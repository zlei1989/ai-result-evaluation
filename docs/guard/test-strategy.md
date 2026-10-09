# 测试策略与提速

本仓 vitest 套件的跑法与提速口径：内循环分层下钻、以进程创建为计价单位、测试预算写成可变对象，以及负载下假红的识别与处置。

## 定位

测试策略回答两个问题：**怎么跑**——内循环在哪一层收口、全量留给门禁；**怎么快**——提速的计价单位是什么、长杆怎么削。规则简明真源是 `AGENTS.md`「测试」节，本篇展开其机制与判据。

分层跑法（内循环从上往下钻，全量只在门禁跑）：

| 场景 | 命令 | 定位 |
|---|---|---|
| 单文件 | `pnpm vitest run <文件路径>` | 最小循环 |
| 单包 | `pnpm vitest run packages/server/<包>` | 包级收口 |
| 改动相关 | `pnpm test:changed` | **内循环用这个** |
| 全量 | `pnpm test` | **留给门禁** |

- 全量是一个进程收齐 8 个包：根 `vitest.config.ts` 用 `projects` 引用各包配置，**刻意不走 `pnpm -r`**——递归会给 8 个包各起一次进程，聚合的价值就没了。
- 反面跑法：`pnpm --filter <pkg> test -- <file>`。vitest 把 `--` 之后的参数当**测试名过滤符**，结果是收集整包再过滤——实测约 40s，对照 `pnpm exec vitest run <单个文件>` 约 7s。单条变异命令也遵守这条：不得被外部超时强杀截断文件。
- 跑全量时「机器带负载」是常态而非例外，红绿判读先过《已知边界与取舍》那套分类，再谈修不修。

## 形态与交互

- **双环境配置**：`vitest.node.ts`（库包与 web-next）/ `vitest.jsdom.ts`（`ui` 与 `client`）；纯函数测试标 `// @vitest-environment node`，不白拖一个 jsdom。
- **`.tsx` 测试只能在库包写**：`apps/web-next` 必须留 `jsx: preserve`，否则 Vite 的 import-analysis 报 `make sure to not set jsx to preserve`；改 vitest 的 `esbuild.jsx` / `esbuild.tsconfigRaw` 都无效。组件测试放 `packages/client/ui`，别试图给 web-next 开例外。
- **别名**：`apps/web-next` 的 `@/*` 指应用根目录；**vitest 不读 tsconfig 的 `paths`**，故在 `apps/web-next/vitest.config.ts` 显式给 `resolve.alias`（其中把 evaluator 指向源码只为让路由测试的 `vi.mock` 生效，只活在测试期——别改成 devDependency）。
- **jsdom 的缺口，桩的分寸**：`matchMedia` 由用例自己注入；`ResizeObserver` 桩在 `packages/client/ui/src/testing/resize-observer.ts`，**不放进共享 setup**——放进去，兜底分支再也测不到；真实拖拽不可达（容器尺寸 0），`Splitter` 的 `onResize` 回写要在真实调用方处钉，jsdom 里钉不住。jsdom 钉不住的行为由[冒烟测试方法论](/guard/smoke-testing)在真机补位。
- **`vi.mock` 逐文件重复**：前置提升只作用于本文件。`orchestrator-*.test.ts` 每个文件都要自己写全三条 `vi.mock`（`@aieval/agents`、`./judge`、`./run-store`，`orchestrator-run-row.test.ts` 头部是标准形）；漏一条不报错，会**静默 spawn 真厂商 CLI**。这条静默坑由静态守卫兜住：`packages/server/evaluator/src/static-assertions.test.ts` 判每个 mock 工厂体的运行时边（`export {} from` 空子句也算运行时边——转译后是一条真请求），守卫自身做过变异验证：拿掉那行判据，恰好对应的新增负样本红。

## 数据与契约

**收集范围契约**：根 `projects` 的 glob 收 `packages/{server,client}/*` 与 `apps/*`，新包自带 `vitest.config.ts` 即被收进来；单包 `pnpm --filter @aieval/<包名> <脚本>` 与根命令结果必须一致。**改动收集方式后必须核对用例总数**——漏收一整个包是静默漏测。

**测试预算契约**（等待与重试的写法）：

| 契约 | 形态 | 判据 |
|---|---|---|
| 重试预算写成可变对象 | `TEXT_API_RETRY` / `ROW_RETRY`：`beforeEach` 读产品默认值再改小、`afterEach` 还原 | 默认值要有**独立用例**钉住——测试里改小不等于丢真源 |
| 终态期望才接 `impossible` | `until` 的第 4 参 `impossible` 只给**终态期望**用（如「重评后该行回到 judged」：落成别的终态就是真失败） | 拿去等中间态会把时序耦合钉错位 |
| 等待上限宁宽勿紧 | 所有等待上限按「**宁可超时也不假红**」定 | 上限定小制造假红，定大只是慢；超时可复跑定性，假红污染判据 |

## 机制与演化

**计价单位是进程创建**。提速手段全部围绕「少起进程」展开：

| 手段 | 落点 |
|---|---|
| 夹具 `beforeAll` 模板 + `cpSync` | 模板目录一次拷贝，摊给整个文件的用例——替代每条用例重建仓库 |
| 缓存预热（`prewarmCaseCache`） | 把 commit 钉进用例缓存，首条用例不为冷缓存买单 |
| 产品侧合并 git 往返 | 把 N 次子进程往返合并成一次——改产品码，不是改测试 |

**墙钟由最长的文件决定**：vitest 按文件并行、文件内用例串行，套件墙钟 ≈ 最长文件的耗时。长杆文件**按 describe 拆开**，把串行长杆切成可并行的短杆——削长杆比优化每条用例划算。

**历史基线（转述，只当数量级参考）**：提速前全量 `tests` 累积安静时约 2604s、带负载约 8154s（当时墙钟约 225s / 699.6s）；提速后一次全量实测 770.88s（213 个文件 / 2694 条用例，墙钟 150.12s），约 0.30× 安静基线。基线记录早于当前套件构成——**不可横比、不可当逐项判据**。

**清理期 EPERM flake 的机制**（判读依据见《已知边界与取舍》）：

- 现象：Windows 上 `rmSync` 清理临时目录偶发 `EPERM, Permission denied`，把本该绿的用例判红。
- 机制：Node 的 `internal/fs/rimraf` 判据是 `retryErrorCodes.has(err.code)`，**EPERM 不在其中**（读安装的 Node v26.7.0 源码确认，非推测）——`maxRetries` 对该 errno 形同虚设，重试一次都不会发生。
- 既存事实：`%TEMP%` 下 `aieval-*` 临时目录残留长期累积（315 → 367 个），清理失败不是新冒出来的问题。

## 已知边界与取舍

负载与 flake 之下，红先分类再处置：

| 红的形态 | 判据 | 处置 |
|---|---|---|
| 满载超时噪声 | 全部红是 `Test timed out` / `Hook timed out`，无一例断言失败（历史满载批次 24 条红里 23 条 `Test timed out in 60000ms`、另有 5 条 `Hook timed out`） | 先看 `tests` 累积项，**比上次大 2 倍以上就别把红当回归**；复跑用 `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000` |
| 清理期 EPERM flake | 该文件的**失败条数 == stderr 里 `EPERM` 的条数**、`AssertionError` 为 0；零 `Test timed out`（与耗时无关）；红集合每次不同 | 判 flake 不判回归；要修走独立一条线：**有界重试一次 + 告警**，不静默吞（静默会掩盖真正的泄漏） |
| 真红 | 断言失败有确定锚点、红可复现 | 修 |

- **全量红一律先隔离复跑**，且复跑前先确认**没有别的会话在跑套件/变异体**（本仓多写者）——先例：一次满载全量的红全是超时（`Test timed out in 5000/20000/60000ms`，无一例断言失败），四个包隔离复跑 14/13/9/37 条全绿、退出码 0。
- **包级超时上限不一**：`api` 包整包 `testTimeout: 60_000`（对照 `core` 是 20_000），该包的满载噪声会以 60 秒级超时的形态出现——接受现状，看到时别当新缺陷。
- **`vi.mock` 守卫的覆盖边界**：工厂体若写成静态 import 的标识符（`vi.mock('@aieval/agents', seams.agentsMock)`）而不是内联 `async () => (await import('<字面量>'))`，判据取不到运行时边，**静默放行**——这是有意留的边界，不是守卫失效；保持内联形态（现仓 58 处带工厂的 `vi.mock` 全部是内联形态）。

## 相关链接

- [冒烟测试方法论](/guard/smoke-testing)——jsdom 覆盖不到的（拖拽、真机行为）由冒烟补位，红绿判据同源
- [密钥与环境变量](/guard/secrets-and-env)——测试隔离的临时配置目录与环境差异假绿的点名法
- [Playwright MCP](/guard/playwright-mcp)——jsdom 测不到的几何与拖拽在真机上的断言口径
- [《变异验证》](/guard/mutation-verification) ——静态守卫必须见过失败才算守卫
- 仓库内参考：`AGENTS.md`「测试」节——规则简明真源
