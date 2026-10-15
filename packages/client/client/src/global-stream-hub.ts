/**
 * **全局流**的客户端出口（`GET /api/runs/stream`）：一条页面级长连接承载三族信号
 * （`run-updated` / `ask-user-changed` / `inject-messages-changed`），列表重验、待答快照、
 * 人工消息队列三个消费方都从这里取帧。
 *
 * 三层分工（本文件只占第三层，与 `run-stream-hub.ts` / `drawer-stream-hub.ts` 逐字同形）：
 *   · **原语**（`sse-keyed-hub.ts`）：键控的连接管理 + 解帧 + 扇出，与业务无关；
 *   · **信封**（`@aieval/contracts` 的 `RunStreamFrameSchema`）：帧的形状只有那一份；
 *   · **本文件**：键 = 常量 `'global'`、URL 拼装、以及「哪些帧属于这条流」的判别。
 *
 * 业务只加了一条原语管不到的东西：**「重连补读一次」的判据在连接层，不在各 hook 里**。
 * 三族信号都是「变了，重读快照」的提示、都不可续订，断线期间服务端发的帧永远补不回来 ⇒
 * 每一次**重连**都要通知订阅者补读一次；而**首次连接不通知**（页面自己的首拉就在同一瞬间）。
 * 这条判据写三份的结果必然是某一份先漂：hook 自己拿不到「这是第几次连上」这个事实。
 *
 * 帧**无名**（没有 `event:` 行）：判别键是信封顶层的 `type`，再用 SSE 的具名事件表达一遍就是
 * 第二份会漂移的真相；原语只绑 `onmessage`，发具名帧等于零交付。
 */
import {
  RunStreamFrameSchema,
  type AskUserChangedFrame,
  type InjectMessagesChangedFrame,
  type RunSignalFrame,
  type RunStreamFrame,
} from '@aieval/contracts';
import { createKeyedSseHub, type SseSink } from './sse-keyed-hub';

/** 全局流的端点（与路由 `apps/web-next/app/api/runs/stream/route.ts` 同形） */
export const GLOBAL_STREAM_URL = '/api/runs/stream';

/**
 * 这条流会发的三族信号帧。判别键是顶层 `type`。
 * 信封里新增信号族时这里要一起加——漏了的表现是「新信号在客户端零交付」，不报任何错。
 */
export type GlobalStreamFrame = RunSignalFrame | AskUserChangedFrame | InjectMessagesChangedFrame;

/**
 * 一个订阅者。三族帧都会喂给它（消费方按 `type` 自己分流：列表那一路还要把
 * `ask-user-changed` 当刷新信号，见 `run-events.ts`），`onReconnect` 是「补读一次快照」的入口。
 */
export interface GlobalStreamSink {
  /** 一帧到手（已按信封契约解析、且属于这条流） */
  onFrame(frame: GlobalStreamFrame): void;
  /** 断线重连成功：断线期间的信号永远收不到了，重连本身当一条迟到的信号。首次连接不调 */
  onReconnect?(): void;
}

/** 一帧是不是全局流的信号帧（不是就当坏帧丢掉：这条流不带行级帧） */
function isGlobalStreamFrame(frame: RunStreamFrame): frame is GlobalStreamFrame {
  return frame.type === 'run-updated' || frame.type === 'ask-user-changed' || frame.type === 'inject-messages-changed';
}

/**
 * 键控原语（连接管理 + 解帧 + 扇出）：本文件只提供键、URL 与帧的解析。
 *
 * `eventNames` 为空：全局流的帧**一律无名**（见文件头），原语因此只绑 `onmessage`——
 * 这也是原语那条「不许再 `addEventListener('message')`」的口径在这里天然成立的原因。
 */
const hub = createKeyedSseHub<RunStreamFrame>({
  url: () => GLOBAL_STREAM_URL,
  eventNames: [],
  parse: (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
    const parsed = RunStreamFrameSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  },
  disconnected: '实时连接中断：浏览器会自动重连，已收到的内容不受影响',
});

/** 连接键：只有这一条全局流，故是一个常量键 */
const GLOBAL_STREAM_KEY = 'global';

/** 当前订阅者 */
const sinks = new Set<GlobalStreamSink>();
/** 本文件在底层 hub 上的那一次订阅（订阅者 0 → 1 时挂上、1 → 0 时摘掉） */
let offHub: (() => void) | null = null;
/** 是否已经完成过一次连接（重连判据；不复位：单例关掉再重开对页面语义而言仍是「页面已首拉过」） */
let openedOnce = false;

/**
 * 逐个 sink 地投递：一个 sink 抛错不该让另一个 sink 收不到这一帧
 * （与浏览器 `EventTarget.dispatchEvent` 的既有语义一致：一个监听器抛错不打断其余监听器）。
 */
function fanOut(deliver: (sink: GlobalStreamSink) => void): void {
  for (const sink of [...sinks]) {
    try {
      deliver(sink);
    } catch (error) {
      // 报错但吞掉：消费方是 React 的 setState 与 SWR 的 mutate，它们的异常不该让另一个消费方断流
      console.error('全局流帧的消费方抛错（其余订阅者照常收到）', error);
    }
  }
}

/** 挂在底层 hub 上的那一个 sink：帧分流 + 重连通知（订阅者的增删由本文件自己记账） */
const hubSink: SseSink<RunStreamFrame> = {
  onFrame: (frame) => {
    if (!isGlobalStreamFrame(frame)) return;
    fanOut((sink) => sink.onFrame(frame));
  },
  onOpen: () => {
    // 首次连接不补：页面自己的首拉（列表 / 待答快照）就在同一瞬间，再补一刀是纯重复请求
    if (!openedOnce) {
      openedOnce = true;
      return;
    }
    fanOut((sink) => sink.onReconnect?.());
  },
};

/**
 * 订阅全局流，返回退订函数（幂等）。
 *
 * 第一个订阅者开连接、最后一个退订即关流：全局流是**页面级**的，空闲时不该留一条只发心跳的连接。
 */
export function subscribeGlobalStream(sink: GlobalStreamSink): () => void {
  sinks.add(sink);
  offHub ??= hub.subscribe(GLOBAL_STREAM_KEY, hubSink);

  let done = false;
  return () => {
    if (done) return;
    done = true;
    sinks.delete(sink);
    if (sinks.size > 0) return;
    offHub?.();
    offHub = null;
  };
}

/** 当前开着的连接数（用例断言共享与归零关连接；生产代码不读它） */
export function globalStreamOpenCount(): number {
  return hub.openCount();
}

/** 测试复位：关掉连接并清空订阅与重连判据（用例之间不串） */
export function resetGlobalStreamHubForTesting(): void {
  offHub?.();
  offHub = null;
  sinks.clear();
  openedOnce = false;
  hub.reset();
}
