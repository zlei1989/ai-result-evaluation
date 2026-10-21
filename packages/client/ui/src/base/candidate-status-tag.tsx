'use client';

/**
 * 候选状态 → 彩色 Tag + 中文文案。
 * 分工：**文案**在 contracts 的 `CANDIDATE_STATUS_LABELS`（契约的一部分），**颜色**在这里（界面的事）。
 * 「10 个颜色两两不同」是刻意的（状态语义必须可区分）——两个状态同色时，
 * 使用者只能逐字读才能分清，扫一眼列表看不出差别。
 */
import { Tag } from 'antd';
import type { ReactNode } from 'react';
import { CANDIDATE_STATUS_LABELS, type EvalCandidateStatus } from '@aieval/contracts';

/** 状态 → Tag 配色（10 个值两两不同，见文件头；跑批色系与终态色系刻意分开） */
export const CANDIDATE_STATUS_COLORS: Record<EvalCandidateStatus, string> = {
  pending: 'default',
  preparing: 'cyan',
  running: 'processing',
  judging: 'geekblue',
  judged: 'success',
  failed: 'error',
  'timed-out': 'volcano',
  canceled: 'orange',
  skipped: 'gold',
  interrupted: 'magenta',
};

export interface CandidateStatusTagProps {
  status: EvalCandidateStatus;
}

export function CandidateStatusTag({ status }: CandidateStatusTagProps): ReactNode {
  return <Tag color={CANDIDATE_STATUS_COLORS[status]}>{CANDIDATE_STATUS_LABELS[status]}</Tag>;
}
