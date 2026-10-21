/**
 * 提问端口：模型问到用户时，适配器从这一格拿到「问一次」的函数。
 *
 * 为什么单列成模块：这一格的等待语义（没挂应答面 / 本次运行终止 / 这一问的预算 / 回调抛错）在四家适配器里
 * 必须**逐字一致**——抄四遍必然漂移，而漂移的表现是「同一件事在两家落不同的收场方式」，
 * 排障时会被读成厂商差异。厂商差异全部留在适配器里：把厂商的钩子接到这一格上、把答复按各家的形状
 * 喂回去，是各家接线的事。
 *
 * 它与既有三条流（`onEvent` / `onMessage` / `onSubagent`）刻意不同：那三条同步、不 await、抛错被吞、
 * 不改变本次运行的结论；这一格**必须 await、允许阻塞本次运行、会改变本次运行结论**。因此它不能
 * 并进任何一条既有流，也不能由适配器各自处置。
 *
 * 只依赖骨架入参（`AgentRunInput`）：适配器运行期从 `TurnContext.askUser` 拿它，夹具也能拿同一份
 * 入参自己造一个——于是这一格的行为可以脱离任何厂商夹具单测（见 `ask-user.test.ts` 的四条硬规则）。
 */
import { createLogger } from '@aieval/core';
import type { AskUserQuestion } from '@aieval/contracts';
import type { AgentKind, AgentRunInput, AskUserReply, AskUserRequest } from './types';

/**
 * 这一问自己的等待预算缺省值（毫秒）：厂商没给预算时用它兜底。
 *
 * 取值理由：应答面按轮**显式开启**，所以等的是「有人正在看着界面」的那一轮；十分钟够一个人
 * 把手上的事告一段落再答，又不会让无人值守的一轮永远挂在一个再也答不了的问题上。厂商给了自己的
 * 预算就以它为准（到点厂商自己就收场了，再等没有意义）。
 */
export const DEFAULT_ASK_USER_BUDGET_MS = 600_000;

const logger = createLogger('agents/ask-user');

/**
 * 等待期的登记口：骨架用它把「在等用户回答」登记进**静止超时豁免**判据表（与「工具在途」同一处）。
 *
 * 为什么必须登记：这一段时间里厂商一个事件都不会产出（它正阻塞在同一次工具调用上），
 * 不登记就会被自己的看门狗按静止超时收掉——每次人工介入都活不过空闲上限。
 */
export interface AskUserWaitSink {
  /** 进入等待（可重入：并发两问各自登记一次） */
  enter: () => void;
  /** 离开等待（与 `enter` 配对；最后一次离开会重新起表并重排看门狗） */
  leave: () => void;
}

/** 提问端口：适配器从它拿到「问一次」，也靠 `available` 判「这一轮到底有没有应答面」 */
export interface AskUserPort {
  /**
   * 这次运行有没有应答面（= 调用方传了 `onAskUser`）。
   * 适配器据此决定挂不挂厂商钩子、开不开厂商开关、改不改权限档——「不问就不动」这条边界靠它成立。
   */
  readonly available: boolean;
  /**
   * 问一次：等回调、等本次运行终止、等这一问的预算，谁先到谁定收场方式。
   * **不抛**：没有人答、等超时、随行取消、回调抛错，四种都折成一个答复返回。
   */
  ask: (request: AskUserRequest) => Promise<AskUserReply>;
}

export interface AskUserPortOptions {
  /** 这一家（日志上下文与静止超时豁免表按家取值用） */
  kind: AgentKind;
  /** 等待期的登记口；缺省 = 不登记（脱离骨架的纯 promise 用例不关心看门狗） */
  wait?: AskUserWaitSink | undefined;
  /** 覆盖这一问的预算（毫秒）；缺省取请求里的厂商预算，再缺省取 `DEFAULT_ASK_USER_BUDGET_MS` */
  budgetMs?: number | null | undefined;
}

/** 一份「收场了但没有答案可回填」的答复。每次现造：交给调用方的那一份不该被上一问的改动牵连 */
function unanswered(outcome: AskUserReply['outcome']): AskUserReply {
  return { outcome, answers: null };
}

/**
 * 这一问的等待预算：调用方覆盖 > 厂商自己的预算 > 缺省。
 *
 * 非正数一律读成「没给」而不是「立刻超时」：契约明写 `0` 不许填（会被读成「马上超时」），
 * 一个手滑的 `0` 不该让每一次提问当场落空。厂商真会给 `0` 的那天，先改契约那条口径。
 */
function budgetOf(request: AskUserRequest, override: number | null | undefined): number {
  if (typeof override === 'number' && override > 0) return override;
  if (typeof request.vendorBudgetMs === 'number' && request.vendorBudgetMs > 0) return request.vendorBudgetMs;
  return DEFAULT_ASK_USER_BUDGET_MS;
}

/**
 * 这一问里有没有两题共用一个标题：有就返回那个标题，没有返回 `null`。
 *
 * 为什么标题撞车必须整场拦下，而不是等答复回来再纠错：契约的答案形状是 `{header, selected, custom}`，
 * **唯一的配对键就是 `header`**（`AskUserAnswerSchema` 那条口径），所以同一次提问里出现两个相同标题时，
 * 一份答复在结构上无法说清它答的是哪一题——四家适配器把答复递回厂商时都按这个键查表
 * （`ccAnswersOf` / `dshAnswerBatchOf` / codex 的答案帧），必然把两题配到同一份答案上。
 * 缺的是键不是判据：契约零新增字段这条口径下没有地方补第二个配对键，因此这一问只能整场不收答案。
 *
 * 空标题同样算撞车：厂商没给标题时归一成空串（「没给」与「给了空串」在契约那一格不可分），
 * 两题都是空串与两题同名一样不可分。
 */
function duplicateHeaderOf(questions: readonly AskUserQuestion[]): string | null {
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.header)) return question.header;
    seen.add(question.header);
  }
  return null;
}

/**
 * 造一个提问端口。
 *
 * 四条硬规则（每条一个用例，见 `ask-user.test.ts`）：
 *   1. **没挂应答面**（`input.onAskUser` 缺席）⇒ 立即返回「无人应答」：不挂起、不登记等待、不打日志
 *      ——「默认不介入」这条边界要能被断言成「一次都没调用、一个字都没多打」；
 *   2. `Promise.race([回调, 本次运行终止信号, 这一问的预算])` ⇒ 三条收场分别是「随本轮取消」「超时」「正常答复」；
 *   3. 等待期间登记进骨架的静止超时豁免（见 `AskUserWaitSink`）；
 *   4. 回调抛错 ⇒ 落「无人应答」+ ERROR 日志（堆栈与 `{kind, toolName, 问题数}`），**不改变**本次运行的
 *      `ok` / 退出原因：「没人答」与「本次运行失败」是两件事。
 *
 * 另有一条**发出前**的拦截：同一次提问里两题共用一个标题 ⇒ 整场落「无人应答」、一次都不问人
 * （判据见 `duplicateHeaderOf`）。它落在这一层而不是各适配器：四个适配器各自把厂商的提问钩子接到这里，
 * 这里是「问人」这件事在包内的唯一收窄口；抄四遍必然漂移，而漂移的表现是同一件事在两家落不同的收场方式。
 *
 * 厂商自己收场那一档（厂商到点自己结束这一问）不在这里猜：那是适配器拿得到的收束通知，
 * 由它结束这一问并落「厂商自动决议」；本模块的预算只是**没人结束它时**的兜底。⚠️ 有的家（codex）
 * 压根没有这一档——它的等待预算是 `@deprecated` 且实测恒空，收场只能靠我们回帧或本模块的预算。
 */
export function createAskUserPort(input: AgentRunInput, options: AskUserPortOptions): AskUserPort {
  const callback = input.onAskUser;

  /** 规则 2 与规则 4 的收场：谁先落定谁说了算，晚到的那些一律丢弃 */
  const race = (request: AskUserRequest, answer: NonNullable<AgentRunInput['onAskUser']>): Promise<AskUserReply> =>
    new Promise<AskUserReply>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        finish(unanswered('canceled'));
      };
      const finish = (reply: AskUserReply): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        resolve(reply);
      };
      /**
       * 回调抛错的两种形态都要折进「无人应答」：返回一个被拒的 promise，或**当场抛**
       * （普通函数里一句 `throw` 就是这么走的）。漏了后者，一次问答故障会顺着 `ask` 冒出去，
       * 把整行判成失败——而「没人答」与「本次运行失败」是两件事。
       * 堆栈随 `error` 对象交给 console 的第二个参数（Node 的 inspector 会打印它）：
       * 「没人答」与「问这一下的通道坏了」在排障时是两回事，日志里必须分得开。
       */
      const onError = (error: unknown): void => {
        logger.error('提问回调抛错，这一问落「无人应答」', {
          kind: options.kind,
          toolName: request.toolName,
          questionCount: request.questions.length,
          callId: request.callId,
          error,
        });
        finish(unanswered('unavailable'));
      };

      /**
       * 已经要求停止的运行不再问人：本次运行的产物已经由停止那条路径定稿，
       * 再让一个人对着一个不会有人消费的弹层答题是纯粹的浪费。
       */
      if (input.signal.aborted) {
        finish(unanswered('canceled'));
        return;
      }

      const budgetMs = budgetOf(request, options.budgetMs);
      input.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        logger.warn('提问等待到点，这一问按超时收场', {
          kind: options.kind,
          toolName: request.toolName,
          callId: request.callId,
          budgetMs,
        });
        finish(unanswered('timeout'));
      }, budgetMs);

      // 回调放进微任务里调，好让「当场抛」与「返回被拒的 promise」走同一条错误处置
      Promise.resolve()
        .then(() => answer(request))
        .then((reply) => finish(reply), onError);
    });

  return {
    available: callback !== undefined,
    ask: async (request) => {
      // 规则 1：没挂应答面 ⇒ 立即「无人应答」。这一支必须**在登记等待之前**返回：
      // 登记了就会挂起看门狗，而这一格一个字都不该动到既有行为
      if (callback === undefined) return unanswered('unavailable');
      /**
       * 标题撞车 ⇒ 整场落「无人应答」，一次都不问人（判据见 `duplicateHeaderOf`）。
       *
       * 为什么不在这里自己配一次答案（例如按题序对号入座）：那要造第二个配对键，
       * 而适配器把答复递回厂商时读的仍是 `header`——两处键不同源，漂移的表现正是答案悄悄配错题。
       * 也不折叠或去重问题：那会静默改写模型实际问的是哪几题，而「不许静默丢掉一条」是这一格的底线。
       * 落「无人应答」而不是抛：它与「没人答」同档，是收场方式之一——模型照自己的判断继续，行不失败。
       * 同样在登记等待之前返回：不问人就不该占着静止超时豁免那一格。
       */
      const duplicated = duplicateHeaderOf(request.questions);
      if (duplicated !== null) {
        logger.warn('同一次提问里两题共用一个标题，这一问整场落「无人应答」', {
          kind: options.kind,
          toolName: request.toolName,
          callId: request.callId,
          header: duplicated,
          questionCount: request.questions.length,
        });
        return unanswered('unavailable');
      }
      options.wait?.enter();
      try {
        return await race(request, callback);
      } finally {
        options.wait?.leave();
      }
    },
  };
}
