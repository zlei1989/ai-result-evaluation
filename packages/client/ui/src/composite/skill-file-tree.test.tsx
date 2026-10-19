/**
 * 技能树：File Tree pattern（`Collapsible` + `Button` 递归）的用户可见行为。
 *
 * 三条判据分别钉住一件容易「看起来对、实际坏」的事：
 *   1. **目录默认展开**：技能树回答的是「这一条里有什么」，初次打开就要看全；
 *      收起后子节点必须真的离开 DOM（`Collapsible.Panel` 卸载内容），而不是只被 CSS 藏住；
 *   2. **节点标题只显示叶子名**：缩进已经表达层级，再写 `reference/API.md` 就是重复；
 *      完整相对路径只在预览标题栏那一格（同名文件靠它分辨）；
 *   3. **选中文件 → 预览切换**：左树右预览是同一个受控回路——点文件回调路径段，
 *      调用方写回 `selectedPath`，右侧换成那份内容；树里的选中态用 `aria-current` 表达。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { SkillTreeNode } from '@aieval/contracts';
import { SkillFileTree } from './skill-file-tree';

/** 技能目录的内容：`title` / `path` 都是叶子名（契约原样） */
const NODES: SkillTreeNode[] = [
  {
    title: 'reference',
    path: 'reference',
    isDirectory: true,
    children: [{ title: 'API.md', path: 'API.md', isDirectory: false, children: [], sizeBytes: 12 }],
    sizeBytes: null,
  },
  { title: 'SKILL.md', path: 'SKILL.md', isDirectory: false, children: [], sizeBytes: 34 },
];

/** 预览正文按「技能内相对路径」取：模拟真实调用方（正文由它在树外取好递进来） */
const PREVIEWS: Record<string, string> = {
  'reference/API.md': 'API 正文',
  'SKILL.md': '技能正文',
};

/**
 * 受控回路的宿主：点树 → `onSelectPath` → 宿主 state → 右侧预览与选中态。
 * 组件自身不持选中态，联动必须在这一层成立（与 `SkillDetailDrawer` 同形）。
 */
function Harness({ initial = null }: { initial?: string[] | null }): React.ReactNode {
  const [selected, setSelected] = useState<string[] | null>(initial);
  const current = selected?.join('/') ?? '';
  return (
    <SkillFileTree
      nodes={NODES}
      selectedPath={selected}
      onSelectPath={setSelected}
      preview={<span>{PREVIEWS[current] ?? ''}</span>}
      previewTitle={selected === null ? undefined : { fileName: current, copyText: `# ${current}\n` }}
      empty={<span>还没选中文件</span>}
    />
  );
}

describe('SkillFileTree：目录节点的展开与收起', () => {
  it('目录默认展开：子文件初次就在树里', () => {
    render(<Harness />);

    expect(screen.getByText('reference')).toBeInTheDocument();
    expect(screen.getByText('API.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reference' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('点目录收起、再点展开：子文件跟着进出 DOM', () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'reference' });

    fireEvent.click(trigger);
    // 收起后内容卸载（不是只被 CSS 藏住）：再点开时拿到的是一份新挂载的内容
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('API.md')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('API.md')).toBeInTheDocument();
  });
});

describe('SkillFileTree：节点标题只显示这一层', () => {
  it('节点标题是**叶子名**（不带父目录前缀：缩进已经表达了层级）', () => {
    render(<Harness />);

    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
    expect(screen.getByText('reference')).toBeInTheDocument();
    expect(screen.getByText('API.md')).toBeInTheDocument();
    // `reference/API.md` 这种「父目录 + 自己」的写法在树里就是重复
    expect(screen.queryByText('reference/API.md')).toBeNull();
  });

  it('不传 title ⇒ 不渲染左树标题；传了才渲染', () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByTestId('skill-file-tree-title')).toBeNull();
    unmount();

    render(
      <SkillFileTree
        nodes={NODES}
        selectedPath={null}
        onSelectPath={vi.fn()}
        preview={<span>预览</span>}
        title={<span>这个目录没列全</span>}
        empty={<span>还没选中文件</span>}
      />,
    );
    expect(screen.getByText('这个目录没列全')).toBeInTheDocument();
  });
});

describe('SkillFileTree：选中文件 → 预览切换', () => {
  it('点文件：回调收到路径段数组，右侧预览换成那份内容，选中项带 aria-current', () => {
    render(<Harness />);

    // 没选中时右侧是空态
    expect(screen.getByText('还没选中文件')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'API.md' }));
    expect(screen.getByText('API 正文')).toBeInTheDocument();
    expect(screen.queryByText('还没选中文件')).toBeNull();
    expect(screen.getByRole('button', { name: 'API.md' })).toHaveAttribute('aria-current', 'true');

    // 换一个文件：预览内容跟着换（不是叠一份、也不是停在上一次）
    fireEvent.click(screen.getByRole('button', { name: 'SKILL.md' }));
    expect(screen.getByText('技能正文')).toBeInTheDocument();
    expect(screen.queryByText('API 正文')).toBeNull();
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'API.md' })).not.toHaveAttribute('aria-current');
  });

  it('选中是受控的：selectedPath 指到哪个文件，哪个节点就是选中态', () => {
    render(<Harness initial={['reference', 'API.md']} />);

    expect(screen.getByRole('button', { name: 'API.md' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'SKILL.md' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('API 正文')).toBeInTheDocument();
  });
});

describe('SkillFileTree：预览标题栏', () => {
  it('给了 previewTitle ⇒ 完整相对路径与复制按钮都在场（同名文件靠这一格分辨）', () => {
    render(<Harness initial={['reference', 'API.md']} />);

    expect(screen.getByTestId('skill-file-preview-title')).toBeInTheDocument();
    expect(screen.getByText('reference/API.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  });

  it('复制按钮复制的是我们给的 copyText（点一次看剪贴板）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<Harness initial={['reference', 'API.md']} />);

    fireEvent.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# reference/API.md\n'));
  });

  it('不给 previewTitle ⇒ 不渲染标题栏', () => {
    render(
      <SkillFileTree
        nodes={NODES}
        selectedPath={['reference', 'API.md']}
        onSelectPath={vi.fn()}
        preview={<span>预览</span>}
        empty={<span>还没选中文件</span>}
      />,
    );

    expect(screen.queryByTestId('skill-file-preview-title')).toBeNull();
  });
});

/**
 * 搜索：树上方一个输入框，按名字过滤。
 *
 * 过滤最容易做错的是**层级**：只留下命中的文件、把祖先目录一起扔掉，文件就悬空了；
 * 反过来只按「目录里有没有命中」保留目录、却不剪空枝，就会出现满屏空目录。
 * 两条都要单独钉。搜索只改「显示什么」，**不动选中态、不动树外的启停状态**——
 * 那两样是调用方的东西，组件没有资格替它改。
 */
const SEARCH_NODES: SkillTreeNode[] = [
  {
    title: 'docs',
    path: 'docs',
    isDirectory: true,
    sizeBytes: null,
    children: [
      {
        title: 'guide',
        path: 'guide',
        isDirectory: true,
        sizeBytes: null,
        children: [{ title: 'deep.md', path: 'deep.md', isDirectory: false, children: [], sizeBytes: 10 }],
      },
      { title: 'intro.md', path: 'intro.md', isDirectory: false, children: [], sizeBytes: 20 },
    ],
  },
  {
    title: 'reference',
    path: 'reference',
    isDirectory: true,
    sizeBytes: null,
    children: [{ title: 'API.md', path: 'API.md', isDirectory: false, children: [], sizeBytes: 12 }],
  },
  { title: 'SKILL.md', path: 'SKILL.md', isDirectory: false, children: [], sizeBytes: 34 },
];

/**
 * 搜索的宿主：同时持「选中」与「启停」两个树外状态。
 * 启停由调用方管（详情抽屉里那条不可用说明的开关就是它），搜索不该碰它。
 */
function SearchHarness({ onSelect }: { onSelect(segments: string[]): void }): React.ReactNode {
  const [selected, setSelected] = useState<string[] | null>(['reference', 'API.md']);
  const [enabled, setEnabled] = useState(true);
  return (
    <div>
      <span data-testid="skill-enabled">{enabled ? '已启用' : '已停用'}</span>
      <button type="button" onClick={() => setEnabled(false)}>
        停用
      </button>
      <SkillFileTree
        nodes={SEARCH_NODES}
        selectedPath={selected}
        onSelectPath={(segments) => {
          onSelect(segments);
          setSelected(segments);
        }}
        preview={<span>预览</span>}
        empty={<span>还没选中文件</span>}
      />
    </div>
  );
}

function searchFor(keyword: string): void {
  fireEvent.change(screen.getByLabelText('按名字过滤'), { target: { value: keyword } });
}

describe('SkillFileTree：搜索', () => {
  it('按名字过滤：命中深层文件时祖先目录仍在，且没有空目录残留', () => {
    render(<SearchHarness onSelect={vi.fn()} />);

    searchFor('deep');

    // 祖先链 docs → docs/guide 必须在场，否则 deep.md 悬空、看不出它在哪一层
    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deep.md' })).toBeInTheDocument();

    // 一个都没命中的分支整枝剪掉：reference / SKILL.md / intro.md 都不该留下空壳
    expect(screen.queryByRole('button', { name: 'reference' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'API.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'SKILL.md' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'intro.md' })).toBeNull();
  });

  it('命中目录名 ⇒ 保留该目录整棵子树（搜目录是想看它里面有什么）', () => {
    render(<SearchHarness onSelect={vi.fn()} />);

    searchFor('docs');

    expect(screen.getByRole('button', { name: 'docs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deep.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'intro.md' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SKILL.md' })).toBeNull();
  });

  it('搜索不清空选中态、也不改树外的启停状态', () => {
    const onSelect = vi.fn();
    render(<SearchHarness onSelect={onSelect} />);

    // 用户先把技能停用（树外状态），再回来搜文件
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect(screen.getByTestId('skill-enabled')).toHaveTextContent('已停用');

    searchFor('deep');

    // 搜索没有替调用方重新选文件
    expect(onSelect).not.toHaveBeenCalled();
    // 也没有把启停状态重置回去
    expect(screen.getByTestId('skill-enabled')).toHaveTextContent('已停用');
    // 右侧预览仍是原先选中的那份（过滤只改树，不改预览）
    expect(screen.getByText('预览')).toBeInTheDocument();
  });

  it('选中的文件仍在过滤结果里 ⇒ 保持 aria-current', () => {
    render(<SearchHarness onSelect={vi.fn()} />);

    searchFor('API');

    const api = screen.getByRole('button', { name: 'API.md' });
    expect(api).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'reference' })).toBeInTheDocument();
  });

  it('清空搜索 ⇒ 回到完整树（过滤不是破坏性的）', () => {
    render(<SearchHarness onSelect={vi.fn()} />);

    searchFor('deep');
    expect(screen.queryByRole('button', { name: 'SKILL.md' })).toBeNull();

    searchFor('');

    expect(screen.getByRole('button', { name: 'SKILL.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'reference' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'deep.md' })).toBeInTheDocument();
  });

  it('一个都不命中 ⇒ 给一句空态，而不是留一棵空树', () => {
    render(<SearchHarness onSelect={vi.fn()} />);

    searchFor('nope');

    expect(screen.getByText('没有匹配项')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SKILL.md' })).toBeNull();
  });
});
