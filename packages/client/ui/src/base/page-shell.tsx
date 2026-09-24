'use client';

/**
 * 页面根容器：全站「弹性布局 + 横向沾满」的唯一出口。
 * 四条不变量，每条都对应一个真实缺陷：
 *   1. 纵向 Flex 根 + width:100% + minWidth:0 + height:100%；
 *   2. **刻意不设 alignItems**——纵向 Flex 的交叉轴是水平方向，align-items:flex-start
 *      会让子元素不横向拉伸（「没有横向沾满」）并把父级顶宽（多余横向滚动条）；
 *   3. padding / gap 默认不落 style——原语默认值一旦非 0，页面迁移会凭空新增间距并可能制造溢出；
 *   4. **minHeight:0 无条件写在基础 style 里**（与 minWidth:0 并列）——纵向主轴默认 min-height:auto，
 *      内容（或子元素的自动最小尺寸）撑开容器时页面根就收缩不到 flex 分配的高度，
 *      整页被顶出「顶栏那一截」。实测：/demo 打开右栏 + 视口高 520 时页面溢出 **25px**
 *      （documentElement.scrollHeight 545 > clientHeight 520）、PageShell 高卡在 520（本应 495.33）；
 *      运行时把它压成 0 后溢出归零。原先只在 scroll="inner" 分支里给，是因为当时只想到
 *      「内部滚动」那一类；但高度链是**每个**模式共用的，故上移为基础不变量。
 *      scroll="inner" 仍额外要 overflow:auto（根自身滚动）——那一项留在分支里。
 *
 * 为什么结构性不变量**自己写进内联 style**，而不只靠 antd 的 Flex：antd 的 display /
 * flex-direction 走 CSS 类（`.ant-flex`、`.ant-flex-vertical`），内联 style 里读不到；
 * 不变量若只活在类名里，antd 换实现或改类名就会静默失效，本组件也不再是可靠真源。
 * 内联与类名同值时内联胜出，渲染结果不变。
 *
 * 为什么 minWidth / minHeight 写字面量 '0px' 而不是数字 0：React 对数值 0 **不加单位**
 * （源码里 `value !== 0` 才补 px，因为 0 与 0px 等价），内联 style 会落成 `min-width: 0`。
 * 两者计算值相同，但 '0px' 让「横向不收缩」「纵向不收缩」这两条不变量在内联口径下可断言。
 *
 * 副作用（如实记录）：这条内联 display:flex 也压过了 antd 的 `.ant-flex:empty { display: none }`，
 * 于是 <PageShell /> 不带 children 时会占满整屏，而不再像偏离前那样收缩为零——
 * 对页面根容器而言这更合理，但它确实是一处相对偏离前渲染的真实行为变化。
 */
import { ConfigProvider, Flex } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import { compactTheme } from './density';
import { useDensityMode } from './density-context';

/** 紧凑主题按明暗预生成一次：避免每次 render 重建 ThemeConfig（algorithm 数组引用亦保持稳定） */
const COMPACT_THEMES = {
  light: compactTheme('light'),
  dark: compactTheme('dark'),
} as const;

export interface PageShellProps {
  children: ReactNode;
  /** 密度：compact（默认，全站通用）| default（仅设置页豁免） */
  density?: 'compact' | 'default';
  /** 内边距；不传则不落 style */
  padding?: number | string;
  /** 纵向间距；不传则不落 style */
  gap?: number;
  /** page：由外层文档滚动（默认）| inner：根自身滚动（长列表页）| none：不接管 */
  scroll?: 'page' | 'inner' | 'none';
}

export function PageShell({ children, density = 'compact', padding, gap, scroll = 'page' }: PageShellProps): ReactNode {
  const mode = useDensityMode();
  // 只编码结构性不变量；间距仅在显式传入时落 style
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: '0px',
    // 无条件给：高度链不只在 scroll="inner" 下需要它（见文件头第 4 条不变量）
    minHeight: '0px',
    height: '100%',
  };
  if (padding !== undefined) style.padding = padding;
  if (gap !== undefined) style.gap = gap;
  if (scroll === 'inner') style.overflow = 'auto';
  const content = (
    <Flex vertical style={style}>
      {children}
    </Flex>
  );
  // 豁免页不包 ConfigProvider，直接落回外层主题
  if (density === 'default') return content;
  return <ConfigProvider theme={COMPACT_THEMES[mode]}>{content}</ConfigProvider>;
}
