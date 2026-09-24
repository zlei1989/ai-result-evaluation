# AGENT.md

用中文交流。

## 约束

- **写 Next.js 代码前先读 `apps/web-next/node_modules/next/dist/docs/` 中的相关指南** — 当前版本可能有训练数据未覆盖的破坏性变更
- **写 UI 前先用 context7 查组件用法** — 常规界面与布局用 `antd`；适配 `light` 与 `dark` 主题，弹性布局自适应屏幕尺寸；样式一律走 `antd`（主题 token / 紧凑密度 / 语义 `styles`）——**不手写字号**（交紧凑密度）、**不手调行内边距**（交组件默认），避免裸写 `div` 等原始标签
- **提交时逐个显式 `git add <路径>`，禁止 `git add -A`** — 本仓可能同时有别的会话在工作（实测发生过：一次 `docs/` 下的规格扩写与脚手架任务并行），`-A` 会把别人未提交的改动卷进你的提交。`git status` 里出现不属于你的文件时，**保持原样、不要动它**
- **代码变更后、进入审查阶段前，必须先执行检查** — 顺序：`pnpm typecheck` → `pnpm lint` → 修复所有错误 → 再进入代码审查；格式修复产生的变更需随本次改动一并提交
- **新增的每条回归守卫都必须做变异验证** — 把它要拦的缺陷人为制造回去，确认该守卫**失败**，再还原并核对文件哈希未变。**没有见过失败的守卫不算守卫**：本项目的计划编写期给出的断言已被实测证明无区分力四次（`expect(existsSync(tmp)).toBe(false)` 对直接覆盖的实现同样通过；`readdirSync(dir)` 为空对「压根不写探针」的实现同样通过；`toContain('.runs')` 与 `{ ...DEFAULTS }` 的断言对变异体同样通过）
- web 启动时若端口被占用，先 kill 占用进程再启动

## 目录

monorepo：1 个下游应用 + 服务端/客户端两层，职责严格分离（架构见 `docs/superpowers/specs/2026-09-22-scaffold-design.md`）：

```text
ai-result-evaluation/
├── apps/
│   └── web-next/       # 下游应用：Next.js 薄组装（页面壳 + 路由转调 api）
├── packages/
│   ├── server/
│   │   ├── core/       # 工作区引擎：git CLI 原语、配置落盘、路径校验（只用 Node 内置 + contracts）
│   │   ├── agents/     # 智能体抽象层 + 三家适配器（Claude Code / Codex / DSH）
│   │   ├── evaluator/  # 编排状态机 + 评分器 + 事件落盘
│   │   ├── api/        # 功能服务层：一个功能一个文件，禁框架依赖
│   │   └── contracts/  # 跨端契约：zod schema + 领域类型 + 错误码
│   └── client/
│       ├── ui/         # 纯展示组件（base + composite），不调接口
│       └── client/     # 数据层：SWR hooks + HTTP 原语
├── docs/
│   └── superpowers/    # specs（设计与实现计划）/ plans
└── eslint.shared.ts    # 共享规则 + 分层边界规则（withBoundary）
```

- **core**：与 git 进程和磁盘打交道的引擎层，无任何业务；**只用 Node 内置模块与 `contracts`，不引入任何外部运行时依赖**
- **agents**：唯一允许引入厂商 SDK 的包；对外只暴露 provider 注册表，三家差异全部吸收在 `providers/<kind>/` 里
- **evaluator**：编排与评分，不碰框架、不碰具体 SDK
- **api**：后端逻辑，每个小功能 1 个文件；只依赖 evaluator + core + contracts，**禁止 import 任何框架**
- **contracts**：服务端与客户端共享的类型/校验/错误契约
- **ui**：只做基础组件和组合组件，不涉及任何接口调用，纯数据驱动
- **client**：数据获取 hooks（SWR），类型全部来自 contracts
- **web-next**：框架层，路由只做「zod 校验 → 调 api → 错误映射」三件事

依赖方向（由 `eslint.shared.ts` 的 `withBoundary()` 硬约束，**含动态 `import()` 与 `require()`，且禁止跨包相对引用**）：

```text
web-next → api / core / ui / client / contracts
api      → evaluator / core / contracts
evaluator→ agents / core / contracts
agents   → core / contracts
ui       → contracts
client   → contracts
core     → 无（Node 内置之外）
```

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 起 web-next 开发服务器（http://localhost:3083） |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 全量检查（`pnpm -r lint`） |
| `pnpm format` | ESLint `--fix` 自动修复（`pnpm -r format`） |
| `pnpm typecheck` | TypeScript 全链类型检查 |
| `pnpm test` | vitest 全量测试 |

单包：`pnpm --filter @aieval/<包名> <脚本>`，例如 `pnpm --filter @aieval/ui test`。

## 测试

| 规则 | 说明 |
|------|------|
| 环境 | `vitest.node.ts`（node，库包与 web-next）/ `vitest.jsdom.ts`（jsdom，`ui` 与 `client`）。纯函数测试标 `// @vitest-environment node` |
| **`.tsx` 测试只在库包可写** | 根 `tsconfig.base.json` 的 `jsx` 是 `react-jsx`；`apps/web-next` 保留 `preserve`（Next 需要），**故该应用内不能写 `.tsx` 测试** |
| **`jsx: preserve` 会让 `.tsx` 测试无法运行** | Vite 的 import-analysis 直接读 tsconfig 的 `jsx`，报 `make sure to not set jsx to preserve`；**改 vitest 的 `esbuild.jsx` 或 `esbuild.tsconfigRaw` 都无效**（报错来自 Vite 而非 esbuild） |
| 别名 | `apps/web-next` 的 `@/*` 指该应用根目录。**vitest 不读 tsconfig 的 `paths`**，故 `apps/web-next/vitest.config.ts` 里显式给了 `resolve.alias`（用 `import.meta.dirname` 推导，不依赖 `process.cwd()`） |
| 组件测试的 `matchMedia` 与 `ResizeObserver` | jsdom **两者都没有**；前者由用例自己注入（主题模块的「无 matchMedia 按暗色」兜底正是要覆盖的路径），后者的桩在 `packages/client/ui/src/testing/resize-observer.ts`，**刻意不放进共享 setup**（否则组件的「无 ResizeObserver」兜底分支再也测不到） |
| 真实拖拽 | jsdom 里不可达（尺寸按容器 0 换算后非有限，分隔条变成不可拖）；`Splitter` 的 `onResize` 回写只能在真实调用方处钉 |

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
- **读盘必须容忍 UTF-8 BOM**：外部工具（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json`）默认带 BOM，而 `JSON.parse` 遇到它直接抛
- 配置文件损坏时抛**含路径的中文原因**，绝不能让 `SyntaxError` 冒充「请求体不是合法 JSON」

## 边界与工具链的已知坑

| 坑 | 正确做法 |
|----|----------|
| `pnpm-workspace.yaml` 的 `allowBuilds` | pnpm 11 必需（`sharp` / `unrs-resolver`）。**写进 `onlyBuiltDependencies` 不再生效**，实测仍报 `ERR_PNPM_IGNORED_BUILDS` |
| flat config 的规则是**整体替换**不是选项合并 | `withBoundary` 生成的对象排在 `baseConfig` 之后且匹配同一批文件，会把 `baseConfig` 的 `no-restricted-syntax` 整条盖掉——两处各放一份（共用同一个常量对象） |
| `no-restricted-imports` 覆盖不到动态 `import()` 与 `require()` | 边界另配 `no-restricted-syntax`，且选择器**必须按说明符过滤**（裸 `ImportExpression` 会把包自己的 `import('./x')` 一起禁掉，挡住合法的代码分割） |
| `import-x/no-relative-packages` 单开不生效 | import-x 的 node 解析器默认不含 `.ts`，规则在 `resolve()` 失败时静默 return；必须在 `baseConfig` 补 `settings['import-x/resolver'].node.extensions` |
| `escapeRegExp` 漏转义 `/` | 该正则会拼进 esquery 的 `/…/` 字面量，`@aieval/client` 的 `/` 会提前闭合它，**ESLint 直接以退出码 2 崩溃** |
| 紧凑密度**绝不显式写 `fontSize`** | `compactAlgorithm` 会覆盖它并反向推导，实效字号掉到 10px（比 antd 默认的 14 还小）；只给 `fontSizeSM: 11`，产出 12 / 11 / 14 |
| 主题必须**三处同步** | `ConfigProvider theme` + `html[data-theme]` + `ConfigProvider.config({ holderRender })`；缺一处就是「组件亮了、底色还是暗的」半亮主题 |
| antd `Splitter` 的 `size` 是受控响应式入口 | 用它而非 `defaultSize`（后者只在挂载时读一次）；**受控模式下拖拽必须把 `onResize` 回写进 `size`**，否则松手弹回。弹性列**不给 `size`**（条件展开，不是 `size={0}`） |
| antd `Flex` 的 `display` / `flex-direction` 走 CSS 类 | 内联 `style` 读不到；结构性不变量要自己写进内联 style，否则 antd 换实现或改类名就静默失效 |
| `next dev` 生成的 `next-env.d.ts` | 已 gitignore，并在 `apps/web-next/eslint.config.ts` 里 ignore（它用双引号与三斜线语法，会让 `@stylistic/quotes` 报错） |

## 冒烟测试

- **流程**：启动真实服务（web-next :3083），用 mcp 在浏览器中按真实用户路径逐项操作（表单输入、按钮、弹窗、导航、拖拽），并用 CLI 复核落盘事实（配置文件内容、git 分支与 diff），页面展示与磁盘事实互证。
- **几何断言别靠眼睛**：读 `getBoundingClientRect()`（`read_picked_element` 或 `browser_evaluate`），不要凭截图判断「宽度变了」。
- **记录**：每次冒烟后在对应计划/关账记录的「冒烟」小节写入：① 范围清单（逐项 ✅/❌/跳过+理由）；② 操作路径（点击/输入序列）；③ 证据（浏览器状态 + CLI 输出互证）；④ 未覆盖项与后续计划（如有）。

## 技术栈

- **路由** — web-next：App Router（Server Components + API Routes）
- **语言/构建** — TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）；库包直出 TS 源码（`main` 指 `./src/index.ts`），由 Next 的 `transpilePackages` 编译
- **测试** — vitest 4（node / jsdom 双配置）
- **UI** — antd 6 + React 19；`splitter` 与 `flex` 的语义见上文「已知坑」
- **数据** — SWR 2；契约 zod 3
- **源码一律 ESM** — `require()` 被 `baseConfig` 与 `withBoundary` 两处规则禁止（`tsc` 与 eslint 的边界规则都拦不住它，Vitest 的 SSR runner 还会注入模块级 `require`，故必须显式禁）
