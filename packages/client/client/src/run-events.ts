/**
 * run 级信号流的客户端：一条**模块级共享**的 SSE 连接 + 按信号重验缓存。
 *
 * 「不要来回刷新」的用户口径落在这里：
 * · **重验由信号驱动**：服务端 `saveRun` 落盘一次 ⇒ 这里收到一条 `run-updated` ⇒
 * 重读列表与详情的 REST——状态翻转从「每 3 秒问一次」变成「变了才读」；
 * · **连接全页一条**：`useRuns`与 `useRun`都挂这个 hook，但连接
 * 由模块级单例持有、引用计数管理——最后一个订阅者退订才关流。页面挂载期间
 * 恰好一条连接，空闲零连接；
 * · **信号不携带快照**（服务端 run-events.ts 口径 1 在客户端的镜像）：收到的是
 * 「这一轮变了」，内容一律走 `getJson` 重读——帧里的内容在乱序时是第二份真相。
 *
 * 与三条行级流（row-stream / row-messages / row-live）的三处**刻意不同**：
 * 1. **模块级单例**而不是「一 hook 一连接」：行级流的订阅范围由「哪一行在抽屉里」
 * 决定（hook 生命周期正好就是连接生命周期），而这条流是页面级的——列表与详情
 * 共用，挂到哪个 hook 上都会变成两条；两条流各自 mutate 同一批键，每次翻转
 * 重验两遍，白翻一倍请求；
 * 2. **没有 afterSeq / 重放语义**：信号是瞬时提示（run-signals.ts 口径 3），断线重连
 * 从「当下」开始即可——错过的那几条由重连后的首次重验与慢兜底补齐；
 * 3. **EventSource 的重连由浏览器自己带**：这里不手写退避。连接故障的表现是
 * 「这一刻的重验没发生」，慢兜底与 SWR 焦点重验都在，如实降级即可。
 */
import { useEffect } from 'react';
import { useSWRConfig } from 'swr';
import { RUNS_KEY, runKey } from './run-keys';

/** run 级信号流的端点：与路由 `apps/web-next/app/api/runs/events/route.ts` 同形 */
const RUNS_EVENTS_URL = '/api/runs/events';

/**
 * 信号重验的节流窗口（毫秒），可变对象（仓库约定，同 `LIVE_TEXT_SAMPLE` / `TEXT_API_RETRY`）：
 * 用例把它调小以免每条用例真等 300ms，**产品默认值有独立用例钉住**、`afterEach` 还原。
 *
 * 为什么要有这个窗口：一次状态翻转链上可能连着两三笔 saveRun（行状态 → 评分 → 终态），
 * 逐条重验等于把「一拍内的三笔」放大成三次全量读；攒到窗口末尾读一次，拿到的就是终值。
 */
export const RUN_SIGNAL_DEBOUNCE = { debounceMs: 300 };

/** 模块级共享连接的状态（单例的字段；为什么挂模块级见文件头口径 1） */
interface SharedRunEvents {
  /** 浏览器原生连接；`null` = 从未创建、已关闭、或环境没有 EventSource */
  source: EventSource | null;
  /** 当前挂着的订阅者数（每个 hook 实例 +1）；归零即关流 */
  refCount: number;
  /** 节流定时器：窗口内第一条信号挂起它，窗口末尾统一重验 */
  debounce: ReturnType<typeof setTimeout> | null;
  /** 窗口内已有信号、还没重验（flush 的判据：没信号就不空转） */
  pending: boolean;
  /** 各订阅者的声明（mutate 来自它自己的 SWR 上下文；列表键恒在、详情键按需） */
  sinks: Set<Sink>;
  /** 是否已经完成过一次连接（首次 onopen 不重验：页面自己的首拉刚发过，别再补一刀） */
  openedOnce: boolean;
}

/**
 * 一个订阅者向共享连接声明的重验范围。
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

/** 见文件头口径 1：模块级单例——页面只有一条连接，无论挂多少个 hook 实例 */
const shared: SharedRunEvents = {
  source: null,
  refCount: 0,
  debounce: null,
  pending: false,
  sinks: new Set(),
  openedOnce: false,
};

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

/** 确保共享连接存在（订阅者从 0 → 1 时创建一次） */
function ensureSource(): void {
  if (shared.source !== null) return;
  // 环境没有 EventSource（老浏览器 / 测试替身缺失）时不能抛：少了信号重验，
  // 慢兜底与焦点重验仍在，界面只是晚一拍，不是坏掉
  if (typeof EventSource === 'undefined') return;
  const source = new EventSource(RUNS_EVENTS_URL);
  shared.source = source;
  source.onopen = () => {
    // **只有重连才把「连上」当信号补一次重验**：断线期间的服务端信号永远收不到了，
    // 与其等下一次翻转（可能几分钟），不如把重连本身当作一条信号。
    // 首次连接不补：页面自己的首拉（useRuns/useRun 的初次 GET）就在同一瞬间，
    // 再补一刀是纯重复请求。
    if (shared.openedOnce) {
      shared.pending = true;
      flushSinks();
    }
    shared.openedOnce = true;
  };
  source.addEventListener('run-updated', (event) => {
    // 帧解不动就跳过（与行级流的 parseFrame 同一条口径：坏帧不许打断流）。
    // 只验证「是一帧 JSON」，不取内容——重验范围由键决定，信号不携带快照（文件头口径 1）。
    try {
      JSON.parse((event as MessageEvent).data);
    } catch {
      return;
    }
    shared.pending = true;
    // 窗口内后续的信号只刷新 pending，不再另起窗口（一拍多笔 saveRun 合并成一次重验）
    if (shared.debounce !== null) return;
    shared.debounce = setTimeout(flushSinks, RUN_SIGNAL_DEBOUNCE.debounceMs);
  });
}

/** 关掉共享连接（订阅者归零时）；定时器一并清掉——挂着没人消费的重验是纯浪费 */
function closeSourceIfIdle(): void {
  if (shared.refCount > 0) return;
  shared.source?.close();
  shared.source = null;
  if (shared.debounce !== null) {
    clearTimeout(shared.debounce);
    shared.debounce = null;
  }
  shared.pending = false;
  // `openedOnce` 不复位：单例关掉再重开是新的一次连接，但页面语义没变——
  // 「首拉已发过、别再补一刀」对同一个页面会话仍然成立
}

/** 测试复位：把模块级单例清回初始（用例之间互不串连接与重验回调） */
export function resetRunEventsForTesting(): void {
  shared.source?.close();
  shared.source = null;
  shared.refCount = 0;
  shared.debounce = null;
  shared.pending = false;
  shared.sinks.clear();
  shared.openedOnce = false;
}

/**
 * 订阅 run 级信号，按信号重验缓存。
 *
 * `currentRunId` **只在详情打开时给**（列表页挂本 hook 时传 null / 缺省）：重验范围 =
 * 列表键恒在 + 当前打开那一轮的详情键。`run-updated` 一次 = 页面上两处可见的
 * 视图各重验一次，不多不少；列表视图（状态列、候选数）与详情视图（行状态、评分、
 * 排名）读的是同一份快照，别处一概不需要动。
 *
 * 刻意**不返回连接状态**：页面没有为这条通道画徽标的诉求（连接故障有慢兜底与焦点
 * 重验兜着，如实降级、无需展示），返回一个「不会触发重渲染的假状态」只会诱导消费方
 * 拿它做判据。将来真要展示时再把它做成真正的 state（onopen/onerror 触发重渲染）。
 */
export function useRunEvents(input: { currentRunId?: string | null }): void {
  const { mutate } = useSWRConfig();
  const currentRunId = input.currentRunId ?? null;

  useEffect(() => {
    // 注册的是「声明」而不是不透明回调（见 Sink 的注释：flush 要按键去重）。
    // mutate 包一层：`useSWRConfig().mutate` 是重载签名，这里只需要「按键重验」这一个用法
    const sink: Sink = { mutate: (key) => void mutate(key), currentRunId };
    shared.sinks.add(sink);
    shared.refCount += 1;
    ensureSource();

    return () => {
      shared.sinks.delete(sink);
      shared.refCount -= 1;
      closeSourceIfIdle();
    };
  }, [mutate, currentRunId]);
}
