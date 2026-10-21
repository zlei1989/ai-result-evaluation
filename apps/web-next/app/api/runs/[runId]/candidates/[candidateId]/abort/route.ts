/** 终止单行：POST。全开并发下某一个候选跑歪时不必等它超时。 */
import { abortCandidate } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; candidateId: string }> },
): Promise<Response> {
  try {
    const { runId, candidateId } = await params;
    return Response.json(abortCandidate(runId, candidateId));
  } catch (error) {
    return handleApiError(error);
  }
}
