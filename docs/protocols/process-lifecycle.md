# 进程生命周期

## 定位

厂商智能体进程从 spawn 到整棵回收的完整口径：一次运行的进程树怎么起、怎么停、怎么保证不留孤儿。核心教训来自一次真实事故：同一条提示词 7 次尝试逐字重复，根因不在清理层，而在**上一轮的厂商进程没有被整棵回收**。

## 形态与交互

- **每行独立隔离**：每次运行独占临时目录（`.agenthome`，作为 `HOME` / `USERPROFILE` 与厂商配置目录）——行与行共用会互相注入 MCP / 插件定义，破坏「同一起点」。评分智能体另有独立 `.judgehome`。
- **停止与释放固定顺序**：`interrupt()` → 等在途 turn 终结（最多 **5 秒**）→ `dispose()`。顺序不可颠倒：直接 dispose 会与在途 turn 争抢同一批资源（子进程、临时目录）。四家差异：claude 的 `interrupt` 是 SDK 优雅停止（结束在途 turn、不是 kill）；codex 是 `turn/interrupt` 协议能力；dsh `interrupt()` **刻意空实现**（SDK 无 wire-level cancel）；pi 走 SDK 的 `abort()`。
- **发起停止的有三个来源，收尾只有一条路径**：用户点「终止」（`signal`）、宿主停机（SIGTERM / SIGINT ⇒ `disposeLiveSessions()`）、看门狗判定静止超时（见下面「静止超时」）。三者都走上面那条三段式，区别只在结论：`canceled` / `canceled` / `timed-out`。
- **`dispose()` 杀整棵树并等 exit**：Windows `taskkill /PID <pid> /T /F`、POSIX 进程组 `SIGKILL`；杀树失败退回直接 kill；等不到 exit 如实回 `exited: false` 由调用方 WARN。`dispose` 幂等（用户终止与看门狗判定的静止超时可能先后触发），「恰好关一次」绑到**被关闭的那个对象**上。
- **起手三步失败也要回收**（spawn / 握手 / 起轮）：`dispose` 只在句柄成功返回后存在，失败路径要在 finally 里补回收。
- **被终止的那一轮不等收尾取数**；正常轮的收尾取数必须在 `dispose` 之前落定。
- **整棵回收归谁**：口径是「谁 spawn 谁负责整棵回收」——本仓自己 spawn 的走 `terminateProcessTree`；工具子进程由厂商 SDK 代 spawn 的家，只能走那家 SDK 自己的硬停止通道（好坏参差，故必须逐家分档登记，不许一律声称做到了）：

  | 家 | 谁 spawn 工具子进程 | 回收通道 | 归属 |
  |---|---|---|---|
  | codex | 我们（`codex app-server`） | `terminateProcessTree`：Windows `taskkill /T /F`、POSIX 进程组 SIGKILL；真机守卫 `AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts` | **整棵已验证** |
  | claude | SDK / CLI 代 spawn | SDK 的硬停止通道（`controller.abort()`）；公开面拿不到 pid | **尽力**（MCP server 拉起的浏览器会留下，见下面的 FAQ） |
  | dsh | SDK 代 spawn | 关 runtime（`runtime.close()`，`cancelMidTurn: false` 下唯一真实存在的硬通道） | **尽力**（行产物清理不假设它一定干净） |
  | pi | in-process SDK 自己 spawn（POSIX 上 `detached`，自成进程组） | SDK 自己的 `killProcessTree`：`session.abort()` / `session.dispose()` 在 POSIX 上走 `process.kill(-pid, 'SIGKILL')`，按**进程组**整组回收——不需要我们拿到 pid | **整组已验证** |

## 数据与契约

- `exitReason` 判定优先级固定：外部要求停止（用户点「终止」/ 宿主停机）→ 看门狗判定的静止超时 → 其余按实际结果（`completed` / `error`）。进程退出码**不得当本轮成败判据**：codex app-server 在 `turn/completed` 后不自退、kill 后退出码恒 `null` ⇒ 成败只认 `turn/completed.status` + `error`。
- `AGENT_*` 领域归因码（`AGENT_LOAD_FAILED` / `AGENT_FAILED` / `AGENT_TIMED_OUT` / `AGENT_CANCELED` / `AUTH_FAILED` / `RATE_LIMITED`）：没有 HTTP 状态，落点是该行的事件日志。
- **替换型子进程环境**：以宿主环境为底、覆盖 `HOME` / `USERPROFILE` 与厂商变量后**整体交给**子进程，绝不写 `process.env`（有源码级静态断言守着）——并行多行时往 `process.env` 塞会互相串凭据。

## 状态机与时序

一次运行：懒加载 SDK → spawn（独立 configHome）→ 握手 → 通知流 → 终态 → **settled**（流停、树冻结）→ 收尾取数 → `finalize` → 释放（杀整棵树 + 等 exit + 删临时目录）。

**终结闸门认本轮**：codex 主线程与每个子线程各有自己的 turn，`turn/completed` 多条、`threadId` 各异——子线程先到不能当本轮终结（拿到的是子线程结束时刻的快照）。凡「等一个终态再取数」的地方都要问：这是哪条线程的终态。

**静止超时（骨架的看门狗，四家默认生效）**：判据是「这一行还在动吗」，**不是**工作时长上限——「执行不限时间」不变，没有内层上限、也没有整行级的兜底定时器。它存在是因为**厂商侧的兜底在一类挂死上不成立**：上游接了请求却既不回包也不报错（响应头到了、body 停住），有的家的 SDK 在这一层无限等；而各家自带的流空闲容错在 300 s 上下，等它只会更晚发现。

| 级别 | 缺省 | 判据 |
|---|---|---|
| 空闲 | 180 s | 连续这段时间没有任何产品事件 |
| 单轮墙钟 | 600 s | **一次模型往返**从起表到收尾超过这段时间 |

阈值可传入（`AgentRunInput.watchdog`，执行阶段与评分阶段共用同一份缺省）。四条口径：

1. **「有输出」＝这一条投影交出了任何产品事件**（行级事件 / 消息 / 子任务行 / 计量）。判据窄了会把
   「工具在途的一整段」读成静止——claude 的 `tool_progress` 与 `system/api_retry` 走未识别负载的兜底投影。
2. **墙钟按一次模型往返计**，不按厂商 turn：codex 的一个 app-server `turn` 内含多次往返，
   套在 turn 上等于整行上限。
3. **工具在途挂起两级计时，只对能合法静默的家生效**（今天：dsh 与 pi）。
   dsh 的工具输出**不投**通知流（`tool/call` 与 `tool/result` 只有首尾两发）⇒ 一条全程无输出的长命令
   与「对端挂了」在这条通道上完全同形，而 `bash` 允许显式 `timeoutMs` 到 600 s。
   pi 同因：`tool_execution_update` **只在工具有输出时**才发（bash 把子进程 stdout/stderr 的 `data`
   事件接成更新回调），静默工具全程只有 `tool_execution_start` 那一发；它的 `bash` **没有默认超时**
   （`timeout` 是可选参数），事件全集里也没有心跳 / keep-alive 这类事件。
   claude / codex 刻意不豁免：它们在途自带节拍
   （claude 每 30 s 一件 `tool_progress`、codex 单次 `exec_command` 静默硬夹 30 s），豁免只会把真挂死的
   工具藏起来。**新增一家时这一格必须显式给值**（代码侧是穷尽的 `Record<AgentKind, boolean>`，漏了
   在编译期就报错），取值口径是**默认不豁免**：要放宽得先拿到「该家工具在途确实可能合法静默」的证据。
4. **等待审批在途也应当挂起，但识别机制按家不同、今天采不到 ⇒ 如实登记为「未豁免」**（见下表）。

到点后的收尾与用户点「终止」同一条路径（`interrupt` → 终结在途 → `dispose`，5 秒交卷窗口），
并在服务日志与该行事件流各留一条 `[WARN] 看门狗：…`。**宿主停机回收**：`runTurn` 进出自动登记 /
注销在册会话，宿主的 SIGTERM / SIGINT 处理器（`apps/web-next/instrumentation.ts` 的 `register()`）收到
信号就调 `disposeLiveSessions()`——先一起发停止、再一起等各自释放完，超过停机预算后按原信号退出；
`SIGKILL` 不可捕获，那一格不可闭合。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| **EPERM 清理失败**（`INTERNAL：清理上一轮的行产物失败：…（EPERM, Permission denied: \\?\…\.agenthome）`）：codex 启动阶段 spawn git 孙进程（插件同步 `plugins-clone-*/` + `plugins.sync.lock`），`child.kill()` 在 Windows 只杀直接子进程，`fs.rmSync` 同步无重试 | 修法四件：进程树终止（`terminateProcessTree`）、`close()` 异步化、`remove-tree` 有界重试（6 × 250ms）、拿不到 pid 的家按上面的归属表分档登记；真机守卫 `AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts` |
| Node 的 `rmSync` 对「被子进程当 cwd 的目录」抛 EPERM 且 **EPERM 不在 Node 的 `retryErrorCodes` 里** ⇒ `maxRetries` 形同虚设 | 判读口径：整包跑时用「该文件的失败条数 === stderr 里 EPERM 条数」把清理期 flake 与真红分开 |
| codex 插件 startup sync 未关（线程级 `config` 管不到它——`features.plugins=false` 只有盘上 `config.toml` 或 `-c` 生效） | 未闭合；只表现为每次 `thread/start` 白连一次 github + 起一串 git 孙进程；进程树回收已不让它变成行失败 |
| 临时目录残留（`%TEMP%\aieval-evaluator-*` 长期既存且累积） | 已知代价；清理靠外层，不进产品逻辑 |
| **等待审批的一行会被判成静止超时**（dsh 的 `read-only` 档 approval 仍是 `ask`，越界操作停在无人应答的批准上） | **未豁免**（如实登记，机制未定、**不拿事件名猜判据**）：dsh 的 wire 上没有「待批准」这条通知——传输层的 server→client 请求通道尚未实现（SDK 逐字：「Client→server notifications and server→client requests are unimplemented on both wire ends; the transport carries them for future approval flows」），通知流里 `approval/policy` 只是装配期一次性的档位事实 ⇒「在等审批」与「对端挂了」在这条通道上同形。后果就是被看门狗按静止超时收掉。claude（`dontAsk` + `permissionPrompts: 'none'`）与 codex（两档都是 `approvalPolicy: 'never'`）没有批准面，这一条不适用 |
| **工具在途挂死的家只能靠用户终止**（dsh 的静默长命令没有自己的超时；pi 的 `bash` 不给 `timeout` 时同样无默认上限） | 已知代价，与豁免那条是同一枚硬币：豁免了合法静默，也就顺带豁免了卡死的工具。要停下它只有用户点「终止」 |
| **`SIGKILL` 拦不到**：宿主的 SIGTERM / SIGINT 处理器能回收在册会话（kill -9 谁也接不到） | 不可闭合，如实登记。`kill -9` 之后留下的工具子进程只能靠它们自己超时或人工清理 |
| dsh 停止走「等 5 秒宽限 → WARN → 强制关闭」 | 设计（`cancelMidTurn: false`）；点「终止」后该行晚 5 秒变 `canceled` |

## FAQ：行结束后留下的浏览器

这条是**跨家 / 环境类**的（任何一家只要注入了会拉起浏览器的 MCP server 都成立），故不进四份厂商 FAQ，
落在这里；《故障索引》有登记。

### 行结束后仍能 `pgrep` 到上一轮的浏览器（重跑同一行撞 `Browser is already in use for …, use --isolated …`）

**现象**：行已经收尾、厂商 CLI 与 MCP server 都从进程表里消失了，但 `pgrep -f <浏览器标记>` / `kill -0 <pid>`
仍能找到**上一轮那个浏览器**——它由 MCP server 拉起，**没有任何人收**。后果最容易在「重跑同一行」时现形：
同一个 rowId ⇒ 同一个 `configHome` ⇒ 同一个 profile，playwright MCP 启动前的锁检查
（`isProfileLocked5Times`：重试 5 次、每次隔 1 s）失败后抛出下面这句（原文照抄，`<profile 目录>` 是那一行的
profile 路径）：

```text
Browser is already in use for <profile 目录>, use --isolated to run multiple instances of the same browser
```

⚠️ **本环境的一条测量坑**：沙箱拒绝 `/bin/ps`（`bash: /bin/ps: Operation not permitted`，退出码 **126**）——
拿 `ps -p <pid>` 判存活会把「被拒」读成「进程已消失」。可用判据是 `kill -0 <pid>` 与
`pgrep -f <唯一标记>`（标记要唯一：用每行专属的路径或 argv 片段）。

**日期**：2026-10-10（两臂真机 claude 会话 + 一台注入的 MCP server，它自己再生一个孙进程）

**根因**：**孤儿是孙进程，不是 MCP server**——两层之间的耦合方式不一样：

- **CLI ↔ MCP server**：MCP 的 stdio 传输把 server 的生命周期绑在**管道**上。父进程一死（或被 abort 杀掉），
  管道写端关闭 ⇒ server 读到 EOF ⇒ 自己退出。产品口径的停止序列（`interrupt()` → 等 5 s →
  `controller.abort()`）与猝死口径（拿到 init 直接 `process.exit(0)`）**两臂下 CLI 与 server 都被带走**。
- **MCP server ↔ 浏览器**：没有任何协议层耦合（浏览器不读 server 的 stdin）。上游死得再干净也带不走它，
  而**我们够不着**：claude 这一类由 SDK 代 spawn，公开面拿不到 CLI 的 pid（`providers/cc/index.ts`
  已写明「进程树回收是尽力不是保证」），更别说孙进程；按 profile 路径扫全表杀的跨平台成本与误杀风险不划算。

**解决方案**：**不清理孤儿**（进程树这条路不可达 + 收益为负），改从**根上**消掉它的后果——默认参数里带
`--isolated`（`SETTINGS_DEFAULTS.mcpServers.playwright` 的 `args`）：profile 留在内存、不落盘 ⇒ 既没有
`SingletonLock` 可撞，也没有 20 MB+ 残留可攒。判据与守卫：`contracts/src/settings.test.ts` 钉住播种参数逐字
（`--isolated` 掉了会红）、`agents/src/mcp.test.ts` 钉住翻译后的形状；真机冒烟验残留**只能查进程**
（`--isolated` 下没有 profile 目录可查），用 `kill -0` / `pgrep -f`，本环境不要用 `ps`。

**未覆盖（如实列出）**：浏览器那一半没有直接实测（受限环境起不了浏览器），但「孙进程存活」这条主干结论
不依赖孙进程具体是什么——它只依赖「MCP server 与它的子进程之间没有 stdio 耦合」；codex / dsh 的收尾形状
不同，两家的孙进程命运**未测**。

## 相关链接

- 活文档：[Codex FAQ](/faq/codex)——EPERM 清理失败条（完整证据链与真机守卫）、`Reconnecting` 条
- 仓库内参考：`packages/server/agents/README.md`——§5.2 停止、释放与静止超时；AGENTS.md「删除与 PowerShell 安全」
- 知识文章：[《Provider 抽象与 run 入口》](/protocols/provider-run)（调用契约与终态语义）、[《事件流》](/protocols/event-stream)（终态事件从哪来）、[《行执行与日志》](/features/row-execution)（清理失败在行状态机上的落点）、《密钥与环境变量》（子进程环境凭据）
