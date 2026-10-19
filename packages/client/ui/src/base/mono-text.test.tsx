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

  /**
   * 等宽字体必须**同时**落在承载文本的那个元素上。
   *
   * 宿主上的 `font-family` 会被任何给内层文本设了字体的包裹盖掉：真机上出现过宿主写着
   * `SFMono-Regular…`、文本那一格算出来却是系统字体，于是「等宽」变成一句写在代码里的话术。
   * jsdom 没有 CSS 级联，量不出计算值，
   * 所以这里钉的是**机制**：字体在文本元素自己也有一份；真机上的计算值由界面冒烟量
   * `getComputedStyle` 兜底。
   */
  it('等宽字体也挂在文本元素上（只挂在宿主上会被内层包裹覆盖）', () => {
    render(<MonoText text="a" dataTestId="log-text" />);

    const host = screen.getByTestId('log-text');
    const inner = host.querySelector('span');
    expect(inner).not.toBeNull();
    // 宿主与文本元素都走命名类 `font-mono`，文本元素另有内联字体兜底
    expect(host.classList.contains('font-mono')).toBe(true);
    expect(inner?.classList.contains('font-mono')).toBe(true);
    expect(inner?.style.fontFamily).toBe('var(--font-mono)');
  });

  it('maxHeight 落到宿主的限高上，且文本保留换行', () => {
    render(<MonoText text={'a\nb'} maxHeight={240} dataTestId="log-text" />);

    const host = screen.getByTestId('log-text');
    expect(host.style.maxHeight).toBe('240px');
    expect(host.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(host.classList.contains('overflow-auto')).toBe(true);
  });
});
