/**
 * `LogNodeBreadcrumb`（L1）的守卫。四条：
 *   1. **链是派生的**：换 `activeNodeId` 就换链，段顺序 = 根 → 当前；
 *   2. **当前段不可点**：`aria-current="page"`，且它不带下拉；
 *   3. **下拉列的是同层兄弟**（不是全树），当前项 `disabled`；
 *   4. **`kind === 'row'` 的节点不进链**（点进去只有一个空会话）。
 *
 * 下拉的断言直接打在导出的 `breadcrumbItems` 上：浮层要靠 hover 才出现，
 * 用 DOM 去测既慢又脆，而「菜单里列了谁」本来就是一份纯数据。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LogNode, RowNode, SessionNode } from './types';
import {
  LogNodeBreadcrumb,
  breadcrumbItems,
  nodeChain,
  nodeDisplayName,
  type BreadcrumbSegment,
} from './log-node-breadcrumb';

/** 下拉项只有两格值得断言：这一项是谁、它是不是当前段（禁用）。 */
function menuOf(items: readonly BreadcrumbSegment[], index: number): { key: string; disabled: boolean }[] {
  return (items[index]?.siblings ?? []).map((sibling) => ({
    key: sibling.key,
    disabled: sibling.disabled,
  }));
}

/** 会话节点：只给本用例关心的几格，其余按「都没有」补齐 */
function sessionNode(overrides: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    kind: 'subagent',
    parentId: null,
    spawnedBy: null,
    status: 'completed',
    statusMissing: null,
    startedAt: null,
    endedAt: null,
    content: { status: 'ready', data: [] },
    contentTruncatedReason: null,
    capability: {},
    capabilityNotes: [],
    source: 'wire',
    subagentId: null,
    vendorId: null,
    dispatchKind: null,
    name: null,
    nameMissing: null,
    userPrompt: null,
    usage: null,
    outcome: null,
    sessionFacts: null,
    ...overrides,
  };
}

/** 行级汇总节点（`kind === 'row'`）：不进面包屑的那一档 */
function rowNode(id: string, parentId: string | null = null): RowNode {
  return {
    kind: 'row',
    id,
    parentId,
    spawnedBy: null,
    status: 'completed',
    statusMissing: null,
    startedAt: null,
    endedAt: null,
    content: { status: 'ready', data: [] },
    contentTruncatedReason: null,
    capability: {},
    capabilityNotes: [],
    counts: null,
    facts: {
      status: { tone: 'ok', label: '已完成' },
      startedAt: null,
      endedAt: null,
      turns: { current: 0, total: 0 },
      tokens: null,
      thinking: null,
      domain: [],
      error: null,
      contextUsed: null,
      contextWindow: null,
    },
  };
}

const MAIN = sessionNode({ id: 'main', kind: 'main', name: null });
const SUB_A = sessionNode({ id: 'sub-a', parentId: 'main', subagentId: 'agent-9c1f2b44', name: '整理变更清单' });
const SUB_B = sessionNode({ id: 'sub-b', parentId: 'main', subagentId: 'agent-deadbeef', name: null });
const SUB_A1 = sessionNode({ id: 'sub-a1', parentId: 'sub-a', subagentId: 'agent-11112222', name: '跑全量测试' });
const ROW = rowNode('row-1', 'main');

const NODES: LogNode[] = [MAIN, SUB_A, SUB_B, SUB_A1, ROW];

describe('LogNodeBreadcrumb', () => {
  it('链由 parentId 回溯派生：换 activeNodeId 就换链，顺序是根 → 当前', () => {
    expect(nodeChain(NODES, 'sub-a1').map((node) => node.id)).toEqual(['main', 'sub-a', 'sub-a1']);
    expect(nodeChain(NODES, 'sub-b').map((node) => node.id)).toEqual(['main', 'sub-b']);
    expect(nodeChain(NODES, 'main').map((node) => node.id)).toEqual(['main']);
  });

  it('段数与顺序：主会话 / A / A1 三段，当前段带 aria-current 且加粗', () => {
    render(<LogNodeBreadcrumb nodes={NODES} activeNodeId="sub-a1" onSelect={vi.fn()} />);

    const host = screen.getByTestId('log-node-breadcrumb');
    const labels = [...host.querySelectorAll('[data-segment]')].map((segment) => segment.textContent);
    expect(labels).toEqual(['主会话', '整理变更清单', '跑全量测试']);

    // 当前段是带 `aria-current` 的纯文本，不可点、也不带下拉
    const current = screen.getByText('跑全量测试');
    const marked = current.closest('[aria-current="page"]');
    expect(marked).not.toBeNull();
    expect(marked).toHaveTextContent('跑全量测试');
    expect(current.closest('[data-slot="dropdown-menu-trigger"]')).toBeNull();
    expect(current.tagName).not.toBe('BUTTON');
  });

  it('换 activeNodeId 即换链（同一份 nodes，不存第二份真值）', () => {
    const { rerender } = render(<LogNodeBreadcrumb nodes={NODES} activeNodeId="sub-a" onSelect={vi.fn()} />);
    expect(screen.getByText('整理变更清单').closest('[aria-current="page"]')).not.toBeNull();

    rerender(<LogNodeBreadcrumb nodes={NODES} activeNodeId="sub-b" onSelect={vi.fn()} />);
    expect(screen.getByText('子任务 agent-de').closest('[aria-current="page"]')).not.toBeNull();
    expect(screen.queryByText('跑全量测试')).toBeNull();
  });

  it('下拉列的是**这一段所在层级**的兄弟；同层只有一个时不给下拉、整段可点回退', () => {
    const items = breadcrumbItems(NODES, 'sub-a1', vi.fn()) ?? [];
    // 第一段（主会话）：根层只有它自己 ⇒ **不给下拉**，整段自己就是回退入口（点了回 main）
    expect(menuOf(items, 0)).toEqual([]);
    // 第二段（sub-a）的同层有 sub-a / sub-b ⇒ 给下拉，本段自己在菜单里 disabled
    expect(menuOf(items, 1)).toEqual([
      { key: 'sub-a', disabled: true },
      { key: 'sub-b', disabled: false },
    ]);
  });

  it('**站在子任务上点主会话那一段就回得去**', () => {
    const onSelect = vi.fn();
    render(<LogNodeBreadcrumb nodes={NODES} activeNodeId="sub-a1" onSelect={onSelect} />);

    // 主会话那一段必须是**可交互的**：要么整段可点（同层只有一个），要么下拉里有可用项。
    // 修复前它必然落到「下拉里只有一个 disabled 的自己」⇒ 抽屉上根本没有回退入口。
    const mainSegment = screen.getByText('主会话');
    const clickable =
      mainSegment.tagName === 'BUTTON' || mainSegment.closest('[data-slot="dropdown-menu-trigger"]') !== null;
    expect(clickable, '主会话那一段既没有下拉也没有点击入口（回不去主会话）').toBe(true);

    // 直接点它：必须把 `main` 交回去
    mainSegment.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('main');
  });

  it('同一份形状对**两层以上的链**同样成立（A 段回到 A、主会话段回到 main）', () => {
    const onSelect = vi.fn();
    const items = breadcrumbItems(NODES, 'sub-a1', onSelect) ?? [];
    // 链是 main / sub-a / sub-a1：最后一段不可点，前两段各有一条回退路径
    expect(items).toHaveLength(3);
    expect(menuOf(items, 0)).toEqual([]); // main：同层只有它自己 ⇒ 整段可点
    expect(menuOf(items, 1)).toHaveLength(2); // sub-a：有兄弟 ⇒ 下拉
    expect(items[2]?.siblings).toBeUndefined(); // 当前段：不给菜单
  });

  it('点下拉项把节点 id 交回去', () => {
    const onSelect = vi.fn();
    const items = breadcrumbItems(NODES, 'sub-a1', onSelect) ?? [];
    const target = items[1]?.siblings?.find((sibling) => sibling.key === 'sub-b');

    target?.onSelect();

    expect(onSelect).toHaveBeenCalledWith('sub-b');
  });

  it('任务名为 null 时用 subagentId / 节点 id 前 8 位兜底（不显示空白）', () => {
    expect(nodeDisplayName(SUB_B)).toBe('子任务 agent-de');
    expect(nodeDisplayName(sessionNode({ id: 'abcdefgh1234', name: null, subagentId: null }))).toBe('子任务 abcdefgh');
    expect(nodeDisplayName(MAIN)).toBe('主会话');
  });

  it('kind === row 的节点不进链、也不进同层菜单', () => {
    // 链：row-1 自己也在 nodes 里，但它不进链 ⇒ 以它为当前节点时面包屑整个不渲染
    const { container } = render(<LogNodeBreadcrumb nodes={NODES} activeNodeId="row-1" onSelect={vi.fn()} />);
    expect(container.querySelector('[data-testid="log-node-breadcrumb"]')).toBeNull();

    // 主会话层的菜单里也没有它：根层只有主会话自己 ⇒ 不给下拉（整段可点），故这里断言的是
    // 「row 节点没有让主会话那一段多出一个下拉项」
    const items = breadcrumbItems(NODES, 'sub-a', vi.fn()) ?? [];
    expect(menuOf(items, 0)).toEqual([]);
  });
});
