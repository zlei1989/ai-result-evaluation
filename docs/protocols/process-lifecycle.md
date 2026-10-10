# 进程生命周期

## 定位

厂商智能体进程从 spawn 到整棵回收的完整口径：一次运行的进程树怎么起、怎么停、怎么保证不留孤儿。核心教训来自一次真实事故：同一条提示词 7 次尝试逐字重复，根因不在清理层，而在**上一轮的厂商进程没有被整棵回收**。

## 形态与交互

- **每行独立隔离**：每次运行独占临时目录（`.agenthome`，作为 `HOME` / `USERPROFILE` 与厂商配置目录）——行与行共用会互相注入 MCP / 插件定义，破坏「同一起点」。评分智能体另有独立 `.judgehome`。
- **停止与释放固定顺序**：`interrupt()` → 等在途 turn 终结（最多 **5 秒**）→ `dispose()`。顺序不可颠倒：直接 dispose 会与在途 turn 争抢同一批资源（子进程、临时目录）。三家差异：claude 的 `interrupt` 是 SDK 优雅停止（结束在途 turn、不是 kill）；codex 是 `turn/interrupt` 协议能力；dsh `interrupt()` **刻意空实现**（SDK 无 wire-level cancel）。
- **`dispose()` 杀整棵树并等 exit**：Windows `taskkill /PID <pid> /T /F`、POSIX 进程组 `SIGKILL`；杀树失败退回直接 kill；等不到 exit 如实回 `exited: false` 由调用方 WARN。`dispose` 幂等（用户终止与兜底超时可能先后触发），「恰好关一次」绑到**被关闭的那个对象**上。
- **起手三步失败也要回收**（spawn / 握手 / 起轮）：`dispose` 只在句柄成功返回后存在，失败路径要在 finally 里补回收。
- **被终止的那一轮不等收尾取数**；正常轮的收尾取数必须在 `dispose` 之前落定。

## 数据与契约

- `exitReason` 判定优先级固定：`signal` 已中止 → `canceled`；其余按实际结果（`completed` / `error`；`timed-out` 无生产者）。进程退出码**不得当本轮成败判据**：codex app-server 在 `turn/completed` 后不自退、kill 后退出码恒 `null` ⇒ 成败只认 `turn/completed.status` + `error`。
- `AGENT_*` 领域归因码（`AGENT_LOAD_FAILED` / `AGENT_FAILED` / `AGENT_TIMED_OUT` / `AGENT_CANCELED` / `AUTH_FAILED` / `RATE_LIMITED`）：没有 HTTP 状态，落点是该行的事件日志。
- **替换型子进程环境**：以宿主环境为底、覆盖 `HOME` / `USERPROFILE` 与厂商变量后**整体交给**子进程，绝不写 `process.env`（有源码级静态断言守着）——并行多行时往 `process.env` 塞会互相串凭据。

## 状态机与时序

一次运行：懒加载 SDK → spawn（独立 configHome）→ 握手 → 通知流 → 终态 → **settled**（流停、树冻结）→ 收尾取数 → `finalize` → 释放（杀整棵树 + 等 exit + 删临时目录）。

**终结闸门认本轮**：codex 主线程与每个子线程各有自己的 turn，`turn/completed` 多条、`threadId` 各异——子线程先到不能当本轮终结（拿到的是子线程结束时刻的快照）。凡「等一个终态再取数」的地方都要问：这是哪条线程的终态。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| **EPERM 清理失败**（`INTERNAL：清理上一轮的行产物失败：…（EPERM, Permission denied: \\?\…\.agenthome）`）：codex 启动阶段 spawn git 孙进程（插件同步 `plugins-clone-*/` + `plugins.sync.lock`），`child.kill()` 在 Windows 只杀直接子进程，`fs.rmSync` 同步无重试 | 修法四件：进程树终止（`terminateProcessTree`）、`close()` 异步化、`remove-tree` 有界重试（6 × 250ms）、claude/dsh 尽力登记；真机守卫 `AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts` |
| Node 的 `rmSync` 对「被子进程当 cwd 的目录」抛 EPERM 且 **EPERM 不在 Node 的 `retryErrorCodes` 里** ⇒ `maxRetries` 形同虚设 | 判读口径：整包跑时用「该文件的失败条数 === stderr 里 EPERM 条数」把清理期 flake 与真红分开 |
| codex 插件 startup sync 未关（线程级 `config` 管不到它——`features.plugins=false` 只有盘上 `config.toml` 或 `-c` 生效） | 未闭合；只表现为每次 `thread/start` 白连一次 github + 起一串 git 孙进程；进程树回收已不让它变成行失败 |
| 临时目录残留（`%TEMP%\aieval-evaluator-*` 长期既存且累积） | 已知代价；清理靠外层，不进产品逻辑 |
| dsh 停止走「等 5 秒宽限 → WARN → 强制关闭」 | 设计（`cancelMidTurn: false`）；点「终止」后该行晚 5 秒变 `canceled` |

## FAQ：行结束后留下的浏览器

这条是**跨家 / 环境类**的（任何一家只要注入了会拉起浏览器的 MCP server 都成立），故不进三份厂商 FAQ，
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
  而**我们够不着**：claude 这一类由 SDK 代 spawn，公开面拿不到 CLI 的 pid（`providers/claude-code/index.ts`
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
- 仓库内参考：`packages/server/agents/README.md`——§5.2 停止与释放；AGENTS.md「删除与 PowerShell 安全」
- 知识文章：[《Provider 抽象与 run 入口》](/protocols/provider-run)（调用契约与终态语义）、[《事件流》](/protocols/event-stream)（终态事件从哪来）、[《行执行与日志》](/features/row-execution)（清理失败在行状态机上的落点）、《密钥与环境变量》（子进程环境凭据）
