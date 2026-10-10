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
import { asRecord, readString } from '../../../json';
import {
  createAppServerClient,
  type AppServerClient,
  type AppServerEnv,
  type AppServerSpawn,
} from './client';
import { readNotification, type AppServerNotificationPayload } from './protocol';

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
