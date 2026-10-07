/**
 * 执行日志一次性拉取：GET ?afterSeq=N（抽屉首帧与下载共用）。
 * `?afterSeq=abc` 必须是 400：静默当成 0 会让「只取增量」的调用方拿到全量，
 * 而它多半会以为自己在续订。
 */
import { getRowLog } from '@aieval/api';
import { z } from 'zod';
import { handleApiError } from '@/src/server-context';

/** 查询参数：afterSeq 可省；给了必须是 >= 0 的整数 */
const LogQuerySchema = z.object({ afterSeq: z.coerce.number().int().min(0).optional() });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    const { afterSeq } = LogQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    return Response.json(getRowLog(runId, rowId, afterSeq));
  } catch (error) {
    return handleApiError(error);
  }
}
