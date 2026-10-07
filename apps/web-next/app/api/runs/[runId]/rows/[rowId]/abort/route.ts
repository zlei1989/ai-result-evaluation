/** 终止单行：POST。全开并发下某一行跑歪时不必等它超时。 */
import { abortRow } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    return Response.json(abortRow(runId, rowId));
  } catch (error) {
    return handleApiError(error);
  }
}
