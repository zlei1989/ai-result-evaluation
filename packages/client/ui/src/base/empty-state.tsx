'use client';

/**
 * 空状态：占位说明 + 引导动作。
 * 为什么必须给引导动作而不只是「暂无数据」：空列表是新用户唯一会看到的界面，
 * 一句「还没有用例」加一个「创建用例」按钮，比任何文案都直接。
 */
import { Button, Empty, Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** 引导动作；不传则只渲染说明（不是所有空态都有可执行动作） */
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  return (
    <Flex vertical align="center" justify="center" gap={8} style={{ padding: 32 }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null} />
      <Typography.Text strong>{title}</Typography.Text>
      {description !== undefined && <Typography.Text type="secondary">{description}</Typography.Text>}
      {action !== undefined && (
        <Button type="primary" size="small" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </Flex>
  );
}
