# Agent 消息规范 v3：契约、三家映射与实施路径

> **本文自包含**：接口声明、字段含义、三家取值路径、缺失影响与实施步骤全部写在本文内，不需要查阅任何其它文档。
> **阅读顺序 = 实施顺序**：先读契约与字段映射，再按家落地实现，接着是工具族与面板投影、流式与合并、缺失影响、配置面，最后照落地清单收口。每章开头即写该章产出，可以逐章实施、逐章验证。全部内容都在本文内，不需要查阅其它文档。

## 章节地图

| 章 | 标题 | 本章产出 |
|---|---|---|
| 1 | 术语与约定 | 三家缩写、四个易混量（往返/厂商轮/步骤/子任务）的定义 |
| 2 | 统一消息契约 | 可直接落进代码的 TypeScript 接口 + 每个字段的含义与缺失语义 |
| 3 | 字段级三家映射 | 每个字段在三家的取值路径、取不到时填什么、默认能力取值 |
| 4 | 三家实施路径 | 逐家、逐步骤的落地顺序与关键实现点 |
| 5 | 工具族与面板投影 | 10 个工具族的归一规则、三家工具名映射、2 张面板的数据来源 |
| 6 | 流式与合并规则 | 增量/快照的产出规则、覆盖合并算法、顺序保证 |
| 7 | 缺失影响矩阵 | 谁缺什么、影响什么、消费方必须遵守的展示义务 |
| 8 | 配置面 | 三家必须写死的开关与闸门，以及必须规避的配置 |
| 9 | 落地清单 | 按包与按顺序的改动面 |
| 10 | 附录：最小实例集 | 每种块与事件的一手样例 |

---

## 1. 术语与约定

### 1.1 三家

| 缩写 | 指什么 | 取数通道 |
|---|---|---|
| `claude-code` | `@anthropic-ai/claude-agent-sdk`（Anthropic Agent SDK）驱动的 claude CLI | SDK 消息流（`system` / `assistant` / `user` / `result` / `stream_event`） |
| `codex` | **`@openai/codex-sdk`** 驱动的 codex 运行时（SDK 内部以 `exec --experimental-json` 形态驱动其自带可执行文件，可用 `codexPathOverride` 换可执行文件） | SDK 产出的事件流（JSONL）+ **会话文件**（`$CODEX_HOME/sessions/…/rollout-*.jsonl`）+ hook 回调（`SubagentStart` / `SubagentStop`） |
| `dsh` | DeepSeek Harness | 会话协议通知流，method 四种：`session.event` / `session.status` / `subagent.started` / `subagent.finished` |

### 1.2 四个易混的"轮次/步骤"量

| 量 | 定义 | claude-code | codex | dsh |
|---|---|---|---|---|
| `roundTrip` | **模型往返序号**：一次模型 API 往返 = 1，从 1 递增 | 合成：按 `assistant.message.id` 去重计数 | 合成：按模型产出条目 `item.id` 去重计数 | 合成：按 `step/start` 边界计数 |
| `vendorTurn` | **厂商自己的轮号** | 无 | 无 | 有：`turn`（**用户轮号**，不是模型往返号） |
| `step` | **一轮内的第几次调用** | 无 | 无 | 有：`step` |
| `subagentId` | 子智能体/子线程身份 | `task_started.task_id`（同一条子任务的 `task_notification.task_id` 同值） | **子线程 id**：事件流由 `collab_tool_call.receiver_thread_ids` 给出，会话文件由 `session_meta.id` 给出（两者同值） | `agentId`（与 `childSessionId` 同值） |

`subagentId` 在 claude-code 与 dsh 上就是厂商原生 id ⇒ 这两家的子任务载荷里 `vendorId` 与 `subagentId` 同值；codex 的线程 id 同样是原生值，但它不在事件流的消息条目上。

`roundTrip` 三家都要合成，且计数方法不同 ⇒ **跨家比较前必须确认口径**，不要把某家偏高的近似值当成另一家的等价物。

### 1.3 三条全局约定

1. **`null` 只表示"未采集"**，永远不等于 0。缺数据一律 `null`，禁止用 0、空串、空数组冒充。
2. **不合成无法验证的值**：可以不采（`null`），不可以猜。文本类字段尤其如此——上游没给正文时，不得拿摘要、token 数或统计量顶替。
3. **每个值都带来源**：同一字段在不同家可能来自事件流、会话文件或 hook，来源必须随值一起给出，否则消费方无法判断实时性与可比性。

---

## 2. 统一消息契约

### 2.1 消息信封

```ts
/** 数据来源：决定实时性与可信度，消费方必须读 */
type MessageSource = 'wire' | 'hook' | 'session-file' | 'aggregate';

/** 块形态：'delta' 是增量片段，'snapshot' 是该块的当前完整内容 */
type ChunkKind = 'delta' | 'snapshot';

interface AgentMessage {
  /** 本项目生成的稳定消息 id（`<runId>:<seq>`），与厂商 id 解耦 */
  messageId: string;
  /** 厂商侧消息/条目 id；厂商没有则为 null */
  vendorId: string | null;
  /** 说话者；codex 由条目类型派生 */
  role: 'assistant' | 'user' | 'tool' | 'system';
  /** 数据来源 */
  source: MessageSource;
  /** 模型往返序号，从 1 递增；三家均为合成值 */
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
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: unknown;
}
```

**字段缺失语义**

| 字段 | 为 `null` 的含义 | 消费方义务 |
|---|---|---|
| `vendorId` | 该家没有可用的消息级 id | 不得把它当去重键；用 `messageId` |
| `vendorTurn` | 该家没有厂商轮号 | 不得用 `roundTrip` 冒充（两者语义不同） |
| `step` | 该家没有"一轮内第几次调用" | 不得按 `step` 分组做跨家对比 |
| `parentCallId` | 该家给不出派生关系 | 子任务归属改用 `subagentId` |
| `subagentId` | 这条来自主线程 | — |
| `assembly` / `mergeKey` | 不是可空格（各恒为两个取值之一 / 一个字符串） | `'open'` 时按"未收尾"呈现；按 `mergeKey` 覆盖累积 |

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
                           input: unknown;      /** 原始入参，未做语义改写 */ }
interface ToolResultBlock{ type: 'tool-result'; callId: string;
                           /** 结构化结果（厂商给了才填）；没有则 null */
                           structured: unknown;
                           isError: boolean;
                           /** 结果文本；截断时 truncated = true */
                           text: string;
                           truncated: boolean }
interface AttachmentBlock{ type: 'attachment';  kind: 'image' | 'file';
                           path: string | null; mimeType: string | null }

type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock | AttachmentBlock;

type ToolFamily = 'read-file' | 'write-file' | 'edit-file' | 'search-content' | 'list-files'
                | 'run-shell' | 'web-search' | 'spawn-agent' | 'task' | 'ask-user';
```

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
  "roundTrip": 2, "vendorTurn": null, "step": null, "parentCallId": "toolu_01A…", "subagentId": null,
  "chunk": "snapshot", "assembly": "snapshot",
  "blocks": [ { "type": "tool-result", "callId": "toolu_01A…", "structured": { "totalLines": 42 },
                "isError": false, "text": "export const config = …", "truncated": false } ],
  "raw": {} }
```

### 2.3 行级事件

行级事件与消息**并行**输出，不进 `blocks`。七个类型：

```ts
type AgentEvent =
  | { seq: number; at: string; type: 'status'; status: EvalRowStatus }
  | { seq: number; at: string; type: 'log'; stream: 'stdout' | 'stderr';
      text: string;        /** 原始负载（排障用） */
      summary?: string }   /** 给人看的一句话；无则省略，消费方不得拿 text 顶替 */
  | { seq: number; at: string; type: 'usage'; tokens: UsageTokens | null;
      timing: UsageTiming | null; turns: number }
  | { seq: number; at: string; type: 'diff-summary'; filesChanged: number;
      insertions: number; deletions: number; truncated: boolean }
  | { seq: number; at: string; type: 'score'; score: ScoreResult }
  | { seq: number; at: string; type: 'error'; message: string; stack?: string }
  | { seq: number; at: string; type: 'end'; exitReason: string };
```

- `seq` 从 1 单调递增，用于去重与断线续订；`at` 是**本项目**写入时间，不是厂商时间。
- `usage` 的四个格：`turns` 必填，`tokens` 与 `timing` 可空。
- `turns` 与 `tokens` **相互独立**：`turns` 是"到目前为止的模型往返次数"，每见到一次新往返就应发一条；`tokens` 采不到就是 `null`，不得因为 token 缺失而停发轮次。
- `timing` 的 `apiMs` / `ttftMs` 多数家没有 ⇒ 各自为 `null`；`source` 恒有值，决定这组时长能不能与另一家横着比。

**实例**

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 2,
  "tokens": { "input": 1219, "cached": 7040, "output": 114, "reasoningOutput": 52, "total": 8260 },
  "timing": { "totalMs": 4820, "apiMs": null, "ttftMs": null, "source": "events" } }
```

### 2.4 计量结构

```ts
interface UsageTokens {
  /** **非缓存输入** token。三家统一口径：claude-code 与 dsh 的原文即不含缓存、原样取；codex 的 `input_tokens` 含缓存读，适配器必须减掉 `cached_input_tokens` */
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

### 2.5 能力声明

每家每次运行都带一份能力声明，说明"这次到底能拿到什么"。取值五态：

```ts
type Capability =
  | 'yes'                    // 有值，且来自厂商原生字段
  | 'no'                     // 这家结构上就没有这个能力
  | 'unverified'             // 没验证过，不要当有也不要当没有
  | 'off-by-adapter'         // 厂商有，但当前实现没接
  | 'not-projected-by-vendor'; // 厂商侧有数据，但不投送到我们拿得到的通道

type MissingReason = 'not-supported' | 'not-exposed' | 'not-observed' | 'unverified';

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

- **通道与原因逐格声明**，不是整份声明一份：codex 的思考正文来自会话文件，而它的事件流那一格按厂商定义只有摘要（`not-projected-by-vendor` / `not-exposed`）——两件事必须能同时表达。
- 取值为 `no` / `not-projected-by-vendor` / `off-by-adapter` 的格**必须**配一条 `MissingReason`，对应关系为 `no → 'not-supported'`、`not-projected-by-vendor → 'not-exposed'`、`off-by-adapter → 'not-observed'`（当前实现没接这一格）或 `'unverified'`（只做过部分验证）。`unverified` 这一态本身就是 `'unverified'`；它只用于确实没验证过的格，不得当成"没有"。
- 取值为 `'yes'` 的格**必须**同时给出它那一格的 `source`（值从哪条通道取到）；其余四态的 `source` 为 `null`。
- **能力随路由翻转**：同一份能力位在不同路由下取值不同（codex 的多智能体在会拒绝命名空间工具的路由上被判 `unsupported call`，在另一条路由上整条派发链跑得通）⇒ 必须把路由与模型名写进 `notes`，不得把某一条路由上的取值写成这家的固有属性。
- `thinkingTextKind` **不是**能力位，是"思考文本属于哪一档"的取值（`'full'` 完整推理 / `'summary'` 厂商摘要 / `'none'` 有思考但无文本）：它随 `thinkingText` 一起声明，`thinkingText` 非 `'yes'` 时按 `'none'` 填。

### 2.6 子任务行

子任务不走 `AgentMessage`，而是一行一子任务的记录：

```ts
interface SubagentRecord {
  /** 子智能体/子线程身份；与厂商 id 同值 */
  subagentId: string;
  /** 展示名；采不到为 null（消费方显示身份前 8 位） */
  name: string | null;
  /** 派发方式（如 spawn_agent / subagent / Task），采不到为 null */
  kind: string | null;
  /** 这行记录的数据来源 */
  source: MessageSource;
  /** 归一到六种之一；厂商没给状态且无法推导时为 'unknown' */
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  /** null = 状态已采集到；非 null = 未采集到的原因 */
  statusMissing: MissingReason | null;
  /** 结果摘要（子智能体的最终答复）；取消场景可能为 null */
  outcome: string | null;
  /** 嵌套父链；顶层子任务为 null */
  parentSubagentId: string | null;
  /** 该子任务自己的用量；采不到为 null */
  usage: UsageTokens | null;
}
```

两条硬规则：

- **状态与"状态是否采到"分开记**：`status` 永远给一个可渲染的值（采不到就 `'unknown'`），`statusMissing` 说明为什么采不到。不得用 `status: null` 表示未采集。
- **`outcome` 只放文本**：厂商给的是结构化对象时取其中的文本块；拿不到文本就 `null`，不得用推理内容、工具输出或状态文案顶替。

---

## 3. 字段级三家映射

表中"路径"一律写成 `载荷 → 字段`；`—` 表示该家没有这个来源。

### 3.1 信封字段

| 字段 | claude-code | codex | dsh |
|---|---|---|---|
| `messageId` | 适配器生成 `<runId>:<seq>` | 同左 | 同左 |
| `vendorId` | `assistant.message.id` | `item.id` | `data.message.id` |
| `role` | `assistant.message.role` | **派生**：`agent_message` / `reasoning` → `assistant`；`command_execution` / `file_change` / `mcp_tool_call` / `web_search` → `tool`；`collab_tool_call` → `tool`（多智能体条目，不在标准 item 联合里）；`error`、`todo_list` 不产出消息 | `data.message.role` |
| `source` | `'wire'`（SDK 消息流） | `'wire'`（事件流）/ `'hook'`（子任务回调）/ `'session-file'`（会话文件补录） | `'wire'`（会话通知流） |
| `roundTrip` | 按 `assistant.message.id` 去重计数 | 按模型产出条目（`reasoning` / `agent_message`）的 `item.id` 去重计数（**近似，系统性偏高**） | 按 `step/start` 事件边界计数 |
| `vendorTurn` | `null` | `null` | `data.message.turn`（用户轮号） |
| `step` | `null` | `null` | `data.message.step` |
| `parentCallId` | `parent_tool_use_id`（与工具调用 id 同空间） | `null`（子智能体不产出消息，该字段无载体） | 由 `subagent` 工具结果文本解析子会话 id，与该结果的 `toolCallId` 建立关联表（契约预留，当前未接 ⇒ `null`） |
| `subagentId` | `task_started.task_id` | 子线程 id（= 会话文件名末段） | `agentId`（与 `childSessionId` 同值） |
| `chunk` | 默认 `'snapshot'`；开启 `includePartialMessages` 后同一块先出 `'delta'`（`content_block_delta`）、再出 `'snapshot'`（完整 assistant 消息）；**仅主会话** | 恒 `'snapshot'`（事件流无 delta 形态） | `'delta'`（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）与 `'snapshot'`（块结束）都有 |
| `raw` | 该条 SDK 消息原样 | 该条事件或会话记录原样 | 该条通知原样 |

### 3.2 内容块

| 块 | claude-code | codex | dsh |
|---|---|---|---|
| `text` | `assistant.message.content[type=text].text` | `item.type='agent_message'.text`（事件流）；会话文件 `message.content[type=output_text].text` | `data.message.content[type=text].text`；流式为 `text-chunks` |
| `thinking` | `assistant.message.content[type=thinking]`（`thinking` + `signature`）；流式为 `thinking_delta` / `signature_delta` | **会话文件** `reasoning.content[type=reasoning_text].text`（正文），`reasoning.summary[]` 另存一行；事件流的 `reasoning` item 在厂商定义上就是**摘要**通道（`text` 为推理摘要），正文只在会话文件里 | `data.message.content[type=reasoning].text`；流式为 `reasoning-chunks`，块结束给整块快照（会话协议层只投 `*-chunks` 与块结束两种，增量分片打包在 `reasoning-chunks` 的 `texts[]` / `dt[]` 里，不另投 `reasoning-delta`） |
| `tool-call` | `content[type=tool_use]`：`id` / `name` / `input` | 事件流：`item.type='command_execution'`（只有 `command` 文本）或 `item.type='collab_tool_call'`（`tool` 是被派发的协作动作名）；**真名与结构化入参在会话文件** `function_call.name` / `arguments`（`arguments` 是 JSON 字符串，`call_id` 与结果配对） | `tool/call` 事件的 `data`：`callId` / `name` / `arguments`（JSON 字符串） |
| `tool-result` | `user.message.content[type=tool_result]`：`tool_use_id` / `content` / `is_error`；结构化旁路 `tool_use_result` | `item.type='command_execution'`：`aggregated_output` / `exit_code` / `status`；`item.type='mcp_tool_call'`：`result.content[]` / `error.message` / `status`；`item.type='file_change'`：`changes[]` / `status`。会话文件里 `function_call_output.output` 按 `call_id` 与调用配对 | `tool/result` 事件的 `data.message`：`toolCallId` / `content[]` / `isError` |
| `attachment` | Message API 的 `image` / `document` 块（**只出现在 user 消息**里，含工具结果里的图片） | —（无附件块） | `content[type=image]` / `content[type=file]`（内容块里各带一个 `attachment` 引用，不是 `type='attachment'`） |

### 3.3 子任务

| 维度 | claude-code | codex | dsh |
|---|---|---|---|
| 启动 | `system` 子类型 `task_started`：`task_id` / `subagent_type` / `description` / `prompt` / `spawn_depth` | 事件流 `item.type='collab_tool_call'`：`tool`（`spawn_agent` / `wait` / `close_agent` 等）/ `prompt` / `sender_thread_id` / `receiver_thread_ids` / `agents_states`（**以子线程 id 为键的对象**，不是数组）；hook `SubagentStart` 给 `agent_id` / `agent_type` / `transcript_path` | `subagent.started`：`parentSessionId` / `childSessionId`（**没有 `agentId`**——收场前只能用 `childSessionId` 认人）+ `subagent/catalog` 项 `{childId, mode, label?}`（`provider` 与 `agentId` 都在 `subagent.finished` 上） |
| 名称 | `task_started.description` | `collab_tool_call.prompt` 首行；hook `SubagentStart` / `SubagentStop` 的载荷里没有名称，取会话文件 `thread_spawn.agent_nickname` | catalog `label`（缺 catalog 项时为 `null`） |
| 类型 | `task_started.subagent_type` | `collab_tool_call.tool`（如 `spawn_agent`） | catalog `mode`；`provider` 取 `subagent.finished` |
| 状态 | `task_notification.status` ∈ `completed`/`failed`/`stopped`（`task_started` 时记 `running`） | 事件流 `agents_states[<子线程 id>].status`；取不到时记 `unknown` + `statusMissing` | **两格合读**：`status` + `stopReason`（`stopReason !== 'completed'` 时不得报 `completed`） |
| 结果摘要 | `task_notification.summary` | hook `SubagentStop.last_assistant_message`；事件流 `agents_states[].message`；会话文件子线程的 `assistant` 消息 | `subagent.finished` 载荷 `lastAssistantMessage` 里 `type='text'` 的块（取消时可能没有 ⇒ `null`） |
| 嵌套父链 | `null`（`spawn_depth` 与 `is_backgrounded` 可得，父 id 不在载荷里） | 会话文件 `session_meta.source.subagent.thread_spawn.parent_thread_id` + `depth` | 由 `parentSessionId` 是否等于主会话判定 |
| 子任务级用量 | `task_notification.usage`（`total_tokens` / `tool_uses` / `duration_ms`） | 子线程会话文件 `event_msg.token_count.info.total_token_usage` / `last_token_usage`（含 `reasoning_output_tokens`） | 子会话 `assistant/message` 的 `data.usage`（按 `sessionId` 分组求和） |
| 轨迹可达性 | 子智能体消息与主会话同流投送（带 `parent_tool_use_id`）；**默认只投送子智能体的 `tool_use` / `tool_result` 块**，子智能体自己的文本与思考块要开启 `forwardSubagentText` 才转发 | **不在主流里**，必须读子线程会话文件（消息、工具调用、推理） | 子会话事件直接出现在通知流里（`params.sessionId` = 子会话 id） |
| 未收场 | 无通知 ⇒ 保持"运行中" | 会话文件仍在，可读部分轨迹 | 运行时被终止时 `subagent.finished` 不会到达 ⇒ 必须显示"未收场" |

### 3.4 计量

| 量 | claude-code | codex | dsh |
|---|---|---|---|
| 输入（非缓存） | `result.usage.input_tokens`（原文即不含 cache） | 事件流 `turn.completed.usage.input_tokens − cached_input_tokens`；会话文件 `token_count.info.total_token_usage.*` 同式（**必须减**） | `usage.inputTokens`（原文即不含 cache） |
| 命中缓存 | `cache_read_input_tokens` | `cached_input_tokens` | `cacheReadTokens` |
| 输出 | `output_tokens` | `output_tokens` | `outputTokens` |
| 思考 token | `output_tokens_details.thinking_tokens` | `reasoning_output_tokens`（**只有会话文件的 `token_count` 有**，事件流的 `turn.completed` 不含它） | `reasoningTokens`（当前通道不投送 ⇒ `null`） |
| 缓存写 | `cache_creation_input_tokens`（**不计入 `cached`**） | `cache_write_input_tokens`（**不计入 `cached`**） | `cacheWriteTokens`（**不计入 `cached`**） |
| 总量原文 | 无（分列计数，没有合计格 ⇒ `null`） | 事件流按类型面**没有**总量格 ⇒ `null`；会话文件 `token_count.info.total_token_usage.total_tokens` | `totalTokens` |
| 整轮时长 | `result.duration_ms` | 会话文件首末行 `timestamp` 之差 | 会话事件 `time` 首末之差 |
| 仅 API 时长 | `result.duration_api_ms` | `null` | `null` |
| 首 token 时延 | `result.ttft_ms` | `null` | `null` |
| 时间来源标记 | `'vendor'` | `'events'` | `'events'` |

**两处必须写进适配器的口径差异**：

1. **输入的 cache 口径**：codex 的 `input_tokens` 含缓存读，另两家不含 ⇒ codex 必须做减法，归一后三家统一用 `cached / (input + cached)` 算命中率。
2. **缓存写不进 `cached`**：三家的 `cache_creation_input_tokens` / `cache_write_input_tokens` / `cacheWriteTokens` 都是"写进缓存"，与"从缓存读"是两件事，一律不进 `cached`（否则第一轮就会显示命中率 100%）。

### 3.5 能力声明（默认取值）

| 能力 | claude-code | codex | dsh |
|---|---|---|---|
| `thinkingText` | `'yes'`（SDK 消息流） | `'yes'`（**会话文件**通道）；事件流那一格记 `not-projected-by-vendor`（`reasoning` item 按厂商定义只给推理摘要，正文只在会话文件里） | `'yes'`（会话通知流） |
| `thinkingTextKind` | `'full'` | `'full'`（会话文件正文）/ `'summary'`（事件流那一格） | `'full'` |
| `toolInput` | `'yes'` | `'yes'`（真名与结构化入参取自会话文件；事件流那一格只有命令文本与协作动作名，记 `not-projected-by-vendor`） | `'yes'` |
| `toolResult` | `'yes'` | `'yes'` | `'yes'` |
| `subagent` | `'yes'`（**轨迹完整度取决于 `forwardSubagentText`**：默认只投送子智能体的 `tool_use` / `tool_result` 块，开启后才转发其文本与思考块） | `'yes'`（依赖多智能体开关与路由；轨迹取自子线程会话文件） | `'yes'` |
| `streamingDelta` | `'yes'`（开启 `includePartialMessages` 后；仅主会话） | `'no'` | `'yes'` |

---

## 4. 三家实施路径

每家的步骤按依赖排列，可逐步实现、逐步验证。

### 4.1 claude-code

**步骤 1｜建会话**
- 用 Agent SDK `query({ prompt, options })`；`cwd` 指向工作区。
- `settingSources` 决定读哪些**文件系统 settings**：`'user'` = 配置根下的 `settings.json`、`'project'` = `${cwd}/.claude/settings.json`、`'local'` = `${cwd}/.claude/settings.local.json`；`[]` = 隔离模式（一个都不读，代价是**仓库自带的 `CLAUDE.md` 与项目配置也读不到**——`'project'` 是加载 `CLAUDE.md` 的必要条件）。需要它们时给 `['user', 'project', 'local']`，此时**必须**同时给 `settings: { env: { … } }`：仓库自带的 `.claude/settings.json` 就在 `'project'` 档里，它的 `env` 块会盖掉子进程环境注入的地址与密钥，而 `settings`（等价 CLI 的 `--settings`，flag 档）优先级高于 project / local，能把路由压回去。两半必须成对给。
- `env` 注入模型与路由（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` 等），不要依赖用户全局配置；`env` 是**替换**语义，要自己展开宿主环境。
- 权限用显式模式；若需要接收提问，见步骤 7。

**步骤 2｜打开流式**
- 选项 `includePartialMessages: true`，消息流里会出现 `stream_event`。
- 事件形态：`message_start` → `content_block_start` → 多个 `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`。
- 增量子类型（判据是 `content_block_delta.delta.type`）：`text_delta`（正文）、`thinking_delta`（思考正文）、`signature_delta`（签名）、`input_json_delta`（工具入参分片，片段在 `partial_json`）；还会出现别的子类型（如 `citations_delta`），不认识的按未知类型跳过，不得当成正文或入参。
- **自己累积**：SDK 只转发原始事件，不提供累积文本；按 `index` 分组累积到块。
- 流式事件只覆盖主会话：其 `parent_tool_use_id` 恒为 `null`，子智能体的 token 级增量不会转发，子任务归属一律用完整消息上的 `parent_tool_use_id`。

**步骤 3｜归一消息与块**
- `assistant` 消息 → 遍历 `message.content[]` 产出块：`text` / `thinking`（含 `signature`）/ `tool_use`。
- `user` 消息 → 若含 `tool_result`，产出 `tool-result` 块；同时读 `tool_use_result` 作为 `structured`——它是**工具的完整 Output 对象**（形状按工具名而定），不是发给模型的那份字符串内容，能读它就不要再从文本里正则提取。
- `system` 消息按子类型分流：`init` 给工具表与会话信息；`task_started`/`task_notification` 走子任务通道。
- `result` 消息给终局用量与时延；一次 turn **恰好一条**，且在该 turn 的 `assistant` / `user` / `stream_event` 之后到达 ⇒ 可当收轮信号（其后仍可能有 `task_notification` 这类信息型 `system` 消息）。

**步骤 4｜覆盖合并（关键）**
- 同一条 `assistant.message.id` 会被**分多条**投递：SDK 每完成一个非空内容块就发一条，每条只带该块（思考 / 正文 / 工具调用各一条），这些条共享同一个 id。
- 合并规则：同一条 `message.id` 会被**按内容块**分多次投递，每次只带一个块 ⇒ **新块追加到末尾、同键覆盖**（不得把每次投递都当成"整条消息的第 0 块"）；块序号按**首次到达**分配，分配后不再变化。增量（步骤 2）先按 `index` 累积成一个块，再按同一键覆盖。

**步骤 5｜子任务**
- `task_started`：`task_id` → `subagentId`；`description` → `name`；`subagent_type` → `kind`；`spawn_depth` 用于层级。
- `task_notification`：`status` → 终态；`summary` → `outcome`；`usage` → 子任务级用量。
- 子智能体的**工具调用与工具结果**块默认就出现在主流里（带 `parent_tool_use_id`），按它归属到对应子任务；`task_started.tool_use_id`、派生该子任务的工具调用 id、子消息上的 `parent_tool_use_id` 三者同值，可直接配对。
- 子智能体自己的**文本与思考块默认不转发**：必须显式给 `forwardSubagentText: true` 才会随主流到达（开启前只有 `tool_use` / `tool_result` 块）。不开时子任务视图只剩工具流水，看不到"子智能体说了什么、想了什么"。
- 嵌套父链没有原生字段：`task_started` 只给 `spawn_depth`，父任务的 id 不在载荷里，该格填 `null`，层级只能靠 `spawn_depth` 表达。

**步骤 6｜规划数据**
- 工具按模型门控：`TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` 或 `TodoWrite` 只在部分模型默认给出。
- 显式开启任选一种：把工具名写进 `tools` 数组；或用 `allowedTools` 点名；或设 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。设 `CLAUDE_CODE_ENABLE_TASKS=0` 可把四件套换成 `TodoWrite`。
- `TaskCreate` 的返回 id 从**携带 tool_result 的 user 消息**的 `tool_use_result` 里读结构化对象，不要从文本里正则提取。
- 条目更新是**逐条 patch**，适配器要按 `taskId` 累积成整表再交出去；`status: 'deleted'` 表示移除该条。
- `TaskUpdate` 在流里的入参是模型**原始发出**的形状：键可能是 `taskId`，也可能是 `id` / `task_id`（`activeForm` 同理可能是 `active_form`）；CLI 只在执行前修这些名字，流里看不到修复结果 ⇒ 读取时几个名字都要认。

**步骤 7｜交互与计划模式**
- `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode` 三个工具**只在注册了 `canUseTool` 回调时才出现在工具表里**；不注册则连工具都没有。给了 `tools` 数组收窄能力时，必须把 `AskUserQuestion` 也列进去，否则提问能力直接消失。
- 自动放行模式（`bypassPermissions`、`acceptEdits`）会在回调之前解决调用 ⇒ 回调不会触发。要真正收到问题，改用 `PreToolUse` hook 拦截，或使用会走审批的权限模式。

**步骤 8｜工具族映射**
- 工具表项数由**模型与开关**共同决定（同一版本在不同模型与开关下取到过 23～30 项），族映射要按**工具名**做，不按数量。
- 子智能体工具是同一个东西的两种叫法：`system/init` 工具表与部分模型叫 `Task`，入站工具表与另一些模型叫 `Agent`（工具 schema 里的名字也是 `Agent`）。两个名字都要映射到同一族，不要按名字拆成两族。
- `Bash` 结果**没有结构化退出码**：失败时结果文本形如 `Exit code N`，从文本解析；成功时该格保持 `null`，不要填 0。
- 长输出会走持久化文件路径，工具结果里给的是路径而不是正文。

**步骤 9｜计量**
- 用量从 `result.usage` 取：`input_tokens`（不含缓存）、`cache_read_input_tokens`、`output_tokens`、`output_tokens_details.thinking_tokens`。
- 时延从 `result` 取：`duration_ms`、`duration_api_ms`、`ttft_ms`，来源标 `'vendor'`。
- `thinking_tokens` 在 `usage.output_tokens_details` 里，该格可能整个缺失、也可能给 0：**0 不等于这家不思考**（兼容后端会把"上游没报"写成 0）⇒ 缺失记 `null`、读到 0 **照实记 0**（这一格是厂商原文），但不得据此断言"这家不思考"。`output_tokens` 已含思考量，归一后不要再做减法。

### 4.2 codex

**步骤 1｜启动与路由**
- 用 **`@openai/codex-sdk`** 发起：`new Codex({ apiKey, baseUrl, config, env })` → `startThread(线程选项)` → `await runStreamed(提示词, { signal, outputSchema? })` → 迭代 `run.events`（异步生成器，逐个产出已解析的事件对象；`thread.id` 到首轮开始后才有值）。
- SDK 内部以 **`exec --experimental-json`** 形态驱动**它自带的那个可执行文件**：可执行文件由平台包解析而来（Windows x64 上是 `@openai/codex-win32-x64` 的 `vendor/<target-triple>/bin/codex.exe`），**提示词从 stdin 传入**，模型与开关经 `--config <点号键>=<TOML 字面量>` 注入。给了 `env` 就**不继承** `process.env`，必须自带完整环境。
- `CODEX_HOME` 的位置受可执行文件位置约束：可执行文件在工作区内时，`$CODEX_HOME` 也必须落在工作区内，否则进程起不来；可执行文件在工作区外时任意位置都行。scratch 目录（`TMPDIR` / `TEMP` / `TMP`）不要用系统临时目录。
- 模型 provider 的 `wire_api` **只有 `responses` 一个合法值**，写成 `chat` 会在启动阶段失败。

**步骤 2｜解析事件流**
- 事件类型共 **8 种**，由 SDK 声明的联合给出：`thread.started`（拿 `thread_id`）、`turn.started`、`item.started`、`item.updated`、`item.completed`、`turn.completed`、`turn.failed`、`error`。
- item 类型也是 **8 种**，由 SDK 声明的联合给出：`agent_message`（`text` 是正文）、`reasoning`（`text` 是**推理摘要**，不是正文）、`command_execution`（`command` / `aggregated_output` / 运行中省略的 `exit_code` / `status`）、`file_change`（`changes[]{path, kind}` / `status`）、`mcp_tool_call`（`server` / `tool` / `arguments` / `result` / `error` / `status`）、`web_search`（`query`）、`todo_list`（`items[]{text, completed}`）、`error`（`message`）。
- 多智能体的 `collab_tool_call` 会出现在事件流里，但**不在** SDK 声明的联合内（形状见步骤 5）。
- item 级 `error` 是**非致命告警**（例如"有无法识别的配置项"），不得当成运行失败；失败只认顶层的 `error` / `turn.failed`。
- **事件流不带时间戳**，也不带工具真名：命令类 item 只有 `command` 文本（工具真名 `exec_command` 只在会话文件里）⇒ 时间与工具真名都要从会话文件补。

**步骤 3｜读会话文件**
- 路径：`$CODEX_HOME/sessions/<年>/<月>/<日>/rollout-<ISO 时间>-<线程id>.jsonl`。
- 查找方式：在 `sessions/` 下按**文件名末尾的线程 id** 匹配，不要按日期目录推算（跨午夜会找错目录）。
- 逐行 JSON，外层 `type` 是 `session_meta` / `response_item` / `event_msg`，语义由内层 `payload.type` 决定。
- 行内另有 `timestamp`（ISO 8601）、`ordinal`、`turn_id` 三格；`turn_id` 是厂商轮的稳定标识（外层优先、内层兜底）。
- 第一条必是 `session_meta`：`id`（本线程 id，与文件名末段同值）、`parent_thread_id`（主线程为 `null`）、`source.subagent.thread_spawn.{parent_thread_id, depth, agent_nickname}`。
- 解析要容错：坏行跳过但计数，计数是"厂商换了行格式"的唯一早期信号。

**步骤 4｜补思考正文**
- 从 `payload.type === 'reasoning'` 的记录取 `content[].reasoning_text`，这是完整推理正文。
- `summary` 通常是空数组，**不要拿它当正文**；`content` 为空（只有 `encrypted_content`）时正文记 `null`。
- 因为来源是会话文件，这些块的 `source` 记 `'session-file'`。

**步骤 5｜子任务**
- 从事件流 `collab_tool_call.receiver_thread_ids` 拿**子线程 id**；`prompt` 是派发任务原文。
- 用子线程 id 定位子会话文件，读出子智能体的完整轨迹：`message`（`role` + 正文块 `input_text` / `output_text`）、`function_call`（工具**真名**在 `name`，入参是 **JSON 字符串**形态的 `arguments`，要自己解析）、`function_call_output`（按 `call_id` 与调用配对）、`reasoning`（正文）。
- 父子链路：子会话文件的 `session_meta.parent_thread_id` 给父线程，`thread_spawn.parent_thread_id` / `thread_spawn.depth` 给嵌套父链与深度，`thread_spawn.agent_nickname` 给名称。
- 终态与答复：hook 回调给 `agent_id` / `agent_type` / `last_assistant_message`（**hook 载荷没有 status 字段**）；状态从事件流补——`collab_tool_call.agents_states` 是**以子线程 id 为键的对象**，取 `agents_states[<子线程 id>].status`（同格 `message` 是该子智能体的最终答复），取不到时用 `statusMissing` 标注。
- 一次运行结束后读一次会话文件即可：运行期只有派发事件与 `agents_states` 状态，没有实时子任务轨迹。

**步骤 6｜计量**
- 事件流 `turn.completed.usage` 的字段集是五个：`input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` / `output_tokens` / `reasoning_output_tokens`；**没有 `total_tokens`**——总量只在会话文件 `event_msg.token_count.info.total_token_usage` 里 ⇒ `total` 一格从会话文件取，取不到记 `null`。
- SDK 会把**缺失**的 `cache_write_input_tokens` 补成 `0`，所以该格为 `0` 不等于"厂商报过 0"；本仓不消费这一格。
- **`input` 必须减去 `cached_input_tokens`**（`input_tokens` 含缓存读，`cached_input_tokens` 是它的明细），否则命中率会系统性低估。
- 时间只能从会话文件行 `timestamp` 的首末两点算跨度，标 `'events'`；`apiMs` 与 `ttftMs` 保持 `null`，不要用跨度顶替。
- 子任务级用量取子会话文件的 `event_msg.token_count.info.total_token_usage` / `last_token_usage`（含 `reasoning_output_tokens` / `total_tokens`）。

**步骤 7｜工具族与已知限制**
- 当前模型预设的工具表（`exec_command` / `write_stdin` / `request_user_input` / `view_image` / 多智能体命名空间 / `get_goal` / `create_goal` / `update_goal` / `web_search`）里没有文件读写类工具：`read-file` / `write-file` / `edit-file` / `search-content` / `list-files` **五族取不到值**，文件改动经 `exec_command` 承载（落在 `run-shell` 族）。该点随模型预设变化，实现按工具名归族即可，不要写死"这家没有文件工具"。
- 联网工具在本仓配置里被关掉（`tools.web_search=false`）⇒ `web-search` 族同样取不到值。
- 工具真名（`exec_command` / `spawn_agent` / `wait_agent` 等）只在会话文件里；事件流只有派生**条目名**（`command_execution`、`collab_tool_call`），不要把它当工具名。
- `request_user_input` 在 exec 路径不可用：它出现在工具表里，但调用会被拒 ⇒ 该族记 `outcome: 'unavailable'`。
- 规划工具 `update_plan` 需要显式开启（`tools.update_plan.enabled=true`）才出现在工具表；它在事件流里落成 `todo_list` 条目，载荷是 `{ text, completed }` **二态**，恢复不出 `in_progress`，该态一律 `unknown`。

**步骤 8｜多智能体开关**
- 需要显式打开多智能体特性（`features.multi_agent=true`；写在 `tools.` 前缀下会被忽略）；关掉时多智能体命名空间工具不注册、子任务面恒空。**在会拒绝命名空间工具的路由上必须保持关闭**（例如带工具列表即被拒的自建网关路由）⇒ 该能力随路由翻转，能力声明要带路由前提。
- 能力随路由翻转：同一条 `spawn_agent` 调用，某些自建网关路由会判 `unsupported call`，带工具列表的请求也可能被网关拒绝；另一条路由上同一条派发链可以完整跑通（`spawn_agent` → `wait` → `close_agent`，子线程有真实答复）。**模型名是否被该版本认识不是决定因素**（两条路由都可能落到回退元数据），决定因素未定位。
- ⇒ 必须把路由与模型名记为能力声明的前提：同一份能力位在不同路由下取值不同，不得把某一条路由上的取值写成这家的固有属性。

### 4.3 dsh

**步骤 1｜建会话**
- 用 Harness 类建会话并订阅通知；协议类型（openai 兼容 / anthropic 兼容）与模型在路由配置里给。
- 通知共四种 method：`session.event`（具体事件）、`session.status`（会话级状态）、`subagent.started`、`subagent.finished`。前两种的 `params.sessionId` 标出事件属于哪个会话——**子会话的事件也在同一条流里**，带的是子会话自己的 id；后两种是顶层通知，不套在 `session.event` 里。

**步骤 2｜块协议**
- 流式片段挂在 `assistant/message` 的 `data.stream[]` 里，条目两种形态：
  - `{ type: 'chunk', time, chunk }`：单条底层 chunk，按 `chunk.type` 分流——`block-start`（带 `index` / `blockType`）、`text-delta`、`reasoning-delta`、`tool-call-delta`（带 `id` / `name?` / `argumentsDelta`）、`block-end`（带整块 `block`）、`usage`（带 `usage`）、`finish`（带 `reason`，可选 `replayState`）。会话日志把外层 `type` 与内层 `chunk.type` 合写成 `chunk:block-start` / `chunk:usage` 这类名字，代码里要按 `type` 与 `chunk.type` 两级判定。
  - `{ type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks', time0, index, dt[], texts[] / args[] }`：同一个块的多个片段打包成一条——正文在 `texts[]`、工具入参在 `args[]`，是逐条 `*-delta` 的批形态。
- 一次模型输出的顺序：`block-start` →（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）→ `block-end` → `usage` → `finish`；一个往返可以有多个块，`index` 标识是哪一个。
- 累积规则：按 `index` 把片段追加到当前块（文本拼 `texts`，工具入参拼 `args` / `argumentsDelta`），`block-end` 的 `chunk.block` 是该块的**完整快照**，可直接覆盖累积结果。
- **思考没有增量可用**：底层类型里有 `reasoning-delta`，但本路由运行时不产出它，推理文本整块在 `block-end` 到达 ⇒ 思考按整块渲染，不要等逐字增量；主任务与子任务同理。

**步骤 3｜归一消息**
- `assistant/message`：`data.message.content[]` 给块，`data.usage` 给该次往返用量，`data.turn` / `data.step` 给厂商轮号与步骤号。
- `tool/call` 给 `callId` / `name` / `arguments`（`arguments` 是 **JSON 字符串**，要自己解析）；`tool/result` 给 `message.{toolCallId, content[], isError}`，另有 `error?` 与 **`meta`**——**结构化结果在 `meta` 里**（`content[]` 只是给模型看的那份文本）。
- 块类型是 `reasoning` / `text` / `tool-call`，且 `reasoning` 块**也带 `text` 字段** ⇒ 取值必须先按 `type` 过滤，绝不按 `text` 字段取值（否则推理正文会混进最终答复）。

**步骤 4｜子任务**
- 两条通知的载荷不同：`subagent.started` 只给 `parentSessionId` / `childSessionId`（**没有 `agentId`**）；`subagent.finished` 给 `provider` / `agentId` / `parentSessionId` / `childSessionId` / `status` / `stopReason` / `lastAssistantMessage?`——身份取 `agentId`（与 `childSessionId` 同值），收场之前只能用 `childSessionId` 认人。
- 任务名与运行方式在另一条会话事件 `subagent/catalog` 里：`childId` / `createdAt` / `mode`（`one-shot` / `continuable`）/ `label?`；**`provider` 不在 catalog 里**，只在 `subagent.finished` 上。catalog 可能先于 start / finish 到达，要按 `childId` 记住，否则收场时名字只能填 `null`。
- **终态用两格合读的映射表**（`status` × `stopReason`）：`ok`+`completed` ⇒ `completed`；`ok`+`max-tokens` ⇒ `failed`（字面"成功"实为被输出上限截断）；`error`+`aborted` ⇒ `stopped`（字面"失败"实为主动取消）；`error`+`error` ⇒ `failed`；其余组合（含未观测的 `refusal`）⇒ `unknown` + `statusMissing: 'unverified'`，**不猜**。
- 结果摘要取 `subagent.finished` 载荷里 `lastAssistantMessage` 的 `type='text'` 块；取消场景可能只有 `reasoning` 块，此时 `outcome` 保持 `null`，不得拿推理顶替。
- 子智能体轨迹直接从通知流里取（`params.sessionId` = 子会话 id）；子任务级用量按 `params.sessionId` 把子会话的 `assistant/message.data.usage` 分组求和（那是子会话自己的往返用量）。
- 运行时被强制终止时不会收到 `subagent.finished` ⇒ 面板必须能显示"未收场"。
- 归属键没有工具调用 id，只有会话 id 层级；跨家比较时不要把它当"调用级"归属。

**步骤 5｜容错与状态**
- 权限与审批类事件（`approval/asked`、`approval/decided`、`approval/policy`、`permission/preset`、`sandbox/mode`）至少投影成 `log` 行，不要静默丢弃：无人值守的运行里审批不会被应答，这些行是排障的唯一线索。
- 任何未识别的事件也要投影成一条 `log`，保留原始载荷。

**步骤 6｜计量**
- 用量在 `assistant/message` 的 `data.usage`：`inputTokens`（**不含**缓存，直接当 `input`）/ `cacheReadTokens`（当 `cached`）/ `outputTokens`（当 `output`，已含思考量）/ `totalTokens`（厂商自报总量，只作参考，不参与归一后的加和）。
- `cacheWriteTokens` 不进 `cached`：缓存**写**不是缓存**读**，把它算进命中率会得出"第一轮就命中"的假象。
- `reasoningTokens` 在类型上存在但当前通道不写这一格 ⇒ 记 `null`（该格能力位记 `not-projected-by-vendor`），不要用 `outputTokens` 去凑。
- 时间从会话事件的 `time`（毫秒）算，标 `'events'`。

**步骤 7｜工具族与路由 patch**
- 工具表约 25 项；五类文件工具（`read` / `write` / `edit` / `grep` / `glob`）都有结构化结果，落在 `tool/result` 的 `meta` 里：`read` 给 `{lines[], totalLines}`、`grep` 给 `{shape:'matches', files[], total, truncated}`、`glob` 给 `{shape:'paths', paths[], truncated}`、`write` 给 `{operation, diffs[]}`、`edit` 给 `{diffs[{path, oldText, newText}]}`。**写文件的字节数拿不到**，`edit` 的替换处数也拿不到 ⇒ 这两格保持 `null`；有 `meta` 就不要退回去解析文本。
- `pwsh` 的结果**没有 `meta`**：退出码只在文本尾部的 `[exit code: N]` 里，成功时不带这个尾部 ⇒ 该格保持 `null`，不要填 0。
- 关闭联网工具时，路由 patch 是**整份替换**语义：只写要改的那一格会把同组的其它键抹掉，随后被 schema 默认值悄悄改回。必须把该组的全部键一次写全。

**步骤 8｜交互**
- `ask_user_question` 可用；无人应答时工具结果 `isError` 为真，文本形如 `Error: no user-questions answerer accepted the request` ⇒ 该族记 `outcome: 'unavailable'`，不要当成用户拒绝。子智能体内不可发起提问（该限制在另两家同样成立），调用会被拒并给出说明调用方归另一个智能体所有的文案。

---

## 5. 工具族与面板投影

### 5.1 分族规则

族名由**工具名**决定，不由家决定。归不进任何一族的工具，`family` 记 `null`，并在 `name` 里保留原名（消费方对 `null` 走通用渲染）。

| 族 | 命中条件 | 归一入参 | 归一结果 |
|---|---|---|---|
| `read-file` | 读单个文件 | `path`、可选 `offset`/`limit` | `totalLines`（有则填）、正文 |
| `write-file` | 新建/整体写入 | `path`、`content` | `bytesWritten`（拿不到则 `null`） |
| `edit-file` | 局部替换 | `path`、`oldText`、`newText` | 替换处数（拿不到则 `null`；整体替换模式下数量不可知） |
| `search-content` | 内容检索 | `pattern`、可选 `path`/`glob` | 命中条目数组 |
| `list-files` | 文件名匹配/列目录 | `pattern` 或 `path` | 路径数组、可选 `truncated` |
| `run-shell` | 执行命令 | `command`、可选 `shell`/`cwd` | `exitCode`（拿不到则 `null`）、`stdout`、`stderr`、`truncated` |
| `web-search` | 联网检索 | `query` | 结果条目 |
| `spawn-agent` | 派发子智能体 | `prompt`、可选 `name`/`background` | 子任务身份 |
| `task` | 进度清单维护 | 整表替换或逐条 patch | `steps[]`（`{id, subject, status, owner?, blockedBy?}`） |
| `ask-user` | 向用户提问 | `questions[]` | `answers`；结构性不可用时记 `outcome: 'unavailable'` |

归一结果里取不到的格一律记 `null`，不得用 0 或空串顶替。唯一例外是 `truncated`：契约里它是布尔，拿不到截断标记时只能记 `false`，消费方**不得**据此断定输出完整。

### 5.2 三家工具名 → 族

| 族 | claude-code | codex | dsh |
|---|---|---|---|
| `read-file` | `Read` | — | `read` |
| `write-file` | `Write` | — | `write` |
| `edit-file` | `Edit`、`MultiEdit` | — | `edit` |
| `search-content` | `Grep` | — | `grep` |
| `list-files` | `Glob`、`LS` | — | `glob` |
| `run-shell` | `Bash`、`PowerShell` | `exec_command`（工具真名，只在会话文件）/ `command_execution`（事件流里的命令**条目**名，不是工具名） | `pwsh`/`shell` 类 |
| `web-search` | `WebSearch`、`WebFetch` | `web_search` | `web_search`、`web_fetch` |
| `spawn-agent` | `Task` / `Agent`（**同一工具的两种叫法**，谁叫哪个随模型与工具表档位变；两个名字都映射到本族） | `spawn_agent` | `subagent`、`subagent_fork` |
| `task` | `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` 或 `TodoWrite` | `update_plan`（工具；在事件流里落成 `todo_list` 条目） | `todo_write` |
| `ask-user` | `AskUserQuestion` | `request_user_input`（在工具表里但调用被拒） | `ask_user_question` |

codex 的 `family` 判定补充：事件流的 `command_execution` 条目一律落 `run-shell`（该条目的 `aggregated_output` 是 stdout 与 stderr **合流**，拆不开 ⇒ 归一结果里 `stderr` 记 `null`；`exit_code` 在运行中省略 ⇒ 记 `null`）；文件类五族在 codex 上取不到值（当前模型预设没有这些工具，文件改动经 `exec_command` 承载）。`collab_tool_call` 落 `spawn-agent`；其余条目与工具（`write_stdin` / `view_image` / `wait_agent` / `close_agent` / `send_input` / `resume_agent` / `get_goal` / `create_goal` / `update_goal`）不属这十族 ⇒ `family` 记 `null`，`name` 保留原名。

**名字是否出现由各家的配置与模型决定，不影响映射本身**：

- claude-code：`MultiEdit`、`LS`、`PowerShell` 在**当前工具表里不出现**（保留映射以兼容工具表变化，不表示当前会出现）；`Task*` 与 `TodoWrite` 二选一（设 `CLAUDE_CODE_ENABLE_TASKS=0` 时才换成 `TodoWrite`）；`AskUserQuestion` 要注册 `canUseTool` 回调才出现；`WebSearch` 只在本行模型名含 `claude` 时保留（其余模型被禁用），`WebFetch` 不受此限。
- codex：`update_plan` 需显式开启（`tools.update_plan.enabled=true`）才出现在工具表；`web_search` 在本仓配置里被关掉（`tools.web_search=false`）；`request_user_input` 在工具表里但调用被拒；多智能体命名空间需 `features.multi_agent=true`。
- dsh：`web_search` / `web_fetch` 是否可用取决于该行的路由 patch（关闭联网工具时是整组键的替换语义：只写要改的那一格会把同组其它键抹掉）。

### 5.3 `task` 族的合并语义

三家的更新语义不同，必须由适配器统一成**整表**再交给消费方：

| 家 | 更新语义 | 适配器做法 |
|---|---|---|
| claude-code | 逐条 patch（`TaskUpdate` 传 `taskId` + 单个字段） | 维护 `taskId → step` 映射，累积成整表；`status: 'deleted'` 表示移除 |
| codex | 整表替换 | 直接替换；载荷是 `{ text, completed }` **二态**，缺 `in_progress`；条目**没有 id** ⇒ `steps[].id` 只能按整表序号生成，不得当跨快照匹配的稳定键 |
| dsh | 整表替换 | 直接替换；结果只给摘要句，**入参才是数据源** |

状态三种取值：`pending` / `in_progress` / `completed`；codex 恢复不出 `in_progress` 时填 `unknown`，不要猜成 `pending`。`unknown` 是第四种显示值（不是三态之一），面板必须能显示它。

### 5.4 面板①：进度清单

- 数据来源：`task` 族的整表快照（claude-code 由适配器把逐条 patch 累积成整表，codex 与 dsh 直接给整表）。
- 渲染：按 `status` 分组——`pending` / `in_progress` / `completed` 各一组，**外加 `unknown` 一组**（codex 的条目只有 `{text, completed}` 二态，`unknown` 不得并入任何三态组）。
- `owner` / `blockedBy` 有则显示（仅 claude-code 提供）；codex 的条目没有 `id`，`steps[].id` 是按序号生成的显示用编号，不要当稳定键。
- 缺失处理：本次运行没有任何 `task` 族调用 ⇒ 面板显示"未使用进度清单"，不要显示空表头。

### 5.5 面板②：派发视图

每个子任务一行。每格的取值路径：

| 字段 | claude-code | codex | dsh |
|---|---|---|---|
| `subagentId` | `task_started.task_id` | 子线程 id（`collab_tool_call.receiver_thread_ids` 的元素，与会话文件名末段同值） | `subagent.finished.agentId`（收场前用 `childSessionId`） |
| `name` | `task_started.description` | hook `SubagentStart.prompt` 首行；或子会话文件里 `spawn_agent` 的入参 | catalog `label` |
| `kind` | `task_started.subagent_type` | `collab_tool_call.tool`（如 `spawn_agent`） | catalog `mode` / `provider` |
| `status` | `task_notification.status`（还没收到通知时记 `running`） | `agents_states[<子线程 id>].status`，取不到置 `statusMissing` | `status` 与 `stopReason` 两格合读：`stopReason !== 'completed'` 时不得报 `completed` |
| `outcome` | `task_notification.summary` | hook `SubagentStop.last_assistant_message`；或事件流 `agents_states[<子线程 id>].message`；或子会话文件里子智能体的 `assistant` 消息（三处任一有值即可，都没有则 `null`） | `subagent.finished` 载荷里 `type='text'` 的块（取消时可能没有 ⇒ `null`） |
| `usage` | `task_notification.usage` | 子会话文件 `event_msg.token_count.info.total_token_usage` / `last_token_usage` | 子会话 `assistant/message` 的用量按 `sessionId` 分组求和 |
| `parentSubagentId` | `null`（只有 `spawn_depth`，没有父 id） | 子会话文件 `session_meta.parent_thread_id`（`thread_spawn.depth` 给深度） | 由 `parentSessionId` 是否等于主会话判定 |
| 轨迹 | 子智能体消息直接出现在主流里（带 `parent_tool_use_id`） | 只能读子线程会话文件（消息、工具调用、推理），运行结束后才有 | 子会话事件在同一条通知流里（`params.sessionId` = 子会话 id） |

渲染要求：

- **身份**用 `subagentId`；名称缺失时显示身份前 8 位，不要显示 `null`。
- **状态**取值固定为六种：`running` / `completed` / `failed` / `stopped` / `unknown` / `未收场`；厂商原始状态先归一到这六种再进面板。`statusMissing` **非 `null`** 时显示"状态未采集"，同时显示最后一次状态快照（`null` = 状态已采集）。
- **轨迹**：codex 的子智能体轨迹来自子会话文件（消息、工具调用、推理），运行结束后才有；运行期只显示派发事件与状态。
- **层级**：父链可得时缩进显示；父链不可得时全部平铺，不要用"派发顺序"推测层级。

---

## 6. 流式与合并规则

### 6.1 两种块形态

- `'delta'`：该块的增量片段，消费方**必须按块累积**。只有两家产出：dsh（`text-chunks` / `reasoning-chunks` / `tool-call-chunks`）与开启 `includePartialMessages` 的 claude-code（`content_block_delta`），且 claude-code 的增量**只覆盖主会话**；codex 恒 `'snapshot'`。
- `'snapshot'`：该块的当前完整内容，可**直接覆盖**同键块。三家都会产出，且每个块最终都会到一个 snapshot——dsh 在 `chunk:block-end`、claude-code 在流式事件之后仍会再到的完整 assistant 消息上、codex 的条目本身就是快照；只有进程被中断的块例外。
- 同一个块可以既有 delta 又有 snapshot：delta 用于实时打字，snapshot 是落盘与抽屉的真相。**消费方只实现 snapshot 也能正确渲染**（把 delta 当作可选的实时增强，因为快照一定在块结束时到达）。

### 6.2 覆盖合并算法

合并键：`(subagentId ?? 'main', roundTrip, 载体, 块标识)`。

| 分量 | 取值 |
|---|---|
| `载体` | 该块所属消息的 `role` 与 `parentCallId`。同一轮里 assistant 消息与工具结果消息各自从 0 起算块序号，只带 `blockIndex` 会把工具结果盖到正文块上 |
| `块标识` | 文本块与思考块用 `blockIndex`（该逻辑消息内的序号，按首次到达顺序分配，一经分配不再变化）；工具调用块与工具结果块用 `callId`（同轮多次调用因此互不覆盖） |

1. 收到 `delta`：把片段追加到该键的累积缓冲区，渲染时显示缓冲区内容。
2. 收到 `snapshot`：用其内容**覆盖**该键的缓冲区与最终内容。
3. 收到同一键的多个 `snapshot`（claude-code 把同一个 `message.id` 分多次投递，每次只带一个块）：**后者覆盖前者**，不追加、不拼接。
4. 新块只能追加到末尾：块序号与 `callId` 一经确定不再变化。**消息信封的 `mergeKey` 就是这条规则的可执行形式**，消费方按它覆盖累积，再在键内按数组下标（= 块序号）或 `callId` 合并到块一级。
5. 合并键不含 `messageId`：同一个块的 delta 与 snapshot 是两条消息，配对只靠上面的键。

### 6.3 顺序与容错

- 事件 `seq` 单调递增；消费方按 `seq` 去重，断线后按 `Last-Event-ID` 语义续订。
- 允许不同块之间乱序到达：合并只依赖合并键，不依赖块与块之间的到达顺序。
- 同一个键上，`delta` 必须先于 `snapshot`（同一家的同一条流内有序）。`snapshot` 之后到达的同键 `delta` **丢弃**、不追加——快照按定义已含它之前的内容，追加会把这一块写重。
- 缺失 `snapshot` 的块（进程中断）保持最后一次 delta 累积值，并由消息上的 `assembly` 标成 `'open'`。**不要**用 `truncated` 表达这件事：那是 `tool-result` 块自己的字段（结果文本有没有被截断），文本块与消息都没有这一格。

---

## 7. 缺失影响矩阵

"谁缺什么、影响什么"是本文最需要被消费方读到的一节。每一条缺失都要落到能力声明的某一格上，写清它属于五态中的哪一种（`yes` / `no` / `unverified` / `off-by-adapter` / `not-projected-by-vendor`），并配一条缺失原因（`no` 配 `not-supported`、`not-projected-by-vendor` 配 `not-exposed`、`off-by-adapter` 配 `not-observed`、`unverified` 配 `unverified`）。**不得**用 0、空串或省略字段代替。

### 7.1 claude-code

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `vendorTurn`、`step` | 厂商无此字段 | 只有 dsh 能给出厂商轮号与步骤号；跨家比较这两个量没有基准 | 恒 `null`，不显示"0"或"1" |
| 嵌套父链 | 载荷里没有父 id | 深度 ≥2 时父子关系建不起来 | 平铺显示或用 `spawn_depth` 表达层级，不要推测父节点 |
| `Bash` 成功时的退出码 | 无结构化字段 | 成功路径的退出码恒 `null` | 显示"未采集"，不要显示"0 = 成功" |
| 子智能体的 token 级增量 | 不投送（只发主会话） | 子任务只有整块内容，无实时打字 | 子任务视图不做逐字动画 |
| 子智能体的文本与思考块 | 默认**不转发**（默认只投工具调用与工具结果块） | 不开开关时子任务视图只剩工具流水，看不到子智能体自己说的话 | 需要完整嵌套轨迹时显式开启转发子智能体文本与思考块的选项；不开启时如实说明"该子任务的对话未转发" |
| `thinking_tokens` 缺失或为 0 | 后端不返回这一格时字段缺失；返回 0 时无法区分"这次没有推理"与"这条后端不上报" | 不能判断"这家不思考" | 缺失记 `null`；读到 0 照实记 0，但不得据此断言"这家不思考" |
| SDK 路径下的 shell | **环境边界，不是厂商能力**：claude.exe 自身的工具沙箱拒绝工具级建目录（`EPERM`），同一份二进制由 CLI 直跑时不受影响 | SDK 路径下 shell 类观测在本机拿不到真实结果，`Bash` / `PowerShell` 的结果为空或报错 | 该族结果为空时标"环境不可用"，不要标"没有执行"，也不要写成"这家不能跑 shell" |

### 7.2 codex

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| 文件类五族 | 当前模型预设的工具表里没有这五类工具（随预设变化，不是"这家没有"） | 文件读写改搜列的统计对 codex 失真 | `family` 为 `null` 时走通用渲染；跨家统计标注"本次运行不适用"，不要写成"这家不支持" |
| `step`、`vendorTurn` | 厂商无此字段 | 这家给不出厂商轮号与步骤号，跨家比较这两个量没有基准 | 恒 `null`，不要填 0 或 1 |
| `parentCallId` | 子智能体不产出消息，字段无载体 | 无法把子任务挂到"哪次调用派生的" | 用子线程 id 建线程级父子关系 |
| 事件流里的 `role` | 事件流没有 role 概念 | `role` 是派生值 | 不要当厂商原生字段用 |
| 事件流的时间 | 事件流不带时间戳 | tok/s 的分母含工具执行时间 | 展示 tok/s 时标注"墙钟"，不与厂商计时混排 |
| `thinking` 的 `signature` | 厂商条目里没有该字段（会话文件只给 `encrypted_content` 密文，不解析） | 无法校验思考块完整性 | 恒 `null` |
| 流式增量 | 事件流无 delta | 无实时打字 | 不做逐字动画 |
| `ask-user` | exec 路径结构性不可用 | 交互族恒空 | 记 `outcome: 'unavailable'` |
| 多智能体与思考 token | 多智能体随路由翻转；`reasoning_output_tokens` 字段存在但取值为 0 | 同一家的能力在不同路由下不同；思考 token 为 0 时无法区分"这次没有推理"与"这条路由不上报" | 能力声明必须带路由前提；缺值时不要回落成"这家没有"；思考 token 该格记 `unverified`，也不要把 0 断成"这家不思考" |
| `in_progress` 态 | 事件流的载荷只有 `{ text, completed }` 二态（`in_progress` 只出现在工具入参里） | 从事件流重建进度面板时无法区分"进行中"与"未开始" | 该态显示 `unknown`，不要猜成 `pending` |

### 7.3 dsh

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `reasoningTokens` | 通道不投送（本条路由的用量映射不写这一格） | 思考**计量**跨家只有两家有值；思考**内容**不受影响 | 该格记 `not-projected-by-vendor` + 缺失原因 `not-exposed`；跨家求和不含它 |
| 子任务级用量不在子任务通知里 | `subagent.started` / `subagent.finished` 不带用量 | 子任务级用量要按子会话分组求和才拿得到 | 用子会话的 `assistant/message.usage` 按 `sessionId` 分组求和，`source` 记 `'wire'`（子会话事件与主会话同一条通知流） |
| 取消时的结果文本 | 可能没有 text 块 | `outcome` 为空 | 保持 `null`，不要用状态文本顶替 |
| `stopReason` 的部分档位 | 厂商值域有五档（`completed` / `aborted` / `error` / `max-tokens` / `refusal`），其中 `error` 与 `refusal` 没有可核对的映射依据 | 状态映射表可能漏档 | 未覆盖档记 `unknown` + 缺失原因 `unverified`（`statusMissing` 非空），不得猜 |
| 收场事件 | 强杀时没有 finished | 面板会缺一行终态 | 必须支持"未收场"显示 |
| 工具调用级归属 | 只有会话 id 层级 | 归属粒度比另两家粗 | 跨家比较归属时标注粒度差异 |

### 7.4 三家共同

| 缺什么 | 缺失性质 | 影响 | 消费方义务 |
|---|---|---|---|
| `web-search` 族数据 | 多数配置下取不到：codex 关掉 `web_search`；dsh 的搜索后端缺凭据（`web_search` 必失败，`web_fetch` 仍可用）；claude 只在非 Claude 模型上摘掉 `WebSearch` | 该族整体为空或全是失败结果 | 显示"未启用联网"或"联网不可用"，**不得**显示"三家都没搜" |
| 思考块的 `signature` | 有意不进呈现（claude-code 有值，codex 与 dsh 恒 `null`） | 无用户可见影响 | 只在审计视图出现，正文与导出都不显示 |
| 子智能体内的提问 | 三家一致不支持 | 子任务不能向用户提问 | 子任务视图不渲染提问入口 |

---

## 8. 配置面

### 8.1 必须写死的配置

| 家 | 配置 | 值 | 原因 |
|---|---|---|---|
| claude-code | `includePartialMessages` | `true` | 否则消息流里没有 `stream_event`，`streamingDelta` 能力位为 `no` |
| claude-code | 规划工具开启 | `tools` 数组列出 / `allowedTools` 点名 / `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 三选一 | 按模型门控，不显式开启会没有进度数据 |
| claude-code | `CLAUDE_CODE_ENABLE_TASKS` | `0`（可选） | 官方口径是改回 `TodoWrite`；新模型上未必生效，进度数据可能因此为空 |
| claude-code | `canUseTool` 回调 | 需要交互时注册 | 不注册则 `AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode` 都不出现在工具表里 |
| claude-code | `settingSources` | `['user', 'project', 'local']` | 读得到被测仓库的 `CLAUDE.md` 与项目配置；`[]` 会把它们一起挡掉 |
| claude-code | `settings.env` | 与本次路由同值的 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 打开 `project` 档后，仓库自带的 `.claude/settings.json` 的 `env` 会盖掉本次路由；这一档优先级更高，把它钉回去。与 `settingSources` **成对**给 |
| codex | 驱动方式 | `@openai/codex-sdk`：`new Codex({ apiKey, baseUrl, config, env })` → `startThread({ model, workingDirectory, sandboxMode, approvalPolicy, skipGitRepoCheck })` → `runStreamed(prompt)` | 不经裸 CLI 手拼 argv；SDK 用自带的可执行文件以 `exec --experimental-json` 收发 JSONL，`env` 是替换型（要自己展开宿主环境） |
| codex | `wire_api` | `responses` | 唯一合法值，写别的在配置校验阶段就失败 |
| codex | `CODEX_HOME` | 与 SDK 自带的 exe 同区：exe 在工作区内时，它也必须落在工作区内 | 跨区会启动失败 |
| codex | 多智能体 | `features.multi_agent = true`；模型预设的 `model_messages.multi_agent` 必须有值 | 写在 `tools.` 前缀下会被 CLI 忽略；模型预设没有这一格时 `spawn_agent` 被拒为 `unsupported call`，子任务面为空 |
| codex | `tools.update_plan.enabled` | `true` | 默认关闭，不开启则工具表里没有 `update_plan`，没有进度数据 |
| dsh | 子进程环境 | 显式删除 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL` | 宿主凭据被继承时，不用的 `deepseek-official` 路由会静默可用并真实发请求 |
| dsh | 路由 patch（`- id: <插件 id>`） | 该行的 `config` **整份写出**，不做深合并 | 只写要改的那一格会抹掉同组其它键，随后被插件 schema 的默认值改回 |
| dsh | 联网工具的关闭 | `tool-web` 的 `search` / `fetch` / `searchTimeoutMs` 三格一次写全 | 只写 `search: false` ⇒ `fetch` 回到默认 `true`，`searchTimeoutMs` 静默从 60000 变 30000 |

### 8.2 必须规避

| 家 | 不要做什么 | 后果 |
|---|---|---|
| claude-code | 依赖自动放行模式（`bypassPermissions` / `acceptEdits`）同时期望收到提问 | 调用在回调之前就被解决，`canUseTool` 不触发，提问被静默跳过 |
| claude-code | 用 `tools` 数组限制能力却不列出需要的工具 | 该工具直接从工具表消失 |
| codex | exe 在工作区内时，把 `CODEX_HOME` 放到工作区外（例如系统临时目录） | 启动即失败（`os error 5`） |
| codex | 在只支持部分能力的网关路由上开启多智能体 | `spawn_agent` 被拒为 `unsupported call`；带工具列表的请求可能被整体拒绝 |
| codex | 把事件流的近似条目计数当厂商轮号，或当跨家可比的往返数 | 该计数系统性偏高，跨家比较失真 |
| dsh | 把宿主的 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 留在子进程环境里 | 不用的 `deepseek-official` 路由静默可用并按公网地址真实计费；`web_search` 也会拿它去打搜索接口 |
| dsh | patch 里只写要改的那一个键 | 同组其它键被抹掉，再被 schema 默认值改回（`searchTimeoutMs` 静默从 60000 变 30000） |
| 三家 | 用 0 或空串表达"未采集" | 下游无法区分"没有"与"没采到" |

---

## 9. 落地清单

按实施顺序排列；每步都有可独立验证的产出。

| 序 | 改动面 | 产出 |
|---|---|---|
| 1 | 契约包：消息信封、内容块、行级事件、计量结构、能力声明 | 类型与校验 schema 可被消费方引用 |
| 2 | 适配器公共层：覆盖合并、增量累积、块序号分配、`seq` 分配、工具归族、缺失表达工具函数 | 合并与缺失语义只有一份实现，三家适配器都调它 |
| 3 | 适配器骨架接线：`onMessage` / `onSubagent` 两条回调与 `TurnProjection.messages` / `.subagents` 承载面 | 一家产出的消息与子任务行走同一套合并与发射 |
| 4 | claude-code 适配器：建会话与路由注入 → 消息归一 → 流式 → 子任务 → 规划数据 → 计量 → 工具族 → 交互 | 该家全字段可产出 |
| 5 | codex 适配器：SDK 启动与 `CODEX_HOME` → 事件流解析 → 会话文件读取（思考/子任务/计量）→ 消息与子任务行 → 多智能体与规划开关 → 工具族 | 该家全字段可产出 |
| 6 | dsh 适配器：建会话与路由 patch → 块协议 → 消息归一 → 子任务两格读状态 → 计量 → 工具族 → 交互 → 未识别事件的容错投影 | 该家全字段可产出 |
| 7 | **三端一致性验证**：同一场景三家归一结果逐字段相等（纯文本、shell 调用与结果、思考档位、工具归族、缺失表达） | 三家产出的形状差异只剩「这一家结构上没有」的那几格 |
| 8 | 落盘与推送：`messages.jsonl`（消息与子任务行**一条流**）+ 进程内订阅；每次尝试开始时清空；`GET .../rows/<rowId>/messages`（折叠视图）与 `.../messages/stream`（SSE）| 对话视图与派发面板有唯一真相源，刷新与实时两条路径同源 |
| 9 | 投影层：10 个工具族 + 2 张面板 | 两张面板的数据可渲染（含各类缺失态） |
| 10 | 派生指标：缓存命中率、tok/s、首字延迟（唯一一份实现） | 界面与导出共用同一套算法 |
| 11 | 能力声明与缺失表达接线 | 缺数据时界面显示"未采集"而非 0；声明与实测行为由守卫对齐 |
| 12 | 配置面固化：三家开关与路由前提逐条落进适配器 | 每条开关都有唯一的写入点，能力声明随之带出路由前提 |

**落盘格式与消费口径**（第 8 步的细则）：

- 文件名 `messages.jsonl`，与 `events.jsonl` 同行目录、**互不合并**：事件按 `seq` 去重与续订（行级），
  记录按 `mergeKey` / `subagentId` 覆盖累积（内容级）。
- 一行一条记录，`RowRecord` 两种载体：`{ type: 'message', message }` 与 `{ type: 'subagent', subagent }`。
- 读取侧两步：先按 `type` 分流，再按 `mergeKey`（消息）与 `subagentId`（子任务行）**覆盖累积**，
  顺序按**首次出现**——打字过程中的覆盖不该让这条消息跳到列表末尾。
- 一行都不产出时不建文件：读侧因此不必区分"空文件"与"没有这一格"。
- 每次尝试开始清空（与事件日志同一口径）：它记的是**当前这一次**尝试的内容。
- **实时通道没有 `Last-Event-ID` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
  每次连接回放全量折叠视图，客户端按 `messageId` 去重、按 `mergeKey` 覆盖累积。SSE 帧因此**不带** `id:`
  帧头（设了它浏览器重连会带一个我们解释不了的值，表现为重连后少一段历史且不报错）。
- 消息流与事件流是**两条独立的长连接**，生命周期也不同：事件流在终态帧后自行关闭，消息流保持打开
  （靠终态关流会让"打开一个跑完的行的对话视图"立刻断连，而那份历史正是要看的东西）。

---

## 10. 附录：最小实例集

### 10.1 思考块（三家归一后）

```jsonc
{ "type": "thinking", "text": "先读配置再决定改哪一行。", "textKind": "full", "signature": "EqQBC…" }
```

### 10.2 工具调用与结果（run-shell）

```jsonc
{ "type": "tool-call", "callId": "call_00_NiG…", "family": "run-shell", "name": "exec_command",
  "input": { "cmd": "npm run build", "shell": "pwsh" } }   // input 是厂商原文（codex 侧 arguments 是 JSON 字符串，落库前解析成对象）
{ "type": "tool-result", "callId": "call_00_NiG…", "structured": { "exitCode": 1 },
  "isError": true, "text": "…error TS2304…", "truncated": false }   // structured 是归一后的结果；厂商原文是条目里的 exit_code / status / aggregated_output
```

### 10.3 子任务行

```jsonc
{ "subagentId": "01a0f434-707e-…", "name": "Child runs a tool", "kind": "spawn_agent",
  "source": "session-file", "status": "completed", "statusMissing": null,
  "outcome": "CHILD-TOOL-RAN", "parentSubagentId": "01a0f434-5def-…",
  "usage": { "input": 1200, "cached": 8320, "output": 114, "reasoningOutput": 52, "total": 9634 } }
// statusMissing：null = 状态已采集；取不到时写缺失原因（如 `'unverified'`）
// usage.total 是厂商原文（codex 口径 = input_tokens 9520（含缓存读）+ output_tokens 114），不参与 input + cached + output 的加和
```

### 10.4 计量行

```jsonc
{ "seq": 41, "at": "2026-10-01T05:24:31.002Z", "type": "usage", "turns": 2,
  "tokens": { "input": 1221, "cached": 7040, "output": 114, "reasoningOutput": null, "total": 8375 },
  "timing": { "totalMs": 4820, "apiMs": null, "ttftMs": null, "source": "events" } }
// 时长单位毫秒；total 是厂商原文（dsh 口径 = input 1221 + 缓存读 7040 + 缓存写 0 + output 114），不参与归一后的加和
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
```

### 10.6 未采集的表达

```jsonc
{ "type": "tool-result", "callId": "toolu_01A…", "structured": null, "isError": false,
  "text": "export const config = …", "truncated": false }   // structured 未采集 ⇒ null，不是 {}
{ "type": "usage", "tokens": null, "timing": null, "turns": 1 }   // 用量与时间整体未采集 ⇒ null，不是三个 0
```
