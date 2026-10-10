# DeepSeek Harness 适配 FAQ

DeepSeek Harness（`@deepseek-ai/dsh-sdk-client`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## `dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`

**日期**：2026-10-07

**现象**：新增智能体 SDK 一致性套件的「能力声明与产物互钉」组报出上面这句（红在 `providers/dsh/conformance.test.ts`）。同一条判据在 codex 与 claude 上都过。

**根因**：**这条通路上，厂商不把增量投送到我们能订阅的通道**。厂商侧确实有这个数据——LLM 层的流式协议里有 `text-delta`（`StreamChunk` 的一支），会话日志默认还会把连续同块增量压成 `text-chunks` 行——但**我们订阅到的通知流里没有它**：2026-10-07 真机探针（`probe/v2/dsh-chunk-shape.mjs` → 转储 `probe/dumps/v2/dsh-chunk-shape.jsonl`）跑完一次完整往返，共 **20 条通知**，正文只有**一条整块的 `assistant/message`**、增量类事件 **0 条**（事件类型全集：`permission/preset`、`sandbox/mode`、`approval/policy`、`agent/inbox/spliced`、`session.status`、`turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`、`session/title`、`session-log-deepseek/delivery-accepted`、`assistant/message`、`step/end`、`turn/end`）。适配器只认整块 `assistant/message`（`message.ts` 全文件 `delta` 零命中）本身没错；错的是**声明写着 `streamingDelta: 'yes'` + `source: 'wire'`**，即「说这条通道拿得到」。

**⚠️ 这条最值钱的教训：文档说的层 ≠ 我们能拿到的层**。我们最初照文档把它判成 `off-by-adapter`（厂商有、我们没接），实跑把它推翻了——文档描述的是 **LLM 层**与**会话日志层**，我们消费的是 **SDK 订阅到的通知层**，两者不是同一个通道。**凡「厂商有没有」的判定，落到「我们能不能拿到」上才算数**；只查文档最多得出「某层有」。

**解决方案**：`providers/dsh/index.ts` 的 `messageCapability` 改为 `streamingDelta: 'not-projected-by-vendor'`、`streamingDeltaSource: null`、`streamingDeltaReason: 'not-exposed'`——五态里这一格的语义正是「厂商侧有数据，但不投送到我们拿得到的通道」；并在 `notes` 第一条写上探针证据与「界面不得按有增量渲染」。
判据：套件第 7 组「能力声明与产物互钉（§2.7）」+ `providers/dsh/conformance.test.ts` **11/11** 全过；codex 侧的能力对齐守卫同步钉住这处差异（`codex/index.test.ts`，commit `2f3dd50`）。若换路由或 SDK 选项后能拿到增量，把这一格改回 `'yes'` 并补一个含 delta 的场景。

**相关资料**：
- [dsh 官方 `llm-streaming.md`：`StreamChunk` 的完整定义（含 `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end`）](https://github.com/deepseek-ai/deepseek-harness/blob/25d959aa085865f9d889e3a663ce018669258207/docs/core-data-structures/llm-streaming.md)
- [会话日志存储格式（中文手册）：`text-chunks` 等 packed row 展开成 `assistant/chunk` 的 `text-delta`](https://github.com/sandbaseai/deepseek-harness-handbook/blob/main/docs/zh-CN/reference/session-log-storage-format.md)

---

## `AssertionError: expected false to be true // Object.is equality`（`providers/dsh/index.test.ts` 的 overlay 绝对路径那条）＋仓库根长出 `D:\runs\run-1\rows\r-1\workspace`

**日期**：2026-10-09

**现象**：macOS 上跑测试，两件事同时发生：

1. `FAIL  |@aieval/agents| src/providers/dsh/index.test.ts > dshProvider > 注入落点：路由键 + 绝对路径的 overlay + **自定义变量名**带凭据；DSH_HOME/HOME 都指向该行目录`，报
   `AssertionError: expected false to be true // Object.is equality`（`expect(isAbsolute(patches?.[0] ?? '')).toBe(true)` 那一行）；
2. 仓库根（进程 cwd）冒出 Windows 名字的目录：`D:\runs\run-1\rows\r-1\workspace`（api 夹具 `makeRow().workspacePath` 的原值）、`D:\runs/run-1/rows/r-1`（`rowWorkspaceDir('D:\runs', …)` 拼出的混合分隔符树），以及 `D:/tmp/rows/row-1/.agenthome/aieval-route.patch.yml`。

**根因**：**夹具把「磁盘地址」写成了盘符字面量，而盘符路径在 POSIX 上不是绝对路径**（`isAbsolute('D:/tmp/x') === false`），于是它按**相对 cwd** 解析，产物落进进程 cwd。

- `packages/server/agents/src/testing/agent-fixtures.ts` 的 `createRunInput` 默认 `cwd: 'D:/tmp/rows/row-1/workspace'`、`configHome: 'D:/tmp/rows/row-1/.agenthome'`；dsh 适配器**真的**会 `mkdirSync(input.configHome)` 并在其下写 overlay（`providers/dsh/index.ts`）⇒ `D:/tmp/…/.agenthome/aieval-route.patch.yml` 落在仓库根。
- 同一条路径还撞上 dsh 的既有不变量：`patches` 必须是绝对路径（SDK 用 `resolve(callerCwd, path)` 解析，callerCwd 是宿主进程的 cwd），故 `isAbsolute` 那行红。
- 同一类缺陷在 api 侧：`packages/server/api/src/testing/run-fixtures.ts` 的 `makeRow().workspacePath` / `makeRun().workspaceBase` 是 `D:\runs…`，而 `run-artifacts.test.ts`（`seedRun(..., { createWorkspace: true })`）与 `messages-stream.test.ts`（`resetRecords(...)`）拿它们直接 `mkdirSync` —— `D:\runs` 那棵树就是这么来的。

**这是测试环境差异，不是厂商行为**：同一份夹具在 Windows 上既绿又不脏（盘符路径确实是绝对路径），只在 POSIX 上既红又脏。凡是「夹具里的路径字段会被产品代码拼进真实文件路径」的地方，都必须按当前平台拼。

**解决方案**：两个夹具各取一棵**当前平台的真临时树**（`mkdtempSync(join(tmpdir(), …))`；vitest 按文件隔离模块图 ⇒ 每个测试文件一棵，互不串台），并在夹具模块里用 `afterAll` 回收（模块级钩子在**收集期**注册到当前测试文件的根套件，已实测有效，避免让十几个消费文件各写一遍清理）：

- `agent-fixtures.ts` 导出 `FIXTURE_CWD` / `FIXTURE_CONFIG_HOME`，`createRunInput` 的默认值改引它们；三家适配器用例里断言默认地址的 10 处（claude 3、codex 1、dsh 6）改为引用常量。
- `run-fixtures.ts` 导出 `fixtureWorkspaceRoot()`，`makeRow().workspacePath = rowWorkspaceDir(FIXTURE_WORKSPACE_ROOT, 'run-1', 'r-1')`、`makeRun().workspaceBase = FIXTURE_WORKSPACE_ROOT`。
- 夹具里的 `repoPath`（`D:\projects\gateway`）**刻意保留盘符形状**：用例的 git 操作要么被 mock、要么指向自建的临时仓库，它只走运输链，不碰盘。

判据（守卫 + 变异验证）：新增 `agent-fixtures.test.ts` 与 `run-fixtures.test.ts` 的「夹具里的磁盘地址按当前平台拼」两条，断言 `isAbsolute()` + 落在 `tmpdir()` 下 + 不在 `process.cwd()` 下（刻意不问「等于某个常量」——常量本身就是缺陷现场）。三个变异体都见过红：① `makeRun().workspaceBase` 改回 `'D:\\runs'` → api 守卫红；② 夹具根改成相对路径 `'aieval-run-fixtures'` → api 守卫红在 `isAbsolute` 那条；③ `configHome` 改回 `'D:/tmp/rows/row-1/.agenthome'` → agents 守卫红 **且** dsh 那条 overlay 不变量同时红，仓库根重新长出 `D:/tmp/…/aieval-route.patch.yml`（缺陷可复现）。还原后两份夹具的 sha256 与变异前逐字一致。

**相关资料**：
- [Node.js `path.isAbsolute()`：POSIX 与 Windows 的「绝对路径」判定不同（盘符路径在 POSIX 上是普通相对路径）](https://nodejs.org/api/path.html#pathisabsolutepath)
- [Node.js `fs.mkdtempSync()`：推荐的临时目录 API（本仓口径：能用现成 API 就别手写递归删除）](https://nodejs.org/api/fs.html#fsmkdtempsyncprefix-options)

---
## `原始输出 38164 行，但执行日志是空的`（dsh 行：厂商会话日志 201 条事件，我们只收到前 13 条）

**日期**：2026-10-10（首次观测 2026-10-09）

**根因**：**适配器自己把 `subscription.next()` 的 promise 遗弃成了孤儿**，于是 SDK 把后续每一条通知都交给了没人等的等待者。

1. 消费循环每 `DSH_STREAM_TAP_POLL_MS`（100 ms）被 `tapWake` 唤醒一次，并把它与 `subscription.next()` **竞速**（`Promise.race`）。每一轮都**新建**一个 `next()`，竞速输给 `tapWake` 之后那份 promise 没人再 await，**但它仍挂在 SDK 的等待者队列里**。
2. SDK 的 `NotificationSubscriptionImpl.push()` 是 `const waiter = this.state.waiters.shift(); … waiter.resolve(notification)` —— **先到先得**（最老的等待者拿这一条）。于是此后每条通知都落到那个**孤儿**上（resolve 后丢弃），真正在等的那一个永远拿不到。孤儿数随静默时长线性增长 ⇒「握手之后彻底静默」是必然，不是偶发。
3. 结果：`messages.jsonl` 为 0、执行日志整段空白、`streamingDelta` 为 `{0,0}`，而**行照旧判成功**（diff 与评分都是真的）。真机运行 `7f05c765` 的 dsh 行连续三次都是这个形状。

**量级与判据**（真机一次 + 本机复现一次，数字逐字相同）：客户端**投递并接受 181 条**（含 18 条 `assistant/message`、tool call/result 各 52 条），我们的生成器只 `yield` **15 条**（全在前 50 ms 内——那批是先入队、被 `tryNext()` 取走的），之后 137 秒一条不剩且**零报错**。

- 探针 `probe/v3/dsh-tap-truncation.mjs`：同一 SDK / 运行时 / overlay / 权限 / **真题面 + 真工作区副本**，变体 A–E **全部收齐内容** ⇒ 上游与数据格式无罪。
- 回放：厂商会话日志的 191 条事件喂真实投影 ⇒ **127 条消息、185 条草稿、零抛错** ⇒ 投影层无罪。
- 本机复现（真网关 + 真题面 + 真工作区副本直接跑 `dshProvider.run`）：修前 `事件 16 / 消息 0`，修后 **`事件 175 / 消息 78`**；埋点从 `delivered 181 / yield 15` 变成 **`delivered 136 / yield 136`（1:1）+ `sawTurnEnd: true`**。

**为什么此前所有守卫都绿**：① 夹具的假订阅**只留一个 `waiter`**（新的 `next()` 直接覆盖旧的），真实实现是**等待者数组 + `shift()`** ⇒ 孤儿这条路径在夹具层根本不存在；② 夹具默认同步 / 2 ms 投递，永远抢在 100 ms 轮询拍之前，连「竞速输一次」都造不出来。**测试环境 ≠ 运行环境**在这里就是这两点：替身比真实实现弱，守卫就没有区分力。

**解决方案**：`packages/server/agents/src/providers/dsh/index.ts` 把在飞的 promise **记忆化复用**（`pendingNext ??= …`，settle 后才允许再建一个）。夹具补两处保真度：`waiters` 改数组 + `shift()`（与真实同序）、新增 `emitIntervalMs` 旋钮。回归守卫：`dsh/index.test.ts` 的「投递间隔 150ms > tap 轮询拍 100ms：三条通知一条都不许丢」，判据取**最后一条** `assistant/message` 带出的 `tokens`。**变异验证**：把记忆化改回「每轮新建」⇒ 守卫红（`expected null to deeply equal { input: 218, … }`），还原后哈希 `326a644fff9a0499861f7b0cc7452555a4b2d4af5096c602ef5425c1d0786f3b` 逐字一致、129 条复绿。

**顺带定位并修掉的第二个缺陷**：tap 插件落点错了——overlay 里 `name: "./aieval-stream-tap.mjs"` 由运行时按 **`dshHome`** 解析，而适配器写在 `profiles/sdk/` ⇒ 每次运行 stderr 只有 `dsh: warning: 1 entry did not activate` + `aieval-stream-tap (file:///<dshHome>/aieval-stream-tap.mjs): failed to import`，**插件从未加载**、旁路文件恒 0 字节、能力位声称 `streamingDelta: yes` 而界面一条增量都没有。改 `DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH` 为 `'aieval-stream-tap.mjs'` 后探针实证：stderr 干净、**旁路文件 0 → 720 字节**。

**方法论留档**：这一条最初被误判为「订阅在中途静默失败」（并据此加了 `aieval/stream-failure` 伪事件与「静默停滞」判据）。那些改动无害（只在真断流时出现），但当时的原因文案把矛头指向了厂商——**判据必须能分开「客户端投递了几条」与「我们消费了几条」**，这一格是最后才补上的，也是本次排障耗时最久的地方。`diagnoseStreamEnd` 现在同时报告两个数并直接指出断点在哪一侧。

**相关资料**：

- SDK 源码（本地安装态）：`node_modules/.pnpm/@deepseek-ai+dsh-sdk-client@0.2.0-rc.2_*/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js` 的 `NotificationSubscriptionImpl.push/next`
- 探针（可复跑）：`packages/server/agents/probe/v3/dsh-tap-truncation.mjs`
- [《DeepSeek Harness 接入》](/protocols/dsh) —— 已知边界与取舍里同一条
