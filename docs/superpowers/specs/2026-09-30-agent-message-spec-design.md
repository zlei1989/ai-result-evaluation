# Agent 消息规范 v2 设计（三家对齐）

> 目标：把 Claude Code / Codex / DSH 三家智能体的输出对齐成**一套可跨家比较的消息模型**，
> 覆盖 **结果 / 思考 / 工具调用 / subagent 详情 / 流式输出** 五个面。
>
> 状态：**设计稿，待评审**。本文件只定契约，不含实现改动。
>
> **⚠️ 2026-10-01 重写稿**：[`2026-10-01-agent-message-spec-design-v2.md`](./2026-10-01-agent-message-spec-design-v2.md)
> ——该文以三家实现方案对照重写，并**载有 7 项定案**（含 `turn` 拆成 `roundTrip`+`vendorTurn`、
> `parentMessageId` 改名 `parentCallId`、能力声明新增第五态 `'not-projected-by-vendor'`、
> codex 子任务改混合组装、两轴统计以 item 类型为键等）。
> **本文与 v2 冲突处，以 v2 为准。**
>
> **验证状态（2026-10-01 更新）**：未验证项已由两轮真机探测逐项核对——
> 第一轮见 [2026-09-30 验证报告](../notes/2026-09-30-agent-message-spec-verification.md)（闭合 14 处、推翻 3 处），
> 第二轮见 [2026-10-01 未验证项收尾报告](../notes/2026-10-01-agent-message-spec-unverified-closure.md)
> （claude 侧 5 项、dsh 侧 6 项、本地判据 3 项，其中 **3 项推翻了本文正文的结论**）。
> 正文里凡被真机改写的段落都带「2026-09-30 / 2026-10-01」标注，**未标注的仍是待验证的推断**。

## 0. 为什么做这件事

### 0.1 问题：四类语义不同的内容被压进同一个 `log` 类型

现状（逐条对着代码核过）：

| 面 | claude-code | codex | dsh |
|---|---|---|---|
| 结果 | `structured_output` 优先，回落 `result` | 只认 `item.type === 'agent_message'` | 最后一条 `assistant/message` 的 `text` 块 |
| 思考 | 有真文本 + `signature` | `reasoning` 条目当普通文本落盘 | **有真文本**（真机实测 259/68/143 字符），整块到达、无增量；修复前适配器未投影 |
| 工具调用 | 原始 JSON + 一句「调用工具 X」 | 无 summary | 原始 JSON + 参数摘要（截断 120 字） |
| 工具结果 | 原始 JSON | 原始 JSON | 摘要「工具返回：…」（分 `isError`） |
| subagent | 侧链标记 `parent_tool_use_id` + result 上的聚合计数 | 厂商有能力，但**当前不可达**（见 §7.5） | `subagent.started/finished` 通知，从未投影 |
| 流式 | 整块到达 | 累积文本（`ItemDelta` 存在，未见） | 原生 `block-start`/`text-chunks`/`block-end` |

**根因**：四类语义完全不同的内容全被压进 `log` 一个类型（`text` + 可选 `summary`）。
于是「结果 / 思考 / 工具调用 / 子任务」的差异既无法在类型上表达，也无法跨家比较——
只能靠各家适配器自觉，而自觉必然漂移。**这是本次要修的问题。**

### 0.2 两个「为什么现在做」的硬约束

这两条是本次调查新查出来的，**它们决定了规范的形状**，不是背景介绍：

**① 流式粒度不可控 ⇒ 必须显式分标**
三家到达粒度不同（claude 整块、codex 累积、dsh 原生块协议）。规范若只规定一种粒度，
必然有两家要"假装"，而假装出来的实时性最误导人。故 D6 用 `chunk: 'delta' | 'snapshot'`
把"增量"与"快照"分开标注，**消费方只认 snapshot 也能正确渲染**。

**② codex 走 SDK 而非 CLI ⇒ 可得数据的上界被 SDK 的封闭联合卡死**
本项目**不直接操作 codex CLI**，而是经 `@openai/codex-sdk`（适配器里唯一的厂商依赖，
见 `packages/server/agents/src/providers/codex/sdk.ts`）。实测结论（详见 §7.0）：

- SDK 把 CLI 的 JSONL **原样透传**（`yield parsed` 无类型过滤），所以「SDK 会不会吞事件」不是问题；
- 但 CLI 只产出 **5 种**事件：`thread.started` / `turn.started` / `item.started` /
  `item.completed` / `turn.completed`，**联合里没有 subagent 变体**；
- ⇒ **子智能体数据永远不可能从 `runStreamed` 拿到**，只能走 hook 或 rollout 会话文件。

> ### ⚠️ 上面这一条已被真机**推翻**（2026-09-30 验证轮，证据见 [验证报告](../notes/2026-09-30-agent-message-spec-verification.md)）
>
> **事件 `type` 封闭 ≠ `item.type` 封闭**——初稿把两者混为一谈，于是得出了一个错误的"永远"。
>
> | 实测（codex 0.154.0，`multi_agent` 真的跑起来时） | 结果 |
> |---|---|
> | 事件 `type` 全集 | `thread.started` · `turn.started` · `item.started` · **`item.updated`** · `item.completed` · `turn.completed`（**6 种**，不是 5 种）**→ 2026-10-01 再修正为 7 种**（另有失败态 `error` / `turn.failed`） |
> | 事件联合本身 | 确实没有 subagent 变体（初稿这一点是对的） |
> | **`item.type` 里的子智能体变体** | ✅ **存在**：`collab_tool_call`，字段 `tool` / `sender_thread_id` / `receiver_thread_ids` / `prompt` / `agents_states` / `status` |
>
> ```jsonc
> {"type":"item.started","item":{"id":"item_3","type":"collab_tool_call","tool":"wait",
>   "sender_thread_id":"01a0f2d8-…","receiver_thread_ids":[],"prompt":null,
>   "agents_states":{},"status":"in_progress"}}
> ```
>
> ⇒ 修正后的口径：**子智能体在事件流上有投影**（`collab_tool_call`），
> **hook 仍是更完整的带外通道**（hook 带 `agent_id` / `agent_type`，`collab_tool_call` 不带）。
> 「必须走 hook」的**设计结论仍成立**（§6 的 `source` 字段照样必需），
> 但立项理由要从"事件流拿不到"改成"**事件流给的身份不如 hook 完整**"。

这一条直接否掉了「等 model preset 修好就能从事件流拿到 subagent」的想象，
也让 §6 的 `source` 字段从"可选的严谨"变成**必需的机制**。

### 0.3 因此规范要解决的三件事

1. **给四类内容各自的类型与字段**（强对齐，缺就是缺）——§5 / §6；
2. **给流式一个可控的粒度模型**（delta / snapshot 分标，不新增事件类型）——§8；
3. **给"拿不到"一个诚实的表达**（能力四态 + `MissingReason` + `source`）——§3 / §4。

## 1. 设计口径（已确认的决策）

| # | 决策 | 取值 |
|---|---|---|
| D1 | 规范落点 | 契约层统一消息模型（`@aieval/contracts`）；events.jsonl 与 SSE 是该模型的视图 |
| D2 | 对齐强度 | **强对齐**：同一套字段，拿不到就写 `null` + 原因码 |
| D3 | 事件类型 | **新增消息类事件**；`log` 降级为「未识别 / 纯文本 / WARN」出口 |
| D4 | subagent 建模 | `subagent-start` / `subagent-end` 事件对 + 统一「子任务」字段 |
| D5 | 消息组织 | **方案 A**：一条事件 = 一条消息（含完整 `blocks[]`），同 `messageId` 随块增加重发 |
| D6 | 流式粒度 | `chunk: 'delta' \| 'snapshot'` 显式分标，两条都规范 |
| D7 | 演化方式 | **破式重构**：联合重定义为「消息事件 + 行级事件」，`log` 不再兼收并蓄 |
| D8 | 可追溯 | `raw` 分 message / block 两层，各自有 owner，互不重复（见 §5.4） |
| D9 | 历史产物 | **不兼容、不加版本分流**——旧 `events.jsonl` / `run.json` **删除**，读侧只留一套代码（见 §10.1） |
| D10 | codex subagent | **必须支持**。通道已定为 **hook**（`SubagentStart`/`SubagentStop`，格式与载荷已实测，见 §7.5.5）；另需网关提供带 multi_agent profile 的模型名（§7.5.3 牌 A） |
| D11 | 内置工具对齐 | **两层**：① 10 个工具族给统一 `args`/`result`，**目标是让 UI 渲染代码只按族分支、不按厂商分支**（§7.6）；② `action`×`target` 两轴供统计比较（§7.6.8）。厂商工具名一字不改（改名会打断 codex 的路由） |
| D12 | 三家开关 | **统一打开**（用户口径 2026-09-30）：claude 注入 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`、codex 注入 `tools.update_plan.enabled=true`、dsh 默认就开。**常开、不做成配置项**——否则「有没有规划」会变成配置差异而非能力差异 |
| D13 | `signature` 处置 | **隐藏**（用户口径 2026-09-30，开放问题 2）：契约**保留**字段（审计用），但**不进任何面向界面/消费方的呈现**（§5.2 的口径 + §7.6.4 的渲染规则 + §7.6.5 的静态守卫）。**不删字段**——删了它，§5.4 的 `raw` 在"归一无损"时省略，这一格会**静默消失** |
| D14 | 思考 token 计量 | **进 `usage` 行级事件**（用户口径 2026-09-30，开放问题 3）：新增与 `tokens` **平级**的 `thinkingTokens`；**只收结算值**；它是 `output` 的**子集、不是第四个加数**；能力声明进新的 `usageCapability`（全部细节见 §7.7） |
| D15 | claude 的 Workflow | **允许触发，但压住规模**（用户口径 2026-09-30，开放问题 7）：显式 `enableWorkflows: true` + **并发硬闸门 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8`** + 总数侧软约束与告警阈值；**作用域是 Workflow 派生的 agent**（见 §7.8） |
| D16 | `web-search` 族 | **三家统一禁用**（用户口径 2026-09-30，开放问题 26）：claude 的 `WebSearch` 改为**无条件禁用**（推翻 2026-09-29 的按模型名分档）、codex 保持 `tools.web_search: false`、dsh 关掉 `tool-web.search`；⇒ **该族在本仓恒空**。理由：只有 claude / gpt 系模型支持它，属**模型差异**（见 §7.9） |

**贯穿三条原则**：
1. **缺就是缺**——拿不到的格写 `null` + `MissingReason`，绝不写 0 或空串；
2. **原始载荷有唯一归宿**——`raw` / `attachment` 块，不再混进文本；
3. **流式只有一种形状**——`chunk` 标记区分增量与快照，不新增事件类型。

## 2. 分层模型

联合重定义为**两大类、三种消息类事件**（`type` 是判别字段）：

```
AgentEvent v2
├── 行级事件（编排层发，与 v1 同义，仅规整）
│   status / usage（含思考 token，§7.7） / diff-summary / score / error / end
└── 消息类事件（适配器发，新增）
    ├── message          智能体说的一条消息（信封 + blocks[]）
    │     └── Block      内容块：text / thinking / tool-call / tool-result / attachment
    ├── subagent-start   子任务开始
    └── subagent-end     子任务结束
```

`message` / `subagent-start` / `subagent-end` **与行级事件并列**在同一个 seq 序列里，不嵌套：
`status` / `score` 是**关于这一行**的事实，不是智能体说的话。今天的 `log` 之所以变成万能垃圾桶，
根因就是这两类被混在一个类型里。

`subagent-start/end` 是与 `message` **平级的独立事件**，不是消息的子结构——子任务的生命周期
（开始、结束、失败）无法用「一条消息」表达，且它要能与 `message.subagentId` 交叉引用。

### 2.1 命名规则

1. **事件 `type` 一律 kebab-case 单词，不复用厂商点号**——`turn/end`、`subagent.started`
   只出现在**映射表**里，不进入契约（沿用 contracts 既有口径：契约不得随厂商版本漂移）；
2. **代理自产 id 一律 `<domain>Id`**——`messageId` / `callId` / `subagentId`；厂商原始 id 另存 `vendorId`；
3. **能力档位用四态**（见 §3）。

## 3. 能力声明

```ts
/** 四态：'no' = 厂商无此概念；'unverified' = 有通道但无真机样本；'off-by-adapter' = 本适配器关闭 */
export type CapabilityLevel = 'yes' | 'no' | 'unverified' | 'off-by-adapter';
```

**为什么必须四态**（全部有实测依据）：

| 事实 | 应声明 |
|---|---|
| codex 有完整子智能体工具面、`multi_agent` 默认开，但**本仓 config 显式关掉了它**（`features.multi_agent: false`），且子智能体数据不在事件流上 | `'off-by-adapter'`——**注意这不完整**：不只是"关掉了"，而是**连通道都没接**（`SubagentStart/Stop` hook 未配置，`providers/codex/` 里 `hook` 零命中）。见 §6 的现状表与 §7.5.2 的措辞更正 |
| dsh 的 SDK **会推** `subagent.started/finished`，但从未被触发过 | `'unverified'` |
| claude-code 有 `parent_tool_use_id` 侧链 + result 上的 `subagent_stats` 聚合 | `'yes'`（身份字段仍缺） |
| ~~dsh 的 thinking 文本实测恒为空串~~ **已被真机推翻（2026-09-30）**：dsh 有完整推理文本，只是修复前适配器未投影 | `thinkingText: 'yes'`（投影已补） |

用布尔会把「厂商没有」「有但没验证」「我们自己关了」压成同一个值，
于是「本来没有」与「我们不知道」在界面上长得一样——这正是本仓最忌讳的「看起来采到了」的反面。

```ts
export interface AgentProviderMetadata {
  // …既有字段不变…
  /**
   * 消息规范 v2 的逐项能力；缺格一律 'no'（安全侧）。
   *
   * ⚠️ **守卫尚未存在**（2026-09-30 独立审查指出）：初稿写「由 `registry.test.ts` 守卫每家
   * 显式声明」，但该守卫**目前不存在**——`registry.test.ts` 守的是既有的 `capability` 四格
   * 与 `reasoningEfforts`。且 `messageCapability` / `AgentMessage` / `ToolData`
   * 在代码里**零命中**（v2 消息模型整体尚未实现）。
   * ⇒ 措辞改成**待实现**：实现本契约时**必须同时补上**这条守卫（见 §11.1 第 28 项；
   * 2026-09-30 追加：该守卫**同时覆盖下面的 `usageCapability`**，理由是那边的 `basis` 一旦
   * 「没声明就走默认值」，跨家比较会**静默**用上错误的可加性）。
   */
  messageCapability: {
    thinkingText: CapabilityLevel;   // 思考能否带文本（三家都是 'yes'，见 2026-09-30 真机更正）
    /**
     * 思考文本的**完备性**（2026-09-30 补，独立审查指出契约层原先无法表达）。
     * 与 `thinkingText` **不是同一格**：那格说"有没有文本"，这格说"文本完不完整"。
     * `'full'` = 完整推理（claude）；`'summary'` = 只有推理摘要
     * （codex，SDK 类型面逐字 "Agent's reasoning summary"）；`'none'` = 拿不到文本（dsh）。
     */
    thinkingTextKind: 'full' | 'summary' | 'none';
    toolInput: CapabilityLevel;      // 工具参数能否拿到结构化对象
    toolResult: CapabilityLevel;     // 工具结果能否拿到
    subagent: CapabilityLevel;       // 是否发 subagent-start/end
    streamingDelta: CapabilityLevel; // 是否会出现 chunk:'delta'
  };
  /**
   * **计量能力**（`usage` 行级事件，2026-09-30 新增，见 §7.7）。
   *
   * 为什么不并进 `messageCapability`：`usage` 是**行级事件**、不是消息（§2），两者不是一类东西；
   * 并进去会让「消息模型的能力」与「编排层计量的能力」混成一格。
   */
  usageCapability: {
    /**
     * 能否拿到思考 token 的**结算值**。**2026-10-01 真机定案后三家不再一律**：
     * claude `'yes'`（19/19 样本、恒 ≤ output）、codex **`'yes'`**（9/9 非 0、恒 ≤ output，
     * ⚠️ **样本全部来自 DeepSeek 路由**；内网网关路径上 codex 跑不完 turn ⇒ 那一路上无样本，
     * 所以这条升级要带路由前提）、
     * dsh **`'off-by-adapter'`**（`dsh-llm-pi-ai` 的 `mapUsage()` 从不写这一格 ⇒ 再跑也没有）。
     * ⚠️ **`'unverified'` 描述的是证据等级，不是开关**：适配器照采照发，
     * 消费方据此知道它还没被核对过（这正是四态存在的理由）。
     * 三家取值与依据见 §7.7.2 / §7.7.4。
     */
    thinkingTokens: CapabilityLevel;
    /**
     * `thinkingTokens` 与 `tokens.output` 的**可加性**——决定它能不能被加、能不能跨家比较。
     * claude 与 codex **都有真机支撑**（两个都 9/9 或 19/19 恒 ≤ output）⇒ `'subset-of-output'`；
     * dsh 是 `'unknown'`（本路由根本不暴露该值）。
     * **相加只在 `'additive'` 时合法**：`'subset-of-output'` 相加就是**双计**（§7.7.0），
     * `'unknown'` 既不得相加、也不得跨家比较（与 §7.0.5 对 `turn` 的同款限制）。
     */
    thinkingTokensBasis: 'subset-of-output' | 'additive' | 'unknown';
  };
}
```

## 4. 缺失表达

```ts
/** 软缺：拿不到但本次运行正常 */
export type MissingReason =
  | 'not-supported'   // 厂商无此概念（codex 的 subagent 通道）
  | 'not-exposed'     // 厂商有但没暴露给我们（例：codex 的 `subagent-end.status`）
  | 'not-observed'    // 本次运行没出现（用户没派生子智能体）—— 这是事实，不是局限
  | 'unverified';     // 有通道但无真机样本，不敢说采到了
```

**`not-observed` 与另外三个必须分得开**：前者是「这次没有」，后者是「我们拿不到」。
今天的 `tokens: null` 把两者混在一起，所以「这家很省」与「这家没采集」在界面上长得一样。

## 5. 消息信封与内容块（D5 / D6 / D8）

### 5.1 信封

```ts
export interface AgentMessage {
  type: 'message';
  messageId: string;          // 代理自产稳定 id；同 id 重发 = 同一消息的块在增加
  vendorId: string | null;    // 厂商原始 id（claude 的 message.id / dsh 的 message.id）
  role: 'assistant' | 'user' | 'system' | 'tool';
  source: 'model' | 'subagent' | 'system';   // 归属：侧链消息必须标 'subagent'
  turn: number | null;        // 一次模型 API 往返的序号
  step: number | null;        // 一轮内的第几次调用（dsh 有，其余 null）
  parentMessageId: string | null;  // 侧链/子任务消息回指父消息
  subagentId: string | null;       // 归属的子任务（§6）
  chunk: 'delta' | 'snapshot';     // 本条是增量还是完整快照
  blocks: AgentBlock[];
  raw: string | null;              // 信封级未映射字段（§5.4），无则 null
}
```

**同 `messageId` 重发的合并语义**：消费方按 `messageId` **覆盖**合并（后到的 `blocks[]` 是
该消息**到目前为止**的完整块列表）。这不是新发明的约定——`row-live.ts` 的 `usage` 事件
本来就是覆盖语义。且它与三家厂商的真实投递同形：

- claude：同一条 `message.id` 分两次投递，一次只带 `thinking` 块、一次只带 `text` 块（实测）；
- dsh：`assistant/message` 自带完整 `content[]`；
- codex：`item.*` 三种事件共享同一个 `item.id`，文本累积。

> **更正记录（2026-09-30，经独立审查指出后逐行核对代码）**：
> 本节初稿写过「现有 `assistantDrafts` 只取 `content` 数组首块，同 id 的后一次会盖掉前一次的内容，
> 是一个现存真 bug」——**这条断言是错的**。代码事实（`providers/claude-code/events.ts:166-184`）：
>
> - `const texts = blocks.map(textOfBlock).filter(…)` 取的是**全部**文本块，随后 **`texts.join('\n')`**
>   一起落成**一条**日志——**不是"只取首块"**；
> - 全仓**没有**任何按 `message.id` 覆盖写**内容**的路径。去重键是 **`uuid`**（同文件 `:37-42`）；
>   按 `message.id` 写的只有**用量表** `usageByMessageId`（刻意设计，只服务跑动期估算）。
>
> 真实的轻微缺陷是：**同一 `message.id` 的多次投递会各落一条日志**（内容不丢，只是重复）——
> 属**冗余**而非**丢失**，且已被 `uuid` 去重挡掉大半。**初稿只看了 dump 里两条同 id 消息就下了结论，
> 没有读实现**——这正是本规范反复强调的"不许推断"，初稿自己犯了。
>
> **对新规范的影响**：覆盖合并语义**仍然成立且必要**（否则 `chunk: 'delta'` 与 `snapshot` 无从区分），
> 但它的立项理由是「**同一消息分多次到达时，消费方需要一份自洽的当前状态**」，
> **不是**"修一个现存的数据丢失 bug"。§9.2 的变异验证 #1 据此改写（见 §9.2）。

### 5.2 块判别联合

```ts
export type AgentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | AttachmentBlock;

interface BlockBase {
  index: number;                     // 消息内顺序（厂商给 block index 就用它）
  normalizedFrom: string | null;     // 审计线索：产出本块的原始事件名
  raw: string | null;                // 归一无损时为 null；无法归一或 attachment 时必有
}

/** 结果：给人的文本 */
interface TextBlock extends BlockBase { type: 'text'; text: string; }

/** 思考：文本可空。**三家都有文本**（2026-09-30 真机更正：dsh 并非恒空），可空只是为形状异常留口 */
interface ThinkingBlock extends BlockBase {
  type: 'thinking';
  text: string | null;
  /**
   * claude/dsh 的 replay 校验串。
   *
   * **隐藏口径（2026-09-30 定案，D13 / 开放问题 2）**：
   * **它是厂商内部的 replay 校验串，对评测者无意义 ⇒ 不进任何面向界面 / 面向消费方的呈现。**
   * 落法有三条，缺一条就等于没隐藏：
   *   · **渲染**：UI 只画 `text`，不得画它（§7.6.4 的第二条规则）；
   *   · **文案**：活动行摘要、抽屉正文、卡片指标**一律不得出现它**；
   *   · **守卫**：静态断言 UI 模块里不出现 `signature`（§7.6.5），并用变异体确认守卫会红（§9.2 #5）。
   *
   * **但字段本身保留在契约里，不删**。理由是删了会**静默丢证据**：§5.4 规定 `block.raw`
   * 在「归一无损」时**省略**，所以一旦不投影成字段，这一格在落盘里就再无处可寻
   * （成本是一个字符串，代价是审计断链）。
   * ⇒ 一句话：**数据留着、呈现藏起来**——这是两件事，不要混成一件。
   */
  signature: string | null;
  textMissing: MissingReason | null; // text 为 null 时必填
  /**
   * `text` 的**完备性**（2026-09-30 补）。三家的 `text` 是**三种不同的东西**：
   *   · claude 的 `.thinking` 是**完整推理文本**（实测："The user wants me to answer with a
   *     single character: 好. No tools, no files."）；
   *   · codex 的 `ReasoningItem` 在 SDK 类型面逐字是 **"Agent's reasoning summary"** ——
   *     **摘要**，不是完整思维链。⚠️ **2026-10-01 真机补一刀**：本机所有后端上
   *     `item.type === 'reasoning'` **一条都不出现**（37 条 item 里 0 条），而 wire 层**有** reasoning
   *     （`reasoning_text` 全文 + **空的 `summary`**）⇒ **是 codex 不投影**。
   *     故 codex 的 `textKind` **在本机实得是 `'none'`**；`'summary'` 描述的是**厂商语义上界**，
   *     不是"我们会拿到摘要"。实现时若按 `'summary'` 写死，UI 会显示一个永远为空的"推理摘要"；
   *   · dsh 是**完整推理原文**（真机实测 259/68/143 字符，整块到达、无增量）——与 claude 同为 `'full'`。
   * 契约里若不区分，codex 的"摘要"与 claude 的"全文"会是**同一状态**，
   * UI 要标注"这是摘要"就只能去读 `normalizedFrom`（厂商事件名）——那是**变相按厂商分支**。
   * ⇒ 显式一档，让 UI 与统计都能分辨。
   */
  textKind: 'full' | 'summary' | 'none';
}

/** 工具调用 */
interface ToolCallBlock extends BlockBase {
  type: 'tool-call';
  callId: string;                    // 关联 tool-result 的键
  name: string;                      // 工具名（拿不到就空串 + nameMissing）
  nameMissing: MissingReason | null;
  input: unknown | null;             // 结构化参数
  inputText: string | null;          // 原始参数文本（dsh 的 arguments 是 JSON **字符串**）
  inputMissing: MissingReason | null;
}

/** 工具结果 */
interface ToolResultBlock extends BlockBase {
  type: 'tool-result';
  callId: string | null;             // 拿不到关联键时为 null（不编）
  status: 'ok' | 'error' | 'unknown';
  text: string;
  truncated: boolean;
}

/** 兜底：拿不到语义时保留原始载荷（替代今天的 unknownEventDraft） */
interface AttachmentBlock extends BlockBase {
  type: 'attachment';
  reason: 'unrecognized' | 'unmapped-shape';
  vendorType: string | null;         // 如 'session/title'、'request/header'
}
```

### 5.3 为什么 `attachment` 而不是继续用文本

今天的兜底是把原始 JSON 塞进 `log.text`，于是「模型说的话」与「我们不认识的信封」在
抽屉里长得一样。`attachment` 让两者在**类型上**就分得开，且它自带 `raw`。

### 5.4 `raw` 的两层归属（D8）

**问题**：规范化的代价是丢掉厂商特有字段；不做追溯就再也查不到「当时原文是什么」。

**结论：要 raw，但按 owner 分层，互相不重复。**

| 落点 | owner | 内容 | 出现时机 |
|---|---|---|---|
| `message.raw` | 信封级未映射字段 | `sessionId` / `stop_reason` / `permission_denials` / `thread_id` / `surfaceOp` | 原文里存在**块之外**的实质字段时 |
| `block.raw` | 该块的原始载荷 | 产出这个块的那份原始片段 | 归一无损时**省略**（默认）；无法归一或 `attachment` 时**必有** |
| `block.normalizedFrom` | 最小审计线索 | `'item.completed'` / `'assistant/message'` | 恒有 |

**为什么 message 级不存整段原始通知**（三个具体代价）：

1. **同一内容存两遍**——dsh 的 `assistant/message` 里 `data.message.content[]` 就是 `blocks[]`
   的来源，`data.stream[]` 又是这些块的来源。实测该 `stream` 数组 8914 字符 / 文件共 237279 字符；
2. **与破式重构叠加会放大**——既然一次理清，就不该同时让日志体积翻倍；
3. **没有 owner 的 raw 必然漂移**——三家对「存多少」各写一套，正是要消灭的毛病。

**形态**：一律**已序列化字符串**（沿用 `emit.ts` 的 `safeStringify` 口径），不是对象——
避免二次编码（`'"{\"a\":1}"'` 下游 parse 出字符串而非对象），且天然免疫循环引用与 BigInt。

**审计路径**（回答「要不要存 raw」的实用判据）：任何规范化决策都能追到原文——
- 不认识的形状 → `attachment` 块自带 `raw`，原文一字不少；
- 认识但被忽略的信封字段 → `message.raw`；
- 某个块从哪来 → `block.normalizedFrom`。

## 6. 子任务模型（D4）

> ## ⚠️ 实现现状：**两家已投影，codex 仍空**（2026-09-30 更新）
>
> | 家 | 数据源 | `subagent-start/end` 投影 |
> |---|---|---|
> | **claude** | SDK 原生 `system/task_started` · `task_notification`（§6.4）——**默认就发** | ✅ **已实现**（`claude-code/events.ts` 的 `subagentDraft`，5 条守卫 + 变异验证） |
> | **dsh** | 顶层通知 `subagent.started` · `subagent.finished` + `subagent/catalog`（§6.5） | ✅ **已实现**（`dsh/events.ts` 的 `subagentDraft`，6 条守卫 + 变异验证） |
> | **codex** | 只能走 hook（§7.5.4）——而 hook **未配置**、`multi_agent=false` ⇒ **永不触发** | ❌ **没有**（且前提未满足） |
>
> **落在 v1 上的形状**：v1 的 `AgentEvent` 是 7 型封闭联合，**没有** subagent 事件类型
> ⇒ 两家都落成**一条可解析的日志**（载荷 JSON，`kind: 'subagent'` + `phase`）。
> 消费方按 `kind === 'subagent'` 过滤即可重建面板。**本节以下的 `SubagentStart`/`SubagentEnd`
> 是 v2 契约**（尚未实现），字段口径由这两家 v1 载荷的**并集**定义。
>
> **两家的 v1 载荷已对齐的字段**：`kind` · `phase` · `source` · `subagentId` · `vendorId` ·
> `name` · `subagentKind` · `parentToolUseId` · `status` · `outcome`。
> **未对齐的三格**（都要在实现里显式表达，不能拉平）：
> · `parentToolUseId`——**claude 有**（真机三者同值，可精确归属），**dsh 恒 `null`**（通知里没有）；
> · `statusMissing`——**claude 不用**（有真实终态），**dsh 只在未定案的取值上用**
> （2026-10-01 收紧：`stopReason` 值域 5 档里 **3 档已有实测映射**——`completed`/`aborted`/**`max-tokens`**，
> 只剩 `error`/`refusal` 未观测；而 `max-tokens` **已定案为 `'failed'`**，故那一格不再需要它），**codex 预计一直用**；
> · `usage`——**claude 有**（`task_notification.usage`），**dsh 没有**（通知里不带）。

> ## ⚠️ 本节曾写的「三家适配器一个事件都没发」已过时
>
> 那是 2026-09-30 早些时候逐行核对代码的结论，**当天就被推翻了**：
> claude 与 dsh 的**数据一直都在各自的流里**（§6.4 / §6.5），只是两边的 `events.ts` 都没读
> （claude 把 `system` 一律落 `unknownEventDraft`；dsh 只认 `session.event` 一种外形）。
> **"没有实现"与"没有数据"是两件事**——这次差一点又按前者写进结论。

> ## 先前记录的核对结果（保留作为历史）
>
> | 家 | `providers/` 里曾经真实存在的 | 当时发 `subagent-start/end` 了吗 |
> |---|---|---|
> | claude | 只有 `parent_tool_use_id`（`claude-code/events.ts:33`），**且只用于排除**——轮次计数与用量估算都把它剔掉（`:63`、`:243`） | ❌ 没有（数据在，没人读） |
> | codex | `hook` / `Subagent` / `spawn_agent` 在适配器里 **0 处命中** | ❌ 没有 |
> | dsh | `subagent.started/finished` **只出现在 `dsh/sdk.ts:14` 的注释里** | ❌ 没有（数据在，没人读） |
>
> ⇒ 当时的判断是**"三家归一是零观察面"**——**这句话现在已经不成立**：
> claude 与 dsh 当天就补上了投影（本节顶部的现状表），只剩 codex 一家空。
> 保留下面的原始记录是为了记住那条教训：**"适配器没实现"被误读成了"没有数据"**。
>
> **本节的定位因此要读准**：它是**待实现的目标**，不是对现状的描述。
> 三家要各自新写投影才能兑现，工作量见 §11 的开放问题 20。
>
> **同时修掉的一条措辞错误**：§3 的能力位表曾把 codex 记成 `'off-by-adapter'`——
> 那是**不完整的**：codex 侧不只是"被适配器关了"，而是**连通道都没接**（hook 未配置）。
> 见 §3 的更正与 §7.5.2 的措辞更正。

```ts
/** subagent-start */
export interface SubagentStart {
  type: 'subagent-start';
  subagentId: string;                // 代理自产稳定 id
  vendorId: string | null;           // dsh 的 agentId / codex 的 agent_id
  parentSubagentId: string | null;   // 嵌套子任务（codex 有 max_depth）
  name: string | null;               // 任务名（dsh 的 name / codex 的 task_name）
  kind: string | null;               // codex 的 subagent_kind
  source: 'wire' | 'hook' | 'session-file' | 'aggregate';  // 数据来源（见下）
  raw: string | null;
}

/** subagent-end */
export interface SubagentEnd {
  type: 'subagent-end';
  subagentId: string;
  /**
   * 子任务的终态。**可空**（2026-09-30 更正：初稿写成必填，是错的）。
   *
   * 为什么必须可空：**codex 选定的通道拿不到状态**。`SubagentStop` hook 的输入 schema
   * （§7.5.5 ⑤）在 `SubagentStart` 的全部字段之外**只多两个**——`agent_transcript_path`
   * 与 `last_assistant_message`——**没有任何状态字段**。claude 的 `'aggregate'` 档同样只有计数、
   * 没有逐个终态。若坚持必填，适配器就只能恒填 `'unknown'` 或**假定 `'completed'`**，
   * 后者是编数据（与 §4「缺就是缺」直接冲突）。
   *
   * ⇒ 取不到时写 `null` + `statusMissing`（下），而不是猜一个值。
   */
  status: 'completed' | 'failed' | 'canceled' | null;
  /** `status` 为 null 时必填：为什么拿不到（与 §4 的 `MissingReason` 同一套取值） */
  statusMissing: MissingReason | null;
  outcome: string | null;            // 结果摘要（拿不到就 null）
  source: SubagentStart['source'];
  raw: string | null;
}
```

### 6.1 `source` 字段：为什么必须有

三家的子任务数据来自**完全不同的通道**，可信度也不同：

| source | 含义 | 谁 |
|---|---|---|
| `'wire'` | 厂商事件流直接给出 | dsh 的 `subagent.started/finished` |
| `'hook'` | 从 CLI 钩子事件取 | codex 的 `SubagentStart`/`SubagentStop` |
| `'session-file'` | 从厂商会话文件取 | codex 的 rollout `subagent_history` |
| `'aggregate'` | 只有汇总计数，无逐个身份 | claude 的 `subagent_stats` |

**审计时看得出每条数据的来源**，这是「混合组装」的正确形态：能拿 wire 就拿 wire，
拿不到允许降级，但**降级必须可见**。claude 的 `subagent_stats` 落成一对
`source: 'aggregate'` 的事件（`name` 为 null，`outcome` 带计数）。

### 6.2 字段必填性（对齐"强对齐"口径）

**必填的只有 `subagentId` 一个**（2026-09-30 更正：初稿把 `status` 也写成必填，是错的——
理由见 `SubagentEnd.status` 的 JSDoc：codex 的通道根本没有状态字段，claude 的聚合档也没有）。

`name` / `vendorId` / `parentSubagentId` / `kind` / `outcome` / **`status`** 可为 `null`。
claude 只有聚合时，`name` 与 `parentSubagentId` 为 `null` 且
`source: 'aggregate'` 已说明原因；**但 `status` 的缺失要另给 `statusMissing`**——
`source` 说明的是"数据从哪来"，不说明"这一格为什么空"（一个 `'aggregate'` 来源
既可能给得出计数、也可能给不出终态）。

**关于 `subagentId` 必填（2026-09-30 真机更正）**：claude 侧**有厂商原生 id**——
`task_started.task_id`（真机 `ac9fca27ed014a4ea`），**不需要合成**。
先前"claude 只能合成 id"的说法基于"只有 `agent_id`+`agent_type` 的 hook 输入"这一**不完整的通道认知**，
真机证明原生 `system/task_*` 消息给出了完整身份（§6.4）。
⇒ §11.1 第 21 项（合成 id 的张力）**对 claude 不成立，可关闭**；`vendorId` 填同一个 `task_id`。

**codex 的 `name` 为什么必须允许 null**（实测依据，见 §7.5.5 ⑨）：`SubagentStart` 的输入
schema 里**没有任何任务名/描述字段**，只有 `agent_id` 与 `agent_type`。故 `name` 的取值顺序是：

1. 从**父消息的 `spawn_agent` 工具调用**关联（`tool-call.input` 含任务描述），
   按 `subagentId` ↔ `callId` 交叉引用——**这是首选**，也是唯一能给出"它被派去干什么"的来源；
2. 关联不上时退回 `agent_type`（角色名）；
3. 两者都没有 ⇒ `null`。

### 6.3 `source` 与「哪些格填得出来」的对照

**必须同时看这两列**：`outcome` 与 `status` 的可得性**不同**——初稿只对照了 `outcome`，
于是 `status` 被误写成必填（见 `SubagentEnd.status` 的 JSDoc）。

| source | `outcome` 来源 | `status` 来源 | 实测状态 |
|---|---|---|---|
| **`'wire'`（claude，2026-09-30 新增）** | `task_notification.summary` | ✅ **`task_notification.status`** ∈ `completed`/`failed`/`stopped` | ✅ **真机已抓**（§6.4.1），默认就发 |
| `'hook'`（codex） | `SubagentStop` 的 `last_assistant_message` | ✅ **真机确证：载荷里没有任何状态字段**（12 字段逐字见 §6.4 开头）⇒ `null` + `statusMissing: 'not-exposed'` | ✅ **载荷已有真机样本（2026-10-01）**：`SubagentStart`/`SubagentStop` 在 0.154.0 与 0.156.1 上各触发 1 次；⚠️ 但 §7.5.5 ⑤ 的字段表**少列了 `stop_hook_active`**（真机比 `SubagentStart` 多**三**个字段，不是两个） |
| `'wire'`（dsh） | `subagent.finished.lastAssistantMessage` 的 `text` 块 | ⚠️ 要**同时**读 `status` 与 `stopReason`（见下）：`ok`+`completed` ⇒ `'completed'`；`error`+`aborted` ⇒ `'canceled'`；**`ok`+`max-tokens` ⇒ `'failed'`（2026-10-01 定案）** | ✅ **三条真机已抓**（§6.5.1 + §6.5.2）：成功 / 取消 / **截断**；只剩 `stopReason` 的 `error`、`refusal` 两档未观测 |
| `'aggregate'`（claude） | ❌ 无逐个 outcome，**只有计数** | ❌ 无逐个终态，只有 `completed`/`failed` 计数 | `subagent_stats` 已实测（**未收编进 SDK 类型面**，§6.4.5） |

**⚠️ claude 同时具备 `'wire'` 与 `'aggregate'` 两档**——前者是主源（逐个身份），
后者是交叉校验（`result.subagent_stats` 的总数）。**两家都用 `'wire'` 这个名字但通道不同**
（claude 是 SDK 原生消息、dsh 是厂商通知流），实现时以 `agentKind` 分支即可，
**但消费方只看 `source: 'wire'` 这一档，不需要知道是哪个 wire**——这正是 `source` 字段的用途。

### 6.4 claude 侧的数据源：**SDK 原生的 `system/task_*` 消息**（2026-09-30 真机定型）

> **本节推翻了两条我先前写下的判断**，都是没查类型面就下结论：
> ① 曾写「claude 只有聚合、没有逐个身份」——**错**，逐个身份一直都在；
> ② 曾倾向照搬 codex 的 **hook** 方案——**不必要**，claude 有更好的原生通道。

> ### ✅ 证据等级已升级（2026-10-01 真机）：**schema 级 → 真机级**
>
> 本轮在 DeepSeek 路由上让 `spawn_agent` 真的跑起来后，配好 hook 抓到了 **`SubagentStop` 的真实载荷**：
>
> ```jsonc
> { "session_id":"01a0f3d2-c3f9-…", "turn_id":"01a0f3d3-18e7-…",
>   "transcript_path":"…-<父会话>.jsonl",
>   "agent_transcript_path":"…-<子会话>.jsonl",       // ← ⑤ 列了
>   "cwd":"…", "hook_event_name":"SubagentStop", "model":"deepseek-chat",
>   "permission_mode":"bypassPermissions",
>   "stop_hook_active":false,                        // ← **⑤ 没列这一格**
>   "agent_id":"01a0f3d3-0dd9-…", "agent_type":"default",
>   "last_assistant_message":"2" }                   // ← ⑤ 列了（另一版："2 — adding one and one gives a total of two."）
> ```
>
> **两条修正**：
> 1. **确证没有任何 `status` 字段** ⇒ 下面那条"`statusMissing: 'not-exposed'` 降级为预期行为"，
>    现在可以**升级为真机结论**（不再是"不得据此断定"）；
> 2. ⚠️ **§7.5.5 ⑤ 写「在 `SubagentStart` 全部字段之外多两个」是错的——真机多三个**：
>    除 `agent_transcript_path` 与 `last_assistant_message` 外还有 **`stop_hook_active`**。
>    它是**只在运行时载荷里出现**的字段（schema 的 `properties` 里没有）
>    ⇒ 又一条「**schema 级不足以定论**」的实证，与本节的开篇论点自洽。
>
> 顺带一个新通道：**子智能体自己的 `UserPromptSubmit` 载荷带 `agent_id` / `agent_type` 与它收到的 prompt 原文**
> （`agent_id` 与 `SubagentStart.agent_id` 同值）⇒ §7.5.5 ⑨「`name` 只能从父消息的 `spawn_agent` 关联」
> **之外多了一条通道**（hook 侧直接拿到 prompt 原文）。

> ### ⚠️ 证据等级的分野（2026-09-30，用户追问后补写）
>
> **本仓对 codex 的 `SubagentStop` 结论只有 schema 级证据，没有实测**——而我在 §6.3 曾把它
> 写成了确定的「❌ 无来源」。这是**把 schema 级当成了实测级**。
>
> | 结论 | 证据等级 | 强度 |
> |---|---|---|
> | claude 的 `status` 有真实来源 | ✅ **真机载荷**（§6.4.1 ②） | 强 |
> | codex 的 `status` **拿不到** | ✅ **真机载荷**（2026-10-01，见上面的 `SubagentStop` 12 字段：无任何状态字段） | **强**（原为「schema 级、中——待实测」） |
>
> **为什么 schema 级不足以定论**：JSON Schema 的 `properties` **不禁止**运行时出现未列出的字段
> （除非该 schema 明确写了 `additionalProperties: false`，而 ④⑤ 两段捕获里**没有**这一项）。
> 我在二进制里再搜了一遍 `SubagentStop` 附近的字符串，**未见 status/state/success/fail 类字段**——
> 但这仍是**间接**证据。
>
> ⇒ **处置**：codex 的 `statusMissing: 'not-exposed'` 降级为**预期行为**而非已证事实；
> ✅ **该保留已于 2026-10-01 关闭**：真机抓到了 `SubagentStop` 载荷，**确证没有状态字段**
> （12 字段逐字见本节开头的升级块）。⇒ `statusMissing: 'not-exposed'` 现在有真机依据，
> 「不得据此断定」的禁令解除。
> （这也是 `statusMissing` 这个字段本身的价值：**它让"拿不到"是显式的**——即便将来发现 codex
> 其实给得出，也不会有一行假数据被静默写进快照。）

#### 6.4.1 真机原始载荷（抓自 2.1.281，提示词明确要求派生一个子智能体）

```jsonc
// ① subagent-start 的全部来源 —— 默认就发，无需任何 SDK 选项
{ "subtype":"task_started", "task_id":"ac9fca27ed014a4ea",
  "tool_use_id":"call_e086fd6fde2f4f1ab029fce9",      // ← 派生它的 Agent 工具调用 id
  "description":"Count lines in notes.txt", "subagent_type":"general-purpose",
  "is_backgrounded":false, "spawn_depth":1, "task_type":"local_agent",
  "prompt":"Count the number of lines in the file notes.txt …" }

// ② subagent-end 的全部来源
{ "subtype":"task_notification", "task_id":"ac9fca27ed014a4ea",
  "tool_use_id":"call_e086fd6fde2f4f1ab029fce9",
  "status":"completed",                                // ← 真实终态，不是猜的
  "summary":"**3 lines** in `/tmp/…/notes.txt` (per `wc -l`).",
  "usage":{"total_tokens":19901,"tool_uses":2,"duration_ms":14496},
  "output_file":"…\\tasks\\ac9fca27ed014a4ea.output" }

// ③ 状态更新（含 killed / paused，是 status 的第二来源）
{ "subtype":"task_updated", "task_id":"ac9fca27ed014a4ea",
  "patch":{"status":"completed","end_time":1790757115826} }

// ④ 跑动期心跳（含最后调用的工具名）
{ "subtype":"task_progress", "task_id":"ac9fca27ed014a4ea",
  "tool_use_id":"call_e086fd6fde2f4f1ab029fce9",
  "description":"Running Check current directory for notes.txt",
  "subagent_type":"general-purpose", "last_tool_name":"Bash",
  "usage":{"total_tokens":1,"tool_uses":1,"duration_ms":2625} }
```

#### 6.4.2 三条已验证的关键事实

1. **默认就发**（`forwardSubagentText: false` 与 `true` 各跑一次，`task_started` **各 1 条**）
   ⇒ **做 §6 不需要开任何开关**。我们适配器收不到它们，只因为 `events.ts` 把 `system` 一律落成
   `unknownEventDraft`（`claude-code/events.ts:52`）——**数据一直在，只是没人读**。
2. **`task_started.tool_use_id` ≡ 派生它的 `Agent` 工具调用 id ≡ 子智能体消息的 `parent_tool_use_id`**。
   真机逐字（两次运行都一样）：
   ```
   Agent 工具调用的 id : ["call_e086fd6fde2f4f1ab029fce9"]
   子智能体消息的 parent_tool_use_id: ["call_e086fd6fde2f4f1ab029fce9"]   ← 完全相同
   ```
   ⇒ **这就是「归属」的桥**：用户口径的"用 `parent_tool_use_id` 划分归属"**成立且已实测**，
   而且**不需要 hook、不需要读 transcript**。
3. **`forwardSubagentText` 只影响"说了什么"，不影响"派了谁"**。A/B 差集：

   | | `parent_tool_use_id` 非空消息数 | 子智能体消息的块类型 |
   |---|---|---|
   | `false`（默认） | 5 | `text:1` · `tool_use:Bash:2` · `tool_result:2` |
   | `true` | **10** | `text:3` · **`thinking:3`** · `tool_use:Bash:2` · `tool_result:2` |

   ⇒ 默认**丢弃**子智能体的思考与大部分文本；开了才拿到完整嵌套轨迹。
   官方逐字："By default, only tool_use/tool_result blocks from subagents are emitted
   **(enough for a heartbeat counter)**"。

#### 6.4.3 字段落点（可直接实现）

| §6 字段 | 来源 |
|---|---|
| `subagentId` | **`task_id`**（真机 `ac9fca27ed014a4ea`）——**厂商原生 id，不需要合成** |
| `vendorId` | 同 `task_id`（**不再是 `null`**，推翻 §6.2 里"claude 只能合成"的说法） |
| `parentSubagentId` | `spawn_depth > 1` 时用 `parent_agent_id`（**仅深度 ≥2 有效**，见下） |
| `name` | `task_started.description`（**厂商给的任务名**，不是我们编的） |
| `kind` | `task_started.subagent_type`（真机 `"general-purpose"`） |
| `source` | **`'wire'`**（SDK 原生消息，既不是 hook 也不是 aggregate） |
| `subagent-end.status` | `task_notification.status` ∈ `'completed'\|'failed'\|'stopped'` ⇒ **有真实来源** |
| `subagent-end.outcome` | `task_notification.summary` |
| `subagentId` 关联键 | `task_started.tool_use_id` ↔ 消息的 `parent_tool_use_id`（§6.4.2 第 2 条） |

**⇒ 一条重要的三家不对称**：§6 的 `statusMissing` 对 **claude 用不到**（有真实终态）、
对 **dsh 待验**、**只有 codex 一定要用**（`SubagentStop` schema 没有状态字段）。
这是三家在子任务上第一处**真实的能力差异**，应保留而不是抹平。

#### 6.4.4 `parent_agent_id` 的**正确用法**（别用错）

官方逐字（`SessionMessage.parent_agent_id`）：

> agentId of the subagent that spawned this subagent, **or null when this message belongs to a
> **depth-1** subagent (spawned by the main loop)** or to the main session itself.

⇒ **深度 1 的 `parent_agent_id` 是 `null`，与主会话不可区分**。
**父子关系对深度 1 只能靠 `parent_tool_use_id` 建立**（`spawn_depth === 1` ⇒ `parentSubagentId: null`）。
若照字面用 `parent_agent_id` 判父子，会得到"所有子智能体都没有父"。

#### 6.4.5 `result.subagent_stats`：**未收编进类型面的聚合字段**

**它确实存在**（真机载荷），但 `sdk.d.ts` 里 `subagent_stats` **0 命中**——**SDK 类型面没有它**。
用途限定为**聚合面板与交叉校验**（`source: 'aggregate'`），**不作为逐个身份的来源**：

```jsonc
"subagent_stats": { "spawned":1, "requested":{"background":0,"foreground":1,"unset":0},
  "started_in_background":0, "max_depth":1, "spawned_by_subagents":0,
  "completed":1, "failed":0, "killed":{"parent":0,"user":0,"system":0},
  "refused":{"depth_limit":0,"concurrency_limit":0,"budget":0}, "by_type":{"general-purpose":1} }
```

⚠️ **它是未文档化字段**（类型面未收编）⇒ **可能随版本变动**。实现时**不得**让它成为唯一数据源：
`task_*` 是主源，`subagent_stats` 只做交叉校验（两者不一致时以 `task_*` 为准并告警）。

#### 6.4.6 与 hook 的关系（为什么不用 hook）

| | 原生 `task_*` 消息 | `SubagentStart`/`SubagentStop` hook |
|---|---|---|
| 需要额外配置 | **不需要** | 需要在 query options 里注册回调 |
| 需要改被测仓库/环境 | 不需要 | 不需要（SDK 内回调） |
| `tool_use_id`（归属键） | ✅ 有 | ❌ **没有**（只有 `agent_id`/`agent_type`） |
| 终态 | ✅ `status` | ⚠️ 靠 `last_assistant_message` 猜 |
| 嵌套深度 | ✅ `spawn_depth` | ❌ 无（TS 版 `BaseHookInput` 无 `parent_agent_id`） |
| 跑动期进度 | ✅ `task_progress` | ❌ 无 |

⇒ **claude 侧走 `'wire'`，hook 只作后备**。这与 codex 相反（那边事件流结构性拿不到，
**只能**走 hook，§7.5.4）——**这个差异要在实现里显式表达，不能拉平**。

### 6.5 dsh 侧的数据源：两条通知 + 一个 catalog 事件（2026-09-30 真机定型）

> **本节把 §6 里"dsh 从未触发过"的空白关掉。** 那个通道一直都是好的，只是从来没被测过。

#### 6.5.1 真机原始载荷（GLM-5.3，提示词明确要求派生一个子智能体）

```jsonc
// ① 顶层通知：子会话建立（**父子关系在这一条里**）
{ "method":"subagent.started",
  "params":{ "parentSessionId":"session-16c91eba4bf54932a23c6dd4f39eb05b",
             "childSessionId":"a5e63152-5662-4986-a190-7849eeac0f0b" } }

// ② 会话事件：子任务目录项（**任务名与模式在这一条里**）
{ "type":"subagent/catalog",
  "data":{ "version":0, "childId":"a5e63152-5662-4986-a190-7849eeac0f0b",
           "childCreatedAt":1790757576213, "mode":"one-shot",
           "label":"Count lines in notes.txt" } }        // ← 厂商给的任务名

// ③ 顶层通知：子任务收场（**身份、终态、结果全在这一条里**）
{ "method":"subagent.finished",
  "params":{ "provider":"spawn",
             "agentId":"a5e63152-5662-4986-a190-7849eeac0f0b",   // ← 厂商原生 id
             "parentSessionId":"session-16c91eba4bf54932a23c6dd4f39eb05b",
             "childSessionId":"a5e63152-5662-4986-a190-7849eeac0f0b",
             "status":"ok",                                      // ← 自己的状态词汇
             "stopReason":"completed",
             "lastAssistantMessage":[
               { "type":"reasoning", "text":"Both methods agree: the file has 3 lines. …" },
               { "type":"text", "text":"3" } ] } }
```

#### 6.5.2 字段落点

| §6 字段 | dsh 来源 |
|---|---|
| `subagentId` | `agentId`（③）或 `childSessionId`（真机两者**同值**）——**厂商原生，不需要合成** |
| `vendorId` | 同 `agentId` |
| `parentSubagentId` | 由 `parentSessionId` 判定：**等于主会话 id ⇒ `null`**（深度 1） |
| `name` | `subagent/catalog` 的 **`label`**（真机 `"Count lines in notes.txt"`） |
| `kind` | `subagent/catalog` 的 **`mode`**（真机 `"one-shot"`）／`provider`（真机 `"spawn"`） |
| `source` | **`'wire'`**（厂商通知流） |
| `subagent-end.status` | **需要映射**：dsh 给的是 `status: "ok"` + `stopReason: "completed"` 两个字段 |
| `subagent-end.outcome` | `lastAssistantMessage` 里 `type === 'text'` 的块（真机 `"3"`） |
| `tool_use_id`（归属键） | ❌ **dsh 的通知里没有**——归属只能靠 `parentSessionId`/`childSessionId` |

**⚠️ dsh 的 `status` 是另一套词汇，不能直接塞进 §6 的值域**：

| dsh `status` | dsh `stopReason` | §6 的 `status` | 依据 |
|---|---|---|---|
| `"ok"` | `"completed"` | `'completed'` | 真机（2026-09-30） |
| `"error"` | `"aborted"` | `'canceled'` | 真机（2026-09-30）：父智能体 `interrupt_agent` 掉一个正在跑的后台子任务，载荷逐字 `{"status":"error","stopReason":"aborted",…}` |
| **`"ok"`** | **`"max-tokens"`** | **`'failed'`**（2026-10-01 定案：截断＝没做完） | **真机（2026-10-01）**：子任务撞上输出上限被截断，厂商给的是 `status:"ok"` + `stopReason:"max-tokens"` + 半篇 `lastAssistantMessage` |

> **⚠️ 判据必须是 `stopReason`，而且 `status` 这一格"两个方向都会骗人"**（2026-10-01 真机补齐第二个方向）：
> · 取消时是 `status: "error"`——字面像"失败"，真实语义是**主动取消**；
> · **截断时是 `status: "ok"`——字面像"成功"，真实语义是"没跑完"**。
> 若只看 `status`，一次主动取消会被记成"子任务失败"、一次截断会被记成"子任务成功"，**两个方向都是假数据**。
> ⇒ `mapSubagentStatus()` 必须**同时**读两格。
>
> **`stopReason` 的完整值域**（类型面逐字，`@deepseek-ai/dsh-subagent`）：
> `completed` · `aborted` · `error` · `max-tokens` · `refusal`。
> **真机已覆盖 3/5**（`completed` / `aborted` / `max-tokens`）；`error` 与 `refusal` **仍未观测**
> ——`subagent` 工具的入参只有 `{description, prompt, run_in_background}`，**没有模型/供应商覆盖口**，
> 本机没有省事的构造法。这两格继续按"未知取值原样透出，不假装映射"处置。
>
> **`max-tokens` 的映射：已定案（用户口径 2026-10-01）⇒ `'failed'`**。
> 理由三条：
> ① §6 的 `status` 四值（`completed` / `failed` / `canceled` / `null`）里**"做完没做完"是唯一的判据轴**，
>    截断就是**没做完** ⇒ `'failed'` 是这一轴上的正确取值；
> ② **不为它新增枚举值**——`status` 是三家共有字段，为一个厂商专属成因加一档，
>    等于让另两家去理解一个它们永远不会产生的值；
> ③ **信息不丢**：`outcome` 里仍留着那半篇文本（真机验证过：截断时 `lastAssistantMessage` **有** `text` 块），
>    UI 照常显示"做到一半"，只是状态不再冒充成功。
>
> **配套的一条硬规则（比取值本身更重要）**：
> **只要 `stopReason !== 'completed'`，一律不得记为 `'completed'`**；
> 而 `stopReason` 落到**未观测过的取值**（`error` / `refusal`）时，仍走
> `status: null` + `statusMissing`（§4「缺就是缺」）——**不许猜**。
>
> 同轮另一条实测：**截断时 `lastAssistantMessage` 里有 `text` 块**（半篇文章）⇒ `outcome` 该填就填；
> 这与取消路径的"可能只有 `reasoning` 块、没有 `text` 块"不矛盾（两条路径形状不同）。
> ⇒ **取消那一格 `outcome` 必须是 `null`**，**不得**退而取 reasoning 文本。
> 证据：`probe/dumps/v4/dsh-subagent-failure.json`。

#### 6.5.3 与 claude 的差异（都要在实现里显式表达）

| | claude | dsh |
|---|---|---|
| 通道 | SDK 原生 `system/task_*` | 厂商顶层通知 `subagent.started/finished` + `subagent/catalog` |
| 任务名 | `task_started.description` | `subagent/catalog` 的 **`label`**（**分散在另一条消息里**） |
| 归属键 | ✅ `tool_use_id`（与消息 `parent_tool_use_id` 同值） | ❌ 只有 `parentSessionId`/`childSessionId` |
| 终态 | ✅ 单一 `status` | ⚠️ **两个字段**（`status` + `stopReason`） |
| 结果摘要 | `task_notification.summary` | `lastAssistantMessage[].text`（**要自己挑块**） |

⇒ **"三家归一"在数据源层做不到**（这正是 `source` 字段存在的理由）；**能归一的只有产出的事件形状**。
`name`/`kind` 在 dsh 上**分散在 `subagent/catalog`** 里 ⇒ 适配器**必须维护
`childSessionId → catalog` 的关联表**（否则拿不到任务名）——这是 dsh 侧实现的关键点。

## 7. 三家映射表（逐格，含实测依据）

### 7.0 先划边界：本项目经 SDK 驱动，不直接操作 CLI

**这一条决定所有映射的可行性上界，故排在映射表之前。**

本项目对 codex 的唯一入口是 `@openai/codex-sdk`（`providers/codex/sdk.ts` 的
`loadCodexSdk()`；`package.json` 的依赖是 `@openai/codex-sdk`）。适配器**不 spawn CLI、
不解析 CLI 的 stdout、不读 CLI 的 JSONL 文件**。而 SDK 自己 spawn CLI 时用的参数是
`["exec", "--experimental-json"]`（`dist/index.js:177`）——**注意不是 `--json`**。

#### 7.0.1 SDK 不会吞事件（这一层是好的）

```js
// @openai/codex-sdk/dist/index.js:79-92
for await (const item of generator) {
  let parsed;
  try { parsed = JSON.parse(item); } catch (error) { throw new Error(`Failed to parse item: ${item}`, …); }
  if (parsed.type === "thread.started") { this._id = parsed.thread_id; }
  else if (parsed.type === "turn.completed") { parsed.usage.cache_write_input_tokens ??= 0; }
  yield parsed;                       // ← 无类型过滤：未识别的事件照样透传
}
```

`yield parsed` 是**无守卫**的，SDK 只对 `thread.started` / `turn.completed` 两个字段做补全，
不认识的 `type` 原样交给消费方。**所以「SDK 过滤掉了 subagent 事件」这个假设是错的。**

#### 7.0.2 真正的上界：CLI 的事件联合是封闭的，且没有 subagent

我们的适配器把 SDK 的 `Promise<StreamedTurn>` 当 `AsyncIterable<CodexEvent>` 消费
（`CodexEvent = { type: string; [key: string]: unknown }`，**开放形状**，故类型层面不拦）。
那么实际上界取决于 CLI 产出什么。**用 SDK 自身跑一次、把 `type` 全集打出来**（实测）：

```
thread.started, item.started, item.completed, turn.completed, turn.started
```

**只有这 5 种**，与 SDK 类型面声明的 `ThreadEvent` 联合逐字吻合，**其中没有任何 subagent 变体**。

⇒ **结论：子智能体数据永远不可能从 `runStreamed` 的事件流里拿到。**
这不是 bug、不是配置问题，而是「SDK 的封闭联合 ∩ CLI 的封闭事件集」的**结构性结果**。
它与 §7.5 的 model preset 问题是**两件独立的事**——就算 preset 修好、`spawn_agent` 能跑，

> ## ⚠️ 上面这一段**已被真机推翻**（2026-09-30 验证轮，2026-10-01 复核）
>
> 三处更正，都在**同一份 0.154.0 + 同一个 SDK 路径**上实测（`probe/dumps/v2/codex-*.jsonl`）：
>
> | 原话 | 真机 |
> |---|---|
> | 「`type` 全集只有 **5** 种」 | **7 种**（2026-10-01 第三次修正）：`thread.started` · `turn.started` · **`item.started`** · `item.updated` · `item.completed` · `turn.completed` · 两个失败态 **`error`** / **`turn.failed`**（前两次分别漏了 `item.updated` 与 `item.started`） |
> | 「事件联合没有 subagent 变体」（事件 `type` 层） | ✅ 这一句**成立** |
> | 「⇒ **子智能体数据永远不可能**从事件流拿到」 | ❌ **不成立**：`item.type` 里有 **`collab_tool_call`**，字段 `tool` / `sender_thread_id` / `receiver_thread_ids` / `prompt` / `agents_states` / `status`；**2026-10-01 更进一步证到它能真的派发出子智能体**（`agents_states` 里拿到子智能体的真实答复） |
>
> **根因是把两个封闭性混为一谈**：事件 `type` 封闭 **≠** `item.type` 封闭。
> ⇒ 修正后的口径：**子智能体在事件流上有投影**（`collab_tool_call`），
> **hook 仍是更完整的带外通道**（hook 带 `agent_id`/`agent_type`，`collab_tool_call` 不带）。
> **「必须走 hook」的设计结论仍然成立**（§6 的 `source` 字段照样必需），
> 但立项理由要从"事件流拿不到"改成"**事件流给的身份不如 hook 完整**"。
事件流里也不会多出 subagent 事件。

#### 7.0.3 因此子智能体只有两条可得通道

| 通道 | 机制 | 经 SDK 是否可行 |
|---|---|---|
| **hook 命令** | codex 的 `SubagentStart` / `SubagentStop` 钩子（外部命令，stdin/stdout 协议） | **可行**：SDK 的 `config` 会被 `flattenConfigOverrides` 平铺成 `--config key=value` 传给 CLI（`dist/index.js:177-186`），故 hook 配置可以经 SDK 注入 |
| **rollout 会话文件** | `$CODEX_HOME/sessions/**/rollout-*.jsonl` 里的 `parent_thread_id` / `task_name` / `agent_id` / `subagent_kind` | **可行**：文件由 CLI 写，适配器直接读盘即可（但引入对厂商内部文件格式的依赖） |

**这也是 §6 的 `source: 'hook' | 'session-file'` 不是可选严谨、而是必需机制的原因。**

> 与三家横向对比，codex 是**唯一**「数据有这个维度、但送达通道在事件流之外」的一家：
> claude 在**流内**（侧链标记 + `subagent_stats`）、dsh 在**流内**（`subagent.started/finished` 通知），
> 只有 codex 必须走带外通道。规范必须为此留出 `source` 字段，否则这一格永远说不清。

#### 7.0.4 顺带纠正的一处口径

本次 SDK 路径实测（与适配器同路径、同一 `runStreamed` 入口）除了「5 种事件」外，
还确认了两点与 CLI 路径**完全一致**的行为，可放心作为映射依据：

1. `features: { multi_agent: true }` 经 SDK 的 `config` 注入后，模型确实收到并尝试调用
   `spawn_agent`（表现为 `agent_message` 里明说「spawn_agent was requested, but the tool
   returned `unsupported call`」）；
2. `unsupported call: spawn_agent` 同样复现——**证明 §7.5 的根因与「走 SDK 还是走 CLI」无关**。

#### 7.0.5 信封字段的三家落点（2026-09-30 补写：初稿漏了这一整块）

初稿的三张映射表（§7.1/§7.2/§7.3）**只映射内容块，没有一行映射信封字段**，
于是 §5.1 定义的 `role` / `turn` / `chunk` / `vendorId` 在三家**都没有落点**。
补齐如下——**其中 `turn` 是最严重的一格**：

| 信封字段 | claude | codex | dsh |
|---|---|---|---|
| `vendorId` | `message.id`（实测 `2ec0969d-…`） | **`item.id`**（初稿注释漏了这家） | `data.message.id` |
| `role` | `message.role`（实测 `"assistant"`） | ❌ **事件流里没有 role 概念** ⇒ 由 item 类型推：`agent_message`/`reasoning` → `assistant`；`command_execution`/`file_change`/`mcp_tool_call`/`web_search` → `tool` | `data.message.role` |
| `chunk` | 无增量 ⇒ 恒 `'snapshot'`（⚠️ 2026-10-01 更正：开 `includePartialMessages` 后可变 `'delta'`，仅主会话） | **`item.delta` 实测不存在**（2026-09-30，0 命中）⇒ codex 侧 `chunk` **恒 `'snapshot'`**（见 §7.3） | 原生块协议 ⇒ `block-start`/`text-chunks` = `'delta'`、`block-end` = `'snapshot'` |
| ~~`turn`~~ **已废弃 → `roundTrip` + `vendorTurn`**（2026-10-01 定案） | 原意：厂商无此字段 ⇒ 由 `assistant.message.id` 去重计数**合成** | 原意：无此字段 ⇒ 由模型产出条目数**合成**（`item.id` 去重；**已知偏高**） | 厂商字段就叫 `turn`，但它是**用户轮号** ⇒ 现落 `vendorTurn` |
| `step` | 无 ⇒ `null` | 无 ⇒ `null` | ✅ 厂商字段 `step`（一轮内的第几次调用） |

> **⚠️ 两版文档的列序不同（读表必看）**：本表按 **claude / codex / dsh**，
> 与 v2 [`2026-10-01-agent-message-spec-design-v2.md`](./2026-10-01-agent-message-spec-design-v2.md) §1 一致；
> **历史版本曾按 claude / dsh / codex** ⇒ 对读旧稿时注意列位，否则会把 dsh 的 `step` 读成 codex 的。

> **⚠️ `turn` 的语义撞车（本节最要紧的一条）**：同一个 `message.turn`，三家是**三个不同的量**——
> claude/codex 是**合成出来的模型往返序号**，而 dsh 是**厂商的用户轮号**。
> 按 `turn` 分组或比较时，**消费方必须按厂商换算**，否则会出现"dsh 只有 1 轮而另两家 60 轮"的假象
> （这只是"用户问了一次、模型往返了 60 次"）。
>
> **修法（择一，见 §11 开放问题 22）**：
> ① 把 `turn` 正名为**模型往返序号**，dsh 侧另起 `vendorTurn` 存厂商的轮号（**本文倾向此方案**，
>    因为"一次 API 往返"是本仓**已经统一过**的口径——§5.1 的轮次定义、`usage.turns` 都按它）；
> ② 把 `turn` 定义成厂商轮号，另加 `roundTrip` 字段承载往返序号。
>
> 在定案前，**`turn` 字段不得用于跨家比较**——这条限制写进 §7.6.4 的渲染契约。

### 7.1 claude-code

| 厂商原文 | 规范落点 |
|---|---|
| `assistant.message.content[].type==='thinking'` | `thinking` 块：`text` = `.thinking`，`signature` = `.signature`（**隐藏字段**：仅审计，UI/文案一律不得呈现，§5.2 / §7.6.4） |
| `assistant.message.content[].type==='text'` | `text` 块 |
| `assistant.message.content[].type==='tool_use'` | `tool-call` 块：`callId` = `.id`，`name` = `.name`，`input` = `.input` |
| `user.message.content[].type==='tool_result'` | `tool-result` 块：`callId` = `.tool_use_id`，`status` 按 `.is_error` |
| `parent_tool_use_id` 非空 | `source: 'subagent'` + `parentMessageId` ⚠️**见下** |
| `result.subagent_stats` | 一对 `source: 'aggregate'` 的 subagent 事件 |
| `result.structured_output` / `result.result` | **最终答复**（`finalText`）：结构化优先 |
| `system.subtype==='thinking_tokens'` | **已识别且有意不投影**（2026-09-30 定案，§7.7.3）：它是**估算帧**（SDK 逐字 "not the authoritative billed output_tokens"），且逐帧高频（实测一轮 6913 条事件 / 2.1 MB，绝大多数是它）⇒ **既不落 `attachment`**（逐帧噪声会把抽屉灌满），**也不进 `usage`**（近似值冒充结算值）。与下面 `session.status` 同一档处置 |
| `result.num_turns` / `usage` | `usage` 行级事件；**思考 token 的主源是 `result.usage.output_tokens_details.thinking_tokens`**（与三元组同源、同为主循环口径）；`modelUsage[].thinkingTokens` **只做交叉校验**，见 §7.7.2 |

> **⚠️ `parent_tool_use_id` 装不进 `parentMessageId`（2026-09-30 更正，独立审查指出）**：
> 字段名是 `parent_tool_use_id`，**值是工具调用 id**（属 `callId` 空间），**不是 messageId**。
> 按 `parentMessageId` 去索引父消息**在 claude 上必然查不到**。
>
> claude 侧的正确路径是**两跳**：`parent_tool_use_id` → 找持有该 `callId` 的 `tool-call` 块
> → 再找承载那个块的消息 —— 这是 claude 专属的解析，消费方要跨家统一就**必须按厂商分支**。
>
> **登记为开放问题 24**（修法：要么该字段改名为 `parentCallId` 并把 claude 的映射写清楚，
> 要么规范层补一条"父消息解析算法"把两跳路径统一表达）。**在定案前，claude 的
> `parentMessageId` 不得用于索引父消息。**

**实测形状**（`probe/dumps/claude-code.json:347-353`）：
```json
{ "type": "thinking",
  "thinking": "The user wants me to answer with a single character: 好. No tools, no files.",
  "signature": "2ec0969d-8179-4977-a61b-1d7387b199a0" }
```

**实测的关键坑**：同一条 `message.id` 分两次投递，一次只带 thinking、一次只带 text——
必须按 §5.1 的覆盖语义合并。

### 7.2 dsh

| 厂商原文（`params.event`） | 规范落点 |
|---|---|
| `type==='assistant/message'` | `message` 事件（`messageId` = `data.message.id`） |
| `data.message.content[].type==='reasoning'` | `thinking` 块：**`text` = 该块的 `.text`**（真机实测非空，259/68/143 字符）、`textKind: 'full'`；`signature` 取 `data.message.source.replayState.blocks[].signature`（**隐藏字段**，与 §7.1 同口径：仅审计、UI 不得呈现，§5.2）。⚠️ **dsh 不发 `reasoning-delta`**（实测 0 次）：推理**只能整块**从 `block-end` / `assistant/message` 取，没有增量可推 |
| **思考强度的 wire 形态**（2026-09-30 实测） | 适配器的 `effort` 经 SDK 落到请求体：`"thinking":{"type":"enabled"\|"disabled"}` + `"output_config":{"effort":"low"\|"high"\|"max"}`（`off` ⇒ `disabled` 且**不带** `output_config`）。插件侧逐字：`thinking: { type: effort === "off" ? "disabled" : "enabled" }`。`request/header.config.reasoningEffort` 里可见解析后的档位 |
| `data.message.content[].type==='text'` | `text` 块 |
| `data.stream[].chunk.type==='block-start'` | `message` 事件，`chunk: 'delta'`（块开始） |
| `data.stream[].type==='text-chunks'` | `message` 事件，`chunk: 'delta'`，`blocks[].text` = 增量文本 |
| **`data.stream[].type==='reasoning-chunks'`**（2026-09-30 补） | 同上，内容是**推理**的增量 |
| `data.stream[].chunk.type==='block-end'` | `message` 事件，`chunk: 'snapshot'`（完整块） |
| **`data.stream[].type==='tool-call-chunks'`**（2026-09-30 补） | 同上，内容是**工具调用**的增量。⚠️ §8.1 写的「dsh 的工具调用都没有 token 流」**与实测不符**——真机 16 条命中 |
| `type==='tool/call'` | `tool-call` 块：`callId` = `data.callId`，`name` = `data.name`，`inputText` = `data.arguments`（**JSON 字符串**，parse 成功才填 `input`） |
| `type==='tool/result'` | `tool-result` 块：`callId` = `data.message.toolCallId`，`status` 按 `data.message.isError` |
| **`type==='tool/result'` 的 `data.meta`**（2026-09-30 补：初稿漏了这一整块） | **族结构的权威来源**——`read` 给 `{path,offset,lines[],totalLines}`、`glob` 给 `{shape:'paths',paths[],truncated,total}`、**`grep` 给 `{shape:'matches',files[{path,matches[{lineNumber,line}]}],truncated,total}`**、**`write` 给 `{operation:'create'\|'update',diffs[]}`**、**`edit` 给 `{diffs[{path,oldText,newText}]}`**。**有 `meta` 就不要解析文本** |
| `subagent.started` / `subagent.finished`（**通知 method**） | `subagent-start` / `subagent-end`，`source: 'wire'` |
| `type==='step/start'` | 轮次 +1（`usage` 行级事件） |
| `assistant/message → data.usage` | `usage` 行级事件的**唯一**来源（`inputTokens` / `cacheReadTokens` / `outputTokens` 三元组，实测）。**思考 token：结构性拿不到（2026-10-01 真机定案）**——`@deepseek-ai/dsh-llm` 的类型面上**有** `reasoningTokens?: number`，但**本仓用的那条路由永远不会写它**：`@deepseek-ai/dsh-llm-pi-ai` 的 `mapUsage()` 只映射 `input/output/total + cache 两格`，且源码注释逐字 *"Map pi-ai usage (reasoning folded into output by pi-ai)"*、README 逐字 *"pi-ai folds reasoning tokens into output usage…"* ⇒ **不是"还没采到"，是"这条路由不投影"**：`usageCapability.thinkingTokens` 应记 **`'off-by-adapter'`**（不是 `'unverified'`），`basis` 保留 `'unknown'` 并附注"厂商语义是并入 output，但本路由不暴露该值"。两段证据：上游**确实给了** `output_tokens_details.reasoning_tokens = 31`（`dumps/v4/wire-usage-shape.json`），而 dsh 侧 usage 逐字只有 `{inputTokens,outputTokens,totalTokens}`（`dumps/v4/dsh-reasoning-tokens.json`） |
| `type==='turn/start'` / `turn/end` | 轮次边界；`turn/end.reason.kind==='error'` ⇒ `error` 事件 |
| `type==='session/title'`、`request/header`、`request/context`、`session-log-*` | `attachment` 块（`reason: 'unrecognized'`） |
| `session.status` | **有意不投影**（保留既有口径：与轮次语义无关，落盘只增噪声） |

**实测形状**（`probe/dumps/dsh.json`）：
```json
// assistant/message 的 content —— reasoning 的 text 是空串
"content": [ { "type": "reasoning", "text": "" },
             { "type": "text", "text": "好" } ]
// replayState 里才有 signature
"blocks": [ { "type": "reasoning", "signature": "43bc2eee-86ac-49ba-8e64-0194a70fe434" },
            { "type": "text" } ]
```

**原生流是块协议**（这是 D6 能做到 1:1 映射的原因）：
```json
{ "type":"chunk", "chunk":{ "type":"block-start", "index":0, "blockType":"reasoning" } }
{ "type":"text-chunks", "index":1, "dt":[], "texts":["好"] }
{ "type":"chunk", "chunk":{ "type":"block-end", "index":1, "block":{ "type":"text", "text":"好" } } }
```

**~~未验证项~~（已闭合，2026-09-30 / 2026-10-01）**：`subagent.started/finished` 的真机载荷见 §6.5.1；
2026-10-01 又补齐了**非成功路径**（`status:"ok"` + `stopReason:"max-tokens"`）、
`subagent/catalog.mode` 的两个取值（`one-shot` / `continuable`）、以及 `subagent/descriptor` 的载荷与归属。
⇒ 本节不再有"从未真机触发过"的空白；字段口径**按实测**（不再"按类型面 + 二进制字符串推断"）。

### 7.3 codex

| 厂商原文 | 规范落点 |
|---|---|
| `item.completed` + `item.type==='agent_message'` | `text` 块（**最终答复**来源） |
| `item.completed` + `item.type==='reasoning'` | `thinking` 块：`text` = `.text`（**推理摘要**，非完整思维链）；`signature: null`（codex 不给 replay 校验串 ⇒ 恒 `null`；隐藏口径同 §5.2）。**⚠️ 2026-10-01 真机：这一行在 DeepSeek 路由上恒不触发**——37 条 item 里 `reasoning` **0 条**；而 **wire 层确实有** `{"type":"reasoning",…,"content":[{"type":"reasoning_text","text":"<整段推理原文>"}],"summary":[]}`（`summary` 是**空的**）⇒ **是 codex 不投影，不是链路丢了**。**同日追加轮补一条边界**：内网网关路径上**拿不到证据**（4 个 case 里 3 个因 `tool_choice` 提前失败、1 个用未知模型只产出一条 `agent_message`）⇒ 这条"不投影"**只能说在 DeepSeek 路由上成立**。因此 codex 的"思考文本"**在已观测的两条路径上都为 `null`**，`textKind` 实得只能是 `'none'`（契约里的 `'summary'` 描述的是**厂商语义**，不是本机实得） |
| `item.started/updated/completed` + `item.type==='command_execution'` | `tool-call` 块：`callId` = `.id`，`name` = `'shell'`（规范自定名），`input.command`；`tool-result` 块的 `text` = `.aggregated_output`，`status` 按 `.exit_code` / `.status` |
| `item.*` + `item.type==='file_change'` | `tool-call`（`name='apply_patch'`）+ `tool-result`（`status` 按 `.status`，`text` = 变更文件列表） |
| `item.*` + `item.type==='mcp_tool_call'` | `tool-call`（`name` = `server + '/' + tool`，`input` = `.arguments`）+ `tool-result`（`.result` 或 `.error.message`） |
| `item.*` + `item.type==='web_search'` | `tool-call`（`name='web_search'`，`input.query`） |
| `item.*` + `item.type==='todo_list'` | **`task` 族的唯一来源**（2026-09-30 实测确认，见 §7.3.1）：`item.started/updated/completed` 三态都发，载荷是 `{id, type:'todo_list', items:[{text, completed}]}`。**它不是 `attachment`** |
| `item.*` + `item.type==='error'` | `error` 行级事件（**不是** attachment——它有明确语义） |
| `turn.completed.usage` | `usage` 行级事件：`cache_write_input_tokens` 今天被丢弃、规范保留；**思考 token 取 `reasoning_output_tokens`**（类型面**必填**，但本仓夹具与真机样本里从未出现 ⇒ 未核对，§7.7.2） |
| `thread.started` / `turn.started` | `attachment` 块 或 忽略（信封级；`thread_id` 进 `message.raw`） |
| `item.delta` | **实测不存在**（2026-09-30）：多轮运行里 `含 delta 的行数 = 0` ⇒ codex 侧 `chunk` **恒为 `'snapshot'`**，`streamingDelta: 'no'` |
| `spawn_agent` / `wait_agent` / `send_message` / `followup_task` / `interrupt_agent` 的调用 | `tool-call` 块（`name` 用原名，**不改名**——改名会让 codex 认不出自己的调用）；其产出为 codex 本地执行的事实 |
| **子智能体生命周期** | **部分在事件流上**（2026-09-30 更正）：`item.type==='collab_tool_call'`，带 `tool` / `sender_thread_id` / `receiver_thread_ids` / `prompt` / `agents_states` / `status`；但**不带 `agent_id`/`agent_type`** ⇒ 完整身份仍走 hook / session-file，见 §7.5 |

#### 7.3.1 两个开关打开后，`update_plan` / `request_user_input` 落到哪个 item（**2026-09-30 已定案：候选 ①**）

**这是初稿漏掉的一整块**（独立审查指出）。矛盾在于：

- §7.6.2.2 断言「codex 的面板**只能靠工具面（`update_plan`）重建**」，
  §7.6.3 也写出了它的 args 结构；
- 但**本表没有任何一行说这个调用以哪种 `item.type` 出现在事件流里**，
  而唯一与"计划"有关的 item 形状 `todo_list` 又被写成 `attachment`（不解析）——
  ⇒ 两个开关打开后，**适配器仍不知道从哪读 `plan[]`**，codex 的 `task` 族与面板会**恒空**。

**已知与未知要分清**：

| 事实 | 状态 |
|---|---|
| `update_plan` **存在于工具表**（开 `tools.update_plan.enabled` 后实测出现在 `write_stdin` 之后） | ✅ 已证（§7.6.3） |
| 它的输入是 `{explanation?, plan:[{step,status}]}` | ✅ 已证（二进制内嵌文案） |
| 它**以哪种 `item.type` 出现在 `exec --json` 事件流里** | ✅ **已实测（2026-09-30）：`item.type === 'todo_list'`**——`item.started` / `item.updated` / `item.completed` 三态都发 |
| `todo_list` 与 `update_plan` 是否同一个东西 | ✅ **是同一个东西**：模型每次调用 `update_plan`，事件流就多发一条同 `item.id` 的 `todo_list` |
| `update_plan` 到底是工具还是内部功能 | ✅ **是工具**：入站 `tools[]` A/B 实测 9 项 → 10 项，新增的正是 `update_plan`（插在 `write_stdin` 之后） |
| 事件流给的形状与工具输入是否一致 | ⚠️ **不一致**：工具描述是 `{step, status}`（三态、至多一个 `in_progress`），事件流只给 `{text, completed}`（**二态**）⇒ `TaskStep.status` 在 codex 上**恢复不出 `in_progress`** |

⇒ **实测结论（2026-09-30）：候选 ① 成立**（真机原文见 [验证报告](../notes/2026-09-30-agent-message-spec-verification.md)）：
`item.type === 'todo_list'`，载荷 `items: [{text, completed}]`，与 `@openai/codex-sdk` 的 `TodoListItem` 同形。

- **候选 ② 否**（没有 plan 专用 item 类型）；**候选 ③ 否**（不是只在 `agent_message` 里留痕）
  ⇒ ✅ **§7.6.2.2 的"工具面重建面板"方案成立**，不必改走 hook/session-file；
- ⚠️ 但**契约要降级**：工具输入的 `status`（三态）在事件流里被压成 `completed`（布尔），
  适配器**拿不到 `in_progress`**。codex 的 `TaskStep.status` 只能映射成 `pending` / `completed`，
  第三态**必须如实标 `unknown`**，不能猜。

**本表因此把 `todo_list` 那行的落点改成"待定"**，并列为 §11 开放问题 23。
`request_user_input` 同理——它的 `answers` 从哪个 item 来**也没有落点**，与 `update_plan` 一并待验。

**实测（见 §7.5）**：`ThreadEvent` 联合里**没有任何 subagent 变体**；子智能体工具是否可用
取决于**命名空间展开**与**模型元数据**两个卡点，而**不是**「codex 没有这个能力」。

### 7.4 难度诚实登记

| 格 | 难度 | 原因 |
|---|---|---|
| codex 的 `command_execution` → tool-call/result | 中 | 它是**一个** item 同时含调用与结果，要拆成两个块 |
| dsh 的 reasoning 文本 | ~~不可得~~ **更正：可得**（2026-09-30 真机）——旧结论源于探测中继破坏 SSE 分块的假象；适配器投影已补（`readAssistantReasoning`） | — |
| claude 的 subagent 身份 | **不可得** | 只有聚合计数，落 `source: 'aggregate'` |
| codex 的 subagent | **待实现** | 厂商有能力，卡点是命名空间展开 + 模型元数据，见 §7.5 |

### 7.5 codex 子智能体：根因已定位（本次调查最重要的一条）

#### 7.5.0 根因一句话

**能力开关、网关展开都不是卡点；卡点是「模型预设（model preset）没有 multi-agent 能力」。**
codex 只有当**当前模型预设自带 multi_agent profile** 时，才会为 `multi_agent_v1` 命名空间里的
工具注册本地执行器。profile 为 `null` 时，codex **照样把命名空间发给上游**（模型因此看得见
`spawn_agent` 并会去调它），但本地**没有执行器** ⇒ 调用落到
`codex_core::tools::router: error=unsupported call: spawn_agent`。

这是一个**「声明了但实现缺失」的不一致**，而且它**无法用配置修复**——见 §7.5.2 的穷举。

#### 7.5.1 官方口径（codex 自己写在 `references/codex-tools.md` 里，真机运行时被模型读出）

原文摘要（来自本机 `~/.agents/skills/using-superpowers/references/codex-tools.md`，
由本次真机运行的 `command_execution` 输出逐字回显）：

- 「Subagent dispatch requires multi-agent support」——在 `~/.codex/config.toml` 里加
  ```toml
  [features]
  multi_agent = true
  ```
  「This enables the multi-agent tools…」
- **「Which tools you get depends on the multi-agent version your model preset selects
  (current presets run V2; older ones run V1).」** ← **决定性的一句**：工具集由**模型预设**决定；
- V1 与 V2 的差异：**V2 没有 `close_agent`**（Finished children are evicted automatically），
  V1 才有 `close_agent`；V2 用 `followup_task` 续跑子智能体；
- **「V2 accepts only V2-capable presets and hard-errors on the rest」**；
- spawn 时可带 `fork_turns`（`"none"` = 干净上下文，默认 `"all"` = 复制整段 transcript）、
  `model`、`reasoning_effort`、`agent_type`；
- `[agents]` 表可用键：`default_subagent_model` / `default_subagent_reasoning_effort` 等。

**本机实测到的真实工具名（V1 档）**：`close_agent, resume_agent, send_input, spawn_agent, wait_agent`
——由本地 `proxygateway` 的诊断逐字记录（`builtin_tool_expanded`）：
「tools[4] 的 namespace 容器 multi_agent_v1 已展开为 5 个 function 工具
（close_agent, resume_agent, send_input, spawn_agent, wait_agent），由客户端执行」。

> 注意这与二进制字符串里那批名字（`send_message` / `followup_task` / `interrupt_agent`）
> **不完全重合**——那是 V2 档的名字。规范因此**不硬编码任何工具名**。

#### 7.5.2 根因隔离：五步穷举（每步都单独排除了一个假设）

| 步 | 做了什么 | 结果 | 排除了什么 |
|---|---|---|---|
| 1 | `features list` | `multi_agent stable true`（默认开） | —— |
| 2 | 直连企业网关 + `features.multi_agent=true` + `GPT-5.5` | 模型调了 `spawn_agent`，codex 回 `unsupported call` | —— |
| 3 | 经本地 `proxygateway`（**确认展开**：诊断逐字记录 5 个工具已展开，模型确实看见） | **仍然** `unsupported call` | **排除「网关没展开」** |
| 4 | 加 `features.multi_agent_v2=true`（V1/V2 都试） | **仍然** `unsupported call` | **排除「版本开关没开」** |
| 5 | 加 `agents.default_subagent_model` / `default_subagent_reasoning_effort` | **仍然** `unsupported call`；且新键被 CLI **接受**（无 unrecognized 告警，证明 `[agents]` 表存在） | **排除「缺 agents 配置」** |

**同时也验证了不可用的绕法**：`-c model_messages.multi_agent={role={root="…"}}` 被 CLI 判为
`unrecognized configuration setting … model_messages is ignored`——**模型 profile 无法通过配置注入**。

**结论（2026-09-30 更正措辞）**：**`spawn_agent` 要同时满足两个条件，缺一不可**：
① `features.multi_agent = true`；② 模型预设自带 multi_agent profile。

初稿只写了 ② 并把它说成"**唯一**未满足的条件"——**这是错的**，独立审查核对代码后发现
本仓 config 里 **`features: { multi_agent: false }` 仍然生效**
（`providers/codex/sdk.ts:62` 与 `buildCodexConfig` 的返回值；那是 2026-09-27 按
「命名空间工具在网关侧常回 400」加的护栏）。**我们自己的开关也没开。**

**而且这条护栏的原始理由已被本仓自己的实测推翻**：网关对 `multi_agent_v1` 命名空间的处置是
**忽略或展开**，**不是 400**（§7.5.2 五步穷举的第 3、4 步）。

⇒ **两处修正**：
1. `multi_agent` 是**本仓可自行解决**的一格，不该归入"外部依赖"；
2. **它同时卡住 D10 选定的 hook 通道**——`SubagentStart/Stop` 属于 multi-agent 机制，
   `multi_agent=false` 时**永不触发**，codex 的派发面板恒空（§6 的现状表）。
   ⇒ 这是 **B6 缺口**，与 §11 开放问题 20 一并处置。

`codex debug models` 的逐个解析（条件 ② 的依据）：**profile 的确切位置是
`model_messages.multi_agent`**（不是顶层——顶层根本没有这个键），形如
`{"role":{"root":"You are `/root`…"},"mode":…}`。
**只有 3 个模型带它**：

| slug | `model_messages.multi_agent` | `multi_agent_version` |
|---|---|---|
| **`gpt-6-astra`** | ✅ `{role, mode}` | v2 |
| **`gpt-6-sol`** | ✅ `{role, mode}` | v2 |
| **`gpt-6-luna`** | ✅ `{role, mode}` | v2 |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | ❌ `null` | v2 / v2 / v1 |
| `gpt-daybreak-blue-latest` / `gpt-daybreak-red-latest` | ❌ `null` | v2 |
| `gpt-5.5` / `gpt-5.4` / `codex-auto-review` | ❌ `null` | — |

#### 7.5.2b **profile 无法通过配置注入**（2026-09-30 实测，逐键判定）

判据有效（先验证）：写一个不存在的键 ⇒ CLI 自己报
`unknown configuration field \`bogus_key_xyz\``。用同一判据逐个试：

| 候选注入点 | 结果 |
|---|---|
| `model_providers.<id>.models`（数组） | ❌ `unknown configuration field` |
| `model_messages`（早先试过） | ❌ `is ignored` |
| 顶层 `multi_agent` / `multi_agent_mode` / `multi_agent_role` / `agent_default_subagent_model` | ❌ 全部 `unknown configuration field` |
| `features.multi_agent` · `features.multi_agent_v2` · `features.agent_message_board` | ✅ 被接受（但**不含 profile**） |

⇒ **只能由网关提供那 3 个 slug 之一**，本仓无解（§7.5.3 牌 A）。
二进制里虽然存在 `model_providers.<id>.models[]` 的元素 schema（含 `multi_agent_role`），
**但该路径不被配置校验接受**——schema 存在 ≠ 可从 config 到达。

#### 7.5.3 达成路径（两张牌，按可行性排序）

**牌 A（唯一确定可行）——网关列出 codex 认识的、带 profile 的模型名**

codex 的模型表有 11 个 slug（`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-5.6-*` /
`gpt-5.5` / `gpt-5.4` / `codex-auto-review`）。要求：

- 上游 / 网关的模型清单里**出现** `gpt-6-astra`（或 `-sol` / `-luna`）这个名字
  ——**当前两个网关都没有**：`gpt-6-sol` 经网关返回
  `404 模型(gpt-6-sol)不存在或已下线`；网关侧只有 `gt-6-as-a` / `gt-6-sol-a` / `gt-6-lu-a`，
  而这三个名字 codex **不认识**（`Model metadata for 'gt-6-sol-a' not found` → 落 fallback → profile 仍为 null）；
- 且该模型能跑通（`gt-6-*` 在直连时有 `invalid_encrypted_content`，需网关侧一并解决）。

**⇒ 行动项：请网关把模型名对齐成 `gpt-6-*`，或为 `gt-6-*` 增加 `gpt-6-*` 别名。**
这是**一行配置级**的改动，比改协议便宜得多。

> ### 2026-10-01 追加轮（VPN 恢复后）复核：**前提仍未满足，且又多了一条**
>
> 网关重新可达后重打清单（`probe/dumps/v4/gateway-restored.json`）：
> · **47 个模型**，里面**依然一个 `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` 都没有**；
>   只有 `gt-6-as-a` / `gt-6-sol-a` / `gt-6-lu-a`，而这三个名字 codex **不认识**（落 fallback ⇒ profile 仍为 `null`）；
> · ⚠️ 上一轮"**唯一**能跑完一个 turn 的模型名是 `GPT-5.5`"**已过时**：本轮清单里**没有 `gpt-5.5`**；
> · ⚠️ **一条新的访问前提**：`GET /v1/models` **不校验凭据**（拿一把故意写错的 key 也回 200），
>   所以"清单列得出来"**不等于**"能推理"。实测 `proxygateway` 里那几把 key 打 `/v1/responses` **一律 401**，
>   报文逐字「**登录态丢失，请重启再试**」——**这句话误导**：它读起来像服务端会话失效，
>   实际含义是"**这把凭据不被推理端点接受**"。⇒ 排障时别按字面去"重启网关"，
>   **先确认手里那把 key 能通过 `/v1/responses`**；
> · ⇒ **牌 A 的行动项不变，但优先级更高了**：网关侧还得同时解决
>   `tool_choice is only allowed when 'tools' are specified`（带 tools 的请求被拒，
>   而 **codex 的每一次真实调用都带 tools**）⇒ 这条不修，**网关路径上 codex 不可用**。

> ### ⚠️ 2026-09-30 验证轮的三条更正（证据见 [验证报告](../notes/2026-09-30-agent-message-spec-verification.md)）
>
> 1. **「codex 认识哪 3 个 slug」随版本变**：真机逐名探测（判据是 `Model metadata for '…' not found` 告警）
>    显示 **0.154.0 只认 `gpt-6-astra` 一个**，**不认 `gpt-6-sol` / `gpt-6-luna`**
>    （0.156.1 才是三个都认）。⇒ 下表是**版本相关**的事实，不能当成"codex 的能力"。
> 2. **`gpt-5.6-sol` 虽被认识、网关也有，却跑不通**：网关回
>    `Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified.`，
>    整个 turn 立刻 `turn.failed`。§9.4 把它列为"网关噪声"是**低估**——它是**致命**的。
> 3. **"gpt-6-\* 只能由网关给"这条前提可以在本机绕开（仅用于探测）**：
>    `gpt-6-astra` 被 0.154.0 认识，而网关有对应的 `gt-6-as-a`；
>    在本机放一层**模型名中转**（逐块转发，见 §9.4.1 的教训）把 `gpt-6-astra` 改写成 `gt-6-as-a`，
>    codex 就会用**它自己那份带 multi_agent profile 的元数据**注册执行器，
>    `spawn_agent` 真的跑起来、`SubagentStart` hook 真的触发（§7.5.5 ⑩ 因此从"无法实测"变成"已抓到一半"，
>    **2026-10-01 在 DeepSeek 路由上补齐另一半：`SubagentStop` 也抓到了**）。
>    ⇒ **这不是产品解法**（产品仍应要求网关直接给带 profile 的名字），
>    但它证明：**卡点确实只在"名字"这一格**，与初稿的根因判断一致。

**牌 B（需要改 codex 本身，不可行）**——让 codex 接受自定义 preset。
`model_presets` / `spawn_allowlist` 这类键在二进制里**计数为 0**，即 0.156.1 **没有**
「用户自定义模型元数据」的入口。因此只能等上游提供带 profile 的模型名。

#### 7.5.4 硬边界：子智能体数据不在事件流上（与牌 A 是否打通无关）

见 §7.0 的完整推导。结论复述：codex 经 SDK 驱动，而 SDK 的 `ThreadEvent` 联合与 CLI 的
事件集**都是封闭的 5 种、都没有 subagent 变体**，且 SDK 无类型过滤（是上游没有，不是被吞）。
⇒ **即使牌 A 打通、`spawn_agent` 能跑，`runStreamed` 里也不会多出 subagent 事件。**
子智能体数据只能走 hook 或 rollout 会话文件——**hook 已选定并验证，见 §7.5.5**。

#### 7.5.5 采用 hook 通道：已验证的完整事实（用户口径：采用 hook）

> **⚠️ 适用范围（2026-10-01 二次更正）：本节的"已验证"原本只到 hook 的配置格式与输入 schema。**
> **现在两条 hook 的真实载荷都抓到了**（`SubagentStart` + `SubagentStop`，0.154.0 与 0.156.1 各 1 次），
> 所以这一节**从"配置已证"升级为"端到端已证"**。
> 上一轮记的两个前提条件里，**第二条被本轮推翻**：
> · `features.multi_agent` —— 本仓可开（`buildCodexConfig` 现为 `false`）；
> · ~~模型预设带 profile —— 本仓无解（只能由网关给模型名）~~ **不需要**：
>   本轮用 codex **不认识**的模型名（落 fallback 元数据）+ DeepSeek 路由，`spawn_agent` **真的跑通**、
>   hook **真的触发**（详见 §7.5.5 ⑩ 的限定块与 §9.3 的对应行）。
> ⇒ **"codex 的 hook 能否拿到子智能体信息"这一格：已从"未验证"变成"已验证"**。
> ⚠️ **但要带一条路由前提（同日追加轮补）**：两条 hook 的载荷是在 **DeepSeek 路由**上抓到的
> （`spawn_agent` 真的跑起来才会触发）；**内网网关路径上没能复现**——那边 `spawn_agent` 仍 `unsupported call`。
> ⇒ 准确说法是「**hook 机制已验证；它在哪条路由上能被触发，取决于 §7.5.2 那条与路由相关的条件**」。
> （追加轮四次网关运行的 hook 落盘全空，但**"没落盘"不等于"没触发"**——见验证报告 §8.6，
> 判据是**给 hook 命令行配一条手工自检**。）
> （仍然成立的教训：先前那次"已完成（含真实载荷捕获）"确实是**把"配置格式已捕获"当成了"载荷已捕获"**——
> 但那句批评的对象是**当时**的状态，不是把这条结论**永久**钉死；真机一跑就翻了。）

**结论：hook 可行，且是 codex 子智能体的唯一实用通道。以下是全部实测结果。**

**① 配置格式（TOML，`config.toml`）**

```toml
[[hooks.SessionStart]]            # 事件名 PascalCase；数组（matcher group）
matcher = ""                      # UserPromptSubmit / SessionStart / SubagentStop 不支持 matcher
  [[hooks.SessionStart.hooks]]    # 内层 hooks 数组
  type = "command"
  command = "node <absolute path>/hook.cjs"
```

- **事件名是 PascalCase**：实测 `hooks.SessionStart` **触发**、`hooks.session-start` **不触发**
  （kebab-case 只出现在插件 `hooks.json` 那份配置里，见下）；
- **SDK 可注入**：SDK 把 `config` 平铺成 `--config key=value`，所以
  `config: { hooks: { SubagentStart: [{ matcher: '', hooks: [{ type: 'command', command }] }] } }`
  会变成 `--config hooks.SubagentStart=[{...}]`——**dotted path + TOML 数组字面量**，正好落在同一张表上。

**② 事件清单（11 个，二进制枚举与文档逐字一致）**

`PreToolUse` · `PermissionRequest` · `PostToolUse` · `PreCompact` · `PostCompact` ·
`SessionStart` · `SessionEnd` · `UserPromptSubmit` · **`SubagentStart`** · **`SubagentStop`** ·
`Stop` · `Interrupt`

**③ 实测捕获的真实载荷（逐字）**

```jsonc
// SessionStart
{ "session_id": "…", "transcript_path": "…/sessions/2026/09/30/rollout-….jsonl",
  "cwd": "…", "hook_event_name": "SessionStart", "model": "GPT-5.5",
  "permission_mode": "bypassPermissions", "source": "startup" }

// PreToolUse
{ "session_id": "…", "turn_id": "…", "transcript_path": "…",
  "cwd": "…", "hook_event_name": "PreToolUse", "model": "GPT-5.5",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_input": { "command": "Get-Content -Raw C:/…/SKILL.md" },
  "tool_use_id": "call_hAvZf74pquDI6WwhxDooQ2oO" }
```

**④ `SubagentStart` 输入 schema（二进制内嵌 JSON Schema，逐字）**

```jsonc
{ "required": ["agent_id","agent_type","cwd","hook_event_name","model",
               "permission_mode","session_id","transcript_path","turn_id"],
  "properties": {
    "agent_id": "string", "agent_type": "string", "cwd": "string",
    "hook_event_name": { "const": "SubagentStart" }, "model": "string",
    "permission_mode": { "enum": ["default","acceptEdits","plan","dontAsk","bypassPermissions"] },
    "session_id": "string", "transcript_path": "string|null",
    "turn_id": "string  // Codex extension: expose the active turn id to internal turn-scoped hooks" } }
```

**⑤ `SubagentStop` 输入 schema（同上来源）**

在 `SubagentStart` 全部字段之外**多三个**（2026-10-01 真机更正：初稿写"多两个"，**漏了 `stop_hook_active`**）：

```jsonc
{ "agent_transcript_path": "string|null",      // 子智能体自己的 transcript（真机给了绝对路径）
  "stop_hook_active": false,                   // ← **只在运行时载荷里出现，schema 未列**
  "last_assistant_message": "string|null" }    // 子智能体的最终答复（真机："2"）
```

⇒ **`subagent-end` 的 `outcome` 有直接来源**（`last_assistant_message`），
且**需要更细的细节时可按 `agent_transcript_path` 读子会话**（可选，不必需）。

**⑥ 钩子输出契约**（`SubagentStart` / `SubagentStop` 的 `.output` schema）
通用四格：`continue`（默认 true）· `suppressOutput` · `stopReason` · `systemMessage`；
`hookSpecificOutput.additionalContext` 可**向模型注入上下文**。
退出码语义：`SubagentStop` **退出码 2** = 把 stderr 当作 continuation prompt
（`SubagentStop hook exited with code 2 but did not write a continuation prompt to stderr`）。
**我们只用它做只读观测**：命令读完 stdin、写自己的落盘物、返回 0，不注入、不阻断。

**⑦ 信任闸门——本方案唯一的硬障碍（实测）**

| 实测 | 结果 |
|---|---|
| 配置合法、但**不带** `--dangerously-bypass-hook-trust` | **hook 不执行**（turn 正常完成，无任何 hook 相关输出） |
| 带 `--dangerously-bypass-hook-trust` | **hook 执行**，载荷完整捕获 |
| 带该标志时的告警 | `` `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation. `` |
| 是否落盘信任状态 | **没有**——`CODEX_HOME` 下无任何 hook 信任文件；信任态在全局 SQLite（`app-server`）里，按 per-row `CODEX_HOME` 隔离时本就取不到 |

相关串：`New hook - review required` · `Trusted` · `Modified since last trusted - review required` ·
`Hooks can run outside the sandbox after you trust them` · `HookStateToml { enabled, trusted_hash }`。

⇒ **信任是硬闸门，且无法通过配置文件绕过。**

**⑧ SDK 传不通这个标志（源码确认）**

SDK 的 `commandArgs` 从 `["exec","--experimental-json"]` 起，后续**全部是固定白名单**
（`--config` / `--model` / `--sandbox` / `--cd` / `--output-schema` / …），
**没有任意 flag 透传口**。`CodexOptions` 只有 `codexPathOverride` / `baseUrl` / `apiKey` /
`config` / `configOverrides` / `env`。

⇒ **采用 `codexPathOverride` + 一层薄启动器**（唯一干净可行的落法）：

```ts
// 适配器侧
new Codex({
  codexPathOverride: <生成到该行 scratchDir 的启动器>,
  apiKey, baseUrl, config: { …既有 config…, hooks: { SubagentStart: [...], SubagentStop: [...] } },
  env,
})
```

启动器的职责**只有一件**：把 `--dangerously-bypass-hook-trust` 追加到 argv 再 exec 真正的
`codex` 二进制。**不解析、不改写、不转发 stdout**——仍完全走 SDK 的事件流（§7.0），
`codexPathOverride` 本身就是 SDK 公开支持的入口，所以不违反「不直接操作厂商 CLI」的边界。
Windows 上按平台决定 `.cmd` / `sh` 形态，且需落在该行 scratchDir（`dispose()` 已负责回收）。

**⑨ `SubagentStart` 不携带任务名（对 §6 的直接影响）**

`required` 里**没有**任何任务名 / 描述 / prompt 字段——只有 `agent_id` 与 `agent_type`。
⇒ **`subagent-start` 的 `name` 不能来自 hook**，只能：

- 从**父消息的 `spawn_agent` 工具调用**关联（`tool-call` 块的 `input` 里有任务描述），
  按 `subagentId` ↔ `callId` 交叉引用；
- 或取 `agent_type`（角色名，如 `~/.codex/agents/` 里定义的角色）。

**规范据此定：`subagent-start.name` 允许为 `null`；能关联到 spawn 调用时用该调用的任务描述，
否则用 `agent_type`。** 这是 §6.2 必填性口径的具体落点。

**⑩ 验证进展（2026-10-01 定稿：**两条 hook 都抓到了**）**

用 §7.5.3 更正 3 的**本机模型名中转**（`gpt-6-astra → gt-6-as-a`），
codex 0.154.0 的 `spawn_agent` **真的跑起来了**，hook **真的触发**：

- ✅ **`SubagentStart` 真实载荷已抓到**（逐字见 [验证报告](../notes/2026-09-30-agent-message-spec-verification.md)）：④ 的必填字段**逐字吻合**，
  实测值 `agent_type: "default"`、`transcript_path` **非 null**；
  ⑨「没有任何任务名/描述字段」**再次确证**——载荷里只有 `agent_id` + `agent_type`；
  ⑦ 的信任闸门也吻合（不带 `--dangerously-bypass-hook-trust` 就不执行）。
- ✅ **`SubagentStop` 也抓到了（2026-10-01，DeepSeek 路由）**——0.154.0 与 0.156.1 **各触发 1 次**，
  逐字载荷见 §6.4 开头的升级块：**12 字段、确证没有 `status`**，
  且**比 `SubagentStart` 多三个字段**（⑤ 初稿只写了两个，漏 `stop_hook_active`）。
  ⇒ 上一轮那句「`SubagentStop` 仍未抓到、只差一个能跑通的上游模型」**已关闭**：
  **不需要模型预设带 profile**——本轮用 codex **不认识**的模型名（落 fallback 元数据）也跑通了，
  详见下面那条对 §7.5.2 的限定。
- ⚠️ **一条方法学补记（防误判，值得抄进探测脚本）**：探测者第一版把日志器路径少写了一层，
  三格全是 0 载荷，**差点得出"hook 不触发"**；现在脚本带**手工自检**——拿合成载荷喂同一条命令行、
  确认落盘。同一次运行的 `SessionStart` 1 条 + `UserPromptSubmit` 2 条就是**机制对照**
  （证明配置被接受、闸门已开、命令真被执行）。

> ### ⚠️ 对 §7.5.2 根因结论的**限定**（2026-10-01，**同日追加轮再修正一次**）
>
> §7.5.2 的五步穷举得出「`spawn_agent` 需要模型预设自带 `multi_agent` profile，本仓无解、只能等网关」。
> 当天先在 DeepSeek 路由上观察到它能跑：`features: { multi_agent: true }` + `deepseek-chat`
> （codex **不认识**这个名字 ⇒ 落 fallback 元数据），完整走完 `spawn_agent → wait → close_agent`，
> `agents_states` 从 `pending_init` 变成 `{"status":"completed","message":"1+1 = 2"}`
> —— **子智能体真的算了 1+1**（不是空壳调用）。
>
> **但追加轮在 VPN 恢复后回到内网网关（= 适配器真实路径）复跑，口径必须收敛成更弱的那个**：
>
> | 路径 | `features.multi_agent=true` 下的结果 |
> |---|---|
> | **内网网关** + `gt-6-as-a`（同样 fallback 元数据） | ❌ 模型自述逐字：**`unsupported call: spawn_agent`** |
> | **内网网关** + `gpt-5.6-sol`（codex 认识、`multi_agent` 为 `null`） | ❌ turn 直接失败（`tool_choice` 网关错误），连模型的话都没出来 |
> | **DeepSeek 路由** + `deepseek-chat`（同样 fallback 元数据） | ✅ 跑通（见上） |
>
> ⇒ **"认不认识模型名"不是决定因素**（两边都是 fallback 元数据，结果相反）；
> **§7.5.2 的结论对它自己的那条路径（内网网关）依然成立**。
> 准确措辞：**「结论与路由相关；DeepSeek 路由是目前唯一观测到的例外，机制未定」**——
> **不是**"本仓无解已被推翻"。
>
> 同一轮钉死了"执行器由什么决定"的一半：`codex debug models` 逐模型解析（本地、0 调用）显示，
> 本机 **0.154.0 的 11 个模型里只有 `gpt-6-astra` 一个**在 **`model_messages.multi_agent`** 上带 profile
> （`gpt-5.6-sol`/`-terra`/`-luna`、`gpt-daybreak-blue/red-latest`、`gpt-5.5`/`5.4`/`5.4-mini`/`5.2`、
> `codex-auto-review` **全是 `null`**）。⚠️ 落点是 **`model_messages.multi_agent`**（不是顶层——
> 顶层根本没有这个键），且**每个模型都有这个键**，区别只在值是 `null` 还是对象。

> 附：`task_notification` 在 0.156.1 里**不存在**（二进制全量字符串计数 0），
> 实际存在的是 `subagent_notification`（上下文注入项）与上面两条通道。

### 7.6 内置工具的数据规范化（统一 UI 渲染契约）

> **本节经一次目标重写**：初稿的目标是"给工具分类"（`ToolKind` 单轴 → 两轴）。
> 那个目标**不够**——分类只能回答"这是什么工具"，回答不了"UI 怎么画一个工具调用"。
> 重写后的目标是：**为常用工具定义统一的 structure，让同一份 UI 渲染代码能吃下三家的调用与结果。**

#### 7.6.0 目标与边界

**目标**：定义一组**工具族（tool family）**，每族给出统一的 `args` 与 `result` 结构。
UI 只按 `family` 分支（10 个），**不再按厂商分支**（27 + 24 + 13 个工具名）。

**为什么归类解决不了渲染问题**：`Bash`(cc) / `pwsh`(dsh) / `exec_command`(codex) 都是
`execute/shell`，但三家的 arguments 字段名不同（`command` vs `cmd`）、result 形状也不同
（cc 是文本、codex 是 `{aggregated_output, exit_code, status}`）。
**只有把 args/result 也归一，UI 才不用写三个分支。**

**责任划分（关键设计决策）**：

| 层次 | 职责 | 理由 |
|---|---|---|
| **适配器**（`agents` 包） | 把**它自己那一家**的 args/result 归一成族结构 | 厂商细节（`cmd` vs `command`、`aggregated_output` 的 64 KiB 截断）**只有适配器知道**；放上游等于让消费方认识所有厂商 |
| **消费方**（`ui` / `client`） | 只读 `family` + 族结构渲染 | **一份渲染代码**，与厂商解耦 |

**降级**：适配器不认识某个工具时，`family: null`，UI 回退到「通用渲染」
（`name` + `inputText` + 文本结果）。**规范化是可选的增收，不是必填的负担**——
这与 §7.6.0「未收录 ⇒ `null`」同一条口径。

**不放进 contracts 必填位的原因**：族结构是**派生视图**，`raw` 才是事实（§5.4）。
把它做成必填会逼适配器为不懂的工具编一个结构——那正是「看起来对齐了」的假象。

#### 7.6.1 选定归一化的工具族（**10 个**，覆盖实测高频）

按「**评测里真正会出现、且 UI 必须特殊渲染**」筛出来的 10 族。依据是三家工具清单
（[清单证据](../notes/2026-09-30-agent-builtin-tools-inventory.md)）与真实运行观察：

| family | 覆盖的工具 | UI 为什么需要特殊渲染 |
|---|---|---|
| `read-file` | `Read`(cc) · `read`(dsh) | 行号 + 范围高亮 |
| `write-file` | `Write`(cc) · `write`(dsh) | 新建/覆盖 + 字节数 |
| `edit-file` | `Edit`·`NotebookEdit`(cc) · `edit`(dsh) | **前后对照 diff** |
| `search-content` | `Grep`(cc) · `grep`(dsh) | 按文件分组 + 命中行 |
| `list-files` | `Glob`(cc) · `glob`(dsh) | 路径列表 + 计数 |
| `run-shell` | `Bash`(cc) · `pwsh`(dsh) · `exec_command`(codex) | **终端块 + 退出码** |
| `web-search` | `WebSearch`(cc) · `web_search`(dsh·codex) | 结果链接列表（**本仓三家统一禁用 ⇒ 恒空**，见 §7.9） |

> **⚠️ `web-search` 的"三家同名 ✅"有前提（2026-09-30 补，独立审查指出；当天已定案）**：
> 这一族的可得性**由本仓自己的配置决定**，不是三家天然都开：
> · codex 硬编码 **`tools.web_search: false`**（`providers/codex/sdk.ts`）；
> · claude 对**非 Claude 模型**禁用 `WebSearch`（`providers/claude-code/index.ts` 的
>   `NON_CLAUDE_DISALLOWED_TOOLS`）。
>
> ⇒ 标注"三家同名"容易读成"三家都可比"。**处置已定（D16）**：
> **三家统一禁用**（claude 改为无条件禁用、dsh 也关掉 `web_search`），**该族在本仓恒空**——
> 完整理由与三处落点见 **§7.9**（一句话：`web_search` 只有 claude / gpt 系模型支持，
> 属**模型差异**，D12 式的"统一打开"在这里做不到）。
| `spawn-agent` | `Task`(cc) · `subagent`(dsh) · `spawn_agent`(codex) | 子任务卡片（联动 §6） |
| **`task`** | `TaskCreate`·`TaskUpdate`·`TaskGet`·`TaskList`(cc，需开 `CLAUDE_CODE_ENABLE_TODO_TOOLS`) · `todo_write`(dsh) · `update_plan`(codex，需开配置) | **状态化清单面板**（多次调用 ⇒ 一张清单，§7.6.2 ⑨） |
| **`ask-user`** | `AskUserQuestion`(cc) · `ask_user_question`(dsh) · `request_user_input`(codex，需开配置) | **问答卡片 + 七种收场**（§7.6.2 ⑩，**三家同源 schema**） |

**`task` 与 `ask-user` 是用户指定必须仔细设计的两族**，理由分别是：
前者是**状态化渲染**（不能用"一次调用一张卡片"的模式），后者**会阻塞 turn**
（在无人值守评测里是挂起风险点——**实测三家机制不同**，见 §7.6.2 ⑩）。
两族的结构设计见 §7.6.2 ⑨ / ⑩。

> **⚠️ 目标修正（2026-09-30 用户口径）**：初稿把 `todo` 当作"三家对齐的任务面板"，
> **这是错的**——claude 侧**没有** `TodoWrite`（本机 27 个工具里没有），
> 而它的 `Task*` 是**另一种东西**（工作项注册表，§7.6.2.1）。
> ⇒ `task` 族**只有 dsh 与 codex 两家**，且**它不是"任务面板"的载体**。
> 「任务面板」的归一另立模型，见 **§7.6.2.2**。

**其余工具统一走「通用渲染」**，不单独设族（`goal`·`worktree`·`skill`·`stop`·`wait`·
`query`·`resume`·`deliver` 等）：它们出现频次低、且 UI 用「工具名 + 摘要 + 文本结果」
已经够用。**族是可扩展的**，将来某个工具调用变多再收编。

#### 7.6.2 族结构定义（args + result）

共通字段（所有族都有）：

```ts
/** 归一化结果。**适配器产出；不认识就 family: null** */
export type ToolData =
  | { family: 'read-file';      args: ReadFileArgs;      result: ReadFileResult | null }
  | { family: 'write-file';     args: WriteFileArgs;     result: WriteFileResult | null }
  | { family: 'edit-file';      args: EditFileArgs;      result: EditFileResult | null }
  | { family: 'search-content'; args: SearchContentArgs; result: SearchContentResult | null }
  | { family: 'list-files';     args: ListFilesArgs;     result: ListFilesResult | null }
  | { family: 'run-shell';      args: RunShellArgs;      result: RunShellResult | null }
  | { family: 'web-search';     args: WebSearchArgs;     result: WebSearchResult | null }
  | { family: 'spawn-agent';    args: SpawnAgentArgs;    result: SpawnAgentResult | null }
  | { family: 'task';           args: TaskListArgs;          result: TaskListResult | null }
  | { family: 'ask-user'; args: AskUserArgs; result: AskUserResult | null }
  | { family: null };                                    // 通用渲染

/** 每一族的 result 都带它，避免每个 result 重复定义 */
interface ResultBase {
  ok: boolean;                  // 工具是否成功（**不是** turn 的成功）
  truncated: boolean;           // 结果是否被截断（三家的截断口径见 §7.6.3）
  raw: string | null;           // 该工具结果的原始载荷（§5.4 的 block.raw）
}
```

**① `read-file`**

```ts
interface ReadFileArgs { path: string; offset: number | null; limit: number | null; }
interface ReadFileResult extends ResultBase {
  content: string;                    // 文本内容（图片/PDF 时为空串）
  lineCount: number | null;           // 拿到行数时给；拿不到 null
  lineNumbersIncluded: boolean;       // 内容里是否**已经带了行号**（见下）
  kind: 'text' | 'image' | 'pdf' | 'notebook' | 'unknown';
  mediaType: string | null;           // 图片/PDF 的 mime
  bytes: number | null;
}
```

> ⚠️ `lineNumbersIncluded` 是**必须的**：claude 的 `Read` 返回内容里**带 `cat -n` 风格行号**
> 且前置/后置 `<system-reminder>`；dsh 的 `read` 返回**带行号的结果**（工具描述逐字：
> "Results include line numbers"）。⇒ 若 UI 再叠一次行号就会**双重编号**。
> 该字段让 UI 知道"能不能自己编号"。

**② `write-file`**

```ts
interface WriteFileArgs { path: string; content: string; }
interface WriteFileResult extends ResultBase { path: string; bytes: number | null; created: boolean | null; }
```

**③ `edit-file`**（UI 最需要的一族——前后对照）

```ts
interface EditFileArgs {
  path: string;
  edits: Array<{ oldText: string | null; newText: string | null; replaceAll: boolean | null }>;
}
interface EditFileResult extends ResultBase {
  path: string;
  applied: number | null;             // 成功应用了几处
  replacements: number | null;        // 总替换次数
  diff: string | null;                // 厂商给了 diff 就用它（比我们自己算准）
}
```

**④ `search-content`**

```ts
interface SearchContentArgs {
  pattern: string;
  path: string | null;                // 搜索根
  include: string | null;             // 文件过滤（glob）
  caseInsensitive: boolean | null;
}
interface SearchContentResult extends ResultBase {
  matches: Array<{ file: string; line: number | null; text: string }>;
  fileCount: number | null;
  matchCount: number | null;
  mode: 'content' | 'files-with-matches' | 'count' | null;   // 输出模式（见下）
}
```

> `mode` 的用处：dsh 的 `grep` 描述提到「Returns the first 250 matches inline; a capped result
> reports where the complete match list was saved」——**它的结果可能是「命中在另一个文件里」**，
> 与"命中就在这条结果里"是两种渲染。`mode` + `truncated` 一起决定 UI 是列命中还是给路径。

**⑤ `list-files`**

```ts
interface ListFilesArgs { pattern: string; path: string | null; }
interface ListFilesResult extends ResultBase { files: string[]; count: number | null; }
```

**⑥ `run-shell`**（codex 的形状最完整，作为基准）

```ts
interface RunShellArgs {
  command: string;
  cwd: string | null;
  timeoutMs: number | null;           // codex 的 pwsh 有 timeout_ms（实测参数）
}
interface RunShellResult extends ResultBase {
  stdout: string;                     // 合并输出（三家都只给合并后的）
  exitCode: number | null;            // 拿不到就是 null（**不填 0**）
  status: 'completed' | 'failed' | 'running' | 'unknown';
  outputPath: string | null;          // 长输出被存到文件时的路径（见下）
}
```

> `outputPath` 的用处：claude 的长输出「saved to a file and Claude receives a short preview
> plus the path」（`taskOutputMaxChars` 的说明逐字）；dsh 的长输出
> 「full output is saved to a file whose path is reported」。⇒ 两家都可能**只给路径**，
> UI 需要据此渲染「输出在文件里」而不是「输出就是这些」。

**⑦ `web-search`**

```ts
interface WebSearchArgs { query: string; }
interface WebSearchResult extends ResultBase {
  results: Array<{ title: string | null; url: string; snippet: string | null }>;
  answer: string | null;              // 有的家给一句总结
}
```

**⑧ `spawn-agent`**

```ts
interface SpawnAgentArgs {
  prompt: string | null;              // 派给子任务的任务描述
  agentType: string | null;
  forkTurns: 'none' | 'all' | null;   // codex 的 fork_turns
  model: string | null;               // codex 允许指定子模型
}
interface SpawnAgentResult extends ResultBase {
  subagentId: string | null;          // 关联 §6 的 subagent-start/end
  vendorId: string | null;
  outcome: string | null;             // 子任务最终答复摘要
}
```

**⑨ `task`**（用户口径补充：todo 类需仔细设计）

**真机验证（2026-09-30，走真实适配器跑通一次 dsh）**——`todo_write` 的真实形状已拿到：

```jsonc
// tool/call（dsh 的 arguments 是 **JSON 字符串**，需 parse）
{ "turn":1, "step":1, "callId":"call_c2a5405622cc490f803bd59f", "name":"todo_write",
  "arguments":"{\"todos\": [{\"content\": \"Locate notes.txt in the workspace\", \"status\": \"in_progress\"}, …]}" }

// tool/result
{ "role":"tool", "toolCallId":"call_…", "isError":false,
  "content":[{"type":"text","text":"Updated todo list: 2 pending, 1 in progress, 0 completed."}] }
```

**三条实测确认**：
1. **确实是整表覆盖**——同一次运行里连发 3 次 `todo_write`，每次的 `todos[]` 都是**完整 3 项**
   （第一次 1 in_progress，第二次 1 completed/1 in_progress，第三次 3 completed）
   ⇒ §7.6.2 ⑨ 的 `commitModel: 'replace-whole-list'` **实测成立**；
2. **结果只有一句人话摘要**（`Updated todo list: N pending, …`），**没有结构化步骤数组**
   ⇒ 适配器**必须从 `arguments` 读步骤**，不能指望 result 给出清单；
3. `content[].type` 目前只见到 `text`。

```ts
interface TaskListArgs { /* 无参数：计划是整表提交，见下 */ }
interface TaskStep {
  id: string | null;                  // 厂商给了稳定 id 就用（claude 的 taskId）；否则 null  text: string;                       // 这一步做什么（= claude 的 subject / dsh 的 content / codex 的 step）
  status: 'pending' | 'in_progress' | 'completed' | 'unknown';
  // ── 以下两格**只有 claude 有**（用户口径 2026-09-30：需要）──
  /** 这一项被指派给谁（claude 的 `owner`，值是一个 agent 名）；另两家恒 null */
  owner: string | null;
  /**
   * 依赖：这一项**被谁阻塞**（claude 的 `addBlockedBy` / `TaskGet` 返回的 `blockedBy`），
   * 值是**其它 TaskStep 的 id**。另两家恒 null。
   * 为什么只收 `blockedBy` 而不收 `blocks`：两者互为反向边，**冗余**——
   * 存两份就有「两份不一致」的可能，而 UI 需要的是「这一项现在能不能开工」。
   */
  blockedBy: string[];
}
interface TaskListResult extends ResultBase {
  steps: TaskStep[];                  // **该次调用后"整张清单"的完整状态**（见下）
  commitModel: 'replace-whole-list' | 'patch-one-item';
  // 计数是派生值，放这里是为了 UI 不必自己算
  counts: { pending: number; inProgress: number; completed: number };
}
```

**`owner` / `blockedBy` 的缺失口径**：另两家把 `owner` 写成 `null`、`blockedBy` 写成 `[]`。
**注意这里的取值不是"没采到"而是"厂商没有这个概念"**——按 §4 的口径属 `not-supported`；
若 UI 要显示"未指派"，需区分 `null`（该家无此概念）与 `''`（有概念但没指派给谁）。
claude 侧的 `owner` 空值是 **`''`**（工具描述逐字："`owner`: Agent ID if assigned, **empty if available**"），
所以两者**在实现上必须分开**：`null` = 该家不支持，`''` = 支持但当前无人认领。

**`steps` 必须是"整张清单"而不是"本次变更"**——这是本族最重要的归一决策。
理由是**两家语义完全不同**（实测）：

| 家 | 工具 | 语义（描述逐字） | 默认可用？ |
|---|---|---|---|
| dsh | `todo_write` | 「Send the **ENTIRE list** every call — it **REPLACES** the previous list（there are no partial updates, no per-item edits）」 | ✅ 常驻（24 个工具之一） |
| codex | `update_plan` | 「Updates the task plan. Provide an optional explanation and a list of plan items, **each with a step and status**. **At most one step can be in_progress at a time**」 | ❌ **默认关闭**，见下 |
| claude | `TodoWrite`※ | **本机 27 个工具里没有**；SDK 只有 TUI 开关 `todoFeatureEnabled`（"Enable the todo / task tracking panel"） | ❌ 未出现在工具表 |

**codex 的 `update_plan` 是被配置门控的（本次实测确认）**：它的配置键是
**`tools.update_plan.enabled`**（与 `features.*` 是两套）。A/B 实测：

- **不设该键** ⇒ 入站 `tools[]` 里**没有** `update_plan`（实测工具表：
  `exec_command, write_stdin, request_user_input, view_image, multi_agent_v1, get_goal, create_goal, update_goal, web_search`）；
- **设 `tools.update_plan.enabled=true`** ⇒ `update_plan` **出现在 `write_stdin` 之后**（实测）。

⇒ **本仓只要加一行 config 就能给 codex 打开计划工具**，且它同样是**整表提交**
（「a list of plan items, each with a step and status」）——**与 dsh 的 `todo_write` 语义对齐**，
不需要 `commitModel` 的补丁分支去兼容它。

**另一条必须登记的语义**（二进制内嵌文案逐字）：
`update_plan is a TODO/checklist tool and is not allowed in Plan mode`
——**codex 的 Plan mode 与本工具互斥**。这与 `request_user_input`（"only available in Plan mode"）
正好相反，两者**不可能同时出现**在同一个 mode 下。

⇒ 若把"本次变更"当作 `steps` 的语义，dsh/codex 的整表提交与任何补丁式更新就无法对齐；
定义成"整表状态"则两家都成立，而**"本次改了哪几项"可以由 UI 做与上一条的差分**得到。

**claude 的结论（2026-09-30 实测更正）**：claude 侧**有**任务数据，但它**是另一种更新模型**——
`Task*` 是**逐条 patch**（§7.6.2.1c 的实测 schema），不是整表提交。
所以本族**同时保留两种 `commitModel`**，并**在适配器侧都收敛成"整表 `steps`"**：

| `commitModel` | 谁 | 适配器要做什么 |
|---|---|---|
| `'replace-whole-list'` | dsh `todo_write` · codex `update_plan` | 原样搬运（本来就是整表） |
| `'patch-one-item'` | claude `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` | **累积**成整表后交出：适配器维护 `taskId → TaskStep` 的映射，按 `TaskCreate` 插入、按 `TaskUpdate` 覆盖、`TaskList`/`TaskGet` 的结果用于**校对**（`status: 'deleted'` ⇒ 从表里**移除**） |

> **⚠️ `id` 从哪来还没定（2026-09-30，见 §11.1 第 27 项）**：上面写的"按 `TaskCreate` 插入"
> **缺一环**——`TaskCreate` 的输入是 `{subject, description, activeForm?, metadata?}`，
> **里面没有 `taskId`**（§7.6.2.1c 的实测 schema）。而 `TaskStep.id` 要靠它、`blockedBy` 又要靠 `id` 解析。
>
> 候选来源：① `TaskCreate` 的 **result**（形状**未登记**，需真机）；② `TaskCreated` **hook**
> （存在，但本节的累积配方**没有用它**）；③ 由适配器**自己发号**（与 §4「不编」冲突，最差）。
> ⇒ **在定案前，claude 侧的 `blockedBy` 无法解析**——"依赖"这个维度会**落空**。
> 需真机看一次 `TaskCreate` 的返回，才能把这一格补实。

**`commitModel` 的作用**：它告诉 UI/持久化层这条结果是「可独立成立的全量快照」
还是「必须与既有状态合并的补丁」。**补丁合并是适配器职责**（与 §7.6.0 的责任划分一致）：
适配器必须**累积**后交出整表，**不允许把补丁原样抛给 UI**——否则 UI 又要为 claude 单独写一套增量渲染，
正好违背本族"统一渲染代码"的目标。

⇒ **因此 `task` 族三家都有数据**（claude 需开 `CLAUDE_CODE_ENABLE_TODO_TOOLS`），
`TaskStep.status` 对 claude 的 `deleted` **不做取值映射**（它不是三种状态之一）——
按上面的规则**直接从 `steps` 里移除**，语义与"移除"一致。

#### 7.6.2.1 专题调研：claude 的 `Task*` 能否代替 todo？（结论：**不能**）

**问题**（用户提出）：`TaskUpdate` 是否可以代替 todo，甚至废弃 todo？

**结论：不能。二者是两种不同的东西**，证据来自 SDK 类型定义的逐字字段：

| 维度 | claude `Task*` | todo（`todo_write` / `update_plan`） |
|---|---|---|
| 数据模型 | **工作项注册表**：每项有 `task_id` + `task_subject` + `task_description` | **进度清单**：一次提交**整张**步骤列表 |
| 更新方式 | **patch 式**（`SDKTaskUpdatedMessage.patch`：只带变更字段，注释逐字「Clients **merge** into their local task map」） | **整表覆盖**（"REPLACES the previous list"） |
| 是否有"队友"概念 | ✅ **有**：`TaskCreatedHookInput.teammate_name` / `team_name`（注释：「Sessions have a single implicit team」） | ❌ 无 |
| 是否覆盖子智能体 | ✅ **是**：`subagent_type`（"Subagent type for **Task tool subagents**"）、`spawn_depth`（子智能体嵌套深度） | ❌ 无（那是 §6 的 subagent 域） |
| 是否覆盖后台 shell | ✅ **是**：`is_backgrounded`（"Whether the task was registered in the background"） | ❌ 无 |
| 生命周期事件 | `TaskCreated` / `TaskCompleted` hook + `Query.stopTask()` 控制面 | 无独立事件，只有工具调用本身 |
| 用途 | **运行时调度**：谁在跑、跑多深、归哪个 teammate、停谁 | **意图表达**：我打算做哪几步、现在到哪一步 |

**判据**：`Task*` 回答的是「**现在有什么在跑**」（运行时状态，patch 语义、可归属 teammate、
可嵌套），todo 回答的是「**agent 打算做什么**」（声明式意图，整表语义）。
**一个不能表达另一个**：用 `TaskUpdate` 表达不了"整张清单"（它是逐项 patch），
用 todo 表达不了"哪个子智能体嵌套在第几层"。

⇒ **两者都要保留，且分属不同族**（这也是 §7.6.8 把 `Task*` 归 `job`、
`todo_write`/`update_plan` 归 `task` 的原因）。

**顺带解决的一个疑点**：SDK 的 `todoFeatureEnabled`（"Enable the **todo / task tracking panel**"）
把 todo 与 task **并列**，容易读成"两者是一回事"。实际它是 **TUI 开关**（与
`terminalProgressBarEnabled`、`showTurnDuration` 同一组设置），管的是**面板显示**，
不是工具的语义归属——**不要据此把两个族合并**。

**仍需真机确认**（§11 开放问题 12）：claude 的 `TodoWrite` 在**本机这套非交互 SDK 配置**的入站工具表里
**不存在**（30 项，逐字见 §9.3），所以 claude 侧当前**没有 todo 数据**。
**2026-10-01 补两条判据**：① 打包 `claude.exe` 里 `TodoWrite` 有 **18 处**字符串命中
⇒ 它是**mode/feature 门控**，**不是"这家没有"**（能力位应记 `'off-by-adapter'` / `'unverified'`，**不是 `'no'`**）；
② 它**不随任何已知开关出现**（3 模型 × 2 档 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 共 6 次采集，增量恒为空）。
**仍未验证**的是：它是否在**交互式会话**或**别的 plan / 模型预设**下出现——本机没有那条采集路径。

#### 7.6.2.1b claude 的 Task / Todo 工具为何不在工具表里（**已查清，用户提供**）

**根因：这是一次产品演进 + 一次按模型的裁剪，两者叠加。**

| 阶段 | 事实 |
|---|---|
| 演进 | 自 **TypeScript Agent SDK 0.3.142 / Claude Code v2.1.142** 起，claude 把**默认任务工具从 `TodoWrite` 换成了 `Task*`（TaskCreate/TaskUpdate/TaskGet/TaskList）** |
| 裁剪 | 在 **Opus 4.8、Sonnet 5 等较新模型**上，**任务跟踪工具（含 `TodoWrite`）不再默认包含**在工具集里 |
| 官方理由 | Anthropic 认为**新模型在没有显式清单的情况下也能很好地跟踪多步工作**，而**工具定义会占用上下文** |
| **启用方式** | 环境变量 **`CLAUDE_CODE_ENABLE_TODO_TOOLS`** |

```ts
for await (const message of query({
  prompt: "优化我的 React 应用性能并用任务跟踪进度",
  options: { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } }
})) { /* … */ }
```

**⇒ 对本规范的三条影响：**

**A/B 实测（本机 claude 2.1.281，同一二进制，只切该环境变量；抓的是入站 `/v1/messages` 的 `tools[]`）**：

| | toolCount | 新增 | 移除 |
|---|---|---|---|
| 默认（不开开关） | **26** | — | — |
| `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | **30** | **`TaskCreate` · `TaskGet` · `TaskList` · `TaskUpdate`** | 无 |

> ### ⚠️ 这张 A/B **在 2026-09-30 的验证轮里不重现**
>
> 同一个 CLI 版本（**2.1.281**，与本节采集时同版本）、**三个模型**
> （`Claude-Sonnet-4.6` / `claude-haiku-4-5` / `Claude-Opus-4.8`）× 两档开关，
> 共 6 次采集（`system/init` 与**入站 `tools[]`** 两处都看了）：
> **默认就是 30 项、开了仍是 30 项、增量恒为空数组**。
>
> | 模型 | 默认 | 开开关 | 新增 | 移除 |
> |---|---|---|---|---|
> | `Claude-Sonnet-4.6` | 30 | 30 | — | — |
> | `claude-haiku-4-5` | 30 | 30 | — | — |
> | `Claude-Opus-4.8` | 30 | 30 | — | — |
>
> ⇒ 结论改成：**`Task*` 在当前版本上已经是默认工具**；
> `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 变成**冗余的护栏**（留着无害，但**不能再当成"打开任务工具"的开关**）。
> D12「统一打开」的**目标仍然成立**（三家一致地不额外配置也能有规划数据），
> 但理由要从"不开就没有"改成"**开着以防版本回退**"。
>
> 仍然成立的部分：**`TodoWrite` 不在**、**`AskUserQuestion` 也不在**，
> 且这两者都**不因这个开关出现**（见 §11 第 11 / 16 项的更新）。

> ### ⚠️ 但上一条更正本身也**只对 claude 模型名成立**（2026-10-01 复核，第三次修正）
>
> 换后端（DeepSeek 的 anthropic 兼容端点）重采入站 `tools[]`，同一个 CLI 2.1.283：
>
> | 模型 | 默认 | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | 增量 |
> |---|---|---|---|
> | **`deepseek-chat`** | **23** | **27** | **+ `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`** |
> | `claude-sonnet-4-5` | 27 | 27 | 无 |
>
> ⇒ **工具表是模型相关的**：DeepSeek 名下 TODO 工具**默认关、开关真的有效（+4）**；
> claude 模型名下**无增量**。**读这一节时必须带模型名**，否则"26→30"、"恒 30"、"23→27" 三个数
> 会看起来互相矛盾——它们其实是**三个不同模型名**下的读数。
>
> **同时更正一条工具名口径**（本轮新发现）：**入站 `tools[]` 里子智能体工具叫 `Agent`**
> （描述首句逐字 `Launch a new agent to handle complex, multi-step tasks.`），
> 而 `system/init` 的 `tools[]` 里叫 **`Task`**——同一件东西**两个名字**，
> 且 **`Task` 在入站表里根本不存在**。§7.6.8 两轴表写 `Task`(cc) 时**必须注明它取自 `system/init`**。
>
> ### ⚠️ 还有一处**没解释完**（2026-10-01 追加轮，如实登记）
>
> 把 09-30 那三个模型名（`Claude-Sonnet-4.6` / `claude-haiku-4-5` / `Claude-Opus-4.8`）在同一台机器上
> 用本机抓包逐字重跑，读数一律 **27→27**（请求到不了模型 ⇒ 与后端无关）。逐名 diff 的结果是：
>
> ```
> 今天的 27 = 09-30 的 30 − {Task, Monitor, PowerShell, PushNotification} + {Agent}
> ```
>
> · **`Task` → `Agent` 是改名**（上面的双名发现独立佐证）；
> · 我又从打包 exe 里把与这三个工具相关的 `CLAUDE_CODE_*` 候选变量捞出来逐个开，
>   **一个都没把 `Monitor` / `PushNotification` 带回来**。
>
> ⇒ **差异不止"模型名 + 环境开关"两个轴**（还应含 CLI/SDK 版本或那条采集的参数）。
> **本文如实登记为"未解释"**，不硬凑一个解释——这与 §7.6.2.1b 开头那句
> "工具表还受**模型 preset** 影响"是同一件事的两面：**这张表是多个变量的函数，别指望单一轴能解释它**。

**注意：`TodoWrite` 并未回来**——精确新增的就是那 4 个 `Task*` 工具，与「Task 工具**替代**了 TodoWrite」逐字吻合。
另注：这份实测工具表与 §7.1 的 27 项**不完全一致**（本表有 `Agent`/`Monitor`/`PowerShell`，
无 `Task`）——说明工具表还受**模型 preset** 影响，两次采集的 preset 不同；**判据以「同一次 A/B 的增量」为准**。

1. **本机工具表里没有它们不是版本过低**——是**按模型裁剪的默认值**
   （§11 开放问题 16 因此**收窄**：不是"claude 没有"，而是"没开"）。
   升级 SDK **不必然**让它们出现；**开环境变量才是开关**；
2. **`task` 族在 claude 侧是可得的**——只要在适配器的子进程环境里加
   `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。这与 §7.0.4 的注入通道同形
   （`buildSubprocessEnv` 的 `injected`），**不需要新的机制**；
3. **`Task*` 的语义维持 §7.6.2.1 的结论**（工作项注册表，**不是**整表清单）——
   下面的实测 schema 是这条结论的**确证**，并因此**改写了 `task` 族的归一方式**（§7.6.2 ⑨）。

#### 7.6.2.1c claude 的 `Task*` 实测 schema（决定了 `task` 族怎么归一）

抓自入站请求的 `input_schema`（逐字）：

| 工具 | 输入 | 关键语义 |
|---|---|---|
| `TaskCreate` | `{subject, description, activeForm?, metadata?}` | **一次只建一条**；"All tasks are created with status `pending`" |
| `TaskGet` | `{taskId}` | 返回**单条**全量：`subject`/`description`/`status`/`blocks`/`blockedBy` |
| `TaskList` | `{}`（**无参数**） | 返回**全部**任务的摘要：`id`/`subject`/`status`/`owner`/`blockedBy` |
| `TaskUpdate` | `{taskId, subject?, description?, activeForm?, status?, addBlocks?, addBlockedBy?, owner?, metadata?}` | **逐条 patch**；`status ∈ {pending, in_progress, completed}` **外加 `deleted`**（"permanently removes the task"） |

**三条必须写进规范的发现**：

1. **`Task*` 是「工作项注册表」，不是「进度清单」**——每条有自己的 id / owner / 依赖关系
   （`blocks` / `blockedBy`）、可被**指派**（`owner`）、可**删除**（`status: 'deleted'`）。
   `TodoWrite`/`todo_write`/`update_plan` 那套「整表覆盖」在这里**完全不存在**；
2. **状态值域不同**：claude 多一个 **`deleted`**（终端态，语义是"移除"而不是"完成"）——
   归一成 `TaskStep.status` 时**不能直接映射**（`deleted` 不是 `pending|in_progress|completed` 之一），
   需单独一档或直接**从清单里移除**；
3. **`owner` 与依赖是 claude 独有的维度**——另两家没有。UI 若要三家共渲染，
   这两格只能对 claude 显示（`null` 对另两家）——与 §4「缺就是缺」同口径。

> **推论已作废（2026-09-30 同日 A/B 推翻、2026-10-01 复核）**：初稿据"较新模型默认不带任务工具"
> 推出"默认配置下只剩 dsh 一家有数据"。**真机不重现**：同一 CLI 版本、三个模型 × 两档开关共 6 次采集，
> 工具表**默认就是 30 项、开开关仍是 30 项、增量恒为空**（§7.6.2.1b 的更正块）。
> ⇒ **`Task*` 在本版已是默认工具**，"三家可比"这一目标**默认就成立**，不依赖那个环境变量。
> 仍然成立的部分：`TodoWrite` 与 `AskUserQuestion` **确实不在**工具表里（且不受该开关影响），
> 但它们在**打包二进制里有字符串计数**（18 / 70 处）⇒ 是 **mode/feature 门控**，**不是"这家没有"**。
> 开关口径（D12）的**目标不变**（三家一致地不额外配置也能有规划数据），但理由从"不开就没有"
> 改为"**开着以防版本回退**"。

**⑩ `ask-user`**（用户口径补充：交互类需仔细设计；**三家都有，且 schema 高度同源**）

> **本节经调研重写**：初稿按 codex 一家设计（族名 `ask-user`）。
> 调研后发现 **cc 与 dsh 也有同一件事**，且三家 schema 几乎可以逐字段对齐
> ⇒ 族名改为 **`ask-user`**，结构按**三家并集**定义。

**三家工具（实测来源）**：

| 家 | 工具名 | 证据来源 |
|---|---|---|
| claude-code | **`AskUserQuestion`** | 打包 CLI 二进制（`claude.exe`）：`AskUserQuestion` 72 处、`multiSelect` 58 处 |
| dsh | **`ask_user_question`** | 专用包 `@deepseek-ai/dsh-tool-ask-user` 的 `lib/index.js`（完整 schema + README） |
| codex | `request_user_input` | 入站 wire `tools[]`（需开两个配置开关，见 §7.6.3） |

**三家 schema 对齐表（逐字段）**：

| 概念 | claude | dsh | codex | 规范取值 |
|---|---|---|---|---|
| 问题数组 | `questions[]` | `questions[]` | `questions[]` | `questions[]` |
| 稳定 id | `id`（"each with a stable id... echoed in the answer"） | `id`（"Stable id for this question; echoed in the answer"） | `id`（"Stable identifier for mapping answers (snake_case)"） | `id` |
| 问题正文 | `question`（"Should be clear, specific, and **end with a question mark**"） | `question` | `question` | `prompt` |
| 短标题 | `header`（"Very short label displayed as a chip/tag (max **8** chars)"） | `header`（"Optional short heading... such as \"Confirm\""） | `header`（"Short header label... (**12 or fewer chars**)"） | `header` |
| 选项 | `options[]`，**"Must have 2-4 options"** | `options[]`（可选） | `options[]`（"Provide **2-3** mutually exclusive choices"） | `options[]` |
| 选项标签 | `label` | `label`（"Short user-facing option label"） | `label`（"User-facing label (1-5 words)"） | `label` |
| 选项说明 | ✅ 有 | `description`（"One sentence explaining the tradeoff or impact"） | `description`（"One short sentence explaining impact/tradeoff"） | `description` |
| 推荐项 | 首位（"If you recommend one, put it first"） | 首位 + 追加 **"(Recommended)"** | 首位 + 追加 **"(Recommended)"** | `recommended: true` + UI 自理文案 |
| 多选 | `multiSelect` | `multi_select`（"Defaults to **false**"） | — （未见于 codex schema） | `multiSelect: boolean` |
| 自由输入 | — | `custom`（答案侧） | `isOther`（"the client will add a free-form \"Other\" option **automatically**"） | `allowOther: boolean` |
| 机密 | — | — | `isSecret` | `secret: boolean` |

**三家的约束值不同，规范取并集并记录**：`header` 上限 cc=8 / codex=12（**取更严的 8 作为 UI 建议**）；
选项数 cc=2–4 / codex=2–3（**2–4 为合法域**）；`multi_select` 默认 `false`。

**规范结构（三家并集）**：

```ts
interface AskUserQuestion {
  id: string;                          // 三家同名同义
  prompt: string;                      // = 三家的 `question`
  header: string | null;               // = 三家的 `header`（UI 建议 ≤8 字符）
  options: Array<{
    label: string;
    description: string | null;        // 三家都有，语义一致
    recommended: boolean;              // 三家都用"放首位 + 追加 (Recommended)"表达 ⇒ 规范化成布尔
  }>;
  multiSelect: boolean;                // = cc `multiSelect` / dsh `multi_select`（默认 false）
  allowOther: boolean;                 // = codex `isOther`；dsh 由 `custom` 答案侧表达
  secret: boolean;                     // = codex `isSecret`
}
interface AskUserArgs { questions: AskUserQuestion[]; }

interface AskUserAnswer {
  questionId: string;                  // = 三家的 `id`（回显）
  selected: string[];                  // = **标签数组**（dsh 逐字："`selected` holds the chosen option labels"）
  custom: string | null;               // 自由输入
}
interface AskUserResult extends ResultBase {
  answers: AskUserAnswer[];
  /** 本次交互的收场方式——本族的重点 */
  outcome: 'answered' | 'auto-resolved' | 'skipped' | 'timeout' | 'unavailable' | 'rejected' | 'canceled';
}
```

**答案形状以 dsh 为准（它的契约最明确）**，逐字：*"`selected` holds the chosen option labels,
and `custom` carries a free-form answer — **supplementing** `selected` for a multi-select question
and **overriding** it for a single-select question."*
⇒ `selected` 与 `custom` 是**标签字符串**（不是 option id），且两家的合并语义必须写进 UI 契约。

**`outcome` 七态——三家各有自己的"非正常收场"，全部有证据**：

| outcome | 来源与逐字依据 |
|---|---|
| `answered` | 正常收到答复 |
| `auto-resolved` | codex 的 `autoResolutionMs`（`RequestUserInputEvent` 字段：**自动决议超时**） |
| `skipped` | claude 的 `tengu_ask_user_question_skipped`（`skippedCount`）+ `user_skipped_questions` |
| `timeout` | claude 的 `getAskUserQuestionTimeout`；dsh **无**超时预算（见下） |
| `unavailable` | dsh 逐字：*"if no answer handler accepts it, **the model receives an error**"*、*"Without one, the tool call **fails with an error instead of degrading**"* |
| `rejected` | claude 的 `tengu_ask_user_question_rejected`；dsh 的 **`DELEGATED_CALLER`**（子智能体被拒） |
| `canceled` | 三家都靠 turn 的 signal（dsh 逐字："cancels only through the turn's `signal`"） |

**阻塞行为——三家不同，且这是本族最关键的差异**：

| 家 | 是否阻塞 | 超时/自动收场机制 |
|---|---|---|
| dsh | **阻塞，且无超时预算**（逐字："A pending question **blocks the tool call until the human answers** — the tool declares **no `timeout-policy` budget**"） | ❌ 无，只能靠 turn 的 `exec.signal` |
| codex | `isBlocking` 声明 + `autoResolutionMs` | ✅ **有自动决议** |
| claude | 有 park 机制（`tengu_auq_park_interrupted_at_stream_close`：*"Interrupting **parked** AskUserQuestion"*）+ `afk` 模式与 `getAskUserQuestionTimeout` | ✅ **有超时 + AFK 自动前进** |

⇒ **「会不会无界挂起」的答案是"看哪一家"**：dsh **会**（它自己 README 承认），
codex/claude **有兜底**。**UI 必须按 `outcome` 呈现，而不是假设三家都会挂住或都会收场。**

**两条三方共有的硬约束（必须写进 UI 与评测口径）**：

1. **子智能体不能问用户**——dsh 逐字：*"A live child agent owned by another agent **cannot call this
   tool** and must report unresolved questions in its final result"*（错误码 `DELEGATED_CALLER`）；
   claude 侧有 `Task` 子智能体上下文。⇒ 子任务里的"想问没问成"**只能靠 `outcome: 'rejected'`**。
2. **无人值守环境下的失败是"报错"而不是"降级"**——dsh 逐字：
   *"the tool call **fails with an error instead of degrading**"*
   ⇒ 本仓（`approvalPolicy: 'never'`、无人应答）**必然走 `unavailable` 分支**，
   这是**已知边界**而非缺陷，UI 要如实标注。

**配置开关（codex 侧，已核实归属）**：
- `tools.experimental_request_user_input.enabled=true` —— 打开工具本身；
- **`features.default_mode_request_user_input=true`** —— 让它在**默认模式**下也可用。
  该键属于 `features.*`（出现在二进制的 feature 名单里，与 `steer`、`guardian_approval` 并列），
  **不是 `tools.*`**。

**dsh 侧的依赖**：该工具需要 `ctx.userQuestions` 这个 seam 且**必须有能接受该请求的 answerer**；
否则调用直接报错（上表 `unavailable`）。⇒ **本仓若不开应答面，dsh 的 `ask_user_question` 会在真机上报错**，
需实测确认它是否出现在本仓的工具表里（本机 dsh 的 24 项工具里**没有**它——
说明当前 profile 未启用该插件，见 §11 开放问题 15）。

#### 7.6.2.2 两张独立面板（用户口径：统一 WorkItem + source 标注；面板分开）

**根因**：三家的"任务"面**形态相反**——claude/codex 是**事件流**，dsh 是**工具**；
且**没有任何一个概念是三家共有的**（§7.6.1 的目标修正）。所以不能"对齐一个工具"，
只能**定义一个派生模型**，由消费方从可得信号拼出来。

**两张面板，各自一个模型**：

| 面板 | 语义 | 数据来源 |
|---|---|---|
| **① 进度清单面板** | agent **自述**的工作步骤（声明式意图） | `todo_write`(dsh) · `update_plan`(codex) |
| **② 派发面板** | **运行时**派发的子智能体/作业（调度事实） | §6 的 `subagent-start/end`（三家）+ claude 的 `Task*` |

**① 进度清单面板——统一 `WorkItem` 模型 + `source` 标注**

```ts
interface WorkItem {
  id: string | null;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'unknown';
  /** **该条数据的来源**——本模型的灵魂字段（与 §6 的 source 同一口径） */
  source: WorkItemSource;
}
type WorkItemSource = 'tool' | 'event';
interface TaskPanel {
  items: WorkItem[];
  /** 整表覆盖（两家都是）——§7.6.2 ⑨ 的 commitModel 在此收敛 */
  commitModel: 'replace-whole-list';
  counts: { pending: number; inProgress: number; completed: number };
}
```

**为什么 `source` 是灵魂**：两家**送达方式不同**，UI 必须知道自己在看什么：

| 家 | 来源 | `source` | 我们能不能拿到 |
|---|---|---|---|
| dsh | `todo_write` 工具调用 | `'tool'` | ✅ 能（工具在 wire 上） |
| codex | `PlanUpdate` / `plan_delta` **事件** | `'event'` | ❌ **拿不到**——见下 |
| codex（退化） | `update_plan` 工具调用 | `'tool'` | ✅ 能（开 `tools.update_plan.enabled` 后） |

**⚠️ 关键约束（本次调研最重要的发现）**：codex 的**原生**面板数据是 `EventMsg` 事件
（`PlanUpdate`/`plan_delta`/`CollabAgent*`/`RequestUserInputEvent`），
而**本项目的传输层看不到它们**：

- SDK 只 spawn `exec --experimental-json`（实测 `commandArgs = ["exec","--experimental-json"]`）；
- SDK 产物里 **`PlanUpdate` / `plan_update` / `CollabAgent` / `TurnPlanUpdated` /
  `RequestUserInput` 的引用数全部为 0**（实测）；
- 这些事件走的是 **app-server / rollout 协议**（`RolloutItemWire::EventMsg`、
  `TurnPlanUpdatedNotification`），不是 exec JSONL 的 5 种 item 类型。

⇒ **codex 的面板只能靠工具面（`update_plan`）重建**。这正是
「打开 `tools.update_plan.enabled`」的真正理由——**不是为了对齐工具，而是给 codex 提供唯一可得的数据源**。

**② 派发面板——复用 §6，不新建模型**

用户口径是**两张独立面板**，而派发那半边**已经在 §6 定义好了**：

| 家 | 派发数据 | 规范落点 |
|---|---|---|
| 三家 | `subagent-start` / `subagent-end`（§6，含 `source: 'wire'\|'hook'\|'session-file'\|'aggregate'`） | §6 |
| claude | `SDKTaskStarted/Updated/Progress/Notification` + `SDKBackgroundTasksChanged`（level 信号） | 经 §6 的 `source: 'session-file'` 或 hook 落地 |
| codex | `CollabAgentSpawnBegin/End`、`InteractionBegin/End`、`WaitingBegin/End`、`CloseBegin/End`、`ResumeBegin/End`、`sub_agent_activity` | **不可达**（同上），退化为 `multi_agent_v1` 的工具调用 |
| dsh | `subagent.started/finished` 通知 + `subagent*` / `job_*` 工具 | §6 + 工具面 |

**⇒ 派发面板不新增模型**：它就是 §6 的子任务事件渲染成的一张表。
这避免了两套"子任务"表示（§6 一套、面板一套）——**同一事实只有一个真相源**。

**两张面板的边界（防止混用）**：

| 问题 | 进度清单面板 | 派发面板 |
|---|---|---|
| 回答什么 | "agent **打算**做哪几步" | "**现在有什么在跑**" |
| 谁产生 | agent 自己声明 | 运行时调度 |
| 更新方式 | 整表覆盖 | 逐条生命周期事件 |
| 可否为空 | 可以（agent 没规划） | 可以（没派发） |
| 混淆的代价 | 把"计划"读成"已经跑起来的东西" | 把"跑起来的"读成"计划" |


#### 7.6.3 三家映射表（原生形状 → 族结构）

| family | claude-code | dsh | codex |
|---|---|---|---|
| `read-file` | 结果文本带 `cat -n` 行号 + `<system-reminder>` ⇒ `lineNumbersIncluded: true`；需要**剥掉 reminder** | **真机（2026-09-30）**：`{path, type, content}` 三标签包裹，`content` **带 `N: ` 行号**、末尾 `(End of file - total N lines)` ⇒ `lineNumbersIncluded: true`、`lineCount` 可从末行取 | 无文件读取工具（`tool_mode: code_mode_only`）⇒ **该族恒为 null** |
| `write-file` | `Write` 的 `{file_path, content}` | `write` 的 `{file_path, content}` | 同上，经 `exec_command` 完成 |
| `edit-file` | `Edit` 的 `{file_path, old_string, new_string, replace_all}` → `edits[1]` | `edit` 同形（实测参数名一致） | 同上 |
| `search-content` | `Grep` 的 `{pattern, path, glob, -i}` ⇒ `include` 取 `glob` | `grep` 的 `{pattern, path, include}` | 同上 |
| `list-files` | `Glob` 的 `{pattern, path}` | **真机（2026-09-30）**：`glob` 的 result 带 `meta: {shape:'paths', paths:[...], truncated, total}` ⇒ `files` = `meta.paths`、`count` = `meta.total`、`truncated` = `meta.truncated`（**别去 parse 文本**） | 同上 |
| `run-shell` | `Bash` 的 `{command, timeout}`；结果**是文本**（无结构化 exit code）⇒ 从文本推或留 `null` | `pwsh` 的 `{command, workdir, timeout_ms}` | ✅ **最完整**：`{command}` + `{aggregated_output, exit_code, status}`；`status` 三值 `in_progress/completed/failed` |
| `web-search` | `WebSearch` 的 `{query}` | `web_search` 的 `{queries[]}`（**复数**）⇒ 取首个进 `query`，其余进 `raw` | `web_search` 的 `{query}` |
| ↑ **本仓三家统一禁用**（D16） | 无条件进 `disallowedTools` | profile patch：`tool-web.config.search=false` | 保持 `tools.web_search=false` |
| `spawn-agent` | `Task` 的 `{prompt, subagent_type, model}` | `subagent`/`subagent_fork` 的 `{prompt, agent_type?}` | `spawn_agent` 的 `{prompt?, fork_turns, model?, reasoning_effort?}` |
| `task` | `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` 的 `{subject, description, activeForm?, status?, taskId?}`（**逐条 patch**，§7.6.2.1c） | `todo_write` 的 `{todos: [{content, status}]}`；**整表覆盖** | `update_plan` 的 `{explanation?, plan: [{step, status}]}`；**默认关闭** |
| `ask-user` | `AskUserQuestion` 的 `{questions: [{id, question, header, options[], multiSelect}]}` | `ask_user_question` 的 `{questions: [{id, question, header?, options[]?, multi_select?}]}` | `request_user_input` 的 `{questions: [{id, header, question, options[]}]}`；**默认关闭** |

**codex 的两个开关（本仓必须显式打开，否则上面两族恒 `null`）**：

```toml
[tools]
# 让 codex 发 update_plan —— 这是它在 SDK 传输层上**唯一**可得的面板数据源（见 §7.6.2.2）
update_plan.enabled = true
# 让 request_user_input 工具出现
experimental_request_user_input.enabled = true

[features]
# 让"请求用户输入"在**默认模式**下也可用（否则按工具描述只在 Plan mode 可用）
default_mode_request_user_input = true
```

**归属已核实**：`update_plan` / `experimental_request_user_input` 在 `tools.*` 下
（二进制 `ToolsToml with 3 elements`：`web_search`、`experimental_request_user_input`、`update_plan`）；
`default_mode_request_user_input` 在 **`features.*`** 下（它出现在 feature 名单里，
与 `steer`、`guardian_approval` 并列），**不是 `tools.*`**。
两处 A/B 实测：`tools.update_plan.enabled=true` 使 `update_plan` 出现在入站 `tools[]` 里。

**codex 的截断口径（实测，必须照实转成 `truncated`）**：
`aggregated_output` **截断到 64 KiB，且末尾带 `\n...(truncated)` 标记**。
⇒ `truncated: true` 且**从 `stdout` 里剥掉那个标记**（否则 UI 会把标记当程序输出显示）。

**几处必须照实说明的差异**：

1. **codex 在文件类 4 族上恒为 `null`**——这不是我们没做，是它 `code_mode_only` 下
   **没有那些工具**（§7.6.3 差异 1）。UI 因此**必须能吃 `family: null`**，
   这不是边缘情况而是 codex 的常态；
2. **`exitCode` 在 claude 上很可能拿不到**——`Bash` 的结果是文本块，没有结构化退出码
   ⇒ 恒 `null`（**不填 0**，与「绝不填 0」同口径）。UI 对 `exitCode: null` 要显示「未知」
   而不是「成功」；
3. **`web_search` 的参数基数不同**（cc/codex 单数、dsh 复数）⇒ 统一取 `query: string`，
   多查询进 `raw`。这是"强对齐"的代价：dsh 的多查询能力在族结构里被压平。

#### 7.6.4 UI 渲染契约（本节的最终目的）

**一条规则**：UI 只按 `family` 分支，**永不按 `name` 或 `agentKind` 分支**。

**第二条规则（2026-09-30 新增，D13）**：**`thinking` 块只渲染 `text`**——
`signature` 是**隐藏字段**（§5.2 的隐藏口径）：**任何界面文案、活动行摘要、卡片指标、抽屉正文
都不得出现它**。可以渲染 `textKind`（「完整推理 / 推理摘要」是**给人看**的信息），
但**不得据它回推厂商**。
理由一句话：它是 replay 校验串，对评测者无意义，且显示出来只会让人误以为那是「思考的签名/摘要」。

> **⚠️ 在 `turn` 语义定案前（§7.0.5 / §11.1 第 22 项），`message.turn` 不得用于跨家比较或分组**——
> 它在 claude/codex 上是**合成的模型往返序号**，在 dsh 上是**厂商的用户轮号**，是三个不同的量。
> 要用就先用 `agentKind` 换算——而那正是本契约要消灭的东西。UI 在统计里显示轮次时，
> **应当显示 `usage.turns`**（那一格是三家里唯一已统一过口径的量，见 §5.1 与 `usage` 事件）。

| family | 渲染为 | 关键字段 |
|---|---|---|
| `read-file` | 代码块 + 行号栏（`lineNumbersIncluded` 为 false 时才自己编号） | `content` · `offset`/`limit` 高亮范围 |
| `write-file` | 一行摘要：`写入 <path>（N 字节，新建/覆盖）` | `path` · `bytes` · `created` |
| `edit-file` | **前后对照 diff**（`diff` 有就用，无则用 `edits[]` 自己算） | `edits[]` · `applied` |
| `search-content` | 按 `file` 分组的命中列表；`mode='files-with-matches'` 时改成路径列表 | `matches[]` · `mode` |
| `list-files` | 路径列表 + `共 N 个` | `files[]` · `count` |
| `run-shell` | **终端块** + 退出码徽标；`outputPath` 非空时改成「输出已存至 <path>」 | `stdout` · `exitCode` · `status` |
| `web-search` | 链接列表（`title` + `url` + `snippet`）；**本仓恒无数据**（§7.9）——渲染能力保留，UI 只需能吃 `family: null` | `results[]` |
| `spawn-agent` | 子任务卡片，与 §6 的 `subagent-start` 联动 | `prompt` · `subagentId` |
| `task` | **状态化清单面板**（§7.6.2.2 的①）：只画**最后一条**结果，历史折叠 | `steps[]` · `counts` · `commitModel` |
| `ask-user` | **问答卡片**：逐问题渲染 `options`（`recommended` 置顶、`allowOther` 追加自由输入），按 `outcome` 标收场（**七态**） | `questions[]` · `answers[]` · `outcome` |
| `family: null` | **通用回退**：`name` 作标题 + `inputText` + 文本结果 | 兜底，不算失败 |

**三态显示口径（贯穿所有族）**：

| 状态 | 判据 | 显示 |
|---|---|---|
| 成功 | `ok: true` | 正常 |
| 失败 | `ok: false` | 错误样式 + 结果文本 |
| **未知** | `ok: true` 但关键字段为 `null`（如 `exitCode`） | **不显示为成功**，标「未采集」 |

这一格是全部设计的落点：**「拿不到」与「拿到了好结果」在 UI 上必须能分开**（§4 的同一口径）。

#### 7.6.5 验证策略

1. **逐族一条映射守卫**：用三家真实形状的夹具，断言产出的 `family` 与关键字段。
   **codex 的文件类 4 族要专门断言 `family: null`**（防止有人"顺手"给它猜一个族）；
2. **必须做的变异验证**：
   - 把 codex 的 `truncated` 标记处理去掉 ⇒ 守卫必须红（标记会混进 `stdout`）；
   - 把 `lineNumbersIncluded` 恒设为 `false` ⇒ 守卫必须红（UI 会双重编号）；
   - 把 claude 的 `exitCode` 从 `null` 改成 `0` ⇒ 守卫必须红（假"成功"）；
3. **UI 侧一条"不按厂商分支"的守卫**：静态断言渲染模块里**不出现** `agentKind` 或厂商工具名
   （与 §10 的目录边界同思路，用 eslint 规则封）；
4. **UI 侧一条"隐藏字段不出现"的守卫**（D13）：静态断言渲染模块与文案模块里**不出现 `signature`**
   ——与上一条同一手法（静态规则），因为这是**呈现层**的约束，靠 code review 守不住；
5. **配置面的两组守卫**（与上面第 3 条同一性质：静态断言 + 变异体）：
   **`web-search` 三家禁用**（D16，判据见 §7.9.3）与 **Workflow 的开关与并发闸门**（D15，见 §7.8.4）。

#### 7.6.6 未覆盖与待验证（诚实登记）

| 项 | 状态 |
|---|---|
| dsh 的 `read`/`edit`/`grep`/`pwsh` **结果**形状 | ✅ **全部闭合**（2026-09-30 真机，逐字见 [验证报告](../notes/2026-09-30-agent-message-spec-verification.md)）：**结构化数据全在 `tool/result.meta` 里**——`grep` 是 `{shape:'matches',files[{path,matches[{lineNumber,line}]}]}`、`write` 是 `{operation:'create'\|'update'}`、`edit` 是 `{diffs[{path,oldText,newText}]}`、`pwsh` 的退出码在文本尾部 `[exit code: N]`（成功时无此尾部）。**有 `meta` 就不要解析文本** |
| claude 的 `Read` 是否恒带 `<system-reminder>` | ✅ **已闭合**：2.1.281 / 2.1.283 上**不出现**（工作区内、外各读一次，3 次运行 0 命中）⇒ "必须剥掉"这一条**在本版不成立**（将来若出现，剥掉仍是对的）。附带坑：文本末尾**多一行空编号行**（`6\t`），用"行号最大值"当 `lineCount` 会**系统性多算 1 行**；而结构化旁路直接给 `totalLines` |
| claude 的 `Bash` 能否拿到退出码 | ✅ **已闭合**：**没有**结构化退出码（`BashOutput` 类型面里根本没有 `exitCode`）；失败时退出码在**文本**里——`tool_result` 正文是 `"Exit code 3"`、结构化旁路是字符串 `"Error: Exit code 3"`；成功时结构化旁路给 `{stdout, stderr, interrupted, …}` ⇒ ①`exitCode` 只能从失败文本解析、成功时保持 `null`（**不填 0**）；②**`stdout`/`stderr` 是分开的**，"三家都只给合并后的"对 claude 不成立；③长输出另有 `persistedOutputPath` ⇒ `outputPath` 有真来源 |
| codex 的 `file_change` 是否在 `code_mode_only` 下出现 | ✅ **已闭合**：**不出现**。一次"新建文件 + 改文件"的任务里两次都走 `command_execution` ⇒ 该族在 codex 上确实恒由 shell 承载 |
| 图片/PDF 类结果的渲染 | 本版只给 `kind` + `mediaType`，**不定义二进制承载方式**——留待 UI 需要时再设计 |

#### 7.6.7 与"两轴分类"的关系（前一版目标，降级保留）

前一版设计的 `action` × `target` 两轴**不是废弃**，而是**降级为辅助**：

- **`family`**（本节）服务于**渲染**——UI 直接吃；
- **`action` × `target`** 服务于**统计与比较**（"谁主动停过工作"、"哪家读文件多"），
  覆盖**全部**工具（含没有族的那些），因此仍需要；
- 两者的关系：`family` 是**细粒度渲染契约**（10 族），两轴是**粗粒度可比维度**（全部工具）。
  **不合并**——`run-shell` 与 `read-file` 在渲染上毫无共同点，但在"用了什么工具"的统计上
  都只是两个 `(action, target)` 组合。

表与两轴定义见 §7.6.8（保留原内容供统计侧使用）。

#### 7.6.8 两轴分类表（统计与比较用，覆盖全部工具）

```ts
export type ToolAction =
  | 'read' | 'write' | 'edit' | 'search' | 'list'
  | 'execute' | 'send' | 'spawn' | 'stop' | 'wait' | 'query' | 'resume' | 'deliver';
export type ToolTarget =
  | 'file' | 'image' | 'notebook' | 'shell' | 'process'
  | 'agent' | 'job' | 'goal' | 'task' | 'web' | 'worktree' | 'skill'
  | 'user';      // 向用户提问（request_user_input 一类）——2026-09-30 新增
```

| 工具（家） | action | target |
|---|---|---|
| `Read`(cc) · `read`(dsh) | `read` | `file` |
| `read_image`(dsh) · `view_image`(codex) | `read` | `image` |
| `Write`(cc) · `write`(dsh) | `write` | `file` |
| `Edit`(cc) · `edit`(dsh) · `NotebookEdit`(cc) | `edit` | `file` / `notebook` |
| `Glob`(cc) · `glob`(dsh) | `search` | `file` |
| `Grep`(cc) · `grep`(dsh) | `search` | `file` |
| `Bash`(cc) · `pwsh`(dsh) · `exec_command`(codex) | `execute` | `shell` |
| `write_stdin`(codex) | `send` | `process` |
| `request_user_input`(codex) ※ | `query` | 待定（开放问题 8） |
| `WebSearch`(cc) · `web_search`(dsh/codex) ~~✅~~ | `search` | `web`（**本仓统一禁用 ⇒ 计数恒 0**，§7.9；不得读成"三家都没搜"） |
| `WebFetch`(cc) · `web_fetch`(dsh) | `read` | `web` |
| `ExitPlanMode`(cc)※ · `exit_plan_mode`(dsh) | `send` | `task` |
| `todo_write`(dsh) | `edit` | `task` |
| `update_plan`(codex) ※ | `edit` | `task`（**默认关闭**，`tools.update_plan.enabled`，见 §7.6.3） |
| `TaskCreate`·`TaskUpdate`·`TaskList`·`TaskGet`(cc) ※ | `edit` / `query` | **`job`**（**不是 `todo`**，见 §7.6.2.1） |
| `Skill`(cc) · `skill`(dsh) | `execute` | `skill` |
| `Task`(cc) · `subagent`·`subagent_fork`(dsh) · `spawn_agent`(codex) | `spawn` | `agent` |
| `SendMessage`(cc) · `send_message`(dsh) · `send_input`(codex) | `send` | `agent` |
| `TaskStop`(cc) · `interrupt_agent`(dsh) · `close_agent`(codex) | `stop` | `agent` / `job`※ |
| `job_kill`(dsh) | `stop` | `job` |
| `request_user_input`(codex) · `AskUserQuestion`(cc) · `ask_user_question`(dsh) | `query` | `user`（**新增 target**，开放问题 8 已决） |
| `ListAgents`(cc) · `list_agents`(dsh) | `query` | `agent` |
| `job_list`(dsh) | `query` | `job` |
| `wait_agent`(codex) | `wait` | `agent` |
| `job_output`(dsh) | `query` / `wait`‡ | `job` |
| `resume_agent`(codex) | `resume` | `agent` |
| `create_goal`·`get_goal`·`update_goal`(dsh/codex) ✅ | `write`/`read`/`edit` | `goal` |
| `EnterWorktree`·`ExitWorktree`(cc) | `send` | `worktree` |
| `Workflow`(cc) · `workflow`(dsh) | `execute` | `agent`（claude 侧**允许触发、并发闸门 = 8**，§7.8 ⇒ 本行的**规模**在两家的比较里不可直接并列） |
| `ReportFindings`(cc) | `deliver` | **`user`**（2026-09-30 查清：它是**代码评审结论的结构化上报口**，面向**宿主 UI**；原占位 `agent` 是错的） |
| `Cron*`·`ScheduleWakeup`·`DesignSync`(cc) | 已被适配器禁用（§7.1） | — |

※ ~~待真机确认（见 §11）~~ **已逐条真机确认（2026-10-01）**：
· **dsh 的 `exit_plan_mode`** ✅ **在**入站工具表里（该表实测 25 项，逐字见 §9.3 的复现命令）；
· **codex 的 `update_plan`** ✅ **在**（开 `tools.update_plan.enabled` 后，插在 `write_stdin` 之后）；
· **codex 的 `request_user_input`** ✅ **在**入站表里，但**在 `codex exec`/SDK 这条路径上结构性不可用**
  （JSON-RPC -32000，见 §11 第 10 项）⇒ 该行只对 **app-server 交互面**成立，本仓恒空；
· **claude 的 `ExitPlanMode`** ❌ **不在**入站工具表里（打包 exe 里有 29 处字符串 ⇒ 是 **mode 门控**，
  **不是"这家没有"**，与 `AskUserQuestion`/`TodoWrite` 同档）。
✅ = 三家同名。‡ = 兼两种动作，规范取 `query`。

> **⚠️ codex 那几个"工具名"有两类，本表混着用了（2026-09-30 补，独立审查指出）**：
>
> | 类 | 例子 | 来源 | 可信度 |
> |---|---|---|---|
> | **厂商真名** | `exec_command` · `spawn_agent` · `update_plan` · `request_user_input` · `view_image` · `write_stdin` | **入站 `tools[]`**（实测捕获） | ✅ 真名 |
> | **规范自定名** | **`'shell'`** · **`'apply_patch'`** | §7.3 为 `command_execution` / `file_change` 两个 **item 类型**编的**代称**——厂商在事件流里**不给工具名** | ⚠️ **我们起的** |
>
> ⇒ 本表按名字查得到 `exec_command` 与 `spawn_agent`，但**查不到 `'shell'` / `'apply_patch'`**
> （它们不在入站 `tools[]` 里），于是 `command_execution` 与 `file_change`——
> codex **最常用的两类调用**——的 `(action, target)` 会是**空**，
> "哪家跑命令多 / 改文件多"的跨家汇总**对 codex 失真**。
>
> **修法（见 §11 开放问题 25）**：给 §7.3 的自定名在**入站工具表里找一个真名**对应，
> 或把本表的 codex 列改用"**item 类型**"做键（`command_execution` → `execute/shell`）。
> 在此之前，**codex 的统计行不可与另两家并列**。

**用途**：产出「每家用了几次读文件 / 几次跑命令 / 几次派子任务」这类**跨家可比**的汇总。
**与 `family` 的分工**：统计读两轴（覆盖全部工具），渲染读 `family`（覆盖 10 族），
面板读 §7.6.2.2 的 `WorkItem` / §6 的子任务事件。

#### 7.6.9 落地位置

- **契约**：`ToolData` 与 10 族的 args/result、两轴类型、以及 §7.6.2.2 的
  `WorkItem` / `TaskPanel`，都加进 `@aieval/contracts`（§5.2）；
- **归一逻辑**：**在各自适配器内**（`providers/<kind>/`）——厂商细节只有它知道（§7.6.0）；
- **面板派生**：`WorkItem` 由消费方从**工具面 + 事件面**拼出（§7.6.2.2），
  **不放进 agents 包**——它需要同时看三家，与"每家只认自己"的适配器职责相反；
- **两轴映射表**：`packages/client/client/src/` 或 `ui` 的纯函数模块，**不放进 agents 包**
  （那是厂商投影层，不该知道别家的工具名）；
- **守卫与变异验证**：见 §7.6.5。

### 7.7 计量扩展：思考 token 进 `usage`（D14 / 开放问题 3 的定案）

**定案（用户口径 2026-09-30）：思考 / 推理 token 的计量进 `usage` 行级事件。**
本节给出契约形状、三家落点、能力声明与**必须同步改的四处落点**——
其中最要紧的一条写在最前面：**它不是第四个加数**。

#### 7.7.0 先划死一条：它是 `output` 的**子集**，不是第四个加数

claude 侧有**权威的类型面逐字**（`BetaOutputTokensDetails.thinking_tokens`）：

> "Number of output tokens the model generated as internal reasoning, including the thinking-block
> delimiter tokens. … **Always ≤ `output_tokens`**; `output_tokens - thinking_tokens` approximates
> the non-reasoning output."

`modelUsage[].thinkingTokens` 同样逐字："**already counted inside outputTokens**"。

⇒ **它已经算在 `output` 里了**。任何"总输出 = `output` + `thinking`"的实现都是**双计**，
且会让"哪家更费 token"的跨家比较**系统性失真**。契约因此把它做成**独立字段 + 一个可加性标注**
（`usageCapability.thinkingTokensBasis`，§7.7.4），**不塞进 `tokens` 三元组**——
放进那个对象就是在**邀请**别人去加它。

#### 7.7.1 契约形状（`tokens` 三元组一个字不改）

```ts
/** `usage` 行级事件（**契约草图**，与 §5.1 的 `AgentMessage` 同一性质：只定口径，不代表代码里的命名）。
 * **只新增一个字段**，`tokens` / `turns` 的既有口径全部不动。 */
interface UsageEvent {
  type: 'usage';
  tokens: { input: number; cached: number; output: number } | null;
  /**
   * 思考 / 推理 token 的**结算值**。三条口径：
   *   · **采不到就是 `null`**（绝不填 0，也不拿 `tokens.output` 去凑——§4「缺就是缺」）；
   *   · **它是 `tokens.output` 的子集，不是第四个加数**（§7.7.0）⇒ 消费方**不得把它加进
   *     `tokens.output`**（能不能另算「总输出」，由 `usageCapability.thinkingTokensBasis` 决定）；
   *   · **只收结算值**：跑动期的估算帧不进这一格（理由见 §7.7.3）。
   */
  thinkingTokens: number | null;
  turns: number;
}
```

**为什么不并进 `tokens`**：三元组是三家**已经统一过口径**的量，且被快照回写、评分通路、排序与卡片指标
**同时读**；新维度与它**可空性不同、可信度不同、来源也可能不同**。塞在一起，「其中一格采不到」
就会拖住另一格——这正是 2026-09-28 把 `turns` 从 `tokens` 里解耦出来（`tokens` 可空、`turns` 仍必填）
的**同一条理由**。

#### 7.7.2 三家落点（含证据等级）

| 家 | 结算值来源 | 与 `tokens` 三元组**同源同口径**吗 | 证据等级 |
|---|---|---|---|
| **claude** | `result.usage.output_tokens_details.thinking_tokens` | ✅ **是**（同一个 `result.usage`，都是"主循环"口径） | **类型面逐字 + 真机取值**（2026-10-01 复核：**19/19 样本字段恒在**，取值 0/7/134/147/180/223/419/837/976/1027/1089/1268/1401，**恒 ≤ `output_tokens`**（最大比 0.545，零违例））⇒ `thinkingTokens: 'yes'`、`basis: 'subset-of-output'` **都有真机支撑** |
| claude（校验档） | `result.modelUsage[].thinkingTokens` | ❌ **不是**（含 Task 子智能体 / 侧链 / 压缩等内部调用，且 SDK 逐字说可能 **partial**） | 类型面逐字；真机同量级但**不等**（例：223 vs `outputTokens` 541）⇒ **只做交叉校验，不作主源** |
| **codex** | `turn.completed.usage.reasoning_output_tokens` | ✅ 是（同一个 usage 对象） | **类型面必填 + 真机取值（2026-10-01）**：**9/9 个完成的 run 全部非 0**（123/50/65/53/117/56/84/51/61），且 **9/9 恒 ≤ `output_tokens`**（123≤165、50≤97、…、61≤370）⇒ `thinkingTokens: 'yes'`、`basis: 'subset-of-output'` 都有了真机支撑。⚠️ **路由前提（同日追加轮补）**：这 9 个样本**全部来自 DeepSeek 路由**；**内网网关路径上没有一个跑完的 turn ⇒ 无样本**（`tool_choice` 网关错误），所以这条升级**必须带路由前提**，不能写成"三家的普遍结论" |
| **dsh** | `assistant/message → data.usage.reasoningTokens` | ✅ 是（同一个 usage 对象） | **2026-10-01 真机定案：结构性不可达**——`dsh-llm-pi-ai` 的 `mapUsage()` **从不写这一格**（源码逐字 + 上游确实给 `reasoning_tokens:31` 而 dsh 侧只有三格）⇒ `thinkingTokens: 'off-by-adapter'`，**不是 `'unverified'`** |

> **⚠️ 2026-10-01 追加一条"后端相关"的警告**：claude 的 `output_tokens_details.thinking_tokens`
> **在第三方 anthropic 兼容后端上可能恒为 0**——实测经 DeepSeek 的 `/anthropic/v1/messages` 时两次都是
> `{"thinking_tokens": 0}`，而**同一次运行里模型确实产出了 thinking 正文**
> （assistant 消息带 `{"type":"thinking",…}` 块，CLI 只能用 `system/thinking_tokens` 的 `estimated_tokens` 近似）。
> 根因：**DeepSeek 的 anthropic wire 根本不返回思考 token 字段**，而它的 **openai** wire 返回
> （`output_tokens_details.reasoning_tokens = 40` / `completion_tokens_details.reasoning_tokens = 48`）。
> ⇒ 规范据此加一条口径：**`thinkingTokens: 0` 不得读成"这家不思考"**；
> 在第三方后端上它只意味着「**上游没报**」——这正是 §4「缺就是缺」要防的那种假数。

**为什么 `modelUsage[].thinkingTokens` 不作主源**：它的**统计范围比 `tokens` 三元组大**——三元组取
`result.usage`，SDK 对它逐字写着 "**MAIN AGENT LOOP ONLY** — excludes Task subagent, sidechain,
and auxiliary model calls"。两者混用会出现「**思考 > 输出**」这种**自相矛盾**的读数，
而它在数据里**看不出错**（两个数各自都"对"）。
⇒ 不平滑、不混用：只在两者**同范围**时做交叉校验，不一致即落 WARN
（与 `num_turns` 和自数轮次不一致那条同一处置：同一件事有两个来源，**不静默挑一个**）。

#### 7.7.3 估算帧**不进计量**（claude 的 `system/thinking_tokens`）

claude 另有一条**逐帧**通道：`system.subtype === 'thinking_tokens'`（`estimated_tokens` /
`estimated_tokens_delta`）。**SDK 自己把它定性为估算**，逐字：

> "Live thinking-token estimate, digested from thinking_delta.estimated_tokens during the
> redacted-thinking phase … **Approximate progress for spinners/pills, not the authoritative billed
> output_tokens**."

体量也支持"不落盘"：实测一轮跑出 **6913 条事件 / 2.1 MB，其中绝大多数是逐条 `thinking_tokens`**
（[2026-09-22-features-p5-smoke.md](../notes/2026-09-22-features-p5-smoke.md)）。

⇒ 三档处置（2026-09-30 定案）：

1. **不落 `attachment` 块**——逐帧噪声会把抽屉灌满；`attachment` 是给「不认识的信封」用的兜底（§5.3），
   **不是**给「已识别且有意不投影」用的；
2. **不进 `usage.thinkingTokens`**——把「近似值」写进「结算值」的格子，正是本仓最忌讳的
   「看起来采到了」；
3. **归入「已识别且有意不投影」**（与 §7.2 的 `session.status` 同一档）。
   将来若要做「正在思考 N tok」的动效，那是**动效专用通道**，不与计量列共用格子（本期不做，§12）。

> 这条与 `tokens` 三元组的**既有估算**不冲突，两者是**不同的认识等级**：三元组的跑动期估值是
> assistant 消息上**真实用量**的累加（只是 not final，权威值一到就作废，见 `turn.ts` 的
> `tokensEstimated` 分支）；而 `estimated_tokens` 是**对推理 token 数的近似**
> （SDK 逐字 "Approximate progress"）。前者可以进事件、后者不可以。

#### 7.7.4 能力声明：`usageCapability`（§3 的新增块）

```ts
usageCapability: {
  thinkingTokens: CapabilityLevel;                                  // 能否拿到结算值
  thinkingTokensBasis: 'subset-of-output' | 'additive' | 'unknown'; // 能不能加、能不能跨家比
};
```

| 家 | `thinkingTokens` | `thinkingTokensBasis` | 依据 |
|---|---|---|---|
| claude | **`'yes'`** | `'subset-of-output'` | 类型面逐字 "Always ≤ `output_tokens`" **＋ 真机 19/19 样本无违例（2026-10-01）** |
| codex | **`'yes'`** | **`'subset-of-output'`** | **真机 9/9 非 0 且 9/9 恒 ≤ `output_tokens`（2026-10-01，DeepSeek 路由）**——原为 `'unverified'`/`'unknown'`（旧样本 3/3 恒 0，已推翻）。⚠️ **样本只来自 DeepSeek 路由**：内网网关路径上 codex 跑不完 turn（`tool_choice`），**那一路上无样本** |
| dsh | **`'off-by-adapter'`** | `'unknown'` | **2026-10-01 真机定案**：`dsh-llm-pi-ai` 的 `mapUsage()` 从不写 `reasoningTokens`（源码逐字；上游确实给 `reasoning_tokens:31`） |

**⚠️ 这句在本轮被改写了**（原话是"三家一律先声明 `'unverified'`——通道都在类型面上，但**没有一家有真机取值样本**"）。
2026-10-01 的真机复核把三家拆成了三种不同的状态，**这正是四态存在的理由**：

| 家 | 原声明 | 改为 | 为什么 |
|---|---|---|---|
| claude | `'unverified'` | **`'yes'`** | 19 条真机样本、字段恒在、恒 ≤ output ⇒ **有样本了** |
| codex | `'unverified'` | **`'yes'`** | **2026-10-01：9/9 非 0 且 9/9 恒 ≤ output** ⇒ 旧样本"3/3 恒 0"被推翻，`basis` 一并升为 `'subset-of-output'` |
| dsh | `'unverified'` | **`'off-by-adapter'`** | 不是"没有样本"，是**这条路由的适配器不投影**（有源码逐字依据）⇒ 再跑多少次也不会有 |

⇒ 一句话：**`'unverified'` 描述的是证据等级**（再采一次可能就有），**`'off-by-adapter'` 描述的是适配器行为**（再采也没有）。
把后者写成前者，会让消费方以为"多跑几次 dsh 就能拿到思考 token"。
**反过来也要注意**：`'unverified'` 也可能**一次真机就翻盘**——codex 那格就是（3/3 恒 0 → 9/9 非 0），
差别只在**跑的是哪个后端**。

**为什么 `basis` 要进能力元数据，而不是写成文档里的一张表**：可加性是**厂商属性**、不是逐事件属性
（写进事件等于每条 `usage` 重复携带同一个常数）；但把它留在文档里，消费方就得**按厂商分支**
去查表——而「消灭按厂商分支」正是本规范的全部目的（§7.6.4）。故它是**能力元数据的一格**。

#### 7.7.5 必须同步改的实现点（四处，缺一处就出假数或静默）

| # | 落点 | 改什么 | 不改的后果 |
|---|---|---|---|
| 1 | `turn.ts` 的 `sameUsage` | 去重比较**纳入这一格** | 「只有思考 token 变了」的新值**永远发不出去**，界面停在旧数 |
| 2 | `AgentRunResult`（快照） | 新增同名字段，**只收结算值** | 与 `tokens` 的「估算不进结果」口径不一致（`tokensEstimated` 分支的同一原则） |
| 3 | 三家适配器 | claude `result.usage` / codex `turn.completed.usage` / dsh `assistant/message → data.usage`；**缺项一律 `null` + WARN** | 缺项被填 0；或静默变成「没采集」——沿用既有的「用量负载不完整」合流 WARN，**不新开**一条噪声 |
| 4 | 消费方三处 | `row-live.ts`（`thinkingTokens: null` 与 `tokens: null` **同义**：这一条没带这一格，保留上一份）、`log-format.ts`（用量行加一段，无值**不写这一段**）、`metric-line.tsx`（可选显示） | 界面出现「思考 0」这类假数 |

#### 7.7.6 验证（四个变异体并入 §9.2）

- **变异 A**：把 `thinkingTokens` 加进 `output` ⇒ 守卫必须红（双计）；
- **变异 B**：把跑动期估算帧写进 `usage.thinkingTokens` ⇒ 守卫必须红（近似值冒充结算值）；
- **变异 C**：`sameUsage` 不比较这一格 ⇒ 守卫必须红（新值发不出去）；
- **变异 D**：三家任一家的缺项写成 `0` ⇒ 守卫必须红。

#### 7.7.7 未验证登记（与 §9.3 同步）——**2026-10-01 已被真机改写，不再是"三家都没有"**

初稿写的是「三家**都没有**真机取值样本」。2026-10-01 的复核把三家**拆成了三种状态**（详见 §7.7.2 / §7.7.4）：

| 家 | 真机结论 | 依据 |
|---|---|---|
| claude | ✅ **有样本**：19/19 条 `result` 消息字段恒在，取值 0/7/134/147/180/223/419/837/976/1027/1089/1268/1401，**恒 ≤ `output_tokens`**（最大比 0.545，零违例） | `probe/dumps/v2/thinking-tokens.json`、`thinking-basis.json` |
| codex | ⚠️ **字段出现但恒为 0**（3/3）⇒ "采到了" ≠ "采到了有意义的数"，继续 `'unverified'` | `probe/dumps/v2/codex-usage.json` |
| dsh | ⛔ **结构性不可达**：`dsh-llm-pi-ai` 的 `mapUsage()` 从不写 `reasoningTokens`（源码逐字；上游确实给 `reasoning_tokens:31`）⇒ 记 `'off-by-adapter'` | `probe/dumps/v4/dsh-reasoning-tokens.json` + `wire-usage-shape.json` |

⇒ 实现侧的口径随之改：**不再是"各跑一次真机并登记"**（claude 已登记、dsh 跑多少次都不会有），
而是 **① 按上表把三家能力位改成 `'yes'`/`'unverified'`/`'off-by-adapter'`；② 只有 codex 还需要一次"真产出推理"的运行**
（本机此前那 3 次 `reasoning_output_tokens` 全为 0，不足以核对可加性）。

### 7.8 Workflow 编排的开启与规模闸门（D15 / 开放问题 7 的定案）

**定案（用户口径 2026-09-30）：claude 的 Workflow 允许触发，但把规模压到 8。**
本节先把**"厂商能硬保证的是什么"**划清——Q7 原来含糊的地方正在这里。

#### 7.8.0 四个旋钮，两种性质（全部逐字取自厂商产物）

| 旋钮 | 在哪 | 逐字语义 | 是硬上限吗 |
|---|---|---|---|
| `enableWorkflows` | SDK `Settings`（`sdk.d.ts:6444` 的 `export declare interface Settings`） | "Enable or disable the Workflows feature for this user. **Unset = default by plan** once the feature is available." | 是**开关**，不是上限 |
| `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | **打包 `claude.exe`**（二进制字符串） | 设了就打一行 `workflow: concurrent agent gate = <N> (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)`；代码路径是 `… ?? Fr`（不设走厂商默认） | ✅ **硬闸门——但它管的是「并发」** |
| `workflowSizeGuideline` | SDK `Settings` | "small" aims for **fewer than 5** agents、"medium" fewer than 10、"large" fewer than 50、"unrestricted" 不发指引；**"This is a guideline, not an enforced limit."** | ❌ **advisory**，且档位是 5/10/50，**表达不了 8** |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` | **打包 `claude.exe`** | 与 guideline 合成的 `agentCap` 一起用于**规模告警**（载荷带 `scheduled_agents` / `agent_cap` / `cap_from_guideline`） | ⚠️ **告警阈值**，不是拦截 |

⇒ **一句话：厂商侧能"硬保证"的只有并发那一格；「总数 ≤ 8」没有厂商开关。**
本规范据此把上限拆成**两半**，且**不许把两半混着说**（这正是 Q7 原来含糊的地方）。

#### 7.8.1 落点（三处，全部走既有通道）

**① 允许触发**（"Workflow 触发"这一半）——`settings` 档（flag 档，与既有路由三件套同一格）：

```ts
settings: {
  env: { /* 既有：把路由钉回去那三个键，一个字不改 */ },
  enableWorkflows: true,            // ← 新增
  workflowSizeGuideline: 'medium',  // ← 新增（见 ③）
}
```

**为什么显式写 `enableWorkflows: true`**：SDK 逐字说 "**Unset = default by plan**"——
默认值取决于**账号 plan**，那是评测环境里**不可控的输入**。与 D12 同一口径：
**能让"有没有这个能力"变成配置差异的默认值，一律显式钉死。**
`workflowKeywordTriggerEnabled` **保持厂商默认（true）**：用户口径是"Workflow 触发"，
关掉关键字触发等于人为压低触发率，会让"用没用编排"不可比。
（**如实登记**：这意味着提示词里出现 `ultracode` 会额外提高触发率——评测提示词要避免无意带上它。）

> ### ⚠️ 2026-09-30 真机补一条：**`enableWorkflows` 只管"能不能"，不管"会不会"**
>
> `Workflow` 的工具描述**逐字**把触发条件写死在提示词侧：
>
> > "**ONLY call this tool when the user has explicitly opted into multi-agent orchestration.**
> > Workflows can spawn dozens of agents and consume a large amount of tokens; **the user must request that
> > scale, not have it inferred.** … The user included the keyword `ultracode` … The user directly asked you
> > to run a workflow or use multi-agent orchestration **in their own words** ("use a workflow", "run a workflow",
> > "fan out agents", "orchestrate this with subagents"). **The ask must be in the user's words** — a task that
> > would merely benefit from a workflow does not count."
> >
> > "For any other task — **even one that would clearly benefit from parallelism** — do **NOT** call this tool."
>
> 实测（本机 30 项工具表里 `Workflow` **在**，无需额外开关）：`enableWorkflows: true` 打开的是**功能可用性**；
> 模型**仍不会**在普通提示词下调用它。
> ⇒ 两条落地口径：
> ① **`enableWorkflows: true` 要显式写**，但**不是"不设就没有"**——见下面的语义更正；
>    **真正的理由是"钉住行为"而不是"打开功能"**，
>    但**不是充分的**——"3 家都没用编排"很可能只是**提示词没 opt-in**，不能读成"能力差异"；
> ② 若评测确实要比"编排能力"，**三家都要在同一段提示词里显式 opt-in**（否则这一格是提示词差异，不是能力差异）；
>    反之若不想引入编排，**提示词里必须避免 `ultracode` 与"用 workflow / 并行开 agent"这类原话**。

> ### ⚠️ `enableWorkflows` 的语义**在本 build 上与上一段写的不一样**（2026-10-01 抓包逐字）
>
> 用本机抓包服务采入站 `tools[]`，只切这一格：
>
> | settings | `Workflow` 在不在工具表里 |
> |---|---|
> | **不给** `enableWorkflows` | **在**（23 项） |
> | `enableWorkflows: false` | **不在**（22 项，描述为空） |
> | `enableWorkflows: true` | 在 |
>
> ⇒ 上一段"不设就是 default by plan，不可控"**在本 build 上不成立**：**不给 settings 时工具就在**，
> **`false` 才是把它摘掉的那一格**。**处置不变**（照样显式写 `true`——显式永远比隐式好），
> 但**理由要改成"钉住行为、防版本/plan 回退"，不是"不设就没有"**。
> 这也是本文反复出现的同一类更正：**把"我没设"读成了"它没有"**。

**② 并发硬闸门 = 8** —— `buildSubprocessEnv` 的 `injected`（与 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 同一通道）：

```
CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8
```

**③ 总数侧：软约束 + 厂商告警 + 我们留痕（不硬拦）**

- `workflowSizeGuideline: 'medium'`（"fewer than 10"，**最接近 8 的档**；实测 `'8'` 会被忽略并回落成 medium ⇒ 确认表达不了 8）；
- 注入 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`，让**厂商自己**在排期超 8 时产生规模告警
  （字段名 `scheduled_agents` / `agent_cap` / `cap_from_guideline` 已在二进制里逐字见到）。
  **⚠️ 2026-10-01 真机：这条告警进不了任何可见流**——构造了确定性触发条件（阈值 8 + guideline medium=10 +
  提示词要 12 个 agent，实测确实排了 12 个），5 个 token 在 **stdout / stderr / debug 日志 / SDK 消息流**
  **全部 0 命中**（它们只出现在**遥测调用**里，且那段代码在 UI 层的 memo 块中）
  ⇒ **这一条在本仓退化成"纯我们自己的计数"，不要指望厂商告警进落盘物**；
- 适配器侧仍按 §6 的 `subagent-start` **计数留痕**（对 `task_type === 'local_workflow'` 计数），
  超 8 落一条 WARN——**计数是观察，不是拦截**。**注意：这条现在是唯一的告警来源**。

**为什么总数不做硬拦**：唯一能拦的手段是我们在数到第 9 个时调 `Query.stopTask(taskId)`
（`sdk.d.ts:3070` 确有这个 API），那等于**评测中途改写模型的编排**：被杀掉的 agent 会留下半成品，
而"编排规模"这个**本该被观察的量**反而被我们自己抹掉了。
⇒ 用户口径要的是"限制"，而**厂商唯一提供的限制就是并发那一格**；超出的部分**如实记录**
比悄悄掐掉更有价值。

#### 7.8.2 作用域（必须写清，否则会被读成"所有子智能体都 ≤ 8"）

**本上限的作用域是 Workflow 派生的 agent**（`task_started.task_type === 'local_workflow'`）——
因为两个旋钮都是 workflow 专属的。**普通 `Task` 子智能体（`task_type === 'local_agent'`）
不在这个上限里**：厂商**没有**任何等价开关（`sdk.d.ts` 里 `maxConcurrent*` / `maxAgent*` /
`maxSubagent*` **零命中**，实测）。要把 8 也套在 `local_agent` 上，只能走
"我们计数 + `stopTask`"那条路，**本期不做**（登记为缺口，见 §11.1 第 29 项）。

#### 7.8.3 由此产生的一个跨家不对称（如实登记，不抹平）

Workflow 是 **claude 独有的编排面**：codex 的子智能体仍卡在 model preset（§7.5.3 牌 A，外部依赖），
dsh 只有 `subagent` / `job` 工具面。
⇒「claude 用了编排、另两家没用」这类比较**必须带上本节的闸门口径**（并发 ≤ 8、总数只有软约束），
否则"编排规模"会被读成能力差异。这与 §7.9 对 `web-search` 的处置同源：
**能力不对称要标出来，不要靠配置去假装对齐。**

#### 7.8.4 验证

- **守卫**：`enableWorkflows === true` 显式出现在 `settings`；`injected` 里**逐字含**
  `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS: '8'`（判据与 D12 那两条同一手法）；
- **变异**：删掉 `enableWorkflows`（回落成"按 plan 默认"）⇒ 守卫必须红；
  漏注入闸门（或写成非 `8`）⇒ 守卫必须红；
- **真机（2026-10-01 已跑，三条判据全部有结论）**：跑一轮会触发 workflow 的提示词，核对
  ① **那一行 `workflow: concurrent agent gate = 8` 出现了，但不在 stdout/stderr 上，只在 CLI 的 debug 日志上**
     （需 `--debug`（默认落 `~/.claude/debug/<session>.txt`）或 `--debug-file <path>`；plain `-p` 的两条标准流里**永远没有**）。
     ⚠️ **本节原写的"它在 CLI 的 stdout/stderr 上"要改**——按原话去找会**找不到，然后误判"闸门没生效"**。
     对照干净：**不设该变量时哪一格都没有**；设了则只在 debug 日志里。逐字：
     `[DEBUG] workflow: concurrent agent gate = 8 (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)`；
  ② **规模告警进不去任何可见流**：构造了确定性触发条件（`_SIZE_WARNING_AGENTS=8` + `guideline: medium`(=10) +
     提示词明确要 **12 个 agent**，实测流里确实排了 12 个不同 label），
     5 个 token（`workflow_size_warning` / `tengu_workflow_size_warning_shown` / `scheduled_agents` /
     `agent_cap` / `cap_from_guideline`）在 **stdout ✗ / stderr ✗ / debug 日志 ✗ / SDK 消息流 ✗** 全部 0 命中
     ⇒ **③ 的告警在本仓的 print/SDK 路径下退化成"纯我们自己的计数留痕"**（与本节 if-not 分支一致，可直接定稿）；
  ③ **顺带证到两件设计稿没写的事**：DeepSeek 后端**真能驱动 Workflow**（6 跑 5 中，12-agent 编排真跑完、
     12 个 agent 全部 `state:"done"`）；`workflowSizeGuideline: '8'` **被忽略、回落成 medium/10**
     ⇒ 「档位只有 5/10/50、表达不了 8」**实测成立**。
     **保留一句**：OTLP 通路确实被访问（21 次），但 OTEL 日志的 `event.name` 只有固定 8 个，
     **从不承载 `tengu_*`**（那条走 Statsig 的另一条网络通路，未观测）
     ⇒ **能说"不进可见事件流"，不能说"事件不产生"**。

### 7.9 `web-search` 族统一禁用（D16 / 开放问题 26 的定案）

**定案（用户口径 2026-09-30）：`WebSearch`(claude) 与 `web_search`(codex/dsh) 三家全部禁用。**
**`web_fetch` / `WebFetch` 不在本条里**——本条管的是"搜索"，不是"取网页"。

#### 7.9.0 为什么是"统一禁用"，而不是 D12 式的"统一打开"

`web_search` 的能力**绑在模型 / 服务端**上，不是绑在配置上：

| 家 | 现状 | 依据 |
|---|---|---|
| claude | `WebSearch` 是**厂商服务端执行**的工具；第三方模型走同一网关时未必实现它 | `providers/claude-code/index.ts` 的 `NON_CLAUDE_DISALLOWED_TOOLS` 注释（2026-09-29 口径） |
| codex | `tools.web_search: false` **硬编码**（保留） | `providers/codex/sdk.ts` 的 `buildCodexConfig` |
| dsh | `dsh-base` 的 profile **默认装上**它 | `dsh-base/cordis.patch.yml` 逐字："The shared base enables the stable model-facing **web_search and web_fetch** tools." |

⇒ 用户口径：**只有 claude / gpt 系模型支持它，其余模型不支持**。于是 D12 的"统一打开"在这里
**做不到**——打开了只会让"有没有联网"变成**模型差异**，而模型正是本项目的**自变量**，
不该同时充当被观察的因变量。**统一关闭**才让该族在**所有模型上一致地"没有"**。

> 这一条与 D12 **不矛盾**，判据是"**能不能三家同时成立**"：
> D12 打开的是三家都能开、且开了才有得比的能力（规划工具）；
> 这里关掉的是**只有部分模型有**、开了就再也比不了的能力。

#### 7.9.1 三处落点（逐家，全部是既有机制）

| 家 | 落点 | 改法 |
|---|---|---|
| claude | `ALWAYS_DISALLOWED_TOOLS`（`providers/claude-code/index.ts`） | `WebSearch` **从"按模型名分档"移进无条件名单**：`disallowedToolsFor` 里那条 `/claude/i` 分支**删掉**，`NON_CLAUDE_DISALLOWED_TOOLS` 随之消失——**这推翻了 2026-09-29 的分档口径** |
| codex | `buildCodexConfig` | `tools.web_search: false` **保持不变**（本来就是无条件关） |
| dsh | 本行 `cordis.patch.yml`（**顶层 id-targeted override**，与 `insert` 是两种写法） | `- id: tool-web` + `config: { search: false }`（`search` 逐字："Register `web_search`. **Defaults to true**"）；`fetch` 保持 true ⇒ `web_fetch` 不受影响 |

**dsh 那一格的两个注意点**（都要在实现时核对，不要推断）：

1. 顶层条目是 "**id-targeted config overrides**" ⇒ **已机械核对（2026-10-01）：它确实整份替换**
   `tool-web` 的 config（`dsh-base` 那份是 `{ fetch: true, searchTimeoutMs: 60000 }`）。⇒ **必须连
   `fetch: true` 与 `searchTimeoutMs: 60000` 一起写出**，否则会顺手改掉 `web_fetch` 的行为。
   **注意形态**：只写 `{ search: false }` 时，插件的 zod 默认值会把 `fetch` 补回 `true`（web_fetch **不会**消失），
   但 `searchTimeoutMs` 会**静默从 60000 掉到 30000**——所以"改了行为"这件事是真的，只是**不是"关掉"而是"超时腰斩"**。
   详见 §11.1 第 30 项（含三档 `--dump-config` 逐字）与 `probe/dumps/v4/dsh-tool-web-override.json`；
2. 判据用**机械验证**：`dsh --profile sdk --dump-config` 后断言合成树里 `tool-web` 的
   `search` 为 false、且 `fetch` 仍为 true（与 §7.6.2 ⑩ 验证 `tool-ask-user` 插入时**同一个手法**）。

#### 7.9.2 影响（三处必须同步改的口径）

1. **§7.6.1 的族**：`web-search` **族保留**（渲染契约不变），但标注**本仓恒空**——
   与 codex 的文件类 4 族同一处置：UI 必须能吃 `family: null`，**这不是边缘情况**；
2. **§7.6.8 的两轴统计**：`WebSearch` / `web_search` 两行**计数恒为 0**；
   任何"谁搜过网"的跨家汇总在本仓**没有数据**，**不得读成"三家都没搜"的能力结论**；
3. **`WebFetch` / `web_fetch` / `Bash` 照旧可用**（沿用既有口径：**只禁工具，不禁网络**——
   评测要观察的正是"改完自己跑不跑得起来"）⇒ **"联网能力"因此仍不可比**，
   这一点**如实登记**，而不是假装已经统一。

#### 7.9.3 验证

- **守卫（三家各一条，判据指向真源）**：claude 的 `disallowedTools` **恒含** `WebSearch`
  （**不分模型名**）；codex 的 config `tools.web_search === false`；dsh 的 patch 文件里
  `tool-web` 的 `search` 为 false；
- **变异**：任一家放行 ⇒ 对应守卫必须红。**claude 那一条尤其要跑**：把 `/claude/i` 分档逻辑
  加回去 ⇒ 守卫必须红（现存用例 `claude-code/index.test.ts` 的"随模型名分档"那条要
  **删掉并替换**——它守的正是被本条推翻的口径）。

## 8. 流式语义（D6）

### 8.1 统一的 `chunk` 标记

不新增事件类型。每个 `message` 事件带 `chunk`：

| 值 | 含义 | 消费方处置 |
|---|---|---|
| `'delta'` | 本条是**增量**（可追加） | 追加到该 `messageId` 的累积缓冲；只用于实时打字效果 |
| `'snapshot'` | 本条是**完整快照**（`blocks[]` 为该消息到目前为止的全量） | **覆盖**合并；抽屉与落盘真相以它为准 |

**为什么两条都要**：厂商支持度不一——`claude` 的工具块、`dsh` 的工具调用都没有 token 流，
只给增量则这些块永远出不来；只给快照则界面看不到「正在生成」。分标之后
**消费方可以只认 snapshot 也能正确渲染**，而想要的细腻度由 delta 提供。

### 8.2 与现有 SSE / seq 语义的关系（不变）

现行投递契约**完全保留**，规范不引入第二套流：

- `seq` 仍由 core 的 `appendEvent` 从 1 分配，单调递增；
- SSE 仍按**具名事件**发帧（`event: <type>`），清单取 `AGENT_EVENT_TYPES`（新类型自动跟随）；
- 客户端仍按 `seq` 去重、SSE 仍回放 `afterSeq` 之后的历史、行终态仍关连接；
- **「seq 回到 1 = 新一代」的重置语义不变**（重跑时 `resetEvents` 删文件）。

新增的只是事件类型，不是新的传输机制。

### 8.3 落盘策略（避免日志膨胀）

- `chunk: 'delta'` 的事件**照常落盘**（它是证据，且量小）；
- `chunk: 'snapshot'` 在**每个块完成时**发一条（不是每个 token 一条）；
- 因此一条消息最多产生「若干 delta + 若干 snapshot」，与今天的量级同阶。

## 9. 验证方案

### 9.1 每家一条映射守卫（逐块断言）

用现有夹具（`agent-fixtures.ts`）构造真实形状的厂商消息，断言投影出的
**事件类型 + 块类型 + 关键字段**。守卫必须**逐家**写，因为三家的坑各不相同。

### 9.2 必须做的变异验证（本仓硬口径）

每条守卫都要把它要拦的缺陷人为制造回去，确认守卫**失败**，再还原并核对哈希。
重点变异体：

1. claude 同 `messageId` 分次投递 → 把覆盖合并改成「**丢弃同 id 的后续投递**」，守卫必须红
   （**注**：初稿写的是「改成只取首块」，那是基于一条**错误**的代码断言——见 §5.1 的更正记录；
   现在的变异体针对的是**新规范要防的真实缺陷**：后续投递带来新块时被丢掉，于是该消息的
   `blocks[]` 永远停在第一次投递的样子。这是"看起来采到了"的典型形态）；
2. dsh 的 reasoning `text` 空串 → 改成写 `''` 而非 `null`，守卫必须红；
3. 缺失表达 → 把 `not-observed` 与 `not-supported` 互换，守卫必须红；
4. `chunk` 标记 → 把 delta 当 snapshot 覆盖，守卫必须红；
5. **`signature` 隐藏（D13）** → 把 `signature` 渲染进 `thinking` 块（或让 UI 模块读它），
   两条守卫必须红：§7.6.5 第 4 条的静态规则、以及该块的渲染断言；
6. **思考 token 的四个变异体（D14，§7.7.6）**：加进 `output`（双计）· 估算帧当结算值 ·
   `sameUsage` 不比较这一格 · 缺项写 0 —— 四个都要各有一条守卫**必须红**；
7. **`web-search` 统一禁用（D16，§7.9.3）**：三家**任一家放行**（claude 侧即把 `/claude/i`
   分档逻辑加回去）⇒ 对应守卫必须红；
8. **Workflow 开关与闸门（D15，§7.8.4）**：删掉 `enableWorkflows`（回落成"按 plan 默认"）、
   或漏注入 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8` ⇒ 守卫必须红。

### 9.3 真机验证（待办，含明确前置条件）

| 项 | 前置条件 | 状态 |
|---|---|---|
| ~~dsh 的 `subagent.started/finished` 字段~~ **✅ 已拿到，三条 stopReason 全闭合** | 提示词派生子智能体 | **✅ 真机已抓**（§6.5.1 + 2026-10-01）：顶层两条通知 + `subagent/catalog`（`one-shot`/`continuable` **两值都实测**）+ **`subagent/descriptor` 载荷已解析**（身份只在信封 `params.sessionId`，且**不是逐子任务必发**：3 子任务 2 条）。成功 `status:"ok"`+`stopReason:"completed"`、取消 `status:"error"`+`"aborted"`、**截断 `status:"ok"`+`"max-tokens"`（2026-10-01 新增）**；`error`/`refusal` 仍未观测（构造口不存在） |
| **dsh `subagent/descriptor` 的归属与载荷** | —— | ✅ **已解析（2026-10-01）**：`{version:3, mode, provider, label}`，**data 里没有 `childId`**——身份来自信封 `params.sessionId`（= 子会话 id）；且它与 catalog **不同数** ⇒ **不得当身份来源** |
| **claude 的子智能体原生消息** | —— | ✅ **真机已抓**（§6.4.1）：`task_started`/`task_notification`/`task_progress`/`task_updated` 默认就发，归属键三方同值 |
| ~~**codex `SubagentStop` 是否真有 `status`**~~ **✅ 真机已抓（2026-10-01）** | 打通 `multi_agent` + hook | **✅ 结论：没有 `status`**。真机载荷 12 字段（逐字见 §6.4 开头），**证据等级从「schema 级」升到「真机」**；⚠️ 同时更正 §7.5.5 ⑤：真机比 `SubagentStart` **多三个**字段（漏了 `stop_hook_active`） |
| **思考 token 的结算值（三家各一次）** | —— | ⚠️ **两家已定、一家待补（2026-10-01）**：**claude ✅ 有真机取值**（19/19 样本，取值 0~1401，**恒 ≤ `output_tokens`**，零违例）⇒ 升 `'yes'`；**dsh ✅ 定案为结构性不可达**（`dsh-llm-pi-ai` 的 `mapUsage()` 从不写 `reasoningTokens`）⇒ 记 `'off-by-adapter'`；**codex ⚠️** 字段出现但 **3/3 恒为 0**，仍 `'unverified'` |
| **claude 的 `thinking_tokens` 在第三方后端上恒 0（2026-10-01 新增登记）** | —— | ⚠️ **后端相关，不是能力结论**：经 DeepSeek 的 **anthropic** 兼容端点时 `output_tokens_details.thinking_tokens` **恒为 0**，而同一 run 里模型**确实产出了 thinking 正文**——因为该端点**根本不返回思考 token 字段**（它的 **openai** wire 才返回 `output_tokens_details.reasoning_tokens`）。⇒ 规范加一条口径：**`thinkingTokens: 0` 不得读成"这家不思考"**，在第三方后端上它只意味着"上游没报" |
| **claude 的 `system/thinking_tokens` 帧体量** | —— | ✅ **已实测**（[2026-09-22-features-p5-smoke.md](../notes/2026-09-22-features-p5-smoke.md)）：一轮 **6913 条事件 / 2.1 MB**，绝大多数是它 ⇒ 支撑 §7.7.3 的"有意不投影"决定 |
| ~~**claude 的 Workflow 会不会被触发、闸门吃不吃**~~ **✅ 三条判据全部有结论（2026-10-01）** | 提示词要能触发 workflow | **✅ 真机已跑**（§7.8.4）：① 闸门日志**出现了但只在 CLI 的 debug 日志上**（stdout/stderr ✗；需 `--debug`/`--debug-file`），对照干净；② DeepSeek 后端**真能驱动 Workflow**（6 跑 5 中，12-agent 编排真跑完）；③ **规模告警进不去任何可见流**（stdout/stderr/debug/SDK 全 0 命中，遥测通路也不承载它）⇒ §7.8.1 ③ 退化成纯计数留痕 |
| **dsh 的 `ask_user_question` 挂载** | —— | ✅ **真机确认**（2026-09-30）：`request/header` 的 `tools[]` 里出现 `{"name":"ask_user_question", …}`，且模型在提示下主动说出该工具名 |
| **dsh 的 `todo_write` 真机形状** | —— | ✅ **已拿到**（§7.6.2 ⑨）：整表覆盖实测成立；result 只给摘要句 |
| **dsh 的 `read` / `glob` 真机形状** | —— | ✅ **已拿到**（§7.6.3 补充行） |
| **codex hook 的配置格式与输入 schema** | —— | ✅ **已完成**（§7.5.5）：11 个事件名、TOML 形状、信任门、`SubagentStart/Stop` 的字段表 |
| **codex hook 的 `SubagentStart/Stop` 真实载荷** | ~~网关提供带 profile 的模型名~~ **不需要**（2026-10-01 推翻） | ✅ **两条都抓到了**（§6.4 开头 + §7.5.5 ⑩）：0.154.0 与 0.156.1 各触发 1 次；`SubagentStop` 12 字段、**无 `status`**、比 `SubagentStart` **多三个**字段 |
| **codex `spawn_agent` 根因定位** | —— | ✅ **已完成**（五步穷举，§7.5.2）——但**结论被本轮限定**：内网网关那套模型名 ⇒ `unsupported call`；**DeepSeek fallback 元数据 ⇒ 能跑**（见下面两行与 §7.5.5 ⑩ 的限定块） |
| ~~codex `spawn_agent` 真正跑通~~ **⚠️ 只在 DeepSeek 路由上跑通（2026-10-01）** | ~~网关列出带 profile 的模型名~~ **不需要** | ✅ **DeepSeek 路由 + `features.multi_agent=true` 下真跑通**：`collab_tool_call` 18 条，完整 `spawn_agent → wait → close_agent`，子智能体返回 `"1+1 = 2"`。❌ **但内网网关（适配器真实路径）复跑仍 `unsupported call: spawn_agent`** ⇒ 结论**与路由相关**；且"认不认识模型名"**不是决定因素**（两边都是 fallback 元数据）。**机制未定位**（如实登记） |
| **codex 的 `reasoning_output_tokens`** | —— | ✅ **DeepSeek 路由 9/9 非 0 且恒 ≤ `output_tokens`（2026-10-01）** ⇒ `basis` 升 `'subset-of-output'`（**带路由前提**：内网网关路径上 codex 跑不完 turn ⇒ 无样本）；⚠️ 但 `item.type === 'reasoning'` 在已观测的两条路径上**都没有**——DeepSeek 上 wire 层有（`reasoning_text` 全文 + **空 `summary`**）而事件流 0 条，网关路径**拿不到证据**（turn 提前失败） |
| **内网网关（VPN 恢复后）是否可复跑** | —— | ⚠️ **网络可达但复跑基本被挡**：① `/v1/models` **不校验凭据**（假 key 也 200）；② 推理端点只认**那把曾被明文提交的 key**（其余 10 条候选一律 401，报文「登录态丢失，请重启再试」**误导**）；③ 带 tools 的请求被网关以 `tool_choice is only allowed when 'tools' are specified` **拒掉**（codex 每次真实调用都带 tools）；④ 47 个模型里**已无 `gpt-5.5`**（上一轮唯一能跑完 turn 的名字） |
| **codex 事件 type 全集** | 曾记 5 种 → 6 种 | ⚠️ **7 种（2026-10-01 第三次修正）**：`thread.started` · `turn.started` · **`item.started`** · `item.completed` · `turn.completed` · `error` · `turn.failed` |
| **codex 0.156.1（适配器实际 spawn 的那份）能否起来** | 上一轮：`os error 5`，归因"沙箱限制 node 管道" | ✅ **归因推翻 + 边界定死**：pwsh 直跑同样报错 ⇒ 与 node 管道无关；真规则是「**exe 在工作区内 ⇒ `$CODEX_HOME` 也必须在工作区内**」。适配器 `index.ts:28` 用 `tmpdir()` ⇒ **落在失败格（0% 可用）**；两条绕行已实测（scratch 放工作区内 / vendor 外置 + `codexPathOverride`）。**机制仍未定**（无 Procmon/ETW） |
| codex 的 `agent_message` / `usage` 字段名 | 可跑通的 codex 网关 | ✅ **已证**（`GPT-5.5` 可跑完一个 turn） |

### 9.4 本次调查的复现命令（供实施阶段直接复用）

#### 9.4.1 ⚠️ 坑：用中继抓 dsh 的 SSE 时，**必须逐块转发**

**这条是本规范最贵的一课**（2026-09-30）：一次"dsh 的推理文本恒为空"的错误结论，
**根因就是探测中继写错**——它用 `await up.text()` 把整条流转成**一个 blob** 再回给 dsh，
**破坏了 SSE 的分块语义**，于是 `thinking_delta` 增量全部丢失、`block-end` 落成空块。
这个假象被写进规范，直到复核时才被推翻。

**判据**：中继必须 `reader.read()` **逐块** `res.write(chunk)`：

```js
// ✅ 正确：保持分块边界
const reader = upstream.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  res.write(value);
}
// ❌ 错误：await upstream.text() 再 res.end(text)
//    ⇒ thinking_delta 全丢，表现为「厂商不给推理」
```

**同类陷阱的通用判据**：**任何"厂商不产出 X"的结论，先证明抓取链路没有损坏 X。**
本次就是先验了**网关直连**（`thinking_delta` 86 个增量、文本非空）与**dsh SDK 原始会话事件**
（259/68/143 字符），才定位到是中继的错——**三段证据缺一不可**。

> 同一天还犯了两次同源错误，都是**"用字符串搜索当证据、没验形态"**：
> ① 在**转义后的 JSON**（`\"reasoningEffort\":\"high\"`）上查未转义的引号，匹配失败就报告"字段是空的"；
> ② 在 dump 里搜到两条同 `message.id` 就断言"代码按 id 覆盖写"（§5.1 的误诊）。
> ⇒ **判据：报告"某字段为空/不存在"之前，必须先打印它的原始形态。**


```bash
# 0. 打包 CLI 里的 workflow 旋钮（D15 的证据来源；字符串扫描，不要靠推断）
#    判据：应出现 CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS / _SIZE_WARNING_AGENTS，
#          以及日志文案 "workflow: concurrent agent gate = "
node -e "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);const t=b.toString('latin1');for(const p of ['CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS','CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS','workflow: concurrent agent gate','workflowSizeGuideline','CLAUDE_CODE_WORKFLOW_DOES_NOT_EXIST'])console.log(p, t.split(p).length-1)" \
  "<npm 全局>/node_modules/@anthropic-ai/claude-code/bin/claude.exe"

# 1. 工具面与 feature 默认值、哪些模型带 multi_agent profile
codex.exe features list | Select-String multi_agent
codex.exe debug models            # 逐个模型看 "multi_agent":{...} 还是 null

# 2. 命名空间展开的证据（用户自建本地网关，已实现）
node app.js                       # D:\zhanglei1120\coding\proxygateway → 127.0.0.1:7999
#   证据一：lib/convert/responses-builtin-tools.js 的 BUILTIN_TOOL_POLICY
#           namespace/web_search = expand；门禁只拦 drop 档（fidelity.js:80）
#   证据二（运行时）：logs/access.log 的 diagnostics 里逐字记录
#           「tools[4] 的 namespace 容器 multi_agent_v1 已展开为 5 个 function 工具
#             （close_agent, resume_agent, send_input, spawn_agent, wait_agent），由客户端执行」

# 3. 【权威】经 SDK 自身跑（与适配器同路径）——结论以这一次为准
#    放在 packages/server/agents/ 下，让 @openai/codex-sdk 可解析
#    要点：Codex({apiKey, baseUrl, config:{features:{multi_agent:true}}, env}) →
#          startThread({model:'GPT-5.5', sandboxMode:'danger-full-access', approvalPolicy:'never'}) →
#          await thread.runStreamed(prompt) → for await 收集 ev.type 全集
#    预期：5 种（thread.started / turn.started / item.started / item.completed / turn.completed）
#          且 agent_message 里出现「spawn_agent … unsupported call」的自述

# 4. 直连远程网关跑 CLI（辅助定位用；CLI 路径 ≠ SDK 路径，注意 --json vs --experimental-json）
$env:CODEX_API_KEY='<key>'
codex.exe exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox `
  -c model_provider=gw -c model_providers.gw.name=gw `
  -c model_providers.gw.base_url=http://likecode-llm-proxy-test.jd.com/v1 `
  -c model_providers.gw.wire_api=responses -c model_providers.gw.requires_openai_auth=true `
  -c model_providers.gw.request_max_retries=1 `
  -c features.multi_agent=true -m GPT-5.5 "say hi in one word"
#   观察点：是否出现 ERROR codex_core::tools::router: error=unsupported call: spawn_agent
#   五步穷举的增量开关（全部仍失败，用于复核根因）：
#     -c features.multi_agent_v2=true
#     -c agents.default_subagent_model=gt-6-sol-a -c agents.default_subagent_reasoning_effort=medium

# 5. hook 机制验证（已验证通过；把 <EVENT> 换成 SubagentStart 即目标场景）
#    config.toml（放在该行 CODEX_HOME 下）：
#      [[hooks.<EVENT>]]                       # 事件名 PascalCase；kebab-case 不触发
#      matcher = ""
#        [[hooks.<EVENT>.hooks]]
#        type = "command"
#        command = "node <abs>/hook.cjs"       # hook.cjs：读 stdin → 追加到 HOOK_LOG
#    必须带信任绕行标志，否则 hook 静默不执行：
codex.exe exec --json --dangerously-bypass-hook-trust --skip-git-repo-check `
  --dangerously-bypass-approvals-and-sandbox "say hi"
#    判据：HOOK_LOG 出现 SessionStart / PreToolUse 的 JSON 载荷即成功
```

**已知的网关侧噪声**（与 `spawn_agent` 无关，实施时别误判）：`tool_choice is only allowed when
'tools' are specified`（`gpt-5.6-*` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.4` 复现）、
`Unsupported parameter: 'messages'`（`GPT 5.3-codex`）、`invalid_encrypted_content`（`gt-6-*` 三支）。
**`GPT-5.5` 是本机唯一能跑完一个 turn 的模型名**，调试 codex 通路时先用它。

## 10. 消费方改造与历史产物处置

**口径（用户明确）：不考虑兼容，保障代码干净。**

| 消费方 | 现状 | 改造 |
|---|---|---|
| `row-live.ts` `activityOf` | 读 `log.summary`，机器载荷则保留上一句 | 改读消息事件：优先 `text`/`thinking` 块，工具块用 `tool-call.name`，`attachment` 跳过 |
| `log-format.ts` `formatEventLine` | 7 型各一行 | 新增 3 型各一行；`message` 行按块渲染 |
| `judge-agent.ts` | 读 `AgentRunResult.finalText` | **不变**（`finalText` 语义与来源不变，仍是结果块的文本） |
| `AGENT_EVENT_TYPES` | 7 项（`status`/`log`/`usage`/`diff-summary`/`score`/`error`/`end`） | 3 类消息事件 + `log` 保留 = 10 项（自动跟随 SSE 订阅） |
| `log-format.ts` 的 `usage` 行 | 用量三元组 + 轮次 | 加一段「· 思考 N」（D14，§7.7.5 #4）；`thinkingTokens` 为 `null` 时**不写这一段**（不写"未采集"以外的任何字） |
| `row-live.ts` 的 `usage` 折叠 | `tokens: null` = 这一条没带计量，保留上一份 | **同一处置**：`thinkingTokens: null` **同义**，保留上一份（否则界面上的思考 tok 会在只报轮次的事件上掉回「采集中」） |
| `metric-line.tsx` 卡片指标 | 输入 / 缓存 / 输出 / 轮次 | 可选显示思考；**不得与输出相加**——`basis` 为 `'subset-of-output'` 时相加即双计、`'unknown'` 时连跨家比较都不允许，**只有 `'additive'` 才可加**（§7.7.0） |

### 10.1 历史产物：删除，不做读侧兼容

**不做 v1 兼容分支，也不加 `messageSpecVersion` 分流**——读侧只有一套代码，契约即真相。

| 产物 | 处置 |
|---|---|
| 旧 `events.jsonl`（v1 的 7 型） | **删除**：旧 `{workspaceRoot}/{runId}/` 整轮目录不再提供读入口 |
| 旧 `run.json` | 同上（旧轮次不再出现在列表与详情里，与「改工作区根目录后旧轮次不可见」是同一类既定行为） |
| `resetEvents`（重跑清日志） | 保持不变——它本来就是「删文件而不是写空串」 |

**收益**：`AgentEventSchema` 可以是**单一版本**，没有联合类型的分支判断，
`row-stream.ts` 的「seq 回到 1 = 新一代」判据也不用为两种格式写两遍。

**代价（如实登记）**：历史评测记录不再可读。这是用户口径下的**有意取舍**，
代价由「评测数据的保留期」承担，而不是由代码复杂度承担。

> 注意与既有口径的关系：README「数据落在哪」记录的「改工作区根目录不迁移已有产物」
> 说的是**旧轮次留在旧根目录**（可恢复）；本节说的是**格式不再兼容**（不可恢复）。
> 两者是不同层面的事，实施时需要在 README 同步一句说明。

## 11. 开放问题

1. **网关侧模型名对齐（阻塞项，非本仓可解）**——需要上游提供 codex 认识的、带 multi_agent
   profile 的模型名（`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`）。这是 §7.5.3 牌 A 的**唯一前提**，
   属**外部依赖**；`gpt-6-*` 在直连时另有 `invalid_encrypted_content` 需一并解决。
2. ~~**`signature` 是否要暴露到界面**~~ **已决：隐藏**（用户口径 2026-09-30，D13）。
   它是 replay 校验串，对评测者无意义 ⇒ **不进任何面向界面 / 面向消费方的呈现**：
   渲染规则（§7.6.4 第二条）、静态守卫（§7.6.5 第 4 条）、变异体（§9.2 #5）三处都已写死。
   **但字段保留在契约里，不删**——删了它，§5.4 的 `raw` 在「归一无损」时省略，
   这一格会**静默消失**（成本一个字符串，代价是审计断链）。
   一句话：**数据留着、呈现藏起来**。
3. ~~**thinking token 计量**~~ **已决：加进 `usage`**（用户口径 2026-09-30，D14）。
   落点、契约、三家映射、能力声明与**必须同步改的四处实现点**全在 **§7.7**。
   三条最要紧的：
   ① 它是 `tokens.output` 的**子集**，**不是第四个加数**（SDK 类型面逐字 "Always ≤ output_tokens"）；
   ② **只收结算值**——claude 的 `system/thinking_tokens` 估算帧**不进计量**（SDK 逐字
   "not the authoritative billed output_tokens"），且它逐帧高频（实测一轮 6913 条事件 / 2.1 MB）；
   ③ 三家能力**一律先声明 `'unverified'`**（通道都在类型面上，但无一家有真机取值样本），
   `basis` 只有 claude 有权威证据（`'subset-of-output'`），另两家 `'unknown'`
   ⇒ **相加只在 `basis === 'additive'` 时合法**：claude 那档相加就是双计，
   `'unknown'` 期间**既不得相加、也不得跨家比较**。
4. **`todo_list` / `web_search` 这类"非四类"工具**——本设计归为 `tool-call` + `attachment`，
   是否需要更细的块类型需按使用频率定。
5. **工具名单随版本演进**——V1（`close_agent`/`resume_agent`/`send_input`/`spawn_agent`/`wait_agent`）
   与 V2（含 `followup_task`、**无** `close_agent`）不同名。规范**不硬编码工具名**
   （`tool-call.name` 原样透传），故演进不影响契约；但排障文档要记这一条。
6. ~~**`ReportFindings` 的语义未查清**~~ **已查清（2026-09-30 真机）**：它是
   **代码评审结论的结构化上报口**，面向**宿主 UI**（工具描述逐字："Report **code-review findings** as a
   typed list so **the host UI can render them**"），输入是
   `{level?, findings:[{file, line, summary, short_summary?, failure_scenario, category?, verdict?, outcome?}]}`。
   ⇒ 两轴取 **`deliver` / `user`**（§7.6.8 已改）；原占位 `deliver / agent` 是错的。
   **本项关闭。**
   同样待查的还有 `DesignSync`——**已查清（2026-10-01 复核）：它在当前的 30 项入站工具表里确实存在**，
   所以适配器注释里那句「该名字在本机 SDK 2.1.281 的工具表里不存在」**已过时**（那是更早一次采集的结论，
   而工具表随模型 preset 变化，见 §7.6.2.1b 末尾的同款提醒）。⇒ 该条不再悬置。
7. ~~**claude 的 `Workflow` 是否会被本仓配置触发**~~ **已决：允许触发，但压规模**（用户口径 2026-09-30，D15）。
   落点、语义与"哪一格才是硬闸门"全在 **§7.8**。三条最要紧的：
   ① **显式 `enableWorkflows: true`**——SDK 逐字 "Unset = **default by plan**"，那是评测环境里不可控的输入；
   ② **硬闸门只有并发那一格**：`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8`（二进制里逐字有那行
   `workflow: concurrent agent gate = …` 的日志文案）；
   ③ **「总数 ≤ 8」厂商没有开关**——`workflowSizeGuideline` 是 advisory 且档位只有 5/10/50
   （表达不了 8）⇒ 总数侧取 `'medium'` 软约束 + `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8` 告警阈值
   + 我们按 `subagent-start` **计数留痕**，**不硬拦**（硬拦要 `stopTask`，那等于评测中途改写编排）。
   作用域是 **Workflow 派生的 agent**；普通 `Task` 子智能体厂商无等价开关（§7.8.2 / §11.1 第 29 项）。
8. ~~**`request_user_input` 的 `target` 取值**~~ **已决**：新增 `ToolTarget: 'user'`
   （§7.6.8）。原方案里勉强写 `shell` 是错的——它问的对象是**用户**，不是运行环境。
9. **claude 的 `Task*` 与 dsh 的 `todo_write` 是两件事**（已决，但需落地验证）——
   已按证据确认：`Task*` 是 **SDK 的后台任务注册表**（`SDKTaskStartedMessage` /
   `SDKTaskUpdatedMessage` / `SDKTaskNotificationMessage`，带 `task_id` / `is_backgrounded` /
   `spawn_depth` / patch 式更新，且 `Query.stopTask(taskId)` 与之配套），
   **不是** agent 自撰的待办清单；而 dsh 的 `todo_write` 才是清单（整表覆盖）。
   ⇒ `Task*` 归 `job`、`todo_write` 归 `task`（§7.6.8 已更正）。
   **待落地验证**：claude 的 `TodoWrite` 是否存在于当前工具表（本机 dump 里没有）、
   若存在于哪个族。
10. ~~**`request_user_input` 会不会真的挂住**~~ **已实测（2026-09-30）：不会挂住，因为在 exec 模式
    下它结构性不可用**。开了两个开关后跑一次，全程 **18 秒**正常收场，`turn.completed` 照常发出；
    真相在 stderr 逐字：
    ```
    ERROR codex_app_server::bespoke_event_handling: request failed with client error:
    JSONRPCError { code: -32000, data: None, message: "request_user_input is not supported in exec mode for thread `…`" }
    ```
    事件流里**连一条 `request_user_input` 的 item 都没有**（只有 `error` + `agent_message`，
    模型自述"已询问用户…但当前没有收到选项回答"）。
    ⇒ 在本仓的传输路径（`codex exec` / SDK）上，该工具**不是"可能挂起"而是"不可能成功"**；
    `autoResolutionMs` 那条线索在**这条路径上无从生效**。**本项关闭**（若要真用它，得换到 app-server 交互面）。
11. ~~**claude 是否有交互类工具**~~ **已查清**：claude **有** `AskUserQuestion`
    （打包 CLI 二进制里 72 处；字段 `multiSelect`，`header` 限 **8** 字符，选项 **2–4** 个），
    dsh **有** `ask_user_question`（专用包 `@deepseek-ai/dsh-tool-ask-user`）。
    ⇒ 该族**三家齐全**，schema 已按并集重写（§7.6.2 ⑩）。
    残留已于 2026-09-30 验证：**`AskUserQuestion` 不在工具表里**（3 模型 × 2 档共 6 次采集，
    工具表恒为 30 项、无 `AskUserQuestion`），且**开 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 也不会出现**。
    但它**确实存在于产品里**：`~/.claude.json` 的 `toolUsage` 里有 `AskUserQuestion` 的历史计数
    ⇒ **是 feature-gated / 交互式会话才有，不是"这家没有"**。
    ⇒ 该族在 claude 侧的可得性应标 `'off-by-adapter'`（或 `'unverified'`），**不是 `'no'`**。
12. **`update_plan` 的 config 注入方式**（已决要打开，剩落点）——`tools.update_plan.enabled=true`
    已实测有效，但本仓要决定它进 `buildCodexConfig()` 的哪一格：
    是**恒开**（评测里始终能观察规划），还是**按行可配**（与 `features.multi_agent` 同一层）。
13. **claude 的进度清单从哪里来**（**已解决，口径更正两次**）——本机工具表里确实**没有**
    `TodoWrite`，但**有** `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`，
    受 **`CLAUDE_CODE_ENABLE_TODO_TOOLS`** 门控（§7.6.2.1b 的 A/B 实测：26 → 30 项）。
    ⇒ `task` 族**三家都有数据**，claude 走 `commitModel: 'patch-one-item'`
    （由适配器累积成整表，§7.6.2 ⑨）。**本项关闭**，剩余工作只是实现。
14. **codex 的 `PlanUpdate` 事件是否值得为它换传输层**——原生面板数据在 app-server/rollout
    协议上（§7.6.2.2），我们经 SDK 看不到。当前决定是**用工具面退化替代**。
    若将来要原生面板保真度，需评估「SDK → app-server 客户端」的迁移成本。
    **本期不做**，仅登记。
15. **dsh 的 `ask_user_question` 怎么启用**（**实测已定，剩落地**）——根因是**装配缺失**
    而非包缺失：`@deepseek-ai/dsh-tool-ask-user` 已随 dsh 0.1.7-rc.1 装好，但
    **`dsh-base` 与 `dsh-sdk-app` 两个 bundle 都没有它**（只有 `dsh-web-app` 的 preset 有）。
    实测（`--dump-config` 机械验证）：**加一行 insert 即可**
    ```yaml
    - insert:
        - id: tool-ask-user
          name: '@deepseek-ai/dsh-tool-ask-user'
    ```
    ⇒ `tool-ask-user` 在合成树里 **0 → 2 处**，**无解析错误**，且
    **不需要改 profile 的 `dependencies`**（dsh 从自身安装解析插件）。
    落点是**每行**的 `DSH_HOME/profiles/sdk/cordis.patch.yml`——
    适配器只建空 `.agenthome`、由 dsh 播种 profile，**改全局 `~/.dsh` 对评测无效**。
16. ~~**claude 的 `AskUserQuestion` 与 `TodoWrite` 是否被同一类开关门控**~~ **已查清**
    （§7.6.2.1b）：`Task*`/`TodoWrite` 自 SDK 0.3.142 起替代了 `TodoWrite`，
    且在**新模型上默认移除**，需 **`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`** 启用
    ⇒ **不是版本过低，是默认裁剪**。`AskUserQuestion` **不受该开关影响**（2026-09-30 实测：
    3 模型 × 2 档，开关前后工具表都是 30 项，增量为空）。另需更正：**`Task*` 在本版已是默认工具**
    （同一批实测的另一个结论，见 §7.6.2.1b 的更正块）⇒ 这个环境变量的作用已从"开任务工具"
    退化为"防版本回退的护栏"。
17. **`selected` 与 `custom` 的合并语义要写进 UI 契约**——dsh 逐字：
    `custom` *"**supplementing** `selected` for a multi-select question and **overriding** it
    for a single-select question"*。UI 若一律"追加"会在单选场景显示两个答案。
    （用户口径已确认为正确，待落进 UI 契约。）
18. ~~**三家开关必须同时打开才可比**~~ **已决：统一打开**（D12，用户口径 2026-09-30）。
    已落地：claude 的 `CLAUDE_CODE_ENABLE_TODO_TOOLS='1'` 进 `buildSubprocessEnv` 的 `injected`、
    codex 的 `tools.update_plan.enabled=true` 进 `buildCodexConfig`，两处**均有守卫 + 变异验证**。
19. ~~**`TaskStep` 是否要容纳 claude 独有的两格**~~ **已决：需要**（用户口径 2026-09-30）。    已加 `owner: string | null` 与 `blockedBy: string[]`（§7.6.2 ⑨），
    并写明缺失口径：另两家 `null` / `[]` = **该家无此概念**（`not-supported`），
    claude 的 `owner` 空值是 **`''`**（有概念但无人认领）——两者**实现上必须分开**。

---

### 11.1 独立审查新增的待办（2026-09-30）

> 本节各项来自一次对全文档的独立审查（对抗性、逐行核对 `providers/` 代码）。
> 前几项是**文档缺陷**（该说没说 / 说错了），后几项需要**真机**才能定。

20. ~~**§6 子任务模型需三家各自新写投影**~~ **两家已实现（2026-09-30）**：
    · **claude** ✅ 已投影（原生 `system/task_*`，§6.4）——5 条守卫 + 变异验证；
    · **dsh** ✅ 已投影（两条顶层通知 + `subagent/catalog` 关联表，§6.5）——6 条守卫 + 变异验证；
    · **codex** **通道已证可触发（2026-10-01）**：`features.multi_agent=true` + DeepSeek 路由下
    `spawn_agent` 真跑通、`SubagentStart`/`SubagentStop` 各触发 1 次、载荷已抓
    ⇒ "前提最多"里的**第三条（模型预设带 profile）已被推翻**（见 §7.5.5 ⑩ 的限定块）；
    剩下的工作是**把它投影成事件**（与 claude/dsh 同一个活）。
    **剩余（2026-10-01 更新）**：dsh 的**非成功路径**已抓到两格——
    取消 `status:"error"` + `stopReason:"aborted"`（2026-09-30）、
    **截断 `status:"ok"` + `stopReason:"max-tokens"`（2026-10-01）**
    ⇒ 那一格**不能只按 `status` 映射**（两个方向都会骗人）；`max-tokens` 已按用户口径**定案为 `'failed'`**
    （截断＝没做完），**唯一禁止的是记为 `'completed'`**（见 §6.5.2）；
    `stopReason` 值域里还剩 `error` / `refusal` 两档**未观测**（`subagent` 工具没有模型覆盖口，本机无构造法）。
    另一条同轮实测：子任务仍在跑时**直接关掉运行时**，**一条 `subagent.finished` 都不会来**
    ⇒ 派发面板会留下永不收场的条目（这是真实观测，UI 要能吃）。
21. ~~**claude 的 `subagentId` 是合成值**~~ **已关闭（2026-09-30 真机）**：
    `task_started.task_id` 是**厂商原生 id**，`vendorId` 填同一个值，**不需要合成**——
    先前的"只能合成"基于不完整的通道认知（只看 hook，没看原生 `task_*` 消息）。见 §6.4.3。
22. **`turn` 的语义撞车待定案**（§7.0.5）——本文倾向方案 ①（`turn` 正名为模型往返序号、
    dsh 另存 `vendorTurn`），因为它与本仓**已统一过**的口径（§5.1、`usage.turns`）同源。
23. ~~**codex 的 `update_plan` / `request_user_input` 落到哪个 `item.type`**~~ **已定案（2026-09-30 真机）**：
    `update_plan` → **`item.type === 'todo_list'`**（候选 ①；`item.started/updated/completed` 三态都发）。
    ⇒ §7.6.2.2 的"工具面重建面板"方案**成立**，候选 ③ 被排除。
    `request_user_input` 在 exec 模式下**结构性不可用**（JSON-RPC -32000，见 §11 第 10 项），
    因此它在事件流里**没有任何 item 落点**——这一格在 SDK 路径上应当**恒为 `null` + `not-observed`**。
    ⚠️ 新登记一条待办：`todo_list` 的事件载荷是 `{text, completed}` **二态**，
    恢复不出工具输入里的 `in_progress` ⇒ `TaskStep.status` 需要"第三态如实标 `unknown`"的口径。
24. **`parentMessageId` 在 claude 上装的是 `callId`**（§7.1）——需定案：改名，还是补一条
    统一的"父消息解析算法"。
25. **codex 的统计行不可与另两家并列**（§7.6.8）——`'shell'` / `'apply_patch'` 是规范自定名，
    在入站工具表里查不到。需给它们找真名，或把两轴表的 codex 列改用 **item 类型**做键。
    **2026-10-01 真机补充（这条把择一变成了"只有一条路"）**：`command_execution` 的 item **逐字形状**是
    ```jsonc
    {"id":"item_2","type":"command_execution",
     "command":"\"…\\powershell.exe\" -Command \"…\"",
     "aggregated_output":"","exit_code":0,"status":"completed"}
    ```
    ——**里面没有任何工具名字段**（只有 `id`/`type`/`command`/`aggregated_output`/`exit_code`/`status`）。
    ⇒ **"在入站工具表里给自定名找真名"这条走不通**（事件流与工具表之间没有可对齐的键）；
    唯一诚实的做法是**两轴表的 codex 列以 item 类型为键**（`command_execution` → `execute/shell`、
    `file_change` → `edit/file`），并把 `'shell'` / `'apply_patch'` 明确标注为**规范自定名（合成）**，
    不得当作厂商真名参与跨家比较。
26. ~~**`web-search` 族的可得性受本仓配置影响**~~ **已决：三家统一禁用**（用户口径 2026-09-30，D16）。
    三处落点与影响全在 **§7.9**：claude 的 `WebSearch` 改为**无条件禁用**（推翻 2026-09-29 的
    "按模型名分档"）、codex 保持 `tools.web_search: false`、dsh 在 profile patch 里
    `tool-web.config.search=false`；⇒ **该族在本仓恒空**，§7.6.8 的对应两行计数**恒为 0**。
    理由：`web_search` **只有 claude / gpt 系模型支持**，属**模型差异**——D12 式的"统一打开"
    在这里做不到（打开只会让"有没有联网"变成模型差异）。
    **`web_fetch` / `WebFetch` 不在本条里**（只禁搜索，不禁联网）⇒"联网能力仍不可比"，如实登记。
27. ~~**`TaskStep.id` 的来源缺一环**~~ **已闭合（2026-09-30 真机）**：`id` 来自 **`TaskCreate` 的返回**——
    结构化旁路逐字 `{"task":{"id":"1","subject":"…"}}`（序号字符串），于是 §7.6.2 ⑨ 的候选 ① 成立、
    **`blockedBy` 可以解析**（`TaskUpdate` 返回 `{"success":true,"taskId":"1","updatedFields":["status","blockedBy"],…}`、
    `TaskGet` 返回 `{"task":{…,"blockedBy":["2"]}}`）。
    ⇒ claude 侧的"依赖"维度**不再落空**；候选 ②（hook）/ ③（自己发号）都不需要用。
    两条附带实测：①`TaskList` 在**未指派**时**不出现 `owner` 字段**（设计稿 §7.6.2 ⑨ 写的
    `id/subject/status/owner/blockedBy` 是"指派后"的形状）；②**冷存储下 `Task*` 必失败**——
    `<HOME>/.claude/tasks/<sessionId>` 与其中的 `.lock` **目录** CLI 都不建，
    工具对 ENOENT 未兜底（`ENOENT lstat '…tasks/<sessionId>'` → `ENOENT …/.lock` → `EPERM mkdir '…/.lock.lock'`）
    ⇒ 本仓若要用 `Task*`，**必须自己先把这两级目录建出来**（这是厂商侧可复现的缺陷形状）。
28. **§3 的 `messageCapability` 守卫尚不存在**——§3 写「由 `registry.test.ts` 守卫每家显式声明」，
    但该守卫**目前不存在**（`registry.test.ts` 守的是既有的 `capability` 四格与 `reasoningEfforts`），
    且 `messageCapability` / `AgentMessage` / `ToolData` 在代码里**零命中**（v2 消息模型尚未实现）。
    ⇒ 措辞需改成"**待实现**"，或实现时补上守卫。
    **（2026-09-30 追加）** 该守卫还要**同时覆盖 §7.7.4 新增的 `usageCapability`**：
    它有两格（`thinkingTokens` / `thinkingTokensBasis`），且 `basis` 现在三家全都对
    ——**"没声明就用默认值"会让 `basis` 悄悄落成 `'unknown'` 或更糟的 `'subset-of-output'`**，
    正是这条守卫要拦的形态（与 `liveUsage` 那条"不许靠默认值蒙混"同一条口径）。
29. **`local_agent` 不受 8 的上限约束（本期登记的缺口，D15）**——用户口径的"限制最大 subagent 8 个"
    落在厂商唯一的硬闸门上（`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`，**并发**），
    而它是 **workflow 专属**的：普通 `Task` 子智能体（`task_type === 'local_agent'`）
    **没有任何厂商开关**（`sdk.d.ts` 里 `maxConcurrent*` / `maxAgent*` / `maxSubagent*` 零命中）。
    ⇒ 本期的处置是**明确作用域 + 如实登记**（§7.8.2），**不自己造拦截**
    （数到第 9 个就 `stopTask` 会在评测中途改写模型编排，并把"编排规模"这个应被观察的量抹掉）。
    **若要给 `local_agent` 也加硬上限，那是另一条口径**，需用户确认后再设计。
30. ~~**dsh 的 `tool-web` override 是"合并"还是"整份替换"未验证**（D16）~~ **已机械核对（2026-10-01 真机）：整份替换（REPLACE）**。
    判据是 `dsh --profile sdk --dump-config` 的**合成树**（同版本、只切一个 patch）：

    ```yaml
    # 基线（无 patch）
    - id: tool-web
      name: '@deepseek-ai/dsh-tool-web'
      config: { fetch: true, searchTimeoutMs: 60000 }
    # 只写 search:false
    # == @deepseek-ai/dsh-base, patched by …\tool-web.patch.yml
    - id: tool-web
      config: { search: false }           # ← fetch 与 searchTimeoutMs 都没了
    ```

    **设计稿没写到的一截（本轮新增，必须一起登记）**：合成树里的 config 会**再过一遍插件自己的 zod schema**，
    而 `@deepseek-ai/dsh-tool-web/lib/index.js` 逐字是
    `fetch: z.boolean().default(true)`、`searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS /* 3e4 */)`。
    ⇒ 只写 `{ search: false }` 时，**`fetch` 会回到 `true`（web_fetch 不消失），但 `searchTimeoutMs` 静默 60000 → 30000**——
    "顺手改掉 `web_fetch` 行为"这件事**真会发生**，形态是**超时预算腰斩**而不是"关掉"。
    这一格 `--dump-config` **看不到**（它只 dump 声明层，不 dump zod 解析后的值）⇒ **只靠 dump 会漏判，必须读插件源码**。

    **修法（已实测成立）**：三格一起写出——
    `config: { search: false, fetch: true, searchTimeoutMs: 60000 }` ⇒ 合成树逐字保留三格。
    证据：`packages/server/agents/probe/dumps/v4/dsh-tool-web-override.json`（含 `baseline` / `patched` / `fixed` 三档）。

## 12. 本期不做

- 不读厂商会话文件（rollout / rollout-*.jsonl）作为**主**数据源——与「轮次计数」既有取舍一致；
  **唯一例外是 codex 的 subagent**：因为事件流结构性地拿不到（§7.0），
  该格允许 `source: 'session-file'` 且**必须标出来源**。优先顺序是 hook → session-file；
- 不做跨轮趋势统计、不做块级 diff 对比；
- 不改 `finalText` 的语义与评分通路；
- **不直接操作厂商 CLI**（不 spawn、不解析 CLI stdout、不依赖 CLI 的非 SDK 参数）——
  本项目对 codex 的入口只有 `@openai/codex-sdk`（§7.0）；
- **不把 8 的上限也套在普通 `Task` 子智能体上**（D15，§7.8.2）——厂商没有等价开关，
  自造拦截（`stopTask`）会在评测中途改写模型编排，并把"编排规模"这个应被观察的量抹掉；
  登记为缺口（§11.1 第 29 项），要做得另行确认；
- **不为 `web-search` 族找替代数据源**（D16，§7.9）——统一禁用的目的就是让该族在
  所有模型上一致地"没有"；`web_fetch` 照旧可用（只禁搜索，不禁联网）。
