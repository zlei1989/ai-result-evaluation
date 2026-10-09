# 冒烟记录：agentProvider.run 能力扩展 + 评分思考强度（2026-10-07）

计划：`docs/superpowers/plans/2026-10-07-agent-run-capability-and-judge-effort.md`
spec：`docs/superpowers/specs/2026-09-22-features-design.md`（§5.6.4 结构化评分输出 · §5.5.1 两条评分通路 · §5.5.2 评分的思考强度 · §7.2 契约）

## 一、范围清单

| # | 项 | 结果 |
|---|---|---|
| 1 | 设置页「评分配置」有「思考强度」一格（在「默认评分模型」下方），初始为「未指定」 | ✅ |
| 2 | 点开该格的候选域与后端 `requireJudgeEffort` 同源 | ✅ 候选恰为 `['off','low','medium','high','max']`（规范五档）；当时 `defaultJudgeAgent = codex`，其域含五档 ⇒ 交集 = 五档 |
| 3 | 选中 `max` ⇒ 落盘 | ✅ `config.json` 的 `settings.defaultJudge.effort = "max"`（文件无 BOM，时间戳与操作一致） |
| 4 | 重评一行 ⇒ 新分数带上强度记账 | ✅ `run.json` 的 `rows[6322a846].score.judgeEffort = "max"` |
| 5 | **旧数据向后兼容** | ✅ 同一次运行里另外三行（Task 5 之前评的）仍是 `judgeEffort: null` ⇒ `.nullable().default(null)` 的读回语义成立 |
| 6 | 评分详情抽屉顶部「候选运行信息」五格 | ✅ 见证据表，与 `run.json` 逐字互证 |
| 7 | 评分者那一行显示思考强度 | ✅ 「… · 思考强度：max」，与落盘值互证 |
| 8 | 清空强度 ⇒ **键消失**（不是写 `undefined`） | ✅ Clear 后 `defaultJudge` 只剩 `{providerId, modelId}`；配置已还原到冒烟前状态 |
| 9 | 智能体评分通路（`useAgentJudge: true`）的强度记账 | ⏭️ 跳过：现网 13 个运行**全是文本通路**，构造智能体通路要另跑一轮真实用例（见未覆盖项） |
| 10 | `tokens: null` 的行显示「用量未采集」而非「输入 0 tok」 | ⏭️ 跳过：被检查的运行 4 行**都有 tokens**，现网没有 `tokens: null` 的行（见未覆盖项） |
| 11 | Task 11 的评分阶段终止 race | ⏭️ 跳过：要专门构造"评分卡住 + 点终止"（单元测试已覆盖，见未覆盖项） |
| 12 | light / dark 两套主题下的抽屉外观 | ⏭️ 跳过：只看默认主题（样式只走 antd token，无手写值，风险低） |

## 二、操作路径

1. `http://localhost:3083/settings` → 展开「评分配置」（折叠面板，默认收起）
2. 「思考强度」→ 下拉 → 选 `max`（设置是 **onChange 自动保存**，页面没有保存按钮）
3. `http://localhost:3083/runs?panel=detail&id=78ef5b58-3d6a-473c-9354-80539b8a6fd1` → 第 1 行的「重新评分」
   - ⚠️ **会弹确认框**（「重新评分这一行？只重跑评分步骤…」）⇒ 必须点「确定」，否则什么都不发生
4. 等评分落地 → 同一行的「评分详情」→ 抽屉顶部即「候选运行信息」
5. 回设置页 → 「思考强度」的 Clear（有值时才出现）→ 键从磁盘消失

## 三、证据（浏览器 + CLI 互证）

| 抽屉显示 | `run.json` 落盘 | 一致 |
|---|---|---|
| 智能体：`Claude Code` | `agentKind: "claude-code"` | ✅（中文标签 ↔ 枚举值） |
| 模型：`deepseek-flash` | `modelId: "deepseek-flash"` | ✅ |
| 思考强度：`未指定` | 该行的 `effort` 为空（候选 agent 的强度） | ✅ |
| 用量：`输入 32,167 tok · 缓存 61,696 tok · 输出 7,620 tok` | `tokens: {input: 32167, cached: 61696, output: 7620}` | ✅ 逐字 |
| 耗时：`39s` | `durationMs: 39399` | ✅ |
| 评分者行：`… · 思考强度：max` | `score.judgeEffort: "max"` | ✅ |

磁盘事实（CLI）：
- `~/.aieval/config.json`：配 `max` 时 `settings.defaultJudge.effort = "max"`；Clear 后该键**不存在**；文件无 BOM。
- `D:\.tmp\aieval\runs\78ef5b58-…\run.json`：被重评的行 `judgeEffort = "max"`，其余三行 `null`。

## 四、未覆盖项与后续

1. **智能体评分通路**（`defaultJudgeAgent` 驱动的 `judgeRowByAgent`）：单元测试覆盖了透传与记账，但**真机未跑**。后续：把某个用例的 `useAgentJudge` 打开跑一轮即可闭合。
2. **`tokens: null` 的「用量未采集」分支**：需要一条没有用量的行（例如适配器不报量的情形）。单元测试有对照用例（`:367` 未采到 / `:409` 真的 0）。
3. **`off` 档位的端到端**：只在候选列表里见到，没有实跑。真机探针（`packages/server/agents/probe/v8/REPORT.md`）已独立确证 `off` 能关掉思考（两协议 0 字符）。
4. **Task 11 的终止 race**：需要"评分卡住 + 用户点终止"的时序，编排层单元测试（`orchestrator-abort.test.ts`，11/11）覆盖。
5. **强度档位的实际效力**：探针结论是**未能证实**（同档抖动 ≥ 档间差），界面只展示"我们要求的档位"，不承诺效果。

---

## 五、补记（2026-10-08）：评分者那一行的「思考强度」挪到「模型」之后

上面第 7 项与证据表最后一行记的是**初版位置**（接在末段）。用户 2026-10-08 改口径：它要与「模型」
连着读（「这一分是谁、以什么档位打的」），「输出约束 / 评分时间」是我们这边的执行事实，接在它后面。
顺带与顶部候选那三格（智能体 → 模型 → 思考强度）顺序对齐，两处不再各排一套。

- **范围**：① `score-detail-view.tsx` 评分者那一行改为
  `评分智能体：X · 模型：Y · 思考强度：Z · 输出约束：… · 评分时间：…`（文本通路同理，`评分模型：X`
  开头）；② 用例逐字钉住新顺序，并补一条**位置判据**（`/· 思考强度：未指定 · 输出约束：/`——
  只断 `· 思考强度：未指定` 的话，挪回末尾仍然全绿）；③ spec §7.3 记本次口径变更。
- **操作路径**：`http://localhost:3083/runs?panel=detail&id=071b7d32-d354-4ea0-ab33-77f86d876036`
  → 右栏「评分详情」→ 读抽屉底部那一行。
- **证据**：真实浏览器读回 `评分智能体：Codex · 模型：deepseek-flash · 思考强度：max · 输出约束：schema 约束 · 评分时间：2026-10-08 06:13`
  （同一抽屉里 `score.judgeEffort = "max"`、`judgeAgentKind = codex`）；
  单测 `packages/client/ui/src/composite/score-detail-view.test.tsx` 20/20；
  **变异验证**：把那一格还原到末段 ⇒ 4 条红（含新加的位置判据），还原后哈希 `88F6454…` 与改前一致。
- **未覆盖**：`light` / `dark` 两套主题（本改动只动文本顺序，无样式），以及顶部候选那几格的形态
  （同一天另有在途工作）。

---

## 六、补记（2026-10-08）：评分详情顶部改为**评分自己**的运行信息（口径反转）

用户口径：「评分详情抽屉里面的智能体和模型用量信息都应该是**评分**产生的，不是执行产生的」。
上面第 6 项与 §五 记的都是**被评那一行**（`EvalRow`）的五格——那正是本次要拆掉的东西：
抽屉叫「评分详情」，而读者拿**执行**的花销（`EvalRow.durationMs` 契约里就写明不含评分阶段）
去理解评分，是一处看不出来的错位（2026-10-07 的夹具与验收截图现在都成了反例）。

- **范围**：
  ① 落盘：`ScoreResult` 新增 `judgeTokens`（`{input,cached,output} | null`）与 `judgeDurationMs`
  （`number | null`），都 `.default(null)` ⇒ 老记录读回是「未采集」，`listRuns()` 不会跳过那一轮；
  ② 采集（两条通路各自表一次态）：文本侧 `text-api.ts` 的 `callTextApiConversation` 改交
  `{ text, usage }`（两协议的用量字段各自映射；单轮入口形状不变），`judgeRow` **逐轮累加** +
  从进函数起掐表；智能体侧 `judgeRowByAgent` 取适配器自报的 `result.tokens` / `result.durationMs`；
  ③ 界面：抽屉顶部两行换成 评分智能体（文本通路写「文本 API」）/ 评分模型 / 思考强度 +
  评分用量 / 评分耗时，`ScoreDetailViewProps` **删掉 `row`**；底部那行只剩
  「输出约束 · 评分时间」（身份与强度不再重复，§五 那次挪位因此被整段取代）；
  ④ 文档：spec §7.2 记三次形态口径、§7.3 改写、§8.1 补两行判据。
- **操作路径**：`http://localhost:3083/runs?panel=detail&id=1de68c94-0e9b-4b1e-b56d-26b61a5f3911`
  → 右栏「重新评分」（弹出确认框 ⇒ 点「确定」；**只重跑评分，候选 agent 不再跑**）
  → 等 `已评分` → 同一行「评分详情」→ 读抽屉顶部两行与底部一行。
- **证据（浏览器 ↔ 磁盘逐字互证）**：
  - 重评前（老记录）：抽屉显示「评分智能体 `文本 API` · 评分模型 `deepseek-flash` · 思考强度 `未指定`」
    + 「用量未采集 / 耗时 未采集」——即 `.default(null)` 的读回语义在真机上成立；
  - 重评后：`run.json` 的 `rows[0].score` 落盘
    `judgeTokens = {input:859, cached:640, output:869}`、`judgeDurationMs = 3998`、
    `judgeAgentKind = null`、`judgeModelId = "deepseek-flash"`、`judgeEffort = "max"`；
    页面对应显示「输入 859 tok · 缓存 640 tok · 输出 869 tok」「耗时 4s」——**逐字一致**；
  - 同一页的行卡片仍是候选那一份（`tok 34,420` / `耗时 29s`），与抽屉里的评分花销（`859` / `4s`）
    **分得开**——这正是本次口径翻转要的效果；
  - 自动化：`pnpm typecheck` / `pnpm lint` 全绿；`pnpm test` = 227 files / 3031 passed（8 skipped）；
    **变异验证** 7 个变异体逐一被拦下并逐字节还原：文本侧不做减法、文本侧只记最后一轮、
    智能体侧写死 `null`、界面「没采到」写成 0、底部加回「思考强度」、页面重新传 `row`、
    契约去掉 `.default(null)`（跑手与变异体清单跑完即删）。
- **未覆盖**：
  1. **智能体评分通路（`judgeRowByAgent`）的真机读数**：本机最近一轮 agent 评分（`071b7d32`）是
     改动**之前**评的，`run.json` 里没有那两格；要闭合得再跑一次真实 codex 评分（分钟级 + 真实 token），
     本轮未跑。单测（`judge-agent.test.ts`）已用夹具的 `durationMs` 钉住「取自报值」这条口径。
  2. **`light` / `dark` 两套主题**：只看了当前主题（样式只走 antd token，无手写值）。
  3. 顶部那两格在**极窄抽屉**下的自然折行：`wrap` 是既有形态，未专门收窄窗口验证。
