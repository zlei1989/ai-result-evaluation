/**
 * 一行的**评分日志**（`judge-events.jsonl`）一次性拉取（2026-10-10）：评审者自己的原始输出，
 * 与执行日志（`../../log`）**分开**。`?afterSeq=` 给增量续拉用。
 *
 * 两条流的 `seq` 是**各自一套**（`appendEvent` 按文件续号）：拿执行日志的游标来续这条流，
 * 拿到的是一段错位的历史——所以游标必须由消费方按这条流自己的号记。
 */
import { getRowJudgeLog } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    const raw = new URL(req.url).searchParams.get('afterSeq');
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    // 非法值按「从头取」处理（与事件流路由的 afterSeq 口径一致）：解析不出来当 0，不编一个负数
    const afterSeq = Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    return Response.json(getRowJudgeLog(runId, rowId, afterSeq));
  } catch (error) {
    return handleApiError(error);
  }
}
