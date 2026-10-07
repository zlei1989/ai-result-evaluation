'use client';

/**
 * `thinking` 块：折叠面板 + 标题上的「还在思考」信号。
 *
 * 三条口径：
 *   1. **`text === null` 时显示缺失原因，不显示空面板**——空面板会被读成「思考了但什么也没想」，
 *      与「这家拿不到思考文本」是两件事。连原因都没有（`textMissing === null`）时也必须说话；
 *   2. **`textKind === 'summary'` 要标「摘要」**：codex 事件流那一格按厂商定义只有推理摘要，
 *      不标注就是假称全文；`'none'` 不需要另标，第 1 条已经把话说完了；
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
import { MESSAGE_SOURCE_LABELS, MISSING_REASON_LABELS } from './types';

export interface ThinkingBlockViewProps {
  block: ThinkingBlock;
  open: boolean;
  onOpenChange(next: boolean): void;
}

const PANEL_KEY = 'thinking';

/**
 * 拿不到思考文本时说清是哪一种「没有」。
 * `textMissing === null` 是契约允许的组合（`text` 为 null 时它「必填」，但类型上仍可空），
 * 这时给一句最保守的话，**不留空**。
 */
function missingText(block: ThinkingBlock): string {
  return block.textMissing === null ? '思考文本未采集' : MISSING_REASON_LABELS[block.textMissing];
}

export function ThinkingBlockView({ block, open, onOpenChange }: ThinkingBlockViewProps): ReactNode {
  const { token } = theme.useToken();
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  // 变量名刻意不叫「流式」什么：本目录不许出现自造的流式判据，`assembly` 是唯一判据
  const openAssembly = block.assembly === 'open';

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
 * 展开后的正文：缺失原因（灰字）或原文（等宽、斜体、左侧竖线）。
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
  if (block.text === null) {
    return <Typography.Text type="secondary">{missingText(block)}</Typography.Text>;
  }
  return (
    <Typography.Paragraph italic style={{ borderInlineStart: `${lineWidth}px solid ${border}`, paddingInlineStart: indent }}>
      <MonoText text={block.text} />
    </Typography.Paragraph>
  );
}
