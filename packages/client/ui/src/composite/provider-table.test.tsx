/**
 * ProviderTable：列内容、协议中文标签、四个回调、「模型」按钮的位置与顺序、删除的二次确认、
 * 空态引导，以及四条形态守卫（掩码列不渲染、新增按钮在表格左下方、两侧固定列、新增入口虚线）。
 * 注意：本文件所有断言都走「用户能看到什么」，不查 antd 的类名 —— 类名会随版本静默变化，
 * 而这里要钉的是「误点一次不会把供应商删掉」这类行为。
 * 例外的两处都是「除了类名没有任何可观察信号」：
 *   · `ant-btn-variant-dashed`：antd 6 会把单给的 `variant` **静默**降级成实线；
 *   · `ant-table-cell-fix-start` / `-fix-end`：jsdom 读不到样式表里的 `position: sticky`，
 *     类名是「这一列到底钉没钉」唯一可断言的东西（吸边效果同样只有真机量得出来）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { ProviderTable } from './provider-table';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 没有 ResizeObserver，而 antd 的 Table 与 Typography 的 ellipsis 内部会直接 new 它
// （见 src/testing/resize-observer.ts）：不打桩，挂载即抛 ReferenceError。
beforeEach(() => {
  installResizeObserverStub();
});

const openai: ProviderView = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKeyMasked: 'sk-***mnop',
  models: [
    { id: 'deepseek-chat', source: 'manual' },
    { id: 'deepseek-reasoner', source: 'fetched' },
  ],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
};

const anthropic: ProviderView = {
  ...openai,
  id: 'p-2',
  name: 'Anthropic 官方',
  protocolType: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKeyMasked: 'sk-***wxyz',
  models: [],
};

const noop = (): void => {};

describe('ProviderTable', () => {
  it('每行显示名称 / 协议中文标签 / 模型数（掩码列已隐藏）', () => {
    render(
      <ProviderTable providers={[openai, anthropic]} onModels={noop} onEdit={noop} onDelete={noop} onCreate={noop} />,
    );

    expect(screen.getByText('DeepSeek 官方')).toBeInTheDocument();
    // 协议列用 contracts 的中文标签（不在这里抄第二份文案）
    expect(screen.getByText(PROTOCOL_LABELS.openai)).toBeInTheDocument();
    expect(screen.getByText(PROTOCOL_LABELS.anthropic)).toBeInTheDocument();
    // 掩码列是**刻意隐藏**的（用户口径，见组件文件头第 5 点）：表头与那串掩码都不该出现。
    // 反向钉住才拦得住「顺手把列加回来」——加回来时页面照常可用，只有这条会红。
    expect(screen.queryByText('密钥掩码')).toBeNull();
    expect(screen.queryByText('sk-***mnop')).toBeNull();

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // 表头 + 两条
    expect(within(rows[1] as HTMLElement).getByText('2')).toBeInTheDocument(); // openai：2 个模型
    expect(within(rows[2] as HTMLElement).getByText('0')).toBeInTheDocument(); // anthropic：0 个
  });

  it('点「编辑」把整条供应商回给调用方', () => {
    const onEdit = vi.fn();
    render(<ProviderTable providers={[openai]} onModels={noop} onEdit={onEdit} onDelete={noop} onCreate={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    expect(onEdit).toHaveBeenCalledWith(openai);
  });

  /**
   * 「模型」按钮：模型清单从编辑弹窗里独立成对话框之后，这里是它的入口。
   * 两条都要钉 —— 回调漏接（点了没反应）与**位置**（它必须排在「编辑」之前、且与「删除」隔开）。
   * 位置只能靠 DOM 顺序断言：jsdom 不做布局，几何在这里不可达。
   */
  it('点「模型」把整条供应商回给调用方', () => {
    const onModels = vi.fn();
    render(<ProviderTable providers={[openai]} onModels={onModels} onEdit={noop} onDelete={noop} onCreate={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '模型' }));

    expect(onModels).toHaveBeenCalledWith(openai);
  });

  it('操作列顺序是 模型 → 编辑 → 删除（高频入口在前，破坏性动作在最后）', () => {
    render(<ProviderTable providers={[openai]} onModels={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    const names = ['模型', '编辑', '删除'];
    const buttons = names.map((name) => screen.getByRole('button', { name }));
    for (let index = 1; index < buttons.length; index += 1) {
      // `DOCUMENT_POSITION_FOLLOWING`：后一个按钮在 DOM 里排在前一个之后
      expect(buttons[index - 1]?.compareDocumentPosition(buttons[index] as HTMLElement)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    // 三个都是两个汉字：漏一个 `autoInsertSpace={false}`，可访问名就会变成「模 型」而这条失配
    expect(screen.getAllByRole('button', { name: /^[^ ]{2}$/ })).toHaveLength(3);
  });

  it('删除必须过一次 Popconfirm：只点「删除」不触发，点「确认删除」才触发', async () => {
    const onDelete = vi.fn();
    render(<ProviderTable providers={[openai]} onModels={noop} onEdit={noop} onDelete={onDelete} onCreate={noop} />);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onDelete).not.toHaveBeenCalled();

    // 浮层里的确认按钮必须显式给中文：应用没有配 antd locale，默认是 "OK" / "Cancel"
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));

    expect(onDelete).toHaveBeenCalledWith(openai);
  });

  it('空列表给引导动作，点它触发 onCreate', () => {
    const onCreate = vi.fn();
    render(<ProviderTable providers={[]} onModels={noop} onEdit={noop} onDelete={noop} onCreate={onCreate} />);

    expect(screen.getByText('还没有供应商')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加第一个供应商' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('表格左下方的「添加供应商」触发 onCreate，且它在 DOM 里排在表格之后', () => {
    const onCreate = vi.fn();
    const { container } = render(<ProviderTable providers={[openai]} onModels={noop} onEdit={noop} onDelete={noop} onCreate={onCreate} />);

    const button = screen.getByRole('button', { name: '添加供应商' });
    fireEvent.click(button);

    expect(onCreate).toHaveBeenCalledTimes(1);
    // 位置的守卫只能靠 DOM 顺序：jsdom 不做布局，几何断言（左右上下）在这里不可达。
    // 这一条钉的是「它不再在工具条里、而是在表格之后」——有人把它挪回标题那一行时会红。
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.compareDocumentPosition(button)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  /**
   * 形态守卫（与 `RunCreatePanel` 候选行表同款）：卡片窄到装不下五列时，
   * 表格**内部**横向滚动，`名称` 钉在左边、`操作` 钉在右边（中间三列从它们下面滑过）。
   * 三处必须同时在场，少一处就静默退回老样子 —— `名称` 与三个按钮跟着滚出视野：
   *   · 没有 `scroll={{ x: 数值 }}` ⇒ 内容容器拿不到 `overflow-x: auto`、表格也没有内联宽度；
   *   · 首列没有 `fixed` ⇒ 表头第一格不再带粘性类；
   *   · 操作列没有 `fixed` ⇒ 表头最后一格不再带粘性类（那一行的编辑 / 删除跟着滚走）。
   *
   * ⚠️ jsdom **没有布局引擎**：`sticky` 的实际吸边效果、「有没有真的滚起来」都量不出来，钉子只到
   * 类名、内联样式与 `colgroup` 的宽度为止（jsdom 的 `getComputedStyle` 只认内联样式，读不到样式表
   * 里的 `.ant-table-cell-fix { position: sticky }`，故这里断言的是类名而不是算出来的 `position`）。
   * 真实几何只能真机冒烟看，同 `PROVIDER_TABLE_MIN_WIDTH` 那条注释。
   */
  it('卡片装不下时横向滚动，且名称列钉左、操作列钉右（P-COLUMN-FIXED）', () => {
    const { container } = render(
      <ProviderTable providers={[openai, anthropic]} onModels={noop} onEdit={noop} onDelete={noop} onCreate={noop} />,
    );

    const content = container.querySelector('.ant-table-content');
    expect(content).not.toBeNull();
    // 有横向滚动才谈得上固定列：给 `scroll.x` 之前这里一个内联样式都没有
    expect(content).toHaveStyle({ overflowX: 'auto' });
    const table = content?.querySelector('table');
    // 最小宽度必须真的落到**表格自己**的宽度上（它才是滚动的那个更宽的盒子）：
    // `min-width: 100%` 保证卡片够宽时铺满、不给滚动条，不是恒定的 900
    expect(table).toHaveStyle({ width: '900px', minWidth: '100%', tableLayout: 'fixed' });

    const headers = content?.querySelectorAll('thead th');
    expect(headers).toHaveLength(5);
    // 首列与操作列刚需的两条粘性类（`-fix-start` / `-fix-end` 就是 `position: sticky` 的来源）
    expect(headers?.[0]?.className).toContain('ant-table-cell-fix-start');
    expect(headers?.[4]?.className).toContain('ant-table-cell-fix-end');
    // 中间三列**不许**粘：把地址列也钉住的话，可滚动区域就只剩协议与模型数两列
    for (const index of [1, 2, 3]) {
      expect(headers?.[index]?.className).not.toContain('ant-table-cell-fix');
    }
    // 表体跟着一起钉（只钉表头的话，数据行会在固定列底下滑过去 —— 滚动时表头与数据行错位）
    const bodyCells = content?.querySelector('tbody tr.ant-table-row')?.querySelectorAll('td');
    expect(bodyCells?.[0]?.className).toContain('ant-table-cell-fix-start');
    expect(bodyCells?.[4]?.className).toContain('ant-table-cell-fix-end');

    // 四列把宽度交出去，剩下的才归「API 地址」（它**刻意不给宽度**，是唯一吃剩余宽度的列）。
    // jsdom 量不出地址列的实测宽度：`colgroup` 里那些数字来自 rc-table 对单元格的 ResizeObserver
    // 测量（`MeasureCell`），而 `installResizeObserverStub` 的替身**从不回调** —— 于是这里只钉得住
    // 「四列各自申报的宽度」与「地址列一列都没申报」。
    const widths = Array.from(content?.querySelectorAll('colgroup col') ?? []).map(
      (cell) => (cell as HTMLElement).style.width,
    );
    expect(widths).toEqual(['180px', '150px', '', '90px', '200px']);
  });

  /**
   * 形态守卫：本组件的两个创建 / 添加入口（表格下方 + 空态）都必须是「前导加号 + 虚线边框」。
   * 为什么钉类名而不是钉截图：`variant="dashed"` 漏掉配对的 `color="default"` 时会**静默**渲染成实线
   * （antd 6 只在 `color && variant` 同时存在时才用它们，否则回落到 `['default','outlined']`），
   * 界面照常可用、控制台一声不响 —— 只有断言类名才拦得住。
   */
  it('两个新增入口都是加号 + 虚线（全站新增形态），且图标不污染可访问名', () => {
    render(<ProviderTable providers={[]} onModels={noop} onEdit={noop} onDelete={noop} onCreate={noop} />);

    for (const name of ['添加供应商', '添加第一个供应商']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).toContain('ant-btn-variant-dashed');
      expect(button.querySelector('.anticon-plus')).toHaveAttribute('aria-hidden', 'true');
    }
  });
});
