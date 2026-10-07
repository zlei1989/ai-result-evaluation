// @vitest-environment node
/**
 * 用量求和：**一份实现**，三家（dsh 的子会话 / codex 的子线程 / claude 的子智能体文件）都用它。
 * 两条口径必须钉住：可选格「一格都没采到才是 null」，`total` **不相加**；另加合计那一格
 * （`addUsage`）的三条口径与那条**恒等**要求（加一个零不得改动主会话那一份）。
 */
import { describe, expect, it } from 'vitest';
import { addUsage, sumUsageTokens } from './usage';

describe('sumUsageTokens', () => {
  it('三格逐格相加', () => {
    expect(sumUsageTokens([
      { input: 10, cached: 2, output: 3 },
      { input: 1, cached: 20, output: 0 },
    ])).toEqual({ input: 11, cached: 22, output: 3, reasoningOutput: null, total: null });
  });

  it('空数组 ⇒ 全 0（「确实没有子智能体」的那一档，不是 null）', () => {
    expect(sumUsageTokens([])).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
  });

  it('reasoningOutput：都采到才相加，一格都没采到就是 null（绝不填 0）', () => {
    expect(sumUsageTokens([
      { input: 1, cached: 0, output: 1, reasoningOutput: 5 },
      { input: 1, cached: 0, output: 1, reasoningOutput: 7 },
    ]).reasoningOutput).toBe(12);
    expect(sumUsageTokens([
      { input: 1, cached: 0, output: 1, reasoningOutput: 5 },
      { input: 1, cached: 0, output: 1 },
    ]).reasoningOutput).toBe(5);
    expect(sumUsageTokens([{ input: 1, cached: 0, output: 1 }]).reasoningOutput).toBeNull();
  });

  it('total（厂商自报总量）**不相加**：它是单个会话的累计快照，加出来是我们的算术不是厂商的数', () => {
    expect(sumUsageTokens([
      { input: 1, cached: 0, output: 1, total: 100 },
      { input: 1, cached: 0, output: 1, total: 200 },
    ]).total).toBeNull();
  });

  it('显式 reasoningOutput: null 是「没采到」，不是「采到了 0」⇒ 仍是 null', () => {
    // 为什么单列：真机会送到显式 null（契约 schema 允许 null，claude 的 readThinkingTokens 缺字段就返回 null），
    // 若把判断从 `!= null` 松成 `!== undefined`，`+= null` 会悄悄当 0 ⇒ 这一格变成 0，
    // 正是「这家不思考」那个假数（口径禁止）。
    expect(sumUsageTokens([{ input: 1, cached: 0, output: 1, reasoningOutput: null }]).reasoningOutput).toBeNull();
  });

  it('显式 reasoningOutput: 0 是「采到了 0」⇒ 报 0，不被当成没采到', () => {
    // 为什么单列：`0` 与「没采到」是两件事。若判断写成真值判断（`if (part.reasoningOutput)`），
    // 厂商**确实报了 0** 会被跳过 ⇒ 报 null，等于把「确实为 0」说成「没上报」，同样是假话。
    expect(sumUsageTokens([{ input: 1, cached: 0, output: 1, reasoningOutput: 0 }]).reasoningOutput).toBe(0);
  });
});

describe('addUsage —— 主 + 子的合计（三条口径）', () => {
  it('子那一份非零 ⇒ 三格相加，且 `total` 记 null（合计不再是任何一个会话的厂商快照）', () => {
    expect(addUsage(
      { input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 },
      { input: 10, cached: 20, output: 5 },
    )).toEqual({ input: 110, cached: 920, output: 55, reasoningOutput: 30, total: null });
  });

  it('子那一份**逐格为零** ⇒ 主会话那一份**原样**返回（加一个零必须是恒等变换）', () => {
    /**
     * 这一条是**回归钉**（codex 那一家实测踩过）：`sumUsageTokens` 刻意不相加 `total`，
     * 于是朴素的「无条件求和」会把厂商自报的 `total` 抹成 `null` —— 而没有子智能体的行
     * （codex 的大多数行）本该**逐字段不变**。守卫：`total` 与 `reasoningOutput` 都得原样留着。
     */
    const main = { input: 100, cached: 900, output: 50, reasoningOutput: 30, total: 1050 };
    const zero = sumUsageTokens([]); // = {0,0,0,reasoningOutput:null,total:null}
    expect(addUsage(main, zero)).toBe(main);
    // 逐字段相等（不是「碰巧三格相同」）：`total` / `reasoningOutput` 一个都不许丢
    expect(addUsage(main, zero)).toEqual(main);

    /**
     * ⚠️ 「有子线程但三格全零」与「没有子智能体」（以及「子智能体一个 token 都没花」）在这一格里
     * **并成同一档**：数值上确实没多花一个 token，合计与主会话逐字段相同。它**不是**「这一行没有
     * 子智能体」的证明——那一句要靠各家自己的取数面（codex 那边见 `childUsageOf` 的注记）。
     * 这一档在 codex 上近乎不可达（要子线程文件里真有 `token_count` 且三格全 0），但可达性不是判据。
     */
    expect(addUsage(main, { input: 0, cached: 0, output: 0, reasoningOutput: 0, total: null })).toBe(main);
  });

  it('`null` 的两档：主会话读不到 ⇒ null（绝不拿子那一份冒充总数）；子读失败 ⇒ 退回主会话口径', () => {
    const main = { input: 10, cached: 1, output: 2 };
    const sub = { input: 4, cached: 1, output: 3 };
    expect(addUsage(null, sub)).toBeNull();
    expect(addUsage(null, null)).toBeNull();
    expect(addUsage(main, null)).toBe(main);
  });
});
