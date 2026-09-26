# 评分体系重构 · 端到端冒烟记录（2026-09-30）

> 本次冒烟的对象：把「固定 5 维、每维 1–5 分、等权」换成「组 → 评分项（ID / 目标 / 权重）+ 每项二元判定 + 总分 = 达成项权重之和」之后，
> **整条链**（表单 → 落盘 → 起跑 → 评分 → 展示）是否真的按新口径工作。计划见 `docs/superpowers/plans/2026-09-29-rubric-scoring.md`（Task 9 Step 5）。
> 一句话结论：**1 个半小时的真实操作（含 4 次真实模型调用、1 次真实 agent 跑）全部落在预期上**；
> 唯一没实测到的是「智能生成往同名组末尾追加」那一支（模型判定当前表已覆盖本题，走的是「未新增条目」分支，见 §4）。

## 1. 范围清单（逐项）

| # | 计划要求 | 结果 | 证据（§3 的对应条目） |
|---|---|---|---|
| 1 | 用例页 → 新建 → 「智能识别」→ 粘贴用户示例提示词 → 表格回填两组共 11 项，表尾「满分 100 分 · 共 11 项」 | ✅ | E1 / E2 |
| 2 | 「智能生成」→ 新增项落在同名组末尾（或提示「未新增条目」） | ✅（**走的是「未新增」分支**） | E3 / E4 |
| 3 | 手工改一格权重 → 表尾汇总实时变 | ✅ | E5 |
| 4 | 保存用例 → 重新打开详情 →「评分标准项」卡片显示同一张表 | ✅ | E6 / E7 |
| 5 | CLI 复核 `config.json` 里该用例的 `rubric` 与界面一致 | ✅ | E7 |
| 6 | 跑一轮评测 → 评分详情逐项达成/未达成、总分 = 达成项权重之和 | ✅ | E8 / E9 / E10 |
| 7 | 改用例的评分表 → 历史记录不变（`run.json` 的 `rubric` 快照仍是旧的） | ✅ | E11 / E12 |
| 8 | 结果写进本文件（四要素） | ✅ | 本文件 |

> **上表 1–8 行是计划 `Step 5` 的六项要求**（第 1 行与第 2 行各拆成两行，故 6 项占 8 行）。**下面 9–13 行是自查补充项**——计划没要求，是执行者按「还有哪些没走到」自己列的，用于说清未覆盖范围。

| # | 自查补充项（非计划要求） | 结果 | 理由（§4 的对应条目） |
|---|---|---|---|
| 9 | 走一遍「使用智能体评分」通路（开关打开） | ❌ 跳过 | 本次用默认的**文本通路**（`judgeAgentKind: null`）已经能证「逐项达成 + 权重求和 + 快照」三条主张；智能体通路的单测覆盖在 `evaluator/src/judge-agent.test.ts` + `orchestrator-*`，真机跑一次要再花一次 agent 成本（§4-1） |
| 10 | 点开两条**既有旧用例**（无 `rubric`）看「旧版数据」INTERNAL | ❌ 跳过 | 那两条是使用者既有数据，点开只会拿到错误提示、且我不改它们；该守卫有 `api/src/cases-crud-b.test.ts:132` 的用例覆盖（§4-2） |
| 11 | 并行模式 / 多候选行 | ❌ 跳过 | 与本次评分口径无关（执行模式在重构前就有），单候选串行足以走完链路（§4-3） |
| 12 | 「重新评分」读快照 | ❌ 跳过 | E11 已用更强的方式证同一条口径（快照里的 A1 仍是 **18**，而用例当前表已改成 **25**，两者**内容不同**、历史分数不变）；rescore 的读快照有 `orchestrator-rescore.test.ts` 覆盖（§4-4） |
| 13 | 暗色主题 / 抽屉几何 | ❌ 跳过 | 与评分口径无关（§4-5） |
| 13 | 几何断言（`getBoundingClientRect`） | — 不适用 | 本次没有触碰任何抽屉/表格几何（AGENT.md 的几何要求在改几何的任务里执行） |

## 2. 环境与操作路径

**环境**

- 服务：`corepack pnpm --filter @aieval/web-next dev`（= 根 `pnpm dev` 的那条脚本，`next dev -p 3083`）→ `✓ Ready in 7.9s`，http://localhost:3083 。
  > ⚠️ 根脚本 `pnpm dev` 是 `pnpm --filter …`，而**嵌套的裸 `pnpm` 是 11.7.0**（本仓 pin 11.18.0）⇒ `corepack pnpm dev` 直接以 `[ERROR] This project is configured to use 11.18.0 of pnpm` 退出 1。故改用等价的 filter 形式（同一个脚本、同一个端口）。
- 评分配置：全局默认评分模型 = `likecode` 供应商 / `jd/GLM-5.3`（真实内网中继）；两条用例都在**真实** `~/.aieval/config.json` 上跑（未动既有的 2 条旧用例）。
- 候选仓库：为本次冒烟建的最小本地仓库 `D:\export\t9-smoke-repo`（`master`，初始提交 `d647a3904e2df203320827cce476f48a4009380f`）。
- 落盘根：`D:\export\runs`（使用者的真实工作区根）。
- 新建的用例：`eb6b2d9a-b16a-4541-8adc-5d02a6396892`「【Task9 冒烟】评分表全链」。
- 评测轮：`3f9d40a2-d630-4383-b549-7c9e300e2734`，单候选 `claude-code` + `jd/GLM-5.3`，串行，默认（文本）评分通路。

**操作路径**（点/输入序列，`data-testid` 为实际落点）

1. `/cases` → 点「创建用例」（`cases-create`）→ 右侧栏切到新建表单。
2. 点「智能识别」（`case-recognize-rubric`）→ 弹窗（`rubric-recognize-text`）粘贴用户示例提示词（`~/.aieval/config.json` 里旧用例那段 Markdown 原文，898 字符，4 列 11 行）→ 点「识别」（`rubric-recognize-submit`）。
3. 填 标题（`case-title`）/ 考题提示词（`case-task-prompt`）/ 代码仓库（`case-repo-path`，`D:\export\t9-smoke-repo`，来源类型「本地目录」）→ 点「校验」（`case-validate-repo`）→ 出现「仓库：t9-smoke-repo · 当前分支：master」。
4. 点「智能生成」（`case-generate-rubric`）→ 按钮进 loading（实测 107s）→ 弹出「当前评分标准项已覆盖本题，未新增条目」。
5. 把 A1 的权重 18 改成 30（`rubric-item-weight-0-0`）→ 表尾即时变「满分 112 分 · 共 11 项」→ 改回 18（表尾回到 100）。
6. 点「确定」（`case-submit`）→ 跳到 `/cases?panel=detail&id=eb6b2d9a…`，「评分标准项」卡片渲染只读表格 + 表尾「满分 100 分 · 共 11 项」。
7. `/runs` → 点「创建评测」→ 选用例「【Task9 冒烟】评分表全链 · t9-smoke-repo · 默认分支 HEAD」、执行模式保持「串行」、行内 智能体 = Claude Code、模型 = `jd/GLM-5.3`、**「使用智能体评分」保持关闭** → 点「确定」。
8. 评测详情 → 点「开始」→ **确认框**「开始执行这一轮评测？」（列出「本次将执行 1 个候选：· Claude Code · jd/GLM-5.3」）→ 点框内的「开始」。
9. 等行跑完（约 1 分钟）→ 点该行的「评分详情」→ 抽屉逐项列出 11 项（达成/未达成 + 理由）+ 顶部总分。
10. 回 `/cases?panel=detail&id=eb6b2d9a…` → 点「编辑」（`case-detail-edit`）→ 把 A1 权重改成 25 → 点「确定」（`case-submit`）。
11. 重新加载评测详情 → 再点「评分详情」→ 抽屉仍显示 A1「18 分」、满分 100、总分 22。

## 3. 证据（浏览器 + CLI 互证）

> 浏览器侧的值由 `browser_evaluate` 从真实 DOM 读出（输入框 `value` / 表格 `innerText` / `data-testid` 节点），CLI 侧由 `node -e` 直接读 `~/.aieval/config.json` 与 `run.json`。两边的数字逐项对齐才算过。

**E1 · 识别分支的请求/响应（真实模型调用）**

- 服务端日志：`POST /api/cases/generate-judge-prompt 200 in 50s (application-code: 50s)`
- 请求体（浏览器网络面板）：`{"rubric":{"groups":[]},"taskPrompt":"","prompt":"评估代码开发质量，满分100分。…","repoPath":""}`
  ——`repoPath` 是**空串**：识别分支不碰仓库（spec D10）。
- 响应体：`{"rubric":{"groups":[{"name":"一、生产代码","items":[A1…C1]},{"name":"二、测试","items":[D1…D6]}]},"addedItems":0}`

**E2 · 回填后的表格 = 用户示例逐项相等**

| 组 | 项（ID → 权重） | 小计 |
|---|---|---|
| 一、生产代码 | A1→18, A2→4, B1→20, B2→3, C1→3 | 48 |
| 二、测试 | D1→14, D2→10, D3→5, D4→4, D5→13, D6→6 | 52 |

- 表尾（DOM 原文）：`满分 100 分 · 共 11 项`
- 与示例的差别只有一处、且是**设计内的**：示例的「改动项」「改动目标」两列被合成一列（`goal`，用「——」连接），即 spec §3 的 D1b（表格三列 `ID / 目标 / 权重`）。

**E3 · 生成分支的请求/响应**

- 服务端日志：`POST /api/cases/generate-judge-prompt 200 in 107s`
- 请求体：携带**当前 11 项表格** + `taskPrompt` + `repoPath`，`prompt: ""`（生成分支）。
- 结论：`addedItems === 0` ⇒ api 返回 `note: '当前评分标准项已覆盖本题，未新增条目'`（`packages/server/api/src/judge.ts:85`）。

**E4 · 界面把「零新增」说清楚了（不是静默无反应）**

- 浏览器 DOM 捕获到的 message 浮层文案：`当前评分标准项已覆盖本题，未新增条目`
- 同时刻表尾仍是 `满分 100 分 · 共 11 项`、权重仍是 `18/4/20/3/3/14/10/5/4/13/6`（生成没有偷偷改表）。

**E5 · 表尾汇总是实时的**

- 改 A1 18→30 后：`满分 112 分 · 共 11 项`（100 − 18 + 30 = 112）
- 改回 18 后：`满分 100 分 · 共 11 项`

**E6 · 保存与详情**

- 服务端日志：`POST /api/cases 201 in 959ms` → `GET /api/cases/eb6b2d9a-… 200`
- 详情页「评分标准项」卡片：组名 `一、生产代码` / `二、测试`，末行 `D6 · … · 6`，表尾 `满分 100 分 · 共 11 项`。

**E7 · CLI 复核落盘（`~/.aieval/config.json`）**

```text
cases total: 3 | found: true
title: 【Task9 冒烟】评分表全链
repoPath: D:\export\t9-smoke-repo | commitHash: null | repoBranch: null
has judgePrompt field: false                 ← 旧字段已从落盘形状里消失
groups: 一、生产代码(5) + 二、测试(6)
ids: A1,A2,B1,B2,C1,D1,D2,D3,D4,D5,D6
weights: 18,4,20,3,3,14,10,5,4,13,6 | sum: 100 | count: 11
legacy cases (no rubric, pre-existing): 2 229bef96-…,c9660aa1-…   ← 既有旧用例未被改动
```

**E8 · 起跑一轮（真实 agent）**

- 服务端日志：`POST /api/runs 201 in 13ms` → `POST /api/runs/3f9d40a2-…/start 200 in 5.9s`
- `run.json` 的轮级快照（创建即写下，评分阶段读它）：`rubric` = 2 组 11 项、权重与用例逐项相等、`max: 100`；`repoBranch: null`；单行 `claude-code / jd/GLM-5.3`。
- 行终态（CLI 轮询 `run.json`）：`run=done row=judged attempts=1 turns=3 diff={filesChanged:1,insertions:32,deletions:0} tokens={input:31715,cached:17664,output:1132} durationMs=46405`。

**E9 · 总分 = 达成项权重之和（CLI 独立复算，不复用产品代码）**

`node -e` 里把「引用键规则」重写了一遍（有 `id` 用 `id`，空 `id` 用位置 `#k`），再与判定逐项对：

```text
rubric items: 11 | maxScore(rubric): 100 | score.maxScore: 100 | match: true
achieved: A1(18) + A2(4) => sum: 22
score.totalScore: 22 | match: true
judgments: 11 | covers every rubric key: true
judgedAt: 2026-09-30T07:53:26.849Z | judgeModel: jd/GLM-5.3 | judgeAgentKind: null | provider: d226add6-…
```

即：11 项里 **A1（18）与 A2（4）达成**、其余 9 项未达成；总分 22 = 18 + 4。
（这正是本次考题刻意的设计：题面只要求新建含 `agent` 字段与 `@param agent` 的 DTO，命中 A1/A2，其余项必然未达成 ⇒ 总分既不是 0 也不是满分，能区分「求和」与「数项数」「按比例」等错误实现。）

**E10 · 界面上逐项展示（评分详情抽屉）**

```text
22
满分 100 分 · 共 11 项
一、生产代码
A1  `FileChangeLogItemDTO` 追加 `agent` 字段，让 `agent` 进入对外契约      18 分  达成   <理由>
A2  同文件 Javadoc 补 `@param agent`，声明字段语义与取值来源              4 分   达成   <理由>
B1  `GitCommitServiceImpl.toDTO()` 补 `m.agent()`，让 ES 数据真正流到响应   20 分  未达成 <理由>
…（C1 / D1–D6 同为「未达成」）
```

- 行卡片摘要：`第 1 名 Claude Code · jd/GLM-5.3 likecode 已评分 … 轮次 3 耗时 46s 得分 22`
- 达成项数（DOM：`[data-achieved="yes"]`）= **2**，与 E9 的 `achieved` 列表一致。

**E11 · 改用例的评分表（A1 18 → 25，界面操作）**

- 服务端日志：`PUT /api/cases/eb6b2d9a-… 200 in 507ms`
- CLI：`case A1 weight now: 25`（用例侧确实变了）

**E12 · 历史记录**不变（本次重构的核心主张）**

```text
run.json rubric snapshot UNCHANGED after case edit: true   ← 与改动前保存的快照「内容」相同（JSON 等值比较）
run.json A1 weight: 18 | case A1 weight now: 25
run.json score still: 22 / 100 | judgedAt: 2026-09-30T07:53:26.849Z | run status: done
```

> **证据强度的准确说法**：上表那条 `true` 来自「编辑用例前后各读一次 `run.json` 的 `rubric`，把两次 `JSON.stringify` 的结果比较」——它证明的是**快照内容未被改写**（这已足以支撑核心主张：评分阶段读的是轮级快照、编辑用例不回头改历史），但**不等于文件字节级相同**（键序/空白归一化在这条比较里看不出来）。
> 若要更强的字节级证据，应在编辑前后各取一次文件哈希（`Get-FileHash`）而不是比较重新序列化的字符串。本记录的判据是前者，故不写成「逐字节」。
> 与之互补的是下面这组**内容确实不同**的对照：用例当前表 A1 = **25**、这一轮快照 A1 = **18**，两者不同 ⇒ 界面若读用例而非快照，就会显示 25 分。

- 浏览器复核：**重新加载**评测详情后打开「评分详情」，仍显示 `22` / `满分 100 分 · 共 11 项` / A1 `18 分`——界面读的是这一轮的快照，不是用例当前那张表。

## 4. 未覆盖项与后续计划

1. **「使用智能体评分」通路（开关打开）未真机跑**。本次证的是文本通路（`judgeAgentKind: null`、`useAgentJudge: false`）。两条通路在评分阶段共用同一把尺子（`run.rubric`）与同一份逐项解析，但「智能体在工作区里自己看代码」这段只有单测覆盖。若要在真机上证，开一次开关、用一次候选行即可（成本：一次 agent 跑）。
2. **「智能生成往同名组末尾追加」这一支没实测到**。模型对本题判定「已完备」（`addedItems: 0`），走的是 `note` 分支。要覆盖它需要一个当前表**明显不全**的用例（例如先只留一组一项，再生成）。
3. **既有旧用例（无 `rubric`）的读侧显式拒绝（INTERNAL「旧版数据」）未在真机点开**。观察到的只是列表与用例下拉**照常渲染**这两条旧用例（列表路径不做逐条校验——与实现一致）。守卫本身有 `api/src/cases-crud-b.test.ts` 的用例；使用者若要清理，按计划「已知的旧数据处置」删掉重建即可。
4. **「重新评分」未点**。E11/E12 已用「改表后历史不变」证了同一条读快照口径，而 rescore 的读快照行为由 `evaluator/src/orchestrator-rescore.test.ts` 覆盖。真机上点一次「重新评分」会把这一行的分数替换成新一次评分结果（预期内），本次刻意不花那笔钱。
5. **并行模式 / 多候选行 / 行级终止 / 日志抽屉**未覆盖：与本次评分口径无关，重构未触碰。
6. **主题（暗色）与窄屏下的评分详情**未覆盖：`ScoreDetailView` 的形态守卫在 `ui` 包内（含语义色），真机只看了默认主题。
7. **冒烟过程的一个环境事实（非缺陷）**：本机的 Playwright 浏览器是**多会话共享**的，期间另一会话三次把当前标签导航到它自己的应用（`localhost:3081`），导致第一次填好的表单丢失、需要重做（因此识别调用实际发生了 4 次：两次识别 + 两次生成，见 §3 的服务端日志）。**若换会话复跑**：一开始就用新标签、并在每步之后核对 `location.href`；另外「开始」按钮会先弹确认框，必须点框内的「开始」才会发 `start` 请求（第一次尝试就是漏了这一步，`run.json` 一直停在 `idle`，服务端日志里没有 `POST …/start`——这本身就是一条判据：**界面排队提示 ≠ 请求已发出**）。
