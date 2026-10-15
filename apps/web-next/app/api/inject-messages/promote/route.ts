/**
 * 改期（「立即发送」）：`POST /api/inject-messages/promote`。
 *
 * 语义是**单向**的：把这一条的要求由「排队」改成「立即」（只能变早，不能变晚）——
 * 把已经要求「立即」的那条改回「排队」会让它比用户按下按钮之前更晚到，那不是任何人的意图。
 * 只对还没取走的条目可用：交出去之后边界已经用掉了。
 *
 * 状态码全部来自 api 层：改成功 / 本来就要求立即发送 ⇒ 200（两种结局在响应体的 `outcome` 里分），
 * 交出去之后改不了 ⇒ 409，没有这个 `messageId` ⇒ 404。请求体不合法 ⇒ 400。
 */
import { InjectMessageRefSchema } from '@aieval/contracts';
import { promoteInjectMessage } from '@aieval/api';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const ref = InjectMessageRefSchema.parse(await readJsonBody(req));
    return Response.json(promoteInjectMessage(ref));
  } catch (error) {
    return handleApiError(error);
  }
}
