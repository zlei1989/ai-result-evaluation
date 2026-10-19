/**
 * `ListDetailLayout` 的 DOM 契约（真实 `react-resizable-panels`，jsdom 能观察的那部分）。
 *
 * jsdom 没有布局引擎，指针拖拽与真实像素宽在单测里不可达（见 `testing/resize-observer.ts`）；
 * 这里钉的是结构、宿主样式、像素还原后的百分比（`flexGrow`）与双击复位落盘。真机几何
 * （`getBoundingClientRect`、窄窗夹紧）由冒烟用例覆盖，拖拽落盘由
 * `list-detail-layout.persistence.test.tsx` 的接线替身覆盖。
 *
 * 判据说明：Panel 的宽度不是内联 `width`，库把它摊成 `flex-basis: 0` + `flex-grow: <百分比>`；
 * 详情栏 700px 在 1200px 的分栏轴上就是 58.333%。按比例送宽度会让这个数随容器漂移，
 * 所以这里同时钉「像素还原后落在哪一格」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ListDetailLayout } from './list-detail-layout';
import { installResizeObserverStub } from '../testing/resize-observer';

// 真实库在挂载与尺寸变化时 new ResizeObserver；jsdom 不提供，不打桩挂载即抛
beforeEach(() => {
  installResizeObserverStub();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function renderLayout(props: Partial<ComponentProps<typeof ListDetailLayout>> = {}): ReturnType<typeof render> {
  return render(
    <ListDetailLayout
      list={<span>列表内容</span>}
      detail={<span>详情内容</span>}
      detailOpen
      widthStorageKey="test-layout-width"
      {...props}
    />,
  );
}

/**
 * 按元素角色给宽度：分组本身 1200px，两栏合计 1200px（每组 600）。
 * 库的百分比以「两栏像素和」为轴，故详情栏 700px ⇒ 58.333%；若哪次按比例送宽度，
 * 这个数就再也对不上。全局返回同一个值会让轴变成 2×容器，断言数字失去意义。
 */
function stubPaneWidths(containerWidth: number): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-group') ? containerWidth : containerWidth / 2;
  });
}

/** 详情栏根节点：宽度落在它的内联 flex-grow 上 */
function detailPanel(): HTMLElement | null {
  return screen.getByTestId('resizable-pane-detail');
}

/** 详情栏宿主的样式在内层节点上（Panel 把 className/style 套进内容壳） */
function detailHost(): HTMLElement {
  const host = detailPanel()?.firstElementChild;
  if (!(host instanceof HTMLElement)) throw new Error('详情栏缺少内容壳');
  return host;
}

describe('ListDetailLayout', () => {
  it('detailOpen=false 时不渲染右栏，列表占满', () => {
    const { container } = renderLayout({ detailOpen: false, detail: null });
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(screen.queryByText('详情内容')).not.toBeInTheDocument();
    // 只查文案抓不住「恒渲染双栏」：本用例的 detail 本来就是 null，真渲染出来也是一条空栏。
    // 必须断言结构——右栏与分隔条都不该存在。
    expect(screen.queryByTestId('resizable-pane-detail')).toBeNull();
    expect(container.querySelectorAll('[data-separator]').length).toBe(0);
    expect(container.querySelectorAll('[data-panel]').length).toBe(0);
  });

  it('detailOpen 为真但 detail 为 null 时同样退化为单栏（不留空栏）', () => {
    const { container } = renderLayout({ detail: null });
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-separator]').length).toBe(0);
    expect(screen.queryByTestId('resizable-pane-detail')).toBeNull();
  });

  it('detailOpen=true 时两栏都渲染，且有一个 role=separator 的分隔条', () => {
    const { container } = renderLayout();
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(screen.getByText('详情内容')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-panel]').length).toBe(2);
    const separator = container.querySelector('[data-separator]');
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute('role')).toBe('separator');
  });

  it('详情栏宿主可滚动且带内边距（长内容不被裁掉）', () => {
    renderLayout();
    expect(detailHost().style.overflow).toBe('auto');
    expect(detailHost().style.padding).toBe('16px');
    // 纵向 flex 是内容里 flex:1 的参照；少了它，长内容会把栏撑开而不是内部滚动
    expect(detailHost().style.display).toBe('flex');
    expect(detailHost().style.flexDirection).toBe('column');
  });

  it('列表栏是弹性列：不给宽度，详情栏按默认 420px 起算', async () => {
    const widthSpy = stubPaneWidths(1200);
    try {
      renderLayout({ widthStorageKey: 'default-width' });
      // 1200px 的轴、详情栏 420px ⇒ 35%
      await waitFor(() => expect(detailPanel()?.style.flexGrow).toBe('35'));
      const list = screen.getByTestId('resizable-pane-list');
      expect(list.style.flexGrow).toBe('65');
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('存量是像素：刷新后按 resize(700) 还原（1200px 轴上落在 58.333%），不再用默认宽', async () => {
    const widthSpy = stubPaneWidths(1200);
    try {
      window.localStorage.setItem('restore-key', '700');
      renderLayout({ widthStorageKey: 'restore-key' });
      await waitFor(() => expect(detailPanel()?.style.flexGrow).toBe('58.333'));
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('双击分隔条复位到默认宽，并把复位结果落盘（H-05）', async () => {
    const widthSpy = stubPaneWidths(1200);
    try {
      window.localStorage.setItem('reset-key', '700');
      const { container } = renderLayout({ widthStorageKey: 'reset-key' });
      // 先等到存量值生效，才能证明双击确实把它改回去了
      await waitFor(() => expect(detailPanel()?.style.flexGrow).toBe('58.333'));

      const separator = container.querySelector('[data-separator]');
      expect(separator).not.toBeNull();
      act(() => {
        fireEvent.doubleClick(separator as HTMLElement);
      });

      await waitFor(() => expect(detailPanel()?.style.flexGrow).toBe('35'));
      expect(window.localStorage.getItem('reset-key')).toBe('420');
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('detailOpen 从 false 变 true 时右栏出现，并重新按偏好还原（受控切换）', async () => {
    const widthSpy = stubPaneWidths(1200);
    try {
      window.localStorage.setItem('toggle-key', '700');
      const { rerender } = render(
        <ListDetailLayout
          list={<span>列表内容</span>}
          detail={null}
          detailOpen={false}
          widthStorageKey="toggle-key"
        />,
      );
      expect(screen.queryByText('详情内容')).not.toBeInTheDocument();
      rerender(
        <ListDetailLayout
          list={<span>列表内容</span>}
          detail={<span>详情内容</span>}
          detailOpen
          widthStorageKey="toggle-key"
        />,
      );
      expect(screen.getByText('详情内容')).toBeInTheDocument();
      // 重新挂载时不能停在 defaultSize 420：恢复路径要再走一次 resize(700)
      await waitFor(() => expect(detailPanel()?.style.flexGrow).toBe('58.333'));
    } finally {
      widthSpy.mockRestore();
    }
  });

  /**
   * 窄视口覆盖模式：并排在 1280 以下放不下六列表格（770px），此时列表必须保持整宽、
   * 详情改走 Sheet。jsdom 通过 `matchMedia` 桩把断点「拨到窄」，其余结构照常渲染。
   */
  it('窄视口下详情走 Sheet 覆盖层，列表保持整宽', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 1279px)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));

    renderLayout();

    // 并排的两栏都不在了：列表整宽、详情进覆盖层
    expect(screen.queryByTestId('resizable-pane-list')).toBeNull();
    expect(screen.queryByTestId('resizable-pane-detail')).toBeNull();
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(screen.getByText('详情内容')).toBeInTheDocument();
    // 覆盖层必须自带关闭入口：窄屏没有「点顶栏回列表」这条退路
    expect(screen.getByRole('button', { name: '关闭详情' })).toBeInTheDocument();
  });

  it('窄视口覆盖层的关闭按钮回调 onRequestCloseDetail（不自己改 detailOpen）', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 1279px)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    const onClose = vi.fn();

    renderLayout({ onRequestCloseDetail: onClose });
    fireEvent.click(screen.getByRole('button', { name: '关闭详情' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
