# AI 生成代码评测工具 —— 脚手架设计（初始化项目）

日期：2026-09-22
状态：**已实现**（2026-09-24 复核；由本文档生成实施计划 `../plans/2026-09-22-scaffold.md`）
范围：**只做框架**。搭好 monorepo、分包、界面原语、主题、列表 + 右边栏示例页，使后续三个功能域可以并行往上填。
配套文档：功能设计见同目录 `2026-09-22-features-design.md`；实施计划见 `../plans/2026-09-22-scaffold.md`（本 spec 是它的上游依据，对应关系见 §12）。
性质：本文档**自包含**——技术栈、脚手架配置、界面原语的实现契约与关键代码全部内联，实施时不需要参照任何外部仓库。

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
