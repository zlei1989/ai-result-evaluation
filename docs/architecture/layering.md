# 仓库分层与依赖方向

## 定位

单仓 pnpm workspace：1 个下游应用 + 服务端 / 客户端两层共 8 个包，依赖方向自下游指向上游、无环。「边界即架构」——方向不是口头约定，而是两类守卫双向钉死的机械判据：ESLint 边界规则拦写入侧的 import，`package.json` 清单与方向表的一致性测试拦声明错位，改错任何一侧门禁就红。

## 形态与交互

### 目录与职责

```text
apps/web-next/     Next.js 薄组装；路由只做「zod 校验、调 api、错误映射」
packages/server/
  core/            git CLI 原语、配置落盘、路径校验；只用 Node 内置 + contracts
  agents/          智能体抽象层 + 三家适配器（Claude Code / Codex / DSH）；唯一允许引厂商
                   SDK 的包，对外只暴露 provider 注册表，差异吸收在 providers/<kind>/
  evaluator/       编排状态机 + 评分器 + 事件落盘；不碰框架、不碰具体 SDK
  api/             功能服务层，一个功能一个文件；禁止 import 任何框架
  contracts/       zod schema + 领域类型 + 错误码
packages/client/
  ui/              纯展示组件（base + composite），纯数据驱动、不调接口
  client/          SWR hooks + HTTP 原语，类型全部来自 contracts
```

路由的职责边界只有三件事：zod 校验请求 → 调 api → 错误映射；业务逻辑一律不下沉路由文件。

### 依赖方向

逐边的权威清单是仓库根 `AGENTS.md`「依赖方向」节的表——守卫按字面形状逐字解析它，本页不另立真源（复制必漂移，漂移时守卫会替错的那份背书）。按层组织的方向：

```text
下游应用  web-next → api / core / ui / client / contracts
服务端    api → evaluator / agents / core / contracts
          evaluator → agents / core / contracts
          agents → core / contracts
          core → contracts
客户端    ui → contracts
          client → contracts
契约底座  contracts → 无（只依赖 zod 这类第三方；指回任何 @aieval/* 都是环）
```

图与表如有出入，以 `AGENTS.md` 的表为准并改图。

## 数据与契约

| 契约 | 口径 |
|---|---|
| 依赖方向表 | 唯一真源在仓库根 `AGENTS.md`「依赖方向」节的代码块，每行「包 → 允许的内部依赖」，右侧是裸包名。**新增或删除跨包依赖必须同时改表和清单**，只改一处测试就红——`pnpm lint` / `pnpm typecheck` 查不出这种错位 |
| 类型转出不算依赖边 | `@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型，编译期即被抹掉，故表里不列这行、ui 放 `devDependencies`。只允许 `export type`；写成值导出就真有运行时依赖，得回来改表 |
| 测试期别名不算依赖边 | `apps/web-next/vitest.config.ts` 的 `resolve.alias` 把 evaluator 指向源码，只为让路由测试的 `vi.mock` 生效（裸说明符的 mock 与真实解析的 module id 不相等会静默失效、真 spawn 厂商 CLI），只活在测试期。别改成 devDependency（会动 `pnpm-lock.yaml`，还会装进一条运行时可解析的依赖边） |

## 机制与演化

### 8 包为何脚手架期一次建全

边界规则只有在「包真实存在」时才被 ESLint 校验，后补包会一次性冲击边界；空包（`export {}`）成本近零，所以 8 个包在脚手架期一次建全、之后只往里填东西。agents 单列的理由：三家厂商 SDK 是重量级外部依赖，单列才不污染 core / evaluator；core 只依赖 contracts + Node 内置，可独立测试。全仓只做一个 Next.js 应用，服务端逻辑收敛进 Route Handlers（「双下游应用」是被否决的备选）。

### api 对 agents 是后来加的边

脚手架期 api 只有 evaluator / core / contracts 三条边；后来 `api/src/runs.ts` 要读 provider 注册表（`getProvider(agentKind)`、`acceptsProtocol` / `protocolMismatchMessage`、按注册表过滤候选池），判据不硬编码在 api——于是补了 `api → agents` 这条边。内部边加得再顺，也必须显式落进方向表。

### ESLint 边界规则

`eslint.shared.ts` 的 `withBoundary(pkg)` 把每个包的禁止名单展开成 `no-restricted-imports` 的 `patterns.group`——不能用 `paths.name`，精确匹配会被 `next/headers` 这类子路径绕过。现值：

| 包 | 禁止 import |
|---|---|
| core / agents / evaluator / api / contracts | `next`、`next/*`、`react`、`react-dom`（agents 允许三家厂商 SDK 与 HTTP 客户端，但同样不许知道框架与 React 的存在） |
| ui | 框架禁令同上，另禁 `@aieval/client`、`@aieval/api`、`@aieval/web-next` |
| client | `@aieval/web-next` |
| web-next | 空名单（组装层，什么都许 import） |

注意：FORBIDDEN 名单管不到 `@aieval/*` 依赖边（比如 api 的名单里只有框架）——内部边必须显式落方向表，这条边不会报错，不落文档就是隐性依赖。

### 四条不能省的加固

每条对应一条实测过的绕过路径：

1. **动态 `import()` / `require()` 是 `no-restricted-imports` 的盲区**：另配 `no-restricted-syntax`，且选择器按说明符过滤——裸 `ImportExpression` 会把合法的代码分割一并禁掉。
2. **跨包相对引用是盲区**（库包直出 TS 源码，`../../client/ui/src/index` 这种相对路径真能跑通）：用 `import-x/no-relative-packages`，且必须补 `settings['import-x/resolver'].node.extensions` 的 `.ts` / `.tsx`——否则规则内部的 `resolve()` 失败时**静默 return**（实测只开规则不加 settings 时，跨包相对引用照样以退出码 0 通过）。豁免名单按文件名限定 `**/{eslint,vitest,next}.config.{ts,tsx}`：各包配置文件要相对引用仓库根的共享配置，这是合法的；写成 `**/*.config.{ts,tsx}` 是任意深度匹配，产品模块会被顺带豁免。
3. **禁 `require()` 的常量在 baseConfig 与 withBoundary 各放一份**：flat config 对同名规则是**整体替换**不是选项合并，withBoundary 排在后面，会把 baseConfig 那条整个盖掉——两处各放一份、共用同一常量对象。
4. **`escapeRegExp` 必须转义 `/`**：漏了 ESLint 直接以退出码 2 崩溃（`Invalid regular expression: /^(@aieval/: Unterminated group`）。

### 根配置前缀化与双向变异验证

根上 `eslint .` 一个进程覆盖全仓：`workspaceConfig` 经 `scopeToDir()` 把每个包的 glob 前缀到自己的目录（`PACKAGE_DIRS`），包间目录不重叠、永不跨包误伤；baseConfig 不前缀（它自带的是仓库级 ignores）。前缀化的验收是**双向变异验证**：core 里写 `import 'react'` 要报错、web-next 里同样的 import 不报错——前缀化漏了会把 core 的名单误伤到全部包（web-next 被误伤成「禁止 import react」）。

### 清单守卫：表与清单双向比对

`apps/web-next/src/package-dependency-boundaries.test.ts` 只读 package.json、不加载任何模块，判据三段：

1. **内部依赖必须在表里**：每个包 `dependencies` 里的 `@aieval/*`，必须是表里该行列出的包（表是真源，测试不另抄一份清单）；
2. **反向也要**：表里有、清单里没有的边同样是错位——少声明会在运行期才炸；
3. **类型期的边只准放 devDependencies**：client 对 ui 就是这样持有的，另有断言钉住（写回 dependencies 就红）。

解析方式刻意用正则读 `AGENTS.md` 的代码块而不是硬编码第二份表——硬编码等于第二个真相源，两处漂移时守卫会替错的那份背书。箭头用 `String.fromCharCode(0x2192)` 现造而不写字面量：多字节字符被工具链改写时匹配会**静默失败**，而守卫的失效方式必须是响亮报错；解析不出 8 行就抛，不静默通过。

真机实例（2026-10-03）：`@aieval/client` 曾把 `@aieval/ui` 写进 `dependencies` 而表里 client 只有 contracts——错位**没有任何可观测后果**（client 对 ui 只有一条 `export type`，编译期即被抹掉），不会被任何运行时用例逮住，只能靠读清单本身。

### web-next 的运行期特例：厂商 SDK 的声明口径

「厂商 SDK 只在 agents 包内」是 **import 口径不是声明口径**：三家 SDK（`@anthropic-ai/claude-agent-sdk` / `@openai/codex` / `@deepseek-ai/dsh-sdk-client`）必须**同时**声明在 `apps/web-next/package.json` 的 `dependencies`（版本区间与 agents 逐字相同），还要进 `next.config.ts` 的 `serverExternalPackages`。原因：外置包是运行期按裸说明符在产物目录（`.next/server/chunks/`）逐级向上找 `node_modules` 定位的，而 pnpm 的隔离式布局只把它们链在 agents 包下——少了应用侧这条声明，运行期第一次定位就 `MODULE_NOT_FOUND`。这不是打包优化，是「能不能跑起来」的问题。判据由 `apps/web-next/src/runtime-deps.test.ts`（契约 R35）钉住：声明与区间两边读 JSON 现比，另做「只解析路径、不加载模块」的真解析。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| 表与清单是两份人写的真源，天然会错位 | 风险 | boundaries 测试双向比对 + 解析失败响亮报错；新增 / 删除跨包依赖同时改表和清单，只改一处测试就红 |
| 类型转出边（client → ui） | 已收口 | 只允许 `export type`、落 `devDependencies`；第三段断言钉住（写回 `dependencies` 就红） |
| 测试期别名边（web-next → evaluator 源码） | 已收口 | 只活在 `apps/web-next/vitest.config.ts` 的 `resolve.alias`，不进依赖清单；`apps/web-next/instrumentation.ts` 调 `recoverInterruptedRuns` 必须经 `@aieval/api` 转出（web-next 不直接 import evaluator） |
| FORBIDDEN 名单管不到 `@aieval/*` 依赖边 | 已登记 | 加内部边必须显式落方向表；这条边不会报错，不落文档就是隐性依赖 |
| ESLint 边界报错文案曾指向冻结架构档案 | 已修 | 报错文案现指本页「依赖方向」（断链修复时改指，档案退役后无死链） |

## 相关链接

- [工具链与命令聚合](/architecture/toolchain) —— 前缀化（`scopeToDir` / `PACKAGE_DIRS`）的聚合侧：两页共用同一条真源机制
- [契约体系](/architecture/contracts) —— contracts「指回任何 `@aieval/*` 都是环」的底层约束
- [Provider 抽象与 run 入口](/protocols/provider-run) —— agents 的 provider 注册表是 `api → agents` 这条边的存在理由
- 仓库根 `AGENTS.md` 的「目录结构」「依赖方向」节 —— 分包职责与逐边清单的真源（守卫逐字解析）
- `README.md`「代码结构」 —— 面向新人的分层一句话口径
