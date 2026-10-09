/**
 * ContextWindowTag：上下文窗口的展示（今天只有创建评测的模型下拉在用它）。
 * 判据落在**文案**上而不是颜色上：颜色是主题层的实现细节，而「1.05M 不能被显示成 1M」
 * 是这条组件存在的理由 —— 它恰好横跨 cc 的 `[1m]` 后缀阈值（spec D4）。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextWindowTag, formatContextWindow } from './context-window-tag';

describe('formatContextWindow', () => {
  it('≥1M 保留两位再去尾零，其余按 K 取整；未知就是「未知」', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M');
    expect(formatContextWindow(1_048_576)).toBe('1.05M');
    expect(formatContextWindow(400_000)).toBe('400K');
    expect(formatContextWindow(262_144)).toBe('262K');
    expect(formatContextWindow(131_072)).toBe('131K');
    expect(formatContextWindow(undefined)).toBe('未知');
  });

  it('阈值两侧的字符串不同（999999 → 1000K，1000000 → 1M）', () => {
    // 这一条盯的是「别把 999999 也显示成 1M」：格式化函数若先把数字取整到「档」，阈值那两侧
    // 就会长得一样，而 `[1m]` 后缀恰恰按阈值决定加不加（spec D4）
    expect(formatContextWindow(999_999)).toBe('1000K');
    expect(formatContextWindow(1_000_000)).toBe('1M');
  });
});

describe('ContextWindowTag', () => {
  it('渲染格式化后的文案', () => {
    render(<ContextWindowTag contextWindow={1_048_576} />);
    expect(screen.getByText('1.05M')).toBeTruthy();
  });

  it('未知时显示「未知」（不显示 0、也不留空）', () => {
    render(<ContextWindowTag contextWindow={undefined} />);
    expect(screen.getByText('未知')).toBeTruthy();
  });
});
