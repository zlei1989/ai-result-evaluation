/**
 * dsh 的通知投影（§5.6.3）：**按真实探测回写**（Task 12 第 1 步）。
 * 实测口径（探测报告 §2/§3，`probe/dumps/dsh.json`）：
 *  - 通知外形是 `{ method, params }`，method 只有四种；**事件全在 `session.event` 里**，
 *    真正的判别字段是 `params.event.type`（`agent/inbox/spliced`、`turn/start`、`step/start`、
 *    `system/message`、`user/message`、`request/header`、`request/context`、`session/title`、
 *    `session-log-…`、`assistant/message`、`step/end`、`turn/end`）；
 *  - **用量在 `assistant/message` 上**：`params.event.data.usage = { inputTokens, outputTokens,
 *    cacheReadTokens?, cacheWriteTokens?, totalTokens? }`（`TokenUsage` 的计数**互斥**：
 *    `inputTokens` 只算未命中缓存的输入，缓存读单独在 `cacheReadTokens` ⇒ 映射到本仓三元组不会双计）；
 *  - **轮次结束是 `turn/end`**：`params.event.data = { turn, reason: { kind } }`，`kind` 取值实测
 *    `completed` / `error`（类型面另有 `aborted` / `blocked` / `max-tokens` / `interrupted` / `forked`）；
 *  - **一次模型 API 往返 = 一个 step**（用户口径，2026-09-28）：实测事件序列是
 *    `turn/start` → `step/start` → `request/header` → `request/context` → `assistant/message`
 *    → `step/end`（→ 下一个 `step/start` …）→ `turn/end`，`assistant/message` 上带着 `{turn, step}`。
 *    所以**轮次从 `step/start` 数**：它是「这一次请求已经发出去了」的落点，而不是等整段任务收尾。
 *    实测那一轮（`ae798e52` 的 dsh 行）`step/start` = 59、`assistant/message` = 59，而 `turn/end` 只有
 *    **1** 条 —— 原来按 `turn/end` 数，界面上永远是「轮次 1」。
 *  - **失败通道就是 `turn/end` 的 `reason.kind === 'error'`**：`reason.error` 实测有两种形状——
 *    结构化 `{ message, code:"TRANSPORT" }`（传输失败）与**纯字符串** `"…"`（SDK 把非结构化异常
 *    折成 `{ message: errorChain(error), code: 'UNKNOWN' }`，而 `errorChain` 对普通 Error 返回 string）。
 *    两种都要认，否则一次失败的运行会被投影成普通日志、骨架返回 `ok: true, completed`
 *    （「界面显示成功、实际没干活」——评审 L2 点名的那一格）。
 * 其余口径不变：未识别一律 `unknownEventDraft(payload)` 保留原始负载；计量三项齐了才认，缺项 → null + WARN。
 * **时长（2026-10-XX 新增）**：dsh 的用量载荷里**没有任何时间字段**，时间只在会话事件自己身上
 * （`params.event.time`，epoch 毫秒，每条事件都有）⇒ 本行的 `timing` 一律 `source: 'events'`
 * （含工具执行的墙钟），起止取**识别到的那几条事件**的首末 `time`（见 `noteEventTime`）。
 * `ttftMs` 永远是 `null`（dsh 不上报首 token 时延），`apiMs` 同样（它只有 claude 有）。
 * ⚠️ **量本身是累计的、不清零**（见 `assistant/message` 那一支），所以`timing` 也是「到目前为止」的
 * 口径：起点一次定下、右端点每条带时间的消息往后推——这与 `tokens` 的覆盖语义同源。
 * `session.status`（`running` / `idle`）**刻意不投影**：它与轮次语义无关，骨架不需要它，
 * 落成日志只会让抽屉噪声翻倍——但它仍然是「已识别且有意不投影」的一格，不是未识别。
 *
 * 2026-09-29 追加三类投影（用户口径：卡片底部那一行动效要**实时滚动智能体的 event message**，
 * 不能只显示一句「正在思考…」，也不能是 JSON）：
 *  - `tool/call`：`params.event.data = { turn, step, callId, name, arguments }`，其中 `arguments` 是
 *    **JSON 字符串**（实测 `{"job_id": "pwsh-16", "timeout_ms": 420000, "wait": true}`）；
 *    摘要文案是「调用工具 <工具名>：<参数摘要>」（用户指定的措辞）；
 *  - `tool/result`：`params.event.data.message = { role:'tool', toolCallId, content:[{type:'text',text}], isError }`；
 *  - `assistant/message` 的{文本}落成一条日志（过去只进 `finalText`，整轮不出现在任何地方），
 *    `turn/start` 也补一句「第 N 轮开始」——评分阶段跑的是同一个适配器，它的消息因此同样会滚上去。
 *    这些**原始负载照旧逐字落盘**（抽屉里的证据一个字没少），只是多带一句人话摘要
 *    （`log.summary`）——摘要才是给人看的那一句，JSON 不是消息。
 */
import type { UsageTokens } from '@aieval/contracts';
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import { mergeTiming, type TimingSpan, type TurnProjection, type TurnState } from '../../turn';
import type { MessageDraft } from '../../message';
import {
  dshAssistantMessageDraft,
  dshSessionIdOf,
  dshSubagentRecord,
  dshToolCallDraft,
  dshToolResultDraft,
  lookupDshSubagentCatalog,
  noteDshSessionUsage,
  rememberDshSubagentCatalog,
} from './message';
import {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_SESSION_EVENT_METHOD,
  DSH_STEP_START_TYPE,
  DSH_SUBAGENT_CATALOG_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  DSH_TOOL_CALL_TYPE,
  DSH_TOOL_RESULT_TYPE,
  DSH_TURN_END_TYPE,
  DSH_TURN_START_TYPE,
} from './protocol';

export {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_SESSION_EVENT_METHOD,
  DSH_STEP_START_TYPE,
  DSH_SUBAGENT_CATALOG_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  DSH_TOOL_CALL_TYPE,
  DSH_TOOL_RESULT_TYPE,
  DSH_TURN_END_TYPE,
  DSH_TURN_START_TYPE,
} from './protocol';
/**
 * 关联表的清空口（实现与唯一真源在 `message.ts`）：测试按这个名字 import，故在这里再导出一次，
 * 不另留第二份实现。
 */
export { resetSubagentCatalogForTesting } from './message';

/** 用量载荷在事件信封里的路径：`params.event.data.usage`。 */
export const DSH_USAGE_PATH = ['params', 'event', 'data', 'usage'] as const;
/** 摘要的长度上限：这一行的用途是「一眼看出在干什么」，完整参数与输出都在抽屉的原始负载里 */
export const DSH_SUMMARY_MAX_LENGTH = 120;
/**
 * 用量三元组的字段名，**逐字来自真实探测**（`probe/dumps/dsh.json` 的
 * `assistant/message → data.usage`）：`{"inputTokens":218,"outputTokens":2,"cacheReadTokens":8832,…}`。
 */
export const DSH_USAGE_FIELDS = {
  input: 'inputTokens',
  cached: 'cacheReadTokens',
  output: 'outputTokens',
  /** 思考 token（`TokenUsage.reasoningTokens`，类型上可选）：**采不到就是 null，不填 0** */
  reasoning: 'reasoningTokens',
  /** 厂商自报的总量（`TokenUsage.totalTokens`）：**只是证据**，不参与归一后的恒等式（见契约注释） */
  total: 'totalTokens',
} as const;
/**
 * 会话事件的**时间字段名**：`params.event.time`（epoch 毫秒，每条会话事件都有）。
 * 为什么不用我们自己的 `AgentEvent.at`：那是 core 的事件写入器打的**我们这一侧**的时刻，
 * 与厂商事件发生的时刻不是一回事（差在网络与处理延迟上）。dsh 的时间只能从这一格取。
 */
export const DSH_EVENT_TIME_FIELD = 'time';

export function projectDshNotification(raw: unknown, state: TurnState, context: FailureContext): TurnProjection {
  const notification = asRecord(raw);
  const method = readString(notification, 'method');
  // 子智能体的两条**顶层通知**（不是 session.event 包一层）——真机实测的通道，见 §6.5.1
  if (method === DSH_SUBAGENT_STARTED_METHOD || method === DSH_SUBAGENT_FINISHED_METHOD) {
    // 事件那条是给人看的摘要（含原始载荷），子任务行才是有类型的契约形状（spec v3 §2.6）
    const record = dshSubagentRecord(notification);
    return {
      drafts: [subagentDraft(notification)],
      tokens: null,
      turns: null,
      failure: null,
      subagents: record === null ? [] : [record],
    };
  }
  // 只认一种通知外形：`{ method, params }`。其余（含未来新增方法）保留原始负载（§5.6.3）
  if (method !== DSH_SESSION_EVENT_METHOD) {
    return unknown(raw);
  }
  const event = asRecord(notification?.params)?.event;
  const eventRecord = asRecord(event);
  const type = readString(eventRecord, 'type');
  const data = asRecord(eventRecord?.data);
  /** 这一条事件属于哪个会话：子会话的事件与主会话在同一条流里，靠这一格区分（子任务归属的唯一依据） */
  const sessionId = dshSessionIdOf(notification);

  /**
   * 子任务目录项：**只登记、不产出事件**。
   *
   * 为什么必须记：`label`（任务名）与 `mode` **只在这一条消息里**，而 `subagent.started` 只带
   * 两个 sessionId ⇒ 不跨消息记住的话，start/finish 两条都拿不到名字（真机实测 §6.5.1）。
   * 为什么自己不产出事件：它是**身份补充**，不是进度——落成日志只会给抽屉添噪声。
   */
  if (type === DSH_SUBAGENT_CATALOG_TYPE) {
    rememberDshSubagentCatalog(data);
    return { drafts: [], tokens: null, turns: null, failure: null };
  }

  if (type === DSH_ASSISTANT_MESSAGE_TYPE) {
    const drafts: AgentEventDraft[] = [];
    noteEventTime(state, eventRecord);
    /**
     * 子会话的用量按 `sessionId` 分组求和（spec v3 §3.3：`subagent.started` / `finished`
     * **不带用量** ⇒ 子任务级用量只能这样拿）。这一个调用对主会话也有记录，
     * 而 `dshSubagentRecord` 只按**子任务身份**取值 ⇒ 主会话那一条永远不会被读到。
     */
    noteDshSessionUsage(sessionId, asRecord(data)?.usage);
    const tokens = readTokens(asRecord(data)?.usage, drafts);
    if (tokens !== null) {
      // 记进**本行累计**：`step/start` / `turn/end` 两条出口都从这里取「到目前为止」的值。
      // 刻意**不清零**（原来在 `turn/end` 上取走并归零）：现在的口径是「累计快照」，
      // 每次交出都带全量，界面上只会单调增长；清零+跨消息配对正是旧口径下一堆特判的来源。
      state.usageInput = (state.usageInput ?? 0) + tokens.input;
      state.usageCached = (state.usageCached ?? 0) + tokens.cached;
      state.usageOutput = (state.usageOutput ?? 0) + tokens.output;
      /**
       * 思考 token 与厂商自报总量（2026-10-XX 新增）。两格的累加口径**刻意不同**：
       *   · `reasoningTokens` 与上面三格同族 ⇒ **相加**（每个 step 的思考量各自独立）；
       *   · `totalTokens` 是厂商给的**累计快照** ⇒ 只**覆盖**、不相加（相加会把总量算成好几倍）。
       * 两格都只在读到时更新：`null`（这一条没带）**不把已采到的值抹掉**——与
       * 「路径上后到的消息可能更简略」这条既有事实同源（`cumulativeTokens` 每次交的都是全量）。
       */
      if (tokens.reasoningOutput != null) {
        state.usageReasoningOutput = (state.usageReasoningOutput ?? 0) + tokens.reasoningOutput;
      }
      if (tokens.total != null) state.usageTotal = tokens.total;
    }
    // 最终答复：只取 `type === 'text'` 的非空块。实测（probe/dumps/dsh.json 的 assistant/message）：
    // 同一个 content 数组里同时有 `{type:'reasoning', text:…}` 与 `{type:'text', text:'好'}`，
    // 而 reasoning 块**也带 text 字段** —— 按 text 取值会把推理内容混进答复。
    const reply = readAssistantText(data);
    if (reply !== '') {
      state.finalText = reply;
      /**
       * 模型说的话**也要落一条日志**（用户口径 2026-09-29：活动行要滚动智能体实时的 event message
       * ——「评分的消息也在这里滚动展示」）。这一格过去只进 `finalText`，整轮都不出现在任何地方，
       * 于是卡片上只能看到工具 JSON。
       * 与 claude-code 的文本块同待遇：`text` 是原文（抽屉里的证据），`summary` 是压成一行的那句。
       * **这里不筛 JSON**：评分阶段模型吐的就是 JSON 评分结果，筛不筛由消费方（`activityOf`）判——
       * 判据只能有一份，写两处必然漂移。
       */
      drafts.push(logDraft('stdout', reply, clip(oneLine(reply))));
    }
    /**
     * **推理原文单独落一条**（2026-09-30 真机更正）。
     *
     * 过滤掉 reasoning **是对的**（否则推理混进答复），但**只过滤不落盘就是把证据丢了**：
     * 真机实测 dsh 每次模型往返都带完整推理文本（三次往返 259 / 68 / 143 字符），
     * 而修复前这里一个字都不留。
     *
     * 与 claude-code **同待遇**：那边非文本块走 `others` 分支落一条原始负载日志
     * （`providers/claude-code/events.ts` 的 `assistantDrafts`）——所以两边在抽屉里都看得到推理。
     * dsh 的 `text` 是**纯字符串**（不是块对象），所以直接落原文，比 claude 那边再序列化一层更诚实。
     *
     * ⚠️ 被推翻的旧口径：本文件上游曾断言「dsh 的 reasoning `text` 实测恒为空串」——
     * 那是**探测中继把整条流转成单块、破坏 SSE 分块**造成的假象（2026-09-30 复现并定位）。
     */
    const reasoning = readAssistantReasoning(data);
    if (reasoning !== '') {
      drafts.push(logDraft('stdout', reasoning, clip(oneLine(`思考：${reasoning}`))));
    }
    // 本步的计量一到就交出去（轮次用**已经数到的**值）：界面上的 tok 因此在一个 step 内也会动，
    // 而不是等 `turn/end`。轮次还没有数到（形状异常：没有 step/start）时给 null——不发明一个 0。
    return {
      drafts,
      tokens: cumulativeTokens(state),
      timing: state.timing ?? undefined,
      turns: state.turns > 0 ? state.turns : null,
      failure: null,
      /**
       * 内容级消息（spec v3 §2）：同一个 `assistant/message` 的 `content[]` 是**完整快照**
       * ⇒ 一条消息带齐全部块（推理 + 正文），块序号按内容顺序分配。
       * 与上面的日志**并行**：事件是行级审计与活动行，消息是对话视图与工具族统计的载体。
       */
      messages: optionalMessage(dshAssistantMessageDraft(notification, sessionId, roundTripOf(state))),
    };
  }

  if (type === DSH_STEP_START_TYPE) {
    // 一次模型 API 往返已经开始：这是本轮轮次的**唯一**计数点（见文件头）
    state.turns += 1;
    return { drafts: [], tokens: cumulativeTokens(state), turns: state.turns, failure: null };
  }

  if (type === DSH_TURN_START_TYPE) {
    // 轮次开始：原来走 `unknown`（原始 JSON 落盘），这里只**补一句人话摘要**，不多落一行。
    // 轮号取不到就写「?」——不发明一个数字（发明出来的轮号会让排障的人对着不存在的轮次找）
    const turn = readNumber(data, 'turn');
    // 时间也在这里记一笔：`turn/start` 是**整轮**的起点，比第一个 `step/start` 更早，
    // 而 tok/s 的分母要的正是「这一轮花了多久」⇒ 不记它会把第一轮的准备时间漏掉。
    noteEventTime(state, eventRecord);
    return {
      drafts: [logDraft('stdout', safeStringify(raw), `第 ${turn ?? '?'} 轮开始`)],
      tokens: null,
      timing: state.timing ?? undefined,
      turns: null,
      failure: null,
    };
  }

  if (type === DSH_TURN_END_TYPE) {
    const drafts: AgentEventDraft[] = [];
    noteEventTime(state, eventRecord);
    // 收尾这一条把**最新**的累计计量再交一次（最后一个 step 的用量是在它的
    // `assistant/message` 上到的，不进这一步的话它会永远停在上一版）；轮次已是最终值。
    // 失败照旧在这里认，且带上厂商原文。
    const tokens = cumulativeTokens(state);
    const timing = state.timing ?? undefined;
    const failureText = readTurnFailure(data);
    if (failureText === null) {
      return { drafts, tokens, timing, turns: state.turns > 0 ? state.turns : null, failure: null };
    }
    // 失败进该行的事件日志（骨架的 error 出口还会再发一条带 stack 的，两条都留：这条保留厂商原文）
    drafts.push({ type: 'error', message: failureText });
    return {
      drafts,
      tokens,
      timing,
      turns: state.turns > 0 ? state.turns : null,
      failure: classifyAgentMessage(failureText, context),
    };
  }

  // 工具调用 / 结果：**不是**「未识别」，但也不产生计量与轮次——事件那条为它补一句人话摘要
  // （见文件头），消息那条是内容级记录（工具族统计与对话视图读的就是它）。
  // `text` 还是那条原始 JSON：抽屉照旧逐字显示证据，卡片上的活动行显示的是 summary。
  if (type === DSH_TOOL_CALL_TYPE) {
    return {
      drafts: [logDraft('stdout', safeStringify(raw), summarizeToolCall(data))],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshToolCallDraft(notification, sessionId, roundTripOf(state))),
    };
  }
  if (type === DSH_TOOL_RESULT_TYPE) {
    return {
      drafts: [logDraft('stdout', safeStringify(raw), summarizeToolResult(data))],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshToolResultDraft(notification, sessionId, roundTripOf(state))),
    };
  }

  return unknown(raw);
}

/**
 * 这条消息属于**第几次模型往返**：取 `state.turns`（由 `step/start` 数出来）。
 * 还没数到（形状异常：一个 `step/start` 都没有）时给 1：信封这一格是必填正整数，
 * 而「不发这条消息」比「记成第 1 次」丢掉的信息更多（真机每一次往返都带 `step`，这条路径不可达）。
 */
function roundTripOf(state: TurnState): number {
  return state.turns > 0 ? state.turns : 1;
}

/** 归一草稿可能为 `null`（形状不满足那条消息的最小要求时宁可不发，也不发一条空壳） */
function optionalMessage(draft: MessageDraft | null): MessageDraft[] {
  return draft === null ? [] : [draft];
}

/**
 * `tool/call` 的人话摘要：`调用工具 <工具名>：<参数摘要>`（文案是用户口径 2026-09-29 定的）。
 * 工具名取 `data.name`（实测 `pwsh` / `job_output` / `read`…）；取不到就只说「调用工具」——
 * 不编一个名字（编出来的名字会让排障的人去找一个不存在的工具）。
 */
function summarizeToolCall(data: Record<string, unknown> | null): string {
  const name = readString(data, 'name');
  const hint = summarizeArguments(readString(data, 'arguments'));
  const title = name === null || name === '' ? '调用工具' : `调用工具 ${name}`;
  return hint === '' ? title : `${title}：${hint}`;
}

/**
 * `tool/result` 的人话摘要：`工具返回：<内容>`（`message.isError === true` 时是「工具报错：…」）。
 * 结果里**没有工具名**（只有 `toolCallId`），故不编一个；内容取 `message.content[]` 的 text 块
 * （与 `assistant/message` 的读法同源，实测形状一致）。
 */
function summarizeToolResult(data: Record<string, unknown> | null): string {
  const message = asRecord(data?.message);
  const label = message?.isError === true ? '工具报错' : '工具返回';
  const text = readContentText(message?.content);
  return text === '' ? label : `${label}：${clip(oneLine(text))}`;
}

/** 参数里最值得当摘要的字段，**按优先级**排（都是实测见过的：pwsh 的 command、Read 的 file_path…） */
const PREFERRED_ARGUMENT_KEYS = ['command', 'file_path', 'path', 'job_id', 'pattern', 'query', 'description'] as const;

/**
 * 参数摘要：**一句话**，不是参数的完整转储。
 * 优先取上面那几个「说明了在干什么」的字段；一个都取不到时退化成紧凑 JSON；
 * `arguments` 根本不是 JSON（截断 / 纯文本）时原样用。产物会进事件日志，故一律单行化 + 截断。
 */
function summarizeArguments(raw: string | null): string {
  if (raw === null) return '';
  const parsed = parseJsonRecord(raw);
  if (parsed === null) return clip(oneLine(raw));
  for (const key of PREFERRED_ARGUMENT_KEYS) {
    const value = readString(parsed, key);
    if (value !== null && value !== '') return clip(oneLine(value));
  }
  return clip(oneLine(safeStringify(parsed)));
}

/** 解析成对象；不是 JSON、或不是对象（数组 / 标量）时返回 null——「解析不了」与「是空的」要分得开 */
function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    // 厂商偶尔给的不是合法 JSON（被截断 / 本来就是纯文本）：当「解析不了」，由调用方原样用
    return null;
  }
}

/** 单行化：换行与连续空白压成一个空格（摘要要能塞进卡片底部那一行） */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 截断到上限（带省略号）：超长的参数与输出不进摘要字段（完整内容在原始负载里） */
function clip(text: string): string {
  return text.length <= DSH_SUMMARY_MAX_LENGTH ? text : `${text.slice(0, DSH_SUMMARY_MAX_LENGTH)}…`;
}

/**
 * 本行累计的计量（三项齐了才认；缺一项就是 null，不发明 0）。
 * 与旧 `takeTurnTokens` 的唯一区别是**不取走、不清零**：现在的口径是「到目前为止的累计」，
 * 事件本身也是覆盖语义（`row-live.ts` 直接覆盖），清零只会让跨 step 的相加变成特判。
 *
 * 两项可选格（2026-10-XX 新增，`reasoningTokens` / `totalTokens`）同样是**累计/覆盖**口径：
 * 每见到一条更完整的用量就跟着更新，采不到就是 `null`（**不填 0**）。
 * 为什么它们也放在 `state` 上：dsh 的用量是**逐 step 累加**出来的（见 `assistant/message` 那一支），
 * 另两格也必须跟着同一份累计走，否则会出现「input 是三条之和、reasoning 只有最后一条」这种
 * 自相矛盾的一行。`total` 只取**最后见到的那一个**（厂商自报的累计值本来就是全量，不该相加——
 * 相加会把总量算成好几倍）。
 */
function cumulativeTokens(state: TurnState): UsageTokens | null {
  const input = state.usageInput;
  const cached = state.usageCached;
  const output = state.usageOutput;
  if (input === null || cached === null || output === null) return null;
  return {
    input,
    cached,
    output,
    reasoningOutput: state.usageReasoningOutput ?? null,
    total: state.usageTotal ?? null,
  };
}

/**
 * 记一条会话事件的时间戳（epoch 毫秒）进本行的跨度（2026-10-XX 新增）。
 *
 * 落点是 `params.event.time`——**dsh 唯一的时间来源**（用量载荷 `data.usage` 里没有时间字段，
 * 实测）。合并规则完全复用骨架的 `mergeTiming`（起点只认第一条、终点每次覆盖、
 * 来源不一致则整格作废）：抄一份在这里必然漂移，而漂移的症状是「这一家的时长偶尔对不上」。
 *
 * 三条取舍：
 *   · **`time` 不是数字就整条跳过**（不落 WARN）：会话事件里没有时间的那几条是常态缺陷，
 *     为它们刷 WARN 会把真正要看的 WARN 淹掉；跨度缺端点时 `timing` 自然会缺，那是可见的；
 *   · **不认识的事件类型不记**（本函数只在 `turn/start` / `assistant/message` / `turn/end`
 *     三处调用）：取全过程首末会让跨度把与模型无关的杂事（标题生成、inbox 拼接）算进来；
 *   · `source: 'events'` 是**硬编码**的：dsh 报不出厂商时间，这一点没有第二种可能，
 *     写成参数只会给人「某天它可能变成 vendor」的错觉。
 */
function noteEventTime(state: TurnState, event: Record<string, unknown> | null): void {
  const time = readNumber(event, DSH_EVENT_TIME_FIELD);
  if (time === null) return;
  const span: TimingSpan = { firstMs: time, lastMs: time, apiMs: null, ttftMs: null, source: 'events' };
  state.timing = mergeTiming(state.timing, span);
}

/**
 * 从 `assistant/message` 的 `data.message.content[]` 里取可读答复：只认 `type === 'text'` 的非空块，
 * 多个块按顺序用换行拼接。形状不对时返回空串（调用方据此保持 `finalText` 不动，不写空串）。
 */
function readAssistantText(data: Record<string, unknown> | null): string {
  return readContentText(asRecord(data?.message)?.content);
}

/**
 * 从 `assistant/message` 的 `data.message.content[]` 里取**推理原文**：`type === 'reasoning'` 的非空块，
 * 按顺序用换行拼接；形状不对或没有推理时返回空串（调用方据此不落日志——空串不该落成噪声）。
 *
 * 为什么与 `readContentText` 分成两份而不是加参数：两处的**过滤条件相反**
 * （那边只要 `'text'`、这边只要 `'reasoning'`），而**共同点**是"绝不按 text 字段取值"。
 * 合成一个带 `kind` 参数的函数会让调用点看不出这个反面约束，正是那个坑的复发路径。
 *
 * 实测（2026-09-30 真机，dsh SDK 的原始会话事件）：三次模型往返的推理文本长度分别为
 * 259 / 68 / 143 字符，且**只有 `block-end` 带整块文本**——dsh **不发** `reasoning-delta`
 * （实测 `reasoning-delta: 0`），所以推理没有增量可推，只能整块取。
 */
function readAssistantReasoning(data: Record<string, unknown> | null): string {
  const content = asRecord(data?.message)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'reasoning' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * `content[]` 里的 `type === 'text'` 非空块，按顺序用换行拼接。
 * `assistant/message`（答复）与 `tool/result`（工具输出）的 content 形状实测一致，故共用这一份——
 * 两份各写一遍的话，`reasoning` 块**也带 text 字段**那条坑（见 `readAssistantText` 的上游注释）
 * 会在其中一份里被忘掉。
 */
function readContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * `childSessionId → { label, mode }` 的关联表：**唯一一份实现**在 `message.ts`
 * （真机 §6.5.1：任务名与 mode 只在 `subagent/catalog` 里，而 `subagent.started`/`finished`
 * 只带 sessionId）。这里只做读取，不再维护第二份镜像——两份必然漂移，而漂移的症状是
 * 「日志里有名字、子任务行里没有」。
 */
function catalogOf(identity: string | null): { label: string | null; mode: string | null } | null {
  return identity === null ? null : lookupDshSubagentCatalog(identity);
}

/**
 * dsh 的子智能体通知 → 一条**可解析**的日志（spec §6.5.2）。
 *
 * 三条实测决定的口径（§6.5.1）：
 *  1. **身份**取 `agentId`（真机与 `childSessionId` 同值）⇒ `subagentId`/`vendorId` 都是厂商原生值，
 *     **不需要合成**；
 *  2. **任务名/mode 来自 `subagent/catalog`**（另一条消息）⇒ 这里查关联表，查不到就写 `null`
 *     并标 `confidence: 'unknown'`，**绝不编**；
 *  3. **`status` 是另一套词汇**：真机成功路径是 `status: "ok"` + `stopReason: "completed"`。
 *     只映射**实测见过**的取值；其余原样透出 `vendorStatus`/`stopReason` 且 `status: null`
 *     + `statusMissing: 'unverified'`——**不假装映射成 `failed`**（那会把"没见过"写成"失败"）。
 */
function subagentDraft(notification: Record<string, unknown> | null): AgentEventDraft {
  const isStart = readString(notification, 'method') === DSH_SUBAGENT_STARTED_METHOD;
  const params = asRecord(notification?.params);
  const childSessionId = readString(params, 'childSessionId');
  const agentId = readString(params, 'agentId');
  // 身份优先取 agentId（finish 才有），start 时退回 childSessionId——两者真机同值
  const identity = firstNonEmpty(agentId, childSessionId);

  const catalog = catalogOf(identity);
  const name = catalog?.label ?? null;

  const payload: Record<string, unknown> = {
    kind: 'subagent',
    phase: isStart ? 'start' : 'end',
    /** `'wire'` = 厂商通知流（spec §6.1）。dsh 侧既不是 SDK hook，也不是聚合计数 */
    source: 'wire',
    subagentId: identity,
    vendorId: identity,
    name,
    parentSessionId: readString(params, 'parentSessionId'),
    /**
     * **关联置信度**：`'exact'` = 从 `subagent/catalog` 拿到了厂商给的任务名；
     * `'unknown'` = catalog 没到（名字缺失）。为什么要有这一格：dsh 的 name 与身份**分两条消息到**，
     * 下游若把 `name: null` 当成"这个子任务没有名字"就会误判——这一格让"没关联上"是**显式**的。
     */
    confidence: name === null ? 'unknown' : 'exact',
  };

  if (isStart) {
    payload.subagentKind = catalog?.mode ?? null;
    // dsh 的通知里**没有**归属键（真机：无 tool_use_id）⇒ parentToolUseId 恒 null。
    // 与 claude 的真实差异：那边三者同值可精确归属，这边只能靠 sessionId（§6.5.3）。
    payload.parentToolUseId = null;
  } else {
    payload.subagentKind = catalog?.mode ?? null;
    payload.provider = readString(params, 'provider');
    const vendorStatus = readString(params, 'status');
    const stopReason = readString(params, 'stopReason');
    payload.vendorStatus = vendorStatus;
    payload.stopReason = stopReason;
    const mapped = mapSubagentStatus(vendorStatus, stopReason);
    payload.status = mapped;
    payload.statusMissing = mapped === null ? 'unverified' : null;
    // 结果摘要取 `lastAssistantMessage` 里 `type === 'text'` 的块——**不取 reasoning**
    // （同 `readAssistantReasoning` 的反面：两处按块类型分流，绝不按 text 字段取值）
    payload.outcome = readLastAssistantText(params);
  }

  return logDraft('stdout', JSON.stringify(payload), subagentSummary(isStart, name, payload.status as string | null));
}

/**
 * dsh 的 `status`+`stopReason` → spec v3 §2.6 的 `status` 值域（**两格合读**，见 `message.ts` 的映射表）。
 * 未观测的组合返回 `null`（调用方写 `statusMissing: 'unverified'`）——**不猜**。
 * ⚠️ 这里与 `message.ts` 的 `mapDshSubagentStatus` 是**同一张表的两处投影**（日志载荷 / 契约形状）：
 * 改了取值口径必须同时改两处，否则「日志说失败、子任务行说未采集」。
 */
function mapSubagentStatus(vendorStatus: string | null, stopReason: string | null): string | null {
  if (stopReason === 'completed') return vendorStatus === 'ok' ? 'completed' : 'failed';
  if (stopReason === 'max-tokens') return 'failed';
  if (stopReason === 'aborted') return 'stopped';
  if (stopReason === 'error') return 'failed';
  return null;
}

/** `lastAssistantMessage` 里 `type === 'text'` 的非空块，按顺序拼接（不取 reasoning 块） */
function readLastAssistantText(params: Record<string, unknown> | null): string | null {
  const blocks = params?.lastAssistantMessage;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .map((block) => {
      const record = asRecord(block);
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter((entry) => entry !== '')
    .join('\n');
  return text === '' ? null : text;
}

/** 活动行的一句话：`已派发子任务：<任务名>` / `子任务已完成：<任务名>` */
function subagentSummary(isStart: boolean, name: string | null, status: string | null): string {
  const who = name === null || name === '' ? '子任务' : name;
  if (isStart) return `已派发子任务：${who}`;
  return `子任务${SUBAGENT_STATUS_LABELS[status ?? ''] ?? '结束'}：${who}`;
}

/** 终态的中文说法；表里没有的状态不猜（`mapSubagentStatus` 已经把未知值挡成 null） */
const SUBAGENT_STATUS_LABELS: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

/** 第一个非空字符串；都没有返回 null（**不编**） */
function firstNonEmpty(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== '') return value;
  }
  return null;
}

/**
 * 取 `turn/end` 的失败文案；成功返回 null。
 * 为什么两处都试：`reason.error` 实测既可能是对象（`{message, code}`）也可能是**纯字符串**
 * ——SDK 的 `TurnEndReasonMap.error` 声明是 `LlmFailure`，但 `errorChain(error)` 对普通 Error
 * 返回的是字符串，于是真实载荷与类型面不一致。只认对象会让这一类失败静默溜过。
 */
function readTurnFailure(data: Record<string, unknown> | null): string | null {
  const reason = asRecord(data?.reason);
  if (reason === null) return null;
  if (readString(reason, 'kind') !== 'error') return null;
  const error = reason.error;
  const text = readString(asRecord(error), 'message') ?? readString(reason, 'error');
  return text ?? safeStringify(error);
}

/**
 * 三项齐了才认；缺项时落一条 WARN 并保留原始负载——「没采到」与「0」必须能区分（§5.6.3）。
 * `cacheReadTokens` / `cacheWriteTokens` 在类型上是可选的 ⇒ 字段缺席按**未采到**处理（不填 0）。
 * 形状异常（`usage` 根本不是对象、整段缺失）与缺项**合流到同一条 WARN**（评审 N2 的口径）。
 *
 * **`input` 不做减法**（2026-10-XX 补注）：dsh 的 `TokenUsage` 三格**互斥**，本机恒等式判定逐字验过
 * （`{inputTokens:1219, cacheReadTokens:7040, cacheWriteTokens:0, outputTokens:1, totalTokens:8260}`，
 * `1219 + 7040 + 0 + 1 = 8260`）⇒ `inputTokens` 天生就是**非缓存输入**，与本仓契约同口径。
 * 这与 codex 正好相反（那边 `cached_input_tokens` 是 `input_tokens` 的**明细**，必须减）——
 * 两家读法的差别就是本仓「归一放在适配器里」那条口径存在的全部理由。
 *
 * 另两格（`reasoningTokens` / `totalTokens`）是**可选格**：读不到就是 `null`，**绝不填 0**
 * （`reasoningOutput: 0` 会让人得出「这家不做推理」，而事实是「这一格没有」）。
 */
function readTokens(usage: unknown, drafts: AgentEventDraft[]): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, DSH_USAGE_FIELDS.input);
  const cached = readNumber(record, DSH_USAGE_FIELDS.cached);
  const output = readNumber(record, DSH_USAGE_FIELDS.output);
  if (input === null || cached === null || output === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  return {
    input,
    cached,
    output,
    reasoningOutput: readNumber(record, DSH_USAGE_FIELDS.reasoning),
    total: readNumber(record, DSH_USAGE_FIELDS.total),
  };
}

/** 未识别的通知 / 事件：保留原始负载（§5.6.3 唯一允许丢弃的是重复事件） */
function unknown(raw: unknown): TurnProjection {
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}
