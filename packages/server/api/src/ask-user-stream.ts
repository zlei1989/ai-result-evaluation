/**
 * 待答清单的**信号式** SSE 产出：把挂起表的变更信号扇出成 `ask-user-changed` 帧。
 *
 * 与 run 级信号流（`run-events.ts`）**逐字同形**，与三条行级事件流刻意不同（照抄那边会错）：
 *   1. **推信号、不推内容**：帧里只有「变了」两个字，`event.data` 是空串。待答清单里有完整的
 *      问题正文与选项，而「帧里的清单」在乱序时会变成第二份真相（旧帧盖掉更新的缓存）——
 *      客户端收到信号后自己重读快照端点，读到的一定是当下的权威值；
 *   2. **没有 `id:` 行**（无 Last-Event-ID 语义）：信号是瞬时提示、不可续订，
 *      断线重连从「当下」开始，历史由快照兜着；
 *   3. **不因终态关流**：这条流长存（页面级），由客户端在离开页面时取消——
 *      「回放里出现终态就关流」那条口径只属于行级事件流，这里连「终态」都没有。
 *
 * 实现约定与既有两条信号/事件流一致：只用 Web 标准 API（`ReadableStream` / `TextEncoder`）——
 * api 禁框架，这里连 `Response` 都不组装，响应头由路由层负责；`start()` 同步执行，
 * 订阅与首帧之间没有事件循环让出点，不存在丢信号的窗口。
 */
import { createLogger } from '@aieval/core';
import { subscribeAskUserChanges } from '@aieval/evaluator';

/**
 * 作用域按文件分（不是按功能合成一个 `ask-user`）：应答 POST 那一侧（`ask-user.ts`）也打日志，
 * 两条流的前缀逐字相同时，排障现场区别不出「谁在等」与「谁刚被答」，只能靠消息文本猜。
 * 前缀仍以 `ask-user` 起头，`grep ask-user` 照旧收得齐这一功能的全部日志。
 */
const log = createLogger('ask-user-stream');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（与既有两条流同一个值） */
const HEARTBEAT_MS = 15_000;

/**
 * 一帧的序列化。`event: ask-user-changed` 让客户端按事件名订阅（具名事件，与既有流的
 * 投递契约同一口径）。**刻意没有 `id:` 行**：信号不可续订（文件头口径 2）。
 *
 * **那一行空的 `data:` 是载重的，不能省**：SSE 规范在「派发事件」这一步上写着「data buffer
 * 是空串就清空缓冲并返回」——没有 `data:` 字段的块**一个事件都不派发**，浏览器连
 * `addEventListener('ask-user-changed')` 都不会叫，客户端因此永远不知道清单变了
 * （症状是「提问后不刷新看不到弹层」）。`data:` 后面留空即可：字段值空 + 一个换行让 buffer
 * 非空从而进入派发，再由规范去掉那个换行 ⇒ `event.data === ''`。
 * 内容口径不变：**帧里没有清单**（文件头口径 1），客户端只认事件名、一个字节的载荷都不读。
 */
function toFrame(): string {
  return 'event: ask-user-changed\ndata:\n\n';
}

/**
 * 打开待答清单的信号流：订阅全部变更，直到客户端取消。
 * 无参数、无存在性校验——这条流不按轮 / 不按行订阅，任何时刻都可以开。
 */
export function streamAskUserChanges(): ReadableStream<Uint8Array> {
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
      // `controller.enqueue` 才 flush，没人提问时原本要等 15 秒心跳才 flush ⇒ 浏览器不触发
      // `onopen`、代理可能把空连接当空闲回收。与既有两条流同一条理由。
      controller.enqueue(encoder.encode(': ready\n\n'));

      unsubscribe = subscribeAskUserChanges(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(toFrame()));
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('待答信号 SSE 开始推送', {});
    },
    cancel() {
      // 客户端断开（离开页面 / 关标签）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('待答信号 SSE 被客户端取消', {});
    },
  });
}
