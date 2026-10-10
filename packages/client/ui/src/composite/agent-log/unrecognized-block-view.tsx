'use client';

/**
 * `unrecognized` 块：**我们不认识的厂商载荷**。默认折叠（内容不认识的原始载荷不该占地方），
 * 展开后给出原文。
 *
 * 三条口径：
 *   · 正文**只能是 `raw`**：`vendorType` 是「这是什么」的线索，把它当正文等于用一句标签冒充内容； * · 正文走 `JsonText`：载荷是 JSON（厂商事件基本都是）就缩进格式化 + 高亮，
 *     不是就**逐字原样**——两类都仍以 `raw` 为唯一来源；
 *   · `raw === null` 时说「原样载荷未采集」，不留一个空面板（空面板会被读成「载荷是空的」）；
 *   · **默认收起由调用方给**（`open` 受控）——本件自己不持开合态。
 */
import { Collapse, Flex, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { JsonText } from '../../base/json-text';
import type { UnrecognizedPayloadBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export interface UnrecognizedBlockViewProps {
  block: UnrecognizedPayloadBlock;
  open: boolean;
  onOpenChange(next: boolean): void;
}

const PANEL_KEY = 'unrecognized';

export function UnrecognizedBlockView({ block, open, onOpenChange }: UnrecognizedBlockViewProps): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  const label = (
    <Flex align="center" gap={4}>
      <Typography.Text>未识别的厂商载荷</Typography.Text>
      {block.vendorType !== null && block.vendorType !== '' && <Tag>{block.vendorType}</Tag>}
      {sourceLabel !== null && <Tag>{sourceLabel}</Tag>}
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
          children:
            block.raw === null ? (
              <Typography.Text type="secondary">原样载荷未采集</Typography.Text>
            ) : (
              <JsonText text={block.raw} />
            ),
        },
      ]}
    />
  );
}
