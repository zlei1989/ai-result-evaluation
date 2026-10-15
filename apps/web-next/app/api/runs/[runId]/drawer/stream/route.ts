/**
 * 抽屉流 SSE：`GET /api/runs/[runId]/drawer/stream?rowId=<id>&rowChannel=<candidate|judge>[&afterSeq=N]`。
 *
 * 一条连接承载「一行 × 一个 channel」的完整流水：该族的事件（按 seq 续订）+ 该族的消息（全量回放），
 * 事件侧遇到终态由服务端关流。两个抽屉各自开自己 channel 的那一条。
 *
 * 四处必须写死的口径：
 *   1. **`rowChannel` 与 `rowId` 都是必填**：`rowChannel` 走 contracts 的 `DrawerChannelSchema`
 *      白名单（值域仍是 `DRAWER_CHANNELS`），非法值或缺参一律 400——静默空流会让调用方以为
 *      「连上了、只是没内容」，默认成候选更是把评分抽屉的日志混进执行日志；
 *      参数名与信封的归属格、客户端的连接键共用 `rowChannel` 一个词（`channel` 这个名字被
 *      `ask-user` 事件的业务字段占着，见 `contracts/src/run-stream.ts`）；
 *   2. **响应头三件套**：`text/event-stream` + `cache-control: no-cache` + `connection: keep-alive`
 *      + `X-Accel-Buffering: no`（最后一条是给反向代理的：它默认会把 SSE 缓冲起来，
 *      表现是「事件全对，但要等连接结束才一起到」）；
 *   3. **`afterSeq` 的来源优先级**：`Last-Event-ID` 头 > `?afterSeq=`。浏览器自动重连时**只发头、
 *      不发 query**，而 query 里带的是首连那一刻的 seq——优先用头才能不重不漏；头的值非法就忽略。
 *      （只有事件帧写 `id:` 行，所以这个头天然只反映事件那一侧的进度，消息帧不会把它带偏。）
 *   4. **`runtime = 'nodejs'`**：事件与记录两条总线都是**进程内**的，换到别的 runtime 会连不上编排层。
 */
import { z } from 'zod';
import { DrawerChannelSchema } from '@aieval/contracts';
import { streamDrawer } from '@aieval/api';
import { handleApiError } from '@/src/server-context';

/** SSE 是长连接，不能被当成静态资源处理 */
export const dynamic = 'force-dynamic';
/** 进程内事件/记录总线：必须与编排层同进程 */
export const runtime = 'nodejs';

/**
 * 查询参数：两个定位参数都必填。
 * `channel` 用 contracts 的白名单 schema（值域只有一份，客户端与服务端不会各写一份枚举）；
 * `rowId` 只要非空——格式校验（轮/行存不存在）归 api 那一侧的 `findRow`，它的错是 404 不是 400。
 */
const DrawerStreamQuerySchema = z.object({
  rowId: z.string().min(1),
  rowChannel: DrawerChannelSchema,
});

/** 续订起点：优先 `Last-Event-ID`（浏览器重连只发这个头），非法值忽略并回落到 query */
function resolveAfterSeq(req: Request): number {
  const header = req.headers.get('last-event-id');
  if (header !== null) {
    const parsed = Number.parseInt(header, 10);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  const raw = new URL(req.url).searchParams.get('afterSeq');
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    const { rowId, rowChannel } = DrawerStreamQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    // 校验在开流之前完成：轮/行不存在（或参数不合法）时返回 JSON，而不是一个开了就结束的 SSE 流
    const stream = streamDrawer(runId, rowId, rowChannel, resolveAfterSeq(req));
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
