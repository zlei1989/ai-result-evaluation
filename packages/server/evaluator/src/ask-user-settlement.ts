/**
 * 提问的落盘端：一次提问收场之后，把它的**答案与收场方式**落进两处——
 * 候选消息账本的 `tool-result` 那一半，以及一条行级观测事件。
 *
 * 为什么单列成模块：编排层要交给适配器的 `onAskUser` 有**四件事**要做——登记进挂起表、
 * 等（行终止 / 预算 / 有人答）、落盘、把答复交回去。前三件的口径都与「这一问」无关地成立，
 * 且都要能在不跑一次评测的前提下读懂，故集中在 `createAskUserSettlement` 里。
 * 适配器那一侧只认「问一次、拿一个答复」，一个字都不用改（`@aieval/agents` 的提问端口）。
 *
 * 四条口径（改本模块之前先读完）：
 *
 *   1. **收场 promise 恒 resolve**（`registerAskUser` 的承诺）：没人答、等超时、随行取消
 *      都不是「行失败」，故这一格不抛、也不改变本次运行的结论。回调**抛错**才落「无人应答」
 *      ——那条路归端口（`ask-user.ts` 的规则 4），本模块不重复实现。
 *   2. **等待上限比端口自己那条兜底早一步到点**（见 `waitBudgetMs`）：端口到点只会「不再等」，
 *      它不认识挂起表；那一问若不先收掉，快照与弹层上会一直挂着一条再也答不了的提问。
 *   3. **答复是主事实，落盘是记录**：落盘失败只留 ERROR 日志，不许把「有人答了」改写成
 *      「无人应答」——一次磁盘抖动不该改掉模型看到的结论（这与事件/记录总线「落盘失败必须冒出去」
 *      的口径不冲突：那两处的调用方是适配器自己的流，抛出去有明确含义；这里是回调的返回值）。
 *   4. **落盘与交回答复是同一件事的两半**：`tool-result` 那一半（读侧卡片的产出方）与行级事件
 *      （收场方式 / 等待时长 / 提问通道）在同一个函数里写完，两处共用 `askId` / `callId`，
 *      谁也不许单独消失。
 *   5. **落盘过与事件/消息同一条终态闸门**（`landingOpen`）：行已落终态时适配器收尾期间吐出来的
 *      记录一律不落（既有口径，理由是它们会把「已结束」的日志拖长）。行终止让这一问落
 *      「随轮次取消」时正是这种情形——它从挂起表里消失（用户故事要的那一条），但那一条记录
 *      与那一条事件不进账本。
 *
 * 已知边界（留给对应票据，别在这里猜）：
 *   · **厂商自己收场那一档**（codex 的 `autoResolutionMs`、dsh 的 `timed`）今天没有回传通道：
 *     适配器结束那一问时不会通知回调，于是本模块的超时是那一档唯一会发生的收场，落 `timeout`
 *     而不是 `auto-resolved`。要如实落后者，得由那两家让适配器把厂商预算**提前**交出来
 *     （交一个更小的 `vendorBudgetMs`）或给端口加一条「被厂商收场」的收口。
 *   · **宿主工具那一档会落两条 `tool-result`**（我们这条 + 适配器自己那条，都是同一次调用的结果）：
 *     它们落在同一个合并键上（折叠留后到的那条），而两条都带着答复，故卡片两种情形都收得场。
 *      编排层无法知道适配器会不会自己投一条（那是各家实现），宁可重复也不赌。
 */
import { randomUUID } from 'node:crypto';
import type { AgentMessage, AskUserAnswer, AskUserChannel, AskUserQuestion } from '@aieval/contracts';
import { carrierKeyOf, DEFAULT_ASK_USER_BUDGET_MS, type AskUserReply, type AskUserRequest } from '@aieval/agents';
import { createLogger } from '@aieval/core';
import { registerAskUser, type PendingAskHandle } from './ask-user';
import { publishRowMessage } from './row-messages';
import { publishRowEvent } from './events';

const log = createLogger('ask-user-settlement');

/**
 * 编排层比端口自己那条兜底**提前**到点的毫秒数。
 *
 * 为什么必须早：端口到点只是「不再等这一问」，而**挂起表由编排层负责收**——两条计时器同时到点时
 * 谁先响由注册顺序决定（端口那条先注册），输的那一侧意味着「表里留着一条再也答不了的提问」。
 * 一秒足够大：它只是让「没人答」这件事早一秒尘埃落定，对十分钟级的等待没有可感影响。
 */
const BUDGET_LEAD_MS = 1_000;

/**
 * 这一问的等待上限：厂商给的预算优先（端口的兜底也是这么算的），否则取
 * `DEFAULT_ASK_USER_BUDGET_MS`；两者都减去提前量。
 *
 * 非正数一律读成「没给」（与端口的 `budgetOf` 逐字同一条口径）：契约明写 `0` 不许填，
 * 一个手滑的 `0` 不该让每一次提问当场落空。厂商给的预算比提前量还小时按 `0` 处理——
 * 那种预算下没有人来得及答，当场收场才是事实。
 */
export function waitBudgetMs(vendorBudgetMs: number | null): number {
  const base = typeof vendorBudgetMs === 'number' && vendorBudgetMs > 0 ? vendorBudgetMs : DEFAULT_ASK_USER_BUDGET_MS;
  return Math.max(base - BUDGET_LEAD_MS, 0);
}

export interface AskUserSettlementOptions {
  runId: string;
  rowId: string;
  /** 行终止信号（用户终止 / 看门狗 / 宿主停机都从它进来）：一中止这一问当场落「随轮次取消」 */
  signal: AbortSignal;
  /**
   * 这一家**声明**的提问通道（进观测事件）。它只是**声明**，不是每次运行的事实
   * （运行期只有适配器知道，`AskUserRequest` 里没有这一格）：适配器先接了而声明还没翻时它是 `null`。
   */
  channel: AskUserChannel | null;
  /**
   * 这一行当前的**模型往返序号**（答复落回它自己那一轮）：取当前已知的最大主会话轮号。
   * 拿不到时给 `null`（例如这一家不投送消息），此时答复记在第 1 轮。
   */
  roundTripHere: () => number | null;
  /**
   * 落盘闸门（口径 5）：这一行**还收不收记录**——行已落终态时返回 `false`。
   * 由编排层给（闸门的状态面在它那儿），本模块只在落盘前问一次。
   */
  landingOpen: () => boolean;
}

/**
 * 造这一行的 `onAskUser` 实现（编排层把它交给 `agentProvider.run`）。
 *
 * 一次调用做四件事：登记 → 等（行终止 / 预算 / 有人答）→ 落盘 → 交回答复。
 */
export function createAskUserSettlement(options: AskUserSettlementOptions): (request: AskUserRequest) => Promise<AskUserReply> {
  const { runId, rowId, signal } = options;

  /** 落盘：账本那一半 + 行级观测事件；失败只记日志（口径 3），两处各自留痕 */
  const land = (input: {
    askId: string;
    request: AskUserRequest;
    outcome: AskUserReply['outcome'];
    answers: AskUserAnswer[] | null;
    waitedMs: number;
  }): void => {
    // 行已落终态 ⇒ 这一条记录不再进账本（口径 5）：它与事件/消息走的是同一个闸门
    if (!options.landingOpen()) {
      log.debug('行已落终态：这一问的答复不再落盘（收场方式照常交回适配器）', {
        runId,
        rowId,
        askId: input.askId,
        callId: input.request.callId,
        outcome: input.outcome,
      });
      return;
    }
    try {
      publishRowMessage(runId, rowId, settlementMessage(input, options));
    } catch (error) {
      log.error('提问的答复没能落进消息账本（答复本身照常交回模型）', {
        runId,
        rowId,
        askId: input.askId,
        callId: input.request.callId,
        outcome: input.outcome,
        error,
      });
    }
    try {
      publishRowEvent(runId, rowId, {
        type: 'ask-user',
        askId: input.askId,
        callId: input.request.callId,
        toolName: input.request.toolName,
        channel: options.channel,
        outcome: input.outcome,
        waitedMs: input.waitedMs,
      });
    } catch (error) {
      log.error('提问的行级观测事件没能落盘（答复本身照常交回模型）', {
        runId,
        rowId,
        askId: input.askId,
        callId: input.request.callId,
        outcome: input.outcome,
        error,
      });
    }
  };

  return async (request) => {
    const askId = randomUUID();
    const askedAt = Date.now();
    /**
     * **子智能体不能向用户提问**：这一格由回调挡住，而不是靠各家适配器分别判——
     * 四家的判定依据不同（cc 看工具选项里的子智能体身份、dsh 侧厂商自己拒、宿主工具的会话面
     * 根本给不出这个事实），口径却必须是同一句话。不登记进表：那一问从来没有可答的对象，
     * 留在快照里只会让使用者对着一个不该存在的提问点「完成」。
     */
    if (request.subagentId !== null) {
      log.warn('子智能体发起的提问按「子智能体不能向用户提问」收场', {
        runId,
        rowId,
        toolName: request.toolName,
        callId: request.callId,
        subagentId: request.subagentId,
      });
      land({ askId, request, outcome: 'rejected', answers: null, waitedMs: 0 });
      return { outcome: 'rejected', answers: null };
    }

    const handle = registerAskUser({
      askId,
      runId,
      rowId,
      stage: 'agent',
      request: {
        questions: request.questions,
        toolName: request.toolName,
        callId: request.callId,
        vendorBudgetMs: request.vendorBudgetMs,
        subagentId: request.subagentId,
      },
      signal,
    });
    const settled = await settleWithinBudget(handle, request);
    const waitedMs = Date.now() - askedAt;
    log.info('提问已收场', { runId, rowId, askId, callId: request.callId, outcome: settled.outcome, waitedMs });
    land({ askId, request, outcome: settled.outcome, answers: settled.answers, waitedMs });
    return { outcome: settled.outcome, answers: settled.answers };
  };
}

/**
 * 等到这一问收场：行终止（表自己会落「随轮次取消」）与预算到点（这里落「超时」）都算收场，
 * 谁先到谁定。
 *
 * 预算那一条**由编排层落**（`handle.settle`）而不是干等：它是把这一问从挂起表里收掉的唯一出口，
 * 而端口的兜底不认识表（见文件头口径 2）。定时器在收场之后一定要清掉——不清就是个悬挂的计时器，
 * 一次评测问十次就攒十个。
 */
async function settleWithinBudget(handle: PendingAskHandle, request: AskUserRequest): Promise<{ outcome: AskUserReply['outcome']; answers: AskUserAnswer[] | null }> {
  const budgetMs = waitBudgetMs(request.vendorBudgetMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle.outcome,
      new Promise<{ outcome: AskUserReply['outcome']; answers: AskUserAnswer[] | null }>((resolve) => {
        timer = setTimeout(() => {
          log.warn('提问等待到点：这一问按超时收场（端口那一条兜底因此不再触发）', {
            callId: request.callId,
            toolName: request.toolName,
            vendorBudgetMs: request.vendorBudgetMs,
            budgetMs,
          });
          handle.settle('timeout');
          // `settle` 已经让 `handle.outcome` 落定，这里只是给 race 一个立刻可用的值（两者同值）
          resolve({ outcome: 'timeout', answers: null });
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 这一次提问的答复在**消息账本**里的那一条。
 *
 * 形状与适配器投递的消息逐字同形（只有 `source` 与 `raw` 说了实话）：读侧因此不必区分
 * 「谁写的这条记录」——账本里它就是一次工具调用的结果。
 *
 * 五格的取值理由：
 *   · `role: 'tool'` / `parentCallId: callId`：与 `tool-call` 配对的那一半（`callId` 是配对键）；
 *   · `mergeKey` 用 `@aieval/agents` 的 `carrierKeyOf` 算（账本里 `mergeKey` 那一格的唯一真源）：
 *     这一条要与适配器投递的那些落进同一个键空间，同一轮里同一次调用的结果才折叠成一条；
 *   · `source: 'hook'`：数据来自**我们自己的宿主通道**（人工应答），不是厂商 wire
 *     ——与 dsh 那条插件旁路同一个取值，而它正是「不是厂商投送的」这一档；
 *   · `raw` 记这一条的产者与定位（`askId` / 工具名 / 通道 / 等了多久）：排障时要能从这一格
 *     追回行级事件与弹层那一次提问，而不必靠时间戳去猜。
 */
function settlementMessage(
  input: {
    askId: string;
    request: AskUserRequest;
    outcome: AskUserReply['outcome'];
    answers: AskUserAnswer[] | null;
    waitedMs: number;
  },
  options: AskUserSettlementOptions,
): AgentMessage {
  const { askId, request, outcome, answers, waitedMs } = input;
  const subagentId = request.subagentId;
  const roundTrip = Math.max(options.roundTripHere() ?? 1, 1);
  return {
    messageId: `${options.runId}:ask-user:${askId}`,
    vendorId: null,
    role: 'tool',
    source: 'hook',
    roundTrip,
    turn: null,
    step: null,
    parentCallId: request.callId,
    subagentId,
    chunk: 'snapshot',
    assembly: 'snapshot',
    mergeKey: carrierKeyOf({ subagentId, roundTrip, role: 'tool', parentCallId: request.callId }),
    blocks: [
      {
        type: 'tool-result',
        callId: request.callId,
        // 答案那一半的**数据面**：只读卡片与任何回填只认这一格（`text` 是给人看的措辞）
        structured: { outcome, answers },
        // 「没人答」不是这一行失败：七态里那六种都是正常收场，模型照自己的判断继续
        isError: false,
        text: renderAnswerText(outcome, request.questions, answers),
        // 这一份是我们自己拼的、没有上限可撞 ⇒ 「确认没被截断」
        truncation: { kind: 'none' },
      },
    ],
    usage: null,
    raw: { author: 'ask-user-settlement', askId, toolName: request.toolName, channel: options.channel, waitedMs },
  };
}

/**
 * 台账里那一份人话（模型看到的那一份由适配器按各家形状渲染，两处刻意各写一份：
 * 这一份的读者是翻 `messages.jsonl` 的人，措辞只求把「谁答了什么」说清楚）。
 * 没答案的六态也各说一句——写成「用户选了空」是这一格最坏的误读。
 */
function renderAnswerText(outcome: AskUserReply['outcome'], questions: AskUserQuestion[], answers: AskUserAnswer[] | null): string {
  if (answers === null) return `这一问没有答案（收场方式：${outcome}）。`;
  const lines = questions.map((question) => {
    const answer = answers.find((item) => item.header === question.header);
    if (answer === undefined) return `- ${question.header}：（没有答复）`;
    const parts = [...answer.selected];
    if (answer.custom !== null) parts.push(answer.custom);
    return `- ${question.header}：${parts.length === 0 ? '（空答复）' : parts.join('、')}`;
  });
  return [`这一问的答案（收场方式：${outcome}）：`, ...lines].join('\n');
}
