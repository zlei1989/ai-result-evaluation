/**
 * TextBlockView：**只有正文走 markdown**，以及的角色 / 来源 / 动效三格。
 *
 * 五条守卫：
 * · `assistant` **不标注**（默认主角，标了反而吵）；`user` 出「用户」；`system` 出「系统」
 * 且整块降一档（`ant-typography-secondary`）；
 * · `source` 非 `wire` 时出角标（`session-file` → 「补录」、`aggregate` → 「汇总」），
 * `wire` / `hook` 不出；
 * · `assembly === 'open'` 挂流式光标类名、`snapshot` **不挂**（变异体 (y) 的落点之一）；
 * · 正文是 markdown（`**粗体**` 变成 `strong`）——这是「只有 text 块走 markdown」的可见形式。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STREAM_CURSOR_CLASS, TextBlockView } from './text-block-view';
import type { TextBlock } from './types';

function textBlock(overrides: Partial<TextBlock> = {}): TextBlock {
  return {
    kind: 'text',
    id: 'blk-1',
    at: '2026-10-02T08:00:00.000Z',
    messageId: 'msg-1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    usage: null,
    text: '正文',
    ...overrides,
  };
}

describe('TextBlockView', () => {
  it('assistant 不标注角色，也不带来源角标', () => {
    render(<TextBlockView block={textBlock()} />);

    expect(screen.queryByText('用户')).toBeNull();
    expect(screen.queryByText('系统')).toBeNull();
    expect(screen.queryByText('补录')).toBeNull();
    expect(screen.queryByText('汇总')).toBeNull();
  });

  it('user 出「用户」标，并给左侧竖线', () => {
    const { container } = render(<TextBlockView block={textBlock({ role: 'user' })} />);

    expect(screen.getByText('用户')).toBeInTheDocument();
    // 竖线是结构性样式（用户消息与智能体输出必须一眼分得开）
    expect(container.firstElementChild?.getAttribute('style')).toContain('border-inline-start');
  });

  it('system 出「系统」标，且整块降一档（secondary）', () => {
    const { container } = render(<TextBlockView block={textBlock({ role: 'system' })} />);

    expect(screen.getByText('系统')).toBeInTheDocument();
    expect(container.querySelector('.ant-typography-secondary')).not.toBeNull();
  });

  it('非 wire 的来源出角标：session-file → 补录、aggregate → 汇总、wire 不出', () => {
    const { unmount } = render(<TextBlockView block={textBlock({ source: 'session-file' })} />);
    expect(screen.getByText('补录')).toBeInTheDocument();
    unmount();

    const { unmount: unmount2 } = render(<TextBlockView block={textBlock({ source: 'aggregate' })} />);
    expect(screen.getByText('汇总')).toBeInTheDocument();
    unmount2();

    render(<TextBlockView block={textBlock({ source: 'wire' })} />);
    expect(screen.queryByText('补录')).toBeNull();
    expect(screen.queryByText('汇总')).toBeNull();
  });

  it('assembly 为 open 时挂流式光标类名，snapshot 时不挂', () => {
    const { container, unmount } = render(<TextBlockView block={textBlock({ assembly: 'open' })} />);
    expect(container.querySelector(`.${STREAM_CURSOR_CLASS}`)).not.toBeNull();
    unmount();

    const { container: snapshot } = render(<TextBlockView block={textBlock({ assembly: 'snapshot' })} />);
    expect(snapshot.querySelector(`.${STREAM_CURSOR_CLASS}`)).toBeNull();
  });

  it('正文走 markdown', () => {
    const { container } = render(<TextBlockView block={textBlock({ text: '**粗体**' })} />);

    expect(container.querySelector('strong')).not.toBeNull();
  });
});
