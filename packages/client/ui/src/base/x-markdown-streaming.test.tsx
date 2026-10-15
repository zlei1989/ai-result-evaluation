/**
 * `XMarkdownText` 流式观感的现状守卫：钉住 `@ant-design/x-markdown@2.9.0` 上
 * 「片段渐显」这一档的**生效**，以及 `tail: false`（无 ▋ 光标）的现状。
 *
 * 为什么值得钉：这一格的失效是静默的——`enableAnimation` 被误删或覆盖时文字照常出现，
 * 只是没有任何动效，界面与控制台都不报错。断言走 **XMarkdown 自己的渲染产物**
 * （带 `x-markdown-fade-in` 内联动画的 chunk span），而不是我们传进去的 props：
 * 「配了」与「生效」是两件事（与 `x-provider.test.tsx` 同一口径）。
 *
 * 边界：X 官网 demo 的逐字打字机（`typewriter`）在官方 main 分支、2.9.0 没有该属性；
 * 官方发版换布尔预设后，本文件的 chunk 断言按新行为重写（见《行执行与日志》边界表）。
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { XMarkdownText } from './x-markdown';

/** AnimationText 产出的 chunk span：内联 style 里带 `x-markdown-fade-in` */
function chunkSpans(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.x-markdown span[style*="x-markdown-fade-in"]'));
}

describe('XMarkdownText 流式淡入（2.9.0 能力范围）', () => {
  it('同一实例追加文本：旧片段的 span 保留，新片段是新的淡入 chunk（而不是整段重放）', () => {
    const view = render(<XMarkdownText text="第一句话" open />);
    const firstChunk = chunkSpans(view.container);
    expect(firstChunk.map((s) => s.textContent)).toEqual(['第一句话']);

    // 流式追加：同一个 React 实例上 text 变长（与真实页面「同块持续增长」同形）
    view.rerender(<XMarkdownText text="第一句话，第二句" open />);

    const chunks = chunkSpans(view.container);
    // 旧 chunk 不重挂 + 新增部分单独一个带动画的 span —— 这就是 2.9.0 的「打字观感」
    expect(chunks.map((s) => s.textContent)).toEqual(['第一句话', '，第二句']);
    expect(chunks[1]?.getAttribute('style')).toContain('x-markdown-fade-in');
  });

  it('tail: false 的现状：流式期间没有 ▋ 光标', () => {
    const view = render(<XMarkdownText text="还在写" open />);
    expect(view.container.querySelector('.xmd-tail')).toBeNull();
  });
});
