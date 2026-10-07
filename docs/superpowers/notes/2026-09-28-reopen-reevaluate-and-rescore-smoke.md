# 冒烟记录：两个「重跑」出口放开给已出分的行 + 「重新评测」改名「重新执行」— 2026-09-28（晚间）

> 上一版口径（同日上午的收紧）见
> [`2026-09-28-reevaluate-and-rescore-gating-smoke.md`](2026-09-28-reevaluate-and-rescore-gating-smoke.md)——
> 本文是它的**反转**，那份记录的 §2/§4 有三格已不成立（文首已逐条标注）。
> 上位口径：`README.md` 的「⑤′ 重试：三种失败、三条出路」与 `packages/server/contracts/src/run.ts` 的两个判据。
> **只记实测值**；没在真机上做到的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么（用户口径三条）

用户原话（三条一起给的）：

1. 「已分出，无报错时取消禁用」——**两个按钮都放开**（追问确认过范围）；
2. 「删除死代码」；
3. 「『重新评测』改名『重新执行』」。

落成的东西：

| # | 改动 | 落点 |
|---|---|---|
| 1 | `canRetryRow` 去掉 `REEVALUABLE_ROW_STATUSES.includes(row.status)`（`judged` 不再是排除项） | `packages/server/contracts/src/run.ts` |
| 1 | `canRescoreRow` 去掉 `row.error?.stage === 'judge'` | 同上 |
| 1 | 界面两条禁用原因的下标顺序改成与判据同序（在跑 → 没基线 → 没产出），删掉「已经出分不给」「候选阶段失败不给」「读不到失败阶段不给」三条 | `packages/client/ui/src/composite/eval-row-card.tsx` |
| 1 | 编排层 `retryRefusal` / `rescoreRefusal` 同步删掉那三条；两条原因阶梯此后与判据的三个条件**逐条同序、措辞与界面逐字相同**（残留的兜底 return 今天**不可达**——只有判据将来新增条件时才会走到） | `packages/server/evaluator/src/orchestrator.ts` |
| 2 | 死代码：`rescoreRefusal` 尾部「无条件 return 之后的第二条 return」；界面 `rescoreDisabledReason` 同形的第二条 | 同上两处 |
| 3 | 按钮文案、`Popconfirm` 标题与说明、两条禁用原因里的词、行事件标记 `[重新执行]`、服务端 CONFLICT 文案与日志 | 同上两处 + `packages/server/api/src/runs.ts` |

**不动的东西**（写在这里省得下次再讨论一遍）：内部名 `retryRow` / `useRetryRow` / `/rows/{rowId}/retry` 路由
一个字都没改（只为一次文案调整做全链路改名不划算，名字↔文案的对应关系写在判据的 JSDoc 里）；
`EvalRow.error.stage` 照旧落盘（它今天只用于叙述与排障，不再参与任何按钮判定）；
`attempts` 照旧累计、不清零。

## 2. 判据真值表（今天的口径）

| 行形状 | 重新执行 | 重新评分 |
|---|---|---|
| `judged`（已出分、无报错） | **可点** | **可点** |
| `failed` / `timed-out`（含 `stage='judge'` 与 `stage='agent'`） | 可点 | 可点 |
| `canceled` / `interrupted` | 可点（有 diff 时） | 可点（有 diff 时） |
| 老快照（`error` 没有 `stage`） | 可点 | 可点 |
| `preparing` / `running` / `judging` | 禁用（先终止） | 禁用（先终止） |
| `pending` / `skipped`（`baselineCommit=''` 或 `diff=null`） | 禁用 | 禁用 |

## 3. 实现层用例（`pnpm test` 里跑得到的那一层）

| 断言 | 文件 |
|---|---|
| judged 行两个判据都给；agent 阶段失败、老快照、canceled 都给；在跑与没跑过的都不给 | `packages/server/contracts/src/run.test.ts`（`canRescoreRow` / `canRetryRow` 两组） |
| judged 行两个按钮 `toBeEnabled`；点「重新执行」弹确认框且首点不发请求；`pending`/`running` 仍 `toBeDisabled` + 原因文案 | `packages/client/ui/src/composite/eval-row-card.test.tsx` |
| judged 行 `retryRow` 真的整段重跑（`attempts` 1→2、候选 agent 再跑一次） | `packages/server/evaluator/src/orchestrator-retry.test.ts` |
| judged 行 `rescoreRow` 出分被替换（五维各 3 分 ⇒ 60）、候选 agent 一次都没再跑、事件日志**追加**两条 `score` | `packages/server/evaluator/src/orchestrator-rescore.test.ts` |

## 4. 真机证据（`http://localhost:3083`，Next dev 起在 17:04，本轮热更新生效）

目标轮：`/runs?panel=detail&id=3cf0b7d1-078b-460e-b4bc-008233e7fbd9`
（唯一一行：`judged`、`score.totalScore = 100`、`diff ≠ null`、`baselineCommit` 是 40 位 hash、`error = null`
——正是这次要放开的那一格）。

| 断言 | 实测 | 结论 |
|---|---|---|
| 已出分的行两个按钮**都可点** | `[data-testid="retry-wrapper"] button` → `label='重新执行'`、`disabled=false`；`rescore-wrapper` → `'重新评分'`、`disabled=false` | ✅ |
| 按钮顺序仍是用户口径 | DOM 文本序：`查看日志 / 查看改动 / 重新执行 / 评分详情 / 重新评分` | ✅ |
| 点「重新执行」弹确认框、**首点不发请求** | `.ant-popover` 文本：`重新执行这一行？候选 agent 与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。取消 确定`；点「取消」后 `GET /api/runs/{id}` 仍是 `status=judged`、`score=100`、`attempts=2`、`error=null`（快照逐字未变） | ✅ |
| 可点态**不挂** Tooltip（浮层不该凭空出现） | 悬浮外层 `span` 后 `.ant-tooltip` 数量 0 | ✅ |
| 禁用态的原因**在真机上屏**（FIX-6 那条只能真机验的口径） | 目标页 `/runs?panel=detail&id=d63d3da4-841d-45ef-8b05-aa6a47756e38`：第 1 行 `running` ⇒ `重新执行`/`重新评分` 的浮层分别是「正在运行中：请先终止它，再重新执行 / 再重新评分」；第 2 行 `pending`（`baselineCommit=''`）⇒「这一行的工作区未就绪，请先点「开始」跑一次」（两个按钮同一句，与判据同序） | ✅ |
| **「已出分的行点重新评分 → 真的重算出分」** | ⏭ **未在真机复现**：`GET /api/settings` 显示 `defaultJudgeProviderId=null`、`defaultJudgeModelId=null`、`providers=0`（这台机器的评分配置是空的，上一轮冒烟为了造 judge 失败把它清掉过）。此刻点下去只会走「评分阶段失败」那条路，而那一条既不是本轮要验的正面，也会把这一行留成 `failed`。该路径由 §3 的 `orchestrator-rescore.test.ts` 正例覆盖（分数 80 → 60、`score` 事件两条、`exitReason=rescored`）。**恢复评分配置后请在真机上补一次** | ⏭ |
| **「已出分的行点重新执行 → 真的重跑候选」** | ⏭ 未在真机复现（同上：这一条会真的启动候选 agent，分钟级 + 上游预算；由 `orchestrator-retry.test.ts` 的正例覆盖）。确认框与首点不发请求这一半已实测（见上表第 3 行） | ⏭ |

## 5. 变异验证（判据是不是真的在被守）

| 变异 | 期望 | 实测 |
|---|---|---|
| `canRescoreRow` 保留 `row.error?.stage === 'judge'`（即不放开 judged 行） | 契约 + 界面两组红 | ✅ **7 failed**（契约 4：judged 行、agent 阶段失败行、老快照行、两条判据同形那条；界面 3：两个按钮都可点那三条）。恢复实现后 76/76 绿 |
| `canRetryRow` 保留 `REEVALUABLE_ROW_STATUSES.includes(row.status)` | 契约组红 | ✅ 放开前的起点运行里已见（`canRetryRow > 已经出分…` 那两条，共 5 条红） |
| 契约组在**实现之前**的读数（先写测试的红阶段） | 5 failed | ✅ `expected false to be true` ×5，无一条是 typo 或跑不起来 |

## 5.5 独立审计（只读子代理，2026-09-28 晚间）

改完之后另起一个只读子代理，按 A–E 五节审了一遍（旧口径残留 / 改名残留 / 判据与原因文案是否自洽 /
有没有别的调用方依赖被删行为 / 有没有断言旧行为的用例）。它的结论与随后采取的处置：

| 审计发现 | 处置 |
|---|---|
| 编排层原因阶梯里多一条 `pending`/`skipped` 分支，与界面**同一条「没跑过」的行给出不同文案**（服务端「该行还没有跑过」vs 界面「工作区未就绪」） | **修**：删掉服务端那条分支（`pending` 行的 `baselineCommit` 必然是空串，落到的正是「工作区未就绪」），两边文案此后逐字相同；两条服务端用例的断言同步改成 `/工作区未就绪/` |
| 四处兜底 `return` 今天**不可达**（只在判据新增条件时才可达），我此前把服务端那条写成「删掉之后变成可达」，与代码相反 | **修**：代码保留兜底但把注释改成「今天不可达、判据新增条件时才走到这里」；note 里那句写反的话改正 |
| `settleAgentJudgeStop` / `catch` 分支的注释仍称「界面要靠 `stage` 决定给不给重新评分」 | **修**：改成纯叙述口径，并注明不参与任何按钮判定 |
| 若干测试注释仍以「必须造评分失败的行」「判据据此把重新评分挡在外面」当理由（`orchestrator-{retry,rescore}.test.ts`、`eval-row-card.test.tsx`、`run-detail-panel.test.tsx`） | **修**：理由改成「造一条有产出的行」，`stage` 断言注明是叙述面 |
| `README.md` 一条 bullet 被前一次编辑并进了上一行（渲染层丢了一条列表项） | **修**：补回换行 |
| 旧 name / 旧口径只出现在 `docs/superpowers/{specs,plans}` 的历史决策文档里 | **不动**（那是当时的决策记录，改了反而失真） |
| `REEVALUABLE_ROW_STATUSES` 在代码/夹具/e2e 里 0 引用；没有任何调用方仍假设「judged 行两个按钮禁用」 | **无需处置**（另：`isRunnableRow` 仍然排除 `judged`，那是「开始」按钮的判据，与本次两条无关） |

## 6. 已知残留（本轮**没有**修）

1. **`settling` 窗口仍是「界面可点、点下去 409」**：`rescoreRow` / `retryRow` 在编排层还有一条界面看不见的判据
   （`rowAborts` 里还有这一行的条目 ⇒ 上一次运行还没收尾 ⇒ `CONFLICT`「该行上一次的运行还没收尾，请稍候再试」）。
   2026-09-28 判据放宽之后，进得来这个窗口的行**变多了**（此前只可能是「评分阶段失败」的终态，现在是任意
   「跑过一次且有产出」的终态）——例如评分落 `failed` 之后 `runRow` 还在自动重试的退避里
   （`JUDGE_PARSE_FAILED` 是瞬时码）。既有的实测用例
   「上一次的运行还没收尾（评分失败后还在自动重试的退避里）→ 拒绝重评」仍然绿。
   **没有修**的原因：界面那份判据只看行字段，看不见编排层的在途任务表；要闭合它得让快照多一格「还在收尾」
   或让界面订阅在途状态——那是另一个改动，本轮不动。
2. **`error.stage` 今天没有任何控制流读者**：它仍然落盘（契约与单测都还钉着形状），
   但两个判据都不读它了。如果哪天要删这一格，先确认没有新的判据依赖它；留着它的唯一理由是排障。
