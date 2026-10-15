/**
 * run 焦点：模块级单例 + 订阅式读。
 *
 * 这一层是「暂缓」的判据来源（浮层按它决定弹谁不弹谁），两条风险面各一条用例：
 *   1. 设了焦点订阅方要**立刻读到**（不重渲染就没暂缓）；
 *   2. 值没变不许通知（列表页每帧都用当前选中项设一次，通知一次就是白重渲染一次整页浮层）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { resetRunFocusForTesting, setFocusedRun, useFocusedRun } from './run-focus';

beforeEach(() => {
  resetRunFocusForTesting();
});

describe('useFocusedRun', () => {
  it('默认没有焦点：没在看某一轮时，全部提问都可弹（暂缓不是丢弃）', () => {
    const { result } = renderHook(() => useFocusedRun());

    expect(result.current).toBeNull();
  });

  it('设焦点后订阅方读到新的那一轮，切走时回到 null', () => {
    const { result } = renderHook(() => useFocusedRun());

    act(() => setFocusedRun('run-1'));
    expect(result.current).toBe('run-1');
    act(() => setFocusedRun('run-2'));
    expect(result.current).toBe('run-2');
    act(() => setFocusedRun(null));
    expect(result.current).toBeNull();
  });

  it('重复设同一个值不通知（否则列表页每帧都会让浮层重渲染一次）', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useFocusedRun();
    });
    const before = renders;

    act(() => setFocusedRun(null)); // 与当前值相同
    expect(renders).toBe(before);

    act(() => setFocusedRun('run-1'));
    expect(renders).toBeGreaterThan(before);
  });
});
