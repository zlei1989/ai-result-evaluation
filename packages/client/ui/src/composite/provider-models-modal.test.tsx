/**
 * ProviderModelsModal：模型清单对话框（2026-09-30 从「编辑供应商」里独立出来的那个）。
 * 覆盖：标题带供应商名、拉取、手工增删、逐条能力两格、目标消失的可见原因、
 * 以及列宽/省略号两条形态守卫（它们原先挂在 `provider-form-modal.test.tsx` 上，随组件一起搬过来）。
 *
 * 判据落在**回调收到的值**上：`null`（清空）与「没改」（回落到清单里的值）是两件事，
 * 而服务端对它们的处置相反 —— 清空会记住「这是用户的手工表态」，没改则什么都不做。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProviderView } from '@aieval/contracts';
import { ProviderModelsModal, MODEL_COLUMN_WIDTH, MODELS_MODAL_WIDTH } from './provider-models-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

const PROVIDER: ProviderView = {
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

const noop = (): void => {};

/** 一套默认 props：每个用例只覆盖自己关心的那几个 */
function renderModal(overrides: Partial<Parameters<typeof ProviderModelsModal>[0]> = {}): ReturnType<typeof render> {
  return render(
    <ProviderModelsModal
      open
      provider={PROVIDER}
      fetchingModels={false}
      onClose={noop}
      onFetchModels={noop}
      onAddModel={noop}
      onRemoveModel={noop}
      onSetModelContext={noop}
      {...overrides}
    />,
  );
}

describe('ProviderModelsModal：外框', () => {
  it('标题带供应商名（从列表点进来时未必记得点的是哪一行）', () => {
    renderModal();

    expect(screen.getByText('模型清单：DeepSeek 官方')).toBeInTheDocument();
  });

  // 这个对话框不做提交：每一次增删与拉取都是立即生效的独立请求。给它一个「确定」会让人以为
  // 不点就不保存 —— 页脚只留一个明确的出口（右上角的 × 与 Esc 照常可用）。
  it('页脚只有一个「关闭」，点它回调 onClose；没有「确定 / 取消」', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    expect(screen.queryByRole('button', { name: '确定' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('宽度是 720（模型名 + 两个输入框 + 两个图标按钮）', () => {
    renderModal();

    expect((document.querySelector('.ant-modal') as HTMLElement | null)?.style.width).toBe(
      `${MODELS_MODAL_WIDTH}px`,
    );
  });

  /**
   * 目标消失（别的标签页删了这条供应商 / CLI 改了配置 → 列表重取后按 id 查不到）：
   * 必须说清去向，而不是渲染一片空白，或者留下一个还能点、但注定 404 的按钮。
   */
  it('目标已不在列表里：给可见原因，且不渲染拉取按钮与清单', () => {
    renderModal({ provider: null });

    expect(screen.getByText('这条供应商已不在列表里')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拉取模型' })).toBeNull();
    expect(screen.queryByPlaceholderText('手工添加模型名，如 deepseek-chat')).toBeNull();
    // 标题退化成不带名字的通用标题（没有名字可写）
    expect(screen.getByText('模型清单')).toBeInTheDocument();
  });

  it('空清单给一句引导（拉取或手工添加），不渲染表格', () => {
    renderModal({ provider: { ...PROVIDER, models: [] } });

    expect(screen.getByText('还没有模型：拉取一次，或手工添加。')).toBeInTheDocument();
    expect(document.querySelector('.ant-table')).toBeNull();
  });

  it('「拉取模型」回传；拉取中按钮转圈（loading 来自 props）', () => {
    const onFetchModels = vi.fn();
    const { rerender } = renderModal({ onFetchModels });

    fireEvent.click(screen.getByRole('button', { name: '拉取模型' }));
    expect(onFetchModels).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '拉取模型' }).className).not.toMatch(/loading/);

    rerender(
      <ProviderModelsModal
        open
        provider={PROVIDER}
        fetchingModels
        onClose={noop}
        onFetchModels={onFetchModels}
        onAddModel={noop}
        onRemoveModel={noop}
        onSetModelContext={noop}
      />,
    );
    expect(screen.getByRole('button', { name: '拉取模型' }).className).toMatch(/loading/);
  });

  // 清单**不在这里存一份**（两份必然漂移）：列表一重取，props 换了新对象，表格就得跟着变。
  it('清单跟着 props 刷新（列表重取后新加的模型立刻出现）', () => {
    const { rerender } = renderModal();
    expect(screen.queryByText('brand-new')).toBeNull();

    rerender(
      <ProviderModelsModal
        open
        provider={{ ...PROVIDER, models: [...PROVIDER.models, { id: 'brand-new', source: 'manual' }] }}
        fetchingModels={false}
        onClose={noop}
        onFetchModels={noop}
        onAddModel={noop}
        onRemoveModel={noop}
        onSetModelContext={noop}
      />,
    );

    expect(screen.getByText('brand-new')).toBeInTheDocument();
  });

  it('模型清单带来源标签，点「移除」回传对应的模型名', () => {
    const onRemoveModel = vi.fn();
    renderModal({ onRemoveModel });

    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('手工维护')).toBeInTheDocument();
    expect(screen.getByText('自动拉取')).toBeInTheDocument();

    const removeButtons = screen.getAllByRole('button', { name: '移除' });
    fireEvent.click(removeButtons[1] as HTMLElement);

    expect(onRemoveModel).toHaveBeenCalledWith('deepseek-reasoner');
  });

  it('手工添加：去掉首尾空白后回传，并清空输入框', () => {
    const onAddModel = vi.fn();
    renderModal({ onAddModel });
    const input = screen.getByPlaceholderText('手工添加模型名，如 deepseek-chat');

    fireEvent.change(input, { target: { value: ' deepseek-coder ' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(onAddModel).toHaveBeenCalledWith('deepseek-coder');
    expect(input).toHaveValue('');
  });

  it('纯空白输入不触发添加（不让一个空模型名走一趟服务端）', () => {
    const onAddModel = vi.fn();
    renderModal({ onAddModel });

    fireEvent.change(screen.getByPlaceholderText('手工添加模型名，如 deepseek-chat'), {
      target: { value: '   ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    expect(onAddModel).not.toHaveBeenCalled();
  });

  // 换了一个供应商还留着上一条的草稿，点保存就是改错了对象（与表单重灌同一条口径）。
  it('换成另一个供应商时草稿重置（切回来是清单里的现值）', () => {
    const { rerender } = renderModal({
      provider: { ...PROVIDER, models: [{ id: 'm', source: 'fetched', contextWindow: 1_000 }] },
    });
    fireEvent.change(screen.getByLabelText('m 的上下文窗口'), { target: { value: '5000' } });
    expect(screen.getByLabelText('m 的上下文窗口')).toHaveValue('5000');

    const other = { ...PROVIDER, id: 'p-2', models: [{ id: 'm', source: 'fetched' as const, contextWindow: 2_000 }] };
    rerender(
      <ProviderModelsModal
        open
        provider={other}
        fetchingModels={false}
        onClose={noop}
        onFetchModels={noop}
        onAddModel={noop}
        onRemoveModel={noop}
        onSetModelContext={noop}
      />,
    );
    expect(screen.getByLabelText('m 的上下文窗口')).toHaveValue('2000');
  });
});

/**
 * 模型清单 = 一个 small Table（用户口径 2026-09-29，二稿）。
 * 列序固定 **模型 ｜ 来源 ｜ 输入 ｜ 输出 ｜ 操作**；表头隐藏（列的含义由输入框占位符与按钮承担）；
 * 两个输入框各 7em；操作列右对齐；「手工维护」不再用 Tag 表达，而是**保存图标变黄 + tooltip 说明**。
 */
describe('ProviderModelsModal：模型清单表格', () => {
  const LONG_ID = 'vendor/some-very-long-model-name-that-overflows';
  /** 第一行是「手工改过」的（`contextWindowSource: 'manual'`），第二行没改过 —— 两种保存态都要能验 */
  const twoModels = {
    ...PROVIDER,
    models: [
      { id: LONG_ID, source: 'fetched' as const, contextWindow: 262_144, maxOutputTokens: 32_768, contextWindowSource: 'manual' as const },
      { id: 'short', source: 'manual' as const },
    ],
  };

  /** 第一行的单元格（列序断言都靠它，避免每处各写一遍 querySelector） */
  const firstRowCells = (): HTMLElement[] =>
    Array.from(((document.querySelectorAll('tbody tr')[0] as HTMLElement) ?? document.createElement('tr')).querySelectorAll('td'));

  it('不渲染表头；值只在输入框里；「手工」不再是 Tag', () => {
    renderModal({ provider: twoModels });

    // 表头隐藏（用户口径）：列标题一个都不出现
    for (const header of ['模型', '来源', '输入', '输出', '操作']) {
      expect(screen.queryByText(header)).toBeNull();
    }
    expect(screen.queryByText('262K')).toBeNull(); // 大小 Tag 已删（一稿删的）
    expect(screen.queryByText('手工')).toBeNull(); // 「手工」Tag 已删（二稿删的，改由保存图标承担）
    expect(screen.getByLabelText(`${LONG_ID} 的上下文窗口`)).toHaveValue('262144');
    expect(screen.getByLabelText(`${LONG_ID} 的最大输出`)).toHaveValue('32768');
  });

  it('列序是 模型｜来源｜输入｜输出｜操作（操作在最后一列）', () => {
    renderModal({ provider: twoModels });

    const cells = firstRowCells();
    expect(cells).toHaveLength(5);
    // ① 模型：不再套 `code`（用户口径「去掉 tag 包裹」）⇒ 单元格里没有 code 元素
    expect(cells[0]?.textContent).toContain(LONG_ID);
    expect(cells[0]?.querySelector('code')).toBeNull();
    // ② 来源
    expect(cells[1]?.textContent).toContain('自动拉取');
    // ③④ 输入 / 输出：值在 input 里（textContent 为空）
    expect(cells[2]?.querySelector('input')).not.toBeNull();
    expect(cells[3]?.querySelector('input')).not.toBeNull();
    // ⑤ 操作：两个按钮，且在最后一格
    expect(cells[4]?.querySelectorAll('button')).toHaveLength(2);
  });

  it('两个输入框都是 7em 宽；操作列右对齐', () => {
    renderModal({ provider: twoModels });

    for (const label of [`${LONG_ID} 的上下文窗口`, `${LONG_ID} 的最大输出`]) {
      const wrapper = screen.getByLabelText(label).closest('.ant-input-number') as HTMLElement | null;
      expect(wrapper?.style.width).toBe('7em');
    }
    expect(firstRowCells()[4]?.style.textAlign).toBe('right');
  });

  /**
   * 列宽必须装得下「7em 的输入框 + 单元格左右各 8px 内边距」。
   *
   * 这条守卫是**实测漏出来的坑**（浏览器里量的真实几何）：原先输入列写 96px ⇒ 内容宽只有 80px，
   * 而 7em 在 14px 字号下是 98px ⇒ 输入框向右溢出 10px。td 是 `overflow: visible`（antd 不裁），
   * 于是两个输入框互相压、右边界再盖住操作列的图标按钮 —— 在界面上就是「输入框被隐藏」。
   * 字号与内边距都由 antd 的密度/主题给（本仓不手写），所以这条把 `1em = 14px`、`内边距 = 8+8`
   * 当成**常量假设**核对：谁把列宽改小到装不下 7em，这里就变红。
   */
  it('输入/输出列宽装得下 7em + 内边距；列宽真的落到 colgroup 上', () => {
    expect(MODEL_COLUMN_WIDTH.capability).toBeGreaterThanOrEqual(98 + 16);

    renderModal({ provider: twoModels });

    const widths = Array.from(document.querySelectorAll('.ant-table colgroup col')).map(
      (col) => (col as HTMLElement).style.width,
    );
    // 模型列不给宽度（吃剩余空间），其余四列按常量
    expect(widths).toEqual([
      '',
      `${MODEL_COLUMN_WIDTH.source}px`,
      `${MODEL_COLUMN_WIDTH.capability}px`,
      `${MODEL_COLUMN_WIDTH.capability}px`,
      `${MODEL_COLUMN_WIDTH.actions}px`,
    ]);
  });

  it('模型名过长时用省略号（列上开 ellipsis，长 id 不撑破弹窗）', () => {
    renderModal({ provider: twoModels });

    // ⚠️ 查 `document` 而不是 render 的 container：antd Modal 是 **portal** 渲染到 body 的，
    // 表格不在测试容器的子树里（第一版查 container 得到 0，正是这个原因）。
    expect(document.querySelectorAll('.ant-table-cell-ellipsis').length).toBeGreaterThan(0);
  });

  /**
   * 「手工维护」的唯一可视信号（二稿）：保存过的行（`contextWindowSource === 'manual'`）
   * 保存图标**变黄**、tooltip 与可访问名都说明「模型已被手工维护」。
   * 判据取可访问名而不是 tooltip 文本：Tooltip 要 hover 才进 DOM，而可访问名是它的稳定投影
   * （两者在我这里逐字相同，见实现里的 `saveHint`）。
   */
  it('手工改过的行：保存按钮变黄且可访问名带上「模型已被手工维护」；没改过的行是普通「保存窗口」', () => {
    renderModal({ provider: twoModels });

    const manualSave = screen.getByRole('button', { name: '保存窗口，模型已被手工维护' });
    expect(manualSave.className).toMatch(/gold/);
    // 没手工过的那一行仍是普通保存按钮（对照组：否则「所有行都变黄」也会全绿）
    const plainSave = screen.getByRole('button', { name: '保存窗口' });
    expect(plainSave.className).not.toMatch(/gold/);
  });

  it('改输入后点图标保存 ⇒ 回调 (modelId, { contextWindow, maxOutputTokens })', () => {
    const onSetModelContext = vi.fn();
    renderModal({ provider: twoModels, onSetModelContext });

    fireEvent.change(screen.getByLabelText('short 的上下文窗口'), { target: { value: '1000000' } });
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }));

    expect(onSetModelContext).toHaveBeenCalledWith('short', { contextWindow: 1_000_000, maxOutputTokens: null });
  });

  it('只改输出、清空输入 ⇒ 输入回 null，输出带上新值', () => {
    const onSetModelContext = vi.fn();
    renderModal({
      provider: { ...PROVIDER, models: [{ id: 'm', source: 'fetched', contextWindow: 1_048_576, maxOutputTokens: 4_096 }] },
      onSetModelContext,
    });

    fireEvent.change(screen.getByLabelText('m 的上下文窗口'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('m 的最大输出'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }));

    expect(onSetModelContext).toHaveBeenCalledWith('m', { contextWindow: null, maxOutputTokens: 8_192 });
  });

  it('没碰过任何输入就保存 ⇒ 回调回落到清单里的现值（不是「清空」）', () => {
    const onSetModelContext = vi.fn();
    renderModal({ provider: twoModels, onSetModelContext });

    fireEvent.click(screen.getByRole('button', { name: '保存窗口，模型已被手工维护' }));

    expect(onSetModelContext).toHaveBeenCalledWith(LONG_ID, {
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
    });
  });

  it('「移除」仍是那个语义（图标按钮，可访问名不变）', () => {
    const onRemoveModel = vi.fn();
    renderModal({ provider: twoModels, onRemoveModel });

    fireEvent.click(screen.getAllByRole('button', { name: '移除' })[1] as HTMLElement);

    expect(onRemoveModel).toHaveBeenCalledWith('short');
  });
});
