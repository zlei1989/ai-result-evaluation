/**
 * AgentRunStateTag：**§4.2「`running` 不可由 `output` 推断」的分派处**（工具行 / 工具组 / 计划清单三处共用；
 * 问答卡片自持一支，不走本件）。
 *
 * 核心断言（变异体 (f) 的落点）：`running === false && !hasResult` 必须是
 * **静态灰字 + 没有 `processing` 徽标**——一个转圈的「结果未采集」会被读成「还在跑」，
 * 读的人会一直等一个不会来的结果。
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunStateTag } from './agent-run-state-tag';

const START = '2026-10-02T00:00:00.000Z';
const NOW = '2026-10-02T00:02:03.000Z';

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentRunStateTag', () => {
  it('running：转圈 + 已运行时长按分:秒走', () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    try {
      render(<AgentRunStateTag running hasResult={false} missingReason={null} since={START} />);

      expect(document.querySelector('.ant-badge-status-processing')).not.toBeNull();
      expect(screen.getByText('进行中 · 2m03s')).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.getByText('进行中 · 3m03s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('running 为 false 且结果没到：静态灰字，且没有 processing 徽标', () => {
    const { container } = render(
      <AgentRunStateTag running={false} hasResult={false} missingReason={null} since={START} />,
    );

    expect(screen.getByText('结果未采集')).toBeInTheDocument();
    // 这一条是核心：静态的「没采到」绝不能带一个转圈的徽标
    expect(container.querySelector('.ant-badge-status-processing')).toBeNull();
  });

  it('结果未到时把能力声明给的原因缀上', () => {
    render(
      <AgentRunStateTag
        running={false}
        hasResult={false}
        missingReason="厂商有数据、但没投送到我们能读的通道"
      />,
    );

    expect(screen.getByText('结果未采集 · 厂商有数据、但没投送到我们能读的通道')).toBeInTheDocument();
  });

  it('结果到手时不表态（渲染为 null）', () => {
    const { container } = render(<AgentRunStateTag running={false} hasResult missingReason={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('since 为 null 时不挂定时器：推进时间数字不变', () => {
    vi.useFakeTimers({ now: new Date(NOW) });
    try {
      render(<AgentRunStateTag running hasResult={false} missingReason={null} since={null} />);

      expect(screen.getByText('进行中')).toBeInTheDocument();
      expect(vi.getTimerCount()).toBe(0);

      act(() => vi.advanceTimersByTime(30_000));
      expect(screen.getByText('进行中')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
