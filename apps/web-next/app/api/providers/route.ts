/**
 * 供应商接口：GET 列表（只回密钥掩码）/ POST 新增。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 */
import { createProvider, listProviders } from '@aieval/api';
import { ProviderCreateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listProviders());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const input = ProviderCreateSchema.parse(await readJsonBody(req));
    return Response.json(createProvider(input));
  } catch (error) {
    return handleApiError(error);
  }
}
