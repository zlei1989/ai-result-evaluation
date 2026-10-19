'use client';

/**
 * 技能目录树：AI Elements 的 `File Tree` pattern（`Collapsible` + `Button` 递归），
 * 左树右预览。纯展示：树数据与右侧正文都由调用方取好递进来，本件不调接口。
 *
 * 六条口径：
 *   1. **目录由 `Collapsible` 管开合，默认展开**：这棵树回答「这一条技能里有什么」，
 *      初次打开就要看全；收起时面板内容卸载（不是被 CSS 藏住），再展开拿到的是新挂载的一份。
 *   2. **文件节点是 `Button`**，选中态只给 `aria-current="true"`，不自造选中 class：
 *      可访问名就是文件名，屏读器与按名定位的用例看到的是同一个词。
 *   3. **节点标题只显示叶子名**（`API.md`，不是 `reference/API.md`）：缩进已经表达了层级，
 *      再写父目录就是重复；完整相对路径在预览标题栏那一格（不同目录下的同名文件靠它分辨）。
 *   4. **选中是受控的**：`selectedPath` 恒给数组（没选中给空数组/`null`），
 *      组件不持内部态——否则关掉抽屉再打开会残留上一次选中的文件。
 *   5. **预览恒由调用方接管**：壳只摆槽位，不取内容、不认识正文来源；标题栏也只是由壳渲染、
 *      文案与复制源由调用方给。
 *   6. **树标题默认不渲染**：树那一栏上下都是内容，多一行只是噪声；调用方要交代
 *      「这个目录没列全」时才传 `title`。
 *   7. **搜索只改「显示什么」**：过滤后层级必须仍然正确（命中文件的祖先目录保留、
 *      空枝剪掉），并且**不碰选中态、不碰调用方的启停状态**——那两样不在本件的职责里。
 *
 * 依赖纪律：本文件与它用的两个 vendored 原语都不 import `antd` / `@ant-design/*`
 * （静态守卫见 `skill-file-tree.guard.test.ts`）。
 */
import { ChevronRightIcon, CopyIcon, FileIcon, FolderIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { SkillTreeNode } from '@aieval/contracts';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import { InputGroup, InputGroupAddon, InputGroupInput } from '../components/ui/input-group';
import { cn } from '../lib/utils';

export interface SkillFileTreeProps {
  /** 树数据（契约形状：`title` / `path` 都是叶子名、`children` 恒为数组） */
  nodes: SkillTreeNode[];
  /** 选中的文件（**路径段数组**，与树的层级一一对应）；null = 没选中 */
  selectedPath: string[] | null;
  /** 点了某个文件：收到**路径段数组**（逐层拼出来的技能内相对路径） */
  onSelectPath(segments: string[]): void;
  /** 右侧预览那一栏（由调用方渲染） */
  preview: ReactNode;
  /**
   * 预览区的标题栏：左边 `fileName`（通常给**完整相对路径**——它才是「同名文件分得清」的那一格）、
   * 右边是复制 `copyText` 的按钮。不传 = 不渲染标题栏。
   */
  previewTitle?: { fileName: string; copyText: string };
  /** 左树顶部的标题；不传 = 不渲染（见文件头第 6 条） */
  title?: ReactNode;
  /** 没选中任何文件时右侧那一栏 */
  empty?: ReactNode;
  /** 结构性尺寸（高度之类）由调用方给：抽屉里它要吃掉剩余高度 */
  style?: CSSProperties;
}

/**
 * 按名字/相对路径过滤技能树（大小写不敏感）。
 *
 * 三条规则一起才是「层级仍然正确」：
 *   - 节点自身命中 ⇒ 整个节点留下；目录命中意味着「想看这个目录里有什么」，保留整棵子树；
 *   - 目录没命中但子树有命中 ⇒ 只带命中的那一支下去，**祖先链保留**（否则文件悬空）；
 *   - 子树一个都没命中 ⇒ 整枝剪掉（否则满屏空目录，比不过滤还难找）。
 *
 * 关键词为空时**原样返回同一个引用**：调用方把它放进 `useMemo`，每次重建整棵树是白花钱。
 */
export function filterSkillTree(nodes: SkillTreeNode[], keyword: string): SkillTreeNode[] {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed === '') return nodes;

  const walk = (list: SkillTreeNode[], base: string): SkillTreeNode[] =>
    list.flatMap((node) => {
      // 相对路径里也含叶子名，故路径命中天然覆盖「按名字命中」；再单独比一次名字，
      // 是为了让 `title` 与 `path` 不一致的树（契约允许）也按人看到的那一格过滤
      const path = base === '' ? node.path : `${base}/${node.path}`;
      if (node.title.toLowerCase().includes(trimmed) || path.toLowerCase().includes(trimmed)) {
        return [node];
      }
      if (!node.isDirectory) return [];
      const children = walk(node.children, path);
      return children.length === 0 ? [] : [{ ...node, children }];
    });

  return walk(nodes, '');
}

/** 复制按钮：失败静默（只读预览里，弹一句「复制失败」比没复制上更打扰） */
function CopyButton({ text }: { text: string }): ReactNode {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="复制"
      onClick={() => {
        const clipboard: Clipboard | undefined = navigator.clipboard;
        if (clipboard === undefined) return;
        void clipboard.writeText(text).catch(() => undefined);
      }}
    >
      <CopyIcon aria-hidden />
    </Button>
  );
}

interface TreeRowProps {
  node: SkillTreeNode;
  /** 从技能目录内容开始的路径段（不含技能名那一层） */
  parentSegments: string[];
  selectedPath: string[] | null;
  onSelectPath(segments: string[]): void;
}

/**
 * 递归渲染一个节点。
 *
 * 目录：`Collapsible`（默认展开）+ `CollapsibleTrigger` 里放一个 ghost `Button`；
 * 子层容器 `ml-4` 只做视觉缩进，层级由 DOM 嵌套表达（与 File Tree 官方口径一致）。
 * 文件：`Button`，点击交出「父段 + 自己的 `path`」。
 */
function TreeRow({ node, parentSegments, selectedPath, onSelectPath }: TreeRowProps): ReactNode {
  const segments = [...parentSegments, node.path];

  if (!node.isDirectory) {
    const selected = selectedPath?.join('/') === segments.join('/');
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-current={selected ? 'true' : undefined}
        className={cn('w-full justify-start gap-1.5 font-normal', selected && 'bg-muted')}
        onClick={() => onSelectPath(segments)}
      >
        <FileIcon aria-hidden />
        <span className="truncate">{node.title}</span>
      </Button>
    );
  }

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="sm" className="w-full justify-start gap-1.5 font-normal" />
        }
      >
        {/* `data-panel-open` 落在 trigger 渲染出的按钮上（Button 自带 `group/button`），
            所以箭头跟着开合转 90° */}
        <ChevronRightIcon
          aria-hidden
          className="transition-transform group-data-panel-open/button:rotate-90"
        />
        <FolderIcon aria-hidden />
        <span className="truncate">{node.title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 flex flex-col">
          {node.children.map((child) => (
            <TreeRow
              key={[...segments, child.path].join('/')}
              node={child}
              parentSegments={segments}
              selectedPath={selectedPath}
              onSelectPath={onSelectPath}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SkillFileTree({
  nodes,
  selectedPath,
  onSelectPath,
  preview,
  previewTitle,
  title,
  empty,
  style,
}: SkillFileTreeProps): ReactNode {
  const [keyword, setKeyword] = useState('');
  const filtered = useMemo(() => filterSkillTree(nodes, keyword), [nodes, keyword]);

  return (
    <div data-testid="skill-file-tree" className="flex min-h-0 w-full overflow-hidden" style={style}>
      {/* 左栏固定宽、自己滚动：树只回答「有什么」，不参与右侧正文的布局 */}
      <div
        data-testid="skill-file-tree-sidebar"
        className="flex w-60 shrink-0 flex-col gap-1 overflow-auto border-r border-border p-tight"
      >
        {/* 搜索框在树的最上方：它是这一栏的操作，先于任何状态说明 */}
        <div data-testid="skill-file-tree-search" className="px-tight py-hair">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder="按名字过滤"
              aria-label="按名字过滤"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </InputGroup>
        </div>
        {title === undefined ? null : (
          <div data-testid="skill-file-tree-title" className="px-tight py-hair">
            {title}
          </div>
        )}
        {filtered.length === 0 ? (
          <span className="px-tight py-hair text-muted-foreground">没有匹配项</span>
        ) : (
          <div className="flex flex-col">
            {filtered.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                parentSegments={[]}
                selectedPath={selectedPath}
                onSelectPath={onSelectPath}
              />
            ))}
          </div>
        )}
      </div>

      {/* 右栏：标题栏（可选）+ 预览正文；没选中文件时给空态而不是空正文 */}
      <div data-testid="skill-file-tree-preview" className="flex min-w-0 flex-1 flex-col">
        {previewTitle === undefined ? null : (
          <div
            data-testid="skill-file-preview-title"
            className="flex items-center justify-between gap-snug border-b border-border px-page py-tight"
          >
            <span className="truncate font-mono text-sub" title={previewTitle.fileName}>
              {previewTitle.fileName}
            </span>
            <CopyButton text={previewTitle.copyText} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-page py-tight">
          {selectedPath === null ? empty : preview}
        </div>
      </div>
    </div>
  );
}
