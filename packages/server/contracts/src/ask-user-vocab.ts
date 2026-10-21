/**
 * 提问与应答的**词表**：一次提问的收场方式（七态）与提问工具的来源通道（两档）。
 *
 * 为什么单独一格而不是留在 `agent-message.ts`（它们原来的落点）：这两份词表**消息账本与候选级事件都要用**
 * ——问题与答案挂在消息块上，而「这一问最后怎么收场」还要出现在候选级事件里。若把定义留在
 * `agent-message`，`agent-event` 引它就会与既有那条「`agent-message` 引 `agent-event` 的
 * `UsageTokensSchema`」构成环：环上先求值的那个模块拿到的是 `undefined`，
 * 而 zod 在模块求值期就会读这些枚举（不是等到解析时才读），表现为导入即崩。
 * 本模块不 import 任何其它契约模块，两个方向都只 import 它，环因此不存在。
 */
import { z } from 'zod';

/**
 * **收场方式（七态）**：一次提问最后是怎么结束的，与只读复盘卡片上的那七态同名同义。
 *
 * 它与「答案」是两个独立事实：`answered` 一定有答案，而另外六态是六种**不同的**「没有答案」
 * （厂商自己按预算收掉 / 用户跳过 / 等超时 / 通道不可用 / 厂商当场拒 / 随候选终止）。
 * 把任何两种合成一句「未回答」，排障时分不清「厂商自动决议」与「根本没人能答」。
 */
export const AskUserOutcomeSchema = z.enum([
  'answered',
  'auto-resolved',
  'skipped',
  'timeout',
  'unavailable',
  'rejected',
  'canceled',
]);
export type AskUserOutcome = z.infer<typeof AskUserOutcomeSchema>;

/**
 * **提问工具是谁提供的**：`vendor-tool` = 厂商自己的提问工具（提示词也归厂商），
 * `host-tool` = 我们注册进会话的工具（提示词是我们写的）。
 *
 * 为什么必须单列一格：两者的**提示词来源不同**——排查「模型为什么问得这么差」时，
 * 前者要去读厂商的文案，后者要去读我们自己的 `promptGuidelines`；合成一格就再也分不开。
 */
export const AskUserChannelSchema = z.enum(['vendor-tool', 'host-tool']);
export type AskUserChannel = z.infer<typeof AskUserChannelSchema>;
