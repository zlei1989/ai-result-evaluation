/**
 * TableScrollArea：滚动容器的三条结构性不变量。
 *
 * 为什么只断言「这三条无条件落在内联 style 上」：jsdom 没有布局引擎，「能不能真的滚」在这里
 * 测不出来（与 PageShell 的 minHeight 守卫同一个处境）。而这三条又都能被静默漏掉——
 * 漏掉 `minHeight: 0` 时容器按内容高度撑开、永不滚动，界面只是「长列表下面的行点不到」，
 * 没有任何报错。真正的滚动行为（槽宽归零、表头钉住）留在真实浏览器冒烟里用几何断言验。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TABLE_SCROLL_STYLE, TableScrollArea } from './table-scroll-area';

/** 取渲染出来的滚动容器（Flex 是根节点） */
function renderArea(): HTMLElement {
  const { container } = render(
    <TableScrollArea>
      <span>表格</span>
    </TableScrollArea>,
  );
  return container.firstElementChild as HTMLElement;
}

describe('TableScrollArea', () => {
  it('渲染子节点', () => {
    renderArea();
    expect(screen.getByText('表格')).toBeInTheDocument();
  });

  it('滚动接管在自己身上，且允许收缩到分配高度', () => {
    const root = renderArea();

    // 这三条就是文件头列的不变量：少任何一条都不会报错，只会静默失去「按需滚动」
    expect(root.style.overflow).toBe('auto');
    expect(root.style.minHeight).toBe('0px');
    // 实测 jsdom 把 `flex: 1` 原样回读成 '1'（不是展开后的 '1 1 0%'）
    expect(root.style.flex).toBe('1');
  });

  it('常量与渲染结果一致（改常量必然改渲染，守卫不会两边漂移）', () => {
    const root = renderArea();

    expect(TABLE_SCROLL_STYLE).toEqual({ flex: 1, minHeight: '0px', overflow: 'auto' });
    expect(root.style.overflow).toBe(TABLE_SCROLL_STYLE.overflow);
    expect(root.style.minHeight).toBe(TABLE_SCROLL_STYLE.minHeight);
  });
});
