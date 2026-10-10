/**
 * 单个用例接口：GET / PUT / DELETE。
 * Next 16 的动态路由上下文里 `params` 是 **Promise**，必须 await——
 * 直接读 `context.params.caseId` 拿到的是 undefined（类型上也不允许）。
 */
import { deleteCase, getCase, updateCase } from '@aieval/api';
import { CasePatchSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

/** 动态段上下文：显式声明而不是用生成的 RouteContext 全局类型，避免依赖 .next/types 的生成时机 */
interface CaseRouteContext {
  params: Promise<{ caseId: string }>;
}

export async function GET(_req: Request, context: CaseRouteContext): Promise<Response> {
  try {
    const { caseId } = await context.params;
    return Response.json(getCase(caseId));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: Request, context: CaseRouteContext): Promise<Response> {
  try {
    const { caseId } = await context.params;
    const patch = CasePatchSchema.parse(await readJsonBody(req));
    return Response.json(updateCase(caseId, patch));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_req: Request, context: CaseRouteContext): Promise<Response> {
  try {
    const { caseId } = await context.params;
    // 响应体带 affectedRuns：页面用它提示「N 个评测记录仍可查看」
    return Response.json(deleteCase(caseId));
  } catch (error) {
    return handleApiError(error);
  }
}
