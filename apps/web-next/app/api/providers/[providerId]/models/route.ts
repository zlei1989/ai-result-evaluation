/**
 * 供应商的模型清单：POST 加一条 / DELETE 删一条（模型名走 query，见契约 §9）。
 * 本文件只做「zod 校验 → 调 api → 错误映射」，不含业务逻辑。
 *
 * 三个口径：
 *   1. 请求体里的 `source` 只用于过契约校验，落盘来源由服务端固定为 `manual`（见 api/providers.ts）；
 *   2. **响应体是 `ProviderView`，不是 `{ ok: true }`**：客户端把这两个接口的 `res.json()` 直接当
 *      `ProviderView` 解析（client/src/providers.ts），回 `{ ok: true }` 会让每次模型增删都在
 *      客户端炸掉。`{ ok: true }` 只属于供应商 DELETE 那条路由；
 *   3. 用 `new URL(req.url).searchParams` 取模型名（而不是 `req.nextUrl`）：两者在 Next 运行时等价，
 *      但前者对测试里的普通 `Request` 同样成立，测试不必构造 NextRequest。
 */
import { addProviderModel, removeProviderModel, setProviderModelContext } from '@aieval/api';
import { ProviderModelContextSchema, ProviderModelInputSchema, ServiceError } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：params 是 Promise（Next 15 起） */
interface ProviderRouteContext {
  params: Promise<{ providerId: string }>;
}

export async function POST(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const { id } = ProviderModelInputSchema.parse(await readJsonBody(req));
    return Response.json(addProviderModel(providerId, id));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    // searchParams 会把 %2F / %2B / %23 解回 / + #：客户端按 encodeURIComponent 传参（Task 3）
    const modelId = new URL(req.url).searchParams.get('modelId');
    if (modelId === null || modelId === '') {
      throw new ServiceError('INVALID_QUERY', '缺少查询参数 modelId');
    }
    return Response.json(removeProviderModel(providerId, modelId));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * PUT：设置单条模型的窗口（设置页的行内编辑器）。用 PUT 而不是 PATCH，是为了复用客户端既有的
 * `putJson`（本包 http 原语里没有 patch 形态），语义上也成立：这一次调用**完整**表达了该条模型
 * 的能力两格（给了就是给了，null 就是清空）。
 */
export async function PUT(req: Request, ctx: ProviderRouteContext): Promise<Response> {
  try {
    const { providerId } = await ctx.params;
    const input = ProviderModelContextSchema.parse(await readJsonBody(req));
    return Response.json(setProviderModelContext(providerId, input));
  } catch (error) {
    return handleApiError(error);
  }
}
