// @vitest-environment node
/**
 * `fenceFrontmatter` 的判据：frontmatter 段被包成 yaml 代码块、其余一字不动；
 * 没有 frontmatter（含未闭合的半个块）原样返回。
 *
 * 这里只钉字符串——「包完之后 markdown 到底还长不长出标题」是渲染器的事，钉在真实消费方
 * （`skill-detail-drawer.test.tsx`）那一层。
 */
import { describe, expect, it } from 'vitest';
import { fenceFrontmatter } from './skill-preview-markdown';

/** 真实形态：两行字段 + 收尾围栏 + 空行 + 正文 */
const RAW = ['---', 'name: poetry', 'description: 推荐唐诗', '---', '', '1. 只推一首', ''].join('\n');

describe('fenceFrontmatter：把 YAML 围栏包进代码块', () => {
  it('frontmatter 逐字进 yaml 代码块，正文原样跟在后面', () => {
    expect(fenceFrontmatter(RAW)).toBe(
      ['```yaml', '---', 'name: poetry', 'description: 推荐唐诗', '---', '```', '', '1. 只推一首', ''].join('\n'),
    );
  });

  it('字段行之后紧跟的是闭合围栏，不再是收尾那条 ---（setext 标题的触发条件）', () => {
    expect(fenceFrontmatter(RAW)).toContain('description: 推荐唐诗\n---\n```');
  });

  it('没有 frontmatter ⇒ 一字不动', () => {
    const plain = '# 直接就是正文\n';
    expect(fenceFrontmatter(plain)).toBe(plain);
  });

  it('只有开围栏没有闭合 ⇒ 按普通正文原样返回（与准入那把尺同判）', () => {
    const half = ['---', 'name: broken'].join('\n');
    expect(fenceFrontmatter(half)).toBe(half);
  });

  it('CRLF + BOM 的 SKILL.md 照样包得上', () => {
    const fenced = fenceFrontmatter('\uFEFF---\r\nname: crlf\r\n---\r\n正文\r\n');

    expect(fenced.startsWith('```yaml\n')).toBe(true);
    expect(fenced).toContain('name: crlf');
    expect(fenced).toContain('正文');
  });
});
