'use client';

/**
 * 页内操作条：左标题 + 右动作区。
 * 全站操作条的唯一样式来源——各页自己拼 flex 会让标题字号与动作间距逐页漂移。
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export interface ToolbarProps {
  /** 左标题；不给则只剩右侧动作区（列表页的页面名已由顶栏导航表达，标题重复） */
  title?: ReactNode;
  /** 右侧动作区 */
  extra?: ReactNode;
}

export function Toolbar({ title, extra }: ToolbarProps): ReactNode {
  return (
    <div
      // 无标题时必须 justify-end：`justify-between` 只有一个子元素时会把它推到**左**端，
      // 动作区会从右侧跳到原标题的位置（布局静默变形，没有报错）
      className={cn(
        'flex shrink-0 items-center gap-2 py-2',
        title === undefined ? 'justify-end' : 'justify-between',
      )}
    >
      {title !== undefined && <span className="font-medium">{title}</span>}
      {extra !== undefined && <div className="flex items-center gap-2">{extra}</div>}
    </div>
  );
}
