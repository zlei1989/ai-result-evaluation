/**
 * 事件发射与「未识别负载」投影：适配器产出的每一条事件都从这里出去。
 * 职责：
 *  1. 补 `seq`（**run 内自增，从 1 开始**）与 `at`（ISO 8601）。为什么由适配器给：`onEvent` 的签名被
 *     spec §5.6.2 钉死为 `(e: AgentEvent) => void`，而 `AgentEvent` 的 seq/at 是必填；落盘的最终 seq
 *     由 core 的 appendEvent 按文件重新分配（契约 §3.4），适配器这一层的序号不参与持久化语义。
 *  2. 提供把任意厂商负载折成日志事件的出口（§5.6.3：未识别事件不得静默丢弃）。
 * 注意：`onEvent` 是同步回调，本模块**不 await**、不做背压（§5.6.2）。
 */
import type { AgentEvent, UsageTiming, UsageTokens, UsageTurn } from '@aieval/contracts';
import { inspect } from 'node:util';

/** 适配器能发的三类事件；status / diff-summary / score / end 由编排层发（见「实现层修正」第 2 条） */
export type AgentEventDraft =
  /**
   * `summary` = **给人看的一句话**（可选，2026-09-29）：适配器认识这个形状时给一句人话，
   * `text` 仍是原始负载。卡片底部的活动行显示 `summary`，**绝不显示 JSON**（见 contracts 的 log 事件）。
   */
  | { type: 'log'; stream: 'stdout' | 'stderr'; text: string; summary?: string }
  /**
   * 计量快照：`turns` 是**门槛**（一次模型 API 往返算一次，见 `turn.ts` 的发射点），
   * `tokens` 采不到就是 null——绝不发三个 0（§5.6.3）。
   *
   * `timing`（2026-10-XX 新增）= 这一轮的时间数据（`totalMs` / `apiMs` / `ttftMs` / `source`）。
   * **这一格必填**（没有时间时写 `null`）：它与契约的 `.nullable()` 对齐，读侧因此只有两种形态
   * （`timing === null` ⇒ 未采集），不必再区分「键不存在」与「键是 null」——
   * 而这一层少一种形态，就少一处「某家用 undefined、某家用 null」的漂移。
   * 为什么不塞进 `tokens`：它们是**两把尺子**（`tokens` 是模型干的活，`timing` 是这段时间怎么花的），
   * 且来源不同（`tokens` 全部来自厂商载荷；`timing` 可能来自我们按事件/行时间戳现算——
   * 口径差异见契约里 `timing.source` 的注释，那是 tok/s 能不能横向比的关键）。
   */
  | {
    type: 'usage';
    tokens: UsageTokens | null;
    /**
     * **子智能体那一份**（2026-10-04）：与 `timing` 一样**这一层必填**（没有时写 `null`），
     * 契约那边是可选可空——读侧只有「有」「明确的 null」「老日志缺格」三态，
     * 而草稿层不必区分后两者（见 `withMeta`）。
     */
    subagentTokens: UsageTokens | null;
    /**
     * **子智能体那一份**轮次（2026-10-04）：与 `subagentTokens` 一样**这一层必填**（没有时写 `null`），
     * 契约那边是可选可空。`null` = 明确没采到（有子智能体但读不出轮次），`0` = 确实没有子智能体。
     * 为什么必填而不是可选：它决定界面画不画「轮次」那一格的拆分行，草稿层少一种形态就少一处漂移
     * （与 `timing` / `subagentTokens` 同一条处置）。
     */
    subagentTurns: number | null;
    /**
     * **这一条读数属于哪一轮**（2026-10-05）：与 `timing` / `subagentTokens` 一样**这一层必填**
     * （没有归属时写 `null`），契约那边是可选可空。`null` = 本条没给出归属 ⇒ 界面按时刻归位。
     */
    turn: UsageTurn | null;
    timing: UsageTiming | null;
    turns: number;
    /**
     * `tokens` 那一格是**厂商上报的权威值**还是**我们的跑动期估算**（A2，2026-10-07）。
     * 与 `timing` / `subagentTokens` 一样**这一层必填**：这一格没有「不知道」这一态——
     * 发事件的人总是知道手里这个数是自己算的还是厂商给的（骨架按 `tokensEstimated` 判、
     * codex 的收尾条是结算值）。必填换来的是「事件流里每一条 usage 都能自证来源」，
     * 消费方（编排层的跑动期回写段）因此不必在跑之前反查注册表的能力格。
     * 契约那边是 `.optional()`（磁盘上有老事件），那一种形态只可能来自**没过这一层**的调用方。
     */
    tokensBasis: 'reported' | 'estimated';
  }
  | { type: 'error'; message: string; stack?: string }
  /**
   * 厂商系统层事实（2026-10-04 新增）：这一次运行被下发了什么。
   *
   * 六格与契约一一对应，**各自可空**（`null` = 厂商没投送到我们能读的通道，**不是空数组**）。
   * 只在厂商真的投送了那一行时才发（真机：只有 claude 的 `system/init` 有），
   * 另两家**不发**——消费方据此整组走「厂商有数据但没投送」，而不是显示成一堆空值。
   */
  | {
    type: 'vendor-system';
    tools: string[] | null;
    slashCommands: string[] | null;
    agents: string[] | null;
    mcpServers: string[] | null;
    permissionMode: string | null;
    outputStyle: string | null;
  };

export interface EventEmitter {
  emit: (draft: AgentEventDraft) => void;
}

/** 造一个发射器：seq 在同一次 run 内单调递增 */
export function createEventEmitter(onEvent: (event: AgentEvent) => void): EventEmitter {
  let seq = 0;
  return {
    emit: (draft) => {
      seq += 1;
      onEvent(withMeta(draft, seq));
    },
  };
}

/**
 * 日志草稿。
 * `summary`（可选）= 这一行的人话版本；不认识那个形状的调用方留空即可——**不要**拿 `text` 凑。
 */
export function logDraft(stream: 'stdout' | 'stderr', text: string, summary?: string): AgentEventDraft {
  return summary === undefined ? { type: 'log', stream, text } : { type: 'log', stream, text, summary };
}

/** 未识别事件一律落成**保留原始负载**的日志事件（§5.6.3），不要在这里做任何取舍 */
export function unknownEventDraft(payload: unknown): AgentEventDraft {
  return logDraft('stdout', safeStringify(payload));
}

/**
 * 厂商系统层事实草稿（2026-10-04）。
 * 六格由调用方（各家的投影）取好——本函数只做形状搬运，**不补默认值**：
 * 取不到的格必须是 `null`，`[]` 与 `null` 在界面侧是两句不同的话（见契约里那条注释）。
 */
export function vendorSystemDraft(facts: {
  tools: string[] | null;
  slashCommands: string[] | null;
  agents: string[] | null;
  mcpServers: string[] | null;
  permissionMode: string | null;
  outputStyle: string | null;
}): AgentEventDraft {
  return { type: 'vendor-system', ...facts };
}

/**
 * 补 seq / at。
 * 为什么用 switch 而不是对象展开：展开联合类型会让 TS 收不到窄化，从而丢掉「事件成员漏了一个没写」
 * 这件事的编译期检查——那正是本层最容易静默出错的地方。
 */
function withMeta(draft: AgentEventDraft, seq: number): AgentEvent {
  const at = new Date().toISOString();
  switch (draft.type) {
    case 'log':
      // 没有 summary 就**不带这个键**：带上 `undefined` 会在「先序列化再解析」的路径上留下噪声，
      // 而读侧（contracts 的 `.optional()`）本来就把它当「没有」——两个形状别混着用
      return draft.summary === undefined
        ? { seq, at, type: 'log', stream: draft.stream, text: draft.text }
        : { seq, at, type: 'log', stream: draft.stream, text: draft.text, summary: draft.summary };
    case 'usage':
      // `timing` 恒带这一格（没有时间时是 `null`）：读侧只有「有数据」与「未采集」两态，
      // 不必区分「键不存在」与「键是 null」——这一层少一种形态就少一处漂移。
      return {
        seq,
        at,
        type: 'usage',
        tokens: draft.tokens,
        // 这一格**恒带**（没有子智能体时是 null）：与 `timing` 同一条处置，
        // 读侧因此只有「有值」与「未采集」两态，不必区分「键不存在」与「键是 null」
        subagentTokens: draft.subagentTokens,
        // 同上：轮次那一格也恒带（`null` = 没采到，`0` = 确实没有子智能体）
        subagentTurns: draft.subagentTurns,
        // 归属格恒带（没有归属时是 null）：读侧只有「有值」与「没有」两态
        turn: draft.turn,
        timing: draft.timing,
        // 来源格恒带（A2）：它没有「不知道」这一态，见 `AgentEventDraft` 那一格
        tokensBasis: draft.tokensBasis,
        turns: draft.turns,
      };
    case 'vendor-system':
      // 六格逐格照搬（含 `null`）：这一层不做任何取舍，见 `vendorSystemDraft`
      return {
        seq,
        at,
        type: 'vendor-system',
        tools: draft.tools,
        slashCommands: draft.slashCommands,
        agents: draft.agents,
        mcpServers: draft.mcpServers,
        permissionMode: draft.permissionMode,
        outputStyle: draft.outputStyle,
      };
    case 'error':
      return { seq, at, type: 'error', message: draft.message, stack: draft.stack };
  }
}

/**
 * 把任意值序列化成可读文本。
 * 为什么不用裸 JSON.stringify：它遇到循环引用或 BigInt 会抛，而它在实参位置求值——异常会原样冒进
 * 适配器主流程。丢事件比丢格式更糟，所以兜底走 util.inspect（能渲染循环引用与 BigInt，且不抛）。
 * 口径（评审 N2）：`inspect` 兜底**只保证可读，不保证可解析**——走到那一步说明原值本来就序列化不了
 * （循环引用 / BigInt / undefined），此时 `text` 不是合法 JSON；消费方（p5 的日志视图）按纯文本展示，
 * `unknownEventDraft` 的「保留原始负载」指的是内容不丢字段，不是「保证 JSON.parse 一定成功」。
 */
export function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    // undefined / 函数 / Symbol 会被 stringify 成 undefined，此时同样交给 inspect
    return text === undefined ? inspect(value) : text;
  } catch {
    return inspect(value, { depth: 6, breakLength: 120 });
  }
}
