/**
 * 用例同步状态接口：GET 读当前状态快照（非 git 仓库 / 未配置评分智能体都只是快照里的一格中文原因，不是 500）。
 * 照 `app/api/settings/route.ts` 的三层结构：zod 校验 → 调 api → `handleApiError`。
 * 本路由没有入参，故第一层是空的，本文件只做「调 api + 错误映射」，不含任何业务逻辑。
 *
 * 单独一条路由而不是塞进设置接口：它由用例域产生（git 状态、待提交数），
 * 设置页只是它的一个消费方；塞进 `GET /api/settings` 会让「读设置」变成一次要跑 git 的请求。
 */
import { getCaseSyncStatus } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(getCaseSyncStatus());
  } catch (error) {
    return handleApiError(error);
  }
}
