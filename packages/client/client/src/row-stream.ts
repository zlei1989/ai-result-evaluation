/**
 * 一行的实时事件流：`/log` 补历史 + `/stream` 按 seq 续订。
 * 五条口径（SSE 订阅行为要求）：
 * 1. **首帧先拉 `/log`**：抽屉一打开就要有完整历史，不必等 SSE 从 seq 0 重放一遍；
 * 2. 用 `afterSeq=lastSeq` 接 `/stream`：服务端只推新的；断线重连由浏览器自带，
 * 它会带上 `Last-Event-ID`，服务端优先用它（见路由）；
 * 3. **按 seq 去重**：重连、代理重放、以及「/log 与 SSE 在边界上重叠」都会造成重复投递，
 * 不去重日志里就会出现两遍同一行。**服务端的 SSE 本身就会回放**`afterSeq` 之后的历史
 * （`streamRowEvents` 的第一件事就是回放，见 api/src/run-stream.ts），所以「/log 拿到的」
 * 与「SSE 回放的」天然重叠——两条来源重叠是**有意**的，去重是客户端的职责；
 * 4. 行进入终态就关连接并 **mutate 一次快照**（SSE 行为要求）：卡片上的分数/耗时/diff 摘要
 * 都来自快照，不刷新就只能等下一次轮询，界面会「明明跑完了还显示执行中」；
 * 5. **同一行重跑 = 新一代，靠「这一次尝试」重挂订阅**：「重跑」前编排层会 `resetEvents` 删掉
 * `events.jsonl`（core/event-log.ts 的口径：删文件而不是写空串，下一次 `appendEvent`
 * 的 seq 自然从 1 开始）。所以调用方必须把**这一次尝试的标识**（`attemptKey`，取行快照的
 * `attempts`）传进来并进 effect 依赖：不传的话 effect 在重跑时一个依赖都没变 ⇒ 连接不重挂，
 * 而连接要么已被终态关掉（`stop()` 之后不会自己回来），要么虽然活着、其续订游标却停在上一代
 * 的水位上——**两种形状都是「重跑之后执行日志一条都不动」**，且连接徽标照旧显示「实时连接中」。
 * 依赖变化会连同 `seenRef` / `minSeqRef` / `lastSeqRef` 一起重置（见 effect 开头），
 * 于是新一轮从 `/log` 全量重放。
 * 序号侧的换代判据（`merge` 里的 `restarts`）仍然保留：浏览器自动重连时用的是
 * `Last-Event-ID`，那条路不经过 effect，重连后可能拿到比已见最小值更小的 seq——
 * 那正是这套判据的另一半。两条判据的分工是「谁负责发现换代」：依赖变化负责重挂，
 * seq 判据负责在同一条连接内识别。
 * 为什么不选「由 UI 在开始/重跑后强制重挂抽屉」：那要把正确性押在「调用方记得重挂」上，
 * 而**任何别的截断路径**（后端清日志、重连后拿到更小的 seq）仍会静默丢事件——
 * 数据层自己该扛住这件事。
 *
 * 实现约定（① 的投递契约在这一层**看不到**了：它整体搬进了抽屉 hub）：
 * · **帧从哪来**：订阅走 `drawer-stream-hub.ts`——一行一个 channel 一条连接，
 *   与 `useRowMessages` 共用（两族帧混在同一条连接上，本 hook 只挑自己那一族）。
 *   原先那四件通用知识（自己 `new EventSource`、逐个 `addEventListener`、按帧形状分流 `error`、
 *   `stop` 里摘监听器）现在只有一份，在 `sse-keyed-hub.ts` 的键控原语里
 *   ——具名事件不进 `onmessage`、`error` 的两个来源、无名帧兜底、引用计数归零关连接。
 * · 本 hook 这一层只剩三件：**筛掉消息 / 子任务行那两族**、**终态后停订阅并刷一次快照**、
 *   以及**换代时重挂订阅**（口径 5：判据仍在 `merge` 的 `restarts` 与 effect 依赖里）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { AgentEventSchema, TERMINAL_ROW_STATUSES, type AgentEvent } from '@aieval/contracts';
import { eventOf, isAgentEventFrame, subscribeDrawerStream } from './drawer-stream-hub';
import { getJson } from './http';
import { RUNS_KEY, runKey, runRowUrl } from './runs';

/**
 * 一条事件是不是「这一行已经结束」：`end` 事件与终态 `status` 事件都算（与 api 侧同一口径）。
 * 导出给 `row-live.ts` 复用：那一条流（实时指标叠加层）也要在终态关掉自己的连接，
 * 两处各写一份判据必然漂移，而漂移的症状是「日志那条关了、指标那条还挂着」。
 */
export function isTerminalEvent(event: AgentEvent): boolean {
  if (event.type === 'end') return true;
  return event.type === 'status' && TERMINAL_ROW_STATUSES.includes(event.status);
}

/**
 * 帧解析：坏帧返回 null（调用方跳过它），绝不让一个畸形帧把整条流打断。
 * 同样导出给 `row-live.ts`：两条流消费的是**同一份** SSE 帧格式，校验规则只能有一份。
 */
export function parseFrame(data: string): AgentEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = AgentEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * `attemptKey` = 「这一行的这一次尝试」（取行快照的 `attempts`）：同一行重跑时它会变，
 * 依赖跟着变才谈得上重挂订阅（口径 5）。一轮之内它恒定——这正是它比 `status` 合适的地方，
 * 后者会在 preparing / running / judging 之间抖几次，每抖一次都要重放一遍历史。
 */
/**
 * 一条事件的**指纹**：换代判据只看「这一批里的 `seq 1` 是不是手上那条」（见 `merge`）。
 *
 * 只取 `at` + `type` 两格，**不逐字序列化整条事件**：同一条事件有两个来源——`GET /log` 那一份
 * （只有事件自己的格）与 SSE 帧那一份（信封上多挂 `rowId` / `rowChannel` 两格，见 hub 的
 * `eventOf`）——整条序列化会把「同一件事的两种写法」判成两条不同的事件。
 * 换代时 `at` 必然不同（两代之间隔着一整轮的时长），而 `seq 1` 在一代里只有一条。
 */
function fingerprintOf(event: AgentEvent): string {
  return `${event.at}|${event.type}`;
}

export function useRowStream(input: { runId: string; rowId: string; enabled: boolean; attemptKey: string }): {
  events: AgentEvent[];
  lastSeq: number;
  connected: boolean;
  error: unknown;
} {
  const { runId, rowId, enabled, attemptKey } = input;
  const { mutate } = useSWRConfig();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 已见过的 seq 与「是否还在监听」都放 ref：SSE 回调不是渲染函数，
  // 读 state 会读到闭包里的旧值（去重会因此失效）
  const seenRef = useRef<Set<number>>(new Set());
  // 已见 seq 的**下界与上界**：前者是「新一代」判据的一半（见 merge），后者给历史续订算 afterSeq。
  // 单独存一份而不从 events 里现算：events 是 state，SSE 回调读到的会是闭包里的旧值。
  const minSeqRef = useRef<number | null>(null);
  const lastSeqRef = useRef(0);
  /**
   * 当前这一代 `seq === 1` 那条事件的**指纹**（换代判据的锚点，见 `merge`）。
   * `null` = 还没收到过 `seq 1`（例如从中间续订）。
   */
  const generationRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || runId === '' || rowId === '') return;

    let cancelled = false;
    /** 本次订阅的退订函数（hub 里引用计数归零即关连接）；没订阅上时为 null */
    let unsubscribe: (() => void) | null = null;
    // 换到另一行时必须丢掉上一行的事件与去重记录，否则新行的 seq 会被当成重复而全部丢弃
    seenRef.current = new Set();
    minSeqRef.current = null;
    lastSeqRef.current = 0;
    generationRef.current = null;
    setEvents([]);
    setConnected(false);
    setError(null);

    /**
     * 合并一批事件：按 seq 去重 + 保持升序；**遇到「新一代」就整体重置**（文件头口径 5）。
     *
     * 新一代的判据（两条，取并集——判据要从宽，漏判的代价是静默丢事件）：
     *   ① 这一批里的 `seq === 1` 是**另一条事件**（内容与手上那条逐字不同）：seq 由 core 的
     *      `appendEvent` 从 1 开始分配，只有清空过日志才会再出现 1；它出现时**整批**都属于新一轮
     *      （新一轮的 1..k 与上一轮的 1..k 同号，逐条比对 seenRef 会把它们全部误判成重复——
     *      所以判据必须在去重**之前**看）。
     *   ② 这一批里还有没见过的、且全部比「已见过的最小 seq」还小：日志被截断后重新发号
     *      （重连后拿到更小的 seq）。
     * 为什么**不**把「任何非单调回退」当判据：重复投递本来就是常态（重连、代理重放、/log 与 SSE
     * 在边界重叠，见口径 3）。最常走的那一条路是**打开抽屉**：先 `GET /log` 拿全量（里面有 `seq 1`），
     * 随后 SSE 从游标 0 逐帧回放**同一份历史**——第一帧又是 `seq 1`，而它与手上那条**逐字相同**，
     * 是重复投递、不是换代。按「只要出现 1 就换代」判，这一帧会把刚拿到的全量整批清掉，
     * 之后只能靠回放一条条重新攒；服务端一旦在历史里遇到终态就关流（追问那一段的事件到不了），
     * 界面就永久停在**截断的历史**上（真机症状：会话总用量停在首段最后那条读数上）。
     * 故 ① 的判据是**内容**（`at` 等逐字相同 ⇒ 同一条事件）：两代之间隔着一整轮的时长，
     * 新一轮的 `seq 1` 不可能与上一代的 `seq 1` 逐字相同。
     * 乱序到达（{3} 之后来 {2}）不触发重置也不被丢弃，照常按 seq 归位。
     */
    const merge = (incoming: AgentEvent[]): void => {
      if (cancelled) return;

      const unseen = incoming.filter((event) => !seenRef.current.has(event.seq));
      // 判据必须在 unseen 之前算：新一轮的 1..k 与上一轮同号，stale 过滤会把它们全吃掉，
      // 于是「出现了 1」这个信号永远看不见（这正是本轮要修的那个静默丢弃）
      const previousMin = minSeqRef.current;
      const head = incoming.find((event) => event.seq === 1);
      const generationChanged =
        head !== undefined && generationRef.current !== null && fingerprintOf(head) !== generationRef.current;
      const restarts =
        generationChanged ||
        (previousMin !== null && unseen.length > 0 && unseen.every((event) => event.seq < previousMin));
      // 换代的锚点跟着**新**那一代走；同一代的重复帧只是把它写回原值
      if (head !== undefined) generationRef.current = fingerprintOf(head);

      if (restarts) {
        // 新一代：上一轮的事件已经不在磁盘上了（resetEvents 删了文件），留着会与新一轮交错
        seenRef.current = new Set();
        minSeqRef.current = null;
        lastSeqRef.current = 0;
        setEvents([]);
      }

      const fresh = restarts ? incoming : unseen;
      if (fresh.length === 0) return;

      // 同一批里也要去重（重置后 seenRef 是空的，同批的两条 seq=1 会一起进来）
      const bySeq = new Map<number, AgentEvent>();
      for (const event of fresh) {
        bySeq.set(event.seq, event);
        seenRef.current.add(event.seq);
      }
      for (const seq of bySeq.keys()) {
        minSeqRef.current = minSeqRef.current === null ? seq : Math.min(minSeqRef.current, seq);
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);
      }
      const accepted = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      setEvents((prev) => [...prev, ...accepted].sort((a, b) => a.seq - b.seq));
    };

    /** 终态之后刷一次快照与列表：卡片上的分数、耗时、diff 摘要都在快照里 */
    const refreshSnapshot = async (): Promise<void> => {
      await mutate(runKey(runId));
      await mutate(RUNS_KEY);
    };

    /**
     * 停掉本 hook 的订阅。**只退自己这一个 sink**：同一条连接上还挂着消息那一条
     * （`useRowMessages` 与它共用「一行一个 channel」的抽屉流），引用计数没归零就不该关连接
     * ——消息那一条本来就比事件多活一会儿（终态之后对话历史仍要能看）。
     */
    const stop = (): void => {
      unsubscribe?.();
      unsubscribe = null;
      setConnected(false);
    };

    /** 一条事件的处理：折叠进 `merge`，终态则停订阅并刷一次快照（口径 4） */
    const handleEvent = (event: AgentEvent): void => {
      if (cancelled) return;
      merge([event]);
      if (isTerminalEvent(event)) {
        stop();
        void refreshSnapshot();
      }
    };

    const connect = (afterSeq: number): void => {
      // 环境没有 EventSource（老浏览器 / 测试）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') {
        setError(new Error('当前环境不支持 EventSource：只能查看已落盘的日志，无法实时追加'));
        return;
      }
      unsubscribe = subscribeDrawerStream(
        runId,
        rowId,
        'candidate',
        {
          // 同一条连接上两族混着来：消息与子任务行那两族归 `useRowMessages`（同一行同一 channel）
          onFrame: (frame) => {
            if (!isAgentEventFrame(frame)) return;
            handleEvent(eventOf(frame));
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
          // 坏帧只跳过它自己，绝不打断整条流（判据在 hub 的 `parse` 里）
          onInvalidFrame: () => setError(new Error('收到无法解析的事件帧，已跳过')),
        },
        afterSeq,
      );
    };

    void (async () => {
      try {
        const history = await getJson<AgentEvent[]>(runRowUrl(runId, rowId, 'log'));
        if (cancelled) return;
        merge(history);
        // afterSeq 用**已交付的最大 seq**（刚 merge 过历史，它等于历史的最大值）
        connect(lastSeqRef.current);
      } catch (cause) {
        // /log 都拿不到（例如行 id 不存在）就不必接 SSE 了：接上也只会立刻收到错误
        if (!cancelled) {
          setError(cause);
          setConnected(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [enabled, runId, rowId, attemptKey, mutate]);

  const lastSeq = useMemo(() => events.reduce((max, event) => Math.max(max, event.seq), 0), [events]);

  return { events, lastSeq, connected, error };
}
