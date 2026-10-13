/**
 * 待答快照：GET，当前还没答的提问清单（全部轮次）。
 *
 * 这条路由没有参数、没有动态段，也不读请求体——它是**给晚开的页面与刷新用的读侧**，
 * 唯一的事情是把 api 层的清单转成 JSON。响应体是裸数组（不是 `{items: [...]}`）：
 * 消费方拿到就是清单本身，多包一层只为将来可能的元数据，而这一格今天不存在。
 */
import { getPendingAskUser } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(getPendingAskUser());
  } catch (error) {
    return handleApiError(error);
  }
}
