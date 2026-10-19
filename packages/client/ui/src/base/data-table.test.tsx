/**
 * `DataTable` 的四条判据：
 *   ① 固定列的吸边偏移来自列定义里声明的 `size`，左右两侧分别走
 *      `column.getStart('start')` / `column.getAfter('end')`；
 *   ② 500 行数据只渲染可视行（行虚拟化）；
 *   ③ 空数据不产生常驻滚动条（滚动容器只在内容溢出时才滚）；
 *   ④ 钉住的列必须声明 `size`——缺了就没有可靠的偏移输入，必须当场报错。
 *
 * jsdom 没有布局引擎：①②③ 里真正的几何效果（吸边是否对齐、滚动条是否出现）
 * 只能在真实浏览器里量；这里钉的是组件的结构输出与退化路径。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  DATA_TABLE_SCROLL_STYLE,
  DataTable,
  pinnedColumnsMissingSize,
  type DataTableColumn,
} from './data-table';

interface DemoRow {
  id: string;
  name: string;
  code: string;
  middle: string;
  actions: string;
  status: string;
}

const COLUMNS: DataTableColumn<DemoRow>[] = [
  { id: 'name', header: '名称', accessorKey: 'name', size: 160, pinned: 'start' },
  { id: 'code', header: '编号', accessorKey: 'code', size: 120, pinned: 'start' },
  { id: 'middle', header: '中间', accessorKey: 'middle', size: 240 },
  { id: 'actions', header: '操作', accessorKey: 'actions', size: 80, pinned: 'end' },
  { id: 'status', header: '状态', accessorKey: 'status', size: 100, pinned: 'end' },
];

const ONE_ROW: DemoRow[] = [
  { id: 'row-1', name: '名称一', code: 'C-1', middle: '中间内容', actions: '编辑', status: '完成' },
];

function headerCell(columnId: string): HTMLElement {
  const cell = document.querySelector<HTMLElement>(`th[data-column-id="${columnId}"]`);
  if (cell === null) throw new Error(`找不到列头 ${columnId}`);
  return cell;
}

describe('DataTable 固定列', () => {
  it('左右固定列按声明的 size 计算 sticky 偏移', () => {
    render(<DataTable columns={COLUMNS} data={ONE_ROW} rowKey={(row) => row.id} />);

    // 起始侧：第一列 0，第二列是前一列声明的 160px
    expect(headerCell('name').style.position).toBe('sticky');
    expect(headerCell('name').style.left).toBe('0px');
    expect(headerCell('code').style.position).toBe('sticky');
    expect(headerCell('code').style.left).toBe('160px');

    // 中间列不吸边
    expect(headerCell('middle').style.position).not.toBe('sticky');

    // 结束侧：最右列 0，左边一列是它右侧列的 100px（getAfter('end')）
    expect(headerCell('status').style.position).toBe('sticky');
    expect(headerCell('status').style.right).toBe('0px');
    expect(headerCell('actions').style.position).toBe('sticky');
    expect(headerCell('actions').style.right).toBe('100px');

    // 每个格子的宽度也来自同一份声明，偏移与实际列宽不会各说各话
    expect(headerCell('name').style.width).toBe('160px');
    expect(headerCell('middle').style.width).toBe('240px');
    expect(headerCell('status').style.width).toBe('100px');
  });
});

describe('DataTable 首列 / 末列的固定偏移', () => {
  /** 首尾各钉两列：偏移必须来自声明的 260 / 180 / 200 / 120，而不是 DOM 实测或默认 150 */
  interface EdgeRow {
    id: string;
    first: string;
    second: string;
    middle: string;
    last: string;
    tail: string;
  }

  const edgeColumns: DataTableColumn<EdgeRow>[] = [
    { id: 'first', header: '首列', accessorKey: 'first', size: 260, pinned: 'start' },
    { id: 'second', header: '次列', accessorKey: 'second', size: 180, pinned: 'start' },
    { id: 'middle', header: '中间', accessorKey: 'middle', size: 240 },
    { id: 'last', header: '末列', accessorKey: 'last', size: 200, pinned: 'end' },
    { id: 'tail', header: '尾列', accessorKey: 'tail', size: 120, pinned: 'end' },
  ];
  const edgeRows: EdgeRow[] = [
    { id: 'row-1', first: '一', second: '二', middle: '三', last: '四', tail: '五' },
  ];

  it('首列的 left 与末列的 right 都是 0，相邻固定列的偏移等于声明宽度', () => {
    render(<DataTable columns={edgeColumns} data={edgeRows} rowKey={(row) => row.id} />);

    // 起始侧：首列 0，次列偏移 = 首列声明的 260
    expect(headerCell('first').style.left).toBe('0px');
    expect(headerCell('second').style.left).toBe('260px');
    // 结束侧：末列 0，左边一列偏移 = 末列声明的 200
    expect(headerCell('tail').style.right).toBe('0px');
    expect(headerCell('last').style.right).toBe('120px');
    // 两列各自的宽度也来自同一份声明
    expect(headerCell('first').style.width).toBe('260px');
    expect(headerCell('tail').style.width).toBe('120px');
    // 中间列不吸边
    expect(headerCell('middle').style.position).not.toBe('sticky');
  });

  it('同一列的表头与单元格共用同一组偏移（不会一格用声明宽度、另一格用实测）', () => {
    render(<DataTable columns={edgeColumns} data={edgeRows} rowKey={(row) => row.id} />);

    const bodyCell = (id: string): HTMLElement | null =>
      document.querySelector<HTMLElement>(`td[data-column-id="${id}"]`);
    expect(bodyCell('second')?.style.left).toBe('260px');
    expect(bodyCell('last')?.style.right).toBe('120px');
    expect(bodyCell('first')?.style.width).toBe('260px');
    expect(bodyCell('tail')?.style.width).toBe('120px');
  });
});

describe('DataTable 行虚拟化', () => {
  const BIG_DATA: DemoRow[] = Array.from({ length: 500 }, (_, index) => ({
    id: `row-${index}`,
    name: `名称 ${index}`,
    code: `C-${index}`,
    middle: `中间内容 ${index}`,
    actions: '编辑',
    status: '完成',
  }));

  it('500 行数据只渲染可视行（DOM 行数远小于数据行数）', async () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={BIG_DATA}
        rowKey={(row) => row.id}
        viewportHeight={320}
        rowHeight={32}
      />,
    );

    await waitFor(() => {
      expect(document.querySelectorAll('tr[data-row]').length).toBeGreaterThan(0);
    });

    const rendered = document.querySelectorAll('tr[data-row]').length;
    expect(rendered).toBeLessThan(100);
    expect(BIG_DATA.length).toBe(500);
    expect(document.querySelector('tbody')?.getAttribute('data-virtualized')).toBe('true');
    // 上下 spacer 之外，DOM 里确实只有一小段可视行
    expect(document.querySelectorAll('tr[data-virtual-spacer]').length).toBeLessThanOrEqual(2);
  });
});

describe('DataTable 空数据', () => {
  it('空数据时滚动容器的 overflow 不是 scroll（不产生常驻滚动条）', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        rowKey={(row) => row.id}
        viewportHeight={200}
        emptyText="没有数据"
      />,
    );

    const scroll = screen.getByTestId('data-table-scroll');
    // 这三条与旧 TableScrollArea 同源：少一条就会「空表也挂着滚动条」或「长表滚不动」
    expect(DATA_TABLE_SCROLL_STYLE).toEqual({ flex: 1, minHeight: '0px', overflow: 'auto' });
    expect(scroll.style.overflow).toBe('auto');
    expect(scroll.style.minHeight).toBe('0px');

    // 空表体里没有虚拟化的占位行，也不该出现 `overflow-y: scroll` 那种常驻滚动条
    expect(screen.getByText('没有数据')).toBeInTheDocument();
    expect(document.querySelectorAll('tr[data-virtual-spacer]').length).toBe(0);
    expect(document.querySelectorAll('tr[data-row]').length).toBe(0);
    expect(scroll.style.overflowY).not.toBe('scroll');
  });
});

describe('DataTable 固定列的 size 守卫', () => {
  it('钉住但没声明 size 的列被拒绝，并在错误里点名', () => {
    const missing: DataTableColumn<DemoRow>[] = [
      { id: 'name', header: '名称', accessorKey: 'name', pinned: 'start' },
    ];

    // 纯函数先给出名单（静态守卫与运行期校验共用同一个判据）
    expect(pinnedColumnsMissingSize(missing)).toEqual(['name']);
    // 渲染前就失败：不能等 TanStack 回落成默认 150px 再静默错位
    expect(() =>
      render(<DataTable columns={missing} data={ONE_ROW} rowKey={(row) => row.id} />),
    ).toThrow(/钉住的列必须声明 size/);
  });
});
