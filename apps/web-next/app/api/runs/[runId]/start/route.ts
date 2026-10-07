/** 开始执行这一轮里未完成的行：POST。 */
import { startRun } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(startRun(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
