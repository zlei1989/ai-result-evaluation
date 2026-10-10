/**
 * 行级**消息流**SSE：内容级实时通道，与 `./stream` 并行。
 *
 * 三处与事件流**必须不同**的地方：
 * 1. **没有 `Last-Event-ID` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
 * 每次连接都回放全量，客户端按 `messageId` 去重、按 `mergeKey` 覆盖累积；
 * 2. **不设 `id:` 帧头**：设了浏览器会在重连时带上 `Last-Event-ID`，而我们这边没有任何东西能
 * 解释那个值——表现为重连后**少一段历史**，且不报错；
 * 3. `runtime = 'nodejs'`：记录总线是**进程内**的，换 runtime 会连不上编排层。
 *
 * **`?replay=0`**：只校验行存在、不回放历史。给卡片活动行那条连接用——它只要
 * 「此刻在打字的那一句」，而历史里没有 delta，为一句文案把 4 MB 的 `messages.jsonl`
 * 读进来、序列化、推过 socket 是纯浪费。缺省（含 `?replay=1` / 其它值）= 回放，即既有行为。
 */
import { streamRowRecords } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内记录总线：必须与编排层同进程 */
export const runtime = 'nodejs';

/** 要不要回放历史：只有显式 `?replay=0` 才关（缺省保持既有行为，老客户端不受影响） */
function wantsReplay(req: Request): boolean {
  return new URL(req.url).searchParams.get('replay') !== '0';
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    // 校验在开流之前完成：轮/行不存在时返回 404 JSON，而不是一个开了就结束的 SSE 流。
    // `replay: 0` 那一档走的是「只校验」，校验照样在开流之前（见 `streamRecords`）
    const stream = streamRowRecords(runId, rowId, { replayHistory: wantsReplay(req) });
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
