'use client';

/**
 * 单行省略文本 + Tooltip 显全量。
 * 为什么需要：长路径与 40 位哈希在表格里必然溢出，直接截断会让人无从判断与复制；
 * Tooltip 显全量、配合省略，是唯一不破坏列宽又能看全的做法。
 *
 * 宽度两种给法，**不传才是列表里的常规选择**：
 *   · 不传 → `max-width: 100%`：吃满单元格，省略号正好落在单元格右边缘——能显示多少就显示多少，
 *     栏位被拖宽后长文本也跟着多显示（列表页的栏宽是用户拖出来的，写死 px 一定对不上）；
 *     百分比要有确定的分母，所以这条依赖列宽与内容无关：两张列表的 `Table` 都带 `sticky`，
 *     rc-table 据此把 `table-layout` 定成 `fixed`（`@rc-component/table` 的 `Table.js`：
 *     `isSticky || fixHeader || 有列 ellipsis` → `fixed`），列宽由表头算，不被内容顶开；
 *     `ProviderTable` 走的是另一条路（`scroll={{ x: 数值 }}` + 显式 `tableLayout="fixed"`），
 *     落到同一个 `fixed` 上，故这一格也是「不传才对」；
 *   · 传 px → 硬上限，给**列宽已知且比单元格窄**的地方用（生产调用方今天都不传它了，只剩用例在传）。
 *     曾被误用于列表页（`width={300}` 而列只有两百多像素）：文字块比单元格宽，超出的一段被
 *     单元格裁掉，省略号跟着被裁掉——症状是「显示不全，也看不到省略号」。
 */
import { Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface EllipsisTextProps {
  text: string;
  /** 固定宽度（px）；不传则吃满单元格 */
  width?: number;
  /** 等宽字体（哈希、路径这类用） */
  monospace?: boolean;
  /** 加粗（列表里的主字段，如供应商「名称」用） */
  strong?: boolean;
  /**
   * 提示里显示的**全量**文本；不传就是 `text`。
   * 给「显示的是截短形式」的列用：用例列表的「仓库」列显示的是末段（`displayRepoName`），
   * 而提示里该给全路径——两者不同形，靠默认的 `text` 会把末段再显示一遍，等于没有提示。
   */
  tooltip?: string;
}

export function EllipsisText({ text, width, monospace = false, strong = false, tooltip }: EllipsisTextProps): ReactNode {
  const content = (
    <Typography.Text
      style={{ display: 'inline-block', maxWidth: width ?? '100%', verticalAlign: 'bottom' }}
      code={monospace}
      strong={strong}
      ellipsis
    >
      {text}
    </Typography.Text>
  );
  // 文本为空时不挂 Tooltip（空 Tooltip 是个无意义的浮层）
  return text === '' ? content : <Tooltip title={tooltip ?? text}>{content}</Tooltip>;
}
