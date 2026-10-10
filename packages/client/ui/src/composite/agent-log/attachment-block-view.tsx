'use client';

/**
 * `attachment` 块：**认识的**真实附件（图片 / 文件），与 `unrecognized`（不认识的载荷兜底）走两条路
 * ——合成一条的代价是「一张图片被画成 base64」或「一段原始载荷被画成附件」。
 *
 * 两条边界：
 *   · **本期不加载缩略图**：加载远程资源会牵出鉴权、体积、CSP 三件事，不属于数据结构这一轮。
 *     故这里**不出现 `<img>`**（结构上留位、渲染上先占位）；
 *   · `path === null`（内联附件）显示「内联内容，无路径」——**不显示空白，也不编造路径**。
 *
 * 不折叠：它是「这一轮带了这个文件」的事实，与正文同级（表格）。
 */
import { Flex, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { MonoText } from '../../base/mono-text';
import type { AttachmentBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export function AttachmentBlockView({ block }: { block: AttachmentBlock }): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  return (
    <Flex vertical gap={4}>
      <Flex align="center" gap={4}>
        <Tag>{block.attachmentKind === 'image' ? '图片' : '文件'}</Tag>
        {sourceLabel !== null && <Tag>{sourceLabel}</Tag>}
      </Flex>
      {block.path === null ? (
        <Typography.Text type="secondary">内联内容，无路径</Typography.Text>
      ) : (
        <MonoText text={block.path} />
      )}
      {block.mimeType !== null && <Typography.Text type="secondary">{block.mimeType}</Typography.Text>}
    </Flex>
  );
}
