/**
 * 抽屉流的 SSE 产出：**单个候选单 channel 的完整流水**——该族的事件（seq 回放 + 总线续订 + 终态关流）
 * 与该族的消息（全量回放 + 总线续订 + 16ms 增量合并）由**一条连接**承载。
 *
 * 为什么合成一条：这两条通道读的是同一候选的同一族产物、同生共死（抽屉一关一起断），
 * 分开写就是每个抽屉两条长连接、浏览器侧两次事件派发与两轮 `setState`。
 *
 * **两族差异收在一张 channel 表里**（读历史的函数、水位函数、两个订阅函数），公共实现只写一份
 * ——照 `run-stream.ts` / `messages-stream.ts` 既有的形状。两份实现并排写的话，
 * `id:` 帧头、`: ready` 首字节、心跳、终态关流、增量合并这五条里漏改一条就是
 * 「某个抽屉的浏览器契约悄悄不一样」，而那种差异在界面上只表现为「某个抽屉就是不刷新」。
 *
 * 五条不能混的口径：
 *   1. **帧头分轨**：事件帧写 `id: <seq>`（浏览器 `Last-Event-ID` 的唯一来源），消息帧**不写**
 *      ——`messageId` 由适配器分配、跨运行重号，且 `delta` 覆盖使历史可变，按 seq 续订对一份
 *      会变的历史没有意义；设了帧头浏览器重连就会带一个我们解释不了的值（少一段历史且不报错）。
 *   2. **事件按 seq 续订、消息每次全量回放**：游标只对事件那一侧有意义，消息靠客户端按
 *      `messageId` 去重 / `mergeKey` 覆盖累积。
 *   3. **终态只由事件那一侧触发**（`end` 或终态 `status` ⇒ 关流）：消息侧从不触发关流
 *      ——靠终态关流会让「打开一个跑完的候选的对话视图」立刻断连，而那份历史正是要看的东西。
 *   4. **消息先回放、事件后回放**：终态一到就关流，事件若排在前面会把消息回放整段吞掉
 *      （见口径 3 的同一件事）。两条回放都在 `start()` 里同步发生，中间没有让出点。
 *   5. **游标只在同一世代内有意义**：同一行重跑会 `resetEvents` 删文件、`seq` 从 1 重新发号，
 *      于是「不按游标回放」与「按 seq 去重」各自都要认一次换代，判据是同一条——**游标超过
 *      当前水位即上一代**。少了前者，重连拿不到新一代的历史；少了后者，一直开着的那条连接
 *      会把新一代的 `1..k` 整段吃掉（连接活着、心跳照发，界面上只是「日志一条都不动」）。
 *
 * **回放归本函数**（不留给浏览器）：`subscribeCandidateEvents` / `subscribeCandidateRecords` 只承诺
 * 「订阅**之后**发布的每一条都推给你」，历史只能由这一侧补；`afterSeq` 与 `Last-Event-ID`
 * 共用同一个语义，接缝处按 seq 去重，服务侧不主动制造重复帧。
 *
 * **先读盘、再开流**（顺序不能动）：「评测/行不存在」由读历史那一侧的 `findCandidate` 在开流之前
 * **同步**抛出（`NOT_FOUND` + 同一句中文「该评测里没有这个候选（candidateId）」），路由层因此拿得到
 * 带原因的 404 JSON；把读盘塞进 `start()` 会把「读不出来」从同步抛错变成流内的异步 error，
 * 路由层就只剩一条刚打开就断掉的 SSE。两族的历史都在开流前读，校验也只有一份。
 */
import {
  TERMINAL_CANDIDATE_STATUSES,
  type AgentEvent,
  type AgentMessage,
  type DrawerChannel,
  type CandidateChannelEventFrame,
  type CandidateChannelMessageFrame,
  type CandidateRecord,
  type SubagentRecord,
} from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeJudgeEvents, subscribeJudgeRecords, subscribeCandidateEvents, subscribeCandidateRecords } from '@aieval/evaluator';
import { createDeltaCoalescer } from './messages-stream';
import {
  getCandidateJudgeLog,
  getCandidateJudgeLogMaxSeq,
  getCandidateJudgeRecords,
  getCandidateLog,
  getCandidateLogMaxSeq,
  getCandidateRecords,
} from './run-artifacts';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（两条既有通道共用同一个值） */
const HEARTBEAT_MS = 15_000;

/** 消息历史的形状（两条 channel 的读历史返回同一份折叠视图） */
interface RecordsPayload {
  messages: AgentMessage[];
  subagents: SubagentRecord[];
}

/** 一条 channel 的五个接口点（其余全在本文件的公共实现里） */
interface DrawerChannelSource {
  /** 读事件历史（`afterSeq` 语义由被调方保证）；同时承担「行存在性校验」的**同步**抛错 */
  eventHistory: (runId: string, candidateId: string, afterSeq: number) => AgentEvent[];
  /** 这条流当前落盘事件的 **seq 水位**（文件里已用过的最大 seq）：续订入口据此判「游标是不是上一代的」 */
  eventMaxSeq: (runId: string, candidateId: string) => number;
  /** 订阅**后续**事件，返回退订函数 */
  subscribeEvents: (runId: string, candidateId: string, listener: (event: AgentEvent) => void) => () => void;
  /** 读消息全量（同时承担行存在性校验的**同步**抛错）：返回折叠后的视图 */
  records: (runId: string, candidateId: string) => RecordsPayload;
  /** 订阅**后续**记录，返回退订函数 */
  subscribeRecords: (runId: string, candidateId: string, listener: (record: CandidateRecord) => void) => () => void;
  /** 日志里点名这是哪一族（两个抽屉同时开着时，日志得能分开） */
  label: string;
}

/** 候选那条：`events.jsonl` + `messages.jsonl`（执行日志抽屉） */
const CANDIDATE_SOURCE: DrawerChannelSource = {
  eventHistory: getCandidateLog,
  eventMaxSeq: getCandidateLogMaxSeq,
  subscribeEvents: subscribeCandidateEvents,
  records: getCandidateRecords,
  subscribeRecords: subscribeCandidateRecords,
  label: '候选',
};

/** 评分那条：`judge-events.jsonl` + `judge-messages.jsonl`（评审者是另一个会话，文件也各是各的） */
const JUDGE_SOURCE: DrawerChannelSource = {
  eventHistory: getCandidateJudgeLog,
  eventMaxSeq: getCandidateJudgeLogMaxSeq,
  subscribeEvents: subscribeJudgeEvents,
  records: getCandidateJudgeRecords,
  subscribeRecords: subscribeJudgeRecords,
  label: '评分',
};

/**
 * channel → 它那一族。表是**唯一一份**值域映射（`DrawerChannelSchema` 管取值，这里管读哪一族），
 * 键取全了才会通过类型检查：漏一族是编译期错误，而不是「某个抽屉连上却永不刷新」。
 */
const CHANNEL_SOURCES: Record<DrawerChannel, DrawerChannelSource> = {
  candidate: CANDIDATE_SOURCE,
  judge: JUDGE_SOURCE,
};

/** 一条事件是不是「这个候选已经结束」：`end` 事件与终态 `status` 事件都算（与候选级流同一口径） */
function isTerminalEvent(event: AgentEvent): boolean {
  if (event.type === 'end') return true;
  return event.type === 'status' && TERMINAL_CANDIDATE_STATUSES.includes(event.status);
}

/**
 * 事件帧：`id: <seq>` + `event: <type>` + 信封载荷。
 * 载荷只做一次展开（`{ ...event, candidateId, candidateChannel }`），字段清单由 contracts 的
 * `CandidateChannelEventFrame` 兜住——不手抄第二份，上游加一格时这里自动跟随。
 * `data` 里不能出现裸换行（否则一帧会被劈成两帧），而 `JSON.stringify` 已把换行转义成 `\n`。
 */
function toEventFrame(event: AgentEvent, candidateId: string, candidateChannel: DrawerChannel): string {
  const frame: CandidateChannelEventFrame = { ...event, candidateId, candidateChannel };
  return `id: ${frame.seq}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * 消息帧：只有 `event:` 与 `data:` 两个候选，**没有 `id:` 行**（见文件头口径 1）。
 * `event` 名取记录的 `type`（`message` / `subagent`），消费方因此可以在浏览器侧按事件名分流。
 */
function toMessageFrame(record: CandidateRecord, candidateId: string, candidateChannel: DrawerChannel): string {
  const frame: CandidateChannelMessageFrame = { ...record, candidateId, candidateChannel };
  return `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * 订阅一条抽屉流：先回放该 channel 的消息全量，再回放 `seq > afterSeq` 的事件并与总线续订，
 * 事件侧遇到终态即关流。
 *
 * `channel` 由路由层用 `DrawerChannelSchema` 校验过——这一侧拿到的是**已收窄的类型**，
 * 不再写第二份白名单（两份判据会漂移，而漂移时先抛的那一份说了算）。
 */
export function streamDrawer(
  runId: string,
  candidateId: string,
  candidateChannel: DrawerChannel,
  afterSeq: number,
): ReadableStream<Uint8Array> {
  const source = CHANNEL_SOURCES[candidateChannel];
  /**
   * 续订游标**只在同一世代内有意义**：同一行重跑会 `resetEvents` 删掉文件、seq 从 1 重新发号，
   * 而客户端手里的 `afterSeq` / `Last-Event-ID` 是它见过的最大 seq——那个号在新一代里根本不存在。
   * 判据是「游标超过当前水位」，超了就按从头回放处理；否则这条连接会拿着旧游标去回放新一代的日志，
   * 回放结果恒为空（症状是「重连之后执行日志一直是空的」）。
   *
   * 水位这一侧同样会 `findCandidate`（与 `eventHistory` 同一份校验，不另写一份）：行不存在时仍然在这里
   * **同步**抛出。消息那一侧的 `records` 也读同一个 `findCandidate`，两族的存在性因此不可能漂移。
   */
  const cursor = afterSeq > source.eventMaxSeq(runId, candidateId) ? 0 : afterSeq;
  const eventHistory = source.eventHistory(runId, candidateId, cursor);
  const records = source.records(runId, candidateId);
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribeEvents: (() => void) | null = null;
  let unsubscribeRecords: (() => void) | null = null;
  /** `start()` 才拿得到 controller，而写帧与拆除都在它外面 ⇒ 留一个可空引用（开流前为 null） */
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** 出口观测（DEBUG 才打印）：帧数与字节数是「抽屉卡不卡」的第一手判据 */
  let frames = 0;
  let bytes = 0;

  /** 真正写消息帧的唯一出口：帧数与字节数只在这里数 */
  const emit = (record: CandidateRecord): void => {
    if (closed || sink === null) return;
    const frame = toMessageFrame(record, candidateId, candidateChannel);
    frames += 1;
    bytes += frame.length;
    sink.enqueue(encoder.encode(frame));
  };

  /** 增量帧的出口合并（消息那一侧专有：一段 n 个 token 的回复按 token 发帧就是 O(n²) 字节） */
  const coalescer = createDeltaCoalescer(emit);

  /** 释放资源（幂等）：关流与取消都要走它 */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    coalescer.dispose();
    unsubscribeEvents?.();
    unsubscribeEvents = null;
    unsubscribeRecords?.();
    unsubscribeRecords = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      /** 已发出事件帧的最大 seq：历史与实时都过这一道闸，于是接缝处不会出现重号帧。起点取 `cursor` 而不是调用方给的游标 */
      let lastSeq = cursor;

      const close = (): void => {
        if (closed) return;
        closed = true;
        teardown();
        controller.close();
      };

      const pushEvent = (event: AgentEvent): void => {
        if (closed) return;
        /**
         * 去重按 seq：服务侧不主动制造重复——重号会让浏览器按 `Last-Event-ID` 续订时把
         * 「已经在手上的那条」当成重复丢掉，而它其实可能是新事件。
         *
         * **唯一的口子是「换代」**：判据是「游标**超过**当前水位」而不是「seq 回到 1」——
         * 后者会把同一世代里重复推来的第一条（`seq === 1` 的边界重叠）也当成换代，
         * 凭空多发一帧、还会让客户端把已收内容整批清掉。水位这一读只在真走到这一步时才发生。
         */
        if (event.seq <= lastSeq) {
          if (event.seq !== 1 || lastSeq <= source.eventMaxSeq(runId, candidateId)) return;
          lastSeq = 0;
          log.debug('抽屉流的事件日志已换代（同一行重跑），续订游标重新起算', { runId, candidateId, candidateChannel });
        }
        // 终态：**先把出口窗口里待发的增量冲出去再成帧**。关流会 `dispose()` 掉窗口，而窗口里
        // 那一条是这段正文的末条（不是被覆盖的中间态），丢掉就是「界面上少一段正文」
        if (isTerminalEvent(event)) coalescer.flush();
        lastSeq = event.seq;
        const frame = toEventFrame(event, candidateId, candidateChannel);
        frames += 1;
        bytes += frame.length;
        controller.enqueue(encoder.encode(frame));
        if (isTerminalEvent(event)) close();
      };

      const pushRecord = (record: CandidateRecord): void => {
        if (closed) return;
        coalescer.push(record);
      };

      // **第一件事就是吐一个字节**（一条注释帧，客户端按 SSE 规范忽略它）：响应头要等第一次
      // `controller.enqueue` 才 flush，而空历史 + 无新事件时原本要等到 15 秒后的心跳才 flush
      // ⇒ 这段时间里浏览器不触发 `onopen`、连接状态只能停在「离线未连接」，代理也可能把空连接当空闲回收。
      // 它只是让连接可观测，不改变帧语义。
      controller.enqueue(encoder.encode(': ready\n\n'));

      /**
       * 消息：**先订阅再回放**（顺序与事件那一侧相反，这里安全且必要）。
       * 安全：`start()` 是同步执行的，回放与订阅之间没有事件循环的让出点，不存在丢记录的时间窗。
       * 必要：订阅在前，回放期间到达的新记录**也在同一条流里**，客户端按 `messageId` 去重即可。
       */
      unsubscribeRecords = source.subscribeRecords(runId, candidateId, pushRecord);
      for (const message of records.messages) pushRecord({ type: 'message', message });
      for (const subagent of records.subagents) pushRecord({ type: 'subagent', subagent });

      /**
       * 事件：回放**排在消息之后**（口径 4）。历史里已有终态 ⇒ `close()` 已经跑过，
       * 这里既不订阅事件总线也不起心跳（否则浏览器会一直挂着这条连接）；
       * 消息那一条订阅由 `teardown` 一并退掉。
       */
      for (const event of eventHistory) {
        pushEvent(event);
        if (closed) return;
      }

      unsubscribeEvents = source.subscribeEvents(runId, candidateId, pushEvent);

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('抽屉 SSE 开始推送', {
        runId,
        candidateId,
        candidateChannel,
        afterSeq,
        cursor,
        replayedEvents: eventHistory.length,
        replayedMessages: records.messages.length,
        replayedSubagents: records.subagents.length,
      });
    },
    cancel() {
      // 客户端断开（关闭抽屉 / 切行 / 切 channel）：必须退订两条总线并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      log.debug('抽屉 SSE 被客户端取消', { runId, candidateId, candidateChannel, frames, bytes, coalesced: coalescer.coalescedCount });
    },
  });
}
