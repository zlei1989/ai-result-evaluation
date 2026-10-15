/**
 * 「产物总览」的索引：GET `/api/runs/[runId]/artifacts`。
 *
 * 一次给出这一轮**每个候选**在它自己的工作区根下写下的 `RESULT.*` 清单（不含正文）——
 * 界面拿它决定「产物总览」按钮出不出现，以及二级抽屉里要渲染几张卡。
 * 正文按份单独取（`…/rows/[rowId]/artifacts?name=`）：一份读不出来不该把整张总览打成空白。
 *
 * 没有查询参数：索引的形状与「哪个候选排第几」无关（名次只有一个判据，在界面那一侧由 `rankOf` 算）。
 */
import { getRunArtifactIndex } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(getRunArtifactIndex(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
