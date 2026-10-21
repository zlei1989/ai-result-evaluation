/**重新评分：POST。只重跑评分阶段，不重跑候选 agent。 */
import { rescoreCandidate } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const { runId, candidateId } = await params;
    return Response.json(rescoreCandidate(runId, candidateId));
  } catch (error) {
    return handleApiError(error);
  }
}
