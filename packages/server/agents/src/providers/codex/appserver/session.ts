/**
 * 一次 codex 运行的会话：握手 → 建线程 → 起轮次 → 通知流 → 收敛。
 *
 * 分工：`client.ts` 只管帧与配对；本模块管**生命周期语义**（帧序、本轮终结的判定边界、中断、关闭），
 * 并把通知归一化成 `AppServerNotificationPayload`。
 *
 * 三条口径：
 * 1. **终结只认本轮**：子线程自己的 `turn/completed` 不结算本次运行（它是子智能体的一轮），
 *    但仍照原样产出——子任务轨迹要靠它。
 * 2. **绝不悬挂**：进程退出/启动失败/关闭都要让 `outcome` 以 `failed` 结算，流随之结束。
 * 3. **不做归属推断**：线程 id 取自 `thread/start` 的响应；拿不到就报错，不带着空 id 继续。
 *
 * 第四条：**起手三步失败要把已经 spawn 的进程收掉**——`close()` 是 `dispose` 之外
 * 唯一的回收出口，而 `dispose` 只在会话句柄成功返回之后才存在（见 `startCodexSession` 的 catch）。
 */
import { createLogger } from '@aieval/core';
import { asRecord, readNumber, readString } from '../../../json';
import {
  createAppServerClient,
  type AppServerClient,
  type AppServerEnv,
  type AppServerNotification,
  type AppServerServerRequest,
  type AppServerSpawn,
} from './client';
import { readNotification, type AppServerNotificationPayload } from './protocol';

const logger = createLogger('agents/codex/session');

/**
 * 等注入的 MCP 落定的预算。**写成可变对象**（口径同仓库的 `TEXT_API_RETRY` / `ROW_RETRY`）：
 * 用例要把它调小才跑得动，`beforeEach` 读产品默认值、`afterEach` 还原，默认值另有一条用例钉住。
 *
 *  - `fallbackSec`：条目**没申报** `startup_timeout_sec` 时的启动预算（秒）；
 *  - `graceMs`：收尾余量——`startup_timeout_sec` 是 codex 自己的启动预算，它到点才投 `failed`，
 *    不加余量就会在结论投出前的一刹那收手，日志里的读数从「失败」退化成「超时」。
 */
export const CODEX_MCP_STARTUP_WAIT = {
  fallbackSec: 30,
  graceMs: 5_000,
};

export interface CodexSessionInput {
  /** codex 可执行文件（`binary.ts` 解析） */
  binary: string;
  /** 子进程环境（含本行 `CODEX_HOME`） */
  env: AppServerEnv;
  cwd: string;
  model: string;
  /** 思考强度：原样透传，值域由厂商声明 */
  effort?: string;
  sandbox: string;
  approvalPolicy: string;
  /** 线程级配置覆盖（网关路由、特性开关）；键名与 CLI 的 config 同义 */
  config?: Record<string, unknown>;
  /** 提交给模型的任务原文 */
  prompt: string;
  /** 结构化输出 schema；缺省则不带该字段 */
  outputSchema?: Record<string, unknown>;
  /**
   * 服务端主动请求的应答者（见 `AppServerClientOptions.onServerRequest`）。
   * **只在自建客户端时生效**：注入了 `client` 的调用方自己承担接线。
   */
  onServerRequest?: ((request: AppServerServerRequest) => Promise<unknown | null>) | undefined;
  /** 测试注入口：给了就不再 spawn */
  client?: AppServerClient;
  spawnFn?: AppServerSpawn;
}

export interface CodexTurnOutcome {
  status: 'completed' | 'failed';
  error: string | null;
  durationMs: number | null;
}

export interface CodexSession {
  threadId: string;
  turnId: string;
  /** 归一化通知流：产到本轮终结（含终结那条）为止 */
  notifications: AsyncIterable<AppServerNotificationPayload>;
  /** 本轮结局；流结束后必定已结算 */
  outcome: Promise<CodexTurnOutcome>;
  /**
   * 通知流**停下来之后**落定（`outcome` 已结算、且排队中的通知已全部产出）。
   * 取数面用它当闸门：轮次一旦有结论，线程树就不再增长，`thread/list` 拿到的才是全量。
   */
  settled: Promise<void>;
  interrupt(): Promise<void>;
  /** 关闭并**回收整棵进程树**（异步：见 `client.ts` 的 `close`） */
  close(): Promise<void>;
}

/** 从 `thread/start` / `turn/start` 的响应里取 id；形状不对就报错（点名字段） */
function requireId(value: unknown, holder: string, field: string, context: string): string {
  const id = readString(asRecord(asRecord(value)?.[holder]), field);
  if (id === null) throw new Error(`${context} 未返回 ${holder}.${field}`);
  return id;
}

/** 线程级 config 里的 `mcp_servers` 表（没有这一格 / 不是对象 ⇒ 空表） */
function mcpServerEntries(config: Record<string, unknown> | undefined): Record<string, unknown> {
  return asRecord(config?.['mcp_servers']) ?? {};
}

/**
 * 等注入的 MCP 落定的上限（毫秒）：**申报了** `startup_timeout_sec` 的按最大的那一台算，
 * 一台都没申报才用 `fallbackSec`。导出是给守卫钉默认值用的（纯函数，不读时钟）。
 */
export function mcpStartupWaitMs(config: Record<string, unknown> | undefined): number {
  const declared = Object.values(mcpServerEntries(config))
    .map((entry) => readNumber(asRecord(entry), 'startup_timeout_sec'))
    .filter((sec): sec is number => sec !== null && sec > 0);
  const budgetSec = declared.length === 0 ? CODEX_MCP_STARTUP_WAIT.fallbackSec : Math.max(...declared);
  return budgetSec * 1000 + CODEX_MCP_STARTUP_WAIT.graceMs;
}

/**
 * 起轮次之前，等注入的每一台 MCP **落定**（`ready` / `failed`）。
 *
 * 为什么非等不可：MCP 工具要 server 到 `ready` 之后才进 codex 的工具表，而工具表是**随每条模型
 * 请求重算**的——`turn/start` 一发出去，紧接着那条请求就已经带着当时的表走了。而
 * `thread/start` 与 `turn/start` 之间只隔毫秒，playwright MCP 走 `npx` 首次要 ~5–6 s（公网 registry
 * 下 17 s）⇒ 不等的话开局 1–2 轮的请求里根本没有 `mcp__<name>`，模型据此断言「当前会话没有暴露
 * MCP 工具」并整轮退化成 shell（真机读数：`starting` 后 6 s 才 `ready`，而首轮请求早 5 s 就发出去了）。
 * 探针 A/B（`probe/v10/codex-mcp-tools-capture.mjs`，读数见同目录 `REPORT.md`）：
 * 不等 ⇒ 请求体 `tools` 里没有那一格；等 ⇒ 有。
 *
 * 四条边界：
 *   · **历史先扫一遍**：`client.subscribe` 不补投历史（见 `client.ts` 的口径），而毫秒级启动的
 *     server 完全可能在我们登记之前就到 `ready`；
 *   · **有上限**：谁都不上报时按 `startup_timeout_sec` + 余量收手（`failed` 也算落定，codex 自己
 *     会在超时后投它）；等超了只记 WARN，**不改失败语义**——判据仍只在事件流那一侧；
 *   · **进程终止也放行**：等待窗口里 app-server 死掉时立刻返回，不白等满预算；
 *   · **没有注入就直接返回**（不订阅、不等待）：没注入 MCP 的行不该付这笔时间。
 *
 * 只按**名字**认，不按 `threadId`：这一步在 `turn/start` 之前，子线程还不存在，那条判据在此恒真。
 */
async function settleMcpStartup(client: AppServerClient, config: Record<string, unknown> | undefined): Promise<void> {
  const pending = new Set(Object.keys(mcpServerEntries(config)));
  if (pending.size === 0) return;
  const waitMs = mcpStartupWaitMs(config);
  const failed: string[] = [];
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const consume = (notification: AppServerNotification): void => {
    const payload = readNotification(notification.method, notification.params);
    if (payload.kind !== 'mcpStartupStatus' || !pending.has(payload.name)) return;
    if (payload.status === 'ready') {
      pending.delete(payload.name);
    } else if (payload.status === 'failed') {
      pending.delete(payload.name);
      failed.push(payload.name);
    } else {
      // `starting` 不是终态：它之后还会变，等它没有意义
      return;
    }
    if (pending.size === 0) settle();
  };
  for (const one of client.notifications()) consume(one);
  if (pending.size > 0) {
    const unsubscribe = client.subscribe(consume);
    /**
     * 进程死在启动窗口里也要**立刻放行**：否则这一行会白等到预算上限，而那几十秒里轮次根本没机会起
     * （`turn/start` 会照旧报进程已退出，回收走 `startCodexSession` 的 catch）。
     */
    const unsubscribeTerminal = client.onTerminal(settle);
    const timer = setTimeout(settle, waitMs);
    await done;
    clearTimeout(timer);
    unsubscribe();
    unsubscribeTerminal();
  }
  if (failed.length > 0) {
    // 不在这里抛：这一行的失败判据是事件流那一侧（`AGENT_MCP_UNAVAILABLE` 的文案要厂商原文）
    logger.warn('注入的 MCP 启动失败：本轮工具表里不会有它', { failed });
  }
  if (pending.size > 0) {
    logger.warn('MCP 启动未在预算内落定，先起轮次', { timedOut: [...pending], waitMs });
  }
}

/**
 * **会话骨架：在 `thread/start` 之前就得建好**（下面两条事实合成的一条）。
 *
 * 为什么不能等「握手 → 建线程 → 起轮次」三步都完成再建（本模块原来的写法）：
 *   1. **订阅必须早于 `thread/start`**：MCP server 随线程启动，它的
 *      `mcpServer/startupStatus/updated` 就落在 `thread/start` 响应与 `turn/start` 响应之间那段窗口里
 *      ——`thread/start` +119 ms 返回，`starting` 与 `failed` 两条在 +135 ms 前**全部到齐**。
 *      真实的 `appserver/client.ts` 把通知追加进历史列表，但**没有订阅者时不投递给任何人**（丢）
 *      ⇒ 订阅晚一步，那两条一条都收不到，症状是「MCP 明明没起来，行照旧出分」，且**只在失败时**才看得见
 *      （`ready` 往往晚到一步，于是成功路径看起来一切正常）。
 *   2. **终结结算必须早于 `turn/start`**：`turn/completed` 可能在 `turn/start` 的响应回来之前就被投递
 *      （快速失败的一轮、以及夹具那种「提交即产通知」的形状都是这样）⇒ 结算器晚一步登记，
 *      `outcome` 就**永不落定**，这一行会一直挂着（40 s 级别的用例超时就是它的警报）。
 *
 * 主线程 id 到手之前 `mainThreadId` 是 `null`：填之前不可能有 `turn/completed`（轮次还没起来），
 * 故那条判据在 `null` 期间恒不成立。
 */
interface SessionCore {
  queue: AppServerNotificationPayload[];
  /** 迭代器登记的唤醒器（一条通知到达时被消费一次） */
  wake: (() => void) | null;
  /** 主线程 id（`thread/start` 返回之后填）：终结判据要它 */
  mainThreadId: string | null;
  /** 本轮是否已结算（迭代器据此决定要不要继续等） */
  ended: () => boolean;
  /** 结算本轮（幂等）：终结通知、进程终止都走这里 */
  end: (outcome: CodexTurnOutcome) => void;
  /** 本轮结局；**流结束后必定已结算** */
  outcome: Promise<CodexTurnOutcome>;
  /** 通知流停下来的信号（迭代走到 `return` 之前落定一次） */
  settled: Promise<void>;
  /** 迭代器停下来的信号（正常产完 / 消费者提前 return） */
  markStreamStopped: () => void;
}

function createSessionCore(client: AppServerClient): SessionCore {
  let ended = false;
  let settleOutcome: (outcome: CodexTurnOutcome) => void = () => undefined;
  const outcome = new Promise<CodexTurnOutcome>((resolve) => {
    settleOutcome = resolve;
  });
  let settleStream: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settleStream = resolve;
  });

  const core: SessionCore = {
    queue: [],
    wake: null,
    mainThreadId: null,
    ended: () => ended,
    end: (result) => {
      if (ended) return;
      ended = true;
      settleOutcome(result);
      const resume = core.wake;
      core.wake = null;
      resume?.();
    },
    outcome,
    settled,
    markStreamStopped: () => settleStream(),
  };

  client.subscribe((raw) => {
    const payload = readNotification(raw.method, raw.params);
    core.queue.push(payload);
    if (payload.kind === 'turnCompleted' && payload.threadId === core.mainThreadId) {
      core.end({
        status: payload.turn.status === 'failed' ? 'failed' : 'completed',
        error: payload.turn.error,
        durationMs: payload.turn.durationMs,
      });
    }
    const resume = core.wake;
    core.wake = null;
    resume?.();
  });
  client.onTerminal((reason) => {
    core.end({ status: 'failed', error: reason, durationMs: null });
  });
  return core;
}

export async function startCodexSession(input: CodexSessionInput): Promise<CodexSession> {
  const client =
    input.client ??
    createAppServerClient({
      binary: input.binary,
      env: input.env,
      ...(input.onServerRequest === undefined ? {} : { onServerRequest: input.onServerRequest }),
      ...(input.spawnFn === undefined ? {} : { spawnFn: input.spawnFn }),
    });

  /**
   * 起手三步（握手 / 建线程 / 起轮次）任一失败，**必须把已经 spawn 出来的进程树收掉**。
   *
   * 为什么这条不能省：`runTurn` 拿到的 `TurnStart` 才是 `dispose` 的载体（A7：「守卫绑定被关闭的
   * 对象」），而这三步抛错时 `runTurn` 里 `started` 仍是 undefined ⇒ `dispose` 永远不会被调用，
   * 进程就此常驻（实测：`thread/start` 超时 30s 后的 codex 进程会一直持着该行的 `$CODEX_HOME`，
   * 下一轮的行产物清理直接 `EPERM`）。收不掉也不改变失败结论：`close()` 自己吞掉回收异常。
   */
  try {
    await client.initialize();
    // 骨架先立：订阅与终结结算都要早于下面的两个请求（见 `SessionCore` 的 JSDoc）
    const core = createSessionCore(client);

    const threadResult = await client.request<unknown>('thread/start', {
      model: input.model,
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
      ...(input.config === undefined ? {} : { config: input.config }),
    });
    const threadId = requireId(threadResult, 'thread', 'id', 'thread/start');
    core.mainThreadId = threadId;

    /**
     * 注入的 MCP 落定之后才起轮次：工具表随每条模型请求重算，而 MCP 工具要 server `ready`
     * 之后才进表 ⇒ 起早了会让开局那几轮的请求里没有它（机制与判据见 `settleMcpStartup`）。
     */
    await settleMcpStartup(client, input.config);

    const turnResult = await client.request<unknown>('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    });
    const turnId = requireId(turnResult, 'turn', 'id', 'turn/start');
    return buildSession(client, core, threadId, turnId);
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * 起手三步成功之后才建会话句柄：把「起手失败要回收」与「会话怎么跑」分成两段读起来才清楚。
 * 骨架（队列 / 订阅 / 结算）已经由 `createSessionCore` 建好，这里只把**迭代器**与四个出口拼起来。
 */
function buildSession(
  client: AppServerClient,
  core: SessionCore,
  threadId: string,
  turnId: string,
): CodexSession {
  async function* iterate(): AsyncGenerator<AppServerNotificationPayload> {
    try {
      let index = 0;
      while (true) {
        // 先排空再判结束：结算与投递是两件事，已经入队的必须交出去
        while (index < core.queue.length) {
          const payload = core.queue[index];
          index += 1;
          if (payload !== undefined) yield payload;
        }
        if (core.ended()) return;
        await new Promise<void>((resolve) => {
          core.wake = resolve;
        });
      }
    } finally {
      // 消费者停止迭代（正常产完 / 提前 return）也算「流停下来了」
      core.markStreamStopped();
    }
  }

  return {
    threadId,
    turnId,
    notifications: iterate(),
    outcome: core.outcome,
    settled: core.settled,
    interrupt: async () => {
      await client.request('turn/interrupt', { threadId, turnId });
    },
    close: () => client.close(),
  };
}
