# AI 生成代码评测工具 —— 脚手架设计（初始化项目）

日期：2026-09-22
状态：待评审
范围：**只做框架**。搭好 monorepo、分包、界面原语、主题、列表 + 右边栏示例页，使后续三个功能域可以并行往上填。
配套文档：功能设计见同目录 `2026-09-22-features-design.md`。
性质：本文档**自包含**——技术栈、脚手架配置、界面原语的实现契约与关键代码全部内联，实施时不需要参照任何外部仓库。

---

## 1. 本文档要交付什么

一句话：**一个能跑起来的空壳 + 一个证明空壳可用的列表示例**。

具体交付物：

1. pnpm monorepo，8 个包全部建好，`withBoundary` 分层边界生效（越界 import 直接报错）。
2. Next.js 应用在 `:3083` 起得来，顶栏（用例 / 评测 / 设置 + 主题切换）可见可点。
3. 亮/暗双主题落地，**三处消费点同步**（组件、CSS 底色、静态 portal），跟随系统开关即时生效。
4. 界面原语就位：`PageShell`、`SplitPane`、`ResizableColumns`、`stored-preference`、紧凑密度、空态等。
5. **一个列表示例页**：左侧列表 + 右侧可拖拽宽度详情栏，宽度刷新后还原 —— 用来证明第 2–4 项真的能用。
6. `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条命令全绿。

**明确不做**（属于功能阶段）：

- 任何真实业务数据。示例页用内存里的假数据，不落盘、不调接口。
- 供应商 / 用例 / 评测三个功能域。
- 三个智能体适配器、编排状态机、评分器、SSE 流。
- 任何 `/api` 路由（除一条 `GET /api/health` 之类的最小连通性检查，可选）。

**示例页是过渡产物**：功能阶段实现真实用例管理页时，删除 `/demo` 路由。它的价值在于把「原语能不能组合出目标形态」这件事在写业务之前就验证掉——尤其是右边栏的可拖拽宽度与刷新还原，这类问题越晚发现返工越贵。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 包管理 | pnpm（workspace，`preinstall` 强制只允许 pnpm） |
| 框架 | Next.js 16（App Router：Server Components + Route Handlers） |
| 语言 | TypeScript 5（全链 `tsc --noEmit`） |
| UI 组件库 | antd 6 + `@ant-design/icons` |
| 数据层 | SWR 2（REST）+ EventSource（SSE）——脚手架期先装好、示例页用内存数据 |
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
│   │   ├── contracts/       # zod 契约 + 错误码（本阶段只放错误模型与 Settings 骨架）
│   │   ├── core/            # 工作区引擎：git CLI 原语、config-store（本阶段只放 config-store 与路径校验）
│   │   ├── agents/          # 智能体抽象层（本阶段只放接口定义 + 假实现）
│   │   ├── evaluator/       # 编排与评分（本阶段只放目录与空出口）
│   │   └── api/             # 业务服务层，禁框架（本阶段只放 settings 的读写）
│   └── client/
│       ├── ui/              # 纯展示组件（base + composite），不调接口
│       └── client/          # SWR hooks + SSE 订阅（本阶段只放 http 四函数与 useSettings）
├── docs/
├── eslint.shared.ts         # 共享规则 + withBoundary 分层硬约束
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .editorconfig
└── package.json
```

### 4.1 依赖方向（硬约束）

```
web-next → api / ui / client / contracts
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
| `contracts` | `ERROR_CODES` / `httpStatusFor` / `ServiceError` / `Settings` 的 zod schema + 类型 | zod |
| `core` | `config-store`（原子写 + BOM 容忍 + 0600）、`paths`（`~` 展开、可写性校验） | 无 |
| `agents` | `AgentRunInput` / `AgentRunResult` / `AgentEvent` 接口定义 + 一个 `fake` 适配器（供测试与示例用） | 无（三家 SDK 到功能阶段再装） |
| `evaluator` | 目录 + 空出口（`export {}`） | 无 |
| `api` | `getSettings` / `updateSettings` | `core` / `contracts` |
| `ui` | §6 的全部原语 | antd / react / `contracts` |
| `client` | `http` 四函数、`useSettings` | swr / `contracts` |
| `web-next` | 壳、Providers、顶栏、`/demo`、`/settings`（仅主题项）、`/api/health`、`/api/settings` | 全部 |

---

## 5. 脚手架配置（可直接落地）

### 5.1 `pnpm-workspace.yaml`

```yaml
packages:
  - apps/*
  - packages/server/*
  - packages/client/*

onlyBuiltDependencies:
  - esbuild
```

### 5.2 根 `package.json`

```json
{
  "name": "ai-result-evaluation",
  "private": true,
  "packageManager": "pnpm@10.26.2",
  "scripts": {
    "preinstall": "node -e \"if(!/pnpm/i.test(process.env.npm_config_user_agent||'')){console.error('[禁止] 本项目仅允许使用 pnpm 安装依赖，请运行: corepack enable && pnpm install');process.exit(1)}\"",
    "build": "pnpm -r build",
    "dev": "pnpm -r dev",
    "lint": "pnpm -r lint",
    "format": "pnpm -r format",
    "test": "pnpm -r --workspace-concurrency=4 test",
    "typecheck": "pnpm -r typecheck"
  },
  "pnpm": { "overrides": { "vite": "7.3.6" } }
}
```

### 5.3 `apps/web-next/package.json`

```json
{
  "name": "@aieval/web-next",
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
    "@aieval/ui": "workspace:*",
    "@ant-design/icons": "^6.3.2",
    "antd": "^6.5.3",
    "next": "16.2.7",
    "react": "19.2.7",
    "react-dom": "19.2.7",
    "swr": "^2.3.0",
    "zod": "^3.25.28"
  }
}
```

各包统一脚本口径：`lint`（`eslint .`）、`format`（`eslint . --fix`）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run --passWithNoTests`）、`build`（库包用 `tsc -p tsconfig.build.json`，应用用 `next build`）。

### 5.4 `eslint.shared.ts` 的分层边界工厂

边界由 eslint 硬约束，不靠口头约定。核心是「每个包一份禁止 import 名单」，展开成 `no-restricted-imports` 的 glob 组。**必须用 `patterns.group` 而不是 `paths.name`**——后者是精确匹配，`next/*` 这类条目会被 `next/headers` 这样的子路径绕过。

```ts
export type PackageName =
  | 'core' | 'agents' | 'evaluator' | 'api' | 'contracts' | 'ui' | 'client' | 'web-next';

/** 各包禁止 import 的模块名（精确名或带 * 的通配名） */
const FORBIDDEN: Record<PackageName, string[]> = {
  core: ['next', 'next/*', 'react', 'react-dom'],
  // agents 允许三家 agent SDK 与 HTTP 客户端，但同样不许知道框架与 React 的存在
  agents: ['next', 'next/*', 'react', 'react-dom'],
  evaluator: ['next', 'next/*', 'react', 'react-dom'],
  api: ['next', 'next/*', 'react', 'react-dom'],
  contracts: [],
  ui: ['@aieval/client', '@aieval/api', '@aieval/web-next', 'next', 'next/*'],
  client: ['@aieval/web-next'],
  'web-next': [],
};

/**
 * 把禁止名单展开为 no-restricted-imports 的 patterns 组：
 * 精确名匹配自身，非通配名另加「名/*」子路径组；已带 * 的保持通配。
 */
function toGroups(pkg: PackageName, names: string[]): Array<{ group: string; message: string }> {
  return names.flatMap((name) => {
    const message = `[分层边界] ${pkg} 禁止 import ${name}`;
    if (name.endsWith('*')) return [{ group: name, message }];
    return [{ group: name, message }, { group: `${name}/*`, message }];
  });
}

/** 按包名生成带边界约束的配置（与 baseConfig 合并使用） */
export function withBoundary(pkg: PackageName): Linter.Config[] {
  const names = FORBIDDEN[pkg];
  if (names.length === 0) return [...baseConfig];
  return [
    ...baseConfig,
    {
      files: ['**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: toGroups(pkg, names).map(({ group, message }) => ({ group: [group], message })) },
        ],
      },
    },
  ];
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

`baseConfig` 的 `ignores`：`**/node_modules/**`、`**/dist/**`、`**/.next/**`、`**/public/**`。

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
    "jsx": "preserve",
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true
  }
}
```

各包 `tsconfig.json` 继承它并设自己的 `include`。**各包自含路径别名，不设跨包 `@/` 别名**：包内引用走相对路径，跨包引用走 `@aieval/*` 包名。

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

---

## 6. 界面原语（内联实现契约）

本节是界面层的唯一口径。每个原语都是**新写的实现**，代码在此给全——实施时照抄本节即可。

### 6.1 文档壳与全局样式

**`app/layout.tsx`**：`<html lang="zh-CN">` + `<body>` + `<Providers>`，引入 `globals.css`；导出 `metadata = { title: 'AI 代码评测', description: '…' }`。

**`app/globals.css`**：主题底色变量 + 盒模型复位。**只放这一层壳所需的复位与变量**——字号与间距一律由 antd 主题 token 与紧凑密度供给，不在此手调。

```css
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; }

/* 暗色（默认）：等价 antd darkAlgorithm 的容器底色观感 */
:root, html[data-theme='dark'] {
  --app-bg: #141414;
  --app-fg: rgba(255, 255, 255, 0.85);
  --app-border: #303030;
  --app-muted: #888;
  --app-selected: #111a2c;
  color-scheme: dark;
}
/* 明亮：与 antd defaultAlgorithm 的容器底色一致 */
html[data-theme='light'] {
  --app-bg: #ffffff;
  --app-fg: rgba(0, 0, 0, 0.88);
  --app-border: #f0f0f0;
  --app-muted: #888;
  --app-selected: #e6f4ff;
  color-scheme: light;
}
html, body { background: var(--app-bg); color: var(--app-fg); }

/* antd App 包装层承接 body 高度：页面根（height:100%）与内容区（flex:1 + minHeight:0）的高度链不能断 */
.ant-app { height: 100%; display: flex; flex-direction: column; }
```

**`.ant-app` 这段高度链必须内联到位**：`PageShell` 用 `height: 100%`，而它的父级是 antd `<App>` 渲染出的 `.ant-app` 节点。该节点默认既不是 flex 容器也没有高度，链一断，页面根就退化成内容高度，所有内部滚动随之失效——表现为整页被内容撑长、该出现的滚动条不出现。

### 6.2 主题解析（`packages/client/ui/src/base/app-theme.tsx`）

**职责**：把偏好（`auto` / `light` / `dark`）解析成实际明暗 + antd 主题配置，并落文档根属性。

**契约**：`useResolvedTheme({ preference?, apply? }) → { mode, preference, themeConfig, holderRender }`。

**关键不变量：三个消费点必须同步，缺一处就会出现「组件亮了、底色还是暗的」的半亮主题**：

1. `<ConfigProvider theme={themeConfig}>` —— 组件层配色；
2. `html[data-theme]` —— CSS 底色变量与 `color-scheme`；
3. `ConfigProvider.config({ theme, holderRender })` —— 脱离 React 上下文的静态 `message` / `Modal`（portal 渲染）也要跟随同一主题。

**口径细节**：

- 偏好由**调用方从设置取后以 props 传入**——`ui` 包不调接口，故本模块不 import `client` 包。主题口径全仓只有这一处定义。
- `data-theme` 恒为**解析后**的 `light` / `dark`；`data-theme-preference` 保留偏好原值（`auto` 要能被区分出来，供排障与断言）。
- 偏好未就绪（设置还没拉到）**按暗色兜底**：默认观感，SSR 期不闪白。
- `auto` 在浏览器端订阅 `prefers-color-scheme` 变化**即时重解析**（无需刷新）。
- 无 `window`（SSR）/ 无 `matchMedia` 时 `readSystemDark()` 返回 `true`，与上述兜底一致，保证首帧不闪。

```tsx
/** 主题偏好：auto=跟随操作系统、light=明亮、dark=暗色 */
export type ThemePreference = 'auto' | 'light' | 'dark';

/** 系统深色偏好的媒体查询：auto 模式据此解析（浏览器端唯一判据） */
const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 读系统深色偏好；无 matchMedia（SSR / 老环境）按深色——与服务端默认主题一致 */
function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/** 偏好 → 实际明暗：auto 跟随系统，其余原样（纯函数，口径单独锁定并有单测） */
export function resolveThemeMode(preference: ThemePreference, systemDark: boolean): ThemePreference {
  if (preference !== 'auto') return preference;
  return systemDark ? 'dark' : 'light';
}

export function useResolvedTheme({ preference: rawPreference, apply = true }: UseResolvedThemeOptions = {}): ResolvedTheme {
  // 偏好未就绪（应用设置还没拉到）按暗色兜底：默认观感，SSR 期不闪白
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
  const mode: 'light' | 'dark' = resolveThemeMode(preference, systemDark) === 'light' ? 'light' : 'dark';
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
    // 三个消费点在此同步：文档根属性供 CSS 底色，ConfigProvider.config 供静态 portal（message/Modal）
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
export const COMPACT_FONT_TOKENS = { fontSizeSM: 11 } as const;

/** 生成紧凑密度主题：algorithm 依赖明暗，故按 mode 参数化 */
export function compactTheme(mode: 'light' | 'dark'): ThemeConfig {
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

**密度上下文**：`DensityProvider` 把**解析后的实际明暗**（`auto` 已解析为 `light` / `dark`）通过 React 上下文传给 `PageShell`，供其选择 `COMPACT_THEMES` 的哪一份；`useDensityMode()` 读它。

### 6.4 页面根容器 `PageShell`

全站「弹性布局 + 横向沾满」的唯一出口。四条不变量，每条都对应一个真实缺陷：

1. **纵向 Flex 根 + `width: 100%` + `minWidth: 0` + `height: 100%`**。
2. **刻意不设 `alignItems`**。纵向 Flex 的交叉轴是水平方向，`align-items: flex-start` 会让子元素**不横向拉伸**（表现为「没有横向沾满」）并把父级顶宽（多余横向滚动条）。这是最常见的误用。
3. **`padding` / `gap` 默认不落 `style`**，仅在显式传入时设置。原语默认值一旦非 0，页面迁移时会凭空新增间距并可能制造溢出。
4. `scroll: 'inner'` 时另需 `minHeight: 0`。纵向主轴默认 `min-height: auto`，会让内容撑开容器而不产生内部滚动。

```tsx
/** 紧凑主题按明暗预生成一次：避免每次 render 重建 ThemeConfig（algorithm 数组引用亦保持稳定） */
const COMPACT_THEMES = { light: compactTheme('light'), dark: compactTheme('dark') } as const;

export interface PageShellProps {
  children: ReactNode;
  /** 密度：compact（默认，全站通用）| default（仅设置页豁免） */
  density?: 'compact' | 'default';
  /** 内边距；不传则不落 style（保持既有行为） */
  padding?: number | string;
  /** 纵向间距；不传则不落 style */
  gap?: number;
  /** page：由外层文档滚动（默认）| inner：根自身滚动（长列表页）| none：不接管 */
  scroll?: 'page' | 'inner' | 'none';
}

export function PageShell({ children, density = 'compact', padding, gap, scroll = 'page' }: PageShellProps): ReactNode {
  const mode = useDensityMode();
  // 只编码结构性不变量；间距仅在显式传入时落 style（见上方第 3 条）
  const style: CSSProperties = { width: '100%', minWidth: 0, height: '100%' };
  if (padding !== undefined) style.padding = padding;
  if (gap !== undefined) style.gap = gap;
  if (scroll === 'inner') { style.overflow = 'auto'; style.minHeight = 0; }
  const content = <Flex vertical style={style}>{children}</Flex>;
  // 豁免页不包 ConfigProvider，直接落回外层主题（antd 默认或 app 的明暗主题）
  if (density === 'default') return content;
  return <ConfigProvider theme={COMPACT_THEMES[mode]}>{content}</ConfigProvider>;
}
```

### 6.5 两栏布局 `SplitPane`

侧栏 + 主区的两栏布局，**薄适配 antd `Splitter`**。分隔条的指针捕获、键盘可达、双击复位、最小/最大夹紧、拖动态光标与 `role="separator"` 语义全由 `Splitter` 提供，不自绘。

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
  /** 两栏间距（px）；映射到分隔条的命中带宽度 */
  gap?: number;
}
```

参数映射：

- `sidePosition: 'start' | 'end'` → `Splitter.Panel` 的先后顺序（`Splitter` 按 children 顺序排）。
- `sideWidth` → 侧栏 Panel 的 `defaultSize`（像素）；`collapseBelow` → 侧栏 Panel 的 `min`（窗口再窄也不会把侧栏压没，超出可用宽时由 `Splitter` 自身夹紧）。
- `gap` → `Splitter` 的 `styles.dragger`（分隔条命中带宽度即两栏视觉间距）。

**已记录的边界**：本适配**不支持纵向堆叠**——`Splitter` 没有等价开关，故改为「始终保持左右并排 + 夹紧最小宽」。对桌面为主的用法可接受，但 `collapseBelow` 现在只作最小宽使用，不再是「窄于它就上下堆叠」。

**两个已踩过的坑**：

1. **`styles.dragger` 会整个替换 antd 的 dragger 样式**，传 `width` 会把命中带改成 0（实测三条分隔条宽度全为 0、看不见也拖不到）。两栏间距交给 antd 自带的 `--ant-splitter-bar-size` / trigger 尺寸，不要覆盖。
2. 两栏宿主用原生 `div` 是**有意偏离**「避免裸写 div」——antd 没有「可滚动的通用盒子」原语，用 `<Flex>` 包单个孩子只是徒增节点（注释写明理由）。

```tsx
export function SplitPane({ side, children, sideWidth = 300, sidePosition = 'start', gap = 8 }: SplitPaneProps): ReactNode {
  const sidePanel = (
    <Splitter.Panel key="side" defaultSize={sideWidth} min={sideWidth}>
      {/* 侧栏宿主：固定宽度由 Panel 给，内部滚动由调用点的内容自带 */}
      <div data-testid="split-side-host" style={{ height: '100%', minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {side}
      </div>
    </Splitter.Panel>
  );
  const mainPanel = (
    <Splitter.Panel key="main">
      <div data-testid="split-main-host" style={{ height: '100%', minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
    </Splitter.Panel>
  );
  return (
    <Splitter style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      {sidePosition === 'start' ? [sidePanel, mainPanel] : [mainPanel, sidePanel]}
    </Splitter>
  );
}
```

该原语**不支持「用户拖过的宽度在刷新后还原」**（`Splitter` 非受控，`defaultSize` 只在挂载时读一次）。需要还原宽度时用 §6.6 的 `ResizableColumns`。

### 6.6 可调栏宽 `ResizableColumns`

给「多栏各栏可拖」的页面用，每条分隔条调整其**左邻**那一栏的宽度。本模块只负责三件事，真正干活的全在 antd 里（拖拽、夹紧、键盘、双击、aria 语义）：

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

```ts
/** Splitter 的分隔条命中带宽度（px）：用于把可用宽换算成「扣除分隔条后的预算」 */
const HANDLE_HIT_WIDTH = 6;

/**
 * 按容器实测宽度**比例还原**非弹性列的像素宽度：够宽时原样返回；不够宽时按比例收（不低于 min）。
 * 弹性列不参与：它的宽度由 Splitter 的 autoPtgSizes 补剩余，期望值无意义（见尺寸口径）。
 * 返回数组与入参同长同序（弹性列位置原样回填），便于调用方按下标取用。
 */
export function restoreWidthsToAvailable(
  widths: number[], panes: PaneGeometry[], available: number, handleCount: number,
): number[] {
  const budget = available - handleCount * HANDLE_HIT_WIDTH;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (available <= 0 || total <= 0) return widths;
  // 够宽：原样（不必把富余塞给谁——Splitter 会把剩余留给没给 size 的弹性列）
  if (total <= budget) return widths;
  // 过窄：按比例收，再逐栏夹到 [min, max]；夹紧后仍可能超预算，故取夹紧结果
  // （宁可略超，也不把任何一栏压到 min 以下——Splitter 自己还会再夹一次，这里是让比例先稳定下来）
  const scale = budget / total;
  return panes.map((pane, i) => Math.min(pane.max, Math.max(pane.min, widths[i] * scale)));
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
/** 单个偏好键在本机的读取：无 window（SSR）/ 存储不可用 / 无值 / 解析失败 → seed */
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

/**
 * 数值偏好的状态（列宽这类「夹在区间里的整数」）：与 readStoredPreference 同一套读写口径，
 * 额外把值**夹紧到 [min, max] 并取整**——存量值可能来自旧版本的范围、也可能被手改过，
 * 越界一律夹回，不让它把布局撑坏。**回退值（seed）同样参与夹紧**。
 */
export function useStoredWidth(key: string, seed: number, min: number, max: number): [number, (next: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    const stored = readStoredPreference(key, seed, (raw) => {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    });
    return Math.min(max, Math.max(min, stored));
  });
  const update = useCallback((next: number) => {
    const clamped = Math.min(max, Math.max(min, Math.round(next)));
    setWidth(clamped);
    try {
      window.localStorage.setItem(key, String(clamped));
    } catch {
      // 写不进去（配额 / 禁用存储）：本次会话内的宽度仍然生效
    }
  }, [key, min, max]);
  return [width, update];
}
```

写入失败（配额 / 禁用存储）不抛错——本次会话内的改动仍然生效，只是记不住。

### 6.8 列表 + 右边栏组合原语 `ListDetailLayout`

**这是脚手架的核心验收对象**：把 §6.5 / §6.6 / §6.7 组合成「列表 + 可拖拽宽度右边栏」这一形态的唯一出口，供示例页使用；功能阶段的用例页与评测页直接复用，不再各写一套。

```ts
export interface ListDetailLayoutProps {
  /** 左栏内容（usually Table / 列表） */
  list: ReactNode;
  /** 右栏内容；为 null 时不渲染右栏，回到单栏（列表占满） */
  detail: ReactNode | null;
  /** 右栏宽度偏好的 localStorage 键（每个页面各一个，避免互相覆盖） */
  widthStorageKey: string;
  /** 右栏默认宽度（px），默认 420 */
  defaultDetailWidth?: number;
  /** 右栏宽度下限（px），默认 320 */
  minDetailWidth?: number;
  /** 右栏宽度上限（px），默认 900 */
  maxDetailWidth?: number;
  /** 右栏是否显示（有表格行的选中或表单打开时为真） */
  detailOpen: boolean;
}
```

实现要点：

- 用 `ResizableColumns`，两栏：`panes[0]` = 列表（`flexible: true`，**不给 `size`**）、`panes[1]` = 右栏（给 `size`，值由 `restoreWidthsToAvailable` 从 `useStoredWidth` 的偏好与容器实测宽算出）。
- `detail === null` 时退化为 `SplitPane`（单栏列表占满）——**不要**渲染一个宽度为 0 的 Panel，`Splitter` 的 `min` 会把它夹回最小宽、留下一条空栏。
- 右栏宿主样式：`{ overflow: 'auto', padding: 8 }`。宿主默认 `overflow: hidden`，不给就会把长内容裁掉且没有滚动条。
- 拖动后把**右栏像素宽**写回 `useStoredWidth` 的同名键；容器尺寸变化时按 `restoreWidthsToAvailable` 重新计算传给 `Splitter` 的 `size`。

### 6.9 其余基础原语

均为纯 props 驱动的展示组件，放 `ui/src/base/`。**脚手架阶段只实现有消费者的那些**（消费者 = §7 示例页或设置页）；没有消费者的原语留到功能阶段实现，避免留下死代码。

| 组件 | 职责 | 脚手架阶段 |
|---|---|---|
| `EmptyState` | 空列表占位 + 引导动作（如「还没有数据 → 点这里创建」） | ✅ 示例页空态用 |
| `Toolbar` | 页内操作条（左标题 + 右动作区），全站操作条的唯一样式来源 | ✅ 示例页列表头用 |
| `EllipsisText` | 单行省略 + `Tooltip` 显全量（长路径、长 hash 用） | ✅ 示例页长字段用 |
| `CopyOnClick` | 点击复制到剪贴板 + 成功提示 | ⏳ 待功能阶段（脚手架无消费者） |
| `OperationStatus` | 「进行中操作」条 + 中止按钮（`Popconfirm` 确认） | ⏳ 待功能阶段（评测运行态才有消费者） |

### 6.10 顶栏

`Layout.Header` + 横向 `Menu`（用例 / 评测 / 设置）+ 右侧主题快捷切换（`Segmented` 三档：跟随系统 / 明亮 / 暗色）。抽为 `composite/app-top-nav.tsx`，纯 props 驱动（当前路径 + 三个跳转回调 + 主题偏好与变更回调）。两处主题入口（顶栏与设置页）读同一个 `useSettings()` 状态，不各存一份数据。

---

## 7. 列表 + 右边栏示例页（脚手架验收对象）

### 7.1 目标

用**内存假数据**把「左列表 + 右可拖拽详情栏」这个形态跑通，证明 §6 的原语真能组合出目标形态。它同时是功能阶段用例页与评测页的模板。

### 7.2 路由与形态

路由 `/demo`。页面顶部放一条 `Alert`（`type="info"`，`closable`）：**「这是脚手架示例页，使用内存假数据；功能实现后本页删除。」**——避免后来者误以为它是真功能。

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
| `hash` | 40 位十六进制 | 短哈希展示（前 7 位）+ 点击复制（`CopyOnClick`） |
| `status` | 五态枚举 | `Tag` 颜色映射 |
| `size` | 数字（字节） | 人类可读格式化（KB/MB） |
| `updatedAt` | ISO 时间 | 本地时间格式化 |
| `note` | 多段长文本 | 详情栏内部滚动（验证右栏 `overflow: auto` 真的生效） |

### 7.3 交互清单（验收项）

| # | 行为 | 期望 |
|---|---|---|
| 1 | 点列表行 | 右栏显示该行详情 |
| 2 | 拖右栏左侧分隔条 | 右栏宽度实时变化，列表栏吃剩余空间 |
| 3 | 刷新页面 | 右栏宽度**保持**拖动后的值（验证 `useStoredWidth` + `size` 口径） |
| 4 | 窗口从宽拖到窄 | 两栏**按比例**收，不出现某一栏被硬夹成最小宽的比例跳变 |
| 5 | 窗口拖回宽 | 右栏恢复偏好宽度 |
| 6 | 双击分隔条 | 宽度复位（`Splitter` 内置行为） |
| 7 | 未选中任何行 | 右栏不渲染，列表占满 |
| 8 | 顶栏切主题 | 组件与**页面底色**同时切换（验证三处同步），无「半亮」状态 |
| 9 | 设置页主题选「跟随系统」 | 改系统深浅色，界面**即时**跟随，无需刷新 |
| 10 | 列表为空 | 显示 `EmptyState` 引导，且页面不出现多余滚动条 |
| 11 | 详情栏放进超长文本 | 右栏**内部**滚动，页面本身不出现纵向滚动条 |

第 3、9、11 项是这页存在的理由——它们分别验证偏好持久化、主题三处同步、高度链不断。这三类问题在写业务时才发现，返工成本最高。

### 7.4 假数据的归属

假数据放 `apps/web-next/src/testing/demo-fixtures.ts`（`testing` 目录，与生产代码物理隔离），并在文件头注释写明「仅示例页使用，功能实现后随示例页一并删除」。

---

## 8. 最小服务端连通性

脚手架期只做两件事，证明「路由 → api → contracts → client」这条链通了：

1. `contracts`：`ERROR_CODES` / `httpStatusFor` / `ServiceError` / `InvalidRequestBodyError` + `Settings` 的 zod schema（`theme`、`workspaceRoot`、`defaultJudge`、`rowTimeoutMs`、`diffBudgetBytes`）。
2. `core/config-store`：原子写、BOM 容忍、缺失字段归一化、损坏时报含路径的中文原因、写盘后 `chmod 0600`。
3. `api`：`getSettings()` / `updateSettings(patch)`。
4. `web-next`：`GET/PUT /api/settings` + `GET /api/health`；`client` 侧 `useSettings()`。

`/settings` 页本阶段**只实现主题那一项**（三档 `Segmented`），其余三项（供应商 / 评分配置 / 工作区）留空位或占位卡片，功能阶段补齐。

统一错误出口 `handleApiError(error, init?)` 的三段映射：`ZodError` → 400 + `context: error.issues`；`InvalidRequestBodyError` → 400；其余按 `toServiceError` 折叠（未知 → `INTERNAL`）。响应体恒为 `{ error: { code, message, context? } }`，`context` 仅在存在时携带。

**必须区分的两种 400**：zod 校验失败与「请求体不是合法 JSON」都映射 400 `INVALID_QUERY`，但**只有后者能叫这个名字**。为此用专属标记类型包装 `req.json()` 的失败：

```ts
/**
 * 请求体解析失败的唯一标记类型：**只有它**映射为 400「请求体不是合法 JSON」。
 * 绝不允许把**任何** SyntaxError 都映射成它——否则「读配置文件失败」这类**服务端内部**
 * 解析异常会被伪装成客户端请求体问题（文案误导 + 排查方向被带偏）。这是已发生过的真实事故。
 */
export class InvalidRequestBodyError extends SyntaxError {
  constructor(cause?: unknown) {
    super('请求体不是合法 JSON');
    this.name = 'InvalidRequestBodyError';
    this.cause = cause;
  }
}

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch (error) {
    throw new InvalidRequestBodyError(error);
  }
}
```

`client` 的 HTTP 层：同源 `/api`，非 2xx 解析 `{ error: { code, message, context? } }` → 抛 `ServiceError`（`context` 透传）；**响应非 JSON 时兜底 `INTERNAL` + HTTP 状态码**，保证错误路径本身不会二次抛错。导出 `getJson` / `postJson` / `putJson` / `delJson` 四个函数。SWR 的 mutation 成功后一律 `mutate(key, response, { revalidate: false })` 回写缓存，避免随后的 GET 覆盖刚写入的新值。

---

## 9. 测试

| 对象 | 测试 |
|---|---|
| `resolveThemeMode` | 纯函数：`auto` + 系统深/浅 → 对应明暗；显式 `light`/`dark` 不随系统变化 |
| `compactTheme` | 用 `theme.getDesignToken({ algorithm: [darkAlgorithm, compactAlgorithm], token: COMPACT_FONT_TOKENS })` 断言实效 `fontSize / fontSizeSM / fontSizeLG` 为 `12 / 11 / 14`——防止有人「顺手补回 `fontSize`」把字号打回 10 |
| `restoreWidthsToAvailable` | 够宽原样返回；过窄按比例收且不破 `min`/`max`；`available <= 0` 原样返回；弹性列位置原样回填 |
| `readStoredPreference` / `useStoredWidth` | 无 `window` 回落 seed；存储抛错时不抛出、回落 seed；越界值夹紧；`seed` 越界也被夹紧 |
| `ListDetailLayout` | 组件测试（jsdom）：`detailOpen=false` 时右栏不渲染；`detailOpen=true` 时右栏渲染；**断言两栏工作目录式的关键属性——右栏宿主存在且 `overflow` 为 `auto`** |
| `app-theme` | 挂载后 `document.documentElement.dataset.theme` 等于解析后的模式；`data-theme-preference` 保留 `auto` 原值 |
| `config-store` | BOM 容忍（写入带 BOM 的文件仍能读出）；损坏配置抛含路径的中文 `ServiceError`；缺失字段归一化；写盘权限 0600（Windows 跳过） |
| `handleApiError` | `ZodError` → 400 + context；`InvalidRequestBodyError` → 400 + 该文案；**普通 `SyntaxError` → 500 且文案不得是「请求体不是合法 JSON」**（防回归到那次真实事故） |

组件测试才用 jsdom，纯函数测试标 `// @vitest-environment node`。

**冒烟**：真实起服务（:3083），按 §7.3 的 11 项交互清单逐项在浏览器中操作，并记录证据（页面状态 + 浏览器实际计算出的 `getBoundingClientRect()` 宽度，避免「看起来变了」）。第 3、9、11 项必须留证。

---

## 10. 实施顺序

1. **仓库骨架**：`pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json`、`.editorconfig`、`eslint.shared.ts`、`.gitignore`。
2. **8 个包的空壳**：每个包的 `package.json` / `tsconfig.json` / `eslint.config.ts` / `vitest.config.ts` / `src/index.ts`。跑 `pnpm install` + `pnpm typecheck` 确认边界与依赖图成立。
3. **`contracts`**：错误码、`httpStatusFor`、`ServiceError`、`InvalidRequestBodyError`、`Settings` schema。
4. **`core`**：`config-store`（原子写 + BOM + 0600 + 归一化）、`paths`（`~` 展开 + 可写性校验）。含单测。
5. **`api` + 路由**：`getSettings` / `updateSettings`；`/api/settings`、`/api/health`、`handleApiError`、`readJsonBody`。
6. **`client`**：`http` 四函数、`useSettings`。
7. **`ui` 主题与骨架**：`app-theme`、`density` + `DensityProvider`、`PageShell`。含单测。
8. **`ui` 布局原语**：`stored-preference`、`SplitPane`、`ResizableColumns` + `restoreWidthsToAvailable`、`ListDetailLayout`。含单测。
9. **应用壳**：`layout.tsx`、`providers.tsx`、`globals.css`、顶栏、`/settings`（仅主题项）。
10. **示例页**：`demo-fixtures.ts` + `/demo` + `DemoListPage`。
11. **验收**：`pnpm typecheck` / `pnpm lint` / `pnpm test` 全绿；按 §9 冒烟清单逐项留证。

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
