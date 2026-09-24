// @vitest-environment node
/**
 * 紧凑密度的实效字号码。
 * 这是**防回归**用例：有人「顺手补回 fontSize: 12」时，compactAlgorithm 会拿基础算法
 * 派生出的 fontSizeSM 当新基准重新推导，实效 fontSize 反而掉到 10px（比 antd 默认的 14 还小）。
 * 只有 fontSizeSM: 11 这一项产出目标值 12 / 11 / 14。
 */
import { describe, expect, it } from 'vitest';
import { theme } from 'antd';
import { COMPACT_FONT_TOKENS, compactTheme } from './density';

describe('compactTheme', () => {
  it('algorithm 是「底色算法 + 紧凑算法」的有序数组', () => {
    expect(compactTheme('light').algorithm).toEqual([theme.defaultAlgorithm, theme.compactAlgorithm]);
    expect(compactTheme('dark').algorithm).toEqual([theme.darkAlgorithm, theme.compactAlgorithm]);
  });

  it('暗色下实效字号为 12 / 11 / 14', () => {
    const token = theme.getDesignToken({
      algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
      token: { ...COMPACT_FONT_TOKENS },
    });
    expect(token.fontSize).toBe(12);
    expect(token.fontSizeSM).toBe(11);
    expect(token.fontSizeLG).toBe(14);
  });

  it('明亮下实效字号同样是 12 / 11 / 14', () => {
    const token = theme.getDesignToken({
      algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm],
      token: { ...COMPACT_FONT_TOKENS },
    });
    expect(token.fontSize).toBe(12);
    expect(token.fontSizeSM).toBe(11);
    expect(token.fontSizeLG).toBe(14);
  });

  it('防回归：显式写 fontSize 会把实效字号打回 10（错误写法）', () => {
    const wrong = theme.getDesignToken({
      algorithm: [theme.darkAlgorithm, theme.compactAlgorithm],
      token: { fontSize: 12, fontSizeSM: 11, fontSizeLG: 14 },
    });
    expect(wrong.fontSize).toBe(10);
  });
});
