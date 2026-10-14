/**
 * `XFolder` 壳：契约形状 → X 的形状、预览标题栏、**受控选中**。
 *
 * 这一条钉的是三个容易判断错的机制：
 *   1. X 的 `DirectoryTree` 自己逐层拼完整路径（它的 `buildPathSegments` 累积父段）——
 *      所以 `treeData` 每层的 `path` 给**叶子名**就够，`onSelectedFileChange` 回来的是**拼好的
 *      路径段数组**；把 `path` 写成完整路径会拼成 `reference/reference/API.md`；
 *   2. 树节点的 `title` 也放**叶子名**：缩进已经表达了层级，再带父目录前缀就是重复
 *      ——**完整相对路径在预览区标题栏那一格**；
 *   3. 标题栏的复制按钮复制的是**我们给的 `copyText`**：不能靠 X 的默认那一栏
 *      （它的复制源是 `fileContentService`，本仓不走那条路 ⇒ 只会复制一句占位文案）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { SkillTreeNode } from '@aieval/contracts';
import { installResizeObserverStub } from '../testing/resize-observer';
import { XFolder } from './x-folder';

// jsdom 没有 ResizeObserver，而 X 的 Folder 内部用 antd 的 Splitter
beforeEach(() => {
  installResizeObserverStub();
});

/** 技能目录的**内容**（调用方已经剥掉技能名那一层）：`title` / `path` 都是叶子名 */
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

function renderFolder(overrides: Partial<Parameters<typeof XFolder>[0]> = {}): ReturnType<typeof render> {
  return render(
    <XFolder nodes={NODES} selectedPath={null} onSelectPath={vi.fn()} preview={<span>预览</span>} {...overrides} />,
  );
}

describe('XFolder：树节点只显示这一层', () => {
  it('节点标题是**叶子名**（不带父目录前缀：缩进已经表达了层级）', () => {
    renderFolder();

    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
    expect(screen.getByText('reference')).toBeInTheDocument();
    expect(screen.getByText('API.md')).toBeInTheDocument();
    // `reference/API.md` 这种「父目录 + 自己」的写法在树里就是重复
    expect(screen.queryByText('reference/API.md')).toBeNull();
  });

  it('不传 title ⇒ 不渲染左树标题（那一栏上下都是内容，多一行只是噪声）', () => {
    const { container } = renderFolder();

    expect(container.querySelector('.ant-folder-directory-tree-title')).toBeNull();
  });

  it('传了 title ⇒ 渲染出来（「没列全」这类交代就挂在这里）', () => {
    const { container } = renderFolder({ title: <span>这个目录没列全</span> });

    expect(screen.getByText('这个目录没列全')).toBeInTheDocument();
    expect(container.querySelector('.ant-folder-directory-tree-title')).not.toBeNull();
  });
});

describe('XFolder：预览标题栏', () => {
  it('给了 previewTitle ⇒ 文件名（完整相对路径）与复制按钮都在场', () => {
    renderFolder({
      selectedPath: ['reference', 'API.md'],
      previewTitle: { fileName: 'reference/API.md', copyText: '# API\n' },
    });

    expect(document.querySelector('.ant-folder-preview-title-wrapper'), '标题栏没渲染').not.toBeNull();
    expect(screen.getByText('reference/API.md')).toBeInTheDocument();
    expect(document.querySelector('.ant-actions-copy-copy'), '复制按钮没渲染').not.toBeNull();
  });

  it('不给 previewTitle ⇒ 不渲染标题栏', () => {
    renderFolder({ selectedPath: ['reference', 'API.md'] });

    expect(document.querySelector('.ant-folder-preview-title-wrapper')).toBeNull();
  });

  /**
   * 这一条是「不用 X 默认标题栏」的**理由**本身：默认那栏的复制源是 `fileContentService`
   * 取到的内容，本仓不走那条路 ⇒ 它会复制一句占位文案。判据只能落在这里：
   * `copyText` 不进 DOM（它在 antd `Typography.Text copyable` 的 props 里），
   * 所以读按钮的类名看不出对错——要**真的点一次**再看剪贴板收到了什么。
   */
  it('复制按钮复制的是我们给的 copyText（点一次看剪贴板）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderFolder({
      selectedPath: ['reference', 'API.md'],
      previewTitle: { fileName: 'reference/API.md', copyText: '# API\n' },
    });

    document.querySelector<HTMLButtonElement>('.ant-actions-copy-copy')?.click();

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# API\n'));
  });
});

describe('XFolder：叶子名进去、路径段出来', () => {
  it('点一个**深层**文件：回调收到拼好的路径段数组（X 自己拼，壳不拼）', () => {
    const onSelectPath = vi.fn();
    renderFolder({ onSelectPath });

    screen.getByText('API.md').click();

    expect(onSelectPath).toHaveBeenCalledWith(['reference', 'API.md']);
  });

  it('选中是受控的：`selectedPath` 指到哪个文件，哪个节点就是选中态', () => {
    const { container } = renderFolder({ selectedPath: ['reference', 'API.md'] });

    const selected = container.querySelectorAll('.ant-tree-node-selected');
    expect(selected.length).toBe(1);
    expect(selected[0]?.textContent).toContain('API.md');
  });

  it('selectedPath 为 null 时没有任何选中态（不残留上一次的选择）', () => {
    const { container } = renderFolder({ selectedPath: null });

    expect(container.querySelectorAll('.ant-tree-node-selected').length).toBe(0);
  });
});
