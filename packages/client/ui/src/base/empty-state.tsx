'use client';

/**
 * 空状态：占位说明 + 引导动作。
 * 为什么必须给引导动作而不只是「暂无数据」：空列表是新用户唯一会看到的界面，
 * 一句「还没有用例」加一个「创建用例」按钮，比任何文案都直接。
 */
import { Button, Empty, Flex, Typography } from 'antd';
import type { ButtonProps } from 'antd';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** 引导动作；不传则只渲染说明（不是所有空态都有可执行动作） */
  action?: {
    label: string;
    onClick: () => void;
    /**
     * 前导图标；创建 / 添加类动作传 `<PlusOutlined aria-hidden />`。
     * `aria-hidden` 不是可选项：`@ant-design/icons` 给每个图标挂了 `role="img" aria-label="plus"`，
     * 不藏起来按钮的可访问名会变成「plus 创建用例」——屏读器多念一个词，
     * 按名字定位按钮的用例与真实用户的可访问名都会跟着漂（口径同 workspace-settings-card 对 loading 图标的处理）。
     */
    icon?: ReactNode;
    /**
     * 按钮形态；创建 / 添加类动作传 `'dashed'`，与工具栏上的新增按钮同形。
     * 只暴露 `variant`，`color` 由本组件按 antd 的配对规则配：**antd 6 的 `variant` 单独给不生效**
     * ——`Button.js` 只在 `color` 与 `variant` **同时存在**时才用它们（`if (color && variant)`），
     * 否则回落到 `type` 的语法糖、再回落到 `['default', 'outlined']`：`variant="dashed"` 会**静默**
     * 渲染成实线。故这里两态各给一份：不传 variant = 主按钮（`type="primary"`），
     * 传了 = `color="default"` + 该 variant（`dashed` 即虚线）。
     */
    variant?: ButtonProps['variant'];
  };
}

export function EmptyState({ title, description, action }: EmptyStateProps): ReactNode {
  return (
    <Flex vertical align="center" justify="center" gap={8} style={{ padding: 32 }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null} />
      <Typography.Text strong>{title}</Typography.Text>
      {description !== undefined && <Typography.Text type="secondary">{description}</Typography.Text>}
      {action !== undefined && (
        <Button
          // 两态互斥地给：不给 variant 就是原来的主按钮；给了 variant 就必须连 `color` 一起给
          // （理由见 action.variant 的 JSDoc：antd 6 里 `variant` 单给会被静默降级成实线 outlined）
          type={action.variant === undefined ? 'primary' : undefined}
          color={action.variant === undefined ? undefined : 'default'}
          variant={action.variant}
          icon={action.icon}
          size="small"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </Flex>
  );
}
