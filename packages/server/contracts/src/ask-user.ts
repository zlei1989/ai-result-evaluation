/**
 * 待答提问的**传输形状**：一个应答面（浏览器 → 运行中的评测）需要的三份数据。
 *
 * 与 `agent-message.ts` 里那两格的分工：那边是**消息账本**里的问题与答案（`AskUserPayloadSchema`
 * 挂 `tool-call` 一半、`AskUserAnswerSchema` 挂 `tool-result` 一半，随轮次落盘、供复盘卡片渲染），
 * 这边是**应答途中**的形状（还没答、谁在问、什么时候问的，只活在内存里）。
 * 两者共用同一套问题与答案词汇（`AskUserQuestionSchema` / `AskUserAnswerSchema`），
 * 差别只在包在外面那几格：账本要的是「这一族的调用载荷」，应答面要的是「这一问属于哪一轮哪一行」。
 *
 * 三条口径：
 *   · **答案侧复用，不新造**：一份答案仍是 `{ header, selected, custom }`，配对键仍是 `header`
 *     （`selected` 装选项标签，单选 + 自由输入是覆盖 ⇒ `selected: []`）——应答面若各写一份，
 *     回灌进厂商钩子的那一份与落进账本的那一份就会漂移成两种语义；
 *   · **`stage` 与 `RowFailureStageSchema` 同词表**：提问发生在候选那一段还是评分那一段，
 *     与「这一笔失败发生在哪一段」问的是同一个问题，两处各造一套词表只会让排障时多一次翻译；
 *   · **待答项不带厂商上下文**（工具名 / 调用 id / 厂商预算）：那是编排层回灌答案时要用的东西，
 *     界面对它没有消费方，放进响应体就是把「谁在等、等了多久」与「这条运行内部怎么记账」混在一起。
 *     界面要的排障线索是 `askedAt`（等了多久）与 `questions`（几问由它的条数给出，不另设计数格）。
 */
import { z } from 'zod';
import { AskUserAnswerSchema, AskUserQuestionSchema } from './agent-message';

/**
 * 提问发生在哪一段：与 `RowFailureStageSchema` 逐字同词表（见文件头口径 2）。
 * 今天只有候选那一段会提问——评审者那一侧不接应答面——但这一格必须存在：
 * 少了它，「两条不同的等待为什么并排挂在面板上」就无从判断。
 */
export const AskUserStageSchema = z.enum(['agent', 'judge']);
export type AskUserStage = z.infer<typeof AskUserStageSchema>;

/**
 * **一个待答提问**（快照里的一条，也是应答 POST 里 `askId` 的所指）。
 *
 * `askedAt` 是**服务端写入时刻**的 ISO 串（与 `AgentEvent.at` 同口径：不是厂商时间，
 * 是这一问进入挂起表的时刻）。界面的「已等待」由它算，不由本地收到帧的时刻算——
 * 后者把「页面开得晚」读成「刚问的」。
 */
export const PendingAskUserSchema = z.object({
  /** 这一问的唯一标识；应答 POST 按它幂等 */
  askId: z.string().min(1),
  runId: z.string().min(1),
  /** `null` = 这一问不在某一行上（今天没有这种提问，留着是为了读侧不必区分两种形状） */
  rowId: z.string().nullable(),
  stage: AskUserStageSchema,
  /** 问出去的那几个问题（归一后形状，与账本里 `AskUserPayloadSchema.questions` 同一份） */
  questions: z.array(AskUserQuestionSchema),
  askedAt: z.string(),
});
export type PendingAskUser = z.infer<typeof PendingAskUserSchema>;

/** 待答快照：**全部轮次**当前还没答的提问（为晚开的页面与刷新服务） */
export const PendingAskUserListSchema = z.array(PendingAskUserSchema);
export type PendingAskUserList = z.infer<typeof PendingAskUserListSchema>;

/**
 * 应答 POST 的请求体：答的是哪一问 + 那份答案数组，**逐问对上**（数量与顺序都与 `questions` 一致）。
 *
 * 「逐问对上」是硬约束而不是宽容处理：少答一问时，回灌进厂商钩子与落进账本的那一份会缺一条，
 * 而缺的那一条在两天后才以「模型说用户选了空」的形式暴露出来——宁可在入口处 400。
 * 写成一个对象（而不是裸数组）是因为 `askId` 与答案数组必须一起到达：分两处传（`askId` 进路径）
 * 会让「哪一问」与「答了什么」在客户端拼装时多一次出错机会，而这一格错了就是答案配错问题。
 */
export const AskUserAnswerRequestSchema = z.object({
  /** 答的是哪一问（幂等键）。它在请求体里而不在路径里：这一问属于哪一轮哪一行已在服务端的表里 */
  askId: z.string().min(1),
  answers: z.array(AskUserAnswerSchema).min(1),
});
export type AskUserAnswerRequest = z.infer<typeof AskUserAnswerRequestSchema>;

/**
 * 应答 POST 的响应体：这一问的收场结果。
 *
 * 正常路径恒是 `{ outcome: 'answered', answers: <原样交回的那份> }`——幂等冲突走 409、
 * 未知 `askId` 走 404，两者都不是这个形状（见路由层）。`answeredAt` 与 `PendingAskUser.askedAt`
 * 同口径，是服务端写入时刻：一次应答总共只有这两个时刻，「等了多久」由它们相减得出。
 */
export const AskUserAnswerAcceptedSchema = z.object({
  askId: z.string().min(1),
  answer: z.object({
    outcome: z.literal('answered'),
    answers: z.array(AskUserAnswerSchema),
  }),
  answeredAt: z.string(),
});
export type AskUserAnswerAccepted = z.infer<typeof AskUserAnswerAcceptedSchema>;
