# 《执行日志抽屉重设计》内容基线清单（重写后逐条核对用）

- **源文档**：`docs/superpowers/specs/2026-09-30-exec-log-drawer-redesign-design.md`
- **源文档规模**：2727 行 / 236,841 字节（本次以 `read` 工具分批读到末行，非摘要、非抽样）
- **本清单性质**：**穷尽式基线**。不做概括、不做同类项合并——概括即丢信息，而丢掉的恰好是之后核对不出来的部分。
- **用途**：重写/改版该 spec 后，逐条比对「信息是否丢失」。
- **判据**：只有这份文档本身。全程**未读**任何 `.ts` / `.tsx` / 其它 spec / 代码（用户口径：代码正在重构，不是判据）。
- **节号约定**：本清单中的 `§N` 一律指**源文档自己的小节号**（不是 v2/v3 spec 的节号）；凡指外部文档处会显式写「v2 spec §x」或「v3」。
- 源文档内置的四轮修订：① 2026-10-01 P0 五条（§8.1）；② 2026-10-02 组件分层与重组（§8.4，D24–D26）；③ 2026-10-02 第二轮数据结构对齐规范（§8.5，D27–D38）；④ 基线口径此后对齐 `2026-10-01-agent-message-spec-design-v3.md`。

**条目数速览**（详见各节）：

| 类 | 条目数 |
|---|---|
| 1 决策表 D1–D38 | **38**（D1–D26 一表 26 行 + D27–D38 一表 12 行） |
| 2 契约类型 | **52** 个 `export type` / `export interface` + **5** 个 `export function` / `export const` = **57** 个具名导出；另有 **5** 个**被引用但未定义**的名字（见附录 C）+ **24** 条「删 / 移出 / 改判」登记（§2.8） |
| 3 数值参数 | **127** 条（含 24 条「文案里的示例数字」、8 条动效时长、11 条性能/频率） |
| 4 §11 验收标准 | **35** 条（1–23 / 24–28 / 29–35） |
| 5 变异体验证 | **24** 条（(a)–(x)：(a)–(m) 13 + (n)–(r) 5 + (s)–(x) 6） |
| 6 §10 测试计划 | **28** 个文件行（主表 21 + 第二轮 7）+ **6** 项真实浏览器冒烟（标题误写「五项」） |
| 7 界面结构描述 | §5 三区结构图 1 张（14 行内容）+ §5.1–§5.5 / §6.1–§6.10 / §9.0 / §9.5 / §9.6 的规则条目 **≈150 条**（含 **15** 张表），逐条抄录 |
| 8 §12 范围登记 | A/B 分段 **2** 段 + **3** 条代价说明 + 逐族 **2** 行 + 六处接口要求 + **5** 项不做 + 配置开关表 **7** 行 + S5 一条 + 三条根因 + 未覆盖 P1/P2 清单 |
| 9 §13 风险表 | **26** 行 |
| 10 「有意不显示 / 不进 UI」 | **53** 项（契约层 28 + 界面层 16 + 行为层 9） |
| 11 §8.2 对外部文档修订 | **14** 行 |
| 12 交叉引用热点 | **611** 处 `§` 引用；前十名排行 + **14** 个「非跳不可」实例 + **8** 个「一句话被四轮修订改过」的高危点 |
| 附录 A | 矛盾/写漏 **16（A 类）+ 11（B 类）+ 6（C 类）+ 5（D 类） = 38** 条 |

---

## 1. 决策表 D1–D38

### 1.1 D1–D26（源文档 §3 第一张表）

| # | 决策名 | 取值（留全） | 理由摘要 |
|---|---|---|---|
| D1 | 「一轮」的定义 | **模型一次 API 往返 = 一轮**（＝ `usage.turns` 口径；**不是** `message.turn`——后者三家语义不同、明文禁止用于分组）。**⚠️ 2026-10-02 更正**：口径由「跨三家可比」改为「**同口径可比**」，且 `round` / `turns` 必须带来源标注（D27） | 同一份口径下的轮次；规范逐字「跨家比较前必须确认口径」，codex 近似计数**系统性偏高** |
| D2 | 块内正文渲染 | **按块类型分派**：只有 `text` 块走 markdown；其余（thinking / tool 参数 / tool 结果 / attachment）一律**等宽原文** | 推理摘要与命令输出不是 markdown |
| D3 | 行级事实的安置 | **顶部固定不可折叠的进度条** + 下方**纯轮次时间轴** | 那些事实是「关于这一行」的，不是智能体说的话 |
| D4 | 面包屑作用域 | **只看该节点自己的消息**；后代以「子任务」占位条出现；**用户提示词作为首条消息**（主会话是与用户的往来、子任务是父派给它的指令） | 「这句话是谁说的」不能有歧义 |
| D5 | 合并粒度 | 先按 `callId` **配对「调用+结果」**成一个工具条目，再把这些条目里**连续的**合进一个面板；`callId` 缺失/配不上时**降级成独立条目，不编造关联** | dsh 的调用与结果是两条独立事件 |
| D6 | 面包屑「级联菜单」 | 每段下拉 = **该层级的兄弟列表**，当前项打勾 | 祖先链由面包屑表达，菜单只负责「跳到同层另一个」 |
| D7 | 长跑处理 | **全渲染 + 轮次跳转器 + 过滤**（**不做**「默认折叠轮次」） | 「每轮的事实内容」必须开箱即见 |
| D8 | 下载口径 | **拆成两件事**：下载 = 原始事件台账（`formatEventLog`），**不再要求与抽屉逐字一致** | 时间轴与台账本来就不是一种东西 |
| D9 | 虚拟滚动 | **`@rc-component/virtual-list`**（antd 6 的虚拟化底座，已在依赖树里） | 嵌套折叠面板的动态高度补偿 |
| D10 | 工具面板形态 | **整宽折叠面板**（组头 + 组内工具行） | 视觉对比页确认 |
| D11 | 轮次容器 | **扁平 + 左槽标记**（`轮次 N` 与时间挂左侧竖槽） | 密度高于卡片 |
| D12 | 工具行默认态 | **全部收起**（第一级展开后只是一行行摘要，点某行才出完整命令/参数/结果） | 一级折叠给扫读，二级折叠给细读 |
| D13 | 流式滚动 | **「跟随最新」**：默认开，新事件带视口到底；用户一上翻即自动关，角落浮出「回到最新」 | 替代原「自动滚底」手工开关 |
| D14 | `log` 事件去处 | 时间轴**不混入**；固定区给一个「原始输出 N 条」入口，展开看原文 | 原始负载必须可查，但不能与消息争夺注意力 |
| D15 | 工具名显示 | **原样透传**（`Bash` / `apply_patch` / `pwsh` / `spawn_agent`），不做统一改名 | v2 spec §7.3 明文禁改名 |
| D16 | **接口优化的原则** | **按最优形状定模型，不迁就现状、不粘传输层**：`seq` / SSE / `chunk` / 两源合并 / 取数时机 / 大小上限判断**全部不进 UI 契约**；会自己随时间变的量（耗时）不进契约；存储用**扁平数组 + `parentId`**，不建嵌套树 | 优先 UI 设计，并评估每项属性的合理性与扩展性 |
| D17 | 环境信息的口径 | **按提示词栈的层分组、各自标来源**（用户层 / 厂商系统层 / 运行配置 / 实测统计），缺失项给 `MissingReason`。**不做假等价的合并** | 合起来回答不了「这条要求是谁下发的」 |
| D18 | 「通用」的落点 | **`agent-log` 本身就是那个通用组件**（`AgentLogView` 吃 `AgentLogModel` + `AgentEnvironment`，不认「评测行」这个业务概念）；环境抽屉是它**内部**的一块（`agent-log/agent-environment-drawer.tsx`），**不提为并列组件** | 需求方口径修正（2026-09-30） |
| D19 | 用户提示词的命名与位置 | 概念上叫**用户提示词**（角色视角），**不叫**「考题提示词」（业务视角）；**只在消息时间轴的首条出现，环境抽屉里不重复列** | 对它说话的是使用者，不是「考题」 |
| D20 | `task` 卡片的形态与位置 | **状态化清单面板**落到轮次时间轴上：**从工具组里提出、原地成卡并切断合并链**；**同一轮只画最后一次**调用（更早的收进面板底部）；**跨轮不去重**，首次展开、其后收起且标题带变化摘要 | 去重需跨轮状态，与 §7.2 的「按项渲染 + 虚拟列表乱序挂载」相冲 |
| D21 | `ask-user` 卡片的形态 | **问答卡片**：逐问题渲染选项（`recommended` 打标、`multiSelect` 标注、`allowOther` 追加自由输入行）+ 答案回填 + **七种收场**；**`outcome: null`（还没收场）是独立于七态的一格**，默认展开并显示已等待时长 | 无人值守评测里最需要一眼看出「它卡在等人回答」 |
| D22 | 族数据的落点与形状 | **只挂 `tool-call` 块**，且**只给「本次调用后的归一结果」**（清单 / 问答）；**不把 `args` / `result` 两半暴露给 UI**；`commitModel` 与 v2 的 `TaskListArgs` 空壳**不进 UI 契约** | `tool-call` 是唯一必然存在的那一块 |
| D23 | 「等待输入」的可见性 | 卡片标题上的等待时长 **+** 固定区一个**只在真的在等时出现**的 `等待答复 12m`（**派生**：不新增 `facts` 字段，也不进 `rowEvents`） | 「这一行为什么不动了」是长跑评测里最该一眼看出的 |
| D24 | **组件的分层与状态归属** | **三层**：**L0 纯渲染件**（无 state、无取数、无业务概念）/ **L1 受控组合件**（吃 `turns` + `renderBlock` 分派，**自己不持有折叠态**）/ **L2 场景预设**（`useAgentLogView` + `AgentLogLayout` + `AgentLogDrawer`）。**四份视图态抽成一个 headless hook**；**虚拟列表降为 L2 的一个预设**，不是 L1 的默认行为 | 需求方 2026-10-02 口径：拆成多个子组件、便于重组、组件之间用事件交互（＝回调 props，§9.1）。§2.1 的五个场景是**唯一判据** |
| D25 | **块渲染是注册表，不是 switch** | `RenderBlock` 的**七个臂**改成 **`kind → 渲染器` 的注册表**：默认项随组件走，调用方可用 `BlockRendererProvider` **追加或覆盖**，用 `assertNever` 守住**默认集**的穷尽性 | 满足「新增块类型不改已有文件」（§2.1 S4）；**判别联合管类型、注册表管分派** |
| D26 | **工具条是动作数组，不是六个硬编码控件** | 默认动作集（**下载台账 / 跟随最新 / 跳到轮次 / 只看工具调用 / 只看错误 / 原始输出 / 环境信息**）内聚成 `AgentLogToolbarPreset`；`AgentLogLayout` 只吃 `actions: readonly ToolbarAction[]`，调用方可换集、可追加 | 「六个动作是一套预设」，不是「工具条只会这六个」 |

### 1.2 D27–D38（源文档 §3 第二张表；2026-10-02 第二轮「数据结构对齐规范」）

> 起因：四方并行评审（信封/内容块、工具族/面板、计量/能力/子任务、缺失矩阵/配置面），约 63 项缺口归并为 6 个根因；本轮修**必须修的 12 条**。判据是 v3 规范正文、**不参考任何实现代码**。这十二条**只补展示所需的数据结构与文案落点，不改 §5 / §6 的界面形态**。

| # | 决策名 | 取值（留全） | 理由摘要 |
|---|---|---|---|
| D27 | **消息信封的三格必须摊到块上** | `ContentBlockBase` 补 `role` / `source` / `assembly`；`LogTurn` 补 `running` | 初版只摊了 `messageId` / `subagentId`，把另外三个丢掉了；§6.7 的流式动效全靠 `assembly` |
| D28 | **能力声明是「维度注册表」，不是两个定字段** | `MessageCapability` 用**可变键** + `CapabilityDecl`（`{ level, source, reason }` 三元组）+ `capabilityNotes` | ① 初版只有 `thinkingText` / `subagent` 两格，缺 `toolInput` / `toolResult` / `streamingDelta`；② **`toolResult` 那一格缺得最要紧**——`AgentRunStateTagProps.missingReason` 注释写着「`capability` 给」，而契约里没有这一格 ⇒ 该参数**恒为 `null`**；③ 三元组绑死排除「有等级没原因」；④ 加维度不必改契约 |
| D29 | **族名与「有没有专门卡片」是两件事** | `ToolCallBlock` / `ToolItem` 补 `family: ToolFamily \| null`；`tool` 只表示「本期收没收编专门卡片」 | 初版把「适配器不认识这个工具」与「它有族、只是不在本期两族里」压成同一个 `null`；而纪律 5 逐字要求「**只按 `family` 分支**」 |
| D30 | **截断是「已知 / 未知」两态，不是布尔** | `ToolResultBlock.truncated` → `truncation: TruncationState`；`ToolItem.output` 同步 | 规范明写「拿不到截断标记只能记 `false`，但**消费方不得据此断定输出完整**」 |
| D31 | **附件本体与「不认识的原样载荷」拆成两个类型** | 新增 `UnrecognizedPayloadBlock`（兜底原文）；`AttachmentBlock` 归还给**真实附件**（`attachmentKind` / `path` / `mimeType`）；`RenderBlock` 相应加一臂 | 初版借用了规范的名字去装「不认识的厂商载荷」，两者**语义正交**，而对照表还标着「一致」；后果是**图片与文件附件没有任何展示路径** |
| D32 | **`LogNode` 按形态判别联合** | `SessionNode`（`main` / `subagent` 共用）\| `RowNode`；新增 `SessionFacts`；`RowNode.counts` 补计数格；`RenderBlock` 加 `row-summary` 臂 | 初版扁平接口让两种形态的格互相为 `null`；顺带闭合三条已登记 P1（`facts` 关系、`kind: 'row'` 无出口、`subagentId` 无消费者） |
| D33 | **子任务行补齐规范要求的列** | `SessionNode` 补 `source` / `dispatchKind` / `usage` / `outcome` / `statusMissing`；`LogNodeStatus` 补 **`stopped`** 与 **`unsettled`**（未收场） | 规范的面板②是「每个子任务一行」；**强杀时收场事件永不到达**，没有「未收场」这一档，已死的子任务会永远显示「运行中」；`statusMissing` 与 `status` 必须分开记 |
| D34 | **`RowEvent` 补 `warning` 档** | `level: 'milestone' \| 'error' \| 'warning'`；§5.2 去向表加「消息层非致命告警」一行 | codex 的 item 级 `error` 是**非致命告警**（规范逐字「不得当成运行失败」），初版既不是块、也不在那张表里 |
| D35 | **`AskUserInteraction` 按收场形态判别联合** | `AskUserPending`（`state: 'pending'` + `running`）\| `AskUserSettled`（`state: 'settled'` + `outcome` + `answers`） | 初版三个并列可空字段允许 `answers 非空 + outcome === null + running === false`，按 §5.5 判据渲染成「结果未采集」**而答案就在手上** |
| D36 | **`TaskPanel.counts` 补 `unknown` 第四格** | `{ pending, inProgress, completed, unknown }` | 规范说 `unknown`「是第四种**显示值**，面板必须能显示」；初版三格时标题的 `3/5 完成` **分母必错**（三数之和 ≠ 项数），而 §5.4 又规定「UI 不自己算」 |
| D37 | **`AgentLogDiagnostics.lines[]` 补 `summary`** | `summary: string \| null`；有值时**优先渲染**，`text` 原文**仍逐字给出** | 规范逐字：`log.summary` 无则省略，**消费方不得拿 `text` 顶替** |
| D38 | **「有内容但这一类没被转发」是第三种空** | §6.1 补**两档**如实说明（「运行期只有派发事件与状态」/「该子任务的对话未转发」） | 规范 §7.1 逐字要求 claude 未开 `forwardSubagentText` 时**如实说明「该子任务的对话未转发」**；初版只有 `empty` / loading / error 三档 |

**D24 与 D18 的关系（源文档明写）**：D18 说「`agent-log` 整体才是那个通用件」，D24 **不推翻它**——通用性仍由整个目录承担，只是目录内部从「九个平铺件」变成「三层 + 一个注册表」。D18 反对的是把环境抽屉提为**并列组件**，这条依旧成立（§6.8 约束 1 不变）。

---

## 2. 契约类型清单（逐个类型 + 逐字段）

> 全部来自 §4.1 / §4.2 / §4.3 / §4.4 / §5.3.1 / §9.1 / §9.2 / §9.3 / §9.4 / §9.7 的代码块与紧邻说明。
> 标注「（未定义）」的是**文档引用但全文没有给出定义**的名字——重写时必须补或必须继续承认这个洞。

### 2.1 `@aieval/contracts` 主模型（§4.1）

**`AgentLogModel`**（`export interface`）— 抽屉渲染的输入模型（UI 的全部输入），`specVersion` 值为字面量 `1`
| 字段 | 形状 / 说明 |
|---|---|
| `specVersion` | `1`（契约版本；UI 据此判断来的是不是它认识的那一版） |
| `facts` | `AgentLogFacts`（只读，不含任何会自己走的数） |
| `nodes` | `readonly LogNode[]`（会话树**扁平**存储：主会话 + 所有后代子任务） |
| `activeNodeId` | `string`（当前视图／面包屑选中的节点；注释写「UI 内部 state，默认取 `kind === 'main'` 的那个」） |
| `rowEvents` | `readonly RowEvent[]`（行级事件在时间轴上的条目，见 §5.2） |
| `empty` | `boolean`（全无内容＝还没跑过：决定显示空态，而不是空时间轴） |

**`AgentLogFacts`**（`export interface`）— 行级事实，逐条按「界面是否真的需要」定
| 字段 | 形状 / 说明 |
|---|---|
| `status` | `{ tone: 'pending' \| 'running' \| 'ok' \| 'failed' \| 'canceled'; label: string }`；`tone` 是界面词汇（决定徽标色，`running` 还决定 `Badge status="processing"` 动效，§6.7）；`label` 是数据层给的文案（评测侧传 `ROW_STATUS_LABELS[status]`） |
| `startedAt` | `string \| null`（耗时由 UI 用现成的 `useNow(active)` 本地走秒表算） |
| `endedAt` | `string \| null`（null = 还在跑；终态耗时 = `endedAt − startedAt`） |
| `turns` | `{ current: number; total: number \| null }`（`total` 为 null = 还没跑完，**不是**「一共就这么多」） |
| `tokens` | `{ input: number; cached: number; output: number } \| null`（三格各自可缺；整格为 null = 这一家根本不报，claude-code 只报 turns） |
| `thinking` | `{ tokens: number; basis: 'subset-of-output' \| 'additive' \| 'unknown' } \| null`（思考/推理 token 的**结算值**与**可加性**；null = 拿不到，**不写 0**；「报了且是 0」是 `{ tokens: 0, … }`） |
| `domain` | `readonly DomainFact[]`（**领域事实**，数据驱动；评测侧放「改动摘要」与「评分」两格；通用消费方给空数组） |
| `error` | `{ code: string \| null; message: string } \| null`（`code` 允许为 null） |
| `exitReason` | `string \| null` |

**`DomainFact`**（`export interface`）— 一条领域事实（`facts.domain` 的元素）
| 字段 | 形状 / 说明 |
|---|---|
| `id` | `string` |
| `label` | `string`（格名，如「改动」「评分」，由数据层给） |
| `value` | `string`（一行值，如 `+12 −3` / `8/10`） |
| `tone?` | `'default' \| 'success' \| 'warning' \| 'error'` |
| `hint?` | `string`（补充说明；评分那一格放「尺子」= `judgeAgentKind` + `judgeModelId` + 一句话总评） |

**`LogNode`**（`export type`）= `SessionNode | RowNode`（按节点形态的判别联合）

**`LogNodeBase`**（`export interface`）— 两张节点形态共有的格
| 字段 | 形状 / 说明 |
|---|---|
| `id` | `string`（稳定键：折叠态／面包屑／虚拟列表 key 都挂在它上面，**不用数组下标**） |
| `parentId` | `string \| null` |
| `spawnedBy` | `{ messageId: string; callId: string \| null; at: string } \| null`（**派发点**；主会话节点为 `null`） |
| `status` | `LogNodeStatus`（永远给一个**可渲染的值**，采不到就是 `'unknown'`） |
| `statusMissing` | `MissingReason \| null`（说明**为什么采不到**；规范「不得用 `status: null` 表示未采集」） |
| `startedAt` | `string \| null` |
| `endedAt` | `string \| null` |
| `content` | `Loadable<readonly LogTurn[]>`（**按值给，不是取数回调**） |
| `contentTruncatedReason` | `string \| null`（内容被上限截断时给一句人话，如「只保留了最近 N 轮」；null = 完整） |
| `capability` | `MessageCapability`（维度名由数据层给） |
| `capabilityNotes` | `readonly string[]`（能力成立的**前提**：路由／模型／开关；空数组 = 无条件成立） |

**`SessionNode`**（`export interface extends LogNodeBase`）— 会话节点：主会话与子任务**共用同一份形状**
| 字段 | 形状 / 说明 |
|---|---|
| `kind` | `'main' \| 'subagent'` |
| `source` | `MessageSource`（`aggregate` = 厂商只给汇总、没有逐条身份） |
| `subagentId` | `string \| null`（主会话为 `null`；**任务名兜底用它前 8 位**，§6.3） |
| `vendorId` | `string \| null`（厂商侧身份 id；只在块的详情里可选显示） |
| `dispatchKind` | `string \| null`（`subagent` / `subagent_fork` / `Task` / `spawn_agent` …；**与 `kind` 不是一回事**） |
| `name` | `string \| null`（任务名；claude 聚合形态只给计数） |
| `nameMissing` | `MissingReason \| null` |
| `userPrompt` | `{ text: string; at: string } \| null`（该节点首条消息＝用户提示词） |
| `usage` | `AgentLogFacts['tokens']`（子任务自己的往返用量；**主会话为 `null`**，不存第二份真值） |
| `outcome` | `string \| null`（子智能体最终答复；取消场景常常只有推理块，此时**保持 `null`，不得拿推理或状态文案顶替**；主会话为 `null`） |
| `sessionFacts` | `SessionFacts \| null`（主会话为 `null`；不复用 `AgentLogFacts`，因为 `domain` 对子任务无意义） |

**`SessionFacts`**（`export interface`）
| 字段 | 形状 |
|---|---|
| `exitReason` | `string \| null` |
| `error` | `{ code: string \| null; message: string } \| null` |

**`RowNode`**（`export interface extends LogNodeBase`）— 厂商只给汇总、没有逐个身份的那一档；**不进面包屑、不可点**
| 字段 | 形状 / 说明 |
|---|---|
| `kind` | `'row'` |
| `counts` | `{ subagents: number; completed: number; failed: number } \| null`（**这一档唯一的实质内容**） |
| `facts` | `AgentLogFacts`（这一档**必然**是行级，故非空） |

**`LogTurn`**（`export interface`）— 一个轮次；**只做轻量分组，不建渲染块**
| 字段 | 形状 / 说明 |
|---|---|
| `round` | `number \| null`（**统一轮次号**＝「模型一次 API 往返」口径，与 `usage.turns` 同一把尺子；**不是** v2 的 `message.turn`；`null` = 不属于任何轮次的内容（厂商 system / 信封类块），集中成时间轴**顶部一个「未归属」段**，**不丢弃**、也不假装它属于第 1 轮） |
| `at` | `string` |
| `subagentId` | `string \| null` |
| `blocks` | `readonly ContentBlock[]`（**已成形的内容块**，`buildRenderBlocks` 的输入） |
| `tokens` | `AgentLogFacts['tokens']`（该轮自己的计量；整轮总计在 `facts.tokens`） |
| `durationMs` | `number \| null`（该轮**已结算**时长；界面落点：轮次头显示「本轮 3.2s」，§6.3） |
| `running` | `boolean`（**该轮是否尚未结束**；是 `ToolItem.running` 与 `block.assembly` 在**轮次级**的兜底判据） |

**`LogNodeStatus`**（`export type`，**枚举成员 7 个**）
`'running'` / `'completed'` / `'failed'` / `'stopped'` / `'canceled'` / `'unsettled'` / `'unknown'`

**`MessageSource`**（`export type`，4 值）
| 取值 | 含义 | 到 UI 的方式 |
|---|---|---|
| `'wire'` | 厂商事件流 / 会话通知流 | 逐条进模型，**实时** |
| `'hook'` | 厂商回调（如 codex 的 `SubagentStart`） | 逐条进模型，**实时** |
| `'session-file'` | 厂商会话文件（rollout 等） | 数据层**运行结束后**读，事件流里没有这些条目 |
| `'aggregate'` | 厂商只给汇总、没有逐条身份 | 数据层算出来的形态，**没有逐条条目** |

**`MissingReason`**（`export type`，4 值，2026-10-02 补定义）
| 取值 | 含义 |
|---|---|
| `'not-supported'` | 这家**结构上就没有**这个能力 |
| `'not-exposed'` | 厂商有数据，但**不投送**到我们拿得到的通道 |
| `'not-observed'` | 厂商有、通道也有，但**我们当前实现没接** |
| `'unverified'` | **没验证过**——不要当有、也不要当没有 |

**`CapabilityLevel`**（`export type`，**五态**；初版只写了四态，漏了 `not-projected-by-vendor`）
`'yes'` / `'no'` / `'unverified'` / `'off-by-adapter'` / `'not-projected-by-vendor'`
与 `MissingReason` 的配对**固定**：`no`→`not-supported`、`not-projected-by-vendor`→`not-exposed`、`off-by-adapter`→`not-observed` 或 `unverified`、`unverified`→`unverified`。

**`CapabilityDecl`**（`export interface`）
| 字段 | 形状 / 说明 |
|---|---|
| `level` | `CapabilityLevel` |
| `source` | `MessageSource \| null`（**`level === 'yes'` 时必填**，其余四态为 `null`） |
| `reason` | `MissingReason \| null`（**`level !== 'yes'` 时必填**，`'yes'` 时为 `null`） |

**`MessageCapability`**（`export interface`）= `readonly [dimension: string]: CapabilityDecl`
已收编的五个维度名：`thinkingText` / `toolInput` / `toolResult` / `subagent` / `streamingDelta`（UI **不硬编码任何维度名**，只按收到的顺序渲染）。

**`Loadable<T>`**（`export type`）= `{ status: 'loading' }` | `{ status: 'error'; error: unknown }` | `{ status: 'ready'; data: T }`

### 2.2 `buildRenderBlocks` 与渲染块（§4.2）

**`buildRenderBlocks`**（`export function`）
签名：`buildRenderBlocks(blocks: readonly ContentBlock[], nodes: LogNodeIndex): RenderBlock[]`
四条规整：① 按 `callId` 配对 `tool-call` 与 `tool-result`（缺 `callId` 或配不上 ⇒ 降级成独立条目，不编造关联）；② 相邻的工具条目合并成一个工具组；③ **派发点**出 `subagent-bar`（导航），**不进工具组**（判据：`nodes` 里有节点的 `spawnedBy` 命中本轮的块（`callId` 优先、其次 `messageId`）；命不中时挂在**该轮最后一个块之后**，不隐藏）；④ `tool.family === 'task' | 'ask-user'` 的块**从工具组里提出、原地成卡**，并**切断**工具组的合并链；同一轮内只有**最后一次** `task` 调用出面板。
输入假设（由数据层保证，UI 不校验、也不补救）：同 messageId 的多条消息**已按 v2 的覆盖/累积语义合并完毕**；缺格一律是 `null` + `MissingReason`，**例外是工具名**——拿不到时是**空串** + `nameMissing`；每个块的 `id` 已由数据层给定；`nodes` 是**整棵会话树的索引**（按 `id`）。

**`LogNodeIndex`**（`export type`）= `ReadonlyMap<string, LogNode>`（会话树索引：规则 3 定位派发点用）

**`RenderBlock`**（`export type`，判别联合，**共 9 个 arm**）
| arm | 载荷字段 |
|---|---|
| `{ kind: 'text' }` | `block: TextBlock` |
| `{ kind: 'thinking' }` | `block: ThinkingBlock` |
| `{ kind: 'tool-group' }` | `items: ToolItem[]` |
| `{ kind: 'attachment' }` | `block: AttachmentBlock` |
| `{ kind: 'unrecognized' }` | `block: UnrecognizedPayloadBlock` |
| `{ kind: 'subagent-bar' }` | `node: SessionNode`（**收窄成 `SessionNode`**：`kind: 'row'` 的节点不进面包屑、不可点，收窄后**类型上就点不进去**） |
| `{ kind: 'row-summary' }` | `node: RowNode` |
| `{ kind: 'task-panel' }` | `panel: TaskPanel` |
| `{ kind: 'ask-user-card' }` | `interaction: AskUserInteraction` |

§4.2 对本类型的三处修订：① **`streaming: boolean` 从 `text` / `thinking` 两个 arm 上删掉**，改由 `block.assembly` 承担（判据是 `block.assembly === 'open'`，**它是块自己的事实，不是推断**）；② **新增 `row-summary` arm**；③ **`subagent-bar` 的 `node` 收窄成 `SessionNode`**；另 `attachment` 一分为二（D31）。

**`ToolItem`**（`export interface`）— 一个工具条目 = 一次调用 +（可能有的）结果
| 字段 | 形状 / 说明 |
|---|---|
| `callId` | `string \| null` |
| `name` | `string` |
| `nameMissing` | `MissingReason \| null` |
| `family` | `ToolFamily \| null`（归一后的族名；无法归类为 `null`；与 `tool` 是否为空**不是**一回事，D29） |
| `input` | `{ value: string \| null; text: string \| null; bytes: number \| null }` |
| `output` | `{ text: string; status: 'ok' \| 'error' \| 'unknown'; bytes: number; truncation: TruncationState } \| null` |
| `at` | `string`（发出调用的时刻；折叠态标题里显示「已运行 12s」要用） |
| `running` | `boolean`（有调用、结果还没到、**且所在轮次尚未结束**——只有这一种情况才转圈） |

**`RowEvent`**（`export interface`）— 时间轴上必须可见的行级事件
| 字段 | 形状 / 说明 |
|---|---|
| `at` | `string` |
| `level` | `'milestone' \| 'error' \| 'warning'`（三档，2026-10-02 新增 `'warning'`，D34） |
| `text` | `string`（给人看的一句话；复用 `log-format.ts` 的既有措辞，不另写一套） |

**`ContentBlockBase`**（`export interface`）— 五类块共有的归属字段（v2 放在**消息信封**上，定型时摊到块上）
| 字段 | 形状 / 说明 |
|---|---|
| `id` | `string`（必须由数据层给：折叠态、React key、虚拟列表的稳定识别都挂在它上面） |
| `at` | `string` |
| `messageId` | `string` |
| `subagentId` | `string \| null`（非空表示这条来自子任务；时间轴只显示当前节点的，靠它过滤防串台） |
| `role` | `'assistant' \| 'user' \| 'tool' \| 'system'`（**说话者**；决定块的角色标签，§6.9） |
| `source` | `MessageSource`（非 `wire` 时界面标「补录 / 汇总」） |
| `assembly` | `'snapshot' \| 'open'`（**`open` = 还没收到过快照**（进程被中断的块停在这里）；界面据它挂流式动效，**不得用「有没有后续块」推断**） |

**`TextBlock`**（`extends ContentBlockBase`）：`kind: 'text'`、`text: string`（**只有它走 markdown**；v2 的 `TextBlock.text` 非空，故这里也没有 missing 格）

**`ThinkingBlock`**（`extends ContentBlockBase`）：`kind: 'thinking'`、`text: string | null`、`textMissing: MissingReason | null`、`textKind: 'full' | 'summary' | 'none'`
（文本可空，为 `null` 时**必填** `textMissing`，不给空面板；`textKind` = 文本的**完备性**：claude 是完整推理、codex 只有「推理摘要」、dsh 是完整原文）

**`ToolCallBlock`**（`extends ContentBlockBase`）
| 字段 | 形状 / 说明 |
|---|---|
| `kind` | `'tool-call'` |
| `callId` | `string \| null`（本设计两侧都放宽） |
| `name` | `string`（**原样透传**；拿不到时是**空串** + `nameMissing`） |
| `nameMissing` | `MissingReason \| null` |
| `family` | `ToolFamily \| null`（十个族；无法归类时 `null`） |
| `input` | `{ value: string \| null; text: string \| null; bytes: number \| null }` |
| `tool` | `ToolFamilyPayload \| null`（`null` = **本期没有为它收编专门卡片**，含「适配器不认识」与「不在两族里」两种，两者靠 `family` 分开） |

**`ToolResultBlock`**（`extends ContentBlockBase`）：`kind: 'tool-result'`、`callId: string | null`、`text: string`、`status: 'ok' | 'error' | 'unknown'`、`bytes: number`、`truncation: TruncationState`

**`TruncationState`**（`export type`，三态）
- `{ kind: 'none' }`：**确认**没被截断（数据层拿到了标记且为 false）
- `{ kind: 'truncated'; reason: string | null }`：确认被截断（`reason` 给人话，如「超过 256 KB」）
- `{ kind: 'unknown' }`：**没采到截断标记**——界面写「输出可能不完整」，**不写「完整」**

**`AttachmentBlock`**（`extends ContentBlockBase`）：`kind: 'attachment'`、`attachmentKind: 'image' | 'file'`、`path: string | null`（拿不到为 null，如内联 base64 的图片）、`mimeType: string | null`

**`UnrecognizedPayloadBlock`**（`extends ContentBlockBase`）：`kind: 'unrecognized'`、`reason: 'unrecognized' | 'unmapped-shape'`、`vendorType: string | null`（厂商原始类型，如 `session/title`、`todo_list`，仅供参考）、`raw: string | null`（正文是该载荷的**原文**）

**`ContentBlock`**（`export type`，判别联合，**6 类**）= `TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | AttachmentBlock | UnrecognizedPayloadBlock`

### 2.3 工具族与两族载荷（§4.2）

**`ToolFamily`**（`export type`，**十个族**，族名由**工具名**决定、不由厂商决定）
`'read-file'` / `'write-file'` / `'edit-file'` / `'search-content'` / `'list-files'` / `'run-shell'` / `'web-search'` / `'spawn-agent'` / `'task'` / `'ask-user'`

**`ToolFamilyPayload`**（`export type`）= `{ family: 'task'; panel: TaskPanel }` | `{ family: 'ask-user'; interaction: AskUserInteraction }`

**`ToolCardResult`**（`export interface`）— 卡片底部的「原始结果」
| 字段 | 形状 |
|---|---|
| `ok` | `boolean` |
| `raw` | `string \| null`（拿不到就是 null） |
| `truncated` | `boolean`（结果被上限截断，**由数据层判定**） |

**`TaskPanel`**（`export interface`）— `task` 族的卡片载荷：**本次调用之后的整张清单**
| 字段 | 形状 / 说明 |
|---|---|
| `steps` | `readonly TaskStep[]`（整张清单；**整表**是归一结果，不是本次变更） |
| `counts` | `{ pending: number; inProgress: number; completed: number; unknown: number }`（派生值，由数据层给；`unknown` 必须是**第四格**） |
| `change` | `{ completed: number; added: number; removed: number } \| null`（与**上一张**清单的差分；null = 该节点首次出现清单） |
| `note` | `string \| null`（厂商给的一句话说明，codex 的 `explanation`：为什么改计划） |
| `at` | `string` |
| `result` | `ToolCardResult \| null` |
| `running` | `boolean`（有调用、结果还没到、**且所在轮次尚未结束**） |

**`AskUserInteraction`**（`export type`）= `AskUserPending | AskUserSettled`

**`AskUserPending`**（`export interface`）：`state: 'pending'`、`questions: readonly AskUserQuestion[]`、`at: string`、`running: boolean`（**还在等**（true）还是**等不到了**（false）——这一格不能省）

**`AskUserSettled`**（`export interface`）：`state: 'settled'`、`questions: readonly AskUserQuestion[]`、`outcome: AskUserOutcome`（**在这一支里非空**）、`answers: readonly AskUserAnswer[] | null`（null = 收场了但没有答案可回填，如 `unavailable` / `timeout`）、`at: string`、`result: ToolCardResult | null`

**`AskUserOutcome`**（`export type`，七态，= v2 spec 的 `AskUserResult.outcome` 内联联合，**同一份取值，不增不减**）
`'answered'` / `'auto-resolved'` / `'skipped'` / `'timeout'` / `'unavailable'` / `'rejected'` / `'canceled'`

**`TaskStep` / `AskUserQuestion` / `AskUserAnswer`**：文档明写「字段与 v2 spec §7.6.2 ⑨ / ⑩ **同名同义**，本节不重复定义」——**本设计对 v2 只做两处收紧**：`commitModel` 不进 UI 契约、`TaskListArgs`（空壳）不作为清单的来源。

### 2.4 环境模型（§4.3）

**`AgentEnvironment`**（`export interface`）— 与「日志」解耦的模型（但由 agent-log 负责展示）
| 字段 | 形状 / 说明 |
|---|---|
| `summary` | `{ agentKind: AgentKind; modelId: string; effort: string \| null; providerName: string; baseUrl: string; workspaceBase: string; baselineCommit: string }`（一行摘要：谁 · 哪个模型 · 哪一档权限；工作区根目录与基线提交） |
| `groups` | `readonly EnvGroup[]` |

**`EnvGroup`**（`export interface`）：`id: string`、`title: string`（组名由数据层给）、`source: 'user' | 'project' | 'vendor' | 'observed'`、`items: readonly EnvItem[]`

**`EnvItem`**（`export type`，判别联合两支）
- `{ present: true; id: string; label: string; text: string; truncated: { reason: string; bytes: number } | null; copyPath?: string; at: string | null }`
- `{ present: false; id: string; label: string; missing: MissingReason }`（`present: false` 时 **`missing` 必填**）

### 2.5 数据来源接口（§4.4）

**`AgentLogSource`**（`export interface`）
| 方法 | 签名 / 说明 |
|---|---|
| `requestEnvironment?()` | 调用方声明「环境信息现在需要了」（入口：用户点了「？环境信息」）；实现方据此去取，取好后用新的 `environment` props 回灌；**组件不 await 它**，也不从返回值推断状态 |
| `requestDiagnostics?()` | 同上，对应「原始输出」面板展开 |
| `retryNode?(nodeId: string)` | 节点内容读取失败时的重取。**给 `nodeId`**：数据层可能只缓存了部分节点；重试后同样用新的 `nodes` props 回灌 |

三条口径：① 三个方法**全可选**，一个都不给时组件照常工作（`environment` / `diagnostics` 为 `undefined` 时显示「未提供」、`content.status === 'error'` 时**不渲染重试按钮**）；② **不得把 `seq` / 事件流 / 增量累积塞进这个接口**；③ `requestEnvironment` 在抽屉**每次**打开时各调一次（不是只在首次），组件不实现「只调一次」这类缓存。

### 2.6 原始输出（§5.3.1）

**`AgentLogDiagnostics`**（`export interface`）
| 字段 | 形状 / 说明 |
|---|---|
| `lines` | `readonly { at: string; source: 'stdout' \| 'stderr'; text: string; summary: string \| null }[]`（逐字原文行；UI 不截断、不解析、不合并，也不做「取最后 N 条」这类判断） |
| `truncatedReason` | `string \| null`（因上限只保留了最近 N 行时给一句人话；null = 完整） |

**渲染口径**：有 `summary` 时**它优先**（`Typography.Text`），`text` 原文**仍逐字给出**（`MonoText`）——两者都给，不互相替代。
**props（§9）**：`diagnostics?: Loadable<AgentLogDiagnostics>` + `onRetryDiagnostics?: () => void`——**由调用方在抽屉打开时取**。三种状态各有画面：`loading` 给 `Skeleton`、`error` 给 `Alert` + 重试、`ready` 且 `lines` 为空时**不渲染这个入口**。

### 2.7 组件 props 契约（§9.1 / §9.2 / §9.3 / §9.4 / §9.7）

**`MessageTimelineProps`**（§9.1，L1：一轮消息的渲染；**没有虚拟化、没有 subagent 字段、没有轮次跳转**）
| 字段 | 形状 / 说明 |
|---|---|
| `turns` | `readonly LogTurn[]`（**已分组、未建渲染块**） |
| `nodes` | `LogNodeIndex`（`buildRenderBlocks` 的规则 3（派发点）要用） |
| `renderBlock?` | `BlockRenderer`（默认实现 = 注册表；传它是为了 S5） |
| `openKeys?` | `ReadonlySet<string>`（折叠态：`activeKey` 由 L2 给；不传 = 全部用默认态、不可交互） |
| `onOpenChange?` | `(key: string, open: boolean) => void` |
| `rowEvents?` | `readonly RowEvent[]`（按 `at` 落在轮次之间） |
| `userPrompt?` | `LogNode['userPrompt']`（**L1 不知道它从哪来**，只负责摆在最前） |

**`RenderTurn`**（`export type`）= `(turn: LogTurn, index: number) => ReactNode`（单轮渲染入口；虚拟列表按项渲染时调的就是它）
**`BlockRenderer`**（`export type`）= `(block: RenderBlock, ctx: BlockRenderContext) => ReactNode`
**`BlockRenderContext`**（`export interface`）：`open: boolean`（折叠态是否打开，受控）、`onOpenChange(next: boolean): void`、`streaming: boolean`（这一轮是否还在流式，§6.7 的动效判据）

**`AgentLogLayoutProps`**（§9.2，L2：抽屉正文的一体化布局；**不套 `Drawer`**）
| 字段 | 形状 / 说明 |
|---|---|
| `model` | `AgentLogModel` |
| `environment?` | `Loadable<AgentEnvironment>` |
| `diagnostics?` | `Loadable<AgentLogDiagnostics>` |
| `source?` | `AgentLogSource`（三个方法全可选，一个不给也照常工作） |
| `onDownload?()` | 下载台账回调 |
| `actions?` | `readonly ToolbarAction[]`（不传 = 用 `AgentLogToolbarPreset`） |
| `timeline?` | `ReactNode \| ((props: TimelineSlotProps) => ReactNode)`（不传 = `VirtualTurnList`；传它是为了 S1 / S5） |
| `viewState?` | `AgentLogViewState`（视图态外置，S5；不传则由 `AgentLogLayout` 内部用 `useAgentLogView`） |

**`AgentLogDrawerProps`**（§9.2，`extends AgentLogLayoutProps`）：`open: boolean`、`onClose(): void`、`title?: ReactNode`（默认「执行日志」）

**（未定义）`TimelineSlotProps`**：`timeline` 槽的函数形态入参，全文没有给定义。
**（未定义）`AgentLogViewState`**：§9.5 只说「导出 `AgentLogViewState`（受控值 + setter），供 S5 外置」，没有字段清单。
**（未定义）`AgentLogToolbarPresetInput`**：§9.4 的 `useAgentLogToolbarPreset(input: AgentLogToolbarPresetInput)` 用到了它。
**（未定义）`AgentKind`**：`AgentEnvironment.summary.agentKind: AgentKind` 用到，全文未定义取值。

**`BlockRendererRegistry`**（§9.3，映射类型）
`{ readonly [K in RenderBlock['kind']]: (block: Extract<RenderBlock, { kind: K }>, ctx: BlockRenderContext) => ReactNode }`
**`DEFAULT_BLOCK_RENDERERS`**：`export const DEFAULT_BLOCK_RENDERERS: BlockRendererRegistry`（默认注册表，注释写「**七臂齐全**（类型层强制，漏一臂编译不过）」）
**`BlockRendererProviderProps`**：`renderers: Partial<BlockRendererRegistry>`、`children: ReactNode`
**`BlockRendererProvider(props: BlockRendererProviderProps): ReactNode`**
**`useBlockRenderers(): BlockRendererRegistry`**（取合并后的表 = 默认表 ⊕ 最近的 Provider）
不提供「部分覆盖某一臂的内部」——注册表以 `kind` 为粒度，半个渲染器是自相矛盾的。

**`ToolbarAction`**（§9.4，一个工具条动作）
| 字段 | 形状 / 说明 |
|---|---|
| `key` | `string`（稳定键：React key 与测试定位都用它，**不用数组下标**） |
| `label` | `string`（可访问名／按钮文案） |
| `icon?` | `ReactNode` |
| `onSelect?()` | `void` |
| `visible?` | `boolean`（「原始输出」与「环境信息」的显隐判据挂在这里） |
| `toggle?` | `{ checked: boolean; onChange(next: boolean): void }`（受控开关类动作：跟随最新 / 只看工具调用 / 只看错误） |
| `number?` | `{ value: number; min: number; max: number; onSubmit(next: number): void }`（数值输入类动作：跳到轮次；给了就越界 clamp 并如实回显） |
| `disabled?` | `boolean` |

**`useAgentLogToolbarPreset(input: AgentLogToolbarPresetInput): readonly ToolbarAction[]`**（默认六个动作的内聚处；**本仓的业务口径只住在这个文件里**）

**`AgentRunStateTagProps`**（§9.7，L0 具名原语「进行中 / 结果未采集」的**唯一分派处**）
| 字段 | 形状 / 说明 |
|---|---|
| `running` | `boolean`（有调用、结果未到、**且所在轮次尚未结束**） |
| `hasResult` | `boolean`（结果在不在，`null` = 还没到） |
| `missingReason` | `string \| null`（结果未采集时的原因（`capability` 给）；拿不到为 null 时只写「结果未采集」） |
| `since?` | `string \| null`（给计时器用：`running` 为 false 时不挂定时器） |

**第二个具名原语 `raw-output-panel`**（§9.7）：吃 `Loadable<AgentLogDiagnostics> | Loadable<ToolCardResult>` 的**公共形状**（`{ status, lines|raw, truncatedReason }`）与 `onRetry`。**卡片底部用的是它的 `ToolCardResult` 变体**（单份原文），固定区用的是 `AgentLogDiagnostics` 变体（逐行）。

### 2.8 §4.2 里被显式删除 / 移出的类型与字段（重写时最易被"恢复"）

| 名字 | 处置 | 理由（源文档原话要点） |
|---|---|---|
| `AgentLogFacts.durationMs`（行级的那个） | **删** | 它**每秒变**；改由 `startedAt` / `endedAt` 现算。**注意 `LogTurn.durationMs`（一轮的结算值）不在此列** |
| `attempts`（重试次数） | **删** | 它是**候选行**的属性，不是执行日志的属性；行卡片上已有「已重试 N 次」标签 |
| `diagnostics`（`log` 原文数组） | **移出主模型**（不是删功能） | 它有几千行、面板又默认收起 ⇒ 独立 `Loadable`、按需注入（§5.3.1） |
| `status: EvalRowStatus` | **改 `{ tone; label }`** | `EvalRowStatus` 是**评测编排**的十态词汇 |
| `diff` / `score` | **移出，改 `facts.domain`** | 它们是**领域事实**，定字段等于每加一格事实都要改契约 |
| `LogTurn.turn` | **改 `round`** | v2 明文禁止拿 `message.turn` 分组 |
| `tokens.reasoning?: number` | **移出，改与 `tokens` 并列的 `thinking`** | v2 §7.7 逐字「为什么不并进 `tokens`」；且必须带 `basis` |
| `error.code: string` | **放宽成 `string \| null`** | 不是每种失败都有错误码 |
| `LogNodeRef` + `siblings` | **删，改 `parentId` + 扁平 `nodes`** | 初版把「同层兄弟」预先算好塞在每个节点上：N 个节点就有 N 份重复列表 |
| `chain`（面包屑链） | **删，改派生** | 从 `nodes` + `activeNodeId` 顺着 `parentId` 走一遍即可，存一份就是第二份真值 |
| `capability: subagent: 'no'` 的语义 | **加 `kind: 'row'`** | 「这家没有子任务概念」≠「这次没派子任务」 |
| v2 的 `ToolData`（族联合，`args` + `result` 装在一起） | **不照搬，收窄成 `ToolFamilyPayload`** | v2 那个形状是按「一次调用」在**适配器内部**组装的；落到块上时不成立 |
| `TaskListArgs`（v2 的空壳 `{ /* 无参数 */ }`） | **删**（不进 UI） | 它是空参数占位，实测里整表就在 `arguments` 里 |
| `TaskListResult.commitModel` | **删** | v2 已明文「**不允许把补丁原样抛给 UI**」 |
| 族载荷的挂载点（两块各挂一份，还是只挂一块） | **只挂 `tool-call` 块** | `tool-call` 是**唯一必然存在**的那一块 |
| `kind: 'subagent'` 的块 | **删**（v2 里没有这一支） | subagent 是**与消息平级的独立事件**；导航改由 `LogNode.spawnedBy` 派生 |
| `streaming: boolean`（`RenderBlock` 的 `text` / `thinking` arm 上） | **删**，改由 `block.assembly` 承担 | 它的**输入来源无处可寻** |
| `ToolResultBlock.truncated: boolean` | **改 `truncation: TruncationState`** | 裸布尔让「确认完整」与「没采到标记」在界面上完全一样 |
| `AttachmentBlock`（初版装的是「不认识的载荷」） | **拆成两个类型** | 语义正交；初版误标成「一致」 |
| `LogNode`（扁平接口） | **改按形态的判别联合** | 两种形态的格互相为 `null` |
| 子任务行缺的格（`outcome` / `usage` / `dispatchKind` / `statusMissing` / `source`） | **补进 `SessionNode`** | 规范的面板②是「每个子任务一行」 |
| `capability` 的两个定字段 | **改可变键的维度声明** | 定字段意味着「加一个能力维度 = 改契约」 |
| 消息信封的 `role` / `source` / `assembly` | **摊到块上**（`ContentBlockBase`） | 初版只摊了 `messageId` / `subagentId` |
| `AgentLogView`（组件名） | **不再使用** | D24 之后「主件」这个概念本身被拆成了三层 |

### 2.9 §4.1 扩展性七条（原文标题自称「三条」，见 §12 矛盾清单）

1. **加块类型不用改模型**：`ContentBlock` 是判别联合，新增一类块 = 加一个 `kind`；渲染层按 `kind` 分派（`assertNever` 兜底），**不改 `AgentLogModel` 的形状**。
2. **`Loadable<T>` 可复用到别处**：本仓出现很多次（`useRowDiff` / `useRowLog` / `RowDiffIndex` 各写一份）。
3. **`specVersion: 1` 是给未来留的门**：让「模型形状变了」变成一个**可判定**的事；本期只有 `1`，不加分流逻辑。
4. **不加 `children` / 嵌套树**：UI 的消费者只有「祖先链」与「同层兄弟」两处，两者都能从 `parentId` 派生。
5. **收编新工具族 = 加一个 arm**：`ToolFamilyPayload` 与 `RenderBlock` **都是判别联合**；本期只收编 `task` / `ask-user` 两族，其余 8 族走通用工具行。
6. **加一个能力维度 = 加一项声明**（D28）：`MessageCapability` 用**可变键**。
7. **加一种节点形态 = 加一个 arm**（D32）：`LogNode` 是判别联合（`SessionNode` | `RowNode`）。

### 2.10 §4.1 五条边界纪律（这一节比字段更重要）

1. **UI 永远看不到传输层**：模型里**没有** `seq`、没有 SSE、没有 `chunk: 'delta' | 'snapshot'`、没有「`log` 事件」这个概念。增量累积与快照覆盖属于数据层；UI 只看到**已成形的块**与两个布尔（`streaming` / `running`）。**`log` 原文同理，但它不是「事件」**：它以**已定型的原始输出行**（`AgentLogDiagnostics`，§5.3）单独注入。
2. **UI 不做取数**：`content` 是**按值给**的，不是 `load()` 回调。「进哪个节点才取哪个」是**数据层的按需策略**（它可以用 `activeNodeId` 决定取哪个）。
3. **不合并事件源**：初版「`useRowLog` 与 `useRowStream` 按 `seq` 并集」（原 §5.4）**整节删除**。数据层对外只该给**一条已经合并好的流**。
4. **UI 不判断大小**：`input.text` / `output.text` 的长度上限与 `truncated` 标记**由数据层算好**。
5. **UI 不判厂商，也不判「族数据的来源」**：卡片只吃 `ToolFamilyPayload`（`task` / `ask-user`）；**不按 `agentKind` / 工具名分支**（v2 spec §7.6.4：只按 `family` 分支）。

### 2.11 §4.2「两族卡片的载荷」与 `ContentBlock` ↔ 规范 `AgentBlock` 逐成员对应

| 本设计的块 | 规范的对应 | 差异（不藏的） |
|---|---|---|
| `ContentBlockBase` | `BlockBase` + 消息信封字段 | 规范的 `index` / `normalizedFrom` / `raw` **不进 UI**；本设计反向补 `id` / `at` / `messageId` / `subagentId` / `role` / `source` / `assembly`——规范把这七个放在**消息信封**上，定型时摊到块上 |
| `TextBlock` | `TextBlock` | 一致 |
| `ThinkingBlock` | `ThinkingBlock` | **少 `signature`**：它是有意隐藏的 replay 校验串，不进任何呈现，UI 连拿都不该拿到。`textKind` 的界面落点见 §6.9 |
| `ToolCallBlock` | `ToolCallBlock` | ① 规范的 `input: unknown`（结构化对象）**收窄成「结构化文本 + 原文文本 + 字节数」**；② **补 `family`**（D29）；③ `input.bytes` 放宽成**可空** |
| `ToolResultBlock` | `ToolResultBlock` | ① **多一个 `bytes`**；② **`truncated: boolean` 改成 `truncation: TruncationState`**（D30） |
| `AttachmentBlock` | `AttachmentBlock` | **2026-10-02 起才是「一致」**（D31）。初版把这个名字借去装「不认识的厂商载荷」，而对照表却标着「一致」——**这是一处错误登记**，现已拆开 |
| `UnrecognizedPayloadBlock`（新增） | 规范里**没有**这一支 | 本设计对「不认识的厂商载荷」的兜底 |
| **（已删除）`kind: 'subagent'` 的块** | 规范里**没有**这一支 | subagent 是**与消息平级的独立事件** ⇒ 子任务导航改由 `LogNode.spawnedBy` 派生 |

---

## 3. 数值参数（逐条：数值 / 表达式 → 所属元素或场景）

> 「宁可长，不可漏」。颜色值文档中**未出现任何十六进制色值**，只有主题变量名（见 3.9）。

### 3.1 抽屉与容器几何

| # | 数值 / 表达式 | 所属元素 / 场景 | 出处 |
|---|---|---|---|
| 1 | `max(50vw, 800px)` | 主抽屉（`Drawer`）宽度 | §5 结构图、§5.1、§6.8、§9.5 |
| 2 | `maxWidth: '100vw'` | 主抽屉宽度上限 | §5.1 |
| 3 | `size` 不传 | 主抽屉（沿用既有口径） | §5.1 |
| 4 | `styles.body.padding = 0` | 主抽屉 body（2026-09-29 spec §7.2.1 ②） | §5.1、§6.8 |
| 5 | `height: '100%'`（**不是 `minHeight`**） | `AgentLogLayout` 最外层取满父容器（虚拟列表需要确定高度视口） | §5.1 |
| 6 | `min(42vw, 640px)` | **环境抽屉**宽度（**比主抽屉窄**） | §6.8 表、§9.6 |
| 7 | `maxWidth: '100vw'` | 环境抽屉宽度上限 | §6.8 表 |
| 8 | `push: { distance: 360 }` | 环境抽屉内推量（**antd 内建默认 180**） | §6.8 表、§9.6 |
| 9 | `destroyOnHidden: true` | 环境抽屉（与主抽屉同口径） | §6.8 表 |
| 10 | `mask: true` | 环境抽屉（antd 默认） | §6.8 表 |
| 11 | `styles.body.padding: 0` | 环境抽屉（内边距由内容给） | §6.8 表 |
| 12 | 限高 **520px** | **旧抽屉**（现状描述，`formatEventLog` 塞进的等宽文本框） | §1 |
| 13 | `.ant-drawer-body` | 旧滚动容器；**本期唯一例外**：滚动容器不再是它 | §5.1 |
| 14 | `Descriptions size="small" column={1}` | 环境抽屉摘要条 | §6.8 内容布局 1、§9.6 |

### 3.2 文案里的示例数字（重写时极易被"顺手改掉"）

| # | 数值 | 所属文案 / 场景 | 出处 |
|---|---|---|---|
| 15 | `轮次 N · 10:44:31` | 三区结构图的轮次头示例 | §5 |
| 16 | `工具调用 × 3` | 三区结构图的工具组标题示例 | §5 |
| 17 | `等待答复 12m` | 固定区徽标示例（D23） | §3 D23、§5、§11 验收 21 |
| 18 | `原始输出 N 条` | 固定区入口文案（N 为条数） | §5、§6.6、§9.5 |
| 19 | `↓ 回到最新（N 轮未读）` | 右下角浮动件 | §5、§6.4 |
| 20 | `3/5 完成` | `task` 面板标题计数示例 | §3 D20、§5.4、§6.1、§11 验收 19、§13 |
| 21 | `+1 完成` | `task` 面板标题变化摘要示例 | 同上 |
| 22 | `本轮另有 N 次更新 ▾` | `task` 面板底部 | §5.4 卡片结构 3、§5.4 规则 3、§11 验收 19 |
| 23 | `本轮 3.2s` | 轮次头的本轮耗时显示 | §4.1 `LogTurn.durationMs` 注释 |
| 24 | `已运行 12s` | 工具行折叠态标题 | §4.2 `ToolItem.at` 注释 |
| 25 | `命中 12 / 83 轮` | 过滤生效时固定区显示的命中数 | §6.5 |
| 26 | `已渲染 N / 共 M 轮` | 虚拟列表尾部护栏（**与上一条是两个不同的数**） | §6.5、§7.2、§11 验收 8、§13 |
| 27 | `第 40 轮` | §1 的问题陈述（「第 40 轮发生了什么」没有入口） | §1 |
| 28 | 「列了 **30** 个工具，其实只用了 **2** 个」 | §4.3「已调度的工具」与「用过的工具」混组的误读示例 | §4.3、§13 |
| 29 | 「只保留了最近 **N** 轮」 | `contentTruncatedReason` 的人话示例 | §4.1 |
| 30 | 「原文 **N** KB」/「超过 **256 KB**」 | 环境抽屉截断提示 / `TruncationState.truncated` 的 `reason` 示例 | §6.8 内容布局 3、§4.1 `TruncationState` |
| 31 | `••••` | `secret: true` 的默认遮罩 | §5.5 三处如实登记 1 |
| 32 | `3/5 完成 · +1 完成` | 收起态标题（说明「收起不丢信息」） | §5.4 规则 4、§6.1、§13 |
| 33 | 「十几条」 | §11 验收 8：几百轮下 DOM 中轮次节点数恒定在**十几条** | §11 验收 8 |
| 34 | `+12 −3` / `8/10` | `DomainFact.value` 的示例值格式 | §4.1 `DomainFact` |
| 35 | `[HH:mm:ss] source + 原文` | 原始输出面板的行形状 | §5.3.1、§10 |
| 36 | `30 个工具` / `2 个` | 同 #28（§13 风险表复述） | §13 |
| 37 | `approvalPolicy: 'never'` | 本仓无人值守的配置值（多处引用） | §5.5、§11 验收 21、§12、§13 |
| 38 | `MAX` / clamp `[1, turns.length]` | 轮次跳转器越界输入 clamp 区间 | §6.5、§9.4、§10 |

### 3.3 动效与时长（§6.7 五处动效）

| # | 数值 | 所属元素 / 场景 | 出处 |
|---|---|---|---|
| 39 | **1.8s 线性** | 思考块折叠态标题「思考中…」**扫光**（`ACTIVITY_SWEEP_CLASS`；**已处理 `prefers-reduced-motion`**） | §6.7 表 1 |
| 40 | **6px** | 思考行最前的圆点（呼吸标记）尺寸 | §6.7 表 2 |
| 41 | `opacity` **1 → 0.25** | 同上（呼吸） | §6.7 表 2 |
| 42 | **1.2s** | 同上（呼吸周期） | §6.7 表 2 |
| 43 | `▍` | 正文流末尾的闪烁光标（CSS 伪元素加在容器上，`MarkdownText` 一行都不改） | §6.7 表 3 |
| 44 | `.aieval-activity-sweep` | 扫光类名（**已在 `apps/web-next/app/globals.css`**，**不新造 keyframes**） | §6.7 表 1、§9.6 |
| 45 | `--app-muted` | 呼吸点唯一使用的主题变量（**不引图标包**） | §6.7 表 2 |
| 46 | `Badge status="processing"` | 进行中的工具行/工具组 + 固定区状态徽标（antd 自带动效） | §6.7 表 4、表 5 |

### 3.4 性能与频率（§7.1）

| # | 数值 | 所属元素 / 场景 | 出处 |
|---|---|---|---|
| 47 | **至多一帧一次（约 16ms）** | 对数据层的要求：对外更新合并频率上界 | §7.1(c) |
| 48 | **约 60Hz** | 更新上界（人眼之外）——如实登记的副作用 | §7.1 末 |
| 49 | **200ms 兜底** | rAF 不可用时的定时器兜底（后台标签页） | §10 `row-stream.test.ts` |
| 50 | 第 **195** / **154** 行 | 现状附录：`row-stream.ts` 的 `handleFrame` / `setEvents` 行号（**仅作证据，不作为设计依据**） | §7.1 现状附录 |
| 51 | **50 轮** | 被否掉的方案 2（自建窗口化：最近 50 轮 + 滚到顶加载更早） | §7.3 |
| 52 | **50 轮渲染出 50 轮** | L1 「不虚拟化」的测试断言 | §10 `agent-message-timeline.test.tsx` |
| 53 | `@rc-component/virtual-list@1.5.2` | antd 6 的**传递依赖**版本（装它**不新增任何传递包**） | §7.2 |
| 54 | `"@rc-component/virtual-list": "^1.5.2"` | 要写进 `packages/client/ui/package.json` 的 `dependencies` | §7.2 |
| 55 | `itemHeight` 是可选的 | `@rc-component/virtual-list` 逐项测量动态高度 | §7.2 |
| 56 | **几十个节点** | §7.4 评测的典型规模（故不做淘汰） | §7.4 |
| 57 | 「n 是子任务数，**几十的量级**」 | §4.1 评估表（扁平数组 + 一次 `filter` 是 O(n)） | §4.1 评估表 |

### 3.5 组件与结构的计数常量

| # | 数值 | 所属元素 / 场景 | 出处 |
|---|---|---|---|
| 58 | **7 个类型** | §1 现状：`formatEventLog(events)` 把事件按 7 个类型各拼一行 | §1 |
| 59 | **7 个扁平类型** | `packages/server/contracts/src/agent-event.ts` 仍是 v1 的 7 个扁平类型 | §12 |
| 60 | **十个族** | `ToolFamily` 十个取值 | §4.1 `ToolCallBlock.family` 注释、§4.2 `ToolFamily`、§12 |
| 61 | **两族** | 本期收编 `task` / `ask-user` | §3 D22、§4.2、§12 |
| 62 | **8 族** | 其余 8 族本期走通用工具行 | §2 非目标、§4.1 扩展性 5、§12 |
| 63 | **五态** | `CapabilityLevel`（初版四态，漏 `not-projected-by-vendor`） | §4.1 |
| 64 | **四态** | `MissingReason` 四个取值 | §4.1、§12 |
| 65 | **五个维度名** | `thinkingText` / `toolInput` / `toolResult` / `subagent` / `streamingDelta` | §4.1 `MessageCapability` 注释 |
| 66 | **5 个维度 × 3 格 = 15 个格** | 为什么 `CapabilityDecl` 要绑成对象（反对三个并列可空字段） | §4.1 `CapabilityDecl` 注释 |
| 67 | **六档** / 枚举 **7 个成员** | `LogNodeStatus`（「六档 + `unknown`」的说法与枚举成员数不一致，见 §12 矛盾清单） | §4.1 字段注释、类型定义 |
| 68 | **三档** | `RowEvent.level`：`milestone` / `error` / `warning` | §4.2 |
| 69 | **三态** | `TruncationState`：`none` / `truncated` / `unknown` | §4.1 |
| 70 | **三态** | `Loadable<T>`：`loading` / `error` / `ready` | §4.1 |
| 71 | **四格** | `TaskPanel.counts`：`pending` / `inProgress` / `completed` / `unknown` | §4.1、§10 |
| 72 | **七态 + 一种「还没收场」** | `AskUserOutcome` 七态；`outcome: null` 是独立一格 | §3 D21、§5.5 |
| 73 | **四匹 / 四个通道** | `MessageSource` 四值 | §4.1 |
| 74 | **两条 / 两个 `main` / 两个 arm** | `LogNode = SessionNode \| RowNode` | §4.1、§4.2 |
| 75 | **9 个 arm**（`RenderBlock` 实际臂数）vs 文中多处写 **「七臂」** | 见 §12 矛盾清单 | §4.2 vs §9.3 / §10 / D25 |
| 76 | **6 类块** | `ContentBlock` 六臂（`render-blocks.test.ts` 的「六类块各自字段只在自己那一支可读」） | §4.2、§10 |
| 77 | **三层**（L0 / L1 / L2） | D24 的组件分层 | §3 D24、§9.0 |
| 78 | **三条硬纪律** | §9.0：依赖只准向下 / L0 不 `useState` / L0 不认业务概念 | §9.0 |
| 79 | **三条边界纪律** | §9.5（初版三条全部保留，逐条补上 D24 后的新落点） | §9.5 |
| 80 | **三个方法全可选** | `AgentLogSource` | §4.4、§9.2 |
| 81 | **六项 / 六个动作**（实际列出 **7 个**名字：下载台账 / 跟随最新 / 跳到轮次 / 只看工具调用 / 只看错误 / 原始输出 / 环境信息） | 工具条预设（**数不一致，见 §12 矛盾清单**） | §3 D26、§6.6、§9.4、§9.5 |
| 82 | **五处动效** vs §11 验收 13 的 **四处动效** | §6.7 / §11（**数不一致，见 §12 矛盾清单**） | §6.7、§11 验收 13 |
| 83 | **五条例外** | §6.1 折叠例外 | §6.1 |
| 84 | **四条硬规则** | §5.4 位置与折叠 | §5.4 |
| 85 | **两条例外** | §5.4 默认展开（`running === true` 或结果未采集） | §5.4 |
| 86 | **四种「没有清单」的情形** | §5.4 表 4 行 | §5.4 |
| 87 | **三条口径** | §5.5 答案回填；§4.4 三条口径；§4.3 环境归属 | §5.5、§4.4 |
| 88 | **三处如实登记** | §5.5（`secret` 遮罩 / 不美化截断 / 不在组件里按主会话-子任务分支） | §5.5 |
| 89 | **五处重组场景**（S1–S5） | §2.1 | §2.1、§8.4、§11 验收 24–28 |
| 90 | **九件平铺** | §9 初版（按组件名拆） | §8.4 |
| 91 | **8 行对照表** | §8.4「§9 初版 → 本轮对照」 | §8.4 |
| 92 | **13 行落点表** | §8.4「逐条落点」 | §8.4 |
| 93 | **12 行落点表** | §8.5「逐条落点」（D27–D38） | §8.5 |
| 94 | **约 63 项缺口 / 6 个根因 / 12 条必修** | §8.5 四方并行评审结论 | §8.5、卷首修订说明 |
| 95 | **四条评审作用域 / 四位评审** | §8.5 评审分工表 | §8.5 |
| 96 | **三条差异**（能力态数 / 思考 token 可加性 / 能力格是否逐格声明） | v2 系 → v3 的基线差异 | §8.5 |
| 97 | **24 条变异体**（(a)–(x)） | §10 变异验证 | §10 |
| 98 | **6 项真实浏览器冒烟**（标题写「五项」） | §10 末（**数不一致，见 §12 矛盾清单**） | §10 |
| 99 | **三个根因未修** | `structured` / 派生指标 / 图片缩略图 | §8.5 末、§12 |
| 100 | **2 处原子不变量** | §10 `agent-log-shape.test.ts`：`CapabilityDecl` 配对不变量、`LogNode` 两支不接受多余格 | §10 |
| 101 | **8 字符** | `header` 超过 v2 建议的 8 字符就让它长着（**不做美化截断**） | §5.5 三处如实登记 2 |
| 102 | **前 8 位** | 任务名为 null 时用 `子任务 <subagentId 前 8 位>` | §4.1 `SessionNode.subagentId`、§6.3、§11 验收 7 |

### 3.6 组件选型中的尺寸/属性值（§9.6）

| # | 数值 | 所属元素 |
|---|---|---|
| 103 | `List size="small"` | 计划清单面板、问答卡片 |
| 104 | `Descriptions size="small" column={1}` | 环境摘要 |
| 105 | `Switch size="small"` | 跟随最新（沿用「自动滚底」原来的控件形态） |
| 106 | `Card size="small"` | 子任务占位条 |
| 107 | `Button type="text"` + `icon={<QuestionCircleOutlined />}` | 环境信息入口（`aria-label` 与 `Tooltip` 都写「环境信息」） |
| 108 | `Collapse ghost`（单面板 / 内层 ghost） | 思考块、工具行（组内）、原始输出 |
| 109 | `Collapse`（最外层，带边框） | 工具组、计划清单面板、问答卡片 |
| 110 | `Segmented`（多选）或两个 `Tag.CheckableTag` | 过滤 |
| 111 | `aria-current="page"` | 面包屑不可点的当前段（`Typography.Text strong` + 该属性） |

### 3.7 §8.2 修订表中出现的行号/定位（都是必须一起改的锚点）

| # | 锚点 | 文件 |
|---|---|---|
| 112 | `README.md:168` | README 按钮与下载说明 |
| 113 | `README.md:215` | README 按钮顺序口径 |
| 114 | `README.md:241` | README 排障表 |
| 115 | `eval-row-card.tsx:208` | 按钮文案 |
| 116 | `agent-activity-line.tsx:18` | 注释 |
| 117 | `packages/server/agents/src/turn.ts:343` | 注释 |
| 118 | `docs/superpowers/specs/2026-09-22-features-design.md:168` | 历史 spec 的版式图 |
| 119 | `claude-code/index.ts:66` | `disallowedToolsFor(modelId)`（环境「运行配置」来源） |
| 120 | `packages/server/contracts/src/run.ts:37-40` | `EvalRowStatus` 十态词汇出处（§4.1 引用） |
| 121 | `packages/client/ui/src/composite/log-view.tsx` | 旧抽屉（将被删除） |
| 122 | `base/use-now.ts` | `useNow(active)` 的既有用途（文件头为「走秒表」而写） |
| 123 | `2026-10-01-agent-message-spec-design-v3.md` | 本轮起一律对齐的基线（v3） |

### 3.8 阶段与版本号

| # | 值 | 场景 |
|---|---|---|
| 124 | `specVersion: 1` | `AgentLogModel` 的唯一取值（本期不加分流逻辑） |
| 125 | 文档日期 **2026-09-30** / 状态 **待评审** | 源文档头部 |
| 126 | 修订日期 **2026-10-01**（P0 五条）/ **2026-10-02**（组件分层）/ **2026-10-02**（数据结构对齐，第二轮） | 卷首三段修订说明 |
| 127 | 需求方口径日期 **2026-09-30** / **2026-10-02** | D18 / D24 等 |

### 3.9 颜色与主题（文档中**没有**十六进制色值）

- `tone` 只给**色档词**：`AgentLogFacts.status.tone` = `'pending' | 'running' | 'ok' | 'failed' | 'canceled'`；`DomainFact.tone` = `'default' | 'success' | 'warning' | 'error'`。
- 唯一具名主题变量：`--app-muted`（呼吸点用）。
- 唯一具名 CSS 类：`.aieval-activity-sweep`（扫光，已在 `globals.css`）。
- 样式硬口径（AGENT.md）：走 antd 的主题 token / 紧凑密度 / 语义 `styles`；**不手写字号、不手调行内边距、避免裸写 `div`**。
- **一条允许的例外**：`ui` 包**一个 CSS 文件都没有**——§6.7 的扫光、呼吸点、流式光标三处**只能**以类名形式实现，并由 `apps/web-next` 的既有守卫（`global-styles.test.ts` 那类）核对类名与 keyframes 两边一致；这三处**不写字号、不写行内边距**，只写动效与结构性属性。

---

## 4. §11 验收标准（逐条）

**第一组 1–23（初版 + 第一轮修订）**

| # | 一句话 |
|---|---|
| 1 | 行卡片按钮与抽屉标题都用「执行日志」 |
| 2 | 抽屉打开即定位到最新一轮；顶部事实进度条常驻可见（滚动时不跟着走） |
| 3 | 每轮的块按 `思考 → 工具调用 → 正文` 顺序呈现；正文是 markdown 渲染的结果；思考与工具组默认收起且可展开 |
| 4 | 连续的工具调用合成一个「工具调用 × N」面板；面板内一行一条工具；**点某一行**才出完整命令/参数/结果 |
| 5 | 进行中的工具组默认展开；失败的工具组与失败行默认展开 |
| 6 | 主会话里 `spawn_agent` 的轮次**同时**出现「工具面板里的一条 `spawn_agent`」与「可点的子任务占位条」；点子任务条或面包屑下拉都能进子任务，且子任务的时间轴渲染与主会话**逐字同形**（同一个组件） |
| 7 | 任务名为空的子任务显示 `子任务 <id 前 8 位>`，**不出现空白** |
| 8 | 几百轮下 DOM 中轮次节点数恒定在**十几条**（`已渲染 N / 共 M 轮` 可见）；跳轮器能直达任意轮；**进度条的轮次与时间轴的轮次数同源同值**（都用数据层给的统一 `round`，厂商 `message.turn` 不参与分组）。**⚠️ 2026-10-02 更正**：初版写的是「跨三家可比」，与规范相反——规范逐字「不要把某家偏高的近似值当成另一家的等价物」（codex 的近似计数**系统性偏高**），故本条口径是「**同一份口径下的同源同值**」，跨家对比时按 `source` 标注（D1 / D27） |
| 9 | 用户向上滚动后，新事件不再把视口拽走，右下角出现「回到最新」 |
| 10 | 「原始输出」能查到全部 `log` 原文（含 `[codex]` 那几行），且默认收起；**无法归一的厂商载荷走 `attachment` 块**（⚠️ 与 D31 冲突，见 §12） |
| 11 | 正在跑的行：打开抽屉后再产生的新消息**能实时出现在时间轴上**（数据层的单一合并流生效） |
| 12 | **流式连续追加不卡**：一行持续输出时键入过滤条件、拖动滚动条都跟手；且**一次上游提交只走一次重建**（§7.1 的 (a)(b)(c) 三条同时成立） |
| 13 | **动态感可见**（§6.7）：跑动期思考标题扫光、正文末尾有光标、进行中的工具行状态在动；**块一结束四处动效全部停下**（静止 = 已确定） |
| 14 | 「下载台账」导出的是 `formatEventLog` 的全文；README 的「逐字一致」口径已改 |
| 15 | 还没跑过的行打开抽屉显示 `EmptyState`（措辞与今天一致）；读盘失败仍整段替换为错误提示 |
| 16 | 折叠面板、面包屑、过滤、跳轮次、开关、状态徽标**全部用 antd 组件**（§9.6 选型表逐条对齐），没有自己手写的折叠箭头与手调字号 |
| 17 | **环境抽屉**（§6.8，通用组件）：`？` 按钮打开后能看到摘要（智能体 / 模型 / 强度 / 供应商 / 工作区 / 基线）与按提示词栈分层的分组；「厂商系统层」与「运行配置」各自标了来源；「已调度的工具」与「用过的工具」**不在同一组**；缺失项显示原因而不是空白；**组名与顺序来自数据层**（组件里没有硬编码的组名） |
| 18 | 环境抽屉随主抽屉一起消失（**结构保证**：它是 `AgentLogLayout` 的子组件） |
| 19 | **计划清单卡片**（§5.4）：`todo_write` / `update_plan` 的那一轮出现一张面板，标题带 `3/5 完成` 与本次变化（`+1 完成`），清单逐项带状态（含 `unknown` 不显示成成功）；**同一轮多次更新只画最后一张**，更早的收在「本轮另有 N 次更新」里；首次出现默认展开、其后默认收起，展开任一张都能看到整表 |
| 20 | **问答卡片**（§5.5）：提问那一轮出现一张卡片，逐问题给出选项（`recommended` 打了「推荐」、`multiSelect` 标了「可多选」、`allowOther` 有「其它（自由输入）」行），答案按**选项标签**回填；`secret` 的问题默认遮罩 |
| 21 | **等待与七态**（§5.5）：没有答案的提问显示「**等待答复中…**」并**在走秒表**，固定区同时出现 `等待答复 12m`；七种收场各自的文案与样式正确，其中 `unavailable` **不是红色错误**且写明「本仓无人应答，是已知边界」；轮次结束而结果没到时显示「结果未采集」而不是一直转圈 |
| 22 | **两族卡片都从工具组里提出**（§4.2）：组标题的 `工具调用 × N` 与实际列出的行数**一致**；族载荷缺失时该次调用**回退成普通工具行**（不消失、不留空卡片） |
| 23 | `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条全绿；**§10 表里逐行的用例全部到位**（**不写死文件个数**——本轮既有新增文件也有改名，写一个数字就会随下一次改动过期；判据是「§10 的表与实现逐行对齐」） |

**第二组 24–28（2026-10-02 新增「可重组」验收，对应 §2.1 五个场景，逐条给可判定形式）**

| # | 一句话 |
|---|---|
| 24 | **S1 · 内嵌只读视图**：在**不套 `<Drawer>`** 的前提下，用 `AgentLogLayout`（或更低的 `AgentMessageTimeline`）渲染同一份 `AgentLogModel`，**时间轴与固定区逐字同形**；且此时**不存在** `.ant-drawer` 节点。**判据**：`agent-log-drawer.test.tsx` 里有一条「同一份模型分别经 `AgentLogDrawer` 与 `AgentLogLayout` 渲染，时间轴区 DOM 逐字一致」 |
| 25 | **S2 · 换模型来源**：`AgentLogSource` **一个方法都不给**时，抽屉照常打开、时间轴照常渲染，只有「环境信息 / 原始输出 / 重试」三处如实降级（「未提供」/ 无入口 / 无重试按钮），**不出现崩溃、不出现永远转圈的 `Skeleton`** |
| 26 | **S3 · 子块独立挂载**：`agent-log/` 下**每一个 L0 件都能在测试里被单独 `render()`**——给定 props 即出画面，不经过 `AgentLogDrawer` / `AgentLogLayout`；且**没有一个 L0 件内部存在 `useState`**（§9.0 纪律 2，由 `agent-log-layering.test.ts` 静态钉住） |
| 27 | **S4 · 扩展零改动**：新增一类块 = **不改** `agent-message-timeline.tsx` / `agent-log-layout.tsx` / `agent-log-drawer.tsx`（`agent-log-layering.test.ts` 用文件哈希或 import 断言钉住）；新增一个工具条动作 = **只传 `actions`**，同样不改上述三个文件。外部消费方还能通过 `BlockRendererProvider` 叠加渲染器而**不动默认表** |
| 28 | **S5 · 换交互形态做得出来**：`MessageTimeline` + `BlockRendererProvider` + `ToolbarAction[]` + `AgentLogSource` 四个接缝齐全，且**虚拟列表只在 `virtual-turn-list.tsx` 里出现**（`agent-log-layering.test.ts` 的 (d) 条）。**本期不验收任何具体的新形态**——验收的是「接缝在、且层没塌」 |

**第三组 29–35（2026-10-02 第二轮新增「展示完整性」验收，对应 D27–D38；每条都是「界面能说出那句话」的可判定形式）**

| # | 一句话 |
|---|---|
| 29 | **谁说的能看出来**（D27 / §6.9）：同一轮里，智能体的正文**不带**角色标签；用户消息带「用户」、厂商 system 内容带「系统」且降一档；三者**不再逐字同形** |
| 30 | **实时与补录能分开**（D27 / §6.9）：`source !== 'wire'` 的块带角标（`session-file` → 「补录」、`aggregate` → 「汇总」）；**codex 的思考正文（来自会话文件）在界面上不再与实时正文长得一样** |
| 31 | **收尾状态不是猜的**（D27 / §6.7）：一次**被中断**的回复——光标与扫光**立刻停**，且**不**显示成「还在流」；`buildRenderBlocks` 的入参里没有「轮次是否结束」这一信息，故它**不可能**做这个推断（由 `render-blocks-streaming.test.tsx` 钉住） |
| 32 | **「为什么缺」能说出来，且三句话不同**（D28）：工具结果那一格——`toolResult` 能力位存在，§9.7 的 `missingReason` **不再恒为 `null`**；界面把「这家结构上不支持」/「厂商有数据但没投送」/「我们还没接」/「没验证过」显示成**四句不同的话**；`capabilityNotes` 非空时显示路由/模型前提 |
| 33 | **「族认得但没收编」与「不认识」能分开**（D29 / §5.4）：两种情形都回退通用工具行，但**文案不同**；`family` 为空才是「不认识」 |
| 34 | **子任务一行能看全**（D32 / D33 / §6.3）：占位条与节点详情给得出**状态（七档，含「未收场」）· 派发方式 · 结果摘要 · 自己的用量**；`statusMissing` 非空时**同时**显示状态与「状态未采集」；**一个被强杀的子任务不显示成「运行中」**；`kind: 'row'` 的节点出计数行、**不进面包屑也不可点** |
| 35 | **三种「空」分得开**（D38 / §6.1）：① 还没跑过 → `EmptyState`；② 这一类内容没被转发 → 「该子任务的对话未转发」/「运行期只有派发事件与状态」；③ 内容被上限截断 → `contentTruncatedReason` 那句话。**三者互不冒充** |

---

## 5. 变异体验证（(a)–(x) 共 24 条：编号 + 它要拦什么缺陷）

> 本仓硬口径：**没见过失败的守卫不算守卫**。分三批：**(a)–(m)** 是 §8.1 那一轮立的；**(n)–(r)** 是**分层那一轮**新增的；**(s)–(x)** 是**第二轮（数据结构对齐）**新增的。

| # | 变异（把缺陷造回去） | 它要拦的缺陷 / 必须变红的守卫 |
|---|---|---|
| (a) | 把 `callId` 配对改成「按出现顺序两两配对」 | 配对错位被静默吞掉（§13 有对应风险行） |
| (b) | 把 `running` 的组默认展开改回收起 | 「这一步正在干什么」被折叠吞掉（§6.1 例外 1） |
| (c) | 把 `usage` 创新高判断去掉（每轮都进时间轴） | 同一条累积快照被重复几十遍（§5.2「创新高」规则） |
| (d) | 把 `thinking.text === null` 的空面板改回空串渲染 | 空面板被读成「思考了但什么也没想」（§6.1 例外 3） |
| (e) | **把折叠键从 `ContentBlockBase.id` 改回数组下标** | 追加一轮后「我展开的那条自己合上了」（§6.1 / §13） |
| (f) | **把 `running` 改成由「有没有 `output`」推断** | 「结果未采集」被显示成「正在跑」（§4.2 硬规则） |
| (g) | **把「已调度的工具」与「用过的工具」并成一组** | 读成「它用了 30 个工具」（§4.3 / §13） |
| (h) | **把组名硬编码进组件、忽略数据层给的 `EnvGroup.title`** | 新增一层时组名不变（§4.3 / §6.8 内容布局 2） |
| (i) | **把 `AskUserAnswer.selected` 的匹配从「选项标签」改成「数组下标」或「option id」** | 答案看起来有、其实错位——**最难发现的一类错**（§5.5 口径 1） |
| (j) | **把「还没收场」并进任何一态显示**（初版形态是 `outcome: null`；现在应把 `AskUserPending` 并进 `AskUserSettled`） | 「还在等」被说成「已经收场」（D21 / D35 / §5.5） |
| (k) | **把两族卡片改回留在工具组内** | 组头的 `工具调用 × N` 与实际列出的行数不一致（§5.4 规则 2 / §11 验收 22） |
| (l) | **把 `owner === null` 显示成「未指派」** | 编造了这一家没有的概念（§5.4 四种情形表） |
| (m) | **把同轮多次 `task` 调用画成多张面板** | v2 spec 的「只画最后一条结果，历史折叠」被破坏（§5.4 规则 3） |
| (n) | **把虚拟列表塞回 `agent-message-timeline`**（或让 L1 去 import `@rc-component/virtual-list`） | 层塌：`agent-log-layering.test.ts` 的 (c)(d) 两条必须红，且 `agent-message-timeline.test.tsx` 的「50 轮渲染出 50 轮」必须红。**这一条是 S5 与 §7.2 的共同守卫** |
| (o) | **把 `BlockRendererProvider` 改成「整体替换默认表」** | 「扩展一下就把默认渲染器弄丢了」——页面上表现为**大面积空白**、控制台只有一句 `undefined is not a function`，很容易被误判成数据没到。注册表用例的「默认七臂仍可用」必须红 |
| (p) | **把 `AgentLogLayout` 改成忽略传入的 `actions`、恒用预设** | 否则 S4 的「新增动作」只是纸面承诺。工具条预设用例的「传了 `actions` 时用传入的」必须红 |
| (q) | **把某个 L0 件从受控改回 `useState`**（例如 `thinking-block-view` 自己记住开合态） | S3 的守卫：`agent-log-layering.test.ts` 的 (e) 必须红，且该件的独立挂载用例必须红 |
| (r) | **在 L0 里加一句按厂商分支**（例如 `task-panel-card` 判 `agentKind === 'claude'` 才画 `owner`） | §4.1 纪律 5 的目录级落实：`agent-log-layering.test.ts` 的 (f) 必须红 |
| (s) | **把 `role` 固定成 `'assistant'`**（或干脆不渲染角色标签） | `block-role-label.test.tsx` 的 `user` / `system` 断言必须红。**拦的是「用户在读一份不知道谁在说话的记录」** |
| (t) | **把三种缺失原因写成同一句话** | `capability-notes.test.tsx` 的「四句互不相同」必须红。拦的是「把『这家没有』说成『我们没接』」 |
| (u) | **把 `unrecognized` 与 `attachment` 合成一条渲染路径** | 两条断言必须红（一张图片被画成 base64、或一段原始载荷被画成附件） |
| (v) | **把 `LogNodeStatus.unsettled` 归并进 `running`** | 断言必须红。**拦的是「一个已经被强杀的子任务永远显示运行中」**——读的人会一直等一个不会来的收场 |
| (w) | **把 `summary ?? text` 写进原始输出面板** | `log-summary-line.test.tsx` 必须红。规范逐字禁这一条（「消费方不得拿 `text` 顶替」） |
| (x) | **把 `TruncationState.unknown` 与 `none` 走同一分支** | `truncation-unknown.test.tsx` 必须红。**这一条是 D30 的全部意义**：裸布尔时代「没采到标记」与「确认完整」在界面上完全一样 |

**源文档对三批变异体的定性（必须留住）**：

- **(n)–(r) 必须单列的理由**：(a)–(m) 全部是**行为**守卫（拦「画错了」）；(n)–(r) 拦的是「**层塌了**」——塌掉之后 (a)–(m) 可能**全绿**（界面看起来还是对的），但下一个消费场景接不进来。**这正是「可重组」这件事唯一能被自动验的形式**。
- **(s)–(x) 六条的共性**：拦的都是「**用乐观值填补缺失**」——没采到状态就说「还在跑」、没采到截断标记就说「完整」、认不出原因就说「这家没有」。这与 (f) 是**同一条纪律的六个面**，也是本设计与「看起来采到了」长期对抗的那条主线。

---

## 6. 测试计划（§10：文件名 → 覆盖点）

### 6.1 主表（21 行）

| # | 文件 | 覆盖点（关键词） |
|---|---|---|
| 1 | `ui/.../render-blocks.test.ts` | `buildRenderBlocks`：callId 配对成功 / `callId` 为 null 降级 / 配不上的 result 独立成条 / 连续工具合并 / 中间夹 text 则**不**合并 / **被调用 `turns.length` 次而非一次**（`vi.fn()` 计数，§7.2 护栏）/ codex「一个 item 拆成 call+result」/ **`running` 与失败组的默认折叠态**（§6.1 例外）/ **两族卡片从工具组提出并切断合并链**（前后各成一组，组头 `工具调用 × N` **不含**提出去的调用）/ **同轮多次 `task` 只出最后一张面板 + 底部「本轮另有 N 次更新」** / **族载荷缺失（`tool === null`）回退成普通工具行**（不消失、不空面板）/ **`family` 非空但 `tool` 为 null 时也是通用工具行**（D29）/ **块按 `kind` 判别分派（`assertNever` 兜底）**：六类块各自字段只在自己那一支可读 / **`spawnedBy` 命中节点在同一轮对应位置出 `subagent-bar`**；`callId` 为 null 或命不中时挂轮末而**不是**丢掉 / **`round === null` 的轮次进「未归属」段**而不是被过滤掉 / **`kind: 'row'` 出 `row-summary` 臂而不是 `subagent-bar`**（D32） |
| 2 | `ui/.../render-blocks-streaming.test.ts`（**2026-10-02 新增**） | **D27 护栏，专测「收尾标记从哪来」**：`buildRenderBlocks` **不碰** `delta` / `snapshot` / `block.index` / 合并键（§4.2 职责边界）/ 对同一批块**只做转发**、**不读** `chunk` 类字段 / **`assembly === 'open'` 的块在 `RenderBlock` 上被如实带出** / `assembly === 'snapshot'` **不带**流式标记 / **`ToolItem.running` 只由 `LogTurn.running` 转发**，不由 `output` 是否存在推断（变异体 (f) 的**结构性**版本：造一个被中断的轮次，「结果未采集」必须仍显示为静态灰字） |
| 3 | `ui/.../agent-log-layering.test.ts`（**2026-10-02 新增**） | **三层边界纪律的可执行形式**（§9.0）；**静态扫描而不是渲染断言**——用 `fs` 读 `agent-log/` 源文件、按层查 import 说明符：(a) L0 **不得** import L1/L2；(b) L1 **不得** import L2；(c) L0/L1 **不得** import `@rc-component/virtual-list`；(d) 除 `virtual-turn-list.tsx` 外**不得** import 它；(e) L0/L1 **不得**出现 `useState`（纪律 2）；(f) L0/L1 **不得**出现 `EvalRow` / `agentKind` 字样（纪律 3）。**逐条各有一个变异体** → (n)–(r) |
| 4 | `client/.../row-stream.test.ts` | **投递合并**（§7.1）：同一批多帧只触发一次 `setEvents` / 合并后的结果与逐帧投递**逐条等价**（去重、升序、「seq 回到 1 = 新一代」三条语义不变）/ rAF 不可用时 **200ms 兜底**仍会刷 |
| 5 | `contracts/src/agent-log.test.ts` | **`AgentLogModel` 的类型守卫**：类型层只依赖契约（不 import `ui` 之外的东西）/ `Loadable` 三态不接受自相矛盾组合 / 夹具构造的模型通过类型检查。（**模型组装属 B 段**，此处只钉形状不钉行为） |
| 6 | `ui/.../agent-message-timeline.test.tsx` | **L1 用例（不掺虚拟化、不掺 subagent）**：思考默认收起 / 工具组默认收起 / `running` 的组默认展开 / `error` 的组与行默认展开 / `thinking.text === null` 显示缺失原因而非空面板 / `text` 块走 markdown（`MarkdownText` 挂载）/ 子任务占位条渲染且不折叠 / **`streaming` 时挂扫光类名与光标容器类，转 false 后类名被摘掉**（§6.7）/ **`renderBlock` 不传时走默认注册表、传了就用传入的分派**（§9.2）/ **逐轮 `map`：`turns` 有 50 轮时 DOM 里就有 50 轮**（钉「L1 不虚拟化」——变异体 (n)） |
| 7 | `ui/.../log-node-breadcrumb.test.tsx` | 链由 `parentId` 回溯派生（换 `activeNodeId` 即换链）/ 段数与顺序 / 当前段 `aria-current` / 下拉列的是**同层兄弟**（不是全树）且当前项 `disabled` / 任务名为 null 时显示 id 前缀兜底 / `kind === 'row'` 的节点不进面包屑 |
| 8 | `ui/.../agent-log-facts-bar.test.tsx` | 各事实格的空值不显示成 `0` / 错误格存在时可见 / **耗时用 `useNow` 本地走秒表**（`startedAt` 在、`endedAt` 为 null 时数字在涨；终态用 `endedAt − startedAt` 结算值）/ **思考 token 只在与 `tokens` 并列的那一格显示**，`basis !== 'additive'` 时**不提供任何相加口径**、`null` 时不显示「0」/ **`facts.domain` 按数据层给的顺序渲染**，空数组时不出这一行，`label` / `value` / `hint` 一字不改地照画（UI 不解析值）/ `status.label` 照数据层给的文案渲染、`tone === 'running'` 时才带动效 / 「等待答复」徽标只在真的在等时出现（§5.5）。**原始输出入口的用例已移出**（归下两行） |
| 9 | `ui/.../raw-output-panel.test.tsx`（**2026-10-02 新增**） | **§9.7 提升出来的原语，两种变体各测**：`AgentLogDiagnostics` 变体逐行渲染 `[HH:mm:ss] source + 原文`（复用 `log-format` 措辞）/ `lines` 空数组时**不渲染入口** / `loading` 给 `Skeleton`、`error` 给 `Alert` + 重试且 `onRetry` 未给时**不渲染重试按钮** / `truncatedReason` 非空时如实显示那句话 / **`ToolCardResult` 变体（卡片底部）与逐行变体共用同一个件**：`raw === null` 时显示「结果未采集」而不是空白 / `secret` 类遮罩由调用方决定（本件不做脱敏，§5.5） |
| 10 | `ui/.../agent-run-state-tag.test.tsx`（**2026-10-02 新增**） | **§4.2「`running` 不可由 `output` 推断」的唯一分派处**：`running === true` → 转圈 + 走秒表（fake timers 涨数）/ `running === false && !hasResult` → **静态灰字「结果未采集」且不带 `Badge status="processing"`**（变异体 (f) 的核心断言就在这一行）/ `hasResult === true` → 不显示状态（已确定的事不占地方）/ `missingReason` 非空时把那句话带上 / **`since` 为 null 时不挂定时器**（终态不涨） |
| 11 | `ui/.../block-renderer-registry.test.tsx`（**2026-10-02 新增**） | **D25 守卫**：`DEFAULT_BLOCK_RENDERERS` 七臂齐全，逐个 `kind` 都渲染出对应元素 / **`BlockRendererProvider` 追加一个自定义 `kind` 后，默认七臂仍然可用**（叠加而不是替换）/ **覆盖已有 `kind` 时以 Provider 为准**（覆盖是整体替换那一臂）/ 无 Provider 时 `useBlockRenderers()` 返回默认表 / **变异体 (o)** |
| 12 | `ui/.../agent-log-drawer.test.tsx` | **原 `agent-log-view.test.tsx` 的用例全部保留**（只是文件名与宿主组件跟着 D24 改）：`empty === true` 时出 `EmptyState` 而不是空时间轴 / 切节点时内容未到显示 `Skeleton`、读失败出 `Alert` + 重试 / 过滤后不含目标块的轮次整轮隐藏 / 同名两处「跟随最新」state 只有一份（开关与浮出按钮同步）/ **主抽屉关闭时第二层抽屉一起关**（§6.8 联动 1）。**新增两条**：`source` 全不给时各入口仍照常工作（「未提供」而不是崩溃，§4.4 口径 1）/ `timeline` 槽传 `MessageTimeline` 时**不渲染「已渲染 N 共 M 轮」**（§7.2） |
| 13 | `ui/.../agent-environment-drawer.test.tsx` | **`agent-log` 内部件的用例**：摘要各项与分组按数据层给的 `title` / 顺序渲染 / 四种 `source` 各有标签 / `present: false` 渲染成「标签 · 原因」而**不是空白** / `truncated` 非空时出截断提示与「复制全部」/ **「已调度的工具」（vendor）与「用过的工具」（observed）在两组** / **用户提示词不出现在环境抽屉里**（D19）/ 加载中 `Skeleton`、失败 `Alert` 重试 / `environment === undefined` 时显示「未提供」而不是空白 / **主抽屉关闭后环境抽屉不在 DOM 里**（结构性保证，钉一条防回归） |
| 14 | `ui/.../tool-group-panel.test.tsx` | 组头文案（`工具调用 × N` + 名字汇总 + 状态汇总）/ 工具行摘要 / 展开后出 `ToolItemDetail` / 超长结果截断并给「展开全部」 |
| 15 | `ui/.../task-panel-card.test.tsx` | 计数与变化摘要**照数据层给的渲染**（UI 不自己算）/ 四态 Tag（`unknown` **不显示成成功**）/ `steps` 空数组显示「清单为空」而不是空白面板 / `owner === null` **不显示这一格**、`owner === ''` 显示「未指派」/ `id === null` 时不画 id 与依赖 / 首次（`change === null`）展开、其后收起且标题带摘要 / `running` 与结果未采集时默认展开 / 同轮更早的调用收进「本轮另有 N 次更新」/ `note` 有值时出现在标题行 |
| 16 | `ui/.../ask-user-card.test.tsx` | **`state: 'pending'`** 显示「等待答复中…」+ 计时在涨（fake timers）+ **不显示任何收场文案** / **`state: 'pending'` 且 `running === false`** 显示「结果未采集」而**不是**一直转圈（D35）/ 七态各自的 Tag 与中文 / `unavailable` **不是红色错误样式**且写明「无人可应答、已知边界」/ **答案按 `label` 回填（不是 id、不是下标）** / 多选时 `custom` 补充、单选时覆盖 / `selected` 里的未知标签**照样显示** / `recommended` 打 Tag 但**顺序不变** / `allowOther` 追加「其它（自由输入）」/ `secret` 默认遮罩 + 「显示」按钮可展开 / 等待状态默认展开、已收场默认收起、`timeout`/`unavailable`/`rejected` 默认展开 |
| 17 | `ui/.../virtual-turn-list.test.tsx`（**2026-10-02 新增**） | **§7.2 护栏落在这里**：`buildRenderBlocks` 被调用 `turns.length` 次而不是一次（`vi.fn()` 计数——jsdom 里虚拟列表仍只挂载可见项，这条断言是**唯一**能在单测里拦住「先全建再渲染」的地方）/ `scrollTo({ index, align: 'top' })` 被转发到列表实例 / 「已渲染 N / 共 M 轮」用 `onVisibleChange` 的 N 渲染 / **同一份 `data` 引用下父组件重渲染不触发重新测量**（§7.1(a)：`useMemo` 挂在 `turns` / `activeNodeId` 上） |
| 18 | `ui/.../agent-log-toolbar-preset.test.ts`（**2026-10-02 新增**） | **D26 守卫**：「原始输出」在 `diagnostics.lines` 为空时 `visible === false` / `diagnostics` 为 `undefined` 时该动作的显隐（与 §5.3.1 一致）/ 「跳到轮次」的 `min` / `max` 来自 `turns.length` 且越界 clamp 后**如实回显**（§6.5）/ 「跟随最新」的 `toggle.checked` 与浮出按钮**是同一个值**（不出现两份 state）/ 「只看工具调用」命中含 `task` / `ask-user` 的轮次（§6.5）/ **`AgentLogLayout` 传了 `actions` 时用传入的、不传时用预设**——变异体 (p) |
| 19 | `apps/web-next/src/log-drawer-state.test.ts` | 既有三态判定保留；新增「`log` 事件不再进时间轴」的接线断言 |
| 20 | `apps/web-next/src/runs-page-wiring.test.ts` | 既有守卫保留；新增「`AgentLogDrawer` 吃到的是 `buildAgentLogModel` 的产物」（初版写的是 `AgentLogView`，D24 后该名不再使用） |
| 21 | `eval-row-card.test.tsx` | 按钮可访问名逐字改「执行日志」，**顺序断言不变** |

### 6.2 第二轮新增的守卫文件（7 行，钉 D27–D38）

| # | 文件 | 覆盖点（关键词） |
|---|---|---|
| 22 | `contracts/src/agent-log-shape.test.ts` | **D27–D37 的契约形状守卫**（类型层，node 环境）：`MessageSource` / `MissingReason` / `CapabilityLevel` **三者取值集合逐字固定**（加一个值必须改测试）/ `CapabilityDecl` **配对不变量**（`level === 'yes'` ⇒ `source` 非空且 `reason` 为 null；否则反之）/ `LogNodeStatus` **七档**（含 `stopped` 与 `unsettled`）/ `TruncationState` 三态**不接受** `{ kind: 'none', reason: 'x' }` 这类多余组合 / `AskUserInteraction` 两支**不接受** `AskUserPending` 带 `outcome` / `LogNode` 两支**不接受** `RowNode` 带 `content`、`SessionNode` 带 `facts` / `TaskPanel.counts` 四格**必须齐全** |
| 23 | `ui/.../block-role-label.test.tsx`（**新增**） | **§6.9 角色标签与来源标注**：`role === 'assistant'` **不标注** / `user` 出「用户」Tag / `system` 出「系统」Tag 且用 `secondary` / `source === 'session-file'` 出「补录」Tag、`'aggregate'` 出「汇总」Tag、`'wire'` **不出** / **`textKind === 'summary'` 出「摘要」Tag**（初版这一格只有类型注释、全篇没有文案落点）/ `contentTruncatedReason` 非空时那句话可见 / **变异体 (s)** |
| 24 | `ui/.../capability-notes.test.tsx`（**新增**） | **D28 的界面落点**：`capability` 按数据层给的**顺序**渲染、**UI 不硬编码维度名**（塞一个 `{ myNewDim: … }` 也要画出来）/ 五个已知维度各有中文标签与**原因文案**：`no → 「这家结构上不支持」`、`not-projected-by-vendor → 「厂商有数据、但没投送到我们能读的通道」`、`off-by-adapter → 「厂商有、我们还没接」`、`unverified → 「没验证过」`（**四句必须互不相同**）/ `capabilityNotes` 非空时如实显示（「能力随路由/模型变化：…」）/ `level === 'yes'` 的那一格**不显示原因** / **变异体 (t)** |
| 25 | `ui/.../attachment-block.test.tsx`（**新增**） | **D31 的界面落点**：`image` / `file` 各自的 Tag 与路径、MIME / `path === null` 显示「内联内容，无路径」而**不是空白** / **缩略图不加载**（断言不出现 `<img>`）/ `unrecognized` 块渲染成折叠的 `raw` 等值原文且**默认收起** / **变异体 (u)** |
| 26 | `ui/.../node-kind-render.test.tsx`（**新增**） | **D32 / D33 的节点形态**：`RowNode` 出 `row-summary`（**计数与状态都可见**，`counts === null` 时如实说明而不是空白）/ `RowNode` **不进面包屑、不可点**（无 `subagent-bar`）/ `SessionNode` 的子任务占位条显示 `dispatchKind`、`outcome`、`usage` 三格（拿不到时各显示「未采集」而不是空白，`usage` **主会话为 null 时不显示这一格**）/ `status` 六档**各有一句中文**，其中 **`unsettled` 与 `running` 必须是两句不同的话**（「等不到了」vs「还在等」）/ `statusMissing` 非空时**同时**显示状态与「状态未采集」（两句并列）/ **变异体 (v)** |
| 27 | `ui/.../log-summary-line.test.tsx`（**新增**） | **D37**：`summary` 非空时它**优先**渲染且 `text` 原文**仍在**（两者都给）/ `summary === null` 时**不拿 `text` 顶替**（不额外渲染一句像是摘要的话）/ **变异体 (w)** |
| 28 | `ui/.../truncation-unknown.test.tsx`（**新增**） | **D30**：`kind: 'none'` **不显示**截断提示 / `kind: 'truncated'` 显示提示 + `reason` / **`kind: 'unknown'` 显示「输出可能不完整」且绝不显示「完整」**——这是 `truncated: boolean` 时代**表达不出来**的那一格 / **变异体 (x)** |

### 6.3 jsdom 验不出、必须靠真实浏览器冒烟（标题写「五项」，实际列 6 项）

1. 虚拟列表的滚动几何：`scrollTo({ index, align: 'top' })` 后目标轮的 `getBoundingClientRect().top` 落在视口顶部（**±2px**）；
2. 展开一条嵌套折叠面板后，**下方轮次的滚动位置不跳**（D9 的全部理由）；
3. 跟随最新的自动关闭：向上滚一屏后新事件到达，视口不再移动，且浮出按钮出现；
4. 明暗两态下展开/收起的面板底色与边框都可读；
5. **动效的可见性**（§6.7）：流式期间思考标题在扫光、正文末尾有光标；块一结束两处都停。（jsdom 只看类名在不在，**「动没动」要看真实浏览器**。）
6. **流式不卡**（§7.1）：让一行持续输出时，键入过滤条件与滚动**不被拖慢**；React DevTools 的 Profiler 里确认「一次上游提交只走一次重建」。

---

## 7. 界面结构描述（§5 三区结构 + §6 全部交互规则条目）

### 7.1 §5 抽屉内容的三区结构（结构图逐行留全）

```
┌─ Drawer（title 恒为「执行日志」，宽度 max(50vw, 800px)）─────────────┐
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
│    行级事实：错误条目 / 用量里程碑（`rowEvents`）                     │
│ ③ 浮动件：未读时右下角「↓ 回到最新（N 轮未读）」                       │
└──────────────────────────────────────────────────────────────────┘
```

**§5 的注**：`log-format.ts` 的 `formatEventLine` / `formatEventLog` **不改语义**，继续服务「下载台账」。新增的只是 `message` / `subagent-*` 三类事件的文本行（v2 spec §10 已列）。

### 7.2 §5.1 几何（沿用既有口径，一处例外）

- 宽度仍是 `styles.wrapper = { width: 'max(50vw, 800px)', maxWidth: '100vw' }`，`size` 不传。
- `styles.body.padding` 仍是 `0`（2026-09-29 spec §7.2.1 ②）。
- **例外（唯一的修订）**：滚动容器不再是 `.ant-drawer-body`。`AgentLogLayout` 最外层取满父容器的全部高度（`height: '100%'`，**不是 `minHeight`**），固定区占自然高度，虚拟列表用 flex 取剩余高度并自持滚动。
- **「取满父容器」而不是「取满 `body`」是 2026-10-02 的一处措辞修正**：D24 之后套 `Drawer` 的是 `AgentLogDrawer`，内嵌场景（S1）没有 `body` 可满——几何口径不变，只是参照物从 `body` 改成宿主容器。

### 7.3 §5.2 行级事件的去向（逐条，不留洞）

| 事件 | `facts` | `rowEvents`（时间轴） | 原始输出（§5.3.1） | 说明 |
|---|---|---|---|---|
| `status` | 最新值 | 否 | 否 | 「正在跑」是当前态，历史态没有信息量 |
| `usage` | 最新值 | **仅当令牌数创新高** | 否 | 见下 |
| `diff-summary` | 最新值 | 否 | 否 | 只在终点有意义 |
| `score` | 最新值 | 否 | 否 | 同上；详情在「评分详情」抽屉 |
| `error` | 最新值 | **是（恒）** | 否 | 失败归因不能只留最后一条 |
| `end` | exitReason | 否 | 否 | 终态 |
| `log` | 否 | 否 | **是（全部）** | D14 |
| **消息层非致命告警**（codex 的 item 级 `error`） | 否 | **是（`level: 'warning'`）** | 否 | 2026-10-02 新增（D34）：规范明文「item 级 `error` 是**非致命告警**（例如『有无法识别的配置项』），**不得当成运行失败**」。它既不是块（`ContentBlock` 六臂里没有它）、也不是编排层事件，初版**没有出口** |

- **两族卡片不进 `rowEvents`**：`task` / `ask-user` 是**消息层的内容**（`message` 事件里的块），按轮次落在时间轴上（§5.4 / §5.5），与这张表里的编排层事实不是一类东西。D23 的「等待输入」徽标同理——它是**当前态**，而 `rowEvents` 装的是发生过的事件。
- **`usage` 的「创新高」规则**：`usage.tokens` 是**累积快照**（v2 spec §5 的覆盖语义），每轮发一条会把同一条信息重复几十遍。故只在「本次三项之和超过此前最大值」时追加一条 `milestone`——它的语义是「上下文又长了一截」。`turns` 不追加（进度条已经有当前值）。

### 7.4 §5.3 `log` 与原始载荷的去处（三种东西的所有者划分，4 行）

| 内容 | 归谁 | 界面出口 |
|---|---|---|
| `log` 事件（适配层的 stdout/stderr、未识别信封） | **可读的原始文本** | 「原始输出 N 条 ▾」——固定区一个 `Collapse ghost`，正文用 `MonoText` **逐字原文**，`data-testid="agent-log-diagnostics"`；数据由 **`AgentLogDiagnostics`** 承载（§5.3.1） |
| 无法归一的厂商载荷 | **块** | `unrecognized` 块（**已经有主**，与文本块同处时间轴，默认折叠，见 §6.1）。**不再另开出口** |
| 真实附件（图片 / 文件） | **块** | `attachment` 块（2026-10-02 起**才**与规范同名同义，见 D31；界面落点见 §6.10）。**它不是「无法归一的载荷」**——两者初版共用一个类型名，现已拆开 |
| 完整事件台账 | **归档** | 只有「下载台账」一个出口（§6.6）。它是台账，不是视图 |

**为什么这样分**：`attachment` / `unrecognized` 都已经有类型化的家（规范 §5.3 的整节就是在论证「别把不认识的载荷塞进文本」）；`log` 是无结构的行，只能在时间轴之外找个地方；台账是给机器/归档的，不该在界面上再摊开一遍。

**§5.3.1「原始输出」的形状与取数时机**（本节是 2026-10-01 修订补的）：
- 初版把 `diagnostics` 从模型里删掉（理由写「不属于渲染模型」），但**没有给它任何替代出口**——而 D14、§5.3 的表、§6.6、§10 的用例与 **§11 验收 10** 都要求它能查到全部原文。**这是一处会直接卡住 A 段验收的洞**，本修订补齐。
- 它是**独立的 `Loadable`，不进 `AgentLogModel`**（与 `AgentEnvironment` 同一条边界）：① **体积**（一次评测的 `log` 行可达几千条，而 §7.1 整节都在说「提交要快」）；② **时机**（面板默认收起，只有展开时才需要）；③ **归属**（它是**这一行**的输出，与「哪个会话节点」无关，故也不必按节点分发）。
- 面板正文按**既有的 `[HH:mm:ss] source + 原文` 形状**渲染——复用 `log-format.ts` 的 `formatEventLine` 那一套措辞，**不改它的语义**。`at` / `source` / `text` 三格分开给，是为了让「哪一段是格式、哪一段是原文」可分辨。
- **⚠️ 依赖数据层的三件事**（写在这里，因为 UI 侧看不出来）：① `log` 原文仍然**必须完整可查**——它是排障证据（README 里「对照 `[codex]` 那几行」的处置路径就靠它）；数据层不得因为「反正 UI 不怎么显示」而丢弃它；**面板默认收起不等于可以不取**：`Loadable` 还没到时如实显示「读取中 / 读失败 + 重试」，不假装「一条都没有」。② **两个事件源的合并是数据层的内务**（原 §5.4 整节删除）：对外只给**一条已合并的流**，合并判据仍是 `seq` 去重 + 升序 + 「回到 1 = 新一代」（`row-stream.ts` 的既有语义），但**这件事不该在页面上做第二次**。③ **行序与全文由数据层定**：`lines` 已是给人看的顺序，`truncatedReason` 非空时如实显示那句话。

### 7.5 §5.4 `task` 卡片：状态化清单面板（界面规则条目）

**定位**：它不是一次工具调用的回显，而是「agent 自述的进度」的当前状态。v2 spec §7.6.4 已定渲染形态（逐字：「**状态化清单面板**：只画**最后一条**结果，历史折叠」），本节只把它落到**轮次时间轴**这个容器上。

**与「派发面板」的边界**（v2 spec §7.6.2.2 的两张面板；混了就是两种事实互相冒充）：

| 问题 | `task` 卡片 | 派发面板（§6.3 的子任务占位条 + 面包屑） |
|---|---|---|
| 回答什么 | 「它**打算**做哪几步、现在到哪一步」 | 「**现在有什么在跑**」 |
| 谁产生 | agent 自己声明（`todo_write` / `update_plan` / claude 的 `Task*`） | 运行时调度（`subagent-start/end`） |
| 更新方式 | **整表**（补丁累积已由适配器收敛，v2 spec §7.6.2 ⑨） | 逐条生命周期事件 |
| 混淆的代价 | 把「计划」读成「已经跑起来的东西」 | 把「跑起来的」读成「计划」 |

**与 `attachment` 的边界（同一份载荷不许画两次）**：未归一的厂商载荷仍走 `attachment` 块（§5.3）——`AttachmentBlock.vendorType` 举的例子就是 `todo_list`。一旦适配器认识了它，它就该**只**以 `task` 卡片出现；判据是**族载荷在不在**，不是「名字像不像任务清单」。两条路都画的结果是同一份清单在时间轴上出现两次、且长得不一样。（⚠️ 此处 `attachment` / `vendorType` 的措辞与 D31 冲突，见 §12）

**卡片结构（自上而下，3 条）**：
1. **标题行**（折叠面板的 `label`）：`计划清单` + 计数（`3/5 完成`）+ **变化摘要**（`+1 完成`）+ 状态（进行中转圈 / 结果未采集的灰字）；`note` 有值时补一行灰字（codex 的 `explanation`：为什么改计划）。
2. **清单体**：每项一行——状态 + 文本 +（claude 才有的）`owner` 与依赖。
3. **底部**：`本轮另有 N 次更新 ▾`（本轮更早的调用）与 `原始结果 ▾`（`MonoText` 原文，默认收起）。

**「计数」与「变化摘要」都由数据层给，UI 不自己算**：UI 按项渲染（§7.2），**看不到上一轮的面板**，跨轮比较它做不到；而数据层本来就有累积态（claude 的补丁累积就发生在那里）。`TaskPanel.change` 与 `counts` 一样是**派生值**——v2 spec 已为 `counts` 立过这条先例（逐字：「计数是派生值，放这里是为了 UI 不必自己算」）。

**位置与折叠（四条硬规则）**：

| # | 规则 | 理由 |
|---|---|---|
| 1 | 从**工具组里提出**，按块序**原地**出现（与 `subagent-bar` 同规则） | 「多了一张清单」与「调用了什么」是两件事；留在组里会被读成「又一次工具调用」 |
| 2 | 提出时**切断工具组的合并链**（前面的合成一组、后面的另起一组） | 组标题的 `工具调用 × N` 必须数得清——把一条调用画成卡片却仍算进 N，就是不实的计数 |
| 3 | **同一轮内只画最后一次** `task` 调用，更早的收进面板底部的 `本轮另有 N 次更新 ▾` | v2 spec §7.6.4 逐字：「只画最后一条结果，历史折叠」。整表语义下，同轮多次调用只有最后一次是有效状态 |
| 4 | **跨轮不去重**：有 `task` 调用的轮就画一张；`change === null`（该节点首次）**默认展开**，其余**默认收起** | 去重要跨轮状态，与 §7.2「按项渲染 + 虚拟列表乱序挂载」相冲；收起态标题已带 `3/5 完成 · +1 完成`，所以收起不丢信息 |

**默认展开的两条例外**（与 §6.1 的例外条款同源）：`running === true`（这次更新还没回来）或结果未采集时**默认展开**且标题写明状态——「正在更新计划」被折叠吞掉，就把唯一的时间信号藏了。

**四种「没有清单」的情形，逐一有明确画面（不留洞）**：

| 情形 | 画面 |
|---|---|
| `steps` 是空数组 | 「清单为空（这家报了空表）」——**不是**空白面板。空表与「没采到」必须分得开 |
| 族载荷缺失（`tool === null`：适配器不认识、或它不在本期两族里） | **回退通用工具行**（v2 spec §7.6.0 的降级：规范化是可选增收，不是必填负担）。这次调用仍在时间轴上，只是没有专门形状 |
| claude 的 `id === null`（v2 spec §11.1 第 27 项：`TaskCreate` 的 `taskId` 来源未定） | **不画 id、也不画依赖**（`blockedBy` 的值就是 id）。**不自己发号**——编出来的 id 会让「依赖」看起来解析成功了 |
| `owner === null` 与 `owner === ''` | 两者**不是一回事**：`null` = 这一家没有「指派」这个概念（**整格不显示**）；`''` = 有概念但当前无人认领（显示「未指派」）。v2 spec §7.6.2 ⑨ 明文要求分开 |

**`TaskStep.status === 'unknown'` 不显示成成功**：四态各有中文与样式（待办 / 进行中 / 已完成 / 状态未知），`unknown` 用中性灰——与 §4.2 的「`ok: true` 但关键字段为 null 不显示成成功」是同一条口径。

### 7.6 §5.5 `ask-user` 卡片：问答卡片（界面规则条目）

**定位**：它是时间轴上唯一「会等人」的东西，而本仓恰恰是无人值守（`approvalPolicy: 'never'`，没有应答面）。故这张卡片的第一职责不是好看，而是**让「卡在等人回答」一眼可见**（D21 / D23）。

**结构与位置**：同样**从工具组提出、原地出现**（§5.4 规则 1 / 2）。结构 5 条：
1. **标题行**：问题数 + 首问的 `header`（没有就给截断到一行的 `prompt`）+ 收场 Tag / 等待状态。
2. **每个问题一块**：`header`（`Tag`）+ `prompt`（正文）+ 选项列表（`recommended` 项带「推荐」；`multiSelect` 标「可多选」；`allowOther` 追加一行「其它（自由输入）」）。
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

**⚠️ 2026-10-02 修订（D35）后本表的读法**：`AskUserInteraction` 分成 `AskUserPending` / `AskUserSettled` 两支后，**本节的表读作「`state: 'pending'` 那一支内部再分两种」**：

| 判据 | 画面 |
|---|---|
| `state === 'pending'` 且 `running === true` | 「等待答复中…」+ **走秒表**的已等待时长（`useNow(active)`：只有等待中的卡片挂计时器，`active === false` 不挂） |
| `state === 'pending'` 且 `running === false`（轮次已结束，结果没到） | 「**结果未采集**」（静态灰字）——**不能一直转圈**，否则一次没采到的结果会被永远读成「还在等」 |
| `state === 'settled'` | 七态各自的文案与样式（上表）；`answers` 已到手，按下面三条口径回填 |

**答案回填的三条口径**（v2 spec §7.6.2 ⑩ 逐字：`selected` 装的是**选项标签**）：
1. **按 `label` 匹配，不按 id 也不按下标**——`selected` 是标签数组，拿 id 或下标去匹配会一条都对不上，而界面上看起来「有答案」。这是最难发现的一类错，故 §10 有专门的变异体。
2. **`custom` 的语义随 `multiSelect` 变**：多选时是**补充**（标签与自由输入都显示）；单选时是**覆盖**（只显示自由输入）。照抄 dsh 的契约原文。
3. **`selected` 里出现 `options` 里没有的标签时**：**原样显示**（多一个 Tag），不静默丢弃、也不报错——配不上是事实；藏起来就成了「答的和问的对不上时界面上看不出来」。

**三处如实登记**：
1. **`secret: true` 的遮罩是显示口径，不是安全边界**：默认 `••••` + 「显示」按钮，但原文仍在结果与事件台账里（「下载台账」拿得到）。**不要把遮罩当脱敏**。
2. **不做美化截断、也不重排选项**：`header` 超过 v2 建议的 8 字符就让它长着——截断会改事实（与 D15「工具名原样透传」同一口径）；`recommended` 的置顶是**厂商给的顺序**，UI 只加一个「推荐」Tag。
3. **不在组件里按「主会话 / 子任务」分支**（§9 纪律 1）：「子智能体不能提问」这件事**只体现为 `outcome: 'rejected'` 与结果原文**。组件若去看节点类型，就把「同一份渲染」这条保证破了。

**这张卡片是只读的复盘视图，不是应答面**：本仓没有应答 handler（`approvalPolicy: 'never'`），所以卡片上**不提供「回答」按钮**——给一个只在某些场景可用的输入框，会让「评测里的提问为什么没人答」更难解释。收场行如实说明是谁（没）回答的（§12 已登记为明确不做）。

**「等待输入」在固定区有一个位置（只在真的在等时出现）**：`等待答复 12m`（`Badge status="processing"` + `Typography.Text`）。范围是**当前节点**（与面包屑的视图作用域一致，D4），判据是那一格里存在 `state === 'pending' && running === true` 的卡片。它**不新增契约字段**：UI 从当前节点的块里线性扫一遍即可，与 §5.2 的「创新高」一样是**纯派生**（存一份就是第二份真值）。子任务节点里的提问按 v2 spec 是**被拒**（`rejected`）而非等待，故正常情况下它不会为子任务亮起；真亮起时切进那个节点就看到它自己那一格。

### 7.7 §6.1 折叠（默认态表 9 行 + 五条例外 + 键控 + 持有者 + 空态 + 第三种空）

**默认态表**：

| 块 | 默认态 | 说明 |
|---|---|---|
| 思考块 | **收起** | 标题「思考」；展开显示 `text` 原文（等宽、斜体、左侧竖线） |
| 工具组 | **收起** | 标题「工具调用 × N · 调用名汇总 · 状态汇总」 |
| 工具行（组内） | **收起** | 摘要行 = 工具名 + 参数摘要 + 状态；点开才是完整命令/参数/结果 |
| 正文 `text` 块 | 不折叠 | 它就是事实内容，折叠它等于把抽屉的目的折掉 |
| 子任务占位条 | 不折叠 | 它是导航入口 |
| 用户提示词 | 不折叠 | 它是「这个节点被要求做什么」的唯一说明（D4） |
| `attachment` 块 | **收起** | 内容是我们不认识的厂商原始载荷，默认不该占地方（⚠️ 与 D31 冲突，见 §12） |
| 计划清单面板（§5.4） | **首次展开、其后收起** | 第一次要让读的人知道「它打算做什么」，之后只需要知道「走到哪了」；收起态标题已带 `3/5 完成 · +1 完成` |
| 问答卡片（§5.5） | **等待答复时展开**；已收场收起 | 等待态是「卡住了」的唯一信号，折叠它就等于把抽屉里最该露出来的东西藏起来 |

**五条例外（必须写进代码，否则会踩）**：
1. **进行中的工具不折叠**：`ToolItem.running === true` 的那个工具组默认**展开**。否则「这一步正在干什么」被折叠吞掉，而折叠的意义恰恰是「已确定的事不用一直占地方」。
2. **失败的工具自动展开**：该组内有 `status === 'error'` 时，组默认展开**且该行默认展开**。失败的证据不该要用户点两次才看得到。
3. **思考块 `text === null` 时**：显示 `textMissing` 对应的中文（如「这家拿不到思考文本」），**不显示空面板**——空面板会被读成「思考了但什么也没想」（v2 spec §4 的 `MissingReason` 口径）。
4. **运行中的计划清单不折叠**：`TaskPanel.running === true` 或结果未采集时该面板**默认展开**且标题写明状态（与例外 1 同源：进行中的事不折叠）。
5. **异常收场的问答展开**：`timeout` / `unavailable` / `rejected` 的问答卡片**默认展开**（理由与例外 2 相同——「它没能问成人」不该要用户点两次才看得到）；`skipped` / `canceled` / `auto-resolved` 属正常收场，默认收起。

**折叠状态的作用域与键控**：**用 `ContentBlockBase.id` / `ToolItem.callId` 键控，不用数组下标**（`AgentLogModel.turns` 会随流式追加而变长，下标会漂——「我展开的那条自己合上了」正是这么来的）。两族卡片同理：键 = **承载族载荷的那个 `tool-call` 块的 `id`**（同一轮多次 `task` 调用因而各自独立，只是其中只有最后一张会成卡，见 §5.4 规则 3）。默认态由组件内的 `activeKey` 计算（**不在纯函数里**）：内置规则 ∪ 用户手动开过的那些键。**不持久化**（刷新与切换节点即回到默认），且**流式推进不重置已折叠态**——手动展开过的块在后续事件到达时保持展开。

**折叠态的持有者（2026-10-02 补，D24）**：这份 `activeKey` **住在 `useAgentLogView` 里，不住在组件树里**。两条必守：
1. **L0 纯渲染件一律受控**：`ThinkingBlockView` / `ToolGroupPanel` 等吃 `open: boolean` + `onOpenChange(next: boolean)`，**自己不 useState**。理由是 §2.1 场景 S3：一个自己持有开合态的折叠件**不能被独立挂载**——挂两个实例就是两份互不相干的真值，而 §6.4 要求「工具条开关与角落浮出按钮是同一份 state」已经立过同一条纪律。**受控件是「同一份 state 只能有一处」在组件层的落实方式。**
2. **只有 `renderBlock` 分派处注入这份受控态**：`AgentMessageTimeline` 不认识 `activeKey`，它只调 `renderBlock(block, { open, onOpenChange })`。这样「折叠态从哪来」与「块怎么画」是两个可分别替换的东西——监控台场景可以换一条完全不同的折叠策略（例如「永远全开」）而不碰任何一个渲染件。

**空态**：`AgentLogModel.empty === true` 时，时间轴区渲染 `EmptyState`，文案沿用现有 `LogView` 的措辞（标题「还没有日志」、说明「这一行还没开始执行，或执行尚未产生输出」）——**不是**渲染一个空的时间轴（那会被读成「界面没渲染出来」）。注意「读盘失败」不走这里：那是页面层的 `resolveLogDrawer` 的 `failed` 分支，仍整段替换抽屉内容（既有口径不变），因为把一次带文件路径的真实故障说成「还没开始执行」是错的。

**「有内容、但这一类内容没被转发」是第三种空（D38）**：`content.status === 'ready'` 且 `turns` 非空，但**一个 `role === 'assistant'` 的块都没有**时，**不能**渲染成「这个子任务什么都没做」。规范逐字要求 claude 未开 `forwardSubagentText` 时**如实说明「该子任务的对话未转发」**（默认只投工具调用与工具结果块）。判据与文案：

| 情形 | 画面 |
|---|---|
| `capability['subagent'].level` 非 `'yes'` | 「子任务轨迹不可用 · <原因中文>」（原因取 `CapabilityDecl.reason`） |
| 有工具块、无 assistant 文本/思考块 · `source === 'session-file'` 且该节点尚未结束 | 「**运行期只有派发事件与状态，完整轨迹要等运行结束**」 |
| 有工具块、无 assistant 文本/思考块 · 已结束 | 「**该子任务的对话未转发**（只投送了工具调用）」——**不写「它什么都没说」** |

这一档与 `empty` 的区别是**「没有内容」与「这一类内容没有」**，与 §5.3.1 的 `Skeleton` / `Alert` / 空入口三分是同一条口径。

### 7.8 §6.2 打开与切换（5 条）

- **`AgentLogView` 自己不取数**，只吃 `AgentLogModel` + 一个 `onDownload` 回调（§4.1 纪律 2）。**2026-10-02 补（D24）**：这里的「一个 `onDownload`」已扩成 `AgentLogModel` + `environment?` + `diagnostics?` + `source?: AgentLogSource` + `onDownload`（§4.4 / §9.2）——**纪律没变**，变的是「不取数」这条边界的**形状**：组件仍然只渲染数据层给的形状，只是把「我需要了」的时机上报收进了一个对象。取数时机、事件源合并、按需加载子任务，全部是数据层的事。
- 面包屑切换节点：**是组件内部 state**（不写 URL）。理由：抽屉本身已经是页面 state（`drawer.kind`），再加一层 URL 会让「刷新回到主会话」与「刷新回到第三级子任务」出现两个都说得通的期望，而两者都无法从服务端快照恢复（子任务没有独立 id 路由）。
- 切换节点时**滚动位置重置到该节点时间轴顶部**（不是保留上一个节点的位置）。
- 节点内容未到（`content.status === 'loading'`）：时间轴区显示 `Skeleton`（**不是空态**——空态会被读成「这个子任务什么都没做」）。
- 节点内容读失败（`content.status === 'error'`）：`Alert` 显示中文原因 + 「重试」按钮。**重试是向数据层要一次重取**（回调由页面注入），不是 UI 自己再去请求。

### 7.9 §6.3 子任务占位条与面包屑的兜底（5 条）

- 占位条内容：`[子任务]` 标签 + 任务名 + 状态标签 + 「进入 ▸」。
- **任务名为 null 时**用 `子任务 <subagentId 前 8 位>`（v2 spec §6.2 明确 `name` 可为 null，claude 的聚合形态就是 `name: null` 且 `source: 'aggregate'`）。**不显示空白**。
- **`kind === 'row'` 的节点不是子任务**：它是「这家只有汇总计数、没有逐个身份」的形态（`capability.subagent === 'aggregate'` 那一类）。它**不进面包屑、不可点**，只在时间轴上占一条带计数与状态的说明行——否则用户会点进一个空会话。
- **占位条对已结束的子任务同样出现**（`completed` / `failed` / `canceled`）——评测者回看时需要能进去，「只有正在跑的才可进」会让跑完的行永久读不到子任务。
- 面包屑段：`主会话 / A / B`；不可点的当前段用 `Typography.Text strong` + `aria-current="page"`。链由 `parentId` 从 `activeNodeId` 回溯到根**派生**（不存第二份，§4.1 评估表）。

### 7.10 §6.4 滚动（D13，5 条）

- 打开抽屉时定位到**最新一轮**（新抽屉的默认诉求是「看现在」）。
- **跟随最新**开启时，新事件到达即把视口带到底（`scrollTo({ align: 'bottom' })`）。
- 用户**任何向上滚动**即自动关闭跟随（不需要手动点开关），并在右下角浮出 `↓ 回到最新（N 轮未读）`；点它回到最新并重新开启跟随。
- 工具条上的 `跟随最新` 开关**只用于显式打开**（关闭由滚动触发）。开关自身的打开/关闭态与浮出按钮是同一份 state，不允许两处各存一份。
- 展开/折叠导致的**内容变高变矮由虚拟列表自己补偿**（D9 的全部理由）。

### 7.11 §6.5 跳转与过滤（4 条）

- **轮次跳转器**：`InputNumber` + 回车/失焦即跳，落点 `scrollTo({ index, align: 'top' })`。越界输入 clamp 到 `[1, turns.length]` 并**如实回显 clamp 后的值**（不让输入框显示一个没跳到的数）。
- **过滤**（`只看工具调用` / `只看错误`）：过滤在**轮次级**生效——过滤后不含目标块的轮次**整轮隐藏**（否则会得到一屏「轮次 12（空）」的噪声）。两个过滤可叠加（AND）。过滤生效时固定区显示命中数：`命中 12 / 83 轮`（**与「已渲染 N / 共 M 轮」是两个不同的数**：前者是过滤后的命中轮数，后者是虚拟列表实际挂载的轮数，见 §7.2。两个都常驻，不互相替代）。
- 过滤不影响面包屑与子任务占位条的可见性（它们是导航，不是内容）。
- **两族卡片算「工具调用」**：`只看工具调用` 命中含 `task` / `ask-user` 的轮次——它们本质就是工具调用，漏掉它们会让「过滤后我的计划清单不见了」被读成缺陷。`只看错误` 只认**数据给的 `ok === false`**（含 `unavailable` / `rejected` 的问答）与 `rowEvents` 的 `error`，**不按 `outcome` 猜**：`timeout` / `skipped` / `canceled` 算不算失败由厂商的结果定，UI 不替它判断。

### 7.12 §6.6 工具栏（6 行，行为逐条）

| 控件 | 行为 |
|---|---|
| `下载台账` | 即现有的下载按钮，内容 = `formatEventLog(全量事件)`（来源仍是 `useRowLog`，不是连接里收到的那份）。**不再声称与抽屉逐字一致**（D8） |
| `跟随最新` | 见 §6.4 |
| `跳到轮次` | 见 §6.5 |
| `只看工具调用` / `只看错误` | 见 §6.5 |
| `原始输出 N 条` | 见 §5.3 |
| `？环境信息`（图标按钮） | 见 §6.8——打开环境抽屉（`agent-log` 内部件） |

**这六项是一套「预设」，不是工具条的全部（D26）**：上表逐项的**行为**不变，但它落到代码里是 `AgentLogToolbarPreset` 里的 `ToolbarAction[]`，`AgentLogLayout` 只吃 `actions` 数组（§9.4）。两处后果：① 通用消费方**增删动作不必改组件**（§8.3 的 P1 已登记本仓原先做不到）；② 「原始输出」与「环境信息」两个按钮**由预设按数据在不在决定渲不渲染**（`diagnostics` 的 `lines` 为空时不渲染入口，见 §5.3.1），这条判断跟着**动作自己的 `visible` 谓词**走，不写死在工具条组件里。

### 7.13 §6.7 流式可见性与动效（目的 + 五处动效 + 三条取舍）

**目的**：让「它正在干活」在**不操作**的情况下就能看出来。今天的抽屉是一坨静态文本，跑动期与跑完长得一模一样；而一次评测要跑几分钟，使用者需要知道它在动。

**五处动效，全部只在流式期间出现、块结束后立刻消失**（静止即「这件事已经确定了」）：

| # | 位置 | 表现 | 实现 |
|---|---|---|---|
| 1 | 思考块**折叠态的标题** | 「思考中…」**扫光** | 复用现有具名出口 `ACTIVITY_SWEEP_CLASS`（`agent-activity-line.tsx`）——`.aieval-activity-sweep` 已在 `apps/web-next/app/globals.css`，1.8s 线性，**已处理 `prefers-reduced-motion`** |
| 2 | 思考行最前的标记 | 6px 圆点**呼吸**（`opacity` 1→0.25，1.2s） | 只用既有主题变量（`--app-muted`）；**不引图标包**，固定尺寸不撑动布局 |
| 3 | 正文流末尾 | 闪烁光标 `▍` | **CSS 伪元素加在容器上**，`MarkdownText` 一行都不改（§4.1 的边界） |
| 4 | 进行中的工具行 / 工具组 | 状态用 `Badge status="processing"`（antd 自带动效） | antd |
| 5 | 固定区状态徽标 | 同一套 `Badge status="processing"` | antd |

- **为什么扫光只给折叠态的标题**：块结束后的静态文本上加动画，等于把「还在流」这个信号稀释成噪声；而折叠态下**看不到正文**，标题不表态就没有任何地方能表态了。
- **已展开的思考块不做字符级打字机**：它的文字**只追加不重排**，本身已经是「顺着读」的。逐字打字机要自己维护一个追逐缓冲，还会与 `prefers-reduced-motion` 打架，收益不抵成本。
- **刻意不做（本期）**：「在抽屉里中断这一轮」按钮。它需要 `AgentLogDrawer` 多拿一个中断回调，而**单行终止已经在行卡片上**（`onAbortRow`）——抽屉里再放一个是同一动作的第二个入口，两个入口的可用面必然漂移。若确实要「就地在抽屉里终止」，那是独立的一次需求。

### 7.14 §6.8 环境抽屉（`agent-log` 内部的一块）

- **它是 `AgentLogLayout` 的内部件，不是并列组件**：调用方给 `AgentLogLayout` 喂一个 `environment?: Loadable<AgentEnvironment>`，问号按钮由它自己渲染、抽屉由它自己持有开合状态。调用方**不需要**接线、也不需要记得「关主抽屉时一起关」——环境抽屉是 `AgentLogLayout` 的子组件，主抽屉一卸载它跟着没了，**关闭联动是结构保证的**（初版把它提为并列组件时，这条得靠记忆，还得配一条接线守卫；内部化之后守卫可以删掉）。
- **「它自己持有开合状态」在 D24 之后落到哪**：**开合态仍归 `useAgentLogView`**，但环境抽屉按**受控件**写：`AgentEnvironmentDrawer` 吃 `open` / `onOpenChange`，**自己不 useState**。两条理由：① **S3**：受控后它能被单独挂到任何地方（例如设置页的「本机环境」区块），而自己持态的版本只能在 `AgentLogLayout` 里工作；② **S5**：监控台场景要的可能是「环境信息常驻右侧栏」而不是抽屉——那时换的是**摆法**（谁渲染 `open`），受控件一行都不用改。
- **`AgentLogDrawer` 提供的默认接线**（让评测页一行代码就能用）：问号按钮自己渲染、`open` 由 `useAgentLogView` 给、点击时同时调 `source.requestEnvironment()`（§4.4）。**「关闭联动」的保证不变**：`AgentEnvironmentDrawer` 仍被 `AgentLogLayout` 内部渲染，`<Drawer destroyOnHidden>` 一卸载整棵树跟着没。
- **入口**：固定区最右一个 `Button` `type="text"` + `icon={<QuestionCircleOutlined />}`，`aria-label="环境信息"`。`environment` 为 `undefined` 时**按钮照常渲染、抽屉里显示「未提供」**——「没有这个功能」与「这次没采到」要分得开。
- **关于图标语义的一处偏离（需求方原文是「问号图标按钮」，我按现状改了）**：`?` 在通用语义里是「帮助」，而这里打开的是**调试用的环境事实**。行卡片上已有的按钮全部是「动作名」风格（执行日志 / 变更详情 / 评分详情），一个纯图标按钮必须靠 `aria-label` 与 `Tooltip` 才能被理解。故用**问号形状但语义化命名**（`aria-label` 与 `Tooltip` 都写「环境信息」），而不是再引一个 `Tool` / `Code` 图标——少一个图标依赖，且形状是需求方要的。

**几何与行为（组件内部固定，调用方不必重复给）**：

| 项 | 取值 | 理由 |
|---|---|---|
| `placement` | `'right'`（与主抽屉同侧） | 同侧才是「从主抽屉里再划出一层」的观感 |
| 宽度 | `min(42vw, 640px)`，`maxWidth: '100vw'` | **比主抽屉窄**：它是从属信息，不该与主视图等宽抢注意力 |
| `push` | `{ distance: 360 }`（antd 内建，默认 180） | 主抽屉宽 `max(50vw, 800px)`，默认 180 的内推量在宽屏上几乎看不出来；360 让「主抽屉被推开了」这件事可见 |
| `destroyOnHidden` | `true` | 与主抽屉同口径（关掉即卸载，不留浮层状态） |
| `styles.body.padding` | `0`，内边距由内容给 | 与三个既有抽屉同口径 |
| `mask` | `true`（antd 默认） | 点遮罩关闭是浮层的通用预期 |
| `title` | `环境信息` | `agent-log` 内部件，文案固定，不开覆盖口 |

**内容布局（自上而下，4 条）**：
1. **摘要条**：`Descriptions` `size="small"` `column={1}`——智能体 / 模型 / 思考强度 / 供应商 / 接口地址 / 工作区 / 基线提交。这些是「它跑在什么之上」。
2. **分组**：每组一个 `Collapse`（`items` 的每个 `EnvGroup` 一项），组头 = 组名 + `Tag` 标来源（用户层 / 厂商系统层 / 运行配置 / 实测统计）。**组名与分组顺序都由数据层给**（`EnvGroup.title` / 数组顺序），组件不硬编码任何一组的名字——这样新增一层（例如「项目规范 / AGENTS.md」）不需要改组件。
3. **条目**：`Collapse` 内每条一个「标签 + 正文」块：正文用 `MonoText`（逐字原文、可滚），`truncated` 非空时在尾部加一行「已截断（原文 N KB）」+ 「复制全部」按钮，有 `copyPath` 时再加「复制」按钮（调试时最常用的是把完整提示词粘到别处）。
4. **缺失项**：`present: false` 的条目渲染成一行灰字「标签 · 原因」——`MissingReason` 映射成中文（如 `not-exposed` → 「厂商没有暴露给我们」）。**不隐藏**：隐藏会让「这一格没有」与「我们没做这一格」不可分。

**两条必须写进代码的约束**：
1. **关闭联动由结构承担，不靠记忆**：环境抽屉是 `AgentLogLayout` 的子组件，主抽屉卸载它即随之卸载。**不存在**「主抽屉关了、环境抽屉还挂着」这个失败面，也**不需要**任何接线守卫来钉它。
2. **环境抽屉不订阅任何流**：它是**打开那一刻的快照**（环境是静态配置，不会变），故不复用主抽屉的实时数据，也**不因流式事件而重取**。**注意别把这条读成「不能向数据层要数据」**：入口被点开时调一次 `source.requestEnvironment()`（§4.4）是**允许且必需**的——它上报的是「用户要看了」，与「流又来了一帧」无关。两者混为一谈时，会出现「点了问号却永远停在『读取中』」。「要不要真去取、要不要走缓存」是 `AgentLogSource` 实现方的判断，组件不实现这层缓存。

**如实登记的口径冲突**：§5.1 与 2026-09-29 spec §7.2.1 ③ 那条「抽屉内只有一个滚动容器」是**针对单个抽屉**说的；环境抽屉是**另一个抽屉**（虽然由同一个组件内部渲染），它自带 `.ant-drawer-body` 滚动容器。两者不矛盾（各自内部仍只有一个滚动容器），但环境抽屉的内容**必须按同一个约束来写**：不内套第二层滚动区，长文本交给它自己的 `body` 滚——否则环境抽屉里会出现两条滚动条。

### 7.15 §6.9 块的角色标签与来源标注表（8 行）

`ContentBlockBase` 补的 `role` / `source` / `assembly` 三格各自有一个**可见**落点（不然它们就只是躺在契约里的装饰）：

| 格 | 界面表现 | 为什么必须有 |
|---|---|---|
| `role === 'assistant'` | **不标注**（它是默认的主角，标了反而吵） | —— |
| `role === 'user'` | 左侧竖线 + `Tag`「用户」 | 首条之后的用户消息（一次会话可以有多个用户轮）今天会被渲染成智能体的输出——「用户在读一份不知道谁在说话的记录」 |
| `role === 'system'` | `Tag`「系统」+ **不折叠但降一档**（`Typography.Text type="secondary"`） | 厂商 system / 信封类文本若走 `text` 块，会按 markdown 正文渲染且不折叠，与智能体的结论**逐字同形** |
| `role === 'tool'` | 由工具类块自身表达（不另标） | —— |
| `source !== 'wire'` | 块角标 `Tag`：`session-file` → 「补录」、`aggregate` → 「汇总」、`hook` → 不标 | codex 的思考正文来自**会话文件**（运行结束后才有），界面上与实时数据逐字同形 ⇒ 用户把「事后补齐」读成「实时采到」 |
| `assembly === 'open'` | §6.7 的扫光 / 光标（**唯一判据**） | 见 §4.2 修订 1：初版没有这一格，`streaming` 只能靠「是不是最后一轮」猜，一次中断会永远闪光标 |
| `ThinkingBlock.textKind === 'summary'` | 标题后缀 `Tag`「摘要」 | codex 事件流那一格按厂商定义**只有推理摘要**；不标注就是「假称全文」 |
| `ThinkingBlock.textKind === 'none'` | 已由 §6.1 例外 3 承担（显示 `textMissing`） | —— |

**`contentTruncatedReason` 非空时**同样如实显示那句话（内容被上限截断，与「最后一条就是终点」不是一回事）。

### 7.16 §6.10 附件块的呈现（4 行）

`attachment` 块是**认识的真实附件**，与 `unrecognized`（不认识的载荷兜底）走两条路：

| 内容 | 画面 |
|---|---|
| `attachmentKind === 'image'` | `Tag`「图片」+ `path`（`MonoText`）+ `mimeType`。**本期不加载缩略图**——加载远程资源会牵出鉴权、体积、CSP 三件事，不属于数据结构这一轮；结构上留位，渲染上先占位 |
| `attachmentKind === 'file'` | `Tag`「文件」+ `path` + `mimeType` |
| `path === null`（内联附件） | 「内联内容，无路径」（**不显示空白**，也不编造路径） |
| `unrecognized` 块 | 折叠的 `raw` 等宽原文（沿用初版 `attachment` 的呈现，**默认收起**，§6.1） |

**附件出现在两处，都要接**：① 用户消息里（`LogNode.userPrompt` 本期仍是 `{ text, at }` 纯文本，**附件不进它**——它只承载提示词正文；附件以 `attachment` 块出现在该节点的首轮）；② 工具结果里（`ToolResultBlock` 本期不加附件出口，**登记为不做**：规范说 claude 的图片可以出现在工具结果里，但本仓工具结果以文本为主，加这一格会让 `ToolResultBlock` 多一层嵌套，等真有截图需求再加）。

### 7.17 §9.0 三层结构与三条硬纪律

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

| # | 纪律 | 违例长什么样 |
|---|---|---|
| 1 | **依赖只准向下**：L0 不 import L1/L2；L1 不 import L2 | L0 里的 `task-panel-card` import 了 `useAgentLogView` 去读折叠态 |
| 2 | **L0 不 useState**：所有开合/选中一律受控（`open` + `onOpenChange`） | 一个自己持开合态的折叠件**不能被独立挂载**（§2.1 S3 直接失败） |
| 3 | **L0 不认业务概念**：不 import 任何 `EvalRow*` / 厂商名 / `agentKind` | 卡片按 `agentKind === 'dsh'` 分支（§4.1 纪律 5 已经禁过，这里再钉一次到目录级） |

**L0 与 L1 的分界不是「有没有 props」，而是「认不认 `LogTurn`」**：L0 吃的是**单个块**（`TextBlock` / `ToolItem` / `TaskPanel` / …），L1 吃的是**一轮**（`LogTurn` + 分派函数）。故 `MessageTimeline` 是 L1 而不是 L0——它知道「一轮里有多个块、要按顺序摆」，但**不知道虚拟化、不知道轮次跳转、不知道过滤**。

### 7.18 §9.5 文件清单（按层分组，20 个文件 + 删除项）

| 层 | 文件 | 职责 |
|---|---|---|
| L2 | `use-agent-log-view.ts` | **四份视图态的 headless 持有者**：当前节点 / 跟随最新 / 过滤 / 环境抽屉开合 + `activeKey` 折叠态。**不持有 data**。导出 `AgentLogViewState`（受控值 + setter），供 S5 外置 |
| L2 | `agent-log-drawer.tsx` | **唯一一处 `<Drawer>`**。title 默认「执行日志」；几何沿用 §5.1。评测页一行接线 |
| L2 | `agent-log-layout.tsx` | **抽屉正文**（S1 的内嵌视图直接用它）：固定区 + 面包屑 + 时间轴槽 + 浮动件。吃 `actions`（§9.4）与 `timeline` 槽；内部用 `useAgentLogView` |
| L2 | `virtual-turn-list.tsx` | **虚拟滚动的唯一持有者**（§7.2）：包 `@rc-component/virtual-list`，把「按项渲染」接到 `RenderTurn`；跳轮器 / 回到最新 / 「已渲染 N 共 M 轮」的 ref 与回调都从这里出 |
| L2 | `agent-log-toolbar-preset.ts` | 默认六个动作（§6.6）：下载台账 / 跟随最新 / 跳到轮次 / 只看工具调用 / 只看错误 / 原始输出 / 环境信息（⚠️ 列了 7 个名字，见 §12） |
| L1 | `agent-message-timeline.tsx` | **吃 `turns` + 分派函数，吐轮次列表**。虚拟化、subagent、过滤都不在它这里 |
| L1 | `log-node-breadcrumb.tsx` | 面包屑 + 每段兄弟菜单（`Breadcrumb` + `Dropdown`）。**只吃 `nodes` / `activeNodeId` / `onSelect`**：祖先链由 `parentId` 回溯派生，同层兄弟由 `filter(parentId === 本段)` 现算 |
| L1 | `agent-log-facts-bar.tsx` | 事实进度条（受控、不可折叠）+ 「等待答复」徽标（§5.5）。**只吃 `facts` / `rowEvents` / 等待判据**；原始输出入口与「？环境信息」按钮**移出**（分别归 `raw-output-panel` 与工具条预设） |
| L0 | `block-renderer-registry.tsx` | 注册表 + `DEFAULT_BLOCK_RENDERERS` + `Provider` + `useBlockRenderers`（§9.3） |
| L0 | `render-blocks.ts` | `buildRenderBlocks` 的实现**落在 `ui` 包**（与 `log-format.ts` / `diff-patch.ts` 同层）。**不放进 `@aieval/contracts`**：契约包只有 node 环境的测试（无 jsdom） |
| L0 | `text-block-view.tsx` | `text` 块：`MarkdownText` + 流式光标容器类（§6.7 第 3 条） |
| L0 | `thinking-block-view.tsx` | `thinking` 块：折叠面板、`text === null` 显示缺失原因而非空面板（例外 3）、扫光标题（§6.7 第 1 / 2 条） |
| L0 | `tool-group-panel.tsx` | 工具组折叠面板 + 组内工具行（两级折叠） |
| L0 | `tool-item-detail.tsx` | 单条工具的命令/参数/结果，含超长截断 |
| L0 | `subagent-bar.tsx` | 子任务占位条（§6.3）：`Card` + `Tag` + 「进入 ▸」。**任务名为 null 时的 id 前缀兜底在这里** |
| L0 | `agent-run-state-tag.tsx` | **§9.7 的原语**：`running` / 「结果未采集」的唯一分派处，工具行与三张卡片共用 |
| L0 | `raw-output-panel.tsx` | **§9.7 的原语**：逐行原文（`AgentLogDiagnostics`）与单份原文（`ToolCardResult`）两种变体，三态画面（§5.3.1） |
| L0 | `agent-environment-drawer.tsx` | 环境抽屉本体。**受控**：`open` / `onOpenChange`。摘要 `Descriptions` + 分组 `Collapse` + 逐条 `MonoText` |
| L0 | `task-panel-card.tsx` | `task` 族的状态化清单面板（§5.4）：计数/变化摘要标题 + 清单行 + `本轮另有 N 次更新` + 原始结果。吃 `TaskPanel`，**不认厂商、也不认 `args`/`result`** |
| L0 | `ask-user-card.tsx` | `ask-user` 族的问答卡片（§5.5）：逐问题选项 + 答案回填 + 七态收场 + 等待计时 + 原始结果。吃 `AskUserInteraction`，**不认厂商** |

- 新增目录：`packages/client/ui/src/composite/agent-log/`——**这个目录整体就是那个通用组件**。
- `packages/client/ui/src/composite/`：`log-view.tsx` **删除**（被 `agent-log-drawer` 取代），`log-format.ts` 保留（供下载台账）。
- **`agent-log-view.tsx` 这个名字不再使用**——初版用它是为了当主件，而 D24 之后「主件」这个概念本身被拆成了三层。
- **三条边界纪律**（初版三条全部保留，逐条补上 D24 之后的新落点）：① `AgentMessageTimeline` 的 props 里**没有任何 subagent 字段**——「当前在第几级」是 `AgentLogLayout` 的事（D24 之后更严格：`AgentLogLayout` 用**同一个 `timeline` 槽**渲染主会话与子任务，两者的差别只有喂进去的 `turns`）；② `ui` 包不调接口、也不决定取数时机（取数「时机」的上报收进 `source`，而不是散成若干回调）；③ **环境抽屉是内部件，不是并列组件**（「通用」由整个 `agent-log/` 目录承担）。

---

## 8. §12 范围登记（「不做」的每一条）

### 8.1 A / B 分段（本设计只覆盖 A 段）

**本设计依赖 v2 的 `message` / `subagent-start` / `subagent-end` 三类事件。** 它们**今天是设计稿，契约与适配器都还没有**（`packages/server/contracts/src/agent-event.ts` 仍是 v1 的 7 个扁平类型）。故本期拆成两段，**本文只覆盖第一段**：

| 段 | 内容 | 本设计是否覆盖 |
|---|---|---|
| **A. UI 与渲染模型** | `AgentLogModel` / `AgentEnvironment` 等**类型**、`buildRenderBlocks` 纯函数、全部新组件（含通用的 `AgentEnvironmentDrawer`）、页面接线、按钮改名、文档修订。**用夹具喂 UI**，走单测 + 真实浏览器冒烟 | ✅ 本文 |
| **B. 数据层与适配器** | 契约加三类事件（v2 spec §5/§6 的形状）、三家适配器投影、**组装 `AgentLogModel` 与 `AgentEnvironment` 的 selector**、按需取子任务内容与**按需取环境信息**、§7.1(c) 的更新频率上界、§5.3 的 `log` 原文保真、**厂商 `system` init 行的工具面与系统提示词提取（§4.3）** | ❌ 不在本文（属 v2 spec 的实施范围） |

**这段划分的代价如实登记**：A 段做完时，抽屉在**真实数据下仍显示不出消息**——因为契约里还没有 `message` 事件，而组装 `AgentLogModel` 的 selector 属 B 段。B 段落地前，A 段的可见验收只能靠夹具驱动的组件测试与冒烟页，**不能声称「真实评测里能用了」**。需要提前把这条讲清楚，否则第一个跑真实评测的人会以为功能坏了。

**环境信息抽屉受这条分段的影响更直接**：厂商侧那两组（系统提示词、已调度的工具）**完全依赖 B 段从厂商 `system` init 行里提取**。A 段做完时，环境抽屉能显示的是「项目侧配置」那两组（本仓自己下发的，夹具可造），厂商侧会**如实显示成缺失 + 原因**（`not-exposed` / `unverified`）——**这是正确行为，不是没做完**：v2 的四态口径要的正是「拿不到就说拿不到」，而不是先渲染一个空面板。

### 8.2 逐族可得性（避免把「没开开关」读成「卡片坏了」）

| 族 | A 段（夹具喂 UI） | B 段落地前，真实数据下的样子 |
|---|---|---|
| `task` | ✅ 卡片结构、计数/变化摘要、折叠、同轮多次、`owner`/依赖四态全可验 | **dsh 有数据**（`todo_write` 是它 24 个工具之一）；codex 要开 `tools.update_plan.enabled`；claude 要开 `CLAUDE_CODE_ENABLE_TODO_TOOLS`——**没开就没有这一族**（是「没采到」，不是卡片坏了；v2 spec §7.6.2.1b） |
| `ask-user` | ✅ 七态 + 等待态 + 答案回填全可验 | 本仓 `approvalPolicy: 'never'` 且未开应答面 ⇒ dsh 的 `ask_user_question` **会以 `unavailable` 报错**（v2 spec §7.6.2 ⑩ 硬约束 2：报错而不是降级）。**这是已知边界**，卡片上如实写明（§5.5） |

**另外登记一条范围口径**：其余 8 族本期不做专门渲染（走通用工具行）。这不影响 v2 spec §7.6.4 的「UI 只按 `family` 分支」——两族是**族驱动**的（不认厂商、不认 `args`/`result` 半边），收编下一族时只加一个 `ToolFamilyPayload` arm 与一个 `RenderBlock` 分支（§4.1 扩展性第 5 条）。

### 8.3 对 B 段提出的接口要求（集中在**六处**）

§4.1 的**五条**边界纪律与评估表、§4.3 的环境信息模型与两组固定构成、§5.2 的行级事件去向表、§5.3 的三条所有者划分、§5.4 / §5.5 的两族卡片载荷与降级口径、§7.1(c) 的更新频率上界。

### 8.4 另有**五项**明确不做

1. 不读厂商会话文件（rollout / `rollout-*.jsonl`）作为消息来源（沿用 v2 spec §12 的口径）；
2. 不做抽屉内的全文搜索（轮次跳转器 + 过滤已覆盖「能不能找到」）；
3. 不做轮次级「折叠全部 / 展开全部」批量开关（D7 选了「事实内容开箱即见」，批量折叠与它相冲）；
4. 不做抽屉之外的「正在等待答复」提示（行卡片 / 列表页的状态标记）：本期只在抽屉内如实显示（§5.5 的固定区徽标 + 卡片计时）。跨页面提示要动列表页与行卡片的 state，是另一件事；
5. **不做「就地在卡片里回答提问」**：本仓没有应答面（`approvalPolicy: 'never'`），而做一个只在本机可用的回答框会让「评测里的提问为什么没人答」这件事更难解释。卡片是**只读的复盘视图**，这一点在 §5.5 的文案里写明。

### 8.5 2026-10-02 追加一条范围口径（S5 的另一半）

**不交付任何「非抽屉形态」的成品界面**。D24 的分层让对话式 UI / 实时监控台**做得出来**（§2.1 S5 / §11 验收 28），但本轮只落一个真实场景需要的预设（`AgentLogDrawer`）。**把「可重组」读成「已经做了五个界面」是本次修订最可能的误读**——它交付的是**接缝**，不是界面。真要第二个形态时，那是独立的一次需求，按同一套分层组装即可（`MessageTimeline` + `ToolbarAction[]` + `AgentLogSource` 都现成）。

### 8.6 2026-10-02 第二轮追加：影响展示的配置开关逐条登记（**表内 7 行**）

以下开关**关掉时界面会缺东西**，而初版 §12 一条都没写——第一个排查的人会以为功能坏了：

| 配置 | 关掉/不满足时的界面表现 | 界面必须说的话 |
|---|---|---|
| claude `includePartialMessages` | 无流式增量 ⇒ §6.7 五处动效全不出现 | 由 `streamingDelta` 能力位承担（D28）：显示「这家不产出流式增量」而不是干等着 |
| claude `canUseTool` 未注册 | `AskUserQuestion` 不在工具表 ⇒ **连卡片都没有** | 「本行未注册交互回调，提问工具不可用」——**不是**「这次没提问」 |
| claude 自动放行模式 | 提问**被静默跳过** ⇒ 既非 `unavailable` 也非 `rejected` | 同上；这是规范 §8.2 明列的「必须规避」 |
| codex `features.multi_agent` | 子任务面恒空 ⇒ 面包屑与占位条都不出现 | 由 `subagent` 能力位 + `capabilityNotes` 承担：「本行多智能体未启用 / 该路由拒绝命名空间工具」——**不是**「没派子任务」 |
| codex 受限路由上开多智能体 | `unsupported call` / 整轮被拒 | 同上一行（**能力随路由翻转**，故必须带前提） |
| dsh 联网三键 + 凭据 | web 族「看似可用」或必失败 | 「未启用联网」/「联网不可用」——规范 §7.4 明禁显示成「三家都没搜」 |
| codex 近似条目计数 | `round` / `turns` **系统性偏高** | **⚠️ 本设计 D1 与 §11 验收 8 声称「跨三家可比」与这条相反**：现已改为「**同口径可比**」，并在块/进度条上按 `source` 标注（D27） |

### 8.7 第二轮明确不做（三条根因，各带理由与代价）

1. **`structured`（工具结果的结构化结果）仍不承载**。规范要求「有 `meta` 就不要退回去解析文本」，而本设计只有等宽原文。**理由**：本期不渲染任何族的结构化结果，收编一族专门卡片时再按需加逃生格。**代价**：`read` 的行数、`grep` 的命中数这类「已解析过的事实」在界面上只能读原文自己认。
2. **`usage.total` / `apiMs` / `ttftMs` / 派生指标（缓存命中率 / tok/s / 首字延迟）不进 UI**。**理由**：规范说「适配器**不预先算比率**」，而本设计不做这几格 ⇒ 界面也没有它们的落点。**代价**：厂商自报总量与归一值不一致时无可对照；时间观感只有墙钟一种。
3. **图片缩略图不加载**（见 §8.6 同源的 §6.10）：结构留位、渲染占位，加载远程资源牵出鉴权 / 体积 / CSP 三件事。

另有三条紧随其后的登记：**`log.summary` 的取值来源**（D37 给了格，但「谁来填」属数据层，§12 的 B 段）；**工具结果里的附件不出承载**（§6.10 已登记理由）；**主会话节点的 `sessionFacts` 该不该非空**（§8.3 末段的裁决：**主会话节点的 `sessionFacts` 为 `null`**，行级事实一律读 `AgentLogModel.facts`，不存第二份）。

### 8.8 本轮不复述的评审结论（判为「已成立的有意排除」，不需要改动）

`vendorTurn` / `step`（规范逐字「恒 `null`，不显示」）、`signature`（规范逐字「只在审计视图出现」，本设计的「下载台账」正是那个出口）、`seq` / `chunk` / 合并键（规范逐字「消费方只实现 snapshot 也能正确渲染」）、`index` / `normalizedFrom`（审计职责）。
**唯一被判「有意不显示不成立」的是消息级 `raw`**：初版把它推给「台账的职责」，但本设计定义的台账是 `formatEventLog` 的**文本行**，承载不了「未归类字段原样保留」——而 `log` 原文却专门补了面板（§5.3.1）。**处置**：`UnrecognizedPayloadBlock.raw`（D31）就是消息级未归类载荷的出口，台账仍是归档面；两处不重复。

### 8.9 §8.3 未覆盖清单（P1 / P2，**重写时不要当成已修**）

划掉的已在 2026-10-02 第二轮闭合（见 §8.5）：

- **P1**：~~`capability` 只有两格~~（**已修**：D28 / §4.1 的维度注册表 + 五态）；`TaskPanel` 与规范同名不同形状（规范里没有 `WorkItem`，但 `SubagentRecord.source` 是**另一件事**，它已随 D33 补进 `SessionNode.source`）；~~`RenderBlock` 对 `kind === 'row'` 的节点没有出口、`LogNode` 也没有计数格~~（**已修**：D32）；**`AgentLogModel.activeNodeId` 既是输入字段又被注释成「UI 内部 state」（§4.1 vs §6.2，仍未闭合）**；~~`AgentLogModel.facts` 与 `LogNode.facts` 的关系没写死~~（**已修**：D32）；~~`LogNode.subagentId` / `vendorId` 全文无消费者~~（**已修**：D33）；**`EnvGroup.source` 是闭集四值（加一层要改组件，仍未闭合）**；~~工具条六项硬编码~~（**已修**：D26 / §9.4）；**组件文案里写死了本仓的 `approvalPolicy` 与 dsh（仍未闭合**，但 `ask-user` 的 `unavailable` 原因位已由 §5.5 的 `outcome` 与结果原文承担）。
- **P2**：`ask-user` 的 `recommended` 置顶被本设计推翻但 **§8.2 未登记**（规范 §7.6.4 的 `ask-user` 行 vs 本文 §5.5）；§11.1 第 27 项**已闭合**而 §8.2 仍当开放项引用；claude 的 `Task*` 已是默认工具、开关已注入而 §12 仍写「没开就没有这一族」；`specVersion` 与规范「不做版本分流」是两个版本轴，需要一句区分。
- **另记一条第二轮评审发现、但本轮不修的**：`AgentLogModel.facts`（行级）与 `LogNode.sessionFacts`（会话级）**是两层不同的东西**，D32 已把形状分开，但「主会话节点的 `sessionFacts` 该不该非空」**仍未写死**。本期的取值是：**主会话节点的 `sessionFacts` 为 `null`**，行级事实一律读 `AgentLogModel.facts`（不存第二份）。**这一句就是裁决，后续按它实现。**

---

## 9. §13 风险表（26 行：风险 → 处置）

| # | 风险 | 处置 |
|---|---|---|
| 1 | 嵌套折叠面板变高变矮后滚动位置跳 | 用 `@rc-component/virtual-list` 的逐项测量（D9）；真实浏览器冒烟第 2 项专门验它 |
| 2 | `buildRenderBlocks` 被写回「先全建再渲染」 | §7.2 的对照块明文禁止；`已渲染 N / 共 M 轮` 是它的可见护栏 |
| 3 | `callId` 配不上时静默丢弃 tool-result | 契约里 `ToolItem.callId` 可空、配不上降级成独立条目；§10 有专门用例与变异体 (a) |
| 4 | 用传递依赖而不声明 `@rc-component/virtual-list` | §7.2 要求写进 `ui` 的 `dependencies` 并在 AGENT.md 登记 |
| 5 | 子任务内容按需取，但缓存无淘汰 | §7.4 记了护栏与「不修在 ui 包」的边界 |
| 6 | **数据层仍按「一帧一次提交」对外，流式一开就卡** | §7.1(c) 以**要求**的形式提出（不指定实现，故重构后不过期）；真实浏览器冒烟第 6 项验它 |
| 7 | **UI 契约被传输层污染**（有人把 `seq` / `chunk` / 取数回调加回模型） | §4.1 的五条边界纪律逐条写明「不许有什么」，并在 §4.1 评估表里记了每条被删属性的理由——下一个人加回来之前会先看到理由 |
| 8 | 折叠态用数组下标键控，追加一轮后「自己合上了」 | §6.1 要求用 `ContentBlockBase.id` / `callId` 键控；§10 变异体 (e) 专验这一条 |
| 9 | `running` 被写成「有没有 `output`」的推断，「结果未采集」被显示成「正在跑」 | §4.2 明文要求 `running` 由数据层按「所在轮次是否结束」给出；变异体 (f) |
| 10 | 面包屑状态不写 URL，刷新回主会话 | §6.2 定为有意取舍（子任务无独立路由，服务端无法恢复该状态） |
| 11 | **环境信息被塞进主模型，每次流式提交都搬几十 KB** | §4.3 明文：它是独立的 `Loadable`，由页面按需取；理由是体积与时机两条 |
| 12 | **「已调度的工具」与「用过的工具」被混成一组**，读成「它用了 30 个工具」 | §4.3 要求分列并标 `source: 'observed'`；§10 变异体 (g) |
| 13 | 主抽屉关掉而环境抽屉残留在屏幕上 | **结构上不可能**（环境抽屉是 `AgentLogLayout` 的子组件，随主抽屉一起卸载，§6.8 约束 1）；`agent-environment-drawer.test.tsx` 仍钉一条防回归——**不需要**页面接线守卫 |
| 14 | A/B 分段让「真实数据下不可见」被误判成缺陷 | §12 明文登记，并在 README 的排障表补一句 |
| 15 | 改「查看日志」文案时漏掉既有断言 | §8 的修订表逐文件列出，含两处测试与三处注释 |
| 16 | **无人值守下 `ask-user` 会无界挂起**（dsh 逐字：无 `timeout-policy` 预算，只能靠轮次的 signal） | 卡片把「等待答复」画成**独立于七态的一格** + 走秒表 + 固定区徽标（§5.5，D21/D23）。本仓**不能自己收场**，故如实显示等待时长，而不是假装成 `timeout` |
| 17 | 「还在等」被显示成某个已收场的态（或反过来，一次没采到的结果被永远读成「还在等」） | **2026-10-02 起由类型保证**：`AskUserPending` / `AskUserSettled` 是判别联合，那个矛盾组合（初版的 `answers 非空 + outcome === null + running === false`）**写不出来**（D35）；§10 变异体 (j) 专验 |
| 18 | **`AskUserAnswer.selected` 按 id / 下标匹配**：答案看起来有、其实错位 | §5.5 第 1 条口径（按 `label` 匹配）+ §10 变异体 (i)；这是最难发现的一类错 |
| 19 | claude 的 `TaskStep.id` 来源未定（v2 spec §11.1 第 27 项）⇒ 依赖与 `owner` 落空 | `id === null` 时**不画 id 与依赖**、`owner === null` 时整格不显示（§5.4）。**不自己发号**；缺口闭合后 UI 无需改动 |
| 20 | 计划清单在多轮里重复出现（跨轮不去重） | 首次展开、其后**默认收起且标题带 `3/5 完成 · +1 完成`**（§5.4 规则 4）；去重要跨轮状态，与 §7.2 的按项渲染相冲 |
| 21 | `secret` 的遮罩被当脱敏 | §5.5 如实登记：遮罩只是**显示口径**，原文仍在结果与事件台账里（「下载台账」拿得到） |
| 22 | 族载荷缺失（B 段未落地 / 适配器不认识）被当成缺陷 | 回退通用工具行是**设计内的降级**（v2 spec §7.6.0：规范化是可选增收）；§10 有一条专测，§12 有逐族登记 |
| 23 | 同一份「任务清单」被画两次（一次 `task` 卡片、一次 `attachment` 块） | §5.4 的边界：判据是**族载荷在不在**，不是在不在 `vendorType` 里；一族认出来就只走一条路 |
| 24 | **分层被绕过：新代码直接 import 上层**（2026-10-02 新增） | §9.0 的三条纪律 + `agent-log-layering.test.ts` 的静态扫描（a–c）；**逐条配变异体 (n)–(r)**。这一条的风险不是"画错了"而是"层塌了"——塌掉后既有的行为守卫**可能全绿**，所以必须有一条专测分层的守卫 |
| 25 | **注册表被当成第二份真值**：有人把默认表复制一份到调用方再改（2026-10-02 新增） | §9.3 的 `BlockRendererProvider` 明确是**叠加**语义（`默认表 ⊕ Provider`），且 `DEFAULT_BLOCK_RENDERERS` 是**唯一**的默认真值；变异体 (o) 专验「覆盖成整体替换后默认臂必须还在」 |
| 26 | **L0 偷偷持态**（2026-10-02 新增） | §9.0 纪律 2 要求全部受控，`agent-log-layering.test.ts` 的 (e) 条**静态**禁止 L0/L1 出现 `useState`。这条之所以要静态钉：自己持态的折叠件在**当前**用法下表现完全正常，只有在被挂第二个实例时才暴露（而那时已经晚了） |

---

## 10. 明确标注为「有意不显示 / 不进 UI」的每一项（+ 一句理由）

> 这一节是最容易被重写时误删的一类内容——源文档反复用「有意/如实登记/不进 UI/删」这类字眼标注它们。

### 10.1 契约层：有意不进 UI 的字段与类型

| # | 名字 | 理由（一句话） |
|---|---|---|
| 1 | `ThinkingBlock.signature` | **有意隐藏的 replay 校验串**，不进任何呈现，**UI 连拿都不该拿到**（§4.1 对照表、§8.8） |
| 2 | 规范的 `index` | 审计线索的职责，不是 UI 的（§4.1 对照表） |
| 3 | 规范的 `normalizedFrom` | 审计职责；给它就等于让 UI 变相按厂商分支（§4.1 对照表、§8.5） |
| 4 | 消息信封的 `raw`（消息级） | 初版推给「台账的职责」被**判为不成立**——台账是 `formatEventLog` 的文本行，承载不了未归类字段；**处置**：`UnrecognizedPayloadBlock.raw` 是它的出口（§8.8） |
| 5 | `vendorTurn` | 规范逐字「恒 `null`，不显示」；UI 只吃统一的 `round`，厂商轮号换算/另存是数据层的事（§4.1 `LogTurn.round`、§8.8） |
| 6 | `step` | 同上（规范逐字「恒 `null`，不显示」）（§8.8） |
| 7 | `seq` / `chunk` / 合并键 | 规范逐字「消费方只实现 snapshot 也能正确渲染」；两源合并是数据层内务（§4.1 纪律 1/3、§8.8） |
| 8 | `AgentLogFacts.durationMs`（行级） | 它会**每秒变**；契约里放一个会自己走的数等于让数据层承担渲染压力（§4.1 评估表） |
| 9 | `attempts`（重试次数） | 它是**候选行**的属性，不是执行日志的属性；行卡片上已有「已重试 N 次」标签（§4.1 评估表） |
| 10 | `TaskListArgs`（v2 空壳 `{ /* 无参数 */ }`） | 空参数占位；「清单从哪读」是适配器的知识，留一个空壳会误导下一个人（§4.1 评估表） |
| 11 | `TaskListResult.commitModel` | v2 已明文「**不允许把补丁原样抛给 UI**」；UI 拿到它只会多出一种「自己也来合并一次」的写法（§4.1 评估表） |
| 12 | v2 的 `ToolData`（`args` + `result` 装在一起） | **不照搬**：UI 只需要「本次调用后的归一结果」，给它两半等于让它自己判断 dsh 的清单在 args 里、claude 的在结果累积里（§4.1 评估表） |
| 13 | `LogNodeRef` + `siblings` | 删：N 个节点就有 N 份重复列表；扁平数组 + 一次 `filter` 是 O(n) 且不重复存储（§4.1 评估表） |
| 14 | `chain`（面包屑链） | 删：从 `nodes` + `activeNodeId` 顺着 `parentId` 走一遍即可，**存一份就是第二份真值**（§4.1 评估表） |
| 15 | `diff` / `score`（定字段） | 移出，改 `facts.domain`：它们是**领域事实**，定字段等于每加一格事实都要改契约（§4.1 评估表） |
| 16 | `status: EvalRowStatus` | 改 `{ tone; label }`：`EvalRowStatus` 是**评测编排**的十态词汇，写进通用件与 D18 冲突（§4.1 评估表） |
| 17 | `tokens.reasoning?: number` | 移出，改与 `tokens` 并列的 `thinking` 且必须带 `basis`（§4.1 评估表） |
| 18 | `kind: 'subagent'` 的块 | 删：subagent 是**与消息平级的独立事件、不是消息的子结构**；导航改由 `LogNode.spawnedBy` 派生（§4.1 对照表、§4.2 规则 3） |
| 19 | `structured`（工具结果的结构化结果） | **仍不承载**：本期不渲染任何族的结构化结果，收编一族时再按需加逃生格。**代价**：`read` 的行数、`grep` 的命中数只能读原文自己认（§8.5 末） |
| 20 | `usage.total` / `apiMs` / `ttftMs` | **不进 UI**：规范说「适配器不预先算比率」，本设计不做这几格 ⇒ 界面也没有落点。**代价**：厂商自报总量与归一值不一致时无可对照（§8.5 末） |
| 21 | 派生指标（缓存命中率 / tok/s / 首字延迟） | 同上（§8.5 末） |
| 22 | 图片缩略图 | **不加载**：结构留位、渲染占位，加载远程资源牵出鉴权 / 体积 / CSP 三件事（§6.10、§8.5 末） |
| 23 | `ToolResultBlock` 里的附件出口 | **本期不加**：规范说 claude 的图片可以出现在工具结果里，但本仓工具结果以文本为主，加这一格会多一层嵌套（§6.10） |
| 24 | `AgentLogModel` 里的 `log` 原文 | 不进主模型：几千行、面板默认收起 ⇒ 独立 `Loadable` 按需注入（§4.1 评估表、§5.3.1） |
| 25 | `AgentEnvironment` 里的**用户提示词** | **环境抽屉里不重复列**：对模型说的话属于**对话**，不属于环境配置；由时间轴首条承载（§4.3、D19） |
| 26 | `content` 的 `load()` 回调形态 | 删：那是把**数据层的取数时机**泄进了 UI 契约；改成按值给（§4.1 纪律 2） |
| 27 | 「`useRowLog` 与 `useRowStream` 按 `seq` 并集」整节（原 §5.4） | **整节删除**：数据层对外只该给一条已经合并好的流（§4.1 纪律 3、§5.3.1 依赖第 2 条） |
| 28 | 前端的大小上限判断 | **UI 不判断大小**：`input.text` / `output.text` 的长度上限与 `truncated` 标记由数据层算好（否则等于把全量先传到浏览器再丢掉）（§4.1 纪律 4） |

### 10.2 界面层：有意不显示的元素与状态

| # | 名字 | 理由（一句话） |
|---|---|---|
| 29 | `role === 'assistant'` 的角色标签 | **不标注**——它是默认的主角，标了反而吵（§6.9） |
| 30 | `role === 'tool'` 的额外标签 | 由工具类块自身表达，不另标（§6.9） |
| 31 | `source === 'hook'` 的角标 | **不标**（只标 `session-file` → 「补录」、`aggregate` → 「汇总」）（§6.9） |
| 32 | `owner === null` 的整格 | `null` = 这一家没有「指派」这个概念 ⇒ **整格不显示**；`''` 才显示「未指派」（§5.4 四种情形） |
| 33 | `TaskStep.id === null` 时的 id 与依赖 | **不画 id、也不画依赖**（`blockedBy` 的值就是 id）；**不自己发号**——编出来的 id 会让「依赖」看起来解析成功了（§5.4） |
| 34 | 主会话节点的 `usage` 这一格 | **主会话为 `null` 时不显示这一格**（整行用量在 `facts.tokens`，不存第二份真值）（§4.1 `SessionNode.usage`、§10 `node-kind-render.test.tsx`） |
| 35 | 抽屉里的「中断这一轮」按钮 | **刻意不做（本期）**：单行终止已经在行卡片上（`onAbortRow`），抽屉里再放一个是同一动作的第二个入口，两个入口的可用面必然漂移（§6.7 末） |
| 36 | 卡片上的「回答」按钮 | **不提供**：本仓没有应答 handler（`approvalPolicy: 'never'`），给一个只在某些场景可用的输入框会让「评测里的提问为什么没人答」更难解释（§5.5 末、§12） |
| 37 | 「填写中」/ 逐字打字机（已展开的思考块） | **不做字符级打字机**：文字只追加不重排，本身已经是「顺着读」的；逐字打字机要维护追逐缓冲，还会与 `prefers-reduced-motion` 打架（§6.7） |
| 38 | 折叠箭头的手写 `▸` `▾` | **不自己写**（§6.1 表格里那些符号只是文字示意）；用 `Collapse` 自带 `expandIcon`（§9.6） |
| 39 | 裸 `nav` 面包屑 | **不是**裸 `nav`（初版写错过），用 `Breadcrumb`（§9.6） |
| 40 | 原生 `<details>` 折叠 | 不写原生 `<details>`：`destroyOnHidden` / `items[].extra` / `activeKey` 受控三条都要（§9.6） |
| 41 | `Steps` 组件（计划清单） | **不用 `Steps`**：它把清单读成线性流程，而且表达不了 `unknown` 这一档（硬塞成 `wait` 就是「看起来采到了」）（§9.6） |
| 42 | 组件的文案里的本仓 `approvalPolicy` 与 dsh 硬编码 | **仍未闭合的 P1**（但 `ask-user` 的 `unavailable` 原因位已由 `outcome` 与结果原文承担）（§8.3） |
| 43 | `AgentLogView`（组件名） | D24 之后「主件」概念被拆成三层，**这个名字不再使用**（§9.5） |
| 44 | `log-view.tsx` | **删除**（被 `agent-log-drawer` 取代）（§9.5） |

### 10.3 行为层：有意不做的功能（与 §12 五项 + §2 非目标呼应，此处只列「有意不显示」角度）

| # | 名字 | 理由（一句话） |
|---|---|---|
| 45 | 抽屉内全文搜索 | 轮次跳转器 + 过滤已覆盖「能不能找到」（§2 非目标、§12） |
| 46 | 轮次级「折叠全部 / 展开全部」 | D7 选了「事实内容开箱即见」，批量折叠与它相冲（§2 非目标、§12） |
| 47 | 抽屉之外的「正在等待答复」提示 | 跨页面提示要动列表页与行卡片的 state，是另一件事（§2 非目标、§12） |
| 48 | diff 正文渲染 | 「变更详情」抽屉已负责（§2 非目标） |
| 49 | 厂商会话文件（rollout / `rollout-*.jsonl`）作为消息来源 | 沿用 v2 spec §12 的口径（§12） |
| 50 | 其余 8 个工具族的专门渲染 | 走「工具名 + 参数摘要 + 文本结果」的通用工具行；v2 spec §7.6.4 的通用回退不算失败（§2 非目标、§12） |
| 51 | 适配器改造 | 把三家厂商事件投影成 v2 的 `message` / `subagent-start` / `subagent-end` 是 v2 spec 的实施范围（§2 非目标、§12 B 段） |
| 52 | 评分通路与 `finalText` 语义的改动 | 不改（§2 非目标） |
| 53 | 「完全不同的交互形态」的成品（对话式 UI / 实时监控台） | §2.1 只要求这一层**做得出来**，不要求本期做出来；**不要把「可重组」读成「已经做了五个界面」**（§2 非目标、§12） |

---

## 11. 对外部文档的修订要求（§8.2 表，14 行）

| # | 文件 | 现状 | 改成 |
|---|---|---|---|
| 1 | `README.md:168` | 「查看日志 \| …可「下载」为 `.log`（**内容与抽屉逐字一致**）」 | 按钮名改「执行日志」；下载说明改为「下载原始事件台账（与抽屉视图不同：台账是逐条事件原文，抽屉是按轮次组织的视图）」 |
| 2 | `README.md:215` | 按钮顺序口径写「查看日志」 | 逐字改为「执行日志」（**顺序不变**） |
| 3 | `README.md:241` | 排障表里「对照「查看日志」抽屉里 `[codex]` 那几行」 | 改为「对照『执行日志』抽屉的『原始输出』里的 `[codex]` 那几行」 |
| 4 | `eval-row-card.tsx:208` 的按钮 | 「查看日志」 | 「执行日志」 |
| 5 | `eval-row-card.test.tsx` 的可访问名断言 | `['查看日志', …]` | 逐字改（**顺序断言的口径不变**） |
| 6 | `2026-09-29-diff-drawer-redesign-design.md` §7.2.1 ③ | 「抽屉内只有一个滚动容器，就是 `.ant-drawer-body` 自己」 | 补一条修订说明：**执行日志抽屉**改用虚拟列表自持滚动容器；变更详情 / 评分详情两抽屉口径不变，`body` 仍 `padding: 0` |
| 7 | `agent-activity-line.tsx:18` 注释 | 「全量内容本来就在「查看日志」里」 | 改「执行日志」，并补「子任务内容在面包屑里」 |
| 8 | `packages/server/agents/src/turn.ts:343` 注释 | 「使用者看的是「查看日志」抽屉」 | 改「执行日志」 |
| 9 | `docs/superpowers/specs/2026-09-22-features-design.md:168` 的版式图 | `[查看日志]` | 改「执行日志」（历史 spec 的版式图，**改文案不改结构**） |
| 10 | `README.md` 的排障表 | **无此条** | **新增一行**（A 段做完后必须加，否则第一个跑真实评测的人会以为功能坏了）：「打开『执行日志』看到『还没有日志』且这一行明明跑过」→ 原因是消息事件（`message` / `subagent-*`）尚未进入契约，属 §12 的 A/B 分段，**不是缺陷** |
| 11 | `2026-09-30-agent-message-spec-design.md` §7.6.2 ⑨ / §7.6.4 | 族结构写成 `ToolData`（`args` 与 `result` 装在一个判别联合里），且 `TaskListArgs` 是空壳 `{ /* 无参数 */ }`；两族的 UI 形态只有一句「状态化清单面板」/「问答卡片」 | 补三条落地说明：① 族结构落到 v2 的**块**上时**只挂 `tool-call` 块**、由数据层回填，且给 UI 的是「本次调用后的归一结果」（清单在 dsh 的 `arguments` 里、在 claude 的结果累积里，由适配器读）；② `commitModel` 与 `TaskListArgs` 空壳**不进 UI 契约**；③ 两族在**轮次时间轴**里的位置、折叠默认态、同轮多次调用的画法，以本文 §5.4 / §5.5 为准 |
| 12 | `2026-09-30-agent-message-spec-design.md` §11.1 第 27 项 | `TaskCreate` 的 `taskId` 来源未定（`TaskStep.id` / `blockedBy` 因此可能落空） | 本文按「**不编 id**」处置（§5.4）：`id === null` 时不画 id 与依赖，`owner`/`blockedBy` 两格如实少画。该缺口闭合后 UI 无需改动（它吃的是整表结构） |
| 13 | `2026-09-30-agent-message-spec-design.md` §7.0.5 / §7.6.4 / §11.1 第 22 项 | `message.turn` 三家语义不同，**定案前不得用于跨家比较或分组**，而初版 D1 把它当成 `usage.turns` 的同义词并据此分组 | 本文的 UI 契约**不出现 `message.turn`**：分组用数据层给的**统一轮次号** `LogTurn.round`（= `usage.turns` 口径）。换算落在数据层（沿用 v2 倾向的方案①：`turn` 正名为模型往返序号、厂商轮号另存 `vendorTurn`）；**v2 定案后本文无需改动** |
| 14 | `2026-09-30-agent-message-spec-design.md` §7.7（`UsageEvent.thinkingTokens` / `usageCapability.thinkingTokensBasis`） | 思考 token 与 `tokens` **并列**、**不得塞进三元组**，可加性由 `basis` 决定（v2 §7.7.0 与 §11 待办 3） | 初版把 `reasoning?: number` 放进 `tokens`，与 v2 相反；本修订改为**与 `tokens` 并列的 `thinking: { tokens; basis } \| null`**，并把可加性口径写进注释 |

**另有一条对 v2/v3 spec 的引用纪律**（§8.1 的引言）：**本文对 v2 spec 一律按小节（§）引用，不引用行号**——v2 spec 正在被并行修订，行号随时会漂移（审查时的行号在审查记录里，那两份是当天的快照）。

---

## 12. 交叉引用热点

### 12.1 统计口径

全文共 **611 处 `§` 引用**（正则 `§\s?\d+(\.\d+)*`）。**注意**：源文档同时引用**自己的小节**与**外部 v2/v3 spec 的小节**，两者的节号在字面上不可分（例如 `§7.6.4` 是外部 v2 spec，`§4.1` 是本设计自己的）。下面给「粗略排序」，并对已知的外部引用做标注。

### 12.2 被引用最频繁的前十名（内部节号为主）

| 排名 | 节号 | 次数 | 备注 |
|---|---|---|---|
| 1 | **§4.1** | 68 | 契约与五条边界纪律；全文的引用重心 |
| 2 | **§4.2** | 37 | `buildRenderBlocks` / `RenderBlock` / `ToolItem` / `RowEvent` / `ContentBlock` |
| 3 | **§5.4** | 29 | `task` 卡片（四条硬规则、四种没有清单的情形） |
| 3 | **§5.5** | 29 | `ask-user` 卡片（七态 + 等待态 + 答案回填三条口径） |
| 5 | **§6.1** | 25 | 折叠默认态 + 五条例外 + 三种空 |
| 6 | **§10** | 21 | 测试计划与变异体 |
| 7 | **§7.2** | 20 | 虚拟滚动（**含 1 处外部 v2 spec §7.2**） |
| 8 | **§6.8** | 17 | 环境抽屉 |
| 8 | **§7.6.4** | 17 | **全部是外部**（v2/v3 spec 的渲染契约节） |
| 10 | **§5.2** | 16 | 行级事件去向表（**含若干外部 v2 spec §5.2**） |
| 10 | **§6.3** | 16 | 子任务占位条与面包屑兜底 |

紧随其后：**§5.3.1**（15）、**§6.7**（14）、**§5.3**（14，含外部 v2 §5.3）、**§2.1**（13）、**§8.3**（13）、**§9**（13）、**§12**（13）、**§11**（11，含外部 v2 §11 待办 3）、**§4.4**（11）、**§7.1**（10）、**§4.3**（10）、**§7.6.2**（10，**全部外部**）、**§9.7**（10）、**§5**（8）、**§6.5**（8）、**§6.9**（7）、**§9.4**（7）。

**纯外部（v2/v3 spec）的高频节号**：`§7.6.4`（17）、`§7.6.2`（10）、`§7.6.2 ⑨/⑩`、`§7.0.5`、`§7.7` / `§7.7.0`、`§11.1 第 22 / 27 项`、`§7.6.0`、`§5.1`/`§5.2`/`§5.3`（部分）、`§6`、`§8.1`、`§8.2`、`§10`、`§12`、2026-09-29 spec `§7.2.1 ②/③`。

### 12.3 「为读懂一句话必须跳到别的小节」的典型例子（12 个）

| # | 起点（那句话在哪） | 必须跳到 | 为什么非跳不可 |
|---|---|---|---|
| 1 | §4.1 `LogTurn.round` 的整段注释（「统一轮次号」「不是 v2 的 `message.turn`」） | 外部 v2 spec §7.0.5 / §7.6.4 / §11.1 第 22 项 + 本设计 §3 D1 + §11 验收 8 + §12 配置开关表末行 | 不跳就不知道「三家三个不同的量」「codex 系统性偏高」「为什么初版在 dsh 上会得到『进度条 60 轮、时间轴 1 轮』」；也读不懂 §11 验收 8 的 2026-10-02 更正 |
| 2 | §4.2 修订 1（`streaming: boolean` 被删、改由 `block.assembly` 承担） | §4.1 纪律 1（声称模型里有 `streaming` / `running` 两个布尔）+ §6.7 + §6.9 + §9.1 `BlockRenderContext.streaming` | 「为什么必须删」的论证完全落在「入参里没有这个信息」这一句上；而 §4.1 纪律 1 至今仍写着那两个布尔，不跳过去就看不出这是一处**未修的自相矛盾** |
| 3 | §4.2 规则 3（派发点判据：`nodes` 里某节点的 `spawnedBy` 命中本轮块） | §4.1 `LogNodeBase.spawnedBy` 的整段注释（「为什么必须有这一格」） | 不跳就不知道初版曾有一个 `kind: 'subagent'` 的块、以及为什么要删掉它（subagent 是与消息平级的独立事件） |
| 4 | §5.2 去向表的 `usage` 行「仅当令牌数创新高」 | 同节下方的「`usage` 的『创新高』规则」段 + §5.5「等待输入」段 | 那张表只给「是/否」，判据（三项之和超过此前最大值、`turns` 不追加、纯派生）全在同节下方；不跳会把「创新高」读成「每轮」 |
| 5 | §5.4 规则 4「跨轮不去重……与 §7.2『按项渲染 + 虚拟列表乱序挂载』相冲」 | §7.2（`buildRenderBlocks` 必须在按项渲染回调里被调用 + L1/L2 分层表） | 「为什么不去重」的**全部理由**是「去重需要跨轮状态，而按项渲染看不见上一轮」；不跳会以为是偷懒 |
| 6 | D35 的论证（「按 §5.5 判据会渲染成『结果未采集』，**而答案就在手上**」） | §5.5 的判据表（三条 `state`/`running` 组合）+ §4.1 `Loadable` 的注释（「允许 `isLoading && error && data` 这种自相矛盾的组合存在」） | D35 的全部力量来自「它违反的是本设计自己的标准，不需要规范背书」——不跳到 `Loadable` 的注释就看不到那条标准 |
| 7 | §6.1 例外 3（`thinking.text === null` 显示 `textMissing` 对应的中文） | §4.1 `MissingReason` 的定义（四态各一句语义）+ §6.8 内容布局 4（`MissingReason` 映射成中文，如 `not-exposed` → 「厂商没有暴露给我们」）+ §10 `capability-notes.test.tsx` 的四句文案 | 「对应的中文」到底是哪四句、四句为什么要互不相同，只在另外三处 |
| 8 | §6.5 过滤条（「`命中 12 / 83 轮` 与『已渲染 N / 共 M 轮』是两个不同的数……见 §7.2」） | §7.2（「已渲染 N / 共 M 轮」随虚拟化归 L2，只有 `VirtualTurnList` 在列表尾部给，用 `onVisibleChange` 取 N）+ §9.5 文件清单 | 不跳就不知道后者由谁渲染、为什么 `MessageTimeline` 不渲染它（不虚拟化时 N === M、这一行没有信息量） |
| 9 | §6.7 动效 1（「复用现有具名出口 `ACTIVITY_SWEEP_CLASS`」） | §6.7 末段「为什么扫光只给折叠态的标题」+ §9.6 选型表 + §9.6 末段「一条允许的例外」（`ui` 包一个 CSS 文件都没有） | 「为什么只能用类名实现、不能写 keyframes / 字号」的约束在 §9.6 末段，不在 §6.7 |
| 10 | §6.8 约束 2 末（「**注意别把这条读成『不能向数据层要数据』**」） | §4.4 `AgentLogSource` 三条口径 + §4.4 口径 3（`requestEnvironment` 每次打开各调一次） | 不跳会把「不订阅流」误读成「不许取数」，正是文档点名的那个失败面（「点了问号却永远停在『读取中』」） |
| 11 | §9.3 末段「**『零改动』的确切含义**（免得读成夸张）」 | §4.2 扩展性第 1 / 5 条 + §2.1 S4 + §9.5 的文件清单 | 「零改动」被明确限定为「不改 `agent-message-timeline` / `agent-log-layout` / `agent-log-drawer` 与其余渲染件」，但**契约与默认注册表仍要动**——这层限定只在跨这三处合读时才成立 |
| 12 | §12 配置开关表末行（「**⚠️ 本设计 D1 与 §11 验收 8 声称『跨三家可比』与这条相反**」） | §3 D1 的 2026-10-02 更正 + §11 验收 8 的 ⚠️ 段 + D27（`source` 标注） | 这是一处**自我指认的矛盾**：三处必须合读才能确认「现已改为『同口径可比』」，单读 §12 会以为 D1 仍在说「跨三家可比」 |
| 13 | §9.7 `AgentRunStateTagProps.missingReason` 的注释「（`capability` 给…）」 | §4.1 `CapabilityDecl` / `MessageCapability`（五个维度名）+ D28 的第 ② 条理由 | D28 的**起因**就是这条注释：契约里原本没有 `capability` 这一格 ⇒ 该参数恒为 `null`、组件被自己的契约判成空转。不跳就读不出这个因果 |
| 14 | §10 `agent-log-layering.test.ts` 的 (a)–(f) 六条扫描项 | §9.0 三条硬纪律 + §4.1 纪律 5 + §7.2（(c)(d) 的虚拟列表禁令） | (e) 对应纪律 2、(f) 对应纪律 3、(c)(d) 只在 §7.2 有理由 |

### 12.4 「同一句话在四轮修订里被改过」的高危点（重写时最易取错版本）

| 主题 | 各轮说法 | 现有唯一口径 |
|---|---|---|
| 轮次可比性 | 初版 D1「跨三家可比」→ 2026-10-02 更正「同口径可比」 | **同口径可比** + `source` 标注（D1 / D27 / §11 验收 8 / §12 末行） |
| `streaming` 从哪来 | 初版 `RenderBlock.streaming: boolean` → §4.2 修订 1 删掉，改 `block.assembly === 'open'` | `block.assembly === 'open'` 是**唯一合法判据**（§4.2 / §6.9）；但 §4.1 纪律 1 与 §9.1 `BlockRenderContext.streaming` **未同步** |
| `attachment` 的语义 | 初版 = 「不认识的厂商载荷」→ D31 归还给真实附件，兜底改 `UnrecognizedPayloadBlock` | **`attachment` = 真实附件；`unrecognized` = 兜底原文**（§4.1 / §5.3 / §6.10）；但 §5.4 / §6.1 / §11 验收 10 / §13 仍写着旧口径 |
| 「还没收场」怎么表达 | 初版 `outcome: null` 独立一格 → D35 改成 `AskUserPending` / `AskUserSettled` 判别联合 | `state: 'pending'` + `running`（§4.1 / §5.5）；D21 的原文仍写 `outcome: null` |
| 工具条动作数 | 初版「六项硬编码」→ D26 改成「默认动作集是一套预设」 | `ToolbarAction[]` + `AgentLogToolbarPreset`；**动作名实为 7 个**（§6.6 / §9.4 / §9.5） |
| `counts` 三格 vs 四格 | 初版三格 → D36 补 `unknown` | 四格（§4.1 / §5.4 / §10 / §11 验收 19） |
| 子任务状态档数 | 初版（5：running/completed/failed/canceled/unknown）→ D33 补 `stopped` + `unsettled` | 枚举 **7 个成员**（§4.1 / §10 / §11 验收 34）；但 §4.1 字段注释、D33 标题、§8.5 仍写「六档」 |
| `RenderBlock` 臂数 | 初版七臂 → D31 加 `unrecognized` → D32 加 `row-summary` | **9 臂**（§4.2）；但 D25 / §9.3 / §10 注册表用例仍写「七臂」 |

---

## 附录 A. 读文档时发现的「自身自相矛盾 / 写漏了」的地方（按节号，重写时必须一并裁决）

> 这一节不在用户要求的 12 类之内，但是本次通读最有价值的产出：**其中多数是「某轮修订只改了一半」留下的**，重写时若照抄旧句，会把已经裁决过的口径又写回去。
> 分级：**A 类 = 会误导实现**；**B 类 = 计数/自指不一致（不影响行为，但会让「是否改全」无法核对）**；**C 类 = 引用悬空（名字用了但没定义）**。

### A 类：会误导实现的自相矛盾（9 条）

| # | 节号 | 矛盾内容 | 裁决建议（依本文档自身的最新口径） |
|---|---|---|---|
| A1 | **§6.1 折叠默认态表** 的 `attachment` 块行 vs **D31 / §4.1 / §6.10** | §6.1 写「`attachment` 块 \| **收起** \| 内容是我们**不认识**的厂商原始载荷，默认不该占地方」；而 D31 已把「不认识的载荷」改判给 `UnrecognizedPayloadBlock`，`AttachmentBlock` 是**认识的**真实附件。§5.3 那张表还专门引用「见 §6.1」 | 该行的**行名应改为 `unrecognized` 块**；`attachment` 块默认态在新口径下**无规定**（§6.10 也没说折叠）——需补一条 |
| A2 | **§11 验收 10** vs **D31 / §5.3** | 验收 10 写「无法归一的厂商载荷走 **`attachment` 块**」；§5.3 与 §6.10 都写 `unrecognized` | 改为 `unrecognized` 块 |
| A3 | **§5.4「与 `attachment` 的边界」** vs **D31** | 写「未归一的厂商载荷仍走 `attachment` 块（§5.3）——**`AttachmentBlock.vendorType`** 举的例子就是 `todo_list`」；而 `AttachmentBlock` 已无 `vendorType` 字段（`vendorType` 现在在 `UnrecognizedPayloadBlock` 上） | 类型名改 `UnrecognizedPayloadBlock.vendorType` |
| A4 | **§8.1 机械改动段** vs **D31** | 写「`ContentBlock.vendorType` → **`AttachmentBlock.vendorType`**（§5.4）」——这是 2026-10-01 的机械改名，已被 2026-10-02 的 D31 推翻，但该句未撤回 | 撤掉或加删除线并指向 D31 |
| A5 | **§4.1 纪律 1** vs **§4.2 修订 1**（+ 模型实际字段） | 纪律 1 写「UI 只看到**已成形的块**与两个布尔（`streaming` / `running`）」；§4.2 修订 1 逐字指出「§4.1 纪律 1 声称模型里有 `streaming` / `running` 两个布尔，**而模型里一个都没有**」。`AgentLogModel` / `LogNode` / `LogTurn` 里只有 `LogTurn.running`，没有 `streaming` | §4.2 已裁决：流式判据是 `block.assembly === 'open'`；**§4.1 纪律 1 那句必须改**（否则下一个人会去模型里找 `streaming`） |
| A6 | **§9.1 `BlockRenderContext.streaming: boolean`**（+ §10 `agent-message-timeline.test.tsx` 的「`streaming` 时挂扫光类名」）vs **§6.9「`assembly === 'open'`（唯一判据）」/ §4.2 修订 1** | 组件层又出现了一个 `streaming` 布尔，并被注明是「§6.7 的动效判据」——与「唯一合法判据是 `block.assembly === 'open'`」直接冲突。§4.2 修订 1 说得很死：**「不得用『有没有后续块』推断」**，而一个轮级/上下文级的 `streaming` 正是那种推断的载体 | 二选一：① 删 `BlockRenderContext.streaming`，动效只读 `block.assembly`；② 明确它是 `LogTurn.running` 的转发且**只用于非动效**用途。**必须补一句裁决** |
| A7 | **§10 `render-blocks.test.ts` 的覆盖点** vs **§4.2 末段** | §10 说该用例覆盖「**`running` 与失败组的默认折叠态**（§6.1 的例外条款）」；而 §4.2 末段逐字写「**折叠默认态不在这里**（初版写错过）：`buildRenderBlocks` 只输出结构与状态；『思考块默认收起』『进行中的组默认展开』『失败的组默认展开』是 §6.1 的**组件内** `activeKey` 计算」，§6.1 也重复了「不在纯函数里」 | 该用例的这条覆盖点应移到组件测试（`agent-message-timeline.test.tsx` 已有对应条目），或改写为「纯函数**只转发** `running`，不产出折叠态」 |
| A8 | **§10 `agent-log-facts-bar.test.tsx` 前身/§11 验收 10 与 §5.3.1 的 props 说法** vs **§4.4 / §9.2** | §5.3.1 写「**props（§9）**：`diagnostics?: Loadable<AgentLogDiagnostics>` + **`onRetryDiagnostics?: () => void`**——**由调用方在抽屉打开时取**」；而 §4.4 已把散回调收进 `AgentLogSource`（`requestDiagnostics()`，触发时机是**面板展开**），§9.2 的 `AgentLogLayoutProps` 里**没有** `onRetryDiagnostics`。§8.1 的表（第 2 行）也仍写着 `onRetryDiagnostics?` | §5.3.1 与 §8.1 的这两句是 D24 之前的旧口径；应改为 `source.requestDiagnostics()` + 展开时上报 |
| A9 | **§6.1「折叠状态的作用域与键控」里的 `AgentLogModel.turns`** vs **§4.1 的 `AgentLogModel` 定义** | 那句写「（**`AgentLogModel.turns`** 会随流式追加而变长，下标会漂……）」；但 `AgentLogModel` 的字段是 `specVersion` / `facts` / `nodes` / `activeNodeId` / `rowEvents` / `empty`——**没有 `turns`**（`turns` 在 `LogNode.content` 里，或指派生出的轮次列表） | 改成「`nodes` 里各节点的 `content`（轮次列表）」或「派生的 `turns`」 |

### A 类补：数值口径冲突（各自独立成条）

| # | 节号 | 冲突 | 说明 |
|---|---|---|---|
| A10 | **D21 / §5.5 的表** vs **D35 / §4.1 的 `AskUserSettled`** | §5.5 的七态表仍以 **`outcome: null`（结果还没到）** 作为表格的一行（「七种收场 + 一种『还没收场』」的表里 `null` 是第 1 行）；而 D35 之后 `outcome` 只存在于 `AskUserSettled` 且类型**非空**（`outcome: AskUserOutcome`，七值无空）。D21 的取值栏也仍写「`outcome: null`（还没收场）是独立于七态的一格」 | §5.5 已加了一段「本节的表因此读作『`state: 'pending'` 那一支内部再分两种』」来打补丁，**但表头那一行 `null` 仍在**，与类型定义对不上 |
| A11 | **§4.2 `ToolCardResult.truncated: boolean`** vs **D30 的裁决理由** | D30 把 `ToolResultBlock.truncated: boolean` 改判为 `truncation: TruncationState`，理由是「裸布尔让『确认完整』与『没采到标记』在界面上完全一样」；而同一轮新增/保留的 `ToolCardResult`（卡片底部的「原始结果」）**仍是 `truncated: boolean`**，且它正是卡片底部那条「原始结果 ▾」的数据源 | 要么同步改成 `TruncationState`，要么**明确写一句为什么卡片底部可以只用布尔**（否则 D30 的理由在同一个文档里被自己违反；§10 的 `truncation-unknown.test.tsx` 也只覆盖了 `ToolResultBlock` 一侧） |
| A12 | **§6.7「五处动效」** vs **§11 验收 13「块一结束四处动效全部停下」** | 同一件事在两处数不同（5 vs 4）。§6.7 的第 5 处是「固定区状态徽标」，它严格说不属于「块」——所以验收 13 的「四处」可能是有意的，但**文档没有说明这一处差异** | 补一句「第 5 处（固定区徽标）随整行状态而非块结束」或把验收 13 改为五处 |
| A13 | **D26 / §6.6 / §9.5 的「六个动作」** vs 实际列出的 **7 个动作名** | D26 写「不是**六个**硬编码控件」，括号里列了 **7** 个（下载台账 / 跟随最新 / 跳到轮次 / 只看工具调用 / 只看错误 / 原始输出 / 环境信息）；§6.6 的表是 **6 行**（第 4 行把「只看工具调用 / 只看错误」两个控件合并成一行）；§9.5 写「默认**六个**动作（§6.6）：」后面同样列了 **7** 个名字 | 建议统一为「**7 个动作 / 6 行表**」，或把「只看工具调用」「只看错误」明确算作一个复合动作 |
| A14 | **§4.1 `LogNodeBase.status` 注释「六档」/ `LogNodeStatus` 定义注释「六档」/ D33 标题「状态六档」/ §8.5 落点表「状态六档」** vs **枚举实际 7 个成员 / §10 `agent-log-shape.test.ts`「七档」 / §11 验收 34「七档」 / §10 `node-kind-render.test.tsx`「`status` 六档各有一句中文」** | 同一个类型在四处被叫「六档」、三处被叫「七档」。枚举本体是 7 个成员（`running` / `completed` / `failed` / `stopped` / `canceled` / `unsettled` / `unknown`）。§4.1 的注释试图自洽（「为什么要六档而不是『五档 + 一个 unknown』」），但那样一来「六档」到底含不含 `unknown` 全文没有交代 | 建议统一为「**七个取值：六个实义状态 + `unknown`**」并在定义处写死 |
| A15 | **D25「`RenderBlock` 的七个臂」/ §9.3「默认注册表：七臂齐全」/ §10 `block-renderer-registry.test.tsx`「七臂齐全」「默认七臂仍然可用」/ §8.4 对照表「`RenderBlock` 七臂」** vs **§4.2 的 `RenderBlock` 定义（9 个 arm）** | D31 加了 `unrecognized`、D32 加了 `row-summary` 之后，判别联合是 **9 臂**（text / thinking / tool-group / attachment / unrecognized / subagent-bar / row-summary / task-panel / ask-user-card）。**「七臂」是 D31/D32 之前的数**，散落在四处未同步（`block-renderer-registry.test.tsx` 与 `agent-log-shape.test.ts` 都靠这个数做断言） | 全部改为「九臂」；否则「类型层强制、漏一臂编译不过」的守卫会与用例计数对不上 |
| A16 | **§10 冒烟清单标题「jsdom 验不出……的**五项**」** vs 实际列出 **6 项**（编号 1–6） | 第 6 项「流式不卡（§7.1）」是后加的，标题未改 | 标题改「六项」 |

### B 类：自指/计数不一致（不影响行为，但影响「是否改全」的核对）

| # | 节号 | 内容 |
|---|---|---|
| B1 | **§4.1 扩展性标题「（三条，回答『以后加东西会不会推翻它』）」** vs 实际列出 **7 条** | 标题的「三条」是初版的数；D28 加了第 6 条、D32 加了第 7 条 |
| B2 | **§8.5「本轮顺带闭合的既有登记」第 5 条** | 写「`MissingReason` / `CapabilityLevel` 从未定义取值集合 → §4.1 已定义（**含四态各一句中文文案，见 §6.8**）」。但 §6.8 只举了 **1 个**映射例子（`not-exposed` → 「厂商没有暴露给我们」）；四句互不相同的文案实际在 §10 `capability-notes.test.tsx` 里 | 
| B3 | **§11 验收 31 引用的文件名 `render-blocks-streaming.test.tsx`** vs **§10 表里的 `render-blocks-streaming.test.ts`** | 同一文件两个扩展名（`.tsx` / `.ts`）；该用例断言的是纯函数与 `RenderBlock`，按 §10 的命名应是 `.ts` |
| B4 | **§12「另有**五项**明确不做」** vs **§2 非目标 8 条** vs **§8.4「本轮明确不做」2 条** vs **§8.5「本轮明确不做」5 条** | 四处「不做」清单互有重叠但不完全等价（§12 的五项是 §2 八条的子集 + 新增「不就地回答」；§8.5 的五条是三条根因 + 两条附带登记）。**重写时若合并成一张表，会丢掉「哪一轮登记的」这条信息** |
| B5 | **§12 配置开关表实际 7 行**（用户任务描述里写的是「六条配置开关登记」） | 前 6 行是**配置开关**，第 7 行「codex 近似条目计数」严格说不是开关而是厂商行为；若按「开关」计确实是 6 条，但表是 7 行。**清单按 7 行登记** |
| B6 | **§10 `agent-log-layering.test.ts` 的 (c) 与 (d)** | (c)「L0/L1 不得 import `@rc-component/virtual-list`」被 (d)「除 `virtual-turn-list.tsx` 外不得 import 它」**完全包含**——冗余（不影响正确性，但变异体 (n) 同时引 (c)(d) 两条，实际只需一条） |
| B7 | **§8.3 末段与 §8.5 末段的「未闭合项」表述** | §8.3 说 `TaskPanel` 与规范同名不同形状「**仍未闭合**」（只补了 `SessionNode.source`）；§8.5 的「顺带闭合」清单**没有**列它——与 §8.3 的措辞一致，但读者容易把 §8.5 的 6 条当成「P1 全清了」 |
| B8 | **§10 `agent-message-timeline.test.tsx` 行的「`streaming`」用词** | 同一份文档里，流式判据有 `block.assembly === 'open'`（§4.2 / §6.9）、`LogTurn.running`（§4.1）、`BlockRenderContext.streaming`（§9.1）三个名字，测试行用的是第三个。**重写时必须先统一命名再写用例** |
| B9 | **§9.7「它**只吃了这三个字段**」** vs `AgentRunStateTagProps` 实际有 **4 个成员**（`running` / `hasResult` / `missingReason` / `since?`） | 「三个字段」漏了 `since` |
| B10 | **§9.7「初版把……写进了**两张卡片**各自的内部（§4.2 / §5.4 / §5.5）。重组场景下这会**复制四份**（工具行 / 工具组 / 计划清单 / 问答卡片）」** | 「两张卡片」与「四份」（含工具行、工具组）在同一句里对不上；且括号里的三个节号里 §4.2 并不是「卡片」 |
| B11 | **§1 与 §9.5 对旧件的处置** | §1 说旧抽屉是 `packages/client/ui/src/composite/log-view.tsx`；§9.5 说该文件**删除**、`log-format.ts` 保留。一致，但**§11 没有一条验收覆盖「旧文件已删」**（验收 23 只说三条命令全绿 + §10 逐行对齐） |

### C 类：引用悬空（名字被用了但没有定义）

| # | 名字 | 出现处 | 状况 |
|---|---|---|---|
| C1 | **`TimelineSlotProps`** | §9.2 `timeline?: ReactNode \| ((props: TimelineSlotProps) => ReactNode)` | 全文无定义。「S1 / S5 给 `MessageTimeline`（不虚拟化）」这条接缝**没有类型**，S1 的验收（§11 24）也没说这个函数形态怎么用 |
| C2 | **`AgentLogViewState`** | §9.2 `viewState?: AgentLogViewState`；§9.5「导出 `AgentLogViewState`（受控值 + setter），供 S5 外置」 | 全文无字段清单。「四份视图态」（当前节点 / 跟随最新 / 过滤 / 环境抽屉开合）+ `activeKey` 折叠态到底怎么外置，**无法据此实现**。S5 验收（§11 28）只要求「接缝齐全」，也没点名它 |
| C3 | **`AgentLogToolbarPresetInput`** | §9.4 `useAgentLogToolbarPreset(input: AgentLogToolbarPresetInput)` | 全文无定义。而它的入参至少要知道 `diagnostics` 在不在、`turns.length`、跟随最新/过滤的受控值——**这正是 D26「六项是一套预设」能否落地的关键** |
| C4 | **`AgentKind`** | §4.3 `AgentEnvironment.summary.agentKind: AgentKind` | 全文无取值集合（可能有意指向既有契约；但本篇既已给 `MessageSource` / `MissingReason` / `CapabilityLevel` 补了值域定义，这个漏了） |
| C5 | **`TaskStep` / `AskUserQuestion` / `AskUserAnswer`** | §4.2 末尾明写「字段与 v2 spec §7.6.2 ⑨ / ⑩ 同名同义，本节不重复定义」 | **这是有意的**（不是缺陷），但重写时**必须保留这句指路**，否则 `TaskPanel.steps` / `AskUserPending.questions` / `AskUserSettled.answers` 三个字段会变成无类型可依 |
| C6 | **`AgentLogToolbarPreset`**（名字）vs **`useAgentLogToolbarPreset`**（函数） | D26 / §6.6 / §9.2 写「内聚成 `AgentLogToolbarPreset`」「不传 = 用 `AgentLogToolbarPreset`」；§9.4 定义的却是 `useAgentLogToolbarPreset(...)`，§9.5 的文件名是 `agent-log-toolbar-preset.ts` | 三个名字指同一样东西，**没有一处写清 `AgentLogToolbarPreset` 到底是常量、hook 还是文件** |

### D 类：验证覆盖的空洞（不是矛盾，是「验收没验到」）

| # | 位置 | 空洞 |
|---|---|---|
| D1 | **§11 验收 25（S2）** | S2 的定义是「换一个 `AgentLogModel` + 换一个 `AgentLogSource`；**不许改组件、不许改契约**」（§2.1）；但 25 的判据只验了「`AgentLogSource` **一个方法都不给**时降级正确」，**没有一条验「换第二个模型/第二个来源照样工作」**——即 S2 的核心（可替换性）没被可判定地验到 |
| D2 | **`specVersion: 1`** | §4.1 扩展性第 3 条说它是「给未来留的门」「让『模型形状变了』成为一个可判定的事」；但 §10 全表与 §11 全 35 条**没有一条**涉及它（`contracts/src/agent-log.test.ts` 只测「夹具模型通过类型检查」）。「本期只有 `1`，不加分流逻辑」是合理的，但**没有任何守卫防止有人把 `1` 改成别的值** |
| D3 | **§6.6 末段 vs §6.8 入口段** | §6.6 说「『原始输出』与『环境信息』**两个按钮由预设按数据在不在决定渲不渲染**」；而 §6.8 明确「`environment` 为 `undefined` 时**按钮照常渲染**、抽屉里显示『未提供』——『没有这个功能』与『这次没采到』要分得开」。**同一件事在两节里给了相反的行为**。另外 §6.6 把「未提供（`undefined`）」与「空（`lines: []`）」合并成一句「数据在不在」，而 §10 `agent-log-toolbar-preset.test.ts` 对二者**分别**有断言（说明实现上必须分开），文档句子却没分开 |
| D4 | **§12 的「六处接口要求」** | 以「集中在六处」的形式提出，**没有一条对应到 §11 的验收编号**；B 段落地时这六条是否满足，没有可判定的验收（与验收 23「§10 表逐行对齐」同类的自查机制缺一条） |
| D5 | **§7.4 内存的「处置门槛」** | 写得很好（「若真实冒烟中出现『打开抽屉后内存持续增长』，先量再改」），但**没有进 §10 的冒烟清单**（§10 冒烟只有 6 项，不含内存曲线），也没进 §11 验收——门槛写了却不在任何清单里，容易在执行时被漏掉 |
