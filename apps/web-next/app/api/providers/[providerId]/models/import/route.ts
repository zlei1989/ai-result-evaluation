/**
 * 把挑选后的候选模型合并进清单（拉取的第二步）。
 * 本文件只做「zod 校验 → 调 api → 错误映射」：合并规则全在 `api/providers.ts`。
 *
 * 请求体是 `{ models: ProviderModelPreview[] }`（与预览响应同形 —— 前端把勾选的候选
 * 原样回传，所见即所得）；条目上的多余键（如 `source`）被 zod strip，落盘来源由服务端定。
 * 响应体是 `ProviderView`（客户端把它当 ProviderView 解析），不是 `{ ok: true }`。
 */
import { importProviderModels } from '@aieval/api';
import { ProviderModelsImportSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：params 是 Promise（Next 15 起） */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const input = ProviderModelsImportSchema.parse(await readJsonBody(req));
    return Response.json(importProviderModels(providerId, input));
  } catch (error) {
    return handleApiError(error);
  }
}
