/**
 * v11 探针专用：`codex app-server` 的 JSON-RPC over stdio 客户端。
 *
 * 与 `v5/lib/client.mjs` 同源（一行一条 JSON、原文回吐、服务端主动请求独立归类、
 * `turn/completed` **不结算**客户端），只多一件事——**能回帧**。
 *
 * 为什么要多这一件事：v5 那份客户端把 `stdin` 封在闭包里，服务端主动请求**只记录不应答**
 * （生产 `appserver/client.ts` 当时的口径）。而本票要问的恰恰是「回一帧之后模型怎么走」
 * ⇒ 必须能写回一帧。复制一份而不是改 v5：那份实现撑着 v5/v6/v10 三批已归档读数，
 * 探针之间不共享可变文件。
 *
 * 三条硬口径（与生产客户端同源）：
 *   · 进程退出 / 启动失败 / 显式 `close()` ⇒ 结算，**绝不悬挂**；
 *   · 服务端主动请求原样进 `serverRequests`，**回不回帧由调用方决定**（审批类一律不回）；
 *   · 解析不了的行留原文（`unparsed`）：静默跳过会把「上游换了帧格式」表现成「请求没来」。
 */
import { spawn } from 'node:child_process';

/** stderr 尾部保留长度：报错时够定位，又不至于把整段日志搬进读数 */
const STDERR_TAIL_LIMIT = 4_000;

/**
 * 拉起一个 app-server 进程并挂上帧处理。
 *
 * @param {object} input
 * @param {string} input.command 可执行文件（缺省是 codex 本体；走 TTY 臂时是 pty 桥）
 * @param {string[]} input.args 命令行参数
 * @param {Record<string,string|undefined>} input.env 子进程环境（含 `CODEX_HOME` 与网关密钥）
 * @param {string} input.cwd 子进程工作目录
 * @param {(line: string) => void} [input.onLine] 每收到一整行 stdout（**原文**）时回调
 * @param {(record: {id: number|string, method: string, params: unknown}) => void} [input.onServerRequest]
 *   服务端主动请求回调（调用方据此决定回不回帧）
 * @param {(method: string, params: unknown) => void} [input.onNotification] 每条通知回调
 * @param {(params: unknown) => void} [input.onTurnCompleted] 任意线程的 `turn/completed`（**不结算**）
 * @param {number} [input.timeoutMs] 单条请求超时，缺省 60s
 */
export function startAppServer(input) {
  const child = spawn(input.command, input.args, {
    env: input.env,
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map(); // id -> { method, resolve, reject, timer }
  const unparsed = [];
  const serverRequests = [];
  let stderrTail = '';
  let buffer = '';
  let nextId = 1;
  let terminal = null;
  let settleDone = () => undefined;
  const done = new Promise((resolve) => {
    settleDone = resolve;
  });
  let settleTurn = () => undefined;
  const turnDone = new Promise((resolve) => {
    settleTurn = resolve;
  });
  let settleExited = () => undefined;
  const exited = new Promise((resolve) => {
    settleExited = resolve;
  });

  /** 结算：进程退出 / 显式 close；只结算一次（`turn/completed` **不**走这里，见文件头） */
  const settle = (reason) => {
    if (terminal !== null) return;
    terminal = reason;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason.reason}；未完成的请求：${entry.method}`));
      pending.delete(id);
    }
    settleDone(reason);
  };

  const handleLine = (line) => {
    input.onLine?.(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      unparsed.push(line.slice(0, 400));
      return;
    }
    const id = message.id;
    if (typeof id === 'number' && pending.has(id)) {
      const entry = pending.get(id);
      clearTimeout(entry.timer);
      pending.delete(id);
      if (message.error !== undefined) {
        entry.reject(new Error(`app-server 错误（${message.error?.code ?? '?'}）：${message.error?.message ?? '未知'}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    /**
     * 带 id 但不在待收表里 = **服务端主动请求**（审批 / 提问）。
     * 本探针在这里只归类；回帧与否由调用方按 method 决定——审批类必须继续不回帧，
     * 这是生产 `appserver/client.ts` 的既有口径，本票不动它。
     */
    if (id !== undefined && (typeof id === 'number' || typeof id === 'string')) {
      const record = { id, method: String(message.method ?? ''), params: message.params ?? null };
      serverRequests.push(record);
      input.onServerRequest?.(record);
      return;
    }
    if (typeof message.method === 'string') {
      input.onNotification?.(message.method, message.params ?? null);
      // `turn/completed` 只作信号：结算留给调用方（收尾还要用同一个进程读回）
      if (message.method === 'turn/completed') {
        settleTurn(message.params ?? null);
        input.onTurnCompleted?.(message.params ?? null);
      }
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim() !== '') handleLine(line);
      index = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
  });
  child.on('exit', (code) => {
    input.onExit?.({ code, stderrTail });
    settleExited({ code, stderrTail });
    settle({ reason: `app-server 进程已退出（code=${code}）`, code, stderrTail });
  });
  child.on('error', (error) => {
    input.onExit?.({ code: null, stderrTail });
    settleExited({ code: null, stderrTail });
    settle({ reason: `app-server 启动失败：${error.message}`, code: null, stderrTail });
  });

  /** 往子进程 stdin 写一整帧（请求与应答共用这一条出口，保证是同一行长 JSON） */
  const write = (frame) => {
    if (terminal !== null) return false;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    return true;
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (terminal !== null) {
        reject(new Error(terminal.reason));
        return;
      }
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`app-server 请求超时：${method}`));
      }, input.timeoutMs ?? 60_000);
      pending.set(id, { method, resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });

  return {
    request,
    /** 回一帧**成功**应答（`id` 原样取自服务端请求） */
    respond: (id, result) => write({ jsonrpc: '2.0', id, result }),
    /** 回一帧**错误**应答（`refuse` 臂用它复刻「客户端说我这里没有交互式终端」那条路） */
    respondError: (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } }),
    /** 本轮 `turn/completed` 的信号（任意线程；调用方自己按 threadId 过滤） */
    turnCompleted: () => turnDone,
    finish: () => {
      settle({ reason: '本轮已收尾（探针主动关闭）', code: null, stderrTail });
      try {
        child.kill();
      } catch {
        /* 已经死了：kill 抛错不影响「关闭」这个结论 */
      }
    },
    close: () => {
      settle({ reason: '探针主动关闭', code: null, stderrTail });
      try {
        child.kill('SIGKILL');
      } catch {
        /* 同上 */
      }
    },
    stats: () => ({
      unparsed: [...unparsed],
      serverRequests: [...serverRequests],
      stderrTail,
      terminal,
    }),
    get done() {
      return done;
    },
    get exited() {
      return exited;
    },
  };
}
