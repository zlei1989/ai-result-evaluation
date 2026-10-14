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

  it('user 与其余角色**同形**：无标签、无竖线、无内边距，样式全归 XMarkdown', () => {
    const { container } = render(<TextBlockView block={textBlock({ role: 'user' })} />);

    expect(screen.queryByText('用户')).toBeNull();
    // 不再有左侧竖线，也没有我们加的内边距：本仓在这一块不提供任何样式
    const style = container.firstElementChild?.getAttribute('style') ?? '';
    expect(style).not.toContain('border-inline-start');
    expect(style).not.toContain('padding');
    // 正文确实由 XMarkdown 渲染（本仓不套排版容器）
    expect(container.querySelector('.x-markdown')).not.toBeNull();
  });

  it('system 出「系统」标，但**不套本仓自己的排版容器**（正文样式归 XMarkdown）', () => {
    const { container } = render(<TextBlockView block={textBlock({ role: 'system' })} />);

    expect(screen.getByText('系统')).toBeInTheDocument();
    // 此前这里断言 `ant-typography-secondary`：那一层 `Typography.Paragraph` 会盖掉 X 自己的
    // `table` / `code` / 段落规则 ⇒ 同一段 markdown 在两档里长得不一样。现在不套了。
    expect(container.querySelector('.ant-typography-secondary')).toBeNull();
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

  it('assembly 为 open 时给「正在思考」那一行，snapshot 时不给', () => {
    const { container, unmount } = render(<TextBlockView block={textBlock({ assembly: 'open' })} />);
    expect(screen.getByText('正在思考')).toBeInTheDocument();
    // 有字才说得清在做什么：那一行必须带转圈（`Spin` 的 DOM），不是一句干文案
    expect(container.querySelector('.ant-spin')).not.toBeNull();
    unmount();

    const { container: snapshot } = render(<TextBlockView block={textBlock({ assembly: 'snapshot' })} />);
    expect(screen.queryByText('正在思考')).toBeNull();
    expect(snapshot.querySelector('.ant-spin')).toBeNull();
    // 旧的闪烁光标**不再挂在正文块上**（那一格留给了评测列表的活动行）
    expect(snapshot.querySelector(`.${STREAM_CURSOR_CLASS}`)).toBeNull();
  });

  it('正文走 markdown', () => {
    const { container } = render(<TextBlockView block={textBlock({ text: '**粗体**' })} />);

    expect(container.querySelector('strong')).not.toBeNull();
  });
});
