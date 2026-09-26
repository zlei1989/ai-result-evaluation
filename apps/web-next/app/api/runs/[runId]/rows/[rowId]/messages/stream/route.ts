/**
 * 行级**消息流** SSE：内容级实时通道（spec v3 §2），与 `./stream`（行级事件流）并行。
 *
 * 三处与事件流**必须不同**的地方（照抄那边会坏）：
 *   1. **没有 `Last-Event-ID` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
 *      每次连接都回放全量，客户端按 `messageId` 去重、按 `mergeKey` 覆盖累积；
 *   2. **不设 `id:` 帧头**：设了浏览器会在重连时带上 `Last-Event-ID`，而我们这边没有任何东西能
 *      解释那个值——表现为重连后**少一段历史**，且不报错；
 *   3. `runtime = 'nodejs'`：记录总线是**进程内**的（§11 R6），换 runtime 会连不上编排层。
 */
import { streamRowRecords } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内记录总线：必须与编排层同进程 */
export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    // 校验在开流之前完成：轮/行不存在时返回 404 JSON，而不是一个开了就结束的 SSE 流
    const stream = streamRowRecords(runId, rowId);
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
