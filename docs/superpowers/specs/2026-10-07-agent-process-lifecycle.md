# 厂商进程生命周期规范（claude-code / codex / dsh，以及将来的每一家）

> 2026-10-07 立。起因是一条真机报错：点「重新执行」时 `INTERNAL：清理上一轮的行产物失败…（EPERM, Permission denied: …\.judgehome）`，
> 连着 7 次尝试逐字重复。根因不在清理那一层，而在**上一轮的厂商进程没有被整棵回收**——完整证据链与处置见 `docs/codex-faq.md` 的同名条目。
>
> 这份文档管的是**过程平面**（进程怎么起、谁拥有、怎么死、死了谁负责确认），不是内容平面（事件 / 消息归一，
> 那两块的规范在 `2026-10-01-agent-message-spec-design-v3.md`）。新增一家厂商时，按 §4 的清单逐条走完即可。

---

## 1. 事实基线（真机实测，不是设计意图）

| 家 | 谁 spawn 厂商进程 | 本仓能拿到 pid 吗 | 厂商会自己 spawn 下级进程吗 | 回收通道 |
|---|---|---|---|---|
| codex | **本仓**（`providers/codex/appserver/client.ts` 的 `spawn`） | ✅ 有 | ✅ 会：`thread/start` 期间同步 curated 插件目录，拉起 `git.exe → git.exe → git remote-https → git-remote-https.exe` | `close()` → `terminateProcessTree` |
| claude-code | 厂商 SDK（`query()` 内部 spawn CLI） | ❌ `sdk.d.ts` 里那个 `pid` 属于 MCP stdio transport，**不是 CLI** | 会（CLI 的工具子进程） | `controller.abort()`（SDK 自己的硬停止） |
| dsh | 厂商 SDK（`DeepSeekHarness.start()`） | ❌ `lib/types/*.d.ts` 里没有任何 pid | 会（运行时进程树） | `runtime.close()` |

三条由此推出的事实（每条都有真机判据）：

1. **Windows 上 `child.kill()` 只杀直接子进程**。孙进程原地存活，并且**继承了父进程的句柄**——它们甚至不在命令行里出现 `CODEX_HOME`，所以「按路径扫进程再杀」这条路不通（`probe/v7/codex-plugins-sync.mjs`）。
2. **活着的孙进程会让整棵目录删不掉**。`rmdir` 抛 `EPERM`，而且**不会自愈**：探针在杀完直接子进程后的 50ms / 250ms / 2s / **10s** 四个时点全部失败；把残留 pid 清掉之后**立刻**成功（同一份探针的 A/B 组）。
3. **`fs.rmSync` 在本机没有可用的重试**。`maxRetries` / `retryDelay` 的白名单只存在于**异步** `fs.rm`（`internal/fs/rimraf` 的 `retryErrorCodes`），同步那条直接下沉 C++（`packages/server/core/src/remove-tree.ts` 文件头，2026-10-01 与 2026-10-07 两次实测）。

---

## 2. 五条不变量

编号 L1–L5，**每条都要有可执行的判据**（见 §5）。任何一条不成立时，症状都会以「另一层报错」的形式出现（例如 L1 破了，报错出现在行产物清理上），所以判据必须绑在**本层**。

### L1 归属：谁 spawn，谁负责整棵回收

- **本仓 spawn 的家**（今天的 codex）：`dispose` 必须回收**整棵树**——Windows `taskkill /PID <pid> /T /F`、POSIX 进程组 `SIGKILL`（spawn 时 `detached: true`）。**不许**只调 `child.kill()`。
- **SDK 代 spawn 的家**（claude / dsh）：拿不到 pid ⇒ 只能走 SDK 的硬停止通道，回收是**尽力**。这一档**必须如实登记**在本节，不许在文档、注释或提交信息里声称「已整棵回收」。
- 判据：`process-tree.test.ts` 钉住命令逐字（`/T` 少一个字符就红）；真机 `lifecycle-live.test.ts` 钉住「close 之后没有残留进程」。

### L2 dispose 要等确认，不能只发信号

`kill()` 返回 ≠ 进程已退出，更 ≠ 句柄已释放。回收动作之后必须**等 `exit`**（有上界，默认 5s；等不到就如实回 `exited: false` 并留 WARN）。

- 为什么不能只等事件：这是一条释放路径，**无界等待会把整行拖死**。
- 为什么不能不等：行落终态与「目录可用」之间会留下一个没人管的窗口，窗口长度由厂商子进程的网络超时决定（真机上以分钟计）。
- 判据：`client.test.ts` 的「close 会等子进程真的退出」与「宽限期内不退出 ⇒ close 仍然返回」。

### L3 起手失败也要回收

`hooks.start()` 抛错时，`runTurn` 里的 `started` 还是 `undefined` ⇒ **`dispose` 永远不会被调用**（它挂在 `TurnStart` 上，而它根本没被返回）。已经 spawn 出来的进程就此常驻，并一直持着该行的配置目录。

- 义务在**适配器**：起手三步（握手 / 建线程 / 起轮次）包一层 `try/catch`，失败时先回收再抛原始错误（`session.ts` 的 `startCodexSession`）。
- 判据：`session.test.ts` 三条（initialize / thread/start / turn/start 各自失败 ⇒ client 被关闭）。

### L4 行产物回收不得假设上一轮干净

`clearRowArtifacts` 那三条删除必须走**有界重试**（`core/src/remove-tree.ts`：6 × 250ms，白名单与 Node 异步 `rimraf` 同表），失败时文案要**点名成因**，而不是把 errno 原文丢给用户。

- 为什么 L1 已经保证整棵回收了还要这一条：L1 只覆盖**我们能回收的**那两家；SDK 代 spawn 的残留、本进程被杀（dev 重启 / 掉电）、以及杀软与索引器的瞬时占用都不归 L1 管。
- 判据：`remove-tree.test.ts`（重试次数、白名单、放弃时交出最后一次错误）+ `workspace-cleanup.test.ts`（顺序、文案、瞬时占用不算失败）。

### L5 可见性：回收不干净必须留痕，不许静默

三处必须出声：① 整树回收动作报错 → WARN；② 宽限期内没等到退出 → WARN（带上 pid 与等了多少毫秒）；③ 子树重试 → WARN（带上路径、第几次、errno）。

- 理由：这一族的失败**必然**会在下一轮以另一层的报错现身（EPERM），把因果留在日志里，排障才不用反推整条链。
- 判据：`client.test.ts` 与 `remove-tree.test.ts` 的用例在失败分支上会打 WARN（用例里可观察到的副作用）。

---

## 3. 一次运行的生命周期（顺序是承重的）

```text
adapters: spawn（owned：记录 pid / sdk-owned：拿不到 pid）
   └─ 起手握手 / 建线程 / 起轮次         ← 失败 ⇒ L3 回收，然后抛原始错误
      └─ 消费事件流（interrupt 可打断）
         └─ runTurn.finally：
              1) finalize（只读盘，先于释放：会话文件 / 临时目录还要用）
              2) settleTurn（终结在途 turn）
              3) releaseTurn：interrupt → 等 settled（≤5s）→ dispose
                 · dispose = 整树回收 + 等退出（≤5s）        ← L1 / L2
         └─ 行落终态（编排层）
   ── 下一轮 prepareRowWorkspace：清理 workspace / .agenthome / .judgehome（有界重试）  ← L4
```

两条必须记住的边界：

- **`dispose` 不是「关掉一个句柄」，而是「让对方进程消失」**。顺序上它排在行落终态**之前**（`runTurn` 的 `finally`），所以「行已经 failed 了，进程还在」这件事在时间上是可能的——L2 的等待就是压缩这个窗口的手段，但它**不保证**窗口为零（第三方 SDK 代 spawn 的家没有这个保证）。
- **回收失败不改变本次运行的结论**（与 `finalize` 同一条处置：可见性次于结论）。所以回收失败只 WARN；它造成的后果会在**下一轮**的 L4 上现身。

---

## 4. 新增一家厂商：清单（逐条可勾）

1. **声明归属**：这一家是「本仓 spawn」还是「SDK 代 spawn」？写进 §1 的表里，并同步更新本节第 2、3 条的落地方式。
2. **回收通道**：owned ⇒ 走 `process-tree.ts` 的 `terminateProcessTree`，并**等退出**；sdk-owned ⇒ 找到 SDK 的硬停止通道（abort / close），在 dispose 处写一句注释说明「为什么这是尽力」，并在 §6 登记残留风险。
3. **起手失败回收**：起手三步包 `try/catch`，失败先回收再抛（L3）。
4. **home 目录注入**：每行一个独立配置目录（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME`）——它是**行产物的第三个落点**（前两个是 `workspace` 与 `events.jsonl`），也是被孙进程锁住的那一个。
   - ⚠️ 有些配置**线程级给不进去**：codex 的 `features.plugins=false` 只在**盘上的 `config.toml`** 或**进程级 `-c`** 上生效（`probe/v7` 四格对照），线程级 `config` 会被 startup sync 无视。
5. **一致性套件**：`providers/conformance/` 的四格（传输 / 结构化输出 / 最终答复 / 消息）全绿。
6. **真机守卫**：加一条 gated 的 live 用例（范式见 `providers/codex/lifecycle-live.test.ts`）：跑一次真实运行 → dispose → 断言「没有残留进程」+「该行 home 目录可删」。
7. **FAQ**：把过程中踩到的运行期问题按四格格式写进 `docs/<厂商>-faq.md`（**同一现象只留一条**，与事实冲突时改旧条目）。
8. **权限档**：在 `permission.ts` 的表里给出两档（`full` / `read-only`）的落点；两家必须成对的选项（如 claude 的 `bypassPermissions` + `allowDangerouslySkipPermissions`）在注释里点明。

---

## 5. 判据与守卫（改了这些必须重跑变异）

| 不变量 | 守卫文件 | 变异（造回缺陷）⇒ 红在哪 |
|---|---|---|
| L1 | `agents/src/process-tree.test.ts` | `taskkill` 去掉 `/T` ⇒ 命令逐字比对红；**真机** `lifecycle-live.test.ts` 同时红（4 个孙进程存活） |
| L1 | `agents/src/providers/codex/appserver/client.test.ts` | `close()` 退回 `child.kill()` ⇒ 4 条红 |
| L1 | `agents/src/providers/codex/lifecycle-live.test.ts`（gated） | 同上：真机上「残留进程 + 目录删不掉」 |
| L2 | 同上 client.test.ts 两条（等退出 / 等不到也返回） | 去掉 `await` 或去掉超时 ⇒ 各红一条 |
| L3 | `agents/src/providers/codex/appserver/session.test.ts` 三条 | 去掉 `catch` 里的回收 ⇒ 3 条红 |
| L4 | `core/src/remove-tree.test.ts` | 去掉重试循环 ⇒ 2 条红（`attempts: 1 ≠ 3`） |
| L4 | `core/src/workspace-cleanup.test.ts` | 删除顺序 / 文案 / 失败折叠任一处改动 ⇒ 对应条红 |

真机探针：`node packages/server/agents/probe/v7/codex-plugins-sync.mjs`（四格闸门 + A/B 杀树对照，落盘 `probe/dumps/v7/codex-plugins-sync.json`）。

---

## 6. 已知未闭合（照实登记，不要当成已解决）

1. **claude / dsh 没有整树回收**：SDK 公开面不给 pid。兜底是 L4 的有界重试与 `turn.ts` 的 5s 兜底；若将来 SDK 暴露 pid，按 L1 的 owned 分支接上。
2. **codex 的插件同步仍然联网**：每次 `thread/start` 都会 `ls-remote` + `fetch https://github.com/openai/plugins.git`。关掉它有两个有效闸门（盘上 `config.toml` 的 `[features] plugins=false`、进程级 `-c features.plugins=false`），但会**改变被测智能体的能力面**（少掉那批插件技能），故今天不动，只登记。
3. **`rmSync` 的 `maxRetries` 在本机无效**：L4 用自写重试绕开，没有根治（也根治不了，是 Node 的实现口径）。
4. **本进程非正常死亡（掉电 / dev 重启）时孤儿无法回收**：L1 只在正常运行路径上成立；这类残留要靠 L4 的重试窗口或人工清理。

---

## 7. 相关资料

- 本次事件的完整证据链与变异结果：`docs/codex-faq.md` 的 `INTERNAL：清理上一轮的行产物失败…` 条目
- 真机探针：`packages/server/agents/probe/v7/`（脚本 + `REPORT.md`）
- 释放顺序的原始设计：`packages/server/agents/src/release.ts` 文件头、`turn.ts` 的 `TurnStart.dispose` 注释
- Node 侧事实：`packages/server/core/src/remove-tree.ts` 文件头（异步 `fs.rm` 与同步 `rmSync` 的重试差异）
- `taskkill /T` 的语义：https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill
