# 消息规范

## 定位

把 claude-code / codex / dsh 三家的消息、条目、块归一成 `AgentMessage` ＋ `ContentBlock` ＋ `SubagentRecord` 的统一契约，配套能力声明表达「缺了什么、为什么缺」。设计基线只有一条：**事件形状能归一，数据的来源与完备性归不了一**——所以 `source` / `MissingReason` / 能力五态是承重结构，不是可选严谨。契约名不随厂商版本漂移：厂商侧新增量进 `raw` 与映射表，不改契约面；反过来映射表可以随时改。

## 形态与交互

消息怎么到达、怎么合并成最终视图：

- **chunk 两形态**：`delta`（增量）与 `snapshot`（快照）。**三家都产 delta**，但通道不同：claude `stream_event`（`includePartialMessages` 常开，**仅主会话**，`source: 'wire'`）、codex `item/agentMessage/delta` + 两条推理增量通知（`source: 'wire'`）、dsh 插件旁路 sidecar 后的 `aieval/delta` 伪通知（`source: 'hook'`，见《DeepSeek Harness 接入》「流式增量旁路」）。**消费方只实现 snapshot 也能正确渲染**——增量是可选的实时增强，快照一定在块结束时到达。
- **帧是累积值，不是本片**：`MessageAssembler.ingest` 每次回吐的是该逻辑消息**到现在为止的完整块列表**（`agents/src/message.ts` 的 `onMessage` JSDoc 是这条保证的落点）⇒ 消费方**按 `mergeKey` 覆盖**即可，不必自己维护累积状态。这条同时解释了两件事：① 客户端 last-wins 折叠是对的（`row-messages.ts` / `build-model.ts` 都只在 `mergeKey` 上留最后一条）；② 逐帧传输是 **O(n²) 字节**（第 k 帧重发前 k 个 token）⇒ 实时 SSE 出口按 `mergeKey` **丢中间态**（16ms 窗口，见《事件流》「消息流的出口合并」），丢掉的都是「被后一条完全覆盖」的帧，语义零变化。
- **只广播、不落盘**：增量帧不进 `messages.jsonl`（唯一真相源由快照承担：块结束时必有快照，折叠读侧本来就会把同键的 delta 全部盖掉）。**代价如实登记**：被中断的块没有快照 ⇒ 那段半截正文刷新后不可见；行级 `EvalRow.streamingDelta` 只留「多少帧 / 末帧多少字」，正文不落任何地方。原始输出面板（只吃 `log` 事件）**三家一致地零增量**——适配器对增量帧的事件草稿数 = 0。
- **五类「非渲染增量 / 进度帧」的处置必须登记**（禁止无登记的静默丢弃）：

  | 类别 | 处置 | 为什么 |
  |---|---|---|
  | claude `input_json_delta` | **不进 delta 通道** | `partial_json` 是 JSON片段，当 `input` 落库会让消费方拿到半截字符串；工具调用按块结束的完整快照产出 |
  | claude `signature_delta` | **不进 delta 通道** | 它是同一个思考块的一部分（只进审计），落点是随后那份快照的 `signature` 字段；进通道只会得到一条无正文的帧 |
  | claude `system` / `thinking_tokens` | **零事件产出**（显式丢弃） | 它是**思考进度帧**：SDK 原文 *Live thinking-token estimate … **Approximate progress for spinners/pills, not the authoritative billed `output_tokens`***，每个思考 token 一条。一次长回复就是上万条、占该行 `log` 的九成以上（评分智能体那条路走同一适配器，再叠一层）⇒ 原始输出面板被刷成 JSON 流水且卡死、单行 `events.jsonl` 涨到 MB 级。权威值在收尾的 `result.usage.output_tokens_details.thinking_tokens`，丢它不损失事实 |
  | codex `item/plan/delta` / `item/commandExecution/outputDelta` | 进通道判定后**显式丢弃 + DEBUG 计数** | 无渲染消费点；但「丢」必须留痕，静默丢在排障时与「厂商没发」不可分 |
  | dsh `block-start` / `block-end` | **占位不发消息** | 它们不产消息，只用来按首见顺序给块位次发号（与厂商 `BlockAssembler.order` 同算法） |
- **合并键分两层**：信封 `mergeKey` 只含载体四段（见「数据与契约」），**块标识不进 `mergeKey`**——适配器内部按 `i:<index>` / `c:<callId>` 给块分槽；codex 把所有块统一重写成块序号标识，结果与另两家等价。
- **覆盖合并算法**：`delta` 追加到该键缓冲、`snapshot` 覆盖；同键多 snapshot 后者覆盖前者（**不追加不拼接**）；块序号按首次到达分配、一经确定不再变；同键 `delta` 必须先于 `snapshot`，之后到的 delta 丢弃；缺 snapshot 的块停在最后 delta 累积值并由 `assembly: 'open'` 标记（**不要用 `truncated` 表达**，那是 tool-result 自己的字段）。
- **消息级 usage「带值覆盖、缺省保留」**：同一逻辑消息多次投递（增量块 / block-end 快照）时 `usage` 只在完整那次到达，后到不带必须保留已采到的值。
- **评分阶段有自己的文件与出口（用户口径「与执行日志分开」）**：`judgeRowByAgent` 的 `onMessage` / `onSubagent` 与候选同形同口径（快照落盘、增量只广播），但落点是 **`judge-messages.jsonl`**——评审者是另一个会话，执行日志那条时间轴只讲候选做了什么。分流判据是**产出者**不是块形态：评分那次 `run()` 交出来的消息全部走评分那条流（拓扑见《事件流》）。两处细节：事件那层给评分内容加 `[评分智能体] ` 前缀（同一条行级流里要靠它分辨来源），**消息不加**（文件层面已经分开）；行级 `EvalRow.streamingDelta` 只记**候选**的增量帧，评审者的帧数写进去就是答非所问。

## 数据与契约

**信封 `AgentMessage`**——15 格（14 必填＋`usage?` 可选）：

- `messageId`：`run-<kind>:<seq>`（如 `run-codex:12`），供日志与排障、客户端兜底去重；**不含真实 run id、跨运行重号**——别当全局唯一键，去重折叠按 `mergeKey`。
- `vendorId` / `role`：厂商侧 id 与角色。
- `source`：四值 `'wire'` / `'hook'` / `'session-file'` / `'aggregate'`；**今天真正产出的只有 `wire` 与 `session-file` 两值**。
- `roundTrip`：正整数必填，三家都合成（方法不同 ⇒ 跨家比较前必须核对口径）。
- `turn` / `step`：仅 dsh 有值（`data.turn` 是**用户轮号**、`data.step` 是步骤号），另两家恒 `null`。
- `parentCallId` / `subagentId`：子会话归属；`subagentId` 是厂商原生 id（claude 任务 id / codex 线程 id / dsh 子会话 id，dsh 三级兜底 `subagentId`→`agentId`→`childSessionId`）。
- `chunk`：`'delta'` / `'snapshot'`。
- `assembly`：`'snapshot'` / `'open'`，有块停在增量累积上即 `open`。
- `mergeKey`：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`（竖线分隔）。
- `blocks[]`：数组下标即块序号。
- `usage?`：消息级用量，只有 dsh 交。
- `raw`：厂商原文。

**内容块六种**（`blocks[]` 元素）：

- `text`：正文。
- `thinking`：`textKind: 'full' | 'summary' | 'none'`；用、不进呈现。
- `tool-call`：`family` 十族之一或 `null`；`payload` 族载荷只有 `task` / `ask-user` 两族；**`summary`**（可选）是适配器在**唯一构造点** `toolCallBlockDraft` 里算好的**摘要主体**——**冒号后面那一段**（`Check surefire report summaries` / `src/index.ts:10-120` / `2 步`），**不带 `调用工具 <名>：` 前缀**。前缀与整句另有出口：`toolCallSummary(name, input)` 给**活动行**（它只有一行，名字必须在句子里）、`toolCallHint(name, input)` 给**工具行**与这一格（工具行把工具名渲染成一个独立元素，带前缀就是同一件事说两遍）；`toolCallTitle` 单独给前缀。**词表真源仍是 `activity.ts`**，浏览器因此不必把「描述优先 / 每族拼法 / 截断尺子」再实现一遍（`ui` / `client` 按分层表不许 import `agents`）。它与 `log.summary` 由**同一份词表**产出（不是两份）；这一格缺席（老记录）时工具行回落 `input.description`、再回落参数原文首行。**两格都可缺**——老记录里没有它们，读侧把「键不存在」与「显式 `null`」当同一件事。

  **取参口径（用户裁定：description 优先，没有就按每个簇自己拼）**，顺序不可换：① 计划类入参（`todos` / `plan` / `steps`）先说步数——它的值是一整张清单，「几步」才是使用者要的；② **`input.description` 优先**（只有这一个键名算数；`reason` / `justification` 是审批语义、`explanation` 归计划卡片那一格，都不进摘要），有目标（`command` / `file_path` / `pattern` / `url`）时拼成 `描述（目标）`——描述说明「为什么」、目标说明「哪一个」，**只留描述会让同一行里两次 `exec_command` 长得一模一样**；③ 没有描述**按族拼**（判据是族不是家：同一个工具在三家的名字不同，族才是跨家一致的那个轴）：读文件 `路径:起-止`、改文件 路径或 `changes[].path` 清单、搜内容 `模式（范围）`、列文件 `pattern`、跑命令 命令原文、联网 `query`/`url`、派子任务 `prompt`、提问 第一个问题正文；④ 只剩「本仓不认识的工具」（`family === null`）才走通用优先键 → `changes[].path` → 紧凑 JSON → 原样。守卫：`activity.test.ts`（逐族文案 + 描述优先级）、`tool-family.test.ts`（别名逐字）、`activity-conformance.test.ts`（跨家同一句）、`message.test.ts`（块上那一格 = `toolCallHint`）。
- `tool-result`：`structured` 是厂商结构化结果原文透传；`truncation` 三态 `none` / `truncated` / `unknown`，正文超长按 `TOOL_RESULT_MAX_CHARS = 20_000` 截断。
- `attachment` 与 `unrecognized`：契约保留、当前三家都无消息侧产出点。
- **硬约束**：工具块只允许经适配器公共层构造器（`toolCallBlockDraft` / `toolResultBlockDraft`）产出，手搓块会静默少掉 `payload`；源码级断言已拦 `providers/**` 手搓 `tool-call` 块。

**计量结构**：

- `UsageTokens` 五格：`input`＝**非缓存输入**（codex 必须做减法，`input − cachedInputTokens`）；`cached`；`output`；`reasoningOutput` 是 `output` 的**子集不是第四加数**，只收结算值绝不填 0；`total` 是厂商原文、不参与归一恒等式。
- `UsageTiming` 四格：`totalMs` / `apiMs` / `ttftMs` / `source: 'vendor' | 'events'`。
- 派生公式由消费方算：缓存命中率 `cached / (input + cached)`；tok/s `output / ((apiMs - ttftMs) / 1000)`（该退化式分母含工具时间，展示时须标注）。

**能力声明**：`Capability` 五态 `yes` / `no` / `unverified` / `off-by-adapter` / `not-projected-by-vendor`，配 `MissingReason` 四句分工——同一格「没有」要能说出是哪一种没有：

| MissingReason | 含义 |
|---|---|
| `not-supported` | 这家结构上没有，换配置没用 |
| `not-exposed` | 厂商有数据但没投送到我们读得到的通道 |
| `not-observed` | 有通道但我们没接，或本次运行没出现 |
| `unverified` | 有通道没验证过，不敢说采到 |

今天真正被声明的只有两态：`yes`（三家合计 18 格）与 `not-projected-by-vendor`（仅 dsh 的 `streamingDelta`，配 `not-exposed`）。

**子任务行 `SubagentRecord`**：10 个顶层格全必填；`status` 五态 `running` / `completed` / `failed` / `stopped` / `unknown`，另有 `statusMissing` 分开记「状态是否采到」；`parentCallId` 是两套 id 之间的**唯一桥**——子任务记录的身份是厂商原生 id，子任务消息挂在派生它的工具调用 id 上，缺了这格子任务消息会全部落回主会话或被丢；`kind` 是厂商原文**不做归一、不得用来判派发点**。

**消息级用量**（`AgentMessage.usage`）：只有 dsh 交（`assistant/message` 的 `data.usage` 三项原文，三项缺一 ⇒ 整格 `null`，不填 0）；claude（wire 上 `output_tokens` 恒 0）与 codex（协议只到线程级累计、差分归属无法证明）都恒 `null`。**不是累计、不进任何合计**，不承诺「Σ 消息级 = 行级」。

## wire 形态与事件

三家取数通道总表：

| 厂商 | 通道 | 要点 |
|---|---|---|
| claude-code | SDK 消息流（`system` / `assistant` / `user` / `result` / `stream_event`）＋ CLI 落盘的子智能体转录 | 转录在 `<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，只供子智能体用量与轮次，`source: 'session-file'`——当前全仓仅剩这一档非 wire 来源 |
| codex | `codex app-server`（JSON-RPC/stdio，适配器自己 spawn）通知流＋收尾请求 | 收尾 `thread/list{ancestorThreadId}` / `thread/read` / `thread/items/list`；**不读会话文件、不发 hook**；通知 15 种 kind（14 归一＋`other` 兜底）、条目 13 种 kind |
| dsh | 会话通知流四种 method | `session.event` / `session.status` / `subagent.started` / `subagent.finished`；**子会话事件在同一条流里**，靠 `params.sessionId` 分辨归属 |

四个易混的「轮次/步骤」量：`roundTrip`（模型往返序号）、`turn`（仅 dsh，用户轮号）、`step`（仅 dsh）、`subagentId`（厂商原生 id）——前三个名字相近、口径各异，跨家比较前必须核对。⚠️ **有两个同名的 `turn`**：信封这一格是**厂商的用户轮号**，用量事件的 `usage.turn`（`{subagentId, round}`）是**这笔读数的归属**（哪个会话的第几次模型往返）——不同源、不同义，读代码时先看清在哪一层。

四条全局约定：

1. `null` 只表示「未采集」，永不等于 0。
2. 不合成无法验证的值——上游没给正文，不拿摘要/token 数顶替。
3. 每个值都带来源。
4. 契约 `type` 一律 kebab-case（厂商原生名如 `turn/end`、`subagent.started` 只进映射表与 `raw`）；代理自产 id 一律叫 `<domain>Id`（今天只有 `messageId`）。

真机钉住的口径（与契约直接相关的结论）：

| 结论 | 证据 |
|---|---|
| dsh `status` 两个方向都会骗人：`status:"ok"` + `stopReason:"max-tokens"` 字面像成功实为截断；`status:"error"` + `stopReason:"aborted"` 字面像失败实为取消 ⇒ 必须同读两格 | 硬规则：`stopReason !== 'completed'` 一律不得记 `completed`；`max-tokens` ⇒ `failed`、`aborted` ⇒ `stopped` |
| codex `reasoning_output_tokens` 是 `output` 的子集口径有真机支撑（**带路由前提**） | 样本恒非 0 且恒 ≤ `output_tokens` |
| claude 思考 token 子集口径 | 可用对零违例；第三方 anthropic 兼容后端**恒 0**——0 不得读成「不思考」 |
| codex `SubagentStart` 载荷与设计逐字吻合、`SubagentStop` 12 字段且**确证没有 `status`**（比 `SubagentStart` 多 `agent_transcript_path` / `stop_hook_active` / `last_assistant_message`） | schema 级证据 ≠ 真机证据，以真机为准 |
| dsh `subagent/descriptor` **不是逐子任务必发**、身份只在信封 `params.sessionId`、`data` 里没有 `childId` | 不得当身份来源 |
| codex `request_user_input` 在 exec 模式结构性不支持，报错原文 `request_user_input is not supported in exec mode for thread …` | ⇒ `ask-user` 族恒空、**不合成任何问答块**（没有块就没有 `outcome` 可挂） |
| claude `update_plan` 的事件投影 `todo_list ≡ update_plan`，形状 `{text, completed}` 二态 | 恢复不出 `in_progress`，契约记 `unknown` |

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| dsh `stopReason` 的 `error` / `refusal` 两档未观测（`subagent` 工具入参无模型/供应商覆盖口，构造不可得） | 未观测 | 出现时按「其余取值 ⇒ `unknown` + `unverified`」处置，**不猜** |
| claude 嵌套父链恒 `null`（`parent_agent_id` 真机从未出现、无读取点） | 结构性缺 | 消费方全部平铺、不推测父节点；要用层级先补取数 |
| claude `Task*` 冷存储「预建两级目录」这条修法未验证 | 未验证 | 别当已修；要用 `Task*` 先预建 `~/.claude/tasks/<sessionId>` 与 `.lock` |
| claude 增量只覆盖主会话（`stream_event` 的 `parent_tool_use_id` 恒 `null`） | 厂商投送面 | 子智能体不做逐字动画；消费方按**实际到达的块形态**渲染，不按「有增量」写动效 |
| dsh 增量靠**插件注入 + sidecar 文件**，依赖三个内部事实：事件名 `agent/assistant-stream`、`DSH_HOME` 环境变量、profile loader 的 `./` 相对名解析 | 未闭合的脆弱点 | 任一漂移即**静默无增量**（界面表现为「就是不打字」）⇒ 唯一事后判据是行级 `EvalRow.streamingDelta`（缺席=未观测 / `0`=观测到零帧 / `>0`=有增量），且启动时做注入自检；不许让「插件没挂上与「这家本来没有」在界面上同形 |
| 中断的块没有快照 ⇒ 半截正文刷新后不可见 | **已认领的代价**（用户口径） | 增量不落盘换「文件不膨胀 + 实时通道不受影响」；`EvalRow.streamingDelta.lastFrameChars` 回答「它当时写到哪」，不回答「说了什么」 |
| codex `off` 做不到零推理（`effort:'none'` ∧ `model_reasoning_summary:'none'` 都到 CLI，网关照推理） | 厂商行为 | 文案一律按「已按要求下发」表述，不按「它没思考」；真机判据读**行的产物**（reasoning 条目数；`off` 行照样有 reasoning 条目与思考 token），并与「未选」对照行成对读 |
| 派发台账「后到覆盖」：codex `wait` 也带 `receiverThreadIds` ⇒ `kind` / `parentCallId` 可能落在收场那一步 | 已裁决待落地 | 写入面收窄成「只有派发动作（`tool` 以 `spawn` 开头）才写台账」；先改实现再补「`spawnAgent`→`wait` 之后形状」的断言 |
| codex 协作条目真机 `tool` 是 camelCase（`spawnAgent` / `wait` / `closeAgent`），族表登记 snake_case ⇒ 真机 `family: null` | 未裁决 | 要么把 camelCase 补进族表并同步改声明，要么如实写「这一格真机取不到」；两条路都得先补一条 `tool: 'spawnAgent'` 的断言再定稿 |
| 用量去重判据只比 `input` / `cached` / `output`，`reasoningOutput` / `total` 不在 ⇒ 「只有思考 token 变了」的新值发不出去 | 已知缺口 | 闭合判据是比较事件里的五格 `UsageTokens`——先改实现再补守卫 |
| 消息级 usage 不参与任何合计 | 契约定死 | 界面不得拿它对账 `usage` 事件的 tokens / 行卡片 |
| 评分阶段的消息与事件落在独立文件（`judge-messages.jsonl` / `judge-events.jsonl`） | 已落地（裁决：消息与 log 都拆） | 判据是**产出者**；`seq` 各自一套、重跑 / 重评与候选同一条清空口径。代价如实登记：**当前界面没有「评分日志」视图**（活动行只取一句话），排障要直接读文件——两条读数路由（`…/judge/messages`、`…/judge/events`，含 SSE）已备好，接界面是后续动作 |
| 读数两个尺度（dsh 恒行尺度、claude 恒会话尺度），读侧过滤对 dsh 是「有界的过度过滤」 | 未收口 | 真正收口是让生产侧把尺度写进读数（加尺度标记或让 dsh 只累主会话＋分量）；读侧修不干净，未做 |

**取数通道的方法论**（codex 只剩 app-server 一条：`source: 'session-file'` 在 codex 已无产出点，针对旧通道的结论一律不适用）：

- **「厂商有没有」必须落到「我们订阅的层拿不拿得到」**——厂商能力清单与订阅通道是两回事。
- **schema 级证据 ≠ 真机证据**——载荷比 schema 少列/多列字段都出现过。
- **先证链路、再下结论**——dsh 思考 token 结构性不可达的根因是上游给了（`reasoning_tokens: 31`）、本仓路由 `mapUsage()` 不投影：两端都要看到才能下「不可达」。
- **能力声明必须带前提**——工具表/能力随模型名与路由翻转：`deepseek-chat` 23→27＋4 个 `Task*`、`claude-sonnet-4-5` 27→27；`spawn_agent` DeepSeek 路由跑通、内网网关报 `unsupported call: spawn_agent`。

## 相关链接

- 姊妹篇：[事件流](/protocols/event-stream)——行级八型事件与双流分工；`log.summary` 词表属该篇，消息级 `usage` 属本篇
- 活文档：`packages/server/agents/README.md`——§5.4 轮次与计量的口径（三家计数键）、§10 术语对照（「采不到就是 `null`，绝不填 0」「估算 vs 上报」「轮次」）、§4.4 `AgentProvider.metadata`（能力查询唯一入口）
- FAQ 判例（条目标题原文照抄）：
  - [DeepSeek Harness FAQ](/faq/deepseek-harness)——`dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`（`not-projected-by-vendor` 的判例与探针证据）
  - [Codex FAQ](/faq/codex)——思考块恒为 `{"type":"thinking","text":null,"textKind":"none"}`（增量明明带着文本；界面显示「思考文本未采集」，修前显示「厂商有、我们还没接」）；`codex exec --json` 里一条 `item.type === 'reasoning'` 都没有（`show_raw_agent_reasoning=true` 也不管用）；子智能体用量与思考正文：responses 上真机已可得（**不必**换 `wire_api`）；`turn/completed` 只收到**子线程**那一条，主线程仍是 `"status":"inProgress","completedAt":null`
- 知识文章：[Codex 接入](/protocols/codex)（字段级映射的厂商细节）、[《Claude Code 接入》](/protocols/claude-code)、[《DeepSeek Harness 接入》](/protocols/dsh)、[《Provider 抽象与 run 入口》](/protocols/provider-run)、[《进程生命周期》](/protocols/process-lifecycle)、[《三家横向对比》](/protocols/comparison)
