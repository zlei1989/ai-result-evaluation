/**
 * RunDetailSkeleton：右栏快照未到时的占位。
 *
 * 钉住三条：
 *   1. 渲染的是**真骨架**（每张卡里都有 `.ant-skeleton` 节点），不是只有 testid 的空白盒子——
 *      只断言 testid 会漏掉「`Skeleton` 根本没渲染」这一类失败（同 `diff-view.test.tsx`）；
 *   2. 形状与详情面板同构：一张信息卡 + 默认三张候选卡，张数可用 `rows` 调；
 *   3. 不是空态：旧文案「正在加载评测…」不该再出现，而对读屏器仍有一个可读的 `status` 名
 *      （骨架本身没有文字，播报来源不能跟着丢）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { installResizeObserverStub } from '../testing/resize-observer';
import { RUN_DETAIL_SKELETON_ROWS, RunDetailSkeleton } from './run-detail-skeleton';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RunDetailSkeleton', () => {
  it('渲染真骨架：信息卡 + 默认三张候选卡', () => {
    const { container } = render(<RunDetailSkeleton />);

    expect(screen.getByTestId('run-detail-loading-header')).toBeInTheDocument();
    expect(screen.getAllByTestId('run-detail-loading-row')).toHaveLength(RUN_DETAIL_SKELETON_ROWS);
    // 每张卡各一块骨架（卡片本身不是骨架，只断言卡的数量等于张数会放过「Card 里是空的」）
    expect(container.querySelectorAll('.ant-skeleton')).toHaveLength(RUN_DETAIL_SKELETON_ROWS + 1);
  });

  it('候选卡张数可调：rows 只影响候选卡，信息卡恒有一张', () => {
    render(<RunDetailSkeleton rows={1} />);

    expect(screen.getAllByTestId('run-detail-loading-row')).toHaveLength(1);
    expect(screen.getByTestId('run-detail-loading-header')).toBeInTheDocument();
  });

  it('不是空态：旧文案不出现，读屏器有 status 可读名', () => {
    render(<RunDetailSkeleton />);

    expect(screen.queryByText('正在加载评测…')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '正在加载评测详情' })).toBeInTheDocument();
  });
});
