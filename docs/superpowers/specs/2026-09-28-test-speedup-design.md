# AI 生成代码评测工具 —— 测试墙钟提速设计（进程创建预算视角）

> 前置阅读：`AGENT.md`（「测试」「注释」「边界与工具链的已知坑」三节）、
> `packages/server/core/src/git.ts`（git 原语，本设计唯一的被测产品面）。
> 本文描述的是**工程口径**的改动：不改产品语义、不减用例、不放宽守卫强度，
> 只改「测试要付多少次进程创建」与「失败要烧多久的守卫预算」。

## 1. 要解决的问题

`pnpm test` 的墙钟今天由**一个文件**决定，而那个文件里有 79% 的时间是**失败用例在烧守卫上限**。

### 1.1 实测依据（本仓日志 + 本机微基准，2026-09-28）

| 事实 | 数值 | 怎么验的 |
|---|---|---|
| 全量墙钟 ≈ `orchestrator.test.ts` 的时长 | 2437s 里它占 **2426s** | `.full-test.log`（116 文件 / 1516 用例 / 36 红）：`orchestrator.test.ts (85 tests \| 12 failed) 2426043ms` |
| 同一结论在门禁运行里复现 | 919s 里它占 **911s** | `.gate-test.log`（113 文件 / 1425 用例 / 20 红）：`orchestrator.test.ts (70 tests) 911498ms` |
| 全绿 + 独占时同一个文件只要 | **472.84s** | `.vitest-orch5.log`：`Test Files 1 passed (1)` / `81 passed \| 5 skipped (86)` |
| 那 12 条红全是**超时**，不是断言失败 | 5×`timed out in 300000ms` + 7×`timed out in 60000ms` = **1 920 000ms = 32.0 分钟** | `.full-test.log` 的 Failed Tests 段逐条 |
| 远端那 5 条独占跑只要 | **75.98s** | `.vitest-remote.log`：`5 passed \| 80 skipped (85)` |
| 进程创建是本机的计价单位 | `cmd /c exit 0` **162ms**、`git --version` **566ms**、`node --version` **530ms**（暖态多次均值） | 本机 `Measure-Command` |
| 单次夹具仓库成本 | `init`+`config`×2+`add`+`commit`+`rev-parse` = **1612ms** | 同上 |
| 单次真克隆成本 / 单次 `git status` | 本地 `git clone` **1053ms** / `status --porcelain -z` ≈ **251ms** | 同上 |
| 杀软排除名单里没有本仓要用的东西 | Defender 实时防护 `RealTimeProtectionEnabled: False`，`ExclusionProcess` 无 `git.exe` / `node.exe`，`ExclusionPath` 无本仓路径与 `%TEMP%` | `Get-MpComputerStatus` / `Get-MpPreference` |
| `collectDiff` 一次调用 = **6** 个 git 进程 | `git.ts:545-559`：`status` / `add -N` / `diff --numstat HEAD` / `diff base..HEAD` / `diff HEAD` / `diff --numstat base..HEAD` | 读码 + core 包 `vitest.config.ts` 的文件头注释（「一个用例里 collectDiff 调两次就是 12 次 git 进程，本机实测 4.0–4.7s」） |
| `assertCommit` 一次 = **2** 个 git 进程 | `git.ts:118-138`：`cat-file -e <hash>^{commit}` + `rev-parse <hash>^{commit}` | 读码 |
| `ensureCaseCache` 已验过的 commit，`checkoutRow` 再验一遍 | `hasCommitObject`（`git.ts:306-313`）+ `assertCommit`（`git.ts:476`） | 读码 |

### 1.2 三条推论（本设计的立足点）

1. **墙钟不是「所有测试之和」，是「最长的那个文件」**。三次独立运行都指向同一个文件；
   其余 115 个文件的 worker-seconds 之和（约 1626s）在 15 路并发下早就跑完了。
2. **失败比成功贵一个数量级**。守卫的上限是按「宁可超时也不假红」定的
   （`until(..., 30_000)`、`REMOTE_FIXTURE_TIMEOUT_MS = 300_000`、`testTimeout` 60s），
   条件一旦不可能成立，它就把整个预算烧完——12 条红 = 32 分钟。
3. **并发不是免费的**：同一组远端用例独占 76s，全量并发下 5 条全部越过 300s 上限。
   15 路 worker 抢同一条进程创建管道时，每次 spawn 都更贵。

## 2. 本阶段范围

**做：**

- 测试侧：守卫 fail-fast、拆分长杆文件、夹具模板化 + 用例缓存预热、并发度实测选值、内循环脚本；
- 产品侧：`collectDiff` 6→4 个 git 进程、`assertCommit` 2→1 个 git 进程（**输出逐字节等价**）；
- 文档：AGENT.md 补「计价单位」与「跑法分层」，另出一份 IT 白名单申请说明。

**不做（这些是「变快」的作弊路径）：**

- 不删用例、不加 `skip`/`todo`、不用 `--changed` 冒充门禁、不改 `expect` 的强度；
- 不放宽任何守卫的上限（要的是「失败得早」，不是「等得久」）；
- 不改产品的可观测行为（`ServiceError` 的 code / 中文原因 / `context` 形状全部保持）；
- 不动本仓其它会话正在改的文件（本设计只落在下面点名的路径上）。

## 3. 设计总览

三个阶段，按风险递增串行落地；每个阶段结束后**必须**有一次墙钟测量才算完成。

| 阶段 | 工作包 | 触及 | 预期 | 回滚成本 |
|---|---|---|---|---|
| 一（纯测试侧） | W1 守卫 fail-fast、W3 夹具减 spawn、W2 拆文件 | `evaluator/src/**` 测试与 fixtures | 红状态 40min → ~10min；绿状态 472s → ≤250s | 低（只动测试） |
| 二（产品侧） | W4 合并 git 往返 | `core/src/git.ts` | 每次 `collectDiff` −0.8s；每行准备 −0.4s | 中（一条一提交） |
| 三（调度与环境） | W5 并发度实测、W6 内循环、W7 文档 | 根 `vitest.config.ts` / `package.json` / `AGENT.md` | 消假红 + 省人工等待 | 低 |

## 4. W1：守卫 fail-fast

**问题**：`until(condition, label, timeoutMs)`（`evaluator/src/orchestrator.test.ts:63-70`）只会轮询到上限；
条件已经**不可能**成立时（被测对象已落终态）它照样等满预算。

**设计**：给 `until` 增加第 4 个可选参数 `impossible?: () => boolean`——
每次轮询先问它，成立时立刻带诊断抛错（消息里同时给出「等的是什么」与「为什么不可能」）。

- 上限**一个都不改**：`until(..., 30_000)`、`REMOTE_FIXTURE_TIMEOUT_MS = 300_000`、`testTimeout` 60s 全部保持原值。
- `impossible` 的判据取自被测对象自己的终态（`getRun(id)` 的轮/行状态），不新造语义。
- 覆盖范围：本文件全部 12 条会烧预算的调用点（远端来源 5 条 + `rescoreRow`/`retryRow` 7 条），
  其余调用点可选接入。
- 同名 helper 在 `orchestrator-live.test.ts:118` 与 `mirror.test.ts:146` 各有一份，本设计只改
  evaluator 那一份；另两份是否同步由实施时按同一判据决定（改动必须各自有守卫）。

**验收**：把 12 条失败面里的任意一条人为弄红（变异验证），确认它**秒级**失败而不是等满
60s/300s；还原后文件哈希与改动前逐字节一致。

## 5. W2：拆分 `orchestrator.test.ts`

**问题**：2543 行、86 条用例挤在一个文件里。vitest 按**文件**并行、文件内**顺序**执行，
所以这一个文件独占一个 worker 顺序跑完全程，墙钟被它钉死（§1.1 三次实测）。

**设计**：按 describe 分组成 10 个文件 + 1 个共享 harness。

| 新文件 | 收进的 describe | 用例数 |
|---|---|---|
| `orchestrator-run-row.test.ts` | `runRow：八步时序与落盘`、`runRow：改工作区根目录后仍在途收尾` | 5 |
| `orchestrator-failure-modes.test.ts` | `runRow：失败面与配置漂移` | 12 |
| `orchestrator-judge-route.test.ts` | `评分尺子只有一个来源`、`runRow：评分通路` | 11 |
| `orchestrator-execution-mode.test.ts` | `执行模式：并行与串行`、`轮收尾的失败面` | 5 |
| `orchestrator-abort.test.ts` | `终止语义（§5.4 的表）` | 10 |
| `orchestrator-timeout-isolation.test.ts` | `超时与失败隔离` + `（续）` | 5 |
| `orchestrator-recover.test.ts` | `recoverInterruptedRuns`、`R31 夹具守卫` | 6 |
| `orchestrator-remote-source.test.ts` | `远端来源的行准备` | 5 |
| `orchestrator-rescore.test.ts` | `rescoreRow：只重跑评分` | 13 |
| `orchestrator-retry.test.ts` | `runRow：瞬时失败的自动重试`、`retryRow` | 15 |

> 表里的用例数按**拆分前**的 describe 结构统计（本表合计 87，与文件当前的 `it(` 计数 86 差 1，
> 说明有一处嵌套或重复计数）；以 §10 第 3 条的「拆分前后总数逐一核对」为准，不以本表为准。

**共享 harness**：`evaluator/src/testing/orchestrator-harness.ts`，导出
`injected`（落盘失败/陈旧列表接缝）、`resetInjected()`、三个 mock 工厂
（`agentsMock` / `judgeMock` / `runStoreMock`）、`until()`、`seedRunnableRun()`、
`TEST_TIMEOUT_MS` / `REMOTE_FIXTURE_TIMEOUT_MS`、以及现有的事件读取与 cwd 断言小工具。

**`vi.mock` 的硬约束**：`vi.mock` 必须在**测试文件自身**里调用（vitest 只对它做前置提升），
所以每个新文件保留一段固定的三行前置块（内容逐字相同，由 harness 提供工厂函数体）。
**这是本设计最大的静默失效风险**：漏写 `@aieval/agents` 的 mock 会让测试**真的去 spawn 厂商 CLI**
（本仓已有先例：web-next 的 `@aieval/evaluator` alias 缺失时 `vi.mock` 静默失效并真的 spawn 子进程）。

**防静默失效的守卫**（新增，落在 `evaluator/src/static-assertions.test.ts` 的既有风格里）：
逐个读取这 10 个文件，断言每个文件都含三条 `vi.mock(` 注册；缺一条即红。
该守卫自身要做变异验证（删掉某个文件里的一行 `vi.mock`，确认守卫红）。

**验收**：`pnpm vitest run packages/server/evaluator` 的用例总数与拆分前**逐数相等**（AGENT.md 的
硬性要求：改动收集方式后必须核对总数，漏收集是静默漏测）。

## 6. W3：夹具减 spawn

**问题**：`seedRunnableRun`（`orchestrator.test.ts:211`）每条用例都 `initFixtureRepo`
（7 次 git ≈ 1612ms）；`prepareRowWorkspace → ensureCaseCache` 在每条用例的临时 workspaceRoot 下
**真的 clone 一次**（≈1053ms）。86 条用例仅这两项就 ≈ 230s。

**设计**（两件独立的事，各自可单独回滚）：

1. **仓库模板**：harness 的 `beforeAll` 建**一个**模板仓库（`initFixtureRepo` 一次），
   每条用例 `cpSync` 一份到自己的 `home.root/repo-<uuid>`（纯文件系统，实测 ~10ms）。
   依据：`git.repo.test.ts:71-101` 已经用同一手法把该文件的夹具从 23s 降下来，
   且 `copyWorkspace` 的用例守的正是「复制出来的仍是独立、可用、带 `.git` 的真仓库」。
2. **用例缓存预热**：harness 的 `beforeAll` 克隆**一份**模板缓存，每条用例把它 `cpSync` 到
   `caseCacheDir(home.workspaceRoot, caseId)`，并写 `.git/aieval-origin.json`
   （`{repoPath: 该用例自己的 repoPath, tip: 模板 commit, recordedAt}`）。
   - **只对钉死 `commitHash` 的用例预热**。`commitHash === null` 的语义是「跟随来源 tip」，
     走 `refreshCacheToSourceHead → fetch origin`——预热出来的缓存 `origin` 指向模板而不是该用例的仓库，
     语义会漂。那些用例继续走真克隆（`workspace.test.ts` 里有专门守这条语义的用例）。
   - 预热成立的依据：`ensureCaseCache`（`git.ts:189-242`）对「来源记录一致 + 缓存里已有该 commit」
     直接 return，一次 git 进程都不起。

**验收**：该文件单跑墙钟下降可测；`git.repo.test.ts` / `workspace.test.ts` 全绿（它们是
`ensureCaseCache` / `copyWorkspace` 的真源守卫，语义漂了会红）。

## 7. W4：产品侧合并 git 往返（`core/src/git.ts`）

**逐条实测依据（本机 git 2.47.0.windows.2）**：

| 现状 | 目标 | 实测 |
|---|---|---|
| `diff --numstat HEAD` + `diff HEAD`（2 进程） | `diff --numstat --no-color -p HEAD`（1 进程） | `--numstat -p` 一次输出里 **numstat 块在前、补丁块在后**（先若干 `A\tD\tpath` 行，再 `diff --git` 起的补丁），退出码 0 |
| `diff --numstat base..HEAD` + `diff base..HEAD`（2 进程） | `diff --numstat --no-color -p base..HEAD`（1 进程） | 同上 |
| `cat-file -e <hash>^{commit}` + `rev-parse <hash>^{commit}`（2 进程） | `rev-parse --verify <hash>^{commit}`（1 进程） | 短 hash 归一到 40 位全量；blob → `error: … expected commit type, but the object dereferences to blob type` 且非零退出；不存在的 hash → 非零退出 |

**解析设计**：合并输出按**第一条行首的 `diff --git `** 切成「numstat 段 + 补丁段」；
`--numstat` 段交给现有 `parseNumstat`，补丁段就是今天 `committed` / `uncommitted` 的取值。
边界三种情形都要有守卫：两段都为空（无改动）、只有 numstat（二进制/gitignore 边界）、
补丁正文里出现形如 `1\t2\tx` 的行（**必须不被误认成 numstat**——切分点只看行首 `diff --git `）。

**错误面不变**：不使用 `--quiet`（它会吃掉 stderr），`gitMessage(error)` 仍能取到 git 原文；
`ServiceError` 的 code（`INVALID_REF` / `INTERNAL`）、中文原因的形状、`context` 字段一律保持。

**不做**：不消除 `ensureCaseCache` 与 `checkoutRow` 对同一 commit 的重复校验（要改 `checkoutRow`
的入参形状，属于接口变更，收益 1 个进程/行，风险不划算）。此项登记在 §12。

**守门**：`git.diff.test.ts`（22 条，真实 git）与 `git.repo.test.ts`（33 条）是这两处的真源守卫，
必须全绿；并对新增的解析守卫做变异验证。

## 8. W5：并发度实测选值

**问题**：16 逻辑核（4P+8E）上默认起 ~15 个 worker，每个都在 spawn git；
同一组远端用例独占 76s、并发下 5 条全部越过 300s（§1.1）。

**设计**：在最终状态上跑三档全量——`--maxWorkers=4` / `--maxWorkers=8` / 默认——取**墙钟最短**的一档
写进根 `vitest.config.ts`（附注释写明是实测值、测法与日期），并顺手记下三档的用例总数与红数是否一致。
若三档差异在噪声内，就**不写**这个配置（少一个需要维护的魔数）。

## 9. W6/W7：内循环与文档

- `package.json` 增 `test:changed`（`vitest run --changed`），保留 `test` 为门禁口径；
  **不新增**「跳过重文件」的假门禁。
- `AGENT.md` 的「测试」小节补两条：① 计价单位是进程创建（附本机实测值）；
  ② 跑法分层：改一个包用 `pnpm vitest run <文件>`，全量只留给门禁。
- `docs/superpowers/notes/2026-09-28-test-runtime-it-request.md`：IT 白名单申请
  （`git.exe` / `node.exe` / 本仓目录 / `%TEMP%`），附实测对比（cmd 162ms vs git 566ms）。

## 10. 验证与证据要求

1. **改前基线**：`.baseline-test.log`（本次改动开始前跑的 `pnpm test`）。
2. **改后复测**：同一命令、同一机器、同一天，产出「改前/改后」墙钟对比表（含用例总数、红数）。
3. **用例总数只增不减**：拆文件后按 AGENT.md 要求逐包核对总数与全量一致。
4. **每条新守卫做变异验证**（把缺陷造回去确认它红，再还原并核对文件哈希）：
   - W1 的 `impossible` 判据（去掉它，红用例重新等满 60s/300s）；
   - W2 的 `vi.mock` 静态守卫（删一行 `vi.mock`，守卫必须红）；
   - W4 的 diff 合并解析（把切分点改错，`git.diff.test.ts` 必须红）。
5. **产品语义未变**：`pnpm typecheck` → `pnpm lint` → `pnpm test` 全绿；
   `ServiceError` 的形状由既有守卫钉住。
6. **不碰别人的文件**：`git add` 逐个显式路径，`git status` 里不属于本次改动的条目保持原样。

## 11. 风险与回滚

| 风险 | 处置 |
|---|---|
| 拆文件时漏写 `vi.mock` → 测试真的 spawn 厂商 CLI | §5 的静态守卫 + 变异验证（这是本设计唯一会**静默**变慢/变假绿的路径） |
| 缓存预热改变「跟随来源 tip」语义 | 只对钉死 commit 的用例预热；`workspace.test.ts` 的语义守卫必须绿 |
| diff 合并后的解析吃进补丁正文 | 切分点只看行首 `diff --git `；三条边界守卫 + 变异验证 |
| `maxWorkers` 调优在本机有效、在 CI 变慢 | 差异在噪声内就不写配置；写了就附实测依据与复测命令 |
| 改动被其它会话的文件污染 | 逐个 `git add <路径>`；每个工作包一次提交，便于单独回滚 |

## 12. 未能验证 / 明确不做

1. **IT 白名单的实际效果未验**（改机器策略不在本设计的执行面内）：只出申请说明，
   实测值（cmd 162ms vs git 566ms）作为依据。
2. **不消除 `ensureCaseCache` + `checkoutRow` 的重复 commit 校验**：需要改 `checkoutRow` 入参，
   属接口变更，收益 1 进程/行，不做。
3. **`.vitest-orch5.log` 里那 5 条 skip 的来源未确认**（当前文件里没有 `.skip` / `runIf`）。
   本设计不依赖它：拆文件后用例总数以**拆分前后逐数对比**为准。
4. **CI 机器的并发表现未测**（本设计的所有数字都出自本机 i7-1360P / 16 逻辑核 / Windows）。
