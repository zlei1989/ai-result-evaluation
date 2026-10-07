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
import { Flex, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { LogNodeStatus, RowNode } from './types';
import { LOG_NODE_STATUS_LABELS, MISSING_REASON_LABELS } from './types';

/**
 * 状态七档 → `Tag` 色档，与 `subagent-bar` 同一口径（两处都画 `LogNodeStatus`）。
 * 只映射三档，其余一律中性：`unknown` 涂成红或绿都是在替数据表态。
 */
function statusColor(status: LogNodeStatus): 'processing' | 'success' | 'error' | 'default' {
  switch (status) {
    case 'running':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    default:
      return 'default';
  }
}

export function RowSummaryLine({ node }: { node: RowNode }): ReactNode {
  return (
    <Flex align="center" gap={4} wrap>
      <Tag>汇总</Tag>
      <Tag color={statusColor(node.status)}>{LOG_NODE_STATUS_LABELS[node.status]}</Tag>
      {node.statusMissing !== null && (
        <Typography.Text type="secondary">{`状态未采集 · ${MISSING_REASON_LABELS[node.statusMissing]}`}</Typography.Text>
      )}
      {node.counts === null ? (
        <Typography.Text type="secondary">计数未采集</Typography.Text>
      ) : (
        <Typography.Text type="secondary">
          {`子任务 ${node.counts.subagents} · 完成 ${node.counts.completed} · 失败 ${node.counts.failed}`}
        </Typography.Text>
      )}
    </Flex>
  );
}
