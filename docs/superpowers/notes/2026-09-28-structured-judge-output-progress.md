# 评分通路原生结构化输出 —— 实施完成记录（Task 1–10）

> 计划：`docs/superpowers/plans/2026-09-28-structured-judge-output.md`
> 设计：`docs/superpowers/specs/2026-09-28-structured-judge-output-design.md`
> 分支：`feat/features`（**就地执行**，见 ledger R1，不建 worktree）
> 台账原始档：`.superpowers/sdd/2026-09-28-structured-judge-output/progress.md`（逐任务的派发/报告/评审/裁决）
>
> 本文件由 **Task 10（冻结门禁 + 变异台账 + spec 回写）** 产出。Task 10 是**唯一一个只改 `docs/` 的任务**：
> 门禁必须跑在**代码冻结之后**，否则刚跑绿的门禁会被同一任务的后续提交推翻（拆分的理由见 ledger R47）。

---

## 一、冻结门禁（Task 10 实跑，2026-09-29）

全部命令在**未再改动任何代码/测试文件**的树上跑；三条都是**本任务自己这一次运行**打印出来的结果
（不引用 SDD 目录里既有的 `full-suite-clean.log` / `mutation*.log` —— 那些是前序任务各自的产物，
`full-suite-clean.log` 记的还是 `6 failed`，见 R32）。

| 命令 | 退出码 | 原始数字 |
|---|---|---|
| `pnpm typecheck` | **0** | `tsc -p tsconfig.typecheck.json`，输出中 **0 行 `error TS`** |
| `pnpm lint` | **0** | `eslint . --cache --cache-location node_modules/.cache/eslint/`，**0 条诊断**（无 warning / 无 error） |
| `pnpm test` | **1** | 见 §1.0（同一 frozen tree 上**三次采样**）；样本 #1（本任务）：`Test Files` **3 failed \| 145 passed (148)**；`Tests` **3 failed \| 1563 passed (1566)**；`Duration 475.98s`；样本 #3（控制方）：`Test Files` **12 failed \| 136 passed (148)**；`Tests` **19 failed \| 1547 passed (1566)**；`Duration 603.91s` |

- 原始输出：`.superpowers/sdd/2026-09-28-structured-judge-output/task-10-typecheck.out.log`、`task-10-lint.out.log`、`task-10-full-suite.log`（样本 #1）、`task-10-full-suite-sample3.log`（样本 #3；样本 #2 的原始输出不在仓内，见 §1.0 末条）。
- **全量测试的退出码是 1，不是绿**。三次采样中**已点名的**失败文件全部落在本计划未触碰的文件上，且**这些**文件逐个隔离复跑为绿（12/12，§1.3）；**样本 #3 的 19 条失败里没有一条是断言失败** —— 全部是 `Test timed out in 60000ms`（18 条）或 Windows 临时目录 EPERM（1 条）。
- 全量测试跑完后的 `git status --porcelain` 只有本记录这一个未跟踪文件 —— 即门禁数字对应的是**提交态**的字节。

**门禁口径（终审修复波改写：把「三条全绿」换成本环境可验证的形式）**

| 项 | 判据 |
|---|---|
| `pnpm typecheck` | **必须 exit 0**（0 行 `error TS`） |
| `pnpm lint` | **必须 exit 0**（0 条诊断） |
| `pnpm test` | **全部失败必须落在已知抖动集内**（`api/cases-crud`、`core/mirror-*`、`evaluator/orchestrator-*` —— R9 登记的既有抖动族）；**落在集合外的任何失败即阻塞**，不得当成抖动放过；且**已识别的失败文件必须逐个隔离复跑为绿** |

- **谁接受这条替换**：spec §10 第 2 条的「`pnpm test` 全绿」**在本机不可达** —— 本计划**开工前的基线**即
  `6 failed | 1529 passed (1535)`（`full-suite-clean.log`，R32）。该条**由控制方裁定 R52 替换接受**；
  **用户可在收口时复核**（口径、三次采样的原始日志与失败清单都在本记录与 SDD 目录里）。
- **本分支按此口径的实测**：`typecheck` / `lint` exit 0；三次采样中**已识别的**失败（样本 #1 的 3 条、
  样本 #3 的 12 条，以及样本 #2 那条已识别的 `orchestrator-rescore`）**全部落在抖动集内**，
  且**已识别的失败中没有一条是断言失败** —— **样本 #2 余下 6 个文件仍未识别**，本句不覆盖它们（限度见 §1.0）。
  终审修复波在**本轮代码改动之后**又重跑了这三条门禁，见 §1.4。

### 1.0 三次全量采样（同一 frozen tree）—— 失败集合漂移本身就是抖动判据

| 样本 | 谁跑的 | 结果 | 耗时 | 失败集合 |
|---|---|---|---|---|
| #1 | Task 10 实现者（`task-10-full-suite.log`） | `Test Files 3 failed \| 145 passed (148)`；`Tests 3 failed \| 1563 passed (1566)`；exit 1 | 475.98s | `api/src/cases-crud`、`core/src/mirror-ref`、`evaluator/src/orchestrator-execution-mode-b` |
| #2 | 控制方（**同一 frozen tree**：`38cbaf8` 之后、本任务两个 docs 提交之后，代码树逐字节未动） | `Test Files 7 failed \| 141 passed (148)`；`Tests 8 failed \| 1558 passed (1566)`；exit 1 | 540.71s | **7 个文件**，其中包含 `evaluator/src/orchestrator-rescore.test.ts`（`Test timed out in 60000ms`）—— **该文件不在样本 #1 的失败集合里** |
| #3 | 控制方（`pwsh-888`，**同一 frozen tree**，输出留档 `task-10-full-suite-sample3.log`） | `Test Files 12 failed \| 136 passed (148)`；`Tests 19 failed \| 1547 passed (1566)`；exit 1 | 603.91s | **12 个文件**：`api/src/cases-crud`；`core/src/mirror-{ensure-b, fetch, ref}`；`evaluator/src/orchestrator-{abort, auto-retry, execution-mode, execution-mode-b, rescore, retry, retry-b, timeout-isolation}` |

- **样本 #2 的完整失败清单不在本记录里**（控制方只取了尾部输出）⇒ 本记录对 #2 **只断言**「7 文件 / 8 用例，
  且其中包含一个样本 #1 没有的文件」，对余下 6 个文件不下任何结论。**这一限度到本记录收笔时仍未补上**
  （样本 #3 识别出的是它自己那 12 个文件，不能反推 #2 的 6 个）。
- **漂移是判据**：同一棵树、连续三次，失败集合**互不相同**（用例 `3 / 8 / 19`；文件 `3 / 7 / 12`，含互有出入的文件）
  ⇒ 负载/时序抖动，**不是**本计划引入的回归（控制方裁定 **R52**；样本 #3 到货后按 **R54** 复核，见下）。
- **样本 #3 的逐条归因（机械复算，非转述）**：**19 条里 18 条是 `Test timed out in 60000ms`，1 条是 Windows 临时目录 EPERM** ——
  `core/src/mirror-ensure-b.test.ts` 的夹具清理竞态（`Error: EPERM, Permission denied: \\?\C:\Users\…\AppData\Local\Temp\aieva…`，
  锚点 `src/testing/mirror-harness.ts:228`）。**19 条里 `AssertionError` 一条都没有**，与样本 #1、以及 #2 **那条已识别的**失败同形
  （60s 超时带 + Windows 临时目录占用）。该样本的原始日志在仓内，任何人可复算。
- **R54 硬检查（交集必须为空）——已执行，结论是空集**：**样本 #3 的 12 个失败文件 ∩ 本计划触碰的 17 个测试文件 = 空集** ✓
  （权威清单 `.superpowers/sdd/2026-09-28-structured-judge-output/plan-touched-files.txt`：`1346eb3..38cbaf8` 的 34 个文件里
  有 17 个测试文件）。这一步由**终审者与控制方各自程序化执行**；**终审修复波又复算一次**：同一份清单求交 = 空集，
  并另用 `git diff --name-only 1346eb3..944b2bc -- <12 个失败文件>` 逐个查过 —— **12/12 在本计划区间内一次都没被改过**。
  ⇒ R52 的判据①在「样本 #2 那 6 个未识别文件」这一限度上被补实：三个样本累计识别出的失败文件**全部**落在未触碰文件上。
- **样本 #2 里多出的那个失败文件已隔离复跑为绿**：`evaluator/src/orchestrator-rescore.test.ts`
  ⇒ 在包目录（`packages/server/evaluator`）跑 **`pnpm exec vitest run src/orchestrator-rescore.test.ts`** 得
  `Test Files 1 passed (1)`、`Tests 13 passed (13)`、`Duration 72.50s`、**exit 0**（控制方跑，同一棵冻结树）。
  （本行 2026-09-29 按实测**更正过命令形态**：原记的 `pnpm --filter … test -- <file>` 在本 harness 下跑不出
  「1 个文件」，见下条口径。）
- **命令形态口径（R53；终审修复波实测并更正本记录）**：`pnpm --filter <pkg> test -- <file>` 的位置过滤
  **不生效** —— `--` 会被原样透传给 vitest（命令回显 `vitest run --passWithNoTests "--" "<file>"`），
  结果是**整包被拉起来**（实测：在 `@aieval/core` 上跑出 22 个文件）；要**只跑一个文件**必须用
  **`pnpm exec vitest run <file>`（工作目录 = 对应包）**，判据是日志里出现 `Test Files 1 passed (1)`。
  本波那 8 次隔离复跑即用此形态（`final-fix-rerun-*.log`），形态可复现。
  **最有力的一点**：全量样本 #2 里该文件的用例「上一次的运行还没收尾（评分失败后还在自动重试的退避里）→ 拒绝重评…」
  是 `Test timed out in 60000ms`，而**隔离复跑里同一条用例只用了 8469ms** —— 同一棵树、同一条用例，
  负载下 60s 超时 vs 隔离 8.5s ⇒ **负载归因被钉死**。
- **样本 #3 的 12 个失败文件：隔离复跑 12/12 为绿**（终审修复波实跑 8 个 + 已有的 4 个，逐条见表 §1.3）
  ⇒ R52 判据③对样本 #3 已从「**已识别的**失败文件」推进到「**该样本全部 12 个失败文件**」：
  12 个已全部识别、无剩余，且全部隔离复跑为绿。
- **第三方独立佐证（终审者做的，不是本任务做的）**：终审者**不经全量负载**、把本计划触碰的 **17 个测试文件全部单独复跑**
  = **320/320 全绿、exit 0**（contracts 24/24、agents 95/95、evaluator 95/95 —— 其中 `orchestrator-judge-route` 9 条 66s、
  含本计划两条新 e2e 用例；ui 106/106）。这一项**没有仓内日志**（结果在终审者会话内），在本记录里属**转述**；
  它与 §1.3 的 12/12 是**两个方向**的同一结论：**改过的都绿、失败的全在没改过的文件里**。
- **仓内不可复算声明**：**样本 #2 的两组数字**与上一条第三方佐证，**原始输出都在控制方/终审者会话内**，
  本仓没有对应日志（本仓有的是样本 #1 的 `task-10-full-suite.log`、样本 #3 的 `task-10-full-suite-sample3.log`，
  以及 §1.3 那 12 条隔离复跑的 `task-10-rerun-*.log` / `final-fix-rerun-*.log`）
  ⇒ 这几项在本记录里属**转述**，不是本任务实测。

### 1.1 零新增依赖（spec §10 第 6 条 / §2 硬约束）

```bash
git diff --stat 1346eb3..HEAD -- package.json pnpm-lock.yaml
```

**输出为空（无任何行）** ⇒ 本计划一个依赖都没加、lockfile 一个字节没动。
（`1346eb3` 是本计划第一个提交 `51a9794` 的父提交；它本身是另一位写者的 `docs(notes)` 提交，
落在计划的 BASE `0523932` 之后 —— 区间选择理由见 ledger R10。）

本计划 15 个提交的总体足迹：`34 files changed, 1060 insertions(+), 40 deletions(-)`，
全部落在 `packages/server/{contracts,agents,evaluator}`、`packages/client/ui` 与两份 README 内 ——
`packages/server/api` 与 `packages/server/core` **整个包一字未动**。

### 1.2 现场抽验一条变异（Task 9 评审的 ⚠️ 转来的硬要求）

前九个任务的变异记录**全部**是各自报告里的声明，审查者只读 diff、无法验证。Task 10 因此**重做**了
Task 9 的那条「整行删维度」变异，全程原始输出留档。

| 项 | 值 |
|---|---|
| 抽验对象 | `packages/server/contracts/src/score.ts:144`（`JUDGE_OUTPUT_CONTRACT` 数组里 `maintainability` 那一行元素，**删掉一整行维度**） |
| 制造手法 | `[System.IO.File]::ReadAllText` → 按行索引剔除第 144 行 → `WriteAllText` + `UTF8Encoding($false)`（无 BOM，保持 LF）。删后行数 **151 → 150**（**按以 LF 切分后的数组元素计**：文件以 LF 结尾，末尾空元素使该计数比真实行数多 1；按 LF 计数与 `ReadAllLines` 都是 **150 → 149**），`git diff --stat` = `1 file changed, 1 deletion(-)` |
| 基线（删除前） | blob `9dd4b699410b46d6d7d13279d85348453c707475`（= `HEAD:packages/server/contracts/src/score.ts`）；sha256 `88BABF844672CB93439C39A2F558CA4860DF79E283B304A04EE620BA6B733E10` |
| 变异体 | blob `6a8929038aa57a4b448c3c3729267d623fd5bcd1`；sha256 `5343DB0AFC59D999F656F3621518E66400FBA2461F0D72AEC0311D03E43A50F0` |
| 命令 | `pnpm --filter @aieval/contracts test -- score.test`（实跑 `vitest run --passWithNoTests "--" "score.test"`） |
| 结果 | 退出码 **1**；`Test Files 1 failed \| 9 passed (10)`；`Tests 2 failed \| 132 passed (134)`；`src/score.test.ts (20 tests \| 2 failed)` —— **恰好 2 条红** |
| 红 ①（**被抽验的那条**） | `契约文本里每个维度字段各出现 DIMENSION_COUNT 次（整行删掉一个维度也会红）` → `AssertionError: 契约文本里 "key" 的出现次数: expected 4 to be 5`，锚点 `src/score.test.ts:284:52` |
| 红 ②（连带，如实登记） | `含五个维度的键名与 1–5 分的约束（生成侧与解析侧共用同一份字段名）` → `AssertionError: expected '…' to contain 'maintainability'`，锚点 `src/score.test.ts:74:37`（既有 `toContain(dimension.key)`） |
| **未红（关键）** | D5 的**集合判等**（`字段名与 JUDGE_OUTPUT_CONTRACT 文本里列的完全一致`）在变异体下**保持绿** —— 整行删维度后字段名集合仍是那 7 个 ⇒ R48 的前提**实测成立** |
| 复原 | `git hash-object` = `9dd4b699410b46d6d7d13279d85348453c707475`（**= HEAD blob**）、sha256 = `88BABF84…`（**= 基线**）、`git diff --stat` 输出为空、`git status --porcelain` 为空 |
| 交叉验证 | 本次变异体 blob `6a892903…` 与 Task 9 报告声明的变异体哈希 **逐字节相同** —— 该声明由此被独立复现 |
| 日志 | `task-10-spotcheck-mutant.log` / `.err.log` |

**其余变异一律标注「报告声明、Task 10 未复核」**（见 §三 的证据类型列）；本次抽验是唯一一条由 Task 10
自己在冻结树上重做的。附带记录一处调用细节：`pnpm ... test -- score.test` 在本 harness 下把 `--` 透传给了
vitest（`vitest run --passWithNoTests "--" "score.test"`），**位置过滤没有生效**，于是整个 contracts 包
（10 个文件 / 134 条）都跑了 —— 证据只多不少，但复现该抽验时要按实际命令读数字。

### 1.3 全量测试失败的逐条归因（既有抖动 + 隔离复跑结果）

**判据**（brief Step 1）：把失败清单逐条与「是否落在本计划改过的文件上」对照；落在未触碰文件上的失败，单文件复跑一次确认，然后如实写「既有抖动 + 复跑结果」。**下表是样本 #1 的三条**（样本 #2 的 `orchestrator-rescore` 见 §1.0，样本 #3 的 12 条见本节末）。

| # | 失败用例 | 文件（包） | 耗时 | 本计划是否触碰该文件 | 单文件复跑结果 |
|---|---|---|---|---|---|
| 1 | `createCase 接受不在最近 20 条候选里的真实 commit（候选不是白名单）` | `packages/server/api/src/cases-crud.test.ts`（`@aieval/api`） | 83705ms | **未触碰**（`packages/server/api` 整包未动） | **exit 0 · Test Files 1 passed · Tests 13/13** |
| 2 | `三条路都回 40 位具体 hash：指定分支 / 默认分支 / 指定 commit` | `packages/server/core/src/mirror-ref.test.ts`（`@aieval/core`） | 66670ms | **未触碰**（`packages/server/core` 整包未动） | **exit 0 · Test Files 1 passed · Tests 3/3** |
| 3 | `「开始」只跑未完成的行：已 judged 的行不重跑` | `packages/server/evaluator/src/orchestrator-execution-mode-b.test.ts`（`@aieval/evaluator`） | 66761ms | **未触碰**（该文件名不在 34 文件清单里） | **exit 0 · Test Files 1 passed · Tests 2/2** |

**结论（样本 #1 的三条）：既有抖动 + 复跑全绿（3/3 文件）**，不是本计划引入的红。依据有五条（第 4、5 条已随样本 #3 扩到三个采样）：

1. **三条失败全在未触碰文件上**（逐条用 `git diff --name-only 1346eb3..HEAD -- <path>` 验过 = 空）；
2. **耗时落在既有的 ~60–80s 超时带**（83.7s / 66.7s / 66.8s）——与 R9 记录的「148 文件并行下的负载抖动」同形；
3. **每个失败文件单独复跑都绿**：样本 #1 三条 = 上表末列（日志
   `task-10-rerun-{cases-crud,mirror-ref,exec-mode-b}.log`）。**这三条日志的证据类型 =「执行过 · 报告声明」**：
   日志本体在仓内、末行 `Test Files 1 passed (1)` 可查，但**里面没有 pnpm 的脚本回显**
   （对比：`pnpm run <script>` 形态会在 stderr 留下 `$ vitest run …` 回显），**无法从仓内确认当时跑的是哪一形态**；
   而本次实测已证明 `pnpm --filter <pkg> test -- <file>` 会把整包拉起来 ⇒ 故按「**命令形态与本次实测不同，
   不可作可复现形态**」标注（**不否认它们为绿**，只标清证据强度；正确形态见 §1.0 的命令形态口径）。
   样本 #2 多出的 `evaluator/orchestrator-rescore.test.ts` = 控制方隔离复跑 **13/13、72.50s、exit 0**（§1.0，同为转述）；
   本波那 8 条用 `pnpm exec vitest run <file>`（见本节末表），形态可复现；
4. **失败集合在采样间漂移**：历史记录是 `6 failed \| 1529 passed (1535)` 与 `5 failed`，本计划三次采样是
   **`3 / 8 / 19` 条**，且样本 #1 把历史上出过问题的 `orchestrator-rescore`
   换成了同包另一个文件 `orchestrator-execution-mode-b`；
5. **同一棵 frozen tree 上的第二次采样（控制方，§1.0 样本 #2）失败集合又不同**：
   `7 failed \| 141 passed (148)` / `8 failed \| 1558 passed (1566)`，其中含一个样本 #1 **没有**的失败文件
   `evaluator/src/orchestrator-rescore.test.ts`（`Test timed out in 60000ms`）⇒ 与「按文件漂移」的抖动特征一致
   （该文件被样本 #1 放过、被样本 #2 咬住，正说明是时序/负载而非代码）；**第三次采样（样本 #3）**又把集合扩到
   **12 个文件 / 19 条用例**，且这 12 个文件与样本 #1/#2 的集合**互有出入、同族**（`api/cases-crud` + `core/mirror-*` +
   `evaluator/orchestrator-*`，19 条全是超时/EPERM）——漂移幅度随后台负载增长，正是同一现象的第三个数据点（§1.0）。

**如实登记两处不比前序更弱、也不更强的边界**：

- 本任务**没有**做 BASE 对照实验（需要回退生产文件，风险大于收益，且 R37 的教训就是别用 `checkout`）；
  所以「失败是既有抖动而非本计划引入」的依据是**上面五条**，不是一次受控对照（与 R9 同一处境）。
- 计数不是全绿：`1535 → 1566` 条总数上升是本计划新增用例的净增量（spec §8 的新守卫），
  **失败数从 6 降到 3 不等于「问题变少了」**，只说明抖动这次咬到的文件更少；样本 #2 又回到 8 条、样本 #3 到了 19 条，
  进一步说明这几个数字**只反映当次负载**，不该被当作质量的横向对比（样本 #3 那 12 个文件**全部**是超时/EPERM、无一条断言失败）。

**样本 #3 的 12 个失败文件：逐条隔离复跑（R52 判据③的最后一块拼图）**

- 判据要求「**已识别的**失败文件单独复跑为绿」。样本 #3 把失败文件**全部**识别出来（12 个），于是本波把
  **当时还没有隔离证据的 8 个**逐个单文件复跑；其余 4 个此前已有证据（`cases-crud` / `mirror-ref` /
  `execution-mode-b` 见上表末列，`orchestrator-rescore` 见 §1.0）。
- **命令形态（重要，R53 的教训）**：本 harness 下 `pnpm --filter <pkg> test -- <file>` 的**位置过滤不生效**
  （`--` 被原样透传，会把整包拉起来 ⇒ 又回到负载抖动形状），单文件复跑要用
  **`pnpm exec vitest run <file>`（从包目录跑）**；判据是日志里出现 `Test Files 1 passed (1)`。
- **结果：12/12 全绿、exit 0**（8 条本波实跑 + 4 条此前已有证据）：

| 文件（样本 #3 的失败面） | 隔离复跑 | 日志 |
|---|---|---|
| `api/src/cases-crud.test.ts`（1 条 60s 超时） | **13/13 · 29.70s · exit 0**（T10 跑；证据类型见上注） | `task-10-rerun-cases-crud.log` |
| `core/src/mirror-ensure-b.test.ts`（1 条 Windows 临时目录 EPERM） | **3/3 · 9.86s · exit 0**（本波） | `final-fix-rerun-core-mirror-ensure-b.log` |
| `core/src/mirror-fetch.test.ts`（1 条 60s 超时） | **9/9 · 29.51s · exit 0**（本波） | `final-fix-rerun-core-mirror-fetch.log` |
| `core/src/mirror-ref.test.ts`（2 条 60s 超时） | **3/3 · 42.91s · exit 0**（T10 跑；证据类型见上注） | `task-10-rerun-mirror-ref.log` |
| `evaluator/src/orchestrator-abort.test.ts`（3 条 60s 超时） | **9/9 · 47.79s · exit 0**（本波） | `final-fix-rerun-evaluator-orchestrator-abort.log` |
| `evaluator/src/orchestrator-auto-retry.test.ts`（2 条 60s 超时） | **7/7 · 38.67s · exit 0**（本波） | `final-fix-rerun-evaluator-orchestrator-auto-retry.log` |
| `evaluator/src/orchestrator-execution-mode.test.ts`（2 条 60s 超时） | **3/3 · 28.37s · exit 0**（本波） | `final-fix-rerun-evaluator-orchestrator-execution-mode.log` |
| `evaluator/src/orchestrator-execution-mode-b.test.ts`（2 条 60s 超时） | **2/2 · 25.45s · exit 0**（T10 跑；证据类型见上注） | `task-10-rerun-exec-mode-b.log` |
| `evaluator/src/orchestrator-rescore.test.ts`（2 条 60s 超时） | **13/13 · 72.50s · exit 0**（控制方跑；**本仓无日志 ⇒ 转述**） | —（见 §1.0） |
| `evaluator/src/orchestrator-retry.test.ts`（1 条 60s 超时） | **4/4 · 25.10s · exit 0**（本波） | `final-fix-rerun-evaluator-orchestrator-retry.log` |
| `evaluator/src/orchestrator-retry-b.test.ts`（1 条 60s 超时） | **4/4 · 25.25s · exit 0**（本波） | `final-fix-rerun-evaluator-orchestrator-retry-b.log` |
| `evaluator/src/orchestrator-timeout-isolation.test.ts`（1 条 60s 超时） | **5/5 · 34.97s · exit 0**（本波） | `final-fix-rerun-evaluator-orchestrator-timeout-isolation.log` |

- **最有力的一点**：这 12 个文件在全量负载下是 60s 超时 / EPERM，隔离下**最长 72.5s 内全绿** ⇒ 与「负载抖动」一致，
  而不是断言缺陷（样本 #3 的 19 条里 `AssertionError` 为 **0**）。
- **如实登记的限度**：隔离复跑证明的是「**载荷去掉后为绿**」，不是「这些文件在任何负载下都绿」；本机无法做
  BASE 对照实验（同 §1.3 前文那条限度）⇒ 「不是本计划引入的回归」的完整依据仍是**三条合起来**：
  R54 交集为空 + 12/12 未被本计划改过 + 失败面全是超时/EPERM。

### 1.4 终审修复波的门禁重跑与 C3/C4 变异（2026-09-29，最后一轮代码改动**之后**）

> §一 的数字属于 Task 10 那一轮（代码树自 `38cbaf8` 冻结）。全分支终审判 `With fixes` 之后，修复波又动了
> **4 个代码/测试文件**（C1–C4）⇒ 门禁必须在**动完之后**再跑一遍，否则本记录引用的就是被自己推翻的数字。
> 本轮原始输出（全部在 SDD 目录，本波自跑）：`final-fix-typecheck.*`、`final-fix-lint.*`、
> `final-fix-agents-suite.*`、`final-fix-contracts-suite.*`、`final-fix-c3-mutant-*.log`、`final-fix-c4-mutant.{out,err}.log`。

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | **exit 0**；stdout 空、stderr 只有一行命令回显 ⇒ **0 行 `error TS`** |
| `pnpm lint` | **exit 0**；同上 ⇒ **0 条诊断** |
| `pnpm --filter @aieval/agents test`（受影响包） | **exit 0** · `Test Files 19 passed (19)` · `Tests 230 passed (230)` |
| `pnpm --filter @aieval/contracts test`（受影响包） | **exit 0** · `Test Files 10 passed (10)` · `Tests 135 passed (135)`（134 → 135 = C4 新增的那条冻结守卫） |
| 全量 `pnpm test` | **按 §一 的口径不再重跑**：本波只动了两个受影响包内的 4 个文件，本机全量有既有抖动且口径已由 R52 替换；重跑的判据是**受影响包全绿**（上两行） |

**C3 的变异：把「SDK 压根没被调用」这一形状造出来**（适配器改成在 `startThread` 之后、`runStreamed` 之前抛错
⇒ `recorder.turnOptions` 停在 `null`，观测点丢失）：

| 步骤 | 结果 |
|---|---|
| 变异体 + **保留**新守卫 | codex 文件 `17 tests \| 12 failed`；**目标用例红** = `AssertionError: expected null not to be null`，锚点 `index.test.ts:120:29`（`final-fix-c3-mutant-guard-on.{out,err}.log`） |
| 变异体 + **删掉**新守卫（3 行注释 + 1 行断言） | 同一条用例翻成 **`✓`（绿）**：文件 `12 failed → 11 failed`、套件 `13 failed → 12 failed` ⇒ **假绿被复现**，证明那一行**承重**（`final-fix-c3-mutant-guard-off.{out,err}.log`） |
| 变异体改成**无条件**抛错（排除「为哪条用例量身定制」的质疑） | 目标用例同样红在同一锚点 `:120:29`（`final-fix-c3-mutant-unconditional.{out,err}.log`） |
| 复原 | 3 个文件逐个 sha256 与变异前**逐字节相同**（脚本打印 `sha_equal=True`），`git diff --stat` 只剩本波那 4 个代码文件 |

- **如实登记的限度**：那个变异体是**替身**（本仓没有「适配器在 `runStreamed` 之前失败」的真实回归可造），
  它的爆炸半径是 17 条 codex 用例里的 12 条（条件写成 `input.outputSchema === undefined`，而多数用例都不带 schema）
  ⇒ 「谁红谁绿」必须按**用例名**读，不能只读总数；本轮正是按名字读的（`× …没给 outputSchema…` → `✓` 同一条）。

**C4 的变异：冻结守卫是不是承重的** ⇒ 去掉 `Object.freeze` 后 `pnpm --filter @aieval/contracts test`
= `Tests 1 failed | 134 passed (135)`，**唯一红的就是**「顶层被冻结（共享全局值：谁都不能在运行期往上加一格或改一格）」
（`final-fix-c4-mutant.{out,err}.log`）⇒ 该断言**单独**钉住那层冻结，不是搭便车。

**C1 / C2（纯注释，无变异）**：改注释不改变可执行行为，构造不出「要拦的缺陷」、也没有可复跑的红
⇒ 替代验证 = **事实来源逐条核对**：`@openai/codex-sdk/dist/index.d.ts:169-174`（`TurnOptions` 整段，
`outputSchema` 在 `:170-171`、`signal` 在 `:172-173`）与 `dist/index.js:5-12`（`createOutputSchemaFile`：
`undefined` 直接返回、非 plain object 抛 `outputSchema must be a plain JSON object`）、
`:29-31`（`isJsonObject`：`null` 被拒）、`:55`（该校验在 `runStreamedInternal` 生成器的第一段、**早于 CLI 启动**；
细节：因而抛错是在**首次迭代**事件流时冒出来，由 `turn.ts:297` 的 catch 归成 `AGENT_FAILED`
—— 仍是「响亮」，不是「静默透传」）。

---

## 二、任务清单与提交

| 任务 | 状态 | 提交（短哈希） | 评审结论 |
|---|---|---|---|
| 契约（spec） | 已入库 | `658482f` | —（设计文档） |
| 计划（plan） | 已入库 | `0523932` | —（实施计划，ledger 的 BASE） |
| T1 contracts：schema 字面量 + 记账字段 + 一致性守卫 | **complete** | `51a9794` + 修复轮 `e231f15` | Approved；Critical 0 / Important 0 / Minor 5；⚠️ 4 条逐条结掉 |
| T2 agents：中性 `outputSchema` 入参 + `capability.structuredOutput` | **complete** | `3a2a84c` | Approved；Critical 0 / Important 0 / Minor 4 |
| T3 claude-code：`outputFormat` 落点 + `structured_output` 出口 + 重试用尽归因 | **complete** | `a704d59` + `d230318` + `dbbbe53` | 一轮 **Needs fixes**（1 Important：恒真 WARN 守卫 + 4 Minor）→ 修复轮 1、2 → scoped re-review「All findings addressed, no new Critical/Important breakage」 |
| T4 codex：`runStreamed` 按需带 `outputSchema` | **complete** | `6c80b04` | Approved；Critical 0 / Important 0 / Minor 4 |
| T5 dsh：纵深防御守卫（不静默忽略） | **complete** | `58d9c42` | Approved；Critical 0 / Important 0 / Minor 3 |
| T6 evaluator：转发 + 记账 + `finalizeScore` 必填 | **complete** | `505b061` | Approved；Critical 0 / Important 0 / Minor 4 |
| T7 编排层：按能力带 schema + 有痕降级 | **complete** | `4a2c0cd` | Approved；Critical 0 / Important 0 / Minor 4 |
| T8 界面：评分详情「输出约束」一格 | **complete** | `e88d05d` | Approved；Critical 0 / Important 0 / Minor 6 |
| T9 deferred 收口批次（12 条） | **complete** | `423e275` + `86d763c` + `9a6f38f` + 修复轮 `38cbaf8` | 一轮 **Needs fixes**（2 Important：注释自相矛盾 / 授权清单缺口；4 Minor）→ 修复轮 1 → re-review「All findings addressed」 |
| T10 冻结门禁 + 变异台账 + spec 回写 + 完成记录 | **修复轮 2**（首轮 Needs fixes → 修复轮 1 的 F1/F2/m3–m8/R52 全 ADDRESSED，但修复轮自身引入 N1 → 修复轮 2） | `fe8fe18`（本记录 + spec 回写，2 files +442/−0）· `a121804`（回填本任务哈希，1 file +1/−1）· `4100cf5`（修复轮 1，2 files +56/−20）· `01336f6`（补判据③证据，1 file +14/−3）· 修复轮 2 提交（本次，哈希不自指） | 首轮 **Needs fixes**：2 Important（§1.2 状态行低估待确认范围；§九把 spec §10 第 2 条判为「已满足」）+ 6 Minor；修复轮 1 → **ADDRESSED，但引入 N1**（三处汇总句说满：样本 #2 的 7 个失败文件里只识别出 1 个，却写了「全部/每个」）⇒ 修复轮 2 按「已识别」口径收窄。详见 `task-10-report.md` §9/§10 |

**任务账与 git 的核对**：上表 15 个实现提交逐个用 `git log -1 --format='%h %ad %s'` 验过**确实存在**，
且 `git log --oneline 1346eb3..38cbaf8` 的 **15 行**与上表**逐一对应、无多无少**；
`1346eb3..HEAD` 截至 `01336f6` 为 **19 行**（= 那 15 个实现提交 + 表末 Task 10 自身的 4 个提交）；
**该计数随提交增长会变**，故这里锚到**具体提交**而不是 `HEAD`。

**全分支终审与修复波（2026-09-29）**：终审区间 `1346eb3..944b2bc`（20 commits / 36 files / 1561 insertions / 40 deletions）结论 **`With fixes`** ——
**无 Critical、无需改代码的 Important**；唯一阻塞项是 **I1（docs 回写）**，另有 3 条 Minor（M1 盲区措辞 /
M2 spec §5.3 落点未回写 / M3 冒烟第 1 项判据缺一支）与 4 条一行级代码/注释修法（C1–C4，末条为硬化建议）。
本波**全部结掉**：**修复波分三个提交**（下表）；**其后另有一次 docs 微修**（见本段末）：

- **代码 `3dfea8d`**（4 files, +33/−9）：C1 codex 注释行号 `172-174 → 169-174`、C2 codex `null` 的理由改写、
  C3 codex 用例补 `not.toBeNull()`、C4 `JUDGE_OUTPUT_JSON_SCHEMA` 冻结 + `Object.isFrozen` 守卫。
  门禁在该提交**之后**重跑（§1.4）：`typecheck` / `lint` / 两个受影响包套件全部 exit 0，C3/C4 各带变异证据。
- **docs `2f9ea15`**（2 files）：I1（样本 #3、交集检查、第三方佐证、门禁口径改写、12/12 隔离复跑）+ M1 + M2 + M3。
- **docs `6dd29d6`**（1 file, +28/−10）：按控制方对「§1.0 那行复跑命令」的裁决做的更正 —— 把 rescore 的
  复跑命令换成本 harness 下**真正只跑一个文件**的形态（`pnpm exec vitest run <file>`，包目录为工作目录），
  紧邻处补「命令形态口径」，并给 T10 那三条 `task-10-rerun-*.log` 标注证据类型
  「执行过 · 报告声明（当时日志无脚本回显，无法从仓内确认所跑形态）」（§1.0 / §1.3）。

另有评审后的 docs 微修提交 `d611fdd`（R57：三处汇总句收窄到「已识别的失败」+ 一处悬空日志指针），**不属修复波**（见报告 §7）。

截至代码提交的区间足迹：`1346eb3..3dfea8d` = **21 commits / 36 files / 1585 insertions / 40 deletions**
（差值 = 本波那 4 个代码文件）。逐条「改了什么 / 文件:行 / 验证证据」见
`.superpowers/sdd/2026-09-28-structured-judge-output/final-fix-report.md`。

---

## 三、变异验证台账

**证据类型只有两种，逐条标注，不许混为一谈**：

- **`执行过（有日志）`** —— 实现者真的把缺陷造出来、看见了红、并按 `git hash-object` 复原。**除 #34 外，
  这些日志与哈希全部来自各任务报告，Task 10 未复核**；写在这里是「报告声明」的汇总，不是 Task 10 的实测。
- **`按断言可证伪性判定`** —— 审查者只读 diff、未复跑，凭断言内容推出「制造该缺陷必然红在哪一条」。本计划的评审里有相当一部分属于这一类。

表内 `✔︎T10` 标记 = Task 10 现场重做过（唯一一条，见 §1.2）。

| # | 守卫名 | 怎么制造的缺陷 | 哪条用例红了 | 复原证据（`git hash-object`） | 证据类型 |
|---|---|---|---|---|---|
| 1 | T1 枚举与 `DIMENSIONS` 逐项按序相等 | `enum: DIMENSIONS.map(…)` → `DIMENSIONS.slice(0, DIMENSION_COUNT-1).map(…)` | 「维度 key 的枚举与 DIMENSIONS 逐项、按序相等」+ 连带「合格样例过 schema…」= 2 failed / 18 | 变异体 `7b31fef2…` → 复原 `6369fb20e2859e5779082ee37abf128df8cce92a`（+ sha256 `A19981EF…`） | 执行过（`mutation1.log`）·报告声明，T10 未复核 |
| 2 | T1 `ScoreResultSchema.structuredOutput` 默认值 | 去掉 `.default(false)` | 「老记录（没有这一格）读盘后补 false」红在 `ZodError: Required` + 2 条既有连带 = 3 failed / 18 | 变异体 `2a0141eb…` → 复原 `6369fb20…` | 执行过（`mutation2.log`）·报告声明，T10 未复核 |
| 3 | T1 D5 字段名集合判等（文本侧） | 契约文本删 `'     "verdict": "一句话中文总评"',` 那一行元素 | 当时的 `every(...)` 断言红（`expected false to be true`）+ 既有「不要输出 JSON 以外的任何文字」连带 | 基线 `7ee0b1220b7c33041ae2ce307ade1f7995a5943e` → 变异体 `96a994c828aba002aba5aadfa03352050fc63743` → 复原 = 基线 | 执行过（`mutation3.log`）·报告声明，T10 未复核 |
| 4 | T1 D5 反向（schema 侧） | 删 `verdict: { type: 'string' },` | 3 failed：等式断言红（7 vs 6）+ 两条既有守卫连带 | 变异体 `17253220…` → 复原 `7ee0b122…` | 执行过（报告 §F4，无独立日志）·报告声明，T10 未复核 |
| 5 | T2 三家显式声明能力（必填格） | 删掉 `dsh/index.ts` 的注释 2 行 + `structuredOutput: false` | ① `pnpm typecheck` **exit 2**（TS2741）② `registry.test` 2 failed / 11：「三家与 spec §5.6.2 的表逐格一致」「每家都显式声明 structuredOutput」 | 变异体 `bf72b975…` → 复原 `aac35e68…` | 执行过（报告 §4）·报告声明，T10 未复核 |
| 6 | T2 能力开集（审查者补充推演） | 把 dsh 那格翻成 `true` / 删格 | 翻 `true` ⇒ 红在**两张独立的网**：`registry.test.ts:69`（夹具 `:42` 是 false）与 `:115`（过滤后 3 家 ≠ `['claude-code','codex']`）；删格 ⇒ typecheck TS2741 + `:106` | —（未执行） | **按断言可证伪性判定**（审查者只读 diff，未复跑） |
| 7 | T3 claude 出口优先级（A） | `projectResult` 先看 `text` 且空串也算答复 | 2 failed / 29：「structured_output 存在 ⇒ finalText 是它的序列化（即使 result 是空串）」（`expected '' to be …`）＋「两个来源不一致 ⇒ 落 WARN 且以 structured_output 为准」 | 变异体 `863ce75e…` → 复原 `faa726a21c49437d678e4cc9715d3aa115baf2f1` | 执行过（报告 §4）·报告声明，T10 未复核 |
| 8 | T3 出口优先级（A1，自加变体） | 反过来但**保留**「空串不算答复」 | 1 failed / 29：**只有**「两个来源不一致 ⇒ 落 WARN」那条红，第 1 条反而绿 ⇒ 证明第 1 条独占钉「`result` 为空串时结构化仍生效」 | 变异体 `c5700b4a…` → 复原 `faa726a2…` | 执行过（报告 §4）·报告声明，T10 未复核 |
| 9 | T3 claude `outputFormat` 落点（B） | 删掉 `index.ts:157-160` 的注释 + 三行展开 | 1 failed / 18：「给了 outputSchema ⇒ options.outputFormat 是 json_schema 且 schema 原样带上」 | 变异体 `1cf4597b…`（= 该文件 BASE 哈希）→ 复原 `3021b336fded1095db643a2e0641f82f82cbe569` | 执行过（报告 §4）·报告声明，T10 未复核 |
| 10 | T3 出口三态：显式 `null`（A′） | 判据还原成 `structured !== undefined` | 1 failed：`expected 'null' to be '{"verdict":"还行"}'`（只红 null 那条） | 变异体 `179c45fc…` → 复原 `f9d80a26f60b0770091c14e1c023baa63a3d7e06` | 执行过（报告 §10.3）·报告声明，T10 未复核 |
| 11 | T3 出口三态：JSON 字符串形态（B′） | 判据还原成无条件 `safeStringify` | 1 failed：`expected '"{\"verdict\":\"还行\"}"' to be '{"verdict":"还行"}'`（只红字符串那条） | 变异体 `01e62f9f…` → 复原 `f9d80a26…` | 执行过（报告 §10.3）·报告声明，T10 未复核 |
| 12 | T3「两源不一致 ⇒ 落一条 WARN」（真守卫化） | **改前**先复现：删掉不一致 WARN 整段 | **M0（改前）**：删掉整段仍 `31 passed` ⇒ 假守卫成立（审查者结论被独立复现）；**M1（改后）**：同一次删除 ⇒ 1 failed / 32，唯一红 = `events.test.ts:445` | M0 变异体 `f0779ec1…` → 复原 `f9d80a26…`；M1 变异体 `e26b28e2…` → 复原 `4db52507149a61fbd68baf027365dedcb8d7c671` | 执行过（报告 §11.3）·报告声明，T10 未复核 |
| 13 | T3 空串不算答复（R24） | 去掉 `&& structured !== ''` | 1 failed / 32：`expected '' to be '{"verdict":"还行"}'`（只红空串那条） | 变异体 `a1bf3f4f…` → 复原 `4db52507…` | 执行过（报告 §11.3）·报告声明，T10 未复核 |
| 14 | T4 codex `outputSchema` 展开 | 删展开 → `runStreamed(prompt, { signal })` | 1 failed / 17：「给了 outputSchema ⇒ runStreamed 第二参带上它」（另 16 条绿） | 变异体 `48e16d14…` → 复原 `013676d8e26db0418c7cde1236cf4bdabb536f56` | 执行过（报告 §3）·报告声明，T10 未复核 |
| 15 | T4 codex 入口侧 `null` 口径 | 退回只判 `=== undefined` | 1 failed / 17：「`outputSchema` 显式为 `null` ⇒ 与「没给」同义」。**该变异体 `pnpm typecheck` exit 0（不红）** ⇒ 这道门只能靠用例（R28） | 变异体 `29ad81ef…` → 复原 `013676d8…` | 执行过（报告 §3）·报告声明，T10 未复核 |
| 16 | T5 dsh 纵深防御守卫 | 整段删掉守卫（回到 HEAD 原文） | 1 failed / 15：「收到 outputSchema ⇒ 报中文错且**不构造运行时**」 | 变异体 `aac35e68…`（= `HEAD:dsh/index.ts` blob）→ 复原 `01835c71d6d7b8dc87642a16460b6dc3bc0dc219` | 执行过（报告 §3）·报告声明，T10 未复核 |
| 17 | T5 dsh 守卫 `null` 口径 | `!== undefined && !== null` → `!== undefined` | 1 failed / 15：「outputSchema 显式为 null ⇒ 与「没给」同义：不报错，正常跑完」 | 变异体 `32457237…` → 复原 `01835c71…` | 执行过（报告 §3）·报告声明，T10 未复核 |
| 18 | T6 `judge.ts` 记账格（恒 false → `input.structuredOutput`） | 写死 `false` | **2 failed / 54**：`judge.test.ts`「structuredOutput 原样进结果」＋`judge-agent.test.ts`「带 outputSchema ⇒ 原样传给适配器，且记 structuredOutput=true」 | 变异体 `7baea332…` → 复原 `2d3dd4750cad535ee92839a014cb36eb3b879a72` | 执行过（`task-6-mutation1.log`）·报告声明，T10 未复核 |
| 19 | T6 `judge-agent.ts` 记账 | 写死 `false` | 1 failed / 16：「带 outputSchema ⇒ 原样传给适配器，且 ScoreResult 记 structuredOutput=true」（转发那半仍绿） | 变异体 `d9e6edb1…` → 复原 `5524736e45aaaeca419cd990c1cff31e0393148d` | 执行过（`task-6-mutation2.log`）·报告声明，T10 未复核 |
| 20 | T6 文本通路传 `false` | 那一处改成 `true` | 1 failed / 38：「文本通路本期不开 schema：structuredOutput 记 false」 | 变异体 `437e6277…` → 复原 `2d3dd475…` | 执行过（`task-6-mutation3.log`）·报告声明，T10 未复核 |
| 21 | T6 契约 `.default(false)`（自加） | 去掉 `.default(false)` | `run-store` 1 failed / 26：「磁盘上已有的评分（score 里没有 structuredOutput）读盘后是 false」（读入口抛 `INTERNAL`） | 变异体 `a32fc742…` → 复原 `7ee0b122…` | 执行过（`task-6-mutation4-contract-default.log`）·报告声明，T10 未复核 |
| 22 | T6/T7 记账链（审查者独立推导） | 把 `judge.ts:237` 写死 `false` | 审查者独立推导 = **恰好 2 条**（`judge.test.ts:275`、`judge-agent.test.ts:182`），与实现者变异 ① 的 2 红吻合 | —（未执行） | **按断言可证伪性判定**（审查者只读 diff，未复跑） |
| 23 | T7 编排层能力判断 | 写死 `true`（对 dsh 也带 schema） | 1 failed / 12：**dsh 那条** `:186` `expected { type:'object', … } to be undefined`；claude-code 那条照旧绿 | 变异体 `1eb75b48…` → 复原 `14555f99312845a1a29c66c30ba2ea55a0868064` | 执行过（`task-7-mutation1.log`）·报告声明，T10 未复核 |
| 24 | T7 降级日志 + 按需带 schema（整段接线） | 删掉 20 行接线（副证据：`git diff --stat` 从 21 insertions 掉到 **1**，只剩 import） | 2 failed / 13：`:168` `expected undefined to deeply equal {…}`、`:193`「降级日志恰好一条」`expected [] to have a length of 1`。**注意**：dsh 的 `structuredOutput === false` 断言照旧绿（恒 false 正是开工前的形状）—— 抓住它的是降级日志那条 | 变异体 `ad02ee83…` → 复原 `14555f99…` | 执行过（`task-7-mutation2.log`）·报告声明，T10 未复核 |
| 25 | T7「不许传 null」（自加） | 三元另一支给 `{ outputSchema: null }` | 1 failed / 12：`:186` `expected null to be undefined`；即便它不存在，`:187` 的记账（`!== undefined`）也会把它记成 `true` ⇒ 双重红 | 变异体 `ef775878…` → 复原 `14555f99…` | 执行过（`task-7-mutation3-null.log`）·报告声明，T10 未复核 |
| 26 | T7「键在、值为 `undefined`」的**不可观测性**（自加，**预期绿**） | 三元另一支给 `{ outputSchema: undefined }` | **13/13 全绿（exit 0）** —— `judge-agent.ts:167` 的条件展开把它折叠成「没传」⇒ 本仓观测点分不出「键不存在」，故 R40 裁决不为它扩夹具 | 变异体 `7732e2f8…` → 复原 `14555f99…` | 执行过（`task-7-mutation4-undefined-cousin.log`）·报告声明，T10 未复核 |
| 27 | T7 R16「tsc 看不见 mock 字面量」的假绿复现 | 把 `orchestrator-live.test.ts` 逐字写回 T6 版（缺 `capability.structuredOutput` 格） | `pnpm typecheck` **exit 0 / 0 行 `error TS`**；该文件测试 **5 passed** ⇒ 缺格不产生任何红，R16 是**预防性**的（R42 修正口径） | 写回 blob `d41d1e304ad34b5ffa20040a79521fd6ae0ff43b` → 逐字节还原 | 执行过（`task-7-r16-false-green.log`）·报告声明，T10 未复核 |
| 28 | T8「输出约束」三元 | 三元条件反过来 | 3 failed / 9（两条新用例 + 既有逐字节断言，见 §5.1） | 变异体 `1c7415d4…` → 复原 blob `7c5b9e7b…` / sha256 `3996F75A…` | 执行过（`task-8-mutation1.log`）·**审查者按指令未复跑** |
| 29 | T8「`false` 不带告警样式」负向断言（自加） | 评分者那一行 `type="secondary"` → `type="danger"` | 1 failed / 9：**唯一红** = 该负向断言 | 变异体 `7e95e1a9…` → 复原 `7c5b9e7b…` | 执行过（`task-8-mutation2-style.log`）·**审查者按指令未复跑** |
| 30 | T9 claude 入口侧 `null` 口径（R27） | 判据退回只判 `=== undefined` | 1 failed / 18：「outputSchema 显式为 null ⇒ …」`index.test.ts:501` | 变异体 `de269398…` → 复原 `5fe6250fae55151555e05d5641354f67587ef2f7` | 执行过（报告 §一.1）·报告声明，T10 未复核 |
| 31 | T9 evaluator 记账 `null` 口径（R39b） | 退回 `!== undefined` | 1 failed / 16：`judge-agent.test.ts:210` `expected true to be false` | 变异体 `569961dc…` → 复原 `2050698e98a0e5cccfe8f23c62168f0d13e7c4fd` | 执行过（报告 §一.2）·报告声明，T10 未复核 |
| 32 | T9 evaluator 转发 `null` 口径（额外） | 退回 `=== undefined ? {} : {…}` | 1 failed：`judge-agent.test.ts:208` `expected null to be undefined` | 变异体 `b3c321bf…` → 复原 `2050698e…` | 执行过（报告 §一.2）·报告声明，T10 未复核 |
| 33 | T9 D5 差分断言（R14a） | 契约文本删 `"verdict": …` 行元素 | 红在**差分断言** `:263` `expected [ 'verdict' ] to deeply equal []`（+ 既有 `toContain('verdict')` 连带） | 变异体 `3f254866…` → 复原 `9dd4b699410b46d6d7d13279d85348453c707475` | 执行过（报告 §一.4）·报告声明，T10 未复核 |
| 34 | T9 D5 出现次数断言（R14b） | 契约文本删**整行** `maintainability` 维度 | 红在**出现次数断言** `:284` `expected 4 to be 5`（+ 既有 `:74` 连带）；**D5 集合判等保持绿** | 变异体 `6a892903…` → 复原 `9dd4b699…` | **执行过 + T10 现场重做**（`task-10-spotcheck-mutant.log`）✔︎T10 |
| 35 | T9 界面负向断言的**误红面**（R49） | 给视图**别处**加一个合法告警样式（总评标题 `type="danger"`） | 真实用例 **9/9 绿**（exit 0）；同变异体下探针实测**旧口径会命中** `SPAN.ant-typography-danger`（即旧口径会误红）、新口径 `SCAN-NEW-LINE = null` | 变异体 `d521bd66…` → 复原 `7c5b9e7b…` | 执行过（报告 §一.5）·报告声明，T10 未复核 |
| 36 | T9 界面负向断言的**拦截面** | 给**评分者那一行本身**加告警类 | 1 failed：`expected 'ant-typography ant-typography-danger …' not to match /danger\|warning/`（`:148`）。附带：`:147` 的 `querySelector` **不红**（元素查不到自身 class）⇒ 实证两条判据不重复 | 变异体 `7e95e1a9…` → 复原 `7c5b9e7b…` | 执行过（报告 §一.5）·报告声明，T10 未复核 |
| 37 | T9 D5 集合判等**看不见整行删除**（审查者具名复核） | 删整行维度 | 审查者独立确认：`score.test.ts:74` 的 `toContain(dimension.key)` 在整行删除时**必红**（每个维度 key 在契约文本里只在自己那行出现一次）⇒ R48 口径成立 | —（T9 已执行；审查者未复跑） | **按断言可证伪性判定**（审查者只读 diff，未复跑）—— **已被 T10 实测证实**（见 #34） |
| 38 | T9 R50 等价性（审查者具名复核） | 把 `every(...)` 换成两条差分断言 | 审查者确认**真等价**：两个差分组齐、下界与集合判等是 context 行原样保留 | —（未执行） | **按断言可证伪性判定**（审查者只读 diff，未复跑） |
| 39 | T9 R49 收窄必要性（审查者具名复核） | 按 brief 字面收窄到「父元素」 | 审查者确认：该行 span 的 parent **就是根 `Flex`**（children 恰好 5）⇒ 按字面改等于**没收窄**。T10 现场读码复核：`score-detail-view.test.tsx:136` 取的 `scorerLine` 就是 `getByText` 命中的那个 span，两条判据在 `:147-148` | —（未执行） | **按断言可证伪性判定**（审查者只读 diff，未复跑） |
| 40 | T9 注释口径（修复轮 F1） | —（纯注释，无变异） | 无 | 无 | **按断言可证伪性判定 —— 不适用（无可执行缺陷）**：改注释不改变可执行行为，构造不出「该守卫要拦的缺陷」、也没有可复跑的红。替代验证 = 逐条对代码行锚点核对事实 + 受影响包过滤测试/typecheck/lint 全绿（审查者明确背书，不算缺交付） |

**台账的两条诚实说明**：

1. **除 #6 / #22 / #37 / #38 / #39 / #40 这六行（「按断言可证伪性判定」）之外，本表各行全部来自各任务报告的声明**，
   Task 10 只对 **#34 一条**做了现场重做（`✔︎T10`）。
   凡未标 `✔︎T10` 的行，其「红在哪条用例 / 复原哈希」都无法从 diff 验证 —— 这正是 Task 9 评审把
   「现场抽验一条」转为硬要求的原因。抽验结果**支持**报告声明的口径（变异体哈希逐字节相同、红点与 R48 一致）。
2. **#6 / #22 / #37 / #38 / #39 / #40 是「按断言可证伪性判定」**（其中 #40 属该类里「**不适用**」的一格：
   无可执行缺陷、没有可复跑的红），其中 #37 / #38 / #39 已被 T10 的现场实测或读码复核证实
   （#37 见 §1.2：#34 的两次红与「集合判等保持绿」与审查者推演逐条一致）。

---

## 四、deferred / parked 清单

ledger 里所有 `Ruling:` 与 `Task N: minor (deferred)` 条目，按「**已在本计划收口**」与
「**转交终审与人工**」分两张表。**转交不等于丢弃** —— 每条都有裁决记录。
（Ruling 覆盖度自查：R1–R51 共 51 条 = 44 条已收口 + 7 条转交，无遗漏；其中 R14/R19/R39/R43 是被拆成
子条的复合裁决，各子条分别落在两张表里。**该自查的依据是 ledger**
`.superpowers/sdd/2026-09-28-structured-judge-output/progress.md` —— 它是 **gitignored、不进提交**的台账原始档，
所以「无遗漏」这句只能对**那份未跟踪文件**负责，不能从本提交的 diff 反查。
**终审与修复波期间新增的 R52–R55 不在这次自查的范围内**，见 §4.3 末条。）

### 4.1 已在本计划收口

#### 4.1.1 Ruling 条目（44 条）

| Ruling | 一句话 | 怎么收口的 |
|---|---|---|
| R1 | 不建 worktree、就地执行 | 全计划 15 个提交都在 `feat/features` 上就地完成 |
| R3 | T1 漏了 contracts 的 barrel 出口 | T1 补 `index.ts` 出口名单 + `index.test.ts` 断言（`51a9794`） |
| R4 | 夹具新增**观测格**不算「改既有用例」 | T4 加 `turnOptions`、T6 加 `outputSchema` 记录格：只增观测、不动既有断言 |
| R5 | 提交命令以仓规（pathspec）为准 | 15 个提交一律 pathspec；控制方逐个 `git show --stat` 复核文件数 |
| R6 | T2 的用例要 `listAgentProviders()`，缺就补 import | 只补 import（`3a2a84c`） |
| R7 | 预检「T1 两处 `finalizeScore` 调用补必填参数」不成立 | 更正为 T6 的活；T6 落地（`505b061`） |
| R8 | 接受 `judge.ts:225-227` 越界补恒 `false` 格 | T6 换成 `input.structuredOutput`（`505b061`），并列为 T6 必核项 + 变异 ① |
| R10 | 评审包区间避开他人提交 | `review-1346eb3..e231f15.diff` 等区间均从「计划的第一个提交之父」起算 |
| R11 | D5 缺口成立 ⇒ 进修复轮 1 | `e231f15` 补文本侧集合判等 + 两条防假绿前置断言 |
| R12 | `makeScoreFixture` 用字面量 `false`——接受 | 该夹具是位置参数签名、没有 `input`；T6 需要时用第 5 参数 |
| R13 | `MAX_SCORE_PER_DIMENSION` JSDoc 丢了原文引用 | 随 R11 修复轮补回（`e231f15`） |
| R14 | 三条 deferred minor 并入 Task 9 收口（a/b/c） | `86d763c`（a/b：差分断言 + 出现次数）+ `9a6f38f`（c：文件头第四职责） |
| R15 | T2 夹具终值 `true/true/false`（我的 brief 写错了） | 按 spec §5.6.2 真值表落地（`3a2a84c`），并先写 `false` 走 RED→GREEN |
| R16 | `orchestrator-live.test.ts:70` 的 mock 缺 `structuredOutput` 格 ⇒ T7 必补 | `4a2c0cd` 补格；另有假绿复现实测（台账 #27） |
| R17 | 不在 T3/T4 做真机 probe | 依据为安装态类型面 + `--help` 实测；真机项进 §六 |
| R18 | `api/src/runs.ts` 的 capability 白名单不需要动 | 已核该包全文无 score 字段白名单；将来需求见 §六 第 7 项 |
| R19 | R14 再扩两条一行注释（a/b） | `9a6f38f`（`registry.test.ts` JSDoc 收窄 + `types.ts` 分层子句） |
| R20 | 接受 `failure.message` 不含英文 subtype | subtype 原文改落一条 `stderr` WARN 草稿（`a704d59`） |
| R22 | 修复轮 1：显式 `null` 与 JSON 字符串形态 | `d230318` + 两条互不牵连的变异（A′/B′，台账 #10/#11） |
| R23 | 接受 WARN 断言改成**点名文案** | `events.test.ts` 点名「structured_output 与 result 文本不一致」（`d230318`） |
| R24 | `structured_output: ''` 必须落回 `result` 支 | `events.ts` 补 `&& structured !== ''` + 用例 + 变异 M2（`dbbbe53`） |
| R25 | `index.test.ts` 补 `not.toBeNull()` + 一条否证用例 | `dbbbe53` |
| R27 | 适配器入参侧空值口径并入 Task 9 批次 | `423e275`（claude 侧补齐 ⇒ 三适配器 + evaluator 同口径） |
| R28① | 入口侧 null 口径的用例**不可删** | 给 codex / claude 两条用例各加「唯一守卫」注释（`423e275`） |
| R29 | 接受 codex `index.ts:88` 顺手修既有注释 | `6c80b04`（原结论逐字未变） |
| R30 | 计划 `git add` 清单漏文件（T4/T6） | 派发点名「提交清单以实际改动为准」；两任务提交清单完整 |
| R31 | R27 的全特性统一批次确认在 Task 9 | `423e275` |
| R33 | `.catch()` 拿不到守卫抛的异常（我的 brief 写错） | 断言改 `result.error` + `ok === false` + `exitReason` + `error.code`（`58d9c42`） |
| R34 | dsh 守卫生产不可达 ⇒ T7 必查项 | `4a2c0cd` 端到端断言「dsh 行的 `run()` 入参没有 `outputSchema`」；残余事实进 §六 第 5 项与 §七 |
| R37 | 「测试全绿不能证明插入干净」的收尾检查 | T6–T10 派发一律携带删除计数自查；T9 逐条命名 30 处删除 |
| R38 | T6 之后生产路径仍没有任何调用方传 `outputSchema` | T7 端到端接线（`4a2c0cd`）+ 变异 ①②（含「微观尺度的假绿复现」） |
| R39 | (a) 转发理由说过头 → `423e275` 改成事实描述；(b) `null` 口径自相矛盾 → `423e275` 改 `!= null` + 用例 + 两条变异 | （c）(d) 见 §4.2 |
| R40 | 不为「键不存在」扩夹具 | 裁决在案；该性质由 `judge-agent.ts` 的条件展开保证。措辞按 R40 更正（不再说 `judge-agent.test.ts:190` 守着它） |
| R41 | 降级日志/记账只剩**最后一次尝试** ⇒ Task 10 写一句 | 本记录 §5.5 |
| R42 | R16 是**预防性**的，不是「今天就咬人」的雷 | 口径更正在案；T7 仍按预防性补了那一格 |
| R43 | (b) 「由 `judge-agent.test.ts:190` 守着键不存在」说过头 → 本记录按 R40 更正；(c)「恰好一条」只对单次尝试成立 → 本记录 §5.5 | （a）(d) 见 §4.2 |
| R44 | 按 spec §7 落点必须更新一条既有断言 | 裁「放行」；实现为**加强**（§5.1） |
| R45 | README 同步并入 Task 9 批次 | `9a6f38f`（`README.md:170` 补「输出约束」+ 新增说明段） |
| R46 | R44 的授权范围按精神放宽 | 测试名 / 行内注释 / 头注一并放行（§5.1） |
| R47 | 计划结构变更：拆出 Task 10 | 本任务即该拆分产物；门禁跑在冻结树上 |
| R48 | **D5 集合判等自身看不见「整行删掉一个维度」**；出现次数是唯一把它报成**结构缺陷**（计数）的判据 —— **不是「只有它能拦住」**（既有 `:74` 同样会红） | 措辞口径见 §5.3（本行摘要与之一致）；代码注释 `score.test.ts:271-280` 同口径 |
| R49 | 条目 5 的「父元素」指令基于错误 DOM 假设 | 改为收窄到「那一行本身」；T10 现场读码复核（台账 #39） |
| R50 | D5 的 `every(...)` 被差分断言等价取代 | **授权例外**，登记见 §5.2 |
| R51 | 授权 B5 的覆盖面变更（容器级 → 那一行） | 授权 + **残余盲区登记**（§5.4 与 §七） |

#### 4.1.2 deferred minor 条目（16 条）

| 来源 | 条目 | 怎么收口的 |
|---|---|---|
| T1-m1 | D5 守卫失败信息不点名是哪一侧多了/少了 | `86d763c` 改差分形状（R14a） |
| T1-m2 | D5 按「去重后名字集合」比对 ⇒ 整行删维度它仍绿 | `86d763c` 补出现次数断言（R14b）；**表述按 R48 更正**（§5.3） |
| T1-m4 | `score.ts` 文件头没写第四个职责 | `9a6f38f` 补第四项 + 「两份必须同批修改」（R14c） |
| T2-m1 | `registry.test.ts:98-100` 的 JSDoc 说过头 | `9a6f38f` 收窄成「未标注的 `vi.mock` 字面量 tsc 拦不住」（R19a） |
| T2-m3 | `types.ts:91` 与 `:158` 并读像矛盾 | `9a6f38f` 补分层子句（R19b） |
| T3-m2 | claude `index.ts:158` 只判 `=== undefined` | `423e275` 统一空值口径（R27） |
| T6-R39a | `judge-agent.ts` 的转发理由（`in`/`Object.keys`）仓内不成立 | `423e275` 改成事实描述 |
| T6-R39b | `judge-agent.ts` 对显式 `null` 会转发并记 `true` | `423e275` 改 `!= null` + 用例 + 两条变异（台账 #31/#32） |
| T7-R43b | 报告 §7.1「由 `judge-agent.test.ts:190` 守着键不存在」说过头 | 本记录按 R40 更正（台账 #26/#39） |
| T7-R43c | `:193` 的「恰好一条」只对**单次尝试**成立 | 本记录按 R41 写清跨重试口径（§5.5） |
| T8-m1 | 测试文件头注 `:9` 未收窄 | `86d763c`（Task 9 条目 11） |
| T8-m2 | R44 授权范围 | R46 已裁；本记录 §5.1 写明 |
| T8-m3 | `score-detail-view.test.tsx:138` 容器级负向断言过宽 | `86d763c` 收窄到评分者那一行（Task 9 条目 5；R49/R51） |
| T8-m6 | UI 包全量 348 tests 带 wrapper `[timed out after 120000ms]`，不许引用该数 | 本任务自己重跑全量并记真实数字（§一） |
| T9-m1 | 报告汇总句「全批唯一一处既有断言被改写」不准 | 本记录如实登记为**物理改写 3 条**（`:107`/`:109`/`:110`，其中 1 条减覆盖 = R51） |
| T9-m3 | 注释/文档类 8 条无守卫、无变异 | 按事实登记（T9 实现者与审查者一致背书：注释无变异属 brief 自身不可同时满足，**不算缺交付**） |

### 4.2 转交终审与人工（33 条）

| 来源 | 条目 | 为什么转交 / 建议 |
|---|---|---|
| R2 | 模型不可逐角色指定（本会话 `subagent` 工具无 `model` 参数） | 环境限制，非本计划可解；独立性收益只剩「新鲜上下文」，没有能力阶梯 |
| R9 | 全仓 6 条既有抖动**未做 BASE 对照实验** | 判据是「独立复现 + 落在未触碰文件 + 失败集合漂移（本计划三次采样：用例 3/8/19、文件 3/7/12）」；本任务用同一判据（§1.3） |
| R21 | `is_error === true` 合取项维持不动 | 改与不改都要真机证据 ⇒ §六 第 6 项 |
| R26 | 出口用例 fixture 未统一带 `usage` 三元组 | 点名断言对无关 WARN 免疫 ⇒ 判别力不受损；边际收益只剩「少一条噪声草稿」。终审若认为该组 fixture 应统一带齐用量，可整批处理 |
| R32 | 证据卫生：SDD 目录既有日志不可当门禁证据 | 本任务自跑（§一），并把每条变异证据与所属任务对齐（§三） |
| R35 | `null` 口径三处各写一遍、**未集中定义** | 不新开抽象层（只有三处）；类型面不可表达 ⇒ 无编译期护栏，只能靠用例。登记为结构弱点（§7.2） |
| R36 | 守卫错误归到 `AGENT_FAILED`，粒度不精 | 加新错误码会牵连 contracts 与重试判据 ⇒ 不动；该路径生产不可达（§七） |
| R39c | `judge.test.ts:244` 既有用例内多了一行注释（断言未动） | 登记即可 |
| R39d | `run-store.test.ts:254` 的 `not.toContain('structuredOutput')` 是全文件级、过宽 | 收窄到该行 score 的 JSON（将来任何无关的 `structuredOutput*` 字段都会让它以误导性信息变红）；未做 |
| T1-m3 | 文本抽取与契约文本的**书写格式**耦合 | 不是假绿（是「假红且信息无用」）；去掉骨架引号或合法重排都要同批改守卫。未做 |
| T1-m5 | 报告 §2 引用的 `score.test.ts` 行号偏约 37 行 | 报告自身瑕疵，写进终审视野 |
| T2-m2 | `providers/*/index.ts` 注释断言了厂商开关名，本任务没验 | ⇒ §六 冒烟第 3 项 |
| T2-m4 | `capability` 白名单没转发 `structuredOutput` | R18：本计划不需要；将来做「创建评测时提示不支持」才需要（§六 第 7 项） |
| T2-m5 | `evaluator/src/testing/fixtures.ts` 用派生值 `kind !== 'dsh'` 而 JSDoc 承诺「与真实注册表逐格一致」 | 与既有 `cancelMidTurn` 同形（不是新债）；加第四家时会红在 `registry.test.ts:115` |
| T3-m1 | `events.test.ts:434` 注释写「下面六条分别钉」而该 describe 现有 **7** 条 | 纯注释计数；未做 |
| T3-m3 | `sdk.ts:47` 新字段把 `permissionMode` 与成对项切开 | 纯阅读顺序（brief 指定锚点所致）；未做 |
| T4-M1 | `codex/index.ts:88` 引用的行号 `172-174` 不含 `outputSchema`（它在 170-171） | **终审修复波已做**（C1）：改为 `169-174`，事实来源 `dist/index.d.ts:169-174`（见 §4.3） |
| T4-M2 | `codex/index.ts:65-67` 与 `index.test.ts:121-124` 的**理由写错了** | **终审修复波已做**（C2）：守卫不变，理由改成「在入口把 `null` 与『没给』同义化，不把判据交给厂商 SDK 的报错」（见 §4.3） |
| T4-M3 | `codex/index.test.ts:117` 在 `turnOptions === null` 时可空过 | **终审修复波已做**（C3）：补 `expect(turnOptions).not.toBeNull()`（修后该判据在 `:120`），附「SDK 未被调用」形状的变异证据（见 §4.3） |
| T4-M4 | 报告计数笔误（「16 条既有 codex 用例」实为 14；diffstat 误读） | 报告瑕疵 |
| T5-m1 | `dsh/index.ts` 的 19 行 `/** … */` 落在**函数体内**、不是任何声明的 JSDoc | 按同文件惯例降级为 `//` 块或压到 6–8 行（它是守卫代码的近三倍长）；未做 |
| T5-m2 | `dsh/index.ts:125` 注释首句应先说「做什么」再说定位 | 未做 |
| T5-m3 | `dsh/index.test.ts:121` 把「入参不支持」归到 `AGENT_FAILED` | = R36 |
| T7-R43a | 报告把「写死 `true` / 删整段接线」标成 brief 的必做变异，而 brief 真正点名的「写死 `false`」**没跑** | 替代变异已严格覆盖其意图；但 `claude-code:171` 在任何已执行变异下**都未被观察到红** ⇒ 终审可补跑或接受改标签 |
| T7-R43d | `getProvider` 在评分阶段被调两次 | A3 不受影响；登记 |
| T8-m4 | 新格位置只对「文本通路 + `false`」组合做了逐字节钉住 | 一条 JSX 表达式、单代码路径，收益低 ⇒ 不补 |
| T8-m5 | 行内注释 4 行配 1 行代码、且与头注第 5 条内容重复（两处要同步） | 未做 |
| T9-m2 | `judge-agent.test.ts:208` 用 `calls[0]?.`（可选链） | 补 `toHaveLength(1)` 更硬；未做 |
| T9-m4 | 两套空值语法（`=== undefined \|\| === null` 与 `!= null`）语义一致、语法不同 | 全仓此前无 `!= null` 用法，lint 也未配 `eqeqeq` ⇒ 无工具强制统一；建议终审决定是否单开一行收拾 |
| T9-m5 | 收窄后的界面守卫盲区（`<Alert>`） | = R51 残余盲区，见 §5.4 与 §七 |
| T9-m6 | README 句子「claude-code / codex 两家支持」会随能力集漂移且**无守卫** | 与 `registry.test.ts:110-116` 的开集一致；新增/去掉一家时不会被任何测试拦住 |
| T9-m7 | `structuredOutput` 字段名读起来像「已经结构化了」 | 改名是破坏契约的事，本计划不做；已用 README + 契约注释写明「不表示上游照做了」 |
| T3-遗留 | 出口用例 fixture 的无关「用量负载不完整」噪声草稿 | = R26 |

### 4.3 全分支终审（`1346eb3..944b2bc`，`With fixes`）的修复波收口（2026-09-29）

> 终审结论：**无 Critical、无需改代码的 Important**；唯一阻塞项是 **I1（docs 回写）**，另有 3 条 Minor
> （M1/M2/M3）与 4 条一行级代码/注释修法（C1–C4，末条为硬化建议）。**本波全部结掉**，逐条证据见下表
> 与 `.superpowers/sdd/2026-09-28-structured-judge-output/final-fix-report.md`。

| 条目 | 改了什么 | 文件:行（修后） | 验证证据 |
|---|---|---|---|
| **I1**（docs 回写，唯一阻塞项） | 写入样本 #3 实测（12 文件 / 19 用例 / 603.91s）+ 逐条归因（18 超时 + 1 EPERM）+ R54 交集 = 空集 + 终审者 320/320 佐证（标注来源）+ 门禁口径改写（谁接受）+ 12/12 隔离复跑 + N6/N7/N8 三处措辞 + 计划层教训（§5.6） | 本记录 §一/§1.0/§1.3/§1.4/§5.6/§九；spec §10 第 2 条状态行 | 数字可从 `task-10-full-suite-sample3.log` 复算；交集可从 `plan-touched-files.txt` 复算；复跑日志 `final-fix-rerun-*.log`（§1.3） |
| **M1**（盲区措辞比实际损失窄） | 从「整行被外层包进 `<Alert>`」这一个最窄实例放宽到「**除该行自身与其后代之外的任何位置**」（含兄弟级 `<Alert>`）；**授权结论不变** | 本记录 §5.4 与 §七 R51 行 | 读码（`:147`/`:148` 两条判据的覆盖面）+ R49 探针的既有实测；措辞级，无新变异 |
| **M2**（spec §5.3 落点未回写，终审追加） | spec §5.3 第 4 条就地补「实施期落点与理由」（`errors.ts` → `providers/claude-code/events.ts`），并登记为本记录 §八 的**第四处**历史不一致 | spec §5.3 第 4 条；本记录 §八 | 代码锚点 `events.ts:132-148`；授权出处 `plans/2026-09-28-structured-judge-output.md:36-40` |
| **M3**（冒烟第 1 项判据缺一支） | 写入 `events.ts` 逐字节比对的风险：真机 `result` 若是「同一份 JSON 但键序/空白不同」或摘要 ⇒ **每条 schema 行都会刷一条「不一致」WARN**；判据分两支，**不改代码** | 本记录 §六 第 1 项；spec §11 第 1 项 | 读码（`events.ts` 的 `text !== serialized`）；真机结论待 §六 执行 |
| **C1** | 注释引用的行号范围改为覆盖 `outputSchema` 的整段 | `packages/server/agents/src/providers/codex/index.ts:89` | 事实来源 `@openai/codex-sdk/dist/index.d.ts:169-174`（`outputSchema` 在 `:170-171`） |
| **C2** | 只改**理由**：在入口把 `null` 与「没给」同义化，不把判据交给厂商 SDK 的报错（它会在自己边界抛 `outputSchema must be a plain JSON object`）；**守卫不变** | `codex/index.ts:65-68`；`codex/index.test.ts:125-128` | 读 `dist/index.js:5-12`/`:29-31`/`:55`（`null` 被 `isJsonObject` 拒、校验早于 CLI 启动） |
| **C3** | 「没给 outputSchema」用例补 `expect(turnOptions).not.toBeNull()`，与 null 用例对称（原来 `turnOptions === null` 时会静默变绿） | `codex/index.test.ts:120` | 变异三连（§1.4）：造「SDK 未被调用」形状 ⇒ 带守卫**红**（`expected null not to be null`，`:120:29`）、删守卫**绿**（假绿复现）、无条件抛错**同样红** |
| **C4**（硬化建议） | `JUDGE_OUTPUT_JSON_SCHEMA` 加 `Object.freeze`（**浅**冻结顶层，注释写明限度）+ `score.test.ts` 补 `Object.isFrozen` 守卫 | `packages/server/contracts/src/score.ts:102-108,132`；`score.test.ts:214-225` | 变异：去掉 `Object.freeze` ⇒ `Tests 1 failed \| 134 passed`，**唯一红**就是那条冻结守卫（§1.4） |

- **本波引用的四条新裁决/事实**（控制方在终审与修复波期间裁定或登记，故 §4.1/§4.2 的「R1–R51 共 51 条」
  自查**不覆盖**它们）：**R52**（门禁口径替换接受，§一）、**R53**（本 harness 下 `pnpm --filter <pkg> test -- <file>`
  的位置过滤**不生效**、会把整包拉起来 ⇒ 单文件复跑用 `pnpm exec vitest run <file>`，§1.3/§1.4）、
  **R54**（样本 #3 的失败文件清单 ∩ 本计划触碰的文件 = 硬检查，§1.0）、**R55**（终审区间用 `1346eb3..HEAD`；
  `merge-base main HEAD` 实测等于 HEAD ⇒ 空集）。
- **代码足迹**：C1–C4 只落在 4 个文件、一个依赖都没加（`package.json` / `pnpm-lock.yaml` 仍无 diff）。

---

## 五、两条口径记录（+ 两条授权例外）

### 5.1 R44 / R46 例外：唯一一处需要**人工判断**而非机械比对的既有断言更新

- **事实**：`packages/client/ui/src/composite/score-detail-view.test.tsx` 那条既有断言（期望字符串）**因 spec §7 的落点必须更新**——
  它是对「评分者一行」的**整行精确匹配**，而新格按 spec §7 钉在同一行 ⇒ 任何位置都会改变该行整串，不改它门禁不可能绿。
- **更新后更强**：**原两段逐字保留**（`评分模型：claude-opus-4-6` 与 `评分时间：${formatDateTime(…)}`，含模板表达式），
  **新段的位置与顺序被整行匹配钉住**（新格若插错位置同样会红，变异 ① 已实测该断言有区分力）；断言现在位于 `:120-124`。
- **R46（同一个提交里的测试名 / 注释 / 头注改动一并放行）**：全部是文档性、coverage 中性，
  且每一处都是在**防止一句话变成假话**（这正是 R44 放行的同一理由）。
- **口径**：**这是 Task 9 收口自查里唯一一处需要人工判断而非机械比对的例外**（计划 Global Constraints / Task 9 brief 第 18 行
  「不许为了过关而放松或删除既有断言」的本意是「不许放松或删除」，而这一处是**加强**）。
  证据：`task-8-step4-after-impl.log` + 变异 ① 实测该断言有区分力（台账 #28）。
- **代价（照实登记）**：收口自查必须靠人判断「加强 vs 放松」，不能只做机械的「测试文件零删除」检查 ——
  R46 已预告 Task 10 在这个文件上会看到 4 处改动，必须靠记录说明。

### 5.2 R50 例外：D5 的 `every(...)` 被两条差分断言等价取代

- `packages/server/contracts/src/score.test.ts` 的 D5 守卫里，`expect([...schemaNames].every((name) => names.has(name))).toBe(true)`
  被 `missingInContract` / `extraInContract` 两条**差分断言**等价取代。
- **强度不变**：两个方向都在，且 `expect(names.size).toBeGreaterThanOrEqual(schemaNames.size)` 的下界与集合判等**原样保留**
  （审查者具名复核为「真等价」，台账 #38）。
- 收益：失败信息从 `expected false to be true` 变成点名缺失字段（`expected [ 'verdict' ] to deeply equal []`）。
- **这是「只许加不许改」之外的授权例外**，与 R44/R46 同族，在此一并登记。

### 5.3 R48 口径：D5 出现次数断言到底拦住了什么

**准确表述**：**D5 集合判等自身看不见「整行删掉一个维度」**；出现次数是唯一把它报成
**结构缺陷**（计数）的判据 —— **不是「只有它能拦住」**：既有 `toContain(dimension.key)`
（`score.test.ts:74`）在整行删除时**同样会红**。

- **代码注释已按此写**（`score.test.ts:271-280`），本台账与之一致，否则注释/报告/台账三者分叉。
- **T10 现场实测支持**（§1.2）：删整行 `maintainability` ⇒ 恰好 2 条红（`:284` 出现次数 + `:74` 既有），
  **D5 集合判等保持绿**。
- 出现次数断言的增量价值 = 「把结构缺陷本身报准（`4 ≠ 5` + 自定义失败信息）」+「拦得住『行被删但 key 名在别处仍出现』的未来形状」。

### 5.4 R51 例外 + 残余盲区：界面负向断言从**容器级**收窄到**评分者那一行**

- **授权**：`score-detail-view.test.tsx` 的「无告警样式」负向断言从容器级（`container.querySelector`，扫整棵渲染子树）
  收窄到**评分者那一行**。理由：收窄正是 Task 9 brief 条目 5 要求的（避免视图别处的**合法**告警样式造成误红），
  而 T9 实现者实测该行 span 的 parent **就是根 `Flex`** ⇒ 按 brief 字面「收窄到父元素」等于**没收窄**（R49），故收窄到「那一行本身」。
- **代价（残余盲区，照实登记；措辞按终审 M1 放宽到实际范围）**：**除「评分者那一行自身」与「该行的后代」之外的任何位置**
  出现告警样式都不再被任何断言覆盖 —— `:147` 的 `querySelector` 只扫该行的**后代**、`:148` 的 `className` 只覆盖该行元素**自身**。
  丢掉的是一个**范围**，不是「整个视图被包进 `<Alert>`」这一个最窄实例：把整行包进外层 `<Alert>`（告警类落在**祖先**上）看不见，
  为一个错误的「提示词约束」加一条**兄弟级** `<Alert>` 同样看不见，甚至该行**祖先链上任何一层**的告警类都看不见。
- **授权结论不变**：收窄仍然是必要的（R49 探针已实证旧口径会命中视图别处的合法 danger 样式 ⇒ 那是误红面）；这一改只是把**损失写准**——
  「只有祖先看不见」低估了盲区，实际是「该行自身与后代之外都看不见」。
- 两条判据在修后位于 `:147-148`（**注意**：Task 9 报告里写的 `:144-145` 是**修前**锚点，引用时要写 `:147-148`）。
- 留在**已知边界**而非补回容器级断言：加回去等于把误红风险请回来（R49 探针已实证旧口径会命中别处的合法 danger 样式），价值极低、误红代价更高。

### 5.5 R41 重试口径：降级日志与 `structuredOutput` 都只剩**最后一次尝试**

- 降级日志是「**每次尝试一条**」，而 `resetEvents` 在**每次尝试开始时**清空该行事件 ⇒
  **自动重试之后，日志抽屉里只剩最后一次尝试的降级说明**。
- `ScoreResult.structuredOutput` **同样被覆盖为最后一次取值**（与 `judgeProviderId` / `judgeModelId` / `judgeAgentKind` 等字段**同构**）。
- **判定为一致**（不是缺陷），但写进记录供使用者理解：界面上的「输出约束」与抽屉里的降级日志都只代表**最后一次尝试**，
  它同时也正是最终进入 `score` 的那一次 —— 两者口径自洽。

### 5.6 口径教训（计划层）：往「整行匹配」的断言里插一格，必须在计划里先授权更新那条期望串

- **事实**：§5.1 那处例外（`score-detail-view.test.tsx` 的评分者行**整行期望串**）不是执行期的偶发判断，
  而是 spec §7 的落点决定的**必然后果** —— 新格按设计钉在同一行 ⇒ 那条整串**必然**要改，不改门禁不可能绿。
- **教训**：这类需求（「在一条已有整行精确匹配的断言所处的位置插入一格」）应当在**计划里直接写明**
  「允许更新指名的那条整行期望串」，而不是留给执行期临时裁决、再靠记录事后补一张授权单。
  临时裁决的病根是**它没有守卫**：实现者可以把它做成「加强」（本次如此：原两段逐字保留 + 新段位置被整行匹配钉住），
  也可以悄悄做成「放松」，而两者在 diff 上长得一样，只能靠人读。
- **代价（本次实际付出的）**：Task 9 的收口自查因此必须靠人判断「加强 vs 放松」，不能只做机械的
  「测试文件零删除」检查（§5.1 末条）—— 一次本可预防的人工判断，花在了执行期而不是计划期。
- **下次的落法**：计划里点名**文件 + 断言 + 只许加强的判据**（原串逐字保留、新段被整行匹配钉住），
  让这条授权本身可机械复核。

---

## 六、待人工执行的真机冒烟清单（七项）

> spec §11 的四项 + 实施期新登记的三项。**本节全部是待办，实施阶段一条都没跑**：
> 本机没有可用凭据/网关（R17）。执行后把结论写回 spec §1.2 与 §9，并用真机结论**替换**推断。

| # | 项 | 怎么判 |
|---|---|---|
| 1 | cc 在 `outputFormat` 下，收尾消息的 `result` 与 `structured_output` **各自**是什么 | dump 一次真实收尾消息（spec §11 第 1 项）。本计划按「**优先 `structured_output`**」实现（D8），三态已兜住：字段**缺失** / 显式 `null` / 已序列化**字符串** / **对象**。判据：`run.json` 的 `score.structuredOutput === true`；并把 spec §1.2 第 1 条从「未验证」改成「已验证」或按实测回写 §9 第 5 条。**判据的第二支（终审 M3 追加，不改代码）**：`events.ts` 对两个来源做的是**逐字节**比对（`text !== serialized`）⇒ 真机若把 `result` 填成**同一份 JSON 但键序/空白不同**、或填一句**自然语言摘要**，则**每一条 schema 行都会刷一条「不一致」WARN**（`[WARN] claude-code 的 structured_output 与 result 文本不一致…`）。故本项按两支落结论：确认 `result` 就是**同一份 JSON 文本** ⇒ 逐字节比对即正确判据、保留现状；是摘要（或等价但不等字面）⇒ 再决定「两边都能 parse 时做深比较」还是「把该行降为 INFO」——**本计划不改代码**，按实测结论单开一处小改动 |
| 2 | **网关透传对照**：同一用例、同一模型，schema 开 / 关各跑一次 | 开的那次 `score.raw` 应是**合法 JSON 且形状与 schema 同形**（顶层三字段、`dimensions` 恰 5 条）。若仍是散文 ⇒ 网关未透传，**照实登记进 spec §9 第 1 条**（不改设计）。两次的 `score.structuredOutput` 应分别为 `true` / `false` |
| 3 | codex：真 CLI 是否把 `outputSchema` 落成 `--output-schema <FILE>`；以及**故意违反 schema** 时的失败面文案 | ① 观察进程 argv / CLI 输出确认落点（SDK 侧 `--output-schema` 在 `dist/index.js:214-215` 被 push 已由审查者核过，缺的是端到端）；② 非法 schema 那次的归因应是「**上游/CLI 拒绝 schema**」而**不是**「模型答错」 |
| 4 | 页面互证 + dsh 行日志抽屉 | 评分详情显示「输出约束：schema 约束 / 提示词约束」，与 `run.json` 里的 `score.structuredOutput` **逐格一致**；dsh 行的日志抽屉里能看到那条降级说明 |
| 5 | dsh 行的**生产表现是降级日志、不是报错** | 跑一次 dsh 评分：该行**成功**、`score.structuredOutput === false`、抽屉里有「不支持结构化输出…回落」一条。依据 **R34**：适配器那道守卫在生产路径上**不可达**，可达性靠编排层按能力不传（T7 已落地并有端到端用例） |
| 6 | 重试用尽那条是否真带 `is_error: true` + `error_max_structured_output_retries` | 制造一次形状不符导致重试用尽（R21 维持不改的那条**合取项**）。判据：收尾消息 `is_error === true` 且 subtype 为该值 ⇒ 中文归因生效、失败面正确；若 subtype 配 `is_error: false`（生产者违约），我们的合取项会**静默漏掉**这条归因，需据实回写 |
| 7 | 将来要做「创建评测时提示这家评分智能体不支持 schema」的入口条件 | 需要把 `structuredOutput` 加进 `packages/server/api/src/runs.ts` 的 **capability 投影白名单**。本计划**没有**做（R18：界面读的是 `ScoreResult.structuredOutput`，不是创建期的能力格）。**不属于本次冒烟**，登记为将来需求的入口条件 |

---

## 七、已知边界

### 7.1 spec §9 六条（**照抄**，不改写、不美化）

1. **网关透传（最高风险）**。schema 落到 wire 上就是请求体里的一格；网关不认时**不报错**，
   只是模型照旧自由生成。可观测手段只有两条：`ScoreResult.structuredOutput` 与 `score.raw`
   （schema 生效时 `raw` 必然是一段能解析的 JSON，且形状与 schema 同形）。§11 第 2 项是判据来源。
   本设计**不假设**网关一定认——它只是把「认不认」变成一次可执行的对照实验。
2. **两条通路在「越界」这一格上有意不同**（D7）：文本通路会把 `score: 6` 夹紧成 5，
   agent 通路在 schema 下根本不会拿到 6（拿到了说明网关没透传，走 §9 第 1 条）。这是登记项，不是缺陷。
3. **cc 的结构化轮次可能更慢**：形状不符时 CLI 自己重问（`error_max_structured_output_retries`），
   单行耗时与轮次都会上升。「评分不限时间」是既有用户口径（`AgentRunInput` 已无 `timeoutMs`），
   而轮次/用量/耗时本来就有记账（`turns` / `tokens` / `durationMs`）。
4. **契约文本与 schema 的漂移**：`JUDGE_OUTPUT_CONTRACT`（文本）与 `JUDGE_OUTPUT_JSON_SCHEMA`（schema）
   是同一条契约的两个投影，靠 §4.3 的守卫与「同批修改」的注释约束。rubric spec 落地时两者必须**同批**替换。
5. **`result.result` 在结构化轮次里的内容未知**（§1.2 第 1 条）：本设计的 D8 用「优先 `structured_output`」
   把这条不确定性挡在出口之外，但**不排除** CLI 把 `result` 也填成同一段 JSON（届时两条分支给出同一结果，
   无害）。冒烟会把真实形状写回本文件。
6. **dsh 的分数与开通 schema 的分数不可直接比较**：这是本设计要暴露的事实（§1 第 3 条），
   不是它能消除的问题。要消除只有一条路——给 dsh 补上结构化输出通道，那是独立需求（§2 已排除自研插件）。

### 7.2 实施期新登记的四条

| # | 边界 | 内容 |
|---|---|---|
| R26 | 出口用例 fixture 未统一带 `usage` 三元组 | `readTokens` 在用量不齐时会**无条件**落一条「用量负载不完整」WARN（既有行为）。本计划已把所有断言改成**点名文案**（对无关 WARN 免疫）⇒ 判别力不受损；代价是测试输出里仍能看到与断言无关的草稿。给 fixture 补 `usage` 的边际收益只剩「少一条噪声」，整批处理留给终审 |
| R35 | `null` 口径三处各写一遍、**未集中定义** | 三个适配器 + evaluator 各写一遍 `=== undefined \|\| === null` / `!= null`。类型面上不可表达（该字段类型不含 `null`）⇒ **没有编译期护栏**，只能靠用例（台账 #15/#30）。处置：不新开抽象层（只有三处），但登记为结构弱点 |
| R36 | 守卫错误归到 `AGENT_FAILED`，粒度不精 | dsh 守卫抛的错被 `turn.ts` 的 catch 归成 `AGENT_FAILED`，而该码的文案语义是「CLI 未安装 / 非零退出」——对「入参不支持」不精确、重试也不会好。加新错误码会牵连 contracts 与重试判据 ⇒ 不动；精度损失可接受，因为该路径**生产不可达**（R34 兜底） |
| R51 | 界面负向断言的覆盖损失（是**范围**，不是单例） | **除「评分者那一行自身」与「该行的后代」之外的任何位置**出现告警样式都不再被任何断言覆盖 —— 「整行被包进 `<Alert>`」只是其中一例，**兄弟级** `<Alert>`（例如为一个错误的「提示词约束」加一条）同样看不见（详见 §5.4；措辞按终审 M1 放宽） |

### 7.3 两条「同族事实」（R28 的落地）

- **入口侧的假值**（显式 `null` 被当成有效值透给厂商 SDK）由**适配器用例**守
  （`codex/index.test.ts`、`claude-code/index.test.ts` 各一条，已加「唯一守卫、不可删」注释）；
- **出口侧的假值**（显式 `null` / 空串被当成有效产出）由 `events.ts` 的**用例**守；
- **两者都靠用例、不靠类型**：条件展开这一形状 `tsc` **零诊断**（探针实测，R28）。

---

## 八、记录问题（四处历史不一致：三处不改历史产物，第 4 处按授权回写 spec）

1. **计划文档里的一处历史不一致**：`docs/superpowers/plans/2026-09-28-structured-judge-output.md:1083`
   仍逐字引用**旧**用例名（`…（不是错误，只是事实，不给告警样式）`），而代码里已在 `38cbaf8` 改名为
   `…（不是错误，只是事实，评分者那一行不带告警样式）`（原因：断言已只扫一行，旧名字成了假话）。
   **处置：不改计划** —— 计划是历史产物、无测试依赖（审查者已 grep 确认旧名只命中计划文档，无 `.snap`、
   无 `--testNamePattern`），改它反而会把「当时的计划」与「当时的代码」的对应关系抹掉。此处点明即可。
2. **Task 9 报告里的行号是修前锚点**：报告写 `:144-145`，修后两条判据实际在 `score-detail-view.test.tsx:147-148`。
   引用时写作 `:147-148`（本记录各处已按修后写）。
3. **`task-9-report.md:54` 把同一条出现次数断言记为 `:281`**，而当前文件里它在 `:284`（Task 9 修复轮 1 的
   `38cbaf8` 在该用例上方补了 JSDoc 首段，把它往下推了 3 行）。本记录与台账引用时一律写 `:284`
   （§1.2 的原始输出即 `src/score.test.ts:284:52`）。
4. **spec §5.3 第 4 条的落点与代码不一致**（终审 M2 发现）：spec 原文写「归因补在 `errors.ts`」，
   实际落在 `packages/server/agents/src/providers/claude-code/events.ts:132-148` 的 `projectResult`
   （中文归因进 `failure.message`，英文 subtype 另落一条 `stderr` WARN）—— 理由是
   `error_max_structured_output_retries` 是 **claude 一家的 subtype**，而 `errors.ts` 是三家共用的中性归因层
   （输入只有 message 文本与 baseUrl），把某一家 CLI 的枚举塞进共享层与「厂商方言留在 `providers/<kind>/`」
   这条既有边界冲突；归因码仍是 `AGENT_FAILED`。该偏离**在计划里已被授权**
   （`docs/superpowers/plans/2026-09-28-structured-judge-output.md:36-40` 的「计划对 spec 的两处修正」第 1 条），
   但 spec 当时没回写、本记录首版也没登记 ⇒ 记录与事实两处都缺。
   **处置：按授权就地回写 spec §5.3 第 4 条**（补一句实施期落点与理由）**并作为第四处登记**。
   这一处与第 1–3 处的处置不同是有理由的：spec 是终审与后继者的**入口**，留着已知偏差比补一句话贵得多；
   而计划/报告是**历史产物**，改写它们会把「当时的计划」与「当时的代码」的对应关系抹掉。
**处置口径**（第 1、3 处同源 —— 都是「计划/报告写于修复前、代码在修复后位移」造成的锚点漂移；第 4 处是**落点偏离**，
已被计划授权、只是当时没回写）：第 1–3 处一律**不改历史产物**，由本记录声明当前正确锚点；
第 4 处按授权**回写 spec §5.3**（见上）。上列四处之外未再发现别的历史不一致。

---

## 九、结论

- spec §10 验收标准的结论**按条分开写**（第 2 条与第 3–5 条都转交终审，不再合并成一句「已满足」）：
  - **第 1 条（新守卫按 §8 完成变异验证）——已满足，但含义按事实限定**：按 §三 的分类**可复算** ——
    §三 的**变异台账全表 40 行**里，除 `#6`/`#22`/`#37`/`#38`/`#39`/`#40` 那 **6 行**属
    「按断言可证伪性判定」外，其余 **34 行**的证据类型均为「执行过」，而这 34 行再按标签逐行复算是
    **31 行「报告声明」+ 2 行「审查者按指令未复跑」（`#28`/`#29`）+ 1 行「执行过 + T10 现场重做」（`#34`，`✔︎T10`）**
    （旧稿把这 34 行一律写成「报告声明」，与 `#28`/`#29` 的标签矛盾 —— 终审 N6；总数 `40 = 6 + 34` 不变）
    ⇒ **不是**「每一条都由本任务见过红」（§三 的两条诚实说明）。
  - **第 2 条（`pnpm typecheck` / `lint` / `test` 全绿 + 既有用例一条不改）——按字面未满足，按 R52 替换后的口径满足**：
    `typecheck` 与 `lint` 均 exit 0；**`pnpm test` 退出码 1**，但**三次采样的全部失败都落在已知抖动集
    （`api/cases-crud`、`core/mirror-*`、`evaluator/orchestrator-*`）内**（用例 `3 / 8 / 19`），
    且**已识别的失败文件逐个隔离复跑为绿**（样本 #3 的 12 个文件 12/12，§1.3）
    ⇒ **spec §10 第 2 条的「`pnpm test` 全绿」在本机不可达**（开工前基线即 `6 failed | 1529 passed (1535)`），
    该条**由控制方裁定 R52 替换接受**为可验证形式（口径见 §一），**用户可在收口时复核**。
    另外：按 R44/R46/R51 **物理改写了 3 条既有断言**（`score-detail-view.test.tsx` 的
    `:107`/`:109`/`:110`，其中 1 条减覆盖 —— 该文件既有的「无告警样式」断言，盲区措辞已按终审 M1 放宽到实际范围）。
    **判据（控制方裁定 R52，三条齐备）**：
    ① **已识别的**失败文件全部落在本计划未触碰的文件上（样本 #1 的三条由 T10 审查者 grep 全部 11 个评审包证实；样本 #2 只识别出 `orchestrator-rescore` 一条，余 6 个见 §1.0、**至今未识别**；**样本 #3 的 12 个文件已全部识别，且按 R54 求交 = 空集、`git diff` 逐个复核 12/12 都未被本计划改过**）；
    ② **失败集合在三次采样间漂移**（用例 3 vs 8 vs 19，文件 3 vs 7 vs 12，含互有出入的文件，§1.0）；
    ③ **已识别的**失败文件单独复跑为绿（样本 #1 三条 + 样本 #2 的 `orchestrator-rescore` 一条 + 样本 #3 的 12 条，§1.0/§1.3）
    ⇒ 判为**既有负载抖动，不是本计划的回归**。
  - **第 6 条（未新增任何依赖）——已满足**：`git diff --stat 1346eb3..HEAD -- package.json pnpm-lock.yaml`
    输出为空（§1.1）；终审修复波同样一个依赖都没加（4 个代码文件只动注释/测试/冻结，见 §1.4）。
- 第 3、4、5 条**依赖真机**：由 §六 的七项冒烟清单承接；spec §11 与 §1.2 已按本任务回写状态行。
- 代码树自 Task 9 的 `38cbaf8` 起**冻结**；Task 10 的 diff 只含 `docs/` 下的文件
  （`docs/superpowers/notes/2026-09-28-structured-judge-output-progress.md` 与
  `docs/superpowers/specs/2026-09-28-structured-judge-output-design.md`）。
- **冻结在终审后解冻过一次**：全分支终审（`1346eb3..944b2bc`）判 `With fixes` ⇒ **终审修复波**按结论改了
  4 个代码/测试文件（C1–C4：codex 注释行号与理由、codex 用例如硬、`JUDGE_OUTPUT_JSON_SCHEMA` 冻结）
  与 2 个 docs 文件（I1/M1/M2/M3），分两个提交提交；**改完之后门禁重跑一遍**（§1.4），随后**再次冻结**。
