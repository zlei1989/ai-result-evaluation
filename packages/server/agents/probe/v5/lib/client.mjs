/**
 * v5：`codex app-server` 的**探针版** JSON-RPC over stdio 客户端。
 *
 * 与生产代码 `src/providers/codex/appserver/client.ts` 的分工差别只有一条，但很关键：
 * 生产侧把通知**归一化**后交给业务（字段被投影、原始形状丢失），探针要回答的却是
 * 「到底哪个字段带着思考内容」——归一化本身就会把答案抹掉（例如把 `summary`/`content`
 * 读成 `[]` 之后，就分不清「上游没给这个键」与「给了但数组为空」）。
 *
 * 所以本客户端只做两件事：
 *   1. **帧级**：一行一条 JSON，收到即**原文**回吐（`onLine`），不 parse 后再序列化；
 *   2. **配对**：请求 id ↔ 响应；其余带 `method` 的帧一律算通知，交 `onNotification`。
 *
 * 硬约束（沿用生产侧口径）：
 *   · 进程退出 / 启动失败 / 显式 `close()` ⇒ 结算，**绝不悬挂**；
 *   · **`turn/completed` 不结算本客户端**（这点与生产侧刻意不同）：生产侧收到它就结束消费，
 *     而探针**收尾还要读回来**（`thread/read` 看持久化视角的同一件事）——若在这里 reject 掉
 *     全部待收请求，收尾读回必然以「探针主动关闭」失败（v5 第一版就是这么错的）。
 *     ⇒ 改为回调 `onTurnCompleted`，由调用方决定何时继续、何时关；
 *   · 超时到点也要把**已经收到的部分**交出去（超时 ≠ 没有证据）；
 *   · stderr 只留尾部，报错时够定位。
 */
import { spawn } from 'node:child_process';

/** stderr 尾部保留长度（报错时够定位，又不至于把整段日志搬进错误消息） */
const STDERR_TAIL_LIMIT = 4_000;

/**
 * 拉起一个 app-server 进程并挂上帧处理。
 *
 * @param {object} input
 * @param {string} input.binary codex 可执行文件绝对路径
 * @param {Record<string,string>} input.env 子进程环境（含 `CODEX_HOME` 与 `OPENAI_API_KEY`）
 * @param {string} input.cwd 子进程工作目录（与 `$CODEX_HOME` 一样必须落在工作区内）
 * @param {(line: string) => void} [input.onLine] 每收到一整行 stdout（**原文**）时回调
 * @param {(method: string, params: unknown) => void} [input.onNotification] 通知回调
 * @param {(params: unknown) => void} [input.onTurnCompleted] 本轮 `turn/completed` 回调（**不结算**，见文件头）
 * @param {(info: { code: number|null, stderrTail: string }) => void} [input.onExit] 进程退出回调（留退出码用）
 * @param {(record: { method: string, params: unknown }) => void} [input.onServerRequest] 服务端主动请求（审批等）
 * @returns {{ request: Function, close: Function, stats: Function, done: Promise<object> }}
 */
export function startAppServer(input) {
  const child = spawn(input.binary, ['app-server'], {
    env: input.env,
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map(); // id -> { method, resolve, reject, timer }
  const unparsed = []; // 解析不了的行（**留存原文**，静默跳过会让「上游换帧格式」变成「突然没通知」）
  const serverRequests = [];
  let stderrTail = '';
  let buffer = '';
  let nextId = 1;
  let terminal = null;
  let settleDone;
  const done = new Promise((resolve) => {
    settleDone = resolve;
  });
  /** 本轮终结的信号（`turn/completed`）：与 `done`（进程退出）分开，见文件头 */
  let settleTurn = () => undefined;
  const turnDone = new Promise((resolve) => {
    settleTurn = resolve;
  });
  /** 进程**真的退出**的信号（`done` 会在 `finish()` 时提前落定 ⇒ 拿退出码得靠这一格） */
  let settleExited = () => undefined;
  const exited = new Promise((resolve) => {
    settleExited = resolve;
  });

  /** 结算：进程退出 / 收到本轮 `turn/completed` / 显式 close；只结算一次 */
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
    // 带 id 但不在待收表：服务端主动请求（审批 / 问用户）。探针**只记录不应答**（本仓评测是非交互的）
    if (id !== undefined && (typeof id === 'number' || typeof id === 'string')) {
      serverRequests.push({ id, method: String(message.method ?? ''), params: message.params ?? null });
      input.onServerRequest?.(serverRequests.at(-1));
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
    // 进程先退、缓冲区里还剩半行：不当成证据（半行 JSON 解析不了，只会污染 unparsed）
    input.onExit?.({ code, stderrTail });
    settleExited({ code, stderrTail });
    settle({ reason: `app-server 进程已退出（code=${code}）`, code, stderrTail });
  });
  child.on('error', (error) => {
    input.onExit?.({ code: null, stderrTail });
    settleExited({ code: null, stderrTail });
    settle({ reason: `app-server 启动失败：${error.message}`, code: null, stderrTail });
  });

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
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
    });

  return {
    request,
    /** 显式结算（收尾读回做完之后由调用方触发）：把待收请求按同一个原因 reject */
    settle,
    /** 本轮 `turn/completed`：**不结算**，只作信号（见文件头；收尾还要读回） */
    turnCompleted: () => turnDone,
    /** 正常收尾：结算 + 关进程（`close()` 的语义版，便于和「被超时杀掉」区分） */
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
        child.kill();
      } catch {
        /* 已经死了：kill 抛错不影响「关闭」这个结论 */
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
    /** 进程真的退出（拿退出码用） */
    get exited() {
      return exited;
    },
  };
}
