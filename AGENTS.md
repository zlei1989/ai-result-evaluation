# AGENTS.md

用中文交流。

## 约束

- 写 Next.js 代码前先读 `apps/web-next/node_modules/next/dist/docs/` 的相关指南（当前版本有训练数据未覆盖的破坏性变更）。
- 写 UI 前先用 context7 查组件用法；界面只用 vendored 原语（`packages/client/ui/src/components/ui/`）与语义 token 组装，不手写字号与行内边距。口径见[《界面原语与主题》](docs/architecture/ui-primitives-and-theme.md)。
- 提交逐个显式 `git add <路径>`，**禁止 `git add -A`**；`git status` 里不属于你的文件保持原样。
- 改完代码按序执行 `pnpm typecheck` → `pnpm lint`，修完所有错误再进代码审查；格式修复随本次改动一并提交。
- 新增回归守卫必须做**变异验证**：把要拦的缺陷人为制造回去、确认守卫失败、再还原并核对文件哈希。没见过失败的守卫不算守卫。方法见[《变异验证》](docs/guard/mutation-verification.md)。
- 遇到厂商智能体的运行期问题（报错、卡死、行为与预期不符、环境差异导致的假绿）先把问题修掉，再按四格追加 FAQ；格式与索引见[《故障索引》](docs/faq/index.md)。
- 调智能体只有 `agentProvider.run` 一个入口（`getProvider(kind).run(input)`）：包外不许自己 spawn 厂商 CLI、不许深路径 import `providers/*`、也不许再包一层「跑一次」的门面；`run` 不够用就扩展它本身，扩展前先澄清。口径见[《Provider 抽象与 run 入口》](docs/protocols/provider-run.md)。
- 落盘一律原子写（临时文件创建即 `0600` → `rename` 覆盖），读盘容忍 BOM；别先删目标再 `rename`。口径见[《数据与存储》](docs/features/storage.md)。
- 递归删除先断言目标在允许根之下、打印目标、再执行；临时值用专属名，绝不给 `$home` / `$profile` / `$env:*` 赋值。完整规则见[《PowerShell》](docs/guard/powershell.md)。
- 冒烟记录落 `.scratch/<feature-slug>/smoke.md`，不进知识库；真机操作与四要素见[《冒烟测试方法论》](docs/guard/smoke-testing.md)。
- 源码一律 ESM：`require()` 被 `baseConfig` 与 `withBoundary` 两处规则禁止（`tsc` 与 eslint 的边界规则都拦不住它，Vitest 的 SSR runner 还会注入模块级 `require`）。

## 知识库

知识按五域组织：协议规范（`docs/protocols/`）、功能说明（`docs/features/`）、架构设计（`docs/architecture/`）、FAQ（`docs/faq/`）、规约守卫（`docs/guard/`）。**接任务先按域找文章，别全仓扫描**。全站地图见 `docs/index.md`；每域收什么、终态写作与关账口径见[《知识库口径》](docs/guard/knowledge-base.md)。

工具链 / 依赖 / UI 的已知坑分别归档在[《工具链与命令聚合》](docs/architecture/toolchain.md)、[《界面原语与主题》](docs/architecture/ui-primitives-and-theme.md)、[《仓库分层与依赖方向》](docs/architecture/layering.md)。

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

表是**真源**，由 `apps/web-next/src/package-dependency-boundaries.test.ts` 逐条比对每个包的 `package.json`：新增或删除跨包依赖必须同时改表和清单，只改一处测试就红。目录与分层、类型转出与测试期别名的口径见[《仓库分层与依赖方向》](docs/architecture/layering.md)。

## 命令与测试

- 开发：`pnpm dev`（web-next :3083；端口被占用先 kill 占用进程）；构建：`pnpm build`。
- 门禁：`pnpm typecheck` → `pnpm lint` → `pnpm test`；内循环用 `pnpm test:changed`，单包 / 单文件跑法与命令全表见[《工具链与命令聚合》](docs/architecture/toolchain.md)。
- `.tsx` 测试只能在库包写：`apps/web-next` 必须留 `jsx: preserve`，否则 Vite 的 import-analysis 报 `make sure to not set jsx to preserve`。
- 双环境、`vi.mock` 逐文件重复、jsdom 缺口、测试预算、负载下假红、根聚合的收集范围见[《测试策略与提速》](docs/guard/test-strategy.md)。

## 注释与日志

- 注释：TS/TSX 用 JSDoc；中文，简洁、专业的口语，先说「做什么」再说「怎么做」；文件头写职责，嵌套 > 2 层注释业务含义；**只写终态**，不写改动史与验证过程。
- 日志：统一用 `@aieval/core` 的 `createLogger(scope)`，禁止模块自己 `console`；上下文作为 `console` 的第二个参数透传，不 `JSON.stringify`。级别与必打点位见[《注释与日志》](docs/guard/code-conventions.md)。
