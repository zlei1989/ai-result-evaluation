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
 *      （spec v3 §2），这里若重新发号，消费方就会拿两套号对不上。
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

type RowRecordListener = (record: RowRecord) => void;

interface RowMessageBus {
  /** `runId:rowId` → messages.jsonl 绝对路径（纯缓存，裂脑只让它多解析几次） */
  paths: Map<string, string>;
  /** `runId:rowId` → 该行的订阅者集合 */
  subscribers: Map<string, Set<RowRecordListener>>;
}

const BUS_KEY = '__aievalRowMessageBus';
type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: RowMessageBus };
const globalWithBus = globalThis as GlobalWithBus;
globalWithBus[BUS_KEY] ??= { paths: new Map(), subscribers: new Map() };
const bus: RowMessageBus = globalWithBus[BUS_KEY];

function cacheKey(runId: string, rowId: string): string {
  return `${runId}:${rowId}`;
}

/**
 * 评分子通道的键后缀（2026-10-10）。同一个 `runId:rowId` 上有**两条**记录流（候选与评分），
 * 路径缓存与订阅表都靠它分开：不加后缀就是把评审者的对话投给正在看执行日志的人
 * （而两者恰恰是用户要求分开的两件事）。
 */
const JUDGE_CHANNEL = ':judge';

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

/** 扇出给一条流的订阅者；`scope` 只用于出错时的日志措辞（候选 / 评分 / delta 广播） */
function fanOut(input: { key: string; runId: string; rowId: string; record: RowRecord; scope: string }): void {
  const listeners = bus.subscribers.get(input.key);
  if (listeners === undefined) return;
  // 先复制一份再遍历：订阅者在回调里取消订阅是合法用法
  for (const listener of [...listeners]) {
    try {
      listener(input.record);
    } catch (error) {
      log.error(`${input.scope}订阅者抛错（落盘与其它订阅者不受影响）`, {
        runId: input.runId,
        rowId: input.rowId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 落盘 + 扇出的唯一实现：候选与评分两条流只差 `judge` 这一格。
 * **同步**函数（适配器的 `onMessage` / `onSubagent` 契约同步、不 await，见 spec v3 §2：
 * 内容流不能被消费者拖慢）。落盘失败**必须冒出去**：静默丢消息等于事后无法复盘这一行到底说了什么。
 */
function publishRecord(runId: string, rowId: string, record: RowRecord, judge: boolean): void {
  const { key, file } = channelOf(runId, rowId, judge);
  mkdirSync(dirname(file), { recursive: true });
  const written = appendRecord(file, record);
  fanOut({ key, runId, rowId, record: written, scope: judge ? '评分记录' : '记录' });
}

/** 发布一条候选记录（消息或子任务行） */
export function publishRowRecord(runId: string, rowId: string, record: RowRecord): void {
  publishRecord(runId, rowId, record, false);
}

/**
 * 发布一条**评分阶段**的记录（2026-10-10）：落 `judge-messages.jsonl`。
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
 * **只广播、不落盘**：`chunk === 'delta'` 的内容消息走这里（2026-10-09，用户口径「三家统一」）。
 *
 * 为什么 delta 不进 `messages.jsonl`：
 *   · 唯一真相源由**快照**承担——块结束时必有快照（spec 的覆盖合并保证），delta 只是它的实时预告；
 *   · 真机量级（codex 一次运行 867 条 delta 记录、`messages.jsonl` 5.69 MB）会让文件膨胀一个数量级，
 *     而折叠读侧本来就会把同键的 delta 全部盖掉——落下来的每一行中间态都是死重。
 *
 * 代价（如实登记）：被**中断**的块没有快照 ⇒ 刷新后那段半截正文**不可见**，且**没有第二处兜底**
 * ——原先这里写着「另由事件日志的 `log` 载荷兜底」，那句话在 2026-10-09 的统一口径下是**假的**：
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
  fanOut({ key: cacheKey(runId, rowId), runId, rowId, record: { type: 'message', message }, scope: 'delta 广播的' });
}

/**
 * **只广播、不落盘**的评分增量（2026-10-10）：与 `broadcastRowMessage` 逐字同一条理由与口径，
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

/** 订阅**评分**那条记录流（2026-10-10）：与执行日志分开的第二条流 */
export function subscribeJudgeRecords(runId: string, rowId: string, listener: RowRecordListener): () => void {
  return subscribeRecords(runId, rowId, listener, true);
}
