/**
 * MarkdownText：把提示词里的 markdown 渲染成 antd 元素。
 *
 * 每条断言都对着**真实用例里出现过的写法**写（用例 `229bef96` 的考题提示词 8855 字符里有
 * 14 行标题、23 行表格、6 个围栏代码块、115 处行内代码），并钉住两件不许回退的事：
 *   1. GFM 表格必须成 `<table>`——拿掉 `remark-gfm`，那 23 行会退化成一段竖线文本（本文件的
 *      「表格」那条就是它的守卫）；
 *   2. 提示词里的原始 HTML **绝不**变成活元素（提示词由模型/外部系统产生，是外部输入）；
 *      `react-markdown` 默认把 HTML 转义成文本，不引入 `rehype-raw` 是有意为之。
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownText } from './markdown-text';

/** 渲染并取回 RTL 容器：结构断言一律从容器往下查，避免命中测试文件之外的同名文本 */
function renderMarkdown(text: string): HTMLElement {
  const { container } = render(<MarkdownText text={text} />);
  return container;
}

describe('MarkdownText', () => {
  /**
   * 标题映射到 antd `Title`：右栏只有 320–640px，markdown 的 `#` 不能长成页面级巨标题，
   * 也不能原样漏成 `<h1>`（那样会污染整个页面的标题大纲）。
   */
  it('标题按层级映射到 antd Title（h1→4 级，h2/h3→5 级），不出现裸 h1', () => {
    const host = renderMarkdown('# 一级标题\n\n## 二级标题\n\n### 三级标题\n');

    expect(screen.getByRole('heading', { level: 4, name: '一级标题' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 5, name: '二级标题' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 5, name: '三级标题' })).toBeInTheDocument();
    expect(host.querySelector('h1')).toBeNull();
  });

  it('粗体成 strong、行内代码成 code 元素', () => {
    const host = renderMarkdown('调用方为**行云平台**，接口在 `OpenController` 下\n');

    expect(host.querySelector('strong')?.textContent).toBe('行云平台');
    expect(host.querySelector('code')?.textContent).toBe('OpenController');
  });

  /**
   * 围栏代码块：`textContent` 必须**逐字**等于原文 + 一个收尾换行。
   * 末尾那个 `\n` 是 CommonMark 的规定（`<pre><code>…\n</code></pre>`），不是被吃掉的缩进；
   * 断言写成精确相等（而不是 trim 之后再比）是为了连「多一个 / 少一个换行」都能拦住——
   * 提示词里的链路图靠前导空格对齐，任何折叠 / 归一都会让它读不出来。
   */
  it('围栏代码块保留原文的换行与前导空格', () => {
    const code = 'POST /api/open/query-file-change-log\n  OpenController.queryFileChangeLogs   (lc-web:45)\n    GitCommitServiceImpl.queryFileChangeLogs';
    const host = renderMarkdown(`现有链路：\n\n\`\`\`text\n${code}\n\`\`\`\n`);

    expect(host.querySelector('pre')?.textContent).toBe(`${code}\n`);
  });

  /** GFM 守卫：表格必须是真表格（拿掉 remark-gfm 这条必红） */
  it('GFM 表格渲染成 table / columnheader / cell', () => {
    renderMarkdown('| 字段 | 说明 |\n| --- | --- |\n| agent | 智能体 |\n');

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '字段' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'agent' })).toBeInTheDocument();
  });

  /** 链接必须新标签打开 + `rel` 挡掉 `window.opener`：提示词里的外链不受本仓控制 */
  it('链接以新标签打开，并带 noreferrer', () => {
    renderMarkdown('调用方见 [行云平台](https://example.com/doc)\n');

    const link = screen.getByRole('link', { name: '行云平台' });
    expect(link).toHaveAttribute('href', 'https://example.com/doc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  /** 安全守卫：原始 HTML 既不能变活元素，也不能被悄悄吞掉（要能看见提示词里写了什么） */
  it('原始 HTML 只当文本，不生成 img / script 元素', () => {
    const host = renderMarkdown('正常文本\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>\n');

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toContain('<img src="x" onerror="alert(1)">');
    expect(host.textContent).toContain('<script>alert(2)</script>');
  });

  /** 无 markdown 语法的纯文本照旧显示（历史用例的提示词多是这种） */
  it('纯文本原样显示', () => {
    renderMarkdown('为 anthropic-to-chat 补一条回归用例');

    expect(screen.getByText('为 anthropic-to-chat 补一条回归用例')).toBeInTheDocument();
  });
});
