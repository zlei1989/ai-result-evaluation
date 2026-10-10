# AGENTS.md

用中文交流。

## 约束

- 写 Next.js 代码前先读 `apps/web-next/node_modules/next/dist/docs/` 的相关指南（当前版本有训练数据未覆盖的破坏性变更）
- 写 UI 前先用 context7 查组件用法；界面与布局用 `antd`，适配 `light` / `dark` 与弹性尺寸；样式只走 antd 的主题 token / 紧凑密度 / 语义 `styles`——不手写字号、不手调行内边距、不裸写 `div` 等原始标签
- 提交逐个显式 `git add <路径>`，**禁止 `git add -A`**；`git status` 里不属于你的文件保持原样
- 改完代码按序执行 `pnpm typecheck` → `pnpm lint`，修完所有错误再进代码审查；格式修复随本次改动一并提交
- 新增回归守卫必须做**变异验证**：把要拦的缺陷人为制造回去、确认守卫失败、再还原并核对文件哈希。没见过失败的守卫不算守卫
- **遇到厂商智能体的运行期问题就追加一条 FAQ**（报错、卡死、行为与预期不符、环境差异导致的假绿都算）：先把问题修掉，再按下面的格式写进对应文件。**发现即记录，逐步攒成知识库**
- **调智能体只有 `agentProvider.run` 一个入口**（`getProvider(kind).run(input)`，即 `@aieval/agents` 的 `AgentProvider`）：包外不许自己 spawn 厂商 CLI、不许深路径 import `providers/*`、也不许再包一层「跑一次」的门面。**`run` 不够用就扩展 `run` 本身**，不是绕开它；**扩展前先澄清**：要加什么、现有形状为什么不够、动到哪几家与哪些消费方、旧数据怎么读——讲清楚并得到确认再动手
- `pnpm dev` 端口被占用时先 kill 占用进程再启动

## 厂商适配 FAQ（发现即追加）

三家各一份，问题按厂商归档：

| 厂商 | 文件 |
|------|------|
| Codex（`@openai/codex` / `codex app-server`） | `docs/faq/codex.md` |
| Claude Code（`@anthropic-ai/claude-agent-sdk`） | `docs/faq/claude-code.md` |
| DeepSeek Harness（`@deepseek-ai/dsh-sdk-client`） | `docs/faq/deepseek-harness.md` |

每条四格，**缺一不可**：

1. **现象** —— 做成二级小标题，**照抄日志/界面里的原文**（含报错码、英文原句）。下次拿报错原文一搜就能命中；改写成自己的话就搜不到了。
2. **日期** —— `YYYY-MM-DD`。
3. **根因** —— 说到机制层（哪一层、哪个键、哪次替换、谁先谁后）。**没定位到就写「未定位」**并留下下一步，不要写「可能」当结论。
4. **解决方案** —— 改了哪个文件/哪个键、判据是什么（守卫名、命令、变异结果）。改不动的就写「未闭合」并说明代价。

有外部资料（官方文档、issue、协议说明）就补第 5 格**相关资料**，附链接。

两条维护规矩：
- **同一现象只留一条**：修法与事实冲突时**改旧条目**，不要新开一条并列。
- **测试环境 ≠ 运行环境**：凡是「单测绿、真机红」的（打包器改写、解析器差异、子进程环境差异），根因里必须点名差异在哪，避免下一个人再信一次单测。

## 知识库

`docs/` 原位构建 VitePress 知识库：`pnpm docs:dev` 起本地站浏览，`pnpm docs:build` 构建并重新生成 `docs/public/llms.txt`。知识按五域组织，**接任务先按域找文章，别全仓扫描**：

| 域 | 位置 | 收什么 |
|----|------|--------|
| 协议规范 | `docs/protocols/` | providers 抽象与 run 入口、消息与事件、进程生命周期、新增 SDK 接入流程、三家厂商接入与横向对比 |
| 功能说明 | `docs/features/` | 按功能模块组织的现时行为说明；目录层《功能总览》 |
| 架构设计 | `docs/architecture/` | 分层与依赖方向、契约体系、界面原语与主题、工具链与命令聚合 |
| FAQ | 三份厂商 FAQ 原文 + 目录层 `docs/faq/index.md`《故障索引》 | 运行期问题按报错原文索引，可 grep |
| 规约守卫 | `docs/guard/`；另有 PowerShell / Playwright MCP 两份活文档原文编入（`docs/guard/powershell.md`、`docs/guard/playwright-mcp.md`） | 密钥与环境变量、冒烟方法论、变异验证、测试策略 |

- **AI 读口径**：路径稳定、文件可 grep、本节指针可导航；`docs/public/llms.txt`（构建期由 `docs/.vitepress/build-llms.mjs` 按 `pages.mjs` 生成，全站页面清单 + 一句话摘要）是**副产品**判据，不是主判据。
- **关账回写（ADR 0001）**：关账时把设计决策与冒烟证据直接回写进对应知识文章的小节，**不再新增过程档案**，过程可追溯性交给 git 历史；FAQ 追加条目时同步《故障索引》目录层，少一条即未关账。

## 目录结构

1 个下游应用 + 服务端/客户端两层，职责严格分离（架构见 `docs/architecture/layering.md`，知识库入口见「知识库」节）：

```text
apps/web-next/     Next.js 薄组装；路由只做「zod 校验、调 api、错误映射」
packages/server/
  core/            git CLI 原语、配置落盘、路径校验；只用 Node 内置 + contracts
  agents/          智能体抽象层 + 三家适配器（Claude Code / Codex / DSH）；唯一允许引厂商 SDK 的包，
                   对外只暴露 provider 注册表，差异吸收在 providers/<kind>/
  evaluator/       编排状态机 + 评分器 + 事件落盘；不碰框架、不碰具体 SDK
  api/             功能服务层，一个功能一个文件；禁止 import 任何框架
  contracts/       zod schema + 领域类型 + 错误码
packages/client/
  ui/              纯展示组件（base + composite），纯数据驱动、不调接口
  client/          SWR hooks + HTTP 原语，类型全部来自 contracts
docs/ 知识库（五域 + FAQ 与规约守卫活文档，见「知识库」节）
docs/guard/powershell.md   PowerShell 的事实与硬规则（删除守卫、编码坑）
docs/guard/playwright-mcp.md   Playwright MCP 的 filename 路径规则与冒烟口径
docs/faq/  三家厂商 FAQ（发现即追加，格式见上）+ 目录层《故障索引》
eslint.shared.ts   共享规则 + 分层边界规则（withBoundary）
```

## 依赖方向

```text
web-next → api / core / ui / client / contracts
api      → evaluator / agents / core / contracts
evaluator→ agents / core / contracts
agents   → core / contracts
ui       → contracts
client   → contracts
contracts→ 无（只依赖 zod 这类第三方；指回任何 @aieval/* 都是环）
core     → contracts
```

表是**真源**，由 `apps/web-next/src/package-dependency-boundaries.test.ts` 逐条比对每个包的 `package.json`：新增或删除跨包依赖必须同时改表和清单，只改一处测试就红（`pnpm lint` / `pnpm typecheck` 查不出这种错位）。

- **类型转出不算依赖边**：`@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型，编译期即被抹掉，故表里不列这行、ui 放 `devDependencies`。只允许 `export type`；写成值导出就真有运行时依赖，得回来改表。
- `apps/web-next/vitest.config.ts` 的 `resolve.alias` 把 evaluator 指向源码，只为让路由测试的 `vi.mock` 生效，只活在测试期。别改成 devDependency（会动 `pnpm-lock.yaml`，还会装进一条运行时可解析的依赖边）。

## 删除与 PowerShell 安全

> PowerShell 的通用规则（自动变量禁令、`Assert-Deletable` 完整实现、编码与 `Get-Content` 坑）见 `docs/guard/powershell.md`。

- **禁止**把 `$home` / `$profile` / `$env:USERPROFILE` / `$env:APPDATA` 等当临时变量：5.1 下报只读错，**pwsh 7 下却是静默成功**，于是 `Remove-Item $home -Recurse -Force` 会真的删掉用户目录。临时值一律用专属名 `$repoRoot` / `$tmpDir` / `$outPath`；判据是「有没有给自动变量赋值」，不是「上次跑报没报错」。
- **递归删除按序做三件事**：断言目标在允许根之下（用 `docs/guard/powershell.md`「递归删除」一节的 `Assert-Deletable`，允许根传 `$env:TEMP` 或本仓工作目录）→ 打印目标 → 执行；删除语句**不得**带 `-ErrorAction SilentlyContinue`。
- 能用现成的临时目录 API 就别手写递归删除（JS 用 `mkdtempSync`，PS 用 `New-TemporaryFile`）；也别指望 PSScriptAnalyzer 做静态门禁（本机未安装且装不上）。
- 本仓只有两个 PS 脚本：`scripts/bench-gates.ps1`、`packages/server/agents/probe/v2/codex-cli-plan.ps1`，改动靠人工审。`scripts/bench-gates.ps1:28` 用 `Invoke-Expression` 执行命令串，**调用方只能传字面量**。
- 已审计的永久删除点，别"顺手加守卫"：`scripts/split-test-file.mjs:202` 的 `rmSync(src)` 是拆完测试文件删原文件的有意行为；`packages/server/core/src/workspace.ts:124-126` 的三个 `rmSync` 分开写是刻意的（改前先读该处注释）。
- **网关 key 只能从环境变量读**：`packages/server/agents/probe/v2/lib/gateway.mjs:27` 仍把 key 硬编码在源码里（`codex-cli-plan.ps1` 已改成读 `AIEVAL_PROBE_GATEWAY_API_KEY`），改这里时必须改成读环境变量（该 key 需轮换）。

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | web-next 开发服务器（http://localhost:3083） |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 全量检查，一个进程覆盖 8 个包 |
| `pnpm format` | ESLint `--fix`（与 `lint` 同一条根配置） |
| `pnpm typecheck` | TypeScript 全链类型检查，一个 tsc 进程 |
| `pnpm test` | vitest 全量测试，一个进程收齐 8 个包 |
| `pnpm test:changed` | 只跑与改动相关的文件——**内循环用这个**，全量留给门禁 |

- 三条聚合命令**刻意不走 `pnpm -r`**（递归会给 8 个包各起一次进程）；聚合靠复用包级真源：根 eslint 配置前缀化 `boundaryConfigs()`、根 `vitest.config.ts` 用 `projects` 引用各包配置、根 `tsconfig.typecheck.json` 是各包 `include` 的并集。别退回 `pnpm -r`，也别把包级规则抄进根配置。
- 单包：`pnpm --filter @aieval/<包名> <脚本>`，与根命令结果必须一致。

## 测试

| 规则 | 说明 |
|------|------|
| 环境 | `vitest.node.ts`（库包与 web-next）/ `vitest.jsdom.ts`（`ui` 与 `client`）；纯函数测试标 `// @vitest-environment node` |
| **`.tsx` 测试只能在库包写** | `apps/web-next` 必须留 `jsx: preserve`，Vite 的 import-analysis 会报 `make sure to not set jsx to preserve`；改 vitest 的 `esbuild.jsx` / `esbuild.tsconfigRaw` 都无效 |
| 别名 | `apps/web-next` 的 `@/*` 指应用根目录；**vitest 不读 tsconfig 的 `paths`**，故在 `apps/web-next/vitest.config.ts` 显式给 `resolve.alias` |
| 根聚合的收集范围 | 根 `vitest.config.ts` 的 `projects` glob 收 `packages/{server,client}/*` 与 `apps/*`；新包自带 `vitest.config.ts` 即被收进来。**另有 docs 一条**：知识库守卫工程（`docs/vitest.config.ts`，读磁盘断言的 node 环境）以显式路径并列——docs 不是 workspace 包，glob 罩不到；改收集方式后核对全仓用例总数对它同样适用 |
| **`vi.mock` 逐文件重复** | 前置提升只作用于本文件：`orchestrator-*.test.ts` 每个文件都要自己写三条 `vi.mock`，漏一条会**静默** spawn 真厂商 CLI（守卫在 `packages/server/evaluator/src/static-assertions.test.ts`） |
| jsdom 的缺口 | `matchMedia` 由用例自己注入；`ResizeObserver` 桩在 `packages/client/ui/src/testing/resize-observer.ts`，**不放进共享 setup**（否则兜底分支再也测不到）；真实拖拽不可达（容器尺寸 0），`Splitter` 的 `onResize` 回写要在真实调用方处钉 |
| 测试预算 | `TEXT_API_RETRY` / `ROW_RETRY` 写成可变对象：`beforeEach` 读产品默认值再改小、`afterEach` 还原，默认值要有独立用例钉住；`until` 的第 4 参 `impossible` 只给**终态期望**用；所有等待上限按「宁可超时也不假红」定 |
| 跑法与提速 | 单包 `pnpm vitest run packages/server/<包>`、单文件 `pnpm vitest run <文件路径>`、改动相关 `pnpm test:changed`，**全量留给门禁**。计价单位是**进程创建**：夹具用 `beforeAll` 模板 + `cpSync`、缓存预热（`prewarmCaseCache`）、产品侧合并 git 往返；墙钟由最长的文件决定（按文件并行），长杆文件按 describe 拆开 |
| 机器带负载时 | 用 `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000`；先看 `tests` 累积项，比上次大 2 倍以上就别把红当回归 |

## 注释

- TS/TSX 用 JSDoc；中文，简洁，专业的口语，先说"做什么"再说"怎么做"
- 文件头写明职责与注意事项；嵌套 > 2 层必须注释业务含义
- 方法、条件分支、事件处理、数据转换等独立功能单元都要说明业务目的与关键逻辑；重要方法注释算法思路
- 环境判断、响应处理等特殊处理要注释原因；密度在同文件内保持一致

## 日志

| 级别 | 场景 |
|------|------|
| ERROR | 业务异常、外部调用失败 — 必须打印堆栈和业务上下文 |
| WARN | 降级、重试、超时、配置缺失但可继续 |
| INFO | 请求入口、关键状态变更、外部调用耗时 >500ms |
| DEBUG | 分支走向、中间变量、循环关键节点（生产默认关闭，`AIEVAL_DEBUG=1` 打开） |

必须打日志的点位：请求入口（INFO + 标识）、外部调用（DEBUG 参数 + INFO 耗时）、异常捕获（ERROR + 堆栈 + 上下文）、关键分支（DEBUG + 依据）。

日志器是 `@aieval/core` 的 `createLogger(scope)`；**上下文作为 `console` 的第二个参数透传，不要 `JSON.stringify`**（循环引用或 BigInt 会抛，日志器不该能打断业务流程）。

## 持久化

- 配置目录：`AIEVAL_CONFIG_DIR` > `~/.aieval`；测试用 `setConfigDirForTesting(dir)` 指向临时目录，**不得触碰真实 `~/.aieval`**
- **用例目录是第二处「默认根在真实家目录下」**：`settings.casesRoot` > `AIEVAL_CASES_ROOT` > `~/.aieval-cases`，一用例一文件（`<id>.json`）；测试用 `setCasesRootForTesting(dir)`——`setConfigDirForTesting` **管不到**它，夹具动手前先查 `getCasesRootOverrideForTesting()`（详见 `docs/features/storage.md` 的《用例目录》）
- **写盘必须原子**：写临时文件（创建即 `0600`）→ `renameSync` 覆盖；不要先删目标再 rename（中间崩溃会让配置彻底消失，而 `loadConfig()` 会静默回落默认值）
- rename 的 `EPERM` 有两种成因、处置相反：目标是只读文件（只能先删）与杀软瞬时占用（重试即可）。用 `statSync(file).mode & 0o200` 区分，别无脑先删
- **读盘必须容忍 UTF-8 BOM**（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json` 默认带 BOM，`JSON.parse` 遇到就抛）；自己落盘不要产 BOM
- 配置损坏时抛**含路径的中文原因**，别让 `SyntaxError` 冒充「请求体不是合法 JSON」

## 边界与工具链的已知坑

| 坑 | 正确做法 |
|----|----------|
| `pnpm-workspace.yaml` 的 `allowBuilds` | pnpm 11 必需（`sharp` / `unrs-resolver`）；写进 `onlyBuiltDependencies` 不再生效 |
| flat config 的规则是**整体替换**不是选项合并 | `withBoundary` 会整条盖掉 `baseConfig` 的 `no-restricted-syntax`——两处各放一份（共用同一常量对象） |
| 边界规则管不到的三种写法 | `no-restricted-imports` 管不到动态 `import()` / `require()`，要另配 `no-restricted-syntax` 且选择器按说明符过滤（裸 `ImportExpression` 会禁掉合法的代码分割）；`import-x/no-relative-packages` 要补 `settings['import-x/resolver'].node.extensions`，否则 `resolve()` 失败时静默 return；`escapeRegExp` 必须转义 `/`，漏了 ESLint 直接以退出码 2 崩溃 |
| 紧凑密度**不显式写 `fontSize`** | `compactAlgorithm` 会覆盖并反向推导，实效字号掉到 10px；只给 `fontSizeSM: 11`（产出 12 / 11 / 14） |
| antd 6 `Button` 的 `variant` **单给不生效** | 须与 `color` 成对给（`color="default" variant="dashed"`）或改用 `type` 语法糖；单给 `variant="dashed"` 会**静默**渲染成实线 |
| 主题必须**三处同步** | `ConfigProvider theme` + `html[data-theme]` + `ConfigProvider.config({ holderRender })`，缺一处就是半亮主题 |
| `Splitter` 的尺寸用受控 `size` | 不用 `defaultSize`；受控下拖拽必须把 `onResize` 回写进 `size`，否则松手弹回；弹性列不给 `size`。唯 `SplitPane` 原语用 `defaultSize`（它不支持刷新后还原拖过的宽度） |
| `Flex` 的 `display` / `flex-direction` 走 CSS 类 | 内联 `style` 读不到；结构性不变量要自己写进内联 style |
| `next-env.d.ts` | 已 gitignore；忽略它只能写在 `boundaryConfigs('web-next')` 里，散写在 `apps/web-next/eslint.config.ts` 的裸条目会被根路径漏掉 |
| PowerShell 5.1 的 `Get-Content` 读 UTF-8 文件 | 见 `docs/guard/powershell.md`「读写文件与编码」：无 BOM 时按 ANSI 解码，中文乱码且**行号少算** |
| 根 `eslint .` 的边界规则必须**按目录前缀化** | 否则 core 的禁用名单会落到全部包（web-next 被误伤成「禁止 import react」）；前缀化在 `scopeToDir()`。改完做**双向变异验证**：core 里写 `import 'react'` 要报错、web-next 里同样的 import 不报错 |

## 冒烟测试

- 启动真实服务（web-next :3083），用 mcp 按真实用户路径逐项操作（输入、按钮、弹窗、导航、拖拽），并用 CLI 复核落盘事实（配置文件、git 分支与 diff），页面与磁盘互证。
- **几何断言别靠眼睛**：读 `getBoundingClientRect()`（`read_picked_element` 或 `browser_evaluate`），不要凭截图判断。
- MCP 浏览器工具的 `filename` 路径规则与几何断言见 `docs/guard/playwright-mcp.md`。
- 每次冒烟后在对应计划/关账记录的「冒烟」小节写入四要素：范围清单（逐项 ✅/❌/跳过+理由）、操作路径、证据（浏览器 + CLI 互证）、未覆盖项与后续计划。
- 冒烟记录按关账回写纪律熔炼进知识文章（ADR 0001）。

## 技术栈

- **路由** — web-next：App Router（Server Components + API Routes）
- **语言/构建** — TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）；库包直出 TS 源码（`main` 指 `./src/index.ts`），由 Next 的 `transpilePackages` 编译
- **测试** — vitest 4（node / jsdom 双配置）
- **UI** — antd 6 + React 19；**数据** — SWR 2 + zod 3 契约
- **源码一律 ESM** — `require()` 被 `baseConfig` 与 `withBoundary` 两处规则禁止（`tsc` 与 eslint 的边界规则都拦不住它，Vitest 的 SSR runner 还会注入模块级 `require`，故必须显式禁）
