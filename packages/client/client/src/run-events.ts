/**
 * 列表重验的客户端：把**全局流**上的信号接到 SWR 重验上（节流窗口、按键去重、重连补一次）。
 *
 * 「不要来回刷新」的用户口径落在这里：
 * · **重验由信号驱动**：服务端 `saveRun` 落盘一次 ⇒ 这里收到一条 `run-updated` ⇒
 * 重读列表与详情的 REST——状态翻转从「每 3 秒问一次」变成「变了才读」；
 * · **连接全页一条**：`useRuns` 与 `useRun` 都挂这个 hook，但连接由 `global-stream-hub.ts`
 * 的模块级单例持有，与待答快照、人工消息队列两族信号共用——页面挂载期间恰好一条连接、空闲零连接；
 * · **信号不携带快照**（服务端 `run-events.ts` 口径的客户端镜像）：收到的是「这一轮变了」，
 * 内容一律走 `getJson` 重读——帧里的内容在乱序时是第二份真相。
 *
 * 两族信号都触发重验：`run-updated`（`run.json` 落盘成功）与 `ask-user-changed`（挂起表变了）。
 * 后者也要刷列表，因为列表与详情都要显示「哪一轮在等人答」（`pendingAskCount` 就在同一份快照里）；
 * 而 `inject-messages-changed` 不在此列——人工消息队列的变更与 run 视图无关。
 *
 * 刻意**不返回连接状态**：页面没有为这条通道画徽标的诉求（连接故障有慢兜底与焦点重验兜着，
 * 如实降级、无需展示），返回一个「不会触发重渲染的假状态」只会诱导消费方拿它做判据。
 */
import { useEffect } from 'react';
import { useSWRConfig } from 'swr';
import { subscribeGlobalStream, type GlobalStreamFrame } from './global-stream-hub';
import { RUNS_KEY, runKey } from './run-keys';

/**
 * 信号重验的节流窗口（毫秒），可变对象（仓库约定，同 `LIVE_TEXT_SAMPLE` / `TEXT_API_RETRY`）：
 * 用例把它调小以免每条用例真等 300ms，**产品默认值有独立用例钉住**、`afterEach` 还原。
 *
 * 为什么要有这个窗口：一次状态翻转链上可能连着两三笔 saveRun（候选状态 → 评分 → 终态），
 * 逐条重验等于把「一拍内的三笔」放大成三次全量读；攒到窗口末尾读一次，拿到的就是终值。
 */
export const RUN_SIGNAL_DEBOUNCE = { debounceMs: 300 };

/**
 * 一个订阅者向共享层声明的重验范围。
 * 存声明（mutate + 哪一轮的详情被打开）而不是存不透明回调：flush 要按**键去重**——
 * 页面同时挂 useRuns 与 useRun 时，闭包式 sink 会把一次信号放大成两次列表读
 *（实测两次 `mutate(同键)` 不被 SWR 合并），而「列表恒一次 + 详情按 runId 一次」
 * 只有把键摊开在共享层才做得到。
 */
interface Sink {
  /** 这一份声明的 mutate（来自订阅 hook 自己的 `useSWRConfig()`） */
  mutate: (key: string) => void;
  /** 该 hook 当前打开的详情轮 id；`null` = 只订阅列表（列表键不用声明、恒在重验范围里） */
  currentRunId: string | null;
}

/** 模块级共享状态：节流窗口与各订阅者的声明（连接本身归 `global-stream-hub.ts`） */
interface SharedRunEvents {
  /** 节流定时器：窗口内第一条信号挂起它，窗口末尾统一重验 */
  debounce: ReturnType<typeof setTimeout> | null;
  /** 窗口内已有信号、还没重验（flush 的判据：没信号就不空转） */
  pending: boolean;
  /** 各订阅者的声明 */
  sinks: Set<Sink>;
}

const shared: SharedRunEvents = { debounce: null, pending: false, sinks: new Set() };

/** 把当前累积的信号重验掉（窗口到期 / 重连成功两个入口共用）。没信号时是空操作。 */
function flushSinks(): void {
  shared.debounce = null;
  if (!shared.pending) return;
  shared.pending = false;
  // 复制一份再展开：effect 清理可能正好在遍历中退订（unmount 时序），直接遍历原集合会跳项
  const entries = [...shared.sinks];
  if (entries.length === 0) return;
  // 列表键**只发一次**：页面同时挂 useRuns 与 useRun（评测页的常态）时，每个订阅者
  // 各 mutate 一遍列表键就是「一次信号两次读」——重验的是同一份快照，第二次纯属浪费。
  // mutate 取第一个订阅者的（生产页面只有一个 SWR 上下文，谁的都是同一个缓存）；
  // 解构 + 判空是给 noUncheckedIndexedAccess 的：集合非空在上一行已保证。
  const [listMutator] = entries;
  if (listMutator !== undefined) listMutator.mutate(RUNS_KEY);
  // 详情键按 runId 去重：同一轮即使被两个 hook 打开（罕见）也只读一次
  const mutatorByRunId = new Map<string, Sink['mutate']>();
  for (const entry of entries) {
    if (entry.currentRunId !== null && !mutatorByRunId.has(entry.currentRunId)) {
      mutatorByRunId.set(entry.currentRunId, entry.mutate);
    }
  }
  for (const [runId, mutate] of mutatorByRunId) mutate(runKey(runId));
}

/**
 * 收一条信号：攒到窗口末尾统一重验。
 * 窗口内后续的信号只刷新 `pending`、不再另起窗口（一拍多笔 saveRun 合并成一次重验）。
 */
function onSignal(): void {
  shared.pending = true;
  if (shared.debounce !== null) return;
  shared.debounce = setTimeout(flushSinks, RUN_SIGNAL_DEBOUNCE.debounceMs);
}

/**
 * 这一帧要不要触发列表 / 详情重验：`run-updated`（落盘成功）与 `ask-user-changed`（挂起表变了，
 * 列表与详情的待答徽标读的是同一份快照）都要；`inject-messages-changed` 与 run 视图无关。
 */
function shouldRevalidate(frame: GlobalStreamFrame): boolean {
  return frame.type === 'run-updated' || frame.type === 'ask-user-changed';
}

/** 测试复位：把节流窗口与订阅者声明清回初始（连接归 `resetGlobalStreamHubForTesting`） */
export function resetRunEventsForTesting(): void {
  if (shared.debounce !== null) clearTimeout(shared.debounce);
  shared.debounce = null;
  shared.pending = false;
  shared.sinks.clear();
}

/**
 * 订阅全局流的信号，按信号重验缓存。
 *
 * `currentRunId` **只在详情打开时给**（列表页挂本 hook 时传 null / 缺省）：重验范围 =
 * 列表键恒在 + 当前打开那一轮的详情键。一次信号 = 页面上两处可见的视图各重验一次，
 * 不多不少；列表视图（状态列、候选数、待答数）与详情视图（候选状态、评分、排名）读的是同一份快照，
 * 别处一概不需要动。
 */
export function useRunEvents(input: { currentRunId?: string | null }): void {
  const { mutate } = useSWRConfig();
  const currentRunId = input.currentRunId ?? null;

  useEffect(() => {
    // 注册的是「声明」而不是不透明回调（见 Sink 的注释：flush 要按键去重）。
    // mutate 包一层：`useSWRConfig().mutate` 是重载签名，这里只需要「按键重验」这一个用法
    const sink: Sink = { mutate: (key) => void mutate(key), currentRunId };
    shared.sinks.add(sink);
    const off = subscribeGlobalStream({
      onFrame: (frame) => {
        if (shouldRevalidate(frame)) onSignal();
      },
      // **只有重连才把「连上」当信号补一次重验**：断线期间的服务端信号永远收不到了，
      // 与其等下一次翻转（可能几分钟），不如把重连本身当作一条信号。
      // 首次连接不补：页面自己的首拉（useRuns/useRun 的初次 GET）就在同一瞬间，再补一刀是纯重复请求
      onReconnect: () => {
        shared.pending = true;
        flushSinks();
      },
    });

    return () => {
      shared.sinks.delete(sink);
      off();
    };
  }, [mutate, currentRunId]);
}
