// @vitest-environment node
/**
 * `session.ts` 的行为契约：帧序、参数透传、本轮终结的判定边界、中断与提前终止。
 *
 * 用假 client（不 spawn 真进程）：真机联通性由 `protocol` 的录播报文与探针覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServerClient, AppServerNotification } from './client';
import { CODEX_MCP_STARTUP_WAIT, mcpStartupWaitMs, startCodexSession, type CodexSession } from './session';

class FakeClient implements AppServerClient {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  closed = false;
  /** 让某一条请求失败（用来钉「起手失败要回收」那条路） */
  failOn: string | null = null;
  /** 终结原因（`die()` 之后非 null）：此后所有请求被拒，与真客户端同语义 */
  private terminalReason: string | null = null;
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly terminalListeners = new Set<(reason: string) => void>();
  /**
   * 通知历史（与真 `client.ts` 同语义：**先追加历史、再投给当时的订阅者**）。
   * 两者分开才守得住「订阅不补投历史」那条口径——`emit` 在订阅之前发生时，只有历史留得下它。
   */
  private readonly history: AppServerNotification[] = [];

  initialize(): Promise<void> {
    this.requests.push({ method: 'initialize', params: null });
    if (this.failOn === 'initialize') return Promise.reject(new Error('握手超时'));
    return Promise.resolve();
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    // 终结之后不再受理（真客户端的 `terminal` 判据）：等待窗口里进程死掉后 `turn/start` 必被拒
    if (this.terminalReason !== null) return Promise.reject(new Error(this.terminalReason));
    if (this.failOn === method) return Promise.reject(new Error(`${method} 失败（30s 超时）`));
    if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } } as T);
    if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } } as T);
    return Promise.resolve({} as T);
  }

  notifications(): readonly AppServerNotification[] {
    return this.history;
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
    const notification: AppServerNotification = { method, params };
    this.history.push(notification);
    for (const listener of this.notificationListeners) listener(notification);
  }

  die(reason: string): void {
    // 与真 `client.ts` 同语义：终结之后**新的请求一律被拒**（`terminal` 那条判据）
    this.terminalReason = reason;
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

/**
 * 起轮次之前等注入的 MCP 落定。
 *
 * 为什么这组守卫值得单列：工具表**随每条模型请求重算**，而 MCP 工具要 server `ready` 之后才进表
 * ⇒ 起早了，开局那几轮的请求里根本没有 `mcp__<name>`，模型据此断言「当前会话没有暴露 MCP 工具」
 * 并整轮退化成 shell（真机现象与探针 A/B 见 `probe/v10/REPORT.md`）。
 * 判据取**请求顺序**（`turn/start` 在终态通知之后）与**不挂死**（预算到点就放行）两件事。
 */
describe('startCodexSession —— 起轮次前等注入的 MCP 落定', () => {
  /** 让等待器拿到控制权的两拍：一条宏任务足够走完 `await` 链 */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const methods = (client: FakeClient): string[] => client.requests.map((one) => one.method);
  /**
   * 预算按仓库口径写成可变对象，用例把它调小才跑得动；还原放 `afterEach`——
   * **不能放用例体内的 `finally`**：等待不落定时 `await start(...)` 永远不返回，那一段轮不到执行，
   * 被改小的预算会污染后面的用例（表现是「预算」那条无辜见红）。
   */
  const PRODUCT_WAIT = { ...CODEX_MCP_STARTUP_WAIT };
  beforeEach(() => {
    Object.assign(CODEX_MCP_STARTUP_WAIT, PRODUCT_WAIT);
  });
  afterEach(() => {
    Object.assign(CODEX_MCP_STARTUP_WAIT, PRODUCT_WAIT);
  });

  it('注入的 MCP 没落定 ⇒ turn/start 不发；到 ready 才发', async () => {
    const client = new FakeClient();
    const started = start(client, {
      config: { mcp_servers: { probe: { command: 'node', startup_timeout_sec: 30 } } },
    });
    await tick();
    expect(methods(client)).toEqual(['initialize', 'thread/start']);
    client.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'probe', status: 'ready' });
    await started;
    expect(methods(client)).toEqual(['initialize', 'thread/start', 'turn/start']);
  }, 3000);

  it('`starting` 不算落定（把它当终态就是这条缺陷本身）', async () => {
    const client = new FakeClient();
    const started = start(client, {
      config: { mcp_servers: { probe: { command: 'node', startup_timeout_sec: 30 } } },
    });
    await tick();
    client.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'probe', status: 'starting' });
    await tick();
    expect(methods(client)).toEqual(['initialize', 'thread/start']);
    client.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'probe', status: 'ready' });
    await started;
    expect(methods(client)).toContain('turn/start');
  }, 3000);

  it('ready 早于等待登记（只在历史里）⇒ 不卡，立刻起轮次', async () => {
    const client = new FakeClient();
    // 订阅之前就到了：真客户端只把它追加进历史，`subscribe` 不补投
    client.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'probe', status: 'ready' });
    await start(client, {
      config: { mcp_servers: { probe: { command: 'node', startup_timeout_sec: 30 } } },
    });
    expect(methods(client)).toEqual(['initialize', 'thread/start', 'turn/start']);
  }, 3000);

  it('failed 也是终态（不等满预算）', async () => {
    const client = new FakeClient();
    const started = start(client, {
      config: { mcp_servers: { probe: { command: 'node', startup_timeout_sec: 30 } } },
    });
    await tick();
    client.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'probe', status: 'failed', error: '起不来' });
    await started;
    expect(methods(client)).toContain('turn/start');
  }, 3000);

  it('谁都不上报 ⇒ 到预算就起轮次（不挂死）', async () => {
    CODEX_MCP_STARTUP_WAIT.fallbackSec = 0.05;
    CODEX_MCP_STARTUP_WAIT.graceMs = 20;
    const client = new FakeClient();
    await start(client, { config: { mcp_servers: { probe: { command: 'node' } } } });
    expect(methods(client)).toContain('turn/start');
  }, 3000);

  it('等待窗口里进程终止 ⇒ 立刻放行（不白等预算），且照旧回收', async () => {
    const client = new FakeClient();
    const started = start(client, {
      config: { mcp_servers: { probe: { command: 'node', startup_timeout_sec: 30 } } },
    });
    await tick();
    client.die('codex app-server 进程已退出（code=1）');
    await expect(started).rejects.toThrow(/进程已退出/);
    expect(client.closed).toBe(true);
  }, 3000);

  it('没有注入的 MCP ⇒ 不烧预算（不等）', async () => {
    // 预算调到「量得出来」的量级：真去等就一定超过下面那条上限
    CODEX_MCP_STARTUP_WAIT.fallbackSec = 0.3;
    CODEX_MCP_STARTUP_WAIT.graceMs = 0;
    const client = new FakeClient();
    client.emit('mcpServer/startupStatus/updated', { threadId: 'thread-1', name: 'other', status: 'starting' });
    const at = Date.now();
    await start(client);
    expect(Date.now() - at).toBeLessThan(150);
    expect(methods(client)).toEqual(['initialize', 'thread/start', 'turn/start']);
  }, 3000);

  it('预算：条目没申报时按 30 s + 余量；申报了就按最大的那一台算', () => {
    expect(CODEX_MCP_STARTUP_WAIT).toEqual({ fallbackSec: 30, graceMs: 5_000 });
    expect(mcpStartupWaitMs(undefined)).toBe(35_000);
    expect(mcpStartupWaitMs({})).toBe(35_000);
    expect(mcpStartupWaitMs({ mcp_servers: { a: { startup_timeout_sec: 30 } } })).toBe(35_000);
    expect(mcpStartupWaitMs({ mcp_servers: { a: { startup_timeout_sec: 30 }, b: { startup_timeout_sec: 45 } } })).toBe(50_000);
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
 * 起手失败必须回收。
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
