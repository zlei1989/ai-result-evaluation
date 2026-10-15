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
 * ## 失败：运行期从 `stopReason` / `errorMessage` 读，起请求前会抛
 *
 * `prompt()` 对**运行期失败永不抛**（传输失败、被中止、自带超时全是 resolve），所以那一路的失败姿态
 * 只有一条通道：助手 `message_end` 的 `stopReason` 与 `errorMessage`。厂商给的是**裸英文短句**
 * （`Connection error.` / `Request timed out.` / `terminated`），不带 host、不带状态码，
 * 共用的归因层够不着 ⇒ 本文件先把它们翻成带 host 的中文原因，再交给 `classifyAgentMessage`。
 * ⚠️ **起请求之前**它是会抛的（没有可用凭据 / 模型未选 / 压缩中 / 已有在跑的轮次）——那一路必须
 * 抛给骨架（见 `index.ts` 的 `sessionEventStream`），否则一次「凭据缺失」会被读成
 * 「这一行成功了、只是没说话」。
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
import { carrierKeyOf, usageTokens, type MessageDraft } from '../../message';
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
import { PI_SUBAGENT_WIRE_TICK_TYPE, type PiSubagentWire } from './subagent-wire';
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
  noteTextReply,
  type StructuredOutputProjection,
} from './structured-output';

/**
 * 一次运行的投影状态：骨架的 `TurnState` 是三家共用的形状，这里只放 pi 自己的两格
 * （与 dsh 的子会话白名单同一条处置：另起一个对象随闭包走，不污染共用形状）。
 */
/**
 * 结构化输出的参数**连续**被厂商拒几次就收手。
 *
 * 为什么必须有上限：`submit_result` 靠工具结果上的 `terminate: true` 收尾，而厂商在参数**校验失败**时
 * 返回的是 `createErrorToolResult`——**不带 terminate**（校验发生在 terminate 之前，见
 * `pi-agent-core` 的 `executeToolCalls*`：`preparation.kind === 'immediate'` 之后照样
 * `emitToolExecutionEnd`）。于是模型每交一次越界参数就换来一条错误结果、再交一次，两侧都没有轮数上限：
 * 真机读数（脚本式上游，永久回同一段越界调用）**15 秒 1337 次出站请求**，不挂看门狗直接 OOM。
 * 三次足够覆盖「模型自己改对」的正常修正（骨架的修正轮另有 2 轮上限），再多就是上面那个环。
 */
export const PI_STRUCTURED_REJECTION_BUDGET = 3;

export interface PiRunState {
  /** 收到过停止请求（用户终止 / 看门狗 / 宿主停机都从骨架的 `interrupt()` 进来） */
  stopRequested: boolean;
  /** 结构化输出的参数被厂商**连续**拒了几次（只增不清：成功收尾时这一轮已经结束） */
  structuredRejections: number;
  /**
   * **本层自己**因为上面那条预算而中止了这一轮（不是用户终止、也不是厂商自己中止）。
   *
   * 为什么要单独一格：厂商把这次中止报成 `stopReason: 'error'` + `errorMessage: 'This operation
   * was aborted'`，而归因层对 `error` 无条件给一条失败 ⇒ 它会**盖掉**投影层已经记下的那条点名原因
   * （真机：最终 `error.message` 变成厂商那句「厂商原文「This operation was aborted」」，
   * 用户看不出是「参数连续越界」）。有这一格，归因层就知道这条 error 是本层自找的，让位给点名原因。
   */
  selfAborted: boolean;
  /**
   * 停止请求**不是用户点的**（看门狗开火或宿主停机）。
   *
   * 为什么必须自己记：`agent_settled.aborted` 分不出「用户停的」与「看门狗停的」。用户终止会让
   * `input.signal` 翻转（编排层 abort 的就是它），看门狗与宿主停机都不碰它 ⇒ 这是适配器这一层
   * 唯一的判据。它只影响日志措辞，不影响结论（结论由骨架按停止来源给 `canceled` / `timed-out`）。
   */
  watchdogFired: boolean;
  /**
   * 这一行**派发过**子智能体（见过一次 `Agent` 工具调用）。
   *
   * 为什么不是「有没有子任务行」：行只在收场那一刻才造得出来，而子智能体可能在整行跑完时还在跑。
   * 这一格判的是「本行的计量里有没有子这一份」——有派发就必须按「有子智能体」那三档处置，
   * 否则跑动期会报出 `{0,0,0}` 那句「**确实没有**子智能体」，与事实相反。
   */
  dispatched: boolean;
  /**
   * 派发工具调用的入参（`toolCallId` → 这一次派发的名字与任务描述）。
   *
   * 为什么要留：`tool_execution_end` 的事件里**没有 `args`**（只有 `toolCallId` / `toolName` /
   * `result` / `isError` / `durationMs`），而「这一次派发的名字」只出现在入参里。
   *
   * 为什么还要 `description` 与 `claimedBy`：派发那一刻的**子任务行**要在总线报「开始」时投出去
   * （见 `deliverStartedSubagents`），而扩展的总线载荷只有身份 + 描述、**没有工具调用 id**
   * ⇒ 认领靠「描述逐字相同且唯一」这一条判据，认领结果记在 `claimedBy` 上（同一个身份只认一次，
   * 免得两条同描述的派发指向同一次调用）。
   */
  dispatchStarts: Map<string, PiDispatchStart>;
  /**
   * 已经落过「派发行认不出对应调用」那条 WARN 的身份。
   *
   * 为什么要单独记：补发挂在**每个**事件上，而认不出的那条会一直留在收数器里
   * ⇒ 不挡的话同一句话会把原始输出面板刷满。
   */
  unclaimedWarned: Set<string>;
  /**
   * 已收场的派发记录（`agentId` → 这一行的收尾快照），键是**子智能体身份**。
   *
   * 为什么要按身份而不是按工具调用登记：收尾要拿它去总线那一条上对账（总线载荷只有身份），
   * 而 `turnCount` 只出现在 `Agent` 工具结果的 `details` 里。两边的唯一公共键就是身份。
   */
  dispatches: Map<string, PiDispatch>;
  /**
   * 跑动期已经投出的**转写消息条数**（`agentId` → 条数）。
   *
   * 为什么要这一格：收尾对账只补**差量**——跑动期增量投过的那一段不重发（重发会在
   * `messages.jsonl` 留下同内容的重复行）。条数按投影顺序切片：转写文件 append-only、
   * 行一旦 flush 即不可变 ⇒ 同一身份的下标稳定。
   */
  transcriptEmitted: Map<string, number>;
  /**
   * 上一次**读盘**的时刻（`agentId` → epoch 毫秒）。spinner 帧逐条触发投影，不节流的话
   * 一个话痨子任务每秒会带来几十次全量读盘（见 `deliverTranscriptIncrements`）。
   */
  transcriptReadAt: Map<string, number>;
  /**
   * 子会话消息**已经投出快照的载体键**（`carrierKeyOf`，wire 与转写两条通路共用一份）。
   *
   * 为什么要这一格：同一个子会话正文有两条来源（wire 事件流 / 转写文件），同一条消息在
   * 两条路上给出**同一个载体键**（wire 的轮次基数取自 `session.messages`，与转写的助手行序
   * 对齐，见 `subagent-wire.ts`）⇒ 按「第一条到达者胜出」过滤，后到的重复快照整条丢掉——
   * 不然 `messages.jsonl` 会留同内容的双份行（客户端按 `mergeKey` 折叠会收敛，但账本不该虚胖）。
   *
   * **只记快照、也只挡快照**（判据是 `chunk`，不是「这个载体出现过没有」）：同一轮的
   * 逐字增量与它的收尾快照**载体键逐字相同**，按载体挡会让先到的 delta 占死键、真正的
   * 收尾快照被整条丢掉，消息永远停在半截。两条通路里只有 wire 会产 delta（转写文件读的是
   * 已完成消息数组，天然只有快照）⇒ 放行 delta 不会放进来任何重复内容。
   *
   * **只对子会话载体生效**（`subagentId !== null`）：主会话的同一载体合法地收增量 + 快照
   * 多次投递，过滤它会把快照挡掉、消息永远停在「未收尾」。
   */
  subagentCarriers: Set<string>;
}

/** 一次派发在**发起那一刻**留下的三格事实（见 `PiRunState.dispatchStarts`） */
export interface PiDispatchStart {
  /** 入参的 `name`（模型给这一行起的名字）；没给记 `null` */
  name: string | null;
  /** 入参的 `description`（任务描述）。认领判据与派发行的名字兜底都用它（与总线载荷同源） */
  description: string | null;
  /**
   * 这一次调用已经被哪个子任务身份认领（`null` = 还没被认领）。
   *
   * 为什么要记：同一条子任务上只会来一条 `subagents:started`，而描述撞名的另一条派发
   * **也**满足「描述逐字相同」⇒ 不记认领者的话，同一个 `toolCallId` 会被两条身份各认领一次，
   * 两条子任务行指向同一个派发点。认领者由 `deliverStartedSubagents` 写。
   */
  claimedBy: string | null;
}

/** 一次派发在收尾那一刻留下的几格事实（见 `PiRunState.dispatches`） */
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
  /**
   * 收尾那一刻**已知的厂商状态原文**（`details.status`，如后台档的 `background`）。
   *
   * 为什么必须留这一格：后台档下总线只会来一条 `subagents:started`（没有 `status` 字段），
   * 于是收尾对账时 `latest()` 给出的是一条**没有状态**的记录。只读它会让已经投出去的
   * `running` 行被覆盖成 `unknown`——那是与「从终态退回运行中」同类的**倒退**，只是方向相反
   * （把「已知在跑」说成「不知道」）。有这一格，收尾就能沿用它。
   */
  rawStatus: string | null;
}


/** 每行一份的空状态（**不跨运行共享**：两行并发时共享会让「谁停的」互相串） */
export function createPiRunState(): PiRunState {
  return {
    stopRequested: false,
    structuredRejections: 0,
    selfAborted: false,
    watchdogFired: false,
    dispatched: false,
    dispatchStarts: new Map(),
    unclaimedWarned: new Set(),
    dispatches: new Map(),
    transcriptEmitted: new Map(),
    transcriptReadAt: new Map(),
    subagentCarriers: new Set(),
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

/**
 * 投影的唯一入口：**先算这一个事件自身的投影，再补发两样「挂在每个事件上」的东西**——
 * 「已经在跑、但我们还没投过行」的子任务（`deliverStartedSubagents`）与在飞子智能体
 * 已经 flush 的转写增量（`deliverTranscriptIncrements`）。
 *
 * 为什么补发挂在**每个**事件上而不是某个具体事件上：扩展报「子智能体开始」的那条总线事件
 * 与父会话的事件流没有先后保证，而它在**前台档**（`Agent` 工具阻塞到子智能体收场）里是
 * 派发到收场之间**唯一**能让我们知道「它已经跑起来了」的时刻。父会话在这段时间里**自己一个
 * 事件很稀**：真机原始帧计数（`pi 1.3.0`，脚本式上游，派发一轮）——派发到收场之间父会话发
 * **4 帧 `tool_execution_update` + 1 帧 `entry_appended`**（含正文的帧一帧都没有；厂商在更早的
 * 版本上不发这几帧）⇒ 心跳仍由 wire 通道自己造的合成帧提供（`subagent-wire.ts` 的泵，
 * 见那一处的取舍），
 * 补发因此挂在「任何一次投影」上：厂商事件与合成帧都算，派发行在几十毫秒内出去。
 *
 * 兜底姿态：一个中间事件都没有时，派发行退到 `tool_execution_end` 那条完整快照
 * （与「不在派发时刻投递」同形）——**退化成旧行为，不会更坏**；转写增量同理，没有合成帧
 * 就没有增量，收尾对账补齐差量。
 *
 * **顺序**：补发的派发行排在本次事件自己产出的行**之前**——同一批次里「派发行 → 收尾行」
 * 不许反过来（后到的那条是完整快照，反过来会让状态从终态退回运行中）。
 *
 * **同一批次里已经有一条更完整的行时不再补**：这一次事件若正好把某个身份收尾了，它交出的那条
 * 本身就是完整快照（派发行注定被它覆盖 ⇒ 补发只是往产物里多写一行）。
 *
 * **转写增量只认「更早一批」的子任务行**：身份快照在投影**之前**取（`deliveredEarlier`）——
 * 骨架在同一批投影里先发消息、后发子任务行，同批混发会让这批消息在行到达之前掉进主会话。
 */
export function projectPiEvent(
  raw: unknown,
  state: TurnState,
  context: FailureContext,
  runState: PiRunState,
  subagents?: PiSubagentRecorder,
  structured?: StructuredOutputProjection,
  readTranscript?: (agentId: string) => PiSubagentTranscript,
  wire?: PiSubagentWire,
): TurnProjection {
  const deliveredEarlier = new Set(subagents?.deliveredIds() ?? []);
  const projection = projectEvent(raw, state, context, runState, subagents, structured);
  const settledNow = new Set((projection.subagents ?? []).map((record) => record.subagentId));
  const started = deliverStartedSubagents(runState, subagents, settledNow);
  /**
   * wire 排空在转写读盘**之前**：wire 的事件先到（消息级 vs 轮级），先排先占载体键，
   * 转写随后只补 wire 没覆盖到的那些（订阅前的缺口 / wire 不可用的整行）。
   */
  const wireDrafts = wire === undefined || subagents === undefined
    ? { messages: [] as MessageDraft[], warnings: [] as string[] }
    : deliverWireIncrements(runState, subagents, wire, deliveredEarlier);
  const increments = subagents === undefined || readTranscript === undefined
    ? []
    : deliverTranscriptIncrements(runState, subagents, readTranscript, deliveredEarlier);
  const wireWarnDrafts = wireDrafts.warnings.map((warning) => logDraft('stderr', `[WARN] ${warning}`));
  if (
    started.subagents.length === 0 && started.drafts.length === 0 && increments.length === 0
    && wireDrafts.messages.length === 0 && wireWarnDrafts.length === 0
  ) return projection;
  return {
    ...projection,
    drafts: [...started.drafts, ...wireWarnDrafts, ...projection.drafts],
    subagents: [...started.subagents, ...(projection.subagents ?? [])],
    ...(wireDrafts.messages.length === 0 && increments.length === 0
      ? {}
      : { messages: [...(projection.messages ?? []), ...wireDrafts.messages, ...increments] }),
  };
}

/** 单个事件的投影（派发记账在这一步登记，故补发必须排在它之后，见 `projectPiEvent`） */
function projectEvent(
  raw: unknown,
  state: TurnState,
  context: FailureContext,
  runState: PiRunState,
  subagents?: PiSubagentRecorder,
  structured?: StructuredOutputProjection,
): TurnProjection {
  const event = asRecord(raw);
  const type = readString(event, 'type');
  /**
   * **本层自己造的合成帧**（`subagent-wire.ts` 的泵）：它不是厂商事件，一个字的正文都没有，
   * 存在的全部意义是「换一次 `projectPiEvent` 的排空」。故这里**最先判、返回空投影**——
   * 漏判它会走到末尾的兜底分支，把「未识别的厂商载荷」刷满原始输出面板。
   */
  if (type === PI_SUBAGENT_WIRE_TICK_TYPE) return { drafts: [], tokens: null, turns: null, failure: null };
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
 * `tool_execution_start`：派发类工具（`Agent`）要**留下入参**——`tool_execution_end`
 * 的事件里没有 `args`，而「这一次派发的名字」只在入参里（见 `PiRunState.dispatchStarts`）。
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
    messages = [piStructuredResultDraft(event?.['args'], text, roundOf(state), readString(event, 'toolCallId'))];
  }
  if (toolName === PI_SUBAGENT_DISPATCH_TOOL) {
    runState.dispatched = true;
    const toolCallId = readString(event, 'toolCallId');
    if (toolCallId !== null) {
      const args = asRecord(event?.['args']);
      runState.dispatchStarts.set(toolCallId, {
        name: readString(args, 'name'),
        // 与总线载荷的 `description` 同源（扩展把同一个 `params.description` 写进两处），认领判据就是它
        description: readString(args, 'description'),
        claimedBy: null,
      });
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
  if (readString(message, 'role') !== 'assistant') {
    return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
  }
  /**
   * 证据行：思考正文、工具入参、用量与 `stopReason` 全在这一条的原始负载里。
   * 它是 `needsMessagesForReasoningEvidence: false` 的依据，**不许**在这里做取舍（见文件头）。
   */
  const drafts: AgentEventDraft[] = [logDraft('stdout', safeStringify(raw))];
  const usage = readPiUsageTokens(message?.['usage'], {
    // openai 那条 wire 把缺失的推理明细补成 0（见 `readPiUsageTokens`），别读成「这家不做推理」
    reasoningZeroIsMissing: readString(message, 'api') === 'openai-completions',
  });
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
  const timing = piTimingSpan(message);
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
 * `apiMs` 交的是**当轮那一份 `durationMs`**（厂商对「一次响应」的定义，逐轮各报一次），
 * 由骨架的 `mergeTiming` 相加成「本行到目前为止」——它那一层的约定就是「每条投影交增量」。
 * 自己在这里累加会与骨架的相加叠成平方级的偏大（三轮各 160 ms 时行级 `apiMs` 读到 966 ms，
 * 而整行跨度只有 483 ms：比它自己装着的那段时间还长）。
 *
 * `ttftMs` **恒 `null`**：厂商不报首字时延，唯一测法是盯我们自己的第一帧——那是另一把尺子
 * （我们的墙钟 vs 厂商的单调钟），而 `mergeTiming` 对来源不一致的处置是整格作废：
 * 混进去的代价不是「这一格不准」，而是**整条时长消失**。
 *
 * `durationMs` 缺席（历史消息、延迟取回的结果）时返回 `undefined`：只有一个端点算不出跨度，
 * 而「算不出来」必须说成没采到——**不拿 0、也不拿别处的时刻冒充**。
 */
function piTimingSpan(message: Record<string, unknown> | null): TimingSpan | undefined {
  const startedMs = readNumber(message, 'timestamp');
  const durationMs = readNumber(message, 'durationMs');
  if (startedMs === null || durationMs === null) return undefined;
  return {
    firstMs: startedMs,
    lastMs: startedMs + durationMs,
    apiMs: durationMs,
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
  const toolName = readString(event, 'toolName');
  const draft = piToolResultMessageDraft(event, roundOf(state));
  const dispatch = toolName === PI_SUBAGENT_DISPATCH_TOOL
    ? projectDispatchEnd(event, runState, subagents)
    : null;
  /**
   * 结构化输出的参数被厂商拒 ⇒ 记一次；连续越界超过预算就**交出失败**（无界往返的机制见
   * `PI_STRUCTURED_REJECTION_BUDGET`）。⚠️ 光交 `failure` **停不下厂商的 agent loop**——
   * 骨架只把它记下来、消费循环继续跑到流结束；真正让往返停下的是装配面在同一个判据上
   * `session.abort()`（见 `index.ts` 的 `projectRow`）。
   */
  let rejectionFailure: TurnProjection['failure'] = null;
  if (toolName === PI_STRUCTURED_OUTPUT_TOOL && isError) {
    runState.structuredRejections += 1;
    if (runState.structuredRejections > PI_STRUCTURED_REJECTION_BUDGET) {
      rejectionFailure = {
        code: 'AGENT_FAILED',
        message: `pi 的结构化输出参数连续 ${runState.structuredRejections} 次被厂商拒（参数不合法）：`
          + `超过 ${PI_STRUCTURED_REJECTION_BUDGET} 次的上限后中止这一轮，避免无界的模型往返。`
          + `厂商原文：${(piToolResultText(event) ?? '').slice(0, 500)}`,
      };
    }
  }
  return {
    drafts: [
      logDraft('stdout', safeStringify(raw), isError
        ? toolErrorSummary(piToolResultText(event))
        : dispatch?.summary),
      ...(dispatch?.drafts ?? []),
    ],
    tokens: null,
    turns: null,
    failure: rejectionFailure,
    messages: draft === null ? [] : [draft],
    // 投递判据在收数器里（同一身份、同一内容只发一次）：这条通路与收尾对账那条都会到达
    subagents: dispatch?.record === undefined
      ? []
      : (subagents === undefined ? [dispatch.record] : subagents.deliver(dispatch.record)),
  };
}

/**
 * 两次投递共用的名字解析：**入参的 `name` 优先，没有才退回任务描述**。
 *
 * 为什么必须是共用的一份：派发行与收尾行是同一个身份的两次投递，界面按后者覆盖前者
 * ⇒ 两处各算一遍必然漂移，而漂移的表现是「卡片标题在收尾那一刻换了一个」。
 * 描述那一端优先取**入参**（派发那一刻就定了，与总线载荷同源），`details.description` 只作兜底
 * （`tool_execution_end` 的结果里那一格与入参同值，保留它只为「入参没采到」这一档）。
 */
function resolveDispatchName(
  toolCallId: string | null,
  detailsDescription: string | null,
  runState: PiRunState,
): string | null {
  const start = toolCallId === null ? undefined : runState.dispatchStarts.get(toolCallId);
  return start?.name ?? start?.description ?? detailsDescription;
}

/**
 * **派发那一刻的子任务行**：扩展刚报「开始」的那些身份，与还在飞的那次 `Agent` 调用对上就投一条
 * `running` 行——界面的子任务卡片与「进入 ▸」入口由此在派发瞬间就位，不必等子智能体收场。
 *
 * 为什么需要它：契约明文要求「同一身份多次投递（**派发时一条**、收场时一条）」，
 * 而这一家前台档的 `Agent` 是**阻塞工具**（子智能体跑完才返回）⇒ 只靠 `tool_execution_end`
 * 那条通路的话，整段运行期界面上没有节点、没有卡片、也没有入口（另三家都在派发时投）。
 *
 * 四条判据：
 *   1. **总线已报终态的身份不投**（`settledIds`）：那会让状态从终态退回运行中，
 *      而其后到达的收尾行必须带**新**事实（一致性套件的 K2）；
 *   2. **认领靠描述**：总线载荷只有 `{id, type, description}`，**没有工具调用 id**
 *      ⇒ 在还在飞的派发里找「尚未被认领 且 `description` 逐字相同」的那一条；
 *      恰好一条才认领，零条或多条**一律不认领、不投**（`claimedBy` 挡住重复认领）
 *      ——宁可晚一条，也不把卡片挂到别人的派发点上；
 *   3. **身份用总线的那个 id**：与收尾行（`details.agentId`）、与子会话正文（转写文件）同一套身份；
 *   4. **逐字相同的重发由 `deliver` 挡掉**：本函数挂在每个事件上，同一次派发只会出一条 running 行。
 *
 * 未认领时**什么都不投**、只落一条点名 WARN（每个身份一条）：那一档退化成「收尾才出行」，
 * 与修之前同形。
 */
function deliverStartedSubagents(
  runState: PiRunState,
  subagents?: PiSubagentRecorder,
  /** 本次事件自己已经交出的身份：它们那条是完整快照，派发行让位（见 `projectPiEvent`） */
  settledNow: ReadonlySet<string> = new Set(),
): { subagents: SubagentRecord[]; drafts: AgentEventDraft[] } {
  const delivered: SubagentRecord[] = [];
  const drafts: AgentEventDraft[] = [];
  if (subagents === undefined) return { subagents: delivered, drafts };
  const settled = new Set(subagents.settledIds());
  for (const agentId of subagents.startedIds()) {
    if (settled.has(agentId) || settledNow.has(agentId)) continue;
    const started = subagents.latest(agentId);
    if (started === null) continue;
    const claim = claimDispatch(runState, started.description, agentId);
    if (claim === null) {
      // 只落一次：本函数挂在每个事件上，不加这道闸就会把同一句话刷满原始输出面板
      if (!runState.unclaimedWarned.has(agentId)) {
        runState.unclaimedWarned.add(agentId);
        drafts.push(logDraft('stderr', '[WARN] 这次子智能体派发没能与它的工具调用对上'
          + `（身份 ${agentId}、任务描述 ${started.description ?? '未采集'}）：`
          + '描述与在飞的派发对不上或不唯一，本行**不在派发时刻**投它的子任务行'
          + '——卡片要等这次工具收尾才出现（那是完整快照），不猜一个派发点'));
      }
      continue;
    }
    const name = resolveDispatchName(claim, null, runState);
    delivered.push(...subagents.deliver(piSubagentRecord({
      agentId,
      name,
      rawStatus: 'running',
      outcome: null,
      parentCallId: claim,
      usage: null,
    })));
  }
  return { subagents: delivered, drafts };
}

/**
 * 认领一次还在飞的派发（描述逐字相同且唯一）。命中即把认领者记到那一格上，
 * 于是同一个 `toolCallId` 不会再被第二条同描述的身份认领。
 *
 * **同一个身份再来一次不算「认不出来」**：本函数挂在每个事件上，第二次之后的调用原样返回
 * 第一次认领的那一格，重发的那条行由 `deliver` 按内容挡掉——否则「已认领」会被读成
 * 「对不上」，于是每个事件都落一条 WARN。
 */
function claimDispatch(runState: PiRunState, description: string | null, agentId: string): string | null {
  for (const [toolCallId, start] of runState.dispatchStarts) {
    if (start.claimedBy === agentId) return toolCallId;
  }
  if (description === null || description === '') return null;
  const matches: string[] = [];
  for (const [toolCallId, start] of runState.dispatchStarts) {
    if (start.claimedBy !== null) continue;
    if (start.description !== description) continue;
    matches.push(toolCallId);
  }
  const claimed = matches.length === 1 ? matches[0] : undefined;
  if (claimed === undefined) return null;
  const start = runState.dispatchStarts.get(claimed);
  if (start !== undefined) start.claimedBy = agentId;
  return claimed;
}

/**
 * 跑动期转写读盘的最小间隔（毫秒）。投影由两类输入驱动——厂商事件与 wire 的合成帧
 * （`subagent-wire.ts` 的泵把「缓冲进账」换成一次投影），后者按 25 ms 节拍走；转写的 flush
 * 粒度是 `turn_end` ⇒ 250 ms 的节流只削读盘次数，不削「一轮一现」的及时性。
 */
const PI_SUBAGENT_TRANSCRIPT_POLL_MS = 250;

/**
 * **跑动期的转写增量**：把在飞子智能体已经 flush 的转写行折成消息，只投**新增的那一段**。
 *
 * ## 为什么要挂在这里（每个事件的投影之后）
 *
 * 子会话的正文只在扩展写的转写文件里（`transcript.ts` 的文件头），flush 粒度是 `turn_end`。
 * 前台档（`Agent` 阻塞）里父会话的帧很稀（真机：派发到收场之间 4 帧 `tool_execution_update`，
 * 没有一帧带正文）⇒ 投影主要靠 wire 的**合成帧**换来（后台档里父会话自己的事件也走同一挂载点）。
 * 投影与 flush 天然对齐：子会话收一轮、我们读一次。
 *
 * ## 四条闸门（一条不满足就跳过这个身份，一个字不投）
 *
 * 1. **总线已报终态的不读**（`settledIds`）：收场身份的尾巴归收尾对账补（`finalizePiSubagents`），
 *    跑动期再读只会与它赛跑；
 * 2. **子任务行必须已在更早一批投影里落账**（`deliveredEarlier`）：骨架在同一批投影里
 *    **先发消息、后发子任务行**（turn.ts 的发射顺序），行本批才落、消息本批就跟的话，
 *    消息会先于行进账——客户端 `build-model` 只认记录里的身份，会把这批消息归进主会话。
 *    晚一批事件（毫秒级）再投，落点就是对的；
 * 3. **读盘按身份节流**（`transcriptReadAt`）：投影逐条到达，不节流的话一个话痨子任务
 *    每秒带来几十次全量读盘；
 * 4. **只投差量**（`transcriptEmitted` 按投影条数切片）：转写文件 append-only、行一旦
 *    flush 即不可变 ⇒ 切片下标稳定；重发已投过的那一段只会在 `messages.jsonl` 留下
 *    同内容的重复行（客户端按 `mergeKey` 覆盖会收敛，但账本不该虚胖）。
 *
 * ## 读不到是跑动期的常态，不是错误
 *
 * 在飞的子会话可能还没 flush 过任何一行（文件尚未创建）——这一档**静默跳过、不落 WARN**：
 * 「还没有正文」是正常形状。转写读不到的**权威** WARN 在收尾对账那一条（收场了还读不到
 * 才是「步骤不在产物里」）。
 *
 * ## 与骨架的两处交互（有意为之）
 *
 * · 这批消息让 `projectionHasOutput` 为真 ⇒ 看门狗的空闲计时随之重置——子智能体在干活
 *   就是这一行在干活（与 `deliverStartedSubagents` 的子任务行算「有输出」同一条先例）；
 * · 消息里的工具块会进 `trackToolBlocks` 的在途集合：子会话命名空间的 callId 与其结果
 *   自配平（add 后随差量 delete），跨会话撞名才会错销账，pi 的调用 id 带随机后缀，实践上不撞。
 */
function deliverTranscriptIncrements(
  runState: PiRunState,
  subagents: PiSubagentRecorder,
  readTranscript: (agentId: string) => PiSubagentTranscript,
  /** 子任务行已经在**更早一批**投影里落账的身份（本批新落的行在本批消息之后才发射） */
  deliveredEarlier: ReadonlySet<string>,
): MessageDraft[] {
  const messages: MessageDraft[] = [];
  const settled = new Set(subagents.settledIds());
  const now = Date.now();
  for (const agentId of subagents.startedIds()) {
    if (settled.has(agentId)) continue;
    if (!deliveredEarlier.has(agentId)) continue;
    const last = runState.transcriptReadAt.get(agentId);
    if (last !== undefined && now - last < PI_SUBAGENT_TRANSCRIPT_POLL_MS) continue;
    runState.transcriptReadAt.set(agentId, now);
    const transcript = readTranscript(agentId);
    const emitted = runState.transcriptEmitted.get(agentId) ?? 0;
    const fresh = transcript.messages.slice(emitted);
    if (fresh.length === 0) continue;
    runState.transcriptEmitted.set(agentId, emitted + fresh.length);
    messages.push(...fresh);
  }
  // 同一条消息可能已被 wire 通路投出（载体键相同）⇒ 只留 wire 没覆盖到的（见 emitSubagentDrafts）
  return emitSubagentDrafts(runState, messages);
}

/**
 * **跑动期的 wire 增量**：把子会话事件缓冲折成消息，只投**行已落账**的那部分身份。
 *
 * 与转写增量同一条闸门（`deliveredEarlier`）与同一个原因：骨架在同一批投影里先发消息、
 * 后发子任务行。差别在**排空是选择性的**——`wire.drain(身份集合)` 只取走已放行的身份，
 * 还没放行的留在缓冲里等下一批（wire 事件是一次性的，排空即消费，不像转写可以重读）。
 *
 * 不设「已收场不排」的闸（转写增量有）：wire 缓冲是唯一正源、无重读竞态，收场身份的
 * 尾巴在随后的父事件上照常排空，收尾 `finalizePiSubagents` 再兜一次底。
 */
function deliverWireIncrements(
  runState: PiRunState,
  subagents: PiSubagentRecorder,
  wire: PiSubagentWire,
  /** 子任务行已经在**更早一批**投影里落账的身份 */
  deliveredEarlier: ReadonlySet<string>,
): { messages: MessageDraft[]; warnings: string[] } {
  const drained = wire.drain(deliveredEarlier);
  return { messages: emitSubagentDrafts(runState, drained.messages), warnings: drained.warnings };
}

/**
 * 子会话消息的**载体去重**：同一条逻辑消息在 wire 与转写两条通路上给出同一个载体键
 * （轮次对齐的口径见 `subagent-wire.ts` 的文件头），**第一条到达者胜出**，后到的整条丢掉。
 *
 * 判据是**快照**，不是「这个载体出现过没有」：同一轮的逐字增量与它的收尾快照载体键逐字相同，
 * 按载体挡会让先到的 delta 占死键、收尾快照被整条丢掉（消息永远停在半截）。
 * 于是 delta 一律放行（只有 wire 产 delta，转写天然只有快照 ⇒ 放行不会引入重复内容），
 * 只有快照之间互斥。
 *
 * 只对 `subagentId !== null` 的草稿生效：主会话的同一载体合法地收「增量 + 快照」多次投递
 * （合并器靠它拼出完整块），把主会话草稿也过一遍会把快照挡掉、消息永远停在「未收尾」。
 */
function emitSubagentDrafts(runState: PiRunState, drafts: MessageDraft[]): MessageDraft[] {
  const fresh: MessageDraft[] = [];
  for (const draft of drafts) {
    if (draft.subagentId === null) {
      fresh.push(draft);
      continue;
    }
    // 增量不参与互斥：它与同轮快照同键，记账会把快照挡掉（见本函数的判据那一段）
    if (draft.chunk === 'delta') {
      fresh.push(draft);
      continue;
    }
    const key = carrierKeyOf(draft);
    if (runState.subagentCarriers.has(key)) continue;
    runState.subagentCarriers.add(key);
    fresh.push(draft);
  }
  return fresh;
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
 * ⚠️ **名字取入参里的 `name`，没有才退回任务描述**（两条通路共用 `resolveDispatchName`，
 * 见那一格的说明）：`details.displayName` 是 agent **类型**的展示名（真机上是常量 `Agent`），
 * 拿它当名字等于每一行都叫同一个名字。
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
  /**
   * **名字与派发行逐字相同**（`resolveDispatchName` 是两条通路共用的那一份）：
   * 派发那一刻已经定下的名字，收尾不许换——界面会在收尾那一刻把卡片标题改掉。
   */
  const name = resolveDispatchName(toolCallId, details.description, runState);
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
    // 收尾那一刻的厂商状态原文（收尾对账在「总线只报了 started」时沿用它，见 `PiDispatch.rawStatus`）
    rawStatus,
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
  /**
   * 本层自己中止的那一轮（结构化输出预算）：厂商把它报成 `error` + `This operation was aborted`，
   * 而那一条失败会盖掉投影层记下的点名原因 ⇒ 这里让位（原因已经由 `projectToolExecutionEnd` 交出）。
   */
  if (runState.selfAborted) return null;
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
  const errorMessage = readString(message, 'errorMessage');
  const text = piFailureText(errorMessage, context.baseUrl);
  /**
   * 上游**自己报的超时**按契约归 `AGENT_TIMED_OUT`（`types.ts`：「上游自己报的超时也归它」）。
   * 为什么不能交给 `classifyAgentMessage`：它只认 HTTP 状态（`status` / 文案里的状态码），
   * 而厂商原文是一句不带状态码的裸英文短句 ⇒ 会被归成 `AGENT_FAILED`，那一格在自动重试表里
   * （`orchestrator.ts` 的 `TRANSIENT_ROW_RETRY_CODES`）⇒ 一次上游超时被白跑两遍还各等一次退避，
   * 而重试改变不了它。
   */
  if (errorMessage !== null && PI_TIMEOUT_TEXT.test(errorMessage)) {
    return { code: 'AGENT_TIMED_OUT', message: text };
  }
  return classifyAgentMessage(text, context);
}

/**
 * 厂商**自报超时**的原文指纹（`piFailureText` 与失败归因两处共用一份，避免两处各写一条正则）。
 * 它是厂商 SDK 自己的请求时限（`Request timed out.`），不是我们的看门狗。
 */
const PI_TIMEOUT_TEXT = /request timed out/i;

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
  if (PI_TIMEOUT_TEXT.test(original)) {
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
 * ## 两格分量**各自**判「全量或 null」
 *
 * 任何一次**已派发**的子智能体拿不到终态（还在跑、或这一行的结论先落了），或拿到了终态却没有可读的
 * 用量 / 轮次 ⇒ **那一格**记 `null`、对应的合计退回主会话口径，并落一条**点名** WARN——绝不把部分和
 * 冒充总数（部分和与全部读完在界面上长得一模一样）。与 codex / claude 那两条 reads 同一条口径。
 *
 * **两格不互相作废**（这一条与「一项不完整就整组作废」的旧口径相反，理由是厂商面本身不对称）：
 * 用量那一格来自总线终态载荷（`subagents:completed` / `failed` 的 `usage`，与 pi-ai 的 `Usage` 同形），
 * 而轮次那一格**只在 `Agent` 工具结果的 `details.turnCount` 里**——后台档（`run_in_background`）
 * 下工具派发即返回、那一刻子智能体还没跑，而厂商的总线终态载荷里**没有** `turnCount` 这一格。
 * 于是后台档**结构上**永远拿不到轮次；把两格绑在一起，会让一份**真读到了**的用量跟着作废
 * （症状是「给不出」，而子智能体确实花掉了一整轮输入）。契约与一致性套件都允许「用量在、轮次 null」
 * （`checkUsagePairing` 只判 `subagentTurns` 不许比 `turns` 更清楚，不要求两格同时在场）。
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
   * 为什么必须有这一格：子会话的事件**不在父会话的流里**，唯一带正文的通道是扩展写的
   * 转写文件（见 `transcript.ts`）。它是**旁路文件**，与流没有先后保证——跑动期已按
   * 事件心跳增量投过一部分（`deliverTranscriptIncrements`），这一层补**收尾差量**：
   * 已收场身份在「最后一次增量读」与「收场」之间 flush 的那几行只有这里能拿到。
   * 读不到**不影响结论**（子任务正文是补充信息），只是界面上那个节点停在增量那一段。
   */
  readTranscript?: (agentId: string) => PiSubagentTranscript,
  /**
   * wire 通道（缺省 = 这一行没有 wire）。收尾排空它**尚未消费的尾巴**：终态事件的到达
   * 与最后几条子会话事件之间没有先后保证，最后一次父事件排空可能差那几条；
   * 转写差量随后只补 wire 没覆盖到的载体（`emitSubagentDrafts`，两条通路同一把尺）。
   */
  wire?: PiSubagentWire,
): TurnFinalize {
  if (!runState.dispatched) return { drafts: [] };

  const mainTokens = cumulativeTokens(state);
  const settled = new Map<string, PiSubagentEvent>();
  for (const agentId of subagents.settledIds()) {
    const event = subagents.latest(agentId);
    if (event !== null) settled.set(agentId, event);
  }

  /**
   * **对账集合 = 派发记录 ∪ 总线身份**。
   *
   * 为什么不能只遍历 `runState.dispatches`：那一格只在 `Agent` 工具的收尾事件里带得出
   * `details.agentId` 时才登记（见 `projectDispatchEnd`），而「这一行有哪些子智能体」的权威面是
   * 扩展总线。两者分家时（工具结果是厂商自己合成的裸错误、或那次收尾压根没到），一个**真跑过**
   * 的子智能体会既拿不到终态行（卡片永远停在「运行中」）也不进用量——而这里正是它唯一的补账点。
   */
  const accounted = new Set<string>([
    ...runState.dispatches.keys(),
    ...subagents.startedIds(),
    ...subagents.settledIds(),
  ]);

  /**
   * **要投终态行的那些身份** = 派发记录 ∪ **总线已报终态**的身份。
   *
   * 只加「已报终态」那一半：总线只报了 `started` 的身份现在有一条 `running` 行在账上，
   * 而这一层给不出它的 `rawStatus`（总线载荷没有状态时就该判 `unknown`）⇒ 在这里补一条
   * 会把状态从「运行中」改成「未知」，那是倒退。它若在派发收尾时留下了状态，
   * 走 `dispatch?.rawStatus` 那一支沿用（见下面 `piSubagentRecord` 的调用点）。
   */
  const rowIds = [...new Set([...runState.dispatches.keys(), ...settled.keys()])];

  /**
   * 逐个对账：派发过、但没拿到完整读数的那些**必须点名**（静默按已收到的求和会得到一个看着正常的数）。
   *
   * 两格各记一份：**用量**（总线终态载荷里的那一份）与**轮次**（`Agent` 工具结果里的 `turnCount`）
   * 各有各的来源与失败形态，合成一句会让「哪一格缺、为什么缺」都读不出来。
   */
  const usageGaps: string[] = [];
  const turnGaps: string[] = [];
  const usage: UsageTokens[] = [];
  let turns = 0;
  if (accounted.size === 0) {
    // 派发过（`dispatched` 为真）却连一条身份都没拿到：两格都没有可求和的读数，不能报零
    usageGaps.push('本行派发过子智能体，但一条身份都没拿到（工具结果里没有身份，总线也没报过）');
  }
  for (const agentId of accounted) {
    const dispatch = runState.dispatches.get(agentId) ?? null;
    const event = settled.get(agentId) ?? null;
    if (event === null) {
      /**
       * 没有终态事件 = 本行收尾那一刻它还没收场。**这不是「它活过了本行」**：子会话与父会话共用
       * 同一个扩展运行器，本行的释放序列（`session.dispose()` 里的 `_extensionRunner.invalidate`）
       * 会把它一起终结——真机五档释放对照里 `dispose-only` 那一臂就足以让子会话一个模型往返都
       * 跑不起来（子会话出站 0 次、转写只剩 user 行），而只 abort / 不释放两臂照常跑完。
       * **两格都拿不到**：用量只在终态载荷里，而轮次那一刻本来就是半截的。文案要把机制说出来
       * （并附上收尾那一刻的厂商状态原文），否则读起来像「它还在后台跑」。
       */
      const unsettled = dispatch?.rawStatus === null || dispatch?.rawStatus === undefined
        ? `${agentId}（本行收尾那一刻它还没收场：本行的释放序列会连同它一起终结）`
        : `${agentId}（本行收尾那一刻它还没收场（厂商记的状态是 ${dispatch.rawStatus}）：`
          + '子会话挂在父会话的扩展运行器上，本行的释放序列会连同它一起终结）';
      usageGaps.push(unsettled);
      turnGaps.push(unsettled);
      continue;
    }
    if (event.usage === null) usageGaps.push(`${agentId}（终态到了，但那一份载荷里没有可读的用量）`);
    else usage.push(event.usage);
    if (dispatch === null) {
      // 派发记录缺席 ⇒ 轮次也没有来源（那一格只从 `Agent` 工具结果的 `details` 里来）
      turnGaps.push(`${agentId}（终态到了，但没有派发记录：轮次只在 Agent 工具结果的 details 里，总线载荷不带这一格）`);
    } else if (dispatch.turnCount === null) {
      /**
       * 后台档的结构性缺口：`projectDispatchEnd` 在工具收尾那一刻状态还是「运行中」时**刻意**
       * 把 `turnCount` 记 `null`（半截的轮次数不是读数），而厂商的总线终态载荷里没有这一格
       * ⇒ 它此后**再没有第二个到达点**。文案必须把这条机制写出来，否则读起来像一次读失败。
       */
      turnGaps.push(`${agentId}（后台档：Agent 工具派发即返回，那一刻子智能体还没跑过一轮；`
        + '厂商的总线终态载荷里不带 turnCount）');
    } else turns += dispatch.turnCount;
  }

  /**
   * 两格**各自**判完整性（见函数头的「两格分量各自判」）：用量齐了就交 `subagentTokens`，
   * 轮次缺只让 `subagentTurns` 记 `null`。
   *
   * 两格都还要过「合计那一侧拿不拿得出」这一关：主会话一条助手用量都没读到、或一次往返都没数到时，
   * 分量比合计更清楚是自相矛盾的读数（一致性套件的用量配对判据会当场红）。
   */
  const mainGap = mainTokens === null
    ? (state.turns <= 0 ? '主会话一条助手用量都没读到、一次往返也没数到' : '主会话一条助手用量都没读到')
    : (state.turns <= 0 ? '主会话一次往返都没数到' : null);
  const usageTotal = accounted.size === 0 || usageGaps.length > 0 || mainGap !== null
    ? null
    : sumUsageTokens(usage);
  const turnsTotal = accounted.size === 0 || turnGaps.length > 0 || state.turns <= 0
    ? null
    : turns;

  /**
   * 子会话正文：**wire 尾巴先排**（`deliverWireIncrements` 同一把载体尺，先到先占），
   * **转写逐身份各读一次**补差量，顺带把「为什么读不到」落成点名 WARN。
   * 只给**已经收场**的那些补转写差量——还在跑的子会话增量那一段已经在账本里，而它在本行
   * 收尾之后还会继续写、追不到底；已收场身份「最后一次增量读」之后的尾巴只有这里能拿到。
   */
  const messages: MessageDraft[] = [];
  const drafts: AgentEventDraft[] = [];
  if (wire !== undefined) {
    // 收尾是独立的一批（晚于最后一条父事件），行落账的时序闸在此不再适用
    const tail = wire.drain(subagents.deliveredIds());
    messages.push(...emitSubagentDrafts(runState, tail.messages));
    drafts.push(...tail.warnings.map((warning) => logDraft('stderr', `[WARN] ${warning}`)));
  }
  const transcriptNotes: string[] = [];
  if (readTranscript !== undefined) {
    /**
     * 逐身份补差量的集合 = 「要投终态行的那些」（见 `rowIds`）——总线报了终态但没有派发记录的
     * 身份同样要读：那正是它的步骤唯一的来源。
     */
    for (const agentId of rowIds) {
      if (!settled.has(agentId)) continue;
      const transcript = readTranscript(agentId);
      /**
       * 只补**差量**：跑动期增量投过的那一段不重发（重发只会在 `messages.jsonl` 留下
       * 同内容的重复行）。没跑过增量的身份这一格是 0 ⇒ 整份照投，与只有收尾一条
       * 通路时的旧形状逐字一致。wire 已投过的载体由 `emitSubagentDrafts` 挡掉。
       */
      const emitted = runState.transcriptEmitted.get(agentId) ?? 0;
      messages.push(...emitSubagentDrafts(runState, transcript.messages.slice(emitted)));
      if (transcript.warning !== null) transcriptNotes.push(transcript.warning);
    }
  }

  /**
   * 分量的两条点名 WARN：**逐格**说清是哪一格、为什么。三档优先级：
   *   ① 有缺口名单 ⇒ 照名单点名（缺口是更具体的原因）；
   *   ② 名单为空而这一格仍然交不出 ⇒ 原因在合计那一侧（`mainGap`）；
   *   ③ 交得出 ⇒ 一条都不落。
   */
  const usageWarn = usageTotal !== null
    ? null
    : usageGaps.length > 0
      ? `[WARN] 这一行的子智能体用量给不出（记 null，不编造、不填 0）：${usageGaps.join('、')}`
      : mainGap === null
        ? null
        : `[WARN] 这一行的主子用量拿不出来（${mainGap}），子智能体用量随之记 null（分量不可能比合计更清楚）`;
  const turnsWarn = turnsTotal !== null
    ? null
    : turnGaps.length > 0
      ? `[WARN] 这一行的子智能体轮次给不出（记 null，不编造、不填 0）：${turnGaps.join('、')}`
      : mainGap === null
        ? null
        : `[WARN] 这一行的主子轮次拿不出来（${mainGap}），子智能体轮次随之记 null（分量不可能比合计更清楚）`;
  drafts.push(
    ...(usageWarn === null ? [] : [logDraft('stderr', usageWarn)]),
    ...(turnsWarn === null ? [] : [logDraft('stderr', turnsWarn)]),
    ...(transcriptNotes.length > 0
      ? [logDraft('stderr', `[WARN] 子任务的逐步骤正文没取全：${transcriptNotes.join('、')}`)]
      : []),
  );

  const rows = rowIds.map((agentId) => {
    const dispatch = runState.dispatches.get(agentId) ?? null;
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
      name: dispatch?.name ?? event?.description ?? null,
      /**
       * 状态**不许倒退**，且**收尾时如实记「已停止」**：
       *   · 总线报了终态 ⇒ 用它（它是子会话收场那一刻的记录）；
       *   · 总线只报了 `started`（后台档的常态）⇒ **不再沿用派发那一刻的 `background`**：
       *     本行的释放序列（`session.dispose()` → 扩展运行器作废）会把这个子会话一起终结，
       *     真机五档对照里 `dispose-only` 一臂就足以让它一个模型往返都跑不起来 ⇒ 收尾这一份
       *     快照记 `stopped`（`piSubagentStatus('stopped')`），界面上从「运行中」翻成「已停止」，
       *     而不是永远转圈。理由与点名 WARN 一致（见 `usageGaps` / `turnGaps` 里那条
       *     「本行收尾那一刻它还没收场……本行的释放序列会连同它一起终结」）。
       *   · 两处都没有（连派发记录也没有）才是真的没采到 ⇒ `unknown` + `not-observed`。
       */
      rawStatus: event?.rawStatus ?? (dispatch === null ? null : 'stopped'),
      outcome: event?.outcome ?? null,
      parentCallId: dispatch?.toolCallId ?? null,
      usage: event?.usage ?? null,
    });
  });
  // 收尾这一份是**完整快照**；与工具收尾那条逐字相同的话由收数器挡掉（见 `deliver`）
  const delivered = rows.flatMap((row) => subagents.deliver(row));

  /**
   * 四格各按各的完整性交：`subagentTokens` / `subagentTurns` 的 `null` 是**明确没采到**（覆盖掉旧值），
   * 而 `tokens` / `turns` 的缺省是「本条不带这一格」（骨架保持主会话口径的原值）。
   *
   * 合计与它的分量**同刻**交出（分量能交时合计一定带上它）：只给分量不给合计会让界面按
   * 「主会话 = 合计 − 分量」算出负数；只给合计不给分量则是那句「确实没有子智能体」的假话。
   */
  return {
    drafts,
    messages,
    subagents: delivered,
    ...(usageTotal === null || mainTokens === null ? {} : { tokens: addUsage(mainTokens, usageTotal) }),
    ...(turnsTotal === null ? {} : { turns: state.turns + turnsTotal }),
    subagentTokens: usageTotal,
    subagentTurns: turnsTotal,
  };
}
