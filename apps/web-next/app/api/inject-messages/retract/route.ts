/**
 * 撤回一条人工消息：`POST /api/inject-messages/retract`。
 *
 * **撤回与「删除未投递项」是同一个端点**：界面只有一个「删除」按钮，服务端按那一条当前的状态分派
 * （还在我们表里 ⇒ 摘掉；已经交给厂商 ⇒ 走这一家的撤回面；已经被模型吃掉 ⇒ 明确拒绝）。
 * 拆成两个动作等于把服务端的真相复制一份到客户端，两份必然漂。
 *
 * 状态码全部来自 api 层（本层不重复判）：
 *   · `removed` / `retracted` ⇒ 200；
 *   · 重复撤回（`gone`）⇒ 200 + `already-retracted`（**不是 404**——`gone` 留在表里正是为了让
 *     「已经处理过了」与「这个 id 从没存在过」分得开，而两者的客户端动作相反）；
 *   · 不在表里 ⇒ 404；
 *   · 已被模型吃掉 / 这一家不支持按条撤回 / 结果说不清 ⇒ 409 + 各自的中文原因。
 *
 * `messageId` 走请求体而不是路径：它不是资源的层级标识（那一条属于哪一轮哪一行已经在服务端的表里）。
 */
import { InjectMessageRefSchema } from '@aieval/contracts';
import { retractInjectMessage } from '@aieval/api';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const ref = InjectMessageRefSchema.parse(await readJsonBody(req));
    return Response.json(await retractInjectMessage(ref));
  } catch (error) {
    return handleApiError(error);
  }
}
