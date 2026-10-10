/**
 * 评测数据层：键、慢兜底开关、信号驱动的重验、四个动作的请求与回写、产物按需读取、候选池。
 * 重点在两条容易被写错、写错了界面表现又很隐蔽的约定：
 * 1. **实时性由 run 信号驱动、轮询只剩 60 秒慢兜底**——
 * 「3 秒快轮询已经删除」本身有守卫，信号帧到达必须立刻重验；
 * 慢兜底只在有 running 时开、跑完必须停；
 * 2. mutation 成功后要写进缓存且**不得**被随后的 GET 覆盖（沿用 useSettings 的回写约定）。
 *
 * 假定时器显式列出 `toFake`：只替换 setTimeout/setInterval/Date，不碰 queueMicrotask 与
 * nextTick——SWR 的请求链是 Promise 驱动的，把微任务也冻结掉会让用例假死。
 *
 * 两条读用例的通用结构：
 * - 需要跨 hook 观察「刷新了谁」的用例，必须把相关 hook 挂在**同一个 renderHook**里：
 * `SWRConfig` 的 `provider` 是按组件树建的缓存，分开 `renderHook` 会各拿一份缓存，
 * `mutate(key)` 便找不到另一个缓存上的消费者（真实页面里它们同在一个 provider 下）；
 * - 数请求一律**按方法**数（`countGets`）：`/api/runs` 同时是列表 GET 与创建 POST 的目标，
 * 只按 URL 数会让「列表被刷新了一次」被创建请求蒙混过关——那是一条空转的守卫。
 *
 * 信号用例的替身：`FakeEventSource`（`testing/event-source.ts`）只装在**用到它的用例里**，
 * 不进共享 setup——`useRunEvents` 有「环境没有 EventSource 就静默降级」的分支，
 * 全局注入会让那条分支永远不可达（与 `resize-observer.ts` 不共享是同一个理由）。
 * 模块级共享连接（run-events.ts 的单例）在用例之间必须复位：`resetRunEventsForTesting()`。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { EFFORT_OFF, type RunUpdate } from '@aieval/contracts';
import {
  AGENT_OPTIONS_KEY,
  RUNS_KEY,
  runKey,
  runRowUrl,
  useAbortRow,
  useAbortRun,
  useCreateRun,
  useDeleteRun,
  useRowDiffFile,
  useRowDiffIndex,
  useRowLog,
  useRun,
  useRunModelOptions,
  useRuns,
  useStartRun,
  useUpdateRun,
  type AgentModelOption,
  type AgentOptionGroup,
} from './runs';
import { useCases } from './cases';
import { resetRunEventsForTesting } from './run-events';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeRow, makeRun } from './testing/run-fixtures';

/** fetch 替身的签名：显式写出来，`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 直接报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/**
 * 焦点重验的专用 wrapper：默认的 `focusThrottleInterval`（5s）与 `dedupingInterval`（2s）
 * 会把焦点事件静默吞掉，于是「没发请求」既可能是真的关掉了、也可能是被节流了——
 * 两个窗口都置 0，断言才有区分力（与 useCommitCandidates 用例同一手法）。
 */
const focusWrapper = ({ children }: { children: ReactNode }) =>
  createElement(
    SWRConfig,
    { value: { provider: () => new Map(), focusThrottleInterval: 0, dedupingInterval: 0 } },
    children,
  );

/** 挂载请求可能是微任务、也可能是 0ms 定时器；推进 0ms 把它冲出来，免得它被算成一次轮询 */
async function flushMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** 焦点事件是异步派发的：等一拍；重验若开着，这一拍内必然多出一次请求 */
async function settleFocus(): Promise<void> {
  await act(async () => {
    fireEvent.focus(window);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

/** 一次 `Response` 的简写（用例里到处都在造响应） */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 装一个 fetch 替身：不碰真实网络（单测的硬规则） */
function stubFetch(handler: FetchHandler): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 数一数某个 URL 的某个方法被请求了几次 */
function countCalls(fetchMock: FetchMock, url: string, method = 'GET'): number {
  return fetchMock.mock.calls.filter(
    ([called, init]) => String(called) === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method,
  ).length;
}

/** 只数 GET，见文件头第二条 */
function countGets(fetchMock: FetchMock, url: string): number {
  return countCalls(fetchMock, url, 'GET');
}

/** 用例里最常见的替身：列表 GET 返回数组、详情 GET 返回单轮、动作端点返回单轮、其余 404 */
function stubRunRoutes(overrides: { list?: unknown; detail?: unknown } = {}): FetchMock {
  return stubFetch(async (url: string, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';
    if (target === RUNS_KEY && method === 'POST') return json(makeRun(), 201);
    if (target === RUNS_KEY) return json(overrides.list ?? [makeRun()]);
    if (target === '/api/runs/run-1' && method === 'GET') return json(overrides.detail ?? makeRun());
    // start / abort / rows/{id}/abort 三个动作端点
    if (target.startsWith('/api/runs/run-1/')) return json(makeRun());
    return json({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }, 404);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // run-events 的共享连接是模块级单例：不复位会把上一个用例的 EventSource 实例与
  // 重验回调带进来（FakeEventSource.reset 只清替身自己的记录，清不到这个单例）
  resetRunEventsForTesting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('键与端点', () => {
  it('键就是真实路由 URL（字面量散落必然漂移，而漂移的表现是「安静地拿不到数据」）', () => {
    expect(RUNS_KEY).toBe('/api/runs');
    expect(runKey('run-1')).toBe('/api/runs/run-1');
    expect(runRowUrl('run-1', 'w-1', 'diff')).toBe('/api/runs/run-1/rows/w-1/diff');
    expect(runRowUrl('run-1', 'w-1', 'log')).toBe('/api/runs/run-1/rows/w-1/log');
    expect(runRowUrl('run-1', 'w-1', 'stream')).toBe('/api/runs/run-1/rows/w-1/stream');
    expect(AGENT_OPTIONS_KEY).toBe('/api/runs/model-options');
  });
});

describe('useRuns', () => {
  it('挂载后拉到列表，键是 /api/runs', async () => {
    const fetchMock = stubRunRoutes();

    const { result } = renderHook(() => useRuns(), { wrapper });
    await flushMount();

    expect(result.current.runs).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs');
  });

  it('有 running 的行时**不再有 3 秒快轮询**：3 秒内零请求（实时性已由信号通道承担）', async () => {
    // 「不要来回刷新」的用户口径落到这条守卫上：把 3 秒轮询放回去时，
    // 这里必须红——它是本次改造的回归门。
    const fetchMock = stubFetch(async () =>
      json([makeRun({ status: 'running', rows: [makeRow({ status: 'running' })] })]),
    );

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('有活在跑时只开 60 秒慢兜底：60 秒整点补一次，跑完立刻停', async () => {
    const fetchMock = stubFetch(async () =>
      json([makeRun({ status: 'running', rows: [makeRow({ status: 'running' })] })]),
    );

    const { result } = renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 59.999 秒：还不到兜底整点
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 下一次拉回来的是「已完成」：兜底必须关掉，否则开着的页面会永远打接口
    fetchMock.mockImplementation(async () => json([makeRun()]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const afterFinish = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock.mock.calls.length).toBe(afterFinish);
    expect(result.current.runs?.[0]?.status).toBe('done');
  });

  it('一轮都没在跑时完全不轮询（连慢兜底都不开）', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('信号帧到达即重验列表（「变了才读」，不等任何轮询）', async () => {
    FakeEventSource.reset();
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    // 服务端落了一次盘：SSE 推一条 run-updated ⇒ 客户端立刻重读列表。
    // 推进一个节流窗口（300ms 是产品默认值），mutate 的 promise 链随之冲出来
    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe('/api/runs/events');
    await act(async () => {
      source?.emitNamed('run-updated', JSON.stringify({ runId: 'run-1' }));
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
  });

  it('行还在跑（轮状态还没翻）时也要开慢兜底：编排层翻转轮状态有一拍延迟', async () => {
    const fetchMock = stubFetch(async () => json([makeRun({ status: 'idle', rows: [makeRow({ status: 'judging' })] })]));

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('useRun', () => {
  it('id 为 null 时不发请求（右栏未打开）', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRun(null), { wrapper });
    await flushMount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('id 给了就拉 /api/runs/{id}', async () => {
    const fetchMock = stubFetch(async () => json(makeRun({ id: 'run-9' })));

    const { result } = renderHook(() => useRun('run-9'), { wrapper });
    await flushMount();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs/run-9');
    expect(result.current.run?.id).toBe('run-9');
  });

  it('还有活在跑时详情只开 60 秒慢兜底（信号通道断掉时靠它兜底）', async () => {
    const fetchMock = stubFetch(async () => json(makeRun({ status: 'running', rows: [makeRow({ status: 'running' })] })));

    renderHook(() => useRun('run-1'), { wrapper });
    await flushMount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(57_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('四个动作', () => {
  it('create 发 POST /api/runs，把响应写进详情缓存并显式刷新列表', async () => {
    const created = makeRun({ id: 'run-new' });
    const fetchMock = stubFetch(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json(created, 201);
      if (String(url) === '/api/runs/run-new') return json(created);
      return json([created]);
    });

    // 三个 hook 必须挂在**同一个** renderHook 里：SWRConfig 的 provider 是按组件树建的缓存，
    // 分开 renderHook 会各拿一份缓存，写操作里的 `mutate(key)` 就找不到另一个缓存上的消费者
    const { result } = renderHook(
      () => ({ list: useRuns(), detail: useRun('run-new'), create: useCreateRun() }),
      { wrapper },
    );
    await flushMount();
    expect(countGets(fetchMock, '/api/runs')).toBe(1);
    expect(countGets(fetchMock, '/api/runs/run-new')).toBe(1);

    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code' as const, providerId: 'p-1', modelId: 'm-1' }],
    };
    await act(async () => {
      await result.current.create.create(input);
    });

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post?.[0]).toBe('/api/runs');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual(input);
    // revalidate:false ⇒ 详情端点不多发 GET，但缓存里已经是新建的那一份
    expect(countGets(fetchMock, '/api/runs/run-new')).toBe(1);
    expect(result.current.detail.run?.id).toBe('run-new');
    // 列表被显式刷新一次（回写约定）
    await flushMount();
    expect(countGets(fetchMock, '/api/runs')).toBe(2);
    expect(result.current.list.runs).toHaveLength(1);
  });

  it('start / abort / abortRow 发到正确的端点', async () => {
    const fetchMock = stubRunRoutes();

    const { result } = renderHook(
      () => ({ start: useStartRun(), abort: useAbortRun(), abortRow: useAbortRow() }),
      { wrapper },
    );

    await act(async () => {
      await result.current.start.start('run-1');
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs/run-1/start');

    await act(async () => {
      await result.current.abort.abort('run-1');
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs/run-1/abort');

    await act(async () => {
      await result.current.abortRow.abortRow('run-1', 'w-1');
    });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/runs/run-1/rows/w-1/abort');
    expect(countCalls(fetchMock, '/api/runs/run-1/rows/w-1/abort', 'POST')).toBe(1);
  });

  /**
   * mutation 后**只**刷新受影响的 key（`matchesCommitsKey` 是同一诉求的先例）：
   * 顺手 `mutate(() => true)` 会把页面上所有在飞的 key 一起重取——评测页旁边就挂着用例列表，
   * 点一次「开始」顺带重取一次用例列表，是实打实的浪费，还会让无关区域闪一下 loading。
   */
  it('start 之后只重取详情与列表，不碰无关的 key', async () => {
    const fetchMock = stubFetch(async (url: string) => {
      if (String(url) === '/api/cases') return json([]);
      if (String(url) === RUNS_KEY) return json([makeRun({ id: 'run-1' })]);
      return json(makeRun({ id: 'run-1' }));
    });

    // 同一个 provider 下把三个数据消费者与动作 hook 一起挂上（真实页面的结构）
    const { result } = renderHook(
      () => ({ list: useRuns(), detail: useRun('run-1'), cases: useCases(), start: useStartRun() }),
      { wrapper },
    );
    await flushMount();
    expect(countGets(fetchMock, '/api/cases')).toBe(1);

    await act(async () => {
      await result.current.start.start('run-1');
    });
    await flushMount();

    // 列表重取一次；详情由响应回写（revalidate:false，不再多发 GET）
    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
    expect(countGets(fetchMock, '/api/runs/run-1')).toBe(1);
    // 无关的 key 一个请求都不多发
    expect(countGets(fetchMock, '/api/cases')).toBe(1);
    expect(result.current.detail.run?.id).toBe('run-1');
    expect(result.current.list.runs).toHaveLength(1);
  });
});

describe('产物读取', () => {
  it('useRowDiffIndex 在 enabled=false 时一个请求都不发', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRowDiffIndex('run-1', 'w-1', false), { wrapper });
    await flushMount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useRowLog 在 enabled=false 时一个请求都不发', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRowLog('run-1', 'w-1', false), { wrapper });
    await flushMount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useRowDiffFile 的 path 为 undefined 时一个请求都不发（「滚动到才加载」的开关）', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRowDiffFile('run-1', 'w-1', undefined), { wrapper });
    await flushMount();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useRowDiffIndex / useRowDiffFile / useRowLog 的键就是真实端点（索引带分页参数、正文带 file）', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRowDiffIndex('run-1', 'w-1', true), { wrapper });
    await flushMount();
    // 翻页：offset/limit 必须真的进 URL，否则第 31 个之后的文件永远拿不到
    renderHook(() => useRowDiffIndex('run-1', 'w-1', true, 30), { wrapper });
    await flushMount();
    // 含空格的路径必须编码，否则服务端解出来是截断的
    renderHook(() => useRowDiffFile('run-1', 'w-1', 'src/a b.ts'), { wrapper });
    await flushMount();
    renderHook(() => useRowLog('run-1', 'w-1', true), { wrapper });
    await flushMount();

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain('/api/runs/run-1/rows/w-1/diff?offset=0&limit=30');
    expect(urls).toContain('/api/runs/run-1/rows/w-1/diff?offset=30&limit=30');
    expect(urls).toContain('/api/runs/run-1/rows/w-1/diff?file=src%2Fa%20b.ts');
    expect(urls).toContain('/api/runs/run-1/rows/w-1/log');
  });
});

/**
 * 焦点重验：候选提交（POST 当读用，服务端要跑 `git log`）在这里有个同形的兄弟——
 * 写请求一旦被挂进 SWR 的 fetcher，每切回一次窗口就重发一次；而「变更详情」的索引 GET
 * 在服务端是**一次真实的 git 计算**（明确「按需现算，不预先落库」），
 * 被焦点重验反复触发同样是秒级卡顿。两条都在这一节钉住。
 */
describe('焦点重验', () => {
  it('窗口重新获得焦点不会把写请求再发一次（写请求不做焦点重验）', async () => {
    vi.useRealTimers();
    const fetchMock = stubRunRoutes();

    const { result } = renderHook(() => useStartRun(), { wrapper: focusWrapper });
    await act(async () => {
      await result.current.start('run-1');
    });
    const postsBefore = countCalls(fetchMock, '/api/runs/run-1/start', 'POST');
    expect(postsBefore).toBe(1);

    await settleFocus();

    expect(countCalls(fetchMock, '/api/runs/run-1/start', 'POST')).toBe(postsBefore);
  });

  it('焦点回来不会重跑一次 git 现算的 diff 索引（服务端每次都要现场算）', async () => {
    vi.useRealTimers();
    const fetchMock = stubFetch(async () =>
      json({ files: [], total: 0, offset: 0, insertions: 0, deletions: 0, noBodyCount: 0, truncated: false, droppedFiles: [] }),
    );

    const { result } = renderHook(() => useRowDiffIndex('run-1', 'w-1', true), { wrapper: focusWrapper });
    await waitFor(() => expect(result.current.index).toBeDefined());
    const before = fetchMock.mock.calls.length;

    await settleFocus();

    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

describe('useRunModelOptions', () => {
  it('按 agentKind 给出候选池与能力元数据，未知 kind 退回乐观默认值', async () => {
    const groups = [
      {
        agentKind: 'claude-code',
        protocolTypes: ['anthropic'],
        usage: true,
        cancelMidTurn: true,
        options: [{ providerId: 'p-1', providerName: 'A', modelId: 'claude-opus-4-6', source: 'manual' }],
      },
      // dsh 两条 wire 都收 ⇒ 它的集合是两个元素、且能计量
      { agentKind: 'dsh', protocolTypes: ['openai', 'anthropic'], usage: true, cancelMidTurn: false, defaultEffort: 'high', options: [] },
    ];
    const fetchMock = stubFetch(async () => json(groups));

    const { result } = renderHook(() => useRunModelOptions(), { wrapper });
    await flushMount();

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/runs/model-options');
    expect(result.current.optionsFor('claude-code').map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
    expect(result.current.capabilityOf('dsh')).toEqual({ usage: true, cancelMidTurn: false });
    // 数据还没到 / kind 未知时按「都支持」处理：多给一个终止按钮，比无端禁用安全
    expect(result.current.capabilityOf('codex')).toEqual({ usage: true, cancelMidTurn: true });
    expect(result.current.optionsFor('codex')).toEqual([]);
    /**
     * 「未选档位会落到哪」按 kind 透出，**缺省是 `undefined` 而不是一个猜出来的档**：
     * 界面用它拼占位符（「未指定（DeepSeek Harness 用 high）」），猜错就是替那一家承诺。
     */
    expect(result.current.defaultEffortOf('dsh')).toBe('high');
    expect(result.current.defaultEffortOf('claude-code')).toBeUndefined();
    // 响应里没有这一组的 kind：同样给 undefined（不是空串、也不是别家的档）
    expect(result.current.defaultEffortOf('codex')).toBeUndefined();
    //  钉的原始形状也在（页面照解构时不必自己再 find 一遍）
    expect(result.current.options).toEqual(groups);
  });

  /**
   * **本接口的那三格**：这是接缝的 **client 那一半**。
   *
   * 为什么非要在 client 侧再钉一条：`apps/web-next/src/route-runs.test.ts` 钉的是 **api 的响应形状**
   * ——从这里删掉 `efforts`，那条**照样绿**；而所有消费点传的都是函数值、三格又全是
   * 可选的 ⇒ 结构类型下「少一格」天然可赋值，**tsc 与测试都不会响**，症状是界面静默丢掉那一格。
   *
   * 判据靠**对象字面量的多余属性检查**：这三格若从 `AgentModelOption` 里消失，下面这个字面量就成了
   * 「多余的键」 ⇒ `pnpm typecheck` 当场报 TS2353。运行时那两行只是顺带（证明这条用例真的跑到，
   * 而不是一个被摇掉的空壳）。
   */
  it('接缝形状：AgentModelOption 必须装得下 api 的三格（少一格 tsc 就报错）', () => {
    const option: AgentModelOption = {
      providerId: 'p-1',
      providerName: '网关',
      modelId: 'three',
      source: 'manual',
      contextWindow: 1_048_576,
      efforts: [EFFORT_OFF, 'low', 'high'],
      recommendedEffort: 'high',
    };

    expect(option.efforts?.[0]).toBe(EFFORT_OFF);
    expect(option.recommendedEffort).toBe('high');
  });

  /**
   * **上一层那一半**：`AgentOptionGroup` 的 `efforts` 也漏了整整一轮——
   * 与上面那条同一个成因（client / api 两处手写的同一份形状 + 可选属性天然可赋值），只是没有对应用例，
   * 于是「api 一直在发、client 没声明」谁都不响。症状比缺一个选项更硬：
   * 设置页「评分配置」的思考强度候选会退化成规范五档，dsh 收不了的 `medium` 摆上界面、还能被存进设置，
   * 直到生成 / 识别时被 `requireJudgeEffort` 硬拒。
   *
   * 判据写成**类型查询**而不是值字面量：这里要钉的是**接口的字段集合**，
   * 而那份对象的内容是 api 的事——为了凑一个完整的 `AgentOptionGroup` 字面量，
   * 得凭空编一份 17 格的 `messageCapability`。类型查询同样拦得住
   * 「删掉 / 改名这一格」：`AgentOptionGroup['efforts']` 当场 TS2339 ⇒ `pnpm typecheck` 失败。
   * 运行时的两行只为证明这条用例真跑到了，不是被摇掉的空壳。
   */
  it('接缝形状：AgentOptionGroup 必须装得下 api 的 efforts（少了它设置页的档位域会静默退化）', () => {
    const dshEfforts: AgentOptionGroup['efforts'] = [EFFORT_OFF, 'low', 'high', 'max'];

    expect(dshEfforts[0]).toBe(EFFORT_OFF);
    // 该家没有 medium（dsh 的硬报错档）——这一格正是设置页那格候选的上游
    expect(dshEfforts).not.toContain('medium');
  });

  /**
   * **补的同一条接缝**：`defaultEffort`（「未选档位」时该家实际会用的档）。
   *
   * 成因与上面两条逐字相同（api / client 两处手写的同一份形状，可选属性天然可赋值），
   * 只是这一格是被**占位符文案**消费的：client 漏声明时 tsc 与路由测试都不响，而
   * `defaultEffortOf` 恒给 `undefined` ⇒ 界面上那句「（DeepSeek Harness 用 high）」静默消失，
   * 只剩一句泛化的「未指定」。判据同样是类型查询（拼一个完整的 `AgentOptionGroup` 字面量
   * 要凭空编 17 格 `messageCapability`，线上永远长不成那样）。
   */
  it('接缝形状：AgentOptionGroup 必须装得下 api 的 defaultEffort（少了它占位符会静默退回「未指定」）', () => {
    const declared: AgentOptionGroup['defaultEffort'] = 'high';

    expect(declared).toBe('high');
  });

  /**
   * 候选池与能力元数据**完全来自服务端**（A3 /）：前端不许再抄一份「哪家配哪种协议」。
   * 所以这里喂一份**反直觉**的响应（dsh 带模型、claude-code 缺席）：任何在前端硬编码
   * 「谁属于哪组 / 谁有哪些模型」的实现都会在这条用例上露馅。
   */
  it('候选池完全由服务端响应驱动，不硬编码「哪家配哪种协议」', async () => {
    const groups = [
      {
        agentKind: 'dsh',
        protocolTypes: ['openai', 'anthropic'],
        usage: true,
        cancelMidTurn: false,
        options: [{ providerId: 'p-9', providerName: '网关', modelId: 'deepseek-v4', source: 'fetched' }],
      },
    ];
    stubFetch(async () => json(groups));

    const { result } = renderHook(() => useRunModelOptions(), { wrapper });
    await flushMount();

    expect(result.current.optionsFor('dsh').map((option) => option.modelId)).toEqual(['deepseek-v4']);
    // 响应里没有 claude-code 这一组 ⇒ 它的池子是空的（而不是「本地写死的默认池」）
    expect(result.current.optionsFor('claude-code')).toEqual([]);
    expect(result.current.capabilityOf('dsh')).toEqual({ usage: true, cancelMidTurn: false });
  });

  /**
   * **能力声明按 kind 透出**。
   *
   * 界面那四句「这家结构上不支持 / 厂商有数据但没投送 / 厂商有我们还没接 / 没验证过」全部来自
   * 这一格，它此前在 api 出口就不存在 ⇒ 界面一律按「没验证过」渲染。
   * 这里钉两件事：① 声明**逐格原样**透出（含每格自己的 `source` / `reason` 与 `notes`，
   * 数据层不许裁剪、不许替厂商改写原因）；② 拿不到那一组时给 `null`——**不是**一份编出来的
   * 「都支持」：能力格与 `usage` / `cancelMidTurn` 的乐观默认值处置刻意不同，
   * 编出来的能力声明会让人以为「我们验过这一家」。
   */
  it('能力声明逐格透出；未知 kind 给 null 而不是编一份「都支持」', async () => {
    const declared = {
      thinkingText: 'yes' as const,
      thinkingTextKind: 'full' as const,
      toolInput: 'yes' as const,
      toolResult: 'yes' as const,
      subagent: 'yes' as const,
      streamingDelta: 'no' as const,
      thinkingTextSource: 'session-file' as const,
      thinkingTextReason: null,
      toolInputSource: 'session-file' as const,
      toolInputReason: null,
      toolResultSource: 'session-file' as const,
      toolResultReason: null,
      subagentSource: 'session-file' as const,
      subagentReason: null,
      streamingDeltaSource: null,
      streamingDeltaReason: 'not-exposed' as const,
      notes: ['多智能体随路由变化'],
    };
    stubFetch(async () =>
      json([
        { agentKind: 'codex', protocolTypes: ['openai'], usage: true, cancelMidTurn: true, options: [], messageCapability: declared },
      ]),
    );

    const { result } = renderHook(() => useRunModelOptions(), { wrapper });
    await flushMount();

    // 逐格原样：`streamingDelta` 那一格的非 yes 与它的原因都必须还在
    expect(result.current.messageCapabilityOf('codex')).toEqual(declared);
    expect(result.current.messageCapabilityOf('dsh')).toBeNull();
  });
});

/**
 * 编辑与删除的**回写约定**（与另外四个写操作逐字同形）：
 * mutation 成功后写详情缓存（`revalidate: false`，避免紧接的 GET 用旧值覆盖）、再刷新列表。
 * 为什么不走 `useSWRMutation`：见 runs.ts 文件头——runId 是**调用时**才拿到的，
 * 且写操作不进 SWR 的 fetcher（「窗口重新获得焦点 ⇒ 重发一次写请求」在形状上就不存在）。
 *
 * 这两节沿用本文件的**假定时器**约定，用 `flushMount()` 而不是同义的 `waitFor()`：
 * `waitFor` 只在检测到 **jest** 的假定时器时才自己推进时钟（@testing-library/dom 的
 * `jestFakeTimersAreEnabled` 先看 `typeof jest`，vitest 下恒为假），于是它退回「真定时器」
 * 分支，却面对被替换掉的 `setTimeout` / `setInterval`——第一次检查不成立就挂到 40s 用例超时。
 * 本文件的焦点重验一节能用 `waitFor`，是因为它先 `vi.useRealTimers()`。
 */
describe('useUpdateRun', () => {
  it('PUT 到详情键、把入参逐字透传，并同时回写详情缓存与列表', async () => {
    const updated = makeRun({ executionMode: 'serial' });
    const fetchMock = stubFetch(async (url, init) => {
      if (init?.method === 'PUT' && url === runKey('run-1')) return json(updated);
      if (url === RUNS_KEY) return json([updated]);
      return json(makeRun());
    });

    const { result } = renderHook(
      () => ({ list: useRuns(), detail: useRun('run-1'), update: useUpdateRun() }),
      { wrapper },
    );
    await flushMount();
    expect(result.current.list.runs).toHaveLength(1);
    expect(countGets(fetchMock, runKey('run-1'))).toBe(1);

    // 入参里的 `rows[].id`（原地更新这一行）与 `rows[].effort`（思考强度）都由服务端读，
    // 钩子只负责**原样**送到线路上：任何「挑字段重组」的实现都会在这一条上露馅
    const input: RunUpdate = {
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [
        {
          id: 'w-1',
          agentKind: 'claude-code',
          providerId: 'p-anthropic',
          modelId: 'claude-opus-4-6',
          effort: 'high',
        },
      ],
    };
    await act(async () => {
      await result.current.update.update('run-1', input);
    });

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall?.[0]).toBe(runKey('run-1'));
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual(input);
    // 详情由响应回写（revalidate:false ⇒ 详情端点不多发 GET），列表被显式刷新
    //（首次挂载 1 次 + 写操作后 1 次；不刷新的话左栏还显示旧的执行模式）
    expect(countGets(fetchMock, runKey('run-1'))).toBe(1);
    expect(result.current.detail.run?.executionMode).toBe('serial');
    expect(countGets(fetchMock, RUNS_KEY)).toBeGreaterThanOrEqual(2);
    expect(result.current.list.runs?.[0]?.executionMode).toBe('serial');
  });

  it('请求失败时抛 ServiceError，且不把缓存写坏', async () => {
    const fetchMock = stubFetch(async (url, init) => {
      if (init?.method === 'PUT') {
        return json({ error: { code: 'CONFLICT', message: '这一轮还有候选行在运行' } }, 409);
      }
      return json(makeRun());
    });

    const { result } = renderHook(
      () => ({ detail: useRun('run-1'), update: useUpdateRun() }),
      { wrapper },
    );
    await flushMount();
    expect(result.current.detail.run?.executionMode).toBe('parallel');

    await act(async () => {
      await expect(
        result.current.update.update('run-1', {
          caseId: 'c-1',
          executionMode: 'serial',
          useAgentJudge: false,
          rows: [
            { agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
          ],
        }),
      ).rejects.toThrowError(/正在运行|在运行/);
    });
    // 失败后转圈必须停（finally），且缓存里还是原来那一轮（失败响应不许写进缓存）
    expect(result.current.update.isUpdating).toBe(false);
    expect(result.current.detail.run?.executionMode).toBe('parallel');
    expect(countGets(fetchMock, runKey('run-1'))).toBe(1);
  });
});

describe('useDeleteRun', () => {
  it('DELETE 详情键、清掉详情缓存并刷新列表，返回 workspaceRemoved', async () => {
    const fetchMock = stubFetch(async (url, init) => {
      if (init?.method === 'DELETE' && url === runKey('run-1')) return json({ workspaceRemoved: false });
      if (url === RUNS_KEY) return json([]);
      return json(makeRun());
    });

    const { result } = renderHook(
      () => ({ list: useRuns(), detail: useRun('run-1'), remove: useDeleteRun() }),
      { wrapper },
    );
    await flushMount();
    expect(result.current.detail.run).toBeDefined();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    let removed: { workspaceRemoved: boolean } | undefined;
    await act(async () => {
      removed = await result.current.remove.remove('run-1');
    });
    await flushMount();

    // `workspaceRemoved` 原样交给页面：false = 磁盘上的行工作区没能回收，界面要如实说出来
    expect(removed).toEqual({ workspaceRemoved: false });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    // 详情缓存被清掉：改回同一个 URL 时不许先渲染一条已经不存在的轮次
    expect(result.current.detail.run).toBeUndefined();
    // 列表也刷新了（左栏不许留着已经删掉的那一轮）
    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
    expect(result.current.list.runs).toEqual([]);
  });

  /**
   * 失败路径（A10 的 `finally` 形状，与 `useUpdateRun` 同一条）：转圈要停，
   * 而且**没删掉就不许从界面上消失**——清缓存的 `mutate` 一旦被挪到 finally 或请求之前，
   * 用户会看到轮次先消失、刷新一下又回来（而服务端其实抛了 409）。
   */
  it('删除失败时抛 ServiceError：转圈停、详情缓存原样保留', async () => {
    const fetchMock = stubFetch(async (url, init) => {
      if (init?.method === 'DELETE') {
        return json({ error: { code: 'CONFLICT', message: '这一轮还有候选行在运行' } }, 409);
      }
      if (url === RUNS_KEY) return json([makeRun()]);
      return json(makeRun());
    });

    const { result } = renderHook(
      () => ({ detail: useRun('run-1'), remove: useDeleteRun() }),
      { wrapper },
    );
    await flushMount();
    expect(result.current.detail.run?.id).toBe('run-1');

    await act(async () => {
      await expect(result.current.remove.remove('run-1')).rejects.toThrowError(/正在运行|在运行/);
    });

    expect(result.current.remove.isDeleting).toBe(false);
    expect(result.current.detail.run?.id).toBe('run-1');
    expect(countGets(fetchMock, runKey('run-1'))).toBe(1);
  });
});
