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
  /** `thread/resume` 响应里的 `thread.id`；`null` = 响应里没有这一格（形状不认识那条路） */
  resumedThreadId: string | null = 'thread-resumed';
  /** `thread/queue/add` 响应里的 `queuedSubmission.id`；`null` = 响应里没有这一格 */
  queuedSubmissionId: string | null = 'qs-1';
  /** `thread/queue/delete` 的 `{deleted}` */
  queueDeleteResult = false;
  /** `thread/queue/list` 回读到的提交 id */
  queueListIds: string[] = [];
  /** 每页给几条（`null` = 一次给完）：翻页判据要靠它造出真的多页应答 */
  queueListPageSize: number | null = null;
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
    if (method === 'thread/resume') {
      return Promise.resolve((this.resumedThreadId === null ? {} : { thread: { id: this.resumedThreadId } }) as T);
    }
    if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } } as T);
    if (method === 'thread/queue/add') {
      return Promise.resolve(
        (this.queuedSubmissionId === null ? {} : { queuedSubmission: { id: this.queuedSubmissionId } }) as T,
      );
    }
    if (method === 'thread/queue/delete') return Promise.resolve({ deleted: this.queueDeleteResult } as T);
    if (method === 'thread/queue/list') {
      /**
       * **按页交付**（`queueListPageSize` 为 `null` 时一次给完，与过去同形）：翻页判据只能用
       * 真的分成多页的应答来钉——一次给完的假件下，「读不读 `nextCursor`」两种实现都是绿的。
       */
      const size = this.queueListPageSize;
      if (size === null) return Promise.resolve({ data: this.queueListIds.map((id) => ({ id })), nextCursor: null } as T);
      const offset = Number((params as { cursor?: string } | undefined)?.cursor ?? '0');
      const page = this.queueListIds.slice(offset, offset + size);
      const next = offset + size;
      return Promise.resolve({
        data: page.map((id) => ({ id })),
        nextCursor: next < this.queueListIds.length ? String(next) : null,
      } as T);
    }
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
  it('interrupt 发 turn/interrupt 并带**调用方给的那一轮**坐标', async () => {
    const client = new FakeClient();
    const session = await start(client);
    // 在途轮号由调用方给：续跑之后，建会话时捕获的首轮早就收场了（见 CodexSession.interrupt）
    await session.interrupt('turn-2');
    expect(client.requests[3]).toEqual({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-2' } });
  });

  it('没有在途轮时不发 turn/interrupt（发一个已收场的 id 必被厂商拒）', async () => {
    const client = new FakeClient();
    const session = await start(client);
    await session.interrupt(null);
    expect(client.requests.some((one) => one.method === 'turn/interrupt')).toBe(false);
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

/**
 * **续接**（`thread/resume`）：新进程接上一条已有线程。
 *
 * 判据取**帧序**（`thread/start` 一条都不许出现）与**id 的来源**（响应里的 `thread.id`）两件事：
 * 前者守「不许静默开新会话」（那是最坏的一种——用户以为在追问、智能体其实什么都不记得），
 * 后者守「落盘的键与真正在跑的线程同值」。
 */
describe('startCodexSession —— 续接（thread/resume）', () => {
  it('给了 resumeThreadId ⇒ 只发 thread/resume，id 取自响应的 thread.id', async () => {
    const client = new FakeClient();
    client.resumedThreadId = 'thread-old';
    const session = await start(client, { resumeThreadId: 'thread-old' });
    // `thread/start` 一条都不许出现：它意味着「开了新会话」，而那与用户在追问的预期相反
    expect(client.requests.map((one) => one.method)).toEqual(['initialize', 'thread/resume', 'turn/start']);
    expect(client.requests[1]?.params).toMatchObject({
      threadId: 'thread-old',
      model: 'deepseek-chat',
      cwd: 'D:/w',
    });
    expect(session.threadId).toBe('thread-old');
  });

  it('响应里的 thread.id 才是权威（与请求里那个不同时以响应为准）', async () => {
    const client = new FakeClient();
    client.resumedThreadId = 'thread-canonical';
    const session = await start(client, { resumeThreadId: 'thread-alias' });
    expect(session.threadId).toBe('thread-canonical');
    // 终结判据挂在主线程 id 上 ⇒ 用响应那个 id 投终态必须能结算本轮
    client.emit('turn/completed', {
      threadId: 'thread-canonical',
      turn: { id: 'turn-1', items: [], status: 'completed' },
    });
    await expect(session.outcome).resolves.toMatchObject({ status: 'completed' });
  });

  it('thread/resume 不返回 thread.id ⇒ 报错点名（不拿请求里那个冒充）', async () => {
    const client = new FakeClient();
    client.resumedThreadId = null;
    await expect(start(client, { resumeThreadId: 'thread-old' })).rejects.toThrow(/thread\/resume/);
  });

  it('thread/resume 报错 ⇒ 原样抛且**不回落** thread/start，已 spawn 的客户端被回收', async () => {
    const client = new FakeClient();
    client.failOn = 'thread/resume';
    await expect(start(client, { resumeThreadId: 'thread-old' })).rejects.toThrow(/thread\/resume 失败/);
    expect(client.requests.some((one) => one.method === 'thread/start')).toBe(false);
    expect(client.closed).toBe(true);
  });
});

/**
 * **两档注入的 wire 面**：`turn/steer`（在途）与 `thread/queue/*`（耐久队列）。
 *
 * 入参形状照本机 0.156.1 的生成物：`TurnSteerParams.required = ['expectedTurnId','input','threadId']`
 * （`clientUserMessageId` 可选）、`ThreadQueueAddParams.required =
 * ['clientUserMessageId','input','threadId']`（**必填**，由我们铸）、
 * `ThreadQueueDeleteParams.required = ['queuedSubmissionId','threadId']` → `{deleted}`。
 */
describe('startCodexSession —— 注入的 wire 面（steer / queue）', () => {
  it('steer：expectedTurnId 是本轮 id，clientUserMessageId 是编排层那一条的身份', async () => {
    const client = new FakeClient();
    const session = await start(client);
    await session.steer({ text: '顺便把 changelog 补上', messageId: 'msg-1', expectedTurnId: 'turn-1' });
    expect(client.requests[3]).toEqual({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'msg-1',
        input: [{ type: 'text', text: '顺便把 changelog 补上', text_elements: [] }],
      },
    });
  });

  it('steer 被厂商拒（没有在途轮）⇒ 错误原文照抛，由端口那一层决定怎么处置', async () => {
    const client = new FakeClient();
    client.failOn = 'turn/steer';
    const session = await start(client);
    await expect(session.steer({ text: '喂', messageId: 'm', expectedTurnId: 'turn-1' })).rejects.toThrow(/turn\/steer 失败/);
  });

  it('queueAdd：clientUserMessageId 必填，交回厂商的 queuedSubmission.id', async () => {
    const client = new FakeClient();
    client.queuedSubmissionId = 'qs-9';
    const session = await start(client);
    await expect(session.queueAdd({ text: '等这轮跑完再说', messageId: 'msg-2' })).resolves.toBe('qs-9');
    expect(client.requests[3]).toEqual({
      method: 'thread/queue/add',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'msg-2',
        input: [{ type: 'text', text: '等这轮跑完再说', text_elements: [] }],
      },
    });
  });

  it('queueAdd 的响应形状不认识 ⇒ 点名报错（拿不到 id 就没法按身份撤回）', async () => {
    const client = new FakeClient();
    client.queuedSubmissionId = null;
    const session = await start(client);
    await expect(session.queueAdd({ text: '喂', messageId: 'm' })).rejects.toThrow(/queuedSubmission\.id/);
  });

  it('queueDelete：按 queuedSubmissionId，`{deleted}` 如实回', async () => {
    const client = new FakeClient();
    client.queueDeleteResult = true;
    const session = await start(client);
    await expect(session.queueDelete('qs-9')).resolves.toBe(true);
    expect(client.requests[3]).toEqual({
      method: 'thread/queue/delete',
      params: { threadId: 'thread-1', queuedSubmissionId: 'qs-9' },
    });
    client.queueDeleteResult = false;
    await expect(session.queueDelete('qs-9')).resolves.toBe(false);
  });

  it('queueList：读回队列里的提交 id（撤回那一刻判「还在不在队列里」）', async () => {
    const client = new FakeClient();
    client.queueListIds = ['qs-1', 'qs-2'];
    const session = await start(client);
    await expect(session.queueList()).resolves.toEqual(['qs-1', 'qs-2']);
    expect(client.requests[3]).toEqual({ method: 'thread/queue/list', params: { threadId: 'thread-1' } });
  });

  /**
   * **翻完页才算读全**。
   *
   * 要拦的缺陷：只读第一页、丢掉 `nextCursor`。这份读数的唯一消费方是撤回那条路
   * （`thread/queue/delete` 只回 `{deleted:false}`，「已消费 / 已删过 / id 不对」分不开，
   * 要靠「这条还在不在队列里」才分得开）⇒ 排在后面几页的那条会被读成「已经不在队列里了」，
   * 撤回于是给出**相反**的结论（答 `already-consumed`，而它其实还在队里等着投给模型）。
   */
  it('queueList：跟着 `nextCursor` 翻完（只读第一页会让撤回给出相反的结论）', async () => {
    const client = new FakeClient();
    client.queueListIds = ['qs-1', 'qs-2', 'qs-3', 'qs-4', 'qs-5'];
    client.queueListPageSize = 2;
    const session = await start(client);
    await expect(session.queueList()).resolves.toEqual(['qs-1', 'qs-2', 'qs-3', 'qs-4', 'qs-5']);
    const listCalls = client.requests.filter((one) => one.method === 'thread/queue/list');
    expect(listCalls).toHaveLength(3);
    // 第一页不带 cursor（那一格缺席才是「从头读」），后续页逐页带上它
    expect(listCalls[0]?.params).toEqual({ threadId: 'thread-1' });
    expect(listCalls[1]?.params).toEqual({ threadId: 'thread-1', cursor: '2' });
    expect(listCalls[2]?.params).toEqual({ threadId: 'thread-1', cursor: '4' });
  });
});
