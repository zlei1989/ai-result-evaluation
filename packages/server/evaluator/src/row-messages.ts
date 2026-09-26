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
import { appendRecord, createLogger, rowMessagesFile } from '@aieval/core';
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

/** 该行记录日志的绝对路径：优先用缓存，未命中时从**这一轮自己的根**推出来（与事件侧同一个解析） */
function recordsFileFor(runId: string, rowId: string): string {
  const key = cacheKey(runId, rowId);
  const cached = bus.paths.get(key);
  if (cached !== undefined) return cached;
  const file = rowMessagesFile(getRunForWrite(runId).workspaceBase, runId, rowId);
  bus.paths.set(key, file);
  return file;
}

/**
 * 发布一条记录（消息或子任务行）：落盘 → 扇出。**同步**函数（适配器的 `onMessage` / `onSubagent`
 * 契约同步、不 await，见 spec v3 §2：内容流不能被消费者拖慢）。
 * 落盘失败**必须冒出去**：静默丢消息等于事后无法复盘这一行到底说了什么。
 */
export function publishRowRecord(runId: string, rowId: string, record: RowRecord): void {
  const file = recordsFileFor(runId, rowId);
  mkdirSync(dirname(file), { recursive: true });
  const written = appendRecord(file, record);

  const listeners = bus.subscribers.get(cacheKey(runId, rowId));
  if (listeners === undefined) return;
  // 先复制一份再遍历：订阅者在回调里取消订阅是合法用法
  for (const listener of [...listeners]) {
    try {
      listener(written);
    } catch (error) {
      log.error('记录订阅者抛错（落盘与其它订阅者不受影响）', {
        runId,
        rowId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** 发布一条内容消息（`publishRowRecord` 的窄包装：调用点只关心消息） */
export function publishRowMessage(runId: string, rowId: string, message: Extract<RowRecord, { type: 'message' }>['message']): void {
  publishRowRecord(runId, rowId, { type: 'message', message });
}

/** 发布一条子任务行（同上：派发视图的一行） */
export function publishSubagentRecord(
  runId: string,
  rowId: string,
  subagent: Extract<RowRecord, { type: 'subagent' }>['subagent'],
): void {
  publishRowRecord(runId, rowId, { type: 'subagent', subagent });
}

/**
 * 订阅某一行的**后续**记录，返回取消订阅函数（可重复调用）。
 * 不回放历史：回放要读文件、要按 `mergeKey` / `subagentId` 折叠，那是消费方（对话视图与派发面板）的活；
 * 本函数只保证「订阅之后发布的每一条都推给你」。
 */
export function subscribeRowRecords(runId: string, rowId: string, listener: RowRecordListener): () => void {
  const key = cacheKey(runId, rowId);
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
