/**
 * 一行的实时事件流：`/log` 补历史 + `/stream` 按 seq 续订。
 * 四条口径（spec §8 的 SSE 订阅行为要求）：
 *   1. **首帧先拉 `/log`**：抽屉一打开就要有完整历史，不必等 SSE 从 seq 0 重放一遍；
 *   2. 用 `afterSeq=lastSeq` 接 `/stream`：服务端只推新的；断线重连由浏览器自带，
 *      它会带上 `Last-Event-ID`，服务端优先用它（见路由 Task 10）；
 *   3. **按 seq 去重**：重连、代理重放、以及「/log 与 SSE 在边界上重叠」都会造成重复投递，
 *      不去重日志里就会出现两遍同一行。**服务端的 SSE 本身就会回放** `afterSeq` 之后的历史
 *      （`streamRowEvents` 的第一件事就是回放，见 api/src/run-stream.ts），所以「/log 拿到的」
 *      与「SSE 回放的」天然重叠——两条来源重叠是**有意**的，去重是客户端的职责；
 *   4. 行进入终态就关连接并 **mutate 一次快照**（spec §8.3）：卡片上的分数/耗时/diff 摘要
 *      都来自快照，不刷新就只能等下一次轮询，界面会「明明跑完了还显示执行中」；
 *   5. **同一行重跑 = 新一代**（R27 的客户端缺口）：「重跑」前编排层会 `resetEvents` 删掉
 *      `events.jsonl`（core/event-log.ts 的口径：删文件而不是写空串，下一次 `appendEvent`
 *      的 seq 自然从 1 开始），而抽屉一直开着时本 hook 的 effect 依赖
 *      `[enabled, runId, rowId, mutate]` 一个都没变 ⇒ **连接不会重挂**，新一轮的事件仍从
 *      同一条 SSE 推来。此时上一轮的 `seenRef`（{1,2,3}）会把新一轮的头几条当成重复
 *      **静默丢弃**——用户看到「日志缺头」。所以 seq 回到 1（或整批都比已见的最小 seq 还小）
 *      时按**新一代**处理：清空去重记录与已交付事件，后续事件正常交付。
 *      为什么不选「由 UI 在开始/重跑后强制重挂抽屉」：那要把正确性押在「调用方记得重挂」上，
 *      而**任何别的截断路径**（后端清日志、重连后拿到更小的 seq）仍会静默丢事件——
 *      数据层自己该扛住这件事。
 *
 * 实现约定（**R38 ① 的投递契约**，p5 阶段评审 C1 的根因）：
 *   · `onopen` 用属性赋值；
 *   · **事件帧一律按事件名订阅**：api 的 `toFrame` 发的是 SSE **具名**事件
 *     （`packages/server/api/src/run-stream.ts` 的 `event: <type>`），而规范规定
 *     `EventSource.onmessage` **只收默认（无名）事件** ⇒ 只绑 `onmessage` 等于**零交付**
 *     （7 种事件在真实浏览器里一个接收者都没有；历史靠 `/log`、终态靠轮询兜底，
 *     症状只表现为「实时通道没有」，因此曾长期不被发现）。
 *     类型清单取 contracts 的 `AGENT_EVENT_TYPES`（**不抄第二份**），逐个 `addEventListener`；
 *     `onmessage` 保留为无名帧的兜底（服务端若不发 `event:` 行也照样能用）；
 *   · **`error` 是唯一的例外，但它不再是「不交付」**（终审 H4）：这个类型名在 `EventSource` 上
 *     既是内置的连接失败事件、又是 `AgentEvent` 的合法类型，两个来源都落在 `error` 监听位上。
 *     故它不进 `addEventListener` 表，而是由 `onerror` 按帧形状分流——**带 `data` 的是服务端帧、
 *     走正常解析与 merge；不带 `data` 的才是连接故障**。详见 `connect()` 里 `onerror` 的注释。
 *   · `stop()` 里**移除**监听器：终态关流与卸载都要摘干净，否则替身/浏览器上都留着悬挂引用。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { AGENT_EVENT_TYPES, AgentEventSchema, TERMINAL_ROW_STATUSES, type AgentEvent } from '@aieval/contracts';
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

export function useRowStream(input: { runId: string; rowId: string; enabled: boolean }): {
  events: AgentEvent[];
  lastSeq: number;
  connected: boolean;
  error: unknown;
} {
  const { runId, rowId, enabled } = input;
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

  useEffect(() => {
    if (!enabled || runId === '' || rowId === '') return;

    let cancelled = false;
    let source: EventSource | null = null;
    /** 本次连接挂上去的具名监听器：`stop()` 要按同一对 (类型, 函数) 摘掉它们 */
    const namedListeners: Array<{ type: string; listener: (event: MessageEvent) => void }> = [];
    // 换到另一行时必须丢掉上一行的事件与去重记录，否则新行的 seq 会被当成重复而全部丢弃
    seenRef.current = new Set();
    minSeqRef.current = null;
    lastSeqRef.current = 0;
    setEvents([]);
    setConnected(false);
    setError(null);

    /**
     * 合并一批事件：按 seq 去重 + 保持升序；**遇到「新一代」就整体重置**（文件头口径 5）。
     *
     * 新一代的判据（两条，取并集——判据要从宽，漏判的代价是静默丢事件）：
     *   ① 这一批里出现 seq === 1：seq 由 core 的 `appendEvent` 从 1 开始分配，只有清空过日志
     *      才会再出现 1；它出现时**整批**都属于新一轮（新一轮的 1..k 与上一轮的 1..k 同号，
     *      逐条比对 seenRef 会把它们全部误判成重复——所以判据必须在去重**之前**看）。
     *   ② 这一批里还有没见过的、且全部比「已见过的最小 seq」还小：日志被截断后重新发号
     *      （重连后拿到更小的 seq）。
     * 为什么**不**把「任何非单调回退」当判据：重复投递本来就是常态（重连、代理重放、/log 与 SSE
     * 在边界重叠，见口径 3），而重连后服务端可能把边界那条**再推一遍**——seq 等于上界是重复，
     * 不是新轮；只有「严格小于已见最小值」才是真的换了一轮。乱序到达（{3} 之后来 {2}）同理：
     * 2 落在 [min,max] 内，既不触发重置也不被丢弃，照常按 seq 归位。
     * 副作用（如实登记）：若**同一轮内**真的重复投递了 `seq === 1`，会多走一次重置——
     * 代价是 events 被清成那一批。这种投递在服务端「按 seq 去重、不主动制造重复帧」的口径下
     * 不会发生（而每行一轮只会有一条 seq===1），可接受。
     */
    const merge = (incoming: AgentEvent[]): void => {
      if (cancelled) return;

      const unseen = incoming.filter((event) => !seenRef.current.has(event.seq));
      // 判据必须在 unseen 之前算：新一轮的 1..k 与上一轮同号，stale 过滤会把它们全吃掉，
      // 于是「出现了 1」这个信号永远看不见（这正是本轮要修的那个静默丢弃）
      const previousMin = minSeqRef.current;
      const restarts =
        incoming.some((event) => event.seq === 1) ||
        (previousMin !== null && unseen.length > 0 && unseen.every((event) => event.seq < previousMin));

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

    const stop = (): void => {
      if (source === null) return;
      // 先摘监听器再关连接：顺序反过来也不出错，但「连接已关、监听器还挂着」在
      // 真实浏览器里会保留整条闭包链（含 merge/refreshSnapshot），是纯泄漏
      for (const { type, listener } of namedListeners) source.removeEventListener(type, listener);
      namedListeners.length = 0;
      source.close();
      source = null;
      setConnected(false);
    };

    const connect = (afterSeq: number): void => {
      // 环境没有 EventSource（老浏览器 / 测试）时不能抛：历史仍然可用，只是不再实时
      if (typeof EventSource === 'undefined') {
        setError(new Error('当前环境不支持 EventSource：只能查看已落盘的日志，无法实时追加'));
        return;
      }
      const next = new EventSource(`${runRowUrl(runId, rowId, 'stream')}?afterSeq=${afterSeq}`);
      source = next;
      next.onopen = () => {
        setConnected(true);
        setError(null);
      };

      /** 一帧的处理：与「具名」还是「无名」无关，两种订阅路径共用（口径写在文件头） */
      const handleFrame = (event: MessageEvent): void => {
        if (cancelled) return;
        const parsed = parseFrame(String(event.data));
        if (parsed === null) {
          setError(new Error('收到无法解析的事件帧，已跳过'));
          return;
        }
        merge([parsed]);
        if (isTerminalEvent(parsed)) {
          stop();
          void refreshSnapshot();
        }
      };

      /**
       * `error` 这个类型名在 `EventSource` 上有**两个来源**，必须按帧的形状分开处置
       * （终审 H4：原先无条件当连接故障，服务端发的具名 `error` 事件被整个丢掉，
       * 而真实浏览器里每个失败行还会多显示一句假的中断提示）：
       *
       *   - **服务端发的具名 `error` 帧**（`event: error` + `data: {...}`）：api 的 `toFrame`
       *     （`packages/server/api/src/run-stream.ts`）对事件类型**没有任何过滤**，而
       *     `type: 'error'` 的 `AgentEvent` 确实会被发布（编排层的 `settleStopped`/`settleFailed`、
       *     agents 侧 `turn.ts` via `emit.ts`）⇒ **必然成帧**。它按 SSE 规范派发到 `EventSource`
       *     的 `error` 监听位，而 `onerror` **就是** `error` 的 event handler ⇒ 走到这里。
       *     判据用 `typeof data === 'string'`：只有带 `data` 的 `MessageEvent` 才是帧
       *     （`FakeMessageEvent.data` 与真实 `MessageEvent.data` 都是字符串）。
       *   - **连接故障**：浏览器派发的是**没有 `data`** 的普通 `Event` ⇒ 才按「会自动重连」处置。
       *     这一支保留原因为什么重要：把它换成「收到无法解析的事件帧」会让真正的原因消失。
       */
      next.onerror = (event: Event) => {
        const data = (event as MessageEvent).data;
        if (typeof data === 'string') {
          handleFrame(event as MessageEvent);
          return;
        }
        // 浏览器会自动重连（带 Last-Event-ID），这里如实反映状态即可
        setConnected(false);
        setError(new Error('实时日志连接中断：浏览器会自动重连，已收到的日志不受影响'));
      };

      // R38 ①：api 发的是具名事件（`event: <type>`），必须按事件名订阅。
      // 类型清单取 contracts，不抄第二份——加一种事件类型时这里自动跟随。
      // **`error` 仍不进这张表**：它的 `onerror` 属性已经被上面那个「按帧形状分流」的处理器占用，
      // 再 `addEventListener('error')` 会因为替身/浏览器把两条路都触发而**双投一帧**；
      // 而服务端发的具名 `error` 帧本来就走到 `onerror` 里，交付不会因此缺失（见上面的分流注释）。
      for (const type of AGENT_EVENT_TYPES) {
        if (type === 'error') continue;
        namedListeners.push({ type, listener: handleFrame });
        next.addEventListener(type, handleFrame);
      }
      // 无名帧的兜底：服务端哪天不发 `event:` 行了也照样能收（规范里 `onmessage` 只收这种）
      next.onmessage = handleFrame;
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
  }, [enabled, runId, rowId, mutate]);

  const lastSeq = useMemo(() => events.reduce((max, event) => Math.max(max, event.seq), 0), [events]);

  return { events, lastSeq, connected, error };
}
