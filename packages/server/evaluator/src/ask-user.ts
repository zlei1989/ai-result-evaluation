/**
 * 挂起表：**待答提问在进程内的唯一真相源**，外加它的变更信号总线。
 *
 * 一条记录的命运只有两条：被答复（`resolveAskUser`）或被调用方取消（`signal` 中止）。
 * 两条都走同一个 `settle`，因此「从表里消失」与「等待方拿到收场」永远同时发生。
 *
 * 四格口径（改本模块之前先读完）：
 *
 *   1. **挂 `globalThis`**，理由与编排层既有那三条进程内总线（`events.ts` / `run-signals.ts` /
 *      `candidate-messages.ts`）**逐字相同**：dev 的 HMR 会重新实例化模块，模块作用域的表会裂成两半，
 *      症状是「页面连上的是新表、编排层登记的是旧表」——连接 OPEN、快照恒空、应答恒 404，
 *      而两边各自的日志都看不出异样。挂上之后无论模块被重建多少次，读写两侧看到的都是同一张表。
 *   2. **存的是决议函数，不是 promise**：表要能在应答到达的那一刻**当场**结束等待，
 *      而「等」的那一侧（`Promise.race([等待, 候选终止, 预算])`）归调用方——表不认识定时器，
 *      也就无从在超时后自己清理。`settle` 收口两个出口，超时与取消因此不会漏退登记。
 *   3. **进程重启 = 表为空**：这里**没有持久化，也不该有**——「待答」是只存在于内存里的一刻，
 *      落盘只会造出一张重启后无人能兑现的欠条。重启后旧 `askId` 一律应答不到（`NOT_FOUND`），
 *      在跑的候选由既有的重启恢复路径收场（`recoverInterruptedRuns`），不是静默悬挂。
 *   4. **信号只推「变了，重读」**：`publishAskUserChanged` 在登记、答复、取消三处各发一条，
 *      负载为空——待答清单的内容由快照端点给。把内容塞进信号，乱序到达时旧内容会盖掉新内容，
 *      快照就变成第二份真相（与 `run-signals.ts` 口径 1 同源）。
 *
 * 依赖方向：本模块只认 `@aieval/contracts`（形状）与 `@aieval/core`（日志）。
 * `PendingAskUserEntry.request` 是**结构化**形状而不是 `@aieval/agents` 的 `AskUserRequest`：
 * 编排层把厂商上下文交进来时要多用几个字段，而本模块一个都不用（它们只为回灌答案时取用），
 * 引一个类型只为抄一遍字段名，会顺手把 agents 包拖进 evaluator 的类型面。
 */
import { ServiceError, type AskUserAnswer, type AskUserOutcome, type AskUserQuestion, type PendingAskUser } from '@aieval/contracts';
import { createLogger } from '@aieval/core';

const log = createLogger('ask-user');

/** 提问发生在哪一段：与契约的 `AskUserStageSchema` 同词表（那边是传输形状，这里是内存形状） */
export type AskUserStage = 'agent' | 'judge';

/**
 * 登记时交进来的厂商上下文（**不进快照**）：回灌答案时要按 `callId` 找到那次工具调用，
 * 按 `toolName` 报出模型实际调的是谁，按 `vendorBudgetMs` 判断厂商自己会不会先收场。
 */
export interface PendingAskUserRequest {
  questions: AskUserQuestion[];
  toolName: string;
  callId: string;
  vendorBudgetMs: number | null;
  subagentId: string | null;
}

/** 一条挂起记录：定位（哪一轮哪一行哪一段）+ 问题与时刻 + 决议函数（口径 2） */
export interface PendingAskUserEntry {
  askId: string;
  runId: string;
  /** `null` = 这一问不在某一个候选上 */
  candidateId: string | null;
  stage: AskUserStage;
  request: PendingAskUserRequest;
  askedAt: string;
  /**
   * 结束等待（幂等由调用方保证：`settle` 是唯一出口，且它先删表项再决议）。
   * `outcome === 'answered'` 时必须同时给出答案，其余六档 `answers` 传 `null`
   * （「收场了但没有答案可回填」与「答了一个选项都没选」是两件事）。
   */
  resolve: (outcome: AskUserOutcome, answers: AskUserAnswer[] | null) => void;
}

/** 变更信号的订阅者：只被告知「变了」，读什么由它自己去快照端点取（口径 4） */
export type AskUserChangedListener = () => void;

/** 挂 `globalThis` 的形状：一张表 + 一张订阅表 + 一份已答名单（口径 1：三者都必须挂） */
interface AskUserRegistry {
  /** `askId → 记录`；插入顺序即提问顺序，快照按它给（界面的先来后到由这一刻决定） */
  entries: Map<string, PendingAskUserEntry>;
  subscribers: Set<AskUserChangedListener>;
  /**
   * **已经被答复过**的 `askId`（只增不删）。
   *
   * 它的唯一职责是把 409 与 404 分开：答复是一次性动作，出表之后「刚才有人答过」与
   * 「这个 id 从没存在过」在表里长得一模一样，而两者的客户端动作相反——409 该提示「已经答过了」，
   * 404 该让客户端刷新快照。
   *
   * `askId` 由编排层用 `randomUUID()` 生成（一进程内不重复），故这一格不需要过期时间：
   * 命中它只可能是「同一个 id 的第二份提交」。代价如实登记：随进程寿命单调增长，
   * 每条约几十字节，而一场评测的提问次数是人手点出来的量级——一份名单换一个准确的 409 是划算的。
   */
  answered: Set<string>;
  /** 名单的出生标记（见 `answered`）：本模块实例的标识，模块被重建时不匹配即清空名单 */
  answeredEpoch: number;
}

/** 键名必须全局唯一：与既有三条总线同一个命名空间，撞名会把两张表悄悄并成一张 */
const REGISTRY_KEY = '__aievalAskUserRegistry';
type GlobalWithRegistry = typeof globalThis & { [REGISTRY_KEY]?: AskUserRegistry };
const globalWithRegistry = globalThis as GlobalWithRegistry;
/**
 * 已答名单的出生标记（见 `answeredEpoch`）：每次模块求值都是一个新值。
 * dev 的 HMR 换掉本模块时，上一实例留下的名单对应的是上一批等待方，对本实例没有意义 ⇒ 清掉。
 * 用时间戳而不是随机数：同一毫秒内重建两次模块（HMR 连打）的分辨率问题不存在——
 * 那种情形下两份名单本来就都只含「刚刚答过的那几个 id」。
 */
const epoch = Date.now();
globalWithRegistry[REGISTRY_KEY] ??= { entries: new Map(), subscribers: new Set(), answered: new Set(), answeredEpoch: epoch };
const registry: AskUserRegistry = globalWithRegistry[REGISTRY_KEY];
if (registry.answeredEpoch !== epoch) {
  registry.answered = new Set();
  registry.answeredEpoch = epoch;
}

/**
 * 发布一条「待答清单变了」：**同步**、不落盘、无负载（口径 4）。
 * 三个发射点都在本模块内（登记 / 答复 / 取消），订阅者抛错只记日志——
 * 一个坏订阅者不能打断其余订阅者，更不能因此让一次应答失败（与 `publishRunChanged` 同一口径）。
 */
export function publishAskUserChanged(): void {
  // 先复制一份再遍历：订阅者在回调里退订是合法用法，遍历原集合会漏掉后续订阅者
  for (const listener of [...registry.subscribers]) {
    try {
      listener();
    } catch (error) {
      log.error('待答信号订阅者抛错（其余订阅者不受影响）', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 订阅**后续**的变更信号，返回退订函数（可重复调用）。
 * 不回放历史：信号没有序号、不可续订，要当前状态就读快照。
 */
export function subscribeAskUserChanges(listener: AskUserChangedListener): () => void {
  registry.subscribers.add(listener);

  return () => {
    registry.subscribers.delete(listener);
  };
}

/** 当前待答清单（插入顺序 = 提问顺序）；**只含还没答的**——答完、取消、超时都在 `settle` 里出表 */
export function listPendingAskUser(): PendingAskUser[] {
  return [...registry.entries.values()].map((entry) => ({
    askId: entry.askId,
    runId: entry.runId,
    candidateId: entry.candidateId,
    stage: entry.stage,
    questions: entry.request.questions,
    askedAt: entry.askedAt,
  }));
}

/** 一次提问的收场（与 agents 包的 `AskUserReply` 同形；本包不 import 它，见文件头依赖方向） */
export interface AskUserSettled {
  outcome: AskUserOutcome;
  answers: AskUserAnswer[] | null;
}

/**
 * 把「收场方式 + 可选答案」折成两格成对的收场。
 * **只有 `answered` 那一档带答案数组**，其余六档一律 `null`——`answers: []` 说的是
 * 「有人答了、但一个选项都没选」，拿它冒充「等超时」会让落盘的收场标记再也说不清有没有人答过。
 */
function toSettled(outcome: AskUserOutcome, answers: AskUserAnswer[] | null): AskUserSettled {
  return { outcome, answers: outcome === 'answered' ? (answers ?? []) : null };
}

/** 登记入参（`askId` 由调用方生成并同时交给厂商那一侧，表不自己发号） */
export interface RegisterAskUserInput {
  askId: string;
  runId: string;
  candidateId: string | null;
  stage: AskUserStage;
  request: PendingAskUserRequest;
  /** 候选终止信号：一旦中止，这一问当场落「随本轮取消」并出表 */
  signal?: AbortSignal;
}

/** 一次挂起登记的句柄：拿在调用方手里的收场 promise 与清理入口 */
export interface PendingAskHandle {
  /**
   * 这一问的收场。**恒 resolve、不 reject**：没人答（超时 / 候选终止 / 取消）与候选失败是两件事，
   * 折成 reject 会让调用方把「没人答」写进行的失败归因（与 `AskUserReply` 的口径一致）。
   */
  outcome: Promise<AskUserSettled>;
  /**
   * 结束这一问（幂等）。取消与超时都走它；`resolveAskUser` 内部也走同一条收口。
   * 已经结束过的 `askId` 再调一次是空操作。
   */
  settle: (outcome: AskUserOutcome, answers?: AskUserAnswer[] | null) => void;
}

/**
 * 登记一个待答提问，并返回它的收场 promise。
 *
 * `askId` 重复登记是**调用方的编程错误**（一个 id 对应两次等待，后一个答复会去向不明），
 * 故直接抛错而不是覆盖：覆盖的症状是「第一次提问永远等不到答案」，且没有任何日志能说明原因。
 *
 * 已经中止的 `signal` 不能登记——它一进表就该落「随本轮取消」，留在表里会让快照显示一条
 * 永远不会被答复的提问。
 */
export function registerAskUser(input: RegisterAskUserInput): PendingAskHandle {
  const { askId, runId, candidateId, stage, request, signal } = input;

  if (registry.entries.has(askId)) {
    throw new ServiceError('CONFLICT', '这一问已经在等待答复了（askId 重复登记）', { context: { askId } });
  }

  let settled = false;
  let conclude: (outcome: AskUserOutcome, answers: AskUserAnswer[] | null) => void = () => {};

  /**
   * 唯一收口：**先出表、再决议**。
   * 顺序不能反——决议会让等待方在同一微任务里继续跑（可能立刻登记下一问），
   * 那时旧记录若还在表里，快照会短暂地同时显示两问。
   */
  const settle = (outcome: AskUserOutcome, answers: AskUserAnswer[] | null = null): void => {
    if (settled) return;
    settled = true;
    registry.entries.delete(askId);
    conclude(outcome, answers);
    publishAskUserChanged();
    log.info('待答提问已收场', { askId, runId, candidateId, stage, outcome });
  };

  // 已经中止的等待方不该在表里留痕：直接落收场，登记这一步等于空操作
  if (signal?.aborted === true) {
    log.debug('登记时就已中止：直接落「随本轮取消」，不进表', { askId, runId, candidateId });
    return { outcome: Promise.resolve(toSettled('canceled', null)), settle };
  }

  const outcome = new Promise<AskUserSettled>((resolve) => {
    conclude = (settledOutcome, answers) => resolve(toSettled(settledOutcome, answers));
  });

  registry.entries.set(askId, {
    askId,
    runId,
    candidateId,
    stage,
    request,
    askedAt: new Date().toISOString(),
    resolve: settle,
  });
  publishAskUserChanged();
  log.info('登记待答提问', { askId, runId, candidateId, stage, questionCount: request.questions.length, toolName: request.toolName });

  // 订阅候选终止信号：终止后这一问出表（口径 3 的「不是静默悬挂」在候选内的那一半）
  signal?.addEventListener(
    'abort',
    () => {
      log.debug('候选终止：这一问落「随本轮取消」', { askId, runId, candidateId });
      settle('canceled');
    },
    { once: true },
  );

  return { outcome, settle };
}

/** 待答清单的读侧投影（与 `PendingAskUser` 同形，避免调用方各拼一遍） */
export function listPendingAskUserEntries(): PendingAskUserEntry[] {
  return [...registry.entries.values()];
}

/**
 * 按 `askId` 校验一份答案：**逐问对上**（数量、顺序、`header` 三者都对）。
 *
 * 为什么不宽容：答案按 `header` 与问题配对，错位一次就是「答案配到了另一个问题上」。
 * 数量对但顺序不同（同一份答案换个次序）照样是错位——回灌进厂商钩子的那一份是按位置对齐的。
 */
function assertAnswersMatch(entry: PendingAskUserEntry, answers: AskUserAnswer[]): void {
  const headers = entry.request.questions.map((question) => question.header);
  const submitted = answers.map((answer) => answer.header);
  if (headers.length !== submitted.length || headers.some((header, index) => header !== submitted[index])) {
    throw new ServiceError('INVALID_QUERY', '答案与问题对不上（数量与顺序都要逐问一致）', {
      context: { askId: entry.askId, expected: headers, submitted },
    });
  }
}

/**
 * **唯一写入口**：提交一份答案数组，收场这一问并返回它的收场结果。
 *
 * 幂等三条（`askId` 是幂等键）：
 *   · **首个生效**：先到的应答按顺序校验答案、出表、决议（返回 `answered` + 答案），
 *     同时把 `askId` 记进已答名单；
 *   · **后到 409**：这一问已经在已答名单里 ⇒ `CONFLICT`。那是并发两份提交（多标签页、
 *     或双击了「完成」），不是打错了 id，故 `CONFLICT` 而不是 `NOT_FOUND`。两者的客户端动作相反：
 *     409 该提示「已经答过了」，404 该让客户端刷新快照；
 *   · **未知 404**：从没登记过、或已被取消 / 超时收场的 id ⇒ `NOT_FOUND`。
 *     取消与超时不进已答名单：那一问**没有**被谁答过，此时到的人与「从没问过」是同一件事。
 *
 * 「这份答案逐问对不上」在**取走记录之前**校验：答错形状不该消耗掉这一次应答机会——
 * 出表之后这一问就再也答不了了，而 400 是客户端可以立刻改一版重发的错。
 */
export function resolveAskUser(askId: string, answers: AskUserAnswer[]): { askId: string; answeredAt: string } {
  if (registry.answered.has(askId)) {
    throw new ServiceError('CONFLICT', '这一问已经答过了（首个应答生效，后到的提交不再处理）', { context: { askId } });
  }

  const entry = registry.entries.get(askId);
  if (entry === undefined) {
    throw new ServiceError('NOT_FOUND', '这一问不在待答清单里（可能已取消、已超时，或服务重启过）', {
      context: { askId },
    });
  }

  assertAnswersMatch(entry, answers);

  // 先记名单再决议：决议会让等待方在同一微任务里继续跑，那一侧可能立刻发起下一次提问
  registry.answered.add(askId);
  // 决议函数收「收场方式 + 答案」：表存的是决议函数，答案随它一次性交给等待方
  entry.resolve('answered', answers);
  const answeredAt = new Date().toISOString();

  return { askId, answeredAt };
}

/**
 * **仅供用例**：清空挂起表与已答名单，并卸掉所有订阅者。
 *
 * 为什么需要它：表与名单都挂 `globalThis`（口径 1），于是它们**跨用例、跨测试文件**活下来——
 * 上一条用例留下的待答提问会让下一条的快照断言多一条，上一条答过的 `askId` 会让下一条
 * 同名 id 的提交变成 409。既有三条总线没有这个东西，是因为它们的残留只表现为「多投递几条」，
 * 而本表还兼着幂等判据。
 *
 * 为什么要有 `NODE_ENV` 闸：它是测试脚手架，不是产品入口。产品侧没有任何调用点
 * （清表等于把在等的用户丢下），故在非测试环境下调用直接抛错——一个只该出现在
 * 用例里的名字被生产代码调到，必须是当场可见的失败。
 */
export function resetAskUserForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetAskUserForTesting 只能用在用例里（它会清掉在等的提问）');
  }
  registry.entries.clear();
  registry.answered.clear();
  registry.subscribers.clear();
}
