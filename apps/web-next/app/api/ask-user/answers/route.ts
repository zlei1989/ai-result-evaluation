/**
 * 应答提交：`POST /api/ask-user/answers`，应答面的**唯一写入口**。
 *
 * 路由只做三件事：zod 校验请求体、调 api、错误映射（`handleApiError` 按 `ServiceError.code` 出状态码）。
 * `askId` 走**请求体**而不是路径：它不是资源的层级标识（这一问属于哪一轮哪一行已经在服务端的表里），
 * 放进路径只会让客户端为了拼一个 URL 去读一遍快照。
 *
 * 三条状态码的来源都在挂起表（本层不重复判）：
 *   · 首个应答 ⇒ 200；
 *   · 同一 `askId` 的第二份提交 ⇒ `CONFLICT` ⇒ 409；
 *   · 未知 / 已取消 / 服务重启过的 `askId` ⇒ `NOT_FOUND` ⇒ 404。
 */
import { AskUserAnswerRequestSchema } from '@aieval/contracts';
import { answerAskUser } from '@aieval/api';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = AskUserAnswerRequestSchema.parse(await readJsonBody(req));
    return Response.json(answerAskUser(body.askId, body.answers));
  } catch (error) {
    return handleApiError(error);
  }
}
