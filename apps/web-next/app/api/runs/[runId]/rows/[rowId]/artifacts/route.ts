/**
 * 单个候选的**一份**产物正文：GET `/api/runs/[runId]/rows/[rowId]/artifacts?name=RESULT.md`。
 *
 * `name` 只认本仓的白名单（`RESULT.md` / `RESULT.html` / `RESULT.svg`，大小写不敏感），
 * 且只在**该行工作区根**这一层里拼——名字本身进不了任何别的位置（第一道门；
 * 第二道是 core 的 `realpath` 复核）。
 *
 * **不要再 `decodeURIComponent` 一次**：`searchParams.get` 已经解过码了，再解一次会让含 `%`
 * 的真实文件名抛 `URIError` ⇒ 500（与变更详情那条路由同一条坑）。
 */
import { ServiceError } from '@aieval/contracts';
import { getRowArtifactFile } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ runId: string; rowId: string }> },
): Promise<Response> {
  try {
    const { runId, rowId } = await params;
    const name = new URL(req.url).searchParams.get('name');
    if (name === null || name === '') {
      // 缺参数与「名字不合法」分开说：前者是调用方漏了一格，后者是名字本身有问题
      throw new ServiceError('INVALID_QUERY', '缺少 name：一次只取一份产物');
    }
    return Response.json(getRowArtifactFile(runId, rowId, name));
  } catch (error) {
    return handleApiError(error);
  }
}
