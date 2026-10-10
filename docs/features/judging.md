# 评分

## 定位

评分是一轮评测的第 7 步：把候选的**完整产出**（文本通路 = 裁剪后的 diff；智能体通路 = 候选自己的工作区）对照用例的**评分标准项表格**做逐项二元判定（达成 / 未达成），总分 = 达成项权重之和、满分 = 全部项权重之和，**模型不给总分**。两条通路（`judgeRow` 文本 API / `judgeRowByAgent` 智能体）共用同一把尺子：`parseJudgeResponse`（解析）+ `finalizeScore`（收口）+ `judgeStageAttempt`（执行骨架）。

## 页面形态与交互

- **用例表单**：评分标准项卡片（表格**常驻可见**，不藏弹窗）+ 三个按钮「智能生成 / 智能识别 / 智能调整」。未配置全局默认评分模型 ⇒ 三个按钮全部禁用 + Tooltip「请先到设置里配置默认评分模型」。
- **RubricTable**：受控二级表格（组 → 项），列 ID / 目标 / 权重；新项默认权重 1（0 非法）；重复 ID（trim 后比较）当场标红；表尾「满分 N 分 · 共 M 项」实时；`readOnly` 形态复用于用例详情。三道校验同一份 `validateRubric`：表格上方即时提示、表单提交拦截、服务端写侧。
- **识别弹窗**：只有一个多行文本域；**失败不关窗、不清文本**；识别中按钮禁用。
- **调整弹窗**（智能调整）：输入一句话 → 模型回整表 + 服务端 `diffRubric` 算改动清单（七类改动）→ **预览清单、点「应用」才回写**（不点应用表格不动；空表在调模型之前拒，不花额度）。
- **评分详情抽屉**（props 只有 `score` + `rubric`）：顶部两行是**评分自己**的运行信息（评分智能体（文本通路写「文本 API」）/ 评分模型 / 思考强度 + 评分用量 / 评分耗时）；中部逐项达成 / 未达成（缺判定项 `Tag warning`「缺少判定」不静默跳过）；总评；底部「输出约束（schema 约束 / 提示词约束）· 评分时间」；模型原始返回可见。**总分原样显示权威值，前端不重算；满分来自 `maxScore` 不是常量 100**。
- **设置页评分配置**：默认评分模型（跨协议候选）、思考强度（`allowClear`，清空 = 未指定）、默认评分智能体（协议不兼容项 `disabled`）、输出契约（只读文案）、diff 上限（KB 计，配置存字节，默认 256）。onChange 自动保存。
- **行卡片**：「重新评分」Popconfirm；「使用智能体评分」Switch（创建时快照、编辑可改）。

## 数据与契约

- **Rubric**：`{ groups: [{ name, items: [{ id, goal, weight }] }] }`。组不带权重；`weight` 正整数 ≤ `MAX_ITEM_WEIGHT = 10_000`（拦手滑多零与 safe integer 越界）；**schema 刻意不设 `.min(1)`**（空表是新建用例的真实初态），非空要求由 `validateRubric` 提交时给；空 id 项按位置引用 `#k`（全表顺序号、跨组连续）。
- **派生函数**：`rubricMaxScore`（空表 0）、`validateRubric`（中文报错点名组 / 项）、`composeTotalScore`（达成项权重之和，可 >100）、`renderRubricForJudge`（Markdown 二级表格：引用键 / 目标 / 权重，`|` 转义、换行压空格防列错位）、`diffRubric`（七类改动 + 三段式配对：id → goal 逐字 → 组内位置）。
- **ScoreResult**（12 格）：`judgments[]`（`{ id, achieved, reason }`）、`totalScore`、`maxScore`（满分快照）、`verdict`、`raw`、`judgeProviderId`、`judgeModelId`、`judgedAt`、`judgeAgentKind`（null ⇔ 文本 API）、`judgeEffort`（null ⇔ 我们没指定）、`structuredOutput`（记**骨架算出的「schema 真的下发给了适配器」**，不承诺上游照做）、`judgeTokens` / `judgeDurationMs`（评分自己的花销，与行卡片那份分开）。所有记账格 `.default(...)`——`run-store` 用 `safeParse` 读盘，必填新字段会让旧 `run.json` 解析失败 ⇒ `listRuns()` 静默跳过。
- **两投影同批替换**：`JUDGE_OUTPUT_CONTRACT`（提示词文本，作 system）与 `JUDGE_OUTPUT_JSON_SCHEMA`（结构化输出）是同一条契约的两个投影，改一份必须同批改另一份；两份里都**没有** `totalScore`；同形守卫从契约文本正则抽字段名与 schema 逐一对齐。
- **快照链**：`TestCase.rubric`（必填）→ 创建评测时快照进 `EvalRun.rubric` → 评分阶段只读 `run.rubric`。改用例的表**不影响**历史分数与其满分；重评分按**当前配置**的模型 / 智能体 / 强度打，但尺子（表）不变。
- **旧数据处置**：不删历史、不写迁移。旧用例在「用」的路径（详情 / 建评测 / 换用例 / 编辑保存）被拒（INTERNAL：`这个用例是旧版数据（没有评分标准项），请删除它或重新创建：<caseId>`）；**列表路径故意不拒**（否则一条旧用例让整页 500、连删除入口都没有）。
- **effort 档位**（文本侧 `reasoningFields(protocolType, effort)`，单轮 / 多轮共用）：

  | 档位 | openai 协议 | anthropic 协议 |
  ||---|---|
  | 未指定 | 一个键都不加 | 一个键都不加 |
  | `off` | `thinking: { type: 'disabled' }` | `thinking: { type: 'disabled' }` |
  | 其它档 | `reasoning_effort: '<档>'` | `output_config: { effort: '<档>' }` |

  智能体侧三家各管各的：claude `off` ⇒ `thinking: { type: 'disabled' }` + env 覆盖层；codex `off` ⇒ `effort: 'none'`（裸 `off` 网关拒、重试 6 次后 exit 1 ⇒ 映射必要）**同时** `model_reasoning_summary: 'none'`（空转）；dsh overlay 档位表 `off: null`、未指定落 `high`。`judgeEffort` 落盘语义：**记「我们要求的」档位，不是「实际生效的」**。关闭档文案是「`off（要求不思考）`」——claude/codex 选 off 后并没有真的停止思考，文案若写成「不思考」就是向用户断言一件假事。

- **结构化输出三家落点**：

  | kind | 能力 | 落点 | 结果出口 |
  ||---|---|
  | claude-code | true | `options.outputFormat` | 收尾消息 `structured_output`；与 `result` 不一致落 WARN 且以 structured_output 为准 |
  | codex | true | `turn/start` 一等字段 `outputSchema`（JSON-RPC，不落命令行） | 主会话答复文本写 `state.finalText` |
  | dsh | false | 无（SDK 客户端没有这一格） | 骨架摘格后照常跑，`structuredOutput = false` + 有痕降级日志 |

  三条硬约束：`input.outputSchema === undefined` 时一个字段都不加；不支持的家由骨架摘格照常跑不报错；降级留痕在拿到分之后判（不预读注册表）。

## 状态机与时序

- **第 7 步骨架**（`runJudgeStage`，两条通路共用）：`setRowStatus('judging')` → **空表兜底守卫**（`rubricMaxScore(run.rubric) <= 0` ⇒ `CONFLICT`：`这一轮用的评分标准项是空的，无法评分：这一轮的评分表在创建时就已快照，改用例不会影响它——请在用例里补上评分项后新建一轮评测`，**评分器一次都不调用**）→ 取同一份 config 快照 → `useAgentJudge` 分流 → `judgeStageAttempt` → 失败面折行终态（`AGENT_CANCELED` ⇒ canceled；其余 failed 且原样保留归因码）。
- **`judgeStageAttempt` 四件事**：迟到事件闸门（落定后收尾事件不再落盘）；用户终止归因（`userAborted` 记账）；**污染对照**（仅智能体通路：评分前后各算一次改动摘要，不一致 ⇒ 拿到分时该行判 `failed`，拿不到分只留痕）；终止 race（`Promise.race`，终止赢 ⇒ 不改状态、在途结果只落「`[已终止的尝试]`」日志；**宽限为 0**，孤儿 promise 先挂 `.catch`）。
- **文本通路**：提示词 = 题面 → `renderRubricForJudge(快照)` → diff（空 diff 显式写「（无改动）」）；结构检查不合格**回问**（`JUDGE_REPAIR_ROUNDS = 2`，即最多 3 次请求；反馈点名缺项 + 引用键 / 目标 / 权重清单）；调用失败（网络 / 鉴权 / 限流）**透传原错误码**、一次都不回问；`MAX_TOKENS = 16_384`。
- **解析唯一真源 `collectJudgeJudgments`**：剥围栏只剥整段的（中间夹散文不救）；**按引用键逐个取，缺一项即不合格**（`缺少对 <键>（<目标>）的判定：评分表里的每一项都必须恰好给出一条判定`）；多余判定忽略、重复键取第一条；`achieved` 宽容读（`"true"/"false"/"是"/"否"/"达成"/"未达成"`）；缺 verdict / reason 给占位文案（占位不是失败）。
- **智能体通路**：`getProvider(kind).run`，`permission: 'read-only'`（提示词「只读评审」是要求、这一格是强制）、`configHome` = 独立 `.judgehome`、`outputSchema` 总是传；**先判 `result.ok` 再读 `finalText`**（先读会把「没问到」当「答错了」）；`finalText === null` 与空答复两种 `JUDGE_PARSE_FAILED` 文案分开；评分智能体日志行带 `[评分智能体] ` 前缀（summary 不戴）；其用量不进行级三格，随分记 `judgeTokens` / `judgeDurationMs`。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| **网关透传 schema 不报错**（最高风险）：schema 落 wire 只是请求体一格，网关不认时模型照旧自由生成 | 可观测手段只有 `structuredOutput` 与 `score.raw`；不假设网关一定认 |
| **档位强度的效力未证实**（同档抖动不小于档间差） | 界面与契约只展示「我们要求的档位」，不给「高档=更准」的暗示 |
| **codex `off` 关不掉思考**（未闭合）：`effort:'none'` 网关 200 但照常推理（reasoning 条目与思考 token 都比未选档还多） | 「接受 ≠ 关闭」；codex 上当前没有可用的「关闭思考」旋钮 |
| claude `off` 的关停点在 env 覆盖层（CLI/SDK 层不认 `Options.thinking`） | claude 思考块在 UI 被 `foldMessages` 折叠抹掉（界面比真实产出少）——登记未修 |
| codex `model_reasoning_summary:'none'` 空转：注入了、既不报错也不影响推理产出 | 别指望它关掉什么 |
| 带 `outputSchema` 的一轮会偶发 180s 超时（未定位；同参数有时 1.7s 就收尾） | 已排除「字段被拒」「CLI 没发出去」；下一步带 relay 复现看 `response.completed` |
| **智能体评分通路真机未跑**（现网全是文本通路） | 单测覆盖透传与记账；闭合条件 = 开一次 `useAgentJudge` 跑一轮 |
| 请求侧 schema `achieved` 严档与解析侧宽容读**不对称是有意的**（拦身份 vs 拦形状，作用域不同） | 别「顺手对齐」；`"yes"` / `1` 不在宽容读的名单里 |
| `MAX_TOKENS = 16_384` 截断风险仍在（多项表的调整回复会被截断） | 症状 `JUDGE_PARSE_FAILED` + `raw` 断在半截 JSON |
| 文本通路本期不开 schema（有自己的回问修复机制）；评分三动作（生成/识别/调整）走非流式调用、**没有思考档位格** | — |
| 旧 `run.json`（带 `dimensions`）`safeParse` 失败 ⇒ `listRuns` 跳过并落汇总 WARN | 清理是使用者手动决定 |

## 相关链接

- 活文档：[Codex FAQ](/faq/codex)——`JUDGE_PARSE_FAILED` finalText 条、180s 超时条、read-only 读不到工作区条、`.agenthome`/`.judgehome` EPERM 条
- 仓库内参考：AGENTS.md——「调智能体只有 `agentProvider.run` 一个入口」（评分智能体通路的唯一入口约束）
- 知识文章：[《行执行与日志》](/features/row-execution)（第 7 步在内部时序的位置、`[评分智能体]` 前缀、score 事件）、[《Codex 接入》](/protocols/codex)（结构化输出与 reasoning 的厂商侧细节）、[《用例管理》](/features/case-management)（评分表 CRUD 与写侧校验）、[《评测详情与候选行》](/features/run-detail)（重新评分入口）、《设置》（评分配置格）、《数据与存储》（评分口径的数据侧表述）
