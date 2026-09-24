/**
 * ResizableColumns：尺寸口径与比例还原。
 * 三个防回归点：
 *   1. 弹性列**不给 size**（给了会被钉死，另一栏被压成 0）；
 *   2. 非弹性列**给 size**（用 defaultSize 刷新会回到旧值）；
 *   3. onResize 必须把像素宽度回传给调用方——受控模式下不回写，拖拽会松手弹回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResizableColumns, restoreWidthsToAvailable, type PaneGeometry, type ResizablePane } from './resizable-columns';
import { FakeResizeObserver, installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 ResizeObserver，而 antd 的 Splitter 内部（@rc-component/resize-observer）
// 直接读全局构造器、没有 polyfill：不打桩，挂载即抛 ReferenceError（见 src/testing/resize-observer.ts）。
beforeEach(() => {
  installResizeObserverStub();
  FakeResizeObserver.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('restoreWidthsToAvailable', () => {
  const panes: PaneGeometry[] = [
    { width: 0, min: 80, max: Number.MAX_SAFE_INTEGER, flexible: true },
    { width: 420, min: 320, max: 900 },
  ];

  it('够宽时原样返回（富余留给弹性列）', () => {
    expect(restoreWidthsToAvailable([0, 420], panes, 1400, 1)).toEqual([0, 420]);
  });

  it('过窄时按比例收，且不低于 min', () => {
    const result = restoreWidthsToAvailable([0, 900], panes, 700, 1);
    expect(result[1]).toBeGreaterThanOrEqual(320);
    expect(result[1]).toBeLessThan(900);
  });

  it('比例稳定：同样输入重复调用结果一致（纯函数无副作用）', () => {
    const a = restoreWidthsToAvailable([0, 900], panes, 700, 1);
    const b = restoreWidthsToAvailable([0, 900], panes, 700, 1);
    expect(a).toEqual(b);
  });

  it('不超过 max', () => {
    const wide: PaneGeometry[] = [{ width: 0, min: 80, max: 99999, flexible: true }, { width: 5000, min: 320, max: 900 }];
    const result = restoreWidthsToAvailable([0, 5000], wide, 800, 1);
    expect(result[1]).toBeLessThanOrEqual(900);
    // 上面那条的输入算出来是 794，本来就没碰到 max，压不住「去掉 Math.min(pane.max, …)」这个变异体。
    // 这条让收缩结果**真的越过** max：预算 2000-6=1994，按比例收得 1994，必须被夹回 900。
    expect(restoreWidthsToAvailable([0, 5000], wide, 2000, 1)[1]).toBe(900);
  });

  it('available 为 0 或负数时原样返回（不产生 NaN / 负宽度）', () => {
    expect(restoreWidthsToAvailable([0, 420], panes, 0, 1)).toEqual([0, 420]);
    expect(restoreWidthsToAvailable([0, 420], panes, -100, 1)).toEqual([0, 420]);
  });

  it('宽度全为 0 时原样返回（避免除零）', () => {
    expect(restoreWidthsToAvailable([0, 0], panes, 500, 1)).toEqual([0, 0]);
    // 上面那条其实是被「够宽就原样返回」挡住的（0 ≤ 494），删掉 total<=0 这条守卫它也通过。
    // 只有预算**为负**时才会走到 total 做除数的那一步（scale = -3/0 = -Infinity ⇒ 第二栏 NaN）。
    expect(restoreWidthsToAvailable([0, 0], panes, 3, 1)).toEqual([0, 0]);
  });

  it('收缩路径上弹性列仍原样回填（不参与按比例收，不被抬到 min）', () => {
    // 与上一条的区别：这一条的输入**真的会收缩**（预算 700-6=694 < 900），
    // 才会暴露「弹性列的 0 被 Math.max(pane.min, …) 抬到 80」这个偏离口径的行为。
    const result = restoreWidthsToAvailable([0, 900], panes, 700, 1);
    expect(result[0]).toBe(0);
  });

  it('弹性列位置原样回填（返回数组与入参同长同序）', () => {
    const result = restoreWidthsToAvailable([0, 500], panes, 600, 1);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(0);
  });

  it('扣除分隔条命中带后再算预算', () => {
    // 预算 = 700 - 1*6 = 694，小于 900，故必须收缩；收缩结果恰好等于 694（900 * 694/900 在双精度下就是 694）。
    // 这 6px 是 dragger 的**命中带**（绝对定位，不占布局宽），扣掉它属有意保守，见 HANDLE_HIT_WIDTH 的注释。
    // 断言必须是**精确**的 694：写成 `694 + 1` 会让 HANDLE_HIT_WIDTH = 5（预算 695 ⇒ 结果 695）这个
    // 差一变异体活下来。
    const result = restoreWidthsToAvailable([0, 900], panes, 700, 1);
    expect(result[1]).toBe(694);
  });

  it('夹紧后的结果不低于 min（宁可略超预算也不把栏压没）', () => {
    const tiny: PaneGeometry[] = [{ width: 0, min: 80, max: 99999, flexible: true }, { width: 400, min: 320, max: 900 }];
    const result = restoreWidthsToAvailable([0, 400], tiny, 100, 1);
    expect(result[1]).toBe(320);
  });
});

describe('ResizableColumns', () => {
  function makePanes(): ResizablePane[] {
    return [
      { key: 'list', label: '列表', content: <span>列表内容</span>, width: 0, min: 80, max: Number.MAX_SAFE_INTEGER, flexible: true },
      { key: 'detail', label: '详情', content: <span>详情内容</span>, width: 420, min: 320, max: 900, style: { overflow: 'auto', padding: 8 } },
    ];
  }

  it('渲染所有栏与宿主节点', () => {
    render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    expect(screen.getByText('列表内容')).toBeInTheDocument();
    expect(screen.getByText('详情内容')).toBeInTheDocument();
    expect(screen.getByTestId('resizable-pane-list')).toBeInTheDocument();
    expect(screen.getByTestId('resizable-pane-detail')).toBeInTheDocument();
  });

  it('调用方传入的 style 覆盖宿主默认（详情栏自己滚动）', () => {
    render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    const detailHost = screen.getByTestId('resizable-pane-detail');
    expect(detailHost.style.overflow).toBe('auto');
    expect(detailHost.style.padding).toBe('8px');
  });

  it('空 panes 时渲染 null（不炸）', () => {
    const { container } = render(<ResizableColumns panes={[]} onWidthsChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('两栏必有一个分隔条（可拖拽的前提）', () => {
    const { container } = render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    expect(container.querySelectorAll('.ant-splitter-bar').length).toBe(1);
  });

  it('分隔条的无障碍角色在 .ant-splitter-bar-dragger 上（外层 bar 只是定位容器）', () => {
    // 浏览器冒烟实测：role="separator" 在 antd 的**命中区** dragger 上，而 .ant-splitter-bar 的 role 是
    // null（SplitBar.js 第 187 / 204 行：bar 是定位容器，dragger 才是可聚焦的命中区）。
    // 断言直接指向 dragger 这个选择器——antd 一旦把它改名或把角色挪走，这条会在**正确的选择器**上失败，
    // 而不是让「分隔条可被无障碍访问」这件事失去守卫。
    const { container } = render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    const dragger = container.querySelector<HTMLElement>('.ant-splitter-bar-dragger');
    expect(dragger).not.toBeNull();
    expect(dragger?.getAttribute('role')).toBe('separator');
  });

  it('栏增减后新宿主仍被观察（重新收集的验收：三栏时两个分隔条、宿主齐全）', () => {
    const twoPanes = makePanes();
    const { rerender, container } = render(<ResizableColumns panes={twoPanes} onWidthsChange={() => {}} />);
    const threePanes: ResizablePane[] = [
      ...twoPanes,
      { key: 'extra', label: '附加', content: <span>附加内容</span>, width: 300, min: 200, max: 600 },
    ];
    rerender(<ResizableColumns panes={threePanes} onWidthsChange={() => {}} />);
    expect(screen.getByTestId('resizable-pane-extra')).toBeInTheDocument();
    expect(container.querySelectorAll('.ant-splitter-bar').length).toBe(2);
    // 只断言 DOM 看不出「重新收集」：把 effect 依赖从 [paneCount] 改成 [] 后，上面两条照样通过，
    // 而新宿主从此不被观察、onPaneWidthChange 静默失效。这条断言观察器**真的观察到了新宿主**。
    const observedKeys = FakeResizeObserver.instances
      .flatMap((observer) => observer.observed.map((el) => el.getAttribute('data-pane-key')))
      .filter((key) => key !== null);
    expect(observedKeys).toContain('extra');
  });

  it('弹性列**不给 size**、非弹性列给 size（Panel 的内联 flex 是这两条口径的 DOM 证据）', () => {
    // antd 的 InternalPanel 把 hasSize 直接写成内联样式：有 size → flexBasis=size / flexGrow=0；
    // 无 size → flexBasis='auto' / flexGrow=1。这正是「弹性列必须不给 size」的唯一可观察面：
    // 一旦给它传 size（哪怕 size={0}），它就被钉死、吃不到剩余空间。
    const { container } = render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    const panels = Array.from(container.querySelectorAll<HTMLElement>('.ant-splitter-panel'));
    expect(panels).toHaveLength(2);
    expect(panels[0]?.style.flexGrow).toBe('1'); // 弹性列：吃剩余空间
    expect(panels[0]?.style.flexBasis).toBe('auto');
    expect(panels[1]?.style.flexGrow).toBe('0'); // 非弹性列：钉在 size 上
    expect(panels[1]?.style.flexBasis).toBe('420px');
  });

  it('非弹性列的 size 跟随 props 变化（口径②：defaultSize 只在挂载时读一次）', () => {
    // 为什么这条是必需而不是锦上添花：useStoredWidth 是**挂载之后**才读 localStorage 的，
    // 还原宽度只能靠「父级重渲染 + 新 width」送进来。给 defaultSize 的话 innerSizes 只在挂载时
    // 种一次，面板会永远停在挂载那一刻的种子值（存量宽度再也还原不了）。
    // 可观察的原理：任一栏带 size ⇒ useSizes 走 propSizes 分支，而 jsdom 里容器宽测不到
    // ⇒ panelSizes 回落成 sizes ⇒ size 的变化直接落成 flexBasis。
    const twoPanes = makePanes();
    const { rerender } = render(<ResizableColumns panes={twoPanes} onWidthsChange={() => {}} />);
    const detailPanel = (): HTMLElement | null =>
      screen.getByTestId('resizable-pane-detail').closest<HTMLElement>('.ant-splitter-panel');
    expect(detailPanel()?.style.flexBasis).toBe('420px');
    rerender(
      <ResizableColumns
        panes={twoPanes.map((pane) => (pane.key === 'detail' ? { ...pane, width: 500 } : pane))}
        onWidthsChange={() => {}}
      />,
    );
    expect(detailPanel()?.style.flexBasis).toBe('500px');
  });

  it('分栏区的 DOM 嵌套是 Layout > Layout.Content > Splitter（栏高确定的唯一来源）', () => {
    // 为什么只能断言结构：jsdom 没有布局引擎，读不到计算高度，断言不了「栏有确定高度」。
    // 能钉住的是**给出确定高度的那层嵌套**——Layout.Content 的 flex:auto + min-height:0
    // 就是「吃满父级剩余高度」的现成实现（见 resizable-columns.tsx 文件头）。去掉这层，
    // 栏内 flex:1 会退化成 auto、被长内容撑到数千像素，而下面所有用例的 DOM 断言照样通过。
    const { container } = render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    expect(container.querySelector('.ant-layout > main.ant-layout-content > .ant-splitter')).not.toBeNull();
  });

  it('无 ResizeObserver 的环境也要上报各栏初值（兜底分支可达）', () => {
    // 先渲染一次让 antd 内部（@rc-component/resize-observer 的模块级单例）把观察器建好，
    // 之后撤掉全局构造器才不会让 Splitter 自己先抛 ReferenceError——否则这条兜底分支根本走不到。
    render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />).unmount();
    vi.stubGlobal('ResizeObserver', undefined);
    const onPaneWidthChange = vi.fn();
    render(
      <ResizableColumns panes={makePanes()} onWidthsChange={() => {}} onPaneWidthChange={onPaneWidthChange} />,
    );
    // 没有观察器时唯一的上报来源就是这个兜底循环：删掉它，调用方一条宽度都拿不到
    expect(onPaneWidthChange.mock.calls.map(([key]) => key)).toEqual(['list', 'detail']);
  });

  it('观察各栏宿主，并在卸载时断开（否则是观察器泄漏）', () => {
    const { unmount } = render(<ResizableColumns panes={makePanes()} onWidthsChange={() => {}} />);
    // 本组件自己建的两个观察器：容器一个、栏宿主一个（antd 的单例在文件首个用例里已建好，不会新增）
    const hostObserver = FakeResizeObserver.instances.find((o) => o.observed.some((el) => el.classList.contains('ant-layout')));
    const paneObserver = FakeResizeObserver.instances.find((o) => o.observed.some((el) => el.hasAttribute('data-pane-key')));
    expect(hostObserver).toBeDefined();
    expect(paneObserver?.observed.map((el) => el.getAttribute('data-pane-key'))).toEqual(['list', 'detail']);
    unmount();
    expect(hostObserver?.disconnectCount).toBe(1);
    expect(paneObserver?.disconnectCount).toBe(1);
  });
});
