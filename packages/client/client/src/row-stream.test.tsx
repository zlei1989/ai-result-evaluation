/**
 * useRowStream：抽屉一打开就要有完整历史，然后按 seq 增量续订，终端态关连接并刷一次快照。
 *
 * 六个用例是本组件的全部风险面：
 * 1. 顺序必须是「先 /log 再 /stream」，且 /stream 的 afterSeq 等于 /log 的最大 seq；
 * 2. **同一 seq 出现两次只能留一条**（重连、代理重放、/log 与 SSE 在边界上重叠都会造成重复）；
 * 3. 终态后关连接 + mutate 一次快照（否则「跑完了界面还显示执行中」）；
 * 4. 环境没有 EventSource 时不能抛：历史照旧显示，连接状态如实为「未连接」。
 *
 * ⚠️ **帧一律用具名事件投递**（`FakeEventSource.emitNamed(type, data)`）：api 的 `toFrame` 发的是
 * `event: <type>` 的具名事件，而规范规定 `EventSource.onmessage` **只收无名事件**
 * （①）。这里若用 `emit()`（= 喂 `onmessage`）就等于假装浏览器会把具名事件
 * 交给 `onmessage`——**替身比浏览器弱**，正是「真实链路零交付」能藏住的地方。
 * 唯一的例外是 `error`：它既是 `AgentEvent` 的合法类型、又是 `EventSource` 的连接失败事件，
 * 两个来源都落在 `onerror` 上 ⇒ 用 `emitNamed('error', …)` / `emitError()` 分别造。
 *
 * 两条本文件特有的写法：
 * - 快照端点故意返回**已终态**的轮：终态行不轮询，于是用例 3 里那两个
 * GET 只可能来自「终态后刷一次快照」这条路径，不会被 3 秒轮询蒙混过关；
 * - 需要跨 hook 观察刷新的用例把消费者挂在**同一个 renderHook**里（同一个 SWR provider）：
 * 分开 renderHook 会各拿一份缓存，`mutate(key)` 便找不到另一个缓存上的 fetcher。
 */
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { AGENT_EVENT_TYPES, type AgentEvent } from '@aieval/contracts';
import { useRowStream } from './row-stream';
import { useRun, useRuns } from './runs';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';
import { makeEvent, makeRun } from './testing/run-fixtures';

/** fetch 替身的签名：显式写出来，`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 直接报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(SWRConfig, { value: { provider: () => new Map() } }, children);

/** /log 的假响应；两个快照端点返回**已终态**的轮（不轮询），其余请求 404 */
function stubFetch(history: unknown[]): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(async (url: string) => {
    const target = String(url);
    if (target.endsWith('/log')) return new Response(JSON.stringify(history), { status: 200 });
    if (target === '/api/runs') return new Response(JSON.stringify([makeRun()]), { status: 200 });
    if (target === '/api/runs/run-1') return new Response(JSON.stringify(makeRun()), { status: 200 });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 挂上一条流（之后的断言都从「已有一条连接」出发） */
function mountStream() {
  return renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }), { wrapper });
}

/** SSE 的 `data:` 行内容就是一条事件的 JSON（与 api 的 `toFrame` 逐字同形） */
function frame(event: AgentEvent): string {
  return JSON.stringify(event);
}

beforeEach(() => {
  FakeEventSource.reset();
  installEventSourceStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useRowStream', () => {
  it('先拉 /log 补历史，再按最后一条的 seq 接 /stream', async () => {
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result } = mountStream();

    await waitFor(() => expect(result.current.events).toHaveLength(3));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/runs/run-1/rows/w-1/stream?afterSeq=3');
    expect(result.current.lastSeq).toBe(3);

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(result.current.connected).toBe(true);
  });

  it('按 seq 去重：同一序号来两次只留一条（重连与边界重叠都会重复投递）', async () => {
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result } = mountStream();
    await waitFor(() => expect(result.current.events).toHaveLength(3));

    const source = FakeEventSource.instances[0];
    await act(async () => {
      // 重连后服务端把边界那条又推了一遍
      const boundary = makeEvent({ seq: 3 });
      source?.emitNamed(boundary.type, frame(boundary));
      // 再推一条新的
      const fresh = makeEvent({ seq: 4 });
      source?.emitNamed(fresh.type, frame(fresh));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(result.current.lastSeq).toBe(4);
  });

  it('**具名事件必须能进 events**（①：api 发 `event: <type>`，只绑 onmessage 等于零交付）', async () => {
    // 这条守的是：真实浏览器里 `onmessage` **只收无名事件**，api 的 `toFrame` 发的却是
    // 具名事件（status/log/usage/diff-summary/score/error/end）。把实现改回「只绑 onmessage」
    // 时本用例必须红——否则「实时追加」这条通道在真实服务里会安安静静地全死。
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = mountStream();
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    const source = FakeEventSource.instances[0];
    await act(async () => {
      const status = makeEvent({ seq: 2, type: 'status', status: 'running' });
      source?.emitNamed('status', frame(status));
      const log = makeEvent({ seq: 3, type: 'log', stream: 'stdout', text: '实时来的' });
      source?.emitNamed('log', frame(log));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(result.current.lastSeq).toBe(3);
    // 内容也要真的到（不是「有一帧被吞掉」）
    expect(result.current.events.at(-1)).toMatchObject({ seq: 3, type: 'log', text: '实时来的' });
  });

  it('八种事件类型全部按名字订阅，且 stop() 里逐个摘掉（①：类型清单取 contracts）', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = mountStream();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    // 每一种都挂了监听器（漏一种 = 那一种事件在真实浏览器里收不到）。
    // **`error` 仍是 0**，但理由与那句旧注释写的**不同**：
    // 它不是因为「api 不会把 error 成帧」（那是假的——`push` 对类型没有任何过滤），
    // 而是因为 `onerror` 属性**已经**是 `error` 的 handler，服务端发的具名 `error` 帧本来就会
    // 走到那里按帧解析（见下面那条具名 `error` 的用例）；再 `addEventListener('error')` 会让同一帧被投递两次。
    for (const type of AGENT_EVENT_TYPES) {
      expect(source?.listenerCount(type), `'${type}' 的监听器数量不对`).toBe(type === 'error' ? 0 : 1);
    }

    // 无名帧的兜底仍在（`onmessage` 属性，不是 addEventListener('message')）：
    // 服务端哪天不发 `event:` 行了也照样能收
    await act(async () => {
      const fallback = makeEvent({ seq: 2 });
      source?.emit(frame(fallback));
    });
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);

    // 终态 → stop()：连接关掉、具名监听器一个不剩（否则闭包链留在真实浏览器里）
    const end = makeEvent({ seq: 3, type: 'end', exitReason: 'completed' });
    await act(async () => {
      source?.emitNamed('end', frame(end));
    });

    expect(source?.closeCount).toBe(1);
    expect(source?.listenerCount()).toBe(0);
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('同一行重跑（seq 从 1 重新开始）时按新一代重置去重，新的 1 与 2 都要交付', async () => {
    // 场景（客户端缺口）：抽屉一直开着，用户在卡片上点了「重跑」。编排层会先
    // `resetEvents` 删掉 events.jsonl（core/event-log.ts 注释：「下一次 appendEvent 会重新建，
    // seq 自然从 1 开始」），于是**同一条已经建立的 SSE 连接**上会推来 seq=1、2……
    // 而抽屉的 effect 依赖是 [enabled, runId, rowId, mutate]，三者都没变 ⇒ effect 不重跑
    // ⇒ seenRef 里还留着上一轮的 {1,2,3}：新一轮的头三条会被当成重复**静默丢弃**，
    // 用户看到的是「日志缺头」（第一轮的内容还在，新的头几条没了）。
    // 判据取「seq === 1」：seq 由 core 的 appendEvent 从 1 开始分配（文件头口径 1），
    // 只有清空过日志才会再出现 1——它是「新一轮」在本协议里唯一可靠的开端标记。
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 }), makeEvent({ seq: 3 })]);

    const { result } = mountStream();
    await waitFor(() => expect(result.current.events).toHaveLength(3));

    const source = FakeEventSource.instances[0];
    await act(async () => {
      // 第二轮：服务端清过日志，从头开始推
      const first = makeEvent({ seq: 1, text: '第二轮第一行' });
      const second = makeEvent({ seq: 2, text: '第二轮第二行' });
      source?.emitNamed(first.type, frame(first));
      source?.emitNamed(second.type, frame(second));
    });

    // 必须**交付**（不是被去重吃掉）：新一轮的两条都在，且 lastSeq 与新一轮一致
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.current.lastSeq).toBe(2);
    // 交付的内容也要是新一轮的（上一轮那三条已经不在这条流里了）
    expect(result.current.events.map((event) => (event.type === 'log' ? event.text : ''))).toEqual([
      '第二轮第一行',
      '第二轮第二行',
    ]);
  });

  it('seq 非单调回退（没出现 1）也按新一代重置：截断后重新发号的批次不得被丢掉', async () => {
    // 判据的另一半：**别**把「任何非单调回退」都当新一轮（重连重推边界那条是重复，见下一条用例），
    // 但「这一批里还有没见过的、且全部比已见过的最小 seq 还小」只可能来自「日志被截断后重新发号」
    // ——seq 由 core 的 appendEvent 单调分配，正常投递绝不会让一条**没见过**的事件落在下界之下。
    // 这里刻意让新一轮不出现 1（只从 2 开始）：没有这一半判据时，这条用例的 2/3/4 会被
    // stale 过滤静默吃掉（判据必须先于去重看），events 归零。
    stubFetch([makeEvent({ seq: 5 }), makeEvent({ seq: 6 }), makeEvent({ seq: 7 })]);

    const { result } = mountStream();
    await waitFor(() => expect(result.current.events).toHaveLength(3));

    await act(async () => {
      const source = FakeEventSource.instances[0];
      for (const seq of [2, 3, 4]) {
        const event = makeEvent({ seq });
        source?.emitNamed(event.type, frame(event));
      }
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([2, 3, 4]);
    expect(result.current.lastSeq).toBe(4);
  });

  it('乱序到达也按 seq 归位（日志视图是顺序追加的，不能倒着长）', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = mountStream();
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    await act(async () => {
      // 乱序到达：3 先来、2 后到
      for (const seq of [3, 2]) {
        const event = makeEvent({ seq });
        FakeEventSource.instances[0]?.emitNamed(event.type, frame(event));
      }
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('终态事件后关连接，并刷一次快照与列表', async () => {
    const fetchMock = stubFetch([makeEvent({ seq: 1 })]);

    // 终态刷新的是**别人的**两个键（详情与列表）：先把这两个消费者挂上，
    // 它们的键才有 fetcher——否则 `mutate` 找不到消费者，请求根本不会发出（真实页面里它们一定在）。
    // 同一个 renderHook ⇒ 同一个 provider ⇒ 共享一份缓存（页面的结构就是这样）
    const { result } = renderHook(
      () => ({
        runs: useRuns(),
        detail: useRun('run-1'),
        stream: useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: true }),
      }),
      { wrapper },
    );
    // 行级流的连接按 **URL** 取，不按序号：本用例挂了 useRuns/useRun（给 mutate 找消费者），
    // 它们现在会合法地开一条 run 级信号连接（/api/runs/events），实例池里多出的那一条与本用例无关
    const rowSource = () =>
      FakeEventSource.instances.find((source) => source.url.startsWith('/api/runs/run-1/rows/w-1/stream'));
    await waitFor(() => expect(rowSource()).toBeDefined());
    const before = fetchMock.mock.calls.length;

    await act(async () => {
      const end = makeEvent({ seq: 2, type: 'end', exitReason: 'completed' });
      rowSource()?.emitNamed('end', frame(end));
    });

    expect(rowSource()?.closeCount).toBe(1);
    await waitFor(() => {
      const urls = fetchMock.mock.calls.slice(before).map(([url]) => String(url));
      // 卡片上的分数/耗时/diff 摘要都在快照里，不刷就永远停在「执行中」
      expect(urls).toContain('/api/runs/run-1');
      expect(urls).toContain('/api/runs');
    });
    expect(result.current.stream.connected).toBe(false);
    await waitFor(() => expect(result.current.detail.run?.status).toBe('done'));
  });

  it('无法解析的帧被跳过，不影响后续帧', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = mountStream();
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    await act(async () => {
      // 坏帧按**具名**投递（真实服务端就是这么发的）：解析失败只跳过它自己
      FakeEventSource.instances[0]?.emitNamed('log', '这不是 JSON');
      FakeEventSource.instances[0]?.emitNamed('log', JSON.stringify({ seq: 9, at: 'x', type: '不存在的类型' }));
      const good = makeEvent({ seq: 2 });
      FakeEventSource.instances[0]?.emitNamed(good.type, frame(good));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.current.error).not.toBeNull();
  });

  it('连接出错时把 connected 置回 false 并给出原因', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = mountStream();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(result.current.connected).toBe(true);

    await act(async () => {
      FakeEventSource.instances[0]?.emitError();
    });
    expect(result.current.connected).toBe(false);
    expect(result.current.error).not.toBeNull();
    // 「给出原因」：徽标旁边要能说清为什么断了（浏览器会自动重连，已收到的日志不受影响）——
    // 而不是被一个把连接故障当帧解析的错分支覆盖成「收到无法解析的事件帧」
    expect(String(result.current.error)).toContain('自动重连');
    // 已拉到的历史不因断线而消失
    expect(result.current.events.map((event) => event.seq)).toEqual([1]);
  });

  it('**服务端发的具名 `error` 帧必须交付，且不得被误判成连接中断**', async () => {
    // 两个来源共用 `error` 这个名字，本用例把**两个来源**都喂一遍，钉住「按帧形状分流」这条判据：
    //   ① 服务端帧：api 的 `toFrame` 对事件类型没有任何过滤，而 `type: 'error'` 的 AgentEvent
    //      确实会被发布（编排层的 settleStopped/settleFailed、agents 侧 turn.ts）⇒ **必然成帧**；
    //   ② 连接故障：浏览器派发的是**没有 data** 的普通 Event。
    // 改前的实现把两者一律当 ②：帧被整个丢掉（data 不读），而真实浏览器里 `onerror` **就是**
    // `error` 的 handler ⇒ 每个失败行都会多显示一句「实时日志连接中断：浏览器会自动重连」。
    stubFetch([makeEvent({ seq: 1 })]);

    const { result } = mountStream();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    await act(async () => {
      source?.emitOpen();
    });
    expect(result.current.connected).toBe(true);

    // ① 服务端发的具名 error 帧：**内容必须到达 events**，且不得把 connected 打回 false、
    //    不得产生任何 error 文案（「连接中断」那句是**假**的：连接还好好的）
    await act(async () => {
      const failure = makeEvent({ seq: 2, type: 'error', message: '适配器返回非零退出码 1' });
      source?.emitNamed('error', frame(failure));
    });

    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(result.current.events.at(-1)).toMatchObject({ seq: 2, type: 'error', message: '适配器返回非零退出码 1' });
    expect(result.current.error).toBeNull();
    expect(result.current.connected).toBe(true);

    // 帧之后的**行终态**照常到达（证明 error 帧是被正常 merge 进状态的，而不是被吞掉后连接一直挂着）
    await act(async () => {
      const end = makeEvent({ seq: 3, type: 'end', exitReason: 'error' });
      source?.emitNamed('end', frame(end));
    });
    expect(result.current.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(source?.closeCount).toBe(1);
    // 已交付的 error 帧不因终态关流而消失
    expect(result.current.events.some((event) => event.type === 'error')).toBe(true);
  });

  it('环境没有 EventSource 时退化为只读历史，不抛错', async () => {
    // 显式 stub 成 undefined：不依赖「当前环境恰好没有」（Node 24 起自带 EventSource，
    // 是否透传到 jsdom 环境取决于版本）——兜底分支必须在任何环境下都可达
    vi.stubGlobal('EventSource', undefined);
    stubFetch([makeEvent({ seq: 1 }), makeEvent({ seq: 2 })]);

    const { result } = mountStream();

    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.connected).toBe(false);
    // 兜底分支要「如实反映未连接并给出原因」：不能抛（整页报错），也不能把历史清掉
    expect(result.current.error).not.toBeNull();
    expect(String(result.current.error)).toContain('只能查看已落盘的日志');
  });

  it('enabled=false 时既不发请求也不建连接', async () => {
    const fetchMock = stubFetch([makeEvent({ seq: 1 })]);

    renderHook(() => useRowStream({ runId: 'run-1', rowId: 'w-1', enabled: false }), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('换到另一行时关掉旧连接并从零开始', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result, rerender } = renderHook(
      ({ rowId }: { rowId: string }) => useRowStream({ runId: 'run-1', rowId, enabled: true }),
      { wrapper, initialProps: { rowId: 'w-1' } },
    );
    await waitFor(() => expect(result.current.events).toHaveLength(1));

    rerender({ rowId: 'w-2' });

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    expect(FakeEventSource.instances[1]?.url).toContain('/rows/w-2/stream');
  });

  it('卸载时关掉连接（抽屉关掉不该留一条长连接）', async () => {
    stubFetch([makeEvent({ seq: 1 })]);

    const { result, unmount } = mountStream();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    unmount();

    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    expect(result.current.connected).toBe(false);
  });
});
