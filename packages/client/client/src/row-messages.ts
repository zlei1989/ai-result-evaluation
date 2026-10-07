/**
 * 一行的**消息与子任务行**（`messages.jsonl`）：首帧拉一次，然后接内容级 SSE。
 *
 * 与 `useRowStream`（行级事件流）的三处**刻意不同**——照抄那边会坏：
 *   1. **没有 `seq` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
 *      服务端每次连接都回放全量，客户端**按 `mergeKey` 覆盖累积**、按 `messageId` 去重；
 *   2. **不去重「内容」**：一条逻辑消息会多次投递（delta 之后是快照、块一块一块追加），
 *      每一次都带「到目前为止的完整块列表」⇒ 留最后一条就是终态。按内容去重会把中间态吃掉；
 *   3. **不因终态关流**：与事件流相反，这里不订阅终态去关连接。打开一个**已经跑完**的行的
 *      对话视图时，那份历史恰恰是要看的东西。
 *
 * 为什么要按帧合并提交（本仓 spec 对数据层的要求）：真实一行的一次运行会落下几百上千条消息记录，
 * 一帧一次 `setState` 就是每秒几十次整页重渲染。这里把一帧内的多条帧**攒到下一帧再发布一次**，
 * 并把投递上界钉在「至多一帧一次」。
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentMessage, RowRecord, SubagentRecord } from '@aieval/contracts';
import { getJson } from './http';
import { runRowMessagesStreamUrl, runRowUrl } from './runs';

/** 服务端 `/messages` 一次性拉取的形状（折叠后的最终视图） */
export interface RowMessagesPayload {
  messages: AgentMessage[];
  subagents: SubagentRecord[];
}

/**
 * 按记录的合并键**覆盖累积**成最终视图：消息按 `mergeKey`、子任务行按 `subagentId`。
 * 顺序按**首次出现**——那是这条逻辑消息被产出的顺序，比按 `messageId` 排序可靠
 * （`messageId` 是适配器给的字符串，没有可比的序）。
 *
 * 导出是为了可单测：这是整条链上唯一一处「覆盖而不是追加」的判据，错一次就是
 * 「同一段正文在时间轴上出现两遍、后一遍还是半截的」。
 */
export function foldRowRecords(records: readonly RowRecord[]): RowRecord[] {
  const messages = new Map<string, AgentMessage>();
  const subagents = new Map<string, SubagentRecord>();
  /** 首次出现的顺序；用 `Set` 判重而不是 `Array.includes`（一次运行可能有几千条记录） */
  const seen = new Set<string>();
  const order: string[] = [];
  const keyOf = (record: RowRecord): string =>
    record.type === 'message' ? `m:${record.message.mergeKey}` : `s:${record.subagent.subagentId}`;
  for (const record of records) {
    const key = keyOf(record);
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
    if (record.type === 'message') messages.set(key, record.message);
    else subagents.set(key, record.subagent);
  }
  const out: RowRecord[] = [];
  for (const key of order) {
    const message = messages.get(key);
    if (message !== undefined) {
      out.push({ type: 'message', message });
      continue;
    }
    const subagent = subagents.get(key);
    if (subagent !== undefined) out.push({ type: 'subagent', subagent });
  }
  return out;
}

/** 把服务端的一次性响应摊成记录序列（两条流在折叠前是同一形状，故在这里统一） */
function toRecords(payload: RowMessagesPayload): RowRecord[] {
  return [
    ...payload.messages.map((message): RowRecord => ({ type: 'message', message })),
    ...payload.subagents.map((subagent): RowRecord => ({ type: 'subagent', subagent })),
  ];
}

/** 一帧的解析：坏帧返回 `null`（调用方跳过它），绝不让一个畸形帧把整条流打断 */
export function parseRowRecordFrame(data: string): RowRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<RowRecord>;
  if (candidate.type === 'message' && typeof candidate.message === 'object' && candidate.message !== null) {
    return { type: 'message', message: candidate.message };
  }
  if (candidate.type === 'subagent' && typeof candidate.subagent === 'object' && candidate.subagent !== null) {
    return { type: 'subagent', subagent: candidate.subagent };
  }
  return null;
}

/**
 * 覆盖累积的**增量**入口：把新到的若干条并进已累积的序列。
 * 覆盖发生在原位（同键只留一条），新键追加——这样「用户正在读的那一段」不会被重排到别处。
 */
export function mergeRowRecords(previous: readonly RowRecord[], incoming: readonly RowRecord[]): RowRecord[] {
  return foldRowRecords([...previous, ...incoming]);
}

export interface UseRowMessagesResult {
  /** 折叠后的最终视图（消息 + 子任务行） */
  records: RowRecord[];
  connected: boolean;
  error: unknown;
  isLoading: boolean;
  /** 重取这一行的记录（`AgentLogSource.retryNode` 的落点）；它就是再拉一次 `/messages` */
  refresh: () => void;
}

/**
 * 订阅一行的消息流。`enabled` 为 false 时不发任何请求（抽屉关着时不该开长连接）。
 *
 * **先拉 `/messages`、后接 SSE**（顺序与事件流同一条理由）：SSE 会回放全量，
 * 两条来源天然重叠，而客户端按 `mergeKey` 覆盖累积 ⇒ 重叠无害；反过来先接 SSE 再拿 REST，
 * 晚到的那份 REST 会把 SSE 期间累积的新内容盖回旧值。
 */
export function useRowMessages(input: { runId: string; rowId: string; enabled: boolean }): UseRowMessagesResult {
  const { runId, rowId, enabled } = input;
  const [records, setRecords] = useState<RowRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setLoading] = useState(false);
  /** 攒到下一帧再发布：一帧内的多条投递合并成一次提交（见文件头） */
  const pendingRef = useRef<RowRecord[]>([]);
  const flushRef = useRef<number | null>(null);
  /** 重取信号：+1 让下面的 effect 重挂（连接也要跟着重开，否则会一直读旧的那份回放） */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled || runId === '' || rowId === '') return;

    let cancelled = false;
    let source: EventSource | null = null;
    pendingRef.current = [];
    setRecords([]);
    setConnected(false);
    setError(null);
    setLoading(true);

    const cancelFlush = (): void => {
      if (flushRef.current === null) return;
      cancelAnimationFrame(flushRef.current);
      flushRef.current = null;
    };

    const flush = (): void => {
      flushRef.current = null;
      if (cancelled) return;
      const pending = pendingRef.current;
      if (pending.length === 0) return;
      pendingRef.current = [];
      setRecords((previous) => mergeRowRecords(previous, pending));
    };

    /**
     * 一帧的合并提交。`requestAnimationFrame` 在**后台标签页里会暂停**，而流不会停——
     * 不兜底就是「后台攒一大坨、切回来卡一下」，故用定时器兜住同一帧。
     */
    const schedule = (): void => {
      if (flushRef.current !== null) return;
      flushRef.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 16) as unknown as number);
    };

    const stop = (): void => {
      source?.close();
      source = null;
      setConnected(false);
    };

    const connect = (): void => {
      // 环境没有 EventSource（老浏览器 / 测试替身缺失）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') return;
      const next = new EventSource(runRowMessagesStreamUrl(runId, rowId));
      source = next;
      next.onopen = () => {
        setConnected(true);
        setError(null);
      };
      const handleFrame = (event: MessageEvent): void => {
        if (cancelled) return;
        const parsed = parseRowRecordFrame(String(event.data));
        if (parsed === null) return;
        pendingRef.current.push(parsed);
        schedule();
      };
      // api 的 `toFrame` 发的是**具名**事件（`event: message` / `event: subagent`），
      // 而 `onmessage` 只收无名帧 ⇒ 只绑 onmessage 等于零交付。无名帧仍留兜底。
      next.addEventListener('message', handleFrame);
      next.addEventListener('subagent', handleFrame);
      next.onmessage = handleFrame;
      next.onerror = (event: Event) => {
        const data = (event as MessageEvent).data;
        // 带 data 的是服务端帧（走正常解析）；不带的才是连接故障
        if (typeof data === 'string') {
          handleFrame(event as MessageEvent);
          return;
        }
        setConnected(false);
        setError(new Error('消息流连接中断：浏览器会自动重连，已收到的内容不受影响'));
      };
    };

    void (async () => {
      try {
        const payload = await getJson<RowMessagesPayload>(runRowUrl(runId, rowId, 'messages'));
        if (cancelled) return;
        pendingRef.current.push(...toRecords(payload));
        flush();
        setLoading(false);
        connect();
      } catch (cause) {
        if (cancelled) return;
        setLoading(false);
        setError(cause);
      }
    })();

    return () => {
      cancelled = true;
      cancelFlush();
      stop();
    };
  }, [enabled, runId, rowId, reloadToken]);

  return { records, connected, error, isLoading, refresh: () => setReloadToken((token) => token + 1) };
}
