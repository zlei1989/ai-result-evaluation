/**
 * 行级**评分事件流** SSE（2026-10-10）：`judge-events.jsonl` 的历史回放 + 实时扇出，
 * 与 `../../stream`（执行日志）**分开**。评审者的原始输出因此不再混进执行日志那条流。
 *
 * 三处与执行日志那条**逐字相同**的口径（理由见 `../../stream/route.ts`）：
 *   1. 响应头四件套（含给反向代理的 `X-Accel-Buffering: no`）；
 *   2. `afterSeq` 的来源优先级：`Last-Event-ID` 头 > `?afterSeq=`；**注意这条流的 `seq` 是独立一套**，
 *      游标不许拿执行日志的号来续；
 *   3. `runtime = 'nodejs'`：事件总线是**进程内**的（§11 R6）。
 */
import { streamJudgeEvents } from '@aieval/api';
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
    const stream = streamJudgeEvents(runId, rowId, resolveAfterSeq(req));
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
