'use client';

/**
 * 页内操作条：左标题 + 右动作区。
 * 全站操作条的唯一样式来源——各页自己拼 Flex 会让标题字号与动作间距逐页漂移。
 */
import { Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface ToolbarProps {
  title: ReactNode;
  /** 右侧动作区 */
  extra?: ReactNode;
}

export function Toolbar({ title, extra }: ToolbarProps): ReactNode {
  return (
    <Flex align="center" justify="space-between" gap={8} style={{ paddingBlock: 8, flexShrink: 0 }}>
      <Typography.Text strong>{title}</Typography.Text>
      {extra !== undefined && <Flex align="center" gap={8}>{extra}</Flex>}
    </Flex>
  );
}
