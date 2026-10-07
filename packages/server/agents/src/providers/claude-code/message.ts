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
 *   · 信封：`uuid` 只用来去重（**本侧一张表**，不与事件侧共用——共用会让消息被整批丢掉，
 *     见 `createClaudeMessageNormalizer` 里 `seen` 的注释）；`message.id` → `vendorId`；
 *     `parent_tool_use_id` → **`subagentId`**（真机：`task_started.tool_use_id`、派生它的工具调用 id、
 *     子消息上的 `parent_tool_use_id` **三者同值** ⇒ 不需要另建关联表）。
 *   · `roundTrip`：按 `assistant.message.id` 去重计数（一次 API 往返 = 一条 id，流式响应按内容块
 *     多次到达、共享同一个 id）。**主会话与侧链各数各的**（`roundTripOfSession`，2026-10-05 修正）：
 *     主会话仍是 `state.turns` 那一套（`events.ts` 的 `countModelRoundTrip` 只数主循环），
 *     而 `parent_tool_use_id` 非空的侧链消息按**该子会话自己的** 1..N 编号——进子会话节点时
 *     时间轴因此按它自己的轮次分行（与 codex 的 `threadMessages` 同形：那家本来就是一线程一套号）。
 *     ⚠️ **改前是共用一个计数器**（侧链沿用主会话当前的号）⇒ 子会话节点整条时间轴只有 1 个轮次行
 *     （真机 run `2921fee3`）。⚠️ 2026-10-05 加这一条时的**直接理由**是「让收尾那批子会话逐轮读数
 *     落进自己的行」，而那批读数已于 **2026-10-06 删除**（成本与收益不成比例，见 `index.ts` 的
 *     `finalize` 注记）——**这条编号保留**，因为它独立地决定子会话节点好不好读。
 *   · `vendorTurn` / `step`：**这家没有**（恒 `null`）。不许拿 `roundTrip` 冒充 `vendorTurn`。
 *   · 子任务行：`system` 下的 `task_started` / `task_notification` → `SubagentRecord`。⚠️ **但不是每一条都算**
 *     （2026-10-05，spec §4 **R19**）：CLI 也给**非 Agent 的后台任务**发这两条（真机：子智能体自己那条
 *     带 `description` 的 Bash），照 subtype 收下就会在派发面板里多出一条**幽灵「子任务」**。
 *     判据是**形状**（`ClaudeTaskShape` / `isDispatchShaped`），判决结果随每条 `task_*` 帧一起返回
 *     （`ClaudeMessageOutput.taskShape`）——它是 `index.ts` 那份「事实核对名单」的唯一来源。
 *   · `chunk`：完整 assistant 消息恒 `'snapshot'`；开启 `includePartialMessages` 后同一条消息先出
 *     `'delta'`（`content_block_delta`，按 `index` 分组累积），再出完整快照。流式**只覆盖主会话**
 *     （`stream_event` 的 `parent_tool_use_id` 恒为 null）；它的轮次号走**同一个** `roundTripOfSession`
 *     ——拿得到归属就按那一会话数，拿不到就是主会话那一档。
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

/** 归一器的产出：0..n 条消息草稿 + 0..1 条子任务行 + 这一帧的形状判决 */
export interface ClaudeMessageOutput {
  messages: MessageDraft[];
  subagent: SubagentRecord | null;
  /** 这一帧的 `task_*` 形状判决；不是 `task_*` 帧时为 `null`（判据与三档的含义见 `ClaudeTaskShape`） */
  taskShape: ClaudeTaskShape | null;
}

/**
 * `task_*` 帧的**形状判决**（spec 2026-10-04 §4 **R19** 的裁定）。
 *
 * 为什么要它：CLI 的 `task_started` / `task_notification` **不只给真派发的 `Task`**，也给**非 Agent
 * 的后台任务**——真机那一条是子智能体自己跑的 Bash（wire 上的「名字」就是那条命令的 `description`，
 * `parentToolUseId` 是**子智能体自己那次调用**的 id ⇒ 面板里看着像一次嵌套派发），而盘上**永远没有**
 * 它的转录。只认 `task_id` + subtype 就会把它收成一条子任务行（幽灵行），并让收尾为它喊一句
 * 「读不到子智能体」——一句把 Bash 任务叫成子智能体的假话。
 *
 * 三档（判决只按 **start 帧**做，见 `isDispatchShaped`；收场帧按同一个 id 追随）：
 *   · `'dispatch'`：**形状像一次派发** ⇒ 产子任务行，且这个 id 进 `index.ts` 的事实核对名单；
 *   · `'phantom'`：已证实**不是**派发（它那条 `start` 帧三格全空）⇒ **不产子任务行**、也不进名单；
 *   · `'unjudged'`：**只见到收场帧**（没有 `start` 可判形状）⇒ 照产子任务行（**丢一个真派发比多一条
 *     幽灵行更坏**，用户裁定），但**不进名单**——它不是「形状像派发」的证据 ⇒ 两格照算，**不**因它整格
 *     `null`；而**盘上没有它的转录**时由 `index.ts` 落一条**不说它是子智能体**的 WARN
 *     （「可能少算它（无法判定它是不是子智能体）」——既不静默少算，也不假装判定得了）。
 */
export type ClaudeTaskShape = 'dispatch' | 'phantom' | 'unjudged';

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
  /**
   * **消息侧自己的去重表**（`uuid → 已处理`）。
   *
   * ⚠️ **不能与事件侧共用 `state.seen`**（2026-10-03 实测的真缺陷）：`project` 总是先跑事件投影
   * （`projectClaudeMessage`），它会把这一条的 `uuid` 记进 `state.seen`；随后本归一器读到同一张表，
   * 于是一条 `assistant` / `user` 消息**全部被判成重复并丢弃** ⇒ `messages.jsonl` 一行都不写、
   * 抽屉里永远是「还没有日志」，而 `events.jsonl` 里内容齐全。
   *
   * 两侧的去重**意图**本来就不同（文件头：事件按 `uuid` 去重、消息按内容块归并），
   * 故这里各持一张表；共享的只有 `TurnState` 里的轮次计数与 `seen` 之外的那几格。
   */
  const seen = new Set<string>();

  /**
   * **形状判决的两张账**（`taskId → 结论`，一份 run 一张）。
   *
   * 为什么要按 id 记账、而不是逐帧判：**收场帧不承载形状证据**——本仓的审计投影只在 `start` 相位写那三格
   * （`events.ts` 的 `subagentDraft` 里 `if (isStart)` 那一支），而 CLI 的会话转录里**根本没有** `task_*` 帧
   * ⇒ 厂商那边收场帧长什么样，我们**从未观测到**（**未知 ≠ 缺失**，别把它写成「三格缺」）。
   * ⇒ 逐帧判就是**拿一个不承载证据的帧去判**：每一个真派发的收场帧都会被判成幻影，面板那一行永远停在
   * `running`、抽屉里那一格用量永远「未采集」。
   * 故判决只在 `task_started` 上做，收场帧按同一个 id 追随——这正是这两张账存在的唯一理由。
   */
  const dispatchIds = new Set<string>();
  const phantomIds = new Set<string>();

  /** 流式消息的块序号分配器：`message_start` 时重建（`message.id` 用于与完整消息对齐） */
  let streaming: { messageId: string | null; allocator: BlockIndexAllocator } | null = null;

  /**
   * **每会话自己的轮次号账**（`SessionRoundIds`）。
   *
   * 主会话**不在这张账上**：它的号一直由 `state.turns` 那一套给出（`events.ts` 的
   * `countModelRoundTrip` 只数主循环），本次改动一个字节都没碰它（见 `roundTripOfSession`）。
   */
  const sessionRoundIds: SessionRoundIds = new Map();

  /** 取走当前流式分配器（只在 `message.id` 对得上时）：完整消息要用同一批块序号 */
  const takeStreaming = (messageId: string | null): BlockIndexAllocator | null => {
    if (streaming === null) return null;
    if (messageId !== null && streaming.messageId !== null && messageId !== streaming.messageId) return null;
    const allocator = streaming.allocator;
    streaming = null;
    return allocator;
  };

  /**
   * 一条 `task_*` 帧的形状判决（三档的含义见 `ClaudeTaskShape`）。
   *
   * 状态只有两张 id 账（`dispatchIds` / `phantomIds`），判据只有 `isDispatchShaped` 一处；
   * 判决只在 `task_started` 上做（收场帧按 id 追随，理由见那两张账的注释）。
   * 缺 `task_id` 时两张账都记不了（`subagentRecord` 也不会为它产行）：start 帧仍按自己的形状回答，
   * 收场帧只能是 `'unjudged'`——**不猜**。
   */
  const classifyTask = (message: Record<string, unknown> | null, isStart: boolean): ClaudeTaskShape => {
    const taskId = firstNonEmpty(readString(message, 'task_id'));
    if (isStart) {
      const shaped = isDispatchShaped(message);
      if (taskId !== null) (shaped ? dispatchIds : phantomIds).add(taskId);
      return shaped ? 'dispatch' : 'phantom';
    }
    if (taskId === null) return 'unjudged';
    // 已证实是幻影的那一条：它的收场帧同样不产行（否则幽灵行会从收场帧那一侧回来）
    if (phantomIds.has(taskId)) return 'phantom';
    return dispatchIds.has(taskId) ? 'dispatch' : 'unjudged';
  };

  /**
   * `system` 帧里与子任务有关的两类（`task_started` / `task_notification`）→ 0..1 条子任务行 + 形状判决。
   * 其余 `system` 帧（`init` 等）在这一层不产任何东西（`taskShape` 为 `null`，与「不是 task 帧」同义）。
   */
  const subagentFrame = (message: Record<string, unknown> | null): ClaudeMessageOutput => {
    const subtype = readString(message, 'subtype');
    if (subtype !== 'task_started' && subtype !== 'task_notification') {
      return { messages: [], subagent: null, taskShape: null };
    }
    const taskShape = classifyTask(message, subtype === 'task_started');
    // 幻影**不产行**（面板里那条幽灵「子任务」就是它）；`'unjudged'` 照产（丢一个真派发比多一行更坏）
    if (taskShape === 'phantom') return { messages: [], subagent: null, taskShape };
    return { messages: [], subagent: subagentRecord(message), taskShape };
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
    /**
     * 流式事件真机上只覆盖主会话（其 `parent_tool_use_id` 恒为 null），但**归属与轮次照样按会话解析**：
     * 这一格拿得到就照实归位，拿不到就是主会话那一档——**不许让它无条件掉进主会话的号里**
     * （合并键 `subagentId | roundTrip | role | parentCallId` 里这两格都在：一条侧链增量若顶着
     * 主会话的号、身份又是 `null`，就会与主会话同一轮的块挤进同一个载体）。
     * 侧链那一档的号取自 `message_start` 记下的那个 `message.id` ⇒ 它的增量与随后的**完整快照**
     * 落在同一个号上（合并键里的轮次号必须稳定，否则一条逻辑消息会被劈成两条、增量永远收不了尾）。
     * ⚠️ **主会话那一档与改前逐字相同**（仍是 `state.turns` 的**当前值**，这里不 +1）：推进主循环
     * 计数的是 `events.ts` 的 `countModelRoundTrip`，它只认**完整** assistant 消息 ⇒ 主会话增量的号是
     * 「上一条完整消息那一轮」。这是**既有口径、本次不动**（动它就改了主会话的号，而本次只修侧链）。
     */
    const parentCallId = readString(message, SIDE_CHAIN_FIELD);
    const subagentId = parentCallId === null || parentCallId === '' ? null : parentCallId;
    const allocator = streaming?.allocator ?? createBlockIndexAllocator();
    const index = allocator.forSource(sourceIndex);
    const identity = { kind: 'index' as const, index };
    const envelope = {
      roundTrip: roundTripOfSession(state, sessionRoundIds, subagentId, streaming?.messageId ?? null),
      vendorId: null as string | null,
      parentCallId,
      subagentId,
    };
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
    const parentCallId = readString(message, SIDE_CHAIN_FIELD);
    const subagentId = parentCallId === null || parentCallId === '' ? null : parentCallId;
    /**
     * 轮次**先记**（在任何早退之前）：数与块无关——一条消息占一轮，靠的是它**是**一条 `assistant`
     * 消息（有 `message.id`），而不是「有没有我们认得出来的块」。少了这一句，一条我们不产块的消息
     * 会让**后面每一轮**的号都差一（同一轮里的块与轮次号错位）。
     * ⚠️ 主会话那一支（`subagentId === null`）读的是 `state.turns`，**没有副作用**，行为不变。
     */
    const roundTrip = roundTripOfSession(state, sessionRoundIds, subagentId, readString(payload, 'id'));
    const content = payload?.content;
    if (!Array.isArray(content)) return EMPTY;
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
          roundTrip,
          vendorTurn: null,
          step: null,
          parentCallId,
          subagentId,
          chunk: 'snapshot',
          /**
           * 消息级用量：**claude 交不出来**（这个网关下流式快照的 `output_tokens` 恒 0，
           * 真值只在收尾的 `result.usage` 上，而那不是「这条消息」的）⇒ 一律 `null`（不是 0）。
           */
          usage: null,
          blocks,
          raw,
        },
      ],
      subagent: null,
      taskShape: null,
    };
  };

  return {
    normalize(raw, state) {
      const message = asRecord(raw);
      const uuid = readString(message, 'uuid');
      // 去重**只在本侧**做（见 `seen` 的注释：与事件侧共用一张表会让消息被整批丢掉）
      if (uuid !== null) {
        if (seen.has(uuid)) return EMPTY;
        seen.add(uuid);
      }
      const type = readString(message, 'type');
      if (type === 'assistant') return assistant(raw, message, state);
      if (type === 'user') return user(raw, message, state, sessionRoundIds);
      if (type === 'stream_event') return { messages: streamEvent(message, state), subagent: null, taskShape: null };
      // `task_*` 帧要走形状判决（幻影不产行），其余 `system` 帧与子任务无关
      if (type === 'system') return subagentFrame(message);
      return EMPTY;
    },
  };
}

/**
 * 流式增量消息的空壳：这一层拿不到 `vendorId`，`vendorTurn` / `step` 这家没有。
 * 归属两格（`parentCallId` / `subagentId`）与轮次号都由调用方按会话解析好带进来——
 * 它们与完整快照的取值**同一处**（`roundTripOfSession`），增量的块才能落进快照那个载体。
 */
function deltaMessage(
  envelope: {
    roundTrip: number;
    vendorId: string | null;
    parentCallId: string | null;
    subagentId: string | null;
  },
  block: MessageBlockDraft,
): MessageDraft {
  return {
    vendorId: envelope.vendorId,
    role: 'assistant',
    source: 'wire',
    roundTrip: envelope.roundTrip,
    vendorTurn: null,
    step: null,
    parentCallId: envelope.parentCallId,
    subagentId: envelope.subagentId,
    chunk: 'delta',
    // 消息级用量：这一家交不出来（见 `assistant` 那一支的注释）⇒ `null`；增量那一档更没有
    usage: null,
    blocks: [block],
    raw: null,
  };
}

/**
 * `user` 消息 → 工具结果消息（只处理带 `tool_result` 块的那些）。
 * `structured` 取顶层 `tool_use_result`（**不是** `message.content[].content`：后者是发给模型的那份
 * 字符串内容）；读不到就是 `null`——不填 `{}`。
 *
 * `sessionRoundIds` 是归一器那份**每会话轮次号账**（本函数在工厂之外，只能显式传进来）：
 * 工具结果的轮次号要按**它所属的那个会话**取（见下面那一格）。
 */
function user(
  raw: unknown,
  message: Record<string, unknown> | null,
  state: TurnState,
  sessionRoundIds: SessionRoundIds,
): ClaudeMessageOutput {
  const payload = asRecord(message?.message);
  const content = payload?.content;
  if (!Array.isArray(content)) return EMPTY;
  const parentCallId = readString(message, SIDE_CHAIN_FIELD);
  const subagentId = parentCallId === null || parentCallId === '' ? null : parentCallId;
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
        /**
         * 工具结果属于**派生它的那次往返**：取**该会话当前**的号（`messageId` 传 `null` ⇒ 不新开一轮）。
         * 主会话取的就是 `state.turns`（`assistant` 那条已经把它推进过），
         * 侧链取的是**那个子会话自己**当前的号（同样是它上一条 `assistant` 推进过的）
         * ——两档与改前的主会话行为逐字相同，只是侧链不再借用主会话的号。
         */
        roundTrip: roundTripOfSession(state, sessionRoundIds, subagentId, null),
        vendorTurn: null,
        step: null,
        // 这一格是「派生这条消息的那次工具调用 id」：工具结果不派生任何东西 ⇒ `null`
        parentCallId: null,
        subagentId,
        chunk: 'snapshot',
        // 消息级用量：工具结果消息**恒**没有（`usage` 只可能挂在模型产出上，这一格不是 0）
        usage: null,
        blocks,
        raw,
      },
    ],
    subagent: null,
    taskShape: null,
  };
}

/**
 * **「形状像一次派发」的判据**（spec §4 R19 的裁定）：`subagent_type` / `spawn_depth` / `prompt`
 * **至少一格非 `null`**（**不是**「非空串 / 非零」：`''` 与 `0` 都算「给了」——刻度由 `message.test.ts`
 * 的「刻度」那条用例钉住；判严了会把一个真派发判成幻影，那比幽灵行更坏）。
 *
 * 实测（三个 claude 真机产物，`D:\.tmp\aieval\runs\…`）：真派发那条 `task_started` **三格齐**
 * （`general-purpose` / `1` / 783 字的 prompt），而 CLI 给非 Agent 任务发的条目**三格全缺**
 * （它 wire 上的「名字」就是那条 Bash 的 `description`）⇒ 这条判据把两者分得干净。
 *
 * ⚠️ **只对 `task_started` 用**（`classifyTask` 是唯一的调用方）：**收场帧不承载形状证据**——
 * 审计投影只在 `start` 相位写那三格，CLI 的会话转录里又没有 `task_*` 帧可查 ⇒ 厂商的收场帧长什么样
 * **我们从未观测到**（未知 ≠ 缺失）。逐帧判 = 拿一个不承载证据的帧去判，会把每个真派发的收场帧判成幻影。
 * ⚠️ **字符串按「非 `null`」判**（不是「非空串」）：这是裁定逐字的口径，而它偏向**保**——
 * 一个只带 `''` 的真派发会因此留住自己的行（多一行面板，可形状判据的代价）；反过来判会**丢一个真派发**，
 * 那比多一条幽灵行更坏（同一条取舍见 `ClaudeTaskShape` 的 `'unjudged'`）。
 */
function isDispatchShaped(message: Record<string, unknown> | null): boolean {
  return (
    readString(message, 'subagent_type') !== null
    || readNumber(message, 'spawn_depth') !== null
    || readString(message, 'prompt') !== null
  );
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
 *   · `parentCallId` ← **`tool_use_id`**（`task_started` / `task_progress` / `task_notification`
 *     都带这一格）：它是**派生这个子任务的那次工具调用 id**，与子消息上的 `parent_tool_use_id`、
 *     `Agent` 工具调用块的 `callId` 三者同值（真机逐条核过 2026-10-03）。**没有它，界面上的
 *     「进入子任务」入口只能靠任务名去猜**，而猜不中时整棵子任务在时间轴上不可达。
 *   · `parentSubagentId` 恒 `null`：载荷里**没有父 id**（只有 `spawn_depth`）⇒ 层级只能用深度表达，
 *     **不推测**父节点。
 *   · 子任务级用量：`task_notification.usage` 是**另一种形状**（`total_tokens` / `tool_uses` /
 *     `duration_ms`），与契约的 `UsageTokens`（input / cached / output 三格必填）不同口径 ⇒ 拿不到
 *     合法的填法就整格记 `null`（**不编三个 0**）。
 *
 * ⚠️ **本函数不判形状**（它只回答「这一条 `task_*` 描述的子任务行长什么样」）：唯一调用方是
 * `subagentFrame`，而它已经用**形状判决**把幻影挡在外面了（`ClaudeTaskShape`）。别单独调它——
 * 那等于绕开 R19 的判据、把 CLI 的非 Agent 任务重新收成一条子任务行。
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
    // 派生它的那次工具调用 id：`task_notification` 上实测也有这一格，取不到就 `null`（不猜）
    parentCallId: firstNonEmpty(readString(message, 'tool_use_id')),
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

/** **每会话自己的轮次号账**：`会话身份（= 子消息上的 parent_tool_use_id） → (message.id → 轮次号)`（主会话不进这张账） */
type SessionRoundIds = Map<string, Map<string, number>>;

/** 该会话**当前**的轮次号（= 已经数到的去重 id 个数；一个都没数到时给 1，与 `roundTripOf` 同一条处置） */
function currentRoundOf(rounds: ReadonlyMap<string, number>): number {
  return rounds.size > 0 ? rounds.size : 1;
}

/**
 * 一条消息该带哪个轮次号——**按会话各数各的**（spec `…-claude-subagent-own-usage-design` §2.5）。
 *
 * 为什么要按会话分开数（2026-10-05 真机冒烟抓出来的缺口，run `2921fee3` 的 claude 行 `71e35c51`）：
 * 改前所有消息**共用一个计数器**（`state.turns` 口径）⇒ 子会话那 37 条消息的 `roundTrip`
 * **全等于父会话派发那一轮**（真机 = 3），而界面按 `message.roundTrip` 给**每个会话节点**分轮
 * （`build-model.ts`）⇒ 子会话节点整条时间轴只有 **1 个轮次行**，它自己那几十条消息全挤在那一行里。
 *
 * ⚠️ **它当初的直接目的（让收尾那批子会话逐轮读数对齐自己的行）已于 2026-10-06 取消**——那批读数
 * 的成本与收益不成比例，已删除（见 `index.ts` 的 `finalize` 注记）。**这一条保留**：它独立地回答
 * 「子会话节点按什么分轮」，且与 codex 的 `threadMessages`（一线程一套号）保持同一形态。
 *
 * 判据：按 `parent_tool_use_id` 分组，每组数**去重后的 `assistant.message.id` 个数**，首次出现顺序 = 1..N。
 *
 * 三档：
 *   · **主会话**（`subagentId === null`）：`roundTripOf(state)`，**原样**不动；
 *   · **侧链**：该会话自己的 1..N（不同子会话各自从 1 起、互不干扰，也不吃主会话的号）；
 *   · **`messageId === null`**（形状异常，没有归并键）：**不新开一轮**，如实回落到**该会话当前**
 *     的号（= 已经数到的个数，一个都没数到时给 1，与主会话那条 `roundTripOf` 同一条处置）。
 *     ⚠️ 这一档对**工具结果**（`user` 消息）是常态而不是异常：工具结果属于派生它的那次往返，
 *     本来就该取当前号（与主会话那条注释逐字同一条口径）。
 *
 * ⚠️ **拿不到 `parent_tool_use_id` 的那一档**（`null` **或空串**，形状异常）：它归不到任何子会话，
 * 只能按**主会话**那一档给号（`subagentId === null` 那一支）。这是**如实回落**而不是兜底猜测：
 * 手上没有能把它认到某个子会话上去的证据，编一个号比沿用主会话号更坏——而且 `subagentId` 那一格
 * 也会是 `null`（`assistant` / `user` 里「`''` 与 `null` 同处置」的写法逐字如此），界面按主会话归位，
 * **号与归属至少是自洽的**。真机上这一档不可达：`forwardSubagentText` 打开之后子消息**必带**这一格
 * （官方逐字「Forward subagent text and thinking blocks as assistant/user messages with
 * `parent_tool_use_id` set」）。
 */
function roundTripOfSession(
  state: TurnState,
  sessionRoundIds: SessionRoundIds,
  subagentId: string | null,
  messageId: string | null,
): number {
  if (subagentId === null) return roundTripOf(state);
  let rounds = sessionRoundIds.get(subagentId);
  if (rounds === undefined) {
    rounds = new Map();
    sessionRoundIds.set(subagentId, rounds);
  }
  // 没有归并键 ⇒ 没有「这是第几轮」可言：取该会话**当前**的号，不新开一轮（与主会话同一条处置）
  if (messageId === null) return currentRoundOf(rounds);
  const known = rounds.get(messageId);
  if (known !== undefined) return known;
  // 首次出现 ⇒ 占下一个号（同一个 id 的后几次投递（按内容块）因此稳定回到这里）
  const round = rounds.size + 1;
  rounds.set(messageId, round);
  return round;
}

/** 第一个非空字符串；都没有返回 null（**不编**） */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== '') return value;
  }
  return null;
}

const EMPTY: ClaudeMessageOutput = { messages: [], subagent: null, taskShape: null };
