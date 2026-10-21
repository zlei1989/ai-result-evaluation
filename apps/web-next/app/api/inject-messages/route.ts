/**
 * 人工消息的**快照**（`GET`）与**发送**（`POST`），同住一条路由：两者读写的是同一份队列表，
 * 分成两条路径只会让「读侧与写侧说的不是同一件事」。
 *
 * 三处形状的由来：
 *   · **快照的定位走查询参数**（`?runId=…&candidateId=…`）：它是给晚开的页面与刷新用的读侧，
 *     没有请求体可用；
 *   · **发送的定位走请求体**（`runId` / `candidateId` / `messageId` 与正文、附件清单一起到）：
 *     真相源在服务端的队列表里，客户端不必为了发一条消息去拼 URL，服务端也不必在两种来源之间
 *     做二次合并——与应答面把 `askId` 放进请求体同一条理由；
 *   · **响应体是裸数组**（不是 `{items: […]}`）：消费方拿到就是队列本身，多包一层只为将来可能的
 *     元数据，而这一格今天不存在。
 *
 * 本文件只做三件事：zod 校验、调 api、错误映射。
 */
import { InjectMessageQuerySchema, InjectMessageSendRequestSchema } from '@aieval/contracts';
import { getInjectMessages, sendInjectMessage } from '@aieval/api';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(req: Request): Promise<Response> {
  try {
    const params = new URL(req.url).searchParams;
    // 缺席的两格给 `null`：zod 会在这一层就以 400 收场，而不是让空串一路走到「这个候选不存在」
    const query = InjectMessageQuerySchema.parse({ runId: params.get('runId'), candidateId: params.get('candidateId') });
    return Response.json(getInjectMessages(query.runId, query.candidateId));
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * 发送一条人工消息。**两种结局都回 200**：首个 200 + `created: true`，同一个 `messageId` 再发一次
 * 200 + `created: false` + 同一条（幂等，不新增、不再投递）。
 * 用 201 区分「新建成」会让客户端多一条分支，而它要做的动作在两种情形下完全一样：重读快照。
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = InjectMessageSendRequestSchema.parse(await readJsonBody(req));
    return Response.json(sendInjectMessage(body));
  } catch (error) {
    return handleApiError(error);
  }
}
