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
 * 等注入的 MCP 落定的预算。**写成可变对象**（口径同仓库的 `TEXT_API_RETRY` / `CANDIDATE_RETRY`）：
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
  /** 子进程环境（含本次运行 `CODEX_HOME`） */
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
  /**
   * **续接到哪条线程**（`AgentRunInput.resume.sessionId`）。给了就走 `thread/resume{threadId}`，
   * 不给才 `thread/start`。
   *
   * 两条硬口径：
   *   · **键只有 `threadId`**：`ThreadResumeParams.required = ['threadId']`，cwd 只是可选覆盖
   *     （转录落在本次运行自己的 `$CODEX_HOME` 下，与 cwd 无关）⇒「换一个 cwd 就找不到会话」这件事
   *     在 codex 上不成立，别为它写兜底；
   *   · **绝不回落 `thread/start`**：静默开新会话是最坏的一种——用户以为在追问、智能体其实什么都
   *     不记得，而界面上一切正常。续接失败就让这一轮失败，原因里点名 `thread/resume`。
   */
  resumeThreadId?: string;
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
  /**
   * 中断**当前在途那一轮**（`turn/interrupt` 是协议能力，不 kill 进程）。
   *
   * 为什么必须由调用方把**在途轮号**传进来：厂商按「当前在途轮」校验（真机读数：
   * 拿一个**自然收场**的 turn id 去发，回 `-32600 no active turn to interrupt`；而**被我们中断过**的轮再发一次则**一帧都不回**，客户端会白等一个超时），
   * 而本模块建会话时只拿得到**首轮**的 id；人话续跑起的那一轮（`thread/queue/start` 起的、
   * 或厂商自己投递起的那一轮）只有流那一侧知道 ⇒ 这里收一个参数，不再用建会话时捕获的那一个。
   *
   * `null` = 当前没有在途轮（轮与轮之间）：**不发这一帧**——发一个已收场的 id 必被拒，
   * 只会白留一条 WARN；释放路径照旧由 `close()` 兜底。
   */
  interrupt(turnId: string | null): Promise<void>;
  /**
   * **在途注入**（`'round'` 档）：把一条用户消息插进**当前在途那一轮**。
   *
   * ⚠️ `expectedTurnId` 必须是**当前在途那一轮**的 id（厂商 schema 原文：*"Required active turn id
   * precondition. The request fails when it does not match the currently active turn."*）。两处推论：
   *   · 线程空闲时拿**已收场**的 turn id 去 steer 会被拒（`-32600 no active turn to steer`）；
   *   · **`thread/resume` 之后没有在途轮** ⇒ 续接回来的那一轮只能走 `'idle'` 档，`'round'` 的有效
   *     范围是「本进程内、`turn/start` 已起、未收场」。
   * 厂商侧**不发新的 `turn/started`**：消息落在本轮的下一次模型往返之前，`turn/steer` 由厂商替我们等。
   */
  steer(input: { text: string; messageId: string; expectedTurnId: string }): Promise<void>;
  /**
   * **耐久队列**（`'idle'` 档）：把一条用户消息登记进厂商线程自己的队列，交回它的提交 id。
   *
   * `clientUserMessageId` 在这一格是**必填**（`ThreadQueueAddParams.required` 三格之一），由我们铸
   * ——与端口上那条消息同值，于是「我们这一侧的身份」与「厂商那一侧的提交 id」在撤回时对得上。
   */
  queueAdd(input: { text: string; messageId: string }): Promise<string>;
  /** 按提交 id 撤回队列里的一条；`{deleted:false}` = 没删到（已消费 / 已删过 / id 不对，厂商不区分） */
  queueDelete(queuedSubmissionId: string): Promise<boolean>;
  /** 读回队列里的提交 id（撤回那一刻判「它还在不在队列里」） */
  queueList(): Promise<string[]>;
  /**
   * **让厂商把队列里的一条起成一轮**，交回新那一轮的 id。
   *
   * ⚠️ **它不是 `'idle'` 档的必经之路**（真机读数三次一致）：条目录在一个**空闲**线程上时，
   * 厂商在 `thread/queue/add` **那一刻**就自己把它撒成新一轮（上游 `dispatch_if_idle`），
   * 我们紧接着的这一发**必然**拿到 `-32600 queue is empty`——那不是失败，是「已经有人替你起了」。
   * 线程**忙**时 add 只入队，而那一轮收场时厂商同样会自己撒（真机：`turn/completed` 与
   * `turn/started` 相隔 1 ms）⇒ 这一发的真实作用收窄成「我们主动催一次」，判据只能是
   * **条目还在不在可见队列里**（见 `turn-injection.ts` 的 `deliverIdle`），不是它回没回成功。
   *
   * `queuedSubmissionId` 给 `null` = 起队首那一条（厂商按 FIFO）；两条路都回 `{turn}`。
   */
  queueStart(queuedSubmissionId: string | null): Promise<string>;
  /**
   * **装续跑闸门**：主线程一轮收场时问一次「先别结算，等我续跑」。
   *
   * 缺省不装 ⇒ 主线程第一轮收场即结算（与不装闸门时**逐字相同**，「不挂应答面就不动」的判据）。
   * 装了之后，被拦下的那一轮结局暂存，由 `continueWith`（续跑，丢掉它）或 `endPending`
   * （不再续跑，用它结算）两条路之一放行。
   */
  installTurnGate(hold: (outcome: CodexTurnOutcome) => boolean): void;
  /** 这一轮是否被闸门拦下（暂存了结局）：调用方据此判断「该续跑还是该收场」 */
  heldTurn(): boolean;
  /**
   * 续跑：丢掉暂存的结局，流继续消费（新轮的通知照旧按主线程 id 收）。
   *
   * `turnId` 可省：厂商**自己**投递起的那一轮（`thread/queue/add` 落在空闲线程上时就会发生）
   * 只有流那一侧才拿得到它的 id ⇒ 调用方先不传，等 `turn/started` 进流再补。
   */
  continueWith(turnId?: string): void;
  /** 不再续跑：用暂存的结局结算本次运行 */
  endPending(): void;
  /**
   * 取走**流停之后**入队的那些通知（取走即清空）。
   *
   * 为什么需要它：`iterate()` 在「队列已排空 ∧ 本轮已结算」时 `return`，此后到达的通知照样
   * `push` 进队列却**再没有人投影**；而用量只从通知来（协议没有「按线程读用量」的请求）
   * ⇒ 子线程那条 `thread/tokenUsage/updated` 一到就只剩「没人读」一个下场。
   * 真机读数：子线程用量落在收尾取数**之前** 3 ms，落盘的却是「子线程没有用量通知」。
   */
  drainPending(): AppServerNotificationPayload[];
  /** 关闭并**回收整棵进程树**（异步：见 `client.ts` 的 `close`） */
  close(): Promise<void>;
}

/**
 * `thread/queue/list` 最多翻几页。
 *
 * 队列里装的是**人手输入**的那几条消息，量级远小于一页；上限只为兜住「上游给的 `nextCursor`
 * 不前进」那种协议异常——真撞上时宁可少读一页，也不把一次撤回拖成死循环。
 */
const QUEUE_LIST_PAGE_LIMIT = 20;

/** 从 `thread/start` / `thread/resume` / `turn/start` 的响应里取 id；形状不对就报错（点名字段） */
function requireId(value: unknown, holder: string, field: string, context: string): string {
  const id = readString(asRecord(asRecord(value)?.[holder]), field);
  if (id === null) throw new Error(`${context} 未返回 ${holder}.${field}`);
  return id;
}

/** 文本输入块（`UserInput` 的 text 变体）：四格注入面共用同一形状，一处拼 */
function textInput(text: string): Array<{ type: 'text'; text: string; text_elements: never[] }> {
  return [{ type: 'text', text, text_elements: [] }];
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
     * 进程死在启动窗口里也要**立刻放行**：否则本次运行会白等到预算上限，而那几十秒里轮次根本没机会起
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
    // 不在这里抛：本次运行的失败判据是事件流那一侧（`AGENT_MCP_UNAVAILABLE` 的文案要厂商原文）
    logger.warn('注入的 MCP 启动失败：本轮工具表里不会有它', { failed });
  }
  if (pending.size > 0) {
    logger.warn('MCP 启动未在预算内落定，先起轮', { timedOut: [...pending], waitMs });
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
 *      `outcome` 就**永不落定**，本次运行会一直挂着（40 s 级别的用例超时就是它的警报）。
 *
 * 主线程 id 到手之前 `mainThreadId` 是 `null`：填之前不可能有 `turn/completed`（轮次还没起来），
 * 故那条判据在 `null` 期间恒不成立。
 */
interface SessionCore {
  queue: AppServerNotificationPayload[];
  /**
   * 迭代器**已经交出去**的条数（`queue` 本身从不截断）。
   *
   * 为什么游标必须住在 core 里而不是 `iterate()` 的局部变量：流停之后还要有人能把「此后到达的」
   * 那些取出来投影（`drainPending`），而「哪些已经交过」只有一处能算——两个各自记一份游标，
   * 排水那一侧就会把整段历史重发一遍（症状：消息成对重复）。
   */
  cursor: number;
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
  /** 装续跑闸门（见 `CodexSession.installTurnGate`；缺省不装） */
  installTurnGate: (hold: (outcome: CodexTurnOutcome) => boolean) => void;
  /** 这一轮是否被闸门拦下（暂存了结局） */
  heldTurn: () => boolean;
  /** 续跑：丢掉暂存的结局（`turnId` 可省，见 `CodexSession.continueWith`） */
  continueWith: (turnId?: string) => void;
  /** 不再续跑：用暂存的结局结算 */
  endPending: () => void;
  /**
   * 取走**流停之后**入队的那些通知（取走即清空）。
   *
   * 为什么需要它：`iterate()` 在「队列已排空 ∧ 本轮已结算」时 `return`，此后到达的通知照样
   * `push` 进队列，却**再没有人投影**——用量只从通知来（协议没有「按线程读用量」的请求），
   * 于是子线程那条 `thread/tokenUsage/updated` 一到就只剩「没人读」一个下场。真机读数：
   * 子线程用量 @158、收尾取数 @161，落盘的却是「子线程没有用量通知」。
   */
  drainPending: () => AppServerNotificationPayload[];
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

  /** 被闸门拦下时暂存的结局（`null` = 没拦） */
  let pending: CodexTurnOutcome | null = null;
  /** 续跑闸门：缺省 `null` ⇒ 第一轮主线程收场即结算（与不装闸门时逐字相同） */
  let shouldHold: ((outcome: CodexTurnOutcome) => boolean) | null = null;

  const core: SessionCore = {
    queue: [],
    cursor: 0,
    wake: null,
    mainThreadId: null,
    ended: () => ended,
    end: (result) => {
      if (ended) return;
      ended = true;
      pending = null;
      settleOutcome(result);
      const resume = core.wake;
      core.wake = null;
      resume?.();
    },
    outcome,
    settled,
    markStreamStopped: () => settleStream(),
    installTurnGate: (hold) => {
      shouldHold = hold;
    },
    heldTurn: () => pending !== null,
    continueWith: (_turnId) => {
      /**
       * 续跑：把暂存的那一轮结局**丢掉**（本次运行的结论取最后一轮），流继续往下消费。
       * `turnId` 这一格不参与本模块的判据（流是按主线程 id 过滤的，新轮的通知照样到，
       * 在途轮号由调用方那一侧维护）；留着是为了让调用点把「续的是哪一轮」说清楚。
       */
      pending = null;
    },
    endPending: () => {
      core.end(pending ?? { status: 'completed', error: null, durationMs: null });
    },
    drainPending: () => {
      const rest = core.queue.slice(core.cursor);
      core.cursor = core.queue.length;
      return rest;
    },
  };

  client.subscribe((raw) => {
    const payload = readNotification(raw.method, raw.params);
    core.queue.push(payload);
    if (payload.kind === 'turnCompleted' && payload.threadId === core.mainThreadId) {
      const result: CodexTurnOutcome = {
        status: payload.turn.status === 'failed' ? 'failed' : 'completed',
        error: payload.turn.error,
        durationMs: payload.turn.durationMs,
      };
      /**
       * **闸门说拦就只暂存，不结算、也不唤醒**：那一刻适配器还要拿这一拍去问端口要人话、
       * 可能再起一轮（见 `CodexSession.continueWith`）。不拦时与过去逐字相同（同步结算 + 唤醒）。
       */
      if (shouldHold?.(result) === true) pending = result;
      else {
        core.end(result);
        return;
      }
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
   * 进程就此常驻（实测：`thread/start` 超时 30s 后的 codex 进程会一直持着本次运行的 `$CODEX_HOME`，
   * 下一轮的行产物清理直接 `EPERM`）。收不掉也不改变失败结论：`close()` 自己吞掉回收异常。
   */
  try {
    await client.initialize();
    // 骨架先立：订阅与终结结算都要早于下面的两个请求（见 `SessionCore` 的 JSDoc）
    const core = createSessionCore(client);

    const threadResult = await startOrResumeThread(client, input);
    const resumed = input.resumeThreadId !== undefined;
    const threadId = requireId(threadResult, 'thread', 'id', resumed ? 'thread/resume' : 'thread/start');
    core.mainThreadId = threadId;

    /**
     * 注入的 MCP 落定之后才起轮次：工具表随每条模型请求重算，而 MCP 工具要 server `ready`
     * 之后才进表 ⇒ 起早了会让开局那几轮的请求里没有它（机制与判据见 `settleMcpStartup`）。
     */
    await settleMcpStartup(client, input.config);

    const turnResult = await client.request<unknown>('turn/start', {
      threadId,
      input: textInput(input.prompt),
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
 * 建线程或接线程：两条路只有方法名与「要不要带 `threadId`」不同，覆盖项逐字相同（模型 / cwd /
 * 权限档 / 线程级 config 都得再给一次——续接那一轮同样要按本次运行的路由与权限档跑）。
 *
 * 续接失败**原样上抛并点名 `thread/resume`**：绝不回落 `thread/start`（见 `resumeThreadId` 的说明）。
 */
async function startOrResumeThread(client: AppServerClient, input: CodexSessionInput): Promise<unknown> {
  const overrides = {
    model: input.model,
    cwd: input.cwd,
    sandbox: input.sandbox,
    approvalPolicy: input.approvalPolicy,
    ...(input.config === undefined ? {} : { config: input.config }),
  };
  if (input.resumeThreadId === undefined) return await client.request<unknown>('thread/start', overrides);
  try {
    return await client.request<unknown>('thread/resume', { threadId: input.resumeThreadId, ...overrides });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`codex 续接失败（thread/resume 失败）：${reason}`);
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
      while (true) {
        // 先排空再判结束：结算与投递是两件事，已经入队的必须交出去。
        // 游标住在 `core` 里：流停之后 `drainPending` 要靠它把「还没交过的」接过去（见 SessionCore.cursor）
        while (core.cursor < core.queue.length) {
          const payload = core.queue[core.cursor];
          core.cursor += 1;
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
    installTurnGate: core.installTurnGate,
    heldTurn: core.heldTurn,
    continueWith: core.continueWith,
    endPending: core.endPending,
    drainPending: core.drainPending,
    interrupt: async (turnId) => {
      // 没有在途轮就不发：厂商按「当前在途轮」校验，发一个已收场的 id 必被拒（真机读数）
      if (turnId === null) {
        logger.debug('codex 此刻没有在途轮，不发 turn/interrupt（释放仍走 close）');
        return;
      }
      await client.request('turn/interrupt', { threadId, turnId });
    },
    steer: async ({ text, messageId, expectedTurnId }) => {
      await client.request('turn/steer', {
        threadId,
        expectedTurnId,
        clientUserMessageId: messageId,
        input: textInput(text),
      });
    },
    queueAdd: async ({ text, messageId }) => {
      const result = await client.request<unknown>('thread/queue/add', {
        threadId,
        clientUserMessageId: messageId,
        input: textInput(text),
      });
      const id = readString(asRecord(asRecord(result)?.['queuedSubmission']), 'id');
      // 拿不到 id 就没法按身份撤回（撤回面只认 queuedSubmissionId）⇒ 响亮失败，不返回空串
      if (id === null) throw new Error('thread/queue/add 未返回 queuedSubmission.id');
      return id;
    },
    queueDelete: async (queuedSubmissionId) => {
      const result = await client.request<unknown>('thread/queue/delete', { threadId, queuedSubmissionId });
      return asRecord(result)?.['deleted'] === true;
    },
    /**
     * 让厂商把队列里的一条起成一轮，交回新那一轮的 id。
     *
     * 两处形状事实（探针 dump `v2/ThreadQueueStart{Params,Response}.json`）：参数**只有**
     * `threadId` 与可空的 `queuedSubmissionId`（不给就按 FIFO 起队首）；响应 `{turn}` 里带着
     * 新轮的 `Turn`（`turn.id` 是 UUIDv7，与 `turn/start` 同形）。
     *
     * `turn.id` 拿不到就**响亮失败**：调用方要拿它判断「是不是真起了新的一轮」（线程忙时厂商
     * 回什么没有读数），返回空串会让那条判据静默失效。
     */
    queueStart: async (queuedSubmissionId) => {
      const result = await client.request<unknown>('thread/queue/start', {
        threadId,
        ...(queuedSubmissionId === null ? {} : { queuedSubmissionId }),
      });
      return requireId(result, 'turn', 'id', 'thread/queue/start');
    },
    /**
     * 队列里现存的提交 id **全量**（跟着 `nextCursor` 翻完）。
     *
     * 为什么必须翻页：这份读数的唯一消费方是撤回那条路——`thread/queue/delete` 只回
     * `{deleted:false}`，「已消费 / 已删过 / id 不对」三件事在它那里分不开，要靠「这条还在不在
     * 队列里」才分得开。只读第一页的话，排在后面几页的那条会被读成「已经不在队列里了」
     * ⇒ 撤回给出**相反**的结论（答 `already-consumed`，而它其实还在队里等着投给模型）。
     *
     * `nextCursor` 为 `null` 才是「没有更多」（协议原文）。页数上限兜一道：cursor 不前进时
     * 宁可少读一页也不把一次撤回拖成死循环。
     */
    queueList: async () => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < QUEUE_LIST_PAGE_LIMIT; page += 1) {
        const result = await client.request<unknown>('thread/queue/list', {
          threadId,
          ...(cursor === null ? {} : { cursor }),
        });
        const record = asRecord(result);
        const data = record?.['data'];
        if (!Array.isArray(data)) break;
        for (const one of data) {
          const id = readString(asRecord(one), 'id');
          if (id !== null) ids.push(id);
        }
        cursor = readString(record, 'nextCursor');
        if (cursor === null) break;
      }
      return ids;
    },
    close: () => client.close(),
  };
}
