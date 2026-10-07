/**
 * `VirtualList`（虚拟化的唯一持有者）的守卫。四条：
 *   1. **量不到高度就不虚拟化**（jsdom 里 `clientHeight === 0`）：此时全部项都在 DOM 里——
 *      这既是「退化不报错」的口径，也是**其它用例能数到全部内容**的前提（没有它，
 *      每个渲染列表的用例都得先造一个假的布局引擎）；
 *   2. **`onMeasured` 会把宿主交回来**：调用方靠它数「已渲染 N」（数自己标的锚点属性）；
 *   3. **`scrollToKey` 对不存在的键不抛**：列表还在流式追加时跳一个还没有的键是正常操作，
 *      抛错会让一次滚动静默变成白屏（与 `virtual-turn-list` 的越界处置同口径）；
 *   4. **不出现 `itemHeight`**（本仓调用口径：动态高度由底层逐项测量）。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { VirtualList, type VirtualListHandle } from './virtual-list';
import { installResizeObserverStub } from '../testing/resize-observer';

/**
 * `Listy` 内部 `new ResizeObserver(...)`（`@rc-component/resize-observer` 读**全局构造器**）：
 * jsdom 里不打桩，一挂载就抛 `ReferenceError`。桩只影响「量得到/量不到」——
 * jsdom 的 `clientHeight` 恒为 0，所以虚拟化照旧退化（见守卫 1）。
 */
beforeEach(() => {
  installResizeObserverStub();
});

const ITEMS = ['第一条', '第二条', '第三条'];

describe('VirtualList', () => {
  it('量不到高度 ⇒ 不虚拟化：每一项都在 DOM 里（退化而不是报错）', () => {
    render(
      <VirtualList
        items={ITEMS}
        rowKey={(item) => item}
        itemRender={(item) => <span data-testid="row">{item}</span>}
        testId="list"
      />,
    );

    expect(screen.getAllByTestId('row').map((node) => node.textContent)).toEqual(ITEMS);
  });

  it('onMeasured 把宿主交回来（调用方在那一刻数已渲染行数）', () => {
    const onMeasured = vi.fn();
    render(
      <VirtualList
        items={ITEMS}
        rowKey={(item, index) => `${index}|${item}`}
        itemRender={(item) => <span data-testid="row">{item}</span>}
        onMeasured={onMeasured}
      />,
    );

    expect(onMeasured).toHaveBeenCalled();
    // 交回来的必须是**列表宿主**（里面数得到行），不是随便一个节点
    const host = onMeasured.mock.calls[0]?.[0] as HTMLElement | undefined;
    expect(host?.querySelectorAll('[data-testid="row"]').length).toBe(ITEMS.length);
  });

  it('scrollToKey 对不存在的键不抛（列表还在追加时跳一个还没有的键是正常操作）', () => {
    const ref = createRef<VirtualListHandle>();
    render(
      <VirtualList
        controllerRef={ref}
        items={ITEMS}
        rowKey={(item) => item}
        itemRender={(item) => <span data-testid="row">{item}</span>}
      />,
    );

    expect(() => ref.current?.scrollToKey('还没有的那一项')).not.toThrow();
    expect(() => ref.current?.scrollToKey('第二条', 'bottom')).not.toThrow();
  });
});
