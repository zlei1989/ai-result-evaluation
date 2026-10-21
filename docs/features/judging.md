# 评分

## 定位

评分是一轮评测的第 7 步：把候选的**完整产出**（文本通路 = 裁剪后的 diff；智能体通路 = 候选自己的工作区）对照用例的**评分标准项表格**做逐项二元判定（达成 / 未达成），总分 = 达成项权重之和、满分 = 全部项权重之和，**模型不给总分**；用例开启「包含步骤」时两条通路都另把候选的**执行过程记录**纳入评分证据（文本通路 = 独立 text 块、智能体通路 = 提示词里的绝对路径）。两条通路（`judgeRow` 文本 API / `judgeRowByAgent` 智能体）共用同一把尺子：`parseJudgeResponse`（解析）+ `finalizeScore`（收口）+ `judgeStageAttempt`（执行骨架）。

## 页面形态与交互

- **用例表单**：评分标准项卡片（表格**常驻可见**，不藏弹窗）+ 三个按钮「智能生成 / 智能识别 / 智能调整」。未配置全局默认评分模型 ⇒ 三个按钮全部禁用 + Tooltip「请先到设置里配置默认评分模型」。
- **RubricTable**：受控二级表格（组 → 项），列 ID / 目标 / 权重；新项默认权重 1（0 非法）；重复 ID（trim 后比较）当场标红；表尾「满分 N 分 · 共 M 项」实时；`readOnly` 形态复用于用例详情。三道校验同一份 `validateRubric`：表格上方即时提示、表单提交拦截、服务端写侧。
- **识别弹窗**：只有一个多行文本域；**失败不关窗、不清文本**；识别中按钮禁用。
- **调整弹窗**（智能调整）：输入一句话 → 模型回整表 + 服务端 `diffRubric` 算改动清单（七类改动）→ **预览清单、点「应用」才回写**（不点应用表格不动；空表在调模型之前拒，不花额度）。
- **评分详情抽屉**（评分与评分表吃 `score` + `rubric`；评审过程另走一组 `judgeOutput` props）：总分那一格是 `Row` / `Col` 里并排的两格 antd `Statistic`（「总分」：`value` = `totalScore`、`suffix` = `/maxScore`；「目标」：`value` = 评分项数）；紧跟其后是**总评**（同样是 antd `Statistic`，title「总评」、`value` 就是那句评语；评语是一句话而不是读数，故 `content` 回到正文档字号，不跟着指标值的 24px 长成标题）；总评排在两格指标之后是**先结论、后明细**——分数回答「多少分」，总评一句话回答「为什么」，逐项判定才是往下核对的证据；再往下是逐项达成 / 未达成——**一组一个折叠面板、面板里一张表**（组名是面板标题），面板**默认全部展开**，收起是使用者的动作；各组那张表共用同一套列几何（`tableLayout="fixed"`，引用键 / 权重 / 判定 / 理由给百分比宽度，目标列吃剩余宽度并在列内折行），从上到下列的位置对齐。缺判定项 `Tag warning`「缺少判定」不静默跳过；**最底部**是**评分自己**的运行信息——两行无标题（评分智能体（文本通路写「文本 API」）/ 评分模型 / 思考强度，以及评分用量 / 评分耗时 / 评分时间），读者先看分数、总评与逐项证据，最后才回看这一分是谁打的、花了多少；不设记账行（`structuredOutput` 留在契约里，不上界面）。**总分原样显示权威值，前端不重算；满分来自 `maxScore` 不是常量 100**。
- **评分原始输出**（评审会话的 `log` 事件逐字原文，`judge-events.jsonl` 经 `diagnosticsOf` 折行）：入口「原始输出 N 条」挂在评分详情抽屉 footer 上，正文在二级抽屉里（与执行日志的「原始输出」面板**共用同一份行渲染** `diagnosticsBody`：summary 优先、原文照给、虚拟滚动）。可见性两判据：有分时按 `score.judgeAgentKind`（文本 API 评分没有评审会话 ⇒ 不渲染；智能体评分的候选**常驻**，0 条时正文给空态文案「这个候选评分没有留下原始输出记录」，不藏按钮）；评分进行中（judging ⇔ 无分）按 `run.useAgentJudge` 判——入口在空态那一格也照常出现，点开**实时盯评审**（`judge/events/stream` SSE 续订，抽屉顶部一行「正在评分，以下为当前尝试的输出」；终态候选只拉一次历史、不挂空连接，judging → 终态翻转时重拉全量收尾）。读取失败在二级抽屉里给 Alert + 重试；实时断线给一行「自动重连」警示。
- **设置页评分配置**：默认评分模型（跨协议候选）、思考强度（`allowClear`，清空 = 未指定）、默认评分智能体（协议不兼容项 `disabled`）、diff 上限（KB 计，配置存字节，默认 256；同一预算也是「包含步骤」执行过程证据的截断上限）。onChange 自动保存。
- **候选卡片**：「重新评分」Popconfirm；「使用智能体评分」Switch（创建时快照、编辑可改）。

## 数据与契约

- **Rubric**：`{ groups: [{ name, items: [{ id, goal, weight }] }] }`。组不带权重；`weight` 正整数 ≤ `MAX_ITEM_WEIGHT = 10_000`（拦手滑多零与 safe integer 越界）；**schema 刻意不设 `.min(1)`**（空表是新建用例的真实初态），非空要求由 `validateRubric` 提交时给；空 id 项按位置引用 `#k`（全表顺序号、跨组连续）。
- **派生函数**：`rubricMaxScore`（空表 0）、`validateRubric`（中文报错点名组 / 项）、`composeTotalScore`（达成项权重之和，可 >100）、`renderRubricForJudge`（Markdown 二级表格：引用键 / 目标 / 权重，`|` 转义、换行压空格防列错位）、`diffRubric`（七类改动 + 三段式配对：id → goal 逐字 → 组内位置）。
- **ScoreResult**（12 格）：`judgments[]`（`{ id, achieved, reason }`）、`totalScore`、`maxScore`（满分快照）、`verdict`、`raw`、`judgeProviderId`、`judgeModelId`、`judgedAt`、`judgeAgentKind`（null ⇔ 文本 API）、`judgeEffort`（null ⇔ 我们没指定）、`structuredOutput`（**适配器上报的每-run 通道事实**：这一分有没有走原生 schema 通道。它是**方法**的记录、不是结论的记录——`false` 不等于答复不合格：dsh 走填充层交出一份完全合格的 JSON 时它仍是 `false`，cc / codex 在厂商这一轮没照做时也记 `false`；界面不展示这一格，需要时从 `run.json` 读）、`judgeTokens` / `judgeDurationMs`（评分自己的花销，与候选卡片那份分开）。所有记账格 `.default(...)`——`run-store` 用 `safeParse` 读盘，必填新字段会让旧 `run.json` 解析失败 ⇒ `listRuns()` 静默跳过。
- **两投影同批替换**：`JUDGE_OUTPUT_CONTRACT`（提示词文本，作 system）与 `JUDGE_OUTPUT_JSON_SCHEMA`（结构化输出）是同一条契约的两个投影，改一份必须同批改另一份；两份里都**没有** `totalScore`；同形守卫从契约文本正则抽字段名与 schema 逐一对齐。
- **快照链**：`TestCase.rubric`（必填）→ 创建评测时快照进 `EvalRun.rubric` → 评分阶段只读 `run.rubric`。改用例的表**不影响**历史分数与其满分；重评分按**当前配置**的模型 / 智能体 / 强度打，但尺子（表）不变。「包含步骤」与尺子**同链**：`TestCase.includeSteps`（创建缺省 false）创建评测时快照进 `EvalRun.includeSteps`（旧 `run.json` 缺列读 false）——评分阶段看的是快照、不是当前用例的开关；重评分沿用快照。
- **执行过程证据（开关开启时组装）**：`assembleProcessEvidence` 读候选的 `events.jsonl` **raw 原文**（坏行与缺字段的历史行照留——它们同样是候选为的证据，解析侧会丢它们、证据侧必须留）；候选 `agentKind` 的 provider 元数据声明 `needsMessagesForReasoningEvidence`（codex true、claude / dsh false——厂商差异只问注册表，**不硬编码厂商名**）时追加 `messages.jsonl` raw 原文。内容在进入评分上下文**之前**按 `settings.diffBudgetBytes` 按**字节**截断（`Buffer.byteLength`、逐行裁剪、**头尾保留 + 中间截断处显著标注**）。两条通路共用同一份产物：文本通路取截断后的 `content` 拼成带 `## 文件名` 标题的独立 text 块，智能体通路取 `absolutePath` 指路、评审者读磁盘原文（那一侧不截断）。记录文件缺失（候选没跑到产出）时跳过该份、评分照常，跳过以「files 里少一份」留痕、不静默。
- **旧数据处置**：不删历史、不写迁移。旧用例在「用」的路径（详情 / 建评测 / 换用例 / 编辑保存）被拒（INTERNAL：`这个用例是旧版数据（没有评分标准项），请删除它或重新创建：<caseId>`）；**列表路径故意不拒**（否则一条旧用例让整页 500、连删除入口都没有）。
- **effort 档位**（文本侧 `reasoningFields(protocolType, effort)`，单轮 / 多轮共用）：

  | 档位 | openai 协议（Responses） | anthropic 协议（Messages） |
  ||---|---|
  | 未指定 | 一个键都不加 | 一个键都不加 |
  | `off` | `reasoning: { effort: 'none' }` | `thinking: { type: 'disabled' }` |
  | 其它档 | `reasoning: { effort: '<档>' }` | `output_config: { effort: '<档>' }` |

  智能体侧四家各管各的：claude `off` ⇒ `thinking: { type: 'disabled' }` + env 覆盖层；codex `off` ⇒ `effort: 'none'`（裸 `off` 网关拒、重试 6 次后 exit 1 ⇒ 映射必要）**同时** `model_reasoning_summary: 'none'`（空转）；dsh overlay 档位表 `off: null`、未指定落 `high`；pi `off` 在 openai wire 上是 `reasoning: { effort: 'none' }`、在 anthropic wire 上是 `thinking: { type: 'disabled' }`（未选档位落 `medium`）。`judgeEffort` 落盘语义：**记「我们要求的」档位，不是「实际生效的」**。关闭档文案是「`off（要求不思考）`」——claude/codex 选 off 后并没有真的停止思考，文案若写成「不思考」就是向用户断言一件假事。

- **结构化输出四家落点**（同一份 `JUDGE_OUTPUT_JSON_SCHEMA`，三条通道）：

  | kind | 通道 | 落点 | 结果出口 |
  |---|---|---|---|
  | cc | 原生 | `options.outputFormat` | 收尾消息 `structured_output`；与 `result` 不一致落 WARN 且以 structured_output 为准 |
  | codex | 原生 | `turn/start` 一等字段 `outputSchema`（JSON-RPC，不落命令行） | 主会话答复文本写 `state.finalText` |
  | dsh | **填充层**（无原生通道） | 首轮把 schema 约束追加在提示词之后 + 骨架驱动的同会话修正轮（`continue`，上限 2 轮） | 答复文本写 `state.finalText`；`applied.structuredOutput` 恒 `false` |
  | pi | **工具通道** | 自定义工具 `submit_result` + `constrainedSampling` 的 strict（**原 schema 直传**，禁止预归一化；装配期预检不过 ⇒ 降 `strict: 'prefer'` 并回填充层，点名 WARN） | 工具参数**投影回** `state.finalText`；`applied.structuredOutput` 只在答复确实来自被 strict 约束的工具参数时为真（模型改走正文时翻回 `false`） |

  三条硬约束：`input.outputSchema === undefined` 时一个字段都不加（**非对象**不是任何一家能用的 schema ⇒ 适配器按「没给」处置）；没有原生通道的家由填充层补齐，**交付契约相同、保证强度不同**；「这一次走没走原生通道」由**适配器**在收尾上报，编排层**拿到分之后**才据它留痕（不预读注册表）。

## 状态机与时序

- **第 7 步骨架**（`runJudgeStage`，两条通路共用）：`setRowStatus('judging')` → **空表兜底守卫**（`rubricMaxScore(run.rubric) <= 0` ⇒ `CONFLICT`：`这一轮用的评分标准项是空的，无法评分：这一轮的评分表在创建时就已快照，改用例不会影响它——请在用例里补上评分项后新建一轮评测`，**评分器一次都不调用**）→ 取同一份 config 快照 → `useAgentJudge` 分流 → `judgeStageAttempt` → 失败面折行终态（`AGENT_CANCELED` ⇒ canceled；其余 failed 且原样保留归因码）。
- **`judgeStageAttempt` 四件事**：迟到事件闸门（落定后收尾事件不再落盘）；用户终止归因（`userAborted` 记账）；**污染对照**（仅智能体通路：评分前后各算一次改动摘要，不一致 ⇒ 拿到分时该候选判 `failed`，拿不到分只留痕）；终止 race（`Promise.race`，终止赢 ⇒ 不改状态、在途结果只落「`[已终止的尝试]`」日志；**宽限为 0**，孤儿 promise 先挂 `.catch`）。
- **文本通路**：评分上下文 = **意图 text 块 + 独立 text 块**。意图 text 块只含【题面 + 评分标准表】；diff 作为独立 text 块（块标题 `## candidate-diff.txt`）与意图分开输入——这对**所有文本评分生效**、与开关无关；空 diff 显式写「（无改动）」。开关开启时在 diff 块之后按序追加执行过程证据 text 块（`## candidate-events.jsonl`，codex 候选再加 `## candidate-messages.jsonl`；标题与内容照组装产物原样）。块翻译只在 `text-api.ts` 一处：attachment 块翻成带 `## 文件名` 标题的独立文本块，块类型随协议（Messages 是 `text`、Responses 是 `input_text`）。**为什么不是协议附件（anthropic document / openai input_file）**：DeepSeek 系端点不实现这两种附件——官方端点把 document 块替换成 `[Unsupported Document]` 占位、对 file part 回 400，网关还会静默丢弃；独立文本块在两协议三端点真机可用（判据 = 哨兵词复述）。网关将来支持协议附件后，重跑探针再议。结构检查不合格**回问**（`JUDGE_REPAIR_ROUNDS = 2`，即最多 3 次请求；修复轮全量重发同一份 diff 块与证据块，纠错文本在前；反馈点名缺项 + 引用键 / 目标 / 权重清单）；调用失败（网络 / 鉴权 / 限流）**透传原错误码**、一次都不回问；`MAX_TOKENS = 16_384`。
- **解析唯一真源 `collectJudgeJudgments`**：剥围栏只剥整段的（中间夹散文不救）；**按引用键逐个取，缺一项即不合格**（`缺少对 <键>（<目标>）的判定：评分表里的每一项都必须恰好给出一条判定`）；多余判定忽略、重复键取第一条；`achieved` 宽容读（`"true"/"false"/"是"/"否"/"达成"/"未达成"`）；缺 verdict / reason 给占位文案（占位不是失败）。
- **智能体通路**：`getProvider(kind).run`，`permission: 'read-only'`（提示词「只读评审」是要求、这一格是强制）、`configHome` = 独立 `.judgehome`、`outputSchema` 总是传（语义是「我想要」——走原生 schema 通道还是适配器内部的填充层，由该家自己决定）；**先判 `result.ok` 再读 `finalText`**（先读会把「没问到」当「答错了」）；`finalText === null` 与空答复两种 `JUDGE_PARSE_FAILED` 文案分开；评审者的事件与消息**原样转出、不加前缀**，落评分自己的 `judge-events.jsonl` / `judge-messages.jsonl`（与执行日志分开，靠「流的去处」分辨来源）；其用量不进行的级三格，随分记 `judgeTokens` / `judgeDurationMs`。开关开启时：提示词在既有段落**之后追加**「## 候选的执行过程」段——逐项列出证据文件的**绝对路径**与它是什么，加读取指引（文件可能很大：先看结构再按需读，不要整份打印）；记录原文**不截断**，评审者直接读磁盘。记录文件落在 cwd 之外，同一条路径透传进 `run` 的 `extraReadPaths`（claude 映射 SDK `additionalDirectories` = `--add-dir`，扩进 `dontAsk` 的预授权范围；codex / dsh / pi 不映射，只读档读本就放行）——没有这一格，claude 的 `dontAsk` 会拒读工作目录外的记录。⚠️ **`--add-dir` 只认目录**：适配器把文件项换算成它的父目录（判据见[《Claude Code 接入》](/protocols/cc)的边界表与 [Claude Code FAQ](/faq/claude-code)），所以放行面是「记录文件所在的那个目录」，而不是单独两份文件。证据为空（开关关 / 两份记录都缺失）时提示词与入参都不多这一格。
- **结构化输出的留痕与处置**（拿到分之后才留痕：判据来自这一次运行的结果，跑之前无从得知）：
  - 答复**拿到了但不合格**（剥整段围栏 → `JSON.parse` → 「JSON Schema 子集 → zod」校验）⇒ 骨架在**同一会话**里追问修正，上限 **2 轮**（`STRUCTURED_OUTPUT_REPAIR_ROUNDS`），每轮落一条 `[WARN] 结构化输出未通过校验，要求模型修正（第 N/2 轮）：<首条问题>`；追问文本带上问题清单、schema 原文与它自己的原文（上限 20000 字符），并硬性要求不要重新读工作区 / 不要重新执行任务 / 不要改判定。
  - **耗尽仍不合格** ⇒ `[WARN] 结构化输出修正 2 轮后仍未通过校验：…`，`ok` / `finalText` **保持最后一轮原样**（修正流程不改写结论），评分段按「答复不可解析」报 `JUDGE_PARSE_FAILED`。适配器没有同会话追问通道（cc / codex）时**不做修正**，只剩一条 `[WARN] 答复不符合本次要求的 JSON Schema，且该适配器不支持同会话修正：…`——同样是一次如实的失败。
  - 通道留痕：`applied.structuredOutput === false` 时落 `[评分] <该家> 这一次没有走原生 schema 通道：输出约束由提示词交代，适配器另做一次自校验与最多两轮同会话修正；仍不合格时按答复不可解析处置`。**静默才是问题**——「厂商按 schema 保证形状」与「提示词约束 + 自校验 + 修正轮兜住」在分数与界面上长得一样，横向比较时必须能从这个候选的日志里读出差别。
- **评分段失败只重跑评分**：失败段是 `judge` 且归因码在 `TRANSIENT_CANDIDATE_RETRY_CODES` 里（`JUDGE_PARSE_FAILED` / `INTERNAL` / `RATE_LIMITED` 一类）时，编排层按 `ROW_RETRY`（**2 次 / 3000 ms**）**只重算这一分**——候选产出、工作区、分支与 diff 摘要一个字不动（为一个评分侧的打嗝重新生成候选会**换掉被打分的对象**，而界面上看不出来）。重试期间候选状态走 `judging`，收场事件的 `exitReason` 是 `rescored`；候选段失败才整行重跑（`scope: 'row'`）。不可重评（产物不可用 / 用例被删）⇒ 放弃重试并留 WARN + 事件日志，**不静默**。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| **网关透传 schema 不报错**（最高风险）：schema 落 wire 只是请求体一格，网关不认时模型照旧自由生成 | 可观测手段只有 `applied.structuredOutput`（这一次有没有真的走成原生通道）与 `score.raw`；不假设网关一定认 |
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
- 知识文章：[《候选执行与日志》](/features/candidate-execution)（第 7 步在内部时序的位置、score 事件）、[《Codex 接入》](/protocols/codex)（结构化输出与 reasoning 的厂商侧细节）、[《用例管理》](/features/case-management)（评分表 CRUD 与写侧校验）、[《评测详情与候选》](/features/run-detail)（重新评分入口）、《设置》（评分配置格）、《数据与存储》（评分口径的数据侧表述）
