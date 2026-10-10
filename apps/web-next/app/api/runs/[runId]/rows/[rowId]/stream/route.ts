/**
 * 行级 SSE：唯一的实时通道。
 * 三处必须写死的口径：
 *   1. 响应头 `text/event-stream` + `cache-control: no-cache` + `connection: keep-alive`
 *      + `X-Accel-Buffering: no`（最后一条是给反向代理的：它默认会把 SSE 缓冲起来，
 *      表现是「事件全对，但要等连接结束才一起到」）；
 *   2. `afterSeq` 的来源优先级：`Last-Event-ID` 头 > `?afterSeq=`。浏览器自动重连时**只发头、
 *      不发 query**，而 query 里带的是首连那一刻的 seq——优先用头才能不重不漏；头的值非法就忽略；
 *   3. `runtime = 'nodejs'`：事件总线是**进程内**的，换到别的 runtime 会连不上编排层。
 */
import { streamRowEvents } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内事件总线：必须与编排层同进程 */
export const runtime = 'nodejs';

/** 续订起点：优先 `Last-Event-ID`（浏览器重连只发这个头），非法值忽略并回落到 query */
function resolveAfterSeq(req: Request): number {
  const header = req.headers.get('last-event-id');
  if (header !== null) {
    const parsed = Number.parseInt(header, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const raw = new URL(req.url).searchParams.get('afterSeq');
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    // 校验在开流之前完成：轮/行不存在时返回 404 JSON，而不是一个开了就结束的 SSE 流
    const stream = streamRowEvents(runId, rowId, resolveAfterSeq(req));
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
