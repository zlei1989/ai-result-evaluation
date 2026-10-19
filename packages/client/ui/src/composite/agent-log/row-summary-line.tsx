'use client';

/**
 * 行级汇总节点的说明行（`kind: 'row'`）：厂商只给汇总计数、没有逐个身份的那一档。
 *
 * 三条口径：
 *   · **一条说明行，不是卡片**，也**不可点**：点进去只会得到一个空会话，
 *     故它不进面包屑、不渲染任何按钮（本件里没有 `Button`）；
 *   · `counts === null` 时如实说「计数未采集」，**不显示空白、也不写 0**
 *     （0 是「一个子任务都没派」，与「没采到」是两件事）；
 *   · 状态与状态缺失原因**两句并列**，口径与 `subagent-bar` 一致。
 */
import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge';
import type { LogNodeStatus, RowNode } from './types';
import { LOG_NODE_STATUS_LABELS, MISSING_REASON_LABELS } from './types';

/**
 * 状态七档 → 徽标色档，与 `subagent-bar` 同一口径（两处都画 `LogNodeStatus`）。
 * 只映射三档，其余一律中性：`unknown` 涂成红或绿都是在替数据表态。
 */
function statusTone(status: LogNodeStatus): string {
  switch (status) {
    case 'running':
      return 'border-info/40 bg-info/10 text-info';
    case 'completed':
      return 'border-success/40 bg-success/10 text-success';
    case 'failed':
      return 'border-destructive/40 bg-destructive/10 text-destructive';
    default:
      return '';
  }
}

export function RowSummaryLine({ node }: { node: RowNode }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-hair">
      <Badge variant="outline">汇总</Badge>
      <Badge variant="outline" className={statusTone(node.status)}>
        {LOG_NODE_STATUS_LABELS[node.status]}
      </Badge>
      {node.statusMissing !== null && (
        <span className="text-sub text-muted-foreground">{`状态未采集 · ${MISSING_REASON_LABELS[node.statusMissing]}`}</span>
      )}
      {node.counts === null ? (
        <span className="text-sub text-muted-foreground">计数未采集</span>
      ) : (
        <span className="text-sub text-muted-foreground">
          {`子任务 ${node.counts.subagents} · 完成 ${node.counts.completed} · 失败 ${node.counts.failed}`}
        </span>
      )}
    </div>
  );
}
