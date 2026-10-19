'use client';

/**
 * 行状态 → 彩色徽标 + 中文文案。
 * 分工：**文案**在 contracts 的 `ROW_STATUS_LABELS`（契约的一部分），**颜色**在这里（界面的事）。
 * 「10 个颜色两两不同」是刻意的（状态语义必须可区分）——两个状态同色时，
 * 使用者只能逐字读才能分清，扫一眼列表看不出差别。
 *
 * 颜色用 Tailwind 的调色板类而不是内联色值：`light` / `dark` 两态各有一条类，
 * 主题切换只换 `html[data-theme]`，这里不必跟着改（写死 `#xxx` 的话暗色下会糊成一片）。
 */
import type { ReactNode } from 'react';
import { ROW_STATUS_LABELS, type EvalRowStatus } from '@aieval/contracts';
import { Badge } from '../components/ui/badge';

/** 状态 → 徽标配色（10 个值两两不同，见文件头；跑批色系与终态色系刻意分开） */
export const ROW_STATUS_COLORS: Record<EvalRowStatus, string> = {
  pending: 'border-border text-muted-foreground',
  preparing: 'border-cyan-500/40 text-cyan-600 dark:text-cyan-400',
  running: 'border-info/40 text-info',
  judging: 'border-indigo-500/40 text-indigo-600 dark:text-indigo-400',
  judged: 'border-success/40 text-success',
  failed: 'border-destructive/40 text-destructive',
  'timed-out': 'border-orange-500/40 text-orange-600 dark:text-orange-400',
  canceled: 'border-warning/40 text-warning',
  skipped: 'border-yellow-500/40 text-yellow-600 dark:text-yellow-400',
  interrupted: 'border-fuchsia-500/40 text-fuchsia-600 dark:text-fuchsia-400',
};

export interface RowStatusTagProps {
  status: EvalRowStatus;
}

export function RowStatusTag({ status }: RowStatusTagProps): ReactNode {
  return (
    <Badge variant="outline" className={ROW_STATUS_COLORS[status]}>
      {ROW_STATUS_LABELS[status]}
    </Badge>
  );
}
