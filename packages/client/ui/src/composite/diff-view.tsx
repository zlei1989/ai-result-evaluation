'use client';

/**
 * 变更详情：**左目录树 + 右单文件 diff**。
 *
 * 六条口径：
 *   1. **右侧只渲染选中的那一个文件**，正文由调用方经 `renderFileBody(path)` 渲染。
 *      本包不调接口（见 index.ts 头注释），调用方为每个文件挂自己的 SWR 订阅——
 *      hook 不能按参数循环调用，故「每文件一个组件实例」是唯一站得住的形状。
 *   2. **逐文件惰性加载**：没选中任何文件时一次都不取；选中哪个才取哪个。
 *      万级文件变更下这是不卡死的关键——不取、也不渲染未选中的那些。
 *   3. **左树可折叠、目录行带子树增删汇总**：树回答「这次改了哪些目录、各改了多少」，
 *      汇总由 `diff-tree.ts` 从索引算出（目录的数字必须等于其下文件之和）。
 *   4. **滚动的归属**：左树与右侧正文各自滚（各自 `overflow: auto`），
 *      抽屉正文容器不再承担本组件内部的滚动——正文自己再加一层滚动就会出现第二条滚动条。
 *   5. **截断提示是硬要求**：文案必须说「评分模型看不到」，
 *      只说「已截断」会让使用者以为只是界面没显示全。
 *   6. 正文用 `react-diff-viewer-continued` 渲染，它要的是**两侧完整正文**而不是 diff 文本，
 *      故先经 `reconstructSides` 还原（理由见 diff-patch.ts 的文件头）。
 */
import { ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '../components/ui/empty';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import DiffViewer from 'react-diff-viewer-continued';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RowDiffFile, RowDiffIndex } from '@aieval/contracts';
import { EllipsisText } from '../base/ellipsis-text';
import { EmptyState } from '../base/empty-state';
import { cn } from '../lib/utils';
import { buildDiffTree, filterDiffTree, type DiffTreeNode } from './diff-tree';
import { languageOf, reconstructSides } from './diff-patch';

export interface DiffViewProps {
  index: RowDiffIndex | undefined;
  /** 由调用方渲染单个文件的正文（ui 包不调接口，故收一个渲染函数而不是取数函数） */
  renderFileBody: (path: string) => ReactNode;
  /** 继续加载下一页索引；undefined = 没有更多 */
  onLoadMore?: () => void;
  /** 实际生效的明暗，透传给 diff 组件的 useDarkTheme */
  dark: boolean;
}

/**
 * 单个文件正文的**受控纯展示件**：加载中 / 出错 / 二进制 / diff 视图四态。
 * 导出它是因为调用方拿到 SWR 结果后需要一个现成的渲染件——
 * 否则每个调用方都要再写一份这四态判断，四份判断必然漂移。
 */
export function DiffFileContent({
  file,
  error,
  isLoading,
  dark,
}: {
  file: RowDiffFile | undefined;
  error: unknown;
  isLoading: boolean;
  dark: boolean;
}): ReactNode {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" data-testid="diff-file-skeleton">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  if (error !== null && error !== undefined) {
    return (
      <Alert variant="destructive">
        <AlertTitle>这个文件的正文读取失败</AlertTitle>
        <AlertDescription>{String(error)}</AlertDescription>
      </Alert>
    );
  }
  if (file === undefined) return null;
  if (file.binary) return <span className="text-muted-foreground">二进制文件，没有可显示的文本改动</span>;

  return <DiffContentViewer file={file} dark={dark} />;
}

/**
 * 单个文件的 diff 视图。
 *
 * **标题（文件路径）由外壳负责，不交给 diff 组件**：组件内部那个头部也是 `position: sticky`，
 * 与外壳的标题条叠在一起只会互相压。边界很清楚：**标题归我们**（它对每个文件都必须存在，
 * 哪怕没有正文可取），**正文归它**。故这里把 `hideSummary` 打开，只留它自己的展开/折叠按钮
 * （`summary`），路径不再重复出现。
 */
function DiffContentViewer({ file, dark }: { file: RowDiffFile; dark: boolean }): ReactNode {
  const sides = useMemo(() => reconstructSides(file.patch), [file.patch]);

  if (sides.oldValue === '' && sides.newValue === '') {
    return <span className="text-muted-foreground">这个文件没有可显示的文本改动</span>;
  }

  return (
    // **不限高、不自滚**：正文随内容自然展开，右栏只保留一条滚动条——
    // 正文自己再滚一次就会出现右侧第二条滚动条。
    <DiffViewer
      oldValue={sides.oldValue}
      newValue={sides.newValue}
      splitView={false}
      useDarkTheme={dark}
      // 不折叠未修改行：两侧已按 hunk 头各自恢复到真实位置（缺失行是空洞、没补空串），
      // 折叠会把「相隔多远」这层信息藏起来
      showDiffOnly={false}
      // 每个文件一个 worker 在几十个文件同时进视口时是纯开销；jsdom 里也没有 worker
      disableWorker
      highlightLanguage={languageOf(file.path)}
      hideSummary
      styles={{
        contentText: { fontFamily: 'var(--font-mono)', fontSize: 'var(--density-text-sub)' },
        lineNumber: { fontFamily: 'var(--font-mono)' },
        /**
         * **避免横向滚动**：组件给表格的默认样式里带
         * `minWidth: '1000px'` 与 `overflowX: 'auto'`，而抽屉宽度可能是 800px（`WIDE_DRAWER_SIZE`
         * 的下限）——窄屏上它比这个最小宽还窄，横向滚动条就是必然的；宽屏上也不该由组件的默认
         * 最小宽替我们定死排版宽度。这里把最小宽度放开、改成按容器宽度排版；正文本身已是
         * `pre-wrap` + `lineBreak: anywhere`，长行会在单元格内折行，所以不需要靠横向滚动来看全。
         */
        diffContainer: { minWidth: 0, width: '100%', tableLayout: 'fixed', overflowX: 'auto' },
      }}
    />
  );
}

/** 增删行数按 git 惯例上色：`+N` 绿、`−M` 红，与执行日志事实条里「改动」那一格同一套视觉语言 */
function DiffCounts({
  insertions,
  deletions,
  testId,
}: {
  insertions: number;
  deletions: number;
  /** 给断言用：不换行这条不变量就落在这个 span 上（外层容器没有它） */
  testId?: string;
}): ReactNode {
  return (
    <span className="text-muted-foreground" style={{ whiteSpace: 'nowrap' }} data-testid={testId}>
      <span className="text-success">+{insertions}</span>
      {' '}
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

/**
 * 左树的一行（递归）。
 *
 * 目录：`Collapsible`（默认展开）+ `CollapsibleTrigger` 里放一个 ghost `Button`，
 * 子层容器 `ml-4` 只做视觉缩进，层级由 DOM 嵌套表达（与 File Tree pattern 一致）。
 * 文件：`Button`，选中态只给 `aria-current="true"` + `bg-muted`，不自造选中 class。
 */
function DiffTreeRow({
  node,
  selectedPath,
  onSelect,
}: {
  node: DiffTreeNode;
  selectedPath: string | null;
  onSelect(path: string): void;
}): ReactNode {
  if (!node.isDirectory) {
    const selected = selectedPath === node.path;
    return (
      <Button
        variant="ghost"
        size="sm"
        data-testid={`diff-tree-file-${node.path}`}
        aria-current={selected ? 'true' : undefined}
        className={cn('w-full justify-start gap-1.5 font-normal', selected && 'bg-muted')}
        onClick={() => onSelect(node.path)}
      >
        <FileIcon aria-hidden />
        <span className="truncate" title={node.path}>
          {node.name}
        </span>
        {node.file?.untracked === true && (
          <Badge
            variant="outline"
            className="shrink-0 border-success/40 text-success"
            data-tone="untracked"
          >
            未跟踪
          </Badge>
        )}
        <span className="ml-auto shrink-0">
          <DiffCounts
            insertions={node.insertions}
            deletions={node.deletions}
            testId={`diff-file-counts-${node.path}`}
          />
        </span>
      </Button>
    );
  }

  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-testid={`diff-dir-${node.path}`}
            className="w-full justify-start gap-1.5 font-normal"
          />
        }
      >
        {/* `data-panel-open` 落在 trigger 渲染出的按钮上（Button 自带 `group/button`），箭头跟着开合转 90° */}
        <ChevronRightIcon aria-hidden className="transition-transform group-data-panel-open/button:rotate-90" />
        <FolderIcon aria-hidden />
        <span className="truncate" title={node.path}>
          {node.name}
        </span>
        <span className="ml-auto shrink-0">
          <DiffCounts
            insertions={node.insertions}
            deletions={node.deletions}
            testId={`diff-dir-counts-${node.path}`}
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 flex flex-col">
          {node.children.map((child) => (
            <DiffTreeRow
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 右栏：选中文件的标题条 + 正文（没选中时由调用方给空态） */
function SelectedFilePane({
  entry,
  renderFileBody,
}: {
  entry: RowDiffIndex['files'][number];
  renderFileBody: DiffViewProps['renderFileBody'];
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        data-testid={`diff-file-title-${entry.path}`}
        className="flex items-center justify-between gap-2 border-b border-border bg-popover px-roomy py-snug"
      >
        {/* 路径**不再另外包一层壳**：`EllipsisText` 自己就是 `truncate` + 原生 `title`，
            外面再包一层等宽容器会多一层 DOM，还会让省略号的宽度算错。这里直接用它。 */}
        <EllipsisText text={entry.path} monospace />
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          {entry.untracked && (
            <Badge
              variant="outline"
              className="border-success/40 text-success"
              data-tone="untracked"
            >
              未跟踪
            </Badge>
          )}
          <DiffCounts insertions={entry.insertions} deletions={entry.deletions} />
        </div>
      </div>

      {/*
        正文区**不额外加横向内边距**：diff 表格自带 `minWidth: 1000px` 与 `overflow-x: auto`，
        右栏外面再套一层 padding 只会把可用的横向空间再削掉一截、让那条横向滚动条更早出现。
        上下留白仍由这里的 padding 提供。
      */}
      <div data-testid={`diff-file-body-${entry.path}`} style={{ padding: '8px 0' }}>
        {!entry.hasBody ? (
          <span className="text-muted-foreground">该文件超出体积上限，未包含在本次评分输入中</span>
        ) : (
          renderFileBody(entry.path)
        )}
      </div>
    </div>
  );
}

export function DiffView({ index, renderFileBody, onLoadMore, dark }: DiffViewProps): ReactNode {
  const [keyword, setKeyword] = useState('');
  /** 选中的文件（完整路径）；null = 还没选，右栏给空态 */
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  /**
   * `onLoadMore` 走 ref 而不是直接进 effect 依赖：调用方几乎总是传一个**内联箭头函数**
   * （每帧新引用），进依赖会让观察者每帧重建、每次都立即判定「哨兵可见」而反复触发加载——
   * 一个自我维持的加载循环。ref 让订阅只建一次，回调始终取最新那个。
   */
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current?.();
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  const files = index?.files ?? [];
  const tree = useMemo(() => buildDiffTree(files), [files]);
  const visibleTree = useMemo(() => filterDiffTree(tree, keyword), [tree, keyword]);

  if (index === undefined) {
    return <span className="text-muted-foreground">正在读取变更…</span>;
  }

  // 选中的文件从**全量已加载**里查，而不是从过滤结果里查：搜索只改左树显示什么，
  // 不该把正在看的那份正文一起收走
  const selectedEntry = selectedPath === null ? undefined : files.find((file) => file.path === selectedPath);

  return (
    // height 交给抽屉 body：左树与右栏要各自滚，本组件必须吃满剩余高度
    <div data-testid="diff-view" className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-2" style={{ padding: '12px 16px' }}>
        {index.truncated && (
          <Alert className="border-warning/30 bg-warning/10 text-warning">
            <AlertTitle>
              {`变更已按体积上限截断：${index.droppedFiles.length} 个文件未包含，评分模型看不到它们`}
            </AlertTitle>
          </Alert>
        )}
        {index.droppedFiles.length > 0 && (
          <span className="text-muted-foreground">被丢弃的文件：{index.droppedFiles.join('、')}</span>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">
            共 {index.total} 个文件 · +{index.insertions} −{index.deletions}
          </span>
          <Input
            type="search"
            placeholder="按路径过滤"
            className="max-w-[260px]"
            onChange={(event) => setKeyword(event.target.value)}
            aria-label="按路径过滤"
          />
        </div>
        {keyword.trim() !== '' && (
          // 只说「命中几个」会让人以为服务端搜过全部文件——实际只过滤了已加载的这一页
          <span className="text-muted-foreground">
            仅在已加载的 {files.length} 个文件里过滤（共 {index.total} 个）
          </span>
        )}
      </div>

      {index.total === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <EmptyState title="没有代码变更" description="这一行没有产生任何文件变更" />
        </div>
      ) : visibleTree.length === 0 ? (
        <div style={{ padding: '0 16px 16px' }}>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>没有匹配项</EmptyTitle>
              <EmptyDescription>已加载的文件里没有匹配项</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1" data-testid="diff-split">
          {/* 左栏固定宽、自己滚：树只回答「改了哪些文件」，不参与右侧正文的布局 */}
          <aside
            data-testid="diff-tree-pane"
            className="flex w-60 shrink-0 flex-col gap-1 border-r border-border p-tight"
            style={{ overflow: 'auto' }}
          >
            {visibleTree.map((node) => (
              <DiffTreeRow
                key={node.path}
                node={node}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
              />
            ))}
            {onLoadMore !== undefined && files.length < index.total && (
              <div ref={sentinelRef} style={{ height: 1 }} />
            )}
          </aside>

          {/* 右栏：只渲染选中的那一个文件；没选中时给空态而不是空白 */}
          <section
            data-testid="diff-file-pane"
            className="flex min-w-0 flex-1 flex-col"
            // 内联而不是 `overflow-auto` 类：jsdom 没有样式表，滚动归属这条不变量只能读内联
            style={{ overflow: 'auto' }}
          >
            {selectedEntry === undefined ? (
              <div className="flex flex-1 items-center justify-center p-roomy">
                <EmptyState title="从左边选一个文件" description="这里只渲染你选中的那一个文件的变更" />
              </div>
            ) : (
              <SelectedFilePane entry={selectedEntry} renderFileBody={renderFileBody} />
            )}
          </section>
        </div>
      )}
    </div>
  );
}
