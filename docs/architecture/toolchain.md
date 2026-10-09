# 工具链与命令聚合

## 定位

`pnpm lint` / `pnpm typecheck` / `pnpm test` 三条门禁命令各起**一个**进程覆盖 8 个包，靠「复用包级真源」聚合：根 eslint 配置前缀化引用包级边界规则、根 vitest 用 `projects` 引用各包配置、根 tsconfig 取各包 `include` 的并集。三条都刻意不走 `pnpm -r`——递归会给 8 个包各起一次进程，全部时间花在启动税上。

## 形态与交互

### 命令入口

命令表的真源在仓库根 `AGENTS.md`「命令」节（7 条：dev / build / lint / format / typecheck / test / test:changed）。使用原则：内循环用 `pnpm test:changed`（只跑与改动相关的文件），全量留给门禁；单包 `pnpm --filter @aieval/<包名> <脚本>` 与根命令的**结果必须一致**（包级配置是真源，根只聚合）。

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

逐包跑的实测数字是脚手架期的量级，结论至今成立：逐包跑 eslint 实测 14.5s，其中约 12s 是 8 次 Node + 插件加载的启动税、94 个源文件本身不到 1s；逐包跑 vitest 实测 22.6s，约 20s 是启动税，各包测试自身的 Duration 只有 600ms 上下；逐包跑 typecheck 实测 12.7s，绝大部分是启动与重复装载。2026-10-08 口径：8 包共 476 个 `.ts` / `.tsx`（`git ls-files` 口径 475）、229 个测试文件——文件数涨了数倍，**启动税占大头**的结论不变。

### vitest 的 projects 收集

根配置的 `projects` 是 glob：`packages/server/*/vitest.config.ts`、`packages/client/*/vitest.config.ts`、`apps/*/vitest.config.ts`，外加**显式列出**的 `docs/vitest.config.ts`（知识库内容守卫工程，2026-10-09 并入；docs 不是 workspace 包，glob 会把无关目录扫进来）。glob 不写死路径：新包自带 `vitest.config.ts` 即自动被收进根测试，不出现「新包没进根测试」的静默漏测。**改动收集方式后必须核对用例总数**。

### tsconfig 并集

根 `tsconfig.typecheck.json` 的 `include` = 7 个库包的 `src` + web-next 的 `next-env.d.ts` / `app` / `src` / `.next/types`。**不含**仓库根与各包 `*.config.ts`——只做聚合、不顺带扩面（扩面会让门槛变化混进性能改动里，出问题难归因）。`incremental` + 单一 `tsBuildInfoFile`：全量首次跑建一次图，第二次起只重查改动文件；8 个包各写一份会把「同一个文件被哪个项目检查过」拆散，增量失效，故只放根上一份。

### vitest 双配置与线程池

- `vitest.node.ts`（库包与 web-next）/ `vitest.jsdom.ts`（ui 与 client，jsdom + setup）两份共享配置，各包 `vitest.config.ts` 直接复用；纯函数测试标 `// @vitest-environment node`。
- `pool: 'threads'`：vitest 4 默认池是 `forks`（每次起子进程），而本机（i7-1260P，4 性能核 + 8 能效核）的进程创建极贵——企业 DLP / EDR 在每个新进程上挂钩，实测 `git --version` 350–566ms、`node --version` 530ms 量级；threads 用 worker_threads 免掉这层。本仓测试不用 `process.chdir()` / `process.exit()` / 原生模块（正是 vitest 把默认池从 threads 改回 forks 的三类原因），故可安全换。

### 超时预算

共享基线 `testTimeout: 40_000` / `hookTimeout: 60_000`：默认的 5s / 10s 在满载下会假红——`Test timed out in 5000ms` 是单条用例掉队，`Error: Hook timed out in 10000ms` 是整个文件 suite 级掉队（该文件全部用例被标 skipped）。core 与 api 包级再把 `testTimeout` 加宽到 60s（core 真跑 git 子进程，一个用例里 12 次 git 进程本机实测 4.0–4.7s；api 的 `cases.test.ts` 一条用例要造 25 次提交、合计 75 次 git 进程）。口径：等待上限按「宁可超时也不假红」定，真正的死循环仍会被挡住。

### 并发档位：不设上限的演化

曾因两个 250–370s 巨型文件 + 15 路 worker 假红一片而取 `maxWorkers: 8`（同一棵树实测：默认并发 307.0s / 20 红，8 路 343.5s / 8 红——拿 +12% 墙钟换 −60% 假红）。长杆文件全部拆成 ≤80s 的小文件后，同一份代码四档实测全部 0 失败（6 路 156.7s / 8 路 150.5s / 12 路 129.9s / 15 路 125.4s），上限拿掉回默认。口径：**若再出现巨型文件 + `Test timed out` 假红，先拆文件，再把 `--maxWorkers` 调低当临时手段**（命令行覆盖永远赢过配置文件）。

### 内循环经济学

`pnpm test:changed` 只跑改动相关、全量留给门禁。计价单位是**进程创建**：夹具用 `beforeAll` 模板 + `cpSync`、缓存预热、产品侧合并 git 往返；墙钟由最长的文件决定（按文件并行），长杆文件按 describe 拆开。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| tsconfig「并集」是近似说法 | 已登记 | 未含 web-next 应用根的 `instrumentation.ts`（该应用自己的 tsconfig 里有），实际仍被 `src/instrumentation.test.ts` 以 `@/instrumentation` 导入检查到；别拿并集当「与各包 include 逐项相等」的依据 |
| 共享超时基线与包级加宽并存 | 取舍 | 基线 40s / 60s，core 与 api 包级 `testTimeout` 60s；按「宁可超时也不假红」定，别随手调小 |
| 满载假红判据 | 已登记 | 红不红看**隔离复跑**：满载的 `Test timed out` 是已知噪声，零断言失败 + 隔离全过 ⇒ 不是回归；机器带负载时 `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000` |
| 根 `pnpm test` 的形态误判 | 已登记 | 它是根上单跑（projects 收齐 8 包），**不是**每包一行输出；不能用「输出里有没有 8 段包级汇总」判断跑全了；`.next/types` 陈旧会让 typecheck 假红（删过源码先重建产物） |

## 相关链接

- [仓库分层与依赖方向](/architecture/layering) —— 前缀化机制（`scopeToDir` / `PACKAGE_DIRS`）的分层侧：FORBIDDEN 名单与包目录是两页共用的真源
- [《测试策略与提速》](/guard/test-strategy) —— 规约守卫域：进程创建预算与内循环跑法的展开
- 仓库根 `AGENTS.md` 的「命令」「测试」「技术栈」节 —— 命令表与测试规矩的真源
