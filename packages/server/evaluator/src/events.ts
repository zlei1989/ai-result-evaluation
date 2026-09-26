/**
 * 每候选行的事件总线：**一次 publish 做两件事**——追加到 `events.jsonl`（唯一真相源，F14）
 * 与扇出给进程内订阅者（SSE 的实时通道）。
 * 为什么两件事必须由同一个调用完成：分开写必然出现「落盘了但没推」或「推了但没落盘」，
 * 而事件日志是唯一真相源——它和实时流一旦分叉，刷新页面看到的与刚才推送的就对不上。
 * 为什么只做进程内（契约 §11 R6）：单个 Next 服务进程，跨进程要额外消息层而收益为零；
 * 「刷新页面不丢事件」由消费方「重读文件 + 按 seq 续订」实现（spec §7.4）。
 *
 * 注意：
 *   1. `seq` / `at` 的归属（core 的 `event-log.ts` 是唯一分配者，R17）：
 *      · `seq` **恒由写入器分配**——调用方传进来的会被覆盖（按文件里已用的最大 seq 续号）；
 *      · `at` 是**缺省补齐**——调用方没给就补当前时间，给了就**保留**（core 的
 *        `at: event.at ?? new Date().toISOString()` 只在缺省时兜）。
 *      所以生产调用方只给内容、不传 `at`：需要时间戳的字段走各自的实体字段（`judgedAt` 等），
 *      别靠事件时间去表达。订阅者收到的永远是**已落盘**的那一条；
 *   2. 订阅只收订阅**之后**发布的事件。要历史就自己读文件——**先订阅、再读文件、按 seq 去重**，
 *      顺序反了会在「读完」与「订阅上」之间丢事件；
 *   3. 订阅者抛错只记日志：一个坏订阅者不能让正在跑的 agent 事件流断掉；
 *   4. **写侧另有一层进程内兜底**（R10）：改过工作区根目录之后，这一轮的事件仍要写进
 *      「这一轮自己的根」。读侧（`listRuns` / `getRun`）**不变**，仍只扫当前设置里的根。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent } from '@aieval/contracts';
import { appendEvent, createLogger, rowEventsFile, type PendingAgentEvent } from '@aieval/core';
import { getRunForWrite } from './run-store';

const log = createLogger('events');

/** 待发布的事件：`seq` 由写入器分配、`at` 可省（省略时写入器补当前时间）。
 *  它就是 core 的 `PendingAgentEvent`（**同一个类型，不另立一份**）——别名只为让本包读起来是「行事件」。 */
export type PendingRowEvent = PendingAgentEvent;

/** 见下方 `bus` 的注释：总线必须挂在 `globalThis` 上，不能放模块作用域 */
interface RowEventBus {
  /** `runId:rowId` → events.jsonl 绝对路径（纯缓存，裂脑只让它多解析几次） */
  paths: Map<string, string>;
  /** `runId:rowId` → 该行的订阅者集合 */
  subscribers: Map<string, Set<(event: AgentEvent) => void>>;
}

/**
 * **事件总线必须挂在 `globalThis` 上**（2026-09-28 实测补的；原来放模块作用域）。
 *
 * 为什么：Next 的 dev（turbopack HMR）在源文件变化时会**重新实例化模块**。一次评测跑到一半时
 * 改一个文件，编排层（那一轮开始时加载的**旧**实例）仍然 publish 到旧 Map，而随后建立的 SSE
 * 连接由**新**实例的服务（新 Map）接管 ⇒ 连接是 `OPEN` 的、却一个事件都收不到，
 * 「实时推送」静默失效而两端都不报错。
 *
 * 实测形状（本机，一轮跑到第 44 轮时改文件）：同一行、同一时刻——
 *   · `?afterSeq=0` 的连接拿到 **12743 帧**（它走的是**历史回放**，读文件，与总线无关）；
 *   · 按当前 seq 续订的连接（页面一直在用的那条）**0 帧**，界面上的「轮次」从此不再动，
 *     刷新页面又能显示到最新（刷新走的也是回放）——这正是使用者报的「轮次不够实时」。
 *
 * 生产构建只有一个实例，本来撞不上；但本仓的开发流程就是「一边改一边看」，这条必须扛住。
 * 挂在 `globalThis` 上之后，无论模块被重建多少次，订阅者与发布者看到的都是**同一张表**。
 */
const BUS_KEY = '__aievalRowEventBus';
type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: RowEventBus };
const globalWithBus = globalThis as GlobalWithBus;
globalWithBus[BUS_KEY] ??= { paths: new Map(), subscribers: new Map() };
const bus: RowEventBus = globalWithBus[BUS_KEY];

/** `runId:rowId` → events.jsonl 绝对路径。每条事件都读一次 run.json 会让写日志退化成 O(n) 次磁盘解析 */
const eventsPaths = bus.paths;
/** `runId:rowId` → 该行的订阅者集合 */
const subscribers = bus.subscribers;

/**
 * 解析「这一轮的事件该写在哪个根下」：**委托给 `run-store` 的 `getRunForWrite`**——
 * 编排层的快照读与这里的事件写因此共用同一个「当前根优先、进程内记忆兜底」的解析（R10，H1 的修法），
 * 兜底口径（只在 NOT_FOUND 时用记忆、INVALID_QUERY / INTERNAL 原样抛出、记忆里没有就照旧 NOT_FOUND）
 * 与取值理由都写在那个函数上，本文件不再抄第二份。
 */
function resolveRunRoot(runId: string): string {
  return getRunForWrite(runId).workspaceBase;
}

/** 该行事件日志的绝对路径：优先用缓存，未命中时从**这一轮自己的根**推出来（见 resolveRunRoot） */
function eventsFileFor(runId: string, rowId: string): string {
  const key = cacheKey(runId, rowId);
  const cached = eventsPaths.get(key);
  if (cached !== undefined) return cached;
  const file = rowEventsFile(resolveRunRoot(runId), runId, rowId);
  eventsPaths.set(key, file);
  return file;
}

function cacheKey(runId: string, rowId: string): string {
  return `${runId}:${rowId}`;
}

/**
 * 发布一条行事件：落盘 → 扇出。**同步**函数（适配器的 `onEvent` 契约就是同步、不 await，
 * 见 §5.6.2：事件流不能被消费者拖慢）。
 * 落盘失败**必须冒出去**：静默丢事件等于事后无法复盘这一行到底发生了什么。
 */
export function publishRowEvent(runId: string, rowId: string, event: AgentEvent | PendingRowEvent): void {
  const file = eventsFileFor(runId, rowId);
  // 行目录可能还没建起来（「准备中」这条状态事件先于 prepareRowWorkspace 的目录复制）——补一次 mkdir
  mkdirSync(dirname(file), { recursive: true });
  const written = appendEvent(file, event);

  const listeners = subscribers.get(cacheKey(runId, rowId));
  if (listeners === undefined) return;
  // 先复制一份再遍历：订阅者在回调里取消订阅是合法用法，直接遍历原集合会漏掉后续订阅者
  for (const listener of [...listeners]) {
    try {
      listener(written);
    } catch (error) {
      log.error('事件订阅者抛错（落盘与其它订阅者不受影响）', {
        runId,
        rowId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 订阅某一行的**后续**事件，返回取消订阅函数（可重复调用）。
 * 不在这里回放历史：回放要读文件、要定 afterSeq、要去重，那是消费方（p5 的 SSE）按 seq 处理的活；
 * 本函数只保证「订阅之后发布的每一条都推给你」。
 */
export function subscribeRowEvents(runId: string, rowId: string, listener: (event: AgentEvent) => void): () => void {
  const key = cacheKey(runId, rowId);
  let listeners = subscribers.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = subscribers.get(key);
    if (current === undefined) return;
    current.delete(listener);
    // 空集合立刻回收：长驻服务里跑几百行，不回收就是一条缓慢的内存泄漏
    if (current.size === 0) subscribers.delete(key);
  };
}
