/**
 * ProviderTable：列内容、协议中文标签、四个回调、「模型」按钮的位置与顺序、删除的二次确认、
 * 空态引导，以及两条形态守卫（掩码列不渲染、新增按钮在表格左下方）。
 * 注意：本文件所有断言都走「用户能看到什么」，不查 antd 的类名 —— 类名会随版本静默变化，
 * 而这里要钉的是「误点一次不会把供应商删掉」这类行为。
 * 唯二的例外是两条形态守卫里的 `ant-btn-variant-dashed`：antd 6 会把单给的 `variant` **静默**
 * 降级成实线，除了类名没有任何可观察信号（详见那两条用例的注释）。
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
   * 「模型」按钮（用户口径 2026-09-30）：模型清单从编辑弹窗里独立成对话框之后，这里是它的入口。
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
