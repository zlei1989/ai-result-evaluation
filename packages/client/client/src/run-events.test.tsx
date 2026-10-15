/**
 * useRunEvents（全局流 → SWR 重验那一层）：共享连接、节流重验、首连不补刀、重连补一次、
 * 以及「哪两族帧要重验」。
 *
 * 这里的每条用例都对着 run-events.ts 文件头的一条口径；「环境没有 EventSource 的降级」
 * 由 runs.test.tsx 的常规用例隐式覆盖（那个文件不装替身，全部轮询用例照样过）。
 *
 * 替身（FakeEventSource）只装在用到它的用例里：jsdom 没有原生 EventSource，
 * 不装 = 走「静默降级」分支，装了 = 测信号链路——两条路各有各的用例，互不冒充。
 * 每个用例前把两层单例都复位（连接归 `resetGlobalStreamHubForTesting`，节流与声明归
 * `resetRunEventsForTesting`）。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRun, useRuns } from './runs';
import { RUN_SIGNAL_DEBOUNCE, resetRunEventsForTesting } from './run-events';
import { GLOBAL_STREAM_URL, resetGlobalStreamHubForTesting } from './global-stream-hub';
import { RUNS_KEY } from './run-keys';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeRun } from './testing/run-fixtures';

/** 服务端帧的原文（api 的 `toFrame` 逐字同形：无名事件、无 `id:` 行） */
const RUN_UPDATED_FRAME = 'data: {"type":"run-updated","runId":"run-1"}\n\n';
const ASK_USER_CHANGED_FRAME = 'data: {"type":"ask-user-changed"}\n\n';
const INJECT_CHANGED_FRAME = 'data: {"type":"inject-messages-changed"}\n\n';

/** fetch 替身的签名：显式写出来，`vi.fn(async () => …)` 会被推成零参函数 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/** 列表与详情都返回「已终态」的快照：不触发慢兜底，请求计数只反映信号重验 */
function stubRunRoutes(): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(async (url: string) => {
    const target = String(url);
    if (target === RUNS_KEY) return new Response(JSON.stringify([makeRun()]), { status: 200 });
    if (target === '/api/runs/run-1') return new Response(JSON.stringify(makeRun({ id: 'run-1' })), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 挂载请求可能是微任务、也可能是 0ms 定时器；推进 0ms 把它冲出来 */
async function flushMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** 推进一个节流窗口，把信号触发的重验与它的 promise 链一起冲出来 */
async function flushSignal(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_SIGNAL_DEBOUNCE.debounceMs);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function countGets(fetchMock: FetchMock, url: string): number {
  return fetchMock.mock.calls.filter(([called, init]) => String(called) === url && (init?.method ?? 'GET') === 'GET').length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  FakeEventSource.reset();
  resetGlobalStreamHubForTesting();
  resetRunEventsForTesting();
});

afterEach(() => {
  // 节流窗口还原（AGENTS.md：可变对象改小后必须还原，产品默认值另有独立用例钉住）
  RUN_SIGNAL_DEBOUNCE.debounceMs = 300;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useRunEvents', () => {
  it('产品默认值钉住：节流窗口 300ms（改小只是测试手段，不许溜进产品）', () => {
    expect(RUN_SIGNAL_DEBOUNCE.debounceMs).toBe(300);
  });

  it('列表与详情两个 hook 共享同一条连接（页面级长连接全页恰好一条，且是全局流那条）', async () => {
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => ({ list: useRuns(), detail: useRun('run-1') }), { wrapper });
    await flushMount();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(GLOBAL_STREAM_URL);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('首个订阅者开流、最后一个退订阅关流（空闲零连接）', async () => {
    installEventSourceStub();
    stubRunRoutes();

    const first = renderHook(() => useRuns(), { wrapper });
    const second = renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.closeCount).toBe(0);

    first.unmount();
    second.unmount();
    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
  });

  it('信号触发重验：列表键 + 当前打开的详情键（别的轮的详情一概不动）', async () => {
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => ({ list: useRuns(), detail: useRun('run-1') }), { wrapper });
    await flushMount();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);
    expect(countGets(fetchMock, '/api/runs/run-1')).toBe(1);

    const source = FakeEventSource.instances[0];
    await act(async () => {
      source?.feed(RUN_UPDATED_FRAME);
    });
    await flushSignal();

    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
    expect(countGets(fetchMock, '/api/runs/run-1')).toBe(2);
    // 没打开过的轮不会有人去读：signal 说 run-1，run-2/run-9 都不该多出请求
    expect(countGets(fetchMock, '/api/runs/run-2')).toBe(0);
  });

  it('窗口内多条信号合并成一次重验（一次收尾链上两三笔 saveRun 不放大成多次读）', async () => {
    // 窗口调小是测试提速（仓库约定），断言语义与 300ms 完全相同
    RUN_SIGNAL_DEBOUNCE.debounceMs = 50;
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    const source = FakeEventSource.instances[0];
    await act(async () => {
      source?.feed(RUN_UPDATED_FRAME);
      source?.feed(RUN_UPDATED_FRAME);
      source?.feed(RUN_UPDATED_FRAME);
    });
    await flushSignal();

    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
  });

  it('ask-user-changed 也重验列表（列表与详情的待答数读同一份快照）；inject-messages-changed 不重验', async () => {
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    const source = FakeEventSource.instances[0];
    // 人工消息队列的变更与 run 视图无关：重验一次就是白读一次列表
    await act(async () => {
      source?.feed(INJECT_CHANGED_FRAME);
    });
    await flushSignal();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    // 挂起表变了 ⇒ 列表上的「待答」徽标要跟着变
    await act(async () => {
      source?.feed(ASK_USER_CHANGED_FRAME);
    });
    await flushSignal();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
  });

  it('首次连接成功不补重验（页面首拉刚发过，别再补一刀）', async () => {
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    const before = countGets(fetchMock, RUNS_KEY);

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    await flushSignal();

    expect(countGets(fetchMock, RUNS_KEY)).toBe(before);
  });

  it('断线重连成功则补一次重验（断线期间的信号永远收不到了，重连就是一条迟到的新信号）', async () => {
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen(); // 首连
    });
    await flushSignal();
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen(); // 重连
    });
    await flushSignal();

    expect(countGets(fetchMock, RUNS_KEY)).toBe(2);
  });

  it('坏帧（解不动的 JSON）跳过：一条畸形帧不许打断流，也不许触发重验', async () => {
    installEventSourceStub();
    const fetchMock = stubRunRoutes();

    renderHook(() => useRuns(), { wrapper });
    await flushMount();
    const before = countGets(fetchMock, RUNS_KEY);

    await act(async () => {
      FakeEventSource.instances[0]?.feed('data: 不是 JSON\n\n');
    });
    await flushSignal();

    expect(countGets(fetchMock, RUNS_KEY)).toBe(before);
  });

  it('环境没有 EventSource 时静默降级：不抛、不开连接，数据照常首拉', async () => {
    const fetchMock = stubRunRoutes();

    const { result } = renderHook(() => useRuns(), { wrapper });
    await flushMount();

    expect(result.current.runs).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(countGets(fetchMock, RUNS_KEY)).toBe(1);
  });
});
