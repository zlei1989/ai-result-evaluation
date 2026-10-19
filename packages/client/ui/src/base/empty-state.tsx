'use client';

/**
 * 空状态：占位说明 + 引导动作。
 * 为什么必须给引导动作而不只是「暂无数据」：空列表是新用户唯一会看到的界面，
 * 一句「还没有用例」加一个「创建用例」按钮，比任何文案都直接。
 *
 * 基座是新栈的 `Empty` 与 `Button`：空态是每屏都会出现的门面，
 * 它不该为了一个占位图把更重的原语拉回这一屏。
 */
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '../components/ui/empty';

/** 空态的一个引导动作：`action` 传单个或一组都用这个形状 */
export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** 回调没接上时**禁用并给出原因**：摆一个点了没反应的按钮，比明说「还没接上」的按钮更糟 */
  disabled?: boolean;
  /** 禁用原因（悬停可见）：写清「还没接上」，别写含糊的「不可用」 */
  title?: string;
  /**
   * 前导图标。纯装饰的图标要自己带 `aria-hidden`：图标若带无障碍名，
   * 按钮的可访问名会变成「图标名 + 文案」，屏读器多念一个词，按名字定位按钮也会失配。
   */
  icon?: ReactNode;
  /**
   * 按钮形态；创建 / 添加类动作传 `'dashed'`，与工具栏上的新增按钮同形。
   * `dashed` 的视觉是「描边 + 虚线边框」：`outline` 变体给描边，虚线边框由本组件补，
   * 两半缺一都会静默退回实线——故要在用例里按类名钉住。
   */
  variant?: 'default' | 'dashed';
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  /**
   * 引导动作；不传则只渲染说明（不是所有空态都有可执行动作）。
   * **多个动作传数组**：按顺序横排，第一个是主按钮（MCP 卡片的空态就摆「添加第一台 + 粘贴 JSON」两个）。
   */
  action?: EmptyStateAction | EmptyStateAction[];
}

export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  // 单个与一组动作归一成同一条渲染路径：调用方不必关心自己给的是哪一种
  const actions = action === undefined ? [] : Array.isArray(action) ? action : [action];
  return (
    // `flex-none` 把 vendored `Empty` 自带的 `flex-1` 压回去：空态不是页面主体，
    // 拉满整栏再垂直居中会在列表与详情之间凭空造出一大片空白。
    <Empty className="flex-none border-dashed py-10">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {actions.length > 0 && (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {actions.map((item) => (
              <Button
                key={item.label}
                // 创建 / 添加类动作与工具栏的新增按钮同形：描边 + 虚线
                variant={item.variant === 'dashed' ? 'outline' : 'default'}
                className={item.variant === 'dashed' ? 'border-dashed' : undefined}
                size="sm"
                disabled={item.disabled === true}
                title={item.title}
                onClick={item.onClick}
              >
                {item.icon}
                {item.label}
              </Button>
            ))}
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}
