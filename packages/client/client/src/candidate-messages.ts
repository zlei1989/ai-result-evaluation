/**
 * 一候选的**消息与子任务行**（`messages.jsonl`）：首帧拉一次，然后接内容级 SSE。
 *
 * 帧从抽屉 hub（`drawer-stream-hub.ts`）来：与 `useCandidateStream` **共用**「一行一个 channel」
 * 的那一条连接，两族帧混着到，本 hook 只挑 `message` / `subagent` 两种
 * （`isCandidateRecordFrame`）。连接与解帧的通用知识在 `sse-keyed-hub.ts` 的键控原语里。
 *
 * 与 `useCandidateStream`（候选级事件流）的三处**刻意不同**——照抄那边会坏：
 *   1. **没有 `seq` 续订**：记录没有单调序号（`messageId` 由适配器分配、跨运行会重号），
 *      服务端每次连接都回放全量，客户端**按 `(段号, mergeKey)` 覆盖累积**（契约的 `messageFoldKey`；
 *      **不按 `messageId` 去重**，那是错的——同一条逻辑消息的 delta 与快照是两条 `messageId`）；
 *   2. **不去重「内容」**：一条逻辑消息会多次投递（delta 之后是快照、块一块一块追加），
 *      每一次都带「到目前为止的完整块列表」⇒ 留最后一条就是终态。按内容去重会把中间态吃掉；
 *   3. **不因终态关流**：与事件流相反，这里不订阅终态去关连接。打开一个**已经跑完**的候选的
 *      对话视图时，那份历史恰恰是要看的东西。
 *
 * 为什么要按帧合并提交（本仓 spec 对数据层的要求）：真实一候选的一次运行会落下几百上千条消息记录，
 * 一帧一次 `setState` 就是每秒几十次整页重渲染。这里把一帧内的多条帧**攒到下一帧再发布一次**，
 * 并把投递上界钉在「至多一帧一次」。
 */
import { useEffect, useRef, useState } from 'react';
import { messageFoldKey, type AgentMessage, type CandidateRecord, type SubagentRecord } from '@aieval/contracts';
import { isCandidateRecordFrame, recordOf, subscribeDrawerStream } from './drawer-stream-hub';
import { getJson } from './http';
import { runCandidateUrl } from './runs';

/** 服务端 `/messages` 一次性拉取的形状（折叠后的最终视图） */
export interface CandidateMessagesPayload {
  messages: AgentMessage[];
  subagents: SubagentRecord[];
}

/**
 * 按记录的合并键**覆盖累积**成最终视图：消息按 `(段号, mergeKey)`、子任务行按 `subagentId`。
 * 顺序按**首次出现**——那是这条逻辑消息被产出的顺序，比按 `messageId` 排序可靠
 * （`messageId` 是适配器给的字符串，没有可比的序）。
 *
 * ⚠️ **键里必须带段号**（用契约的 `messageFoldKey`，不自己拼）：一次追问是又开一次 `run()`，
 * 那一段自己的厂商轮次从 1 重新数 ⇒ 两段的载体键**逐字相同**（`main|1|assistant|-`）。
 * 按裸 `mergeKey` 折叠就是「后一段把前一段同键的那条整条吃掉」——真机症状是
 * **关掉再打开执行日志时首段的消息全没了**（重新打开先拉一次 `/messages`，走的就是本函数）。
 * 服务端折叠（`@aieval/core` 的 `foldMessages`）与界面装配（`@aieval/ui` 的 `buildAgentLogModel`）
 * 早就用这一条式子，三处同源才不会「一处认段、一处不认」。
 *
 * 导出是为了可单测：这是整条链上唯一一处「覆盖而不是追加」的判据，错一次就是内容丢失。
 */
export function foldCandidateRecords(records: readonly CandidateRecord[]): CandidateRecord[] {
  const messages = new Map<string, AgentMessage>();
  const subagents = new Map<string, SubagentRecord>();
  /** 首次出现的顺序；用 `Set` 判重而不是 `Array.includes`（一次运行可能有几千条记录） */
  const seen = new Set<string>();
  const order: string[] = [];
  const keyOf = (record: CandidateRecord): string =>
    record.type === 'message' ? `m:${messageFoldKey(record.message)}` : `s:${record.subagent.subagentId}`;
  for (const record of records) {
    const key = keyOf(record);
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
    if (record.type === 'message') messages.set(key, record.message);
    else subagents.set(key, record.subagent);
  }
  const out: CandidateRecord[] = [];
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
function toRecords(payload: CandidateMessagesPayload): CandidateRecord[] {
  return [
    ...payload.messages.map((message): CandidateRecord => ({ type: 'message', message })),
    ...payload.subagents.map((subagent): CandidateRecord => ({ type: 'subagent', subagent })),
  ];
}

/** 一帧的解析：坏帧返回 `null`（调用方跳过它），绝不让一个畸形帧把整条流打断 */
export function parseCandidateRecordFrame(data: string): CandidateRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Partial<CandidateRecord>;
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
export function mergeCandidateRecords(previous: readonly CandidateRecord[], incoming: readonly CandidateRecord[]): CandidateRecord[] {
  return foldCandidateRecords([...previous, ...incoming]);
}

export interface UseCandidateMessagesResult {
  /** 折叠后的最终视图（消息 + 子任务行） */
  records: CandidateRecord[];
  connected: boolean;
  error: unknown;
  isLoading: boolean;
  /** 重取这个候选的记录（`AgentLogSource.retryNode` 的落点）；它就是再拉一次 `/messages` */
  refresh: () => void;
}

/**
 * 订阅一候选的消息流。`enabled` 为 false 时不发任何请求（抽屉关着时不该开长连接）。
 *
 * **先拉 `/messages`、后接 SSE**（顺序与事件流同一条理由）：SSE 会回放全量，
 * 两条来源天然重叠，而客户端按 `mergeKey` 覆盖累积 ⇒ 重叠无害；反过来先接 SSE 再拿 REST，
 * 晚到的那份 REST 会把 SSE 期间累积的新内容盖回旧值。
 */
export function useCandidateMessages(input: { runId: string; candidateId: string; enabled: boolean }): UseCandidateMessagesResult {
  const { runId, candidateId, enabled } = input;
  const [records, setRecords] = useState<CandidateRecord[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setLoading] = useState(false);
  /** 攒到下一帧再发布：一帧内的多条投递合并成一次提交（见文件头） */
  const pendingRef = useRef<CandidateRecord[]>([]);
  const flushRef = useRef<number | null>(null);
  /** 重取信号：+1 让下面的 effect 重挂（连接也要跟着重开，否则会一直读旧的那份回放） */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!enabled || runId === '' || candidateId === '') return;

    let cancelled = false;
    /** 本次订阅的退订函数（hub 里引用计数归零即关连接）；没订阅上时为 null */
    let unsubscribe: (() => void) | null = null;
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
      setRecords((previous) => mergeCandidateRecords(previous, pending));
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

    /**
     * 停掉本 hook 的订阅。**只退自己这一个 sink**：同一条连接上还挂着事件那一条
     * （`useCandidateStream` 与它共用「一行一个 channel」的抽屉流）；终态时事件那一条会先退，
     * 而这一条要留到抽屉关闭——跑完的候选的对话历史正是用户要看的东西。
     */
    const stop = (): void => {
      unsubscribe?.();
      unsubscribe = null;
      setConnected(false);
    };

    const connect = (): void => {
      // 环境没有 EventSource（老浏览器 / 测试替身缺失）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') return;
      unsubscribe = subscribeDrawerStream(runId, candidateId, 'candidate', {
        // 同一条连接上两族混着来：候选级事件那十种归 `useCandidateStream`（同一行同一 channel）
        onFrame: (frame) => {
          if (cancelled) return;
          if (!isCandidateRecordFrame(frame)) return;
          pendingRef.current.push(recordOf(frame));
          schedule();
        },
        onOpen: () => {
          setConnected(true);
          setError(null);
        },
        // 连接故障（浏览器会自动重连，带 Last-Event-ID）：如实反映状态即可
        onError: (message) => {
          setConnected(false);
          setError(new Error(message));
        },
        // 坏帧**静默跳过**（与这一条流原先的口径一致）：时间轴少一条不致命的记录，
        // 不值得在界面上报一句故障——事件那一条（`useCandidateStream`）才把坏帧显示出来
      });
    };

    void (async () => {
      try {
        const payload = await getJson<CandidateMessagesPayload>(runCandidateUrl(runId, candidateId, 'messages'));
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
  }, [enabled, runId, candidateId, reloadToken]);

  return { records, connected, error, isLoading, refresh: () => setReloadToken((token) => token + 1) };
}
