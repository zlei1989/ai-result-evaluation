/**
 * pi 的提问工具（**宿主注册**那一档）：参数形状、提示词与 `execute` 的答复映射。
 *
 * 为什么这家要自己注册工具：pi 结构上没有「向用户提问」这件内置工具，模型能调的每一个工具都来自
 * 会话装配面，因此这一格只能由宿主补上。好处是同一个进程——`execute` 里直接 `await` 回调，零 IPC。
 *
 * 三条与厂商工具那一档**不同**的地方（宿主工具这条通道的固有限制）：
 *   · 提示词没有厂商来源，三格全是我们自己写的（见 `ASK_USER_DESCRIPTION` / `promptSnippet` /
 *     `promptGuidelines`）——「什么时候该问」只能写在 `promptGuidelines` 里，`description` 描述能力；
 *   · 工具名落进既有的 `ask-user` 族（`tool-family.ts` 的 `ask_user_question`），于是族载荷归一、
 *     卡片与七态全部复用，族表一行都不用改；它同时与 pi 的全部内置工具名（`read` / `bash` /
 *     `powershell` / `edit` / `write` / `grep` / `find` / `ls`）以及本仓装进来的子智能体那三件都不撞；
 *   · 等待预算没有厂商那一格（`vendorBudgetMs` 恒 `null`），超时只由骨架的预算产生。
 */
import type { AskUserQuestion } from '@aieval/contracts';
import { toolPayloadOf } from '../../tool-payload';
import type { AskUserReply } from '../../types';
import type { PiCustomTool } from './sdk';

/** 工具名：族表已识别的那个，且与 pi 的内置工具无一相撞（见文件头） */
export const PI_ASK_USER_TOOL = 'ask_user_question';

/**
 * 工具声明里的描述：**只说这一格是什么**。
 * 「什么时候该问、什么时候不该问」写在 `promptGuidelines`（那是行为提示唯一的落点）。
 */
export const PI_ASK_USER_DESCRIPTION =
  '向用户提出一个或多个选择题，等用户回答后再继续。问题要具体到一次能答完；'
  + '选项用简短标签，需要解释时用选项自己的描述。';

/**
 * 默认系统提示词 `## Available tools` 段的那一行。
 *
 * **只写「这是什么」，不重复工具名**：厂商把它渲染成 `- <name>: <这一格>`，自己再写一遍名字
 * 就会变成 `- ask_user_question: ask_user_question: …`。不给这一格时，自定义工具在该段里
 * 根本不出现（厂商按有没有这一格过滤，不是按有没有这个工具）。
 */
export const PI_ASK_USER_SNIPPET = '需要用户拍板、或需要只有他知道的信息时提问';

/**
 * 默认系统提示词 `## Guidelines` 段的条目（本工具激活时逐条进提示词）。
 * 宿主工具这条通道没有厂商给的时机提示，这一格就是我们能给的**全部**行为约束——所以它必须点明
 * 「什么该问」与「什么不该问」两侧：只写前一半，模型会把能从仓库里查到的事也拿去问人。
 */
export const PI_ASK_USER_GUIDELINES = [
  '需要用户在几个方案之间拍板，或需要只有用户才知道的信息（偏好、外部事实、凭据）时，用 '
    + `${PI_ASK_USER_TOOL} 提问，不要替用户猜。`,
  '能从工作目录、代码或文档里自己查到的答案不要问；先查再问。',
] as const;

/**
 * 工具的参数形状：与契约的 `AskUserQuestion` **逐字同形**。
 *
 * `questions` 是唯一必填的根键——族载荷归一（`tool-payload.ts` 的 `askUserPayloadOf`）正是靠它认这
 * 一族。少一个字段名（例如把 `multiSelect` 写成 `multi_select`）会让卡片与答案回填各自静默降级。
 *
 * `additionalProperties: false` 在每一层都给：多给的键不会进卡片，静默丢掉比当场被厂商校验拒更坏。
 * 刻意**不声明** `constrainedSampling`（见 `buildPiAskUserTools`）：那份 schema 里的可选字段形态
 * （例如 `description` 可为 `null`）不在厂商 strict 采样支持的子集里，开了反而会被它拒。
 */
export const PI_ASK_USER_PARAMETERS = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      /**
       * 至少一问：空数组过得了「有 `questions` 这一格」的校验，于是**人会被问一道空题**
       * （端口拿到空列表、模型读到一句没有任何内容的「用户已答复」），而那是一次纯噪声的往返。
       * 判据是厂商自己的参数校验器（真机：空数组从前一版装配起被拒在 `execute` 之前，
       * 端口一次都不被调）——这一格是那条判据的声明面。
       */
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          header: { type: 'string', description: '这一问的短标题，也是回填答案时的配对键' },
          question: { type: 'string', description: '要问用户的那句话' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: ['string', 'null'] },
                recommended: { type: 'boolean' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          multiSelect: { type: 'boolean' },
          allowOther: { type: 'boolean' },
          secret: { type: 'boolean' },
        },
        required: ['header', 'question', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

/** 工具入参（厂商按上面的 schema 校验/强转之后交给 `execute` 的那一份） */
export interface PiAskUserParams {
  questions: AskUserQuestion[];
}

/**
 * 工具入参里的问题数组 → **契约形状**（`prompt` 那一格由工具 schema 的 `question` 补齐）。
 *
 * 为什么走族载荷归一而不是原样交出去：工具 schema 里那一格叫 `question`（字段名在
 * `PI_ASK_USER_PARAMETERS` 里，改不动），而契约的问题形状叫 `prompt`（`AskUserQuestionSchema`）。
 * 两处各自拼一份的话，端口收到的与账本里记的就是两种形状——`AskUserRequest.questions` 是**归一后**
 * 的问题数组（见它的 JSDoc），而登记那条 `tool-call` 时又走一遍同一套归一 ⇒ 两边必然对不上，
 * 判据的表现是「卡片上问的与模型问的不是同一道题」。
 */
function contractQuestionsOf(raw: readonly unknown[]): AskUserQuestion[] {
  const payload = toolPayloadOf('ask-user', { questions: [...raw] }, 'pi');
  return payload?.kind === 'ask-user' ? payload.questions : [];
}

/**
 * 把答复渲染成**模型看到的那段文本**。
 *
 * 两条口径：
 *   · 收场方式（`outcome`）要点名：模型据此决定是「照答案干活」还是「自己拿主意」——把超时读成
 *     「用户选了空」是这一格最坏的误读；
 *   · 逐问回填，`header` 是配对键（与契约的答案形状同义）；没答案的问也要出现一行，
 *     否则模型看不出「是没人答」还是「这一问被漏了」。
 */
export function renderPiAskUserAnswer(reply: AskUserReply, questions: AskUserQuestion[]): string {
  if (reply.answers === null) {
    return `没有人回答（收场方式：${reply.outcome}）。请按你的最佳判断继续，不要重复提问。`;
  }
  const lines = questions.map((question) => {
    const answer = reply.answers?.find((item) => item.header === question.header);
    if (answer === undefined) return `- ${question.header}：（没有答复）`;
    const parts = [...answer.selected];
    if (answer.custom !== null) parts.push(answer.custom);
    return `- ${question.header}：${parts.length === 0 ? '（空答复）' : parts.join('、')}`;
  });
  return `用户已答复（收场方式：${reply.outcome}）：\n${lines.join('\n')}`;
}

/**
 * 造提问工具：**一个都没有回调就一件都不造**。
 *
 * 「不问就不动」这条边界靠它成立——不传 `onAskUser` 时这个数组是空的，装配面因此连
 * `customTools` 那一格都不给（会话选项逐字不变，零回归）。
 *
 * `execute` 的三条处置：
 *   · 等的是**骨架的提问端口**，不是 `ctx.ui`——本仓没给 `uiContext`，厂商会回落成
 *     `noOpUIContext`，`ctx.ui.input()` 静默返回 `undefined`（看起来像「用户没答」）；
 *   · 端口**不抛**（超时 / 行终止 / 回调抛错都折成答复），所以这里不 catch；答复映射成一条**普通
 *     工具结果**：`content` 是模型读的那段文本，`details` 是界面/日志看的结构化那一份；
 *   · **刻意不给 `terminate`**：它会让「答完继续干活」变成「答完就停」（提问只是这一轮里的一件事）。
 *     「没人答」也不置 `isError`：那是正常收场，不是这一行失败。
 */
export function buildPiAskUserTools(
  ask: ((params: PiAskUserParams, callId: string) => Promise<AskUserReply>) | null,
): PiCustomTool[] {
  if (ask === null) return [];
  return [{
    name: PI_ASK_USER_TOOL,
    label: '向用户提问',
    description: PI_ASK_USER_DESCRIPTION,
    promptSnippet: PI_ASK_USER_SNIPPET,
    promptGuidelines: [...PI_ASK_USER_GUIDELINES],
    parameters: PI_ASK_USER_PARAMETERS,
    constrainedSampling: false,
    execute: async (toolCallId, params) => {
      const questions = contractQuestionsOf((params as PiAskUserParams | null)?.questions ?? []);
      const reply = await ask({ questions }, toolCallId);
      return {
        content: [{ type: 'text', text: renderPiAskUserAnswer(reply, questions) }],
        details: { outcome: reply.outcome, answers: reply.answers },
      };
    },
  }];
}
