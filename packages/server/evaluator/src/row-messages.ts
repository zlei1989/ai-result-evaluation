/**
 * 每候选行的**记录总线**：一次 publish 做两件事——追加到 `messages.jsonl`（唯一真相源）
 * 与扇出给进程内订阅者（对话视图与派发面板的实时通道）。与 `events.ts` 同一条理由：分开做必然
 * 出现「落盘了但没推」或「推了但没落盘」，而日志是唯一真相源，它和实时流一旦分叉，刷新页面看到的
 * 与刚才推送的就对不上。
 *
 * 与事件总线的两处**刻意不同**：
 *   1. **去重与合并的键不同**：事件按 `seq`（行级、单调、`Last-Event-ID` 续订），记录按 `messageId`
 *      （内容级、由适配器分配）与 `mergeKey`（覆盖累积）、`subagentId`（派发视图归组）。两套游标
 *      服务两种视图，不共用一条流。
 *   2. **发布端不分配任何号**：`messageId` / `mergeKey` / `subagentId` 都由适配器算好
 *      ，这里若重新发号，消费方就会拿两套号对不上。
 *
 * 扇出是**双层**的（与事件总线逐字同一条口径）：一次 publish 既投给订阅了**这一行**的订阅者，
 * 也投给订阅了**这一轮所有行**的订阅者（后者多一个 `rowId` 实参）。两套键分属两张表，
 * 不变量见 `RowMessageBus`。`broadcastRowMessage` / `broadcastJudgeMessage` 走同一个 `fanOut`，
 * 故「只广播、不落盘」的增量同样双层投递——聚合通道漏掉它，卡片上的正文就只在块结束时跳一下。
 *
 * 总线同样挂在 `globalThis` 上（理由与事件总线逐字相同：Next dev 的 HMR 会重建模块，
 * 放模块作用域会让「编排层 publish 到旧 Map、SSE 订阅新 Map」静默失效）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RowRecord } from '@aieval/contracts';
import { appendRecord, createLogger, rowJudgeMessagesFile, rowMessagesFile } from '@aieval/core';
import { getRunForWrite } from './run-store';

const log = createLogger('row-messages');

/** 行级订阅者：只认记录本身（订阅的是「某一行」的流） */
type RowRecordListener = (record: RowRecord) => void;

/** run 级订阅者：比行级多一个 `rowId`——它订阅的是「一轮下所有行」，得自己把帧归到行上 */
type RunRecordListener = (rowId: string, record: RowRecord) => void;

/** 订阅者抛错时的日志措辞：哪一层的订阅者抛的（两层各自计数，见 `logListenerError`） */
type ListenerLevel = '行级' | 'run 级';

/**
 * 总线（挂 `globalThis`，见文件头）里的**两张订阅表**：
 *
 * | 表 | 订阅的是 | 键（候选 / 评分） |
 * |---|---|---|
 * | `subscribers` | 某一行的一条流 | `runId:rowId` / `runId:rowId:judge` |
 * | `runSubscribers` | 一轮下所有行的同一条流 | `runId` / `runId:judge` |
 *
 * **键空间不变量**：两套键各自成表，任何一张表里的键都不拿到另一张表里解释（`fanOut`
 * 双层投递时正是这么查的：行键只查 `subscribers`、run 键只查 `runSubscribers`）。
 * 为什么不共用一张表：两套键在**字符串层面**可能逐字相同——`runId:judge` 既是「这一轮的评分通道」
 * （run 级键），又是「这一轮里 id 恰好叫 `judge` 的那一行的候选通道」（行级键）。共用一张表就会
 * 互相误投，而 id 是 UUID 只是把冲突推到看不见，不是让它不可能。
 */
interface RowMessageBus {
  /** `runId:rowId` → messages.jsonl 绝对路径（纯缓存，裂脑只让它多解析几次） */
  paths: Map<string, string>;
  /** 行级：`runId:rowId[:judge]` → 该行该流的订阅者集合 */
  subscribers: Map<string, Set<RowRecordListener>>;
  /** run 级：`runId[:judge]` → 该轮该流的订阅者集合（见下方为何可选） */
  runSubscribers?: Map<string, Set<RunRecordListener>>;
}

const BUS_KEY = '__aievalRowMessageBus';
type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: RowMessageBus };
const globalWithBus = globalThis as GlobalWithBus;
globalWithBus[BUS_KEY] ??= { paths: new Map(), subscribers: new Map(), runSubscribers: new Map() };
const bus: RowMessageBus = globalWithBus[BUS_KEY];
// run 级表**按需补齐**：总线对象可能由更早的模块实例建出来（HMR 重建模块，而对象留在 `globalThis` 上），
// 那种对象上没有这一格——直接读会拿到 `undefined`，并在下一次 publish 时抛。
const runSubscribers = (bus.runSubscribers ??= new Map());

function cacheKey(runId: string, rowId: string): string {
  return `${runId}:${rowId}`;
}

/**
 * 评分子通道的键后缀。同一个 `runId:rowId` 上有**两条**记录流（候选与评分），
 * 路径缓存与订阅表都靠它分开：不加后缀就是把评审者的对话投给正在看执行日志的人
 * （而两者恰恰是用户要求分开的两件事）。
 */
const JUDGE_CHANNEL = ':judge';

/**
 * run 级订阅键：`runId`（候选）/ `runId:judge`（评分）——与行级键**分属两张表**（不变量见 `RowMessageBus`）。
 * 复用同一个 `JUDGE_CHANNEL` 后缀：两条评分通道指的是同一个概念，后缀一旦漂开，症状是
 * 「订阅了评分却收到候选」这种不报错的错投。
 */
function runChannelKey(runId: string, judge: boolean): string {
  return judge ? `${runId}${JUDGE_CHANNEL}` : runId;
}

/**
 * 取一条记录流的落点：优先用缓存，未命中时从**这一轮自己的根**推出来（与事件侧同一个解析）。
 * `judge` = 评分阶段那条流（`judge-messages.jsonl`），否则是候选的 `messages.jsonl`。
 */
function channelOf(runId: string, rowId: string, judge: boolean): { key: string; file: string } {
  const key = judge ? `${cacheKey(runId, rowId)}${JUDGE_CHANNEL}` : cacheKey(runId, rowId);
  const cached = bus.paths.get(key);
  if (cached !== undefined) return { key, file: cached };
  const base = getRunForWrite(runId).workspaceBase;
  const file = judge ? rowJudgeMessagesFile(base, runId, rowId) : rowMessagesFile(base, runId, rowId);
  bus.paths.set(key, file);
  return { key, file };
}

/**
 * 投一层订阅者：**先复制再遍历**（订阅者在回调里退订是合法用法，遍历原集合会漏掉后续订阅者），
 * 坏订阅者只记日志——落盘、同层其余订阅者与另一层都不受影响。
 */
function deliver<L>(listeners: Set<L> | undefined, call: (listener: L) => void, onError: (error: unknown) => void): void {
  if (listeners === undefined) return;
  for (const listener of [...listeners]) {
    try {
      call(listener);
    } catch (error) {
      onError(error);
    }
  }
}

/** 记一条订阅者抛错（`level` 区分是哪一层），上下文与其它总线同一形状 */
function logListenerError(input: { scope: string; runId: string; rowId: string }, level: ListenerLevel, error: unknown): void {
  log.error(`${input.scope}${level}订阅者抛错（落盘与其它订阅者不受影响）`, {
    runId: input.runId,
    rowId: input.rowId,
    reason: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 扇出给一条流的**两层**订阅者：先行键（既有通道，只拿记录）、后 run 键（聚合通道，多拿一个
 * `rowId`）；两层递的是**同一条记录**（不复制、不改写）。`judge` 决定 run 键是候选还是评分那条
 * （`scope` 只用于出错时的日志措辞：候选 / 评分 / delta 广播）。
 */
function fanOut(input: {
  key: string;
  runId: string;
  rowId: string;
  judge: boolean;
  record: RowRecord;
  scope: string;
}): void {
  deliver<RowRecordListener>(
    bus.subscribers.get(input.key),
    (listener) => listener(input.record),
    (error) => logListenerError(input, '行级', error),
  );
  deliver<RunRecordListener>(
    runSubscribers.get(runChannelKey(input.runId, input.judge)),
    (listener) => listener(input.rowId, input.record),
    (error) => logListenerError(input, 'run 级', error),
  );
}

/**
 * 落盘 + 扇出的唯一实现：候选与评分两条流只差 `judge` 这一格。
 * **同步**函数（适配器的 `onMessage` / `onSubagent` 契约同步、不 await：
 * 内容流不能被消费者拖慢）。落盘失败**必须冒出去**：静默丢消息等于事后无法复盘这一行到底说了什么。
 */
function publishRecord(runId: string, rowId: string, record: RowRecord, judge: boolean): void {
  const { key, file } = channelOf(runId, rowId, judge);
  mkdirSync(dirname(file), { recursive: true });
  const written = appendRecord(file, record);
  fanOut({ key, runId, rowId, judge, record: written, scope: judge ? '评分记录' : '记录' });
}

/** 发布一条候选记录（消息或子任务行） */
export function publishRowRecord(runId: string, rowId: string, record: RowRecord): void {
  publishRecord(runId, rowId, record, false);
}

/**
 * 发布一条**评分阶段**的记录：落 `judge-messages.jsonl`。
 * 判据是**产出者**而不是类型——评审者那次 `run()` 交出来的消息与子任务行全部走这里，
 * 于是执行日志那条时间轴只讲候选做了什么。
 */
export function publishJudgeRecord(runId: string, rowId: string, record: RowRecord): void {
  publishRecord(runId, rowId, record, true);
}

/** 发布一条内容消息（`publishRowRecord` 的窄包装：调用点只关心消息） */
export function publishRowMessage(runId: string, rowId: string, message: Extract<RowRecord, { type: 'message' }>['message']): void {
  publishRowRecord(runId, rowId, { type: 'message', message });
}

/** 发布一条**评分阶段**的内容消息（`publishJudgeRecord` 的窄包装） */
export function publishJudgeMessage(runId: string, rowId: string, message: Extract<RowRecord, { type: 'message' }>['message']): void {
  publishJudgeRecord(runId, rowId, { type: 'message', message });
}

/**
 * **只广播、不落盘**：`chunk === 'delta'` 的内容消息走这里（用户口径「三家统一」）。
 *
 * 为什么 delta 不进 `messages.jsonl`：
 *   · 唯一真相源由**快照**承担——块结束时必有快照（spec 的覆盖合并保证），delta 只是它的实时预告；
 *   · 真机量级（codex 一次运行 867 条 delta 记录、`messages.jsonl` 5.69 MB）会让文件膨胀一个数量级，
 *     而折叠读侧本来就会把同键的 delta 全部盖掉——落下来的每一行中间态都是死重。
 *
 * 代价（如实登记）：被**中断**的块没有快照 ⇒ 刷新后那段半截正文**不可见**，且**没有第二处兜底**：
 * 增量三家一致地不进 `log`（三家 `events.ts` 都有显式分流），原始输出面板里也不会有它。
 * 「它死在哪句话」因此答不出来；能答的只有「它当时写到哪」——那一格是 `EvalRow.streamingDelta`
 * 的 `lastFrameChars`（编排层在 `onMessage` 的 delta 支里记，见 `orchestrator.ts`）。
 * 换来的「文件不膨胀 + 实时通道不受影响」按用户口径取舍。
 */
export function broadcastRowMessage(
  runId: string,
  rowId: string,
  message: Extract<RowRecord, { type: 'message' }>['message'],
): void {
  fanOut({ key: cacheKey(runId, rowId), runId, rowId, judge: false, record: { type: 'message', message }, scope: 'delta 广播的' });
}

/**
 * **只广播、不落盘**的评分增量：与 `broadcastRowMessage` 逐字同一条理由与口径，
 * 只是投给评分那条流（`judge-messages.jsonl` 同样只留快照）。
 */
export function broadcastJudgeMessage(
  runId: string,
  rowId: string,
  message: Extract<RowRecord, { type: 'message' }>['message'],
): void {
  fanOut({
    key: `${cacheKey(runId, rowId)}${JUDGE_CHANNEL}`,
    runId,
    rowId,
    judge: true,
    record: { type: 'message', message },
    scope: '评分 delta 广播的',
  });
}

/** 发布一条子任务行（同上：派发视图的一行） */
export function publishSubagentRecord(
  runId: string,
  rowId: string,
  subagent: Extract<RowRecord, { type: 'subagent' }>['subagent'],
): void {
  publishRowRecord(runId, rowId, { type: 'subagent', subagent });
}

/** 发布一条**评分阶段**的子任务行（评审者自己派发的子智能体） */
export function publishJudgeSubagentRecord(
  runId: string,
  rowId: string,
  subagent: Extract<RowRecord, { type: 'subagent' }>['subagent'],
): void {
  publishJudgeRecord(runId, rowId, { type: 'subagent', subagent });
}

/**
 * 订阅一条记录流的**后续**记录，返回取消订阅函数（可重复调用）。
 * 不回放历史：回放要读文件、要按 `mergeKey` / `subagentId` 折叠，那是消费方（对话视图与派发面板）的活；
 * 本函数只保证「订阅之后发布的每一条都推给你」。
 * `judge` = 评分那条流：两条流的订阅表分开，订阅执行日志的人不会收到评审者的对话。
 */
function subscribeRecords(runId: string, rowId: string, listener: RowRecordListener, judge: boolean): () => void {
  const key = judge ? `${cacheKey(runId, rowId)}${JUDGE_CHANNEL}` : cacheKey(runId, rowId);
  let listeners = bus.subscribers.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    bus.subscribers.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = bus.subscribers.get(key);
    if (current === undefined) return;
    current.delete(listener);
    // 空集合立刻回收：长驻服务里跑几百行，不回收就是一条缓慢的内存泄漏
    if (current.size === 0) bus.subscribers.delete(key);
  };
}

/** 订阅候选那条记录流（执行日志与派发面板） */
export function subscribeRowRecords(runId: string, rowId: string, listener: RowRecordListener): () => void {
  return subscribeRecords(runId, rowId, listener, false);
}

/** 订阅**评分**那条记录流：与执行日志分开的第二条流 */
export function subscribeJudgeRecords(runId: string, rowId: string, listener: RowRecordListener): () => void {
  return subscribeRecords(runId, rowId, listener, true);
}

/**
 * 订阅**一个 run 下所有行**的某一条流，返回取消订阅函数（可重复调用）。
 * 与行级同一条 live-only 口径（见 `subscribeRecords`），差别只在键与集合：这里按 run 级键分组。
 */
function subscribeRunStream(runId: string, listener: RunRecordListener, judge: boolean): () => void {
  const key = runChannelKey(runId, judge);
  let listeners = runSubscribers.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    runSubscribers.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = runSubscribers.get(key);
    if (current === undefined) return;
    current.delete(listener);
    // 空集合立刻回收：长驻服务里跑几百行，不回收就是一条缓慢的内存泄漏
    if (current.size === 0) runSubscribers.delete(key);
  };
}

/**
 * 订阅**一个 run 下所有行**的候选记录流（聚合流用），返回取消订阅函数（可重复调用）。
 * 与 `subscribeRowRecords` 的两处差别：`listener` 多一个 `rowId` 实参——它只有这一条流，
 * 得自己把帧归到行上；键是 run 级键，同一条记录由 publish 与 delta 广播**双层投递**给两层。
 * 不回放历史：要历史就自己读文件（按 `mergeKey` / `subagentId` 折叠），与行级一致。
 */
export function subscribeRunRecords(runId: string, listener: RunRecordListener): () => void {
  return subscribeRunStream(runId, listener, false);
}

/** 订阅**一个 run 下所有行**的评分记录流（与候选那条分开，见 `JUDGE_CHANNEL`） */
export function subscribeRunJudgeRecords(runId: string, listener: RunRecordListener): () => void {
  return subscribeRunStream(runId, listener, true);
}
