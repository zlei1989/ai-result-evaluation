/**
 * 一行的**消息与子任务行**一次性拉取（spec v3 §2）：对话视图与派发面板的首帧。
 *
 * 返回的是**折叠后的最终视图**（按 `mergeKey` / `subagentId` 覆盖累积）——界面上要渲染的就是它；
 * 想看原始投递序列（增量与快照的先后）走 `./stream`。
 */
import { getRowRecords } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(getRowRecords(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
