/**
 * 全局命令面板：⌘K / Ctrl-K 唤起、Esc 关闭并把焦点还回去、↑↓ + Enter 执行、输入过滤。
 *
 * 键盘语义全部钉在这一层（ui 包只收数据与 `onSelect`，不依赖路由与接口）：
 * 应用侧只负责「喂哪些条目」和「选中后跳哪」。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { CommandPalette, type CommandPaletteEntry, type CommandPaletteGroup } from './command-palette';
import { installResizeObserverStub } from '../testing/resize-observer';

// cmdk 的列表在 effect 里 `new ResizeObserver`（jsdom 没有），不装桩挂载即抛
installResizeObserverStub();
// jsdom 不实现 `scrollIntoView`，cmdk 在选中项变化时用它把高亮项滚进视野（与产品行为无关的缺口）
Element.prototype.scrollIntoView = () => {};

const GROUPS: CommandPaletteGroup[] = [
  {
    heading: '导航',
    items: [
      { id: 'nav-runs', label: '评测', href: '/runs' },
      { id: 'nav-cases', label: '用例', href: '/cases' },
      { id: 'nav-settings', label: '设置', href: '/settings' },
    ],
  },
  {
    heading: '用例',
    items: [{ id: 'case-1', label: '登录页改造', href: '/cases?panel=detail&id=c1', hint: 'acme/web' }],
  },
];

/** 唤起前的焦点落点：面板关闭后必须回到它身上 */
function Harness({ onSelect }: { onSelect: (entry: CommandPaletteEntry) => void }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <>
      <textarea aria-label="提示词" />
      <CommandPalette open={open} onOpenChange={setOpen} groups={GROUPS} onSelect={onSelect} />
    </>
  );
}

/** 焦点落在 textarea 里、用组合键唤起，返回那个 textarea（焦点归位的锚点） */
function openFromTextarea(): HTMLTextAreaElement {
  const textarea = screen.getByLabelText<HTMLTextAreaElement>('提示词');
  textarea.focus();
  // 焦点在 textarea 里也必须唤得起来：全局监听在捕获阶段收，不被输入控件的按键吃掉
  fireEvent.keyDown(textarea, { key: 'k', metaKey: true });
  return textarea;
}

describe('CommandPalette', () => {
  it('⌘K 唤起；焦点在 textarea 里也唤得起（Ctrl-K 同理）', async () => {
    render(<Harness onSelect={vi.fn()} />);
    expect(screen.queryByRole('combobox')).toBeNull();

    openFromTextarea();
    const input = screen.getByRole('combobox');
    expect(input).toBeInTheDocument();
    // 唤起后焦点落在输入框：接着就能打字过滤，不用再点一下
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('Esc 关闭，并把焦点还给唤起前的元素（textarea 里的输入位置不丢）', async () => {
    render(<Harness onSelect={vi.fn()} />);
    const textarea = openFromTextarea();
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
    // 面板是「借焦点」：关掉后必须回到原处，否则从长表单里唤起一次就丢了输入位置
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('↑↓ 移动高亮、Enter 执行当前项；执行后关闭面板', async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    openFromTextarea();

    const input = screen.getByRole('combobox');
    const options = (): HTMLElement[] => screen.getAllByRole('option');
    await waitFor(() => expect(options()).toHaveLength(4));
    // 打开即高亮第一条：直接回车就是「最常见的那个目标」，不用先按一下方向键
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ href: '/cases' }));
    await waitFor(() => expect(screen.queryByRole('combobox')).toBeNull());
  });

  it('输入两个字母就能按关键词过滤（hint 里的仓库名也参与匹配）', async () => {
    render(<Harness onSelect={vi.fn()} />);
    openFromTextarea();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ac' } });

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option')).toHaveTextContent('登录页改造');
  });

  it('Ctrl-K 与 ⌘K 是同一条路径', () => {
    render(<Harness onSelect={vi.fn()} />);
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('提示词');
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
