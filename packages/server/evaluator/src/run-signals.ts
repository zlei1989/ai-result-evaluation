/**
 * run 级变更信号总线：`saveRun` 落盘成功后的一句「这一轮的快照变了」。
 *
 * 与行级事件总线（`events.ts`）的三处**刻意不同**：
 *   1. **信号不落盘、也不带内容**：真相源是 `run.json`，信号只是「去读它」的提示。
 *      推内容会把「帧里的快照」变成第二份真相——乱序到达时旧帧会盖掉更新的缓存；
 *   2. **live-only 且不按轮分流**：订阅者收**全部轮**的信号（页面上一条连接，
 *      由客户端按「当前打开的是哪一轮」过滤重验范围），而不是每轮一张订阅表——
 *      行级总线按行分流是因为「这一行的事件只对该行的视图有意义」，而快照重验
 *      天然是「读一次列表 / 读一次详情」，全局广播 + 客户端过滤更省连接；
 *   3. **没有 seq / Last-Event-ID 语义**：信号是瞬时提示，不进日志、不可续订。
 *      「刷新页面不丢状态」由 REST 快照兜着——信号丢了最多晚一次兜底轮询。
 *
 * 为什么挂 `globalThis`（与 `events.ts` 同一条教训）：dev 的 HMR
 * 会重新实例化模块，模块作用域的订阅表会在「旧编排层还在跑、新 SSE 已接线」时裂成
 * 两半——连接 OPEN 却一个信号都收不到。挂 `globalThis` 后无论重建多少次，
 * 发布与订阅看到的都是同一张表。
 *
 * 依赖方向：本模块**不 import** `./run-store`（那边要 import 本模块的 `publishRunChanged`
 * 作发射点），避免 eval 期循环——两侧各只有这一条边，方向单一。
 */
import { createLogger } from '@aieval/core';

const log = createLogger('run-signals');

/** 一条 run 变更信号的负载：只有 runId（内容在快照里，见文件头口径 1） */
export type RunChangedListener = (runId: string) => void;

/** 订阅表（挂 `globalThis` 的形状）：一个全局集合，不按轮分流（见文件头口径 2） */
interface RunSignalBus {
  subscribers: Set<RunChangedListener>;
}

/** 见 `events.ts` 的 `BUS_KEY`：键名必须全局唯一，挂在 `globalThis` 上防 HMR 裂脑 */
const BUS_KEY = '__aievalRunSignalBus';
type GlobalWithBus = typeof globalThis & { [BUS_KEY]?: RunSignalBus };
const globalWithBus = globalThis as GlobalWithBus;
globalWithBus[BUS_KEY] ??= { subscribers: new Set() };
const bus: RunSignalBus = globalWithBus[BUS_KEY];

/**
 * 发布一条「这一轮的快照变了」：**同步**、不落盘。
 * 唯一发射点是 `run-store.saveRun` 落盘成功之后——挂在写收口上，行级（`mutateRow`）、
 * 轮级（`setRunStatus`）与 api 的创建 / 更新全部自动覆盖，不会漏发也不会重发。
 * 订阅者抛错只记日志：一个坏订阅者不能打断其余订阅者（与 `publishRowEvent` 同一口径）。
 */
export function publishRunChanged(runId: string): void {
  // 先复制一份再遍历：订阅者在回调里退订是合法用法，遍历原集合会漏掉后续订阅者
  for (const listener of [...bus.subscribers]) {
    try {
      listener(runId);
    } catch (error) {
      log.error('run 信号订阅者抛错（其余订阅者不受影响）', {
        runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 订阅**后续**的 run 变更信号，返回退订函数（可重复调用）。
 * 不回放历史：信号没有序号、不可续订（文件头口径 3），要当前状态就读快照。
 */
export function subscribeRunChanges(listener: RunChangedListener): () => void {
  bus.subscribers.add(listener);

  return () => {
    bus.subscribers.delete(listener);
  };
}
