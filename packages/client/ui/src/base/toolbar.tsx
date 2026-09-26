'use client';

/**
 * 页内操作条：左标题 + 右动作区。
 * 全站操作条的唯一样式来源——各页自己拼 Flex 会让标题字号与动作间距逐页漂移。
 */
import { Flex, Typography } from 'antd';
import type { ReactNode } from 'react';

export interface ToolbarProps {
  /** 左标题；不给则只剩右侧动作区（列表页的页面名已由顶栏导航表达，标题重复） */
  title?: ReactNode;
  /** 右侧动作区 */
  extra?: ReactNode;
}

export function Toolbar({ title, extra }: ToolbarProps): ReactNode {
  return (
    <Flex
      align="center"
      // 无标题时必须 flex-end：`space-between` 只有一个子元素时会把它推到**左**端，
      // 动作区会从右侧跳到原标题的位置（布局静默变形，没有报错）
      justify={title === undefined ? 'flex-end' : 'space-between'}
      gap={8}
      style={{ paddingBlock: 8, flexShrink: 0 }}
    >
      {title !== undefined && <Typography.Text strong>{title}</Typography.Text>}
      {extra !== undefined && <Flex align="center" gap={8}>{extra}</Flex>}
    </Flex>
  );
}
