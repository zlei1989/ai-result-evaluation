/**
 * 回到某一轮：`POST /api/checkpoint` —— 把这一行某一点之后的旧内容标作废，并从这一点接着跑一段
 * （不重建工作区；工作区文件是否回退由厂商能力声明说，本接口不改文件）。
 *
 * 形状照追问（`/api/follow-up`）：**定位走请求体**，请求体就是契约里的 `CheckpointRequestSchema`，
 * 本文件只做三件事：zod 校验、调 api、错误映射。
 *
 * 状态码全部来自 api 层：200 + 快照（续跑进行中）；404（行不存在）；
 * 400（空消息 / 附件超限 / 非法 JSON）；409（这一家不支持 / 这一行此刻不能续跑）。
 */
import { CheckpointRequestSchema } from '@aieval/contracts';
import { checkpointRow } from '@aieval/api';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = CheckpointRequestSchema.parse(await readJsonBody(req));
    return Response.json(checkpointRow(body));
  } catch (error) {
    return handleApiError(error);
  }
}
