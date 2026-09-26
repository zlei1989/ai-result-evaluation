/**
 * 评测列表与创建：GET 列表 / POST 新建。
 * 只做「zod 校验 → 调 api → 错误映射」，业务规则在 @aieval/api 的 runs.ts。
 */
import { createRun, listRunsView } from '@aieval/api';
import { RunCreateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listRunsView());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = RunCreateSchema.parse(await readJsonBody(req));
    // 201：确实创建了一个新资源。客户端只看 res.ok，与 PUT /api/settings 的 200 不冲突
    return Response.json(createRun(input), { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
