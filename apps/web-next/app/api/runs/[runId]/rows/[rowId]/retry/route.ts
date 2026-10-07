/**
 * 单行**执行**：POST。只把这一行的候选 agent 与评分整段跑一遍，本轮其他行一律不动。
 * 路由名与 api 层的 `retryRow` 保持 `retry`（内部名不动）；**界面文案按行态分叉**（2026-09-29）：
 * 没跑过的行是「开始执行」（首跑）、跑过的行是「重新执行」——两者打的是同一条链路。
 * 与 `rescore` 的分工写在 api 层 `retryRow` 的 JSDoc 里：重评只跑评分那一步，
 * 本路由连候选 agent 一起跑；可用判据是 `canRunRow`（**不在跑就放行**，含一次都没跑过的行，
 * 2026-09-29 口径「只执行当前候选项」），正在跑的行会被 409 挡下。
 */
import { retryRow } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(retryRow(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
