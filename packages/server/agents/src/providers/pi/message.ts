/**
 * pi 的**消息归一**：把 `session.subscribe` 的原始载荷折成统一的 `AgentMessage`。
 * 事件投影在 `events.ts`（行级审计、计量、轮次与失败），本文件只管内容级视图。
 *
 * 取值路径（都是进程内事件对象，字段名取自厂商的 `.d.ts`）：
 *   · **助手消息**：`message_end.message`（`AssistantMessage`）——`content[]` 三种块
 *     （`{type:'text',text}` / `{type:'thinking',thinking,thinkingSignature,redacted}` /
 *     `{type:'toolCall',id,name,arguments}`）、`usage`、`stopReason`、`responseId`。
 *     `message_end` 是**权威快照**：`message_start` 与 `message_update` 的 `partial` 是
 *     **同一个被原地 mutate 的对象**，只承载增量与块骨架，收尾一律以 `message_end` 为准。
 *   · **工具结果**：`tool_execution_end.{toolCallId,toolName,result,isError}`，其中
 *     `result = {content,details,structuredContent}`（后两个是厂商自定义载荷）。
 *     `turn_end.toolResults[]` 是同一件事的另一份陈述（会话记录里的 `ToolResultMessage`）——
 *     本文件**只取执行事件那一条**：两条都投影会在同一个合并键上投两次快照。
 *   · **子智能体**：本家没有这一面（`messageCapability.subagent` 声明 `no` / `not-supported`）
 *     ⇒ 本文件不产出 `SubagentRecord`，也不给任何消息挂 `subagentId`。
 *
 * 三条硬口径：
 *   · **`raw` 必须是当场快照**：`partial` 会被后续帧原地改写，存引用会让已经交出去的消息
 *     在消费方手里变样（合并器按到达顺序读，读到的是「后来的内容」）；
 *   · **`source` 一律 `'wire'`**：数据全部来自进程内的厂商事件流，没有旁路通道；
 *   · **块序号取厂商的 `contentIndex`**：增量帧与快照必须落进同一个槽位，
 *     而厂商给增量的位次就是它在 `content[]` 里的下标（自己按到达顺序重新发号会让两者错位）。
 */
import type { UsageTokens } from '@aieval/contracts';
import { safeStringify } from '../../emit';
import { asRecord, readNumber, readString } from '../../json';
import {
  textBlockDraft,
  thinkingBlockDraft,
  toolCallBlockDraft,
  toolResultBlockDraft,
  usageTokens,
  type MessageBlockDraft,
  type MessageDraft,
} from '../../message';
import { PI_STRUCTURED_RESULT_PAYLOAD_TYPE } from './structured-output';

/**
 * 厂商载荷的**当场快照**。
 *
 * 为什么不能直接存引用：pi 的助手消息块是**被原地 mutate** 的（`message_update` 的每个增量
 * 都改同一个 `partial`）。存引用的话，合并器与落盘侧随后读到的会是「最后那一版」，
 * 于是刚落的一条消息会被后面的帧悄悄改写——症状是「增量与快照内容对不上」。
 *
 * JSON 往返是这里能拿到的最保真的快照；序列化不了的值（循环引用 / BigInt）退回可读文本，
 * **绝不抛**：快照失败不该打断一次正在跑的运行。
 */
export function snapshotPiPayload(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return safeStringify(value);
  }
}

/**
 * pi 的 `Usage` → 契约的计量形状。
 *
 * 字段映射（逐条对过厂商的 `.d.ts`）：
 *   · `input` → `input`（**非缓存输入**，与本契约同义，不做减法）；
 *   · `cacheRead` → `cached`；
 *   · `output` → `output`；
 *   · `reasoning` → `reasoningOutput`——厂商文档逐字写着它是 `output` 的**子集**
 *     ⇒ 三格相加时**不许**把它并进 `output`（并了就是双计，而症状是「这家 tok 偏大」）；
 *   · `totalTokens` → `total`（厂商自报原文，不参与本仓的恒等式）；
 *   · `cacheWrite` / `cacheWrite1h` / `cost`：契约里没有对应的格，**丢弃**——
 *     钱的账本不在本仓（行级成本这一格不存在）。
 *
 * 三格（`input` / `cacheRead` / `output`）缺任何一项就是 `null`（**不填 0**）：
 * 「没采到」与「确实是 0」在界面上是两句不同的话。两个可选格读不到同样是 `null`。
 */
export function readPiUsageTokens(usage: unknown): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, 'input');
  const cached = readNumber(record, 'cacheRead');
  const output = readNumber(record, 'output');
  if (input === null || cached === null || output === null) return null;
  return usageTokens({
    input,
    cached,
    output,
    reasoningOutput: readNumber(record, 'reasoning'),
    total: readNumber(record, 'totalTokens'),
  });
}

/**
 * 助手消息里的**答复正文**：`content[]` 中 `type === 'text'` 的非空块，按顺序用换行拼接。
 *
 * 为什么按块类型过滤而不是按 `text` 字段取值：思考块装的是 `thinking` 字段、两者不重名，
 * 但厂商将来多一种带 `text` 的块时，「按字段取值」会把不是答复的内容混进最终答复。
 * 过滤条件只有这一份，`events.ts` 与消息归一都从这里取。
 */
export function piAssistantReply(message: unknown): string {
  return contentText(asRecord(message)?.content);
}

/**
 * 结构化输出的**工具参数** → 一条助手快照草稿（正文由 `adoptStructuredArguments` 给出，两处同一份）。
 *
 * 为什么要造这条消息：产物在工具参数里，而两条消费通路都只认「助手消息」这一种载体——
 * 评分通路读 `AgentRunResult.finalText`（那条路由 `state.finalText` 来），对话视图读消息流。
 * 只写 `state.finalText` 会让「这份 JSON 是本轮的答复」在产物里无处可查（一致性套件要求
 * `finalText` 必须是产物里某一条主会话答复正文）；只发消息不写 `state.finalText` 又会让评分通路
 * 拿不到它。两处都写，且**共用同一个字符串**。
 *
 * 为什么合法：被 strict 约束的工具调用在协议上就是助手消息的一部分（anthropic 的 `tool_use` 块、
 * openai 的 `tool_calls`），这条快照是那段参数在对话视图里的文本投影，不是凭空拼的内容。
 * `chunk` 记 `'snapshot'`（它一次性到位，没有增量形态），`usage` 记 `null`
 * （它不是一次独立的模型往返，没有属于它自己的用量）。
 */
export function piStructuredResultDraft(args: unknown, text: string, roundTrip: number): MessageDraft {
  return {
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip,
    // 与 `piAssistantMessageDraft` 同一条口径：厂商不给轮号 / 步骤号就不编
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    blocks: [textBlockDraft(text, 'snapshot')],
    usage: null,
    raw: { type: PI_STRUCTURED_RESULT_PAYLOAD_TYPE, arguments: args },
  };
}

/**
 * 助手消息 → 一条 `snapshot` 消息草稿。
 *
 * 块序号取**厂商的 `contentIndex`**（= 该块在 `content[]` 里的下标）：增量帧用的是同一个位次，
 * 两者因此落进同一个槽位，`message_end` 的快照按合并规则覆盖掉增量累积值。
 *
 * 三种块的取舍：
 *   · `text`：空串块**不发**（空块落进对话视图只是一片空白）；
 *   · `thinking`：`redacted === true`（厂商把正文替换成密文/占位串）或正文为空时
 *     正文记 `null`、档位记 `'none'`——**不回落**成摘要或空串冒充全文；
 *   · `toolCall`：`arguments` 在 pi 上**已经是对象**（不需要像 dsh 那样解析 JSON 字符串），
 *     原样交给公共草稿函数（族载荷与摘要都由它一处算）。
 *
 * 一条块都没有时返回 `null`（不发明一个空壳消息）。
 */
export function piAssistantMessageDraft(message: unknown, roundTrip: number): MessageDraft | null {
  const record = asRecord(message);
  const content = record?.content;
  if (!Array.isArray(content)) return null;
  const blocks: MessageBlockDraft[] = [];
  content.forEach((rawBlock, contentIndex) => {
    const block = asRecord(rawBlock);
    const type = readString(block, 'type');
    const identity = { kind: 'index' as const, index: contentIndex };
    if (type === 'text') {
      const text = readString(block, 'text');
      if (text !== null && text !== '') blocks.push(textBlockDraft(text, 'snapshot', identity));
      return;
    }
    if (type === 'thinking') {
      const text = readString(block, 'thinking');
      const hasText = block?.['redacted'] !== true && text !== null && text !== '';
      blocks.push(
        thinkingBlockDraft(
          hasText ? text : null,
          hasText ? 'full' : 'none',
          'snapshot',
          readString(block, 'thinkingSignature'),
          identity,
        ),
      );
      return;
    }
    if (type === 'toolCall') {
      const callId = readString(block, 'id');
      if (callId === null || callId === '') return;
      blocks.push(toolCallBlockDraft(callId, readString(block, 'name') ?? '', block?.['arguments'] ?? null));
    }
  });
  if (blocks.length === 0) return null;
  return {
    vendorId: readString(record, 'responseId'),
    role: 'assistant',
    source: 'wire',
    roundTrip,
    // pi 的 `turn_start` 不带序号、assistant 消息也没有厂商轮号/步骤号 ⇒ 两格恒 null（不编）
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    /**
     * 这条消息**自己那一次往返**的用量（不是累计、不进任何合计）。骨架的合并器对它是
     * 「带值覆盖、缺省保留」：增量帧不带它，快照那一次带。
     */
    usage: readPiUsageTokens(record?.usage),
    blocks,
    raw: snapshotPiPayload({ type: 'message_end', message: record }),
  };
}

/**
 * `message_update` 的一个增量帧 → 一条 `delta` 消息草稿；不是正文/思考增量时返回 `null`。
 *
 * 只有两种帧进对话视图：`text_delta` / `thinking_delta`。三处刻意不处理：
 *   · `toolcall_delta` 是**未解析完的 JSON 片段**，把它当 `tool-call` 块的 `input` 会渲染出半截对象，
 *     而权威值就在紧随其后的 `message_end` 快照里（`arguments` 已是对象）⇒ 不投影；
 *   · `*_start` / `*_end` 只是块的边界（`*_end` 的 `content` 与快照重复）；
 *   · `start` / `done` / `error` 是流级帧，用量与失败都由 `message_end` 那条权威快照承载。
 *
 * ⚠️ 本函数**只产消息、不产行级事件**：一条增量一行 `log` 会把「原始输出」面板刷成 JSON 流水，
 * 而那正是「未识别负载落兜底」那条路最贵的一种回归。
 */
export function piDeltaMessageDraft(frame: unknown, roundTrip: number): MessageDraft | null {
  const record = asRecord(frame);
  const contentIndex = readNumber(record, 'contentIndex');
  if (contentIndex === null) return null;
  const delta = readString(record, 'delta');
  if (delta === null || delta === '') return null;
  const identity = { kind: 'index' as const, index: contentIndex };
  const type = readString(record, 'type');
  if (type !== 'text_delta' && type !== 'thinking_delta') return null;
  return {
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'delta',
    // 增量帧不带用量（用量只在收尾的 `message_end` 上）⇒ 合并器的「缺省保留」保住快照那一份
    usage: null,
    blocks: [
      type === 'thinking_delta'
        ? thinkingBlockDraft(delta, 'full', 'delta', null, identity)
        : textBlockDraft(delta, 'delta', identity),
    ],
    raw: snapshotPiPayload({ type: 'message_update', assistantMessageEvent: record }),
  };
}

/**
 * 工具结果的**正文**：`result.content[]` 里 `type === 'text'` 的非空块，按顺序用换行拼接。
 * 拿不到文本时返回空串（调用方据此决定要不要给摘要），**不**把整个 `result` 序列化成正文——
 * 那是排障载荷，落进结果块只会把真正的输出挤掉。
 */
export function piToolResultText(event: unknown): string {
  return contentText(asRecord(asRecord(event)?.result)?.content);
}

/**
 * `tool_execution_end` → 一条 `snapshot` 工具结果消息草稿。
 *
 * 信封的两格是这里的要点：
 *   · `parentCallId` 取 `toolCallId`：合并键因此逐调用唯一（同一轮里多次工具调用各占一条载体），
 *     消费方也靠这一格把结果块配回它的调用块；
 *   · `roundTrip` 取**当前已数到的往返号**：工具是那次调用的后续，不新起一轮
 *     （新的一轮由紧随其后的 `turn_start` 开）。
 *
 * `structured` 取 `result.details`（厂商自定义载荷；`read` 给行数、`edit` 给 diff 那一类），
 * 没有再退到 `structuredContent`，都没有就是 `null`——**不填 `{}`**（「没采到」与「空对象」不同）。
 */
export function piToolResultMessageDraft(event: unknown, roundTrip: number): MessageDraft | null {
  const record = asRecord(event);
  const callId = readString(record, 'toolCallId');
  if (callId === null || callId === '') return null;
  const result = asRecord(record?.result);
  return {
    // 厂商没有给工具结果消息 id ⇒ `toolCallId` 是这一条最稳的身份（合并键里也有它）
    vendorId: callId,
    role: 'tool',
    source: 'wire',
    roundTrip,
    turn: null,
    step: null,
    parentCallId: callId,
    subagentId: null,
    chunk: 'snapshot',
    // 工具结果不来自任何一次模型调用 ⇒ 消息级用量恒 null
    usage: null,
    blocks: [
      toolResultBlockDraft(callId, piToolResultText(record), {
        structured: result?.['details'] ?? result?.['structuredContent'] ?? null,
        isError: record?.['isError'] === true,
      }),
    ],
    raw: snapshotPiPayload({
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: readString(record, 'toolName'),
      isError: record?.['isError'] === true,
      durationMs: readNumber(record, 'durationMs'),
      result,
    }),
  };
}

/** `content[]` 里 `type === 'text'` 的非空块，按顺序用换行拼接（形状不对就是空串，不抛） */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}
