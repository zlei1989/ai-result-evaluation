// @vitest-environment node
/**
 * `session.ts` 的行为契约：帧序、参数透传、本轮终结的判定边界、中断与提前终止。
 *
 * 用假 client（不 spawn 真进程）：真机联通性由 `protocol` 的录播报文与探针覆盖。
 */
import { describe, expect, it } from 'vitest';
import type { AppServerClient, AppServerNotification } from './client';
import { startCodexSession, type CodexSession } from './session';

class FakeClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  closed = false;
  /** 让某一条请求失败（用来钉「起手失败要回收」那条路） */
  failOn: string | null = null;
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly terminalListeners = new Set<(reason: string) => void>();

  initialize(): Promise<void> {
    this.requests.push({ method: 'initialize', params: null });
    if (this.failOn === 'initialize') return Promise.reject(new Error('握手超时'));
    return Promise.resolve();
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.failOn === method) return Promise.reject(new Error(`${method} 失败（30s 超时）`));
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } } as T);
    if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } } as T);
    return Promise.resolve({} as T);
  }

  notifications(): readonly AppServerNotification[] {
    return [];
  }

  subscribe(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onTerminal(listener: (reason: string) => void): () => void {
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  serverRequests(): readonly [] {
    return [];
  }

  unparsedFrames(): number {
    return 0;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  emit(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  die(reason: string): void {
    for (const listener of this.terminalListeners) listener(reason);
  }
}

const BASE_INPUT = {
  binary: 'C:/fake/codex.exe',
  env: {},
  cwd: 'D:/w',
  model: 'deepseek-chat',
  sandbox: 'workspace-write',
  approvalPolicy: 'never',
  prompt: '派一个子智能体回答 1+1',
} as const;

async function start(client: FakeClient, extra: Record<string, unknown> = {}): Promise<CodexSession> {
  return await startCodexSession({ ...BASE_INPUT, ...extra, client });
}

/** 收齐通知流（生成器在终结后自行结束） */
async function drain(session: CodexSession): Promise<string[]> {
  const kinds: string[] = [];
  for await (const payload of session.notifications) kinds.push(payload.kind);
  return kinds;
}

describe('startCodexSession —— 帧序与参数', () => {
  it('initialize → thread/start → turn/start，且线程参数落在 thread/start', async () => {
    const client = new FakeClient();
    await start(client);
    expect(client.requests.map((one) => one.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    expect(client.requests[1]?.params).toMatchObject({
      model: 'deepseek-chat',
      cwd: 'D:/w',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
    });
  });

  it('提示词按 UserInput.text 提交，text_elements 为空数组', async () => {
    const client = new FakeClient();
    await start(client);
    const params = client.requests[2]?.params as { threadId: string; input: Array<Record<string, unknown>> };
    expect(params.threadId).toBe('thread-1');
    expect(params.input).toEqual([{ type: 'text', text: BASE_INPUT.prompt, text_elements: [] }]);
  });

  it('effort 与 outputSchema 只出现在 turn/start（thread/start 不接受这两格）', async () => {
    const client = new FakeClient();
    await start(client, { effort: 'high', outputSchema: { type: 'object' } });
    expect(client.requests[1]?.params).not.toHaveProperty('effort');
    expect(client.requests[2]?.params).toMatchObject({ effort: 'high', outputSchema: { type: 'object' } });
  });

  it('thread/start 不返回 thread.id 时立即报错（不带着空 id 继续）', async () => {
    const client = new FakeClient();
    client.request = <T,>(method: string): Promise<T> => {
      client.requests.push({ method, params: null });
      return Promise.resolve({} as T);
    };
    await expect(start(client)).rejects.toThrow(/thread\/start/);
  });
});

describe('startCodexSession —— 终结边界', () => {
  it('终态通知带状态、错误与时长', async () => {
    const client = new FakeClient();
    const session = await start(client);
    const outcome = session.outcome;
    client.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'failed', error: { message: '模型超时' }, durationMs: 1234 },
    });
    await expect(outcome).resolves.toEqual({ status: 'failed', error: '模型超时', durationMs: 1234 });
  });

  it('子线程的 turn/completed 不结算本轮，但通知照样产出', async () => {
    const client = new FakeClient();
    const session = await start(client);
    let settled: unknown = null;
    void session.outcome.then((value) => {
      settled = value;
    });
    // 子线程失败：若它被当成本轮终结，settled 会立刻变成 failed
    client.emit('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', items: [], status: 'failed', error: { message: '子线程失败' } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBeNull();
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'completed' } });
    await expect(session.outcome).resolves.toMatchObject({ status: 'completed', error: null });
    await expect(drain(session)).resolves.toEqual(['turnCompleted', 'turnCompleted']);
  });

  it('流在终结后结束（不会挂住）', async () => {
    const client = new FakeClient();
    const session = await start(client);
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '好' } });
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'completed' } });
    await expect(drain(session)).resolves.toEqual(['itemCompleted', 'turnCompleted']);
  });
});

describe('startCodexSession —— 中断、终止与关闭', () => {
  it('interrupt 发 turn/interrupt 并带本轮坐标', async () => {
    const client = new FakeClient();
    const session = await start(client);
    await session.interrupt();
    expect(client.requests[3]).toEqual({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  });

  it('进程提前终止 ⇒ 本轮以 failed + 原因结算，流结束', async () => {
    const client = new FakeClient();
    const session = await start(client);
    const drained = drain(session);
    client.die('codex app-server 进程已退出（code=1）');
    await expect(session.outcome).resolves.toEqual({
      status: 'failed',
      error: 'codex app-server 进程已退出（code=1）',
      durationMs: null,
    });
    await expect(drained).resolves.toEqual([]);
  });

  it('close 关掉底层客户端', async () => {
    const client = new FakeClient();
    const session = await start(client);
    await session.close();
    expect(client.closed).toBe(true);
  });
});

/**
 * 起手失败必须回收（2026-10-07）。
 *
 * 为什么单列一组：这三步抛错时 `runTurn` 里 `started` 还是 undefined ⇒ `dispose` **永远不会被调用**
 * （`dispose` 挂在 `TurnStart` 上，而它根本没被返回）。进程就此常驻，并一直持着该行的 `$CODEX_HOME`
 * ——下一轮的行产物清理会 `EPERM`。守卫的判据是「client 被关了」，不是「错误有没有抛」。
 */
describe('startCodexSession —— 起手失败要回收已经 spawn 的进程', () => {
  it('initialize 失败 ⇒ 客户端被关闭，原始错误照抛', async () => {
    const client = new FakeClient();
    client.failOn = 'initialize';
    await expect(start(client)).rejects.toThrow(/握手超时/);
    expect(client.closed).toBe(true);
  });

  it('thread/start 失败（超时）⇒ 客户端被关闭', async () => {
    const client = new FakeClient();
    client.failOn = 'thread/start';
    await expect(start(client)).rejects.toThrow(/thread\/start 失败/);
    expect(client.closed).toBe(true);
  });

  it('turn/start 失败 ⇒ 客户端被关闭', async () => {
    const client = new FakeClient();
    client.failOn = 'turn/start';
    await expect(start(client)).rejects.toThrow(/turn\/start 失败/);
    expect(client.closed).toBe(true);
  });

  it('正常起手不关（回收归 dispose 那条路，提前关会把会话掐死）', async () => {
    const client = new FakeClient();
    await start(client);
    expect(client.closed).toBe(false);
  });
});

describe('startCodexSession —— settled 闸门', () => {
  it('流正常产完 ⇒ settled 落定，且此时 outcome 已结算', async () => {
    const client = new FakeClient();
    const session = await start(client);
    const drained = drain(session);
    client.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'completed' } });
    await drained;
    await expect(session.settled).resolves.toBeUndefined();
    await expect(session.outcome).resolves.toMatchObject({ status: 'completed' });
  }, 3000);

  it('消费者提前停止迭代 ⇒ settled 同样落定（finally 分支）', async () => {
    const client = new FakeClient();
    const session = await start(client);
    const iterator = session.notifications[Symbol.asyncIterator]();
    client.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '半' } });
    await iterator.next();
    await iterator.return?.(undefined);
    await expect(session.settled).resolves.toBeUndefined();
  }, 3000);
});
