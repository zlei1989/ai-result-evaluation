/**
 * 评测数据层：键、轮询开关、四个动作的请求与回写、产物按需读取的条件键、候选池。
 * 重点在两条容易被写错、写错了界面表现又很隐蔽的约定：
 *   1. **轮询只在有 running 时开**（spec §8 末段）——用假定时器推 3 秒看请求次数，
 *      既验证「该轮询时轮询」，也验证「跑完必须停」；
 *   2. mutation 成功后要写进缓存且**不得**被随后的 GET 覆盖（沿用 useSettings 的回写约定）。
 *
 * 假定时器显式列出 `toFake`：只替换 setTimeout/setInterval/Date，不碰 queueMicrotask 与
 * nextTick——SWR 的请求链是 Promise 驱动的，把微任务也冻结掉会让用例假死。
 *
 * 两条读用例的通用结构（实测踩过才这么写）：
 *   - 需要跨 hook 观察「刷新了谁」的用例，必须把相关 hook 挂在**同一个 renderHook** 里：
 *     `SWRConfig` 的 `provider` 是按组件树建的缓存，分开 `renderHook` 会各拿一份缓存，
 *     `mutate(key)` 便找不到另一个缓存上的消费者（真实页面里它们同在一个 provider 下）；
 *   - 数请求一律**按方法**数（`countGets`）：`/api/runs` 同时是列表 GET 与创建 POST 的目标，
 *     只按 URL 数会让「列表被刷新了一次」被创建请求蒙混过关——那是一条空转的守卫。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import type { RunUpdate } from '@aieval/contracts';
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
} from './runs';
import { useCases } from './cases';
import { makeRow, makeRun } from './testing/run-fixtures';

/** fetch 替身的签名：显式写出来，`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 直接报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/**
 * 焦点重验的专用 wrapper：默认的 `focusThrottleInterval`（5s）与 `dedupingInterval`（2s）
 * 会把焦点事件静默吞掉，于是「没发请求」既可能是真的关掉了、也可能是被节流了——
 * 两个窗口都置 0，断言才有区分力（与 p2 的 useCommitCandidates 用例同一手法）。
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

  it('有 running 的行时 3 秒轮询一次，跑完立即停', async () => {
    const fetchMock = stubFetch(async () =>
      json([makeRun({ status: 'running', rows: [makeRow({ status: 'running' })] })]),
    );

    const { result } = renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 下一次拉回来的是「已完成」：轮询必须关掉，否则开着的页面会永远打接口
    fetchMock.mockImplementation(async () => json([makeRun()]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const afterFinish = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(fetchMock.mock.calls.length).toBe(afterFinish);
    expect(result.current.runs?.[0]?.status).toBe('done');
  });

  it('一轮都没在跑时完全不轮询', async () => {
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('行还在跑（轮状态还没翻）时也要轮询：编排层翻转轮状态有一拍延迟', async () => {
    const fetchMock = stubFetch(async () => json([makeRun({ status: 'idle', rows: [makeRow({ status: 'judging' })] })]));

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
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

  it('还有活在跑时详情也按 3 秒轮询（SSE 断掉时靠它兜底，spec §8 末段）', async () => {
    const fetchMock = stubFetch(async () => json(makeRun({ status: 'running', rows: [makeRow({ status: 'running' })] })));

    renderHook(() => useRun('run-1'), { wrapper });
    await flushMount();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
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
    // 列表被显式刷新一次（契约 §7 的回写约定）
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
   * mutation 后**只**刷新受影响的 key（p2 的 `matchesCommitsKey` 是同一诉求的先例）：
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
 * 焦点重验：p2 的候选提交（POST 当读用，服务端要跑 `git log`）在这里有个同形的兄弟——
 * 写请求一旦被挂进 SWR 的 fetcher，每切回一次窗口就重发一次；而「变更详情」的索引 GET
 * 在服务端是**一次真实的 git 计算**（spec §7.2 明确「按需现算，不预先落库」），
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

  it('焦点回来不会重跑一次 git 现算的 diff 索引（服务端每次都要现场算，spec §7.2）', async () => {
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
      // dsh 两条 wire 都收（2026-09-30 起，契约 §11 的 R37 收口）⇒ 它的集合是两个元素、且能计量
      { agentKind: 'dsh', protocolTypes: ['openai', 'anthropic'], usage: true, cancelMidTurn: false, options: [] },
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
    // 契约 §7 钉的原始形状也在（页面照 §7 解构时不必自己再 find 一遍）
    expect(result.current.options).toEqual(groups);
  });

  /**
   * 候选池与能力元数据**完全来自服务端**（A3 / R11）：前端不许再抄一份「哪家配哪种协议」。
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
