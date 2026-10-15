/**
 * 追问的**可用性读侧**：`GET /api/follow-up?runId=…` —— 这一轮里每一行此刻能不能追问、
 * 不能的那一行为什么（界面入口按它给按钮的 `disabled` 与 Tooltip 文案）。
 *
 * 为什么要一条专门的读侧：七档拒绝里有一半的事实（工作区还在不在 / 用例还在不在 /
 * 这一家的声明）在盘上与厂商声明上，浏览器一格都看不到。让界面自己编一句「这一家不支持续接」
 * 就是第二份说法，而两份说法必然漂移——漂移的表现是「按钮写着能追问、点下去 409」。
 *
 * 定位走**查询参数**（照人工消息快照那一格）：它是给晚开的页面与刷新用的读侧，没有请求体可用；
 * 读的是**整轮**（一行一条结论），因为入口画在每一张候选卡片上，逐行发请求就是把一次读
 * 摊成 N 次。响应体 `{rows: [{rowId, verdict}]}` 的顺序即 `run.rows` 的顺序；轮不存在 ⇒ 404。
 *
 * ⚠️ 查询参数用**本文件**的 zod（照 `log/route.ts` 的 `LogQuerySchema`）：一对一的定位参数
 * 没有第二个消费方，放进 contracts 只会多一格没人复用的形状；**请求体**那一侧仍走 contracts
 * （`FollowUpRequestSchema`）——它是客户端与服务端共用的同一份。
 *
 * 本文件只做三件事：zod 校验、调 api、错误映射。
 */
import { z } from 'zod';
import { FollowUpAvailabilitySchema } from '@aieval/contracts';
import { getFollowUpAvailability } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** 查询参数：`runId` 必填且非空（空串要在这里收场，不让它一路走到「评测不存在」——那是两件事） */
const FollowUpQuerySchema = z.object({ runId: z.string().min(1) });

export async function GET(req: Request): Promise<Response> {
  try {
    const { runId } = FollowUpQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    // 出参也过一遍 schema（照人工消息快照那一格）：这条读侧的消费方按 `verdict` 直接说一句人话，
    // 形状漂了必须在这里响，而不是让界面渲染出一个没有原因的空 Tooltip
    return Response.json(FollowUpAvailabilitySchema.parse(getFollowUpAvailability(runId)));
  } catch (error) {
    return handleApiError(error);
  }
}
