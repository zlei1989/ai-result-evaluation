/**
 * 人工消息的**落点与等待窗口**：端口实现（`InjectionPort` 四格）、一条消息真正交给厂商那一刻的
 * 落盘（账本 + 候选级事件）、以及「适配器已收工、只剩队列」时那一段的预算。
 *
 * 为什么与 `inject-queue.ts` 分两个模块：那是**表**（四态迁移，谁都不许绕过它写状态），
 * 这是**表外面的两件事**——落盘口径与时间口径。与提问应答面同一条切法
 * （`ask-user.ts` 管挂起表、`ask-user-settlement.ts` 管落盘与预算）。
 *
 * 五条口径（改本模块之前先读完）：
 *
 *   1. **账本记的是「模型真收到了什么」**：落盘挂在 `markDelivered` 那一刻，「人点了发送」与
 *      「适配器真交出去」是两份不同的账。未投递期间**账本一个字都不写**，界面靠队列表自己显示。
 *   2. **落盘失败只留 ERROR、不改写交回厂商的那一份**（与提问应答面逐字同源）：一次磁盘抖动
 *      不该让一条已经交出去的消息看起来「没交出去」。
 *   3. **落盘过与事件/消息同一条终态闸门**（`landingOpen`）：行已落终态之后，适配器收尾期
 *      吐出来的一律不落（它们会把「已结束」的日志拖长）。
 *   4. **事件与消息共用同一把钥匙**（`messageId`）：它是客户端为这一条生成的那个 id，
 *      同时是登记时的幂等键——三处（表 / 账本 / 事件）因此能互相追回。
 *   5. **预算不是兜底，是主力**：能把「已收工的一轮」唤醒的家今天一家都没接线 ⇒ 一条投不出去的
 *      消息最后由预算收场（落 `gone` + 一条候选级事件）。没有它，一个被遗忘的排队项会把这个候选永远挂住。
 *
 * 三条已知边界（如实登记）：
 *   · **重启即无从投递**：表是内存的，服务端重启后旧条目不存在（与挂起表同口径，不做持久化欠条）；
 *   · **`consumed` 是惰性判定**：只在撤回尝试拿到「已经交出去了」时才知道（不做持续对账）；
 *   · **`'idle'` 档在本轮收场那一刻才登记**：同一条运行内几乎没有「撤回窗口」——这不是缺陷，
 *     是契约里 `'idle'` 的定义（这一整轮没活可干了）的必然结果。
 */
import { statSync } from 'node:fs';
import type { AgentMessage, AgentEvent, InjectMessageOutcome, RetractOutcome, TurnInjectionCapability } from '@aieval/contracts';
import { carrierKeyOf, DEFAULT_INJECT_WAIT_BUDGET_MS, type InjectionPort, type UserMessage } from '@aieval/agents';
import { createLogger } from '@aieval/core';
import { publishCandidateEvent } from './events';
import { publishCandidateMessage } from './candidate-messages';
import {
  discardUndeliveredInjectEntries,
  enqueueInjectMessage,
  expireUndeliveredInjectEntries,
  hasUndeliveredInjectEntries,
  isUndelivered,
  listInjectEntries,
  markInjectEntriesDelivered,
  promoteInjectEntry,
  resetInjectQueueForTesting,
  retractInjectEntry,
  subscribeInjectChanges,
  takeInjectEntries,
  type InjectAttachment,
  type EnqueueInjectInput,
  type EnqueueInjectResult,
  type InjectQueueEntry,
  type InjectRetractResult,
  type PromoteInjectResult,
} from './inject-queue';

const log = createLogger('inject-port');

/**
 * 等待窗口的时间口径。写成**可变对象**是为了用例（十分钟级的等待在用例里必须能压小），
 * 产品默认值另有一条独立用例钉住。
 *
 * `leadMs` 就是提问应答面那条「编排层早一秒」：端口那一侧的缺省预算是
 * `DEFAULT_INJECT_WAIT_BUDGET_MS`，而**表由编排层收**——两条计时器同时到点时谁先响由注册顺序决定，
 * 输的那一侧意味着「表里留着一条再也投不出去的东西」。
 */
export const INJECT_WAIT = {
  budgetMs: DEFAULT_INJECT_WAIT_BUDGET_MS,
  leadMs: 1_000,
};

/**
 * 「队列非空 ⇒ 这个候选先不收场」的**能力分派**（判据写成纯函数，好独立断言）。
 *
 * 两条路只差一件事：这一家声明了「已收工的一轮还能被唤起来接着投」（`turnInjection` 的
 * `delivery.idle` 那一格）**并且**调用方真的把那条唤醒路径接上了。两条都成立才走唤醒，
 * 否则等这一批的等待预算——**绝不假装投递成功**：没接通的路径不会让任何一条悄悄变成「已送达」。
 *
 * 为什么把「接没接」也算进判据：能力声明说的是厂商那一侧收不收得到，而「我们有没有那条路」
 * 是这一侧的实现事实。只看声明会让界面与编排层都以为「队列非空就会自动继续跑」，而实际只会等超时。
 */
export function resolveIdleWithPending(input: {
  /** 声明面；`null` / 缺席都读作「不知道」⇒ 不走唤醒（猜错会让一条投不出去的消息看起来投出去了） */
  declaration: TurnInjectionCapability | null | undefined;
  /** 起新一轮的入口（第二期的 `followUpCandidate`）；`null` = 这一侧还没接 */
  wake: (() => Promise<void>) | null;
}): 'wake' | 'budget' {
  if (input.wake === null) return 'budget';
  return input.declaration?.delivery.idle.state === 'yes' ? 'wake' : 'budget';
}

/** 一条附件的字节数；读不到（文件被删 / 权限）返回 `null`——提示词里就不写大小，**不猜一个数** */
export function readAttachmentSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * 这个候选的人工消息落盘时要用到的四格（由编排层给，因为它才知道「这个候选还剩不收记录」「现在跑到第几轮」
 * 与「这是第几段」）。前三格与 `AskUserSettlementOptions` 的对应三格一一对应。
 */
export interface InjectionLanding {
  /**
   * 落盘闸门（口径 3）：行已落终态时返回 `false`。
   * 由编排层给（闸门的状态面在它那儿），本模块只在落盘前问一次。
   */
  landingOpen: () => boolean;
  /**
   * 这个候选当前的**模型往返序号**（这条人话落回它自己那一轮）：取当前已知的最大主会话轮号；
   * 拿不到时给 `null`（此时记在第 1 轮）。
   */
  roundTripHere: () => number | null;
  /**
   * 一条或几条人工消息**真的交给厂商**之后叫一次（`count` 是本次条数）：
   * 编排层据此把候选快照的「人工追问 ×N」加上去——**与候选级事件在同一段代码里**发生，
   * 两处因此不会漂（漂的表现是卡片上的数与账本对不上）。
   */
  noteDelivered: (count: number) => void;
  /**
   * 本端口服务的**那一段**（`AgentMessage.segment`）：首次跑那一段缺省 0，第 n 次追问那一段给 n。
   *
   * 为什么要传进来：追问是又开一次 `run()`，厂商轮次从 1 重新数 ⇒ 同一轮号在两段里各有一条消息，
   * 而折叠按 `(segment, mergeKey)` 走。少这一格时，人在追问段里插的话会落进首段同号的那一轮
   * （位置错），且与服务端折叠对不上。
   */
  segment?: number;
}

/** 端口实现的入参：行身份 + 落盘口径（`sizeOf` 只给用例换，产品侧读盘） */
export interface InjectionPortOptions extends InjectionLanding {
  runId: string;
  candidateId: string;
  /** 读附件大小的口子（用例用它让提示词拼装脱离磁盘；缺省 `readAttachmentSize`） */
  sizeOf?: ((path: string) => number | null) | undefined;
}

/**
 * 这一条在**消息账本**里的那一半。
 *
 * 形状与适配器投递的消息逐字同形（只有 `origin` / `source` / `raw` 说了实话）：
 *   · `role: 'user'` + `origin: 'human'`——与人写的题面同形，唯一的区别就是这一格
 *     （复盘时「哪句是出题人写的、哪句是人在半路插的」只能靠它分开）；
 *   · `source: 'hook'`：数据来自**我们自己的宿主通道**（人从界面上发的话），不是厂商 wire
 *     投送的——与 dsh 那条插件旁路、与提问答复那一半同一个取值；
 *   · `blocks` 里**只有人写的那句话**（附件另成块）：提示词里那份带路径与大小的清单是给模型的，
 *     账本这一半要的是「人发了什么」；
 *   · `mergeKey` 在既有载体键之后**接一段 `|inject:<messageId>`**：两条人话可能落在同一轮、
 *     同一个角色、都没有父调用 ⇒ 按原式算出的键会**完全相同**，读侧按它覆盖式累积时
 *     后一条会把前一条盖掉（人明明说了两句，界面上只剩一句）。载体键的语义是「这些记录属于
 *     同一条逻辑消息」，而两条不同的人话本就是两条逻辑消息——补上身份那一段才是它该有的样子。
 *     这一条只写一次快照、没有增量，故补段不影响任何折叠。
 *
 * `segment` 那一段后缀只在追问段里补（见 `InjectionPortOptions.segment`）：段号本身由折叠键带着，
 * 但同一条人话的载体键在两段里会逐字相同，读侧折叠时仍要靠段号区分——两处是同一件事的两半。
 */
function deliveredMessage(entry: InjectQueueEntry, roundTrip: number, landing: InjectionLanding): AgentMessage {
  return {
    // 三处共用同一把钥匙：队列表的条目、这一条记录、那一条候选级事件（见文件头口径 4）
    messageId: entry.messageId,
    vendorId: null,
    role: 'user',
    source: 'hook',
    origin: 'human',
    ...(landing.segment === undefined ? {} : { segment: landing.segment }),
    roundTrip,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: `${carrierKeyOf({ subagentId: null, roundTrip, role: 'user', parentCallId: null })}|inject:${entry.messageId}`,
    blocks: [
      { type: 'text', text: entry.text },
      ...entry.attachments.map((attachment) => ({
        type: 'attachment' as const,
        kind: attachment.kind,
        path: attachment.path,
        mimeType: attachment.mimeType,
      })),
    ],
    usage: null,
    raw: {
      author: 'inject-port',
      requires: entry.requires,
      // 附件只记清单（路径与类型）：**绝不把文件内容写进日志或事件**
      attachments: entry.attachments,
      roundTripFrom: landing.roundTripHere(),
    },
  };
}

/**
 * 一条 `inject-message` 候选级事件（`outcome` 与 `reason` 成对：投递 / 撤回无原因，其余三态必给）。
 * 返回的是**草稿**（`seq` / `at` 由事件日志写入器补），与编排层别处发事件的形状一致。
 */
function injectEventOf(entry: InjectQueueEntry, outcome: InjectMessageOutcome, reason: string | null): Omit<Extract<AgentEvent, { type: 'inject-message' }>, 'seq' | 'at'> {
  return { type: 'inject-message', messageId: entry.messageId, requires: entry.requires, outcome, reason };
}

/**
 * 把一批**真的交给厂商**的条目落盘（账本 + 候选级事件 + 计数）。
 *
 * 三处各自 try/catch：任何一处失败都只留 ERROR（口径 2）——消息已经交出去了，
 * 落盘是记录，不该反过来改写「模型收到了什么」这个事实。
 */
function landDelivered(runId: string, candidateId: string, entries: readonly InjectQueueEntry[], landing: InjectionLanding): void {
  if (entries.length === 0) return;
  if (!landing.landingOpen()) {
    // 行已落终态 ⇒ 这几条记录不进账本、事件也不落（口径 3），但计数照旧由调用方按事实维护
    log.debug('行已落终态：这一批人工消息不再落盘（它们照常已经交给厂商）', {
      runId,
      candidateId,
      messageIds: entries.map((entry) => entry.messageId),
    });
    return;
  }
  const roundTrip = Math.max(landing.roundTripHere() ?? 1, 1);
  for (const entry of entries) {
    try {
      publishCandidateMessage(runId, candidateId, deliveredMessage(entry, roundTrip, landing));
    } catch (error) {
      log.error('人工消息没能落进消息账本（它已经交给厂商，结论不受影响）', {
        runId,
        candidateId,
        messageId: entry.messageId,
        requires: entry.requires,
        error,
      });
    }
    try {
      publishCandidateEvent(runId, candidateId, injectEventOf(entry, 'delivered', null));
    } catch (error) {
      log.error('人工消息的事件没能落盘（消息已在账本里）', {
        runId,
        candidateId,
        messageId: entry.messageId,
        error,
      });
    }
  }
  /**
   * 计数与上面两条落盘**同一段代码**（`followUps` 的快照口径就是「与账本对齐」）。
   * 单独兜一层：它失败与「这一批没交出去」是两件事——消息已经交出去了，
   * 只是快照上的那个数没跟上（账本才是主事实）。
   */
  try {
    landing.noteDelivered(entries.length);
  } catch (error) {
    log.error('人工消息已交付，但候选快照的计数没能加上去（账本是主事实）', {
      runId,
      candidateId,
      messageIds: entries.map((entry) => entry.messageId),
      error,
    });
  }
}

/**
 * 登记一条人工消息（**唯一的入表口**，幂等由表负责）。
 * 包装成薄薄一层是为了让消费方（api 的功能层）只 import 本模块，不必知道表在哪。
 */
export function registerInjectMessage(input: EnqueueInjectInput): EnqueueInjectResult {
  const result = enqueueInjectMessage(input);
  log.info(result.created ? '登记人工消息' : '人工消息重复登记（幂等命中，不新增不重投）', {
    runId: input.runId,
    candidateId: input.candidateId,
    messageId: input.messageId,
    requires: input.requires,
    attachmentCount: input.attachments.length,
  });
  return result;
}

/**
 * 「立即发送」：把这一条的要求由「排队」改成「立即」（**单向**：只能变早不能变晚）。
 * 薄包装的理由与 `registerInjectMessage` 同：端点那一层只 import 本模块，不必知道表在哪。
 */
export function promoteInjectMessage(runId: string, candidateId: string, messageId: string): PromoteInjectResult {
  const result = promoteInjectEntry(runId, candidateId, messageId);
  log.info('人工消息改期（立即发送）', { runId, candidateId, messageId, result });
  return result;
}

/**
 * 造这个候选的注入端口（编排层交给 `agentProvider.run` 的那一格）。
 *
 * 四格逐格交代：
 *   · `available: true`——造它就意味着这一轮开了闸门（不开时编排层根本不会造，骨架另有「关闭档」）；
 *   · `drain`——按契约的取件规则取件（表那一侧），**不抛**：表读坏了也只记 ERROR 并回空表，
 *     一个坏掉的表不该让适配器的收尾路径炸掉；
 *   · `markDelivered`——**真的交给厂商之后**才调：写「已交付」时刻、落盘、计数；
 *   · `retract`——编排层发起撤回时走它（结果如实返回，四值里没有「抛错」这一档）。
 */
export function createInjectionPort(options: InjectionPortOptions): InjectionPort {
  const { runId, candidateId } = options;
  const sizeOf = options.sizeOf ?? readAttachmentSize;

  return {
    available: true,
    drain: (boundary): UserMessage[] => {
      try {
        return takeInjectEntries(runId, candidateId, boundary, sizeOf);
      } catch (error) {
        log.error('取件时表读坏了（这一次当作没取到，条目仍在表里）', { runId, candidateId, boundary, error });
        return [];
      }
    },
    markDelivered: (ids, retract): void => {
      try {
        const marked = markInjectEntriesDelivered(runId, candidateId, ids, retract);
        landDelivered(runId, candidateId, marked, options);
      } catch (error) {
        log.error('登记「已交付」失败（条目仍在表里等下一次机会）', { runId, candidateId, ids, error });
      }
    },
    retract: (id) => retractInjectMessage(runId, candidateId, id).then(retractOutcomeOf),
  };
}

/**
 * 表那一侧的分派结论 → 端口契约的四值（`RetractOutcome`）。
 *
 * 两处映射不是随意的：
 *   · `gone` ⇒ `'retracted'`——那一条已经不在任何队列里了（已撤回或已被预算丢弃），
 *     对「还能不能要回来」的如实回答就是「它回不来了」；
 *   · `not-found` ⇒ `'unknown'`——端口这一层说不出「这个 id 从来不存在」（那是 HTTP 面的事，
 *     404 归端点），这里只有「撤不到、也说不出为什么」这一档。
 */
function retractOutcomeOf(result: InjectRetractResult): RetractOutcome {
  switch (result.kind) {
    case 'removed':
    case 'retracted':
    case 'gone':
      return 'retracted';
    case 'consumed':
      return 'already-consumed';
    case 'unsupported':
      return 'unsupported';
    case 'unknown':
    case 'not-found':
      return 'unknown';
  }
}

/**
 * 撤回一条（含落盘）：编排层的撤回端点（与「删除未投递项」是同一个动作）走它。
 *
 * 只有**状态真的变了**的那两种结果才落候选级事件（`retracted` / `already-consumed`）：
 * `unsupported` / `unknown` 什么都没改变，落一条「已撤回」的事件会说假话。
 */
export async function retractInjectMessage(runId: string, candidateId: string, messageId: string): Promise<InjectRetractResult> {
  const result = await retractInjectEntry(runId, candidateId, messageId);
  if (result.kind === 'not-found') return result;
  const entry = result.entry;
  try {
    if (result.kind === 'removed' || result.kind === 'retracted') {
      publishCandidateEvent(runId, candidateId, injectEventOf(entry, 'retracted', null));
    } else if (result.kind === 'consumed') {
      publishCandidateEvent(runId, candidateId, injectEventOf(entry, 'already-consumed', entry.reason));
    }
  } catch (error) {
    log.error('撤回的事件没能落盘（撤回结果本身照常返回）', { runId, candidateId, messageId, kind: result.kind, error });
  }
  log.info('人工消息撤回结果', { runId, candidateId, messageId, kind: result.kind });
  return result;
}

/**
 * 行落终态：把还没投递的条目落 `gone`（原因「这个候选已经结束」）+ **各落一条候选级事件** + 清表。
 *
 * 与下面的「等待预算」是**两件事**：这条管「这个候选真的收场了，剩下的怎么办」，
 * 那条管「适配器已收工、只剩队列时还要等多久」。两者都落 `gone`，原因不同。
 * 事件写不进去只记 ERROR（候选状态那一次写入才是权威，不能被一条观测事件顶掉）。
 */
export function settleInjectQueueOnCandidateEnd(runId: string, candidateId: string): number {
  const discarded = discardUndeliveredInjectEntries(runId, candidateId);
  for (const entry of discarded) {
    try {
      publishCandidateEvent(runId, candidateId, injectEventOf(entry, 'discarded', entry.reason));
    } catch (error) {
      log.error('候选收场时的人工消息事件没能落盘（条目已落 gone）', { runId, candidateId, messageId: entry.messageId, error });
    }
  }
  if (discarded.length > 0) {
    log.warn('行已收场：未投递的人工消息按「这个候选已经结束」丢弃', {
      runId,
      candidateId,
      messageIds: discarded.map((entry) => entry.messageId),
    });
  }
  return discarded.length;
}

/** 等待窗口的落定方式：`empty` = 队列已空（照常收场）、`expired` = 预算到点（那一批已落 gone）、`canceled` = 候选终止 */
export type InjectWaitOutcome = 'empty' | 'expired' | 'canceled';

/** 等待窗口的入参（`budgetMs` 只给用例压小；产品取 `INJECT_WAIT`） */
export interface InjectWaitOptions {
  runId: string;
  candidateId: string;
  /** 候选终止信号：终止时窗口立刻落定（那一批的收场归候选收场那条路，这里不重复落） */
  signal: AbortSignal;
  /** 覆盖预算（毫秒）；缺省 = `INJECT_WAIT.budgetMs - INJECT_WAIT.leadMs` */
  budgetMs?: number | undefined;
}

/**
 * 开一个等待窗口：**「适配器已收工、只剩队列」那一刻**调它（起算点就是调用这一刻，
 * **不是**条目自己的 `createdAt`——那会把一轮跑 30 分钟时的一条正常排队项误杀）。
 *
 * 三件事里最先发生的那一件落定这个窗口：队列空了（照常收场）/ 预算到点（那一批落 `gone`
 * + 候选级事件）/ 候选终止（清场归候选收场那条路）。预算按 `INJECT_WAIT` 的「缺省十分钟 − 早一秒」算。
 */
export async function waitForInjectQueue(options: InjectWaitOptions): Promise<InjectWaitOutcome> {
  const { runId, candidateId } = options;
  if (!hasUndeliveredInjectEntries(runId, candidateId)) return 'empty';
  if (options.signal.aborted) return 'canceled';
  const budgetMs = options.budgetMs ?? Math.max(INJECT_WAIT.budgetMs - INJECT_WAIT.leadMs, 0);

  return new Promise<InjectWaitOutcome>((resolve) => {
    let done = false;
    let cleanup = (): void => {};
    /** 唯一收口：先摘监听与计时器，再落定（顺序不能反——落定会让等待方在同一微任务里继续跑） */
    function finish(outcome: InjectWaitOutcome): void {
      if (done) return;
      done = true;
      cleanup();
      resolve(outcome);
    }
    /**
     * 预算到点那一段**自己**在收那批条目，而收场会发变更信号——不挡一下的话，
     * 订阅支会在 `finish('expired')` 之前抢先答一句 `'empty'`（两句话对界面是不同的含义）。
     */
    let expiring = false;
    const off = subscribeInjectChanges(() => {
      if (expiring) return;
      // 只要「没有未投递的条目了」就收场：新到的条目也算未投递，故这里要整体判一次
      if (!hasUndeliveredInjectEntries(runId, candidateId)) finish('empty');
    });
    const onAbort = (): void => {
      finish('canceled');
    };
    const timer = setTimeout(() => {
      expiring = true;
      const expired = expireUndeliveredInjectEntries(runId, candidateId);
      for (const entry of expired) {
        try {
          publishCandidateEvent(runId, candidateId, injectEventOf(entry, 'timed-out', entry.reason));
        } catch (error) {
          log.error('等待预算到点时的事件没能落盘（条目已落 gone）', { runId, candidateId, messageId: entry.messageId, error });
        }
      }
      log.warn('人工消息等待预算到点：还没投递的条目按「等太久了」丢弃', {
        runId,
        candidateId,
        budgetMs,
        messageIds: expired.map((entry) => entry.messageId),
      });
      finish('expired');
    }, budgetMs);
    cleanup = (): void => {
      clearTimeout(timer);
      off();
      options.signal.removeEventListener('abort', onAbort);
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 这个候选还有没有没投递的人工消息（编排层判「队列非空 ⇒ 这个候选先别收场」用）。
 * 单独导出是为了让编排层不必 import 表的内部形状。
 */
export function hasPendingInjectMessages(runId: string, candidateId: string): boolean {
  return hasUndeliveredInjectEntries(runId, candidateId);
}

/** 快照面：这个候选的条目（含终态；`gone` 留着是为了让重复撤回答得出「已经处理过了」） */
export function listInjectMessages(runId: string, candidateId: string): InjectQueueEntry[] {
  return listInjectEntries(runId, candidateId);
}

export { isUndelivered, resetInjectQueueForTesting, subscribeInjectChanges };
export type {
  EnqueueInjectInput,
  EnqueueInjectResult,
  InjectAttachment,
  InjectQueueEntry,
  InjectRetractResult,
  PromoteInjectResult,
};
