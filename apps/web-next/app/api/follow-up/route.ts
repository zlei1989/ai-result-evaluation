/**
 * 追问：`POST /api/follow-up` —— 人给一行**已经跑过**的行补一句话，让它接着同一段会话再跑一段
 * （不重建工作区、不重置计量，跑完自动重评）。
 *
 * 形状照人工消息那一组（`/api/inject-messages`）：**定位走请求体**（`runId` / `rowId` 与正文、
 * 附件清单一起到），客户端不必为了发一句话去拼 URL，服务端也不必在路径与请求体两种来源之间做
 * 二次合并。请求体就是契约里的 `FollowUpRequestSchema`，**一格都不在这里增删**。
 *
 * 状态码全部来自 api 层（本层不重复判）：
 *   · 这一行真的接受之后回 **200 + 这一轮的快照**——与 `rescore` / `retry` 逐字相同：追问是
 *     分钟级的，HTTP 不能挂在那儿等它跑完，进度交给 SSE 与轮询；客户端要做的动作也很简单
 *     （拿快照回写详情键）；
 *   · 行不存在 / 轮不存在 ⇒ 404（客户端该去刷新）；
 *   · 请求本身不合法（空消息、附件超限、非法 JSON）⇒ 400，中文原因点名是哪一条限制；
 *   · **这一行此刻不可追问**（没会话 / 工作区没了 / 用例没了 / 附件没了 / 这一家接不上 /
 *     正在跑 / 上一次没收尾）⇒ 409，中文原因逐字透出——界面按它给 Tooltip。
 *
 * 本文件只做三件事：zod 校验、调 api、错误映射。
 */
import { FollowUpRequestSchema } from '@aieval/contracts';
import { followUpRow } from '@aieval/api';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = FollowUpRequestSchema.parse(await readJsonBody(req));
    return Response.json(followUpRow(body));
  } catch (error) {
    return handleApiError(error);
  }
}
