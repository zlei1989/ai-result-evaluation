/**
 * app-server 的假客户端夹具：单测「不 spawn 真 codex、不碰真网络」的全部物质基础。
 *
 * 为什么单独一个文件（不进 `testing/agent-fixtures.ts`）：那一份是三家共用的假厂商件，
 * 而 app-server 是 codex 一家自己的协议（帧、请求、通知），混进去会让另两家读到一个无关的抽象。
 *
 * 三条保真要求（不满足就会给出真实进程没有的能力、守卫变假绿）：
 *   1. **通知是推的**：`subscribe` 之后由夹具主动投递，测试不能替适配器「拉」；
 *      订阅前推入的那些**丢掉**（与真实 `appserver/client.ts` 逐字同语义：通知照进历史列表，
 *      但没有订阅者时不投递给任何人）。⚠️ 「缓冲到首个订阅者再补投」是**比真实更宽容**的语义——
 *      它正好盖住「订阅晚于 `thread/start` ⇒ MCP 启动状态全丢」这条真机缺陷，故按真实行为收紧；
 *   2. **请求是配对的**：`thread/list` / `thread/read` / `thread/items/list` 走 `respond` 表，
 *      未登记的方法**响亮失败**（静默返回 `{}` 会让「请求没发」与「发了没人管」长得一样）；
 *   3. **帧序可断言**：`requests` 按序记下每一次方法名与参数（对账注入落点的唯一客观量）。
 *
 * 本模块只被 `*.test.ts` import。
 */
import type {
  AppServerChild,
  AppServerClient,
  AppServerEnv,
  AppServerNotification,
  AppServerServerRequest,
} from './appserver/client';

/** 一条通知的原始形状（与 `client.ts` 收到的帧同形） */
export interface FakeNotification {
  method: string;
  params: unknown;
}

export interface FakeAppServerStats {
  /** 按序记录每一次请求（方法 + 参数原文） */
  requests: Array<{ method: string; params: unknown }>;
  /** `initialize` 被调用的次数（幂等性可断言） */
  initializeCount: number;
  /** 关闭次数（释放路径的可观测量） */
  closeCount: number;
  /** 收到过的通知（方法名，按序） */
  notificationMethods: string[];
}

export interface FakeAppServerOptions {
  /** 线程 id（`thread/start` 的响应）；缺省 `thread-main` */
  threadId?: string;
  /** 轮次 id（`turn/start` 的响应）；缺省 `turn-1` */
  turnId?: string;
  /**
   * `turn/start` 受理时投递的通知（按序）。
   * 适配器**在这之前就已经订阅**（`session.ts` 的骨架建在 `thread/start` 之前），故这一批直接到达；
   * 若哪天订阅又挪到 `turn/start` 之后，这一批会**静默丢掉**（与真实客户端一致，见 `emit` 的注释）。
   */
  notifications?: readonly FakeNotification[];
  /**
   * 请求应答表：`方法 → 应答（或抛错）`。
   * 只有 `initialize` 与 `thread/start` / `turn/start` 走夹具内建的那三条应答；
   * **取数面的方法必须登记**——否则夹具会响亮失败（静默返回空表会让 `reader` 拿到空线程树，
   * 那正是要防的假绿）。
   */
  respond?: Record<string, (params: Record<string, unknown>) => unknown>;
  /** `thread/start` 抛错（模拟 CLI 未安装 / 线程建不起来） */
  threadError?: unknown;
  /**
   * 「某个请求**处理到一半**时投递这些通知」：`方法 → 通知列表`。
   * 用来复现「响应还没回来，通知先到」的真实时序——MCP 启动状态就落在
   * `thread/start` 与 `turn/start` 之间（见 `codex/index.test.ts` 的那条守卫）。
   * **没有订阅者时它们照样丢**（与真实客户端同语义，见 `emit` 的注释）。
   */
  emitOnRequest?: Record<string, readonly FakeNotification[]>;
  /**
   * 不投递 `turn/completed`：通知流保持开着（`turn/start` 之后只挂住）。
   * 用来观察「本轮还没结算」时的行为——终止、运行期事件、`interrupt` 的帧。
   */
  hangUntilTerminal?: boolean;
}

export interface FakeAppServer {
  client: AppServerClient;
  stats: FakeAppServerStats;
  /** `thread/start` 之后才知道的主线程 id（注入落点与线程树锚点） */
  threadId: string;
  turnId: string;
  /**
   * 手动投递一条通知。
   * 与**真实客户端逐字同语义**（`appserver/client.ts`）：通知照进历史列表，但**没有订阅者时
   * 不投递给任何人**（丢）。「缓冲到首个订阅者再补投」是**比真实更宽容**的语义，
   * 而那正好把「订阅晚于 `thread/start` ⇒ MCP 启动状态全丢」这条真机缺陷盖住。
   */
  emit: (method: string, params: unknown) => void;
  /** 模拟进程退出 / 启动失败：待收请求全部拒绝，通知流随之结束 */
  die: (reason: string) => void;
}

/** 造一个假 app-server 客户端（不 spawn 任何进程） */
export function createFakeAppServer(options: FakeAppServerOptions = {}): FakeAppServer {
  const threadId = options.threadId ?? 'thread-main';
  const turnId = options.turnId ?? 'turn-1';
  const stats: FakeAppServerStats = { requests: [], initializeCount: 0, closeCount: 0, notificationMethods: [] };
  const notifications: AppServerNotification[] = [];
  const listeners = new Set<(notification: AppServerNotification) => void>();
  const terminalListeners = new Set<(reason: string) => void>();
  const serverRequests: AppServerServerRequest[] = [];
  let terminal: string | null = null;
  let closed = false;

  const push = (method: string, params: unknown): void => {
    const notification: AppServerNotification = { method, params };
    notifications.push(notification);
    stats.notificationMethods.push(method);
    // **没有订阅者 = 丢**（与真实客户端逐字同语义，见 `emit` 的注释）：夹具不能比真实更宽容，
    // 否则「订阅晚了一步」这类缺陷在单测里永远看不见
    for (const listener of listeners) listener(notification);
  };

  const client: AppServerClient = {
    initialize: () => {
      stats.initializeCount += 1;
      stats.requests.push({ method: 'initialize', params: null });
      return Promise.resolve();
    },
    request: <T,>(method: string, params?: unknown): Promise<T> => {
      stats.requests.push({ method, params });
      for (const one of options.emitOnRequest?.[method] ?? []) push(one.method, one.params);
      if (closed) return Promise.reject(new Error('codex app-server 客户端已关闭'));
      if (terminal !== null) return Promise.reject(new Error(terminal));
      if (method === 'thread/start') {
        if (options.threadError !== undefined) return Promise.reject(options.threadError);
        return Promise.resolve({ thread: { id: threadId } } as T);
      }
      if (method === 'turn/start') {
        // 提交即开始产通知：真实 app-server 的 `item/*` 在 `turn/start` 响应之后就到
        if (options.hangUntilTerminal !== true) {
          for (const one of options.notifications ?? []) push(one.method, one.params);
        }
        return Promise.resolve({ turn: { id: turnId } } as T);
      }
      if (method === 'turn/interrupt') return Promise.resolve({} as T);
      const handler = options.respond?.[method];
      if (handler === undefined) return Promise.reject(new Error(`假 app-server 未登记的方法：${method}`));
      const record = (params ?? {}) as Record<string, unknown>;
      try {
        return Promise.resolve(handler(record) as T);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    notifications: () => notifications,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onTerminal: (listener) => {
      terminalListeners.add(listener);
      return () => {
        terminalListeners.delete(listener);
      };
    },
    serverRequests: () => serverRequests,
    unparsedFrames: () => 0,
    close: () => {
      closed = true;
      stats.closeCount += 1;
      for (const listener of terminalListeners) listener('codex app-server 客户端已关闭');
      // 真实 `close()` 是异步的（回收整棵进程树 + 等退出，见 `client.ts`）；替身保持同形
      return Promise.resolve();
    },
  };

  return {
    client,
    stats,
    threadId,
    turnId,
    emit: push,
    die: (reason) => {
      terminal = reason;
      for (const listener of terminalListeners) listener(reason);
    },
  };
}

/**
 * 一个**从没被 spawn 过**的子进程替身：只用来断言「适配器有没有绕过注入口去 spawn」。
 * 任何成员被碰到都抛错——静默成功的替身会让「注入口被绕开」这件事不可见。
 */
export function createExplodingChild(): AppServerChild {
  const boom = (): never => {
    throw new Error('假子进程不该被使用：适配器必须走注入的客户端');
  };
  return {
    stdin: { write: boom },
    stdout: { on: boom },
    stderr: { on: boom },
    // `on` 在 `AppServerChild` 上是两个重载，单个「碰一下就炸」的实现满足不了重载签名 ⇒ 断言一次。
    // 断言而不是补一个空实现：空实现会让「适配器绕开注入口去 spawn」这件事静默地看不出来。
    on: boom as unknown as AppServerChild['on'],
    kill: boom,
  };
}

/** 空的子进程环境（`AppServerEnv` 是只读字典；值域见 `client.ts` 的注释） */
export const EMPTY_ENV: AppServerEnv = {};
// ---------------------------------------------------------------------------
// 通知构造器：形状逐字对齐 `codex app-server generate-ts --experimental`（0.156.1）
// ---------------------------------------------------------------------------

/** `thread/started`：`{ thread }` */
export function threadStarted(
  thread: Record<string, unknown> & { id: string },
): FakeNotification {
  return { method: 'thread/started', params: { thread } };
}

/** `item/completed`：`{ item, threadId, turnId, completedAtMs }` */
export function itemCompleted(
  item: Record<string, unknown> & { type: string; id: string },
  where: { threadId: string; turnId: string; completedAtMs?: number },
): FakeNotification {
  return {
    method: 'item/completed',
    params: { item, threadId: where.threadId, turnId: where.turnId, completedAtMs: where.completedAtMs ?? 1_700_000_000_000 },
  };
}

/** `item/started`：`{ item, threadId, turnId, startedAtMs }` */
export function itemStarted(
  item: Record<string, unknown> & { type: string; id: string },
  where: { threadId: string; turnId: string; startedAtMs?: number },
): FakeNotification {
  return {
    method: 'item/started',
    params: { item, threadId: where.threadId, turnId: where.turnId, startedAtMs: where.startedAtMs ?? 1_700_000_000_000 },
  };
}

/** `item/agentMessage/delta`：`{ threadId, turnId, itemId, delta }` */
export function agentMessageDelta(
  delta: string,
  where: { threadId: string; turnId: string; itemId: string },
): FakeNotification {
  return { method: 'item/agentMessage/delta', params: { ...where, delta } };
}

/** `item/reasoning/textDelta`（完整推理正文的增量） */
export function reasoningTextDelta(
  delta: string,
  where: { threadId: string; turnId: string; itemId: string; contentIndex?: number },
): FakeNotification {
  return { method: 'item/reasoning/textDelta', params: { ...where, delta, contentIndex: where.contentIndex ?? 0 } };
}

/** `item/reasoning/summaryTextDelta`（厂商摘要的增量） */
export function reasoningSummaryDelta(
  delta: string,
  where: { threadId: string; turnId: string; itemId: string; summaryIndex?: number },
): FakeNotification {
  return {
    method: 'item/reasoning/summaryTextDelta',
    params: { ...where, delta, summaryIndex: where.summaryIndex ?? 0 },
  };
}

/** `turn/completed`：`{ threadId, turn }`。`startedAt` / `completedAt` 的单位是**秒**（与协议一致） */
export function turnCompleted(
  turn: {
    id: string;
    status?: string;
    error?: { message: string } | null;
    items?: readonly Record<string, unknown>[];
    startedAt?: number | null;
    completedAt?: number | null;
    durationMs?: number | null;
  },
  where: { threadId: string },
): FakeNotification {
  return {
    method: 'turn/completed',
    params: {
      threadId: where.threadId,
      turn: {
        id: turn.id,
        items: turn.items ?? [],
        itemsView: 'full',
        status: turn.status ?? 'completed',
        error: turn.error ?? null,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
      },
    },
  };
}

/** `thread/tokenUsage/updated`：`{ threadId, turnId, tokenUsage }` */
export function tokenUsageUpdated(
  usage: { inputTokens: number; cachedInputTokens?: number; outputTokens: number; reasoningOutputTokens?: number; totalTokens?: number },
  where: { threadId: string; turnId?: string },
): FakeNotification {
  const breakdown = {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteInputTokens: 0,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
    totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
  return {
    method: 'thread/tokenUsage/updated',
    params: { threadId: where.threadId, turnId: where.turnId ?? 'turn-1', tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null } },
  };
}

/** `error`：`{ error: { message }, willRetry, threadId, turnId }` */
export function errorNotification(message: string, where: { threadId?: string; turnId?: string } = {}): FakeNotification {
  return {
    method: 'error',
    params: { error: { message, codexErrorInfo: null, additionalDetails: null, misalignment: null }, willRetry: false, threadId: where.threadId ?? null, turnId: where.turnId ?? null },
  };
}

/** `turn/plan/updated`：`{ threadId, turnId, plan }` */
export function turnPlanUpdated(
  steps: ReadonlyArray<{ step: string; status: string }>,
  where: { threadId: string; turnId: string },
): FakeNotification {
  return { method: 'turn/plan/updated', params: { ...where, explanation: null, plan: steps } };
}

/**
 * `thread/list` 的一页应答（`{ data, nextCursor }`）。
 * 为什么要有 `pageSize` 版：分页拼接是 `reader.ts` 的行为，夹具必须能把「一页装不下」这个形状造出来。
 */
export function threadListPages(
  threads: ReadonlyArray<Record<string, unknown> & { id: string }>,
  pageSize: number,
): (params: Record<string, unknown>) => unknown {
  return (params) => {
    const cursor = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
    const data = threads.slice(cursor, cursor + pageSize);
    const next = cursor + pageSize < threads.length ? String(cursor + pageSize) : null;
    return { data, nextCursor: next, backwardsCursor: null };
  };
}

/** `thread/read` 的应答（`{ thread }`）；`itemsView` 决定 `reader` 走不走 `thread/items/list` */
export function threadRead(
  thread: Record<string, unknown> & { id: string },
): (params: Record<string, unknown>) => unknown {
  return (params) => (params.threadId === thread.id ? { thread } : { thread: null });
}

/** `thread/items/list` 的一页应答（`{ data, nextCursor }`） */
export function threadItemsPages(
  entries: ReadonlyArray<{ turnId: string; item: Record<string, unknown> }>,
  pageSize: number,
): (params: Record<string, unknown>) => unknown {
  return (params) => {
    const cursor = typeof params.cursor === 'string' ? Number(params.cursor) : 0;
    const data = entries.slice(cursor, cursor + pageSize);
    const next = cursor + pageSize < entries.length ? String(cursor + pageSize) : null;
    return { data, nextCursor: next };
  };
}

/** 等待一个条件成立（微任务级轮询：夹具的通知是推的，不需要真定时器） */
export async function waitFor(predicate: () => boolean, steps = 200): Promise<void> {
  for (let index = 0; index < steps; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('等待条件超时：夹具的通知没有到达（用例可能真的挂住了）');
}
