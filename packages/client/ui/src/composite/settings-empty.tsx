'use client';

/**
 * 表格空态：一句说清「还没有什么」的话 + 一组引导动作。
 *
 * 与 `base/empty-state.tsx` 的区别只在版式：那一份是整屏空态（带引导动作的固定布局），
 * 设置屏这一份只给「一句说明 + 一组动作」，用 `Empty` 与 `Button` 直接拼，表格空态不必再套一层。
 * 动作的形态只有两种：主按钮（默认）与虚线描边（创建 / 添加类，全站「新建」的视觉约定）。
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

export interface SettingsEmptyAction {
  label: string;
  onClick: () => void;
  /** 回调没接上时禁用并给出原因：摆一个点了没反应的按钮比明说「还没接上」更糟 */
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  /** `dashed` = 创建 / 添加类（与表格下方的添加按钮同形） */
  variant?: 'default' | 'dashed';
}

export interface SettingsEmptyProps {
  title: string;
  description?: string;
  actions?: SettingsEmptyAction[];
}

export function SettingsEmpty({ title, description, actions = [] }: SettingsEmptyProps): ReactNode {
  return (
    <Empty className="border-dashed py-8">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {actions.length > 0 && (
        <EmptyContent>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {actions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.variant === 'dashed' ? 'outline' : 'default'}
                className={action.variant === 'dashed' ? 'border-dashed' : undefined}
                disabled={action.disabled === true}
                title={action.title}
                onClick={action.onClick}
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        </EmptyContent>
      )}
    </Empty>
  );
}
