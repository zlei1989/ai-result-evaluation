/**
 * 人工消息数据层：快照 + 信号流 + 四个写动作接到一起之后的行为。
 *
 * 五条风险面（每一条都能单独坏掉，且坏掉的表现都是「界面照旧工作、只是说的不是真的」）：
 *   1. 挂载即拉快照、**接的是全局流**（与列表信号、待答快照共用同一条连接，不是自己那条流）；
 *   2. 只认 `inject-messages-changed` 那一族帧（同一连接上还有另两族，认错了就是白翻请求）；
 *   3. 断线重连**补读一次**（帧不重放，不补就漏掉断线期间登记的那几条；判据在 hub 层统一）；
 *   4. 写动作**成败都重读快照**：撤回成功那一条落 `gone`、撤不回来那一条落 `consumed` 带原因；
 *      **不做乐观出队**（那会让用户以为撤干净了，而厂商那边还留着）；
 *   5. `enabled === false`（闸门关着 / 抽屉关着）时一个请求都不发、一条连接都不开。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { ServiceError, type InjectMessage, type InjectMessageSendRequest } from '@aieval/contracts';
import { GLOBAL_STREAM_URL, resetGlobalStreamHubForTesting } from './global-stream-hub';
import {
  INJECT_MESSAGES_ATTACHMENTS_URL,
  INJECT_MESSAGES_PROMOTE_URL,
  INJECT_MESSAGES_RETRACT_URL,
  INJECT_MESSAGES_URL,
  injectMessagesUrl,
  useInjectMessages,
} from './inject-messages';
import type { UseInjectMessagesInput } from './inject-messages';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';

/** fetch 替身的签名显式写出来：`vi.fn(async () => …)` 会被推成零参函数，`mock.calls[0][0]` 报 TS2493 */
type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;
type FetchMock = Mock<FetchHandler>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 一条人工消息：只给断言要用的那几格 */
function messageOf(messageId: string, overrides: Partial<InjectMessage> = {}): InjectMessage {
  return {
    messageId,
    text: `${messageId} 的正文`,
    attachments: [],
    requires: 'idle',
    state: 'queued',
    createdAt: '2026-09-22T10:30:00.000Z',
    deliveredAt: null,
    settledAt: null,
    outcome: null,
    reason: null,
    ...overrides,
  };
}

const KEY = injectMessagesUrl('run-1', 'w-1');

/**
 * 假服务端：`GET` 给当前快照（由用例持有的函数决定，便于中途改），三个写动作各按用例给的裁决回话。
 * 其余路径一律 404——本 hook 只该碰这五个端点，多出来的请求要在断言里现形。
 */
function stubServer(options: {
  snapshot: () => InjectMessage[];
  onSend?: (body: InjectMessageSendRequest) => Response | Promise<Response>;
  onRetract?: () => Response | Promise<Response>;
  onPromote?: () => Response | Promise<Response>;
  onUpload?: () => Response | Promise<Response>;
}): FetchMock {
  const fetchMock = vi.fn<FetchHandler>(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === KEY) return json(options.snapshot());
    if (target === INJECT_MESSAGES_URL && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as InjectMessageSendRequest;
      return options.onSend?.(body) ?? json({ created: true, message: messageOf(body.messageId) });
    }
    if (target === INJECT_MESSAGES_RETRACT_URL && init?.method === 'POST') {
      return options.onRetract?.() ?? json({ outcome: 'removed', message: messageOf('m-1', { state: 'gone' }) });
    }
    if (target === INJECT_MESSAGES_PROMOTE_URL && init?.method === 'POST') {
      return (
        options.onPromote?.() ??
        json({ outcome: 'promoted', message: messageOf('m-1', { requires: 'round' }) })
      );
    }
    if (target === INJECT_MESSAGES_ATTACHMENTS_URL && init?.method === 'POST') {
      return options.onUpload?.() ?? json({ kind: 'file', path: '/tmp/row/attachments/m-1/a.md', mimeType: 'text/markdown' });
    }
    return json({ error: { code: 'NOT_FOUND', message: '没有这个路由' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 读快照的请求次数（写动作之后那次重读也算） */
function snapshotReads(fetchMock: FetchMock): number {
  return fetchMock.mock.calls.filter(([url]) => String(url) === KEY).length;
}


/**
 * 渲染这个 hook，并给每次渲染一份**全新的 SWR 缓存**。
 *
 * 不给的话同一个文件里的用例会共用模块级缓存（SWR 的默认 provider 挂在模块作用域上）：
 * 第二个用例渲染同一个键时直接用上一条用例的数据、连 `fetch` 都不发（`dedupingInterval` 还会
 * 把重读压掉）——症状是用例自己绿着，而它断言的那次请求根本没发生。
 */
function renderInjectHook(input: UseInjectMessagesInput) {
  return renderHook(() => useInjectMessages(input), {
    wrapper: ({ children }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
    ),
  });
}

/** 服务端帧的原文（api 的 `toFrame` 逐字同形：无名事件、无 `id:` 行） */
const INJECT_CHANGED_FRAME = 'data: {"type":"inject-messages-changed"}\n\n';

beforeEach(() => {
  FakeEventSource.reset();
  resetGlobalStreamHubForTesting();
  installEventSourceStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('订阅：快照 + 信号流', () => {
  it('挂载即拉快照，并接上全局流（与列表信号、待答快照共用一条连接）', async () => {
    stubServer({ snapshot: () => [messageOf('m-1')] });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });

    await waitFor(() => expect(result.current.messages).toHaveLength(1));
    expect(result.current.messages[0]?.messageId).toBe('m-1');
    expect(FakeEventSource.instances[0]?.url).toBe(GLOBAL_STREAM_URL);
  });

  it('只认 inject-messages-changed 那一族帧：同一条连接上的另两族不重读队列快照', async () => {
    let snapshot: InjectMessage[] = [messageOf('m-1')];
    const fetchMock = stubServer({ snapshot: () => snapshot });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(result.current.messages).toHaveLength(1));

    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();
    // 另两族（列表状态翻转、待答挂起表变更）与本队列无关 ⇒ 不该重读
    snapshot = [messageOf('m-1'), messageOf('m-2')];
    act(() => {
      source?.feed('data: {"type":"run-updated","runId":"run-1"}\n\n');
      source?.feed('data: {"type":"ask-user-changed"}\n\n');
    });
    expect(snapshotReads(fetchMock)).toBe(1);

    // 本族帧：帧里只有「变了」，内容靠重读拿
    act(() => source?.feed(INJECT_CHANGED_FRAME));
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
  });

  it('重连补读一次（帧不重放，断线期间登记的条目靠这一读补回来）；首次连接不重复读', async () => {
    let snapshot: InjectMessage[] = [messageOf('m-1')];
    const fetchMock = stubServer({ snapshot: () => snapshot });
    renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    const source = FakeEventSource.instances[0];
    // 首次连接：挂载时那一次读就在同一瞬间，不补读
    act(() => source?.emitOpen());
    expect(snapshotReads(fetchMock)).toBe(1);

    // 断线期间登记了一条，重连时补读
    snapshot = [messageOf('m-1'), messageOf('m-2')];
    act(() => source?.emitOpen());
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(2));
  });

  it('卸载时把那条连接关掉（全局信号流不该随抽屉关掉而泄漏）', async () => {
    stubServer({ snapshot: () => [] });
    const { unmount } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    unmount();
    expect(source?.closeCount).toBe(1);
  });

  it('`enabled === false`：一个请求都不发、一条连接都不开', async () => {
    const fetchMock = stubServer({ snapshot: () => [messageOf('m-1')] });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: false });

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.messages).toEqual([]);
  });
});

describe('写动作：失败也不许乐观出队', () => {
  it('发送成功之后重读快照（队列以服务端为准，客户端不自己往队尾塞一条）', async () => {
    let snapshot: InjectMessage[] = [];
    const fetchMock = stubServer({ snapshot: () => snapshot });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    snapshot = [messageOf('m-9')];
    await act(async () => {
      await result.current.send({ runId: 'run-1', rowId: 'w-1', messageId: 'm-9', text: '话', attachments: [], requires: 'idle' });
    });
    await waitFor(() => expect(result.current.messages.map((item) => item.messageId)).toEqual(['m-9']));
    expect(snapshotReads(fetchMock)).toBe(2);
  });

  it('撤回失败（409「已经交给模型了」）⇒ 抛原因，且**仍然重读**快照（那一条会落 `consumed`）', async () => {
    let snapshot: InjectMessage[] = [messageOf('m-1', { state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' })];
    const fetchMock = stubServer({
      snapshot: () => snapshot,
      onRetract: () => json({ error: { code: 'CONFLICT', message: '已经交给智能体了，撤不回来' } }, 409),
    });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    // 服务端在那次失败的撤回里把它判成 consumed
    snapshot = [messageOf('m-1', { state: 'consumed', deliveredAt: '2026-09-22T10:31:00.000Z', settledAt: '2026-09-22T10:32:00.000Z', reason: '厂商说已经交给模型了' })];
    await expect(
      act(async () => {
        await result.current.retract('m-1');
      }),
    ).rejects.toThrow(ServiceError);

    await waitFor(() => expect(result.current.messages[0]?.state).toBe('consumed'));
    expect(snapshotReads(fetchMock)).toBe(2);
  });

  it('撤回成功 ⇒ 重读，那一条以 `gone` 出现（不是就地摘掉）', async () => {
    let snapshot: InjectMessage[] = [messageOf('m-1')];
    const fetchMock = stubServer({
      snapshot: () => snapshot,
      onRetract: () => json({ outcome: 'removed', message: messageOf('m-1', { state: 'gone', settledAt: '2026-09-22T10:32:00.000Z', outcome: 'retracted' }) }),
    });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    snapshot = [messageOf('m-1', { state: 'gone', settledAt: '2026-09-22T10:32:00.000Z', outcome: 'retracted' })];
    await act(async () => {
      await result.current.retract('m-1');
    });
    await waitFor(() => expect(result.current.messages[0]?.state).toBe('gone'));
    // 数据层**原样透出** `gone`：跳过它是渲染层的口径（它带着「为什么消失」）
    expect(result.current.messages).toHaveLength(1);
  });

  it('改期带齐三格定位（`runId` / `rowId` / `messageId` 走请求体）', async () => {
    const fetchMock = stubServer({ snapshot: () => [messageOf('m-1')] });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    await act(async () => {
      await result.current.promote('m-1');
    });
    const call = fetchMock.mock.calls.find(([url]) => String(url) === INJECT_MESSAGES_PROMOTE_URL);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ runId: 'run-1', rowId: 'w-1', messageId: 'm-1' });
  });

  it('附件上传走 multipart：三格文本 + 字段名固定 `file`，且不自己写 `content-type`', async () => {
    const fetchMock = stubServer({ snapshot: () => [messageOf('m-1')] });
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    const file = new File(['hello'], 'a.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current.uploadAttachment('m-1', file);
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url) === INJECT_MESSAGES_ATTACHMENTS_URL);
    const form = call?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    const body = form as FormData;
    expect(body.get('runId')).toBe('run-1');
    expect(body.get('rowId')).toBe('w-1');
    expect(body.get('messageId')).toBe('m-1');
    expect(body.get('file')).toBeInstanceOf(File);
    // 手写 `content-type` 会把 boundary 丢掉，服务端 `formData()` 会解析出零个字段
    expect(call?.[1]?.headers).toBeUndefined();
  });

  it('写动作在途时 `busy` 为真（按钮据此禁用，免得同一句话发两遍）', async () => {
    let release: (() => void) | null = null;
    const fetchMock = stubServer({ snapshot: () => [] });
    fetchMock.mockImplementationOnce(async () => json([])); // 首次快照
    const { result } = renderInjectHook({ runId: 'run-1', rowId: 'w-1', enabled: true });
    await waitFor(() => expect(snapshotReads(fetchMock)).toBe(1));

    fetchMock.mockImplementationOnce(
      async () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ created: true, message: messageOf('m-9') }));
        }),
    );
    let pending: Promise<unknown> | null = null;
    act(() => {
      pending = result.current.send({ runId: 'run-1', rowId: 'w-1', messageId: 'm-9', text: '话', attachments: [], requires: 'idle' });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await act(async () => {
      release?.();
      await pending;
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });
});
