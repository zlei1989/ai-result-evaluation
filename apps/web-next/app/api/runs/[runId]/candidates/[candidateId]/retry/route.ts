/**
 * 单行**执行**：POST。只把这个候选的 agent 与评分整段跑一遍，本轮其他行一律不动。
 * 路由名与 api 层的 `retryCandidate` 保持 `retry`；**界面文案按候选状态分叉**：
 * 没跑过的候选是「开始执行」、跑过的候选是「重新执行」——两者打的是同一条链路。
 * 与 `rescore` 的分工写在 api 层 `retryCandidate` 的 JSDoc 里：重评只跑评分那一步，
 * 本路由连候选 agent 一起跑；可用判据是 `canRunCandidate`（*不在跑就放行**，含一次都没跑过的候选，
 * 「只执行当前候选项」），正在跑的候选会被 409 挡下。
 */
import { retryCandidate } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const { runId, candidateId } = await params;
    return Response.json(retryCandidate(runId, candidateId));
  } catch (error) {
    return handleApiError(error);
  }
}
