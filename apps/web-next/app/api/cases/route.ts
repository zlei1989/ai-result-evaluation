/**
 * 用例集合接口：GET 列表 / POST 新建。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
import { createCase, listCases } from '@aieval/api';
import { CaseCreateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listCases());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = CaseCreateSchema.parse(await readJsonBody(req));
    // 201：确实创建了新资源；客户端只判 res.ok，状态码用语义正确的那个
    return Response.json(createCase(input), { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
