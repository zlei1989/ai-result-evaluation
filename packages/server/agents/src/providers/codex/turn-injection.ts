/**
 * codex 的**两档注入接线**：人往运行中的一轮送话时，这一家把它交给谁。
 *
 * 两档各自的落点（本机 0.156.1 的 wire 与生成物）：
 *   · `'round'`（立即发送）⇒ **`turn/steer`**：消息插进**当前在途那一轮**，由厂商在下一次模型往返
 *     之前落点（`turn/steer` 自己不产新的 `turn/started`，所以我们不必替它找边界）；
 *   · `'idle'`（排队）⇒ **`thread/queue/add`**：登记进厂商线程自己的**耐久队列**，等该线程空闲后
 *     由厂商起新一轮时投出。
 *
 * 三条边界写在这里，因为它们决定了这个模块为什么长这样：
 *   1. **`'round'` 的有效范围是「本进程里 `turn/start` 已起、尚未收场的那一轮」**：
 *      `expectedTurnId` 必须是**当前在途那一轮**（厂商 schema 原文见 `session.ts` 的 `steer`）。
 *      ⚠️ 这条约束**不等于**「续接之后没有在途轮」：续接走的是 `thread/resume` **再发一次
 *      `turn/start`**（见 `session.ts` 的 `startCodexSession`）⇒ 续接轮同样有在途轮、`'round'` 照样可用。
 *      接不回的只是**上一个进程**那一轮——它早已收场，拿它的 turn id 去 steer 会被拒
 *      （真机阴性 `-32600 no active turn to steer`）；
 *   2. **受理之后才算交付**：`markDelivered` 只在「厂商真的把这一轮跑起来」之后调——`'round'` 档看
 *      `turn/steer` 返回成功；`'idle'` 档看**起轮真的发生**：我们起轮成功（`thread/queue/start` 回了
 *      turn id），**或者**厂商自己把条目投了出去（`queue/list` 里已经没有它 ⇒ 见 `deliverIdle`）。
 *      两条都不是时**不假装投递成功**：那一条退回手上/留在队列里，由等待窗口按预算收场。
 *      ⚠️ **`'round'` 档的落点在「下一次模型往返之前」**（真机读数：`turn/steer` 1 ms 返回、
 *      **不打断**在途那次上游请求，那句话进**下一次**请求，且不产新的 `turn/started`）。
 *      推论有两条：① 它是**异步落点**，「RPC 回了 OK」与「模型看见了」之间隔着一次往返；
 *      ② 在**最终答复之后、`turn/completed` 之前**那个窗口里，厂商可能受理却再也投不出去
 *      （裸臂 24 样本命中 1 次）⇒ 这一档的交付判据天生弱于 `'idle'` 档，能力声明里它仍记
 *      `unverified` 正是这个意思，别把 `yes` 读出来；
 *   3. **撤回按身份、两档不一样**：`'idle'` 档交回厂商的 `queuedSubmission.id`（`thread/queue/delete`
 *      按它撤）；`'round'` 档**没有撤回面**（104 个方法里没有按身份收回在途 steer 的那一个，
 *      `turn/interrupt` 是无身份的全清）⇒ 那一档的撤回闭包如实回 `unsupported`。
 *
 * 本模块不认「队列」这个词（业务无关那一刀）：取件规则全在 `InjectionPort` 里，这里只按两档边界
 * 问它要人话。
 */
import { createLogger } from '@aieval/core';
import type { RetractOutcome } from '@aieval/contracts';
import type { InjectionPort, UserMessage } from '../../types';

const logger = createLogger('agents/codex/injection');

/** wire 面的五条出口（由 `appserver/session.ts` 提供；测试用假件顶替） */
export interface CodexInjectionWire {
  steer: (input: { text: string; messageId: string; expectedTurnId: string }) => Promise<void>;
  queueAdd: (input: { text: string; messageId: string }) => Promise<string>;
  queueDelete: (queuedSubmissionId: string) => Promise<boolean>;
  queueList: () => Promise<string[]>;
  /** 让厂商把队列里的一条起成一轮；`null` = 起队首那一条。回新那一轮的 id */
  queueStart: (queuedSubmissionId: string | null) => Promise<string>;
}

export interface CodexInjectionOptions extends CodexInjectionWire {
  /** 注入端口；`null` = 调用方没传（这一轮不进人工消息）——适配器**一格都不挂** */
  port: InjectionPort | null;
  /**
   * 当前**在途**那一轮的 id；`null` = 没有在途轮（尚未起轮 / 本轮已收场）。
   * 由调用方在流那一侧维护：它比这里更早看到 `turn/completed`。
   */
  activeTurnId: () => string | null;
}

/** 一条已经 `queueAdd` 过、厂商给了提交 id 的人话 */
interface QueuedSubmission {
  message: UserMessage;
  queuedSubmissionId: string;
}

/** 收场那一刻的投递结果：`continuedTurnId` 非 `null` = 厂商真的起了一轮，流要继续消费 */
export interface CodexSettledDelivery {
  /**
   * 新起那一轮的 id；`null` = 我们没有起轮（队列是空的 / 起不动），调用方据此收场。
   * ⚠️ 调用方还要自己比一次「它是不是**新**的」：线程忙时厂商回什么没有读数，
   * 只能按「回的 id 与刚收场那一轮相同 ⇒ 没起成」这条保守判据处置。
   */
  continuedTurnId: string | null;
  /**
   * **厂商那一侧还有我们交出去的东西在动**：流要继续跑，此刻不一定拿得到它的 turn id。
   *
   * 两档来源（都是真机读数）：
   *   · `thread/queue/add` 落在**空闲**线程上时，厂商在 add 那一刻就把条目投出去了
   *     （`queue/add` 响应回来时条目已不在队列里）⇒ 我们紧接着的 `thread/queue/start`
   *     必然拿到 `queue is empty`。若按「起轮失败」收场，`dispose` 会把它连同那句话一起杀掉
   *     （真机复现：`turn/started` 2 条、`turn/completed` 1 条、哨兵 0 次进请求体）；
   *   · 一批里**只被消费了一部分**（空闲线程上连交两条时必然）：剩下的躺在厂商的耐久队列里，
   *     当前轮收场后厂商会自己撒出去（真机读数：什么都不做也照样跑完、哨兵进了出站请求体）
   *     ⇒ 此刻也不能收场，否则那一条随 `dispose` 一起没。
   *
   * 约定：置 `true` 时 `continuedTurnId` 必为 `null`——turn id 由 `turn/started` 进流时补
   * （见 `index.ts` 的 onPayload），适配器在这一刻不需要它。
   */
  vendorDispatched?: boolean;
}

export interface CodexInjection {
  /** 通知流每推进一格时问一次：在途就把要求 `'round'` 的交给 `turn/steer`（不 await，串行排队） */
  onNotification: () => void;
  /** 本轮收场那一刻问一次：手上剩下的与端口里剩下的合起来交给厂商（要 await） */
  onTurnSettled: () => Promise<CodexSettledDelivery>;
  /** 收工前把在飞的投递等回来（释放路径；不抛） */
  settle: () => Promise<void>;
}

/** 什么都不做的接线：端口缺席或 `available === false` 时用它（「一格都不挂」的唯一形态） */
const INERT: CodexInjection = {
  onNotification: () => undefined,
  onTurnSettled: async () => ({ continuedTurnId: null }),
  settle: async () => undefined,
};

export function createCodexInjection(options: CodexInjectionOptions): CodexInjection {
  const { port } = options;
  if (port === null || !port.available) return INERT;

  /** 取出来了、厂商还没受理的那些（被拒时退回这里，收场时并入 `'idle'` 档那一批） */
  let carried: UserMessage[] = [];
  /**
   * **已 `queueAdd`、还没被厂商取走**的那些。
   *
   * 为什么要跨收场边界留着：一次 `drain('idle')` 交 ≥2 条是合法形状，而条目录在**空闲**线程上时
   * 厂商在 `add` 那一刻就把第 1 条撒成新一轮 ⇒ 第 2 条落在忙线程上只入队，我们紧接着的
   * `queue/start` 必然被拒（`thread already has an active or pending turn`）。此时第 2 条
   * **既没被消费、也没有失败**——它就躺在厂商的耐久队列里，等当前轮收场后由厂商自己撒出去
   * （真机读数：空闲线程连加两条、什么都不做 ⇒ 3 轮跑完、第 2 条的哨兵进了出站请求体）。
   * ⇒ 这一段代码的职责是「别丢、也别谎报」，等到它真被取走那一刻再登记交付。
   */
  let pendingQueued: QueuedSubmission[] = [];
  /** 每条消息怎么要回来（`'idle'` 档按厂商的提交 id）；只登记受理过的那些 */
  const retractors = new Map<string, (id: string) => Promise<RetractOutcome>>();
  /** 投递串行链：一次只发一条，且 `settle()` 要能等到链尾 */
  let chain: Promise<void> = Promise.resolve();
  /**
   * `'idle'` 档的撤回闭包：先按提交 id 删，删不到才去读一次队列。
   *
   * 为什么要读那一次：`thread/queue/delete` 只回 `{deleted:boolean}`，"已消费 / 已删过 / id 不对"
   * 三件事在它那里**分不开**（真机读数：删不到一律 `{false}` 且不报错）。读一次队列才能把
   * 「厂商赢了竞态（它已经不在队列里了）」与「撤不到也说不出为什么」分开——界面那两句话不一样。
   */
  const retractorFor = (messageId: string, queuedSubmissionId: string) => async (): Promise<RetractOutcome> => {
    try {
      if (await options.queueDelete(queuedSubmissionId)) {
        retractors.delete(messageId);
        return 'retracted';
      }
      const remaining = await options.queueList();
      return remaining.includes(queuedSubmissionId) ? 'unknown' : 'already-consumed';
    } catch (error) {
      logger.error('codex 撤回失败（按 unsupported 之外的最小结论如实回 unknown）', { error, messageId });
      return 'unknown';
    }
  };

  /** `'round'` 档的撤回闭包：这一档根本没有撤回面（见文件头第 3 条） */
  const roundRetract = async (): Promise<RetractOutcome> => 'unsupported';

  /**
   * 在途投递：取件 + 逐条 steer。
   * 失败（最常见的一支是「没有在途轮」）只记 WARN、**不登记**，那一条退回手上。
   *
   * **取件的节拍是通知边界**：端口只有 `drain` 一格、没有「有新消息」的信号，而骨架里也没有
   * 计时器给适配器用 ⇒ 一条在两次通知之间到达的人话要等下一格通知才交出去。这不改变它的**档位**：
   * `turn/steer` 由厂商在**下一次模型往返之前**落点，我们早发晚发几百毫秒，模型看到的位置一样。
   */
  async function deliverRound(): Promise<void> {
    const expectedTurnId = options.activeTurnId();
    // 没有在途轮 ⇒ 连件都不取：取出来就只能揣在手上，而端口的表才是「还没投」的真相源
    if (expectedTurnId === null) return;
    const messages = [...carried, ...port!.drain('round')];
    carried = [];
    for (const one of messages) {
      try {
        await options.steer({ text: one.text, messageId: one.id, expectedTurnId });
        retractors.set(one.id, roundRetract);
        port!.markDelivered([one.id], roundRetract);
      } catch (error) {
        carried.push(one);
        logger.warn('codex 在途注入被拒（该条改由队列兜住）', { error, messageId: one.id, expectedTurnId });
      }
    }
  }

  /**
   * 收场投递：手上剩下的 + 端口里剩下的（`drain('idle')` 取全部且要求 `'round'` 的排在前面）
   * 登记进厂商的耐久队列，**再让厂商把它起成一轮**——起轮成功才算交付。
   *
   * 三步顺序不能换，每一步都有它的理由：
   *   1. **先 `queueAdd` 全部**：拿到 `queuedSubmissionId` 才能在窗口期按身份撤（这一步保住
   *      `retract.idle = 'by-id'` 那条声明）；
   *   2. **再 `queueStart`（FIFO 起队首）**：这是"让它真的进模型上下文"的显式动作；
   *   3. **起轮成功之后才 `markDelivered`**：账本记的是「模型真收到了什么」，起不动就不许登记
   *      ——让编排层的等待窗口按预算如实收场（`gone`），而不是被我们提前绕过去。
   *
   * ⚠️ **`queueStart` 报 `queue is empty` 不是失败**（真机读数 + 上游语义）：条目录在一个**空闲**
   * 线程上时，厂商在 `queue/add` 那一刻就自己把它撒成了一轮（上游 README：*"dispatches the oldest
   * pending row … once the thread is idle"*；集成测试名就是 `queued_turns_drain_after_a_direct_turn_has_already_completed`）。
   * 判据是**条目还在不在可见队列里**（`queue/list`；真机正对照：忙线程上入队的条目会带**同一个 id**
   * 留在表里、`queue/delete` 也按它生效）：
   *   · **不在了** ⇒ 厂商已消费 ⇒ 按**交付成功**登记；
   *   · **还在** ⇒ **不是失败**：它在厂商的耐久队列里，当前轮收场后厂商会自己撒出去
   *     （真机读数：空闲线程连加两条、什么都不做 ⇒ 第 2 条照样进了出站请求体）⇒ 留在
   *     `pendingQueued` 里，由下一拍对账时再登记，**这一行继续跑**（`vendorDispatched`）。
   *
   * ⚠️ **一批里可以只有一部分被消费**——把这一批当整体处置就是一条静默丢话的缺陷
   * （真机复现 3/3：两条人话时第 2 条既不登记、也不回滚、也没人等它，随 `dispose` 一起没）。
   * 所以这里逐条对账、逐条判定，**没有「整批算成功」或「整批算失败」这一档**。
   */
  async function deliverIdle(): Promise<CodexSettledDelivery> {
    // 上一拍留下的那些先对一次账：厂商会在当前轮收场后把它们撒出去，那一刻它们才算交付
    const before = await reconcilePending();

    const messages = [...carried, ...port!.drain('idle')];
    carried = [];
    if (messages.length === 0) return keepAlive(before);

    const queued: QueuedSubmission[] = [];
    for (const one of messages) {
      try {
        queued.push({ message: one, queuedSubmissionId: await options.queueAdd({ text: one.text, messageId: one.id }) });
      } catch (error) {
        logger.warn('codex 队列登记失败（该条停在已登记未交付）', { error, messageId: one.id });
      }
    }
    if (queued.length === 0) return keepAlive(before);
    pendingQueued = [...before.remaining, ...queued];

    let startedTurnId: string;
    try {
      startedTurnId = await options.queueStart(null);
    } catch (error) {
      const after = await reconcilePending();
      /**
       * **本拍至少有一条被厂商取走 ⇒ 它起的轮正在跑 ⇒ 队列里的其余条目会被它在收场时撒出去**
       * ⇒ 不许收场（收场即 `dispose`，那些话连同那一轮一起没）。这一支正是「一批只被消费了一部分」
       * 那条真机缺陷的修复点：旧实现只要「有任意一条被消费」就整批返回，把剩下的留在原地无人认领
       * （真机读数：第 2 条既不登记、也不回滚、也没人等它，随 `dispose` 一起没）。
       */
      if (after.consumed > 0) {
        logger.debug('codex 队列条目已由厂商自己投递（不按起轮失败处置）', {
          error,
          consumed: after.consumed,
          stillQueued: after.remaining.map((one) => one.message.id),
        });
        return { continuedTurnId: null, vendorDispatched: true };
      }
      /**
       * 一条都没被取走：`queueStart` 失败而条目还躺在队列里（或队列读不回来 ⇒ 状态未知）。
       * 与过去逐字相同：**不登记交付、并从队列撤回**——「宁可少认一次交付，也不假报成功」。
       */
      logger.warn('codex 队列起轮失败（这一批按「没交付」处置：不登记、并从队列撤回）', {
        error,
        messageIds: after.remaining.map((one) => one.message.id),
      });
      for (const one of after.remaining) {
        try {
          await options.queueDelete(one.queuedSubmissionId);
        } catch (rollbackError) {
          logger.warn('codex 起轮失败后的回滚也没成功（条目留在厂商队列，随本行配置目录一起清理）', {
            error: rollbackError,
            queuedSubmissionId: one.queuedSubmissionId,
          });
        }
      }
      pendingQueued = [];
      return { continuedTurnId: null };
    }

    pendingQueued = [];
    for (const one of queued) registerDelivered(one);
    logger.debug('codex 队列已起轮，这一批人工消息进模型上下文', {
      turnId: startedTurnId,
      messageIds: queued.map((one) => one.message.id),
    });
    return { continuedTurnId: startedTurnId };
  }

  /** 登记交付：撤回闭包与端口两处一次写完（`'idle'` 档的两条路共用） */
  function registerDelivered(one: QueuedSubmission): void {
    const retract = retractorFor(one.message.id, one.queuedSubmissionId);
    retractors.set(one.message.id, retract);
    port!.markDelivered([one.message.id], retract);
  }

  /**
   * 把「已登记、还没被取走」的那些与**厂商可见队列**对一次账：不在表里的 ⇒ 厂商已经取走了
   * （= 真的投出去了，此刻才登记交付）；还在表里的 ⇒ 留着等下一拍。
   *
   * 两格返回值都要：`consumed > 0` 说明此刻有厂商起的轮在跑（这一行不能收场），
   * `remaining` 说明后面还会有轮（同样不能收场）——两者的**后续动作**相同，但排障时要分得开。
   * `queueList` 自己失败时**一条都不登记**（宁可晚一拍交付，也不假报）。
   */
  async function reconcilePending(): Promise<{ consumed: number; remaining: QueuedSubmission[] }> {
    if (pendingQueued.length === 0) return { consumed: 0, remaining: [] };
    let remainingIds: string[];
    try {
      remainingIds = await options.queueList();
    } catch (error) {
      logger.warn('codex 队列读不回来（这一批留到下一拍再对账，不登记交付）', { error });
      return { consumed: 0, remaining: pendingQueued };
    }
    const remaining: QueuedSubmission[] = [];
    let consumed = 0;
    for (const one of pendingQueued) {
      if (remainingIds.includes(one.queuedSubmissionId)) remaining.push(one);
      else {
        registerDelivered(one);
        consumed += 1;
      }
    }
    pendingQueued = remaining;
    return { consumed, remaining };
  }

  /**
   * 这一拍之后要不要让流继续跑。
   *
   * 判据是**厂商那一侧还有没有我们交出去的东西在动**：本拍消费掉了若干（那一轮正在跑），
   * 或者还有条目躺在厂商队列里（当前轮收场后它会自己撒出来）。两条都不是 ⇒ 收场。
   * 有界性由调用方兜：连续续跑有上限（`CODEX_IDLE_CONTINUATION`），等 `turn/started` 有预算
   * （`CODEX_VENDOR_TURN_WAIT`）⇒ 厂商真不动了也不会把这一行永久挂住。
   */
  function keepAlive(state: { consumed: number; remaining: QueuedSubmission[] }): CodexSettledDelivery {
    return state.consumed > 0 || state.remaining.length > 0
      ? { continuedTurnId: null, vendorDispatched: true }
      : { continuedTurnId: null };
  }

  /**
   * 把一次投递排进串行链；失败只记日志（投递这一路不许把一轮运行翻成失败）。
   * 返回值是**这一次投递的结果**（`deliverRound` 不带结果 ⇒ 包一层）。
   */
  const schedule = (work: () => Promise<CodexSettledDelivery>): Promise<CodexSettledDelivery> => {
    const next = chain.then(work).catch((error: unknown) => {
      logger.error('codex 注入投递异常（这一条不再重试）', { error });
      return { continuedTurnId: null };
    });
    chain = next.then(() => undefined);
    return next;
  };

  return {
    onNotification: () => {
      void schedule(async () => {
        await deliverRound();
        return { continuedTurnId: null };
      });
    },
    onTurnSettled: async () => {
      // 先等在途那一批落定：同一条消息在两条路上并发投两次就是双份
      await chain;
      return await schedule(deliverIdle);
    },
    settle: () => chain,
  };
}
