'use client';

/**
 * 多栏可调宽度布局：每条分隔条调整其**左邻**那一栏的宽度。
 * 真正干活的全在 antd Splitter 里（拖拽、夹紧、键盘、aria 语义），本模块只做三件事：
 *   1. 把 ResizablePane 映射成 Splitter.Panel 的 props；
 *   2. 提供「分栏区 = Layout(Content(Splitter))」这层结构，让各栏拿到**确定高度**；
 *   3. 每栏一个宿主节点，承接调用方的内边距与滚动。
 *
 * **双击复位不是 antd 提供的能力**（原注释把「双击」也列在 Splitter 里，对 6.6.5 不成立）：
 * antd 6.6.5 的 Splitter 没有内置双击复位，`es/splitter/SplitBar.js:203` 只把双击事件转给可选的
 * `onDraggerDoubleClick` prop，而本模块与 ListDetailLayout 都没有传它 ⇒ 双击分隔条**什么也不会发生**
 * （浏览器冒烟实测：双击前后右栏 380px / localStorage "380" 完全不变）。需要复位时由调用方自己传
 * `onDraggerDoubleClick`（本模块目前不透出这个 prop）。
 *
 * 尺寸口径（读 antd splitter/hooks/{useSizes,useResize}.js 得出，三条反直觉但必须遵守）：
 *   ① 只要有任一个 Panel 带 size，整体走 propSizes 分支，没给 size 的栏由 autoPtgSizes 补剩余
 *      ⇒ **弹性列必须「不给 size」**才是吃剩余的那一栏（给它传期望值会让它钉死，另一栏被压成 0）。
 *      实现方式是条件展开，而不是传 size={0}；
 *   ② size 是**响应式受控入口**——propSizes 一变即重算并重渲染，所以**不需要**用「改 key 强制
 *      重挂载」那种做法（那还会顺带重置列表滚动位置）。反之 defaultSize 只在挂载时读一次，
 *      想还原宽度必须给 size；
 *   ③ **受控模式下拖拽不会自己动，必须把 onResize 回写进 size**：拖拽时 onOffsetUpdate 只调
 *      setInnerSizes，而存在 size 时就完全忽略 innerSizes。调用方不回写的表现是「拖得动但松手弹回」。
 *
 * Layout.Content 是「吃满父级剩余高度」的关键：它的 flex:auto + min-height:0 就是该语义的现成实现；
 * 有了确定高度，栏内那些 flex:1 才有可解析的参照（否则会退化成 auto，内容栏被内容撑到数千像素）。
 * 外层 minWidth:0 必须留着：它是横向 Flex 的 flex item，默认 min-width:auto 会被内部内容撑宽。
 */
import { Layout, Splitter } from 'antd';
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';

/**
 * Splitter 的分隔条**命中带**宽度（px）：用于把可用宽换算成「扣除分隔条后的预算」。
 * 注意它不是布局宽度：antd 横向布局里分隔条本身是 `width: 0`（见 splitter/style 的 `&-horizontal > bar`），
 * 只有绝对定位的 dragger 有 6px（默认 `splitTriggerSize`）宽的命中区，**不占**横向空间。
 * 所以这条扣减是**有意保守的宽减**——宁可还原出的宽度略小于容器，也不让最后一栏溢出。
 */
export const HANDLE_HIT_WIDTH = 6;

/** 供布局计算使用的最小面板几何：只关心「当前宽 + 夹紧范围 + 是否弹性列」 */
export interface PaneGeometry {
  width: number;
  min: number;
  max: number;
  /** 弹性列标记（至多一栏为 true）：吃富余空间 */
  flexible?: boolean;
}

export interface ResizablePane extends PaneGeometry {
  /** React key 与无障碍名称 */
  key: string;
  /** 栏的无障碍名称：渲染成栏宿主的 `aria-label`（下方宿主节点是唯一消费点） */
  label: string;
  content: ReactNode;
  /** 该栏宿主的样式（与默认样式合并，同键覆盖） */
  style?: CSSProperties;
}

export interface ResizableColumnsProps {
  panes: ResizablePane[];
  /**
   * 拖动过程中各栏的**像素**宽度（下标与 panes 对齐，每次位移都触发）。
   * **调用方必须把结果回写进传给 size 的那个状态**，否则受控模式下拖拽会弹回（见文件头口径③）。
   */
  onWidthsChange: (widths: number[]) => void;
  /** 容器实测宽度上报（首帧 + 每次尺寸变化） */
  onAvailableChange?: (available: number) => void;
  /**
   * 指定栏的实测像素宽度上报（首帧 + 每次变化，含拖动过程中）。
   * 为什么需要：Splitter 的拖动只改它内部的尺寸状态、不会让调用方重渲染，
   * 故调用方无法从自己的 props 推出「这一栏现在多宽」，而响应式隐列这类行为必须跟着实测值走。
   */
  onPaneWidthChange?: (key: string, width: number) => void;
}

/**
 * 按容器实测宽度**比例还原**非弹性列的像素宽度：够宽时原样返回；不够宽时按比例收（不低于 min）。
 * 弹性列不参与：它的宽度由 Splitter 的 autoPtgSizes 补剩余，期望值无意义。
 * 返回数组与入参同长同序（弹性列位置原样回填），便于调用方按下标取用。
 */
export function restoreWidthsToAvailable(
  widths: number[],
  panes: PaneGeometry[],
  available: number,
  handleCount: number,
): number[] {
  const budget = available - handleCount * HANDLE_HIT_WIDTH;
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (available <= 0 || total <= 0) return widths;
  // 够宽：原样（富余留给没给 size 的弹性列）
  if (total <= budget) return widths;
  // 过窄：按比例收，再逐栏夹到 [min, max]；夹紧后仍可能超预算，故取夹紧结果
  // （宁可略超，也不把任何一栏压到 min 以下——Splitter 自己还会再夹一次，这里让比例先稳定）
  const scale = budget / total;
  return panes.map((pane, i) => {
    const width = widths[i] ?? 0;
    // 弹性列原样回填：它不参与按比例收（期望值无意义，宽度由 Splitter 的 autoPtgSizes 补剩余）。
    // 少了这一条，宽度为 0 的弹性列会被下面的 Math.max(pane.min, …) 抬到 min，
    // 与函数头「弹性列位置原样回填」的口径不符（缩窄路径上实测返回 80 而非 0）。
    if (pane.flexible === true) return width;
    return Math.min(pane.max, Math.max(pane.min, width * scale));
  });
}

export function ResizableColumns({
  panes,
  onWidthsChange,
  onAvailableChange,
  onPaneWidthChange,
}: ResizableColumnsProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // 回调放 ref：避免因为父级每次渲染新建函数而反复重建 ResizeObserver
  const availableCbRef = useRef(onAvailableChange);
  availableCbRef.current = onAvailableChange;
  const paneWidthCbRef = useRef(onPaneWidthChange);
  paneWidthCbRef.current = onPaneWidthChange;

  // 栏数参与依赖：调用方切换栏（如右栏开/关）后必须重新收集并观察新宿主，
  // 否则新宿主不被观察、onPaneWidthChange 从此静默失效
  const paneCount = panes.length;

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (node === null) return;

    // 每次 effect 重新收集栏宿主：栏增减后旧的引用已失效
    const collectPanes = (): HTMLDivElement[] =>
      Array.from(node.querySelectorAll<HTMLDivElement>('[data-pane-key]'));

    const report = (): void => availableCbRef.current?.(node.offsetWidth);
    report();
    if (typeof ResizeObserver === 'undefined') {
      // 无 ResizeObserver 的环境（老浏览器 / 测试）也要把初值报一次，否则调用方拿不到任何宽度
      for (const el of collectPanes()) {
        if (el.dataset.paneKey !== undefined) paneWidthCbRef.current?.(el.dataset.paneKey, el.offsetWidth);
      }
      return;
    }

    const containerObserver = new ResizeObserver(report);
    containerObserver.observe(node);
    // 栏宿主也一并观察：拖动时 Splitter 只改自己的内部状态，
    // 这个观察器是「拖动过程中实时把栏宽报给调用方」的唯一来源
    const panesObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLDivElement;
        const key = el.dataset.paneKey;
        if (key !== undefined) paneWidthCbRef.current?.(key, el.offsetWidth);
      }
    });
    const paneNodes = collectPanes();
    for (const el of paneNodes) panesObserver.observe(el);
    // 首帧也报一次（观察器只报变化、不报初值）
    for (const el of paneNodes) {
      if (el.dataset.paneKey !== undefined) paneWidthCbRef.current?.(el.dataset.paneKey, el.offsetWidth);
    }

    return () => {
      containerObserver.disconnect();
      panesObserver.disconnect();
    };
  }, [paneCount]);

  if (paneCount === 0) return null;
  return (
    <Layout style={{ flex: 1, minWidth: 0, minHeight: 0, background: 'transparent' }} ref={hostRef}>
      <Layout.Content style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Splitter onResize={onWidthsChange} style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          {panes.map((pane) => (
            <Splitter.Panel
              key={pane.key}
              // 弹性列：只给 min，**不给 size** ⇒ 由 Splitter 补剩余空间（见文件头口径①）
              // 非弹性列：给 size（像素）⇒ 落库的偏好才能在刷新后真正还原（见口径②）
              {...(pane.flexible === true
                ? { min: pane.min }
                : { size: pane.width, min: pane.min, max: pane.max })}
            >
              {/* 栏宿主：唯一的一层节点。默认「撑满 + 纵向 flex + 裁剪」——
                  高度与滚动都靠这一层约束住，内容再长也不会把栏撑开；
                  调用方的 style 覆盖在其上（display/overflow 会被换掉，故调用方要自己保证仍能撑满）。
                  data-pane-key 是上方 effect 收集栏宿主的唯一钩子，改名要同步改收集逻辑。 */}
              <div
                data-pane-key={pane.key}
                data-testid={`resizable-pane-${pane.key}`}
                // label 的唯一消费点：栏宿主的无障碍名称（读屏/测试都靠它标识「这是哪一栏」）。
                // 必须同时给 role：裸 div 是 role=generic，而 ARIA 规范**禁止** generic 角色带名字，
                // 只写 aria-label 读屏取不到——role="group" 才让这个名字真正生效。
                role="group"
                aria-label={pane.label}
                style={{
                  height: '100%',
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  ...pane.style,
                }}
              >
                {pane.content}
              </div>
            </Splitter.Panel>
          ))}
        </Splitter>
      </Layout.Content>
    </Layout>
  );
}
