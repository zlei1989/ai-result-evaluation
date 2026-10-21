/**
 * 聚合流：一轮下所有候选的实时数据收进**一条** SSE（`?after=w-1:12,w-2:5`，逐行游标）。
 *
 * 三处必须写死的口径：
 *   1. 响应头 `text/event-stream` + `cache-control: no-cache` + `connection: keep-alive`
 *      + `X-Accel-Buffering: no`（最后一条是给反向代理的：它默认会把 SSE 缓冲起来，
 *      表现是「事件全对，但要等连接结束才一起到」）；
 *   2. `after` 格式非法 ⇒ **400**，不许静默当成空游标——那会让调用方以为自己在续订，
 *      实际只收到实时增量，历史整段丢失（界面上表现为「刷新之后卡片一直是空的」）；
 *   3. `runtime = 'nodejs'`：事件总线是**进程内**的，换到别的 runtime 会连不上编排层。
 *
 * 轮的 / 候选的存在性校验在 api 层**开流之前**同步完成（`streamRunAggregate` 读历史那一侧顺带校验），
 * 路由因此给得出带原因的 404 JSON，而不是一条刚打开就断的 SSE。
 */
import { streamRunAggregate, type CandidateCursors } from '@aieval/api';
import { z } from 'zod';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内事件总线：必须与编排层同进程 */
export const runtime = 'nodejs';

/**
 * `after` 的形状：`candidateId:seq` 逗号分隔；空串 / 缺省 = 一张空表（只推实时帧，不回放历史）。
 * `seq` 必须是 >= 0 的整数；候选 id 里不许出现 `,` / `:`（它们是两个分隔符，混进去会让切分歧义）。
 */
const AfterSchema = z.string().regex(/^(?:[^,:]+:\d+(?:,[^,:]+:\d+)*)?$/);

/**
 * `?after=` → 逐行游标表。
 * 同一个候选 id 重复出现时取**较小**的 seq：宁重不漏——取大的会跳过小游标那一侧还没折过的帧，
 * 而重放的帧在客户端按 `seq` 去重（`stepLiveState`），多发一帧没有代价。
 */
function parseCandidateCursors(after: string): CandidateCursors {
  const cursors = new Map<string, number>();
  if (after === '') return cursors;
  for (const entry of after.split(',')) {
    const [candidateId = '', seq = ''] = entry.split(':');
    const parsed = Number.parseInt(seq, 10);
    const previous = cursors.get(candidateId);
    if (previous === undefined || parsed < previous) cursors.set(candidateId, parsed);
  }
  return cursors;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  try {
    const { runId } = await params;
    // 参数校验与存在性校验都在开流之前：前者 400、后者 404，两者都不是一条开了就断的 SSE
    const after = AfterSchema.parse(new URL(req.url).searchParams.get('after') ?? '');
    const stream = streamRunAggregate(runId, parseCandidateCursors(after));
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
