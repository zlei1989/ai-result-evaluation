/**
 * SkillDetailDrawer：顶部两个只读事实、左树右预览、正文渲染成 markdown、原始 HTML 只当文本、
 * 树与正文各自的错误态、不可用条目照旧打得开。
 *
 * 为什么这些断言落在抽屉这一层而不是只留在 markdown 外壳自己的用例里：`SKILL.md` 是**外部输入**
 * （可能随被测仓库克隆进来），「原始 HTML 转义成文本」这条安全口径要在真实消费方这里再钉一次
 * ——将来有人图省事把外壳里那条恒开的转义改成 prop 并关掉，壳那一处不会红，这一处会。
 *
 * 「frontmatter 包成 yaml 代码块之后还长不长出标题」同样只有在这一层量得到：纯函数
 * （`skill-preview-markdown.test.ts`）只钉字符串，标题是渲染器读完之后才有的东西。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceError, type SkillEntry, type SkillFileText, type SkillTree } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { SkillDetailDrawer } from './skill-detail-drawer';

// jsdom 没有 ResizeObserver，而 antd 的 Drawer / Splitter 内部都会直接 new 它
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
};

const BAD_SKILL: SkillEntry = {
  name: 'broken-skill',
  dir: `${ROOT}/broken-skill`,
  description: '',
  ok: false,
  reason: '缺 SKILL.md（技能是一个目录，里面放 SKILL.md；只扫这一层，不递归）',
  disabled: false,
};

/** 一棵两级树：`reference/API.md` 与 `SKILL.md`；`path` 都是**叶子名**（全路径由 X 的树自己拼） */
const TREE: SkillTree = {
  name: 'tang-poem-meal',
  dir: `${ROOT}/tang-poem-meal`,
  root: {
    title: 'tang-poem-meal',
    path: 'tang-poem-meal',
    isDirectory: true,
    children: [
      {
        title: 'reference',
        path: 'reference',
        isDirectory: true,
        children: [{ title: 'API.md', path: 'API.md', isDirectory: false, children: [], sizeBytes: 12 }],
        sizeBytes: null,
      },
      { title: 'SKILL.md', path: 'SKILL.md', isDirectory: false, children: [], sizeBytes: 2048 },
    ],
    sizeBytes: null,
  },
  truncated: false,
};

const FILE: SkillFileText = {
  path: 'SKILL.md',
  text: [
    '---',
    'name: tang-poem-meal',
    'description: 推荐唐诗',
    '---',
    '',
    '## 规则',
    '',
    '**只推荐一首**与吃饭有关的唐诗。',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 首数 | 1 |',
    '',
    '调用链路见 [行云平台](https://example.com/doc)：',
    '',
    '```text',
    'POST /api/open/query-file-change-log',
    '  OpenController.queryFileChangeLogs   (lc-web:45)',
    '```',
    '',
    '<img src="x" onerror="alert(1)">',
    '',
  ].join('\n'),
};

const noop = (): void => {};

/** 一份「都齐了」的 props：用例只覆盖自己关心的那几格 */
function propsOf(
  overrides: Partial<Parameters<typeof SkillDetailDrawer>[0]> = {},
): Parameters<typeof SkillDetailDrawer>[0] {
  return {
    open: true,
    skill: OK_SKILL,
    tree: TREE,
    treeError: undefined,
    treeLoading: false,
    onRetryTree: noop,
    // 技能内相对路径（树从技能目录的内容开始、不含技能名那一层，所以两边同形）
    selectedPath: 'SKILL.md',
    onSelectPath: noop,
    file: FILE,
    fileError: undefined,
    fileLoading: false,
    onClose: noop,
    ...overrides,
  };
}

describe('SkillDetailDrawer：标题与左树', () => {
  it('这一条的名字只在抽屉标题上；绝对路径不摆（顶部不留事实块）', () => {
    render(<SkillDetailDrawer {...propsOf()} />);

    expect(screen.getByText('技能：tang-poem-meal')).toBeInTheDocument();
    // 路径那一格是刻意删掉的：它在树里逐层可见，顶部再摆一遍只是噪声
    expect(screen.queryByText(`${ROOT}/tang-poem-meal`)).toBeNull();
    expect(screen.queryByText('名称')).toBeNull();
  });

  it('树从技能目录的内容开始，节点只显示这一层（不带父目录前缀）', () => {
    // `selectedPath: null` ⇒ 标题栏不渲染，这一条只判树（否则 `SKILL.md` 在树与标题栏各出现一次）
    render(<SkillDetailDrawer {...propsOf({ selectedPath: null, file: undefined })} />);

    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
    expect(screen.getByText('reference')).toBeInTheDocument();
    // 树里只显示叶子名：缩进下面再写一遍 `reference/` 就是重复
    expect(screen.getByText('API.md')).toBeInTheDocument();
    expect(screen.queryByText('reference/API.md')).toBeNull();
  });

  it('预览标题栏给**完整相对路径**（同名文件靠这里分）+ 复制按钮', () => {
    render(<SkillDetailDrawer {...propsOf({ selectedPath: 'reference/API.md' })} />);

    expect(document.querySelector('.ant-folder-preview-title-wrapper'), '标题栏没渲染').not.toBeNull();
    expect(screen.getByText('reference/API.md')).toBeInTheDocument();
    expect(document.querySelector('.ant-actions-copy-copy'), '复制按钮没渲染').not.toBeNull();
  });

  it('点树里的文件：交出去的就是**技能内相对路径**（不含技能名，多一段就是 404）', () => {
    const onSelectPath = vi.fn();
    // 同上：标题栏不渲染，保证点到的是树里那个节点
    render(<SkillDetailDrawer {...propsOf({ onSelectPath, selectedPath: null, file: undefined })} />);

    screen.getByText('API.md').click();

    // 多带一段技能名的话，请求会拼成 `<技能根>/tang-poem-meal/reference/API.md` ⇒ 一路 404，
    // 而界面上只显示「这个文件读不出来」，看不出是多了一层
    expect(onSelectPath).toHaveBeenCalledWith('reference/API.md');
  });

  it('技能内路径与树的层级一一对应，所以选中态落在对的那个节点上', () => {
    render(<SkillDetailDrawer {...propsOf({ selectedPath: 'reference/API.md', file: undefined })} />);

    // 抽屉渲染在 portal 里（挂到 `document.body`），`render()` 的 container 里查不到它
    const selected = document.querySelectorAll('.ant-tree-node-selected');
    expect(selected.length).toBe(1);
    expect(selected[0]?.textContent).toContain('API.md');
  });

  it('没列全时明说「这个目录没列全」（不静默少列）', () => {
    render(<SkillDetailDrawer {...propsOf({ tree: { ...TREE, truncated: true } })} />);

    expect(screen.getByText('这个目录没列全')).toBeInTheDocument();
  });

  it('没选中文件时右侧是空态（不是空正文）', () => {
    render(<SkillDetailDrawer {...propsOf({ selectedPath: null, file: undefined })} />);

    expect(screen.getByText('还没选中文件')).toBeInTheDocument();
    expect(document.querySelector('.x-markdown')).toBeNull();
  });

  it('不可用条目照旧打得开：整句中文原因在场', () => {
    render(
      <SkillDetailDrawer
        {...propsOf({ skill: BAD_SKILL, tree: undefined, selectedPath: null, file: undefined })}
      />,
    );

    expect(screen.getByText('这一条现在不可用')).toBeInTheDocument();
    expect(screen.getByText(BAD_SKILL.reason ?? '')).toBeInTheDocument();
  });
});

describe('SkillDetailDrawer：三态', () => {
  it('树读取中给骨架屏，不出树也不出错误', () => {
    render(<SkillDetailDrawer {...propsOf({ tree: undefined, treeLoading: true })} />);

    expect(document.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByText('技能目录读取失败')).toBeNull();
    expect(screen.queryByText('SKILL.md')).toBeNull();
  });

  it('树读失败：一句中文原因 + 一次重试（树与预览一起换错误态）', () => {
    const onRetryTree = vi.fn();
    render(
      <SkillDetailDrawer
        {...propsOf({
          tree: undefined,
          treeError: new ServiceError('INTERNAL', '读取技能目录失败：/x/skills/broken（EACCES）'),
          onRetryTree,
        })}
      />,
    );

    expect(screen.getByText('技能目录读取失败')).toBeInTheDocument();
    expect(screen.getByText('读取技能目录失败：/x/skills/broken（EACCES）')).toBeInTheDocument();

    screen.getByRole('button', { name: '重试' }).click();
    expect(onRetryTree).toHaveBeenCalledTimes(1);
  });

  it('正文读取中给骨架屏；读失败说清是哪一步失败 + 服务端的中文原因', () => {
    const { unmount } = render(<SkillDetailDrawer {...propsOf({ file: undefined, fileLoading: true })} />);
    expect(document.querySelector('.ant-skeleton')).not.toBeNull();
    unmount();

    render(
      <SkillDetailDrawer
        {...propsOf({
          file: undefined,
          fileError: new ServiceError('INVALID_QUERY', '这一类文件不预览（二进制 / 非 UTF-8，3 B）：blob.bin'),
        })}
      />,
    );

    expect(screen.getByText('这个文件读不出来')).toBeInTheDocument();
    expect(screen.getByText('这一类文件不预览（二进制 / 非 UTF-8，3 B）：blob.bin')).toBeInTheDocument();
  });
});

describe('SkillDetailDrawer：正文 markdown', () => {
  /**
   * 夹具的 `SKILL.md` 首个候选就是 `---`：不包围栏时，收尾那条 `---` 会命中 CommonMark 的 setext
   * 下划线规则，把 `name:` / `description:` 两行吃成 `<h2>`（本仓降级成 5 级 `Title`）——
   * 一份 YAML 变成页面里最大的一行字。这条判据要能在真实消费方这里红。
   */
  it('frontmatter 整段落在 yaml 代码块里，不长成标题', () => {
    render(<SkillDetailDrawer {...propsOf()} />);

    expect(screen.queryByRole('heading', { name: /name: tang-poem-meal/ })).toBeNull();

    const body = document.querySelector('.x-markdown');
    // 正文里另有一个 ```text 围栏，故按内容认：这一条钉的是**第一块**代码
    expect(body?.querySelector('pre code')?.textContent).toContain(
      '---\nname: tang-poem-meal\ndescription: 推荐唐诗\n---',
    );
  });

  it('正文渲染成 markdown：粗体成 strong、GFM 表格成表', () => {
    render(<SkillDetailDrawer {...propsOf()} />);

    // 从正文根往下查而不是全局取第一个：抽屉顶部与左树都有元素，全局取会取错
    const body = document.querySelector('.x-markdown');
    expect(body, '正文没有交给 XMarkdown 渲染').not.toBeNull();
    expect(body?.querySelector('strong')?.textContent).toBe('只推荐一首');
    expect(screen.getByRole('columnheader', { name: '项' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
  });

  /**
   * 三条排版口径由共享渲染器承担（消费方只递文本）：围栏不折行、外链挡 opener、标题降两级。
   * `white-space` 的**计算样式**只能真机量（jsdom 没有 CSS 级联），这里钉的是内联那一条声明——
   * X 的默认样式写的是 `pre-wrap`，内联这条是唯一能盖住它的地方。
   */
  it('复刻三条口径：围栏不折行 / 外链新标签且带 noreferrer / 标题降两级', () => {
    render(<SkillDetailDrawer {...propsOf()} />);

    const body = document.querySelector('.x-markdown');
    // 正文里两块围栏（frontmatter 的 yaml 块 + 夹具那个 text 块），按内容认，不靠顺序
    const pre = Array.from(body?.querySelectorAll('pre') ?? []).find((node) =>
      node.textContent?.includes('OpenController'),
    );
    expect(pre, '找不到正文那个围栏代码块').not.toBeUndefined();
    expect(pre?.style.whiteSpace, '围栏代码块被折行：链路图的前导空格对齐会散掉').toBe('pre');
    expect(pre?.style.overflowX, '超宽时没有横向滚动').toBe('auto');
    // 内层 `code` 也要盖章：X 的 CSS 给 `pre` **与** `code` 都写了 `pre-wrap`，只盖 `pre` 时
    // 文字在块级 `code` 那一层就折了、`pre` 永远滚不出来（jsdom 没有级联，这条只能钉内联声明）
    expect(pre?.querySelector('code')?.style.whiteSpace, '围栏里的 code 仍在折行').toBe('pre');
    // 前导空格逐字保留：链路图靠它对齐
    expect(pre?.textContent).toContain('  OpenController.queryFileChangeLogs   (lc-web:45)');

    const link = body?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/doc');
    expect(link?.getAttribute('target'), '外链没有新标签打开').toBe('_blank');
    expect(link?.getAttribute('rel'), '外链没有挡掉 window.opener').toContain('noreferrer');

    // 标题降两级：h2 落到 antd `Title` 的 5 级，正文里不长出页面级 h1
    expect(screen.getByRole('heading', { level: 5, name: '规则' })).toBeInTheDocument();
    expect(body?.querySelector('h1')).toBeNull();
  });

  it('原始 HTML 只当文本：不生成 img 元素，但写的内容看得见', () => {
    render(<SkillDetailDrawer {...propsOf()} />);

    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src="x" onerror="alert(1)">');
  });

  it('**没有**「看原文」切换：渲染的就是同一份文件（frontmatter 也在这份渲染里，只是包成了代码块）', () => {
    render(<SkillDetailDrawer {...propsOf()} />);

    expect(screen.queryByRole('button', { name: /看原文|原文/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('SkillDetailDrawer：没选中时不渲染正文', () => {
  it('skill 为 null ⇒ 只有抽屉壳，没有任何事实或正文', () => {
    render(
      <SkillDetailDrawer {...propsOf({ skill: null, tree: undefined, selectedPath: null, file: undefined })} />,
    );

    expect(screen.queryByTestId('skill-detail-drawer')).toBeNull();
  });
});
