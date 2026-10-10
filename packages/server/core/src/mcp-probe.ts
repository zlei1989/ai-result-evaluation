/**
 * MCP stdio 探活原语：起一条子进程 → 走三步握手 → 拿回 serverInfo 与工具清单 → 收干净退出。
 *
 * 落点为什么在 core：core 的职责是「零依赖基础能力」，且**已经是唯一持有非智能体子进程原语的地方**
 * （`git-exec.ts` 的 `execFileSync`）。行协议收帧是纯机制，策略（谁算失败、说什么话）在 `api/src/mcp.ts`。
 *
 * ⚠️ **探活不是跑智能体**，不受 AGENTS.md「调智能体只有 `agentProvider.run` 一个入口」那条铁律约束
 * 三条理由：它的对象是一个 MCP 端点、与 claude / codex / dsh 无关；
 * 它必须在**零 provider、零仓库**的干净状态下可用；它也不是「再包一层跑一次」的门面——
 * 它是**另一类东西**：MCP 协议客户端。
 *
 * 三个必须在真进程上才验得出来的点（`mcp-probe.test.ts` 逐条钉住）：
 *   1. `exit` 与 `error` 两个监听都要在 **spawn 当刻**挂上：晚挂会漏掉「握手前就退出」，症状是空等到超时，
 *      把「早退」误报成「超时」；只挂 `exit` 不挂 `error` 时，命令不存在（ENOENT）会以未处理事件崩掉调用方。
 *   2. 行协议收帧按 `\n` 切、**JSON 解析失败的行直接跳过**：服务端往 stdout 夹一行日志是常态。
 *   3. 收尾三级（`stdin.end()` → `SIGTERM` → `SIGKILL`）**必须被同一个超时罩住**：先关 stdin 是 stdio
 *      server 的标准退出信号（实测 6 ms 自行退出），不退再升级；收尾预算从总预算里预扣，
 *      否则「超时」这条路上函数会永不返回（界面转圈到用户刷新）。
 */
import { spawn } from 'node:child_process';

/** 客户端报的协议版本：服务端可以不采纳（照抄或改成自己的，两者都合法） */
const CLIENT_PROTOCOL_VERSION = '2025-06-18';

/** 收尾预算：stdin-eof 2 s → SIGTERM 2 s → SIGKILL 1 s。从总超时里**预扣**（见文件头第 3 点） */
const DEFAULT_TEARDOWN_BUDGET_MS = 5_000;

/**
 * 实际预扣的收尾预算：默认 5 s，但**不超过总预算的一半**。
 * 为什么要有这个上限：预算小到与收尾预算相等时（测试里常见的 5 s），预扣会把握手阶段的截止线
 * 压到「现在」，于是任何一次探活都直接报超时——连命令不存在（ENOENT）这种**当场就有结论**的失败
 * 也被误报成超时（真机上症状是「明明没装 npx 却说超时」，用户照着超时去查网络）。
 */
function teardownBudgetFor(timeoutMs: number, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  return Math.min(DEFAULT_TEARDOWN_BUDGET_MS, Math.max(Math.floor(timeoutMs / 2), 50));
}

/** stderr 摘要上限：npx 的下载进度与 npm 警告很长，全带回去只会淹没真正的那一句 */
const STDERR_LIMIT = 2_000;

export interface McpStdioProbeInput {
  command: string;
  args?: string[] | undefined;
  /** 条目里配的环境变量：**追加**到 process.env 上（与 `git-exec.ts` 的 execute 同口径） */
  env?: Record<string, string> | undefined;
  /** 总预算（毫秒），罩住握手**与**收尾 */
  timeoutMs: number;
  /** 收尾预算；测试用它把 5 s 压小，产品路径不传 */
  teardownBudgetMs?: number | undefined;
  cwd?: string | undefined;
}

export interface McpStdioProbeOutcome {
  serverName?: string | undefined;
  serverVersion?: string | undefined;
  protocolVersion?: string | undefined;
  /** `tools/list` 声明的工具数 */
  toolCount: number;
  elapsedMs: number;
  /** 子进程 stderr 摘要（失败时是「依赖拉取失败」那类归因的原始素材） */
  stderr: string;
  /** 收尾走了哪一级；`stdin-eof` 说明服务端自己干净退出了 */
  teardown: 'stdin-eof' | 'SIGTERM' | 'SIGKILL';
}

/** 失败种类：这是**机制层**的划分，翻译成中文结论与档位是 api 层的事 */
export type McpStdioProbeErrorKind = 'spawn' | 'exited' | 'timeout' | 'protocol';

/** 探活失败：带上机制层拿到的原始信号（退出码 / ENOENT / stderr 摘要 / pid），供上层分档 */
export class McpStdioProbeError extends Error {
  readonly kind: McpStdioProbeErrorKind;
  /** 退出码或 errno 字符串（ENOENT）；超时与协议失败时为 null */
  readonly code: string | number | null;
  readonly stderr: string;
  /** 子进程 pid（超时那条路上要给测试与日志留证：到点之后它已经被收掉） */
  readonly pid: number | undefined;

  constructor(
    kind: McpStdioProbeErrorKind,
    message: string,
    options: { code?: string | number | null; stderr?: string; pid?: number | undefined } = {},
  ) {
    super(message);
    this.name = 'McpStdioProbeError';
    this.kind = kind;
    this.code = options.code ?? null;
    this.stderr = options.stderr ?? '';
    this.pid = options.pid;
  }
}

/** 一行一条 JSON-RPC 消息：换行分隔，消息体内不得有裸换行（MCP 的 stdio 传输就是这么定的） */
interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * 起进程、发三步握手、收尾，返回 serverInfo 与工具数。
 * 失败一律抛 `McpStdioProbeError`（**不**在这里折成中文：分档与文案是 api 层的事）。
 */
export async function probeMcpStdio(input: McpStdioProbeInput): Promise<McpStdioProbeOutcome> {
  const started = Date.now();
  const teardownBudget = teardownBudgetFor(input.timeoutMs, input.teardownBudgetMs);
  // 握手阶段的截止线 = 总预算 - 收尾预算。收尾自己也有上限（2+2+1 s），两者相加不超过总预算。
  const handshakeDeadline = started + Math.max(input.timeoutMs - teardownBudget, 0);

  const child = spawn(input.command, input.args ?? [], {
    cwd: input.cwd,
    // 不走 shell：`command` / `args` 是用户填的，走 shell 会引入注入面（同 git-exec 的口径）
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: input.env === undefined ? process.env : { ...process.env, ...input.env },
  });

  // 监听必须在 spawn 当刻挂上（文件头第 1 点）：`exit` 与 `error` 都要，且都要 once
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnError: Error | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve();
    });
    child.once('error', (error) => {
      spawnError = error;
      resolve();
    });
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk;
  });

  /** 按 id 收响应：通知没有 id，不入表 */
  const waiters = new Map<number, (message: JsonRpcMessage) => void>();
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line.trim()) as JsonRpcMessage;
      } catch {
        // 服务端往 stdout 夹日志行是常态：跳过它，不要让一行噪音毁掉整次探活
        continue;
      }
      const waiter = typeof message.id === 'number' ? waiters.get(message.id) : undefined;
      if (waiter !== undefined) {
        waiters.delete(message.id as number);
        waiter(message);
      }
    }
  });

  /**
   * 已经能确定的早退原因（命令不存在 / 握手前退出）；还没确定时返回 null。
   * 抽成函数是为了让「先判早退、再判超时」这条顺序在每一处等待里都一样：顺序反了，
   * ENOENT 这种**当场就有结论**的失败会被报成超时（用户拿着「超时」去查网络，方向全错）。
   */
  const earlyExitError = (): McpStdioProbeError | null => {
    if (spawnError === null && exited === null) return null;
    return describeEarlyExit(spawnError, exited, stderr, child.pid);
  };

  /** 超时错误：带上 pid，收尾之后那条「进程真被收掉了吗」的断言才有判据（少了它只能对着 undefined 判） */
  const timeoutError = (): McpStdioProbeError =>
    new McpStdioProbeError('timeout', `等待 ${input.command} 的响应超时`, { pid: child.pid });

  /** 等一个响应：谁的截止线先到就以谁为准（退出 / 超时都算「没等到」） */
  const awaitResponse = (id: number): Promise<JsonRpcMessage> =>
    new Promise<JsonRpcMessage>((resolve, reject) => {
      const early = earlyExitError();
      if (early !== null) {
        reject(early);
        return;
      }
      const remaining = handshakeDeadline - Date.now();
      if (remaining <= 0) {
        reject(timeoutError());
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(timeoutError());
      }, remaining);
      // 早退也要立刻了结：等满超时会把「握手前退出」误报成「超时」
      void exitPromise.then(() => {
        if (!waiters.has(id)) return;
        waiters.delete(id);
        clearTimeout(timer);
        reject(earlyExitError() ?? new McpStdioProbeError('exited', 'MCP 服务在握手完成前退出'));
      });
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

  const send = (message: Record<string, unknown>): void => {
    try {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      // 管道已关（子进程刚死）：交给 awaitResponse 那条路报错，这里不吞错也不抛
    }
  };

  try {
    // ① initialize
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aieval-mcp-probe', version: '1.0.0' },
      },
    });
    const init = await awaitResponse(1);
    if (init.error !== undefined && init.error !== null) {
      throw new McpStdioProbeError('protocol', 'initialize 返回了 JSON-RPC 错误', {
        stderr: `${JSON.stringify(init.error)}${stderrSuffix(stderr)}`,
        pid: child.pid,
      });
    }
    const initResult = asRecord(init.result);
    if (initResult === null || typeof initResult.protocolVersion !== 'string') {
      throw new McpStdioProbeError('protocol', 'initialize 的响应里没有 result.protocolVersion', {
        stderr: stderrSuffix(stderr).trim(),
        pid: child.pid,
      });
    }

    // ② notifications/initialized：协议上必须发（有的服务端强制），但**不能拿它当判据**
    // （playwright MCP 不发也照过）
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // ③ tools/list
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await awaitResponse(2);
    if (listed.error !== undefined && listed.error !== null) {
      throw new McpStdioProbeError('protocol', 'tools/list 返回了 JSON-RPC 错误', {
        stderr: `${JSON.stringify(listed.error)}${stderrSuffix(stderr)}`,
        pid: child.pid,
      });
    }
    const listResult = asRecord(listed.result);
    const tools = listResult === null ? null : listResult.tools;
    if (!Array.isArray(tools)) {
      throw new McpStdioProbeError('protocol', 'tools/list 的响应里没有 result.tools', {
        stderr: stderrSuffix(stderr).trim(),
        pid: child.pid,
      });
    }

    const serverInfo = asRecord(initResult.serverInfo);
    const teardown = await teardownChild(child, exitPromise, teardownBudget, started);
    return {
      serverName: typeof serverInfo?.name === 'string' ? serverInfo.name : undefined,
      serverVersion: typeof serverInfo?.version === 'string' ? serverInfo.version : undefined,
      protocolVersion: initResult.protocolVersion,
      toolCount: tools.length,
      elapsedMs: Date.now() - started,
      stderr: stderr.trim(),
      teardown,
    };
  } catch (error) {
    // 失败也要收干净：不然一次「命令不存在」会在后台留下半条管道，一次超时会留下一个狂转的 npx
    await teardownChild(child, exitPromise, teardownBudget, started);
    throw error;
  }
}

/**
 * 收尾三级（见文件头第 3 点）：先关 stdin，等 2 s；不退发 SIGTERM，再等 2 s；最后 SIGKILL 等 1 s。
 * 每一级都**同时**等「进程退出」与「本级时限」，时限一过立刻升级——不升级会让一次探活拖满总预算。
 */
async function teardownChild(
  child: ReturnType<typeof spawn>,
  exitPromise: Promise<void>,
  budgetMs: number,
  startedAt: number,
): Promise<'stdin-eof' | 'SIGTERM' | 'SIGKILL'> {
  // 每级各占预算的一段（2 : 2 : 1），预算是 5 s 时与实测口径一致；测试把它压小时按比例分
  const step = (weight: number): number => Math.max(Math.round((budgetMs * weight) / 5), 10);

  if (await settleWith(exitPromise, step(2), () => child.stdin?.end())) return 'stdin-eof';
  if (await settleWith(exitPromise, step(2), () => child.kill('SIGTERM'))) return 'SIGTERM';
  // SIGKILL 之后不再无限等：进程已不可被捕获，等不到就如实报 SIGKILL（残留由调用方记 WARN）
  await settleWith(exitPromise, Math.max(budgetMs - (Date.now() - startedAt), step(1)), () => child.kill('SIGKILL'));
  return 'SIGKILL';
}

/** 执行一次收尾动作并等它或时限先到；进程已退出（或动作已无意义）返回 true */
async function settleWith(exitPromise: Promise<void>, ms: number, act: () => void): Promise<boolean> {
  act();
  return Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/** 把「命令不存在」与「握手前退出」两种早退折成带原始信号的错误 */
function describeEarlyExit(
  spawnError: Error | null,
  exited: { code: number | null; signal: NodeJS.Signals | null } | null,
  stderr: string,
  pid: number | undefined,
): McpStdioProbeError {
  if (spawnError !== null) {
    const code = (spawnError as NodeJS.ErrnoException).code ?? null;
    return new McpStdioProbeError('spawn', spawnError.message, { code, stderr: stderr.trim(), pid });
  }
  const code = exited?.code ?? null;
  const signal = exited?.signal ?? null;
  const how = signal === null ? `exit code ${code ?? '未知'}` : `signal ${signal}`;
  return new McpStdioProbeError('exited', `MCP 服务在握手完成前退出（${how}）`, {
    code,
    stderr: stderr.trim(),
    pid,
  });
}

/** 对象取值：拿不到对象时返回 null（比到处 `as` 稳） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** stderr 摘要的拼接前缀（协议错误要把 JSON-RPC 错误与 stderr 一起带回去） */
function stderrSuffix(stderr: string): string {
  return stderr.trim() === '' ? '' : `\n${stderr.trim()}`;
}
