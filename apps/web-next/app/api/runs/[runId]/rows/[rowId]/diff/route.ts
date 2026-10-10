/**
 * 变更详情：GET 两种形态。
 *   · `?offset=&limit=`（默认 0 / 30）→ 文件索引，**不含正文**
 *   · `?file=<path>`                 → 该文件的 diff 正文
 *
 * `offset` / `limit` 非法时按默认值处理而**不是**400：这是只读的展示接口，
 * 宽容降级比报错有用（与 `/log?afterSeq=` 的选择刻意相反——那个参数决定「从哪续」，
 * 猜错了会静默漏日志，故它必须报错）。
 *
 * `file` 只用来在内存里比对 diff 段落中的路径字符串，**不参与任何 path.join**，
 * 故不构成路径穿越面。**不要再 decodeURIComponent 一次**：`searchParams.get` 已经解过码了，
 * 再解一次会让含 `%` 的真实路径（如 `report 100%.md`）抛 URIError ⇒ 500，
 * 而字面量 `%20` 的路径会被解成空格 ⇒ 取错文件。
 */
import { getRowDiffFile, getRowDiffIndex } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    const url = new URL(req.url);
    const file = url.searchParams.get('file');

    if (file !== null && file !== '') {
      return Response.json(getRowDiffFile(runId, rowId, file));
    }

    const offset = Number(url.searchParams.get('offset') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '30');
    return Response.json(getRowDiffIndex(runId, rowId, offset, limit));
  } catch (error) {
    return handleApiError(error);
  }
}
