/**
 * RowSummaryLine：行级汇总节点（厂商只给计数、没有逐个身份的那一档）。
 *
 * 三条守卫：
 *   · 计数与状态都可见；
 *   · `counts === null` 时如实说「计数未采集」（**不写 0**——0 是「一个都没派」，与「没采到」是两件事）；
 *   · **不可点**：本件一个按钮都不渲染。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RowSummaryLine } from './row-summary-line';
import type { AgentLogFacts, RowNode } from './types';

const facts: AgentLogFacts = {
  status: { tone: 'ok', label: '已完成' },
  startedAt: '2026-10-02T08:00:00.000Z',
  endedAt: '2026-10-02T08:03:00.000Z',
  turns: { current: 3, total: 3 },
  tokens: null,
  thinking: null,
  domain: [],
  error: null,
  exitReason: null,
};

function rowNode(overrides: Partial<RowNode> = {}): RowNode {
  return {
    id: 'row-1',
    parentId: null,
    spawnedBy: null,
    status: 'completed',
    statusMissing: null,
    startedAt: null,
    endedAt: null,
    content: { status: 'ready', data: [] },
    contentTruncatedReason: null,
    capability: {},
    capabilityNotes: [],
    kind: 'row',
    counts: { subagents: 4, completed: 3, failed: 1 },
    facts,
    ...overrides,
  };
}

describe('RowSummaryLine', () => {
  it('计数与状态都可见', () => {
    render(<RowSummaryLine node={rowNode()} />);

    expect(screen.getByText('汇总')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('子任务 4 · 完成 3 · 失败 1')).toBeInTheDocument();
  });

  it('状态没采到时两句并列', () => {
    render(<RowSummaryLine node={rowNode({ status: 'unknown', statusMissing: 'not-exposed' })} />);

    expect(screen.getByText('状态未知')).toBeInTheDocument();
    expect(screen.getByText('状态未采集 · 厂商有数据、但没投送到我们能读的通道')).toBeInTheDocument();
  });

  it('计数没采到时如实说明，不写 0', () => {
    render(<RowSummaryLine node={rowNode({ counts: null })} />);

    expect(screen.getByText('计数未采集')).toBeInTheDocument();
  });

  it('不可点：不渲染任何按钮', () => {
    const { container } = render(<RowSummaryLine node={rowNode()} />);

    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
