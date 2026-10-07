# AI 生成代码评测工具 —— 脚手架设计（初始化项目）

日期：2026-09-22
状态：**已实现**（2026-09-24 复核；由本文档生成实施计划 `../plans/2026-09-22-scaffold.md`）
范围：**只做框架**。搭好 monorepo、分包、界面原语、主题、列表 + 右边栏示例页，使后续三个功能域可以并行往上填。
配套文档：功能设计见同目录 `2026-09-22-features-design.md`；实施计划见 `../plans/2026-09-22-scaffold.md`（本 spec 是它的上游依据，对应关系见 §12）。
性质：本文档**自包含**——技术栈、脚手架配置、界面原语的实现契约与关键代码全部内联，实施时不需要参照任何外部仓库。

**章节分工**：§1–§12 是脚手架本身（包结构、配置、界面原语、示例页、最小服务端连通性、测试口径）；
**§13 是建立在脚手架之上的十个功能面**（智能体评分、结构化评分输出、评分标准项、远端 git 来源、
上下文窗口与思考强度、单行执行、评测修改/删除、变更详情抽屉、测试墙钟、子智能体用量与轮次口径）。
新功能一律先读 §4.1 的依赖方向与 §13 对应小节，再动手。

---

## 1. 本文档要交付什么

一句话：**一个能跑起来的空壳 + 一个证明空壳可用的列表示例**。

具体交付物：

1. pnpm monorepo，8 个包全部建好，`withBoundary` 分层边界生效（越界 import 直接报错）。
2. Next.js 应用在 `:3083` 起得来，顶栏（用例 / 评测 / 设置）可见可点。**顶栏不含主题切换**——主题的唯一入口在设置页（见 §6.10）。
3. 亮/暗双主题落地，**三处消费点同步**（组件、CSS 底色、静态 portal），跟随系统开关即时生效。
4. 界面原语就位：`PageShell`、`SplitPane`、`ResizableColumns`、`stored-preference`、紧凑密度、空态等。
5. **一个列表示例页**：左侧列表 + 右侧可拖拽宽度详情栏，宽度刷新后还原 —— 用来证明第 2–4 项真的能用。
6. `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令全绿。

**明确不做**（属于功能阶段）：

- 任何真实业务数据。示例页用内存里的假数据，不落盘、不调接口。
- 供应商 / 用例 / 评测三个功能域。
- 三个智能体适配器、编排状态机、评分器、SSE 流。
- 任何 `/api` 路由（除 `/api/settings` 这一条用于验证连通性的最小接口）。

**示例页是过渡产物**：功能阶段实现真实用例管理页时，删除 `/demo` 路由。它的价值在于把「原语能不能组合出目标形态」这件事在写业务之前就验证掉——尤其是右边栏的可拖拽宽度与刷新还原，这类问题越晚发现返工越贵。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 包管理 | pnpm（workspace，`preinstall` 强制只允许 pnpm） |
| 框架 | Next.js 16（App Router：Server Components + Route Handlers） |
| 语言 | TypeScript 5（全链 `tsc --noEmit`） |
| UI 组件库 | antd 6 + `@ant-design/icons` |
| 数据层 | SWR 2（REST）——本阶段只用它做 GET/PUT；EventSource（SSE）属于功能阶段，脚手架期不装、不写 |
| 契约 | zod 3（运行时校验 + 类型推导，服务端与客户端共享） |
| 测试 | vitest 4 + node（纯函数）/ jsdom（组件） |
| 样式 | **一律走 antd**：主题 token / 紧凑密度 / 语义 `styles`。不引入 Tailwind 等工具类框架；不手写字号；不手调行内边距；避免裸写 `div`（antd 无「可滚动通用盒子」原语时除外，需在注释中写明理由） |

端口：**3083**（`next dev -p 3083` / `next start -p 3083`）。

---

## 3. 关键决策与理由

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| S1 | 严格分层分包：`core`（零依赖）/ `agents` / `evaluator` / `api`（禁框架）+ `contracts` + `ui` + `client` | 边界即架构：`core` 保持零依赖可独立测试，`api` 不碰框架，`ui` 不调接口。三个智能体 SDK 是重量级外部依赖，单列 `agents` 才不会污染 `core` 的零依赖边界 | 单应用平铺（改一处牵动全身，无法对 `core` 做零依赖测试） |
| S2 | 只做一个 Next.js 应用，后端收敛进 Route Handlers | 少一个应用的重复装配；该形态足以撑住百级路由 | 双下游应用（多一份重复装配，收益为零） |
| S3 | 脚手架阶段就把 8 个包全部建好（含空实现） | 边界规则只有在「包真实存在」时才被 eslint 校验；后补包会导致边界被一次性冲击。空包成本近零 | 先建用到的包、按需增包（分层约束形同虚设） |
| S4 | 偏好记忆放 localStorage，URL 只记视图状态 | 栏宽是**个人显示偏好**（怎么读界面），不是「在看什么」——同一份链接发给别人时不该把自己的栏宽带过去 | 全部放 URL（链接共享时串味）；全部放 localStorage（深链接无法还原看的是哪一条） |
| S5 | 边栏宽度用「像素偏好 + 按可用宽比例还原」而非百分比 | 窗口变窄时若不做比例还原，`Splitter` 只能硬夹到 `min`，栏间比例会跳变 | 存百分比（像素语义更直观、夹紧边界更好表达）；不做还原（刷新回到旧值） |
| S6 | 错误模型在脚手架阶段定型（错误码 + HTTP 映射 + 专属请求体标记类型） | 后续所有路由都依赖它，晚定会各处自拼 HTTP 错误、文案与状态码必然漂移 | 各路由自行拼错误响应 |

---

## 4. 仓库与分包结构

```
ai-result-evaluation/                    # 包名前缀 @aieval/*
├── apps/
│   └── web-next/            # Next.js 16 薄组装：页面壳 + Route Handlers（:3083）
├── packages/
│   ├── server/
│   │   ├── contracts/       # zod 契约 + 错误码（本阶段：错误模型 + Settings 契约）
│   │   ├── core/            # 零依赖基础能力（本阶段：logger + config-store + paths）
│   │   ├── agents/          # 智能体抽象层（本阶段：空出口 `export {}`）
│   │   ├── evaluator/       # 编排与评分（本阶段：空出口 `export {}`）
│   │   └── api/             # 业务服务层，禁框架（本阶段：settings 读写）
│   └── client/
│       ├── ui/              # 纯展示组件（base + composite）+ 测试用 testing/，不调接口
│       └── client/          # 数据层（本阶段：http 四函数 + useSettings）
├── docs/
├── README.md / AGENT.md     # 项目说明与协作约束（不在本 spec 的产出清单里，但仓库里存在）
├── eslint.shared.ts         # 共享规则 + withBoundary 分层硬约束
├── vitest.node.ts           # 纯函数测试的共享配置（node）
├── vitest.jsdom.ts          # 组件测试的共享配置（jsdom + setup）
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .editorconfig
├── .gitignore
└── package.json
```

### 4.1 依赖方向（硬约束）

```
web-next → api / core / ui / client / contracts
api      → evaluator / core / contracts
evaluator→ agents / core / contracts
agents   → core / contracts
ui       → contracts
client   → contracts
core     → 无（Node 内置模块之外零依赖）
```

`web-next` 的路由**只做三件事**：zod 校验请求 → 调 `api` → 错误映射。业务逻辑一律不下沉到路由文件。

### 4.2 各包在本阶段的实际内容

| 包 | 本阶段内容 | 依赖（生产） |
|---|---|---|
| `contracts` | `ERROR_CODES` / `httpStatusFor` / `ServiceError`；`SettingsSchema` / `SettingsPatchSchema` / `DefaultJudgeSchema` / `ThemeModeSchema` / `SETTINGS_DEFAULTS` + 类型 | zod |
| `core` | `logger`（`createLogger(scope)`，DEBUG 运行时读 `AIEVAL_DEBUG`）；`config-store`（原子写 + BOM 容忍 + 创建即 0600 + 缺失字段归一化 + 损坏抛含路径中文原因；`ProviderRecord` / `TestCaseRecord` / `AppConfig` 形状在此定义）；`paths`（`expandHome` / `defaultWorkspaceRoot` / `resolveRootForRead` 只展开不碰磁盘 / `validateWorkspaceRoot` 真写探针） | 无（Node 内置 + `contracts`） |
| `agents` | 空出口 `export {}`——**接口定义与假适配器都推迟到功能阶段**（脚手架期没有消费者，写了就是死代码） | 无 |
| `evaluator` | 空出口 `export {}` | 无 |
| `api` | `getSettings` / `updateSettings`（读取只展开不校验、改根目录才校验、`saveConfig` 的裸 errno 折成带配置目录的中文 `INTERNAL`） | `core` / `contracts` / `evaluator` |
| `ui` | §6 的全部原语 + `composite/`（顶栏、示例页展示组件）+ `testing/`（setup、ResizeObserver 桩） | antd / `@ant-design/icons` / react / `contracts` |
| `client` | `http` 四函数（`getJson` / `postJson` / `putJson` / `delJson`）、`useSettings` | swr / react / `contracts` |
| `web-next` | SSR 壳、`providers`、顶栏、`/cases`、`/runs`、`/demo`、`/settings`（仅主题项）、`/api/settings`、`src/server-context.ts`（路由层错误出口） | 全部 |

### 4.3 完整文件清单（= 实施计划的「文件结构总览」）

生成计划时按这份清单取文件全文；`*` 表示同名加 `.test.ts(x)` 的测试文件。

```
ai-result-evaluation/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  eslint.shared.ts
├── vitest.node.ts  vitest.jsdom.ts  .editorconfig  .gitignore
├── apps/web-next/
│   ├── package.json  next.config.ts  tsconfig.json  eslint.config.ts  vitest.config.ts
│   ├── app/{layout.tsx,providers.tsx,globals.css,page.tsx}
│   ├── app/cases/page.tsx  app/runs/page.tsx  app/demo/page.tsx  app/settings/page.tsx
│   ├── app/api/settings/route.ts
│   ├── src/{index.ts（export {} 占位）,server-context.ts*,route-settings.test.ts,nav.ts}
│   └── src/testing/demo-fixtures.ts
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
    ├── ui/src/testing/{setup.ts,resize-observer.ts}
    └── client/src/{index.ts,http.ts*,settings.ts*,testing/setup.ts}
```

---

## 5. 脚手架配置（可直接落地）

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
  sharp: true
  unrs-resolver: true

onlyBuiltDependencies:
  - esbuild
```

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
    "lint": "pnpm -r lint",
    "format": "pnpm -r format",
    "test": "pnpm -r --workspace-concurrency=4 test",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@stylistic/eslint-plugin": "^4.4.1",
    "@types/node": "^20.19.43",
    "@typescript-eslint/parser": "^8.61.0",
    "eslint": "^9.39.5",
    "eslint-plugin-import-x": "^4.17.1",
    "eslint-plugin-unused-imports": "^4.4.1",
    "jiti": "^2.7.0"
  }
}
```

### 5.3 `apps/web-next/package.json`

```json
{
  "name": "@aieval/web-next",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3083",
    "build": "next build",
    "start": "next start -p 3083",
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

统一脚本口径：**7 个库包**只有 `lint`（`eslint .`）、`format`（`eslint . --fix`）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run --passWithNoTests`）——**库包没有 `build`**（它们直出 TS 源码，由 Next 的 `transpilePackages` 编译）；只有 `apps/web-next` 有 `dev` / `build`（`next build`）/ `start`。

**7 个库包的 `package.json` 必须声明 `main` / `types` / `exports` 指向 `./src/index.ts`**（否则 Next 与 vitest 解析不到）；`apps/web-next` 是应用，**不写**这三项。

### 5.4 `eslint.shared.ts` 的分层边界工厂

边界由 eslint 硬约束，不靠口头约定。`withBoundary(pkg)` 把「每包一份禁止 import 名单」展开成 `no-restricted-imports` 的 `patterns.group`。**必须用 `patterns.group` 而不是 `paths.name`**——后者是精确匹配，`next/*` 这类条目会被 `next/headers` 这样的子路径绕过。

实现里另有四条**不能省**的加固，每条都对应一条真实绕过路径（都实测过）：

1. **`no-restricted-imports` 覆盖不到动态 `import()` 与 `require()`**（它只看静态 import/export 语句）。故另配 `no-restricted-syntax`，且选择器**必须按说明符过滤**（`ImportExpression[source.value=/…/]`、`CallExpression[callee.name='require'] > Literal.arguments:first-child[value=/…/]`）：裸 `ImportExpression` 会把包自己的 `import('./x')` 一起禁掉，挡住合法的代码分割。
2. **相对路径跨包引用是盲区**：`import '../../../client/ui/src/index'` 既不是包名、也不在禁止名单里，而本仓所有库包直出 TS 源码，这种写法**真的能跑通**。用 `import-x/no-relative-packages` 关掉；但该规则内部的 `resolve()` 默认只认 `.js`/`.json` 等扩展名，**必须在 `settings['import-x/resolver'].node.extensions` 里补 `.ts`/`.tsx`**，否则它对 TS 说明符解析失败会静默 `return`——规则看着开着，却从不触发。该规则还要对 `**/{eslint,vitest,next}.config.{ts,tsx}` 豁免（它们必须相对引用仓库根配置，而根 `package.json` 自带 `name`），豁免名单**按文件名限定死**，不能写成 `**/*.config.{ts,tsx}`。
3. **源码一律 ESM，仓库里不允许 `require()`**：`tsc`（`@types/node` 声明了 `var require`）、边界规则、Vitest 的 SSR runner 三处都不拦它，只能显式禁。该常量必须在 `baseConfig` 与 `withBoundary` 的 `no-restricted-syntax` 里**各放一份**：flat config 对同一条规则是**整体替换**而不是选项合并，`withBoundary` 生成的对象排在后面且匹配同一批文件，会把 `baseConfig` 那条整条盖掉。
4. **`escapeRegExp` 必须转义 `/`**：禁止名单里的 `@aieval/client` 会被拼进 esquery 选择器的 `/…/` 字面量，漏转义会提前闭合字面量，ESLint 直接以**退出码 2 崩溃**。

```ts
/**
 * 共享 ESLint flat 配置 + 分层边界规则工厂。
 * 边界即架构：core/agents/evaluator/api/contracts 禁框架；ui 禁 client/api/apps；client 禁 apps。
 * 注意：禁止名单用 `patterns.group` 展开而不是 `paths.name`——后者是精确匹配，
 * `next/*` 这类条目会被 `next/headers` 这样的子路径绕过。
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
 */
const esmOnlyRequire: { selector: string; message: string } = {
  selector: "CallExpression[callee.name='require']",
  message: '源码一律 ESM：改用 import（仓库内不允许 require）',
};

export const baseConfig: Linter.Config[] = [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/out/**', '**/coverage/**'] },
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

/** 按包名生成带边界约束的配置（与 baseConfig 合并使用） */
export function withBoundary(pkg: PackageName): Linter.Config[] {
  const names = FORBIDDEN[pkg];
  if (names.length === 0) return [...baseConfig];
  // 说明符必须整串等于某个禁止名，或等于「禁止名 + / 至少一个字符」（子路径）。
  // `^…$` 锚定是必要的：没有它 `react` 会顺带匹配 `react-dom`。
  const forbiddenSpecifier = `^(${names
    // 名称里的正则元字符先转义（`@aieval/client` 的 `/`、`next/*` 的 `*` 都要按字面处理）
    .map((name) => escapeRegExp(name.replace(/\/\*$/, '')))
    .join('|')})(\\/.+)?$`;

  return [
    ...baseConfig,
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
            selector: `CallExpression[callee.name='require'] > Literal.arguments:first-child[value=/${forbiddenSpecifier}/]`,
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

`baseConfig` 另含统一格式规则；每个包的 `eslint.config.ts` 只调 `withBoundary('包名')`：

| 规则 | 值 | 说明 |
|---|---|---|
| `@stylistic/quotes` | `single` | 单引号 |
| `@stylistic/semi` | `always` | 语句末尾分号 |
| `@stylistic/indent` | `2` | 两空格缩进 |
| `unused-imports/no-unused-imports` | error | 禁未使用导入 |
| `import-x/no-duplicates` | error | 禁重复导入 |
| `import-x/no-relative-packages` | error | 禁跨包相对引用 |
| `no-restricted-syntax` | error | 禁 `require()`（ESM 口径） |

`baseConfig` 的 `ignores`：`**/node_modules/**`、`**/dist/**`、`**/.next/**`、`**/out/**`、`**/coverage/**`。

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

**`jsx` 必须是 `react-jsx`，不能是 `preserve`**：Vite 的 import-analysis 会直接读 tsconfig 的 `jsx`，一旦是 `preserve`，任何 `.tsx` 测试文件都以「Failed to parse source for import analysis … make sure to not set jsx to preserve」失败，而改 vitest 的 `esbuild.jsx` / `esbuild.tsconfigRaw` 都无济于事（报错来自 Vite 而非 esbuild）。库包本身没有 React 编译需求，故基座统一用 `react-jsx`；`apps/web-next` 在自己的 `tsconfig.json` 里保留 `preserve`（Next 需要它），代价是该应用内不能写 `.tsx` 测试。

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

**日志器在 `@aieval/core` 的 `createLogger(scope)`**（`logger.ts`）：`debug` / `info` / `warn` / `error` 四个方法，前缀 `[级别] [scope] message`；**上下文一律作为 `console` 的第二个参数透传，绝不 `JSON.stringify`**（后者遇到循环引用或 BigInt 会抛，而日志器不该有能力打断业务流程）。`DEBUG` 门控**每次调用时**读 `AIEVAL_DEBUG`（不是模块加载时读一次），否则测试里无法在同一进程内切换开关。

### 5.8 vitest 双配置与各包的 `vitest.config.ts`

`vitest.node.ts`（纯函数 / 库包 / web-next）：

```ts
/** 纯函数测试的共享配置：node 环境、不加载 DOM。各包 vitest.config.ts 直接复用它。 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
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
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/testing/setup.ts'],
  },
});
```

各库包的 `vitest.config.ts` 一行转发：`export { default } from '../../../vitest.node';`（`ui` / `client` 则指向 `../../../vitest.jsdom`）。

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
    resolve: { alias: { '@/': `${packageRoot}/` } },
  }),
);
```

### 5.9 `apps/web-next/next.config.ts`

7 个库包的 `main` 直接指向 `./src/index.ts`、不预构建产物，所以必须把 workspace 内的 TS 源码包纳入 Next 的编译：

```ts
/**
 * Next 配置：把 workspace 内的 TS 源码包纳入编译。
 * 这些包的 `main` 直接指向 `./src/index.ts`，不预先构建产物——Next 靠 transpilePackages 编译它们。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@aieval/contracts', '@aieval/core', '@aieval/agents', '@aieval/evaluator', '@aieval/api', '@aieval/ui', '@aieval/client'],
  reactStrictMode: true,
};

export default nextConfig;
```

---

## 6. 界面原语（内联实现契约）

本节是界面层的唯一口径。每个原语都是**新写的实现**，代码在此给全——实施时照抄本节即可。

### 6.1 文档壳与全局样式

**`app/layout.tsx`**：`<html lang="zh-CN">` + `<body>` + `<Providers>`，引入 `globals.css`；导出 `metadata = { title: 'AI 代码评测', description: '…' }`。

**`app/globals.css`**：主题底色变量 + 盒模型复位。**只放这一层壳所需的复位与变量**——字号与间距一律由 antd 主题 token 与紧凑密度供给，不在此手调。

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
```

**`.ant-app` 这段高度链必须内联到位**：`PageShell` 用 `height: 100%`，而它的父级是 antd `<App>` 渲染出的 `.ant-app` 节点。该节点默认既不是 flex 容器也没有高度，链一断，页面根就退化成内容高度，所有内部滚动随之失效——表现为整页被内容撑长、该出现的滚动条不出现。

### 6.2 主题解析（`theme-resolve.ts` 纯函数 + `app-theme.tsx` hook）

**拆成两个文件**：与 React 无关的纯函数放 `packages/client/ui/src/base/theme-resolve.ts`（口径可被单测单独锁定），React hook 放同目录 `app-theme.tsx`。

**职责**：把偏好（`auto` / `light` / `dark`）解析成实际明暗 + antd 主题配置，并落文档根属性。

**契约**：`useResolvedTheme({ preference?, apply? }) → { mode, preference, themeConfig, holderRender }`；`mode` 是**解析后**的 `'light' | 'dark'`（类型上不是 `ThemePreference`）。

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
import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './theme-resolve';

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
  /** 侧栏位置，默认 'start'；本项目的右栏一律用 'end' */
  sidePosition?: 'start' | 'end';
  /** 语义见下：只作侧栏最小宽使用 */
  collapseBelow?: number;
  /** 两栏间距（px）：原样落成 Splitter 根节点的 CSS `gap`（flex 间距，纯视觉），**不**是分隔条命中带宽度 */
  gap?: number;
}
```

参数映射：

- `sidePosition: 'start' | 'end'` → `Splitter.Panel` 的先后顺序（`Splitter` 按 children 顺序排）。
- `sideWidth` → 侧栏 Panel 的 `defaultSize`（像素）；`collapseBelow` → 侧栏 Panel 的 `min`，实现是 `const min = collapseBelow ?? sideWidth`（不传时 `min === sideWidth`，窗口再窄也不会把侧栏压没）。
- `gap` → `Splitter` 根节点的 CSS `gap`（纯视觉间距）。**不要**去覆盖 `styles.dragger`——它会整个替换 antd 的 dragger 样式，传 `width` 会把命中带改成 0（见下方坑 1）。

**已记录的边界**：本适配**不支持纵向堆叠**——`Splitter` 没有等价开关，故改为「始终保持左右并排 + 夹紧最小宽」。对桌面为主的用法可接受，但 `collapseBelow` 现在只作最小宽使用，不再是「窄于它就上下堆叠」。

**两个已踩过的坑**：

1. **`styles.dragger` 会整个替换 antd 的 dragger 样式**，传 `width` 会把命中带改成 0（实测三条分隔条宽度全为 0、看不见也拖不到）。两栏间距交给 antd 自带的 `--ant-splitter-bar-size` / trigger 尺寸，不要覆盖。
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

**尺寸口径（读 antd `splitter/hooks/useSizes.js` 与 `useResize.js` 得出，四条反直觉但必须遵守）**：

1. 只要有**任何一个** Panel 带 `size`，`Splitter` 整体走 `propSizes` 分支（`sizes = propSizes.some(isNonNullable) ? propSizes : innerSizes`），没给 `size` 的栏由 `autoPtgSizes` 补剩余空间 ⇒ **弹性列必须「不给 `size`」**才是吃剩余的那一栏（给它传期望值 900 会让它钉死在 900，另一栏实测被压成 0）。不给 `size` 的实现方式是条件展开 `{...(flexible ? { min } : { size, min, max })}`，而不是传 `size={0}`。
2. `size` 是**响应式受控入口**：`propSizes` 一变，`sizes` 的 `useMemo` 立即重算并重新渲染 ⇒ **不需要用「改 `key` 强制重挂载」那种做法**（那还会顺带重置列表滚动位置）。但反过来，`defaultSize` 只在挂载时读一次（`useState(() => items.map(item => item.defaultSize))`）⇒ 想还原「上次拖出来的宽度」**必须给 `size`（像素）**，用 `defaultSize` 刷新后会回到旧值（实测拖到 145、刷新回 173）。
3. **受控模式下拖拽不会自己动，必须把 `onResize` 回写进 `size`**。原因：拖拽时 `onOffsetUpdate` 只调 `updateSizes`（即 `setInnerSizes`），而只要存在 `size` prop，`sizes` 就走 `propSizes` 分支、**完全忽略 `innerSizes`**。所以调用方必须监听 `onResize(sizes: number[])`（像素数组、每次拖动都触发）并把结果写回自己传给 `size` 的状态——不写回的表现是「拖得动但一松手弹回原位」。这也是 antd 在部分 Panel 有 `size`、部分没有却不传 `onResize` 时给出用法警告的原因。`onResize` 的触发时机：拖动过程中每次位移都会调；`onResizeEnd` 只在 lazy 模式松手时才拿到尺寸，非 lazy 模式松手走的是 `onResizeEnd(itemPxSizes)`——故**以 `onResize` 为准**，不要只监听 `onResizeEnd`。
4. **栏增减后必须重新收集栏宿主并重新挂载观察器**。`onPaneWidthChange` 靠 `ResizeObserver` 观察各栏宿主节点实现，而节点引用在一次 effect 里收集完就固定了。栏数变化（最典型的是右栏开关导致两栏 ↔ 单栏切换）后，新宿主不在被观察之列，**`onPaneWidthChange` 会从此静默失效**——不报错、只是再也不回调。故该 effect 的依赖必须含栏数，每次重新 `querySelectorAll('[data-pane-key]')` 后重新观察。同理，`data-pane-key` 是收集栏宿主的唯一钩子，改名必须同步改收集逻辑。

**难点与解法**：只有 `size` 是像素值，窗口变窄时若不按比例收，`Splitter` 只能硬夹到 `min`，栏间比例会跳变。故提供一个纯函数完成「落库的像素偏好 + 当前可用宽 → 本次渲染的像素值」，比例稳定且便于单测：
5. **比例还原时弹性列必须原样回填**：`restoreWidthsToAvailable` 对 `flexible: true` 的栏**直接返回入参宽度**，不参与按比例收、也不被 `Math.max(pane.min, …)` 抬到 `min`。少了这条早返回，宽度为 0 的弹性列会被抬成 80，与「弹性列位置原样回填」的口径不符（缩窄路径上实测）。
6. **栏宿主要带无障碍名称**：宿主 div 上写 `role="group"` + `aria-label={pane.label}`。裸 div 是 `role=generic`，而 ARIA 规范**禁止** generic 角色带名字——只写 `aria-label` 读屏取不到，必须同时给 `role`。

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

**`useStoredWidth` 必须「挂载后再读 localStorage」**（`useState(() => clampWidth(seed))` + `useEffect` 里读存量）：若在 `useState` 初始化函数里读，服务端渲染拿到 seed、客户端首次渲染拿到存量值，会产生**水合不一致**警告。挂载后读同样满足「刷新保持宽度」。首帧值 = `clamp(seed)`，`seed` 本身也参与夹紧；夹紧时先 `Math.round` 再取整。

读取路径还要兜住**两类**存储不可用：`getItem` 抛错（配额 / 安全错误）与 `window.localStorage` **属性访问本身**抛错（隐私模式 / 分区隔离）——取值必须在 `try` 内，挪到 `try` 外会炸穿到调用方。

写入失败（配额 / 禁用存储）不抛错——本次会话内的改动仍然生效，只是记不住。

### 6.8 列表 + 右边栏组合原语 `ListDetailLayout`

**这是脚手架的核心验收对象**：把 §6.5 / §6.6 / §6.7 组合成「列表 + 可拖拽宽度右边栏」这一形态的唯一出口，供示例页使用；功能阶段的用例页与评测页直接复用，不再各写一套。

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
    style: { padding: 8 },
  };

  const detailPane: ResizablePane = {
    key: 'detail',
    label: '详情',
    content: detail,
    width: Math.round(detailWidth),
    min: minDetailWidth,
    max: maxDetailWidth,
    // 右栏内容可长（用例正文、评测日志），必须自己滚：宿主默认 overflow:hidden 会把它裁掉
    style: { overflow: 'auto', padding: 8 },
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
        <div style={{ height: '100%', minHeight: 0, overflow: 'auto', padding: 8 }}>{list}</div>
      )}
    </PageShell>
  );
}

/** 分隔条命中带宽度，供调用方做几何断言时复用（避免魔法数字散落） */
export { HANDLE_HIT_WIDTH };
```

实现要点：

- 用 `ResizableColumns`，两栏：`panes[0]` = 列表（`flexible: true`，**不给 `size`**）、`panes[1]` = 右栏（给 `size`，值由 `restoreWidthsToAvailable` 从 `useStoredWidth` 的偏好与容器实测宽算出）。
- **右栏的显示条件是「开关打开」且「确实有内容」，两个都要判**：`const showDetail = detailOpen && detail !== null && detail !== undefined`。只看 `detailOpen` 时，调用方在「详情未选中」传 `detail === null` 会渲染出一条**空栏**（分隔条 + 宿主都在）——正是 `Splitter` 的 `min` 会把 0 宽 Panel 夹回来的那个缺陷。
- 退化为单栏时**不要**渲染宽度为 0 的 Panel，也不要用 `SplitPane`：直接用一个原生 `div`（`height: 100%` + `minHeight: 0` + `overflow: auto` + `padding: 8`）让列表占满。
- 根容器是 `PageShell`（`density` 默认 compact）。
- 右栏宿主样式：`{ overflow: 'auto', padding: 8 }`。宿主默认 `overflow: hidden`，不给就会把长内容裁掉且没有滚动条。
- 拖动时把**右栏像素宽**同时写进「本次渲染的 `size`」与 `useStoredWidth`（受控模式下不回写，松手会弹回）；容器尺寸变化时清掉拖动期的临时值，回到按可用宽比例还原的路径。

### 6.9 其余基础原语

均为纯 props 驱动的展示组件，放 `ui/src/base/`。**脚手架阶段只实现有消费者的那些**（消费者 = §7 示例页或设置页）；没有消费者的原语留到功能阶段实现，避免留下死代码。

| 组件 | 职责 | 脚手架阶段 |
|---|---|---|
| `EmptyState` | 空列表占位 + 引导动作（如「还没有数据 → 点这里创建」） | ✅ 示例页空态用 |
| `Toolbar` | 页内操作条（左标题 + 右动作区），全站操作条的唯一样式来源 | ✅ 示例页列表头用 |
| `EllipsisText` | 单行省略 + `Tooltip` 显全量（长路径、长 hash 用） | ✅ 示例页长字段用 |
| `formatBytes` / `formatDateTime` / `shortHash`（`format.ts`） | 展示格式化：字节数（1024 进制、负数与 NaN 按 0）、ISO → 本地 `YYYY-MM-DD HH:mm`（非法输入原样返回）、哈希取前 N 位 | ✅ 示例页表格与详情用 |
| `CopyOnClick` | 点击复制到剪贴板 + 成功提示 | ⏳ 待功能阶段（脚手架无消费者） |
| `OperationStatus` | 「进行中操作」条 + 中止按钮（`Popconfirm` 确认） | ⏳ 待功能阶段（评测运行态才有消费者） |

### 6.10 顶栏

`Layout.Header` + 横向 `Menu`（用例 / 评测 / 设置）。抽为 `composite/app-top-nav.tsx`，纯 props 驱动：`AppTopNav({ items, active, onNavigate })`——`items` 由应用层从 `src/nav.ts` 注入，`active` 是当前项 key，`onNavigate(href)` 交回应用层路由。**没有 `theme` / `onThemeChange` 这两个 props**（理由见下）。

**顶栏刻意不含产品名与主题切换**（用户口径）：产品名是装饰；主题切换的**唯一入口在设置页**（三档 `Segmented`，读 `useSettings()` 的持久化偏好）。原先顶栏也放了一份「随手切」，与设置页那份读同一状态、成为第二处真源——切换后两处可能不一致，故删除。

**顶栏必须显式给高（`height: 40`）**：antd 6 的 `.ant-layout-header { height: var(--ant-layout-header-height) }`，而这个 CSS 变量由 `Layout` 的**嵌套** ConfigProvider 作用域提供——顶栏是 `PageShell` 的兄弟节点、渲染在**根**作用域（实测根作用域里该变量为空字符串），于是声明在计算值阶段失效、`height` 退回 `auto`：顶栏塌成内容高度 **24.67px**、`padding-block` 为 0。写死 40 是实测过的确定值。这不是密度问题：顶栏本来就是默认密度。

**还必须给 `flexShrink: 0`**：顶栏与 `PageShell`（`height: 100%`）同处 `.ant-app` 这个纵向 flex，后者的 `100%` 使两者高度之和恰好超出容器一个顶栏，浏览器于是在收缩因子内把它压掉几像素——实测只写 `height: 40`、`flexShrink` 取默认 `1` 时顶栏是 **37.84px**（另一次测量为 38.27px：被压掉多少随视口高与滚动条的有无浮动，**不要把这个值当固定常数**），补上这条才是确定的 40px，且页面照样不溢出。

顶栏底色用主题变量（`background: var(--app-bg)` + `borderBottom: 1px solid var(--app-border)`），不许写死色值，否则又是一处半亮。当前项的可访问性由链接上的 `aria-current="page"` 表达（屏幕阅读器与断言都能拿到）：

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
import type { ReactNode } from 'react';

export interface AppTopNavItem {
  key: string;
  label: string;
  href: string;
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

jsdom **不提供** `ResizeObserver`，而 antd 的 `Splitter`（`@rc-component/resize-observer`）在 effect 里直接 `new ResizeObserver(...)` 读全局构造器——不打桩，任何挂载 `Splitter` 的用例都会抛 `ReferenceError`。桩放 `packages/client/ui/src/testing/resize-observer.ts`，**刻意不放进共享 `src/testing/setup.ts`**：`resizable-columns.tsx` 有一条「无 `ResizeObserver` 的环境也要把初值报一次」的兜底分支，全局注入桩会让那条分支在测试里永远不可达。需要的用例自己 `installResizeObserverStub()`。

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
 * 把替身装成全局 `ResizeObserver`。
 * 反复调用只会重设全局构造器（`afterEach` 里用 `vi.unstubAllGlobals()` 解除）。
 */
export function installResizeObserverStub(): void {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
}
```

## 7. 列表 + 右边栏示例页（脚手架验收对象）

### 7.1 目标

用**内存假数据**把「左列表 + 右可拖拽详情栏」这个形态跑通，证明 §6 的原语真能组合出目标形态。它同时是功能阶段用例页与评测页的模板。

### 7.2 路由与形态

路由 `/demo`。页面顶部放一条 `Alert`（`type="info"`，`closable`）：**「这是脚手架示例页，使用内存假数据；功能实现后本页删除。」**——避免后来者误以为它是真功能。注意 antd 6 已废弃 `Alert.message`，**必须用 `title=`**（用 `message` 会在每次加载时往 console 打一条 error，破坏「干净加载 0 条 error」的自检口径）。

```
apps/web-next/app/demo/page.tsx        # 'use client'，持有选中态与假数据
packages/client/ui/src/composite/demo-list-page.tsx   # 纯展示：ListDetailLayout + Table + 详情栏
```

**假数据**：12 条记录，字段刻意覆盖后续真实需求会用到的渲染难点：

| 字段 | 类型 | 覆盖的渲染难点 |
|---|---|---|
| `id` | 序号 | 主键 |
| `title` | 长中文标题 | 单元格省略（`EllipsisText`） |
| `path` | 长路径（如 `D:\project\some\deeply\nested\module`） | 省略 + `Tooltip` 全量 |
| `hash` | 40 位十六进制 | 表格里展示短哈希（前 7 位）、`Tooltip` 与详情栏给全量（`CopyOnClick` 属功能阶段，脚手架不实现） |
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
| 4 | 窗口从宽拖到窄 | 右栏**保持偏好宽度**、两栏都不被压没、页面不出现横向滚动条（**不是**「两栏按比例收」——比例收缩实测未生效，见下方已知弱点） |
| 5 | 窗口拖回宽 | 右栏恢复偏好宽度 |
| 6 | 双击分隔条 | ✗ **本期不做（功能缺口）**：antd 6.6.5 的 `Splitter` 未提供双击复位，且无人传 `onDraggerDoubleClick` ⇒ 双击无任何反应（详见 §6.5） |
| 7 | 未选中任何行 | 右栏不渲染，列表占满 |
| 8 | 到 `/settings` 切主题（顶栏没有主题入口） | 组件与**页面底色**同时切换（验证三处同步），无「半亮」状态 |
| 9 | 设置页主题选「跟随系统」 | 改系统深浅色，界面**即时**跟随，无需刷新 |
| 10 | 列表为空 | 显示 `EmptyState` 引导，且页面不出现多余滚动条（**注意**：`/demo` 的假数据是非空常量，这条分支在页面上走不到，由 `EmptyState` 的组件测试覆盖——冒烟记录里已如实标注） |
| 11 | 详情栏放进超长文本 | 右栏**内部**滚动，页面本身不出现纵向滚动条 |

第 3、9、11 项是这页存在的理由——它们分别验证偏好持久化、主题三处同步、高度链不断。这三类问题在写业务时才发现，返工成本最高。

**第 4 项的已知弱点（实测记录，本期不修）**：缩窄窗口时右栏一直保持偏好宽度（实测恒为 380），收缩量全部由左栏承担，左栏被压到 **88px、16px——低于它自己声明的 `min: 120`**；只有视口 ≲418 时右栏才开始按比例收（380 → 342）。原因是 `ListDetailLayout` 传给 `restoreWidthsToAvailable` 的 `total` 只统计非弹性列，故「容器比偏好宽」时 `total <= budget` 恒成立。⇒ **比例收缩在真实浏览里没有生效**，第 4 项只作「不崩」的底线；修法（扣掉弹性列的 `min`，或把左栏实测宽喂进 `widths`）留给后续任务。

### 7.4 假数据的归属

假数据放 `apps/web-next/src/testing/demo-fixtures.ts`（`testing` 目录，与生产代码物理隔离），并在文件头注释写明「仅示例页使用，功能实现后随示例页一并删除」。

---

## 8. 最小服务端连通性

脚手架期只做两件事，证明「路由 → api → contracts → client」这条链通了：

1. `contracts`：`ERROR_CODES` / `httpStatusFor` / `ServiceError` + `Settings` 的 zod schema（`theme`、`workspaceRoot`、`defaultJudge`、`rowTimeoutMs`、`diffBudgetBytes`）。
   `InvalidRequestBodyError` 与 `handleApiError` **不在** `contracts`——它们属于框架层的请求处理，落在 `apps/web-next/src/server-context.ts`（`contracts` 不含任何请求对象的概念，把它放进去会让纯契约层依赖 Web 运行时类型）。
2. `core/config-store`：原子写、BOM 容忍、缺失字段归一化、损坏时报含路径的中文原因、写盘后 `chmod 0600`。
3. `api`：`getSettings()` / `updateSettings(patch)`。
4. `web-next`：`GET/PUT /api/settings`；`client` 侧 `useSettings()`。

`/settings` 页本阶段**只实现主题那一项**（三档 `Segmented`），其余三项（供应商 / 评分配置 / 工作区）留空位或占位卡片，功能阶段补齐。

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

`client` 的 HTTP 层：同源 `/api`，非 2xx 解析 `{ error: { code, message, context? } }` → 抛 `ServiceError`（`context` 透传）；**响应非 JSON 时兜底 `INTERNAL` + HTTP 状态码**，保证错误路径本身不会二次抛错。导出 `getJson` / `postJson` / `putJson` / `delJson` 四个函数。SWR 的 mutation 成功后一律 `mutate(key, response, { revalidate: false })` 回写缓存，避免随后的 GET 覆盖刚写入的新值。

---

## 9. 测试

测试文件与被测模块**同目录、同名加 `.test.ts(x)`**；纯函数标 `// @vitest-environment node`（或继承 `vitest.node.ts`），组件用 jsdom（`vitest.jsdom.ts`）。**新增的每条回归守卫都要做变异验证**：把要拦的缺陷人为制造回去、确认该守卫**失败**，再还原并核对文件哈希（本项目已多次证明「看起来正确」的断言毫无区分力）。

| 测试文件 | 关键守卫（具体断言见实施计划中对应代码块） |
|---|---|
| `contracts/errors.test.ts` | 错误码集合一次定稿；`ServiceError` 的 `code`/`message`/`context`/`name` 形状；每个错误码都有 ≥400 的 HTTP 映射，无遗漏 |
| `contracts/settings.test.ts` | 默认值本身能过 schema（防默认值与契约漂移）；拒绝非法 `theme`、非正整数超时/预算；`defaultJudge` 必须成对或 `null`；补丁允许空对象与部分更新，且不能绕过校验 |
| `core/logger.test.ts` | 级别门控；上下文真的作为 `console` 第二参数到达（循环引用不抛）；`DEBUG` 默认关、置 `AIEVAL_DEBUG=1` 开、且是**运行时**读（同一 logger 实例前后两次调用可不同） |
| `core/config-store.test.ts` | 缺文件返回完整默认值；缺失字段归一化；两次读取互不影响；**嵌套字段不与共享默认值别名**（`structuredClone` 的实际意义）；BOM 容忍；损坏抛含路径中文 `ServiceError`；原子写断言**调用序列**（`write:*.tmp` → `rename`、创建即 `mode 0600`、不先删目标、不直写目标） |
| `core/paths.test.ts` | `~` 只替开头、相对路径绝对化、已是绝对路径原样返回；默认根与 `contracts` 默认值同源；**真写探针再删**（mock 断言写入/删除调用）；写入失败 / 被同名文件占住 / 空白串 → `NOT_WRITABLE` 且文案可区分「无法创建」与「不可写」；`resolveRootForRead` **不碰磁盘** |
| `api/settings.test.ts`（13 例） | 读取归一化（`~` 展开为绝对路径）、读取时**不做**可写性校验（存量根目录不可用也能打开设置页）；改动落盘；**只有改 `workspaceRoot` 才校验**（数 `validateWorkspaceRoot` 的 spy 次数）；校验失败不落盘；显式 `workspaceRoot: undefined` 回落默认值；存量根目录不可用时只改主题仍能保存；`saveConfig` 抛裸 errno → 折成带配置目录的中文 `INTERNAL` |
| `web-next/server-context.test.ts` | 三段映射：`ZodError` → 400 + `context[0].path`；`InvalidRequestBodyError` → 400 固定文案；**普通 `SyntaxError` → 500 且 message 恰为「服务端内部错误」**；未知错误不泄漏原始 message/context；`context` 缺省时响应里不出现该键；**体已被读过（`TypeError`）→ 原样抛出**；4xx 不打 `console.error`、5xx 打一次 |
| `web-next/route-settings.test.ts` | 走 `@/*` 别名端到端调 `PUT`：合法补丁 200 且**真的落盘**；非法取值 400 且 `context[0].path` 正确、**被拒的补丁不得落盘**（这条才钉得住「parse 先于 update」的顺序）；坏 JSON → 400 固定文案且不带 `context` 键。它同时是 `@/*` 别名在 vitest 里的守卫（缺 `resolve.alias` 会在收集阶段失败） |
| `client/http.test.ts` | URL 原样交给 `fetch`；非 2xx → `ServiceError` 且 code/message/context 透传；响应非 JSON / 缺 `error` 字段 → 兜底 `INTERNAL` + `HTTP <status>`，错误路径不二次抛错；四方法的动词、请求体与 content-type |
| `client/settings.test.tsx` | 首帧 GET 的 URL 就是 cache key（`/api/settings`）；PUT 成功后回写缓存且**不再发 GET** 覆盖（`revalidate: false`）。每个用例挂独立 SWR cache（默认 cache 是模块级单例，会串味） |
| `ui/theme-resolve.test.ts` | `auto` 跟随系统、显式值忽略系统；无 `window` / 无 `matchMedia` → 深色兜底 |
| `ui/density.test.ts` | 明暗两侧实效字号均为 12 / 11 / 14；**反例**：显式写 `fontSize: 12` 会得到 10（把这条错误写法钉在测试里，防止有人「补回来」） |
| `ui/app-theme.test.tsx`（8 例） | 三处消费点同步：`data-theme` / `data-theme-preference`、`apply=false` 都不写、**`ConfigProvider.config` 全局配置真的被写入**（读回器必须从 `antd/lib/config-provider` 取 `globalConfig`，`antd/es/…` 在 Vitest 下是另一个模块实例、恒为 undefined）；订阅 `prefers-color-scheme` 并在卸载时清理（断言查询串就是 `SYSTEM_DARK_QUERY`） |
| `ui/page-shell.test.tsx`（10 例） | 纵向 Flex / `width:100%` / `minWidth:0` / `height:100%`；**不设 `alignItems`**；默认不落 padding/gap；**三种 `scroll` 模式都带 `minHeight: '0px'`**（只有 `inner` 额外 `overflow:auto`）；密度只能靠子组件 `theme.useToken()` 探针观察——compact 实效 12、`density="default"` 回落 14、明暗底色不同 |
| `ui/stored-preference.test.tsx`（12 例） | 无 `window` / `getItem` 抛错 / **`window.localStorage` 属性访问抛错** / 脏值 → 回落 seed；`useStoredWidth` 首帧为 `clamp(seed)`（在**渲染期**逐帧记录观测）、挂载后读出存量并夹紧、越界夹紧、`setItem` 抛错不抛且本次会话仍生效 |
| `ui/split-pane.test.tsx` | 两栏顺序（`start` / `end`）；两栏宿主都可滚动且有 `'0px'` 的 `minWidth`/`minHeight`；**`sideWidth` 落成 Panel 的内联 `flexBasis` / `flexGrow`**（只断言「有分隔条」抓不到 `defaultSize` 被删） |
| `ui/resizable-columns.test.tsx`（22 例） | 比例还原：够宽原样、过窄按比例且不破 `min`/`max`、**预算精确等于 `available - 6×handle`**、`available<=0` / `total=0` 原样返回、**弹性列在收缩路径上原样回填**；Panel 内联 flex 证明「弹性列不给 `size`、非弹性列给 `size`」且 size 跟随 props；**栏增减后重新收集并观察新宿主**（改 effect 依赖会被这条抓住）；无 `ResizeObserver` 时兜底上报各栏初值；卸载时两个观察器都 `disconnect`；DOM 嵌套是 `Layout > Layout.Content > Splitter`；`role="separator"` 在 `.ant-splitter-bar-dragger` 上 |
| `ui/list-detail-layout.test.tsx` | `detailOpen=false` **与** `detail=null` 都退化为单栏（断言没有栏宿主、没有分隔条）；拖拽把右栏宽度回写进 `size` 与偏好（合成 mousedown/mousemove，靠 `offsetWidth` 桩让容器可拖）；容器比偏好窄时按比例还原并夹到 `min`；首帧用 seed、挂载后还原存量宽度 |
| `ui/format.test.ts` | 字节：0 / 负 / `NaN` / 超 TB 不进位；短哈希默认 7 位、比长度短时原样；时间：ISO → 本地且**输出形状**为 `YYYY-MM-DD HH:mm`（排除「原样返回 ISO」的实现）、非法输入原样返回 |
| `ui/ellipsis-text / empty-state / toolbar.test.tsx` | 渲染与**结构断言**：空串不包 `Tooltip`（元素层断言，DOM 层不可观测）、无 `description` 时根容器子节点数为 2、无 `extra` 时动作容器不渲染（子节点数为 1） |
| `ui/app-top-nav.test.tsx` | 导航项渲染、点击回调 `href`、当前项 `aria-current="page"`；**不再渲染产品名与主题切换**（守「入口唯一」）；顶栏有显式 `height: 40px` 与 `flexShrink: 0` |

组件测试才用 jsdom，纯函数测试标 `// @vitest-environment node`。

**冒烟**：真实起服务（:3083），按 §7.3 的 11 项交互清单逐项在浏览器中操作，并记录证据（页面状态 + 浏览器实际计算出的 `getBoundingClientRect()` 宽度，避免「看起来变了」）。第 3、9、11 项必须留证。

---

## 10. 实施顺序（= 实施计划的 14 个任务）

每个任务都遵守「先写失败测试 → 跑一遍确认失败 → 写实现 → 跑测试确认通过 → 提交」；新增回归守卫必须做变异验证。

| Task | 内容 | 对应本 spec |
|---|---|---|
| 1 | monorepo 骨架 + 8 包空壳 + 边界探针（含 `apps/web-next/src/index.ts` 占位、`client/src/testing/setup.ts`；边界要用五条「必须失败」+ 两条「必须放行」的探针实测） | §4、§5 |
| 2 | `contracts`：统一错误模型（错误码 + `ServiceError` + HTTP 映射） | §8 第 1 条 |
| 3 | `contracts`：`Settings` 契约（默认值 + 部分更新补丁 + 边界校验） | §8 第 1 条 |
| 4 | `core`：`logger` + `config-store`（原子写 / BOM / 0600 / 归一化 / 损坏报中文原因） | §5.7、§8 第 2 条 |
| 5 | `core`：`paths`（`~` 展开、默认根、`resolveRootForRead`、真写探针校验） | §8 第 2 条 |
| 6 | `api`：`getSettings` / `updateSettings`（读取只展开、改根目录才校验、errno 折中文） | §8 第 3 条 |
| 7 | `web-next`：`src/server-context.ts` + `/api/settings` + `route-settings.test.ts`（`@/*` 别名与整条链路的守卫） | §8 第 4 条 |
| 8 | `client`：`http` 四函数 + `useSettings`（错误路径不二次抛错、回写不被 GET 覆盖） | §8 第 5 条 |
| 9 | `ui`：主题解析（两个文件）、紧凑密度 + `DensityProvider`、`PageShell` | §6.1–§6.4 |
| 10 | `ui`：`stored-preference`、`SplitPane`、`ResizableColumns` + `restoreWidthsToAvailable` + ResizeObserver 桩 | §6.5–§6.7、§6.12 |
| 11 | `ui`：展示原语、`format.ts`、`ListDetailLayout` | §6.8、§6.9、§6.11 |
| 12 | `web-next`：应用壳（`layout` / `providers` / `globals.css`）、顶栏、`/settings`（仅主题项）、`/cases` 与 `/runs` 占位页 | §6.1、§6.2、§6.10、§7.2 |
| 13 | 示例页：`demo-fixtures.ts` + `DemoListPage` + `/demo` + 11 项交互冒烟记录 | §7 |
| 14 | 验收：三条命令 + §11 完成标准逐条 + BOM 复验，并留下记录 | §11 |

---

## 11. 完成标准（脚手架阶段 Definition of Done）

- [ ] `pnpm install` 成功，且非 pnpm 环境的安装被 `preinstall` 拒绝。
- [ ] `pnpm dev` 起在 `http://localhost:3083`。
- [ ] 故意在 `core` 里 `import 'react'`，`pnpm lint` **报错**（边界真的生效，不是纸面约束）。
- [ ] 顶栏三项可跳转，当前项高亮。
- [ ] 亮/暗/跟随系统三档都能切，且**页面底色**与组件同时变（无半亮态）。
- [ ] `/demo` 的 11 项交互清单全部通过并留证。
- [ ] `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令零错误。
- [ ] `/settings` 的主题项可保存，刷新后保持；配置文件里出现 `~/.aieval/config.json`。
- [ ] 故意把配置文件改成非法 JSON，页面给出**含路径的中文原因**，且不是「请求体不是合法 JSON」。

**本节的实测状态（2026-09-24 复核）**：九条全部达成。其中「顶栏三项可跳转」与「三档主题」的入口分别在顶栏与**设置页**（顶栏没有主题切换）；`/demo` 的 11 项里第 4、6 项是**已接受、本期不修**的弱点（见 §7.3）；验收证据写在 `docs/superpowers/notes/2026-09-22-scaffold-smoke.md`，**没有**单独产出 `2026-09-22-scaffold-acceptance.md`。

---

## 12. 从本 spec 重新生成实施计划

本 spec 是上游依据，`../plans/2026-09-22-scaffold.md` 是下游计划。生成关系（2026-09-24 复核确认）：

1. **任务划分与顺序**：计划的 Task 1–14 与 §10 的表格一一对应。
2. **代码块来源**：计划里 78 个「一个代码块 = 一个完整文件」的块 = 仓库里对应文件的**全文**（已逐字核对）。本 spec 只内联**契约与不变量**相关的代码（§5、§6、§8）；其余文件（`demo-list-page.tsx`、`demo-fixtures.ts`、各测试文件等）按 §4.3 的文件清单从实现取全文——spec 不重复贴它们，避免出现第二处真源。
3. **边界与守卫要求**：计划的探针清单与变异验证要求来自 §5.4 的四条加固与 §9 的守卫表。
4. **冒烟清单**：= §7.3 的 11 项（第 8 项的入口是设置页，不是顶栏）。
5. **口径修正**：凡本 spec 与实现不一致处，以**实现**为准并回写本 spec（本次已回写：`allowBuilds`、`eslint.shared.ts` 四条加固、`resolveRootForRead`、`useStoredWidth` 挂载后读、`restoreWidthsToAvailable` 的弹性列早返回、`ListDetailLayout` 的 `showDetail`、顶栏无主题切换、`Alert title`、vitest 双配置与 `@/*` 别名、`next.config.ts` 的 `transpilePackages`）。

**交付实况**：`pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令全绿（8 个包）；`README.md` 与 `AGENT.md` 不是本 spec 的产出，但仓库里存在，按本 spec 重生成代码时不要遗漏它们。

---

## 13. 功能面（建立在脚手架之上的十条链路）

每小节自包含：口径 → 契约 → 落点 → 实现路径 → 守卫。**契约里的字段名与派生函数是硬接口**，跨端实现按它们对齐。

| § | 功能面 | 主落点 | 主要契约 |
|---|---|---|---|
| 13.1 | 智能体评分（第二条评分通路 + 重新评分） | `evaluator/src/judge-agent.ts`、`agents` | `EvalRun.useAgentJudge`、`ScoreResult.judgeAgentKind`、`AgentRunResult.finalText`、`canRescoreRow` |
| 13.2 | 评分输出的原生结构化输出 | `agents/providers/*`、`evaluator/orchestrator.ts` | `AgentRunInput.outputSchema`、`capability.structuredOutput`、`ScoreResult.structuredOutput`、`JUDGE_OUTPUT_JSON_SCHEMA` |
| 13.3 | 评分标准项（组 → 项的权重表） | `contracts/src/rubric.ts`、`api/src/judge.ts`、`ui` | `Rubric`、`RubricJudgment`、`ScoreResult.judgments` / `maxScore` |
| 13.4 | 远端 git 仓库来源（镜像） | `core/src/mirror.ts`、`api/src/cases.ts` | `RepoSource`、`TestCase.repoBranch`、`RepoInfo.mirror*`、`REPO_UNREACHABLE` |
| 13.5 | 上下文窗口与思考强度 | `api/src/providers.ts`、三家适配器 | `ProviderModel.contextWindow`/`supportedEfforts`、`route.contextWindow`、`AgentRunInput.effort` |
| 13.6 | 单行执行（只跑当前候选） | `contracts`、`evaluator`、`ui` | `canRunRow` |
| 13.7 | 评测的修改与删除 | `contracts/src/run.ts`、`api/src/runs.ts`、`evaluator` | `RunUpdateSchema`、`hasLiveRows`、`isSameRowTarget` |
| 13.8 | 「变更详情」抽屉（逐文件 + 吸顶 + 惰性加载） | `core/src/git.ts`、`api/src/run-artifacts.ts`、`ui` | `RowDiffIndex`、`RowDiffFile` |
| 13.9 | 测试墙钟（进程创建预算） | `evaluator/src/testing/`、`core/src/git.ts` | —— |
| 13.10 | 子智能体用量与轮次口径 | `agents/providers/*`、契约 | `subagentTokens` / `subagentTurns`、`UsageTokens` |

---

### 13.1 智能体评分：第二条评分通路

**口径**

- 一轮的评分方式由创建时的开关决定并**快照**：`EvalRun.useAgentJudge`（缺省 `false`），创建后不可改——一轮里只有一把尺子。
- 评分智能体复用设置页「默认评分模型」那一对 `(providerId, modelId)`，只额外选「用哪家 CLI 驱动」；评分路由解析（用例覆盖 > 全局默认）**一个字都不改**。
- 评分方式另记进**行级** `ScoreResult.judgeAgentKind`（`null` ⇔ 纯文本 API）：轮级字段回答「这一轮打算怎么评」，行级字段回答「这一分实际是谁打的」。
- 评分智能体跑在**该行现有工作区**里（不另建副本），用**独立的配置目录** `.judgehome`（与 `.agenthome` 分开：两家格式不同，共用会互相破坏）。
- 评分智能体的用量**不进任何快照**（快照里的 `tokens` 是候选的计量），只转发成带 `[评分智能体]` 前缀的日志行。

**契约**

```ts
// contracts/src/agent.ts（新文件）：AGENT_KINDS / AgentKindSchema / AgentKind / AGENT_LABELS
// 从 run.ts 原样搬来，run.ts 用 `export { … } from './agent'` 再导出，index.ts 入口清单不变

// contracts/src/settings.ts
defaultJudgeAgent: AgentKindSchema.nullable(),          // null = 未配置；SETTINGS_DEFAULTS 里为 null

// contracts/src/run.ts
useAgentJudge: z.boolean().default(false),              // RunCreateSchema 与 EvalRunSchema 都要显式声明：
                                                        // zod 3 的 z.object 默认 strip 未知键，不声明就被静默丢掉
// contracts/src/score.ts
judgeAgentKind: AgentKindSchema.nullable().default(null),

// agents/src/types.ts
finalText: string | null;                               // 三家统一出口，null = 未采到（不猜）

/** 该行能否「重新评分」：不重跑候选 agent，只在既有工作区上重跑评分步骤 */
export function canRescoreRow(row: EvalRow): boolean;
```

`useAgentJudge` / `judgeAgentKind` **必须带 `.default(...)`**：`run-store` 用 `EvalRunSchema.safeParse` 读盘，任何必填新字段都会让磁盘上已有的 `run.json` 解析失败（`listRuns()` 静默跳过、`getRun()` 抛 INTERNAL）。

`canRescoreRow` 三个条件缺一不可：不在运行中（`preparing` / `running` / `judging`）· `baselineCommit !== ''` · `diff !== null`。⇒ `judged` / `failed` / `timed-out` / `canceled` / `interrupted` 都可重评，`pending` / `skipped` 得到「该行还没跑过」的明确拒绝。界面与服务端**共用这一份**。

**实现路径**

1. `agents`：`TurnState` 加 `finalText`（初始 `null`），`assembleResult` 的 `base` 原样带出（**canceled / timed-out / error 三种结论也带**）；`TurnProjection` 不变——`finalText` 只经 `TurnState` → 结果，**不进事件流**。三家采集点：

   | 家 | 采集点 |
   |---|---|
   | claude-code | `result` 消息的 `result` 字段（`projectResult` 里已在手） |
   | codex | `item.completed` / `item.updated` 且 `item.type === 'agent_message'` 的累积文本（取最后一次） |
   | dsh | `assistant/message` → `data.message.content[]` **按 `type === 'text'` 过滤**后 `join('\n')`——同一数组里的 `reasoning` 块**也带 `text` 字段**，不过滤会把推理混进答复 |

   次级口径：`''` **不写**；每见到一次就覆盖（多轮时最后一次即最终答复）。
2. `evaluator/src/judge-agent.ts`：`judgeRowByAgent(input)`，`cwd` = 该行工作区、`configHome` = `.judgehome`、`route` = 评分模型那一对、`baselineCommit`、`judgePrompt`、`taskPrompt`、`dimensions`、`timeoutMs`、`signal`、`onEvent`。提示词逐段拼、顺序与 `buildJudgePrompt` 对齐：考题 → 维度定义 → 用例评分提示词 → **改动怎么看** → 输出契约。「改动怎么看」要写清：工作区就是当前目录、基线是 `<baselineCommit>`、`git diff <baselineCommit>` 看已跟踪改动、未跟踪的新文件自己列出来、**改动可能很大，按文件读、不要整段打印**。只读要求显式写进提示词（不改/不建/不删文件，不跑格式化与安装依赖）。
3. 两条通路统一收口 `finalizeScore(parsed, raw, judgeProviderId, judgeModelId, judgeAgentKind)`：同一个维度口径、同一份契约自检、同一条「总分一律重算、不采信模型自报」；`raw` 上限两路共用（成功 20 000 / 失败 2 000 字符）。
4. 编排层第 7 步按 `useAgentJudge` 分流（`judgeRowByAgent` / `judgeRow`），`requireJudgeAgent(config, route)` 在未配置或协议不兼容时抛 `CONFLICT`。**超时与终止**：内层 `timeoutMs = settings.rowTimeoutMs`；外层另起一套 backstop（候选阶段那个定时器已被 `clearTimeout`，`runTurn` 可能无界返回）；stop signal **复用该行已注册的 `AbortController`** ⇒ 「终止」按钮在评分阶段天然有效。超时文案写「评分智能体超过…」以便与候选超时区分。
5. **工作区污染对照**（只对智能体通路）：评分结束后重算一次 `collectDiff` 摘要与评分前比对，不一致落一条点名 WARN（「评分智能体执行期间工作区被改动…『查看改动』抽屉显示的可能是它改后的状态」）。**不自动回滚**。
6. **重新评分** `evaluator.rescoreRow(runId, rowId)`：`requireRow` → `canRescoreRow` → `loadConfig`（用例必须仍存在：题面与评分提示词没有快照进 `run.json`）→ 注册 `AbortController` → 落 `[重新评分]` 日志 → `setRowStatus('judging', { error: null, score: null })` → 跑评分（与第 7 步**同一个函数**）→ `patchRow({ score })` + `publishRowEvent({ type: 'score' })` → `setRowStatus('judged')` + `publishRowEvent({ type: 'end', exitReason: 'rescored' })`；失败/终止/超时复用 `settleFailed` / `settleStopped`；`finally` 里 `clearRowRuntime` + `finalizeRun`。**重新评分追加事件、不 `resetEvents`**（事件日志是执行的唯一真相源）。
7. `core/workspace.ts` 新增 `rowJudgeHomeDir(workspaceRoot, runId, rowId)` → `{rowDir}/.judgehome`；`clearRowArtifacts` 补第三条 `rmSync`（**分开写**，不并入前两条）。

**界面**：设置页 `judge-settings-card.tsx` 在「默认评分模型」下方加同形 `Select`（`aria-label="默认评分智能体"`、`allowClear`、`size="small"`，选项来自 `AGENT_KINDS` + `AGENT_LABELS`）；**协议兼容判据是集合**（`acceptsProtocol(metadata, protocolType)` / `accepted.includes(judgeProtocol)`，**不是** `metadata.protocolType === …`），协议表只从注册表元数据来（`useRunModelOptions()` 的 `{ agentKind, protocolTypes }[]`，`ui` 包里不写这张表）；不兼容项 `disabled` 并写明原因，已存值变成不兼容时给点名两个 id 的红色 `Alert`。保存**不被阻止**（拦截发生在创建评测与评分两处）。创建表单加 `Switch`（`initialValues` 里 `false`，payload 补 `useAgentJudge: values.useAgentJudge ?? false`），开关打开而未配置默认评分智能体时给内联 `Alert` 指出路。行卡片加「重新评分」按钮 + `Popconfirm`，`canRescoreRow` 为假时 `disabled` + `Tooltip` 给原因。

**服务端创建时再拦一次**（`api/src/runs.ts`）：`useAgentJudge === true` 时校验 `defaultJudgeAgent` 非空、且该用例解析出的评分模型所属供应商的协议能被该智能体**接受**（用例级覆盖只能在服务端判）；两条都抛 `CONFLICT` + 可直接展示的中文原因。

**错误面**：未配置 / 协议不兼容 → `CONFLICT`（点名智能体、供应商、两种协议）；`finalText === null` → `JUDGE_PARSE_FAILED`「该适配器未回传最终消息」；答复不合法 / 缺项 / 非数字 → 复用 `parseJudgeResponse` 的中文文案，raw 进日志抽屉；进程起不来 / 鉴权 / 限流 → 透传 `AGENT_FAILED` / `AUTH_FAILED` / `RATE_LIMITED`；超时 → 该行 `timed-out` + `AGENT_TIMED_OUT`。

**守卫**：老 `run.json`（缺 `useAgentJudge` / `judgeAgentKind`）仍能 `safeParse`（**去掉 `.default` 必须变红**）；`finalText` 在三家与三种失败结论下都被带出，dsh 混入 `reasoning` 块时答复只有 `text`；`canRescoreRow` 真值表（六种终态哪些可重评、三种在途一律不可）；两条通路对**同一份模型回复**给出同一个 `ScoreResult`；评分阶段超时**不**永远停在 `judging`；工作区污染时有一条点名 WARN。

---

### 13.2 评分输出的原生结构化输出（零三方依赖）

**口径**

- schema 以**手写字面量**放在 `contracts/src/score.ts`（`JUDGE_OUTPUT_JSON_SCHEMA`），与 `JUDGE_OUTPUT_CONTRACT` 文本**同形**且**必须同批修改**；不引 `zod-to-json-schema`，不写通用转换器（那是第二份真源）。
- 契约里存**中性事实** `outputSchema?: Record<string, unknown>`，`outputFormat` / `--output-schema` / 「没有这一格」三种方言全部留在各家适配器。
- 能力声明写进**注册表元数据**且**必填**：`AgentProviderMetadata.capability.structuredOutput: boolean`（可选就会被默认成 `false` 而无人验证）。
- 不支持时**有痕降级**：编排层不传 schema，但发一条行日志说明「本行的评分智能体不支持结构化输出，回落到提示词契约」，并把 `ScoreResult.structuredOutput = false` 记下来。
- schema 的严格度**只到可移植子集**：`type` / `properties` / `required` / `additionalProperties` / `enum` / `integer` + `minimum`/`maximum` / `minItems` / `maxItems`；**不用** `oneOf` / `const` / `prefixItems` / `uniqueItems`。
- 解析判据**一个字不改**：schema 只让「不合格」更少见，不改变「不合格时怎么办」；**请求侧阻止优先于解析侧夹紧**（`score: 6` 被 schema 拒、被解析器夹紧这处差异是有意登记项）。
- 结果的出口仍是 `AgentRunResult.finalText`（claude 在 `structured_output` 存在时把它序列化后作为 `finalText`），不加第二个出口。

**三家落点**

| kind | `capability.structuredOutput` | 落点 | 结果出口 |
|---|---|---|---|
| `claude-code` | `true` | `query({ options: { outputFormat: { type: 'json_schema', schema } } })` | 收尾消息的 `structured_output`（序列化后进 `finalText`） |
| `codex` | `true` | `thread.runStreamed(prompt, { signal, outputSchema })`（SDK 自行落成 `--output-schema <FILE>`） | 仍是 `item.type === 'agent_message'` 的文本 |
| `dsh` | `false` | 无（SDK 客户端没有这一格） | 不变 |

三条硬约束：`input.outputSchema === undefined` 时**一个字段都不加**（保证「没传 schema 的行」行为逐字不变）；不支持这一格的适配器**必须报错**（dsh 的 `startDsh` 收到非空 `outputSchema` 就抛中文错，**纵深第二道**，第一道在编排层）；claude 的 `structured_output` 与 `result` **同时存在且内容不同**时落一条 WARN，并以 `structured_output` 为准（同形处置见既有 `num_turns` 那条）。claude 的 `error_max_structured_output_retries` 要在 **`providers/claude-code/events.ts` 的 `projectResult`** 里折成可直接展示的中文（归因码仍是 `AGENT_FAILED`）——**不放进三家中性归因层**：那是 claude 一家的 subtype。

**编排层**

```ts
const kind = requireJudgeAgent({ defaultJudgeAgent: config.settings.defaultJudgeAgent, route });
const structuredOutput = getProvider(kind).metadata.capability.structuredOutput;
if (!structuredOutput) {
  publishRowEvent(ctx.runId, ctx.rowId, { type: 'log', stream: 'stderr',
    text: `[评分] ${AGENT_LABELS[kind]} 不支持结构化输出，本行回落到提示词契约（返回形状由结构检查兜底）` });
}
judgeRowByAgent({ …, outputSchema: structuredOutput ? JUDGE_OUTPUT_JSON_SCHEMA : undefined });
```

`finalizeScore` 的入参新增**必填** `structuredOutput: boolean`（让两个调用点各自表一次态，不吃默认值）；文本通路传 `false`。界面：`score-detail-view.tsx` 的「评分者」一行补「输出约束：schema 约束 / 提示词约束」，`false` 时**不显示任何告警样式**（它是事实，不是错误）。

**守卫**：schema 的字段名与契约文本**逐项对齐**（`judgments` / `id` / `achieved` / `reason` / `verdict`），两份里都不出现 `totalScore`；`minItems` / `maxItems` **不存在**（项数由每张评分表决定，schema 表达不了）；「不传 schema ⇒ 键不存在」（不是 `undefined`）；dsh 收到 schema ⇒ 抛中文错且不 spawn；三家都显式声明能力位；能力为假时事件日志里有一条降级说明且 `structuredOutput === false`。

**已知风险**：schema 落到 wire 上就是请求体里的一格，**网关不认时不报错**（只是模型照旧自由生成）——可观测手段只有 `ScoreResult.structuredOutput` 与 `score.raw`（schema 生效时 `raw` 必然是能解析的 JSON）。对照实验：同一用例、同一模型，schema 开 / 关各跑一次。

---

### 13.3 评分标准项（组 → 项的权重表）

**口径**

- 评分表是**组 → 评分项**的二级表格，每项三列：`ID` / `目标` / `权重`；模型对每一项做**二元判定**（达成 / 未达成），**没有部分分**。
- `总分 = 达成项权重之和`；`满分 = 全部项权重之和`（由表格决定，不是常量 100）。**满分快照**进 `ScoreResult.maxScore` ⇒ 改了表之后历史分仍自洽。
- 评分表**快照进轮次**（`EvalRun.rubric`），跑一行时**读快照、不读用例**；改了用例的表，历史记录一个字节都不变。
- 用例上**没有**评分模型字段（两个生成按钮一律走设置页的全局默认评分模型），也**没有** `judgePrompt`（文本只是生成输入，不落盘）。
- 「智能生成 / 智能识别」两个按钮都是**一次非流式文本调用**（`callTextApi`）：**不建工作区、不起 CLI、不走 `AgentJudgeInput`**；判据落在 `api/src/judge.ts` 的模块头注 + 一条「生成不引入 agents 依赖」的守卫。这条口径只管生成与识别，**不管评分**（`useAgentJudge` 为真的轮次仍走 `judgeRowByAgent`）。

**契约（`contracts/src/rubric.ts`）**

```ts
export const RubricItemSchema = z.object({
  id: z.string().default(''),                              // 空 ID 的项按位置分配引用键 `#k`
  goal: z.string().min(1),                                 // 自足判据：既说清改哪里，也说清怎样算达成
  weight: z.number().int().positive().max(MAX_ITEM_WEIGHT),
});
export const MAX_ITEM_WEIGHT = 10_000;                     // 防 safe-integer 越界 / 满分失去意义 / 手滑多打零

export const RubricGroupSchema = z.object({ name: z.string().min(1), items: z.array(RubricItemSchema) });
export const RubricSchema = z.object({ groups: z.array(RubricGroupSchema) });  // **不设 .min(1)**：空表是新建用例的真实初态

export function rubricMaxScore(rubric: Rubric): number;                       // 空表返回 0
export function rubricItemKeys(rubric: Rubric): string[];                     // 有 id 用它，没 id 用 `#k`（全表跨组连续）
export function validateRubric(rubric: Rubric): { ok: true } | { ok: false; message: string };
export function composeTotalScore(rubric: Rubric, judgments: readonly RubricJudgment[]): number;
export function renderRubricForJudge(rubric: Rubric): string;                 // 两条评分通路共用同一份
```

`validateRubric` 是**提交用例时**的唯一判据（界面与后端共用）：至少一组、每组至少一项、组名非空、目标非空、权重正整数、**有值的 id 不重复**（空 id 可重复）。前两条「至少」刻意不写进 schema，只在这里判。

```ts
// contracts/src/score.ts（重写）
export const RubricJudgmentSchema = z.object({
  id: z.string().min(1),          // 评分表里的引用键，原样照抄
  achieved: z.boolean(),          // 二元判定
  reason: z.string(),
});
export const ScoreResultSchema = z.object({
  judgments: z.array(RubricJudgmentSchema),   // **必须与快照评分表逐项对齐**：少一项即整行失败
  totalScore: z.number().int().min(0),        // 上限放开（120 / 300 分的表都合法）
  maxScore: z.number().int().positive(),
  verdict: z.string(), raw: z.string(),
  judgeProviderId: z.string(), judgeModelId: z.string(),
  judgeAgentKind: AgentKindSchema.nullable().default(null),
  structuredOutput: z.boolean().default(false),
  judgedAt: z.string(),
});
```

`JUDGE_OUTPUT_JSON_SCHEMA` **必须同批换成新形状**（与输出契约文本同形），三条有意差异写进注释：`judgments` **不设** `minItems` / `maxItems`（项数由每张表决定，schema 是编译期字面量，表达不了「恰好等于这张表的项数」——这条约束只能由结构检查判）；**去掉 `totalScore`**（模型不再给总分）；`achieved` 用 `{ type: 'boolean' }` 而非 `enum: [true, false]`。

**服务端：生成与识别（`api/src/judge.ts`）**

| 分支 | 触发 | 输入 | 输出 |
|---|---|---|---|
| 智能生成 | `prompt` 为空 | 题面 + 仓库名 + **当前表格** | 合并后的完整表格 + `addedItems` |
| 智能识别 | `prompt` 非空 | `prompt`（+ 可选题面）+ **不含仓库** | 识别出的完整表格（整表替换） |

三条顺序纪律：先解析评分模型路由（`resolveJudgeRoute()`，**无参**）→ 生成分支才做「仓库名解析」且**不联网** → 最后才调用模型（前两步失败时一次模型调用都不该花掉）。

- 生成分支提示词：只输出 JSON、无围栏；分段含当前评分表（`renderRubricForJudge`）与**已有项 ID 清单**；输出契约只给**新增**组与项；四条硬约束——只新增（不许重复 / 改写 / 删除）、禁止复用已有 ID、同名组复用原名、表格已完备时返回空 `groups`（不凑数）。
- 识别分支提示词：用户原文**原样放入**、不做改写；三条硬约束——原样抽取（组数项数数字一个都不许改、不合并不拆分）、忽略与项无关的内容（组不带权重）、用户没给 ID 时留空串**不要自己编号**。
- `mergeRubric(current, added)`：按组名归位（同名组追加到该组末尾，否则新建组追加到表尾）；`added.groups` 为空 ⇒ 原表原样返回；新增项 id 与已有 id 冲突 ⇒ `JUDGE_PARSE_FAILED`（模型违约）。
- 返回值 `{ rubric, addedItems, note? }`，两个分支都返回**完整表格**；识别分支 `addedItems` 固定 0。
- 路由沿用 `/api/cases/generate-judge-prompt`（两个按钮打同一个接口，按 `prompt` 是否为空分派），请求体按 `GenerateRubricSchema` 校验。
- **失败绝不改调用方状态**：识别失败时弹窗不关、文本原样保留。

**服务端：两条评分通路共用的尺子（`evaluator/judge.ts`）**

- 解析：围栏剥离不变（只剥整段以 ``` 开头的，中间夹散文故意不救）→ 顶层必须是对象、`judgments` 必须是数组 → **按快照的引用键逐个找判定，缺一项即不合格**（报错点名「缺少对第 N 项（引用键 X，目标 Y）的判定」）→ **多余的判定忽略**、**重复引用键取第一条** → `achieved` 宽容读（`true` / `false` / `"true"` / `"false"` / `"是"` / `"否"`，认不出即不合格）→ `reason` 缺失给占位文案（`（模型未给出理由）`）。
- 收口：`totalScore = composeTotalScore(快照, 判定)`、`maxScore = rubricMaxScore(快照)`；自检失败仍抛中文 `INTERNAL`。
- 回问修复（`JUDGE_REPAIR_ROUNDS = 2`）保留，`buildJudgeFeedback` 的字段清单从「维度 key」换成「**评分表引用键 + 目标 + 权重**」清单 + 新输出契约——漏一项 = 白送那一项的权重。
- 智能体通路的 `buildAgentJudgePrompt` 里「评分维度」一节换成 `renderRubricForJudge`，「本用例的评分提示词」一节**整段删除**；其余口径（只读要求、失败面两类、`finalText === null` 与空答复的区分、`ok` 判定先于读答复）一字不改。

**界面**

- 用例表单：「评分提示词」字段整段删除，换成「评分标准项」卡片（`data-testid` 从 `case-dimensions` 改成 `case-rubric`）+ `[智能生成] [智能识别]` 两个按钮；表尾实时汇总「满分 N 分 · 共 M 项 · 权重合计 N」（用户自查权重的手段）。**表里一格模型选择都没有**。表单校验与 `validateRubric` 同一份判据。
- 新组件 `rubric-table.tsx`：纯展示 + 受控回调（`value` / `onChange`，不 import client 包），单元格用受控 `Input` / `InputNumber`，增删按钮各带 `data-testid`（`rubric-add-group` / `rubric-add-item-{i}` / `rubric-remove-group-{i}` / `rubric-remove-item-{i}-{j}`）。
- 新组件 `rubric-recognize-modal.tsx`：框内只有一个多行文本域 + 取消 / 识别；成功回填并关窗，**失败不关窗、文本原样保留**；关闭不写回表单。
- 用例详情：删掉「评分维度」那一行 `Descriptions`，新增只读「评分标准项」`Card`。
- 评分详情：顶部总分 + `满分 N · M 项达成 K 项`，逐组表格（`引用键 / 目标 / 权重 / 达成说明`），未达成项**用颜色区分（不是隐藏）**，「模型原始返回」保留可折叠。判定与评分表**按引用键**对应，**不做「找不到就跳过」的兜底**（找不到说明数据不一致，静默跳过比报错危险）。`ScoreBars` 组件整体删除。
- 设置页的「输出契约（只读）」两行换成新口径的一句话说明。

**三层职责（各自只做一件事）**

| 层 | 落点 | 不合格时 |
|---|---|---|
| 体验层 | 用例表单提交前 | `message.error(validateRubric 的中文原因)`，**不发请求** |
| 真相层 | `api/cases.ts` **已有的** `assertStorable()` | 抛 `INVALID_QUERY` + 中文原因（**落一处**，两处各写一遍必然漂移） |
| 兜底层 | `orchestrator.ts` 起一行评分之前 | 满分 ≤ 0 ⇒ 该行落**评分失败** + 中文原因，**不许走到 `finalizeScore`** |

兜底层**不在写入路径上但确实会开火**：`config.json` 是手可编辑的，而 `{ groups: [] }` 是一张**合法**的 `Rubric` ⇒ 手改的空表用例 `getCase` 读得出来、`POST /api/runs` 会把空表快照进 `run.json`，于是这一轮开跑时兜底层把它变成一句可展示的 `CONFLICT`。**不要在 `createRun` 再加「空表不许建轮」的守卫**——空表是写用例过程中的合法初态。

**旧数据**：`judgePrompt` 被 zod 丢掉（忽略）；**用例没有 `rubric` 是唯一一条「读侧必须显式处置」的路径**——`asStoredCase` 里显式判一次，不合法（含 `undefined`）时抛中文 `INTERNAL`「这个用例是旧版数据，请删除它或重新创建：<caseId>」，**绝不给它 `.default({ groups: [] })`**（那会让旧用例看起来只是「还没配」，而它实际带着一份已无意义的旧提示词）；带 `dimensions` 的旧 `run.json` 过不了契约 ⇒ `listRuns` 跳过，并在**同一趟扫描的最后**记一条**汇总 WARN**（「有运行快照因评分口径升级不再兼容，已从列表跳过」+ 条数；计数只含「读得出 JSON、但过不了契约」的快照）。落点在 `listRuns` 而不是启动钩子：启动钩子拿到的已经是过滤后的结果，`listRuns` 是唯一同时看得见「读出来的」与「被跳过的」的地方。

**守卫**：`rubricMaxScore` / `rubricItemKeys` / `validateRubric` / `composeTotalScore` 的边界（空表合法且满分 0、空组 schema 合法而 `validateRubric` 拒绝、跨组顺序号连续、空 ID 重复合法、权重 0 / 负 / 小数 / 超上限不合法）；两份契约投影的**同形守卫**（字段名逐项对齐、两份都不出现 `totalScore`、`minItems` / `maxItems` 不存在）；缺一项即失败且点名是哪一项；`maxScore` 来自快照而非当前用例；两条通路对同一份回复给出同一个 `ScoreResult`；「两个生成按钮都只用默认评分模型，且生成路径不 import `@aieval/agents` 的 provider 入口」。

---

### 13.4 远端 git 仓库来源（自动镜像）

**口径**

- 来源仍是**同一个 `repoPath` 字段**，按形态判定本地路径还是远端 URL（不新增 `repoUrl`）。
- 远端由服务端**自动镜像**到 `{workspaceRoot}/remotes/<slug>-<hash8>/`：**裸镜像**（`git clone --mirror`，没有工作树、不脏、全部分支以 `refs/heads/*` 可见），跨用例复用。
- **core 只见本地路径**：远端在 api / evaluator 层就被解析成「镜像路径 + 具体 commit hash」，再交给既有 `prepareRowWorkspace` ⇒ 缓存克隆、行工作区复制、`checkoutRow`、`collectDiff`、`copyWorkspace` **一行不改**。
- `repoBranch: string | null`（null = 远端默认分支）**仅远端可填**，本地来源填了直接 `INVALID_QUERY`。
- **分支 tip 每次评测重新解析**（跟随语义）；填了 `commitHash` 则**钉死**（优先于分支）。
- **不做凭据管理**：认证 = 本机 git（SSH key / ssh-agent / credential helper）。
- 远端 git 调用**非交互 + 墙钟超时**：`GIT_TERMINAL_PROMPT=0`、`stdin: 'ignore'`、`GIT_SSH_COMMAND` 追加 `-o BatchMode=yes`（**仅在进程环境里没有它时**）；探活 15 s / 传输 10 min。同步 git 调用挂在请求线程上 ⇒ clone/fetch 期间整个进程阻塞（已知代价，用墙钟上限兜底）。
- 镜像**不随「删除用例」消失**、不自动清理（它按 URL 命名、可能被多个用例共用）；改工作区根目录后旧镜像不再被看到（会重新克隆）。

**来源形态判定（唯一真源 `contracts/src/repo-source.ts`，顺序不可换）**

| 序 | 形态 | 判定 | 例 |
|---|---|---|---|
| 1 | Windows 盘符 `^[A-Za-z]:[\\/]`、UNC `^\\\\` | local | `D:\repos\demo`、`\\host\share\repo` |
| 2 | 白名单 scheme：`ssh://` / `http://` / `https://` / `git://` / `file://` | remote | `https://coding.jd.com/FlowAI/rbac-server.git`、`file:///D:/tmp/origin.git` |
| 3 | 其它 `^[a-z][a-z0-9+.-]*://` | **拒绝** `INVALID_QUERY` | `ftp://host/x.git` |
| 4 | scp 形态 `^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]{2,}:.+$` 且「含 `@`」或「host 段含 `.`」 | remote | `git@coding.jd.com:FlowAI/rbac-server.git` |
| 5 | 其余（含 `/home/…`、相对路径） | local | `D:/repos/demo`、`./repo` |

- 第 4 条的额外条件是为了不把 `src:foo` 这类含冒号的本地相对路径误判成远端；`localhost:repo` 因此判 local（要指定它请写 `ssh://localhost/repo`）。
- `file://` 判 remote 是刻意的：整条远端链路（镜像、基线解析、超时、失败分类）可以用本地裸仓库全覆盖，不需要网络。
- **归一**：两侧空白 `trim`；远端**仅**去掉尾部 `/`。此外不做任何归一（不折叠大小写、不剥 `.git`、不把 https 改写成 ssh）——它是镜像 key 与「来源是否改变」的判据。
- **两条硬拒绝**（在判定之前）：含控制字符（`\u0000-\u001f`）→ `INVALID_QUERY`「代码来源里含控制字符」；以 `-` 开头 → `INVALID_QUERY`「代码来源不能以 - 开头」（后者防 URL 被 `git clone` / `git ls-remote` 当成选项解析）。

```ts
type RepoSource = { kind: 'local'; path: string }
                | { kind: 'remote'; url: string; host: string; repoName: string };
export function parseRepoSource(source: string): RepoSource;
/** 远端取 URL 末段去 .git，本地取路径末段。**用途限定**：界面标签与远端来源的服务端取值；
 *  本地来源的服务端仓库名仍走 resolveRepoInfo 的 git 口径（rev-parse --show-toplevel 的目录名） */
export function repoNameFromSource(source: string): string;
export const RepoSourceStringSchema: z.ZodType<string>;   // 给 TestCaseSchema / CaseCreateSchema 的 repoPath
```

放 contracts（不是 core / ui）：三层都要用它（core 的镜像层、api 的校验与文案、ui 的标签），放一处才有唯一真源。

**契约改动**

| 字段 | 变更 |
|---|---|
| `TestCaseSchema.repoPath` | 语义扩为「来源」，改用 `RepoSourceStringSchema`（旧值判定结果不变） |
| `TestCaseSchema.repoBranch` / `CaseCreateSchema.repoBranch` | 新增 `z.string().min(1).nullable().default(null)` |
| `RepoInfoSchema` | 新增 `kind: 'local' \| 'remote'`、`mirrorPath: string \| null`、`mirrorReady: boolean`、`mirrorFetchedAt: string \| null`、`tip: string \| null`（短哈希 7 位，**仅远端有值**）；`branch` 语义：本地 = 当前分支，远端 = 默认分支或用户填的分支 |
| `RepoPathInputSchema` | 保留不动；新增 `RepoValidateInputSchema` / `RepoCommitsInputSchema`（各 extend 一格 `repoBranch`） |
| `EvalRunSchema` | 新增 `repoBranch`（快照口径：用例改名 / 改分支 / 删除后，这一轮从哪个分支的哪个 commit 起跑仍读得出来） |
| `errors.ts` | 只增 `REPO_UNREACHABLE`（400）：DNS / 连接超时 / 连接被拒 / SSH 指纹未信任 / 拉取超时。认证沿用 `AUTH_FAILED`（`context.host`），不存在 / 不是仓库 / 无法归因沿用 `NOT_A_GIT_REPO`，分支与提交不存在沿用 `INVALID_REF` |

`.default(null)` 是载重的：旧 `config.json` 的用例没有这个字段，读侧必须按 null 读。

**`core/src/mirror.ts` 实现路径**

1. 目录 `{workspaceRoot}/remotes/{slug}-{sha1(归一 URL).slice(0,8)}/`：`slug` = URL 末段去 `.git`、非 `[A-Za-z0-9._-]` 归一成 `-`、小写化、截 40 字符、为空则 `repo`；**身份判据是 hash 段**（slug 只为人眼可读）。`remotes/` 是 `workspaceRoot` 下的第三个兄弟目录，`listRuns` 只认「目录下有合法 `run.json`」的那些，不会被当成一轮评测。
2. `ensureMirror({ workspaceRoot, url, timeoutMs? })`：**就绪判据 = `<dir>/HEAD` 是文件且 `<dir>/objects` 是目录**（不是「目录存在」——克隆中途失败会留下没有 objects 的半成品）→ 已就绪直接返回 `created: false`（**不联网**）→ 未就绪则清残留、`git clone --mirror --quiet <url> <dir>.tmp-<pid>`（cwd = `remotes/`）、成功后 `renameSync` **原子改名**；rename 时目标已存在（并发已建）当作成功复用；目录存在但内容损坏 ⇒ 删掉重建，删不掉给中文 `INTERNAL`。
3. `fetchMirror(mirrorDir, url, options?)`：`git -C <dir> fetch --prune`（`--mirror` 克隆的 config 里 `remote.origin.mirror=true`，普通 fetch 即全 refs 同步）→ 成功后写镜像记录 `<dir>/aieval-mirror.json`（`{ url, fetchedAt }`，`url` 存**归一形态**；普通 `writeFileSync`，写失败只 WARN）。**更新不在 `ensureMirror` 里做**：候选列表要快（不联网）、校验要新鲜、评测准备必须新鲜，把 fetch 混进去会让准备路径联网两次、也让「候选不联网」从签名上看不出来。记录的用途只有诊断与回显「更新于 HH:mm」，**不参与就绪判据**（缺失或不可解析一律按「没有记录」处理、不重建）。写记录有两处：`fetchMirror` 成功后，以及**首次克隆成功后**（否则刚建好的镜像没有 `fetchedAt` 可回显）。
4. `probeRemote(url, { cwd, timeoutMs? })`：`git ls-remote --symref <url> HEAD`，从 `ref: refs/heads/<name>\tHEAD` 与 `<sha>\tHEAD` 两行解析出 `{ defaultBranch, tip }`。`cwd` **由调用方显式给**（`{workspaceRoot}/remotes/`，必要时先建目录），刻意不回落 `process.cwd()`。空输出（远端没有任何 ref）→ `NOT_A_GIT_REPO`「远端仓库还没有任何提交」。
5. `resolveRemoteRef(mirrorDir, url, { branch, commitHash, fetch = true, timeoutMs? })`：`fetch` 为真先 `fetchMirror` → `commitHash` 非空则 `cat-file -e <hash>^{commit}` + `rev-parse <hash>^{commit}`（找不到 → `INVALID_REF`）→ `branch` 非空取 `refs/heads/<branch>^{commit}` → 否则取远端默认分支（`symbolic-ref --short HEAD`，失败退回 `rev-parse --abbrev-ref HEAD`，都失败 → `NOT_A_GIT_REPO`「无法确定远端默认分支」）。**这一路不联网**。
6. 远端调用统一走**同一个** `execute` 封装（把 `git.ts` 的 `execute` / `gitMessage` 抽到 `core/src/git-exec.ts` 共用），新增 `env` 与 `timeoutMs` 两个可选参数（`execFileSync` 的 `timeout`，到点杀子进程）。常量 `REMOTE_PROBE_TIMEOUT_MS = 15_000`、`REMOTE_TRANSFER_TIMEOUT_MS = 600_000`，都可由调用方覆盖（测试用 1 ms 制造确定性超时）。**超时判定不靠关键词**：`execFileSync` 因超时被杀时错误带 `signal`（`SIGTERM`）且 `status` 为 null ⇒ 折成 `REPO_UNREACHABLE`「远端仓库拉取超时（超过 10 分钟）…已终止 git 进程」，**不得**归到 `NOT_A_GIT_REPO`。
7. `git.ts` 只加两处签名级补充：`resolveRepoInfo` 的返回值补上新增字段的本地常量取值（`kind:'local'`、`mirrorPath:null`、`mirrorReady:false`、`mirrorFetchedAt:null`、`tip:null`）；`listCommits(repoPath, limit = 20, ref: string | null = null)` 加一个可选 ref（不传时行为逐字不变）。

**api / evaluator 接线**

- `validateRepo`：local 走现状；remote = `probeRemote` →（镜像未就绪时）`ensureMirror`（首次克隆，慢）→ `fetchMirror`（增量，通常 1–3 秒）→ `resolveRemoteRef(..., { fetch: false })`（分支不存在在这里就拦下）→ 回 `kind:'remote'`、`repoName`、`branch`、`tip`（7 位）、`mirrorPath`、`mirrorReady:true`。远端校验**不 checkout、不碰工作树、不建行工作区**。
- `listCommitCandidates`：remote = `ensureMirror`（就绪则纯本地、**不联网**）→ `resolveRemoteRef(..., { fetch: false })` 取该 ref 的 40 位 tip → `git -C <dir> log --format=%h%x09%s -n 20 <tip>`。复用 `resolveRemoteRef` 而不自己算 ref 名（默认分支的取名只在一处实现）。
- `createCase` / `updateCase`：形态判定走 `parseRepoSource`；本地来源 + 非 null 分支 → `INVALID_QUERY`（**按值判**，避免 UI 的全量补丁把无关保存拦下）；远端分支 / commit **先在镜像里判**，判不过时**只 `fetchMirror` 一次再判**，仍判不过才抛（远端刚推上来的分支不该因为镜像还没更新而被拒）；落盘时 `commitHash` 归一成 40 位、`repoBranch` trim（空串 → null）。删用例只删 `{workspaceRoot}/cases/{caseId}/cache`，**不动镜像**。
- `generateJudgePrompt`：只用仓库名 ⇒ 远端直接取 `repoNameFromSource`，不需要镜像、不联网。
- 创建评测：把用例的 `repoPath` 与 `repoBranch` 一并快照进 `EvalRun`。
- 编排层准备阶段（第 1/2 步之前）：`parseRepoSource(run.repoPath)` → remote 时 `ensureMirror({ workspaceRoot: run.workspaceBase, url })`（**不联网**更新）→ `resolveRemoteRef(mirrorDir, url, { branch: run.repoBranch, commitHash: run.commitHash })`（缺省 `fetch: true`，**这是本轮唯一一次 fetch**，分支 tip 在这里重新解析）→ `prepareRowWorkspace({ …, repoPath: mirrorDir, commitHash: baseline, branch })`（传**具体 hash** 而不是 null：镜像刚 fetch 过，缓存只需从镜像取对象）→ `EvalRow.baselineCommit` = 该 hash（仍是 40 位）。本地来源走原路。

**基线解析规则总表**

| 来源 | `repoBranch` | `commitHash` | 基线 |
|---|---|---|---|
| local | null | null | 缓存刷新到来源仓库当前 HEAD（既有语义） |
| local | null | hash | `assertCommit` |
| local | 非 null | 任意 | 写入口就 `INVALID_QUERY`（到不了准备阶段） |
| remote | null | null | 远端**默认分支** tip（每次评测 fetch 后重新解析） |
| remote | `feat/x` | null | `refs/heads/feat/x` 的 tip（同上） |
| remote | 任意 | hash | 该 commit（镜像里没有 → fetch 一次 → 仍没有 → `INVALID_REF`） |

local 与 remote 的「默认分支 HEAD」**不是同一个东西**：local 取来源仓库**当前检出的 HEAD**（可能停在特性分支上），remote 取**远端默认分支**。这是两种来源的固有差异，写进文案与文档，不试图统一。

**界面**：用例表单加来源切换（`Radio.Group`：本地目录 / 远端仓库，纯展示层状态，落到同一个 `repoPath`），编辑态按形态回填；本地态 = 现状；远端态 = URL 输入 + 「分支（留空 = 远端默认分支）」+ 「校验」，成功回显「仓库：rbac-server · 默认分支：main · tip abc1234 · 镜像：已就绪（更新于 12:04）」；`extra` 文案按来源切换（远端那句写明「认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据」）；「校验」与「重新加载候选」在远端首次点击可能触发克隆（loading + 「正在拉取远端仓库…」，背后有 10 分钟上限）。列表 / 详情的仓库名列改用 `repoNameFromSource`，详情里远端显示 URL（等宽）+ 分支行。设置页**不加**任何凭据 / 镜像管理项。

**错误分类（判别关键词按序匹配 git 原文）**：`Permission denied (publickey` / `Authentication failed` / `could not read Username` / `HTTP Basic: Access denied` / `terminal prompts disabled` → `AUTH_FAILED`；`Could not resolve host` → DNS；`Connection timed out` / `Connection refused` / `Network is unreachable` / `Operation timed out` / **`Could not connect to server`** / **`Timeout was reached`** → 不可达（后两条覆盖 curl 系原文与「未监听端口」这一档）；`Host key verification failed` → 指纹；`repository .* not found` / `does not appear to be a git repository` / `not found` → 不存在；其余 → 无法归因（同样 `NOT_A_GIT_REPO`，原文照带）。**中文原因在前，git 英文原文作为补充跟在后面**，同一份原文另放 `context.gitMessage`。

**守卫**（`mirror.test.ts` 用真 git + `file://` 夹具）：镜像路径稳定（同一 URL 含两侧空白 / 尾斜杠差异 → 同一目录；`https` 与 `ssh` → 不同目录）；首次建镜像后可 `for-each-ref` 看到来源全部分支；**幂等且不联网**（第二次 `created: false` 且提交号不变，把来源删掉后再调一次仍成功）；`fetchMirror` 更新后镜像里有新提交且记录 `fetchedAt` 前进、`url` 是归一形态；镜像记录缺失 / 损坏不影响就绪判据；`git clone <裸镜像>` 到临时目录后 `for-each-ref refs/heads` **恰好一条**且等于远端默认分支；半成品目录能重建；`tmp + rename` 竞态下复用不抛错；`probeRemote` 四类（正常 / 空仓库 / 不存在 / 未监听端口）；`resolveRemoteRef` 三条路；超时映射到 `REPO_UNREACHABLE` 且文案含「超时」；`remotes/` 不被当评测；**重命名 `{a => b}` 形态的来源变更重克隆**；**远端不可达 ⇒ 该行 `failed` 且错误码是 `REPO_UNREACHABLE` / `AUTH_FAILED`，绝不静默用旧镜像**；远端新增提交后重跑 ⇒ 新基线（分支跟随语义）。

---

### 13.5 上下文窗口与思考强度

**口径**

- 契约里只存**中性事实** `contextWindow: number`（`[1m]` / `model_context_window` / overlay 三种写法全留在各家适配器）。
- 取数按**字段优先级**取第一个正整数（不深遍历整个 JSON）：窗口 `max_input_tokens` → `contextWindow` → `context_window` → `context_length` → `limit.context` → `capabilities.contextWindow`；输出 `max_tokens` → `max_output_tokens` → `maxTokens` → `maxOutputTokens` → `limit.output`（点号表示嵌套）。
- 手工覆盖优先于拉取值，用**逐字段来源** `contextWindowSource: 'fetched' | 'manual'` 记住；`manual` 的条目在拉取时**不被覆盖**，**清空也记成 `manual`**（语义是「别用上游那个数」）。
- **窗口未知 ⇒ 三家都不注入**（不拿兜底数字冒充「已知」）；**强度未选 / 未知 ⇒ 不传该选项**（让模型用自己的默认档）。
- 强度选项 = **上游档位 ∩ 该行智能体的档位域**，在服务端算好（投影进候选池），创建时再校验一次；**不做就近取整**（`medium` → `high` 是静默改语义）。
- 每个智能体的档位域写进**注册表元数据**（`reasoningEfforts`），由 `registry.test.ts` 强制每家显式声明。
- 强度进**行快照**（`rows[].effort`），窗口**不进**：窗口是模型属性（与 `baseUrl` 同口径，运行时现读），强度是这一行的配置（与 `modelId` 同级，必须跟着行一起被重跑、被展示、被比较）。
- 推荐档**不预选**，只在选项标签上标「推荐」（预选会让「我没选过」与「我选了推荐档」在快照里长得一样）。

**契约**

```ts
// contracts/src/provider.ts
contextWindow: z.number().int().positive().optional(),        // null / 缺省 = 未知
maxOutputTokens: z.number().int().positive().optional(),
contextWindowSource: z.enum(['fetched', 'manual']).optional(),
supportedEfforts: z.array(z.string().min(1)).optional(),      // 原样保留上游顺序与拼写
recommendedEffort: z.string().min(1).optional(),              // 不在 supportedEfforts 里 ⇒ 按「没有推荐」
// 三个字段全部可选 ⇒ 磁盘上已有的 config.json 无需迁移（loadConfig 只做 JSON.parse + 合并默认值）

// agents/src/types.ts
route: { protocolType; baseUrl; apiKey; modelId;
         contextWindow?: number; maxOutputTokens?: number };   // 中性事实，不是方言
effort?: string;                                               // **不进 route**：它是请求参数，与 permission / prompt 同级
AgentProviderMetadata.reasoningEfforts: readonly string[];      // 该家能表达的完整档位域
```

| 智能体 | `reasoningEfforts` |
|---|---|
| claude-code | `['low', 'medium', 'high', 'xhigh', 'max']` |
| codex | `['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']` |
| dsh | `['off', 'low', 'high', 'max']` |

`AgentModelOption` 增加 `contextWindow?: number`、`efforts: string[]`（**已与该智能体求过交**，空数组 = 这个组合只有「默认」）、`recommendedEffort?: string`（必须落在 `efforts` 里才有值）；`AgentOptionGroup` 增加 `efforts`（该智能体的完整取值域，供「换智能体」时即时校验）。`RunRowInput` 增加 `effort?: string`（**逐行**）。

**取数（`api/src/providers.ts`）**

- `extractModelIds` → `extractModels`：解析规则 `number` 或数字字符串（`'1048576'`）→ `Number(v)`，要求 `Number.isInteger(n) && n > 0`，否则跳过换下一个字段；**上界不设**（清单里有 2M 窗口，加上界只会把合法的截掉）；`data: ['a','b']`（纯字符串形态）继续支持，此时两个可选字段都是 `undefined`；原有的 `trim` 与去重口径逐字保留。
- 档位数组的优先级：`supportedEffortLevels` → `reasoning.supported_efforts`；第三种形态是 `capabilities.effort` 的**逐档对象**（`{ supported: true, low: { supported: true }, high: { supported: true, recommend: true }, … }`）——取值为对象且 `value.supported === true` 的键、保持上游键顺序，`recommend === true` 的那一档同时充当推荐档。清洗：只留非空字符串、按首次出现去重；`supportedEfforts` 为空 ⇒ 三个字段都不写。`recommendedEffort` 不在 `supportedEfforts` 里 ⇒ **两个都当成上游没说**。推荐字段优先级：`recommendEffortLevel` → `reasoning.default_effort`。
- **合并（最容易踩的一处）**：`fetchProviderModels` 现在把 fetched 条目**重建成 `{ id, source: 'fetched' }`** ⇒ 照原样上线的表现是「点一次拉取模型就把所有窗口清空」。正确形状：

```ts
const manual = current.models.filter((m) => m.source === 'manual');       // 原样保留
const byId = new Map(current.models.map((m) => [m.id, m]));
const manualIds = new Set(manual.map((m) => m.id));
const models = [
  ...manual,
  ...[...new Set(fetched)].filter((id) => !manualIds.has(id)).map((id) => {
    const upstream = extractedById.get(id);
    const previous = byId.get(id);
    // 用户手工改过（或手工清空）就保留用户那份；否则以上游为准
    return previous?.contextWindowSource === 'manual'
      ? { id, source: 'fetched' as const, ...pickContext(previous) }
      : { id, source: 'fetched' as const, ...pickContext(upstream) };
  }),
];
```

  `pickContext(x)` 只挑 `contextWindow` / `maxOutputTokens` / `contextWindowSource` 三键（缺席不写 `undefined`）；上游这次没给窗口且条目也没有手工覆盖 ⇒ 三键都不写（= 未知），**不保留上一轮的旧值**（上游下架了就是下架了）。日志「模型清单已更新」增加 `withWindow: <条数>`。强度字段走同一段合并、同一条规则；窗口的手工覆盖**不**顺带保护强度（两件事）。
- `setProviderModelContext(providerId, modelId, context)` 写 `contextWindow` / `maxOutputTokens`（正整数或清空）并把来源置 `'manual'`；清单里没有这条 ⇒ `NOT_FOUND`；窗口为 `null` 时清除三个键，**但 `contextWindowSource: 'manual'` 留下**。

**三家的表达（编排层给事实，适配器给方言）**

编排层只改一处：`orchestrator.ts` 组装 route 时从供应商清单里那条模型条目读出窗口填进 `route.contextWindow` / `route.maxOutputTokens`。

| 家 | 窗口 | 强度 |
|---|---|---|
| claude-code | `contextWindow >= ONE_M_CONTEXT (1_000_000)` ⇒ 传给 CLI 的模型名加 `[1m]` 后缀（对非 Claude 名字一样加），否则原样；`maxOutputTokens` **不注入**（SDK 的 options 里没有对应项） | `...(effort === undefined ? {} : { effort })`（SDK 自己转成 `--effort`） |
| codex | `buildCodexConfig(baseUrl, contextWindow?)` → `...(contextWindow === undefined ? {} : { model_context_window: contextWindow })`（SDK 摊成 `--config model_context_window=…`）；**不设** `model_auto_compact_token_limit`（CLI 自己按窗口推导更准） | `...(effort === undefined ? {} : { modelReasoningEffort: effort })` |
| dsh | **per-run overlay**：`<configHome>/aieval-route.patch.yml` 的 `llm-pi-ai.providers.aieval-route.models[0]` 下 `contextWindow` / `maxTokens` 两个键；未知 ⇒ **不写那个键**（overlay 每次运行由 `buildDshRoutePatch()` 纯函数**整份重写**，同一输入两次调用逐字相同） | `...(effort === undefined ? {} : { reasoningEffort: effort })` |

三条都**不做值映射**：档位字符串按上游词汇原样透传，能不能收由交集在创建时就保证。三家的 debug 日志各补一行 `effort`（claude 那条同时记**真正传给 CLI 的模型名**与 `declaredModel`，两者不同时才出现）。

**界面**

- 设置页 · 模型清单（`provider-models-modal.tsx`，入口是供应商列表的「模型」按钮）：`size="small"`、`showHeader={false}` 的 `Table`，列序固定 **模型 ｜ 来源 ｜ 输入 ｜ 输出 ｜ 操作**；模型列开 `ellipsis` 且**不套 `code`**；来源列只有一个来源 Tag；输入 / 输出各占一列、都是 `InputNumber`、都 7em 宽，**两格一次提交**，没碰过的输入回落到清单现值且**不与「清空」混同**（草稿状态按 `Object.hasOwn` 判「改过没有」）；操作列右对齐、两个图标按钮（保存 / 移除）+ `Tooltip`（文字进 tooltip、可访问名走 `aria-label`）；**「手工维护」的可视信号 = 保存图标变 `gold` + 提示语**；保存走 `setProviderModelContext(modelId, { contextWindow, maxOutputTokens })`（`null` = 明确清空）。**列宽是算出来的**（表是 `table-layout: fixed`，格子比内容窄时内容会压到相邻列上）：输入 / 输出列 **116px**（= 7em 的 98px + 单元格内边距 16px + 2px 余量），弹窗宽 **720**，`MODEL_COLUMN_WIDTH` / `MODELS_MODAL_WIDTH` 是导出常量并由列宽守卫盯着。
- 创建评测：模型下拉在模型名后补窗口 Tag（`1M` / `200K`），**Select 的 value 不变**（仍是 `providerId::modelId`）；强度下拉的选项 = 该行当前模型的 `option.efforts`，推荐档标「推荐」、**默认不预选**、占位符是「默认」；**换模型或换智能体都要作废本行已选强度**（与「换智能体作废模型」同一口径；`efforts` 为空时置空并提示「该组合只有默认」）；值编码成裸字符串随行提交。
- **候选行是一张 small `Table`**，列序固定 **智能体 ｜ 模型 ｜ 思考强度 ｜ （无标题的）操作列**：字段名交给列头、`Form.Item` **不再给 `label`**（右栏只有 ~545px 宽，竖排标签在多候选时最贵）；**可访问名由控件自己的 `aria-label` 承担**；操作列列名留空、右对齐，三个图标按钮顺序是 **上移 / 下移 / 删除**（候选顺序就是串行执行顺序），边界行**置灰而不是隐藏**，删除用危险色 `variant="link"`；模型池与强度档位由整张表的 `shouldUpdate` 订阅（判据是 `(agentKind, modelKey)` 的**签名**，行数变化也必须重画——否则新加的候选根本不出现）；**删光最后一行是可达状态**，空态文案是中文的「还没有候选：点下面的「添加候选」加一行」；列宽只在浏览器里定：智能体 130 / 强度 120 / 操作 **80**，**模型列不给宽度**（吃掉剩余宽度）。
- 行快照展示：评测详情里那一行的模型名旁显示档位（如 `GLM-5.3 · high`），缺省不显示。
- 以上都不手写字号、不手调行内边距。

**守卫**：三个新字段可选（老形态解析通过、带窗口往返不丢）；六个窗口字段优先级各一条 + 嵌套 / 数字字符串 / `0` / 负数 / 小数 / `'abc'` 一律跳过；合并的四条（拉取不清空窗口、手工覆盖不被打回、上游没给就不保留旧值、manual 条目原样保留）+ 强度同规则且**窗口的手工覆盖不顺带保护强度**；`setProviderModelContext` 写入 / 改 / 清空（清空后来源仍是 `manual`）；claude 的 `1000000` / `1048576` → `[1m]`、`999999` / 未知 → 原名；codex 给窗口 ⇒ 键在且值逐字相等、不给 ⇒ **键不存在**；dsh 给窗口 ⇒ overlay 里那两个键正确、不给 ⇒ 键不出现；编排层组装的 route 带上窗口与输出上限；强度三个形态各一条 + 推荐档不在档位表里 ⇒ 两个都不写；候选池交集表驱动（含四条边界：交集为空、交集部分命中、上游无档位、推荐档不收）；`createRun` 的行级 `effort` 不在交集 ⇒ `INVALID_QUERY` 且中文原因点名两个值域；三家强度参数名与值正确、**不给 ⇒ 该键不存在**；三家都显式声明 `reasoningEfforts`。

---

### 13.6 单行执行（只跑当前候选）

**判据分两档**（都在 contracts）

| 判据 | 回答的问题 | 条件 | 谁在用 |
|---|---|---|---|
| `canRunRow` | 能不能**就现在**把这一行跑起来 | `!isRunningRow(row.status)` | 服务端放行、按钮 `disabled` |
| `canRetryRow` | **重**跑这一行有没有对照物 | 不在跑 + 有可比基线 + 有产出 | 按钮**文案**与确认框措辞 |

两者是**单调关系**：能重新执行 ⇒ 必然能单跑，反之不然。

**一个按钮，文案按行态分叉**：没跑过的行 ⇒「开始执行」；跑过的行 ⇒「重新执行」；**正在首跑**的行（`preparing` / `running`，还没有基线）也显示「重新执行」⇒ 文案判据是 `canRetryRow(row) || isRunningRow(row.status)`，不是单纯的 `canRetryRow`。确认框同样分叉且**都必须点名范围**：首跑「只跑这一个候选：本轮其他行（含已经执行过的行）都不会重跑。」；重跑「…只跑这一行，本轮其他行不动。」

**并发**：本轮其他行在跑**不拦**单行执行（`retryRow` 的互斥只针对这一行：`rowAborts` / `retryTasks` 防的是「两条执行同时改同一行的状态」）。

**服务端只换判据，执行体一个字不改**：`retryRow` 仍是「同步落 `preparing` → 起 `runRow` → `finally` 里补一次 `finalizeRun`」，只把放行判据换成 `canRunRow`，并按行态写不同的日志与事件标记（`[开始执行]` / `[重新执行]`）；`retryRefusal` 收成一句**竞态兜底**（走到它只可能是「读快照时不在跑、落状态前那一拍它跑起来了」）。

**唯一承重不变量**：单行执行**只动这一行**——本轮其他行的状态、分数、计量、diff、`attempts` 以及它们的事件日志与尝试账本全都逐字不变，串行队列不推进。守卫用三行串行夹具（跑第 1、3 行后只跑中间那一行）：逐字比对另外两行的**全部字段**（`JSON.stringify` 相等）；两行的 `events.jsonl` 与 `attempts.jsonl` 条数都不变；`fakeAgents.calls` 只多一次。

**已知缺口（另行处置）**：`POST …/retry` 会被准备阶段阻塞（`prepareRowWorkspace` 是**同步**重活，跑在 `retryRow` 返回之前 ⇒ 远端仓库 + 冷镜像时该请求可能挂几分钟）；强杀重启会留下在途锁（`recoverInterruptedRuns` 标记为 `interrupted` 的行可能仍有活着的 `runRow` 与厂商 CLI 子进程留在旧模块实例里 ⇒ 该行此后一律 409，只能杀掉残留进程才恢复）。

---

### 13.7 评测的修改与删除

**口径**

- 修改范围 = **用例 + 执行模式 + 使用智能体评分 + 候选行**（与创建表单完全对齐）。
- 只要**没有行在运行**（`!hasLiveRows(run)`）就可以改，改动**作废受影响行的结果**。
- **行 id 是行身份**：编辑入参的候选行带可选 `id`（表单必须能说清「这一行还是原来那一行」）。
- 被改动的行**原地重置**（行 id / 分支 / 工作区路径都不变），只清快照字段。
- **编辑路径不碰文件系统**：产物留给重跑时清理（`prepareRowWorkspace` 会自己清 `workspace/ .agenthome/ .judgehome`，`runRowAttempt` 会 `resetEvents`）。
- 删除**分两步且顺序承重**：① 删 `run.json` ② `rmSync` 整个 `{workspaceBase}/{runId}/`；②失败**只 WARN 并如实回报**（响应 `workspaceRemoved: false`）。
- 用 **`PUT /api/runs/{runId}`**（不是 PATCH）：payload 的语义就是「这一轮应当长成什么样」。
- 编辑表单**复用 `RunCreatePanel`**（加 `mode: 'new' | 'edit'`）。
- 判据只加**一份** `hasLiveRows(run)`，编辑与删除共用。
- 编辑后**轮级状态收敛一次**，用新口径**而不是**现成的 `finalizeRun`（后者对「全行 pending」会落 `partial`）。
- `EvalRun` **不加字段**（列表的「创建时间」是复现条件之一，编辑不该让它变）。
- 新增行的 `workspacePath` 按 **`run.workspaceBase`** 现算，**不用当前 `settings.workspaceRoot`**（一轮的产物必须与它的快照同根）。

**契约（`contracts/src/run.ts`）**

```ts
/** 编辑交回的「这一轮应当长成什么样」：与创建的差别只有候选行可带 id */
export const RunUpdateSchema = RunCreateSchema.extend({
  rows: z.array(z.object({ id: z.string().min(1).optional(), agentKind, providerId, modelId })).min(1),
});
// RunCreateSchema / RunCreate 逐字不变（创建路径不带 id，服务端也不读它）

/** 这一轮此刻还有活在跑吗（轮级 running，或任一行处于 preparing/running/judging） */
export function hasLiveRows(run: EvalRun): boolean;

/** 编辑交回的这一行与现有行还是不是同一件事（三个字段逐字比较） */
export function isSameRowTarget(row: EvalRow, next: { agentKind; providerId; modelId }): boolean;
```

`isSameRowTarget` 也必须在 contracts：它有两个消费方（服务端 `planRunUpdate` 决定重置哪一行、编辑表单**事先算出这次会作废哪几行**），两处各写一份的漂移症状是「确认框说会作废 2 行，实际作废了 1 行」——那正是用户唯一能核对的地方。`providerName` / `baseUrl` 是服务端快照，不入判据。

**逐行处置表（`PUT /api/runs/{runId}`）**

| 编辑动作 | 行快照 | 该行的磁盘产物 |
|---|---|---|
| 只改执行模式 / 只改「使用智能体评分」 | **一行都不动** | 不动 |
| 改某行的 agent 或模型 | 该行**原地重置**：`status → 'pending'`、`baselineCommit → ''`、`tokens / turns / durationMs / diff / score / error → null`、`attempts → 0` | 不动（重跑时既有机制清） |
| 新增一行 | 新 `rowId`（`randomUUID`）+ `branch = test/{rowId}` + `workspacePath = rowWorkspaceDir(run.workspaceBase, runId, rowId)`；`providerName` / `baseUrl` 由服务端快照；其余字段与 `createRun` 的行初值逐字相同 | 无（首次 prepare 时建） |
| 删掉一行 | 从快照移除 | **不动**（孤儿目录留给整轮删除时回收） |
| 换来用例 | 重取 `caseTitle / repoPath / commitHash / repoBranch` 快照 + **所有行**按「原地重置」处理 | 同上 |

行对齐规则（**行 id 是唯一对齐键**）：带 id 且命中 ⇒ 原地更新；带 id 但**不命中** ⇒ 抛 `NOT_FOUND`「该评测里没有这一行（…）」**不静默当新行**；不带 id ⇒ 新行；现有行不在 patch 里 ⇒ 删除。

四条口径：**「改了才重置」按值判**（表单交回来的永远是全量行集合，按「字段出现没有」判会把每次保存都变成全行清空重来）；**`attempts` 在重置时清零**（与 `retryRow` 刻意不清零相反：重试重跑的是同一件事，编辑换掉的是**被评对象**——留着「尝试 3 次」等于让新模型凭空背上旧模型的账）；**轮级状态收敛一次**（在同一个 `saveRun` 里落地，不额外写盘）：全行 `judged` ⇒ `done`（`finishedAt` 已非 null 保留原值，否则填当前时刻）、否则 `startedAt === null` ⇒ `idle`（`finishedAt = null`）、否则 ⇒ `partial`（`finishedAt = null`）；**校验链与创建共用一份，先全校验、再一次性落盘**（顺序逐字沿用 `createRun`；编辑不为已存在的行生成新 id；任何一步抛 ⇒ **一个字节都不写**）。

**互斥与并发**：`hasLiveRows` 之外另加一条纵深守卫——`runTasks` / `retryTasks` / `rescoreTasks` / `rowAborts` 里还有这一轮或这一行的条目 ⇒ 409 `CONFLICT`「上一次的运行还没收尾，请稍候再试」（`hasLiveRows` 读的是**快照**，而行刚落终态、任务还在收尾的那一拍快照是「没有活」）。守卫落在 evaluator（那是这些表的家），api 在算完新快照、写盘**之前**调它。

**删除顺序**：存在性检查（404）→ 同一套互斥守卫 → `hasLiveRows` ⇒ 409 → ① 删 `{run.workspaceBase}/{runId}/run.json` → ② `rmSync({run.workspaceBase}/{runId}/, { recursive: true, force: true })` → 从进程内根记忆里忘掉这一轮（`run-root-memory` 新增 `forgetRunRoot(runId)`）→ ②失败只记 WARN + 响应 `{ workspaceRemoved: false }`。边界：**只删当前 `settings.workspaceRoot` 里可见的那一轮**（与读侧口径一致）。拆两步的理由：整目录一把删时 `rmSync` 的遍历顺序不保证，中途 EPERM 会让「快照到底删没删」变成不确定。

**接口分层**

| 层 | 落点 | 职责 |
|---|---|---|
| contracts | `contracts/src/run.ts` | `RunUpdateSchema` / `hasLiveRows` / `isSameRowTarget` |
| evaluator | `evaluator/src/orchestrator.ts` | `assertRunMutable(runId)`（互斥守卫）与 `deleteRun(runId)`（两步 + 根记忆） |
| api | `api/src/runs.ts` | `updateRun`：取快照 → `hasLiveRows` → 校验链 → 算新快照 → `assertRunMutable` → `saveRun`；`deleteRun`：存在性检查 → 转 evaluator |
| 路由 | `apps/web-next/app/api/runs/[runId]/route.ts` | 现有文件加 `PUT` / `DELETE`，只做「zod 校验 → 调 api → 错误映射」 |

两个都落在 `orchestrator.ts`，**不拆到 `run-store.ts`**：`assertRunMutable` 要看的那四张表都是该模块私有的，而 `deleteRun` 若放进 `run-store.ts` 就会为了这个守卫 import orchestrator，得到循环 import。算新快照拆成两个**可导出、可直测**的函数：`resolveRunRows(input): ResolvedRow[]`（校验链 + 供应商快照，**创建与编辑共用**）、`planRunUpdate(run, resolvedRows, input): EvalRun`（对齐 / 重置 / 轮级收敛，不做 I/O、不查配置与注册表；唯一外部状态是新增行的 `randomUUID()`）。

**界面**：`RunDetailPanel` 顶部信息卡的 `extra` 加「编辑 / 删除」（与 `CaseDetailPanel` 逐字同形）：两个汉字的按钮一律 `autoInsertSpace={false}`；删除用 `Popconfirm` 且 `onConfirm` **必须回交在途 promise**（返回 `undefined` 时确认框立刻关闭，用户会再点一次 = 第二次 DELETE）；删除文案说清「会连这一轮的全部行工作区与执行日志一起删掉，不可恢复」；`hasLiveRows` 为真时两个按钮都 `disabled` + `Tooltip` 说明原因，服务端同一判据抛 409（两层都有）。新增 props `onEdit` / `onDelete` / `deleting?`。编辑表单加 `mode` + `initial?`，行值多带 `id`；提交类型收敛成 `RunFormValues`，`new` **显式剥掉 id** 再交给 `create`（**新建对象**，不动表单内部持有的行值），`edit` 原样交给 `update`；`mode` 与 `initial` 变更靠 `key` 重挂载（`initialValues` 只在挂载时读一次）。**保存前的确认框**：用 `isSameRowTarget` 与 `caseId` 比较算出会作废的行，**非空时** `Modal.confirm` 列出它们（`agentKind · modelId · 原状态`）后才发 `PUT`；**只改执行模式 / 只改评分方式时什么都不作废、不弹**（无事发生却弹窗 = 噪音，弹多了用户就会闭眼点确定）。页面右栏由两种内容变三种：`?panel=detail|new|edit&id=…`（`RunsPanelKind` 加 `'edit'`，`parseRunsPanel` 认 `edit` 且**必须带非空 id**，缺 id 回落「不显示右栏」；未知 `panel` 仍按「有 id 就是 detail」兜底）；列表选中高亮放宽到 `detail | edit`；编辑成功 ⇒ `message.success('评测已保存')` + 回 `?panel=detail&id=`，删除成功 ⇒ 回 `/runs` + `message.success`，`workspaceRemoved === false` 时补一句「行工作区有残留（被占用），可手动清理」。

**数据层**：`useUpdateRun()`（`PUT` → `mutate(runKey(id), updated, { revalidate: false })` + `await mutate(RUNS_KEY)`）、`useDeleteRun()`（`DELETE` → `mutate(runKey(id), undefined, { revalidate: false })` + `await mutate(RUNS_KEY)`）；两个都**不用** `useSWRMutation`（该文件头写明两条理由：runId 是调用时才拿到的；写操作不进 SWR 的 fetcher ⇒「窗口重新获得焦点重发一次写请求」这条坑在形状上不存在）。`api/src/index.ts` 的评测域转出加 `updateRun` / `deleteRun`；`route-runs.test.ts` 对 `@aieval/evaluator` 的手写 mock 键清单**必须跟着补** `assertRunMutable` / `deleteRun`（缺键不是「用例红」，而是模块求值期直接抛「No … export is defined on the mock」）。

**守卫**：只改执行模式 ⇒ 所有行逐字不变；改某行模型 ⇒ **只有那一行**重置；改用例 ⇒ 快照四格重取 + 全行重置；删行 ⇒ 从快照消失且 patch 里的未知 id 抛 `NOT_FOUND`；新增行的 `workspacePath` 落在 `run.workspaceBase` 下；`attempts` 归零（未被重置的行保留）；轮级收敛三条分支各按口径；运行中 / 在途任务未收尾 ⇒ 409、校验失败 ⇒ 一个字节都不写；`deleteRun` 的顺序断言 + 回收失败仍删快照 + 删后 `getRun` 404 + 根记忆被忘记；编辑表单预填**带行 id**；确认框该弹时列出被作废的行、不该弹时不弹。

---

### 13.8 「变更详情」抽屉（逐文件 + 吸顶标题 + 惰性加载）

**形态**：文件名 + 内容的**一个可滚动列表**，向下滚动时当前文件标题**吸顶**，改动内容用 diff 组件渲染；抽屉标题「变更详情」。

**组件**：`react-diff-viewer-continued@4.4.0`（`react-diff-viewer` 3.1.1 的 peer 不含 React 19、已 6 年未发版；continued 是同 API 的维护分支，额外白拿 `highlightLanguage` 与内置行虚拟化）。

**一个必须写清的接口错配**：该系列的 `oldValue` / `newValue` 收的是**完整文件正文**，不是 diff 文本；把 diff 文本直接当 `newValue`、`oldValue` 传空串，会渲染出一份**完全错误的 diff**（`+foo` 变成「新增了一行字面量 `+foo`」）。**由 diff 文本还原两侧正文**：解析 hunk 头拿行号，用上下文行与 `/^-/` 行拼旧侧、用上下文行与 `/^+/` 行拼新侧，**并用 hunk 头的行号把两侧补空行对齐**（缺失行填 `''`），组件侧同时传 `showDiffOnly={false}` 让对齐后的空行如实显示为「未修改」；`extraLinesSurroundingDiff` 保持默认。理由：diff 文本已经是服务端算好的唯一真源，另取全文会让「界面显示的改动」与「评分模型看到的改动」变成两次独立计算，而这两者必须逐字一致。`oldValue === newValue` 时（纯二进制改动）不渲染 diff 视图，显示「二进制文件，无文本改动可显示」。

**超万个文件变更**

1. **正文已经有硬上限**：`RowDiff.text` 经 `truncateDiff(text, settings.diffBudgetBytes)` 裁剪（默认 **262144 字节 = 256 KB**），按 `diff --git` 整段保留到预算为止，超出部分只留文件名。
2. **`RowDiff.files` 没有上限** ⇒ 真正的风险在文件清单本身。三条对策：**文件索引与正文拆成两个接口**（索引不含任何 diff 正文，按 `offset` / `limit` **分页**，每页 30，界面逐页追加 ⇒ DOM 里始终只有几十行）；**正文按需、逐个文件加载**（`IntersectionObserver` 触发，任何一次响应都不携带「全部文件」）；**单个文件的正文不做二次截断**——`truncateDiff` 是按**整文件**丢弃的，**永远不会把一个文件的正文切一半** ⇒ 「某文件正文显示了一半」这个状态不可能出现，故 `RowDiffFile` **没有** `truncated` 字段（留一个恒为 `false` 的字段，下一个人会照着它写一条永远进不去的分支）。
3. **吸顶与惰性加载是同一个机制**：滚动正是加载的触发器，两件事在同一时刻发生，不需要两套滚动监听。
4. **服务端计算缓存**：api 层加**进程内**结果缓存，键 `(runId, rowId)`，值 = `collectDiff` 的原始输出 + 预算裁剪结果，**TTL 30 秒**。语义是「打开抽屉这半分钟内的快照」，与 `useRowDiff` 现有的 `revalidateOnFocus: false` 口径一致；不做主动失效（候选中途会写盘，主动失效要在编排层埋钩子）；缓存只在内存、进程重启即失效。

**契约（替换 `RowDiffSchema`，是替换而不是并存——调用方只有抽屉一处）**

```ts
export const RowDiffIndexSchema = z.object({
  files: z.array(z.object({
    path: z.string(), insertions: z.number(), deletions: z.number(),
    untracked: z.boolean(),        // 该文件在「未跟踪文件」段里
    hasBody: z.boolean(),          // false = 被 256 KB 预算丢弃 ⇒ 界面不给加载入口
  })),                             // 已按路径排序
  total: z.number(),               // 文件总数（不受分页影响）
  offset: z.number(),
  insertions: z.number(), deletions: z.number(),   // **全部文件**的增删合计（不是本页——头部要的是全局值）
  noBodyCount: z.number(),         // 全部文件里有多少个没有正文
  truncated: z.boolean(),
  droppedFiles: z.array(z.string()),               // 被预算丢弃的文件名（评分模型看不到它们）
});

export const RowDiffFileSchema = z.object({
  path: z.string(),
  patch: z.string(),               // 该文件那一段统一 diff 原文
  insertions: z.number(), deletions: z.number(),
  binary: z.boolean(),             // true 时界面不渲染 diff 视图
});
```

`hasBody` 的存在理由：**让「被预算丢弃」在界面上是可预期的，而不是点一下才发现没有**；它由服务端按预算算出，与 `droppedFiles` 同源。

**服务端**

- `core/src/git.ts` 新增导出 `extractDiffFile(text, path): string | undefined`（按路径取某一段 diff 原文）。**必须复用私有的 `splitDiffFiles`，不得另写一份切分逻辑**（两份切分器漂移的表现是「索引里有的文件，正文永远取不到」，且只在路径含特殊字符时出现）。**必须处理一处已存在的陷阱**：`splitDiffFiles` 从 `diff --git a/X b/Y` 取路径时是**原样取**的，而 `RowDiff.files[].path` 来自 `--numstat` 并**经过 `rewriteRenamePath` 规范化**（花括号重命名 `packages/{old => new}/x.ts` → `packages/new/x.ts`）⇒ 两个来源的路径键可能不相等，按未规范化的键去找，重命名文件的正文永远取不到。故 `extractDiffFile` **必须对切出的路径同样套一次 `rewriteRenamePath`** 再比对（该函数对已规范化的路径是幂等的）。**同名文件在「已提交」与「未提交」两段都出现时取「未提交」那一段**（未跟踪文件的正文只在未提交段；且未提交段反映的是工作区当前状态，用户打开抽屉想看的正是「现在这个文件被我改成什么样了」）。
- `api/src/run-artifacts.ts`：`getRowDiffIndex(runId, rowId, offset, limit)` 与 `getRowDiffFile(runId, rowId, path)`，两者共用一次 `collectDiff` 结果（即那 30 秒缓存）保证同源。`getRowDiffFile` 对未知路径抛 `NOT_FOUND`、对 `hasBody === false` 的路径抛 `CONFLICT` 并说明是被预算丢弃——**两条必须分开**（「这个文件不存在于本次改动」与「它存在但正文被裁了」在排障时是两回事）。
- 路由 `…/rows/[rowId]/diff/route.ts` 改读查询参数：`?offset=0&limit=30` → 索引（`limit` 服务端封顶 200）；`?file=<path>` → 单文件。`file` 需 `decodeURIComponent` 且**路径不得被当作文件系统路径使用**（只用来在内存里比对 diff 段落中的路径字符串，不参与任何 `path.join`）；`offset` / `limit` 非法一律按默认值处理而不是 400（只读展示接口，宽容降级比报错更有用）。

**客户端**

- `client/src/runs.ts`：`useRowDiffIndex(runId, rowId, enabled, offset, limit)`（沿用 `revalidateOnFocus: false`）；`useRowDiffFile(runId, rowId, enabled, path)`（**`path` 为 `undefined` 时 key 传 `null`**——这正是「滚动到才加载」的开关，不需要另造 `enabled` 布尔）。
- `ui/composite/diff-view.tsx` 重写：

```ts
export interface DiffViewProps {
  index: RowDiffIndex | undefined;
  /** 逐文件正文：由调用方注入，本包不调接口 */
  loadFile: (path: string) => { patch: string | undefined; error: unknown; isLoading: boolean };
  onLoadMore?: () => void;
  dark: boolean;
}
```

- **布局**：汇总条（`共 N 个文件 · +X −Y` + 截断提示，**文案沿用「评分模型看不到它们」**——改成「已截断」会让人以为只是界面没显示全）→ 搜索框（按路径过滤，只对**已加载页**做 `includes` 并提示「仅过滤已加载的 N 个文件」，不做服务端搜索）→ 文件列表（每项 = 吸顶标题 + 正文；标题 `position: sticky; top: 0`，**滚动容器是列表自己**——sticky 相对最近的滚动祖先定位；标题内容 = 路径（等宽）+ `+X −Y` + 未跟踪标签 + 该文件正文的截断 / 二进制标记；`hasBody === false` 的条目标题照常吸顶、正文位置显示「该文件超出体积上限，未包含在本轮评分输入中」且不给加载入口；正文由 `IntersectionObserver` 在进入视口时 `loadFile(path)`；加载中显示 **`Skeleton`，不是空白**——空白会被误读成「这个文件没改动」）→ 列表底部哨兵元素触发下一页。diff 组件 `disableWorker` 传 `true`（每行一个 worker 在几十个文件同时进视口时是纯开销，且 jsdom 里没有 worker）。
- **抽屉几何（三个抽屉共用）**：宽度 `styles={{ wrapper: { width: 'max(50vw, 800px)', maxWidth: '100vw' } }}`（用 CSS `max()` 而不是在 JS 里量窗口；**显式写 `maxWidth` 是为了让「窄屏下 800px 下限不许撑出屏幕」这条意图留在代码里**；去掉 `size="large"`——它与 `styles.wrapper.width` 同时给会打架）；内容区 `styles={{ body: { padding: 0 } }}`，内边距由**每个抽屉的内容自己提供**（变更详情：汇总条与搜索框各带横向 padding，**文件标题条与 diff 正文也带**但标题条的吸顶底色要铺满整宽 ⇒ padding 加在内层元素上；执行日志：`LogView` 最外层 `Flex` 加 padding；评分详情：最外层加 padding）；限高**去掉写死的 `maxHeight={420}`**——高度链由 antd 自己铺好（`.ant-drawer-section` 是 flex 列 + `height:100%`、`.ant-drawer-body` 是 `flex:1; min-height:0; overflow:auto`）⇒「随窗口自适应」= 什么都不写。**抽屉内只有一个滚动容器，就是 `.ant-drawer-body` 本身**：它自己已经是 `overflow: auto`，而 sticky 相对最近的滚动祖先定位 ⇒ 不要在它内部再套一层 `overflow: auto`；内容高度用 `minHeight: '100%'`（不是 `height`，否则内容短于视口时铺不满）。**已核实 body 没有任何祖先带 `transform`**（`.ant-drawer` 是 `position: fixed`、content-wrapper 是 `position: absolute`，`transition` 不是 `transform`）——若日后给抽屉加 `transform` 动画（会创建新的包含块），吸顶会静默失效，这一条是那一处的护栏。**不给抽屉加 `resizable`**（需求方给的是确定口径，再加一层可拖拽会让「宽度是多少」出现两个答案；真要放开就接进 `ListDetailLayout` 那套宽度偏好）。
  > **执行日志抽屉是例外**：它改用虚拟列表自持滚动容器（虚拟列表需要确定高度的视口，而 body 的高度靠 flex 取、给不到那个数）⇒ 那个抽屉的最外层取满父容器（`height: '100%'`）、固定区占自然高度、列表用 flex 取剩余高度。`body.padding: 0` 与宽度那两条照旧适用。
- `dark` **由调用方传入**（`useResolvedTheme().mode === 'dark'`），不从 `ui` 包内部猜（避免第二份主题判据 = 半亮主题）。页面把 `useRowDiffIndex` / `useRowDiffFile` 与主题接进新的 `DiffView`，抽屉 `title` 改为「变更详情」。

**「未跟踪文件」段不单独呈现**，只靠文件清单里该条目的「未跟踪」标签体现；不做 diff 行内评论、不做并排 / 内联切换的偏好持久化、不做文件树。

**守卫**：**还原算法**的单测（给一段含两个相隔很远的 hunk 的 diff，断言还原出的两侧正文长度一致、且第二处改动的行号与 hunk 头一致——这条是防「相隔 200 行的改动被渲染成相邻」的回归守卫，是整个重设计里最容易写错的一处）；`extractDiffFile` 的正常路径 / 路径不存在 / 重命名 `=>` / `{a => b}` / 含空格路径 / **同名文件在两段中都出现时取未提交段**；索引分页与 `hasBody`；`getRowDiffFile` 的 `NOT_FOUND` 与 `CONFLICT` 两条分开断言；路由的 `?offset/limit`、`limit` 封顶、`?file=`；`diff-view.test.tsx` **逐字保留**「截断提示必须说『评分模型看不到』」那条，并新增吸顶 / 骨架 / `hasBody=false` 文案 / 惰性触发。

---

### 13.9 测试墙钟：进程创建预算

**计价单位是「进程创建」**（本机 i7-1360P / Windows 实测）：`cmd /c exit 0` **162 ms**、`git --version` **566 ms**、`node --version` **530 ms** —— 企业 DLP/EDR 在每个新进程上挂钩（Defender 实时防护是**关**的）。由此推导：`initFixtureRepo`（7 次 git）≈ **1612 ms**、本地 `git clone` ≈ **1053 ms**、`git status` ≈ 251 ms。

**三条推论**：墙钟不是「所有测试之和」，而是「**最长的那个文件**」（vitest 按**文件**并行、文件内**顺序**执行）；**失败比成功贵一个数量级**（守卫上限按「宁可超时也不假红」定，条件一旦不可能成立就把预算烧完）；**并发不是免费的**（15 路 worker 抢同一条进程创建管道时每次 spawn 都更贵）。

**测试侧**

1. **守卫 fail-fast**：`until(condition, label, timeoutMs, impossible?)` 的第 4 个可选参数每轮先问「条件已经不可能成立吗」，成立就**立刻带诊断抛错**（消息同时给出「等的是什么」与「为什么不可能」）。**上限一个都不改**；`impossible` 的判据取自被测对象自己的终态，不新造语义；**只给终态期望的等待接 `impossible`**（落成别的终态就是真失败），同步点式的等待刻意不接（避免把「错过观察」判成假红）。
2. **长杆文件按 describe 拆开**：`orchestrator.test.ts`（2543 行 / 86 条用例挤在一个文件里 ⇒ 独占一个 worker 顺序跑完全程，墙钟被它钉死）拆成 10 个文件 + 1 个共享 harness `evaluator/src/testing/orchestrator-harness.ts`（导出 `injected` / `resetInjected()` / 三个 mock 工厂 / `until()` / `seedRunnableRun()` / `TEST_TIMEOUT_MS` / `REMOTE_FIXTURE_TIMEOUT_MS` 与既有的事件读取、cwd 断言小工具）。
   **`vi.mock` 必须在测试文件自身里调用**（vitest 只对它做前置提升）⇒ 每个新文件保留一段固定的三行前置块。**这是本设计唯一的静默失效路径**：漏写 `@aieval/agents` 的 mock 会让测试**真的去 spawn 厂商 CLI**。防它的守卫落在 `evaluator/src/static-assertions.test.ts`：逐个读取这些文件，断言每个都含三条 `vi.mock(` 注册，缺一条即红。
3. **夹具减 spawn**（两件独立的事，各自可单独回滚）：**仓库模板**——harness 的 `beforeAll` 建**一个**模板仓库（`initFixtureRepo` 一次），每条用例 `cpSync` 一份到自己的 `home.root/repo-<uuid>`（纯文件系统，实测 ~10 ms）；**用例缓存预热**——`beforeAll` 克隆**一份**模板缓存，每条用例把它 `cpSync` 到 `caseCacheDir(...)` 并写 `.git/aieval-origin.json`。预热**只对钉死 `commitHash` 的用例**做：`commitHash === null` 的语义是「跟随来源 tip」（走 `refreshCacheToSourceHead → fetch origin`），预热出来的缓存 `origin` 指向模板而不是该用例的仓库，语义会漂。
4. **并发度实测选值**：在最终状态上跑 `--maxWorkers=4` / `=8` / 默认三档全量，取**墙钟最短**的一档写进根 `vitest.config.ts`（附注释写明是实测值、测法与日期），并核对三档的用例总数与红数一致；差异在噪声内就**不写**这个配置（少一个要维护的魔数）。命令行覆盖永远赢过配置文件。
5. **跑法分层**：`test:changed`（`vitest run --changed`）进 `package.json`；`test` 仍是门禁口径。**不新增**「跳过重文件」的假门禁，**不删用例、不加 `skip`/`todo`、不用 `--changed` 冒充门禁、不改 `expect` 的强度、不放宽任何守卫上限**（要的是「失败得早」，不是「等得久」）。
6. **机器带负载时的跑法**：`pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000`；**先看 `tests` 累积项**——比上次大 2 倍以上就别把红当成回归。

**产品侧：合并 git 往返**（`core/src/git.ts`，输出逐字节等价）

| 现状 | 目标 | 判据 |
|---|---|---|
| `diff --numstat HEAD` + `diff HEAD`（2 进程） | `diff --numstat --no-color -p HEAD`（1 进程） | 一次输出里 **numstat 块在前、补丁块在后**，退出码 0 |
| `diff --numstat base..HEAD` + `diff base..HEAD`（2 进程） | `diff --numstat --no-color -p base..HEAD`（1 进程） | 同上 |
| `cat-file -e <hash>^{commit}` + `rev-parse <hash>^{commit}`（2 进程） | `rev-parse --verify <hash>^{commit}`（1 进程） | 短 hash 归一到 40 位；blob → 非零退出；不存在的 hash → 非零退出 |

**解析设计**：合并输出按**第一条行首的 `diff --git `** 切成「numstat 段 + 补丁段」；numstat 段交给现有 `parseNumstat`，补丁段就是今天 `committed` / `uncommitted` 的取值。三种边界都要有守卫：两段都为空（无改动）、只有 numstat（二进制 / gitignore 边界）、**补丁正文里出现形如 `1\t2\tx` 的行必须不被误认成 numstat**（切分点只看行首 `diff --git `）。**错误面不变**：不使用 `--quiet`（它会吃掉 stderr），`gitMessage(error)` 仍能取到 git 原文，`ServiceError` 的 code 与中文原因的形状、`context` 字段一律保持。**不消除** `ensureCaseCache` 与 `checkoutRow` 对同一 commit 的重复校验（要改 `checkoutRow` 入参，属接口变更，收益 1 进程/行，不划算）。

**验证口径**：改前基线 → 同一命令同一机器同一天的改后复测 → 墙钟对比表（含用例总数与红数）；**用例总数只增不减**（拆文件后按 AGENT.md 要求逐包核对总数与全量一致——漏收集一整个包是静默漏测）；每条新守卫做变异验证（去掉 `impossible` ⇒ 红用例重新等满 60 s/300 s；删一行 `vi.mock` ⇒ 静态守卫红；把 diff 切分点改错 ⇒ `git.diff.test.ts` 红）。

---

### 13.10 子智能体用量与轮次口径

**口径（行级三格）**

| 项 | 口径 |
|---|---|
| 范围 | 候选**自己派发的全部子智能体**（claude `Task` / dsh `subagent` / codex `spawn_agent`），**含嵌套** |
| 不含 | **评分智能体**（`judgeRowByAgent` 那个独立的 agent）——它报的是评审者的成本，与「这个候选多省」是两件事；候选阶段结束即冻结（`candidateEnded` 之后的事件折不进这三格） |
| tok | `input + output` 的**全树**合计（主会话 + 全部子智能体） |
| 缓存命中 | 由全树三元组派生 `cached / (input + cached)`，不新增采集字段 |
| 轮次 | **主会话轮次 + 各子智能体轮次之和**（「一次模型 API 往返」是唯一单位）：合计在 `turns`，**子那一份单列在 `subagentTurns`** |
| 耗时 / 得分 | 不动（耗时仍是候选那一段的墙钟，子智能体的时间本来就在其中） |

**契约**

```ts
/** 子智能体那一份用量（主会话之外）；null = 没采到（含这家没有子智能体通道 / 这一行还没跑完） */
subagentTokens: { input: number; cached: number; output: number } | null
/** 子智能体那一份轮次；null = 没采到（含「有任何一个子智能体读不出轮次」） */
subagentTurns: number | null
```

- `{0,0,0}` / `0` = **确实没有子智能体**；`null` = **没采到**。两者必须长得不一样（与全仓 `null ≠ 0` 的硬口径同源）；**在契约与日志里承重**，在界面那一行浮层里不承重（§13.10 末段）。
- **「全量或 null」是硬规则**（三档）：

  | 情形 | 分量 | 合计 |
  |---|---|---|
  | 没有子智能体 | `{0,0,0}` / `0` | 主会话（全树恒等式仍成立） |
  | 有子智能体且**一个都没读失败** | Σ 各子（仍在跑的那个算「到目前为止」） | 主 + Σ |
  | 有子智能体但**有任何一个读失败** | `null`（**三家一致** ⇒ 界面一律退回一行） | **读盘拼合计的那两家**（codex / claude）退回主会话口径；**dsh 不退**（它的合计是逐条累加的流水，已经并进来的子会话用量退不回去——把已收到的丢掉等于让卡片**少报**） |
  | **合计自己也拿不出来**（主会话一次往返都没数到） | `null`（**与合计同生共死，不留孤儿分量**） | `null` |

- 三家的**共同保证**因此落在两条上：① 分量一律 `null`（界面据此一律退回一行）；② **恒有 `subagentTokens ≤ tokens`（逐格）与 `subagentTurns ≤ turns`**。
- 「读失败」= **读不到**（文件不在、格式读不动），**不是**「它还在跑」——跑动期的数本来就是「到目前为止」；而一个已经收场却读不出用量的子智能体是**事实缺失**。
- **「全量或 null」与「点名 WARN」是同一条硬规则**，但它只管「**因读不到而** `null`」那一档；**孤儿档（合计拿不出来）不补 WARN**（那一刻没有「谁没报」可言）。`null` 的判据与用量那一格**同一份**（不另造第二个谓词），否则会出现「结果是 `null`、日志里点不出人」。
- **R2 的不对称**（三处 write site 逐字适用：`turn.ts` 的投影折叠、`turn.ts` 的收尾折叠、`orchestrator.ts` 的 `patchRow`）：**显式 `null` = 「明确没采到」⇒ 清**；**缺键 = 「本条不带」⇒ 保持**。
- **运行期是否交出分量由各家的合计口径决定**：运行期 `turns` 已是全树（dsh）就同刻交；运行期 `turns` 只有主线程（codex / claude）就**不交**——交出去会立刻破坏 `subagentTurns ≤ turns`（真机形状：主线程 1 轮派活、子线程跑 5 轮 ⇒ 界面按「主会话 = 合计 − 分量」算出**负数**）。**终态值必须齐**（终态不齐就是缺陷）：`finalTurns = lastTurns + subagentTurns`，`finalTurns === null` 时分量也必须是 `null`。
- 老 `run.json` 没有这两格 ⇒ contracts 用**可选格**（与 `attempts` / `effort` / `stage` 同一条处置：必填会让 `listRuns()` 静默跳过老记录）。
- 传播链（一站不缺，缺一站界面就看不到）：`TurnProjection.subagentTokens/subagentTurns` → `usage` 事件 → `AgentRunResult` → `EvalRow` → `RowLiveMetrics` / `LiveMetricsView` → `MetricLine` 的第二行 Tooltip。

**三家取数**

| 家 | 子那一份用量 | 子那一份轮次 |
|---|---|---|
| dsh | Σ 本行**子会话白名单**的 `sessionUsage[id]`（`sessionUsage` 是模块级表，主会话之外还有**别的行**的会话 ⇒ 必须按白名单才与行绑定） | Σ 白名单的 `step/start` 计数（**与合计同一个计数点**：`noteDshSessionTurn` 就写在 `state.turns += 1` 的同一处、同一张模块级表的另一张表、同一个清空口）；两格由同一条事件驱动 ⇒ `subagentTurns ≤ turns` 是**构造上的** |
| codex | Σ `normalizedTotalUsage(child)`（子线程会话文件的 `token_count.info.total_token_usage`） | Σ `child.turnIds.length`（**只收「真的有内容」的轮**：桶里得有本模块消费的记录类型——fork 会把派发者那一轮的开工痕迹抄进子线程文件，只有开工痕迹的桶不算一轮，否则子线程轮次多 1） |
| claude-code | 读 CLI 转录目录，按 `message.id` **去重后**逐格求和（同一往返会按内容块出现多次、第一条的 `output_tokens` 是 0 ⇒ 不去重会双计 input / cached） | 同一份转录里 `message.id` 去重后的**个数**（**与用量同一次读盘**） |

**dsh 的三段出口**：分量在带分量的三条事件出口（`step/start`、`assistant/message`、`turn/end`）上**一起交两格**（否则会出现「上一版的非零用量分量 + `null` 的轮次分量」两句互相矛盾的话摆在同一格上）；**收尾也交一次**（子会话收场却没用量这个结论是在**不带轮次**的 `subagent.finished` 上成立的，那一轮之后再没有消息时结论就送不出去）。`null` 时**必须点名**（WARN 列出「已收场却没有用量事件」的子会话 id）；`{0,0,0}` / `0` 那一档**不刷噪声**。累加**没有去重键**（这一家从不写 `state.seen`）：唯一的去重是 `usage` 事件的发射门（与上次逐字段相同就不发），它只决定「要不要发这条事件」，不改已累加的值。

**codex 的取数面**：种子 = 事件流点名的 `receiver_thread_ids`，再由 `discoverChildThreads` 沿每个线程自己文件里的派发证据**逐层展开**（两种外形都要认：子线程自己拿到了多智能体工具时的 `CollabAgentToolCall.receiver_thread_ids`；子线程 shell 出去起了另一个 codex 时，新会话 id 只出现在 **CLI 启动横幅** `session id: <uuid>` 一行里——判据**刻意写窄**，宽判据会把「列会话目录」「cat 别人的 rollout」也算成派发 ⇒ **多算**）。两条上限：深度 8 / 递归**自己发现到**的线程数 32（**种子是事件流点名的事实、不占这个预算**）；**被上限真的砍掉分支 ⇒ 分量整格 `null`**（不拿部分和冒充总数），那条点名 WARN 说的是**整行**（截断时 `tokens` / 缓存命中 / `轮次` 三格一起退回主线程口径）。**旧会话排除**：`codex exec resume` 复用旧会话并打出同一条横幅 ⇒ 判据落在**时序**上——候选的 `session_meta.timestamp` **严格早于**派发线程创建时刻则判为旧会话排除并逐个点名；**「派发者创建时刻」取内层 `payload.timestamp`**（厂商记的「会话被创建」，不是行首外层那一个「这行被写下来的时刻」），两侧必须比各自「被创建的时刻」这一同类量。

**claude 的读取（`subagent-usage.ts`）**：路径 `<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`（`sessionId` 来自 `system/init`；**采不到就不猜目录**——猜错会把别的会话的转录算到这一行上）。**单个文件的读数规则**：逐行 JSON；半截行 / 坏行跳过（CLI 边跑边写，这是常态）；只认 `type === 'assistant'`；按 `message.id` **去重、后到覆盖**；三项（`input_tokens` / `cache_read_input_tokens` / `output_tokens`）缺一，或认得是 `assistant` 却拿不到 `message.id` ⇒ **整份文件作废**（跳过会让那一次往返从合计与轮次里一起消失）；一条可用记录都没有（空文件 / 被中断在半截）⇒ 同样作废。**聚合（读取集 = 目录里枚举出来的转录 ∪ 事实核对名单）**：盘上有就必须读（转录比事件流更硬），名单里有就必须读得动；**有任何一个进 `missing` ⇒ 两格一起 `null`** + 一条**点名** WARN（读到的那些**不进合计**）。**形状判据（决定谁进名单）**：`subagent_type` / `spawn_depth` / `prompt` **至少一格非 `null`**（`''` 与 `0` 都算「给了」——判严了会把真派发判成幻影，比多一条幽灵行更坏）；判决**只在 `start` 帧上做**（**收场帧不承载形状证据**：审计投影只在 `start` 相位写那三格、CLI 的会话转录里根本没有 `task_*` 帧；逐帧判 = 拿一个不承载证据的帧去判 ⇒ 每个真派发的收场帧都被判成幻影），收场帧按**同一个 id 追随** `start` 帧的判决。三档：幻影（三格全空）**不产行**、**不进名单**；**只见到收场帧**的 id **照产行**（丢一个真派发比多一条幽灵行更坏）、**不要求它有转录**、两格照算，但盘上没有它的转录时落一条**不叫它子智能体**的 WARN（「…没有转录：这一行的 tok / 缓存命中 / 轮次可能少算它（无法判定它是不是子智能体）」）；**「确实没有」的出口**：会话目录不存在、或目录里一个转录都没有且名单里也没有形状像派发的 id ⇒ `{0,0,0}` / `0`。**读取实现**：**同步分块流式读**（`openSync` + 64 KB `readSync` + `StringDecoder`，**不许** `readFileSync` 整份 ⇒ 峰值内存从「整份 + 行数组」降到「最大单行 + 一块」；**必须同步**——`finalize` / `project` 都是同步钩子，改异步要动钩子签名并波及另两家）；**同版本不重复解析**（给「路径 + size + mtime」加一个 **run 作用域**的小缓存，不是模块级：避免跨 run 留大对象；收尾那一次读取**仍然真读**）；**两个读出口共用同一个缓存**（子任务条那一格与收尾合计各只 open 一次）。**读数时机**：子智能体的转录**只在收尾读一次**（终态通知那一帧只登记记录，**不读盘**），且 `rememberSubagent` 连**派发帧**（`running`）一起登记（终态优先）⇒ 没有终态通知的子智能体（CLI 没投送 `task_notification` / 运行被中断）在收尾那批里也有它。**不发逐轮读数**：事件流里 `turn.subagentId` 恒 `null`。

**界面（`MetricLine` 的 Tooltip）**：只在**真有分量**时画第二行，主会话那一行由**相减**得出（`tokens − subagentTokens` / `turns − subagentTurns`，派生而非第二份真值）。

| 格 | 画第二行的判据（缺一条就退回改动前那一行） |
|---|---|
| tok / 缓存命中 | 分量**在**（不是缺格）、三项之和**不全为 0**、且**逐格 ≤ 合计**。即便不拆也有一行「输入 … · 缓存 … · 输出 …」可讲（合计本身） |
| 轮次 | 分量**在**、`> 0`、且 `≤ turns`。**没有分量可拆时连浮层都不出现**——这一格只讲「怎么拆」 |

- 卡片正文仍是合计那**一个**数，不因拆分改口径。
- **`{0,0,0}` 与 `null` 在这一格上渲染逐字相同（都只有一行）**：两者的区别在**契约与日志**里承重，界面这一格回答的是「子那一份怎么拆」——没有可拆的东西时，两种情形要画的本就是同一行。
- **`≤ 合计` 是纵深防御**：一份老 `run.json` 或一次将来引入的缺陷都会以「两行自己都不自洽」的形式出现在用户面前，而那种画面看起来完全正常。
- **浮层类否定面的断言必须等满延迟窗口**（antd 的 `mouseEnterDelay` 默认 0.1 s，悬浮完同步查 `.ant-tooltip` 在任何实现下都为真）⇒ 用 `expectNoTooltip()`，不要同步断言。

**已知边界（如实登记）**：dsh / codex 的 `{0,0,0}` 带前置条件——codex 的子线程 id **唯一**来源是事件流的 `receiver_thread_ids`，路由拒绝命名空间工具 / `multi_agent=false` / CLI 换形状时它为空 ⇒ 它说的是「**本次没观察到**」，不是对事实的证明（文案写「本次未观察到子智能体」）；claude 的**嵌套**子智能体若转录落在别处（不在同一个会话的 `subagents/` 里），既不在目录里也不在名单里 ⇒ **既不进合计、也不会被点名**（「部分和冒充总数」那一半已关闭，「看不见」这一半仍开着）；`codex exec resume` 复用旧会话那条只挡住了「明显早于派发者」的一半，**不要当成「已证明没有多计」**；codex 的子线程轮次可能少 1（方向是**少计**：只有一个外层用量记录的桶会漏一轮）。
