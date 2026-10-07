/**
 * `readAppliedThemeMode` / `useAppliedThemeMode`：读**已经解析好**的实际明暗。
 *
 * 为什么需要它：`useResolvedTheme()` 的 `preference` 参数缺省是 `'dark'`（`app-theme.tsx` 里
 * `rawPreference ?? 'dark'`，那是给 SSR 期兜底、不闪白用的）。页面上再调一次
 * `useResolvedTheme()` 而不传偏好，就会得到 `'dark'` —— 既是**第二份**主题判据，
 * 又与真正解析过的结果相反；它的 `apply` 副作用还会把 `data-theme` 改回暗色。
 *
 * 本仓已经有一条明确口径（`app-theme.tsx` 头注释）：`html[data-theme]` **恒为解析后的明暗**。
 * 故消费方读它即可，不必自行再解析一次。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readAppliedThemeMode, useAppliedThemeMode } from './app-theme';

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('readAppliedThemeMode', () => {
  it('没有 data-theme 时按暗色（与服务端默认一致，SSR 首帧不闪白）', () => {
    expect(readAppliedThemeMode()).toBe('dark');
  });

  it('读的是 data-theme 这个**已解析**的值，不是偏好', () => {
    document.documentElement.dataset.theme = 'light';

    expect(readAppliedThemeMode()).toBe('light');
  });

  it('值不是 light/dark 时按暗色兜底（脏属性不该让界面拿到非法值）', () => {
    document.documentElement.dataset.theme = 'auto';

    expect(readAppliedThemeMode()).toBe('dark');
  });
});

describe('useAppliedThemeMode', () => {
  it('跟随 documentElement 的 data-theme 变化（主题切换后调用方要能跟上）', async () => {
    document.documentElement.dataset.theme = 'light';
    const { result } = renderHook(() => useAppliedThemeMode());

    expect(result.current).toBe('light');

    // 模拟「设置页切到暗色」：providers 会把解析结果写回 data-theme
    await act(async () => {
      document.documentElement.dataset.theme = 'dark';
      await Promise.resolve();
    });

    expect(result.current).toBe('dark');
  });
});
