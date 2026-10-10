/**
 * 测试连接：`POST /api/settings/mcp/test`，body 二选一 `{ name }`（已保存的那份）
 * 或 `{ entry }`（表单当前值、**不落盘**），回同一形状的 `McpProbeResult`。
 *
 * 本文件只做「zod 校验 → 调 api → 错误映射」，与 `app/api/settings/route.ts` 同形。
 * 探活失败（连不上 / 404 / key 无效）**不是** HTTP 错误：服务层以 `{ ok: false, failure }` 返回，
 * 路由照旧 200 —— 折成 4xx/5xx 会让客户端把一次正常的探测当成系统故障，
 * 拿不到「厂商原文」那一段（`client/src/http.ts` 只把错误码与 message 带回去）。
 */
import { probeMcpServer } from '@aieval/api';
import { McpProbeRequestSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const request = McpProbeRequestSchema.parse(await readJsonBody(req));
    return Response.json(await probeMcpServer(request));
  } catch (error) {
    return handleApiError(error);
  }
}
