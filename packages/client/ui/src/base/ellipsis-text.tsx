'use client';

/**
 * 单行省略文本 + Tooltip 显全量。
 * 为什么需要：长路径与 40 位哈希在表格里必然溢出，直接截断会让人无从判断与复制；
 * Tooltip 显全量、配合固定的省略宽度，是唯一不破坏列宽又能看全的做法。
 */
import { Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface EllipsisTextProps {
  text: string;
  /** 固定宽度（px）；不传则由父容器决定（单元格里通常需要传） */
  width?: number;
  /** 等宽字体（哈希、路径这类用） */
  monospace?: boolean;
}

export function EllipsisText({ text, width, monospace = false }: EllipsisTextProps): ReactNode {
  const content = (
    <Typography.Text
      style={{ display: 'inline-block', maxWidth: width ?? '100%', verticalAlign: 'bottom' }}
      code={monospace}
      ellipsis
    >
      {text}
    </Typography.Text>
  );
  // 文本为空时不挂 Tooltip（空 Tooltip 是个无意义的浮层）
  return text === '' ? content : <Tooltip title={text}>{content}</Tooltip>;
}
