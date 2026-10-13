/**
 * 应答面的数据层：订阅（快照 + 信号流）与应答动作（POST）接到队列规则上。
 *
 * 这一组用例覆盖的是**传输与队列接起来之后**的行为，五条是本功能的全部风险面：
 *   1. 挂载即拉快照并接上信号流；信号帧（**没有 `data`**）到来就重读一次快照；
 *   2. 重连补读一次——断线期间登记的提问不会漏（帧不重放，不补就永远看不到）；
 *   3. 完成 → POST → **收到确认才出队**；失败（409 / 网络错）这一问留在队首；
 *   4. 关闭弹层不发任何请求、队列一条不少，`reopen` 能回到它（「关掉」不是「回答」）；
 *   5. 别处答了（快照里没有了）⇒ 出队，不需要本地答过。
 *
 * 帧一律用**具名事件**投递（`emitNamed('ask-user-changed', '')`）：服务端发的正是具名事件，
 * 而规范里 `onmessage` 只收无名事件——用 `emit()` 就等于假装浏览器会把具名事件交给 `onmessage`，
 * 替身比浏览器弱，真实链路的「零交付」正是这样藏住的。这里只回答「派发给谁」；
 * 「这一帧的**字节**够不够被派发」由 `feed()`（原始帧文本）那一组用例回答——两者都要，
 * 少任何一半都会让「帧格式写错、用例全绿」重演。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ServiceError, type AskUserAnswerRequest, type PendingAskUser } from '@aieval/contracts';
import type { AskUserAnswer } from '@aieval/ui';
import {
  ASK_USER_ANSWERS_URL,
  ASK_USER_CHANGED_EVENT,
  ASK_USER_STREAM_URL,
  ASK_USER_URL,
  useAskUserQueue,
} from './ask-user';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';

/** fetch 替身的签名显式写出来：`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 直接报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 一条待答提问：队列规则只认 `askId`，其余字段填成合法形状 */
function pending(askId: string): PendingAskUser {
  return {
    askId,
    runId: 'run-1',
    rowId: 'w-1',
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

/** 已经发出的应答 POST（断言「关掉不发请求」「双击只发一份」都靠它） */
function postCalls(fetchMock: FetchMock): unknown[] {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
}

beforeEach(() => {
  FakeEventSource.reset();
  installEventSourceStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAskUserQueue 的订阅', () => {
  it('挂载即拉快照并按先来后到排队，同时接上信号流', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a'), pending('b')] });

    const { result } = renderHook(() => useAskUserQueue());

    await waitFor(() => expect(result.current.pendingCount).toBe(2));
    expect(result.current.current?.askId).toBe('a');
    // 「还有 N 个待答」问的是排在这一问之后的条数，不含正在答的这一条
    expect(result.current.waitingCount).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ASK_USER_URL);
    expect(FakeEventSource.instances[0]?.url).toBe(ASK_USER_STREAM_URL);
    expect(FakeEventSource.instances[0]?.listenerCount(ASK_USER_CHANGED_EVENT)).toBe(1);
  });

  it('信号帧只推「变了」：重读快照，新登记的提问入队（载荷是空串，内容全靠重读）', async () => {
    let snapshot: PendingAskUser[] = [];
    stubServer({ snapshot: () => snapshot });

    const { result } = renderHook(() => useAskUserQueue());
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());

    // 服务端那边登记了一问；客户端手里只有一条「变了」的信号，内容必须靠重读拿
    snapshot = [pending('a')];
    await act(async () => {
      FakeEventSource.instances[0]?.emitNamed(ASK_USER_CHANGED_EVENT, '');
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('a'));
  });

  it('帧按浏览器语义派发就重读快照：新登记的提问入队（字节取服务端 toFrame 的原文）', async () => {
    let snapshot: PendingAskUser[] = [];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    const { result } = renderHook(() => useAskUserQueue());
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));

    // 服务端那边登记了一问；客户端手里只有一条「变了」的信号，内容必须靠重读拿。
    // 走 `feed`（原始字节）而不是 `emitNamed`：要断言的正是「这一帧在浏览器里够不够被派发」
    snapshot = [pending('a')];
    await act(async () => {
      FakeEventSource.instances[0]?.feed('event: ask-user-changed\ndata:\n\n');
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('a'));
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('没有 data 字段的块不派发：替身按规范丢帧 ⇒ 不重读（被断言的那一步在字节里）', async () => {
    const snapshot: PendingAskUser[] = [pending('a')];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    const { result } = renderHook(() => useAskUserQueue());
    await waitFor(() => expect(result.current.current?.askId).toBe('a'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));

    await act(async () => {
      // 规范：「data buffer 是空串就返回」⇒ 这一块一个事件都不派发，订阅端不该被叫醒
      FakeEventSource.instances[0]?.feed('event: ask-user-changed\n\n');
    });

    // 快照臂没有再被读过：拿它去驱动界面的链路正是「提问后不刷新看不到弹层」那一格
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(FakeEventSource.instances[0]?.listenerCount(ASK_USER_CHANGED_EVENT)).toBe(1);
  });

  it('重连补读一次快照（断线期间登记的提问不会漏），首次连接不补', async () => {
    const snapshot: PendingAskUser[] = [];
    const fetchMock = stubServer({ snapshot: () => snapshot });

    const { result } = renderHook(() => useAskUserQueue());
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));

    // 首次 onopen：挂载那一次读就在同一瞬间，不重复发
    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });
    expect(fetchMock.mock.calls.length).toBe(1);

    // 断线期间登记了一问；重连（浏览器自动重连）后必须补读，否则它永远不出现
    snapshot.push(pending('a'));
    await act(async () => {
      FakeEventSource.instances[0]?.emitOpen();
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('a'));
  });

  it('卸载时关掉连接并摘干净监听器（否则整条闭包链留到页面离开）', async () => {
    stubServer({ snapshot: () => [] });

    const { unmount } = renderHook(() => useAskUserQueue());
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());

    unmount();

    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    expect(FakeEventSource.instances[0]?.listenerCount()).toBe(0);
  });
});

describe('useAskUserQueue 的应答', () => {
  it('完成 → POST 之后才出队，队首换成下一问', async () => {
    const fetchMock = stubServer({ snapshot: () => [pending('a'), pending('b')] });

    const { result } = renderHook(() => useAskUserQueue());
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

    const { result } = renderHook(() => useAskUserQueue());
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

    const { result } = renderHook(() => useAskUserQueue());
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

    const { result } = renderHook(() => useAskUserQueue());
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

    const { result } = renderHook(() => useAskUserQueue());
    await waitFor(() => expect(result.current.pendingCount).toBe(2));

    // 另一个标签页答掉了 a：服务端发一条信号、快照里 a 消失
    snapshot = [pending('b')];
    await act(async () => {
      FakeEventSource.instances[0]?.emitNamed(ASK_USER_CHANGED_EVENT, '');
    });

    await waitFor(() => expect(result.current.current?.askId).toBe('b'));
    expect(result.current.pendingCount).toBe(1);
    expect(postCalls(fetchMock)).toHaveLength(0);
  });
});
