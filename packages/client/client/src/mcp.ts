/**
 * MCP 探活数据层：一个 POST，**不进 SWR 缓存**。
 *
 * 为什么不是 `useSWRMutation`：它的 key 与去重语义都是围绕「资源 + 冲突」设计的，而探活是
 * **无缓存的一次性副作用**（同一份配置连点两次也该真跑两次），且 loading 是**逐行**的
 * （表格里哪一行在测就哪一行转），不是全局 `isMutating`。行级 loading 与结果状态因此留在
 * 展示层的局部 state 里，这一层只留一个「怎么发这次请求」。
 *
 * 失败分两类，**都要如实上行**：
 *   · 探活结论（连不上 / 404 / key 无效）是 HTTP 200 + `{ ok: false, failure }`，原样返回；
 *   · 请求本身失败（配置里没这条、网络断、服务端 500）由 `postJson` 折成 `ServiceError` 抛出，
 *     调用方（展示层）把它渲染成一句中文原因。
 */
import type { McpProbeRequest, McpProbeResult } from '@aieval/contracts';
import { postJson } from './http';

/** 探活端点（与 `app/api/settings/mcp/test/route.ts` 一一对应） */
export const MCP_TEST_URL = '/api/settings/mcp/test';

/**
 * 测一次连接：`{ name }` 测已保存的那份，`{ entry }` 测表单当前值（**不落盘**）。
 * 两种入参回同一形状，调用方不必分两条路径解析。
 */
export function probeMcpServer(request: McpProbeRequest): Promise<McpProbeResult> {
  return postJson<McpProbeResult>(MCP_TEST_URL, request);
}
