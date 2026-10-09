/**
 * 一次 codex 运行的**跨通知状态**（app-server 通道）。
 *
 * 为什么单独一个文件：`events.ts`（行级）与 `message.ts`（内容级）都要读同一把尺子与同一份台账，
 * 而两处各建一份必然漂移——漂移的症状是「轮次与子任务行对不上」这种看不出是谁错的错。
 * 这里只放**事实与计数**，不放任何展示口径。
 *
 * 三条约定：
 *   1. **轮次按线程分别去重**：`roundTripKeys` 的键是线程 id，值是那一线程见过的
 *      **模型答复条目 id** 集合。一次模型往返算一票 ⇒ `size` 就是该线程的轮次数。
 *      主线程与子线程各数各的，谁都不借用谁的号。
 *   2. **用量按线程记累计快照**：`usageByThread` 的值是厂商自报的 `ThreadTokenUsage`
 *      （`total` 累计 + `last` 最近一轮），**只从运行期的 `thread/tokenUsage/updated` 来**
 *      ——协议没有「按线程读用量」的请求。这里不做差分、不做归属推断。
 *   3. **派发台账只记观测到的事实**：`dispatches` 的键是子线程 id，值是「谁派发了它、用的哪次调用」。
 *      昵称来自 `thread/started` 的 `Thread.agentNickname`；收尾时 `reader` 给出更权威的一份。
 */
import type { AppServerItem, AppServerThreadUsage } from './appserver/protocol';

/** 一个子线程的派发台账（身份在本行的运行期就能拿到，不必等收尾） */
export interface CodexDispatch {
  /** 派发动作名（`spawn_agent` / `wait` …）；采不到为 `null` */
  tool: string | null;
  /** 派发那次**工具调用**的 id：子任务行的 `parentCallId` 与调用块的 `callId` 同值才谈得上配对 */
  callId: string | null;
  /** 派发者的线程 id（嵌套父链的判据：`null` = 主线程派发的 ⇒ 顶层子任务） */
  parentThreadId: string | null;
}

export interface CodexRunState {
  /** `线程 id → 见过的模型答复条目 id`（一票一轮） */
  roundTripKeys: Map<string, Set<string>>;
  /** `线程 id → 厂商自报的累计用量`（只来自 `thread/tokenUsage/updated`） */
  usageByThread: Map<string, AppServerThreadUsage>;
  /** `子线程 id → 派发台账` */
  dispatches: Map<string, CodexDispatch>;
  /** `子线程 id → 昵称`（`thread/started` 的 `Thread.agentNickname`；收尾时可被 reader 覆盖） */
  nicknames: Map<string, string>;
  /**
   * `子线程 id → 最近一次观测到的状态`（契约五态；来自协作调用的 `agentsStates` 与 `subAgentActivity`）。
   *
   * 为什么要有这一格：同一次**收场**会在多条通知上重复出现（派发那次调用完成时、`wait` 完成时、
   * 子线程自己的活动条目上），而活动行播的是「刚发生的事」——不去重就会把同一句话播三四遍。
   * 判据是**状态变化**（终态且与上次不同），所以这里存的是事实（最近见到的状态），不是「播过没有」。
   */
  subagentStatus: Map<string, string>;
  /**
   * `线程 id|条目 id → 已推完的推理增量`（全文与摘要各一格）。
   * 完成通知要靠它兑现「这一块该补什么快照」：只回密文的路由上，全文永远不写在 `content[]` 里，
   * 那一块就只剩增量这一条命——没有这份台账就只能补一个空格，把已经拿到的正文丢掉。
   */
  reasoningDeltas: Map<string, { full?: string; summary?: string }>;
  /**
   * `载体键|条目 id|块种 → 块序号`（块序号在该载体内唯一，一经分配不再变化）。
   *
   * 为什么必须由本层分配而不是一律给 0：契约的块标识就是**该载体内的第几个块**，而一个载体里
   * 会同时有推理块、正文块与工具块（它们来自不同的条目）⇒ 全给 0 会让后到的块**覆盖**先到的
   * （合并器按标识归位），真机形状「同一条消息里既想又想写」会静默只剩最后一块。
   */
  blockIndices: Map<string, number>;
}

export function createCodexRunState(): CodexRunState {
  return {
    roundTripKeys: new Map(),
    usageByThread: new Map(),
    dispatches: new Map(),
    nicknames: new Map(),
    subagentStatus: new Map(),
    reasoningDeltas: new Map(),
    blockIndices: new Map(),
  };
}

/**
 * 取该载体里这个块的序号（同一个「载体键|条目 id|块种」重复取到同一个号 ⇒ 增量与快照落进同一槽位）。
 * 载体键由调用方给（`subagentId` + 轮次 + `role`），块种区分同一条目里的全文与摘要。
 */
export function blockIndexFor(state: CodexRunState, carrier: string, itemId: string, kind: string): number {
  const key = `${carrier}|${itemId}|${kind}`;
  const existing = state.blockIndices.get(key);
  if (existing !== undefined) return existing;
  // 号源是「该载体里已经开过几个槽位」：新块只能追加到末尾
  const next = [...state.blockIndices.keys()].filter((one) => one.startsWith(`${carrier}|`)).length;
  state.blockIndices.set(key, next);
  return next;
}

/**
 * 记一个模型答复条目并返回到目前为止的轮次数。
 *
 * 判据是**条目 id 去重**：`item/started` / `item/completed` 与增量通知共享同一个 id，
 * 每见一个新 id 才算一次往返。非答复条目（推理、工具、计划）对这把尺子**透明**——
 * 它们不推高轮次，也不返回号。
 *
 * ⚠️ **返回 `null` 而不是当前值**：本条通知没有给出新的轮次信息时，发一条内容相同的 usage
 * 只是噪声（`runTurn` 的发射门槛就是轮次）。
 */
export function countRoundTrips(item: AppServerItem, threadId: string, state: CodexRunState): number | null {
  if (item.kind !== 'agentMessage') return null;
  const keys = state.roundTripKeys.get(threadId) ?? new Set<string>();
  const before = keys.size;
  keys.add(item.id);
  state.roundTripKeys.set(threadId, keys);
  return keys.size === before ? null : keys.size;
}

/** 一个线程的轮次数；`null` = 一票都没数到（**绝不编 0**——那是「确实零轮」） */
export function observedTurns(state: CodexRunState, threadId: string): number | null {
  const size = state.roundTripKeys.get(threadId)?.size ?? 0;
  return size > 0 ? size : null;
}

/** 一个线程的轮次数，**没有就是 0**（收尾求和用：每个线程各数各的答复条目） */
export function roundTripsOf(state: CodexRunState, threadId: string): number {
  return state.roundTripKeys.get(threadId)?.size ?? 0;
}

/**
 * `input − cached`，下限 0。
 *
 * codex 的 `inputTokens` **含**缓存读（`cachedInputTokens` 是它的明细），而契约的 `input` 是
 * **非缓存输入**（另两家的原文天生不含 cache）⇒ 不减就是三家口径里的那一处真实分歧：
 * 命中率公式 `cached/(input+cached)` 的分母偏大、命中率被系统性低估。
 *
 * `cached > input` 是上游数据自相矛盾（真机未出现）。照减会得到负的输入，而负 token 会让命中率与
 * 成本两条公式同时失去意义 ⇒ 夹到 0。这是唯一一处允许夹断的地方，方向是「不编造负值」。
 */
export function normalizedInput(input: number, cached: number): number {
  return Math.max(0, input - cached);
}
