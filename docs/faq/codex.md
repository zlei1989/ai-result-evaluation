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

**日期**：2026-10-10

**现象原文**（模型答复，同一轮里内置 shell 工具完全正常、审批请求为零）：
```
unsupported call: probe_echo
```
配套三格：`mcpServer/startupStatus/updated` → `status: "ready"`；事件流里 `mcpToolCall` **零条**；MCP server 侧（`PROBE_CALL_LOG`）**零 `tools/call`**。⚠️ 同一矩阵里还抓到一次**假绿**：某一轮最终答复是 `hello`（像是调用成功了），而 server 侧同样零调用——**判据只能是 server 侧记录**，模型答复不算证据。

**根因**：**上游命名空间缺口**（不是本仓配置问题）。codex 自 0.156 起把 MCP 工具按「命名空间」暴露给模型（推理里逐字说 `namespace listed function is mcp__probe with probe_echo`），而**自定义 OpenAI 兼容 Responses 网关**（本仓的 `likecode-llm-proxy`，issue 里的 llama.cpp / Ollama / LM Studio / OpenRouter 同型）在转发时把它**拍平**成普通 function call ⇒ codex 的工具注册表（错误文案出自 `core/src/tools/registry.rs`）解析不了扁平函数名，回 `unsupported call`。官方 Responses 会保留那层结构，所以只有自定义网关中招。

**不是配置能解的**（本地矩阵五组全败）：`GLM-5.3` ❌、`DeepSeek-V4.1-Flash-a` ❌、打开 `features.non_prefixed_mcp_tool_names = { server_names = ["probe"] }` ❌（它改的是**暴露给模型的名字**，不改「回传时缺失命名空间」）、**升级到 `0.163.0-alpha.5` ❌**。三条出路（网关侧还原命名空间 / 追上游 / 退到命名空间机制之前的版本，最后一条代价最大）留给运维层决定。

**解决方案**：**本仓不硬解**，按「已知边界」处置（`docs/protocols/codex.md` 的 MCP 条目 + 契约常量 `CODEX_MCP_DISPATCH_GAP_NOTE`）：
- 判据只到「装上了」——`mcpServer/startupStatus === 'ready'` ⇒ 行级观测格记 `connected`（判据来源 `vendor-startup-status`），**一个字都不暗示工具可用**；界面的行卡片浮层与环境抽屉的「本行 MCP」都附上那句话（`build-environment.ts` / `eval-row-card.tsx`，文案取契约里那份共用常量）；
- 冒烟对 codex 只验 `ready`（只验 `ready` 的口径），**不把调不动当本仓缺陷**去修；
- 复跑探针定期确认上游是否已修：`AIEVAL_LIVE_MCP=1` 跑 `packages/server/agents/src/providers/codex/live-mcp.test.ts`（判据仍是**事件侧 + server 侧**两处——`mcpServer/startupStatus` 与 server 自己的调用记录，模型答复不算）。

证据矩阵（五组本地矩阵 + 三格配套信号）见[《MCP 配置》](/features/mcp-config)的「已知边界与取舍」；同一句结论已落成契约常量 `CODEX_MCP_DISPATCH_GAP_NOTE`（界面与文档都取那一份）。外部同型 issue（#26977 / #20652 / #26234）见下方「相关资料」。

**相关资料**：[MCP tools return 'unsupported call' with custom Responses API provider (llama.cpp) · #26977](https://github.com/openai/codex/issues/26977)、[Resolution failure for flattened MCP tool names from OpenAI-compatible proxies · #20652](https://github.com/openai/codex/issues/20652)、[Flatten MCP namespace tools for non-OpenAI Responses API providers · #26234](https://github.com/openai/codex/issues/26234)

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
- `item/reasoning/summaryTextDelta` 与 `item/reasoning/summaryPartAdded` 在本路由上**恒 0 条**（是**上游不给摘要**，不是我们没接；`summaryIndex` 因此**无样本**，不是恒 0）⇒ 摘要那一块在 DeepSeek 上结构性拿不到，`thinkingTextKind: 'full'` 的声明与实际相符。
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

