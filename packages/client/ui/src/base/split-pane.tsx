'use client';

/**
 * 两栏布局（侧栏 + 主区）：antd `Splitter` 的薄适配。
 * 分隔条的指针捕获、键盘可达、最小/最大夹紧、拖动态光标与 role=separator 语义全由 Splitter 提供，
 * 不自绘。本项目右栏一律用 sidePosition="end"。
 *
 * **双击复位不在其列**（原注释与设计稿 §6.5 都把「双击复位」算作 Splitter 的能力，对 antd 6.6.5 不成立）：
 * antd 6.6.5 的 Splitter 没有内置双击复位，`es/splitter/SplitBar.js:203` 只把双击转给可选的
 * `onDraggerDoubleClick` prop，本组件没有透出它 ⇒ 双击分隔条无任何反应。需要时由调用方自行实现。
 *
 * 已记录的边界：本适配**不支持纵向堆叠**——Splitter 没有等价开关，故改为
 * 「始终保持左右并排 + 夹紧最小宽」。collapseBelow 只作侧栏最小宽使用。
 *
 * 两个已踩过的坑：
 *   1. styles.dragger 会整个替换 antd 的 dragger 样式，传 width 会把命中带改成 0
 *      （实测三条分隔条宽度全为 0、看不见也拖不到）——两栏间距交给 antd 自带尺寸，不覆盖；
 *   2. 两栏宿主用原生 div 是有意偏离「避免裸写 div」——antd 没有「可滚动的通用盒子」原语，
 *      用 <Flex> 包单个孩子只是徒增节点。
 *
 * 两个宿主 div 的 `minWidth/minHeight` 写字面量 `'0px'` 而不是数字 0：React 对数值 0 **不加单位**
 * （源码里 `value !== 0` 才补 px），内联 style 会落成 `min-width: 0`。两者计算值相同，
 * 但 `'0px'` 让「不收缩」这条不变量在内联口径下可断言（与 page-shell.tsx 同一口径）。
 * 两套写法**并存是有意的**：写 `'0px'` 的只有「测试会断言其内联值」的这两处宿主，其余（本文件
 * Splitter 根节点的 `minWidth/minHeight`、`resizable-columns.tsx` 里的全部 0）保持数值 0，不做全仓统一。
 *
 * 本原语不支持「用户拖过的宽度在刷新后还原」（Splitter 的 defaultSize 只在挂载时读一次）；
 * 需要还原宽度时用 ResizableColumns。
 */
import { Splitter } from 'antd';
import type { ReactNode } from 'react';

export interface SplitPaneProps {
  side: ReactNode;
  children: ReactNode;
  /** 侧栏宽度（px），默认 300 */
  sideWidth?: number;
  /** 侧栏位置，默认 'start' */
  sidePosition?: 'start' | 'end';
  /** 只作侧栏最小宽使用 */
  collapseBelow?: number;
  /** 两栏间距（px）：原样落成 Splitter 根节点的 CSS `gap`（flex 间距，纯视觉），**不**是分隔条命中带宽度 */
  gap?: number;
}

export function SplitPane({
  side,
  children,
  sideWidth = 300,
  sidePosition = 'start',
  collapseBelow,
  gap = 8,
}: SplitPaneProps): ReactNode {
  const min = collapseBelow ?? sideWidth;
  const sidePanel = (
    <Splitter.Panel key="side" defaultSize={sideWidth} min={min}>
      {/* 侧栏宿主：固定宽度由 Panel 给，内部滚动由调用点的内容自带 */}
      <div data-testid="split-side-host" style={{ height: '100%', minWidth: '0px', minHeight: '0px', overflow: 'auto' }}>
        {side}
      </div>
    </Splitter.Panel>
  );
  const mainPanel = (
    <Splitter.Panel key="main">
      <div data-testid="split-main-host" style={{ height: '100%', minWidth: '0px', minHeight: '0px', overflow: 'auto' }}>
        {children}
      </div>
    </Splitter.Panel>
  );
  return (
    <Splitter style={{ flex: 1, minWidth: 0, minHeight: 0, gap }}>
      {sidePosition === 'start' ? [sidePanel, mainPanel] : [mainPanel, sidePanel]}
    </Splitter>
  );
}
