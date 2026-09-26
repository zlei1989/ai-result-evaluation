# AGENT.md

用中文交流。

## 约束

- **写 Next.js 代码前先读 `apps/web-next/node_modules/next/dist/docs/` 中的相关指南** — 当前版本可能有训练数据未覆盖的破坏性变更
- **写 UI 前先用 context7 查组件用法** — 常规界面与布局用 `antd`；适配 `light` 与 `dark` 主题，弹性布局自适应屏幕尺寸；样式一律走 `antd`（主题 token / 紧凑密度 / 语义 `styles`）——**不手写字号**（交紧凑密度）、**不手调行内边距**（交组件默认），避免裸写 `div` 等原始标签
- **提交时逐个显式 `git add <路径>`，禁止 `git add -A`** — 本仓可能同时有别的会话在工作，`-A` 会把别人未提交的改动卷进你的提交；`git status` 里出现不属于你的文件时，**保持原样、不要动它**
- **代码变更后、进入审查阶段前，必须先执行检查** — 顺序：`pnpm typecheck` → `pnpm lint` → 修复所有错误 → 再进入代码审查；格式修复产生的变更需随本次改动一并提交
- **新增的每条回归守卫都必须做变异验证** — 把它要拦的缺陷人为制造回去，确认该守卫**失败**，再还原并核对文件哈希未变。**没有见过失败的守卫不算守卫**（本仓的守卫已多次被实测证明无区分力）
- web 启动时若端口被占用，先 kill 占用进程再启动

## 目录与边界

monorepo：1 个下游应用 + 服务端/客户端两层，职责严格分离（架构见 `docs/superpowers/specs/2026-09-22-scaffold-design.md`）：

```text
ai-result-evaluation/
├── apps/
│   └── web-next/       # 下游应用：Next.js 薄组装；路由只做「zod 校验 → 调 api → 错误映射」三件事
├── packages/
│   ├── server/
│   │   ├── core/       # 工作区引擎：git CLI 原语、配置落盘、路径校验；无任何业务，只用 Node 内置 + contracts
│   │   ├── agents/     # 智能体抽象层 + 三家适配器（Claude Code / Codex / DSH）：唯一允许引厂商 SDK 的包，
│   │   │               #   对外只暴露 provider 注册表，三家差异全部吸收在 providers/<kind>/
│   │   │               #   DSH 走 pi-ai 路由（`llm-pi-ai`）：anthropic→anthropic-messages、openai→openai-responses，
│   │   │               #   路由/模型/档位写进 per-run overlay（`--patch`），已退役 settings.yaml 与 DEEPSEEK_*
│   │   ├── evaluator/  # 编排状态机 + 评分器 + 事件落盘；不碰框架、不碰具体 SDK
│   │   ├── api/        # 功能服务层：一个功能一个文件；只依赖 evaluator + agents + core + contracts，禁止 import 任何框架
│   │   └── contracts/  # 跨端契约：zod schema + 领域类型 + 错误码
│   └── client/
│       ├── ui/         # 纯展示组件（base + composite）；纯数据驱动，不调接口
│       └── client/     # 数据层：SWR hooks + HTTP 原语，类型全部来自 contracts
├── docs/
│   └── superpowers/    # specs（设计与实现计划）/ plans
└── eslint.shared.ts    # 共享规则 + 分层边界规则（withBoundary）
```

依赖方向（`eslint.shared.ts` 的 `withBoundary()` 硬约束框架依赖与跨包相对引用，**含动态 `import()` 与 `require()`**；`@aieval/*` 之间的边除 ui / client 的禁名单外 lint 不拦，只由下表约束——新增跨包依赖必须同时改表）：

```text
web-next → api / core / ui / client / contracts
api      → evaluator / agents / core / contracts   # agents：候选池按智能体读注册表元数据（协议**集合** protocolTypes，判据 acceptsProtocol）
evaluator→ agents / core / contracts
agents   → core / contracts
ui       → contracts
client   → contracts
core     → 无（Node 内置之外）
```

> 脚注（p5 阶段评审裁定）：`apps/web-next/vitest.config.ts` 的 `resolve.alias` 把 `@aieval/evaluator` 指向源码，**仅为让路由测试里的 `vi.mock` 生效**（测试期解析，**不**建依赖边、**不**进 `next build` / `next dev`——那两个命令根本不读该文件）。不加它时 `vi.mock` 只注册在未解析的裸说明符上、api 内部仍解析到真实模块，mock **静默失效并真的会 spawn agent 子进程**（Task 10 实测）；之所以不改成 devDependency：那会动 `pnpm-lock.yaml`，并把一条**运行时可解析**的 `web-next → evaluator` 边装进应用——正是本表没有这条边的原因。 alias 一旦消失不会静默：`apps/web-next/src/route-runs.test.ts` 有一条正向 mock 存活断言会红。

## 删除与 PowerShell 安全

> 起因（2026-10-01）：一段手敲的 PowerShell 用 `$home = Join-Path $env:TEMP '…'` 承载临时目录，随后 `Remove-Item $home -Recurse -Force -ErrorAction SilentlyContinue`。`$home` 是**只读自动变量**，赋值失败后它仍是 `C:\Users\<用户>`，而 `-Force` 会剥掉只读属性、`-ErrorAction SilentlyContinue` 又把报错吞掉 ⇒ **用户目录被删空，只剩被句柄占用的文件**（`NTUSER.DAT`、活动中的 `AppData`）。命令未落盘、`ConsoleHost_history.txt` 随 profile 一起消失，真凶无法取证——所以下面按"机制"约束，不依赖复盘。

| 规则 | 说明 |
|------|------|
| **禁止**把 `$home`/`$HOME`/`$profile`/`$env:USERPROFILE`/`$env:APPDATA`/`$env:LOCALAPPDATA` 当临时变量 | `$home`/`$HOME`/`$profile` 是只读自动变量，`$env:*` 是真实环境变量。临时值一律用专属名：`$dshHome`/`$aiEvalHome`/`$repoRoot`/`$tmpDir`/`$outPath`。**本机只装了 PowerShell 5.1**（无 `pwsh`），5.1 下该赋值报 `Cannot overwrite variable HOME because it is read-only` ⇒ 一旦依赖它，后续所有引用都指向用户目录 |
| **递归删除前必须断言目标在允许根之下** | 判据用 `[System.IO.Path]::GetFullPath($Path)` 规范化 + `$full.StartsWith($realRoot + '\', [StringComparison]::OrdinalIgnoreCase)`；并硬拒盘根、`$env:SystemRoot`、`C:\Users`。**注意末尾 `'\'`**：少了它 `…\Tem` 会被 `…\Temp` 认成子目录。`GetFullPath` 会自动折叠 `..`（实测 `C:\Users\x\.dsh\..\..\..\..\Users` → `C:\Users`，被受保护规则拦住）。完整函数见 `~/.dsh/AGENTS.md` 的 `Assert-Deletable` |
| **不要用 `-like (Join-Path $root '*')` 当守卫** | 右侧是**通配符模式**，路径含 `[` `]` 时被当字符类。实测 `TEMP='…\Temp[1]'` 下合法目标 `…\Temp[1]\scratch` 被判 False（**误杀**），`StartsWith` 判 True。误杀会让守卫显得"碍事"从而被绕过 |
| 删除语句**不得**带 `-ErrorAction SilentlyContinue` | 静默正好隐藏真凶；错误必须显式处理 |
| 删除前**先打印目标**再执行 | 这次事故里没人看见真实路径 |
| **不要指望 PSScriptAnalyzer** | 本机实测：**未安装，且 PSGallery 不可达（装不上）** ⇒ 改成**运行时守卫**（`~/.dsh/AGENTS.md` 的 `Assert-Deletable`，删前必过，不需要任何模块）。想在 CI 里静态扫也不行：全仓 `-Include *.ps1,*.psm1` 命中 **85,205** 个文件（74,309 在 `node_modules`、6,333 在 `.git`），扫描超 2 分钟且被 `apps/web-next/.next/dev/lock` 占用报错 |
| 本仓**只有 2 个** PowerShell 脚本 | `scripts/bench-gates.ps1`、`packages/server/agents/probe/v2/codex-cli-plan.ps1`（排除 `node_modules\|.git\|.next\|.superpowers` 后实测）。**这 2 个靠人工审更划算**，别写全仓扫描门禁（清点一次就要 22 秒）。另注意 `codex-cli-plan.ps1` 头部写的用法路径 `probe/v2/…` 是**旧布局**，真实路径在 `packages/server/agents/` 下 |
| 本仓已审计的永久删除点 | `scripts/split-test-file.mjs:202` 的 `rmSync(src)` 是"拆完测试文件删原文件"的有意行为，且 `src` 已被 `readFileSync` 读过、传目录会先抛错 ⇒ **结构上安全，不要"顺手加守卫"**；`packages/server/core/src/workspace.ts:112-114` 的三个 `rmSync` 分开写是刻意的（行目录新增内容不被顺手清掉），改动它们前先读该处注释 |
| 本仓已审计的 PowerShell 侧风险点 | `scripts/bench-gates.ps1` 用 `Invoke-Expression "$Command 2>&1"`（`:28`）执行命令串 —— 当前调用方传的都是写死的 `pnpm test/typecheck/lint`，**无注入面**，但新增调用方时必须继续传字面量，**不得把外部输入拼进 `$Command`**；`packages/server/agents/probe/v2/codex-cli-plan.ps1:26` 把网关 API key **硬编码在源码里** ⇒ 该 key 应轮换并改从环境变量读（同目录 `lib/gateway.mjs:27` 有同一问题）。这 2 个文件都**不含**递归删除，本次事故与它们无关 |
| 临时目录优先用 `mkdtempSync` 而不是手写删除 | JS 侧 `mkdtempSync` + 自建目录（`probe/v3/dsh-overlay-dump.mjs:36`）；PS 侧用 `New-TemporaryFile`。**能不在 PowerShell 里手写递归删除，就别写** |
| 本仓已审计的永久删除点 | `scripts/split-test-file.mjs:202` 的 `rmSync(src)` 是"拆完测试文件删原文件"的有意行为，且 `src` 已被 `readFileSync` 读过、传目录会先抛错 ⇒ **结构上安全，不要"顺手加守卫"**；`packages/server/core/src/workspace.ts:112-114` 的三个 `rmSync` 分开写是刻意的（行目录新增内容不被顺手清掉），改动它们前先读该处注释 |

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 起 web-next 开发服务器（http://localhost:3083） |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 全量检查——根 `eslint.config.ts`，**一个**进程覆盖 8 个包 |
| `pnpm format` | ESLint `--fix` 自动修复（与 `lint` 同一条根配置，只多 `--fix`） |
| `pnpm typecheck` | TypeScript 全链类型检查——`tsconfig.typecheck.json`，**一个** tsc 进程 |
| `pnpm test` | vitest 全量测试——根 `vitest.config.ts` 的 `projects` 收齐 8 个包，**一个**进程 |
| `pnpm test:changed` | 只跑与改动相关的文件（`vitest run --changed`）——**内循环用这个**，全量留给门禁 |

- 三条聚合命令**刻意都不走 `pnpm -r`**（递归会按拓扑序为 8 个包各起一次进程，白付启动税）。聚合靠**复用同一份包级真源**：`eslint.shared.ts` 的 `boundaryConfigs()` 由根配置按包目录前缀化、根 `vitest.config.ts` 用 `projects` 按路径引用各包 `vitest.config.ts`、根 `tsconfig.typecheck.json` 是各包 `include` 的并集。**别退回 `pnpm -r`**，也别把包级规则抄进根配置（两份必然漂移）。
- 单包：`pnpm --filter @aieval/<包名> <脚本>`，走各包自己的 `eslint.config.ts` / `vitest.config.ts` / `tsconfig.json`——与根命令是同一份真源的两个视图，结果必须一致，**改了根命令就要回头确认单包命令仍然可用**。

## 测试

| 规则 | 说明 |
|------|------|
| 环境 | `vitest.node.ts`（node，库包与 web-next）/ `vitest.jsdom.ts`（jsdom，`ui` 与 `client`）。纯函数测试标 `// @vitest-environment node` |
| **`.tsx` 测试只在库包可写** | 根 `tsconfig.base.json` 的 `jsx` 是 `react-jsx`；`apps/web-next` 保留 `preserve`（Next 需要），**故该应用内不能写 `.tsx` 测试**——Vite 的 import-analysis 直接读 tsconfig 的 `jsx`，报 `make sure to not set jsx to preserve`，**改 vitest 的 `esbuild.jsx` 或 `esbuild.tsconfigRaw` 都无效**（报错来自 Vite 而非 esbuild） |
| 别名 | `apps/web-next` 的 `@/*` 指该应用根目录。**vitest 不读 tsconfig 的 `paths`**，故 `apps/web-next/vitest.config.ts` 里显式给了 `resolve.alias`（用 `import.meta.dirname` 推导，不依赖 `process.cwd()`） |
| 根聚合的收集范围 | `pnpm test` 由根 `vitest.config.ts` 的 `projects` glob 收集（`packages/{server,client}/*` 与 `apps/*`）；新增包落在这些目录下且自带 `vitest.config.ts` 就会被自动收进来。**改动收集方式后必须核对用例总数与逐包跑一致**——漏收集一整个包是静默漏测，退出码仍是 0 |
| 组件测试的 `matchMedia` 与 `ResizeObserver` | jsdom **两者都没有**；前者由用例自己注入（主题模块的「无 matchMedia 按暗色」兜底正是要覆盖的路径），后者的桩在 `packages/client/ui/src/testing/resize-observer.ts`，**刻意不放进共享 setup**（否则组件的「无 ResizeObserver」兜底分支再也测不到） |
| 真实拖拽 | jsdom 里不可达（尺寸按容器 0 换算后非有限，分隔条变成不可拖）；`Splitter` 的 `onResize` 回写只能在真实调用方处钉 |
| 重试预算写成**可变对象**（`TEXT_API_RETRY` / `ROW_RETRY`） | 真等 `ROW_RETRY.delayMs`（3s）× 重试次数会把每条失败面用例拖慢十倍（重试会重跑真仓库准备）。用例在 `beforeEach` 里把**产品默认值**读进一个常量、再把它改小，重试那一组显式改回来；**默认值必须有独立用例钉住**（否则默认值成了无人验证的常量），`afterEach` 必须还原 |
| **计价单位是「进程创建」** | 本机实测（2026-09-28，i7-1360P / Windows）：`cmd /c exit 0` **162ms**、`git --version` **566ms**、`node --version` **530ms**——企业 DLP/EDR 在每个新进程上挂钩（Defender 实时防护是**关**的）。由此推导：`initFixtureRepo`（7 次 git）≈ **1612ms**、本地 `git clone` ≈ **1053ms**、`git status` ≈ 250ms。**测试要提速就减进程数**：夹具用 `beforeAll` 模板 + `cpSync`（~10ms），用例缓存预热（`evaluator/src/testing/orchestrator-harness.ts` 的 `prewarmCaseCache`），产品侧合并 git 往返（`collectDiff` 曾 6 个进程、`assertCommit` 曾 2 个） |
| **墙钟由最长的那个文件决定** | vitest 按**文件**并行、文件内**顺序**执行。实测（2026-09-28）：`orchestrator.test.ts` 一个文件占了全量 2437s 里的 2426s（85 条用例挤在一个 worker 里）。**长杆文件按 describe 拆开**是唯一能打破这个天花板的手段（已拆成 `orchestrator-*.test.ts` 十个文件 + `testing/orchestrator-harness.ts`）。拆出来的文件**每个都必须自己写三条 `vi.mock`**——vitest 的前置提升只作用于测试文件自身，漏一条会**静默**退回真实实现（真的 spawn 厂商 CLI）；守卫在 `evaluator/src/static-assertions.test.ts` |
| **失败比成功贵一个数量级** | 守卫上限是按「宁可超时也不假红」定的（`until` 30s、`REMOTE_FIXTURE_TIMEOUT_MS` 300s、`testTimeout` 60s/20s/5s）。实测一次全量里 12 条红 = 5×300s + 7×60s = **32 分钟**，占那次墙钟 79%。`until` 的第 4 参 `impossible` 只给**终态期望**用（落成别的终态就是真失败）；同步点式的等待刻意不接，避免把「错过观察」判成假红 |
| 跑法分层 | 改一个包：`pnpm vitest run packages/server/<包>`；改一个文件：`pnpm vitest run <文件路径>`；只跑改动相关：`pnpm test:changed`。**全量留给门禁**——它是分钟级的，不该进内循环 |
| **机器带负载时的跑法** | 本仓的墙钟与红数都**同时取决于机器状态**：实测同一份代码，安静时 `tests` 累积 2604s（全量 ~225s），而机器上同时跑着开发服务器 + 浏览器自动化时涨到 **8154s（3.1×）**——此时 60s 的 `testTimeout`/`hookTimeout` 必然被撞穿，红的是"机器慢"而不是代码。带负载时用：`pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000`（少开 worker 减少互相踩，预算按倍数放宽）。**先看 `tests` 累积那一项**：它比上次大 2 倍以上，就别把红当成回归 |

## 注释

| 规则 | 说明 |
|------|------|
| 风格 | TS/TSX 用 JSDoc；中文，简洁，先说"做什么"再说"怎么做" |
| 文件头 | 简要说明文件职责 + 注意事项 |
| 嵌套 > 2 层 | 必须注释业务含义 |
| 功能点 | 方法、条件分支、事件处理、数据转换等独立功能单元都需说明其业务目的和关键逻辑 |
| 重要方法 | 必须注释算法思路或业务逻辑 |
| 特殊处理 | 环境判断、响应处理等需注释原因 |
| 密度 | 同文件内保持一致 |

## 日志

| 级别 | 场景 |
|------|------|
| ERROR | 业务异常、外部调用失败 — 必须打印堆栈和业务上下文 |
| WARN | 降级、重试、超时、配置缺失但可继续 |
| INFO | 请求入口、关键状态变更、外部调用耗时 >500ms |
| DEBUG | 分支走向、中间变量、循环关键节点（生产默认关闭，`AIEVAL_DEBUG=1` 打开） |

**必须打日志的点位**：请求入口（INFO + 标识）、外部调用（DEBUG 参数 + INFO 耗时）、异常捕获（ERROR + 堆栈 + 上下文）、关键分支（DEBUG + 依据）

日志器在 `@aieval/core` 的 `createLogger(scope)`；**上下文作为 `console` 的第二个参数透传，不要 `JSON.stringify`**（后者遇到循环引用或 BigInt 会抛，而日志器不该有能力打断业务流程）。

## 持久化

- 配置目录：`AIEVAL_CONFIG_DIR` > `~/.aieval`；测试用 `setConfigDirForTesting(dir)` 指向临时目录，**测试不得触碰真实 `~/.aieval`**
- **写盘必须原子**：写临时文件（创建即 `0600`）→ `renameSync` 覆盖；**不要先删目标再 rename**（两步之间崩溃会让配置文件彻底消失，而 `loadConfig()` 会静默回落默认值）
- **rename 失败的 `EPERM` 有两种成因，处置相反**：① 目标只读——替换只读文件在 Windows 上必失败，只能先删目标；② 杀软/索引器瞬时占用——重试 rename 就过去了。必须用 `statSync(file).mode & 0o200` 区分（Windows 上 libuv 用写位表达只读属性），**无条件先删会在 ② 上白白制造丢配置窗口**（全量并发测试下稳定复现）。守卫在 `packages/server/core/src/config-store.test.ts`
- **读盘必须容忍 UTF-8 BOM**：外部工具（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json`）默认带 BOM，而 `JSON.parse` 遇到它直接抛
- 配置文件损坏时抛**含路径的中文原因**，绝不能让 `SyntaxError` 冒充「请求体不是合法 JSON」

## 边界与工具链的已知坑

| 坑 | 正确做法 |
|----|----------|
| `pnpm-workspace.yaml` 的 `allowBuilds` | pnpm 11 必需（`sharp` / `unrs-resolver`）。**写进 `onlyBuiltDependencies` 不再生效**（仍报 `ERR_PNPM_IGNORED_BUILDS`） |
| flat config 的规则是**整体替换**不是选项合并 | `withBoundary` 生成的对象排在 `baseConfig` 之后且匹配同一批文件，会把 `baseConfig` 的 `no-restricted-syntax` 整条盖掉——两处各放一份（共用同一个常量对象） |
| `no-restricted-imports` 覆盖不到动态 `import()` 与 `require()` | 边界另配 `no-restricted-syntax`，且选择器**必须按说明符过滤**（裸 `ImportExpression` 会把包自己的 `import('./x')` 一起禁掉，挡住合法的代码分割） |
| `import-x/no-relative-packages` 单开不生效 | import-x 的 node 解析器默认不含 `.ts`，规则在 `resolve()` 失败时静默 return；必须在 `baseConfig` 补 `settings['import-x/resolver'].node.extensions` |
| `escapeRegExp` 漏转义 `/` | 该正则会拼进 esquery 的 `/…/` 字面量，`@aieval/client` 的 `/` 会提前闭合它，**ESLint 直接以退出码 2 崩溃** |
| 紧凑密度**绝不显式写 `fontSize`** | `compactAlgorithm` 会覆盖它并反向推导，实效字号掉到 10px（比 antd 默认的 14 还小）；只给 `fontSizeSM: 11`，产出 12 / 11 / 14 |
| antd 6 `Button` 的 `variant` **单给不生效** | `Button.js` 只在 `color` 与 `variant` **同时**存在时才用它们（`if (color && variant)`），否则回落 `type` 的语法糖、再回落 `['default','outlined']`——`variant="dashed"` 会**静默**渲染成实线（实测：类名是 `ant-btn-variant-outlined`，`borderStyle: solid`）。要什么形态就成对给 `color="default" variant="dashed"`，或改用语法糖 `type="dashed"` |
| 主题必须**三处同步** | `ConfigProvider theme` + `html[data-theme]` + `ConfigProvider.config({ holderRender })`；缺一处就是「组件亮了、底色还是暗的」半亮主题 |
| antd `Splitter` 的尺寸入口用受控 `size` | 不用 `defaultSize`（后者只在挂载时读一次）；**受控模式下拖拽必须把 `onResize` 回写进 `size`**，否则松手弹回。弹性列**不给 `size`**（条件展开，不是 `size={0}`） |
| antd `Flex` 的 `display` / `flex-direction` 走 CSS 类 | 内联 `style` 读不到；结构性不变量要自己写进内联 style，否则 antd 换实现或改类名就静默失效 |
| `next dev` 生成的 `next-env.d.ts` | 已 gitignore，并由 `eslint.shared.ts` 的 `boundaryConfigs('web-next')` 忽略（它用双引号与三斜线语法，会让 `@stylistic/quotes` 报错）。**这条只能放在包级配置里**：根配置会把包级条目按目录前缀化，散写在 `apps/web-next/eslint.config.ts` 里的裸条目会被根路径漏掉 |
| 根 `eslint .` 的边界规则必须**按目录前缀化** | 包级 glob 相对包根（匹配任意深度 ts/tsx），根配置直接复用而不加目录前缀，core 的禁用名单会落到全部包上（web-next 会被误伤成「禁止 import react」）。前缀化在 `eslint.shared.ts` 的 `scopeToDir()`。**改完必须做双向变异验证**：`packages/server/core/src/` 里写 `import 'react'` 必须报错，`apps/web-next/src/` 里写同样的 import 必须**不**报错——只验前者漏掉「跨包误伤」，只验后者漏掉「规则根本没生效」 |

## 冒烟测试

- **流程**：启动真实服务（web-next :3083），用 mcp 在浏览器中按真实用户路径逐项操作（表单输入、按钮、弹窗、导航、拖拽），并用 CLI 复核落盘事实（配置文件内容、git 分支与 diff），页面展示与磁盘事实互证。
- **几何断言别靠眼睛**：读 `getBoundingClientRect()`（`read_picked_element` 或 `browser_evaluate`），不要凭截图判断「宽度变了」。
- **记录**：每次冒烟后在对应计划/关账记录的「冒烟」小节写入四要素：① 范围清单（逐项 ✅/❌/跳过+理由）；② 操作路径（点击/输入序列）；③ 证据（浏览器状态 + CLI 输出互证）；④ 未覆盖项与后续计划（如有）。

## 技术栈

- **路由** — web-next：App Router（Server Components + API Routes）
- **语言/构建** — TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）；库包直出 TS 源码（`main` 指 `./src/index.ts`），由 Next 的 `transpilePackages` 编译
- **测试** — vitest 4（node / jsdom 双配置）
- **UI** — antd 6 + React 19；`splitter` 与 `flex` 的语义见上文「已知坑」
- **数据** — SWR 2；契约 zod 3
- **源码一律 ESM** — `require()` 被 `baseConfig` 与 `withBoundary` 两处规则禁止（`tsc` 与 eslint 的边界规则都拦不住它，Vitest 的 SSR runner 还会注入模块级 `require`，故必须显式禁）
