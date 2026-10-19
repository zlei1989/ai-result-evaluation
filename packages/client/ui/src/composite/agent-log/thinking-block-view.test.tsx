/**
 * ThinkingBlockView（`Reasoning` 形态）：一条 `TraceLine` + 受控展开的正文。
 *
 * 守卫：
 *   · **没有正文就什么都不渲染**（`text === null` ⇒ 整块隐藏）：不给占位文案、也不给空面板——
 *     空面板会被读成「思考了但什么也没想」，占位文案则会把「这一轮没采到」当成内容显示出来；
 *   · `textKind` 不进呈现：`summary` 那一档（只有 codex 会落）照常显示正文、**不出「摘要」标**——
 *     单一厂商的正文形态差异不升为界面标注；
 *   · 标题是**状态文字**：`assembly === 'open'` ⇒ 「思考中…」，否则「思考」；`TraceLine` 的
 *     `status` 同样由 `assembly` 派生（流式的唯一判据），收成快照后**不传 status**（不再 shimmer）；
 *   · 非 wire 来源出角标（「补录」/「汇总」），与状态文字同一行；
 *   · **开合是受控的**（分层纪律 (d)）：`aria-expanded` 完全来自 `open`，点触发器只把
 *     `!open` 交回调用方，组件自己不翻面。`open ?? running` 的三段落住在
 *     `useAgentLogView`（默认键 / 点开 / 点收），不在这个组件里；
 *   · 正文是**纯文本**（思考不是 markdown）：不解析 `**`，也不带本仓自己的排印
 *     （无斜体、无左侧竖线）；收起时正文不在 DOM 里（真收起，不是视觉收起）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ThinkingBlockView } from './thinking-block-view';
import type { ThinkingBlock } from './types';

function thinkingBlock(overrides: Partial<ThinkingBlock> = {}): ThinkingBlock {
  return {
    kind: 'thinking',
    id: 'blk-think',
    at: '2026-10-02T08:00:00.000Z',
    messageId: 'msg-1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
    text: '先看测试，再改实现',
    textMissing: null,
    textKind: 'full',
    ...overrides,
  };
}

/** 标题那一行（`TraceLine`）；`status` 不传时这个属性根本不存在 */
const traceLine = (container: HTMLElement): HTMLElement => {
  const line = container.querySelector<HTMLElement>('[data-slot="trace-line"]');
  if (line === null) throw new Error('思考块没有画成 TraceLine');
  return line;
};

describe('ThinkingBlockView', () => {
  it('拿不到文本时**整块隐藏**（没有占位文案，也没有「思考」块头）', () => {
    const { container } = render(
      <ThinkingBlockView
        block={thinkingBlock({ text: null, textKind: 'none', textMissing: 'not-observed' })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('厂商有、我们还没接')).toBeNull();
    expect(screen.queryByText('思考文本未采集')).toBeNull();
    expect(screen.queryByText('思考')).toBeNull();
  });

  it('`textMissing === null` 的那一档同样隐藏（占位文案不再是任何一档的出口）', () => {
    const { container } = render(
      <ThinkingBlockView
        block={thinkingBlock({ text: null, textKind: 'none', textMissing: null })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * **空白正文与没有正文是同一档**（用户口径）：`text: ''` 时若照常渲染，出来的是「思考」标题
   * 带一片空白——那一行空白既不是内容也不是状态。它真在流里出现过：codex / pi 的思考增量帧
   * 不过滤空 delta ⇒ 「思考刚开始、正文还没到」那一拍就是一条 `text: ''`。
   * 这一条是本件的第二道（第一道在 `build-model` 的块过滤里）。
   */
  it('空白正文（`text: \'\'` / 只有空白）同样整块隐藏，也不出「思考中…」标题', () => {
    const { container, unmount } = render(
      <ThinkingBlockView block={thinkingBlock({ text: '', textKind: 'full' })} open onOpenChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('思考')).toBeNull();
    unmount();

    const blank = render(
      <ThinkingBlockView block={thinkingBlock({ text: '  \n ', assembly: 'open' })} open={false} onOpenChange={vi.fn()} />,
    );
    expect(blank.container).toBeEmptyDOMElement();
    expect(screen.queryByText('思考中…')).toBeNull();
  });

  it('textKind 为 summary 时正文照常显示，且**不出「摘要」标**（`textKind` 不进呈现）', () => {
    render(<ThinkingBlockView block={thinkingBlock({ textKind: 'summary' })} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('先看测试，再改实现')).toBeInTheDocument();
    expect(screen.queryByText('摘要')).toBeNull();
  });

  it('还在流（assembly=open）时标题一律是「思考中…」——收起与展开同款', () => {
    const { unmount } = render(
      <ThinkingBlockView block={thinkingBlock({ assembly: 'open' })} open={false} onOpenChange={vi.fn()} />,
    );
    expect(screen.getByText('思考中…')).toBeInTheDocument();
    unmount();

    render(<ThinkingBlockView block={thinkingBlock({ assembly: 'open' })} open onOpenChange={vi.fn()} />);
    expect(screen.getByText('思考中…')).toBeInTheDocument();
  });

  it('块已结束（snapshot）时标题回落「思考」，不残留进行中信号', () => {
    render(<ThinkingBlockView block={thinkingBlock({ assembly: 'snapshot' })} open={false} onOpenChange={vi.fn()} />);

    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText('思考中…')).toBeNull();
  });

  /**
   * `TraceLine.status` 由 `assembly` 派生（与工具行同一条口径）：还在流给 `running`（标题 shimmer），
   * 收成快照**不传 status**。写死 `running` 的话，收到快照后 shimmer 停不下来，而上面那些
   * 只查文案的用例照样全绿。
   */
  it('`TraceLine.status` 由 `assembly` 派生：进行中是 running，结束后没有 status 属性', () => {
    const { container, unmount } = render(
      <ThinkingBlockView block={thinkingBlock({ assembly: 'open' })} open={false} onOpenChange={vi.fn()} />,
    );
    expect(traceLine(container)).toHaveAttribute('data-status', 'running');
    unmount();

    const { container: done } = render(
      <ThinkingBlockView block={thinkingBlock({ assembly: 'snapshot' })} open={false} onOpenChange={vi.fn()} />,
    );
    expect(traceLine(done).hasAttribute('data-status'), '快照块仍然传了 status ⇒ 跑完还在 shimmer').toBe(false);
  });

  /**
   * **受控开合**：`aria-expanded` 只来自 `open`。这一条同时是「组件里没有第二份 state」的判据：
   * 点了之后 `aria-expanded` **不变**（组件不自己翻面），只有调用方回写 `open` 才会变。
   */
  it('开合受控：aria-expanded 跟着 open 走，点击只把 !open 交回调用方', () => {
    const onOpenChange = vi.fn();
    const { container, rerender } = render(
      <ThinkingBlockView block={thinkingBlock()} open={false} onOpenChange={onOpenChange} />,
    );
    const trigger = screen.getByRole('button', { name: /思考/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    // Base UI 会在第二参带上事件详情；本仓只吃第一个（下一格 open）
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(true);
    // 组件自己不翻面：没有回写 open 时它仍是收起的
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[data-testid="reasoning-body"]')).toBeNull();

    // 调用方回写之后才展开
    rerender(<ThinkingBlockView block={thinkingBlock()} open onOpenChange={onOpenChange} />);
    expect(screen.getByRole('button', { name: /思考/ })).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-testid="reasoning-body"]')).not.toBeNull();
  });

  it('收起时正文不在 DOM 里（真收起，不是视觉收起）', () => {
    render(<ThinkingBlockView block={thinkingBlock()} open={false} onOpenChange={vi.fn()} />);

    expect(screen.queryByText('先看测试，再改实现')).toBeNull();
  });

  it('展开后正文是**纯文本**：不解析 markdown、不带本仓排印（无斜体、无左侧竖线）', () => {
    const { container } = render(
      <ThinkingBlockView block={thinkingBlock({ text: '**先看测试**，再改实现' })} open onOpenChange={vi.fn()} />,
    );

    const body = container.querySelector<HTMLElement>('[data-testid="reasoning-body"]');
    expect(body?.textContent).toBe('**先看测试**，再改实现');
    // 思考不是 markdown：解析 `**` 会得到一个 `<strong>`，那是另一条口径
    expect(container.querySelector('strong')).toBeNull();
    // 本仓不再自带样式：`italic` 会渲染成 `<i>`、竖线会写成 `border-inline-start`，两者都不该出现
    expect(container.querySelector('i')).toBeNull();
    expect(container.innerHTML).not.toContain('border-inline-start');
  });

  it('非 wire 的来源出角标', () => {
    render(
      <ThinkingBlockView block={thinkingBlock({ source: 'session-file' })} open onOpenChange={vi.fn()} />,
    );

    expect(screen.getByText('补录')).toBeInTheDocument();
  });
});
