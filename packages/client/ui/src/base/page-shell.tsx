'use client';

/**
 * 页面根容器：全站「弹性布局 + 横向沾满 + 密度作用域」的唯一出口。
 * 五条不变量，每条都对应一个真实缺陷：
 *   1. 纵向 Flex 根 + `w-full` + `min-w-0` + **`flex-1`**：外壳是 `body` 的纵向 flex，
 *      顶栏 56px 是兄弟节点，页面壳只吃剩余高度。写成 `h-full` 会变成「顶栏 56 + 整视口」，
 *      每页多出 56px 溢出、顶栏被滚走、底栏掉到视口外；
 *   2. **刻意不设 alignItems**——纵向 Flex 的交叉轴是水平方向，`items-start` 会让子元素
 *      不横向拉伸（「没有横向沾满」）并把父级顶宽（多余横向滚动条）；
 *   3. padding / gap 默认不落类——原语默认值一旦非 0，页面迁移会凭空新增间距并可能制造溢出；
 *      显式传入时只落密度间距档（`p-page` / `gap-page`），值由 `[data-density]` 决定，
 *      不再逐像素写内联 style；
 *   4. **`min-h-0` 无条件写**（与 `min-w-0` 并列）——纵向主轴默认 `min-height:auto`，
 *      内容（或子元素的自动最小尺寸）撑开容器时页面根就收缩不到 flex 分配的高度，
 *      整页被顶出「顶栏那一截」。高度链是**每个**模式共用的，故它是基础不变量，
 *      而不是 `scroll="inner"` 分支的局部处置；
 *   5. **`data-density` 无条件写**——CSS 变量按最近祖先继承，属性不在，整页就落回 `:root`
 *      的紧凑档，设置页的豁免会静默失效。`compact` 与 `default` 两档在 `globals.css` 里
 *      都写全，因此嵌套壳的「最近一层赢」天然成立。
 *
 * `text-body` / `leading-body` 让继承链上的文字真的读到作用域变量；显式设了字号的组件
 * （显式写 `text-sub` / `text-xs` 的组件）不受影响。滚动条相关的 `overflow-auto` 仍只在 `inner` 分支。
 */
import { cn } from '../lib/utils';
import type { ReactNode } from 'react';

export interface PageShellProps {
  children: ReactNode;
  /** 密度：compact（默认，全站通用）| default（仅设置页豁免） */
  density?: 'compact' | 'default';
  /** 显式开启页内边距（落 `p-page`，实际值由密度档决定） */
  padding?: number | string;
  /** 显式开启纵向间距（落 `gap-page`，实际值由密度档决定） */
  gap?: number;
  /** page：由外层文档滚动（默认）| inner：根自身滚动（长列表页）| none：不接管 */
  scroll?: 'page' | 'inner' | 'none';
}

export function PageShell({ children, density = 'compact', padding, gap, scroll = 'page' }: PageShellProps): ReactNode {
  return (
    <div
      data-density={density}
      data-scroll={scroll === 'inner' ? 'inner' : undefined}
      className={cn(
        'flex w-full min-w-0 min-h-0 flex-1 flex-col text-body leading-body',
        padding !== undefined && 'p-page',
        gap !== undefined && 'gap-page',
        scroll === 'inner' && 'overflow-auto',
      )}
    >
      {children}
    </div>
  );
}
