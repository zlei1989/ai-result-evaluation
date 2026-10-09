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
 * 第四条（2026-10-07）：**起手三步失败要把已经 spawn 的进程收掉**——`close()` 是 `dispose` 之外
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

    const threadResult = await client.request<unknown>('thread/start', {
      model: input.model,
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy,
      ...(input.config === undefined ? {} : { config: input.config }),
    });
    const threadId = requireId(threadResult, 'thread', 'id', 'thread/start');

    const turnResult = await client.request<unknown>('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    });
    const turnId = requireId(turnResult, 'turn', 'id', 'turn/start');
    return await buildSession(client, threadId, turnId);
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** 起手三步成功之后才建会话句柄：把「起手失败要回收」与「会话怎么跑」分成两段读起来才清楚 */
async function buildSession(
  client: AppServerClient,
  threadId: string,
  turnId: string,
): Promise<CodexSession> {
  const queue: AppServerNotificationPayload[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let settleOutcome: (outcome: CodexTurnOutcome) => void = () => undefined;
  const outcome = new Promise<CodexTurnOutcome>((resolve) => {
    settleOutcome = resolve;
  });
  /** 流结束的信号（见 `CodexSession.settled`）：迭代走到 `return` 之前落定一次 */
  let settleStream: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settleStream = resolve;
  });

  const end = (settled: CodexTurnOutcome): void => {
    if (ended) return;
    ended = true;
    settleOutcome(settled);
    const resume = wake;
    wake = null;
    resume?.();
  };

  client.subscribe((raw) => {
    const payload = readNotification(raw.method, raw.params);
    queue.push(payload);
    if (payload.kind === 'turnCompleted' && payload.threadId === threadId) {
      end({
        status: payload.turn.status === 'failed' ? 'failed' : 'completed',
        error: payload.turn.error,
        durationMs: payload.turn.durationMs,
      });
    }
    const resume = wake;
    wake = null;
    resume?.();
  });
  client.onTerminal((reason) => {
    end({ status: 'failed', error: reason, durationMs: null });
  });

  async function* iterate(): AsyncGenerator<AppServerNotificationPayload> {
    try {
      let index = 0;
      while (true) {
        while (index < queue.length) {
          const payload = queue[index];
          index += 1;
          if (payload !== undefined) yield payload;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      // 消费者停止迭代（正常产完 / 提前 return）也算「流停下来了」
      settleStream();
    }
  }

  return {
    threadId,
    turnId,
    notifications: iterate(),
    outcome,
    settled,
    interrupt: async () => {
      await client.request('turn/interrupt', { threadId, turnId });
    },
    close: () => client.close(),
  };
}
