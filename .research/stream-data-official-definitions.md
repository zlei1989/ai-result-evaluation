# 「流数据」在三家厂商官方文档与协议层面的定义（调研报告）

- 调研日期：2026-10-09（报告由子代理产出，仅做资料调研，未改动产品代码）
- 核对到的版本（本仓 `node_modules` 实装）：
  - `@anthropic-ai/claude-agent-sdk` **0.3.281**（随包原生二进制 Claude Code）
  - `@openai/codex` **0.156.1**（`codex-cli 0.156.1`，已用本机二进制生成 JSON Schema 核对）
  - `@deepseek-ai/dsh-sdk-client` **0.1.7-rc.1**（peer：`dsh-sdk-protocol` / `dsh-session` / `dsh-llm` 同版本）
- 约定：**结论 + 证据（原文引用 + URL）**。凡没有权威来源的，明确写「未找到官方来源」。厂商原文引用保持英文原样。

---

## 1. Claude Agent SDK（TypeScript，`@anthropic-ai/claude-agent-sdk`）

### 1.1 `query()` 产出的消息类型全集

**结论**

`query()` 返回 `Query extends AsyncGenerator<SDKMessage, void>`，`SDKMessage` 是一个**三十多个成员的联合类型**，`StreamEvent`（TS 类型名 `SDKPartialAssistantMessage`）只是其中之一，且**只在开启 `includePartialMessages` 时出现**。

- 官方文档（Agent SDK TypeScript 参考）给出的联合：

```ts
type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKPluginInstallMessage
  | SDKToolProgressMessage
  | SDKAuthStatusMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKBackgroundTasksChangedMessage
  | SDKThinkingTokensMessage
  | SDKSessionStateChangedMessage
  | SDKWorkerShuttingDownMessage
  | SDKCommandsChangedMessage
  | SDKNotificationMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKMemoryRecallMessage
  | SDKRateLimitEvent
  | SDKElicitationCompleteMessage
  | SDKPermissionDeniedMessage
  | SDKPromptSuggestionMessage
  | SDKAPIRetryMessage
  | SDKMirrorErrorMessage
  | SDKInformationalMessage
  | SDKConversationResetMessage;
```

证据：<https://code.claude.com/docs/en/agent-sdk/typescript>（`.md` 版 `### SDKMessage` 一节）。

- **本仓实装 0.3.281 的 `sdk.d.ts:5133` 与文档页并不完全一致**，多出三个成员、文档页多一个：

本机 `sdk.d.ts:5133`（原文）：

```ts
export declare type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage | SDKPluginInstallMessage | SDKToolProgressMessage | SDKAuthStatusMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskProgressMessage | SDKTaskUpdatedMessage | SDKBackgroundTasksChangedMessage | SDKThinkingTokensMessage | SDKSessionStateChangedMessage | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage | SDKNotificationMessage | SDKFilesPersistedEvent | SDKToolUseSummaryMessage | SDKMemoryRecallMessage | SDKRateLimitEvent | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage | SDKPromptSuggestionMessage | SDKMirrorErrorMessage | SDKInformationalMessage | SDKConversationResetMessage;
```

差别：实装多 `SDKControlRequestProgressMessage` / `SDKModelRefusalFallbackMessage` / `SDKModelRefusalNoFallbackMessage`。
**⇒ 口径不要照抄文档页的名单，要按版本钉。**（对本仓来说，判据是 `sdk.d.ts` 的联合，而不是网页。）

**各关键类型的字段与语义（官方原文）**

`SDKAssistantMessage`：

```ts
type SDKAssistantMessage = {
  type: "assistant";
  uuid: UUID;
  session_id: string;
  message: BetaMessage; // From Anthropic SDK
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
  aborted?: true;
  agent_id?: string;
  timestamp?: string;
  context_usage?: SDKContextUsage;
  user_message_uuid?: string;
  user_message_uuids?: string[];
  resume_reason?: string;
};
```

> The `message` field is a `BetaMessage` from the Anthropic SDK. It includes fields like `id`, `content`, `model`, `stop_reason`, and `usage`.

> Claude Code emits an `AssistantMessage` as each non-empty content block completes, so a response with a text block and a tool call yields two `AssistantMessage` objects. Each one carries only its own content block, and both share the same message ID, which you read as `message.message.id` in TypeScript.

> `aborted` is `true` when an interrupt or abort truncated the assistant message before the stream completed: the message has no `stop_reason` and the content may end mid-word. The field is absent on normally completed messages.

`SDKUserMessage`：`{ type: "user"; uuid?; session_id?; agent_id?; message: MessageParam; pasted_content?; parent_tool_use_id; isSynthetic?; shouldQuery?; client_composed?; tool_use_result?; priority?; origin?; inline_pastes? }`（见同页 `### SDKUserMessage`）。

`SDKResultMessage` 语义（同一页）：

> The CLI emits exactly one result message per turn, after that turn's assistant, user and stream_event messages; treat it as the turn-complete signal (informational system messages such as task notifications, session state changes or prompt suggestions may still follow it).

`SDKSystemMessage`：会话初始化；`SDKCompactBoundaryMessage` 标记会话历史被压缩的边界。

来源：
- <https://code.claude.com/docs/en/agent-sdk/typescript>（`## Message Types` 一节）
- <https://code.claude.com/docs/en/agent-sdk/streaming-output>（Message flow 一节）
- 本机 `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.281*/…/claude-agent-sdk/sdk.d.ts:5133`

---

### 1.2 `StreamEvent` 由哪个选项控制？默认值？

**结论**

- 选项：**TypeScript `includePartialMessages`，Python `include_partial_messages`；默认 `false`。**
- TS 类型名 `SDKPartialAssistantMessage`（`type: 'stream_event'`），Python 叫 `StreamEvent`。
- 开启后拿到的是**未累积的原始 Anthropic Messages API 流式事件**，消费方必须自己累积。

**证据（原文）**

> To enable streaming, set `include_partial_messages` (Python) or `includePartialMessages` (TypeScript) to `true` in your options. This causes the SDK to yield `StreamEvent` messages containing raw API events as they arrive, in addition to the usual `AssistantMessage` and `ResultMessage`.

> Both contain raw Claude API events, not accumulated text. You need to extract and accumulate text deltas yourself.

来源：<https://code.claude.com/docs/en/agent-sdk/streaming-output>

**默认值 `false` 的出处很关键**：官方文档的 `Options` 表格里写死了 Default 列：

| Property | Type | Default | Description |
| :- | :- | :- | :- |
| `includePartialMessages` | `boolean` | `false` | Include partial message events |

来源：<https://code.claude.com/docs/en/agent-sdk/typescript>（`### Options` 表格）。

**反例（必须知道）**：本机 `sdk.d.ts` 里这个字段**没有 `@default` 注释**，只有一句描述：

```ts
/**
 * Include partial/streaming message events in the output.
 * When true, `SDKPartialAssistantMessage` events will be emitted during streaming.
 */
includePartialMessages?: boolean;
```

（本机 `sdk.d.ts:1794-1798`）

⇒ 「默认 false」只有**官方文档表格**这一个权威来源，类型定义本身不承载默认值。若日后拿 d.ts 反向推断默认值，会得出「未声明」。

**开启后 `StreamEvent` 里有什么**

```ts
type SDKPartialAssistantMessage = {
  type: "stream_event";
  event: BetaRawMessageStreamEvent; // From Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
  ttft_ms?: number; // Time to first token in ms, present only on message_start events
  user_message_uuid?: string;
  user_message_uuids?: string[];
  resume_reason?: string;
};
```

> Streaming partial message (only when `includePartialMessages` is true).
> The `parent_tool_use_id` field is always `null`: stream events are emitted for the main session only. For subagent attribution, use complete messages, which carry `agent_id` and `parent_tool_use_id`, or enable `forwardSubagentText` to receive subagent text and thinking as complete messages.

来源：<https://code.claude.com/docs/en/agent-sdk/typescript>（`### SDKPartialAssistantMessage`）

本机类型定义原文（`sdk.d.ts:5282` 起）：

```ts
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    /**
     * One Anthropic Messages API streaming event (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop) as defined for the streaming Messages API.
     */
    event: BetaRawMessageStreamEvent;
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
    ttft_ms?: number;
    ...
};
```

**`event.type` 与 `delta.type` 全表**

SDK 文档列出的常见 `event.type`：

| Event Type | Description |
| :- | :- |
| `message_start` | Start of a new message |
| `content_block_start` | Start of a new content block (text or tool use) |
| `content_block_delta` | Incremental update to content |
| `content_block_stop` | End of a content block |
| `message_delta` | Message-level updates (stop reason, usage) |
| `message_stop` | End of the message |

来源：<https://code.claude.com/docs/en/agent-sdk/streaming-output>（StreamEvent reference 表格）

`delta.type` 的权威出处是 Anthropic 平台文档（SDK 只是原样转发）：

- `text_delta`：`{"type": "content_block_delta","index": 0,"delta": {"type": "text_delta", "text": "ello frien"}}`
- `input_json_delta`：`{"type": "content_block_delta","index": 1,"delta": {"type": "input_json_delta","partial_json": "{\"location\": \"San Fra"}}`
- `thinking_delta`：
  > When using thinking with streaming enabled, you'll receive thinking content through `thinking_delta` events. These deltas correspond to the `thinking` field of the `thinking` content blocks.
- `signature_delta`：
  > For thinking content, a special `signature_delta` event is sent just before the `content_block_stop` event. This signature is used to verify the integrity of the thinking block.

来源：<https://platform.claude.com/docs/en/build-with-claude/streaming>（`content_block_delta` 一节）

- 还有非 delta 的 `ping` 帧（keep-alive），Claude Code 会转发：

> While the watchdog waits out a response that a gateway behind `ANTHROPIC_BASE_URL` holds open with keep-alive pings, a host that sets `includePartialMessages` keeps receiving `ping` stream events, so read those frames as liveness rather than timing the session out on silence.

来源：<https://code.claude.com/docs/en/agent-sdk/typescript>（`### Options` 里 `includePartialMessages` 邻近的环境说明段）

- 流式事件里还有一个特殊块：服务端回退（server-side fallback）时会有**没有任何 delta、只有一对 start/stop 的 `fallback` 内容块**：

> One exception: during server-side fallback responses, a `fallback` content block arrives at each model boundary as a `content_block_start` and `content_block_stop` pair with no deltas in between.

来源：<https://platform.claude.com/docs/en/build-with-claude/streaming>

---

### 1.3 官方是否明说「完整消息一定会在流结束时到达」/「partial 只是可选增强」？

**结论**

- 「完整消息按内容块逐个产出」与「不开 partial就只是少收 `StreamEvent`，其余消息类型照收」——**有官方原文**。
- 「忽略 StreamEvent 不会丢最终事实」——**未找到这句官方措辞**（原文里没有等价句子）。只能引下面两句作为最接近的官方口径。

**证据（原文）**

> By default, the Agent SDK yields a complete `AssistantMessage` for each non-empty content block, such as a text block or a tool call, after Claude finishes generating that block. To receive incremental updates as text and tool calls are generated, enable partial message streaming.

> Without partial messages enabled, you receive all message types except `StreamEvent`. Common types include `SystemMessage` (session initialization), `AssistantMessage` (complete content blocks), `ResultMessage` (final result), and a compact boundary message…

来源：<https://code.claude.com/docs/en/agent-sdk/streaming-output>

顺序关系（官方给出的消息流时序，说明完整块在本块 `content_block_stop` 之前就到）：

```text
StreamEvent (message_start)
StreamEvent (content_block_start) - text block
StreamEvent (content_block_delta) - text chunks...
AssistantMessage - complete text block
StreamEvent (content_block_stop)
StreamEvent (content_block_start) - tool_use block
...
ResultMessage - final result
```

同页 Known limitations（说明「结果以完整侧为准」的唯一官方表述）：

> **Structured output**: with partial messages enabled, the JSON streams as a tool call's unvalidated `input_json_delta` chunks, and only the validated result reaches the final `ResultMessage.structured_output`.

**重要反例（别把「完整消息」等同于「完整输出」）**：中断/中止时，完整消息本身可能是截断前缀——`aborted?: true` 的语义见 1.1（"the content may end mid-word"）。即：**丢弃增量不会丢「已定型的最终事实」，但在 `aborted` 场景下，你拿到的「完整消息」也可能不是模型本要产出的完整内容**，只是这件事在完整消息上**有显式标记**（`aborted` + 无 `stop_reason`）。

---

### 1.4 反过来：有没有只存在于 `StreamEvent` 的信息？

**结论（逐项判定）**

| 信息 | 只在 StreamEvent？ | 依据 |
|---|---|---|
| 逐 token / 逐块的到达时刻与切分边界 | **是** | 完整消息只给最终 `content`，不给切分与时间 |
| `ttft_ms`（首 token 时延） | **是** | 类型定义注明 "present only on message_start events"；完整消息无对应字段 |
| `ping` keep-alive 帧 | **是** | 只作为 stream event 出现 |
| 未定型前缀的实时可见性（块生成中途） | **是（实时性）** | 完整 `AssistantMessage` 要等该块完成才产出 |
| `signature_delta`（thinking 签名） | **否** | 完整 `thinking` 块自带 `signature` 字段 |
| usage（含 output_tokens） | **否** | `BetaMessage.usage` 在完整消息里；`message_delta` 的 usage 是累积值 |
| 内容块 `index` 顺序 | **否（可推导）** | "Each content block has an `index` that corresponds to its index in the final Message `content` array." |
| `user_message_uuid` / `resume_reason` | **否** | 完整 assistant 消息上同样会盖章 |
| 中途模型回退/`fallback` 块的存在 | **待验证** | 见下 |

**证据（原文）**

- `signature` 在完整块里（不是只有增量才有）：

> Each thinking block also carries a `signature` field, an encrypted copy of the full reasoning that you pass back unchanged in multi-turn and tool-use conversations

> When streaming responses, the signature arrives as a `signature_delta` inside a `content_block_delta` event just before the `content_block_stop` event.

来源：<https://platform.claude.com/docs/en/build-with-claude/thinking>

- `index` 与最终 `content` 数组下标一一对应：

> Each content block has an `index` that corresponds to its index in the final Message `content` array.

来源：<https://platform.claude.com/docs/en/build-with-claude/streaming>

- `message_delta` 的 usage 是累积值：

> The token counts shown in the `usage` field of the `message_delta` event are *cumulative*.

同页。

- `ttft_ms` 唯一性：见 1.2 的类型定义注释（"present only on message_start events"）。

**待验证**：`message_start` 里那个 `Message` 对象在 thinking beta 头下会额外带 `input_transformations` 数组，且「服务端回退后最终 `message_delta` 会再带一次」——**若完整 `AssistantMessage` 里没有等价的"中途回退边界/变换"记录，则这部分只有增量侧有**：

> 1. `message_start`: contains a `Message` object with empty `content`. Under the `thinking-binding-controls-2026-08-01` beta header, this `Message` object also carries the `input_transformations` array. After a mid-stream server-side fallback, the final `message_delta` event carries the array again with the serving model's entries.

来源：<https://platform.claude.com/docs/en/build-with-claude/streaming>

⇒ 这一条**需要真机抓一次 `includePartialMessages` 的开/关对照**才能定论（见第 5 节）。

---

## 2. OpenAI Codex app-server 协议

核对手段（比网页更硬）：用**本仓实装的 `codex-cli 0.156.1` 二进制**生成协议 Schema：

```bash
codex app-server generate-json-schema --out /tmp/codex-schema
```

`ServerNotification.json` 里共 **82** 个通知方法。官方文档亦提供了同样的生成命令：

> You can generate a TypeScript schema or a JSON Schema bundle from the CLI. Each output is specific to the Codex version you ran, so the generated artifacts match that version exactly:
> `codex app-server generate-ts --out ./schemas`
> `codex app-server generate-json-schema --out ./schemas`

来源：<https://learn.chatgpt.com/docs/app-server>（官网 `developers.openai.com/codex/app-server` 会 302 到这里；`.md` 版：<https://learn.chatgpt.com/docs/app-server.md>）

### 2.1 增量 vs 完整快照（名称已按 0.156.1 Schema 核实）

**结论**

**(a) 增量类通知（0.156.1 实存，逐字核实）**

| 方法名 | 语义（官方原文） |
|---|---|
| `item/agentMessage/delta` | appends streamed text for the agent message |
| `item/plan/delta` | streams proposed plan text. **The final `plan` item may not exactly equal the concatenated deltas** |
| `item/reasoning/summaryTextDelta` | streams readable reasoning summaries; `summaryIndex` increments when a new summary section opens |
| `item/reasoning/summaryPartAdded` | marks a boundary between reasoning summary sections |
| `item/reasoning/textDelta` | streams **raw reasoning text (when supported by the model)** |
| `item/commandExecution/outputDelta` | streams stdout/stderr for a command; append deltas in order |
| `item/fileChange/outputDelta` | **deprecated** compatibility notification for legacy `apply_patch` text output. Current app-server versions no longer emit it |
| `command/exec/outputDelta`（notify） | emitted for base64-encoded stdout/stderr chunks from a streaming `command/exec` session |
| `process/outputDelta`（notify） | emitted for streaming process output（experimental） |
| `thread/realtime/*delta`（voice 面） | `thread/realtime/transcript/delta`、`thread/realtime/item/transcript/delta`、`thread/realtime/outputAudio/delta` |

来源：<https://learn.chatgpt.com/docs/app-server>（`### Item deltas` 一节）+ 本机生成的 `/tmp/codex-schema/ServerNotification.json`。

⚠️ 注意你给的候选名单里有两个**不准确**的地方，按实存核实后是：
- `item/reasoning/textDelta`（对）与 `item/reasoning/summaryTextDelta`（对）都存在，但**它们是两个不同字段名**，别写成 `item/reasoning/delta`。曾有一个提交名为 "add new v2 events: `item/reasoning/delta`, `item/agentMessage/delta`…"（<https://github.com/openai/codex/commit/b8ec97c0ef37e4acc6b6243d893989183a478467>），**最终落地的名字不是 `item/reasoning/delta`** —— 以 0.156.1 Schema 为准。
- `codex exec --json` 的 `item.updated` 不是 token 增量（见 2.3）。

**(b) 完整快照类（官方口径）**

| 方法名 | 语义（官方原文） |
|---|---|
| `item/started` | emits the full `item` when a new unit of work begins; the `item.id` matches the `itemId` used by deltas |
| `item/completed` | sends the final `item` once work finishes; **treat this as the authoritative state** |
| `turn/started` | `{ turn }` with the turn id, empty `items`, and `status: "inProgress"` |
| `turn/completed` | `{ turn }` where `turn.status` is `completed`, `interrupted`, or `failed` |
| `turn/diff/updated` | latest aggregated unified diff across every file change in the turn |
| `turn/plan/updated` | whenever the agent shares or changes its plan; each `plan` entry is `{ step, status }` |
| `thread/tokenUsage/updated` | usage updates for the active thread |

同页还有一条重要的「谁是事实源」：

> `turn/diff/updated` and `turn/plan/updated` currently include empty `items` arrays even when item events stream. **Use `item/*` notifications as the source of truth for turn items.**

来源：<https://learn.chatgpt.com/docs/app-server>（`### Turn events` / `### Items`）

完整项里 item 的形状（官方 + Schema 双向核对）：

- `agentMessage` - `{id, text, phase?}` containing **the accumulated agent reply**（⇒ 完整项里是全文，不是片段）
- `reasoning` - `{id, summary, content}` where `summary` holds streamed reasoning summaries and `content` holds raw reasoning blocks
- `commandExecution` - `{id, command, cwd, status, commandActions, aggregatedOutput?, exitCode?, durationMs?}`
- `plan` - `{id, text}`；"Treat the final `plan` item from `item/completed` as authoritative."

Schema 层面的关键细节（`codex_app_server_protocol.v2.schemas.json` → `ThreadItem`）：
各变体的 `required` 与 `properties` 由 0.156.1 生成器输出，例如

```
AgentMessageThreadItem    | required: ['id','text','type']          | props: delivery,id,memoryCitation,phase,questions,text,type
ReasoningThreadItem       | required: ['id','type']                 | props: content,id,summary,type
PlanThreadItem            | required: ['id','text','type']          | props: id,text,type
CommandExecutionThreadItem| required: ['command','commandActions','cwd','id','status','type']
```

**⇒ `content` / `summary` 在 reasoning 完整项里是「可选字段」**，这是第 4 节「只能靠增量才能拿到的最终事实」那条判断的 Schema 依据。

增量通知的载荷（同样来自 0.156.1 Schema）：

```json
// AgentMessageDeltaNotification
{ "delta": "string", "itemId": "string", "threadId": "string", "turnId": "string" }
// ReasoningTextDeltaNotification
{ "contentIndex": 0, "delta": "string", "itemId": "...", "threadId": "...", "turnId": "..." }
// ReasoningSummaryTextDeltaNotification
{ "delta": "string", "itemId": "...", "summaryIndex": 0, "threadId": "...", "turnId": "..." }
// ReasoningSummaryPartAddedNotification
{ "itemId": "...", "summaryIndex": 0, "threadId": "...", "turnId": "..." }
```

⇒ 增量帧**不带** `index` 之外的块结构信息也不算全文；`contentIndex` / `summaryIndex` 是增量侧用来拼段的游标。

### 2.2 官方是否说明「增量是可选增强、完整项一定在 `item/completed` 到达」？

**结论**

- 「完整项一定到、且以它为准」：**有官方原文**（"treat this as the authoritative state"）。
- 「增量是可选增强」：**没有这句措辞**，但有**更强的等价证据**——官方支持按方法名**精确屏蔽**增量通知（含示例里就点名 `item/agentMessage/delta`）：

> `optOutNotificationMethods` - exact notification method names to suppress for this connection. Matching is exact (no wildcards or prefixes); unknown names are accepted and ignored.

```json
{ "method": "initialize", "id": 1, "params": {
  "clientInfo": { ... },
  "capabilities": {
    "experimentalApi": true,
    "optOutNotificationMethods": ["thread/started", "item/agentMessage/delta"]
  }
} }
```

> Exact-match only: `item/agentMessage/delta` suppresses only that method.

来源：<https://learn.chatgpt.com/docs/app-server>（`## Initialization` 与 notification 过滤一节）

⇒ 官方把 `item/agentMessage/delta` 当作**可整条屏蔽的旁路通知**，配合 "item/completed … treat this as the authoritative state"，构成「增量可选、完整项为准」的官方依据。**但没有一句话是"忽略增量不会丢最终事实"。**

### 2.3 `codex exec --json` 的 JSONL 投影 vs app-server

**结论**

1. `codex exec --json` 的 JSONL **完全没有 token 级增量事件**。
2. 它的 reasoning 投影**只取 summary、丢弃 raw content**；summary 为空时该 item **整条不产出**。
3. 它的 `item.updated` **只用于 todo/plan 列表**，不是 token 流。

**证据（源码，权威）**

`codex-rs/exec/src/exec_events.rs` 的顶层事件联合（`ThreadEvent`）**只有 8 个变体**，无任何 delta：

```rust
/// Top-level JSONL events emitted by codex exec
#[serde(tag = "type")]
pub enum ThreadEvent {
    #[serde(rename = "thread.started")]  ThreadStarted(ThreadStartedEvent),
    #[serde(rename = "turn.started")]    TurnStarted(TurnStartedEvent),
    #[serde(rename = "turn.completed")]  TurnCompleted(TurnCompletedEvent),
    #[serde(rename = "turn.failed")]     TurnFailed(TurnFailedEvent),
    #[serde(rename = "item.started")]    ItemStarted(ItemStartedEvent),
    #[serde(rename = "item.updated")]    ItemUpdated(ItemUpdatedEvent),
    #[serde(rename = "item.completed")]  ItemCompleted(ItemCompletedEvent),
    #[serde(rename = "error")]           Error(ThreadErrorEvent),
}
```

来源：<https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs>

官方文档对该事件的列举与之一致：

> Event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, and `error`.

来源：<https://learn.chatgpt.com/docs/non-interactive-mode.md>

投影实现（`codex-rs/exec/src/event_processor_with_jsonl_output.rs`）：

- 只处理 `ServerNotification::ItemStarted` / `ItemCompleted`（以及 turn/error/thread 等），**所有 delta 通知落进 `_ => CodexStatus::Running` 被丢弃**：

```rust
ServerNotification::ItemStarted(notification) => {
    if let Some(item) = self.map_started_item(notification.item) {
        events.push(ThreadEvent::ItemStarted(ItemStartedEvent { item }));
    }
    CodexStatus::Running
}
ServerNotification::ItemCompleted(notification) => { ... }
...
_ => CodexStatus::Running,
```

- reasoning 只取 `summary`，空则**整条丢掉**：

```rust
ThreadItem::Reasoning { summary, .. } => {
    let text = summary.join("\n");
    if text.trim().is_empty() {
        return None;
    }
    Some(ExecThreadItem {
        id: make_id(),
        details: ThreadItemDetails::Reasoning(ReasoningItem { text }),
    })
}
```

而 `ReasoningItem` 只有 `text` 一个字段，文档注释是 "Agent's reasoning summary."：

```rust
/// Agent's reasoning summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ReasoningItem { pub text: String }
```

- `item.updated` 仅由 `ServerNotification::TurnPlanUpdated` 驱动，投影成 `TodoList` item：

```rust
ServerNotification::TurnPlanUpdated(notification) => {
    let items = Self::map_todo_items(&notification.plan);
    if let Some(running) = self.running_todo_list.as_mut() { ... ThreadEvent::ItemUpdated(...TodoList...) }
```

来源：<https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs>

**⇒ 结论：exec 投影不含 delta；且 reasoning 的 raw content（`item/reasoning/textDelta` 那条通道）在 exec 侧被结构性丢弃，summary 缺失时连 reasoning item 都没有。** 这与本仓 `docs/protocols/codex.md` 的真机记录一致（「`codex exec --json` 里 `item.type === 'reasoning'` 恒 0 条」）——该记录是**仓库自己的实测**，不是厂商文档，引用时请标注来源。

### 2.4 只存在于增量、不存在于完整项里的信息有哪些？

**结论**

| 信息 | 只在增量？ | 依据 |
|---|---|---|
| token 级到达时序与节奏 | **是** | 完整项只在结束时给一次 |
| 进度类中间态（`item/mcpToolCall/progress`、`item/fileChange/patchUpdated`、`item/commandExecution/outputDelta` 的实时 stdout） | **是（实时性）** | 完整项的 `aggregatedOutput` 只有最终聚合值 |
| `summaryIndex` / `contentIndex` 的分段游标 | **否（可推导）** | 完整项是数组（`summary: string[]`、`content: string[]`），边界即数组下标 |
| **原始推理正文 `reasoning.content`** | **部分场景可能只此一份** | `ReasoningThreadItem` 的 `content`/`summary` 在 Schema 里**非 required**；文档把 `textDelta` 限定为 "when supported by the model" |
| plan 文本 | **否，且增量更差** | 官方明说 final plan 可能 ≠ 拼接的 delta |
| `item/started` 里的"开工快照" | 否 | `item/started` 也是完整 item（状态 inProgress） |

关于「原始推理正文只在 delta」这条，需要给出精确的机制层证据：完整项里的内容是**从 core 的 TurnItem 搬过来的**，字段本身可为空：

```rust
CoreTurnItem::Reasoning(reasoning) => ThreadItem::Reasoning {
    id: reasoning.id,
    summary: reasoning.summary_text,
    content: reasoning.raw_content,
},
```

且结构体上两个字段都带 `#[serde(default)]`：

```rust
Reasoning {
    id: String,
    #[serde(default)] summary: Vec<String>,
    #[serde(default)] content: Vec<String>,
},
```

来源：<https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs>

⇒ 若 `raw_content` 因模型/配置（例如未开启 raw reasoning 回传）而为空，则完整项里 `content: []`，**原始推理正文只在 `item/reasoning/textDelta` 里出现过**。这是三家当中唯一一个「完整项可能为 null、事实只在增量里」的候选，**必须真机验证**（见第 5 节）。

---

## 3. DeepSeek Harness（`@deepseek-ai/dsh-sdk-client`）

**前置说明（来源可得性）**：`package.json` 里 `repository` 指向 `https://github.com/deepseek-ai/deepseek-harness`，但该仓库路径 **404（未公开）**；`npmjs.com` 包页返回 403。**因此本节的权威来源是「已发布的 npm 包内类型定义（`.d.ts`）」**，不引任何二手转述。公开官方文档：**未找到官方来源**。

### 3.1 通知/事件类型里有没有 text-delta 一类增量？

**结论**

**SDK 订阅的通知层没有 delta。** 协议层的服务端→客户端通知**只有 4 个方法**，全部是「完整记录/状态」，没有任何文本或推理增量：

```ts
/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
    'session.event': SessionEventNotification;
    'session.status': SessionStatusNotification;
    'subagent.started': SubagentStartedNotification;
    'subagent.finished': SubagentFinishedNotification;
}
```

证据：`@deepseek-ai/dsh-sdk-protocol@0.1.7-rc.1` → `lib/types/types.d.ts`（"Named wire types … the three request/result pairs and **the four server-to-client notification payloads**"）。
可访问 URL（包页）：<https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-protocol>（页面对自动化请求返回 403，需人工打开；本报告以实装 `.d.ts` 原文为准）。

`session.event` 的语义是「**逐条记录、记录时即转发**」，不是「逐 token」：

```ts
/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
    sessionId: string;
    /** The full session-log event envelope. */
    event: SessionEvent;
}
```

**LLM 层确实有 delta**（所以"厂商 LLM 层有 delta 但通知层不投送"是成立的）。`@deepseek-ai/dsh-llm` 的原始流式块联合：

```ts
/**
 * Raw streaming protocol emitted by adapters.
 * Block indexes correlate interleaved deltas, and `block-end` carries the
 * assembled block. ...
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```

证据：`@deepseek-ai/dsh-llm@0.1.7-rc.1` → `lib/types/types.d.ts:406` 起。

**会话事件词汇表里也没有 delta 类型**（`KNOWN_SESSION_EVENT_TYPES`，生成自仓库的类型表，`assistant/message` 是其中的「组装完成」事件）：

```js
export const KNOWN_SESSION_EVENT_TYPES = new Set([
    'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', ...
    'assistant/attempt', 'assistant/message',
    'command/done', 'command/run', ...
    'user/message', ...
]);
```

证据：`@deepseek-ai/dsh-session@0.1.7-rc.1` → `lib/types/known-event-types.js`（文件头："GENERATED by `scripts/gen-persistence-catalog.ts`"）。

**delta 真实存在的层：进程内（process-local）事件总线，SDK 拿不到**：

```ts
/**
 * Process-local assistant-stream publication. Chunk frames are transient;
 * the loop appends one final v2 `assistant/message` or `assistant/attempt`
 * with the same stream before a committed end frame.
 * ...
 * @mode emit
 */
'agent/assistant-stream'(this: Scoped<Agent>, payload: {
    agent: Agent;
    frame: AssistantStreamFrame;
}): void;
```

证据：`@deepseek-ai/dsh-agent@0.1.7-rc.1` → `lib/types/runtime-types.d.ts`（`agent/assistant-stream` 条目；`AssistantStreamFrame` 的 `type: 'chunk'` 帧里就带 `readonly chunk: StreamChunk`）。

⇒ **三层证据链**：LLM 层有 `text-delta` → 进程内 `agent/assistant-stream` 有 chunk 帧（**显式标注 Process-local / transient**）→ SDK 协议通知表只有 4 个方法、无 delta。**"文档说的层 ≠ 我们能拿到的层"这条本仓结论在 DSH 上得到源码级支撑。**

### 3.2 完整消息（`assistant/message`）与任何增量类通知的关系

**结论（DSH 独有的答案）**：**不存在"增量通知"，但增量数据不丢——它被内嵌在完整消息事件里。**

`assistant/message` 的定义同时携带「组装好的消息」与「原样的流式记录」：

```ts
/**
 * Assembled assistant message for one step (derived history uses this).
 * Carries the step's `usage` when the adapter reported token accounting ...
 * A turn cancelled mid-stream finalizes its delivered text/reasoning prefix as this
 * event with `interrupted: true`; undispatched tool calls are absent. ...
 */
'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage;
    /** Exact timed model stream, compacted without joining delta boundaries. */
    stream: AssistantStreamRecord[];
    usage?: TokenUsage;
    interrupted?: true;
};
```

同族还有 `assistant/attempt`（"One model attempt that committed no surface message. The embedded stream preserves a failed, retried, cancelled, or stream-error attempt…"）。

证据：`@deepseek-ai/dsh-session@0.1.7-rc.1` → `lib/types/types.d.ts`（`SessionEventMap`）。

另有一条佐证（`assistant/message` 会拒绝外部塞入 source seq，因为它自己就带来源流）：

```
throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs');
```

证据：`@deepseek-ai/dsh-session` → `lib/types/surface.js:239`。

SDK 侧消费口径（官方 README）：

> `RunResult { sessionId, finalResponse, events, notifications }`, where `finalResponse` is the last committed root-session assistant text in that interval

> A run subscribes to the session tree, queues the prompt, waits until the prompt's message id appears in a durable `agent/inbox/spliced` receipt, then collects notifications until the whole agent reports `idle`. **`finalResponse` is derived from the last `assistant/message` in the collected events.**

证据：`@deepseek-ai/dsh-sdk-client@0.1.7-rc.1` → `README.md`。

`stream: AssistantStreamRecord[]` 是**压缩**表示（"compacted without joining delta boundaries"），需要展开才能拿逐字：

```ts
/** @returns detached timed chunks with every original delta boundary preserved. */
export declare function expandAssistantStream(stream: readonly AssistantStreamRecord[]): readonly TimedStreamChunk[];
```

证据：`@deepseek-ai/dsh-llm` → `lib/types/assistant-stream.d.ts`。

**⇒ 所以 DSH 的「丢增量」= 什么都不丢最终事实**（时延与「逐条记录时刻」也不丢，因为 stream 是 timed 的）；但**实时性完全丢失**：SDK 通知层不会给你任何 token 级到达信号，`assistant/message` 只在 settlement 时才发。

---

## 4. 横向归纳（最重要）

### 4.1 「流数据 / stream data」在官方文档层面最贴切的定义

**结论**

最贴切的定义是：**「最终事实定型之前的逐字/逐块中间态增量（partial / delta）」**。

- **是**「partial / delta」：三家的官方词汇都指向同一件事——Claude 用 "partial message streaming" / `content_block_delta`；Codex 用 "Item deltas"；DSH 用 `text-delta` / `reasoning-delta` / `tool-call-delta`（`StreamChunk`，且 SDK 层不投送）。
- **不是**「SSE 帧本身」：只有 Claude 这条链是 SSE（Anthropic API 流式事件），Codex app-server 是 JSON-RPC over JSONL/WebSocket，DSH 是 newline-delimited JSON-RPC。把「流数据」等同于 SSE 帧，会漏掉后两家的增量。
- **不是**「流式传输通道」：三家全都用流式传输（这是传输层事实）；若把通道本身叫「流数据」，则"不记录流数据"会退化成"不记录任何东西"，口径失效。

**建议的可判定口径**（把三类东西切开）：

| 层 | 定义 | 三家的对应物 |
|---|---|---|
| 传输帧 | 承载消息的字节/帧边界（SSE `data:`、NDJSON 一行、WS text frame） | 与"事实"无关，解析层吸收 |
| **流数据（中间态增量）** | 最终事实定型前的逐字/逐块片段，**消费方必须自行累积**，且可能不与最终值一致 | Claude `StreamEvent`(若开)；Codex `item/*/delta`；DSH `StreamChunk`（仅进程内 + 内嵌） |
| 完整消息（台账事实） | 具备稳定 id、可独立解释、不依赖上下文累积的定型对象 | Claude `AssistantMessage`/`UserMessage`/`ResultMessage`…；Codex `item/started`/`item/completed`/`turn/completed`；DSH `session.event`（`assistant/message` 等） |

关键判据（本报告所得）：**"完整消息"必须自带足以独立解释的全部字段**。按这条：
- Claude：✅（`AssistantMessage.message` 是完整 `BetaMessage`，含 content/usage/stop_reason）
- Codex：✅（`item/completed` 是 authoritative snapshot，`agentMessage.text` 是 accumulated 全文）
- DSH：✅（`assistant/message` 带 `message` + `usage`；且 `stream` 内嵌，**连逐字都可复原**）

### 4.2 丢弃增量、只留完整消息：分别丢什么 / 不丢什么

| 维度 | Claude Agent SDK | Codex app-server | DeepSeek Harness |
|---|---|---|---|
| 丢掉的中间态 | `StreamEvent`（`BetaRawMessageStreamEvent` 原样转发） | `item/agentMessage/delta`、`item/reasoning/{textDelta,summaryTextDelta,summaryPartAdded}`、`item/plan/delta`、`item/commandExecution/outputDelta`、`command/exec/outputDelta`、`process/outputDelta` 等 | **本来就没有中间态可丢**（SDK 通知层只有 4 个方法） |
| 不丢的最终事实 | 完整 `content`（含 thinking 块与 `signature`）、`usage`、`stop_reason`、块顺序 | `item/completed` 的 `agentMessage.text`、`reasoning.summary`/`content`(可为空)、`commandExecution.aggregatedOutput`、`fileChange.changes`、`turn.completed` | 全部（`assistant/message.message` 与内嵌 `stream` 的最终拼合） |
| 真丢掉的独有信息 | `ttft_ms`；token 级到达时序；块生成中途的实时可见性；`ping` 存活信号；**（待验证）中途回退/`fallback` 块边界与 `input_transformations`** | token 级时序；命令 stdout 的实时性；**（待验证）若 `reasoning.content` 为空则原始推理正文只在 `textDelta`** | 实时性（无任何 token 级信号）；`assistant/attempt` 之外无中间态 |
| 截断/异常时的风险 | `aborted: true` 的完整消息可能是**词中截断**的前缀（有显式标记） | `turn/completed` 的 `status` 会是 `interrupted`/`failed`；半成品 item 有 `inProgress` 态 | 中断时 `assistant/message.interrupted: true`，只保留已交付文本/推理前缀 |
| 是否需要厂商开关 | 需要（`includePartialMessages: true`，默认 false 才需要"关"——默认就是关） | 不需要（delta 默认就在发，可用 `optOutNotificationMethods` 关掉） | 无处可开 |

**一句话**：三家都能做到「只留完整消息而台账不失真」；差别在**性能/实时性/时延指标**上，以及在 **Codex 的原始推理正文**这一处可能存在"完整项为空、只有增量有"的结构性风险。

### 4.3 是否存在「增量内容 ≠ 完整消息内容」的厂家？

| 厂商 | 结论 | 证据 |
|---|---|---|
| **Codex** | **官方明说不等** | "The final `plan` item may not exactly equal the concatenated deltas."（<https://learn.chatgpt.com/docs/app-server>，`item/plan/delta`）；代码注释同样写 "The completed plan item is authoritative and may not match the concatenation of `PlanDelta` text."（`v2/item.rs` 的 `Plan` 变体注释） |
| **Claude** | **官方口径是"原始事件、请自行累积"，不承诺等值；且 `aborted` 时完整消息是截断前缀** | "Both contain raw Claude API events, not accumulated text. You need to extract and accumulate text deltas yourself."；"`aborted` … the content may end mid-word."（<https://code.claude.com/docs/en/agent-sdk/streaming-output>、<https://code.claude.com/docs/en/agent-sdk/typescript>） |
| **DSH** | **不等值问题不存在（也不适用）**：完整事件内嵌的 `stream` 被定义为 "exact timed model stream, compacted without joining delta boundaries"，二者是同一份数据的两种表示 | `@deepseek-ai/dsh-session` → `lib/types/types.d.ts`（`assistant/message.stream`） |

### 4.4 是否存在只能靠增量才能拿到的最终事实？

| 厂商 | 有没有？ | 具体 |
|---|---|---|
| **Claude** | **基本没有**（只有过程性/时延性信息） | `signature`：完整 thinking 块自带（thinking 文档）；`usage`：完整消息有；块 `index`：与最终 `content` 下标一致（streaming 文档）。**只有 `ttft_ms`、`ping`、逐字时序是增量独有**。**待验证**：`input_transformations` 与中途 `fallback` 块边界是否在完整消息里有等价记录 |
| **Codex** | **可能有一个，待验证** | `ReasoningThreadItem` 的 `content`（原始推理正文）与 `summary` 在 Schema 里**非 required**；`item/reasoning/textDelta` 的存在前提被文档限定为 "when supported by the model"。若某模型/配置下 `raw_content` 不回传，则**完整项 `content: []`，原始推理正文只在增量里**。本仓真机记录显示在**已观测的配置**下 `textDelta` 拼接与 `content[0]` 完全相等（即快照侧有全文），但那是单配置结论 |
| **DSH** | **没有** | 逐字流被内嵌在 `assistant/message.stream`（timed、可 `expandAssistantStream()` 展开），不依赖任何独立增量通知 |

---

## 5. 不确定项与需要真机验证的点

1. **Claude：`StreamEvent` 独有信息只剩两条，但要卡死边界。**
   - 已验证：`ttft_ms` 只在 `message_start`；`signature`/`usage`/`index` 完整侧都有。
   - **待验证**：服务端回退时 `content_block_start` 的 `fallback` 块（无 delta）与 `message_start`/`message_delta` 的 `input_transformations`，在**完整 `AssistantMessage` 里是否有等价记录**（若没有，则"中途换过模型/改过输入"这一事实只能靠增量或最终 `message.model` 观察）。
   - 验证方法：同一 prompt 开/关 `includePartialMessages` 各跑一次（需能触发 fallback，或直接比对 `input_transformations` 是否出现在 `message.content`/其它字段），逐字段 diff 两份台账。
2. **Claude：`aborted` 语义落地**。中断时完整 `AssistantMessage` 是否**仍然**作为一条 assistant 消息投递（而非只留 `ResultMessage`）？文档只说字段语义，未说投递保证。需要真机在流式中途 abort，统计收到的消息类型序列。
3. **Codex：`item/completed` 的 `reasoning.content` 何时为空。** Schema 是 optional，文档说 `textDelta` "when supported by the model"。需要跨**模型 / 网关 / reasoning 配置**（例如 DeepSeek 网关、不同 effort、不同 `model_reasoning_summary`）抓对照：同一 turn 里比对 `item/reasoning/textDelta` 拼接 vs `item/completed` 的 `reasoning.content`。**这是三家唯一需要"防丢事实"的点。**
4. **Codex：`item/started` 里 reasoning 是否恒为空数组**（本仓 `docs/protocols/codex.md` 记录实测两格皆空）。Schema 无法证明"运行期恒空"，需真机复验；也不要拿 `item/started` 当取值点。
5. **Codex：文档页与 0.156.1 Schema 的漂移。** `item/fileChange/outputDelta` 文档已标 deprecated「Current app-server versions no longer emit it」，但 0.156.1 的 `ServerNotification.json` **仍有该方法**（发不发是运行期行为）。另有 `thread/realtime/*`、`process/*`、`command/exec/*` 属 experimental。**升级 Codex 时必须重新 `generate-json-schema` 取名单**，不能缓存文档页名单。
6. **Codex：`item/agentMessage/delta` 的 delta 与 `item/completed` 的 `text` 是否恒等。** 文档对 plan 说了"可能不等"，对 agentMessage 只说 "appends streamed text for the agent message"，**没有对 agentMessage 做等值承诺**。需要在真机上做多 case 拼接比对（这是本仓归一化算法"delta 追加 + snapshot 覆盖"是否安全的关键前提）。
7. **DSH：没有公开官方文档可引。** `github.com/deepseek-ai/deepseek-harness` 返回 404、npm 包页对自动化 403。本报告以 npm 包内 `.d.ts` 为权威；**若需要可引用的公开 URL，只能引包页面或请厂商提供文档站**。另外 `AssistantStreamRecord` 的压缩格式（`text-chunks`/`reasoning-chunks` 打包记录）需按 `expandAssistantStream()` 展开后才能逐字比对，**不要手写解包**。
8. **DSH：`agent/assistant-stream` 是 process-local。** 只有在 harness 进程内写插件才能拿到实时 delta；SDK（子进程外）拿不到。若产品要求 DSH 也有实时流，代价是**在 harness 侧加一个投影到 `session.event` 或新通知方法的插件**（协议方法表当前是封闭的 3 请求 + 4 通知），这属于改协议，不是改消费方。
9. **三家"默认值"的权威出处不齐。** Claude 的 `false` 只在**官方文档表格**，d.ts 无 `@default`（引 d.ts 会得出"未声明"）；Codex 没有 delta 开关（只有 `optOutNotificationMethods`，且**默认全开**）；DSH 无开关。写进本仓口径文档时，要按厂商分别标注"默认值的来源"。

---

### 附：本报告用到的权威来源清单

**Claude**
- <https://code.claude.com/docs/en/agent-sdk/streaming-output>（`StreamEvent`、默认值、消息流时序、Known limitations）
- <https://code.claude.com/docs/en/agent-sdk/typescript>（`SDKMessage` 联合、`SDKAssistantMessage`、`SDKPartialAssistantMessage`、`Options.includePartialMessages` 默认值表）
- <https://platform.claude.com/docs/en/build-with-claude/streaming>（事件类型与 `text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta`、index 语义、usage 累积、fallback 块）
- <https://platform.claude.com/docs/en/build-with-claude/thinking>（完整 thinking 块自带 `signature`；`display: omitted` 的流式行为）
- 本机实装 `@anthropic-ai/claude-agent-sdk@0.3.281`（`sdk.d.ts:1794`、`sdk.d.ts:5133`、`sdk.d.ts:5282`）

**Codex**
- <https://learn.chatgpt.com/docs/app-server>（通知总览、`item/started`/`item/completed` 为 authoritative、Item deltas 全表、`optOutNotificationMethods`；`developers.openai.com/codex/app-server` 302 到此）
- <https://learn.chatgpt.com/docs/non-interactive-mode>（`codex exec --json` 的事件类型列举与样例）
- <https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs>（exec JSONL 事件联合，无 delta）
- <https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs>（exec 丢弃 delta、reasoning 只取 summary）
- <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/item.rs>（`Reasoning { summary, content }` 均 `#[serde(default)]`；plan 注释）
- 本机实装 `codex-cli 0.156.1` 生成物：`codex app-server generate-json-schema` → `ServerNotification.json`（82 个通知）、`codex_app_server_protocol.v2.schemas.json`（`ThreadItem` 各变体 required/properties）

**DeepSeek Harness**（公开官方文档：未找到官方来源；以下为已发布 npm 包内类型定义）
- `@deepseek-ai/dsh-sdk-protocol@0.1.7-rc.1` → `lib/types/types.d.ts`（4 个通知方法）
- `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1` → `lib/types/types.d.ts`、`README.md`
- `@deepseek-ai/dsh-session@0.1.7-rc.1` → `lib/types/types.d.ts`（`assistant/message` 带 `stream`）、`lib/types/known-event-types.js`、`lib/types/surface.js`
- `@deepseek-ai/dsh-llm@0.1.7-rc.1` → `lib/types/types.d.ts`（`StreamChunk` 的 `text-delta`/`reasoning-delta`/`tool-call-delta`）、`lib/types/assistant-stream.d.ts`
- `@deepseek-ai/dsh-agent@0.1.7-rc.1` → `lib/types/runtime-types.d.ts`（`agent/assistant-stream`，Process-local）

**本仓内部资料（非厂商官方，引用时请标注为实测记录）**
- `docs/protocols/codex.md`（`exec --json` reasoning 恒 0 条、`textDelta` 与 `content[0]` 相等的实测）
- `docs/protocols/dsh.md`、`docs/protocols/comparison.md`、`docs/protocols/message-spec.md`（"文档说的层 ≠ 能拿到的层"；delta/snapshot 两形态）
