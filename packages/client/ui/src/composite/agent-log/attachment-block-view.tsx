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
import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { MonoText } from '../../base/mono-text';
import type { AttachmentBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export function AttachmentBlockView({ block }: { block: AttachmentBlock }): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <Badge variant="outline">{block.attachmentKind === 'image' ? '图片' : '文件'}</Badge>
        {sourceLabel !== null && <Badge variant="outline">{sourceLabel}</Badge>}
      </div>
      {block.path === null ? (
        <span className="text-muted-foreground">内联内容，无路径</span>
      ) : (
        <MonoText text={block.path} />
      )}
      {block.mimeType !== null && <span className="text-muted-foreground">{block.mimeType}</span>}
    </div>
  );
}
