# 「执行日志」抽屉重设计 · 通用性与扩展性审查（2026-10-01）

> 审查对象：`docs/superpowers/specs/2026-09-30-exec-log-drawer-redesign-design.md`（下称 **R**，1302 行，状态「待评审」）
> 对照物：`docs/superpowers/specs/2026-09-30-agent-message-spec-design.md`（下称 **V**，v2 消息规范）、
> 现行 `packages/server/contracts/src/`、`packages/client/ui/src/composite/log-view.tsx`、`apps/web-next/src/log-drawer-state.ts`
> 审查口径：R 自己的 D16（按最优形状定模型，不迁就现状）与 D18（`agent-log` 就是那个通用组件，不认「评测行」）
> 记录方式：只审设计，不改设计；每条给「现象 / 证据 / 后果 / 建议」。
>
> ⚠️ **行号是 2026-10-01 审查当时的快照**：此后 R 已按本文的 P0 五条修订
> （登记在 R 的 §8.1，且 R 里对 V 的引用已全部改成按小节引用），V 也正在被并行修订
> ⇒ **本文里的 `R:` / `V:` 行号都会漂移，请按小节标题与小节名定位，不要按行号跳转**。

## 0. 四问四答（先给结论）

| 问题 | 判定 | 一句话依据 |
|---|---|---|
| 具备通用性吗？ | **未达成（传输层达成，业务层未达成）** | `AgentLogFacts` 直接吃 `EvalRowStatus`、评分与 git diff，与 D18 的「不认评测行」自相矛盾（§1） |
| 具备扩展性吗？ | **声明与实现不符** | 三条承诺里「加块类型不改模型」与 `ContentBlock` 的扁平+可空字段形状相反；「收编一族 = 加一个 arm」漏了 `TaskPanel` 与 v2 撞名（§2、§3.4） |
| 不迁就当前项目吗？ | **只做了一半** | 「数据驱动」只在 `EnvGroup` 上落实，`facts` / 工具条 / `capability` / `source` 仍是本项目的硬编码词表（§2.3） |
| 满足重构目标吗？ | **接缝未对齐，会被迫二次改契约** | 时间轴的分组键 `message.turn` 正是 V 明文禁止用于分组的量；「原始输出」在模型里没有归处（§3.1、§4.6） |

**总评**：这份设计在**传输层解耦**上做得比本仓既往任何一份 spec 都干净（五条边界纪律、删 `durationMs`/`attempts`/`siblings`/`chain`、`Loadable`、扁平 `parentId`），
但它把「不迁就现状」只理解成了「不迁就**传输**现状」，没理解成「不迁就**业务**现状」——
于是接缝的一侧是干净的流式模型，另一侧仍是评测行的形状与措辞。按 D16/D18 自己的标准，**通用性这一条不成立**。

---

## 1. 通用性：D18 的「不认评测行」被契约本身推翻

### 1.1 `facts` 就是评测行的形状（P0）

**现象**：`AgentLogFacts`（R:113-148）八格里三格是评测业务专属：

| 字段 | R 行 | 为什么不是「智能体运行」的通用事实 |
|---|---|---|
| `status: EvalRowStatus` | R:114 | `EvalRowStatus` 是**十态**编排状态机（`packages/server/contracts/src/run.ts:37-40`：含 `preparing` / `judging` / `judged` / `interrupted`）。`preparing` 是「准备仓库」、`judging` / `judged` 是「本仓的评分通路」——换一个消费场景（一个智能体自己的运行记录）没有这两段 |
| `score`（`totalScore` / `maxScore` / `judgeAgentKind` / `judgeModelId` / `verdict`） | R:139-145 | LLM 裁判的评分结果，且 R 自己说「详情在『评分详情』抽屉」——那**是另一个 eval-only 组件**。通用消费方没有「尺子」，只能恒填 `null` |
| `diff`（`files` / `insertions` / `deletions` / `truncated`） | R:133 | git 工作区相对 baseline 的产物摘要，属于「评测行怎么跑的」，不属于「智能体说了什么」。R 自己的环境摘要里还有 `baselineCommit`（R:492），即 diff 的意义依赖本仓的 baseline 概念 |

**后果**：D18 写「`AgentLogView` 吃 `AgentLogModel` + `AgentEnvironment`，**不认「评测行」这个业务概念**」，
但模型的第一格就是 `EvalRowStatus`。**同一个模型里还并列着第二套状态词表** `LogNodeStatus`（R:193，五态）——
于是一个抽屉里有两套互不相干的状态词，且其中一套只有本仓有。
「换一个消费场景时，目录里的东西一行都不用改」（R:1059-1060）这句不成立：换场景要先改 `@aieval/contracts`。

**建议（择一，推荐 ②）**：
① 把 `AgentLogFacts` 拆成 `AgentRunFacts`（通用：`status` 用通用档 / `startedAt` / `endedAt` / `turns` / `tokens` / `error` / `exitReason`）
    + `extras`（业务槽，评测侧放 `score` / `diff`）；
② **照 R 已经对 `EnvGroup` 采用的做法，把 facts 也做成数据驱动的 `FactItem[]`**（`{ id, label, value, tone, hint, missing }`）——
   这样「状态 / 轮次 / 用量 / 耗时 / 改动 / 评分 / 错误 / 结束原因」变成数据层给的一组条目，
   加一格事实不需要改组件、也不需要改契约。注意 R 已为 `EnvGroup` 立过这条先例并配了变异体 (h)，
   却对 facts 用了硬编码结构：**同一份文档里两套口径**（详见 §2.3）。

### 1.2 「通用件」里写死了本仓的业务口径（P1）

**现象**：卡片文案直接写本仓配置，而这两个组件按 D18 是要能换场景复用的：

| 位置 | 文案 | 问题 |
|---|---|---|
| R:717（`outcome: null` 那一格） | 「无人值守的运行里，这一步会一直等到轮次被取消」（dsh 无超时预算） | 写死了 dsh 与「无人值守」这个部署形态 |
| R:722 / R:1219-1221 | 「本仓没有开应答面（`approvalPolicy: 'never'`）——**已知边界，不是缺陷**」 | 把本仓的 `approvalPolicy` 常量写进通用组件的可见文案 |
| R:829 | 「`capability.subagent === 'aggregate'` 那一类」 | 见 §4.5（类别错误） |

**建议**：这类句子外置成数据层给的 `notice` / `outcomeNote`（与 `EnvItem.label`、`RowEvent.text` 同一条先例：
文案由数据层给），组件只负责摆版。否则「通用件」在第二个消费场景里会说出与本仓配置有关的假话。

### 1.3 组件没有插槽：通用消费方无法增删动作（P1）

**现象**：`AgentLogView` 的 props 被钉死为 `AgentLogModel + environment? + onDownload + onRetryEnvironment?`（R:1064），
工具条是硬编码的六项（R:863-870）。通用消费方想加一个「打开厂商原始会话文件」「重新评分」「导出 JSON」都做不到；
`onDownload` 的语义（D8：下载 = `formatEventLog` 原始台账）本身就是**评测行的事件台账**，不是「智能体运行」的通用产物。

**建议**：`actions?: ReactNode` 或 `toolbar?: { leading?: ReactNode; trailing?: ReactNode }` 插槽；
`onDownload` 保留但正名为「导出回调」，默认实现（台账）留在页面层。

---

## 2. 扩展性：三条承诺与实现不符

R:240-255 列了五条扩展性，其中第 1、5 条与实现不一致，第 2、4 条成立（`Loadable` 复用、不建嵌套树）。

### 2.1 承诺 1（加块类型不改模型）与 `ContentBlock` 的形状相反（P0）

**现象**：R:242 写「`ContentBlock` 是判别联合，新增一类块 = 加一个 `kind`；渲染层按 `kind` 分派（`assertNever` 兜底），
**不改 `AgentLogModel` 的形状**」。但 R:341-362 的 `ContentBlock` **不是判别联合**，是：
一个扁平接口（`id` / `kind` / `at` / `messageId` / `subagentId` / `text` / `textMissing` / `callId` / `toolName` / `vendorType` / `tool`）
+ 一堆「只在某个 kind 下有意义」的可空字段。证据是**它自己已经加过一次**：
`tool: ToolFamilyPayload | null`（R:361）就是为两个族新加的专属载荷槽。

**后果**：
- 新增一类带专属数据的块（例如 `image` / `artifact`），要么再加一个可空字段（接口变胖、每个消费点都要非空判断），
  要么复用 `text`（于是 `text` 的语义随 kind 漂移）；
- `text: string` 对**所有** kind 都是同一个字段，而 R 开篇第 1 条骂旧抽屉的正是「四类语义完全不同的东西长得一样」
  （R:19-21）——在**类型层**把这一点重演了；
- 与 V 相反：V 的 `AgentBlock` 是判别联合，`ToolCallBlock` / `ToolResultBlock` / `AttachmentBlock` 各自带自己的字段（V:266-337）。

**建议**：`ContentBlock` 改成 `{ id; at; messageId; subagentId } & (TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | AttachmentBlock)`
的判别联合（消费点用 `switch (block.kind)` + `assertNever`），或至少把所有 kind 专属载荷收进一个 `payload: BlockPayload | null` 判别联合槽。
这同时修掉 §4.4 的「非空 `string` 却允许 missing」。

### 2.2 `capability` 是闭集，且比 V 少 4 格（P0/P1）

**现象**：R:178 只有 `{ thinkingText; subagent }`；V 的 `messageCapability` 是**六格**（V:163-176）：
`thinkingText` / `thinkingTextKind` / `toolInput` / `toolResult` / `streamingDelta` / （usage 侧另有 `thinkingTokens`、`thinkingTokensBasis`，V:183-199）。

**后果（有三条，后两条是功能洞不是美观问题）**：
1. **R 自己的论证依赖缺掉的那一格**：R:455-458 用「『这一家拿不到工具结果』（v2 spec §3 的 `toolResult: 'no'`）」
   论证 `running` 不能由「有没有 `output`」推断，并要求 `running === false && output === null` 时显示成
   「结果未采集（**静态灰字 + 原因**）」。但 `LogNode.capability` 里**没有** `toolResult`，
   `ToolItem` 里也**没有** `outputMissing: MissingReason` 一格（对照 V 给工具调用块配的 `inputMissing`，V:320）
   ——**「原因」没有来源**。UI 只能显示「结果未采集」而说不出是「不支持」「没暴露」还是「本次没采到」，
   这正是 R 最忌讳的「看起来采到了」的近亲。
2. **`thinkingTextKind` 丢掉 = codex 的「推理摘要」被当成完整推理展示**：V:299-309 明文说三家 `text` 是三种不同的东西、
   V:1948 明文允许 UI 渲染 `textKind`（「完整推理 / 推理摘要」**是给人看的信息**），且 V:305-307 指出
   不给这一格，UI 要想标注就只能去读 `normalizedFrom`（= 变相按厂商分支，正是 R 要消灭的）。
   R 的思考块只有「思考」两个字（R:770），于是摘要与全文同形。
3. **闭集本身不可扩展**：加一格能力 = 改 `LogNode`。

**建议**：`capability` 至少补 `toolResult` 与 `thinkingTextKind`（`thinkingTextKind` 应挂在思考块上，
与 V 的 `ThinkingBlock.textKind` 对齐）；长期看它应与 `EnvGroup` 一样由数据层给成条目列表，
而不是在契约里逐个加字段。

### 2.3 「数据驱动」只做了一半（P1）

同一份文档里两种做法并存：

| 对象 | R 的做法 | 加一层/加一格要改什么 |
|---|---|---|
| `EnvGroup.title` / 顺序 / 条目 | **数据驱动**（R:504、R:932-934；变异体 (h) 专守「组名不许硬编码」，R:1175） | 只改数据层 |
| 事实条（facts） | 硬编码 `AgentLogFacts` 八个字段 + 组件逐格摆版 | 改契约 + 组件 |
| 工具条六项 | 硬编码 | 改组件 |
| `EnvGroup.source` | 闭集四值 `'user' \| 'project' \| 'vendor' \| 'observed'`，组件映射成四个中文标签（R:506、R:931-932） | 改契约 + 组件 |
| `capability` | 闭集两格 | 改契约 |

**建议**：把第 1、3、5 项也按 `EnvGroup` 的先例数据驱动（`source` 改成 `{ id: string; label: string }` 或开放字符串 + 可选 label），
让「通用」这件事在**所有**格子上是同一套机制，而不是一处特例。

### 2.4 承诺 5 低估触点；`TaskPanel` 与 V 撞名（P1）

**现象**：R:252 写「收编新工具族 = 加一个 arm」。实际触点是四处：
`ToolFamilyPayload` 加 arm（R:373-375）、`RenderBlock` 加 arm（R:285-292）、
`buildRenderBlocks` 里那两条**点名族名的硬编码比较**（R:276：`tool.family === 'task' | 'ask-user'`）、再加一个新组件。
前三处是预期的，但第四处不必：**「成卡」这件事可以由载荷自己声明**。

**更硬的一条是撞名**：V 已经定义了一个 `TaskPanel`（V:1837-1842）：
`{ items: WorkItem[]; commitModel: 'replace-whole-list'; counts }`，其中
`WorkItem.source: 'tool' | 'event'` 被 V 逐字称为「**本模型的灵魂字段**」（V:1833、V:1845-1851），
且 V:2089-2090 明文「`WorkItem` / `TaskPanel` 都加进 `@aieval/contracts`」。
R 又定义了一个 `TaskPanel`（R:395-411）：`{ steps; counts; change; note; at; result; running }`——**同名、同包、不同形状，且没有 `source`**。

**后果**：B 段落地时两个 `TaskPanel` 不能共存于 `@aieval/contracts`，必须有一方改名或收编；
而丢掉 `source` 的后果 V 已经写明：codex 的原生 `PlanUpdate` / `plan_delta` 走的是**本项目传输层看不到的事件通道**
（V:1850-1855），`source: 'event'` 这一轴消失后，UI 无法分辨「自己在看工具面还是事件面」，
R:1252 那张「哪家能出这一族」的表也只覆盖了工具面。

**建议**：① R 与 V 收敛 `TaskPanel` 的名字与形状（建议保留 V 的 `WorkItem` + `source`，R 的 `change` / `note` 作为增量字段）；
② 「成卡」由载荷声明（例如 arm 上带 `presentation: 'card'`），`buildRenderBlocks` 只按声明分派，不点名族。

### 2.5 `RenderBlock` 的签名与输出不自洽；`kind: 'row'` 节点没有出口（P1）

**现象 A**：`buildRenderBlocks(blocks: readonly ContentBlock[])`（R:283），但输出里有一支
`{ kind: 'subagent-bar'; node: LogNode }`（R:290）。纯函数**拿不到** `LogNode`——
`ContentBlock.kind === 'subagent'` 上只有一个 `subagentId: string | null`（R:347）。
签名与返回值对不上：实现要么改签名（`(blocks, nodesById)`），要么现造一个假 node。

**现象 B**：`kind: 'row'` 的节点要求「在时间轴上占一条带计数与状态的说明行」（R:828-830），
但 `RenderBlock` 没有承担它的 arm，`RenderBlock` 的输入里也没有节点。
且如前所述 `LogNode` 里**没有计数格**（V 的 `aggregate` 档把计数放在 `SubagentEnd.outcome` 这个字符串里，V:470、V:507）——
没有字段可放计数。

**建议**：`buildRenderBlocks` 的输入改为「本轮的块 + 节点索引（`Map<string, LogNode>`）」；
给 `RenderBlock` 补一支 `row-note`（吃 `LogNode`），并给 `LogNode` 补 `outcome` / `statusMissing`（对齐 V:448-450）或显式的计数字段。

### 2.6 没有轮次归属的内容无处安放（P1）

**现象**：V 的 `AgentMessage.turn` **可为 `null`**（V:228），而 R 的 `LogTurn.turn: number` 是非空数字（R:183）、
`ContentBlock` 自己不带 turn（R:341-362）。R 又要求「无法归一的厂商载荷走 `attachment` 块，与文本块**同处时间轴**」（R:629、R:634）。
一条 turn 为 `null` 的 system/信封类 attachment（V 的 `vendorType` 例子就是 `session/title`、`request/header`，V:336）**没有桶可放**。

**建议**：给「无轮次归属」一个显式出口——`LogTurn.turn: number | null`（时间轴顶部/底部一个「未归属」段），
或在契约里明确「turn 为 null 的内容一律不进时间轴」（那就要在 R 里写明它去哪，不能留洞）。

---

## 3. 与 v2 的接缝没对齐（重构目标的另一半）

R 的 §8（R:1038-1053）是一张诚实的修订表，下面这些问题里**只有一部分**被登记了。未登记的那些会让 B 段出现「按哪份文档写」的争执。

### 3.1 【最严重】分组键 `turn` 正是 V 明文禁止用于分组的量（P0）

**现象**：R 的 D1（R:60）写「**模型一次 API 往返 = 一轮**（v2 的 `message.turn`，与 `usage.turns` **同义**）」，
整条时间轴（`LogTurn`，R:182-191）、轮次跳转器（R:848-849）、过滤的「命中 N 轮」（R:852-854）、验收 8「跳轮器能直达任意轮」（R:1196）
全部按 `message.turn` 分组。

**V 的明文相反**（已逐字核对）：
- V:811-814：同一个 `message.turn` 三家是**三个不同的量**——claude/codex 是**合成**的模型往返序号，
  **dsh 是厂商的「用户轮号」**；「按 `turn` 分组或比较时，消费方必须按厂商换算」；
- V:821：**「在定案前，`turn` 字段不得用于跨家比较」**；
- V:1952-1955：**「在 `turn` 语义定案前（§7.0.5 / §11.1 第 22 项），`message.turn` 不得用于跨家比较或分组」**，
  「UI 在统计里显示轮次时，**应当显示 `usage.turns`**」；
- 该开放问题（§11.1 第 22 项）**至今未闭合**（V:2732-2733）。

**后果（不是文档瑕疵，是可见缺陷）**：dsh 一行若有 60 次模型往返，`usage.turns` = 60，
而按 `message.turn` 分组的时间轴只有 **1 轮** —— 进度条写「轮次 60」、时间轴写「轮次 1」，
同一个抽屉里两个「轮次」互相打脸；跳轮器与「第 40 轮发生了什么」在 dsh 上直接失效（而那正是 R §1 第 2 条要解决的问题）。
**这也是通用性问题的根**：整个设计的核心轴（分组）建立在一个「三家语义不同、未经换算」的字段上。

**建议**：分组键改成**数据层算好的「统一轮次号」**（`usage.turns` 口径，或 V 倾向的方案① `turn` 正名为模型往返序号 + 另存 `vendorTurn`），
并把「轮次」这一格明确为「数据层给、已换算、跨家可比」；R 必须显式引用 V:1952-1955 并说明如何满足它，
否则 R 与 V 对同一字段的用法直接冲突。

### 3.2 `thinkingTokens` 被塞进 `tokens`，并丢了可加性标记（P0/P1）

**现象**：R:126-132 在 `tokens` 里加了 `reasoning?: number`，注释写「`reasoning` 单列，绝不并进 `output`」。

**V 的明文相反**（已逐字核对）：
- V:2124-2136：`thinkingTokens` 是 **`UsageEvent` 上与 `tokens` 并列的一格**；
- V:2139-2142：**「为什么不并进 `tokens`」**——「三元组是三家**已经统一过口径**的量……
  塞在一起，『其中一格采不到』就会拖住另一格」；
- V:2130-2131、V:2608-2617：它是 `tokens.output` 的**子集**，**不是第四个加数**；
- V:2191、V:2616-2617：能不能相加由 `usageCapability.thinkingTokensBasis`（`'subset-of-output' | 'additive' | 'unknown'`）决定，
  「只有 `'additive'` 时相加才合法」。

**后果**：① 两份文档对同一格的位置与名字（`reasoning` vs `thinkingTokens`）都不一致；
② R 丢掉了 `basis`，而 UI 恰好要显示这些数字——「哪家更费 token」正是 V 说这一格存在的理由；
③ R:122-123 把这件事引成「v2 spec §11 待办 3」，而 §11 第 3 项是**已决**（V:2608-2617），且结论与 R 的落法相反。

**建议**：把 `reasoning` 从 `tokens` 里提出，与 `tokens` 并列（名字对齐 `thinkingTokens`），
并带上 `basis`；这条要进 R 的 §8 修订表。

### 3.3 `ContentBlock` 不是 V 的形状（P0）

**现象**：R:259-260 把 `ContentBlock` 当成与 `AgentLogModel` 一起进契约的 v2 形状引用，但：

| 项 | V | R |
|---|---|---|
| 名字 | `AgentBlock`（V:266） | `ContentBlock` |
| 判别键 | `type`（V:275-337） | `kind`（R:343） |
| 成员 | text / thinking / tool-call / tool-result / attachment（V:266） | 多一个 **`subagent`**（R:343） |
| 块级原文 | `raw` + `normalizedFrom` + `index`（V:268-272） | **全部没有** |
| 思考块 | `signature` + `textKind`（V:278-309） | 只有 `text` + `textMissing` |
| 工具调用块 | `input: unknown \| null` + `inputText` + `inputMissing`（V:313-321） | 只有 `callId` / `toolName`，参数挪进 `ToolItem.input` |
| 工具结果块 | `status` / `text` / `truncated`（V:324-330） | `text` / `status` / `bytes` / `truncated`（在 `ToolItem.output`） |

其中「多一个 `subagent` 块」与 V 直接冲突：V:111 的块成员表里没有它，V:120-121 更明文写 subagent 是**与 `message` 平级的独立事件**、
「**不是消息的子结构**——子任务的生命周期（开始、结束、失败）无法用『一条消息』表达」。
R 把「子任务可进入」这件事做成一个块（R:343），等于要求数据层**为一件并列事件伪造一个块**；
而 `buildRenderBlocks` 又需要 `LogNode` 才能产出 `subagent-bar`（见 §2.5）——同一条链上有两个洞。
事实层面 R:259-260 说这些类型「随 `AgentLogModel` 一起进 `@aieval/contracts`」，但 V 的 `AgentBlock` 本来就是 v2 的契约类型 ——
两份文档现在对同一个概念有两个名字与两种形状。

**后果**：适配器/selector 要写一层「V 的形状 → R 的形状」的翻译，而这层翻译正是 D16 想避免的「迁就」；
且 `raw` 的丢失与 R 自己的「归一化是视图，原文才是事实」（R:378）口径相抵（R 只给两族卡片保留了 `raw`，R:381-387）。

**建议**：要么直接吃 V 的 `AgentBlock`（`type` 判别、保留 `raw`），把「配对成 `ToolItem`」纯粹放在 `ui` 的纯函数里（R 已经这么放实现，R:257-263）；
要么在 R 里显式登记「这是对 v2 块形状的收窄/改名」，并逐条说明丢掉的字段（`raw` / `textKind` / `input`）去哪了。

### 3.4 `task` 族三条口径不一致（P1）

| 问题 | V | R |
|---|---|---|
| 载荷挂在哪 | **没有规定**（`ToolData` 是独立的一次调用类型；`AgentBlock` 里没有族槽，V:266、V:1337-1348） | **只挂 `tool-call` 块**（R:238、R:361） |
| 谁派生面板 | 「`WorkItem` 由**消费方**从工具面 + 事件面拼出」（V:2092-2093） | **数据层/适配器**给整表归一结果（R:391-393、D22 R:81） |
| `source` 轴 | `WorkItem.source: 'tool' \| 'event'`「灵魂字段」（V:1833） | **没有** |
| `commitModel` | 进 UI 关键字段（V:1967）、进 contracts（V:2089-2090） | **不进 UI 契约**（R:81、R:237） |

**评价**：挂载点与 `commitModel` 两条 R 已在 §8 登记（R:1052① ②），属**已登记的收窄**，可以接受；
但「谁派生」与「丢 `source`」**没有登记**，而这两条恰好是 V 花了整节（V:1845-1855）论证的东西
（codex 的原生计划数据在事件面上、本项目传输层看不到 ⇒ 必须让 UI 知道自己在看哪一面）。

**建议**：R 的 §8 补第 ④ 条：说明 `source` 轴由 `TaskPanel` 的哪个字段承载（或明确「本期只做工具面，事件面走 `attachment`」），
并把「面板派生在数据层」与 V:2092-2093 的差异写明理由。

### 3.5 被静默推翻的 v2 口径：`recommended` 置顶（P2）

V:1968 对 `ask-user` 写「逐问题渲染 `options`（**`recommended` 置顶**、`allowOther` 追加自由输入）」；
R:749 明确相反——「**不做美化截断、也不重排选项**……UI 只加一个『推荐』Tag」，
并在 R:1152（测试）与 R:1216-1217（验收 20）钉死了「顺序不变」。
R 的取舍理由（截断/重排会改事实）是站得住的，但**§8 没有登记这条修订**，于是两份文档对同一族的渲染规则直接冲突。
**建议**：进 §8。

### 3.6 陈旧引用（P2）

| R 处 | R 的说法 | 实际 |
|---|---|---|
| R:693、R:1053、R:1298 | 「v2 spec §11.1 第 27 项：`TaskCreate` 的 `taskId` 来源未定」 | **已闭合**（V:2752-2756：`id` 来自 `TaskCreate` 返回、`blockedBy` 可解析）。R:1053 那句「该缺口闭合后 UI 无需改动」已经可以删掉改成既成事实 |
| R:1252 | 「claude 要开 `CLAUDE_CODE_ENABLE_TODO_TOOLS`——**没开就没有这一族**」 | 该变量**已进 `buildSubprocessEnv` 的注入**（V:2707-2708，有守卫+变异验证），且 `Task*` 自 SDK 0.3.142 起是**默认工具**，此开关已退化为「防版本回退的护栏」（V:2695-2701）。§12 是范围诚实表，读者会据此判断「为什么没有这一族」，措辞要改 |
| R:235 | 「tool-result 可能没有、`callId` 可能为 null、codex 一个 item 要拆两块——**都是 v2 §5.2 的明文**」 | 只有「`callId` 可为 null」（且仅限 `tool-result`）在 §5.2（V:326）；codex 一拆二是 §7.4（V:959）；「tool-result 可以没有」在 §5.2 无出处 |
| R:658-659 | 拿 `todo_list` 当 `attachment` 的 `vendorType` 例子 | V:911 说 codex 的 `todo_list`「**它不是 `attachment`**」（V 自己在开放问题 4 里也不一致，V:2618）。R 选了 V 明文反驳的那一侧且没引 |

### 3.7 一处程度较轻的：`specVersion` 与「不做版本分流」（P2，需澄清而非修改）

R:96、R:246-248 加了 `specVersion: 1`；V 的立场是「**不做 v1 兼容分支，也不加 `messageSpecVersion` 分流**——读侧只有一套代码，契约即真相」（V:2579、D9 V:87）。
两者其实**不是同一个版本轴**（V 说的是线上事件 schema，R 说的是 UI↔数据层模型），
但 R 只写了「给未来留的门」，没写「为什么它不与 V 的『不分流』立场冲突」。
**建议**：补一句区分两个版本轴，否则下一个人会按 V 的立场把它删掉，或按 R 的立场去给事件加版本分流。

---

## 4. 契约自身的第二份真值 / 矛盾（接缝不稳的直接证据）

R 的评估表（R:225-238）已经删掉了 `chain` / `siblings`，理由是「存一份就是第二份真值」——这条纪律很好，
但下面这些同类问题没有按同一条纪律处理：

### 4.1 `activeNodeId`（P1）

R:102 把它写成 `AgentLogModel` 的**非可选输入字段**，注释却是「**UI 内部 state**，默认取 `kind === 'main'` 的那个」；
R:814-816（§6.2）又说「面包屑切换节点：**是组件内部 state**」；R:214 还拿它当「数据层按需取数」的依据。
**一个字段不能既是输入模型的一部分又是 UI 内部 state**：要么删掉（数据层不需要它），
要么保留并承认它是输入（那 UI 就不能自己切节点，R:814 的「不写 URL」另说）。
**建议**：从 `AgentLogModel` 删除，改为组件内部 state；数据层的按需取数改用「页面告知当前节点」的显式入参。

### 4.2 `empty` 与两份 `facts`（P1）

- `AgentLogModel.empty`（R:106）与 `nodes[].content` 可派生关系重复（R 自己的纪律：不存第二份真值）。若保留，必须写明判据（是「没有任何节点」还是「节点内容为空」——R:802 的注释两者都提了）。
- `AgentLogModel.facts`（R:98）与 `LogNode.facts`（R:168，`kind === 'row'` 时非空）是**同一份「行级事实」的两处存放**。
  哪一份是真值？`row` 节点的 `facts` 与顶层 `facts` 何时不同？R 没写。
  **建议**：二者留一，或在注释里写死优先级与差异。

### 4.3 三处 `subagentId` 与两处无消费者的字段（P1）

`LogNode.subagentId`（R:157）、`LogTurn.subagentId`（R:185）、`ContentBlock.subagentId`（R:347）三层同义。
而 R:212（纪律 2）说「子任务内容与主会话内容由数据层**按同一份模型组装完毕**」，
R:345 却说时间轴「只显示当前节点的，**靠它过滤防串台**」——**两者只能有一个是真值**：
内容若已按节点切好，过滤是死代码；若没切好，则每个节点都装着全量块（内存 × 节点数）。
此外 `LogNode.subagentId`（节点把自己的 id 再写一遍）与 `LogNode.vendorId`（R:158）在全文**没有任何消费者**
（面包屑用 `parentId`、时间轴用 `ContentBlock.subagentId`、导航用 `id`）——它们是 `chain`/`siblings` 的同类残留。
**建议**：写清 `content` 的作用域不变量（推荐「已按节点切好，UI 不再过滤」），删掉无消费者字段与三层重复的归属字段。

### 4.4 非空 `string` 却允许 missing（P1）

- `ToolItem.name: string` + `nameMissing: MissingReason | null`（R:308-309）
- `ContentBlock.text: string` + `textMissing: MissingReason | null`（R:347、R:349）

「拿不到」时这两个字段填什么？R:281 的输入假设写「缺字段一律是 `null` + `MissingReason`，**不是空串**」，
但类型是非空 `string` ⇒ 实现只能填空串（或 `''`）——**与 R 自己的假设冲突**。
且 V 对 `ToolCallBlock.name` 的写法正是「空串 + `nameMissing`」（V:316-317），两份文档的空缺口径也不一致。
**建议**：改成 `string | null`（并在 R 里显式说明与 V 的 `name: string` 空串口径如何收敛），或去掉 `nameMissing`。

### 4.5 `capability.subagent === 'aggregate'` 是类别错误（P2）

R:829 写「（`capability.subagent === 'aggregate'` 那一类）」，
但 `CapabilityLevel` 只有 `'yes' | 'no' | 'unverified' | 'off-by-adapter'`（V:134）；
`'aggregate'` 是 V 的 `SubagentStart.source` / `SubagentEnd.source` 取值（V:429、V:452、V:466）。
**这是把「数据从哪来」与「能力档位」压进一格**（V:479-481 专门论证过两者必须分开）。
**建议**：`LogNode` 补 `source`（V 的四值），`kind: 'row'` 的判据改用 `source === 'aggregate'`；
`kind` 只表达「节点在会话树里是什么」。

### 4.6 「原始输出 N 条」在模型里没有数据源（P0，直接影响 A 段验收）

**现象**：
- R:231（评估表）删掉了 `diagnostics`（`log` 原文数组），理由「见 §5.3 的重写：它分叉成两件事，且**都不属于渲染模型**」；
- 但 R:603 的 §5.2 去向表**仍留着一列** `diagnostics`（§5.3），且该表规定 `log` 事件**全部**进这一列（R:611）；
- R:628 要求固定区给「原始输出 N 条 ▾」的 `Collapse`，正文是**逐字原文**（`MonoText`），`data-testid="agent-log-diagnostics"`；
- D14（R:73）明文「原始负载**必须可查**，但不能与消息争夺注意力」；R:636-639 再次强调数据层**不得丢弃** `log` 原文；
- 验收 10（R:1198）要求「『原始输出』能查到全部 `log` 原文（含 `[codex]` 那几行）」；
- 测试计划（R:1147）要求 `agent-log-facts-bar.test.tsx` 断言「原始输出入口在 N=0 时不渲染」；
- 而 `AgentLogModel`（R:94-107）**没有这一格**，`AgentLogView` 的 props（R:1064）**也没有**这一项。

**后果**：A 段无法实现 D14 与验收 10——「原始输出」的 N 与原文无处可取。这不是文档小漏，
而是 R 唯一一处「删了字段却没给替代出口」的地方（其余删除项都在评估表里给了去处）。
**建议**：明确它的归处，二选一：① `AgentLogModel` 加一格（例如 `diagnostics: { lines: readonly string[]; truncatedReason: string | null }`，
按 R:218 纪律 4「上限由数据层算」）；② 作为独立 `Loadable` 与 `environment?` 并列注入（与 §4.3 对环境的处置同形，
理由是体积：`log` 行可达几千条，与「提交要快」冲突）。**推荐 ②**，但必须在 props 与 §5.3 里写出来。

### 4.7 读失败与实时通道故障在新模型里的落点（P2）

既有实现（`apps/web-next/src/log-drawer-state.ts:12-23`）刻意把「读盘失败」「实时通道断了」「还没开始跑」分成三种画面，
文件头写明「**坏比缺更糟**……少一句日志只是缺，说错一句则是把人引到错误的方向」。
R:806-808 保留了「读盘失败整段替换」这一条，但新 props 里**没有** `liveError` / `warning` 的位置
（旧的 `LogView` 也没有，是页面层渲染的）。若页面层继续渲染，要确认它与新的固定区不打架；
另外 `AgentLogModel.empty` 必须由数据层按同一判据算（「拿到 `[]`」≠「还没拉到」），R:106 的注释要把这件事写死。
**建议**：在 §6.1 或 §6.2 补一句「三种空态由页面层区分，`empty` 只在『确实读到了、且为空』时为 true」。

---

## 5. 做对的地方（应保留，不要因为上面的问题一起改掉）

1. **传输层解耦**：五条边界纪律（R:206-223）逐条挡住 `seq` / SSE / `chunk` / 取数回调 / 大小上限判断，
   并给了「为什么」；「不合并事件源」与「UI 不判断大小」两条尤其正确。
2. **删掉会自己变的量与第二份真值**：`durationMs`（用 `useNow` 现算，R:229）、`chain`、`siblings`、`attempts`、
   `TaskListArgs` 空壳、`commitModel`（R:230-237）——方向对，只是没做彻底（§4）。
3. **扁平 `nodes` + `parentId`**（R:232、R:249-251）：不建嵌套树、不为假想需求建树，理由写得好。
4. **`Loadable<T>` 判别联合**（R:200-203）：拒绝 `{data?, isLoading, error}` 三兄弟的理由（允许自相矛盾组合）是对的。
5. **按族而不是按厂商分支**（R:220-223、R:1255-1257）：与 V:1944 一致，是本设计的骨架。
6. **环境模型独立成 `Loadable` 且体积/时机两条理由成立**（R:471-478）；环境抽屉**内部化**（D18、R:897-903、R:942-947）
   顺带消掉了「主抽屉关了、二层还挂着」这个失败面——这是本设计最漂亮的一处结构决定。
7. **折叠键用 `ContentBlock.id` / `callId` 而不是数组下标**（R:794-800），并在 R:339 写清「UI 造不出稳定 id」的理由。
8. **测试与变异体清单**（R:1140-1181）：14 个用例文件 + 13 个变异体 + 6 项真实浏览器冒烟，
   符合本仓「没见过失败的守卫不算守卫」的口径；(e)(f)(i)(j)(k)(l)(m) 都直接打在最有区分力的点上。

---

## 6. 修改清单（按优先级，可直接抄进 R 的 §4 / §8）

**P0（不改就会在 B 段被迫二次改契约，或 A 段验收无法达成）**

1. **轮次分组键**：改成数据层给的「统一轮次号」（`usage.turns` 口径），或按 V 的方案①把 `turn` 正名为模型往返序号；
   显式引用 V:1952-1955 并说明如何满足。**这一条决定整个时间轴在 dsh 上是否可用。**
2. **「原始输出」的归处**：补 `AgentLogModel` 字段或并列的 `Loadable` prop，并在 §5.3 与 props 清单里写出来。
3. **`ContentBlock` 改判别联合**（或补 `payload` 判别槽），并逐条登记与 V 的 `AgentBlock` 的差异（名字、`type`/`kind`、`subagent` 块、`raw`、`textKind`、`input`）。
4. **`facts` 去业务化**：拆通用运行事实 + 业务扩展槽，或整体改成数据驱动的 `FactItem[]`（与 `EnvGroup` 同一机制）。
5. **把 `reasoning` 从 `tokens` 里提出**，与 `tokens` 并列、带 `basis`；进 §8。

**P1（通用性/扩展性承诺的兑现）**

6. `capability` 补 `toolResult`（R:457 的论证需要它）与 `thinkingTextKind`（否则 codex 摘要被当全文）。
7. `TaskPanel` 与 V 收敛：名字、`source` 轴、谁派生；§8 补登记。
8. `buildRenderBlocks` 签名补节点索引；`RenderBlock` 补 `row-note` 一支；`LogNode` 补 `outcome`/`statusMissing` 或计数字段。
9. 删 `AgentLogModel.activeNodeId`（改组件内部 state）；明确 `empty` 与两份 `facts` 的真值归属；
   删 `LogNode.subagentId`/`vendorId` 等无消费者字段；写清 `content` 的作用域不变量。
10. `ToolItem.name` / `ContentBlock.text` 改可空（或与 V 的空串口径显式收敛）。
11. `kind: 'row'` 的判据改用新增的 `source === 'aggregate'`；`LogNode` 补 `source`。
12. `EnvGroup.source` 改数据驱动（`{ id, label }`）；工具条补插槽（`actions?`）；本仓业务口径的文案外置。
13. `LogTurn.turn` 允许 null 或明确「无轮次内容不进时间轴」。

**P2（文档一致性与陈旧引用）**

14. §8 补三条修订：`recommended` 置顶（V:1968）、`thinkingTokens` 位置与 `basis`、`task` 族的 `source`/派生位置。
15. 更新陈旧引用：§11.1 第 27 项已闭合（V:2752-2756）、claude 的 `Task*` 已是默认工具且开关已注入（V:2695-2708）、
    `todo_list` 与 `attachment` 的关系（V:911 与 V:2618 自相矛盾，需要选定一侧并注明）。
16. 澄清 `specVersion` 与 V:2579「不做版本分流」是两个不同的版本轴。

---

## 7. 判定

按 R 自己写下的 D16（按最优形状定模型，不迁就现状）与 D18（`agent-log` 就是那个通用组件）来判：

- **传输层**：达标，且是本仓做得最干净的一次；
- **业务层通用性**：**不达标**——`EvalRowStatus`、评分、git diff、本仓 `approvalPolicy` 文案都在「通用件」里；
- **扩展性**：**承诺与实现不符**——两条主要承诺（加块类型不改模型、收编一族加一个 arm）都需要按 §2 重写，
  第 2/4 条（`Loadable`、不建树）成立；
- **与重构目标的契合**：**核心分组键与 v2 明文冲突**（§3.1），加上「原始输出无归处」（§4.6）与
  `TaskPanel` 撞名（§2.4），B 段落地时必然要动 R 的契约——这正是 D16 想避免的「落地即重构」。

**一句话**：这份设计的**结构**（三区、轮次、族驱动、环境内部化）值得保留，
但**契约**需要按 §6 的 P0 五条返工一次；返工后它才真的能被称为「通用组件」，而不是「为评测行定制的组件」。

---

### 附：本文核对过的关键证据（便于复核）

| 结论 | 证据 |
|---|---|
| `turn` 不得用于分组 | `2026-09-30-agent-message-spec-design.md:811-821`、`:1952-1955`、`:2732-2733` |
| `thinkingTokens` 不进 `tokens`、需 `basis` | 同上 `:2124-2142`、`:2191`、`:2608-2617` |
| V 的块是判别联合、无 `subagent` 块 | 同上 `:266`、`:275-337`、`:111-121` |
| `WorkItem.source` 是「灵魂字段」、`TaskPanel` 进 contracts | 同上 `:1829-1851`、`:2089-2090` |
| `recommended` 置顶 | 同上 `:1968`（对照 `:749`、`:1152`、`:1216-1217`） |
| §11.1 第 27 项已闭合 | 同上 `:2752-2756` |
| claude 的 `Task*` 已默认、开关已注入 | 同上 `:2695-2708` |
| `EvalRowStatus` 十态 | `packages/server/contracts/src/run.ts:37-40` |
| `MissingReason` / `CapabilityLevel` 目前在代码里零命中 | `packages/server/contracts/src/` 全目录 grep 无匹配 |
| 三种空态必须分开的既有口径 | `apps/web-next/src/log-drawer-state.ts:12-23` |
| `ACTIVITY_SWEEP_CLASS` 与 `.aieval-activity-sweep` 的存在与守卫 | `packages/client/ui/src/base/agent-activity-line.tsx:32`、`apps/web-next/app/globals.css:64-95`、`apps/web-next/src/global-styles.test.ts:33` |
