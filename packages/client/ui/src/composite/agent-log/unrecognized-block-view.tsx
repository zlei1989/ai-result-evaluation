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
import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { JsonText } from '../../base/json-text';
import type { UnrecognizedPayloadBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export interface UnrecognizedBlockViewProps {
  block: UnrecognizedPayloadBlock;
  open: boolean;
  onOpenChange(next: boolean): void;
}

export function UnrecognizedBlockView({ block, open, onOpenChange }: UnrecognizedBlockViewProps): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];

  return (
    // 嵌在日志里的一块内容：给描边与卡片底色，与其它日志块同形。
    // 受控 `open` + 收起即卸载（Base UI 的 Panel 默认不保留 DOM）：内容不认识的原始载荷不该占地方
    <Collapsible
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      className="rounded-lg border border-border bg-card px-2 py-1.5"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-left text-sm">
        <span>未识别的厂商载荷</span>
        {block.vendorType !== null && block.vendorType !== '' && (
          <Badge variant="outline">{block.vendorType}</Badge>
        )}
        {sourceLabel !== null && <Badge variant="outline">{sourceLabel}</Badge>}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        {block.raw === null ? (
          <span className="text-muted-foreground">原样载荷未采集</span>
        ) : (
          <JsonText text={block.raw} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
