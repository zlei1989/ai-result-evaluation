/**
 * 「作废一条历史」这一格契约的**叶子定义**。
 *
 * 为什么单独一个文件：`EvalRowSchema`（`run.ts`）要带这一格，而 `checkpoint.ts` 本身要引
 * `inject-message.ts`，后者又经 `agent-message` → `agent-event` 回到 `run.ts` ——
 * 整条链是个环。环上的模块在包根评估顺序里会撞上「TDZ」（`Cannot access X before initialization`），
 * 而**类型检查与按文件跑的用例都看不出来**（它们不走包根那条全量评估顺序）。
 *
 * 所以这一格被下沉成只依赖 `zod` 的叶子：两个原本互相需要的模块都从叶子取，环在模块层被剪断。
 *
 * ⚠️ **不要往这个文件里加任何 `./` 依赖**——它存在的全部理由就是不再引任何东西。
 */
import { z } from 'zod';

export const CheckpointVoidSchema = z.object({
  /** 这一次作废的身份（同一次回到某一轮只落一条） */
  checkpointId: z.string().min(1),
  /** 回到的是哪一段（0 = 第一次跑那一段，n ≥ 1 = 第 n 次续段） */
  segment: z.number().int().min(0),
  /** 回到的是这一段里的第几轮（**保留，含**） */
  turn: z.number().int().min(1),
  /** 落标记那一刻已存在的最大段号（作废范围的上界，见文件头） */
  throughSegment: z.number().int().min(0),
  /** 落标记的时刻 */
  at: z.string().min(1),
  /** 作废那一截的用量（采不到为 `null`，绝不填 0） */
  tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable(),
  /** 作废那一截的轮次（主会话往返数） */
  turns: z.number().int().min(0),
});
export type CheckpointVoid = z.infer<typeof CheckpointVoidSchema>;
