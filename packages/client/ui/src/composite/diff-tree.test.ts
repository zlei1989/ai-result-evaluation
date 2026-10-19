// @vitest-environment node
/**
 * 变更详情的目录树（纯函数）：扁平路径 → 嵌套树，目录带**子树**增删汇总。
 *
 * 两条判据各自单独钉住：
 *   1. **汇总口径**：目录行显示的 `+N −M` 必须是它下面每个文件的增删之和，否则
 *      「目录里看着改了很多、点进去只有几行」——数字与内容对不上，人就再也不信这一格；
 *   2. **过滤后的层级**：命中深层文件时祖先目录必须留下（否则文件悬空、看不出它在哪），
 *      没命中的分支必须整枝剪掉（否则满屏空目录，比不过滤还难找）。
 *
 * 期望值全部是手算的字面量，不由被测函数复算——复算出来的「期望」永远不会失败。
 */
import { describe, expect, it } from 'vitest';
import type { RowDiffIndex } from '@aieval/contracts';
import { buildDiffTree, filterDiffTree, type DiffTreeNode } from './diff-tree';

type Entry = RowDiffIndex['files'][number];

function entry(path: string, insertions: number, deletions: number): Entry {
  return { path, insertions, deletions, untracked: false, hasBody: true };
}

/** 夹具：两个根级目录（其中一个带三层）+ 一个根级文件，数字小到手算不会错 */
const FILES: Entry[] = [
  entry('docs/guide/a.md', 3, 1),
  entry('docs/guide/b.md', 2, 4),
  entry('docs/README.md', 5, 0),
  entry('src/app.ts', 10, 2),
  entry('src/lib/util.ts', 0, 7),
  entry('package.json', 1, 1),
];

/** 按完整路径找节点；找不到返回 undefined，由 `nodeAt` 决定抛错 */
function findNode(nodes: DiffTreeNode[], path: string): DiffTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const hit = findNode(node.children, path);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 按完整路径取一个节点；取不到就是用例失败（不要让它静默返回 undefined 让后面的断言空转） */
function nodeAt(nodes: DiffTreeNode[], path: string): DiffTreeNode {
  const hit = findNode(nodes, path);
  if (hit === undefined) throw new Error(`树里没有 ${path}`);
  return hit;
}

/** 深度优先铺平成路径数组：用来判「有没有多余的空目录」——多一层就多一项 */
function flattenPaths(nodes: DiffTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...flattenPaths(node.children)]);
}

describe('buildDiffTree：扁平文件列表接成目录树', () => {
  it('目录在前、各自按名字升序；文件挂在所属目录下，路径逐层拼出', () => {
    const tree = buildDiffTree(FILES);

    expect(tree.map((node) => node.path)).toEqual(['docs', 'src', 'package.json']);
    expect(tree.map((node) => node.isDirectory)).toEqual([true, true, false]);

    // 目录先于文件（git 与常见文件树的惯例：先看到结构，再看到叶子）
    expect(nodeAt(tree, 'docs').children.map((node) => node.path)).toEqual([
      'docs/guide',
      'docs/README.md',
    ]);
    // 叶子节点的 `name` 只是这一层的名字，完整路径在 `path` 上
    expect(nodeAt(tree, 'docs/guide').children.map((node) => node.name)).toEqual(['a.md', 'b.md']);
    expect(nodeAt(tree, 'docs/guide').children.map((node) => node.path)).toEqual([
      'docs/guide/a.md',
      'docs/guide/b.md',
    ]);
  });

  it('目录行汇总 = 子树每个文件之和（三层也要逐层对上）', () => {
    const tree = buildDiffTree(FILES);

    // docs: 3+2+5 = 10 行新增；1+4+0 = 5 行删除
    expect([nodeAt(tree, 'docs').insertions, nodeAt(tree, 'docs').deletions]).toEqual([10, 5]);
    // docs/guide: 3+2 = 5 / 1+4 = 5
    expect([nodeAt(tree, 'docs/guide').insertions, nodeAt(tree, 'docs/guide').deletions]).toEqual([5, 5]);
    // src: 10+0 = 10 / 2+7 = 9
    expect([nodeAt(tree, 'src').insertions, nodeAt(tree, 'src').deletions]).toEqual([10, 9]);
    // src/lib 只有一个文件，汇总与文件本身一致
    expect([nodeAt(tree, 'src/lib').insertions, nodeAt(tree, 'src/lib').deletions]).toEqual([0, 7]);
  });

  it('目录的 fileCount 是子树文件数（不是直接子节点数）', () => {
    const tree = buildDiffTree(FILES);

    expect(nodeAt(tree, 'src').fileCount).toBe(2);
    expect(nodeAt(tree, 'docs').fileCount).toBe(3);
    expect(nodeAt(tree, 'docs/guide').fileCount).toBe(2);
    expect(nodeAt(tree, 'package.json').fileCount).toBe(1);
  });
});

describe('filterDiffTree：过滤后层级正确', () => {
  it('命中深层文件时祖先目录仍在，且没有空目录残留（docs 与 src 的另一支整枝剪掉）', () => {
    const filtered = filterDiffTree(buildDiffTree(FILES), 'util');

    // 恰好是 src → lib → util.ts 这一条链：多一个 docs 就是空目录残留，
    // 少一个 src 就是文件悬空（看不出它在哪一层）
    expect(flattenPaths(filtered)).toEqual(['src', 'src/lib', 'src/lib/util.ts']);
  });

  it('过滤后目录汇总跟着剩余子树重算（不把被剪掉的文件算进去）', () => {
    // src 下 app.ts（+10 −2）被过滤掉，只剩 util.ts（+0 −7）
    const filtered = filterDiffTree(buildDiffTree(FILES), 'util');

    expect([nodeAt(filtered, 'src').insertions, nodeAt(filtered, 'src').deletions]).toEqual([0, 7]);
    expect(nodeAt(filtered, 'src').fileCount).toBe(1);
  });

  it('关键词命中目录名 ⇒ 保留该目录整棵子树（搜目录是想看它里面有什么）', () => {
    const filtered = filterDiffTree(buildDiffTree(FILES), 'docs');

    expect(flattenPaths(filtered)).toEqual([
      'docs',
      'docs/guide',
      'docs/guide/a.md',
      'docs/guide/b.md',
      'docs/README.md',
    ]);
  });

  it('关键词为空（或只有空白）⇒ 原样返回，不重建树', () => {
    const tree = buildDiffTree(FILES);

    expect(filterDiffTree(tree, '')).toBe(tree);
    expect(filterDiffTree(tree, '   ')).toBe(tree);
  });

  it('一个都不命中 ⇒ 空数组（调用方据此给空态，而不是留一棵空壳）', () => {
    expect(filterDiffTree(buildDiffTree(FILES), 'nope')).toEqual([]);
  });
});
