/**
 * run 级 SSE 产出：把 run 信号总线（`subscribeRunChanges`）扇出成 `run-updated` 帧。
 *
 * 与行级事件流（`run-stream.ts`）的三处**刻意不同**（照抄那边会错）：
 *   1. **推信号、不推快照**：帧里只有 `runId`。快照几十 KB 而状态翻转的帧率极低，
 *      且「帧里的快照」在乱序时会变成第二份真相（旧帧盖掉更新的缓存）——客户端收到
 *      信号后自己重读 REST（`getJson`），读到的一定是落盘后的权威值；
 *   2. **没有 `id:` 行**（无 Last-Event-ID 语义）：信号是瞬时提示、不进日志、不可续订
 *      （`run-signals.ts` 的口径 3）——断线重连从「当下」开始，历史由 REST 快照兜着；
 *   3. **不因终态关流**：这条流跨轮次长存（页面级），由客户端在离开页面时取消；
 *      「回放里出现终态就关流」那条口径只属于行级事件流。
 *
 * 实现约定与行级流一致：只用 Web 标准 API（`ReadableStream` / `TextEncoder`）——api 禁框架，
 * 响应头由路由层组装；`start()` 同步执行，订阅与首帧之间没有事件循环让出点，不存在丢信号的窗口。
 */
import { createLogger } from '@aieval/core';
import { subscribeRunChanges } from '@aieval/evaluator';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（与行级流同一个值） */
const HEARTBEAT_MS = 15_000;

/**
 * 一帧的序列化。`event: run-updated` 让客户端按事件名订阅（具名事件，与行级流的
 * 投递契约同一口径）；`data` 里不能出现裸换行，而 `JSON.stringify` 已把换行转义。
 * **刻意没有 `id:` 行**：信号不可续订（见文件头口径 2），多发一个 id 会让浏览器
 * 误以为这条流支持 Last-Event-ID 续订。
 */
function toFrame(runId: string): string {
  return `event: run-updated\ndata: ${JSON.stringify({ runId })}\n\n`;
}

/**
 * 打开全局的 run 信号流：订阅全部轮的信号，直到客户端取消。
 * 无参数、无存在性校验——这条流不按 runId 订阅，任何时刻都可以开。
 */
export function streamRunSignals(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** 释放资源（幂等）：取消要走它（这条流没有「自然关闭」的路径，见文件头口径 3） */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // **第一件事就是吐一个字节**（注释帧，客户端按 SSE 规范忽略它）：响应头要等第一次
      // `controller.enqueue` 才 flush，空信号期原本要等 15 秒心跳才 flush ⇒ 浏览器不触发
      // `onopen`、代理可能把空连接当空闲回收。与行级流同一条理由（F3-①）。
      controller.enqueue(encoder.encode(': ready\n\n'));

      unsubscribe = subscribeRunChanges((runId) => {
        if (closed) return;
        controller.enqueue(encoder.encode(toFrame(runId)));
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('run 信号 SSE 开始推送', {});
    },
    cancel() {
      // 客户端断开（离开评测页 / 关标签）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('run 信号 SSE 被客户端取消', {});
    },
  });
}
