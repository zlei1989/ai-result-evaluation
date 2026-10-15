/**
 * 待答快照：GET，当前还没答的提问清单（全部轮次，或用 `?runId=` 收窄到某一轮）。
 *
 * 这条路由读一个可选查询参数、不读请求体、没有动态段——它是**给晚开的页面与刷新用的读侧**，
 * 唯一的事情是把 api 层的清单转成 JSON。响应体是裸数组（不是 `{items: [...]}`）：
 * 消费方拿到就是清单本身，多包一层只为将来可能的元数据，而这一格今天不存在。
 *
 * 过滤为什么不拆成 `/api/ask-user/[runId]`：清单是**一份**，两个端点的排序与形状迟早会漂；
 * 而「哪条提问属于哪一轮」的判据在 api 层（归属以快照条目自己的 `runId` 为准，信号帧不带归属）。
 */
import { getPendingAskUser } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(req: Request): Promise<Response> {
  try {
    // 缺省与空串都由 api 层按「没给」处理：路由只负责把查询串取出来
    const runId = new URL(req.url).searchParams.get('runId');
    return Response.json(getPendingAskUser(runId ?? undefined));
  } catch (error) {
    return handleApiError(error);
  }
}
