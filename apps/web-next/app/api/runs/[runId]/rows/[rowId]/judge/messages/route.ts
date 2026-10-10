/**
 * 一行**评分阶段**的消息与子任务行一次性拉取：与 `../../messages/route.ts` 逐字同形，
 * 只是读 `judge-messages.jsonl` 那条**独立的流**（评审者是另一个会话，与执行日志分开）。
 *
 * 返回的是**折叠后的最终视图**（按 `mergeKey` / `subagentId` 覆盖累积）；想看原始投递序列走 `./stream`。
 * 该行还没被评审过时返回两个空数组——**不是错误**。
 */
import { getRowJudgeRecords } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(getRowJudgeRecords(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
