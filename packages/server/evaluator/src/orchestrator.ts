/**
 * 一轮评测的编排：**单行执行**（spec §5.5 的八步 + 失败隔离）与**轮级状态机**（并行 / 串行 /
 * 终止，Task 6）。
 *
 * 六条不许动的口径： *   1. **每行一个独立工作区**（F6）：串行只省 CPU 与供应商配额，不省工作区——串行共用一个目录会让
 *      第二个 agent 在第一个的改动上继续写，分数无意义、整轮作废；
 *   2. **停止只有两个来源：用户终止，或适配器自己收场**（2026-09-28 用户口径「执行不限时间、
 *      评分不限轮次和时间」）：本层**不再有任何兜底定时器**，`signal` 只表示「外部要求停止」、
 *      不带原因，故原因由本层记账（`userAborted`）；
 *   3. **失败隔离**：任何异常都在本层折成该行的终态，绝不让一行的问题冒到轮级（F12）；
 *   4. **终止是「同步落库、异步收尾」**：先改状态并写 `end` 事件，再给适配器发停止信号；
 *      在途任务稍后回来看到终态只记日志、不改状态（用户按了终止，几秒后状态跳回 `failed` 是最难解释的行为）；
 *   5. **状态变更的单一写入点**：行级只由 `setRowStatus`（同时写快照与追加事件）、轮级只由 `setRunStatus`
 *      落库；别处不许出现 `saveRun` / `status` 事件的第二个写入点（结构式守卫在 static-assertions.test.ts）；
 *   6. **在途轮次的读写走 `getRunForWrite`**（R10）：它按「这一轮自己的根」解析，用户在评测期间改工作区
 *      根目录也不会把在途的一轮打死；`getRun` 的对外语义不变（p5 的列表 / 详情仍只扫当前根）。
 *
 * **删掉时间上限的代价（照实登记）**：一行除非用户点「终止」，否则不会自己结束。原契约里
 * 「一行不会永远停在 running」那条不变量随 `rowTimeoutMs` 一起作废——上游滴流响应、忽略停止信号的
 * 适配器都可能把一行挂住，出路只剩界面上的「终止」。这是用户 2026-09-28 的明确取舍。
 *
 * 注意：本模块不写 `process.env`（§5.6.5 硬性不变量）、不拼 git 命令（走 core）、不发 HTTP（走 judge）。
 * 另：`caseCacheDir` / `ensureCaseCache` **刻意不在这里调用**——`prepareRowWorkspace` 内部已经按
 * 三参数形态（R28）调过一次，编排层再调一遍会落在 `commitHash = null` 分支上（R29：逐行 fetch +
 * `reset --hard`，且源仓库不可达时直接抛 `NOT_A_GIT_REPO`）。
 * 远端来源（`repoPath` 是 git 地址）在交给 core 之前先被物化成「本地镜像路径 + 具体 40 位 hash」
 * （spec §6.6 / RG7）：core 那条接缝只认本地路径，不需要知道 URL 的存在。
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_LABELS,
  JUDGE_OUTPUT_JSON_SCHEMA,
  ROW_STATUS_LABELS,
  ServiceError,
  TERMINAL_ROW_STATUSES,
  canRescoreRow,
  canRetryRow,
  canRunRow,
  hasLiveRows,
  isRunnableRow,
  isRunningRow,
  parseRepoSource,
  rubricMaxScore,
  type AgentEvent,
  type AgentKind,
  type AgentMessage,
  type EvalRow,
  type EvalRowStatus,
  type EvalRun,
  type Provider,
  type RowFailureStage,
  type ScoreResult,
  type SubagentRecord,
  type TestCase,
} from '@aieval/contracts';
import {
  collectDiff,
  createLogger,
  ensureMirror,
  ensureRowJudgeHome,
  rowAttemptsFile,
  loadConfig,
  prepareRowWorkspace,
  // 用例已从 config.json 搬到 `<casesRoot>/<case-id>.json`（2026-10）：题面必须从**用例文件**读，
  // 配置文件里已经没有 `cases` 那一段了
  readCase,
  resetEvents,
  resetRecords,
  resolveRemoteRef,
  rowEventsFile,
  rowJudgeEventsFile,
  rowJudgeMessagesFile,
  rowMessagesFile,
  runDir,
  runSnapshotFile,
  truncateDiff,
} from '@aieval/core';
import { acceptsProtocol, getProvider, protocolMismatchMessage, type AgentRunResult } from '@aieval/agents';
import { publishJudgeEvent, publishRowEvent } from './events';
import {
  broadcastJudgeMessage,
  broadcastRowMessage,
  publishJudgeMessage,
  publishJudgeSubagentRecord,
  publishRowMessage,
  publishSubagentRecord,
} from './row-messages';
import { judgeRow } from './judge';
import { judgeRowByAgent, JudgeAgentError } from './judge-agent';
import { requireJudgeAgent, requireJudgeEffort, resolveJudgeEffort, resolveJudgeRoute } from './judge-route';
import { forgetRunRoot } from './run-root-memory';
import { getRunForWrite, listRuns, saveRun } from './run-store';

const log = createLogger('evaluator');

/**
 * 用户终止之后，再给适配器多久把**已经算出来的**结算值交回来（毫秒；见 `runRowAttempt` 里那段注释）。
 * 与 `turn.ts` 的 `RELEASE_GRACE_MS` 同量级、同一条思路：它只量「终止之后的交卷窗口」，
 * **不是**这一行的执行上限——执行本身仍然不限时间。
 */
const TERMINATION_GRACE_MS = 5_000;

/**
 * 行级自动重试的预算：最多重试几次、每次之间等多久。
 * 与 `TEXT_API_RETRY` 同一形状的**可变对象**：用例要能钉住「重试真的发生了、且用的是同一行」
 * 而真等 2×3 秒会让每条负例都慢六秒（在满载的全量套件里成倍放大）。
 * 产品默认值由 `orchestrator.test.ts` 里一条独立用例钉住。
 */
export const ROW_RETRY = {
  /** 最多重试几次（**不含**首次执行） */
  maxRetries: 2,
  /** 两次尝试之间的等待（毫秒）：够网关从「维护中」缓过来，又不至于让人以为卡住了 */
  delayMs: 3_000,
};

/**
 * 值得**自动**重跑整行的失败码（**只增不减**）。
 * `RATE_LIMITED` 是「稍后重试」的正式语义；`AGENT_FAILED` 是「CLI 起不来 / 进程非零退出」，
 * 实测的成因是网关瞬时不可用（`Codex Exec exited with code 1` 之前跟着一串
 * 「We're currently experiencing high demand」）；`AGENT_LOAD_FAILED` 是厂商包加载失败
 * （镜像抖动，重试可能就过去了，且它只在该家失败、不影响别的行）。
 * `INTERNAL` 也收进来：文本评分通路的网络与 5xx 都折成它（见 text-api 的折错口径）。
 * `JUDGE_PARSE_FAILED` 同样收（2026-09-27，目标口径「评分失败支持重试」）：**评分那一步**失败时
 * 行落在 `failed`，而它是可以重跑的——评分是一次廉价、可重复的动作，再问一次可能就过了
 *（真实成因见 `judge.ts`：模型偶尔回散文 / 半截 JSON）；重试重跑的是整行，但那一行的候选产出
 * 会从同一基线重新生成，成本与处置都清楚可预期。
 * **不收**：`AUTH_FAILED`（密钥错）、`CONFLICT`（配置不成立）、`NOT_FOUND`、`INVALID_*`。
 */
const TRANSIENT_ROW_RETRY_CODES: readonly string[] = [
  'AGENT_FAILED',
  'AGENT_LOAD_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
  'JUDGE_PARSE_FAILED',
];

/**
 * 跑动期把「已耗时」回写快照的间隔（用户口径，2026-09-26）。
 *
 * 为什么值得写：耗时是**客观事实**（不是估算），而行结束前快照里它是 null——刷新页面、抓磁盘、
 * 或者任何一个不接 SSE 的消费方都只能看到「未采集」。5s 是「看得出来在走」与「不把写盘变成噪音」
 * 之间的折中（快照是整份 run.json 覆盖写，一轮 10 分钟的评测因此多出约 120 次小文件写）。
 * 导出它是为了让用例能用**同一个常量**推进假定时器：抄一个 5000 进用例，改这里时用例会静默失配。
 */
export const ROW_HEARTBEAT_MS = 5_000;

/** 在途行的终止控制器：abortRun / abortRow 靠它把「停止」交给适配器 */
const rowAborts = new Map<string, AbortController>();
/**
 * 被**用户**要求停止的行（`signal` 不带原因，原因必须由编排层记账）。
 * 这是**唯一**一张停止原因的记账表了（2026-09-28）：删掉单行超时之后，
 * 「外层兜底超时」这个原因不存在了，`timedOutRows` 随之删除。
 */
const userAborted = new Set<string>();

/**
 * **已判定终态**的行（`runId:rowId`）：迟到事件闸门的**状态面**（2026-09-28 新增）。
 *
 * 为什么需要它：原来那道「适配器收尾期间吐出来的事件不再落盘」的闸门，靠的是**硬停**先把行收掉
 * （`settled` 随之置真），孤儿适配器随后吐的事件才被挡住。硬停随「单行超时」一起删除之后，
 * 用户终止同样会让行**当场**落终态、而适配器的 `run()` 可能还在飞（`turn.ts` 明写可能无界返回）
 * ——少了这张表，那些事件会继续追加进 `events.jsonl`，日志抽屉里就出现「这一行已经结束了，
 * 却还在往外冒日志」。放一个 `Set` 而不是每次去读快照：事件是热路径（一行几千条），
 * 每条都读一次 run.json 不划算。
 *
 * 写入点是 `setRowStatus`（状态变更的唯一入口）——终态入表、非终态出表（重跑 / 重评会把行推回
 * `preparing`，闸门必须重新打开）。代价照实登记：每个跑过的行会在表里留一个短字符串
 * （单机单用户工具，量级与「这一轮跑过多少行」同阶），不值得为此再加一套回收。
 */
const settledRows = new Set<string>();

/** 这一行是否已判定终态（迟到事件的闸门；见 `settledRows`） */
function isRowSettled(runId: string, rowId: string): boolean {
  return settledRows.has(rowKey(runId, rowId));
}

/**
 * 「这一行已经落终态了」的**唤醒器**（每个在跑的行一个）：行任务在等适配器返回时，同时等它。
 *
 * 为什么必须有（2026-09-28 真机实测补的）：删掉行级时间上限之后，「适配器一直不返回」再没有任何
 * 兜底——用户点了终止、行状态**当场**落 `canceled`，而 `runRowAttempt` 还挂在
 * `await agentProvider.run(...)` 上（`turn.ts` 明写 `runTurn` 可能无界返回：`dispose` 只能尽力
 * 让迭代结束）。后果实测过：该行的**轮级任务**永不收尾 ⇒ 轮状态一直停在 `running`，
 * 列表显示「执行中」、「开始」被 `runTasks` 挡着拒绝，而用户以为已经停了。
 *
 * 所以这里只做一件事：**行一落终态就唤醒行任务**（不是时间上限，是用户动作的送达）。被放弃的
 * `run()` 仍在后台收尾（`abort` 已经递给适配器，`turn.ts` 的释放路径照常跑），它随后吐出来的事件
 * 由 `settledRows` 那道闸门挡在盘外——两件事合起来才是「终止真的生效」的完整形状。
 *
 * 生命周期：登记在每个行任务的入口（`runRowAttempt` / `rescoreAttempt`），清理点唯一——
 * `clearRowRuntime`（`runRow` 与 `rescoreRow` 各自的收尾都会调它）。**别**把清理挪进行任务的中途
 * （候选阶段那个 finally 曾经这么干过）：评分阶段用的是同一个 `terminalReached`，中途摘掉就等于
 * 让它变回一条没人唤醒的 promise（2026-10-07 的缺陷形状）。
 */
const terminalWaiters = new Map<string, () => void>();

/**
 * 行级**耗时心跳**的登记表（key → 计时器与它的起点）：**行一落终态就当场拆掉**（见 `setRowStatus`）。
 *
 * 为什么需要这张表（2026-10-06 真机实测补的）：心跳原先只有 `runRowAttempt` 的 `finally` 一个拆除点，
 * 而那条路要等适配器交卷——`TERMINATION_GRACE_MS` 只是它的**下限**，实测一次拖了两分钟。
 * 期间使用者早已看到「已终止」，快照里的 `durationMs` 却还在每 5s 往上涨
 * （run `8df6ff65` 的 codex 行：`canceled` 落在 18:25:31，读数到 18:27:33 仍在变），
 * 而界面在终态读的正是快照值（`MetricLine` 的实时叠加层只在 `running` 时生效）⇒
 * 症状就是「候选行已经手动停止，耗时还在增加」。
 *
 * 结论：终止是**同步**动作，撤心跳也必须同步——不能把它挂在「适配器什么时候愿意交卷」上。
 */
const rowHeartbeats = new Map<string, { timer: ReturnType<typeof setInterval>; startedAt: number }>();

/**
 * 拆掉这一行的心跳（**幂等**），返回它登记的起点（没登记过 ⇒ `null`）。
 * 幂等是必须的：`setRowStatus` 与 `runRowAttempt` 的 `finally` 都会调它，先到的那一次生效。
 */
function stopRowHeartbeat(key: string): number | null {
  const entry = rowHeartbeats.get(key);
  if (entry === undefined) return null;
  clearInterval(entry.timer);
  rowHeartbeats.delete(key);
  return entry.startedAt;
}

/**
 * 这一行此刻是否还在**候选阶段**（心跳就是在这一档里建立的）。
 * 判据只有一个用处：落终态时该不该把耗时冻结在「此刻」——行进了 `judging` 之后，
 * `Date.now() - startedAt` 里混着评分那一段，而 `durationMs` 的口径是**候选那一段**
 * （见 `runRowAttempt` 的注释）；正常收尾的 `judged` 正落在那一档，绝不能被这里覆盖。
 * 注意它判的**不是**「心跳在不在跑」：心跳一直活到 `runRowAttempt` 收尾，`judging` 期间照走。
 */
function isCandidatePhase(status: EvalRowStatus): boolean {
  return status === 'preparing' || status === 'running';
}

function rowKey(runId: string, rowId: string): string {
  return `${runId}:${rowId}`;
}

/**
 * 取快照 + 取行；行不存在抛 NOT_FOUND（带两个 id，便于从日志反查）。
 *
 * 走 `getRunForWrite` 而不是 `getRun`：本层是**在途轮次**的读写者。用户在这期间把工作区根目录从 A 改到 B
 * 之后，`getRun`（只扫当前根）会抛 NOT_FOUND ⇒ 本函数第一次调用就炸，而 `settleFailed` 也要先走这里
 * ⇒ 行停在非终态、只留一行 ERROR 日志（评审 H1）。`getRunForWrite` 用「当前根优先、进程内记忆兜底」
 * 解析出**这一轮自己的根**（与 events.ts 的事件路径同一个入口，R10）。
 * 对外的读侧口径不受影响：`getRun` 仍只扫当前根（p5 的列表 / 详情路由用它是正确的）。
 */
function requireRow(runId: string, rowId: string): { run: EvalRun; row: EvalRow } {
  const run = getRunForWrite(runId);
  const row = run.rows.find((item) => item.id === rowId);
  if (row === undefined) throw new ServiceError('NOT_FOUND', `评测 ${runId} 里没有候选行 ${rowId}`);
  return { run, row };
}

/** 改一行的字段并落盘快照；行不存在即抛 NOT_FOUND */
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}

/**
 * 行状态变更的**唯一**入口：写快照（run.json）+ 追加状态事件（events.jsonl）。
 * 为什么合成一个函数：F14 要求事件日志是唯一真相源，而真相源一旦有两个写入点就必然漂移；
 * 状态只在这里改，别处只补字段（patchRow）。`patch` 先合并、`status` 后覆盖，避免 patch 顺手改掉状态。
 * 全仓**不许**出现「直接 `row.status = …` 再 `saveRun`」的第二条路径——那是漂移的开始。
 */
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  const key = rowKey(runId, rowId);
  const heartbeat = rowHeartbeats.get(key);
  mutateRow(runId, rowId, (row) => {
    /**
     * **落终态 = 这一行不再有时长了**：把耗时**冻结在「此刻」**（用户口径 2026-10-06）。
     * 三档判据缺一不可：
     *   · 落的是终态；
     *   · 落状态**之前**这一行还在候选阶段（`judging` 之后 `Date.now() - startedAt` 混进了评分那一段，
     *     而 `durationMs` 的口径是候选那一段——正常收尾的 `judged` 正落在那一档，不许被这里覆盖）；
     *   · 这一行确实有心跳（`preparing` 阶段就被终止的行还没有心跳，那时它的耗时本就该保持 null）。
     * 合并顺序是 `patch` → 冻结值 → `status`：冻结值代表「此刻」，比调用方可能顺手带进来的旧值更准，
     * 所以排在 `patch` 之后（今天没有调用方带这一格，这个顺序是给它兜底的）。
     */
    const frozen =
      heartbeat !== undefined && TERMINAL_ROW_STATUSES.includes(status) && isCandidatePhase(row.status)
        ? { durationMs: Date.now() - heartbeat.startedAt }
        : {};
    Object.assign(row, patch ?? {}, frozen, { status });
  });
  // 迟到事件闸门的状态面（见 `settledRows`）：终态入表、非终态出表
  if (TERMINAL_ROW_STATUSES.includes(status)) {
    settledRows.add(key);
    // 心跳随终态**当场**拆掉。放在写盘之后：写盘失败（磁盘满 / 快照被删）时这一行照旧在跑，
    // 它不能连心跳都没了——那种「状态没落地、心跳也没了」的形状比多写几拍糟得多。
    stopRowHeartbeat(key);
    // 唤醒正在等适配器返回的那一次行任务（见 `terminalWaiters`）：用户终止必须真的能收尾轮级状态
    terminalWaiters.get(key)?.();
  } else {
    settledRows.delete(key);
  }
  publishRowEvent(runId, rowId, { type: 'status', status });
  // 回读也走 in-flight 的入口：否则改过根目录之后，这一次状态变更写进了旧根、这里却在新根读不到
  return getRunForWrite(runId);
}

/** 只补字段、不动状态：计量 / diff 摘要在跑的过程中逐步落库，状态由 setRowStatus 管 */
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}

/** 让出一次事件循环：工作区准备是同步重活（整目录复制 + checkout），留在调用方栈里会让「开始」这个请求卡住整段复制时长 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 错误对象 → ServiceError：已是 ServiceError 就原样透传（错误码要保留给该行的 `error.code`） */
function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError('INTERNAL', error instanceof Error ? error.message : String(error), { cause: error });
}

/** 从 `ServiceError.context` 里取回解析失败时保留的原文（编排层要把它写进事件日志） */
function rawFromContext(context: unknown): string | null {
  if (typeof context !== 'object' || context === null) return null;
  const raw = (context as { raw?: unknown }).raw;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/* ===================================================================================================
 * 评分阶段（Task 4 的第 7 步：spec §7.3 / §7.4）
 *
 * 这一段的定位是**行级**的，故放在轮级状态机之前。三条不变式：
 *   ① 尺子（`resolveJudgeRoute`）与「这一分是哪把尺子打的」（`judgeProviderId`）取自**同一份配置快照**
 *      （R14：两次同步读之间没有 `await`，等于同一瞬间的快照）——变的只是谁去驱动那把尺子；
 *   ② **评分阶段不再有上限**（2026-09-28 用户口径「评分不限轮次和时间」）：原来这里有
 *      「内层超时 + 外层兜底 + 硬停」三件套（终审 FIX-1），现已全部删除。代价照实登记：
 *      一次滴流的上游响应、或一个忽略停止信号的适配器，会把这一行一直挂在 `judging`，
 *      而出路只剩用户点「终止」——`signal` 仍然是两条通路共用的那一把，终止照样能切断它；
 *   ③ 评分前后的改动摘要必须一致（spec §7.4 的污染对照）：不一致说明评审者动了工作区，而
 *      「查看改动」抽屉是按需现算的——它显示的不再是候选的产出，这件事绝不静默。
 * =================================================================================================== */

/** 评分阶段的可复用输入：完整跑一行与重新评分走**同一条**路径（两处各写一遍必然漂移） */
interface JudgeStageContext {
  runId: string;
  rowId: string;
  run: EvalRun;
  testCase: TestCase;
  workspacePath: string;
  baselineCommit: string;
  /** 第 6 步已算好的裁剪后正文；重新评分传 null（自己现算） */
  diffText: string | null;
  /** 第 6 步已算好的改动摘要（污染对照的「评分前」那一份）；重新评分传 null（自己现算） */
  diffSummary: NonNullable<EvalRow['diff']> | null;
  controller: AbortController;
  /**
   * 「这一行落终态」的唤醒器（同 `terminalWaiters` 的语义：不是时间上限，是用户动作的送达）。
   *
   * 为什么它在 ctx 上而不是在 `judgeStageAttempt` 里现造：唤醒器是**逐行一次性**的，注册点在行任务的
   * 入口（`runRowAttempt`）——评分阶段只是它的一个消费者；在这里再造一个就没人注册它，
   * 等于没有。两条评分通路各有一个生产者：完整跑一行用候选阶段那一个（同一个行任务），
   * 重新评分那条旁路自己造一个并注册（见 `rescoreAttempt`）。
   */
  terminalReached: Promise<'terminal'>;
}

/**
 * 改动摘要（与 `EvalRow.diff` 同形）：污染对照用，只看计数、不需要正文与裁剪。
 * `truncated` 恒为 `false` 是**刻意的**：这一份只参与「文件数 / 增删行数」三者的比对，
 * 正文有没有被 `diffBudgetBytes` 裁掉与「评审者是否动过工作区」无关（被裁掉的文件数不是改动）。
 */
function diffSummaryOf(workspacePath: string, baselineCommit: string): NonNullable<EvalRow['diff']> {
  const collected = collectDiff(workspacePath, baselineCommit);
  return {
    filesChanged: collected.filesChanged,
    insertions: collected.insertions,
    deletions: collected.deletions,
    truncated: false,
  };
}

/** 按 `diffBudgetBytes` 裁剪后的改动正文：完整跑一行与重新评分共用同一个算法 */
function clippedDiffText(workspacePath: string, baselineCommit: string, budgetBytes: number): string {
  return truncateDiff(collectDiff(workspacePath, baselineCommit).text, budgetBytes).text;
}

/**
 * 评分阶段的执行骨架（**不再有界**，2026-09-28 用户口径「评分不限轮次和时间」）。
 * 两条通路（智能体 / 文本 API）共用它——分开写必然在某一处漏掉记账或污染对照。
 *
 * 它现在做四件事：
 *   ① **迟到事件闸门**：本函数一落定就 `settled = true`，此后适配器收尾期间吐出来的事件不再落盘
 *      （它们会把「已结束」的日志拖长）。`events.ts` 的写入是无条件的，闸门只能设在这里。
 *   ② **用户终止的归因**：适配器 / HTTP 客户端只会报「被中止」（`signal` 不带原因），
 *      只有本层的 `userAborted` 记账能把它翻成 `AGENT_CANCELED`。原来还有一支「外层兜底超时」，
 *      随单行超时一起删了 ⇒ 现在能到这里的中止**只可能**是用户点的终止。
 *   ③ **污染对照**（spec §7.4，智能体通路专有）：评分前后的改动摘要必须一致，不一致就落一条
 *      带 `[ERROR]` 前缀的行日志——**拿到分就判失败**（`AGENT_FAILED` + `stage: 'judge'`），
 *      没拿到分则只留痕（真因优先）。「查看改动」抽屉是按需现算的，评审者动过工作区就不再是候选的产出。
 *   ④ **终止 race**（`ctx.terminalReached`）：`Promise.race([attempt, terminalReached])`，终止那一支赢就
 *      **不改状态**（这一分不落快照），在途结果回来后只落一条 `[已终止的尝试]` log + 一条 `score` 事件。
 *
 * `label` 是点名那一段（评分智能体 / 评分模型（文本 API））；`beforeSummary` 由调用方在
 * **进入本函数之前**算好（完整跑一行用第 6 步那一份、重新评分现算）：那一步自己会抛
 * （工作区被删 / git 不可用），而它抛在 `try` 之外时就没有 `finally` 能做对照了。
 */
/**
 * 评分阶段的三个外发出口（与候选阶段 `agentProvider.run` 的 `onEvent` / `onMessage` / `onSubagent`
 * 同形）：三条都受**同一道迟到闸门**约束，也都落在**评分自己那条流**里（2026-10-10 起与执行日志分开）。
 */
interface JudgeSinks {
  onEvent: (event: AgentEvent) => void;
  onMessage: (message: AgentMessage) => void;
  onSubagent: (record: SubagentRecord) => void;
}

async function judgeStageAttempt(input: {
  ctx: JudgeStageContext;
  label: string;
  /** 真正去拿这一次分：智能体通路启动评审者，文本通路调一次文本 API（signal 都由 ctx 那一把提供）。
   *  `sink` 的三个出口都**受 settled 闸门约束**（见下面 forward*）：智能体通路把它们接到
   *  `onEvent` / `onMessage` / `onSubagent` 上，文本通路没有内容可转、整个忽略。 */
  attempt: (sink: JudgeSinks) => Promise<ScoreResult>;
  /** 污染对照的「评分前」那一份摘要（spec §7.4）；不传 / null = 不做对照（文本通路） */
  beforeSummary?: NonNullable<EvalRow['diff']> | null;
  /** 智能体名（只有智能体通路有）：只进服务端日志，便于从一堆失败里认出是哪一家 */
  agentKind?: AgentKind;
}): Promise<ScoreResult> {
  const { ctx } = input;
  const key = rowKey(ctx.runId, ctx.rowId);

  // 污染对照（spec §7.4）：评分前后的改动摘要必须一致。不一致说明评审者动了工作区，而
  // 「查看改动」抽屉是按需现算的 ⇒ 它显示的不再是候选的产出。
  // 2026-10-07（用户裁决）：**拿到分时升级为该行失败**——那一份分建立在一个被改过的现场上，
  // 不自动回滚（没有干净基线可退），但也不许当作正常分数收下；拿不到分时只留痕（见 finally）。
  const before = input.beforeSummary ?? null;

  /** 迟到事件闸门（两道）：本函数自身落定之后，以及**行已被判定终态**之后（用户终止会让后者先发生，
   *  而适配器的 `run()` 可能还在飞——见 `settledRows` 的注释）。 */
  let settled = false;
  /** 闸门的唯一判据：三条出口（事件 / 消息 / 子任务）共用它，免得三处各写一遍条件而漏掉一条 */
  const gateOpen = (): boolean => !settled && !isRowSettled(ctx.runId, ctx.rowId);
  /**
   * 评审者的事件（`log` / `usage` / `vendor-system` / `error`）→ **评分自己的事件流**
   * （`judge-events.jsonl`，2026-10-10）。行级那条流因此只讲候选发生了什么；编排层自己的留痕
   * （降级、终止、失败归因）仍走 `publishRowEvent`——判据是**产出者**，不是事件类型。
   */
  const forward = (event: AgentEvent): void => {
    if (!gateOpen()) return;
    publishJudgeEvent(ctx.runId, ctx.rowId, event);
  };
  /**
   * 评审者的内容消息：与候选阶段**同一套分叉**（快照落盘、增量只广播），只是落在评分那条流
   * （`judge-messages.jsonl`）。**刻意不记 `streamingDelta`**：那一格是**候选**的流式观测
   * （`EvalRow.streamingDelta` 回答「候选到底有没有在打字」），把评审者的帧数写进去就是答非所问。
   */
  const forwardMessage = (message: AgentMessage): void => {
    if (!gateOpen()) return;
    if (message.chunk === 'delta') {
      broadcastJudgeMessage(ctx.runId, ctx.rowId, message);
      return;
    }
    publishJudgeMessage(ctx.runId, ctx.rowId, message);
  };
  /** 评审者自己派发的子任务行（同一道闸门、同一条评分流） */
  const forwardSubagent = (record: SubagentRecord): void => {
    if (!gateOpen()) return;
    publishJudgeSubagentRecord(ctx.runId, ctx.rowId, record);
  };

  /** 这一次拿到分了吗：污染判定据此决定「升级为失败」还是「只留痕」（见 finally） */
  let scored: ScoreResult | null = null;
  try {
    /**
     * 等这一次评分，**同时等「行落终态」**（spec §6 / D13）：评分阶段原先只有裸 `await`，适配器不响应
     * abort 时用户点了「终止」也收不了场（行已同步落 `canceled`，任务却一直挂着 ⇒ `runRow` 的 finally
     * 不执行、`rowAborts` 记账不清、`drainRunningTasks` 空转）。宽限为 **0**：这一分反正落不了快照
     * （行已是终态，用户意图优先），没必要为交卷多等（与候选阶段的 `TERMINATION_GRACE_MS` 5 秒不同）。
     */
    const attempt = input.attempt({ onEvent: forward, onMessage: forwardMessage, onSubagent: forwardSubagent });
    // 先挂一个 catch：race 输了之后它仍在飞（适配器可能永远不交卷），而裸的孤儿 promise 一旦 reject
    // 就是 unhandledRejection（Node 默认 `--unhandled-rejections=throw`，能打崩进程）——
    // 与候选阶段那句 `runPromise.catch(() => {})` 同一条理由
    attempt.catch(() => {});
    const first = await Promise.race([attempt.then(() => 'done' as const), ctx.terminalReached]);
    /**
     * 终态优先：这一行已经落了终态（用户终止），这一分**不落快照**——但**证据不能凭空消失**：
     * p4 的口径是「在途任务稍后回来看到终态就只记日志、不改状态」，这里保留的就是那条日志。
     * 宽限为 0 之后调用方那条终态复检（`runRowAttempt` / `rescoreAttempt` 的 `afterJudging`）已经等不到
     * 交卷了（它此前是这份证据的唯一产出点），于是把这一笔挪到这里（spec §6 的落点已按这条口径改写：
     * 不改状态 + 只记日志，两者缺一不可）。
     * 末尾那个 `.catch` 管两件事：这个 `.then` 自己抛（事件写不进去——这一轮可能已被删、目录已回收），
     * 以及 `attempt` 最终 reject（经 `.then` 转发过来）——两件都不该影响本函数即将抛出的终止归因。
     */
    if (first === 'terminal') {
      attempt
        .then((late) => {
          /**
           * **先留来源标识，再发那条分**（评审 Minor-1）：这一笔续作跑的时候，行任务早已收尾——
           * `clearRowRuntime` 释放了 `rowAborts`，用户甚至可能已经点了「重新执行 / 重新评分」。
           * 于是这条孤儿的 `score` 会**夹在新一轮的事件之间**（改动前不可能：行任务必须等评分返回才结束），
           * 在 F14「事件日志是唯一真相源」下会被误读成**新一轮的分数**。紧邻在它前面的一条带标记 log
           * 就是它的来源：读日志的人一眼能看出「这条分属于上一次已被终止的尝试，没写进行里」。
           */
          publishRowEvent(ctx.runId, ctx.rowId, {
            type: 'log',
            stream: 'stderr',
            text: `[已终止的尝试] 这一次${input.label}在终止之后才交回结果：分数未写入该行，以下这一条仅为证据`,
          });
          publishRowEvent(ctx.runId, ctx.rowId, { type: 'score', score: late });
          log.warn('行已被终止，评分结果只记入事件日志', { runId: ctx.runId, rowId: ctx.rowId, label: input.label });
        })
        .catch(() => {});
      throw new JudgeAgentError('AGENT_CANCELED', `${input.label}已被终止`);
    }
    // 'done' 那一支重取一次：此刻它已解决，不会二次等待（也让 `scored` 的赋值留在原来的位置上）
    scored = await attempt;
    return scored;
  } catch (error) {
    // 停止归因**只按本层记账**（`signal` 不带原因）：判据是 `signal.aborted`（不是错误类型）——
    // 停止只可能来自我们交出去的那把 signal，而它在中止路径上抛出的形状因运行时/阶段而异
    // （适配器归一化后的 AGENT_CANCELED、undici 的 AbortError、我们自己在 fetchFailure 里折的
    // ServiceError），按错误类型判必然漏一种。
    // 这里**只有**用户终止这一种可能了：外层兜底超时随单行超时一起删除（2026-09-28）。
    if (ctx.controller.signal.aborted && userAborted.has(key)) {
      throw new JudgeAgentError('AGENT_CANCELED', `${input.label}已被终止`);
    }
    throw error;
  } finally {
    // 先闸住迟到事件：这段 finally 之后调用方立刻要写终态
    settled = true;
    if (before !== null) {
      /**
       * 对照本身失败（工作区被删、git 不可用）不该顶替评分结论 ⇒ 只记 WARN。
       * **它必须与「发现污染」分开**：下面的升级是 `throw`，被这里的 catch 兜住就永远不会生效。
       */
      let after: NonNullable<EvalRow['diff']> | null = null;
      try {
        after = diffSummaryOf(ctx.workspacePath, ctx.baselineCommit);
      } catch (error) {
        // 对照失败（工作区被删、git 不可用）不该顶替评分本身的结论，只记 WARN
        log.warn('评分后的改动对照失败（不影响本次结论）', {
          runId: ctx.runId,
          rowId: ctx.rowId,
          reason: toServiceError(error).message,
        });
      }
      if (after !== null && diffChanged(before, after)) {
        const detail =
          `（评分前 ${before.filesChanged} 个文件 +${before.insertions} −${before.deletions}，`
          + `评分后 ${after.filesChanged} 个文件 +${after.insertions} −${after.deletions}）`;
        const message =
          `${input.label}执行期间改动了工作区${detail}：评审者只能读，改动会让「变更详情」抽屉显示的不再是候选的产出`;
        publishRowEvent(ctx.runId, ctx.rowId, { type: 'log', stream: 'stderr', text: `[ERROR] ${message}` });
        /**
         * **有分才算污染**：拿到分说明评审者跑完了，那一份分建立在一个它自己改过的现场上——不可信，
         * 直接判这一次失败（上层的 `catch` 把它折成行的 `failed` + `stage: 'judge'`）。
         * 拿不到分时不抛：那种情况下的第一归因是**它为什么没跑完**（认证失败 / 网络 / 被终止），
         * 拿污染顶掉它等于把真因换成一句副作用描述。
         */
        if (scored !== null) throw new JudgeAgentError('AGENT_FAILED', message);
      }
    }
  }
}

/** 两次改动摘要是否不同（只看三格：文件数、增、删）——评分前后对照的唯一判据 */
function diffChanged(before: NonNullable<EvalRow['diff']>, after: NonNullable<EvalRow['diff']>): boolean {
  return (
    after.filesChanged !== before.filesChanged ||
    after.insertions !== before.insertions ||
    after.deletions !== before.deletions
  );
}

/**
 * 评分前的档位校验（spec §5.4 / D8 的**第二道门**）：把 `settings.defaultJudge.effort` 交给
 * `requireJudgeEffort` 判一次，越域 / 空串当场抛 CONFLICT + 指向评分配置。
 *
 * 为什么在编排层也要有（生成 / 识别那条通路另有自己的一道）：`effort` 的 schema 守卫只作用于走 schema
 * 的**写下侧**，而 `loadConfig()` 刻意不做校验 ⇒ 手改 `config.json` 写进的档位、或换掉评分智能体之后
 * 留下的悬空档位会一路到消费方。不拦就要跑到 dsh 的 `UNSUPPORTED_REASONING_EFFORT` 才失败。
 *
 * 三处刻意的口径：
 *   · `config` 由调用方传进来（`runJudgeStage` 手里那份快照）：找模型记录用的就是**同一份**快照里的
 *     同一对 id，不必再读一次盘；
 *   · 模型记录查不到就**跳过**——那一支由 `resolveJudgeRoute()` 负责报错（两者的查找判据逐字相同，
 *     故这道门永远不会顶掉路由那句更准的中文原因）；
 *   · 两个分支**各调一次**，因为「评分智能体域」依分支而异：文本通路压根不用智能体，故按设置里
 *     那一格判（与设置页给出候选档位时用的是同一条口径），智能体通路则用它自己那个已校验过的 kind。
 */
function requireConfiguredJudgeEffort(
  config: ReturnType<typeof loadConfig>,
  effort: string | undefined,
  agentKind: AgentKind | null,
): void {
  const pair = config.settings.defaultJudge;
  const model = config.providers
    .find((item) => item.id === pair?.providerId)
    ?.models.find((item) => item.id === pair?.modelId);
  if (model === undefined) return;
  requireJudgeEffort({ effort, model, agentKind });
}

/**
 * 评分阶段：解析尺子 → 按 `run.useAgentJudge` 选通路 → 出分。
 * 尺子只有**一个**来源：设置页「评分配置」的全局默认评分模型（`resolveJudgeRoute()`，无参）；
 * 「这一分是哪把尺子打的」也取自**同一份配置快照**（两次同步读之间没有 `await`，等于同一瞬间的快照）。
 * 变的一直只是谁去驱动那把尺子。用例上不再有评分模型覆盖，R14 原先那条「优先级表达式两处恒等」
 * 的接缝随之消失——`judgeProviderId` 与 `route` 现在来自同一个 `defaultJudge`。
 *
 * **两条通路都走 `judgeStageAttempt`**（终审 FIX-1 引入、2026-09-28 去掉上限后保留骨架）：
 * 文本通路原来既拿不到 signal、也没有自己的上界，于是「终止」按了也只是把状态同步改成 `canceled`、
 * 调用照旧在飞。现在两段共用同一套记账（`userAborted`）与同一套终态映射（`settleAgentJudgeStop`）。
 *
 * 抛出的两类错误由调用方分别处置：`ServiceError`（配置缺失 / 解析失败）→ `settleFailed`；
 * `JudgeAgentError`（评分阶段的终止 / 失败，两条通路共用）→ `settleAgentJudgeStop`。
 * **绝不把 `AGENT_*` 折成 `ServiceError`**：它们不是 contracts 的 `ErrorCode`。
 */
async function runJudgeStage(ctx: JudgeStageContext): Promise<ScoreResult> {
  setRowStatus(ctx.runId, ctx.rowId, 'judging');

  // 兜底守卫：评分表为空（满分 0）时这一行**没法评**。`RubricSchema` 刻意不设 `.min(1)`
  // （空表是新建用例的真实初态），而空表**是一张合法的 `Rubric`**：用例的写入路径由 `assertStorable`
  // 拦住，但读侧只拒过不了 schema 的形状（见 `asUsableRubric`），于是一张手改 `config.json` 留下的空表
  // 照样能被 `getCase` 读出来、被 `createRun` 原样快照进 `run.json`——这条守卫就是为它准备的。
  // 放它走下去的话 `maxScore` 会是 0，而契约要求它为正，于是抛出一句「本不该发生」的 INTERNAL；
  // 这里把它变成一个能讲清楚的状态，且**评分器一次都不调用**（没有表就没有判定依据）。
  //
  // 文案为什么必须点名「快照」与「新建一轮评测」：判据读的是 `ctx.run.rubric`——**创建这一轮时**
  // 拍下的那份快照。于是「去用例里补上评分项」对用空表建出来的这一轮**不成立**：用户照做之后，
  // `开始` / `重新执行` / `重新评分` 会再次撞上同一条守卫（快照还是那张空表），
  // 唯一解得开这个状态的动作是**新建一轮评测**（那时才会重新拍一张非空快照）。
  // 一句话里三件事缺一不可：这是**这一轮**用的表、它**创建时已快照**（改用例不影响它）、出路是**新建**。
  if (rubricMaxScore(ctx.run.rubric) <= 0) {
    throw new ServiceError(
      'CONFLICT',
      '这一轮用的评分标准项是空的，无法评分：这一轮的评分表在创建时就已快照，改用例不会影响它——请在用例里补上评分项后新建一轮评测',
    );
  }

  const config = loadConfig();
  const route = resolveJudgeRoute();
  // 强度与尺子同源（同一份 `defaultJudge`；这两次读之间没有 await，等于同一瞬间的快照）。
  // 走 `resolveJudgeEffort()` 而不是从上面的 `config` 里现取：那是**唯一读点**（spec §5.3），
  // 多一处直读就多一处会漂移的地方。校验（spec §5.4 的第二道门）紧挨着读点，但落在**各分支**里——
  // 「评分智能体域」那一格依分支而异（见 `requireConfiguredJudgeEffort`），且必须在**花掉任何一次
  // 上游调用之前**判掉：越域档位是配置问题，不该等到 dsh 的 `UNSUPPORTED_REASONING_EFFORT` 才现形。
  const judgeEffort = resolveJudgeEffort();
  // 冗余快照的同一理由（§7.2）：这一分是哪把尺子打的必须留在行上。取值与上面 `resolveJudgeRoute`
  // 内部的 `providerId` 是同一个来源（同一份 `config` 快照里的 `defaultJudge`），不再有两处表达式要对齐。
  const judgeProviderId = config.settings.defaultJudge?.providerId ?? '';

  if (!ctx.run.useAgentJudge) {
    // 文本通路没有智能体驱动它，故「评分智能体域」按设置里那一格判：与设置页给出候选档位时同一条口径
    // （这一格没配、或是个枚举之外的坏值时，`requireJudgeEffort` 自己取规范五档）
    requireConfiguredJudgeEffort(config, judgeEffort, config.settings.defaultJudgeAgent ?? null);
    return judgeStageAttempt({
      ctx,
      label: '评分模型（文本 API）',
      attempt: () =>
        judgeRow({
          // 尺子是**这一轮的快照**（`run.rubric`），不是用例现取的那一份：改了用例的评分表之后重评，
          // 用的仍应是当初那把尺子，历史分数的满分也仍与它自己自洽
          rubric: ctx.run.rubric,
          diffText: ctx.diffText ?? clippedDiffText(ctx.workspacePath, ctx.baselineCommit, config.settings.diffBudgetBytes),
          taskPrompt: ctx.testCase.taskPrompt,
          route,
          judgeProviderId,
          // 强度按需带（没配就一个键都不出现）：与候选执行同一条口径——**请求参数**由两条通路
          // 各自递下去，不在 `route` 上（那是连接事实）。记账在评分器里做（`finalizeScore`）
          ...(judgeEffort === undefined ? {} : { judgeEffort }),
          // 文本通路的停止信号（终审 FIX-1）：它与智能体通路共用编排层那一把控制器，
          // 于是「终止」真的能切断这次调用（不再有外层兜底给它上界——上限已随单行超时删除）。
          signal: ctx.controller.signal,
          // 结构检查不合格 ⇒ judgeRow 会回问模型（多轮修复）。每一轮都写进该行日志：
          // 「为什么这一行多花了一次请求的时间」必须能从日志抽屉里看出来（静默重试不可接受）。
          onProgress: (progress) => {
            publishRowEvent(ctx.runId, ctx.rowId, {
              type: 'log',
              stream: 'stderr',
              text: `[评分] 第 ${progress.round} 轮返回未通过结构检查：${progress.message}；已把该原因回问评分模型，重新请求评分结果`,
            });
          },
          // 「一次新的行尝试」的接缝（生产代码里是 no-op）：夹具靠它知道 attempt 的边界，
          // 从而能分别造出「这一次尝试里评分第一次失败、第二次成功」与「跨尝试重跑之后成功」
          onAttemptStart: () => {},
        }),
    });
  }

  const kind = requireJudgeAgent({ defaultJudgeAgent: config.settings.defaultJudgeAgent, route });
  // 档位校验放在 `requireJudgeAgent` **之后**：那一格是坏值时，先由它给出「默认评分智能体不是可用的
  // 智能体」这句准确的中文原因，而不是被这里按「未配智能体」的域去报一个档位问题（归因会指错方向）
  requireConfiguredJudgeEffort(config, judgeEffort, kind);
  // 在进入执行骨架**之前**把评分智能体的配置目录建出来（原来它是作为实参先算的）：
  // 建目录失败（磁盘满 / 目录形状非法）该是一次普通的 `failed`，不该混进「评审者本身失败」那条路。
  const judgeHome = ensureRowJudgeHome(ctx.run.workspaceBase, ctx.runId, ctx.rowId);
  const score = await judgeStageAttempt({
    ctx,
    label: '评分智能体',
    agentKind: kind,
    // 第 6 步已经算过一份（`ctx.diffSummary`）；重新评分没有它，现算一份（spec §7.4 的对照不能省）
    beforeSummary: ctx.diffSummary ?? diffSummaryOf(ctx.workspacePath, ctx.baselineCommit),
    attempt: (sink) =>
      judgeRowByAgent({
        kind,
        cwd: ctx.workspacePath,
        configHome: judgeHome,
        route,
        baselineCommit: ctx.baselineCommit,
        // 与文本通路同一份快照、同一个表达式（两条通路必须是同一把尺子）
        rubric: ctx.run.rubric,
        taskPrompt: ctx.testCase.taskPrompt,
        signal: ctx.controller.signal,
        judgeProviderId,
        // 与文本通路同一格、同一份快照（两条通路的要求强度必须是同一个值，否则分数不可比）
        ...(judgeEffort === undefined ? {} : { judgeEffort }),
        // 总是表达「我想要 schema」：能不能给由适配器按能力决定（A1），降级会经 applied 报回来
        outputSchema: JUDGE_OUTPUT_JSON_SCHEMA,
        // 三条出口一起接上（2026-10-10）：评审者的事件、消息、子任务行都落**评分自己那条流**，
        // 执行日志那条只讲候选做了什么
        onEvent: sink.onEvent,
        onMessage: sink.onMessage,
        onSubagent: sink.onSubagent,
      }),
  });
  /**
   * 降级留痕。判据来自**结果**（`applied`）而不来自注册表：包外不再预读 `capability`，于是
   * 「这一次有没有真的把结构化输出落到实处」由**骨架**算（`runTurn` 按适配器转发的能力声明摘掉
   * schema 并记下 `applied.structuredOutput`），编排层只负责把那个结论留在这一行的日志上。
   *
   * 为什么必须在**拿到分之后**才留痕：判据本身来自这一次运行的结果，跑之前无从得知。
   * 为什么留痕不能省：降级是允许的，静默降级不是——「这一分是在 schema 约束下拿到的」与「只靠
   * 提示词契约拿到的」在分数与界面上长得一模一样，横向比较时（同一批用例、改过评分配置前后、
   * 重评过的行）必须能从这一行的日志里读出这个差别。
   */
  if (score.structuredOutput === false) {
    publishRowEvent(ctx.runId, ctx.rowId, {
      type: 'log',
      stream: 'stderr',
      text:
        `[评分] ${AGENT_LABELS[kind]} 没有把结构化输出落到实处（适配器 SDK 无 schema 入参），`
        + '本行回落到提示词契约：返回形状由结构检查兜底，不合格会落 JUDGE_PARSE_FAILED',
    });
  }
  return score;
}

/**
 * 把评分阶段的停止 / 失败折成行终态。**两条通路共用**（终审 FIX-1 之后文本通路也走这里）：
 * 名字里的「Agent」是历史（携带归因码的 `JudgeAgentError` 就是这个映射的入参类型），
 * 而两条通路的终态口径必须**逐字一致**——否则两条通路同一件事在界面上长得不一样。
 * 映射是**规定动作**，不是随手兜底：
 *   · `AGENT_CANCELED` → `canceled`（用户意图优先，与候选 agent 阶段同一口径）；
 *   · `AGENT_TIMED_OUT` → `timed-out`：**今天没有任何生产者**——删掉单行超时后评分阶段不再有超时来源，
 *     三家适配器（`providers/<kind>/`）也都不自报这个码。留着这一支有两个理由：归因码是
 *     `JudgeAgentError` 类型的一部分（`judgeRowByAgent` 会把适配器自报的 `result.error.code` 原样转出来，
 *     将来某家真自报超时时这里就是它的落点），且磁盘上的历史行还带着 `timed-out`——删掉这一支
 *     会让历史数据的读侧缺少对应映射；
 *   · 其余（`AGENT_FAILED` / `AGENT_LOAD_FAILED` / `AUTH_FAILED` / `RATE_LIMITED`）→ `failed`，
 *     `error.code` **原样保留 agents 的归因码**（`EvalRow.error.code` 是自由字符串，正是为它留的）。
 *
 * 注意**停止这一侧只有第一臂**：评分阶段的「停下来」只可能是用户点的「终止」——外层兜底超时
 * 随单行超时一起删除，`judgeStageAttempt` 的 catch 里只剩 `userAborted` 一条记账。
 *
 * 失败留一条 WARN（AGENTS.md 的日志表）。为什么不只靠上面那条行事件：事件日志是**行级**的，
 * 而运维看的是服务端日志——评分阶段反复失败如果只在抽屉里，排障时没有任何线索。
 *
 * 落终态时**一律带 `stage: 'judge'`**（2026-09-28）：这一路的失败全部发生在评分那一段，而两段失败落的
 * 行状态与归因码可以逐字相同（候选超时与评分超时都是 `timed-out` + `AGENT_TIMED_OUT`）——少了这一笔，
 * 事后复盘时读不出「刚才坏的是哪一段」。**它不参与任何按钮判定**（2026-09-28 晚间起两个「重跑」按钮
 * 的判据都不读 `error` / `error.stage`）：这一格是事实记录，不是控制流。
 */
function settleAgentJudgeStop(runId: string, rowId: string, error: JudgeAgentError): void {
  if (error.agentCode === 'AGENT_CANCELED') {
    settleStopped(runId, rowId, { status: 'canceled', error: null, exitReason: 'canceled', stage: 'judge' });
    return;
  }
  if (error.agentCode === 'AGENT_TIMED_OUT') {
    log.warn('评分阶段超时，按超时收尾', { runId, rowId, code: error.agentCode, message: error.message });
    settleStopped(runId, rowId, {
      status: 'timed-out',
      error: { code: 'AGENT_TIMED_OUT', message: error.message },
      exitReason: 'timed-out',
      stage: 'judge',
    });
    return;
  }
  log.warn('评分阶段失败', { runId, rowId, code: error.agentCode, message: error.message });
  settleStopped(runId, rowId, {
    status: 'failed',
    error: { code: error.agentCode, message: error.message },
    exitReason: 'error',
    stage: 'judge',
  });
}

/**
 * 终止类结果的判定结果（也是 `runRowAttempt` 交回给 `runRow` 的失败面：
 * 候选阶段的 `failed` 与评分阶段的 `failed` 都以它出门，自动重试据此判定）。
 *
 * `stage`（2026-09-28 追加）是**这一笔失败发生在哪一段**，会随快照落进 `EvalRow.error.stage`：
 * 两段的失败落的行状态与归因码可以逐字相同，从终态本身读不出「是哪一段坏了」。
 * 它今天只用于**叙述与排障**（曾有版本靠它决定给「重新执行」还是「重新评分」，那次判定已取消）。
 * 两条产出路径各自给值：`classifyStop` 恒为 `agent`（它只在候选阶段被调用），
 * `settleAgentJudgeStop` 恒为 `judge`。
 */
interface RowOutcome {
  status: 'canceled' | 'timed-out' | 'failed';
  error: EvalRow['error'];
  exitReason: string;
  /** 失败发生在哪一段（`canceled` 没有 error，这一格只为 `failed` / `timed-out` 服务） */
  stage: RowFailureStage;
}

/**
 * 判定终止类结果（2026-09-28 收窄到「用户终止」这一条）：
 *   用户终止 → `canceled`；适配器违约（`run()` 抛了）→ `failed`；适配器自报的 `exitReason` 照它的来。
 * 返回 null 表示「正常完成」，交给评分阶段。
 *
 * **原来这里有三档：用户终止 > 外层兜底超时 > 适配器自报**。删掉单行超时之后中间的兜底档消失，
 * 于是「一行既不正常完成、又没被用户终止」只可能是适配器自己收场（失败或违约）。
 * `result === null && agentError === null` 现在**不可达**（`Promise.race` 的另一条腿已经删掉，
 * 唯一的 `null` 来源是适配器违约时 `agentError` 非空）——留着它是纵深防御：真出现时按 `failed`
 * 归因，绝不再冒充「超时」（那个方向会让人去调一个已经不存在的超时设置）。
 * 「适配器抛了、但同时也被用户终止」由第一行的 userAborted 覆盖：用户意图优先。
 */
function classifyStop(input: {
  userAborted: boolean;
  result: AgentRunResult | null;
  agentError: ServiceError | null;
}): RowOutcome | null {
  if (input.userAborted) return { status: 'canceled', error: null, exitReason: 'canceled', stage: 'agent' };
  // 适配器违约（契约说 run() 返回 ok:false，不抛）：它比「没拿到结果」更具体，优先归因
  if (input.agentError !== null) {
    return {
      status: 'failed',
      error: {
        code: input.agentError.code,
        message: input.agentError.message,
        ...(input.agentError.stack === undefined ? {} : { stack: input.agentError.stack }),
      },
      exitReason: 'error',
      stage: 'agent',
    };
  }
  if (input.result === null) {
    // 不可达的纵深防御（见函数头）：没有内层/外层超时了，唯一的 null 来源是上面的违约分支
    return {
      status: 'failed',
      error: { code: 'AGENT_FAILED', message: '智能体既没有返回结果、也没有报错（适配器违约）' },
      exitReason: 'error',
      stage: 'agent',
    };
  }
  const { result } = input;
  if (result.exitReason === 'canceled') {
    return { status: 'canceled', error: null, exitReason: 'canceled', stage: 'agent' };
  }
  if (result.exitReason === 'timed-out') {
    // 只剩**适配器自报**这一条路（本层已无任何超时）：照它的归因落地，界面上的处置看 error.code
    return {
      status: 'timed-out',
      error: { code: 'AGENT_TIMED_OUT', message: '适配器自报的运行超时' },
      exitReason: 'timed-out',
      stage: 'agent',
    };
  }
  if (!result.ok || result.exitReason === 'error') {
    // 适配器违约（ok:false 却没给 error）也要给出可读归因，不能让界面显示空白原因
    const detail = result.error;
    return {
      status: 'failed',
      error:
        detail === undefined
          ? { code: 'AGENT_FAILED', message: '智能体执行失败（适配器未给出原因）' }
          : { code: detail.code, message: detail.message, ...(detail.stack === undefined ? {} : { stack: detail.stack }) },
      exitReason: 'error',
      stage: 'agent',
    };
  }
  return null;
}

/**
 * 清掉这一行的在途状态：控制器、「终止原因」的记账与「落终态的唤醒器」，避免长驻进程里累积。
 *
 * 三个条目是**同一条生命周期**（一次行任务：从控制器登记到任务收尾），所以同处清理。
 * 调用点**四处**（评审 Minor-2，此前这里只写了两处）：
 *   · 清理：`runRow` 的 finally（完整跑一行：候选 + 评分）与 `rescoreRow` 任务自己的 finally（重评）；
 *   · **入口区回退**另有两处（`retryRow` / `rescoreRow` 的 entry `catch`）：那三步（落状态 → 起任务）
 *     中途抛时任务压根没起来，抹掉痕迹＝「什么都没发生」——对唤醒器同样成立（那两处还没有人登记过它，
 *     删的是空条目，幂等无副作用）。
 *
 * `terminalWaiters` 为什么也在这里（2026-10-07 修正）：它此前挂在候选阶段那个 `Promise.race` 的
 * finally 上，而候选跑完**评分才刚开始**（`runRowAttempt` 第 7 步）——于是评分阶段拿到的那个
 * `terminalReached` 成了一条没人唤醒的 promise（匹配到这次的缺口：适配器在评分阶段不理 abort 时，
 * 用户终止后这一行照样收不了场）。唤醒器必须活到**整次行任务**结束，而这里正是那个边界。
 *
 * ⚠️ **清理点必须在这里，别挪回行任务中途**（候选阶段那个 finally 曾经这么干过，2026-10-07 那条缺陷
 * 就是它）：唤醒器一被提前摘掉，评分阶段手上那条 `terminalReached` 就是**死 promise**——race 永远不会被
 * 「终止」赢下，用户按了终止这一行仍挂在评分调用上。`runRowAttempt` 与 `rescoreAttempt` 两处同理。
 */
function clearRowRuntime(runId: string, rowId: string): void {
  const key = rowKey(runId, rowId);
  rowAborts.delete(key);
  userAborted.delete(key);
  terminalWaiters.delete(key);
}

/**
 * 落一个终止类终态。**终态优先**：abortRun / abortRow 是同步落库的，在途任务稍后带着
 * 终止结果回来时不能再写一次状态（用户明明按了终止，几秒后状态跳回 timed-out 是最难解释的行为）。
 *
 * 失败（`failed`）时与 `settleFailed` 同口径补发一条 `error` 事件：事件日志是唯一真相源（F14），
 * 「这一类失败有 error、那一类没有」会让日志抽屉里缺掉原因——适配器违约与 `ok:false` 都属这一类。
 * 顺序也与 `settleFailed` 一致：error 先于终态 status，`end` 收尾（评审 L2）。
 *
 * 落库时把 `outcome.stage` 拼进 `error.stage`（2026-09-28）：`canceled` 没有 error，其余两种终态
 * 都带上「失败发生在哪一段」——它是排障时最常问的那个问题的事实记录（不参与任何按钮判定）。
 */
function settleStopped(runId: string, rowId: string, outcome: RowOutcome): void {
  const { row } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(row.status)) {
    log.debug('行已被同步终止，执行侧不再改状态', { runId, rowId, status: row.status });
    return;
  }
  if (outcome.status === 'failed' && outcome.error !== null) {
    publishRowEvent(runId, rowId, {
      type: 'error',
      message: `${outcome.error.code}：${outcome.error.message}`,
      ...(outcome.error.stack === undefined ? {} : { stack: outcome.error.stack }),
    });
  }
  // 只有真的有 error 时才落 stage：`canceled` 的 error 是 null，多挂一个「失败阶段」是假语义
  const error = outcome.error === null ? null : { ...outcome.error, stage: outcome.stage };
  setRowStatus(runId, rowId, outcome.status, { error });
  publishRowEvent(runId, rowId, { type: 'end', exitReason: outcome.exitReason });
}

/**
 * 把一行落成 `failed`（终态优先，理由同 settleStopped）。
 *
 * `stage` 由**调用方显式给出**（2026-09-28）：这一条路接收的是抛出来的 `ServiceError`，
 * 而同一个错误对象既可能来自候选阶段（准备失败 / git 不可达），也可能来自评分阶段
 * （评分配置缺失 / `JUDGE_PARSE_FAILED`）。判据只有调用方知道，本函数不猜。
 */
function settleFailed(
  runId: string,
  rowId: string,
  error: ServiceError,
  durationMs: number | null,
  stage: RowFailureStage,
): void {
  publishRowEvent(runId, rowId, {
    type: 'error',
    message: `${error.code}：${error.message}`,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  });
  const raw = rawFromContext(error.context);
  if (raw !== null) {
    // 评分解析失败时把模型原文摊进日志：日志抽屉是唯一能回答「是提示词的问题还是模型的问题」的地方（§5.7）
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stderr', text: `评分模型原始返回（截断）：\n${raw}` });
  }

  const { row } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(row.status)) {
    log.warn('候选行已是终态，错误只记入事件日志、不改状态', { runId, rowId, status: row.status, code: error.code });
    return;
  }
  setRowStatus(runId, rowId, 'failed', {
    error: { code: error.code, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }), stage },
    durationMs: row.durationMs ?? durationMs,
  });
  publishRowEvent(runId, rowId, { type: 'end', exitReason: 'error' });
}

/**
 * 跑一行并**保证它离开在途集合**：所有失败都在这里折成终态（F12 的失败隔离在行这一级落地）。
 * 唯一可能停在非终态的情况是「连落盘都失败」（磁盘满 / 目录被删），那种情况会打 ERROR。
 *
 * **自动重试**（2026-09-27 追加）：失败面是**瞬时**的（`shouldRetryFailedRow`）就在同一次调用里
 * 再跑一遍整行，最多 `ROW_RETRY.maxRetries` 次。
 * 为什么把重试放在这一层而不是 `startRun` 那一层（外层重试）：
 *   · 这一层的 finally 已经保证「离开在途集合」，重试循环跑在同一段生命周期里，
 *     行的状态机不需要新增状态（仍是 `failed → preparing → running`）；
 *   · 外层重试要么自己再造一套记账，要么让 `executeRun` 的串行队列提前推进（队列在等 promise），
 *     两条都比这里复杂。
 * 与「单个评测项重新执行」的手动出口（`retryRow`）共用同一个执行体 `runRowAttempt`：
 * 自动重试是同一件事的自动版，两处各写一份必然漂移。
 *
 * **留痕落在两个地方，缺一不可**（2026-09-27 实测补的）：
 *   · 该行**事件日志**：本次尝试的过程（每次尝试开始时被 `resetEvents` 清空）；
 *   · 该行**尝试账本**（`attempts.jsonl`，追加、永不清空）：第 N 次尝试的开始与结局——
 *     否则「已重试 5 次」在日志抽屉里一条证据都没有（实测就是这个症状：`attempts = 6`，
 *     而事件日志里零条重试记录）。
 */
export async function runRow(runId: string, rowId: string): Promise<void> {
  try {
    for (let attempt = 0; ; attempt += 1) {
      let failure: RowFailure | null = null;
      let outcome: 'judged' | 'failed' | 'stopped' | 'skipped' = 'judged';
      appendAttemptRecord(runId, rowId, { attempt: attempt + 1, phase: 'start' });
      try {
        // `outcome` 为 null = 这一行已经**成功**落终态（judged）或被终止后跳过，不该再有任何动作；
        // 非 null = 它落了 failed，由下面决定要不要自动重试
        const settled = await runRowAttempt(runId, rowId);
        if (settled === null) {
          appendAttemptRecord(runId, rowId, { attempt: attempt + 1, phase: 'end', outcome: rowStatus(runId, rowId) });
          return;
        }
        failure = rowFailureOf(settled);
        outcome = 'failed';
      } catch (caught) {
        const serviceError = toServiceError(caught);
        /**
         * 这一笔失败发生在哪一段（2026-09-28）：`runJudgeStage` 的**第一件事**就是把状态落成
         * `judging`（评分配置缺失 / 解析失败 / 评分智能体起不来都发生在它之后），故「此刻的状态
         * 是不是 `judging`」就是这一段最便宜的判据——抛异常这条路上，阶段信息本来已经丢了。
         * 读不到快照时 `rowStatus` 给 `skipped` ⇒ 判成 `agent`：把「不确认」归到**不给重新评分**
         * 那一侧（宁可少给一个按钮，也不给一个会跑错段的按钮，与 `canRescoreRow` 同一条口径）。
         */
        const stage: RowFailureStage = rowStatus(runId, rowId) === 'judging' ? 'judge' : 'agent';
        failure = { code: serviceError.code, message: serviceError.message };
        outcome = 'failed';
        log.error('候选行执行失败', { runId, rowId, code: serviceError.code, message: serviceError.message, stage });
        try {
          settleFailed(runId, rowId, serviceError, null, stage);
        } catch (secondary) {
          appendAttemptRecord(runId, rowId, {
            attempt: attempt + 1,
            phase: 'end',
            outcome: 'failed',
            code: serviceError.code,
            message: '落 failed 也失败（该行可能停在非终态）',
          });
          log.error('落 failed 也失败（该行可能停在非终态）', {
            runId,
            rowId,
            reason: toServiceError(secondary).message,
          });
          return; // 连落盘都失败：重试只会再撞一次同一堵墙
        }
      }

      const willRetry = attempt < ROW_RETRY.maxRetries && shouldRetryFailedRow(runId, rowId, failure);
      appendAttemptRecord(runId, rowId, {
        attempt: attempt + 1,
        phase: 'end',
        outcome,
        code: failure.code,
        message: failure.message,
        ...(willRetry ? { retrying: true } : {}),
      });
      if (!willRetry) return;

      // 重试要留痕：既写事件日志（用户看得到），也写服务端 WARN（运维看得到）——
      // 自动重试若静默，使用者只会看到「这一行莫名其妙慢了三倍」
      const next = attempt + 1;
      log.warn('候选行瞬时失败，准备自动重试', {
        runId,
        rowId,
        attempt: next,
        maxRetries: ROW_RETRY.maxRetries,
        code: failure.code,
      });
      try {
        publishRowEvent(runId, rowId, {
          type: 'log',
          stream: 'stderr',
          text:
            `[编排] 该行判定为瞬时失败（${failure.code}：${failure.message}），` +
            `将在 ${ROW_RETRY.delayMs} ms 后自动重试第 ${next}/${ROW_RETRY.maxRetries} 次`,
        });
      } catch (publishError) {
        // 事件写不进去不该挡住重试本身（与耗时心跳同一处置：日志是锦上添花，终态那一次才权威）
        log.warn('自动重试的事件写入失败（重试本身照常进行）', {
          runId,
          rowId,
          reason: toServiceError(publishError).message,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, ROW_RETRY.delayMs));
      // 重试前复检用户意图：等待期间用户按了「终止」⇒ 该行已是终态，重试必须让位
      if (!shouldRetryFailedRow(runId, rowId, failure)) return;
    }
  } finally {
    clearRowRuntime(runId, rowId);
  }
}

/**
 * 一次**失败**的行级归因（`runRow` 的自动重试只看它的 `code`）。
 * 为什么不复用 `ServiceError`：候选 / 评分阶段的失败是 `RowOutcome` 带回来的（`settleStopped`
 * 那条路，不是抛异常），把它硬塞进 `ServiceError` 就得给一个假的契约错误码
 * （`AGENT_FAILED` 不在 `ERROR_CODES` 里）——那会让日志与重试判据都建立在一个编造的值上。
 * `code` 因此是**自由字符串**：它同时承载 agents 的 `AgentErrorCode` 与契约的 `ErrorCode`
 * （与 `EvalRow.error.code` 同一口径）。
 */
interface RowFailure {
  code: string;
  message: string;
}

/** `RowOutcome` → `RowFailure`：`error` 为空时给一句可读的兜底原因（界面与日志都不该出现空白） */
function rowFailureOf(outcome: RowOutcome): RowFailure {
  return {
    code: outcome.error?.code ?? 'AGENT_FAILED',
    message: outcome.error?.message ?? '该行执行失败（编排层未给出原因）',
  };
}

/**
 * 尝试账本的一条记录（落 `{rowDir}/attempts.jsonl`，**追加、永不清空**）。
 *
 * 为什么要有它：`events.jsonl` 是「**当前这一次**尝试」的日志（每次尝试开始都被 `resetEvents` 清空），
 * 于是自动重试的记录会被后一次尝试连文件一起删掉——实测症状是那一行 `attempts = 6`、
 * 而日志抽屉里**零条**重试记录：界面说「已重试 5 次」，日志里查不到任何一次。
 * 这份账本是**累计**的，与 `EvalRow.attempts` 同口径（回答「走过几次」，不是「当前是哪一次」）。
 *
 * 不放进 `AgentEvent` 契约：它是**编排层**的记账，不是行执行过程里的事件；塞进事件流还会让
 * 「事件日志 = 当前尝试」这条语义失效（那正是本文件要保住的东西）。读侧（界面）暂不消费它。
 */
interface AttemptRecord {
  /** 这一行的第几次尝试（从 1 开始，与 `EvalRow.attempts` 同源） */
  attempt: number;
  phase: 'start' | 'end';
  /** 结局（只有 `phase: 'end'` 有）：与 `EvalRow.status` 同口径 */
  outcome?: EvalRowStatus;
  /** 失败归因（只有失败时有）：与 `EvalRow.error.code` 同口径 */
  code?: string;
  message?: string;
  /** 这一条之后还会自动重试（`phase: 'end'` 且判定为瞬时失败时） */
  retrying?: boolean;
}

/**
 * 追加一条尝试记录。**写失败只记 WARN，绝不上抛**：
 * 账本是「让排查看得见」的辅助产物，而它挂在候选执行的关键路径上——为它中断一次真实执行
 * 是本末倒置（与耗时心跳同一处置：日志是锦上添花，终态那一次写入才权威）。
 */
function appendAttemptRecord(
  runId: string,
  rowId: string,
  record: Omit<AttemptRecord, 'at'> & { at?: string },
): void {
  try {
    const { run } = requireRow(runId, rowId);
    const file = rowAttemptsFile(run.workspaceBase, runId, rowId);
    mkdirSync(join(file, '..'), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8');
  } catch (error) {
    log.warn('尝试账本写入失败（不影响本次执行）', {
      runId,
      rowId,
      reason: toServiceError(error).message,
    });
  }
}

/** 读该行**当前**的快照状态（账本记「结局」用；读不到就给 skipped，绝不猜一个好看的） */
function rowStatus(runId: string, rowId: string): EvalRowStatus {
  try {
    return requireRow(runId, rowId).row.status;
  } catch {
    return 'skipped';
  }
}

/**
 * 「这一次失败值不值得自动重跑整行」——判据有两半，**缺一不可**：
 *   ① 错误码在 `TRANSIENT_ROW_RETRY_CODES` 里（瞬时面）；
 *   ② 该行此刻**仍然是那个失败终态**（`failed`），且没有被用户终止 / 没有正在跑别的执行。
 * ② 不是多余的：等待退避的那几秒里用户可能按了「终止」（行 → `canceled`）或点了「重新执行」
 * （行 → `preparing`）——此时再跑一遍会与那一件事抢同一行（两条执行同时改状态）。
 * 读的是**磁盘上的当前快照**（`getRunForWrite`），不是循环开始时的缓存。
 */
function shouldRetryFailedRow(runId: string, rowId: string, failure: RowFailure): boolean {
  if (!TRANSIENT_ROW_RETRY_CODES.includes(failure.code)) return false;
  try {
    const { row } = requireRow(runId, rowId);
    return row.status === 'failed';
  } catch (readError) {
    // 快照读不到（目录被删 / 工作区根被改走）⇒ 不重试：连状态都读不到的时候只能收手
    log.warn('判定是否自动重试时读快照失败，放弃重试', {
      runId,
      rowId,
      reason: toServiceError(readError).message,
    });
    return false;
  }
}

/**
 * 跑一行的完整过程：spec §5.5 的八步。
 * 前三步（建工作区 / 取基线 / 注入隔离配置）由 `core.prepareRowWorkspace` 一次完成；
 * 「注入隔离配置」在本层只体现为把 `configHome` 交给适配器——真正写环境变量的是适配器
 * （§5.6.5 的三条不变量：本仓任何地方都不写 `process.env`）。
 *
 * 为什么先落 `preparing` 再让出事件循环、最后才复制工作区：复制是同步重活，放在调用方
 * （`startRun`）的调用栈里会让「开始」这个请求卡住整段复制时长（并行 6 行就是 6 倍），
 * 而界面在此期间连一个状态变化都看不到。
 *
 * **返回值**（2026-09-27）：`null` = 这一行已经**正常落定**（出了分 / 被终止 / 被跳过），
 * 不该再有任何后续动作；`RowOutcome` = 它落了 `failed`，由调用方（`runRow`）决定要不要自动重试。
 *
 * 为什么失败**必须**以返回值交出去、而不是在这里直接落终态：候选 agent 的失败走的是
 * `classifyStop` → `settleStopped`（那条路上有「终态优先」的记账），它与「抛异常」是两条路，
 * 但对外都是「这一行 failed」。原来的实现只在**抛异常**那条路上让 `runRow` 拿到错误，
 * 于是候选 agent 的失败（`AGENT_FAILED` 等）**永远不会被自动重试**——而这恰恰是最常见的一类
 * （目标页实测的上游瞬时不可用就是这个形状）。返回 `RowOutcome` 把两条路收成同一条。
 *
 * 「被终止」返回 `null` 是刻意的：重试一个用户刚杀掉的行是对用户意图的违抗。
 */
/**
 * 从供应商清单里取该模型的窗口两格（spec §4.2 / D1）。
 * 条目缺失或没声明 ⇒ **空对象**（不是 `{ contextWindow: undefined }`）：适配器一律用 `undefined` 判「未知」，
 * 而多一个「值为 undefined 的键」会让 `'contextWindow' in route` 这类判据给出相反结论。
 */
function contextOf(provider: Provider, modelId: string): { contextWindow?: number; maxOutputTokens?: number } {
  const model = provider.models.find((item) => item.id === modelId);
  if (model === undefined) return {};
  return {
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
  };
}

async function runRowAttempt(runId: string, rowId: string): Promise<RowOutcome | null> {
  const { run, row } = requireRow(runId, rowId);
  // **`preparing` 也算「可执行」**（2026-09-27，单行重新执行接入时发现）：
  // `retryRow` 为了让 HTTP 立刻拿到「已经在准备中」的快照，会先把状态落成 `preparing`，
  // 再异步起 `runRow`——而 `isRunnableRow('preparing')` 是 **false**（它属于「在途」，
  // 见 contracts 的 `isRunningRow`）。只看 `isRunnableRow` 的写法会让重新执行**永远什么都不做**：
  // 状态停在 `preparing`、终态永不落、界面上的「终止」按钮一直亮着（实测症状）。
  // 为什么放行它是安全的：走到这里的状态只可能来自两条路——`startRun`（它只挑
  // `isRunnableRow` 的行）与 `retryRow`（它已经把「正在运行中」的行拒掉了）。
  // 真正的「已被终止 / 已结束」由下面那两处 `TERMINAL_ROW_STATUSES` 复检拦下，那一层一个字都没动。
  if (!isRunnableRow(row.status) && row.status !== 'preparing') return null; // 已被终止或已结束：什么都不做

  const config = loadConfig();
  const settings = config.settings;
  const testCase = readCase(run.caseId);
  if (testCase === null) {
    // §4.4 允许删用例后评测仍可读，但「跑」必须有题面——题面**没有**快照进 run.json
    // （评分表已经快照了：`EvalRunSchema.rubric`，见 run.ts）
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法执行该行；历史记录仍可查看`);
  }
  const providerRecord = config.providers.find((item) => item.id === row.providerId);
  if (providerRecord === undefined) {
    throw new ServiceError('CONFLICT', `供应商已删除（${row.providerId}），该行无法执行；请重建供应商后新建评测`);
  }
  const agentProvider = getProvider(row.agentKind);
  if (!acceptsProtocol(agentProvider.metadata, providerRecord.protocolType)) {
    // F2 的过滤在创建评测时已拦一次；这里再拦一次，因为供应商的协议可能在创建之后被改过
    throw new ServiceError(
      'CONFLICT',
      protocolMismatchMessage({
        agentLabel: AGENT_LABELS[row.agentKind],
        accepted: agentProvider.metadata.protocolTypes,
        subject: `供应商「${providerRecord.name}」的模型`,
        actual: providerRecord.protocolType,
      }),
    );
  }
  if (providerRecord.baseUrl !== row.baseUrl) {
    // 快照用于追溯、当前配置用于执行：改了地址后重跑应当用新地址，但差异必须留痕
    log.warn('行的 baseUrl 快照与供应商当前配置不一致，本次执行使用当前配置', {
      runId,
      rowId,
      snapshot: row.baseUrl,
      current: providerRecord.baseUrl,
    });
  }

  // 重跑同一行前清空事件日志：新旧事件混在一个文件里，seq 与时间线都会对不上
  resetEvents(rowEventsFile(run.workspaceBase, runId, rowId));
  // 记录日志（消息与子任务行）同一条口径：它记的也是「当前这一次尝试」的对话
  resetRecords(rowMessagesFile(run.workspaceBase, runId, rowId));
  /**
   * **评分那两份产物同一条口径**（2026-10-10）：它们记的也是「当前这一次尝试」的评审过程。
   * 不清的话，重评之后 `judge-events.jsonl` 里会留着上一次评审的流水，而它的 `seq` 从 1 起的假设
   * （`appendEvent` 按文件续号）当场失效——新一轮的事件会接着旧号往下发，
   * 任何「按 seq 续订」的消费方都会把两轮评审读成一整条时间线。
   */
  resetEvents(rowJudgeEventsFile(run.workspaceBase, runId, rowId));
  resetRecords(rowJudgeMessagesFile(run.workspaceBase, runId, rowId));

  /**
   * 这一行的**流式增量观测**（2026-10-09）：增量帧只广播不落盘 ⇒ 「这次到底有没有真的收到逐字流」
   * 事后在文件里找不到任何痕迹，而它恰恰是「界面为什么不打字」的唯一判据（厂商声明说是 `yes`，
   * 但开关没生效 / 插件没挂上时也是 `yes`）。故在这里数两份事实，收尾时写进 `EvalRow.streamingDelta`：
   *   · `frameCount`：转给实时通道的增量帧数——**`0` 与「没数过」必须分得开**（后者是格缺席）；
   *   · `lastFrameChars`：最后一帧的累积正文字符数，给**中断行**回答「它当时写到哪」。
   * 注意这里数的是**归一后的帧**，不是厂商原始 chunk：三家的切片粒度不同，跨家比这个数没有意义。
   */
  const streamingDelta = { frameCount: 0, lastFrameChars: 0 };

  // `attempts` **累加**而不是重置成 1（2026-09-27）：这一格回答的是「这一行走过几次尝试」
  // （含自动重试与用户点的「重新执行」），而每次进入本函数恰好就是一次尝试。
  // 与其它几格（分数 / 计量 / diff）刻意不同：那些是「本次尝试的产出」，必须清零；
  // 尝试次数是**累计事实**，清零会让「试了三次才成功」重新看起来像「一次就成功」。
  setRowStatus(runId, rowId, 'preparing', {
    error: null,
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    attempts: row.attempts + 1,
  });
  await yieldToEventLoop();

  // **第一次复检**（评审 High-1）：`preparing` 在 `isRunningRow` 眼里就是「在途」（契约 §5.3），所以用户
  // 在这个窗口里按终止是**合法且同步**的——`abortRun` / `abortRow` 会把这一行立刻落成 `canceled` 并写一条
  // `end`。而让出事件循环**之前**没得复检（那时终止还没发生），让出之后必须复检：不复检就会继续走完
  // prepare → 注册 controller（此刻 abort 早已错过，新建的 signal 不是 aborted）→ 无条件
  // `setRowStatus('running')` 把快照从 `canceled` **复活**成 `running`、agent 真的被启动，收尾再写
  // **第二条 `end`**——「终态优先」（实现层修正第 5 条）在这个窗口内失效，且「点了开始马上点终止」必落进来
  // （`startRun` 的同步前缀把并行行全部推到 `preparing` 之后才返回）。命中终态就直接返回：不建工作区、
  // 不改状态、不发事件。
  const { row: afterYield } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(afterYield.status)) {
    log.debug('行已在准备阶段被终止，不再执行', { runId, rowId, status: afterYield.status });
    return null;
  }

  // 第 1 步：用例级缓存仓库 —— 由 prepareRowWorkspace 内部调用（见本节第 12 条与契约 §3.3/R28），
  // 编排层**不要**再单独调一次：两参数形式落在 commitHash=null 分支上，会逐行刷新缓存，
  // 且源仓库不可达时会直接抛 NOT_A_GIT_REPO（哪怕该行的 commit 已在缓存里）。
  // 第 2、3 步：复制缓存 → checkout 基线 → 建 test/{rowId} 分支 → 建该行独立的 .agenthome
  //
  // 远端来源先在这里被物化成「本地镜像路径 + 具体 40 位 hash」（spec §6.6，RG7）：
  // core 的 ensureCaseCache / copyWorkspace / checkoutRow / collectDiff 一行都不改，它们只认本地路径。
  const branch = `test/${rowId}`;
  const source = parseRepoSource(run.repoPath);
  let preparedRepoPath: string;
  let preparedCommit: string | null = run.commitHash;
  if (source.kind === 'local') {
    preparedRepoPath = source.path;
  } else {
    // 就绪即复用（不联网）：本轮**唯一**一次联网在下面的 resolveRemoteRef 里
    const mirror = ensureMirror({ workspaceRoot: run.workspaceBase, url: source.url });
    // 分支 tip 在这一步被重新解析（spec §6.7）：这是「跟随分支」与「钉死 commit」的分岔点，
    // 也是「来源不可达就失败、绝不静默沿用旧镜像」的落点（fetch 在这一步内部发生，失败即抛）。
    // `repoBranch` 为 null 时跟的是**远端此刻的默认分支**：这次 fetch 之后镜像 HEAD 会被对齐到
    // 远端当前的默认分支（core 的 alignDefaultBranch），所以远端改了默认分支名这一行也跟得上。
    // 给 prepareRowWorkspace 传**具体 hash** 而不是 null：镜像刚 fetch 过，用例缓存只需从镜像取对象，
    // 不走 ensureCaseCache 的「刷新到来源 HEAD」分支（那条读的是**本地** HEAD 语义）。
    // `run.repoBranch ?? null`：编排层读的是磁盘上的快照，而 `EvalRunSchema` 给这一列的是
    // `.default(null)`（旧 run.json 里根本没有这一列，读出来已经是 null）——所以 `?? null` 是**防御性的**，
    // 拦的是「有人绕过 schema 直接塞了一份 run 对象」这条路，不是在补 schema 的缺口
    preparedRepoPath = mirror.mirrorDir;
    preparedCommit = resolveRemoteRef(mirror.mirrorDir, source.url, {
      branch: run.repoBranch ?? null,
      commitHash: run.commitHash,
    });
  }
  const prepared = prepareRowWorkspace({
    workspaceRoot: run.workspaceBase,
    caseId: run.caseId,
    repoPath: preparedRepoPath,
    runId,
    rowId,
    commitHash: preparedCommit,
    branch,
  });
  patchRow(runId, rowId, {
    workspacePath: prepared.workspacePath,
    branch,
    baselineCommit: prepared.baselineCommit,
  });

  const key = rowKey(runId, rowId);
  const controller = new AbortController();
  rowAborts.set(key, controller);
  /**
   * 「这一行落终态」的唤醒器（见 `terminalWaiters`）。它**不是时间上限**：只有用户终止（或别的
   * 路径真的把这一行写成终态）才会 resolve。所以两个 `Promise.race` 都不会凭空截断一次正常运行，
   * 它解决的是「用户已经看到『已终止』，而轮级状态还挂在 running」这件事。
   * **两个消费者**（同一次行任务里前后两段都可能无限等待）：候选阶段的 `runPromise` 与评分阶段的
   * `input.attempt`（后者经 `JudgeStageContext.terminalReached` 传进去）——评分那一段是 2026-10-07
   * 补的，此前只有候选那一个 race（适配器在评分阶段不理 abort 时，这一行照样收不了场）。
   * 注册点紧跟控制器：从这一刻起，任何一次 `setRowStatus(终态)` 都能唤醒这一次任务。
   */
  let wakeOnTerminal: (() => void) | undefined;
  const terminalReached = new Promise<'terminal'>((resolve) => {
    wakeOnTerminal = () => resolve('terminal');
  });
  terminalWaiters.set(key, () => wakeOnTerminal?.());
  const startedAt = Date.now();

  // 第 4 步：跑智能体（**没有任何上限**：用户口径 2026-09-28「执行不限时间」——
  // 内层交给适配器自己收场，外层不再起兜底定时器，停止只可能来自用户点「终止」）
  // **第二次复检**（评审 High-1 的最小修法要求两处都在）：准备阶段是同步重活，Node 单线程下这里插不进
  // 第三方改动，但这条不变式不该只靠「当前这一段恰好没有 `await`」这个巧合——将来有人在中间补一个
  // `await`（例如把复制改成异步），这里就是唯一的拦截点：命中终态就不再启动智能体、不改状态、不发事件。
  const { row: beforeRun } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(beforeRun.status)) {
    log.debug('行在准备期间被终止，不再启动智能体', { runId, rowId, status: beforeRun.status });
    return null;
  }
  setRowStatus(runId, rowId, 'running');
  // 跑动期的耗时心跳（见 ROW_HEARTBEAT_MS 的注释）：只写 durationMs 一项，终态那一次写入会覆盖它。
  // 它是**进度**、不是上限：执行不限时间，心跳照走，界面上的秒表才不会看起来卡住。
  const heartbeat = setInterval(() => {
    try {
      patchRow(runId, rowId, { durationMs: Date.now() - startedAt });
    } catch (error) {
      // 心跳是「锦上添花」的写入——终态那一次才是权威值。而它跑在定时器回调里，
      // 抛出的异常**没有任何调用方能接住**：实测全量测试里因此冒出 573 条未捕获
      // `ServiceError: 评测不存在`（vitest 警告「可能造成假阳/假阴」），生产上则可能打崩进程。
      // 触发条件都真实存在：快照被清理、工作区根目录被改走、磁盘满。
      // 处置：**自停**（不再反复尝试），终态写入与失败归因照常走。
      // 为什么记 DEBUG 而不是 WARN：① 真正的故障会在收尾那一次写入上以 ERROR 现身
      //（`runRow` 的二级 catch 打的就是 ERROR），这里不丢信息；② 本仓有用例故意让
      // `console.warn` 抛错来验证释放顺序（见 claude-code/index.ts 的注释），
      // 一个后台定时器在那些用例里响 WARN 会把它们整条顶掉。
      stopRowHeartbeat(key);
      log.debug('耗时心跳写入失败，已停止这一行的心跳（终态写入与失败归因不受影响）', {
        runId,
        rowId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }, ROW_HEARTBEAT_MS);

  // 登记到行级心跳表：`setRowStatus` 落终态（用户终止）时会**当场**把它拆掉，不再等这里收尾
  // （见 `rowHeartbeats` 的注释）。先拆一次旧的：一次尝试只有一个心跳，真出现重入时留着旧的，
  // 它会在本次尝试期间继续写这一行的耗时——数字往后跳，而没有任何报错。
  stopRowHeartbeat(key);
  rowHeartbeats.set(key, { timer: heartbeat, startedAt });

  // 行判定终态之后，适配器收尾期间吐出来的迟到事件不再落盘（它们会把「已结束」的日志拖长）
  let settled = false;
  /**
   * 跑动期用量的回写口径（A2 起**按每一条事件自己的性质**，不再按整家的静态声明——那是
   * `capability.liveUsage` 的最后一处消费点，删掉它之后包外不再读 agents 的任何能力格）：
   *   · `tokens`：**只有显式声明「厂商上报」的那一条**（`tokensBasis === 'reported'`）才写快照。
   *     `'estimated'`（claude-code 的跑动期估算）与**整格缺席**（老适配器 / 第三方 provider 直接
   *     发事件）一律不写——缺省的判据落在安全侧，见 contracts 的 `tokensBasis` 注释。估算进快照会
   *     让崩溃 / 被杀的行看起来像「采到了计量」，而快照是唯一落盘真相；
   *   · `turns` 与子智能体两格：**恒回写**（它们只有权威形态，契约里没有对应的估算标记）。
   *     旧口径把这三格一起挡掉，于是「估算的家」连轮次都看不到——这是一次**有意的行为变更**。
   *
   * **不写 ≠ 清空**：这一段的每一格都是「不满足条件就整格不进 `patchRow`」⇒ 保持原值。
   * 一条只带轮次的 usage 事件不该把快照里已经采到的 tokens 抹成 null
   * （那会让界面上的 tok 从有数掉回「采集中」）。
   */
  const onEvent = (event: AgentEvent): void => {
    // 两道闸门：本行任务已落定、或**行已被判定终态**（用户终止 / 另一条路径已经收尾，见 `settledRows`）
    if (settled || isRowSettled(runId, rowId)) return;
    publishRowEvent(runId, rowId, event);
    // 「计量在跑的过程中逐步落库」（patchRow 的注释里承诺的就是这里）：权威值一到就写快照，
    // 于是列表、刷新后的页面、以及任何不接 SSE 的消费方都能在中途看到当前用量
    if (event.type !== 'usage') return;
    patchRow(runId, rowId, {
      turns: event.turns,
      /**
       * 子智能体那一份：**显式 `null` 要清**（`undefined` = 老事件缺这一格 ⇒ 保持原值）。
       * 为什么与 `tokens` 的处置不同：读失败时同一条事件的 `tokens` 已退回主会话口径，
       * 留着旧的偏大分量会让快照满足不了 `subagentTokens ≤ tokens`（spec §2.4 的不变量）。
       */
      ...(event.subagentTokens === undefined ? {} : { subagentTokens: event.subagentTokens }),
      /**
       * 轮次那一格的分量：与上面那一格**同一条规则**（显式 `null` 清、缺格保持）。
       * 两格分开写而不是合成一处：契约里它们是**两个**可选键，「这一条带了哪一个」由各家决定
       * （dsh 两格同刻，codex 只在收尾那一条上给），合成一处会让「只带了其中一格」变成
       * 「另一格被顺手清掉」。
       */
      ...(event.subagentTurns === undefined ? {} : { subagentTurns: event.subagentTurns }),
      // `tokens` 按这一条自己的来源：只有厂商上报值才落盘（估算与缺格都不写，见上面那段口径）
      ...(event.tokens !== null && event.tokensBasis === 'reported' ? { tokens: event.tokens } : {}),
    });
  };

  let result: AgentRunResult | null = null;
  let agentError: ServiceError | null = null;
  /**
   * 跑这一次适配器。**先挂一个 catch**：下面可能在「已经不再等它」之后才 reject（终止宽限用尽、
   * 或 `terminalWaiters` 先唤醒），而裸的孤儿 promise 会在 Node 上变成 unhandledRejection
   * （默认 `--unhandled-rejections=throw`，能打崩进程）——与 claude-code 里吞掉 `interrupt()`
   * 拒绝的那处是同一条理由。
   */
  const runPromise = agentProvider.run({
    cwd: prepared.workspacePath,
    configHome: prepared.agentHome,
    // 执行阶段给**全权限**（见 agents 的 `AgentPermission`）：候选要装依赖、跑测试，
    // 而「工作区可写」那类档位默认关掉网络，会让「改完自己验一遍」根本发生不了。
    permission: 'full',
    prompt: testCase.taskPrompt,
    // 强度按需带（spec §4.4 / D13）：行上没选就**不加这个键** —— 三家的实际语义各不相同
    // （2026-10-06 更正）：dsh 的适配器会给缺省档 `high`；claude / codex 不传、由厂商推断。
    // 传一个 undefined 会让某些 SDK 自己拼参数时出错，所以「没选」在这里就是**没有这个键**。
    ...(row.effort === undefined ? {} : { effort: row.effort }),
    route: {
      protocolType: providerRecord.protocolType,
      baseUrl: providerRecord.baseUrl,
      apiKey: providerRecord.apiKey,
      modelId: row.modelId,
      // 窗口从**供应商清单里当次读到的那一条**取（与 baseUrl 同口径：模型属性在运行时现读，不进快照）。
      // 条目缺失或没声明 ⇒ 空对象 ⇒ 三家都不注入（spec D8），绝不兜底一个数字。
      ...contextOf(providerRecord, row.modelId),
    },
    signal: controller.signal,
    onEvent,
    /**
     * 消息与子任务行（spec v3 §2）：**与事件同一条闸门与同一条落盘路径**——「行已终态」之后
     * 适配器收尾期间吐出来的迟到消息同样不落盘（理由与事件逐字相同：它们会把已结束的对话拖长）。
     * 落盘按块形态分叉（2026-10-09，用户口径「三家统一」）：
     *   · **快照**（`chunk === 'snapshot'`）→ `publishRowMessage`（`messages.jsonl` 唯一真相源 + 实时扇出）；
     *   · **增量**（`chunk === 'delta'`）→ `broadcastRowMessage`（**只扇出**，不进文件——块结束必有快照，
     *     delta 只是实时预告；落下来的中间态在折叠读侧全被盖掉，纯死重，见 `row-messages.ts` 的分叉注释）。
     * 增量这一支**顺手记账**（`streamingDelta`）：帧数与末帧字符数是这条通道事后唯一的痕迹。
     */
    onMessage: (message) => {
      if (settled || isRowSettled(runId, rowId)) return;
      if (message.chunk === 'delta') {
        streamingDelta.frameCount += 1;
        // 末帧累积正文长度：文本与思考块都算（签名/工具入参不进这条通道，故这里只有这两种块）
        streamingDelta.lastFrameChars = message.blocks.reduce(
          (total, block) => total + (block.type === 'text' || block.type === 'thinking' ? (block.text ?? '').length : 0),
          0,
        );
        broadcastRowMessage(runId, rowId, message);
        return;
      }
      publishRowMessage(runId, rowId, message);
    },
    /**
     * 子任务行与消息**共用一条记录流**（`messages.jsonl`，按 `type` 分流）：两者本来就来自同一条
     * 适配器回调，各开一份的代价是「一次运行要落两处、读两处，还得保证两处一致」。
     */
    onSubagent: (record) => {
      if (settled || isRowSettled(runId, rowId)) return;
      publishSubagentRecord(runId, rowId, record);
    },
  });
  runPromise.catch(() => {});
  try {
    const outcome = await Promise.race([runPromise, terminalReached]);
    /**
     * 已落终态（用户终止）之后：**再给适配器一个有限的交卷窗口**（`TERMINATION_GRACE_MS`）。
     *
     * 为什么要这一段（2026-09-28 真机实测的两难）：直接放弃的话，一行被终止时就拿不到适配器
     * 已经算出来的 `tokens`/`turns`（实测：同一个夹具下从 `turns=17 / 501k tok` 变成两个 null，
     * 界面上那一行由「轮次 17」退回「未采集」）；而无限等下去就是「轮级状态永远挂在 running」
     * （实测：适配器不响应 abort 时，一整轮卡在「执行中」，「开始」也被挡着）。
     * 这个窗口**不是执行上限**：它只在用户已经点过终止之后计时，且适配器**不响应停止信号**时
     * 也只是让这次收尾晚 5 秒——与 `turn.ts` 的释放宽限（`RELEASE_GRACE_MS`，同为 5 秒）同一条思路。
     * 等不到就按「未采集」收尾（`result === null`），绝不猜一个数出来。
     */
    result =
      outcome === 'terminal'
        ? await Promise.race([
          runPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), TERMINATION_GRACE_MS)),
        ])
        : outcome;
  } catch (error) {
    // 契约说 run() 返回 ok:false（不抛），但实现可能违例；违例也必须落成可读的 failed
    agentError = toServiceError(error);
  } finally {
    // 心跳的拆除点有**两个**（2026-10-06 修正）：`setRowStatus` 落终态时当场拆（用户终止那条路，
    // 它不能等适配器交卷），这里只是兜底——正常走到这里时表里已经没有这一行了（`stopRowHeartbeat` 幂等）。
    // 原先只有这一个拆除点，实测终止之后心跳又多活了两分钟（见 `rowHeartbeats` 的注释）。
    stopRowHeartbeat(key);
    // 唤醒器**刻意不在这里摘**（2026-10-07 修正）：这个 finally 收的是候选阶段，而紧接着第 7 步还要
    // 评分，那一段用的是**同一个** `terminalReached`（经 `JudgeStageContext` 传下去）——在这里摘掉，
    // 评分阶段就拿到一条没人唤醒的 promise，用户终止后这一行照样挂住。清理归 `runRow` 的 finally
    // （见 `clearRowRuntime`）：那才是「这一次行任务结束」的边界。
  }
  settled = true;
  const elapsedMs = Date.now() - startedAt;

  // 第 5 步：收集计量。采集不到就是 null，**绝不填 0**（§5.6.3：0 token 与「没采到」含义相反）
  const measured = {
    tokens: result?.tokens ?? null,
    turns: result?.turns ?? null,
    // 终态**必须**写这一格：codex 的子线程用量与 claude 的子智能体用量都只在收尾才知道，
    // 而收尾那条 usage 事件会在几毫秒后被这里的 patchRow 覆盖（见 TurnFinalize 的注释）
    subagentTokens: result?.subagentTokens ?? null,
    // 轮次那一格的分量同理（2026-10-04）：codex 的子线程轮次只在收尾并进合计，
    // 只在事件里给数的话这一格会被这一次写入盖掉（真值在 `result.subagentTurns` 上）
    subagentTurns: result?.subagentTurns ?? null,
  };
  // 为什么失败 / 被终止的行也测耗时：它是客观事实，且正是排查要看的东西（「它跑了多久」）；
  // token 与轮次只有适配器能给，故那两项在没结果时保持 null
  //
  // **`durationMs` 的口径 = 候选 agent 那一段的耗时，不含评分阶段**（终审 ADD-4，选定「写明口径」
  // 而不是改语义）。两处理由：
  //   ① 有适配器结果时它是**适配器自报**的时长（不是我们掐表），而评分那一段没有对应物——
  //      把「适配器自报的秒数」加上「我们掐表的评分墙钟」会得到一个两种来源拼起来的数，
  //      这个数没有任何一处能解释得清；
  //   ② 它是界面上「耗时」那一列、冒烟记录里也有实测基线，改语义等于让历史读数与新读数不可比。
  // 后果照实说明：开智能体评分的轮次里，评分本身也要跑一次 CLI（分钟级），那一截不在这个数里
  // ⇒ 横向比「耗时」时它是候选阶段的成本，不是这一行的总墙钟。重新评分同样不动它
  // （`rescoreAttempt` 只跑评分，改它会把候选那段的时间换成一个只含评分的数）。
  /**
   * **已经落过终态的行，耗时以那一刻的冻结值为准**（用户口径 2026-10-06）。
   *
   * 用户按了终止之后，这一次收尾算出的数是「终止 + 收尾延迟」的墙钟；适配器迟到的自报值同理
   * （它是适配器自己跑到停下来的时长）。拿任何一个顶掉冻结值，等于把使用者已经看到停住的那个数
   * 再往上跳一次——实测现场：18:25:31 终止、18:27:33 才走到这里，中间整整两分钟会被算进去。
   * 冻结值由 `setRowStatus` 落终态时写入；它缺席时（`preparing` 阶段就被终止、当时还没有心跳）
   * 退回原来的口径。`judging` 期间被终止的行不在此列：那时 `durationMs` 里已经是候选那一段的读数，
   * 冻结值本来就是它。
   */
  const { row: settledRow } = requireRow(runId, rowId);
  const durationMs =
    (TERMINAL_ROW_STATUSES.includes(settledRow.status) ? settledRow.durationMs : null) ??
    result?.durationMs ??
    elapsedMs;

  // 第 6 步：算 diff（三样合并），并按 diffBudgetBytes 裁剪
  const collected = collectDiff(prepared.workspacePath, prepared.baselineCommit);
  const clipped = truncateDiff(collected.text, settings.diffBudgetBytes);
  patchRow(runId, rowId, {
    ...measured,
    durationMs,
    /**
     * 流式增量观测（2026-10-09）：**这里写的不是「有没有」而是「数到了几条」**——`frameCount === 0`
     * 明确表示「这一次观测到零增量帧」，与老数据的「没观测」（格缺席）是两件事（见契约那一格的 JSDoc）。
     * 中断行也走到这里（`Promise.race` 的宽限窗口结束后照常收尾）⇒ 半截正文虽然不落盘，
     * 「它当时写到哪」仍有据可查。
     */
    streamingDelta,
    diff: {
      filesChanged: collected.filesChanged,
      insertions: collected.insertions,
      deletions: collected.deletions,
      truncated: clipped.truncated,
    },
  });
  publishRowEvent(runId, rowId, {
    type: 'diff-summary',
    filesChanged: collected.filesChanged,
    insertions: collected.insertions,
    deletions: collected.deletions,
    truncated: clipped.truncated,
  });
  if (clipped.truncated) {
    // 被裁掉的文件必须留痕：否则「看不到的改动」会被评分模型当成「没改」（§5.5 第 7 步）
    const shown = clipped.droppedFiles.slice(0, 20).join('、');
    const more = clipped.droppedFiles.length > 20 ? ` 等 ${clipped.droppedFiles.length} 个文件` : '';
    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stderr',
      text: `[编排] diff 超过上限 ${settings.diffBudgetBytes} 字节，已按文件裁剪；未送入评分模型的文件：${shown}${more}`,
    });
  }

  // 终止类结果优先判定（用户终止 > 适配器违约 > 适配器自报）
  const stop = classifyStop({
    userAborted: userAborted.has(key),
    result,
    agentError,
  });
  if (stop !== null) {
    settleStopped(runId, rowId, stop);
    // **候选 agent 阶段的失败也要交回调用方**（2026-09-27）：`classifyStop` 的 `failed` 那一支
    // 走的是 `settleStopped`（不是抛异常），只返回 null 会让 `AGENT_FAILED` 这类瞬时失败
    // 永远进不了自动重试。`canceled` / `timed-out` 返回 null——用户意图与分钟级成本都不该自动再赌。
    return stop.status === 'failed' ? stop : null;
  }
  // 这里不再有 `if (agentError !== null) throw agentError;`：classifyStop 在 agentError 非 null 时
  // 必定返回非 null（违约分支排在 `result === null` 之前），那一行是**不可达**的——留着会让人以为
  // 违约还有第二条兜底路径（评审 L3 的处置：删掉死代码，违约的归因与 error 事件都在 classifyStop
  // → settleStopped 这一条路上）。

  // 第 7 步：评分（§5.7）。通路的选择、尺子的解析、配置快照的取法全部收在 runJudgeStage 里——
  // 完整跑一行与「重新评分」共用它，两处各写一遍必然漂移。
  // 原来写在这里的 `setRowStatus(…, 'judging')` 与那两段 R14 注释**整段搬进**了 runJudgeStage：
  // 留在原地会变成第二处状态写入点（static-assertions.test.ts 盯的就是这个）。
  const { row: beforeJudging } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(beforeJudging.status)) {
    log.debug('行已被同步终止，跳过评分', { runId, rowId, status: beforeJudging.status });
    return null;
  }

  let score: ScoreResult;
  try {
    score = await runJudgeStage({
      runId,
      rowId,
      run,
      testCase,
      workspacePath: prepared.workspacePath,
      baselineCommit: prepared.baselineCommit,
      diffText: clipped.text,
      diffSummary: {
        filesChanged: collected.filesChanged,
        insertions: collected.insertions,
        deletions: collected.deletions,
        truncated: clipped.truncated,
      },
      controller,
      // 候选阶段那个唤醒器的**同一个** promise：评分阶段也要能被「用户终止」唤醒（spec §6 / D13）
      terminalReached,
    });
  } catch (error) {
    if (error instanceof JudgeAgentError) {
      // 智能体自身的终止 / 失败：AGENT_* 不是契约的 ErrorCode，走这条专用映射
      settleAgentJudgeStop(runId, rowId, error);
      // 与候选阶段同一条口径：**评分阶段的 failed 也要交回调用方**（`JUDGE_PARSE_FAILED` /
      // 上游 5xx 都从这里出去），否则「评分失败自动重试整行」这条出口就是死的；
      // canceled / timed-out 仍然返回 null（用户意图 / 分钟级成本，不自动重试）
      const { row: settledRow } = requireRow(runId, rowId);
      return settledRow.status === 'failed'
        ? { status: 'failed', error: settledRow.error, exitReason: 'error', stage: 'judge' }
        : null;
    }
    // 配置缺失（未配评分模型 / 未配评分智能体 / 协议不兼容）与解析失败：交给 runRow 的兜底落 failed
    throw error;
  }

  const { row: afterJudging } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(afterJudging.status)) {
    // 评分是在用户终止之后才返回的：状态保持 canceled（用户意图优先），分数只记进日志
    publishRowEvent(runId, rowId, { type: 'score', score });
    log.warn('行已被终止，评分结果只记入事件日志', { runId, rowId, status: afterJudging.status });
    return null;
  }

  // 第 8 步：落盘（分数 → 状态 → end，顺序即事件日志里的顺序）
  patchRow(runId, rowId, { score });
  publishRowEvent(runId, rowId, { type: 'score', score });
  setRowStatus(runId, rowId, 'judged');
  publishRowEvent(runId, rowId, { type: 'end', exitReason: 'completed' });
  return null;
}

/** 在途的重新评分任务（键是 `runId:rowId`）：`drainRunningTasks` 也要等它们 */
const rescoreTasks = new Map<string, Promise<void>>();

/** 在途的单行重新执行任务（键是 `runId:rowId`）：与重评同一形状，`drainRunningTasks` 也要等它们 */
const retryTasks = new Map<string, Promise<void>>();

/** 这一轮还有没有「上一次的运行还没收尾」的任务：轮级任务 + 行级三条在途表 */
function hasUnsettledWork(runId: string): boolean {
  if (runTasks.has(runId)) return true;
  const prefix = `${runId}:`;
  for (const key of [...retryTasks.keys(), ...rescoreTasks.keys(), ...rowAborts.keys()]) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 「这一轮此刻可以被改 / 被删吗」的纵深守卫：还有在途任务就抛 `CONFLICT`。
 *
 * 为什么 `hasLiveRows` 之外还要它：那条判据读的是**快照**，而行刚落终态、任务还在收尾
 * （`finally` 还没跑）的那一拍，快照上确实「没有活」。这条守卫与 `retryRow` 里既有的那条
 * （`rowAborts.has(key) || retryTasks.has(key)`）同源，只是把范围从「这一行」放大到「这一轮」。
 *
 * ⚠️ 四个子句里 `runTasks.has(runId)` 这一条**今天构造上不可达**：`startRun` 的收尾把 `finalizeRun`
 * 与 `runTasks.delete` 放在**同一个同步片段**里（`.finally` 的内层 `finally`，两步之间没有 await），
 * 单线程下没有别的代码能在那一拍插进来观察它。留着它是给将来的异步改造兜底（收尾里一旦出现 await，
 * 那一格立刻变成真实窗口）——**不要**为了「让它可达」在生产代码里开缝、加延迟或加测试钩子。
 * 另外三条（`retryTasks` / `rescoreTasks` / `rowAborts`）不受此说影响：它们对应的是行级任务真实的在途期。
 */
export function assertRunMutable(runId: string): void {
  if (hasUnsettledWork(runId)) {
    throw new ServiceError('CONFLICT', `这一轮上一次的运行还没收尾（${runId}）：请稍候再试，或先终止它`);
  }
}

/**
 * 删除一轮评测：**分两步且顺序是承重的**（spec §5.3）。
 *   ① 删 `run.json` —— 这是用户按下去要的那件事（列表立刻干净）。快照是列表的唯一真相源，
 *      先删它，就永远不可能出现「回收失败了但这一轮还在列表里」这种半吊子状态。
 *   ② `rmSync` 整个 `{workspaceBase}/{runId}/` —— 回收行工作区与事件日志。
 *      为什么不整目录一把删：`rmSync` 的内部遍历顺序不保证，中途 EPERM 会让
 *      「快照到底删没删」变成不确定。拆开之后，①的结果是确定的。
 *
 * ②失败**只 WARN 并如实回报**（`workspaceRemoved: false`），不报成删除失败：与 `removeCaseCache`
 * 同一处置精神——快照已删＝用户要的结果已达成，剩下的失败是磁盘回收问题（Windows 上文件被占用）；
 * 报成「删除失败」会让用户再点一次，而那一轮已经不存在了，他只会拿到 404。
 *
 * 路径取 `run.workspaceBase`（这一轮**自己**记录的根）而不是当前 `settings.workspaceRoot`：
 * 用户在评测期间改过工作区根目录时，这一轮连读都读不到（`getRun` 只扫当前根 ⇒ 上面先抛 NOT_FOUND），
 * 更不该按当前根去猜一个可能同名、却属于别人的目录。
 */
export function deleteRun(runId: string): { workspaceRemoved: boolean } {
  const run = getRunForWrite(runId);
  if (hasLiveRows(run)) {
    throw new ServiceError('CONFLICT', `这一轮还有候选行在运行（${runId}）：请先终止它，再删除`);
  }
  assertRunMutable(runId);

  const dir = runDir(run.workspaceBase, runId);
  const snapshot = runSnapshotFile(run.workspaceBase, runId);
  try {
    rmSync(snapshot, { force: true });
  } catch (error) {
    // 快照删不掉＝用户要的那件事没发生：必须如实抛（中文原因，与 saveRun 的失败面同口径）
    throw new ServiceError(
      'INTERNAL',
      `评测快照删除失败（${snapshot}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error, context: { runId, snapshot } },
    );
  }
  // 快照没了就把记忆一起清掉：留着它，`getRunForWrite` 还会把这一轮解析回旧根
  forgetRunRoot(runId);

  let workspaceRemoved = true;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    workspaceRemoved = false;
    log.warn('行工作区回收失败（评测已删除，产物残留）', {
      dir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  log.info('评测已删除', { runId, workspaceRemoved, workspaceBase: run.workspaceBase });
  return { workspaceRemoved };
}

/**
 * 单行**执行**（内部名保留 `retry`，界面文案按行态分叉：没跑过 = 「开始执行」、
 * 跑过 = 「重新执行」；2026-09-27 引入为「重新执行」，2026-09-29 放开到「没跑过的行也能单跑」）：
 * 只把**这一行**的候选 agent 与评分整段跑一遍。
 *
 * 与 `rescoreRow` 的分工（两者在界面上是两个按钮）：
 *   · `rescoreRow` = 保留候选产出，只重跑**评分**那一步（几十秒）；
 *   · `retryRow`   = 连候选 agent 一起跑（分钟级）。
 * 两者今天**可用面仍然不同**：后者还要求「跑过一次且有产出」（没有工作区就没有可复评的东西）。
 *
 * 四条口径：
 *   1. **只动这一行**：不重跑别的行、不改轮级 `executionMode`、**不推进串行队列**——
 *      原话接口是「单个评测项执行失败或评分失败支持重试」，2026-09-29 的用户口径又补了半句
 *      「只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。「开始」按钮回答不了这个
 *      问题：它的语义是**所有可执行行**（`isRunnableRow`），想单独跑三行里的第二行时它会顺带把
 *      失败过的行一起重跑。本出口就是那个「只跑它」的入口，**交付时也得是**（守卫见
 *      `orchestrator-single-row.test.ts` 里那条「其他两行逐字未变」）。
 *   2. **同步落状态、异步跑任务**（与 `rescoreRow` / `startRun` 同一形状）：HTTP 立刻拿到
 *      「已经在准备中」的快照，界面靠 SSE 与轮询追进度；
 *   3. **与在途执行互斥**：`rowAborts`（或 `retryTasks`）里已经有这一行 ⇒ 抛 `CONFLICT`。
 *      这一条不是礼节，而是防「两条执行同时改同一行的状态」——那会让 `settleStopped` 的
 *      「终态优先」守卫失效（它只看**当前**状态，而另一条执行刚把状态改回非终态）。
 *      它**只**约束这一行：本轮**别的**行在跑不拦（用户口径 2026-09-29「单行执行就是要现在只跑它」），
 *      与「手动点重新执行」原本的风险同级，不是新增的。
 *   4. **可用判据是 `canRunRow`**（不在跑就放行；2026-09-29 起包含**没跑过**的行）。
 *      `canRetryRow` 只剩「这次是重跑还是首跑」这一个用途——它决定界面文案与确认框措辞，
 *      不再决定能不能跑：
 *        · 跑过（有可比基线 + 有产出）：整段重跑，分钟级成本由 `Popconfirm` 拦一次；
 *        · 没跑过（`pending` / `skipped`）：就是这一次的首跑，工作区从零准备。
 *
 * `attempts` **不在这里重置**：它由 `runRowAttempt` 累加（「这一行走过几次尝试」是累计事实——
 * 没跑过的行从 0 起算，于是「首跑」与「重跑」在这本账上自然分得开）。
 */
export function retryRow(runId: string, rowId: string): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  const key = rowKey(runId, rowId);

  // 判据顺序与 `rescoreRow` 一致：正在跑的先判——它的处置是「先去终止」，与「等它收尾」完全不同
  if (isRunningRow(row.status)) {
    throw new ServiceError('CONFLICT', `该行正在运行中（${ROW_STATUS_LABELS[row.status]}）：请先终止它，再执行`);
  }
  if (rowAborts.has(key) || retryTasks.has(key)) {
    throw new ServiceError('CONFLICT', '该行上一次的运行还没收尾，请稍候再试');
  }
  if (!canRunRow(row)) {
    throw new ServiceError('CONFLICT', retryRefusal(row));
  }
  // 这一次是「首跑」还是「重跑」——只影响文案与事件标记，不影响能不能跑（见函数头第 4 条）
  const rerun = canRetryRow(row);

  const config = loadConfig();
  // 题面没有快照进 run.json（§7.2 只冗余了 caseTitle / repoPath / commitHash；**评分表已经在快照里**，
  // 见 run.ts 的 `EvalRunSchema.rubric`），
  // 与 `startRun` / `rescoreRow` 同一条口径：用例被删了就只能看、不能跑。
  if (readCase(run.caseId) === null) {
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法执行该行；历史记录仍可查看`);
  }

  /**
   * 入口区（落状态 → 起任务）必须能整体回退：`rowAborts` 里的条目现在是「不可并发」的判据，
   * 而 `runRow` 的 `finally` 只在任务真的起来之后才会清它。中间任何一步抛（磁盘满 / 快照被删）
   * 都会把这一行留成「终态 + 一个活着的条目」⇒ 此后它再也执行不了。
   * 与 `rescoreRow` 的入口区是**同一个处置**（失败就该是「什么都没发生」）。
   */
  try {
    setRowStatus(runId, rowId, 'preparing', { error: null });
    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stdout',
      text: rerun
        ? '[重新执行] 用户请求重跑这一行（候选智能体与评分都会重跑；本轮其他行不动）'
        : '[开始执行] 用户请求单跑这一行（只跑这一个候选，本轮其他行不动）',
    });
  } catch (error) {
    clearRowRuntime(runId, rowId);
    throw error;
  }
  log.info(rerun ? '单行重新执行' : '单行首次执行', {
    runId,
    rowId,
    agentKind: row.agentKind,
    modelId: row.modelId,
  });

  const task = runRow(runId, rowId)
    .catch((error: unknown) => {
      // `runRow` 自己保证不抛，走到这里说明是编排自身的 bug：记下来，但不能把行留在非终态
      log.error('单行执行任务异常退出（行级已兜底，不应发生）', {
        runId,
        rowId,
        reason: toServiceError(error).message,
      });
    })
    .finally(() => {
      retryTasks.delete(key);
      // 补一次轮收尾：单行执行成功之后 `partial` 该翻回 `done`（`finalizeRun` 自带「还有行在跑就
      // 什么都不做」的守卫，正在跑别的行时调它是安全的）
      try {
        finalizeRun(runId);
      } catch (error) {
        log.error('单行执行后的轮收尾失败（该轮可能停在 partial）', {
          runId,
          reason: toServiceError(error).message,
        });
      }
    });
  retryTasks.set(key, task);

  // 重新读一次快照再返回：POST /retry 拿到的必须是「已经在准备中」的状态
  return getRunForWrite(runId);
}

/**
 * 不可单跑的**具体**原因。判据只有 `canRunRow` 一份（「不在跑」），而**在跑那一条由调用方先拦**
 * （它有自己的处置：先去按「终止」）——所以走到这里只可能是**竞态**：读快照时不在跑、
 * 落状态前那一拍它跑起来了。留一句话是为了那一刻不放行（放行的代价是两条执行同时改一行的状态），
 * 而不是为了穷举情形。
 *
 * 「没跑过」（`baselineCommit === ''` / `diff === null`）**不再是**拒绝理由（2026-09-29 口径）：
 * 没跑过的行就是这次的首跑，界面上的按钮文案此时是「开始执行」。
 * `row` 这个参数今天只用于**叙述**（调用方已经判过一轮），留着它是因为下一版判据若再加条件，
 * 这里要能原地点出是哪一格拦下的。
 */
function retryRefusal(row: EvalRow): string {
  log.debug('单行执行被拒（判据与快照之间发生了竞态）', { status: row.status });
  return '该行此刻不能单跑（状态刚变化过）：请稍候再试，或先终止正在运行的这一行';
}

/**
 * 不可重评的**具体**原因（逐条点名，不要笼统地说「不能重评」——使用者要知道下一步做什么）。
 * 判据本身与界面共用 `canRescoreRow`（contracts），这里只负责把「为什么不行」翻译成人话。
 *
 * **判据只有一个出处**（终审 Minor）：本函数先问 `canRescoreRow(row)`，它说可以就直接放行，
 * 说不行才去逐条找原因。这样「界面可点、点下去 409」这条漂移在结构上不可能发生——
 * 而下面那串 if 只是**文案**，即使将来判据加了条件而这里没跟上，也会落到最后那条笼统拒绝上
 * （宁可给一句笼统的原因，也不能放行）。
 *
 * `settling` 是**编排层独有的一个面**（其它几条都是「行字段」上的），界面的 `canRescoreRow`
 * 看不见它（它只看行字段）：
 * `rowAborts` 里还有这一行的条目、而**行已经是终态** ⇒ 上一次运行虽然落了终态、却还没收尾
 * （`runRow` 的 finally 还没跑）。这个窗口真实存在且可达，两条路都能进去：
 *   · 适配器响应 abort 需要时间（它可能正卡在等待上游响应上）；
 *   · 评分调用响应 abort 也需要时间（文本通路的 signal 已接上，但中止不是瞬时的）。
 * 2026-09-28 判据放宽之后（不再看 `error` / `error.stage`），进得来这个窗口的行是「**跑过一次且有产出**
 * 的任意终态」——典型形状：评分落了 `failed` 之后 `runRow` 还在自动重试的循环里
 * （`rowAborts` 的条目还在，行已经是 `failed`）。放它进去就是下面这条竞态：
 * 重评把状态推回 `judging` ⇒ 迟到的旧任务调 `settleStopped` / `settleFailed`，而它们的
 * 「终态优先」守卫只看**当前**状态（刚被重评改成非终态）⇒ **再落一次终态**、把重评踩掉；
 * 重评自己的终态复检随后只把分数记进日志，而用户还会看到终止按钮失灵
 * （`runRow` 的 finally 已经把重评那把控制器删了）。故这个窗口必须**拒之门外**，而不是并发。
 * 判据排在「正在运行中」**之后**（顺序的理由见下面那句注释与实测记录）。
 */
function rescoreRefusal(row: EvalRow, options: { settling: boolean }): string | null {
  // **顺序要紧**：正在跑的行先判。它在 `rowAborts` 里**必然**有条目（控制器是开跑前登记的），
  // 把 `settling` 放在前面会让「正在跑」的行拿到「上一次的运行还没收尾」——而那一行的处置
  // 完全相反（该去按「终止」，不是干等）。实测：顺序颠倒时既有用例
  // 「把『正在运行中』的行挡下来，并指向终止」立刻以 `got '该行上一次的运行还没收尾'` 变红。
  if (isRunningRow(row.status)) {
    return `该行正在运行中（${ROW_STATUS_LABELS[row.status]}）：请先终止它，再重新评分`;
  }
  // 到这里行已经是终态：`rowAborts` 里还有条目只可能是**上一次运行还没收尾**（见函数头的注释）
  if (options.settling) {
    return '该行上一次的运行还没收尾，请稍候再试';
  }
  // 判据（与界面同一份）。它说可以就放行，说不行才往下找原因；
  // 下面每条 if 都**必须**只覆盖判据的三个条件之一（顺序也一致），界面上有同样两条、**同义但不逐字**
  if (canRescoreRow(row)) return null;
  if (row.baselineCommit === '') {
    return '该行的工作区未就绪（准备阶段没有成功过）：请先点「开始」重跑该行';
  }
  if (row.diff === null) {
    return '该行没有可用于复评的改动（候选 agent 阶段没有跑完）：请先点「开始」重跑该行';
  }
  // 判据说不行、但上面两条都对不上：只有判据**将来新增条件**时才会走到这里（今天不可达）——
  // 照样拒绝，放行的代价是那一次 409 竞态
  return '该行当前不可重新评分：请先点「开始」让它完整跑过一次';
}

/**
 * 重新评分：在**该行现有工作区**上重跑评分步骤，不重跑候选 agent、不重建工作区、不改分支、不动 diff 摘要。
 *
 * 三条口径：
 *   1. **模式沿用 `run.useAgentJudge`**（spec D11）：一轮里只有一把尺子，行间分数才可比。
 *      评分模型走 `resolveJudgeRoute` 的**当前配置**（只有全局默认这一个来源），于是「到设置页换个评分模型
 *      再点重新评分」天然生效，不需要新的选择器；
 *   2. **先清空该行的分数与失败归因再重算**（与 `runRowAttempt` 的 `preparing` 重置同口径）：
 *      界面停在「评分中」却还挂着上一次的分数，会让人以为已经出分了。代价见 spec §14 第 6 条
 *      （重评失败会丢掉上一次的分数，历史仍在事件日志的 `score` 事件里）；
 *   3. **同步落状态、异步跑任务**（与 `startRun` 同一形状）：HTTP 立刻拿到「已经在评分中」的快照，
 *      界面靠 SSE 与轮询追进度。
 *
 * 与 `startRun` 的**一处有意不对称**：`startRun` 靠 `runTasks.has(runId)` 天然挡住「上一轮还在收尾」，
 * 而重评不在 `runTasks` 里（它不是一轮的执行）——它的对应物是 `rowAborts` 里那个条目，
 * 判据落在 `rescoreRefusal` 的 `settling`（见那里的长注释：放进去会与迟到的旧任务抢状态）。
 *
 * 为什么在这里补一次 `finalizeRun`（见任务收尾的 `.finally`）：补完最后一个失败行之后，轮状态该从
 * `partial` 翻回 `done`，而这一次重评**不在** `runTasks` 里（那是轮级任务的集合），
 * `startRun` 的收尾够不着它。`finalizeRun` 自带「还有行在跑就什么都不做」的守卫，故它在这里是安全的。
 */
export function rescoreRow(runId: string, rowId: string): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  const key = rowKey(runId, rowId);
  // `rowAborts` 里有条目 = 上一次运行还在收尾（见 rescoreRefusal 的 `settling`）：那一刻放行会与
  // 迟到的旧任务抢状态。这是**编排层独有的判据**，`canRescoreRow`（界面那份）看不见它——
  // 于是可能的形态是「界面可点、点下去 409」，与其它拒绝原因同一处置（界面按 reasons 给 Tooltip）。
  const refusal = rescoreRefusal(row, { settling: rowAborts.has(key) });
  if (refusal !== null) throw new ServiceError('CONFLICT', refusal);

  const config = loadConfig();
  const testCase = readCase(run.caseId);
  if (testCase === null) {
    // 题面没有快照进 run.json（§7.2 只冗余了 caseTitle / repoPath / commitHash；**评分表已经在快照里**，
    // 见 run.ts 的 `EvalRunSchema.rubric`）
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法重新评分；历史记录仍可查看`);
  }

  const controller = new AbortController();
  const mode = run.useAgentJudge ? '评分智能体' : '评分模型';
  /**
   * 入口区（登记控制器 → 写标记事件 → 写状态）**必须能整体回退**。
   *
   * 为什么：`rowAborts` 里的条目现在是**不可重评**的判据（上面那条 `settling`），
   * 而这三步里任何一步抛（磁盘满 / 快照被删 / 目录形状非法）都会让这一行**带着一个活着的条目
   * 停在终态**——此后它再也重评不了，且没有任何东西会去清那个条目（只有 `clearRowRuntime` 会，
   * 而它挂在重评任务的 finally 上，任务压根没起来）。修复前这不是问题（条目只影响 abort），
   * 修复后它会把一次落盘失败放大成「这一行永久不可重评」。
   * 处置：整段 try/catch，失败即 `clearRowRuntime` 抹掉入口区的全部痕迹再抛——失败就该是
   * 「什么都没发生」，而不是「留下一把永远打不开的锁」。
   * 注意**顺序没变**（登记 → 标记 → 状态）：取消窗口里「先有控制器、后有状态」与候选阶段同形，
   * 且标记事件排在状态之前，日志里仍是「先说要重评、再说进入评分中」。
   */
  try {
    // 与 runRowAttempt 同一把钥匙：于是「终止」按钮（abortRow）在重评**真正可被中止的那一段**有效，
    // 不需要新入口。**两条通路的中止语义现在一致**（终审 FIX-1）：文本通路也拿到了 signal，
    // 于是按终止会真的切断那次调用——差别只剩「中止不是瞬时的」这一点（旧注释里
    // 「文本通路按终止只同步落 canceled、调用继续跑到返回为止」已不成立）。
    rowAborts.set(key, controller);

    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stdout',
      text: `[重新评分] 用户请求重新评分（模式：${mode}），本次不重跑候选智能体`,
    });
    setRowStatus(runId, rowId, 'judging', { error: null, score: null });
  } catch (error) {
    clearRowRuntime(runId, rowId);
    throw error;
  }
  log.info('重新评分', { runId, rowId, mode });

  // `run` 是**刚刚读到的**那一份快照：`runJudgeStage` 按它的 `useAgentJudge` 选通路。
  // 不复用 `runRowAttempt` 闭包里的任何东西——那会拿一份陈旧的轮级开关去评分。
  const task = rescoreAttempt({ runId, rowId, run, testCase, row, controller })
    .catch((error: unknown) => {
      // 行级已兜底，走到这里说明是编排自身的 bug：记下来，但不能把行留在非终态
      log.error('重新评分任务异常退出（行级已兜底，不应发生）', {
        runId,
        rowId,
        reason: toServiceError(error).message,
      });
    })
    .finally(() => {
      clearRowRuntime(runId, rowId);
      // 补一次轮收尾：补完最后一个失败行之后 partial 该翻回 done（`finalizeRun` 自己有「还有行在跑就
      // 什么都不做」的守卫，正在跑别的行时调它是安全的）
      try {
        finalizeRun(runId);
      } catch (error) {
        log.error('重新评分后的轮收尾失败（该轮可能停在 partial）', {
          runId,
          reason: toServiceError(error).message,
        });
      } finally {
        rescoreTasks.delete(key);
      }
    });
  rescoreTasks.set(key, task);

  // 重新读一次快照再返回：POST /rescore 拿到的必须是「已经在评分中」的状态
  return getRunForWrite(runId);
}

/** 重评的执行体：跑评分 → 终态复检 → 落盘（失败面与完整跑一行**逐条同形**） */
async function rescoreAttempt(input: {
  runId: string;
  rowId: string;
  run: EvalRun;
  testCase: TestCase;
  row: EvalRow;
  controller: AbortController;
}): Promise<void> {
  const key = rowKey(input.runId, input.rowId);
  /**
   * 重评这条旁路**没有**现成的唤醒器可用（它不在 `runRowAttempt` 里，那个是完整跑一行的闭包），
   * 故在这里自己造一个并注册——与 `runRowAttempt` 的那两行逐字同形，评分阶段才能同样被终止唤醒
   * （spec §6：两条路同形）。注册必须在**本函数第一个 `await` 之前**（async 函数体同步执行到第一个
   * await 为止）：`rescoreRow` 刚把行落成 `judging`，那一拍与这里是同一个同步片段，中间插不进
   * 「用户终止」——注册晚一步就会漏掉那次唤醒。
   */
  let wakeOnTerminal: (() => void) | undefined;
  const terminalReached = new Promise<'terminal'>((resolve) => {
    wakeOnTerminal = () => resolve('terminal');
  });
  terminalWaiters.set(key, () => wakeOnTerminal?.());
  try {
    const score = await runJudgeStage({
      runId: input.runId,
      rowId: input.rowId,
      run: input.run,
      testCase: input.testCase,
      workspacePath: input.row.workspacePath,
      baselineCommit: input.row.baselineCommit,
      // 第 6 步那一份没有落在快照里（快照只存计数摘要）：这里传 null，由评分阶段自己现算
      diffText: null,
      // 改动摘要同样传 null：评分阶段现算的那一份 `truncated` 恒为 false（它只用于计数对照），
      // 把它写回 `row.diff` 会让「diff 已截断」这个徽标凭空消失。`row.diff` 属于候选阶段，
      // 重评一个字都不动它。
      diffSummary: null,
      controller: input.controller,
      terminalReached,
    });

    const { row: afterJudging } = requireRow(input.runId, input.rowId);
    if (TERMINAL_ROW_STATUSES.includes(afterJudging.status)) {
      // 用户终止之后评分才返回：状态保持 canceled（用户意图优先），分数只记进日志
      publishRowEvent(input.runId, input.rowId, { type: 'score', score });
      log.warn('行已被终止，重新评分的结果只记入事件日志', { runId: input.runId, rowId: input.rowId });
      return;
    }

    patchRow(input.runId, input.rowId, { score });
    publishRowEvent(input.runId, input.rowId, { type: 'score', score });
    setRowStatus(input.runId, input.rowId, 'judged');
    // `exitReason` 用 'rescored' 而不是 'completed'：日志里两次 `end` 必须能区分是哪一次
    publishRowEvent(input.runId, input.rowId, { type: 'end', exitReason: 'rescored' });
  } catch (error) {
    if (error instanceof JudgeAgentError) {
      settleAgentJudgeStop(input.runId, input.rowId, error);
      return;
    }
    // 重评只跑评分那一段：这里出去的每一笔失败都发生在评分阶段（`error.stage` 的叙述口径要靠它）
    settleFailed(input.runId, input.rowId, toServiceError(error), null, 'judge');
  }
  // 唤醒器不在这里摘（同 `runRowAttempt` 候选阶段那一段的理由）：清理点统一在 `clearRowRuntime`
  // ——`rescoreRow` 的任务 finally 会调它，两条路因此共用同一个边界
}

/* ===================================================================================================
 * 轮级状态机（Task 6）
 *
 * 一轮的产出有三样：run.json 的 status、每行的终态、每行的事件日志。三样必须互相对得上——
 * 「开始」在轮级只被读一次（执行模式随评测落库，运行中不可改），终止在轮级有两条入口
 * （整轮 / 单行），收尾只在「一行都不在跑」之后发生。
 * =================================================================================================== */

/** 在途的**轮级**任务：`drainRunningTasks` 等它们，`startRun` 用它判「是不是已经在跑」 */
const runTasks = new Map<string, Promise<void>>();

/**
 * 被**用户整轮终止**的轮次。
 *
 * 为什么需要它、而不是只看行的状态：`skipped` 在 `isRunnableRow` 里属于「可执行」（§5.3 的
 * 「开始」按钮要能重跑被跳过的行），所以串行队列**不能**拿「状态还可执行」当「继续启动」的判据；
 * 而 `abortRun` 只把 `pending` 的行落成 `skipped`，队列里那些 `failed` / `interrupted`
 *（上一轮留下、本轮已列入目标）的行状态不变——只看状态的话，用户按了终止，串行队列仍会把它们跑起来。
 * 故轮级终止另记一笔，队列每起一行前先看它。
 */
const abortedRuns = new Set<string>();

/** 轮级快照允许变的字段：状态与两个时间戳（行级字段一律走 `setRowStatus` / `patchRow`） */
type RunStatusPatch = Pick<EvalRun, 'status'> & Partial<Pick<EvalRun, 'startedAt' | 'finishedAt'>>;

/**
 * 轮级快照的唯一写入点：`EvalRun.status` / `startedAt` / `finishedAt` 只在这里改。
 *
 * 为什么轮级另有一个出口、而不复用 `mutateRow`：`mutateRow` 的定位参数是 `(runId, rowId)`，
 * 而轮级收尾发生在「所有行都已结束」之后，没有「当事行」——借一行来写轮状态是假语义。
 * 为什么轮级不需要「同时追加事件」：契约 §2.6 / spec §7.4 的 `AgentEvent` 八个成员**全是行级的**，
 * 事件日志也按行落盘（`{rowDir}/events.jsonl`），轮级状态在协议里没有对应的事件可写；
 * 「事件与快照同源」这条不变式因此只对行级成立（由 `setRowStatus` 成对落地）。
 */
function setRunStatus(runId: string, patch: RunStatusPatch): EvalRun {
  const next: EvalRun = { ...getRunForWrite(runId), ...patch };
  saveRun(next);
  return next;
}

/**
 * 开始执行一轮评测：只跑可执行的行（`isRunnableRow`：pending / failed / timed-out / canceled /
 * interrupted / skipped），已有行在跑则拒绝（契约 §5）。
 * 为什么立即返回快照、不等跑完：一轮评测是分钟级的，HTTP 请求不能挂在那儿；进度由事件日志 +
 * 快照驱动（F14），界面靠 SSE 追。
 * 执行模式（F9）在这里被读取一次就固定下来：本模块**不提供**改模式的入口，运行中也就无从修改。
 *
 * 快照读写走 `getRunForWrite`（不是 `getRun`）：本层是**在途轮次**的执行者，用户在评测期间把工作区
 * 根目录从 A 改到 B 之后，只扫当前根的 `getRun` 会抛 NOT_FOUND ⇒ 刚点就开始不了（评审 H1 的同一扇门）。
 */
export function startRun(runId: string): EvalRun {
  const run = getRunForWrite(runId);
  if (runTasks.has(runId) || run.rows.some((row) => isRunningRow(row.status))) {
    throw new ServiceError('CONFLICT', `该评测已有候选行在运行（${runId}），请先等它结束或终止`);
  }
  const config = loadConfig();
  if (readCase(run.caseId) === null) {
    // 题面没有快照进 run.json（§7.2 只冗余了 caseTitle / repoPath / commitHash；**评分表已经在快照里**，
    // 见 run.ts 的 `EvalRunSchema.rubric`），
    // 所以用例被删掉之后这轮可以看、不能跑——必须在启动前拦下，而不是等每行各自失败
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法执行该评测；历史记录仍可查看`);
  }
  if (!run.rows.some((row) => isRunnableRow(row.status))) {
    throw new ServiceError('CONFLICT', '没有可执行的候选行');
  }

  // 新一轮从「没被终止过」开始：上一轮终止留下的标记不能把这一轮的串行队列判成「已终止」
  abortedRuns.delete(runId);
  setRunStatus(runId, { status: 'running', startedAt: new Date().toISOString(), finishedAt: null });
  log.info('评测开始', { runId, mode: run.executionMode, rows: run.rows.length });

  const task = executeRun(runId)
    .catch((error: unknown) => {
      // 行级已兜底（runRow 永不抛），走到这里说明是编排自身的 bug：记下来，但轮不能卡在 running
      log.error('轮级任务异常退出（行级已兜底，不应发生）', { runId, reason: toServiceError(error).message });
    })
    .finally(() => {
      // 收尾**可能抛**（`finalizeRun → setRunStatus → saveRun`：磁盘满 / 快照被删 / 根目录形状非法），
      // 而 `.finally` 里裸调它的两个后果都很重（评审 Medium-3）：
      //   ① `runTasks.delete` 被跳过 ⇒ 这一轮在**进程存活期内再也 `startRun` 不了**（恒抛 CONFLICT
      //      「该评测已有候选行在运行」，而实际一行都没在跑）；`drainRunningTasks` 也会因为这条永不消失的
      //      条目**空转**（while 条件恒真）；
      //   ② `.finally()` 返回的 promise 在生产**无人 await**（只有测试/关停会 drain）⇒ 未处理 rejection，
      //      Node 默认 `--unhandled-rejections=throw` 会终结进程。
      // 所以收尾自己吞掉并记 ERROR（这一轮可能停在 running，那是要人来看的故障，不是静默丢数据），
      // 而「清理在途记账」放进内层 `finally`：无论收尾成功与否都必须执行。
      try {
        finalizeRun(runId);
      } catch (error) {
        log.error('轮收尾失败（该轮可能停在 running）', { runId, reason: toServiceError(error).message });
      } finally {
        runTasks.delete(runId);
        abortedRuns.delete(runId);
      }
    });
  runTasks.set(runId, task);

  // 重新读一次快照再返回：p5 的 POST /start 拿到的必须是「已经在跑」的状态
  return getRunForWrite(runId);
}

/**
 * 轮级执行：并行 = 所有目标行同时启动（不设并发上限，F12）；串行 = 一行跑完**含评分**才起下一行（§5.2）。
 * 两种模式**都**为每行建独立工作区（F6）——串行省的是 CPU 与供应商配额，不是工作区；
 * 串行共用一个目录会让第二个 agent 在第一个的改动上继续写，分数无意义、整轮作废。
 *
 * 串行队列「该不该起这一行」的判据**不是** `isRunnableRow`：`skipped` 在它眼里是可执行的
 *（§5.3 的「开始」按钮靠它重跑被跳过的行），拿它当判据会让 `abortRun` / `abortRow` 落下的
 * `skipped` 行在队列里立刻又被启动——终止也就等于没终止。判据是两样：
 *   · `abortedRuns` 里有这一轮 ⇒ 整轮已被终止，队列剩下的行一个都不再起；
 *   · 该行此刻的状态与本轮开始时的**计划状态**不一致 ⇒ 它在排队期间被单行终止（pending → skipped），跳过。
 * 计划状态在轮开始时取一次、而不是写死「必须是 pending」：重跑 `failed` / `timed-out` 行时，
 * 它们的状态本来就是「非 pending」，写死会把整条队列跳空。
 */
async function executeRun(runId: string): Promise<void> {
  const run = getRunForWrite(runId);
  const planned = run.rows.filter((row) => isRunnableRow(row.status)).map((row) => ({ id: row.id, status: row.status }));

  if (run.executionMode === 'parallel') {
    // runRow 保证永不抛，故 Promise.all 不会因为某一行失败而提前结束其它行
    await Promise.all(planned.map((target) => runRow(runId, target.id)));
    return;
  }

  for (const target of planned) {
    if (abortedRuns.has(runId)) {
      log.info('轮已被终止，串行队列不再启动后续行', { runId });
      return;
    }
    // 每行开跑前重读快照：单行终止会把排队中的行同步落成 skipped，这里必须尊重它
    const current = getRunForWrite(runId).rows.find((row) => row.id === target.id);
    if (current === undefined || current.status !== target.status) continue;
    await runRow(runId, target.id);
  }
}

/**
 * 轮收尾：所有行都到终态后，全部 `judged` → `done`，否则 `partial`。
 * spec 只给了 `idle | running | partial | done` 四个取值、没定义后两者，这里定死口径（列表页靠它显示状态）：
 * **done = 每一行都出了分；partial = 跑完了但有行没出分**（失败 / 超时 / 终止 / 跳过 / 中断）。
 * 还有行在跑就什么都不做——「轮结束」不能抢在「行结束」前面。
 */
function finalizeRun(runId: string): void {
  const run = getRunForWrite(runId);
  if (run.rows.some((row) => isRunningRow(row.status))) return;
  const status: EvalRun['status'] = run.rows.length > 0 && run.rows.every((row) => row.status === 'judged') ? 'done' : 'partial';
  if (run.status === status && run.finishedAt !== null) return; // 已收尾：不重复写时间戳
  setRunStatus(runId, { status, finishedAt: new Date().toISOString() });
  log.info('评测执行结束', { runId, status, rows: run.rows.length });
}

/**
 * 终止整轮：**正在跑的行 → canceled，还没轮到的行 → skipped**（§5.4 的表，两者不可合并：
 * 「用户杀了它」与「它压根没跑」在事后复盘时是两件事）。
 * 为什么状态同步落库、不等待进程真正退出：终止是用户的即时动作，若等到子进程死掉再改状态，
 * 界面会在十几秒里一直显示「运行中」——使用者只会认为按钮坏了，然后再点几次。
 * 在途任务稍后回来时会看到终态并跳过（终态优先），进程收尾由适配器按 §5.6.6 的顺序完成。
 */
export function abortRun(runId: string): EvalRun {
  const run = getRunForWrite(runId);
  const running = run.rows.filter((row) => isRunningRow(row.status));
  if (running.length === 0 && !runTasks.has(runId)) {
    throw new ServiceError('CONFLICT', `该评测没有正在运行的候选行（${runId}）`);
  }

  // 先记账再发停止信号：`signal` 不带原因，在途任务回来时只能靠 userAborted 认出「这是用户终止」
  abortedRuns.add(runId);
  for (const row of running) {
    const key = rowKey(runId, row.id);
    userAborted.add(key);
    rowAborts.get(key)?.abort();
    setRowStatus(runId, row.id, 'canceled');
    publishRowEvent(runId, row.id, { type: 'end', exitReason: 'canceled' });
  }
  // 还没轮到的行（串行排队中；并行下理论上不存在，真有也按同一口径处理）：
  // 它们从此不会再有开始的机会，语义是 skipped 而不是 canceled
  let skipped = 0;
  for (const row of getRunForWrite(runId).rows) {
    if (row.status !== 'pending') continue;
    setRowStatus(runId, row.id, 'skipped');
    publishRowEvent(runId, row.id, { type: 'end', exitReason: 'skipped' });
    skipped += 1;
  }

  // 两个数都要报（评审 Nit-9）：复盘时「跑着的被终止」与「压根没跑的」是两件事，只报前者会让人
  // 以为队列里的行都跑过、只是没出分。
  log.info('评测已终止', { runId, canceled: running.length, skipped });
  return getRunForWrite(runId);
}

/**
 * 终止单行：正在跑的行 → `canceled`；排队中的行 → `skipped`（它还没开始过，与轮级终止同一口径）；
 * 已经结束的行 → CONFLICT（界面不该给它按钮，真调到了要明确报出来，而不是静默成功）。
 * 单行终止**不影响**其它行：串行队列会跳过这一行继续跑后面的（`executeRun` 的计划状态判据）。
 */
export function abortRow(runId: string, rowId: string): EvalRun {
  const { row } = requireRow(runId, rowId);

  if (isRunningRow(row.status)) {
    const key = rowKey(runId, rowId);
    userAborted.add(key);
    rowAborts.get(key)?.abort();
    setRowStatus(runId, rowId, 'canceled');
    publishRowEvent(runId, rowId, { type: 'end', exitReason: 'canceled' });
    log.info('候选行已终止', { runId, rowId });
    return getRunForWrite(runId);
  }

  if (row.status === 'pending') {
    setRowStatus(runId, rowId, 'skipped');
    publishRowEvent(runId, rowId, { type: 'end', exitReason: 'skipped' });
    log.info('排队中的候选行已跳过', { runId, rowId });
    return getRunForWrite(runId);
  }

  throw new ServiceError('CONFLICT', `候选行已结束（${ROW_STATUS_LABELS[row.status]}），无法终止`);
}

/**
 * 等在途的任务结束（测试与进程关停用）。**三处都要等**：轮级任务、重新评分任务与单行重新执行任务
 * 各有一个集合，只等第一个会让 `drainRunningTasks()` 在「一轮跑完之后、某行的重评/重新执行还在跑」时
 * 提前返回，而它们会在测试已经拆掉临时目录之后继续写盘。
 * 用 while 而不是一次性 `allSettled`：等待期间可能又有新的轮开始，一次等干净更符合「关停」的语义。
 */
export async function drainRunningTasks(): Promise<void> {
  while (runTasks.size > 0 || rescoreTasks.size > 0 || retryTasks.size > 0) {
    await Promise.allSettled([...runTasks.values(), ...rescoreTasks.values(), ...retryTasks.values()]);
  }
}

/* ===================================================================================================
 * 重启恢复（spec §7.4 / F10）
 * =================================================================================================== */

/**
 * 服务重启恢复：把仍处 `preparing` / `running` / `judging` 的行标 `interrupted`（F10，**不自动续跑**：
 * agent 子进程已随服务消失，续跑需要独立进程托管，成本远超收益）。
 *
 * 只动这三种状态——终态行（judged / failed / timed-out / canceled / skipped / interrupted）一律不碰：
 * 把「上次失败」改写成「被中断」会抹掉失败原因，使用者就再也看不到那一行到底为什么没出分。
 * 判据直接用 `isRunningRow`（界面判「这一行在不在跑」用的是同一个函数）：恢复必须沿用编排层已有的
 * 那套状态划分，**不新发明第二套**——两套判据一旦分叉，最先漂移的就是「哪些状态算在途」。
 *
 * 状态改写**走 `setRowStatus`、轮级收尾走 `setRunStatus`**，不是直接改对象字段再 `saveRun`：
 * 恢复同样受「每次状态变更由同一个函数同时写快照与追加事件」这条不变式约束（R17 / F14），
 * 而静态守卫会逐条扫源码（`static-assertions.test.ts`，评审 C1）——`row.status = …` 会同时命中
 * 「直接给 .status 赋值」「状态事件出圈」「第二处 saveRun」三条判据，把那条 Critical 的守卫染红。
 * 走 `setRowStatus` 还顺带保证「快照里那一行」与「事件里那一条」永远同源。而「不覆盖别人改过的行」这条
 * 承诺**不是**靠 `listRuns()` 的结果成立的——它只用来挑出「看起来在途」的行——而是靠改写前对**磁盘上的
 * 当前快照**做的二次复检（见循环内的注释，评审 Low-4）。
 *
 * 顺带把该轮收成 `partial` 并补 `finishedAt`（spec §7.4 只说了改行状态）：否则界面会一直显示
 * 「运行中」，而实际上没有任何行在跑，使用者只能干等。轮级状态在协议里没有对应的事件类型
 * （`AgentEvent` 八个成员全是行级的），故这一笔只有快照、没有事件——与 `finalizeRun` 同一口径。
 *
 * 逐行 / 逐轮都吞掉异常并记 WARN：恢复的输入是**上一个进程留下的磁盘状态**，其中任何一条坏掉
 * （目录被手工删、磁盘满、文件被占）都不该挡住其它行与其它轮次，更不该让启动钩子抛错——
 * 启动钩子抛错会让整个 Next 服务起不来（Review Focus 第 4 条）。
 *
 * 调用点**唯一**：`apps/web-next/instrumentation.ts` 的 `register()`（Next 的服务启动钩子）。
 * 返回值的 `recovered` 是**被改写为 interrupted 的行数**（不是轮数）——启动日志按它报数。
 */
export function recoverInterruptedRuns(): { recovered: number } {
  let recovered = 0;
  let touchedRuns = 0;

  for (const listed of listRuns()) {
    const interrupted = listed.rows.filter((row) => isRunningRow(row.status));
    if (interrupted.length === 0) continue;

    for (const row of interrupted) {
      try {
        // **二次复检**（评审 Low-4）：`listRuns()` 的结果只用来挑出「看起来在途」的行，而 `setRowStatus`
        // 只按 id 定位、**不比对当前状态**——若某一行在 `listRuns()` 与这次改写之间跑完（`judged`），
        // 恢复就会把它的分数与状态一起改写成 `interrupted`，使用者永久丢掉那一分（正是本函数 JSDoc
        // 开头那条「终态行一字不动」要防的事）。复检读的是**磁盘上的当前快照**（`getRunForWrite`），
        // 只在它此刻仍然在途时才改写。今天的唯一调用点（启动钩子）那一瞬没有行在跑，所以这条是
        // **纵深防御**而不是现行缺陷——但它让「不覆盖别人改过的行」这句承诺真的成立。
        const current = getRunForWrite(listed.id).rows.find((candidate) => candidate.id === row.id);
        if (current === undefined || !isRunningRow(current.status)) continue;
        // 事件日志里要留一句：日志抽屉停在半路时，看的人必须能区分「模型没说话」与「服务没了」
        publishRowEvent(listed.id, row.id, {
          type: 'log',
          stream: 'stderr',
          text: '服务重启：该行执行已中断（agent 子进程随服务退出，不自动续跑）；点「开始」可重跑该行。',
        });
        setRowStatus(listed.id, row.id, 'interrupted');
        // 与 abortRow / settleStopped 同一口径：终态之后补一条 `end`，日志抽屉里「这一行结束了、
        // 为什么结束」才有完整的一句（五种终态由编排层记账区分，`exitReason` 就是那本账）
        publishRowEvent(listed.id, row.id, { type: 'end', exitReason: 'interrupted' });
        recovered += 1;
      } catch (error) {
        // 恢复不了这一行不影响别的行：状态可能已在快照里落好（setRowStatus 先落盘再发事件），
        // 界面照样能看到「已中断」；这里只保证「一条坏数据不挡住其余恢复」并把原因留在日志里
        log.warn('恢复该行失败（继续恢复其它行）', {
          runId: listed.id,
          rowId: row.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      // `?? 新时间` 而不是无条件刷新：同一轮被恢复两次时 finishedAt 不该跳（幂等）
      setRunStatus(listed.id, { status: 'partial', finishedAt: listed.finishedAt ?? new Date().toISOString() });
      touchedRuns += 1;
    } catch (error) {
      log.warn('恢复时收尾轮状态失败（继续恢复其它轮次）', {
        runId: listed.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (recovered > 0) log.warn('服务重启：已把中断的行标记为 interrupted', { rows: recovered, runs: touchedRuns });
  return { recovered };
}
