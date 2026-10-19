/** EllipsisText：内容渲染、省略与全量提示。 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EllipsisText } from './ellipsis-text';

describe('EllipsisText', () => {
  it('渲染文本', () => {
    render(<EllipsisText text="D:/a/very/long/path/to/module" />);
    expect(screen.getByText('D:/a/very/long/path/to/module')).toBeInTheDocument();
  });

  it('宽度固定时落到 style（保证列宽不被长文本顶开）', () => {
    render(<EllipsisText text="abc" width={120} />);
    expect(screen.getByText('abc').style.maxWidth).toBe('120px');
  });

  it('不传宽度时吃满单元格（maxWidth 100%）', () => {
    render(<EllipsisText text="abc" />);
    expect(screen.getByText('abc').style.maxWidth).toBe('100%');
  });

  it('省略靠 truncate，全量靠原生 title（悬停可见、可复制）', () => {
    render(<EllipsisText text="D:/a/very/long/path" />);
    const node = screen.getByText('D:/a/very/long/path');
    expect(node.className).toContain('truncate');
    expect(node).toHaveAttribute('title', 'D:/a/very/long/path');
  });

  it('tooltip 给的是**另一份**全量文本（显示短形式时提示仍给完整路径）', () => {
    render(<EllipsisText text="repo-name" tooltip="group/repo-name" />);
    expect(screen.getByText('repo-name')).toHaveAttribute('title', 'group/repo-name');
  });

  it('monospace 与 strong 各自落到命名类（哈希 / 主字段）', () => {
    render(<EllipsisText text="abcdef1" monospace strong />);
    const node = screen.getByText('abcdef1');
    expect(node.className).toContain('font-mono');
    expect(node.className).toContain('font-semibold');
  });

  /**
   * `muted`（次级色）：给「这一行不生效，但内容照旧要读」的格用（MCP 表的停用行名称）。
   * 两半都要钉：传了要**真有**那个语义类；不传时**不许**带上——只钉前者会放过「一律加灰」，
   * 那正是这条 prop 要避免的（整行涂淡会把排障要读的字一起藏起来）。
   */
  it('muted 时带次级色语义类，不传时一个字节都不带（弱化 ≠ 一律加灰）', () => {
    render(<EllipsisText text="playwright" muted />);
    render(<EllipsisText text="context7" />);

    expect(screen.getByText('playwright').className).toContain('text-muted-foreground');
    expect(screen.getByText('context7').className).not.toContain('text-muted-foreground');
    // 弱化不等于隐藏：文本照旧在 DOM 里（次级色只是换了个颜色）
    expect(screen.getByText('playwright')).toHaveTextContent('playwright');
  });

  it('空串不挂提示（空浮层无意义）', () => {
    render(<EllipsisText text="" />);
    // 空串时 DOM 里没有可查的文本节点，按 class 取那唯一一个宿主
    const host = document.querySelector('span.truncate');
    expect(host).not.toBeNull();
    expect(host).not.toHaveAttribute('title');
  });
});
