/**重新评分：POST。只重跑评分步骤，不重跑候选 agent。 */
import { rescoreRow } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(rescoreRow(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
