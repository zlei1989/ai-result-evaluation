'use client';

/**
 * 用例列表：四列（标题 / 仓库 / commit / 更新时间）+ 三列可排序。
 *
 * 走 Data Table 套件（`base/data-table.tsx`）：行虚拟化、表头吸顶与列宽都由它给，
 * 本组件只声明四列的宽度与排序语义：
 *   · 标题列默认降序、首点升序，再点降序，第三次取消排序（回到服务端顺序）；
 *   · 仓库列按**显示出来的仓库名**排，同名再按全路径兜底；更新时间按时刻值排；
 *   · 标题列钉在左边：左栏被拖窄时横向滚动，标题与列名始终看得见；
 *   · 四列宽度之和（`CASES_TABLE_MIN_WIDTH`）就是表格宽度；容器更宽时右侧留白，
 *     套件不按容器拉伸列宽（固定列的偏移只认声明的 `size`）。
 *
 * 排序是纯展示决策，不进 URL：刷新后回到标题降序。搜索参数里只放右栏状态。
 */
import { displayRepoName, isNoneSource, type TestCase } from '@aieval/contracts';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { DataTable, type DataTableColumn } from '../base/data-table';
import { formatDateTime, shortHash } from '../base/format';

/**
 * 四列声明的宽度（px）：标题 / 仓库 / commit / 更新时间。
 * 标题列 240：左栏被拖窄时，这一列至少还得读得下一整个用例名（如「简单测试」）。
 */
export const CASES_TABLE_COLUMN_WIDTH = {
  title: 240,
  repoPath: 200,
  commitHash: 110,
  updatedAt: 150,
} as const;

/** 标题列的宽度（保留具名导出：调用方与用例按它读「主标识有多宽」） */
export const CASES_TABLE_TITLE_MIN_WIDTH = CASES_TABLE_COLUMN_WIDTH.title;

/** 表格宽度 = 四列声明宽度之和；固定列的偏移只认这些声明值 */
export const CASES_TABLE_MIN_WIDTH =
  CASES_TABLE_COLUMN_WIDTH.title +
  CASES_TABLE_COLUMN_WIDTH.repoPath +
  CASES_TABLE_COLUMN_WIDTH.commitHash +
  CASES_TABLE_COLUMN_WIDTH.updatedAt;

/** 可排序列：与 `compareCases` 的键一一对应 */
type SortKey = 'title' | 'repoPath' | 'updatedAt';

/**
 * 每一列的**首次点击方向**：标题默认降序（首点切到升序），仓库与更新时间从「不排序」起步
 * ⇒ 首次点击分别是升序与降序（「最近更新在前」才符合直觉）。
 * 三态循环（首项 → 次项 → 取消）由套件的排序 feature 给，本组件不再自己写一遍。
 */

/**
 * 文本比较：中文按 `zh-Hans-CN` 的拼音序、数字按数值比（「测试2」排在「测试10」前面）。
 * 空值当最小值，且走显式分支：`updatedAt` 契约只声明 `z.string()`，手改过的用例文件能让排序键为空，
 * 不管的话 `String(undefined)` 会把 `"undefined"` 当正常字符串混进序里。
 */
function compareText(left: unknown, right: unknown): number {
  const leftBlank = typeof left !== 'string' || left.trim() === '';
  const rightBlank = typeof right !== 'string' || right.trim() === '';
  if (leftBlank || rightBlank) return leftBlank === rightBlank ? 0 : leftBlank ? -1 : 1;
  return (left as string).localeCompare(right as string, 'zh-Hans-CN', { numeric: true });
}

/** 时间比较：一律按时刻值比；解析不出时刻的脏数据与文本空值同一档，当最小值 */
function compareTime(left: unknown, right: unknown): number {
  const leftMs = typeof left === 'string' ? Date.parse(left) : Number.NaN;
  const rightMs = typeof right === 'string' ? Date.parse(right) : Number.NaN;
  const leftInvalid = Number.isNaN(leftMs);
  const rightInvalid = Number.isNaN(rightMs);
  // 同类 ISO 串的字典序与时刻序一致，但混进带时区偏移的写法（+08:00 与 Z 表示同一时刻）就会错位，故一律比毫秒数
  if (leftInvalid || rightInvalid) return leftInvalid === rightInvalid ? 0 : leftInvalid ? -1 : 1;
  return leftMs - rightMs;
}

/** 排序比较器：仓库列先比显示名、再比全路径；返回 0 的行保持服务端顺序（`sort` 稳定） */
function compareCases(left: TestCase, right: TestCase, key: SortKey): number {
  if (key === 'title') return compareText(left.title, right.title);
  if (key === 'repoPath') {
    return (
      compareText(displayRepoName(left.repoPath), displayRepoName(right.repoPath)) ||
      compareText(left.repoPath, right.repoPath)
    );
  }
  return compareTime(left.updatedAt, right.updatedAt);
}

export interface CasesTableProps {
  /** 服务端给的用例（`updatedAt` 降序）；组件只在渲染期排序，不改入参 */
  cases: TestCase[];
  /** 当前右栏选中的用例 id；高亮它这一行 */
  selectedId: string | null;
  /** 点一行（或聚焦后回车 / 空格）打开详情 */
  onSelect: (id: string) => void;
}

export function CasesTable({ cases, selectedId, onSelect }: CasesTableProps): ReactNode {
  /**
   * 四列定义：宽度是固定列偏移的唯一输入，故每一列都声明 `size`。
   * `sortFn` 只写升序语义，方向由排序态施加（与套件的约定一致，不在比较器里翻两次）。
   */
  const columns: DataTableColumn<TestCase>[] = [
    {
      id: 'title',
      header: '标题',
      accessorFn: (testCase) => testCase.title,
      size: CASES_TABLE_COLUMN_WIDTH.title,
      pinned: 'start',
      sortFn: (left, right) => compareCases(left.original, right.original, 'title'),
      sortDescFirst: true,
      cell: ({ row }) => (
        // 不写死 px：宽度由列定义给，`truncate` 让长标题落在单元格右边缘、悬停看全量
        <span className="block truncate" title={row.original.title}>
          {row.original.title}
        </span>
      ),
    },
    {
      id: 'repoPath',
      header: '仓库',
      accessorFn: (testCase) => testCase.repoPath,
      size: CASES_TABLE_COLUMN_WIDTH.repoPath,
      sortFn: (left, right) => compareCases(left.original, right.original, 'repoPath'),
      cell: ({ row }) => (
        // 列里只给末段，全路径在 Tooltip：深路径会把这列撑开、把标题挤没。
        // 「无来源」不显示哨兵串 `none://`，悬停换成一句说全的话。
        <span
          className="block truncate"
          title={isNoneSource(row.original.repoPath) ? '空仓库，无来源代码' : row.original.repoPath}
        >
          {displayRepoName(row.original.repoPath)}
        </span>
      ),
    },
    {
      id: 'commitHash',
      header: '提交',
      accessorFn: (testCase) => testCase.commitHash ?? '',
      size: CASES_TABLE_COLUMN_WIDTH.commitHash,
      // commit 不排序：短哈希与提交说明的先后没有业务含义
      enableSorting: false,
      cell: ({ row }) =>
        row.original.commitHash === null ? (
          <span className="text-muted-foreground">默认 HEAD</span>
        ) : (
          // 悬停给**全量** hash：短哈希再显示一遍等于没有提示
          <code className="font-mono text-xs" title={row.original.commitHash}>
            {shortHash(row.original.commitHash)}
          </code>
        ),
    },
    {
      id: 'updatedAt',
      header: '更新时间',
      accessorFn: (testCase) => testCase.updatedAt,
      size: CASES_TABLE_COLUMN_WIDTH.updatedAt,
      sortFn: (left, right) => compareCases(left.original, right.original, 'updatedAt'),
      sortDescFirst: true,
      cell: ({ row }) => formatDateTime(row.original.updatedAt),
    },
  ];

  return (
    <DataTable
      columns={columns}
      fillColumnId="title"
      data={cases}
      rowKey={(testCase) => testCase.id}
      rowHeight={40}
      enableSorting
      // 刷新后回到标题降序（与服务端给的 `updatedAt` 降序不是一回事，但这是既有的显示口径）
      defaultSorting={[{ id: 'title', desc: true }]}
      tableAttributes={{ 'data-testid': 'cases-table' }}
      rowAttributes={(testCase) => {
        const selected = testCase.id === selectedId;
        return {
          'data-testid': `case-row-${testCase.id}`,
          'data-selected': String(selected),
          'aria-selected': selected,
          tabIndex: 0,
          className: cn(
            'group cursor-pointer outline-none focus-visible:bg-muted',
            selected ? 'bg-muted' : 'bg-background',
          ),
          onClick: () => onSelect(testCase.id),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            // 空格默认会滚动页面：行是「按钮」语义，必须拦下
            event.preventDefault();
            onSelect(testCase.id);
          },
        };
      }}
      cellAttributes={(testCase, columnId) => {
        if (columnId !== 'title') return undefined;
        const selected = testCase.id === selectedId;
        // 钉住的那一格必须自己带底色：否则别的列滑过来会透出来（选中态同样跟着换）
        return {
          className: cn('max-w-0', selected ? 'bg-muted' : 'bg-background group-hover:bg-muted/50'),
        };
      }}
      ariaLabel="用例列表"
    />
  );
}
