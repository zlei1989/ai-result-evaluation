/**
 * 应答面的数据层：队列（快照 + 全局流的信号）、应答动作（POST）、以及**暂缓**
 * （焦点之外的那些轮次的提问不弹、不取消、不出队）。
 *
 * 这一组覆盖的是「传输与队列接起来之后」的行为，六条是本功能的全部风险面：
 *   1. 挂载即拉快照并接上**全局流**（与列表信号、人工消息队列共用同一条连接）；
 *   2. 只认 `ask-user-changed` 这一族帧（同一连接上还有 `run-updated` / `inject-messages-changed`）；
 *   3. 重连补读一次——断线期间登记的提问不会漏（帧不重放，不补就永远看不到）；
 *   4. 完成 → POST → **收到确认才出队**；失败（409 / 网络错）这一问留在队首；
 *   5. 关闭弹层不发任何请求、队列一条不少，`reopen` 能回到它（「关掉」不是「回答」）；
 *   6. **暂缓**：焦点切走后该轮的提问不进 `current`（不弹、不发请求、不出队），切回即重现。
 *
 * 帧一律用 `feed()`（服务端原始字节）投递：全局流的帧是**无名**的（判别键是顶层 `type`），
 * 而 `emitNamed('ask-user-changed', …)` 那种老形状（具名事件 + 空 `data:`）已经不存在了——
 * 上面第 2 条与 `feed('event: ask-user-changed\\ndata:\\n\\n')` 那条用例正是为它留的守卫。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ServiceError, type AskUserAnswerRequest, type PendingAskUser } from '@aieval/contracts';
import type { AskUserAnswer } from '@aieval/ui';
import { ASK_USER_ANSWERS_URL, ASK_USER_URL, useAskUserQueue } from './ask-user';
import { GLOBAL_STREAM_URL, resetGlobalStreamHubForTesting } from './global-stream-hub';
import { resetRunFocusForTesting, setFocusedRun, useFocusedRun } from './run-focus';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';

/** fetch 替身的签名显式写出来：`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 直接报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 服务端帧的原文（api 的 `toFrame` 逐字同形：无名事件、无 `id:` 行） */
const ASK_USER_CHANGED_FRAME = 'data: {"type":"ask-user-changed"}\n\n';

/** 一条待答提问：队列规则只认 `askId`，焦点过滤只认 `runId` */
function pending(askId: string, runId = 'run-1'): PendingAskUser {
  return {
    askId,
    runId,
    candidateId: 'w-1',
    stage: 'agent',
    questions: [
      { header: '选路径', prompt: '这次改哪条路径？', options: [], multiSelect: false, allowOther: true, secret: false },
    ],
    askedAt: '2026-10-13T10:00:00.000Z',
  };
}

/** 面板交出来的那样一份答案 */
function answer(): AskUserAnswer {
  return { header: '选路径', selected: ['A'], custom: null };
}

/**
 * 待答面的假服务端：`GET` 给当前清单（由用例持有的函数决定，便于中途改），`POST` 按用例给的裁决回话。
 * 其余路径一律 404——本 hook 只该碰这两个端点，多出来的请求要在断言里现形。
 */
function stubServer(options: {
  snapshot: () => PendingAskUser[];
  onAnswer?: (body: AskUserAnswerRequest) => Response | Promise<Response>;
}): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === ASK_USER_URL) return json(options.snapshot());
    if (target === ASK_USER_ANSWERS_URL && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as AskUserAnswerRequest;
      return (
        options.onAnswer?.(body) ??
        json({ askId: body.askId, answer: { outcome: 'answered', answers: body.answers }, answeredAt: '2026-10-13T10:00:05.000Z' })
      );
    }
    return json({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 已经发出的应答 POST（断言「关掉不发请求」「双击只发一份」「暂缓期间零调用」都靠它） */
function postCalls(fetchMock: FetchMock): unknown[] {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
}

/** 读快照的请求次数 */
function snapshotReads(fetchMock: FetchMock): number {
  return fetchMock.mock.calls.filter(([url]) => String(url) === ASK_USER_URL).length;
}

/**
 * 渲染队列 hook：焦点与宿主同一句——从 `run-focus` 单例**订阅式读**再喂进去。
 * 于是「切走 ⇒ 暂缓、切回 ⇒ 重现」走的正是生产里那条路（焦点一变就重渲染）。
 */
function renderQueue() {
  return renderHook(() => useAskUserQueue({ focusedRunId: useFocusedRun() }));
}

beforeEach(() => {
  FakeEventSource.reset();
  resetGlobalStreamHubForTesting();
  resetRunFocusForTesting();
  installEventSourceStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAskUserQueue 的订阅', () => {
  it('挂载即拉快照并按先来后到排队，同时接上全局流（不是自己那条待答流）', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a'), pending('b')] });

    const { result } = renderQueue();

    await waitFor(() => expect(result.current.pendingCount).toBe(2));
    expect(result.current.current?.askId).toBe('a');
    // 「还有 N 个待答」问的是排在这一问之后的条数，不含正在答的这一条
    expect(result.current.waitingCount).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ASK_USER_URL);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(GLOBAL_STREAM_URL);
  });

  it('只认 ask-user-changed 那一族帧：同一条连接上的另两族不重读待答快照', async () => {
    let snapshot: PendingAskUser[] = [];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    const { result } = renderQueue();
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    const source = FakeEventSource.instances[0];
    // 另两族：与待答清单无关（列表状态翻转、人工消息队列变更）
    await act(async () => {
      source?.feed('data: {"type":"run-updated","runId":"run-1"}\n\n');
      source?.feed('data: {"type":"inject-messages-changed"}\n\n');
    });
    expect(snapshotReads(fetchMock)).toBe(1);

    // 本族帧：帧里只有「变了」，内容必须靠重读拿
    snapshot = [pending('a')];
    await act(async () => {
      source?.feed(ASK_USER_CHANGED_FRAME);
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('a'));
    expect(snapshotReads(fetchMock)).toBe(2);
  });

  it('老形状（具名事件 ask-user-changed + 空 data）不再驱动重读：客户端读的是信封的 type', async () => {
    let snapshot: PendingAskUser[] = [];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    renderQueue();
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    snapshot = [pending('a')];
    await act(async () => {
      FakeEventSource.instances[0]?.feed('event: ask-user-changed\ndata:\n\n');
    });

    expect(snapshotReads(fetchMock)).toBe(1);
  });

  it('重连补读一次快照（断线期间登记的提问不会漏），首次连接不补', async () => {
    const snapshot: PendingAskUser[] = [];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    const { result } = renderQueue();
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    // 首次 onopen：挂载那一次读就在同一瞬间，不重复发
    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(snapshotReads(fetchMock)).toBe(1);

    // 断线期间登记了一问；重连（浏览器自动重连）后必须补读，否则它永远不出现
    snapshot.push(pending('a'));
    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('a'));
  });

  it('卸载时退订：最后一个订阅者走了就把全局连接关掉（不留一条只发心跳的长连接）', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a')] });

    const { unmount } = renderQueue();
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    unmount();

    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    // 卸载之后到达的帧不许再写进一个已经不属于本用例的 React 树
    FakeEventSource.instances[0]?.feed(ASK_USER_CHANGED_FRAME);
    expect(snapshotReads(fetchMock)).toBe(1);
  });
});

describe('useAskUserQueue 的应答', () => {
  it('完成 → POST 之后才出队，队首换成下一问', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a'), pending('b')] });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.current?.askId).toBe('a'));

    await act(async () => {
      await result.current.submit([answer()]);
    });

    expect(result.current.current?.askId).toBe('b');
    const [call] = postCalls(fetchMock) as [string, RequestInit][];
    expect(call?.[0]).toBe(ASK_USER_ANSWERS_URL);
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      askId: 'a',
      answers: [{ header: '选路径', selected: ['A'], custom: null }],
    });
  });

  it('提交失败：这一问留在队列里（提交本身不出队），原因抛给调用方', async () => {
    stubServer({
      snapshot: () => [pending('a'), pending('b')],
      onAnswer: () => json({ error: { code: 'CONFLICT', message: '这一问已经被回答过了' } }, 409),
    });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.current?.askId).toBe('a'));

    let failure: unknown = null;
    await act(async () => {
      await result.current.submit([answer()]).catch((cause: unknown) => {
        failure = cause;
      });
    });

    expect(failure).toBeInstanceOf(ServiceError);
    expect((failure as ServiceError).message).toBe('这一问已经被回答过了');
    expect(result.current.current?.askId).toBe('a');
    expect(result.current.pendingCount).toBe(2);
    // 失败之后必须能再答一次：在途标记要归零，否则这一问再也提交不出去
    expect(result.current.submitting).toBe(false);
  });

  it('在途期间 submitting 为真，同一 tick 的第二次「完成」（双击）不会再发一份', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = stubServer({
      snapshot: () => [pending('a')],
      onAnswer: async () => {
        await gate;
        return json({ askId: 'a', answer: { outcome: 'answered', answers: [answer()] }, answeredAt: '2026-10-13T10:00:05.000Z' });
      },
    });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.current?.askId).toBe('a'));

    act(() => {
      void result.current.submit([answer()]);
      void result.current.submit([answer()]);
    });
    await waitFor(() => expect(result.current.submitting).toBe(true));
    expect(postCalls(fetchMock)).toHaveLength(1);

    await act(async () => {
      release?.();
      await gate;
    });
    await waitFor(() => expect(result.current.submitting).toBe(false));
    expect(result.current.current).toBeNull();
  });
});

describe('关掉弹层不是回答', () => {
  it('关闭不发任何请求、队列一条不少；reopen 回到同一问', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a'), pending('b')] });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.pendingCount).toBe(2));

    act(() => {
      result.current.close();
    });

    expect(result.current.current).toBeNull();
    expect(result.current.pendingCount).toBe(2);
    expect(result.current.pending[0]?.askId).toBe('a');
    expect(postCalls(fetchMock)).toHaveLength(0);

    act(() => {
      result.current.reopen();
    });
    expect(result.current.current?.askId).toBe('a');
  });

  it('别处答了：信号驱动重读，快照里没有了就出队（本页一次都没答过）', async () => {
    let snapshot: PendingAskUser[] = [pending('a'), pending('b')];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.pendingCount).toBe(2));

    // 另一个标签页答掉了 a：服务端发一条信号、快照里 a 消失
    snapshot = [pending('b')];
    await act(async () => {
      FakeEventSource.instances[0]?.feed(ASK_USER_CHANGED_FRAME);
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('b'));
    expect(result.current.pendingCount).toBe(1);
    expect(postCalls(fetchMock)).toHaveLength(0);
  });
});

describe('暂缓：焦点之外的那些轮次不弹、不取消、不出队', () => {
  it('焦点切到 run-2 时 run-1 的提问不进 current；切回 run-1 时重现（一条用例钉两个方向）', async () => {
    stubServer({ snapshot: () => [pending('a', 'run-1'), pending('c', 'run-2')] });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.current?.askId).toBe('a')); // 没在看某一轮：全部可弹

    act(() => setFocusedRun('run-2'));
    // 焦点那一轮的提问顶上来，run-1 的那条不弹（但仍留在队列里）
    expect(result.current.current?.askId).toBe('c');

    // 切回 run-1：它照旧在队列里，于是当场重现
    act(() => setFocusedRun('run-1'));
    expect(result.current.current?.askId).toBe('a');
  });

  it('焦点那一轮没有待答提问时 current 是 null（别的轮次的提问不顶上来）', async () => {
    stubServer({ snapshot: () => [pending('a', 'run-1')] });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.current?.askId).toBe('a'));

    act(() => setFocusedRun('run-2'));

    expect(result.current.current).toBeNull();
    // 没在看某一轮（离开详情页 / 列表页）时照旧弹全部——暂缓不是丢弃
    act(() => setFocusedRun(null));
    expect(result.current.current?.askId).toBe('a');
  });

  it('暂缓期间不发任何请求、不出队：`POST /answers` 零调用，`pending` 长度不变', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a', 'run-1'), pending('b', 'run-1')] });

    const { result } = renderQueue();
    await waitFor(() => expect(result.current.pendingCount).toBe(2));
    const readsBefore = snapshotReads(fetchMock);

    act(() => setFocusedRun('run-2')); // 焦点切到没有待答提问的那一轮 ⇒ 两条都暂缓

    expect(result.current.current).toBeNull();
    // 不出队：队列本体一条不少，顺序也没变
    expect(result.current.pending).toHaveLength(2);
    expect(result.current.pending.map((item) => item.askId)).toEqual(['a', 'b']);
    expect(result.current.pendingCount).toBe(2);
    // 不发任何请求：既没有应答 POST，也没有为了「过滤」再读一次快照
    expect(postCalls(fetchMock)).toHaveLength(0);
    expect(snapshotReads(fetchMock)).toBe(readsBefore);

    // 焦点放开后那两条照旧可答（暂缓没有改变它们的状态）
    act(() => setFocusedRun(null));
    await act(async () => {
      await result.current.submit([answer()]);
    });
    expect(postCalls(fetchMock)).toHaveLength(1);
  });
});
