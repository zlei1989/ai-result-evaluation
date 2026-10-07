'use client';

/**
 * 能力声明：把「这家不支持 / 厂商没投送 / 我们没接 / 没验证过」显示成**四句不同的话**。
 *
 * 三条口径：
 *   · **维度名由数据层给，本件不硬编码**：契约允许数据层加维度，故按 `capability` 的**插入顺序**
 *     渲染、未知维度**原样显示**（`CAPABILITY_DIMENSION_LABELS[dim] ?? dim`）——留白等于把新维度藏了；
 *   · **`level === 'yes'` 不显示原因**（那一格的 `reason` 按契约就是 `null`），
 *     但它**也不能留空**：`CAPABILITY_LEVEL_LABELS` 里只有四句「为什么没有」，没有「有」这一档；
 *   · 四句原因的文案**直接取 `CAPABILITY_LEVEL_LABELS`**，一个字都不在这里重写——
 *     把「这家没有」说成「我们没接」正是本仓最忌讳的那类误读。
 */
import { Flex, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { MessageCapabilityMap } from './types';
import { CAPABILITY_DIMENSION_LABELS, CAPABILITY_LEVEL_LABELS } from './types';

export interface CapabilityNotesProps {
  /** 能力声明（维度名由数据层给，**不硬编码**） */
  capability: MessageCapabilityMap;
  /** 能力成立的前提（路由 / 模型 / 开关）；空数组 = 无条件成立 */
  notes: readonly string[];
  /** 只显示这些维度（不给就全显示）；工具结果那一格是 `toolResult` */
  only?: readonly string[];
}

export function CapabilityNotes({ capability, notes, only }: CapabilityNotesProps): ReactNode {
  const entries = Object.entries(capability).filter(
    ([dimension]) => only === undefined || only.includes(dimension),
  );

  return (
    <Flex vertical gap={4} data-testid="capability-notes">
      {entries.map(([dimension, declaration]) => (
        <Flex key={dimension} align="center" gap={4} wrap>
          <Tag>{CAPABILITY_DIMENSION_LABELS[dimension] ?? dimension}</Tag>
          {declaration.level === 'yes' ? (
            // `yes` 没有「原因」可给（`reason` 按契约是 null），但不能留空：这一格是「有」
            <Typography.Text>支持</Typography.Text>
          ) : (
            <Typography.Text type="secondary">{CAPABILITY_LEVEL_LABELS[declaration.level]}</Typography.Text>
          )}
        </Flex>
      ))}
      {notes.length > 0 && (
        <Typography.Text type="secondary">{`能力随路由/模型变化：${notes.join('、')}`}</Typography.Text>
      )}
    </Flex>
  );
}
