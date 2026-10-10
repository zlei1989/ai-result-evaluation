/**
 * 行级**消息流**的 SSE 产出：把记录文件的历史回放 + 进程内记录总线扇出成 SSE 帧
 * （内容级通道，与 `run-stream.ts` 的行级事件通道**并行**）。
 *
 * 与事件通道的三处**刻意不同**（照抄那边的实现会错）：
 *   1. **没有 `Last-Event-ID` 语义**：事件按 `seq` 续订，而记录没有单调序号——`messageId` 由适配器
 *      分配（`<runId>:<seq>`），跨运行会重号，`mergeKey` 只是覆盖键。所以这里**每次都回放全量**，
 *      客户端按 `messageId` 去重、按 `mergeKey` 覆盖累积（这本来就是消费方的职责）。
 *   2. **不去重帧**：一条逻辑消息会多次投递（delta 之后是快照、块一块一块地追加），它们**都**必须
 *      发出去——每一条都是「到目前为止的完整块列表」（增量帧**也是累积值**：`MessageAssembler.ingest`
 *      每次回吐整个 carrier 的槽位，见 `agents/src/message.ts`），客户端拿最后一条即可。按内容去重
 *      会把覆盖累积需要的中间状态吃掉。
 *   3. **不因终态关流**：与事件通道相反，这里**不**订阅终态事件去关流。消息流是长连接，
 *      由客户端在抽屉关闭时取消（`cancel()`）；靠终态关流会让「打开一个跑完的行的对话视图」
 *      立刻断连，而那份历史恰恰是用户要看的东西。
 *
 * **一条例外：增量帧在出口合并**——「都发出去」这条纪律对**快照**成立、对**增量**不成立。
 * 因为帧是累积值，一段 n 个 token 的回复按 token 发帧 = 第 k 帧重发前 k 个 token ⇒ 总字节 O(n²)，
 * 而这些中间态在客户端**注定被后一条完全覆盖**（折叠只留最后一条）⇒ 逐帧发出去是纯浪费：
 * 序列化、socket 与浏览器事件循环三处都要为它付账，实测症状就是「浏览器卡死」。
 * 故增量帧按 `mergeKey` 在 16ms 窗口内**只留最后一条**（丢掉的都是被覆盖的中间态，语义零变化，
 * 判据见 `createDeltaCoalescer`）；非增量记录一到就先把待发的增量冲出去，**顺序不变**。
 *
 * **两条记录流共用这一份实现**：候选那条（`streamRowRecords`，`messages.jsonl`）
 * 与评分那条（`streamJudgeRecords`，`judge-messages.jsonl`）只差「读历史 / 校验存在 / 订阅」
 * 三处函数。分开写两份的话，合并器、`: ready` 首字节、心跳、拆除这四条里漏一条就是
 * 某条流的浏览器契约悄悄不一样。
 *
 * **`replayHistory: false`**：只做存在性校验、**不回放历史**。给的是**刷新后没有历史
 * 可言**的消费方（卡片活动行：它只要「此刻在打字的那一句」，而历史里没有 delta——增量不落盘。
 * 实测某行 `messages.jsonl` 4 MB，为一句文案把它读进来、序列化、推过 socket 是纯浪费）。
 * 注意这一档**仍然要校验行存在**：把校验一起省掉，客户端拿到就是一条「开了即静默」的连接，
 * 而不是带原因的 404。
 */
import type { AgentMessage, RowRecord, SubagentRecord } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { subscribeJudgeRecords, subscribeRowRecords } from '@aieval/evaluator';
import { assertRowExists, getRowJudgeRecords, getRowRecords } from './run-artifacts';

const log = createLogger('runs');

/** 保活间隔：反向代理与浏览器都会掐掉长时间静默的连接（与事件通道同一个值） */
const HEARTBEAT_MS = 15_000;

/**
 * 增量帧的合并窗口（毫秒）：**对齐浏览器的一帧**（16ms ≈ 60fps）。
 *
 * 为什么是这个数：客户端在 `useRowMessages` 里按 `requestAnimationFrame` 合并提交（至多一帧一次），
 * 所以比一帧更细的窗口在浏览器侧**看不出区别**，只会多花传输；更大（50/100ms）则肉眼开始能感到
 * 一串一串地跳。这一格是「观感」与「字节数」之间的唯一旋钮，改它前先读上面文件头那段 O(n²)。
 */
export const DELTA_COALESCE_MS = 16;

export interface DeltaCoalescer {
  /** 吃进一条记录：增量帧按 `mergeKey` 只留最后一条，其余记录先冲增量再原样交出去 */
  push(record: RowRecord): void;
  /** 把待发的增量帧立刻交出去（顺序 = 各 `mergeKey` 首次进窗口的顺序） */
  flush(): void;
  /** 累计被合并掉（从未发出）的增量帧数：D11 的观测量，也是「丢的是被覆盖的中间态」的判据 */
  readonly coalescedCount: number;
  /** 释放定时器并丢弃待发帧（客户端已断开，再发没有意义） */
  dispose(): void;
}

/**
 * 增量帧的**出口合并器**（`streamRowRecords` 用，导出是为了可单测：这是全仓唯一一处
 * 「故意不发某条记录」的地方，错一次的表现是「界面上少了一段正文」）。
 *
 * 三条不变量（用例逐个钉住）：
 *   ① **只合并增量**——`chunk !== 'delta'` 的记录（含全部快照）一条都不许丢、也不许延迟到窗口之后：
 *      非增量记录一到就 `flush()`，所以同一条流的先后顺序**逐字保持不变**；
 *   ② **丢的必须是被覆盖的中间态**——同一 `mergeKey` 的新增量覆盖旧的（键相同才丢），不同键各自留着；
 *   ③ **窗口到点必发**——定时器不是「有流量才动」：静默 16ms 后剩下的最后一条一定会出去，
 *      否则光标会停在半路（这正是不许用「等下一次记录」代替定时器的原因）。
 */
export function createDeltaCoalescer(emit: (record: RowRecord) => void, windowMs = DELTA_COALESCE_MS): DeltaCoalescer {
  /** `mergeKey` → 窗口内该键的最新一条增量帧；`Map 的插入顺序就是首次进窗口的顺序 */
  const pending = new Map<string, RowRecord>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let coalescedCount = 0;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    for (const record of batch) emit(record);
  };

  return {
    get coalescedCount(): number {
      return coalescedCount;
    },
    push(record) {
      // 只有「消息 + 增量」进窗口；子任务行与快照一律即时发（不变量 ①）
      if (record.type !== 'message' || record.message.chunk !== 'delta') {
        flush();
        emit(record);
        return;
      }
      // 同一键上已有待发帧 ⇒ 它马上会被这一条覆盖，丢掉它（不变量 ②）
      if (pending.has(record.message.mergeKey)) coalescedCount += 1;
      pending.set(record.message.mergeKey, record);
      if (timer === null) timer = setTimeout(flush, windowMs); // 不变量 ③
    },
    flush,
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}

/**
 * 一帧的序列化。
 * `event` 名取记录的 `type`（`message` / `subagent`），消费方因此可以在浏览器侧按事件名分流，
 * 而不必先解析 `data`。SSE 的 `data` 里不能出现裸换行，而 `JSON.stringify` 已把换行转义成 `\n`。
 */
function toFrame(record: RowRecord): string {
  return `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`;
}

/** 回放形状（两条记录流的读历史返回同一份） */
interface RowsPayload {
  messages: AgentMessage[];
  subagents: SubagentRecord[];
}

/** 一条记录流的三个接口点（其余全在本文件的公共实现里） */
interface RecordChannel {
  /** 一次性读全量（同时承担行存在性校验的**同步**抛错） */
  history: (runId: string, rowId: string) => RowsPayload;
  /** 只校验行存在（`replayHistory: false` 那一档用它，免得为一句文案把 4 MB 读进来） */
  assertExists: (runId: string, rowId: string) => void;
  subscribe: (runId: string, rowId: string, listener: (record: RowRecord) => void) => () => void;
  /** 日志里点名这是哪条流 */
  label: string;
}

/** 候选那条：`messages.jsonl`（执行日志抽屉的对话与派发视图） */
const ROW_RECORD_CHANNEL: RecordChannel = {
  history: getRowRecords,
  assertExists: assertRowExists,
  subscribe: subscribeRowRecords,
  label: '候选',
};

/** 评分那条：`judge-messages.jsonl`（评审者自己的对话，与执行日志分开） */
const JUDGE_RECORD_CHANNEL: RecordChannel = {
  history: getRowJudgeRecords,
  assertExists: assertRowExists,
  subscribe: subscribeJudgeRecords,
  label: '评分',
};

export interface RecordStreamOptions {
  /**
   * 回放历史（缺省 `true`，即既有行为）。`false` = 只校验行存在、从「此刻之后」开始推——
   * 给卡片活动行那条连接用（见文件头那一档的说明）。
   */
  replayHistory?: boolean;
}

/**
 * 订阅一条记录流的 SSE。
 *
 * **先读盘、再开流**（这个顺序与事件通道同一条理由）：「评测/行不存在」由读历史（或只校验）
 * 在开流之前**同步**抛出（`NOT_FOUND` + 同一句中文），路由层因此拿得到带原因的 404 JSON；
 * 把读盘塞进 `start()` 会把「记录读不出来」从同步抛错变成流内的异步 error，路由层就只剩一条
 * 刚打开就断掉的 SSE。
 */
function streamRecords(
  channel: RecordChannel,
  runId: string,
  rowId: string,
  options: RecordStreamOptions,
): ReadableStream<Uint8Array> {
  // 存在性校验 + 历史一并取到（同步抛错的那一步必须在开流之前，见函数头）。
  // 不回放那一档只校验、不读文件：`messages.jsonl` 实测能到 4 MB，读它只为了丢掉的帧不划算。
  const replay = options.replayHistory ?? true;
  const history = replay ? channel.history(runId, rowId) : null;
  if (history === null) channel.assertExists(runId, rowId);
  const encoder = new TextEncoder();

  // 这几个状态放流外：`cancel` 与 `start` 都要能碰到同一份，否则客户端断开时定时器与订阅会漏
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  /** `start()` 才拿得到 controller，而写帧与拆除都在它外面 ⇒ 留一个可空引用（开流前为 null） */
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** 出口观测（D11：卡顿时第一件事就是量这两个数；DEBUG 打开才打印，不落 WARN） */
  let frames = 0;
  let bytes = 0;

  /** 真正写帧的唯一出口：帧数与字节数只在这里数 */
  const emit = (record: RowRecord): void => {
    if (closed || sink === null) return;
    const frame = toFrame(record);
    frames += 1;
    bytes += frame.length;
    sink.enqueue(encoder.encode(frame));
  };

  const coalescer = createDeltaCoalescer(emit);

  /** 释放资源（幂等）：关流与取消都要走它 */
  const teardown = (): void => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    coalescer.dispose();
    unsubscribe?.();
    unsubscribe = null;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      const close = (): void => {
        if (closed) return;
        closed = true;
        teardown();
        controller.close();
      };

      const push = (record: RowRecord): void => {
        if (closed) return;
        coalescer.push(record);
      };

      // **第一件事就是吐一个字节**（注释帧，客户端按 SSE 规范忽略）：响应头要等第一次
      // `controller.enqueue` 才 flush，而空历史 + 无新记录时原本要等到 15 秒后的心跳才 flush
      // ⇒ 这段时间里浏览器不触发 `onopen`，徽标只能显示「未连接」。
      controller.enqueue(encoder.encode(': ready\n\n'));

      /**
       * 回放历史：**先订阅再回放**（顺序与事件通道相反，这里安全且必要）。
       * 安全：`start()` 是同步执行的，回放与订阅之间没有事件循环的让出点，不存在丢记录的时间窗。
       * 必要：订阅在前，回放期间到达的新记录**也在同一条流里**（都写在同一个文件末尾），
       * 客户端按 `messageId` 去重即可——这比「回放、再订阅」少一个『读到一半又来了新记录』的窗口。
       */
      unsubscribe = channel.subscribe(runId, rowId, push);

      if (history !== null) {
        for (const message of history.messages) push({ type: 'message', message });
        for (const subagent of history.subagents) push({ type: 'subagent', subagent });
      }

      heartbeat = setInterval(() => {
        if (closed) return;
        // 注释帧（以 `:` 开头）按 SSE 规范被客户端忽略，只用来占住连接
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, HEARTBEAT_MS);
      log.debug('消息 SSE 开始推送', {
        runId,
        rowId,
        channel: channel.label,
        replayHistory: replay,
        replayedMessages: history?.messages.length ?? 0,
        replayedSubagents: history?.subagents.length ?? 0,
      });
    },
    cancel() {
      // 客户端断开（关闭抽屉 / 切行）：必须退订并清定时器。
      // 这里不能调 controller.close()——流已经被取消了，再关会抛。
      closed = true;
      teardown();
      /**
       * 出口观测（D11）：**「浏览器卡死」的第一手判据就是这三个数**——`frames` 是真正写出去的
       * SSE 帧数、`bytes` 是字节数、`coalesced` 是被窗口合并掉（从未发出）的增量帧数。
       * 它们只在 DEBUG 打（`AIEVAL_DEBUG=1`）：这是排查用的数，不是每次断连都值得刷一行日志。
       */
      log.debug('消息 SSE 被客户端取消', {
        runId,
        rowId,
        channel: channel.label,
        frames,
        bytes,
        coalesced: coalescer.coalescedCount,
      });
    },
  });
}

/**
 * 候选那条记录流：`messages.jsonl` 的历史回放 + 实时扇出。
 * `options.replayHistory: false` = 不回放（见文件头那一档）。
 */
export function streamRowRecords(runId: string, rowId: string, options: RecordStreamOptions = {}): ReadableStream<Uint8Array> {
  return streamRecords(ROW_RECORD_CHANNEL, runId, rowId, options);
}

/**
 * 评分那条记录流：`judge-messages.jsonl`。与候选那条逐字同口径，
 * 只是另一个会话、另一个文件、另一张订阅表。
 */
export function streamJudgeRecords(runId: string, rowId: string, options: RecordStreamOptions = {}): ReadableStream<Uint8Array> {
  return streamRecords(JUDGE_RECORD_CHANNEL, runId, rowId, options);
}
