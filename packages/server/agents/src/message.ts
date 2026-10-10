/**
 * 适配器公共层：把三家的原始形状**归一成同一条消息流**的实现只有这一份。
 *
 * 为什么集中一处：块序号分配、覆盖合并、缺失表达这三件事在三家**逐字相同**，抄三遍必然漂移，
 * 而漂移的症状是「同一件事在 A 家能渲染、在 B 家丢块或多块」——最难查的一类问题。
 * 厂商差异全部通过「归一草稿」（`MessageDraft`）注入：各家只负责把厂商载荷翻译成草稿，
 * 序号、合并、`chunk` 形态由本模块统一决定。
 *
 * 本模块实现消息合并的全部规则：
 *   1. **合并键** = `(subagentId ?? 'main', roundTrip, 载体, 块标识)`。
 *      `载体` = 该块所属消息的 `role` 与 `parentCallId`（同一轮里 assistant 消息与工具结果消息
 *      各自从 0 起算块序号，只带块序号会把工具结果盖到正文块上）；
 *      `块标识` = 文本块与思考块用 `blockIndex`（该逻辑消息内的序号，**按首次到达顺序分配、
 *      一经分配不再变化**），工具调用块与工具结果块用 `callId`（同轮多次调用因此互不覆盖）。
 *   2. **收到 `delta`**：片段追加进该键的累积缓冲区；
 *      **收到 `snapshot`**：其内容**覆盖**该键的缓冲区与最终内容（不追加、不拼接）。
 *      claude-code 把同一个 `message.id` 按内容块分多次投递（每条只带一个块）⇒ 新块只能
 *      **追加到末尾**，同键才覆盖；把它当成「整条消息的第 0 块」会让后到的块反复覆盖第一个。
 *   3. **`snapshot` 之后到达的同键 `delta` 丢弃**：快照按定义已含它之前的内容，追加会写重。
 *   4. 合并键**不含 `messageId`**：同一个块的 delta 与 snapshot 是两条消息，配对只靠上面的键。
 *
 * 每一块**最终都要到一个 snapshot**（dsh 在 `block-end`、claude-code 在流式事件之后的完整
 * assistant 消息上、codex 的条目本身就是快照），只有进程被中断的块例外 ⇒ 由 `assembly` 标记
 * 「这块收尾了没有」，消费方据此区分「未收尾」而不是拿 `truncated` 冒充
 * （`truncated` 是 `tool-result` 块自己的字段，文本块与消息都没有这一格）。
 */
import type {
  AgentMessage,
  ChunkKind,
  ContentBlock,
  MessageRole,
  MessageSource,
  ToolFamily,
  TruncationState,
  UsageTokens,
} from '@aieval/contracts';
import { toolPayloadOf } from './tool-payload';
import { toolCallHint } from './activity';
import { classifyTool } from './tool-family';

/** 工具结果的文本上限：超出即截断，`truncation` 记 `{ kind: 'truncated' }`（结果正文与工具族统计都只看这一段） */
export const TOOL_RESULT_MAX_CHARS = 20_000;

/** 块标识：文本块与思考块用块序号，工具块用调用 id */
export type BlockIdentity = { kind: 'index'; index: number } | { kind: 'call'; callId: string };

/**
 * 归一草稿的块：**阶段**决定合并方式，`identity` 决定合并键。
 * `'delta'` 只对 text / thinking / tool-call 有意义（工具结果没有增量形态）。
 */
export type MessageBlockDraft =
  | { phase: 'snapshot'; identity: BlockIdentity; block: ContentBlock }
  | { phase: 'delta'; identity: BlockIdentity; block: ContentBlock };

/**
 * 一条消息的归一草稿。信封字段由各家按各自的取值路径填写；
 * `blocks` 的顺序 = 到达顺序（合并器按块标识归位，不按数组下标）。
 */
export interface MessageDraft {
  /** 厂商侧消息/条目 id；厂商没有则为 `null` */
  vendorId: string | null;
  role: MessageRole;
  source: MessageSource;
  /** 模型往返序号，从 1 递增（三家均为合成值） */
  roundTrip: number;
  /** 厂商轮号；无则为 `null` */
  turn: number | null;
  /** 一轮内的第几次调用；无则为 `null` */
  step: number | null;
  /** 派生这条消息的那次工具调用 id；无则为 `null` */
  parentCallId: string | null;
  /** 子智能体身份；主线程消息为 `null` */
  subagentId: string | null;
  chunk: ChunkKind;
  blocks: MessageBlockDraft[];
  /**
   * 这条消息**自己那一次模型调用**的用量。**草稿层必填**（没有就写 `null`）：
   * 三家都必须显式交这一格 ⇒ `tsc` 会把全部构造点列出来，不会出现「某家 `undefined`、某家 `null`」的漂移
   * （与 `timing` / `subagentTokens` 同一条处置）。它与行级累计口径无关：不是累计、不进任何合计。
   */
  usage: UsageTokens | null;
  /** 该条消息的原始载荷（未归类字段原样保留，供排障） */
  raw: unknown;
}

/** 一个块槽位的内部状态：累积缓冲区 + 最终内容 + 是否已收到快照 */
interface BlockSlot {
  identity: BlockIdentity;
  block: ContentBlock;
  /** 已收到过 snapshot ⇒ 同键 delta 丢弃、`assembly` 记为 `'snapshot'` */
  sealed: boolean;
}

/** 一个「逻辑消息」（合并键里除块标识外的部分）的槽位表 */
interface Carrier {
  key: string;
  /** 块标识 → 槽位（保持插入顺序 = 首次到达顺序） */
  slots: Map<string, BlockSlot>;
  /** 已分配出去的文本/思考块序号：新块只能追加到末尾 */
  nextIndex: number;
  /** 这条逻辑消息到目前为止采到的用量（带值覆盖、缺省保留，见 `ingest`） */
  usage: UsageTokens | null;
}

export interface MessageAssemblerOptions {
  /** 消息 id 前缀，形如 `<runId>`；最终 `messageId` 是 `<runId>:<seq>` */
  runId: string;
}

/**
 * 消息合并器：跨消息存活（一份 run 一个），负责块序号分配、覆盖合并与 `messageId` 分配。
 *
 * 用法：
 * ```ts
 * const assembler = createMessageAssembler({ runId });
 * for (const draft of drafts) assembler.ingest(draft, (message) => onMessage(message));
 * ```
 */
export interface MessageAssembler {
  /**
   * 吃进一条归一草稿，可能产出**一条**消息（`onMessage` 同步调用）。
   * 产出的是该逻辑消息**到现在为止的完整块列表**（不是本次新增的那几块）：
   * 消费方按合并键覆盖即可，不必自己维护累积状态——「只实现 snapshot 也能正确渲染」
   * 这条契约保证就落在这里。
   */
  ingest: (draft: MessageDraft, onMessage: (message: AgentMessage) => void) => void;
  /** 已产出的消息条数（诊断用，也是 `seq` 的当前值） */
  readonly emitted: number;
}

export function createMessageAssembler(options: MessageAssemblerOptions): MessageAssembler {
  const carriers = new Map<string, Carrier>();
  let seq = 0;

  return {
    get emitted(): number {
      return seq;
    },
    ingest(draft, onMessage) {
      if (draft.blocks.length === 0) return;
      const carrierKey = carrierKeyOf(draft);
      let carrier = carriers.get(carrierKey);
      if (carrier === undefined) {
        carrier = { key: carrierKey, slots: new Map(), nextIndex: 0, usage: null };
        carriers.set(carrierKey, carrier);
      }
      /**
       * 带值覆盖、缺省保留：同一条逻辑消息会多次投递（增量块 / `block-end` 快照），
       * 而用量只在完整 `assistant/message` 那一次到达 ⇒ 后到的投递不带它时**必须保留**已采到的值
       * （改成「后到覆盖」会把已经采到的计量抹掉，界面上表现为页脚自己消失）。
       * 也不累加：它是「这一次调用」的值，累加是行级 `tokens` 那一格的事。
       */
      if (draft.usage !== null) carrier.usage = draft.usage;
      for (const blockDraft of draft.blocks) {
        applyBlock(carrier, blockDraft);
      }
      seq += 1;
      const slots = [...carrier.slots.values()];
      onMessage({
        messageId: `${options.runId}:${seq}`,
        vendorId: draft.vendorId,
        role: draft.role,
        source: draft.source,
        roundTrip: draft.roundTrip,
        turn: draft.turn,
        step: draft.step,
        parentCallId: draft.parentCallId,
        subagentId: draft.subagentId,
        chunk: draft.chunk,
        // 每一块都收到过快照才算收尾（只要有块停在增量累积值上，这条消息就是「未收尾」）
        assembly: slots.every((slot) => slot.sealed) ? 'snapshot' : 'open',
        // 合并键随信封一起带走：消费方不必自己反推「哪些消息属于同一条逻辑消息」
        mergeKey: carrier.key,
        blocks: slots.map((slot) => slot.block),
        // 这条逻辑消息到目前为止采到的用量（带值覆盖、缺省保留，见上面那一支）
        usage: carrier.usage,
        raw: draft.raw,
      });
    },
  };
}

/**
 * 合并键里除「块标识」外的部分（`载体`）。
 * `parentCallId` 参与载体：同一个 roundTrip 里，派发子任务的工具调用消息与它的结果消息各自
 * 从 0 起算块序号，只用 `role` 会把主线程消息与子智能体消息串在一起。
 *
 * **导出**：叫 codex 的适配器要在**交出去之前**按合并键比内容（运行期刷新时
 * 只交变化的那几条，见 `providers/codex/index.ts` 的 `changedMessages`）。
 * 它自己在那边拼一遍 `载体` 会造成**两套合并键**——一旦漂移，去重就会漏（表现为
 * `messages.jsonl` 里同一条逻辑消息出现两份快照），故这里只留一份实现。
 */
export function carrierKeyOf(draft: MessageDraft): string {
  return [draft.subagentId ?? 'main', String(draft.roundTrip), draft.role, draft.parentCallId ?? '-'].join('|');
}

/** 块标识 → 合并键里的那一段（同一 carrier 内唯一） */
function identityKey(identity: BlockIdentity): string {
  return identity.kind === 'index' ? `i:${identity.index}` : `c:${identity.callId}`;
}

/**
 * 把一个块草稿落进它的槽位。四种情形，每一种都有靶子：
 *   · **新键 + 快照**：分配槽位（文本/思考块取下一个序号），内容即快照；
 *   · **新键 + 增量**：分配槽位并以该片段起头；
 *   · **已有键 + 增量**：追加（文本拼字符串、思考拼字符串、工具入参拼 JSON 片段）；
 *   · **已有键 + 快照**：**覆盖**（含已 seal 的槽位被新快照更新——dsh 的 `block-end` 会在
 *     `usage` 之后再补一份，claude-code 的完整 assistant 消息也会在流式之后重投同一个块）；
 *   · **已 seal + 增量**：丢弃（快照已含它之前的内容，追加会写重）。
 */
function applyBlock(carrier: Carrier, draft: MessageBlockDraft): void {
  const key = identityKey(draft.identity);
  const slot = carrier.slots.get(key);
  if (slot === undefined) {
    carrier.slots.set(key, { identity: draft.identity, block: draft.block, sealed: draft.phase === 'snapshot' });
    // 文本块与思考块按首次到达顺序占号：新块只能追加到末尾
    if (draft.identity.kind === 'index' && draft.identity.index >= carrier.nextIndex) {
      carrier.nextIndex = draft.identity.index + 1;
    }
    return;
  }
  if (draft.phase === 'snapshot') {
    slot.block = draft.block;
    slot.sealed = true;
    return;
  }
  if (slot.sealed) return;
  slot.block = mergeDelta(slot.block, draft.block);
}

/**
 * 增量合并：同一块的片段追加到累积缓冲区。
 * 三处「同型才合并」的判据都按**块的 type** 走：形状意外（例如增量说 text、槽位是 tool-call）
 * 时取新的那一份而不是拼出一个四不像——类型不匹配本身就是「厂商换了形状」的信号，
 * 拼接只会把它藏起来。
 */
function mergeDelta(current: ContentBlock, incoming: ContentBlock): ContentBlock {
  if (current.type === 'text' && incoming.type === 'text') {
    return { type: 'text', text: current.text + incoming.text };
  }
  if (current.type === 'thinking' && incoming.type === 'thinking') {
    return {
      type: 'thinking',
      text: `${current.text ?? ''}${incoming.text ?? ''}`,
      // 增量只带正文时文本档位沿用当前值：`textKind` 是随能力一起声明的事实，不由片段改写
      textKind: incoming.textKind === 'none' ? current.textKind : incoming.textKind,
      /**
       * 签名**只能保留、不能由增量改写**：三家的增量通道都不带签名（claude 的
       * `signature_delta` 按「非渲染增量」表不进通道，codex / dsh 结构上没有），而这一格在契约里
       * 是**必填**（`signature: string | null`，快照路径会给真值）⇒ 合并时必须原样带过去。
       * 注意它**不是**「后到覆盖」那一类：增量到不了这里，写 `incoming.signature ?? current.signature`
       * 会让人以为增量可以带签名。
       */
      signature: current.signature,
    };
  }
  if (current.type === 'tool-call' && incoming.type === 'tool-call') {
    return { ...current, input: incoming.input };
  }
  return incoming;
}

/**
 * 块序号分配器：**每个「载体」一个实例**（载体 = `subagentId ?? 'main'` + `roundTrip`
 * + `role` + `parentCallId`），三家用同一份实现。
 *
 * 它的存在只为一条规则：**新块只能追加到末尾，序号一经分配不再变化**。
 * 号源是该载体里已经开过的块数，所以：
 *   · claude-code 的多次投递（每个完成的内容块一条消息）各占一个新号；
 *   · dsh 的 `chunk.index` 是**该次模型输出内**的序号（每次输出都从 0 起），
 *     直接拿它当块序号会让第二次输出的第 0 块盖掉第一次输出的第 0 块 ⇒ 必须先过这里换算成
 *     「该载体内的第几个块」；
 *   · codex 的每个条目本身就是一个块，一次分配一个。
 */
export interface BlockIndexAllocator {
  /** 取下一个块序号（每次调用都前进一格） */
  next: () => number;
  /**
   * 按厂商给的**输出内序号**取「该载体内的第几个块」，同一个厂商序号只分配一次。
   * 增量片段与它后面的块结束快照必须落进同一个槽位，靠的就是这张映射。
   */
  forSource: (sourceIndex: number) => number;
}

export function createBlockIndexAllocator(): BlockIndexAllocator {
  let next = 0;
  const bySource = new Map<number, number>();
  return {
    next: () => {
      const index = next;
      next += 1;
      return index;
    },
    forSource: (sourceIndex: number) => {
      const existing = bySource.get(sourceIndex);
      if (existing !== undefined) return existing;
      const index = next;
      next += 1;
      bySource.set(sourceIndex, index);
      return index;
    },
  };
}

/** 文本块草稿（`phase` 见 `MessageBlockDraft`） */
export function textBlockDraft(
  text: string,
  phase: ChunkKind,
  identity: BlockIdentity = { kind: 'index', index: 0 },
): MessageBlockDraft {
  return { phase, identity, block: { type: 'text', text } };
}

/**
 * 思考块草稿。
 * `textKind` 是**厂商侧的事实**（`'full'` 完整推理 / `'summary'` 厂商摘要 / `'none'` 有思考但无文本），
 * 由各家按自己那条通道填；拿不到正文时 `text` 记 `null` 而**不是空串**（空串会被读成「模型想了空」）。
 */
export function thinkingBlockDraft(
  text: string | null,
  textKind: 'full' | 'summary' | 'none',
  phase: ChunkKind,
  signature: string | null = null,
  identity: BlockIdentity = { kind: 'index', index: 0 },
): MessageBlockDraft {
  return { phase, identity, block: { type: 'thinking', text, textKind, signature } };
}

/**
 * 工具调用块草稿。
 * `input` 传厂商原文（codex 与 dsh 的 `arguments` 是 JSON 字符串，**调用方先解析成对象**再传）；
 * `family` 由 `classifyTool` 按工具名判定，判不出来就是 `null`（消费方走通用渲染）。
 *
 * **族载荷在这一处归一**：`payload` 由 `toolPayloadOf(family, input)` 从厂商原文算出
 * （见 `tool-payload.ts`）。放在这个咽喉点而不是各家的 `message.ts` 里，是因为三家的工具调用
 * **全部**流经本函数——每家各写一遍必然漂移，而漂移的症状是「同一族的卡片在某一家上是空的」。
 *
 * **摘要也在这一处生成**：`summary` 取 `toolCallHint(name, input)`——
 * **只有冒号后面那一段**（`Check surefire report summaries`），不带 `调用工具 <名>：` 前缀。
 * 为什么去掉前缀（用户口径）：这一格有**两个消费方**，而它们对前缀的需求相反——
 *   · **工具行**（`ToolItemDetail` 的摘要行）把工具名渲染成一个独立元素 ⇒ 带前缀就是同一件事说两遍；
 *   · **活动行**（卡片底部那一行）只有一行、名字必须在句子里 ⇒ 它取 `toolCallSummary(...)`
 *     （同一个词表加前缀），不是把这一格拿去用。
 * 词表真源仍只有 `activity.ts` 一处：界面按分层表不许 import `agents`，故那句人话随块给出，
 * 浏览器不必把「描述优先 / 每族拼法 / 截断」再实现一遍。
 */
export function toolCallBlockDraft(
  callId: string,
  name: string,
  input: unknown,
  family: ToolFamily | null = classifyTool(name),
): MessageBlockDraft {
  return {
    phase: 'snapshot',
    identity: { kind: 'call', callId },
    block: {
      type: 'tool-call',
      callId,
      family,
      name,
      input,
      payload: toolPayloadOf(family, input),
      summary: toolCallHint(name, input),
    },
  };
}

/**
 * 工具结果块草稿。
 * `structured` **未采集就是 `null`**（不是 `{}`）；
 * `truncation` 记**截断三态**：这里只可能给 `none`（本函数自己截了才算）或 `unknown`
 * （厂商的截断标记**没采到**——拿不到标记时不许写成「确认完整」，那正是「用负信号断言正事实」）。
 */
export function toolResultBlockDraft(
  callId: string,
  text: string,
  options: { structured?: unknown; isError: boolean; truncation?: TruncationState } = { isError: false },
): MessageBlockDraft {
  const clipped = truncate(text);
  return {
    phase: 'snapshot',
    identity: { kind: 'call', callId },
    block: {
      type: 'tool-result',
      callId,
      structured: options.structured ?? null,
      isError: options.isError,
      text: clipped.text,
      // 未被本函数截断时只有厂商标记能给「确认完整」；这里拿不到厂商标记 ⇒ `unknown`
      truncation: options.truncation ?? (clipped.truncated ? { kind: 'truncated', reason: `超过 ${TOOL_RESULT_MAX_CHARS} 字符` } : { kind: 'unknown' }),
    },
  };
}

/** 附件块草稿 */
export function attachmentBlockDraft(
  kind: 'image' | 'file',
  path: string | null,
  mimeType: string | null,
): MessageBlockDraft {
  return { phase: 'snapshot', identity: { kind: 'call', callId: path ?? kind }, block: { type: 'attachment', kind, path, mimeType } };
}

/** 超过上限就截断，并把「截过」这件事显式带出来（消费方要能区分「原文就这么长」与「我们截了」） */
export function truncate(text: string, max = TOOL_RESULT_MAX_CHARS): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(0, max), truncated: true };
}

/**
 * 工具名 → 族：**表在 `tool-family.ts`**。
 *
 * 为什么表不在这里：`message.ts` 要用 `toolCallSummary`（`activity.ts`），而 `activity.ts` 要用
 * `classifyTool`（本文件）——表留在任何一边都会造成循环 import。两个消费方都只依赖
 * `tool-family.ts`，一边一份表就会漂（「同一个名字在两处判出不同的族」是最难查的一类）。
 */
export { classifyTool } from './tool-family';

/**
 * 造一份**形状恒定**的计量：两个可选格恒带（缺就是 `null`，不是缺席）。
 *
 * 为什么不让各家各写一遍：`reasoningOutput` / `total` 在类型上是 `number | null | undefined` 三态，
 * 各家分别构造时会出现「一家留 `undefined`、另一家写 `null`」，而下游（面板、导出、快照）就得判
 * 三种形态 ⇒ 少一种形态就少一处漂移。三格必填值与厂商原文一个都不改，这里只做形状归一。
 */
export function usageTokens(input: {
  input: number;
  cached: number;
  output: number;
  reasoningOutput?: number | null;
  total?: number | null;
}): UsageTokens {
  return {
    input: input.input,
    cached: input.cached,
    output: input.output,
    reasoningOutput: input.reasoningOutput ?? null,
    total: input.total ?? null,
  };
}
