/**
 * MonoText：等宽文本块 + 尾部自动滚动。
 * **注意 jsdom 没有布局引擎**：`scrollHeight` 恒为 0，直接断言 `scrollTop` 会把
 * 「压根不滚动」的实现也判成通过（`0 === 0`）。所以用例把元素的 `scrollHeight`
 * 用 defineProperty 顶成 720，让「滚到底」这件事在数值上可见；
 * 反向用例先把 `scrollTop` 设成 123，看它会不会被**错误地**重置。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MonoText } from './mono-text';

describe('MonoText', () => {
  it('文本变化时把宿主滚到底（autoScroll 打开）', () => {
    const { rerender } = render(<MonoText text="第一行" autoScroll dataTestId="log-text" />);
    const host = screen.getByTestId('log-text');
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });

    rerender(<MonoText text={'第一行\n第二行'} autoScroll dataTestId="log-text" />);

    expect(host.scrollTop).toBe(720);
  });

  it('autoScroll 关闭时不碰滚动位置（用户往上翻的动作不能被按回去）', () => {
    const { rerender } = render(<MonoText text="第一行" dataTestId="log-text" />);
    const host = screen.getByTestId('log-text');
    Object.defineProperty(host, 'scrollHeight', { value: 720, configurable: true });
    host.scrollTop = 123;

    rerender(<MonoText text={'第一行\n第二行'} dataTestId="log-text" />);

    expect(host.scrollTop).toBe(123);
  });

  it('maxHeight 落到宿主的限高上，且文本保留换行', () => {
    render(<MonoText text={'a\nb'} maxHeight={240} dataTestId="log-text" />);

    const host = screen.getByTestId('log-text');
    expect(host.style.maxHeight).toBe('240px');
    expect(host.style.whiteSpace).toBe('pre-wrap');
    expect(host.style.overflow).toBe('auto');
  });
});
