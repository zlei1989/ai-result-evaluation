/**
 * 拉取上游 /models 并合并进清单。
 * 本文件只做「调 api → 错误映射」：没有请求体要校验（providerId 来自路径）。
 * 服务端会在 Anthropic 协议下直接拒绝（该协议没有 /models 接口）。
 *
 * 响应体是 `ProviderView`（客户端 fetchModels 把它当 ProviderView 解析），不是 `{ ok: true }`。
 */
import { fetchProviderModels } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** 动态段上下文：params 是 Promise（Next 15 起） */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(_req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    return Response.json(await fetchProviderModels(providerId));
  } catch (error) {
    return handleApiError(error);
  }
}
