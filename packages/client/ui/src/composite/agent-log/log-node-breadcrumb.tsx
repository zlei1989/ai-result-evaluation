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
import { Breadcrumb, Flex, Typography } from 'antd';
import type { BreadcrumbProps } from 'antd';
import { useMemo, type ReactNode } from 'react';
import type { LogNode } from './types';

export interface LogNodeBreadcrumbProps {
  nodes: readonly LogNode[];
  activeNodeId: string;
  onSelect(nodeId: string): void;
}

/** 能进面包屑的节点：`kind === 'row'` 除外（不可点，见 §6.3） */
function navigableNodes(nodes: readonly LogNode[]): LogNode[] {
  return nodes.filter((node) => node.kind !== 'row');
}

/**
 * 节点的显示名。主会话是固定文案「主会话」；子任务给不出任务名时用 `subagentId` 前 8 位，
 * 再给不出才用节点 id 前 8 位——**不显示空白**（v2 spec §6.2 明确 `name` 可为 null）。
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
 *
 * ⚠️ 第 3 种是两种真机缺陷的共同修法（2026-10-03）：
 *   · 原来写成 `candidate.parentId === node.parentId`，而 `node` 是**这一段的节点**——
 *     `主会话` 那一段列出的是「与主会话同父的节点」，主会话 `parentId === null`
 *     ⇒ 列表里只有它自己、且被标成 `disabled`。表现是**站在子任务上回不去主会话**：
 *     抽屉上唯一的入口是个灰项，点不动。正确口径：某一段的兄弟 = **它父节点的子节点**。
 *   · 改对之后仍留一个死胡同：主会话是根、本来就没有同层兄弟 ⇒ 那一段必然只有一个灰项。
 *     所以「同层只有一个」时不能再给下拉，要把**这一段本身**做成入口。
 */
export function breadcrumbItems(
  nodes: readonly LogNode[],
  activeNodeId: string,
  onSelect: (nodeId: string) => void,
): BreadcrumbProps['items'] {
  const chain = nodeChain(nodes, activeNodeId);
  const navigable = navigableNodes(nodes);

  return chain.map((node, index) => {
    if (index === chain.length - 1) {
      return {
        key: node.id,
        title: (
          <Typography.Text strong aria-current="page">
            {nodeDisplayName(node)}
          </Typography.Text>
        ),
      };
    }
    // 这一段的层级 = 它父节点的子节点集合；`parentId === null`（根段）时列的是根层
    const siblings = navigable.filter((candidate) => candidate.parentId === node.parentId);
    if (siblings.length <= 1) {
      // 同层只有它自己：整段可点回退（不给下拉，免得给出一个只有灰项的死胡同）
      return {
        key: node.id,
        title: (
          <Typography.Text
            role="link"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(node.id);
            }}
          >
            {nodeDisplayName(node)}
          </Typography.Text>
        ),
      };
    }
    return {
      key: node.id,
      title: <Typography.Text>{nodeDisplayName(node)}</Typography.Text>,
      menu: {
        items: siblings.map((sibling) => ({
          key: sibling.id,
          label: nodeDisplayName(sibling),
          disabled: sibling.id === node.id,
        })),
        onClick: ({ key }) => onSelect(String(key)),
      },
    };
  });
}

export function LogNodeBreadcrumb({ nodes, activeNodeId, onSelect }: LogNodeBreadcrumbProps): ReactNode {
  const items = useMemo(() => breadcrumbItems(nodes, activeNodeId, onSelect), [nodes, activeNodeId, onSelect]);

  if (items === undefined || items.length === 0) return null;

  return (
    // `data-testid` 只能挂在宿主上：`BreadcrumbProps` 没有 `data-*` 索引签名，挂它自己编译不过
    <Flex align="center" data-testid="log-node-breadcrumb">
      <Breadcrumb items={items} />
    </Flex>
  );
}
