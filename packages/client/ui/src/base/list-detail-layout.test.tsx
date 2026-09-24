/**
 * ListDetailLayout：脚手架的核心验收对象。
 * 三条必须成立的行为：
 *   1. detailOpen=false 时右栏不渲染（不是渲染一个 0 宽的空栏——Splitter 的 min 会把它夹回来）；
 *   2. 右栏宿主可滚动（否则长内容被裁掉且没有滚动条）；
 *   3. 拖拽回调能把像素宽度回写进 size（受控模式下不回写会松手弹回）。
 *
 * 三条都**真的钉住了**：用变异测试逐条验证过——把缺陷注入实现，对应断言必须失败。
 * 其中两条的守卫不是「查文案 / 查 DOM 里有没有浮层」这种间接写法（那样抓不住变异体）：
 *   · detailOpen=false 必须断言**结构上**没有右栏宿主与分隔条（本用例的 detail 本来就是 null，
 *     只查文案的话「恒渲染双栏」这个变异体照样通过）；
 *   · 面板宽度要看 Panel 的内联 flex-basis（「不给弹性列 size」与「宽度回写」的唯一可观察面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ListDetailLayout } from './list-detail-layout';
import { FakeResizeObserver, installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，而 antd 的 Splitter 内部（@rc-component/resize-observer 的
// ensureResizeObserver）直接 new 全局构造器、没有 polyfill：不打桩，挂载即抛
// ReferenceError —— 环境缺口，不是被测代码的问题（见 src/testing/resize-observer.ts）。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

/** 右栏所在的 Splitter.Panel：宽度只落在它的内联 flex-basis 上，故按宿主 testid 反查 */
function detailPanel(): HTMLElement | null {
  return screen.getByTestId('resizable-pane-detail').closest<HTMLElement>('.ant-splitter-panel');
}

describe('ListDetailLayout', () => {
  it('detailOpen=false 时不渲染右栏，列表占满', () => {
    const { container } = renderLayout({ detailOpen: false, detail: null });
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(screen.queryByText('详情内容')).not.toBeInTheDocument();
    // 只查文案抓不住「恒渲染双栏」：本用例的 detail 本来就是 null，真渲染出来也是一条空栏。
    // 必须断言结构——右栏宿主与分隔条都不该存在。这正是文件头要点 3 说的缺陷：
    // 渲染宽度为 0 的 Panel 会被 Splitter 的 min 夹回最小宽，留下一条真实占位的空栏。
    expect(screen.queryByTestId('resizable-pane-detail')).toBeNull();
    expect(container.querySelectorAll('.ant-splitter-bar').length).toBe(0);
  });

  it('detailOpen 为真但 detail 为 null 时同样退化为单栏（不留空栏）', () => {
    // 文件头承诺「detail 为 null 或 detailOpen=false 都退化为单栏」，两个条件都要判：
    // 只看 detailOpen 时，调用方在「详情未选中」传 null 会得到一条空右栏。
    const { container } = renderLayout({ detail: null });
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(container.querySelectorAll('.ant-splitter-bar').length).toBe(0);
    expect(screen.queryByTestId('resizable-pane-detail')).toBeNull();
  });

  it('detailOpen=true 时两栏都渲染，且有一个分隔条', () => {
    const { container } = render(
      <ListDetailLayout list={<span>列表内容</span>} detail={<span>详情内容</span>} detailOpen widthStorageKey="k" />,
    );
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(screen.getByText('详情内容')).toBeInTheDocument();
    expect(container.querySelectorAll('.ant-splitter-bar').length).toBe(1);
  });

  it('右栏宿主可滚动且带内边距（长内容不被裁掉）', () => {
    renderLayout();
    const host = screen.getByTestId('resizable-pane-detail');
    expect(host.style.overflow).toBe('auto');
    expect(host.style.padding).toBe('8px');
  });

  it('列表栏是弹性列（不给 size，吃剩余空间）', () => {
    const { container } = renderLayout();
    const listHost = screen.getByTestId('resizable-pane-list');
    expect(listHost).toBeInTheDocument();
    // 只断言宿主存在抓不住「给弹性列传了 size」——传了面板也照样在。真正的可观察面是
    // InternalPanel 把 hasSize 写成内联样式：不给 size ⇒ flexBasis:auto / flexGrow:1，
    // 给了 size ⇒ flexBasis:<n>px / flexGrow:0（被钉死，吃不到剩余空间）。
    const panels = Array.from(container.querySelectorAll<HTMLElement>('.ant-splitter-panel'));
    expect(panels).toHaveLength(2);
    expect(panels[0]?.style.flexGrow).toBe('1');
    expect(panels[0]?.style.flexBasis).toBe('auto');
    expect(panels[1]?.style.flexGrow).toBe('0');
    expect(panels[1]?.style.flexBasis).toBe('420px');
  });

  it('拖拽把右栏像素宽回写进 size 与偏好（不回写则松手弹回）', async () => {
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
    window.localStorage.removeItem('k2');
    try {
      const { container } = render(
        <ListDetailLayout list={<span>列表内容</span>} detail={<span>详情内容</span>} detailOpen widthStorageKey="k2" />,
      );
      const bar = container.querySelector('.ant-splitter-bar');
      expect(bar).not.toBeNull();
      // antd 把 role="separator" 放在分隔条的**命中区**（.ant-splitter-bar-dragger）上，
      // 外层 .ant-splitter-bar 只是定位容器、本身没有角色（SplitBar.js 第 187 / 204 行；
      // 浏览器冒烟实测 .ant-splitter-bar 的 role 为 null）。
      // 直接按 dragger 的选择器取元素来断言（不再从 bar 里再查一层）：antd 一旦改名，
      // 这条断言立刻在**正确的选择器**上失败，而不是悄悄断言到别的元素或整体被跳过。
      const dragger = container.querySelector<HTMLElement>('.ant-splitter-bar-dragger');
      expect(dragger).not.toBeNull();
      expect(dragger?.getAttribute('role')).toBe('separator');

      // jsdom 没有布局引擎，容器实测宽恒为 0 ⇒ antd 认为所有栏都是 0 像素宽、分隔条不可拖
      // （useResizable：`prevSize !== 0 || !prevMin`）。把容器宽推成非 0 才拖得动：
      // offsetWidth 桩给像素，再手动触发 antd 自己的容器观察器（它把回调放在微任务里，要等一拍）。
      const splitterEl = container.querySelector('.ant-splitter');
      const containerObserver = FakeResizeObserver.instances.find((observer) =>
        observer.observed.includes(splitterEl as Element),
      );
      await act(async () => {
        containerObserver?.callback(
          [{ target: splitterEl } as unknown as ResizeObserverEntry],
          containerObserver as unknown as ResizeObserver,
        );
        await Promise.resolve();
      });
      expect(dragger?.getAttribute('aria-disabled')).toBe('false');

      expect(detailPanel()?.style.flexBasis).toBe('420px');

      // 真拖一把：mousedown 起拖 → window 上的 mousemove → mouseup。
      // 容器 1000px、偏好 420px ⇒ 弹性列吃 580px；向左拖 300px ⇒ 右栏 420+300 = 720px。
      fireEvent.mouseDown(dragger as HTMLElement, { clientX: 0, clientY: 0 });
      fireEvent.mouseMove(window, { clientX: -300, clientY: 0 });
      fireEvent.mouseUp(window);

      // 受控模式下 onResize 只把内部尺寸改了，size 不跟着变面板就一动不动（松手弹回原宽）
      expect(detailPanel()?.style.flexBasis).toBe('720px');
      // 同时落进 localStorage：不回写偏好的话刷新后回到旧宽度
      expect(window.localStorage.getItem('k2')).toBe('720');
    } finally {
      widthSpy.mockRestore();
      window.localStorage.removeItem('k2');
    }
  });

  it('初始宽度取自偏好（首帧为 seed，不读 localStorage，避免水合不一致）', () => {
    window.localStorage.setItem('k3', '700');
    render(
      <ListDetailLayout list={<span>列表内容</span>} detail={<span>详情内容</span>} detailOpen widthStorageKey="k3" />,
    );
    // 用自己栏宿主的 testid 定位面板，不用 :nth-child——Splitter 的子节点是
    // [Panel, Bar, Panel]（bar 排在两栏之间），位置选择器会指到分隔条上。
    expect(detailPanel()).not.toBeNull();
    // 存量值只能靠「挂载后读 → 重渲染 → 新 width」送进来（useStoredWidth 的 useEffect）。
    // 面板改用 defaultSize 的话内部尺寸只在挂载时种一次，这里会停在首帧的 seed 420px。
    expect(detailPanel()?.style.flexBasis).toBe('700px');
    window.localStorage.clear();
  });

  it('容器比偏好窄时按比例还原右栏宽度（否则被 Splitter 硬夹到 min）', () => {
    // 同样要靠 offsetWidth 桩才能走到「已量到容器宽」的分支：300px 容器扣掉分隔条命中带 6px
    // ⇒ 预算 294px < 偏好 420px ⇒ 按比例收成 294 再被下限 320 托底。
    // 不做比例还原（直接用偏好值 420）会让右栏在窄窗口里挤掉列表栏，比例在窗口缩放时跳变。
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    try {
      renderLayout({ widthStorageKey: 'k5' });
      expect(detailPanel()?.style.flexBasis).toBe('320px');
    } finally {
      widthSpy.mockRestore();
    }
  });

  it('detailOpen 从 false 变 true 时右栏出现（受控切换）', () => {
    const { rerender } = render(
      <ListDetailLayout list={<span>列表内容</span>} detail={null} detailOpen={false} widthStorageKey="k4" />,
    );
    expect(screen.queryByText('详情内容')).not.toBeInTheDocument();
    rerender(
      <ListDetailLayout list={<span>列表内容</span>} detail={<span>详情内容</span>} detailOpen widthStorageKey="k4" />,
    );
    expect(screen.getByText('详情内容')).toBeInTheDocument();
  });
});
