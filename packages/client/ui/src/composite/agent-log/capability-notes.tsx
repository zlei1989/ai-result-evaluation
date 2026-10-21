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
 *
 * 版式两块都是 `Descriptions`，本件不用 `Typography` / `Collapse`：
 *   · 维度格是多列网格（桌面三列、五格两行；手机窄抽屉才落一列），不是默认一行一格；
 *   · 能力成立的前提是另一张表——每句一整行、标题由 `Descriptions` 的 `title` 给。
 *     前提**不能**塞进维度那张表：`span="filled"` 只吃掉**当前行剩下的列**，五格按三列排时
 *     第二行只占两格，前提会被塞进那一候选的空格里并压成窄条。长句也没有「值」可拆，
 *     与短格并排只会被折成多行，故单独成表、整行读。
 */
import { Descriptions, Flex, Tag, theme } from 'antd';
import type { DescriptionsProps } from 'antd';
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

/** 前提那一段的标题：前提随路由 / 模型 / 开关变化，不是恒定事实 */
const NOTES_TITLE = '能力前提（随路由 / 模型 / 开关变化）';

/**
 * 维度格的列数。抽屉宽度是 `min(60vw, 900px)`（随视口走），三列是这一档宽度下的平衡点：
 * 70px 的标签 + 短值（`支持` / 四句原因）一行放得下五格中的三格，五格刚好两行；
 * 再宽一列就要把「厂商有数据、但没投送到我们能读的通道」压成三行以上，总高度反而更高。
 * 窄屏（< lg）退到两列；只有手机那一档（< sm）落到一列——两列时抽屉已窄到 300px 以下，
 * 标签会先被压成竖排，保住列数反而连维度名都读不出来。
 */
const CAPABILITY_COLUMNS = { xs: 1, sm: 2, md: 2, lg: 3 } as const;

export function CapabilityNotes({ capability, notes, only }: CapabilityNotesProps): ReactNode {
  const { token } = theme.useToken();
  const entries = Object.entries(capability).filter(
    ([dimension]) => only === undefined || only.includes(dimension),
  );

  const dimensionItems: NonNullable<DescriptionsProps['items']> = entries.map(
    ([dimension, declaration]) => ({
      key: dimension,
      label: CAPABILITY_DIMENSION_LABELS[dimension] ?? dimension,
      children:
        declaration.level === 'yes' ? (
          // `yes` 没有「原因」可给（`reason` 按契约是 null），但不能留空：这一格是「有」
          <Tag color="green">支持</Tag>
        ) : (
          CAPABILITY_LEVEL_LABELS[declaration.level]
        ),
    }),
  );

  return (
    <Flex vertical gap={token.marginSM} data-testid="capability-notes">
      <Descriptions size="small" column={CAPABILITY_COLUMNS} items={dimensionItems} />
      {notes.length > 0 && (
        <Descriptions
          size="small"
          // 整句读：这里的一列是**内容宽度**约束（长句折成窄条只会更长），不是维度格那种竖排
          column={1}
          title={NOTES_TITLE}
          items={notes.map((note, index) => ({
            // 同一句话可以出现两次（不同前提各说一遍），故键里带序号
            key: `note-${index}`,
            children: note,
          }))}
        />
      )}
    </Flex>
  );
}
