'use client';

/**
 * `thinking` 块 → `Reasoning` 的结构：**一条 `TraceLine` + 受控展开的正文**。
 *
 * 四条口径：
 *   1. **没有正文就什么都不渲染**（`text === null` 或**只有空白** ⇒ 返回 `null`）：数据层如实记着
 *      「有思考、无文本」这条事实，但界面上它只能变成一句占位文案或一个**空面板**（标题 + 一片空白），
 *      而那不是用户要看的思考 ⇒ 整块隐藏。空白那一档不是假想：codex / pi 的思考增量帧不过滤空 delta
 *      ⇒ 「思考刚开始、正文还没到」那一拍就是一条 `text: ''`，用户口径是**等第一条有正文的思考流
 *      消息到了再画这一个面板**（`build-model` 已在模型层过滤掉两档，这里是第二道：
 *      组件被别处直接构造时同样不出空面板）；
 *   2. **`textKind` 不进呈现**：`summary` 档只有 codex 一家会落（`reasoning.summary[]` 通道），
 *      单一厂商的正文形态差异不升为界面标注——正文照常显示，不出「摘要」角标；
 *   3. **`open ?? running` 的三段不在这里**：组件只吃一个**受控** `open`，自己不持态（分层纪律 (d)）。
 *      「用户还没表态 ⇒ 跟 running」是 `useAgentLogView` 的默认展开键（`assembly === 'open'` 时入键），
 *      「点开过 / 点收过 ⇒ 听用户的」是它的 `openedKeys` / `closedKeys`——组件这一层
 *      既没有由 `running` 推出的开合，也没有第二份 state；
 *   4. **状态与动效都由 `assembly` 派生**（流式的唯一判据）：还在流 ⇒ 标题「思考中…」+
 *      `TraceLine status="running"`（标题 shimmer）+ 转圈图标；收成快照 ⇒ 标题「思考」、
 *      **不传 status**（属性都不存在）。状态写进标题文字，不靠图标与颜色单独表达（Trace 的 a11y 口径）。
 *
 * 正文**原样给出**（纯文本 + `whitespace-pre-wrap`）：思考不是 markdown，解析 `**` 只会得到
 * 一堆字面标记；本仓也不给它自己的排印（无等宽、无斜体、无左侧竖线）。
 */
import { BrainIcon, LoaderCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../components/ui/trace';
import type { ThinkingBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

export interface ThinkingBlockViewProps {
  block: ThinkingBlock;
  /** 正文是否展开（**受控**：开合态住在 `useAgentLogView`） */
  open: boolean;
  onOpenChange(next: boolean): void;
}

export function ThinkingBlockView({ block, open, onOpenChange }: ThinkingBlockViewProps): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  // 变量名刻意不叫「流式」什么：本目录不许出现自造的流式判据，`assembly` 是唯一判据
  const streaming = block.assembly === 'open';

  // 没有正文：整块不出现（不给占位、也不给空面板——空面板会被读成「思考了但什么也没想」，
  // 而「只有空白」与「没有正文」在界面上是同一件事）
  if (block.text === null || block.text.trim() === '') return null;

  return (
    <Trace data-testid="thinking-block">
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger>
          {/* 收起与展开同款状态：标题是收起态唯一的进行中信号 */}
          <TraceLine status={streaming ? 'running' : undefined}>
            <TraceIcon>
              {streaming ? (
                <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
              ) : (
                <BrainIcon />
              )}
            </TraceIcon>
            <TraceTitle>{streaming ? '思考中…' : '思考'}</TraceTitle>
            {sourceLabel !== null && <TraceDescription>{sourceLabel}</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {/* `text-foreground`：`TraceCollapsibleContent` 会把整段文字变 muted，而思考正文是正文 */}
          <div className="whitespace-pre-wrap text-foreground" data-testid="reasoning-body">
            {block.text}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
