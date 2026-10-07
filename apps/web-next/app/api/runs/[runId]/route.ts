/**
 * 单轮评测快照：GET / PUT（编辑）/ DELETE（删除）。
 * 只做「zod 校验 → 调 api → 错误映射」三件事（spec 的目录边界：路由层不写业务）。
 * Next 16 的动态路由上下文里 `params` 是 **Promise**，必须 await。
 */
import { deleteRun, getRunView, updateRun } from '@aieval/api';
import { RunUpdateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(getRunView(runId));
  } catch (error) {
    return handleApiError(error);
  }
}

/** 编辑这一轮：入参是「这一轮应当长成什么样」（可变字段全量），与用例的 PUT 逐字同形 */
export async function PUT(req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    const input = RunUpdateSchema.parse(await readJsonBody(req));
    return Response.json(updateRun(runId, input));
  } catch (error) {
    return handleApiError(error);
  }
}

/** 删除这一轮：快照 + 它的全部产物。`workspaceRemoved: false` = 磁盘回收失败（界面要如实说） */
export async function DELETE(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(deleteRun(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
