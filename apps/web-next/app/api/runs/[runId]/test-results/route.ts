/**
 * 一轮的**测试结果只读投影**：GET `/api/runs/[runId]/test-results`。
 *
 * 数据来自每行的消息账本（`tool-call` 与配对的 `tool-result`），**不读事件台账**，也不写任何文件。
 * 排名页用它画「测试通过率」列；三态（采集到 / 未采集 / 解析失败）原样交给界面，
 * 路由不做第二份判定：把 `unparsed` 折成 0 会让「没读到」看起来像「一个都没过」。
 */
import { getRunTestResults } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(getRunTestResults(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
