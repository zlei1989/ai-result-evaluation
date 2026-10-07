# 冒烟记录：失败恢复出口的可用面（「重新评测」/「重新评分」只有失败时才给）— 2026-09-28

> ⚠️ **本文的口径当天晚间已被用户推翻**（「已出分、无报错时取消禁用」），下面的实测是**当时那一版**
> 判据的真实记录，留着当历史与回归基线；今天的口径与实测见
> [`2026-09-28-reopen-reevaluate-and-rescore-smoke.md`](2026-09-28-reopen-reevaluate-and-rescore-smoke.md)。
> 具体已不成立的是：§2 的「已经评测完成且没有报错 ⇒ 两个按钮都禁用」「候选 agent 阶段失败 ⇒ 只给重新评测」
> 「老快照不给重新评分」三格，§4 的 M2 变异读数（那条变异现在**不再**让用例变红：`judged` 已不是排除项），
> §1 里把按钮叫「重新评测」的那几行（要改叫「重新执行」）、§1 的「失败阶段是从终态推不出该给哪个按钮」
> 与「老快照读不到 `stage` ⇒ 重新评分不给」，以及 §7 的「『重新评分』按定义不给它了」。
> 本文的**页面实测读数**（DOM 文案、按钮 disabled 状态）保留原样——它们是那一刻的真实截图，
> 只是今天再去同一页会看到两个按钮都是可点的。
> 仍然成立的：按钮顺序、`Tooltip` 必须挂外层 `span`（FIX-6）、两个按钮的成本差。
>
> 目标页：`http://localhost:3083/runs?panel=detail&id=ae798e52-59df-4fa9-9d2b-dc89e5e98378`（三行全 `judged`）
> 与冒烟轮：`/runs?panel=detail&id=babf7c0d-2d14-4c16-9c82-2c421bf6b0e0`（本轮新建的失败行）
> 上位口径：`README.md` 的「⑤′ 重试：三种失败、三条出路」与 `packages/server/contracts/src/run.ts` 的两个判据。
> **只记实测值**；读不出来的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么（先说清判据，再看证据）

用户口径（原话）：「如果已经测试完成，并且没有错误，就不能重新评测。评分也是如此，只有评分失败报错，
才可重新评分。」落成两条判据 + 一处文案：

| # | 能力 | 判据（**只有一份**，界面与服务端共用） | 落点 |
|---|---|---|---|
| 1 | 「重新评测」只给**跑过但没跑成**的行 | `canRetryRow` = 不在跑 + 有基线 + 有 diff + 状态 ∈ {`failed`,`timed-out`,`canceled`,`interrupted`}（`judged` 被排除） | `contracts/src/run.ts` |
| 2 | 「重新评分」只给**评分那一段报过错**的行 | `canRescoreRow` = 不在跑 + 有基线 + 有 diff + `error.stage === 'judge'` | 同上 |
| 3 | 「失败发生在哪一段」必须落盘 | `EvalRow.error.stage`（`'agent' \| 'judge'`，**可选**：老 `run.json` 没有这一格） | `contracts/src/run.ts`、`evaluator/src/orchestrator.ts`（`RowOutcome.stage` → `settleStopped` / `settleFailed`） |
| 4 | 按钮文案与禁用原因 | 「重试」→「**重新评测**」；两个按钮的 Tooltip 与 `retryRefusal` / `rescoreRefusal` 逐条对应 | `ui/src/composite/eval-row-card.tsx` |
| 5 | 按钮顺序（用户指定） | 查看日志 / 查看改动 / **重新评测** / 评分详情 / **重新评分** | 同上（一条按可访问名取 DOM 顺序的守卫钉住） |

**为什么必须落盘「失败阶段」**：候选超时与评分超时落的行状态与归因码**逐字相同**
（`timed-out` + `AGENT_TIMED_OUT`）；候选 agent 起不来与评分模型起不来也都是 `failed` + `AGENT_FAILED`。
从终态本身推不出「该给哪个按钮」，猜错的代价是白烧一次分钟级的候选 agent。
老快照读不到 `stage` ⇒ 「重新评分」**不给**（不确认就不放行）。

## 2. 范围清单

| 项 | 判定 | 关键实测值 / 证据 |
|---|---|---|
| **已经评测完成且没有报错 ⇒ 两个按钮都禁用** | ✅ | 目标页三行全是 `judged`：每行 `重新评分` / `重新评测` 都是 `disabled`（DOM 实测 3×2 个按钮全 disabled） |
| 禁用原因**在真机上屏**（FIX-6 那条只能在真实浏览器里验的口径） | ✅ | 鼠标移到外层 `span` 上，浮层文字：`重新评分` →「已经评测完成、没有评分错误：只有评分失败才需要重新评分」；`重新评测` →「已经评测完成且没有报错：不需要重新评测」 |
| **评分阶段失败 ⇒ 两个出口都在** | ✅ | 冒烟轮：`status=failed`、`code=CONFLICT`、`stage=judge`、diff 有产出（`tok 19,853 / 轮次 3 / 耗时 15s`）；界面两个按钮都 `enabled` |
| 该行点「重新评分」**真的转下去**（判据不是纯装饰） | ✅ | `events.jsonl` 第 66 条：`[重新评分] 用户请求重新评分（模式：评分模型），本次不重跑候选智能体`；重评失败后仍是 `failed` + `stage=judge`（失败不静默） |
| **候选 agent 阶段失败 ⇒ 只给「重新评测」** | ✅ | 冒烟轮（行超时压到 6s）：`timed-out` + `AGENT_TIMED_OUT：超过该行的超时上限，已强制停止`、`耗时 9s`、diff 有产出；界面 `重新评测` enabled、`重新评分` disabled |
| 候选阶段失败行的禁用原因 | ✅ | 悬浮 `重新评分` 的外层 `span`：`这一行失败在候选 agent 阶段（评分没有跑过）：请用「重新评测」重跑整行` |
| 准备阶段就失败（工作区未就绪）的行 | ✅ | 冒烟轮第一步（仓库目录被移走）：`failed` + `NOT_A_GIT_REPO` + `stage=agent`、`baselineCommit` 空串、`diff` 为空 ⇒ 两个按钮都禁用（「先点「开始」跑一次」那一档） |
| `error.stage` 真的写进了新快照 | ✅ | 新 `run.json` 两个样本：`NOT_A_GIT_REPO` → `stage: "agent"`；`未配置评分模型` → `stage: "judge"`（都是本轮真实跑出来的，不是手改的） |
| 老快照（没有 `stage` 这一格）不崩、且不给「重新评分」 | ✅ | 目标页三行都是本轮之前落盘的记录（`error: null`，无 `stage`），页面照常渲染；判据单测另钉了「有 error 但没有 stage」那一档 |
| **按钮顺序 = 查看日志 / 查看改动 / 重新评测 / 评分详情 / 重新评分** | ✅ | 目标页真实 DOM：`["查看日志","查看改动","重新评测","评分详情","重新评分"]`，`getBoundingClientRect().x` 依次 891 / 962 / 1034 / 1106 / 1177（从左到右就是这一序） |
| 「评分失败 → 点重新评分 → 成功出分」 | ⏭ 未在真机复现 | 本轮为造 judge 失败把默认评分模型清空了，恢复配置后那一行已经不再是「评分失败」那一档（见 §6）。该路径由单测覆盖：`orchestrator.test.ts` 的「正例：评分失败的行重评出分」（断言分数落盘、候选 agent 一次都没再跑、日志追加、`[重新评分]` 标记） |

## 3. 环境

| 项 | 实测值 |
|---|---|
| 地址 | `http://localhost:3083`（`pnpm dev`，Next 16.2.7 Turbopack；改的是 `packages/**`，**重启过 dev server**） |
| 上游 | `likecode-llm-proxy-test.jd.com`（默认评分模型 `jd/GLM-5.3`，anthropic；候选行用 `DeepSeek-V4.1-Flash-a`） |
| 冒烟轮 | 用例「冒烟：失败行按钮面」（本地小仓库 `%TEMP%\aieval-smoke-repo`）→ 运行 `babf7c0d-2d14-4c16-9c82-2c421bf6b0e0`；**用例与临时目录已清理**，运行记录留在工作区里当证据（`C:\Users\zhanglei1120\.runs\babf7c0d-…`） |
| 配置改动 | 为造 judge 失败：`defaultJudge` 清空 → 实测后**已还原**成 `likecode / jd/GLM-5.3`；为造候选超时：`rowTimeoutMs` 6000ms → 实测后**已还原**成 1800000ms（`GET /api/settings` 复核过） |

## 4. 操作路径与证据互证

**路径 A：已完成的一轮（三行 `judged`）**

1. 打开目标页 → 2. 逐个悬浮 `重新评分` / `重新评测` 的外层 `span`。

| 侧 | 读数 |
|---|---|
| 页面 | 三行 `重新评分` / `重新评测` 全 `disabled`；浮层文案见 §2 第二行 |
| 盘上（`run.json`） | 三行 `status: judged`、`error: null`、`score` 非空（`attempts` 1 / 22 / 1——第三行是用户在上一轮反复重评测到成功的那一行） |

**路径 B：造一个「评分阶段失败」的行**

1. 「创建用例」填本地小仓库（`git init` 的临时目录）→ 2. 「创建评测」选该用例 + `DeepSeek-V4.1-Flash-a` →
3. 设置页把「默认评分模型」清空（这一轮刻意让评分那一步失败）→ 4. 「开始」→ 5. 等候选跑完。

| 侧 | 读数 |
|---|---|
| 页面 | 卡片：`失败` + `CONFLICT：未配置评分模型：请先到「设置 → 评分配置」里选择默认评分模型`，`tok 19,853 / 轮次 3 / 耗时 15s`；两个按钮**都可点** |
| 盘上 | `status=failed`、`error.code=CONFLICT`、**`error.stage=judge`**、`diff` 非空（`baselineCommit` 非空） |
| 服务端日志/事件 | `events.jsonl` 里 `error` → `status/failed` → `end/error` 的顺序与既有口径一致 |

**路径 C：那一行点「重新评分」**（判据说可点 ⇒ 端到端真的通）

| 侧 | 读数 |
|---|---|
| 页面 | 二次确认文案：`重新评分这一行？/ 只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。`；确认后卡片进入 `评分中` |
| 盘上 | `events.jsonl` 第 66 条 `[重新评分] 用户请求重新评分（模式：评分模型），本次不重跑候选智能体`；收尾仍是 `failed` + `stage=judge`（默认评分模型仍是空的，重评必然失败——这正是「出口不静默」的实测） |

**路径 D：造一个「候选 agent 阶段失败」的行**（同一行，把行超时压到 6 秒后点「重新评测」）

| 侧 | 读数 |
|---|---|
| 页面 | 卡片：`已超时` + `AGENT_TIMED_OUT：超过该行的超时上限，已强制停止`、`耗时 9s`；`重新评测` 可点、`重新评分` 禁用（浮层文案见 §2） |
| 盘上 | `status=timed-out`、`error.stage=agent`、`diff` 非空、`baselineCommit` 非空 |

**路径 E：准备阶段失败**（先把仓库目录改名移走，再点「开始」）

| 侧 | 读数 |
|---|---|
| 盘上 | `status=failed`、`error.code=NOT_A_GIT_REPO`、**`error.stage=agent`**、`baselineCommit` 空串、`diff` 为空 |
| 页面 | 两个按钮都禁用（工作区未就绪那一档的原因文案） |

## 5. 变异验证（守卫必须见过红）

| 变异 | 期望 | 实测 |
|---|---|---|
| M1：`canRescoreRow` 去掉 `row.error?.stage === 'judge'` | 契约 / 界面两组红 | ✅ 7 failed（judged 行、候选阶段失败行、老快照三条全红） |
| M2：`canRetryRow` 去掉 `REEVALUABLE_ROW_STATUSES.includes(row.status)` | judged 行那两条红 | ✅ 3 failed（`canRetryRow > 已经出分…不可重新评测` 等） |
| M3：`settleStopped` 不再把 `outcome.stage` 拼进 error | 阶段落盘断言红 | ✅ 1 failed（`非瞬时面（AUTH_FAILED）…` 的 `error.stage` 断言） |
| M4：`runRow` 的阶段推导硬编码成 `'agent'` | 评分阶段那条断言红 | ✅ 1 failed（`结构修复回问模型时…` 的 `error.stage === 'judge'`） |
| M5：按钮文案改回「重试」 | 界面用例红 | ✅ 10 failed（按可访问名找不到按钮） |
| M6：把「重新评测」挪回「评分详情」后面（顺序退回旧版） | 顺序守卫红 | ✅ 1 failed（`按钮顺序：查看日志 / 查看改动 / 重新评测 / 评分详情 / 重新评分`，`expected [ Array(5) ] to deeply equal [ Array(5) ]`） |
| 还原 | `run.ts` / `orchestrator.ts` / `eval-row-card.tsx` 的 SHA256 与变异前**逐字相同** | ✅（三个文件各比对过一次；M6 用文件副本还原后 `eval-row-card.tsx` 的 SHA256 = `5C8795FC…80CF9`，与变异前一致） |

## 6. 全量测试的噪声（与本轮改动无关，逐条隔离复跑全绿）

`pnpm vitest run --reporter=json` 两轮（第二轮的测试总数比第一轮多 1：本轮新加了一条老快照的判据用例）：
第一轮**收集 1509、passed 1486、failed 23**；第二轮**收集 1510、passed 1486、failed 24**（改动冻结后的最终一轮）。
两轮的失败文件集合基本重合、逐条漂移，且全部落在两类噪声上，
**没有一条属于本轮的判据 / 落盘 / 界面改动**（本轮相关的 5 个测试文件在两轮里全绿）：

| 类别 | 失败文件（条数，两轮合计） | 隔离复跑 |
|---|---|---|
| 真 git 夹具的超时 / Windows 文件占用（`git clone` 满载时 30s+；`renameSync` 撞 `EPERM`） | `core/mirror`(2+2)、`core/workspace`(3+4)、`api/cases`(1+1)、`api/run-artifacts`(0+1)、`web-next/route-cases`(2+3)、`web-next/route-run-artifacts`(1+1) | ✅ `mirror + workspace + api cases` 121 passed；`route-cases + route-run-artifacts` 29 passed；`api run-artifacts + ui run-create-panel` 33 passed |
| 组件用例的超时（antd 浮层 + 满载 CPU） | `ui/provider-form-modal`(5+5)、`ui/run-create-panel`(6+7)、`ui/case-form-panel`(1+1) | ✅ 三个文件 75 passed；`run-create-panel` 单独再跑 33 passed |
| 与上游 CLI 版本相关的权限档断言（只出现在第一轮，第二轮没复现） | `agents/claude-code/index`(2) | ✅ 14 passed |

> 这两类噪声在 2026-09-27 的记录里已经登记过（`git stash` 回基线复验：同样的失败）。
> 本轮的判据改动**不碰** agents / core / git 夹具，也不碰 provider / case / run-create 表单。

## 7. 未覆盖项与后续

1. **「评分失败 → 重新评分成功出分」没在真机复现**（§2 最后一行）：本轮为造 judge 失败清空了默认评分模型，
   等配置还原时那一行已经是 `timed-out`（候选阶段失败）——「重新评分」按定义不给它了。
   复现它需要再跑一次候选 agent（分钟级）+ 一次真实评分，本轮按「不重复消耗上游」跳过；
   该路径由 `orchestrator.test.ts` 的「正例：评分失败的行重评出分」覆盖，且本轮已实测
   「判据说可点 ⇒ 端点真的收下了这次请求」（路径 C）。
2. **没有真实上游抖动**：本轮两次失败都是**人为造的**（清空评分模型、把行超时压到 6 秒），
   没有等一次真实的上游 500 —— 目标是「按钮的可用面」，不是「上游失败的归因」，故没有造真实故障。
3. **清理已在实测后完成**：`defaultJudge` / `rowTimeoutMs` 已还原（`GET /api/settings` 复核），
   冒烟用例与两个临时目录已删除；冒烟轮 `babf7c0d-…` 留在工作区当证据（它的用例已删，
   所以那一行现在只能看、不能再重跑——这正好也是既有口径「用例被删之后只能看」的实测形状）。
4. **证据路径后来不再可达（如实登记）**：本文写作之后，使用者把「工作区根目录」改成了 `D:\export\runs`
   并清掉了旧根 `C:\Users\zhanglei1120\.runs` 下的轮次 ⇒ 上面引用的 `run.json` / `events.jsonl` 路径
   （`ae798e52…`、`babf7c0d…`）现在打不开了。**当时的读数是真的**（逐条抄自上表），但复现要在
   当时那个根下；同一天在新根下又做了一次轻量复核：真实 `AUTH_FAILED` 的失败行上，
   `重新评测` 可点、`评分详情` / `重新评分` 禁用，悬浮原因仍是
   「这一行失败在候选 agent 阶段（评分没有跑过）：请用「重新评测」重跑整行」，且按钮顺序与 §2 一致。
