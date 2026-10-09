/**
 * ThinkingBlockView：折叠面板 + 「思考中…」扫光。
 *
 * 四条守卫：
 *   · **没有正文就什么都不渲染**（`text === null` ⇒ 整块隐藏）：不给占位文案、也不给空面板——
 *     空面板会被读成「思考了但什么也没想」，占位文案则会把「这一轮没采到」当成内容显示出来；
 *   · `textKind === 'summary'` 出「摘要」标——不标注就是假称全文；
 *   · `assembly === 'open'` 且**收起**时标题挂扫光类名；展开态不挂（正文在流，标题不必也表态）；
 *   · 展开后正文是等宽 + 斜体 + 左侧竖线。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_SWEEP_CLASS } from '../../base/agent-activity-line';
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
    usage: null,
    text: '先看测试，再改实现',
    textMissing: null,
    textKind: 'full',
    ...overrides,
  };
}

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

  it('textKind 为 summary 时出「摘要」标', () => {
    render(<ThinkingBlockView block={thinkingBlock({ textKind: 'summary' })} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('摘要')).toBeInTheDocument();
  });

  it('流式中且收起时标题挂扫光；展开态不挂', () => {
    const { container, unmount } = render(
      <ThinkingBlockView block={thinkingBlock({ assembly: 'open' })} open={false} onOpenChange={vi.fn()} />,
    );
    expect(container.querySelector(`.${ACTIVITY_SWEEP_CLASS}`)).not.toBeNull();
    expect(screen.getByText('思考中…')).toBeInTheDocument();
    unmount();

    const { container: expanded } = render(
      <ThinkingBlockView block={thinkingBlock({ assembly: 'open' })} open onOpenChange={vi.fn()} />,
    );
    // 展开态：正文自己就是「还在流」的证据，标题不再挂动效
    expect(expanded.querySelector(`.${ACTIVITY_SWEEP_CLASS}`)).toBeNull();
  });

  it('块已结束（snapshot）时收起态也不挂扫光', () => {
    const { container } = render(
      <ThinkingBlockView block={thinkingBlock({ assembly: 'snapshot' })} open={false} onOpenChange={vi.fn()} />,
    );

    expect(container.querySelector(`.${ACTIVITY_SWEEP_CLASS}`)).toBeNull();
    expect(screen.queryByText('思考中…')).toBeNull();
  });

  it('展开后正文是等宽 + 斜体 + 左侧竖线', () => {
    const { container } = render(<ThinkingBlockView block={thinkingBlock()} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('先看测试，再改实现')).toBeInTheDocument();
    // antd 的 `italic` 不是类名，而是把内容包进 `<i>`（`Typography/Base/index.js` 的 `wrap('i', italic)`）
    expect(container.querySelector('i')).not.toBeNull();
    // 竖线挂在正文那一段上（标题里的 `Typography.Text` 没有 style，故选整段 HTML 断言）
    expect(container.innerHTML).toContain('border-inline-start');
  });

  it('非 wire 的来源出角标', () => {
    render(
      <ThinkingBlockView block={thinkingBlock({ source: 'session-file' })} open onOpenChange={vi.fn()} />,
    );

    expect(screen.getByText('补录')).toBeInTheDocument();
  });
});
