/**
 * 行级 SSE 产出：把 `events.jsonl`（或评分那条 `judge-events.jsonl`）的历史回放 + 进程内事件总线
 * 扇出成 SSE 帧。三条口径：
 *   1. **只用 Web 标准类型**（`ReadableStream` / `Uint8Array` / `TextEncoder`）——api 禁框架，
 *      这里连 `Response` 都不组装，响应头由路由层负责；
 *   2. 帧格式写死为 `id: <seq>` + `event: <type>` + `data: <JSON>` + 空行：`id` 是浏览器
 *      `Last-Event-ID` 的唯一来源，缺了它断线重连只能从头再来；
 *   3. 回放里出现终态就**立即关流**：已经跑完的行不该让浏览器挂着一条永不结束的连接。
 *
 * **两条流共用这一份实现**：候选那条（`streamRowEvents`）与评分那条
 * （`streamJudgeEvents`）只差「读历史的函数」与「订阅的函数」两处，所以它们收在一个 `EventChannel`
 * 里。两份实现并排写的话，去重、`: ready` 首字节、终态关流、心跳这四条里漏改一条就是
 * 「某一条流的浏览器契约悄悄不一样」——而那种差异在界面上表现为「某条流就是不刷新」。
 *
 * 回放归本函数（而不是留给浏览器）：`subscribeRowEvents` 只承诺「订阅**之后**发布的每一条都推给你」
 * （core 的 events.ts 文件头口径 2），历史只能由这一侧补——`afterSeq` 是补历史的入口，
 * 与 `Last-Event-ID` 共用同一个语义。两者的接缝按 seq 去重，服务侧不主动制造重复帧。
 * 两条流各有**自己一套 seq**（`appendEvent` 按文件续号），所以游标不许跨流复用。
 *
 * 顺序说明（`events.ts` 要求「先订阅、再读文件」）：这里读文件在开流之前、订阅在
 * `start()` 里，看起来是反的，但**两步之间没有事件循环的让出点**——读历史是同步读盘，
 * `new ReadableStream` 的 `start()` 也是同步执行，所以「读完」与「订阅上」之间不存在能插入
 * 一次 publish 的时间窗，不存在丢事件的窗口。反过来把读盘塞进 `start()` 会把
 * 「日志读不出来」从**同步抛错**变成流内的异步 error：路由层就再也给不出带原因的 JSON 错误，
 * 只剩一条刚打开就断掉的 SSE。故保留「先校验/读盘、再开流」。
 */
import { TERMINAL_ROW_STATUSES, type AgentEvent } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeJudgeEvents, subscribeRowEvents } from '@aieval/evaluator';
import { getRowJudgeLog, getRowLog } from './run-artifacts';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接 */
const HEARTBEAT_MS = 15_000;

/** 一条事件流的两个接口点（其余全在本文件的公共实现里） */
interface EventChannel {
  /** 读历史（`afterSeq` 语义由被调方保证）；同时承担「行存在性校验」的**同步**抛错 */
  history: (runId: string, rowId: string, afterSeq: number) => AgentEvent[];
  /** 订阅**后续**事件，返回退订函数 */
  subscribe: (runId: string, rowId: string, listener: (event: AgentEvent) => void) => () => void;
  /** 日志里点名这是哪条流（两条流同时开着时，日志得能分开） */
  label: string;
}

/** 候选那条：行级 `events.jsonl`（状态、计量、候选的 log 与编排层留痕） */
const ROW_EVENT_CHANNEL: EventChannel = { history: getRowLog, subscribe: subscribeRowEvents, label: '行级' };

/** 评分那条：`judge-events.jsonl`（评审者自己的流水，与行级分开） */
const JUDGE_EVENT_CHANNEL: EventChannel = { history: getRowJudgeLog, subscribe: subscribeJudgeEvents, label: '评分' };

/** 一条事件是不是「这一行已经结束」：`end` 事件与终态 `status` 事件都算 */
function isTerminalEvent(event: AgentEvent): boolean {
  if (event.type === 'end') return true;
  return event.type === 'status' && TERMINAL_ROW_STATUSES.includes(event.status);
}

/**
 * 一帧的序列化。
 * `data` 里不能出现裸换行（否则一帧会被劈成两帧），而 `JSON.stringify` 已把换行转义成 `\n`，
 * 所以单行 data 是安全的。
 */
function toFrame(event: AgentEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * 订阅一条事件流的 SSE：先回放 `seq > afterSeq` 的历史，再接进程内事件总线。
 *
 * **先读盘、再开流**（这个顺序不能动）：「评测/行不存在」由读历史那一侧的 `findRow`
 * 在开流之前**同步**抛出（`NOT_FOUND` + 同一句中文「该评测里没有这一行（rowId）」），
 * 路由层因此拿得到带原因的 404 JSON；把读盘塞进 `start()` 会把「日志读不出来」从同步抛错
 * 变成流内的异步 error，路由层就只剩一条刚打开就断掉的 SSE。
 *
 * 这里**不再**写第二份行存在性校验：读历史那一侧已经查过同一件事，同一份校验写两遍正是
 * 要避免的形状（两份判据会漂移，而漂移时先抛的那一份说了算）。
 */
function streamEvents(channel: EventChannel, runId: string, rowId: string, afterSeq: number): ReadableStream<Uint8Array> {
  const history = channel.history(runId, rowId, afterSeq);
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  /** 释放资源（幂等）：关流与取消都要走它 */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    unsubscribe?.();
    unsubscribe = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      /** 已发出帧的最大 seq：历史与实时都过这一道闸，于是接缝处不会出现重号帧 */
      let lastSeq = afterSeq;

      const close = (): void => {
        if (closed) return;
        closed = true;
        teardown();
        controller.close();
      };

      const push = (event: AgentEvent): void => {
        if (closed) return;
        // 去重按 seq（派发稿 §T3-2）：服务侧不主动制造重复——重号会让浏览器按 Last-Event-ID
        // 续订时把「已经在手上的那条」当成重复丢掉，而它其实可能是新事件
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        controller.enqueue(encoder.encode(toFrame(event)));
        if (isTerminalEvent(event)) close();
      };

      // **第一件事就是吐一个字节**（一条注释帧，客户端按 SSE 规范忽略它）：响应头要等第一次
      // `controller.enqueue` 才 flush，而空历史 + 无新事件时原本要等到 15 秒后的心跳才 flush
      // ⇒ 这段时间里浏览器不触发 `onopen`、徽标只能显示「未连接」，代理也可能把空连接当空闲回收。
      // 位置在**最前面**：「打开即有首字节」要覆盖历史为空的情况，放在历史循环之后就不成立。
      // 它只是让连接可观测，不改变帧语义——紧随其后的历史回放与订阅之间
      // 没有任何让出点（`start()` 是同步执行的，见文件头），所以不会插队也不会漏事件。
      controller.enqueue(encoder.encode(': ready\n\n'));

      for (const event of history) {
        push(event);
        if (closed) break;
      }
      // 历史里已经有终态：不订阅、不起心跳（否则浏览器会一直挂着这条连接）
      if (closed) return;

      unsubscribe = channel.subscribe(runId, rowId, push);

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('SSE 开始推送', { runId, rowId, channel: channel.label, afterSeq, replayed: history.length });
    },
    cancel() {
      // 客户端断开（关闭抽屉 / 切行）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('SSE 被客户端取消', { runId, rowId, channel: channel.label });
    },
  });
}

/** 候选那条行级事件流（`afterSeq` 由 `Last-Event-ID` 或 0 传入） */
export function streamRowEvents(runId: string, rowId: string, afterSeq: number): ReadableStream<Uint8Array> {
  return streamEvents(ROW_EVENT_CHANNEL, runId, rowId, afterSeq);
}

/**
 * 评分那条事件流。`afterSeq` 缺省 0 = 从头回放：这条流没有 `Last-Event-ID` 的
 * 接续语义（消费方是卡片活动行与离线排障，游标由它们自己按这条流的 seq 记）。
 */
export function streamJudgeEvents(runId: string, rowId: string, afterSeq = 0): ReadableStream<Uint8Array> {
  return streamEvents(JUDGE_EVENT_CHANNEL, runId, rowId, afterSeq);
}
