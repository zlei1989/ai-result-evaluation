/**
 * 一行**评分阶段**的事件流：`/judge/events` 补历史 +（评分进行中）抽屉流的 judge channel 按 seq 续订。
 *
 * 帧从抽屉 hub（`drawer-stream-hub.ts`）来：judge 那个 channel 的完整流水里也带着评分侧的
 * 消息与子任务行，本 hook 只挑行级事件那一族（`isAgentEventFrame`）。具名事件订阅、
 * `error` 按帧形状分流、无名帧兜底、引用计数归零关连接四件通用知识都在 `sse-keyed-hub.ts`。
 *
 * 与候选那条（`row-stream.ts`）消费的是同一份 SSE 帧协议——差异全部来自「这条流没有终态」：
 *
 * 1. **服务端不会自己关流**：`judge-events.jsonl` 只收评审者自己的事件（`log` / `usage` /
 *    `vendor-system` / `error`），终态落行级那条流 ⇒ SSE 挂着靠心跳吊命，直到客户端关。
 *    故连接生命周期完全等于本 hook 的 effect 生命周期，且**只在 `live`（行状态 judging）时
 *    才接**——已拿分的行历史拉完即止，不给浏览器留一条只发心跳的空连接（空闲零连接口径）；
 * 2. **不做「新一代」检测**：序号侧的换代判据（`row-stream.ts` 的 `restarts`）在这条流上没有落点。
 *    清空 `judge-events.jsonl` 的两个入口（重跑 / 重评）都会**同步**把行落成 running / judging 并
 *    清掉 `score`，于是 `live` 必然翻转、effect 必然重挂重拉——候选那条达到同一效果靠的是调用方
 *    传进来的「这一次尝试」标识（见 `useRowStream` 的口径 5）。
 *    ⚠️ 两条流的换代都**不能**只靠「看到 seq 回到 1」：SSE 续订的游标停在上一代，
 *    新一代的头几条根本发不出服务端那道去重闸门，那个信号不可达。
 *    按 seq 去重仍保留：历史与 SSE 在边界上的重复投递是常态（浏览器重连带 `Last-Event-ID`、
 *    服务端回放边界帧），不去重日志里就有两遍同一行；
 * 3. **judging → 终态的翻转重拉一次全量**：`live` 进依赖，翻 false 时 effect 重挂、历史重新读盘
 *    拿终值——这是收尾不是浪费（SSE 尾部若有丢失，这一步兜住）。快照刷新（分数落进行里）
 *    不归本 hook：那是 run 信号流（`run-events.ts`）的职责；
 * 4. **历史读失败不接 SSE**（接上也只会立刻收到同一条错误），错误交回调用方渲染
 *    （`status === 'error'` + `error`）；`retry` 是重拉历史的显式入口（把 effect 重挂一次）。
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@aieval/contracts';
import { eventOf, isAgentEventFrame, subscribeDrawerStream } from './drawer-stream-hub';
import { getJson } from './http';
import { runRowUrl } from './runs';

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
    /** 本次订阅的退订函数（hub 里引用计数归零即关连接）；没订阅上时为 null */
    let unsubscribe: (() => void) | null = null;
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

    /** 停掉本 hook 的订阅：judge 那个 channel 上只有它一个 sink，退订即关连接（空闲零连接口径） */
    const stop = (): void => {
      unsubscribe?.();
      unsubscribe = null;
    };

    const connect = (afterSeq: number): void => {
      // 环境没有 EventSource（老浏览器 / 测试）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') {
        setLiveError('当前环境不支持 EventSource：只能查看已落盘的输出，无法实时追加');
        return;
      }
      unsubscribe = subscribeDrawerStream(
        runId,
        rowId,
        'judge',
        {
          // 同一个 channel 的完整流水里也带着评分侧的消息与子任务行，本 hook 只认行级事件那一族
          onFrame: (frame) => {
            if (cancelled) return;
            if (!isAgentEventFrame(frame)) return;
            merge([eventOf(frame)]);
          },
          onOpen: () => setLiveError(null),
          // 连接故障（浏览器会自动重连，带 Last-Event-ID）：如实反映状态即可
          onError: (message) => setLiveError(message),
          // 坏帧只跳过它自己，绝不打断整条流（判据在 hub 的 `parse` 里）
          onInvalidFrame: () => setLiveError('收到无法解析的事件帧，已跳过'),
        },
        afterSeq,
      );
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
