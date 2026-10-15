/**
 * dsh 的通知投影：按真实探测到的厂商事件形态投影。
 * 口径（真机逐条核过；探针产物在 `probe/dumps/v3/` 与 `probe/dumps/v11/`）：
 *  - 通知外形是 `{ method, params }`，method 只有四种；**事件全在 `session.event` 里**，
 *    真正的判别字段是 `params.event.type`（`agent/inbox/spliced`、`turn/start`、`step/start`、
 *    `system/message`、`user/message`、`request/header`、`request/context`、`session/title`、
 *    `session-log-…`、`assistant/message`、`step/end`、`turn/end`）；
 *  - **用量在两处**：正常收尾的那次尝试在 `assistant/message` 的 `params.event.data.usage = { inputTokens,
 *    outputTokens, cacheReadTokens?, cacheWriteTokens?, totalTokens? }`（`TokenUsage` 的计数**互斥**：
 *    `inputTokens` 只算未命中缓存的输入，缓存读单独在 `cacheReadTokens` ⇒ 映射到本仓三元组不会双计）；
 *    而**没有落成 `assistant/message` 的那次尝试**（`assistant/attempt`）把用量放在
 *    `data.stream[]` 的最后一条 `{type:'chunk',chunk:{type:'usage'}}` 上——两支都要累计，
 *    漏掉后者就是静默少算（厂商自己的 token meter 两支都算）；
 *  - **轮次结束是 `turn/end`**：`params.event.data = { turn, reason: { kind } }`，`kind` 取值实测
 *    `completed` / `error` / `aborted`（子会话收尾 `{kind:'aborted', reason:{kind:'parent'}}`；
 *    类型面另有 `blocked` / `max-tokens` / `interrupted` / `forked`）；
 *  - **一个 step = 厂商的一次模型调用**（不是「一次 HTTP 往返」）：事件序列是
 *    `turn/start` → `step/start` → `request/header` → `request/context` → `assistant/message`
 *    → `step/end`（→ 下一个 `step/start` …）→ `turn/end`，`assistant/message` 上带着 `{turn, step}`。
 *    所以**轮次从 `step/start` 数**：它是「这一次请求已经发出去了」的落点，而不是等整段任务收尾。
 *    实测那一轮（`ae798e52` 的 dsh 行）`step/start` = 59、`assistant/message` = 59，而 `turn/end` 只有
 *    **1** 条 —— 原来按 `turn/end` 数，界面上永远是「轮次 1」。
 *    ⚠️ 重试不新开 step：一次尝试失败后 `llm/retry-started` 把**同一个 step** 重新打开，
 *    于是 4 次真实往返可以只有 3 个 step（本仓口径与厂商 `turn-usage.js` 一致）。
 *  - **失败通道就是 `turn/end` 的 `reason.kind === 'error'`**：`reason.error` 实测有两种形状——
 *    结构化 `{ message, code:"TRANSPORT" }`（传输失败）与**纯字符串** `"…"`（SDK 把非结构化异常
 *    折成 `{ message: errorChain(error), code: 'UNKNOWN' }`，而 `errorChain` 对普通 Error 返回 string）。
 *    两种都要认，否则一次失败的运行会被投影成普通日志、骨架返回 `ok: true, completed`
 *    （「界面显示成功、实际没干活」）。
 * 其余口径不变：未识别一律 `unknownEventDraft(payload)` 保留原始负载；用量读数只有
 * `protocol.ts` 的 `readUsageTokens` 一份实现——`inputTokens` / `outputTokens` 两格必在
 * （读不到才整条按未采到处置），缓存读 / 缓存写两格「大于 0 才写」⇒ 缺席就是 **0**
 * （见该函数的 JSDoc 与 `readTokens`）。
 * **时长**：dsh 的用量载荷里**没有任何时间字段**，时间只在会话事件自己身上
 * （`params.event.time`，epoch 毫秒，每条事件都有）⇒ 本行的 `timing` 一律 `source: 'events'`
 * （含工具执行的墙钟），起止取**识别到的那几条事件**的首末 `time`（见 `noteEventTime`）。
 * ⚠️ **它不含第一次模型往返**（`request/header` → 首条 `assistant/message`，量级 1.6~2.5 s）
 * 与冷启动 / 收尾（`run()` 的墙钟比它多 0.7 s 上下）：短一轮的运行里那一跳占比可达三成，
 * 拿 `totalMs` 算 tok/s 会偏高。这是**现时约束**——端点是「我们识别到的会话事件」，
 * 不是进程生命周期（`durationMs` 才是墙钟）。
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
 * `state.turns` **无条件** +1 ⇒ **dsh 的三格（tok / 缓存命中 / 轮次）含它派发的
 * 子智能体**，是**构造上如此**，不是投影漏了一层过滤。它是**有意**的既成口径并由守卫钉住
 * 本行的读数问的就是「这个候选一共花了多少」，子会话干的活正是它干的活
 * ⇒ 换成主 / 子两把尺子等于换一套口径。
 * 分量另外交出来（`subagentTokens`，按本行的子会话白名单求和），合计口径不受影响。
 *
 * 另一条口径（`docs/protocols/message-spec.md`）：
 * **合计**（`tokens` / `turns`，服务卡片与快照）仍**不分会话**——与上面那一段同一口径；而
 * **消息的轮次号与 `usage.turn`** 改按**各会话自己的 `step`** 走（两者是同一个数，
 * `message.ts` 的 `dshTurnAttribution` 是唯一实现）。两者不是一回事：合计答的是「这一行一共花了
 * 多少」，归属答的是「这条读数属于哪个会话的第几次模型往返」——同一个数在两边都成立才是错的。
 *
 * **轮次那一格的分量**（`subagentTurns`，子任务级轮次）：同一份白名单、
 * 同一个事实缺失谓词（`dshSilentChildSessions`）——判据只有一份，收尾那条点名 WARN 与它同源。
 * 数据面是 `step/start` 那一支里**紧挨着** `state.turns += 1` 的按会话计数（`noteDshSessionTurn`）：
 * 两格由同一条事件驱动 ⇒ `subagentTurns ≤ turns` 是构造上的，不是事后校验的。
 *
 * 三类投影（用户口径：卡片底部那一行动效要**实时滚动智能体的 event message**，
 * 不能只显示一句「正在思考…」，也不能是 JSON）：
 *  - `tool/call`：`params.event.data = { turn, step, callId, name, arguments }`，其中 `arguments` 是
 *    **JSON 字符串**（实测 `{"job_id": "pwsh-16", "timeout_ms": 420000, "wait": true}`）；
 *  - `tool/result`：`params.event.data.message = { role:'tool', toolCallId, content:[{type:'text',text}], isError }`；
 *  - `assistant/message` 的{文本}落成一条日志（过去只进 `finalText`，整轮不出现在任何地方）——
 *    评分阶段跑的是同一个适配器，它的消息因此同样会滚上去。
 *
 * **活动行只播「正在做什么」**（用户裁定；词表与实现只有一份，在 `src/activity.ts`）：
 * 给「答复 / 推理 / 轮次 / 工具返回」**每一条都配摘要**会让卡片底部那一行被最新一句占据——
 * 真机形态（run `08b56e95` 的 dsh 行与 claude 行）是**永久停在英文推理**上：
 * `思考：Only one file changed: index.html. Now evaluate each item…`，因为同一轮里推理行排在答复行**之后**。
 * 现在的分工：
 *  - **给摘要**：工具调用（`调用工具 <名>：<参数摘要>`）、工具**报错**、子任务派发/收场——都是「在做什么」；
 *  - **不给摘要**：工具**成功返回**、推理、轮次。三者的落点另有其处（结果块、思考块、原始输出面板），
 *    而**事件照旧逐字落盘**：拿掉摘要只是让活动行**保留上一句人话**，不是把证据丢掉
 *    （`activityOf` 对没有摘要、文本又是 JSON 的行本来就只推进游标）。
 *  - **答复文本仍然落一条日志**，且**不带摘要**：它本身就是人话，由 `activityOf` 直取 `text`——
 *    多配一份截断过的摘要等于同一句话有两个版本。
 *
 * **子智能体那一份**：`tokens` / `turns` **已经含**子会话（与上面那条
 * 「投影不按会话分叉」的口径一致）——这一格交出的是**其中的分量**，按 run 作用域的
 * **子会话白名单**求和（`childSessions` 是模块级的表，同一个进程里还跑着别的行 ⇒ 只有白名单能圈出
 * 这一行）。它随 `runState` 走：`projectDshNotification` 的第 4 个参数，**可选**（缺省 = 空集合，
 * 既有直调用例不必改）。
 */
import { namedVendorSkill, type SubagentRecord, type UsageTokens, type VendorSkill } from '@aieval/contracts';
import {
  subagentDispatchSummary,
  subagentSettledSummary,
  toolCallSummary,
  toolErrorSummary,
} from '../../activity';
import { logDraft, safeStringify, unknownEventDraft, vendorSystemDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import { mergeTiming, type TimingSpan, type TurnProjection, type TurnState } from '../../turn';
import type { MessageDraft } from '../../message';
import {
  dshAssistantMessageDraft,
  dshSessionIdOf,
  dshStreamDeltaDraft,
  dshSessionPermissionOf,
  noteDshSessionPermission,
  dshSubagentIdOf,
  dshSubagentIdentity,
  dshSubagentRecord,
  dshSubagentStartRecord,
  dshSubagentTurns,
  dshSubagentUsage,
  dshToolCallDraft,
  dshToolResultDraft,
  dshTurnAttribution,
  lookupDshSubagentCatalog,
  noteDshSessionTurn,
  noteDshSessionUsage,
  parseDshToolArguments,
  rememberDshSubagentCatalog,
} from './message';
import {
  DSH_ASSISTANT_ATTEMPT_TYPE,
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_JOB_SETTLED_TYPE,
  DSH_LLM_RETRY_TYPE,
  DSH_QUIET_EVENT_TYPES,
  DSH_REQUEST_HEADER_TYPE,
  DSH_PERMISSION_PRESET_TYPE,
  DSH_SESSION_EVENT_METHOD,
  DSH_SESSION_STATUS_METHOD,
  DSH_SESSION_TITLE_TYPE,
  DSH_SKILL_CATALOG_KIND,
  DSH_STEP_START_TYPE,
  DSH_STREAM_DELTA_TYPE,
  DSH_STREAM_FAILURE_TYPE,
  DSH_SUBAGENT_CATALOG_TYPE,
  DSH_SUBAGENT_DESCRIPTOR_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_SUBAGENT_STARTED_METHOD,
  DSH_SUBAGENT_TOOL_NAMES,
  DSH_TOOL_CALL_TYPE,
  DSH_TOOL_RESULT_TYPE,
  DSH_TURN_END_TYPE,
  DSH_USER_MESSAGE_TYPE,
  // 读数规则与字段名只有 `protocol.ts` 一份（见那边的文件头）
  readAttemptUsage,
  readHeaderTools,
  readSkillCatalog,
  readUsageTokens,
} from './protocol';

export {
  DSH_ASSISTANT_MESSAGE_TYPE,
  DSH_REQUEST_HEADER_TYPE,
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
 * 字段名表住在 `protocol.ts`（`message.ts` 也要按同一份字段名读，
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

/**
 * 投影的**取数面**（本行自己的状态，不塞进骨架的 `TurnState`）。
 *
 * 七格分三类：子会话白名单 / 已收场集合（归属与计量）、两条「只在变了时才发」的清单缓存、
 * 以及**派发记账**三格——厂商的 `subagent.*` 通知里没有派发调用 id、任务名又从另一条消息到，
 * 于是「这次派发在飞」「认领给了谁」「投过哪一条运行行」必须跨消息记住，
 * 否则子任务运行行落不进界面的任何一轮（见 `noteDshDispatchStart` / `claimDshDispatch`）。
 */
export interface DshProjectionRunState {
  childSessions: ReadonlySet<string>;
  finishedSessions: ReadonlySet<string>;
  /** 上一条 `request/header` 的工具表（见 `request/header` 那一支：只在**变了**的时候发事件） */
  headerTools?: string[] | null;
  /** 上一条技能目录（同上：只在**变了**的时候发事件。两条通道各自发出时都要带上对方那一格） */
  skillCatalog?: string[] | null;
  /**
   * 本 run 的**子会话分量基线**：登记某个子会话时它已经有的累计用量 / 往返数。
   * 分量 = 当前累计 − 基线（`message.ts` 的 `dshSubagentUsage` / `dshSubagentTurns`）——
   * `sessionUsage` 与往返计数都是**模块级、跨 run 不清**的，少了基线，追问/续接的第二个 run
   * 会把前一个 run 一起算进「子智能体那一份」（合计不受影响，于是行快照上会出现「合计 60 / 子分量 2010」）。
   * 基线在 `index.ts` 的 `noteChildSession` 里**首次登记**时记下（同一个 id 只记一次）。
   */
  childUsageBaseline?: Map<string, UsageTokens>;
  childTurnsBaseline?: Map<string, number>;
  /**
   * 释放前那次 `session/wait` **没能确认整棵子树收场**（到点 / 失败 / 终止），而白名单里还有
   * 子会话没收场 ⇒ 它们马上会被 `runtime.close()` 掐死，**「还在跑、以后会报」是假话**：
   * 分量必须按「事实缺失」交 `null` 并点名，不能按 0 计入（真机形状：被杀的子任务交
   * `subagentTokens {0,0,0}` + `subagentTurns 1`，而它永远不会再报）。
   */
  subagentsUnsettled?: boolean;
  /**
   * 工具作业的**失败判据**（`job/settled` 的 `data.detail`，键是 `data.toolCall.callId`）。
   *
   * 两种收场（厂商 `dsh-tool-bash` 的 `processOutcome`）：`exit code: N`（`status: completed`，
   * 失败当且仅当 N ≠ 0）与 `signal: <SIG>` / `killed before exit`（`status: killed` ⇒ 一律失败）。
   * 工具结果投影时按 `message.toolCallId` 取它判 `isError`（真机顺序保证它在结果之前到）；
   * 取不到就是 `null`（不猜、也不退回按文本解析）。
   */
  jobFailures?: Map<string, boolean>;
  /**
   * 已经投影过的工具结果草稿（按 `callId`）：`job/settled` **晚于** `tool/result` 到达时
   * （真机：被 `job_kill` / 超时杀掉的命令就是这个顺序），用它把同一条结果**重投**一次并带上
   * `isError`。合并按消息身份走（`vendorId` / 块的 `callId`）⇒ 重投是同一条覆盖，不是新增一条。
   */
  projectedToolResults?: Map<string, unknown>;
  /**
   * 本次运行**要求**的权限档（`DSH_PERMISSION_OPTIONS[input.permission]` 的字符串，如
   * `danger-full-access` / `read-only`）。用来与厂商实际报的 `permission/preset` 对照——
   * 厂商把权限档当**会话属性**，续接段既不重投也不改（见 FAQ 的对应条目）。
   */
  permissionDesired?: string | null;
  /**
   * 厂商报的权限预设（`permission/preset.preset`）——真机**每会话一条**（会话起手 seq 0），
   * 追问 / 续接段不重投（厂商把它当会话属性）⇒ 本段拿不到时用会话级记忆兜底，见 `dshSessionPermissionOf`。
   * 它是 `vendor-system.permissionMode` 的唯一来源——两条 `vendor-system` 出口都从这一格取，
   * 于是「工具表变了」与「技能目录变了」哪一条最后发出，那一格都带着同一个值。
   * `null` = 还没采到（不发明一个档位）。
   */
  permissionPreset?: string | null;
  /** 在飞的 `subagent` 派发（`callId` → 入参里的任务描述与认领者）——目录项到时按它认领派发点 */
  dispatchStarts?: Map<string, DshDispatchStart>;
  /** 已认领出来的派发点（`子任务身份` → `callId`）：同一身份的**每一条**投递都要带上同一格 */
  claimedDispatches?: Map<string, string>;
  /** 已投递过的运行行内容签名（`子任务身份` → 签名）：目录项晚到时靠它判「要不要再投一条」 */
  deliveredStarts?: Map<string, string>;
}

export function projectDshNotification(
  raw: unknown,
  state: TurnState,
  context: FailureContext,
  /**
   * 本行的子会话白名单与已收场集合（可选，缺省 = 空）。
   * 为什么走参数而不是塞进 `TurnState`：那是**骨架**的状态形状（三家共用），
    * 而这两个集合是 dsh 自己的取数面。
   */
  runState: DshProjectionRunState = {
    childSessions: new Set(),
    finishedSessions: new Set(),
  },
): TurnProjection {
  const notification = asRecord(raw);
  const method = readString(notification, 'method');
  // 子智能体的两条**顶层通知**（不是 session.event 包一层）——实测的通道
  if (method === DSH_SUBAGENT_STARTED_METHOD || method === DSH_SUBAGENT_FINISHED_METHOD) {
    // 事件那条是给人看的摘要（含原始载荷），子任务行才是有类型的契约形状
    const identity = dshSubagentIdentity(notification);
    const claim = claimDshDispatch(runState, identity);
    const record = dshSubagentRecord(notification, claim);
    if (record !== null && method === DSH_SUBAGENT_STARTED_METHOD) {
      /**
       * 记住这条运行行的内容：**目录项（任务名）晚到**时还要按同一身份再投一条更完整的
       * （见 `catalog` 那一支）。不记的话「投过没有」无从判断，就会在每条目录项上重发。
       */
      runState.deliveredStarts?.set(record.subagentId, JSON.stringify(record));
    }
    return {
      drafts: [subagentDraft(notification, claim)],
      tokens: null,
      /**
        * ⚠️ 这一支**不交**「子智能体那一份」：带分量的出口是**三条**——
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
  /**
   * `session.status`：**已识别且有意不投影**（真机每行两条：`running` / `idle`）⇒ 零草稿。
   * 放在这里而不是走下面的兜底，是因为兜底的语义是「不认识的载荷」——把这两条混进去，
   * 原始输出面板就多两条与内容、失败都无关的 JSON。
   */
  if (method === DSH_SESSION_STATUS_METHOD) {
    return { drafts: [], tokens: null, turns: null, failure: null };
  }
  // 只认一种通知外形：`{ method, params }`。其余（含未来新增方法）保留原始负载
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
   * **已识别但无用的那批**（真机每行必现，见 `DSH_QUIET_EVENT_TYPES`）：零草稿。
   * 它们既不带轮次也不带用量或失败；继续走 `unknown` 兜底会把原始输出面板刷成 JSON 流水，
   * 而「未识别的厂商载荷」那一栏也就失去了诊断价值（真正未知的类型混在几十条噪声里）。
   * ⚠️ 顺序：`subagent/descriptor` 在这批里，而它的信封身份已经在**过滤器**里登记过
   * （`noteChildSession`），投影这一层确实什么都不用做。
   */
  if (type !== null && (DSH_QUIET_EVENT_TYPES.has(type) || type === DSH_SUBAGENT_DESCRIPTOR_TYPE)) {
    return { drafts: [], tokens: null, turns: null, failure: null };
  }

  /**
   * 权限预设：**只登记、不产草稿**。厂商在会话起手投一条（seq 0），
   * 它是本行 `vendor-system.permissionMode` 的唯一来源（见 `DshProjectionRunState.permissionPreset`）——
   * 不登记的表现是环境抽屉上「权限档」恒为空，连评分阶段被限成 `read-only` 都看不出来。
   * 事件本身由随后的 `vendor-system` 出口带出去（工具表在每个运行里至少变一次 ⇒ 必然发一条）。
   */
  if (type === DSH_PERMISSION_PRESET_TYPE) {
    const drafts: AgentEventDraft[] = [];
    /**
     * **本次要的档 ≠ 厂商这一会话的档** ⇒ 落一条 WARN：厂商的档是**会话属性**，本段改不了它
     * （真机：`read-only` + 续接照样写得进文件，而新会话同一动作被拒）。只观测、不改写结论——
     * 「这一行的环境抽屉显示哪一档」与「实际生效哪一档」必须是同一句话，冲突时留痕。
     */
    const presetValue = readString(data, 'preset');
    const desired = runState.permissionDesired ?? null;
    if (presetValue !== null && desired !== null && presetValue !== desired) {
      drafts.push(
        logDraft(
          'stderr',
          `[WARN] 本次运行要求权限档 ${desired}，但厂商这一会话的档位是 ${presetValue}`
            + '（厂商把它当会话属性：续接 / 追问都不会改）——本段实际按厂商那一档跑',
        ),
      );
    }
    if (presetValue !== null && presetValue !== '') {
      runState.permissionPreset = presetValue;
      // 会话级也记一份：追问 / 续接段厂商不重投，那一段的 `vendor-system` 靠它才不交 null
      noteDshSessionPermission(sessionId, presetValue);
    }
    return { drafts, tokens: null, turns: null, failure: null };
  }

  /**
   * `session/title`：厂商给会话起的标题（真机 `data.title`，`source.kind === 'fallback'`）。
   * 它与上面那批的区别是**有信息量**（一条人话，排障时一眼看出这一轮在干什么）
   * ⇒ 落一条日志；写成品名而不是原始 JSON。
   */
  if (type === DSH_SESSION_TITLE_TYPE) {
    const title = readString(data, 'title');
    return {
      drafts: title === null ? [] : [logDraft('stdout', title)],
      tokens: null,
      turns: null,
      failure: null,
    };
  }

  /**
   * 子任务目录项：**补名 + 补派发点**——只在**这一条**里到达的 `label`（任务名）与 `mode`（类型）
   * 是派发行能否落进某一轮的判据：`subagent.started` 早于目录项到达时，那条运行行既没有名字、
   * 也没有派发调用 id ⇒ 界面上它落不进任何一轮（没有卡片、也没有「进入」入口），整段运行期
   * 这个子任务都不可达。所以：**投过运行行、而这次目录项让它变完整了 ⇒ 再投一条**
   * （同一身份覆盖累积，界面只留最后一条）。
   *
   * 为什么自己不产出 `log`：它是**身份补充**，不是进度——落成日志只会给抽屉添噪声。
   */
  if (type === DSH_SUBAGENT_CATALOG_TYPE) {
    rememberDshSubagentCatalog(data);
    const childId = readString(data, 'childId');
    return {
      drafts: [],
      tokens: null,
      turns: null,
      failure: null,
      subagents: childId === null ? [] : redeliverStartedSubagent(runState, childId),
    };
  }

  if (type === DSH_STREAM_DELTA_TYPE) {
    /**
     * stream-tap 的增量伪事件（见 `protocol.ts` 的命名与处置两条硬口径）：**只产内容消息、
     * 零事件草稿**。绝不能落进未识别的 `log` 兜底——一条增量一行 log 会把「原始输出」面板
     * 刷成几百条 JSON 流水（真要看的 stderr 反而被冲掉）。delta 的落点只有对话视图；
       * 编排层对 delta 只广播不落盘（三家统一），事件侧彻底没有它的位置。
     */
    return {
      drafts: [],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshStreamDeltaDraft(notification, sessionId, roundOf(sessionId, data))),
    };
  }

  if (type === DSH_STREAM_FAILURE_TYPE) {    /**
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
     * 子会话的用量按 `sessionId` 分组求和（`subagent.started` / `finished`
     * **不带用量** ⇒ 子任务级用量只能这样拿）。这一个调用对主会话也有记录，
     * 而 `dshSubagentRecord` 只按**子任务身份**取值 ⇒ 主会话那一条永远不会被读到。
     */
    noteDshSessionUsage(sessionId, asRecord(data)?.usage);
    /**
     * ⚠️ **`usage` 键缺席是厂商允许的形状**（真机：被 `interrupt_agent` 打断在流中间的那条
     * `assistant/message` 只有 `{interrupted:true, message}`，没有 `usage`）⇒ 这一档**不读**、
     * 也不落 WARN。无条件读会把「厂商没报」说成「我们读不动」，文案里还带着字面量 `undefined`，
     * 读起来像解析崩了（`assistant/attempt` 那一支本来就有这道闸，这里是漏的）。
     * 键在而形状不对（缺 `inputTokens` / `outputTokens`）才是真问题 ⇒ 那一条照旧 WARN。
     */
    const rawUsage = asRecord(data)?.usage;
    const tokens = rawUsage === undefined ? null : readTokens(rawUsage, drafts);
    if (tokens !== null) {
      // 记进**本行累计**：`step/start` / `turn/end` 两条出口都从这里取「到目前为止」的值。
      // 刻意**不清零**（原来在 `turn/end` 上取走并归零）：现在的口径是「累计快照」，
      // 每次交出都带全量，界面上只会单调增长；清零+跨消息配对正是旧口径下一堆特判的来源。
      state.usageInput = (state.usageInput ?? 0) + tokens.input;
      state.usageCached = (state.usageCached ?? 0) + tokens.cached;
      state.usageOutput = (state.usageOutput ?? 0) + tokens.output;
      /**
       * 思考 token 与厂商自报总量。两格都与上面三格**同族**（都是「这一条读数自己」的量）
       * ⇒ 一律**相加**：`reasoningTokens` 是这一个 step 的思考量，`totalTokens` 是**这一条
       * assistant 消息自己的合计**（厂商源码里 `mapUsage` 直传 pi-ai 的 `usage.totalTokens`，
       * 而那一格来自该次响应）——它不是累计快照，只覆盖会把它记成「最后一步的量」，
       * 与同一个对象里求和出来的三格口径打架（真机读数：`total` 会小于 `cached`）。
       * 两格都只在读到时更新：`null`（这一条没带）**不把已采到的值抹掉**——与
       * 「路径上后到的消息可能更简略」这条既有事实同源（`cumulativeTokens` 每次交的都是全量）。
       */
      if (tokens.reasoningOutput != null) {
        state.usageReasoningOutput = (state.usageReasoningOutput ?? 0) + tokens.reasoningOutput;
      }
      if (tokens.total != null) {
        state.usageTotal = (state.usageTotal ?? 0) + tokens.total;
      }
    }
    // 最终答复：只取 `type === 'text'` 的非空块。实测（`probe/dumps/v3/dsh-adapter-*-events.jsonl`）：
    // 同一个 content 数组里同时有 `{type:'reasoning', text:…}` 与 `{type:'text', text:'好'}`，
    // 而 reasoning 块**也带 text 字段** —— 按 text 取值会把推理内容混进答复。
    const reply = readAssistantText(data);
    /**
     * ⚠️ **只有主会话的正文才算本行答复**（`dshSubagentIdOf` 是归属判据的唯一实现）。
     * 子会话的事件与主会话走**同一条通知流**且明确放行（见 `index.ts` 的放行规则），
     * 少了这道过滤，最后一次主会话答复之后子智能体再说话就会把 `state.finalText` 顶掉——
     * 而评分通路只读最终答复（`AgentRunResult.finalText`），于是拿子智能体那句话（或它吐的 JSON）
     * 去评分，`ok` 仍然是 true、一条 WARN 都没有。
     * 对照：codex 用 `threadId === mainThreadId`、claude 只在主循环的 `result` 上写、
     * pi 只认父会话的 `message_end`；一致性套件里也有对应通则
     * （`finalText` 必须是产物里某一条**主会话**答复正文）。
     *
     * 日志那一支**不分会话**：行级事件流本来就是多会话的（子会话的工具调用与结果同样落在这里），
     * 把子智能体说过的话从这里拿掉等于丢证据——它的落点是对话视图里那条带 `subagentId` 的消息。
     */
    if (reply !== '') {
      if (dshSubagentIdOf(sessionId) === null) state.finalText = reply;
      /**
        * 模型说的话**落一条日志**（用户口径：活动行要滚动智能体实时的 event message
       * ——「评分的消息也在这里滚动展示」）。这一格过去只进 `finalText`，整轮都不出现在任何地方，
       * 于是卡片上只能看到工具 JSON。
       *
        * **不给摘要**（统一口径）：它本身就是人话，`activityOf` 在没有摘要时会直接取 `text`；
       * 再配一份截断过的摘要等于同一句话在事件里存两份、两处口径可能漂移。筛不筛 JSON 同样只由
       * 消费方判（评分阶段模型吐的就是 JSON 评分结果）——判据只能有一份。
       */
      drafts.push(logDraft('stdout', reply));
    }
    /**
      * **推理原文单独落一条**（只作证据）。
     *
     * 过滤掉 reasoning **是对的**（否则推理混进答复），但**只过滤不落盘就是把证据丢了**：
     * dsh 每次模型往返都带完整推理文本（三次往返 259 / 68 / 143 字符），
     * 而修复前这里一个字都不留。
     *
     * 落法改了：`text` 取**厂商原始信封**（与 `turn/start` 那一支同源），**不给摘要**。
     * 两个理由，缺一条都不成立：
     *   · 推理的**人话落点**是思考块（`message.ts` 的 `thinkingBlockDraft`，档位 `full`）——日志这一条是
     *     排障证据，不是第二个展示面；
     *   · 给它配一句摘要（`思考：<推理>` 那种文案）会让活动行**永久停在英文推理上**：同一轮里推理行排在
     *     答复行之后 ⇒ 最新一句恒是它（真机形态见文件头那一段）。
     *
     * ⚠️ **探测中继把整条流转成单块、破坏 SSE 分块**时，会看到「dsh 的 reasoning `text` 恒为空串」
     * 的假象——它不是厂商的行为。
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
       * 内容级消息：同一个 `assistant/message` 的 `content[]` 是**完整快照**
       * ⇒ 一条消息带齐全部块（推理 + 正文），块序号按内容顺序分配。
       * 与上面的日志**并行**：事件是行级审计与活动行，消息是对话视图与工具族统计的载体。
       */
      messages: optionalMessage(dshAssistantMessageDraft(notification, sessionId, roundOf(sessionId, data))),
    };
  }

  if (type === DSH_REQUEST_HEADER_TYPE) {
    /**
      * **MCP 的唯一判据**（dsh）：`data.header.tools` 是这一轮模型看到的工具面。
     *
     * 三条口径：
     *   · 只在表**变了**的时候发（`runState.headerTools` 记上一条）：`request/header` 每个 step 都投一条，
     *     逐条落盘等于把同一份几十 KB 的表抄进 `events.jsonl` N 遍；
     *   · **交全量**（不是增量）：后端（编排层）取最后一条当判据，最后一条必须自足；
     *   · 读不到形状（`readHeaderTools` 给 `null`）⇒ **不发**：`[]` 在本仓的定义是「投送了、确实是空的」，
     *     而「读不动」与「确实没有工具」是两件事——混起来会把一台起来了的 MCP 判成没起来。
     *
     * 通道自报 `vendor-tool-table`：推导据此把「表里没有这一台」读成**失败**（另两家在这一点上读法相反）。
     */
    noteEventTime(state, eventRecord);
    const tools = readHeaderTools(data);
    if (tools === null || sameTools(tools, runState.headerTools ?? null)) {
      return { drafts: [], tokens: null, turns: null, failure: null };
    }
    runState.headerTools = tools;
    return {
      drafts: [
        vendorSystemDraft({
          tools: [...tools],
          slashCommands: null,
          agents: null,
          // 这一家没有「每台 MCP 一张状态表」那种东西：只有工具面这一格
          mcpServers: null,
          mcpChannel: 'vendor-tool-table',
          // 权限档来自 `permission/preset`（每会话一条；本段拿不到时会话级记忆兜底）：
          // 写死 null 会让环境抽屉上那一格恒为空，连只读档也看不出来
          permissionMode: runState.permissionPreset ?? dshSessionPermissionOf(sessionId),
          outputStyle: null,
          /**
           * 技能目录那一格**一起带上**（哪怕这一次是工具表变了才发的）：消费方（行级 MCP 证据、
           * 环境抽屉的厂商那一组）都是**取最后一条**读的，一条不带它的 `vendor-system` 会把先前
           * 采到的清单在界面上抹成「厂商没投送」。真机顺序上目录先到、工具表后到，
           * 少了这一步最后一条事件里的技能面**恒为空**。
           *
           * 目录**还没到**时不给这一格（`undefined`，不是 `null`）：`null` 的读数是
           * 「厂商投送了、清单是空的」，而那时我们一个字都没读到——那是替厂商说话。
           */
          skills: namedSkillsOf(runState.skillCatalog ?? null),
        }),
      ],
      tokens: null,
      turns: null,
      failure: null,
    };
  }

  if (type === DSH_USER_MESSAGE_TYPE) {
    /**
     * **技能目录**（dsh 的 skills 判据）：厂商把「本次会话有哪些 skill」合成一条 user 消息注入提示词。
     *
     * 三条口径：
     *   · **只认 `data.source.kind === 'skill-catalog'`**：真机控制臂证明「正文里出现过
     *     `<available_skills>` 这个词」会得到 5 条噪声（厂商自己的提示词与工具描述里就有它）；
     *   · **显式分流**：不认的那一类 `user/message` 走 `unknown(raw)` 兜底（一条几十 KB 的原始
     *     JSON 日志）——这一支只处理目录这一类，**其余 `user/message` 原样落到下面的兜底**，
     *     行为逐字不变（分流不是「静默丢掉不认识的消息」）；
     *   · **只在清单变了的时候发**（照 `request/header` 的工具表那一支），且交**全量**
     *     （工具表那一格一起带上，见上面的理由）。
     */
    const source = asRecord(data?.['source']);
    if (source?.['kind'] !== DSH_SKILL_CATALOG_KIND) return unknown(raw);
    /**
     * ⚠️ **只认主会话的目录**：子会话也会收到它自己的 `<available_skills>`（同一条通知流的另一条
     * 会话），认了它就会让「本行的技能格」显示子会话的清单——那不是这一行配的技能。
     */
    const catalog = dshSubagentIdOf(sessionId) === null ? readSkillCatalog(data) : null;
    // 读不动（`null`）⇒ **不发**：`[]` 的定义是「投送了、确实一条都没有」，
    // 而「读不动」与「确实没有」是两件事——混起来会把每一条都判成「厂商没认」
    if (catalog === null || sameTools(catalog, runState.skillCatalog ?? null)) {
      return { drafts: [], tokens: null, turns: null, failure: null };
    }
    runState.skillCatalog = catalog;
    return {
      drafts: [
        vendorSystemDraft({
          tools: runState.headerTools == null ? null : [...runState.headerTools],
          slashCommands: null,
          agents: null,
          mcpServers: null,
          mcpChannel: 'vendor-tool-table',
          // 权限档来自 `permission/preset`（每会话一条；本段拿不到时会话级记忆兜底）：
          // 写死 null 会让环境抽屉上那一格恒为空，连只读档也看不出来
          permissionMode: runState.permissionPreset ?? dshSessionPermissionOf(sessionId),
          outputStyle: null,
          skills: namedSkillsOf(catalog),
        }),
      ],
      tokens: null,
      turns: null,
      failure: null,
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
    noteDshSessionTurn(sessionId, data);
    return {
      drafts: [],
      tokens: cumulativeTokens(state),
      // 归属：`noteDshSessionTurn` 刚跑过（同一份 `(turn, step)` 幂等），所以这一格与本会话的最后一步同号
      turn: dshTurnAttribution(sessionId, data),
      turns: state.turns,
      /**
        * ⚠️ **两格分量都在这一支交**（只交轮次那一格会让用量分量永远缺一份）。
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
       * 见 `CONTENT_READ_MIN_INTERVAL_MS` 的用处），只在每个 `step/start` 上跑一次。⚠️ 间隔的量级：
       * 本机产物 `runs/8e13e7a3…/rows/08c61bc6…` 那一行 34 个 `step/start` / `durationMs 47821`
       * ⇒ 平均 **≈1.4 秒**一次（子会话多、并发的行更密）。代价的结论不变（两次白名单遍历远低于
       * 一次读盘）。
       */
      subagentTokens: dshSubagentUsage(runState),
      subagentTurns: dshSubagentTurns(runState),
      failure: null,
    };
  }

  if (type === DSH_JOB_SETTLED_TYPE) {
    /**
     * **只登记退出码，不改投影**：这一条照旧走未识别兜底（原始 JSON 落日志），
     * 因为 `job/*` 的处置口径还没定（见 `protocol.ts` 的 `DSH_JOB_SETTLED_TYPE`）。
     * 登记下来的那个数由 `tool/result` 那条用来判 `isError`——真机顺序是
     * `job/registered → job/settled → tool/result`，所以投影结果时它一定已经在手。
     */
    const callId = readString(asRecord(asRecord(data)?.['toolCall']), 'callId');
    const detail = readString(data, 'detail');
    if (callId !== null && callId !== '') {
      /**
       * **两种收场都要认**（厂商 `processOutcome` 的两个分支）：
       *   · `exit code: N`：`N !== 0` 才算失败（`exit code: 0` 是正常收场）；
       *   · `signal: <SIG>` / `killed before exit`：被信号杀掉（超时、`job_kill`、运行时收工）
       *     ——**一律失败**，而正文里那条 `[killed by signal: …]` / `[timed out after …]` 是文本、
       *     不是结构化字段。
       * 只认 `exit code` 会让被杀掉的命令在界面上显示成成功（那正是这一格要消灭的形状）。
       */
      /**
       * **判据是结构化的 `(status, cause, detail)` 三元，不是只看 detail 文本**。
       *
       * 为什么必须读 `status`：`detail` 只是**部分**收场的说明。真机反例（R6-A 的 `workflow` 档）：
       * `run_in_background` 起的 workflow 被 `job_kill` 杀掉、而调用方**没传 `reason`**（那是可选参数）
       * ⇒ 厂商注册表只在 `killReason !== undefined` 时才补 `detail` ⇒ 事件是
       * `{"status":"killed","cause":"kill","producerReported":true}`，**整个 `detail` 键缺席**。
       * 只按「detail 非空才算失败」判，这条被杀的作业在界面上就画成 **ok**。
       */
      const status = readString(data, 'status');
      /**
       * 判据（R6-B 的 J 组 19 档 + R6-A 的 20 档一起核过）：
       *   ① `status ∈ {killed, failed}` ⇒ 失败（**这两档厂商都可能不带 `detail`**：真机 `workflow` 被
       *      `job_kill` 且调用方没传 `reason` 时，事件就是 `{status:'killed', cause:'kill'}`、没有 detail 键）；
       *   ② 否则看 `detail` 文本：`exit code: N` ⇒ 失败当且仅当 N ≠ 0；其余非空（`signal: …` /
       *      `killed …` / 带 sandbox 后缀的退出码）⇒ 失败；空/缺席 ⇒ 不失败。
       *
       * ⚠️ **不读 `cause`**：它与 `status` **不同源**（`killJob` / `cancelForTeardown` 先设 `settleCause`
       * 再等生产方 outcome，中间还夹着 `await job.pump.done`）——那条窄竞态里事件会是
       * `{status:'completed', detail:'exit code: 0', cause:'kill'}`，读 `cause` 会把**一次正常退出的命令
       * 画成失败**（R6-A 受控 20 档证实）。
       * ⚠️ **也不给 `status: 'completed'` 加短路**：`completed` + `signal: …` 是自相矛盾的形状，那一档要按
       * 「有失败证据」判失败（旧实现正是如此）；短路会把这类形状判成成功，方向错得危险。
       */
      const exitCode = /^exit code: (-?\d+)$/.exec(detail?.trim() ?? '')?.[1];
      /**
       * **未观测的 status 词 + 没有 detail** ⇒ 判不了失败，但**不能一声不吭**（R6-B 的 F9 残留）：
       * 今天厂商只产出 `completed` / `killed`（+ `cause: 'producer'` 一类），所以这条 WARN 只在
       * **形状漂移**时出现；没有它，`terminated` / 大写 `KILLED` 这类词会让一条失败的作业静默画成 ok。
       */
      if (status !== null && status !== 'completed' && status !== 'killed' && status !== 'failed'
        && (detail === null || detail.trim() === '')) {
        return {
          drafts: [
            logDraft(
              'stderr',
              `[WARN] 厂商报的 job/settled 收场状态是未观测的词（${status}）且没有 detail：`
                + '本次按「不判失败」处置，结果块可能显示成 ok——请核对该 job 的真实收场；'
                + `原始负载：${safeStringify(raw)}`,
            ),
          ],
          tokens: null,
          turns: null,
          failure: null,
        };
      }
      const failed = status === 'killed' || status === 'failed'
        ? true
        : exitCode !== undefined
          ? Number(exitCode) !== 0
          : detail !== null && detail.trim() !== '';
      runState.jobFailures ??= new Map<string, boolean>();
      runState.jobFailures.set(callId, failed);
      /**
       * **结果已经投影过了 ⇒ 重投一次**（同一条消息覆盖）：被信号杀掉的命令，厂商的
       * `job/settled` 会晚于 `tool/result` 到（真机 `detail: "signal: SIGTERM; …"`），
       * 那时按登记值改判就改不到已经交出去的那一条了。只有「这一条是失败」才重投
       * （成功收场不必多一条）。
       */
      const projected = runState.projectedToolResults?.get(callId);
      if (failed && projected !== undefined) {
        return {
          drafts: [logDraft('stdout', safeStringify(raw))],
          tokens: null,
          turns: null,
          failure: null,
          messages: optionalMessage(retagToolResultError(projected)),
        };
      }
    }
    return unknown(raw);
  }

  if (type === DSH_ASSISTANT_ATTEMPT_TYPE) {
    /**
     * **一次没落成 `assistant/message` 的尝试**：它**只有用量**值得投影，没有内容快照
     * （正文的落点是同一条通知流上的 stream-tap 增量，部分块本就没有快照）。
     *
     * 为什么必须累计它：厂商对一次尝试**只写两者之一**（`dsh-agent-loop`：`error` / `aborted`
     * 走 `assistant/attempt`，正常收尾走 `assistant/message`）⇒ 两处相加不会双计；漏掉它则是
     * **静默少算**——真机反代造出的一次重试里，失败尝试带的
     * `{inputTokens:374, outputTokens:102, cacheReadTokens:5888}` 与厂商 token meter 的差额
     * 逐格相等（1014−640 / 267−165 / 24320−18432），而界面上一条 WARN 都没有。
     *
     * 用量在 `data.stream[]` 的**最后一条** `usage` chunk 上（读法与厂商
     * `turn-usage.js` 的 `streamUsage` 同源，见 `protocol.ts` 的 `readAttemptUsage`）；
     * 读不到就什么都不记（不把一次尝试当成 0 记进去）——坏 key 的首条尝试正是这个形状
     * （`{inputTokens:0, outputTokens:0, totalTokens:0}` 是真的 0，也照记不误）。
     */
    const drafts: AgentEventDraft[] = [];
    noteEventTime(state, eventRecord);
    const attemptUsage = readAttemptUsage(data);
    if (attemptUsage !== null) {
      noteDshSessionUsage(sessionId, attemptUsage);
      const attemptTokens = readTokens(attemptUsage, drafts);
      if (attemptTokens !== null) {
        // 与 `assistant/message` 同一段累计口径（两处必须同源：漏一处就是「某条路径上不计」）
        state.usageInput = (state.usageInput ?? 0) + attemptTokens.input;
        state.usageCached = (state.usageCached ?? 0) + attemptTokens.cached;
        state.usageOutput = (state.usageOutput ?? 0) + attemptTokens.output;
        if (attemptTokens.reasoningOutput != null) {
          state.usageReasoningOutput = (state.usageReasoningOutput ?? 0) + attemptTokens.reasoningOutput;
        }
        if (attemptTokens.total != null) {
          state.usageTotal = (state.usageTotal ?? 0) + attemptTokens.total;
        }
      }
    }
    return {
      drafts,
      tokens: cumulativeTokens(state),
      subagentTokens: dshSubagentUsage(runState),
      subagentTurns: dshSubagentTurns(runState),
      timing: state.timing ?? undefined,
      turn: dshTurnAttribution(sessionId, data),
      turns: state.turns > 0 ? state.turns : null,
      failure: null,
    };
  }

  if (type === DSH_LLM_RETRY_TYPE) {
    /**
     * **被重试掉的那次尝试**：厂商报的 `failure` 原文 + 第几次 / 上限 / 等待多久。
     *
     * 落 WARN 而不是零草稿（它过去整条进未识别兜底，一条原始 JSON）：重试是「这一步为什么慢」
     * 的唯一解释，而 `turn/end` 只报**最终**结局——重试后成功的运行在别处看不出任何痕迹。
     * 结论不改写（重试成功仍是成功），这一条只是把过程如实留下。
     */
    const failure = asRecord(asRecord(data)?.['failure']);
    const reason = readString(failure, 'message') ?? '厂商未给原因';
    const code = readString(failure, 'code');
    const retry = readNumber(asRecord(data), 'retry');
    const maxRetries = readNumber(asRecord(data), 'maxRetries');
    const delayMs = readNumber(asRecord(data), 'delayMs');
    const parts = [
      retry === null ? '第 ? 次' : `第 ${retry}${maxRetries === null ? '' : `/${maxRetries}`} 次`,
      code === null ? reason : `[${code}] ${reason}`,
      delayMs === null ? null : `${Math.round(delayMs)} ms 后重发`,
    ].filter((part): part is string => part !== null);
    return {
      drafts: [logDraft('stderr', `[WARN] 厂商重试（${parts.join('，')}）`)],
      tokens: null,
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
      * **分量也按同一条口径再交一次**：这一支的既有语义
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
      /**
       * **非 `completed` 的收场必须留痕**。失败通道只有 `reason.kind === 'error'` 一条
       * （见文件头），其余几档（`aborted` / `blocked` / `max-tokens` / `interrupted` / `forked`）
       * 今天既不改写 `ok`、也没有任何出口——厂商明确报了的收场原因会**一个字都不剩**，
       * 排障时只能去翻厂商会话日志。
       *
       * 两条口径：
       *   · **不改写结论**：与另三家同尺（claude 的 `aborted`、codex 的 `interrupted`、
       *     pi 的 `length` 都只落 WARN）——截断/中止不等于本次运行白跑，`ok` / `finalText`
       *     按已产出的内容判定，改写结论是产品口径的事；
       *   · **照抄厂商原文**：一条 `stderr` 的 WARN，带 `kind` 与 `data.reason` 原文
       *     （载荷形状可能变，只有原文能回答「到底为什么结束」）。
       */
      const kind = readTurnEndKind(data);
      if (kind !== null && kind !== 'completed') {
        drafts.push(
          logDraft(
            'stderr',
            `[WARN] 厂商报本轮以 ${kind} 收场（不是 completed）：${safeStringify(asRecord(data)?.reason)}`
              + '——本次运行的结论不改写，按已产出的内容判定',
          ),
        );
      } else if (kind === null && asRecord(data)?.reason !== undefined) {
        /**
         * **`reason` 在场却读不出 `kind`**（形状漂移：`reason` 是字符串 / 缺 `kind` / 类型不对）⇒
         * 也要留痕。不留的话这一档与「正常 completed」在投影里**不可分**：零草稿、零 WARN、行判成功
         * （R6-B 的 F6）。照旧不改写结论，只把「我们没读懂厂商的收场」说出来。
         */
        drafts.push(
          logDraft(
            'stderr',
            '[WARN] 厂商报的 turn/end 收场原因读不出（`reason.kind` 缺失或类型不对）：'
              + `${safeStringify(asRecord(data)?.reason)}——本次运行按已产出的内容判定`,
          ),
        );
      }
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
    /**
     * ⚠️ **只有主会话的失败才是本行的失败**（与 `finalText` 那道会话闸同一条口径）。
     *
     * 子会话的 `turn/end(kind:'error')` 在同一条通知流里、同样带 `reason.error`，而**父会话可能
     * 一切正常**（真机读数：父会话正常答完、`finalText` 164 字、父会话的 `turn/end` 是
     * `completed`，整行却 `ok:false / exitReason:'error'`，错误文案与 stack 全是**子会话**那一句）。
     * 触发条件很常见：子智能体限流 / 超窗 / 鉴权失败。少了这道闸，一次成功的运行会被判失败
     * （不评分、还可能被自动重试），而界面上看到的错误与父会话的产出毫无关系。
     *
     * 子会话那一笔**照旧留证据**：`error` 草稿进事件日志，子任务行的终态由
     * `subagent.finished{status,stopReason}` 那条通道给（不靠这一格）。
     */
    const subagentId = dshSubagentIdOf(sessionId);
    return {
      drafts,
      tokens,
      subagentTokens,
      subagentTurns,
      timing,
      turn: dshTurnAttribution(sessionId, data),
      turns: state.turns > 0 ? state.turns : null,
      failure: subagentId === null ? classifyAgentMessage(failureText, context) : null,
    };
  }

  // 工具调用：**不是**「未识别」，但也不产生计量与轮次——事件那条为它补一句人话摘要
  // （见文件头），消息那条是内容级记录（工具族统计与对话视图读的就是它）。
  // `text` 还是那条原始 JSON：抽屉照旧逐字显示证据，卡片上的活动行显示的是 summary。
  if (type === DSH_TOOL_CALL_TYPE) {
    noteDshDispatchStart(runState, sessionId, data);
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
     * 工具结果：**只有报错才给摘要**（统一口径）。
     * 成功返回那句「工具返回：<内容>」会把活动行变成流水账——最新一句常常停在
     * `工具返回：<path>D:\.tmp\aieval\runs\…`；结果的落点是结果块与抽屉的原始输出面板。
     * 报错必须播：那是「这一行出事了」，而它没有别的行级出口。
     */
    const error = asRecord(data?.message)?.isError === true;
    /**
     * 结构化失败判据（`job/settled` 登记的那一格，键与该次结果的 `message.toolCallId` 同值）：
     * 非零退出**或**被信号杀掉 ⇒ 这条结果**按失败记**（见 `message.ts` 的 `dshToolResultDraft`）。
     * 活动行**不加摘要**（与 codex 同尺：非零退出里多数是探测类命令的正常返回）。
     */
    const callId = readString(asRecord(data?.message), 'toolCallId');
    const jobFailed = callId === null ? null : runState.jobFailures?.get(callId) ?? null;
    if (callId !== null && callId !== '') {
      const draft = dshToolResultDraft(notification, sessionId, roundOf(sessionId, data), jobFailed);
      if (draft !== null) {
        runState.projectedToolResults ??= new Map<string, unknown>();
        runState.projectedToolResults.set(callId, draft);
      }
    }
    return {
      drafts: [logDraft('stdout', safeStringify(raw), error ? toolErrorSummary(readContentText(asRecord(data?.message)?.content)) : undefined)],
      tokens: null,
      turns: null,
      failure: null,
      messages: optionalMessage(dshToolResultDraft(notification, sessionId, roundOf(sessionId, data), jobFailed)),
    };
  }

  return unknown(raw);
}

/**
 * 这条消息属于**哪个会话的第几次模型往返**。
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
 * 把一条已投影的工具结果**改判成失败**（`job/settled` 晚到时重投用）。
 *
 * 只动块上的 `isError`：其余字段（`callId` / 结构化结果 / 文本 / 身份）逐字保留 ⇒ 合并时落到
 * 同一条消息上（身份与块键都没变），是覆盖而不是新增。判据是内容签名，逐字相同不重发。
 */
function retagToolResultError(projected: unknown): MessageDraft {
  const draft = projected as MessageDraft;
  return {
    ...draft,
    blocks: draft.blocks.map((block) => ({ ...block, block: { ...block.block, isError: true } })),
  };
}

/**
 * 本行累计的计量。三项齐了才认；缺一项就是 null，不发明 0。
 * 与旧 `takeTurnTokens` 的唯一区别是**不取走、不清零**：现在的口径是「到目前为止的累计」，
 * 事件本身也是覆盖语义（`row-live.ts` 直接覆盖），清零只会让跨 step 的相加变成特判。
 *
 * 两项可选格（`reasoningTokens` / `totalTokens`）与三格**同一口径**（都是「这一条自己」的量）：
 * 每见到一条更完整的用量就累加进去，采不到就是 `null`（**不填 0**）。
 * 为什么它们也放在 `state` 上：dsh 的用量是**逐 step 累加**出来的（见 `assistant/message` 那一支），
 * 另两格也必须跟着同一份累计走，否则会出现「input 是三条之和、total 只有最后一条」这种
 * 自相矛盾的一行（真机上表现为 `total` 小于同一个对象里的 `cached`）。
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
 *   · **不认识的事件类型不记**（本函数只在四类事件上调用：`request/header` 定起点，
 *     `assistant/message` / `assistant/attempt` / `turn/end` 推右端点；`turn/start` 与
 *     `step/start` **都不推时间**）：取全过程首末会让跨度把与模型无关的杂事
 *     （标题生成、inbox 拼接）算进来；
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
 * 观测到的形状（dsh SDK 的原始会话事件）：三次模型往返的推理文本长度分别为
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
 * （真机：任务名与 mode 只在 `subagent/catalog` 里，而 `subagent.started`/`finished`
 * 只带 sessionId）。这里只做读取，不再维护第二份镜像——两份必然漂移，而漂移的症状是
 * 「日志里有名字、子任务行里没有」。
 */
function catalogOf(identity: string | null): { label: string | null; mode: string | null } | null {
  return identity === null ? null : lookupDshSubagentCatalog(identity);
}

/**
 * dsh 的子智能体通知 → 一条**可解析**的日志。
 *
 * 三条实测决定的口径：
 *  1. **身份**取 `agentId`（真机与 `childSessionId` 同值）⇒ `subagentId`/`vendorId` 都是厂商原生值，
 *     **不需要合成**；
 *  2. **任务名/mode 来自 `subagent/catalog`**（另一条消息）⇒ 这里查关联表，查不到就写 `null`
 *     并标 `confidence: 'unknown'`，**绝不编**；
 *  3. **`status` 是另一套词汇**：真机成功路径是 `status: "ok"` + `stopReason: "completed"`。
 *     只映射**实测见过**的取值；其余原样透出 `vendorStatus`/`stopReason` 且 `status: null`
 *     + `statusMissing: 'unverified'`——**不假装映射成 `failed`**（那会把"没见过"写成"失败"）。
 */
function subagentDraft(
  notification: Record<string, unknown> | null,
  /** 对账出来的派发调用 id（见 `claimDshDispatch`）；对账不出就是 `null` */
  parentCallId: string | null = null,
): AgentEventDraft {
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
    /** `'wire'` = 厂商通知流。dsh 侧既不是 SDK hook，也不是聚合计数 */
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
    /**
     * 厂商的通知里**没有**这一格（真机：只有两个 sessionId；SDK 的 `recordSessionRelationship`
     * 也只读 sessionId）⇒ 这里给的是**我们对账出来的**派发调用 id（`catalog.label` ↔ 在飞派发的
     * `description` 唯一命中）。认不出就是 `null`，不猜。
     */
    payload.parentToolUseId = parentCallId;
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
 * 一次 `subagent` 派发在**发起那一刻**留下的那一格（见 `projectDshNotification` 的 `dispatchStarts`）。
 */
export interface DshDispatchStart {
  /** 入参里的任务描述（与目录项的 `label` 同源）；没采到记 `null` */
  description: string | null;
  /** 这一格是被哪个子任务身份认领的（`null` = 还没被认领） */
  claimedBy: string | null;
}

/**
 * 父会话的 `tool/call` ⇒ 记一笔「这次派发在飞」。
 *
 * 为什么必须在**这里**记：厂商的 `subagent.started` / `subagent.finished` 里**没有派发调用 id**
 * （真机两个 sessionId，SDK 的 `recordSessionRelationship` 也只读 sessionId），而子任务行要落进
 * 界面上的某一轮就必须有它（或一个有区分力的名字）。父会话的 `tool/call` 是唯一一处能同时拿到
 * 「调用 id」与「任务描述」的地方。
 *
 * 只认派发工具名，其余工具调用一律不记：这张表的唯一用途是给子任务目录项认领派发点。
 */
function noteDshDispatchStart(
  runState: DshProjectionRunState,
  sessionId: string | null,
  data: Record<string, unknown> | null,
): void {
  if (runState.dispatchStarts === undefined) return;
  const toolName = readString(data, 'name');
  // 派发工具是**枚举**的两个名字（`subagent` / `subagent_fork`，同一插件的两次挂载）：
  // 只认前者会让 fork 那条路的派发行永远拿不到派发点（真机两臂对照见 `protocol.ts`）
  if (toolName === null || !DSH_SUBAGENT_TOOL_NAMES.has(toolName)) return;
  // 子会话自己也可能派子智能体（嵌套派发）：那些不进本行的子任务面，记了只会让认领撞名
  if (sessionId !== null && runState.childSessions.has(sessionId)) return;
  const callId = readString(data, 'callId');
  if (callId === null || callId === '') return;
  const args = asRecord(parseDshToolArguments(data?.['arguments']));
  runState.dispatchStarts.set(callId, { description: readString(args, 'description'), claimedBy: null });
}

/**
 * 认领一次在飞的派发：目录项的 `label`（任务名）与某次派发的入参 `description` **逐字相同且唯一**
 * 时才认。认领结果同时写进 `claimedDispatches`（同一身份的**每一条**投递都要带上同一格，
 * 否则后到的那条覆盖会把派发点抹掉）。
 *
 * 三条姿态：
 *   · 已经认领过的身份**原样返回**（本函数会被 started / catalog / finished 各调一次，
 *     「已认领」不许被读成「认不出来」）；
 *   · 零条或多条命中 ⇒ 返回 `null`，**不猜**（界面那时退回「任务名逐字相同」那条判据，
 *     与这一格缺席的历史行为同形）；
 *   · 目录项缺席（老版本 / 别的通道）⇒ 名字与派发点都拿不到，同样返回 `null`。
 */
function claimDshDispatch(
  runState: DshProjectionRunState,
  childId: string | null,
): string | null {
  if (childId === null || childId === '') return null;
  const claimed = runState.claimedDispatches?.get(childId);
  if (claimed !== undefined) return claimed;
  const label = catalogOf(childId)?.label ?? null;
  if (label === null || label === '' || runState.dispatchStarts === undefined) return null;
  const matches: string[] = [];
  for (const [callId, start] of runState.dispatchStarts) {
    if (start.claimedBy !== null) continue;
    if (start.description !== label) continue;
    matches.push(callId);
  }
  const hit = matches.length === 1 ? matches[0] : undefined;
  if (hit === undefined) return null;
  const start = runState.dispatchStarts.get(hit);
  if (start !== undefined) start.claimedBy = childId;
  runState.claimedDispatches?.set(childId, hit);
  return hit;
}

/**
 * **目录项晚到时把运行行补完整**：投过运行行、而这次目录项让它多出了名字或派发点 ⇒ 再投一条。
 *
 * 判据是**内容**：与上一条逐字相同就不投（目录项可能因 `version` 递增而重发，
 * 逐字相同的重发既不带新事实，也只会往产物里多写一行）。真机顺序上这条在收尾行之前
 * （目录项早于 `subagent.finished`），后到的那条仍是完整快照。
 *
 * ⚠️ **已收场的子任务不再补投**：补投的是一条 `status: 'running'`、`usage: null` 的运行行
 * （`dshSubagentStartRecord`），而读侧按 `subagentId` **覆盖累积、最后一条赢** ⇒ 目录项若晚于
 * 收尾到达，卡片会被从「已完成 + 有用量」打回「运行中 + 用量空」。顺序假设由 `finishedSessions`
 * 这条**事实**兜底（登记来源与放行判据同源），不靠「厂商一定按这个顺序发」。
 */
function redeliverStartedSubagent(
  runState: DshProjectionRunState,
  childId: string,
): SubagentRecord[] {
  const previous = runState.deliveredStarts?.get(childId);
  // 没投过运行行（目录项先到）：`subagent.started` 那条自己就会带上名字与派发点
  if (previous === undefined) return [];
  // 已经收场：终态记录是后到的真相，运行行不许再盖回去
  if (runState.finishedSessions?.has(childId) === true) return [];
  const record = dshSubagentStartRecord(childId, claimDshDispatch(runState, childId));
  const signature = JSON.stringify(record);
  if (signature === previous) return [];
  runState.deliveredStarts?.set(childId, signature);
  return [record];
}

/**
 * dsh 的 `status` + `stopReason` → 契约的 `status` 值域：**以 `stopReason` 分档**，
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
 * `turn/end` 的 `reason.kind`（厂商口径：`completed` / `error` / `aborted` / `blocked` /
 * `max-tokens` / `interrupted` / `forked`…）；形状不对给 `null`（**不编一个档位**）。
 * 与 `readTurnFailure` 分开：那个只回答「失败文案是什么」，这一格回答「厂商说这一轮怎么结束的」。
 */
function readTurnEndKind(data: Record<string, unknown> | null): string | null {
  return readString(asRecord(data?.reason), 'kind');
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
  const structured = asRecord(error);
  const text = readString(structured, 'message') ?? readString(reason, 'error');
  /**
   * **`error` 整格缺席时不许把 `safeStringify(undefined)` 当原因交出去**：那会得到字面量
   * `"undefined"`（`null` 那档得到 `"null"`），界面上就成了一句「原因：undefined」——厂商只是
   * **没带原因**，不是原因叫 undefined。判据与同一文件 usage 分支同款（缺席 ⇒ 说清缺席）。
   * 受控读数（R6-B 的 F1）：`turn/end{reason:{kind:'error'}}` ⇒ 旧实现 `failure.message === "undefined"`。
   */
  const message = text
    ?? (error === undefined || error === null
      ? '厂商报 turn/end 以 error 收场，但没带原因（error 格缺席）'
      : safeStringify(error));
  /**
   * **厂商的结构化失败码一起带上**（`LlmFailure.code`：实测 `TRANSPORT` / `UNKNOWN`）。
   *
   * 归因那一层（`classifyAgentMessage`）只能从**文案**里正则抓状态码（`errors.ts`），
   * 而这一格是厂商唯一的机器可读档位——丢了它，一个不带状态码原文的鉴权 / 配额失败会被折成
   * 笼统的 `AGENT_FAILED`（那一条**在自动重试表里** ⇒ 一个恒失败的配置被白跑两遍）。
   * 带上它不改变归因结果（前缀不参与正则），只是把档位留在证据里，别再丢一格事实。
   */
  const code = readString(structured, 'code');
  return code === null ? message : `[${code}] ${message}`;
}

/**
 * 读一次模型调用的用量：**两格必在、两格可缺**，判据是厂商自己的写入口径（见
 * `protocol.ts` 的 `readUsageTokens`）——
 *   · `inputTokens` / `outputTokens` 无条件写 ⇒ 读不到就整条按未采到处置（WARN + 跳过该条）；
 *   · `cacheReadTokens` 大于 0 才写 ⇒ 缺席就是 **0**（冷缓存的首条请求正是这个形状），
 *     按 0 计而不是把同一条里的 input / output 一起作废；
 *   · `reasoningTokens` / `totalTokens` 是可选的证据格，读不到是 `null`（不填 0）。
 *
 * 另有一条**恒等式校验**：厂商自报总量与分量之和不一致时把 `total` 置 `null` 并落 WARN
 * （分量含缓存写那一格）——宁可说不出总量，也不给一个自己都解释不了的数。
 *
 * **`input` 不做减法**：dsh 的 `TokenUsage` 三格**互斥**，恒等式判定逐字验过
 * （`{inputTokens:1219, cacheReadTokens:7040, cacheWriteTokens:0, outputTokens:1, totalTokens:8260}`，
 * `1219 + 7040 + 0 + 1 = 8260`）⇒ `inputTokens` 天生就是**非缓存输入**，与本仓契约同口径。
 * 这与 codex 正好相反（那边 `cached_input_tokens` 是 `input_tokens` 的**明细**，必须减）——
 * 两家读法的差别就是本仓「归一放在适配器里」那条口径存在的全部理由。
 */
function readTokens(usage: unknown, drafts: AgentEventDraft[]): UsageTokens | null {
  const reading = readUsageTokens(usage);
  if (reading === null) {
    // 落 WARN 留在这一层（消息归一那一层没有 drafts 收集器）；读数规则与字段名只有 `protocol.ts` 一份
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载读不动（缺 inputTokens / outputTokens），这一条按未采到处置、不计入合计：${safeStringify(usage)}`),
    );
    return null;
  }
  /**
   * **在场却读不动的可选格 ⇒ 落一条 WARN**（R6-B 的 F3）：这一条仍然按采到的部分累计（缓存那几格
   * 按 0 计入是厂商写入口径），但「读不动」与「确实是 0」必须分得开——否则缓存命中率静默少算。
   */
  if (reading.unreadableOptional.length > 0) {
    drafts.push(
      logDraft(
        'stderr',
        `[WARN] 用量负载里这几格在场但读不动（按 0 计入本条的累计）：${reading.unreadableOptional.join(' / ')}`
          + `——原始负载：${safeStringify(usage)}`,
      ),
    );
  }
  if (!reading.identityHolds) {
    drafts.push(
      logDraft(
        'stderr',
        `[WARN] 厂商自报总量与分量之和不一致，这一条的总量按「没采到」处置（分量照常累计）：${safeStringify(usage)}`,
      ),
    );
    return { ...reading.tokens, total: null };
  }
  return reading.tokens;
}

/**
 * 技能目录里的名字 → `vendor-system.skills` 那一格。
 *
 * dsh 的清单**只有名字**（没有来源、没有落点）⇒ 每一条的来源都是「来源未证实」，
 * 由契约的 `namedVendorSkill` 一处构造（三处各拼一遍时总有一处会顺手填一个看起来合理的来源）。
 * `null`（还没采到）给 `undefined` = **不带这一格**——它不是「清单是空的」（那是 `[]`）。
 */
function namedSkillsOf(names: readonly string[] | null): VendorSkill[] | undefined {
  return names === null ? undefined : names.map((name) => namedVendorSkill(name));
}

/**
 * 两张工具表是不是同一份（逐字比较 + 顺序敏感）。
 *
 * 顺序敏感是刻意的：dsh 每次投的都是完整的一份表，而工具顺序变了（插件挂载顺序变化）本身
 * 就是一条值得留下的证据——按集合比较会把它抹掉，代价只是一条重复事件的噪声。
 */
function sameTools(left: readonly string[], right: readonly string[] | null): boolean {
  return right !== null && left.length === right.length && left.every((name, index) => name === right[index]);
}

/** 未识别的通知 / 事件：保留原始负载（唯一允许丢弃的是重复事件） */
function unknown(raw: unknown): TurnProjection {
  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}
