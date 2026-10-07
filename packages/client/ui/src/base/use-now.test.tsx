/**
 * useNow：给「运行中的耗时」用的秒级心跳。
 * 两条判据：
 *   · `active === true` 时按间隔推进（耗时才会每秒往上走）；
 *   · `active === false` 时**不挂定时器**（终态的卡片不该继续每秒重渲染整页），
 *     卸载时定时器必须被清掉（否则详情页开着关着会越积越多）。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNow } from './use-now';

afterEach(() => {
  vi.useRealTimers();
});

describe('useNow', () => {
  it('active 为 true 时按间隔推进', () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T08:00:00.000Z') });
    const { result } = renderHook(() => useNow(true, 1_000));

    const initial = result.current;
    // 定时器里的 setState 必须在 act 里推进才会刷进 result.current
    act(() => vi.advanceTimersByTime(3_000));

    expect(result.current - initial).toBe(3_000);
  });

  it('active 为 false 时不挂定时器，值不随时间变（也不白白重渲染）', () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T08:00:00.000Z') });
    const { result } = renderHook(() => useNow(false, 1_000));

    const initial = result.current;
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10_000));

    expect(result.current).toBe(initial);
  });

  it('卸载后定时器被清掉（详情页反复开关不会积压）', () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T08:00:00.000Z') });
    const { unmount } = renderHook(() => useNow(true, 1_000));
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
