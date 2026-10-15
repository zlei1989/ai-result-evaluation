'use client';

/**
 * `thinking` 块：折叠面板 + 标题上的「还在思考」信号。
 *
 * 三条口径：
 *   1. **没有正文就什么都不渲染**（`text === null` 或**只有空白** ⇒ 返回 `null`）：数据层如实记着
 *      「有思考、无文本」这条事实，但界面上它只能变成一句占位文案或一个**空面板**（标题 + 一片空白），
 *      而那不是用户要看的思考 ⇒ 整块隐藏。空白那一档不是假想：codex / pi 的思考增量帧不过滤空 delta
 *      ⇒ 「思考刚开始、正文还没到」那一拍就是一条 `text: ''`，用户口径是**等第一条有正文的思考流
 *      消息到了再画这一个面板**（`build-model` 已在模型层过滤掉两档，这里是第二道：
 *      组件被别处直接构造时同样不出空面板）；
 *   2. **`textKind` 不进呈现**：`summary` 档只有 codex 一家会落（`reasoning.summary[]` 通道），
 *      单一厂商的正文形态差异不升为界面标注——正文照常显示，不出「摘要」角标；
 *   3. **标题是状态文字 + 转圈图标**：`assembly === 'open'` ⇒ 「思考中…」+ `loading`
 *      （图标配文字，同一判据的两面），否则「思考」+ 默认图标——收起与展开同款
 *      （收起时标题是唯一的进行中信号，展开时它只是状态标签）。排版与动效交给 `Think`：
 *      不叠自己的字体层、不挂自造扫光；**没有来源角标时 title 就是纯字符串**，
 *      有角标才包一层 `Flex` 做并排布局。
 *
 * 正文**原样交给 `Think`**：本仓不再自带样式（此前是等宽 + 斜体 + 左侧竖线）——
 * 那一套是「我们觉得思考该长什么样」，而 `Think` 有自己的正文槽位与排版，两边叠着就是两层样式。
 */
import { Flex, Tag } from 'antd';
import type { ReactNode } from 'react';
import { XThink } from '../../base/x-think';
import type { ThinkingBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export interface ThinkingBlockViewProps {
  block: ThinkingBlock;
  open: boolean;
  onOpenChange(next: boolean): void;
}

export function ThinkingBlockView({ block, open, onOpenChange }: ThinkingBlockViewProps): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  // 变量名刻意不叫「流式」什么：本目录不许出现自造的流式判据，`assembly` 是唯一判据
  const openAssembly = block.assembly === 'open';

  // 没有正文：整块不出现（不给占位、也不给空面板——空面板会被读成「思考了但什么也没想」，
  // 而「只有空白」与「没有正文」在界面上是同一件事）
  if (block.text === null || block.text.trim() === '') return null;

  // 标题 = 状态文字；有来源角标才需要并排布局（多包一层 Flex），否则就是纯字符串，
  // 让 `Think` 的 status-text 槽位自己的排版生效
  const statusText = openAssembly ? '思考中…' : '思考';
  const label =
    sourceLabel === null ? (
      statusText
    ) : (
      <Flex gap={4} align="center">
        {statusText}
        <Tag>{sourceLabel}</Tag>
      </Flex>
    );

  return (
    <XThink title={label} loading={openAssembly} expanded={open} onExpand={onOpenChange}>
      {/* 正文原样交给 `Think`：本仓**不再自带样式**（此前是等宽 + 斜体 + 左侧竖线） */}
      {block.text}
    </XThink>
  );
}
