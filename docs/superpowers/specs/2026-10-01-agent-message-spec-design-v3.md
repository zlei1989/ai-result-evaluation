# Agent 消息规范 v3：契约、三家映射与实施路径

> **本文近乎自包含**：接口声明、字段含义、三家取值路径、缺失影响与实施步骤全部写在本文内。只有五处**细节的权威出处**在旁文（`2026-09-30-exec-log-drawer-redesign-design.md` §6.13 的消息级用量页脚、`2026-09-22-features-design.md` §5.1.1 的档位域与取数面、**同一份 §5.6.9 的活动行发射点全表**、`2026-10-07-codex-dsh-parity.md` §3 里那条待裁决的 `unavailable`、以及 §9.2 里那条已由提交 `e68d27a` 完成的迁移）。⚠️ 除这五处，文中另有几处**取证位置**（§9.1 的两条变异记录路径、`AGENTS.md` 的守卫纪律、被测仓库的 `CLAUDE.md`）——那些是「去哪儿看证据」，不是「细节没写」。
> **阅读顺序 = 实施顺序**：先读契约与字段映射，再按家落地实现，接着是工具族与面板投影、流式与合并、缺失影响、配置面，最后照落地清单收口。每章开头即写该章产出，可以逐章实施、逐章验证；除上一段点名的那五处，其余内容都在本文内。

## 章节地图

| 章 | 标题 | 本章产出 |
|---|---|---|
| 1 | 术语与约定 | 三家缩写、四个易混量（往返/厂商轮/步骤/**子智能体身份**）的定义 |
| 2 | 统一消息契约 | 可直接落进代码的 TypeScript 接口 + 每个字段的含义与缺失语义（含族载荷、环境信息、**读数的两个尺度**与**轮次/用量归属键**） |
| 3 | 字段级三家映射 | 每个字段在三家的取值路径、取不到时填什么、默认能力取值（含**思考强度档位**） |
| 4 | 三家实施路径 | 逐家、逐步骤的落地顺序与关键实现点 |
| 5 | 工具族与面板投影 | 10 个工具族的归一规则、三家工具名映射、2 张面板的数据来源 |
| 6 | 流式与合并规则 | 增量/快照的产出规则、覆盖合并算法、顺序保证 |
| 7 | 缺失影响矩阵 | 谁缺什么、影响什么、消费方必须遵守的展示义务 |
| 8 | 配置面 | 三家必须写死的开关与闸门，以及必须规避的配置 |
| 9 | 落地清单 | 按包与按顺序的改动面、守卫与变异验证、**本期不做的边界**，以及测试夹具的模块图判据 |
| 10 | 附录：最小实例集 | 每种块与事件的一手样例 |

---

## 1. 术语与约定

### 1.1 三家

| 缩写 | 指什么 | 取数通道 |
|---|---|---|
| `claude-code` | `@anthropic-ai/claude-agent-sdk`（Anthropic Agent SDK）驱动的 claude CLI | SDK 消息流（`system` / `assistant` / `user` / `result` / `stream_event`）+ **CLI 落盘的子智能体转录**（`<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，只用于子智能体那一份用量与轮次） |
| `codex` | **`@openai/codex` 自带的 `codex app-server`**（适配器自己 spawn，JSON-RPC / stdio；可执行文件由平台包解析，换它走 `runtimeHooks.resolveBinary`） | 协议通知流（`item/*` / `turn/*` / `thread/*`）+ 收尾请求（`thread/list{ancestorThreadId}`、`thread/read`、`thread/items/list`）——**不读会话文件、不发 hook**；子线程身份与用量都从这两条通道取 |
| `dsh` | DeepSeek Harness（`@deepseek-ai/dsh-sdk-client`） | 会话协议通知流，method 四种：`session.event` / `session.status` / `subagent.started` / `subagent.finished`（**子会话的事件在同一条流里**，靠 `params.sessionId` 分辨归属） |

### 1.2 四个易混的"轮次/步骤"量

| 量 | 定义 | claude-code | codex | dsh |
|---|---|---|---|---|
| `roundTrip` | **模型往返序号**：一次模型 API 往返 = 1，从 1 递增 | 合成：按 `assistant.message.id` 去重计数（**每会话各数各的**，主会话用行累计号，见 §2.6） | 合成：按**模型答复条目**（`AgentMessage`）的条目 id 去重计数（运行期与收尾回读共用同一个函数） | 合成：**行级合计**按 `step/start` 边界计数（不分会话 ⇒ 天然是全树的）；**消息信封这一格**取该会话自己的 `data.step`（见 §2.6） |
| `vendorTurn` | **厂商自己的轮号** | 无 | 无 | 有：`turn`（**用户轮号**，不是模型往返号） |
| `step` | **一轮内的第几次调用** | 无 | 无 | 有：`step` |
| `subagentId` | 子智能体/子线程身份 | `task_started.task_id`（同一条子任务的 `task_notification.task_id` 同值；真派发的那个与转录文件名里的 `agentId` 同值） | **子线程 id**：运行期由协作条目的 `receiverThreadIds` 给出，收尾由 `thread/list{ancestorThreadId}` 的线程 id 给出（两者同值） | 三级兜底：`subagentId` → `agentId` → `childSessionId`（与随后子会话事件的 `params.sessionId` 同值） |

`subagentId` 在三家都是**厂商原生 id**（dsh 是子会话 id，claude 是任务 id，codex 是线程 id）⇒ **子任务载荷里的 `vendorId`**（目标口径，见 §5.1；契约今天没有这一格）与它同值；codex 的消息侧靠**通知 / 协议里的线程 id** 带上这一格（`threadId === 主线程 ⇒ null`）。

`roundTrip` 三家都要合成，且计数方法不同 ⇒ **跨家比较前必须确认口径**，不要把某家偏高的近似值当成另一家的等价物。

### 1.3 四条全局约定

1. **`null` 只表示"未采集"**，永远不等于 0。缺数据一律 `null`，禁止用 0、空串、空数组冒充。
2. **不合成无法验证的值**：可以不采（`null`），不可以猜。文本类字段尤其如此——上游没给正文时，不得拿摘要、token 数或统计量顶替。
3. **每个值都带来源**：同一字段在不同家可能来自事件流、会话文件或 hook，来源必须随值一起给出，否则消费方无法判断实时性与可比性。
4. **契约里的名字不随厂商版本漂移**：事件与块的 `type` 一律 kebab-case 单词，**不复用厂商的点号写法**（`turn/end`、`subagent.started` 只出现在映射表与 `raw` 里，不进契约）；厂商原文只出现在 `name` / `vendorType` / `raw` 这类数据位上。**代理侧自己生成的 id 一律叫 `<domain>Id`**（今天只有一个：`messageId`）；`callId` / `subagentId` 是契约**对厂商 id 的改名**（值与厂商同源），厂商原始 id 另存 `vendorId`。

---

## 2. 统一消息契约

### 2.1 消息信封

```ts
/** 数据来源：决定实时性与可信度，消费方必须读。今天真正产出的只有两个值——
 *  `'wire'`（协议/通知流）与 `'session-file'`（只剩 claude 的子智能体用量那一档）；
 *  `'hook'` 与 `'aggregate'` 是**契约保留、当前没有任何产出点**（按枚举发射点核过） */
type MessageSource = 'wire' | 'hook' | 'session-file' | 'aggregate';

/** 块形态：'delta' 是增量片段，'snapshot' 是该块的当前完整内容 */
type ChunkKind = 'delta' | 'snapshot';

interface AgentMessage {
  /** 本项目生成的稳定消息 id（`run-<kind>:<seq>`，如 `run-codex:12`），与厂商 id 解耦 */
  messageId: string;
  /** 厂商侧消息/条目 id；厂商没有则为 null */
  vendorId: string | null;
  /** 说话者；codex 由条目类型派生 */
  role: 'assistant' | 'user' | 'tool' | 'system';
  /** 数据来源 */
  source: MessageSource;
  /** 模型往返序号，**正整数**，从 1 递增；三家均为合成值 */
  roundTrip: number;
  /** 厂商轮号；无则为 null */
  vendorTurn: number | null;
  /** 一轮内的第几次调用；无则为 null */
  step: number | null;
  /** 派生这条消息的那次工具调用 id；无则为 null */
  parentCallId: string | null;
  /** 子智能体身份；主线程消息为 null */
  subagentId: string | null;
  /** 块形态 */
  chunk: ChunkKind;
  /** 这条消息里的块收尾了没有：每个块都收到过快照是 'snapshot'，有块停在增量累积值上是 'open' */
  assembly: 'snapshot' | 'open';
  /** 覆盖合并键：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`（消费方按它覆盖累积） */
  mergeKey: string;
  /** 内容块，按到达顺序；**数组下标就是块序号** */
  blocks: ContentBlock[];
  /**
   * **这条消息所属的那一次模型调用**的用量（可选）。**只有 dsh 交**（取值路径见 §3.1 的 `usage` 行与 §3.2）。
   * 这条读数**不是累计、不进任何合计**，与 `roundTrip` / `step` 各自独立。
   * 缺键与显式 `null` **同义**：这条消息没有消息级用量（这一格**没有** `subagentTokens` 那种三态语义）。
   */
  usage?: UsageTokens | null;
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: unknown;
}
```

**字段缺失语义**

| 字段 | 为 `null` 的含义 | 消费方义务 |
|---|---|---|
| `vendorId` | 该家没有可用的消息级 id | 不得把它当去重键；去重与折叠按 `mergeKey`（`messageId` 只作兜底与排障） |
| `vendorTurn` | 该家没有厂商轮号 | 不得用 `roundTrip` 冒充（两者语义不同） |
| `step` | 该家没有"一轮内第几次调用" | 不得按 `step` 分组做跨家对比 |
| `parentCallId` | 该家给不出派生关系 | 子任务归属改用 `subagentId` |
| `subagentId` | 这条来自主线程 | — |
| `assembly` / `mergeKey` | 不是可空格（各恒为两个取值之一 / 一个字符串） | `'open'` 时按"未收尾"呈现；按 `mergeKey` 覆盖累积 |
| `usage` | 这条消息没有消息级用量（含「这一家根本不交消息级用量」） | **不得渲染成 0**；`null` 时界面整行不出（见 `2026-09-30-exec-log-drawer-redesign-design.md` §6.13）；不得拿它参与任何合计 |

### 2.2 内容块

```ts
interface TextBlock      { type: 'text';        text: string }
interface ThinkingBlock  { type: 'thinking';    text: string | null;
                           /** 'full' = 完整推理；'summary' = 厂商摘要；'none' = 有思考但无文本 */
                           textKind: 'full' | 'summary' | 'none';
                           /** 签名/校验串，仅审计用，不进任何呈现；无则 null */
                           signature: string | null }
interface ToolCallBlock  { type: 'tool-call';   callId: string;
                           /** 归一后的族名；无法归类时 null */
                           family: ToolFamily | null;
                           /** 厂商原始工具名（codex 可能为派生名） */
                           name: string;
                           input: unknown;      /** 原始入参，未做语义改写 */
                           /** 归一后的**族载荷**（只有 `task` / `ask-user` 两族有）；没有则 null。**可缺**（`?`）：老记录没有这一格，读侧把「键不存在」与「显式 null」当同一件事 */
                           payload?: ToolCallPayload | null }
interface ToolResultBlock{ type: 'tool-result'; callId: string;
                           /** 厂商给出的结构化结果**原文**（给了才填）；没有则 null。归一后的族字段见 §5.1 */
                           structured: unknown;
                           isError: boolean;
                           text: string;
                           /** 截断**三态**：见下方「截断的表达」 */
                           truncation: TruncationState }
interface AttachmentBlock{ type: 'attachment';  kind: 'image' | 'file';
                           path: string | null; mimeType: string | null }
interface UnrecognizedPayloadBlock
                         { type: 'unrecognized';
                           /** 'unrecognized' = 类型本身不认识；'unmapped-shape' = 类型认识但形状对不上 */
                           reason: 'unrecognized' | 'unmapped-shape';
                           /** 厂商原始类型（如 `session/title` / `todo_list`），仅供参考 */
                           vendorType: string | null;
                           raw: string | null }

/** `none` = 确认完整；`truncated` = 确认被截断；`unknown` = **没采到标记** */
type TruncationState =
  | { kind: 'none' }
  | { kind: 'truncated'; reason: string | null }
  | { kind: 'unknown' };

type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock
                  | AttachmentBlock | UnrecognizedPayloadBlock;

type ToolFamily = 'read-file' | 'write-file' | 'edit-file' | 'search-content' | 'list-files'
                | 'run-shell' | 'web-search' | 'spawn-agent' | 'task' | 'ask-user';

/** 族载荷：只给「本次调用之后的归一结果」，`kind` 与 `family` 必须对得上（`plan` ↔ `task`、`ask-user` ↔ `ask-user`） */
type ToolCallPayload =
  | { kind: 'plan';     steps: TaskStep[];         note: string | null }
  | { kind: 'ask-user'; questions: AskUserQuestion[] }

interface TaskStep        { id: string | null;                        /** null = 这一家给不出（**不自己发号**） */
                            subject: string;
                            /** 四态。`unknown` 是**独立的一档**（既不是待办也不是完成），不能并进任何一边 */
                            status: 'pending' | 'inProgress' | 'completed' | 'unknown';
                            owner: string | null;                      /** null = 这家没有「指派」这个概念；`''` = 有概念但无人认领 */
                            blockedBy: string[] | null }               /** null = 拿不到依赖表（不是空表） */
interface AskUserQuestion { header: string;                            /** 展示标签，同时是答案的配对键；厂商没给时落 `''` */
                            prompt: string;                            /** = 三家的 `question` */
                            options: AskUserOption[];
                            multiSelect: boolean;                      /** claude `multiSelect` / dsh `multi_select`（归一器两种拼写都认；只认驼峰会把它静默显示成单选） */
                            allowOther: boolean;                       /** codex `isOther`：允不允许自由输入（归一器两种拼写都认） */
                            secret: boolean }                          /** codex `isSecret`：默认遮罩（**显示口径，不是安全边界**；同样两种拼写都认） */
interface AskUserOption   { label: string; description: string | null; recommended: boolean }
```

**块的三条口径**：

- **`payload: null` 不是错误**：族不在 `task` / `ask-user` 里、或厂商形状认不出，都落它 ⇒ 消费方走通用工具行（**调用不会消失**，只是没有专门卡片）。空表（`steps: []` / `questions: []`）与 `null` 是两件事：前者是「厂商给了空表」。
- **`unrecognized` 是「原样保留」，不是「一行文字」**：正文是该载荷的原文，不得画成附件、也不得推给下载台账（台账承载不了原样载荷）。
- **`payload` 可缺**：磁盘上已有的 `messages.jsonl` 没有这一格，读侧把「键不存在」与「显式 `null`」当同一件事。工具块**只允许经适配器公共层的构造器产出**（`message.ts` 的 `toolCallBlockDraft` / `toolResultBlockDraft`，它们内联 `toolPayloadOf`；派发调用块另由各家的 `subagent` 记录走同一族载荷）——手搓块会静默少掉这一格，且公共层有一条源码级断言禁止在 `providers/**` 里手搓 `tool-call` 块。

**实例**

```jsonc
// 一条带思考与工具调用的 assistant 消息
{ "messageId": "run-7:12", "vendorId": "msg_01H…", "role": "assistant", "source": "wire",
  "roundTrip": 2, "vendorTurn": null, "step": null, "parentCallId": null, "subagentId": null,
  "chunk": "snapshot", "assembly": "snapshot",
  "blocks": [
    { "type": "thinking", "text": "先读配置再决定改哪一行。", "textKind": "full", "signature": "EqQBC…" },
    { "type": "text", "text": "我先看一下配置文件。" },
    { "type": "tool-call", "callId": "toolu_01A…", "family": "read-file", "name": "Read",
      "input": { "file_path": "src/config.ts" } }
  ],
  "raw": { /* 厂商原始载荷 */ } }

// 对应的工具结果
{ "messageId": "run-7:13", "vendorId": null, "role": "tool", "source": "wire",
  "roundTrip": 2, "vendorTurn": null, "step": null, "parentCallId": null, "subagentId": null,
  "chunk": "snapshot", "assembly": "snapshot",
  "blocks": [ { "type": "tool-result", "callId": "toolu_01A…", "structured": { "totalLines": 42 },
                "isError": false, "text": "export const config = …", "truncation": { "kind": "unknown" } } ],
  "raw": {} }
// `parentCallId` 是「**派生这条消息**的那次工具调用 id」：工具结果不派生任何东西 ⇒ `null`；
// 子智能体（侧链）消息才带它，且与 `subagentId` 同值（claude 的 `parent_tool_use_id` 一格两义）
// ⚠️ 这里的 `structured` 是**厂商结构化结果的原文透传**（claude Read 的 `tool_use_result` 里本来就有 `totalLines`）；
//    **不是** §5.1 那两列的归一字段——那些（含 `totalLines` 作为**归一结果**）今天在代码里都没有落点
```

### 2.3 行级事件

行级事件与消息**并行**输出，不进 `blocks`。八个类型：

```ts
type AgentEvent =
  | { seq: number; at: string; type: 'status'; status: EvalRowStatus }
  | { seq: number; at: string; type: 'log'; stream: 'stdout' | 'stderr';
      text: string;        /** 原始负载（排障用） */
      summary?: string }   /** 给人看的一句话；无则省略，消费方不得拿 text 顶替 */
  | { seq: number; at: string; type: 'vendor-system';
      /** 厂商系统层事实：工具面 / 斜杠命令 / 子智能体定义 / MCP 服务 / 权限档 / 输出风格 */
      tools: string[] | null;          slashCommands: string[] | null;
      agents: string[] | null;         mcpServers: string[] | null;
      permissionMode: string | null;   outputStyle: string | null }
  | { seq: number; at: string; type: 'usage'; tokens: UsageTokens | null;
      /** `tokens` 是**厂商上报的权威值**还是**我们的跑动期估算**；缺格（老事件）读侧按 `'estimated'`（安全侧） */
      tokensBasis?: 'reported' | 'estimated';
      /** 子智能体那一份用量；见下方三档语义 */
      subagentTokens?: UsageTokens | null;
      /** 子智能体那一份轮次；三档语义与上一格逐字相同 */
      subagentTurns?: number | null;
      /** 这一条读数**属于哪个会话的哪一轮**；整格缺席与显式 `null` 同义（见 §2.6）。`round` 是**正整数** */
      turn?: { subagentId: string | null; round: number } | null;
      /** 整格可选可空：老日志没有这一格；草稿层恒带（没有时间时写 `null`） */
      timing?: UsageTiming | null; turns: number }
  | { seq: number; at: string; type: 'diff-summary'; filesChanged: number;
      insertions: number; deletions: number; truncated: boolean }
  | { seq: number; at: string; type: 'score'; score: ScoreResult }
  | { seq: number; at: string; type: 'error'; message: string; stack?: string }
  | { seq: number; at: string; type: 'end'; exitReason: string };
```

- `seq` 从 1 单调递增，用于去重与断线续订；`at` 是**本项目**写入时间，不是厂商时间。
- **`end.exitReason` 的契约与值域**：契约里它是**开放字符串**（`z.string()`，刻意不引 agents 包的依赖）。实测**已观测七个值，分两层**——① **适配器层**（一次 agent 运行结束）四个：`completed` / `timed-out` / `canceled` / `error`（`AgentExitReason` 那个联合类型）；② **编排层**（同一个 `end` 事件类型，用于行级生命周期）三个：`interrupted` / `rescored` / `skipped` ⇒ 消费方**按字符串原样渲染，不要按那四个值穷举**（漏掉编排层三值时会把「被中断 / 重评 / 跳过」显示成未知）。消费侧两处口径不同：**抽屉的事件行逐字渲染**「结束 `<值>`」（`log-format.ts`）；而**事实条刻意不展示「结束原因」**（用户 2026-10-07 口径——同一格要说的处境状态徽标已经说了一遍）⇒ 它的落点只剩**事件行与台账**（`end` 事件原文）。⚠️ **它不在「原始输出」面板里**：那个面板只收 `type === 'log'` 的事件（`diagnosticsOf` 的 filter），而 `end` 不是 `log`（有一处代码注释写成「照旧落在『原始输出』与台账里」，与实现相反）。
- `usage` 的必填格只有 `turns`；`tokens` / `timing` / `subagentTokens` / `subagentTurns` 都可空。
- `tokensBasis` 说明**这一条 `tokens` 的来源**（`'reported'` = 厂商上报的权威值 / `'estimated'` = 我们的跑动期估算）：它是**每一条事件的性质**，不是这一家的静态属性，故注册表里没有对应的能力格。消费方的处置只有一处——**只有 `'reported'` 才回写行快照**，而判据写成「**只认显式 `'reported'`**」（`orchestrator.ts` 的跑动期回写段），**不是** schema 的 `.default('estimated')`：缺格的老事件与显式 `'estimated'` 走同一条路（安全侧）。估算值只走事件流给界面看。它**只描述 `tokens`**：`turns` / `subagentTokens` / `subagentTurns` 恒为权威值。
- `turns` 与 `tokens` **相互独立**：`turns` 是「到目前为止的模型往返次数」，每见到一次新往返就应发一条；`tokens` 采不到就是 `null`，不得因为 token 缺失而停发轮次。
- `timing` 的 `apiMs` / `ttftMs` 多数家没有 ⇒ 各自为 `null`；`source` 恒有值，决定这组时长能不能与另一家横着比。
- `vendor-system` **只在厂商真的投送了那一行时才有**：没有这一行的那一家不发这条事件（消费方整组走 `not-exposed`），不得发一条各格全 `null` 的事件冒充。六格各自可空，`null` = 这一格厂商没投送，`[]` = 采到了、确实是空的（两者在界面上是两句不同的话）。
- **`log.summary` 是三家共用的一份词表**（公共层 `activity.ts`，`ACTIVITY_SUMMARY_MAX_LENGTH = 120`）——它是「**此刻在做什么**」的一句话，被候选卡片底部那一行消费。客户端的判定在 `activityOf`：**`summary` 优先**，没有摘要时**回落 `text`**，但两者都要过一道「不像机器负载」的闸（整串是 JSON 对象/数组、或「`[标签]` + JSON」形态 ⇒ 挡下并**保留上一句**），空串同样保留上一句。⚠️ 接口上那条「无则省略，消费方不得拿 `text` 顶替」管的是**别把 `text` 填进 `summary` 这一格**；`activityOf` 的回落是**有守卫的**那条路（codex 的答复日志就靠它：正文本身就是人话、不带摘要）。三条口径：
  1. **只播「正在做什么」**：工具调用（带参数）、工具报错、子任务派发与收场、计划更新给摘要；**工具成功返回、推理正文、轮次播报不给摘要**（它们的落点是结果块 / 思考块 / 原始输出面板；给了摘要那一行就会停在「工具返回：<一长串路径>」这类流水账上）。
  2. **不给摘要 ≠ 不落事件**：`text` 照旧是原始负载、抽屉里逐字可见；拿掉摘要只是让活动行**保留上一句人话**。
  3. **一句话必须是一句话**：单行化 + 按长度截断（前缀如「调用工具 `pwsh`：」不计入上限）。
- **各家「在哪一条通知上发摘要」**的清单在 `2026-09-22-features-design.md` §5.6.9，本仓的落点是各家的活动行分支：命令类**在开始**（完成时**正常完成一律不播**，只有起不来 / 被拒才补一条错误摘要——退出码非零不算错）、文件改动在**完成**（`item/started` 的改动可能还是空的）、MCP 在**开始**与**报错**时、搜索与动态工具在**开始**、协作条目在**派发与收场**、**计划更新发**（见下一条）、答复在**完成**且**不带摘要**（正文本身就是人话，由 `activityOf` 直取 `text`）；**推理正文、增量、计划条目不发**（它们的落点是思考块与内容块，落进行级日志只会把抽屉灌满）。
- **`planSummary`（「更新计划：N 步」）三家共用**：`toolCallSummary` 只要命中计划类入参的任一键名（claude 的 `todos` / codex 的 `plan` / dsh 的 `steps`）就整体换成这一句，用例逐字钉住三家同形。⚠️ **「只有 codex 有原生计划通知」是另一回事**：codex 另有一条 `turn/plan/updated` 通道也用它（注释逐字「文案与另两家的清单工具同形」），而 claude / dsh 的计划更新只能从清单工具的入参认出来。
- ⚠️ **跨家一致性有守卫**：`activity-conformance.test.ts` 钉「同一件事，三家**逐字同一句**」，且**该沉默的一起沉默**（任一家给工具成功返回配摘要即红）；差异只允许出现在**厂商自己的名字**上（工具名、任务名）。**服务端这一层只产出字符串**，不碰事件形状——发不发那条 `log`、原始负载是什么，仍由各家 `events.ts` 定。

**`subagentTokens` / `subagentTurns` 的三档语义**（`tokens` / `turns` 已是「主会话 + 全部子智能体」的**合计**，这两格是其中的**分量**）：

| 取值 | 含义 |
|---|---|
| **整格缺席** | 这一条没带这一格（旧版本写的事件 / 这一条不谈它）⇒ 消费方保持上一份 |
| `null` | 有子智能体但**没采到**（含「有任何一个子智能体读失败」）⇒ 合计**退回主会话口径**（这一条只对「合计由主 + 子拼出来」的两家成立；dsh 的合计是逐条累加的流水，退不回，见 §7.3） |
| `{0,0,0}` / `0` | **确实没有子智能体**（或子智能体一个 token / 一个往返都没花） |

- ⚠️ **`null` 与 `0` 在轮次那一格上含义相反**（与用量那一格的 `null` / `{0,0,0}` 同源）：契约与日志里「没采到」与「确实没有」必须长得不一样。
- **两格恒有分量关系**：`subagentTokens ≤ tokens`（逐格）、`subagentTurns ≤ turns`。消费方按「主会话 = 合计 − 分量」推主会话那一行 ⇒ **分量与合计必须同刻成对交出**，只给分量不给合计会让那个减法算出负数。
- 写入侧的三档是**不对称**的，而且**分两层**，别把两层混起来读：
  - **适配器收尾交回那一层（`TurnFinalize`）**：分量写**显式 `null`** = 「明确没采到」⇒ **覆盖**旧值；**缺键** = 「本条不带」⇒ 保持。而**合计（`tokens` / `turns`）在这一层是「`null` 与缺键同义」**——都表示「本条不带」，**不是清空**（`turn.ts` 的接口注释逐字如此；codex 收尾在枚举失败时正是靠这个「不带」让行快照保留跑动期的主线程读数）。
  - **事件层与结果层（`usage` 事件、`AgentRunResult`）**：四格**恒在**（见 §10.4），那时的 `null` 一律是**「没采到」**。⚠️ **但「按未采集呈现」对四格不是同一句话**：`tokens` 那一格的 `null` 被读侧**有意保留上一份**（只报轮次的那一条事件不带计量；把 tok 从有数打回「采集中」比不显示更糟），而 `subagentTokens` / `subagentTurns` 的**显式 `null` 必须清掉**（否则上一版偏大的分量会留在界面上，`subagentTokens ≤ tokens` 当场被读成「主会话为负」），**只有整格缺席才保持**——两行看着像、语义相反，不许合并（落点与现状见 §9 第 17 条）。

**实例**

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 6,
  "tokens": { "input": 1219, "cached": 7040, "output": 114, "reasoningOutput": 52, "total": 8260 },
  "subagentTokens": { "input": 320, "cached": 1024, "output": 40, "reasoningOutput": null, "total": null },
  "subagentTurns": 2,
  "timing": { "totalMs": 4820, "apiMs": null, "ttftMs": null, "source": "events" } }
// 主会话那一行由相减得出：输入 899 · 缓存 6016 · 输出 74；轮次：主 4 / 子 2
```

### 2.4 计量结构

```ts
interface UsageTokens {
  /** **非缓存输入** token。三家统一口径：claude-code 与 dsh 的原文即不含缓存、原样取；codex 的 `inputTokens` 含缓存读，适配器必须减掉 `cachedInputTokens`（app-server 通道的拼写；SDK 时代旧称是 `input_tokens` / `cached_input_tokens`） */
  input: number;
  /** **命中缓存的输入** token（缓存读）。与 `input` 互斥，两者之和才是本次送进模型的 prompt 总量 */
  cached: number;
  /** 输出 token（含思考 token） */
  output: number;
  /** 其中属于思考的部分；采不到为 null */
  reasoningOutput?: number | null;
  /** 厂商自报的总量原文；它**不参与**归一后的加和关系，仅供参考 */
  total?: number | null;
}

interface UsageTiming {
  /** 整轮墙钟时长（含工具执行） */
  totalMs: number | null;
  /** 仅模型 API 往返时间；采不到为 null——不得用 totalMs 顶替 */
  apiMs: number | null;
  /** 首 token 时延；采不到为 null */
  ttftMs: number | null;
  /** 'vendor' = 厂商自报；'events' = 由事件/会话行时间戳算出（含工具时间） */
  source: 'vendor' | 'events';
}
```

派生指标一律由消费方按下列公式算，适配器不预先算比率：

| 指标 | 公式 | 前置条件 |
|---|---|---|
| 缓存命中率 | `cached / (input + cached)` | 三家同式；`input` 已归一为**非缓存输入**，分母即本次 prompt 总量（分子含在分母里，结果不可能超 100%） |
| 生成速率 tok/s | `output / ((apiMs - ttftMs) / 1000)` | 需要 `apiMs` 与 `ttftMs` 都有值；**除以 1000 是把毫秒换成秒** |
| 生成速率（退化） | `output / (totalMs / 1000)` | 无 `apiMs`，或 `apiMs - ttftMs` 不为正时使用；**分母含工具时间**，展示必须标注 |
| 首字延迟 | `ttftMs` | — |

**思考 token（`reasoningOutput`）的四条口径**：

- **它是 `output` 的子集，不是第四个加数**：`output` 已含它，任何界面与统计都**不得**把它再加进 `output`（那是双计），也不得拿它当跨家比较的分子——它只回答「输出里有多少是思考」。⚠️ **这一格的语义在三家并不齐平**：`packages/server/contracts` 里 `UsageTokens.reasoningOutput` 的注释记的是「是输出的一部分还是额外的一格，三家口径不同」，codex 一档已有 **9/9** 真机读数支撑 `reasoning_output_tokens ≤ output_tokens`（可升为「子集」），而 claude 那一档是 `output_tokens_details.thinking_tokens`（恒 ≤ `output_tokens`）、dsh 的 `reasoningTokens` 走单列。⇒ 消费方按「**不得再加进 `output`**」这条硬规则做即可，**不要**据此断言三家的 `output` 含推理的机制相同。
- **只收结算值**：跑动期的估算帧（claude 的 `system/thinking_tokens` 一类）不进这一格，也不落 attachment；采不到就 `null`，**绝不填 0**（`0` 会被读成「这次没思考」）。
- **去重比较必须纳入这一格**（⚠️ **当前未落地**：`turn.ts` 的 `sameTrio` 只比 `input` / `cached` / `output`，`reasoningOutput` / `total` 不在判据里——它比的是 `AgentRunResult['tokens']`（三格类型），见 §9 第 18 条 ⑤）：同一条读数的去重判据只比那三项时，「只有思考 token 变了」的新值永远发不出去（界面冻在第一次的读数上）。
- **`modelUsage[].thinkingTokens`（claude）只作交叉校验，不作主源**——⚠️ **本节是未落地的设计说明**：适配器今天没有读 `modelUsage` 的落点。设计口径：它的范围比 `result.usage` 大（含后台任务 / 侧链 / 上下文压缩），将来收编时两者不一致应落一条 WARN，**不静默挑一个**、也不把两个数平滑混用。

**求和口径（三家共用同一份实现，各家不自己写加法）**

- **子智能体那一份** = `sumUsageTokens(各子会话/子线程/子智能体文件的用量)`：逐格相加 `input` / `cached` / `output`；`reasoningOutput` **一格都没采到才是 `null`**（有一格就相加）；`total` **不相加**（它是厂商自报的**单个会话的累计快照**，相加得到的是我们的算术，与「厂商原文」那一格的语义冲突）⇒ 子智能体那一份的 `total` 恒 `null`。
- **合计** = `addUsage(主会话, 子智能体那一份)`，三条口径：
  1. **子那一份逐格为零 ⇒ 返回主会话原样**：加一个零必须是恒等变换，否则会把厂商自报的 `total` 抹成 `null`（没有子智能体的行正是这一档）；
  2. **主会话拿不出来 ⇒ `null`**：绝不拿子那一份冒充总数；
  3. **子那一份读失败 ⇒ 主会话那一份**：这就是「全量或 null」第三档的落点。
- **「全量或 null」**：分量的读数是**全量或 `null`，没有部分和**——只读到一部分时交出去的那个数既不是合计也不是主会话，而界面上它与全量合计长得一模一样 ⇒ 宁可不出数，并落一条**点名**（哪个子智能体 / 子线程 / 文件读不到）的 WARN。
- **落点**：`EvalRow.tokens` / `turns` 是**合计**，`EvalRow.subagentTokens` / `subagentTurns` 是**分量**，四格同源（`usage` 事件 → 适配器结果 → 行快照）。后两格是**可选格**：老 `run.json` 没有它们，写成必填会让 `listRuns()` 静默跳过老记录。

### 2.5 读数的两个尺度（会话尺度 / 行尺度）

同一个字段里的 `tokens`，在两家适配器里**不是同一把尺子**，消费方必读：

| 尺度 | 含义 | 出现处 |
|---|---|---|
| **行尺度** | **整行**（主会话 + 全部子智能体）的累计 | `dsh` 的**每一条**读数——含带会话身份的那些（`assistant/message` 的用量**无条件**并进 `state.usage*`，交出的都是全树累计） |
| **会话尺度** | **那一个会话自己**的累计 | `claude-code` 的**每一条**读数；dsh / codex 的**分量**格（`subagentTokens` / `subagentTurns`，见 §2.4） |

- **`turn` 决定这条读数的归属口径，但不改变行的合计口径**（见 §2.6）：契约的口径是「`subagentId` 非空的那一条里，`tokens` 是**那个子会话自己**的累计」，此时**不许**拿 `tokens − subagentTokens` 去反推它里面的主会话——那个减法只在**主会话读数**上成立。⚠️ **今天没有任何一家落在这条口径上**：claude 与 codex 的 `turn.subagentId` **恒 `null`**（前者 `events.ts` 四条出口全写 `{ subagentId: null, round }`，后者运行期与收尾同形），唯一会带身份的 **dsh 又恰是例外**——它带身份的读数也是**全树累计**（见下一行）。所以这条规则今天**空转**，留着是为了「将来某一家（或 dsh 改口径）带身份的读数」不被静默地按会话尺度读。
- ⇒ **带会话身份的读数不是行级读数**：到 `turn.subagentId` **非空**那一条为止，行级两格（卡片 / 抽屉事实条）只认 `subagentId` **为空或缺省**的那一条，读侧按会话身份过滤（判据各落一处：`client/src/row-live.ts` 与 `apps/web-next/src/log-drawer-state.ts`）；**行快照不过滤**（`orchestrator.ts` 的 `patchRow` 照单全收——dsh 带身份的读数就是本行累计）。⚠️ **这道过滤今天只对 dsh 生效**：claude / codex 的读数一律 `subagentId: null` ⇒ 对这两家是**空操作**。
- ⚠️ **同一道过滤落在 dsh 身上是「有界的过度过滤」**：它挡掉的是一条**本来就是行尺度**的读数，最坏情形是卡片那几格在子会话干活期间冻在上一条主会话读数上（**不倒流**、下一条主会话读数到达即追平）。**两处不受影响**：快照那一格（`patchRow` **不加**过滤——dsh 带身份的读数就是本行累计）；codex（它的 `turn.subagentId` 恒 `null` ⇒ 过滤是空操作）。
- **真正的收口方向是让生产侧把尺度写进读数**（加一格尺度标记，或让 dsh 只累主会话 + 分量）：读侧修不干净（`row-live.ts` 的折叠函数拿不到 provider）。未做。

### 2.6 轮次与用量的归属键

每一条 `usage` 事件可以带一个**归属键**，说明「这次读数发生在哪个会话的哪一轮」：

```ts
/** 这一条读数**属于哪一轮**。整格可选：缺键与显式 `null` 同义（没有归属信息） */
turn: { subagentId: string | null;   /** 会话身份，与 `SubagentRecord.subagentId` / `LogTurn.subagentId` 同一套 id；`null` = 主会话 */
        round: number } | null       /** **该会话自己的**第几次模型往返（每会话各自 1..N），**不是**本行累计轮次 */
```

- ⚠️ 它与同一对象里那个**必填**的 `turns`（本行累计轮次，服务进度条与 `EvalRow.turns`）**不是一回事、不得互相顶替**：`turns` 回答「这一行跑到第几轮了」（行的尺度），`turn` 回答「这一条读数发生在哪一轮」（会话的尺度）。
- ⚠️ **整格可选是硬要求**：磁盘上已有大量没有这一格的 `usage` 行，写成必填会让老日志在回放 / SSE 续订时成片解析失败。读侧把「键缺席」与「显式 `null`」当**同一件事**。草稿层（`AgentEventDraft`）**恒带这一格**（没有归属时写 `null`），与 `timing` / `subagentTokens` 同一条处置：草稿层少一种形态，就少一处「某家用 `undefined`、某家用 `null`」的漂移。
- 传播链（**只到界面为止**）：`TurnProjection.turn` → `AgentEventDraft` → `AgentEvent` → 界面 `RowEvent.turn`。**`EvalRow` / `run.json` / `RowLiveMetrics` 一概不改**——它只服务抽屉的落点，不是行级事实（行级事实已经在 `tokens` / `turns` 上）。
- 三家的归属实现：

  | 家 | 归属键 | 配套要求 |
  |---|---|---|
  | dsh | `(sessionIdProfileSubagent(sessionId), data.step)` ——`data.step` 是该会话自己的步号（主会话真机 1,2,3；子会话也从 1 起） | 消息信封的 `roundTrip` **同步改用它**（不再用全局 `state.turns`），否则主会话时间轴会出现 `1,2,5,6` 的洞。**`state.turns` 照旧全局自增**（`EvalRow.turns` 与「主 + 全部子」的口径靠它）。**没有 `data.step` 的出口**（`turn/end` 实测不带 step、形状异常时也可能缺）取**该会话上一次见到的 step**（一张按会话分组的小表，与 `sessionUsage` 同一处、同一个 `resetDshMessageStateForTesting`）；**不得回落 `state.turns`**（那正是要消灭的错位）；一次都没见过该会话的 step ⇒ `turn: null` |
  | claude-code |  `(null, state.turns)` 恒成立——读数只由**主循环**消息触发（`parent_tool_use_id` 非空的侧链**一条 `usage` 事件都不发**，发射门槛是轮次） | **侧链消息按每会话自己的号编号**（`roundTripOfSession`：按 `parent_tool_use_id` 分组、每组数**去重后的 `assistant.message.id` 个数**，首次出现顺序 = 1..N），否则子会话那几十条消息全挤在父会话派发的那一轮里（该节点只剩一个轮次行）。主会话仍用 `state.turns` 那一套；流式增量那条路走**同一个**函数 |
  | codex | `(null, state.turns)`（通知流只给主线程读数，子线程的条目不产 `usage` 事件） | **计数键收窄成只数 `agentMessage`**，运行期与收尾回读**共用同一个函数**（按线程分别去重）。理由：两把尺子都得从**两侧都能看见的东西**上数出来——`reasoning` 条目在部分路由上根本不投送（既有口径被它系统性抬高）。**语义变化如实登记**：codex 的「轮次」从此是「模型答复条目数」，比既有近似口径**更低**；一个 `AgentMessage` 都没有的运行 ⇒ 轮次 `null`（界面显示「未采集」）。子线程自己的轮次号仍是**每个文件各自从 1 数**，与归属键各说各话 |

- 「谁是子会话」的判据与消息归属共用同一份（dsh 见 §4.3 步骤 4 的三级兜底；claude 用 `parent_tool_use_id`；codex 用子线程 id）。

### 2.7 能力声明

每家每次运行都带一份能力声明，说明"这次到底能拿到什么"。取值五态：

```ts
type Capability =
  | 'yes'                    // 有值，且来自厂商原生字段
  | 'no'                     // 这家结构上就没有这个能力
  | 'unverified'             // 没验证过，不要当有也不要当没有
  | 'off-by-adapter'         // 厂商有，但当前实现没接
  | 'not-projected-by-vendor'; // 厂商侧有数据，但不投送到我们拿得到的通道

type MissingReason =
  | 'not-supported'   // 这家结构上就没有这个概念（换配置 / 换路由都没用）
  | 'not-exposed'     // 厂商有数据，但没投送到我们读得到的通道
  | 'not-observed'    // 厂商有、通道也有，但我们没接；或本次运行里根本没出现（用户没派生子智能体一类）
  | 'unverified';     // 有通道但没验证过，不敢说采到了

interface MessageCapability {
  thinkingText: Capability;      thinkingTextKind: 'full' | 'summary' | 'none';
  toolInput: Capability;         toolResult: Capability;
  subagent: Capability;          streamingDelta: Capability;
  /** 下面五格的取数通道；对应那格为 `'yes'` 时必填，其余情况为 `null` */
  thinkingTextSource: MessageSource | null;    toolInputSource: MessageSource | null;
  toolResultSource: MessageSource | null;      subagentSource: MessageSource | null;
  streamingDeltaSource: MessageSource | null;
  /** 下面五格为什么取不到；对应那格非 `'yes'` 时必填，`'yes'` 时为 `null` */
  thinkingTextReason: MissingReason | null;    toolInputReason: MissingReason | null;
  toolResultReason: MissingReason | null;      subagentReason: MissingReason | null;
  streamingDeltaReason: MissingReason | null;
  /** 这一族能力成立的**前提**（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  notes: string[];
}
```

规则：

- **通道与原因逐格声明**，不是整份声明一份：同一条通知流里，一格可以「有数据但没投送到我们读得到的通道」（dsh 的正文增量：`streamingDelta: 'not-projected-by-vendor'` + `'not-exposed'`），另一格照样是 `'yes'` —— 两件事必须能同时表达。
- 取值为 `no` / `not-projected-by-vendor` / `off-by-adapter` 的格**必须**配一条 `MissingReason`，对应关系为 `no → 'not-supported'`、`not-projected-by-vendor → 'not-exposed'`、`off-by-adapter → 'not-observed'`（当前实现没接这一格）或 `'unverified'`（只做过部分验证）。`unverified` 这一态本身就是 `'unverified'`；它只用于确实没验证过的格，不得当成"没有"。⚠️ **守卫分两层，别只记一处**：`superRefine` 拦**三条**——「`'yes'` 无 `source`」、「非 `'yes'` 无 `reason`」，以及「`thinkingText` 非 `'yes'` 而 `thinkingTextKind` 不是 `'none'`」；**上面这组「哪一态配哪一条原因」由三家的一致性套件拦**（`providers/conformance/kit.ts` 的 `REASON_BY_CAPABILITY`，三家各接入一次）。⚠️ **有两条今天没有守卫**：「非 `'yes'` 的 `source` 必须为 `null`」与「`'yes'` 的 `reason` 必须为 `null`」——属待补。
- **今天真正被声明出来的只有两个态**（按枚举发射点核过）：`'yes'`（三家合计 18 格）与 **`'not-projected-by-vendor'`（只有 dsh 的 `streamingDelta` 一格，配 `'not-exposed'`）**；`no` / `off-by-adapter` / `unverified` 三个态与 `'not-supported'` / `'not-observed'` / `'unverified'` 三条原因**今天只有契约与用例、没有产出点**（§3.5 的逐格表就是这一事实的展开）。⇒ 消费方**照契约处理五态四原因**，但别指望今天能收到那三态；写实现时也不要把「今天没人产」当成「可以省掉那一支」。
- 取值为 `'yes'` 的格**必须**同时给出它那一格的 `source`（值从哪条通道取到）；其余四态的 `source` 为 `null`。
- **能力随路由翻转**：同一份能力位在不同路由下取值不同（codex 的多智能体在会拒绝命名空间工具的路由上被判 `unsupported call`，在另一条路由上整条派发链跑得通）⇒ 必须把路由与模型名写进 `notes`，不得把某一条路由上的取值写成这家的固有属性。
- `thinkingTextKind` **不是**能力位，是"思考文本属于哪一档"的取值（`'full'` 完整推理 / `'summary'` 厂商摘要 / `'none'` 有思考但无文本）：它随 `thinkingText` 一起声明，`thinkingText` 非 `'yes'` 时按 `'none'` 填。

### 2.8 子任务行

子任务不走 `AgentMessage`，而是一行一子任务的记录：

```ts
interface SubagentRecord {
  /** 子智能体/子线程身份；与厂商 id 同值 */
  subagentId: string;
  /** 展示名；采不到为 null（消费方显示身份前 8 位） */
  name: string | null;
  /**
   * **厂商原文**的派发方式（`spawn_agent` / `subagent` / `Task` / catalog 的 `mode` / 协作动作名…），
   * 采不到为 `null`。⚠️ **不做归一、也不得拿它判「哪次调用是派发点」**：三家填进来的是三种东西
   * （见 §3.3 / §5.5），派发点只认调用块的 `family` / `name` 与 `parentCallId`（见 §5.1）。
   */
  kind: string | null;
  /** 这行记录的数据来源 */
  source: MessageSource;
  /** 归一到五种之一；厂商没给状态且无法推导时为 'unknown' */
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  /** null = 状态已采集到；非 null = 未采集到的原因 */
  statusMissing: MissingReason | null;
  /** 结果摘要（子智能体的最终答复）；取消场景可能为 null */
  outcome: string | null;
  /** **派生这个子任务的那次工具调用 id**；给不出为 null。与消息的 `parentCallId` 同源同义 */
  parentCallId: string | null;
  /** 嵌套父链；顶层子任务为 null（父就是主会话时也记 null） */
  parentSubagentId: string | null;
  /** 该子任务自己的用量；采不到为 null */
  usage: UsageTokens | null;
}
```

四条硬规则：

- **状态与"状态是否采到"分开记**：`status` 永远给一个可渲染的值（采不到就 `'unknown'`），`statusMissing` 说明为什么采不到。不得用 `status: null` 表示未采集。⚠️ **界面的状态类型共七档**（契约五态 + `canceled` / `unsettled`）：其中「**未收场**」当前是用 `status: 'unknown'` + `statusMissing: 'not-observed'` **表达**出来的，`unsettled` 这一档本身**还没有产出点**（不要按它已接线去写渲染分支）。
- **`outcome` 只放文本**：厂商给的是结构化对象时取其中的文本块；拿不到文本就 `null`，不得用推理内容、工具输出或状态文案顶替。
- **`parentCallId` 是两套 id 之间的唯一桥**：子任务**记录**的身份是厂商原生 id（`task_id` / 子线程 id / `agentId`），而子智能体的**消息**挂在**派生它的那次工具调用 id** 上。少了这一格，消费方按 `subagentId` 分桶时子任务的消息会全部落回主会话或被丢掉。**给不出就记 `null`，不猜**（消费方退化为按名字认，而不是编一个）。
- **`parentSubagentId` 只在父本身也是一条子任务时给 id**：父是主会话（或主会话身份未知）时记 `null`——照抄主会话 id 会让消费方挂到一个不存在的父节点上（界面表现：进入子任务后面包屑整段消失）。

### 2.9 环境信息（与消息解耦的旁路契约）

「这一行运行在什么环境里」。**不进 `AgentMessage`**：厂商系统提示词与工具模式串可能几十 KB（并进主模型意味着每次流式提交都在搬它），而它只在环境抽屉打开时才需要。

```ts
type EnvSource = 'user' | 'project' | 'vendor' | 'observed';

type EnvItem =
  | { present: true;  id: string; label: string;
      text: string;                                  /** 长文本按**原文**给，由数据层按上限截断 */
      truncated: { reason: string; bytes: number } | null;   /** null = 完整 */
      copyPath?: string;                             /** 有约定路径时界面额外给「复制」 */
      at: string | null }
  | { present: false; id: string; label: string;
      missing: MissingReason };                      /** 「这一格没有」**必须**带原因 */

interface EnvGroup { id: string; title: string; source: EnvSource; items: EnvItem[] }

interface AgentEnvironment {
  summary: { agentLabel: string; modelId: string;
             effort: string | null;                  /** 我们**要求**的档位，不是实际生效的档位 */
             providerName: string; baseUrl: string; workspaceBase: string; baselineCommit: string };
  groups: EnvGroup[];
}
```

- **摘要里的 `agentLabel` 是显示名**（`AGENT_LABELS` 的全名，如「DeepSeek Harness」），不是 kind id：映射在数据层（`build-environment.ts`）做，界面不查「厂商 → 文案」表（那正是「UI 判厂商」）；认不出的 kind **原样回落**（老快照与将来第四家都不许编名字）。

- **四组的 `source` 回答「这条要求是谁下发的」**：`user` 用户层（附件与上下文引用，**不含用户提示词**）、`vendor` 厂商系统层（系统提示词 / 已调度的工具 / 斜杠命令与子智能体定义 / 工具模式串）、`project` **本仓**下发的运行配置（权限档 / 被禁用的工具 / 模型与思考强度 / 工作区与基线）、`observed` 实测统计（用过的工具及次数）。
- **「已调度的工具」与「用过的工具」必须分开**：前者是厂商自报的**工具面**（`vendor-system.tools`，回答「它当时手里有什么」），后者从内容记录里的 `tool-call` 块按 `name` 计数（回答「它用了什么」）。混成一个列表就会出现「列了 30 个工具，其实只用了 2 个」的误读。
- **厂商系统层只从 `vendor-system` 事件取**，不读那条 `log` 原文（形状由厂商定、随版本漂移；逐字认字段等于把厂商适配搬进浏览器）。没有这条事件的那一家整组走 `not-exposed`。
- **适配器只负责把 `vendor-system` 发出来**，拼装（截断、字节数、组名、列表上限）在数据层，界面只渲染给到的形状。

---

## 3. 字段级三家映射

表中"路径"一律写成 `载荷 → 字段`；`—` 表示该家没有这个来源。

### 3.1 信封字段

| 字段 | claude-code | codex | dsh |
|---|---|---|---|
| `messageId` | **由适配器公共层生成**（骨架的合并器给的是 `run-<kind>:<seq>`，如 `run-codex:12`；样例里的 `run-7:12` 是同一形状的简写）——这一格供**日志与排障定位**、并作客户端**兜底**去重；折叠视图按 `mergeKey` 覆盖累积，不依赖它。它不含真实 run id，跨运行会重号，别当全局唯一键 | 同左 | 同左 |
| `vendorId` | `assistant.message.id` | `item.id`（运行期通知与收尾 `thread/read` 读回的条目同值；空串记 `null`） | `data.message.id` |
| `role` | **硬编码** `'assistant'`（`assistant` 消息）；工具结果那一半硬编码 `'tool'`（**不读** `assistant.message.role`） | **派生**（条目 kind 一律 camelCase）：`agentMessage` / `reasoning` / `plan` / `collabToolCall` / `dynamicToolCall` → `assistant`；`commandExecution`、`fileChange`、`mcpToolCall`、`webSearch` 的**结果**那一半 → `tool`（调用那一半是 `assistant`）；`userMessage`、`toolOutput`（`functionCallOutput` 的旁路副本）、`other` 不产出消息 | **硬编码**：`assistant/message` 与 `tool/call` → `'assistant'`；`tool/result` → `'tool'`（**不读** `data.message.role`） |
| `source` | `'wire'`（SDK 消息流） | `'wire'`（通知流与收尾 `thread/read` **都算 wire**：适配器只从协议取数）——**没有会话文件通道、也没有 hook 通道** | `'wire'`（会话通知流） |
| `roundTrip` | 按 `assistant.message.id` 去重计数；**只数主循环**（侧链消息的 `parent_tool_use_id` 非空 ⇒ 不计入）**但按每会话自己的号编号**：侧链按 `parent_tool_use_id` 分组、每组数去重后的 `message.id` 个数（首次出现顺序 1..N），主会话仍用 `state.turns`（见 §2.6）；**一次都没数到时给 1**（这一格是必填正整数） | 按**模型答复条目**（`item.kind === 'agentMessage'`）的条目 id 去重计数，**运行期与收尾回读共用同一个函数**（`countRoundTrips`，按线程分别去重）；**一次都没数到时给 1** | 按 `step/start` 事件边界计数（不分会话 ⇒ 合计天然是全树的）；**消息信封这一格取该会话自己的 `data.step`**（见 §2.6） |
| `vendorTurn` | `null` | `null`（`turn_id` 是字符串稳定标识，不是序号 ⇒ 不冒充数字） | `data.turn`（用户轮号；**不是** `data.message.turn`） |
| `step` | `null` | `null` | `data.step`（**不是** `data.message.step`） |
| `parentCallId` | `parent_tool_use_id`（与工具调用 id 同空间；子智能体消息上它与 `subagentId` **同值**） | `null`（协议条目不带派生关系；子智能体消息的归属改用 `subagentId`。⚠️ **子任务行**那一格另有值，见 §3.3） | `null`（真机通知载荷没有子会话 id / `agentId`，而 `subagent` 工具调用的 `callId` 是 `call_…\|<uuid>` 复合形状、与身份不是同一个值 ⇒ 给不出就不猜） |
| `subagentId` | `parent_tool_use_id`（侧链消息；主循环为 `null`） | 子线程 id（= `receiverThreadIds` 的元素 / `thread/list` 的线程 id；主线程为 `null`） | 三级兜底：`subagentId` → `agentId` → `childSessionId`（与 `params.sessionId` 同值） |
| `chunk` | 恒 `'snapshot'`（完整 `assistant` / `user` 消息）；`stream_event` 的增量才是 `'delta'`，而该选项当前未开（见第 7 章）；**即便开启也只覆盖主会话** | `'snapshot'`（`item/completed` 的条目）与 `'delta'`（`item/agentMessage/delta`、`item/reasoning/textDelta`、`item/reasoning/summaryTextDelta`）**两种都有**；⚠️ `item/started` 的推理条目不产块（那一刻 `summary` 与 `content` 都还是空数组） | 恒 `'snapshot'`（块取自 `assistant/message.content[]`，`data.stream[]` 未接） |
| `raw` | 该条 SDK 消息原样 | 该条通知或 `thread/read` 条目原样 | 该条通知原样 |
| `usage`（消息级） | `null`（**不交**：wire 上它的 `output_tokens` 在本仓网关下恒 0 ⇒ 照快照求和会得出「这条没产出」的静默假数） | `null`（**不交**：协议只到**线程级**累计（`ThreadTokenUsage{total,last}`），对 `total` 差分在并发子线程与 turn/item 边界不一致时无法证明归属） | `assistant/message` 的 `data.usage` 三项原文（`inputTokens` / `cacheReadTokens` / `outputTokens`）；**三项缺一 ⇒ 整格 `null`，不填 0**；主会话与子会话**同一个函数**产出（`dshAssistantMessageDraft` 不分会话） |

### 3.2 内容块

| 块 | claude-code | codex | dsh |
|---|---|---|---|
| `text` | `assistant.message.content[type=text].text` | `item/completed` 的 `agentMessage.text`（**空串不产块**）；增量来自 `item/agentMessage/delta`；`content[].text` 拼接那一条只对 `userMessage` 成立 | `assistant/message` 的 `data.message.content[type=text].text`（整块快照） |
| `thinking` | `assistant.message.content[type=thinking]`（`thinking` + `signature`）；流式为 `thinking_delta` / `signature_delta` | **通知流** `item/completed` 的 `reasoning`：`content[]` 拼行非空 ⇒ 正文（`textKind:'full'`）；`content[]` 为空但**增量已把全文推完**（`item/reasoning/textDelta` 的台账）⇒ 用增量正文封口（仍是 `'full'`）；两处都没正文时看**摘要**——`summary[]` 与**摘要增量台账**都为空 ⇒ `text:null` + `'none'`（**绝不回落 summary**：摘要是摘要，不是正文）；只要两者之一非空 ⇒ 出**摘要那一块**（`textKind:'summary'`）。⚠️ 两块的判据不同源（空块只看 `item.summary`，摘要块还看 `summaryTextDelta` 的台账）⇒ **只走增量摘要时会出现「`none` 空块 + 摘要块」并存**，消费方按 `textKind` 渲染即可。增量走 `textDelta` / `summaryTextDelta`，由完成通知封口 | `data.message.content[type=reasoning].text`（整块快照，`signature` 恒 `null`） |
| `tool-call` | `content[type=tool_use]`：`id` / `name` / `input` | `commandExecution` → 调用块（真名 `exec_command` **由适配器补**，条目类型名不是工具名）；`fileChange` → 调用块（`apply_patch`，`edit-file` 族）；`mcpToolCall` → 调用块（`callId` = 条目 id、`name` = `<server>.<tool>`、`input` = `arguments`，**不属十族** ⇒ `family: null`）；`webSearch` → 调用块；`dynamicToolCall` → 只出调用（`namespace.tool`）；`plan` / `turn/plan/updated` → 计划块（`task` 族）；`collabAgentToolCall` → 协作调用块；`userMessage` / `toolOutput`（`functionCallOutput` 的旁路副本）/ `other` **三个条目类型一条事件都不落**（块与 `log` 都没有，原始负载只留在同一份通知里）。⚠️ 落 `log` 的是**未识别的通知方法**（`other` 那一支），而且那条 `log` 的正文只有 `{"method":"…"}`——参数在归一化时已丢 | `tool/call` 事件的 `data`：`callId` / `name` / `arguments`（JSON 字符串，要自己解析） |
| `tool-result` | `user.message.content[type=tool_result]`：`tool_use_id` / `content` / `is_error`；结构化旁路 `tool_use_result` | `commandExecution` → 结果块（`aggregatedOutput` 是 stdout 与 stderr **合流**、拆不开 ⇒ 不编 `stderr`；`structured = {exitCode, durationMs}`，**两格都取不到就整格 `null`**；`isError` 只在退出码非零时为真）；`fileChange` → `structured = {changes, status}`；`mcpToolCall` → `structured = result` | `tool/result` 事件的 `data.message`：`toolCallId` / `content[]` / `isError`；**结构化结果在 `data.meta`**（`content[]` 只是给模型看的文本） |
| `attachment` | — | — | —（**契约保留，当前三家适配器都不产出**：`attachmentBlockDraft` 在公共层有定义但无调用点） |
| `unrecognized` | — | — | —（**契约保留，当前三家适配器都不产出**，且「落点」三家不同：claude / dsh 的未识别事件落一条**保留原始负载**的 `log`；codex 的未识别**条目**一条事件都不落，未识别的**通知方法**只落一条正文为 `{"method":"…"}` 的 `log`——参数在归一化时已丢。消息侧三家都无产出点） |

**消息级用量（`AgentMessage.usage`）的实现口径**：

- **契约层可选、草稿层必填**（`MessageDraft.usage: UsageTokens | null`）：前者兼容磁盘上已有的老消息，后者由 `tsc` 把所有构造点列出来 ⇒ 不会出现「某家 `undefined`、某家 `null`」的漂移（与 `timing` / `subagentTokens` 同一条处置）。三家所有构造点 + 测试夹具里的 `MessageDraft` 字面量都要显式补 `usage: null`。
- **合并器按「带值覆盖、缺省保留」**：同一条**逻辑消息**会多次投递（增量块 / block-end 快照），`usage` 只在完整 `assistant/message` 那一次到达；后到的投递不带它时**必须保留已采到的值**。
- **取值函数是纯读**：`readUsageTokens(usage): UsageTokens | null`（不产草稿）与字段名表 `DSH_USAGE_FIELDS` 一起放在 dsh 的 **`protocol.ts`**（wire 形状的唯一真源，且它**不 import 本目录任何模块**）；`events.ts` 的 `readTokens` 改成「调它 + 落草稿」，并**继续 re-export** `DSH_USAGE_FIELDS`。
  ⚠️ **方向是硬约束**：`events.ts` 已 import `message.ts`，纯读函数若留在 `events.ts`，`message.ts` 反过来 import 它就是**循环依赖**。一份实现两处调用（防两套字段名漂移）。
  ⚠️ **仍未收口的一处**：按会话分组累加那一支（`message.ts` 的 `noteDshSessionUsage`）**仍按字面量**读 `inputTokens` / `cacheReadTokens` / `outputTokens` / `reasoningTokens` / `totalTokens` ⇒ `DSH_USAGE_FIELDS` 之外还有第二份字段名清单（正是这一句要防的漂移）。
- **一个字节都不动的行级口径**：`state.usage*` 的累加、`usage` 事件的累计里程碑、`EvalRow.tokens`、`subagentTokens` / `subagentTurns`。**消息级用量不参与任何合计**——本设计**不**承诺「Σ 消息级 = 行级」（跨投递去重与跨会话归属是另一件事）。
- 重复投递在消息级不可见：同一条消息被重投时只保留**最后一条带值**的 `usage`。

### 3.3 子任务

| 维度 | claude-code | codex | dsh |
|---|---|---|---|
| 启动 | `system` 子类型 `task_started`：`task_id` / `subagent_type` / `description` / `prompt` / `spawn_depth`。**先过形状判据**（三格至少一格非 `null`）才认；判不过的条目**不产行** | 协作条目 `item.type='collabAgentToolCall'`：`tool`（`spawnAgent` / `wait` / `closeAgent`）/ `prompt` / `receiverThreadIds` / `agentsStates`（线上是**以子线程 id 为键的对象**，归一时摊平成数组）。`item/started` 时 `receiverThreadIds` 是空数组 ⇒ 不落行（「还没建」与「建了没给 id」分不开） | `subagent.started` / `subagent.finished` 两条顶层通知；身份**三级兜底**：`subagentId` → `agentId` → `childSessionId` |
| 名称 | `task_started.description` | 线程昵称：运行期取 `thread/started` 的 `Thread.agentNickname`（真机常为 `null` ⇒ 只是兜底），收尾以 **`thread/list`** 的 `agentNickname ?? thread_spawn.agent_nickname` 为准。**不拿 `prompt` 首行充当名称**（`prompt` 只进派发调用的入参） | catalog `label`（catalog 可能先于 start/finish 到达 ⇒ 按 `childId` 记住，否则收场时名字只能是 `null`） |
| 类型 | `task_started.subagent_type` | 协作条目的 `tool`（真机取值 `spawnAgent` / `wait` / `closeAgent`）。⚠️ 它**不一定**是派发工具名——台账对每条协作条目都写、后到覆盖（见 §4.2 步骤 5） | catalog `mode`（`one-shot` / `continuable`）；收场时 `provider` 优先 |
| 状态 | `task_notification.status` ∈ `completed` / `failed` / `stopped`（`task_started` 时记 `running`）；终态是原生字段 ⇒ `statusMissing` 恒 `null` | **两处判据**：运行期 `agentsStates[<子线程 id>].status` **五档直映**（`completed`；`errored` / `notFound` ⇒ `failed`；`interrupted` / `shutdown` ⇒ `stopped`；`pendingInit` / `running` ⇒ `running`；其余 ⇒ `unknown` + `'unverified'`）；收尾由最后一条 `turn.status` 推三档（`inProgress` 算在跑），**只有一条 turn 都读不到时**才看 `thread.status`，推不出来 ⇒ `unknown` + `'not-observed'` | **按 `stopReason` 分档**（`status` 只在 `completed` 支参与）：`completed` 且 `status === 'ok'` ⇒ `completed`、其余 ⇒ `failed`；`max-tokens` / `error` ⇒ `failed`；`aborted` ⇒ `stopped`；其余（含未观测的 `refusal`）⇒ `unknown` + `unverified` |
| 结果摘要 | `task_notification.summary` | 运行期 `agentsStates[<子线程 id>].message`；收尾：子线程最后一条 `agentMessage` 的正文 | `subagent.finished` 载荷 `lastAssistantMessage` 里 `type='text'` 的块（取消时可能只有 `reasoning` ⇒ `null`，不拿推理顶替） |
| `parentCallId` | `tool_use_id`（与子消息上的 `parent_tool_use_id`、派发工具调用块的 `id` **三者同值**） | 协作条目的**条目 id**（与派发调用块的 `callId` 同值，两侧同值即可配对）。⚠️ 台账后到覆盖会让它变成**最后一条**协作动作的 id（见 §4.2 步骤 5） | `null`（真机载荷没有子会话 id / `agentId`，而 `subagent` 工具调用的 `callId` 是 `call_…\|<uuid>` 复合形状、与身份不是同一个值 ⇒ 不猜） |
| 嵌套父链 | **代码现状：恒 `null`**。`task_started` 载荷里只有 `spawn_depth`、没有父 id；SDK 类型面上的 `parent_agent_id` **在真机载荷里没出现过**，适配器因此**没有它的读取点**（不推测父节点）⇒ 层级既无父 id 也无深度（`SubagentRecord` 没有深度格，`spawn_depth` 只落事件日志）。⚠️ **不得**照字面拿 `parent_agent_id` 当父子判据——那会得出「所有子智能体都没有父」 | 线程对象的 `parentThreadId` 与 `source.subagent.thread_spawn.{parent_thread_id, depth, agent_nickname}`；**父就是主线程时记 `null`**。`depth` 读得到但**契约没有这一格**，当前不出口 | `null`（真机通知不带父 id；只有「父会话是不是主会话」这一条判据） |
| 子任务级用量 | **CLI 落盘的子智能体转录**：`<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`，按 `message.id` 去重后求和（`task_notification.usage` 是 `total_tokens` / `tool_uses` / `duration_ms` 的**异形**，没有三元组 ⇒ 不采用）。**只在收尾读一次盘**（终态通知那一帧只登记记录），全量读因此从 2 次降到 1 次 | 运行期 `thread/tokenUsage/updated` 的**按线程累计**（`ThreadTokenUsage.total`，camelCase：`inputTokens` / `cachedInputTokens` / `outputTokens` / `reasoningOutputTokens` / `totalTokens`）；三格缺任一 ⇒ `null`。协议**没有**「按线程读用量」的请求 ⇒ 只有运行期这一条来源 | 子会话 `assistant/message` 的 `data.usage` 按 `params.sessionId` 分组求和（**白名单只含本行的子会话**：那张表是模块级的，别的行的会话也在里面） |
| 子任务级轮次 | 该转录按 `message.id` 去重后的**个数**（与用量同一次读盘） | 该子线程的**模型答复条目**（`agentMessage`）`item.id` 去重后的个数（与合计同一个函数、同一把尺） | 该子会话自己的 `step/start` 计数（与合计**同一个计数点**，只是按会话另记一格） |
| 轨迹可达性 | 子智能体消息与主会话同流投送（带 `parent_tool_use_id`）；适配器已显式开 `forwardSubagentText: true`——不开时只有 `tool_use` / `tool_result` 块，看不到子智能体说的话与想的事。**token 级增量只覆盖主会话** | 运行期由**通知驱动**（子线程的 `item/*` 是否推给本条连接由上游决定），**收尾一律用 `thread/list{ancestorThreadId}` + `thread/read` 补齐**——一次拿到任意深度的后代，不扫盘、不递归发现 | 子会话事件直接出现在同一条通知流里（`params.sessionId` = 子会话 id） |
| 未收场 | 无通知 ⇒ 保持「运行中」 | 收尾读回仍拿不到终态判据 ⇒ `unknown` + `'not-observed'`（轨迹照旧补齐） | 运行时被终止时 `subagent.finished` 不会到达 ⇒ 必须显示「未收场」 |

**claude 的 `result.subagent_stats` 不在本期采集面内**：它是**未收编进 SDK 类型面**的聚合计数（`spawned` / `requested` / `max_depth` / `completed` / `failed` / `killed` / `refused` / `by_type`，可能随版本变动）。契约里的 `MessageSource = 'aggregate'`（界面也备好了「汇总」那一档）**当前没有任何产出点**：适配器不读 `subagent_stats`、不产 `source: 'aggregate'` 的子任务行、也没有「与 `task_*` 不一致 ⇒ WARN」的交叉校验。若将来收编，口径仍是：只作聚合与交叉校验，**不得作为逐个身份的来源**，与 `task_*` 不一致时**以 `task_*` 为准**并落一条 WARN。

### 3.4 计量

| 量 | claude-code | codex | dsh |
|---|---|---|---|
| 输入（非缓存） | `result.usage.input_tokens`（原文即不含 cache） | `inputTokens − cachedInputTokens`，下限 0（`normalizedInput`）——**必须减**。⚠️ **取数有两个读取点，优先级是「`turn` 自带 > 按线程累计」**：运行期 `turn/completed` 那一支若拿到 `turn.usage`（协议是实验面、字段可能后加）**优先采用**（`usageOfTurn`，**有具名用例钉着**）；取不到才回落 `thread/tokenUsage/updated` 的**按线程累计**。**收尾回读那一支不读** `Turn.usage`（`usageOfRun` 只读 `usageByThread`）⇒ 今天两条路取值相同，因为协议窄声明**没有**声明 `Turn.usage`、`readTurn` 也不解析它 | `usage.inputTokens`（原文即不含 cache） |
| 命中缓存 | `cache_read_input_tokens` | `cachedInputTokens` | `cacheReadTokens` |
| 输出 | `output_tokens` | `outputTokens` | `outputTokens` |
| 思考 token | `output_tokens_details.thinking_tokens` | `reasoningOutputTokens`（**运行期就在报**，主线程与每个子线程各一份；缺这一格时整块用量记 `null`） | `reasoningTokens`（当前通道不投送 ⇒ `null`） |
| 缓存写 | `cache_creation_input_tokens`（**不计入 `cached`**） | `cacheWriteInputTokens`（**不计入 `cached`**；它在协议里是**必填六格之一**：缺它就整块 `null`，不是只丢这一格） | `cacheWriteTokens`（**不计入 `cached`**） |
| 总量原文 | 无（分列计数，没有合计格 ⇒ `null`） | `totalTokens`（线程累计；只作排障证据，不参与归一后的恒等式） | `totalTokens` |
| 整轮时长 | `result.duration_ms` | `Turn.startedAt` ~ `completedAt`（协议单位是**秒**，换算成毫秒后现减；两点缺一 ⇒ 那条事件不带 `timing`） | 会话事件 `time` 首末之差 |
| 仅 API 时长 | `result.duration_api_ms` | `null` | `null` |
| 首 token 时延 | `result.ttft_ms` | `null` | `null` |
| 时间来源标记 | `'vendor'` | `'events'` | `'events'` |
| **子智能体那一份用量** | 读 CLI 转录目录，**按 `message.id` 去重后**逐格求和（同一往返会按内容块出现多次，第一条的 `output_tokens` 是 0 ⇒ 不去重会双计 input / cached）。读法三条：**同步分块流式读**（公共层 `read-lines.ts`：`openSync` + 64 KB `readSync` + `toString('utf8')` 后按换行切分，**不许** `readFileSync` 整份 ⇒ 峰值内存从「整份 + 行数组」降到「最大单行 + 一块」；**必须同步**——`finalize` / `project` 都是同步钩子，改异步要动钩子签名并波及另两家）；**同版本不重复解析**（给「路径 + size + mtime」加 **run 作用域**的小缓存，不是模块级：避免跨 run 留大对象；收尾那一次**合计读**仍然真读，命中缓存的只是「文件没长」的那些——同一处的逐个子智能体读因此复用同一份解析结果，「每份转录每版本只 open 一次」就是这么来的）；解析规则逐字不变 | Σ 各子线程的**线程级累计用量**（`breakdownToTokens(ThreadTokenUsage.total)`）；**枚举（`thread/list`）失败** ⇒ 分量整格 `null` + 合计**不上报**（收尾那条 `usage` 不发、结果的合计两格缺键 ⇒ 行级退回主线程口径，见 §4.2 步骤 6）；**某条子线程读数失败不算**（只少一份内容） | Σ 本行子会话白名单的 `sessionUsage[id]` |
| **子智能体那一份轮次** | 同一份转录里 `message.id` 去重后的个数之和 | Σ 各子线程的**模型答复条目 id 去重个数**（与合计同一把尺） | Σ 本行子会话白名单的 `step/start` 计数 |
| 子智能体**自己的**用量行 | **不发逐条读数**：运行期一条带会话身份的读数都没有；收尾交**合计与子份两格**（`tokens` + `subagentTokens` / `subagentTurns`，见 §4.1 步骤 5.1） | 不发（子线程的条目不给归属键；分量只在收尾成对交出） | 发：带会话身份的读数与本行累计**在同一条流里交错**，是**行尺度**（见 §2.5） |

**三处必须写进适配器的口径差异**：

1. **输入的 cache 口径**：codex 的 `inputTokens`（旧称 `input_tokens`）含缓存读，另两家不含 ⇒ codex 必须做减法（`Math.max(0, input − cached)`），归一后三家统一用 `cached / (input + cached)` 算命中率。
2. **缓存写不进 `cached`**：三家的 `cache_creation_input_tokens` / `cache_write_input_tokens` / `cacheWriteTokens` 都是「写进缓存」，与「从缓存读」是两件事，一律不进 `cached`（否则第一轮就会显示命中率 100%）。
3. **合计与分量必须成对**：`subagentTokens` / `subagentTurns` 是 `tokens` / `turns` 的分量，**同刻交出**（只给分量会让「主会话 = 合计 − 分量」算出负数）。运行期合计口径不含子那一份的那两家（claude / codex 的运行期轮次只有主循环）**运行期不交分量**，等收尾两格一起换权威值。

### 3.5 能力声明（默认取值）

| 能力 | claude-code | codex | dsh |
|---|---|---|---|
| `thinkingText` | `'yes'`（SDK 消息流） | `'yes'`（app-server 的 `reasoning.content[]`） | `'yes'`（会话通知流） |
| `thinkingTextKind` | `'full'` | `'full'`（`content[]` 非空即全文）；厂商摘要**另出一块**（`summary`）——两档落在**块**上，不是两格能力 | `'full'` |
| `toolInput` | `'yes'` | `'yes'`（app-server 条目自带结构化入参；工具真名按条目类型补：`exec_command` / `apply_patch` / `<server>.<tool>`） | `'yes'` |
| `toolResult` | `'yes'` | `'yes'` | `'yes'` |
| `subagent` | `'yes'`（轨迹完整度取决于 `forwardSubagentText`：SDK 默认只投送子智能体的 `tool_use` / `tool_result` 块，**本适配器已显式开启**，故其文本与思考块也会到达；`CLAUDE_CODE_EXTRA_BODY` 那个覆盖层**对子智能体同样生效**） | `'yes'`（依赖多智能体开关与路由；运行期由上游决定是否推送子线程条目，收尾一律用 `thread/list{ancestorThreadId}` + `thread/read` 补齐） | `'yes'` |
| `streamingDelta` | 声明 `'yes'`；**实际取不到**：适配器没有给 `includePartialMessages`，消息流里不会出现 `stream_event`（`stream_event` 的解析路径已就位，开启该选项即可生效）；且即便开启也只覆盖主会话 | `'yes'`（`item/agentMessage/delta`、`item/reasoning/{text,summary}Delta` 等增量通知） | `not-projected-by-vendor` + `reason: 'not-exposed'`：厂商侧**有**这个数据（LLM 层的 `text-delta`），但**订阅到的通知流里没有**（真机探针：一次完整往返 20 条通知、增量类 0 条）⇒ 消息块一律取自 `assistant/message` 的 `content[]`（整块快照），`data.stream[]` 那条增量通道没有取数实现 |
| 各格的 `source` | 五格全 `'wire'` | 五格全 `'wire'` | 前四格 `'wire'`；`streamingDelta` 的 `source` 为 `null`（配 `not-exposed`） |

**思考 token 的可得性**（对应 `reasoningOutput` 那一格）：claude `'yes'`（`result.usage.output_tokens_details.thinking_tokens`，恒 ≤ `output`）；codex `'yes'`（app-server 线程用量的 `reasoningOutputTokens`；⚠️ **样本只覆盖部分路由** ⇒ 能力声明必须带路由前提）；dsh **不投送**（`llm-pi-ai` 的 `mapUsage()` 把推理并入 `outputTokens`）。⚠️ **契约当前没有「思考 token」能力格**（`MessageCapability` 只有五格）：这一条只写在 dsh 的 `messageCapability.notes` 里，别按能力位去读它。三家都**只收结算值**，采不到一律 `null`（口径见 §2.4）。

> 同一份适配器元数据里另有两格与消息无关、本文不展开：`protocolTypes`（这家能收的协议**集合**，候选池过滤的真源）与 `reasoningEfforts`（档位域，按家各不相同）。

### 3.6 思考强度档位（`effort`）

口径三条，**契约与界面统一用档名 `off`**，翻译由各适配器做：

| 输入 | 语义 | 三家落地 |
|---|---|---|
| **未选**（`undefined`） | **不指定**，让 SDK / 厂商自己推断 | claude / codex：`effort` 那一格**一个键都不加**；**dsh 例外** ⇒ 显式传 `high`（它没有「不传就推断」这条路：不传 = harness 不写 reasoning 字段 = **显式关闭**） |
| **显式 `off`** | **要求不思考**（`EvalRow.effort` 记的是「我们**要求**的档位」，不是「实际生效的档位」） | dsh：原样交 `'off'`（关闭由 harness 的 `off: null` 实现，适配器**不自己特判**）；claude：`thinking: { type: 'disabled' }` 且**不传** `effort`，另有 spawn 时的 env 覆盖层（见下一条）；codex：`codexEffortOf` 把档位翻成 **`none`**（走 app-server `turn/start` 的 `effort` 参数，旧称 `model_reasoning_effort`）**且** CLI config 多一格 `model_reasoning_summary: 'none'` |
| 其余档位 | 原样透传 | 三家的档位域各不相同（dsh 只有 `off` / `low` / `high` / `max`）；**只有关闭档不同名** |

```ts
// 唯一的取档实现，各家 run 入口一处（别在两处各写一份）
// dsh —— 恒带，不再有「undefined 时一个键都不加」这条路
const effort = input.effort ?? DSH_DEFAULT_EFFORT;      // 'high'
...{ reasoningEffort: effort }                           // 'off' 也原样交出
// claude-code（startClaudeCode 的 options）：两个键各自条件展开，互不代替
...(input.effort === undefined || input.effort === 'off' ? {} : { effort: input.effort }),
...(input.effort === 'off' ? { thinking: { type: 'disabled' as const } } : {}),
// claude-code（buildSubprocessEnv 的 injected）：env 覆盖层，与上面两格各管一批模型
...claudeExtraEnvFor(input.effort),                       // 见下方「off 在两家厂商侧都要多一格」
// codex —— 未选照旧不传；只有关闭档走映射（键名就是 app-server turn/start 的 `effort`）
...(input.effort === undefined ? {} : { effort: codexEffortOf(input.effort) }),
function codexEffortOf(effort: string): string { return effort === 'off' ? 'none' : effort; }
// codex —— 同一处再给 config 的**第三实参**（不许挤掉 contextWindow 那一格）
config: buildCodexConfig(baseUrl, input.route.contextWindow,
  input.effort === 'off' ? 'none' : undefined),
```

- **dsh 的档位 → wire 拼写**（与档位域**同源派生**）：`{ off: null, low: 'low', high: 'high', max: 'max' }`。`off` 的 `null` 表示「不写这个键」⇒ 落到 `thinking: { type: 'disabled' }`（anthropic-messages wire）/ `reasoning: { effort: 'none' }`（openai-responses wire）；其余三档原样透传（`max` 不在 OpenAI 的枚举里，但该网关实测接受——换网关若拒它，**只改这一张表**，界面仍是四档：档位域是智能体的能力，不是网关的词汇表）。注册表 `reasoningEfforts` 的键集合必须**逐字等于**这张表的键：界面能选而 patch 里没有 ⇒ dsh 在 `initialize` 阶段以 `UNSUPPORTED_REASONING_EFFORT` 收场，用户是**选完到运行时才失败**。
- **注册表**：`AgentProviderMetadata` 新增**可选** `defaultEffort?: string`——**只有 dsh 声明**（`DSH_DEFAULT_EFFORT = 'high'`，它必须同时满足「在 `DSH_REASONING_WIRE` 的键里」与「不是关闭档」，由守卫钉住）。claude / codex 不声明（未选由厂商推断，API 侧无从校验）。
- **候选与校验**：候选 =（上游声明过 `supportedEfforts` ? 交集 : 该家**完整档位域**）**∪ 该家的关闭档**；「未指定」**不是候选数组的元素**，而是 Select 的**清空态**（否则「关闭」永远点不到）。API 建行时**未选也要校验**：`declared = row.effort ?? metadata.defaultEffort`，`declared` 不在候选里就建行即拒（claude / codex 没声明 ⇒ 未选不校验）。档位域、推荐档与上游取数面见 `2026-09-22-features-design.md` §5.1.1。
- **`off` 在两家厂商侧都要多一格才可能生效**（依赖厂商 CLI 内部行为，见 §8.1）：
  - claude：spawn CLI 时注入环境变量 `CLAUDE_CODE_EXTRA_BODY`，值**必须由 `JSON.stringify({ thinking: { type: 'disabled' } })` 生成**（逐字节等于 `{"thinking":{"type":"disabled"}}`；CLI 对**非法 JSON 静默忽略整条**，实测踩过：PowerShell 吃掉内层引号 ⇒ env 变成 `{thinking:{type:disabled}}` ⇒ 无报错、字段仍缺失）。落点是一条**导出的纯函数** `claudeExtraEnvFor(effort)`：`off` ⇒ `{ CLAUDE_CODE_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' }`，其余档位与未选 ⇒ **空对象**，再把它展开进 `buildSubprocessEnv` 的 `injected`。**必须给空对象**，不能写 `CLAUDE_CODE_EXTRA_BODY: off ? VALUE : undefined`（值为 `undefined` 的键会被**删掉** ⇒ 在非 off 档删掉宿主继承来的同名变量，改变其它档位的行为）。`thinking` 选项那一格**保留**：`thinking: { type: 'disabled' }` 经 SDK 转成 argv `--thinking disabled` **到得了 CLI**，被丢在**组装请求体**那一格 ⇒ CLI 的模型能力门**放行**的模型由这一格生效，**不放行**的模型由 env 覆盖层兜底（两半各管一批模型，不许删掉任何一半）。
  - codex：多一格 CLI config `model_reasoning_summary: 'none'`（**只在 `off` 时给**；其余档位与未选传 `undefined` ⇒ **键整个不出现**）。做法是把 `reasoningSummary` 作为 `buildCodexConfig(baseUrl, contextWindow, reasoningSummary?)` 的**第三实参**（不许挤掉 `contextWindow` 那一格），由它按「`undefined` ⇒ 不写这个键」的条件展开产出。触发条件是 `include: ["reasoning.encrypted_content"]` **∧** `reasoning.summary` 同时存在：**两半缺一都关不掉**（`effort: 'none'` 单独给无效，`include` 不可配——上游硬编码）。⚠️ 「键不存在」与「键在、值为 `undefined`」在本仓**行为等价**（`config` 经 `thread/start` 交给 app-server 前会做 JSON 序列化，`undefined` 值的键**直接消失**）⇒ 钉形态是为了**逐键对账**与抗序列化 / 协议漂移，不是功能差异。
  - ⚠️ **codex 的 `off` 当前做不到「零推理」**：真机探针的 `off-both` case 直证 `effort="none"` **∧** `summary="none"`（主线程与子线程都到），**网关照样推理**（跑动期实验：`off` 行 28 条 reasoning 条目、网关自述 7,347 思考 token；同 run 未选对照行 13 条）⇒ 那两格**确实到了 CLI**，是网关侧不认。极简 prompt 上的「0 条」**不外推到 agentic 长链路**。这一格因此只能按「已按要求下发」呈现，不得按「它没思考」呈现（与 §3.6 顶部「要求 vs 实际」同一口径）。
- **`off` 的生效是有前提的**（换网关 / 换 CLI 版本 / **换链路形态**都要重测）：claude 依赖 CLI 的模型能力门与 body 覆盖层的展开顺序（前置：hipaa 策略为假、`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` **未设**——⚠️ hipaa 那一位**本仓不可独立观测**，只能从「0 思考块」反推，属推断前提）；codex 依赖网关对 `(include ∧ summary)` 的组合行为。⇒ **界面文案一律按「已按要求下发」表述，不按「它没思考」表述**——`EvalRow.effort` 这一格记的本就是「我们**要求**的档位」。**不存在 `effortLabel` 这个共享常量**（`contracts` 里没有它）：关闭档在行卡片上**逐字写 `off`**、浮层写「关闭思考」（`eval-row-card.tsx`），环境抽屉与环境文本同样逐字写 `off` 或「未指定」（`agent-environment-drawer.tsx` / `build-environment.ts`），三处各写各的词、但都不做「它没思考」的断言。**清空态与显式 `off` 必须分开说，而且两处文案本来就不同、别互相抄**：**表单占位符**（`run-create-panel.tsx` 的 `effortPlaceholder`）写「未指定（`AGENT_LABELS` 全名 **用** `metadata.defaultEffort`）」，如「未指定（DeepSeek Harness 用 high）」；**环境文本**（`build-environment.ts` 的 `effortLine`）写「思考强度：未指定（由该家适配器决定：<全名> 走 <档>）」——客户端那句旧的「未指定（沿用厂商默认档）」同步改成这一句（对 dsh 是假的）。**2026-10-08 口径（用户）**：页面展示不用缩写 ⇒ 厂商名一律写 `AGENT_LABELS` 的全名、档位取注册表 `metadata.defaultEffort`，且**没声明缺省档的家（Claude Code / Codex）只说「未指定」**——文案里不写死厂商名与档位。
- **claude 的前置条件被破坏时是「静默失效」，必须变成可观测的**：`off` 档且合并后的子进程 env 里**存在** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` ⇒ 落**一条 WARN**，点名宿主用的那个**键名原文**、说清后果（关闭被静默忽略、本次运行的 `off` 档读数作废）与下一步（去掉该变量后重跑）。三条判据细节：① 看**存在**（`!== undefined`）而不是真值——宿主可能写 `true` / `1` / 空串；② 键名按**大小写不敏感**查找并回报**原拼写**（Windows 环境块常写 `Path`）；③ **只在 `off` 档看**，其余档位与未选连一条日志都不多。
  **它是观测，不是拦截**：不许抛错、不许因此跳过这一行、不许改动注入、不许删改宿主那个变量；判据抽成**纯函数**（`hostDisablesBetas(合并后的 env, effort)`，返回命中的**键名原文**或 `null`），与 `claudeExtraEnvFor` 同一形态——`recorder.env` 是「宿主 + 注入」的合并对象，拿它断言在宿主设过时必然假红。WARN 文案由导出的模板常量 `CLAUDE_OFF_DISABLED_WARNING_TEXT` 拼出（全句只有 `<键名原文>` 一个可变 token），并以 `{ variable: <键名原文>, effort: 'off' }` 作第二个参数透传（**不 `JSON.stringify`**）；模板**导出给测试逐字比对**（一条用例比「常量 == 本文原句」），而另外两条落点用例**刻意把正文写成字面量**、不拿常量拼——常量的字面值（尤其大小写）一旦漂移，要在那里当场红。
  **codex 侧不加对称观测**：它的失效模式是「CLI 内部把 config 键改名 / 忽略」，**启动前没有任何可读的信号源** ⇒ 加了只能是**假观测**；那一侧的探测器就是真机判据（该行的 reasoning 条目数）。
- **读数与判据的两把尺子**：单测证明「我们注入了什么」，真机证明「它生效了」，两者缺一都不算验收。真机判据读的是**行的产物**（dsh / claude 读 `messages.jsonl` 按 `mergeKey` 折叠后含 `thinking` 块的消息条数，主线程与子智能体分开；codex 读该行落盘内容里这一轮的 `reasoning` 条目数——**不要再按旧的 rollout 文件路径去读**，那条通道随 SDK 一起删了），且**「0」必须与同一 run 里的「未选」对照行成对读**（对照行 > 0 才算这一轮可判读）。**不要**用出网请求体当验收判据，也不要在 body / 日志文本里子串搜 `thinking`（真机上命中全是无关），CLI 自述的 `thinking_tokens` **没有区分力**。
- **路径 B（智能生成 / 智能识别 / 文本评分）也有思考档位**：它在**每次调用的入参**上（`TextCallInput.effort` / `TextConversationInput.effort`，取值来自 `settings.defaultJudge.effort`，唯一读点是 `resolveJudgeEffort()`；**`TextRoute` 刻意不带这一格**——route 是连接事实、强度是请求参数，代码注释逐字如此）——未选 ⇒ **一个强度键都不发**（听网关缺省，**不是**关闭）；`off` ⇒ `thinking: { type: 'disabled' }`；其余档位按协议翻成 `output_config.effort`（anthropic）/ `reasoning_effort`（openai）。⚠️ **它与智能体侧的「未选」不等强**（那边 dsh 会落到 `high`），两条通路的「未指定」不要互相引用。
- **历史可比性**：`run.json` 里没写 `effort` 的行，**dsh 的**实际档位从「关闭」变为 `high` ⇒ 同一行重跑与旧结果不同源（另两家不受影响）；**不做**按创建时间区分老新的补偿（那是第二个真相）。

---

## 4. 三家实施路径

每家的步骤按依赖排列，可逐步实现、逐步验证。

### 4.1 claude-code

**步骤 1｜建会话**
- 用 Agent SDK `query({ prompt, options })`；`cwd` 指向工作区，并过一遍 `realpathSync.native`（Windows 8.3 短名会被 CLI 的安全门拦下，表现为 0 改动）；取不到真实路径时回落原值并记 DEBUG，不让整行失败。
- `settingSources` 决定读哪些**文件系统 settings**：`'user'` = 配置根下的 `settings.json`、`'project'` = `${cwd}/.claude/settings.json`、`'local'` = `${cwd}/.claude/settings.local.json`；`[]` = 隔离模式（一个都不读，代价是**仓库自带的 `CLAUDE.md` 与项目配置也读不到**——`'project'` 是加载 `CLAUDE.md` 的必要条件）。需要它们时给 `['user', 'project', 'local']`，此时**必须**同时给 `settings: { env: { … } }`：仓库自带的 `.claude/settings.json` 就在 `'project'` 档里，它的 `env` 块会盖掉子进程环境注入的地址与密钥，而 `settings`（等价 CLI 的 `--settings`，flag 档）优先级高于 project / local，能把路由压回去。两半必须成对给。
- `env` 注入模型与路由（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CONFIG_DIR`），不要依赖用户全局配置；`env` 是**替换**语义，要自己展开宿主环境。base URL 要去掉尾部 `/v1`（SDK 自己追加 `/v1/messages`）。
- **模型名**：`contextWindow ≥ 1_000_000` 时给模型名追加 `[1m]` 后缀（幂等、大小写不敏感）；其余原样。
- **工具面**：`disallowedTools` = **六项无条件**（`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` / `PushNotification` / `DesignSync`）**＋非 Claude 模型再追加** `WebSearch`：判据是 `route.modelId` 的子串 `/claude/i`（大小写不敏感），两张表相加得出名单。⚠️ **§9 第 19 条「收成无条件七项」尚未落地**——代码与用例都仍钉着这条分档行为。**只禁工具、不禁网络**（`Bash` / `WebFetch` 照旧可用）。`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 常开，让新模型上也补齐 `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`。
- **结构输出与档位按需带**：`outputSchema` 为 `undefined` / `null` 时一个字段都不加；`effort` 为 `undefined` 时同理（让模型用自己的默认档）。
- 权限用显式模式（`full` → `bypassPermissions` **必须**配 `allowDangerouslySkipPermissions: true`；`read-only` → `dontAsk` + `permissionPrompts: 'none'`）；不给 `maxTurns`（不给即不限）。若需要接收提问，见步骤 7。
- **编排开关与闸门**（⚠️ **本期未落地**：`settings` 档今天只有 `env` 三键，`injected` 只有路由四键 + `CLAUDE_CODE_ENABLE_TODO_TOOLS` + `CLAUDE_CODE_EXTRA_BODY`，两个 `CLAUDE_CODE_WORKFLOW_*` 名字只出现在探针脚本里，`subagent-start` 事件也还没实现）：目标形态是 `settings` 档显式给 `enableWorkflows: true` 与 `workflowSizeGuideline: 'medium'`，并在 `injected` 里注入 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8` 与 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`；规模计数由适配器按 `subagent-start` 自己留痕（作用域与「为什么总数不硬拦」见 §8.1 / §8.2）。

**步骤 2｜流式增量（当前未启用）**
- 增量通道是 SDK 的 `includePartialMessages: true` + `stream_event`：`message_start` → `content_block_start` → 多个 `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`。
- 增量子类型（判据是 `content_block_delta.delta.type`）：`text_delta`（正文）、`thinking_delta`（思考正文）、`signature_delta`（签名，落**同一个思考块**的槽位）、`input_json_delta`（工具入参分片，**不进消息层**）；其余子类型按未知跳过。
- **自己累积**：SDK 只转发原始事件，不提供累积文本；按 `index` 分组累积到块。`message_start` 记下 `message.id` 与一批块序号分配器，随后的完整 `assistant` 消息用同一个 `message.id` 把分配器取走 ⇒ 增量与快照落到同一批槽位。
- 流式事件只覆盖主会话：其 `parent_tool_use_id` 恒为 `null`，子智能体的 token 级增量不会转发，子任务归属一律用完整消息上的 `parent_tool_use_id`。
- **适配器当前没有给 `includePartialMessages`** ⇒ 实际拿不到 `stream_event`（解析路径已就位，开启该选项即生效）；能力位那一格因此与实现不一致，见第 7 章。

**步骤 3｜归一消息与块**
- `assistant` 消息 → 遍历 `message.content[]` 产出块：`text` / `thinking`（含 `signature`，空文本记 `text:null` + `textKind:'none'`）/ `tool_use`；其余类型**静默丢弃**。
- `user` 消息 → 若含 `tool_result`，产出 `tool-result` 块；同时读 `tool_use_result` 作为 `structured`——它是**工具的完整 Output 对象**（形状按工具名而定），不是发给模型的那份字符串内容，能读它就不要再从文本里正则提取。
- 工具结果文本上限 `TOOL_RESULT_MAX_CHARS = 20_000`（超出即截断）；厂商不给截断标记 ⇒ `truncation` 记 `unknown`。
- `system` 消息按子类型分流：`init` → **`vendor-system` 事件**（六格：`tools` / `slashCommands` / `agents` / `mcpServers` / `permissionMode` / `outputStyle`；字段不是数组 ⇒ `null`「没投送」，空数组 ⇒ `[]`「确实为空」，空串按没给），同时**记下 `session_id`**（定位子智能体转录目录的唯一钥匙）；`task_started` / `task_notification` 走子任务通道。
- **`system/thinking_tokens` 逐帧估算通道不投影**：它是「还没结算」的高频帧（一轮能到几千条），**不落 `attachment`、也不进 `reasoningOutput`**。⚠️ **但它会落 `log`**：代码里 `system` 只分流 `task_*` 与 `init`，其余（含这一族）走「未识别事件」兜底 ⇒ **逐帧一条保留原始负载的 `log`**（「未识别的事件不得静默丢弃」是三家的共同义务，claude / dsh 都落整份原文，见 §3.2 的 `unrecognized` 行），本节原先「也不落 `log`（落盘只增噪声）」的去噪并未实现。`reasoningOutput` 的**结算值**只由 `result.usage` 那条路交；跑动期估算只取 `assistant.message.usage`（不取这一族帧）。
- `result` 消息给终局用量与时延；一次 turn **恰好一条**，且在该 turn 的 `assistant` / `user` / `stream_event` 之后到达 ⇒ 可当收轮信号。结构化输出有两条落点（字段优先、`result` 文本兜底），两者不一致时落一条 WARN。

**步骤 4｜覆盖合并（关键）**
- 同一条 `assistant.message.id` 会被**分多条**投递：SDK 每完成一个非空内容块就发一条，每条只带该块（思考 / 正文 / 工具调用各一条），这些条共享同一个 id。
- 合并规则：同一条 `message.id` 会被**按内容块**分多次投递，每次只带一个块 ⇒ **新块追加到末尾、同键覆盖**（不得把每次投递都当成"整条消息的第 0 块"）；块序号按**首次到达**分配，分配后不再变化。增量（步骤 2）先按 `index` 累积成一个块，再按同一键覆盖。

**步骤 5｜子任务**
- `task_started`：`task_id` → `subagentId`；`description` → `name`；`subagent_type` → `kind`；**`spawn_depth` → 只进事件日志载荷**（`payload.spawnDepth`），**不进 `SubagentRecord`、不表达层级**（见本节末的父链那条）。`task_notification`：`status` → 终态；`summary` → `outcome`。
- **形状判据（先判形状，再产行）**：`subagent_type` / `spawn_depth` / `prompt` **至少一格非 `null`**（`''` 与 `0` 都算「给了」——判严了会把真派发判成幻影，比多一条幽灵行更坏）。判决只按 **`start` 帧**做，收场帧按同一个 id 追随（收场帧不承载形状证据）。三档：`'dispatch'` 产行并进入事实核对名单；`'phantom'`（CLI 给**非 Agent 任务**发的条目，盘上永远没有它的转录）**不产行**；`'unjudged'`（只见到收场帧）照产行，只落一条「可能少算」的 WARN。
- 子智能体的**工具调用与工具结果**块随主流到达（带 `parent_tool_use_id`），按它归属到对应子任务；`task_started.tool_use_id`、派生该子任务的工具调用 id、子消息上的 `parent_tool_use_id` 三者同值 ⇒ `parentCallId` 直接取 `tool_use_id` 并配到派发工具块上。
- 子智能体自己的文本与思考块：SDK **默认不转发**（只投 `tool_use` / `tool_result`），适配器显式给 `forwardSubagentText: true` ⇒ 两类块都会到达；不给时子任务视图只剩工具流水。
- 嵌套父链**当前恒 `null`**：`task_started` 上只有 `spawn_depth`、没有父 id；SDK 类型面上那个 `parent_agent_id` **在真机载荷里从未出现**，适配器因此没有它的读取点（不推测父节点）⇒ `parentSubagentId` 一律记 `null`，层级**没有落点**（`SubagentRecord` 没有深度格；`spawn_depth` 只进事件日志）。
- 子任务行的 `usage` **不取** `task_notification.usage`（`total_tokens` / `tool_uses` / `duration_ms` 是另一种形状，没有三元组）；它由步骤 5.1 的读盘补齐，拿到时整条记录的 `source` 改成 `'session-file'`。

**步骤 5.1｜子智能体那一份用量与轮次（读 CLI 转录）**
- **为什么读盘**：`forwardSubagentText: true` 转发过来的侧链消息虽然带 `message.usage`，但**流式快照的 `output_tokens` 恒为 0**（结算值只在主会话的 `result.usage` 上）⇒ 照快照求和会得出「子智能体输出 0 token」这种静默假数。唯一权威源是 CLI 自己落盘的文件。
- **路径**：`<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`。`sessionId` 来自 `system/init`；**采不到 `sessionId` 就不猜目录**（猜错会把别的会话的转录算到这一行上），直接按「没有目录」处置。项目目录名不重算：遍历 `projects/` 下每个目录，取第一个 `<项目>/<sessionId>/subagents` 读得动的。文件过滤 `agent-*.jsonl` 并**按名字排序**（让点名 WARN 的顺序确定）；`agent-*.meta.json` 不是转录（后缀挡住）。
- **单个文件的读数规则（只有这一条）**：逐行 JSON；半截行 / 坏行**跳过**（CLI 边跑边写，这是常态）；只认 `type === 'assistant'`；按 `message.id` **去重、后到覆盖**（同一次往返会按内容块出现多次，第一条的 `output_tokens` 是 0 ⇒ 逐条相加会把 input / cached 双计）；三项（`input_tokens` / `cache_read_input_tokens` / `output_tokens`）缺一，或认得是 `assistant` 却拿不到 `message.id` ⇒ **整份文件作废**（跳过会让那一次往返从合计与轮次里一起消失）；一条可用记录都没有（空文件 / 被中断在半截）⇒ 同样作废。文件读数 = `sumUsageTokens(去重后的各次往返)`，轮次 = 去重后的 `message.id` **个数**。
- **聚合（全部子智能体）**：读取集 = **目录里枚举出来的转录 ∪ 事实核对名单**——盘上有就必须读（转录比事件流更硬），名单里有就必须读得动。**有任何一个进 `missing` ⇒ 两格一起 `null`**（「全量或 null」：部分和会被读成总数，而界面上它与全量合计长得一模一样），并落一条**点名**的 WARN；读到的那些**不进合计**。
- **「确实没有」的出口**：会话目录不存在、或目录里一个转录都没有，且名单里也没有形状像派发的 id ⇒ `subagentTokens = {0,0,0}`、`subagentTurns = 0`；名单里**有** ⇒ 事实缺失：两格 `null` + 点名那些 id。
- **读数时机：只在收尾读一次盘**（`index.ts` 的 `finalSubagents`；终态通知那一帧只登记记录，**不读盘**）。每个子智能体的全量读因此从 2 次降到 1 次；代价是子智能体收场到收尾之间那一格显示「用量未采集」，终态值由收尾保证（`turn.ts` 的 `finally`，正常 / 失败 / 被终止都会跑）。
- **登记要连派发帧一起**（`rememberSubagent` 记 `running`，终态优先）⇒ 没有终态通知的子智能体（CLI 没投送 `task_notification` / 运行被中断）在收尾那批里也有它，`SubagentRecord.usage` 不再恒为 `null`。
- **读法四条**（用户点名的内存与重复读两件事，落点在 `subagent-usage.ts` 与 `index.ts` 的两层缓存）：
  1. **同步分块流式读**：分块那一层在**公共层 `read-lines.ts`**（`openSync` + 64 KB `readSync` + `toString('utf8')` 后按换行字节切分，`incompleteTail` 决定末尾那段半截内容交不交），`subagent-usage.ts` 的 `readOne` 只做 stat → 查缓存 → 交行给解析器；**不许** `readFileSync` 整份；解析规则逐字保留（只认 `type === 'assistant'`、`message.id` 去重后到覆盖、三项齐全才认、认得却读不全 ⇒ 整份作废、半截行跳过）。
     ⚠️ **必须同步**：`finalize` 与 `project` 都是同步钩子，改异步要动钩子签名并波及另两家（代价远大于收益）。
  2. **同版本不重复解析**：给「路径 + size + mtime」加一个 **run 作用域**的小缓存（不是模块级：避免跨 run 留大对象）；同版本直接复用解析结果，版本变了才重读。**收尾那一次「合计读」是真读**（全量的前提）；**同一处的逐个子智能体读命中同一缓存** ⇒ 每份转录每个版本只 open 一次（这就是下一条的依据）。
  3. **收尾那一条路径与子任务条那一格共用同一个缓存** ⇒ 同一版本的文件各只 open 一次。
   4. **目录解析也要缓存（整行只枚举一次）**：`sessionId` 已知时，`<projects>/<项目>/<sessionId>/subagents` 是**逐项目目录试**出来的 ⇒ 收尾那个逐会话循环里，每个子会话都重试一遍就是 **O(子会话数 × 项目目录数)** 次目录遍历。做法是**按行解析一次并复用**（`configHome` 与 `sessionId` 在一行内固定），命中缓存时连 `<projects>` 都不再打开。⚠️ **只缓存「找到了」的结果**：`null` 不缓存——目录可能在第一条子智能体落盘时才出现，把它固化成「读不到」是静默的缺失。
- **不发逐轮读数**：事件流里 `turn.subagentId` 恒 `null`（与 codex 同形），也不交逐轮明细（`rounds` 已删）——两个读出口只交 `usage` 与 `turns`。
- **主会话轮次的计数**：只数**主循环**的 `assistant.message.id`（侧链消息的 `parent_tool_use_id` 非空 ⇒ 直接返回 `null`，不计数），这正是「主 + 子」这条加法成立的前提。`num_turns` 只作兜底（我们一次都没数到时才用），两者不一致时落一条 WARN。
- **抽屉里那一格（单个子智能体）**：按 **wire id 拼单个文件名**（`agent-<id>.jsonl`）——真派发那条 wire id 与文件名里的 `agentId` 同值，所以这个入口的匹配语义天然正确；它只回答「**这一个**花了多少」，与上面的「全部加起来」共用同一条读数规则（各写一份的症状是「同一份文件在两处算出两个数」）。

**步骤 6｜规划数据**
- 工具按模型门控：`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` 或 `TodoWrite` 只在部分模型默认给出；适配器用 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 常开四件套。
- ⚠️ **冷存储下 `Task*` 必失败**（**本节是未落地的设计说明**：适配器今天没有预建目录的写入点，常开的是 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 那一格）：CLI 不建 `<configHome>/.claude/tasks/<sessionId>` 与其中的 `.lock`（工具对 ENOENT 未兜底，报 `ENOENT lstat '…tasks/<sessionId>'` → `EPERM mkdir '…/.lock.lock'`）⇒ 要用 `Task*` 就**必须先自己把这两级目录建出来**。
- 进度清单的**数据源是「整表」形态的调用**：`TodoWrite` 的 `{ todos: [{ content, status }] }` 会被归一成 `plan` 载荷（`kind:'plan'` + `steps[]` + `note:null`）。**适配器不做跨调用累积**（它无状态）：`Task*` 四件套是逐条 patch 的注册表，入参里没有 `todos` / `plan` / `steps` 任何一个键 ⇒ `family` 仍是 `task`，但 `payload` 记 `null`（消费方走**通用工具行**，进度面板**整卡不出现**——⚠️「未使用进度清单」那句文案与任何说明行**当前都没有落点**，见 §5.4）。
- `TaskCreate` 的返回 id 从**携带 tool_result 的 user 消息**的 `tool_use_result` 里读结构化对象，不要从文本里正则提取。
- 工具入参的键名要认多个写法（`taskId` / `id` / `task_id`，`activeForm` / `active_form`）——**本节是未落地的设计说明**：代码里没有这组兼容读取点（`tool-payload.ts` 的入参兼容只有 `todos` / `plan` / `steps` 三种整表键、步骤内的 `subject` / `text` / `content` / `step`、以及 `status` / `completed` 两套状态写法；`Task*` 四件套的 `payload` 按设计为 `null`）。之所以要认多个写法：CLI 只在执行前修这些名字，流里看不到修复结果。
- `deleted`（状态被删除）归 `unknown`：当 `completed` 是撒谎，当 `pending` 是它明明已被删除。

**步骤 7｜交互与计划模式**
- `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 三个工具**只在注册了 `canUseTool` 回调时才出现在工具表里**；不注册则连工具都没有。给了 `tools` 数组收窄能力时，必须把 `AskUserQuestion` 也列进去，否则提问能力直接消失。
- 自动放行模式（`bypassPermissions`、`acceptEdits`）会在回调之前解决调用 ⇒ 回调不会触发。要真正收到问题，改用 `PreToolUse` hook 拦截，或使用会走审批的权限模式。

**步骤 8｜工具族映射**
- 工具表项数由**模型与开关**共同决定（同一版本在不同模型与开关下取到过 23～30 项），族映射要按**工具名**做，不按数量。
- 子智能体工具是同一个东西的两种叫法：`system/init` 工具表与部分模型叫 `Task`，入站工具表与另一些模型叫 `Agent`（工具 schema 里的名字也是 `Agent`）。两个名字都要映射到同一族，不要按名字拆成两族。
- `Bash` 结果**没有结构化退出码**：真机 `tool_use_result` 给的是分开的 stdout / stderr，但**没有退出码这一格**。⚠️ **本节「失败时从结果文本 `Exit code N` 解析」未落地**：代码里没有这个解析点，契约的 `ToolCallPayload` 也没有 `run-shell` 那一族（只有 `plan` / `ask-user`），故失败路径的退出码今天**无处承接**（`family` 仍是 `run-shell`，归一结果里 `exitCode` 拿不到就是 `null`）；成功时更不得填 0。
- 长输出会走持久化文件路径，工具结果里给的是路径而不是正文。

**步骤 9｜计量**
- 用量从 `result.usage` 取：`input_tokens`（不含缓存）、`cache_read_input_tokens`、`output_tokens`、`output_tokens_details.thinking_tokens`。**三项必填格缺任何一项 ⇒ 整格 `null` 并落一条 WARN**，绝不把缺的那格补成 0。`total` 恒 `null`（这家没有厂商自报的总量格）。
- 时延从 `result` 取：`duration_ms`、`duration_api_ms`、`ttft_ms`，来源标 `'vendor'`（三家只有这一家有 `apiMs` 与 `ttftMs`）。
- `thinking_tokens` 在 `usage.output_tokens_details` 里，该格可能整个缺失、也可能给 0：**0 不等于这家不思考**（兼容后端会把「上游没报」写成 0）⇒ 缺失记 `null`、读到 0 **照实记 0**（这一格是厂商原文），但不得据此断言「这家不思考」。`output_tokens` 已含思考量，归一后不要再做减法。
- **跑动期是估算**：按 `assistant.message.usage` 的同 `message.id` 后到覆盖再求和（侧链消息与缺 `message.id` 的直接不算，三项全 0 的快照当「还没填好」丢弃）⇒ 投影层标 `tokensEstimated: true`，**骨架据此把这一条事件的 `tokensBasis` 标成 `'estimated'`**：估算值只进 `usage` 事件供界面显示，**绝不回写运行快照、也绝不进结果**（`turn.ts` 把它单独存在 `estimatedTokens` 里，`AgentRunResult.tokens` 只取权威那一路）；结算值一到，估算作废（那一条事件的 `tokensBasis` 是 `'reported'`）。⚠️ **回写的判据在编排层、且只认事件自带的那一格**（`orchestrator.ts`：`tokensBasis === 'reported'` 才写快照）——`tokensEstimated` 只决定这一条事件走 `estimated`（即「只发事件、不进结果」），**不再是回写依据**。
- **子智能体那一份**（`subagentTokens` / `subagentTurns`）与收益无关：见步骤 5.1，由收尾读盘交出。
- **`effort` 三档**：未选 ⇒ `effort` 与 `thinking` 两格都不出现；`off` ⇒ `thinking: { type: 'disabled' }` 且不传 `effort`，**外加 spawn 时经 `claudeExtraEnvFor` 注入 `CLAUDE_CODE_EXTRA_BODY`**（见 §3.6 / §8.1）；其余档位原样透传。注入点在 `startClaudeCode` 调 `buildSubprocessEnv` 的 `injected`（与 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 同一个对象）。

### 4.2 codex

**步骤 1｜启动与路由**
- 用 **`@openai/codex` CLI 包自带的 `codex app-server`** 发起：适配器自己 `spawn(binary, ['app-server'], env)` → **握手** `initialize`（`capabilities.experimentalApi: true` 是 `thread/list{ancestorThreadId}` 这类实验字段的前提）→ **建线程** `thread/start{model, cwd, sandbox, approvalPolicy, config}` → **起轮次** `turn/start{threadId, input:[{type:'text',…}], effort?, outputSchema?}` → 迭代会话的**通知流**（异步生成器，逐个产出已归一的载荷）。三帧次序由守卫钉住：`initialize` → `thread/start` → `turn/start`。
- **终结只认主线程的 `turn/completed`**：主线程与每个子线程各有自己的 turn，子线程先干完它的那一条就先到 ⇒ **不能见一条就收轮**（真机踩过：只收到子线程那一条）。子线程那一轮的通知照样产出（子任务轨迹靠它）。
- 可执行文件**不依赖 `PATH`**：`@openai/codex/package.json` → 平台包（Windows x64 是 `@openai/codex-win32-x64`）→ `vendor/<target-triple>/bin/codex(.exe)`。打包器免疫有**两半**，缺一都不行：① 用 `process.getBuiltinModule('module')` 取**真的** `createRequire`（Next 的构建会替换掉 `createRequire`）；② 解析基准写成**列表**（`import.meta.url` → `process.cwd()`，`import.meta.url` 也会被重写）并校验结果是文件。缺这两半的表现是「纯 Node 正常、打包后 `AGENT_LOAD_FAILED`」。
- **路由与开关走线程级 `config`**（`buildCodexConfig(baseUrl, contextWindow?, reasoningSummary?)`）：`model_provider: 'aieval'` 与 `model_providers.aieval` **是一对**（只建条目而不指定 `model_provider` 时 CLI 退回它**内置的**默认 provider，表象是 `Reconnecting... waiting for network`）；`base_url` 先过 `ensureV1Suffix`；`wire_api` **只有 `responses` 一个合法值**（写 `chat` 时失败在**建线程**这一步：`thread/start` 返回 `-32600`）；`env_key: 'OPENAI_API_KEY'` 决定 Bearer 从哪个环境变量取（换 `requires_openai_auth: true` 会走登录态、一个授权头都不附 ⇒ 全 401）；`request_max_retries: 1`；`tools: { web_search: false, update_plan: { enabled: true } }`；`features: { multi_agent: true }`；`model_context_window` 与 `model_reasoning_summary` **只在已知 / 被要求时出现**（`undefined` ⇒ 键整个不存在）。
- **权限档**由 `codexPermissionOptions(permission)` 给：两档 `approvalPolicy` 都是 `'never'`（评测非交互）；`read-only` 在 **Windows** 上落 `danger-full-access`（只读档在 Windows 上连 `echo` / `git status` 都起不来，而 codex 没有独立的文件读取工具 ⇒ 否则评分者只能盲评）。
- **env 是替换型**：`buildSubprocessEnv` 先展开宿主 `process.env`、再把 `HOME` / `USERPROFILE` 指向本行配置目录、最后覆盖注入键 ⇒ codex 注的是 `CODEX_HOME`（= `input.configHome`，**阶段相关**：候选/执行段是 `.agenthome`、评分段是 `.judgehome`）与 `OPENAI_API_KEY`；凭据只进**子进程环境**，不写 `process.env`。
- **停与放**：中止发 `turn/interrupt`（协议能力 ⇒ `cancelMidTurn: true`）；释放走 `close()`——**回收整棵进程树**并等它真的退出（codex 起来后会经插件同步的 `git` 链 spawn 一串孙进程，它们继承了句柄；只杀直接子进程会留下孤儿、锁住本行的 `.agenthome` / `.judgehome`，下一轮清理就 `EPERM`）。
- ⚠️ **已失效的旧约束**：「`CODEX_HOME` 的位置受可执行文件位置约束（exe 在工作区内时它也必须落在工作区内）」「scratch 目录不要用系统临时目录」——这两条来自已被删除的 SDK 时代，**当前代码里没有任何判据**，不要再当既成事实引用。

**步骤 2｜解析通知流**
- 通知载荷共 **15 种** kind = **14 种已归一的方法 + `other` 兜底**：`thread/started`、`thread/status/changed`、`turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/textDelta`、`item/reasoning/summaryTextDelta`、`item/plan/delta`、`item/commandExecution/outputDelta`、`thread/tokenUsage/updated`、`turn/plan/updated`、`error`；其余方法一律归 `other` 并保留方法名（不静默丢弃）。
- 条目共 **13 种** kind：`userMessage`、`agentMessage`（`text` 是正文）、`reasoning`（`{summary[], content[]}`，**没有 `text`**）、`commandExecution`（`command` / `cwd` / `status` / `output`（即 `aggregatedOutput`）/ `exitCode` / `durationMs`）、`fileChange`（`changes[]{path, kind}` / `status`）、`mcpToolCall`（`server` / `tool` / `arguments` / `result` / `error` / `status`）、`dynamicToolCall`（`namespace` / `tool` / `arguments` / `contentItems` / `success`）、`toolOutput`（`functionCallOutput` 的旁路副本）、`collabToolCall`（见步骤 8）、`subAgentActivity`、`plan`（`text`）、`webSearch`（`query`）、`other`。
- ⚠️ **解析了但没有出口的通知**：`item/plan/delta` 与 `item/commandExecution/outputDelta` 两侧都没有分支 ⇒ **连「未识别事件」都不落**；`thread/started`（只登记昵称）、`thread/status/changed`、`turn/started` 同样不落行级事件。
- **这家现在有增量**：`item/agentMessage/delta` → `chunk:'delta'` 的正文块；`item/reasoning/textDelta` / `summaryTextDelta` → 两条思考块的 `delta` ⇒ 能力位 `streamingDelta` 声明 `'yes'` / `'wire'`；**命令输出与计划没有增量**（见上一条）。
- **失败面**：`error` 通知是**每次尝试**都发的过路消息（上游自己还会重试），只落一条 WARN；本轮失败只认 `turn/completed` 的 `status: 'failed'`，`interrupted` 是「被中止」不是失败。
- **时间来自厂商**：`Turn{startedAt, completedAt}`（**秒**）换算成毫秒后现减，来源标 `'events'`；`apiMs` / `ttftMs` 恒 `null`——那两格只有 claude 有，**不许**拿总时长冒充。

**步骤 3｜读数据通道：通知驱动 + 收尾 `thread/read` 补齐**
- **运行期不读盘**：内容由通知即时投影，用量只从 `thread/tokenUsage/updated` 记账——协议**没有**「按线程读用量」的请求，所以线程级累计只能在通知里拿。
- **收尾用请求补齐**：闸门是「本轮结算」→ `thread/list{ancestorThreadId}` **一次拿到任意深度的后代**（分页上限 100）→ 逐线程 `thread/read{includeTurns:true}`：**全部** turn 的 `itemsView` 都是 `full`（且至少一个 turn）时直接用返回的条目，**任一 turn 不全**（或一个 turn 都没有）就只信元数据、条目改走 `thread/items/list` 分页（**摘要视图不是全量**，不能当全量用）。⚠️ 上游已对 `includeTurns: true` 回 `deprecationNotice`（「分页线程的全量水合已废弃，改用 `thread/turns/list` + `thread/items/list`」）⇒ 这是一条**已预告的通道变更**，换协议时要一起改。⚠️ 这条的**证据在真机抓包里**（`probe/dumps/**` 的 `thread/read` 响应帧；该目录**未入库**，`git grep` 查不到）——本仓不读响应信封上 `result` 之外的字段，所以只作预告登记、不做运行时处理。
- **没有深度 / 宽度上限**：线程树由协议给（旧的「深度 8 / 递归发现 32 条」两条上限随读盘实现一起删除），codex 侧既不递归也不扫盘。⚠️ `agents/src` 里**并非**没有目录扫描 API：`readdir` 的调用形态被静态断言全局禁止，只放行**一项**白名单——`providers/claude-code/subagent-usage.ts`（枚举 CLI 的转录目录，理由与「表不许变长」写在守卫里）。
- 子线程的 `item/*` **是否推给本条连接由上游决定**（协议没有 `thread/subscribe`）⇒「通知驱动」与「收尾补齐」两条入口都要有；两条都拿不到时记 `null` + 点名 WARN。
- **坏帧有计数**：解析不了的整行进「未解析帧」计数（不静默），它是「上游换了帧格式」的早期信号；与「文件写完没」无关——这家不读文件。

**步骤 4｜思考正文与摘要（两块）**
- 正文 = `item/completed` 的 `reasoning.content[]` 拼行（`textKind:'full'`）；增量 `item/reasoning/textDelta` 先到时**逐字累积**，由完成通知**无条件补一次快照封口**——「内容与增量逐字相同」也要发：「内容相同」与「已收尾」是两件事。
- 思考块**四支**（与 §3.2 的 `thinking` 格逐字同口径）：①`content[]` 拼行非空 ⇒ 正文（`textKind:'full'`）；②`content[]` 为空但**增量已把全文推完**（`item/reasoning/textDelta` 的台账）⇒ 用增量正文封口（仍是 `'full'`）；③两处都没正文**且 `summary` 为空** ⇒ `text:null` + `textKind:'none'`，**绝不回落 `summary`**（摘要是摘要，不是正文）；④`summary[]` 非空 ⇒ 作为**摘要那一块单独产出**（`textKind:'summary'`），此时**不再出 `none` 空块**（代码是 `else if (summary === null)`，两处条件逐字对应）。
- `summary[]` 非空 ⇒ **另出一块** `textKind:'summary'`（两块各自说清自己是什么）。`signature` 恒 `null`（协议条目里没有该字段）。
- ⚠️ **`item/started` 的推理条目一块都不产**：那一刻 `summary` 与 `content` 都还是空数组，那只是「开始推理了」的占位；落一块空快照会把槽位封掉，随后的几十条增量**整段丢弃**。
- 这一格的 `source` 记 `'wire'`：正文来自通知流（`content[]` 与 `textDelta`），**没有会话文件通道**。

**步骤 5｜子任务**
- **身份**：协作条目的 `receiverThreadIds` 给出子线程 id；收尾的身份来自 `thread/list` 的线程 id。`item/started` 时 `receiverThreadIds` 是**空数组** ⇒ 那时不落行、也不编 id（「还没建」与「建了没给 id」在数据上分不开）。
- **名称 = 线程昵称**：运行期取 `thread/started` 的 `Thread.agentNickname`（越早登记越早对得上；⚠️ 真机该通知常只给主线程且昵称为 `null` ⇒ 这条是**兜底**路径），收尾以 **`thread/list`** 交回的 `Thread.agentNickname ?? source.subagent.thread_spawn.agent_nickname` 为准（`thread/read` 那份 thread 只用于取 `turns`）。**不拿 `prompt` 首行充当名称**——`prompt` 只进派发调用块的入参。
- **终态两处判据**：运行期由协作条目的 `agentsStates[<子线程 id>].status` **五档直映**（`completed`；`errored` / `notFound` ⇒ `failed`；`interrupted` / `shutdown` ⇒ `stopped`；`pendingInit` / `running` ⇒ `running`；其余 ⇒ `unknown` + `statusMissing:'unverified'`）；收尾由最后一条 `turn.status`（`completed` / `failed` / `interrupted` 三档，`inProgress` 算在跑）推出，**只有一条 turn 都读不到时**才看 `thread.status`（`systemError` ⇒ `failed`、`active` ⇒ `running`），剩下 `unknown` + `'not-observed'`——`idle` **不当完成**（它也可能是刚派发还没开跑）。
- **`outcome`**：运行期取同格的 `message`；收尾取子线程**最后一条 `agentMessage` 的正文**；只放文本，拿不到就是 `null`。
- **父链**：派发者是主线程 ⇒ `parentSubagentId: null`（照抄主线程 id 会指向一个不存在的节点，界面上面包屑里「主会话」那一段会消失）。`thread_spawn.depth` 读得到，但**契约没有这一格**，当前不出口。
- **派发调用配对**：子任务行的 `parentCallId` = 协作条目的**条目 id**，与派发调用块的 `callId` 同值 ⇒ 界面能把「进入子任务」挂到那次调用上。
  ⚠️ **派发台账当前是「后到覆盖」**：每一条带 id 的协作条目都会写台账，而真机 `wait` 也带 `receiverThreadIds`（同一条子线程）⇒ 随后产出的记录 `kind` 会变成 `wait`、`parentCallId` 会变成 wait 的条目 id，界面入口随之挂到收场那一步。**这是与本节本意相反的行为**（本意是「只有派发动作认领」），**裁决：写入面收窄成「只有派发动作（`tool` 以 `spawn` 开头）才写台账」**——`wait` / `closeAgent` 只更新状态、不动 `kind` / `parentCallId`。⚠️ **今天没有钉住这个口径的用例**：写入点本身**被现有用例间接走到**（`message.test.ts` 里断言的 `kind` / `parentCallId` 就来自台账），但**没有任何用例直接断言 `dispatches`**、也**没有**「`spawnAgent` → `wait` 之后的形状」那一条。裁决落地时要：先改实现（见 §9 第 6 条）、再补那条断言（见 §9 第 18 条 ⑨）。
- **轨迹的实时性**：子线程的 `item/*` 推不推给本条连接由上游定；运行期能到就实时出，**收尾一律 `thread/read` 补齐**，两条入口共用同一个归一函数（同一槽位上的块逐字段相同，不会互相打架）。
- **轮次分量**：该子线程的**模型答复条目** `item.id` 去重后的个数——与合计用同一把尺子，`subagentTurns ≤ turns` 因此是构造上的性质。

**步骤 5.1｜取数时机：内容由通知驱动，收尾补齐子线程**

- **内容不等收尾**：每条通知即时投影成消息草稿，消费方按 `mergeKey` / `subagentId` **覆盖累积**，重发同一条是幂等的。**没有节流读盘这一步**（旧的 `CONTENT_READ_MIN_INTERVAL_MS = 500` / `SAME_SHAPE_REEMIT_MS = 3000` 两道闸门随读盘实现一起删除），也不再有「不读盘就一个字都没有」的风险——通知就是主通道。
- **收尾在后台先跑、以「本轮结算」为闸门**：收尾出口是**同步**的，而 `thread/list` / `thread/read` 是异步请求 ⇒ 收尾取数在运行期就以「本轮结算」为闸门启动，收尾那一刻只读它**已经落定**的结果。
- **流要与它汇合**：正常跑完时流**等取数落定再结束**（否则读数会稳定地慢一拍：枚举成功却被记成 `null` + 一条名不副实的 WARN）；**被终止的那一轮不等**（取消时本就没有实测可取，等下去只会把一次取消拖满释放宽限期）。
- 三条边界：**只取数、不编造**（读不到就一条都不产出，绝不在失败的运行上造出「看起来跑过」的内容）；**不改结论**（取数抛错只记日志，失败仍是失败、成功仍是成功）；**排在释放之前**（收尾与释放共用同一个客户端 ⇒ 读完了才关）。
- **失败与被终止的运行同样有内容**：通知流照旧产出，收尾再补子线程——「它失败前说了什么、调了什么」两条通道都保得住。
- 每次尝试的**线程 id 都不同**（`thread/start` 每次新发）⇒ 同一行的历次尝试互不串号；收尾的 `thread/list{ancestorThreadId}` 只认本次主线程的后代。

**步骤 6｜计量与轮次**
- **运行期的取数优先级：`turn` 自带 > 按线程累计**：`turn/completed` 那一支若拿得到 `turn.usage`（协议是实验面、字段可能后加），**优先采用它**（`usageOfTurn` 里那次收窄读取，**有具名用例钉着**）；取不到才用 `thread/tokenUsage/updated` 的**按线程累计**（`ThreadTokenUsage{total, last, modelContextWindow}`）。⚠️ **收尾回读那一支不读 `Turn.usage`**（`usageOfRun` 只读 `usageByThread`）⇒ 今天两条路取值相同，只是因为窄声明**没有**声明 `Turn.usage`、`readTurn` 也不解析它。`total` 的六格（`totalTokens` / `inputTokens` / `cachedInputTokens` / `cacheWriteInputTokens` / `outputTokens` / `reasoningOutputTokens`）**缺一即整块记 `null`**——不是只丢那一格。
- **`input` 必须减去 `cachedInputTokens`**，并夹到非负（`normalizedInput`）：codex 的 `inputTokens` **含**缓存读，不减就是三家口径里那处真实分歧（命中率被系统性低估）。`cacheWriteInputTokens` **不进 `cached`**（写缓存与读缓存是两件事）。
- **`reasoningOutputTokens` 与 `totalTokens` 运行期就有**（不是「只在会话文件里」）：前者记 `reasoningOutput`、后者记 `total`（厂商自报，只作排障证据，不参与归一后的恒等式）；三项必填格（`input` / `cached` / `output`）缺任一 ⇒ 整格 `null`，**不填 0**。
- **时间**：`Turn.startedAt` / `completedAt`（秒 → 毫秒）现减 ⇒ `timing{source:'events'}`，两点缺一就**整格不带**；`apiMs` / `ttftMs` 恒 `null`。**时长随运行期那条 `usage` 事件走**；收尾补的那一条只交计量与轮次（`timing: null`）。
- **轮次（本行的 `turns`）= 模型答复条目数**：只数 `item.kind === 'agentMessage'` 的 `item.id`，**按线程分别去重**（`countRoundTrips`），运行期与收尾回读**共用同一个函数**。**不要去数 `Reasoning`**：它在部分路由上根本不投送，数它必然与另一侧分叉（把轮次号系统性抬高）。**一次都没数到 ⇒ `null`，不编 0**。
- **运行期**：按**主线程**交 `turns` 与归属 `turn:{subagentId:null, round}`；**不交** `subagentTokens` / `subagentTurns`（那时 `turns` 只有主线程那一份，交了就会破坏 `subagentTurns ≤ turns`）。
- **收尾**：`finalTurns = mainTurns + subagentTurns`（两侧同一把尺，任一为 `null` ⇒ 合计 `null`）；`projected.usage` 本身**已经是主 + 子**的合计（不要再加一次分量，那会把子线程算两遍）。
- **分量口径是「全量或 null」**：**枚举（`thread/list`）失败** ⇒ ①`usageOfRun` 交出 `total: null` / `subagent: null`；②**收尾那条 `usage` 事件因此不发**（发射闸门要 `total` 非 `null`）；③交回的 `TurnFinalize` 里分量两格是**显式 `null`**、合计两格**缺键**（不带）⇒ 骨架按上一段那条不对称规则处理，`AgentRunResult` 的 `subagentTokens` / `subagentTurns` 记 `null` 而 `tokens` / `turns` **保留跑动期采到的主线程读数**——行级表现就是「合计退回主会话口径」（`index.ts` 那条 WARN 的措辞是「合计退回**主线程**口径」，同一个意思）；④再落一条点名 WARN（**没有截断这一档**）。⚠️ **某条线程的 `thread/read` 失败不算**——那只让它少一份内容（子任务行照出、终态取 `ref`），用量与轮次分量照给（判据只看该线程有没有报过用量通知，与内容是否为 `null` 无关）；**没有子线程** ⇒ 分量 `{0,0,0}`、合计就是主线程那一份；**有子线程但没报用量** ⇒ 两格都 `null` + 点名 WARN——绝不拿子那一份冒充总数（界面按「主会话 = 合计 − 分量」会算出负数）。
- **合计与分量同刻成对**：收尾那条 `usage` 的**发射闸门是 `usage.total !== null && finalTurns !== null` 两个条件**（「有子线程但没报用量」时 `total` 为 `null` 而 `finalTurns` 可能是数字，这条同样不发）；发出去时 `tokens`、`subagentTokens`、`subagentTurns`、`turns` 一起交（不留孤儿分量），`subagentTurns` 跟着 `subagentTokens` 一起记 `null`。四格都进 `AgentRunResult`。
- **来源**：收尾那一条是结算值 ⇒ `tokensBasis: 'reported'`（填成 `'estimated'` 的代价是编排层不回写它——而它恰好是收尾那一刻唯一的权威值）。
- **消息级用量恒 `null`**（结构性缺口）：协议只到**线程级**累计，对 `total` 差分在并发子线程与 turn/item 边界不一致时无法证明归属 ⇒ 不拿线程级读数冒充单条消息。
- **`effort` 三档**：未选 ⇒ **两个键都不加**；`off` ⇒ `turn/start` 的 `effort: 'none'`（`codexEffortOf`，**一处映射**）**且** `thread/start` 的 `config.model_reasoning_summary: 'none'`（**两格一起才构成「要求关闭」的必要条件**——它**不等于**真的关掉，见 §3.6 顶部那条 ⚠️）；其余档位原样透传。落点是 `buildCodexConfig(baseUrl, input.route.contextWindow, input.effort === 'off' ? 'none' : undefined)`——**第三实参**，不许挤掉 `contextWindow`。
  ⚠️ **值域依据不是「SDK 类型面」**：app-server 生成的类型把 `ReasoningEffort` 声明成 `string`（历史上那份 `@openai/codex-sdk` 的 `ModelReasoningEffort` 是 8 档、**不含 `none`**，而那个包已不是本仓依赖）⇒ 本仓按 `string` 透传，**不把任何类型面当能力判据**。
- **内容面与用量面共用同一份后代枚举**：收尾一次 `thread/list{ancestorThreadId}` 同时供消息、子任务行与用量三面使用（判据：`Σ 各行 usage === subagentTokens`）；派发信息由运行期的协作条目台账（`runState.dispatches`）提供（⚠️ 后到覆盖的风险见步骤 5）。
- **行的累计与分量用同一条判据**（同一个 `breakdownToTokens`：`input` / `cached` / `output` 三项齐才认）——否则末条缺项时会出现「分量有值、这一行 `usage: null`」。
- **这条通道不读文件**：`read-lines.ts` 的分块读只服务 claude 的子智能体转录；codex 侧既没有转录缓存，也没有行数上限。

**步骤 7｜工具族与已知限制**
- **族按工具名判**（`classifyTool`）：`exec_command` / `shell` / `command_execution` / `write_stdin` ⇒ `run-shell`；`web_search` ⇒ `web-search`；`spawn_agent` / `collab_tool_call` ⇒ `spawn-agent`；`update_plan` ⇒ `task`；`request_user_input` ⇒ `ask-user`；**MCP 与 `dynamicToolCall` 一律 `family: null`**（`name` 取 `<server>.<tool>` / `namespace.tool`，走通用渲染——它们承载任意工具，猜一个族等于编事实）。
  ⚠️ **`apply_patch` 不在族表里**：它是 `fileChange` 那一支**显式传的第四实参**（`family: 'edit-file'`），`classifyTool('apply_patch')` 返回 `null`。
  ⚠️ **真机形状与族表不一致**：协作条目的 `tool` 在真机上是 **camelCase**（`spawnAgent` / `wait` / `closeAgent`），而族表里登记的是 `spawn_agent` ⇒ 派发调用块在真机上 `family: null`、走通用渲染。⚠️ **今天没有这条断言**：夹具用的是族表拼写 `spawn_agent`（落 `family: 'spawn-agent'`），真机拼写只钉到 `wait` 那一格（`{ family: null, name: 'wait' }`），`spawnAgent` 这一格没有用例。要么把 camelCase 补进族表并同步改声明，要么如实写「这一格真机取不到」——两条路都得**先补一条 `tool: 'spawnAgent'` 的断言再定稿**。
- **文件改动有独立条目**：`fileChange` ⇒ `apply_patch`（`edit-file` 族）的调用 + 结果两条（`structured = {changes, status}`，`failed` / `declined` 都算错误）——**不再经 `exec_command` 承载**。文件**读取**类四族（`read-file` / `write-file` / `search-content` / `list-files`）在当前模型预设的工具表里取不到值（随预设变化，不要写死"这家没有文件工具"）。
- 联网工具在本仓配置里被关掉（`config.tools.web_search = false`）⇒ `web-search` 族取不到值；投影路径仍在（真出现 `webSearch` 条目照常出调用 + 结果）。
- **工具真名的两个来源**：协作条目**自带**（`spawnAgent` / `wait` / `closeAgent`），命令类**由适配器补**（`exec_command`）。条目类型名（`commandExecution` / `collabAgentToolCall`）是派生名，不要当工具名。
- 命令输出是 stdout 与 stderr 的**合流**（`aggregatedOutput`）⇒ 归一结果里**不编 `stderr`**；`exitCode` / `durationMs` 取不到时整格 `null`，`isError` 只在退出码非零时为真。**截断标记厂商不给** ⇒ 只有我们自己截过才是 `truncated`，其余记 `unknown`（不写「完整」）。
- **问用户 / 审批结构性不可用**：协议形态是 **server→client 请求**（要回帧才算应答），本仓 `approvalPolicy: 'never'` 且**不应答** ⇒ 适配器**不合成任何问答块**，`ask-user` 族**恒空**。⚠️ 不是记 `outcome: 'unavailable'`——没有块就没有 `outcome` 可挂（这一条与 `2026-10-07-codex-dsh-parity.md` §3 的「记 `unavailable`」冲突，需在那一份里裁决）。
- **计划**：`update_plan` 需要显式开启（`tools.update_plan.enabled = true`）才出现在工具表；它落成 `turn/plan/updated` 的**整表覆盖**清单（与单条 `plan` 条目同形）⇒ 计划卡只有一张，由 `family:'task'` + `payload.kind:'plan'` 驱动；`status` **不是原样透传**，而是按别名归一（`completed` / `in_progress`·`inProgress` ⇒ `inProgress` / `pending`·`todo` ⇒ `pending`，另认 `completed: true`）后落契约四态，认不出的记 `unknown`；单条 `plan` 条目没有状态格（记 `unknown`），恢复不出 `in_progress` 这句已不成立。

**步骤 8｜多智能体开关**
- **`features.multi_agent = true`（必须开）**，写在 `config` 的 `features.` 下；写在 `tools.` 前缀下会被忽略。理由：子智能体是评测面之一（另两家默认可用），而**关掉换不来「安静地没有子任务」**——`spawnAgent` 会变成一次**失败的工具调用**（token 花了、轮次占了、工具结果里躺着配置提示），通知流里连 `collabAgentToolCall` 都没有 ⇒ 子任务面板**恒空**。
- 能力随路由翻转（**真机结论，代码侧没有判据**）：同一条 `spawnAgent` 调用，某些自建网关路由会判 `unsupported call`，带工具列表的请求也可能被网关整体拒绝；另一条路由上整条派发链（`spawnAgent` → `wait` → `closeAgent`）跑得通。**模型名是否被该版本认识不是决定因素**。被拒时的表现是「模型调了、被拒」，通知流里有那条失败的工具结果 ⇒ 界面据此说「派发被路由拒绝」，而不是「没派子任务」。
- ⇒ 必须把路由与模型名记为能力声明的前提：同一份能力位在不同路由下取值不同，不得把某一条路由上的取值写成这家的固有属性。

**多智能体条目的形状与投影**（`collabAgentToolCall`）：
- 真机形状（逐字）：`{ type:'collabAgentToolCall', id, tool:'spawnAgent'|'wait'|'closeAgent', status, senderThreadId, receiverThreadIds:[子线程 id], prompt, model, reasoningEffort, agentsStates:{<子线程 id>:{status, message}} }`。它在 `item/started` / `item/completed` 两种通知里都出现；⚠️ `item/updated` 这一家**没有**（那是已删除的 SDK 时代形态）。它**在本适配器自己的条目联合里**，但**不在 `@openai/codex-sdk` 声明的 item 联合里**——那个包已经不是本仓的通道。
- **`item/started` 时 `receiverThreadIds` 是空数组**（子线程还没建）⇒ 只在拿到 id 时才落子任务行，**不编一个 id**（「还没建」与「建了没给 id」在数据上分不开）。
- **一条子任务会来多条协作记录**（`spawnAgent` → `wait` → `closeAgent`），每条都带同一个子线程 id ⇒ 子任务行按 `subagentId` 覆盖累积。⚠️ 派发台账的**后到覆盖**风险见步骤 5：`kind` / `parentCallId` 可能落在收场那一步。
- **派发调用也要落一条消息**：界面上「进入子任务」的入口挂在派发工具调用上，只交子任务行、不交调用 ⇒ 占位条画不出来。配对键是**条目 id**（调用块与子任务行两侧同值）。名字不在族表里的协作动作（`wait` / `closeAgent`）⇒ `family: null`，走通用渲染。
- **终态**见步骤 5（运行期五档、收尾三档 + `unknown`）。收尾用 `thread/read` 交出更完整的同 `subagentId` 记录（`outcome`、`turns`、用量、父链），读侧按身份覆盖；**昵称不在这里**——它取自 `thread/list` 交回的那一格（见步骤 5）。

### 4.3 dsh

**步骤 1｜建会话**
- 用 Harness 类建会话并订阅通知；协议类型（openai 兼容 / anthropic 兼容）与模型在路由配置里给。
- **本行的路由 patch 要一次写全三件事**：① 路由与档位键；② `- insert: [{ id: tool-ask-user, name: '@deepseek-ai/dsh-tool-ask-user' }]`——`dsh-base` 与 `dsh-sdk-app` 两个 bundle **都不带**它，不加就没有问答工具（包已随 dsh 装好，**不需要**改 profile 的 `dependencies`）；③ 关联网时 `- id: tool-web` + `config: { search: false, fetch: true, searchTimeoutMs: 60000 }`（三格缺一就被整份替换 + schema 默认值改回去，见 §8.1）——⚠️ **③ 当前尚未落地**：适配器产出的 patch 只有 ① 与 ② 两段，`tool-web` / `searchTimeoutMs` 在 `agents/src` 里搜不到 ⇒ 落地前 §7.4 与 §8.1 里「dsh 的搜索被关掉」**不得当既成事实**引用。**落点是每行的 `DSH_HOME/aieval-route.patch.yml`**（per-launch overlay，绝对路径交给 dsh 的 `--patch`，层序在 profile 之上）；`profiles/sdk/cordis.patch.yml` 是**已退役**的旧落点（那是 dsh 自己的持久化层、Settings 会写它，适配器不再碰它，有反向守卫）。适配器自己 `mkdir` 该行配置目录并把这份 overlay 写进去，profile 仍由 dsh 播种，**改全局 `~/.dsh` 对评测无效**。
- 通知共四种 method：`session.event`（具体事件）、`session.status`（会话级状态）、`subagent.started`、`subagent.finished`。前两种的 `params.sessionId` 标出事件属于哪个会话——**子会话的事件也在同一条流里**，带的是子会话自己的 id；后两种是顶层通知，不套在 `session.event` 里。

**步骤 2｜块协议**
- 消息块取自 `assistant/message` 的 `data.message.content[]`：`text` / `reasoning` / `tool-call` 三种，**一条消息就是一次完整快照**（三条消息草稿恒 `chunk:'snapshot'`，块也恒 `snapshot`）。空内容或一个块都没有 ⇒ 不产消息。
- 块序号在**每条 `assistant/message` 内**顺序分配（`index = blocks.length`）；它与 `data.stream[]` 里的 `chunk.index` 是**两个空间**，不要混用。
- **`data.stream[]` 那条增量通道当前没有取数实现**：`chunk:*`（`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`）与 `*-chunks`（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）两族条目都**不解析**——⚠️ 它们是 **`assistant/message` 载荷里 `data.stream[]` 的条目，不是独立通知**（真机 dump：20 条通知里增量类独立事件 0 条），归一那一层不读这个数组 ⇒ **不产独立事件、也不落 attachment**。⚠️ **但「不落盘」是错的**：`assistant/message` 在推理文本非空时会落一条 `logDraft('stdout', safeStringify(整条通知))`（真机该路由每次往返都有非空推理）⇒ `data.stream[]` 与它的逐段文本**会随原始负载逐字进 log**，去噪并未实现（与 §4.1 的 `system/thinking_tokens` 同一形状）。其中 **`reasoning-delta` 这条路由根本不产出**（推理整块在 `block-end` 到达）⇒ 不要为它写等待逻辑。能力位已按 `streamingDelta: 'not-projected-by-vendor'` 声明（与实现一致，见 §3.5 / §7.3）。
- **思考没有逐字增量**：推理正文整块到达 ⇒ 思考按整块渲染，不要等逐字增量；主任务与子任务同理。

**步骤 3｜归一消息**
- **`assistant/message`**：`data.message.content[]` 给块，`data.usage` 给该次往返用量（**同时摊到这条消息的 `usage` 上**，见 §3.2），`data.turn` / `data.step` 给厂商轮号与该会话自己的步号。
- **消息信封的两个号**：`roundTrip` 取 `data.step`（**该会话自己的**，不是本行全局累计——否则主会话时间轴会出现 `1,2,5,6` 的洞），`vendorTurn` 取 `data.turn`；`usage` 事件的归属键同刻带 `(sessionIdProfileSubagent(sessionId), data.step)`（见 §2.6）。**`state.turns` 照旧全局自增**（`EvalRow.turns` 与「主 + 全部子」的口径靠它），两者不得互相顶替。
- `tool/call` 给 `callId` / `name` / `arguments`（`arguments` 是 **JSON 字符串**，要自己解析）；`tool/result` 给 `message.{toolCallId, content[], isError}`，另有 `error?` 与 **`meta`**——**结构化结果在 `meta` 里**（`content[]` 只是给模型看的那份文本）。
- 块类型是 `reasoning` / `text` / `tool-call`，且 `reasoning` 块**也带 `text` 字段** ⇒ 取值必须先按 `type` 过滤，绝不按 `text` 字段取值（否则推理正文会混进最终答复）。

**步骤 4｜子任务**
- **身份三级兜底**：`subagentId` → `agentId` → `childSessionId`（三个名字指的是同一个东西，哪一格有值随版本与通道而变）。**只认后两个会让一条子会话消息都归不到**（本机载荷只有 `subagentId` / `vendorId` / `parentSessionId`），而多登记一个不存在的 id 是无害的。三个候选名都登记进「哪些会话是子会话」的表，消息据此归到子任务上；`parentSessionId` 另进一张**否决表**（防止把主会话的消息认成子智能体的）。
- **订阅必须放行整棵会话树，不是只放行主会话**：子会话的 `session.event` 与主会话在**同一条通知流**里，`params.sessionId` 是**子会话自己的 id**；判据写成「只放行主会话那个 id」会把子智能体的 `assistant/message` / `tool/call` / `tool/result` **全部丢掉**（抽屉里占位条在、点进去一个字都没有）。放行三条：**不带会话归属的顶层通知一律放行**（`subagent.started` / `subagent.finished` 没有 `params.sessionId`，而它们是子会话 id 的**唯一来源**）；本会话的事件放行；**已登记的子会话**的事件放行。
- **名称与类型**：另一条会话事件 `subagent/catalog` 给 `childId` / `createdAt` / `mode`（`one-shot` / `continuable`）/ `label?`；**`provider` 不在 catalog 里**，只在 `subagent.finished` 上。catalog 可能先于 start / finish 到达 ⇒ 要按 `childId` 记住（它**不产任何事件**，只登记），否则收场时名字只能填 `null`。名称取 catalog `label`，类型取 catalog `mode`（收场时 `provider` 优先）。
- **`subagent/descriptor` 不得当身份来源**：它的 `data` 里**没有 `childId`**（身份只在信封的 `params.sessionId` 上），而且**不是逐子任务必发**（三个子任务可能只到两条）⇒ 身份只能取自 `subagent/catalog` 或顶层通知。⚠️ **它今天零读取点**（`DSH_SUBAGENT_DESCRIPTOR_TYPE` 是死常量，事件直接落「未识别」兜底）⇒「名字与类型也可以取它」**本期未落地**：名字与类型当前只有 catalog 一条来源（收场时 `provider` 优先）。
- **终态按 `stopReason` 分档**（`status` **只在 `completed` 那一支**参与，不是笛卡尔表）：`stopReason === 'completed'` ⇒ 再看 `status`，逐字 `'ok'` 记 `completed`、**其余（含缺失）记 `failed`**；`max-tokens` / `error` ⇒ `failed`；`aborted` ⇒ `stopped`（这三档**不看 `status`**）；其余（`refusal` / `null` / 未观测值）⇒ `unknown` + `statusMissing: 'unverified'`，**不猜**。**硬规则：只要 `stopReason !== 'completed'`，一律不得记成 `completed`**。
- 结果摘要取 `subagent.finished` 载荷里 `lastAssistantMessage` 的 `type='text'` 块（非空块按换行拼接）；取消场景可能只有 `reasoning` 块，此时 `outcome` 保持 `null`，不得拿推理顶替。
- **`parentCallId` 与 `parentSubagentId` 都记 `null`**：通知载荷里没有可对齐的调用 id（`subagent` 工具调用的 `callId` 是 `call_…|<uuid>` 复合形状，与身份不是同一个值），也没有父 id。界面因此退化为「派发工具入参里的任务名 == 子任务名」逐字相同才认派发点。
- 子智能体轨迹直接从通知流里取（`params.sessionId` = 子会话 id）；运行时被强制终止时不会收到 `subagent.finished` ⇒ 面板必须能显示「未收场」。
- 归属键没有工具调用 id，只有会话 id 层级；跨家比较时不要把它当「调用级」归属。

**步骤 4.1｜子智能体那一份用量与轮次（按子会话分组求和）**

- **为什么按白名单求和**：按会话记的两张表（用量 `sessionUsage`、轮次 `sessionTurns`）是**模块级**的——同一个 Node 进程里并行跑着好几行，主会话之外还有**别的行**的会话。只有「本行的子会话白名单」能把这一行圈出来（白名单来自通知流：`subagent.started` / `finished` 的身份）。
- **用量分量** = Σ 白名单里各子会话的 `assistant/message.data.usage`（三项必填格齐才累加，缺项整条丢弃；同一条载荷的 WARN 由 `events.ts` 的 `readTokens` 落一条——**分组累加那一支自己静默返回**，WARN 只有一个落点）。三档：
  - 白名单为空 ⇒ `{0,0,0}`（**确实没有**，不是 `null`）；
  - 子会话**已收场却一条用量都没报** ⇒ `null`（事实缺失）；
  - 仍在跑的子会话 ⇒ 按「到目前为止」计入。
- **轮次分量** = Σ 白名单里各子会话的 `step/start` 计数，三档与用量**逐字相同**（同一份白名单、**同一个**事实缺失谓词 `dshSilentChildSessions = 白名单 ∩ 已收场 − 有用量`）。两格由**同一条 `step/start`** 驱动（合计 `turns` 全局自增的那一行旁边就记这一格），故 `subagentTurns ≤ turns` 是构造上的。判据取「有没有报到用量」而不是「有没有 `step/start`」：后者是**第二个谓词**，会与用量那一格分歧（一个子会话报了用量却没有 step 时，两格会一格有数一格 `null`，而 WARN 只说得清其中一格）。
- **两条出口路径（常规事件出口 + 收尾）**：
  - **带分量的三条事件出口**（`step/start`、`assistant/message`、`turn/end`）**都同时带两格**——否则会出现「上一版的非零用量分量 + `null` 的轮次分量」这种两句互相矛盾的话摆在同一格上；
  - **收尾（`finalize`）也交一次**：`usage` 事件的发射门槛是**轮次**，而「子会话收场却没用量」这个结论是在**不带轮次**的 `subagent.finished` 上成立的 ⇒ 那一轮之后再没有消息时结论就送不出去。收尾每次运行都跑，且分量的**显式 `null` 会覆盖**旧值。
- 分量走 `null` 时**必须点名**：WARN 文案列出那些「已收场却没有用量事件」的子会话 id，并说清「tok 与轮次的分量都给不出（不编造、不填 0），合计仍是已观察到的全树读数」。`{0,0,0}` / `0` 那一档（确实没有）**不刷噪声**。
- 累加**没有去重键**（这一家从不写 `state.seen`）：唯一的去重是 `usage` 事件的发射门（与上次逐字段相同就不发），它只决定「要不要发这条事件」，不改已累加的值。
- 合计 `tokens` / `turns` 与另两家不同源：它由适配器**逐条无条件累加**得到（不是「主 + 子」拼出来的），所以「读失败时退回主会话口径」这条**机制**在这一家不成立——已经并进来的别的子会话用量退不回去。三家的共同保证因此落在另外两条上：① 分量一律 `null`（界面据此一律退回一行）；② `subagentTokens ≤ tokens` 照旧成立。

**步骤 5｜容错与状态**
- 权限与审批类事件（`approval/asked`、`approval/decided`、`approval/policy`、`permission/preset`、`sandbox/mode`）至少投影成 `log` 行，不要静默丢弃：无人值守的运行里审批不会被应答，这些行是排障的唯一线索。
- 任何未识别的事件也要投影成一条 `log`，保留原始载荷。
- **有意不投影的清单**（与上面两条分开——它们**不产独立事件、也不落 attachment**）：`data.stream[]` 的两族增量条目（`chunk:*` 与 `*-chunks`，当前没有取数实现；它们是 `assistant/message` 载荷里的条目，不是独立通知）。⚠️ **「不落 `log`」是错的**：`assistant/message` 在推理非空时会整条 `safeStringify` 落一条 `log` ⇒ 这些条目**随原始负载进 log**，去噪未实现。⚠️ **`session.status` 不在此列**：非 `session.event` 的 method 一律走「未识别事件」兜底 ⇒ 它**落一条保留原始负载的 `log`**（不产 typed 事件，但**不静默丢弃**，见本章步骤 5 第二条）；`subagent/catalog` 才是真正「只登记、不产事件」的那一条。
- **`turn/end` 的失败投影**：`reason.kind === 'error'` ⇒ 落一条 `error` 行级事件；`turn/start` / `turn/end` 同时是轮次边界（归属键见 §2.6）。

**步骤 6｜计量**
- 用量在 `assistant/message` 的 `data.usage`：`inputTokens`（**不含**缓存，直接当 `input`）/ `cacheReadTokens`（当 `cached`）/ `outputTokens`（当 `output`，已含思考量）/ `totalTokens`（厂商自报总量，只作参考，不参与归一后的加和）。**三项必填格缺任一 ⇒ 整条不计入并落一条 WARN**，绝不填 0。
- 累加**不清零**：三项逐条相加；`reasoningOutput` 读到才相加（一格都没读到才是 `null`）；`total` 是累计快照 ⇒ **只覆盖、不相加**。
- `cacheWriteTokens` 不进 `cached`：缓存**写**不是缓存**读**，把它算进命中率会得出「第一轮就命中」的假象。
- `reasoningTokens` 在类型上存在但当前通道不写这一格 ⇒ 记 `null`，不要用 `outputTokens` 去凑。⚠️ **契约没有「思考 token」能力格**（`MessageCapability` 只有五格）⇒ 这条事实登记在该家的 `messageCapability.notes` 里（「`llm-pi-ai` 的 `mapUsage()` 把推理并入 `outputTokens`」），不要按能力位读它。
- 时间从会话事件的 `time`（毫秒）算，标 `'events'`（`apiMs` / `ttftMs` 恒 `null`）；只认三处带时间的通知（`turn/start` / `assistant/message` / `turn/end`）。
- **轮次**：`step/start` 每来一条记一次（**唯一计数点**，不分会话 ⇒ 合计天然是全树的）；消息信封上的 `roundTrip` 取**该会话自己的 `data.step`**（取不到时退回该会话已数到的 step 数，一次都没有给 1——信封这一格是必填正整数；**不得回落本行累计号**，见 §2.6）。
- **子智能体那一份**（`subagentTokens` / `subagentTurns`）见步骤 4.1：按本行子会话白名单分组求和，与合计同刻成对交出。

**步骤 7｜工具族与路由 patch**
- 工具表约 25 项；五类文件工具（`read` / `write` / `edit` / `grep` / `glob`）都有结构化结果，落在 `tool/result` 的 `meta` 里：`read` 给 `{lines[], totalLines}`、`grep` 给 `{shape:'matches', files[], total, truncated}`、`glob` 给 `{shape:'paths', paths[], total, truncated}`、`write` 给 `{operation, diffs[]}`、`edit` 给 `{diffs[{path, oldText, newText}]}`。**写文件的字节数拿不到**，`edit` 的替换处数也拿不到 ⇒ 这两格保持 `null`；有 `meta` 就不要退回去解析文本。
- `pwsh` 的结果**没有 `meta`**：退出码只在文本尾部的 `[exit code: N]` 里，成功时不带这个尾部 ⇒ 该格保持 `null`，不要填 0。
- 关闭联网工具时（⚠️ **该 patch 尚未落地**，见步骤 1），路由 patch 是**整份替换**语义：只写要改的那一格会把同组的其它键抹掉，随后被 schema 默认值悄悄改回。必须把该组的全部键一次写全。

**步骤 8｜交互**
- `ask_user_question` 可用；无人应答时工具结果 `isError` 为真，文本形如 `Error: no user-questions answerer accepted the request` ⇒ 按设计该族记 `outcome: 'unavailable'`，不要当成用户拒绝。⚠️ **这一档尚未落地**：消费侧今天只产出 `state: 'pending'`（`AskUserSettled` 没有构造点），`isError ⇒ 'unavailable'` 的映射要补。子智能体内不可发起提问（该限制在另两家同样成立），调用会被拒并给出说明调用方归另一个智能体所有的文案。

---

## 5. 工具族与面板投影

### 5.1 分族规则

族名由**工具名**决定，不由家决定。归不进任何一族的工具，`family` 记 `null`，并在 `name` 里保留原名（消费方对 `null` 走通用渲染）。

**渲染侧的硬约束**：UI **只按 `family` 分支，不按 `name` 或 `agentKind` 分支**（按名字分支等于把厂商适配搬进界面，工具表一改就静默失效）。⚠️ **唯一例外是「哪次调用是派发点」**，而它今天是**一条三级回填链 + 两条按名字的谓词**（收口时应当只有**一个**谓词、并且补上守卫）：

- **回填链**（按顺序，前一级认领过就不再参与）：
  1. **`parentCallId`**：适配器给的那一格是权威（`SubagentRecord.parentCallId` == 某次工具调用的 `callId`）⇒ 直接挂上去（另有一次「时间回填」只补 `at`，不改判派发点）；
  2. **身份即调用 id**：`subagentId` 恰好等于某个 `callId` 时按 id 认领（厂商把两套 id 合成一套的形态）；
  3. **名字回填**：调用块**过 `isDispatchCall`** ∧ 它的入参里带任务名（`dispatchNameOf`）∧ 某个**尚未认领**的子任务 `name` 与该名**逐字相同** ⇒ 认领。**这是 dsh 唯一可用的那条**——它的 `parentCallId` 恒 `null`、`kind` 又是 catalog 的 `mode`（进不了正则），少了这一条 dsh 的「进入子任务」入口整段不可达（见 §4.3 步骤 4）。
- **两条按名字的谓词**（就是上面第 1 / 第 3 级用的判据）：`isDispatchCall`（判**调用块**的 `name`：`family === 'spawn-agent'` **或** `/^(subagent|spawn_agent|task|agent)$/i`）与 `claimsDispatch`（判**子任务记录**的 `kind`：`/spawn|task|agent/i`）。⚠️ **后者今天不起作用**：它所在的循环**紧接着被一个不带该判据的同形循环整段覆盖**（两处都无条件写 `spawnedBy`）⇒ 第 1 级实际退化成「同一身份**最后一条**记录」（与 §4.2 步骤 5 的「后到覆盖」同源）。`kind` 本身是**厂商原文**、不该拿它判派发点（见 §2.8）。

> ⚠️ **本表的「归一入参 / 归一结果」两列是目标口径，当前**只有 `task` / `ask-user` 两族的**族载荷**（`payload`）落了地（见 §2.2 的 `ToolCallPayload`）。其余八族的那些字段（`totalLines` / `lineNumbersIncluded` / `created` / `bytesWritten` / `applied` / `replacements` / `diff` / `matches[]` / `fileCount` / `matchCount` / `files[]` / `stdout` / `stderr` / `status` / `outputPath` / `results[]` / `answer` / `subagentId` / `vendorId` / `outcome` / `counts` / `source` / `answers[]`）**在代码里都没有落点**：契约的 `ToolResultBlock.structured` 只是厂商结构化结果的**原文透传**，UI 按「结构化结果」渲染。补齐它们是一次独立的改造，**不要**按本表去读现在的产物。

| 族 | 命中条件 | 归一入参 | 归一结果 |
|---|---|---|---|
| `read-file` | 读单个文件 | `path`、可选 `offset`/`limit` | `totalLines`（有则填；**行数取它，不要用行号最大值**——那会系统性多算 1 行）、`lineNumbersIncluded`（厂商已带行号 ⇒ `true`，UI 不得二次编号）、`kind`（`text`/`image`/`pdf`/`notebook`/`unknown`）、`mediaType`、`bytes`、正文 |
| `write-file` | 新建/整体写入 | `path`、`content` | `created`（新建 / 覆盖）、`bytesWritten`（拿不到则 `null`） |
| `edit-file` | 局部替换 | `path`、`edits[]`（每项 `{oldText, newText, replaceAll}`） | `applied`、`replacements`（拿不到则 `null`；整体替换模式下数量不可知）、`diff`（厂商给了就用厂商的，比我们自己算准） |
| `search-content` | 内容检索 | `pattern`、`caseInsensitive`、`mode`（`content`/`files-with-matches`/`count`/`null`）、可选 `path`/`glob` | `matches[]`（`{file, line, text}`）、`fileCount`、`matchCount`、`truncated`（`mode` 与 `truncated` 一起决定 UI 是列命中还是给「命中已存到另一个文件」的路径） |
| `list-files` | 文件名匹配/列目录 | `pattern` 或 `path` | `files[]`、`count`、`truncated` |
| `run-shell` | 执行命令 | `command`、可选 `shell`/`cwd`/`timeoutMs` | `exitCode`（拿不到则 `null`）、`stdout`、`stderr`、`status`（`completed`/`failed`/`running`/`unknown`）、`outputPath`（长输出只给路径时填，UI 据此渲染「输出已存至 `<path>`」而不是「输出就是这些」）、`truncated` |
| `web-search` | 联网检索 | `query`（dsh 给的是复数 `queries[]` ⇒ 取首个进 `query`，其余进 `raw`） | `results[]`（`{title, url, snippet}`）、`answer`（有的家给一句总结） |
| `spawn-agent` | 派发子智能体 | `prompt`、可选 `name`/`agentType`/`forkTurns`（`none`/`all`）/`model`/`background` | `subagentId`、`vendorId`、`outcome`（子任务最终答复的摘要，供工具卡片直接显示） |
| `task` | 进度清单维护 | 整表替换或逐条 patch | `steps[]`（`{id, subject, status, owner?, blockedBy?}`）、`counts`（派生值，⚠️ **契约里没有这一格**：界面自己数，且是**四格含 `unknown`**——分母漏了它必然偏小）、`source`（`'tool'` / `'event'`，⚠️ **契约里没有这一格**） |
| `ask-user` | 向用户提问 | `questions[]`（`header` 是短标题——v2 建议 ≤ 8 字符但**本仓不截断、按原样透传**；选项数、`multiSelect` 默认 `false` 同样按厂商原样） | `answers[]` / `outcome` 七态（⚠️ **契约里没有这两格**：七态只在界面类型里，且**答案的配对键是 `header`**（不是 `questionId`）；产物侧当前只产出 `state:'pending'`——见 §4.3 步骤 8） |

归一结果里取不到的格一律记 `null`，不得用 0 或空串顶替。**截断那一格的口径按契约的三态 `TruncationState`（`none` / `truncated` / `unknown`），不是布尔**：拿不到截断标记就记 `unknown`，消费方**不得**据此断定输出完整。（`diff-summary` 事件上那个 `truncated` 是**另一格**的布尔，别把两者当成同一个字段。）

**后两列与原始载荷的关系**：后两列是**适配器要从厂商原文里取到的事实**（例：codex 命令条目的 `command`、dsh `tool/call` 的 `arguments.command` 与 claude 的 `command` 都归到 `command` 一格），取不到就 `null`；`input` / `structured` / `raw` 里的**原始载荷照旧原样保留**，两者并存——归一字段供渲染与统计，原始载荷供排障与「形状没覆盖到」时的兜底。**契约与消费方都不硬编码工具名**：`name` 一律原样透传，`family` 只做映射（厂商改名单、加名单都不影响契约）。⚠️ **厂商侧是另一回事**：codex 的三类条目**根本没有工具名字段**，`exec_command` / `apply_patch` / `update_plan`（以及 `web_search`）这几个真名是**适配器合成**的（`providers/codex/message.ts` 的三个常量）——它们不是厂商原文，跨家比较时要按「合成名」标注。

**三态显示口径**（对每一族的归一结果都成立）：**归一结果非空、但关键字段是 `null`** ⇒ **不显示为成功**，标「未采集」（`ToolResultBlock.structured` 只是原文透传，没有统一的 `ok` 格——别按一个不存在的字段判成败）。`textKind` 可以渲染，但**不得据它回推厂商**。

**问答族的消费方义务**（`ask-user`）：答案以 `header` 为配对键（`selected[]` 装的是**选项标签**，不是 id / 下标）；`custom`（自由输入）在**多选**时是**追加**（标签与自由输入都显示）、在**单选**时是**覆盖** `selected`——**不得一律追加**（单选会同时显示两个答案）。`recommended` **只加一个「推荐」标注、不改选项顺序**（`ask-user-card.tsx` 的守卫逐字钉着「顺序一个字不动」；适配器也不排序）；`allowOther` 追加自由输入入口。收场方式七态：`answered` / `auto-resolved` / `skipped` / `timeout` / `unavailable` / `rejected` / `canceled`，**必须按 `outcome` 呈现**，不得假设三家都会挂住或都会收场（dsh 阻塞且没有超时预算、codex 结构性无问答、claude 有超时与 AFK）；子智能体内一律不能提问。⚠️ **这一族今天只到「问」这一半**：`outcome` 与 `answers[]` 在契约里都没有落点，产物侧只产出 `state: 'pending'`。

### 5.2 三家工具名 → 族

| 族 | claude-code | codex | dsh |
|---|---|---|---|
| `read-file` | `Read` | — | `read` |
| `write-file` | `Write` | — | `write` |
| `edit-file` | `Edit`、`MultiEdit`、`NotebookEdit` | `apply_patch`（适配器从 `fileChange` 条目补出的真名；⚠️ **它不在族表里**——`fileChange` 那一支是**显式传** `family: 'edit-file'`，`classifyTool('apply_patch')` 返回 `null`，见 §4.2 步骤 7） | `edit` |
| `search-content` | `Grep` | — | `grep` |
| `list-files` | `Glob`、`LS` | — | `glob` |
| `run-shell` | `Bash`、`PowerShell` | `exec_command`（**适配器合成**的真名）/ `commandExecution`（**条目类型名**，不在族表里）/ `shell`、`write_stdin`（族表里登记的拼写） | `pwsh` |
| `web-search` | `WebSearch`、`WebFetch` | `web_search` | `web_search`、`web_fetch` |
| `spawn-agent` | `Task` / `Agent`（**同一工具的两种叫法**，谁叫哪个随模型与工具表档位变；两个名字都映射到本族） | `spawn_agent`（族表登记的拼写）/ `collab_tool_call`（族表登记的拼写，**无产出点**）；协作**条目类型**是 `collabAgentToolCall`，适配器取的是条目里的 `tool` 字段。⚠️ **真机的 `tool` 是 camelCase**（`spawnAgent`），族表里没有它 ⇒ 那一格 `family: null`，是一个待收口的缺口（见 §4.2 步骤 7） | `subagent`、`subagent_fork` |
| `task` | `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` 或 `TodoWrite` | `update_plan`（工具；落成 `turn/plan/updated` 与单条 `plan` 条目，**不再是 `todo_list`**） | `todo_write` |
| `ask-user` | `AskUserQuestion` | `request_user_input`（协议上是 server→client 请求，本仓不应答 ⇒ 族恒空） | `ask_user_question` |

`mcp__<server>__<tool>` 这种形态**刻意不进任何族**（`family` 记 `null`，`name` 保留原名）：它是外部工具，归进十族里的任何一族都会让那一族的统计混进别人的数据。codex 侧的 MCP 名字是 `<server>.<tool>`（点号），同样不进族。

codex 的 `family` 判定补充：`commandExecution` 条目一律落 `run-shell`（它的 `aggregatedOutput` 是 stdout 与 stderr **合流**，拆不开 ⇒ 不编 `stderr`；`exitCode` 在运行中缺省 ⇒ 记 `null`）；`fileChange` 落 `edit-file`（真名 `apply_patch` 由适配器合成，**不再经 `exec_command` 承载**）；`collabToolCall` 的调用块按条目里的 `tool` 名归族（命中族表时才是 `spawn-agent`）；**`plan` 条目与 `turn/plan/updated` 都折成 `update_plan` 调用 ⇒ 落 `task` 族**；其余条目：`dynamicToolCall` **出调用块**但显式 `family: null`（`name` 取 `namespace.tool`）；`userMessage` / `toolOutput` / `other` **一条消息都不产**；`subAgentActivity` **只产子任务行、不产块**。

**codex 的两个命名空间不要混为一谈**（这是本节的坑）：**模型侧工具表**里的名字是 `multi_agent_v1` 命名空间下的 snake_case（`spawn_agent` / `wait_agent` / `close_agent` / `send_input` / `resume_agent`，两份 2026-09-30 的入站 `tools[]` 实测都是这样）；而 **app-server 协作条目字段** `tool` 是 camelCase（真机 `spawnAgent` / `wait` / `closeAgent`）。族表按前者登记、代码按后者归类 ⇒ 真机那一格 `family: null`。⚠️ 那两份实测都**早于 app-server 迁移**；**旁证已有**——迁移当天（2026-10-07）的真机产物里，模型仍以 `namespace: "multi_agent_v1"` + `name: "spawn_agent"` 发起 `function_call`（该产物在 `probe/dumps/**`，未入库）⇒ 命名空间与 snake_case 拼写在 app-server 路径上**仍然成立**。缺的只是**迁移后的入站 `tools[]`** 那一份抓包（**要重新抓一次**才能从「旁证」升为「直证」）——所以这里写「两个命名空间并存」，**不要**写成「snake_case 已退役」。

**名字是否出现由各家的配置与模型决定，不影响映射本身**：

- claude-code：`MultiEdit`、`LS`、`PowerShell` 在**当前工具表里不出现**（保留映射以兼容工具表变化，不表示当前会出现）；`Task*` 与 `TodoWrite` 二选一（设 `CLAUDE_CODE_ENABLE_TASKS=0` 时才换成 `TodoWrite`，⚠️ 该键**本期未落地**，见 §8.1）；`AskUserQuestion` 要注册 `canUseTool` 回调才出现（⚠️ **本期未注册**，见 §8.1）；`WebSearch` **按模型名分档**（`/claude/i` 命中则放行，否则禁用；§9 第 19 条想收成无条件禁用，**尚未落地**），`WebFetch` 不受此限——**`web_fetch` 不属于「搜索」**，本仓只禁搜索。
- codex：`update_plan` 需显式开启（`tools.update_plan.enabled=true`）才出现在工具表；`web_search` 在本仓配置里被关掉（`tools.web_search=false`）；**问用户/审批结构性不可用**（协议上是 server→client 请求，本仓不应答）；多智能体需 `features.multi_agent=true`。
- dsh：`web_search` / `web_fetch` 是否可用取决于该行的路由 patch（关闭联网工具时是整组键的替换语义：只写要改的那一格会把同组其它键抹掉）。

### 5.3 `task` 族的合并语义

**适配器不做跨调用累积**：`tool-call` 块上的 `payload`（`kind: 'plan'`）就是**本次调用之后的整张清单**，跨快照的差分是消费方的事。三家的入参形状不同，归一只有一处：

| 家 | 入参形状 | 归一 |
|---|---|---|
| claude-code | `TodoWrite` 的 `{ todos: [{ content, status }] }`（**整表**）；`Task*` 四件套是逐条 patch 的注册表，入参里没有清单键 | `payload.kind='plan'`，`subject` ← `content`；`Task*` 的调用 ⇒ `payload: null`（**回落成通用工具行**：`family` 仍是 `task`，界面上按普通工具行显示，调用不消失；⚠️「未使用进度清单」那句文案**没有落点**） |
| codex | 适配器把 `turn/plan/updated`（整表覆盖）与单条 `plan` 条目都折成 `{ plan: [{ step, status }] }` 的调用入参（真名 `update_plan`）；协议窄声明**没有收 `explanation`** ⇒ `note` 恒 `null` | `subject` ← `step`；`status` **按别名归一**后落契约四态（`completed` / `in_progress`·`inProgress` / `pending`·`todo`，另认 `completed: true`），认不出的落 `unknown`；单条 `plan` 条目只有文本、没有状态格 ⇒ 该步记 `unknown`；条目**没有 id** ⇒ `steps[].id` 只能是 `null`（**不自己发号**） |
| dsh | `todo_write` 的 `{ todos: [{ content, status }] }`（**整表**） | `subject` ← `content` |

状态四态：`pending` / `inProgress` / `completed` / `unknown`。厂商取值归一到这里（认 `in_progress` / `inProgress` / `pending` / `todo` / `completed`，外加 `completed: true` 写法），其余（含 claude 的 `deleted`）落 `unknown`——当 `completed` 是撒谎，当 `pending` 是它明明已被删除。`unknown` 是**独立的一档**（既不是待办也不是完成），面板必须能显示它。

`owner` / `blockedBy` 这两格**今天没有取值来源**（不是没有读取点）：`tool-payload.ts` 的 `taskStepOf` 照读这两格（厂商给了就原样带上），但三家的清单入参都不带它们——`TodoWrite` / `todo_write` 只有 `content` / `status`，而唯一带工作项语义的 `Task*` 其 `payload` 按设计为 `null` ⇒ 实际恒 `null`；另两家同样恒 `null`。`blockedBy` 认不出时记 `null`（「这家没有这个概念」），**不是空表**（那是「有概念、当前没有依赖」）。**契约上不可空的字符串格共四个**——`subject` / `header` / `prompt` / 选项 `label`——**缺格时一律落 `''`**（其中 `subject` / `header` 同时也是「厂商给了空串也原样保留」的格）；**其余缺格一律 `null`**。

### 5.4 面板①：进度清单

- 数据来源：`task` 族 `tool-call` 块上的 `payload`（`kind: 'plan'` 的 `steps[]`），**每轮**取该轮最后一条，并在卡片上标出「本轮另有 N 次更新」。⚠️ **「每轮」＝该消息的 `roundTrip`**（会话尺度，见 §1.2 / §2.6）——不是 `vendorTurn`、不是 `step`、也不是「文件里第几张清单」；跨家比较卡片张数前先确认三家的 `roundTrip` 是各自合成的（claude 只数主循环、codex 只数模型答复条目、dsh 取 `data.step`）。
- 渲染：两列小表（步骤 / 状态四态 Tag），计数只体现在 `N/M 完成` 那一句里——**分母含 `unknown`**（漏了它分母必然偏小）。`unknown` 是**独立的一档**，不得并入任何三态组。
- `owner` / `blockedBy` 有则显示；`steps[].id` 拿不到就是 `null`，**不要按序号编一个**——编出来的 id 会让依赖看起来解析成功了。
- 缺失处理：本次运行没有任何带 `payload` 的 `task` 族调用（例如 claude 只用了 `Task*` 注册表）⇒ **整张卡不出现**（那些调用仍以通用工具行留痕）。⚠️ **当前不产出任何「本次没有清单」的说明行**（唯一的两句空态文案「清单为空」/「清单为空（这家报了空表）」都要求 `payload` 存在）；要这句说明得先在时间轴上补空态。

### 5.5 面板②：派发视图

每个子任务一行。每格的取值路径：

| 字段 | claude-code | codex | dsh |
|---|---|---|---|
| `subagentId` | `task_started.task_id`（**只有过了形状判据的才产行**） | 子线程 id（`collabAgentToolCall.receiverThreadIds` 的元素 / `thread/list` 的线程 id） | 身份三级兜底：`subagentId` → `agentId` → `childSessionId`（与随后子会话事件的 `params.sessionId` 同值） |
| `name` | `task_started.description` | 线程昵称（`thread/started` 的 `Thread.agentNickname`；收尾以 **`thread/list`** 为准）。**不是 `prompt` 首行** | catalog `label` |
| `kind` | `task_started.subagent_type` | 协作条目的 `tool`（真机 `spawnAgent` / `wait` / `closeAgent`；⚠️ 台账后到覆盖 ⇒ 可能是最后一条协作动作） | catalog `mode`（收场时 `provider` 优先） |
| `status` | `task_notification.status`（还没收到通知时记 `running`；终态是原生字段 ⇒ `statusMissing` 恒 `null`） | 运行期 `agentsStates[<子线程 id>].status` 五档直映；收尾由最后一条 `turn.status` 推三档（**无 turn 时才看 `thread.status`**），推不出来 ⇒ `unknown` + `not-observed` | **按 `stopReason` 分档**（`status` 只在 `completed` 支参与），未覆盖的档记 `unknown` + `unverified` |
| `outcome` | `task_notification.summary` | 运行期 `agentsStates[<子线程 id>].message`；收尾：最后一条 `agentMessage` 的正文 | `subagent.finished` 载荷里 `type='text'` 的块（取消时可能没有 ⇒ `null`） |
| `usage` | **读 CLI 转录**：该子智能体的 `agent-<agentId>.jsonl` 按 `message.id` 去重后求和；读不到 ⇒ `null`（`task_notification.usage` 是异形，不采用） | `thread/tokenUsage/updated` 的按线程累计（三项缺任一 ⇒ `null`） | 子会话 `assistant/message` 的用量按 `params.sessionId` 分组求和（已收场却无用量 ⇒ `null`） |
| `parentSubagentId` | **恒 `null`**（`task_started` 只有 `spawn_depth`、没有父 id；`parent_agent_id` 没有读取点）⇒ 层级当前没有落点 | 线程对象的 `parentThreadId`（`thread_spawn.depth` 读得到但契约没有这一格）；**父就是主线程时记 `null`**——照抄主线程 id 会让消费方挂到一个不存在的父节点上（表现：进子任务后面包屑没有「主会话」那一段） | `null`（真机通知不带父 id） |
| `parentCallId` | `tool_use_id`（与子消息上的 `parent_tool_use_id`、派发工具调用块的 `id` **三者同值**） | 协作条目的**条目 id**（与派发调用块同值，两侧同值即可配对；⚠️ 后到覆盖的风险见 §4.2 步骤 5） | `null`（载荷里没有可对齐的调用 id ⇒ 不猜） |
| 轨迹 | 子智能体消息直接出现在主流里（带 `parent_tool_use_id`，文本与思考块由 `forwardSubagentText` 转发） | 运行期由通知驱动（上游推不推子线程条目由它定），**收尾一律 `thread/list` + `thread/read` 补齐**——运行期就能看到已到的部分 | 子会话事件在同一条通知流里（`params.sessionId` = 子会话 id） |

渲染要求：

- **身份**用 `subagentId`；名称缺失时显示身份前 8 位，不要显示 `null`。
- **状态**：契约五态 `running` / `completed` / `failed` / `stopped` / `unknown`；界面类型另有 `canceled` / `unsettled` 两档（`LogNodeStatus` 共七档）。⚠️ **「未收场」的判据是三家共用的展示规则**（不改契约五态）：**行已到终态（整行不再跑了），而某条子任务仍是 `running` / `unknown` 且本轮没有任何终态帧** ⇒ 显示「未收场」（= 「等不到了」），**不要**继续显示「运行中」（= 「还在等」）。今天它是用 `status: 'unknown'` + `statusMissing: 'not-observed'` **表达**的——`unsettled` 这一档本身**还没有产出点**。厂商原始状态先归一到五态再进面板。`statusMissing` **非 `null`** 时显示「状态未采集」，同时显示最后一次状态快照（`null` = 状态已采集）。
- **轨迹**：codex 的子智能体轨迹**运行期由通知驱动**（上游推不推子线程条目由它定），**收尾一律 `thread/list` + `thread/read` 补齐** ⇒ 已到的部分运行期就能看到，不必等整段跑完。
- **层级**：父链可得时缩进显示；父链不可得时全部平铺，不要用"派发顺序"推测层级。

### 5.6 两轴分类（统计与比较）

> ⚠️ **本节是目标口径，当前没有落点**：`ToolAction` / `ToolTarget` 与下面这张映射表在代码里**一处都没有**（`packages/client/**` 与 `apps/**` 全无 action × target 模块）；今天的「用过的工具」统计按**原始工具名**计数（`build-environment.ts` 的 `observedGroup`），跨家不可比。落地前不要把这一节当既成事实引用。

`family`（§5.1）服务**渲染**，`action` × `target` 服务**统计与比较**：后者覆盖**全部**工具，含没有族的那些。两者**不合并**——`run-shell` 与 `read-file` 在渲染上毫无共同点，在"用了什么工具"的统计上只是两个 `(action, target)` 组合。

```ts
type ToolAction = 'read' | 'write' | 'edit' | 'search' | 'list'
                | 'execute' | 'send' | 'spawn' | 'stop' | 'wait'
                | 'query' | 'resume' | 'deliver';
type ToolTarget = 'file' | 'image' | 'notebook' | 'shell' | 'process'
                | 'agent' | 'job' | 'goal' | 'task' | 'web'
                | 'worktree' | 'skill' | 'user';
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
| `commandExecution`(codex，**条目名**） | `execute` | `shell` |
| `fileChange`(codex，**条目名**） | `edit` | `file` |
| `write_stdin`(codex) | `send` | `process` |
| `WebSearch`(cc) · `web_search`(dsh / codex) | `search` | `web`（**只有「搜索」这一半没有数据**：claude 按模型名分档禁、codex 由 `config.tools.web_search:false` 关掉、dsh **未落地** ⇒ 计数不保证 0，见 §7.4） |
| `WebFetch`(cc) · `web_fetch`(dsh) | `read` | `web` |
| `ExitPlanMode`(cc) · `exit_plan_mode`(dsh) | `send` | `task` |
| `todo_write`(dsh) | `edit` | `task` |
| `update_plan`(codex) | `edit` | `task` |
| `TaskCreate` · `TaskUpdate` · `TaskList` · `TaskGet`(cc) | `edit` / `query` | `job`（**不是 `task`**） |
| `Skill`(cc) · `skill`(dsh) | `execute` | `skill` |
| `Task` / `Agent`(cc) · `subagent` · `subagent_fork`(dsh) · `spawn_agent`(codex) | `spawn` | `agent` |
| `SendMessage`(cc) · `send_message`(dsh) · `send_input`(codex) | `send` | `agent` |
| `TaskStop`(cc) · `interrupt_agent`(dsh) · `close_agent`(codex) | `stop` | `agent` |
| `job_kill`(dsh) | `stop` | `job` |
| `request_user_input`(codex) · `AskUserQuestion`(cc) · `ask_user_question`(dsh) | `query` | `user` |
| `ListAgents`(cc) · `list_agents`(dsh) | `query` | `agent` |
| `job_list`(dsh) | `query` | `job` |
| `job_output`(dsh)（兼两种动作，统计取前者） | `query` | `job` |
| `wait_agent` / `wait`(codex) | `wait` | `agent` |
| `resume_agent`(codex) | `resume` | `agent` |
| `create_goal` · `get_goal` · `update_goal`(dsh / codex) | `write` / `read` / `edit` | `goal` |
| `EnterWorktree` · `ExitWorktree`(cc) | `send` | `worktree` |
| `Workflow`(cc) · `workflow`(dsh) | `execute` | `agent` |
| `ReportFindings`(cc) | `deliver` | `user` |
| `Cron*` · `ScheduleWakeup` · `DesignSync`(cc) | 已被适配器禁用 | — |

- **落点**：两轴映射表是**纯函数模块**，放 `packages/client/`（`client` 或 `ui`），**不进 `agents` 包**——适配器只认自己那一家的工具名，不该知道别家的名字。（⚠️ 未落地，见本节抬头。）
- ⚠️ **两个命名空间并存，别只认一个**：族表登记的是**模型侧工具表**的名字（`multi_agent_v1` 命名空间下的 snake_case：`spawn_agent` / `wait_agent` / `close_agent` / `send_input` / `resume_agent`；两份 2026-09-30 的入站 `tools[]` 实测都是这样），而 **app-server 协作条目字段** `tool` 在真机上是 camelCase（`spawnAgent` / `wait` / `closeAgent`）⇒ 族表按前者登记、代码按后者归类，真机那一格 `family: null`。⚠️ 那两份实测**早于 app-server 迁移**，但**迁移当天的真机产物已有旁证**（同 §5.2：模型仍以 `namespace: "multi_agent_v1"` + `name: "spawn_agent"` 调用）⇒ 命名空间与 snake_case 拼写仍成立；**迁移后的入站 `tools[]` 抓包仍未重做**（要重抓一次）——**不要**写成「snake_case 已退役」。
- **codex 的统计列以 item 类型为键**（`commandExecution` → `execute/shell`、`fileChange` → `edit/file`）：通知里的条目类型与入站工具表之间**没有可对齐的键**（`commandExecution` 条目里根本没有工具名字段）⇒ `'shell'` / `'apply_patch'` 这类**规范自定名必须标注成合成名**，不得当作厂商真名参与跨家比较。
- **表里有没有这一行 ≠ 这次跑有没有这个工具**：`ExitPlanMode` / `AskUserQuestion` 在 claude 侧是 mode / 回调门控的，`update_plan` / `web_search` 在 codex 侧由配置决定。映射表保留全部条目以兼容工具表变化；统计只数**实际出现的调用**。
- **分工**：渲染读 `family`（10 族），统计读两轴（全部工具），面板读子任务行（§2.8）——三者的取数面互不替代。

---

## 6. 流式与合并规则

### 6.1 两种块形态

- `'delta'`：该块的增量片段，消费方**必须按块累积**。**今天只有 codex 真正在产它**（`item/agentMessage/delta` 与两条推理增量通道都落 `chunk:'delta'`，能力位也声明 `'yes'`）；claude-code 的解析路径已就位但 `includePartialMessages` **没开**（且即便开启也只覆盖主会话）；dsh 的 `data.stream[]` 增量通道没有取数实现，能力位记 `not-projected-by-vendor` ⇒ 增量是可选的实时增强，**不是任何一家的必备通道**。
- `'snapshot'`：该块的当前完整内容，可**直接覆盖**同键块。**三家都产出它**：claude-code 的完整 `assistant` / `user` 消息、codex 的 `item/completed` 条目、dsh 的 `assistant/message.content[]`（整块）；只有进程被中断的块例外。
- 同一个块可以既有 delta 又有 snapshot：delta 用于实时打字，snapshot 是落盘与抽屉的真相。**消费方只实现 snapshot 也能正确渲染**（把 delta 当作可选的实时增强，因为快照一定在块结束时到达）。

### 6.2 覆盖合并算法

合并键 = **载体** + **块标识**：`(subagentId ?? 'main', roundTrip, 载体, 块标识)`。⚠️ **信封上的 `mergeKey` 只含载体那四段**：`<subagentId ?? 'main'>|<roundTrip>|<role>|<parentCallId ?? '-'>`；**块标识不进 `mergeKey`**，它在适配器内部按 `i:<index>` / `c:<callId>` 分配到槽位（合并器的 `applyBlock`），消费方拿到的是「该逻辑消息到现在的完整块列表」。

| 分量 | 取值 |
|---|---|
| `载体` | 该块所属消息的 `role` 与 `parentCallId`。同一轮里 assistant 消息与工具结果消息各自从 0 起算块序号，只带 `blockIndex` 会把工具结果盖到正文块上 |
| `块标识` | 文本块与思考块用 `blockIndex`（该逻辑消息内的序号，按首次到达顺序分配，一经分配不再变化）；工具调用块与工具结果块在 **claude / dsh** 走 `callId`（同轮多次调用因此互不覆盖）。⚠️ **codex 是把所有块（含工具调用与工具结果）都改写成块序号标识的**（交块前统一重写 `identity`）——它靠「条目 id + 块种」各占一个新号来做到互不覆盖，合并结果与另两家等价 |

1. 收到 `delta`：把片段追加到该键的累积缓冲区，渲染时显示缓冲区内容。
2. 收到 `snapshot`：用其内容**覆盖**该键的缓冲区与最终内容。
3. 收到同一键的多个 `snapshot`（同一条逻辑消息可能被分多次投递、每次只带一个块）：**后者覆盖前者**，不追加、不拼接。**块序号必须按首次到达分配**——适配器侧要按厂商输出里的序号换算，**不能每次投递都从 0 重开**，否则多个块会挤进同一个槽位、互相覆盖。
4. 新块只能追加到末尾：块序号与 `callId` 一经确定不再变化。**消息信封的 `mergeKey` 就是这条规则的可执行形式**，消费方按它覆盖累积，再在键内按数组下标（= 块序号）或 `callId` 合并到块一级。
5. 合并键不含 `messageId`：同一个块的 delta 与 snapshot 是两条消息，配对只靠上面的键。

### 6.3 顺序与容错

- 事件 `seq` 单调递增；消费方按 `seq` 去重，断线后按 `Last-Event-ID` 语义续订。
- 允许不同块之间乱序到达：合并只依赖合并键，不依赖块与块之间的到达顺序。
- 同一个键上，`delta` 必须先于 `snapshot`（同一家的同一条流内有序）。`snapshot` 之后到达的同键 `delta` **丢弃**、不追加——快照按定义已含它之前的内容，追加会把这一块写重。
- 缺失 `snapshot` 的块（进程中断）保持最后一次 delta 累积值，并由消息上的 `assembly` 标成 `'open'`。**不要**用 `truncated` 表达这件事：那是 `tool-result` 块自己的字段（结果文本有没有被截断），文本块与消息都没有这一格。

---

## 7. 缺失影响矩阵

"谁缺什么、影响什么"是本文最需要被消费方读到的一节。⚠️ **只有能对应到五格能力位（`thinkingText` / `toolInput` / `toolResult` / `subagent` / `streamingDelta`）的条目才写「态＋原因」**（`yes` 配 `source`；`no` 配 `not-supported`、`not-projected-by-vendor` 配 `not-exposed`、`off-by-adapter` 配 `not-observed`（**也允许 `unverified`**）、`unverified` 配 `unverified`——逐项以套件那张表为准）——本节多数条目（`vendorTurn` / `step`、嵌套父链、`Bash` 退出码、轮次口径、`off` 失效、时延粒度、`parentCallId` 后到覆盖…）**没有对应的能力格**，它们只写「影响 + 消费方义务」，**不要硬塞或自造一格**（与「思考 token 也没有能力格」同一处置）。**不得**用 0、空串或省略字段代替缺失。⚠️ **schema 拦三条**（`'yes'` ⇒ 必须有 `source`；非 `'yes'` ⇒ 必须有 `reason`；`thinkingText` 非 `'yes'` ⇒ `thinkingTextKind` 必须为 `'none'`，见 §2.7）——**「哪一态配哪一条原因」由三家的一致性套件拦**（`providers/conformance/kit.ts` 的 `REASON_BY_CAPABILITY`，三家各接入一次），不在 `superRefine` 里。

### 7.1 claude-code

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `vendorTurn`、`step` | 厂商无此字段 | 只有 dsh 能给出厂商轮号与步骤号；跨家比较这两个量没有基准 | 恒 `null`，不显示"0"或"1" |
| 嵌套父链 | **代码现状：恒 `null`**（`task_started` 只有 `spawn_depth`，SDK 类型面上的 `parent_agent_id` 在真机载荷里从未出现、没有读取点） | 父链一格都建不起来，「深度 ≥ 2 缩进」这条义务**当前不可执行**（无父 id、也无深度格） | 全部平铺，不要推测父节点；要用到层级时先补这一格的取数 |
| `Bash` 成功时的退出码 | 无**退出码**字段（`tool_use_result` 给的是分开的 stdout / stderr，但没有退出码这一格） | 退出码恒 `null`（真机实现里也没有从文本解析的那一步） | 显示"未采集"，不要显示"0 = 成功" |
| 子智能体的 token 级增量 | 不投送（只发主会话） | 子任务只有整块内容，无实时打字 | 子任务视图不做逐字动画 |
| **流式增量（声明与实现不一致）** | 能力位声明 `streamingDelta: 'yes'`，但适配器**没有开 `includePartialMessages`** | 主会话也拿不到逐字增量（`stream_event` 解析路径已就位，开选项即生效） | 不要按「这家有增量」写动效；按能力位与实际到达的块形态渲染 |
| **子智能体转录读不到** | **会话目录不存在（而事实核对名单非空）** / 某个 `agent-<id>.jsonl` 读不动 / 空文件 / 三项缺一 / 认得是 assistant 却没有 `message.id` | 子智能体那一份用量与轮次**两格一起 `null`**，合计退回主会话口径 | 按要求退化成一行显示；不得把读到的那些当总数（部分和会被读成合计），日志里那条点名 WARN 说明少了谁。⚠️ **名单为空那一档不走这里**：那说明本次确实没有子智能体 ⇒ 见下一行 |
| **采不到 `session_id`** | `system/init` 没给（或没到达） | 定位不到「这一行的会话目录」，**不猜目录**（猜错会把别的会话的转录算到这一行上） | **分两档**：名单里**有**形状像派发的 id ⇒ 事实缺失（两格 `null` + 点名）；名单里**空** ⇒ `{0,0,0}` / `0`，**不点名**（「采不到 `session_id`」不等于「一律 null」） |
| **幻影 `task_*` 与只见到收场帧的条目** | CLI 给非 Agent 任务也发 `task_started`（盘上永远没有它的转录）；收场帧不承载形状证据 | 前者已不产行、也不进事实核对名单；后者**无法判定**是不是子智能体 | 前者不该出现任何提示；后者照产行、两格照算，并落一条「可能少算它（无法判定）」的 WARN——**不要**因此把分量变 `null`，也不要叫它子智能体 |
| **工具结果的本地截断** | 结果正文超过 20 000 字符时由我们自己截断（写 `truncated` + 原因），而厂商不给截断标记（那一档记 `unknown`） | **上游**已截断而我们没截的那一档（正文 ≤ 20 000 字符）与「确认完整」在界面上分不开——二次截断看不出来；我们**自己**截过的那一档是能说清的 | **我们截过**的按 `truncated` 渲染（原因由适配器写入，界面写「输出已被截断（超过 20000 字符）」）；**没采到标记**的按 `unknown` 渲染（「输出可能不完整」），**不要**写「完整」，也**不要**把「我们截了」记成 `unknown`（见 §10.1.1 口径 2） |
| `thinking_tokens` 缺失或为 0 | 后端不返回这一格时字段缺失；返回 0 时无法区分"这次没有推理"与"这条后端不上报" | 不能判断"这家不思考" | 缺失记 `null`；读到 0 照实记 0，但不得据此断言"这家不思考" |
| **`off` 的关闭依赖宿主环境** | 前置条件（`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 不在场、hipaa 策略为假）被破坏时，`thinking` 与 env 覆盖层**双双静默失效**（不报错、思考照旧） | 该行的 `off` 读数作废，而结果里看不出来 | 只见 `off` 档那条点名 WARN 时按「本次 `off` 未生效」呈现，**不要**按「它没思考」呈现 |
| SDK 路径下的 shell | **环境边界，不是厂商能力**：claude.exe 自身的工具沙箱拒绝**工具级建目录**那一类调用（`EPERM`：它在临时目录下建 `<TEMP>\claude\<slug>`），同一份二进制由 CLI 直跑时不受影响 | **被判为「环境不可用」的是这一类报错调用**（结果正文里带那条 `EPERM`）——真机 `tool_use_result` 里正常的 shell 结果仍拿得到分开的 stdout / stderr（只是没有退出码那一格，见 §7.1 上一行） | 结果正文命中那条 `EPERM` 时标「环境不可用」，不要标「没有执行」，也不要写成「这家不能跑 shell」。⚠️ **该文案当前没有落点**（界面不区分 `EPERM` 与普通失败，全仓无这一档） |

### 7.2 codex

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| 文件**读取**类四族 | 当前模型预设的工具表里没有这几类工具（随预设变化，不是"这家没有"）。⚠️ **文件改动不走这一档**：`fileChange` 条目落 `apply_patch`（`edit-file` 族） | 读 / 搜 / 列的统计对 codex 失真 | `family` 为 `null` 时走通用渲染；跨家统计标注"本次运行不适用"，不要写成"这家不支持" |
| `step`、`vendorTurn` | 厂商无此字段（`turn_id` 是字符串标识，不是序号） | 这家给不出厂商轮号与步骤号，跨家比较这两个量没有基准 | 恒 `null`，不要填 0 或 1 |
| **轮次口径已收窄** | 「只数 `reasoning` + `agentMessage`」会**系统性偏高**（一次调用常同时产出两个条目，而 `reasoning` 在部分路由上根本不投送 ⇒ 两把尺子分叉） | 现行口径只数**模型答复条目**（`agentMessage`），运行期与收尾回读同一把尺子（`countRoundTrips`） | 该数是「模型答复条目数」，**比既有近似口径更低**；一个答复条目都没有的运行 ⇒ 轮次 `null`（显示「未采集」），**不得**回落成一个被抬高的数 |
| 协议条目里的 `role` | 协议没有 role 概念 | `role` 是派生值 | 不要当厂商原生字段用 |
| 事件流的时间 | 只有厂商时刻（`Turn.startedAt` / `completedAt`，含工具执行的**墙钟**） | tok/s 的分母含工具执行时间 | 展示 tok/s 时标注"墙钟"，不与厂商计时混排 |
| `thinking` 的 `signature` | 协议条目里没有该字段 | 无法校验思考块完整性 | 恒 `null` |
| 流式增量 | **有**：`item/agentMessage/delta` 与两条推理增量通道都落 `chunk:'delta'` 块；⚠️ `item/commandExecution/outputDelta` 与 `item/plan/delta` 解析了但**没有出口** | 正文与思考有逐字增量；命令输出与计划没有 | 思考末块可能迟于正文到达（完成通知才封口），按块形态渲染，不要按「整段一次到」写动效 |
| `ask-user` | 结构性不可用（协议形态是 server→client 请求，本仓 `approvalPolicy: 'never'` 且不应答） | 交互族恒空（**不合成任何问答块**） | 不渲染问答卡片，也不要说「用户拒绝了」——它根本没被问到（⚠️ 不是记 `outcome:'unavailable'`：没有块就没有 outcome 可挂） |
| 多智能体 | 随路由翻转（真机结论，代码侧无判据） | 同一家的能力在不同路由下不同 | 能力声明必须带路由前提；缺值时不要回落成"这家没有"。⚠️ **`messageCapability.notes` 里当前没有这条路由前提**，是一条待补的缺口 |
| **`off` 的要求下发了、但关不掉** | 网关行为，不是我们的参数问题：`effort: 'none'`（`turn/start`）与 `model_reasoning_summary: 'none'`（`thread/start` 的 config）**都**已到 CLI（真机探针的 `off-both` case 直证），网关仍照样推理 | `off` 行仍有思考产出 ⇒ 这家当前**没有**「零推理」这一档 | `EvalRow.effort` 记的仍是「我们**要求**的档位」；文案与统计一律按「已要求关闭」说，**不要**按「它没思考」说，也不要用极简 prompt 上的那次「0 条」外推 |
| 计划状态 | `turn/plan/updated` 的 `steps[].status` **按别名归一到契约四态**（`completed` / `in_progress`·`inProgress` / `pending`·`todo`，另认 `completed: true`；认不出的记 `unknown`）；单条 `plan` 条目没有状态格 ⇒ 该步记 `unknown` | 面板按**四态** Tag 渲染，不显示厂商原文；认不出的档不猜 | 未覆盖的档显示 `unknown`，不要猜成 `pending` |
| **`parentCallId` 只有一个来源，且会被后到的协作条目覆盖** | 协作条目的**条目 id**（与派发调用块同值）；而真机 `wait` 也带 `receiverThreadIds` ⇒ 台账「后到覆盖」 | 子任务行的 `kind` / `parentCallId` 可能落在**最后一条**协作动作（收场那一步）上 | 按 `subagentId` 分桶；派发点找不到那次调用时不要让整行不可达（见 §4.2 步骤 5 的风险条）。⚠️ `packages/server/contracts` 里 `SubagentRecord.parentCallId` 的注释仍写「三家都给得出」（含 dsh）——**与实现相反**（dsh 恒 `null`），以本节与 §3.3 为准 |
| **子线程树不是全量** | **枚举（`thread/list`）失败**；⚠️ 某条子线程的 `thread/read` 失败**不算**（只少一份内容） | 分量两格记 `null`、合计两格**不上报**（收尾那条 `usage` 不发）⇒ 行快照保留跑动期的主线程读数，即「`tokens` / 缓存命中 / 轮次三格退回主线程口径」 | 不许拿部分和冒充总数；那条点名整行的 WARN 逐字说明「**子线程树不是全量（枚举失败）**：分量都给不出（记 `null`，不编造、不填 0），合计退回主线程口径」 |
| **`{0,0,0}` 的前提** | 判据**只有一条通道**：`thread/list{ancestorThreadId}` 返回的后代为 0（运行期的 `receiverThreadIds` 只是身份来源，**不参与**这条判定）；枚举失败时走的是另一档（分量记 `null`、合计不上报，见 §4.2 步骤 6） | 「确实没有子智能体」只在「收尾枚举到 0 条后代」这条判据下成立——它说的是「**本次没观察到**」，不是对事实的证明 | 文案写「本次未观察到子智能体」，不要写成「这一行确实没有」（⚠️ 该文案**当前没有落点**，界面不产出这句） |
| **轮次是近似量** | 一把尺子是「模型答复条目数」：一条 `Turn` 内含多次往返，子线程的条目也可能还没推给本条连接（收尾补齐之前） | `turns` 与 `subagentTurns` 是近似值，且必须同尺 | 不要拿它当精确值；跨家比较前先确认口径 |
| **工具结果的截断标记** | 厂商不给截断标记 | 只有我们自己截断时才是 `truncated` | 其余按 `unknown` 渲染，不写"完整" |
| **计划面板来自原生事件** | `turn/plan/updated`（整表覆盖）**已被消费**并驱动计划卡；`item/plan/delta` 与 `item/commandExecution/outputDelta` 解析了但**没有出口**（静默丢弃） | 计划卡有原生保真度；命令输出与计划的**增量**拿不到 | 命令输出按整块渲染；未覆盖的状态档按 `unknown` 显示（见 §4.2 步骤 7 / §5.3） |

### 7.3 dsh

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `reasoningTokens` | 通道不投送（`llm-pi-ai` 的 `mapUsage()` 把推理并入 `outputTokens`；`readUsageTokens` 仍会读这一格，只是取不到） | 思考**计量**跨家只有两家有值；思考**内容**不受影响 | 该格恒 `null`；⚠️ **契约没有「思考 token」能力格**（只有五格能力位）⇒ 这条事实登记在 `messageCapability.notes` 里，跨家求和不含它 |
| 子任务级用量不在子任务通知里 | `subagent.started` / `subagent.finished` 不带用量 | 子任务级用量要按子会话分组求和才拿得到 | 用子会话的 `assistant/message.usage` 按 `sessionId` 分组求和，`source` 记 `'wire'`（子会话事件与主会话同一条通知流） |
| **子会话已收场却一条用量都没报** | 事实缺失（不是「没花」） | 子智能体那一份用量与轮次**两格一起 `null`**；而合计是逐条累加的流水，**退不回**主会话口径 | 按要求退化成一行；`{0,0,0}` / `0` 与 `null` 必须分开说（前者是「确实没有子智能体」） |
| **流式增量（厂商有数据、不投送到通知流）** | 能力位记 `streamingDelta: 'not-projected-by-vendor'`（`source` 为 `null`、缺失原因 `not-exposed`）；`data.stream[]` 那条通道没有取数实现 | 消息块一律是整块快照，没有逐字打字 | 按 `chunk: 'snapshot'` 渲染，不要等增量 |
| **累加没有去重键** | 这一家不写事件去重表：重复投递的同一条 `assistant/message` 会重复累加 | 用量与轮次可能被重复计数 | 去重只发生在 `usage` 事件的发射门（与上次逐字段相同就不发），它不改已累加的值——消费方不要指望事件里带着去重后的更正 |
| `parentCallId` / `parentSubagentId` | 载荷里没有可对齐的调用 id，也没有父 id | 无法把子任务挂到「哪次调用派生的」，也无法表达两层以上的层级 | 两个格恒 `null`；派发点退化为「派发工具入参里的任务名 == 子任务名」逐字相同才认 |
| 取消时的结果文本 | 可能没有 text 块 | `outcome` 为空 | 保持 `null`，不要用状态文本顶替 |
| `stopReason` 的部分档位 | 厂商值域有五档（`completed` / `aborted` / `error` / `max-tokens` / `refusal`）：分档**只看 `stopReason`**——`completed` ⇒ 再看 `status`，逐字 `'ok'` 记 `completed`、**其余（含缺失）记 `failed`**（`statusMissing` 仍为 `null`，即「未观测组合」在这一支被判成 `failed` 而不是 `unknown`）；`max-tokens` / `error` ⇒ `failed`；`aborted` ⇒ `stopped`（这三档不看 `status`）；只有**其余取值**（`refusal` 与未观测档）没有可核对的依据 | 状态映射表可能漏档 | 未覆盖档记 `unknown` + 缺失原因 `unverified`（`statusMissing` 非空），不得猜 |
| 收场事件 | 强杀时没有 finished | 面板会缺一行终态 | 必须支持"未收场"显示 |
| 工具调用级归属 | 只有会话 id 层级 | 归属粒度比另两家粗 | 跨家比较归属时标注粒度差异 |

### 7.4 三家共同

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `web-search` 族数据 | **只有「搜索」那一半没有数据，而且成因三家不同**：claude 的 `WebSearch` **按模型名分档**（非 Claude 模型才禁）、codex 硬编码 `config.tools.web_search: false`、dsh 的 `tool-web` 关闭**尚未落地**（适配器的 patch 只写路由与 `tool-ask-user` 插入）。⚠️ **该族不保证为空**：`WebFetch`（claude）与 `web_fetch`（dsh）**同属这一族且未被禁**（只禁搜索、不禁网络） | 搜索方向没有可用数据；取数方向照常 | **搜索**计数为 0 时显示「未启用联网」（⚠️ 该文案**当前没有落点**），**不得**显示"三家都没搜"（那是把配置结论读成能力结论），也**不得**断言 dsh 侧一定没有搜索 |
| 思考块的 `signature` | 有意不进呈现（claude-code 有值，codex 与 dsh 恒 `null`） | 无用户可见影响 | 界面**不消费**它（没有任何视图渲染这一格；只在落盘的记录原文 / `raw` 里看得到），正文与导出都不显示 |
| 子智能体内的提问 | 三家一致不支持 | 子任务不能向用户提问 | 子任务视图不渲染提问入口 |

---

## 8. 配置面

### 8.1 必须写死的配置

| 家 | 配置 | 值 | 原因 |
|---|---|---|---|
| claude-code | `forwardSubagentText` | `true` | SDK 默认只投送子智能体的 `tool_use` / `tool_result` 块；不开则子任务视图只剩工具流水，看不到子智能体说的话与想的事 |
| claude-code | `disallowedTools` | **现状：六项无条件**（`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` / `PushNotification` / `DesignSync`）**＋非 Claude 模型追加** `WebSearch`（判据 `route.modelId` 的子串 `/claude/i`）。**目标形态：无条件七项**——⚠️ **尚未落地**（§9 第 19 条；代码与用例都仍钉着分档行为） | 定时任务 / 推送这类工具会绕过评测面；`WebSearch` 是**厂商服务端执行**的工具，只有 claude / gpt 系模型实现它 ⇒ 放行会让「有没有联网」变成**模型差异**，而模型正是本项目的自变量。**只禁工具、不禁网络**（`Bash` / `WebFetch` 照旧可用；`web_fetch` 不在本条里） |
| claude-code | `CLAUDE_CODE_ENABLE_TODO_TOOLS` | `1` | 规划工具按模型门控，不显式开启就没有进度数据 |
| claude-code | `CLAUDE_CODE_ENABLE_TASKS` | `0`（可选） | 把 `Task*` 四件套换成 `TodoWrite`；后者的入参是**整表**、能进进度面板，而四件套是逐条 patch 的注册表、没有归一载荷。⚠️ **本期未落地**：适配器不设这个键（§9 第 19 条把它列进了待办清单） |
| claude-code | `canUseTool` 回调 | 需要交互时注册 | 不注册则 `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` 都不出现在工具表里。⚠️ **本期未注册（未落地）**：适配器没有这个回调点 ⇒ 三项今天都不在工具表里，§8.2 那条「期望收到提问」的禁令也随之空转 |
| claude-code | `CLAUDE_CODE_EXTRA_BODY` | `off` 档 spawn CLI 时注入 `{"thinking":{"type":"disabled"}}`（值**由 `JSON.stringify` 生成**，且**只有这一个键**） | CLI 的**模型能力门**对它不认识的模型名判定「不许关思考」⇒ **故意不写** `thinking` 字段（网关本身是尊重这个字段的）⇒ 不注入 env 覆盖层就关不掉。注入由 `claudeExtraEnvFor(input.effort)` 产出：**只有 `off` 档给这一条，其余档位与未选给空对象**（不能给值为 `undefined` 的键——那会在非 off 档删掉宿主继承来的同名变量）；覆盖层经同一条链路**对子智能体同样生效** |
| claude-code | `settingSources` | `['user', 'project', 'local']` | 读得到被测仓库的 `CLAUDE.md` 与项目配置；`[]` 会把它们一起挡掉 |
| claude-code | `settings.env` | 与本次路由同值的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 打开 `project` 档后，仓库自带的 `.claude/settings.json` 的 `env` 会盖掉本次路由；这一档优先级更高，把它钉回去。与 `settingSources` **成对**给 |
| claude-code | `enableWorkflows` | 显式 `true`（⚠️ **本期未落地**：`settings` 档今天只有 `env` 三键） | 不设时取「按 plan 默认」这一档**不可控的输入**（`false` 才会把 `Workflow` 从工具表里摘掉）⇒ 显式钉住行为。**它只管"能不能"，不管"会不会"**：`Workflow` 的工具描述把触发条件写死在提示词侧（用户须显式 opt-in，`ultracode` 关键字或原话要求编排）——**普通提示词下模型不会调它**。要观察编排能力，三家必须在同一段提示词里显式 opt-in；不想引入编排，则提示词里避免 `ultracode` 与「用 workflow / 并行开 agent」这类原话 |
| claude-code | `workflowSizeGuideline` | `'medium'`（⚠️ **本期未落地**） | 总数侧只有 advisory 档位（`small`/`medium`/`large` = 5/10/50），**表达不了 8**；`'8'` 会被忽略并回落 `medium` |
| claude-code | `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | `8`（注入 `buildSubprocessEnv` 的 `injected`，与 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 同一通道；⚠️ **本期未落地**：这个键名只出现在探针脚本里） | 厂商侧**唯一的硬闸门，且它管的是并发**。注入后在 CLI 的 debug 日志上出现 `workflow: concurrent agent gate = 8`（`--debug` / `--debug-file` 才写；plain `-p` 的 stdout / stderr 里永远没有） |
| claude-code | `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` | `8`（注入 `injected`；⚠️ **本期未落地**，且 `subagent-start` 事件本身也还没实现） | 与 `workflowSizeGuideline` 合成的 `agentCap` 一起用于**厂商规模告警**。⚠️ **这条告警不进任何可见流**（stdout / stderr / debug 日志 / SDK 消息流全都没有）⇒ 规模告警**只能由我们产出**：适配器按 `subagent-start` 对 `task_type === 'local_workflow'` 计数，超 8 落一条 WARN。**计数是观察，不是拦截** |
| codex | 驱动方式 | **`codex app-server`**（JSON-RPC / stdio）：自己解析 `@openai/codex` 平台包里的可执行文件 → spawn → `initialize` → `thread/start{model, cwd, sandbox, approvalPolicy, config}` → `turn/start{input, effort?, outputSchema?}`；取数面 `thread/list{ancestorThreadId}` + `thread/read` **复用同一个客户端** | 不经裸 CLI 手拼 argv，也不经 `@openai/codex-sdk`（那个包已不是本仓依赖）；**模型是 `thread/start` 的顶层 `model`**（不在 `config` 里），提示词走 `turn/start` 的 `input`（元素形如 `{ type: 'text', text, text_elements: [] }`），其余开关（路由 / `env_key` / `tools.*` / `features.*`）走线程级 `config`；子线程树由协议给 |
| codex | `wire_api` | `responses` | 唯一合法值；写别的失败在**建线程**这一步（`thread/start` 返回 `-32600`） |
| codex | `CODEX_HOME` | 注入本行配置目录（**`input.configHome`，阶段相关**：执行/候选段是 `.agenthome`、评分段是 `.judgehome`） | ⚠️ **口径更正**：现在没有「SDK 自带的 exe」——可执行文件由 `@openai/codex` 平台包解析；旧约束「可执行文件在工作区内时 `$CODEX_HOME` 也必须落在工作区内」**代码里没有任何判据**（探针结论相反：判据在 exe 侧、不在 `CODEX_HOME` 侧），不要再当既成事实 |
| codex | 多智能体 | `features.multi_agent = true`；模型预设的 `model_messages.multi_agent` 必须有值 | 写在 `tools.` 前缀下会被 CLI 忽略；模型预设没有这一格时 `spawnAgent` 被拒为 `unsupported call`，子任务面为空。⚠️ **这一格本仓无法自行满足**：`model_providers.<id>.models[]` / `model_messages` / 顶层 `multi_agent*` / `agent_default_subagent_model` 逐键被 CLI 拒，二进制里也没有自定义 preset 入口 ⇒ 唯一达成路径是**网关侧**提供一个 codex 认识且带 profile 的模型名；能力声明必须把路由与模型名写成前提（⚠️ **`providers/codex` 的 `messageCapability.notes` 里当前没有这一条**，是一条待补的缺口） |
| codex | `tools.update_plan.enabled` | `true` | 默认关闭，不开启则工具表里没有 `update_plan`，没有进度数据 |
| codex | CLI config `model_reasoning_summary` | **只在 `off` 档**给 `'none'`（`buildCodexConfig` 的**第三实参**）；其余档位与未选 ⇒ **键整个不出现** | 触发条件是 `include: ["reasoning.encrypted_content"]`（上游硬编码、不可配）**∧** `reasoning.summary` 同时存在 ⇒ 两半缺一都关不掉。⚠️ 这一格**到得了 CLI，但网关仍会推理**（真机探针的 `off-both` case 照样产出思考正文）⇒ 只保证「已按要求下发」 |
| dsh | 子进程环境 | 显式删除 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL` | 宿主凭据被继承时，不用的 `deepseek-official` 路由会静默可用并真实发请求 |
| dsh | 路由 patch（`- id: <插件 id>`） | 该行的 `config` **整份写出**，不做深合并 | 只写要改的那一格会抹掉同组其它键，随后被插件 schema 的默认值改回 |
| dsh | 联网工具的关闭 | 该行 patch（per-launch overlay `aieval-route.patch.yml`；旧的 `profiles/sdk/cordis.patch.yml` **已退役**）的 `- id: tool-web` 一次写全三格：`{ search: false, fetch: true, searchTimeoutMs: 60000 }` | 顶层 `- id: <插件 id>` 覆盖是**整份替换**：只写 `search: false` 会抹掉同组其余键，再被插件 schema 的默认值改回 ⇒ `fetch` 回到 `true`（`web_fetch` 不消失），而 `searchTimeoutMs` **静默从 60000 掉到 30000**（超时腰斩，`--dump-config` 看不到这一层）。判据：`dsh --profile sdk --dump-config` 的合成树里 `search === false` 且 `fetch === true`。⚠️ **本期未落地**：`buildDshRoutePatch` 今天只写路由与 `tool-ask-user` 插入，`tool-web` / `searchTimeoutMs` 在产品代码里一处都没有 |

### 8.2 必须规避

| 家 | 不要做什么 | 后果 |
|---|---|---|
| claude-code | 依赖自动放行模式（`bypassPermissions` / `acceptEdits`）同时期望收到提问 | 调用在回调之前就被解决，`canUseTool` 不触发，提问被静默跳过（⚠️ 今天连 `canUseTool` 都没注册 ⇒ 这一条暂时空转，见 §8.1） |
| claude-code | 用 `tools` 数组限制能力却不列出需要的工具 | 该工具直接从工具表消失（⚠️ 适配器今天没有给 `tools` 键） |
| codex | 把**任何**带 `receiverThreadIds` 的协作条目都当派发动作写台账 | 真机 `wait` 也带同一个子线程 id ⇒ 台账「后到覆盖」会把 `kind` / `parentCallId` 挪到最后一条协作动作上，界面「进入子任务」的入口随之挂到收场那一步（见 §4.2 步骤 5） |
| codex | 在只支持部分能力的网关路由上开启多智能体 | `spawnAgent` 被拒为 `unsupported call`；带工具列表的请求可能被整体拒绝 |
| codex | 把「近似条目计数」当厂商轮号或跨家可比的往返数 | 现行口径已**收窄成只数模型答复条目**（不再是偏高那个近似值），但它仍是**合成值**、与另两家的计数方法不同 ⇒ 跨家比较前先确认口径（§1.2） |
| dsh | 把 overlay 写到 `profiles/sdk/cordis.patch.yml` | 那是 **dsh 自己的持久化层**（Settings / config-editor 会写它），两份来源混在一个文件里排障时分不清是谁写的 ⇒ 适配器只写 `aieval-route.patch.yml`（有反向守卫） |
| dsh | 把宿主的 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 留在子进程环境里 | 不用的 `deepseek-official` 路由静默可用并按公网地址真实计费；`web_search` 也会拿它去打搜索接口 |
| dsh | patch 里只写要改的那一个键 | 同组其它键被抹掉，再被 schema 默认值改回（`searchTimeoutMs` 静默从 60000 变 30000） |
| 三家 | 用 0 或空串表达"未采集" | 下游无法区分"没有"与"没采到" |
| claude-code | 把 `CLAUDE_CODE_EXTRA_BODY` 的值手写成字符串常量（而不是 `JSON.stringify` 生成） | CLI 对**非法 JSON 静默忽略整条**：`thinking` 仍缺失、**没有任何报错**（真机踩过：PowerShell 吃掉内层引号 ⇒ `{thinking:{type:disabled}}`）。所以该值必须由构造保证合法 |
| claude-code | 用 `CLAUDE_CODE_EXTRA_BODY: off ? VALUE : undefined` 这种写法 | 值为 `undefined` 的键会被**删掉** ⇒ 非 off 档会删掉宿主继承来的同名变量，改变其它档位的行为 |
| claude-code | 依赖宿主环境里没有 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 它在场会让 `off` 档的修复**静默失效**（body 覆盖层被前置条件废掉）。**观测不拦截**：`off` 档且该变量在场时落一条 WARN（点名宿主用的那个**键名原文**、说清后果与下一步），照旧注入、不许因此跳过这一行 |
| codex | 把「已给 `turn/start` 的 `effort:'none'` ∧ `model_reasoning_summary:'none'`」当成「模型真的不思考」 | 两格**都确实到了 CLI**（真机探针的 `off-both` case 照样产出思考正文），**是网关照样推理** ⇒ 判据只能读**行的产物**（该行落盘内容里的 reasoning 条目数），不能读请求体、也不能拿极简 prompt 上的「0 条」外推 |
| codex | 在 config 里写「键在、值为 `undefined`」来表达「不给这一格」 | 本仓把 config 交给 `thread/start` 前会做序列化，`undefined` 值的键**直接消失** ⇒ 今天与「键缺席」**行为等价**；但**键缺席**才是逐键对账与抗序列化 / 协议漂移都成立的那一种形态 |
| claude-code | 把「总数 ≤ 8」当成本行**所有**子智能体的上限 | 上限的作用域是 **Workflow 派生的 agent**（`task_started.task_type === 'local_workflow'`）；普通 `Task` 子智能体（`local_agent`）厂商**没有任何等价开关**。跨家比较编排规模时必须带上这条口径（⚠️ 该闸门本身尚未落地，见 §8.1） |
| claude-code | 自己数到第 9 个就调 `Query.stopTask(taskId)` 硬拦 | 那等于**评测中途改写模型的编排**：被杀掉的 agent 留下半成品，而「编排规模」这个**本该被观察的量**反而被我们自己抹掉。厂商侧唯一的限制就是并发那一格，超出的部分**如实记录** |
| codex | 用配置键给模型预设注入 `multi_agent` profile | 逐键被 CLI 拒（`model_messages` / 顶层 `multi_agent*` / `agent_default_subagent_model` 都被拒；`[agents]` 的 `default_subagent_model` 虽被接受但不含 profile）⇒ 白费工夫，还会让人误以为「配了就通」。这一格只能由网关侧给模型名 |
| codex | 拿 `prompt` 首行当子任务名 | 名称的权威来源是**线程昵称**（`thread/started` 的 `Thread.agentNickname` 作兜底，收尾以 **`thread/list`** 交回的那一格为准）；`prompt` 只进派发调用的入参 |

---

## 9. 落地清单

按实施顺序排列；每步都有可独立验证的产出。

| 序 | 改动面 | 产出 |
|---|---|---|
| 1 | 契约包：消息信封、内容块（含族载荷与 `unrecognized`）、行级事件（含 `vendor-system`）、计量结构（含 `subagentTokens` / `subagentTurns`）、能力声明 | 类型与校验 schema 可被消费方引用 |
| 2 | 环境契约：`AgentEnvironment` / `EnvGroup` / `EnvItem` / `EnvSource` 与数据层的拼装 | 环境抽屉有稳定的取数形状（与消息解耦） |
| 3 | 适配器公共层：覆盖合并、块序号分配、`seq` 分配、工具归族（`classifyTool`）、**族载荷归一**（`toolPayloadOf`）、**工具块构造器**（`toolCallBlockDraft` / `toolResultBlockDraft`，内联族载荷；`providers/**` 里手搓 `tool-call` 块由源码级断言拦）、**用量求和**（`sumUsageTokens` / `addUsage`）、缺失表达工具函数（`json.ts` 的 `asRecord` / `readString` / `readNumber`：读不到就 `null`，不填 0 不填空串） | 合并、归族、归一与求和各只有一份实现，三家适配器都调它 |
| 4 | 适配器骨架接线：`onMessage` / `onSubagent` 两条回调、`TurnProjection` / `TurnFinalize` 的四格（`tokens` / `turns` / `subagentTokens` / `subagentTurns`）与两套 `null` 语义 | 一家产出的消息与子任务行走同一套合并、发射与覆盖规则 |
| 5 | claude-code 适配器：建会话与路由注入 → 消息归一 → 子任务形状判据 → **读 CLI 转录交子份两格** → 规划数据 → 计量 → 工具族 → 交互 | 该家全字段可产出 |
| 6 | codex 适配器：**app-server 起进程与 `CODEX_HOME`** → 通知流解析 → **`thread/list{ancestorThreadId}` 取线程树** → **`thread/read` 收尾补齐**（正文 / 工具真名 / 配对键 / 时间戳）→ 子份两格 → 计量与轮次 → 工具族与开关（**不再有会话文件读取、spawn 链递归与运行期节流读盘**）。⚠️ **含一处待改实现**：派发台账的写入面收窄成「只有派发动作才写」（`wait` / `closeAgent` 不再覆盖 `kind` / `parentCallId`，判据见 §4.2 步骤 5） | 该家全字段可产出 |
| 7 | dsh 适配器：建会话与路由 patch → 通知分流与**整棵会话树放行** → 消息归一 → 子任务两格读状态与 catalog → **按子会话白名单交子份两格** → 计量 → 工具族 → 未识别事件的容错投影 | 该家全字段可产出 |
| 8 | **三端一致性验证**：同一场景三家归一结果逐字段相等（纯文本、shell 调用与结果、思考档位、工具归族、族载荷、缺失表达） | 三家产出的形状差异只剩「这一家结构上没有」的那几格 |
| 9 | 落盘与推送：`messages.jsonl`（消息与子任务行**一条流**）+ 进程内订阅；每次尝试开始时清空；`GET .../rows/<rowId>/messages`（折叠视图）与 `.../messages/stream`（SSE）| 对话视图与派发面板有唯一真相源，刷新与实时两条路径同源 |
| 10 | 投影层：10 个工具族 + 2 张面板（⚠️ **两轴映射表 `action` × `target` 未落地**：今天「用过的工具」按 `tool-call.name` 原名计数，跨家不可比；见 §5.6） | 两张面板与跨家统计的数据可渲染（含各类缺失态） |
| 11 | 派生指标：缓存命中率、tok/s、首字延迟（唯一一份实现） | 界面与导出共用同一套算法 |
| 12 | 能力声明与缺失表达接线 | 缺数据时界面显示"未采集"而非 0；声明与实测行为由守卫对齐 |
| 13 | 配置面固化：三家开关与路由前提逐条落进适配器 | 每条开关都有唯一的写入点，能力声明随之带出路由前提 |
| 14 | **消息级用量**：契约加 `usage`（可选）→ 草稿层加 `usage`（必填可空，`tsc` 列出全部构造点）→ 合并器「带值覆盖、缺省保留」→ dsh 的纯读函数（`protocol.ts` 的 `readUsageTokens` + `DSH_USAGE_FIELDS`，`events.ts` 只调它并 re-export）→ 界面页脚（见 `2026-09-30-exec-log-drawer-redesign-design.md` §6.13） | 每条消息自己那一次模型调用的用量可见，行级口径一字不动 |
| 15 | **思考强度档位**：`AgentRunInput.effort` 的口径（§3.6）逐家落地 → 注册表 `defaultEffort`（只有 dsh 声明）→ API 的候选与未选校验 → 界面下拉与文案 | 未选不再等于关闭；`off` 的翻译只在一处；候选里「关闭」点得到 |
| 16 | **测试夹具的模块图**（见本章末「测试夹具不得重入**「正在求值中」**的模块」） | 收集期死锁不会经 `vi.mock` 工厂的 `import()` 链复发 |
| 17 | **消费方改造**（逐格标「现状 / 待办」）：`client` 的 `row-live.ts`（**现状**：`activityOf` 仍读行级 `log` 事件、取 `log.summary`；`usage` 折叠的**两套 null 语义是刻意相反的**——`tokens` 那一格「未采集」与「这一条不带」同义 ⇒ **保持上一份**（`?? base.tokens`），而**两个子份格**：显式 `null` **清掉**、只有整格缺席才保持；**待办**：「改读消息事件的块」；**缺口**：`RowLiveMetrics.tokens` 上没有 `reasoningOutput` 这一格）、`log-format.ts`（**现状**：`usage` 行加「· 思考 N」且该格为 `null` 时**不写这一段**、`formatEventLine` 的 `switch` 恰好覆盖行级事件那八型；⚠️ **它没有、也不该有 `message` 分支**——`AgentEvent` 的八型里本来就没有 `message`，消息走 `messages.jsonl` / `RowRecord` 那条并行通道；要加得先改契约）、`AGENT_EVENT_TYPES`（**现状**：跟随行级事件清单，SSE 订阅自动跟随）、`metric-line.tsx`（**现状**：不显示思考 token，也不与输出相加）；`judge-agent.ts` **不变**（`finalText` 的语义与来源不变，仍是结果块的文本） | 界面上四类内容各自成形，且没有一处拿思考 token 去加输出 |
| 18 | **守卫与变异验证**（每条守卫都要把它要拦的缺陷人为造回去、确认守卫**失败**，再还原并核对文件哈希未变）：① 三家各一条映射守卫（用真实形状夹具断言事件类型 + 块类型 + 关键字段）；② claude 同一 `messageId` 分次投递 ⇒ 改成「丢弃同 id 的后续投递」必须红；③ 思考块空文本写 `''` 而不是 `null` 必须红；④ `chunk` 把 `delta` 当 `snapshot` 覆盖必须红；⑤ 把 `reasoningOutput` 加进 `output`、或**把它排除出去重比较**、或把估算帧当结算值 ⇒ 各自必须红。⚠️ **「排除出去重比较」这一半的现状要说清**：去重判据 `sameUsage` 里那一格比的是 `agents/src/turn.ts` 的 `sameTrio`，而它的入参类型是 `AgentRunResult['tokens']`（**只有三格**）⇒ 它**结构上**比不了 `reasoningOutput`；要按 §2.4「去重比较必须纳入这一格」落地，得把判据改成比较事件里的 `UsageTokens`（五格），**先改实现再补守卫**（今天 `tokensBasis` 已进判据，覆盖的是「来源变化」那一半）。「加进 `output`」那一半由 `MetricLineProps.tokens` 的**类型收窄**（只声明 `input` / `cached` / `output`）与 `metric-line.test.tsx` 的**行为断言**共同兜着（`{input:1000,cached:200,output:500}` ⇒ `tok 1,500`、`{input:218,cached:8832,output:2}` ⇒ `tok 220`，两处都钉「只加输入与输出」）；⚠️ **缺的不是这条，而是「把思考 token 喂进去也不改 tok」那一条**——那一格在当前类型收窄下根本传不进去，要写它得先放宽 `MetricLineProps.tokens`，或改在 `row-live` / `build-model` 那一层断言；「估算帧当结算值」那一半由编排层只认 `tokensBasis === 'reported'` 的判据 + `orchestrator-live.test.ts` 的两条用例钉住。⚠️ **②③④ 与 ⑤ 的「加进 `output`」四项今天没有变异记录**（台账与 notes 里都查不到）——按 AGENTS.md「没见过失败的守卫不算守卫」，这四项落地时要各补一条变异读数；⑥ `family` 映射的 `null` 档今天**四处真断言、分布在三个文件**（`providers/message-conformance.test.ts` 两处：协作动作名 `wait` 与 MCP 名字 `github.list_issues`；`providers/codex/index.test.ts` 的 MCP 名字 `fs.read`；`providers/codex/message.test.ts` 的同一形态），场景是「MCP 名字 `<server>.<tool>`」与「协作动作名」两类；⚠️ **codex 侧没有「文件读取类四族断言 `family === null`」这条**（那四个名字根本不在它的工具表里）——若真要为它造断言，得先造得出那种条目；⑦ 静态呈现守卫：**受守卫的那一层**（`agent-log/` 的渲染件 L0/L1 ＋ `build-model.ts`）里**不得出现** `AGENT_LABELS[` 这类按 kind 取名的写法、`agentKind` 分支与厂商族名字面量（⚠️ 两个已知边界：**厂商工具名与 `signature` 不在守卫面内**——`isDispatchCall` 就按工具名正则认派发点；**`log-format.ts` 也不在面内**，而它今天正按 kind 查 `AGENT_LABELS` ⇒ 要么把它纳入扫面，要么让它改吃数据层给的 label）；⑧ 能力声明与实测行为对齐（含 `usage` 相关那几格）的守卫，且**不许靠默认值蒙混**（缺格一律按不安全侧判）。⚠️ **「对齐」的判据要写死，否则两种读法都自称合规**：判据＝**一致性套件的场景证明**（夹具喂一条真实形状的载荷 ⇒ 声明 `'yes'` 的那一格必须真的产出对应产物；声明非 `'yes'` 的必须证明它确实没有）＋ **声明的前提写在 `notes` 里**。**不是**「审计适配器交给 SDK 的选项」——那会把 claude 的 `streamingDelta: 'yes'`（解析路径就位、`includePartialMessages` 未开）钉成永久红，而它是**有意保留**的状态，由 `notes` 承载、不进守卫失败面；⑨ codex 派发台账的写入面：造一条「`spawnAgent` → `wait`」的协作序列，断言 `kind` / `parentCallId` **仍落在 `spawnAgent` 那一条上**（今天没有这条用例，见 §4.2 步骤 5） | 每条口径都有会被触发的守卫，而不是一句声明 |
| 19 | **配置面补齐**（⚠️ **本期未落地**：`tool-ask-user` 插入是基线既有事实，不是本次产出）：claude 的 `enableWorkflows: true` + `workflowSizeGuideline: 'medium'` + 注入 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8` 与 `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8` + `CLAUDE_CODE_ENABLE_TASKS: 0` + `canUseTool` 回调；claude 的 `disallowedTools` 收成**无条件七项**（`WebSearch` 不再分模型名，随之下掉那条按模型名的分支与它的用例）；dsh 的 `tool-web` 三格（见 §8.1 / §4.3 步骤 1） | 三家开关各只有一处写入点，且都能被守卫逐字钉住 |

**实现侧的两条硬约束**：

- `agents/src/**` 里**不许出现目录扫描 API 的调用形态**（判据是 `/\breaddir(Sync)?\s*\(/`；它**不剥注释** ⇒ 注释里写出带括号的调用同样判红），只允许一张**不许变长**的豁免表（今天一项，且**唯一那一项就是** §4.1 步骤 5.1 的转录目录枚举）——**其它**「遍历目录」需求要按已知路径形态实现，新增豁免必须显式登记进那张表。
- 厂商的**会话文件与转录**是边跑边写的：读它们的适配器（今天只有 claude 的子智能体转录）必须容忍半截行与坏行——**静默跳过**（`JSON.parse` 抛错就 `return false` 继续下一行），不能假设「文件已经写完」。⚠️ **既没有逐行 WARN、也没有坏行计数**：跳过是唯一的留痕；要补观测的话落点是在那个 catch 里计数、由收尾落一条**汇总** WARN（逐行 WARN 会刷屏），补之前**不要**按「有 WARN」去排障。（codex 侧已不读文件。）

**落盘格式与消费口径**（第 9 步的细则）：

- 文件名 `messages.jsonl`，与 `events.jsonl` 同行目录、**互不合并**：事件按 `seq` 去重与续订（行级），
  记录按 `mergeKey` / `subagentId` 覆盖累积（内容级）。
- 一行一条记录，`RowRecord` 两种载体：`{ type: 'message', message }` 与 `{ type: 'subagent', subagent }`。
- **四格计量的落点不在这个文件里**：`tokens` / `turns` / `subagentTokens` / `subagentTurns` 走 **`usage` 事件**（`seq` 去重）与 **`EvalRow`**（跑动期由事件回写、终态由适配器结果覆盖，写入口是同一个补丁函数）。消息信封上那一格 `usage` 是**消息级**读数（那一次模型调用），**不是累计、不进任何合计**；**单个子任务自己**的用量在 `messages.jsonl` 的 `subagent` 记录里（`SubagentRecord.usage`）。
- 读取侧两步：先按 `type` 分流，再按 `mergeKey`（消息）与 `subagentId`（子任务行）**覆盖累积**，
  顺序按**首次出现**——打字过程中的覆盖不该让这条消息跳到列表末尾。
- 一行都不产出时不建文件：读侧因此不必区分"空文件"与"没有这一格"。
- 每次尝试开始清空（与事件日志同一口径）：它记的是**当前这一次**尝试的内容。
- **实时通道没有 `Last-Event-ID` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
  每次连接回放全量折叠视图，客户端按 `mergeKey`（消息）/ `subagentId`（子任务行）**覆盖累积**——**不需要按 `messageId` 去重**（同一个 `mergeKey` 只留最后一条，重放因此是幂等的）。SSE 帧因此**不带** `id:`
  帧头（设了它浏览器重连会带一个我们解释不了的值，表现为重连后少一段历史且不报错）。
- 消息流与事件流是**两条独立的长连接**，生命周期也不同：事件流在终态帧后自行关闭，消息流保持打开
  （靠终态关流会让"打开一个跑完的行的对话视图"立刻断连，而那份历史正是要看的东西）。

**历史产物：删除，不做读侧兼容**（与「不考虑兼容、保障代码干净」同一口径）：

- 旧 `events.jsonl`（v1 的七型）与旧 `run.json`：**整轮目录不再提供读入口**（旧轮次不出现在列表与详情里），**不加 `messageSpecVersion` 之类的版本分流** ⇒ `AgentEvent` 只有单一版本，`row-stream.ts` 的「`seq` 回到 1 = 新一代」也只需一套判据。
- `resetEvents`（重跑清日志）保持「删文件而不是写空串」。
- ⚠️ **只针对旧格式**：契约里**新增的可选格**（`messages.jsonl` 的 `payload`、`AgentMessage.usage`、`usage` 事件的 `timing` / `turn` / `subagentTokens` / `subagentTurns` / `tokensBasis`）不属于本条——读侧仍须把「键缺席」与显式 `null` 当同一件事，否则老日志会在回放与 SSE 续订时成片解析失败。⚠️ **`SubagentRecord` 的 10 个顶层格全必填**（`subagentId` / `name` / `kind` / `source` / `status` / `statusMissing` / `outcome` / `parentCallId` / `parentSubagentId` / `usage`；只有 `usage` 内部的两个子格 `reasoningOutput` / `total` 是可选的）：顶层少一格就是整行解析失败、**被读侧跳过**——⚠️ 这条通道**不是静默的**：`core/src/message-log.ts` 的 `readRecords` 对 JSON 坏行与 schema 不过的行**各落一条「已跳过」的 WARN**（静默跳过那一档只属于 claude 转录读取，见本章硬约束）；兼容只能靠「本仓不做读侧兼容」这条口径本身。

### 9.1 测试夹具不得重入「正在求值中」的模块

**目标状态**：`evaluator/src/testing/` 下**被 `vi.mock` 工厂动态 `import()` 的模块，不得对「被 mock 的模块」存在运行时边**。夹具模块可以 `import type` 它们（类型专用 import 被整条擦除，运行时不产生模块请求）。

- **症状（不可归因，所以必须防）**：`vi.mock` 工厂的动态 `import()` 链重入一个**正在求值中**的模块 ⇒ vite ModuleRunner 的 await 环**永不 settle**：整个测试文件 **0 个用例**、无报错、无超时、**零 CPU**（在等，不是在算）。收集阶段的等待**不受** `testTimeout` / `hookTimeout` 管辖；`--pool` / `--no-file-parallelism` / 单 worker / `--reporter=json` 全部无效（json 产物根本不生成）。
- **触发条件是「重入在飞的模块」，不是「图里有环」**：同样的三元环只要不重入在飞模块就正常通过。
- **修复的形态**（以 `evaluator/src/testing/fixtures.ts` 为例）：一条 `import { 一个值, type 若干 } from '@aieval/agents'` 里的**那一个值成员**就是闭合边；把它去掉、改成与该函数**逐字等价的字面量**（真源在 `agents` 的 `permissiveMessageCapability`；由 `AgentProviderMetadata.messageCapability` 的**类型**约束 ⇒ 将来新增必填格时 `tsc` 直接点名，不会静默过期）。
  - **不要**用 `vi.importActual` 去取那个函数：那只是把边换成工厂执行路径上的一次旁路读，时机落在同步函数里 ⇒ 风险面不明。字面量把这条边**彻底去掉**，且不需要任何运行时读。
  - **不要在夹具里另写一个自己的 `permissiveMessageCapability()` 复制函数**：那是第二份真源。
  - **一条类型期本该消失的 import，会因为多了一个值成员而变成真正的运行时边**——这是这类缺陷唯一的成因，看 import 语句的**成员构成**就能认出来。
- **守卫（结构判据，不是类型检查）**，落在 `evaluator/src/static-assertions.test.ts`（它自己不 mock 任何东西 ⇒ **永远能跑**；一条自身也会挂死的守卫不算守卫），用 **TS AST**（不要正则）：
  1. `MOCKED` = **一张登记表**：`@aieval/agents` / `./judge` / `./run-store` / `./text-api`（**所有被 mock 的项目模块**；**显式排除 `node:` 内建**——夹具要能 import `node:fs`，把内建纳入会让守卫落地即红，且那不是本类缺陷）。
  2. `ROOTS` = 扫 `src/**/*.test.ts` 里每个 `vi.mock(...)` 的**工厂实参子树**里 `import('<字面量>')` 的目标；从 ROOTS 出发沿**运行时**相对 import 遍历 `evaluator/src` 内的本地文件得到闭包（类型专用 import 不跟着走）。工厂里出现**非字面量**的 import 目标 ⇒ **直接判红**（推导不出来就不放行）。
  3. 闭包里任一文件对 `MOCKED` 任一目标存在运行时边 ⇒ 红，报 `文件:行:目标`。
- **「运行时边」的判定（逐形态）**：整条 `import type { … }` ⇒ 放行；`typeof import('…')`（类型位置）⇒ 放行；**`vi.importActual('…')` ⇒ 显式放行**（它是 mock 系统的旁路 API、读的是真模块，且是 `fakeAgentsModule` 里两个导出的唯一真源；判它违规会让守卫落地即红并诱使人去拆掉它）。
  其余全违规：有任一成员不带 `type` 的具名 import（**含折行与「成员全带 `type`」的混合形态**——`verbatimModuleSyntax` 下 vite 的 SSR transform 会让它**转译后仍残留一条模块请求**，实测如此）、默认 / 命名空间 / 裸 import、`import x = require(…)`、`export * from`、`export { A } from`、`import {} from` / `export {} from`、任何位置的 `import(…)` / `require(…)`。
- **判据的规格 = 样本表**：把上面每一种写法直接喂给判定函数（负样本必须命中、正样本必须放行），规则被改窄时那条用例先红。
- **绊线**：另加一条用例断言「从源码推导出的集合」与登记表**逐项相等**（新增第三条 mock 或第三个工厂目标模块时它先红一次，逼作者回来看新模块要不要纳入）。
- **范围是「工厂目标的静态可达闭包」，不是整个 `testing/` 目录**：后者包含 `orchestrator-harness.ts` 对 `../run-store` 的**运行时** import（它不是任何工厂的目标、不在环上）⇒ 守卫落地那一刻就是红的，而假红会诱使人削弱断言。
- **修复只解决这一条被追到的边**，不是「所有挂死」的通用修复：同类环若以别的形态出现（转手依赖、非字面量的动态 import 目标），要靠上面这条守卫与它的边界来兜。**不承诺全量全绿**——解冻后那批文件是**第一次**真的执行，可能暴露与本次修复无关的既存红；只承诺「**能被收集**」（汇总行的文件总数与逐包一致、用例数非 0），新出现的红按「回归 / 既存 / 机器慢」三分类登记，**不在本次修复里顺手修**。
- ⚠️ **既存的环境噪声不要与它混为一谈**：本机另有清理期 `EPERM`（临时目录被**刚退出的 git 子进程**的 cwd 句柄短暂锁住）。⚠️ **成因别写反**：含 `EPERM` 的重试白名单**只存在于异步 `fs.rm` / rimraf 那条路**，而 `fs.rmSync` 直接下沉 C++ ⇒ `maxRetries` 对 `rmSync` 形同虚设（一个已经空了的目录照样 3ms 就抛，40 次重试一次都没发生）。那些文件的**通过判据**是「失败条数 == 清理期 EPERM 条数 **且** `AssertionError == 0`」，不是「全绿」。**挂死判据**始终是「**进程自行退出** + **用例数非 0**」（挂死的形态是零输出、不退出、需人工中断）。
- **落地顺序**（判据排在最前，否则没有证据链）：① 去掉那条运行时边（夹具那一行 import 的值成员 → 字面量）；② 最小判别实验（该测试文件）**自行退出且用例数非 0**；③ 整包能被**收集齐**（`--reporter=json` 的 `testResults` 条数 == 该包测试文件数）；④ 新守卫（§9.1 的三步判据 + 样本表 + 绊线）；⑤ 逐条变异验证（把那条边造回去 ⇒ **重新卡死**；只在 import 里加回值成员而调用点仍是字面量 ⇒ 守卫红；去掉 `vi.importActual` 的放行 ⇒ 守卫红）；⑥ 还原并核对文件哈希未变。
- **版本敏感**：本文引的 runner 行为（含「这条环在 vite 内部认不出来」）都对应 **vitest 4.1.11 + vite 8.3.0**（`pnpm-lock.yaml`）——那条判据依赖 vite 的内部实现，**换版本要重新确认**，别照抄旧结论。⚠️ 那个「认不出环」的符号是 **vite `module-runner.js` 的内部名**，不是本仓符号（本仓搜不到它是正常的）。未验的维度如实登记：`--pool` 的其它取值、非 Windows、vitest 5 / vite 7。
- **变异读数存在哪**：⑤ 那三条变异的**执行读数**落在 `docs/superpowers/plans/2026-10-06-evaluator-collect-deadlock-fix.md` 的变异小节，逐条输出与还原后的哈希在 `.superpowers/sdd/2026-10-06-evaluator-collect-deadlock-fix/task-2-report.md`（**该目录被 gitignore、不入库**）⇒ 只读本文的人看不到「守卫真的红过」这一环，需要证据链时按上面两个路径去取。

### 9.2 本期不做

- **不把厂商会话文件当主数据源**：它只用于**厂商没别处可给**的那几格——今天只剩 claude 的子智能体转录（用量与轮次）——那些行的 `source` **必须**标出来源；其余字段优先走事件流 / 协议通知（codex 已全部走 `codex app-server`，不再读会话文件）。
- **不直接操作厂商 CLI 的文本界面**：不解析 CLI 的 stdout、不依赖 CLI 的非 SDK 参数。⚠️ **codex 的入口早已不是 `@openai/codex-sdk`**（那个包已不是本仓依赖）：适配器自己 spawn `codex app-server` 并以 JSON-RPC 通信——这是**协议**入口，不是「手拼 argv 的裸 CLI」。
- **不做跨轮趋势统计、不做块级 diff 对比。**
- **不改 `finalText` 的语义与评分通路。**
- **不为 `web-search` 族找替代数据源**：配置面统一关掉的目的就是让该族在所有模型上一致地"没有"（⚠️ dsh 那一侧尚未落地，见 §8.1）；`web_fetch` 照旧可用（只禁搜索，不禁联网）。
- **不给普通 `Task` 子智能体自造上限**（`stopTask` 那条路，见 §8.2）。
- ~~不为原生面板保真度换传输层~~（**已由 `e68d27a` 实际完成**：codex 已迁到 app-server，`turn/plan/updated` 被直接消费 ⇒ 这一条不再是「本期不做」）。

---

## 10. 附录：最小实例集

### 10.1 思考块（三家归一后）

```jsonc
{ "type": "thinking", "text": "先读配置再决定改哪一行。", "textKind": "full", "signature": "EqQBC…" }
```

### 10.1.1 截断的表达（`truncation` 三态）

```jsonc
{ "kind": "truncated", "reason": "超过 20000 字符" }   // 确认被截断，并说明为什么（`reason` 是自由文本；公共层我们自己截断时写的值取自 `TOOL_RESULT_MAX_CHARS = 20_000`）
// ⚠️ 厂商适配器可以**显式覆盖**这段文案：codex 的 `exec_command` 与 MCP 两条就写成「超过工具结果上限」（阈值仍走同一个常量）⇒ 消费方**不要**按字面匹配 reason，只按 `kind` 分支
{ "kind": "none" }                                  // 确认完整（厂商或我们自己给出了完整标记）
{ "kind": "unknown" }                               // **没采到标记** —— 消费方不得据此断定完整
```

**为什么不是布尔**：拿不到截断标记时只能记「没采到」，裸布尔会让界面上「确认完整」与
「不知道完不完」长得一模一样。三条口径：

- **认定方向是单向的**：只有拿到明确标记才能写 `none`；**没采到一律 `unknown`**；
- **自家截断要自己认**（适配器截断正文时写 `truncated` + 原因），别把「我们截了」也记成 `unknown`；
- **界面必须三态各说各的话**：`unknown` 写「输出可能不完整（没采到截断标记）」，
  绝不写「完整」——那正是「用负信号断言正事实」。

### 10.2 工具调用与结果（含族载荷）

```jsonc
{ "type": "tool-call", "callId": "call_00_NiG…", "family": "run-shell", "name": "exec_command",
  "input": { "command": "npm run build", "cwd": "D:/work" } }   // input 是**适配器补出的原文**：codex 的 commandExecution 条目给 {command, cwd}（真名 exec_command 是适配器补的）；**dsh 侧 `arguments` 是 JSON 字符串**，落库前解析成对象
{ "type": "tool-result", "callId": "call_00_NiG…", "structured": { "exitCode": 1, "durationMs": 1200 },
  "isError": true, "text": "…error TS2304…", "truncation": { "kind": "unknown" } }
// structured 是厂商结构化结果的**原文透传**（codex 的命令条目是 exitCode / durationMs；两格都取不到时整格 null）
// truncation：三家都不报截断标记 ⇒ `unknown`（“输出可能不完整”），**不是** `none`

// 同一族的另一次调用：进度清单（`task` 族的族载荷）
{ "type": "tool-call", "callId": "toolu_01B…", "family": "task", "name": "TodoWrite",
  "input": { "todos": [ { "content": "读配置", "status": "completed" },
                        { "content": "改标题", "status": "in_progress" } ] },
  "payload": { "kind": "plan", "note": null,
               "steps": [ { "id": null, "subject": "读配置", "status": "completed", "owner": null, "blockedBy": null },
                          { "id": null, "subject": "改标题", "status": "inProgress", "owner": null, "blockedBy": null } ] } }
// payload 是**本次调用之后的整张清单**（跨调用差分是消费方的事）；`input` 仍是厂商原文
// 认不出形状 ⇒ `payload: null`（走通用工具行，调用不会消失）；空表与 `null` 是两件事
```

**`structured` 必须有落点**：规范要求「有 `meta` 就不要退回去解析文本」，而它承载的是
**已解析过的事实**（dsh 的 `read` 给 `{lines[], totalLines}`、`grep` 给命中数、`write` / `edit`
给改动对象），结果正文那一格往往只是一段给人看的摘要（`<path>…</path>` 那种）。
界面把它渲染成等宽原文并如实标注「结构化结果」即可，**不需要**族专属渲染；
丢掉它等于让「有数据」变成「看不见」。

### 10.3 子任务行

```jsonc
{ "subagentId": "01a0f434-707e-…", "name": "Child runs a tool", "kind": "spawnAgent",
  "source": "wire", "status": "completed", "statusMissing": null,
  "outcome": "CHILD-TOOL-RAN", "parentCallId": "call_00_ET_…", "parentSubagentId": "01a0f434-5def-…",
  "usage": { "input": 1200, "cached": 8320, "output": 114, "reasoningOutput": 52, "total": 9634 } }
// statusMissing：null = 状态已采集；取不到时写缺失原因（如 `'unverified'` / `'not-observed'`）
// parentCallId：**派生这个子任务的那次工具调用 id** —— 与消息的 parentCallId 同源同义
// usage.total 是厂商原文（codex 的 `totalTokens`（线上拼写，旧称 `total_tokens`）**含** `reasoningOutputTokens`，别拿它验算 input + cached + output）
```

**`parentCallId` 为什么必须在子任务行上**：

- **两套 id 不对等**：子任务**记录**的身份是厂商原生 id（claude 的 `task_id`、dsh 的子会话 id、
  codex 的子线程 id），而子任务的**消息**挂在**派生它的那次工具调用 id** 上（claude 的
  `parent_tool_use_id`）。消费方按 `subagentId` 分桶时，子任务的消息会**全部落回主会话或被丢掉**
  ——表现是点进子任务显示「没有对话记录」，而消息就在文件里。
- 消费方的正确做法是**按 `parentCallId` 建一层别名再分桶**（纯搬运，不含启发式）；
  它同时是「派发导航挂在哪一轮」的唯一定位键——没有它，就只能靠「工具名像不像派发工具 +
  任务名逐字相同」去猜，猜不中时**整棵子任务在界面上不可达**。
- 三家的这一格**不是同一个来源**：claude 取自 `tool_use_id`（与派发调用块、子消息上的
  `parent_tool_use_id` 三处同值）；codex 只有**一条**来源——协作条目的**条目 id**（落 `runState.dispatches` 台账，与派发调用块的 `callId` 同值；⚠️ 台账「后到覆盖」，`wait` 也带子线程 id）；dsh 给不出 ⇒ `null`。
- **给不出就记 `null`**，**不猜**：消费方拿不到这一格时退化为按名字认，而不是编一个。

### 10.4 计量行

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 6,
  "tokensBasis": "reported",
  "tokens": { "input": 1221, "cached": 7040, "output": 114, "reasoningOutput": null, "total": 8375 },
  "subagentTokens": { "input": 320, "cached": 1024, "output": 40, "reasoningOutput": null, "total": null },
  "subagentTurns": 2,
  "timing": { "totalMs": 4820, "apiMs": null, "ttftMs": null, "source": "events" } }
// 时长单位毫秒；total 是厂商原文（dsh 口径 = input + 缓存读 + 缓存写 + output；codex 走 `AppServerTokenUsage.totalTokens`，
//   契约注释记它含 reasoning 口径、且「output_tokens 是否含推理未单独探测过」⇒ 只作排障证据，不参与归一后的加和）
// tokensBasis：'reported' = 厂商上报（**只有它才回写行快照**）/ 'estimated' = 跑动期估算；
//   整格可选，**老事件缺格读侧按 'estimated'**（安全侧）
// tokens / turns 是**全树合计**，subagentTokens / subagentTurns 是其中的**分量**（主会话那一行由相减得出）
// 三档只对 subagentTokens / subagentTurns 成立（契约里它们是 `.optional()`）：
//   整格缺席 = 老日志 / 本条不带（保持上一份）；null = 有子智能体但没采到；{0,0,0} / 0 = 确实没有子智能体
// `tokens`（nullable）与 `turns`（必填）**恒在**：草稿层与发射层都恒写这两格，不会缺席
```

### 10.5 增量与快照

```jsonc
{ "messageId": "run-7:20", "subagentId": null, "role": "assistant", "source": "wire",
  "parentCallId": null, "roundTrip": 3, "chunk": "delta", "assembly": "open",
  "mergeKey": "main|3|assistant|-",
  "blocks": [ { "type": "text", "text": "我先看" } ] }
{ "messageId": "run-7:24", "subagentId": null, "role": "assistant", "source": "wire",
  "parentCallId": null, "roundTrip": 3, "chunk": "snapshot", "assembly": "snapshot",
  "mergeKey": "main|3|assistant|-",
  "blocks": [ { "type": "text", "text": "我先看一下配置文件。" } ] }
// 两条消息的 `mergeKey` 相同（`'main'` + roundTrip 3 + 载体 assistant/null）⇒ 后者覆盖前者，最终块是快照那句
// 第一条的 `assembly` 是 `'open'`（这一块还在增量累积上），第二条收到快照后才是 `'snapshot'`
// 这两条是**合并规则的例子**；样例只列与合并有关的格（`vendorId` / `vendorTurn` / `step` / `raw` 等必填格从略；`usage` 是**契约层可选、草稿层必填**那一格，见 §2.1 / §3.2）
// `'delta'` 今天由 **codex** 真的产出（`item/agentMessage/delta` 与两条推理增量通道）；claude 的解析路径已就位但 `includePartialMessages` 未开；dsh 的通道未接（见 §6.1 / §7）
```

### 10.6 未采集的表达

```jsonc
{ "type": "tool-result", "callId": "toolu_01A…", "structured": null, "isError": false,
  "text": "export const config = …", "truncation": { "kind": "unknown" } }  // structured 未采集 ⇒ null，不是 {}
{ "type": "usage", "tokens": null, "subagentTokens": null, "subagentTurns": null,
  "timing": null, "turns": 1 }   // 用量与时间整体未采集 ⇒ null，不是三个 0
// ⚠️ 本节与 §10.9 的 `usage` 样例都略去了可选的 `tokensBasis`（本仓产出的事件恒写它，见 §10.4）；
//   缺格只可能出现在老日志里，读侧按「非显式 reported 即按估算处置」处理（见 §2.3）
```

### 10.7 系统层事实（`vendor-system`）

```jsonc
{ "seq": 3, "at": "2026-10-01T05:24:02.118Z", "type": "vendor-system",
  "tools": ["Read", "Write", "Bash", "Task"], "slashCommands": ["/clear", "/compact"],
  "agents": ["general-purpose"], "mcpServers": null, "permissionMode": "bypassPermissions",
  "outputStyle": "default" }
// 六格各自可空：null = 这一格厂商没投送到我们能读的通道；[] = 采到了、确实是空的
// 整条事件只在厂商真的投送了那一行时才有（没有这一行的那一家不发这条事件，消费方整组走 not-exposed）
```

### 10.8 消息级用量（dsh）

```jsonc
{ "messageId": "run-7:31", "mergeKey": "main|3|assistant|-", "role": "assistant",
  "roundTrip": 3, "subagentId": null, "chunk": "snapshot",
  "blocks": [ { "type": "text", "text": "我先看一下配置文件。" } ],
  "usage": { "input": 1546, "cached": 9216, "output": 442 } }
// 这一次模型调用自己的用量；不是累计、不进任何合计 ⇒ 不得与 usage 事件的 tokens / 行卡片对账
// 三项缺一 ⇒ 整格 null（不填 0）；claude / codex 恒为 `null`（**不是缺键**：草稿层与合并器都恒写这一格，
//   只是值为 null；读侧把两者当同一件事，但形状上不是一件事）
```

### 10.9 轮次与用量的归属键

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 6,
  "turn": { "subagentId": "48b5bcf6-…", "round": 2 },
  "tokens": { "input": 1211, "cached": 7424, "output": 108 } }
// turns = 这一行跑到第几轮了（**行尺度**：服务进度条与 EvalRow.turns，必填）
// turn  = 这一条读数发生在哪个会话的第几轮（**会话尺度**：界面据此把读数放回它自己那一轮；可选）
//   ⚠️ **`tokens` 的口径跟着这一格走**：`subagentId` 非空 ⇒ `tokens` 是**那个子会话自己**的累计
//      ⇒ **不许**拿 `tokens − subagentTokens` 去反推那一格里的主会话（dsh 是例外：它带身份的读数也是全树累计）
// 缺键与显式 null 同义 ⇒ 无归属信息（界面按时刻归位，与老日志逐字相同）
```
