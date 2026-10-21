/**
 * SSE 帧的信封契约：**一份判别联合**统管三条流（全局 / 聚合 / 抽屉）每一帧的归属。
 *
 * ## 形状：平铺、按顶层 `type` 判别
 *
 * 不嵌套 `{ envelope, data }`——消费方拿到的 `type` 就是业务字面量本身，不必先剥两层再去分流。
 * 判别键是顶层 `type`，业务载荷与归属格平铺在同一层（`candidateId` / `candidateChannel` / `seq`）。
 *
 * ## 四类帧与各自的「该有什么格」
 *
 * | 类别 | 字面量 | 归属格 | 载荷 |
 * |---|---|---|---|
 * | run 信号 | `run-updated` | 无 `candidateId` / 无 `candidateChannel` / 无 `seq` | `runId` |
 * | 候选级事件 | `AGENT_EVENT_TYPES` 的十个 | `candidateId` + `candidateChannel` + `seq` | `AgentEvent` 自己那一份（逐字复用） |
 * | 候选级消息 | `message` / `subagent` | `candidateId` + `candidateChannel`，**无 `seq`** | `CandidateRecord` 自己那一份（逐字复用） |
 * | 两个信号 | `ask-user-changed` / `inject-messages-changed` | 无 `candidateId` / 无 `candidateChannel` / 无 `seq` | 无（推信号不推内容） |
 *
 * ## 归属格为什么叫 `candidateChannel` 而不是 `channel`
 *
 * **撞名**：`ask-user` 事件自己就带一格 `channel`（`AskUserChannelSchema`：提问工具是谁提供的，
 * `vendor-tool` / `host-tool` / `null`），而它是**落盘的**契约字段。两个后果都静默：
 *   · 类型层——`.extend()` 对同名键是**覆盖**，那一支的 `channel` 会变成 `'candidate' | 'judge'`，
 *     业务通道从类型里消失；
 *   · 运行时——组帧写作 `{ ...event, candidateId, candidateChannel }` 时若同名，信封值盖掉业务值，
 *     而消费方（`ui/composite/log-format.ts` 的提问那一行）查表得 `undefined`，界面上只印出
 *     `undefined`，没有任何报错。
 * 改名挑**信封这一侧**而不是业务那一侧：业务字段是落盘契约，改名会让旧 `events.jsonl` 里的
 * ask-user 事件解析失败（读侧按 schema 过滤，静默丢弃）；信封格只在线上存在、不落盘。
 * 守卫在 `run-stream.test.ts` 的「归属格不与业务字段同名」与「ask-user 的业务通道原样保留」两条。
 *
 * 三条口径各自对应一个不能混的理由：
 *   · **信号不落盘、不可续订**，故没有 `seq`，也不许借 `run-updated` 表达「挂起表变了」
 *     （`run-updated` 的语义是「`run.json` 落盘成功」，两者在列表页各触发不同的事）；
 *   · **消息帧没有 `seq`**：`messageId` 跨运行重号、`delta` 覆盖使历史可变，
 *     按 `seq` 续订对一份可变历史没有意义——消息只能靠 `messageId` 去重、`mergeKey` 覆盖；
 *   · **两个信号帧没有载荷**：它们是「去重读快照」的提示，不是数据本身，发布侧
 *     （`publishAskUserChanged` / `publishInjectChanged`）也不带定位参数。
 *
 * ## 为什么事件族与消息族是**映射**出来的、不是手抄的
 *
 * `AgentEventSchema` / `CandidateRecordSchema` 每个成员各自 `.extend(...)` 出一份带归属格的帧。
 * 手抄一遍字段的代价是「上游加一格、这里忘一格」，而症状是那一格在 SSE 上永远缺席
 * （消费方看到的是 `undefined`，不是报错）。映射之后上游即为真源。
 *
 * ⚠️ **不许用交叉类型**（`z.intersection` / TS 的 `&`）拼这两族：交叉出来的成员不是
 * `ZodObject`，进不了父级 `z.discriminatedUnion`——判别直接失效。
 *
 * ⚠️ **字面量必须与 `AGENT_EVENT_TYPES` 错开**：判别键统一是 `type`，撞名时 zod 在构造
 * 联合时就抛重复判别值。守卫在 `run-stream.test.ts`。
 */
import { z } from 'zod';
import { AgentEventSchema } from './agent-event';
import { CandidateRecordSchema } from './agent-message';

/**
 * 抽屉的两个通道：候选（被测智能体）与评分（评审者）。
 *
 * 这一份是**唯一一份**值域——抽屉流的 URL 参数 `?candidateChannel=`、服务端的白名单校验、
 * 客户端的抽屉键都从它派生，各写一份枚举必然漂移（漂移的症状是某个抽屉连上却永不刷新）。
 */
export const DRAWER_CHANNELS = ['candidate', 'judge'] as const;
export const DrawerChannelSchema = z.enum(DRAWER_CHANNELS);
export type DrawerChannel = z.infer<typeof DrawerChannelSchema>;

/** run 信号帧：某一轮落盘成功（无归属格——信号不属于任何一行、也不可续订） */
export const RunSignalFrameSchema = z.object({ type: z.literal('run-updated'), runId: z.string() });
export type RunSignalFrame = z.infer<typeof RunSignalFrameSchema>;

/**
 * 候选级事件帧的成员表：`AgentEvent` 的每个成员各扩上归属两格。
 *
 * `seq` 沿用事件自己那一格（按文件发号、从 1 起），本层不另发号——抽屉流的
 * `Last-Event-ID` 续订、以及「重跑同一行 ⇒ 号回到 1 ⇒ 换代」的判定都依赖这条口径。
 */
const candidateChannelEventFrames = AgentEventSchema.options.map((member) =>
  member.extend({ candidateId: z.string(), candidateChannel: DrawerChannelSchema }),
);
export type CandidateChannelEventFrame = z.infer<(typeof candidateChannelEventFrames)[number]>;

/**
 * 候选级消息帧的成员表：`CandidateRecord` 的每个成员各扩上归属两格，**不扩 `seq`**。
 *
 * 消息的 `messageId` 由适配器分配、跨运行重号，且 `delta` 覆盖使历史可变 ⇒ 按 `seq` 续订
 * 对一份会变的历史没有意义。消费方的两条对应关系因此换成：按 `messageId` 去重、
 * 按 `mergeKey` 覆盖累积。
 */
const candidateChannelMessageFrames = CandidateRecordSchema.options.map((member) =>
  member.extend({ candidateId: z.string(), candidateChannel: DrawerChannelSchema }),
);
export type CandidateChannelMessageFrame = z.infer<(typeof candidateChannelMessageFrames)[number]>;

/**
 * 两个**无载荷**信号帧：待答挂起表变了、人工消息队列变了。
 *
 * 为什么没有载荷：这两条是「去重读快照」的提示，不是数据本身——发布侧
 * （`publishAskUserChanged` / `publishInjectChanged`）本来也不带定位参数，
 * 帧里塞归属信息只会与发布侧的签名对不上。客户端的处置一律是「收到就重读快照」。
 *
 * 待答为什么也不借 `run-updated`：那一条的语义是「`run.json` 落盘成功」，
 * 两者在列表页各触发不同的事（前者要刷待答徽标，后者要刷整候选状态）。
 */
export const AskUserChangedFrameSchema = z.object({ type: z.literal('ask-user-changed') });
export type AskUserChangedFrame = z.infer<typeof AskUserChangedFrameSchema>;
export const InjectMessagesChangedFrameSchema = z.object({ type: z.literal('inject-messages-changed') });
export type InjectMessagesChangedFrame = z.infer<typeof InjectMessagesChangedFrameSchema>;

export const RunStreamFrameSchema = z.discriminatedUnion('type', [
  RunSignalFrameSchema,
  ...candidateChannelEventFrames,
  ...candidateChannelMessageFrames,
  AskUserChangedFrameSchema,
  InjectMessagesChangedFrameSchema,
]);
export type RunStreamFrame = z.infer<typeof RunStreamFrameSchema>;
