/**
 * 用例同步动作接口：POST `{ action: 'commit' | 'pull' }` → 跑完一轮同步后回最新状态快照。
 * 照 `app/api/settings/route.ts` 的三层结构：zod 校验 → 调 api → `handleApiError`，本文件不含业务逻辑。
 *
 * 响应是**跑完之后**的快照（`runCaseSync` 服务端就是这么设计的）：按钮的 loading 与结果提示
 * 都靠这一个 Promise 收口，故这里必须 await，不能起个后台任务就返回。
 * 失败（例如未配置评分智能体、拉取时有未提交变更）会被服务端折成 ServiceError，交给 `handleApiError` 出中文原因。
 */
import { runCaseSync } from '@aieval/api';
import { CaseSyncActionSchema } from '@aieval/contracts';
import { z } from 'zod';
import { handleApiError, readJsonBody } from '@/src/server-context';

/**
 * 请求体形状 `{ action }`。刻意只写在本文件：契约导出的只有**动作枚举**（`CaseSyncActionSchema`），
 * 整份请求体是这条路由的入参形状，不是跨端共享的领域类型。
 *
 * 为什么是把枚举包一层而不是 `CaseSyncActionSchema.parse(body)`：请求体本来就是 `{ action }` 这个对象，
 * 直接拿枚举去 parse 会把**每一个合法请求**都判成非法。包一层还顺带把边界情况收干净——
 * `null` / 数组 / 缺字段都折成 400 + 指向 `action` 的 issues，而不是 `body.action` 的 TypeError（500）。
 */
const CaseSyncRequestSchema = z.object({ action: CaseSyncActionSchema });

export async function POST(req: Request): Promise<Response> {
  try {
    const { action } = CaseSyncRequestSchema.parse(await readJsonBody(req));
    return Response.json(await runCaseSync(action));
  } catch (error) {
    return handleApiError(error);
  }
}
