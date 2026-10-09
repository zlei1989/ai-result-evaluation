/**
 * run 级 SSE：跨轮次的状态信号通道（页面级长连接，「快照变了 ⇒ 客户端重读 REST」）。
 *
 * 三处口径与行级 stream 路由逐字相同：`text/event-stream` 响应头（含 `X-Accel-Buffering: no`，
 * 反代默认会把 SSE 缓冲成「等连接结束才一起到」）、`runtime = 'nodejs'`（信号总线是进程内的）、
 * `force-dynamic`（长连接不能被当成静态资源）。
 *
 * 与行级 stream 路由的三处**刻意不同**：
 *   1. 无 `afterSeq` / `Last-Event-ID`：信号没有序号、不可续订（`run-signals.ts` 的口径 3），
 *      断线重连从「当下」开始即可；
 *   2. 无存在性校验、无 params：这条流不按 runId 订阅，任何时刻都可以开；
 *   3. 无 try/catch：`streamRunSignals` 不读盘、不查 id，没有会同步抛错的路径
 *      （行级路由要靠「开流前同步抛 404」，这里没有那个需求）。
 *
 * 注意：`/api/runs/events` 是静态段，路由优先级高于动态段 `[runId]`——run id 是 `randomUUID()`，
 * 字面上等于 `events` 的轮次不可达（与 `model-options` 路由同一形状）。
 */
import { streamRunSignals } from '@aieval/api';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内信号总线：必须与编排层同进程 */
export const runtime = 'nodejs';

export function GET(): Response {
  return new Response(streamRunSignals(), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
