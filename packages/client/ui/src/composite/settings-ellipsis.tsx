'use client';

/**
 * 单行省略文本（设置屏专用）：长名称、路径、地址在表格里必然溢出，直接截断会让人无从判断；
 * 这里用 `truncate` 收口，`title` 保留全量供悬停查看。
 *
 * 为什么不复用 `base/ellipsis-text.tsx`：那一份带固定宽度的两种给法与原生 `title`（别的屏在用），
 * 而设置屏的这几个落点只需要 `truncate` + `title`——本屏的表格与预览共用这一份实现。
 * `title` 而不是浮层：这几个落点的内容都是纯文本，原生 tooltip 在触屏与键盘上也有稳定行为。
 */
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';

export interface SettingsEllipsisProps {
  text: string;
  /** 固定宽度（px）；不传则吃满父容器 */
  width?: number;
  /** 等宽字体（路径、哈希这类用） */
  monospace?: boolean;
  /** 加粗（列表里的主字段，如供应商「名称」） */
  strong?: boolean;
  /** 次级色：给「这一行暂时不生效，但内容照旧要读」的格用 */
  muted?: boolean;
  /** 悬停提示里的全量文本；不传就是 `text` */
  tooltip?: string;
}

export function SettingsEllipsis({
  text,
  width,
  monospace = false,
  strong = false,
  muted = false,
  tooltip,
}: SettingsEllipsisProps): ReactNode {
  return (
    <span
      data-ellipsis
      className={cn(
        'inline-block max-w-full truncate align-bottom',
        monospace && 'font-mono',
        strong && 'font-medium',
        muted && 'text-muted-foreground',
      )}
      style={{ maxWidth: width ?? '100%', verticalAlign: 'bottom' }}
      title={text === '' ? undefined : (tooltip ?? text)}
    >
      {text}
    </span>
  );
}
