/**
 * codex 的事件投影（§5.6.3）。
 * 规则：
 *  1. `turn.completed` → 取 `usage.input_tokens` / `usage.cached_input_tokens` /
 *     `usage.output_tokens`（三项齐了才认，缺项 → null + WARN，绝不填 0）；
 *     **`input` 要减去 cached**（2026-10-XX）：codex 的 `input_tokens` **含**缓存读
 *     （`cached_input_tokens` 是它的明细，真机 `{input_tokens:8152, cached_input_tokens:6656}`），
 *     而本仓契约的 `input` 是**非缓存输入**（claude / dsh 的原文天生就不含 cache）
 *     ⇒ 不减会让命中率公式 `cached/(input+cached)` 的分母偏大、命中率被系统性低估。
 *     详细理由写在 `readTokens` 的 JSDoc 里（含 `max(0, …)` 那一步防御）。
 *     ⚠️ 这一条路上**没有时间**：`exec --json` 的事件流一个时间字段都没有（实测）
 *     ⇒ 这条投影**不带 `timing`**，本行的时长只能由 `finalize` 读会话文件时补上
 *     （见 `transcript.ts` 的 `transcriptTiming`，`source: 'events'`）；
 *  2. `item.updated` / `item.completed` 携带**同一 item 的累积文本**：只投影新增部分，完全重复
 *     （没有新增）则丢弃——这是「唯一允许丢弃的事件是重复事件」在 codex 上的具体形状；
 *  3. `turn.failed` / `error` → 失败，并按文案归因（401 → AUTH_FAILED 等）；
 *  4. 其余（thread.started / turn.started / item.started / 未来新增类型）一律落保留原始负载的日志事件。
 *
 * **轮次 = 一次模型 API 往返**（用户口径，2026-09-28），而 codex 这里是**近似值**，理由与误差照实登记：
 *   · codex 的 `exec --json` 顶层只有 `thread.started` / `turn.started` / `turn.completed` / `item.*`
 *     （见 `codex-rs/exec/src/exec_events.rs` 的 `ThreadEvent`），**没有逐次模型请求事件**；
 *   · 它自己的 `turn.completed` 是**整段任务**一条（实测：真实 10 次模型调用只落 1 条
 *     `turn.completed`），照它数永远是 1 —— 那正是要修的那个「三家轮次不一致」；
 *   · 逐次请求的权威计数只存在于 codex 自己的会话记录里：`$CODEX_HOME` 下 `sessions` 目录里的
 *     `rollout-*.jsonl`，其中每次模型调用落一条 `event_msg.token_count`（实测 10 条 = 10 次调用）。
 *     ⚠️ **2026-10-XX 起这个文件被读了**（`transcript.ts`，在运行**结束之后**读一次）——但它**只**用来
 *     补推理正文、子智能体的消息与用量明细（`reasoning_output_tokens` / `total_tokens`），
 *     **轮次仍然按上面的近似口径数**（用户 2026-09-28 的取舍：不依赖另一个进程内部文件的格式）。
 *     会话文件里的 `turn_id` 是更准的候选，但它属于另一个口径，混进来会让「轮次」这个数一会儿按
 *     事件流算、一会儿按文件算——那正是本文件花整段注释避免的事。
 * 故这里按**模型答复条目**近似：`item.type === 'agent_message'`，按 `item.id` 去重
 * （`item.started`/`updated`/`completed` 共享同一个 id），每见一个新 id 算一次往返。
 * ⚠️ **2026-10-05 收窄**（spec §2.3）：原来这一格还数 `reasoning`。两把尺子必须都从**两侧都能
 * 看见的东西**上数出来——DeepSeek 路由上 codex 不投影 reasoning item（实测 37 条里 0 条），
 * 而会话文件里它一条不少 ⇒ 旧口径下事件流只数到 18、文件侧数到 42，用量里程碑（带事件流那套号）
 * 与抽屉的分组根本对不上。收窄成答复条目之后两侧同源，且比旧口径**更低**
 * （旧误差方向实测偏高：真实 10 次调用产出 15 条「推理摘要 + 答复」条目，见 `ae798e52`）。
 * ⚠️ 误差方向如实登记（2026-10-05）：只发工具调用、**没有答复**的那几段仍然**偏低**（它们不推高这个数）；
 * 而一次运行若一个 `AgentMessage` 都没有（只有工具调用与推理）⇒ 轮次是 `null`（界面显示「未采集」，
 * **不编 0**）——比出一个被抬高的假数好，但这是真实的口径收窄。
 * 界面与快照都用这个数，README 与这里都写明它是近似。
 */
import type { SubagentRecord, UsageTokens } from '@aieval/contracts';
import { logDraft, safeStringify, unknownEventDraft, type AgentEventDraft } from '../../emit';
import { classifyAgentMessage, type FailureContext } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import { toolCallBlockDraft, type MessageDraft } from '../../message';
import type { TurnProjection, TurnState } from '../../turn';
import { normalizedInput } from './transcript';

/**
 * 算作「一次模型往返」的条目类型（2026-10-05 收窄，spec §2.3）：**只有模型答复条目**。
 * ⚠️ 原来这里还有 `reasoning`，两侧（事件流 / 会话文件）都数它。实测证明那会让两条通道各得一套号：
 * DeepSeek 路由上 codex **不投影** reasoning item（37 条 item 里 0 条），事件流只数到 18，而会话文件
 * 里有 24 条 Reasoning ⇒ 文件侧数到 42。用量里程碑带的是事件流那一套 ⇒ 抽屉按 42 分组、里程碑说
 * 「轮次 18」，两者对不上（2026-10-05 真机）。收窄成「答复条目」之后两侧同源，且比旧口径更低
 * （旧口径被推理条目系统性抬高，见文件头）。
 */
const TURN_ITEM_TYPES: readonly string[] = ['agent_message'];

/** 多智能体条目（不在 SDK 声明的 item 联合里，见 `message-events.ts` 的同名常量） */
const ITEM_COLLAB = 'collab_tool_call';

export function projectCodexEvent(
  raw: unknown,
  state: TurnState,
  seenTexts: Map<string, string>,
  context: FailureContext,
): TurnProjection {
  const event = asRecord(raw);
  const type = readString(event, 'type') ?? 'unknown';

  if (type === 'turn.completed') {
    // 轮次**不在这里数**：这一条是整段任务一条（见文件头）。这里只交计量，轮次带上已经数到的值。
    const drafts: AgentEventDraft[] = [];
    const tokens = readTokens(event?.usage, drafts);
    const turns = observedTurns(state);
    return {
      drafts,
      tokens,
      turns,
      // 归属：事件流只有主线程（子线程的条目不在这一条流里）⇒ 会话恒为 null
      turn: turns === null ? null : { subagentId: null, round: turns },
      failure: null,
    };
  }

  if (type === 'item.updated' || type === 'item.completed') {
    const item = asRecord(event?.item);
    const id = readString(item, 'id');
    const turns = countModelOutputItem(item, id, state);
    /** 归属：与 `turns` 同一个号（事件流只有主线程 ⇒ 会话恒为 `null`）；没数到新轮次时没有归属 */
    const turn = turns === null ? null : { subagentId: null, round: turns };
    /**
     * **多智能体条目**（`collab_tool_call`）：先落子任务行，再退回日志。
     *
     * 为什么必须有这一格（2026-10-03 真机实测的形状）：这条 item **没有 `text` 字段**
     * ⇒ 原来它一路落到下面的 `unknownEventDraft`，事件流里只剩一坨原始 JSON，
     * 而**子任务行一条都不产出**（`projectCodexEvent` 从来没有 `subagents` 出口）。
     * 后果是抽屉里子任务面板恒空——即使 codex 真的派了子智能体
     * （用户口径：「codex 没有看到 subagent 消息」）。
     *
     * 真机载荷（逐字核过）：
     * `{ type:'collab_tool_call', tool:'spawn_agent', sender_thread_id, receiver_thread_ids:[子线程 id],
     *    prompt:'…', agents_states:{<子线程 id>:{status, message}}, status? }`
     * `item.started` 时 `receiver_thread_ids` 是**空数组**（子线程还没建），
     * `item.completed` 才带上——所以子任务行只在有 id 时落。
     */
    if (readString(item, 'type') === ITEM_COLLAB && item !== null) {
      const identity = collabIdentity(item);
      if (identity === null) {
        // 子线程还没建（`item.started` 时 `receiver_thread_ids` 是空数组）⇒ 不编 id，只留原始负载
        return { drafts: [unknownEventDraft(raw)], tokens: null, turns, turn, failure: null };
      }
      // 派发调用的配对键 = 条目 id（两侧同值才配对得上，见 `collabSubagent` 的注释）。
      // 没有 `item.id` 就退回子线程身份：它同样能配对（调用块的 `callId` 与记录的 `parentCallId`
      // 都是它），只是不再等于厂商的条目号——**配对成立**比「像不像厂商 id」重要。
      const callId = readString(item, 'id') ?? identity;
      /**
       * **派发调用也要落一条消息**（`role: assistant` + 一个 `tool-call` 块）。
       *
       * 为什么必须有它（2026-10-03 真机实测的缺口）：界面上「进入子任务」这个入口挂在
       * **派发工具调用**上（`buildAgentLogModel` 用 `spawnedBy.callId` 去时间轴上找那次调用，
       * 找到才画得出子任务占位条）。只交子任务行、不交调用 ⇒ 占位条**画不出来**，
       * 子任务的记录明明在文件里却没有任何入口。
       *
       * `callId` 用**条目 id**（真机 `item_8`）：事件流这一侧没有会话文件的
       * `function_call.call_id`，而「调用与子任务行配对」只要求**两侧同值**——
       * 这里给的就是同一个 id，子任务行的 `parentCallId` 也用它，于是配对成立。
       */
      return {
        drafts: [],
        tokens: null,
        turns,
        turn,
        failure: null,
        messages: [collabCallMessage(item, callId, { roundTrip: turns ?? observedTurns(state) ?? 1, raw })],
        subagents: [collabSubagent(item, identity, callId)],
      };
    }
    const text = readString(item, 'text');
    if (id === null || text === null) {
      // 没有可读文本的 item（命令执行、文件改动、MCP 调用）：保留原始负载，不解析语义
      return { drafts: [unknownEventDraft(raw)], tokens: null, turns, turn, failure: null };
    }
    const previous = seenTexts.get(id) ?? '';
    seenTexts.set(id, text);
    // 最终答复：只认 agent 消息这一种 item——这是**防御性**过滤，不是实测结论。
    // 实测（`docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` 的 codex 一节）只看到
    // `item.completed` + `item.type === 'error'` + `item.message`（**`item.text` 缺席**）与顶层的
    // `{"type":"error","message":…}`；那条会话一次模型调用都没成功，`item.type === 'agent_message'`
    // 的形状**至今没有被探测确认**（spec §14 第 2 条：探测前不许把它当成已验证事实）。
    // 所以这里按「只有明确标了 agent_message 的 item 才算答复」的保守口径过滤：模型真回话时
    // 若不叫这个名字，结果是 `finalText === null` → 该行明确失败，而不是静默出个空分。
    // 注意这是**累积**文本，每见一次覆盖一次 ⇒ 最后一次即最终。
    if (readString(item, 'type') === 'agent_message') state.finalText = text;
    // 累积文本：startsWith 说明是「上次 + 新增」；否则视为整体替换（中间被改写），整段重发
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    if (delta === '') return { drafts: [], tokens: null, turns, turn, failure: null }; // 纯重复更新：唯一允许丢弃的一类
    return { drafts: [logDraft('stdout', delta)], tokens: null, turns, turn, failure: null };
  }

  if (type === 'turn.failed' || type === 'error') {
    const message =
      readString(asRecord(event?.error), 'message') ?? readString(event, 'message') ?? safeStringify(raw);
    return {
      drafts: [{ type: 'error', message }],
      tokens: null,
      turns: null,
      failure: classifyAgentMessage(message, context),
    };
  }

  return { drafts: [unknownEventDraft(raw)], tokens: null, turns: null, failure: null };
}

/**
 * `collab_tool_call` 的子线程身份（`receiver_thread_ids[0]`）。
 * `item.started` 时是**空数组** ⇒ 返回 `null`：「还没建子线程」与「建了但没给 id」
 * 在数据上分不开，编一个会让下游静默错位。
 */
function collabIdentity(item: Record<string, unknown> | null): string | null {
  if (item === null) return null;
  const receivers = item.receiver_thread_ids;
  if (!Array.isArray(receivers)) return null;
  for (const entry of receivers) {
    if (typeof entry === 'string' && entry !== '') return entry;
  }
  return null;
}

/**
 * `collab_tool_call` → 派发调用的那一块（`assistant` 载体上的 `tool-call`）。
 *
 * `callId` 用**条目 id**：它同时写进子任务行的 `parentCallId`，两侧同值 ⇒ 界面能把
 * 「进入子任务」这个入口挂到这次调用上（见调用点的注释）。
 * 入参只留 `prompt`——真机载荷里还有 `sender_thread_id` / `agents_states` 这类**编排内部状态**，
 * 它们不是这次工具调用的入参，混进去会让「参数原文」变得不可读。
 */
function collabCallMessage(
  item: Record<string, unknown>,
  callId: string,
  envelope: { roundTrip: number; raw: unknown },
): MessageDraft {
  return {
    vendorId: callId,
    role: 'assistant',
    source: 'wire',
    roundTrip: envelope.roundTrip,
    vendorTurn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    // 消息级用量：事件流这条通道没有「这条消息花了多少」（codex 只有轮级计量）⇒ 一律 null
    usage: null,
    chunk: 'snapshot',
    blocks: [
      /**
       * 走公共草稿函数（而不是就地手搓块对象）：族载荷的归一住在那一处，
       * 手搓的块会**静默**少掉 `payload` 这一格（类型上必填，但运行时没有守卫）。
       * 这里显式传 `family: null`——`spawn_agent` / `wait` 这类协作动作名判不出族（按名字判，不按家判）。
       */
      toolCallBlockDraft(callId, readString(item, 'tool') ?? ITEM_COLLAB, { prompt: item.prompt ?? null }, null),
    ],
    raw: envelope.raw,
  };
}

/**
 * `collab_tool_call` → 子任务行（**运行期就能落**，不必等收尾）。
 *
 * 三格取值逐条实测（2026-10-03 真机载荷）：
 *   · **身份**：`receiver_thread_ids[0]`（见 `collabIdentity`）；
 *   · **名称**：`prompt` 的**第一行**（这一家没有单独的 name 字段；`prompt` 是调用方写进任务里的
 *     原文，故首行就是给这个子任务起的那句话）；空则 `null`；
 *   · **状态**：`agents_states[<子线程 id>].status`（真机 `{status:'in_progress'}`）。
 *     取值域随版本而变 ⇒ **只认得出 `completed` / `failed`**，其余按「还在跑」处理，
 *     并把没验证过的取值标成 `statusMissing: 'unverified'`——「还没跑完」与「这个取值我没见过」
 *     是两件事，界面要能分开说。
 *
 * ⚠️ 收尾那次读会话文件会交出**更完整**的同 `subagentId` 记录（`outcome`、真实用量、终态、父链），
 * 读侧按 `subagentId` 覆盖累积 ⇒ 这一条是**先给一个可导航的壳，细节由收尾补齐**。
 * 两条通道的 `subagentId` 必须同值才谈得上覆盖——真机核过：`receiver_thread_ids` 的元素
 * 就是子线程会话文件名末段那个 id。
 */
function collabSubagent(item: Record<string, unknown>, identity: string, parentCallId: string): SubagentRecord {
  const prompt = readString(item, 'prompt');
  const firstLine = prompt === null ? null : (prompt.split('\n')[0]?.trim() ?? '');
  const states = asRecord(item.agents_states);
  const childState = asRecord(states?.[identity]);
  const vendorStatus = readString(childState, 'status');
  const status: SubagentRecord['status'] =
    vendorStatus === 'completed' || vendorStatus === 'failed' ? vendorStatus : 'running';
  return {
    subagentId: identity,
    name: firstLine === null || firstLine === '' ? null : firstLine,
    // 派发动作名就是这一家的「派发方式」（真机 `spawn_agent` / `wait`）
    kind: readString(item, 'tool'),
    source: 'wire',
    status,
    statusMissing: status === 'running' && vendorStatus !== 'in_progress' ? 'unverified' : null,
    // 答复在 `agents_states[].message` 或子线程会话文件里；收尾那次会补上
    outcome: readString(childState, 'message'),
    /**
     * 与派发调用那一块**同值**（都用条目 id）⇒ 界面据此把「进入子任务」挂到那次调用上。
     * 它是**事件流内部的配对键**，不是厂商的 `function_call.call_id`——会话文件那条通道
     * 给的是真 `call_id`，两者不同值，故两条记录各自成组、互不覆盖。
     */
    parentCallId,
    parentSubagentId: null,
    usage: null,
  };
}

/**
 * 记一次「模型答复条目」并返回到目前为止的近似轮次；不带 id 或不是答复条目（含 `reasoning`）时返回 null。
 * 返回 null 而不是 `state.turns`：本条消息**没有给出新的轮次信息**，发一条内容相同的 usage
 * 只是噪声（老口径下这也正是「纯重复事件」的处置）。
 */
function countModelOutputItem(
  item: Record<string, unknown> | null,
  id: string | null,
  state: TurnState,
): number | null {
  const itemType = readString(item, 'type');
  if (id === null || itemType === null || !TURN_ITEM_TYPES.includes(itemType)) return null;
  const before = state.turnKeys.size;
  state.turnKeys.add(id);
  if (state.turnKeys.size === before) return null; // 同一条目的后续快照：不是新的往返
  state.turns = state.turnKeys.size;
  return state.turns;
}

/** 到目前为止的轮次；一次都没观察到时给 null（绝不发明一个 0） */
function observedTurns(state: TurnState): number | null {
  return state.turns > 0 ? state.turns : null;
}

/**
 * 三项齐了才认；缺项时落一条 WARN 并保留原始负载——「没采到」与「0」必须能区分（§5.6.3）。
 * 形状异常（`usage` 根本不是对象、整段缺失、缺字段）**合流到同一条 WARN**（评审 N2）：
 * `readNumber(null, …)` 天然返回 null，故不需要那条提前 return —— 有它的话，
 * `usage: 5` 这类形状会**静默**变成「没计量」。
 *
 * ## `input` 归一：`input_tokens − cached_input_tokens`
 *
 * codex 的 `input_tokens` **含**缓存读（`cached_input_tokens` 是它的明细），真机三处都验过：
 * Responses wire 抓包 `{input_tokens:35, input_tokens_details:{cached_tokens:0}, …}`、
 * **exec 事件流** `turn.completed.usage` 的 `{input_tokens:8152, cached_input_tokens:6656}`（6656 < 8152 ⇒ 子集）、
 * 以及 **rollout 会话文件** `token_count` 的 `{input_tokens:9340, cached_input_tokens:8320}`。
 * ⚠️ 2026-10-01 审计更正：8152/6656 那组早前被标成"来自 rollout"，实际只在 exec 事件流里；此处已按产物改正。
 * 而契约的 `input` 是**非缓存输入**（claude 的 `input_tokens` 与 dsh 的 `inputTokens` 原文就是
 * 不含 cache 的）⇒ **不减就是三家口径里的那一处真实分歧**：命中率公式 `cached/(input+cached)`
 * 在 codex 上分母偏大、命中率被系统性低估，而三家看起来「都算对了」。
 * 减法用 `normalizedInput`（与 `transcript.ts` 共用同一份实现：两处各写一遍必然漂移，
 * 而漂移的症状是「跑动期的数与会话文件的数对不上」——最难解释的一类）。
 *
 * `reasoning_output_tokens` / `total_tokens` **在这一条路上一般不存在**（会话文件的
 * `token_count` 才有），所以这里按可选格读：读得到就带上，读不到就是 `null`（**不填 0**）。
 */
function readTokens(usage: unknown, drafts: AgentEventDraft[]): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, 'input_tokens');
  // cached 的语义是**缓存读**：codex 的字段名是 cached_input_tokens（以探测 dump 为准）
  const cached = readNumber(record, 'cached_input_tokens');
  const output = readNumber(record, 'output_tokens');
  if (input === null || cached === null || output === null) {
    drafts.push(
      logDraft('stderr', `[WARN] 用量负载不完整，本次运行按「未采集计量」处理（不填 0）：${safeStringify(usage)}`),
    );
    return null;
  }
  return {
    input: normalizedInput(input, cached),
    cached,
    output,
    reasoningOutput: readNumber(record, 'reasoning_output_tokens'),
    total: readNumber(record, 'total_tokens'),
  };
}
