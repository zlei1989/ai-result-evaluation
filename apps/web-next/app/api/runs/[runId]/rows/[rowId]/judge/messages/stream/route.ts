/**
 * 行级**评分消息流** SSE（2026-10-10）：评审者那个会话的内容级实时通道，与
 * `../../messages/stream`（候选）**并行但互不相通**（两条流各有自己的订阅表与文件）。
 *
 * 三处与候选那条**逐字相同**的口径（照抄 `../messages/stream` 的实现与理由）：
 *   1. **没有 `Last-Event-ID` 续订**：记录没有单调序号，每次连接都回放全量，客户端按 `mergeKey`
 *      覆盖累积；设了 `id:` 帧头反而会让重连少一段历史且不报错；
 *   2. **`?replay=0` 只校验行存在、不回放历史**：卡片活动行只要「此刻在打字的那一句」；
 *   3. `runtime = 'nodejs'`：记录总线是**进程内**的（§11 R6），换 runtime 会连不上编排层。
 */
import { streamJudgeRecords } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内记录总线：必须与编排层同进程 */
export const runtime = 'nodejs';

/** 要不要回放历史：只有显式 `?replay=0` 才关（缺省保持既有行为） */
function wantsReplay(req: Request): boolean {
  return new URL(req.url).searchParams.get('replay') !== '0';
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    // 校验在开流之前完成：轮/行不存在时返回 404 JSON，而不是一个开了就结束的 SSE 流
    const stream = streamJudgeRecords(runId, rowId, { replayHistory: wantsReplay(req) });
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
