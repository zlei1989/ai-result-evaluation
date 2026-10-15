/**
 * 拉取上游 /models 的**候选**清单：只读不写。
 * 本文件只做「调 api → 错误映射」：没有请求体要校验（providerId 来自路径）。
 * 候选经用户在预览对话框里挑选后，由 `models/import` 那条路由合并落盘 ——
 * 这条路由自己绝不写配置：预览一旦落盘半个字，「拉取」就变成了「直接进清单」——
 * 用户还没挑，配置已经被改过。
 *
 * 响应体是 `{ models: ProviderModelPreview[] }`（契约 `ProviderModelPreviewListSchema`），
 * 客户端按它解出候选数组。
 */
import { previewProviderModels } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** 动态段上下文：params 是 Promise（Next 15 起） */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(_req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    return Response.json({ models: await previewProviderModels(providerId) });
  } catch (error) {
    return handleApiError(error);
  }
}
