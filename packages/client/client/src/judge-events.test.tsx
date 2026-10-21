/**
 * useCandidateJudgeEvents：评分那条事件流的历史读取与（仅 judging 时的）实时续订。
 *
 * 五个用例是本 hook 的全部风险面：
 * 1. **终态行不接 SSE**（空闲零连接」口径）：历史拉完即止，`live=false` 时一个
 *    `EventSource` 都不许建——judge 流没有终态事件，服务端不会自己关流，接上就是一条
 *    只发心跳的空连接挂到抽屉关；
 * 2. `live=true` 才接 SSE，且 `afterSeq` 等于历史的最大 seq；**具名事件必须能进 events**
 * （协议同 `row-stream`：api 发 `event: <type>` 具名帧，`onmessage` 只收无名帧）；
 * 3. **judging → 终态的翻转重拉全量**（收尾口径）：`live` 进依赖，翻 false 时旧连接关掉、
 *    历史重新读盘——SSE 尾部若有丢失，这一步兜住；
 * 4. 历史读失败不接 SSE（接上也只会立刻收到同一条错误），`status === 'error'` 交回调用方；
 *    `retry` 把 effect 重挂一次、历史重读；
 * 5. 环境没有 EventSource 时不能抛：历史照旧显示，`liveError` 如实给一句。
 *
 * 帧一律用具名事件投递（`FakeEventSource.emitNamed`）——理由与 `row-stream.test.tsx`
 * 同源：替身必须具备浏览器的具名 / 无名事件语义，用 `emit()` 喂 `onmessage` 等于
 * 假装浏览器会把具名事件交给它（替身比真实链路弱，守卫整体失去区分力）。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@aieval/contracts';
import { resetDrawerStreamHubForTesting } from './drawer-stream-hub';
import { useCandidateJudgeEvents } from './judge-events';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeEvent, makeMessage } from './testing/run-fixtures';

/** fetch 替身的签名：显式写出来，`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 直接报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/**
 * `/judge/events` 的假响应：按调用序轮换（第 2 次读到的历史更长——「重拉全量收尾」
 * 那条用例靠它证明真的重读了一次盘），其余请求 404。
 */
function stubJudgeFetch(history: unknown[], secondRead: unknown[] = history): FetchMock {
  let reads = 0;
  const fetchMock = vi.fn<FetchHandler>(async (url: string) => {
    const target = String(url);
    if (target.endsWith('/judge/events')) {
      reads += 1;
      return new Response(JSON.stringify(reads === 1 ? history : secondRead), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** SSE 的 `data:` 候选内容 = 信封里的那一帧（与 api 的组帧逐字同形：业务载荷 + 归属两格） */
function frame(event: AgentEvent): string {
  return JSON.stringify({ ...event, candidateId: 'w-1', candidateChannel: 'judge' });
}

beforeEach(() => {
  FakeEventSource.reset();
  installEventSourceStub();
  // 抽屉 hub 是模块级单例：不复位的话上一条用例的 hook（本仓没开自动 cleanup）会把连接留给下一条
  resetDrawerStreamHubForTesting();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useCandidateJudgeEvents', () => {
  it('先拉 /judge/events 补历史；live=false（终态行）一个 SSE 都不接', async () => {
    stubJudgeFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result } = renderHook(() => useCandidateJudgeEvents({ runId: 'run-1', candidateId: 'w-1', enabled: true, live: false }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(result.current.liveError).toBeNull();
    // 「空闲零连接」：judge 流没有终态事件、服务端不会自己关——live=false 时建连接就是一条
    // 只发心跳的空连接挂到抽屉关
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('live=true 时接 SSE（afterSeq = 历史最大 seq），具名事件进 events 且按 seq 去重', async () => {
    stubJudgeFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 })]);

    const { result } = renderHook(() => useCandidateJudgeEvents({ runId: 'run-1', candidateId: 'w-1', enabled: true, live: true }), {
      wrapper,
    });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/run-1/drawer/stream?candidateId=w-1&candidateChannel=judge&afterSeq=2');

    const source = FakeEventSource.instances[0];
    await act(async () => {
      // 具名帧（api 发的形状）：只有按事件名订阅才收得到
      const fresh = makeEvent({ seq: 3, type: 'log', stream: 'stderr', text: '评审者的实时输出' });
      source?.emitNamed(fresh.type, frame(fresh));
      // 同号重复投递（重连 / 边界重叠）：只留一条
      const boundary = makeEvent({ seq: 3 });
      source?.emitNamed(boundary.type, frame(boundary));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(result.current.events.at(-1)).toMatchObject({ seq: 3, stream: 'stderr', text: '评审者的实时输出' });
  });

  it('评分侧的消息帧不进事件列表（judge 那个 channel 也带消息族）', async () => {
    // 抽屉流是「一个 channel 的完整流水」：judge 那条也带着评分侧的消息与子任务行，
    // 本 hook 只认候选级事件那一族——不筛的话时间轴的内容会混进「原始输出」面板
    stubJudgeFetch([makeEvent({ seq: 1 })]);

    const { result } = renderHook(() => useCandidateJudgeEvents({ runId: 'run-1', candidateId: 'w-1', enabled: true, live: true }), {
      wrapper,
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    await act(async () => {
      source?.emitNamed(
        'message',
        JSON.stringify({ type: 'message', candidateId: 'w-1', candidateChannel: 'judge', message: makeMessage({ mergeKey: 'judge|-' }) }),
      );
      const fresh = makeEvent({ seq: 2, type: 'log', stream: 'stderr', text: '评审者的实时输出' });
      source?.emitNamed('log', frame(fresh));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.current.liveError).toBeNull();
  });

  it('live 翻 false（judging → 终态）：连接关掉、历史重读成终值（SSE 尾部丢了这一步兜住）', async () => {
    stubJudgeFetch([makeEvent({ seq: 1 })], [makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useCandidateJudgeEvents({ runId: 'run-1', candidateId: 'w-1', enabled: true, live }),
      { wrapper, initialProps: { live: true } },
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // judging 收尾：live 翻 false，effect 重挂
    rerender({ live: false });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    // 旧连接必须关掉（judging 那条不再挂着心跳）
    expect(FakeEventSource.instances[0]?.closeCount).toBeGreaterThanOrEqual(1);
    // 重挂后不重接（终态行空闲零连接）
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('历史读失败 ⇒ status=error 且不接 SSE；retry 重拉一次', async () => {
    const fetchMock = vi.fn<FetchHandler>(async (url: string) =>
      String(url).endsWith('/judge/events')
        ? new Response(JSON.stringify({ error: { code: 'INTERNAL', message: '读不了' } }), { status: 500 })
        : new Response('{}', { status: 404 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCandidateJudgeEvents({ runId: 'run-1', candidateId: 'w-1', enabled: true, live: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(Error);
    // 历史都拿不到就不接 SSE：接上也只会立刻收到同一条错误
    expect(FakeEventSource.instances).toHaveLength(0);

    // 修好盘再重试：历史读到、state 翻回 ready（retry = 把 effect 重挂一次）
    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith('/judge/events')
        ? new Response(JSON.stringify([makeEvent({ seq: 1 })]), { status: 200 })
        : new Response('{}', { status: 404 }),
    );
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events.map((event) => event.seq)).toEqual([1]);
  });

  it('环境没有 EventSource：历史照旧、liveError 给一句人话（不抛）', async () => {
    // 摘掉替身（beforeEach 装的）：环境里就是没有它——历史这条 REST 通路照旧
    vi.unstubAllGlobals();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).endsWith('/judge/events')
          ? new Response(JSON.stringify([makeEvent({ seq: 1 })]), { status: 200 })
          : new Response('{}', { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useCandidateJudgeEvents({ runId: 'run-1', candidateId: 'w-1', enabled: true, live: true }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events.map((event) => event.seq)).toEqual([1]);
    expect(result.current.liveError).toContain('EventSource');
  });
});
