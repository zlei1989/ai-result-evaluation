/**
 * **聚合流**的客户端出口：一轮评测的全部实时数据从这一条连接出，页面里挂几个消费方都只连一次。
 *
 * 三层分工（本文件只占第三层，与抽屉流的 `drawer-stream-hub.ts` 逐字同形）：
 *   · **原语**（`sse-keyed-hub.ts`）：键控的连接管理 + 解帧 + 扇出，与业务无关；
 *   · **信封**（`@aieval/contracts` 的 `RunStreamFrameSchema`）：帧的形状只有那一份；
 *   · **本文件**：键 = `runId`、URL 拼装（含逐行游标 `?after=`）、以及「一帧属于哪一族」的判别谓词。
 *
 * 业务只加了一条原语管不到的东西：**连接参数由各 sink 的游标并集决定**。三条口径：
 *
 * 1. **URL 是各 sink 共同决定的**：`?after=` 是一张逐行游标表，取各 sink 的并集；同一行取**最小**的
 *    seq（宁重不漏——取大的会跳过小游标那一侧还没折过的帧，而重放的帧在客户端按 `seq` 去重）；
 *    不需要历史的 sink（活动行那一路）不贡献任何一格。
 *    原语的 `cursor` 是**一个数**（单行单 channel 的抽屉流够用），表达不了一张表 ⇒ 这里的 `url`
 *    忽略那个入参，改从「这一刻的 sink 集合」现算（原语恰好在开连接那一刻调它，见 `mergedCursors`）。
 * 2. **晚到且「需要历史的行」不在当前游标表里的 sink ⇒ 关旧开新一次**：浏览器自动重连只会重放
 *    **首连那一刻**的 URL，不重开的话新来的行永远进不了服务端的游标表，它在那一段的历史缺口
 *    再也补不上（实时帧照旧会到，所以症状是「历史少了一截」而不是「完全不刷新」）。
 *    这类 sink 注册前**必须自己先折完历史**（`useRunLiveMetrics` 先逐行拉 `/log` 快照）——
 *    它带进来的游标只用来堵住「快照读到订阅建立」之间的缝，不是它的折叠起点。
 * 3. **行集合变小不重连**：某一个候选跑完被移出订阅集合，只是那个 sink 不再关心它的帧（帧照旧到达、
 *    被丢弃），连接不动——重开一次会白白丢掉其余行正在收的实时帧。
 *
 * 另有一条**开连接晚一拍**：同一拍内注册的多个 sink 因此能一起进 URL（早开一步就会漏掉后注册
 * 那个 sink 需要的历史）。原始语是同步开的，故这里把「第一次 `hub.subscribe`」推迟一个微任务。
 *
 * 心跳与终态都不在这里管：连接**不因终态关闭**（一条连接承载整轮），关流只有「订阅者归零」一种。
 */
import {
  RunStreamFrameSchema,
  type CandidateChannelEventFrame,
  type CandidateChannelMessageFrame,
  type RunStreamFrame,
} from '@aieval/contracts';
import { runAggregateStreamUrl } from './runs';
import { createKeyedSseHub, type SseSink } from './sse-keyed-hub';

/**
 * 一帧是不是**候选级事件帧**（`AGENT_EVENT_TYPES` 的那些：带 `seq` 与归属两格）。
 * 归属格那一格必须真在：聚合流将来还会推信号帧（它们没有 `candidateId` / `candidateChannel`），
 * 只按 `type` 判别会把它们当成事件帧交给折叠层。
 */
export function isAgentEventFrame(frame: RunStreamFrame): frame is CandidateChannelEventFrame {
  return 'candidateChannel' in frame && frame.type !== 'message' && frame.type !== 'subagent';
}

/** 一帧是不是**候选级记录帧**（消息 / 子任务行）；与 `isAgentEventFrame` 互补，判据同源 */
export function isCandidateRecordFrame(frame: RunStreamFrame): frame is CandidateChannelMessageFrame {
  return 'candidateChannel' in frame && (frame.type === 'message' || frame.type === 'subagent');
}

/** 一个订阅者向聚合流声明的三件事：哪些帧归我、收到后做什么、我已经折到哪 */
export interface RunStreamSink {
  match: (frame: RunStreamFrame) => boolean;
  onFrame: (frame: RunStreamFrame) => void;
  /**
   * 本 sink **已经折过**的各行位置（候选 id → 该候选最新 seq）；不给 / 空表 = 不需要历史。
   * 表里的候选会进 URL 的 `?after=`：服务端据此把这些行「快照之后、订阅之前」的事件补给它。
   */
  cursors?: ReadonlyMap<string, number>;
}

/** 一轮的共享连接 */
interface RunConnection {
  readonly runId: string;
  readonly sinks: Set<RunStreamSink>;
  /** 各 sink 在底层 hub 上的退订函数；还没挂上去（晚一拍那次开连接之前）时不在表里 */
  readonly offs: Map<RunStreamSink, () => void>;
  /** 已排队的开连接任务（晚一拍：同一拍内后续注册的 sink 也来得及进 URL） */
  opening: boolean;
  /**
   * 当前这条连接 URL 里**已经冻结**的游标表；`null` = 还没开过。
   * 只在 `url` provider 被调用（= 真正开连接）时更新——它回答的是「服务端手里那张表长什么样」。
   */
  opened: Map<string, number> | null;
}

/** 模块级单例：runId → 连接（页面级共享，不用 React Context——全局弹层够不着它） */
const runs = new Map<string, RunConnection>();

/** 报文信封的解析：坏帧返回 `null`（由原语丢掉那一帧，绝不打断整条流） */
function parseRunStreamFrame(data: string): RunStreamFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = RunStreamFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 键控原语（连接管理 + 解帧 + 扇出）：本文件只提供键、URL 与帧的解析 */
const hub = createKeyedSseHub<RunStreamFrame>({
  // `cursor` 这一格对聚合流没有意义（一张逐行表不是一个数）：表由当前 sink 集合现算，
  // 并记进 `opened`——「服务端手里那张表」就是后续判断要不要重连的依据
  url: (key) => {
    const connection = runs.get(key);
    if (connection === undefined) return runAggregateStreamUrl(key, new Map());
    const merged = mergedCursors(connection);
    connection.opened = merged;
    return runAggregateStreamUrl(key, merged);
  },
  // 聚合流的帧**一律无名**：判别键是信封顶层的 `type`，故没有具名事件清单
  // （原语那条「不许再 addEventListener('message')」的口径因此在这里天然成立）
  eventNames: [],
  parse: parseRunStreamFrame,
  disconnected: '实时连接中断：浏览器会自动重连，已收到的内容不受影响',
});

/** 各 sink 的游标并集：同一行取最小的 seq（宁重不漏，见文件头口径 1） */
function mergedCursors(connection: RunConnection): Map<string, number> {
  const merged = new Map<string, number>();
  for (const sink of connection.sinks) {
    for (const [candidateId, seq] of sink.cursors ?? []) {
      const current = merged.get(candidateId);
      if (current === undefined || seq < current) merged.set(candidateId, seq);
    }
  }
  return merged;
}

/**
 * 这个 sink 的「需要历史的行」是不是已经被当前那条连接覆盖。
 * 还没开过连接（`opened === null`）时恒为真：晚一拍那次开连接会把并集一次算全，不必重连。
 */
function satisfiedByOpenCursors(connection: RunConnection, sink: RunStreamSink): boolean {
  if (connection.opened === null) return true;
  for (const [candidateId, seq] of sink.cursors ?? []) {
    const opened = connection.opened.get(candidateId);
    if (opened === undefined || opened > seq) return false;
  }
  return true;
}

/** 把一个 sink 挂到底层 hub 上：帧先过它的 `match`，不匹配的一帧都不喂 */
function attach(connection: RunConnection, sink: RunStreamSink): void {
  const frameSink: SseSink<RunStreamFrame> = {
    onFrame: (frame) => {
      if (!sink.match(frame)) return;
      sink.onFrame(frame);
    },
  };
  connection.offs.set(sink, hub.subscribe(connection.runId, frameSink));
}

/** 排一次开连接（晚一拍）；已有排队任务或已开过时什么都不做 */
function scheduleOpen(connection: RunConnection): void {
  if (connection.opening) return;
  connection.opening = true;
  queueMicrotask(() => {
    connection.opening = false;
    // 排队期间可能已经被取消了（sink 归零、测试复位）：那时不再建连接
    if (connection.opened !== null || connection.sinks.size === 0) return;
    // 第一个 `hub.subscribe` 会开连接（并在那一刻读 URL ⇒ 表是完整的），其余挂到同一条上
    for (const sink of [...connection.sinks]) attach(connection, sink);
  });
}

/** 关旧开新一次：把全部 sink 摘下来（最后一个摘掉时原语会关连接），再按合并后的表挂回去 */
function reopen(connection: RunConnection): void {
  for (const off of [...connection.offs.values()]) off();
  connection.offs.clear();
  connection.opened = null;
  for (const sink of [...connection.sinks]) attach(connection, sink);
}

/**
 * 订阅一轮的聚合流，返回退订函数（可重复调用）。
 * 同一个 `runId` 上的所有 sink 共用一条连接；最后一个退订时连接关闭。
 */
export function subscribeRunStream(input: { runId: string; sink: RunStreamSink }): () => void {
  let connection = runs.get(input.runId);
  if (connection === undefined) {
    connection = { runId: input.runId, sinks: new Set(), offs: new Map(), opening: false, opened: null };
    runs.set(input.runId, connection);
  }
  const target = connection;
  // 判断必须在把 sink 加进集合**之前**做：加进去之后并集里当然有它的行，判据会自己骗自己
  const needsReopen = !satisfiedByOpenCursors(target, input.sink);
  target.sinks.add(input.sink);
  if (target.opened === null) {
    // 还没开（或正在重开）：晚一拍那次开连接会把它一起算进 URL
    scheduleOpen(target);
  } else {
    attach(target, input.sink);
  }
  // 晚到的 sink 让服务端手里那张表过期了：关旧开新一次（新 URL 由 url provider 重新拼）
  if (needsReopen) reopen(target);

  let done = false;
  return () => {
    if (done) return;
    done = true;
    target.sinks.delete(input.sink);
    target.offs.get(input.sink)?.();
    target.offs.delete(input.sink);
    // 归零：这一轮的表与连接一起回收（底层 hub 在最后一个 sink 退订时已经关掉了连接）
    if (target.sinks.size === 0) runs.delete(target.runId);
  };
}

/** 当前开着的连接数（用例断言共享与归零关连接；生产代码不读它） */
export function runStreamOpenCount(): number {
  return hub.openCount();
}

/** 测试复位：清空本轮的表并关掉底层连接（两层都是模块级单例，跨用例存活） */
export function resetRunStreamHubForTesting(): void {
  runs.clear();
  hub.reset();
}
