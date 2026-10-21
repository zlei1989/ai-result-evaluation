# 消息规范

## 定位

把 cc / codex / dsh / pi 四家的消息、条目、块归一成 `AgentMessage` ＋ `ContentBlock` ＋ `SubagentRecord` 的统一契约，配套能力声明表达「缺了什么、为什么缺」。设计基线只有一条：**事件形状能归一，数据的来源与完备性归不了一**——所以 `source` / `MissingReason` / 能力五态是承重结构，不是可选严谨。契约名不随厂商版本漂移：厂商侧新增量进 `raw` 与映射表，不改契约面；反过来映射表可以随时改。

## 形态与交互

消息怎么到达、怎么合并成最终视图：

- **chunk 两形态**：`delta`（增量）与 `snapshot`（快照）。**四家都产 delta**，但通道不同：claude `stream_event`（`includePartialMessages` 常开，**仅主会话**，`source: 'wire'`）、codex `item/agentMessage/delta` + 两条推理增量通知（`source: 'wire'`）、pi `session.subscribe` 的事件里就有逐字增量（`source: 'wire'`）、dsh 插件旁路 sidecar 后的 `aieval/delta` 伪通知（`source: 'hook'`，见《DeepSeek Harness 接入》「流式增量旁路」）。**消费方只实现 snapshot 也能正确渲染**——增量是可选的实时增强，快照一定在块结束时到达。
- **帧是累积值，不是本片**：`MessageAssembler.ingest` 每次回吐的是该逻辑消息**到现在为止的完整块列表**（`agents/src/message.ts` 的 `onMessage` JSDoc 是这条保证的落点）⇒ 消费方**按 `mergeKey` 覆盖**即可，不必自己维护累积状态。这条同时解释了两件事：① 客户端 last-wins 折叠是对的（`row-messages.ts` / `build-model.ts` 都只在 **`(segment, mergeKey)`** 上留最后一条——追问另起一段时两段的载体键会逐字相同，见「数据与契约」）；② 逐帧传输是 **O(n²) 字节**（第 k 帧重发前 k 个 token）⇒ 实时 SSE 出口按 `mergeKey` **丢中间态**（16ms 窗口，见《事件流》「消息流的出口合并」），丢掉的都是「被后一条完全覆盖」的帧，语义零变化。
- **只广播、不落盘**：增量帧不进 `messages.jsonl`（唯一真相源由快照承担：块结束时必有快照，折叠读侧本来就会把同键的 delta 全部盖掉）。**代价如实登记**：被中断的块没有快照 ⇒ 那段半截正文刷新后不可见；候选级 `EvalCandidate.streamingDelta` 只留「多少帧 / 末帧多少字」，正文不落任何地方。原始输出面板（只吃 `log` 事件）**四家一致地零增量**——适配器对增量帧的事件草稿数 = 0。
- **六类「非渲染增量 / 进度帧 / 重放帧」的处置必须登记**（禁止无登记的静默丢弃）：

  | 类别 | 处置 | 为什么 |
  |---|---|---|
  | claude `input_json_delta` | **不进 delta 通道** | `partial_json` 是 JSON片段，当 `input` 落库会让消费方拿到半截字符串；工具调用按块结束的完整快照产出 |
  | claude `signature_delta` | **不进 delta 通道** | 它是同一个思考块的一部分（只进审计），落点是随后那份快照的 `signature` 字段；进通道只会得到一条无正文的帧 |
  | claude `system` / `thinking_tokens` | **零事件产出**（显式丢弃） | 它是**思考进度帧**：SDK 原文 *Live thinking-token estimate … **Approximate progress for spinners/pills, not the authoritative billed `output_tokens`***，每个思考 token 一条。一次长回复就是上万条、占该候选 `log` 的九成以上（评分智能体那条路走同一适配器，再叠一层）⇒ 原始输出面板被刷成 JSON 流水且卡死、单行 `events.jsonl` 涨到 MB 级。权威值在收尾的 `result.usage.output_tokens_details.thinking_tokens`，丢它不损失事实 |
  | claude `isReplay`（`SDKUserMessageReplay`） | **两侧都零产出**（显式丢弃） | 续接（`resume`）时 CLI 把这条会话**已经发生过**的用户侧消息再投一遍，而重放帧带的是**自己的 `uuid`** ⇒ 两侧的 uuid 去重表都挡不住它。追问是**追加到同一行**上的（工作区与产物都不重置）⇒ 那些内容早就在候选的 `events.jsonl` / `messages.jsonl` 里，收下就是把上一轮的工具结果连同证据再写一遍；消息侧还会把**任务台账的 patch 再放一遍**，让计划清单按历史倒带。另有第三处落点：它**不算**人工消息投递的「工具结果边界」（否则会在会话刚接上、模型还没干活时就把人话投出去） |
  | codex `item/plan/delta` / `item/commandExecution/outputDelta` | 进通道判定后**显式丢弃 + DEBUG 计数** | 无渲染消费点；但「丢」必须留痕，静默丢在排障时与「厂商没发」不可分 |
  | dsh `block-start` / `block-end` | **占位不发消息** | 它们不产消息，只用来按首见顺序给块位次发号（与厂商 `BlockAssembler.order` 同算法） |
- **合并键分两层**：信封 `mergeKey` 只含载体四段（见「数据与契约」），**块标识不进 `mergeKey`**——适配器内部按 `i:<index>` / `c:<callId>` 给块分槽；codex 把所有块统一重写成块序号标识，结果与另两家等价。
- **覆盖合并算法**：`delta` 追加到该键缓冲、`snapshot` 覆盖；同键多 snapshot 后者覆盖前者（**不追加不拼接**）；块序号按首次到达分配、一经确定不再变；同键 `delta` 必须先于 `snapshot`，之后到的 delta 丢弃；缺 snapshot 的块停在最后 delta 累积值并由 `assembly: 'open'` 标记（**不要用 `truncated` 表达**，那是 tool-result 自己的字段）。
- **消息级 usage「带值覆盖、缺省保留」**：同一逻辑消息多次投递（增量块 / block-end 快照）时 `usage` 只在完整那次到达，后到不带必须保留已采到的值。
- **评分阶段有自己的文件与出口（用户口径「与执行日志分开」）**：`judgeRowByAgent` 的 `onMessage` / `onSubagent` 与候选同形同口径（快照落盘、增量只广播），但落点是 **`judge-messages.jsonl`**——评审者是另一个会话，执行日志那条时间轴只讲候选做了什么。分流判据是**产出者**不是块形态：评分那次 `run()` 交出来的消息全部走评分那条流（拓扑见《事件流》）。两处细节：事件那层同样**原样透传、不加前缀**（评分事件落 `judge-events.jsonl`，与候选的级流分开，靠「流的去处」分辨来源）；候选级 `EvalCandidate.streamingDelta` 只记**候选**的增量帧，评审者的帧数写进去就是答非所问。

## 数据与契约

**信封 `AgentMessage`**——17 格（15 必填＋`usage?` 与 `segment?` 两个可选）：

- `messageId`：`run-<kind>:<seq>`（如 `run-codex:12`），供日志与排障、客户端兜底去重；**不含真实 run id、跨运行重号**——别当全局唯一键，去重折叠按 `mergeKey`。
- `vendorId` / `role`：厂商侧 id 与角色。
- `source`：四值 `'wire'` / `'hook'` / `'session-file'` / `'aggregate'`；**今天真正产出的有三值**——`wire`（厂商通道）、`hook`（我们自己那一侧的通道：dsh 的流式增量旁路、编排层落的提问答复、编排层落的人工消息）、`session-file`（pi 的子任务转写）。`'aggregate'` 今天没有产出方。
- `origin`：**这一条由谁带进来**——`'case-prompt'`（题面那一档，这一轮的输入本来就是它）/ `'human'`（人在这一轮**已经开始之后**插进来的那句）。两者在形状上完全同形（都是 `role: 'user'` 的文本），复盘时唯一能分开它们的就是这一格，而「这一轮被人插过话」正是「还能不能与别的轮比」的线索。**带默认值**（缺省 = 题面那一档）⇒ 旧账本照读；只有真的由人插进来的那条写 `'human'`。人工消息的块形态与它进账本的时刻见下面「人工消息怎么进账本」。
- `segment?`：**这个候选被分成几段执行，这一条属于第几段**——整格缺席（= 0）= 第一次跑那一段，`n ≥ 1` = 第 n 次追问那一段。追问是**又开一次 `run()`**：厂商那一侧的步数从 1 重新数，两段的 `roundTrip` 撞号、`mergeKey` **逐字相同** ⇒ 读侧按 `mergeKey` 覆盖累积时后一段会把前一段的同号消息整条吃掉（症状：追问之后首段的思考与工具调用凭空消失）。**只有追问那一侧写它**，第一次跑那一段与旧账本一样缺席 ⇒ 旧数据照读。段号与候选快照的 `followUpRounds` 同源（都是「第几次追问」）。
- `roundTrip`：正整数必填，四家都合成（方法不同 ⇒ 跨家比较前必须核对口径）。⚠️ **它只在同一段内递增**：两段各有一个「第 1 步」，步的完整身份是 `(segment, roundTrip)`。
- `turn` / `step`：仅 dsh 有值（`data.turn` 是**用户轮号**、`data.step` 是步骤号），另两家恒 `null`。
- `parentCallId` / `subagentId`：子会话归属。**两家 ID 空间要分开读**：codex 用线程 id、dsh 用子会话 id（三级兜底 `subagentId`→`agentId`→`childSessionId`）；claude **消息侧**的 `subagentId` 是**派生那次调用**的 `parent_tool_use_id`（tool_use id），而 `SubagentRecord.subagentId` 是厂商的 `task_id`（= 转录文件名 `agent-<id>.jsonl` 的那一格）——两者靠 `record.parentCallId` 建立别名，**别按「都是厂商原生 id」把它们对齐**：按 `task_id` 改写消息侧会让子任务正文一条都归不到位。
- `chunk`：`'delta'` / `'snapshot'`。
- `assembly`：`'snapshot'` / `'open'`，有块停在增量累积上即 `open`。
- `mergeKey`：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`（竖线分隔）。⚠️ **它只在同一段内唯一**：读侧的覆盖累积键是 **`(segment, mergeKey)`**（`@aieval/contracts` 的 `messageFoldKey`，**三处**共用：服务端落盘前的 `foldMessages`、浏览器读侧 `foldCandidateRecords`（拉一次 `/messages` 再叠加 SSE 增量）、界面装配 `buildAgentLogModel`）——不带段号会让追问那一段把首段的同号消息盖掉（真机：关掉再打开执行日志，首段的消息整段不见了）。
- `blocks[]`：数组下标即块序号。
- `usage?`：消息级用量，只有 dsh 交。
- `raw`：厂商原文。

**内容块七种**（`blocks[]` 元素）：

- `text`：正文。
- `thinking`：`textKind: 'full' | 'summary' | 'none'`（完整推理 / 厂商摘要 / 有思考无文本），记录厂商侧事实；`summary` 档只有 codex 落（`reasoning.summary[]` 通道）。不进呈现：界面不标注档位，有正文的思考块照常显示。
- `tool-call`：`family` 十族之一或 `null`；`payload` 族载荷只有 `task` / `ask-user` 两族。**`task` 载荷的来源按形状分两路**：整表入参的家（codex 的 `plan`、dsh 的 `todos`）由 `toolPayloadOf` 从**单次入参**算出；claude 的 `TaskCreate` / `TaskUpdate` 是**逐条 patch 的工作项注册表**（入参与结果两头都没有整表，id 也只有结果才有）⇒ 那张表由 `providers/cc/task-registry.ts` 这份 **run 级台账**按到达顺序累积，结果入账后**用同载体重投一份快照**把刷新后的整表挂回同一个块（走的就是「已 seal 的槽位被新快照更新」那条规则，读侧按 `mergeKey` last-wins 折叠即得；界面因此不必知道这一层存在）。**`summary`**（可选）是适配器在**唯一构造点** `toolCallBlockDraft` 里算好的**摘要主体**——**冒号后面那一段**（`Check surefire report summaries` / `src/index.ts:10-120` / `2 步`），**不带 `调用工具 <名>：` 前缀**。前缀与整句另有出口：`toolCallSummary(name, input)` 给**活动行**（它只有一行，名字必须在句子里）、`toolCallHint(name, input)` 给**工具行**与这一格（工具行把工具名渲染成一个独立元素，带前缀就是同一件事说两遍）；`toolCallTitle` 单独给前缀。**词表真源仍是 `activity.ts`**，浏览器因此不必把「描述优先 / 每族拼法 / 截断尺子」再实现一遍（`ui` / `client` 按分层表不许 import `agents`）。它与 `log.summary` 由**同一份词表**产出（不是两份）；这一格缺席（老记录）时工具行回落 `input.description`、再回落参数原文首行。**两格都可缺**——老记录里没有它们，读侧把「键不存在」与「显式 `null`」当同一件事。

  **取参口径（用户裁定：description 优先，没有就按每个簇自己拼）**，顺序不可换：① 计划类入参（`todos` / `plan` / `steps`）先说步数——它的值是一整张清单，「几步」才是使用者要的；② **`input.description` 优先**（只有这一个键名算数；`reason` / `justification` 是审批语义、`explanation` 归计划卡片那一格，都不进摘要），有目标（`command` / `file_path` / `pattern` / `url`）时拼成 `描述（目标）`——描述说明「为什么」、目标说明「哪一个」，**只留描述会让同一行里两次 `exec_command` 长得一模一样**；③ 没有描述**按族拼**（判据是族不是家：同一个工具在四家的名字不同，族才是跨家一致的那个轴）：读文件 `路径:起-止`、改文件 路径或 `changes[].path` 清单、搜内容 `模式（范围）`、列文件 `pattern`、跑命令 命令原文、联网 `query`/`url`、派子任务 `prompt`、提问 第一个问题正文；④ 只剩「本仓不认识的工具」（`family === null`）才走通用优先键 → `changes[].path` → 紧凑 JSON → 原样。守卫：`activity.test.ts`（逐族文案 + 描述优先级）、`tool-family.test.ts`（别名逐字）、`activity-conformance.test.ts`（跨家同一句）、`message.test.ts`（块上那一格 = `toolCallHint`）。
- `tool-result`：`structured` 是厂商结构化结果原文透传；`truncation` 三态 `none` / `truncated` / `unknown`，正文超长按 `TOOL_RESULT_MAX_CHARS = 20_000` 截断。**`ask-user` 一族横跨两个内容块**：问题在 `tool-call` 那一半的 `payload`（`AskUserPayloadSchema`，`kind: 'ask-user'`），答案与收场在 `tool-result` 这一半的 `structured`（`AskUserResultSchema`）——两半共用 `callId`，读侧靠它配对；答案与问题**逐问对齐**（`header` 是唯一配对键，`selected` 装选项标签），故两半的 `questions` 顺序就是答案的顺序。
- `image-view`：**模型看过的一张图片**，`path` 是厂商原文（codex 的 `imageView` 条目只给这一格）。它**不是** `attachment`——后者是「随消息带过来的东西」，前者是模型主动看的一次动作。能不能预览由读侧判断（图片是否还在该候选工作区内），**契约不做推断**。
- `attachment` 与 `unrecognized`：`attachment` 的**唯一产出方是编排层**——人随人工消息发的那几份附件按 `[text, attachment…]` 落进账本（见下面「人工消息怎么进账本」）。`unrecognized` 的产出方是**适配器**：厂商发了、我们归不了的条目类型走这一格（`unrecognizedBlockDraft(vendorType, raw)`），`vendorType` 是厂商的 `type` 原文、`raw` 是条目原文。codex 是今天唯一有产出点的一家——它的 `ThreadItem` 19 个变体里归一了 13 个（含 `imageView` ⇒ `image-view`），剩下 6 个（`hookPrompt` / `sleep` / `imageGeneration` / `enteredReviewMode` / `exitedReviewMode` / `contextCompaction`）与未来新增的类型都落这里。**这一格的意义是消除一类假相等**：不产块时「厂商没发」与「厂商发了、我们没接」在产物里长得一模一样。
- **硬约束**：工具块只允许经适配器公共层构造器（`toolCallBlockDraft` / `toolResultBlockDraft`）产出，手搓块会静默少掉 `payload`；源码级断言已拦 `providers/**` 手搓 `tool-call` 块。**产出通道有两条**：厂商通知流（`project` 的返回值，三家走这条），以及骨架给适配器的**流外投递口** `TurnContext.emitMessage`——厂商把一次调用放在通知流之外时用它（codex 的提问请求是 server→client 请求，线程条目里没有那一格），两条通道进的是同一个合并器，消息号 / 合并键 / 块序号仍只有一处分配。

**人工消息怎么进账本**（人往运行中的一轮送的那句话；形状与厂商投递的消息**逐格同形**，只有三处说了实话）：

| 格 | 值 | 为什么 |
|---|---|---|
| `role` / `origin` | `'user'` / `'human'` | 与题面那条用户消息同形，唯一的区别就是 `origin` 这一格 |
| `source` | `'hook'` | 数据来自**我们自己的宿主通道**（人从界面上发的话），不是厂商 wire 投送的——与 dsh 的增量旁路、提问答复那一半同一个取值 |
| `chunk` / `assembly` | `'snapshot'` / `'snapshot'` | 只写一次快照、没有增量 |
| `blocks` | `[text, attachment…]` | **正文只放人写的那句话**，附件另成块。提示词里那份「绝对路径 + 大小」的清单是**给模型的**（由编排层拼进交给厂商的文本），账本这一半要的是「人发了什么」——两件事混成一格会让账本里的正文与界面上显示的正文不一样 |
| `mergeKey` | 既有载体键之后再接一段 `\|inject:<messageId>`（追问是 `\|followup:<messageId>`） | 两条人话可能落在同一轮、同一个角色、都没有父调用 ⇒ 按原式算出的键会**完全相同**，读侧按它覆盖式累积时后一条会把前一条盖掉（人明明说了两句，界面上只剩一句）。载体键的语义是「这些记录属于同一条逻辑消息」，而两条不同的人话本就是两条逻辑消息 |
| `messageId` | 客户端为这一条草稿铸的 id | 三处共用同一把钥匙：队列表的条目、这条账本记录、那条 `inject-message` 候选级事件 |

两条时刻口径：**落账本的时刻 = 适配器真把消息交给厂商那一刻**（「人点了发送」与「模型真收到了」是两份不同的账；未投递期间**账本一个字都不写**，界面靠队列表自己显示）；**只有账本说得出的一部分事实**——投不进去被丢弃 / 等太久按预算收场 / 撤回来了——**一条账本记录都不会产生**，那三件事归 `inject-message` 候选级事件（账本回答「模型收到了什么」，事件回答「没收到的那几条去哪了」）。

**题面那条用户消息**（`origin: 'case-prompt'`）：编排层在把这一轮交给厂商**之前**落一条 `role: 'user'` 的账本记录，正文就是那一刻交出去的考题提示词（`run({ prompt })` 的实参）。它是执行日志时间轴的**首条**（界面那张「考题提示词」卡片），也是题面事后唯一的落点——题面**没有**快照进 `run.json`，而用例可以被编辑、被删除，现读用例会把「现在这份题面」说成「当时那一次用的题面」。三处细节：`source: 'hook'`（我们自己的宿主通道，不是厂商 wire）；`messageId` 是固定值 `case-prompt:<candidateId>`（一行只有一条，固定 id 让「这一条是不是题面」在原文里一眼可辨）；`mergeKey` 在载体键之后接 `|case-prompt`（同一轮里可能还有一条人工消息，按原式算出的键会完全相同）。**它只进账本、不投给厂商**——交给厂商的那一份走 `run()` 的入参，两个出口互不影响。旧运行（本格落地之前跑的）账本里没有这一条，界面如实不画那张卡片，**不回落去读用例**。

**追问那一段**：人对**已经跑完**的行追问一次，编排层就**再开一次 `run()`**，那一次运行是新的一段（`segment = followUpRounds + 1`）。段内的一切（适配器投的消息、人在这一段里插的话、那条追问自己的账本记录）都带同一个段号，界面上以**一个段标题**分隔（只在主会话节点画）：一行「追问 ×N」+ 这一段的开始时刻 + **那句追问的正文**——段标题是那句话唯一的出口（步的展示块里没有它，见《候选执行》的「执行日志抽屉三区」）。追问那句人话与人工消息同形（`origin: 'human'`、`source: 'hook'`、正文只放人写的那句），`mergeKey` 接 `|followup:<messageId>`，且**它是这一段的段首**：按投递顺序它可能**晚于**这一段的第一条适配器消息落账本（发起追问的那段代码先让出事件循环、再等 `run()` 收尾），账本按事实记，阅读顺序与段标题的落点由执行日志的装配层按段号定。

**计量结构**：

- `UsageTokens` 五格：`input`＝**非缓存输入**（codex 必须做减法，`input − cachedInputTokens`）；`cached`；`output`；`reasoningOutput` 是 `output` 的**子集不是第四加数**，只收结算值绝不填 0；`total` 是厂商原文、不参与归一恒等式。
- `UsageTiming` 四格：`totalMs` / `apiMs` / `ttftMs` / `source: 'vendor' | 'events'`。`firstMs` / `lastMs` 只认「首见即起点、再见即终点」，而 `apiMs` / `ttftMs` 是**逐条投影的增量**、由骨架 `mergeTiming` 相加成候选级值——适配器自己累加会与那一层叠成平方级偏大（症状是 `apiMs` 比 `totalMs` 还长）。
- 派生公式由消费方算：缓存命中率 `cached / (input + cached)`；tok/s `output / ((apiMs - ttftMs) / 1000)`（该退化式分母含工具时间，展示时须标注）。

**能力声明**：`Capability` 五态 `yes` / `no` / `unverified` / `off-by-adapter` / `not-projected-by-vendor`，配 `MissingReason` 四句分工——同一格「没有」要能说出是哪一种没有：

| MissingReason | 含义 |
|---|---|
| `not-supported` | 这家结构上没有，换配置没用 |
| `not-exposed` | 厂商有数据但没投送到我们读得到的通道 |
| `not-observed` | 有通道但我们没接，或本次运行没出现 |
| `unverified` | 有通道没验证过，不敢说采到 |

消息面五格、下发级注入面两格（逐家七格）与交互面那一组（`askUser`）今天**逐格都给得出来**，声明里落的是 `yes`；**人工消息面（第五组 `turnInjection`）是唯一出现 `yes` 之外的实例的一组**——投递两档**四家里只有 dsh 逐格都是 `yes`**（`'round'` 走进程内插件、`'idle'` 走 wire，唯一有 real-path 观测的一家），另三家落在 `off-by-adapter`（pi：厂商侧两档都有原生落点，适配器一格端口都没挂）/ `unverified`（cc 与 codex：通道与接线都在，缺的是厂商侧投递点的端到端真路径观测）——见《契约体系》与四家接入篇；撤回那一对另用一套四档词表（`by-id` / `flush-only` / `none` / `unverified`）。`no` / `not-projected-by-vendor` 两态当前仍没有实例——五态是承重结构，谁给不出哪一格就从这里落。

**子任务行 `SubagentRecord`**：10 个顶层格全必填；`status` 五态 `running` / `completed` / `failed` / `stopped` / `unknown`，另有 `statusMissing` 分开记「状态是否采到」；`parentCallId` 是两套 id 之间的**唯一桥**——子任务记录的身份是厂商原生 id，子任务消息挂在派生它的工具调用 id 上，缺了这格子任务消息会全部落回主会话或被丢；`kind` 是厂商原文**不做归一、不得用来判派发点**。

**消息级用量**（`AgentMessage.usage`）：只有 dsh 交（`assistant/message` 的 `data.usage` 三项原文，三项缺一 ⇒ 整格 `null`，不填 0）；claude（wire 上 `output_tokens` 恒 0）与 codex（协议只到线程级累计、差分归属无法证明）都恒 `null`。**不是累计、不进任何合计**，不承诺「Σ 消息级 = 候选级」。

## wire 形态与事件

四家取数通道总表：

| 厂商 | 通道 | 要点 |
|---|---|---|
| cc | SDK 消息流（`system` / `assistant` / `user` / `result` / `stream_event`）＋ CLI 落盘的子智能体转录 | 转录在 `<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，只供子智能体用量与步数，`source: 'session-file'` |
| codex | `codex app-server`（JSON-RPC/stdio，适配器自己 spawn）通知流＋收尾请求 | 收尾 `thread/list{ancestorThreadId}` / `thread/read` / `thread/items/list`；**不读会话文件、不发 hook**；通知 15 种 kind（14 归一＋`other` 兜底）、条目 13 种 kind |
| dsh | 会话通知流四种 method | `session.event` / `session.status` / `subagent.started` / `subagent.finished`；**子会话事件在同一条流里**，靠 `params.sessionId` 分辨归属 |

四个易混的「轮/步」量：`roundTrip`（模型往返序号）、`turn`（仅 dsh，用户轮号）、`step`（仅 dsh）、`subagentId`（厂商原生 id）——前三个名字相近、口径各异，跨家比较前必须核对。**界面口径**：用户每发送一次提示词（题面或每一次追问）叫**一轮**；适配器的一次模型 API 往返（`roundTrip`，用量事件的 `turns` 是同一把尺）叫**一步**——界面上「步数 / 第 N 步 / 本步」读的都是它，不读厂商的 `turn`。⚠️ **有两个同名的 `turn`**：信封这一格是**厂商的用户轮号**，用量事件的 `usage.turn`（`{subagentId, round}`）是**这笔读数的归属**（哪个会话的第几次模型往返）——不同源、不同义，读代码时先看清在哪一层。

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
| codex 提问的**工具面**与**协议面**是两件事：`exec` 模式结构性不支持（报错原文 `request_user_input is not supported in exec mode for thread …`），而本仓跑的是 `app-server`，协议里有 server→client 的 `item/tool/requestUserInput` 请求与 `ToolRequestUserInputResponse{answers}` 应答 | 协议面那条通道**存在且已接**：线程级配置的两格开关随应答面同开、请求到了由适配器装帧回帧（通道、递答案与收场见《Codex 接入》的《提问与应答面》）。⚠️ 反向也读不得——0.156.1 默认就把 `request_user_input` 列进工具表，而未开应答面时**调用被运行期弹回**（工具结果逐字 `request_user_input is unavailable in Default mode`）⇒「表里有它」不蕴含「这次调用受理得了」 |
| codex 提问的两道厂商门禁：`request_user_input requires an interactive stdin terminal`、`request_user_input can only be used by the root thread` | 前一句**不是服务端闸门**：它属于厂商自带的参照客户端，不是下发前的拦截——真路径里 fd 0 是管道时请求照样下发（判据是「开关打开后请求真的到」，读的是客户端那一侧的服务端请求列表）。后一句决定子线程提问的收场：厂商自己拒，落「子智能体不能向用户提问」 |
| claude `update_plan` 的事件投影 `todo_list ≡ update_plan`，形状 `{text, completed}` 二态 | 恢复不出 `in_progress`，契约记 `unknown` |

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| dsh `stopReason` 的 `error` / `refusal` 两档未观测（`subagent` 工具入参无模型/供应商覆盖口，构造不可得） | 未观测 | 出现时按「其余取值 ⇒ `unknown` + `unverified`」处置，**不猜** |
| claude 嵌套父链恒 `null`（`parent_agent_id` 真机从未出现、无读取点） | 结构性缺 | 消费方全部平铺、不推测父节点；要用层级先补取数 |
| claude `Task*` 冷存储「预建两级目录」这条修法未验证 | 未验证 | 别当已修；要用 `Task*` 先预建 `~/.claude/tasks/<sessionId>` 与 `.lock` |
| claude 增量只覆盖主会话（`stream_event` 的 `parent_tool_use_id` 恒 `null`） | 厂商投送面 | 子智能体不做逐字动画；消费方按**实际到达的块形态**渲染，不按「有增量」写动效 |
| dsh 增量靠**插件注入 + sidecar 文件**，依赖三个内部事实：事件名 `agent/assistant-stream`、`DSH_HOME` 环境变量、profile loader 的 `./` 相对名解析 | 未闭合的脆弱点 | 任一漂移即**静默无增量**（界面表现为「就是不打字」）⇒ 唯一事后判据是候选级 `EvalCandidate.streamingDelta`（缺席=未观测 / `0`=观测到零帧 / `>0`=有增量），且启动时做注入自检；不许让「插件没挂上与「这家本来没有」在界面上同形 |
| 中断的块没有快照 ⇒ 半截正文刷新后不可见 | **已认领的代价**（用户口径） | 增量不落盘换「文件不膨胀 + 实时通道不受影响」；`EvalCandidate.streamingDelta.lastFrameChars` 回答「它当时写到哪」，不回答「说了什么」 |
| codex `off` 做不到零推理（`effort:'none'` ∧ `model_reasoning_summary:'none'` 都到 CLI，网关照推理） | 厂商行为 | 文案一律按「已按要求下发」表述，不按「它没思考」；真机判据读**行的产物**（reasoning 条目数；`off` 行照样有 reasoning 条目与思考 token），并与「未选」对照行成对读 |
| 派发台账「后到覆盖」：codex `wait` 也带 `receiverThreadIds` ⇒ `kind` / `parentCallId` 可能落在收场那一步 | 已裁决待落地 | 写入面收窄成「只有派发动作（`tool` 以 `spawn` 开头）才写台账」；先改实现再补「`spawnAgent`→`wait` 之后形状」的断言 |
| codex 协作条目真机 `tool` 是 camelCase（`spawnAgent` / `wait` / `closeAgent`），族表登记 snake_case ⇒ 真机 `family: null` | 未裁决 | 要么把 camelCase 补进族表并同步改声明，要么如实写「这一格真机取不到」；两条路都得先补一条 `tool: 'spawnAgent'` 的断言再定稿 |
| 用量去重判据只比 `input` / `cached` / `output`，`reasoningOutput` / `total` 不在 ⇒ 「只有思考 token 变了」的新值发不出去 | 已知缺口 | 闭合判据是比较事件里的五格 `UsageTokens`——先改实现再补守卫 |
| 消息级 usage 不参与任何合计 | 契约定死 | 界面不得拿它对账 `usage` 事件的 tokens / 候选卡片 |
| 评分阶段的消息与事件落在独立文件（`judge-messages.jsonl` / `judge-events.jsonl`） | 已落地（裁决：消息与 log 都拆） | 判据是**产出者**；`seq` 各自一套、重跑 / 重评与候选同一条清空口径。代价如实登记：**当前界面没有「评分日志」视图**（活动行只取一句话），排障要直接读文件——两条读数路由（`…/judge/messages`、`…/judge/events`，含 SSE）已备好，接界面是后续动作 |
| 读数两个尺度（dsh 恒行尺度、claude 恒会话尺度），读侧过滤对 dsh 是「有界的过度过滤」 | 未收口 | 真正收口是让生产侧把尺度写进读数（加尺度标记或让 dsh 只累主会话＋分量）；读侧修不干净，未做 |

**取数通道的方法论**（codex 只剩 app-server 一条：`source: 'session-file'` 在 codex 已无产出点，针对旧通道的结论一律不适用）：

- **「厂商有没有」必须落到「我们订阅的层拿不拿得到」**——厂商能力清单与订阅通道是两回事。
- **schema 级证据 ≠ 真机证据**——载荷比 schema 少列/多列字段都出现过。
- **先证链路、再下结论**——dsh 思考 token 结构性不可达的根因是上游给了（`reasoning_tokens: 31`）、本仓路由 `mapUsage()` 不投影：两端都要看到才能下「不可达」。
- **能力声明必须带前提**——工具表/能力随模型名与路由翻转：`deepseek-chat` 23→27＋4 个 `Task*`、`claude-sonnet-4-5` 27→27；`spawn_agent` DeepSeek 路由跑通、内网网关报 `unsupported call: spawn_agent`。

## 相关链接

- 姊妹篇：[事件流](/protocols/event-stream)——候选级九型事件与双流分工；`log.summary` 词表属该篇，消息级 `usage` 属本篇
- 活文档：`packages/server/agents/README.md`——§5.4 轮次与计量的口径（四家计数键）、§10 术语对照（「采不到就是 `null`，绝不填 0」「估算 vs 上报」「轮次」）、§4.4 `AgentProvider.metadata`（能力查询唯一入口）
- FAQ 判例（条目标题原文照抄）：
  - [DeepSeek Harness FAQ](/faq/deepseek-harness)——`dsh：声明 streamingDelta=yes，但 plain-reply 场景里没有任何 delta 消息`（`not-projected-by-vendor` 的判例与探针证据）
  - [Codex FAQ](/faq/codex)——思考块恒为 `{"type":"thinking","text":null,"textKind":"none"}`（增量明明带着文本；界面显示「思考文本未采集」，修前显示「厂商有、我们还没接」）；`codex exec --json` 里一条 `item.type === 'reasoning'` 都没有（`show_raw_agent_reasoning=true` 也不管用）；子智能体用量与思考正文：responses 上真机已可得（**不必**换 `wire_api`）；`turn/completed` 只收到**子线程**那一条，主线程仍是 `"status":"inProgress","completedAt":null`
- 知识文章：[Codex 接入](/protocols/codex)（字段级映射的厂商细节）、[《Claude Code 接入》](/protocols/cc)、[《DeepSeek Harness 接入》](/protocols/dsh)、[《Provider 抽象与 run 入口》](/protocols/provider-run)、[《进程生命周期》](/protocols/process-lifecycle)、[《四家横向对比》](/protocols/comparison)
