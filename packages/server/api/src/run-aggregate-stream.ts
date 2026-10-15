/**
 * 聚合流的 SSE 产出：把**一轮下所有行**的实时数据收进一条连接。
 *
 * 四类帧（信封形状见 contracts 的 `run-stream.ts`，本文件不另立一份）：
 *   · **候选事件帧** `{ …AgentEvent, rowId, rowChannel: 'candidate' }` + `id: <seq>` 行：有历史、可续订；
 *   · **消息帧** `{ …RowRecord, rowId, rowChannel }`（候选与评分两条都推）**没有** `id:` 行：
 *     `messageId` 跨运行重号、`delta` 覆盖使历史可变，按 seq 续订对一份会变的历史没有意义；
 *   · 帧**不带 `event:` 名**：判别键是信封顶层的 `type`，再用 SSE 的具名事件表达一遍就是第二份会漂移的真相
 *     （客户端的 hub 只绑 `onmessage`，发具名帧等于零交付）；
 *   · 信号帧（待答 / 人工消息）不在这条流里，`run-updated` 也不在（全局流常驻，见 spec 的 Q27）。
 *
 * 五条口径：
 *   1. **逐行游标**：`cursors` 是 `rowId → seq` 的一张表（URL 上的 `?after=w-1:12,w-2:5`），
 *      表里有的行从各自 seq 之后回放；**跨行不做全局排序**——每行的折叠各算各的，跨行顺序无意义；
 *   2. **不在表里的行不回放历史、只推实时帧**：那是「刚开详情页、这一行还没有快照位置」的行；
 *   3. **消息恒实时增量、不回放历史**（与旧的 `?replay=0` 那条活动流同一条口径：消费者要的是「此刻」，
 *      而实测某行 `messages.jsonl` 4 MB，为一句文案把它读进来推过 socket 是纯浪费）；
 *   4. **不因终态关流**：一条连接承载整轮，某一行跑完不能把别行的通道一起关掉（关流只有客户端取消一种）；
 *   5. **先校验、再开流**（与行级流同一条理由）：「这一轮 / 这一行不存在」由读历史那一侧**同步**抛出
 *      （`NOT_FOUND` + 中文原因），路由层因此给得出带原因的 404 JSON，而不是一条刚打开就断的 SSE。
 *
 * 评分**事件**不在这条流里（走抽屉流）：聚合流只服务候选卡片的 tok / 轮次 / 耗时与活动行，
 * 而评审者是另一个会话、另一条文件（`judge-events.jsonl`）。消息则是两条 rowChannel 都推——
 * 活动行在评分阶段看的正是评审者那条对话。
 *
 * 换代口径与行级流**逐字相同**：同一行重跑会 `resetEvents` 删文件、seq 从 1 重新发号，
 * 而客户端手里的游标是它见过的最大 seq。判据是「游标**超过**文件水位 = 上一代」——续订时据此改为
 * 从头回放，实时帧据此把去重闸门重新起算（水位**当场读**，不能用开流那一刻的快照：文件已经被删重建过）。
 */
import type { AgentEvent, DrawerChannel, RowChannelEventFrame, RowChannelMessageFrame, RowRecord } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeRunEvents, subscribeRunJudgeRecords, subscribeRunRecords } from '@aieval/evaluator';
import { getRowLog, getRowLogMaxSeq } from './run-artifacts';
import { getRunView } from './runs';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（三条流同一个值） */
const HEARTBEAT_MS = 15_000;

/**
 * 逐行游标：`rowId → 该行已经折到的最新 seq`。表里没有的行不回放历史、只推实时帧。
 *
 * 用 `Map` 而不是普通对象：行的 id 来自 URL，普通对象上的 `constructor` / `__proto__` 这类键
 * 会让「在不在表里」这个判据当场失真（而症状是「某一行的历史静默不回放」，不报任何错）。
 */
export type RowCursors = ReadonlyMap<string, number>;

/**
 * 候选事件帧：`id:` 是浏览器 `Last-Event-ID` 的唯一来源，缺了它断线重连只能从头再来。
 * `data` 里不能出现裸换行（否则一帧会被劈成两帧），而 `JSON.stringify` 已把换行转义成 `\n`。
 */
function toEventFrame(rowId: string, rowChannel: DrawerChannel, event: AgentEvent): string {
  const frame: RowChannelEventFrame = { ...event, rowId, rowChannel };
  return `id: ${event.seq}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/** 消息帧：**刻意没有 `id:` 行**（理由见文件头），消费方按 `messageId` 去重、`mergeKey` 覆盖累积 */
function toMessageFrame(rowId: string, rowChannel: DrawerChannel, record: RowRecord): string {
  const frame: RowChannelMessageFrame = { ...record, rowId, rowChannel };
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * 订阅一轮的聚合流：先按逐行游标回放各自的历史，再接 run 级总线（候选事件 + 两条 rowChannel 的消息）。
 *
 * **先读盘、再开流**（这个顺序不能动）：读历史那一侧（`getRowLog` / `getRowLogMaxSeq`）顺带做
 * 「轮 / 行存在」的**同步**校验，路由层因此拿得到带原因的 404 JSON。两步之间没有事件循环的让出点
 * （读盘是同步的、`new ReadableStream` 的 `start()` 也是同步执行），所以不存在丢事件的窗口。
 */
export function streamRunAggregate(runId: string, cursors: RowCursors): ReadableStream<Uint8Array> {
  // 游标表为空（刚打开详情页、一行都还没读到快照）时也要校验**轮**存在：否则脏 URL 会拿到一条
  // 「开了即静默」的连接，而不是带原因的 404。
  getRunView(runId);
  /** 行 → 要回放的历史（顺序 = 游标表的顺序，跨行不排序） */
  const history = new Map<string, AgentEvent[]>();
  for (const [rowId, seq] of cursors) {
    // 水位这一读同时承担行存在性校验（NOT_FOUND 在这里同步抛出）
    const waterMark = getRowLogMaxSeq(runId, rowId);
    // 游标超过水位 ⇒ 它属于被 `resetEvents` 删掉的那一代：按从头回放处理，
    // 否则这条连接会拿着旧游标去回放新一代的日志，回放结果恒为空
    history.set(rowId, getRowLog(runId, rowId, seq > waterMark ? 0 : seq));
  }

  const encoder = new TextEncoder();
  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const unsubscribes: (() => void)[] = [];
  /** `start()` 才拿得到 controller，而三个 push 都在它外面定义 ⇒ 留一个可空引用 */
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  /**
   * 每行**已发出帧**的最大 seq：回放与实时共用这道闸门，接缝处因此不会出现重号帧。
   * 只对「回放过历史」的行设闸门（不在游标表里的行没有历史，帧一律放行）。
   */
  const sentSeq = new Map<string, number>();

  /** 释放资源（幂等）：只有客户端取消一个入口 */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };

  /** 真正写帧的唯一出口（关流后到达的实时帧直接丢） */
  const emit = (frame: string): void => {
    if (closed || sink === null) return;
    sink.enqueue(encoder.encode(frame));
  };

  /** 推一条候选事件：按该行的 seq 去重，唯一的口子是换代（判据与行级流逐字相同） */
  const pushEvent = (rowId: string, event: AgentEvent): void => {
    if (closed) return;
    const previous = sentSeq.get(rowId);
    if (previous !== undefined && event.seq <= previous) {
      // 水位**当场读**：文件可能刚被删重建过（重跑同一行），用开流那一刻的快照会漏判换代
      if (event.seq !== 1 || previous <= getRowLogMaxSeq(runId, rowId)) return;
      log.debug('事件日志已换代（同一行重跑），聚合流的续订游标重新起算', { runId, rowId });
    }
    sentSeq.set(rowId, event.seq);
    emit(toEventFrame(rowId, 'candidate', event));
  };

  /** 推一条消息：去重交给消费方（按 `messageId` / `mergeKey`），服务端一条都不许丢 */
  const pushMessage = (rowId: string, rowChannel: DrawerChannel, record: RowRecord): void => {
    if (closed) return;
    emit(toMessageFrame(rowId, rowChannel, record));
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      // **第一件事就是吐一个字节**（注释帧，客户端按 SSE 规范忽略）：响应头要等第一次
      // `controller.enqueue` 才 flush，而空历史 + 无新事件时原本要等到 15 秒后的心跳才 flush
      // ⇒ 这段时间里浏览器不触发 `onopen`、代理也可能把空连接当空闲回收。
      controller.enqueue(encoder.encode(': ready\n\n'));

      for (const [rowId, events] of history) {
        for (const event of events) pushEvent(rowId, event);
      }

      unsubscribes.push(
        subscribeRunEvents(runId, pushEvent),
        subscribeRunRecords(runId, (rowId, record) => pushMessage(rowId, 'candidate', record)),
        subscribeRunJudgeRecords(runId, (rowId, record) => pushMessage(rowId, 'judge', record)),
      );

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('聚合流开始推送', {
        runId,
        rows: [...cursors.keys()],
        replayed: [...history.values()].reduce((total, events) => total + events.length, 0),
      });
    },
    cancel() {
      // 客户端断开（关闭详情页）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('聚合流被客户端取消', { runId });
    },
  });
}
