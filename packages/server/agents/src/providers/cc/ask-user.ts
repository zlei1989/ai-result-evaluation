/**
 * cc 的提问应答桥：厂商的**权限钩子**（`can_use_tool`）→ 提问端口 → 答复按厂商形状递回去。
 *
 * 为什么这一家要挂在权限钩子上：厂商自带提问工具（`AskUserQuestion`），它注册的桥是权限桥而不是
 * 对话框桥——CLI 遇到它时发一帧 `can_use_tool`（`requires_user_interaction: true`），宿主的应答
 * 类型面上只有「允许 + 改写入参」与「拒绝 + 一句给模型的话」，没有独立的答案字段。递答案的唯一
 * 落点因此是 `updatedInput.answers`：**键是题目文本**，单选给选项标签串、多选给数组。
 *
 * 四条只在这一家成立的边界：
 *   · **不挂钩子 = 工具被禁用**（厂商口径：headless 下没有批准面就不把提问工具提供给模型）——
 *     这正是「不问就不动」在这一家的落点：没传回调时那个工具连模型都看不到；
 *   · **接它不需要动权限档**：全权档只遮蔽普通工具，提问工具带 `requires_user_interaction`，照样进
 *     回调（真机读数：`bypassPermissions` 与 `default` 两档的控制帧逐字相同）；
 *   · **只读档问不到人**：`dontAsk` + `permissionPrompts: 'none'` 是「本进程没有批准面」，厂商据此
 *     把提问工具一并从模型工具表里撤掉、控制帧一条都不发 ⇒ 那一档即使挂了应答面也落「无人应答」，
 *     本模块不需要为它写分支；
 *   · **子智能体发起的提问到不了这里**——厂商自己就拒（`not available inside subagents`），
 *     因此本模块不做子智能体判定。
 *
 * 通道与形状来自厂商通道的实跑读数（`probe/v11/REPORT.md` 的 cc 提问一节：控制帧、回调选项字段、
 * 七条递答案臂的工具结果原文），不是从类型面推断的。
 */
import type { AskUserAnswer, AskUserQuestion } from '@aieval/contracts';
import { createLogger } from '@aieval/core';
import { toolPayloadOf } from '../../tool-payload';
import type { AskUserPort } from '../../ask-user';
import type { AskUserReply } from '../../types';
import type { ClaudePermissionResult } from './sdk';

const logger = createLogger('agents/cc');

/** 模型看到的那个提问工具名（厂商原文；族表 `tool-family.ts` 也认它） */
export const CC_ASK_USER_TOOL = 'AskUserQuestion';

/**
 * 厂商提问工具的入参（`{questions: [{question, header, options[], multiSelect}]}`）→ 契约形状。
 * 复用族载荷的归一函数：那一份是**唯一**知道四家字段名差异的地方（这里再抄一遍必然漂移）。
 */
export function ccQuestionsOf(input: Record<string, unknown>): AskUserQuestion[] {
  const payload = toolPayloadOf('ask-user', input, 'cc');
  return payload?.kind === 'ask-user' ? payload.questions : [];
}

/**
 * 一份答复 → 厂商的 `answers` 表（**键是题目文本**，值按该题的 `multiSelect` 分档）。
 *
 * 四处刻意的处置：
 *   · **题面认不出来就跳过这一题**，不猜、也不并发一个空串键：厂商按题面文本查表，键错了那一题
 *     就是「没答」，而错键的表现是模型看到一句与本题无关的答案；
 *   · **同题面的题只认第一道**（`answered` 那一格）：键是**题面文本**而厂商的查表也是按题面，
 *     两题问同一句话时两把键必然撞在一起、后写的那份会**静默盖掉**前一份。缺了这条，用户答了两题
 *     而模型只看到一题，且没有任何日志。空题面那一档（厂商没给 `question`）是它的**特例**
 *     ——空串配不上任何一题，同样整题跳过；
 *   · **多选给数组**、单选给标签串（厂商两种写法都认，数组更贴语义）；
 *   · **自由输入**：单选时它**取代**选项（`selected` 为空数组，见契约那条口径），因此该题的值
 *     直接取 `custom`；多选时它是**补充**，厂商那一侧只有一格可用，故把选项与自由输入拼成同一个
 *     数组——两者都进工具结果，不丢任何一半。
 *
 * 第二格怎么落：`answered` 是**实际送去厂商标题面的那几道题**（调用方从 `ccQuestionsOf` 的结果里
 * 先剔掉撞题面的那些）。缺省就按 `questions` 自己算，使这一层单独调用也守同一条口径。
 */
export function ccAnswersOf(
  reply: AskUserReply,
  questions: AskUserQuestion[],
  answered: AskUserQuestion[] = firstByPrompt(questions),
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const answer of reply.answers ?? []) {
    const question = answered.find((one) => one.header === answer.header);
    if (question === undefined) continue;
    answers[question.prompt] = ccAnswerValueOf(answer, question);
  }
  return answers;
}

/**
 * **题面是答案表的键**：同一句话只留第一道，其余整题不入表。
 *
 * 为什么必须在递答案**之前**剔（而不是递的时候发现撞了再处置）：厂商按题面文本查表，
 * 撞键那一档无论怎么写都表达不出「两题各有一个答案」——唯一如实的读法是「这句话只答了一次」，
 * 而含糊地写两次等于替厂商选了一题、还把用户另一题的选择丢掉。
 * ⚠️ 空题面同样在这里被剔（`''` 配不上任何一题），与上面那条「题面认不出就跳过」同源。
 */
export function firstByPrompt(questions: AskUserQuestion[]): AskUserQuestion[] {
  const seen = new Set<string>();
  const kept: AskUserQuestion[] = [];
  for (const question of questions) {
    if (question.prompt === '' || seen.has(question.prompt)) continue;
    seen.add(question.prompt);
    kept.push(question);
  }
  return kept;
}

/**
 * 被剔掉的那几道题（**只用于点名日志**）：题面为空串的与撞题面的分开报——
 * 前者是「厂商没给题面」，后者是「两题问了同一句话」，处置完全不同。
 */
export function droppedQuestionsOf(questions: AskUserQuestion[]): { blankPrompt: AskUserQuestion[]; duplicatePrompt: AskUserQuestion[] } {
  const seen = new Set<string>();
  const blankPrompt: AskUserQuestion[] = [];
  const duplicatePrompt: AskUserQuestion[] = [];
  for (const question of questions) {
    if (question.prompt === '') {
      blankPrompt.push(question);
      continue;
    }
    if (seen.has(question.prompt)) {
      duplicatePrompt.push(question);
      continue;
    }
    seen.add(question.prompt);
  }
  return { blankPrompt, duplicatePrompt };
}

/** 单题的值：见 `ccAnswersOf` 的三条口径 */
function ccAnswerValueOf(answer: AskUserAnswer, question: AskUserQuestion): unknown {
  const custom = answer.custom === null || answer.custom === '' ? null : answer.custom;
  if (question.multiSelect) {
    const filled: string[] = [...answer.selected];
    if (custom !== null) filled.push(custom);
    return filled;
  }
  return custom ?? answer.selected[0] ?? '';
}

/**
 * **没有人回答**时交给模型的那句话（七态里除 `answered` 之外的六态都走它）。
 *
 * 为什么必须说出来、而不是交一张空表：空表在厂商那一侧与「每一题都没配上键」**同形**，
 * 模型会按「用户什么都没选」继续往下做——而事实是**根本没有人答**（等超时 / 通道不可用 /
 * 厂商当场拒 / 随行终止…六种各不相同）。另三家都把这件事说给模型听（pi 渲染「没有人回答」、
 * dsh 交「委派」、codex 的空表是厂商原生的无答案语义），cc 这一家原来**整格丢掉 `outcome`**。
 *
 * 文案点名**收场方式**（排障要搜的就是它），并明确下一步——不要卡在这儿反复问。
 */
function ccUnansweredMessage(outcome: AskUserReply['outcome']): string {
  return `没有人回答这次提问（收场方式：${outcome}）。请按你的最佳判断继续，不要重复提问。`;
}

/**
 * 造一个权限钩子：提问工具走应答面，其余工具**原样放行**（不放进 `updatedInput`）。
 *
 * 为什么其余工具也要回答：挂上这个钩子之后 CLI 就不再自己拍板，返回 `null` 或不返回都等于
 * **没有 control_response**，那个工具会一直挂着（厂商的类型面把 `null` 留给「已经用带外通道答过了」）。
 * 而「全权档下普通工具根本不会进这一格」是厂商预授权的既成事实（真机读数里只有提问工具有
 * `requires_user_interaction`），故这里放行普通工具**不放松任何权限档**——放行的那一类从来没有走到这里。
 *
 * ⚠️ **「没挂应答面就一格都不加」这件事发生在调用点**（`index.ts` 看 `context.askUser.available`），
 * 不在这个函数里：本函数无条件返回一个真回调。挂了它就会让厂商多出几件需要用户介入的工具
 * （真机读数：工具表 27 → 30），而这一家「没有批准面 ⇒ 提问工具连模型都看不到」是**结构性**的
 * ⇒ 面板看不见应答面时，这里必须**不挂**，不是「挂上去再拒」。
 */
export function ccAskUserPermission(
  port: AskUserPort,
): (toolName: string, input: Record<string, unknown>, options: { toolUseID?: string; signal?: AbortSignal }) => Promise<ClaudePermissionResult> {
  return async (toolName, input, options) => {
    if (toolName !== CC_ASK_USER_TOOL) return { behavior: 'allow' };
    const questions = ccQuestionsOf(input);
    /**
     * **入参认不出（归一后一道题都没有）就不问人、当场放行**。
     *
     * 为什么必须在问人之前拦：这一家的 `vendorBudgetMs` 是 `null`（厂商自己永不收场）⇒ 端口按
     * 缺省预算等**十分钟**，而编排层会把这一问登记进挂起表、界面上出现一张**没有任何问题**的卡片
     * ——没有人可能答它，于是一帧畸形入参就把整行拖满一个预算。codex 在同一格的处置同源
     * （入参认不出就不问人，直接回一帧空答案）。
     */
    if (questions.length === 0) return { behavior: 'allow' };
    /**
     * **同一句话只送一道题**（答案表的键就是题面文本 ⇒ 撞键后写的那份会静默盖掉前一份）。
     * 撞了就说出来：那几道题的答复**进不了模型眼里**，静默降级比报错更难查。
     */
    const answered = firstByPrompt(questions);
    const dropped = droppedQuestionsOf(questions);
    if (dropped.duplicatePrompt.length > 0) {
      logger.warn('cc 提问里有两道题问了同一句话：只认第一道（厂商按题面文本查表，键会互相覆盖）', {
        headers: dropped.duplicatePrompt.map((one) => one.header),
      });
    }
    const asked = await askWithVendorCancel(port, {
      questions: answered,
      toolName,
      // 调用 id 优先取钩子给的那一格（它是这一帧的身份）；缺了才退回入参自带的
      callId: options.toolUseID ?? String(input['tool_use_id'] ?? ''),
      /**
       * 厂商侧自己**不会**收场：`askUserQuestionTimeout` 的缺省是 `never`（读数见探针），
       * 也就是「没人答就一直挂着」。故这一格如实给 `null`，超时只能由我们这一侧的预算产生。
       */
      vendorBudgetMs: null,
      /**
       * 主线程提问时厂商回调里带 `agentID` 字段但**缺值**，线级帧里干脆没有 `agent_id`；
       * 而子智能体的提问厂商根本不投送。故这里恒 `null`——不是「没读到」，是这一家拿不到。
       */
      subagentId: null,
    }, options.signal);
    /**
     * **厂商把这一帧收了** ⇒ 立刻收手，回一帧「当场拒」并说明。
     *
     * 为什么不许继续等：`options.signal` 由厂商在这一帧被 `control_cancel_request` 时 abort
     * （`sdk.mjs` 的 `handleControlCancelRequest`）⇒ 那一帧早已无人接收，等满一个预算（缺省十分钟）
     * 只是把界面上的卡片与挂起表白占着，最后写回去的 control_response 也只会被厂商丢掉。
     * 为什么返回 `deny` 而**不是抛**：抛会打断适配器的流循环（`can_use_tool` 的 rejection 会顺着
     * `processControlRequest` 冒到 SDK），而「这一帧已经作废」不该升级成整行失败。
     */
    if (asked === VENDOR_CANCELED) {
      return {
        behavior: 'deny',
        message: '这一帧提问已被厂商撤销（control_cancel_request），宿主不再等待答复。',
        ...(options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID }),
      };
    }
    const reply = asked;
    /**
     * **没有人回答 ⇒ 拒这一次工具调用，并把收场方式说给模型**（`answers === null` 的六态）。
     *
     * 为什么不是「放行 + 空答案表」：那张空表在厂商那一侧与「每题都没配上键」同形，模型会按
     * 「用户什么都没选」继续；`canceled`（行已终止）那一档还会白放行一次工具执行。
     * 厂商把 `deny.message` 渲染成工具结果交给模型 ⇒ 那是这一家唯一能把「没人答」讲出来的通道。
     */
    if (reply.answers === null) {
      return {
        behavior: 'deny',
        message: ccUnansweredMessage(reply.outcome),
        ...(options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID }),
      };
    }
    return {
      behavior: 'allow',
      updatedInput: { ...input, answers: ccAnswersOf(reply, questions, answered) },
      ...(options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID }),
    };
  };
}

/** 「厂商撤了这一帧」的哨兵：与「端口回了一份答复」区分开（答复对象不可能是函数） */
const VENDOR_CANCELED = Symbol('cc-ask-vendor-canceled');

/**
 * 问一次人；**厂商撤帧就提前收手**（返回哨兵），否则原样返回端口的答复。
 *
 * 三条口径：
 *   · 没有 `signal`（老 SDK / 夹具）⇒ 逐字退化成 `port.ask`，行为与没有这一层时相同；
 *   · 已经 aborted ⇒ 连问都不问（那一帧早就作废了）；
 *   · 监听器**一定要摘掉**（`finally`）：一个 run 里可能有多次提问，漏摘会让 abort 之后的
 *     每一次都触发一次本已过期的收手。
 */
async function askWithVendorCancel(
  port: AskUserPort,
  request: Parameters<AskUserPort['ask']>[0],
  signal: AbortSignal | undefined,
): Promise<AskUserReply | typeof VENDOR_CANCELED> {
  if (signal === undefined) return port.ask(request);
  if (signal.aborted) return VENDOR_CANCELED;
  let onAbort: (() => void) | undefined;
  const canceled = new Promise<typeof VENDOR_CANCELED>((resolve) => {
    onAbort = () => resolve(VENDOR_CANCELED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([port.ask(request), canceled]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
