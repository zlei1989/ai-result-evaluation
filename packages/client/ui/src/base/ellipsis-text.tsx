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
 *     ⚠️ 给列表页传 px 会踩坑（`width={300}` 而列只有两百多像素）：文字块比单元格宽，超出的一段被
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
   * 次级色（antd 的 `type="secondary"`）：给「这一行整条不生效，但内容照旧要读」的格用——
   * MCP 表里停用条目的**名称**那一格就是这样：弱化信号落在名称上，端点与命令保持可读
   * （为什么不是整行加灰，见 `mcp-server-table.tsx` 文件头第 2 点）。颜色走 antd 的语义类，
   * 不写死色值，`light` / `dark` 两态由主题自己管。
   */
  muted?: boolean;
  /**
   * 提示里显示的**全量**文本；不传就是 `text`。
   * 给「显示的是截短形式」的列用：用例列表的「仓库」列显示的是末段（`displayRepoName`），
   * 而提示里该给全路径——两者不同形，靠默认的 `text` 会把末段再显示一遍，等于没有提示。
   */
  tooltip?: string;
}

export function EllipsisText({
  text,
  width,
  monospace = false,
  strong = false,
  muted = false,
  tooltip,
}: EllipsisTextProps): ReactNode {
  const content = (
    <Typography.Text
      style={{ display: 'inline-block', maxWidth: width ?? '100%', verticalAlign: 'bottom' }}
      code={monospace}
      strong={strong}
      type={muted ? 'secondary' : undefined}
      ellipsis
    >
      {text}
    </Typography.Text>
  );
  // 文本为空时不挂 Tooltip（空 Tooltip 是个无意义的浮层）
  return text === '' ? content : <Tooltip title={tooltip ?? text}>{content}</Tooltip>;
}
