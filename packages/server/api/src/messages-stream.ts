/**
 * 行级**消息流**的 SSE 产出：把 `messages.jsonl` 的历史回放 + 进程内记录总线扇出成 SSE 帧
 * （spec v3 §2 的内容级通道，与 `run-stream.ts` 的行级事件通道**并行**）。
 *
 * 与事件通道的三处**刻意不同**（照抄那边的实现会错）：
 *   1. **没有 `Last-Event-ID` 语义**：事件按 `seq` 续订，而记录没有单调序号——`messageId` 由适配器
 *      分配（`<runId>:<seq>`），跨运行会重号，`mergeKey` 只是覆盖键。所以这里**每次都回放全量**，
 *      客户端按 `messageId` 去重、按 `mergeKey` 覆盖累积（这本来就是消费方的职责）。
 *   2. **不去重帧**：一条逻辑消息会多次投递（delta 之后是快照、块一块一块地追加），它们**都**必须
 *      发出去——每一条都是「到目前为止的完整块列表」，客户端拿最后一条即可。按内容去重会把
 *      覆盖累积需要的中间状态吃掉。
 *   3. **不因终态关流**：与事件通道相反，这里**不**订阅终态事件去关流。消息流是长连接，
 *      由客户端在抽屉关闭时取消（`cancel()`）；靠终态关流会让「打开一个跑完的行的对话视图」
 *      立刻断连，而那份历史恰恰是用户要看的东西。
 */
import type { RowRecord } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeRowRecords } from '@aieval/evaluator';
import { getRowRecords } from './run-artifacts';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（与事件通道同一个值） */
const HEARTBEAT_MS = 15_000;

/**
 * 一帧的序列化。
 * `event` 名取记录的 `type`（`message` / `subagent`），消费方因此可以在浏览器侧按事件名分流，
 * 而不必先解析 `data`。SSE 的 `data` 里不能出现裸换行，而 `JSON.stringify` 已把换行转义成 `\n`。
 */
function toFrame(record: RowRecord): string {
  return `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`;
}

/**
 * 订阅一行的消息流：先回放全量历史，再接进程内记录总线。
 *
 * **先读盘、再开流**（这个顺序与事件通道同一条理由）：「评测/行不存在」由 `getRowRecords` 的
 * `findRow` 在开流之前**同步**抛出（`NOT_FOUND` + 同一句中文），路由层因此拿得到带原因的 404 JSON；
 * 把读盘塞进 `start()` 会把「记录读不出来」从同步抛错变成流内的异步 error，路由层就只剩一条
 * 刚打开就断掉的 SSE。
 */
export function streamRowRecords(runId: string, rowId: string): ReadableStream<Uint8Array> {
  // 存在性校验 + 历史一并取到（同步抛错的那一步必须在开流之前，见函数头）
  const history = getRowRecords(runId, rowId);
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** 释放资源（幂等）：关流与取消都要走它 */
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
      const close = (): void => {
        if (closed) return;
        closed = true;
        teardown();
        controller.close();
      };

      const push = (record: RowRecord): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(toFrame(record)));
      };

      // **第一件事就是吐一个字节**（注释帧，客户端按 SSE 规范忽略）：响应头要等第一次
      // `controller.enqueue` 才 flush，而空历史 + 无新记录时原本要等到 15 秒后的心跳才 flush
      // ⇒ 这段时间里浏览器不触发 `onopen`，徽标只能显示「未连接」。
      controller.enqueue(encoder.encode(': ready\n\n'));

      /**
       * 回放历史：**先订阅再回放**（顺序与事件通道相反，这里安全且必要）。
       * 安全：`start()` 是同步执行的，回放与订阅之间没有事件循环的让出点，不存在丢记录的时间窗。
       * 必要：订阅在前，回放期间到达的新记录**也在同一条流里**（都写在同一个文件末尾），
       * 客户端按 `messageId` 去重即可——这比「回放、再订阅」少一个『读到一半又来了新记录』的窗口。
       */
      unsubscribe = subscribeRowRecords(runId, rowId, push);

      for (const message of history.messages) push({ type: 'message', message });
      for (const subagent of history.subagents) push({ type: 'subagent', subagent });

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('消息 SSE 开始推送', {
        runId,
        rowId,
        replayedMessages: history.messages.length,
        replayedSubagents: history.subagents.length,
      });
    },
    cancel() {
      // 客户端断开（关闭抽屉 / 切行）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('消息 SSE 被客户端取消', { runId, rowId });
    },
  });
}

