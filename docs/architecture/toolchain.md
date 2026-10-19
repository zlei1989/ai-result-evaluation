# 工具链与命令聚合

## 定位

`pnpm lint` / `pnpm typecheck` / `pnpm test` 三条门禁命令各起**一个**进程覆盖 8 个包，靠「复用包级真源」聚合：根 eslint 配置前缀化引用包级边界规则、根 vitest 用 `projects` 引用各包配置、根 tsconfig 取各包 `include` 的并集。三条都刻意不走 `pnpm -r`——递归会给 8 个包各起一次进程，全部时间花在启动税上。

## 形态与交互

### 命令入口

| 命令 | 说明 |
|------|------|
| `pnpm dev` | web-next 开发服务器（http://localhost:3083）；端口被占用先 kill 占用进程 |
| `pnpm build` | 生产构建 |
| `pnpm lint` | ESLint 全量检查，一个进程覆盖 8 个包 |
| `pnpm format` | ESLint `--fix`（与 `lint` 同一条根配置） |
| `pnpm typecheck` | TypeScript 全链类型检查，一个 tsc 进程 |
| `pnpm test` | vitest 全量测试，一个进程收齐 8 个包 |
| `pnpm test:changed` | 只跑与改动相关的文件——**内循环用这个**，全量留给门禁 |

使用原则：内循环用 `pnpm test:changed`（只跑与改动相关的文件），全量留给门禁；单包 `pnpm --filter @aieval/<包名> <脚本>` 与根命令的**结果必须一致**（包级配置是真源，根只聚合）。

### 技术栈

| 层 | 事实 |
|---|---|
| 路由 | web-next：App Router（Server Components + API Routes） |
| 语言 / 构建 | TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）；库包直出 TS 源码（`main` 指 `./src/index.ts`），由 Next 的 `transpilePackages` 编译 |
| 测试 | vitest 4（node / jsdom 双配置） |
| UI | Tailwind v4 + vendored shadcn 原语 + Base UI / react-resizable-panels / TanStack Table + React 19 |
| 数据 | SWR 2 + zod 3 契约 |

**源码一律 ESM**：`require()` 被 `baseConfig` 与 `withBoundary` 两处规则禁止——`tsc` 与 eslint 的边界规则都拦不住它，Vitest 的 SSR runner 还会注入模块级 `require`，故必须显式禁。

### 三件套

| 门禁 | 根配置 | 聚合方式 |
|---|---|---|
| `pnpm lint` | 根 `eslint.config.ts` 引 `eslint.shared.ts` 的 `workspaceConfig` | `boundaryConfigs()` 经 `scopeToDir()` 按目录前缀化，一个 ESLint 进程覆盖 8 包 |
| `pnpm test` | 根 `vitest.config.ts` | `projects` 引用各包 `vitest.config.ts`（glob 收集），一个 vitest 进程收齐 8 包 |
| `pnpm typecheck` | 根 `tsconfig.typecheck.json` | `include` 是各包 include 的并集，一个 tsc 进程 |

## 数据与契约

根配置与包级配置的真源关系：**各包自己的配置是唯一真源**（environment、include、`@/*` 别名都在包内），根配置只做引用与前缀化，不内联配置对象、不把包级规则抄进根——同一个包的范围写两遍必然漂移。别退回 `pnpm -r`，也别反向把包级规则上移进根配置。

## 机制与演化

### 为什么一个进程：启动税占大头

**启动税占大头**：逐包跑要给 8 个包各起一次 Node + 加载一遍插件（eslint）、各建一次 tsconfig 图（typecheck）、各起一次运行器（vitest），源文件与测试本身只占零头——包自身测试的耗时只有几百毫秒量级。8 包现有 476 个 `.ts` / `.tsx`（`git ls-files` 口径 475）、229 个测试文件，逐包跑就要多付 8 份启动税。

### vitest 的 projects 收集

根配置的 `projects` 是 glob：`packages/server/*/vitest.config.ts`、`packages/client/*/vitest.config.ts`、`apps/*/vitest.config.ts`，外加**显式列出**的 `docs/vitest.config.ts`（知识库内容守卫工程；docs 不是 workspace 包，glob 会把无关目录扫进来）。glob 不写死路径：新包自带 `vitest.config.ts` 即自动被收进根测试，不出现「新包没进根测试」的静默漏测。**改动收集方式后必须核对用例总数**。

### tsconfig 并集

根 `tsconfig.typecheck.json` 的 `include` = 7 个库包的 `src` + web-next 的 `next-env.d.ts` / `app` / `src` / `.next/types`。**不含**仓库根与各包 `*.config.ts`——只做聚合、不顺带扩面（扩面会让门槛变化混进性能改动里，出问题难归因）。`incremental` + 单一 `tsBuildInfoFile`：全量首次跑建一次图，第二次起只重查改动文件；8 个包各写一份会把「同一个文件被哪个项目检查过」拆散，增量失效，故只放根上一份。

### vitest 双配置与线程池

- `vitest.node.ts`（库包与 web-next）/ `vitest.jsdom.ts`（ui 与 client，jsdom + setup）两份共享配置，各包 `vitest.config.ts` 直接复用；纯函数测试标 `// @vitest-environment node`。
- `pool: 'threads'`：vitest 4 默认池是 `forks`（每次起子进程），而本机（i7-1260P，4 性能核 + 8 能效核）的进程创建极贵——企业 DLP / EDR 在每个新进程上挂钩，`git --version` 350–566ms、`node --version` 530ms 量级；threads 用 worker_threads 免掉这层。本仓测试不用 `process.chdir()` / `process.exit()` / 原生模块（正是 vitest 把默认池从 threads 改回 forks 的三类原因），故可安全换。

### 超时预算

共享基线 `testTimeout: 40_000` / `hookTimeout: 60_000`：默认的 5s / 10s 在满载下会假红——`Test timed out in 5000ms` 是单条用例掉队，`Error: Hook timed out in 10000ms` 是整个文件 suite 级掉队（该文件全部用例被标 skipped）。core 与 api 包级再把 `testTimeout` 加宽到 60s（core 真跑 git 子进程，一个用例里 12 次 git 进程在本机要 4.0–4.7s；api 的 `cases.test.ts` 一条用例要造 25 次提交、合计 75 次 git 进程）。口径：等待上限按「宁可超时也不假红」定，真正的死循环仍会被挡住。

### 并发档位：不设上限

当前**不设 `maxWorkers` 上限**（走 vitest 默认并发），前提是长杆文件已全部拆成 ≤80s 的小文件。口径：**若再出现巨型文件 + `Test timed out` 假红，先拆文件，再把 `--maxWorkers` 调低当临时手段**（命令行覆盖永远赢过配置文件）。

### 内循环经济学

`pnpm test:changed` 只跑改动相关、全量留给门禁。计价单位是**进程创建**：夹具用 `beforeAll` 模板 + `cpSync`、缓存预热、产品侧合并 git 往返；墙钟由最长的文件决定（按文件并行），长杆文件按 describe 拆开。

### 依赖安装：只走 npmmirror 与手改 lockfile

- **registry 固定 `https://registry.npmmirror.com`**（仓内 `.npmrc` 的 `registry`）。**不用本机默认的内网镜像**：它的元数据是周期同步的旧快照，已发布的版本端点会返 404，而 pnpm **只要清单改过就做一次全量重解析**（加一个依赖就要重读整棵树的元数据）⇒ 任何新增依赖都被它卡死（`ERR_PNPM_NO_MATCHING_VERSION`）。两格踩过的缺货：`@anthropic-ai/claude-agent-sdk-linux-arm64-musl@0.3.281`（内网只到 0.3.280）与 `node-addon-require-builtin-darwin-x64@0.1.6`（内网只到 0.1.4）。本仓 pin 的厂商版本在 npmmirror 上逐条核对过都有货，故不按 scope 分流。
- **不裸跑 `pnpm add`，也不跑 `--no-frozen-lockfile`**：那条路是全量重解析——既有 snapshot 条目会消失、厂商 SDK 的 peer 会被换掉（`@anthropic-ai/claude-agent-sdk` 的 peer 从 `@anthropic-ai/sdk@0.124.0` 漂到 `0.129.0`、`undici` 8.10.2→8.11.2）。口径：**手改 `package.json`** → 用一个同 peer 集合的临时工作区解析出新依赖的**可达闭包** → **只把新增的** `packages:` / `snapshots:` 条目并进旧 lockfile（既有条目一行不动）→ `pnpm install --frozen-lockfile`。判据：`git diff --stat pnpm-lock.yaml` 是**纯插入**（0 deletions），既有版本后缀逐字不变。
- **`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`**：新依赖改变了 `hoistPattern: ['*']` 的提升集合 ⇒ pnpm 选择**整体重链** `node_modules`，非 TTY 下先要求确认。放行用 `--config.confirmModulesPurge=false`；那一次是全量重链（分钟级），大二进制包从慢 registry 拉会超时 ⇒ 配 `--fetch-timeout=900000 --fetch-retries=6 --fetch-retry-maxtimeout=300000 --network-concurrency=4`。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| `pnpm-workspace.yaml` 的 `allowBuilds` | pnpm 11 必需 | `sharp` / `unrs-resolver` 等构建脚本要在这里放行；写进 `onlyBuiltDependencies` 不再生效 |
| **`next dev` 在含中文的源码行上 panic ⇒ 服务直接不可用** | 已定位 | Next 16 的代码帧渲染器（`next-code-frame/src/highlight.rs:1011`）按**字节**偏移切它要展示的那一行，切在汉字中间就 panic（Rust 的字符串切片语义），随后那个 worker 线程死掉、日志只留 `[Error: Panic in async function] { code: 'GenericFailure' }`——真正的诊断被吞掉，症状是「Ready 之后服务不响应」。本仓 `apps/web-next/instrumentation.ts` 里那条停机 JSDoc 的首行刻意写成 ASCII（同一份说明的中文紧随其后）；任何会被代码帧渲染的含中文行都有同样风险。真撞上时先把那一行临时换 ASCII 看清诊断，再决定怎么改 |
| tsconfig「并集」是近似说法 | 已登记 | 未含 web-next 应用根的 `instrumentation.ts`（该应用自己的 tsconfig 里有），实际仍被 `src/instrumentation.test.ts` 以 `@/instrumentation` 导入检查到；别拿并集当「与各包 include 逐项相等」的依据 |
| 共享超时基线与包级加宽并存 | 取舍 | 基线 40s / 60s，core 与 api 包级 `testTimeout` 60s；按「宁可超时也不假红」定，别随手调小 |
| 满载假红判据 | 已登记 | 红不红看**隔离复跑**：满载的 `Test timed out` 是已知噪声，零断言失败 + 隔离全过 ⇒ 不是回归；机器带负载时 `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000` |
| 根 `pnpm test` 的形态误判 | 已登记 | 它是根上单跑（projects 收齐 8 包），**不是**每包一行输出；不能用「输出里有没有 8 段包级汇总」判断跑全了；`.next/types` 陈旧会让 typecheck 假红（删过源码先重建产物） |
| ESLint flat config **不读 `.gitignore`** | 已登记 | `.gitignore` 以「生成物」为由忽略的目录，只要可能落 `.js` / `.ts`，就得在 `eslint.shared.ts` 的仓库级 `ignores` 里再写一遍——两边的忽略集合本来就不一致。两类已知后果：真机探针把第三方模板的 `.ts` 克隆进 `probe/dumps/**` 时，`pnpm lint` 的报错会涨到上万条；VitePress 把依赖预打包的第三方 `.js` 放进 `docs/.vitepress/cache/deps/` 时，其中一条 `es5/no-es6-methods` 会以 `Definition for rule 'es5/no-es6-methods' was not found` 让 `pnpm lint` 退出码 1（故 `**/.vitepress/cache/**` 与 `**/.vitepress/dist/**` 必须在 ignores 里） |
| 改过 `package.json` 之后跑 `pnpm <script>`：pnpm 的依赖自检会**裸跑一次 `pnpm install`** | 已登记 | 它不只是「看起来像回归」——**它会真的改写 `pnpm-lock.yaml` 与 `node_modules`**。判据：把某个依赖的版本改成一条装不上的线（`latest`）时，自检当场以 `ERR_PNPM_FETCH_404` 失败，而失败的 install 已经把 lockfile 重写成了它自己解析出来的那一版 ⇒ 刚做完精细合并的 lockfile 与已对齐的 `node_modules` **双双回到污染态**，后续真机用例会以「装的还是旧版本」假红。因此那一轮先 `pnpm install --frozen-lockfile` 对齐状态；**凡是要改 `package.json` 的验证（依赖层面的变异验证就是）一律走 `node_modules/.bin/{vitest,tsc,eslint}`** 绕开自检，跑完再核对 `pnpm-lock.yaml` 的哈希 |

## 相关链接

- [仓库分层与依赖方向](/architecture/layering) —— 前缀化机制（`scopeToDir` / `PACKAGE_DIRS`）的分层侧：FORBIDDEN 名单与包目录是两页共用的真源
- [《测试策略与提速》](/guard/test-strategy) —— 规约守卫域：进程创建预算与内循环跑法的展开
- [《界面原语与主题》](/architecture/ui-primitives-and-theme) —— vendored manifest 脚本与构建产物的验收
- 仓库根 `AGENTS.md`「命令与测试」节 —— 只留常用入口与本页的指针
