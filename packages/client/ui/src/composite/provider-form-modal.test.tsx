/**
 * ProviderFormModal：新建/编辑两种形态、必填校验、留空密钥的语义，以及
 * **模型清单不在这里**这条边界（它已搬到 `provider-models-modal.tsx`，入口是列表的「模型」按钮）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PROTOCOL_LABELS, type ProviderView } from '@aieval/contracts';
import { ProviderFormModal, MODAL_WIDTH } from './provider-form-modal';
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
function renderModal(overrides: Partial<Parameters<typeof ProviderFormModal>[0]> = {}): ReturnType<typeof render> {
  return render(
    <ProviderFormModal open initial={null} saving={false} onSubmit={noop} onCancel={noop} {...overrides} />,
  );
}

describe('ProviderFormModal：新建态', () => {
  it('标题是「添加供应商」，模型区只提示「保存后可维护」，没有「拉取模型」按钮', () => {
    renderModal();

    expect(screen.getByText('添加供应商')).toBeInTheDocument();
    expect(screen.getByText('保存后可维护模型清单')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '拉取模型' })).toBeNull();
  });

  it('必填项为空时点「保存」不提交，并给出中文错误', async () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText('请填写名称')).toBeInTheDocument();
    /**
     * 第二条提示也必须**等**：antd 的字段校验是逐个字段落定的，两条消息不保证在同一帧渲染。
     * 这里原来是同步的 `getByText`——满载时（全量并发下 jsdom 渲染被拖慢）它会在第一条出现的
     * 那一帧就查第二条并失败，错误信息是「找不到文本」，指向的是渲染时机而不是校验逻辑。
     * 改成 `findByText` 不放松任何断言：等不到照旧失败（默认上限见 `src/testing/setup.ts` 的 10s）。
     */
    expect(await screen.findByText('请填写 API 密钥')).toBeInTheDocument();
  });

  it('填完提交：回调收到四个字段', async () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'DeepSeek 官方' } });
    fireEvent.click(screen.getByRole('radio', { name: PROTOCOL_LABELS.anthropic }));
    fireEvent.change(screen.getByLabelText('API 地址'), {
      target: { value: 'https://api.deepseek.com/anthropic' },
    });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'DeepSeek 官方',
        protocolType: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-secret',
      }),
    );
  });

  // 只有 `required` 时 `'   '` 能过校验（antd 只判空串），提交出去就是一个「看着像配好了、
  // 实际永远 401」的供应商。规则文案必须是中文：应用没配 antd locale，缺 message 的 whitespace
  // 规则会渲染英文 `API 密钥 cannot be a blank character`。
  it('纯空白密钥不提交，并给中文错误（whitespace 规则）', async () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'DeepSeek 官方' } });
    fireEvent.change(screen.getByLabelText('API 地址'), { target: { value: 'https://api.deepseek.com/v1' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('API 密钥不能只有空格')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ProviderFormModal：编辑态', () => {
  it('字段预填，密钥框留空且占位符回显当前掩码', () => {
    renderModal({ initial: PROVIDER });

    expect(screen.getByText('编辑供应商')).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue('DeepSeek 官方');
    expect(screen.getByLabelText('API 地址')).toHaveValue('https://api.deepseek.com/v1');
    expect(screen.getByLabelText('API 密钥')).toHaveValue('');
    expect(screen.getByPlaceholderText('留空表示不修改（当前：sk-***mnop）')).toBeInTheDocument();
  });

  // 页面会把空串折成「不下发 apiKey」：这条钉住弹窗确实用空串表达「不修改」，
  // 而不是把掩码当密钥回填（那会把 user 的密钥覆盖成 `sk-***mnop`，此后所有调用 401）。
  it('留空密钥提交：回调收到的 apiKey 是空串', async () => {
    const onSubmit = vi.fn();
    renderModal({ initial: PROVIDER, onSubmit });

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改名了' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: '改名了',
        protocolType: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
      }),
    );
  });
});

/**
 * 边界守卫：模型清单已从本弹窗**搬走**，单独成对话框。
 * 三条都要钉，因为「搬走」这件事有两种回归形态：① 模型清单又长回来（两个入口、两套状态）；
 * ② 搬走之后不留路标（用户找不到入口，读起来就是「功能没了」）。
 */
describe('ProviderFormModal：模型清单不在这里（已搬到「模型」对话框）', () => {
  it('编辑态不渲染模型清单的任何一部分，但给出去向', () => {
    renderModal({ initial: PROVIDER });

    // ① 清单本体与它的控件都不在（它们不归本弹窗管）
    expect(screen.queryByText('deepseek-chat')).toBeNull();
    expect(screen.queryByText('deepseek-reasoner')).toBeNull();
    expect(screen.queryByText('自动拉取')).toBeNull();
    expect(screen.queryByRole('button', { name: '拉取模型' })).toBeNull();
    expect(screen.queryByPlaceholderText('手工添加模型名，如 deepseek-chat')).toBeNull();
    expect(screen.queryByRole('button', { name: '添加' })).toBeNull();
    // ② 去向必须**可见**（不是 Tooltip、不是靠用户自己发现）
    expect(screen.getByText('模型清单在列表的「模型」按钮里维护')).toBeInTheDocument();
  });

  it('新建态同样不渲染清单，提示写明「保存后到列表里点这一行的『模型』按钮」', () => {
    renderModal();

    expect(screen.queryByRole('button', { name: '拉取模型' })).toBeNull();
    expect(
      screen.getByText('新建时还没有供应商 id；保存后到列表里点这一行的「模型」按钮，在对话框里拉取或手工增删。'),
    ).toBeInTheDocument();
  });

  it('弹窗收窄到 560（720 是为了塞下模型清单那张表，清单走了就不该继续占宽）', () => {
    renderModal({ initial: PROVIDER });

    expect(MODAL_WIDTH).toBe(560);
    expect((document.querySelector('.ant-modal') as HTMLElement | null)?.style.width).toBe(`${MODAL_WIDTH}px`);
  });
});

describe('ProviderFormModal：表单重灌的边界', () => {
  it('换成另一个供应商时重灌（不残留上一条的输入）', () => {
    const { rerender } = renderModal({ initial: PROVIDER });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '改了一半' } });

    rerender(
      <ProviderFormModal
        open
        initial={{ ...PROVIDER, id: 'p-2', name: 'Anthropic 官方' }}
        saving={false}
        onSubmit={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByLabelText('名称')).toHaveValue('Anthropic 官方');
    expect(screen.getByLabelText('API 密钥')).toHaveValue('');
  });

  // 列表刷新（例如刚手工加了一个模型 → SWR 重新取回列表 → 传进来的 ProviderView 是新对象、
  // id 没变）**不得**重灌表单：否则用户正在敲的名字会在加模型的那一刻被清掉。
  it('同 id 的新对象（列表刷新）不重灌表单', () => {
    const { rerender } = renderModal({ initial: PROVIDER });
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '编辑中的名字' } });

    rerender(
      <ProviderFormModal
        open
        initial={{ ...PROVIDER, models: [...PROVIDER.models, { id: 'brand-new', source: 'manual' as const }] }}
        saving={false}
        onSubmit={noop}
        onCancel={noop}
      />,
    );

    expect(screen.getByLabelText('名称')).toHaveValue('编辑中的名字');
  });
});
