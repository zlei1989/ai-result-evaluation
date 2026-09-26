/** 终止整轮：POST。在跑的行 → canceled，串行未轮到的 → skipped（划分在编排层）。 */
import { abortRun } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(abortRun(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
