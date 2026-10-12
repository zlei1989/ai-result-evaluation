/**
 * 一行**评分阶段**的事件流：`/judge/events` 补历史 +（评分进行中）`/judge/events/stream` 按 seq 续订。
 *
 * 与候选那条（`row-stream.ts`）消费的是同一份 SSE 帧协议——`parseFrame`、具名事件订阅、
 * `error` 按帧形状分流三件全部复用它那份实现——差异全部来自「这条流没有终态」：
 *
 * 1. **服务端不会自己关流**：`judge-events.jsonl` 只收评审者自己的事件（`log` / `usage` /
 *    `vendor-system` / `error`），终态落行级那条流 ⇒ SSE 挂着靠心跳吊命，直到客户端关。
 *    故连接生命周期完全等于本 hook 的 effect 生命周期，且**只在 `live`（行状态 judging）时
 *    才接**——已拿分的行历史拉完即止，不给浏览器留一条只发心跳的空连接（空闲零连接口径）；
 * 2. **不做「新一代」检测**：候选那条要它，是因为抽屉开着时重跑同一行不会换 effect 依赖。
 *    评分这条不会——清空 `judge-events.jsonl` 的两个入口（重跑 / 重评）都会**同步**把行落成
 *    running / judging 并清掉 `score`，于是 `enabled` / `live` 必有一个翻转、effect 必然重挂重拉。
 *    按 seq 去重仍保留：历史与 SSE 在边界上的重复投递是常态（浏览器重连带 `Last-Event-ID`、
 *    服务端回放边界帧），不去重日志里就有两遍同一行；
 * 3. **judging → 终态的翻转重拉一次全量**：`live` 进依赖，翻 false 时 effect 重挂、历史重新读盘
 *    拿终值——这是收尾不是浪费（SSE 尾部若有丢失，这一步兜住）。快照刷新（分数落进行里）
 *    不归本 hook：那是 run 信号流（`run-events.ts`）的职责；
 * 4. **历史读失败不接 SSE**（接上也只会立刻收到同一条错误），错误交回调用方渲染
 *    （`status === 'error'` + `error`）；`retry` 是重拉历史的显式入口（把 effect 重挂一次）。
 */
import { useEffect, useRef, useState } from 'react';
import { AGENT_EVENT_TYPES, type AgentEvent } from '@aieval/contracts';
import { getJson } from './http';
import { runRowUrl } from './runs';
import { parseFrame } from './row-stream';

export interface UseRowJudgeEventsInput {
  runId: string;
  rowId: string;
  /** 评分详情抽屉开着且这一行有这个入口时才取数（文本 API 评分没有这条流） */
  enabled: boolean;
  /** 行状态是 judging 时才接 SSE；终态行只拉历史（口径 1：空闲零连接） */
  live: boolean;
}

export interface UseRowJudgeEventsResult {
  /** 到手的事件（按 seq 升序）；live 时随 SSE 到达原地增长 */
  events: AgentEvent[];
  /** 历史读取的三态（SSE 不改变它：实时追加失败走 `liveError`） */
  status: 'loading' | 'error' | 'ready';
  /** `status === 'error'` 时的原始错误 */
  error: unknown;
  /** SSE 连接故障的一句人话（历史已在手时仍可能非空；重连成功自动清空） */
  liveError: string | null;
  /** 历史读取失败后的重试：重挂一次 effect、历史重新读盘 */
  retry(): void;
}

export function useRowJudgeEvents(input: UseRowJudgeEventsInput): UseRowJudgeEventsResult {
  const { runId, rowId, enabled, live } = input;
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  /** retry 计数：唯一作用是把 effect 重挂一次（历史重新读盘），不参与任何渲染 */
  const [attempt, setAttempt] = useState(0);
  // 已见 seq 放 ref：SSE 回调不是渲染函数，读 state 会读到闭包里的旧值（去重会因此失效）
  const seenRef = useRef<Set<number>>(new Set());
  // 已见 seq 的上界：给 SSE 的 afterSeq（续订起点），同上不进 state
  const lastSeqRef = useRef(0);

  useEffect(() => {
    if (!enabled || runId === '' || rowId === '') return;

    let cancelled = false;
    let source: EventSource | null = null;
    /** 本次连接挂上去的具名监听器：`stop()` 要按同一对 (类型, 函数) 摘掉它们 */
    const namedListeners: Array<{ type: string; listener: (event: MessageEvent) => void }> = [];
    // 换行 / 翻转 live / 重试都从这里重开：上一段的去重记录与已交付事件一并丢掉
    seenRef.current = new Set();
    lastSeqRef.current = 0;
    setEvents([]);
    setStatus('loading');
    setError(null);
    setLiveError(null);

    /**
     * 合并一批事件：按 seq 去重 + 保持升序。不做「新一代」检测——理由见文件头口径 2
     * （这条流的清空必然伴随 `enabled` / `live` 翻转，effect 会整体重挂）。
     */
    const merge = (incoming: AgentEvent[]): void => {
      if (cancelled) return;
      const fresh = incoming.filter((event) => !seenRef.current.has(event.seq));
      if (fresh.length === 0) return;
      for (const event of fresh) {
        seenRef.current.add(event.seq);
        lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
      }
      setEvents((prev) => [...prev, ...fresh].sort((a, b) => a.seq - b.seq));
    };

    const stop = (): void => {
      if (source === null) return;
      // 先摘监听器再关连接：顺序反过来也不出错，但「连接已关、监听器还挂着」在
      // 真实浏览器里会保留整条闭包链（含 merge），是纯泄漏
      for (const { type, listener } of namedListeners) source.removeEventListener(type, listener);
      namedListeners.length = 0;
      source.close();
      source = null;
    };

    const connect = (afterSeq: number): void => {
      // 环境没有 EventSource（老浏览器 / 测试）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') {
        setLiveError('当前环境不支持 EventSource：只能查看已落盘的输出，无法实时追加');
        return;
      }
      const next = new EventSource(`${runRowUrl(runId, rowId, 'judge/events/stream')}?afterSeq=${afterSeq}`);
      source = next;

      /** 一帧的处理：具名 / 无名两种订阅路径共用（协议同 row-stream.ts，口径见它文件头） */
      const handleFrame = (event: MessageEvent): void => {
        if (cancelled) return;
        const parsed = parseFrame(String(event.data));
        if (parsed === null) {
          setLiveError('收到无法解析的事件帧，已跳过');
          return;
        }
        merge([parsed]);
      };

      // `error` 有两个来源（服务端具名帧 vs 连接故障），按帧形状分流——判据与理由同 row-stream.ts
      next.onerror = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (typeof data === 'string') {
          handleFrame(event as MessageEvent);
          return;
        }
        // 浏览器会自动重连（带 Last-Event-ID），这里如实反映状态即可
        setLiveError('实时连接中断：浏览器会自动重连，已收到的输出不受影响');
      };
      next.onopen = () => setLiveError(null);

      // 具名事件按事件名订阅（`onmessage` 只收无名帧）：清单取 contracts，`error` 走 onerror
      for (const type of AGENT_EVENT_TYPES) {
        if (type === 'error') continue;
        namedListeners.push({ type, listener: handleFrame });
        next.addEventListener(type, handleFrame);
      }
      // 无名帧的兜底：服务端哪天不发 `event:` 行了也照样能收
      next.onmessage = handleFrame;
    };

    void (async () => {
      try {
        const history = await getJson<AgentEvent[]>(runRowUrl(runId, rowId, 'judge/events'));
        if (cancelled) return;
        merge(history);
        setStatus('ready');
        // afterSeq 用已交付的最大 seq（刚 merge 过历史）；只在评分进行中才接实时（口径 1）
        if (live) connect(lastSeqRef.current);
      } catch (cause) {
        // 历史都拿不到（例如行 id 不存在）就不接 SSE 了：接上也只会立刻收到错误
        if (!cancelled) {
          setStatus('error');
          setError(cause);
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, runId, rowId, live, attempt]);

  return { events, status, error, liveError, retry: () => setAttempt((n) => n + 1) };
}
