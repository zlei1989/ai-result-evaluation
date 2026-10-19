'use client';

/**
 * 节点面包屑（L1）：`主会话 / A / B`。
 *
 * 三条口径：
 *   1. **链是派生的**：由 `parentId` 从 `activeNodeId` 回溯到根，不存第二份真值
 *      （存一份就必然与 `nodes` 漂移，而漂移的表现是「点备份的链进了另一个节点」）；
 *   2. **每段一个下拉**，菜单内容 = **该层级的兄弟列表**（不是全树）；当前段不可点、
 *      用 `Typography.Text strong` + `aria-current="page"` 标出来；
 *   3. **`kind === 'row'` 的节点不进链、也不进菜单**：它是「这家只有汇总计数、没有逐个身份」
 *      的那一档，点进去只有一个空会话。
 *
 * 断链（`parentId` 指向不存在的节点）与成环都在这里停住：给出已经能确定的那一段，
 * 而不是抛错或死循环——界面缺一段比整个抽屉白屏可接受得多。
 */
import { ChevronRightIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import type { LogNode } from './types';

export interface LogNodeBreadcrumbProps {
  nodes: readonly LogNode[];
  activeNodeId: string;
  onSelect(nodeId: string): void;
}

/**能进面包屑的节点：`kind === 'row'` 除外（不可点） */
function navigableNodes(nodes: readonly LogNode[]): LogNode[] {
  return nodes.filter((node) => node.kind !== 'row');
}

/**
 * 节点的显示名。主会话是固定文案「主会话」；子任务给不出任务名时用 `subagentId` 前 8 位，
 * 再给不出才用节点 id 前 8 位——**不显示空白**（v2  明确 `name` 可为 null）。
 */
export function nodeDisplayName(node: LogNode): string {
  if (node.kind === 'main') return '主会话';
  if (node.kind === 'row') return node.id.slice(0, 8);
  return node.name ?? `子任务 ${(node.subagentId ?? node.id).slice(0, 8)}`;
}

/** 祖先链（**根 → 当前**）。沿 `parentId` 回溯后反转；成环或断链即停 */
export function nodeChain(nodes: readonly LogNode[], activeNodeId: string): readonly LogNode[] {
  const byId = new Map(navigableNodes(nodes).map((node) => [node.id, node]));
  const chain: LogNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(activeNodeId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain.reverse();
}

/**
 * 面包屑的 `items`（导出是为了单测能直接看「每段的下拉里到底列了谁」——
 * 下拉是浮层，靠 hover 去测既慢又脆）。
 *
 * 每一段的形状由「这一层有没有别的节点」决定，三种：
 *   1. **当前段**：不可点（`Typography.Text strong` + `aria-current="page"`），**不给 `menu`**；
 *   2. **祖先段 + 同层还有别的节点**：给下拉，菜单 = 这一段的兄弟列表（本段标 `disabled`）
 *      ——「当前项」指「这一层你现在站在哪个节点上」，不是整条链的末尾；
 *   3. **祖先段 + 同层只有它自己**：**整段可点、不给下拉**（点了就回到它）。
 * * ⚠️ 第 3 种是两种真机缺陷的共同修法：
 * · 写成 `candidate.parentId === node.parentId`、而 `node` 是**这一段的节点**时——
 *     `主会话` 那一段列出的是「与主会话同父的节点」，主会话 `parentId === null`
 *     ⇒ 列表里只有它自己、且被标成 `disabled`。表现是**站在子任务上回不去主会话**：
 *     抽屉上唯一的入口是个灰项，点不动。正确口径：某一段的兄弟 = **它父节点的子节点**。 * · 光改对判据仍留一个死胡同：主会话是根、本来就没有同层兄弟 ⇒ 那一段必然只有一个灰项。
 *     所以「同层只有一个」时不能再给下拉，要把**这一段本身**做成入口。
 */
export interface BreadcrumbSibling {
  key: string;
  label: string;
  /** 当前段自己在菜单里是不可点的（它是「这一层你现在站在哪」的标记） */
  disabled: boolean;
  onSelect(): void;
}

/**
 * 一段面包屑的**纯数据形状**：渲染与判据共用同一份。
 * 三种形态由「这一层有没有别的节点」决定（见上方 1 / 2 / 3），`current` 与 `siblings` 互斥。
 */
export interface BreadcrumbSegment {
  key: string;
  label: string;
  /** 当前段：不可点、带 `aria-current="page"` */
  current: boolean;
  /** 祖先段 + 同层只有它自己：整段可点回退 */
  onSelect?: () => void;
  /** 祖先段 + 同层还有兄弟：下拉里列这一层的兄弟（含本段的禁用项） */
  siblings?: BreadcrumbSibling[];
}

export function breadcrumbItems(
  nodes: readonly LogNode[],
  activeNodeId: string,
  onSelect: (nodeId: string) => void,
): BreadcrumbSegment[] {
  const chain = nodeChain(nodes, activeNodeId);
  const navigable = navigableNodes(nodes);

  return chain.map((node, index) => {
    const label = nodeDisplayName(node);
    if (index === chain.length - 1) return { key: node.id, label, current: true };
    // 这一段的层级 = 它父节点的子节点集合；`parentId === null`（根段）时列的是根层
    const siblings = navigable.filter((candidate) => candidate.parentId === node.parentId);
    if (siblings.length <= 1) {
      // 同层只有它自己：整段可点回退（不给下拉，免得给出一个只有灰项的死胡同）
      return { key: node.id, label, current: false, onSelect: () => onSelect(node.id) };
    }
    return {
      key: node.id,
      label,
      current: false,
      siblings: siblings.map((sibling) => ({
        key: sibling.id,
        label: nodeDisplayName(sibling),
        disabled: sibling.id === node.id,
        onSelect: () => onSelect(sibling.id),
      })),
    };
  });
}

/** 一段的渲染：当前段是带 `aria-current` 的文本，其余两种是可操作的按钮 / 下拉 */
function Segment({ segment }: { segment: BreadcrumbSegment }): ReactNode {
  if (segment.current) {
    return (
      <span className="font-medium" aria-current="page">
        {segment.label}
      </span>
    );
  }
  if (segment.siblings === undefined) {
    return (
      <button
        type="button"
        className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground"
        onClick={segment.onSelect}
      >
        {segment.label}
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex cursor-pointer items-center gap-0.5 rounded-sm text-muted-foreground hover:text-foreground">
        {segment.label}
        <ChevronRightIcon aria-hidden className="size-3 rotate-90" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {segment.siblings.map((sibling) => (
          <DropdownMenuItem key={sibling.key} disabled={sibling.disabled} onClick={sibling.onSelect}>
            {sibling.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LogNodeBreadcrumb({ nodes, activeNodeId, onSelect }: LogNodeBreadcrumbProps): ReactNode {
  const items = breadcrumbItems(nodes, activeNodeId, onSelect);
  if (items.length === 0) return null;

  return (
    <nav className="flex items-center gap-1 text-sm" aria-label="节点路径" data-testid="log-node-breadcrumb">
      {items.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 && <span className="text-faint-foreground">/</span>}
          <div className="flex items-center gap-1" data-segment={segment.key}>
            <Segment segment={segment} />
          </div>
        </Fragment>
      ))}
    </nav>
  );
}
