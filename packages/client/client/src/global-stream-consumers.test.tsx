/**
 * 三个消费方共用**同一条** `EventSource`：列表信号（`useRuns` → `useRunEvents`）、
 * 待答快照（`useAskUserQueue`）、人工消息队列（`useInjectMessages`）。
 *
 * 为什么单独一个文件：这条事实不属于任何一层——hub 的单测证明「一个键一条连接」，
 * 三个 hook 各自的用例证明「帧到手做了什么」，而**「三个消费方到底连了几条」**只有把三个
 * hook 挂在一起才看得见。连接数涨回去的症状是纯运维面的（Network 面板里多两条长连接），
 * 界面上一个字都不会变，所以必须由用例钉住。
 *
 * 顺带钉住**分流**：同一条连接上跑着三族帧，认错族的代价是把别的功能的翻转放大成一次全量读
 * （界面上看不出来，只是请求数翻倍）。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { InjectMessage } from '@aieval/contracts';
import { useAskUserQueue } from './ask-user';
import { GLOBAL_STREAM_URL, resetGlobalStreamHubForTesting } from './global-stream-hub';
import { injectMessagesUrl, useInjectMessages } from './inject-messages';
import { RUN_SIGNAL_DEBOUNCE, resetRunEventsForTesting } from './run-events';
import { RUNS_KEY } from './run-keys';
import { useRuns } from './runs';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeRun } from './testing/run-fixtures';

/** fetch 替身的签名显式写出来：`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** 三个消费方各自的读侧端点：列表、待答快照、人工消息队列 */
const INJECT_KEY = injectMessagesUrl('run-1', 'w-1');

function stubServer(): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(async (url: string) => {
    const target = String(url);
    if (target === RUNS_KEY) return json([makeRun()]);
    if (target === '/api/runs/run-1' || target === '/api/ask-user') return json(target === '/api/ask-user' ? [] : makeRun({ id: 'run-1' }));
    if (target === INJECT_KEY) return json([] satisfies InjectMessage[]);
    return json({ error: { code: 'NOT_FOUND', message: '没有这个路由' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map(), dedupingInterval: 0 } }, children);

/** 页面级组合：详情页右栏的列表/详情 + 全局挂着的应答宿主 + 抽屉里的人工消息 */
function renderConsumers() {
  return renderHook(
    () => ({
      runs: useRuns(),
      askUser: useAskUserQueue(),
      inject: useInjectMessages({ runId: 'run-1', rowId: 'w-1', enabled: true }),
    }),
    { wrapper },
  );
}

function countGets(fetchMock: FetchMock, url: string): number {
  return fetchMock.mock.calls.filter(([called, init]) => String(called) === url && (init?.method ?? 'GET') === 'GET').length;
}

beforeEach(() => {
  // 节流窗口调小只是测试提速（产品默认值在 run-events.test.tsx 里另有独立用例钉住）
  RUN_SIGNAL_DEBOUNCE.debounceMs = 1;
  FakeEventSource.reset();
  resetGlobalStreamHubForTesting();
  resetRunEventsForTesting();
  installEventSourceStub();
});

afterEach(() => {
  RUN_SIGNAL_DEBOUNCE.debounceMs = 300;
  vi.unstubAllGlobals();
});

describe('三个消费方共用全局流', () => {
  it('三个 hook 同时挂着也只有一条 EventSource，且就是全局流那条', async () => {
    const fetchMock = stubServer();

    const { result } = renderConsumers();

    await waitFor(() => expect(countGets(fetchMock, RUNS_KEY)).toBe(1));
    await waitFor(() => expect(result.current.runs.runs).toHaveLength(1));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(GLOBAL_STREAM_URL);
  });

  it('三族帧各走各的消费方：认错族的代价是白读一次别人的快照', async () => {
    const fetchMock = stubServer();
    renderConsumers();
    await waitFor(() => expect(countGets(fetchMock, RUNS_KEY)).toBe(1));
    const source = FakeEventSource.instances[0];

    // run-updated：只刷列表（待答快照与人工消息队列都不该被叫醒）
    await act(async () => {
      source?.feed('data: {"type":"run-updated","runId":"run-1"}\n\n');
    });
    await waitFor(() => expect(countGets(fetchMock, RUNS_KEY)).toBe(2));
    expect(countGets(fetchMock, '/api/ask-user')).toBe(1);
    expect(countGets(fetchMock, INJECT_KEY)).toBe(1);

    // ask-user-changed：待答快照重读 + 列表重验（列表上的待答数读同一份快照）；人工消息队列不动
    await act(async () => {
      source?.feed('data: {"type":"ask-user-changed"}\n\n');
    });
    await waitFor(() => expect(countGets(fetchMock, '/api/ask-user')).toBe(2));
    await waitFor(() => expect(countGets(fetchMock, RUNS_KEY)).toBe(3));
    expect(countGets(fetchMock, INJECT_KEY)).toBe(1);

    // inject-messages-changed：只有人工消息队列重读
    await act(async () => {
      source?.feed('data: {"type":"inject-messages-changed"}\n\n');
    });
    await waitFor(() => expect(countGets(fetchMock, INJECT_KEY)).toBe(2));
    expect(countGets(fetchMock, RUNS_KEY)).toBe(3);
    expect(countGets(fetchMock, '/api/ask-user')).toBe(2);
  });

  it('三个消费方都退订后才关连接（一个抽屉关掉不该掐掉全局通道）', async () => {
    stubServer();
    const { unmount } = renderConsumers();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    unmount();

    expect(source?.closeCount).toBe(1);
  });
});
