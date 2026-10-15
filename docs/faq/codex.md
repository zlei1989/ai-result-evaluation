# Codex 适配 FAQ

Codex（`@openai/codex` CLI / `codex app-server`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## `AGENT_LOAD_FAILED：找不到 codex 可执行文件：The argument 'filename' must be a file URL object… Received '[externals]/@openai/codex/package.json [external] (…)`

**日期**：2026-10-07

**根因**：解析链本身是对的（纯 Node 下真机验证通过），但**换了执行环境**——Next 的服务端构建（dev 走 Turbopack）会把 `import { createRequire } from 'node:module'` 换成自己的 `require`，其 `resolve()` 返回的是**打包器的模块 id**（`[externals]/… [external] (…, cjs, [project]/node_modules/.pnpm/…)`）而不是文件路径；`import.meta.url` 同时会被重写。于是同一个函数在 `vitest` 里正常、在 App 里必挂——**测试环境不是运行环境**。

**解决方案**（两条缺一不可，`providers/codex/appserver/binary.ts`）：
1. 用 `process.getBuiltinModule('module')` 直接向 Node 取真 `createRequire`（绕开替换），静态导入只作老运行时兜底；
2. 解析基准写成**列表**（`import.meta.url` → `process.cwd()`）逐个试，并**校验结果是文件路径**（`isAbsolute` 且不含 `[external`）——不是就换下一个基准，绝不把模块 id 当路径往下走。

判据：`binary.test.ts` 新增 3 条守卫，用**注入的假解析器**复现「返回模块 id」「抛 MODULE_NOT_FOUND」两种形态；变异（去掉形态校验）⇒ 2 条见红。

**相关资料**：`process.getBuiltinModule` — https://nodejs.org/api/process.html#processgetbuiltinmoduleid

---


**现时补充（生产产物 + 生产进程 spy 的真机读数）**：上面那条「Next 把 `createRequire` 换成自己的
`require`、`resolve()` 返回模块 id」的机制，在**当前默认的 Turbopack 生产构建里复现不出来**——
`node:module` 编译成 `e.x("node:module", () => require("node:module"))`，就是真 Node 模块；
`resolve()` 返回真文件路径；`isFilesystemPath` 的 `[external` 那一支一次没走过。⇒ `binary.ts` 那两条
免疫今天是**保险**（守别的打包器/构建配置），不是正在生效的载荷路径；判据照旧要留。

同一份读数还给出两条与「跑不跑得起来」直接相关的现时约束：

- **`@openai/codex` 不进任何产物**（没有 externals chunk、没有 `.next/node_modules/<包名>-<哈希>` 软链、
  `*.nft.json` 里也没有），它只由 `createRequire(anchor).resolve(...)` 在运行期按 node_modules 布局解析
  ⇒ `serverExternalPackages` 里那一格对它是**空转**；
- **第一跳基准在生产产物里是「构建机仓根的源码绝对路径」**（该模块被内联进 server chunk，`import.meta.url`
  在构建期就定死）⇒ 本机能过只因为源码树还在原处；「只发 `.next` + app 的 node_modules」的部署形态下
  这一跳恒失败、只剩 `process.cwd()` 那一跳。**未闭合**：改成什么基准要产品决策。

## `http 401`，但密钥明明就在子进程环境里（`auth.header_attached=false`）

**日期**：2026-10-07

**现象原文**（`RUST_LOG=info` 下 CLI 自己打的）：
```
http.response.status_code=401 error.message="http 401"
auth.header_attached=false
auth.env_openai_api_key_present=true
provider: aieval
```

**根因**：provider 条目里写了 `requires_openai_auth: true`——它走的是 **ChatGPT 登录态**那条认证路（读 `auth.json` / 登录令牌），**不是**「从环境变量取 API key 附 Bearer」。所以 `OPENAI_API_KEY` 就在环境里，请求也一个 `Authorization` 头都不带。

**解决方案**：把该 provider 的 `requires_openai_auth: true` 换成 **`env_key: 'OPENAI_API_KEY'`**（`providers/codex/index.ts` 的 `buildCodexConfig`）。改后同一网关：`status_code=200` + `auth.header_attached=true auth.header_name="authorization"`。

回归守卫：`toMatchObject` 拦不住「两格并存」，故**单独断言 `requires_openai_auth` 不存在**；变异（把它加回去）⇒ 该用例见红。

---

## `unsupported call: probe_echo`（MCP 注入成功、`mcpServer/startupStatus` 报 `ready`，但模型调不动那台工具）

**日期**：2026-10-10（2026-10-11 收窄根因并验证补法）

**现象原文**（模型答复，同一轮里内置 shell 工具完全正常、审批请求为零）：
```
unsupported call: probe_echo
```
真机同一形态的三个名字（run `bad59dce` 的 codex 行，模型连试三个都在 codex 自己的会话记录里留下 `function_call_output`）：
```
unsupported call: browser_navigate
unsupported call: browser_snapshot
unsupported call: browser_tabs
```
配套三格：`mcpServer/startupStatus/updated` → `status: "ready"`；事件流里 `mcpToolCall` **零条**；MCP server 侧（`PROBE_CALL_LOG`）**零 `tools/call`**。⚠️ 同一矩阵里还抓到一次**假绿**：某一轮最终答复是 `hello`（像是调用成功了），而 server 侧同样零调用——**判据只能是 server 侧记录**，模型答复不算证据。

**根因**：**回程的 `function_call` 少了 `namespace` 这一格**（上游网关的锅，不是本仓配置、也不是「没注入」）。

codex 自 0.156 起把 MCP 工具按**命名空间**暴露给模型：请求体里那一台是
`{"type":"namespace","name":"mcp__probe","tools":[{"type":"function","name":"probe_echo",…}]}`。
它收回调用时，`ResponseItem::FunctionCall`（`codex-rs/protocol/src/models.rs`）**有一格独立的
`namespace`**——注册表的键是 `ToolName { namespace: "mcp__probe", name: "probe_echo" }`
（`codex-mcp/src/tools.rs` 的 `canonical_tool_name()`），所以模型回传时必须**同时**给出
`name` 与 `namespace`。而自定义 OpenAI 兼容 Responses 网关（本仓的 `likecode-llm-proxy`，
issue 里的 llama.cpp / Ollama / LM Studio / OpenRouter 同型）把这一格**丢掉**，只留一个被拍平的
`name`（`probe_echo` / `browser_navigate`）⇒ 注册表按「默认命名空间 + 这个名字」查，查不到，
回 `unsupported call: <name>`（文案出自 `core/src/tools/registry.rs`）。官方 Responses 会保留那一格，
所以只有自定义网关中招。

**判据（真机 + 探针，`probe/v10/codex-mcp-tools-capture.mjs`）**：在 codex 与网关之间放一个只改这一格的
记录型中转（回程给注入的 MCP 嵌套工具名补 `namespace`），两端各跑一次、其余全同：

| 臂 | 厂商侧 `mcpToolCall` | MCP server 侧 | 模型答复 |
|---|---|---|---|
| 不改（现状） | 零条 | 零 `tools/call` | `unsupported call: probe_echo` |
| 补 `namespace` | `{server:"probe", tool:"probe_echo", status:"completed"}` | **收到** `{"name":"probe_echo","args":{"value":"hello"}}` | `echo:hello` |

真 playwright MCP 同样打通（`mcpToolCall {server:"playwright", tool:"browser_navigate"}`、
`browser_close` 回了真实结果）；那一次 `browser_navigate` 报 `Target crashed` 是**探针临时 HOME 里
Chromium 不匹配**的环境问题，与分发无关。

**名字形态矩阵**（同一条探针，改回程名字的写法；**只有补字段这一种能过**）：

| 回程名字 | codex 的读数 |
|---|---|
| `probe_echo`（网关现状） | `unsupported call: probe_echo` |
| `mcp__probe__probe_echo`（拍平限定名） | `unsupported call: mcp__probe.probe_echo` |
| `probe.probe_echo` / `probe__probe_echo` | 分别不结算 / `unsupported call: mcp__tools__probe_echo` |
| **name + `namespace: "mcp__probe"`** | **分发成功，server 侧收到调用** |

**不是配置能解的**（本地矩阵五组全败 + 本次复核）：`GLM-5.3` ❌、`DeepSeek-V4.1-Flash-a` ❌、
`features.non_prefixed_mcp_tool_names = { server_names = ["probe"] }` ❌（**本次复跑单变量 A/B 仍 ❌**：
请求体里那台照样是 `namespace mcp__probe`、回程照样 `unsupported call`——它改的是**暴露给模型的名字前缀**，
不改「回程缺字段」）、**升级到 `0.163.0-alpha.5` ❌**。

**修在哪一层**：**网关侧那一格**（本仓不做本地中转兜底——那等于把 codex 的模型出路改成本机多一个
活动部件，而正解只是回程多带一格）。两种查法：

- **不经 codex 的最小复现**：`node packages/server/agents/probe/v10/gateway-namespace-repro.mjs`
  —— 缺字段时打印 `type=function_call name=probe_echo namespace=(缺这一格)`，修好后是 `namespace="mcp__probe"`；
- **网关侧改动面**（单一真源 `lib/tool-namespace.js`）：请求方向的 `responses.pre` 展开容器时把
  「子工具名 → 容器名」按请求记下来（`lib/request-context.js` 的 ALS 流转），回程在 responses 方言的
  两个渲染点补回这一格——流式 `lib/response/stream-sink.js` 的 `itemOf()`（added / done / completed
  三处同源）、非流式 `lib/convert/chat-to-responses.js`。判据在网关仓库的
  `test/tool-namespace.test.js`（含两条真走代理链路 + mock 上游的端到端用例）。

**解决方案**：本仓仍按「已知边界」处置（`docs/protocols/codex.md` 的 MCP 条目 + 契约常量
`CODEX_MCP_DISPATCH_GAP_NOTE`）——**判据只到「装上了」**：`mcpServer/startupStatus === 'ready'` ⇒
行级观测格记 `connected`（判据来源 `vendor-startup-status`），**一个字都不暗示工具可用**；环境抽屉的
「本行 MCP」格在逐台结论之后附上那句话（`build-environment.ts` 拼进那一格、
`agent-environment-drawer.tsx` 渲染，文案取契约里那份共用常量）。网关侧补上之后，用这两条判据收口：

```
node packages/server/agents/probe/v10/gateway-namespace-repro.mjs          # 回程有那一格了
AIEVAL_LIVE_MCP=1 pnpm vitest run packages/server/agents/src/providers/codex/live-mcp.test.ts
```
后者 A 臂的模型答复不再是 `unsupported call: probe_echo`，且探针 MCP server 侧出现调用记录
（模型答复不算证据，server 侧记录才算）。

⚠️ **顺带收窄一条相邻现象**：模型说「当前会话没有暴露 Playwright MCP 工具」**不等于**「没注入」——
那一半是**起轮次早于 server `ready`**（MCP 工具还没进工具表），已修，判据与守卫见下面那条
「当前会话没有暴露 Playwright MCP 工具或资源」。两件事**都表现为「用不了 MCP」，但一层是我们自己的
时序、一层在网关上**，别混成一条。

证据矩阵（五组本地矩阵 + 三格配套信号）见[《MCP 配置》](/features/mcp-config)的「已知边界与取舍」；同一句结论已落成契约常量 `CODEX_MCP_DISPATCH_GAP_NOTE`（界面与文档都取那一份）。外部同型 issue（#26977 / #20652 / #26234）见下方「相关资料」。

**相关资料**：[MCP tools return 'unsupported call' with custom Responses API provider (llama.cpp) · #26977](https://github.com/openai/codex/issues/26977)、[Resolution failure for flattened MCP tool names from OpenAI-compatible proxies · #20652](https://github.com/openai/codex/issues/20652)、[Flatten MCP namespace tools for non-OpenAI Responses API providers · #26234](https://github.com/openai/codex/issues/26234)、[Codex wraps MCP tools in type:"namespace" for custom/local providers · #23186](https://github.com/openai/codex/issues/23186)、[Support flattened deferred MCP tool calls · PR #17556](https://github.com/openai/codex/pull/17556)（codex 侧接受哪些名字形态的另一半证据）

---

## `Reconnecting... waiting for network`（App 里一直重连；同一份配置在 CLI 里 200）

**日期**：2026-10-07

**现象原文**（行日志里只有这一句，没有状态码）：
```
[WARN] codex 报错（本轮尚未结算）：Reconnecting... 2/5
[WARN] codex 报错（本轮尚未结算）：Reconnecting... waiting for network
```

**根因**：`buildCodexConfig` 建了 `model_providers.aieval` 条目，却**没有设 `model_provider`**。CLI 找不到「用哪个 provider」就退回它**内置的默认 provider**（`api.openai.com`）⇒ 本机连不上，表现为**网络层**失败而不是网关 401。

**为什么难归因**（两条，值得记住）：
1. 表象是「连不上网」，与凭据、wire、base_url 都无关，容易往错的方向查；
2. `client.ts` 只在**子进程退出时**才把 stderr 尾巴带进错误消息（`STDERR_TAIL_LIMIT`），进程活着一直重连时，CLI 自己的诊断（`status_code=` / `auth.header_attached=` 那几行）**攒着但永远不露面** ⇒ 排查时看不到任何 HTTP 事实。定位这一步靠的是**在 CLI 里用同一份配置复现**（`RUST_LOG=info`），不是读 App 日志。

**解决方案**：`buildCodexConfig` 里补 `model_provider: 'aieval'`，并把 provider 名抽成 `CODEX_PROVIDER_ID` 常量——**`model_provider` 与 `model_providers` 的键必须同名，少哪个都不行**。

判据：`index.test.ts` 的 `threadParams.config` 期望里钉住 `model_provider: 'aieval'`；变异（删掉这一格）⇒ 该用例见红（`expected { model_providers: … } to match object { model_provider: 'aieval', … }`）。

**真机结果**：修后同一次评测 `run.status=done` / `row.status=judged`，评分 **57/57**（8 项 rubric 全达成），日志流 `running → usage → diff-summary → judging → score → judged → end(completed)`。

---

## 终止一轮之后、或点「重新执行」时：`INTERNAL：清理上一轮的行产物失败：…（EPERM, Permission denied: \\?\…\.agenthome '\\?\…\.agenthome'）`

**日期**：2026-10-07（当日复核并**改判根因**；`.judgehome` 上的同形报错即同一条）

**现象原文**（界面 + `run.json` 的 `error.message`，`.agenthome` 与 `.judgehome` 两种落点逐字同形）：
```
清理上一轮的行产物失败：D:\.tmp\aieval\runs\<runId>\rows\<rowId>（EPERM, Permission denied: \\?\…\.judgehome '\\?\…\.judgehome'）
```
症状的**反直觉处**：同一行连着 7 次尝试（`attempts: 7`）全部折在这一句上，而前两条产物（`workspace` / `.agenthome`）都删掉了——磁盘现场只剩 `.judgehome`，与报错点名的那一条互证。

**根因（三层，缺一层都解释不了「为什么每次都失败」）**：

1. **codex 自己在启动阶段 spawn 了一串 `git` 孙进程**。0.156.1 的 `thread/start` 会同步 curated 插件目录（二进制字面量 `core-plugins/src/startup_sync.rs`、`https://github.com/openai/plugins.git`），真机进程树逐字是
   `codex.exe → git.exe ls-remote … → git.exe → git remote-https → git-remote-https.exe`，
   落到 `$CODEX_HOME/.tmp/plugins-clone-<rand>/` 并留下 `.tmp/plugins.sync.lock`。
2. **`child.kill()` 在 Windows 上只杀直接子进程**（`appserver/client.ts` 的 `close()` 原来就是这一句）。父进程一死，四个 `git` 孙进程照样活着，而且它们**继承了父进程的句柄**——注意它们的命令行里连 `CODEX_HOME` 都不出现，所以「按路径扫进程」是扫不到的。杀不掉又扫不到 ⇒ 目录被锁住，`rmdir` 抛 `EPERM`。
3. **`fs.rmSync` 在本机没有可用的重试**（`maxRetries`/`retryDelay` 只对**异步** `fs.rm` 生效，见 `packages/server/core/src/remove-tree.ts` 文件头）⇒ 一次瞬时占用就被折成 `INTERNAL`，锁没消失之前**每次重跑都失败**。

**判据（真机，四格对照 + A/B，`packages/server/agents/probe/v7/codex-plugins-sync.mjs`，落盘 `probe/dumps/v7/codex-plugins-sync.json`）**：

| 格 | 孙进程 | `.judgehome` 里的残骸 | 只杀直接子进程后能删目录 |
|---|---|---|---|
| 基线（今天的线程级 `config`） | 4~5 个 `git` | `plugins-clone-*/` + `plugins.sync.lock` | ❌ `EPERM`（50ms / 250ms / 2s / **10s** 四个时点全红） |
| 线程级 `config.features.plugins=false` | 4 个 | 同上 | ❌ `EPERM` |
| 盘上 `$CODEX_HOME/config.toml` 写 `[features] plugins = false` | **0** | 无 | ✅ |
| 进程级 `argv: -c features.plugins=false` | **0** | 无 | ✅ |
| A/B：按 pid 杀**整棵树**（`taskkill /PID <pid> /T /F`） | 0（连带 5 个 pid） | — | ✅ **立刻成功** |

⚠️ 两个容易踩空的点：**线程级 `config` 管不到这个 startup sync**（只有盘上的 `config.toml` 与进程级 `-c` 管得住）；**孙进程的命令行里没有 `CODEX_HOME`**，所以「按路径扫进程再杀」这条路不通——必须在父进程还活着的时候按**进程树**杀。

**解决方案（2026-10-07 落地，四项）**：

1. `agents/src/process-tree.ts`（新）：`terminateProcessTree()` —— Windows `taskkill /PID <pid> /T /F`、POSIX 进程组 `SIGKILL`（spawn 时 `detached`），**并且等 `exit`**（`kill()` 返回 ≠ 进程已退出、更 ≠ 句柄已释放）；杀树失败退回直接 kill，等不到也不抛（如实回 `exited: false`，由调用方 WARN）。
2. `appserver/client.ts` 的 `close()` 改成异步：回收整棵树 + 等退出；`session.ts` 的**起手三步失败也要回收**（那三步抛错时 `runTurn` 拿不到 `TurnStart`，`dispose` 永远不会被调用——进程就此常驻）。
3. `core/src/remove-tree.ts`（新）：有界真重试（6 × 250ms，白名单与 Node 异步 `rimraf` 同表），行产物的三条删除都走它；仍失败时文案**点名成因**（「常见成因是上一轮的厂商子进程尚未退出」）。
4. claude / dsh 是**SDK 代 spawn**（公开面没有 pid），本仓拿不到整棵树 ⇒ 如实登记为「尽力」，由上面的有界重试兜底（归属表见《厂商进程生命周期规范》）。

**变异验证（每条守卫都见过失败，改完按 sha256 复原一致）**：

| 变异 | 结果 |
|---|---|
| `close()` 退回 `child.kill()` | `client.test.ts` 4 条红 + **真机** `lifecycle-live.test.ts` 红（`close() 之后仍有残留进程`） |
| `taskkill` 去掉 `/T` | `process-tree.test.ts` 1 条红（命令逐字比对）+ **真机守卫红**（4 个孙进程存活） |
| 起手失败不回收 | `session.test.ts` 3 条红 |
| 子树回收不再重试 | `remove-tree.test.ts` 2 条红（`attempts: 1 ≠ 3`） |

**真机守卫（默认跳过，需显式开）**：
```
AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts
```
它走**本仓的适配器**（不是裸二进制）：`createAppServerClient` → `initialize` → `thread/start`（触发插件同步）→ `close()`，断言「没有残留的 codex/git 进程」且「该行的 `CODEX_HOME` 可以删掉」。

**未闭合**：插件同步本身没关（`features.plugins=false` 只在盘上 `config.toml` 或 `-c` 上生效，且会改变被测智能体的能力面）。今天它只表现为「每次 `thread/start` 白连一次 github + 起一串 git」，进程树回收已经不再让这件事变成行失败。

**相关资料**：`taskkill` 的 `/T` 语义（https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill）；Node `fs.rm` 的异步重试白名单（`internal/fs/rimraf` 的 `retryErrorCodes`，同步 `rmSync` 走 C++ 不走这条）。

---

## 测试里「本轮永不结算」/ `Error: Test timed out in 40000ms`（整个 codex 测试目录跑十几分钟）

**日期**：2026-10-07

**根因**：夹具在 `turn/start` **请求处理内部同步**把 `options.notifications` 推给订阅者，而适配器是在 `await request('turn/start')` **返回之后**才 `subscribe` 的 ⇒ 那批通知（含 `turn/completed`）被丢，本轮永不结算。表现是「每个依赖终态通知的用例各挂 40s」，看起来像「测试很慢」，实际是**逐条超时**。

**解决方案**：夹具改为「推入时若没有任何订阅者 → **缓冲**，首个订阅者注册时按序补投并清空缓冲」（`providers/codex/appserver-fixtures.ts`）。只缓冲「无订阅者」的那些，故「先订阅、后手动 `emit`」的既有用例语义不变。

效果：`providers/codex` 目录总时长 5.76s → 0.79s，「用户终止」用例 5008ms → 1ms。

---

## `AGENT_LOAD_FAILED：厂商 SDK 加载失败：@openai/codex（原因：找不到 codex 可执行文件：解析 @openai/codex-darwin-arm64/package.json 失败（… ⇒ Cannot find module '@openai/codex-darwin-arm64/package.json'））

**日期**：2026-10-08

**现象原文**：
```
AGENT_LOAD_FAILED：厂商 SDK 加载失败：@openai/codex（原因：找不到 codex 可执行文件：解析 @openai/codex-darwin-arm64/package.json 失败（/…/node_modules/.pnpm/@openai+codex@0.156.1/node_modules/@openai/codex/package.json ⇒ Cannot find module '@openai/codex-darwin-arm64/package.json' …）（平台=darwin/arm64 → 三元组=aarch64-apple-darwin → codex=/…/@openai+codex@0.156.1/node_modules/@openai/codex/package.json））
```
注意文案尾部 `codex=…` 给的是 **CLI 包的 `package.json` 路径**而不是可执行文件路径——这是 `steps` 里「第一跳成功、第二跳失败」的形状，别误读成「CLI 包装错了」。

**根因**（应用侧解析链**没有**缺陷，故障面是「依赖没落全」）：
`@openai/codex` 是纯 JS 启动器（`bin` 只有 `bin/codex.js`），原生可执行文件在**平台包** `@openai/codex-darwin-arm64`（= `@openai/codex@0.156.1-darwin-arm64` 的 npm 别名）的 `vendor/aarch64-apple-darwin/bin/codex` 里；平台包是 CLI 包的 `optionalDependencies`，只链在 CLI 包自己的 `node_modules` 下。而本机这份 `node_modules` 里该平台包**只剩空壳**：`node_modules/.pnpm/@openai+codex@0.156.1-darwin-arm64/node_modules/` 是空目录，既**不在 pnpm store 的 `package_index`**（`~/Library/pnpm/store/v11/index.db` 能查到 CLI 包 `@openai/codex@0.156.1`，查不到 `0.156.1-darwin-arm64`），也**不在 `.modules.yaml` 的 `skipped`**（`skipped` 是平台过滤名单，里面全是别家平台的包；darwin-arm64 两个都不在，即 pnpm 本意要装它）⇒ 不是「平台判定跳过」，是那一次安装**从未把它取下来**。旁证：`@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.281` 是**同一个形状**（同样空壳、同样不在 store 索引），同一份 `.modules.yaml` 的 `prunedAt = Thu, 08 Oct 2026 02:22:44 GMT`。

**为什么后来重装也修不好（本条真正值钱的地方）**：pnpm 的「已安装」真源是 **`node_modules/.pnpm/lock.yaml`**，它与仓库 `pnpm-lock.yaml` 一致时 pnpm 直接 `Already up to date`，**不校验文件是否真的在盘上**。于是三种常规手段全部无效，实测：
- `pnpm install --frozen-lockfile` ⇒ `Already up to date`（164ms），空壳照旧；
- **先把空目录删掉**再 install ⇒ 仍 `Already up to date`，**也不会重建**；
- `pnpm install --frozen-lockfile --force` ⇒ 只多一句 `[WARN] using --force I sure hope you know what you are doing`，仍 `Already up to date`（`--force` 管的是「已存在的包也重新取/重链」，管不到**缺失**的包）。
唯一能让 pnpm 承认不一致的是**挪走内部 lock**（`node_modules/.pnpm/lock.yaml`），此时它报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 并要求**清空整个 `node_modules` 重装**——代价是重下 1056 个包（含这个 131 MB 的二进制）。

**排除项（都实测过，别再去查）**：镜像 `registry.m.jd.com` **能给**这个包——`dist.tarball` 200，131 652 985 字节，SHA1 `6490e0ad…` 与镜像 manifest 的 `dist.shasum` **逐字节一致**，包内确有 `package/vendor/aarch64-apple-darwin/bin/codex`。即**不是下载/网络/镜像缺包**，是本地那一次安装没落地。

**解决方案**（本次；环境级修复，未改任何产品代码）：
1. 取镜像 tarball 并**校验后再用**：`curl -o codex.tgz http://registry.m.jd.com/@openai/codex/download/@openai/codex-0.156.1-darwin-arm64.tgz`，比对 `shasum` 与镜像 manifest 的 `dist.shasum`；
2. 解到 pnpm 本该落成的那个位置（`--strip-components=1` 去掉包内 `package/` 前缀）：`node_modules/.pnpm/@openai+codex@0.156.1-darwin-arm64/node_modules/@openai/codex/`；tarball 自带的 `0755` 可执行位要保住（校验 `vendor/aarch64-apple-darwin/bin/codex` 是 `-rwxr-xr-x`）；
3. 判据（三条全绿才算修好）：真 Node `createRequire` 走一遍两跳（**必须绕开 vitest 的解析器**，见下条 FAQ）⇒ 二进制路径存在；`codex --version` ⇒ `codex-cli 0.156.1`；`pnpm vitest run packages/server/agents/src/providers/codex/appserver/binary.test.ts` ⇒ 7/7。
4. **变异验证（做过了）**：把平台包整个移开再跑上面那个文件 ⇒ 真机守卫那条红，抛出的正是本条标题那段原文（`Cannot find module '@openai/codex-darwin-arm64/package.json'`），其余 6 条仍绿；移回 ⇒ 7/7。守卫有效，不是摆设。

**副作用与残余风险**：手工物化的文件不在 store 的 `files/` 里（是复制而非硬链），`pnpm store prune` 不会删它，但下次「清空 node_modules 重装」会把它抹掉并**重新走一遍这个坑**（装机后请立刻跑上面第 3 条判据）。另一家 `@anthropic-ai/claude-agent-sdk-darwin-arm64` 的空壳**本次没修**（Claude 适配器另有 JS 路径可走），要用到它时按同一套办法处置并单独记账。

---

## 二进制解析的真机守卫对「第二跳基准」没有区分力

**日期**：2026-10-07

**根因**：测试进程里裸说明符的解析**由运行器接管**（vite-node/vitest 带 pnpm store 感知），比生产 Node 宽松 ⇒ 把第二跳基准由 `createRequire(codexPackageJson)` 改成 `createRequire(import.meta.url)`，`binary.test.ts` **仍然绿**；而同一写法在真 Node 里对平台包全部 `MODULE_NOT_FOUND`。

**解决方案**（未闭合，如实记账）：在用例内**登记覆盖边界**，不用假夹具掩盖；真实路径的正确性由「解析结果的路径形状必须是 `<平台包>/vendor/<triple>/bin/codex(.exe)`」这条真机守卫承担。
要闭合只有两条路，都**没做**：在真 Node 子进程里跑一次（多一次进程创建，本仓按「进程创建计价」），或加形状式源码断言（引入第二个真相源）。

---

## 解析链里的 `ensureV1Suffix` 不能省：codex 只走 `{base}/v1/responses`

**日期**：2026-10-07（复核既有口径）

**现象**：路由给的是 `https://api.deepseek.com/`，若原样交给 CLI，请求会打到 `https://api.deepseek.com/responses`（不存在）。

**根因**：CLI 在 base_url 后**直接拼 `/responses`**，不补 `/v1`；provider 配置里的 base_url 必须是「Responses 的根」。

**解决方案**：`const baseUrl = ensureV1Suffix(input.route.baseUrl)`（`route.ts`，只对 URL 的路径段做规范化，query/fragment 一个字符不动）。实测 `https://api.deepseek.com/v1/responses` 与 `/v1/chat/completions` 都返回 200（该网关两个 API 都讲），但 codex **只走 Responses**（见下一条）。

---

## 适配器只能钉 `wire_api: 'responses'`（`chat` 及其别名全被 CLI 拒）

**日期**：2026-10-01（本仓实测结论）；2026-10-07 在 **app-server 路径**上复核并**改判根因**（见下）

**现象原文**（app-server 的 `thread/start` 响应，`-32600`；线程级 `config` 注入 `wire_api: 'chat'`）：

```
failed to load configuration: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
in `model_providers.aieval.wire_api`
```
```
failed to load configuration: unknown variant `chat_completions`, expected `responses`
in `model_providers.aieval.wire_api`
```
别名 `chat_completions` / `openai-chat` / `completions` 走第二条（`unknown variant`）。

**根因**（2026-10-07 收窄）：**不是配置写法，是 codex 客户端已删除 chat 实现**。三条独立证据：
1. `0.156.1` 二进制里 `chat/completions`、`v1/chat`、`use_chat_completions` **零命中**——没有一个 chat 客户端可走；
2. `0.160.1`（npm `latest`）源码 `codex-rs/model-provider-info/src/lib.rs` 的 `pub enum WireApi` **只剩 `Responses` 一个变体**，`"chat"` 直接映射到上面那句「已移除」错误 ⇒ **升级版本也换不来 chat wire**；
3. 连内置的 `ollama` / `lmstudio` 也改成 `WireApi::Responses`（二进制里的描述已写成 `Local Ollama server (Responses API, default port 11434)`）。

**为什么以前只记成「枚举拒收」不够**：那只说明「这个值不合法」，会让人以为「换个拼写/升个版本就行」。真正要记的是**这条路在客户端已经不存在**。

**解决方案**：适配器**只能**钉 `responses`，并给 base URL 补 `/v1`（`POST {base}/v1/responses`，见 `ensureV1Suffix`）。**不要**为了拿推理正文或用量去改 wire——两样都不需要 chat：

- 思考正文：`reasoning.content[]` 在 responses 上就是明文全文（`summary[]` 反而是空的），见本文件「`codex exec --json` 一条 reasoning 都没有」一条；
- 子智能体用量：`thread/tokenUsage/updated` **按线程各报一份**（子线程那份经 `thread/list{ancestorThreadId}` 认领），与 wire 无关。

判据（真机，2026-10-07）：`node probe/v6/codex-chat-wire-appserver.mjs only=wire` —— `chat`/别名四个取值 `thread/start` 全被拒，`responses` 对照组打到 `POST /v1/responses`（判据本身因此可信）。完整读数见 `packages/server/agents/probe/v6/REPORT.md`。

**相关资料**：`docs/protocols/message-spec.md`（消息规范，含本条目的演进结论）、[openai/codex discussions#7782](https://github.com/openai/codex/discussions/7782)

---

## `JUDGE_PARSE_FAILED：评分智能体没有给出可读的最终答复（该适配器未回传最终消息）`（codex 当评分智能体时必现）

**日期**：2026-10-07

**根因**：app-server 重构把答复搬到了 `item/completed` 的 `agentMessage` 条目上，却**没有任何一处写骨架的 `state.finalText`**——`message.ts` 只把条目归一成**内容块**（给界面），而 `finalText` 是**行结果**那一格（`turn.ts` 的 `TurnState.finalText`，`judge-agent.ts` 只读它）。另两家都有这条出口（claude 在 `projectResult` 取 `result`、dsh 在 `assistant/message` 上取 `reply`），codex 在重构里丢了。

后果是**最难查的一种**：会话本身 `ok: true`、`turns: 1`、上游也按 schema 回了 JSON，只有本仓交不出答复 ⇒ 评分阶段一律折在「没有可读的最终答复」上，而 `capability.structuredOutput: true` 成了空头支票（schema 真发了，拿回来的东西没人接）。

**解决方案**：`providers/codex/events.ts` 的 `itemStarted` / `itemCompleted` 分支写 `state.finalText`，四条条件缺一不可——`itemCompleted`（`item/started` 的正文可能只是半截）、`agentMessage`、主线程（子线程结论不许顶掉主会话产出）、正文非空（空块不是答复）。

判据与验证（`index.test.ts` 新增「最终答复出口：finalText」5 条守卫）：

| 变异（人为造回缺陷） | 结果 |
|---|---|
| 去掉 `itemCompleted` 判据（让 `item/started` 也写） | **只红**「`item/started` 的半截正文不写 finalText」 |
| 去掉主线程判据 | **只红**「子线程的答复不覆盖主线程那一格」 |

两次变异后 `events.ts` 的 sha256 均复原一致（`FDBCD3403D06FCF2360EABC28B253FCA2FA271037BDC2CAFC9BC6FEEC9DC80EB`）。

**真机**（临时端到端用例，直连 `api.deepseek.com` + `deepseek-flash` + `JUDGE_OUTPUT_JSON_SCHEMA`）：修复前 `ok=true, turns=1, finalText=null` ⇒ 用例红；修复后 `finalText` 是符合 schema 的裸 JSON ⇒ 绿（2.37s）。

**相关资料**：`codex app-server generate-json-schema` 的 `v2/TurnStartParams.outputSchema`（原文「Optional JSON Schema used to constrain the final assistant message for this turn」）；结构化输出的 wire 落点与 A/B 对照见 `docs/protocols/codex.md`（Codex 接入）与 `docs/features/judging.md`（评分）。

---

## 带 `outputSchema` 的一轮跑满 180s 仍无任何答复条目（`settle=timeout`；同题面同模型的对照组 94s 正常收尾）

**日期**：2026-10-07

**现象原文**（探针输出，`probe/v4/codex-structured-output.mjs` 的首次运行）：

```
[v4]    turn/start 接受=true 结算=timeout
[v4]    条目类型：userMessage, reasoning, reasoning, …（37 条 reasoning，**无 agentMessage**）
[v4]    最终答复是裸 JSON=false
```

同一份探针在**同参数**下的第二次运行 1.7s 正常收尾，wire 记录为 `text.format={"format":{"type":"json_schema","strict":true,…}}` + `status=200`。

**根因**：**未定位**。已排除两格：① 不是「字段被拒」（同参数复跑 1.7s 收尾、上游 200）；② 不是「CLI 没把 schema 发出去」（wire 两次都带 `text.format`）。观察到的形态是模型在 `unable to locate image at …` 上反复尝试读不存在的文件、reasoning 条目涨到 37 条而始终不产出 `agentMessage`——与「结构化输出」的因果关系**尚未证实**，不要当结论用。

**下一步**：用带 relay 的形态复现（`node probe/v4/codex-structured-output.mjs only=schema timeoutMs=420000`，wire 记录落 `probe/dumps/v4/codex-structured-output.json`），看那一次的 `response.completed` / `incomplete_details` 与请求条数——判据是「有没有 `response.completed`」。若再现且卡在同一处，再往上游（`api.deepseek.com` 的 Responses 在 json_schema 下偶发不收敛）查，本仓这一层无处置可做。

---

## `codex exec --json` 里一条 `item.type === 'reasoning'` 都没有（`show_raw_agent_reasoning=true` 也不管用）

**日期**：2026-10-07（复核并**改判**既有归因）

**现象**：事件流里 `reasoning` 条目恒 0 条，而会话文件（`rollout-*.jsonl`）里同一条目 `content[].reasoning_text` 是全文。

**根因**（三层，缺一层都解释不了「0 条」）：

1. **上游把明文放在 `content`，`summary` 恒空**。DeepSeek `/v1/responses` 的推理条目逐字是
   `{"type":"reasoning","content":[{"type":"reasoning_text","text":"…全文…"}],"summary":[],"encrypted_content":"59fb31d4-…-0"}`。
   `encrypted_content` 只是一个 38 字符的**引用 id**（不是密文）；`summary` 是**空数组**；即使请求里**不给** `reasoning` 字段也照样返回明文。
2. **`exec` 的 JSONL 投影只认 `summary`**：`exec/src/event_processor_with_jsonl_output.rs` 的
   `ThreadItem::Reasoning { summary, .. } => { let text = summary.join("\n"); if text.trim().is_empty() { return None; } …}`——只取 `summary`、**丢弃 `content`**；且 started 阶段对 reasoning 直接返回 `None`（不发 `item.started`）。与第 1 层合起来，「0 条」是**必然**。
3. **那两个开关本来就不管这条路**：`show_raw_agent_reasoning` / `hide_agent_reasoning` 全仓唯一的运行时消费点是 legacy 事件投影（`protocol/src/legacy_events.rs`）与 TUI / `exec` 的人类可读输出；**app-server v2 的 `ThreadItem` 与 `item/reasoning/*` 通知一个都不读它们**。⇒ 之前把它归因给 [openai/codex#7090](https://github.com/openai/codex/issues/7090)「config not respected」是**错误归因**（该 issue 仍 open，且它讲的是 TUI 显示）。

**解决方案**：**取思考内容一律走 app-server，不要再用 `exec --json`，也不要再试那两个开关**。

- 快照：`item/completed` 的 `ThreadItem.reasoning.content[]`（字符串数组，一项即全文：4 case 实测 117 / 227 / 151 / 278 字）；`item/started` 那一帧两格**都是空数组**（别在 started 就取值）。
- 增量：`item/reasoning/textDelta`（带 `contentIndex`，本路由恒 `0`）——**逐字拼接后与 `content[0]` 完全相等**（4/4；39 / 54 / 49 / 72 条）。增量是**子词级**的（逐字样本：`"The"` / `" r"` / `" conclusion"`），且**条数恰好等于 `reasoningOutputTokens`**（1 delta ≈ 1 token）⇒ 这一格可以当「思考增量真在跑」的旁证。
- ⚠️ **本条原来写的「`summaryTextDelta` / `summaryPartAdded` 恒 0 条 ⇒ 摘要在 DeepSeek 上结构性拿不到」已被后续读数推翻**：在 3 条路由 × 2 个模型上跑 10 次往返，**摘要恰恰是实际拿得到的那一档**（`item/reasoning/summaryTextDelta` 会到、7 次推理条目的 `summary[]` 全非空），而 `textDelta`（全文）**一次未到**、`content[]` 恒为 `[]`。⇒ 由此得出的「`thinkingTextKind: 'full'` 与实际相符」也**不成立**；该报哪一档**未闭合**（要先有一条稳定产出 `content[]` 的路由读数，才能定这是「能力档」还是「本路由档」）。`summaryIndex` 有样本，不是「无样本」。
- 配置面**没有开关可拧**（三条通知在 app-server 里无条件下发）。唯一要守的一条：`model_reasoning_summary` **不设或写 `auto`**——写 `'none'` 时 codex 会**整个省略**该键（`summary != None` 才 `then_some` + `skip_serializing_if`，所以它自身安全），但**手写**请求带 `"summary":"none"` 会被该网关 422 拒：``unknown variant `none`, expected one of `auto`, `concise`, `detailed` ``。
- ⚠️ **本仓那一格是空转**：`providers/codex/index.ts:49` 的 `CODEX_OFF_REASONING_SUMMARY = 'none'`（`effort === 'off'` 时注入）在真机上**既不报错、也不影响推理照常产出**——`off-both` case（`effort:none` ∧ `summary:none`）照样拿到 1 段 278 字明文 ⇒ 「两格一起才生效」在**观测面上不成立**：`none` 只是被 codex 消化掉（**丢弃还是翻译成别的值，未验证**）。文案仍按「已按要求下发」说，但不要指望它关掉任何东西。

判据（真机，2026-10-07）：`probe/v5/codex-appserver-reasoning.mjs`，**四个 case**（`model_reasoning_summary` = 未设 / `detailed` / `none`，再加 `effort:none` ∧ `summary:none` 的 `off-both`）全部 `turn/completed.status=completed`、`error=null`，`reasoningOutputTokens` = **39 / 54 / 49 / 72**（非 0）；完整报告 `probe/v5/REPORT.md`，原始通知逐行落盘 `probe/dumps/v5/codex-appserver-reasoning-<case>.jsonl`（`dumps/` 已 gitignore，跑一次即可重建）。

**收尾读回与通知同源**（顺手闭合）：`turn/completed` 里 `turn.itemsView` 是 `"summary"`，而结束后的 `thread/read{includeTurns:true}` 是 `"full"`——4/4 读回的 reasoning 条目与 `item/completed` **逐字相同**（`reader.ts` 的「不是 full 就改走 `thread/items/list`」降级判据正依赖这个差异，本轮证实成立）。
（首轮探针曾读出「0 个 turn」，那是**采集缺陷**：`turn/completed` 一到就结算客户端，收尾 `thread/read` 被 reject；现版本只把它当信号、不结算，读回即正常。**别把探针自己的时序缺陷记成产品结论**。）

**另一条反直觉事实**：`app-server` 在 `turn/completed` 之后**不会自己退出**，`kill()` 后 Node 给的 `code` 恒为 `null`（4/4）⇒ **子进程退出码不能当本轮成败判据**，成败只认 `turn/completed.status` + `error`。

**相关资料**：
- 投影口径 [`exec/src/event_processor_with_jsonl_output.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L143-L160)
- 条目映射（无门槛）[`app-server-protocol/src/protocol/v2/item.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L908-L912)
- 通知无条件下发 [`app-server/src/bespoke_event_handling.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/bespoke_event_handling.rs#L1000-L1011)
- 开关只作用于 legacy [`protocol/src/legacy_events.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/protocol/src/legacy_events.rs#L162-L183)
- `include` 硬编码 `["reasoning.encrypted_content"]` [`core/src/client.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/client.rs#L942)、`summary` 省略规则同文件 [`client.rs:848-863`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/client.rs#L848-L863)

---

## 评分智能体回「无法读取任何工作区文件」、三项全判未达成（`read-only` 下连 `echo` / `git status` 都被拒）

**日期**：2026-10-07

**现象原文**（真机把 codex 当评分智能体，评一个**确实做到了** Vue3 CDN + Hello World 的工作区）：

```
本次评审环境禁止执行任何 shell 命令，工作区内文件与 diff 均无法读取，三项评分标准均缺乏可见证据，故全部记为未达成。
```
```
本环境完全拦截 shell 命令（连 echo、git status 均被 policy 拒绝），无法读取任何工作区文件，因而无法确认页面是否通过 script 标签从 CDN 引入 Vue 3 的 3.x 全局构建。
```

`totalScore = 0 / 25`（三项权重 10/10/5 全判未达成）。**链路是通的**：`ok`、`judgments` 三项齐全、`structuredOutput: true`、`verdict` 有值——错的只有结论。

**根因**：`CODEX_PERMISSION_OPTIONS['read-only']` 把评分阶段钉在 `sandbox: 'read-only'`（设计意图「评审者只读」），而 **codex 在 Windows 上只有 `danger-full-access` 这一档能真正启动子进程**：`read-only` 与 `workspace-write` 下连 `echo hello` / `git status --porcelain` / `apply_patch` 都被拒，stderr 原文是
`codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(\"… rejected: blocked by policy\")" }`。
codex 没有独立的文件读取工具，读文件只能靠 shell ⇒ 受限沙箱在 Windows 上等于把评审者蒙上眼睛。

**关键证据**（同一份题面「读取 `secret.txt` 并原样报告」，三档对照；探针 `probe/v4/codex-structured-output.mjs`）：

| sandbox | 能否读到 | 现象 |
|---|---|---|
| `read-only`（评分阶段用的档） | ❌ | 答复「读不到」；`Get-Content` / `Get-ChildItem` / `cmd /c type` 全被拒 |
| `workspace-write` | ❌ | 答复「读不到」；`echo hello`、`git status`、`apply_patch` 全被拒 |
| `danger-full-access` | ✅ | 真的执行了 `commandExecution`，答复 `` `HELLO-42-CODEX-READ` ``（与文件内容逐字一致） |

**解决方案**（2026-10-07 裁决为方案 (a)，已落地）：适配器**按平台选档**——`permission.ts` 的 `codexPermissionOptions()` 在
**Windows** 上把只读档落成 `danger-full-access`（别的平台一个字不改：macOS 的 seatbelt / Linux 的 landlock 有可用的只读实现），
先把「读得到」这条底线拿回来。代价是评审者在 Windows 上**能写**工作区，兜底是编排层的「评分前后 diff 摘要对照」——
它同时**从 WARN 升级为该行失败**：拿到分之后才发现现场被改过 ⇒ `JudgeAgentError('AGENT_FAILED')` ⇒ 行 `failed` + `stage: 'judge'`
（拿不到分时只留痕：那种情况的第一归因仍是「它为什么没跑完」，拿污染顶掉真因是不可接受的）。

判据（三条，各自见过失败）：

| 守卫 | 变异 ⇒ 红在哪 |
|---|---|
| `permission.test.ts`：Windows 落最宽档、Linux/darwin 保持 `read-only`、常量表本身不被就地改写 | 去掉 `platform === 'win32'` ⇒ 唯一红 `expected 'danger-full-access' to be 'read-only'` |
| `providers/codex/index.test.ts`：接线走翻译层那一份（不绕过它索引常量表） | 把 `codexPermissionOptions()` 换回直接索引 ⇒ `sandbox` 期望值对不上 |
| `orchestrator-judge-route-b.test.ts`：评审者写文件 ⇒ 该行 `failed` + `error.code === 'AGENT_FAILED'` + `error.stage === 'judge'` | 退回只留痕 ⇒ 唯一红 `expected 'judged' to be 'failed'` |

**真机复验**：同一份候选（Vue3 CDN + Hello World + 无构建工具）修后**三项全达成、`totalScore = 25 / 25`**；
修前同一份候选是 `0 / 25`，理由「无法读取任何工作区文件」。

**复跑判据**：`node probe/v4/codex-structured-output.mjs only=readonly-read,ww-read,full-read timeoutMs=240000`

---

## 思考块恒为 `{"type":"thinking","text":null,"textKind":"none"}`（增量明明带着文本；界面显示「思考文本未采集」，修前显示「厂商有、我们还没接」）

**日期**：2026-10-07

**现象原文**（真机 `messages.jsonl`，`messageId: run-codex:N`；run `2e9eae15` 的 codex 行 **5020/5020** 个思考块都是这个形状）：

```jsonc
{"messageId":"run-codex:2","mergeKey":"main|1|assistant|-","chunk":"delta","assembly":"snapshot",
 "blocks":[{"type":"thinking","text":null,"textKind":"none","signature":null}],
 "raw":{"kind":"reasoningTextDelta","itemId":"e244d02d-…","delta":"The"}}   // ← 增量带着 "The" 到达，落盘却是 null
```

**根因**（两处叠加，缺一条都不会是这个形状）：

1. **`item/started` 的空占位把槽位 seal 了**。真机上 `item/started` 的推理条目 `summary` 与 `content` **都是空数组**（那是「开始推理了」的占位，不是「这一轮没有文本」），而适配器把它当**快照**落进槽位 ⇒ 合并器的 `applyBlock` 落进「已有键 + 增量，但槽位已 seal ⇒ **直接丢弃**」那一支，紧随其后的几十条 `item/reasoning/textDelta` **全部被扔掉**。
2. **`item/completed` 又什么都没补**。当时的判据是「推完的那段增量与 `content[]` 逐字相同 ⇒ 不重发（免得同一份内容说两遍）」，而真机上这两者**恰好逐字相同** ⇒ 那一块永远停在 `text: null` + `none`（`assembly` 还是第 1 步 seal 时留下的 `snapshot`，所以连「未收尾」都看不出来）。

⇒ 症状是「厂商明明给了全文（真机 `content[]` 117~312 字明文），落盘一个字的没有」。另外「逐字相同就不发快照」还把**收尾**一起省了：`assembly` 只有快照能翻，省掉它的结果是那一块永远挂着「思考中…」。

**解决方案**（`providers/codex/message.ts`，两处**一起**改）：

1. `item/started` 的推理条目**不产块**——`projectItem` 收一个 `started` 标志，为真时直接返回空；文本由增量通道累积、由完成通知封口；
2. `reasoningDrafts` **无条件补快照封口**——删掉「逐字相同就不发」的判据。内容不变的重发是幂等的（合并器对同一个块标识是**覆盖**语义），而「内容相同」与「已收尾」是两件事。

守卫与变异（`providers/codex/message.test.ts`，每条都见过失败）：

| 变异（把缺陷造回去） | 结果 |
|---|---|
| 恢复 `item/started` 产块 | 2 条红（「真机序列」「`started` 的空占位不占用块序号」）；⚠️ **真机重放不红**——封口修好后空块会被完成快照覆盖，所以这条修的是**实时增量与块序号**，不是「能不能拿到全文」 |
| 恢复「逐字相同就不重发」 | 3 条红（含既有的「只回密文但全文已推完 ⇒ 补快照封口」） |

**真机端到端确认**（2026-10-07，一次性脚本，跑完即删）：**走真实适配器**（`codexProvider.run` → spawn `codex app-server` → 通知归一 → 合并器）跑一次 `deepseek-reasoner` —— `ok=true` / `exit=completed` / 168 条消息里 **168 个思考块全部带正文**、末块 459 字、`textKind: 'full'`、`assembly: 'snapshot'`。这一条覆盖生产链路本身；下面的 dump 重放只覆盖归一之后的半段。

**真机重放判据**（不入库）：把 `probe/dumps/v5/codex-appserver-reasoning-<case>.jsonl` 的原始通知逐行喂进修复后的归一函数 + 合并器 —— 4 个 case 的思考块正文分别是 **117 / 227 / 151 / 278 字**（与真机 `content[]` 逐字相同）且 `assembly: snapshot`；把第 2 条变异造回去 ⇒ **4/4 红**，失败原文 `思考块正文: expected null not to be null`。

**界面那一半**（`client/ui/src/composite/agent-log/`，2026-10-07 用户口径）：**没有正文的思考块整块隐藏，不给任何占位文案**。此前 `build-model.ts` 把 `text === null` 一律说成 `'not-observed'`（「厂商有、我们还没接」）——而 codex 的思考文本恰恰**来自我们接了的**通道，那句话是反的；改成「按能力分档给一句更准的文案」之后用户直接裁定：**没有就不显示**（占位文案本身就不是内容）。
落点是两层：`build-model.ts` 的 `blocksOf` 过滤掉 `text === null` 的思考块（模型层，任何消费方都拿不到），`thinking-block-view.tsx` 在 `text === null` 时返回 `null`（组件被别处直接构造时同样不出占位）。
守卫：`build-model.test.ts` 3 条（隐藏 / 同一消息里的正文块照常保留 / 有正文的思考块照常出现）+ `thinking-block-view.test.tsx` 2 条（整块隐藏且「思考」块头也不出现）。
变异：把 `blocksOf` 的过滤取反 ⇒ 9 条红（含 3 条新守卫）；去掉组件里的提前 `return null` ⇒ 2 条红。

**相关资料**：`docs/protocols/message-spec.md`（四句缺失原因的分工）、上面那条「`codex exec --json` 一条 reasoning 都没有」（同一份真机的另一条通道）。

---

## `turn/completed` 只收到**子线程**那一条，主线程仍是 `"status":"inProgress","completedAt":null`

**日期**：2026-10-07

**现象原文**（v6 探针第一轮的真机读数，两处合起来才是现象）：
```
[v6]     turn=未收到(timedOut=false) 用时=11s
```
```jsonc
// 同一时刻 thread/read{includeTurns:true} 里主线程那一轮：
{"itemsView":"full","status":"inProgress","error":null,"completedAt":null}
```
通知流里 `turn/completed` **只来了一条**，其 `params.threadId` 是**子线程**的 id；用时 11s 就"结束"了，
而主线程那一轮还在跑（最终答复也读不到）。修正判据后同一场景：**两条** `turn/completed`，
**子线程在前、主线程在后**，总用时 6.7s。

**根因**：主线程与每个子线程**各有自己的 turn**（`turn/start` 只起主线程那一轮，子线程由
`collabAgentToolCall` 的 `spawnAgent` 起）⇒ 通知流里本来就会有**多条** `turn/completed`，各自带不同
`threadId`。子智能体先干完，它的那一条就先到，**不能**当成本轮（主线程）的终结信号。
谁先谁后取决于活干得快慢，不是固定顺序。

**解决方案**：终结闸门必须**按 `threadId` 认本轮**（主线程那一轮）。生产侧早就是这个口径
（`appserver/session.ts` 的「终结只认本轮」，守卫 `appserver/session.test.ts` 的
「子线程的 turn/completed 不结算本轮，但通知照样产出」）——踩坑的是**探针**：它拿「任何线程的
`turn/completed`」当闸门，于是主线程终态、最终答复与两份用量的**终值**全都取不到（拿到的是子线程
结束那一刻的快照：主 45119/子 24903，修正后是主 44972/子 24888）。

判据（真机，2026-10-07）：`node probe/v6/codex-chat-wire-appserver.mjs only=live` —— 汇总里
`turnCompletions` 应是**两条、子线程在前**，且 `turnCompleted: true`（主线程那条等到了）。
完整读数见 `packages/server/agents/probe/v6/REPORT.md` ③。

**为什么值得记住**：这个缺陷**只表现为「读数不完整」而不是报错**——运行看着成功、用量也有值，
只是那些值全部取在「主线程还没跑完」的时刻。凡是「等一个终态再取数」的地方（探针、收尾读回、
编排层的 usage 汇总），判据都要问一句「这是**哪条线程**的终态」。

---

## 子智能体用量与思考正文：responses 上真机已可得（**不必**换 `wire_api`）

**日期**：2026-10-07

**这条要回答的问题**（用户口径，原样留着以便检索）：codex 是不是得改用 `/v1/chat/completions`
才拿得到思考内容与 subagent 用量？——**不是**。chat 那条路在客户端已经不存在（见上面那条
「适配器只能钉 `wire_api: 'responses'`」），而这两样在现有 responses 通道上真机都拿到了：

| 读数 | 主线程 | 子线程（nickname `Linnaeus`） |
|---|---|---|
| 思考正文 `reasoning.content[]` | **161 字明文**（`summary[]` 是空数组） | 该轮 `reasoningOutputTokens = 0`，没有可推的内容 |
| `item/reasoning/textDelta` | 35 条（**条数 = `reasoningOutputTokens`**，v5 的旁证规律再现） | 0 条 |
| 用量 `thread/tokenUsage/updated` | total **44972**（input 44774 / cached 44288 / output 198 / reasoning 35） | total **24888**（input 24830 / cached 24448 / output 58 / reasoning 0）——**独立一份** |
| 线程归属 | — | `thread/list{ancestorThreadId: <主线程>}` 返回该后代，`parentThreadId` 指向主线程 |
| 最终答复 | `done` | `输出：` + `CHILD-TOOL-RAN` 代码块（27 字） |

**根因/机制**（为什么与 wire 无关）：这两样数据的来源都不在 wire 上——
用量来自**通知** `thread/tokenUsage/updated`（厂商上报的**按线程**累计值，主线程与每个子线程各一条），
线程树来自请求 `thread/list{ancestorThreadId}`（一次拿到任意深度的后代）；
思考正文来自 `item/completed` 的 `reasoning.content[]`（本路由上就是明文全文）。
换 wire 改的是「HTTP 请求打哪个端点」，动不了这三条通道。

**顺带一条现成的数据源**：子智能体工具在 app-server 上是 `collabAgentToolCall`
（`tool` 取值 `spawnAgent` / `wait` / `closeAgent`），条目里带 **`receiverThreadIds`** 与
**`agentsStates`**——`wait` 的 `agentsStates[<childId>].message` **直接是子智能体的结论原文**
（本轮值就是上表那一行）。子任务行的「派发方式 / 结果摘要」不必自己拼。

**判据**（真机，2026-10-07）：`node probe/v6/codex-chat-wire-appserver.mjs only=live`
（需 `AIEVAL_PROBE_DEEPSEEK_API_KEY`）——汇总里 `thinking.withTextCount ≥ 1`、
`usage.childThreadsWithUsage` 与 `usage.childThreadIds` 逐项相等（一个不缺）、`threadList` 有后代。
A 组（`only=wire`，离线）另证 chat 不可用；完整读数与未验证项见
`packages/server/agents/probe/v6/REPORT.md`。

**边界（如实说）**：「子线程的思考内容会不会推给父连接」本轮**无样本**——两轮里子线程那一轮都是
`reasoningOutputTokens = 0`，没有内容可推 ⇒ **不能**据此说「子线程思考不推送」，别把它当结论用。

---

## `Error: ENOENT: no such file or directory, open '…/probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl'`（干净检出上「真机抓包重放」那条守卫必红）

**日期**：2026-10-09

**现象原文**：
```
 FAIL  |@aieval/agents| src/providers/codex/events.test.ts > 真机抓包重放：活动行在真实通知序列上的产出 > `spawnAgent` → `wait` 的真实序列产出「已派发子任务」与「子任务已完成」各一次
Error: ENOENT: no such file or directory, open '/Users/…/packages/server/agents/probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl'
 ❯ src/providers/codex/events.test.ts:492:27
    491|     const path = join(import.meta.dirname, '../../../probe/dumps/v6/co…
    492|     const notifications = readFileSync(path, 'utf8')
```

**根因**：这条守卫判的是「**真机抓包的形状**」，而抓包文件本身**不入库**——`probe/dumps/` 在 `.gitignore:21`（抓包可能含网关返回的敏感原文），`eslint.shared.ts` 的仓库级 `ignores` 也把同一目录排掉。于是干净检出、或任何没跑过探针的机器上，那个文件**必然不存在**：守卫从「真机形状」退化成「本机跑没跑过探针」，而且**永远不会变绿**——一条常驻红只会训练人忽略红。

这是「测试环境 ≠ 运行环境」的另一种方向：**单测红、代码无辜**。本 FAQ 前面几条记的是「单测绿、真机红」（假绿），成因同类——判据依赖了机器上的东西，而那个东西不在仓库里。

**解决方案**（`packages/server/agents/src/providers/codex/events.test.ts`）：把抓包路径提到模块级常量 `SUBAGENT_DUMP`，用例改成 `it.skipIf(!existsSync(SUBAGENT_DUMP))(…)`——**缺席跳过、在场照跑**。判据（双向验证过）：
1. 本机无抓包 ⇒ 该文件 `34 passed | 1 skipped`（此前是 `1 failed`）；
2. 临时往那个路径放一份**假**抓包 ⇒ 这条守卫真的跑起来并失败（`1 failed | 34 skipped`）⇒ 证明是「有条件跳过」而不是「被关掉」；
3. 删掉假文件复原 ⇒ 回到 `1 skipped`。

要在本机恢复这条重放，重跑一次探针把抓包生成回来即可：`node probe/v6/codex-chat-wire-appserver.mjs only=live`（需 `AIEVAL_PROBE_DEEPSEEK_API_KEY`，见上一条「子智能体用量与思考正文」）。「依赖未入库产物的守卫怎么写」已回写进[《测试策略与提速》](/guard/test-strategy)。

---

## `当前会话没有暴露 Playwright MCP 工具或资源`（注入成功、`mcpServer/startupStatus` 也报了 `ready`，模型却从第一轮起就断言没有这台工具）

**日期**：2026-10-11

**现象原文**（同一行里三处，缺一处都读不出因果）：

```
// 模型第一轮的思考（rollout；round 1 答复 07:50:34.5 早于 server ready 07:50:36.271）
We have no playwright MCP tools listed; tools only shell etc.
// 第二轮的答复（界面「执行日志」逐字）
当前会话没有暴露 Playwright MCP 工具或资源。我改用本地 Playwright 访问页面，并保留同样的分析目标。
```
```
// 同一份事件流（`vendor-system`），与上面两条**并行**发生
{"mcpServers":[{"name":"playwright","status":"starting","source":null,"error":null}],"mcpChannel":"vendor-startup-status"}   // 07:50:30.316
{"mcpServers":[{"name":"playwright","status":"ready","source":null,"error":null}],"mcpChannel":"vendor-startup-status"}      // 07:50:36.271
```

反直觉处：注入侧全绿——`ready` 报了、`mcpServerStatus/list{threadId}` 直接交出 `runtimeStatus: "connected"` 与 `browser_click … browser_wait_for` **25 个工具**、发出去的请求体里也有 `{"type":"namespace","name":"mcp__playwright","tools":[…]}`——而模型开局就说没有它，整轮（10 轮）用 shell + 本地 playwright 绕路；直到第 11 轮回头去调，撞上的是**另一条**缺口（`unsupported call: browser_navigate`，见上面那条）。

**根因**：**首轮起在了 MCP 服务器就绪之前**（本仓的时序缺陷；不是注入没成，也不是模型不听话）。

MCP 工具的落点是**工具表**，而工具表**随每条模型请求重算**——但 server `ready` 之前，那一格根本不在表里。适配器是 `thread/start` 一回来就 `turn/start`（两者相差毫秒），而 playwright MCP 走 `npx`：真机 `starting` 07:50:30.316 → `ready` 07:50:36.271，首轮请求 07:50:31.4 就发出去了 ⇒ 开局 1–2 轮的 `tools[]` 里没有 `mcp__playwright`，模型据此下结论并锁定路线（`ready` 之后的轮次工具会补上，但它已经不再回头看）。

判据（探针 A/B，`node packages/server/agents/probe/v10/codex-mcp-tools-capture.mjs`，只改「起轮次时机」一个变量）：

| 臂 | 起轮次时机 | 第一条模型请求的 `tools[]` |
|---|---|---|
| 与适配器同序 | `thread/start` 后立刻 `turn/start`，server 6 s 才 `ready` | `toolCount=12`，**没有** `namespace mcp__probe` |
| 等就绪 | 等 `startupStatus=ready` 再 `turn/start` | `toolCount=13`，**有** `namespace mcp__probe`（嵌套 `probe_echo`） |

⚠️ **不要用「模型答复」当判据**：模型会把结果编出来。硬判据只有两处——**事件侧**（`mcpServer/startupStatus/updated`）与 **wire 侧**（请求体的 `tools[]`，用记录型中转抓）。

**解决方案**（`packages/server/agents/src/providers/codex/appserver/session.ts`）：`thread/start` 与 `turn/start` 之间加 `settleMcpStartup()`——等**注入的每一台** MCP 落到终态（`ready` / `failed`）再起轮次。五条边界：

1. **预算**：`CODEX_MCP_STARTUP_WAIT` = 各台申报的 `startup_timeout_sec` 取最大（一台都没申报时按 30 s）+ 余量（5 s，给 codex 投出 `failed` 留时间）。等超了只记 WARN 并照常起轮次——**不改失败语义**，行失败的判据仍在事件流那一侧（`AGENT_MCP_UNAVAILABLE` 要厂商原文）。
2. **历史先扫一遍**：`client.subscribe` 不补投历史，而毫秒级启动的 server 可能在我们登记之前就到 `ready`。
3. **`starting` 不算落定**：把它当终态就是这条缺陷本身。
4. **app-server 在等待窗口里终止 ⇒ 立刻放行**：不白等满预算（`turn/start` 会照旧报进程已退出，回收走起手失败那条路）。
5. **没有注入就一次不等**（不订阅、不烧预算）：评分与用例同步两处不注入 MCP，不该付这笔时间。

判据：`appserver/session.test.ts` 新增 7 条守卫，**8 条变异各自见过失败**（删掉等待 ⇒ 2 红；`starting` 当终态 ⇒ 1 红；去掉历史兜底 / `failed` 不算落定 / 去掉超时兜底 / 预算取最小 / 空集也等一轮 / 进程终止不放行 ⇒ 各 1 红），`session.ts` 的 sha256 变异后复原一致。真机守卫是 `live-mcp.test.ts` 的 **C 臂**（默认跳过）：

```
AIEVAL_LIVE_MCP=1 pnpm vitest run packages/server/agents/src/providers/codex/live-mcp.test.ts
```

它让探针 server 的 `initialize` 晚 4 s 回，断言**第一条**请求的工具表里就有 `mcp__probe`（实测 `@4369ms tools=14 namespace=["multi_agent_v1","mcp__probe"]`）。

**未闭合**：上游命名空间缺口（上面那条 `unsupported call` / issue #23186）还在，所以「工具看得见」之后仍然「调不动」——这次修的是**别让它开局就断言没有**，不是让它能调。

**顺带登记（采集面，未改）**：codex 未识别通知的 **params 被丢掉**——产品日志里只有 `{"method":"warning"}`，而真机原文是 `` Model metadata for `GLM-5.3` not found. Defaulting to fallback metadata; this can degrade performance and cause issues. ``（`providers/codex/events.ts` 的 `other` 分支只带 method）。排这条故障时它正是「模型元数据缺失、能力面按 fallback 走」的旁证，值得单独开口补。

**相关资料**：[Codex wraps MCP tools in type:"namespace" for custom/local providers · #23186](https://github.com/openai/codex/issues/23186)（自定义 Responses 网关解不开命名空间，工具「看不见或调不动」且双方都不报错）、[First-turn API call blocks until pending MCP tools/list times out · #19556](https://github.com/openai/codex/issues/19556)（首轮与 MCP 启动的时序关系）。探针与读数：`packages/server/agents/probe/v10/`（`codex-mcp-inject-status.mjs` 不调模型即可验注入；`codex-mcp-tools-capture.mjs` 抓请求体；`REPORT.md` 是这次的读数）。



## `codex app-server --listen unix://<path>` 连得上、但一行 JSON-RPC 都不回

**现象**

```
$ codex app-server --listen unix:///tmp/x/app.sock      # socket 文件建出来了
已连上 unix socket                                        # net.connect 成功
（写入一行 {"jsonrpc":"2.0","id":1,"method":"initialize",…} 后，4 秒内零字节回程）
```

换成 LSP 式分帧（`Content-Length: N\r\n\r\n{…}`）再等 4 s，同样**零字节**。连接不断、不报错、不返回。

**日期**：2026-10-13

**根因**：**未定位**。`--listen` 的帮助原文只说支持 `stdio://` / `unix://` / `unix://PATH` / `ws://IP:PORT` / `off`，没说这一路要不要别的握手；`codex app-server proxy` 的自述是「Proxy stdio bytes to the running app-server control socket」——**暗示**该 socket 是**控制通道**、与 `stdio://` 的 JSON-RPC 面不是同一套（若如此，直连它就必然静默）。下一步：读 `codex app-server daemon` 的控制通道握手，或抓一条 `proxy` 的真实转发看它前面有没有前置帧。

**解决方案**：**未闭合（已绕过）**。本仓不需要它——探针要「fd 0 是真终端」时改用 pty 桥（`packages/server/agents/probe/v11/lib/pty-stdin-bridge.py`：`pty.openpty()` 给子进程 `stdin=<slave>`、stdout/stderr 仍走管道），代价是依赖 `python3` 且 `pty.openpty()` 在容器 / 受限沙箱下会 `EPERM: Operation not permitted`，故探针必须**自检**（拿哑子进程验 `os.isatty(0)`），自检不过就把那一臂标成跳过，**不静默降级**。

---

## `request_user_input is unavailable in Default mode`（模型调了提问工具，我们一条服务端请求都收不到）

**现象**

真 `codex app-server` 拉起、脚本式上游让模型去调 `request_user_input`，客户端的服务端请求列表里**零条** `item/tool/requestUserInput`；厂商自己的日志给的是：

```
ERROR codex_core::tools::router: error=request_user_input is unavailable in Default mode
```

同一份配置下模型**看得见**这件工具：`/v1/responses` 请求体的 `tools[]` 里有 `request_user_input`，系统提示逐字不变。

**日期**：2026-10-13

**根因**：这家的提问工具有**两格线程级开关**，缺任何一格，调用都会在**运行期**被厂商弹回（工具在表里、调用被拒）：

- `tools.experimental_request_user_input.enabled`（`ToolsToml` 的成员）
- `features.default_mode_request_user_input`（特性表里的那一格）

⇒ 「工具在不在表里」与「调用收不收」是两件事：拿工具表推「这家没开提问」会得到一条静默失效的通道（不报错、不下发、不进任何事件）。

**解决方案**：两格**一起**写进 `thread/start` 的线程级 `config`，且**只在本次运行挂了应答面时**开（`providers/codex/index.ts` 的 `buildCodexConfig` 收 `askUser` 这一位）——开了开关却没人答时厂商会一直等那一帧（见下一条），故这两格与应答面必须同生同灭。

判据：`providers/codex/index.test.ts` 的「提问工具开关：挂了应答面才开这两格；不挂时 `tools` / `features` 逐字不变」（读假 app-server 的 `thread/start` 台账）与同名纯函数守卫；变异（把 `askUser` 这一位钉成 `true`）⇒ 该用例见红。真机那一侧由 `providers/codex/conformance.test.ts` 的真路径场景守（厂商自己下发请求、答复进工具结果）。

---

## 提问请求到了不回帧 ⇒ 厂商**不会**自己收场（那一轮一直挂着）

**现象**

真 `codex app-server` + 脚本式上游：厂商下发了 `item/tool/requestUserInput`，我们**不回帧**。厂商侧那一条请求的 `isBlocking: false`、`autoResolutionMs: null`，而它既不投下一条通知、也不投收束通知——实测 45 s 内既没有下一轮请求、也没有 `serverRequest/resolved`，整轮就停在那里（只等用例自己的 abort 收场）。

**日期**：2026-10-13

**根因**：`autoResolutionMs` 在 0.156.1 已标 **`@deprecated`**（原文：*Use `isBlocking` to decide whether the request should block.*），实测下发值恒为 `null`；`isBlocking: false` 也不让它自己收场——它与「这一帧要不要阻塞客户端」无关，只描述这次调用的语义。⇒ **收场只能由我们给**：没有人答、等到超时、随行终止，三种都必须回一帧，否则这一轮不会结束。

**解决方案**：`providers/codex/ask-user.ts` 的应答者对**每一档收场**都回帧——`answers === null`（没人答 / 等超时 / 取消）回**空表** `{answers: {}}`，那是厂商原生的「没有答案」语义（模型据此继续按最佳判断干活）。⚠️ **由此得出一条映射边界**：spec 里「厂商到点自己收场 ⇒ 落 `auto-resolved`」在这家**不成立**——它没有「自己收场」这回事，收场方式只会是我们自己的 `timeout` / `unavailable` / `canceled`，`auto-resolved` 在这条通道上落不出来（`docs/protocols/codex.md` 与适配器交互面声明同一条口径）。

判据：`providers/codex/ask-user.test.ts` 的「没人答（`unavailable`）⇒ 回的是一帧**空答案**，不是不回帧」与「等超时与随行取消同理」（假端口，逐字比帧）；真路径那一侧是 `providers/codex/conformance.test.ts`——**变异：让应答者返回 `null`（= 不回帧）⇒ 真路径整份见红**（判据拿不到应答帧，且那一轮跑不完）。

---

## 两臂产物指纹恒红：未识别通知只留方法名、厂商通知里又带本次运行的线程 id

**现象**

真路径的两臂对比（挂应答面 / 不挂）报红，而差异全落在厂商自己的通知上：

```
{"method":"warning"}                                              ← 只在一臂里，正文才是「Under-development features enabled: …」
{"method":"serverRequest/resolved","params":{"threadId":"01a133ff-…","turnId":"…"}}   ← 两次运行线程号不同
```

**日期**：2026-10-13

**根因**：两层叠加。① 本仓对**未识别通知**的投影是**故意**只留方法名（`providers/codex/events.ts` 的 `other` 分支：静默丢弃会让「上游换了方法名」表现成「什么都没发生」）⇒ 厂商通知的进出都进指纹；② 那一条日志的 `summary` 抄的是厂商原始载荷，**里面带本次运行的 `threadId` / `turnId`**（UUID，每跑一次都不同）⇒ 同一条通知在两次运行里逐字不同。两件事都真实，合起来让「两臂逐字相同」这条判据恒红。

**解决方案**（判据侧，两处缺一不可）：

1. `providers/conformance/ask-user.ts` 的 `askSwitchNotices` 逐条点名「厂商自己投的、与提问无关的通知」并给它一档（`switch-only` = 开关带来的差异、`volatile` = 厂商按自己节奏投的）；去掉点名的那几条之后两臂指纹仍要逐字相同。`noticeArms` 交出「各臂出现过没有」，判据据此核对档写得对不对（两臂都发却记 `switch-only` ⇒ 红）。
2. 同一模块按**身份格**抹掉抄来载荷里的 `threadId` / `turnId`（`maskedIdentityInText`），只抹这两个键的值，别处每一个字节照旧参与比对。

**未闭合的代价（同一条现象的另一半）**：产品里那条日志仍然**只有方法名**——「模型元数据缺失」这类正文读不到。要采集它得让未识别通知保留原始负载（`other` 分支改成带 `params`），那是改采集面，单独开口。用工具查证时不必改产品：真路径驱动器自己收了一份厂商原文（`CodexRealPathRun.vendorNotices`），「开关那一臂厂商自报 Under-development features enabled」这条判据读的就是它。

判据：`providers/conformance/kit.test.ts` 的「厂商通知」一组（正例 + 五条反例：原始指纹相同 / 两臂都没发 / `switch-only` 两臂都发 / 归一没命中 / 归一之后仍不同）与两条指纹守卫（身份格不算行为、别处的载荷差异照旧算）。

---

## 执行日志里没有「向用户提问」卡片：codex 那一条只剩一句 `这一问的答案（收场方式：answered）：`

**现象**

同一场评测（同一用例、四家各一行，`askUser` 打开），cc / dsh / pi 三行的执行日志里都有「问题 N 个」那张卡片（题目、候选项、答案都在），**codex 那一行没有卡片**，只有一条工具结果：

```text
这一问的答案（收场方式：answered）：
- 动物单选：兔
- 植物多选：月季、杜鹃
```

`messages.jsonl` 里那一行逐条数块：`thinking / text / thinking / tool-result`——**一条 `tool-call` 都没有**（另三家那一轮都是 `thinking / text / tool-call / tool-result / tool-result`）。

**日期**：2026-10-13

**根因**：这一家的提问**不走线程条目流**。它是 server→client 的 JSON-RPC 请求 `item/tool/requestUserInput`，而厂商的条目联合 `ThreadItem`（0.156.1 共 19 个变体）**没有提问这一格** ⇒ 通知流里永远不会有它。而界面上的卡片唯一由 `tool-call` 块的 `payload.kind === 'ask-user'` 驱动（`build-model.ts` 的 `familyPayloadOf`）⇒ 账本里只有编排层写的**答复那一半**（`tool-result` + `structured: {outcome, answers}`）时，卡片没有题目可画，界面上就只剩那句答案。

⚠️ 顺带排除一个容易误判的方向：**不是 id ↔ header 映射错**。`codexAnswerFrameOf`（`providers/codex/ask-user.ts`）按题序取 `questions[i].id` 回帧、按 `header` 从答复里查那一题，真机回帧 `{"answers":{"favorite_animal":{"answers":["兔"]},"favorite_plants":{"answers":["月季、杜鹃"]}}}` 与账本里的 `[{header:'动物单选',custom:'兔'},{header:'植物多选',custom:'月季、杜鹃'}]` 逐字对得上。

**解决方案**：把提问那一半**由观察到请求的适配器补进账本**（provenance 仍是厂商侧）：

- `turn.ts` 的 `TurnContext` 新增 `emitMessage(draft)`——内容级消息的**流外投递口**，走既有合并器（消息号 / 合并键 / 块序号仍只有一处分配），另三家不涉及；
- `providers/codex/ask-user.ts` 新增 `onAskRequest`（只对交到提问端口的请求调用；子线程那一支照旧不问人、也不物化），`providers/codex/message.ts` 的 `askUserCallDraft` 把它物化成 assistant `tool-call`：`callId` 取厂商的 `itemId`、`family: 'ask-user'`、`payload` 由公共层从 `questions` 归一 ⇒ 与另三家 wire 上那条**逐字同形，展示侧一行未改**；
- 审批类请求照旧只归类、不回帧、不产消息。

判据：`providers/codex/index.test.ts` 的「提问请求 → 账本补出那条 assistant `tool-call`；审批类请求不产消息」（真机形状的两题请求：`callId` 与端口请求一致、题目与选项逐字）＋ `agent-log/build-model.test.ts` 的「codex 真机形状」（账本 → 卡片模型：题目逐字、答案按 `header` 逐题对上）＋ `agent-log/ask-user-card.test.tsx` 的「答案到达顺序与题目顺序不同也各归各题」。**变异三处各见一次红**：去掉 `onAskRequest` 那一行 ⇒ 第一条报 `expected [] to have a length of 1`；把卡片改成按下标取答案 ⇒ 第三条的顺序断言见红；把 `build-model.ts` 的配对键从 `callId` 改成题目文本 ⇒ 第二条报 `expected 'pending' to be 'settled'`。

**相关资料**：同节的《提问与应答面》（`docs/protocols/codex.md`）写着这一家的通道、选择模式与配对键口径。

---

## `thread/list` 回 `"data":[]`／`count: 0` + `containsTarget: false`（同一 `$CODEX_HOME` 下 rollout 在场、`thread/read{includeTurns:true}` 与 `thread/resume` 都正常，靠 cwd 反查 id 却永远是空表）

**现象**：同一台 `$CODEX_HOME` 里那条线程，rollout 就在盘上、`thread/read{includeTurns:true}` 读得回历史、`thread/resume{threadId}` 接得上，但**换一个进程**发 `thread/list` 拿到的是一份空表：

```json
{"data":[]}
```

同一份读数在探针里长这样（`thread/list{cwd, limit:10}`，`probe/v11/codex-session-resume.mjs` 的 `inspect` 档；`listError` 是 null——**不是报错，是回空**）：

```text
list: {count: 0, ids: [], containsTarget: false, previews: [], cwds: []}
read: {turns: 1, turnStatuses: ["completed"], turnItemsView: ["full"],
       path: "…/sessions/2026/10/14/rollout-2026-10-14T23-12-53-<threadId>.jsonl"}   nonceFoundInTurns: true
```

两行是**同刻两次请求**、同一条线程：`thread/list` 那一行回空，`thread/read` 那一行连盘上那份 `rollout-*.jsonl` 的路径都报得出来。

`state_5.sqlite` 的 `threads` 表里那一行**是在的**（`id` / `rollout_path` / `cwd` / `model_provider` 逐格对得上）。过滤器怎么换都一样——`{cwd}` / 不带 cwd / `sourceKinds:['appServer']` / `sourceKinds:['cli','vscode']` / `useStateDbOnly:true`，**五档全 0 条**。

**日期**：2026-10-14

**根因**：`thread/list` 只列**进程级配置（`$CODEX_HOME/config.toml`）里认得**的 model provider 名下的线程。本仓那条 provider（`aieval`）是**线程级**给的（`thread/start` 的 `config.model_providers`），进程级配置里没有它 ⇒ 换个进程来查，那条线程被整条筛掉。

判据是**同一台 home 只动一格自变量**：往里补一份 `config.toml` 逐字声明同一个 provider（`model_provider` + `[model_providers.aieval]` 的 `base_url` / `wire_api` / `env_key`），同一个进程、同一份 `thread/list{cwd}` 立刻从 0 条变 1 条命中，另外四档过滤器读数不变。

⚠️ 另一件**不要混进来**的事：`thread/start` 之后**一个 turn 都没跑**的线程，`threads` 表里压根没有那一行——两臂都查不到，那是「没进索引」，与上面的「进了索引但被 provider 筛掉」不是同一条。

**解决方案**：**这条登记为「兜底路不成立」，不改产品行为**——我们要落的键是 `threadId`，它取自 `thread/start` 的响应（`result.thread.id`）或同刻的 `thread/started` 通知（`params.thread.id`），**不依赖 `list`**（两格都在，见 `probe/v11/codex-session-resume.mjs` 的 `write` 档）；判据就是上面那一对真机读数（`thread/list{cwd}` 回空 vs 同刻 `thread/read{includeTurns:true}` 正常）。凡「靠 `thread/list` 反查 id」的写法都不必再试。「cwd + 最近一条」这条查找路在「provider 写在线程级 config」的形状下**不可用**（除非往行 home 里再落一份 `config.toml`，那是另一套落盘口径）⇒ 会话 id 只能**自己落盘**、续接只走 `thread/resume{threadId}`。

判据：`probe/v11/codex-thread-lookup.mjs` 的 ②（只有线程级 config）与 ③（补 `config.toml`）两臂，读数落 `probe/dumps/v11/codex-thread-lookup.json`（整个 `dumps/` 已 gitignore）。**未闭合**：筛的是哪一列（provider 名表还是别的）没到源码级，只有「补 `config.toml` ⇒ 可见」这一条真机判据。下一步就是查这一列——`ancestorThreadId` 那一支**不解释这份读数**（同一个 `{cwd, limit:10}` 请求只补一份 `config.toml` 就从 0 条变命中，自变量是 provider 名表，不是线程树）。

---

## 执行日志里整个 turn 挤成一条消息（`messages.jsonl` 里 5 条 assistant 投递全是 `"mergeKey":"main|1|assistant|-"`，`usage` 事件报 `turns=1`）

**现象**

一次「用 skill 写首诗」的运行，界面上那一轮只剩**一张卡片**，里面「思考 → 工具调用 → 思考 → 正文」挤在一起；面板顶部显示 `已渲染 1 / 共 1 轮`，而这次运行实际发生了 **2 次模型往返**（先想 + 调工具，再想 + 答复）。

落盘逐条数：`messages.jsonl` 里 7 条投递只有两个合并键，其中 5 条是同一个：

```text
run-codex:16 | mk: main|1|assistant|- | rt: 1 | vid: rs_23452b0748824e1db984a3ccc73337b9  (reasoning)
run-codex:17 | mk: main|1|assistant|- | rt: 1 | vid: call_34490b509fdb4e7495168d86        (commandExecution)
run-codex:19 | mk: main|1|assistant|- | rt: 1 | vid: call_34490b509fdb4e7495168d86        (commandExecution)
run-codex:64 | mk: main|1|assistant|- | rt: 1 | vid: rs_b959754e5ed84827ad41bf7eb79d8e3d  (reasoning)
run-codex:85 | mk: main|1|assistant|- | rt: 1 | vid: msg_b959754e5ed84827ad41bf7eb79d8e3d (agentMessage)
```

`events.jsonl` 的 `usage` 事件同样报 `{"turns":1}`（真实是 2）。客户端按设计「同 `mergeKey` 覆盖留最后一条」（`build-model.ts` 的折叠），于是那 5 条被折叠成一条。

**日期**：2026-10-15

**根因**：`roundTrip` 的号源与契约语义不符。契约（`docs/protocols/message-spec.md`）里它是**模型往返序号**，而 `run-state.ts` 的 `countRoundTrips` 只在 `item.kind === 'agentMessage'` 时按条目 id 去重开号 —— 数的是「答复条目」而不是「往返」。codex 的结构是**一个 turn 里跑多次往返，只有收尾那次发 `agentMessage`**：中间那些「想 + 调工具」的往返只有 `reasoning` 与工具条目，一条答复都没有。于是整个 turn 期间号恒为 0，所有条目取号时都落到 `Math.max(0, 1) = 1`。

合并键是 `subagentId|roundTrip|role|parentCallId`（`carrierKeyOf`），codex 的消息 `parentCallId` 恒 `null`、主会话 `subagentId` 恒 `null` ⇒ **只有 `roundTrip` 能区分同角色的消息**。号不前进，同角色的全部消息就是同一个载体，合并器按设计把块累积进它（块序号靠 `blockIndexFor` 区分，所以内容没丢，只是**都挤在一条里**）。

同一把尺子还管着轮次统计（`observedTurns` / `subagentTurns`），所以 `turns` 也被系统性低估。

**解决方案**：号源改成**厂商的响应身份**（`run-state.ts` 的 `countRoundTrips`）：

- **主判据 = id 后缀**。模型产出条目（`reasoning` / `agentMessage`）的 id 后缀就是厂商的响应 id，**同一次响应的推理与答复共享它**（`rs_<响应 id>` / `msg_<响应 id>`）——真机三种 id 格式（`rs_<hex32>`、`rs_<uuid>`、`rs_<时刻+随机>`）与 34 个响应组逐组核对过，同后缀里从不出现两个同类条目。取「第一个 `_` 之后的全部」，一次响应恰好开一个号。
- **两条兜底**：`item.id` 里没有分隔符时退回结构判据（上一次产出之后跑过工具才算新的一次往返）；工具条目在一次产出都没见过时**补记一票**（工具执行蕴含它前面必有一次往返，真机形状：turn 的第一条通知就是命令执行）。
- 增量（`agentMessageDelta` / `reasoningTextDelta`）也过这把尺子（`noteDeltaRoundTrip`）：`item/started` 与增量谁先到不由本层定；载荷的 `itemId` 与条目 id 逐字相同（抓包逐帧核对：`item/agentMessage/delta` 的 `itemId` 就是 `item/completed` 的 `item.id`）。
- 收尾回读（`projectThreadMessages`）**自带开号**：那条路上一条运行期通知都没走过，号必须在那里补。
- **内容级归一不再依赖行级投影先跑**（`projectCodexMessages` 自己也数一遍，幂等）：合并键不该取决于另一层的执行顺序——这正是本缺陷的土壤。

判据：`providers/codex/message.test.ts` 的「往返号源：一次模型往返一条消息」五条（真机形状：想→调工具→想→答复、同响应共享号、提问那一轮、工具打头、增量先到）＋「收尾回读的一批条目自带开号」＋`providers/codex/events.test.ts` 的「推理条目推进往返」与「turn 的第一条通知就是工具执行」。

**变异验证**（两处，各见一次红，之后逐字还原并核对 sha256）：
- 号源退回「只数 `agentMessage` + 身份取整串 + 取消工具补票」⇒ 真机形状那条报 `expected ['main|1|assistant|-', …(1)] to deeply equal […(2)]`（收到 2 个键、正是上报症状）；
- 身份取整串（不做后缀归一）⇒「同一次往返的推理与答复共享一个号」见红。

真机复核：修复后同一用例重跑，`messages.jsonl` 里 `msg`/`rs` 同后缀的两次往返分成 `main|1|…` / `main|2|…`，界面显示 `已渲染 2 / 共 2 轮`，工具调用归它自己那次往返（`轮次 1`）。

**已知边界**：id 里没有 `_` 分隔符时只剩结构判据，此时「答复之后直接下一次往返、中间没有工具条目」的那一轮（提问应答）会并号——真机三种格式都有分隔符，这一档未在真机出现。

---

## 界面显示人工消息「已送达」，但模型从头到尾没看到那句话（`'idle'` 档只 `thread/queue/add`、不起轮）

**日期**：2026-10-16

**现象**：`run.injectMessages` 开启的那一行，人在运行中发一条「顺便把 changelog 也补上」并选择排队。界面与账本三处一致地说它已送达：

- `inject-message` 事件落 `outcome: 'delivered'`；
- 消息账本多一条 `role: 'user'` / `origin: 'human'` 的记录；
- 行快照的 `followUps` 计数 +1。

而模型那一侧的上下文里**一个字都没有**——后续答复完全不提这件事，`events.jsonl` 里也找不到任何异常。

**根因**（机制层）：厂商的自动投递**不是**只挂在「一轮收场那一刻」。真机读数（`arms/arm-queue-race.mjs` 三臂一致）：
条目录在一个**空闲**线程上时，厂商在 `thread/queue/add` 那一刻就自己把它撒成了新一轮——通知序列是
`thread/queue/changed`（入队）→ `thread/queue/changed`（被消费）→ `thread/status/changed(active)` → `turn/started`，
而紧接着的 `thread/queue/start` 拿到 `-32600 queue is empty`。上游源码里这也是主路径之一
（`ext/queue/src/service.rs` 的 `enqueue → wake_if_loaded → dispatch_if_idle`；PR #38456 原文：
*"Automatically dispatch queued submissions in FIFO order after completed or failed turns, while leaving the queue paused after interruption."*）。

⇒ 这一条的**两条历史结论都要改**：
① 「只 add 不 start 会一直躺在队列里没人消费」——真机不成立（厂商自己会投）；
② 真正会坏事的是**反向**：把 `queue is empty` 当成「起轮失败」⇒ 不登记交付、当场收场、`dispose` 杀掉厂商刚起的那一轮（真机复现：`turn/started` 2 条 / `turn/completed` 1 条、哨兵 0 次进请求体）。

**解决方案**（`providers/codex/turn-injection.ts` 的 `deliverIdle` + `index.ts` 的收场接线）：
交付判据从「我们起轮成功」改成「**这一轮真的跑起来了**」，两档按**条目还在不在可见队列里**分：

1. `thread/queue/add{clientUserMessageId}` 登记（拿到提交 id，保住按身份撤）；
2. `thread/queue/start` 起轮：成功 ⇒ 交付登记 + 流继续消费那一轮（原路）；
3. `queue/start` 失败时**读一次 `thread/queue/list`**：
   - 条目**不在**表里 ⇒ 厂商已消费 ⇒ **按交付登记**，并让流继续消费厂商起的那一轮
     （`vendorDispatched`；在途轮号由 `turn/started` 补——中止请求要的正是它）。收场那一拍**不结算**，
     那一轮真收场时它的结局替换掉暂存的，于是这一行的结论取最后一轮；等不到 `turn/started` 时按
     `CODEX_VENDOR_TURN_WAIT`（5 s）有界收场；
   - 条目**还在**表里 ⇒ 见下一条：**没被消费 ≠ 失败**（厂商会在当前轮收场后自己把它撒出去），
     一次交多条时尤其不能整批处置。

判据：`providers/codex/turn-injection.test.ts` 的两条（消费 ⇒ 交付 + `vendorDispatched`；还在 ⇒ 不交付 + 回滚）
+ **真机守卫** `providers/codex/turn-injection-delivery.test.ts`（驱动器 `testing/codex-injection-fixture.ts`：
真二进制 + 脚本式上游，四条判据＝登记交付 / 哨兵进**出站请求体** / 那一轮跑完 / 答复成为 `finalText`；
阴性对照不挂注入面 ⇒ 哨兵 0 次）。**变异验证**：让「消费」那一档恒回空 ⇒ 见红；还原后 sha256 一致。

**未闭合**：无（这一格已按真路径证据升为 `yes` + `real-path`，见 `docs/protocols/codex.md` 的《注入与续接》）。

---

## 中文正文里凭空出现 `\uFFFD`（`中���内容ok`）：命令输出与答复正文**静默**损坏

**日期**：2026-10-16

**现象**：单条通知超过管道一次读上限（64 KB）时，正文里的多字节字符被切成替换字符。同一帧在夹具里完好、真机上偶发；`JSON.parse` **照样成功**、坏帧计数不增、日志不响 —— 表现是「上游改了什么」还是「我们读错了」完全分不出来。

纯 Node 复现（把一帧按字节切成两半，切点落在汉字中间）：

```
原文   : "中文内容ok"
naive  : "中���内容ok"   ← chunk.toString()
setEnc : "中文内容ok"    ← setEncoding('utf8')
```

**根因**：`appserver/client.ts` 的 stdout 读侧写的是 `buffer += chunk.toString()`，而 `spawn` 用的是 `stdio: ['pipe','pipe','pipe']`——**没有 `setEncoding('utf8')`，也没有 `StringDecoder`**。管道单次读上限 64 KB，而一个汉字 3 字节完全可能跨两个 chunk；`Buffer#toString()` 对半个字符产出 `\uFFFD`，而坏字落在 JSON 字符串**内部**时 `JSON.parse` 依然成功。

为什么守卫没拦住：假子进程的 `emitRaw(text: string)` 投的是**字符串**，分包用例只能覆盖「半行」，覆盖不到「半个字符」——**测试环境不是运行环境**。

**解决方案**：读侧 `child.stdout.setEncoding('utf8')`（交给 Node 的 `StringDecoder`，它跨 chunk 保留不完整字节），`stderr` 同样；并把这两格提成 `AppServerChild` 接口的**必填成员**，让类型系统挡住下一个实现者。

判据：`appserver/client.test.ts` 的「跨 chunk 的多字节字符不被切坏」——那条用例**不用假件模拟**，而是拿真实 `PassThrough` 当 stdout（`setEncoding` 在它上面的行为就是生产行为），按字节切帧后断言正文逐字相同；「读侧与错误侧都接上了」按 `setEncoding` 的**设值**与 stdin `error` 监听者的**个数**立判据（空表遍历同样不抛，拿 `not.toThrow()` 立判据等于没立）。**变异验证**：去掉 `stdout.setEncoding` ⇒ 2 条见红；还原后 sha256 一致。

---

## `Error: write EPIPE` 打崩 Web 服务进程：往已死的 app-server 写一帧

**日期**：2026-10-16

**现象**：提问在等人回答期间用户点了「终止」，或那一行被看门狗收掉 —— 随后宿主进程（Next 服务）直接消失，日志里顶多留一句 `Error: write EPIPE`，没有业务上下文。

**根因**：`client.ts` 有**两处**裸写 stdin（回帧、发请求），而全仓没有任何 `child.stdin.on('error', …)`。`child.stdin` 是 Socket，对端已死之后写入会异步 emit `EPIPE` / `ERR_STREAM_DESTROYED`；而 `ChildProcess.on('error')` **不接管 stdin 流上的错误** —— 没有监听者的 `'error'` 事件在 Node 里就是未捕获异常，直接带走宿主。

触发路径是常态而非边角：`port.ask` 有自己的等待预算，取消路径上 `dispose → close → kill` 必然先完成，答案回来时那根管子已经没了。

**解决方案**：三处一起做，缺一个就换一种崩法——

1. `child.stdin.on('error', …)` 挂一个只记日志的监听（**不** `rejectAll`：进程真的退出有 `close` 那条通路，一次写失败不该替它宣布死亡）；
2. 写帧收成**唯一出口** `writeFrame`：已终态就不写（返回 `false`）、同步抛也吞掉（回帧那一侧是 fire-and-forget，抛出去就是未捕获 rejection）；
3. 发请求那一侧拿到 `false` 立刻结算那条 promise（不白等 30 秒的超时）。

判据：`client.test.ts` 的「读侧与错误侧都接上了」（按监听者个数）、「写帧失败（对端已死）⇒ 该请求立刻拒绝，不白等一个超时」。**变异验证**：去掉 stdin 监听 ⇒ 1 条见红；去掉立即结算 ⇒ 1 条见红。

---

## 子线程的正文出现两份、且顺序颠倒（第 1 轮的内容排在第 2 轮之后）

**日期**：2026-10-16

**现象**：上游把子线程的 `item/*` 推给了本连接、收尾又 `thread/read` 全量回读一遍时，同一个载体的条目落进**两个不同的合并键**，按 `mergeKey` 折叠**去不掉**：

```
thread-child|1|assistant|-  roundTrip 1  ["子答复甲"]
thread-child|2|assistant|-  roundTrip 2  ["子答复乙", "子答复甲"]   ← 甲重复，且排在乙之后
```

**根因**：载体键里的轮次号按「该线程**此刻**累计几轮」现算（`roundTripsOf`）。运行期是逐条推进的，当下值恰好等于本条自己的号；而收尾那一批条目的号**已经数过**（`countRoundTrips` 按身份去重、不再推进）⇒ 整批都读到**最终号**。键不同 ⇒ 合并器各占一条逻辑消息（内容重复），且补齐的那份按到达顺序追加在最后一轮之后（块序颠倒）。

按 `mergeKey` 折叠是消费方唯一的去重手段（`build-model.ts` / `row-messages.ts` 同口径「留最后一条」），而这里被打破的正是键本身。

**解决方案**：把「这条条目属于哪一次往返」变成**一经登记不再变的事实**——`run-state.ts` 新增 `itemRoundTrip` 台账与 `roundTripForItem(state, threadId, itemId)`，`message.ts` 的 `draft()` 用它取号（第一次问就钉住）。调用方必须先计入本条再取号（顺序反了会钉在上一轮）。号源仍是同一把尺子 ⇒ 运行期与收尾两条入口拿到的号逐字相同，合并器折得拢。

判据：`index.test.ts` 的「混合通道：子线程条目既走运行期通知、又被收尾回读 ⇒ 每条正文只出一份，且各归自己那一轮」（按载体键折叠后数正文出现次数 + 断言各归各轮）。**变异验证**：取号改回「线程当前累计」⇒ 该条见红（`expected 2 to be 1`）；还原后 sha256 一致。

**已知边界**：收尾那一批条目里**从未在运行期出现过**的那些（上游不推子线程条目的常规情形）本来就没有号，由收尾自己按身份补齐——那条路不受本缺陷影响（既有用例「收尾回读的一批条目自带开号」覆盖）。

---

## `turn/started` 两条、`turn/completed` 一条，而这一行按 `ok: true` 落盘（`finalText` / `tokens` / `turns` 全空）

**日期**：2026-10-17

**现象**：app-server 进程死在**在途**（Rust panic / OOM / 被外部杀掉）时，界面上这一行是**跑完了**：

```
result: { ok: true, exitReason: 'completed', error: null, finalText: null, tokens: null, turns: null }
事件流里唯一相关的一条: [WARN] codex 子线程树不是全量（枚举失败）：…（stderr）
服务端日志: [ERROR] [agents/codex] codex 子线程枚举失败（本行的子智能体分量按「未采集」处理）
            error: Error: codex app-server 进程已退出（code=null）
```

**根因**：进程终态那一拍确实算了失败——`appserver/session.ts` 的 `client.onTerminal` 把 `core.end({status:'failed'})` 落定，
但 `session.outcome` **没有任何消费方**：`providers/codex/index.ts` 交出的 `TurnStart` 只接
`stream` / `interrupt` / `dispose` / `finalize` / `project`。而失败归因只有流内投影一条路
（`turn/completed.status === 'failed'`），进程死亡**不产生任何通知**（`core.end` 只结算 outcome、不产载荷）
⇒ 流正常产完、`consume` 正常返回、`failure` 保持 `null`，落 `ok: true`。消费方按 `ok` / `exitReason` 判失败
（`orchestrator.ts`），于是崩溃的行不进重试、不留失败徽标；评分通路只能退化成
`JUDGE_PARSE_FAILED：评分智能体没有给出可读的最终答复（该适配器未回传最终消息）`——归因指向我们而不是厂商进程死了。

真机读数（`providers/codex/death-live.test.ts`，两臂只差「杀不杀」）：对照臂 `ok: true` / 被测臂**同样** `ok: true`，
`upstreamRequests` 两臂都是 1（都在 `turn/start` 受理之后）。

**解决方案**：给流加一个**收尾问一次**的出口（`index.ts` 的 `asRawStream` 新增 `onStreamEnd`）：
上游正常产完那一刻问一次 `session.outcome`，`status === 'failed'` 且这一轮没被取消、流内也没折过失败时，
合成一条载荷 `{kind: 'sessionFailed', error}` 交给同一个投影出口（`events.ts` 折 error 事件 + `failure`），
骨架据此落 `ok: false / exitReason: 'error'`，原因就是厂商那句「进程已退出」。
三条排除写在同一处：已取消（结论归 canceled 那条通路）、不是 failed（正常收场）、流内已折过失败（`turn/completed{failed}`，别落两条）。

判据：`providers/codex/death-live.test.ts`（真二进制 + 上游挂着 + 从探针侧 `SIGKILL`；对照臂不杀 ⇒ 成功）。
**变异验证**：把 `onStreamEnd` 改成恒回 `null` ⇒ 该条见红（`expected true to be false`）；还原后 sha256 一致。

---

## `no active turn to interrupt`（续跑之后点「终止」：取消退化成杀进程树）

**日期**：2026-10-17

**现象**：`'idle'` 档送过一次人话（厂商因此起过新一轮）之后再点「终止」或看门狗开火，日志里出现

```
[WARN] [agents/codex] codex 中止请求失败（该行仍会按终止收场）
  error: Error: app-server 返回错误（-32600）：no active turn to interrupt
```

那一轮不会被优雅中止：`releaseTurn` 白等 5 秒宽限期，然后 `dispose` **杀掉整棵进程树**；
`cancelMidTurn: true` 与「interrupt 是协议能力、不 kill 进程」在这条路上不成立。

**根因**：厂商按「**当前在途轮**」校验 `turn/interrupt`（真机裸臂：拿一个已收场的 turn id 与一个伪造的 uuid 去发，
回的是同一条 `-32600 no active turn to interrupt`；上游 `turn_processor.rs` 的同名分支就是这条文案），
而适配器建会话时只拿得到**首轮** id——`appserver/session.ts` 的 `interrupt` 闭包捕获的就是它，
`continueWith(_turnId)` 又把新轮号丢掉了。人话续跑起的那一轮（我们起的、或厂商自己投递起的）只有**流那一侧**知道。

**解决方案**：在途轮号收归**流那一侧**维护（`index.ts` 的 `activeTurnId`，`turn/started` 进流时更新，
起轮成功那一支直接赋值），`CodexSession.interrupt(turnId)` 改成收调用方给的轮号；
`null`（轮与轮之间）**不发这一帧**——发一个已收场的 id 必被拒，只会白留一条 WARN。

判据：`appserver/session.test.ts` 两条（带调用方给的轮号 / 无在途轮不发）+ `injection.test.ts` 的
「起轮回 `queue is empty` 但条目已被消费 ⇒ 登记交付，且中止带的是厂商起的那一轮」。
**变异验证**：把 `interrupt` 的参数改回 `session.turnId` ⇒ 见红；还原后 sha256 一致。

---


**同一个「带错轮号」还有另外两种形状**（真机逐格读数，同一台 0.163.0；这一格值得单独记住，因为
三种下场的**代价**差得远，按一种写文档会误导下一个人）：

| 形状 | 厂商回什么 | 代价 |
|---|---|---|
| **自然收场**的轮（`turn/completed` 已到） | `-32600 no active turn to interrupt` | 1 ms，立刻知道 |
| **被我们中断过**的轮，再发一次同一个 id | **一帧都不回** | 客户端的请求超时白等（默认 30 s） |
| 空闲线程 + 伪造 / 陈旧的 id | `-32600 expected active turn id X but found Y`（把**当前在途轮号**写在原文里） | 1 ms，而且能自愈 |

⇒ 适配器那两条保护都是必需的：**没在途轮就不发**（`session.interrupt(null)`），以及**一轮只发一次**
（骨架的 `triggerRelease` 记忆化 ⇒ 第二种形状在本仓不可达）。判据：真机裸臂
四种形状一次跑齐（自然收场后 / 在途发一次再补发 / 在途 / 空闲线程 + 伪造 id）。


**同一个「带错轮号」还有另外两种形状**（真机四种形状逐格读数，同一台 0.163.0）。这一格值得单独记住：
三种下场的**代价**差得远，只按一种写文档会误导下一个人。

| 形状 | 厂商回什么 | 代价 |
|---|---|---|
| **自然收场**的轮（`turn/completed` 已到） | `-32600 no active turn to interrupt` | 1 ms，立刻知道 |
| **被我们中断过**的轮，再发一次同一个 id | **一帧都不回** | 客户端的请求超时白等（默认 30 s） |
| 空闲线程 + 伪造 / 陈旧的 id | `-32600 expected active turn id X but found Y`（把**当前在途轮号**写在原文里） | 1 ms，而且能自愈 |

⇒ 适配器那两条保护都是必需的：**没在途轮就不发**（`session.interrupt(null)`），
以及**一轮只发一次**（骨架的 `triggerRelease` 记忆化 ⇒ 第二种形状在本仓不可达）。

## 子任务行的状态与结论被打回 `unknown` / `null`（`closeAgent` 的 `item/started` 排在收场之后）

**日期**：2026-10-17

**现象**：一次真模型运行里，同一条子任务的投递序列（`live/live-gateway-subagent.json`）是

```
running → unknown/unverified(outcome=null) → completed(outcome="0")
        → unknown/unverified(outcome=null)   ← ★ 这一帧在 completed 之后
        → completed(outcome="0")
```

界面上子任务行的「结果摘要」会短暂（或永久，若最后一拍恰是 started）消失、状态掉回「未知 / 未验证」。

**根因**：`wait` / `closeAgent` 的 `item/started` 带的是 `agentsStates: {}`（真机原文），
而 `message.ts` 的 `projectCollab` **不看 `started`**、对每个 receiver 都产一条记录，
`agentsStates` 为空时 `collabStatusOf(null)` 归成 `unknown` + `unverified`、`outcome` 写 `null`；
子任务行的折叠是**整条覆盖**（`core/message-log.ts` 的 `latest.set`）⇒ 那一帧把已经采到的
`completed` 与结论一起抹掉。本仓一致性套件的 `PRESERVED_SUBAGENT_FIELDS` 明写「覆盖不许丢事实」，
但 codex 的子智能体夹具里没有 `wait` / `closeAgent`（真机每个模型都会调）⇒ 罩不到。

**解决方案**：两处一起收：① `item/started` 的协作帧**这一帧对这条子线程什么也没说时不产记录**
（判据：`agentsStates` 有没有这条子线程的状态格——将来某一版在 started 就带状态时照旧出记录）；
② 子任务行新增 `subagentFacts` 台账（`run-state.ts`），`kind` / `outcome` / `parentCallId` / `parentSubagentId`
**非 `null` 才覆盖**，产记录前先合并——「不许丢事实」这件事只能在产记录之前做，交给消费方已经太晚。

判据：`message.test.ts` 两条（started 不产记录 + 活动条目不抹结论；真机序列回放）+
真机读数 `probes/live-gateway-subagent.test.ts` 的「事实不许回退」断言（按投递顺序查 outcome 被抹与终态被打回）。
**变异验证**：把合并改回「后到覆盖」⇒ 见红；还原后 sha256 一致。

---

## `thread/queue/list requires experimentalApi capability`（投递与子线程枚举一起静默失效）

**日期**：2026-10-17

**现象**：拿掉 `initialize` 的 `capabilities.experimentalApi` 之后，同一份剧本下：

```
thread/queue/list  → -32600 thread/queue/list requires experimentalApi capability
thread/queue/add   → -32600 thread/queue/add requires experimentalApi capability
thread/queue/start → -32600 thread/queue/start requires experimentalApi capability
thread/list{ancestorThreadId} → -32600 thread/list.ancestorThreadId requires experimentalApi capability
```

**根因**：`thread/queue/*` 六个方法逐条带 `#[experimental("…")]` 标注（上游 `common.rs`），
`thread/list` 的 `ancestorThreadId` 是**字段级**标注，检查点只有一处（`message_processor.rs`），
`reason` 就是报错前缀。拿掉能力位之后：`'idle'` 档投递走 `retractorFor` 的 catch 只记一条 WARN、
收尾枚举失败变成一条「子线程树不是全量」的 WARN——两处都**不响亮**。

**解决方案**：`appserver/client.ts` 的 `initialize` 始终声明 `experimentalApi: true`（新增落点时也照此），
并把 `turnInjection.delivery.idle` 那一格的 `experimental` 声明改成 `true`（原来写 `false`，与真机相反）；
`docs/protocols/codex.md` 的措辞同批改正。判据：`turn-injection-resume.test.ts` 的声明互钉用例
（`idle.experimental === true`）+ 修改声明即红。

---

## `tools.web_search: false` 关不掉内置联网工具（模型一直带着 `type: "web_search"`）

**日期**：2026-10-17

**现象**：线程级 config 里给了 `tools: { web_search: false }`，而出站 `/v1/responses` 请求体的工具表**逐字不变**——
`type: "web_search"` 那一项一直在：

```
A 基线（不给开关）              tools[]: … update_goal, web_search:
B 适配器现状 tools.web_search=false  tools[]: 与 A **逐字相同**
C 顶层 web_search="disabled"        tools[]: 与 A 相同但 **web_search 消失**
D tools.update_plan.enabled=true    tools[]: A + function:update_plan
```

**根因**：`tools.web_search` 是 web search 的**参数容器**（filters / user_location / context size），不决定开关；
真正的开关是**顶层** `web_search`（`WebSearchMode`），默认值 `Cached`（= 会带上这件 hosted 工具）。
适配器把「参数容器」当成了开关 ⇒ 一行意图为「关掉联网」的配置**空转**，而且不报错。

**解决方案**：`buildCodexConfig` 改成顶层 `web_search: 'disabled'`（常量 `CODEX_WEB_SEARCH_OFF` 一处定义），
`tools` 里只留 `update_plan` 与提问那两格开关；`docs/protocols/codex.md` 的注入落点同批改正。
判据：`index.test.ts` 的配置形状三条 + 真机守卫 `turn-injection-delivery.test.ts` 的
「出站请求体的工具表里没有 `web_search`、有 `update_plan`」。**变异验证**：改回 `tools.web_search: false` ⇒ 4 条见红；还原后 sha256 一致。

---

## `Full-history hydration is deprecated for paginated threads`（收尾取数走了已弃用的全量水合）

**日期**：2026-10-17

**现象**：真机上每次收尾（有子线程时）都会收到厂商的弃用通知：

```
{"method":"deprecationNotice","params":{"summary":"Full-history hydration is deprecated for paginated threads;
 omit `includeTurns` or set it to `false`, then page with `thread/turns/list` and `thread/items/list`.","details":null}}
```

而本行的线程对象上写着 `"historyMode":"paginated"`。

**根因**：`appserver/reader.ts` 的收尾取数用 `thread/read{includeTurns:true}` 做全量水合，
而 paginated 线程上这条路已被厂商弃用（上游 `thread_processor.rs` 的两条 `PAGINATED_*_DEPRECATION_SUMMARY` 就是这条文案）。
功能没坏，所以不报错；弃用信号落在未识别通知里（归 `other` 并保留原文——归得对，但没有人读它）。

**解决方案**：收尾改成**两步取数**：`thread/read{threadId}`（**不带** `includeTurns`，只取元数据）
+ `thread/turns/list{threadId}` 分页取轮次（真机读数：每一项带 `status` / `startedAt` / `completedAt` /
`durationMs` / `itemsView` / `items`）。条目仍按 `itemsView` 判全量：轮次那一份未必是全量
（真机实测该接口回的常是 `summary`）⇒ 不信它，改走文档化的全量来源 `thread/items/list`。

判据：`appserver/reader.test.ts` 五条（两步取数且**不带** `includeTurns` / 轮次分页 / 非 full 回退 / 未知 `itemsView` / 空轮次）+
真机读数 `probes/live-gateway-subagent.test.ts` 的「不许再出现 `deprecationNotice`」断言。
**变异验证**：把 `thread/read` 改回带 `includeTurns: true` ⇒ 见红；还原后 sha256 一致。


---

## 模型看了一张图（`view_image`），而执行日志里什么都不显示：厂商投了 `item/completed{type:"imageView"}`，账本与事件流零命中

**日期**：2026-10-17

**现象**：模型调用 `view_image`（这件工具**就在本行的工具表里**）之后，
厂商连投两帧、条目的 `type` 是 `imageView`：

```
{"method":"item/started",  "params":{"item":{"type":"imageView","id":"call_img_0"},"threadId":"…","turnId":"…","startedAtMs":…}}
{"method":"item/completed","params":{"item":{"type":"imageView","id":"call_img_0"},"threadId":"…","turnId":"…","completedAtMs":…}}
```

而同一次运行里，本行的消息账本与事件流对它的命中数是 **0**——界面上既没有工具调用行、
也没有结果行、也没有「这里有一条我们没看懂的东西」。对照：同一轮里 `exec_command` 产出的
`commandExecution` 条目照旧成块（工具调用 + 结果两条），证明不是「这一整套投影本来就不产东西」。

**根因**：**未识别的「条目类型」没有兜底出口**。一条链上三个分支叠出来的：
① `appserver/protocol.ts` 的 `readItem` 只归一 `ThreadItem` 19 个变体里的 12 个，剩下 7 个
（`hookPrompt` / `imageView` / `sleep` / `imageGeneration` / `enteredReviewMode` /
`exitedReviewMode` / `contextCompaction`）落进兜底 `{kind:'other'}`；
② `message.ts` 的 `projectItem` 与 `events.ts` 的 `activityDrafts` **都没有 `other` 分支**，
一路落到「什么都不产」；③ `run-state.ts` 的 `roundTripRoleOf('other')` 是「透明」⇒ 连轮次计数都不留痕。
未识别的**方法**有 `unknownEventDraft` 兜底，未识别的**类型**此前没有对应物——这个不对称就是缺陷本身。
⚠️ 改之前 `message.ts` 的兜底注释写着「它们也不是『丢弃』：条目原文仍在同一份通知的 `raw` 里」——
**那句话是假的**：`raw` 的唯一载体就是产出的那条消息的 `raw` 字段，不产消息就没有载体（真机读数正面否证）。

**解决方案**：`readItem` 的 `other` 支带上条目原文（`raw`），`projectItem` 对 `kind:'other'` 产一条
**`unrecognized` 块**（契约的 `UnrecognizedPayloadBlockSchema` 是一等成员，界面有独立渲染路径），
只在 `item/completed` 产（与 `fileChange` / `agentMessage` 同口径）。新增共享构造器
`unrecognizedBlockDraft`（`packages/server/agents/src/message.ts`）。
判据：真机守卫 `packages/server/agents/src/providers/codex/unrecognized-item-live.test.ts`
（真二进制 + 脚本式上游让模型调 `view_image`；断言「厂商必须真投过 `imageView`」+「对照臂
`exec_command` 成块」+「`unrecognized` 块的 `vendorType` 是 `imageView`、`raw` 里带那个路径」）+
单测 `message.test.ts` 两条 / `protocol.test.ts` 一条。
**变异验证**：把 `projectItem` 的 `other` 支改回「什么都不产」⇒ 2 条见红（真机臂 + 单测），
其余 44 条照绿；还原后 sha256 一致。

---

## 文件改动清单的 `kind` 恒为 `null`（补丁的新增/删除/改写分不出来）

**日期**：2026-10-17

**现象**：`fileChange` 条目里厂商给的是**带标签的对象**：

```
{"item":{"type":"fileChange","id":"call_u2","status":"inProgress",
         "changes":[{"path":"…/arm-u2.txt","kind":{"type":"add"},"diff":"hello\n"}]},…}
```

而账本上那条 `apply_patch` 调用块的入参只剩路径：`{"changes":[{"path":"…/arm-u2.txt","kind":null}]}`。

**根因**：`readItem` 用 `readString(one, 'kind')` 读这一格，而 `readString` 只接受**字符串**——
厂商的 `FileUpdateChange.kind` 是 `PatchChangeKind`（生成物 `required = ['diff','kind','path']`，
`kind` 是 `{"type":"add"|"delete"|"update"}` 的**内部标签枚举**，`update` 还带 `move_path`）
⇒ 每次都读出 `null`。既有的单测把**归一之后的条目**喂给投影（`changes: [{path, kind: 'update'}]`），
根本不经过 `readItem`，所以「读错形状」这件事在单测里完全隐形。

**解决方案**：改成读标签本身——`kind: readString(asRecord(one.kind), 'type')`。
判据：真机守卫 `packages/server/agents/src/providers/codex/file-change-live.test.ts`
（真二进制 + 脚本式上游发一帧 `custom_tool_call`（`apply_patch` 的入参是 lark 补丁文本，走
`custom_tool_call` 而不是 `function_call`），厂商自己执行并投 `fileChange`；断言账本里那条
`apply_patch` 的 `changes[0].kind === 'add'`）。⚠️ 这一臂的模型名要用 codex 认得的那个
（未知模型名下厂商不会挂 `apply_patch`，条目根本不出现 ⇒ 假红）。
**变异验证**：把这一格改回 `readString(one, 'kind')` ⇒ 见红（`expected null to be 'add'`）；
还原后 sha256 一致。
**未闭合**：`diff`（补丁正文）与 `kind.move_path` 仍未采集——那是**扩展采集面**，要动契约的
`changes` 形状与界面，单独开口。

---

## 多轮子线程的状态与结论交回的是**第一轮**（`thread/turns/list` 默认降序）

**日期**：2026-10-17

**现象**：真机同一条子线程上跑两轮，子任务行上的 `outcome` 交回的是**第一轮**的答复
（`CHILD_ANSWER_TURN1`），而最后跑完的是第二轮（`CHILD_ANSWER_TURN2`）。

**根因**：`thread/turns/list` 的 `sortDirection` 是**可选格**，厂商生成物的原文是
*"Optional turn pagination direction; defaults to descending."* —— 不传就是**最新一轮在前**。
真机两种姿势各读一次，同一条线程：

```
不传（适配器现状） ⇒ ["turn#2","turn#1"]   at(-1) = TURN_ANSWER_0   ← 第一轮
asc               ⇒ ["turn#1","turn#2"]   at(-1) = TURN_ANSWER_1   ← 第二轮
```

而 `message.ts` 的 `terminalStatusOf` / `outcomeOf` / `lastAgentText` 一律按 `turns.at(-1)` 读
「最后一轮」⇒ 多轮子线程的**终态、失败原因、结论正文**三格全部取自第一轮。

**解决方案**：`appserver/reader.ts` 的 `listThreadTurns` 显式传 `sortDirection: 'asc'`。
判据：真机守卫 `packages/server/agents/src/providers/codex/appserver/turns-order-live.test.ts`
（真二进制 + 脚本式上游，同一条线程跑两轮，走**适配器自己的取数面** `readThreadContent`；
断言轮次顺序等于发起顺序、且 `turns.at(-1)` 的答复是第二轮那一句）。
**变异验证**：删掉那一格 ⇒ 见红（`轮次必须由旧到新`）；还原后 sha256 一致。

---

## 一批人话只投出第 1 条（`deliveredIds` 只有第一条，第 2 条的哨兵 **0** 次进出站请求体，默认日志一条 WARN 都不打）

**日期**：2026-10-17

**现象**：一次 `drain('idle')` 交出**两条**人话时（端口的 `selectForDrain('idle')` 返回**全部**可取条目，
所以这是合法形状），真机读数三条臂全同：

```
deliveredIds        = ['…msg-1']                 ← 第 2 条没登记交付
sentinel2InOutbound = 0                          ← 第 2 条那句话从没进过厂商出站请求体
turnStarted = 2 = turnCompleted                  ← 只跑了首轮 + 厂商投递起的那一轮
finalText           = 「…收到第 1 条。」          ← 结论取第 1 条那一轮
queueOpsOnWire      = [add, add, start, list]     ← 没有 delete（没回滚），也没有第二次投递
```

**根因**（机制层）：条目录在**空闲**线程上时，厂商在 `thread/queue/add` 那一刻就把**第 1 条**撒成了
新一轮 ⇒ 第 2 条 add 撞在忙线程上只入队，紧接着的 `thread/queue/start` 回
`-32600 thread already has an active or pending turn`。而 `deliverIdle` 把这一批当**整体**处置：
`idsConsumedByVendor` 只要发现「**有任意一条**被消费」就走「厂商自己投递」那一支并 `return`——
注册了被消费的那条，剩下的既不登记、也不回滚、也没人等它，随本行 `dispose` 一起没。
那一支还只走 `logger.debug` ⇒ **默认日志级别一条都不打**。

⚠️ 与之配套的一条真机事实（决定修法）：**厂商会自己在当前轮收场后把队列里剩下那条撒出去**——
裸臂读数：空闲线程连加两条、之后**什么都不做** ⇒ `turnStarted=3=turnCompleted=3`、两条哨兵都进了
出站请求体。⇒ 正确处置是「别收场、等它」，不是回滚、更不是谎报已交付。

**解决方案**（`providers/codex/turn-injection.ts` 的 `deliverIdle` + `index.ts` 的收场接线）：
把「一批」拆成**逐条对账**，没有「整批算成功 / 整批算失败」这一档：

1. `pendingQueued` 跨收场边界记住「已 `queueAdd`、还没被取走」的那些；
2. 每一拍先 `reconcilePending()` 与 `thread/queue/list` 对一次账：**不在表里 ⇒ 厂商取走了**，
   此刻才登记交付；还在表里 ⇒ 留到下一拍；
3. `queueStart` 失败时按**本拍有没有被消费**分档：有 ⇒ `vendorDispatched: true`（那一轮在跑，
   队列里的其余条目会被它在收场时撒出去，**这一行不许收场**）；一条都没有 ⇒ 与过去逐字相同，
   不登记并回滚；
4. `index.ts` 那一侧补一处：重新起「等 `turn/started`」的表之前先撤掉上一只——厂商那一轮的
   `turn/started` 可能在本拍**之前**就到了（`queue/add` 落在空闲线程上时它在 add 那一拍就投），
   那只旧表到点会把这一行收场。

判据：**真机守卫** `providers/codex/inject-idle-batch-live.test.ts`（真二进制 + 脚本式上游，
四条判据＝两条都登记交付 / 两条哨兵都进出站请求体 / 起过的轮次全部跑完 / 结论取两句都收到那一轮；
**两个对照臂**＝单条那一档逐字不变、不挂注入面时哨兵零出现）。
**变异验证**：把「还在队里」的那些丢掉（= 旧行为）⇒ 见红（`两条人话都必须登记交付`）；还原后 sha256 一致。
既有单测 `turn-injection.test.ts` 的两条（没被消费 ⇒ 不登记 + 回滚 / 读不回来 ⇒ 保守不交付）逐字不变。

---

## `TypeError: Cannot read properties of null (reading 'id')`（app-server 的一行 `null` 打崩宿主 Node 进程）

**日期**：2026-10-17

**现象**（探针读数，真管道 + 真客户端，装着客户端的 Node 进程退出码 1）：

```
❯ handleLine src/providers/codex/appserver/client.ts:335:24
TypeError: Cannot read properties of null (reading 'id')
```

同一批读数里另外几种「合法 JSON 但不是帧」的行**不崩**：`123` / `"x"` / `[1,2,3]` 只落一条
「认不出归属的响应」WARN，后面的请求照常配对。

**根因**：`JSON.parse('null')` 返回 `null` 是**合法 JSON**，而 `handleLine` 拿到它之后直接读
`message.id` ⇒ 抛 `TypeError`。这一行是从 socket 的 `data` 处理器里跑出来的，抛出去就是
**未捕获异常**——Node 的默认处置是打印后 `process.exit(1)`，于是**整个宿主进程（本仓是 Next 服务）
被一行坏帧带走**。数字 / 字符串那一档不抛（原始值属性访问得 `undefined`），但它们同样不是帧，
会一路滑到「认不出归属」那一支 ⇒ `unparsedFrames()` 把这三类都漏掉，计数不再是「坏帧数」。

**触发条件未观测到**：真 codex 上百帧一次没发过 `null` 行。但**判据在我们这一侧**——
「喂进去会不会崩」与「厂商发不发得出来」是两个问题，前者必须为否。

**解决方案**：`handleLine` 在 `JSON.parse` 之后先挡一道「**不是对象**」（`null` 与原始值）：
计入坏帧 + 落 WARN + `return`，不碰任何属性。判据：`appserver/client.test.ts`
「合法 JSON 但不是对象的行（null / 数字 / 字符串）⇒ 不抛、计数、后面的帧照常」——三行都喂进去，
断言**未捕获异常为空集**、`unparsedFrames() === 3`、且随后一条真请求照常配对。
**变异验证**：把那道闸去掉 ⇒ 见红，报错原文与上面逐字相同（`Cannot read properties of null`）；
还原后 sha256 一致。

---

## 组长先死之后，`codex` 那条插件同步 git 链整条留下来（同进程组的孙进程全活）

**日期**：2026-10-17

**现象**：真进程组逐格对照（`sh -c 'sleep 120 & sleep 120 & wait'` + `detached: true`，读数组内成员用 `pgrep -g`）：

```
E1 先 SIGKILL 组长，再调 terminateProcessTree
   before = [leader, c1, c2]   outcome = {via:'direct', exited:true, waitedMs:0, error:null}
   after  = [c1, c2]           ← 2 个孙进程仍活
E2 不先杀组长（对照）
   before = [leader, c1, c2]   outcome = {via:'tree',   exited:true, waitedMs:0, error:null}
   after  = []                 ← 清零
E1′ 事后手工 kill(-pgid)
   after  = []                 ← 只要发那一发就能清干净
```

**根因**：`terminateProcessTree` 把「直接子进程已退出」当成「树已经回收干净」而**整条短路**
（`if (hasExited(child)) return { via: 'direct', … }`）——而 `hasExited` 只看直接子进程的
`exitCode` / `signalCode`，那条 `kill(-pid, SIGKILL)` 根本不发。组的身份就是**组长**的 pid：
组长没了、组还在，孙进程因此原样存活。codex 的插件同步链正是这个形状
（`codex → git → git → git-remote-https`）。可达路径是「厂商进程先死」的每一条：用户 / 看门狗
`SIGKILL`、OOM、宿主停机、以及 `startCodexSession` 里起手失败那条 `close()`；在 Windows 上
后果就是仓库自己记录过的 `EPERM`（`$CODEX_HOME` 被孤儿句柄锁住）。

**解决方案**：短路只保**等待**那一半——`alreadyExited` 仍照发整树杀，只是不再为一次不可能到来的
`exit` 白等宽限期；`defaultKillTree` 的 POSIX 分支把两次 kill 都回 `ESRCH` 记成「它没了」
（与 Windows 分支「进程不存在也算成功」同口径），只有 `EPERM` 之类才交出去。
判据：真机守卫 `packages/server/agents/src/process-tree-orphan.test.ts`（真进程组 + `pgrep -g`，
两臂唯一自变量是**组长死没死**，判据是调完之后组内还剩几个成员；`pgrep` 不可用时整条跳过——
不把「没有观测手段」读成「清空了」）+ 单测 `process-tree.test.ts` 那一条（已改成断言
「已退出也要发整树杀」）。**变异验证**：把旧的整条短路加回去 ⇒ 真机臂见红
（`expected 2 to be +0`）、单测那条见红；还原后 sha256 一致。

---

## 落盘写着「子线程 … 没有用量通知」，而通知其实到了（子智能体分量与轮次分量一起记 `null`）

**日期**：2026-10-17

**现象**：行跑完（真二进制 + 脚本式上游造的真子智能体），落盘一条点名 WARN：

```
[WARN] codex 子线程 01a145… 没有用量通知（协议只按线程报累计用量）：
这一行的**子智能体分量与轮次分量**都给不出（记 null，不编造、不填 0），合计退回主线程口径
```

而同一轮的探针读数里，那条通知**明明到了**：子线程 `thread/tokenUsage/updated` 落在 t=158、
收尾取数落在 t=161。同一个剧本连跑 4 次，**2 次拿到子线程用量、2 次丢**（1–4 ms 的竞态）。

**根因**（机制层，两处叠加）：① 用量只从运行期的 `thread/tokenUsage/updated` 通知累计，而通知是在
**流那一侧**投影进 `runState` 的；`session.ts` 的 `iterate()` 在「队列已排空 ∧ 本轮已结算」时
`return`，此后入队的通知**再没有人投影**。② 本轮结算的闸门是**主线程的 `turn/completed`**，
子线程往往还在跑 ⇒ 结算与收尾取数都可能抢在那条用量通知之前。于是「通知到了但没被投影」与
「厂商压根没发」在读数上长得一模一样——而旧文案选了一个说，把排查方向指到厂商那边去。

**解决方案**：**文案先说我们这一侧的事实**——`index.ts` 的两条 WARN（主线程 / 子线程）改成
「用量**本行没有采到**（协议只按线程报累计用量；通知若在流收尾之后才到，就没有人再把它投影进读数）」，
不再替厂商下结论。判据：`index.test.ts` 的两条断言同步改成新措辞。

**根因已闭合**（同批）：`asRawStream` 在上游产完之后走一段**有界**的静默窗口
（`CODEX_DESCENDANT_QUIET_WAIT = { waitMs: 10_000, pollMs: 250 }`）——每一拍把**流停之后入队**的
那些通知取出来投影（`CodexSession.drainPending()`；游标必须与迭代器**共用一处**，各记一份会把整段
历史重发一遍 ⇒ 消息成对重复），并问一次「后代线程还活着吗」；窗口结束才让流收尾，收尾取数等这道
闸门放行之后才读树。三条边界：**没有后代线程时不花任何时间**（第一次枚举回空表就放行）；
**预算到点按现状收尾**（落一条点名 WARN，不把一行永久挂住）；取消那一档立刻放行。

真机读数（同一剧本、子线程那一趟拖 8 s）：

```
修复前  turns=2 subagentTurns=null subagentTokens=null  子任务行 status:"running"/outcome:null
        thread/read{child}.status={"type":"active"}      items 只有 1 条 userMessage
修复后  turns=3 subagentTurns=1 subagentTokens={input:78,cached:33,output:11}
        子线程答复进账本（`<childId>|1|assistant|-`）     子任务行 status:"completed" 且带 outcome
```

判据：真机守卫 `providers/codex/descendant-quiet-live.test.ts`——脚本式上游发一帧
`function_call{name:'spawn_agent', namespace:'multi_agent_v1'}`（它在真机工具表里是 namespace 工具）
派真子智能体，子线程那一趟延迟 1.5 s 才回；**四格一起判**（内容 / 用量 / 轮次 / 终态），
只判一格会让「这一格恰好赶上了」蒙混过关。**变异验证**：把静默窗口整段去掉 ⇒ 见红
（`子线程用量必须采到: expected null not to be null`）；还原后 sha256 一致。

---

## 上游 401 归成了 `AUTH_FAILED`，但那是靠文案里的「401」蒙对的（机器可读分类对 HTTP 失败恒不命中）

**日期**：2026-10-17

**现象**：本地脚本式上游回 401，codex 投的行级失败通知逐字是：

```json
{"method":"error","error":{"message":"Reconnecting... 1/5",
  "codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":401}},
  "additionalDetails":"unexpected status 401 Unauthorized: …"}}
```

500 那一档同形：`{"responseStreamDisconnected":{"httpStatusCode":null}}`，而 `additionalDetails`
是 codex 自己的话——*"We're currently experiencing high demand, which may cause temporary errors."*
⇒ 行被归成 `AGENT_FAILED`（在自动重试表里，重试 3 次），失败文案指向 OpenAI 的「高需求」而不是
本地上游的 500。

**根因**：`readCodexErrorCode` 只取对象变体的**名字**，而这一格的名字说的是**传输层**
（`responseStreamDisconnected` 对 401 与 500 **同形**）⇒ `codexFailureOf` 那四条「机器可读分类」
分支（比的是 `unauthorized` / `rateLimitExceeded` / `usageLimitExceeded` / `serverOverloaded`
这些**字符串枚举**）对 HTTP 失败**一次都不命中**，401 只能靠 `additionalDetails` 里那个「401」
被正则认出来——而那个函数自己的注释写着「厂商改一句文案就错档」。`httpStatusCode` 此前被
**主动丢掉**（旧注释：「只取名字、不取 `httpStatusCode`」）。

**解决方案**：`AppServerTurn` 新增一格 `errorStatusCode`（读对象变体里那个 `httpStatusCode`，
取不到就是 `null`），`codexFailureOf` 把 `401` / `429` 与字符串枚举**并列**成判据。
判据：`providers/codex/events.test.ts` 新增一条——文案**刻意不含状态码**，只有对象变体说得出真相
（`401` ⇒ `AUTH_FAILED`、`429` ⇒ `RATE_LIMITED`、`httpStatusCode: null` ⇒ 不强行归档且分类名进文案）。
**变异验证**：把状态码那两条判据去掉（回到只比枚举）⇒ 见红
（`expected 'AGENT_FAILED' to be 'AUTH_FAILED'`）；还原后 sha256 一致。

**未闭合**：`sandboxError` / `contextWindowExceeded` 两档仍未观测到（触发条件未知）；
连接被拒那一档（`httpStatusCode: null`）**会自行收场，用的正是产品自己的预算**：厂商持续回 `error`/重连（21 帧里 13 帧是 `error`），定案的是**单轮墙钟那条**看门狗，落在 **600.1 s** —— 逐条读数依次是「看门狗：单次模型往返超过 600 秒仍未收尾」→「codex 本轮被中止」→「用量本行没有采到」→「该行已按看门狗判定静止超时收场」。原先这里记的「600 s 内不自行收场」是**取样点压在边界上**（恰在 600 s 那一刻去看）造成；**关掉那条看门狗再测一次**（`turnWallClockMs: 0`）⇒ **到 700 s 仍不收场**（690 s / 695 s 两档都是「本轮尚未结算」，全程只有 17 条事件、约 40 s 一次 `error`），最后是**测量臂自己的上限**把它终止的。⇒ **厂商不会自己收场，是产品那条单轮墙钟看门狗把这一行救回来的** ——它不是「避免了一个 bug」，而是**这一档上的载荷路径**
（看门狗是静止超时，而重连本身在产事件），归因与预算都还没有读数。

---

## 思考块整段没有：`item/*` 里一条 `reasoning` 都没有（不是我们没投影，是这条路由上游不给明文）

**日期**：2026-10-17

**现象**：真机跑完一整轮（真 `codex 0.163.0` + 内网网关 + 真模型），把厂商发过的 `item/*` 通知按
类型数一遍：

```
item/completed:agentMessage 9    item/started:agentMessage 9
item/completed:collabAgentToolCall 6 / item/started:… 6
item/completed:commandExecution 2 / item/started:… 2
item/completed:userMessage 3     item/started:userMessage 3
reasoning 相关的帧：0
```

`item/reasoning/textDelta` 与 `item/reasoning/summaryTextDelta` 同样 **0 条**。

**把全部审计臂的原始帧一起数一遍**（122 份 `.jsonl`，覆盖升级面 / 事件面 / 注入面 / 收尾面 / 生命周期面），
更能说清这一格**到底哪一条通道亮**：

```
item/started:reasoning ×6    —— 全部是 content=0 / summary=0 的**空占位**
item/completed:reasoning ×0  —— 带正文的快照**一次都没出现过**
item/reasoning/textDelta ×6 / summaryTextDelta ×7 / summaryPartAdded ×5   —— 增量三条都在
```

⇒ 结论要分开说：**空占位那条判据的触发形状是真的**（`item/started` 的两格都是空数组，所以
「`started` 不产块」不是防御性代码）；**带正文的快照通道在本轮全部读数里没有出现过**，
而增量三条都亮。`message.ts` 的 `reasoningDrafts` 承担两件事——① 给增量封口（今天真正在用的那一半），
② 从 `item/completed` 的快照取值（今天没有读数）。别把这两半一起说成「死代码」。

**⚠️ 本条的结论已在后续读数里收窄——先看这一段再看下面**：同一个网关、同一个模型
（`jd/deepseek-v4-flash-0731`）在**给了 `effort`** 的臂上是**有**推理条目的：

| 给的 `effort` | 出站 `reasoning.effort` | 真机产出的推理条目数 |
|---|---|---|
| `medium` | `medium` | **1** |
| `ultra` | `medium`（被降档） | **1** |
| `persistent` | `disabled` | **0** |

⇒ 正确的说法是「**没给档位时这条路由不投推理正文**」，而不是「这条路由不给明文」；而
`persistent` 那一行的 **0** 更是一条端到端确证：它不只是把请求字段改成 `disabled`，而是
**真的让厂商一个推理条目都不产**（详见 `reasoningEfforts` 那条条目）。下面那段「根因」描述的
是**没给档位**那一档的形状，别当成恒定行为读。

**根因**：这家在**密文路由 + 未指定档位**时不投推理正文——与知识库那条「`content[]` 为空 ⇒ `text: null` + `'none'`，
不回落 summary」是同一件事的两面。⇒ 界面上没有思考块**不是**投影丢了；`message.ts` 的
`reasoningDrafts`（`item/completed` 的快照封口）在今天的路由上**不亮**，它是按协议写好、
**等上游给明文时才生效**的那一支。别照「怎么没有思考块」去查适配器。

**判据／复采**：真二进制 + 脚本式上游（零凭据）把每次请求的响应与厂商通知原文落盘，再按
`item/*` 的 `item.type` 计数——`reasoning` 计数的**对照臂**是「上游确实喂了 `reasoning` 输出条目」，
那时快照与增量两条通道才会亮。**别拿「这一档没有」证明「这一家没有」**：换路由（尤其换成会回明文
推理的网关）之前，这一格只能记「本路由未观测到」。
