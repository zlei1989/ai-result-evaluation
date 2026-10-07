/**
 * codex `app-server` 的 JSON-RPC 客户端（stdio、行分隔 JSON 帧）。
 *
 * 为什么要自己写一个：TS 侧**没有官方 app-server 客户端**（`@openai/codex-sdk` 走的是
 * `exec --experimental-json`，那是另一条通道）。本文件只做四件事——spawn、握手、请求/响应配对、
 * 收通知——**不做**业务映射（那是 `threads.ts` 的事）。
 *
 * 三条硬口径：
 *  1. **绝不悬挂**：进程退出、spawn 失败、超时、`close()` 四种收场都要让待收请求**明确 reject**
 *     （`turn.ts` 的语义是「跑不完就要有结论」，悬挂会把一行拖到整轮超时）。
 *  2. **服务端主动请求不应答**：审批类入站请求（`item/…/requestApproval`，带 `id`）单独归类、**不回帧**。
 *     本仓评测是非交互的（`approvalPolicy: never`），应答等于替用户批准；不归类则会污染响应配对。
 *  3. **坏帧计数不静默**：解析不了的整行进 `unparsedFrames()`，与 `transcript.ts` 的 `stats.badLines`
 *     同一理由——静默跳过会让「上游换了帧格式」表现成「子智能体突然没了子线程」。
 */
import { spawn } from 'node:child_process';

/** 帧里能收到的三类入站报文（形状自己声明，不引厂商类型） */
export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

/**
 * 子进程的窄结构：只声明本模块用到的成员，测试可以拿一个纯对象顶替（不 spawn 真进程）。
 * 真实 `ChildProcess` 结构上满足它（`stdin` 在 `pipe` 下非空）。
 */
export interface AppServerChild {
  readonly stdin: { write(chunk: string): unknown };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

/**
 * 子进程环境（键 → 值）。
 *
 * **刻意不用全局的 `NodeJS.ProcessEnv`**（2026-10-07）：那是个**全局接口**，谁都能往它上面加
 * **必填**成员，而本仓的类型检查是「8 个包共用一个 tsc 程序」（`tsconfig.typecheck.json`）
 * ⇒ 只要 web-next 的 `next-env.d.ts` 存在（**跑过一次 `next dev` 就有**，且它已被 gitignore），
 * Next 16 的 `next/types/global.d.ts` 就会补上：
 * ```ts
 * interface ProcessEnv { readonly NODE_ENV: 'development' | 'production' | 'test' }
 * ```
 * 于是本包（一个谁都不认识的库）里每个 `{}` 形状的 env 都被要求写 `NODE_ENV`——实测
 * `client.test.ts` 三处 TS2741；而**干净检出**下同一个 `{}` 合法。同一份代码两处结论不同、
 * 门禁取决于「这台机器跑没跑过 dev」，这不是判据。
 *
 * 值域按 `spawn` 的口径（`Dict<string>`）：`undefined` 表示「这一格没有值」。
 * 同口径的先例见 `providers/dsh/sdk.ts` 的 `env: Record<string, string>`。
 */
export type AppServerEnv = Readonly<Record<string, string | undefined>>;

export type AppServerSpawn = (binary: string, args: readonly string[], env: AppServerEnv) => AppServerChild;

export interface AppServerClient {
  /** 握手：声明 `experimentalApi`（`thread/list{parentThreadId}` 等实验字段的前提）；重复调用复用同一个 promise */
  initialize(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** 已收到的通知（调用方自己按需过滤；本客户端不做队列消费语义） */
  notifications(): readonly AppServerNotification[];
  /** 服务端主动请求（审批等）：**只归类、不应答**，见文件头第 2 条 */
  serverRequests(): readonly AppServerServerRequest[];
  /** 解析不了的整行数（见文件头第 3 条） */
  unparsedFrames(): number;
  close(): void;
}

export interface AppServerClientOptions {
  /** codex 可执行文件的绝对路径（由 `binary.ts` 解析） */
  binary: string;
  /** 子进程环境（调用方负责展开宿主环境，如本行 `.agenthome` ⇒ `CODEX_HOME`） */
  env: AppServerEnv;
  /** 测试注入口；缺省 = 真 `spawn` */
  spawnFn?: AppServerSpawn;
  /** 单条请求的超时（毫秒）。默认 30s：`thread/read` 在大会话上要扫盘，给足余量 */
  timeoutMs?: number;
}

/** 握手时上报的客户端名（会出现在 `initialize` 的 `userAgent` 里，便于上游排查） */
const CLIENT_INFO = { name: 'aieval-codex-reader', title: 'aieval codex reader', version: '0.0.1' } as const;

/** stderr 只留尾部这么多字符：报错时够定位，又不至于把整段日志搬进错误消息 */
const STDERR_TAIL_LIMIT = 2_000;

const defaultSpawn: AppServerSpawn = (binary, args, env) => {
  // `env` 是仓内自己的键值对视图，而 `spawn` 要的是**全局**的 `NodeJS.ProcessEnv`
  // （下游应用可以给它补必填成员，见 `AppServerEnv`）⇒ 只能在这里断言一次。
  // 逐键拷贝再断言：语义不变（两边都是「键 → 字符串或 undefined」），只是把全局那个类型放回它该在的边界上。
  const child = spawn(binary, [...args], { env: { ...env } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  // 真实 ChildProcess 与本窄结构同形（pipe 下 stdin 非空）；这层断言只为绕开 `stdin: Writable | null`
  return child as unknown as AppServerChild;
};

export function createAppServerClient(options: AppServerClientOptions): AppServerClient {
  const { binary, env, spawnFn = defaultSpawn, timeoutMs = 30_000 } = options;

  /** 待收请求表：id ⇒ 结算入口与超时定时器 */
  const pending = new Map<
    number,
    { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const notificationList: AppServerNotification[] = [];
  const serverRequestList: AppServerServerRequest[] = [];
  let nextId = 1;
  let buffer = '';
  let stderrTail = '';
  let unparsed = 0;
  /** 终态原因（进程退出 / 启动失败 / 已关闭）：非 null 后一切新请求立即拒绝 */
  let terminal: string | null = null;
  let closed = false;
  let initPromise: Promise<void> | null = null;

  const child = spawnFn(binary, ['app-server'], env);

  /** 把所有待收请求按同一个原因 reject（进程退出、启动失败、关闭三条路共用） */
  const rejectAll = (reason: string): void => {
    terminal ??= reason;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${terminal}；未完成的请求：${entry.method}`));
      pending.delete(id);
    }
  };

  const settle = (id: number, message: Record<string, unknown>): void => {
    const entry = pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    const error = message.error as { code?: number; message?: string } | undefined;
    if (error !== undefined) {
      entry.reject(new Error(`app-server 返回错误（${error.code ?? '?'}）：${error.message ?? '未知'}`));
      return;
    }
    entry.resolve(message.result);
  };

  const handleLine = (line: string): void => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      unparsed += 1;
      return;
    }
    const id = message.id;
    if (typeof id === 'number' && pending.has(id)) {
      settle(id, message);
      return;
    }
    // 带 id 但不在待收表里 = 服务端主动请求（审批等）：归类，**应答不在本模块职责内**
    if (id !== undefined && (typeof id === 'number' || typeof id === 'string')) {
      serverRequestList.push({ id, method: String(message.method ?? ''), params: message.params });
      return;
    }
    if (typeof message.method === 'string') {
      notificationList.push({ method: message.method, params: message.params });
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) handleLine(line);
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
  });
  child.on('exit', (code) => {
    const tail = stderrTail.trim();
    rejectAll(`codex app-server 进程已退出（code=${String(code)}）${tail.length > 0 ? ` stderr: ${tail}` : ''}`);
  });
  child.on('error', (error) => {
    rejectAll(`codex app-server 启动失败：${error.message}`);
  });

  const request = <T,>(method: string, params?: unknown): Promise<T> => {
    if (closed) return Promise.reject(new Error('codex app-server 客户端已关闭'));
    if (terminal !== null) return Promise.reject(new Error(terminal));
    return new Promise<T>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`codex app-server 请求超时：${method}（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
    });
  };

  return {
    initialize: () => {
      initPromise ??= request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true, requestAttestation: false },
      }).then(() => undefined);
      return initPromise;
    },
    request,
    notifications: () => notificationList,
    serverRequests: () => serverRequestList,
    unparsedFrames: () => unparsed,
    close: () => {
      closed = true;
      rejectAll('codex app-server 客户端已关闭');
      try {
        child.kill();
      } catch {
        // 已经死了：kill 抛错不影响「关闭」这个结论
      }
    },
  };
}
