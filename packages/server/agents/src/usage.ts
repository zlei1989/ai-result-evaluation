/**
 * 用量求和：**子智能体那一份**的唯一实现（2026-10-04）。
 *
 * 为什么单独一个文件：三家都要把「若干个会话 / 线程 / 文件的用量」加起来
 * （dsh 按子会话、codex 按子线程、claude 按子智能体文件），三处各写一遍必然漂移，
 * 而漂移的表现是「同样的子智能体在三家算出的 tok 不一样」——最难查的一类。
 *
 * 两条口径：
 *   1. **可选格（`reasoningOutput`）一格都没采到才是 `null`**：与 `UsageTokens` 的
 *      「缺项即 null」同源，绝不填 0（`reasoningOutput: 0` 会让人得出「这家不思考」）；
 *   2. **`total` 不相加**：它是厂商自报的**单个会话/线程的累计快照**，把两个会话的快照加起来
 *      得到的是我们的算术，而契约里那一格的语义是「厂商原文」（见 `UsageTokensSchema` 注释）
 *      ⇒ 子智能体这一份恒为 `null`。
 *
 * 合计那一格（主 + 子）**也住在这一层**（`addUsage`）：它同样是三家共用的规则，且带一条不显眼、
 * 会咬人的恒等要求（见那个函数的注释）——放在任何**一家**的目录里，另一家都会重新踩一遍。
 */
import type { UsageTokens } from '@aieval/contracts';

export function sumUsageTokens(parts: readonly UsageTokens[]): UsageTokens {
  let input = 0;
  let cached = 0;
  let output = 0;
  let reasoningOutput = 0;
  let sawReasoning = false;
  for (const part of parts) {
    input += part.input;
    cached += part.cached;
    output += part.output;
    if (part.reasoningOutput != null) {
      reasoningOutput += part.reasoningOutput;
      sawReasoning = true;
    }
  }
  return { input, cached, output, reasoningOutput: sawReasoning ? reasoningOutput : null, total: null };
}

/**
 * 主会话 + 子智能体那一份 = **合计**（spec 2026-10-04 §2.2 / §2.3）。
 *
 * 为什么它必须与 `sumUsageTokens` 同住一个模块：三家都要做这一步，而它比看起来多两条口径
 * ——各写一遍必然有一家踩坑，且踩坑的表现**既不在界面上显眼、也不在类型上可查**
 * （本仓实测：codex 那一家按朴素写法实现时，三条既有用例红的是「厂商自报的 `total` 从 1050
 * 变成了 `null`」，而那与子智能体一个字的关系都没有）。
 *
 * ## 三条口径
 *
 * 1. **子那一份逐格为零 ⇒ 返回 `main` 原样**。加一个零必须是**恒等**变换：`sumUsageTokens`
 *    刻意不相加 `total`（见上），无条件求和会把主线程那一格的 `total` 抹成 `null`，
 *    而**没有子智能体的行**正是这一档 —— 代价是白丢一个排障证据。
 * 2. **`main === null` ⇒ `null`**：拿不出合计。绝不能拿子那一份冒充总数（界面按
 *    「主会话 = 合计 − 分量」推主会话那一行，会算出**负数**）。
 * 3. **`sub === null` ⇒ `main`**：spec §2.2 的第三档「有子智能体但读失败 ⇒ 合计退回主会话口径」。
 *    ⚠️ 调用方若需要区分这一档与「合计可用」（例如「这一条要不要把两格**一起**交出去」），
 *    必须在调用**前**自己判 `sub === null` —— 本函数把「分量不可用」与「分量是零」都归成了
 *    一个非 null 的返回值，这正是「合计」的定义：只要主会话在，合计就说得出来。
 *
 * ⚠️ 口径 1 把「没有子智能体」与「有子智能体但三格全零」并进了同一档：后者**数值上**确实没多花
 * 一个 token（合计与主会话逐字段相同），但它不是「这一行没有子智能体」——界面会照 spec §2.2
 * 把分量显示成 `{0,0,0}`（「子智能体一个 token 都没花」是允许的读法），不能读成「没有子智能体」。
 * 这一档在 codex 上近乎不可达（要子线程文件里真有 `token_count` 且三格全 0），但可达性不是判据。
 */
export function addUsage(main: UsageTokens | null, sub: UsageTokens | null): UsageTokens | null {
  if (main === null) return null;
  if (sub === null) return main;
  // 加一个零 = 恒等（口径 1）：无条件求和会顺手把厂商自报的 `total` 抹掉
  if (sub.input === 0 && sub.cached === 0 && sub.output === 0) return main;
  return sumUsageTokens([main, sub]);
}
