/**
 * 单个供应商：PUT 打补丁 / DELETE 删除。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 * 注意 `params` 是 Promise（Next 15 起）：必须先 await 才能拿到 providerId。
 */
import { deleteProvider, updateProvider } from '@aieval/api';
import { ProviderPatchSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：本机 Next 16.2.7 的 route.md 明确 `params` 是 Promise */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function PUT(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const patch = ProviderPatchSchema.parse(await readJsonBody(req));
    return Response.json(updateProvider(providerId, patch));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    deleteProvider(providerId);
    // 回一个 JSON 体而不是 204：客户端 delJson 走 res.json()，空体在浏览器里是 SyntaxError
    return Response.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
