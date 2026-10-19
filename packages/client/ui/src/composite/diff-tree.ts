/**
 * 变更详情左树的纯函数：把索引里**扁平的路径列表**接成目录树，并支持按路径过滤。
 *
 * 两条不变量（界面上的目录汇总与搜索都从它们派生）：
 *   1. **目录的 `insertions` / `deletions` 是子树求和**，不是自己那一层的统计——
 *      目录行显示 `+N −M`，人拿它跟下面文件对比，两个数对不上就没人再信这一格；
 *   2. **过滤后必须重算汇总**：只保留命中分支，被剪掉的文件不能还留在祖先的计数里。
 *
 * 排序口径：目录在前、文件在后，同层按名字升序（与 `git status` / 常见文件树一致——
 * 先看到结构，再看到叶子；名字比较用码点序而不是 locale，保证跨机器结果一致）。
 */
import type { RowDiffIndex } from '@aieval/contracts';

/** 索引里的一个文件条目（扁平列表的单元） */
export type DiffIndexEntry = RowDiffIndex['files'][number];

/** 树节点：目录的 `file` 为 `null`，文件的 `children` 恒为空数组 */
export interface DiffTreeNode {
  /** 这一层的名字（叶子名，不带父目录） */
  name: string;
  /** 从仓库根起的完整相对路径（目录不带尾斜杠） */
  path: string;
  isDirectory: boolean;
  /** 子树里的文件数——目录行用它说明「这里有几个文件」 */
  fileCount: number;
  /** 子树新增行数之和 */
  insertions: number;
  /** 子树删除行数之和 */
  deletions: number;
  children: DiffTreeNode[];
  /** 仅文件节点有：索引里的原始条目（`hasBody` / `untracked` 都靠它） */
  file: DiffIndexEntry | null;
}

/** 构建期的可变节点：目录与文件共用一种形状，靠 `file` 是否为 null 分辨 */
interface MutableNode {
  name: string;
  path: string;
  file: DiffIndexEntry | null;
  children: Map<string, MutableNode>;
}

/** 目录在前、同层按名字码点升序 */
function compareNodes(a: DiffTreeNode, b: DiffTreeNode): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 可变节点 → 不可变节点，并在这一趟里把子树的增删与文件数汇总上去 */
function finalize(node: MutableNode): DiffTreeNode {
  if (node.file !== null) {
    return {
      name: node.name,
      path: node.path,
      isDirectory: false,
      fileCount: 1,
      insertions: node.file.insertions,
      deletions: node.file.deletions,
      children: [],
      file: node.file,
    };
  }

  const children = [...node.children.values()].map(finalize).sort(compareNodes);

  return {
    name: node.name,
    path: node.path,
    isDirectory: true,
    fileCount: children.reduce((sum, child) => sum + child.fileCount, 0),
    insertions: children.reduce((sum, child) => sum + child.insertions, 0),
    deletions: children.reduce((sum, child) => sum + child.deletions, 0),
    children,
    file: null,
  };
}

/**
 * 扁平条目 → 目录树（根那一层是数组，没有虚拟根节点）。
 *
 * 路径按 `/` 分段；空段（`//`、结尾的 `/`）丢掉，路径为空的条目跳过——
 * 两者都不是真实文件，接进树里只会多出一个名字为空的行。
 */
export function buildDiffTree(entries: DiffIndexEntry[]): DiffTreeNode[] {
  const root: MutableNode = { name: '', path: '', file: null, children: new Map() };

  for (const entry of entries) {
    const segments = entry.path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) continue;

    let cursor = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join('/');
      let child = cursor.children.get(segment);
      if (child === undefined) {
        child = { name: segment, path, file: null, children: new Map() };
        cursor.children.set(segment, child);
      }
      // 最后一段才是文件本身；中间段一律是目录，不挂 `file`
      if (index === segments.length - 1) child.file = entry;
      cursor = child;
    });
  }

  return [...root.children.values()].map(finalize).sort(compareNodes);
}

/** 按剩余子树重算目录的汇总（过滤剪枝后必须走这一趟，否则祖先还留着被剪掉文件的数字） */
function summarize(nodes: DiffTreeNode[]): DiffTreeNode[] {
  return nodes.map((node) => {
    if (!node.isDirectory) return node;
    const children = summarize(node.children);
    return {
      ...node,
      children,
      fileCount: children.reduce((sum, child) => sum + child.fileCount, 0),
      insertions: children.reduce((sum, child) => sum + child.insertions, 0),
      deletions: children.reduce((sum, child) => sum + child.deletions, 0),
    };
  });
}

/**
 * 按完整路径（大小写不敏感）过滤目录树。
 *
 * 三条规则一起才是「过滤后层级正确」：
 *   - 节点自身路径命中 ⇒ 整个节点留下（目录命中意味着「想看这个目录里有什么」，保留整棵子树）；
 *   - 目录自身没命中但子树里有命中 ⇒ 只带命中的那一支下去，**祖先链保留**（否则文件悬空）；
 *   - 子树一个都没命中 ⇒ 整枝剪掉（否则满屏空目录，比不过滤还难找）。
 *
 * 关键词为空时**原样返回同一个引用**：调用方常把它放进 `useMemo`，每次过滤都重建树是白花钱。
 */
export function filterDiffTree(nodes: DiffTreeNode[], keyword: string): DiffTreeNode[] {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed === '') return nodes;

  const walk = (list: DiffTreeNode[]): DiffTreeNode[] =>
    list.flatMap((node) => {
      if (node.path.toLowerCase().includes(trimmed)) return [node];
      if (!node.isDirectory) return [];
      const children = walk(node.children);
      if (children.length === 0) return [];
      return [{ ...node, children }];
    });

  return summarize(walk(nodes));
}
