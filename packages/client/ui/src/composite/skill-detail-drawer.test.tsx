/**
 * SkillDetailDrawer：顶部三个只读事实、frontmatter 逐字等宽、正文渲染成 markdown、
 * 原始 HTML 只当文本、不可用条目照旧打得开、三态（读取中 / 读失败 / 有内容）。
 *
 * 为什么这些断言落在抽屉这一层而不是只留在 `MarkdownText` 自己的用例里：`SKILL.md` 是**外部输入**
 * （可能随被测仓库克隆进来），「不引 `rehype-raw` ⇒ 原始 HTML 转义成文本」这条安全口径要在
 * 真实消费方这里再钉一次——将来有人图省事给 `MarkdownText` 加上 `rehype-raw`，那一处不会红，
 * 这一处会。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceError, type SkillEntry, type SkillFile } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { SkillDetailDrawer } from './skill-detail-drawer';

// jsdom 没有 ResizeObserver，而 antd 的 Drawer 内部（rc-resize-observer）会直接 new 它
beforeEach(() => {
  installResizeObserverStub();
});

const ROOT = '/home/u/.aieval/skills';

const OK_SKILL: SkillEntry = {
  name: 'tang-poem-meal',
  dir: `${ROOT}/tang-poem-meal`,
  description: '推荐唐诗',
  ok: true,
  disabled: false,
  sizeBytes: 2048,
};

const BAD_SKILL: SkillEntry = {
  name: 'broken-skill',
  dir: `${ROOT}/broken-skill`,
  description: '',
  ok: false,
  reason: '缺 SKILL.md（技能是一个目录，里面放 SKILL.md；只扫这一层，不递归）',
  disabled: false,
};

const FILE: SkillFile = {
  frontmatter: '---\nname: tang-poem-meal\ndescription: 推荐唐诗\n---',
  body: [
    '## 规则',
    '',
    '**只推荐一首**与吃饭有关的唐诗。',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 首数 | 1 |',
    '',
    '<img src="x" onerror="alert(1)">',
    '',
  ].join('\n'),
};

const noop = (): void => {};

describe('SkillDetailDrawer：顶部三个只读事实', () => {
  it('名称 / 路径 / 大小都在场（大小按人类可读渲染）', () => {
    render(
      <SkillDetailDrawer open skill={OK_SKILL} file={FILE} error={undefined} loading={false} onClose={noop} />,
    );

    expect(screen.getByText('tang-poem-meal')).toBeInTheDocument();
    expect(screen.getByText(`${ROOT}/tang-poem-meal`)).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('大小算不出（sizeBytes 缺席）⇒ 写「未知」，不拿 0 顶替', () => {
    const { sizeBytes: _omitted, ...withoutSize } = OK_SKILL;
    render(
      <SkillDetailDrawer open skill={withoutSize} file={FILE} error={undefined} loading={false} onClose={noop} />,
    );

    expect(screen.getByText('未知')).toBeInTheDocument();
    expect(screen.queryByText('0 B')).toBeNull();
  });

  it('不可用条目照旧打得开：三个事实 + 整句中文原因都在', () => {
    render(
      <SkillDetailDrawer open skill={BAD_SKILL} file={undefined} error={undefined} loading={false} onClose={noop} />,
    );

    expect(screen.getByText(`${ROOT}/broken-skill`)).toBeInTheDocument();
    expect(screen.getByText('这一条现在不可用')).toBeInTheDocument();
    expect(screen.getByText(BAD_SKILL.reason ?? '')).toBeInTheDocument();
  });
});

describe('SkillDetailDrawer：frontmatter 逐字 + 正文 markdown', () => {
  it('frontmatter 逐字进等宽块（含围栏，不解析成字段）', () => {
    render(
      <SkillDetailDrawer open skill={OK_SKILL} file={FILE} error={undefined} loading={false} onClose={noop} />,
    );

    // **逐字**取 textContent 而不是 toHaveTextContent：后者会把换行折成空格，
    // 于是「逐字」这条断言对「把 frontmatter 摊平成一行」的改法照样绿
    expect(screen.getByTestId('skill-frontmatter').textContent).toBe(FILE.frontmatter);
    // 原文里那两行照旧是 `key: value`（**没有**被拆成字段值渲染）
    expect(screen.getByTestId('skill-frontmatter').textContent).toContain('name: tang-poem-meal');
  });

  it('没有 frontmatter 的文件给一句说明，不留一个空块', () => {
    render(
      <SkillDetailDrawer
        open
        skill={OK_SKILL}
        file={{ frontmatter: null, body: '# 正文\n' }}
        error={undefined}
        loading={false}
        onClose={noop}
      />,
    );

    expect(screen.getByText('这个文件没有 frontmatter')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-frontmatter')).toBeNull();
  });

  it('正文渲染成 markdown：粗体成 strong、GFM 表格成表', () => {
    // 抽屉渲染在 portal 里（挂到 `document.body`），`render()` 的 container 里查不到它
    render(<SkillDetailDrawer open skill={OK_SKILL} file={FILE} error={undefined} loading={false} onClose={noop} />);

    // 按元素查而不是 `querySelector('strong')`：抽屉顶部的事实里也有 strong（名称那一格），
    // 全局取第一个会取到它，这条断言就变成在验事实而不是在验 markdown
    expect(screen.getByText('只推荐一首').tagName).toBe('STRONG');
    expect(screen.getByRole('columnheader', { name: '项' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
  });

  it('原始 HTML 只当文本：不生成 img 元素，但写的内容看得见', () => {
    render(<SkillDetailDrawer open skill={OK_SKILL} file={FILE} error={undefined} loading={false} onClose={noop} />);

    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src="x" onerror="alert(1)">');
  });

  it('**没有**「看原文」切换：渲染的就是同一份文件（frontmatter 已逐字可见）', () => {
    render(
      <SkillDetailDrawer open skill={OK_SKILL} file={FILE} error={undefined} loading={false} onClose={noop} />,
    );

    expect(screen.queryByRole('button', { name: /看原文|原文/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('SkillDetailDrawer：三态', () => {
  it('读取中给骨架屏，正文与错误都不出现', () => {
    render(
      <SkillDetailDrawer open skill={OK_SKILL} file={undefined} error={undefined} loading onClose={noop} />,
    );

    expect(document.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByText('SKILL.md 读取失败')).toBeNull();
    expect(screen.queryByTestId('skill-frontmatter')).toBeNull();
  });

  it('读失败说清是哪一步失败 + 服务端的中文原因（不冒充「没有正文」）', () => {
    render(
      <SkillDetailDrawer
        open
        skill={BAD_SKILL}
        file={undefined}
        error={new ServiceError('NOT_FOUND', `这条技能里没有 SKILL.md：${ROOT}/broken-skill/SKILL.md`)}
        loading={false}
        onClose={noop}
      />,
    );

    expect(screen.getByText('SKILL.md 读取失败')).toBeInTheDocument();
    expect(screen.getByText(`这条技能里没有 SKILL.md：${ROOT}/broken-skill/SKILL.md`)).toBeInTheDocument();
  });
});

describe('SkillDetailDrawer：没选中时不渲染正文', () => {
  it('skill 为 null ⇒ 只有抽屉壳，没有任何事实或正文', () => {
    render(
      <SkillDetailDrawer open skill={null} file={FILE} error={undefined} loading={false} onClose={vi.fn()} />,
    );

    expect(screen.queryByTestId('skill-detail-drawer')).toBeNull();
    expect(screen.queryByTestId('skill-frontmatter')).toBeNull();
  });
});
