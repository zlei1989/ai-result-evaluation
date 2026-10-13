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
import { toolPayloadOf } from '../../tool-payload';
import type { AskUserPort } from '../../ask-user';
import type { AskUserReply } from '../../types';
import type { ClaudePermissionResult } from './sdk';

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
 * 三处刻意的处置：
 *   · **题面认不出来就跳过这一题**，不猜、也不并发一个空串键：厂商按题面文本查表，键错了那一题
 *     就是「没答」，而错键的表现是模型看到一句与本题无关的答案；
 *   · **多选给数组**、单选给标签串（厂商两种写法都认，数组更贴语义）；
 *   · **自由输入**：单选时它**取代**选项（`selected` 为空数组，见契约那条口径），因此该题的值
 *     直接取 `custom`；多选时它是**补充**，厂商那一侧只有一格可用，故把选项与自由输入拼成同一个
 *     数组——两者都进工具结果，不丢任何一半。
 */
export function ccAnswersOf(reply: AskUserReply, questions: AskUserQuestion[]): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const answer of reply.answers ?? []) {
    const question = questions.find((one) => one.header === answer.header);
    if (question === undefined) continue;
    answers[question.prompt] = ccAnswerValueOf(answer, question);
  }
  return answers;
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
 * 造一个权限钩子：提问工具走应答面，其余工具**原样放行**（不放进 `updatedInput`）。
 *
 * 为什么其余工具也要回答：挂上这个钩子之后 CLI 就不再自己拍板，返回 `null` 或不返回都等于
 * **没有 control_response**，那个工具会一直挂着（厂商的类型面把 `null` 留给「已经用带外通道答过了」）。
 * 而「全权档下普通工具根本不会进这一格」是厂商预授权的既成事实（真机读数里只有提问工具有
 * `requires_user_interaction`），故这里放行普通工具**不放松任何权限档**——放行的那一类从来没有走到这里。
 *
 * 没挂应答面（`port.available === false`）返回 `null`：调用方据此**一格都不加**，既有行为逐字不变。
 */
export function ccAskUserPermission(
  port: AskUserPort,
): (toolName: string, input: Record<string, unknown>, options: { toolUseID?: string }) => Promise<ClaudePermissionResult> {
  return async (toolName, input, options) => {
    if (toolName !== CC_ASK_USER_TOOL) return { behavior: 'allow' };
    const questions = ccQuestionsOf(input);
    const reply = await port.ask({
      questions,
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
    });
    return {
      behavior: 'allow',
      updatedInput: { ...input, answers: ccAnswersOf(reply, questions) },
      ...(options.toolUseID === undefined ? {} : { toolUseID: options.toolUseID }),
    };
  };
}
