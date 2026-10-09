# AI 生成代码评测工具 —— 脚手架设计（初始化项目）

日期：2026-09-22
状态：**已实现**（2026-09-24 复核；由本文档生成实施计划 `../plans/2026-09-22-scaffold.md`）。
**2026-10-08 按当前实现逐节复核并回写**：文中所有内联代码块、配置、文件清单与依赖方向都已与磁盘核对；
脚手架之后各功能域的落地改变了哪些事实，逐条记在受影响小节里，本轮更正清单见 §12 第 5 条。
凡本文与实现冲突处**以实现为准**——本文是脚手架阶段的契约记录，不再是当前仓库的完整描述。
范围：**只做框架**。搭好 monorepo、分包、界面原语、主题、列表 + 右边栏示例页，使后续三个功能域可以并行往上填。
配套文档：功能设计见同目录 `2026-09-22-features-design.md`；实施计划见 `../plans/2026-09-22-scaffold.md`（本 spec 是它的上游依据，对应关系见 §12）。
性质：本文档**自包含**——技术栈、脚手架配置、界面原语的实现契约与关键代码全部内联，实施时不需要参照任何外部仓库。

**章节分工**：本文档只讲**脚手架本身**（包结构、配置、界面原语、示例页、最小服务端连通性、测试口径）；
建立在它之上的一切**功能面**（智能体评分与结构化评分输出、评分标准项、远端 git 来源、上下文窗口与思考强度、
单行执行与重新评分、评测的修改与删除、变更详情抽屉、测试墙钟、子智能体用量与轮次口径）见
`2026-09-22-features-design.md`。新功能先读本文档 §4.1 的依赖方向，再读功能设计的对应小节。

---

## 1. 本文档要交付什么

一句话：**一个能跑起来的空壳 + 一个证明空壳可用的列表示例**。

具体交付物：

1. pnpm monorepo，8 个包全部建好，分层边界生效（越界 import 直接报错）。包内 `eslint.config.ts` 走 `withBoundary`，仓库根 `eslint.config.ts` 走同一个工厂导出的 `workspaceConfig`（见 §5.4）。
2. Next.js 应用在 `:3083` 起得来，顶栏可见可点。顶栏三项的顺序是**评测 / 用例 / 设置**（`apps/web-next/src/nav.ts` 的 `NAV_ITEMS`）。**顶栏不含主题切换**——主题的唯一入口在设置页（见 §6.10）。
3. 亮/暗双主题落地，**三处消费点同步**（组件、CSS 底色、静态 portal），跟随系统开关即时生效。
4. 界面原语就位：`PageShell`、`SplitPane`、`ResizableColumns`、`stored-preference`、紧凑密度、空态等。
5. **一个列表示例页**：左侧列表 + 右侧可拖拽宽度详情栏，宽度刷新后还原 —— 用来证明第 2–4 项真的能用。（**该页现已删除**，见下方说明与 §7。）
6. `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令全绿。

**明确不做**（属于功能阶段。**这四条是脚手架期的范围限定，不是对当前仓库的描述**——四条现在都已有落地，见每条的「现状」）：

- 任何真实业务数据。示例页用内存里的假数据，不落盘、不调接口。**现状**：用例/供应商/评测全部落盘（`~/.aieval/config.json` + 工作区目录），示例页已删除。
- 供应商 / 用例 / 评测三个功能域。**现状**：三域都已打通到界面（`/api/providers`、`/api/cases`、`/api/runs`）。
- 三个智能体适配器、编排状态机、评分器、SSE 流。**现状**：三家适配器在 `agents` 包，编排与评分在 `evaluator`，逐行/消息两条 SSE 已落地。
- 任何 `/api` 路由（除 `/api/settings` 这一条用于验证连通性的最小接口）。**现状（2026-10-08）**：`apps/web-next/app/api/**/route.ts` 已有 23 条（cases 5 / providers 4 / runs 13 / settings 1）。

**示例页是过渡产物（已按本段约定删除）**：功能阶段实现真实用例管理页时，删除 `/demo` 路由。它的价值在于把「原语能不能组合出目标形态」这件事在写业务之前就验证掉——尤其是右边栏的可拖拽宽度与刷新还原，这类问题越晚发现返工越贵。

**现状（2026-10-08 复核）**：`/demo` 三件套（`app/demo/page.tsx`、`src/testing/demo-fixtures.ts`、`ui` 包的 `composite/demo-list-page.tsx`）已在功能阶段交付（`8130b80`）里按 `../plans/2026-09-22-features-p2-cases.md` Task 9 一并 `git rm`，`ui` 包的 `index.ts` 也去掉了它的出口；`apps/web-next/src/nav.test.ts` 有一条「不含 `/demo`」的守卫钉住这件事。本文里凡是提到示例页的地方（主要在 §7 与 §4.2、§4.3、§6.4、§6.5、§6.8、§6.9，另见 §9–§12 的变更记录）都只作**历史记录**读——当前仓库里没有 `/demo` 路由，也没有 `DemoListPage`。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 包管理 | pnpm（workspace，`preinstall` 强制只允许 pnpm） |
| 框架 | Next.js 16（App Router：Server Components + Route Handlers） |
| 语言 | TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`；包级 `tsc --noEmit`，根上一条 `tsc -p tsconfig.typecheck.json` 覆盖 8 个包，见 §5.2） |
| UI 组件库 | antd 6 + `@ant-design/icons` |
| 数据层 | SWR 2（REST）——脚手架期只用它做 GET/PUT；EventSource（SSE）当时属功能阶段，**现已落地**（逐行日志/消息流），见 `client` 包的 `row-stream.ts` |
| 契约 | zod 3（运行时校验 + 类型推导，服务端与客户端共享） |
| 测试 | vitest 4 + node（纯函数）/ jsdom（组件） |
| 智能体接入（脚手架之后） | 三家厂商 SDK：`@anthropic-ai/claude-agent-sdk` / `@openai/codex` / `@deepseek-ai/dsh-sdk-client`——**import 只发生在 `agents` 包内**，且必须在 `next.config.ts` 的 `serverExternalPackages` 里外置（§5.9）。**注意「只在 agents 包内」是 import 口径，不是声明口径**：`apps/web-next/package.json` 的 `dependencies` 里也各有一份（版本区间与 `agents` 逐字相同），否则运行期会在产物目录 `.next/server/chunks/` 里按裸说明符定位时 `MODULE_NOT_FOUND`——pnpm 的隔离布局只把链接放在 `packages/server/agents/node_modules/`。这条由 `apps/web-next/src/runtime-deps.test.ts`（契约 R35）钉住 |
| 样式 | **一律走 antd**：主题 token / 紧凑密度 / 语义 `styles`。不引入 Tailwind 等工具类框架；不手写字号；不手调行内边距；避免裸写 `div`（antd 无「可滚动通用盒子」原语时除外，需在注释中写明理由） |

端口：**开发 3083**（`next dev -p 3083`）；**`next start` 是 3080**（`apps/web-next/package.json` 的 `start` 脚本，2026-10-07 的功能阶段交付里由 3083 改成 3080）。文档、冒烟与验收一律以 **3083** 为准，`pnpm start` 那一条是另一个端口。

---

## 3. 关键决策与理由

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| S1 | 严格分层分包：`contracts`（只依赖 zod）/ `core` / `agents` / `evaluator` / `api`（禁框架）+ `ui` + `client` | 边界即架构：`core` 只依赖 `contracts` 与 Node 内置模块，可独立测试，`api` 不碰框架，`ui` 不调接口。三个智能体 SDK 是重量级外部依赖，单列 `agents` 才不会污染 `core` / `evaluator` 的边界 | 单应用平铺（改一处牵动全身，无法对 `core` 做隔离测试） |
| S2 | 只做一个 Next.js 应用，后端收敛进 Route Handlers | 少一个应用的重复装配；该形态足以撑住百级路由 | 双下游应用（多一份重复装配，收益为零） |
| S3 | 脚手架阶段就把 8 个包全部建好（含空实现） | 边界规则只有在「包真实存在」时才被 eslint 校验；后补包会导致边界被一次性冲击。空包成本近零 | 先建用到的包、按需增包（分层约束形同虚设） |
| S4 | 偏好记忆放 localStorage，URL 只记视图状态 | 栏宽是**个人显示偏好**（怎么读界面），不是「在看什么」——同一份链接发给别人时不该把自己的栏宽带过去 | 全部放 URL（链接共享时串味）；全部放 localStorage（深链接无法还原看的是哪一条） |
| S5 | 边栏宽度用「像素偏好 + 按可用宽比例还原」而非百分比 | 窗口变窄时若不做比例还原，`Splitter` 只能硬夹到 `min`，栏间比例会跳变 | 存百分比（像素语义更直观、夹紧边界更好表达）；不做还原（刷新回到旧值） |
| S6 | 错误模型在脚手架阶段定型（错误码 + HTTP 映射 + 专属请求体标记类型） | 后续所有路由都依赖它，晚定会各处自拼 HTTP 错误、文案与状态码必然漂移 | 各路由自行拼错误响应 |

> S6 那三件事（错误码 / HTTP 映射 / 专属请求体标记类型）的**载体不都在同一个包里**：错误码与映射在 `contracts`（`ERROR_CODES` / `STATUS_BY_CODE` / `httpStatusFor`，`ServiceError` 也在那儿），而标记类型 `InvalidRequestBodyError` 在路由层的 `apps/web-next/src/server-context.ts`（`contracts` 不含任何请求对象的概念）——见 §8 第 1 条。
> 另：功能阶段又加了一族**独立的** `AgentErrorCode`（agents 包的领域归因），它**不进** `ERROR_CODES`，否则 `STATUS_BY_CODE` 得为它编造 HTTP 状态码。「一次定型」指接口层的错误码。

---

## 4. 仓库与分包结构

```
ai-result-evaluation/                    # 包名前缀 @aieval/*
├── apps/
│   └── web-next/            # Next.js 16 薄组装：页面壳 + Route Handlers（dev :3083 / start :3080）
├── packages/
│   ├── server/
│   │   ├── contracts/       # zod 契约 + 错误码（脚手架期：错误模型 + Settings 契约）
│   │   ├── core/            # 基础能力：只依赖 contracts 与 Node 内置，禁框架（脚手架期：logger + config-store + paths）
│   │   ├── agents/          # 智能体抽象层（脚手架期：空出口 `export {}`）
│   │   ├── evaluator/       # 编排与评分（脚手架期：空出口 `export {}`）
│   │   └── api/             # 业务服务层，禁框架（脚手架期：settings 读写）
│   └── client/
│       ├── ui/              # 纯展示组件（base + composite）+ 测试用 testing/，不调接口
│       └── client/          # 数据层（脚手架期：http 四函数 + useSettings）
├── docs/                    # superpowers/{specs,plans,notes} + powershell.md / playwright-mcp.md / 三家厂商 FAQ
├── scripts/                 # 开发脚本（`bench-gates.ps1`、`split-test-file.mjs`、`slice-describe.mjs` 等）
├── README.md                # 项目说明
├── AGENTS.md                # 协作约束 + **依赖方向表（本仓依赖方向的真源，见 §4.1）**
├── eslint.config.ts         # 仓库根 ESLint 配置（引 `eslint.shared` 的 `workspaceConfig`）
├── eslint.shared.ts         # 共享规则 + `withBoundary` / `workspaceConfig` 分层硬约束
├── vitest.config.ts         # 仓库根 Vitest 配置（用 `projects` 一次收齐 8 个包）
├── vitest.node.ts           # 纯函数测试的共享配置（node）
├── vitest.jsdom.ts          # 组件测试的共享配置（jsdom + setup）
├── tsconfig.base.json
├── tsconfig.typecheck.json  # 各包 include 的并集（近似，未含 web-next 的 instrumentation.ts，见 §5.2），`pnpm typecheck` 的入口
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── .editorconfig
├── .gitignore
└── package.json
```

**各包职责一句话**（脚手架期 → 现状）：

| 包 | 脚手架期 | 现状（2026-10-08） |
|---|---|---|
| `contracts` | 错误模型 + Settings 契约 | 另含 provider / case / run / score / rubric / agent-message 等全部跨端契约 |
| `core` | logger + config-store + paths | 另含 git 原语、mirror（远端）、workspace、event-log、message-log |
| `agents` | 空出口 `export {}` | provider 注册表 + 三家适配器（Claude Code / Codex / DSH） |
| `evaluator` | 空出口 `export {}` | 编排状态机 + 评分器 + 事件落盘 |
| `api` | settings 读写 | 另含 cases / providers / runs 等功能服务 |
| `client` | http 四函数 + `useSettings` | 另含 cases / providers / runs / 行流（SSE）等 hooks |

### 4.1 依赖方向（硬约束）

**这张表的真源是仓库根的 `AGENTS.md`「依赖方向」一节**——`apps/web-next/src/package-dependency-boundaries.test.ts` 逐条比对每个包的 `package.json`：`dependencies` 里既不许出现表外的内部包，也不许漏表里的边（只改一处测试就红，`pnpm lint` / `pnpm typecheck` 都查不出这种错位）。本文件不另抄一份清单，下面这份只是同源镜像：

```
web-next → api / core / ui / client / contracts
api      → evaluator / agents / core / contracts
evaluator→ agents / core / contracts
agents   → core / contracts
ui       → contracts
client   → contracts
contracts→ 无（只依赖 zod 这类第三方；指回任何 @aieval/* 都是环）
core     → contracts
```

`web-next` 的路由**只做三件事**：zod 校验请求 → 调 `api` → 错误映射。业务逻辑一律不下沉到路由文件。

两条易错点：

- **`api → agents` 是后来加的边**（脚手架期只有 `evaluator / core / contracts`）：`api/src/runs.ts` 要读 provider 注册表——`getProvider(agentKind)` 拿厂商元数据、`acceptsProtocol` / `protocolMismatchMessage` 校验「这一行选的智能体能不能配这家供应商的协议」，以及按注册表元数据过滤可选的供应商列表（判据不硬编码在 api 里）。
- **类型转出不算依赖边**：`@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型，编译期即被抹掉，故表里**不列**这行，`ui` 放 `client` 的 `devDependencies`（判据由上面那条守卫的第三条钉住：写回 `dependencies` 就红）。

### 4.2 各包在脚手架阶段的实际内容

「内容」列记的是**脚手架阶段**的产出（历史事实，不改）；**「依赖（生产）」列按当前 `package.json` 校正过**——它是硬约束，必须与 §4.1 的表逐字对齐。

| 包 | 脚手架阶段内容 | 依赖（生产，现状） |
|---|---|---|
| `contracts` | `ERROR_CODES` / `httpStatusFor` / `ServiceError`；`SettingsSchema` / `SettingsPatchSchema` / `DefaultJudgeSchema` / `ThemeModeSchema` / `SETTINGS_DEFAULTS` + 类型 | zod |
| `core` | `logger`（`createLogger(scope)`，DEBUG 运行时读 `AIEVAL_DEBUG`）；`config-store`（原子写 + BOM 容忍 + 创建即 0600 + 缺失字段归一化 + 损坏抛含路径中文原因；`AppConfig`（`settings` / `providers` / `cases` 三段）在此定义，**领域类型直接复用 `contracts` 的 `Provider` / `TestCase`**）；`paths`（`expandHome` / `defaultWorkspaceRoot` / `resolveRootForRead` 只展开不碰磁盘 / `validateWorkspaceRoot` 真写探针） | `contracts` |
| `agents` | 空出口 `export {}`——**接口定义与假适配器都推迟到功能阶段**（脚手架期没有消费者，写了就是死代码） | `contracts` / `core`（现另有三家厂商 SDK，见 §4.1 与各包 `package.json`） |
| `evaluator` | 空出口 `export {}` | `agents` / `contracts` / `core` |
| `api` | `getSettings` / `updateSettings`（读取只展开不校验、改根目录才校验、`saveConfig` 的裸 errno 折成带配置目录的中文 `INTERNAL`） | `agents` / `contracts` / `core` / `evaluator` |
| `ui` | §6 的全部原语 + `composite/app-top-nav.tsx`（顶栏）+ `composite/demo-list-page.tsx`（示例页展示组件，**已随示例页删除**）+ `testing/`（setup、ResizeObserver 桩） | `contracts` / `@ant-design/icons` / antd / react / react-dom / `react-diff-viewer-continued` / `react-markdown` / `remark-gfm` |
| `client` | `http` 四函数（`getJson` / `postJson` / `putJson` / `delJson`）、`useSettings` | `contracts` / react / react-dom / swr（`@aieval/ui` 只在 `devDependencies`，理由见 §4.1） |
| `web-next` | SSR 壳、`providers`、顶栏、`/cases`、`/runs`、`/demo`（**已删除**）、`/settings`（脚手架期仅主题项，现为四个 Tab）、`/api/settings`、`src/server-context.ts`（路由层错误出口） | **只是 §4.1 里 web-next 那一行的 5 条**（api / core / ui / client / contracts）+ next / react / react-dom / antd / `@ant-design/icons` / swr / zod，另加三家厂商 SDK 作为运行时依赖（见 §5.9）。**没有** `agents` / `evaluator`——写「全部」是错的 |

### 4.3 脚手架阶段的文件清单（计划「文件结构总览」的主体）

生成计划时按这份清单取文件全文；`*` 表示同名加 `.test.ts(x)` 的测试文件。

**这是一份历史清单**：它记的是脚手架阶段（`4775171`）的产出。功能阶段交付（`8130b80`）之后**删除的条目**在行内标出（`/demo` 三件套）；**新增的只作行内脚注、不作为条目补进来**——例如注了 `eslint.config.ts` / `vitest.config.ts` / `tsconfig.typecheck.json`、`nav.test.ts`、`match-media.ts`，而 `instrumentation.ts`、`app/dev/agent-log/page.tsx`、另外 22 条 API 路由则完全不在表内。**当前**全仓结构以 §4 的树与 `AGENTS.md` 的目录结构为准。

> 与计划里的「文件结构总览」**不完全等同**：计划的总览还列了 `README.md / AGENT.md`（注明「非本计划产出，随脚手架一并提交」），本清单只收「要按本 spec 生成全文」的文件，故不含它们。

```
ai-result-evaluation/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.shared.ts
├── vitest.node.ts  vitest.jsdom.ts  .editorconfig  .gitignore
│   # ↑ 这 8 个是脚手架期的**根配置/源文件**（README.md、AGENT.md〔现 AGENTS.md〕
│   #   与 pnpm-lock.yaml 同期也在，只是不属于「要生成全文」的口径）。
│   #   `eslint.config.ts` / `vitest.config.ts` / `tsconfig.typecheck.json` 是功能阶段新增的（`eslint .`、`pnpm test`、
│   #   `pnpm typecheck` 三条聚合命令改为「一个进程覆盖全仓」时才有）
├── apps/web-next/
│   ├── package.json  next.config.ts  tsconfig.json  eslint.config.ts  vitest.config.ts
│   ├── app/{layout.tsx,providers.tsx,globals.css,page.tsx}
│   ├── app/cases/page.tsx  app/runs/page.tsx  app/demo/page.tsx  app/settings/page.tsx
│   │   # app/demo/page.tsx —— **已删除**（功能阶段随用例页落地一并移除）
│   ├── app/api/settings/route.ts
│   ├── src/{index.ts（export {} 占位）,server-context.ts*,route-settings.test.ts,nav.ts}
│   │   # nav.ts 现有配套的 nav.test.ts
│   └── src/testing/demo-fixtures.ts          # **已删除**（随示例页一并移除）
├── packages/server/contracts/src/{index.ts,errors.ts*,settings.ts*}
├── packages/server/core/src/{index.ts,logger.ts*,config-store.ts*,paths.ts*}
├── packages/server/agents/src/index.ts   packages/server/evaluator/src/index.ts
├── packages/server/api/src/{index.ts,settings.ts*}
└── packages/client/
    ├── ui/src/index.ts
    ├── ui/src/base/{theme-resolve.ts*,app-theme.tsx*,density.ts*,density-context.tsx,
    │                page-shell.tsx*,split-pane.tsx*,resizable-columns.tsx*,
    │                stored-preference.ts*,format.ts*,ellipsis-text.tsx*,empty-state.tsx*,
    │                toolbar.tsx*,list-detail-layout.tsx*}
    ├── ui/src/composite/{app-top-nav.tsx*,demo-list-page.tsx}
    │   # demo-list-page.tsx —— **已删除**（随示例页一并移除）
    ├── ui/src/testing/{setup.ts,resize-observer.ts}   # 现另有 match-media.ts（见 §6.12）
    └── client/src/{index.ts,http.ts*,settings.ts*,testing/setup.ts}
```

---

## 5. 脚手架配置（可直接落地）

> **读本节前先看这一条**：下面每个代码块都是对应文件的**逐字全文**（含注释原文），因此注释里的**计数与计时是写下时的实测值，现在多半已经过期**——例如「14.5s / 12s 启动税」「94 个文件本身不到 1s」（`eslint.shared.ts`）与「94 个源文件本身跑完不到 1s」（`eslint.config.ts`）、「`@aieval/contracts`（11 个纯函数测试文件）」「已核对全部 103 个测试文件」「口径与 **core 40s** / api 60s 一致」（`vitest.node.ts`——**core 现在也是 60s**）、「22.6s / 20s」（仓库根 `vitest.config.ts`）等。2026-10-08 的现状是 8 个包共 476 个 `.ts`/`.tsx`（含 gitignore 的 `next-env.d.ts`、排除 `probe/dumps`；`git ls-files` 口径是 475）、229 个测试文件。**照抄注释不要紧，但别把那些数字当现状引用**；要改数字得改源文件，本 spec 不代改。

### 5.1 `pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
  - packages/server/*
  - packages/client/*

# pnpm 11 要求对依赖的安装脚本逐个表态。sharp（Next 图像优化）与 unrs-resolver
# （eslint-plugin-import-x 的原生解析器）都放行，否则 install 以 ERR_PNPM_IGNORED_BUILDS 退出 1。
# 注意：pnpm 11 下把它们写进 onlyBuiltDependencies **不再生效**（实测仍报同一错误），必须用 allowBuilds。
allowBuilds:
  # 以下五项是 2026-09-25 装三家厂商 SDK（dsh 走 next 线 0.1.7-rc.1）时 pnpm 点名要求表态的
  # 传递依赖：pnpm 自己写入了占位值 "set this to true or false" 并以 ERR_PNPM_IGNORED_BUILDS 退出 1，
  # 这里按计划 Task 2 Step 3 的规则逐个置 true 以完成落位。它们都不是本仓的直接依赖。
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  koffi: true
  node-pty: true
  protobufjs: true
  sharp: true
  unrs-resolver: true

onlyBuiltDependencies:
  - esbuild
```

**现状（2026-10-08 复核）**：`allowBuilds` 已是 7 项，不是脚手架期那 2 项——多出来的五项是装三家厂商 SDK 时 pnpm 点名要求表态的传递依赖；`onlyBuiltDependencies` 里的 `esbuild` 仍在。

### 5.2 根 `package.json`

```json
{
  "name": "ai-result-evaluation",
  "version": "0.0.0",
  "private": true,
  "packageManager": "pnpm@11.18.0",
  "scripts": {
    "preinstall": "node -e \"if(!/pnpm/i.test(process.env.npm_config_user_agent||'')){console.error('[禁止] 本项目仅允许使用 pnpm 安装依赖，请运行: corepack enable && pnpm install');process.exit(1)}\"",
    "dev": "pnpm --filter @aieval/web-next dev",
    "build": "pnpm --filter @aieval/web-next build",
    "lint": "eslint . --cache --cache-location node_modules/.cache/eslint/",
    "format": "eslint . --fix --cache --cache-location node_modules/.cache/eslint/",
    "test": "vitest run --passWithNoTests",
    "test:changed": "vitest run --changed --passWithNoTests",
    "typecheck": "tsc -p tsconfig.typecheck.json"
  },
  "devDependencies": {
    "@stylistic/eslint-plugin": "^4.4.1",
    "@types/node": "^20.19.43",
    "@typescript-eslint/parser": "^8.61.0",
    "eslint": "^9.39.5",
    "eslint-plugin-import-x": "^4.17.1",
    "eslint-plugin-unused-imports": "^4.4.1",
    "jiti": "^2.7.0",
    "vitest": "^4.1.11"
  }
}
```

**三条聚合命令刻意不走 `pnpm -r`**（脚手架期曾写成 `pnpm -r lint` / `pnpm -r test` / `pnpm -r typecheck`，功能阶段改掉了）：

- `lint` / `format`：仓库根 `eslint.config.ts` 引 `eslint.shared.ts` 的 `workspaceConfig`，**一个进程**覆盖全部 8 个包（`pnpm -r` 会给 8 个包各起一次 Node + 重新加载 TS parser 与三个插件，实测 14.5s 里约 12s 是启动税，94 个源文件本身不到 1s）。
- `test`：仓库根 `vitest.config.ts` 用 `projects` 引用各包的 `vitest.config.ts`，同样一次启动收齐 8 个包。
- `typecheck`：仓库根 `tsconfig.typecheck.json` 是**各包 `include` 的并集**（7 个库包的 `src` + web-next 的 `next-env.d.ts` / `app` / `src` / `.next/types`），一个 `tsc` 进程跑完。**注意它没列 web-next 的 `instrumentation.ts`**（该应用自己的 tsconfig 里有），实际仍被检查到——`src/instrumentation.test.ts` 以 `@/instrumentation` 导入它。所以「并集」是近似说法，别拿它当「与各包 include 逐项相等」的依据。

包级真源仍在各包自己的配置里（根配置只做引用与前缀化），故 `pnpm --filter @aieval/<包> <脚本>` 与根命令结果一致。`test:changed` 供内循环使用（只跑与改动相关的文件），全量留给门禁。

### 5.3 `apps/web-next/package.json`

```json
{
  "name": "@aieval/web-next",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3083",
    "build": "next build",
    "start": "next start -p 3080",
    "lint": "eslint .",
    "format": "eslint . --fix",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@aieval/api": "workspace:*",
    "@aieval/client": "workspace:*",
    "@aieval/contracts": "workspace:*",
    "@aieval/core": "workspace:*",
    "@aieval/ui": "workspace:*",
    "@ant-design/icons": "^6.3.2",
    "@anthropic-ai/claude-agent-sdk": "^0.3.281",
    "@deepseek-ai/dsh-sdk-client": "0.1.7-rc.1",
    "@openai/codex": "^0.156.1",
    "antd": "^6.6.3",
    "next": "16.2.7",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "swr": "^2.5.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^20.19.43",
    "@types/react": "^19.2.7",
    "@types/react-dom": "^19.2.3",
    "jsdom": "^25.0.1",
    "typescript": "^5.9.3",
    "vitest": "^4.1.11"
  }
}
```

`start` 的端口与 `dev` 不同（3080 / 3083），三家厂商 SDK 是功能阶段才进 `dependencies` 的运行时依赖——它们要定位自身的 CLI / 原生二进制，故还必须进 `next.config.ts` 的 `serverExternalPackages`（见 §5.9）。

`@aieval/agents` / `@aieval/evaluator` **都不在这个 `dependencies` 里**（§4.1 的表里 web-next 只有 5 条边），它们只出现在两处**不建依赖边**的地方：`next.config.ts` 的 `transpilePackages` 名单（那是「要编译哪些 workspace 包」，两个都在），以及 `vitest.config.ts` 的测试别名（**只有** `evaluator`——理由见 §5.8）。route 测试里 `vi.mock('@aieval/evaluator')` 能在不改清单的前提下生效，靠的正是后者。

统一脚本口径：**7 个库包**只有 `lint`（`eslint .`）、`format`（`eslint . --fix`）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run --passWithNoTests`）——**库包没有 `build`**（它们直出 TS 源码，由 Next 的 `transpilePackages` 编译）；只有 `apps/web-next` 有 `dev` / `build`（`next build`）/ `start`。

**7 个库包的 `package.json` 必须声明 `main` / `types` / `exports` 指向 `./src/index.ts`**（否则 Next 与 vitest 解析不到）；`apps/web-next` 是应用，**不写**这三项。

### 5.4 `eslint.shared.ts` 的分层边界工厂

边界由 eslint 硬约束，不靠口头约定。`withBoundary(pkg)` 把「每包一份禁止 import 名单」展开成 `no-restricted-imports` 的 `patterns.group`。**必须用 `patterns.group` 而不是 `paths.name`**——后者是精确匹配，`next/*` 这类条目会被 `next/headers` 这样的子路径绕过。

实现里另有四条**不能省**的加固，每条都对应一条真实绕过路径（都实测过）：

1. **`no-restricted-imports` 覆盖不到动态 `import()` 与 `require()`**（它只看静态 import/export 语句）。故另配 `no-restricted-syntax`，且选择器**必须按说明符过滤**（`ImportExpression[source.value=/…/]`、`CallExpression[callee.name="require"] > Literal.arguments:first-child[value=/…/]`——注意 `name` 的值用**双引号**：外层字符串被 `@stylistic/quotes` 钉死成单引号，内层再写单引号就得转义；esquery 对两种引号等价）；裸 `ImportExpression` 会把包自己的 `import('./x')` 一起禁掉，挡住合法的代码分割。
2. **相对路径跨包引用是盲区**：`import '../../../client/ui/src/index'` 既不是包名、也不在禁止名单里，而本仓所有库包直出 TS 源码，这种写法**真的能跑通**。用 `import-x/no-relative-packages` 关掉；但该规则内部的 `resolve()` 默认只认 `.js`/`.json` 等扩展名，**必须在 `settings['import-x/resolver'].node.extensions` 里补 `.ts`/`.tsx`**，否则它对 TS 说明符解析失败会静默 `return`——规则看着开着，却从不触发。该规则还要对 `**/{eslint,vitest,next}.config.{ts,tsx}` 豁免（它们必须相对引用仓库根配置，而根 `package.json` 自带 `name`），豁免名单**按文件名限定死**，不能写成 `**/*.config.{ts,tsx}`。
3. **源码一律 ESM，仓库里不允许 `require()`**：`tsc`（`@types/node` 声明了 `var require`）、边界规则、Vitest 的 SSR runner 三处都不拦它，只能显式禁。该常量必须在 `baseConfig` 与 `withBoundary` 的 `no-restricted-syntax` 里**各放一份**：flat config 对同一条规则是**整体替换**而不是选项合并，`withBoundary` 生成的对象排在后面且匹配同一批文件，会把 `baseConfig` 那条整条盖掉。
4. **`escapeRegExp` 必须转义 `/`**：禁止名单里的 `@aieval/client` 会被拼进 esquery 选择器的 `/…/` 字面量，漏转义会提前闭合字面量，ESLint 直接以**退出码 2 崩溃**。

```ts
/**
 * 共享 ESLint flat 配置 + 分层边界规则工厂。
 * 边界即架构：core/agents/evaluator/api/contracts 禁框架；ui 禁 client/api/apps；client 禁 apps。
 * 注意：禁止名单用 `patterns.group` 展开而不是 `paths.name`——后者是精确匹配，
 * `next/*` 这类条目会被 `next/headers` 这样的子路径绕过。
 *
 * 导出两个入口，共用同一份 `boundaryConfigs()`，因此**不存在抄两遍漂移**：
 * - `withBoundary(pkg)`：包内 `eslint.config.ts` 用，glob 相对包根；
 * - `workspaceConfig`：仓库根 `eslint.config.ts` 用，把每个包的 glob 前缀到自己的目录，
 *   于是 `eslint .` 在根上跑**一个**进程就能覆盖全仓（8 个包各起一个进程时，
 *   实测 14.5s 里有 12s 是 8 次 Node + 插件加载的启动税，94 个文件本身不到 1s）。
 */
import type { Linter } from 'eslint';
import stylistic from '@stylistic/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import tsParser from '@typescript-eslint/parser';

export type PackageName =
  | 'core' | 'agents' | 'evaluator' | 'api' | 'contracts' | 'ui' | 'client' | 'web-next';

/** 各包禁止 import 的模块名（精确名或带 * 的通配名） */
const FORBIDDEN: Record<PackageName, string[]> = {
  core: ['next', 'next/*', 'react', 'react-dom'],
  // agents 允许三家 agent SDK 与 HTTP 客户端，但同样不许知道框架与 React 的存在
  agents: ['next', 'next/*', 'react', 'react-dom'],
  evaluator: ['next', 'next/*', 'react', 'react-dom'],
  api: ['next', 'next/*', 'react', 'react-dom'],
  contracts: ['next', 'next/*', 'react', 'react-dom'],
  ui: ['@aieval/client', '@aieval/api', '@aieval/web-next', 'next', 'next/*'],
  client: ['@aieval/web-next'],
  'web-next': [],
};

/** 各包在仓库中的目录（相对仓库根，用 `/` 分隔）：根配置据此把包级 glob 限定到对应目录 */
const PACKAGE_DIRS: Record<PackageName, string> = {
  core: 'packages/server/core',
  agents: 'packages/server/agents',
  evaluator: 'packages/server/evaluator',
  api: 'packages/server/api',
  contracts: 'packages/server/contracts',
  ui: 'packages/client/ui',
  client: 'packages/client/client',
  'web-next': 'apps/web-next',
};

/**
 * 源码一律 ESM：仓库里不允许出现 `require()`。
 * 为什么必须显式禁止：三处都不拦它——`@types/node` 声明了 `var require` 所以 tsc 过、
 * 边界规则的 no-restricted-syntax 只按禁止说明符过滤所以 eslint 过、
 * Vitest 的 SSR runner 会给模块注入一个模块级 require 所以运行时也过。
 * 实测在 api 包里写 require('node:os') 能 12/12 全绿通过，就是这条规则要拦的情形。
 *
 * 做成常量是因为它必须在**两个** no-restricted-syntax 数组里各出现一次（baseConfig 一处、
 * withBoundary 一处）：flat config 对同一条规则是**整体替换**而不是选项合并，withBoundary
 * 生成的对象排在 baseConfig 之后、匹配同一批文件，会把 baseConfig 的这条整个盖掉。
 * 同一段中文文案抄两遍正是最容易漂移的写法，所以只留这一份真源。
 *
 * 选择器里 `callee.name` 的值用双引号包：外层字符串被 `@stylistic/quotes` 钉死成单引号，
 * 内层再写单引号就得转义；esquery 对两种引号完全等价，故让内层改用双引号。
 */
const esmOnlyRequire: { selector: string; message: string } = {
  selector: 'CallExpression[callee.name="require"]',
  message: '源码一律 ESM：改用 import（仓库内不允许 require）',
};

export const baseConfig: Linter.Config[] = [
  // 生成物一律不 lint。`**/probe/dumps/**` 这一条是**必须显式写**的（2026-10-01 实测）：
  // 它在 `.gitignore` 里（探测 dump 可能含网关返回的敏感原文，不入库），而 **ESLint 的 flat config
  // 不读 `.gitignore`**（只默认忽略 `node_modules`）⇒ 两者的忽略集合本来就不一致。
  // 后果不是「多扫几个文件」：真机探针会把第三方插件模板整棵克隆进 `probe/dumps/**`，
  // 里面就有 `.ts`（实测一次 63 个）⇒ `pnpm lint` 从 0 报错变成 **14050 条**（几乎全是
  // 「Strings must use singlequote」这类对着别人的模板发的报错），一条门禁指令就这样被一次探测跑红。
  // 口径：**凡是 `.gitignore` 里以「生成物」为由忽略的目录，只要可能落 `.ts`/`.tsx`，都要在这里再写一遍。**
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/out/**', '**/coverage/**', '**/probe/dumps/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tsParser },
    plugins: { '@stylistic': stylistic, 'import-x': importX, 'unused-imports': unusedImports },
    // import-x 内置的 node 解析器默认只认 ['.mjs', '.cjs', '.js', '.json', '.node']，不含 TS；
    // 本仓所有包都直出 TS 源码、import 说明符又按 TS 习惯不带扩展名，于是下面那条
    // `no-relative-packages` 内部的 resolve() 会解析失败并**静默 return**（规则源码第 18–22 行）。
    // 实测：只开规则不加这段 settings 时，`import '../../../client/ui/src/index'` 仍以退出码 0 通过。
    // 补上 TS 扩展名，这条边界规则才真的会开火。
    settings: {
      'import-x/resolver': {
        node: { extensions: ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.json'] },
      },
    },
    rules: {
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/indent': ['error', 2],
      'unused-imports/no-unused-imports': 'error',
      'import-x/no-duplicates': 'error',
      // 相对路径的跨包 import 是边界规则的一个盲区：no-restricted-imports 只看模块说明符，
      // 而 `../../client/ui/src/index` 这种写法（本仓所有包都直出 TS 源码，所以它真的能跑通）
      // 既不是包名、也不在禁止名单里，会以零信号绕过分层。这一条把相对路径的跨包引用一并关掉。
      'import-x/no-relative-packages': 'error',
      // 仓库级：源码一律 ESM，任何 require() 都不允许（理由见 esmOnlyRequire 的 JSDoc）。
      // 注意它只对 FORBIDDEN 为空的包（web-next）真正生效：其余包的 withBoundary 会用
      // 自己的 no-restricted-syntax 把它整条替换掉，故那边必须再放一份。
      'no-restricted-syntax': ['error', esmOnlyRequire],
    },
  },
  // 各包根部的 eslint.config.ts / vitest.config.ts / next.config.ts 必须相对引用仓库根的
  // 共享配置（`../../../eslint.shared`、`../../../vitest.node`，见 brief Step 10），而仓库根
  // package.json 自带 name，会被上面那条规则判成「引用了另一个包」。这些文件既不发包、
  // 也不会被任何包的源码 import，不构成分层绕过路径，故豁免。
  // 豁免名单必须**按文件名**限定死，不能写成 `**/*.config.{ts,tsx}`：那样是任意深度匹配，
  // `packages/server/core/src/foo.config.ts` 这类产品模块会被顺带豁免掉，
  // 跨包相对引用又能零信号通过——实测过，退化成「对老实人有效」。
  {
    files: ['**/{eslint,vitest,next}.config.{ts,tsx}'],
    rules: { 'import-x/no-relative-packages': 'off' },
  },
];

/** 边界违规时的报错文案：必须指明是哪个包、禁了什么、去哪看规则 */
function boundaryMessage(pkg: PackageName, name: string): string {
  return `[分层边界] ${pkg} 禁止 import ${name}（见 docs/superpowers/specs/2026-09-22-scaffold-design.md §4.1）`;
}

/**
 * 把禁止名单展开为 no-restricted-imports 的 patterns 组：
 * 精确名匹配自身，非通配名另加「名/*」子路径组；已带 * 的保持通配。
 */
function toGroups(pkg: PackageName, names: string[]): Array<{ group: string; message: string }> {
  return names.flatMap((name) => {
    const message = boundaryMessage(pkg, name);
    if (name.endsWith('*')) return [{ group: name, message }];
    return [
      { group: name, message },
      { group: `${name}/*`, message },
    ];
  });
}

/** 按包名生成带边界约束的配置（与 baseConfig 合并使用；glob 相对**包根**） */
export function withBoundary(pkg: PackageName): Linter.Config[] {
  return [...baseConfig, ...boundaryConfigs(pkg)];
}

/**
 * 仓库根配置：`eslint .` 一次覆盖全仓，取代「每个包各起一个 eslint 进程」。
 * 做法是把每个包的边界配置**限定到该包的目录**：包内那条匹配任意深度 ts/tsx 的
 * `files` glob，前缀后变成 `packages/server/core/` 下面的同款 glob。包与包之间目录
 * 不重叠，flat config 的「后者整体替换前者」因而永远不会跨包误伤。
 *
 * `baseConfig` 只放一次且**不加前缀**：它自带的那条 ignores-only 对象是仓库级忽略
 * （忽略任意深度的 node_modules / dist / .next 等），按包前缀化反而会把忽略范围
 * 缩到各包内部。
 */
export const workspaceConfig: Linter.Config[] = [
  ...baseConfig,
  ...(Object.entries(PACKAGE_DIRS) as Array<[PackageName, string]>).flatMap(([pkg, dir]) =>
    scopeToDir(dir, boundaryConfigs(pkg)),
  ),
];

/**
 * 把包级配置里的 `files` / `ignores` 前缀到包目录。
 * 只处理后两个键：其余键（rules / plugins / languageOptions / settings）与路径无关，原样透传。
 *
 * 包级 glob 只有两种形态，前缀化对二者都保持语义：
 * - 以 `**` 开头的「任意深度」glob —— 拼上包目录后就是「该包目录下的任意深度」；
 * - 以 `**` 开头的相对精确路径（web-next 的 `next-env.d.ts`）—— 拼上包目录后
 *   正好是相对仓库根的该文件路径。
 */
function scopeToDir(dir: string, configs: Linter.Config[]): Linter.Config[] {
  return configs.map((config) => {
    const scoped: Linter.Config = { ...config };
    if (config.files) scoped.files = config.files.map((pattern) => `${dir}/${pattern}`);
    if (config.ignores) scoped.ignores = config.ignores.map((pattern) => `${dir}/${pattern}`);
    return scoped;
  });
}

/**
 * 包级边界配置（不含 baseConfig）。glob 相对包根，故既能被包内 `eslint.config.ts`
 * 直接导出，也能被 `workspaceConfig` 前缀化后复用。
 */
function boundaryConfigs(pkg: PackageName): Linter.Config[] {
  const names = FORBIDDEN[pkg];
  const configs: Linter.Config[] = [
    // next dev / next build 生成的类型声明：内容是双引号的三斜线引用与指向 .next/ 的相对
    // import，既不由本仓维护（文件头自述「should not be edited」）也已被 gitignore，
    // 故不纳入 lint。放在包级配置里而不是根配置里，是为了 `pnpm --filter @aieval/web-next lint`
    // 与根 `eslint .` 两条路径都覆盖到（根路径下这条会被前缀化成 apps/web-next/next-env.d.ts）。
    ...(pkg === 'web-next' ? [{ ignores: ['next-env.d.ts'] }] : []),
  ];
  if (names.length === 0) return configs;
  // 说明符必须整串等于某个禁止名，或等于「禁止名 + / 至少一个字符」（子路径）。
  // `^…$` 锚定是必要的：没有它 `react` 会顺带匹配 `react-dom`。
  const forbiddenSpecifier = `^(${names
    // 名称里的正则元字符先转义（`@aieval/client` 的 `/`、`next/*` 的 `*` 都要按字面处理）
    .map((name) => escapeRegExp(name.replace(/\/\*$/, '')))
    .join('|')})(\\/.+)?$`;

  return [
    ...configs,
    {
      files: ['**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: toGroups(pkg, names).map(({ group, message }) => ({ group: [group], message })),
          },
        ],
        // no-restricted-imports 的访问器只覆盖静态 import / export 语句（ImportDeclaration、
        // ExportNamedDeclaration、ExportAllDeclaration、TSImportEqualsDeclaration），
        // **不看动态 import，也不看 require** —— 实测 `() => import('react')` 与
        // `require('react-dom')` 在 core 里都能以退出码 0 通过 lint。
        // 故这里显式补上这两种绕过路径；漏了它，边界就只是「对老实人有效」。
        //
        // 选择器必须按**说明符**过滤，不能用裸的 `ImportExpression` /
        // `CallExpression[callee.name='require']`：那样会连同包自己的 `import('./x')`、
        // `require('./m')` 一起禁掉，既挡住 ui/client 之后要做的 React.lazy 代码分割，
        // 又给出与包名无关的误导文案。
        'no-restricted-syntax': [
          'error',
          // 这一条在 baseConfig 里已经有了，这里**必须再放一遍**：flat config 对同一条规则是
          // 整体替换而非选项合并，本对象排在 baseConfig 之后且匹配同一批文件，只用边界那两条
          // 会把 baseConfig 里的 ESM 禁 require 整条盖掉。实测（core/src/index.ts 里写
          // `require('react-dom')`）：不重复这一条时只剩边界规则的 1 条报告，而
          // `require('node:os')` 这类非禁止模块会**一条都不报**——正是这条规则要堵的盲区。
          esmOnlyRequire,
          {
            selector: `ImportExpression[source.value=/${forbiddenSpecifier}/]`,
            message: `[分层边界] ${pkg} 禁止动态 import 该模块（${names.join(' / ')}）`,
          },
          {
            selector: `CallExpression[callee.name="require"] > Literal.arguments:first-child[value=/${forbiddenSpecifier}/]`,
            message: `[分层边界] ${pkg} 禁止 require 该模块（${names.join(' / ')}）——require 不受 import 规则约束`,
          },
        ],
      },
    },
  ];
}

/** 转义正则元字符：禁止名单里的 `@aieval/client`、`next/*` 都要按字面匹配 */
function escapeRegExp(input: string): string {
  // `/` 必须一起转义，不能省：这条正则最终被拼进 esquery 选择器的 `/…/` 字面量
  // （`[source.value=/…/]`）。`/` 在 RegExp 里不是元字符，所以常见的 escapeRegExp
  // 实现都漏掉它；可一旦漏掉，`@aieval/client` 的 `/` 会**提前闭合字面量**，
  // esquery 抛 `Invalid regular expression: /^(@aieval/: Unterminated group`，
  // ESLint 直接以退出码 2 崩溃——ui / client 两个包的禁止名单里都有 `@aieval/*`，
  // 必然踩中（core 这类名单里没有 `/` 的包反而看不出来）。转义成 `\/` 后语义不变。
  return input.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
```

`baseConfig` 另含统一格式规则；包内 `eslint.config.ts` 只调 `withBoundary('包名')`，仓库根 `eslint.config.ts` 只导出 `workspaceConfig`（两者共用同一个 `boundaryConfigs()`）：

| 规则 | 值 | 说明 |
|---|---|---|
| `@stylistic/quotes` | `single` | 单引号 |
| `@stylistic/semi` | `always` | 语句末尾分号 |
| `@stylistic/indent` | `2` | 两空格缩进 |
| `unused-imports/no-unused-imports` | error | 禁未使用导入 |
| `import-x/no-duplicates` | error | 禁重复导入 |
| `import-x/no-relative-packages` | error | 禁跨包相对引用 |
| `no-restricted-syntax` | error | 禁 `require()`（ESM 口径） |

`baseConfig` 的 `ignores`：`**/node_modules/**`、`**/dist/**`、`**/.next/**`、`**/out/**`、`**/coverage/**`、`**/probe/dumps/**`（最后一条是 2026-10-01 实测补的：**flat config 不读 `.gitignore`**，而真机探针会把第三方插件模板整棵克隆进那个目录，一次就能让 `pnpm lint` 从 0 报错变成 14050 条）。

### 5.5 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

各包 `tsconfig.json` 继承它并设自己的 `include`（7 个库包：`extends: ../../../tsconfig.base.json` + `include: ["src"]`）。**库包不设跨包 `@/` 别名**：包内引用走相对路径，跨包引用走 `@aieval/*` 包名。

`apps/web-next/tsconfig.json` 是唯一例外：它保留 `"jsx": "preserve"`、`allowJs`、`incremental`、`plugins: [{ name: 'next' }]`，并配 `"paths": { "@/*": ["./*"] }`（`@/*` 指**应用根目录**，无 `baseUrl`）。**vitest 不读 tsconfig 的 `paths`**，所以 `apps/web-next/vitest.config.ts` 必须再给一份 `resolve.alias`（用 `import.meta.dirname` 推导，不用 `process.cwd()`，否则换 `--root` 时症状会变成「找不到模块」）；别名前缀要带结尾斜杠（`'@/'`），否则会把 `@aieval/*` 一起吃掉。

**`jsx` 必须是 `react-jsx`，不能是 `preserve`**：Vite 的 import-analysis 会直接读 tsconfig 的 `jsx`，一旦是 `preserve`，任何 `.tsx` 测试文件都以「Failed to parse source for import analysis … make sure to not set jsx to preserve」失败，而改 vitest 的 `esbuild.jsx` / `esbuild.tsconfigRaw` 都无济于事（报错来自 Vite 而非 esbuild）。**库包当然要写 React**（`ui` 里有 114 个 `.tsx`，`client` 里 7 个且**全是测试**），成立的只是「库包的 `tsc` 不需要 `preserve`」——库包的 `tsc` 只做 `noEmit` 类型检查，真正的 JSX 变换在**测试期**由 Vite / esbuild 做、在**构建期**由 Next 的 `transpilePackages`（SWC）做，`preserve` 只对 Next 自己编译**应用**代码有意义。`apps/web-next` 在自己的 `tsconfig.json` 里保留 `preserve`（Next 需要它），代价是该应用内不能写 `.tsx` 测试。

### 5.6 `.editorconfig`

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

### 5.7 注释与日志口径（全仓统一）

TS/TSX 用 JSDoc，**中文，简洁，先说「做什么」再说「怎么做」**：

| 位置 | 要求 |
|---|---|
| 文件头 | 文件职责 + 注意事项 |
| 嵌套 > 2 层 | 必须注释业务含义 |
| 功能点 | 方法、条件分支、事件处理、数据转换都需说明业务目的与关键逻辑 |
| 重要方法 | 必须注释算法思路或业务逻辑 |
| 特殊处理 | 环境判断、响应处理等需注释**原因** |
| 密度 | 同文件内保持一致 |

日志级别：

| 级别 | 场景 |
|---|---|
| ERROR | 业务异常、外部调用失败——必须打印堆栈和业务上下文 |
| WARN | 降级、重试、超时、配置缺失但可继续 |
| INFO | 请求入口、关键状态变更、外部调用耗时 >500ms |
| DEBUG | 分支走向、中间变量、循环关键节点（生产默认关闭） |

**必须打日志的点位**：请求入口（INFO + 标识）、外部调用（DEBUG 参数 + INFO 耗时）、异常捕获（ERROR + 堆栈 + 上下文）、关键分支（DEBUG + 依据）。

**日志器在 `@aieval/core` 的 `createLogger(scope)`**（`logger.ts`）：`debug` / `info` / `warn` / `error` 四个方法，前缀 `[级别] [scope] message`（上下文不进前缀）；`debug` 走 `console.log`、`warn` 走 `console.warn`、`error` 走 `console.error`。**上下文一律作为 `console` 的第二个参数透传，绝不 `JSON.stringify`**（后者遇到循环引用或 BigInt 会抛，而日志器不该有能力打断业务流程）。`DEBUG` 门控**每次调用时**读 `AIEVAL_DEBUG`（不是模块加载时读一次，否则测试里无法在同一进程内切换开关），值为 `'1'` 或 `'true'` 时开启。

### 5.8 vitest 双配置与各包的 `vitest.config.ts`

`vitest.node.ts`（纯函数 / 库包 / web-next）：

```ts
/**
 * 纯函数测试的共享配置：node 环境、不加载 DOM。各包 vitest.config.ts 直接复用它。
 *
 * `pool: 'threads'`：vitest 4 的默认池是 `forks`（每次起子进程），而本机的进程创建极贵——
 * 实测 `git --version` 350ms、`cmd /c exit 0` 250ms、`node -e ""` 400ms（企业杀软在进程
 * 创建上收税，与跑什么程序无关）。`threads` 用 worker_threads，免掉这层进程创建。
 * 实测 `@aieval/contracts`（11 个纯函数测试文件）：forks 3.4–4.1s → threads 2.25s。
 *
 * 为什么这里可以换、而本仓别处不敢换：本仓测试**不用** `process.chdir()`（worker 线程里
 * 不可用）、不用 `process.exit()`、不引原生模块——这三样正是 vitest 把默认池从 threads
 * 改回 forks 的原因（见 vitest 3 的迁移说明）。已核对全部 103 个测试文件与全部源码。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'threads',
    /**
     * 默认的 5s 太紧：本机的计价单位是**进程创建**（实测 `git --version` 566ms、`node --version` 530ms，
     * 企业 DLP/EDR 在每个新进程上挂钩），而本仓大量用例要真跑 git 子进程。全量并发下的实测后果是
     * **假红**：同一条用例独占跑 2s，满载时越过 5s 就报 `Test timed out in 5000ms`，
     * 而它要测的断言根本没被走到（2026-09-28 一次全量里 20 条红里绝大多数是这一类）。
     * 2026-09-28 取 **40s**：并发把单条用例放大 5–13 倍（`git.repo.test.ts` 一条独占 3.1s 的用例
     * 满载越过 40s），故按最坏倍数留余量。真正的死循环仍会被挡住（口径与 core 40s / api 60s 一致）。
     */
    testTimeout: 40_000,
    /**
     * `hookTimeout` 默认 **10s**，而本仓的共享 harness 在 `beforeAll` 里建**夹具模板**
     * （真仓库 `init` + `add` + `commit` + `rev-parse`，远端那套还要 `clone --bare`）。
     * 独占时只要 1–2s，但满载（15 worker 抢同一条进程创建管道）时实测越过 10s——
     * 后果不是某条用例红，而是**整个文件在 suite 级失败**：
     * `Error: Hook timed out in 10000ms` + 该文件所有用例被标 skipped
     * （2026-09-28 实测一次全量里 9 个文件、92 条用例这样整块掉队）。
     * 提到 60s：与 `testTimeout` 同一口径——真正的死循环仍会被挡住。
     */
    hookTimeout: 60_000,
  },
});
```

`vitest.jsdom.ts`（`ui` 与 `client` 包；组件测试）：

```ts
/**
 * 组件测试的共享配置：jsdom 环境 + setup（注册 jest-dom 断言、每个用例后清理 DOM）。
 * 注意：**不注入 matchMedia 桩**——jsdom 本身没有 `matchMedia`，而这正是主题模块
 * 「无 matchMedia 时按暗色」兜底路径要被覆盖的前提；需要模拟系统偏好的用例自己注入桩，
 * 见 `packages/client/ui/src/base/app-theme.test.tsx` 里那个用 `vi.fn()` 记调用的实现。
 *
 * `pool: 'threads'` 的理由与 `vitest.node.ts` 同源（本机进程创建约 250–400ms，forks 每次
 * 起子进程都在付这笔税；threads 用 worker_threads 免掉它）。jsdom 在 worker 线程里照常可用。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/testing/setup.ts'],
    pool: 'threads',
    /**
     * 理由与 `vitest.node.ts` 同源：全量并发下 5s 会让本来 1–2s 的组件用例变成
     * `Test timed out in 5000ms` 的假红（jsdom 渲染 + antd 组件树在满载时明显变慢）。
     * 2026-09-28 取 **40s**：jdom 这一档的余量最紧——`run-create-panel.test.tsx` 的用例独占 6s，
     * 并发下的放大倍数（实测 5–13 倍）会越过 20s。真正的死循环仍会被挡住。
     */
    testTimeout: 40_000,
    /** 理由与 `vitest.node.ts` 同源：钩子（组件测试里可能是异步准备）在满载时会越过默认的 10s */
    hookTimeout: 60_000,
  },
});
```

各库包的 `vitest.config.ts`：**5 个包一行转发**——`export { default } from '../../../vitest.node';`（`contracts` / `agents` / `evaluator`），`ui` / `client` 则指向 `../../../vitest.jsdom`（它们要 jsdom + setup）。

**另 2 个包不是一行转发**：`core` 与 `api` 用 `mergeConfig(base, defineConfig({ test: { testTimeout: 60_000 } }))` 各自把单用例超时放宽到 60s（12 / 11 行，带理由注释）——`core` 的用例真跑 git 子进程（一个用例 12 次进程、实测 4.0–4.7s），`api` 的 `cases.test.ts` 要造 25 次提交（75 次 git 进程、实测 18.3s），默认 5s 在满载时会变成假红。共享配置里的 40s 是**全仓基线**，这两处是在它之上的再加宽。

仓库根另有 `vitest.config.ts`：`pnpm test` 靠它用**一个**进程跑完全部 8 个包（逐包跑时每个包都要重新起 Node + 加载 Vite/vitest，实测 22.6s 里约 20s 是启动税）。它按**路径**引用各包的配置而不是内联配置对象——同一个包的测试范围写两遍必然漂移；用 glob 而不是写死 8 条路径，新增包只要落在 `packages/{server,client}/*` 或 `apps/*` 下且自带 `vitest.config.ts` 就会自动被收集，不会出现「新包没进根测试」的静默漏测：

```ts
/**
 * 仓库根 Vitest 配置：`pnpm test` 靠它用**一个**进程跑完全部 8 个包的测试。
 * 逐包跑（`pnpm -r test`）时每个包都要重新起 Node + 加载 Vite/vitest，实测 22.6s 里
 * 约 20s 是启动税——各包测试自身的 Duration 只有 600ms 上下。
 *
 * 各包自己的 `vitest.config.ts` 仍是**唯一真源**（environment、include、`@/*` 别名都在那边），
 * 根配置只负责「一次启动、把 8 个包都收集进来」，故这里按**路径**引用而不是内联配置对象：
 * 同一个包的测试范围写两遍必然漂移。`pnpm --filter @aieval/<包> test` 走的仍是包内那份配置。
 *
 * 用 glob 而不是写死 8 条路径：新增包时只要目录落在 `packages/{server,client}/*` 或 `apps/*`
 * 下、且自带 vitest.config.ts，就会自动被收集，不会出现「新包没进根测试」的静默漏测。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/server/*/vitest.config.ts',
      'packages/client/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
    ],
    /**
     * 并发档位：**不设上限**（vitest 默认 `availableParallelism() - 1`），理由是一条会随代码演化的实测。
     *
     * 2026-09-28 上午：本机（i7-1360P，4 性能核 + 8 能效核）的计价单位是**进程创建**
     * （`git --version` 566ms、`node --version` 530ms，企业 DLP/EDR 在每个新进程上挂钩），
     * 而当时全量里有两个 250–370s 的巨型文件（`cases.test.ts` / `mirror.test.ts`）在跑，
     * 15 路 worker 一起 spawn 会把单条用例放大 5–13 倍 ⇒ 假红一片。当时取 `maxWorkers: 8`：
     * 同一棵树实测 默认并发 307.0s / 20 红，8 路 343.5s / 8 红（拿 +12% 墙钟换 −60% 假红）。
     *
     * 2026-09-28 夜：长杆文件全部拆成 ≤80s 的小文件（`scripts/split-test-file.mjs` /
     * `slice-describe.mjs`），那个「巨型文件 + 高并发」的组合不复存在。同一份代码重测
     * core + evaluator（46 文件 / 409 用例）：
     *     6 路 156.7s / 8 路 150.5s / 12 路 129.9s / **15 路 125.4s**（四档全部 0 失败）
     * ⇒ 上限从 8 拿掉，回到默认。**若日后又出现巨型文件且伴随 `Test timed out` 假红，
     * 先拆文件，再把 `--maxWorkers` 调低当临时手段**（命令行覆盖永远赢过这里）。
     */
  },
});
```

`apps/web-next/vitest.config.ts` 必须用 `mergeConfig` 保留共享配置并补上 `@/*` 别名（理由见 §5.5）：

```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.node';

// `@/*` 指**本包根目录**（`apps/web-next/tsconfig.json` 的 `"@/*": ["./*"]`，无 baseUrl）。
// vitest 不读 tsconfig 的 paths，必须显式给一份 resolve.alias，否则 app/api/**/route.ts
// 在测试里解析不到 `@/src/server-context`（收集阶段就失败，路由层等于没有守卫）。
// 用配置文件自身的位置推导而不是 process.cwd()：否则以 `--root` 从别的目录调用时
// 别名会指向调用目录，症状是「找不到模块」而非「CWD 不对」，极难排查。
// 用 mergeConfig 保留共享配置的 environment / include，避免两处各写一遍。
const packageRoot = import.meta.dirname;

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        '@/': `${packageRoot}/`,
        // `@aieval/evaluator` **不在本应用的依赖里**（`AGENTS.md` 的方向表：web-next 只到
        // api / core / ui / client / contracts），于是它的裸说明符从 apps/web-next 解析不到任何文件。
        // 后果不是「报错」而是**静默失效**（实测，Task 10）：路由测试里的
        // `vi.mock('@aieval/evaluator')` 只能注册在**未解析的裸说明符**上，而 api 包内部那次
        // import 解析到真实源文件——两个 module id 不相等 ⇒ mock 一条都不生效，
        // 测试侧拿到 `vi.fn()` 的同时、api 侧仍在跑真实编排层（日志里出现 `[evaluator] 评测开始`，
        // 也就是真的会去 spawn agent 子进程）。
        // 这里只在**测试配置**里把说明符指向真实源文件，让两侧解析到同一个 id；它不建依赖边
        // （package.json 不动）、也不进运行时（`next build` / `next dev` 完全不读本文件）。
        '@aieval/evaluator': `${packageRoot}/../../packages/server/evaluator/src/index.ts`,
      },
    },
  }),
);
```

> 注：注释里的 **`spec §5.6.2`** 指的是**功能设计**（`2026-09-22-features-design.md` 的 §5.6.2「契约」，那里写「厂商包只作为运行时依赖」），**不是本文档**——本文档的 §5.6 是 `.editorconfig`，§5.9 才是这一节。（该注释原先写的旧文件名 `AGENT.md`，本 spec 只作说明、不代改代码；代码侧已在 2026-10-08 的注释清理里改成 `AGENTS.md`。）

### 5.9 `apps/web-next/next.config.ts`

7 个库包的 `main` 直接指向 `./src/index.ts`、不预构建产物，所以必须把 workspace 内的 TS 源码包纳入 Next 的编译；三家厂商 SDK 是**运行时依赖**（要定位自身的 CLI / 原生二进制），必须逐个外置到 `serverExternalPackages`，否则打进 server bundle 后定位会失效：

```ts
/**
 * Next 配置：把 workspace 内的 TS 源码包纳入编译。
 * 这些包的 `main` 直接指向 `./src/index.ts`，不预先构建产物——Next 靠 transpilePackages 编译它们。
 * 注意：厂商 SDK 是**运行时依赖**（spec §5.6.2）——它们要定位自身的 CLI / 原生二进制，
 * 被打进 server bundle 后定位会失效；故在 serverExternalPackages 里逐个外置。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@aieval/contracts', '@aieval/core', '@aieval/agents', '@aieval/evaluator', '@aieval/api', '@aieval/ui', '@aieval/client'],
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex',
    '@deepseek-ai/dsh-sdk-client',
  ],
  reactStrictMode: true,
};

export default nextConfig;
```

---

## 6. 界面原语（内联实现契约）

本节是界面层的唯一口径。每个原语都是**新写的实现**，代码在此给全——实施时照抄本节即可。

### 6.1 文档壳与全局样式

**`app/layout.tsx`**：`<html lang="zh-CN">` + `<body>` + `<Providers>`，引入 `globals.css`；导出 `metadata = { title: 'AI 代码评测', description: '…' }`。

**`app/globals.css`**：主题底色变量 + 盒模型复位。**只放这一层壳所需的复位与变量**——字号与间距一律由 antd 主题 token 与紧凑密度供给，不在此手调。（后来另加了两组动效类，见本节末尾。）

```css
/*
 * 全局样式：主题底色变量 + 盒模型复位。
 * 只放这一层壳所需的复位与变量——字号与间距一律由 antd 主题 token 与紧凑密度供给，不在此手调。
 * 主题变量口径（供 ui 包内联样式的 var() 消费）：
 *   --app-bg 页面底色 / --app-fg 正文色 / --app-border 分隔线 / --app-muted 次要文本 / --app-selected 选中行底色
 */
* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  height: 100%;
}

/* 暗色（默认，等价 antd darkAlgorithm 的容器底色观感） */
:root,
html[data-theme='dark'] {
  --app-bg: #141414;
  --app-fg: rgba(255, 255, 255, 0.85);
  --app-border: #303030;
  --app-muted: #888;
  --app-selected: #111a2c;
  color-scheme: dark;
}

/* 明亮主题：与 antd defaultAlgorithm 的容器底色一致 */
html[data-theme='light'] {
  --app-bg: #ffffff;
  --app-fg: rgba(0, 0, 0, 0.88);
  --app-border: #f0f0f0;
  --app-muted: #888;
  --app-selected: #e6f4ff;
  color-scheme: light;
}

html,
body {
  background: var(--app-bg);
  color: var(--app-fg);
}

/*
 * antd App 包装层承接 body 高度：页面根（height:100%）与内容区（flex:1 + minHeight:0）的高度链不能断。
 * 这个节点默认既不是 flex 容器也没有高度，链一断页面根就退化成内容高度、所有内部滚动随之失效
 *（表现为整页被内容撑长、该出现的滚动条不出现）。
 */
.ant-app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/*
 * 候选卡片底部的**活动行**高光扫过（类名由 ui 包的 `AgentActivityLine` 带上，样式只在这里定义）。
 * 做法与节奏照 DSH 的 `.turnStatus`（`ui-chat/src/client/chat/ChatView.module.css`：
 * 1.8s linear infinite、background-size 250%、`background-clip: text` 的渐变位移）——
 * 那是它「正在思考」那一行的观感，也是本仓「执行中」要的观感。
 * 颜色只用 `--app-muted` / `--app-fg` 两个**既有**主题变量：antd 主色由 ConfigProvider 在运行时给，
 * 在这里再抄一份就成了第二份真源，改主题时必漂移。
 */
.aieval-activity-sweep {
  background-image: linear-gradient(
    90deg,
    var(--app-muted) 0%,
    var(--app-muted) 40%,
    var(--app-fg) 50%,
    var(--app-muted) 60%,
    var(--app-muted) 100%
  );
  background-size: 250% 100%;
  background-position: 100% 0;
  background-clip: text;
  color: transparent;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: aieval-activity-sweep 1.8s linear infinite;
}

/* 扫到 0 = 高光从右往左走完一遍；起点由上面那条 `background-position: 100% 0` 承担（同 DSH） */
@keyframes aieval-activity-sweep {
  to {
    background-position: 0 0;
  }
}

/*
 * 系统「减少动态效果」下静止成一行动态文本：动效是装饰，不该对抗无障碍偏好
 * （DSH 对 `.turnStatus` 有同一条兜底）。**颜色必须一起还原**：上面的 `color: transparent` 是
 * 给渐变当画布用的，只关动画的话这一行会整行消失——比没有动效严重得多。
 */
@media (prefers-reduced-motion: reduce) {
  .aieval-activity-sweep {
    animation: none;
    background-image: none;
    background-clip: border-box;
    color: var(--app-muted);
    -webkit-text-fill-color: var(--app-muted);
  }
}

/*
 * 正文流末尾的闪烁光标（类名由 ui 包的 `TextBlockView` 带上，且只在 `assembly === 'open'` 时带）。
 * 用**伪元素**而不是往正文里插一个字符：`MarkdownText` 一行都不用改，光标也不会被复制进剪贴板
 * 或落进导出文本。`▍` 用 `--app-muted`，与正文同一个颜色体系。
 */
.aieval-stream-cursor::after {
  content: '▍';
  color: var(--app-muted);
  animation: aieval-stream-cursor 1s steps(1, end) infinite;
}

/* 一亮一灭：`steps(1, end)` 让它是硬切换而不是渐隐，「闪烁」的观感才成立 */
@keyframes aieval-stream-cursor {
  50% {
    opacity: 0;
  }
}

/* 减少动态效果时**保留光标**（它是「还没写完」这个事实的唯一可见信号），只是不再闪 */
@media (prefers-reduced-motion: reduce) {
  .aieval-stream-cursor::after {
    animation: none;
  }
}
```

`globals.css` 里除「壳所需的复位与变量」之外的两组规则（`.aieval-activity-sweep` / `.aieval-stream-cursor`）是**执行日志抽屉**落地时加的：类名由 ui 包带上、样式只在这一处定义（组件里不写 `@keyframes`）。它们同样只用既有的主题变量，故不构成第三处主题真源。

**关于变量注释里的「供 ui 包内联样式的 var() 消费」**：五个变量的**实际**消费点是——`--app-bg` / `--app-border` 在 ui 包的 `app-top-nav.tsx`（另外 `--app-bg` 还被 `globals.css` 的 `html, body` 规则用）；`--app-muted` / `--app-fg` 由 `globals.css` 自己消费（`html, body` 规则 + 两个动效类）；**`--app-selected` 的消费点在应用页**（`app/runs/page.tsx`、`app/cases/page.tsx` 的选中行底色），不在 ui 包——注释那句话是对早期形态的描述。

**`.ant-app` 这段高度链必须内联到位**：`PageShell` 用 `height: 100%`，而它的父级是 antd `<App>` 渲染出的 `.ant-app` 节点。该节点默认既不是 flex 容器也没有高度，链一断，页面根就退化成内容高度，所有内部滚动随之失效——表现为整页被内容撑长、该出现的滚动条不出现。

### 6.2 主题解析（`theme-resolve.ts` 纯函数 + `app-theme.tsx` hook）

**拆成两个文件**：与 React 无关的纯函数放 `packages/client/ui/src/base/theme-resolve.ts`（口径可被单测单独锁定），React hook 放同目录 `app-theme.tsx`。

**职责**：把偏好（`auto` / `light` / `dark`）解析成实际明暗 + antd 主题配置，并落文档根属性。

**契约**：`useResolvedTheme({ preference?, apply? }) → { mode, preference, themeConfig, holderRender }`；`mode` 是**解析后**的 `'light' | 'dark'`（类型上不是 `ThemePreference`）。

同文件另导出**读已解析明暗**的一对入口：`readAppliedThemeMode()` 与 `useAppliedThemeMode()`（后者用 `useSyncExternalStore` 订阅 `html[data-theme]` 的变化）。**消费方一律读这两个，不要再自行调一次 `useResolvedTheme()`**——不传偏好时它按 `'dark'` 兜底，既是第二份判据，其 `apply` 副作用还会把 `data-theme` 改回暗色，症状是「亮色主题下背景不对」。

**关键不变量：三个消费点必须同步，缺一处就会出现「组件亮了、底色还是暗的」的半亮主题**：

1. `<ConfigProvider theme={themeConfig}>` —— 组件层配色；
2. `html[data-theme]` —— CSS 底色变量与 `color-scheme`；
3. `ConfigProvider.config({ theme, holderRender })` —— 脱离 React 上下文的静态 `message` / `Modal`（portal 渲染）也要跟随同一主题。

**口径细节**：

- 偏好由**调用方从设置取后以 props 传入**——`ui` 包不调接口，故本模块不 import `client` 包。主题口径全仓只有这一处定义。
- `data-theme` 恒为**解析后**的 `light` / `dark`；`data-theme-preference` 保留偏好原值（`auto` 要能被区分出来，供排障与断言）。
- 偏好未就绪（设置还没拉到）**按暗色兜底**：默认观感，SSR 期不闪白。
- `auto` 在浏览器端订阅 `prefers-color-scheme` 变化**即时重解析**（无需刷新），并在卸载时清理监听。
- 无 `window`（SSR）/ 无 `matchMedia` 时 `readSystemDark()` 返回 `true`，与上述兜底一致，保证首帧不闪。
- `SYSTEM_DARK_QUERY` 必须导出（测试要按它断言 `matchMedia` 的查询串），且它就是 `'(prefers-color-scheme: dark)'`。

`packages/client/ui/src/base/theme-resolve.ts`：

```ts
/**
 * 主题解析的纯函数部分（与 React 无关，便于单测锁定口径）。
 * 口径：auto 跟随操作系统；无浏览器环境一律按深色——与服务端默认主题一致，SSR 期不闪白。
 */

/** 主题偏好：auto=跟随操作系统、light=明亮、dark=暗色 */
export type ThemePreference = 'auto' | 'light' | 'dark';

/** 系统深色偏好的媒体查询：auto 模式据此解析（浏览器端唯一判据） */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 读系统深色偏好；无 window / 无 matchMedia（SSR、老环境）按深色 */
export function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/** 偏好 → 实际明暗：auto 跟随系统，其余原样 */
export function resolveThemeMode(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (preference !== 'auto') return preference;
  return systemDark ? 'dark' : 'light';
}
```

`packages/client/ui/src/base/app-theme.tsx`：
```tsx
'use client';

/**
 * 应用主题解析：把偏好（auto/light/dark）解析成实际明暗 + antd 主题配置，并落文档根属性。
 *
 * **三个消费点必须同步，缺一处就会出现「组件亮了、底色还是暗的」的半亮主题**：
 *   ① <ConfigProvider theme>            —— 组件层配色
 *   ② html[data-theme]                  —— CSS 底色变量与 color-scheme
 *   ③ ConfigProvider.config({ holderRender }) —— 脱离 React 上下文的静态 message/Modal
 *
 * 口径：偏好由调用方从设置取后以 props 传入（ui 包不调接口，故不 import client 包）；
 * data-theme 恒为**解析后**的明暗，data-theme-preference 保留偏好原值（auto 要能区分出来）。
 */
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import type { ThemeConfig } from 'antd';
import { createElement, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './theme-resolve';

/**
 * 读**已经解析好**的实际明暗（`html[data-theme]`）。
 *
 * 为什么需要：`useResolvedTheme()` 的 `preference` 缺省是 `'dark'`（见下面 `rawPreference ?? 'dark'`，
 * 那是 SSR 期兜底、不闪白用的）。页面若再调一次 `useResolvedTheme()` 而不传偏好，就会拿到 `'dark'`——
 * 既是**第二份**主题判据，又与真正解析过的结果相反；它的 `apply` 副作用还会把 `data-theme` 改回暗色，
 * 于是 `ConfigProvider` 是明亮主题、组件却按暗色渲染（症状：「亮色主题下背景不对」）。
 *
 * 本文件的既有口径是「`data-theme` 恒为**解析后**的明暗」，故消费方直接读它，不再自行解析一次。
 * 无浏览器 / 属性缺失 / 属性是脏值时按暗色——与服务端默认一致，SSR 首帧不闪白。
 */
export function readAppliedThemeMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** `data-theme` 变化的订阅：`providers` 写完属性后通知所有消费方（设置页切主题即触发） */
function subscribeAppliedThemeMode(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * 跟随已解析明暗的 hook。用 `useSyncExternalStore` 而不是 `useState + useEffect`：
 * 后者首帧会先渲染兜底值再补一次，diff 正文会闪一下；前者在提交阶段就取到 DOM 上的真值。
 */
export function useAppliedThemeMode(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeAppliedThemeMode, readAppliedThemeMode, () => 'dark' as const);
}

export interface UseResolvedThemeOptions {
  /** 偏好原值；未就绪（设置还没拉到）按暗色兜底——默认观感，SSR 期不闪白 */
  preference?: ThemePreference;
  /** 是否把解析结果写进文档根与 antd 静态渲染器（默认 true） */
  apply?: boolean;
}

export interface ResolvedTheme {
  /** 实际生效的明暗（auto 已解析） */
  mode: 'light' | 'dark';
  /** 偏好原值，供排障与断言区分「跟随系统」与「显式指定」 */
  preference: ThemePreference;
  themeConfig: ThemeConfig;
  /** 静态 message/Modal 的 holderRender：脱离 React 上下文渲染时也要跟随同一主题 */
  holderRender: (node: ReactNode) => ReactNode;
}

export function useResolvedTheme({ preference: rawPreference, apply = true }: UseResolvedThemeOptions = {}): ResolvedTheme {
  const preference = rawPreference ?? 'dark';
  // 系统深色偏好：SSR/首帧无 window → 先按深色，挂载后立即解析并订阅变化
  const [systemDark, setSystemDark] = useState(readSystemDark);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const sync = (): void => setSystemDark(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const mode: 'light' | 'dark' = resolveThemeMode(preference, systemDark);
  const themeConfig: ThemeConfig = useMemo(
    () => ({ algorithm: mode === 'light' ? theme.defaultAlgorithm : theme.darkAlgorithm }),
    [mode],
  );
  const holderRender = useMemo(
    () => (node: ReactNode) => createElement(ConfigProvider, { theme: themeConfig }, createElement(AntdApp, null, node)),
    [themeConfig],
  );

  useEffect(() => {
    if (!apply) return;
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.themePreference = preference;
    ConfigProvider.config({ theme: themeConfig, holderRender });
  }, [apply, mode, preference, themeConfig, holderRender]);

  return { mode, preference, themeConfig, holderRender };
}
```

**`app/providers.tsx`**（`'use client'`）：取 `useSettings()` 的主题偏好喂给 `useResolvedTheme`，再依次包 `<ConfigProvider theme>` → `<DensityProvider mode>` → `<AntdApp>`。`AntdApp` 提供 `message` / `modal` 的上下文，是页面内调用 `message.error(...)` 的前提。

根 `ConfigProvider` 上还挂了两项**应用级**配置（功能阶段补的，缺一项就有一整类界面问题）：

- `locale={zhCN}`（`antd/locale/zh_CN`）：不配的话 antd 的内置文案全是英文（`Empty` 空图的 `<title>No data</title>`、`Modal` 关闭按钮的 `aria-label="Close"`、`Select` 的 `No data`、校验规则模板……）。显式中文文案不受影响——显式值优先于 locale 的默认值。
- `button={{ autoInsertSpace: false }}`：关掉「两个汉字之间插空格」（antd 默认把 `编辑` / `保存` 渲染成 `编 辑`），否则按钮的可访问名不再等于可见文案，按名字定位按钮会失配。

### 6.3 紧凑密度（`packages/client/ui/src/base/density.ts`）

全站「内容文字用小」的唯一定义点（设置页以 `density="default"` 豁免）。做法是把**明暗底色算法与紧凑算法组合成一条 `algorithm` 数组**——antd 的 `algorithm` 接受数组并按序应用，`[底色算法, compactAlgorithm]` 即「明暗正确 + 更紧凑」。

```ts
/**
 * 紧凑密度主题：全站「内容文字用小」的唯一定义点（设置页以 density="default" 豁免）。
 * 做法：antd 的 algorithm 接受数组并按序应用，[底色算法, compactAlgorithm] 即「明暗正确 + 更紧凑」。
 *
 * 两个不能改的地方（改了会静默出问题）：
 *   1. 绝不显式写 fontSize —— compactAlgorithm 会覆盖它：它取「基础算法派生出的 fontSizeSM」
 *      作为新基准再推导整档字号，于是 { fontSize: 12 } 的实效是 10px（比 antd 默认 14 还小）。
 *      实测：{ fontSizeSM: 11 } → 12/11/14（目标）；{ fontSize: 12 } → 10/8/12；
 *      {}（不传 token）→ 12/10/14。
 *   2. 间距与控件高度交给 compactAlgorithm，不重复手调 padding* / controlHeight 种子 token
 *      （与算法叠加会过度压缩）；lineHeight 也不动（缩小字号后行高比例已流体，动它易致行框局促）。
 */
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

/** 明暗模式（由 useResolvedTheme 解析应用设置得出） */
export type DensityMode = 'light' | 'dark';
/** 紧凑密度的字号 token：只给 fontSizeSM，其余两档交给 compactAlgorithm 派生 */
export const COMPACT_FONT_TOKENS = { fontSizeSM: 11 } as const;

/** 生成紧凑密度主题：algorithm 依赖明暗，故按 mode 参数化 */
export function compactTheme(mode: DensityMode): ThemeConfig {
  return {
    algorithm: [mode === 'light' ? theme.defaultAlgorithm : theme.darkAlgorithm, theme.compactAlgorithm],
    token: { ...COMPACT_FONT_TOKENS },
  };
}
```

**两个必须写进代码注释的坑**（否则后人会「顺手改坏」）：

1. **绝不能显式写 `fontSize`**。`compactAlgorithm` **会覆盖**传入的 `fontSize`——它取「基础算法派生出的 `fontSizeSM`」作为新基准再推导整档字号。实测矩阵：

   | 传入 token | 实效 fontSize / SM / LG |
   |---|---|
   | `{ fontSize: 12, fontSizeSM: 11, fontSizeLG: 14 }` | **10** / 11 / 14 ← 错误写法：覆盖失效，且比 antd 默认的 14 更小 |
   | `{ fontSizeSM: 11 }`（本设计） | **12** / 11 / 14 ← 设计目标 |
   | `{ fontSize: 12 }` | 10 / 8 / 12 |
   | `{ fontSize: 12, fontSizeLG: 14 }` | 10 / 8 / 14 |
   | `{}`（不传 token） | 12 / 10 / 14 |

   即**只有 `fontSizeSM: 11` 这一项**产出实效 12 / 11 / 14。

   > **复核这张表要用对方法**：必须是 `theme.getDesignToken({ algorithm: [底色算法, theme.compactAlgorithm], token })`。**直接调 `theme.compactAlgorithm(theme.defaultAlgorithm(token))` 会得到另一组数**（带 `fontSize` 的三行变 10/8/12，`{fontSizeSM:11}` 与 `{}` 两行变 NaN/NaN/NaN——`mapToken ?? …` 的派生链落空）——那条路子绕过了 antd 的 seed/alias 合并，与 ConfigProvider 实际下发的 token 不是一回事。2026-10-08 用 `getDesignToken` 逐行复跑，五行与上表逐个吻合（含 `{fontSize:12,fontSizeSM:11,fontSizeLG:14}` → 10/11/14）。**测试只覆盖了其中两行**：`density.test.ts` 完整钉住 `{fontSizeSM:11}` → 12/11/14（暗色与亮色各一遍），对 `{fontSize:12,fontSizeSM:11,fontSizeLG:14}` 只钉了 `fontSize === 10`（11 / 14 无断言）；`{fontSize:12}`、`{fontSize:12,fontSizeLG:14}`、`{}` 三行在测试里**没有任何断言**——其中 `{fontSize:12}` 与 `{}` 还能在 `density.ts` 的文件头里找到（那里一共只举了 `{fontSizeSM:11}`、`{fontSize:12}`、`{}` 三例），**`{fontSize:12,fontSizeLG:14}` → 10/8/14 这一行的唯一出处就是本表**。

2. **间距与控件高度交给 `compactAlgorithm`，不重复手调** `padding*` / `controlHeight` 种子 token（与算法叠加会过度压缩）；`lineHeight` 也不动（缩小字号后行高比例已流体，动它易致行框局促）。

**类型与密度上下文**：`DensityMode = 'light' | 'dark'`（`density.ts` 导出）；`DensityProvider` 把**解析后的实际明暗**（`auto` 已解析为 `light` / `dark`）通过 React 上下文传给 `PageShell`，供其选择 `COMPACT_THEMES` 的哪一份；`useDensityMode()` 读它，无 Provider 时回落 `dark`（与默认主题一致）。

### 6.4 页面根容器 `PageShell`

全站「弹性布局 + 横向沾满」的唯一出口。四条不变量，每条都对应一个真实缺陷：

1. **纵向 Flex 根 + `width: 100%` + `minWidth: 0` + `height: 100%`**。
2. **刻意不设 `alignItems`**。纵向 Flex 的交叉轴是水平方向，`align-items: flex-start` 会让子元素**不横向拉伸**（表现为「没有横向沾满」）并把父级顶宽（多余横向滚动条）。这是最常见的误用。
3. **`padding` / `gap` 默认不落 `style`**，仅在显式传入时设置。原语默认值一旦非 0，页面迁移时会凭空新增间距并可能制造溢出。
4. **`minHeight: 0` 无条件写在基础 style 里**（与 `minWidth: 0` 并列）。纵向主轴默认 `min-height: auto`，内容（含子元素的自动最小尺寸）会撑开容器，使页面根收缩不到 flex 分配的高度。原先只在 `scroll: 'inner'` 分支里给，理由是「内部滚动」那一类；但高度链其实是**每个** `scroll` 模式共用的：实测 `/demo` 打开右栏 + 视口高 520 时整页溢出 **25px**（`documentElement.scrollHeight` 545 > `clientHeight` 520）、`PageShell` 高卡在 520（本应 495.33），运行时把它压成 0 后溢出归零。`scroll: 'inner'` 仍额外要 `overflow: auto`（根自身滚动）。

```tsx
'use client';

/**
 * 页面根容器：全站「弹性布局 + 横向沾满」的唯一出口。
 * 四条不变量，每条都对应一个真实缺陷：
 *   1. 纵向 Flex 根 + width:100% + minWidth:0 + height:100%；
 *   2. **刻意不设 alignItems**——纵向 Flex 的交叉轴是水平方向，align-items:flex-start
 *      会让子元素不横向拉伸（「没有横向沾满」）并把父级顶宽（多余横向滚动条）；
 *   3. padding / gap 默认不落 style——原语默认值一旦非 0，页面迁移会凭空新增间距并可能制造溢出；
 *   4. **minHeight:0 无条件写在基础 style 里**（与 minWidth:0 并列）——纵向主轴默认 min-height:auto，
 *      内容（或子元素的自动最小尺寸）撑开容器时页面根就收缩不到 flex 分配的高度，
 *      整页被顶出「顶栏那一截」。实测：/demo 打开右栏 + 视口高 520 时页面溢出 **25px**
 *      （documentElement.scrollHeight 545 > clientHeight 520）、PageShell 高卡在 520（本应 495.33）；
 *      运行时把它压成 0 后溢出归零。原先只在 scroll="inner" 分支里给，是因为当时只想到
 *      「内部滚动」那一类；但高度链是**每个**模式共用的，故上移为基础不变量。
 *      scroll="inner" 仍额外要 overflow:auto（根自身滚动）——那一项留在分支里。
 *
 * 为什么结构性不变量**自己写进内联 style**，而不只靠 antd 的 Flex：antd 的 display /
 * flex-direction 走 CSS 类（`.ant-flex`、`.ant-flex-vertical`），内联 style 里读不到；
 * 不变量若只活在类名里，antd 换实现或改类名就会静默失效，本组件也不再是可靠真源。
 * 内联与类名同值时内联胜出，渲染结果不变。
 *
 * 为什么 minWidth / minHeight 写字面量 '0px' 而不是数字 0：React 对数值 0 **不加单位**
 * （源码里 `value !== 0` 才补 px，因为 0 与 0px 等价），内联 style 会落成 `min-width: 0`。
 * 两者计算值相同，但 '0px' 让「横向不收缩」「纵向不收缩」这两条不变量在内联口径下可断言。
 *
 * 副作用（如实记录）：这条内联 display:flex 也压过了 antd 的 `.ant-flex:empty { display: none }`，
 * 于是 <PageShell /> 不带 children 时会占满整屏，而不再像偏离前那样收缩为零——
 * 对页面根容器而言这更合理，但它确实是一处相对偏离前渲染的真实行为变化。
 */
import { ConfigProvider, Flex } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { compactTheme } from './density';
import { useDensityMode } from './density-context';

/** 紧凑主题按明暗预生成一次：避免每次 render 重建 ThemeConfig（algorithm 数组引用亦保持稳定） */
const COMPACT_THEMES = {
  light: compactTheme('light'),
  dark: compactTheme('dark'),
} as const;

export interface PageShellProps {
  children: ReactNode;
  /** 密度：compact（默认，全站通用）| default（仅设置页豁免） */
  density?: 'compact' | 'default';
  /** 内边距；不传则不落 style */
  padding?: number | string;
  /** 纵向间距；不传则不落 style */
  gap?: number;
  /** page：由外层文档滚动（默认）| inner：根自身滚动（长列表页）| none：不接管 */
  scroll?: 'page' | 'inner' | 'none';
}

export function PageShell({ children, density = 'compact', padding, gap, scroll = 'page' }: PageShellProps): ReactNode {
  const mode = useDensityMode();
  // 只编码结构性不变量；间距仅在显式传入时落 style
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: '0px',
    // 无条件给：高度链不只在 scroll="inner" 下需要它（见文件头第 4 条不变量）
    minHeight: '0px',
    height: '100%',
  };
  if (padding !== undefined) style.padding = padding;
  if (gap !== undefined) style.gap = gap;
  if (scroll === 'inner') style.overflow = 'auto';
  const content = (
    <Flex vertical style={style}>
      {children}
    </Flex>
  );
  // 豁免页不包 ConfigProvider，直接落回外层主题
  if (density === 'default') return content;
  return <ConfigProvider theme={COMPACT_THEMES[mode]}>{content}</ConfigProvider>;
}
```

### 6.5 两栏布局 `SplitPane`

侧栏 + 主区的两栏布局，**薄适配 antd `Splitter`**。分隔条的指针捕获、键盘可达、最小/最大夹紧、拖动态光标与 `role="separator"` 语义全由 `Splitter` 提供，不自绘。

> **双击复位：antd 未提供，本期不做**——antd 6.6.5 的 `Splitter` **没有**内置双击复位（`es/splitter/SplitBar.js:203` 只把双击转给可选的 `onDraggerDoubleClick` prop，而本项目的 `SplitPane` / `ResizableColumns` / `ListDetailLayout` 都没传它），双击分隔条不产生任何反应（浏览器冒烟实测：双击前后右栏 380px / `localStorage` "380" 完全不变）。需要时在 `ResizableColumns` 上自行实现（透出 `onDraggerDoubleClick` 并把偏好复位到 `defaultDetailWidth`）。本节初版把「双击复位」列为 `Splitter` 自带能力，属于**已纠正的错误陈述**。

```ts
export interface SplitPaneProps {
  side: ReactNode;
  children: ReactNode;
  /** 侧栏宽度（px），默认 300 */
  sideWidth?: number;
  /** 侧栏位置，默认 'start' */
  sidePosition?: 'start' | 'end';
  /** 只作侧栏最小宽使用 */
  collapseBelow?: number;
  /** 两栏间距（px）：原样落成 Splitter 根节点的 CSS `gap`（flex 间距，纯视觉），**不**是分隔条命中带宽度 */
  gap?: number;
}
```

> 上面的接口摘录与下面代码块里的 `SplitPaneProps` **逐字同源**（字段、类型与注释都照抄文件）。注意 `sidePosition` 的默认值是 `'start'`，组件文件头声明的用法是「本项目的右栏一律用 `'end'`」。
>
> **现状（2026-10-08）**：`SplitPane` 目前**没有生产消费者**——全仓只有 `ui/src/index.ts` 的出口行与 `split-pane.test.tsx`（测试里 3 处 `end` / 1 处 `start`）。唯一用过它的示例页已删除，而当前列表+右栏的组合走 `ResizableColumns`（§6.6，因为它才支持宽度刷新还原）。它仍作为「不需要还原宽度时的两栏原语」保留在 `ui` 的出口里；那句「右栏一律用 `end`」是**给未来调用方的约定**，不是对现状的描述。

参数映射：

- `sidePosition: 'start' | 'end'` → `Splitter.Panel` 的先后顺序（`Splitter` 按 children 顺序排）。
- `sideWidth` → 侧栏 Panel 的 `defaultSize`（像素）；`collapseBelow` → 侧栏 Panel 的 `min`，实现是 `const min = collapseBelow ?? sideWidth`（不传时 `min === sideWidth`，窗口再窄也不会把侧栏压没）。
- `gap` → `Splitter` 根节点的 CSS `gap`（纯视觉间距）。**不要**去覆盖 `styles.dragger`——它会整个替换 antd 的 dragger 样式，传 `width` 会把命中带改成 0（见下方坑 1）。

**已记录的边界**：本适配**不支持纵向堆叠**——`Splitter` 没有等价开关，故改为「始终保持左右并排 + 夹紧最小宽」。对桌面为主的用法可接受，但 `collapseBelow` 现在只作最小宽使用，不再是「窄于它就上下堆叠」。

**两个已踩过的坑**：

1. **`styles.dragger` 会整个替换 antd 的 dragger 样式**，传 `width` 会把命中带改成 0（实测三条分隔条宽度全为 0、看不见也拖不到）。**这里要区分两件事**：栏间**间距**是本组件自己写进 `Splitter` 根节点的 CSS `gap`（默认 8），跟 antd 无关；**不要去覆盖的是 `styles.dragger`**——命中带的宽度该由 antd 自带的尺寸变量决定，**变量名以运行时的为准**：在跑着的应用里读 `document.styleSheets` 得到的是 `--ant-splitter-split-bar-size` / `--ant-splitter-split-trigger-size` / `--ant-splitter-split-bar-draggable-size`（前缀 `--ant-splitter-` 来自 `genCssVar('.ant','splitter')`，组件 token 名 `splitBarSize` 等由 cssinjs 的 `token2CSSVar` 驼峰转连字），**不是** `--ant-splitter-bar-size`——那个名字在 antd 的产物与运行时里都不存在（2026-10-08 在 :3083 实测）。
   > 下面代码块里那句「两栏间距交给 antd 自带尺寸，不覆盖」是**文件注释的旧措辞**，它想说的是 `styles.dragger` 的命中带；栏间距与 antd 无关——以本段散文为准（要改得改 TSX）。
2. 两栏宿主用原生 `div` 是**有意偏离**「避免裸写 div」——antd 没有「可滚动的通用盒子」原语，用 `<Flex>` 包单个孩子只是徒增节点（注释写明理由）。

```tsx
'use client';

/**
 * 两栏布局（侧栏 + 主区）：antd `Splitter` 的薄适配。
 * 分隔条的指针捕获、键盘可达、最小/最大夹紧、拖动态光标与 role=separator 语义全由 Splitter 提供，
 * 不自绘。本项目右栏一律用 sidePosition="end"。
 *
 * **双击复位不在其列**（原注释与设计稿 §6.5 都把「双击复位」算作 Splitter 的能力，对 antd 6.6.5 不成立）：
 * antd 6.6.5 的 Splitter 没有内置双击复位，`es/splitter/SplitBar.js:203` 只把双击转给可选的
 * `onDraggerDoubleClick` prop，本组件没有透出它 ⇒ 双击分隔条无任何反应。需要时由调用方自行实现。
 *
 * 已记录的边界：本适配**不支持纵向堆叠**——Splitter 没有等价开关，故改为
 * 「始终保持左右并排 + 夹紧最小宽」。collapseBelow 只作侧栏最小宽使用。
 *
 * 两个已踩过的坑：
 *   1. styles.dragger 会整个替换 antd 的 dragger 样式，传 width 会把命中带改成 0
 *      （实测三条分隔条宽度全为 0、看不见也拖不到）——两栏间距交给 antd 自带尺寸，不覆盖；
 *   2. 两栏宿主用原生 div 是有意偏离「避免裸写 div」——antd 没有「可滚动的通用盒子」原语，
 *      用 <Flex> 包单个孩子只是徒增节点。
 *
 * 两个宿主 div 的 `minWidth/minHeight` 写字面量 `'0px'` 而不是数字 0：React 对数值 0 **不加单位**
 * （源码里 `value !== 0` 才补 px），内联 style 会落成 `min-width: 0`。两者计算值相同，
 * 但 `'0px'` 让「不收缩」这条不变量在内联口径下可断言（与 page-shell.tsx 同一口径）。
 * 两套写法**并存是有意的**：写 `'0px'` 的只有「测试会断言其内联值」的这两处宿主，其余（本文件
 * Splitter 根节点的 `minWidth/minHeight`、`resizable-columns.tsx` 里的全部 0）保持数值 0，不做全仓统一。
 *
 * 本原语不支持「用户拖过的宽度在刷新后还原」（Splitter 的 defaultSize 只在挂载时读一次）；
 * 需要还原宽度时用 ResizableColumns。
 */
import { Splitter } from 'antd';
import type { ReactNode } from 'react';

export interface SplitPaneProps {
  side: ReactNode;
  children: ReactNode;
  /** 侧栏宽度（px），默认 300 */
  sideWidth?: number;
  /** 侧栏位置，默认 'start' */
  sidePosition?: 'start' | 'end';
  /** 只作侧栏最小宽使用 */
  collapseBelow?: number;
  /** 两栏间距（px）：原样落成 Splitter 根节点的 CSS `gap`（flex 间距，纯视觉），**不**是分隔条命中带宽度 */
  gap?: number;
}

export function SplitPane({
  side,
  children,
  sideWidth = 300,
  sidePosition = 'start',
  collapseBelow,
  gap = 8,
}: SplitPaneProps): ReactNode {
  const min = collapseBelow ?? sideWidth;
  const sidePanel = (
    <Splitter.Panel key="side" defaultSize={sideWidth} min={min}>
      {/* 侧栏宿主：固定宽度由 Panel 给，内部滚动由调用点的内容自带 */}
      <div data-testid="split-side-host" style={{ height: '100%', minWidth: '0px', minHeight: '0px', overflow: 'auto' }}>
        {side}
      </div>
    </Splitter.Panel>
  );
  const mainPanel = (
    <Splitter.Panel key="main">
      <div data-testid="split-main-host" style={{ height: '100%', minWidth: '0px', minHeight: '0px', overflow: 'auto' }}>
        {children}
      </div>
    </Splitter.Panel>
  );
  return (
    <Splitter style={{ flex: 1, minWidth: 0, minHeight: 0, gap }}>
      {sidePosition === 'start' ? [sidePanel, mainPanel] : [mainPanel, sidePanel]}
    </Splitter>
  );
}
```

该原语**不支持「用户拖过的宽度在刷新后还原」**（`Splitter` 非受控，`defaultSize` 只在挂载时读一次）。需要还原宽度时用 §6.6 的 `ResizableColumns`。

### 6.6 可调栏宽 `ResizableColumns`

给「多栏各栏可拖」的页面用，每条分隔条调整其**左邻**那一栏的宽度。本模块只负责三件事，真正干活的全在 antd 里（拖拽、夹紧、键盘、aria 语义）——**双击复位不在其列**（原因与做法见 §6.5 的说明）：

1. 把 `ResizablePane` 映射成 `Splitter.Panel` 的 props；
2. 提供「分栏区 = `Layout(Content(Splitter))`」这层结构，让各栏拿到**确定高度**；
3. 每栏一个宿主节点，承接调用方的内边距与滚动。

```ts
// 接口摘录（JSDoc 从略/合并，字段与类型与下方代码块一致；注释原文见文件）
export interface PaneGeometry {
  width: number;
  min: number;
  max: number;
  /** 弹性列标记（至多一栏为 true）：吃富余空间 */
  flexible?: boolean;
}

export interface ResizablePane extends PaneGeometry {
  /** React key 与无障碍名称（屏幕阅读器据此播报这是哪一栏） */
  key: string;
  label: string;
  content: ReactNode;
  /** 该栏宿主的样式（与默认样式合并，同键覆盖） */
  style?: CSSProperties;
}

export interface ResizableColumnsProps {
  panes: ResizablePane[];
  /**
   * 拖动过程中各栏的**像素**宽度（下标与 panes 对齐，每次位移都触发）。
   * **调用方必须把结果回写进传给 `size` 的那个状态**，否则受控模式下拖拽会弹回（见尺寸口径第 3 条）。
   */
  onWidthsChange: (widths: number[]) => void;
  /** 容器实测宽度上报（首帧 + 每次尺寸变化） */
  onAvailableChange?: (available: number) => void;
  /** 指定栏的实测像素宽度上报（首帧 + 每次变化，含拖动过程中） */
  onPaneWidthChange?: (key: string, width: number) => void;
}
```

**尺寸口径（读 antd `splitter/hooks/useSizes.js` 与 `useResize.js` 得出，四条反直觉但必须遵守）**——前三条进了 `resizable-columns.tsx` 的文件头，第四条落在 effect 的依赖数组里（写不进文件头，就在下面单列）：

1. 只要有**任何一个** Panel 带 `size`，`Splitter` 整体走 `propSizes` 分支（`sizes = propSizes.some(isNonNullable) ? propSizes : innerSizes`），没给 `size` 的栏由 `autoPtgSizes` 补剩余空间 ⇒ **弹性列必须「不给 `size`」**才是吃剩余的那一栏（给它传期望值 900 会让它钉死在 900，另一栏实测被压成 0）。不给 `size` 的实现方式是条件展开 `{...(flexible ? { min } : { size, min, max })}`，而不是传 `size={0}`。
2. `size` 是**响应式受控入口**：`propSizes` 一变，`sizes` 的 `useMemo` 立即重算并重新渲染 ⇒ **不需要用「改 `key` 强制重挂载」那种做法**（那还会顺带重置列表滚动位置）。但反过来，`defaultSize` 只在挂载时读一次（`useState(() => items.map(item => item.defaultSize))`）⇒ 想还原「上次拖出来的宽度」**必须给 `size`（像素）**，用 `defaultSize` 刷新后会回到旧值（实测拖到 145、刷新回 173）。
3. **受控模式下拖拽不会自己动，必须把 `onResize` 回写进 `size`**。原因：拖拽时 `onOffsetUpdate` 只调 `updateSizes`（即 `setInnerSizes`），而只要存在 `size` prop，`sizes` 就走 `propSizes` 分支、**完全忽略 `innerSizes`**。所以调用方必须监听 `onResize(sizes: number[])`（像素数组、每次拖动都触发）并把结果写回自己传给 `size` 的状态——不写回的表现是「拖得动但一松手弹回原位」。这也是 antd 在部分 Panel 有 `size`、部分没有却不传 `onResize` 时给出用法警告的原因。`onResize` 的触发时机（读 antd `Splitter.js:97-117` 与 `SplitBar.js:119-149` 得出，三条路径各不相同）：**非 lazy（默认）下拖动过程中每次位移都调 `onResize(nextSizes)`**，松手时调的是 `onResizeEnd(itemPxSizes)`——传的是**当次渲染的那份 px 尺寸**，不是这次位移算出的 `nextSizes`；**lazy 下拖动中一个回调都不调**，松手才调一次 `onResizeEnd(nextSizes)`（这次是最新尺寸）。故**以 `onResize` 为准**，不要只监听 `onResizeEnd`（非 lazy 下它给的不是最终值，lazy 下拖动中它根本不响）。另有折叠路径：`onCollapse` 会同时调 `onResize(nextSizes)` 与 `onResizeEnd(nextSizes)`，两者都是最新尺寸。
4. **栏增减后必须重新收集栏宿主并重新挂载观察器**。`onPaneWidthChange` 靠 `ResizeObserver` 观察各栏宿主节点实现，而节点引用在一次 effect 里收集完就固定了。栏数变化（最典型的是右栏开关导致两栏 ↔ 单栏切换）后，新宿主不在被观察之列，**`onPaneWidthChange` 会从此静默失效**——不报错、只是再也不回调。故该 effect 的依赖必须含栏数，每次重新 `querySelectorAll('[data-pane-key]')` 后重新观察。同理，`data-pane-key` 是收集栏宿主的唯一钩子，改名必须同步改收集逻辑。

**难点与解法**：只有 `size` 是像素值，窗口变窄时若不按比例收，`Splitter` 只能硬夹到 `min`，栏间比例会跳变。故提供一个纯函数 `restoreWidthsToAvailable` 完成「落库的像素偏好 + 当前可用宽 → 本次渲染的像素值」，比例稳定且便于单测。**该纯函数另有一条口径**：

- **比例还原时弹性列必须原样回填**：对 `flexible: true` 的栏**直接返回入参宽度**，不参与按比例收、也不被 `Math.max(pane.min, …)` 抬到 `min`。少了这条早返回，宽度为 0 的弹性列会被抬成 80，与「弹性列位置原样回填」的口径不符（缩窄路径上实测返回 80 而非 0）。

**另一条与上面那个纯函数无关、但同属本组件的不变量**：

- **栏宿主要带无障碍名称**：宿主 div 上写 `role="group"` + `aria-label={pane.label}`。裸 div 是 `role=generic`，而 ARIA 规范**禁止** generic 角色带名字——只写 `aria-label` 读屏取不到，必须同时给 `role`。

```tsx
'use client';

/**
 * 多栏可调宽度布局：每条分隔条调整其**左邻**那一栏的宽度。
 * 真正干活的全在 antd Splitter 里（拖拽、夹紧、键盘、aria 语义），本模块只做三件事：
 *   1. 把 ResizablePane 映射成 Splitter.Panel 的 props；
 *   2. 提供「分栏区 = Layout(Content(Splitter))」这层结构，让各栏拿到**确定高度**；
 *   3. 每栏一个宿主节点，承接调用方的内边距与滚动。
 *
 * **双击复位不是 antd 提供的能力**（原注释把「双击」也列在 Splitter 里，对 6.6.5 不成立）：
 * antd 6.6.5 的 Splitter 没有内置双击复位，`es/splitter/SplitBar.js:203` 只把双击事件转给可选的
 * `onDraggerDoubleClick` prop，而本模块与 ListDetailLayout 都没有传它 ⇒ 双击分隔条**什么也不会发生**
 * （浏览器冒烟实测：双击前后右栏 380px / localStorage "380" 完全不变）。需要复位时由调用方自己传
 * `onDraggerDoubleClick`（本模块目前不透出这个 prop）。
 *
 * 尺寸口径（读 antd splitter/hooks/{useSizes,useResize}.js 得出，三条反直觉但必须遵守）：
 *   ① 只要有任一个 Panel 带 size，整体走 propSizes 分支，没给 size 的栏由 autoPtgSizes 补剩余
 *      ⇒ **弹性列必须「不给 size」**才是吃剩余的那一栏（给它传期望值会让它钉死，另一栏被压成 0）。
 *      实现方式是条件展开，而不是传 size={0}；
 *   ② size 是**响应式受控入口**——propSizes 一变即重算并重渲染，所以**不需要**用「改 key 强制
 *      重挂载」那种做法（那还会顺带重置列表滚动位置）。反之 defaultSize 只在挂载时读一次，
 *      想还原宽度必须给 size；
 *   ③ **受控模式下拖拽不会自己动，必须把 onResize 回写进 size**：拖拽时 onOffsetUpdate 只调
 *      setInnerSizes，而存在 size 时就完全忽略 innerSizes。调用方不回写的表现是「拖得动但松手弹回」。
 *
 * Layout.Content 是「吃满父级剩余高度」的关键：它的 flex:auto + min-height:0 就是该语义的现成实现；
 * 有了确定高度，栏内那些 flex:1 才有可解析的参照（否则会退化成 auto，内容栏被内容撑到数千像素）。
 * 外层 minWidth:0 必须留着：它是横向 Flex 的 flex item，默认 min-width:auto 会被内部内容撑宽。
 */
import { Layout, Splitter } from 'antd';
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Splitter 的分隔条**命中带**宽度（px）：用于把可用宽换算成「扣除分隔条后的预算」。
 * 注意它不是布局宽度：antd 横向布局里分隔条本身是 `width: 0`（见 splitter/style 的 `&-horizontal > bar`），
 * 只有绝对定位的 dragger 有 6px（默认 `splitTriggerSize`）宽的命中区，**不占**横向空间。
 * 所以这条扣减是**有意保守的宽减**——宁可还原出的宽度略小于容器，也不让最后一栏溢出。
 */
export const HANDLE_HIT_WIDTH = 6;

/** 供布局计算使用的最小面板几何：只关心「当前宽 + 夹紧范围 + 是否弹性列」 */
export interface PaneGeometry {
  width: number;
  min: number;
  max: number;
  /** 弹性列标记（至多一栏为 true）：吃富余空间 */
  flexible?: boolean;
}

export interface ResizablePane extends PaneGeometry {
  /** React key 与无障碍名称 */
  key: string;
  /** 栏的无障碍名称：渲染成栏宿主的 `aria-label`（下方宿主节点是唯一消费点） */
  label: string;
  content: ReactNode;
  /** 该栏宿主的样式（与默认样式合并，同键覆盖） */
  style?: CSSProperties;
}

export interface ResizableColumnsProps {
  panes: ResizablePane[];
  /**
   * 拖动过程中各栏的**像素**宽度（下标与 panes 对齐，每次位移都触发）。
   * **调用方必须把结果回写进传给 size 的那个状态**，否则受控模式下拖拽会弹回（见文件头口径③）。
   */
  onWidthsChange: (widths: number[]) => void;
  /** 容器实测宽度上报（首帧 + 每次尺寸变化） */
  onAvailableChange?: (available: number) => void;
  /**
   * 指定栏的实测像素宽度上报（首帧 + 每次变化，含拖动过程中）。
   * 为什么需要：Splitter 的拖动只改它内部的尺寸状态、不会让调用方重渲染，
   * 故调用方无法从自己的 props 推出「这一栏现在多宽」，而响应式隐列这类行为必须跟着实测值走。
   */
  onPaneWidthChange?: (key: string, width: number) => void;
}

/**
 * 按容器实测宽度**比例还原**非弹性列的像素宽度：够宽时原样返回；不够宽时按比例收（不低于 min）。
 * 弹性列不参与：它的宽度由 Splitter 的 autoPtgSizes 补剩余，期望值无意义。
 * 返回数组与入参同长同序（弹性列位置原样回填），便于调用方按下标取用。
 */
export function restoreWidthsToAvailable(
  widths: number[],
  panes: PaneGeometry[],
  available: number,
  handleCount: number,
): number[] {
  const budget = available - handleCount * HANDLE_HIT_WIDTH;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (available <= 0 || total <= 0) return widths;
  // 够宽：原样（富余留给没给 size 的弹性列）
  if (total <= budget) return widths;
  // 过窄：按比例收，再逐栏夹到 [min, max]；夹紧后仍可能超预算，故取夹紧结果
  // （宁可略超，也不把任何一栏压到 min 以下——Splitter 自己还会再夹一次，这里让比例先稳定）
  const scale = budget / total;
  return panes.map((pane, i) => {
    const width = widths[i] ?? 0;
    // 弹性列原样回填：它不参与按比例收（期望值无意义，宽度由 Splitter 的 autoPtgSizes 补剩余）。
    // 少了这一条，宽度为 0 的弹性列会被下面的 Math.max(pane.min, …) 抬到 min，
    // 与函数头「弹性列位置原样回填」的口径不符（缩窄路径上实测返回 80 而非 0）。
    if (pane.flexible === true) return width;
    return Math.min(pane.max, Math.max(pane.min, width * scale));
  });
}

export function ResizableColumns({
  panes,
  onWidthsChange,
  onAvailableChange,
  onPaneWidthChange,
}: ResizableColumnsProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 回调放 ref：避免因为父级每次渲染新建函数而反复重建 ResizeObserver
  const availableCbRef = useRef(onAvailableChange);
  availableCbRef.current = onAvailableChange;
  const paneWidthCbRef = useRef(onPaneWidthChange);
  paneWidthCbRef.current = onPaneWidthChange;

  // 栏数参与依赖：调用方切换栏（如右栏开/关）后必须重新收集并观察新宿主，
  // 否则新宿主不被观察、onPaneWidthChange 从此静默失效
  const paneCount = panes.length;

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (node === null) return;

    // 每次 effect 重新收集栏宿主：栏增减后旧的引用已失效
    const collectPanes = (): HTMLDivElement[] =>
      Array.from(node.querySelectorAll<HTMLDivElement>('[data-pane-key]'));

    const report = (): void => availableCbRef.current?.(node.offsetWidth);
    report();
    if (typeof ResizeObserver === 'undefined') {
      // 无 ResizeObserver 的环境（老浏览器 / 测试）也要把初值报一次，否则调用方拿不到任何宽度
      for (const el of collectPanes()) {
        if (el.dataset.paneKey !== undefined) paneWidthCbRef.current?.(el.dataset.paneKey, el.offsetWidth);
      }
      return;
    }

    const containerObserver = new ResizeObserver(report);
    containerObserver.observe(node);
    // 栏宿主也一并观察：拖动时 Splitter 只改自己的内部状态，
    // 这个观察器是「拖动过程中实时把栏宽报给调用方」的唯一来源
    const panesObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLDivElement;
        const key = el.dataset.paneKey;
        if (key !== undefined) paneWidthCbRef.current?.(key, el.offsetWidth);
      }
    });
    const paneNodes = collectPanes();
    for (const el of paneNodes) panesObserver.observe(el);
    // 首帧也报一次（观察器只报变化、不报初值）
    for (const el of paneNodes) {
      if (el.dataset.paneKey !== undefined) paneWidthCbRef.current?.(el.dataset.paneKey, el.offsetWidth);
    }

    return () => {
      containerObserver.disconnect();
      panesObserver.disconnect();
    };
  }, [paneCount]);

  if (paneCount === 0) return null;
  return (
    <Layout style={{ flex: 1, minWidth: 0, minHeight: 0, background: 'transparent' }} ref={hostRef}>
      <Layout.Content style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Splitter onResize={onWidthsChange} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {panes.map((pane) => (
            <Splitter.Panel
              key={pane.key}
              // 弹性列：只给 min，**不给 size** ⇒ 由 Splitter 补剩余空间（见文件头口径①）
              // 非弹性列：给 size（像素）⇒ 落库的偏好才能在刷新后真正还原（见口径②）
              {...(pane.flexible === true
                ? { min: pane.min }
                : { size: pane.width, min: pane.min, max: pane.max })}
            >
              {/* 栏宿主：唯一的一层节点。默认「撑满 + 纵向 flex + 裁剪」——
                  高度与滚动都靠这一层约束住，内容再长也不会把栏撑开；
                  调用方的 style 覆盖在其上（display/overflow 会被换掉，故调用方要自己保证仍能撑满）。
                  data-pane-key 是上方 effect 收集栏宿主的唯一钩子，改名要同步改收集逻辑。 */}
              <div
                data-pane-key={pane.key}
                data-testid={`resizable-pane-${pane.key}`}
                // label 的唯一消费点：栏宿主的无障碍名称（读屏/测试都靠它标识「这是哪一栏」）。
                // 必须同时给 role：裸 div 是 role=generic，而 ARIA 规范**禁止** generic 角色带名字，
                // 只写 aria-label 读屏取不到——role="group" 才让这个名字真正生效。
                role="group"
                aria-label={pane.label}
                style={{
                  height: '100%',
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  ...pane.style,
                }}
              >
                {pane.content}
              </div>
            </Splitter.Panel>
          ))}
        </Splitter>
      </Layout.Content>
    </Layout>
  );
}
```

**三个实现要点**：

- **`Layout.Content` 是「吃满父级剩余高度」的关键**：它的 `flex: auto` + `min-height: 0` 就是「吃满剩余高度」的现成实现（自拼 flex 等于把它再写一遍）。而 `Content` 一旦拿到确定高度，栏内那些 `flex: 1` 才有了可解析的参照——否则 `flex: 1` 会退化成 `auto`，内容栏被内容撑到数千像素（实测过）。外层 `minWidth: 0` 必须留着：它是横向 Flex 的 flex item，默认 `min-width: auto` 会被内部内容撑宽。
- **`onPaneWidthChange` 的存在理由**：`Splitter` 的拖动改的是它内部的尺寸状态，**不会**让调用方重渲染，故调用方无法从自己的 props 推出「这一栏现在多宽」。而「窄到某个阈值就隐去列」这类响应式行为必须跟着**实测值**走（否则拖动时不实时、只有松手后才跳一下）。实现上用 `ResizeObserver` 观察各栏宿主节点，首帧也主动上报一次（观察器只报变化、不报初值）。
- 栏宿主节点的默认样式是「撑满 + 纵向 flex + 裁剪」（`height: 100%` + `minWidth/minHeight: 0` + `display: flex` + `flexDirection: column` + `overflow: hidden`），调用方的 `style` 覆盖在其上——**`display` / `overflow` 会被换掉，故调用方要自己保证内容仍能撑满高度**。

### 6.7 宽度与显示偏好记忆（`packages/client/ui/src/base/stored-preference.ts`）

**为什么放 localStorage 而不是 URL**：这些是**个人显示偏好**（怎么读界面），不是「在看什么」——同一份链接发给别人时不该把自己的栏宽偏好一起带过去。分工口径：**URL 记「在看什么」（`?panel=` / `?id=`），localStorage 记「怎么显示」（栏宽、开关）**。

读取路径必须**绝不抛错**：无 `window`（SSR）/ 存储不可用（隐私模式、禁用存储、分区隔离）/ 无值 / 解析失败，一律回落默认值。

```ts
'use client';

/**
 * 宽度与显示偏好记忆（localStorage）。
 *
 * 为什么放 localStorage 而不是 URL：这些是**个人显示偏好**（怎么读界面），不是「在看什么」——
 * 同一份链接发给别人时不该把自己的栏宽偏好一起带过去。分工：URL 记「在看什么」（?panel= / ?id=），
 * localStorage 记「怎么显示」（栏宽、开关）。
 *
 * 两条硬要求：
 *   1. 读取路径**绝不抛错**——无 window（SSR）/ 存储不可用（隐私模式、禁用存储、分区隔离）/
 *      无值 / 解析失败，一律回落默认值；
 *   2. useStoredWidth **不在首帧读 localStorage**，挂载后再读。若在 useState 初始化函数里读，
 *      服务端渲染拿到 seed、客户端首次渲染拿到存量值，会产生水合不一致警告。
 */
import { useCallback, useEffect, useState } from 'react';

/** 单个偏好键在本机的读取：无 window / 存储不可用 / 无值 / 解析失败 → seed */
export function readStoredPreference<T>(key: string, seed: T, parse: (raw: string) => T | null): T {
  if (typeof window === 'undefined') return seed;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? seed : parse(raw) ?? seed;
  } catch {
    // 隐私模式 / 禁用存储 / 分区隔离：读不到就用默认值，不影响功能
    return seed;
  }
}

/** 数值偏好的解析器：非有限数视为脏值 */
function parseFiniteNumber(raw: string): number | null {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 夹紧到 [min, max] 并取整：存量值可能来自旧版本的范围、也可能被手改过 */
function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * 宽度偏好状态：首帧取 clamp(seed)，挂载后读出存量值并夹紧；更新即写回。
 * 写入失败（配额 / 禁用存储）不抛错——本次会话内的改动仍然生效，只是记不住。
 */
export function useStoredWidth(key: string, seed: number, min: number, max: number): [number, (next: number) => void] {
  const [width, setWidth] = useState<number>(() => clampWidth(seed, min, max));

  // 挂载后再读存量值：保证 SSR 与客户端首帧一致（否则水合不一致）
  useEffect(() => {
    const stored = readStoredPreference(key, seed, parseFiniteNumber);
    setWidth(clampWidth(stored, min, max));
  }, [key, seed, min, max]);

  const update = useCallback(
    (next: number) => {
      const clamped = clampWidth(next, min, max);
      setWidth(clamped);
      try {
        window.localStorage.setItem(key, String(clamped));
      } catch {
        // 写不进去（配额 / 禁用存储）：本次会话内的宽度仍然生效
      }
    },
    [key, min, max],
  );

  return [width, update];
}
```

**`useStoredWidth` 必须「挂载后再读 localStorage」**（`useState(() => clampWidth(seed))` + `useEffect` 里读存量）：若在 `useState` 初始化函数里读，服务端渲染拿到 seed、客户端首次渲染拿到存量值，会产生**水合不一致**警告。挂载后读同样满足「刷新保持宽度」。首帧值 = `clamp(seed)`，`seed` 本身也参与夹紧；夹紧先 `Math.round` 再夹到 `[min, max]`（`clampWidth` 的实现是 `Math.min(max, Math.max(min, Math.round(value)))`，故越界的存量值一律被拉回区间内并取整）。

读取路径还要兜住**两类**存储不可用：`getItem` 抛错（配额 / 安全错误）与 `window.localStorage` **属性访问本身**抛错（隐私模式 / 分区隔离）——取值必须在 `try` 内，挪到 `try` 外会炸穿到调用方。

写入失败（配额 / 禁用存储）不抛错——本次会话内的改动仍然生效，只是记不住。（**严格说有个前提**：`key` / `seed` / `min` / `max` 这四项不变。它们一变，挂载 effect 会重新读一次 `localStorage`，把本次会话里改过的宽度覆盖回存量值。）

### 6.8 列表 + 右边栏组合原语 `ListDetailLayout`

**这是脚手架的核心验收对象**：把 §6.4 / §6.6 / §6.7 组合成「列表 + 可拖拽宽度右边栏」这一形态的唯一出口，供示例页使用；功能阶段的用例页与评测页直接复用，不再各写一套。（**注意不含 §6.5 的 `SplitPane`**——它只能给 `defaultSize`、不支持刷新还原，本组合用的是 §6.6 的 `ResizableColumns`；单栏退化路径也不用 `SplitPane`。）

```tsx
'use client';

/**
 * 列表 + 可拖拽宽度右边栏：这一形态的**唯一出口**。
 * 用例页与评测页都复用它，不再各写一套；示例页也用它（脚手架阶段用来验证整套原语能用）。
 *
 * 三个行为要点：
 *   1. 右侧宽度 = 偏好（localStorage）× 容器可用宽的比例还原 ⇒ 窗口变窄时按比例收，
 *      而不是被 Splitter 硬夹到 min 导致栏间比例跳变；
 *   2. 拖拽时把**右栏像素宽**回写进本地状态与偏好——受控模式下不回写，松手会弹回
 *      （见 resizable-columns 的文件头口径③）；
 *   3. detail 为 null 或 detailOpen=false 时退化为单栏列表占满，
 *      **不要**渲染宽度为 0 的 Panel（Splitter 的 min 会把它夹回最小宽、留下一条空栏）。
 *
 * 要点 3 的两个条件**都要判**：只看 detailOpen 时，`detail={null}` 会渲染出一条
 * 右栏外壳（分隔条 + 宿主都在），正是要点里说的「一条空栏」；调用方在「详情未选中」时
 * 传 null 是常态，所以这里按文件头的口径把两个条件都收进同一个判定。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { PageShell } from './page-shell';
import { useStoredWidth } from './stored-preference';
import {
  HANDLE_HIT_WIDTH,
  ResizableColumns,
  restoreWidthsToAvailable,
  type PaneGeometry,
  type ResizablePane,
} from './resizable-columns';

export interface ListDetailLayoutProps {
  /** 左栏内容（列表 / 表格） */
  list: ReactNode;
  /** 右栏内容；与 detailOpen=false 一起表示「不显示右栏」 */
  detail: ReactNode;
  /** 右栏是否显示 */
  detailOpen: boolean;
  /** 右栏宽度偏好的 localStorage 键（每页各一个，避免互相覆盖） */
  widthStorageKey: string;
  /** 右栏默认宽度（px），默认 420 */
  defaultDetailWidth?: number;
  /** 右栏宽度下限（px），默认 320 */
  minDetailWidth?: number;
  /** 右栏宽度上限（px），默认 900 */
  maxDetailWidth?: number;
}

/** 列表栏的几何：弹性列（吃剩余），只给一个不塌的下限 */
const LIST_MIN_WIDTH = 120;

/**
 * 两栏内容的内边距（四边同一份）。
 *
 * **它同时是详情里吸底操作栏的对齐依据**（2026-10-07 用户口径：「上下边距一样宽」）：
 * 那一栏的下边空隙就是本槽的 `padding`（栏底与内容之间那 8px 是这里的），所以它自己只补**上边**
 * 同一个值——两处必须逐字相同，否则上下就不一样宽了。故导出成一个常量，不各写一个 8
 * （同 `HANDLE_HIT_WIDTH` 的理由：几何数字只留一份）。
 */
export const PANE_PADDING = 8;

export function ListDetailLayout({
  list,
  detail,
  detailOpen,
  widthStorageKey,
  defaultDetailWidth = 420,
  minDetailWidth = 320,
  maxDetailWidth = 900,
}: ListDetailLayoutProps): ReactNode {
  const [preferredWidth, setPreferredWidth] = useStoredWidth(
    widthStorageKey,
    defaultDetailWidth,
    minDetailWidth,
    maxDetailWidth,
  );
  // 容器实测宽度：首帧未知，用 0 表示「还没量到」——此时不还原，直接给偏好值
  const [available, setAvailable] = useState(0);
  // 本次渲染实际传给 Splitter 的右栏像素宽（拖动过程中由 onWidthsChange 更新）
  const [renderWidth, setRenderWidth] = useState<number | null>(null);

  const panes: PaneGeometry[] = useMemo(
    () => [
      { width: 0, min: LIST_MIN_WIDTH, max: Number.MAX_SAFE_INTEGER, flexible: true },
      { width: preferredWidth, min: minDetailWidth, max: maxDetailWidth },
    ],
    [preferredWidth, minDetailWidth, maxDetailWidth],
  );

  // 可用宽或偏好变化时，按比例还原出本次渲染的右栏宽度
  const detailWidth = useMemo(() => {
    if (renderWidth !== null) return renderWidth;
    if (available <= 0) return preferredWidth;
    return restoreWidthsToAvailable([0, preferredWidth], panes, available, 1)[1] ?? preferredWidth;
  }, [renderWidth, available, preferredWidth, panes]);

  const handleWidthsChange = useCallback(
    (widths: number[]) => {
      const next = widths[1];
      if (next === undefined || !Number.isFinite(next)) return;
      setRenderWidth(next);
      // 落库的是「用户意图宽度」——夹紧由 useStoredWidth 负责
      setPreferredWidth(next);
    },
    [setPreferredWidth],
  );

  // 容器尺寸变化时清掉拖动期的临时值，回到「按可用宽比例还原」的路径
  const handleAvailableChange = useCallback((next: number) => {
    setAvailable(next);
    setRenderWidth(null);
  }, []);

  // 右栏的显示条件：开关打开**且确实有内容**——只看开关会让 detail=null 留下一整条空栏（见文件头）
  const showDetail = detailOpen && detail !== null && detail !== undefined;

  const listPane: ResizablePane = {
    key: 'list',
    label: '列表',
    content: list,
    width: 0,
    min: LIST_MIN_WIDTH,
    max: Number.MAX_SAFE_INTEGER,
    flexible: true,
    style: { padding: PANE_PADDING },
  };

  const detailPane: ResizablePane = {
    key: 'detail',
    label: '详情',
    content: detail,
    width: Math.round(detailWidth),
    min: minDetailWidth,
    max: maxDetailWidth,
    // 右栏内容可长（用例正文、评测日志），必须自己滚：宿主默认 overflow:hidden 会把它裁掉
    style: { overflow: 'auto', padding: PANE_PADDING },
  };

  return (
    <PageShell>
      {showDetail ? (
        <ResizableColumns
          panes={[listPane, detailPane]}
          onWidthsChange={handleWidthsChange}
          onAvailableChange={handleAvailableChange}
        />
      ) : (
        // 单栏：列表占满。不要用「宽度为 0 的 Panel」代替——Splitter 的 min 会把它夹回来
        <div style={{ height: '100%', minHeight: 0, overflow: 'auto', padding: PANE_PADDING }}>{list}</div>
      )}
    </PageShell>
  );
}

/** 分隔条命中带宽度，供调用方做几何断言时复用（避免魔法数字散落） */
export { HANDLE_HIT_WIDTH };
```

实现要点：

- 用 `ResizableColumns`，两栏：`panes[0]` = 列表（`flexible: true`，**不给 `size`**）、`panes[1]` = 右栏（给 `size`）。右栏这个值的来源**分两种情况**：静止时由 `restoreWidthsToAvailable` 从 `useStoredWidth` 的偏好与容器实测宽算出；**拖动期间**则由 `onWidthsChange` 写回的 `renderWidth` 直接顶上（`renderWidth !== null` 时优先返回它，比例还原被跳过）。
- **右栏的显示条件是「开关打开」且「确实有内容」，两个都要判**：`const showDetail = detailOpen && detail !== null && detail !== undefined`。只看 `detailOpen` 时，调用方在「详情未选中」传 `detail === null` 会渲染出一条**空栏**（分隔条 + 宿主都在）——正是 `Splitter` 的 `min` 会把 0 宽 Panel 夹回来的那个缺陷。
- 退化为单栏时**不要**渲染宽度为 0 的 Panel，也不要用 `SplitPane`：直接用一个原生 `div`（`height: 100%` + `minHeight: 0` + `overflow: auto` + `padding: PANE_PADDING`）让列表占满。
- 根容器是 `PageShell`（`density` 默认 compact）。
- 右栏宿主样式：`{ overflow: 'auto', padding: PANE_PADDING }`。宿主默认 `overflow: hidden`，不给就会把长内容裁掉且没有滚动条。`PANE_PADDING`（= 8）是导出的常量而不是散落的字面量 8：它同时被详情里吸底操作栏当作对齐依据（见 `PANE_PADDING` 的 JSDoc）。
- 拖动时把**右栏像素宽**同时写进「本次渲染的 `size`」与 `useStoredWidth`（受控模式下不回写，松手会弹回）；容器尺寸变化时清掉拖动期的临时值，回到按可用宽比例还原的路径。

> **⚠️ 上面这条「回到按可用宽比例还原的路径」在真实浏览里基本走不到**：文件头 JSDoc 承诺的「窗口变窄时按比例收」**实测没有生效**——`ListDetailLayout` 传给 `restoreWidthsToAvailable` 的 `widths` 是 `[0, preferredWidth]`（弹性列那格写死 0），而该函数里的 `total` 汇总的正是这个数组，于是只要 `available ≥ preferredWidth + HANDLE_HIT_WIDTH`（`budget = available − 6`）就直接原样返回。这是**已记录的已知弱点**（含实测数字与修法），详见 §7.3 末尾；读本节时不要把「比例还原」当成已兑现的能力。

### 6.9 其余基础原语

均为纯 props 驱动的展示组件，放 `ui/src/base/`。**脚手架阶段只实现有消费者的那些**（当时的消费者 = §7 示例页或设置页）；没有消费者的原语留到功能阶段实现，避免留下死代码。

| 组件 | 职责 | 脚手架阶段 | 现状（2026-10-08） |
|---|---|---|---|
| `EmptyState` | 空列表占位 + 引导动作（如「还没有数据 → 点这里创建」） | ✅ 示例页空态用 | ✅ 仍被用例页/评测页的空态使用（示例页已删除） |
| `Toolbar` | 页内操作条（左标题 + 右动作区），全站操作条的唯一样式来源 | ✅ 示例页列表头用 | ✅ 仍是用例页/评测页的列表头 |
| `EllipsisText` | 单行省略 + `Tooltip` 显全量（长路径、长 hash 用） | ✅ 示例页长字段用 | ✅ 仍被用例列表、供应商表等使用 |
| `formatBytes` / `formatDateTime` / `shortHash`（`format.ts`） | 展示格式化：字节数（1024 进制、负数与 NaN 按 0）、ISO → 本地 `YYYY-MM-DD HH:mm`（非法输入原样返回）、哈希取前 N 位 | ✅ 示例页表格与详情用 | ✅ 仍在用（`formatBytes` 现被执行日志的环境抽屉用于「已截断（原文 N B）」） |
| `CopyOnClick` | 点击复制到剪贴板 + 成功提示 | ⏳ 待功能阶段（脚手架无消费者） | ❌ **至今没有这个原语**——**代码里**搜不到（只在本 spec 与 `../plans/2026-09-22-scaffold.md` 里被提到） |
| `OperationStatus` | 「进行中操作」条 + 中止按钮（`Popconfirm` 确认） | ⏳ 待功能阶段（评测运行态才有消费者） | ❌ **至今没有这个原语**——评测运行态确实上线了（行级/运行级中止都在），但中止按钮分别写在 `composite/run-detail-panel.tsx`（运行级）与 `composite/eval-row-card.tsx`（行级）里，评测页（`app/runs/page.tsx`）只做接线与透传，没有抽成该原语 |

**这张表的「现状」列按 2026-10-08 的实现校正过**：`CopyOnClick` / `OperationStatus` 从「待功能阶段」变成了「未实现」，别照脚手架期的 ⏳ 去代码里找它们。

### 6.10 顶栏

`Layout.Header` + 横向 `Menu`（三项，顺序由 `apps/web-next/src/nav.ts` 的 `NAV_ITEMS` 决定：**评测 / 用例 / 设置**——评测是主任务在前，用例是它的输入次之，设置低频收尾）。抽为 `composite/app-top-nav.tsx`，纯 props 驱动：`AppTopNav({ items, active, onNavigate })`——`items` 由应用层从 `src/nav.ts` 注入（含可选的 `icon`，收**组件引用**而不是元素，见代码块里的 JSDoc），`active` 是当前项 key，`onNavigate(href)` 交回应用层路由。**没有 `theme` / `onThemeChange` 这两个 props**（理由见下）。

**顶栏刻意不含产品名与主题切换**（用户口径）：产品名是装饰；主题切换的**唯一入口在设置页**（三档 `Segmented`，读 `useSettings()` 的持久化偏好）。原先顶栏也放了一份「随手切」，与设置页那份读同一状态、成为第二处真源——切换后两处可能不一致，故删除。

**顶栏必须显式给高（`height: 40`）**：antd 6 的 `.ant-layout-header { height: var(--ant-layout-header-height) }`，而这个 CSS 变量由 `Layout` 的**嵌套** ConfigProvider 作用域提供——顶栏是 `PageShell` 的兄弟节点、渲染在**根**作用域（实测根作用域里该变量为空字符串），于是声明在计算值阶段失效、`height` 退回 `auto`：顶栏塌成内容高度 **24.67px**、`padding-block` 为 0。写死 40 是实测过的确定值。这不是密度问题：顶栏本来就是默认密度。

**还必须给 `flexShrink: 0`**：顶栏与 `PageShell`（`height: 100%`）同处 `.ant-app` 这个纵向 flex，后者的 `100%` 使两者高度之和恰好超出容器一个顶栏，浏览器于是在收缩因子内把它压掉几像素——实测只写 `height: 40`、`flexShrink` 取默认 `1` 时顶栏是 **37.84px**（另一次测量为 38.27px：被压掉多少随视口高与滚动条的有无浮动，**不要把这个值当固定常数**），补上这条才是确定的 40px，且页面照样不溢出。

顶栏底色用主题变量（`background: var(--app-bg)` + `borderBottom: 1px solid var(--app-border)`），不许写死色值，否则又是一处半亮。当前项的可访问性由链接上的 `aria-current="page"` 表达（屏幕阅读器与断言都能拿到）：

> 代码块里那句注释「`aria-current` 由 antd 的 `selectedKeys` 渲染到 `li` 上」是**注释本身的旧说法，与实现不符**：antd 6.6.5 全树没有 `aria-current`——`@rc-component/menu` 渲染的 `aria-*` 有 `aria-selected` / `aria-disabled` / `aria-expanded` / `aria-hidden` / `aria-haspopup` / `aria-controls`，**其中不含 `aria-current`**，所以那条属性**是本组件自己在 `<a>` 上给的**。本节的散文口径（「由链接上的 `aria-current` 表达」）才与代码一致；注释按「逐字内联」的口径保留原样，要改得改 TSX。

```tsx
'use client';

/**
 * 顶栏：横向导航。
 * 纯 props 驱动——ui 包不调接口、不依赖路由库，跳转由应用层注入回调。
 * **刻意不在这里放产品名与主题切换**（用户口径）：产品名是装饰，而主题切换的唯一入口在设置页
 * （「跟随系统 / 明亮 / 暗色」三档，读 useSettings 的持久化偏好）。两处各放一份会变成两个真源，
 * 切换后互相打架——顶栏只保留导航这一件事。
 */
import { Layout, Menu } from 'antd';
import type { ComponentType, ReactNode } from 'react';

export interface AppTopNavItem {
  key: string;
  label: string;
  href: string;
  /**
   * 前导图标：收的是**组件引用**而不是元素 —— 导航项的唯一真源 `apps/web-next/src/nav.ts` 是纯 `.ts`
   * （放不下 JSX），而应用侧改成 `.tsx` 会被 vitest 的 import-analysis 按 tsconfig 的 `jsx: preserve`
   * 直接拒绝（AGENTS.md「测试」表的既定口径）。故数据模块给组件、本组件负责渲染与可访问性处理。
   */
  icon?: ComponentType<{ 'aria-hidden'?: boolean }>;
}

export interface AppTopNavProps {
  items: AppTopNavItem[];
  /** 当前激活项的 key */
  active: string;
  onNavigate: (href: string) => void;
}

export function AppTopNav({ items, active, onNavigate }: AppTopNavProps): ReactNode {
  return (
    <Layout.Header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        paddingInline: 16,
        // 为什么必须显式给高（antd 自己的 height 在这层作用域里解析不出值）：
        // antd 6 的 `.ant-layout-header { height: var(--ant-layout-header-height) }`，而这个 CSS 变量
        // 由 Layout 的嵌套 ConfigProvider 作用域提供——顶栏是 PageShell 的**兄弟**节点、渲染在根作用域
        // （浏览器实测根作用域里 `--ant-layout-header-height` 为空字符串），于是该声明在计算值阶段失效，
        // height 退回 auto：实测顶栏塌到内容高度 24.67px、padding-block 0，子元素上下零余量，明显局促。
        // 写死 40 是实测过的确定值；等宽高由 flex + alignItems:center 管，
        // 不需要再调 line-height（antd 的 line-height 也读同一个空变量，本来就是 normal）。
        height: 40,
        // flexShrink:0 不是可选项：顶栏与 PageShell（height:100%）同处 .ant-app 这个纵向 flex，
        // PageShell 的 100% 会把总高顶到「视口 + 顶栏」，浏览器于是按 flex 规则把两者一起压缩——
        // 实测只写 height:40 时顶栏仍被压到 **38.27px**（PageShell 861.73），加上 flexShrink:0 后
        // 顶栏是**确定的 40px**（PageShell 让到 860），页面依然不溢出（900/900）。
        flexShrink: 0,
        // 用主题变量而非写死色值：顶栏底色必须跟着明暗切换，否则又是一处半亮
        background: 'var(--app-bg)',
        borderBottom: '1px solid var(--app-border)',
      }}
    >
      <Menu
        mode="horizontal"
        selectedKeys={[active]}
        style={{ flex: 1, minWidth: 0, background: 'transparent', borderBottom: 'none' }}
        items={items.map((item) => ({
          key: item.key,
          // 图标一律 `aria-hidden`：`@ant-design/icons` 给每个图标挂了 `role="img" aria-label="file-text"`，
          // 不藏起来导航项的可访问名会变成「file-text 用例」（屏读器多念一个词、按名字定位也失配）。
          // 图标是装饰，导航项的语义由链接文案承担——故这里不给它任何可访问名。
          icon: item.icon === undefined ? undefined : <item.icon aria-hidden />,
          label: (
            // 用原生 a 承接可访问性（aria-current 由 antd 的 selectedKeys 渲染到 li 上，
            // 故这里显式标注在链接上，保证屏幕阅读器与断言都能拿到）
            <a
              href={item.href}
              aria-current={item.key === active ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(item.href);
              }}
            >
              {item.label}
            </a>
          ),
        }))}
      />
    </Layout.Header>
  );
}
```

---


### 6.11 展示格式化 `format.ts`

`packages/client/ui/src/base/format.ts`：三个纯函数，原则是**任何非法输入都要有可读的兜底**，绝不让 `NaN` / `Invalid Date` 出现在界面上。

```ts
/**
 * 展示格式化：字节、时间、短哈希。
 * 原则：**任何非法输入都要有可读的兜底**，绝不让 NaN / Invalid Date 出现在界面上。
 */

/** 字节单位的档位；超出最后一档不再进位（避免出现没定义的 PB 等） */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 字节数 → 人类可读（1024 进制，保留一位小数）；负数与非有限数按 0 处理 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex];
  return unitIndex === 0 ? `${value} B` : `${value.toFixed(1)} ${unit}`;
}

/** 取哈希前 N 位；比 N 短时原样返回 */
export function shortHash(hash: string, length = 7): string {
  return hash.length <= length ? hash : hash.slice(0, length);
}

/**
 * ISO 8601 → 本地可读时间（YYYY-MM-DD HH:mm）。
 * 非法输入原样返回——显示 Invalid Date 比显示原始串更糟。
 */
export function formatDateTime(iso: string): string {
  if (iso === '') return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
```

### 6.12 测试用的 `ResizeObserver` 桩

jsdom **不提供** `ResizeObserver`，而 antd 的 `Splitter`（`@rc-component/resize-observer`）在 effect 里直接 `new ResizeObserver(...)` 读全局构造器——不打桩，任何挂载 `Splitter` 的用例都会抛 `ReferenceError`。桩放 `packages/client/ui/src/testing/resize-observer.ts`，**刻意不放进共享 `src/testing/setup.ts`**：`resizable-columns.tsx` 有一条「无 `ResizeObserver` 的环境也要把初值报一次」的兜底分支，全局注入桩会让那条分支在测试里永远不可达。需要的用例自己 `installResizeObserverStub()`——该入口**顺带**装上 `matchMedia` 桩（`testing/match-media.ts`）：antd 的同一个 `Table` 两个 api 都要用，分成两个入口只会让用例漏装一个。

```ts
/**
 * 测试用的 `ResizeObserver` 替身 + 安装助手。
 *
 * 为什么**必须**打桩：jsdom 不提供 `ResizeObserver`，而 antd 的 `Splitter` 内部
 * （`@rc-component/resize-observer` 的 `ensureResizeObserver`）直接 `new ResizeObserver(...)`
 * 读**全局构造器**、不带任何 polyfill。于是任何挂载 `Splitter` 的用例都会在 effect 里抛
 * `ReferenceError: ResizeObserver is not defined` —— 不是被测代码的问题，是环境缺口。
 *
 * 为什么不放进共享 `src/testing/setup.ts`：`resizable-columns.tsx` 有一条
 * 「无 `ResizeObserver` 的环境也要把初值报一次」的兜底分支，全局注入桩会让那条分支在测试里
 * **永远不可达**（正是「兜底路径被测试环境掩盖」这类问题）。需要的用例自己调用本助手。
 *
 * 断言口径提醒：`@rc-component/resize-observer` 在**模块级**缓存了一个 `observer` 单例
 * （`observerUtil.js` 的 `if (!observer)`），所以同一测试文件里只有**第一个**用例会经 antd
 * 创建一个替身实例；被测代码自己 `new ResizeObserver(...)` 的调用则每次都会创建。
 * 需要「只看本用例创建的实例」时，在用例开头 `FakeResizeObserver.reset()`。
 *
 * **替身与真实实现的差距（读断言前必看）**：它只忠实于构造 / `observe` / `unobserve` / `disconnect`
 * 的**记账**语义——**从不调用**构造时收到的回调，也**从不构造** `ResizeObserverEntry`。因此
 * `entries[].target`、`contentRect` 这类回调参数在测试里恒为死代码，「尺寸变化触发回调」这条路径
 * 在本仓任何用例中都走不到（`resizable-columns.tsx` 的首帧上报是它自己在 effect 里直接调的，
 * 不依赖回调）。需要用回调驱动行为的用例**不能**靠本替身，得自己伪造 entry 并手动调用 `callback`。
 */
import { vi } from 'vitest';
import { installMatchMediaStub } from './match-media';

/** 可观测的 `ResizeObserver` 替身：记录被观察元素与 `disconnect` 次数，便于断言观察与清理 */
export class FakeResizeObserver implements ResizeObserver {
  /** 本文件内创建过的全部替身实例（按创建顺序） */
  static readonly instances: FakeResizeObserver[] = [];

  /** 清空实例记录：放在 `beforeEach` 里，让每个用例只看自己创建的实例 */
  static reset(): void {
    FakeResizeObserver.instances.length = 0;
  }

  /** 构造时收到的回调（antd 与 `resizable-columns` 都会传） */
  readonly callback: ResizeObserverCallback;

  /** 被 `observe` 的目标，按调用顺序 */
  readonly observed: Element[] = [];

  /** `disconnect` 调用次数：用来断言卸载时观察器真的被断开（否则是泄漏） */
  disconnectCount = 0;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  /** 本仓没有调用点，留空实现以满足接口 */
  unobserve(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

/**
 * 把替身装成全局 `ResizeObserver`，**顺带**补上 antd 在 jsdom 里需要的另一个缺口
 * `matchMedia`（见 `./match-media.ts`）。
 *
 * 为什么两件事合在一个入口：antd 的同一个 `Table` 既 `new ResizeObserver` 又调
 * `window.matchMedia`，只装前者的话用例仍会在挂载时抛错，而两个 api 的缺口成因、口径
 * 完全一致（jsdom 没实现 + 不进共享 setup）。分两个入口只会让每个挂载 `Table` 的用例
 * 都漏装一个 —— 那正是本入口被合并的原因。
 *
 * 反复调用只会重设全局（`afterEach` 里用 `vi.unstubAllGlobals()` 解除）。
 */
export function installResizeObserverStub(): void {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  installMatchMediaStub();
}
```

## 7. 列表 + 右边栏示例页（脚手架验收对象）

> **现状（2026-10-08 复核）：本节描述的三件套已全部删除。** `apps/web-next/app/demo/page.tsx`、`apps/web-next/src/testing/demo-fixtures.ts`、`packages/client/ui/src/composite/demo-list-page.tsx` 在功能阶段交付（`8130b80`）里按 `../plans/2026-09-22-features-p2-cases.md` Task 9 `git rm`，`ui/src/index.ts` 里的 `DemoListPage` 出口同步移除，`apps/web-next/src/nav.test.ts` 有一条「不含 `/demo`」的守卫钉住这件事。
>
> **本节以下内容只作历史记录**（记的是脚手架验收时的形态与实测数据），照着它去仓库里找 `/demo` 会一无所获。**没有失效的是它验证的那套原语**：`ListDetailLayout`（§6.8）仍是当前用例页与评测页的组合出口，只是把示例页换成了真实数据。

### 7.1 目标

用**内存假数据**把「左列表 + 右可拖拽详情栏」这个形态跑通，证明 §6 的原语真能组合出目标形态。它同时是功能阶段用例页与评测页的模板。

### 7.2 路由与形态

路由 `/demo`。页面顶部放一条 `Alert`（`type="info"`，`closable`）：**「这是脚手架示例页，使用内存假数据；功能实现后本页删除。」**——避免后来者误以为它是真功能。注意 antd 6 已废弃 `Alert.message`，**必须用 `title=`**（用 `message` 会在每次加载时往 console 打一条 error，破坏「干净加载 0 条 error」的自检口径）。

```
apps/web-next/app/demo/page.tsx        # 'use client'，持有选中态与假数据 —— **已删除**
packages/client/ui/src/composite/demo-list-page.tsx   # 纯展示：ListDetailLayout + Table + 详情栏 —— **已删除**
```

**假数据**：12 条记录，字段刻意覆盖后续真实需求会用到的渲染难点：

| 字段 | 类型 | 覆盖的渲染难点 |
|---|---|---|
| `id` | 序号 | 主键 |
| `title` | 长中文标题 | 单元格省略（`EllipsisText`） |
| `path` | 长路径（如 `D:\project\some\deeply\nested\module`） | 省略 + `Tooltip` 全量 |
| `hash` | 40 位十六进制 | 表格里展示短哈希（前 7 位）、`Tooltip` 与详情栏给全量（`CopyOnClick` 脚手架不实现——**功能阶段交付后仍未实现**，见 §6.9 的现状列） |
| `status` | 五态枚举 | `Tag` 颜色映射 |
| `size` | 数字（字节） | 人类可读格式化（KB/MB） |
| `updatedAt` | ISO 时间 | 本地时间格式化 |
| `note` | 多段长文本 | 详情栏内部滚动（验证右栏 `overflow: auto` 真的生效） |

### 7.3 交互清单（验收项）

| # | 行为 | 期望 |
|---|---|---|
| 1 | 点列表行 | 右栏显示该行详情 |
| 2 | 拖右栏左侧分隔条 | 右栏宽度实时变化（分隔条跟随光标：**向右拖 ⇒ 右栏变窄**，向左拖 ⇒ 右栏变宽），列表栏吃剩余空间 |
| 3 | 刷新页面 | 右栏宽度**保持**拖动后的值（验证 `useStoredWidth` + `size` 口径） |
| 4 | 窗口从宽拖到窄 | 右栏**保持偏好宽度**、页面不出现横向滚动条（**不是**「两栏按比例收」——比例收缩实测未生效，见下方已知弱点）。**注意「两栏都不被压没」这条实际没达成**：实测左栏被压到 16px，低于它自己声明的 `min: 120` |
| 5 | 窗口拖回宽 | 右栏恢复偏好宽度 |
| 6 | 双击分隔条 | ✗ **本期不做（功能缺口）**：antd 6.6.5 的 `Splitter` 未提供双击复位，且无人传 `onDraggerDoubleClick` ⇒ 双击无任何反应（详见 §6.5） |
| 7 | 未选中任何行 | 右栏不渲染，列表占满 |
| 8 | 到 `/settings` 切主题（顶栏没有主题入口） | 组件与**页面底色**同时切换（验证三处同步），无「半亮」状态 |
| 9 | 设置页主题选「跟随系统」 | 改系统深浅色，界面**即时**跟随，无需刷新 |
| 10 | 列表为空 | 显示 `EmptyState` 引导，且页面不出现多余滚动条。**整条都没在页面上跑到**：`/demo` 的假数据是非空常量，冒烟时是拿一份**临时用例（跑完即删）**验的；那条用例只有「渲染文案 + 引导按钮、不渲染 `<table>`、不渲染栏宿主」三个断言——**「不出现多余滚动条」这半条没有证据来源**。长期在册的 `empty-state.test.tsx` 只覆盖组件本身，不覆盖这条分支 |
| 11 | 详情栏放进超长文本 | 右栏**内部**滚动，页面本身不出现纵向滚动条。**这一项当时只算半过**：冒烟记录里两半断言在不同的视口高下各自失败（900 高时夹具太短、右栏不滚；520 高时右栏滚但页面溢出 25px——溢出那一半的根因是 `PageShell` 当时没给 `minHeight: 0`，**现已无条件修好**，见 §6.4 第 4 条） |

> **本清单与冒烟记录里的 11 项不是逐条对齐的两份**（逐条对照过）：记录第 11 项（点「新建示例」→ message 提示）在本表里没有对应项；本表第 7、8 项与记录第 7、8 项不是同一件事（记录是「点右栏关闭」「顶栏切明亮」）；**第 10 项同样错位**——本表第 10 项「列表为空」在记录里属「未覆盖项」，而本表第 11 项才对应记录第 10 项（超长文本 → 右栏内部滚动）。引用时以 `../notes/2026-09-22-scaffold-smoke.md` 的**标题**为准。

第 3、9、11 项是这页存在的理由——它们分别验证偏好持久化、主题三处同步、高度链不断。这三类问题在写业务时才发现，返工成本最高。

**第 4 项的已知弱点（实测记录，本期不修）**：缩窄窗口时右栏一直保持偏好宽度（实测恒为 380），收缩量全部由左栏承担，左栏被压到 **88px、16px——低于它自己声明的 `min: 120`**；只有视口 ≲418 时右栏才开始按比例收（380 → 342）。原因是 `ListDetailLayout` 传给 `restoreWidthsToAvailable` 的 `widths` 是 `[0, preferredWidth]`（弹性列那格写死 0），而该函数里的 `total` 汇总的是这个数组本身（与 `flexible` 无关），故只要 `available ≥ preferredWidth + 6` 就直接原样返回——偏好 380 时即容器 ≥386（对应视口 ≳418），这正是上面那个阈值的来源。⇒ **比例收缩在真实浏览里没有生效**，第 4 项只作「不崩」的底线；修法（扣掉弹性列的 `min`，或把左栏实测宽喂进 `widths`）留给后续任务。

### 7.4 假数据的归属

假数据放 `apps/web-next/src/testing/demo-fixtures.ts`（`testing` 目录，与生产代码物理隔离），并在文件头注释写明「仅示例页使用，功能实现后随示例页一并删除」。

**已按此约定执行**：该文件与示例页、`demo-list-page.tsx` 一起在功能阶段删除（`8130b80`），当前 `apps/web-next/src/testing/` 下只剩 `cleanup.ts`。

---

## 8. 最小服务端连通性

脚手架期只做四件事，证明「路由 → api → contracts → client」这条链通了：

1. `contracts`：`ERROR_CODES` / `httpStatusFor` / `ServiceError` + `Settings` 的 zod schema（脚手架期字段：`theme`、`workspaceRoot`、`defaultJudge`、`rowTimeoutMs`、`diffBudgetBytes`）。
   **现状（2026-10-08）**：`SettingsSchema` 现在只有 `theme` / `workspaceRoot` / `defaultJudge` / `defaultJudgeAgent` / `diffBudgetBytes` 五项——`rowTimeoutMs` 已按用户口径删除（执行与评分都不限时间，一行只会因「跑完 / 失败 / 用户点终止」结束），`defaultJudge` 上另加了可选的 `effort`，`defaultJudgeAgent` 是新增项；旧 `config.json` 里多出来的 `rowTimeoutMs` 在读盘时被丢掉——**机制不是 zod**：`loadConfig` 故意不做 schema 校验（一条手改坏的值不该让设置页打不开），它只 `JSON.parse` 后走 `normalizeSettings`，后者按 `SETTINGS_DEFAULTS` 的键表过滤（缺的补默认、多的丢掉）；zod 只出现在 `PUT` 补丁与契约测试里。故**不需要迁移脚本**。
   `InvalidRequestBodyError` 与 `handleApiError` **不在** `contracts`——它们属于框架层的请求处理，落在 `apps/web-next/src/server-context.ts`（`contracts` 不含任何请求对象的概念，把它放进去会让纯契约层依赖 Web 运行时类型）。
2. `core/config-store`：原子写、BOM 容忍、缺失字段归一化、损坏时报含路径的中文原因、**创建即 0600**（`writeFileSync` 的 `mode`，随后再 `chmodSync` 收紧一次；不是「先按默认 mode 建好再 chmod」——那中间有一个同机可读的窗口）。
3. `api`：`getSettings()` / `updateSettings(patch)`——三个口径：读取时把 `~` **只展开、不校验可写性**（存量根目录不可用也要能打开设置页）、**只有改动 `workspaceRoot` 才** `validateWorkspaceRoot`（通过才落盘）、`saveConfig` 抛的裸 errno 折成带配置目录的中文 `INTERNAL`。
4. `web-next`：`GET/PUT /api/settings`；`client` 侧 `useSettings()`。

`/settings` 页**脚手架期只实现主题那一项**（三档 `Segmented`），其余三项（供应商 / 评分配置 / 工作区）留空位或占位卡片。**现状（2026-10-08）**：该页已是四个 Tab——「界面主题 / 模型供应商 / 评分配置 / 工作区」，其中工作区的「校验并保存」就是 `PUT { workspaceRoot }`（服务端 `validateWorkspaceRoot` 通过才落盘）。

统一错误出口 `handleApiError(error, init?)` 的三段映射：`ZodError` → 400 + `context: error.issues`；`InvalidRequestBodyError` → 400；其余按 `toServiceError` 折叠（未知 → `INTERNAL`）。响应体恒为 `{ error: { code, message, context? } }`，`context` 仅在存在时携带。

**必须区分的两种 400**：zod 校验失败与「请求体不是合法 JSON」都映射 400 `INVALID_QUERY`，但**只有后者能叫这个名字**。为此用专属标记类型包装 `req.json()` 的失败：

```ts
/**
 * 路由层共享：请求体解析 + 统一错误出口。
 * 路由只做三件事——zod 校验、调 api、错误映射；本文件承载第三件。
 */
import { ServiceError, httpStatusFor } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { ZodError } from 'zod';

const log = createLogger('route');

/**
 * 请求体解析失败的**唯一**标记类型：只有它映射为 400「请求体不是合法 JSON」。
 * 绝不允许把任何 SyntaxError 都映射成它——否则「读配置文件失败」这类服务端内部解析异常
 * 会被伪装成客户端请求体问题（文案误导 + 排查方向被带偏）。
 */
export class InvalidRequestBodyError extends SyntaxError {
  constructor(cause?: unknown) {
    super('请求体不是合法 JSON');
    this.name = 'InvalidRequestBodyError';
    this.cause = cause;
  }
}

/** 读 JSON 请求体：只把 `req.json()` 的**语法**失败标记成 InvalidRequestBodyError */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (error) {
    // 只把**语法**失败当作「请求体不是合法 JSON」。`req.json()` 还能因为别的原因失败——
    // 最典型的是体已被读过（`TypeError: Body is unusable`），那是服务端自己的编程错误，
    // 伪装成客户端请求体问题正是本模块存在的理由所要防的事（见 handleApiError 的注释）。
    if (!(error instanceof SyntaxError)) throw error;
    throw new InvalidRequestBodyError(error);
  }
}

/** 出参形状：错误码 + 可直接展示的中文 message + 可选 context */
interface ApiErrorBody {
  error: { code: string; message: string; context?: unknown };
}

/**
 * 统一错误出口：zod 校验失败与请求体语法失败映射 400，其余按 ServiceError 折叠。
 * context 仅在存在时携带，保持 undefined 语义、不向响应里塞空键。
 */
export async function handleApiError(error: unknown, init?: ResponseInit): Promise<Response> {
  if (error instanceof ZodError) {
    log.warn('请求参数校验失败', { issues: error.issues.length });
    const body: ApiErrorBody = {
      error: { code: 'INVALID_QUERY', message: '查询参数不合法', context: error.issues },
    };
    return Response.json(body, { ...init, status: httpStatusFor('INVALID_QUERY') });
  }
  if (error instanceof InvalidRequestBodyError) {
    log.warn('请求体不是合法 JSON');
    const body: ApiErrorBody = { error: { code: 'INVALID_QUERY', message: '请求体不是合法 JSON' } };
    return Response.json(body, { ...init, status: httpStatusFor('INVALID_QUERY') });
  }

  const serviceError = toServiceError(error);
  // 5xx 才需要堆栈；4xx 是预期内的用户输入问题，打堆栈只会淹没日志
  const status = httpStatusFor(serviceError.code);
  if (status >= 500) {
    log.error('请求处理失败', { code: serviceError.code, message: serviceError.message, cause: error });
  }
  const body: ApiErrorBody = {
    error: {
      code: serviceError.code,
      message: serviceError.message,
      ...(serviceError.context === undefined ? {} : { context: serviceError.context }),
    },
  };
  return Response.json(body, { ...init, status });
}

/** 任意抛出物 → ServiceError：已是 ServiceError 则原样，其余折叠为 INTERNAL */
function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError('INTERNAL', '服务端内部错误', { cause: error });
}
```

`client` 的 HTTP 层：同源 `/api`，非 2xx 解析 `{ error: { code, message, context? } }` → 抛 `ServiceError`（`context` 透传）；**响应非 JSON 时兜底 `INTERNAL` + HTTP 状态码**，保证错误路径本身不会二次抛错。导出 `getJson` / `postJson` / `putJson` / `delJson` 四个函数。SWR 侧的回写口径是 `useSWRMutation(key, …, { populateCache: true, revalidate: false })`——少了 `revalidate: false`，紧随其后的 GET 会用旧值覆盖刚写入的新值（表现为主题弹回去）。

---

## 9. 测试

测试文件与被测模块**同目录、同名加 `.test.ts(x)`**；纯函数标 `// @vitest-environment node`（或继承 `vitest.node.ts`），组件用 jsdom（`vitest.jsdom.ts`）。**新增的每条回归守卫都要做变异验证**：把要拦的缺陷人为制造回去、确认该守卫**失败**，再还原并核对文件哈希（本项目已多次证明「看起来正确」的断言毫无区分力）。

| 测试文件 | 关键守卫（具体断言见实施计划中对应代码块） |
|---|---|
| `contracts/errors.test.ts` | 错误码集合一次定稿；`ServiceError` 的 `code`/`message`/`context`/`name` 形状；每个错误码都有 ≥400 的 HTTP 映射，无遗漏 |
| `contracts/settings.test.ts`（11 例） | 默认值本身能过 schema（防默认值与契约漂移）；拒绝非法 `theme`、非正 / 非整数的 diff 预算；**契约里没有 `rowTimeoutMs` 这一格，且旧配置里多出来的那一键不会让解析失败**（这条走的是 `SettingsSchema.safeParse`，zod 的对象语义会把未知键 strip 掉；**读盘路径丢键的机制不是它**，见 §8 第 1 条的现状说明）；`defaultJudge` 必须成对或 `null`、`effort` 可缺省且 `''` 不放行；`defaultJudgeAgent` 只认三家；补丁允许空对象与部分更新，且不能绕过校验 |
| `core/logger.test.ts` | 级别门控；上下文真的作为 `console` 第二参数到达（循环引用不抛）；`DEBUG` 默认关、置 `AIEVAL_DEBUG=1` 开、且是**运行时**读（同一 logger 实例前后两次调用可不同） |
| `core/config-store.test.ts` | 缺文件返回完整默认值；缺失字段归一化；两次读取互不影响；**嵌套字段不与共享默认值别名**（`structuredClone` 的实际意义）；BOM 容忍；损坏抛含路径中文 `ServiceError`；原子写断言**调用序列**（`write:*.tmp` → `rename`、创建即 `mode 0600`、不先删目标、不直写目标） |
| `core/paths.test.ts` | `~` 只替开头、相对路径绝对化、已是绝对路径原样返回；默认根与 `contracts` 默认值同源；**真写探针再删**（mock 断言写入/删除调用）；写入失败 / 被同名文件占住 / 空白串 → `NOT_WRITABLE` 且文案可区分「无法创建」与「不可写」；`resolveRootForRead` **不碰磁盘** |
| `api/settings.test.ts`（13 例） | 读取归一化（`~` 展开为绝对路径）、读取时**不做**可写性校验（存量根目录不可用也能打开设置页）；改动落盘；**只有改 `workspaceRoot` 才校验**（数 `validateWorkspaceRoot` 的 spy 次数）；校验失败不落盘；显式 `workspaceRoot: undefined` 回落默认值；存量根目录不可用时只改主题仍能保存；`saveConfig` 抛裸 errno → 折成带配置目录的中文 `INTERNAL` |
| `web-next/server-context.test.ts`（9 例） | 三段映射：`ZodError` → 400 + `context[0].path`；`InvalidRequestBodyError` → 400 固定文案；普通 `SyntaxError` → 500，且 message **不含**「请求体不是合法 JSON」（「message 恰为『服务端内部错误』」那条精确等式在**未知错误**用例里——两条同属一个折叠分支，别把它们记混）；未知错误不泄漏原始 message/context；`context` 缺省时响应里不出现该键；**体已被读过（`TypeError`）→ 原样抛出**；4xx 不打 `console.error`、5xx 打一次 |
| `web-next/route-settings.test.ts` | 走 `@/*` 别名端到端调 `PUT`：合法补丁 200 且**真的落盘**；非法取值 400 且 `context[0].path` 正确、**被拒的补丁不得落盘**（这条才钉得住「parse 先于 update」的顺序）；坏 JSON → 400 固定文案且不带 `context` 键。它同时是 `@/*` 别名在 vitest 里的守卫（缺 `resolve.alias` 会在收集阶段失败） |
| `client/http.test.ts` | URL 原样交给 `fetch`；非 2xx → `ServiceError` 且 code/message/context 透传；响应非 JSON / 缺 `error` 字段 → 兜底 `INTERNAL` + `HTTP <status>`，错误路径不二次抛错；四方法的动词、请求体与 content-type |
| `client/settings.test.tsx` | 首帧 GET 的 URL 就是 cache key（`/api/settings`）；PUT 成功后回写缓存且**不再发 GET** 覆盖（`revalidate: false`）。每个用例挂独立 SWR cache（默认 cache 是模块级单例，会串味） |
| `ui/theme-resolve.test.ts` | `auto` 跟随系统、显式值忽略系统；无 `window` / 无 `matchMedia` → 深色兜底 |
| `ui/density.test.ts` | 明暗两侧实效字号均为 12 / 11 / 14；**反例**：显式写 `fontSize: 12` 会得到 10（把这条错误写法钉在测试里，防止有人「补回来」） |
| `ui/app-theme.test.tsx`（8 例） | 三处消费点同步：`data-theme` / `data-theme-preference`、`apply=false` 都不写、**`ConfigProvider.config` 全局配置真的被写入**（读回器必须从 `antd/lib/config-provider` 取 `globalConfig`，`antd/es/…` 在 Vitest 下是另一个模块实例、恒为 undefined）；订阅 `prefers-color-scheme` 并在卸载时清理（断言查询串就是 `SYSTEM_DARK_QUERY`） |
| `ui/page-shell.test.tsx`（10 例） | 纵向 Flex / `width:100%` / `minWidth:0` / `height:100%`；**不设 `alignItems`**；默认不落 padding/gap；**三种 `scroll` 模式都带 `minHeight: '0px'`**（只有 `inner` 额外 `overflow:auto`）；密度只能靠子组件 `theme.useToken()` 探针观察——compact 实效 12、`density="default"` 回落 14、明暗底色不同 |
| `ui/stored-preference.test.tsx`（12 例） | 无 `window` / `getItem` 抛错 / **`window.localStorage` 属性访问抛错** / 脏值 → 回落 seed；`useStoredWidth` 首帧为 `clamp(seed)`（在**渲染期**逐帧记录观测）、挂载后读出存量并夹紧、越界夹紧、`setItem` 抛错不抛且本次会话仍生效 |
| `ui/split-pane.test.tsx`（4 例） | 两栏顺序（`start` / `end`）；两栏宿主都可滚动（`overflow: auto`）、`height: 100%`，且 `minWidth` 是 `'0px'`（**`minHeight` 同处也写了 `'0px'`，但用例只断言了 `minWidth`**——别把它当已受守卫的项）；**`sideWidth` 落成 Panel 的内联 `flexBasis` / `flexGrow`**（只断言「有分隔条」抓不到 `defaultSize` 被删）。`collapseBelow` 有意不设守卫（jsdom 里容器宽未测量，删掉它没有 DOM 可观测量） |
| `ui/resizable-columns.test.tsx`（21 例） | 比例还原：够宽原样、过窄按比例且不破 `min`/`max`、**预算精确等于 `available - 6×handle`**、`available<=0` / `total=0` 原样返回、**弹性列在收缩路径上原样回填**；Panel 内联 flex 证明「弹性列不给 `size`、非弹性列给 `size`」且 size 跟随 props；**栏增减后重新收集并观察新宿主**（改 effect 依赖会被这条抓住）；无 `ResizeObserver` 时兜底上报各栏初值；卸载时两个观察器都 `disconnect`；DOM 嵌套是 `Layout > Layout.Content > Splitter`；`role="separator"` 在 `.ant-splitter-bar-dragger` 上 |
| `ui/list-detail-layout.test.tsx` | `detailOpen=false` **与** `detail=null` 都退化为单栏（断言没有栏宿主、没有分隔条）；拖拽把右栏宽度回写进 `size` 与偏好（合成 mousedown/mousemove，靠 `offsetWidth` 桩让容器可拖）；容器比偏好窄时按比例还原并夹到 `min`；首帧用 seed、挂载后还原存量宽度 |
| `ui/format.test.ts` | 字节：0 / 负 / `NaN` / 超 TB 不进位；短哈希默认 7 位、比长度短时原样；时间：ISO → 本地且**输出形状**为 `YYYY-MM-DD HH:mm`（排除「原样返回 ISO」的实现）、非法输入原样返回 |
| `ui/ellipsis-text / empty-state / toolbar.test.tsx` | 渲染与**结构断言**：空串不包 `Tooltip`（元素层断言，DOM 层不可观测）、无 `description` 时根容器子节点数为 2、无 `extra` 时动作容器不渲染（子节点数为 1） |
| `ui/composite/app-top-nav.test.tsx` | 导航项渲染、点击回调 `href`、当前项 `aria-current="page"`；**不再渲染产品名与主题切换**（守「入口唯一」）；带 `icon` 的导航项渲染图标且 `aria-hidden`（可访问名仍只有文案）；顶栏有显式 `height: 40px` 与 `flexShrink: 0` |

**表里的路径是包内相对简写**：`contracts/…` = `packages/server/contracts/src/…`，`core/…` / `api/…` = `packages/server/{core,api}/src/…`，`ui/…` = `packages/client/ui/src/base/…`（表里带 `composite/` 的那行按字面拼），`client/…` = `packages/client/client/src/…`，`web-next/…` = `apps/web-next/src/…`（§9 表里两个 web-next 文件都在 `src/` 下）。**注意这个简写不覆盖路由**——`app/api/**/route.ts` 在 `apps/web-next/app/` 下，不在 `src/` 里。括号里的用例数是 **2026-10-08 逐文件实测**（统计 `it` / `test` 调用点；这 23 个文件里 `skip` / `todo` / `it.each` 均为 0，故静态计数即运行时收集数）；没标数字的表示该条数不构成口径。其中 `ui/resizable-columns.test.tsx` 已按实测从「22 例」更正为 **21 例**（该文件自脚手架提交起就是 21 例，原数字是笔误）。

组件测试才用 jsdom，纯函数测试标 `// @vitest-environment node`。

**冒烟（脚手架期）**：真实起服务（:3083），按 §7.3 的 11 项交互清单逐项在浏览器中操作，并记录证据（页面状态 + 浏览器实际计算出的 `getBoundingClientRect()` 宽度，避免「看起来变了」）。第 3、9、11 项必须留证。原始记录在 `../notes/2026-09-22-scaffold-smoke.md`。**这份清单随 `/demo` 一起失效**（页面已删除），功能阶段的冒烟口径见 `2026-09-22-features-design.md` 与各功能计划。

---

## 10. 实施顺序（= 实施计划的 14 个任务）

每个任务都遵守「先写失败测试 → 跑一遍确认失败 → 写实现 → 跑测试确认通过 → 提交」；新增回归守卫必须做变异验证。

| Task | 内容 | 对应本 spec |
|---|---|---|
| 1 | monorepo 骨架 + 8 包空壳 + 边界探针（含 `apps/web-next/src/index.ts` 占位、`client/src/testing/setup.ts`；边界要用五条「必须失败」+ 两条「必须放行」的探针实测） | §4、§5 |
| 2 | `contracts`：统一错误模型（错误码 + `ServiceError` + HTTP 映射） | §8 第 1 条 |
| 3 | `contracts`：`Settings` 契约（默认值 + 部分更新补丁 + 边界校验） | §8 第 1 条 |
| 4 | `core`：`logger` + `config-store`（原子写 / BOM / 0600 / 归一化 / 损坏报中文原因） | §5.7、§8 第 2 条 |
| 5 | `core`：`paths`（`~` 展开、默认根、`resolveRootForRead`、真写探针校验） | §4.2（`core` 那一行）、§9 的 `core/paths.test.ts` 行 |
| 6 | `api`：`getSettings` / `updateSettings`（读取只展开、改根目录才校验、errno 折中文） | §8 第 3 条 |
| 7 | `web-next`：`src/server-context.ts` + `/api/settings` + `route-settings.test.ts`（`@/*` 别名与整条链路的守卫） | §8 第 4 条 |
| 8 | `client`：`http` 四函数 + `useSettings`（错误路径不二次抛错、回写不被 GET 覆盖） | §8 第 4 条 |
| 9 | `ui`：主题解析（两个文件）、紧凑密度 + `DensityProvider`、`PageShell` | §6.1–§6.4 |
| 10 | `ui`：`stored-preference`、`SplitPane`、`ResizableColumns` + `restoreWidthsToAvailable` + ResizeObserver 桩 | §6.5–§6.7、§6.12 |
| 11 | `ui`：展示原语、`format.ts`、`ListDetailLayout` | §6.8、§6.9、§6.11 |
| 12 | `web-next`：应用壳（`layout` / `providers` / `globals.css`）、顶栏、`/settings`（仅主题项）、`/cases` 与 `/runs` 占位页 | §6.1、§6.2、§6.10、§8 |
| 13 | 示例页：`demo-fixtures.ts` + `DemoListPage` + `/demo` + 11 项交互冒烟记录（**产物已全部删除**，见 §7） | §7 |
| 14 | 验收：三条命令 + §11 完成标准逐条 + BOM 复验，并留下记录 | §11 |

---

## 11. 完成标准（脚手架阶段 Definition of Done）

- [x] `pnpm install` 成功，且非 pnpm 环境的安装被 `preinstall` 拒绝。
- [x] `pnpm dev` 起在 `http://localhost:3083`。
- [x] 故意在 `core` 里 `import 'react'`，`pnpm lint` **报错**（边界真的生效，不是纸面约束）。
- [x] 顶栏三项可跳转，当前项高亮。
- [x] 亮/暗/跟随系统三档都能切，且**页面底色**与组件同时变（无半亮态）。
- [x] `/demo` 的 11 项交互清单逐项跑过并留证——**但不是 11 项全过**：第 4、6 项是已接受、本期不修的弱点，第 11 项只算半过，第 10 项压根没在页面上跑到（见 §7.3 每项的注记）。**该页与这份清单现已随示例页删除而不可复跑，只存历史记录**，见 §7 开头的说明。
- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令零错误。
- [x] `/settings` 的主题项可保存，刷新后保持；配置文件里出现 `~/.aieval/config.json`。
- [x] 故意把配置文件改成非法 JSON，页面给出**含路径的中文原因**，且不是「请求体不是合法 JSON」。

**本节的实测状态（2026-09-24 复核）**：九条全部达成，故上面已全部勾选；**但第 6 条要按 §7.3 的逐项注记读**——那 11 项里有 **4 项**没真正过：第 4、6 项是已接受、本期不修的弱点，第 11 项只算半过（其中「页面溢出 25px」的那一半后来才靠 `PageShell` 无条件给 `minHeight: 0` 修掉），第 10 项在页面上根本没跑到（拿临时用例验的，且那半条滚动条断言没有证据来源）。「顶栏三项可跳转」与「三档主题」的入口分别在顶栏与**设置页**（顶栏没有主题切换）。验收证据写在 `docs/superpowers/notes/2026-09-22-scaffold-smoke.md`，**没有**单独产出 `2026-09-22-scaffold-acceptance.md`。

**2026-10-08 补充**：第 6 条对应的页面已删除，这条**不可复跑**（不是「复跑失败」）；其余八条描述的都是仍然存在的能力，可随时按原判据重验——注意第 3 条的 `pnpm lint` 现在走仓库根一个进程（§5.4），报错文案仍是 `[分层边界] core 禁止 import react（见 docs/superpowers/specs/2026-09-22-scaffold-design.md §4.1）`。第 2 条的端口只指 `pnpm dev`；`pnpm start` 是 3080（§2）。

---

## 12. 从本 spec 重新生成实施计划

本 spec 是上游依据，`../plans/2026-09-22-scaffold.md` 是下游计划。生成关系（2026-09-24 复核确认）：

1. **任务划分与顺序**：计划的 Task 1–14 与 §10 的表格一一对应。
2. **代码块来源**：计划里「一个代码块 = 一个完整文件」的块 = 仓库里对应文件的**全文**，脚手架交付时逐字核对过。**「78 个」是计划自己 Task 14 记录里的数字，不要拿它当可复核的计数**：2026-10-08 实测该计划有 109 个围栏块，但「其中多少个是整文件块」取决于口径（按「Step 标题里点名了带扩展名的文件路径」数，宽严两种口径能差十几条）——引用时请说「计划里那批整文件代码块」。**此后实现继续演进，计划不再随之更新**——计划是脚手架阶段的快照，不是当前实现的真源（例如仓库根的 `tsconfig.typecheck.json` 计划里**一次都没提**；根 `eslint.config.ts` / `vitest.config.ts`（把全仓收进一个进程的那两份）也不在计划的 Create 清单里——计划里出现的同名文件都是**包级**的一行转发；`core` / `api` 的 `vitest.config.ts` 计划里虽有，但那是**当时那一版**，现在这版（`mergeConfig` + 60s 超时）不在；计划里的 `vitest.node.ts` 块也没有后来加上的 `pool` / `testTimeout` / `hookTimeout`，那三项的**当前**全文见 §5.8）。本 spec 只内联**契约与不变量**相关的代码（§5、§6、§8）；其余文件（各测试文件等）按 §4.3 的文件清单从实现取全文——spec 不重复贴它们，避免出现第二处真源。
3. **边界与守卫要求**：计划的探针清单与变异验证要求来自 §5.4 的四条加固与 §9 的守卫表。
4. **冒烟清单**：= §7.3 的 11 项（第 8 项的入口是设置页，不是顶栏）。**该清单随 `/demo` 删除而失效**。
5. **口径修正**：凡本 spec 与实现不一致处，以**实现**为准并回写本 spec。已回写的四批：
   - **2026-09-24（脚手架交付时）**：`allowBuilds`、`eslint.shared.ts` 四条加固、`resolveRootForRead`、`useStoredWidth` 挂载后读、`restoreWidthsToAvailable` 的弹性列早返回、`ListDetailLayout` 的 `showDetail`、顶栏无主题切换、`Alert title`、vitest 双配置与 `@/*` 别名、`next.config.ts` 的 `transpilePackages`。
   - **2026-10-08（本轮逐节复核）**：§4.1 的依赖方向表（补 `api → agents`、`core → contracts`、`contracts → 无`，以及「类型转出不算依赖边」）、§4.2 的依赖列与 `core` 不再自定义 `ProviderRecord` / `TestCaseRecord`、§4.3 与 §7 标注 `/demo` 三件套已删除、§5.1 的 `allowBuilds` 七项、§5.2 三条聚合命令改走根配置（不再 `pnpm -r`）与新增 `test:changed`、§5.3 的 `start -p 3080` 与三家厂商 SDK、§5.4 `eslint.shared.ts` 全文（`workspaceConfig` / `scopeToDir` / `boundaryConfigs` / `probe/dumps` 忽略 / 选择器双引号）、§5.8 两处 vitest 共享配置的完整实现与仓库根 `vitest.config.ts`、§5.9 的 `serverExternalPackages`、§6.1 `globals.css` 的两组动效类、§6.2 的 `readAppliedThemeMode` / `useAppliedThemeMode` 与 `providers` 的 locale、§6.8 的 `PANE_PADDING`、§6.9 的「现状」列（`CopyOnClick` / `OperationStatus` 至今未实现）、§6.10 的 `icon`、§6.12 的 `matchMedia` 桩、§8 的 Settings 字段变更与 `/settings` 四 Tab、§9 的 `resizable-columns` 用例数（22 → 21）与 `app-top-nav` 路径、§11 的勾选状态、§12 本文。
   - **2026-10-08（第三轮：内部一致性与复验回报后回写）**：§1 的示例页交叉引用清单改为非穷举（补 §4.2、§6.4 与 §9–§12 的记录）、§3 的 S6 补「三件东西不都在 contracts」与 `AgentErrorCode` 不进 `ERROR_CODES`、§6.8 末尾补「比例收缩在真实浏览里没有生效」指向 §7.3 的警示、§7.3 的错位说明补上第 10 项、§8 第 3 条补三个口径、§9 的 `contracts/settings.test.ts` 行把「zod strip」限定为**契约测试**的路径（读盘不是它）、§9 的路径简写注明不覆盖 `app/` 下的路由、§10 Task 5 的引用由「§8 第 2 条」改为 §4.2 与 §9（§8 第 2 条只讲 config-store）、§11 第 6 条与实测状态改成「逐项跑过但不是全过」、§12 第 2 条换掉被 §5.8 内联后失效的例子。
   - **2026-10-08（第四轮起：多轮独立子智能体对抗核查的累积回写）**：§1「明确不做」四条各补现状（去掉重复的免责句）、§4 树补 `scripts/`、§4.3 改成「只标删除、不补新增」、§2 的 TypeScript 行与端口行、§3 的 S6 改成「三件事的**载体**不都在同一个包」、§5 头补「注释里的计数已过期」（含正确的文件名归属与 `core 40s` 这个过期例子）、§5.2 的 `typecheck` 并集限定（未含 `instrumentation.ts`）、§5.4 加固 1 的选择器引号、§5.5「库包 JSX 由谁处理」的更正（构建期是 Next 的 `transpilePackages`）、§5.8「5 个一行转发 + core/api 各 60s」、§5.9 注释里 `spec §5.6.2` 的指向说明、§6.1 五个主题变量的**实际**消费点、§6.3 补「复核要用 `getDesignToken`」并订正「测试覆盖了几行」、§6.5 坑 1 区分「栏间距（本组件的 CSS gap）」与「`styles.dragger` 命中带」+ 变量名以运行时为准、§6.6 把「该纯函数的口径」与「与之无关的 aria 不变量」拆开、§6.7「写入失败仍生效」的前提、§6.8 实现要点区分「静止走比例还原 / 拖动走 `renderWidth`」、§6.8 与 §7.3 的阈值说法（`available ≥ preferredWidth + 6`）、§6.9「代码里搜不到」与中止按钮的真实位置、§6.10 `aria-current` 注（antd 无此属性，是组件自己给的）、§7.2/§7.3 的逐项注记与「与冒烟记录不是同一份清单」、§8 的 `rowTimeoutMs` 丢键机制（不是 zod）与第 3 条三口径、§9 的 `server-context` 断言归属、`split-pane` 的 `minHeight` 限定、包内路径简写（`ui/…` = `src/base/…`）、§11 的勾选与「4 项没真正过」、§12 第 2 条与「三批→四批」。
   > 这一批是**多轮「开子智能体查 → 修 → 再查」累积出来的**，每一条都对应一次实际发现；过程记录见本文件头部状态行与各节的「现状（2026-10-08）」括注。

**功能面的落点**：建立在脚手架之上的一切功能面（智能体评分与结构化评分输出、评分标准项、远端 git 来源、上下文窗口与思考强度、单行执行与重新评分、评测的修改与删除、变更详情抽屉、测试墙钟、子智能体用量与轮次口径）**全部写在 `2026-09-22-features-design.md`**，本文档不再保留功能面章节。落地这些功能面的计划（`2026-09-26-agent-judge` / `2026-09-26-remote-git-source` / `2026-09-28-agent-context-window` / `2026-09-28-run-edit-delete` / `2026-09-28-structured-judge-output` / `2026-09-28-test-speedup` / `2026-09-29-diff-drawer-redesign` / `2026-09-29-rubric-scoring`）的 spec 指向应改为该文档的对应小节。**这份清单只列到 2026-09-29**；此后 `../plans/` 下又新增了 `2026-09-30-dsh-dual-protocol`、`2026-10-04-*` ~ `2026-10-07-*` 等计划，取当前全量请直接列目录。

**交付实况（脚手架交付时，2026-09-24）**：`pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令全绿（8 个包）；`README.md` 与 `AGENTS.md` 不是本 spec 的产出，但仓库里存在，按本 spec 重生成代码时不要遗漏它们。（`AGENTS.md` 在脚手架期叫 `AGENT.md`，`8130b80` 里改名。代码注释里残留的旧文件名已在 2026-10-08 的注释清理中全部改正。）
