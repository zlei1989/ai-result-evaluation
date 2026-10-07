# 「执行日志」抽屉重设计（轮次时间轴 + 折叠面板 + 子任务面包屑）

日期：2026-09-30
状态：现行口径
影响面：`@aieval/contracts`（新增消息模型类型）、`@aieval/ui`（新组件 + 改名）、`apps/web-next`（接线）、README、既有 spec 的口径对齐

## 怎么读这份文档

**规范基线**：`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`（下称 **v3**）。
本文只定**界面、交互与 UI 侧的数据契约**，并如实划出「本期不做」的数据层范围（§12）。
v3 的推理不在这里重复，本文只引用它的结论。

> ⚠️ **两版规范的小节号不能互译（读引用时必看）**：v2 与 v3 有若干「同号不同义」的条目，
> 比「不存在」更危险。本文引用规范一律带来源前缀（`v2 spec §x` / `v3 §x`），**对照表只此一处：§8.2**。
> v3 **没有收编**的概念（`ask-user` 的答案回填与七态、`TaskStep`、`commitModel` / `TaskListArgs`）
> 由**本文自行定义**并就地写明，**不指向 v2 的节号**。

**章节导航**（按「读它要解决什么」组织，不按写作顺序）：

| 我想知道… | 读 |
|---|---|
| 为什么要重做、目标是什么 | §1 · §2（含 §2.1 五个重组场景） |
| 界面长什么样（三区结构、几何、尺寸、配色） | **§5** · **§5.0 视觉与尺寸基线** |
| 交互怎么走（折叠、滚动、跳转、过滤、动效） | **§6** |
| 数据契约有哪些类型、每个字段什么含义 | **§4.1**（模型：`AgentLogModel` / `LogNode` / `LogTurn` / 能力与缺失枚举）+ **§4.2**（内容块、`ToolItem`、`RenderBlock`、两族载荷）|
| 某条界面规则依据的是哪一格数据 | 该规则所在小节**就地写出规则名**（如「UI 不做取数」）。规则的完整理由与评估表在 **§4.1 的五条边界纪律**——只有想知道「为什么这么定」时才需要跳过去 |
| 怎么测、怎么验收 | §10 · §11 |
| 本期不做什么 | §12 |
| 有哪些已知风险 | §13 |
| 本文引用规范时，某个小节号对应哪儿 | **§8.2**（与规范小节号的对照） |
| 还有哪些**没闭合**的问题 | **§14**（现行现状） |

---

## 1. 要解决的问题

重设计前，「执行日志」抽屉是**一坨纯文本**：`formatEventLog(events)` 把事件按 7 个类型各拼一行，
塞进一个限高 520px 的等宽文本框自滚。（该台账格式仍在
`packages/client/ui/src/composite/log-format.ts`，供「下载台账」与抽屉的「原始输出」用。）

三条具体的不好用：

1. **四类语义完全不同的东西长得一样。** 智能体说的话、它的思考、工具调用的原始 JSON、
   编排层的事实（状态/用量/评分）——在抽屉里都只是「一行文字」。读的人分不出哪句是结论、
   哪句是过程。
2. **没有结构，只有长度。** 一次评测几百轮、几千条事件时，唯一的定位手段是浏览器的
   `Ctrl+F`；「第 40 轮发生了什么」没有入口。
3. **子任务完全不可见。** v2 spec 已把 subagent 建模成一等事件（§6），但今天没有任何出口；
   而「主智能体派了一个子任务去干活」恰恰是评测里最需要看的一段过程。

目标形态：**顶部固定的事实进度条 + 按轮次分组的消息时间轴**，思考与工具调用默认折叠，
连续工具调用合并成一个面板，子任务用面包屑切换查看。

## 2. 目标与非目标

**目标**

- 按钮文案「查看日志」→「执行日志」（抽屉标题**本来就是**「执行日志」，不动）。
- 抽屉里展示**每轮消息的事实内容**：智能体的正式输出（markdown）一等可见。
- 思考与工具调用**默认折叠**；**连续工具调用合并成一个面板**；工具行可再展开看完整命令/参数/结果。
- subagent 用**面包屑**切换，二级/三级子任务的消息**用与主会话完全相同的渲染**展示。
- `task`（计划清单）与 `ask-user`（向用户提问）两族工具**跳出工具组单独成卡**（§5.4 / §5.5）：
  清单是**状态**（同一张表在多轮里演进）、提问是**交互**（会阻塞轮次），两者都压不进一行工具摘要。
- 把内容渲染抽象成一个通用组件（`AgentMessageTimeline`），主会话与子任务共用。
- **组件分层与重组**：把这一套拆成**三层**——纯渲染件 / 受控组合件 / 场景预设，
  四份视图态抽成 `useAgentLogView`，块渲染走**注册表**。验收口径是**五个重组场景**（§2.1）逐条成立，
  而不是「文件变多了」。
- **扩展零改动**：新增一类内容块 = **注册一项渲染器**、
  新增一个工具条动作 = **传一个 `ToolbarAction`**，两者都**不改任何已有文件**。
- 几百轮时不卡：虚拟滚动（**它是预设，不是默认**——见 D24）。
- 保住既有语义：`log` 的原始负载仍可查阅（不静默丢弃）。

**非目标**

- **不改适配器**：把三家厂商事件投影成 v2 的 `message` / `subagent-start` / `subagent-end`
  是 v2 spec 的实施范围，不在本文（§12）。
- 不做抽屉内全文搜索（用轮次跳转器 + 过滤替代）。
- 不做轮次的「折叠全部 / 展开全部」批量开关。
- 不做 diff 正文渲染（「变更详情」抽屉已负责）。
- 不改评分通路与 `finalText` 语义。
- 其余 8 个工具族本期**不做专门渲染**，仍走「工具名 + 参数摘要 + 文本结果」的通用工具行
  （规范 §7.6.4 的通用回退不算失败）；族结构在契约里留位（§4.1）。
- 不在抽屉之外做「正在等待答复」的提示（行卡片 / 列表页的状态标记）：本期只在抽屉内如实显示（§5.5 / §12）。
- **不提供「完全不同的交互形态」的成品**（对话式 UI / 实时监控台）：§2.1 只要求这一层**做得出来**
  （换滚动几何 = 换组合件，§9.2），**不要求本期做出来**——本期只落一个真实场景需要的预设（抽屉），
  其余形态等真有需求时按同一套分层组装。**不要把「可重组」读成「已经做了五个界面」**。

### 2.1 「可重组」的验收面：五个场景

§9 的分层**不是按组件名拆的**，是按**职责**拆的。判据是下面五个场景逐条成立——
它们是需求方逐项确认的「更多业务场景」，也是 §9 分层的全部判据：

| # | 场景 | 落到哪个接缝 | 不许发生的事 |
|---|---|---|---|
| S1 | **内嵌只读视图（非抽屉）** | 用 `AgentLogLayout`（抽屉正文），**不套 `Drawer`**；或用更低的 `AgentMessageTimeline` | 不许为了内嵌而重写一遍正文 |
| S2 | **喂别的业务数据（换模型来源）** | 换一个 `AgentLogModel` + 换一个 `AgentLogSource`（§4.4） | 不许改组件、不许改契约 |
| S3 | **单独复用某个子块** | 子块**可独立挂载**：给定 props 就能渲染，不依赖 `AgentLogView` 的 state | 不许任何子块的可用性依赖于它恰好被 `AgentLogView` 渲染 |
| S4 | **新增块类型 / 新增工具条动作** | 注册表（§9.3）/ `ToolbarAction[]`（§9.4） | 不许改 `agent-message-timeline` 或 `agent-log-layout` |
| S5 | **完全不同的交互形态（对话 / 监控台）** | 换组合件（§9.2 的 L2），复用 L0/L1 | 本期**不做成品**，只保证做得出来（见 §2 非目标） |

**这五个场景是分层的唯一判据**：任何一处「拆出来的东西仍然只能被 `AgentLogView` 用」，
就是拆错了——文件数变多不算拆对了。

## 3. 口径与取舍（逐条）

| # | 项 | 取值 | 理由 |
|---|---|---|---|
| D1 | 「一轮」的定义 | **模型一次 API 往返 = 一轮**（＝ `usage.turns` 口径；**不是** `message.turn`——后者三家语义不同、明文禁止用于分组，见 §4.1 的 `LogTurn.round`） | **同一份口径**下的轮次；「思考→工具→结果→回复」天然落进同一轮。⚠️ **不是「跨三家可比」**——规范逐字「`roundTrip` 三家都要合成，且计数方法不同 ⇒ **跨家比较前必须确认口径**，不要把某家偏高的近似值当成另一家的等价物」，并点名 codex 的近似计数**系统性偏高** ⇒ 口径是「**同口径可比**」，`round` / `turns` 必须带来源标注（D27） |
| D2 | 块内正文渲染 | **按块类型分派**：只有 `text` 块走 markdown，其余（thinking / tool 参数 / tool 结果 / attachment / unrecognized）一律等宽原文 | 推理摘要与命令输出不是 markdown，解析它们只会得到字面标记 |
| D3 | 行级事实的安置 | **顶部固定不可折叠的进度条** + 下方纯轮次时间轴 | 那些事实是「关于这一行」的，不是智能体说的话（v2 spec §2 的分界） |
| D4 | 面包屑作用域 | **只看该节点自己的消息**；后代以「子任务」占位条出现；**用户提示词作为首条消息**（主会话是与用户的往来、子任务是父派给它的指令） | 「这句话是谁说的」不能有歧义 |
| D5 | 合并粒度 | 先按 `callId` **配对「调用+结果」**成一个工具条目，再把这些条目里**连续的**合进一个面板；`callId` 缺失/配不上时降级成独立条目，不编造关联 | dsh 的调用与结果是两条独立事件，不配对则一次调用被拆成两行 |
| D6 | 面包屑「级联菜单」 | 每段下拉 = **该层级的兄弟列表**，当前项打勾 | 祖先链由面包屑表达，菜单只负责「跳到同层另一个」 |
| D7 | 长跑处理 | **全渲染 + 轮次跳转器 + 过滤**（不做「默认折叠轮次」） | 「每轮的事实内容」必须开箱即见 |
| D8 | 下载口径 | **拆成两件事**：下载 = 原始事件台账（`formatEventLog`），**不再要求与抽屉逐字一致** | 时间轴与台账本来就不是一种东西；「逐字一致」是上一版的假设 |
| D9 | 虚拟滚动 | **antd 6 的 `Listy`（`antd/listy`）**，不自己写窗口化。它内部就是 antd 的 `@rc-component/virtual-list` | 嵌套折叠面板的动态高度补偿是自建方案最容易做错的一处；而 `Listy` 让这条**不必新增直接依赖**（§7.2） |
| D10 | 工具面板形态 | **整宽折叠面板**（组头 + 组内工具行） | 视觉对比页确认 |
| D11 | 轮次容器 | **扁平 + 左槽标记**（`轮次 N` 与时间挂左侧竖槽） | 同上；密度高于卡片 |
| D12 | 工具行默认态 | **全部收起**（第一级展开后只是一行行摘要，点某行才出完整命令/参数/结果） | 一级折叠给扫读，二级折叠给细读 |
| D13 | 流式滚动 | **「跟随最新」**：默认开，新事件带视口到底；用户一上翻即自动关，角落浮出「回到最新」 | 替代原「自动滚底」手工开关 |
| D14 | `log` 事件去处 | 时间轴**不混入**；固定区给一个「原始输出 N 条」入口，展开看原文 | 原始负载必须可查，但不能与消息争夺注意力 |
| D15 | 工具名显示 | **原样透传**（`Bash` / `apply_patch` / `pwsh` / `spawn_agent`），不做统一改名 | v2 spec §7.3 明文禁改名（改名会让厂商认不出自己的调用） |
| D16 | **接口优化的原则** | **按最优形状定模型，不迁就现状、不粘传输层**：`seq` / SSE / `chunk` / 两源合并 / 取数时机 / 大小上限判断**全部不进 UI 契约**；会自己随时间变的量（耗时）不进契约；存储用扁平数组 + `parentId`，不建嵌套树。逐属性的取舍见 §4.1 的评估表 | 需求方口径：接口与数据层正在重构，优先 UI 设计，并评估每项属性的合理性与扩展性 |
| D17 | 环境信息的口径 | **按提示词栈的层分组、各自标来源**（用户层 / 厂商系统层 / 运行配置 / 实测统计），缺失项给 `MissingReason`。**不做假等价的合并** | 各层的来源与可信度不同；合起来回答不了「这条要求是谁下发的」 |
| D18 | 「通用」的落点 | **`agent-log` 本身就是那个通用组件**（`AgentLogView` 吃 `AgentLogModel` + `AgentEnvironment`，不认「评测行」这个业务概念）；环境抽屉是它**内部**的一块（`agent-log/agent-environment-drawer.tsx`），**不提为并列组件** | 需求方口径：环境属于 agent-log 的组成部分，agent-log 才是通用件 |
| D19 | 用户提示词的命名与位置 | 概念上叫**用户提示词**（角色视角），不叫「考题提示词」（业务视角）；**只在消息时间轴的首条出现，环境抽屉里不重复列** | 需求方口径：对它说话的是使用者，不是「考题」；而「对模型说的话」属于对话、不属于环境配置 |
| D20 | `task` 卡片（计划清单）的形态与位置 | **状态化清单面板**（v2 spec §7.6.4 已定的形态）落到轮次时间轴上：**从工具组里提出、原地成卡并切断合并链**；**同一轮只画最后一次**调用（更早的收进面板底部）；**跨轮不去重**，首次展开、其后收起且标题带变化摘要 | 去重需要跨轮状态，与 §7.2 的「按项渲染 + 虚拟列表乱序挂载」相冲；而收起态标题已带 `3/5 完成 · +1 完成`，所以「不去重」不等于「重复占地方」 |
| D21 | `ask-user` 卡片的形态 | **问答卡片**：逐问题渲染选项（`recommended` 打标、`multiSelect` 标注、`allowOther` 追加自由输入行）+ 答案回填 + **七种收场**；**「还没收场」是独立于七态的一支**（`AskUserPending`，见 D35），默认展开并显示已等待时长 | 本仓是无人值守评测，最需要一眼看出的是「它卡在等人回答」；把「还在等」并进任何一态都会把未收场说成已收场（与 §4.2「`running` 不可由 `output` 推断」同一条纪律） |
| D22 | 族数据的落点与形状 | **只挂 `tool-call` 块**，且**只给「本次调用后的归一结果」**（清单 / 问答）；**不把 `args` / `result` 两半暴露给 UI**；`commitModel` 与 v2 的 `TaskListArgs` 空壳**不进 UI 契约** | `tool-call` 是唯一必然存在的那一块；而「清单在 dsh 的 `arguments` 里、在 claude 的结果累积里」是适配器的知识（v2 spec §7.6.0），让 UI 自己挑半边读就是把适配器职责泄进 UI |
| D23 | 「等待输入」的可见性 | 卡片标题上的等待时长 **+** 固定区一个**只在真的在等时出现**的 `等待答复 12m`（**派生**：不新增 `facts` 字段，也不进 `rowEvents`） | 「这一行为什么不动了」是长跑评测里最该一眼看出的；而它是**消息层**的内容，不是 §5.2 那张行级事件表里的编排层事实 |
| D24 | **组件的分层与状态归属** | **三层**：**L0 纯渲染件**（无 state、无取数、无业务概念）/ **L1 受控组合件**（吃 `turns` + `renderBlock` 分派，**自己不持有折叠态**）/ **L2 场景预设**（`useAgentLogView` + `AgentLogLayout` + `AgentLogDrawer`）。**四份视图态抽成一个 headless hook**；**虚拟列表降为 L2 的一个预设**，不是 L1 的默认行为 | 组件要能按**更多业务场景重新组装**、且要有扩展性，件之间用事件交互（＝回调 props，§9.1）。按**组件名**平铺会得到一个「外壳 + 上帝 state」的主件，五个重组场景逐条卡死 ⇒ **§2.1 的五个场景是唯一判据** |
| D25 | **块渲染是注册表，不是 switch** | `RenderBlock` 的九个臂改成 **`kind → 渲染器` 的注册表**：默认项随组件走，调用方可用 `BlockRendererProvider` **追加或覆盖**，用 `assertNever` 守住默认集的穷尽性 | 要满足「新增块类型不改已有文件」（§2.1 S4）。**这是把 §4.2 已立的先例从类型层贯彻到组件层**——§4.2 扩展性第 5 条已经定了「收编新工具族 = 加一个 arm」，但 `assertNever` 写在 timeline 里时，加一个 arm 仍然要改 timeline。**判别联合管类型、注册表管分派**，两者不互斥 |
| D26 | **工具条是动作数组，不是七个硬编码控件** | 默认动作集（下载台账 / 跟随最新 / 跳到轮次 / 只看工具调用 / 只看错误 / 原始输出 / 环境信息）内聚成 `AgentLogToolbarPreset`；`AgentLogLayout` 只吃 `actions: readonly ToolbarAction[]`，调用方可换集、可追加 | **「七个动作是一套预设」，不是「工具条只会这七个」**：通用消费方要能换集、能追加 |

> **D27–D38 只补展示所需的数据结构与文案落点，不改 §5 / §6 的界面形态**。
> 判据是 `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` 的**正文**，不参考实现代码。

| D27 | **消息信封的三格必须摊到块上** | `ContentBlockBase` 补 `role` / `source` / `assembly`；`LogTurn` 补 `running` | 只摊 `messageId` / `subagentId` 会**丢掉**另外三个——于是「谁说的」「实时还是补录」「这块说完了没有」无处表达；而 §6.7 的流式动效全靠最后那一格，缺了它实现只能猜「最后一轮 = 流式中」，一次中断会永远闪光标、半截正文被读成结论 |
| D28 | **能力声明是「维度注册表」，不是两个定字段** | `MessageCapability` 用可变键 + `CapabilityDecl`（`{ level, source, reason }` 三元组）+ `capabilityNotes` | ① 只有 `thinkingText` / `subagent` 两格会缺 `toolInput` / `toolResult` / `streamingDelta`；② **`toolResult` 那一格缺得最要紧**——§9.7 的 `AgentRunStateTagProps.missingReason` 注释写着「`capability` 给」，而契约里没有这一格 ⇒ **该参数恒为 `null`，组件被自己的契约判成空转**；③ 三元组绑死后排除了「有等级没原因」这类自相矛盾；④ 加维度不必改契约（与 `facts.domain` / `EnvGroup.title` 同一条口径） |
| D29 | **族名与「有没有专门卡片」是两件事** | `ToolCallBlock` / `ToolItem` 补 `family: ToolFamily \| null`；`tool` 只表示「本期收没收编专门卡片」 | 只给一个 `tool` 会把「适配器不认识这个工具」与「它有族、只是不在本期两族里」压成同一个 `null`；而「**UI 不判厂商**」逐字要求「**只按 `family` 分支**」——契约里没有这个字段时实现只能按工具名猜，正是该纪律禁止的 |
| D30 | **截断是「已知 / 未知」两态，不是布尔** | `ToolResultBlock.truncated` → `truncation: TruncationState`；`ToolItem.output` 同步 | 规范明写「拿不到截断标记只能记 `false`，但**消费方不得据此断定输出完整**」。裸布尔让「确认完整」与「没采到标记」在界面上完全一样——与本设计反过的「`running` 不可由 `output` 推断」是同一类「用负信号断言正事实」 |
| D31 | **附件本体与「不认识的原样载荷」拆成两个类型** | 新增 `UnrecognizedPayloadBlock`（兜底原文）；`AttachmentBlock` 归还给**真实附件**（`attachmentKind` / `path` / `mimeType`）；`RenderBlock` 相应加一臂 | 借用规范的名字去装「不认识的厂商载荷」会与它**语义正交**（对照表标「一致」则是错登记）；后果是**图片与文件附件没有任何展示路径**（会被画成一大段 base64 或空面板） |
| D32 | **`LogNode` 按形态判别联合** | `SessionNode`（`main` / `subagent` 共用）\| `RowNode`；新增 `SessionFacts`；`RowNode.counts` 补计数格；`RenderBlock` 加 `row-summary` 臂 | 扁平接口会让「只有行级有意义」与「只有会话有意义」的格挤在一张表上互相为 `null`——正是本设计在 `ContentBlock` 上批评过的形状在节点层重演。判别联合顺带给出三处出口（`facts` 只属行级、`kind: 'row'` 的 `counts`、`subagentId` 归会话节点），并让「子任务与主会话逐字同形」从**约定**变成**类型保证** |
| D33 | **子任务行补齐规范要求的列** | `SessionNode` 补 `source` / `dispatchKind` / `usage` / `outcome` / `statusMissing`；`LogNodeStatus` 补 `stopped` 与 `unsettled`（未收场） | 规范的面板②是「每个子任务一行」；把子任务只当导航入口就一眼看不全「有几个子任务、各自状态/结果/用量」。**强杀时收场事件永不到达**，没有「未收场」这一档，一个已经死掉的子任务会永远显示「运行中」；而 `statusMissing` 与 `status` 必须分开记（规范：「不得用 `status: null` 表示未采集」） |
| D34 | **`RowEvent` 补 `warning` 档** | `level: 'milestone' \| 'error' \| 'warning'`；§5.2 去向表加「消息层非致命告警」一行 | codex 的 item 级 `error` 是**非致命告警**（规范逐字「不得当成运行失败」）；它既不是块、又不在去向表里 ⇒ 要么丢弃、要么以**错误条目**的样子出现，把「配置项没认出来」读成「这一行跑失败了」 |
| D35 | **`AskUserInteraction` 按收场形态判别联合** | `AskUserPending`（`state: 'pending'` + `running`）\| `AskUserSettled`（`state: 'settled'` + `outcome` + `answers`） | 三个并列可空字段会允许 `answers 非空 + outcome === null + running === false` 这个组合存在，按 §5.5 判据会渲染成「结果未采集」**而答案就在手上**。这正是本设计在 `Loadable` 上反对过的形状（逐字：「允许 `isLoading && error && data` 这种自相矛盾的组合存在」）——**它违反的是本设计自己的标准，不需要规范背书** |
| D36 | **`TaskPanel.counts` 补 `unknown` 第四格** | `{ pending, inProgress, completed, unknown }` | 规范说 `unknown`「是第四种**显示值**，面板必须能显示」，而 codex 的载荷只有 `{ text, completed }` 二态 ⇒ 该态很常见。只有三格时标题的 `3/5 完成` 在含 `unknown` 项时**分母必错**（三数之和 ≠ 项数），而 §5.4 又规定「UI 不自己算」⇒ 连纠正的余地都没有 |
| D37 | **`AgentLogDiagnostics.lines[]` 补 `summary`** | `summary: string \| null`；有值时优先渲染，`text` 原文仍逐字给出 | 规范逐字：`log.summary` 无则省略，**消费方不得拿 `text` 顶替**。缺这一格时面板只剩逐字原文——一条「未识别事件」的 JSON 原文与一句「收到一条未识别的厂商事件」在排障时不是一回事 |
| D38 | **「有内容但这一类没被转发」是第三种空** | §6.1 补两档如实说明（「运行期只有派发事件与状态」/「该子任务的对话未转发」） | 规范 §7.1 逐字要求 claude 未开 `forwardSubagentText` 时**如实说明「该子任务的对话未转发」**。只有 `empty`（还没跑过）与 loading / error 三档时，进子任务只看到工具流水会被读成「子智能体什么都没说」——把「没转发」说成「没做」 |

| D39 | **三处用量与里程碑归位** | ① `ContentBlockBase` 补 `usage` / `mergeKey`（消息级用量摊到块上）；② 三处用量数字**形制两两可分**（顶部事实条正体 / 里程碑 `Tag` / 消息页脚斜体，§6.11）；③ 消息页脚按 `mergeKey` 分段、`usage` 为 `null` 时整行不出（§6.13）；④ `RowEvent` 补 `turn` 归属键、里程碑按 `(会话身份, 该会话自己的轮次号)` 归位、水位**按会话拆开**（§6.14）；⑤ 行卡片两处浮层的拆行判据（§6.12） | ① 没有 `mergeKey` 就没有可靠的消息身份（`messageId` 每次投递都新分配）⇒ 页脚条数会随流式漂移；② 三处数字同形会被读成同一把尺子（实际是整行累计 / 按轮归属的累计 / 单条消息，三个量）；③ 里程碑原本按**事件时刻**挂到「时刻落在哪两轮之间」，而轮次的时刻是**派生的假时刻** ⇒ 里程碑必然挤在最后几轮。判据是按**号**归位，时刻不参与落点 |

> **D39 是形制与归位规则，不是新界面形态**：同一屏里出现三处同形数字之后必须把三者拆开；
> 逐条见 §6.11 / §6.13 / §6.14。

> **D24 与 D18 的关系（一句话，免得读成推翻）**：D18 说「`agent-log` 整体才是那个通用件」，
> D24 **不推翻它**——通用性仍然由**整个目录**承担，只是目录内部从「九个平铺件」变成
> 「三层 + 一个注册表」。D18 当初反对的是把环境抽屉提为**并列组件**（那会让关闭联动靠记忆），
> 这条依旧成立（§6.8 约束 1 不变）。

## 4. 组件边界与数据契约

### 4.1 模型接口（`AgentLogModel`，纯类型）

> **类型落点（实现口径，与本节的小节号无关，改的是「这些名字住在哪个包」）**
>
> | 类型 | 住在哪 | 为什么 |
> |---|---|---|
> | `ContentBlockBase` / `TextBlock` / `ThinkingBlock` / `ToolCallBlock` / `ToolResultBlock` / `AttachmentBlock` / `UnrecognizedPayloadBlock` / `TruncationState` / `Loadable<T>` | **`@aieval/contracts`**（`src/agent-message.ts` 与 `src/index.ts`） | 它们是**数据层与界面之间的接缝**：适配器产出、`messages.jsonl` 落盘、UI 消费，三方都要能 import |
> | `AgentLogModel` / `AgentLogFacts` / `LogNode` / `LogTurn` / `RowEvent` / `RenderBlock` / `ToolItem` / `TaskPanel` / `AskUserInteraction` / `AgentEnvironment` / `AgentLogDiagnostics` / `AgentLogSource` / 全部中文文案表 | **`@aieval/ui`**（`src/composite/agent-log/types.ts`，**定义只有这一处**） | 它们是**界面词汇**（色档、折叠键、渲染块、文案），放不进服务端的契约包——那会让服务端为了一个 `tone: 'pending'` 而依赖界面口径。`@aieval/client` 用 `export type … from '@aieval/ui'` **原样转出**这几个名字，页面与测试照旧从 `@aieval/client` 取；`export type` 在编译期被抹掉，**运行时不产生任何跨包依赖**，`AGENTS.md` 的依赖表因此不变 |
>
> 两条由此产生的实现口径：
> 1. **契约里的 `MessageCapability` 是扁平的**（`toolResult` / `toolResultSource` / `toolResultReason` 三格同名后缀），界面要的是绑在一起的 `CapabilityDecl` 三元组 ⇒ `types.ts` 的 `toCapabilityMap()` 是这两份形状**唯一**的搬运点，别在页面里再抄一遍；
> 2. **契约里的消息与块都没有时刻**（时刻只存在于行级 `AgentEvent` 上）⇒ 时间轴的时刻是**派生**的：`build-agent-log-model` 用「这一行的开始时刻 + 轮次序号」算出一个基准（`BuildAgentLogModelInput.startedAt`），并如实标注为派生。真正的逐块时刻要等契约补上那一格。

**这个接口是 UI 与数据层的唯一接缝**，按「优化接口、不迁就现状」的原则定稿：
数据层正在重构，故本节**不引用任何当前的传输机制**（`seq` / SSE / `events.jsonl` / `chunk`
全部不在模型里），只描述界面需要的**形状**。

```ts
/** 抽屉渲染的输入模型（UI 的全部输入） */
export interface AgentLogModel {
  /** 契约版本：UI 据此判断来的是不是它认识的那一版（见下方「扩展性」第 3 条） */
  specVersion: 1;
  /** 这一行的事实（只读，不含任何会自己走的数） */
  facts: AgentLogFacts;
  /** 会话树**扁平**存储：主会话 + 所有后代子任务 */
  nodes: readonly LogNode[];
  /** 当前视图（面包屑选中的节点）；UI 内部 state，默认取 kind === 'main' 的那个 */
  activeNodeId: string;
  /** 行级事件在时间轴上的条目（见 §5.2） */
  rowEvents: readonly RowEvent[];
  /** 全无内容（还没跑过）：决定显示空态，而不是空时间轴 */
  empty: boolean;
}

/**
 * 行级事实。**逐条按「界面是否真的需要」定，不照抄任何现有形状**：
 * 会随时间自己变的量（耗时、进度）**不在契约里**——见下方「评估与删除」。
 */
export interface AgentLogFacts {
  /**
   * 运行状态。**界面只要「一个色档 + 一句文案」**，不复用编排状态机。
   *
   * 为什么不直接吃 `EvalRowStatus`：那是**评测编排**的十态词汇
   * （`packages/server/contracts/src/run.ts:37-40` 的 `preparing` / `judging` / `judged` /
   * `interrupted` 只有本仓的评分通路才有），通用消费方没有这些段；而契约里写上它，
   * 「换一个消费场景」就要先改 `@aieval/contracts`——与 D18「不认『评测行』这个业务概念」直接冲突。
   * `tone` 是**界面词汇**（决定徽标色，`running` 还决定要不要 `Badge status="processing"` 的动效，§6.7）；
   * `label` 是**数据层给的文案**（评测侧传 `ROW_STATUS_LABELS[status]`，本仓十态文案一字不丢）。
   */
  status: { tone: 'pending' | 'running' | 'ok' | 'failed' | 'canceled'; label: string };
  /** 开始时刻。耗时由 UI 用现成的 `useNow(active)` 本地走秒表算（`base/use-now.ts` 的既有用途） */
  startedAt: string | null;
  /** 结束时刻；null = 还在跑。终态耗时 = endedAt − startedAt */
  endedAt: string | null;
  /** 已观察到的轮次；total 为 null = 还没跑完（**不是**「一共就这么多」） */
  turns: { current: number; total: number | null };
  /**
   * 计量。**三格各自可缺**（v2 spec 的口径：缺就是缺，不写 0）。
   * 整格为 null = 这一家根本不报（claude-code 只报 turns，见 `agent-event.ts` 的实测注释）。
   */
  tokens: {
    input: number;
    cached: number;
    output: number;
  } | null;
  /**
   * 思考 / 推理 token 的**结算值**与它的**可加性**。
   *
   * **为什么不并进 `tokens` 三元组**：三元组是三家**已统一口径**的量（被快照回写、评分通路、
   * 排序与卡片指标同时读），而本维度与之**可空性、可信度、来源都可能不同**——
   * 「塞在一起，其中一格采不到就会拖住另一格」。
   *
   * **`basis` 决定能不能加**：它**是 `tokens.output` 的子集，不是第四个加数** ⇒
   * `'subset-of-output'` 相加即双计；`'unknown'` 连跨家比较都不允许。
   * 与 `tokens` 同样的缺失口径：`null` = 拿不到（**不写 0**；「报了且是 0」是 `{ tokens: 0, … }`）。
   */
  thinking: { tokens: number; basis: 'subset-of-output' | 'additive' | 'unknown' } | null;
  /**
   * **领域事实**（数据驱动）：与「智能体运行」无关的业务事实由调用方给，UI 只负责摆版。
   *
   * 评测侧放「改动摘要」与「评分」两格；通用消费方给空数组，进度条一样是完整的。
   * **为什么不像上面几格那样定字段**：这些格**因场景而异**（本仓要评分与改动，
   * 别的场景可能要成本、缓存命中率、门禁结果），定字段等于「每加一格事实都要改契约」
   * ——与 `EnvGroup` 同一条口径（§4.3 明写「组名由数据层给，不硬编码在组件里」）。
   * 把 `score` / `diff` 定成固定字段，就是把**评测行**的形状写进通用组件
   * （D18 的反面），不进主模型。
   */
  domain: readonly DomainFact[];
  /** 失败归因。`code` 允许为 null：不是每种失败都有错误码（非空 string 会让「没有码」只能填空串） */
  error: { code: string | null; message: string } | null;
  exitReason: string | null;
}

/**
 * 一条**领域事实**（`facts.domain` 的元素）。
 * 它是「关于这一次运行的一个数」，但**形状因场景而异**，故由数据层给成一行文字 + 一个色档：
 * UI 只摆版、不解析（多值由数据层拼成一行）。
 */
export interface DomainFact {
  id: string;
  /** 格名（如「改动」「评分」）由数据层给——组件的文案表里没有这个业务概念 */
  label: string;
  /** 一行值（如 `+12 −3` / `8/10`） */
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'error';
  /**
   * 补充说明。评分那一格放「尺子」：`ScoreResult` 的注释写明「光有模型名回答不了这个分
   * 是文本请求打的还是智能体会话打的」（`judgeAgentKind` + `judgeModelId`），再加一句话总评。
   * **完整结构仍由「评分详情」抽屉读它自己的 props**，不经过 `AgentLogModel`。
   */
  hint?: string;
}

/**
 * 会话树的一个节点。**扁平数组 + `parentId`**，不建嵌套树：面包屑只走祖先链、级联菜单只取同层兄弟。
 *
 * **为什么按形态判别联合（D32）**：扁平接口会让「只有行级才有意义」的格（`facts` / `domain` / `error`）
 * 与「只有会话才有意义」的格（`content` / `userPrompt`）**挤在同一张表上互相为 `null`**——
 * 即「扁平接口 + 一堆按 kind 才有意义的可空字段」，正是本设计在 `ContentBlock` 上批评过的形状。
 * 改判别联合顺带给出三处出口：只有 `RowNode` 有 `facts`；
 * `kind === 'row'` 有了出口（`counts`）；`subagentId` 由会话节点的格承担。
 */
export type LogNode = SessionNode | RowNode;

/** 两张节点形态共有的格（与形态无关的那些） */
export interface LogNodeBase {
  /** 稳定键：UI 的折叠态 / 面包屑 / 虚拟列表 key 都挂在它上面，**不用数组下标** */
  id: string;
  parentId: string | null;
  /**
   * **派发点**：这个子任务是在父会话时间轴的哪个位置被派出去的（主会话节点为 `null`）。
   *
   * **为什么必须有这一格**：subagent 是**与消息平级的独立事件、
   * 不是消息的子结构**，所以「子任务占位条画在哪一轮的哪个位置」**不能**靠一个
   * 「子任务块」表达——为它伪造一个块正是要避免的（那会多出一个 `kind: 'subagent'` 的块），
   * 那等于要数据层为一件并列事件伪造一个块。现在改为由「派发点」派生（§4.2 规则 3）。
   */
  spawnedBy: { messageId: string; callId: string | null; at: string } | null;
  /**
   * 状态。**七档，且与 `statusMissing` 分开记**（D33）：
   * `status` 永远给一个**可渲染的值**（采不到就是 `'unknown'`），
   * `statusMissing` 说明**为什么采不到**。规范明文要求这一分：
   * 「不得用 `status: null` 表示未采集」——因为那会让「界面没画」与「数据没来」不可分。
   */
  status: LogNodeStatus;
  statusMissing: MissingReason | null;
  startedAt: string | null;
  endedAt: string | null;
  /** 该节点的内容。**按值给，不是取数回调**——见下方边界纪律 */
  content: Loadable<readonly LogTurn[]>;
  /** 内容被上限截断时给一句人话（「只保留了最近 N 轮」），null = 完整 */
  contentTruncatedReason: string | null;
  /**
   * **能力声明：维度名由数据层给**（见 `MessageCapability` / `CapabilityDecl`，D28）。
   * UI 用它把「这家不支持」与「我们没采到」「厂商没投送」显示成**三句不同的话**——
   * 这是本仓最忌讳的「看起来采到了」的反面。
   */
  capability: MessageCapability;
  /**
   * 能力成立的**前提**（路由 / 模型 / 开关）；空数组 = 无条件成立（D28）。
   * 规范逐字要求：「**不得把某一条路由上的取值写成这家的固有属性**」——
   * 同一份能力在不同路由下取值不同（codex 的多智能体就是），故这句前提必须能显示（§6.8）。
   */
  capabilityNotes: readonly string[];
}

/**
 * **会话节点**：主会话与子任务**共用同一份形状**（D32）。
 *
 * 这是「子任务的时间轴渲染与主会话**逐字同形**」在**类型层**的落实方式：
 * 不是一个约定、也不是一句注释，而是两者**就是同一个类型** ⇒ 不可能漂移。
 */
export interface SessionNode extends LogNodeBase {
  kind: 'main' | 'subagent';
  /** 这一节点从哪条通道来（`aggregate` = 厂商只给汇总、没有逐条身份） */
  source: MessageSource;
  /** 子智能体身份；主会话为 `null`。**任务名兜底用它前 8 位**（§6.3） */
  subagentId: string | null;
  /** 厂商侧身份 id；拿不到为 `null`。排障时与厂商流/会话文件对号用（只在块的详情里可选显示） */
  vendorId: string | null;
  /**
   * **派发方式**（`subagent` / `subagent_fork` / `Task` / `spawn_agent` …）；拿不到为 `null`。
   * **与 `kind` 不是一回事**：`kind` 是「这是不是子任务」，这一格是「父用哪种方式派的」。
   */
  dispatchKind: string | null;
  /** 任务名；可为 null（claude 的聚合形态只给计数），组件按 §6.3 兜底 */
  name: string | null;
  nameMissing: MissingReason | null;
  /** 该节点的首条消息（用户提示词）。主会话是对它说话的那个人给的；子任务是父派给它的指令 */
  userPrompt: { text: string; at: string } | null;
  /**
   * **子任务自己的往返用量**（规范 §7.3：按子会话分组求和）；主会话为 `null`
   * ——主会话的整行用量在 `AgentLogModel.facts.tokens`，**不存第二份真值**。
   */
  usage: AgentLogFacts['tokens'];
  /**
   * **子智能体的最终答复**（规范 §2.8 的 `outcome`）；拿不到为 `null`
   * （取消场景常常只有推理块，此时**保持 `null`，不得拿推理或状态文案顶替**）。
   * 主会话为 `null`（它的结论就是时间轴里的正文）。
   */
  outcome: string | null;
  /**
   * 会话级事实。**主会话为 `null`**（它的行级事实在 `AgentLogModel.facts`）；
   * 子任务节点放「这个子任务自己的事实」（若有），与 `usage` / `outcome` 并列。
   *
   * **为什么不复用 `AgentLogFacts`**：那个形状里 `domain`（改动 / 评分这类**业务事实**）
   * 对子任务没有意义（子任务不评分、不改仓库），硬塞会得到一堆恒 `null` 的格。
   */
  sessionFacts: SessionFacts | null;
}

/** 会话级事实：只有子任务节点才可能有的那几格（主会话走 `AgentLogModel.facts`） */
export interface SessionFacts {
  /** 退出/结束原因（拿不到为 `null`） */
  exitReason: string | null;
  /** 失败归因 */
  error: { code: string | null; message: string } | null;
}

/**
 * **行级节点**：厂商只给汇总、没有逐个身份的那一档（规范的 `aggregate` 形态）。
 * **它不进面包屑、不可点**（点进去是一个空会话），只在时间轴上占一条说明行（§6.3）。
 *
 * **`counts` 是这一档唯一的实质内容**（D32）：缺少计数格与对应的 `RenderBlock` arm 时，
 * 于是 §6.3 承诺的那条「带计数与状态的说明行」**在模型层根本画不出来**。
 */
export interface RowNode extends LogNodeBase {
  kind: 'row';
  /** 汇总出来的计数；拿不到为 `null` */
  counts: { subagents: number; completed: number; failed: number } | null;
  /** 行级事实（这一档**必然**是行级，故非空） */
  facts: AgentLogFacts;
}

/** 一个轮次。**只做轻量分组，不建渲染块**——几百轮时先全建 RenderBlock，虚拟滚动就只省了 DOM（§7.2） */
export interface LogTurn {
  /**
   * **统一轮次号**＝「模型一次 API 往返」的口径（与 `usage.turns` 同一把尺子）。
   *
   * ⚠️ **它不是规范的 `message.turn`**：那一个三家语义不同——claude / codex 是合成的模型往返序号，
   * **dsh 是厂商的用户轮号**——规范明文禁止拿它跨家比较或分组（§8.2 的小节号对照）。
   * 若当成同义并据此分组，dsh 上会得到「进度条 60 轮、时间轴 1 轮」的自相矛盾，跳轮器直接失效。
   * ⇒ 换算 / 重编号是**数据层**的事，UI 只吃统一的 `round`。
   * `facts.turns` 与它是**同一把尺子**（`turns.current` = 该节点已给的最大 `round`），
   * 故进度条与时间轴不会互相打脸。
   *
   * `null` = **不属于任何轮次**的内容（厂商 system / 信封类块）。时间轴把它集中成
   * **顶部一个「未归属」段**（仍是一个 `LogTurn`，只是没有轮号），**不丢弃**、也不假装它属于第 1 轮。
   *
   * 分组判据是**消息的 `roundTrip`**（数据层按 `mergeKey` 覆盖累积之后取值）；而**行级事件**
   * （用量里程碑等）**不靠这一格归位**——它们带自己的归属键，见 §6.14。
   */
  round: number | null;
  at: string;
  subagentId: string | null;
  /** **已成形的内容块**（`buildRenderBlocks` 的输入）：增量累积与快照覆盖都在数据层做完了 */
  blocks: readonly ContentBlock[];
  /** 该轮自己的计量（拿得到才有）；整轮总计在 `facts.tokens` */
  tokens: AgentLogFacts['tokens'];
  /**
   * 该轮的**已结算**时长（毫秒）；拿不到为 `null`。
   *
   * ⚠️ **它与 §4.1 评估表里被删掉的那个 `durationMs` 不是同一格**（两处同名会让读者
   * 无法判断被删的是哪个）：
   *   · 被删的是 **`AgentLogFacts.durationMs`**（**行级、会每秒变**的那一个）——
   *     行还在跑时它就是个走动的数，故改由 `facts.startedAt` / `endedAt` 现算；
   *   · **这一格是一轮的结算值**：一轮结束就不再变，不存在「让数据层承担渲染压力」的问题。
   * 界面落点：轮次头显示「本轮 3.2s」（§6.3）。
   */
  durationMs: number | null;
  /**
   * **该轮是否尚未结束**（数据层给）。
   *
   * 为什么必须由数据层给、而不能在 `buildRenderBlocks` 里推：那个纯函数的入参
   * （`blocks` / `nodes`）里**没有这个信息**，猜「最后一轮 = 流式中」会让一次中断
   * 显示成「还在流」。它是 `ToolItem.running` 与 `block.assembly` 在**轮次级**的兜底判据。
   */
  running: boolean;
}

/**
 * 节点的运行状态。**七档**。
 *
 * 四处**不能合并**的区分：
 *   · `stopped`（厂商报的主动取消，dsh 的 `error` + `aborted`）≠ `canceled`（**我们**这一侧轮次被中断）；
 *   · `unsettled`（未收场）≠ `running`：前者是「**等不到了**」（强杀时 `subagent.finished` 永不到达，
 *     不给这一档，一个已死的子任务会永远显示运行中），后者是「还在等」；
 *   · `unknown`（拿到一个认不出的状态值）≠ `unsettled`（状态这一步就没发生过）。
 *   · 与 `statusMissing` 分开记：`status` 永远给可渲染的值，**为什么采不到**由那一格说（§3.3）。
 *
 * ⚠️ **档数与 v3 的关系**：v3 §2.8 的 `SubagentRecord.status` 只列 5 值，而 v3 §5.5 的渲染要求
 * 写「固定为六种……含 `未收场`」⇒ v3 自己的类型与要求对不上。本类型取**七值**：
 * v3 §5.5 的六种语义 + 我们自己的 `canceled`（轮次级中断，不是子任务状态）。
 * **待 v3 补齐后本设计只需复核。**
 */
export type LogNodeStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'canceled'
  | 'unsettled'
  | 'unknown';

/**
 * **一条数据是怎么到我们手上的**（D27）——回答「这行数据凭什么在这儿」。
 *
 * | 取值 | 含义 | 到 UI 的方式 |
 * |---|---|---|
 * | `wire` | 厂商事件流 / 会话通知流 | 逐条进模型，**实时** |
 * | `hook` | 厂商回调（如 codex 的 `SubagentStart`） | 逐条进模型，**实时** |
 * | `session-file` | 厂商会话文件（rollout 等） | 数据层**运行结束后**读，事件流里没有这些条目 |
 * | `aggregate` | 厂商只给汇总、没有逐条身份 | 数据层算出来的形态，**没有逐条条目** |
 *
 * 后两者不是「另一种 `wire`」：一个是**迟到**，一个是**根本不存在逐条**。缺这一格，
 * codex 的思考正文（来自会话文件）会与实时数据**逐字同形**，用户把「事后补录」读成「实时采到」。
 * **与 `role` 的分工**：`source` 回答「凭什么在这儿」，`role` 回答「谁说的」，两者不可互推。
 */
export type MessageSource = 'wire' | 'hook' | 'session-file' | 'aggregate';

/**
 * **缺失原因**（本设计自行定义）。
 *
 * 四个取值各对应一种「缺」的性质，**它们必须在界面上说成四句不同的话**——
 * 把 `not-supported`（这家结构上就没有）说成 `not-observed`（我们有、只是没接），
 * 就是「假装采到了」的反面：**假装没这个地方**。
 */
export type MissingReason =
  /** 这家结构上就没有这个能力 */
  | 'not-supported'
  /** 厂商有数据，但不投送到我们拿得到的通道 */
  | 'not-exposed'
  /** 厂商有、通道也有，但我们当前实现没接 */
  | 'not-observed'
  /** 没验证过——**不要当有、也不要当没有** */
  | 'unverified';

/**
 * 能力等级。**五态**（只写四态会漏掉 `not-projected-by-vendor`）。
 *
 * 第五态是整份规范里最要紧的一格：它说「**厂商有数据，但没投送到我们拿得到的通道**」。
 * 少了它，dsh 的思考计量、codex 事件流的思考正文与工具入参都只能显示成「这家没有」。
 *
 * 与 `MissingReason` 的配对是**固定**的（`no`→`not-supported`、
 * `not-projected-by-vendor`→`not-exposed`、`off-by-adapter`→`not-observed` 或 `unverified`、
 * `unverified`→`unverified`），故 §4.1 的 `CapabilityDecl` 把两者绑成一个不可分的对象。
 */
export type CapabilityLevel =
  | 'yes'
  | 'no'
  | 'unverified'
  | 'off-by-adapter'
  | 'not-projected-by-vendor';

/**
 * **一个能力维度的完整声明**：等级 + 出处 + 为什么——三者**同源，绑成一个不可分的对象**（D28）。
 *
 * **为什么不写三个并列的可空字段**（`…Level` / `…Source` / `…Reason`）：那会得到 5 维 × 3 = 15 个格，
 * 且允许「有等级没原因」「有原因但等级是 yes」这类**自相矛盾组合**存在。
 * 绑成对象后这种组合**在类型上写不出来**（与 `Loadable` 排除 `isLoading && error && data` 同一条纪律）。
 *
 * **为什么用可变键字典而不是定字段**：加一个能力维度**不必改契约形状**——
 * 与 `facts.domain` / `EnvGroup.title` 同一条既有口径（「一律由数据层给，不硬编码在组件里」）。
 */
export interface CapabilityDecl {
  level: CapabilityLevel;
  /** 这一格的值从哪条通道取到；**`level === 'yes'` 时必填**，其余四态为 `null` */
  source: MessageSource | null;
  /** 为什么取不到；**`level !== 'yes'` 时必填**，`'yes'` 时为 `null` */
  reason: MissingReason | null;
}

/**
 * 一次运行的能力声明。**维度名由数据层给**（见 `CapabilityDecl` 的说明）。
 *
 * 已收编的五个维度名（数据层按这个拼写给；UI **不硬编码任何维度名**，
 * 只按收到的顺序渲染——新增维度时组件一行都不用改）：
 * `thinkingText` / `toolInput` / `toolResult` / `subagent` / `streamingDelta`。
 */
export interface MessageCapability {
  readonly [dimension: string]: CapabilityDecl;
}

/**
 * 「还没到 / 读失败 / 有了」三态的标准形状。
 * 用判别联合而不是 `{ data?: T; isLoading: boolean; error: unknown }` 三兄弟：
 * 后者允许 `isLoading && error && data` 这种自相矛盾的组合存在，而每个消费者都得自己猜优先级。
 */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: T };
```

**五条边界纪律**（这一节比上面的字段更重要——字段会变，纪律不会）：

1. **UI 永远看不到传输层**：模型里**没有** `seq`、没有 SSE、没有 `chunk: 'delta' | 'snapshot'`、
   没有「`log` 事件」这个概念。增量累积与快照覆盖是**数据层**的分标协议
   （v3 §6.1/§6.2 把「消费方处置」写在那里）；UI 只看到**已成形的块**，
   以及**两处「当前状态」标记**——`ContentBlockBase.assembly`（这块说完了没有）
   与 `LogTurn.running`（这轮结束了没有）。**两者都由数据层给，UI 不推断**
   （§4.2 第 1 条说明了为什么「推断」在这里是错的）。
   **`log` 原文同理，但它不是「事件」**：它以**已定型的原始输出行**（`AgentLogDiagnostics`，§5.3）
   单独注入，模型里仍然没有事件类型、没有 `seq`、没有增量语义——面板要的是**原文**，
   而不是「一条 `log` 事件」（这与 `RowEvent` 是同一处置：模型里只有给人看的那几行）。
2. **UI 不做取数**：`content` 是**按值给**的，不是 `load()` 回调。
   子任务内容与主会话内容由数据层按同一份模型组装完毕；「进哪个节点才取哪个」是
   **数据层的按需策略**（它可以用 `activeNodeId` 决定取哪个），不是 UI 的职责。
   （写成 `load: () => NodeContentState` 就是把数据层的取数时机泄进 UI 契约。）
3. **不合并事件源**：「`useRowLog` 与 `useRowStream` 按 `seq` 并集」不属于本设计
   （那等于多开一节讲数据层内务）。数据层对外只该给**一条已经合并好的流**；两源合并是它的内务。
4. **UI 不判断大小**：`input.text` / `output.text` 的长度上限与 `truncated` 标记**由数据层算好**
   （工具结果可能是整个文件，把上限判断放前端意味着把全量先传到浏览器再丢掉）。
5. **UI 不判厂商，也不判「族数据的来源」**：卡片只吃 `ToolFamilyPayload`（`task` / `ask-user`）。
   清单在 dsh 的 `arguments` 里、在 claude 的结果累积里，那是适配器的知识；
   让 UI 去挑读哪半边，就是把适配器职责泄进 UI。同理**不按 `agentKind` / 工具名分支**
   （规范 §7.6.4 的一条规则：只按 `family` 分支）。

**评估与删除（逐条给出理由，不是遗漏）**：

| 属性 | 处置 | 理由 |
|---|---|---|
| **`AgentLogFacts.durationMs`**（行级的那个） | **删** | 它会**每秒变**。契约里放一个会自己走的数，等于让数据层承担渲染压力，而 UI 已经有 `useNow` 走秒表（`base/use-now.ts` 的文件头就是为这件事写的）。改由 `startedAt` / `endedAt` 现算。**注意 `LogTurn.durationMs`（一轮的结算值）不在此列**——它不随时间走（与行级那个同名不同义） |
| `attempts`（重试次数） | **删** | 它是**候选行**的属性，不是执行日志的属性。行卡片上已有「已重试 N 次」标签；日志里如实出现的是失败与重试**事件**，那属于 `rowEvents` |
| `diagnostics`（`log` 原文数组） | **移出主模型**（不是删功能） | 原文**必须可查**（D14 / §11 验收 10），但它有几千行、面板又默认收起 ⇒ 与 `AgentEnvironment` 同一条边界：**独立 `Loadable`、按需注入**（§5.3）。写「删」会连带删掉 D14 与验收 10 的落点 |
| `status: EvalRowStatus` | **改 `{ tone; label }`** | `EvalRowStatus` 是**评测编排**的十态词汇（`preparing` / `judging` / `judged` / `interrupted` 只有本仓评分通路才有），写进通用件就与 D18 冲突。界面要的只是「一个色档 + 一句文案」，文案由数据层给（评测侧传 `ROW_STATUS_LABELS`，本仓文案一字不丢） |
| `diff` / `score` | **移出，改 `facts.domain`（数据驱动）** | 它们是**领域事实**、不是「智能体运行」的事实；定字段等于每加一格事实都要改契约——与 `EnvGroup` 同一条口径（§4.3：「组名由数据层给，不硬编码在组件里」） |
| `LogTurn.turn` | **改 `round`（数据层给的统一轮次号）** | v2 §7.0.5 / §7.6.4 明文禁止拿 `message.turn` 分组，且它在 dsh 上是**厂商用户轮号**（v2 spec §7.0.5 / §7.6.4）。见 `LogTurn.round` 的注释 |
| `tokens.reasoning?: number` | **移出，改与 `tokens` 并列的 `thinking`** | v2 §7.7 逐字「为什么不并进 `tokens`」（v2 spec §7.7）；且必须带 `basis`（可加性），否则回答不了「能不能相加 / 能不能跨家比较」 |
| `error.code: string` | **放宽成 `string \| null`** | 不是每种失败都有错误码；非空 string 会让「没有码」只能填空串，与「缺就是缺」冲突 |
| `LogNodeRef` + `siblings` | **删，改 `parentId` + 扁平 `nodes`** | 把「同层兄弟」预先算好塞在每个节点上：N 个节点就有 N 份重复列表，且新增一个子任务要回写**所有**同层节点的 `siblings`。扁平数组 + 一次 `filter` 是 O(n) 且不重复存储（n 是子任务数，几十的量级） |
| `chain`（面包屑链） | **删，改派生** | 从 `nodes` + `activeNodeId` 顺着 `parentId` 走一遍即可，存一份就是第二份真值 |
| `capability: subagent: 'no'` 的语义 | **加 `kind: 'row'`** | 「这家没有子任务概念」不等于「这次没派子任务」。前者是 `capability.subagent === 'no'`，后者是一条 `kind: 'row'` 的正常节点（v2 spec §4 的 `not-observed` 与 `not-supported` 必须分得开） |
| v2 的 `ToolData`（族联合，`args` + `result` 装在一起） | **不照搬，收窄成 `ToolFamilyPayload`** | v2 那个形状是按「一次调用」在**适配器内部**组装的；落到 v2 的**块**上时不成立（`tool-result` 可能没有、`callId` 可能为 null、codex 一个 item 要拆两块——都是 v2 §5.2 的明文）。且 UI 只需要「本次调用后的归一结果」，给它 `args`/`result` 两半，等于让它自己判断 dsh 的清单在 args 里、claude 的在结果累积里 |
| `TaskListArgs`（v2 的空壳 `{ /* 无参数 */ }`） | **删**（不进 UI） | 它是空参数占位，而实测里整表就在 `arguments` 里（v2 spec §7.6.2 ⑨）。「清单从哪读」是适配器的知识，不该在契约里留一个空壳误导下一个人 |
| `TaskListResult.commitModel` | **删** | v2 已明文「**不允许把补丁原样抛给 UI**」（合并是适配器职责）。适配器既然已收敛成整表，UI 拿到 `commitModel` 只会多出一种「自己也来合并一次」的写法，而两份合并必然漂移 |
| 族载荷的挂载点（两块各挂一份，还是只挂一块） | **只挂 `tool-call` 块** | `tool-call` 是**唯一必然存在**的那一块；两块各挂一份就有两份可能不一致的真值（与「不存第二份真值」同一条纪律） |
| 消息信封的 `role` / `source` / `assembly` | **摊到块上**（`ContentBlockBase`，D27） | 只摊 `messageId` / `subagentId` 会**丢掉**另外三个——于是「同一段文字是谁说的」「这条是实时还是补录」「这块说完了没有」三件事在模型里无处表达。**一个块只有一个载体**（合并键的载体分量＝`role` + `parentCallId`），故不会有两份真值 |
| 消息级用量与逻辑消息身份 | **摊到块上**（`ContentBlockBase.usage` / `.mergeKey`，D39） | 块是时间轴唯一拿得到的东西，而页脚要按**逻辑消息**分段：`messageId` 是**每次投递**新分配的（同一条逻辑消息的 delta 与 snapshot 是两个 id）⇒ 不摊 `mergeKey`，页脚条数会随流式追加漂移；不摊 `usage`，页脚只能回读 `LogTurn.tokens`（那是**轮级积出来的另一个量**） |
| `capability` 的两个定字段 | **改可变键的维度声明**（`MessageCapability`，D28） | 定字段意味着「加一个能力维度 = 改契约」；且「等级 / 出处 / 原因」应绑在一起的东西会被散成三个概念。改注册表后与 `facts.domain` / `EnvGroup.title` 同一条既有口径 |
| `ToolResultBlock.truncated: boolean` | **改 `truncation: TruncationState`**（D30） | 规范明写「拿不到截断标记只能记 `false`，**消费方不得据此断定完整**」；裸布尔让「确认完整」与「没采到标记」在界面上完全一样——与本设计反过的「`running` 不可由 `output` 推断」是同一类「用负信号断言正事实」 |
| `AttachmentBlock`（不装「不认识的载荷」） | **拆成两个类型**（D31） | 规范里 `AttachmentBlock` 指的是**认识的真实附件**（image / file + path + mimeType），与「不认识的原样载荷」语义正交。借名会导致**图片与文件附件没有任何展示路径** |
| `LogNode`（扁平接口） | **改按形态的判别联合**（D32） | 「只有行级才有意义」与「只有会话才有意义」的格挤在一张表上互相为 null——正是本设计在 `ContentBlock` 上批评过的形状在节点层重演。判别联合顺带给出三处出口（`facts` 关系、`kind: 'row'` 的 `counts`、`subagentId` 归会话节点） |
| 子任务行缺的格（`outcome` / `usage` / `dispatchKind` / `statusMissing` / `source`） | **补进 `SessionNode`**（D32 / D33） | 规范的面板②是「每个子任务一行」；只当导航入口就一眼看不全「有几个子任务、各自状态/结果/用量」。`statusMissing` 与 `status` **必须分开记**（规范：「不得用 `status: null` 表示未采集」） |

**扩展性（**七条**，回答「以后加东西会不会推翻它」）**：

1. **加块类型不用改模型**：`ContentBlock` 是判别联合，新增一类块 = 加一个 `kind`；
   渲染层按 `kind` 分派（`assertNever` 兜底），**不改 `AgentLogModel` 的形状**。
   （**判别联合**是硬要求：「扁平接口 + 一堆按 kind 才有意义的可空字段」不算——
   那种形状下每加一类带专属数据的块就要再挂一个可空字段，`tool: ToolFamilyPayload | null`
   就是这么来的，且一个 `text` 要承载五种语义。现在的形状与 v2 的 `AgentBlock` 逐成员对应。）
2. **`Loadable<T>` 可复用到别处**：「三态」在本仓出现了很多次（`useRowDiff` / `useRowLog` /
   `RowDiffIndex` 各写一份）。它是一个与业务无关的形状，新面板直接复用。
3. **`specVersion: 1` 是给未来留的门**：数据层与 UI 会并行演进，版本位让
   「模型形状变了」变成一个**可判定**的事（UI 可以降级渲染并如实提示），
   而不是等到某处 `undefined is not a function` 才发现。本期只有 `1`，不加分流逻辑。
4. **不加 `children` / 嵌套树**：UI 的消费者只有「祖先链」与「同层兄弟」两处，
   两者都能从 `parentId` 派生。将来真出现需要整棵树的功能（例如任务树视图），
   那时再加，而不是现在为假想需求建一棵树。
5. **收编新工具族 = 加一个 arm**：`ToolFamilyPayload` 与 `RenderBlock` **都是判别联合**
   （渲染层 `assertNever` 兜底），新增一族不改任何已有形状；本期只收编 `task` / `ask-user`
   两族，其余 8 族走通用工具行（§12）。这也是「族驱动」与「按厂商分支」的分水岭：
   收编第 11 族时，改动量不随厂商数增长。
6. **加一个能力维度 = 加一项声明**（D28）：`MessageCapability` 用**可变键**
   （`CapabilityDecl` 的三元组），新增维度**不改契约形状**、UI 也不必改
   （它按数据层给的顺序渲染，不硬编码维度名）。两个定字段则意味着「加维度 = 改契约」。
7. **加一种节点形态 = 加一个 arm**（D32）：`LogNode` 是判别联合
   （`SessionNode` | `RowNode`），每支只带自己那几格。新增形态（例如「一条被跳过的分支」）
   不改已有格；而 `SessionNode` 被 `main` 与 `subagent` 共用 ⇒
   「子任务与主会话逐字同形」从一个**约定**变成了**类型保证**。

### 4.2 纯函数 `buildRenderBlocks`（落在 `ui` 包，可单测）

**落点说明**：类型（`RenderBlock` / `ToolItem` / `ContentBlock` / `RowEvent` / `ToolFamilyPayload` /
`TaskPanel` / `AskUserInteraction`）随 `AgentLogModel`
一起进 `@aieval/contracts`；**实现**落在 `packages/client/ui/src/composite/agent-log/render-blocks.ts`
（与 `log-format.ts` / `diff-patch.ts` 同层）。理由：契约包只有 node 环境的测试（无 jsdom），
而它的折叠态判据要靠组件测试验。

**职责边界**：它只做「**已成形的一轮消息 → 渲染块**」的规整，
**不碰 `chunk` / 增量累积 / 快照覆盖**（那是数据层——「**UI 永远看不到传输层**」）。

```ts
/**
 * 一轮的**内容块** → 渲染块。四条规整：
 *   1. 按 `callId` 配对 `tool-call` 与 `tool-result`；缺 `callId` 或配不上 ⇒ 降级成独立条目，**不编造关联**；
 *   2. 相邻的工具条目合并成一个工具组；
 *   3. **派发点**出 `subagent-bar`（导航），**不进工具组**——「多了一个可进去看的东西」与「调用了什么」
 *      是两件事，同一轮会同时出现（§11 验收 6）。判据：`nodes` 里有节点的 `spawnedBy` 命中本轮
 *      （`callId` 优先、其次 `messageId`）；**命不中时挂在轮末，不隐藏**（藏起来等于「这一轮没派子任务」）；
 *   4. `family === 'task' | 'ask-user'` 的块**从工具组里提出、原地成卡**并**切断**合并链；
 *      同一轮只有**最后一次** `task` 调用出面板；
 *   5. `kind: 'row'` 的节点出 `row-summary`（带计数与状态的说明行），**整条时间轴只画一次**
 *      （挂第一轮之后）——它是**整个节点**的一条事实，不是「每一轮都有的事」；每一轮都画的话，
 *      两轮的节点上会出现两句一模一样的说明行。判据由调用方给（`turn.firstTurn`），纯函数不自己推。
 *
 * 输入假设（数据层保证，UI 不校验也不补救）：同 `messageId` 的多条消息**已合并完毕**；
 * 缺格一律 `null` + `MissingReason`（**例外是工具名**：拿不到时是**空串** + `nameMissing`）；
 * 块的 `id` 已由数据层给定；`nodes` 是整棵会话树索引，只为规则 3 定位派发点而给。
 */
export function buildRenderBlocks(
  blocks: readonly ContentBlock[],
  nodes: LogNodeIndex,
  /** `at` / `running` / `messageId` / `nodeId` 定位派发点与判定 `ToolItem.running`；`firstTurn` 见规则 5 */
  turn: { at: string; running: boolean; messageId: string | null; nodeId: string; firstTurn: boolean },
): RenderBlock[];

/** 会话树索引：规则 3 定位派发点用。由数据层一次建好，列表按项渲染时复用（§7.2 的护栏不变） */
export type LogNodeIndex = ReadonlyMap<string, LogNode>;

export type RenderBlock =
  | { kind: 'text'; block: TextBlock }
  | { kind: 'thinking'; block: ThinkingBlock }
  | { kind: 'tool-group'; items: ToolItem[] }
  | { kind: 'attachment'; block: AttachmentBlock }
  | { kind: 'unrecognized'; block: UnrecognizedPayloadBlock }
  | { kind: 'subagent-bar'; node: SessionNode }
  | { kind: 'row-summary'; node: RowNode }
  | { kind: 'task-panel'; panel: TaskPanel }
  | { kind: 'ask-user-card'; interaction: AskUserInteraction };
```

**本类型的三个取舍（逐条给理由）**：

1. **`streaming: boolean` 从 `text` / `thinking` 两个 arm 上删掉**，改由 `block.assembly` 承担。
   把 `streaming` 放在 `RenderBlock` 上时，它的**输入来源无处可寻**：
   `buildRenderBlocks(blocks, nodes)` 的两个入参里既没有「轮次是否结束」也没有「当前节点」，
   而模型里也**没有任何流式布尔**（`LogTurn.running` 是轮次级的、`LogNodeStatus` 是节点状态枚举，
   两者都不是「这一块写完了没有」）。实现只能猜「最后一轮 = 流式中」——
   于是一次**被中断**的回复会永远闪光标，而半截正文以正常 markdown 呈现（读成结论）。
   现在判据是 `block.assembly === 'open'`，**它是块自己的事实，不是推断**。
2. **新增 `row-summary` arm**（`RowNode`）：§6.3 承诺这类节点「在时间轴上占一条带计数与状态的
   说明行」，而 arm 里没有它、`LogNode` 也没有计数格时，那条说明行**画不出来**。
   `RowNode.counts` 给了它唯一的实质内容。
3. **`subagent-bar` 的 `node` 收窄成 `SessionNode`**：`kind: 'row'` 的节点不进面包屑、也不可点
   （§6.3），故它不该出现在这个 arm 里——收窄后**类型上就点不进去**。
   `attachment` 一分为二（`attachment` = 真实附件 / `unrecognized` = 兜底原文）见 §4.1 的 D31。

**两族卡片「提出工具组」时要做的第二件事：切断合并链**（`tool-group` 的相邻合并遇到它们即断开，
前后各成一组）。理由是组标题那个 `工具调用 × N` 必须数得清：把一条调用画成了卡片却仍算进 N，
读数就是**不实**的（§11 验收 22）。**`ToolItem` 加 `family` 而不再只用 `tool` 是否为空来分支**
（D29）——两族不从工具组走，其余族本期走通用渲染，`name` + 参数摘要 + 结果已经够
（规范的通用回退不算失败）。

```ts
/**
 * 一个工具条目 = 一次调用 + （可能有的）结果。
 * **`at` 与 `running` 是给界面用的两个布尔/时刻**，不再是「有没有 result」的隐式推断——
 * 「还在跑」与「跑完了但结果拿不到」在折叠态下必须能分开（后者不能一直转圈）。
 *
 * **`running` 的来源**：`buildRenderBlocks` 的两个入参里**没有**
 * 「轮次是否结束」这一信息，故这一格**不能由这个纯函数算出来**。它的生产者是数据层：
 * **`LogTurn.running`**（该轮是否尚未结束，**必填**，见 §4.1 的 `LogTurn`），
 * 纯函数只做转发。**否则实现只能猜**，而猜错的后果正是 §4.2 末段要防的那句
 * 「这一家拿不到工具结果会永远显示成正在跑」。
 */
export interface ToolItem {
  callId: string | null;
  name: string;
  nameMissing: MissingReason | null;
  /** 归一后的族名；无法归类为 `null`（与 `tool` 是否为空**不是**一回事，见 D29） */
  family: ToolFamily | null;
  /** 参数：结构化与原文各留一份（dsh 的 `arguments` 是 JSON **字符串**） */
  input: { value: string | null; text: string | null; bytes: number | null };
  output: {
    text: string;
    status: 'ok' | 'error' | 'unknown';
    bytes: number;
    /** 截断**三态**（`none` / `truncated` / `unknown`），不是布尔——见 D30 */
    truncation: TruncationState;
  } | null;
  /** 发出调用的时刻（折叠态标题里显示「已运行 12s」要用） */
  at: string;
  /** 有调用、结果还没到、且所在轮次尚未结束 —— 只有这一种情况才转圈（由数据层给，见上） */
  running: boolean;
}

/** 时间轴上必须可见的行级事件（§5.2 的逐条去向表决定谁进来） */
export interface RowEvent {
  at: string;
  /**
   * 三档（D34）：`milestone` / `error` / **`warning`**。
   *
   * 为什么要第三档：消息层有一类**非致命告警**（codex 的 item 级 `error`，例如
   * 「有无法识别的配置项」）——规范明文说它**不得当成运行失败**。
   * 只有 `error` 一档时，这类告警要么被丢弃、要么以**错误条目**的样子出现在时间轴上，
   * 把「配置项没认出来」读成「这一行跑失败了」。
   */
  level: 'milestone' | 'error' | 'warning';
  /**
   * **归属键**：这一条事件属于**哪个会话的第几轮**。
   * 数据层从 `usage` 事件的 `turn` 格搬过来；`null` = 没有归属信息 ⇒ 界面按**时刻**归位
   * （与今天逐字相同，见 §6.14）。
   * ⚠️ **它与 `usage.turns`（本行累计轮次）不是一回事**：这一格是**该会话自己的**轮号，
   * 那个是**行**的尺度。两者混用就会出现「用量里程碑全挤在最后几轮」那种错位。
   */
  turn: { subagentId: string | null; round: number } | null;
  /** 给人看的一句话（复用 `log-format.ts` 的既有措辞，不另写一套） */
  text: string;
}

/**
 * 时间轴上的**一条内容块**——它是 `buildRenderBlocks` 的输入，也是折叠态的键控单位。
 *
 * **它是判别联合，不是「扁平接口 + 一堆按 kind 才有意义的可空字段」**：
 * 后者的形状下，每加一类带专属数据的块就要再挂一个可空字段（`tool: ToolFamilyPayload | null`
 * 就是这么来的），且一个 `text` 字段要承载五种语义——那正是本文开头骂旧抽屉
 * 「四类语义完全不同的东西长得一样」（§1）在**类型层**的重演。
 * 现在的形状与 v2 的 `AgentBlock` 逐成员对应（对应关系与差异见本节末的表）。
 *
 * `id` 为什么必须由数据层给：折叠态、React key、虚拟列表的稳定识别**都挂在它上面**。
 * 用数组下标会在流式追加时漂移（「我展开的那条自己合上了」正是这么来的），
 * 而 UI 无法自己造一个稳定 id——它每次只看到「当前这一批块」。
 * 契约层能造（`messageId` + `block.index` 都是稳定输入），UI 不能。
 */

/**
 * 六类块共有的归属字段 + **来源三格**。规范把这几个放在**消息信封**上，定型时摊到块上
 * （**UI 不该再看信封**）。三格各自的必要性：
 *
 *   · `role`：同一段文字**是谁说的**。缺了它，厂商 system 文本若以 `text` 块落地，
 *     会按 markdown 正文渲染且不折叠（§6.1）——与智能体的结论**逐字同形**。
 *   · `source`：这条是实时采到的还是事后补录的（见 `MessageSource`）。
 *   · `assembly`：这块**说完了没有**。它是 §6.7 五处流式动效的**唯一合法判据**——
 *     没有它，`streaming` 只能靠「这是不是最后一轮」猜，一次被中断的回复会永远闪光标。
 *
 * **为什么能放在块上（一个块只有一个载体）**：合并键的「载体」分量就是 `role` + `parentCallId`，
 * 故同一个块不可能同时来自 assistant 正文与工具结果 ⇒ **恰好一个** `role` / `source` / `assembly`。
 */
export interface ContentBlockBase {
  id: string;
  at: string;
  /** 消息归属；`subagentId` 非空表示这条来自子任务（时间轴只显示当前节点的，靠它过滤防串台） */
  messageId: string;
  subagentId: string | null;
  /**
   * **说话者**。`assistant` / `user` / `system` 决定块的角色标签（§6.9），
   * `tool` 与工具类块天然对应（工具结果的正文就是工具说的）。
   */
  role: 'assistant' | 'user' | 'tool' | 'system';
  /** 这条数据从哪条通道来（见 `MessageSource`；非 `wire` 时界面标「补录 / 汇总」） */
  source: MessageSource;
  /**
   * 块形态。**`open` = 还没收到过快照**（进程被中断的块停在这里）。
   * 界面据它挂流式动效，**不得用「有没有后续块」推断**——那会把一次中断显示成「还在流」。
   */
  assembly: 'snapshot' | 'open';
  /**
   * **这条消息自己那一次模型调用**的用量（规范 §2.2 的 `AgentMessage.usage`）。
   * 只有三项（`input` / `cached` / `output`）——`reasoningOutput` 与 `total` **不进界面模型**。
   * `null` = 没有这一格（**不渲染页脚**，不是渲染 0）；只有 `role === 'assistant'` 才可能有值。
   * 与 `LogTurn.tokens`（该轮的计量）**不是一回事**：那一个是轮级、积出来的，这一个是消息级、厂商原文。
   */
  usage: AgentLogFacts['tokens'];
  /**
   * 这条块所属的**逻辑消息**身份（= 契约的 `mergeKey`）。
   * **页脚按它分段，不得用 `messageId`** —— 后者是**每次投递**新分配的
   * （同一条逻辑消息的 delta 与 snapshot 是两个不同 id），拿它分段会让页脚条数随流式漂移；
   * 而块数本来就会随流式追加变化，按数组下标猜同样不可靠（§6.13）。
   */
  mergeKey: string;
}

/** 正文：**只有它走 markdown**（D2）。v2 的 `TextBlock.text` 非空，故这里也没有 missing 格 */
export interface TextBlock extends ContentBlockBase {
  kind: 'text';
  text: string;
}

/** 思考：文本可空，为 `null` 时**必填** `textMissing`（不给空面板，§6.1 例外 3） */
export interface ThinkingBlock extends ContentBlockBase {
  kind: 'thinking';
  text: string | null;
  textMissing: MissingReason | null;
  /**
   * 文本的**完备性**（v2 spec §5.2 的 `ThinkingBlock.textKind`）：claude 是完整推理、
   * codex 只有「推理摘要」、dsh 是完整原文。**UI 据它标注「摘要」而不是假称全文**——
   * v2 §7.6.4 明文允许渲染这一格，理由正是「不给它，UI 要标注就只能去读 `normalizedFrom`，
   * 那是变相按厂商分支」（v2 spec §7.6.4 第二条规则）。
   */
  textKind: 'full' | 'summary' | 'none';
}

/** 工具调用：与 `tool-result` 按 `callId` 配对（§4.2 规则 1） */
export interface ToolCallBlock extends ContentBlockBase {
  kind: 'tool-call';
  /** 关联键；拿不到时为 null（v2 的 `tool-result` 侧本就可空，本设计两侧都放宽） */
  callId: string | null;
  /** 工具名，**原样透传**（D15）；拿不到时是**空串** + `nameMissing`（v2 口径，见 §4.2 输入假设） */
  name: string;
  nameMissing: MissingReason | null;
  /**
   * **归一后的族名**（十个族，见 v2 spec §5.1）；**无法归类时 `null`**。
   *
   * **为什么必须有这一格，而不能只看 `tool`**：`tool === null` 的语义是
   * 「**本期没有为它收编专门卡片**」，它把两件不同的事压成了一个 `null`：
   * 「适配器不认识这个工具」（`family` 也是 `null`）与「它有族、只是不在本期两族里」
   * （`family` 非空）。而「**UI 不判厂商**」逐字要求「**只按 `family` 分支**」——
   * 契约里没有这个字段时，实现只能按工具名猜，正是该纪律禁止的。
   *
   * 它还承载§5.4「四种没有清单的情形」里的两句不同的话：
   * `family === null` → 「适配器不认识」；`family === 'task'` 但 `tool === null` → 「族认得、卡片没收编」。
   */
  family: ToolFamily | null;
  /** 参数：结构化与原文各留一份（dsh 的 `arguments` 是 JSON **字符串**，v2 spec §7.2） */
  input: { value: string | null; text: string | null; bytes: number | null };
  /**
   * 工具族载荷（**只挂 `tool-call` 块**，见下方「两族卡片的载荷」）。
   * `null` = **本期没有为它收编专门卡片**（含「适配器不认识」与「不在两族里」两种，
   * 两者靠 `family` 分开）⇒ UI 走通用工具行（v2 spec §7.6.0 的降级）。
   */
  tool: ToolFamilyPayload | null;
}

/** 工具结果：`status` / `truncated` 由数据层判定（＝「**UI 不判断大小**」） */
export interface ToolResultBlock extends ContentBlockBase {
  kind: 'tool-result';
  callId: string | null;
  text: string;
  status: 'ok' | 'error' | 'unknown';
  bytes: number;
  /**
   * **截断标记是「已知 / 未知」两态，不是布尔**。
   *
   * 规范里明写：拿不到截断标记时只能记 `false`，但**消费方不得据此断定输出完整**。
   * 裸布尔会让界面上「完整」与「不知道完不完整」**完全一样**——
   * 这正是本设计在 §4.2 反过的「用负信号断言正事实」（`running` 不可由 `output` 推断）
   * 在另一个字段上重演。
   */
  truncation: TruncationState;
}

/**
 * 截断状态。
 *
 * - `none`：**确认**没被截断（数据层拿到了标记且为 false）
 * - `truncated`：确认被截断（`reason` 给人话，如「超过 256 KB」）
 * - `unknown`：**没采到截断标记**——界面写「输出可能不完整」，**不写「完整」**
 */
export type TruncationState =
  | { kind: 'none' }
  | { kind: 'truncated'; reason: string | null }
  | { kind: 'unknown' };

/**
 * **附件本体**：厂商给的真实图片 / 文件。
 *
 * **它与 `AttachmentBlock` 是两件事**：后者只装规范指的**认识的附件**，
 * 本类型装的是**我们不认识的厂商载荷**。两者语义正交，共用一个名字会让下一个人把两条路当成一条。
 *
 * 界面落点见 §6.10：图片给类型 + 路径 + MIME（**本期不加载缩略图**），文件给路径 + MIME。
 */
export interface AttachmentBlock extends ContentBlockBase {
  kind: 'attachment';
  /** 附件类别。`image` 与 `file` 的呈现不同（前者可有缩略图，后者只有路径） */
  attachmentKind: 'image' | 'file';
  /** 厂商给的路径；拿不到为 `null`（如内联 base64 的图片） */
  path: string | null;
  mimeType: string | null;
}

/**
 * 兜底：**我们不认识的厂商载荷**（不是 `AttachmentBlock`）。
 * **它是「无法归一的原样保留」，不是「一行文字」**：正文是该载荷的**原文** `raw`，
 * `reason` 说明为什么落到这里；UI 默认折叠（§6.1）。
 * 一处必须守住的取舍：**不**把 `text` 当正文、也**不**把 `vendorType` 当正文——
 * D8 的口径是「归一化是视图，原文才是事实」，故这里给 `raw`，与规范同形。
 */
export interface UnrecognizedPayloadBlock extends ContentBlockBase {
  kind: 'unrecognized';
  reason: 'unrecognized' | 'unmapped-shape';
  /** 厂商原始类型（如 `session/title`、`todo_list`），仅供参考 */
  vendorType: string | null;
  raw: string | null;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | ToolResultBlock
  | AttachmentBlock
  | UnrecognizedPayloadBlock;
```

**`ContentBlock` 与规范 `AgentBlock` 的逐成员对应（差异逐条写明）**：

| 本设计的块 | 规范的对应 | 差异（不藏的） |
|---|---|---|
| `ContentBlockBase` | `BlockBase` + 消息信封字段 | 规范的 **`index` / `normalizedFrom` 不进 UI**（审计线索）；**`raw` 是例外，它有出口** —— 消息级未归类载荷走 `UnrecognizedPayloadBlock.raw`（**默认折叠的原文**，§6.1）。⚠️ **不要把 `raw` 推给「下载台账」**：本设计的台账是 `formatEventLog` 的**文本行**，承载不了「未归类字段原样保留」，这个理由已被否决。本设计反向补 `id` / `at` / `messageId` / `subagentId` / **`role` / `source` / `assembly`**——规范把这七个放在**消息信封**上，定型时摊到块上，UI 不再看信封 |
| `TextBlock` | `TextBlock` | 一致 |
| `ThinkingBlock` | `ThinkingBlock` | **少 `signature`**：它是有意隐藏的 replay 校验串，不进任何呈现，UI 连拿都不该拿到。**`textKind` 的界面落点见 §6.9**（「UI 据它标注『摘要』」这句话有落点与文案） |
| `ToolCallBlock` | `ToolCallBlock` | ① 规范的 `input: unknown`（结构化对象）**收窄成「结构化文本 + 原文文本 + 字节数」**：本期不渲染任何族的参数结构，UI 只给等宽原文（D2）；② **补 `family`**（D29）：没有它「适配器不认识」与「族认得但卡片没收编」压成同一个 `tool === null`，而「**UI 不判厂商**」要求「只按 `family` 分支」；③ `input.bytes` 放宽成**可空**（拿不到时不许写 0，见纪律 1） |
| `ToolResultBlock` | `ToolResultBlock` | ① **多一个 `bytes`**（数据层算好的长度，纪律 4）；② **`truncated: boolean` 改成 `truncation: TruncationState`**（D30）：规范明写「拿不到截断标记只能记 `false`，**消费方不得据此断定完整**」，裸布尔让「完整」与「不知道」在界面上完全一样 |
| `AttachmentBlock` | `AttachmentBlock` | **一致**（D31）：这个名字只装规范指的真实附件。拿它装「不认识的厂商载荷」会与规范的同名类型**语义正交**——那是错登记 |
| `UnrecognizedPayloadBlock`（新增） | 规范里**没有**这一支 | 它是本设计对「不认识的厂商载荷」的兜底。规范把它放在 `AttachmentBlock` 之外是合理的：一个装**认识的附件**，一个装**不认识的原文** |
| **（已删除）`kind: 'subagent'` 的块** | 规范里**没有**这一支 | subagent 是**与消息平级的独立事件、不是消息的子结构** ⇒ 子任务导航改由 `LogNode.spawnedBy` 派生（§4.1 / §4.2 规则 3） |

```ts
/**
 * 工具族（十个）。**族名由工具名决定，不由厂商决定**（规范 §5.1）。
 * 本设计只把其中两族（`task` / `ask-user`）收编成专门卡片，其余八族走通用工具行，
 * 但**族名一律照给**——UI 按它区分「不认识」与「没收编」（D29）。
 */
export type ToolFamily =
  | 'read-file'
  | 'write-file'
  | 'edit-file'
  | 'search-content'
  | 'list-files'
  | 'run-shell'
  | 'web-search'
  | 'spawn-agent'
  | 'task'
  | 'ask-user';
```

**两族「卡片」的载荷**（`ToolCallBlock.tool` 那一格，与 `ContentBlock` 一起进 `@aieval/contracts`）：

```ts
/**
 * 工具族载荷。**本期只收编两族**——它们的渲染形态与「一行工具摘要」差得最远，
 * 且都必须跳出工具组单独成卡。其余 8 族本期走通用工具行（规范 §7.6.4 的通用回退），
 * 族结构在类型上留位但不收编：新增一族 = 加一个 arm（下方扩展性第 5 条），不改任何已有形状。
 */
export type ToolFamilyPayload =
  | { family: 'task'; panel: TaskPanel }
  | { family: 'ask-user'; interaction: AskUserInteraction };

/**
 * 卡片底部的「原始结果」。**归一化是视图，原文才是事实**（v2 spec §7.6.0 逐字）：
 * 卡片可以只画归一后的形状，但原文必须可查（与 §5.3 的三条所有者划分同口径）。
 */
export interface ToolCardResult {
  ok: boolean;
  /** 结果的原始文本；拿不到就是 null */
  raw: string | null;
  /**
   * 结果被上限截断——**与 `ToolResultBlock` 同一个三态形状**（D30）。
   *
   * ⚠️ 这里**不能**用裸 `truncated: boolean`，那与 D30 改判 `ToolResultBlock` 的理由**正面冲突**：
   * 那条理由逐字是「裸布尔让『确认完整』与『没采到标记』在界面上完全一样」。
   * 卡片底部正是靠这一格显示截断提示，所以它必须同样有 `unknown` 这一档。
   */
  truncation: TruncationState;
}

/**
 * `task` 族的卡片载荷：**本次调用之后的整张清单**。
 * 它不是 v2 `TaskListArgs` 的搬运——dsh 的整表在 `arguments.todos` 里、codex 在 `arguments.plan` 里、
 * claude 靠逐条 patch **累积**（v2 spec §7.6.2 ⑨ / §7.6.3）。**「从哪半边读」是适配器的事**，
 * UI 只吃这一份整表（与「**UI 不做取数**」同一条边界）。
 */
export interface TaskPanel {
  /** 整张清单（**整表**是归一结果，不是本次变更） */
  steps: readonly TaskStep[];
  /**
   * 计数是**派生值**，由数据层给（「放这里是为了 UI 不必自己算」）。
   * **`unknown` 必须是第四格**（D36）：规范说它「是第四种**显示值**，面板必须能显示」，
   * 且 codex 的载荷只有 `{ text, completed }` 二态 ⇒ 该态很常见。
   * 少了这一格，标题的 `3/5 完成` 在含 `unknown` 项时**分母必错**，而 UI 又不许自己算。
   */
  counts: { pending: number; inProgress: number; completed: number; unknown: number };
  /**
   * 与**上一张**清单的差分；`null` = 该节点首次出现清单（没有可比的上一张）。
   * UI 按项渲染、看不到上一轮，跨轮比较它做不到 ⇒ 与 `counts` 同一条先例（§5.4）。
   */
  change: { completed: number; added: number; removed: number } | null;
  /** 厂商给的一句话说明（codex 的 `explanation`：**为什么改计划**）；拿不到为 null */
  note: string | null;
  at: string;
  result: ToolCardResult | null;
  /** 有调用、结果还没到、**且所在轮次尚未结束**（与 §4.2 的 `ToolItem.running` 同一判据） */
  running: boolean;
}

/**
 * `ask-user` 族的卡片载荷：**一次提问**——问题来自调用、答案来自结果，**两半归一在同一个形状里**。
 *
 * **为什么按收场形态判别联合（D35）**：三个并列可空字段（`answers` / `outcome` / `running`）
 * 会让 `answers 非空 + outcome === null + running === false` 在类型上合法，
 * 而按 §5.5 的判据它渲染成「结果未采集」——**答案就在手上**。
 * 这正是本设计在 `Loadable` 上反对过的形状（「允许自相矛盾的组合存在，消费者自己猜优先级」）。
 * 做成两支后，**那个矛盾组合在类型上写不出来**。
 */
export type AskUserInteraction =
  /** **还没收场**：答案一定还没到（不是「空数组」——「没人回答」与「答了但一个都没选」是两件事） */
  | AskUserPending
  /** **已收场**：`outcome` 与 `answers` 成对出现，不再各自可空 */
  | AskUserSettled;

export interface AskUserPending {
  state: 'pending';
  questions: readonly AskUserQuestion[];
  at: string;
  /**
   * **还在等**（`true`）还是**等不到了**（`false`）。
   *
   * 这一格不能省：运行时被强杀时结果**永远不会到**，若只写「等待中」，
   * 一张没采到的结果会被永远读成「还在等」（与 §4.2「`running` 不可由 `output` 推断」同一条纪律）。
   */
  running: boolean;
}

export interface AskUserSettled {
  state: 'settled';
  questions: readonly AskUserQuestion[];
  /**
   * 收场方式（七态）。**它在这一支里非空**——「还没收场」已经由上层的 `state: 'pending'` 表达，
   * 不需要再用 `null` 说第二遍（存两份就是第二份真值）。
   */
  outcome: AskUserOutcome;
  /** 答案；`null` = 收场了但没有答案可回填（如 `unavailable` / `timeout`） */
  answers: readonly AskUserAnswer[] | null;
  at: string;
  /** 原始结果（归一化是视图，原文才是事实） */
  result: ToolCardResult | null;
}

/** v2 spec 的 `AskUserResult.outcome` 内联联合，这里给它一个名字（同一份取值，不增不减） */
export type AskUserOutcome =
  | 'answered'
  | 'auto-resolved'
  | 'skipped'
  | 'timeout'
  | 'unavailable'
  | 'rejected'
  | 'canceled';
```

**`TaskStep` / `AskUserQuestion` / `AskUserAnswer` 的字段与 v2 spec §7.6.2 ⑨ / ⑩ 同名同义**，
本节不重复定义。本设计对 v2 只做两处**收紧**（理由在下面的评估表）：`commitModel` 不进 UI 契约、
`TaskListArgs`（空壳）不作为清单的来源。

**为什么族载荷只挂 `tool-call` 块、且只给「归一结果」**：`tool-call` 是**唯一必然存在**的那一块
（`tool-result` 可以没有、`callId` 可以为 null、codex 的一个 item 还要拆成两块——都是 v2 spec §5.2 的明文）；
而把 `args` / `result` 两半交给 UI，等于让它自己判断「清单在 dsh 的 `arguments` 里、在 claude 的结果累积里」——
那是适配器的知识（v2 spec §7.6.0 的责任划分表），也正是 「**UI 不做取数**」要挡住的东西。

**为什么配对放在纯函数里而不是组件内**：`callId` 配对是整套设计里最容易出错的一块
（v2 spec §5.2 明确 `ToolResultBlock.callId` **可以为 null**，且 codex 的
`command_execution` 是**一个** item 同时含调用与结果、要拆成两块）。放在纯函数里，
它可以被逐条单测（§10），组件里只剩渲染。

**`running` 为什么不能由「有没有 `output`」推断**：两者在折叠态下要显示成**两句话**——
「进行中」（转圈）与「结果未采集」（静态灰字 + 原因）。推断出来的话，
「这一家拿不到工具结果」（v2 spec §3 的 `toolResult: 'no'`）会永远显示成「正在跑」，
而那是**假装采到了**的反面。故 `running` 由数据层按「所在轮次是否已结束」明确给出。

**折叠默认态不在这里**：`buildRenderBlocks` 只输出**结构与状态**；
「思考块默认收起」「进行中的组默认展开」「失败的工具组与失败行也默认收起」（末一条见
§6.1 的细则 2）是 §6.1 的**组件内** `activeKey` 计算。理由有两条：
1. 默认态取决于**视图上下文**（是不是正在流、用户是不是手动开过），而纯函数看不见这些；
2. 把它放进纯函数，等于让「同一份输入」在不同的折叠历史下需要不同的输出——
   纯函数的返回值会被缓存，缓存与折叠态混在一起就是「用户展开的面板自己合上了」。

### 4.3 环境信息的模型（`AgentEnvironment`，进 `@aieval/contracts`）
**它是 `AgentLogModel` 的兄弟、不是它的一部分，但它的展示位置在 `agent-log` 内部**：

- **模型独立**（本节最重要的一条）：
  1. **体积**：厂商系统提示词与工具模式串可能是几十 KB——实测里单个 `probe/dumps/dsh.json`
     就有 237 KB。并进主模型意味着**每次流式提交都在搬它**，而 §7.1 整节都在说「提交要快」。
  2. **时机**：它只在环境抽屉打开时才需要。
  故它是**独立的 `Loadable`**，由调用方按需取、按 `Loadable` 注入（与「**UI 不做取数**」同一条边界：
  UI 不取数，只渲染数据层给的形状）。
- **展示在 `agent-log` 里**：环境抽屉是 `AgentLogLayout` 内部的一块（§6.8），
  **不提为并列组件、不需要调用方接线**。「通用」由 `agent-log` 整体承担。

```ts
/** 一个智能体运行在什么环境里 —— 与「日志」解耦的模型（但由 agent-log 负责展示） */
/**
 * 智能体种类。**值域由数据层给、UI 只原样显示**（与 `EnvGroup.title` 同一条口径：
 * 组件的文案表里没有厂商名）。新增一家时这里**不需要**改——
 * UI 只是把它当字符串渲染，不按它分支（「**UI 不判厂商**」明禁按厂商分支）。
 *
 * 本仓当前三家：`'claude-code'` / `'codex'` / `'dsh'`（见 `@aieval/contracts` 的 agent 契约）。
 */
export type AgentKind = string;

export interface AgentEnvironment {
  /** 一行摘要（谁 · 哪个模型 · 哪一档权限），抽屉打开即见 */
  summary: {
    agentKind: AgentKind;
    modelId: string;
    effort: string | null;
    providerName: string;
    baseUrl: string;
    /** 工作区根目录与基线提交（「跑在哪个仓库上」是环境的一部分，排障第一个要看） */
    workspaceBase: string;
    baselineCommit: string;
  };
  groups: readonly EnvGroup[];
}

/**
 * 一组环境信息。
 * `source` 是**必须**的（D17）：它回答「这条要求是谁下发的」，
 * 而这正是把下面三类分开展示的全部理由。
 */
export interface EnvGroup {
  id: string;
  /** 组名由数据层给（不硬编码在组件里）：换个消费场景时组名与分组可以不同 */
  title: string;
  source: 'user' | 'project' | 'vendor' | 'observed';
  items: readonly EnvItem[];
}

/**
 * 一条环境信息。
 * `present: false` 时 **`missing` 必填**——「这一格没有」必须带原因，
 * 否则与「有但是空的」在界面上长得一样（v2 spec §4 的整节口径）。
 */
export type EnvItem =
  | {
      present: true;
      id: string;
      label: string;
      /** 长文本（系统提示词、工具模式串、`disallowedTools` 名单）按原文给 */
      text: string;
      /** 由数据层按上限截断（＝「**UI 不判断大小**」）；null = 完整 */
      truncated: { reason: string; bytes: number } | null;
      /** 约定路径：非空时界面额外给「复制」按钮 */
      copyPath?: string;
      at: string | null;
    }
  | { present: false; id: string; label: string; missing: MissingReason };
```

**固定构成**（`source` 是**提示词栈的层**，不是「谁写的代码」；数据层按 `agentKind` 各自填，
填不出来的那一条走 `present: false`）：

| 组 | `source` | 条目 | 来源（现状核实） |
|---|---|---|---|
| 用户层 | `'user'` | **附件或上下文引用 / 会话续接**（⚠️ **不含**用户提示词——见下方 ⚠️ 段） | 发起这一轮的人给的。**与「考题」这个业务概念无关**——它就是对模型说话的那个人给的输入 |
| 系统层（厂商） | `'vendor'` | 系统提示词 / 已调度的工具 / 斜杠命令或子智能体定义 / 工具模式串 | 厂商事件流自报。**claude-code 的 `system` init 行实测带 `tools`（21 项）与 `slash_commands`（47 项）、`agents`（5 项）、`permissionMode`**；codex / dsh 真机**没有这一类行** ⇒ 整组走 `present: false` + **`not-exposed`** |
| 运行配置 | `'project'` | 权限档 / 被禁用的工具 / 模型与思考强度 / 工作区与基线 | 摘要与工作区取 `EvalRow` / `EvalRun` 的快照字段；**权限档取厂商回显的那一档**（`init.permissionMode`，不抄本仓常量当第二个真源），拿不到走 `not-exposed` |
| 实测统计 | `'observed'` | 用过的工具及次数 | 从这一行**内容记录**（`messages.jsonl`）里的 `tool-call` 按 `name` 计数。**不从事件流数**：事件流的工具名在 codex 上是 `exec_command` 这类入口名，与会话文件里的真名不是一回事 |

**四种 `missing` 的分工（判错会把使用者引到错的方向）**：

| 原因 | 什么时候用 | 本仓实例 |
|---|---|---|
| `not-supported` | 这家**结构上**不支持 | （暂无） |
| `not-exposed` | 厂商**有**数据、但**没投送到我们能读的通道** | codex / dsh 的整组厂商系统层；三家的权限档（除 claude 外） |
| `not-observed` | 厂商有、**我们还没接**（本仓待办） | 系统提示词正文、工具模式串、附件与上下文引用 |
| `unverified` | 没验证过 | （暂无） |

**落点是 `@aieval/contracts`**（`packages/server/contracts/src/agent-environment.ts`）：
ui / client 各自 `export type` 转出，消费方的 import 路径不变。
**不能落在 `@aieval/ui`**：那会让任何生产者都必须依赖 ui，而 `client` 按分层表不依赖 ui
⇒ 这个模型不会有生产者，页面也不会把 `environment` 传进抽屉（它是可选 prop，
「三家都显示『未提供』」这件事会在三个包的用例全绿的情况下发生）。

**⚠️ 用户提示词是「对模型说的话」，不是「环境配置」**（需求方口径）：

它在**消息时间轴的首条**出现（§6.3 / D4），**环境抽屉里不重复列**——
环境抽屉回答的是「系统与运行配置给了它什么」，而对模型说的话属于**对话**，不属于环境。
故上表「用户层」组的常规构成是**附件与上下文引用**这类东西；
`userPrompt` 本身由时间轴承载，两处不重复（避免同一段长文本在两处维护）。

**时间轴的措辞统一为「用户提示词」**（原「任务提示词 / 考题提示词」都是考题视角，D19）：

```
├─ 用户提示词（首条消息，主会话与子任务节点都有）
```

**「已调度的工具」与「用过的工具」必须分开**（这是本节最容易做错的一处）：

- **已调度的工具**（`source: 'vendor'`）：厂商 init 事件自报的**工具面**，没报就是 `not-exposed`；
- **用过的工具**（`source: 'observed'`）：从实际出现的 `tool-call` 统计出来的——**这是统计，
  不是事实声明**，故单列一组、标 `observed`。

把两者混成一个「工具」列表，就会出现「列了 30 个工具，其实只用了 2 个」的误读；
而反过来只给「用过的」，又回答不了「它当时手里有什么」。

**与「时间轴里的子任务链」不重复**：环境信息是**这一行开始时的静态配置**，
子任务链是**运行中发生的事**。两者都不该出现在对方的位置。

### 4.4 数据来源接口 `AgentLogSource`（D24 / 场景 S2）

**它兑现的是「UI 不做取数」的另一半。** 那条纪律写的是「UI 不做取数：`content` 是按值给的」——
「UI 不做取数」这条不变，但**取数时机**不能漏在组件上：`onRetryEnvironment` / `onRetryDiagnostics`
两个回调摆在 `AgentLogView` 的 props 里，等于组件知道「环境信息是进抽屉才取的」。
换一个消费场景（数据层有缓存 / 一次性全给 / 根本没有环境信息）时，这条**时机知识**就要重接一遍。

```ts
/**
 * 数据来源。**把「什么时候要哪一份数据」从组件里搬出去**：
 * 组件只负责**在需要时喊一声**（`requestEnvironment()`），取不取、缓存多久、怎么合并
 * 全由实现方决定。UI 仍然不做取数——它只是把「我需要了」这件事上报。
 *
 * **为什么是一个对象而不是三个回调**：三个回调进 props 时，重组场景里会漂移成
 * 「接了 retry 忘了 diagnostics」；收成一个对象后，换来源 = 换一个对象，
 * 漏接是**类型错误**而不是运行时空白。
 */
export interface AgentLogSource {
  /**
   * 调用方声明「环境信息现在需要了」（入口：用户点了「？环境信息」）。
   * 实现方据此去取，取好后用新的 `environment` props 回灌。
   * **组件不 await 它**，也不从返回值推断状态——状态一律由 `environment` 这个 `Loadable` 表达。
   */
  requestEnvironment?(): void;
  /** 同上，对应「原始输出」面板展开 */
  requestDiagnostics?(): void;
  /**
   * 节点内容读取失败时的重取。**给 `nodeId`**：数据层可能只缓存了部分节点，
   * 不给的话实现方只能「全量重取」或自己猜当前节点（第二份真值）。
   * 重试后同样用新的 `nodes` props 回灌。
   */
  retryNode?(nodeId: string): void;
}
```

**三条口径**：

1. **三个方法全可选**，且**一个都不给时组件照常工作**——`environment` / `diagnostics` 为
   `undefined` 时显示「未提供」、`content.status === 'error'` 时**不渲染重试按钮**
   （而不是渲染一个点了没反应的按钮）。「没有这个能力」与「这次没采到」必须分得开，
   这是 §6.8 已经立过的同一条口径。
2. **不得把 `seq` / 事件流 / 增量累积塞进这个接口**（「**UI 永远看不到传输层**」不变）。
   它是**「我需要了」的上报**，不是传输层。
3. **`requestEnvironment` 在抽屉**每次**打开时各调一次**（不是只在首次）：
   环境是静态配置、重开时拿缓存即可，但**要不要真去取是数据层的判断**——
   组件不实现「只调一次」这类缓存（那会让 UI 持有数据，违反纪律 2）。
   §6.8 约束 2 的「不订阅流、不触发重取」说的是**不因流式事件而重取**，与此不冲突。

## 5. 抽屉内容的三区结构
### 5.0 视觉与尺寸基线

> 下表的数值都是在真实渲染里量出来的（明暗两态各一遍），原始数据见
> `docs/superpowers/notes/2026-10-02-exec-log-visual-measurements.md`。
> **它们是核对基准，不是要照抄的字面量**（§5.0.1）。

#### 5.0.1 一条硬纪律：**只引 token，不写像素**

本仓的紧凑密度由 `packages/client/ui/src/base/density.ts` 唯一定义：
`algorithm: [defaultAlgorithm | darkAlgorithm, compactAlgorithm]` + `token: { fontSizeSM: 11 }`。

**⚠️ 绝不显式写 `fontSize`**：`compactAlgorithm` 会覆盖并反向推导——实测
`{ fontSizeSM: 11 }` → 字号 **12 / 11 / 14**（目标），而 `{ fontSize: 12 }` → **10 / 8 / 12**。
**也不手调 `padding*` / `controlHeight`**：与算法叠加会过度压缩。

⇒ 下文一律写 **token 名**，括号内是实测值，**供核对用、不许照抄成字面量**。

#### 5.0.2 字号 / 间距 / 圆角（明暗两态**完全一致**，只有颜色不同）

| 用途 | token | 实测值 |
|---|---|---|
| 正文、Collapse 头、面包屑、按钮 | `fontSize` | 12 |
| Tag、次级标注 | `fontSizeSM` | **11** |
| 一级标题、卡片标题 | `fontSizeLG` | 14 |
| 行高（正文） | `lineHeight` | 1.667（≈20 @12px） |
| 默认控件高 | `controlHeight` | 28 |
| `size="small"` 控件高 | `controlHeightSM` | **21** |
| 最紧的间隙 | `marginXXS` / `paddingXS` | 4 |
| 块内间隙、块与块之间 | `marginSM` / `paddingSM` | 8 |
| 抽屉内边距、区与区之间、轮次之间 | `paddingMD` / `paddingLG` | 16 |
| Tag、Button 圆角 | `borderRadiusSM` | 4 |
| Card、Collapse 圆角 | `borderRadiusLG` | 8 |

**4px 网格**：≥4 的所有间距都是 `sizeStep` / `sizeUnit` 的整数倍。

#### 5.0.3 组件实测尺寸（暗色 + 紧凑密度）

| 元素 | 实测 | 口径 |
|---|---|---|
| `Tag` | 高 **21.4** · padding `0/7` · 圆角 4 · 字号 11 · 行高 19.8 | `borderRadiusSM` + `fontSizeSM` |
| `Button type="text"`（图标按钮） | **21 × 21** · padding 0 | 触达面积**只有 21px**，见 §5.0.5 |
| `Button size="small"` | 高 **21** · padding `0/7` | `controlHeightSM` |
| `Badge status` 圆点 / 文本 | 点 **5.5 × 5.5** · 文本左距 **4** | antd 默认 |
| `Switch size="small"` | **24 × 14**，手柄 10 × 10 | —— |
| `InputNumber size="small"` | 高 **21.6** · padding `0/7` | —— |
| `Collapse` 头 | 高 **28** · padding `4/8/4/4` · 展开图标 **11 × 20** | 头高 = `controlHeight` |
| `Card` body | padding **12** · 圆角 8 · 边框 `0.8px colorBorderSecondary` | —— |
| `Listy` item | padding `4/12` | 见 §9.6（`List` 已废弃） |
| `MonoText` 内 `code` | 字号 **10.2** · 圆角 3 · 底色 `rgba(150,150,150,.1)` | ⚠️ **全页最小的字** |
| 浮动「回到最新」按钮 | 高 **28** | `controlHeight` |
| 浏览器滚动条 | 15（未自定义） | —— |

#### 5.0.4 结构几何（实测，可直接作为实现的自检值）

| 项 | 实测值 |
|---|---|
| 固定区总高 | **52**（进度条一行 + 「原始输出」折叠入口） |
| 轮次左槽 | 宽 **64** + 右 padding **8** ⇒ 与右内容净距 **24** |
| 轮次内块间距 | **8**（`marginSM`） |
| `rowEvents` 行距 | **4**（`marginXXS`） |
| 滚动容器 | 取满剩余高度（`flex: 1` + `minHeight: 0`） |

#### 5.0.5 对比度（WCAG 相对亮度，含 alpha 合成）

**达标**：暗色正文 **13.4**、`Tag(default)` **11.17**、`MonoText` **13.55**、亮色正文 **16.56 / 15.39**。

**⚠️ 三类不达标，处置口径如下（这是设计取舍，不是缺陷遗漏）**：

| 类别 | 实测 | 处置 |
|---|---|---|
| **语义状态色**（Tag success/error/warning/processing/gold、`Typography type="success"`） | **1.83 – 3.66**，全部 < AA 4.5 | ① **信息绝不靠颜色单通道**——所有 `Tag` 内始终带中文，色只是辅助；② 接受现状，因为改色板会与全站其它页面不一致，且根因是全站统一的紧凑密度；③ **§6.7 的动效因此不得作为唯一信号**（`Tag processing` 只有 3.66） |
| `Typography.Text type="secondary"` | 暗色 **4.52**（**几乎无余量**）/ 亮色 **3.35** | 仅用于**辅助信息**（时间戳、用量、hint）。**不得用它承载唯一的关键信息** |
| `MonoText` 内 `code` | 对比度 13.55 ✅ 但**字号 10.2** | 最小的字。**长文本一律走 `MonoText` 组件本身**（不是内联 `code`），后者字号跟 `fontSizeSM` |

**根因**：`fontSizeSM: 11` 的紧凑密度让字形变小、笔画变细，而 WCAG 阈值不变
⇒ **同一套色板在紧凑密度下更容易不达标**（antd 预设色板按 14px 调）。

#### 5.0.6 图标

- 图标一律来自 `@ant-design/icons`（本仓已在依赖内），**不引其它图标包**。
- 尺寸跟字号走：`Collapse` 展开图标实测 **11 × 20**，`Tag` 内图标与文字同高。
- **纯图标按钮必须同时给 `aria-label` 与 `Tooltip`**（§6.8 的「？环境信息」是唯一一处）。
- **不新造图标形状**：需求方要的「问号」用 `QuestionCircleOutlined`，不自己画。

#### 5.0.7 ⚠️ 内嵌场景的一个陷阱（S1 必读；**jsdom 测不出来**）

把 `agent-log` 嵌进宿主页面时，**只换 `ConfigProvider` 不够**。

实测：根 `Providers` 在最外层挂着 `.ant-app`（antd `<App>`），它带**外层**主题的类名，
于是那个节点上的 `color` 是外层主题的 `colorText`（亮色 ⇒ `rgba(0,0,0,.88)`），
而 `html` / `body` 已经是暗色。**从 `.ant-app` 往下的所有「靠继承拿颜色」的文字都变成近黑**，
落在暗底上**对比度 1.0（完全不可读）**；而读 token 的 `Card` / `Tag` / `Button` **不受影响**
——页面呈「组件正常、正文发黑」的怪状。

**处置（硬要求）**：`AgentLogLayout` 必须在**自己的根节点**上显式声明
`color: token.colorText` 与 `background: token.colorBgLayout`，**不能只依赖 `ConfigProvider`**。
（同一处置也适用于任何把本组件嵌进异主题宿主的场景。）

#### 5.0.8 两态可读性的冒烟要求

明暗两态都必须过一遍**目视**检查，且**用几何断言而不是眼睛**：
① 展开/收起的面板底色与边框在暗色下仍可辨；② `secondary` 文字在两态下都能读；
③ §5.0.5 的三类不达标项**没有承载唯一关键信息**。

---

**下面这张图是本章的三区结构总览**：它回答**抽屉里有什么**（三个区的划分与块级顺序）；
上面这九小节回答**它长什么样、多大、什么颜色**。两者互补：
先看图建立整体，再看 §5.1 的几何与 §5.2–§5.5 的逐块规则。

```
┌─ Drawer（title 恒为「执行日志」，宽度 `size="max(50vw, 800px)"`）────┐
│ ① 固定区（不滚、不可折叠）                                          │
│    事实进度条：状态 · 轮次 · 用量 · 耗时 · 改动 · 评分 · 错误 · 结束原因 │
│    （只在真的在等时出现）等待答复 12m  ← §5.5                        │
│    面包屑：主会话 / 子任务名 ▾  （每段下拉 = 该层兄弟列表，当前项打勾）  │
│    工具条：[下载台账] [跟随最新 ✓] [跳到轮次 __] [只看工具调用][只看错误] [？环境信息]│
│    [原始输出 N 条 ▾]  ← §5.3，默认收起                               │
│ ② 滚动区 = 时间轴（虚拟列表自己就是唯一滚动容器）                     │
│    用户提示词（首条消息，主会话与子任务节点都有）                     │
│    轮次 N · 10:44:31  ← 扁平 + 左槽                                  │
│      思考 ▸ / 工具调用 × 3 ▸ / 正文（markdown）/ 子任务占位条 ▸        │
│      计划清单面板 ▸（状态化整表，§5.4）/ 问答卡片 ▸（含等待态，§5.5） │
│      本条 输入 … · 缓存 … · 输出 …  ← 消息级页脚，斜体（§6.13）        │
│    行级事实：错误条目 / 用量里程碑（`rowEvents`，Tag，§5.2 / §6.14）   │
│ ③ 浮动件：未读时右下角「↓ 回到最新（N 轮未读）」                       │
└──────────────────────────────────────────────────────────────────┘
```

**台账与时间轴是两条内容**：`log-format.ts` 的 `formatEventLine` / `formatEventLog` 只格式化
**行级事件**（`status` / `log` / `vendor-system` / `usage` / `diff-summary` / `score` / `error` / `end`
八类，逐条一行 `[HH:mm:ss] 正文`），供「下载台账」与抽屉的「原始输出」用；
`message` / `subagent` 是**记录流**（`RowRecord`）的类型，不进台账。

### 5.1 几何

> `Drawer` 的 `width` **已废弃**（antd 6：`width is deprecated. Please use size instead.`）。
> `size` 的类型是 `'default' | 'large' | number | string` ⇒ **CSS 表达式可以直接给 `size`**。

**几何的唯一真源是 `packages/client/ui/src/base/drawer-geometry.ts`**（`WIDE_DRAWER_SIZE` /
`NESTED_DRAWER_SIZE` / `MAIN_DRAWER_PUSH` / `DRAWER_SEMANTIC_STYLES`）：三个抽屉（变更详情 / 评分详情 /
执行日志）与两个二级抽屉都从它取，**不许各写一份字面量**（漂移是静默的）。

- 宽度：`size={WIDE_DRAWER_SIZE}` = `max(50vw, 800px)`，`maxWidth: '100vw'`（`styles.wrapper`）。
- `styles.body.padding` 仍是 `0`（2026-09-29 spec §7.2.1 ②）——内边距由内容自己给（`paddingMD`）。
- `destroyOnHidden` 仍为 `true`（与另两个抽屉同口径）。
- `mask`：用 `{ enabled: true, closable: true }`——**`maskClosable` 已废弃**
  （实测警告：`Please use mask.closable instead`）。
- **滚动容器不是 `.ant-drawer-body`**：`AgentLogLayout` 最外层取满**父容器**的全部高度
  （`height: '100%'`，**不是 `minHeight`**——虚拟列表需要确定高度的视口才能算出「渲染哪几项」），
  固定区占自然高度（实测 **52**，见 §5.0.4），虚拟列表用 flex 取剩余高度并自持滚动。
  **「取满父容器」而不是「取满 `body`」**：套 `Drawer` 的是 `AgentLogDrawer`，
  内嵌场景（S1）没有 `body` 可满——几何口径不变，只是参照物从 `body` 改成宿主容器。

### 5.2 行级事件的去向（逐条，不留洞）

模型里没有「事件类型」这个概念（＝「**UI 永远看不到传输层**」），但**数据层在组装 `facts` 与 `rowEvents` 时
必须逐类决定去向**。这张表就是那份决定，UI 侧体现为 `facts` 的字段与 `rowEvents` 的条目：

| 事件 | `facts` | `rowEvents`（时间轴） | 原始输出（§5.3） | 说明 |
|---|---|---|---|---|
| `status` | 最新值 | 否 | 否 | 「正在跑」是当前态，历史态没有信息量 |
| `usage` | 最新值 | **仅当令牌数创新高** | 否 | 见下 |
| `diff-summary` | 最新值 | 否 | 否 | 只在终点有意义 |
| `score` | 最新值 | 否 | 否 | 同上；详情在「评分详情」抽屉 |
| `error` | 最新值 | **是（恒）** | 否 | 失败归因不能只留最后一条 |
| `end` | exitReason | 否 | 否 | 终态 |
| `log` | 否 | 否 | **是（全部）** | D14 |
| **消息层非致命告警**（codex 的 item 级 `error`） | 否 | **是（`level: 'warning'`）** | 否 | （D34）规范明文「item 级 `error` 是**非致命告警**（例如『有无法识别的配置项』），**不得当成运行失败**」。它既不是块（`ContentBlock` 六臂里没有它）、也不是编排层事件，没有出口——于是要么被丢弃、要么以错误条目的样子出现，把「配置项没认出来」读成「这一行跑失败了」 |

**两族卡片不进 `rowEvents`**：`task` / `ask-user` 是**消息层的内容**（`message` 事件里的块），
按轮次落在时间轴上（§5.4 / §5.5），与这张表里的编排层事实不是一类东西。
D23 的「等待输入」徽标同理——它是**当前态**，而 `rowEvents` 装的是发生过的事件。

**`usage` 的「创新高」规则**：`usage.tokens` 是**累积快照**（规范 §2.4 的覆盖语义），
每轮发一条会把同一条信息重复几十遍。故只在「本次三项之和超过此前最大值」时追加一条
`milestone`——它的语义是「上下文又长了一截」，是评测者真正会看的那个拐点。
`turns` 不追加（进度条已经有当前值）。

**水位按会话拆开，且里程碑按号归位**（D39，逐条见 §6.14）：

- 「创新高」这个比较**不是整行一个水位**，而是 `Map<会话身份, 水位>`（`sessionKey = usage.turn?.subagentId ?? 'main'`）——否则子会话的读数会被主会话已抬高的整行水位当场丢掉（表现：子会话节点一条用量行都没有）。老日志（没有 `turn`）全落 `main` 桶 ⇒ 与今天逐字相同。
- 每条里程碑带**归属键**（`RowEvent.turn`），落点是「`(会话身份, 该会话自己的轮次号)` 逐字相同的那一轮」；对不上就不在本节点显示（**不回落按时刻**）。文案里的 `轮次 N` 用**归属号**。

### 5.3 `log` 与原始载荷的去处（D14）

**这四种东西的所有者不同，故出口也不同**（混成一个「诊断输出 N 条」入口是错的）：

| 内容 | 归谁 | 界面出口 |
|---|---|---|
| `log` 事件（适配层的 stdout/stderr、未识别信封） | **可读的原始文本** | 「原始输出 N 条 ▾」：固定区一个 `Collapse ghost`，正文 `MonoText` **逐字原文**，`data-testid="agent-log-diagnostics"`；数据由 **`AgentLogDiagnostics`** 承载（见下） |
| 无法归一的厂商载荷 | **块** | `unrecognized` 块（与文本块同处时间轴，**默认折叠**，§6.1）。**不再另开出口** |
| 真实附件（图片 / 文件） | **块** | `attachment` 块（界面落点见 §6.10）。**它不是「无法归一的载荷」**——两者不共用一个类型名（D31） |
| 完整事件台账 | **归档** | 只有「下载台账」一个出口（§6.6）。它是台账，不是视图 |

**为什么这样分**：前两者都已经有类型化的家（规范在论证「别把不认识的载荷塞进文本」）；
`log` 是无结构的行，只能在时间轴之外找个地方；台账是给机器/归档的，不该在界面上再摊开一遍。

**「原始输出」的形状**——它是**独立的 `Loadable`，不进 `AgentLogModel`**（与 `AgentEnvironment`
同一条边界，理由见 §4.3）：① **体积**（一次评测的 `log` 行可达几千条，并进主模型意味着每次流式提交
都在搬它）；② **时机**（面板默认收起，只有展开时才需要）；③ **归属**（它是**这一行**的输出，
与「哪个会话节点」无关）。

```ts
/**
 * 一行的**原始输出**（`log` 事件的原文）。它是**原文，不是事件**：
 * 没有 `seq`、没有事件类型、没有增量语义（＝「**UI 永远看不到传输层**」的同一条边界）。
 */
export interface AgentLogDiagnostics {
  /** 逐字原文行。UI 不截断、不解析、不合并，也不做「取最后 N 条」这类判断 */
  lines: readonly {
    at: string;
    /** `log` 事件的 `stream`，这里是**给人看的来源标签**，不是要 UI 认的事件字段 */
    source: 'stdout' | 'stderr';
    text: string;
    /**
     * **给人看的一句话**；没有就是 `null`（D37）。规范逐字：`summary` 无则省略，
     * **消费方不得拿 `text` 顶替**——`text` 是原始负载、`summary` 是归纳过的一句人话，
     * 可读性差一个量级（「未识别事件的 JSON 原文」与「收到一条未识别的厂商事件」不是一回事）。
     * **渲染口径**：有 `summary` 时它优先（`Typography.Text`），`text` 原文仍逐字给出，
     * 两者都给、不互相替代。
     */
    summary: string | null;
  }[];
  /** 因上限只保留了最近 N 行时给一句人话（数据层算，纪律 4）；null = 完整 */
  truncatedReason: string | null;
}
```

**取数时机与三态画面**：props 是 `diagnostics?: Loadable<AgentLogDiagnostics>`
（外加 §4.4 的 `source.requestDiagnostics()`）——**取数时机由 `AgentLogSource` 上报**
（面板展开时喊一声），UI 只渲染数据层给的形状（＝「**UI 不做取数**」）。
三态各有画面：`loading` 给 `Skeleton`、`error` 给 `Alert` + 重试、
`ready` 且 `lines` 为空时**不渲染这个入口**（与 §10 的用例一致）。

面板正文按**既有的 `[HH:mm:ss] source + 原文` 形状**渲染——复用 `log-format.ts` 的 `formatEventLine`
那一套措辞，**不改它的语义**（它原来只服务「下载台账」，现在多一个出口，§5 的注照旧成立）。
`at` / `source` / `text` 三格分开给，是为了让「哪一段是格式、哪一段是原文」可分辨。

**⚠️ 依赖数据层的三件事**（写在这里，因为 UI 侧看不出来）：

1. `log` 原文仍然**必须完整可查**——它是排障证据（README 里「对照 `[codex]` 那几行」
   的处置路径就靠它）。数据层不得因为「反正 UI 不怎么显示」而丢弃它；
   **面板默认收起不等于可以不取**：`Loadable` 还没到时如实显示「读取中 / 读失败 + 重试」，
   不假装「一条都没有」。
2. **两个事件源的合并是数据层的内务**（原 §5.4 整节删除，理由＝**不合并事件源**）：
   对外只给**一条已合并的流**。合并判据仍是 `seq` 去重 + 升序 + 「回到 1 = 新一代」
   （`row-stream.ts` 的既有语义），但**这件事不该在页面上做第二次**。
3. **行序与全文由数据层定**：`lines` 已是给人看的顺序，`truncatedReason` 非空时如实显示那句话。

### 5.4 `task` 卡片：状态化清单面板

**它不是一次工具调用的回显，而是「agent 自述的进度」的当前状态。** v2 spec §7.6.4 已定它的渲染形态
（逐字：「**状态化清单面板**：只画**最后一条**结果，历史折叠」），本节只把它落到**轮次时间轴**这个容器上。

**与「派发面板」的边界**（v2 spec §7.6.2.2 的两张面板；混了就是两种事实互相冒充）：

| 问题 | `task` 卡片（本节） | 派发面板（§6.3 的子任务占位条 + 面包屑） |
|---|---|---|
| 回答什么 | 「它**打算**做哪几步、现在到哪一步」 | 「**现在有什么在跑**」 |
| 谁产生 | agent 自己声明（`todo_write` / `update_plan` / claude 的 `Task*`） | 运行时调度（`subagent-start/end`） |
| 更新方式 | **整表**（补丁累积已由适配器收敛，v2 spec §7.6.2 ⑨） | 逐条生命周期事件 |
| 混淆的代价 | 把「计划」读成「已经跑起来的东西」 | 把「跑起来的」读成「计划」 |

**与 `unrecognized` 的边界（同一份载荷不许画两次）**：未归一的厂商载荷走 **`unrecognized`** 块（§5.3）——
它举的例子就是 `vendorType: 'todo_list'`。一旦适配器认识了它（`family === 'task'`、`tool` 载荷非空），
它就该**只**以 `task` 卡片出现；
判据是**族载荷在不在**，不是「名字像不像任务清单」。两条路都画的结果是同一份清单在时间轴上出现两次、
且长得不一样（一次是卡片、一次是折叠的原始载荷），读的人会以为 agent 规划了两遍。
**注意 `attachment` 块不是这一路的兜底**：它装的是**认识的**图片/文件附件（D31 拆开，§6.10）。

**卡片结构**（自上而下）：

1. **标题行**（折叠面板的 `label`）：`计划清单` + 计数（`3/5 完成`）+ **变化摘要**（`+1 完成`）+ 状态
   （进行中转圈 / 结果未采集的灰字）；`note` 有值时补一行灰字（codex 的 `explanation`：为什么改计划）。
2. **清单体**：每项一行——状态 + 文本 +（claude 才有的）`owner` 与依赖。
3. **底部**：`本轮另有 N 次更新 ▾`（本轮更早的调用）与 `原始结果 ▾`（`MonoText` 原文，默认收起）。

**「计数」与「变化摘要」都由数据层给，UI 不自己算**：UI 按项渲染（§7.2），**看不到上一轮的面板**，
跨轮比较它做不到；而数据层本来就有累积态（claude 的补丁累积就发生在那里）。
`TaskPanel.change` 与 `counts` 一样是**派生值**——v2 spec 已为 `counts` 立过这条先例（逐字：
「计数是派生值，放这里是为了 UI 不必自己算」）。

**位置与折叠（本节的四条硬规则）**：

| # | 规则 | 理由 |
|---|---|---|
| 1 | 从**工具组里提出**，按块序**原地**出现（与 `subagent-bar` 同规则） | 「多了一张清单」与「调用了什么」是两件事；留在组里会被读成「又一次工具调用」 |
| 2 | 提出时**切断工具组的合并链**（前面的合成一组、后面的另起一组） | 组标题的 `工具调用 × N` 必须数得清——把一条调用画成卡片却仍算进 N，就是不实的计数 |
| 3 | **同一轮内只画最后一次** `task` 调用，更早的收进面板底部的 `本轮另有 N 次更新 ▾` | v2 spec §7.6.4 逐字：「只画最后一条结果，历史折叠」。整表语义下，同轮多次调用只有最后一次是有效状态 |
| 4 | **跨轮不去重**：有 `task` 调用的轮就画一张；`change === null`（该节点首次）**默认展开**，其余**默认收起** | 去重要跨轮状态，与 §7.2「按项渲染 + 虚拟列表乱序挂载」相冲；收起态标题已带 `3/5 完成 · +1 完成`，所以收起不丢信息 |

**默认展开的两条例外**（与 §6.1 的例外条款同源）：`running === true`（这次更新还没回来）
或结果未采集时**默认展开**且标题写明状态——「正在更新计划」被折叠吞掉，就把唯一的时间信号藏了。

**四种「没有清单」的情形，逐一有明确画面**（不留洞）：

| 情形 | 画面 |
|---|---|
| `steps` 是空数组 | 「清单为空（这家报了空表）」——**不是**空白面板。空表与「没采到」必须分得开 |
| 族载荷缺失（`tool === null`：适配器不认识、或它不在本期两族里） | **回退通用工具行**（v2 spec §7.6.0 的降级：规范化是可选增收，不是必填负担）。这次调用仍在时间轴上，只是没有专门形状 |
| claude 的 `id === null`（v2 spec §11.1 第 27 项：`TaskCreate` 的 `taskId` 来源未定） | **不画 id、也不画依赖**（`blockedBy` 的值就是 id）。**不自己发号**——编出来的 id 会让「依赖」看起来解析成功了 |
| `owner === null` 与 `owner === ''` | 两者**不是一回事**：`null` = 这一家没有「指派」这个概念（**整格不显示**）；`''` = 有概念但当前无人认领（显示「未指派」）。v2 spec §7.6.2 ⑨ 明文要求分开 |

**`TaskStep.status === 'unknown'` 不显示成成功**：四态各有中文与样式（待办 / 进行中 / 已完成 / 状态未知），
`unknown` 用中性灰——与 §4.2 的「`ok: true` 但关键字段为 null 不显示成成功」是同一条口径。

### 5.5 `ask-user` 卡片：问答卡片

**它是时间轴上唯一「会等人」的东西**，而本仓恰恰是无人值守（`approvalPolicy: 'never'`，没有应答面）。
故这张卡片的第一职责不是好看，而是**让「卡在等人回答」一眼可见**（D21 / D23）。

**结构与位置**：同样**从工具组提出、原地出现**（§5.4 规则 1 / 2）。

1. **标题行**：问题数 + 首问的 `header`（没有就给截断到一行的 `prompt`）+ 收场 Tag / 等待状态。
2. **每个问题一块**：`header`（`Tag`）+ `prompt`（正文）+ 选项列表
   （`recommended` 项带「推荐」；`multiSelect` 标「可多选」；`allowOther` 追加一行「其它（自由输入）」）。
3. **答案区**：按 `answers[]` 逐问回填（三条口径见下）。
4. **收场行**：`outcome` 的中文 + 一句话说明 +（等待时）已等待时长。
5. **底部**：`原始结果 ▾`（`MonoText` 原文，默认收起）——归一化是视图，原文才是事实。

**七种收场 + 一种「还没收场」**（v2 spec §7.6.2 ⑩ 的七态逐条落地）：

| `outcome` | 中文 | 样式 | 卡片里如实写出的那一句 |
|---|---|---|---|
| `null`（结果还没到） | **等待答复中…** | `Badge status="processing"` + 走秒表 | 「无人值守的运行里，这一步会一直等到轮次被取消」（dsh 无超时预算） |
| `answered` | 已答复 | 成功 | —— |
| `auto-resolved` | 自动决议 | 警告 | 厂商按 `autoResolutionMs` 自行决定了答案 |
| `skipped` | 被跳过 | 中性 | 用户跳过了这个问题 |
| `timeout` | 超时未答 | 警告 | 厂商的提问超时预算到了 |
| `unavailable` | 无人可应答 | **中性，不是红色错误** | 「本仓没有开应答面（`approvalPolicy: 'never'`）——**已知边界，不是缺陷**」（v2 spec §7.6.2 ⑩ 硬约束 2：失败而不是降级） |
| `rejected` | 被拒绝 | 错误 | 子智能体不能向用户提问（dsh 的 `DELEGATED_CALLER`） |
| `canceled` | 随轮次取消 | 中性 | 轮次被中断，提问一起收场 |

**「还没收场」必须是独立的一支**（本卡片最容易做错的地方）：把它并进七态中的任何一格，
都会把「还在等」说成「已经收场」——它与 §4.2 的「`running` 不能由有没有 `output` 推断」是同一条纪律。

**为什么这一档由类型保证（D35）**：若靠「`outcome === null`」这个**约定**表达，
`answers` / `outcome` / `running` 三个并列可空字段就允许
`answers 非空 + outcome === null + running === false` 这种自相矛盾的组合存在——
按下面这张表它会渲染成「结果未采集」，**而答案就在手上**。
故 `AskUserInteraction` 分成 `AskUserPending` / `AskUserSettled` 两支，
该组合**在类型上写不出来**。本节的表因此读作「`state: 'pending'` 那一支内部再分两种」：

| 判据 | 画面 |
|---|---|
| `state === 'pending'` 且 `running === true` | 「等待答复中…」+ **走秒表**的已等待时长（`useNow(active)`：只有等待中的卡片挂计时器，`active === false` 不挂，见 `base/use-now.ts` 的文件头） |
| `state === 'pending'` 且 `running === false`（轮次已结束，结果没到） | 「**结果未采集**」（静态灰字）——**不能一直转圈**，否则一次没采到的结果会被永远读成「还在等」 |
| `state === 'settled'` | 七态各自的文案与样式（上表）；`answers` 已到手，按下面三条口径回填 |

**答案回填的三条口径**（v2 spec §7.6.2 ⑩ 逐字：`selected` 装的是**选项标签**）：

1. **按 `label` 匹配，不按 id 也不按下标**——`selected` 是标签数组，拿 id 或下标去匹配会一条都对不上，
   而界面上看起来「有答案」。这是最难发现的一类错，故 §10 有专门的变异体。
2. **`custom` 的语义随 `multiSelect` 变**：多选时是**补充**（标签与自由输入都显示）；
   单选时是**覆盖**（只显示自由输入）。照抄 dsh 的契约原文。
3. **`selected` 里出现 `options` 里没有的标签时**：**原样显示**（多一个 Tag），不静默丢弃、也不报错——
   配不上是事实；藏起来就成了「答的和问的对不上时界面上看不出来」。

**三处如实登记**：

1. **`secret: true` 的遮罩是显示口径，不是安全边界**：默认 `••••` + 「显示」按钮，
   但原文仍在结果与事件台账里（「下载台账」拿得到）。**不要把遮罩当脱敏**。
2. **不做美化截断、也不重排选项**：`header` 超过 v2 建议的 8 字符就让它长着——截断会改事实
   （与 D15「工具名原样透传」同一口径）；`recommended` 的置顶是**厂商给的顺序**，UI 只加一个「推荐」Tag。
3. **不在组件里按「主会话 / 子任务」分支**（§9 纪律 1）：「子智能体不能提问」这件事**只体现为
   `outcome: 'rejected'` 与结果原文**。组件若去看节点类型，就把「同一份渲染」这条保证破了。

**这张卡片是只读的复盘视图，不是应答面**：本仓没有应答 handler（`approvalPolicy: 'never'`），
所以卡片上**不提供「回答」按钮**——给一个只在某些场景可用的输入框，会让「评测里的提问为什么没人答」
更难解释。收场行如实说明是谁（没）回答的（§12 已登记为明确不做）。

**「等待输入」在固定区有一个位置（只在真的在等时出现）**：`等待答复 12m`
（`Badge status="processing"` + `Typography.Text`）。范围是**当前节点**（与面包屑的视图作用域一致，D4），
判据是那一格里存在 `state === 'pending' && running === true` 的卡片。它**不新增契约字段**：
UI 从当前节点的块里线性扫一遍即可，与 §5.2 的「创新高」一样是**纯派生**（存一份就是第二份真值）。
子任务节点里的提问按 v2 spec 是**被拒**（`rejected`）而非等待，故正常情况下它不会为子任务亮起；
真亮起时切进那个节点就看到它自己那一格。

## 6. 交互规则

### 6.1 折叠

| 块 | 默认态 | 说明 |
|---|---|---|
| 思考块 | **收起** | 标题「思考」；展开显示 `text` 原文（等宽、斜体、左侧竖线） |
| 工具组 | **收起** | 标题「工具调用 × N · 调用名汇总 · 状态汇总」 |
| 工具行（组内） | **收起** | 摘要行 = 工具名 + 参数摘要 + 状态；点开才是完整命令/参数/结果 |
| 正文 `text` 块 | 不折叠 | 它就是事实内容，折叠它等于把抽屉的目的折掉 |
| 子任务占位条 | 不折叠 | 它是导航入口 |
| 用户提示词 | 不折叠 | 它是「这个节点被要求做什么」的唯一说明（D4） |
| `unrecognized` 块 | **收起** | 内容是我们不认识的厂商原始载荷，默认不该占地方 |
| `attachment` 块（真实附件） | 不折叠 | 它是「这一轮带了这个文件」的事实，与正文同级；详情见 §6.10 |
| 计划清单面板（§5.4） | **首次展开、其后收起** | 第一次要让读的人知道「它打算做什么」，之后只需要知道「走到哪了」；收起态标题已带 `3/5 完成 · +1 完成` |
| 问答卡片（§5.5） | **等待答复时展开**；已收场收起 | 等待态是「卡住了」的唯一信号，折叠它就等于把抽屉里最该露出来的东西藏起来 |

**五条默认态细则（四条例外 + 一条覆盖口径，都必须写进代码，否则会踩）**：

1. **进行中的工具不折叠**：`ToolItem.running === true` 的那个工具组默认**展开**。
   否则「这一步正在干什么」被折叠吞掉，而折叠的意义恰恰是「已确定的事不用一直占地方」。
2. **失败的工具也折叠**（**用户口径**：覆盖「失败的工具自动展开」那条例外）：
   该组内有 `status === 'error'` 时，**组与组内那一行都默认收起**，与成功的一视同仁。
   理由是整齐的默认态：失败通常成片出现，逐条自动展开会把时间轴撑散；而**证据不该要用户点两次才看得到**这件事由组头的标记补回来（下一段）。
   代价由**组头的「失败 N」标记**补回来：`ToolGroupPanel` 在 `extra` 里给一个红色 Tag
   （N = 组内 `output.status === 'error'` 的**条目数**，**调用与孤立结果都算**；一条都没有时整格不渲染），
   于是**收起态仍看得出这一组里出过错**，只是证据要多点一次。
   两处实现细节：① 这一格**不能指望 `AgentRunStateTag`**——它**在结果到手时不表态**
   （`agent-run-state-tag.tsx` 的边界 1，失败的结果恰恰是「到手了」）；② 折叠键的生产者
   （`use-agent-log-view.ts` 的 `defaultOpenKeysOf`）**再也算不出失败**，它只认「进行中」——
   失败标记是 `ToolGroupPanel` 自己的事，两个口径各住各的文件。
3. **思考块 `text === null` 时**：显示 `textMissing` 对应的中文（如「这家拿不到思考文本」），
   **不显示空面板**——空面板会被读成「思考了但什么也没想」（v2 spec §4 的 `MissingReason` 口径）。
4. **运行中的计划清单不折叠**：`TaskPanel.running === true` 或结果未采集时该面板**默认展开**
   且标题写明状态（与例外 1 同源：进行中的事不折叠）。
5. **异常收场的问答展开**：`timeout` / `unavailable` / `rejected` 的问答卡片**默认展开**
   （理由与例外 1 相同——「它没能问成人」不该要用户点两次才看得到）；
   `skipped` / `canceled` / `auto-resolved` 属正常收场，默认收起。

**折叠状态的作用域与键控**：**用 `ContentBlockBase.id` / `ToolItem.callId` 键控，不用数组下标**
（`LogNode.content` 的轮次数会随流式追加而变长，下标会漂——「我展开的那条自己合上了」正是这么来的）。
两族卡片同理：键 = **承载族载荷的那个 `tool-call` 块的 `id`**（同一轮多次 `task` 调用因而各自独立，
只是其中只有最后一张会成卡，见 §5.4 规则 3）。
默认态由组件内的 `activeKey` 计算（**不在纯函数里**，理由见 §4.2 末段）：
内置规则 ∪ 用户手动开过的那些键。**不持久化**（刷新与切换节点即回到默认），
且**流式推进不重置已折叠态**——手动展开过的块在后续事件到达时保持展开。

**折叠态的持有者**：这份 `activeKey` **住在 `useAgentLogView` 里，不住在组件树里**。
两条必守：

1. **L0 纯渲染件一律受控**：`ThinkingBlockView` / `ToolGroupPanel` 等吃
   `open: boolean` + `onOpenChange(next: boolean)`，**自己不 useState**。
   理由不是洁癖，是 §2.1 场景 S3：一个自己持有开合态的折叠件**不能被独立挂载**——
   挂两个实例就是两份互不相干的真值，而 §6.4 要求「工具条开关与角落浮出按钮是同一份 state」
   已经立过同一条纪律。**受控件是「同一份 state 只能有一处」在组件层的落实方式。**
2. **只有 `renderBlock` 分派处注入这份受控态**：`AgentMessageTimeline` 不认识 `activeKey`，
   它只调 `renderBlock(block, { open, onOpenChange })`（§9.2）。这样「折叠态从哪来」
   与「块怎么画」是两个可分别替换的东西——监控台场景可以换一条完全不同的折叠策略
   （例如「永远全开」）而不碰任何一个渲染件。

**空态**：`AgentLogModel.empty === true`（这一行还没跑过、内容为空）时，
时间轴区渲染 `EmptyState`，文案沿用现有 `LogView` 的措辞
（标题「还没有日志」、说明「这一行还没开始执行，或执行尚未产生输出」）——
**不是**渲染一个空的时间轴（那会被读成「界面没渲染出来」）。
注意「读盘失败」不走这里：那是页面层的 `resolveLogDrawer` 的 `failed` 分支，
仍整段替换抽屉内容（既有口径不变），因为把一次带文件路径的真实故障说成
「还没开始执行」是错的。

**「有内容、但这一类内容没被转发」是第三种空**：
`content.status === 'ready'` 且 `turns` 非空，但**一个 `role === 'assistant'` 的块都没有**时，
**不能**渲染成「这个子任务什么都没做」。规范逐字要求 claude 未开 `forwardSubagentText` 时
**如实说明「该子任务的对话未转发」**（默认只投工具调用与工具结果块）。
判据与文案：

| 情形 | 画面 |
|---|---|
| `capability['subagent'].level` 非 `'yes'` | 「子任务轨迹不可用 · <原因中文>」（原因取 `CapabilityDecl.reason`） |
| 有工具块、无 assistant 文本/思考块 · `source === 'session-file'` 且该节点尚未结束 | 「**运行期只有派发事件与状态，完整轨迹要等运行结束**」 |
| 有工具块、无 assistant 文本/思考块 · 已结束 | 「**该子任务的对话未转发**（只投送了工具调用）」——**不写「它什么都没说」** |

这一档与 `empty` 的区别是**「没有内容」与「这一类内容没有」**，与 §5.3 的
`Skeleton` / `Alert` / 空入口三分是同一条口径。

### 6.2 打开与切换

- **抽屉自己不取数**：吃 `AgentLogModel` + `environment?` + `diagnostics?` + `source?: AgentLogSource`
  + `onDownload`（§4.4 / §9.2），＝「**UI 不做取数**」。这条边界的**形状**是：
  组件仍然只渲染数据层给的形状，只是把「我需要了」的时机上报收进了一个对象。
  取数时机、事件源合并、按需加载子任务，全部是数据层的事。
- 面包屑切换节点：**是组件内部 state**（不写 URL）。理由：抽屉本身已经是页面 state
  （`drawer.kind`），再加一层 URL 会让「刷新回到主会话」与「刷新回到第三级子任务」
  出现两个都说得通的期望，而两者都无法从服务端快照恢复（子任务没有独立 id 路由）。
- 切换节点时**滚动位置重置到该节点时间轴顶部**（不是保留上一个节点的位置）。
- 节点内容未到（`content.status === 'loading'`）：时间轴区显示 `Skeleton`
  （**不是空态**——空态会被读成「这个子任务什么都没做」）。
- 节点内容读失败（`content.status === 'error'`）：`Alert` 显示中文原因 + 「重试」按钮。
  **重试是向数据层要一次重取**（回调由页面注入），不是 UI 自己再去请求。

### 6.3 子任务占位条与面包屑的兜底

- 占位条内容：`[子任务]` 标签 + 任务名 + 状态标签 + 「进入 ▸」。
- **任务名为 null 时**用 `子任务 <subagentId 前 8 位>`（v2 spec §6.2 明确 `name` 可为 null，
  claude 的聚合形态就是 `name: null` 且 `source: 'aggregate'`）。**不显示空白**。
- **`kind === 'row'` 的节点不是子任务**：它是「这家只有汇总计数、没有逐个身份」的形态
  （`MessageSource === 'aggregate'` 那一类——**没有逐条条目**，只有汇总）。
  它**不进面包屑、不可点**，
  只在时间轴上占一条带计数与状态的说明行——否则用户会点进一个空会话。
- **占位条对已结束的子任务同样出现**（`completed` / `failed` / `canceled`）——
  评测者回看时需要能进去，「只有正在跑的才可进」会让跑完的行永久读不到子任务。
- 面包屑段：`主会话 / A / B`；不可点的当前段用 `Typography.Text strong` + `aria-current="page"`。
  链由 `parentId` 从 `activeNodeId` 回溯到根**派生**（不存第二份真值）。

### 6.4 滚动（D13）

- 打开抽屉时定位到**最新一轮**（新抽屉的默认诉求是「看现在」）。
- **跟随最新**开启时，新事件到达即把视口带到底（`ListController.scrollToBottom()`）。
- 用户**任何向上滚动**即自动关闭跟随（不需要手动点开关），并在右下角浮出
  `↓ 回到最新（N 轮未读）`；点它回到最新并重新开启跟随。
- 工具条上的 `跟随最新` 开关**只用于显式打开**（关闭由滚动触发）。开关自身的
  打开/关闭态与浮出按钮是同一份 state，不允许两处各存一份。
- 展开/折叠导致的**内容变高变矮由虚拟列表自己补偿**（D9 的全部理由）。

### 6.5 跳转与过滤

- **轮次跳转器**：`InputNumber` + 回车/失焦即跳，落点 `ListController.scrollToTurn(n)`。
  越界输入 clamp 到 `[1, turns.length]` 并**如实回显 clamp 后的值**（不让输入框显示一个没跳到的数）。
- **过滤**（`只看工具调用` / `只看错误`）：过滤在**轮次级**生效——
  过滤后不含目标块的轮次**整轮隐藏**（否则会得到一屏「轮次 12（空）」的噪声）。
  两个过滤可叠加（AND）。过滤生效时固定区显示命中数：`命中 12 / 83 轮`
  （**与「已渲染 N / 共 M 轮」是两个不同的数**：前者是过滤后的命中轮数，后者是虚拟列表
  实际挂载的轮数，见 §7.2。两个都常驻，不互相替代）。
- 过滤不影响面包屑与子任务占位条的可见性（它们是导航，不是内容）。
- **两族卡片算「工具调用」**：`只看工具调用` 命中含 `task` / `ask-user` 的轮次——它们本质就是工具调用，
  漏掉它们会让「过滤后我的计划清单不见了」被读成缺陷。`只看错误` 只认**数据给的 `ok === false`**
  （含 `unavailable` / `rejected` 的问答）与 `rowEvents` 的 `error`，**不按 `outcome` 猜**：
  `timeout` / `skipped` / `canceled` 算不算失败由厂商的结果定，UI 不替它判断。

### 6.6 工具栏

| 控件 | 行为 |
|---|---|
| `下载台账` | 即现有的下载按钮，内容 = `formatEventLog(全量事件)`（来源仍是 `useRowLog`，不是连接里收到的那份）。**不再声称与抽屉逐字一致**（D8） |
| `跟随最新` | 见 §6.4 |
| `跳到轮次` | 见 §6.5 |
| `只看工具调用` / `只看错误` | 见 §6.5 |
| `原始输出 N 条` | 见 §5.3 |
| `？环境信息`（图标按钮） | 见 §6.8——打开环境抽屉（`agent-log` 内部件） |

**这七项是一套「预设」，不是工具条的全部**：上表逐项的**行为**不变，
但它落到代码里是 `AgentLogToolbarPreset` 里的 `ToolbarAction[]`，
`AgentLogLayout` 只吃 `actions` 数组（§9.4）。两处后果：

- 通用消费方**增删动作不必改组件**；
- **每个动作自己决定渲不渲染**，那条判断跟 `visible` 谓词走，不写死在工具条组件里。两个例子：
  - 「原始输出 N 条」：`diagnostics` 为 `undefined`、或其 `lines` 为空 ⇒ **不渲染**
    （§5.3：没有原文就没有入口）；
  - 「？环境信息」：`environment` 为 `undefined` 时**照常渲染**，抽屉里显示「未提供」
    （§6.8：「没有这个功能」与「这次没采到」要分得开）。
  **两者规则相反是有意的**，不要统一成「没数据就不渲染」。

### 6.7 流式可见性与动效

**目的**：让「它正在干活」在**不操作**的情况下就能看出来。今天的抽屉是一坨静态文本，
跑动期与跑完长得一模一样；而一次评测要跑几分钟，使用者需要知道它在动。

**五处动效，全部只在流式期间出现、块结束后立刻消失**（静止即「这件事已经确定了」）：

| # | 位置 | 表现 | 实现 |
|---|---|---|---|
| 1 | 思考块**折叠态的标题** | 「思考中…」**扫光** | 复用现有具名出口 `ACTIVITY_SWEEP_CLASS`（`agent-activity-line.tsx`）——`.aieval-activity-sweep` 已在 `apps/web-next/app/globals.css`，1.8s 线性，**已处理 `prefers-reduced-motion`** |
| 2 | 思考行最前的标记 | 6px 圆点**呼吸**（`opacity` 1→0.25，1.2s） | 只用既有主题变量（`--app-muted`）；**不引图标包**，固定尺寸不撑动布局 |
| 3 | 正文流末尾 | 闪烁光标 `▍` | **CSS 伪元素加在容器上**，`MarkdownText` 一行都不改（`ui` 包不碰渲染细节，见 `MarkdownText` 的文件头） |
| 4 | 进行中的工具行 / 工具组 | 状态用 `Badge status="processing"`（antd 自带动效） | antd |
| 5 | 固定区状态徽标 | 同一套 `Badge status="processing"` | antd |

**为什么扫光只给折叠态的标题**：块结束后的静态文本上加动画，等于把「还在流」这个信号
稀释成噪声；而折叠态下**看不到正文**，标题不表态就没有任何地方能表态了。

**已展开的思考块不做字符级打字机**：它的文字**只追加不重排**，本身已经是「顺着读」的。
逐字打字机要自己维护一个追逐缓冲，还会与 `prefers-reduced-motion` 打架，收益不抵成本。

**刻意不做（本期）**：「在抽屉里中断这一轮」按钮。它需要 `AgentLogDrawer` 多拿一个中断回调，
而**单行终止已经在行卡片上**（`onAbortRow`）——抽屉里再放一个是同一动作的第二个入口，
两个入口的可用面必然漂移。若确实要「就地在抽屉里终止」，那是独立的一次需求。

### 6.8 环境抽屉（`agent-log` 内部的一块）

**它是 `AgentLogLayout` 的内部件，不是并列组件**——三条理由，合成一处：

1. **关闭联动是结构保证的**：它是 `AgentLogLayout` 的子组件，主抽屉一卸载它跟着没。
   调用方**不需要**接线，也不需要记得「关主抽屉时一起关」（提为并列组件时这两件都得靠记忆，
   还得配一条接线守卫）。
2. **开合态归 `useAgentLogView`，但抽屉本体是受控件**（吃 `open` / `onOpenChange`，
   **自己不 `useState`**）。两条收益：① 它能被**单独挂到任何地方**
   （例如设置页的「本机环境」区块），而自己持态的版本只能在 `AgentLogLayout` 里工作；
   ② 换交互形态时换的只是**摆法**（谁渲染 `open`），受控件一行不用改。
3. **不订阅任何流**：它是**打开那一刻的快照**（环境是静态配置，不会变）。

⚠️ **第 3 条不等于「不能向数据层要数据」**：入口被点开时调一次 `source.requestEnvironment()`
（§4.4）是**允许且必需**的——它上报的是「用户要看了」，与「流又来了一帧」无关。
两者混为一谈会出现「点了问号却永远停在『读取中』」。「要不要真去取、走不走缓存」是
`AgentLogSource` 实现方的判断；**组件不实现这层缓存**（那会让 UI 持有数据，违反「**UI 不做取数**」）。

**`AgentLogDrawer` 提供的默认接线**（让评测页一行代码就能用）：问号按钮自己渲染、
`open` 由 `useAgentLogView` 给、点击时同时调 `source.requestEnvironment()`。

**入口**：固定区最右一个 `Button` `type="text"` + `icon={<QuestionCircleOutlined />}`，
`aria-label` 与 `Tooltip` 都写「环境信息」。`environment` 为 `undefined` 时
**按钮照常渲染、抽屉里显示「未提供」**——「没有这个功能」与「这次没采到」要分得开。

**为什么用问号形状但要语义化命名**（需求方原文是「问号图标按钮」，这里按现状解释）：
`?` 在通用语义里是「帮助」，而这里打开的是**调试用的环境事实**；行卡片上已有的按钮
全部是「动作名」风格（执行日志 / 变更详情 / 评分详情）。故用**问号形状 + `aria-label`/`Tooltip`
写「环境信息」**，而不另引 `Tool` / `Code` 图标——少一个图标依赖，形状也是需求方要的。

**几何与行为**（组件内部固定，调用方不必重复给）：

| 项 | 取值 | 理由 |
|---|---|---|
| 落点 | `packages/client/ui/src/base/nested-drawer.tsx` 的 `NestedDrawer`（二级抽屉原语） | 几何与语义槽**只有一处**；`raw-output-panel.tsx` 的原文抽屉用的是同一个件 |
| 几何常量 | `packages/client/ui/src/base/drawer-geometry.ts`：`NESTED_DRAWER_SIZE` / `DRAWER_SEMANTIC_STYLES` | 宽度写成字面量就会静默漂移（主抽屉与二级抽屉共用一份语义槽） |
| `placement` | `'right'`（与主抽屉同侧） | 同侧才是「从主抽屉里再划出一层」的观感 |
| 宽度 | `NESTED_DRAWER_SIZE` = `min(60vw, 900px)`，`maxWidth: '100vw'` | 比主抽屉 `WIDE_DRAWER_SIZE`（`max(50vw, 800px)`）窄一档：从主抽屉里推出来时仍看得见主抽屉 |
| `push` | `MAIN_DRAWER_PUSH = { distance: 360 }`，**声明在主抽屉上** | rc-drawer 的位移量取**父级**那一份：写在二级抽屉上是空转（只挪 antd 默认的 180） |
| `destroyOnHidden` | `true` | 与主抽屉同口径（关掉即卸载，不留浮层状态） |
| `styles.body.padding` | `0`，内边距由内容给 | 与三个既有抽屉同口径 |
| `mask` | `{ enabled: true, closable: true }`（`maskClosable` 已废弃） | 点遮罩关闭是浮层的通用预期 |
| `title` | `环境信息` | `agent-log` 内部件，文案固定，不开覆盖口 |

**内容布局**（自上而下）：

1. **摘要条**：`Descriptions` `size="small"` `column={1}`——智能体 / 模型 / 思考强度 /
   供应商 / 接口地址 / 工作区 / 基线提交。这些是「它跑在什么之上」。
2. **分组**：每组一个 `Collapse`（`items` 的每个 `EnvGroup` 一项），组头 = 组名 + `Tag` 标来源
   （用户层 / 厂商系统层 / 运行配置 / 实测统计）。**组名与分组顺序都由数据层给**
   （`EnvGroup.title` / 数组顺序），组件不硬编码任何一组的名字——
   这样新增一层（例如「项目规范 / AGENTS.md」）不需要改组件。
3. **条目**：`Collapse` 内每条一个「标签 + 正文」块：正文用 `MonoText`（逐字原文、可滚），
   `truncated` 非空时在尾部加一行「已截断（原文 N KB）」+ 「复制全部」按钮，
   有 `copyPath` 时再加「复制」按钮（调试时最常用的是把完整提示词粘到别处）。
4. **缺失项**：`present: false` 的条目渲染成一行灰字「标签 · 原因」，
   原因文案见下面约束 1。**不隐藏**。

**内容写法的两条约束**（结构性的那三条理由见本节开头，此处不重复）：

1. **条目缺失给原因，不隐藏**：`MissingReason` 四态各映射成**一句互不相同的中文**——
   `not-supported` → 「这家结构上就没有」、`not-exposed` → 「厂商没有暴露给我们」、
   `not-observed` → 「我们当前实现没接」、`unverified` → 「没验证过」。
   四态各自的定义见 §4.1；**四句的逐字文案以 §10 的 `capability-notes.test.tsx` 为准**
   （那里是唯一契约）。**不隐藏**：隐藏会把「这家结构上就没有」与「我们没接」说成同一件事——
   那正是「假装采到了」的反面。
2. **不内套第二层滚动区**：长文本交给抽屉自己的 `body` 滚，否则环境抽屉里会出现两条滚动条。
   （与 §5.1「抽屉内只有一个滚动容器」不矛盾——那条是**针对单个抽屉**说的，
   环境抽屉是**另一个抽屉**，各自内部仍只有一个滚动容器。）

### 6.9 块的角色标签与来源标注（D27）

`ContentBlockBase` 补的 `role` / `source` / `assembly` 三格各自有一个**可见**落点
（不然它们就只是躺在契约里的装饰）：

| 格 | 界面表现 | 为什么必须有 |
|---|---|---|
| `role === 'assistant'` | **不标注**（它是默认的主角，标了反而吵） | —— |
| `role === 'user'` | 左侧竖线 + `Tag`「用户」 | 首条之后的用户消息（一次会话可以有多个用户轮）今天会被渲染成智能体的输出——「用户在读一份不知道谁在说话的记录」 |
| `role === 'system'` | `Tag`「系统」+ **不折叠但降一档**（`Typography.Text type="secondary"`） | 厂商 system / 信封类文本若走 `text` 块，会按 markdown 正文渲染且不折叠，与智能体的结论**逐字同形** |
| `role === 'tool'` | 由工具类块自身表达（不另标） | —— |
| `source !== 'wire'` | 块角标 `Tag`：`session-file` → 「补录」、`aggregate` → 「汇总」、`hook` → 不标 | codex 的思考正文来自**会话文件**（运行结束后才有），界面上与实时数据逐字同形 ⇒ 用户把「事后补齐」读成「实时采到」 |
| `assembly === 'open'` | §6.7 的扫光 / 光标（**唯一判据**） | 见 §4.2 第 1 条：模型里**没有任何流式布尔**，若不靠这一格，实现只能猜「是不是最后一轮」——一次中断会永远闪光标 |
| `ThinkingBlock.textKind === 'summary'` | 标题后缀 `Tag`「摘要」 | codex 事件流那一格按厂商定义**只有推理摘要**；不标注就是「假称全文」 |
| `ThinkingBlock.textKind === 'none'` | 已由 §6.1 例外 3 承担（显示 `textMissing`） | —— |

**`contentTruncatedReason` 非空时**同样如实显示那句话（内容被上限截断，与「最后一条就是终点」不是一回事）。

### 6.10 附件块的呈现（D31）

`attachment` 块是**认识的真实附件**，与 `unrecognized`（不认识的载荷兜底）走两条路：

| 内容 | 画面 |
|---|---|
| `attachmentKind === 'image'` | `Tag`「图片」+ `path`（`MonoText`）+ `mimeType`。**本期不加载缩略图**——加载远程资源会牵出鉴权、体积、CSP 三件事，不属于数据结构这一轮；结构上留位，渲染上先占位 |
| `attachmentKind === 'file'` | `Tag`「文件」+ `path` + `mimeType` |
| `path === null`（内联附件） | 「内联内容，无路径」（**不显示空白**，也不编造路径） |
| `unrecognized` 块 | 折叠的 `raw` 等宽原文（**默认收起**，§6.1） |

**附件出现在两处，都要接**：① 用户消息里（`LogNode.userPrompt` 本期仍是
`{ text, at }` 纯文本，**附件不进它**——它只承载提示词正文；附件以 `attachment` 块
出现在该节点的首轮）；② 工具结果里（`ToolResultBlock` 本期不加附件出口，
**登记为不做**：规范说 claude 的图片可以出现在工具结果里，但本仓工具结果以文本为主，
加这一格会让 `ToolResultBlock` 多一层嵌套，等真有截图需求再加）。

### 6.11 三处「用量」数字的形制与落点

同一个抽屉里会出现三处用量数字，**它们不是一把尺子**（一个是整行累计、一个是按轮归属的累计、一个是单条消息），
故**形制必须两两可分**——否则读的人会把「这一条消息花了多少」当成「这一行花了多少」：

| 落点 | 量 | 形制 | 文案 |
|---|---|---|---|
| 顶部固定事实条 | **整行**累计（主会话 + 全部子智能体） | `Typography.Text type="secondary"`，**正体** | `输入 … · 缓存 … · 输出 …` |
| 轮末的用量里程碑（§5.2） | **该会话到这一轮为止**的累计 | **`Tag`（色块）** + 时刻 | `用量 输入 … · 轮次 N`（N = **归属轮次号**） |
| 消息页脚（§6.13） | **这一条消息自己那一次模型调用** | `Typography.Text type="secondary"` + **`italic`**，**不得**用 `Tag` / `Badge` 包裹 | `本条 输入 … · 缓存 … · 输出 …` |

- 为什么页脚必须加 `italic`：`Typography.Text` 只有 `type="secondary"` 这一档弱化，正体与顶部事实条**逐字同形**（会看混）；斜体是原生可用的第二档，且**不引入任何手写样式**。
- 数字格式化**复用同一处**（`base/metric-line.tsx` 的 `formatCount`，事实条与行卡片同一出口），不新写第二份千分位实现。
- 里程碑那一格**一个字都不改**（仍是既有 `Tag`）；卡片正文那一处同理。

### 6.12 子任务那一份用量的两行浮层（行卡片）

「tok / 缓存命中 / 轮次」三格上的 `MetricLine` 只有**两个**数字位（合计在正文里），浮层按下面的判据**决定要不要拆两行**——两处各自独立判、都不新算任何数：

| 格 | 拆分口径 | 画第二行的判据（缺一条就退回改动前那一行且**连浮层都不出现**） |
|---|---|---|
| **tok / 缓存命中** | 主会话 = 合计 − 分量（**相减派生，不是第二份真值**）；子智能体 = 分量本身 | 分量**在**（不是缺格）、三项之和**不全为 0**、且**逐格 ≤ 合计** |
| **轮次** | 同上，主会话 = `turns − subagentTurns` | 分量**在**、`> 0`、且 `≤ turns` |

- 文案形如 `主会话 输入 16,103 · 缓存 45,312 · 输出 1,897` / `子智能体 输入 14,648 · 缓存 13,696 · 输出 2,539`；轮次那一格是 `主会话 6 轮` / `子智能体 3 轮`。
- **两格刻意不同**：token 那一格即便不拆也有一行「输入 … · 缓存 … · 输出 …」可讲（合计本身）；**轮次那一格只讲「怎么拆」，没有分量可拆时连浮层都不出现**——不要顺手把它补成一个只有合计的浮层。
- ⚠️ **`{0,0,0}` 与 `null` 在这里渲染逐字相同（都只有一行），这是规则、不是漏做**：两者的区别在**契约与日志**里承重（一个说「确实没有」、一个说「没采到」），而这一格回答的是「子那一份怎么拆」——没有可拆的东西时，两种情形要画的本就是同一行。为它再造第三种文案，等于把「没采到」塞进一个只讲拆分的浮层里。
- `≤ 合计` 那一条**不是装饰**：它是数据层不变量保证的，界面再查一遍是**纵深防御**——一份老 `run.json`（这一格由别的版本写入过）或一次将来引入的缺陷，都会以「两行自己都不自洽」的形式出现在用户面前，而那种画面看起来完全正常。
- **浮层类否定面的断言必须等满延迟窗口**（antd 的 `mouseEnterDelay` 默认 0.1s，悬浮完**同步**查 `.ant-tooltip` 在任何实现下都为真）⇒ 用 `expectNoTooltip()`，不要同步断言。

### 6.13 消息级用量页脚

**数据来源**：`ContentBlockBase.usage`（契约的 `AgentMessage.usage`，摊到块上）+ `ContentBlockBase.mergeKey`（摊到块上的原因见 §4.1 的 `ContentBlockBase` 注：`messageId` 是**每次投递**新分配的，不能当消息身份）。

**渲染规则**：

- 页脚元素带 **`data-usage-footer`** 锚点（沿用 `data-turn-row` / `data-row-event` 的习惯：断言数自己标的属性，不数 antd 内部类名）。
- **按 `mergeKey` 去重**：从 `turn.blocks` 里取「`role === 'assistant'` 且 `usage` 非空」的块，同一条逻辑消息的多个块**只出一行**页脚；一条消息的每个块共享同一个 `usage`（从同一条 `message` 摊下来的），故取段内任一非空值即可，不必逐块比较。
  ⚠️ **页脚不插进 `render-blocks` 的产物**：渲染块是判别联合，且**相邻工具条目会并成一个 `tool-group`** ⇒ 渲染块的下标与 `turn.blocks` 不对齐，按「块段」插入会把页脚插到错的块后面。正确落点是在 `blocks.map(...)` **之后**、行级事件（`RowEventLines`）**之前**渲染这一组页脚。
- **`usage === null`（含整格缺键）⇒ 整行不渲染**：不是渲染 0、也不是写「未采集」。只有 `role === 'assistant'` 的消息才可能有值。
  **这条判断落在 UI 组件里**（数据层照实把 `null` 交上来）：在数据层把 `null` 抹掉，会让「这一家不交消息级用量」与「这条消息没有用量」在 UI 侧不可分。
- **与里程碑是两个不同锚点**（`[data-usage-footer]` vs `[data-row-event]`），两者**互不嵌套**（既有用例已钉）。
- 子会话节点**同样渲染**（该节点的消息上也带 `usage`）。

### 6.14 用量里程碑的归位

**规则**：用量里程碑按它**自带的归属键**归位，归属键 =（**会话身份**，**该会话自己的轮次号**）。

- **归属键由适配器在发 `usage` 事件时填**（谁能知道这次读数发生在哪个会话的哪一轮，谁填）：事件上那一格是 `usage.turn: { subagentId, round } | null`（契约见规范 §2.6 的口径）。
- **界面两条规则，不留洞**（`rowEventsOfTurn(turns, events, index, homes?)`）：
  1. **有归属键**：本轮的 `(turn.subagentId, turn.round)` 与它**逐字相同** ⇒ 归本轮；本节点**没有这一轮** ⇒ **本节点不显示它**（它属于别的会话节点）。**不回落按时刻**——回落会把不属于这一轮的读数塞进最后一轮，正是要消灭的那个毛病。
  2. **无归属键**（`error` / `warning` 这类行级事件，以及下面的「孤儿」）：**沿用按时刻**的规则（`index === 0 || turn.at <= event.at` 且下一轮不存在或 `next.at > event.at`）。
- **「孤儿」= 归属键整行任何节点都没有那一轮**（异常形状：里程碑引用了一个没有内容的轮次）：它在 `buildAgentLogModel` 里就被抹成 `turn: null` ⇒ 走规则 2，**不丢**。判据是「全部会话节点的 `(subagentId, round)` 集合」，`rowEventsOf` 因此多收一个可选的 `homes` 参数；**不给时按「全是孤儿」处理**（老调用方与老用例的形状逐字不变）。
- **里程碑的选取规则与数值口径一个字不改**：`tokens` 仍是累积快照、仍只在三项之和创新高时出一条；`轮次 N` 的 N **改用归属轮次号**（与它所在的分组同值，不再用本行累计轮次）。
- 过滤器（`只看错误` 等）走的是**同一个** `rowEventsOfTurn` ⇒ 归属规则一处生效、处处一致，不另写一份。
- ⚠️ **用量里程碑的落点不依赖时刻**：时间轴上的轮次**时刻**是派生的假时刻（§4.1 的落点说明），里程碑按**归属键**归位。⇒ 「按时刻挂事件」只是**没有归属键时**的回落，不要写成 `usage` 的规则。

**水位（`highWater`）必须按会话拆开**（`Map<sessionKey, highWater>`，`sessionKey = turn?.subagentId ?? 'main'`）：

- 没有它，子会话的读数会被主会话已经抬高的**整行**水位当场丢掉（子会话的累计从 0 涨到几万，而整行水位已到几十万）——即「子会话节点一条用量行都没有」。
- **老日志不受影响**：历史 `usage` 行没有 `turn` ⇒ 全落 `main` 桶 ⇒ 与今天逐字相同（这一条要有用例钉住）。
- 其余规则不动：孤儿回落、文案用归属号、`homes` 只收可达节点。

**两个尺度不要混**（规范 §2.5 的口径）：`facts.turns.current` 是**当前节点的轮次数**（由时间轴派生），行卡片那一个 `轮次` 是**整行**（主 + 全部子智能体）——两者都是既有定义、都不改；本节的改动**只让归属不再依赖时刻**（时间轴的时刻仍是派生的假时刻，见 §4.1 的落点说明）。

**已知残留**：子线程轮次是「第三把尺子」——行合计的子分量 `subagentTurns` 按会话文件的 `turn_id` 数，而子节点时间轴的轮次按模型答复条目数 ⇒ 行卡片的「轮次 = 主 + 子」与两个节点各自显示的轮次**互不自洽**。本次**不改计算**；真修要动 `EvalRow.turns` 的口径（另一次变更）。

## 7. 性能

### 7.1 更新频率：UI 侧的两条义务 + 对数据层的一条要求

本设计把「重建模型 + 过滤 + 虚拟列表」串成了一条链，**每次上游提交都会走完整条**。
故先说清更新频率的边界——分开写，因为三条的**责任方不同**：

**(a) UI 的义务 1：一次提交只算一次。**
`turns` 只在模型的 `nodes` / `activeNodeId` 真的变化时才重建（`useMemo` 挂在这些输入上），
虚拟列表的 `data` 引用因此稳定；否则父组件每渲染一次，列表就重测一遍全部项。

**(b) UI 的义务 2：重建走非紧急更新。**
用 `useDeferredValue` / `startTransition` 把「重建渲染块 + 过滤」标成可让路的更新，
使键入过滤条件与滚动**不被流式追加卡住**。这两条都在 UI 侧，属于本设计必须做到的。

**(c) 对数据层的要求：提交频率必须有上界。**
数据层不得「一帧一次提交」——UI 再优化也扛不住一个 token 一次全量重建。
**要求（不指定实现）**：数据层对外的更新合并到**至多一帧一次**（约 16ms），
并在页面不可见时用定时器兜底（后台标签页里 `requestAnimationFrame` 会暂停，
而**流不会停**，不兜底就是后台攒一大坨、切回来卡一下）。
去重 / 升序 / 「回到起点 = 新一代」等语义由数据层维护，**UI 不感知**（＝「**UI 永远看不到传输层**」）。

> **数据层现状（下限，不是设计依据）**：`packages/client/client/src/row-stream.ts` 当前对每一帧
> 调一次 `merge([parsed])` 并 `setEvents`，即每帧一次 React 渲染。故本条要求**以「上界」的形式提出**，
> 不写「改哪个函数」——那会在数据层重构后立刻过期。

**(d) 吸底由我们自己控，不用列表内部的自动定位。**
跟随时在一次提交**之后**调 `listRef.current.scrollToBottom()`
（**每次都算，不缓存 index**——随着新轮次出现，最后一项的 index 会变）。
它自带节流，且用户的 `onScroll` 一到立刻把跟随标记置 false（§6.4）。

**如实登记的副作用**：更新上界约 60Hz（人眼之外）。**不影响正确性**——
差别只是「同一毫秒内到达的若干更新会一起出现」。

### 7.2 虚拟滚动（D9）

**用 antd 自己的虚拟列表 `Listy`（`antd/listy`），不自己写窗口化。** 依据：

1. **它逐项测量动态高度**（而**不必**由调用方做任何事——见下方 ⚠️）。本设计里每个轮次的高度
   随「嵌套折叠面板开合」变化——自建方案在这一处的失败模式是
   「展开一条面板后，下面所有轮的滚动位置整体跳掉」，而**jsdom 里完全验不出来**
   （本仓已有这条纪律：脱层几何只能靠真实浏览器冒烟）。
2. **跳轮器 / 「回到最新」都是它现成的能力**：`VirtualListHandle.scrollToKey(key, align?)`
   （**按 `rowKey` 寻址**，比按 index 更稳——轮次会随流式追加而增删）、`onScroll`。
3. **它不新增任何直接依赖**：`Listy` 是 antd 6 的组件；它内部依赖
   `@rc-component/virtual-list`（实测），即**把本设计原本要的那一层封在里面**。
   本仓已依赖 antd ⇒ **`ui` 包的 `dependencies` 不用动，也不用改 `AGENTS.md` 的依赖方向表**。
4. **它额外给了本设计要用的两件**：`sticky`（分组吸顶，将来做「按子任务分组」时现成）
   与 `group`（分组段）。

> **⚠️ antd 6.6.5 的实际行为（按源码与真机核对）**
>
> | 常见写法 | 实际 | 本设计据此的口径 |
> |---|---|---|
> | 「不传 `itemHeight` ⇒ 走逐项测量」 | antd 的 `Listy` **总是**把 token 派生的 `itemHeight`（`fontHeight + paddingSM × 2`）传给底层 `@rc-component/listy`，`ListyProps` 的 `itemHeight` 还被显式 `Omit` 掉 ⇒ **调用方传不传都改变不了这件事** | 仍然**不传**（口径不变、也传不进去）；但**不要**把「动态高度补偿」写成「因为我们没传 `itemHeight`」——它来自底层 `@rc-component/virtual-list` 的逐项测量（先按 `itemHeight` 估位、渲染后按 `ResizeObserver` 实测并回填） |
> | 「`virtual` 开启虚拟化」 | antd 的 `Listy` 里 `virtual ?? contextVirtual ?? false` ⇒ **默认是 `false`**，不传 `virtual` 就没有虚拟化 | 必须显式给 `virtual` |
> | 通篇未提 `height` | 底层 `useVirtual = !!(virtual !== false && height && itemHeight)`：**`height` 缺省时虚拟化整条链都不成立**（`virtual-turn-list` 之外还影响「渲染多少项」） | `packages/client/ui/src/base/virtual-list.tsx` 用外层容器 + `ResizeObserver` 量出可用高度再传 `height`；量不到时不虚拟化（全量渲染），**不抛**——这正好让 jsdom 里的单测能数到全部轮次 |
> | 「§6.5 的『已渲染 N / 共 M 轮』由 `onScroll` + 数据长度推」、§10 的 `virtual-turn-list.test.tsx` 写「用 `onVisibleChange` 的 N 渲染」 | `Listy` 的 `VirtualList` **只透传 `onScroll`**，`onVisibleChange` 被吞掉（它连 `...restProps` 都没接） | N 由 `base/virtual-list.tsx` 的 `onMeasured` 回调数**自己标的**行节点（`data-turn-row`——数 antd 内部类名会把嵌套 `Listy` 的项一起算进来）；量不到高度就不虚拟化、如实退回 `turns.length` 并标为退化。**不许**为了拿 N 而退回直接依赖 `@rc-component/virtual-list`（那正是 §7.2 依据 3 要避免的） |

**必须传的**：`virtual`、`height`、`rowKey`（用轮次的稳定键，**不用数组下标**）；
**不要传 `itemHeight`**（本仓口径，且事实上传不进去）。

**虚拟化是 L2 的预设，不是 L1 的默认行为**：

| 层 | 谁负责虚拟化 | 理由 |
|---|---|---|
| `MessageTimeline`（L1） | **完全不负责**：逐轮 `map` 渲染，`turns` 多大就渲染多少 | §2.1 S3：内嵌只读视图的轮次数常常只有几轮，为它引虚拟列表是净亏；而 S5（监控台）要的可能是别的几何 |
| `VirtualTurnList`（L2） | **它负责**：用 `packages/client/ui/src/base/virtual-list.tsx` 的 `VirtualList`（**全仓唯一的 `<Listy>`**）把「按项渲染」回调接到 `MessageTimeline` 的单轮渲染上 | 抽屉里有两处内容都会长到上千行（轮次时间轴、原文行的逐行台账）——原语只留一处，避免两份高度测量与两份「量不到就不虚拟化」的退化兜底 |

**收拢后仍必须守的一条**（原样保留）：`buildRenderBlocks` 必须在**按项渲染回调**里被调用
——现在这个回调归 `VirtualTurnList` 持有，它调的是 `MessageTimeline` 的单轮渲染入口：

```
✗ 错：buildAgentLogModel() → turns[].blocks = buildRenderBlocks(...)   // 几百轮全建
✓ 对：buildAgentLogModel() → turns[]（仅分组） → 列表每渲染一项才 buildRenderBlocks(该项)
```

否则纯 JS 那一段仍要跑几百轮，虚拟滚动只省了 DOM、没省计算。
**L1 的 `MessageTimeline` 不接受「已建好的 `RenderBlock[]`」作为输入**——那会诱导调用方
在外面先全建一遍。它吃的是 `turns` + `renderBlock` 分派函数（§9.2）。

**「已渲染 N / 共 M 轮」这个护栏随虚拟化一起归 L2**：不虚拟化时 N === M、
这一行没有信息量，故 `MessageTimeline` 不渲染它，只有 `VirtualTurnList` 在列表尾部给，
N 取自 `VirtualList` 的 `onMeasured`（数 `data-turn-row` 行节点，量不到就退回 `turns.length`）。
它既是调试指标也是性能护栏（N 失控增长时立刻看得见）。

### 7.3 为什么不自己写窗口化

自建窗口化（例如「只留最近 50 轮 + 滚到顶加载更早」）零新依赖，但三处都做不对：
(a) 展开嵌套面板后窗口里仍是 50 轮全挂载；(b) 在顶部插入更早轮次会把视口位置抽掉，
得自己做滚动锚定补偿；(c) 跳轮器要自己算 offset。
三项都是「做错了 jsdom 不报错」的那类 ⇒ **不自己写窗口化**，用 `VirtualList`（§7.2）。

### 7.4 内存

子任务内容由数据层按需给（只有进过的节点才组装），但**已访问过的节点内容会留在数据层的缓存里**。
本设计**不做淘汰**——评测的典型规模是几十个节点，为它引入淘汰策略属于提前优化。
**处置门槛写在这里，而不是留一句「将来再说」**：若真实冒烟中出现「打开抽屉后内存持续增长」，
先量再改（浏览器 Performance 面板的 JS heap 曲线），落点是**数据层的按节点保留上限**
（`LogNode.contentTruncatedReason` 这个字段就是为「内容被上限截断」预留的出口，
届时 UI 只需如实显示那句话）。
**不是**在 `ui` 包里加缓存或淘汰（那会让纯展示件持有数据，破坏「**UI 不做取数**」）。

## 8. 对外文档口径与规范引用对照

本节两件事：

- **§8.1 对外文档的口径** —— 逐条给「改哪个文件、改成什么」；
- **§8.2 与规范小节号的对照** —— **查表**：本文引用 v2 / v3 时用得到。

### 8.1 对外文档的口径（逐文件）

| 文件 | 改成 |
|---|---|
| `README.md` 的抽屉表 | 按钮名「执行日志」；下载说明改为「下载原始事件台账（与抽屉视图不同：台账是逐条事件原文，抽屉是按轮次组织的视图）」 |
| `README.md` 的按钮顺序口径 | 逐字改「执行日志」（顺序不变） |
| `README.md` 排障表：`[codex]` 那几行 | 「对照『执行日志』抽屉的『原始输出』里的 `[codex]` 那几行」 |
| `README.md` 排障表：补一行 | 「打开『执行日志』看到『还没有日志』而这一行明明跑过」→ 时间轴吃的是 `messages.jsonl`，而**厂商事件的投影只覆盖了一部分**；夹具画得出来的形态（清单 / 问答 / 子任务轨迹）要等适配器写进那条记录流才看得见。**此时原始事件仍在**（固定区的「原始输出」逐字可查） |
| `eval-row-card.tsx` 的按钮 | 「执行日志」 |
| `eval-row-card.test.tsx` 的可访问名与顺序断言 | 逐字改（**顺序断言的口径不变**） |
| `agent-activity-line.tsx:18` 注释 | 改「执行日志」，并补「子任务内容在面包屑里」 |
| `packages/server/agents/src/turn.ts` 的 stderr 注释 | 改「执行日志」，并点明 `[codex]` 那几行在它的「原始输出」里（**只改注释，不动落盘逻辑**） |
| `docs/superpowers/specs/2026-09-22-features-design.md:168` 的版式图 | 「执行日志」（历史 spec 的版式图，改文案不改结构） |
| `2026-09-22-scaffold-design.md` §13.8 的抽屉几何 | 补一条：**执行日志抽屉**改用虚拟列表自持滚动容器；变更详情 / 评分详情两抽屉口径不变，`body` 仍 `padding: 0` |
| `2026-09-30-agent-message-spec-design.md` §7.6.2 ⑨ / §7.6.4 | 补三条落地说明：① 族结构落到**块**上时**只挂 `tool-call` 块**、由数据层回填，且给 UI 的是「本次调用后的归一结果」（清单在 dsh 的 `arguments` 里、在 claude 的结果累积里，由适配器读）；② `commitModel` 与 `TaskListArgs` 空壳**不进 UI 契约**；③ 两族在**轮次时间轴**里的位置、折叠默认态、同轮多次调用的画法，以本文 §5.4 / §5.5 为准 |
| `2026-09-30-agent-message-spec-design.md` §11.1 第 27 项 | 本文按「**不编 id**」处置（§5.4）：`id === null` 时不画 id 与依赖，`owner` / `blockedBy` 两格如实少画。该缺口闭合后 UI 无需改动（它吃的是整表结构） |
| `2026-09-30-agent-message-spec-design.md` §7.0.5 / §7.6.4 / §11.1 第 22 项 | 本文的 UI 契约**不出现 `message.turn`**：分组用数据层给的**统一轮次号** `LogTurn.round`（= `usage.turns` 口径，§4.1）。换算落在数据层（`turn` 正名为模型往返序号、厂商轮号另存 `vendorTurn`） |
| `2026-09-30-agent-message-spec-design.md` §7.7（`UsageEvent.thinkingTokens` / `usageCapability.thinkingTokensBasis`） | 思考 token 与 `tokens` **并列**（`thinking: { tokens; basis } \| null`，§4.1），可加性由 `basis` 决定 |

> 注：上表四条引用的 `2026-09-30-agent-message-spec-design.md` **已并入 v3 并从库中删除**——那些小节号是当时那份稿子的锚点，内容现全部落在 [`2026-10-01-agent-message-spec-design-v3.md`](./2026-10-01-agent-message-spec-design-v3.md)。

### 8.2 与规范小节号的对照（**查表用**）

**引用纪律**（读本文所有对规范的引用时都适用）：

- **一律按小节（`§`）引用，不引用行号** —— 两份规范都在被并行修订，行号随时漂移；
  行号只允许出现在 **§8.1 的对外口径表**里（那里必须精确到行，因为要指导别人改文件）。
- **外部节号必须带来源前缀**：`v2 spec §x` / `v3 §x` / 完整文件名。
  裸写 `§x` 一律指**本文自己的**小节 —— 否则会出现「看起来有效、实际指错」的假内部引用。
- **两版的节号不能互译**，其中一部分是「同号不同义」，比「不存在」更危险。本节给出权威对照。
- **v3 没收录的概念由本文自行定义**，就地写明，不指向 v2 的节号
  （清单见卷首的 ⚠️ 段：`ask-user` 答案回填与七态、`TaskStep`、`commitModel` / `TaskListArgs`）。

**对照表**（本文引用规范时用到的全部目标）：

| 引用（v2 体系） | v3 的实际位置 | 备注 |
|---|---|---|
| `v2 spec §7.6.0`「规范化是可选增收 / 降级不算失败」 | **v3 §5.1**（`family` 记 `null` 走通用渲染）+ **§7.2** | v3 用「通用渲染」而非「通用回退」 |
| `v2 spec §7.6.4`「只按 `family` 分支」 | **v3 §5.1**（族由工具名决定） | —— |
| `v2 spec §7.6.4`「只画最后一条结果，历史折叠」 | **v3 无对应句** | 本设计**自行定义**（§5.4 规则 3），理由就地写在 §5.4 |
| `v2 spec §7.6.2 ⑨`「整表语义 / 计数是派生值」 | **v3 §5.3**（`task` 族的合并语义）+ **§5.4** | —— |
| `v2 spec §7.6.2 ⑩`「七态 / 答案回填 / 选项语义」 | **v3 无对应物**（见下「v2 独有概念」） | 本设计自行定义于 §4.1 + §5.5 |
| `v2 spec §7.6.2.2`「两张面板」 | **v3 §5.4 / §5.5** | —— |
| `v2 spec §7.7` / `§7.7.0`「思考 token 与 `tokens` 并列」 | **v3 §2.4**（`reasoningOutput` 是 `output` 的子集） | ⚠️ **v3 没有 `basis` 概念**；本设计的 `basis` 是**自行收窄**（§4.1 已注明） |
| `v2 spec §7.0.5`「`message.turn` 三家语义不同」 | **v3 §1.2**（四个易混量）+ **§3.1**（`roundTrip` / `vendorTurn` / `step` 逐家路径） | —— |
| `v2 spec §11.1` 第 27 项「`TaskCreate.taskId` 来源未定」 | **v3 §5.3**（codex 的 `steps[].id` 是按序号生成、**不得当稳定键**） | 两版说的是同一类问题 |
| `v2 spec §12`「不读厂商会话文件作为消息来源」 | **v3 无 §12** | 该口径已由 v3 §4.2/§4.3 的实施路径取代（会话文件**是**思考正文与子任务轨迹的来源）⇒ **本设计 §12 的这句已失效，需按 v3 改写** |
| `v2 spec §5.2`（内容块） | ⚠️ v3 **§5.2 = 三家工具名 → 族** | 同号不同义。内容块在 v3 **§2.2** |
| `v2 spec §6.2`（`subagentId ↔ callId`） | ⚠️ v3 **§6.2 = 覆盖合并算法** | 同号不同义。子任务行在 v3 **§2.8** |
| `v2 spec §3`（四态能力声明） | v3 **§2.7**（**五态**） | 同号不同义。v3 的能力声明形状见 §2.7 |
| `v2 spec §4`（`not-observed` 与 `not-supported` 之分） | v3 **§2.7** + **§7** 前言 | —— |
| `v2 spec §5`（覆盖语义） | v3 **§6.1 / §6.2** | —— |

**v2 独有概念（v3 未收编，必须由本文就地定义）**——实测 v3 全文**零命中**：

| 概念 | v3 命中 | 本设计的处置 |
|---|---|---|
| `AskUserAnswer`（答案回填） | 0 | **本文定义**于 §4.1；三条回填口径就地写在 §5.5 |
| `recommended` / `allowOther` / `multiSelect` / `secret` | 0 | 同上（§4.1 的 `AskUserQuestion`） |
| `AskUserOutcome` 七态（含 `auto-resolved`） | 0（v3 只提 `outcome: 'unavailable'`） | **本文定义**于 §4.1，逐态文案在 §5.5 |
| `TaskStep` | 0（v3 只在 §5.1 内联写 `{id, subject, status, owner?, blockedBy?}`） | **本文按 v3 §5.1 的内联形状定义**于 §4.1 |
| `commitModel` / `TaskListArgs` | 0 | 本设计的「**不进 UI 契约**」处置**仍然成立**；理由是「UI 只吃归一后的整表」（§4.1） |

> **纪律**：上表这些概念**不得**改成「见 v3 §x」——那会指向不存在的东西。
> 它们的定义只能就地给出，并注明「来源为 v2 系设计稿；v3 未收编，本设计自行定义」。

**v3 自身的一处不一致（本设计的取舍已按它对齐）**：

| v3 位置 | 内容 |
|---|---|
| **§2.8** 的 `SubagentRecord` 类型 | `status: 'running' \| 'completed' \| 'failed' \| 'stopped' \| 'unknown'`（**5 值**） |
| **§5.5** 的渲染要求（逐字） | 「状态取值固定为**六种**：`running` / `completed` / `failed` / `stopped` / `unknown` / **`未收场`**」 |

⇒ v3 的**类型与自己的渲染要求对不上**（类型 5 值、要求 6 值）。
本设计的 `LogNodeStatus`（§4.1）**取六值语义、加 `unsettled`**，即按 **v3 §5.5 的要求**走；
它**超出了 v3 §2.8 的类型定义**，这是有意的——否则「被强杀的子任务」只能显示成 `running`
（读者会一直等一个不会来的收场）。**待 v3 补齐该格后，本设计无需改动。**

## 9. 组件与文件

新增目录 `packages/client/ui/src/composite/agent-log/`——
**这个目录整体就是那个通用组件**：吃「一个智能体运行的过程 + 它跑在什么环境里」，
不认「评测行」这个业务概念。换一个消费场景（例如某个智能体自己的运行记录）时，
换掉喂进来的 `AgentLogModel` 即可，目录里的东西一行都不用改。

> 本节按 **§2.1 的五个重组场景**分层：**三层 + 一个注册表 + 一套工具条预设**。
> **四个界面（§5 / §6）与契约（§4.1）都不变**，这里定的是「怎么分层、谁持有 state、加东西时改哪个文件」。

### 9.0 三层：判据是「依赖方向」，不是文件数

```text
L2 场景预设   agent-log-drawer · agent-log-layout · virtual-turn-list
                · agent-log-toolbar-preset · use-agent-log-view
                    ↓ 只能向下依赖
L1 受控组合件 agent-message-timeline · log-node-breadcrumb · agent-log-facts-bar
                    ↓ 只能向下依赖
L0 纯渲染件   text-block-view · thinking-block-view · tool-group-panel ·
                tool-item-detail · subagent-bar · task-panel-card · ask-user-card ·
                agent-run-state-tag · raw-output-panel · agent-environment-drawer ·
                block-renderer-registry · render-blocks(纯函数)
```

**三条硬纪律**（它们就是「高内聚低耦合」在本仓的可判定形式）：

| # | 纪律 | 违例长什么样 |
|---|---|---|
| 1 | **依赖只准向下**：L0 不 import L1/L2；L1 不 import L2 | L0 里的 `task-panel-card` import 了 `useAgentLogView` 去读折叠态 |
| 2 | **L0 不 useState**：所有开合/选中一律受控（`open` + `onOpenChange`） | 一个自己持开合态的折叠件**不能被独立挂载**（§2.1 S3 直接失败） |
| 3 | **L0 不认业务概念**：不 import 任何 `EvalRow*` / 厂商名 / `agentKind` | 卡片按 `agentKind === 'dsh'` 分支（＝「**UI 不判厂商**」，这里再钉一次到目录级） |

**L0 与 L1 的分界不是「有没有 props」，而是「认不认 `LogTurn`」**：
L0 吃的是**单个块**（`TextBlock` / `ToolItem` / `TaskPanel` / …），
L1 吃的是**一轮**（`LogTurn` + 分派函数）。故 `MessageTimeline` 是 L1 而不是 L0——
它知道「一轮里有多个块、要按顺序摆」，但**不知道虚拟化、不知道轮次跳转、不知道过滤**。

### 9.1 L0 / L1 的 props 契约（重组场景真正吃的就是这些）

```ts
/** L1：一轮消息的渲染。**没有虚拟化、没有 subagent 字段、没有轮次跳转** */
export interface MessageTimelineProps {
  /** 轮次（**已分组、未建渲染块**——§7.2） */
  turns: readonly LogTurn[];
  /** 会话树索引：`buildRenderBlocks` 的规则 3（派发点）要用 */
  nodes: LogNodeIndex;
  /**
   * 块分派。**默认实现 = 注册表（§9.3）**，故绝大多数调用方不必传。
   * 传它是为了 S5：换一条完全不同的分派策略（例如「全部展开、不做折叠」）而不碰任何渲染件。
   */
  renderBlock?: BlockRenderer;
  /** 折叠态：`activeKey` 由 L2 给（§6.1）。不传 = 全部用默认态、不可交互 */
  openKeys?: ReadonlySet<string>;
  onOpenChange?: (key: string, open: boolean) => void;
  /** 行级事件（§5.2）：按 `at` 落在轮次之间 */
  rowEvents?: readonly RowEvent[];
  /** 用户提示词（§6.3 首条消息）。**L1 不知道它从哪来**，只负责摆在最前 */
  userPrompt?: LogNode['userPrompt'];
  /** 当前节点 id：折叠默认态与「这一类内容没被转发」的判定按节点分（同一行不同子任务的采数通道可以不同） */
  activeNodeId?: string;
  /** 贴在时间轴顶部的如实提示（如「该子任务的对话未转发」）；空数组 = 一条都不渲染 */
  notices?: readonly string[];
  /** 子任务占位条的「进入 ▸」；不给则该动作不渲染 */
  onEnterNode?(nodeId: string): void;
  /** 节点内容读取失败时的重试（§4.4 的 `AgentLogSource.retryNode` 落点） */
  onRetryNode?(nodeId: string): void;
  /** 展开「原始输出」时向数据层上报（§4.4 的 `requestDiagnostics` 落点） */
  onRequestDiagnostics?(): void;
  /** 能力声明：结果未采集时写出「为什么」的那份（§9.7 的 `missingReason`） */
  capability?: MessageCapabilityMap;
}

/** 单轮渲染入口：**虚拟列表按项渲染时调的就是它**（§7.2 的护栏挂在它上面） */
export type RenderTurn = (turn: LogTurn, index: number) => ReactNode;

/** 块分派：注册表与自定义策略的公共形状（§9.3） */
export type BlockRenderer = (block: RenderBlock, ctx: BlockRenderContext) => ReactNode;

export interface BlockRenderContext {
  /** 折叠态是否打开（受控，§6.1） */
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 「原始结果 ▾」那份二级开合态（与主折叠态同一个受控来源，不另立 state） */
  rawOpen: boolean;
  onRawOpenChange(next: boolean): void;
  /** 折叠键全集：卡片要判断「同一轮里别的块」时读它，不自己拼键 */
  openKeys?: ReadonlySet<string>;
  /** 组内某一行的开合（工具组专用；键由 `toolEntryKey` 给） */
  onEntryOpenChange?(key: string, open: boolean): void;
  /** 子任务占位条的「进入 ▸」 */
  onEnterNode?(nodeId: string): void;
  /** 节点内容读取失败时的重试 */
  onRetryNode?(nodeId: string): void;
  /** 展开「原始输出」时向数据层上报 */
  onRequestDiagnostics?(): void;
  /** 当前节点的能力声明（`toolResult` 那一维决定「结果未采集」的原因怎么写） */
  capability?: MessageCapabilityMap;
  /**
   * **本上下文刻意不提供「流式中」这个布尔。**
   *
   * 再放一个 `streaming: boolean` 与 `assembly` 并存
   * ⇒ 组件层出现**第二个真值**，而 `assembly` 由数据层给、`streaming` 无人给，两者必然漂移
   * （表现是「块结束了动效还在转」）。
   * §6.9 已定「`assembly === 'open'` 是动效的**唯一判据**」⇒ 需要动效的渲染件
   * **自己读 `block.assembly`**，本上下文不再转手一份。
   * 变异体 (y) 钉这一点：把 `streaming` 加回来必须让守卫变红。
   */
}
```

**`MessageTimeline` 的 props（L1，§9.1 已给）与两个具名类型**：

```ts
/**
 * `AgentLogLayout.timeline` 槽位收到的 props。
 *
 * 它存在的意义是 **S1 / S5 两个接缝**：调用方要用别的时间轴实现
 * （内嵌只读视图不虚拟化、监控台换一种滚动几何）时，靠这个函数拿到
 * 「已经定好的分派函数 + 折叠态 + 轮次」，而不必自己重新拼一遍。
 */
export interface TimelineSlotProps {
  /** 当前节点的轮次（已分组、未建渲染块 —— §7.2 的护栏） */
  turns: readonly LogTurn[];
  /** 会话树索引（`buildRenderBlocks` 规则 3 定位派发点要用） */
  nodes: LogNodeIndex;
  /** 块分派（默认实现 = 注册表，§9.3） */
  renderBlock: BlockRenderer;
  /** 折叠态（受控，§6.1） */
  openKeys: ReadonlySet<string>;
  onOpenChange(key: string, open: boolean): void;
  /** 行级事件（§5.2） */
  rowEvents: readonly RowEvent[];
  /** 当前节点的用户提示词（§6.3 首条消息） */
  userPrompt: LogNode['userPrompt'];
  /** 贴在时间轴顶部的如实提示（「这一类内容没被转发」等） */
  notices?: readonly string[];
  onEnterNode?(nodeId: string): void;
  onRetryNode?(nodeId: string): void;
  onRequestDiagnostics?(): void;
  /** 当前节点的能力声明（结果未采集时的原因从它取） */
  capability?: MessageCapabilityMap;
}

/**
 * `useAgentLogView()` 的返回值，也是 `AgentLogLayout.viewState` 的形状。
 *
 * **它只装「视图态」，不装 data**（＝「**UI 不做取数**」）：节点内容、环境、原始输出
 * 一律走 props 注入，本对象里没有它们。
 * 外置它是为了 S5：换一种交互形态时，那份形态自己持有这四份 state 即可，
 * 不必继承本组件的内部实现。
 */
export interface AgentLogViewState {
  /** 当前视图选中的节点 id（面包屑作用域，D4） */
  activeNodeId: string;
  setActiveNodeId(id: string): void;
  /** 跟随最新（D13）；`false` 由用户上翻触发，浮出按钮与工具条开关**共用这一份** */
  follow: boolean;
  setFollow(next: boolean): void;
  /** 过滤（§6.5）；两个过滤可叠加（AND），在**轮次级**生效 */
  filters: { onlyTools: boolean; onlyErrors: boolean };
  setFilters(next: { onlyTools: boolean; onlyErrors: boolean }): void;
  /** 环境抽屉开合（§6.8；受控，抽屉本体自己不持态） */
  environmentOpen: boolean;
  setEnvironmentOpen(open: boolean): void;
  /** 折叠态键集合（§6.1 的 `activeKey`：内置默认态 ∪ 用户手动开过的） */
  openKeys: ReadonlySet<string>;
  onOpenChange(key: string, open: boolean): void;
}
```

### 9.2 L2 的 props 契约：布局与抽屉

```ts
/** L2：抽屉正文的一体化布局。**不套 `Drawer`**（S1 的内嵌视图直接用这个） */
export interface AgentLogLayoutProps {
  model: AgentLogModel;
  environment?: Loadable<AgentEnvironment>;
  diagnostics?: Loadable<AgentLogDiagnostics>;
  /** 数据来源（§4.4）：三个方法全可选，一个不给也照常工作 */
  source?: AgentLogSource;
  onDownload?(): void;
  /** 页面级的补充提示（如「日志可能不完整：…」）：固定区一个 Alert；不传就一个空位都不留 */
  notice?: string;
  /** 流式连接断开时的一句话（§7.1）：与 `notice` 各占一个 Alert，互不顶替 */
  liveError?: string;
  /** 流式连接状态：**只在传了时**渲染那一格；断线那一档不能用 processing 的动效 */
  connected?: boolean;
  /** 工具条动作（§9.4）。不传 = 用 `AgentLogToolbarPreset` */
  actions?: readonly ToolbarAction[];
  /**
   * 时间轴槽位。不传 = `VirtualTurnList`（虚拟滚动）。
   * 传它是为了 S1 / S5：内嵌只读视图可以直接给 `MessageTimeline`（不虚拟化）。
   */
  timeline?: ReactNode | ((props: TimelineSlotProps) => ReactNode);
  /** 视图态外置（S5）：不传则由 `AgentLogLayout` 内部用 `useAgentLogView` */
  viewState?: AgentLogViewState;
}

/** L2：预置的抽屉。**唯一一处 `<Drawer>`**，评测页直接用它 */
export interface AgentLogDrawerProps extends AgentLogLayoutProps {
  open: boolean;
  onClose(): void;
  /** 抽屉标题。默认「执行日志」（§8.2 的改名口径落在这里） */
  title?: ReactNode;
}
```

**「不传就照常工作」是有意的**：上表每一项都有默认值，故最省事的用法是一行
`<AgentLogDrawer open={…} onClose={…} model={model} />`——**重组能力不要求调用方付税**。

### 9.3 L0：块渲染注册表（D25）

```ts
/**
 * 渲染器注册表。**判别联合管类型，注册表管分派**——两者不互斥：
 *   · `RenderBlock` 的判别联合（§4.2）保证「每类块只有在自己那一支里字段可读」；
 *   · 注册表保证「新增一类块**不必改 timeline**」。
 * 只有前者时 `assertNever` 得写在 `agent-message-timeline` 里 ⇒ 加一个 arm 就要改它（§2.1 S4 失败）。
 */
export type BlockRendererRegistry = {
  readonly [K in RenderBlock['kind']]: (
    block: Extract<RenderBlock, { kind: K }>,
    ctx: BlockRenderContext,
  ) => ReactNode;
};

/** 默认注册表：**九臂**齐全（`RenderBlock` 的九个 `kind` 各一；
    类型层强制——用映射类型写，漏一臂编译不过） */
export const DEFAULT_BLOCK_RENDERERS: BlockRendererRegistry;

/**
 * 调用方扩展：**在默认表之上叠加**，只需给新增/覆盖的那几项。
 * 不提供「部分覆盖某一臂的内部」——注册表以 `kind` 为粒度，半个渲染器是自相矛盾的。
 */
export interface BlockRendererProviderProps {
  renderers: Partial<BlockRendererRegistry>;
  children: ReactNode;
}
export function BlockRendererProvider(props: BlockRendererProviderProps): ReactNode;

/** 取合并后的表（默认表 ⊕ 最近的 Provider） */
export function useBlockRenderers(): BlockRendererRegistry;
```

**「零改动」的确切含义（免得读成夸张）**：新增一类块要动的是**契约**（`ContentBlock` / `RenderBlock`
各加一个 arm —— 这是 §4.2 扩展性第 1 / 5 条已经定好的）与**新渲染件本身**，
以及**在 `DEFAULT_BLOCK_RENDERERS` 里加一项**。**不改的是** `agent-message-timeline`、
`agent-log-layout`、`agent-log-drawer` 与其余所有渲染件。
`DEFAULT_BLOCK_RENDERERS` 是**一张平表**，加一项不触碰别人的那一行——这是与「switch + assertNever」
的实质差别（后者每加一臂都要改同一个函数体）。**外部消费方更是连默认表都不用改**：
`BlockRendererProvider` 直接叠。

`assertNever` 仍然保留在**默认注册表的穷尽性检查**上：当契约加了 arm 而默认表漏了时，
`BlockRendererRegistry` 的映射类型**编译期就报错**（比运行时的 `assertNever` 更早，
且这正是本仓「守卫必须能红」的口径）。

### 9.4 L2：工具条动作（D26）

```ts
/**
 * 一个工具条动作。**默认那七个是「一套预设」，不是「工具条只会这七个」。**
 */
export interface ToolbarAction {
  /** 稳定键：React key 与测试定位都用它，**不用数组下标** */
  key: string;
  /** 可访问名（按钮文案） */
  label: string;
  icon?: ReactNode;
  onSelect?(): void;
  /**
   * 渲不渲染。**「原始输出」与「环境信息」的显隐判据挂在这里**
   * （§5.3：`lines` 为空时不渲染入口），不写死在工具条组件里。
   */
  visible?: boolean;
  /** 受控开关类动作（跟随最新 / 只看工具调用 / 只看错误）：给了就渲染成开关 */
  toggle?: { checked: boolean; onChange(next: boolean): void };
  /** 数值输入类动作（跳到轮次）：给了就越界 clamp 并如实回显（§6.5） */
  number?: { value: number; min: number; max: number; onSubmit(next: number): void };
  disabled?: boolean;
  /** 落在哪一排：不给 = 工具条那一行；`'raw'` = 与固定区的「原始输出 N 条」同排（§6.6） */
  placement?: 'raw';
}

/**
 * 预设的输入。**这正是不许硬编码的理由**：它要拿到「当前数据长什么样」与「当前视图态」，
 * 才能算出每个动作的 `visible` / `checked` / `disabled`。
 */
export interface AgentLogToolbarPresetInput {
  /** 原始输出（决定「原始输出 N 条」这个动作渲不渲染，§5.3） */
  diagnostics?: Loadable<AgentLogDiagnostics>;
  /** 环境信息（决定「？环境信息」按钮的 `visible`；`undefined` 时**照常渲染**但抽屉里显示「未提供」，§6.8） */
  environment?: Loadable<AgentEnvironment>;
  /** 轮次总数（「跳到轮次」的 `min` / `max`，§6.5） */
  turnCount: number;
  /** 当前轮次（「跳到轮次」的初始值） */
  currentTurn: number;
  /** 视图态（跟随最新 / 过滤两个开关的受控值，§9.2 的 `AgentLogViewState`） */
  viewState: AgentLogViewState;
  /** 下载台账（`onDownload`，§6.6） */
  onDownload?(): void;
  /** 「跳到轮次」提交：越界已在预设里 clamp，交回来的就是最终值（§6.5） */
  onJumpToTurn(next: number): void;
  /** 「？环境信息」被点：打开环境抽屉 + 向数据层上报（§6.8 / §4.4） */
  onOpenEnvironment(): void;
}

/** 默认**七个**动作的内聚处：**本仓的业务口径只住在这个文件里** */
export function useAgentLogToolbarPreset(input: AgentLogToolbarPresetInput): readonly ToolbarAction[];
```

**`ToolbarAction` 是数据不是组件**：这样「换一套动作」是传一个数组，
而「工具条长什么样」（`Flex` + `Button` / `Switch` / `InputNumber` 的摆法）只有一处。
监控台场景可以把同一批动作渲染到侧栏上，而**动作本身的定义不用重写**。

### 9.5 文件清单（按层分组）

**新增目录 `packages/client/ui/src/composite/agent-log/`，下面所有文件都在这个目录里。**

| 层 | 文件 | 职责 |
|---|---|---|
| 类型 | `types.ts` | **界面模型的唯一真源**（`AgentLogModel` / `LogNode` / `LogTurn` / `RenderBlock` 的输入形状 / `AgentEnvironment` / `AgentLogDiagnostics` / `AgentLogSource`）+ **全部中文文案表**（缺失原因四句、能力五态四句、节点状态七档、工具族十族、清单四态、七种收场、截断三态、来源角标）。落点与理由见 §4.1 的「类型落点」 |
| L0 | `render-blocks.ts` | `buildRenderBlocks` 纯函数（§4.2 的四条规整）+ `nodeIndex` / `taskPanelOf` / `hasToolCall`。**不放进 `@aieval/contracts`**：契约包只有 node 环境的测试（无 jsdom），而它的折叠态判据要靠组件测试验 |
| L0 | `build-model.ts` | **契约形状 → 界面模型**：按 `mergeKey` 覆盖累积、按 `subagentId` 分会话节点、按 `roundTrip` 分轮、能力声明摊成三元组字典、行级事件按去向表折成 `facts` / `rowEvents` / `diagnostics`。`buildRowFacts` 的**输入形状**（`AgentLogFactsInput`）也在这里——它把「评测行」挡在界面之外 |
| **接线** | `fixtures.ts` | 三家各一份**真实形状的夹具**（`messages.jsonl` 的记录 + 行级事件 → `buildAgentLogModel`），覆盖九条 arm。夹具预览页用它，单测也用它——「每一类消息都画得出来」这条验收因此可回归 |
| L2 | `use-agent-log-view.ts` | **四份视图态的 headless 持有者**：当前节点 / 跟随最新 / 过滤 / 环境抽屉开合 + `activeKey` 折叠态。**不持有 data**（数据仍由 props 注入）。导出 `AgentLogViewState`（受控值 + setter）供 S5 外置，以及 `defaultOpenKeysOf`（折叠默认态的唯一真源） |
| L2 | `agent-log-drawer.tsx` | **唯一一处主 `<Drawer>`**。title 默认「执行日志」；几何见 §5.1。评测页一行接线 |
| L2 | `agent-log-layout.tsx` | **抽屉正文**（S1 的内嵌视图直接用它）：固定区（事实条 / 面包屑 / 工具条 / 原始输出）+ 时间轴槽 + 浮动件 + 内部环境抽屉。吃 `actions`（§9.4）与 `timeline` 槽；`viewState` 不传时内部用 `useAgentLogView`。三态（空 / 读取中 / 读失败）与**轮次级过滤**也在这里 |
| L2 | `virtual-turn-list.tsx` | **把「按项渲染」接到 `RenderTurn`**（§7.2）：吃 `base/virtual-list.tsx` 的 `VirtualList`，出 `ListController`（跳轮次 / 回到最新）与「已渲染 N 共 M 轮」的 N。**它不直接碰 `Listy`**——虚拟化原语只许出现在 `base/virtual-list.tsx` |
| L2 | `agent-log-toolbar-preset.ts` | 默认**七个**动作（§6.6 的表逐项给行为）：下载台账 / 跟随最新 / 跳到轮次 / 只看工具调用 / 只看错误 / 原始输出 / 环境信息。纯函数 + 薄 hook 两层 |
| L1 | `agent-message-timeline.tsx` | **吃 `turns` + 分派函数，吐轮次列表**。虚拟化、subagent、过滤都不在它这里。键生成函数（`turnKey` / `renderBlockKey`）的**唯一真源**也在这里——L2 与折叠态都从它取 |
| L1 | `log-node-breadcrumb.tsx` | 面包屑 + 每段兄弟菜单。**只吃 `nodes` / `activeNodeId` / `onSelect`**：祖先链由 `parentId` 回溯派生，同层兄弟由 `filter(parentId === 本段)` 现算 |
| L1 | `agent-log-facts-bar.tsx` | 事实进度条（受控、不可折叠）+ 「等待答复」徽标（§5.5）。**只吃 `facts` / 等待判据**；原始输出入口与「？环境信息」按钮**移出**（分别归 `raw-output-panel` 与工具条预设） |
| L0 | `block-renderer-registry.tsx` | 注册表 + `DEFAULT_BLOCK_RENDERERS`（九臂平表）+ `BlockRendererProvider` + `useBlockRenderers` + `blockRendererOf`（§9.3） |
| L0 | `text-block-view.tsx` | `text` 块：`MarkdownText` + 角色/来源标注（§6.9）+ 流式光标容器类（§6.7 第 3 条，导出 `STREAM_CURSOR_CLASS`） |
| L0 | `thinking-block-view.tsx` | `thinking` 块：折叠面板、`text === null` 显示缺失原因而非空面板（§6.1 例外 3）、`summary` 标「摘要」、扫光标题（§6.7 第 1 / 2 条） |
| L0 | `tool-group-panel.tsx` | 工具组折叠面板 + 组内工具行（两级折叠）。组头的 `工具调用 × N` **只数调用**（孤立结果不算） |
| L0 | `tool-item-detail.tsx` | 单条工具行的摘要与展开详情（命令/参数/结果、截断提示）。导出 `toolEntryKey`（行键的唯一真源，组内两处共用） |
| L0 | `subagent-bar.tsx` | 子任务占位条（§6.3）：`Card` + `Tag` + 「进入 ▸」+ 派发方式 / 结果摘要 / 自己的用量。**任务名为 null 时的 id 前缀兜底在这里** |
| L0 | `row-summary-line.tsx` | `kind: 'row'` 节点的说明行（§6.3）：带计数与状态、**不可点**、`counts === null` 时如实说明 |
| L0 | `attachment-block-view.tsx` | 真实附件（图片 / 文件）：类别 + 路径 + MIME；`path === null` 写「内联内容，无路径」。**本期不加载缩略图** |
| L0 | `unrecognized-block-view.tsx` | 不认识的厂商载荷：默认收起的等宽原文 + 厂商类型。**与附件走两条路**（D31） |
| L0 | `agent-run-state-tag.tsx` | **§9.7 的原语**：`running` / 「结果未采集」的唯一分派处，工具行与三张卡片共用 |
| L0 | `raw-output-panel.tsx` | **§9.7 的原语**：逐行原文（`AgentLogDiagnostics`）与单份原文（`ToolCardResult`）两种变体（§5.3） |
| L0 | `capability-notes.tsx` | 能力声明的界面落点（D28）：按数据层给的顺序渲染、维度名不硬编码、四句原因互不相同、`capabilityNotes` 非空时显示前提 |
| L0 | `agent-environment-drawer.tsx` | 环境抽屉本体。**受控**：`open` / `onOpenChange`（§6.8）。摘要 `Descriptions` + 分组 `Collapse` + 逐条 `MonoText` |
| L0 | `task-panel-card.tsx` | `task` 族的状态化清单面板（§5.4）：计数/变化摘要标题 + 清单行 + `本轮另有 N 次更新` + 原始结果。吃 `TaskPanel`，**不认厂商、也不认 `args`/`result`** |
| L0 | `ask-user-card.tsx` | `ask-user` 族的问答卡片（§5.5）：逐问题选项 + 答案回填 + 七态收场 + 等待计时 + 原始结果。吃 `AskUserInteraction`，**不认厂商** |
| 守卫 | `agent-log-layering.test.ts` | 三层边界纪律的**静态扫描**（§9.0 三条 + 虚拟化的三个入口只许在 `base/virtual-list.tsx` + 清单里的文件都在） |

**本目录消费的 `base/` 原语**（不在 `agent-log/` 里，`ui` 包内共用）：

| 文件 | 职责 | 谁在用 |
|---|---|---|
| `base/virtual-list.tsx` | **全仓唯一的 `<Listy>`**（`VirtualList` / `VirtualListHandle`）：`ResizeObserver` 量可用高度、量不到就全量渲染、按 `rowKey` 跳转 | `agent-log/virtual-turn-list.tsx`、`agent-log/raw-output-panel.tsx` |
| `base/nested-drawer.tsx` | 二级抽屉（`NestedDrawer`）：几何取自 `drawer-geometry`，`destroyOnHidden`、`mask.closable`；**不写 `push`**（位移量由主抽屉声明） | `agent-log/agent-environment-drawer.tsx`、`agent-log/raw-output-panel.tsx`、`composite/score-detail-view.tsx` |
| `base/drawer-geometry.ts` | 抽屉几何常量：`WIDE_DRAWER_SIZE` / `NESTED_DRAWER_SIZE` / `MAIN_DRAWER_PUSH` / `DRAWER_SEMANTIC_STYLES` | 主抽屉（`agent-log-drawer.tsx` 与评测页）+ 两个二级抽屉 |
| `base/json-text.tsx` | 等宽 JSON 正文（格式化 + 高亮）；不是 JSON 就逐字给出 | `agent-log/raw-output-panel.tsx`、`tool-item-detail.tsx`、`unrecognized-block-view.tsx`、`composite/score-detail-view.tsx` |

**接线与预览**（`ui` 目录之外）：

| 文件 | 职责 |
|---|---|
| `packages/client/client/src/row-messages.ts` | **内容级记录的数据层**：`useRowMessages`（先 `/messages` 首帧、再 `/messages/stream` SSE）、`foldRowRecords` / `mergeRowRecords`（按 `mergeKey` 覆盖累积的唯一真源）、帧合并提交（至多一帧一次） |
| `packages/client/client/src/row-stream.ts` | **行级事件流**：`useRowStream`（`/stream?afterSeq=` 增量、`seq` 续订、终态关流）——与记录流是两条独立来源 |
| `packages/client/client/src/row-live.ts` | **实时指标**：`useRunLiveMetrics`（每行一条 SSE）+ `stepLiveState` / `activityOf` / `foldLiveMetrics`；行级读数只认主会话那条 `usage` |
| `packages/client/client/src/build-environment.ts` | **环境信息的数据层**：`buildAgentEnvironment` 把 `EvalRow` 快照 + 事件流 + 记录折成四组（`user` / `vendor` / `project` / `observed`）；拿不到的格走 `present: false` + `MissingReason` |
| `apps/web-next/app/runs/page.tsx` | **接线**：两条来源各自订阅；`buildRowFacts` + `buildAgentLogModel` + `buildAgentEnvironment` 现算；故障 / 读取中两支整段替换；下载台账仍走 `formatEventLog` 的全量事件 |
| `apps/web-next/src/log-drawer-state.ts` | 抽屉三态判定（`resolveLogDrawer`，含**两条来源各自的故障提示位**）与行级事实的界面口径（`buildRowFacts`）——页面本身不能写 `.tsx` 测试，故这两件事都抽成纯函数 |
| `apps/web-next/app/dev/agent-log/page.tsx` | **夹具预览页**（`/dev/agent-log`）：三家夹具喂进真实的 `AgentLogDrawer`。不进导航、不读接口 |

`packages/client/ui/src/composite/`：`log-format.ts` 保留（下载台账与「原始输出」的逐行措辞都读它）；
抽屉本身全部住在 `agent-log/`。

**三条组件边界纪律**（理由各在对应小节，此处只列规则本身）：

1. **`AgentMessageTimeline` 的 props 里没有任何 subagent 字段**——「当前在第几级」是
   `AgentLogLayout` 的事。这样「子任务与主会话同形」是**同一个组件、同一份 props 形状**，不可能漂移。
2. **`ui` 包不调接口、也不决定取数时机**：节点内容按值给（＝「**UI 不做取数**」），
   取数时机的上报收进 `source`（§4.4），不散成若干回调。
3. **环境抽屉是内部件，不是并列组件**：它留在 `agent-log/` 里、由 `AgentLogLayout` 内部渲染
   （三条理由见 §6.8）。**「通用」由整个 `agent-log/` 目录承担**，不靠把某一块拆出去实现。

### 9.6 组件选型：优先 antd，其次本仓既有件，最后才是新写的

**这不是风格偏好，是本仓的硬口径**（AGENTS.md：样式一律走 antd 的主题 token / 紧凑密度 /
语义 `styles`；**不手写字号、不手调行内边距、避免裸写 `div`**）。

| 界面元素 | 用什么 | 备注 |
|---|---|---|
| 抽屉 | `Drawer` | 几何见 §5.1。⚠️ **`width` 已废弃**（antd 6 实测）⇒ 用 `size` |
| 事实进度条 | `Flex` + `Badge` + `Tag` + `Typography.Text` | 状态点用 `Badge status="processing"` |
| 面包屑 | `Breadcrumb` 的 **`items`** | `menu` 已废弃（antd 6 实测）⇒ 用 `items[].title` + `items[].menu` 仅在需要下拉时；**不是**裸 `nav` |
| 思考块 | `Collapse` `ghost`（单面板） | 标题 = `items[].label` |
| 工具组 | `Collapse`（最外层，带边框） | 状态汇总放 `items[].extra`（`extra` 本身是**现行** API，废弃的是 `children` 写法） |
| 工具行（组内） | **嵌套 `Collapse`**（内层 `ghost`） | 两级折叠都用 antd，**不写原生 `<details>`** |
| 计划清单面板 | `Collapse`（带边框）+ **`Listy`** + `Tag` | ⚠️ **`List` 已废弃**（antd 6.6+ 实测警告明示改用 `Listy`）。⚠️ **`Listy` 没有 `size` 属性**（`ListyProps` 实测，见下条「size 口径」）——它每一项的高度由 token 派生，写 `size="small"` 只是 TS 报错级的多余属性。组头 = 清单标题 + 计数/变化 Tag（`items[].extra`）；每项一行：状态 Tag + 文本 + `owner`/依赖 Tag。**不用 `Steps`**：它把清单读成线性流程，且表达不了 `unknown` 这一档（硬塞成 `wait` 就是「看起来采到了」） |
| 问答卡片 | `Collapse` + **`Listy`** + `Tag` + `Typography` | 选项走 `Listy`（`label` + `description`，同上：**不给 `size`**）；`recommended` / 多选 / 收场都是 `Tag`；等待计时复用 `useNow`（已有） |
| 固定区「等待答复」徽标 | `Badge status="processing"` + `Typography.Text` | 与进行中的状态点同一套动效（§6.7 第 5 条） |
| **「进行中 / 结果未采集」** | `Badge status="processing"` / `Typography.Text type="secondary"` | **§9.7 的独立原语 `agent-run-state-tag`**：唯一一处分派处，工具行与三张卡片共用 |
| 折叠箭头 | `Collapse` 自带 `expandIcon` | **不自己写 ▸ ▾**（§6.1 表格里的符号只是文字示意） |
| 正文 | `MarkdownText`（已有）+ 容器 `Typography` | 流式光标用**容器上的伪元素**，`MarkdownText` 不改 |
| 子任务占位条 | `Card` `size="small"` + `Tag` + `Button` | 观感与行卡片同族 |
| 过滤 | **两个 `Tag.CheckableTag`** | ⚠️ antd 6 的 `Segmented` **不支持多选**（`SegmentedValue = string \| number`，实测）⇒ 不用它 |
| 轮次跳转 | `InputNumber` `size="small"` | 越界 clamp（§6.5） |
| 跟随最新 | `Switch` `size="small"` | 沿用「自动滚底」原来的控件形态 |
| 原始输出 | `Collapse` `ghost` + 二级抽屉（`base/nested-drawer.tsx`）+ `MonoText` / `base/json-text.tsx` | 正文逐字原文（§5.3）：是 JSON 就格式化高亮，不是就逐字给出。**独立成 `raw-output-panel`**，卡片底部的「原始结果 ▾」是同一个件（§9.7） |
| 环境信息入口 | `Button type="text"` + `QuestionCircleOutlined`（已有图标包） | `aria-label` 与 `Tooltip` 都写「环境信息」（§6.8）。**它是 `ToolbarAction` 的一项**（§9.4），不写死在工具条里 |
| 环境抽屉 | `base/nested-drawer.tsx` 的 `NestedDrawer`（`agent-log` 内部件） | 几何取自 `base/drawer-geometry.ts`：`NESTED_DRAWER_SIZE`（`min(60vw, 900px)`，⚠️ 不是 `width`）、`DRAWER_SEMANTIC_STYLES`、`mask.closable`；`push` 由主抽屉给（`MAIN_DRAWER_PUSH`） |
| 环境摘要 | `Descriptions` `size="small"` `column={1}` | 「这一行跑在什么之上」逐项列出 |
| 环境分组 | `Collapse`（每组一项）+ `Tag` 标来源 | 项目侧 / 厂商侧 / 统计 |
| 长文本 | `MonoText`（已有）+ 截断提示 + 复制按钮 | 不内套第二层滚动区（§6.8 末段） |
| 节点内容未到 | `Skeleton`（已用） | §6.2 |
| 空态 | `EmptyState`（已有） | §6.1 |
| **虚拟列表** | `packages/client/ui/src/base/virtual-list.tsx` 的 `VirtualList`（内部是 **`Listy`**，`virtual`，**不传 `itemHeight`**） | 见 §7.2：全仓唯一的 `<Listy>`；消费方只有 `virtual-turn-list.tsx` 与 `raw-output-panel.tsx` 两处，L0/L1 不许 import 它 |
| 扫光动效 | `ACTIVITY_SWEEP_CLASS`（已有具名出口） | `.aieval-activity-sweep` 已在 `globals.css`，**不新造 keyframes** |

**按 antd 6 实测对齐的五处**（原始数据见 `notes/2026-10-02-exec-log-visual-measurements.md` §5）：
`List` → `Listy`（4 处）、`Drawer width` → `size`（主抽屉 + 二级抽屉）、
`Segmented` 多选 → `Tag.CheckableTag`、`maskClosable` → `mask.closable`、
`Breadcrumb menu` → `items`。
**无需改的**：`Collapse` 的 `items[].extra` / `destroyOnHidden` / `ghost` / `activeKey`、
`Breadcrumb items`、`Badge status`、`Switch size="small"` —— 带 `@deprecated` 的是它们的**旧**写法
（`children` / `destroyInactivePanel` / `menu`）。

#### 9.6.1 size 口径：**执行日志里带 `size` 的组件一律 `small`**

按 antd 6.6.5 的 `*.d.ts` 逐个核对，这条口径落在**六个**组件上，全部写死 `size="small"`：
`Button`（5 处）、`Switch`、`InputNumber`、`Card`、`Descriptions`、`Badge`（5 处）。
守卫在 `agent-log-size-sweep.test.ts`：按组件名逐个查开标签，缺一格或写成别的值都红。

三条边界，都是实测出来的（**别按直觉改**）：

| 事实 | 依据 | 后果 |
|---|---|---|
| **`Badge` 的 `size` 只作用于计数徽标** | `Badge.js` 把它拼进计数组件的 `ScrollNumber` 类名（`${prefixCls}-count-sm`），status 圆点徽标那条分支不带它 | 抽屉里 5 处全是 status 徽标 ⇒ 写上**不改变外观**。写它是为了「全件同形、可静态核对」，不是「它偏大才压」 |
| **`Tag` / `CheckableTag` 没有 `size`** | `TagProps`、`CheckableTagProps` 里都没有这一格 | 过滤器那两个 `Tag.CheckableTag` **不写** `size`（写了是个 read 的人以为生效的属性） |
| **`Listy` 没有 `size`** | `ListyProps`（`@rc-component/listy`）只有 `items` / `height` / `virtual` / `rowKey` / `itemRender` 等，**这一格在 antd 6 被去掉了** | 计划清单 / 问答选项 / 虚拟列表三处**不给** `size`；给 `Listy` 写 `size` 是个**不生效**的属性 |

⚠️ **`Drawer` 的 `size` 不是这一组**：它的类型是 `'default' | 'large' | number | string`（`Drawer.d.ts`），
收不到 `'small'`，给的是**宽度**——主抽屉与二级抽屉两个宽度都来自
`packages/client/ui/src/base/drawer-geometry.ts`（`WIDE_DRAWER_SIZE` / `NESTED_DRAWER_SIZE`）。
这两个值由 `apps/web-next/src/drawer-geometry.test.ts` 钉住（那条用例只取 `<Drawer>` 开标签，
不扫全文：同文件里还有若干 `<Button size="small">`）。

**为什么工具面板必须用 `Collapse` 而不是原生 `<details>`**：

1. **`destroyOnHidden`**：折叠的面板不进 DOM——这与虚拟列表是同一件事的两半
   （一个管「哪些轮」，一个管「哪些块」）；
2. **`items[].extra`**：状态汇总与工具名汇总不用自己摆版；
3. **`activeKey` 受控**：§6.1 里「进行中的组默认展开」与「流式推进不重置用户手动展开」
   这两条**互相打架**的规则，只有受控态才写得清楚——非受控的默认值在每次数据变化时
   都可能被重新应用，而那正是「用户展开的面板自己合上了」的成因。

**一条允许的例外**：`ui` 包一个 CSS 文件都没有（`agent-activity-line.tsx` 的文件头已确立
「全局样式只在 `apps/web-next/app/globals.css` 一处，ui 只带类名」）。故 §6.7 的扫光、
呼吸点、流式光标三处**只能**以类名形式实现，并由 `apps/web-next` 的既有守卫
（`global-styles.test.ts` 那类）核对类名与 keyframes 两边一致。
这三处**不写字号、不写行内边距**，只写动效与结构性属性。

### 9.7 两个具名原语的归属

**「进行中 / 结果未采集」这一对判断必须只有一处分派**：
它要落在**四个地方**（工具行 / 工具组 / 计划清单 / 问答卡片——其中前两者同属工具族），
**四处各写一遍 = 三处会漂**，而漂了之后「结果未采集」会在某一处悄悄变回「正在跑」。
而 §10 变异体 (f) 要拦的恰恰是「把两者混成一个」。故提升成一个 L0 原语：

```ts
/**
 * 「这次调用现在什么状态」——**唯一一处分派 `running` 与「结果未采集」的地方**。
 *
 * 为什么必须是具名原语（而不是各卡片自己写一遍）：
 *   · §4.2 立过一条硬规则——`running` **不可由「有没有 output」推断**，
 *     「还在跑」与「跑完了但结果拿不到」在折叠态下必须显示成两句话（转圈 vs 静态灰字 + 原因）；
 *   · 这条规则要落在四个地方。**四处各写一遍 = 三处会漂**，而漂了之后
 *     「结果未采集」会在某一处悄悄变回「正在跑」——那正是变异体 (f) 要拦的缺陷。
 *
 * 它**只吃四个字段**（`running` / `hasResult` / `missingReason` / `since`），
 * 不认 `ToolItem` / `TaskPanel` / `AskUserInteraction` 中任何一个
 * （故四张卡片与工具行都能用它）。
 */
export interface AgentRunStateTagProps {
  /** 有调用、结果未到、**且所在轮次尚未结束** */
  running: boolean;
  /** 结果在不在（`null` = 还没到） */
  hasResult: boolean;
  /** 结果未采集时的原因（`capability` 给；拿不到为 null 时只写「结果未采集」） */
  missingReason: string | null;
  /** 给计时器用：`running` 为 false 时不挂定时器（`base/use-now.ts` 的文件头） */
  since?: string | null;
}
```

**同理提升的第二个具名原语**：§5.3 的「原始输出」面板（`raw-output-panel`）。
把它塞在 `agent-log-facts-bar` 里不够用：§5.4 / §5.5 两张卡片的底部**各要一个「原始结果 ▾」**，
而 §5.3 又要求三态画面（`loading` / `error` + 重试 / `ready`）。故它独立成 L0：
吃 `Loadable<AgentLogDiagnostics> | Loadable<ToolCardResult>` 的**公共形状**
（`{ status, lines|raw, truncatedReason }`）与 `onRetry`。
**卡片底部用的是它的 `ToolCardResult` 变体**（单份原文），固定区用的是 `AgentLogDiagnostics` 变体（逐行）。

### 9.8 三家智能体的实施路径

渲染只有一条管线：三家差异**全部在数据层折成同一形状**，组件里没有厂商分支（§9.0 纪律 3）。
适配器侧（怎么取数、怎么投影成 `AgentMessage` / `AgentEvent`）见 v3 §4；本节写**从厂商数据到上屏**
这条路径上每家各走哪几个文件，以及界面靠哪一格知道这家的情况。

#### 9.8.1 共同段（三家逐跳相同）

| 跳 | 落点 | 输入 → 输出 |
|---|---|---|
| 记录订阅 | `packages/client/client/src/row-messages.ts` 的 `useRowMessages` | 先 `GET …/messages`（URL 由 `packages/client/client/src/runs.ts` 的 `runRowUrl` 拼），再接 `runRowMessagesStreamUrl` 的 SSE → `RowRecord[]` |
| 记录折平 | 同上：`foldRowRecords` / `mergeRowRecords` | 按 `message.mergeKey` / `subagent.subagentId` **覆盖累积**、顺序按首次出现、一帧一次提交 |
| 事件订阅 | `packages/client/client/src/row-stream.ts` 的 `useRowStream` 与 `row-live.ts` 的 `useRunLiveMetrics` | 行级事件流（`/stream?afterSeq=`）与实时指标流是两条独立连接 |
| 行级事实 | `apps/web-next/src/log-drawer-state.ts` 的 `buildRowFacts` | 事件流 → `AgentLogFactsInput`；`usage` 只认**主会话**那条 |
| 建模 | `packages/client/ui/src/composite/agent-log/build-model.ts` 的 `buildAgentLogModel` | `RowRecord[]` + 事件 + facts → `AgentLogModel`；另有两条出口 `rowEventsOf`（事件 → 时间轴条目）与 `diagnosticsOf`（`log` → 原始输出） |
| 会话分桶 | `build-model.ts` 的 `sessionKeyOf` / `aliasOf` | 按 `subagentId` 分会话节点；`parentCallId` 命中的别名并进同一个节点 |
| 分轮 | `build-model.ts` 的分轮装配 | `roundTrip` → `LogTurn.round`；`running` 只在**最后一轮**且 `facts.live` |
| 规整 | `agent-log/render-blocks.ts` 的 `buildRenderBlocks` | 一轮的块 → 九个 `RenderBlock` 臂（§4.2 四条规整） |
| 渲染 | `agent-log/agent-log-layout.tsx` / `agent-message-timeline.tsx` / `virtual-turn-list.tsx` | 固定区 + 时间轴 + 浮动件；块分派走注册表（§9.3） |
| 环境 | `packages/client/client/src/build-environment.ts` 的 `buildAgentEnvironment` | `EvalRow` 快照 + 事件 + 记录 → 四组 `AgentEnvironment` |
| 接线 | `apps/web-next/app/runs/page.tsx` | 订阅两条流、现算三份模型、把 props 交给 `AgentLogDrawer` |
| 预览 | `apps/web-next/app/dev/agent-log/page.tsx` ← `agent-log/fixtures.ts` 的 `allFixtures` | 三家夹具各喂一次真实抽屉 |

#### 9.8.2 claude-code

| 项 | 路径与口径 |
|---|---|
| 内容产出 | `packages/server/agents/src/providers/claude-code/message.ts` 的 `createClaudeMessageNormalizer`（逐条 SDK 消息投影）→ `messages.jsonl` |
| 子任务身份 | 记录身份 = 厂商 `task_id`；消息归属 = `parent_tool_use_id`。两者在 `build-model.ts` 的 `aliasOf` / `sessionKeyOf` 并成同一个会话键 |
| 派发点 | `task_started` / `task_notification` 的 `tool_use_id` → `SubagentRecord.parentCallId`；`build-model.ts` 的 `isDispatchCall` 按派发动作名（`Task` / `Agent`）认领，命中即在该轮出 `subagent-bar` |
| 任务名 | `description`（`build-model.ts` 的 `dispatchNameOf`）；`name === null` 的聚合形态由 `subagent-bar.tsx` 的 `displayName` 用 id 前 8 位兜底 |
| 子任务正文 | `forwardSubagentText` 未开 ⇒ 子节点只有工具流水：`agent-log-layout.tsx` 的 `notForwardedNotice` 出「该子任务的对话未转发」 |
| 思考 | `textKind: 'full'`（完整推理） |
| 厂商系统层 | 唯一发 `vendor-system` 事件的一家 ⇒ `build-environment.ts` 的 `vendorGroup` 里「已调度的工具」「斜杠命令 / 子智能体定义」有值、权限档取 `permissionMode`；「系统提示词」「工具模式串」恒 `not-observed` |
| 行级用量 | 收尾按子会话逐条报 `usage` ⇒ 行级读数只认 `turn.subagentId === null` 的那条（`row-live.ts` 与 `log-drawer-state.ts` 各判一次，同一口径） |

#### 9.8.3 codex

| 项 | 路径与口径 |
|---|---|
| 内容产出 | **会话文件** `rollout-*.jsonl`：`providers/codex/message.ts` 的 `projectCodexMessages`；运行期节流读盘 + 收尾整读一次 |
| 补录与摘要 | 块的 `source: 'session-file'` ⇒ 界面出「补录」角标；事件流那一格按厂商定义只有推理摘要 ⇒ `textKind: 'summary'` 出「摘要」标（`thinking-block-view.tsx`） |
| 子任务身份 | 事件流 `collab_tool_call` 的 `receiver_thread_ids[0]`；只有汇总计数的档位记 `source: 'aggregate'` ⇒ `build-model.ts` 走 `RowNode` |
| 派发点 | 一次派发会投递**多条**协作调用（`spawn_agent` → `wait` → `close_agent`，同一个 `subagentId`）⇒ 只能由**派发动作**认领（`build-model.ts` 的 `isDispatchCall`）；先到先得会把入口挂到 `close_agent` 上 |
| 汇总档 | `RowNode` 出 `row-summary`（`render-blocks.ts` 规则 5 + `row-summary-line.tsx`），**不进面包屑、不可点** |
| 工具名 | 事件流只有入口名（`exec_command` 这类）⇒「用过的工具及次数」从 `messages.jsonl` 的 `tool-call.name` 数（`build-environment.ts` 的 `observedGroup`），不从事件流数 |
| 厂商系统层 | 不发 `vendor-system` ⇒ 整组 `not-exposed`（「没投送到我们能读的通道」，不是「这家没有」） |
| 非致命告警 | item 级 `error` ⇒ `RowEvent.level: 'warning'`，不当成运行失败 |
| 轮次 | 条目计数是近似值、系统性偏高 ⇒ `round` / `turns` 只用同一份口径的同源值，跨家不比 |

#### 9.8.4 dsh

| 项 | 路径与口径 |
|---|---|
| 内容产出 | 通知流逐条：`providers/dsh/events.ts` 的 `projectDshNotification` + `providers/dsh/message.ts` 的三条草稿构造函数 → `messages.jsonl`；**无会话文件读盘** |
| 块形态 | `assistant/message` 一条就是完整快照 ⇒ 动效只由 `assembly === 'open'` 触发，不靠增量 |
| 工具入参 | `arguments` 是 JSON 字符串 ⇒ `build-model.ts` 的 `serializeInput` 结构化与原文各留一份 |
| 工具结果 | 正文只是人读摘要（`read` / `write` / `edit` / `grep` / `glob`）⇒ 已解析事实在 `structured`，落点 `tool-item-detail.tsx` 的 `StructuredResult` |
| 子任务身份 | `subagent.started` 给的独立 UUID，与派发工具调用的 `callId` **不同值** ⇒ `parentCallId` 恒 `null`；派发点退到「按 `messageId` 命中，命不中挂轮末」（`render-blocks.ts` 规则 3） |
| 厂商系统层 | 不发 `vendor-system` ⇒ 整组 `not-exposed`；未指定思考档位时的文案是「未指定（由该家适配器决定：dsh 走 high）」（`build-environment.ts`） |
| `ask-user` | 本仓没有应答面 ⇒ 收场记 `unavailable`，卡片写明「已知边界，不是缺陷」 |

#### 9.8.5 三家的可回归面（夹具）

| 夹具 | 代表哪一档 | 落点 |
|---|---|---|
| `dshFixture()` | 覆盖最全：九条 `RenderBlock` 臂 + 两族卡片 + 附件 + 未识别 + 孤立结果 + 未收场子任务 | `agent-log/fixtures.ts` |
| `codexFixture()` | 「补录」+「摘要」+ 只有汇总计数的那一档（`kind: 'row'`） | 同上 |
| `claudeFixture()` | 「有内容但这一类没被转发」（有工具块、无 assistant 正文） | 同上 |

三份都**走真实链路**（`buildAgentLogModel` → `buildRenderBlocks` → 九臂渲染），
故「画不出来」只可能是那家适配器还没把内容投影进记录流，不是界面缺了一类块（§12.1）。

## 10. 测试计划

| 文件 | 覆盖 |
|---|---|
| `ui/.../render-blocks.test.ts` | `buildRenderBlocks`：callId 配对成功 / `callId` 为 null 降级 / 配不上的 result 独立成条 / 连续工具合并 / 中间夹 text 则**不**合并 / **「先全建再渲染」由结构挡住**（L1 只吃 `turns` + 分派函数，§9.1）/ codex 的「一个 item 拆成 call+result」/ **两族卡片从工具组提出并切断合并链**（前后各成一组，且组头的 `工具调用 × N` **不含**提出去的调用）/ **同轮多次 `task` 调用只出最后一张面板 + 面板底部「本轮另有 N 次更新」** / **族载荷缺失（`tool === null`）时该次调用回退成普通工具行（不消失、不空面板）** / **`family` 非空但 `tool` 为 null 时也是通用工具行**（D29：两者不是一回事）/ **块按 `kind` 判别分派（`assertNever` 兜底）**：六类块各自的字段只在自己那一支可读 / **`spawnedBy` 命中的节点在同一轮的对应位置出 `subagent-bar`**；`callId` 为 null 或命不中时挂在轮末而**不是**被丢掉 / **`round === null` 的轮次进「未归属」段而不是被过滤掉** / **`kind: 'row'` 的节点出 `row-summary` 臂而不是 `subagent-bar`**（D32） |
| `ui/.../render-blocks.test.ts` + `ui/.../agent-message-timeline.test.tsx` | **「收尾标记从哪来」的护栏**：`buildRenderBlocks` **不碰** `delta` / `snapshot` / 合并键（§4.2 职责边界）——断言它对同一批块**只做转发**、且**不读** `chunk` 类字段 / `assembly` 被如实带出 / **`ToolItem.running` 只由 `LogTurn.running` 转发**，不由「`output` 是否存在」推断（变异体 (f) 的**结构性**版本：把一个被中断的轮次造出来，「结果未采集」必须仍显示为静态灰字）/ 动效类名只在 `assembly === 'open'` 时挂、`snapshot` 时摘掉（`text-block-view.test.tsx` / `thinking-block-view.test.tsx`） |
| `ui/.../agent-log-layering.test.ts` | **三层边界纪律的可执行形式**（§9.0）。**它是静态扫描而不是渲染断言**——用 `fs` 读 `agent-log/` 下的源文件、按层查 import 说明符：(a) L0 **不得** import L1/L2；(b) L1 **不得** import L2；(c) **虚拟化的三个入口（`virtual` / `itemHeight` / `from 'antd/listy'`）只许出现在 `base/virtual-list.tsx`**，且两个消费方都必须是 `<VirtualList`；(d) L0/L1 **不得**出现 `useState`（§9.0 纪律 2）；(e) L0/L1 **不得**出现 `EvalRow`，也不得按厂商分支（纪律 3；判据只扫**去注释后的可执行源码**）；(f) **`BlockRenderContext` 不得出现 `streaming`**（§9.1：`assembly` 是唯一判据，变异体 (y)）。**逐条各有一个变异体**——详见 §10 的 (n)–(r) 与 (y) |
| `packages/client/client/src/row-stream.test.tsx` | **投递合并**（§7.1）：同一批多帧只触发一次 `setEvents` / 合并后的结果与逐帧投递**逐条等价**（去重、升序、「seq 回到 1 = 新一代」三条语义不变）/ rAF 不可用时 200ms 兜底仍会刷 |
| `packages/server/contracts/src/agent-event.test.ts` + `typecheck` | **形状靠类型与 schema 钉**：`AgentMessage` / `ContentBlock` / `RowRecord` / `MessageCapability` 的 schema 在 `packages/server/contracts/src/agent-message.ts`，`Loadable` 三态与 `RenderBlock` 判别联合由 `tsc` 保证「自相矛盾的组合写不出来」（**模型组装属 B 段**，此处只钉形状不钉行为）；事件 schema 的运行时守卫在 `agent-event.test.ts` |
| `ui/.../agent-message-timeline.test.tsx` | **L1 的用例（不掺虚拟化、不掺 subagent）**：思考默认收起 / 工具组默认收起 / `running` 的组默认展开 / **`error` 的组与行也默认收起**（用户口径：错误原文不在 DOM 里，组头仍给出「失败 N」）/ `thinking.text === null` 显示缺失原因而非空面板 / `text` 块走 markdown（`MarkdownText` 挂载）/ 子任务占位条渲染且不折叠 / **`streaming` 时挂扫光类名与光标容器类，转 false 后类名被摘掉**（§6.7）/ **`renderBlock` 不传时走默认注册表、传了就用传入的分派**（§9.2）/ **逐轮 `map` 渲染：`turns` 有 50 轮时 DOM 里就有 50 轮**（这条钉的正是「L1 不虚拟化」——变异体 (n)） |
| `ui/.../log-node-breadcrumb.test.tsx` | 链由 `parentId` 回溯派生（换 `activeNodeId` 即换链）/ 段数与顺序 / 当前段 `aria-current` / 下拉列的是**同层兄弟**（不是全树）且当前项 `disabled` / 任务名为 null 时显示 id 前缀兜底 / `kind === 'row'` 的节点不进面包屑 |
| `ui/.../agent-log-facts-bar.test.tsx` | 各事实格的空值不显示成 `0` / 错误格存在时可见 / **耗时用 `useNow` 本地走秒表**（`startedAt` 在、`endedAt` 为 null 时数字在涨；终态用 `endedAt − startedAt` 的结算值）/ **思考 token 只在与 `tokens` 并列的那一格显示**，`basis !== 'additive'` 时**不提供任何相加口径**、`null` 时不显示「0」/ **`facts.domain` 按数据层给的顺序渲染**，空数组时不出这一行，`label` / `value` / `hint` 一字不改地照画（UI 不解析值）/ `status.label` 照数据层给的文案渲染、`tone === 'running'` 时才带动效 / 「等待答复」徽标只在真的在等时出现（§5.5）。**原始输出入口的用例已移出**（归下两行） |
| `ui/.../raw-output-panel.test.tsx` | **§9.7 提升出来的原语，两种变体各测**：`AgentLogDiagnostics` 变体逐行渲染 `[HH:mm:ss] source + 原文`（复用 `log-format` 措辞）/ `lines` 空数组时**不渲染入口** / `loading` 给 `Skeleton`、`error` 给 `Alert` + 重试且 `onRetry` 未给时**不渲染重试按钮** / `truncatedReason` 非空时如实显示那句话 / **`ToolCardResult` 变体（卡片底部）与逐行变体共用同一个件**：`raw === null` 时显示「结果未采集」而不是空白 / `secret` 类遮罩由调用方决定（本件不做脱敏，§5.5） |
| `ui/.../agent-run-state-tag.test.tsx` | **§4.2「`running` 不可由 `output` 推断」的唯一分派处**：`running === true` → 转圈 + 走秒表（fake timers 涨数）；`running === false && !hasResult` → **静态灰字「结果未采集」且不带 `Badge status="processing"`**（变异体 (f) 的核心断言就在这一行）/ `hasResult === true` → 不显示状态（已确定的事不占地方）/ `missingReason` 非空时把那句话带上 / **`since` 为 null 时不挂定时器**（终态不涨） |
| `ui/.../fixtures.test.tsx` + `ui/.../block-renderer-registry.test.ts` | **D25 的守卫**：三家夹具合起来覆盖 `RenderBlock` 的**九条 arm**，且每条都能被 `DEFAULT_BLOCK_RENDERERS` 渲染出来（不抛、不返回空）/ 带原文抽屉的两张卡片从 `BlockRenderContext` 取开合（不写死）/**变异体 (o)**：把 `BlockRendererProvider` 改成「整体替换」后「默认臂仍可用」必须红 |
| `ui/.../agent-log-drawer.test.tsx` + `ui/.../agent-log-layout.test.tsx` | **抽屉外壳**：`open === false` 不渲染正文、打开时标题是「执行日志」且正文取满抽屉（`height: 100%`）/ 标题可覆盖 / 页面侧三个接线位（`notice` / `liveError` / `connected`）透传到底 / **主抽屉关闭时环境抽屉不在 DOM 里**（结构性保证）。**布局**：`empty === true` 出 `EmptyState` 而不是空时间轴 / 切节点内容未到出 `Skeleton`、读失败出 `Alert` 且只有给了 `retryNode` 才渲染重试 / 过滤在**轮次级**生效并显示命中数 / 「跟随最新」只有一份 state（开关与浮出按钮同步）/ `source` 全不给时各入口照常工作（「未提供」而不是崩溃，§4.4 口径 1）/ `timeline` 槽传函数时**不渲染「已渲染 N 共 M 轮」**（§7.2） |
| `ui/.../agent-environment-drawer.test.tsx` | **`agent-log` 内部件的用例**：摘要各项与分组按数据层给的 `title` / 顺序渲染 / 四种 `source` 各有标签 / `present: false` 渲染成「标签 · 原因」而**不是空白** / `truncated` 非空时出截断提示与「复制全部」 / **「已调度的工具」（vendor）与「用过的工具」（observed）在两组** / **用户提示词不出现在环境抽屉里**（D19）/ 加载中 `Skeleton`、失败 `Alert` 重试 / `environment === undefined` 时显示「未提供」而不是空白 / **主抽屉关闭后环境抽屉不在 DOM 里**（结构性保证，钉一条防回归） |
| `ui/.../tool-group-panel.test.tsx` | 组头文案（`工具调用 × N` + 名字汇总 + 状态汇总）/ **组头的「失败 N」**（折叠口径的补偿）：N 数的是**结果为 `error` 的条目**——**含失败的孤立结果**，与「工具调用 × N」是两个口径；**一条失败都没有时整格不渲染**（不画恒为 0 的读数）；**收起态就能看出这一组有失败，而组内的行一条都不挂载**（证据要点开）/ 工具行摘要 / 展开后出 `ToolItemDetail` / 超长结果截断并给「展开全部」 |
| `ui/.../task-panel-card.test.tsx` | 计数与变化摘要**照数据层给的渲染**（UI 不自己算）/ 四态 Tag（`unknown` **不显示成成功**）/ `steps` 空数组显示「清单为空」而不是空白面板 / `owner === null` **不显示这一格**、`owner === ''` 显示「未指派」/ `id === null` 时不画 id 与依赖 / 首次（`change === null`）展开、其后收起且标题带摘要 / `running` 与结果未采集时默认展开 / 同轮更早的调用收进「本轮另有 N 次更新」/ `note` 有值时出现在标题行 |
| `ui/.../ask-user-card.test.tsx` | **`state: 'pending'`** 显示「等待答复中…」+ 计时在涨（fake timers）+ **不显示任何收场文案** / **`state: 'pending'` 且 `running === false`** 显示「结果未采集」而**不是**一直转圈（D35）/ 七态各自的 Tag 与中文 / `unavailable` **不是红色错误样式**且写明「无人可应答、已知边界」/ **答案按 `label` 回填（不是 id、不是下标）** / 多选时 `custom` 补充、单选时覆盖 / `selected` 里的未知标签**照样显示** / `recommended` 打 Tag 但**顺序不变** / `allowOther` 追加「其它（自由输入）」/ `secret` 默认遮罩 + 「显示」按钮可展开 / 等待状态默认展开、已收场默认收起、`timeout`/`unavailable`/`rejected` 默认展开 |
| `ui/.../virtual-turn-list.test.tsx` + `ui/.../base/virtual-list.test.tsx` | **§7.2 的护栏**：拿不到高度就**不虚拟化**（每一项都渲染，「已渲染 N / 共 M 轮」如实给出）/ 用户提示词与补充提示是列表里的头几行（跟着列表滚，不钉在顶上）/ `ListController` 暴露跳轮次与回到最新、越界不抛 / 空轮次不抛、尾部如实说 `0 / 0`。**「先全建再渲染」由结构挡住**：L1 只吃 `turns` + 分派函数（§9.1），虚拟化的三个入口只许出现在 `base/virtual-list.tsx`（`agent-log-layering.test.ts` 的 (c)） |
| `ui/.../agent-log-toolbar-preset.test.ts` | **D26 的守卫**：「原始输出」在 `diagnostics.lines` 为空时 `visible === false` / `diagnostics` 为 `undefined` 时该动作的显隐（与 §5.3 一致）/ 「跳到轮次」的 `min` / `max` 来自 `turns.length` 且越界 clamp 后**如实回显**（§6.5）/ 「跟随最新」的 `toggle.checked` 与浮出按钮**是同一个值**（不出现两份 state）/ 「只看工具调用」命中含 `task` / `ask-user` 的轮次（§6.5）/ **`AgentLogLayout` 传了 `actions` 时用传入的、不传时用预设**——变异体 (p) |
| `apps/web-next/src/log-drawer-state.test.ts` | 既有三态判定保留；新增「`log` 事件不再进时间轴」的接线断言 |
| `apps/web-next/src/runs-page-wiring.test.ts` | 页面接线的**静态守卫**：`resolveLogDrawer({` 与 `buildRowFacts({` 必须出现在页面里；`AgentLogDrawer` 吃到的是 `buildAgentLogModel` 的产物 |
| `eval-row-card.test.tsx` | 按钮可访问名逐字改「执行日志」，**顺序断言不变** |

**契约与结构的守卫文件**（钉 D27–D38；**每条都配变异体**，见本节末）：

| 文件 | 覆盖 |
|---|---|
| `packages/server/contracts/src/agent-message.ts` 的 schema + `ui/.../build-model.test.ts` + `ui/.../capability-notes.test.tsx` + `ui/.../fixtures.test.tsx` | **D27–D37 的形状不变量**：取值集合（`MessageSource` / `MissingReason` / `CapabilityLevel` / `LogNodeStatus` 七档 / `TruncationState` 三态）由 schema 与 `tsc` 钉住；`CapabilityDecl` 的**配对不变量**（`yes` ⇒ `source` 非空且 `reason` 为 null，否则反之）在 schema 的 `superRefine` 里；界面侧的落点是：不给能力声明 ⇒ **全套记「没验证过」**、主会话节点的 `sessionFacts === null`、`thinking === null` **不显示成 0**、三家夹具合起来覆盖九条 arm |
| `ui/.../text-block-view.test.tsx` + `ui/.../thinking-block-view.test.tsx` | **§6.9 的角色标签与来源标注**：`role === 'assistant'` **不标注** / `user` 出「用户」标并带左侧竖线 / `system` 出「系统」标且整块降一档 / `source === 'session-file'` 出「补录」、`'aggregate'` 出「汇总」、`'wire'` **不出** / **`textKind === 'summary'` 出「摘要」标** / `contentTruncatedReason` 非空时那句话可见（`agent-log-facts-bar.test.tsx`）/ **变异体 (s)**：把 `role` 固定成 `'assistant'` 后，`user` / `system` 的断言必须红 |
| `ui/.../capability-notes.test.tsx` | **D28 的界面落点**：`capability` 按数据层给的**顺序**渲染、**UI 不硬编码维度名**（塞一个 `{ myNewDim: … }` 也要画出来）/ 四句「为什么没有」**互不相同**：`no → 「这家结构上不支持」`、`not-projected-by-vendor → 「厂商有数据、但没投送到我们能读的通道」`、`off-by-adapter → 「厂商有、我们还没接」`、`unverified → 「没验证过」` / `capabilityNotes` 非空时如实显示（能力随路由 / 模型变化的前提）、空数组时那一行不出现 / `level === 'yes'` 的那一格**不显示原因**、`only` 只筛维度不改顺序 / **变异体 (t)**：把几种原因写成同一句，断言必须红 |
| `ui/.../attachment-block-view.test.tsx` + `ui/.../unrecognized-block-view.test.tsx` | **D31 的界面落点**：`image` / `file` 各自的 Tag 与路径、MIME（拿不到就不出那一格）/ `path === null` 显示「内联内容，无路径」而**不是空白** / **缩略图不加载**（断言不出现 `<img>`，本期口径）/ `unrecognized` 渲染成折叠的等宽原文（JSON 走 `JsonText` 格式化）+ 厂商类型，**默认收起**、`raw === null` 时说「原样载荷未采集」 / **变异体 (u)**：把 `unrecognized` 也走附件那一条路（或反之），两条断言必须红 |
| `ui/.../row-summary-line.test.tsx` + `ui/.../subagent-bar.test.tsx` + `ui/.../log-node-breadcrumb.test.tsx` + `ui/.../build-model.test.ts` | **D32 / D33 的节点形态**：`RowNode` 出 `row-summary`（**计数与状态都可见**，`counts === null` 时如实说明而不是空白，且**不可点**、不渲染任何按钮）/ `RowNode` **不进面包屑**、也不进同层菜单 / `SessionNode` 的子任务占位条显示 `dispatchKind`、`outcome`、`usage` 三格（拿不到时各显示「未采集」而不是空白，`usage` **主会话为 null 时不显示这一格**）/ `status` 七档**各有一句中文**，其中 **`unsettled` 与 `running` 必须是两句不同的话**（「等不到了」vs「还在等」）/ `statusMissing` 非空时**同时**显示状态与「状态未采集」（两句并列）/ **变异体 (v)**：把 `unsettled` 归并进 `running`，断言必须红 |
| `ui/.../raw-output-panel.test.tsx` | **D37**：`summary` 非空时它**优先**渲染且 `text` 原文**仍在**（两者都给）/ `summary === null` 时**不拿 `text` 顶替**（那段原文在界面上只出现一次）/ **变异体 (w)**：把 `summary ?? text` 写进去，第二条断言必须红 |
| `ui/.../raw-output-panel.test.tsx` + `ui/.../tool-item-detail.test.tsx` | **D30**：`kind: 'none'` **不显示**截断提示 / `kind: 'truncated'` 显示提示 + `reason` / **`kind: 'unknown'` 显示「可能不完整」且绝不显示「完整」**——裸布尔时代**表达不出来**的那一格 / 展开的工具行给出完整参数（含字节数）、结果原文与截断提示 / **变异体 (x)**：把 `unknown` 与 `none` 走同一分支，断言必须红 |

**D39 的守卫**（落在既有文件里，不新开文件）：

| 文件 | 覆盖 |
|---|---|
| `ui/.../build-model.test.ts` | `usage` 与 `mergeKey` **摊到每个块**（同一条消息的每个块共享同一个 `usage`）；契约缺这一格时 UI 侧是 `null`（**不是 `undefined`**） |
| `ui/.../agent-message-timeline.test.tsx` | **每条消息恰好一行**页脚（同一条消息的多个块只出一行，数 `[data-usage-footer]`）/ `usage === null` 时**一行都不出**（既不渲染 0 也不写「未采集」）/ 文案以「**本条 输入**」开头（**不是**「用量 …」，与轮末里程碑不同形）/ 页脚**不是 `Tag`**（`[data-usage-footer].ant-tag` 查不到——全仓唯一一处按 antd 类名断言的地方，因为这条判据本身就是「**不许**用哪个组件」，而组件只能由类名识别）/ 与里程碑是**两个互不嵌套**的锚点（`[data-usage-footer]` vs `[data-row-event]`）/ **子会话节点同样渲染** |
| `ui/.../build-model.test.ts` | **水位按会话拆**：子会话读数的前几条**不再被主会话水位丢掉**；**老日志（无 `turn`）行为逐字不变**（全落 `main` 桶） |
| `ui/.../agent-message-timeline.test.tsx` | 里程碑**按号归位**：有键按 `(会话身份, 轮次号)` 归本轮，**跨会话不串**（子会话同号的轮次不认领主会话的里程碑）；有键但本节点对不上 ⇒ **本节点不显示**；无键的 `error` 仍按时刻（逐条与改动前相同）；端到端：里程碑渲染在**它自己那一轮**的分组里 |

**jsdom 验不出、必须靠真实浏览器冒烟的七项**（写进冒烟清单，不是「可选」）：

1. 虚拟列表的滚动几何：`ListController.scrollToTurn(n)` 后目标轮的
   `getBoundingClientRect().top` 落在视口顶部（±2px）；
2. 展开一条嵌套折叠面板后，**下方轮次的滚动位置不跳**（D9 的全部理由）；
3. 跟随最新的自动关闭：向上滚一屏后新事件到达，视口不再移动，且浮出按钮出现；
4. 明暗两态下展开/收起的面板底色与边框都可读。
5. **动效的可见性**（§6.7）：流式期间思考标题在扫光、正文末尾有光标；块一结束两处都停。
   （jsdom 只看类名在不在，**「动没动」要看真实浏览器**。）
6. **流式不卡**（§7.1）：让一行持续输出时，键入过滤条件与滚动**不被拖慢**；
   React DevTools 的 Profiler 里确认「一次上游提交只走一次重建」。
7. **内存不持续增长**（§7.4 的处置门槛**必须在这一项里被执行**，否则那条门槛等于没写）：
   反复进出几个子任务节点后，浏览器 Performance 面板的 JS heap 曲线**不呈单调上升**。
   若上升：先量再改，落点是**数据层的按节点保留上限**，**不是**在 `ui` 包里加淘汰。

**变异验证**（本仓硬口径：没见过失败的守卫不算守卫）：至少对以下**二十六条**把缺陷造回去并确认守卫变红。
(a)–(m) 拦行为，(n)–(r) 拦分层，(s)–(y) 拦「用乐观值填补缺失」，(z) 拦「折叠之后失败彻底消失」：

(a) 把 `callId` 配对改成「按出现顺序两两配对」；(b) 把 `running` 的组默认展开改回收起；
(c) 把 `usage` 创新高判断去掉（每轮都进时间轴）；(d) 把 `thinking.text === null` 的空面板改回空串渲染；
(e) **把折叠键从 `ContentBlockBase.id` 改回数组下标**（追加一轮后「我展开的那条自己合上了」必须红）；
(f) **把 `running` 改成由「有没有 `output`」推断**（「结果未采集」被显示成「正在跑」必须红）；
(g) **把「已调度的工具」与「用过的工具」并成一组**（§6.8 的分组断言必须红）；
(h) **把组名硬编码进组件、忽略数据层给的 `EnvGroup.title`**（新增一层时组名不变，断言必须红）；
(i) **把 `AskUserAnswer.selected` 的匹配从「选项标签」改成「数组下标」或「option id」**
（答案看起来有、其实错位，必须红）；
(j) **把「还没收场」并进任何一态显示**（把 `AskUserPending` 并进 `AskUserSettled`，「还在等」被说成「已经收场」必须红）；
(k) **把两族卡片改回留在工具组内**（组头的 `工具调用 × N` 与实际列出的行数不一致，必须红）；
(l) **把 `owner === null` 显示成「未指派」**（编造了这一家没有的概念，必须红）；
(m) **把同轮多次 `task` 调用画成多张面板**（v2 spec 的「只画最后一条结果，历史折叠」被破坏，必须红）。

**(n)–(r) 五条——它们钉的是分层本身**：

(n) **把虚拟列表塞回 `agent-message-timeline`**（或让 L1 去 import `Listy`）：
`agent-log-layering.test.ts` 的 (c) 必须红，且 `agent-message-timeline.test.tsx` 的
「50 轮渲染出 50 轮」必须红。**这一条是 S5 与 §7.2 的共同守卫**；
(o) **把 `BlockRendererProvider` 改成「整体替换默认表」**：注册表用例的「默认**九臂**仍可用」必须红
（这条防的是「扩展一下就把默认渲染器弄丢了」，而那种缺陷在页面上表现为**大面积空白**、
控制台只有一句 `undefined is not a function`，很容易被误判成数据没到）；
(p) **把 `AgentLogLayout` 改成忽略传入的 `actions`、恒用预设**：工具条预设用例的
「传了 `actions` 时用传入的」必须红（否则 S4 的「新增动作」只是纸面承诺）；
(q) **把某个 L0 件从受控改回 `useState`**（例如 `thinking-block-view` 自己记住开合态）：
`agent-log-layering.test.ts` 的 (d) 必须红，且该件的独立挂载用例必须红（S3 的守卫）；
(r) **在 L0 里加一句按厂商分支**（例如 `task-panel-card` 判 `agentKind === 'claude'` 才画 `owner`）：
`agent-log-layering.test.ts` 的 (e) 必须红（「**UI 不判厂商**」的目录级落实）。

> **为什么 (n)–(r) 必须单列**：(a)–(m) 全部是**行为**守卫——它们拦的是「画错了」。
> 而 (n)–(r) 拦的是「**层塌了**」：塌掉之后(a)–(m) 可能**全绿**（界面看起来还是对的），
> 但下一个消费场景接不进来。**这正是「可重组」这件事唯一能被自动验的形式**——
> 否则「支持重组」只能靠人读代码相信。

**结构性六条（(s)–(x)，钉 D27–D38 的契约改动）**：

(s) **把 `role` 固定成 `'assistant'`**（或干脆不渲染角色标签）：`text-block-view.test.tsx` 的
    `user` / `system` 断言必须红。**这一条拦的是「用户在读一份不知道谁在说话的记录」。**
(t) **把三种缺失原因写成同一句话**：`capability-notes.test.tsx` 的「四句互不相同」必须红。
    这拦的是「把『这家没有』说成『我们没接』」——本仓最忌讳的那类误读。
(u) **把 `unrecognized` 与 `attachment` 合成一条渲染路径**：两条断言必须红
    （一张图片被画成 base64、或一段原始载荷被画成附件）。
(v) **把 `LogNodeStatus.unsettled` 归并进 `running`**：断言必须红。
    **它拦的是「一个已经被强杀的子任务永远显示运行中」**——读的人会一直等一个不会来的收场。
(w) **把 `summary ?? text` 写进原始输出面板**：`raw-output-panel.test.tsx` 必须红。
    规范逐字禁这一条（「消费方不得拿 `text` 顶替」）。
(x) **把 `TruncationState.unknown` 与 `none` 走同一分支**：`raw-output-panel.test.tsx` 必须红。
    **这一条是 D30 的全部意义**：裸布尔时代「没采到标记」与「确认完整」在界面上完全一样。
(y) **把 `streaming` 这个第二真值加回 `BlockRenderContext`**（或让某个渲染件自己算
    「是不是最后一块」）：`agent-log-layering.test.ts` 的「L0/L1 不得出现自造流式判据」断言必须红，
    且 `text-block-view.test.tsx` 的「`assembly === 'snapshot'` 时**不挂**动效类名」必须红。
    **它拦的是「同一个事实有两处真值」**——`assembly` 由数据层给、`streaming` 没人给，
    两者必然漂移，而漂移的表现是「块结束了动效还在转」（(b) 的同源缺陷，但发生在组件层）。

**(z)：钉「失败也折叠」这一条口径**：

(z) **把「失败 ⇒ 展开」造回去**：① 组那一层（`defaultOpenKeysOf` 里写回 `if (running || failed)`）——
    `use-agent-log-view.test.ts` 的「失败的工具组与失败的行都默认收起」必须红、
    `agent-message-timeline.test.tsx` 的「失败的组与失败的行都默认收起」必须红；
    ② 行那一层（写回「失败的行也入键」）——`use-agent-log-view.test.ts` 的两条必须红
    （「都默认收起」与「组内有失败而轮次还在跑时……但那一行失败仍收起」）。
    两处是**两个可分别变异的缺陷**：只造 ① 时后者仍绿，故必须分两次做。
    另一半靶子是**组头的失败标记**：把「失败 N」删掉、或改成只数 `call`（漏掉失败的孤立结果）、
    或改成无条件渲染（恒画一个「失败 0」）——`tool-group-panel.test.tsx` 的三条必须分别红。
    **它拦的是「折叠之后失败彻底消失」**：失败不再自动展开是用户要的，但收起态必须说得出
    「这一组里有失败」，否则折叠会把一个原本可发现的信号变成不可发现的。

> **(s)–(y) 七条的共性**：它们拦的都是「**用乐观值填补缺失**」或「**同一事实立第二个真值**」——
> 没采到状态就说「还在跑」、没采到截断标记就说「完整」、认不出原因就说「这家没有」、
> 没人给收尾标记就自己猜一块是不是最后一块。
> 这与 (f)（`running` 不可由 `output` 推断）是**同一条纪律的七个面**，
> 也是本设计与「看起来采到了」长期对抗的那条主线。

> **计数口径**：变异体共 **26 条**：(a)–(m) 13 条、(n)–(r) 5 条、(s)–(y) 7 条、
> (z) 1 条（它自己含四个可分别变异的靶子）。
> **新增守卫时必须同时给变异体**（本仓硬口径：没见过失败的守卫不算守卫）。

## 11. 验收标准

1. 行卡片按钮与抽屉标题都用「执行日志」。
2. 抽屉打开即定位到最新一轮；顶部事实进度条常驻可见（滚动时不跟着走）。
3. 每轮的块按 `思考 → 工具调用 → 正文` 顺序呈现；正文是 markdown 渲染的结果，
   思考与工具组默认收起且可展开。
4. 连续的工具调用合成一个「工具调用 × N」面板；面板内一行一条工具；
   **点某一行**才出完整命令/参数/结果。
5. 进行中的工具组默认展开；**失败的工具组与失败行都默认收起**，
   而收起态由组头的**「失败 N」标记**说明这一组里出过错（组内那一行仍要点开才看得到证据）。
6. 主会话里 `spawn_agent` 的轮次同时出现「工具调用面板里的一条 `spawn_agent`」
   与「可点的子任务占位条」；点子任务条或面包屑下拉都能进子任务，
   且子任务的时间轴渲染与主会话**逐字同形**（同一个组件）。
7. 任务名为空的子任务显示 `子任务 <id 前 8 位>`，不出现空白。
8. 几百轮下 DOM 中轮次节点数恒定在十几条（`已渲染 N / 共 M 轮` 可见）；跳轮器能直达任意轮；
   **进度条的轮次与时间轴的轮次数同源同值**（都用数据层给的统一 `round`，厂商 `message.turn` 不参与分组）。
   **⚠️ 不是「跨三家可比」**——规范逐字要求
   「不要把某家偏高的近似值当成另一家的等价物」（codex 的近似计数**系统性偏高**），
   故本条的验收口径是「**同一份口径下的同源同值**」，跨家对比时按 `source` 标注（D1 / D27）。
9. 用户向上滚动后，新事件不再把视口拽走，右下角出现「回到最新」。
10. 「原始输出」能查到全部 `log` 原文（含 `[codex]` 那几行），且默认收起；**无法归一的厂商载荷走 `unrecognized` 块**（不是 `attachment` —— 后者是认识的图片/文件附件，见 D31 / §6.10）。
11. 正在跑的行：打开抽屉后再产生的新消息**能实时出现在时间轴上**（数据层的单一合并流生效）。
12. **流式连续追加不卡**：一行持续输出时键入过滤条件、拖动滚动条都跟手；
    且**一次上游提交只走一次重建**（§7.1 的 (a)(b)(c) 三条同时成立）。
13. **动态感可见**（§6.7）：跑动期思考标题扫光、正文末尾有光标、进行中的工具行状态在动；
    **块一结束五处动效全部停下**（静止 = 已确定）。
14. 「下载台账」导出的是 `formatEventLog` 的全文（口径见 §8.1），**与抽屉视图不是一回事**。
15. 还没跑过的行打开抽屉显示 `EmptyState`（措辞与今天一致）；读盘失败仍整段替换为错误提示。
16. 折叠面板、面包屑、过滤、跳轮次、开关、状态徽标**全部用 antd 组件**（§9.6 的选型表逐条对齐），
    没有自己手写的折叠箭头与手调字号。
17. **环境抽屉**（§6.8，通用组件）：`？` 按钮打开后能看到摘要（智能体 / 模型 / 强度 / 供应商 /
    工作区 / 基线）与按提示词栈分层的分组；「厂商系统层」与「运行配置」各自标了来源；
    「已调度的工具」与「用过的工具」**不在同一组**；缺失项显示原因而不是空白；
    **组名与顺序来自数据层**（组件里没有硬编码的组名）。
18. 环境抽屉随主抽屉一起消失（**结构保证**：它是 `AgentLogLayout` 的子组件）。
19. **计划清单卡片**（§5.4）：`todo_write` / `update_plan` 的那一轮出现一张面板，标题带 `3/5 完成`
    与本次变化（`+1 完成`），清单逐项带状态（含 `unknown` 不显示成成功）；**同一轮多次更新只画最后一张**，
    更早的收在「本轮另有 N 次更新」里；首次出现默认展开、其后默认收起，展开任一张都能看到整表。
20. **问答卡片**（§5.5）：提问那一轮出现一张卡片，逐问题给出选项（`recommended` 打了「推荐」、
    `multiSelect` 标了「可多选」、`allowOther` 有「其它（自由输入）」行），答案按**选项标签**回填；
    `secret` 的问题默认遮罩。
21. **等待与七态**（§5.5）：没有答案的提问显示「**等待答复中…**」并**在走秒表**，固定区同时出现
    `等待答复 12m`；七种收场各自的文案与样式正确，其中 `unavailable` **不是红色错误**且写明
    「本仓无人应答，是已知边界」；轮次结束而结果没到时显示「结果未采集」而不是一直转圈。
22. **两族卡片都从工具组里提出**（§4.2）：组标题的 `工具调用 × N` 与实际列出的行数**一致**；
    族载荷缺失时该次调用**回退成普通工具行**（不消失、不留空卡片）。
23. `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条全绿；**§10 表里逐行的用例全部到位**
    （**不写死文件个数**——既有新增文件也有改名，写一个数字就会随下一次改动过期；
    判据是「§10 的表与实现逐行对齐」）。

**以下 24–28 是「可重组」验收**（对应 §2.1 的五个场景，逐条给**可判定形式**——
不给形式的验收项等于没验）：

24. **S1 · 内嵌只读视图**：在**不套 `<Drawer>`** 的前提下，用 `AgentLogLayout`（或更低的
    `AgentMessageTimeline`）渲染同一份 `AgentLogModel`，**时间轴与固定区逐字同形**；
    且此时**不存在** `.ant-drawer` 节点。**判据**：`agent-log-drawer.test.tsx` 里有一条
    「同一份模型分别经 `AgentLogDrawer` 与 `AgentLogLayout` 渲染，时间轴区 DOM 逐字一致」。
25. **S2 · 换模型来源**（两半都要验，缺一不可）：
    **(a) 不给数据来源也能跑**：`AgentLogSource` **一个方法都不给**时，抽屉照常打开、时间轴照常渲染，
    只有「环境信息 / 原始输出 / 重试」三处如实降级（「未提供」/ 无入口 / 无重试按钮），
    **不出现崩溃、不出现永远转圈的 `Skeleton`**。
    **(b) 换一份模型照样渲染**：把 `AgentLogModel` 换成**另一份夹具**（不同节点树、不同块类型组合、
    不同 `facts` 数值）后，**组件代码一行不改**即正确渲染——这才是 S2 的核心（可替换性）。
    **判据**：`agent-log-drawer.test.tsx` 里用两份形状不同的夹具各渲染一次，
    断言两份的关键区域（进度条数值 / 轮次数 / 节点树段数）**跟着模型变**，
    且两次渲染之间**没有任何组件源码改动**（`git diff` 为空即通过）。
26. **S3 · 子块独立挂载**：`agent-log/` 下**每一个 L0 件都能在测试里被单独 `render()`**
    ——给定 props 即出画面，不经过 `AgentLogDrawer` / `AgentLogLayout`；
    且**没有一个 L0 件内部存在 `useState`**（§9.0 纪律 2，由 `agent-log-layering.test.ts` 静态钉住）。
27. **S4 · 扩展零改动**：新增一类块 = **不改** `agent-message-timeline.tsx` / `agent-log-layout.tsx` /
    `agent-log-drawer.tsx`（`agent-log-layering.test.ts` 用文件哈希或 import 断言钉住这一点）；
    新增一个工具条动作 = **只传 `actions`**，同样不改上述三个文件。
    外部消费方还能通过 `BlockRendererProvider` 叠加渲染器而**不动默认表**。
28. **S5 · 换交互形态做得出来**：`MessageTimeline` + `BlockRendererProvider` + `ToolbarAction[]` +
    `AgentLogSource` 四个接缝齐全，且**虚拟化的三个入口只在 `base/virtual-list.tsx` 里出现**
    （`agent-log-layering.test.ts` 的 (c) 条）。**本期不验收任何具体的新形态**（§2 非目标）——
    验收的是「接缝在、且层没塌」。

**以下 29–35 是「展示完整性」验收**（对应 D27–D38；
每条都是**界面能说出那句话**的可判定形式）：

29. **谁说的能看出来**（D27 / §6.9）：同一轮里，智能体的正文**不带**角色标签；
    用户消息带「用户」、厂商 system 内容带「系统」且降一档；三者**不再逐字同形**。
30. **实时与补录能分开**（D27 / §6.9）：`source !== 'wire'` 的块带角标
    （`session-file` → 「补录」、`aggregate` → 「汇总」）；**codex 的思考正文（来自会话文件）
    在界面上不再与实时正文长得一样**。
31. **收尾状态不是猜的**（D27 / §6.7）：一次**被中断**的回复——
    光标与扫光**立刻停**，且**不**显示成「还在流」；`buildRenderBlocks` 的入参里没有
    「轮次是否结束」这一信息，故它**不可能**做这个推断（由 `render-blocks.test.ts` 与
    `agent-message-timeline.test.tsx` 钉住）。
32. **「为什么缺」能说出来，且三句话不同**（D28）：工具结果那一格
    ——`toolResult` 能力位存在，§9.7 的 `missingReason` **不再恒为 `null`**；
    界面把「这家结构上不支持」/「厂商有数据但没投送」/「我们还没接」/「没验证过」
    显示成**四句不同的话**；`capabilityNotes` 非空时显示路由/模型前提。
33. **「族认得但没收编」与「不认识」能分开**（D29 / §5.4）：两种情形都回退通用工具行，
    但**文案不同**；`family` 为空才是「不认识」。
34. **子任务一行能看全**（D32 / D33 / §6.3）：占位条与节点详情给得出
    **状态（七档，含「未收场」）· 派发方式 · 结果摘要 · 自己的用量**；
    `statusMissing` 非空时**同时**显示状态与「状态未采集」；
    **一个被强杀的子任务不显示成「运行中」**；`kind: 'row'` 的节点出计数行、
    **不进面包屑也不可点**。
35. **三种「空」分得开**（D38 / §6.1）：① 还没跑过 → `EmptyState`；
    ② 这一类内容没被转发 → 「该子任务的对话未转发」/「运行期只有派发事件与状态」；
    ③ 内容被上限截断 → `contentTruncatedReason` 那句话。**三者互不冒充**。
36. **三处用量数字两两可分**（D39 / §6.11）：顶部事实条（整行累计，正体 `secondary`）、
    轮末里程碑（按轮归属的累计，`Tag`）、消息页脚（单条消息，**斜体** `secondary`）——
    形态、锚点、文案三处都不同；页脚在 `usage === null` 时**一行都不出**。
37. **用量里程碑落在它自己那一轮**（D39 / §6.14）：同一节点里，
    `(会话身份, 该会话自己的轮次号)` 与轮次号对得上才归位；对不上的**不在本节点显示**
    （不回落到最后一轮）；无归属键的 `error` / `warning` 行为与改动前**逐字相同**；
    **子会话节点能看到它自己的用量行**（水位按会话拆开）。
38. **行卡片的两处浮层按判据拆行**（§6.12）：tok 与轮次各有一组三条判据；
    四个否定面（`0` / `null` / 整格缺席 / 分量大于合计）**连浮层都不出现**；
    否定面的断言**等满延迟窗口**再判。

## 12. 本期不做（范围诚实登记）

**本文覆盖 UI 与渲染模型这一段**：

| 段 | 内容 | 归属 |
|---|---|---|
| A. UI 与渲染模型 | `AgentLogModel` / `AgentEnvironment` 等**类型**、`buildRenderBlocks` 纯函数、`buildAgentLogModel`（契约形状 → 界面模型）、全部组件（含通用的 `AgentEnvironmentDrawer`）、页面接线、按钮改名 | **本文** |
| B1. 内容级契约与适配器 | `AgentMessage` / `SubagentRecord` / `RowRecord`（`packages/server/contracts/src/agent-message.ts`）、`messages.jsonl` 的落盘与进程内总线、`/messages`（折叠后的最终视图）与 `/messages/stream`、`useRowMessages` | 数据层（本文按它接线） |
| B2. **厂商事件的投影覆盖面** | 三家适配器把 `message` / 子任务的每次投递都投影出来——**当前只覆盖一部分**：夹具画得出来的形态（`task` 清单载荷、`ask-user` 问答、完整子任务轨迹、附件、`unrecognized`）要等适配器把它们写进 `messages.jsonl` 才在真实数据里可见 | 适配器（**不在本文**） |

### 12.1 B2 未落地时的界面表现（如实登记）

**抽屉会显示「还没有日志 · 这一行还没开始执行」，而这一行明明跑过**——因为时间轴吃的是
`messages.jsonl`，那一格里没有内容。此时：

- **原始事件仍在**：固定区的「原始输出」逐字可查（它是行级事件流，与记录流是两条来源），
  排障路径不受影响；
- **不是缺陷**：它是 B2 的覆盖面问题，README 的排障表有对应一行；
- **夹具预览页（`/dev/agent-log`）画得出来**：夹具走的是与真实数据**同一条链路**
  （记录 → `buildAgentLogModel` → `buildRenderBlocks` → 上屏），故「画不出来」只可能是
  那家适配器还没投影，不可能是界面缺了一类块。

### 12.2 分段对两处可得性的影响

**厂商侧那两组（系统提示词、已调度的工具）**
**依赖适配器从厂商 `system` init 行里提取**。拿到之前，环境抽屉能显示的是
「项目侧配置」那两组（本仓自己下发的），厂商侧会**如实显示成缺失 + 原因**
（`not-exposed` / `unverified`）——**这是正确行为，不是没做完**：四态口径要的正是
「拿不到就说拿不到」，而不是先渲染一个空面板。

### 12.3 逐族可得性

**逐族登记，避免把「没开开关」读成「卡片坏了」**：

| 族 | A 段（夹具喂 UI） | B 段落地前，真实数据下的样子 |
|---|---|---|
| `task` | ✅ 卡片结构、计数/变化摘要、折叠、同轮多次、`owner`/依赖四态全可验 | **dsh 有数据**（`todo_write` 是它 24 个工具之一）；codex 要开 `tools.update_plan.enabled`；claude 要开 `CLAUDE_CODE_ENABLE_TODO_TOOLS`——**没开就没有这一族**（是「没采到」，不是卡片坏了；v2 spec §7.6.2.1b） |
| `ask-user` | ✅ 七态 + 等待态 + 答案回填全可验 | 本仓 `approvalPolicy: 'never'` 且未开应答面 ⇒ dsh 的 `ask_user_question` **会以 `unavailable` 报错**（v2 spec §7.6.2 ⑩ 硬约束 2：报错而不是降级）。**这是已知边界**，卡片上如实写明（§5.5） |

### 12.4 其余 8 族不做专门渲染

**其余 8 族本期不做专门渲染**（走通用工具行）。这不影响规范 §7.6.4 的
「UI 只按 `family` 分支」——两族是**族驱动**的（不认厂商、不认 `args`/`result` 半边），
收编下一族时只加一个 `ToolFamilyPayload` arm 与一个 `RenderBlock` 分支（§4.1 扩展性第 5 条）。

### 12.5 对 B 段提出的六处接口要求

**数据层重构时按这些约束对齐**：
§4.1 的**五条**边界纪律与评估表、§4.3 的环境信息模型与两组固定构成、
§5.2 的行级事件去向表、§5.3 的三条所有者划分、§5.4 / §5.5 的两族卡片载荷与降级口径、
§7.1(c) 的更新频率上界。

### 12.6 三条明确不做的根因（带理由与代价）

> 这三条是**明确不做**（不是遗漏）——它是**范围**。**每条都写出代价**，免得被读成「已经支持了」。

| # | 不做什么 | 理由 | **代价（如实写）** |
|---|---|---|---|
| 1 | **`structured`（工具结果的结构化结果）不进 UI** | 规范要求「有 `meta` 就不要退回去解析文本」，而本设计只有等宽原文；本期不渲染任何族的结构化结果 ⇒ 收编一族专门卡片时再按需加逃生格（与 §4.1 扩展性第 5 条同一条路） | `read` 的行数、`grep` 的命中数这类**已解析过的事实**，界面上只能读原文自己认 |
| 2 | **`usage.total` / `apiMs` / `ttftMs` / 派生指标不进 UI** | 规范明文「适配器**不预先算比率**」；本设计不做这几格 ⇒ 界面也没有它们的落点 | ① 厂商自报总量与归一值不一致时**无可对照**；② **时间观感只有墙钟一种** |
| 3 | **图片缩略图不加载** | 加载远程资源牵出鉴权 / 体积 / CSP 三件事，不属于数据结构这一轮（§6.10 已给呈现口径：类型 + 路径 + MIME） | 图片附件只显示路径与 MIME，**看不到内容** |

**另有两条同类的不做**（散在对应小节，此处汇总以免漏读）：
**附件不进 `userPrompt`**（它是纯文本，§6.10）；
**工具结果里的附件不出承载**（规范说 claude 的图片可出现在工具结果里，但本仓工具结果以文本为主，等真有截图需求再加，§6.10）。

### 12.7 另有五项明确不做

- **UI 侧不读厂商会话文件**（rollout / `rollout-*.jsonl`）——它是**数据层**的取数通道之一
  （v3 §3.2 / §3.3：codex 的思考正文与子任务轨迹来自会话文件），到 UI 手上的形式是
  `source: 'session-file'` 的**块**（§6.9 给它标「补录」角标）。
  ⇒ 这里「不做」的是**UI 直接去读文件**，不是「不用会话文件的数据」（会话文件**是**消息来源之一）。
- 不做抽屉内的全文搜索（轮次跳转器 + 过滤已覆盖「能不能找到」）；
- 不做轮次级「折叠全部 / 展开全部」批量开关（D7 选了「事实内容开箱即见」，
  批量折叠与它相冲）；
- 不做抽屉之外的「正在等待答复」提示（行卡片 / 列表页的状态标记）：本期只在抽屉内如实显示
  （§5.5 的固定区徽标 + 卡片计时）。跨页面提示要动列表页与行卡片的 state，是另一件事；
- **不做「就地在卡片里回答提问」**：本仓没有应答面（`approvalPolicy: 'never'`），
  而做一个只在本机可用的回答框会让「评测里的提问为什么没人答」这件事更难解释。
  卡片是**只读的复盘视图**，这一点在 §5.5 的文案里写明。

### 12.8 S5 的另一半：不交付成品界面

**不交付任何「非抽屉形态」的成品界面**。
D24 的分层让对话式 UI / 实时监控台**做得出来**（§2.1 S5 / §11 验收 28），
但只落一个真实场景需要的预设（`AgentLogDrawer`）。
**把「可重组」读成「已经做了五个界面」是最可能的误读**——
它交付的是**接缝**，不是界面。真要第二个形态时，那是独立的一次需求，
按同一套分层组装即可（`MessageTimeline` + `ToolbarAction[]` + `AgentLogSource` 都现成）。

### 12.9 影响展示的配置开关（逐条登记）

（补齐只登记两族的缺口。）
以下开关**关掉时界面会缺东西**，登记在此 —— 否则第一个排查的人会以为功能坏了：

| 配置 | 关掉/不满足时的界面表现 | 界面必须说的话 |
|---|---|---|
| claude `includePartialMessages` | 无流式增量 ⇒ §6.7 五处动效全不出现 | 由 `streamingDelta` 能力位承担（D28）：显示「这家不产出流式增量」而不是干等着 |
| claude `canUseTool` 未注册 | `AskUserQuestion` 不在工具表 ⇒ **连卡片都没有** | 「本行未注册交互回调，提问工具不可用」——**不是**「这次没提问」 |
| claude 自动放行模式 | 提问**被静默跳过** ⇒ 既非 `unavailable` 也非 `rejected` | 同上；这是规范 §8.2 明列的「必须规避」 |
| codex `features.multi_agent` | 子任务面恒空 ⇒ 面包屑与占位条都不出现 | 由 `subagent` 能力位 + `capabilityNotes` 承担：「本行多智能体未启用 / 该路由拒绝命名空间工具」——**不是**「没派子任务」 |
| codex 受限路由上开多智能体 | `unsupported call` / 整轮被拒 | 同上一行（**能力随路由翻转**，故必须带前提） |
| dsh 联网三键 + 凭据 | web 族「看似可用」或必失败 | 「未启用联网」/「联网不可用」——规范 §7.4 明禁显示成「三家都没搜」 |
| codex 近似条目计数 | `round` / `turns` **系统性偏高** | **已处置**：`round` / `turns` 的口径是「**同一份口径下的同源同值**」，跨家对比时按 `source` 标注（D1 / §11 验收 8 / D27）。**不要再写成「跨三家可比」**——规范逐字要求「不要把某家偏高的近似值当成另一家的等价物」 |

## 13. 风险

| 风险 | 处置 |
|---|---|
| 嵌套折叠面板变高变矮后滚动位置跳 | 用 **`Listy`（不传 `itemHeight`）** 的逐项测量（D9 / §7.2）；真实浏览器冒烟第 2 项专门验它 |
| `buildRenderBlocks` 被写回「先全建再渲染」 | §7.2 的对照块明文禁止；`已渲染 N / 共 M 轮` 是它的可见护栏 |
| `callId` 配不上时静默丢弃 tool-result | 契约里 `ToolItem.callId` 可空、配不上降级成独立条目；§10 有专门用例与变异体 (a) |
| 重写时把 `Listy` 换回自建窗口化 | §7.2 明文：**不自己写窗口化**（jsdom 验不出「展开面板后下方轮次滚动位置跳」）；真实浏览器冒烟第 2 项专门验它 |
| 子任务内容按需取，但缓存无淘汰 | §7.4 记了护栏与「不修在 ui 包」的边界 |
| **数据层仍按「一帧一次提交」对外，流式一开就卡** | §7.1(c) 以**要求**的形式提出（不指定实现，故重构后不过期）；真实浏览器冒烟第 6 项验它 |
| **UI 契约被传输层污染**（有人把 `seq` / `chunk` / 取数回调加回模型） | §4.1 的五条边界纪律逐条写明「不许有什么」，并在 §4.1 评估表里记了每条被删属性的理由——下一个人加回来之前会先看到理由 |
| 折叠态用数组下标键控，追加一轮后「自己合上了」 | §6.1 要求用 `ContentBlockBase.id` / `callId` 键控；§10 变异体 (e) 专验这一条 |
| `running` 被写成「有没有 `output`」的推断，「结果未采集」被显示成「正在跑」 | §4.2 明文要求 `running` 由数据层按「所在轮次是否结束」给出；变异体 (f) |
| 面包屑状态不写 URL，刷新回主会话 | §6.2 定为有意取舍（子任务无独立路由，服务端无法恢复该状态） |
| **环境信息被塞进主模型，每次流式提交都搬几十 KB** | §4.3 明文：它是独立的 `Loadable`，由页面按需取；理由是体积与时机两条 |
| **「已调度的工具」与「用过的工具」被混成一组**，读成「它用了 30 个工具」 | §4.3 要求分列并标 `source: 'observed'`；§10 变异体 (g) |
| 主抽屉关掉而环境抽屉残留在屏幕上 | **结构上不可能**（环境抽屉是 `AgentLogLayout` 的子组件，随主抽屉一起卸载，§6.8 约束 1）；`agent-environment-drawer.test.tsx` 仍钉一条防回归——**不需要**页面接线守卫 |
| A/B 分段让「真实数据下不可见」被误判成缺陷 | §12 明文登记，并在 README 的排障表补一句 |
| **反复进出子任务节点后内存持续增长**（已访问节点的内容留在数据层缓存里，而本设计**不做淘汰**） | §7.4 写了处置门槛，且**已进 §10 冒烟清单第 7 项**（否则门槛等于没写）：先量再改，落点是**数据层的按节点保留上限**；`LogNode.contentTruncatedReason` 是为它预留的出口，UI 只需如实显示那句话。**不是**在 `ui` 包里加淘汰 |
| 改「查看日志」文案时漏掉既有断言 | §8.1 逐文件列出，含两处测试与三处注释 |
| **无人值守下 `ask-user` 会无界挂起**（dsh 逐字：无 `timeout-policy` 预算，只能靠轮次的 signal） | 卡片把「等待答复」画成**独立于七态的一格** + 走秒表 + 固定区徽标（§5.5，D21/D23）。本仓**不能自己收场**，故如实显示等待时长，而不是假装成 `timeout` |
| 「还在等」被显示成某个已收场的态（或反过来，一次没采到的结果被永远读成「还在等」） | `AskUserPending` / `AskUserSettled` 是判别联合：`answers 非空 + outcome === null + running === false` 这个矛盾组合**写不出来**（D35）；§10 变异体 (j) 专验 |
| **`AskUserAnswer.selected` 按 id / 下标匹配**：答案看起来有、其实错位 | §5.5 第 1 条口径（按 `label` 匹配）+ §10 变异体 (i)；这是最难发现的一类错 |
| claude 的 `TaskStep.id` 来源未定（v2 spec §11.1 第 27 项）⇒ 依赖与 `owner` 落空 | `id === null` 时**不画 id 与依赖**、`owner === null` 时整格不显示（§5.4）。**不自己发号**；缺口闭合后 UI 无需改动 |
| 计划清单在多轮里重复出现（跨轮不去重） | 首次展开、其后**默认收起且标题带 `3/5 完成 · +1 完成`**（§5.4 规则 4）；去重要跨轮状态，与 §7.2 的按项渲染相冲 |
| `secret` 的遮罩被当脱敏 | §5.5 如实登记：遮罩只是**显示口径**，原文仍在结果与事件台账里（「下载台账」拿得到） |
| 族载荷缺失（B 段未落地 / 适配器不认识）被当成缺陷 | 回退通用工具行是**设计内的降级**（v2 spec §7.6.0：规范化是可选增收）；§10 有一条专测，§12 有逐族登记 |
| 同一份「任务清单」被画两次（一次 `task` 卡片、一次 `unrecognized` 块） | §5.4 的边界：判据是**族载荷在不在**，不是在不在 `vendorType` 里；一族认出来就只走一条路 |
| **分层被绕过：新代码直接 import 上层** | §9.0 的三条纪律 + `agent-log-layering.test.ts` 的静态扫描（a–c）；**逐条配变异体 (n)–(r)**。这一条的风险不是"画错了"而是"层塌了"——塌掉后既有的行为守卫**可能全绿**，所以必须有一条专测分层的守卫 |
| **注册表被当成第二份真值**：有人把默认表复制一份到调用方再改 | §9.3 的 `BlockRendererProvider` 明确是**叠加**语义（`默认表 ⊕ Provider`），且 `DEFAULT_BLOCK_RENDERERS` 是**唯一**的默认真值；变异体 (o) 专验「覆盖成整体替换后默认臂必须还在」 |
| **L0 偷偷持态** | §9.0 纪律 2 要求全部受控，`agent-log-layering.test.ts` 的 (d) 条**静态**禁止 L0/L1 出现 `useState`。这条之所以要静态钉：自己持态的折叠件在**当前**用法下表现完全正常，只有在被挂第二个实例时才暴露（而那时已经晚了） |

---

## 14. 未闭合项（现行现状）

以下是**当前实现里仍然成立**的口子：

- `AgentLogModel.activeNodeId` 既是输入字段、又被注释成「UI 内部 state」（§4.1 vs §6.2）。
- `EnvGroup.source` 是闭集四值（`user` / `vendor` / `project` / `observed`）——加一层要改组件。
- 组件文案里写死了本仓的 `approvalPolicy` 与 dsh（`ask-user` 的 `unavailable` 原因位已由 §5.5 的 `outcome` 与结果原文承担）。
- `TaskPanel` 与规范同名不同形状（规范里没有 `WorkItem`；`SubagentRecord.source` 是另一件事，已由 `SessionNode.source` 承担）。
- `ask-user` 的 `recommended` 置顶被本设计推翻，但 §8.2 的对照表未登记（规范 §7.6.4 的 `ask-user` 行 vs 本文 §5.5）。
- claude 的 `Task*` 已是默认工具、开关已注入，而 §12.3 仍写「没开就没有这一族」。
- `specVersion` 与规范「不做版本分流」是两个版本轴，需要一句区分。
- `AgentLogModel.facts`（行级）与 `LogNode.sessionFacts`（会话级）是两层不同的东西。本期的取值是：**主会话节点的 `sessionFacts` 为 `null`**，行级事实一律读 `AgentLogModel.facts`（不存第二份）。

清单与建议改法在 `docs/superpowers/notes/2026-10-01-exec-log-drawer-design-generality-review.md`。