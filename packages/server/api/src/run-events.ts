/**
 * 全局流的 SSE 产出：把**三条全局总线**（run 信号 / 待答挂起表 / 人工消息队列）扇出成一条
 * 连接上的三类信号帧（`GET /api/runs/stream`）。
 *
 * 一条流承载三族信号的理由：三者都是「快照变了 ⇒ 客户端重读 REST」的提示，生命周期也一样
 * （页面级、常驻、不因终态关流），分成三条连接只会让每个页面多两条长连接。
 *
 * 与行级事件流（`run-stream.ts`）的三处**刻意不同**（照抄那边会错）：
 *   1. **推信号、不推快照**：帧里只有 `runId`（两个信号连它都没有）。快照几十 KB 而翻转的帧率极低，
 *      且「帧里的快照」在乱序时会变成第二份真相（旧帧盖掉更新的缓存）——客户端收到信号后自己
 *      重读 REST，读到的一定是落盘后的权威值；
 *   2. **没有 `id:` 行**（无 Last-Event-ID 语义）：信号是瞬时提示、不进日志、不可续订
 *      （`run-signals.ts` 的口径 3）——断线重连从「当下」开始，历史由 REST 快照兜着；
 *   3. **不因终态关流**：这条流跨轮次长存（页面级），由客户端在离开页面时取消；
 *      「回放里出现终态就关流」那条口径只属于行级事件流。
 *
 * **帧不带 `event:` 行**（与聚合流同一口径）：判别键是信封顶层的 `type`
 * （`@aieval/contracts` 的 `RunStreamFrameSchema`），再用 SSE 的具名事件表达一遍就是第二份
 * 会漂移的真相——而客户端的键控 hub 只绑 `onmessage`，发具名帧等于零交付。
 *
 * 实现约定与既有两条流一致：只用 Web 标准 API（`ReadableStream` / `TextEncoder`）——api 禁框架，
 * 响应头由路由层组装；`start()` 同步执行，订阅与首帧之间没有事件循环让出点，不存在丢信号的窗口。
 */
import type { AskUserChangedFrame, InjectMessagesChangedFrame, RunSignalFrame } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeAskUserChanges, subscribeInjectChanges, subscribeRunChanges } from '@aieval/evaluator';

/**
 * 作用域按文件分（不是与 `runs.ts` 合成一个 `runs`）：两者都在同一个进程里打日志，
 * 前缀逐字相同时排障现场区别不出「谁在等信号」与「谁刚落了盘」，只能靠消息文本猜。
 */
const log = createLogger('runs-stream');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（三条流同一个值） */
const HEARTBEAT_MS = 15_000;

/**
 * 一帧的序列化：`data` 里不能出现裸换行（否则一帧会被劈成两帧），而 `JSON.stringify` 已把换行转义。
 * **刻意没有 `id:` 行**（信号不可续订，见文件头口径 2），也**刻意没有 `event:` 行**（见文件头）。
 */
function toFrame(frame: RunSignalFrame | AskUserChangedFrame | InjectMessagesChangedFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * 打开全局信号流：同时订阅三条总线，直到客户端取消。
 * 无参数、无存在性校验——这条流不按 runId 订阅，任何时刻都可以开。
 */
export function streamGlobalSignals(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const unsubscribes: (() => void)[] = [];

  /** 释放资源（幂等）：取消要走它（这条流没有「自然关闭」的路径，见文件头口径 3） */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // **第一件事就是吐一个字节**（注释帧，客户端按 SSE 规范忽略它）：响应头要等第一次
      // `controller.enqueue` 才 flush，空信号期原本要等 15 秒心跳才 flush ⇒ 浏览器不触发
      // `onopen`、代理可能把空连接当空闲回收。与行级流同一条理由。
      controller.enqueue(encoder.encode(': ready\n\n'));

      /** 三条总线的共同出口（`closed` 判据只有这一处，三个订阅回调共用） */
      const emit = (frame: string): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(frame));
      };

      unsubscribes.push(
        subscribeRunChanges((runId) => emit(toFrame({ type: 'run-updated', runId }))),
        subscribeAskUserChanges(() => emit(toFrame({ type: 'ask-user-changed' }))),
        subscribeInjectChanges(() => emit(toFrame({ type: 'inject-messages-changed' }))),
      );

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('全局信号 SSE 开始推送', {});
    },
    cancel() {
      // 客户端断开（离开评测页 / 关标签）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('全局信号 SSE 被客户端取消', {});
    },
  });
}
