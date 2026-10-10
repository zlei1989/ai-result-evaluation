'use client';

/**
 * 空状态：占位说明 + 引导动作。
 * 为什么必须给引导动作而不只是「暂无数据」：空列表是新用户唯一会看到的界面，
 * 一句「还没有用例」加一个「创建用例」按钮，比任何文案都直接。
 */
import { Button, Empty, Flex, Typography } from 'antd';
import type { ButtonProps } from 'antd';
import type { ReactNode } from 'react';

/** 空态的一个引导动作：`action` 传单个或一组都用这个形状 */
export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  /** 回调没接上时**禁用并给出原因**：摆一个点了没反应的按钮，比明说「还没接上」的按钮更糟 */
  disabled?: boolean;
  /** 禁用原因（悬停可见）：写清「还没接上」，别写含糊的「不可用」 */
  title?: string;
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
    <Flex vertical align="center" justify="center" gap={8} style={{ padding: 32 }}>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null} />
      <Typography.Text strong>{title}</Typography.Text>
      {description !== undefined && <Typography.Text type="secondary">{description}</Typography.Text>}
      {actions.length > 0 && (
        <Flex gap={8} wrap justify="center">
          {actions.map((item) => (
            <Button
              key={item.label}
              // 两态互斥地给：不给 variant 就是默认的主按钮实心样式；给了 variant 就必须连 `color` 一起给
              // （理由见 EmptyStateAction.variant 的 JSDoc：antd 6 里 `variant` 单给会被静默降级成实线 outlined）
              type={item.variant === undefined ? 'primary' : undefined}
              color={item.variant === undefined ? undefined : 'default'}
              variant={item.variant}
              icon={item.icon}
              size="small"
              disabled={item.disabled === true}
              title={item.title}
              onClick={item.onClick}
            >
              {item.label}
            </Button>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
