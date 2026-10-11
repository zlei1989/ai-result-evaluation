/**
 * 技能清单接口：GET 回当前这一份（磁盘扫描 + 停用名单合并）。
 * 与 `PUT /api/settings` 的分工：清单是**实时扫出来的**（条目不在配置里，配置里只有停用名单），
 * 故它有自己的读端点；写侧（开关）复用 `PUT /api/settings`，不为其中一块单开写路由。
 * 本文件只做「调 api → 错误映射」，不含业务逻辑。
 */
import { listSkills } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

export async function GET(): Promise<Response> {
  try {
    return Response.json(listSkills());
  } catch (error) {
    return handleApiError(error);
  }
}
