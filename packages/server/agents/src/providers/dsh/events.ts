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
 * **既成口径：用量与轮次都不按会话分叉**（spec
 * "docs/protocols/message-spec.md"「轮次归属」与行尺度一档）。
 * 子会话的 `assistant/message` 与 `step/start` 与主会话同形，而这一层**只认 `event.type`、
 * 不按 `sessionId` 分流**：`assistant/message` 那一支把三元组**无条件**累进本行的 `state.usage*`
 * （`sessionId` 只喂 `noteDshSessionUsage` 那张按会话分组的表），`step/start` 那一支把
 * `state.turns` **无条件** +1 ⇒ **dsh 的三格（tok / 缓存命中 / 轮次）从第一天起就含它派发的
 * 子智能体**，是**构造上如此**，不是投影漏了一层过滤。原文把这条行为记成「碰巧对」；
 * 2026-10-04 起它是**有意**的既成口径并由守卫钉住（spec §3 的 #4 / #5）：本行的读数问的就是
 * 「这个候选一共花了多少」，子会话干的活正是它干的活 ⇒ 要改成主 / 子两把尺子是另一次口径变更。
 * 本次唯一的新增是把**其中的分量**另外交出来（`subagentTokens`，按本行的子会话白名单求和），
 * 合计口径一个字未动——另两家（codex / claude）过去把子那一份留在子任务行上，本次才并进合计。
 *
 * 2026-10-05 补一句新口径（`docs/protocols/message-spec.md`）：
 * **合计**（`tokens` / `turns`，服务卡片与快照）仍**不分会话**——上面那一段一个字未动；而
 * **消息的轮次号与 `usage.turn`** 改按**各会话自己的 `step`** 走（两者是同一个数，
 * `message.ts` 的 `dshTurnAttribution` 是唯一实现）。两者不是一回事：合计答的是「这一行一共花了
 * 多少」，归属答的是「这条读数属于哪个会话的第几次模型往返」——同一个数在两边都成立才是错的。
 *
 * 2026-10-04 追加**轮次那一格的分量**（`subagentTurns`，见 v3 spec §3.4 的子任务级轮次）：同一份白名单、
 * 同一个事实缺失谓词（`dshSilentChildSessions`）——判据只有一份，收尾那条点名 WARN 与它同源。
 * 数据面是 `step/start` 那一支里**紧挨着** `state.turns += 1` 的按会话计数（`noteDshSessionTurn`）：
 * 两格由同一条事件驱动 ⇒ `subagentTurns ≤ turns` 是构造上的，不是事后校验的。
 *
 * 2026-09-29 追加三类投影（用户口径：卡片底部那一行动效要**实时滚动智能体的 event message**，
 * 不能只显示一句「正在思考…」，也不能是 JSON）：
 *  - `tool/call`：`params.event.data = { turn, step, callId, name, arguments }`，其中 `arguments` 是
 *    **JSON 字符串**（实测 `{"job_id": "pwsh-16", "timeout_ms": 420000, "wait": true}`）；
 *  - `tool/result`：`params.event.data.message = { role:'tool', toolCallId, content:[{type:'text',text}], isError }`；
 *  - `assistant/message` 的{文本}落成一条日志（过去只进 `finalText`，整轮不出现在任何地方）——
 *    评分阶段跑的是同一个适配器，它的消息因此同样会滚上去。
 *
 * **2026-10-07 收敛：活动行只播「正在做什么」**（用户裁定；词表与实现只有一份，在 `src/activity.ts`）。
 * 在此之前，本文件给「答复 / 推理 / 轮次 / 工具返回」**每一条都配了摘要**，于是卡片底部那一行会被
 * 最新一句占据——真机形态（run `08b56e95` 的 dsh 行与 claude 行）是**永久停在英文推理**上：
 * `思考：Only one file changed: index.html. Now evaluate each item…`，因为同一轮里推理行排在答复行**之后**。
 * 现在的分工：
 *  - **给摘要**：工具调用（`调用工具 <名>：<参数摘要>`）、工具**报错**、子任务派发/收场——都是「在做什么」；
 *  - **不给摘要**：工具**成功返回**、推理、轮次。三者的落点另有其处（结果块、思考块、原始输出面板），
 *    而**事件照旧逐字落盘**：拿掉摘要只是让活动行**保留上一句人话**，不是把证据丢掉
 *    （`activityOf` 对没有摘要、文本又是 JSON 的行本来就只推进游标）。
 *  - **答复文本仍然落一条日志**，且**不带摘要**：它本身就是人话，由 `activityOf` 直取 `text`——
 *    多配一份截断过的摘要等于同一句话有两个版本。
 *
 * 2026-10-04 追加**子智能体那一份**（spec §2.3）：`tokens` / `turns` **已经含**子会话（上面那条
 * 「投影不按会话分叉」的口径，本次不改）——新增的一格交出的是**其中的分量**，按 run 作用域的
 * **子会话白名单**求和（`childSessions` 是模块级的表，同一个进程里还跑着别的行 ⇒ 只有白名单能圈出
 * 这一行）。它随 `runState` 走：`projectDshNotification` 的第 4 个参数，**可选**（缺省 = 空集合，
 * 既有直调用例不必改）。
 */
import type { UsageTokens } from '@aieval/contracts';
import {
  subagentDispatchSummary,
  subagentSettledSummary,
  toolCallSummary,
  toolErrorSummary,
} from '../../activity';
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import { mergeTiming, type TimingSpan, type TurnProjection, type TurnState } from '../../turn';
import type { MessageDraft } from '../../message';
import {
  dshAssistantMessageDraft,
  dshSessionIdOf,
  dshStreamDeltaDraft,
  dshSubagentRecord,
  dshSubagentTurns,
  dshSubagentUsage,
  dshToolCallDraft,
  dshToolResultDraft,
  dshTurnAttribution,
  lookupDshSubagentCatalog,
  noteDshSessionTurn,
  noteDshSessionUsage,
  rememberDshSubagentCatalog,
} from './message';
import {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_SESSION_EVENT_METHOD,
  DSH_STEP_START_TYPE,
  DSH_STREAM_DELTA_TYPE,
  DSH_STREAM_FAILURE_TYPE,
  DSH_SUBAGENT_CATALOG_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  DSH_TOOL_CALL_TYPE,
  DSH_TOOL_RESULT_TYPE,
  DSH_TURN_END_TYPE,
  DSH_TURN_START_TYPE,
  // 读数规则与字段名只有 `protocol.ts` 一份（2026-10-06 起；见那边的文件头）
  readUsageTokens,
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
/**
 * 字段名表已搬到 `protocol.ts`（2026-10-06：`message.ts` 也要按同一份字段名读，
 * 留在本文件会与 `message.ts` 形成循环依赖）。这里 re-export 保持既有 import 路径不动
 * （`events.test.ts` 从 `./events` import 它）。
 */
export { DSH_USAGE_FIELDS } from './protocol';
/**
 * 会话事件的**时间字段名**：`params.event.time`（epoch 毫秒，每条会话事件都有）。
 * 为什么不用我们自己的 `AgentEvent.at`：那是 core 的事件写入器打的**我们这一侧**的时刻，
 * 与厂商事件发生的时刻不是一回事（差在网络与处理延迟上）。dsh 的时间只能从这一格取。
 */
export const DSH_EVENT_TIME_FIELD = 'time';

export function projectDshNotification(
  raw: unknown,
  state: TurnState,
  context: FailureContext,
  /**
   * 本行的子会话白名单与已收场集合（可选，缺省 = 空）。
   * 为什么走参数而不是塞进 `TurnState`：那是**骨架**的状态形状（三家共用），
   * 而这两个集合是 dsh 自己的取数面（spec 2026-10-04 §2.3）。
   */
  runState: { childSessions: ReadonlySet<string>; finishedSessions: ReadonlySet<string> } = {
    childSessions: new Set(),
    finishedSessions: new Set(),
  },
): TurnProjection {
  const notification = asRecord(raw);
  const method = readString(notification, 'method');
  // 子智能体的两条**顶层通知**（不是 session.event 包一层）——真机实测的通道，见 §6.5.1
  if (method === DSH_SUBAGENT_STARTED_METHOD || method === DSH_SUBAGENT_FINISHED_METHOD) {
    // 事件那条是给人看的摘要（含原始载荷），子任务行才是有类型的契约形状（spec v3 §2.6）
    const record = dshSubagentRecord(notification);
    return {
      drafts: [subagentDraft(notification)],
      tokens: null,
      /**
       * ⚠️ 这一支**不交**「子智能体那一份」（2026-10-04）：带分量的出口是**三条**——
       * `step/start` / `assistant/message` / `turn/end`（**三处都同时带两格**，见各自的注释），
       * 而这一支**两格都不带**。理由与 `turn/start` 那一类同源：`usage` 事件的发射门槛是**轮次**
       * （`turn.ts` 的发射点），而这一支按既有口径给 `turns: null`（子任务的派发/收场不是一次模型
       * 往返）⇒ 就算在这里算出结论也送不出去。收场那一刻的结论（收场了却没报到用量 ⇒ `null`）因此由
       * **下一条**带轮次的投影（`assistant/message` / `turn/end`）与收尾的 `finalize`
       * （`index.ts` 的 `TurnStart.finalize`，它在 `finally` 里跑）交出去——后者保证
       * **即使这一轮再也没有消息**，结果（进而行快照）里也是「没采到」，而不是上一版的旧数。
       */
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

  if (type === DSH_STREAM_DELTA_TYPE) {
    /**
     * stream-tap 的增量伪事件（见 `protocol.ts` 的命名与处置两条硬口径）：**只产内容消息、
     * 零事件草稿**。绝不能落进未识别的 `log` 兜底——一条增量一行 log 会把「原始输出」面板
     * 刷成几百条 JSON 流水（真要看的 stderr 反而被冲掉）。delta 的落点只有对话视图；
     * 编排层对 delta 只广播不落盘（2026-10-09 三家统一），事件侧彻底没有它的位置。
     */
    return {
      drafts: [],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshStreamDeltaDraft(notification, sessionId, roundOf(sessionId, data))),
    };
  }

  if (type === DSH_STREAM_FAILURE_TYPE) {
    /**
     * **通知流中断**伪事件（见 `protocol.ts`）：只产**一条** stderr 的 `log`——它存在的唯一理由
     * 就是让「执行日志为什么是空的」在界面上有答案（真机事故里那句话一个字都没有）。
     * 为什么不做成 `error` 事件的归因：那一格会把这行判成失败，而这一轮的产物（diff 与评分）
     * 是真实有效的——丢的是**过程证据**，不是结果。如实记一句、不改结论，是这里唯一诚实的处置。
     */
    const reason = readString(asRecord(data), 'reason') ?? '未知原因';
    const received = readNumber(asRecord(data), 'receivedNotifications');
    const receivedText = received === null ? '' : `（中断前已放行 ${received} 条通知）`;
    return {
      drafts: [logDraft('stderr', `[dsh] 通知流中断：${reason}${receivedText}；此后的事件与全部未采集，本次运行的执行日志因此不完整`)],
      tokens: null,
      turns: null,
      failure: null,
    };
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
       * 模型说的话**落一条日志**（用户口径 2026-09-29：活动行要滚动智能体实时的 event message
       * ——「评分的消息也在这里滚动展示」）。这一格过去只进 `finalText`，整轮都不出现在任何地方，
       * 于是卡片上只能看到工具 JSON。
       *
       * **不给摘要**（2026-10-07 统一）：它本身就是人话，`activityOf` 在没有摘要时会直接取 `text`；
       * 再配一份截断过的摘要等于同一句话在事件里存两份、两处口径可能漂移。筛不筛 JSON 同样只由
       * 消费方判（评分阶段模型吐的就是 JSON 评分结果）——判据只能有一份。
       */
      drafts.push(logDraft('stdout', reply));
    }
    /**
     * **推理原文单独落一条**（2026-09-30 真机更正；2026-10-07 改为只作证据）。
     *
     * 过滤掉 reasoning **是对的**（否则推理混进答复），但**只过滤不落盘就是把证据丢了**：
     * 真机实测 dsh 每次模型往返都带完整推理文本（三次往返 259 / 68 / 143 字符），
     * 而修复前这里一个字都不留。
     *
     * 落法改了：`text` 取**厂商原始信封**（与 `turn/start` 那一支同源），**不给摘要**。
     * 两个理由，缺一条都不成立：
     *   · 推理的**人话落点**是思考块（`message.ts` 的 `thinkingBlockDraft`，档位 `full`）——日志这一条是
     *     排障证据，不是第二个展示面；
     *   · 给它配摘要（旧文案 `思考：<推理>`）会让活动行**永久停在英文推理上**：同一轮里推理行排在
     *     答复行之后 ⇒ 最新一句恒是它（真机形态见文件头 2026-10-07 那段）。
     *
     * ⚠️ 被推翻的旧口径（留档）：本文件上游曾断言「dsh 的 reasoning `text` 实测恒为空串」——
     * 那是**探测中继把整条流转成单块、破坏 SSE 分块**造成的假象（2026-09-30 复现并定位）。
     */
    const reasoning = readAssistantReasoning(data);
    if (reasoning !== '') {
      drafts.push(logDraft('stdout', safeStringify(raw)));
    }
    // 本步的计量一到就交出去（轮次用**已经数到的**值）：界面上的 tok 因此在一个 step 内也会动，
    // 而不是等 `turn/end`。轮次还没有数到（形状异常：没有 step/start）时给 null——不发明一个 0。
    return {
      drafts,
      tokens: cumulativeTokens(state),
      // 子智能体那一份：**主会话之外**的读数（合计仍由 cumulativeTokens 给，两边同源同刻）
      subagentTokens: dshSubagentUsage(runState),
      // 轮次那一格的分量：与上面那一格同一份白名单、同一个事实缺失谓词（`message.ts`）
      subagentTurns: dshSubagentTurns(runState),
      timing: state.timing ?? undefined,
      // 归属：这一条读数属于哪个会话的第几次模型往返（与消息的 `roundTrip` 同源同值）
      turn: dshTurnAttribution(sessionId, data),
      turns: state.turns > 0 ? state.turns : null,
      failure: null,
      /**
       * 内容级消息（spec v3 §2）：同一个 `assistant/message` 的 `content[]` 是**完整快照**
       * ⇒ 一条消息带齐全部块（推理 + 正文），块序号按内容顺序分配。
       * 与上面的日志**并行**：事件是行级审计与活动行，消息是对话视图与工具族统计的载体。
       */
      messages: optionalMessage(dshAssistantMessageDraft(notification, sessionId, roundOf(sessionId, data))),
    };
  }

  if (type === DSH_STEP_START_TYPE) {
    // 一次模型 API 往返已经开始：这是本轮轮次的**唯一**计数点（见文件头）
    state.turns += 1;
    /**
     * 同一刻按会话记一笔：**轮次那一格的分量**（子智能体跑了几个往返）只能这样拿到——
     * `state.turns` 是全树累加，减不出某一家。两行必须在**同一个分支**上，
     * 否则会出现分量 > 合计（`subagentTurns ≤ turns` 是硬口径）。
     */
    noteDshSessionTurn(sessionId);
    return {
      drafts: [],
      tokens: cumulativeTokens(state),
      // 归属：`noteDshSessionTurn` 刚跑过，`data.step` 在真机上一定在（缺了也会退回该会话的上一个 step）
      turn: dshTurnAttribution(sessionId, data),
      turns: state.turns,
      /**
       * ⚠️ **两格分量都在这一支交**（2026-10-04 复核 M1 的收口；此前只交轮次那一格）。
       *
       * 合计那一格在这里刚刚 +1，两格分量若不跟上，界面上那两行会**短暂地算错**
       * （主会话 = 合计 − 旧分量 ⇒ 主会话多 1、子智能体少 1，而这是能画出来的一行假拆分）。
       * 而只交其中一格还会多出一种更难看的形状：**子 A 报过用量 → 子 B 收场却一条都没报 →
       * 主会话开下一步**，此时 `dshSilentChildSessions` 已经为真（两格分量同时该是 `null`），
       * 只交轮次那一格就会让事件上摆着「上一版的非零用量分量 + `null` 的轮次分量」——
       * 两格各自与自己的上一版自洽，摆在一起却是两句互相矛盾的话（界面会画出「子智能体 1 轮 /
       * 子智能体 0 token」）。
       *
       * 代价照实登记：这一支多一次 `dshSubagentUsage`（两次遍历白名单 + 每个子会话一次 Map 查找，
       * O(子会话数)，通常 1–3）。它**不在任何定时器路径上**（dsh 没有 codex 那种 500ms 读盘刷新，
       * 见 `CONTENT_READ_MIN_INTERVAL_MS` 的用处），只在每个 `step/start` 上跑一次。⚠️ 间隔按真机
       * 量级写（2026-10-04 复核 Minor 改正，原文写「分钟级」**偏大**）：本机产物
       * `runs/8e13e7a3…/rows/08c61bc6…` 那一行 34 个 `step/start` / `durationMs 47821`
       * ⇒ 平均 **≈1.4 秒**一次（子会话多、并发的行更密）。代价的结论不变（两次白名单遍历远低于
       * 一次读盘），但量级要写对——数字写大一个数量级，下次就不会有人真去量它了。
       */
      subagentTokens: dshSubagentUsage(runState),
      subagentTurns: dshSubagentTurns(runState),
      failure: null,
    };
  }

  if (type === DSH_TURN_START_TYPE) {
    /**
     * 轮次边界：只**补一条原始负载**，不给摘要（2026-10-07 统一）。
     * 从前这里写「第 N 轮开始」——它是纯播报，会把活动行从「在做什么」挤成「跑到第几轮」；
     * 轮次的落点是卡片上的「轮次」那一格，不是这一行。时间照旧在这里记一笔（见下）。
     */
    noteEventTime(state, eventRecord);
    return {
      drafts: [logDraft('stdout', safeStringify(raw))],
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
    /**
     * **分量也按同一条口径再交一次**（2026-10-04 评审 Important 1 的可选那一半）：这一支的既有语义
     * 就是「把最新的一份带上」（tokens / timing / turns 都这样），分量不能例外——否则它是唯一可能
     * 停在旧值的格子：「子会话刚收场却没报到用量」这条结论是在**不带轮次**的通知上成立的，
     * 若这一轮之后再没有 `assistant/message`，界面就会一直显示上一版那个偏小的数。
     * 两格**一起**交（`dshSilentChildSessions` 是同一个判据）：见 `step/start` 那一支的注记。
     */
    const subagentTokens = dshSubagentUsage(runState);
    const subagentTurns = dshSubagentTurns(runState);
    const failureText = readTurnFailure(data);
    /**
     * 归属：`turn/end` 的载荷里**没有 `step`**（实测只有收尾信息）⇒ `dshTurnAttribution` 退回
     * **该会话最后一个 step**；一次 step 都没见过的会话给 `null`（**不拿本行累计号顶替**）。
     * 成功与失败两个分支都要带这一格——失败那一支也是一次真实的读数，漏了它就会按时刻乱归位。
     */
    if (failureText === null) {
      return {
        drafts,
        tokens,
        subagentTokens,
        subagentTurns,
        timing,
        turn: dshTurnAttribution(sessionId, data),
        turns: state.turns > 0 ? state.turns : null,
        failure: null,
      };
    }
    // 失败进该行的事件日志（骨架的 error 出口还会再发一条带 stack 的，两条都留：这条保留厂商原文）
    drafts.push({ type: 'error', message: failureText });
    return {
      drafts,
      tokens,
      subagentTokens,
      subagentTurns,
      timing,
      turn: dshTurnAttribution(sessionId, data),
      turns: state.turns > 0 ? state.turns : null,
      failure: classifyAgentMessage(failureText, context),
    };
  }

  // 工具调用：**不是**「未识别」，但也不产生计量与轮次——事件那条为它补一句人话摘要
  // （见文件头），消息那条是内容级记录（工具族统计与对话视图读的就是它）。
  // `text` 还是那条原始 JSON：抽屉照旧逐字显示证据，卡片上的活动行显示的是 summary。
  if (type === DSH_TOOL_CALL_TYPE) {
    return {
      drafts: [logDraft('stdout', safeStringify(raw), toolCallSummary(readString(data, 'name'), readString(data, 'arguments')))],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshToolCallDraft(notification, sessionId, roundOf(sessionId, data))),
    };
  }
  if (type === DSH_TOOL_RESULT_TYPE) {
    /**
     * 工具结果：**只有报错才给摘要**（2026-10-07 统一）。
     * 成功返回那句「工具返回：<内容>」会把活动行变成流水账——实测最新一句常常停在
     * `工具返回：<path>D:\.tmp\aieval\runs\…`；结果的落点是结果块与抽屉的原始输出面板。
     * 报错必须播：那是「这一行出事了」，而它没有别的行级出口。
     */
    const error = asRecord(data?.message)?.isError === true;
    return {
      drafts: [logDraft('stdout', safeStringify(raw), error ? toolErrorSummary(readContentText(asRecord(data?.message)?.content)) : undefined)],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshToolResultDraft(notification, sessionId, roundOf(sessionId, data))),
    };
  }

  return unknown(raw);
}

/**
 * 这条消息属于**哪个会话的第几次模型往返**（spec 2026-10-05 §2.3）。
 * 与 `usage.turn` 同源：`dshTurnAttribution` 是唯一实现（消息这一格是必填正整数，故 `null` 时给 1——
 * 真机每一次往返都带 `step`，这条路径不可达）。
 */
function roundOf(sessionId: string | null, data: Record<string, unknown> | null): number {
  return dshTurnAttribution(sessionId, data)?.round ?? 1;
}

/** 归一草稿可能为 `null`（形状不满足那条消息的最小要求时宁可不发，也不发一条空壳） */
function optionalMessage(draft: MessageDraft | null): MessageDraft[] {
  return draft === null ? [] : [draft];
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

  return logDraft(
    'stdout',
    JSON.stringify(payload),
    isStart
      ? subagentDispatchSummary(name)
      // `payload.status` 是 `Record<string, unknown>` 里的一格：只在它确实是字符串时才算映射后的档位
      : subagentSettledSummary(name, mappedStatusOf(typeof payload.status === 'string' ? payload.status : null)),
  );
}

/**
 * 收场档位取**映射后的契约五态**（`completed` / `failed` / `stopped`），其余一律 `null`：
 * 词表只认这三档，认不出就说「已结束」——厂商那串原始状态（`ok` / `max-tokens` / …）照旧在日志的
 * `text` 里逐字可查，不往那句中文里塞英文（旧实现是 `?? status` 原样透出）。
 */
function mappedStatusOf(status: string | null): string | null {
  return status === 'completed' || status === 'failed' || status === 'stopped' ? status : null;
}

/**
 * dsh 的 `status` + `stopReason` → spec v3 的 `status` 值域：**以 `stopReason` 分档**，
 * `status` **只在 `stopReason === 'completed'` 那一支**参与（不是一张笛卡尔表）。
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
  const tokens = readUsageTokens(usage);
  if (tokens === null) {
    // 落 WARN 留在这一层（消息归一那一层没有 drafts 收集器）；读数规则与字段名只有 `protocol.ts` 一份
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
  }
  return tokens;
}

/** 未识别的通知 / 事件：保留原始负载（§5.6.3 唯一允许丢弃的是重复事件） */
function unknown(raw: unknown): TurnProjection {
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}
