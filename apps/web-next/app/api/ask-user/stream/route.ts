/**
 * 待答清单的信号式 SSE：`GET /api/ask-user/stream`。
 *
 * 三处口径与既有两条流路由逐字相同：`text/event-stream` 响应头（含 `X-Accel-Buffering: no`，
 * 反代默认会把 SSE 缓冲成「等连接结束才一起到」）、`runtime = 'nodejs'`（信号总线是进程内的）、
 * `force-dynamic`（长连接不能被当成静态资源）。
 *
 * 与行级 stream 路由的两处**刻意不同**（同 `runs/events` 的口径）：无 `afterSeq` / `Last-Event-ID`
 * （信号没有序号、不可续订，断线重连从「当下」开始即可）、无存在性校验与 params
 * （这条流不按轮订阅，任何时刻都可以开）。也没有 try/catch：`streamAskUserChanges` 不读盘、不查 id，
 * 没有会同步抛错的路径。
 */
import { streamAskUserChanges } from '@aieval/api';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内信号总线：必须与编排层同进程 */
export const runtime = 'nodejs';

export function GET(): Response {
  return new Response(streamAskUserChanges(), {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
