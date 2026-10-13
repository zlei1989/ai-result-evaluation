/**
 * pi 的事件投影：`session.subscribe` 的原始事件 → 行级事件 + 消息草稿 + 计量。
 *
 * ## 事件全集与取舍
 *
 * 真机一轮完整序列（带工具调用）：`agent_start` → `turn_start` → `message_start/end`（system、user）
 * → `message_start`（assistant）→ `message_update`（`text_start` / `text_delta`* / `thinking_delta`* /
 * `toolcall_delta`）→ `message_end`（assistant）→ `tool_execution_start` → `tool_execution_update`*
 * → `tool_execution_end` → `message_start/end`（toolResult）→ `turn_end` → 下一轮 `turn_start` …
 * → `agent_end` → `agent_settled`。另有会话级事件：`auto_retry_*`、`compaction_*`、
 * `summarization_retry_*`、`queue_update`、`entry_appended`、`bash_execution_update`、
 * `session_info_changed`、`thinking_level_changed`。
 *
 * 三档处置：
 *   · **产消息**：`message_update`（增量）/ `message_end`（助手快照）/ `tool_execution_end`（结果）；
 *   · **产事件 + 计量**：`turn_start` / `message_end`（助手）/ `agent_settled`；
 *   · **其余（含未识别）**：一条保留原始负载的 `log`——**什么都不丢**，但也不假装认识。
 *
 * ## 结束信号：`agent_settled` 是唯一的那一个
 *
 * `agent_end` **不是**结束：它之后还可能有 auto-retry（默认退避 2/4/8 s）、compaction 与排队输入
 * （`steer` / `followUp`）。本文件的 `agent_end` 走通用兜底（只落一条原始负载），
 * 真正收尾的是 `agent_settled`。SDK 侧与之配套：`prompt()` 也是在 settled 时才 resolve。
 *
 * ## 失败：只能从 `stopReason` / `errorMessage` 读
 *
 * `prompt()` **永不抛**（传输失败、被中止、自带超时全是 resolve），所以失败姿态只有一条通道：
 * 助手 `message_end` 的 `stopReason` 与 `errorMessage`。厂商给的是**裸英文短句**
 * （`Connection error.` / `Request timed out.` / `terminated`），不带 host、不带状态码，
 * 共用的归因层够不着 ⇒ 本文件先把它们翻成带 host 的中文原因，再交给 `classifyAgentMessage`。
 *
 * ## 停止的三种来源与 `watchdogFired`
 *
 * 用户点「终止」/ 看门狗开火 / 宿主停机**都**从骨架的 `interrupt()` 进来，而 `agent_settled.aborted`
 * 分不出谁停的。适配器能拿到的唯一判据是 `input.signal` 有没有翻转（用户终止会让它翻转）——
 * 见 `PiRunState.watchdogFired`。结论本身由骨架定（用户终止 → `canceled`、看门狗 → `timed-out`），
 * 这一格只负责把「谁停的」如实写进日志。
 *
 * ## 实现义务：思考正文与工具结果正文必须进 `log`
 *
 * `messageCapability` 声明 `needsMessagesForReasoningEvidence: false`——它的**前提**就是这一层：
 * 助手消息的原始负载（含 `content[]` 里的思考正文、工具入参、用量）与工具执行事件的原始负载
 * （含结果正文）逐条落成 `log`，因此 `events.jsonl` 单独一份就有完整的推理与工具证据。
 * ⛔ 不要在这两条上做过滤、摘要化或截断：它们是那条声明成立的**唯一**依据。
 * 与之配套的是**增量帧绝不产事件**（见 `piDeltaMessageDraft`）：原始输出面板一旦被增量刷屏，
 * 上面那两条证据也就没人看得见了。
 *
 * ## 计量与轮次
 *
 *   · `tokens` ← `message_end.message.usage`，逐次往返**累加**（`reasoning` 是 `output` 的子集，
 *     不相加进 `output`）；`cost` 丢弃（本仓没有成本格）；
 *   · `turns` ＝ **一次模型往返**，在 `turn_start` 上 +1：真机上它与助手 `message_end` 条数恒等，
 *     而它**先到**——按 `message_end` 数会让第 N+1 轮的增量帧落进第 N 轮那条消息里；
 *   · `subagentTokens` / `subagentTurns`：裸 pi 结构上没有子智能体面 ⇒ `{0,0,0}` / `0`
 *     （「确实没有」与「有但没采到」的 `null` 是两句不同的话）。
 *
 * ## 时长：只用厂商那一把尺子
 *
 * 助手消息自带 `timestamp`（厂商记的请求起点）与 `durationMs`（厂商从起点量到响应收尾），
 * 两者同源 ⇒ 时间跨度的两端与 `apiMs` 全取它，整格记 `'vendor'`。首字延迟**恒为 `null`**：
 * 它只能我们按自己的时钟测（estimated），塞进这一格就是两把尺子混用，而 `mergeTiming`
 * 对来源不一致的处置是**整格作废**——宁可少一格，不可给一个看似可比的数。
 */
import type { SubagentRecord, UsageTokens, UsageTurn } from '@aieval/contracts';
import { subagentSettledSummary, toolCallSummary, toolErrorSummary } from '../../activity';
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type AgentFailure, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import { usageTokens, type MessageDraft } from '../../message';
import type { TimingSpan, TurnFinalize, TurnProjection, TurnState } from '../../turn';
import { addUsage, sumUsageTokens } from '../../usage';
import {
  piAssistantMessageDraft,
  piAssistantReply,
  piDeltaMessageDraft,
  piStructuredResultDraft,
  piToolResultMessageDraft,
  piToolResultText,
  readPiUsageTokens,
} from './message';
import {
  PI_SUBAGENT_DISPATCH_TOOL,
  piSubagentRecord,
  readPiSubagentDetails,
  type PiSubagentEvent,
  type PiSubagentRecorder,
} from './subagents';
import type { PiSubagentTranscript } from './transcript';
import {
  PI_STRUCTURED_OUTPUT_TOOL,
  adoptStructuredArguments,
  isStructuredResultMessage,
  noteTextReply,
  type StructuredOutputProjection,
} from './structured-output';

/**
 * 一次运行的投影状态：骨架的 `TurnState` 是三家共用的形状，这里只放 pi 自己的两格
 * （与 dsh 的子会话白名单同一条处置：另起一个对象随闭包走，不污染共用形状）。
 */
export interface PiRunState {
  /** 收到过停止请求（用户终止 / 看门狗 / 宿主停机都从骨架的 `interrupt()` 进来） */
  stopRequested: boolean;
  /**
   * 停止请求**不是用户点的**（看门狗开火或宿主停机）。
   *
   * 为什么必须自己记：`agent_settled.aborted` 分不出「用户停的」与「看门狗停的」。用户终止会让
   * `input.signal` 翻转（编排层 abort 的就是它），看门狗与宿主停机都不碰它 ⇒ 这是适配器这一层
   * 唯一的判据。它只影响日志措辞，不影响结论（结论由骨架按停止来源给 `canceled` / `timed-out`）。
   */
  watchdogFired: boolean;
  /**
   * 本行到目前为止**厂商自报**的模型往返时间合计（毫秒）：每条助手消息的 `durationMs` 逐轮相加。
   *
   * 为什么要自己累加而不是只交当轮那一个数：`usage.timing.apiMs` 与 claude 的 `duration_api_ms`
   * 是同一格，口径必须是「这一行花在模型往返上的总时间」——只交最后一轮会让跨家对比变成两种口径。
   * 与 tokens 同一条处置：交给骨架的永远是「到目前为止」。
   */
  apiMsTotal: number;
  /**
   * 这一行**派发过**子智能体（见过一次 `Agent` 工具调用）。
   *
   * 为什么不是「有没有子任务行」：行只在收场那一刻才造得出来，而子智能体可能在整行跑完时还在跑。
   * 这一格判的是「本行的计量里有没有子这一份」——有派发就必须按「有子智能体」那三档处置，
   * 否则跑动期会报出 `{0,0,0}` 那句「**确实没有**子智能体」，与事实相反。
   */
  dispatched: boolean;
  /**
   * 派发工具调用的入参（`toolCallId` → `Agent` 的 `name` 参数）。
   * 为什么要留：`tool_execution_end` 的事件里**没有 `args`**（只有 `toolCallId` / `toolName` /
   * `result` / `isError` / `durationMs`），而「这一次派发的名字」只出现在入参里。
   */
  dispatchNames: Map<string, string | null>;
  /**
   * 已收场的派发记录（`agentId` → 这一行的收尾快照），键是**子智能体身份**。
   *
   * 为什么要按身份而不是按工具调用登记：收尾要拿它去总线那一条上对账（总线载荷只有身份），
   * 而 `turnCount` 只出现在 `Agent` 工具结果的 `details` 里。两边的唯一公共键就是身份。
   */
  dispatches: Map<string, PiDispatch>;
}

/** 一次派发在收尾那一刻留下的三格事实（见 `PiRunState.dispatches`） */
export interface PiDispatch {
  /** 派发它的那次 `Agent` 工具调用 id（子任务行的 `parentCallId`） */
  toolCallId: string | null;
  /** 展示名（入参的 `name`，没有就用 `details.description`） */
  name: string | null;
  /**
   * 子智能体自己的模型往返数（`details.turnCount`）。**只在终态那一次可信**：
   * 后台档下 `Agent` 工具在子智能体还没跑完时就返回了，那一刻的 `turnCount` 是半截数
   * ⇒ 非终态时记 `null`（「没采到」），绝不拿半截数当收尾值。
   */
  turnCount: number | null;
}


/** 每行一份的空状态（**不跨运行共享**：两行并发时共享会让「谁停的」互相串） */
export function createPiRunState(): PiRunState {
  return {
    stopRequested: false,
    watchdogFired: false,
    apiMsTotal: 0,
    dispatched: false,
    dispatchNames: new Map(),
    dispatches: new Map(),
  };
}

/**
 * 记一次停止请求。三种来源在适配器眼里只有两档：用户那一档会让 `input.signal` 翻转，
 * 看门狗与宿主停机不会（两者都无法与「厂商自己中止」区分开，故一律记成「非用户发起」）。
 */
export function notePiStopRequest(runState: PiRunState, signalAborted: boolean): void {
  runState.stopRequested = true;
  if (!signalAborted) runState.watchdogFired = true;
}

/**
 * 无子智能体那一份：`{0,0,0}` / `0`（三格全 0 是**事实**——裸 pi 没有子智能体入口，
 * 事件流里也不会有子会话身份；与「有但没采到」的 `null` 是两句不同的话）。
 * 与轮次**同一条投影**交出去：分量不可能比合计更清楚（分量非 null 而合计为 null 是自相矛盾的读数）。
 *
 * **每次现造一份**：这一格会随事件交给编排层并落进快照，共享同一个可变对象等于让两行
 * （同一个进程里并发跑着）有机会改到彼此的数。
 */
function noSubagentTokens(): UsageTokens {
  return usageTokens({ input: 0, cached: 0, output: 0 });
}

/**
 * 「这一行跑到第几轮」与「其中的子智能体分量」**只有这一个出口**：两格必须同生共死。
 * 分量非 `null` 而合计为 `null` 是自相矛盾的读数（一致性套件的用量配对判据会当场红），
 * 而还没数到任何一轮时两格都**不交**——那时谈不上「这一行跑了几个往返」，也就谈不上分量。
 *
 * ⚠️ **分量那一格是按「这一行有没有子智能体」分档的**（三档语义见 `PiSubagentEvent` 那一族）：
 *   · **没派发过** ⇒ `{0,0,0}` / `0`——那是「确实没有子智能体」这句**事实**；
 *   · **派发过** ⇒ `null` / `null`——「有子智能体但还没采到」。子智能体跑在自己的会话里，
 *     它的用量与轮次只在它收场那一刻经扩展事件总线到达（见 `subagents.ts`），
 *     而本行的收尾会把它连同合计一起交出去。跑动期**不许**用 `{0,0,0}` 顶替：
 *     那句「确实没有」与事实相反。
 */
function roundTripFields(
  state: TurnState,
  runState: PiRunState,
): Pick<TurnProjection, 'turns' | 'subagentTokens' | 'subagentTurns' | 'turn'> {
  if (state.turns <= 0) return { turns: null, turn: null };
  return {
    turns: state.turns,
    subagentTokens: runState.dispatched ? null : noSubagentTokens(),
    subagentTurns: runState.dispatched ? null : 0,
    turn: turnOf(state),
  };
}

export function projectPiEvent(
  raw: unknown,
  state: TurnState,
  context: FailureContext,
  runState: PiRunState,
  subagents?: PiSubagentRecorder,
  structured?: StructuredOutputProjection,
): TurnProjection {
  const event = asRecord(raw);
  const type = readString(event, 'type');
  if (type === 'turn_start') return projectTurnStart(raw, state, runState);
  if (type === 'message_update') return projectMessageUpdate(event, state);
  if (type === 'message_end') return projectMessageEnd(raw, event, state, context, runState, structured);
  if (type === 'tool_execution_start') return projectToolExecutionStart(raw, event, runState, state, structured);
  if (type === 'tool_execution_update') {
    /**
     * **工具的部分输出刻意不投影**（一帧一条事件会把原始输出面板刷成流水，与增量帧同一条理由）：
     * 静默工具本来就只有 `start` / `end` 两发，而有输出的工具会把完整结果交在 `tool_execution_end`
     * 上——证据在那里，不在中间帧里。
     */
    return { drafts: [], tokens: null, turns: null, failure: null };
  }
  if (type === 'tool_execution_end') return projectToolExecutionEnd(raw, event, state, runState, subagents);
  if (type === 'agent_settled') return projectAgentSettled(raw, event, state, runState);
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/**
 * `tool_execution_start`：派发类工具（`Agent`）要**留下入参里的名字**——`tool_execution_end`
 * 的事件里没有 `args`，而「这一次派发的名字」只在入参里（见 `PiRunState.dispatchNames`）。
 *
 * 同时把「本行派发过子智能体」记成事实：计量那一组的三档由它分叉（见 `roundTripFields`）。
 *
 * **结构化输出那一件也在这里落**：它的产物在**工具参数**里，而两条消费通路都只认助手消息
 * （评分通路读 `finalText`、对话视图读消息流）⇒ 采用点一次做三件事：写 `state.finalText`、
 * 发一条把参数作为正文的助手快照、把投影态的归属翻成 `'structured'`。
 * 采用点选 `start` 而不是 `end`：参数在 `start` 上就已经完整（`end` 只多一个执行结果）。
 */
function projectToolExecutionStart(
  raw: unknown,
  event: Record<string, unknown> | null,
  runState: PiRunState,
  state: TurnState,
  structured?: StructuredOutputProjection,
): TurnProjection {
  const toolName = readString(event, 'toolName');
  const drafts: AgentEventDraft[] = [logDraft('stdout', safeStringify(raw), toolCallSummary(toolName, event?.['args']))];
  let messages: MessageDraft[] | undefined;
  if (toolName === PI_STRUCTURED_OUTPUT_TOOL && structured !== undefined) {
    const text = adoptStructuredArguments(event?.['args'], state, structured);
    // 人话日志与对话视图各一条：前者进原始输出面板，后者是「这段 JSON 就是本轮的答复」的载体
    drafts.push(logDraft('stdout', text));
    messages = [piStructuredResultDraft(event?.['args'], text, roundOf(state))];
  }
  if (toolName === PI_SUBAGENT_DISPATCH_TOOL) {
    runState.dispatched = true;
    const toolCallId = readString(event, 'toolCallId');
    if (toolCallId !== null) {
      runState.dispatchNames.set(toolCallId, readString(asRecord(event?.['args']), 'name'));
    }
  }
  return { drafts, tokens: null, turns: null, failure: null, ...(messages === undefined ? {} : { messages }) };
}

/**
 * `turn_start`：一次模型往返起手。
 *
 * 轮次在**这里** +1（不是助手 `message_end`）：真机上两者条数恒等，而 `turn_start` 先到 ⇒
 * 紧随其后的增量帧能落到**它自己那一轮**。按 `message_end` 数的代价是「第二轮开始吐字时，
 * 那些帧还在往第一轮那条消息里追加」——合并键里的 `roundTrip` 就是它，错一格就是错一条消息。
 */
function projectTurnStart(raw: unknown, state: TurnState, runState: PiRunState): TurnProjection {
  state.turns += 1;
  return {
    drafts: [logDraft('stdout', safeStringify(raw))],
    tokens: cumulativeTokens(state),
    ...roundTripFields(state, runState),
    failure: null,
  };
}

/**
 * `message_update`：一条增量帧只产**内容消息**，零行级事件（见文件头那两条硬口径）。
 * 不是正文/思考增量的帧（块边界、流级帧、工具入参片段）连消息都不产。
 */
function projectMessageUpdate(event: Record<string, unknown> | null, state: TurnState): TurnProjection {
  const draft = piDeltaMessageDraft(event?.['assistantMessageEvent'], roundOf(state));
  if (draft === null) return { drafts: [], tokens: null, turns: null, failure: null };
  return { drafts: [], tokens: null, turns: null, failure: null, messages: [draft] };
}

/**
 * `message_end`：只有助手那一条是权威快照（正文 / 思考 / 工具入参 / 用量 / 失败都在它身上）。
 *
 * 其余角色（`system` / `user` / `toolResult`）走原始负载兜底：工具结果另有一条真源
 * （`tool_execution_end`），这里再投影一次会在同一个合并键上投两次快照。
 */
function projectMessageEnd(
  raw: unknown,
  event: Record<string, unknown> | null,
  state: TurnState,
  context: FailureContext,
  runState: PiRunState,
  structured?: StructuredOutputProjection,
): TurnProjection {
  const message = asRecord(event?.['message']);
  /**
   * **结构化产出的那条快照走短路**：它也是我们造的（见 `piStructuredResultDraft`），
   * 常规通路会在它身上重复落正文与用量两件事——正文已经写过了，用量它压根没有。
   */
  if (isStructuredResultMessage(message)) {
    return {
      drafts: [logDraft('stdout', safeStringify(raw))],
      tokens: cumulativeTokens(state),
      ...roundTripFields(state, runState),
      failure: null,
    };
  }
  if (readString(message, 'role') !== 'assistant') {
    return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
  }
  /**
   * 证据行：思考正文、工具入参、用量与 `stopReason` 全在这一条的原始负载里。
   * 它是 `needsMessagesForReasoningEvidence: false` 的依据，**不许**在这里做取舍（见文件头）。
   */
  const drafts: AgentEventDraft[] = [logDraft('stdout', safeStringify(raw))];
  const usage = readPiUsageTokens(message?.['usage']);
  if (usage === null) {
    // 形状异常与「这一条没带用量」合流到同一条 WARN：不填 0 是硬口径，采不到必须看得见
    drafts.push(logDraft('stderr', `[WARN] pi 这一条助手消息没有可读的用量，本行按「未采集计量」处理（不填 0）：${safeStringify(message?.['usage'])}`));
  } else {
    accumulateUsage(state, usage);
  }
  // 最终答复：只认 `type === 'text'` 的非空块（思考块走 `thinking` 字段，永不混进来）
  const reply = piAssistantReply(message);
  if (reply !== '') {
    state.finalText = reply;
    /**
     * 正文覆写最终答复 ⇒ 投影态的归属翻回 `'text'`。这正是修正轮的那一格：模型第二次没调工具、
     * 直接用正文答了，那么这一份答复就**不是**工具参数投影出来的——形状没有任何厂商保证，
     * 上报口径必须跟着翻（见 `structuredOutputApplied`）。
     */
    if (structured !== undefined) noteTextReply(structured);
    // 答复文本落一条人话日志（**不给摘要**：它本身就是人话，多配一份截断过的摘要等于两个版本）
    drafts.push(logDraft('stdout', reply));
  }
  const draft = piAssistantMessageDraft(message, roundOf(state));
  const timing = piTimingSpan(message, runState);
  return {
    drafts,
    tokens: cumulativeTokens(state),
    ...roundTripFields(state, runState),
    failure: readAssistantFailure(message, context, runState),
    messages: draft === null ? [] : [draft],
    // 采不到就**不带这一格**（不是「把已采到的时间清掉」，见 `TurnProjection.timing` 的三条语义）
    ...(timing === undefined ? {} : { timing }),
  };
}

/**
 * 助手消息 → 时间跨度（**整格厂商口径**）；这一条拿不到完整的两端就返回 `undefined`。
 *
 * 两格加起来的含义：`timestamp` 是厂商记的请求起点（epoch 毫秒），`durationMs` 是厂商用单调钟
 * 从该起点量到响应收尾 ⇒ `lastMs` 由两者相加得出，**不是**我们另取一个时刻。于是三个数
 * （两端 + `apiMs`）出自同一把尺子，`source` 才能记 `'vendor'`；跨轮时 `mergeTiming` 保留最早
 * 的起点与最新的终点，这一段含工具执行时间（与 claude 的 `duration_ms` 同口径）。
 *
 * `ttftMs` **恒 `null`**：厂商不报首字时延，唯一测法是盯我们自己的第一帧——那是另一把尺子
 * （我们的墙钟 vs 厂商的单调钟），而 `mergeTiming` 对来源不一致的处置是整格作废：
 * 混进去的代价不是「这一格不准」，而是**整条时长消失**。
 *
 * `durationMs` 缺席（历史消息、延迟取回的结果）时返回 `undefined`：只有一个端点算不出跨度，
 * 而「算不出来」必须说成没采到——**不拿 0、也不拿别处的时刻冒充**。
 */
function piTimingSpan(message: Record<string, unknown> | null, runState: PiRunState): TimingSpan | undefined {
  const startedMs = readNumber(message, 'timestamp');
  const durationMs = readNumber(message, 'durationMs');
  if (startedMs === null || durationMs === null) return undefined;
  runState.apiMsTotal += durationMs;
  return {
    firstMs: startedMs,
    lastMs: startedMs + durationMs,
    apiMs: runState.apiMsTotal,
    ttftMs: null,
    source: 'vendor',
  };
}

/**
 * `tool_execution_end`：工具结果正文进 `log`（同样是 `needsMessagesForReasoningEvidence: false`
 * 的依据之一），外加一条内容级消息。
 *
 * 摘要只给**报错**那一种：成功返回那句「工具返回：…」会把活动行变成流水账，而结果的落点是
 * 结果块与原始输出面板；报错必须播，那是「这一行出事了」，且它没有别的行级出口。
 *
 * **派发类工具（`Agent`）另产一条子任务行**——见 `projectDispatchEnd`。
 */
function projectToolExecutionEnd(
  raw: unknown,
  event: Record<string, unknown> | null,
  state: TurnState,
  runState: PiRunState,
  subagents?: PiSubagentRecorder,
): TurnProjection {
  const isError = event?.['isError'] === true;
  const draft = piToolResultMessageDraft(event, roundOf(state));
  const dispatch = readString(event, 'toolName') === PI_SUBAGENT_DISPATCH_TOOL
    ? projectDispatchEnd(event, runState, subagents)
    : null;
  return {
    drafts: [
      logDraft('stdout', safeStringify(raw), isError
        ? toolErrorSummary(piToolResultText(event))
        : dispatch?.summary),
      ...(dispatch?.drafts ?? []),
    ],
    tokens: null,
    turns: null,
    failure: null,
    messages: draft === null ? [] : [draft],
    // 投递判据在收数器里（同一身份、同一内容只发一次）：这条通路与收尾对账那条都会到达
    subagents: dispatch?.record === undefined
      ? []
      : (subagents === undefined ? [dispatch.record] : subagents.deliver(dispatch.record)),
  };
}

/**
 * `Agent` 工具的收尾 → 子任务行。
 *
 * 取数路径（**主源是扩展事件总线，`details` 是交叉核对的那一份**，见 `subagents.ts` 的文件头）：
 *   · 身份：`details.agentId`——**唯一**能把这次工具调用与子智能体对上的键（总线载荷里没有
 *     `toolCallId`，反过来 `details` 里有身份）。这一格缺席时**不造行**：拿 `toolCallId` 冒充子智能体
 *     身份会让界面上的派发点永远对不上号，那是假产物；
 *   · 状态：总线那一条（子会话收场那一刻的记录）优先，没有就退回 `details.status`；
 *   · 结果摘要：**只认总线载荷的 `result`**（结构化）。工具结果正文里那句
 *     `Agent completed in 1.0s (0 tool uses, 3.1k token).\n\nPONG` 是给人看的排版文本，
 *     从里面切出答复等于按格式解析厂商文案——格式一变就静默取到半句；
 *   · 用量：总线的 `usage`（与主子**同一把尺**，走同一个 `readPiUsageTokens`）。
 *     后台档下发出去时子智能体还没收场 ⇒ 这一格是 `null`（「没采到」），收尾会补一条完整快照。
 *
 * ⚠️ **名字取入参里的 `name`，没有就退回 `details.description`**：`details.displayName` 是
 * agent **类型**的展示名（真机上是常量 `Agent`），拿它当名字等于每一行都叫同一个名字。
 */
function projectDispatchEnd(
  event: Record<string, unknown> | null,
  runState: PiRunState,
  subagents?: PiSubagentRecorder,
): { record?: SubagentRecord; drafts: AgentEventDraft[]; summary?: string } {
  const toolCallId = readString(event, 'toolCallId');
  const details = readPiSubagentDetails(event?.['result']);
  if (details.agentId === null) {
    return {
      drafts: [
        logDraft('stderr', '[WARN] 这次子智能体派发的结果里没有身份（`details.agentId`），'
          + '本次派发不产出子任务行——拿工具调用 id 冒充身份会让派发点在界面上永远对不上号'),
      ],
    };
  }
  const bus = subagents?.latest(details.agentId) ?? null;
  const name = (toolCallId === null ? null : runState.dispatchNames.get(toolCallId) ?? null) ?? details.description;
  const rawStatus = bus?.rawStatus ?? details.rawStatus;
  const record = piSubagentRecord({
    agentId: details.agentId,
    name,
    // 总线的状态优先（它是子会话收场那一刻的记录）；没有总线那一条时才用 `details` 的快照
    rawStatus,
    outcome: bus?.outcome ?? null,
    parentCallId: toolCallId,
    usage: bus?.usage ?? null,
  });
  /**
   * 登记这一次派发（收尾按身份对账用）。`turnCount` **只在终态可信**：
   * 后台档下工具返回时子智能体还在跑，那一刻的数是半截的。
   *
   * 这里再置一次 `dispatched`：它与 `dispatchNames` 都在 `tool_execution_start` 上记，
   * 而收尾的早退条件读的是它——两处各记一次，任何一条通路单独到达都不会让计量那一组
   * 退回「确实没有子智能体」那句假话。
   */
  runState.dispatched = true;
  runState.dispatches.set(details.agentId, {
    toolCallId,
    name,
    turnCount: record.status === 'running' ? null : details.turnCount,
  });
  return { record, drafts: [], summary: subagentSettledSummary(record.name, record.status) };
}


/**
 * `agent_settled`：唯一的真结束信号。除了原始负载，这里再做两件事：
 *   · **把最新的计量与轮次再交一次**：最后一次往返之后可能再没有别的出口，不交的话界面会停在
 *     上一版（与 dsh 在 `turn/end` 上的处置同源）；
 *   · **记录停止来源**：`aborted === true` 时写明是用户点的还是看门狗/宿主停机发起的
 *     （见 `PiRunState.watchdogFired`）——结论本身仍由骨架给。
 */
function projectAgentSettled(
  raw: unknown,
  event: Record<string, unknown> | null,
  state: TurnState,
  runState: PiRunState,
): TurnProjection {
  const drafts: AgentEventDraft[] = [logDraft('stdout', safeStringify(raw))];
  if (event?.['aborted'] === true) {
    drafts.push(logDraft('stderr', `[WARN] pi 的会话在收场前被中止（${stopOrigin(runState)}）`));
  }
  return {
    drafts,
    tokens: cumulativeTokens(state),
    ...roundTripFields(state, runState),
    failure: null,
  };
}

/**
 * 助手消息 → 失败归因；正常收尾返回 `null`。
 *
 * 三档：
 *   · `stopReason === 'aborted'` **且本侧发过停止请求** ⇒ **不是失败**：结论由「外部要求停止」
 *     那条通路给出（用户终止 → `canceled`，看门狗 → `timed-out`），在这里再判一次失败会让
 *     一次人为终止显示成「适配器出错」；
 *   · `stopReason === 'aborted'` 而本侧**没有**发过停止请求 ⇒ 厂商自己中止了这次往返，
 *     没人替它给结论 ⇒ 必须归成失败（**不许**静默收成 `completed`）；
 *   · `stopReason === 'error'` ⇒ 失败，原因取 `errorMessage`（翻成中文并带 host，见下）。
 * 其余档位（`stop` / `toolUse` / `length` / `pending` / `deferred`）都不是失败。
 */
function readAssistantFailure(
  message: Record<string, unknown> | null,
  context: FailureContext,
  runState: PiRunState,
): AgentFailure | null {
  const stopReason = readString(message, 'stopReason');
  if (stopReason === 'aborted') {
    if (runState.stopRequested) {
      // 这里不落事件：停止来源已经由 `agent_settled` 那条 WARN 记下（同一次停止只记一处）
      return null;
    }
    return classifyAgentMessage(
      `pi 本次往返被中止，但本侧没有发起过停止请求（${hostOf(context.baseUrl)}）`,
      context,
    );
  }
  if (stopReason !== 'error') return null;
  return classifyAgentMessage(piFailureText(readString(message, 'errorMessage'), context.baseUrl), context);
}

/**
 * 厂商短句 → 带 host 的中文原因。
 *
 * 为什么必须在适配器里翻：pi 的失败文案是**裸英文短句**——`Connection error.` /
 * `Request timed out.` / `terminated`（响应体被掐时的措辞，字面上完全看不出是超时）——不带 host、
 * 不带状态码，共用的归因层对这些字面量一个字都认不出来，照原样透出等于让用户去猜
 * 「跟哪台网关、哪一层有关」。厂商原文逐字留在括号里（排障要能拿它去搜）。
 * 未知文案不编：带上 host 原样交出。
 */
function piFailureText(errorMessage: string | null, baseUrl: string): string {
  const host = hostOf(baseUrl);
  const original = errorMessage === null ? '' : errorMessage.trim();
  if (original === '') return `pi 本次往返以失败收场，但厂商没有给出原因（${host}）`;
  if (/connection error/i.test(original)) {
    return `无法连接上游（${host}）：连接被拒绝或中途断开（厂商原文「${original}」）`;
  }
  if (/request timed out/i.test(original)) {
    return `上游请求超时（${host}）：厂商 SDK 自带的请求时限内没有拿到响应（厂商原文「${original}」）`;
  }
  if (/^terminated$/i.test(original)) {
    return `上游在响应中途切断了连接（${host}）：通常是网关或代理的响应体空闲超时（厂商原文「${original}」）`;
  }
  return `pi 本次往返失败（${host}）：厂商原文「${original}」`;
}

/** 取 host 用于文案；URL 不合法时退回原文（绝不因为「文案里放不下 host」而抛） */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 这次中止是谁发起的（只影响措辞：结论由骨架按停止来源给） */
function stopOrigin(runState: PiRunState): string {
  if (!runState.stopRequested) return '本侧没有发起过停止请求，中止来源不明';
  return runState.watchdogFired ? '看门狗或宿主停机发起的停止' : '用户终止';
}

/**
 * 折进本行累计。三格相加；`reasoning` 也相加但**不加进 `output`**（它是 `output` 的子集，
 * 加进去就是双计，而症状是「这家 tok 偏大」）。
 *
 * `totalTokens` 在这里也**相加**（与 dsh 的处置刻意不同）：pi 报的是**本次往返**的量，
 * 逐次相加才是「本行到目前为止厂商自报的总量」；dsh 那一格是会话级累计快照，相加会算成好几倍。
 * 差别来自厂商载荷的语义，不是两套口径——本仓「归一放在适配器里」的全部理由就是这个。
 */
function accumulateUsage(state: TurnState, tokens: UsageTokens): void {
  state.usageInput = (state.usageInput ?? 0) + tokens.input;
  state.usageCached = (state.usageCached ?? 0) + tokens.cached;
  state.usageOutput = (state.usageOutput ?? 0) + tokens.output;
  if (tokens.reasoningOutput != null) {
    state.usageReasoningOutput = (state.usageReasoningOutput ?? 0) + tokens.reasoningOutput;
  }
  if (tokens.total != null) state.usageTotal = (state.usageTotal ?? 0) + tokens.total;
}

/**
 * 本行累计的计量：三格齐了才认（缺一项就是 `null`，**不填 0**）。
 * 两个可选格同样是「没采到就是 null」——`reasoningOutput: 0` 会让人得出「这家不做推理」。
 */
function cumulativeTokens(state: TurnState): UsageTokens | null {
  const input = state.usageInput;
  const cached = state.usageCached;
  const output = state.usageOutput;
  if (input === null || cached === null || output === null) return null;
  return usageTokens({
    input,
    cached,
    output,
    reasoningOutput: state.usageReasoningOutput,
    total: state.usageTotal,
  });
}

/** 这一条读数属于哪一轮：pi 只有主会话，故 `subagentId` 恒 `null`（每一轮无子会话） */
function turnOf(state: TurnState): UsageTurn {
  return { subagentId: null, round: roundOf(state) };
}

/**
 * 这一条消息属于**第几次模型往返**。轮次在 `turn_start` 上已经 +1，这里取的就是「当前这一轮」；
 * 还没数到任何一轮时退回 `1`（增量帧早于 `turn_start` 是形状异常，但合并键必须是正整数）。
 */
function roundOf(state: TurnState): number {
  return state.turns > 0 ? state.turns : 1;
}

/**
 * 收尾：把子智能体那一份折成**最后一批完整快照 + 两格分量**。
 *
 * ## 为什么必须有这一步
 *
 * 子智能体跑在**自己的 pi 会话**里，它的事件不进父会话的事件流 ⇒ 它的用量与终态只在扩展事件总线上
 * 到达（`subagents:completed` / `subagents:failed`），而那个时刻与父会话的事件流**没有先后保证**：
 * 后台档（`run_in_background: true`）下 `Agent` 工具**立刻**返回，子智能体在父会话之后才收场。
 * 收尾因此是补最后一次完整快照的唯一时机（同一身份多次投递、后者是完整快照——骨架的约定如此）。
 *
 * ## 合计含分量（与另三家逐字同一条口径）
 *
 * 主子自己的读数**不含**子智能体的开销：pi 的子会话另起一个会话，父会话的助手消息里只有它自己的
 * `usage`（真机：主子那一轮的读数与子任务那一条各自独立、覆盖面不相交）。所以：
 *   · `tokens` = 主会话累计 **+** 子智能体分量 ⇒ 这一格回答的仍是「这一行一共花了多少」；
 *   · `subagentTokens` = 其中的分量（界面按「主会话 = 合计 − 分量」推导主子那一行）；
 *   · `turns` 同理：主子数自己的 `turn_start`，子那一份来自扩展给的 `turnCount`。
 * 逐格相加**不是双计**——两份读数覆盖面不相交；相加只是把「这一行」的边界补全。
 * 求和走 `usage.ts` 的**唯一共享实现**（与另三家同一份代码）：三格逐格相加，而 `total`
 * **不相加**——两个会话各自自报的总量相加得到的是我们的算术，契约里那一格的语义是「厂商原文」，
 * 只有**单会话**那一份（子任务行自己的 `usage`、无子智能体时的合计）才留着它。
 *
 * ## 「全量或 null」
 *
 * 任何一次**已派发**的子智能体拿不到终态（还在跑、或这一行的结论先落了），或拿到了终态却没有可读的
 * 用量 / 轮次 ⇒ 分量**整格 `null`**、合计退回主会话口径，并落一条**点名** WARN——绝不把部分和
 * 冒充总数（部分和与全部读完在界面上长得一模一样）。与 codex / claude 那两条 reads 同一条口径。
 *
 * ## 没有派发时一个字都不改
 *
 * 没派发过就原样返回（合计与分量都由投影那一层给出：`{0,0,0}` / `0` 是「确实没有子智能体」这句事实）。
 */
export function finalizePiSubagents(
  state: TurnState,
  runState: PiRunState,
  subagents: PiSubagentRecorder,
  /**
   * 取某个子智能体的**转写正文**（子会话的逐步骤消息）。缺省 = 不取正文。
   *
   * 为什么必须在这一层取而不是投影里：子会话的事件**不在父会话的流里**，唯一带正文的通道是
   * 扩展写的转写文件（见 `transcript.ts`）。它是**旁路文件**，与流没有先后保证 ——
   * 与骨架给 codex 会话文件留的那一格同一条处置：**收尾读一次**，不假装流里有。
   * 读不到**不影响结论**（子任务正文是补充信息），只是界面上那个节点会空着。
   */
  readTranscript?: (agentId: string) => PiSubagentTranscript,
): TurnFinalize {
  if (!runState.dispatched) return { drafts: [] };

  const mainTokens = cumulativeTokens(state);
  const settled = new Map<string, PiSubagentEvent>();
  for (const agentId of subagents.settledIds()) {
    const event = subagents.latest(agentId);
    if (event !== null) settled.set(agentId, event);
  }

  /** 逐个对账：派发过、但没拿到完整终态的那些**必须点名**（静默按已收到的求和会得到一个看着正常的数） */
  const incomplete: string[] = [];
  const usage: UsageTokens[] = [];
  let turns = 0;
  for (const [agentId, dispatch] of runState.dispatches) {
    const event = settled.get(agentId) ?? null;
    if (event === null) {
      incomplete.push(`${agentId}（还没收场）`);
      continue;
    }
    if (event.usage === null) incomplete.push(`${agentId}（没有可读的用量）`);
    else usage.push(event.usage);
    if (dispatch.turnCount === null) incomplete.push(`${agentId}（没有可读的轮次）`);
    else turns += dispatch.turnCount;
  }

  /**
   * 主会话那一份拿不出（一条助手用量都没读到）或一次往返都没数到时**整组不交**：
   * 分量比合计更清楚是自相矛盾的读数（一致性套件的用量配对判据会当场红）。
   */
  const total = incomplete.length > 0 || mainTokens === null || state.turns <= 0
    ? null
    : sumUsageTokens(usage);

  /**
   * 子会话正文：**逐身份各读一次**，顺带把「为什么读不到」落成点名 WARN。
   * 只给**已经收场**的那些读——还在跑的子会话转写只落了一半，投影出来会让人以为它就说这么多。
   */
  const messages: MessageDraft[] = [];
  const transcriptNotes: string[] = [];
  if (readTranscript !== undefined) {
    for (const agentId of runState.dispatches.keys()) {
      if (!settled.has(agentId)) continue;
      const transcript = readTranscript(agentId);
      messages.push(...transcript.messages);
      if (transcript.warning !== null) transcriptNotes.push(transcript.warning);
    }
  }

  const drafts: AgentEventDraft[] = [
    ...(incomplete.length > 0
      ? [logDraft('stderr', `[WARN] 这一行的子智能体分量给不出（记 null，不编造、不填 0）：${incomplete.join('、')}`)]
      : []),
    ...(incomplete.length === 0 && total === null
      ? [logDraft('stderr', '[WARN] 这一行的主子用量或轮次拿不出来，子智能体分量随之记 null（分量不可能比合计更清楚）')]
      : []),
    ...(transcriptNotes.length > 0
      ? [logDraft('stderr', `[WARN] 子任务的逐步骤正文没取全：${transcriptNotes.join('、')}`)]
      : []),
  ];

  const rows = [...runState.dispatches].map(([agentId, dispatch]) => {
    const event = settled.get(agentId) ?? null;
    return piSubagentRecord({
      agentId,
      /**
       * 名字**沿用派发那一刻定下的那一个**（`projectDispatchEnd` 已把「入参的 `name`、
       * 退回 `details.description`」resolve 过一次），总线那一条只在派发通路没跑过时兜底。
       *
       * 为什么不在这里改用总线的 `description`：总线载荷里**没有**模型给的 `name`，
       * 于是同一个子任务在两条通路上会有两个名字——运行期显示一个、收尾那一刻换另一个
       * （真机形状：模型叫它 `pong-agent`，收尾把标题改回任务描述）。同一个身份在两份快照里
       * 逐字相同，也正是收数器 `deliver` 那条「同内容只发一次」判据成立的前提。
       */
      name: dispatch.name ?? event?.description ?? null,
      rawStatus: event?.rawStatus ?? null,
      outcome: event?.outcome ?? null,
      parentCallId: dispatch.toolCallId,
      usage: event?.usage ?? null,
    });
  });
  // 收尾这一份是**完整快照**；与工具收尾那条逐字相同的话由收数器挡掉（见 `deliver`）
  const delivered = rows.flatMap((row) => subagents.deliver(row));

  if (total === null || mainTokens === null) {
    return { drafts, messages, subagents: delivered, subagentTokens: null, subagentTurns: null };
  }
  return {
    drafts,
    messages,
    subagents: delivered,
    // 合计与分量**同刻**交出：只给一个会让界面按「主会话 = 合计 − 分量」算出负数
    tokens: addUsage(mainTokens, total),
    turns: state.turns + turns,
    subagentTokens: total,
    subagentTurns: turns,
  };
}
