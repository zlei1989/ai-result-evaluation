/**
 * dsh 会话通知的**判别常量**（真机逐字核过，见 `probe/dumps/v4/dsh-*.jsonl`）。
 *
 * 为什么单独一个模块：`events.ts`（行级事件投影）与 `message.ts`（内容级消息归一）都要按这些
 * 字符串分流，两处各写一份必然漂移——而漂移的症状是「某一类通知在事件里出现、在消息里消失」
 * （或反过来），排查时看不出是哪一层丢的。
 *
 * 通知共四种 method：`session.event`（具体事件，判别字段是 `params.event.type`）、
 * `session.status`（会话级状态）、`subagent.started`、`subagent.finished`。后两种是**顶层通知**，
 * 不套在 `session.event` 里。
 *
 * ⚠️ 2026-10-06 起它**同时是 dsh 用量字段名与读法的唯一真源**：`events.ts`（行级累计）与
 * `message.ts`（消息级那一次调用）都按同一份字段名读——两处各写一份必然漂移，而漂移的症状是
 * 「事件里的用量对、消息上的用量不对」（或反过来），界面上看着都正常。
 */
import type { UsageTokens } from '@aieval/contracts';
import { asRecord, readNumber } from '../../json';

/** 承载会话事件的通知方法名；其余方法（`session.status` 等）不产生事件。 */
export const DSH_SESSION_EVENT_METHOD = 'session.event';
/** 携带用量与会话消息的通知方法名（实测：用量挂在它的 `data.usage` 上，正文在 `data.message` 上）。 */
export const DSH_ASSISTANT_MESSAGE_TYPE = 'assistant/message';
/** 轮次结束的事件类型（实测：失败与收尾从这里取）。 */
export const DSH_TURN_END_TYPE = 'turn/end';
/** **一次模型 API 往返**的落点（实测：`turn/start` 之后、`assistant/message` 之前）——轮次在这里 +1 */
export const DSH_STEP_START_TYPE = 'step/start';
/** 轮次开始（用户口径 2026-09-29：卡片底部的活动行滚动**事件消息**，轮次边界也是一条） */
export const DSH_TURN_START_TYPE = 'turn/start';
/** 工具调用事件类型（实测：`data.{name, arguments}`，`arguments` 是 JSON 字符串） */
export const DSH_TOOL_CALL_TYPE = 'tool/call';
/** 工具结果事件类型（实测：`data.message.{content[], isError}`，结构化结果在同级 `data.meta` 里） */
export const DSH_TOOL_RESULT_TYPE = 'tool/result';
/**
 * 子智能体**派生**通知的方法名（真机 `subagent.started`，§6.5.1 ①）。
 * ⚠️ 它是**顶层通知**（`{ method, params }`），**不是** `session.event` 包一层——
 * 这正是它过去落进 `unknownEventDraft` 的原因（本项目原先只认 `session.event` 一种外形）。
 */
export const DSH_SUBAGENT_STARTED_METHOD = 'subagent.started';
/** 子智能体**收场**通知的方法名（真机，§6.5.1 ③：身份 / 终态 / 结果全在这一条） */
export const DSH_SUBAGENT_FINISHED_METHOD = 'subagent.finished';
/**
 * 子任务目录项（`session.event` 里的 `subagent/catalog`，真机 §6.5.1 ②）。
 * **任务名（`label`）与 mode 只在这一条里** ⇒ 必须跨消息记住，否则 start/finish 都拿不到名字。
 */
export const DSH_SUBAGENT_CATALOG_TYPE = 'subagent/catalog';
/** 子任务目录项的第二种载体（子会话里的事件，身份只在信封 `params.sessionId` 上） */
export const DSH_SUBAGENT_DESCRIPTOR_TYPE = 'subagent/descriptor';

/**
 * 用量三元组的字段名，**逐字来自真实探测**（`probe/dumps/dsh.json` 的
 * `assistant/message → data.usage`）：`{"inputTokens":218,"outputTokens":2,"cacheReadTokens":8832,…}`。
 *
 * ⚠️ 2026-10-06 从 `events.ts` 搬来这里：`message.ts`（消息归一）也要按同一份字段名读，
 * 而 `events.ts` 已经 import `message.ts` ⇒ 留在那边就是**循环依赖**。
 * `events.ts` 继续 re-export 这个名字，既有 import 路径不动。
 */
export const DSH_USAGE_FIELDS = {
  input: 'inputTokens',
  cached: 'cacheReadTokens',
  output: 'outputTokens',
  /** 思考 token（`TokenUsage.reasoningTokens`，类型上可选）：**采不到就是 null，不填 0** */
  reasoning: 'reasoningTokens',
  /** 厂商自报的总量（`TokenUsage.totalTokens`）：**只是证据**，不参与归一后的恒等式（见契约注释） */
  total: 'totalTokens',
} as const;

/**
 * 读一次模型调用的用量：三项（非缓存输入 / 缓存读 / 输出）缺一 ⇒ `null`（**不填 0**）；
 * 可选两格（思考 token、厂商总量）读不到就是 `null`。
 *
 * **纯函数**：不落日志、不改状态——落 WARN 是调用方（`events.ts` 的 `readTokens`）的事，
 * 因为消息归一那一层没有 drafts 收集器（这是我们把它抽出来的直接原因）。
 */
export function readUsageTokens(usage: unknown): UsageTokens | null {
  const record = asRecord(usage);
  const input = readNumber(record, DSH_USAGE_FIELDS.input);
  const cached = readNumber(record, DSH_USAGE_FIELDS.cached);
  const output = readNumber(record, DSH_USAGE_FIELDS.output);
  if (input === null || cached === null || output === null) return null;
  return {
    input,
    cached,
    output,
    reasoningOutput: readNumber(record, DSH_USAGE_FIELDS.reasoning),
    total: readNumber(record, DSH_USAGE_FIELDS.total),
  };
}
