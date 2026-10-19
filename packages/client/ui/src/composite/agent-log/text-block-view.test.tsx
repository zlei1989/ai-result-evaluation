/**
 * TextBlockView：**只有正文走 markdown**，以及的角色 / 来源 / 动效三格。
 *
 * 五条守卫：
 * · `assistant` **不标注**（默认主角，标了反而吵）；`user` 与其余角色同形；`system` 出「系统」标，
 * 正文仍走 markdown 外壳（不另套排印容器）；
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
    segment: 0,
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

  it('user 与其余角色**同形**：无标签、无竖线、无内边距，样式全归 markdown 外壳', () => {
    const { container } = render(<TextBlockView block={textBlock({ role: 'user' })} />);

    expect(screen.queryByText('用户')).toBeNull();
    // 不再有左侧竖线，也没有我们加的内边距：本仓在这一块不提供任何样式
    const style = container.firstElementChild?.getAttribute('style') ?? '';
    expect(style).not.toContain('border-inline-start');
    expect(style).not.toContain('padding');
    // 正文确实由 markdown 外壳渲染（本仓不套排版容器）
    expect(container.querySelector('[data-slot="markdown"]')).not.toBeNull();
  });

  it('system 出「系统」标，但**不套本仓自己的排版容器**（正文样式归 markdown 外壳）', () => {
    const { container } = render(<TextBlockView block={textBlock({ role: 'system' })} />);

    expect(screen.getByText('系统')).toBeInTheDocument();
    // 角标是 vendored 的 `Badge`（`data-slot="badge"`）；「antd 不许回来」由仓库级守卫
    // `apps/web-next/src/antd-free.test.ts` 守，这一条只钉角标自己的结构
    expect(screen.getByText('系统').closest('[data-slot="badge"]')).not.toBeNull();
    // 任何排版容器都会盖掉 markdown 自己的 `table` / `code` / 段落规则 ⇒ 同一段 markdown 在两档里
    // 长得不一样。判据取结构：markdown 的直接父节点就是块根，中间没有第二层容器。
    const markdown = container.querySelector('[data-slot="markdown"]');
    expect(markdown, '正文没有交给 markdown 外壳').not.toBeNull();
    expect(markdown?.parentElement, '正文外面套了一层容器（会盖掉 markdown 自己的排印）').toBe(
      container.firstElementChild,
    );
  });

  it('非 wire 的来源出角标：session-file → 补录、aggregate → 汇总、wire 不出', () => {
    const { unmount } = render(<TextBlockView block={textBlock({ source: 'session-file' })} />);
    expect(screen.getByText('补录')).toBeInTheDocument();
    expect(screen.getByText('补录').closest('[data-slot="badge"]')).not.toBeNull();
    unmount();

    const { unmount: unmount2 } = render(<TextBlockView block={textBlock({ source: 'aggregate' })} />);
    expect(screen.getByText('汇总')).toBeInTheDocument();
    unmount2();

    render(<TextBlockView block={textBlock({ source: 'wire' })} />);
    expect(screen.queryByText('补录')).toBeNull();
    expect(screen.queryByText('汇总')).toBeNull();
  });

  /**
   * **块里不再有「正在写」那一行**（用户口径：删掉那个持续动效）。
   *
   * 判据两档都要看：`open`（还在流）时也不许出现——那一行是一段与正文无关的持续动效，
   * 在一段已经读得通的正文底下只会被读成空白；「还在写」的信号就是新内容自己出现
   * （`XMarkdownText` 的 `open`，判据仍是 `assembly`）。顺带钉住：闪烁光标与加载态锚点
   * （`role="status"` / `.animate-spin`）都不许出现在正文块上。
   */
  it('不该有「正在思考」那一行（open / snapshot 两档都不出现，也没有转圈图标 / 光标）', () => {
    const { container, unmount } = render(<TextBlockView block={textBlock({ assembly: 'open' })} />);
    expect(screen.queryByText('正在思考')).toBeNull();
    // 加载态的新锚点：状态播报（`role="status"`）与转圈图标（`animate-spin`）
    expect(container.querySelector('[role="status"], .animate-spin')).toBeNull();
    expect(container.querySelector(`.${STREAM_CURSOR_CLASS}`)).toBeNull();
    unmount();

    const { container: snapshot } = render(<TextBlockView block={textBlock({ assembly: 'snapshot' })} />);
    expect(screen.queryByText('正在思考')).toBeNull();
    expect(snapshot.querySelector('[role="status"], .animate-spin')).toBeNull();
    // 闪烁光标**不挂在正文块上**（那一格留给了评测列表的活动行）
    expect(snapshot.querySelector(`.${STREAM_CURSOR_CLASS}`)).toBeNull();
  });

  it('流式状态照旧只由 `assembly` 表达：`open` 交给 markdown 外壳，块自己不另加行', () => {
    const { container } = render(<TextBlockView block={textBlock({ assembly: 'open', text: '**粗体**' })} />);

    // 正文照常渲染（markdown 生效），且整块只有正文这一处内容（段落边界由渲染器决定）
    expect(container.querySelector('strong')).not.toBeNull();
    expect(container.textContent?.trim()).toBe('粗体');
  });

  it('正文走 markdown', () => {
    const { container } = render(<TextBlockView block={textBlock({ text: '**粗体**' })} />);

    expect(container.querySelector('strong')).not.toBeNull();
  });
});
