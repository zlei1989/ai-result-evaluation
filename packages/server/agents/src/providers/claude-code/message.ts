/**
 * claude-code 的**消息归一**（spec v3 §3.1 / §3.2 / §3.3 / §3.4 / §4.1）：把 SDK 消息流折成统一的
 * `AgentMessage` 与 `SubagentRecord`。事件投影仍在 `events.ts`（行级审计与活动行），本文件只管内容级视图。
 *
 * 取值路径逐条（真机逐字核过，见 `probe/dumps/v4/claude-*.jsonl`）：
 *   · 正文：`assistant` → `message.content[type=text].text`；思考：`content[type=thinking]` 的
 *     `thinking` + `signature`；工具调用：`content[type=tool_use]` 的 `id` / `name` / `input`。
 *   · 工具结果：`user` → `message.content[type=tool_result]` 的 `tool_use_id` / `content` / `is_error`，
 *     顶层另有 `tool_use_result`——它是**工具的完整 Output 对象**（形状按工具名而定），
 *     能读它就不要再从文本里正则提取；读不到时记 `structured: null`。
 *   · 信封：`uuid` 只用来去重（与事件侧共用同一个 `state.seen`）；`message.id` → `vendorId`；
 *     `parent_tool_use_id` → **`subagentId`**（真机：`task_started.tool_use_id`、派生它的工具调用 id、
 *     子消息上的 `parent_tool_use_id` **三者同值** ⇒ 不需要另建关联表）。
 *   · `roundTrip`：按 `assistant.message.id` 去重计数（一次 API 往返 = 一条 id，流式响应按内容块
 *     多次到达、共享同一个 id）。**只数主循环**：`parent_tool_use_id` 非空的消息来自 Task 子智能体，
 *     与 `result.usage` 排除侧链同口径 ⇒ 子智能体消息沿用当前计数（它不是新的往返）。
 *   · `vendorTurn` / `step`：**这家没有**（恒 `null`）。不许拿 `roundTrip` 冒充 `vendorTurn`。
 *   · `chunk`：完整 assistant 消息恒 `'snapshot'`；开启 `includePartialMessages` 后同一条消息先出
 *     `'delta'`（`content_block_delta`，按 `index` 分组累积），再出完整快照。流式**只覆盖主会话**。
 *
 * 覆盖合并（§4.1 步骤 4，本家的关键坑）：同一个 `message.id` 会被**多条**投递，每条只带一个内容块
 * （思考 / 正文 / 工具调用各一条）⇒ 每条投递的块都是**新块**，只能追加到末尾；把它当成「整条消息的
 * 第 0 块」会让后到的块反复覆盖第一个。块序号按**首次到达**分配：流式那条通道先按
 * `content_block_start.index` 占号，随后的完整消息按 `content` 数组顺序对齐到同一批号。
 */
import type { SubagentRecord } from '@aieval/contracts';
import { asRecord, readNumber, readString } from '../../json';
import {
  createBlockIndexAllocator,
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  truncate,
  type BlockIndexAllocator,
  type MessageBlockDraft,
  type MessageDraft,
} from '../../message';
import type { TurnState } from '../../turn';

/** 子智能体消息的标记字段：非空即「主循环之外」（归属键与 `task_started.tool_use_id` 同值） */
const SIDE_CHAIN_FIELD = 'parent_tool_use_id';

/** 归一器的产出：0..n 条消息草稿 + 0..1 条子任务行 */
export interface ClaudeMessageOutput {
  messages: MessageDraft[];
  subagent: SubagentRecord | null;
}

/**
 * 归一器：**一份 run 一个**，由 `index.ts` 在 `start()` 里造好。
 *
 * 为什么需要状态：`message_start` 之后的所有增量必须落进**同一个**块序号空间，而完整 assistant
 * 消息随后还要对齐到同一批号（否则每个块都会分到新号、前一批累积值成了孤块）。
 */
export interface ClaudeMessageNormalizer {
  normalize: (raw: unknown, state: TurnState) => ClaudeMessageOutput;
}

export function createClaudeMessageNormalizer(): ClaudeMessageNormalizer {
  /** 流式消息的块序号分配器：`message_start` 时重建（`message.id` 用于与完整消息对齐） */
  let streaming: { messageId: string | null; allocator: BlockIndexAllocator } | null = null;

  /** 取走当前流式分配器（只在 `message.id` 对得上时）：完整消息要用同一批块序号 */
  const takeStreaming = (messageId: string | null): BlockIndexAllocator | null => {
    if (streaming === null) return null;
    if (messageId !== null && streaming.messageId !== null && messageId !== streaming.messageId) return null;
    const allocator = streaming.allocator;
    streaming = null;
    return allocator;
  };

  /**
   * 流式事件：只处理与内容块有关的三类（`message_start` / `content_block_delta` /
   * `content_block_stop`）；其余（`message_delta` / `message_stop`）不产出消息。
   *
   * ⚠️ 不认识的 `delta.type`（官方还会有 `citations_delta` 等）**按未知跳过**：
   * 当成正文或入参都会写坏内容。
   * ⚠️ **工具入参的分片（`input_json_delta`）不进消息层**：入参在完整 assistant 消息上已经是
   * 解析好的对象（`tool_use.input`），而流式那一格是 **JSON 片段**（`partial_json`）——把它当
   * `input` 落库会让消费方拿到半截字符串。工具调用按**块结束的完整快照**产出，这与
   * 「消费方只实现 snapshot 也能正确渲染」那条契约保证一致。
   */
  const streamEvent = (message: Record<string, unknown> | null, state: TurnState): MessageDraft[] => {
    const event = asRecord(message?.event);
    const kind = readString(event, 'type');
    if (kind === 'message_start') {
      streaming = { messageId: readString(asRecord(event?.message), 'id'), allocator: createBlockIndexAllocator() };
      return [];
    }
    if (kind !== 'content_block_delta') return [];
    const sourceIndex = readNumber(event, 'index');
    if (sourceIndex === null) return [];
    const delta = asRecord(event?.delta);
    const deltaType = readString(delta, 'type');
    // 流式事件只覆盖主会话（其 `parent_tool_use_id` 恒为 null）⇒ 归属与轮次都用主循环口径
    const allocator = streaming?.allocator ?? createBlockIndexAllocator();
    const index = allocator.forSource(sourceIndex);
    const identity = { kind: 'index' as const, index };
    const envelope = { roundTrip: roundTripOf(state), vendorId: null as string | null };
    if (deltaType === 'text_delta') {
      const text = readString(delta, 'text') ?? '';
      if (text === '') return [];
      return [deltaMessage(envelope, textBlockDraft(text, 'delta', identity))];
    }
    if (deltaType === 'thinking_delta') {
      const text = readString(delta, 'thinking') ?? '';
      if (text === '') return [];
      return [deltaMessage(envelope, thinkingBlockDraft(text, 'full', 'delta', null, identity))];
    }
    if (deltaType === 'signature_delta') {
      const signature = readString(delta, 'signature');
      if (signature === null || signature === '') return [];
      // 签名是**同一个思考块**的一部分（只进审计视图）⇒ 与正文落进同一个槽位
      return [deltaMessage(envelope, thinkingBlockDraft(null, 'none', 'delta', signature, identity))];
    }
    return [];
  };

  /** 主循环 assistant 消息 → 一条快照消息，块序号优先沿用流式那一批 */
  const assistant = (raw: unknown, message: Record<string, unknown> | null, state: TurnState): ClaudeMessageOutput => {
    const payload = asRecord(message?.message);
    const content = payload?.content;
    if (!Array.isArray(content)) return EMPTY;
    const parentCallId = readString(message, SIDE_CHAIN_FIELD);
    const subagentId = parentCallId === null || parentCallId === '' ? null : parentCallId;
    const allocator = takeStreaming(readString(payload, 'id')) ?? createBlockIndexAllocator();
    const blocks: MessageBlockDraft[] = [];
    content.forEach((rawBlock, position) => {
      const block = asRecord(rawBlock);
      const type = readString(block, 'type');
      const identity = { kind: 'index' as const, index: allocator.forSource(position) };
      if (type === 'text') {
        const text = readString(block, 'text');
        if (text !== null && text !== '') blocks.push(textBlockDraft(text, 'snapshot', identity));
        return;
      }
      if (type === 'thinking') {
        const text = readString(block, 'thinking');
        blocks.push(
          thinkingBlockDraft(
            text === null || text === '' ? null : text,
            text === null || text === '' ? 'none' : 'full',
            'snapshot',
            readString(block, 'signature'),
            identity,
          ),
        );
        return;
      }
      if (type === 'tool_use') {
        const callId = readString(block, 'id');
        if (callId === null || callId === '') return;
        blocks.push(toolCallBlockDraft(callId, readString(block, 'name') ?? '', block?.input ?? null, undefined));
      }
    });
    if (blocks.length === 0) return EMPTY;
    return {
      messages: [
        {
          vendorId: readString(payload, 'id'),
          role: 'assistant',
          source: 'wire',
          roundTrip: roundTripOf(state),
          vendorTurn: null,
          step: null,
          parentCallId,
          subagentId,
          chunk: 'snapshot',
          blocks,
          raw,
        },
      ],
      subagent: null,
    };
  };

  return {
    normalize(raw, state) {
      const message = asRecord(raw);
      const uuid = readString(message, 'uuid');
      // 去重与事件侧共用一张表：同一条消息只归一出一次，重复投递（SDK 重放 / 续传）不再产出
      if (uuid !== null) {
        if (state.seen.has(uuid)) return EMPTY;
        state.seen.add(uuid);
      }
      const type = readString(message, 'type');
      if (type === 'assistant') return assistant(raw, message, state);
      if (type === 'user') return user(raw, message, state);
      if (type === 'stream_event') return { messages: streamEvent(message, state), subagent: null };
      if (type === 'system') return { messages: [], subagent: subagentRecord(message) };
      return EMPTY;
    },
  };
}

/** 流式增量消息的空壳：这一层拿不到 `vendorId`，`vendorTurn` / `step` 这家没有 */
function deltaMessage(envelope: { roundTrip: number; vendorId: string | null }, block: MessageBlockDraft): MessageDraft {
  return {
    vendorId: envelope.vendorId,
    role: 'assistant',
    source: 'wire',
    roundTrip: envelope.roundTrip,
    vendorTurn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'delta',
    blocks: [block],
    raw: null,
  };
}

/**
 * `user` 消息 → 工具结果消息（只处理带 `tool_result` 块的那些）。
 * `structured` 取顶层 `tool_use_result`（**不是** `message.content[].content`：后者是发给模型的那份
 * 字符串内容）；读不到就是 `null`——不填 `{}`。
 */
function user(
  raw: unknown,
  message: Record<string, unknown> | null,
  state: TurnState,
): ClaudeMessageOutput {
  const payload = asRecord(message?.message);
  const content = payload?.content;
  if (!Array.isArray(content)) return EMPTY;
  const parentCallId = readString(message, SIDE_CHAIN_FIELD);
  const blocks: MessageBlockDraft[] = [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (readString(block, 'type') !== 'tool_result') continue;
    const callId = readString(block, 'tool_use_id');
    if (callId === null || callId === '') continue;
    blocks.push(
      toolResultBlockDraft(callId, resultText(block?.content), {
        structured: message?.tool_use_result ?? null,
        isError: block?.is_error === true,
      }),
    );
  }
  if (blocks.length === 0) return EMPTY;
  return {
    messages: [
      {
        vendorId: null,
        role: 'tool',
        source: 'wire',
        // 工具结果属于**派生它的那次往返**：取当前计数（`assistant` 那条已经把它推进过）
        roundTrip: roundTripOf(state),
        vendorTurn: null,
        step: null,
        // 这一格是「派生这条消息的那次工具调用 id」：工具结果不派生任何东西 ⇒ `null`
        parentCallId: null,
        subagentId: parentCallId === null || parentCallId === '' ? null : parentCallId,
        chunk: 'snapshot',
        blocks,
        raw,
      },
    ],
    subagent: null,
  };
}

/**
 * `tool_result.content` → 结果文本：字符串直接用，数组取其中的 `text` 块（图片等非文本块不进文本）。
 * 超过上限由 `toolResultBlockDraft` 截断并置 `truncated`（结果正文与工具族统计都只看这一段）。
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return truncate(content).text;
  if (!Array.isArray(content)) return '';
  return truncate(
    content
      .map((entry) => readString(asRecord(entry), 'text') ?? '')
      .filter((text) => text !== '')
      .join('\n'),
  ).text;
}

/**
 * `system` 子类型 `task_started` / `task_notification` → 子任务行（spec v3 §3.3）。
 *
 * 三格的口径：
 *   · `status`：`task_notification.status` ∈ `completed` / `failed` / `stopped`；还没收到通知
 *     （`task_started`）时记 `running`——**状态与「状态是否采到」分开记**，`statusMissing` 恒 `null`
 *     （这一家的终态是原生字段，不存在「没采到」）。
 *   · `name` ← `task_started.description`；`kind` ← `subagent_type`。
 *   · `parentSubagentId` 恒 `null`：载荷里**没有父 id**（只有 `spawn_depth`）⇒ 层级只能用深度表达，
 *     **不推测**父节点。
 *   · 子任务级用量：`task_notification.usage` 是**另一种形状**（`total_tokens` / `tool_uses` /
 *     `duration_ms`），与契约的 `UsageTokens`（input / cached / output 三格必填）不同口径 ⇒ 拿不到
 *     合法的填法就整格记 `null`（**不编三个 0**）。
 */
function subagentRecord(message: Record<string, unknown> | null): SubagentRecord | null {
  const subtype = readString(message, 'subtype');
  if (subtype !== 'task_started' && subtype !== 'task_notification') return null;
  const identity = firstNonEmpty(readString(message, 'task_id'));
  if (identity === null) return null;
  return {
    subagentId: identity,
    // 名称与类型两条载荷同形；`task_notification` 上也可能缺（真机两格都在）
    name: readString(message, 'description'),
    kind: readString(message, 'subagent_type'),
    source: 'wire',
    status: subtype === 'task_started' ? 'running' : normalizeStatus(readString(message, 'status')),
    // 这一家的状态是原生字段 ⇒ 不存在「采不到」；未识别的取值归到 `unknown` 而不是留空
    statusMissing: null,
    // 结果摘要只在通知上（`summary`）；缺失就是 `null`，不拿状态文案顶替
    outcome: subtype === 'task_started' ? null : readString(message, 'summary'),
    parentSubagentId: null,
    usage: null,
  };
}

/** 厂商终态 → 契约值域：只认三个原生取值 + `running`，其余记 `unknown`（不猜成失败） */
function normalizeStatus(status: string | null): SubagentRecord['status'] {
  if (status === 'completed' || status === 'failed' || status === 'stopped' || status === 'running') return status;
  return 'unknown';
}

/** 还没数到往返时给 1：信封这一格是必填正整数（与 dsh 侧同一条处置） */
function roundTripOf(state: TurnState): number {
  return state.turns > 0 ? state.turns : 1;
}

/** 第一个非空字符串；都没有返回 null（**不编**） */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== '') return value;
  }
  return null;
}

const EMPTY: ClaudeMessageOutput = { messages: [], subagent: null };
