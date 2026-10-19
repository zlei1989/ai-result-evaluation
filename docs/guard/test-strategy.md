# 测试策略与提速

本仓 vitest 套件的跑法与提速口径：内循环分层下钻、以进程创建为计价单位、测试预算写成可变对象，以及负载下假红的识别与处置。

## 定位

测试策略回答两个问题：**怎么跑**——内循环在哪一层收口、全量留给门禁；**怎么快**——提速的计价单位是什么、长杆怎么削。本篇是测试口径的真源；`AGENTS.md` 的「命令与测试」节只留常用入口。

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
- **jsdom 的缺口，桩的分寸**：`matchMedia` 由用例自己注入；`ResizeObserver` 桩在 `packages/client/ui/src/testing/resize-observer.ts`，**不放进共享 setup**——放进去，兜底分支再也测不到；真实拖拽不可达（容器尺寸 0），`ListDetailLayout` 的 `onResize` 回写要在真实调用方处钉，jsdom 里钉不住。jsdom 钉不住的行为由[冒烟测试方法论](/guard/smoke-testing)在真机补位。
- **`vi.mock` 逐文件重复**：前置提升只作用于本文件。`orchestrator-*.test.ts` 每个文件都要自己写全三条 `vi.mock`（`@aieval/agents`、`./judge`、`./run-store`，`orchestrator-run-row.test.ts` 头部是标准形）；漏一条不报错，会**静默 spawn 真厂商 CLI**。这条静默坑由静态守卫兜住：`packages/server/evaluator/src/static-assertions.test.ts` 判每个 mock 工厂体的运行时边（`export {} from` 空子句也算运行时边——转译后是一条真请求）。
- **两处家目录默认根，两个 override 钩子**：`setConfigDirForTesting`（配置目录）与 `setCasesRootForTesting`（用例目录，默认 `~/.aieval-cases`）**互不覆盖**，夹具必须两个都设；批量动用例文件的夹具再加一道安全阀（`getCasesRootOverrideForTesting()` 为 null 就抛错，见 `evaluator/src/testing/fixtures.ts`）。隔离细节见[密钥与环境变量](/guard/secrets-and-env)。
- **依赖「未入库产物」的守卫用 `it.skipIf(!existsSync(...))`，并在用例注释里交代怎么恢复那份产物**：真机抓包（`probe/dumps/**`）在 `.gitignore` 里、干净检出上必然没有，硬要它存在等于让一条永远不能变绿的守卫常驻门禁。先例：`agents/src/providers/codex/events.test.ts` 的抓包重放就是这种**有条件跳过**而不是「被关掉」。详见 [Codex FAQ](/faq/codex) 的那条 ENOENT 条目。

### 测试环境 ≠ 运行环境：模块环的 TDZ 在 vitest 里不出现

`contracts` 的包根一旦成环，真正的消费方会撞 `ReferenceError: Cannot access 'X' before initialization`——最典型的是 `pnpm dev` 起来就退、任何页面打不开。同一条环在 `vitest` 里**不报**：Vite 的 SSR runner 不实现 ESM 的 TDZ 语义，未初始化的绑定读成 `undefined`，环因此静默成立。逐文件用例又几乎不 import 包根，环的另一头早已被别的路径初始化好，于是「全部用例绿」完全不构成「包根可用」的证据。

所以「包根可用」的判据不能用 vitest import 包根，只有两条：

- **静态无环扫描**（首选）：把包内相对 `import` 组成有向图找环，成环即红并打印完整环路径——`packages/server/contracts/src/module-graph.test.ts`；
- **Node 原生 ESM 子进程**（补充）：`node --input-type=module -e "import('@aieval/contracts')"`，让解析器用真实语义评估一次。

边界：静态扫描只覆盖包内相对 import，跨包环由依赖方向表（`apps/web-next/src/package-dependency-boundaries.test.ts`）兜。断环的做法是**下沉**共用值域到叶子模块，不要用 `z.lazy` 之类把炸点推迟到运行期。

## 数据与契约

**收集范围契约**：根 `projects` 的 glob 收 `packages/{server,client}/*` 与 `apps/*`，新包自带 `vitest.config.ts` 即被收进来；另有 `docs/vitest.config.ts` 一条**显式路径**——docs 不是 workspace 包，glob 罩不到（知识库守卫工程，node 环境读磁盘断言）。单包 `pnpm --filter @aieval/<包名> <脚本>` 与根命令结果必须一致。**改动收集方式后必须核对用例总数**——漏收一整个包是静默漏测。

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

**当前构成（仅供判读「跑全了没有」）**：`pnpm test` 一次收 **454 个文件**（含 docs 的知识库守卫工程），安静机器上墙钟约 60–90s；其中 6187 条通过、31 条跳过。

**清理期 EPERM flake 的机制**（判读依据见《已知边界与取舍》）：

- 现象：Windows 上 `rmSync` 清理临时目录偶发 `EPERM, Permission denied`，把本该绿的用例判红。
- 机制：Node 的 `internal/fs/rimraf` 判据是 `retryErrorCodes.has(err.code)`，**EPERM 不在其中**（Node v26.7.0 的该处源码即此判据，非推测）——`maxRetries` 对该 errno 形同虚设，重试一次都不会发生。
- 既存事实：`%TEMP%` 下 `aieval-*` 临时目录残留会长期累积（几百个量级），清理失败是常态。

## 厂商适配器的真机探针

对着 `providers/<kind>/` 做审计时，"读代码 + 跑单测"能回答的只有一小半：厂商 CLI 的**真实行为**
（它发什么帧、把我们的入参改成什么样、什么时候截断、什么时候另起一轮）只能靠一台**跑得起来的真机**去问。
真源只有三处**厂商自己写出来的东西**——**出站请求体逐字**（我们发出去的是什么）、**厂商原始帧逐字**
（它回了什么，含"适配器认得于是不落日志"的那些，只有 SDK 边界截帧才看得到）、**CLI 落在行目录里的转录**
（它自己怎么记账）。配合一条注意：未识别帧的兜底日志是拿原始帧的入口，但**认得**的帧不走它
——"日志里没有"不等于"厂商没发"。

四条纪律，每条都对应一次假读数：

- **剧本按请求特征分流，不按请求序号**：CLI 在会话开始时还会打辅助请求（例如给会话起标题），
  它同样落在同一个端点、同样带那套 base 提示词。按序号推进会被它吃掉一轮，症状是"工具一次都没跑"
  ——看着像产品缺陷，实际是剧本错位。
- **SDK 注入表是「包名 → 模块」**：塞**模块本身**不报错，只会静默回落到真实加载；于是"注入的假体"
  从未生效，而读数看起来没问题。
- **装饰器必须用 Proxy 转发**：`query()` 返回类实例、方法在原型上，展开对象会把手感方法（中断、
  取消、上下文用量）整批丢掉，症状是适配器报"该版本没有这个方法"——那是探针造的假红。
- **类型面、常量表、注释都不是真源**：SDK 导出的内建工具名单与 CLI 实际接受的名字可以不一致；
  厂商的某些方言（如模型名后缀）会被 CLI 当场消费，**出站请求体里反而看不到它**
  ⇒ 判"这一格有没有生效"要在 **SDK 边界**读我们交出去的那一份。另外：**"按某格禁用之后"的表
  不能当基线**（被禁的东西本来就不在表里），要判生不生效只能跑两臂看**差集**。

难造的分支（上下文压缩、限流、启动失败）先别改判据去凑，**先找厂商自己报出来的读数**：
例如上下文用量的控制请求会返回**当前生效的窗口与压缩阈值**，读到它就反推得出"要多大才触发"；
某个选项有没有被读到，也常常能从那一条返回里直接看见（返回里的窗口变了就说明生效了）。
真造不出来就登记**未观测**并写清已确证的格与下一步，比按类型面猜一个行为强。

## 已知边界与取舍

负载与 flake 之下，红先分类再处置：

| 红的形态 | 判据 | 处置 |
|---|---|---|
| 满载超时噪声 | 全部红是 `Test timed out` / `Hook timed out`，无一例断言失败（满载批次的红几乎全是 `Test timed out in 60000ms`，另有个别 `Hook timed out`） | 先看 `tests` 累积项，**比上次大 2 倍以上就别把红当回归**；复跑用 `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000` |
| 清理期 EPERM flake | 该文件的**失败条数 == stderr 里 `EPERM` 的条数**、`AssertionError` 为 0；零 `Test timed out`（与耗时无关）；红集合每次不同 | 判 flake 不判回归；要修走独立一条线：**有界重试一次 + 告警**，不静默吞（静默会掩盖真正的泄漏） |
| 真红 | 断言失败有确定锚点、红可复现 | 修 |

- **全量红一律先隔离复跑**，且复跑前先确认**没有别的会话在跑套件或做变异验证**（本仓多写者）——隔离复跑全绿、退出码 0 就不是回归。
- **包级超时上限不一**：`api` 包整包 `testTimeout: 60_000`（对照 `core` 是 20_000），该包的满载噪声会以 60 秒级超时的形态出现——接受现状，看到时别当新缺陷。
- **`vi.mock` 守卫的覆盖边界**：工厂体若写成静态 import 的标识符（`vi.mock('@aieval/agents', seams.agentsMock)`）而不是内联 `async () => (await import('<字面量>'))`，判据取不到运行时边，**静默放行**——这是有意留的边界，不是守卫失效；保持内联形态（现仓 58 处带工厂的 `vi.mock` 全部是内联形态）。

## 相关链接

- [冒烟测试方法论](/guard/smoke-testing)——jsdom 覆盖不到的（拖拽、真机行为）由冒烟补位，红绿判据同源
- [密钥与环境变量](/guard/secrets-and-env)——测试隔离的临时配置目录与环境差异假绿的点名法
- [Playwright MCP](/guard/playwright-mcp)——jsdom 测不到的几何与拖拽在真机上的断言口径
- [《变异验证》](/guard/mutation-verification) ——静态守卫必须见过失败才算守卫
- 仓库内参考：`AGENTS.md`「命令与测试」节——常用入口与指针
