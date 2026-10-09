'use client';

/**
 * `thinking` 块：折叠面板 + 标题上的「还在思考」信号。
 *
 * 三条口径：
 *   1. **没有正文就什么都不渲染**（`text === null` ⇒ 返回 `null`）：数据层如实记着「有思考、无文本」
 *      这条事实，但界面上它只能变成一句占位文案，**而不是用户要看的思考** ⇒ 整块隐藏
 *      （`build-model` 已在模型层过滤掉这一档，这里是第二道：组件被别处直接构造时同样不出占位）；
 *   2. **`textKind === 'summary'` 要标「摘要」**：codex 那一格可能是厂商摘要，
 *      不标注就是假称全文；`'none'` 不需要另标——它已经不显示了；
 *   3. **扫光只给折叠态标题**（`assembly === 'open'` 且收起）：展开时正文在流，
 *      静态文本上再挂动画只会把「还在流」这个信号稀释成噪声。
 *      判据只有 `block.assembly` 一格（模型里没有第二个流式布尔）。
 *
 * 展开后的正文是等宽 + 斜体 + 左侧竖线，字体走 `MonoText`（`token.fontFamilyCode`），
 * 竖线与缩进取 token（不写像素、更不写字号）。
 */
import { Collapse, Flex, Tag, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import { ACTIVITY_SWEEP_CLASS } from '../../base/agent-activity-line';
import { MonoText } from '../../base/mono-text';
import type { ThinkingBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export interface ThinkingBlockViewProps {
  block: ThinkingBlock;
  open: boolean;
  onOpenChange(next: boolean): void;
}

const PANEL_KEY = 'thinking';

export function ThinkingBlockView({ block, open, onOpenChange }: ThinkingBlockViewProps): ReactNode {
  const { token } = theme.useToken();
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  // 变量名刻意不叫「流式」什么：本目录不许出现自造的流式判据，`assembly` 是唯一判据
  const openAssembly = block.assembly === 'open';

  // 无正文：整块不出现（不给占位、也不给空面板——空面板会被读成「思考了但什么也没想」）
  if (block.text === null) return null;

  const label = (
    // 扫光挂在**标题容器**上：折叠态下看不到正文，标题不表态就没有任何地方能表态了
    <Flex align="center" gap={4} className={openAssembly && !open ? ACTIVITY_SWEEP_CLASS : undefined}>
      <Typography.Text>思考</Typography.Text>
      {block.textKind === 'summary' && <Tag>摘要</Tag>}
      {sourceLabel !== null && <Tag>{sourceLabel}</Tag>}
      {openAssembly && !open && <Typography.Text type="secondary">思考中…</Typography.Text>}
    </Flex>
  );

  return (
    <Collapse
      ghost
      destroyOnHidden
      activeKey={open ? [PANEL_KEY] : []}
      onChange={(keys) => onOpenChange(keys.length > 0)}
      items={[
        {
          key: PANEL_KEY,
          label,
          children: (
            <ThinkingBody
              block={block}
              border={token.colorBorder}
              indent={token.paddingSM}
              lineWidth={token.lineWidth}
            />
          ),
        },
      ]}
    />
  );
}

/**
 * 展开后的正文：原文（等宽、斜体、左侧竖线）。
 * 单独一个函数是为了让 `block.text === null` 的窄化留在同一处——
 * 直接在组件里写三元会让「已经判过 null」这件事在下游变成一次断言。
 */
function ThinkingBody({
  block,
  border,
  indent,
  lineWidth,
}: {
  block: ThinkingBlock;
  border: string;
  indent: number;
  lineWidth: number;
}): ReactNode {
  // 第二道兜底：无正文不出正文面板（组件顶部已经整块挡掉，这里只负责类型窄化后的安全出口）
  if (block.text === null) return null;
  return (
    <Typography.Paragraph italic style={{ borderInlineStart: `${lineWidth}px solid ${border}`, paddingInlineStart: indent }}>
      <MonoText text={block.text} />
    </Typography.Paragraph>
  );
}
