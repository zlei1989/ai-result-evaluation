// @vitest-environment node
/**
 * 主题解析的纯函数口径。
 * 注意：readSystemDark 在无 window / 无 matchMedia 时必须回落到「深色」——
 * 这与服务端默认主题一致，保证 SSR 首帧不闪白。这条兜底必须单独锁定。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSystemDark, resolveThemeMode } from './theme-resolve';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveThemeMode', () => {
  it('auto 跟随系统深色偏好', () => {
    expect(resolveThemeMode('auto', true)).toBe('dark');
    expect(resolveThemeMode('auto', false)).toBe('light');
  });

  it('显式 light / dark 忽略系统偏好', () => {
    expect(resolveThemeMode('light', true)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
  });
});

describe('readSystemDark', () => {
  it('无 window（SSR / node）时回落深色', () => {
    vi.stubGlobal('window', undefined);
    expect(readSystemDark()).toBe(true);
  });

  it('有 window 但无 matchMedia 时回落深色', () => {
    vi.stubGlobal('window', {});
    expect(readSystemDark()).toBe(true);
  });

  it('有 matchMedia 时按查询结果', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(readSystemDark()).toBe(false);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(readSystemDark()).toBe(true);
  });
});
