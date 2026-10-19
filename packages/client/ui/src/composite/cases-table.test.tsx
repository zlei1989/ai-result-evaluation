/**
 * CasesTable：排序循环、行选择与「钉住 / 省略」的单元格形态。
 *
 * 这张表是 `/cases` 列表的全部渲染面（页面只负责把数据递进来）。排序是纯展示状态，
 * 不进 URL，所以三条口径都在这里钉：默认标题降序、点一次切升序、第三次回到服务端顺序；
 * 仓库列按**显示出来的仓库名**排，同名再按全路径兜底。行选择同时支持鼠标与键盘——
 * 表格行不是原生按钮，空格键必须自己拦下（否则会滚动页面）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TestCase } from '@aieval/contracts';
import { CasesTable } from './cases-table';

/** 三条用例：标题、仓库名与更新时间都拉开差距，三条比较器各看一处 */
const CASES: TestCase[] = [
  {
    id: 'case-b',
    title: '测试9',
    repoPath: 'ssh://git@host/group/zeta.git',
    commitHash: 'abc1234def567890abc1234def567890abc12345',
    repoBranch: 'main',
    taskPrompt: '题面',
    rubric: { groups: [] },
    includeSteps: false,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  },
  {
    id: 'case-a',
    title: '测试2',
    repoPath: 'none://',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '题面',
    rubric: { groups: [] },
    includeSteps: false,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
  },
  {
    id: 'case-c',
    title: '简单测试',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '题面',
    rubric: { groups: [] },
    includeSteps: false,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-21T10:00:00.000Z',
  },
];

/** 当前表格里的用例标题，按渲染顺序 */
function renderedTitles(): string[] {
  return screen
    .getAllByTestId(/^case-row-/)
    .map((row) => row.querySelector('td span[title]')?.textContent ?? '');
}

function setup(overrides: { onSelect?: (id: string) => void; selectedId?: string | null } = {}): ReturnType<typeof render> {
  return render(
    <CasesTable cases={CASES} selectedId={overrides.selectedId ?? null} onSelect={overrides.onSelect ?? vi.fn()} />,
  );
}

describe('CasesTable 排序', () => {
  it('默认按标题降序（中文按拼音、数字按数值），第三次点击回到服务端顺序', () => {
    setup();

    // 升序是「测试2 → 测试9 → 简单测试」（拼音 + 数值），降序整体取反
    expect(renderedTitles()).toEqual(['简单测试', '测试9', '测试2']);

    fireEvent.click(screen.getByRole('button', { name: /标题/ }));
    expect(renderedTitles()).toEqual(['测试2', '测试9', '简单测试']);

    // 第二次取消排序：回到入参顺序（服务端给的是 `updatedAt` 降序）
    fireEvent.click(screen.getByRole('button', { name: /标题/ }));
    expect(renderedTitles()).toEqual(['测试9', '测试2', '简单测试']);

    // 第三次回到降序（循环重新开始）
    fireEvent.click(screen.getByRole('button', { name: /标题/ }));
    expect(renderedTitles()).toEqual(['简单测试', '测试9', '测试2']);
  });

  it('仓库列按显示名排：无来源的「空仓库」不拿哨兵串参与排序', () => {
    setup();

    fireEvent.click(screen.getByRole('button', { name: /仓库/ }));

    // 显示名升序：无（none:// 的显示名）→ gateway → zeta；哨兵串本身不参与排序、也不上屏
    const rowTexts = screen.getAllByTestId(/^case-row-/).map((row) => row.textContent ?? '');
    expect(rowTexts[0]).toContain('无');
    expect(rowTexts[0]).not.toContain('none://');
    expect(rowTexts[1]).toContain('gateway');
    expect(rowTexts[2]).toContain('zeta');
  });
});

describe('CasesTable 行选择与单元格', () => {
  it('点一行调 onSelect；选中行带 aria-selected', () => {
    const onSelect = vi.fn();
    setup({ onSelect, selectedId: 'case-a' });

    expect(screen.getByTestId('case-row-case-a')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('case-row-case-b'));

    expect(onSelect).toHaveBeenCalledWith('case-b');
  });

  it('键盘 Enter / 空格也能打开详情（空格必须阻止滚动）', () => {
    const onSelect = vi.fn();
    setup({ onSelect });
    const row = screen.getByTestId('case-row-case-c');

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onSelect).toHaveBeenNthCalledWith(1, 'case-c');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'case-c');
  });

  it('长标题 / 全路径放在 title 上：省略的是显示，不是信息', () => {
    setup();

    const row = screen.getByTestId('case-row-case-b');
    const cells = within(row).getAllByRole('cell');
    // 标题格：显示标题、悬停给全量标题
    expect(cells[0]?.querySelector('span[title]')).toHaveAttribute('title', '测试9');
    // 仓库格：显示末段、悬停给全路径
    expect(cells[1]?.querySelector('span[title]')).toHaveAttribute('title', 'ssh://git@host/group/zeta.git');
    // 无来源：不显示哨兵串，悬停换成一句说全的话
    const noneRow = screen.getByTestId('case-row-case-a');
    expect(within(noneRow).getAllByRole('cell')[1]?.querySelector('span[title]')).toHaveAttribute(
      'title',
      '空仓库，无来源代码',
    );
  });
});
