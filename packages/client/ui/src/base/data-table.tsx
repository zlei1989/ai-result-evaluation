'use client';

/**
 * 数据表薄封装：TanStack Table v9（headless）+ 行虚拟化。
 *
 * 它只做本仓真正用得到的三件事，其余能力（筛选、分组、分页、展开）**不进**
 * `tableFeatures()`——v9 是 feature 制，没列出的 feature 会被 tree-shake；
 * 多写一个就是白背体积。
 *
 * 三条结构性口径：
 *   1. **固定的唯一输入是列定义里的 `size`**。TanStack 的 `getStart()` / `getAfter()`
 *      算的是声明宽度之和，不是 DOM 实测；所以钉住的列不声明 `size` 就是静默错位。
 *      组件在渲染前先 `assertPinnedColumnsHaveSize()`，缺一个就当场抛错。
 *   2. **行虚拟化以固定行高为前提**（`rowHeight`）。表体用上下两个 spacer 行撑出总高度，
 *      行本身仍留在正常的 `<table>` 流里——这样固定列、表头吸顶与列宽都不必为了虚拟化改写。
 *      调用方必须把表放进**有界高度**的容器（或直接给 `viewportHeight`）：高度无界时
 *      滚动容器会按内容撑开，虚拟化就只剩一个空转的观察者。
 *   3. **滚动只由这一层容器承担，且是 `overflow: auto`**：空数据、只有表头时不会出现常驻
 *      滚动条。不要给表格任何 `overflow-y: scroll` 或固定表体高度——那会让空表也挂着滚动条。
 *
 * 列显隐、排序、行选择默认关闭：只在对应 `enable*` 为真时渲染控件与状态，
 * 关闭时不多挂一个按钮或一列。
 */

import {
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type Cell,
  type Column,
  type ColumnDef,
  type Header,
  type ColumnPinningState,
  type ColumnVisibilityState,
  type RowData,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '../lib/utils';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
} from 'react';

/**
 * 本表启用的 feature：列固定、列尺寸（`getStart`/`getAfter` 的家）、列显隐、
 * 排序与行选择。筛选/分组/分页/展开**故意不在此列**。
 */
const DATA_TABLE_FEATURES = tableFeatures({
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

export type DataTableFeatures = typeof DATA_TABLE_FEATURES;

/**
 * 列定义：TanStack 的 `ColumnDef` + 本仓的 `pinned` 声明。
 *
 * 固定写在列定义上而不是另传一份 `ColumnPinningState`，是为了让「哪一列钉住」
 * 与「这一列多宽」待在同一个对象里——静态守卫能直接扫这段源码，
 * 调用方也不会把两个列表写漂移。组件内部再把它翻成 TanStack 要的
 * `{ start, end }`。
 */
export type DataTableColumn<TData extends RowData> = ColumnDef<DataTableFeatures, TData> & {
  /** 钉在起始侧（LTR 即左侧）或结束侧（右侧）；省略即不固定 */
  pinned?: 'start' | 'end';
};

/**
 * 挂在表行与单元格上的额外属性。
 *
 * 表格的**业务身份**（`data-testid`、选中态、行点击 / 键盘语义）不属于列定义，也不能由
 * 单元格内容冒充：好几处调用方（用例 / 评测列表的行选择、评分详情的达成态、排名表的列序断言）
 * 都在 `<tr>` / `<td>` 本身上读它。故开两个口子把属性落到正确的元素上，而不是让每个调用方
 * 退回去手搭表格。
 */
export type DataTableRowAttributes = Omit<HTMLAttributes<HTMLTableRowElement>, 'children'> & {
  [key: `data-${string}`]: unknown;
};

export type DataTableCellAttributes = Omit<TdHTMLAttributes<HTMLTableCellElement>, 'children'> & {
  [key: `data-${string}`]: unknown;
};

export type DataTableElementAttributes = Omit<HTMLAttributes<HTMLTableElement>, 'children'> & {
  [key: `data-${string}`]: unknown;
};

/** 选中列的内部 id 与宽度（固定在最左，跟随列显隐/排序不参与） */
const SELECTION_COLUMN_ID = '__select';
const SELECTION_COLUMN_WIDTH = 40;

/**
 * 滚动容器的三条不变量：
 * `flex: 1` 吃掉剩余高度、`minHeight: 0` 允许收缩、`overflow: auto` 只在需要时出滚动条。
 */
export const DATA_TABLE_SCROLL_STYLE = { flex: 1, minHeight: '0px', overflow: 'auto' } as const;

/** 列 id 的解析口径必须与 TanStack 一致：显式 `id` → `accessorKey` → 字符串表头 */
function columnIdOf<TData extends RowData>(column: DataTableColumn<TData>): string {
  if (column.id !== undefined) return column.id;
  if ('accessorKey' in column && typeof column.accessorKey === 'string') return column.accessorKey;
  if (typeof column.header === 'string') return column.header;
  throw new Error('数据表：显示列必须声明 id（否则无法声明固定位置，也无法稳定标识列）');
}

/**
 * 找出「钉住但没声明 size」的列 id。
 *
 * 这是固定列唯一的硬前提：偏移是声明宽度之和，缺了 `size` 时 TanStack 会回落到
 * 默认 150px，表格照样渲染，只是固定的位置与真实列宽错开——没有任何报错。
 */
export function pinnedColumnsMissingSize<TData extends RowData>(
  columns: ReadonlyArray<DataTableColumn<TData>>,
): string[] {
  return columns
    .filter((column) => column.pinned === 'start' || column.pinned === 'end')
    .filter((column) => {
      const size = column.size;
      return typeof size !== 'number' || !Number.isFinite(size) || size <= 0;
    })
    .map((column) => columnIdOf(column));
}

/** 把列定义上的 `pinned` 翻成 TanStack 的 `ColumnPinningState`（顺序即声明顺序） */
export function columnPinningOf<TData extends RowData>(
  columns: ReadonlyArray<DataTableColumn<TData>>,
): ColumnPinningState {
  return {
    start: columns.filter((column) => column.pinned === 'start').map((column) => columnIdOf(column)),
    end: columns.filter((column) => column.pinned === 'end').map((column) => columnIdOf(column)),
  };
}

/** 渲染前的硬校验：错误信息直接点名缺 `size` 的列，别让调用方去猜 */
function assertPinnedColumnsHaveSize<TData extends RowData>(
  columns: ReadonlyArray<DataTableColumn<TData>>,
): void {
  const missing = pinnedColumnsMissingSize(columns);
  if (missing.length > 0) {
    throw new Error(`数据表：钉住的列必须声明 size（缺：${missing.join('、')}）`);
  }
}

export interface DataTableProps<TData extends RowData> {
  /** 列定义；`pinned` 与 `size` 必须成对出现（见 `assertPinnedColumnsHaveSize`） */
  columns: ReadonlyArray<DataTableColumn<TData>>;
  /**
   * 「吃剩余宽度」的列 id：给了它，表宽就不再是列宽之和，而是滚动容器的实测宽度——
   * 多出来的宽度全部加到这一列，其余列保持声明像素。视觉上表格铺满容器，右侧不再有空白。
   *
   * 量不到容器宽（jsdom 的 `clientWidth === 0`、无 `ResizeObserver`）或容器比列宽之和还窄时
   * 不放大：退回原行为（表宽 = 列宽之和 + 横向滚动）。固定列的偏移仍按 TanStack 的声明宽度算，
   * 因为放大发生在**列定义**这一层，`getStart()` 读到的就是放大后的值。
   */
  fillColumnId?: string;
  /** 只读数据；引用变化会触发 TanStack 重算行模型，调用方应保持引用稳定 */
  data: ReadonlyArray<TData>;
  /** 行的稳定键（同时用作 TanStack 的 row id 与虚拟列表的 item key） */
  rowKey: (row: TData, index: number) => string;
  /** 固定行高（px）。虚拟化的估算与 spacer 高度都来自它 */
  rowHeight?: number;
  /** 表头高度（px） */
  headerHeight?: number;
  /**
   * 视口高度（px）。给了就用它作为虚拟化的滚动视口，不再依赖 DOM 实测；
   * 真实页面通常省略，让容器从父级 flex 拿到高度。
   */
  viewportHeight?: number;
  /** 滚动容器的额外内联样式（例如给横向滚动条留一条下内边距） */
  scrollStyle?: CSSProperties;
  /** 可视区外多渲染几行，滚动时减少白屏 */
  overscan?: number;
  /** 空数据时表体里显示的内容 */
  emptyText?: ReactNode;
  /** 是否渲染表头（默认 true）；无表头的编辑器表把它关掉 */
  showHeader?: boolean;
  /**
   * 是否按固定行高做行虚拟化（默认 true）。
   * 行高由内容决定的表（评分目标会折行、行下还挂结果行）关掉它：虚拟化的 spacer 与定位
   * 都以固定行高为前提，行真的变高时后面的行会整体错位。
   */
  virtualize?: boolean;
  /** 打开排序（默认关）：表头可点击，按列定义里的 `sortFn` / 默认排序函数排 */
  enableSorting?: boolean;
  /** 初始排序态（默认不排）；只作为挂载时的初值，之后由组件自己持有 */
  defaultSorting?: SortingState;
  /** 打开列显隐（默认关）：表头上方出现一排列复选框 */
  enableColumnVisibility?: boolean;
  /** 打开行选择（默认关）：最左侧多一列复选框，并固定 */
  enableRowSelection?: boolean;
  /** 行选择变化时回调选中的 row id */
  onSelectionChange?: (selectedRowIds: string[]) => void;
  /** 行上的额外属性：测试标识、选中态、行点击 / 键盘语义（见 `DataTableRowAttributes`） */
  rowAttributes?: (row: TData, index: number) => DataTableRowAttributes | undefined;
  /** 单元格上的额外属性：按列 id 给（见 `DataTableCellAttributes`） */
  cellAttributes?: (row: TData, columnId: string) => DataTableCellAttributes | undefined;
  /**
   * 紧跟在该行之后的附加行（`colSpan` 占满整行）。
   * 给表格加展开列会改变「哪一列吃剩余宽度」；行内结果（如 MCP 探活结论）用这一支留在原地。
   */
  renderRowAfter?: (row: TData, index: number) => ReactNode;
  /** 表格本体的额外属性（`data-testid`、`aria-busy` 等） */
  tableAttributes?: DataTableElementAttributes;
  /** 表格的无障碍名称 */
  ariaLabel?: string;
}

function sortIndicator(direction: false | 'asc' | 'desc'): string {
  if (direction === 'asc') return ' ↑';
  if (direction === 'desc') return ' ↓';
  return '';
}

function sortAriaValue(direction: false | 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (direction === 'asc') return 'ascending';
  if (direction === 'desc') return 'descending';
  return 'none';
}

/**
 * 直接调用列定义里的单元格 / 表头渲染函数，而不是走 `<table.FlexRender>`。
 *
 * 为什么：`flexRender` 把**渲染函数本身**当成组件类型（`<cellFn {...context} />`）。
 * 调用方每次 render 重建 `columns` 数组时，那些函数就是新的类型 ⇒ React 会把整格子树卸载再挂载。
 * 行内编辑器（键值表、评分标准项、模型能力格）的症状是**每敲一个字输入框就换一个 DOM 节点**，
 * 焦点与光标一起丢。直接调用拿到的是函数返回的元素，类型来自它自己（`<Input>` 等），引用变化不再重挂。
 *
 * 单元格渲染函数里不许用 hook —— 它不是组件（TanStack 的 `cell` 回调同样按这个约定写）。
 */
function renderCellContent<TData extends RowData>(
  cell: Cell<DataTableFeatures, TData, unknown>,
): ReactNode {
  const render = cell.column.columnDef.cell;
  return typeof render === 'function' ? render(cell.getContext()) : render;
}

/** 表头同上：字符串表头原样返回，函数表头直接调用 */
function renderHeaderContent<TData extends RowData>(
  header: Header<DataTableFeatures, TData, unknown>,
): ReactNode {
  const render = header.column.columnDef.header;
  const context = header.getContext();
  return typeof render === 'function' ? render(context) : render;
}

/** 单元格/表头共用的几何：宽度与吸边偏移都只从列声明来 */
function cellStyle<TData extends RowData>(
  column: Column<DataTableFeatures, TData, unknown>,
  header: boolean,
): CSSProperties {
  const pinned = column.getIsPinned();
  return {
    width: column.getSize(),
    minWidth: column.getSize(),
    maxWidth: column.getSize(),
    position: pinned === false ? undefined : 'sticky',
    left: pinned === 'start' ? column.getStart('start') : undefined,
    right: pinned === 'end' ? column.getAfter('end') : undefined,
    // 吸边的格子必须盖住从下面滑过的中间列；表头再高一层
    zIndex: pinned === false ? undefined : header ? 2 : 1,
  };
}

export function DataTable<TData extends RowData>({
  columns,
  fillColumnId,
  data,
  rowKey,
  rowHeight = 36,
  headerHeight = 36,
  viewportHeight,
  scrollStyle: scrollStyleOverride,
  overscan = 8,
  emptyText = '暂无数据',
  showHeader = true,
  virtualize = true,
  enableSorting = false,
  defaultSorting,
  enableColumnVisibility = false,
  enableRowSelection = false,
  onSelectionChange,
  rowAttributes,
  cellAttributes,
  renderRowAfter,
  tableAttributes,
  ariaLabel,
}: DataTableProps<TData>): ReactNode {
  const [sorting, setSorting] = useState<SortingState>(defaultSorting ?? []);
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({});
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /**
   * 滚动容器的实测宽度，只服务于 `fillColumnId`。
   * 量不到就保持 0（jsdom 的 `clientWidth` 恒为 0、环境无 `ResizeObserver`）⇒ 不放大任何列，
   * 表格退回「列宽之和」的原行为，用例里的固定列偏移与虚拟化不受影响。
   */
  const [availableWidth, setAvailableWidth] = useState(0);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const measure = (): void => {
      const width = node.clientWidth;
      if (width > 0) setAvailableWidth(width);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /** 选中列只随开关出现一次；表头/单元格从 table 上下文取状态，不闭包外部值 */
  const selectionColumn = useMemo<DataTableColumn<TData>>(
    () => ({
      id: SELECTION_COLUMN_ID,
      header: ({ table }) => (
        <input
          type="checkbox"
          aria-label="全选"
          checked={table.getIsAllRowsSelected()}
          onChange={table.getToggleAllRowsSelectedHandler()}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          aria-label="选择该行"
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={row.getToggleSelectedHandler()}
        />
      ),
      size: SELECTION_COLUMN_WIDTH,
      pinned: 'start',
      enableSorting: false,
      enableHiding: false,
    }),
    [],
  );

  /** 实际列 = 可选的选中列 + 调用方列；固定偏移的输入必须在这一步就齐全 */
  const effectiveColumns = useMemo(
    () => (enableRowSelection ? [selectionColumn, ...columns] : [...columns]),
    [columns, enableRowSelection, selectionColumn],
  );

  // 在 useTable 之前失败：错误信息里能直接写出列名，而不是让 TanStack 用默认宽度静默渲染
  assertPinnedColumnsHaveSize(effectiveColumns);

  /** 可见列的声明宽度之和；隐藏列不参与，否则隐藏一列会把剩余宽度算少 */
  const declaredWidth = useMemo(
    () =>
      effectiveColumns.reduce((sum, column) => {
        if (columnVisibility[columnIdOf(column)] === false) return sum;
        return sum + (typeof column.size === 'number' ? column.size : 150);
      }, 0),
    [effectiveColumns, columnVisibility],
  );

  /**
   * 把容器多出来的宽度全部加到 `fillColumnId` 这一列。
   * 放大放在**列定义**层而不是 `<table>` 的宽度样式上：`cellStyle`、`colgroup` 与
   * TanStack 的固定列偏移都读 `column.getSize()`，只改表格宽度会让三者互相错位。
   */
  const laidOutColumns = useMemo(() => {
    if (fillColumnId === undefined || availableWidth <= declaredWidth) return effectiveColumns;
    const extra = availableWidth - declaredWidth;
    return effectiveColumns.map((column) =>
      columnIdOf(column) === fillColumnId
        ? { ...column, size: (typeof column.size === 'number' ? column.size : 150) + extra }
        : column,
    );
  }, [availableWidth, declaredWidth, effectiveColumns, fillColumnId]);

  const columnPinning = useMemo(() => columnPinningOf(effectiveColumns), [effectiveColumns]);

  const table = useTable({
    features: DATA_TABLE_FEATURES,
    columns: laidOutColumns,
    data,
    getRowId: (row, index) => rowKey(row, index),
    state: { sorting, columnVisibility, rowSelection, columnPinning },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    enableSorting,
    enableRowSelection,
    enableColumnPinning: true,
  });

  // 把选中行 id 交给调用方；放在 effect 里避免在 setState 更新函数里做副作用
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  }, [onSelectionChange]);
  const selectedRowIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection],
  );
  useEffect(() => {
    if (!enableRowSelection) return;
    onSelectionChangeRef.current?.(selectedRowIds);
  }, [enableRowSelection, selectedRowIds]);

  const rows = table.getRowModel().rows;
  const visibleLeafColumns = table.getVisibleLeafColumns();

  /** 给了视口高度就固定用它（jsdom/嵌入式都确定）；否则观察真实滚动容器 */
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index) => rows[index]?.id ?? String(index),
    ...(viewportHeight === undefined
      ? {}
      : {
        initialRect: { width: 0, height: viewportHeight },
        observeElementRect: (_instance: unknown, callback: (rect: { width: number; height: number }) => void) => {
          callback({ width: 0, height: viewportHeight });
        },
      }),
  });

  const virtualItems = virtualizer.getVirtualItems();
  // 可视区外只多渲染 overscan 行；没有视口高度时同样不会白屏（至少这一段仍可交互）。
  // 调用方关掉虚拟化（行高由内容决定）时，spacer 与定位一并跳过——它们都以固定行高为前提
  const isVirtualized = virtualize && virtualItems.length > 0 && virtualItems.length < rows.length;
  const firstVirtual = virtualItems[0];
  const lastVirtual = virtualItems[virtualItems.length - 1];
  const topSpacer = isVirtualized && firstVirtual !== undefined ? firstVirtual.start : 0;
  const bottomSpacer =
    isVirtualized && lastVirtual !== undefined ? virtualizer.getTotalSize() - lastVirtual.end : 0;
  const renderedRows = isVirtualized
    ? virtualItems.flatMap((item) => {
      const row = rows[item.index];
      return row === undefined ? [] : [row];
    })
    : rows;

  // `flex: 1` 与旧滚动容器同义：调用方把它放进纵向 Flex 栏时，表格吃掉工具栏剩下的高度；
  // 放进普通块级容器（卡片 / 弹窗）时 flex 不生效，高度照旧由内容决定
  const rootStyle: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };
  const scrollStyle: CSSProperties =
    viewportHeight === undefined
      ? { ...DATA_TABLE_SCROLL_STYLE, ...scrollStyleOverride }
      : { ...DATA_TABLE_SCROLL_STYLE, flex: '0 0 auto', height: viewportHeight, ...scrollStyleOverride };

  return (
    <div style={rootStyle}>
      {enableColumnVisibility ? (
        <div data-testid="data-table-visibility" className="flex flex-wrap items-center gap-3 border-b border-border px-2 py-1">
          {table
            .getAllLeafColumns()
            .filter((column) => column.getCanHide())
            .map((column) => (
              <label key={column.id} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                />
                {typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id}
              </label>
            ))}
        </div>
      ) : null}

      <div ref={scrollRef} data-testid="data-table-scroll" style={scrollStyle}>
        <table
          aria-label={ariaLabel}
          {...tableAttributes}
          style={{
            width: table.getTotalSize(),
            tableLayout: 'fixed',
            borderCollapse: 'collapse',
            ...tableAttributes?.style,
          }}
        >
          <colgroup>
            {visibleLeafColumns.map((column) => (
              <col key={column.id} style={{ width: column.getSize() }} />
            ))}
          </colgroup>
          {showHeader ? (
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const direction = header.column.getIsSorted();
                    const sortable = enableSorting && header.column.getCanSort();
                    return (
                      <th
                        key={header.id}
                        colSpan={header.colSpan}
                        data-column-id={header.column.id}
                        aria-sort={sortable ? sortAriaValue(direction) : undefined}
                        className="border-b border-border bg-background px-2 text-left align-middle font-medium"
                        style={{ ...cellStyle(header.column, true), height: headerHeight }}
                      >
                        {header.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            // 排序表头是**按钮**，但本仓没引 preflight：不显式复位就会画成 UA 的
                            // 灰底 3D 控件（2px outset、13.33px 字号），整排表头像没做完的 HTML。
                            className="inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left text-[length:inherit] text-inherit hover:text-foreground/80"
                          >
                            {renderHeaderContent(header)}
                            {sortIndicator(direction)}
                          </button>
                        ) : (
                          renderHeaderContent(header)
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
          ) : null}
          <tbody data-virtualized={isVirtualized ? 'true' : 'false'}>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={Math.max(visibleLeafColumns.length, 1)}
                  data-testid="data-table-empty"
                  className="px-2 py-6 text-center text-muted-foreground"
                >
                  {emptyText}
                </td>
              </tr>
            ) : (
              <>
                {topSpacer > 0 ? (
                  <tr data-virtual-spacer aria-hidden>
                    <td
                      colSpan={visibleLeafColumns.length}
                      style={{ height: topSpacer, padding: 0, border: 0 }}
                    />
                  </tr>
                ) : null}
                {renderedRows.flatMap((row) => {
                  const rowAttrs = rowAttributes?.(row.original, row.index);
                  const after = renderRowAfter?.(row.original, row.index);
                  const bodyRow = (
                    <tr
                      key={row.id}
                      data-row
                      data-row-index={row.index}
                      {...rowAttrs}
                      style={{ height: rowHeight, ...rowAttrs?.style }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const cellAttrs = cellAttributes?.(row.original, cell.column.id);
                        return (
                          <td
                            key={cell.id}
                            data-column-id={cell.column.id}
                            {...cellAttrs}
                            className={cn(
                              'border-b border-border bg-background px-2 align-middle',
                              cellAttrs?.className,
                            )}
                            style={{
                              ...cellStyle(cell.column, false),
                              height: rowHeight,
                              ...cellAttrs?.style,
                            }}
                          >
                            {renderCellContent(cell)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                  if (after === undefined || after === null) return [bodyRow];
                  return [
                    bodyRow,
                    <tr key={`${row.id}-detail`} data-row-detail>
                      <td
                        colSpan={Math.max(visibleLeafColumns.length, 1)}
                        className="border-b border-border bg-background px-2 align-middle"
                      >
                        {after}
                      </td>
                    </tr>,
                  ];
                })}
                {bottomSpacer > 0 ? (
                  <tr data-virtual-spacer aria-hidden>
                    <td
                      colSpan={visibleLeafColumns.length}
                      style={{ height: bottomSpacer, padding: 0, border: 0 }}
                    />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
