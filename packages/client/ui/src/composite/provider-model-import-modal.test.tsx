/**
 * ProviderModelImportModal：模型挑选对话框（拉取的第二步）。
 * 覆盖：默认全选、全选 / 反选、确定只回传勾选的条目（含能力格）、零勾选禁点、
 * 候选换一份后勾选重置、importing 的按钮态、取消回传。
 *
 * 最要紧的守卫是「确定只回传**勾选的**候选、且原样带能力格」：多传一条就是
 * 「拉到全加」（这次改造要消灭的旧行为），丢了能力格就是「看到的窗口 ≠ 落盘的窗口」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ProviderModelPreview } from '@aieval/contracts';
import { ProviderModelImportModal, MODEL_IMPORT_MODAL_WIDTH } from './provider-model-import-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
});

/** 一份候选：两条新模型（其中一条带窗口）、一条已在清单（见 existingIds） */
const MODELS: ProviderModelPreview[] = [
  { id: 'jd/glm-5.3', contextWindow: 128_000 },
  { id: 'deepseek-reasoner' },
  { id: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 8_192 },
];

/** deepseek-chat 已在清单里（勾上它的语义是刷新窗口与档位，不是新增） */
const EXISTING_IDS: ReadonlySet<string> = new Set(['deepseek-chat']);

const noop = (): void => {};

function renderModal(
  overrides: Partial<Parameters<typeof ProviderModelImportModal>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <ProviderModelImportModal
      open
      models={MODELS}
      existingIds={EXISTING_IDS}
      importing={false}
      onImport={noop}
      onCancel={noop}
      {...overrides}
    />,
  );
}

/** 表格的行勾选框（不含表头那个全选框）：顺序与 dataSource 一致 */
function rowCheckboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('tbody input[type="checkbox"]')) as HTMLInputElement[];
}

/** 「已选 N / M」那一行 */
function selectedCountText(): string {
  return screen.getByText(/^已选 \d+ \/ \d+$/).textContent ?? '';
}

describe('ProviderModelImportModal：外框', () => {
  it('标题带候选数量；宽度 560（三列无输入框，不必与外层清单对话框等宽）', () => {
    renderModal();

    expect(screen.getByText('拉取到 3 个模型')).toBeInTheDocument();
    expect(screen.getByTestId('provider-model-import-dialog').style.maxWidth).toBe(
      `${MODEL_IMPORT_MODAL_WIDTH}px`,
    );
  });

  it('说明文案说清挑选语义（勾选加入、未勾不移除），候选表带模型 / 窗口 / 状态列', () => {
    renderModal();

    expect(
      screen.getByText('勾选的模型会加入清单（已在清单的勾上则刷新窗口与档位）；未勾选的不会被移除。'),
    ).toBeInTheDocument();
    // 窗口：千分位；未知的那条写「未知」而不是 0（能力格的既有口径）
    expect(screen.getByText('128,000')).toBeInTheDocument();
    expect(screen.getAllByText('未知')).toHaveLength(1);
    // 状态：已在清单的标 Tag，新条目标「新」
    expect(screen.getByText('已在清单')).toBeInTheDocument();
    expect(screen.getAllByText('新')).toHaveLength(2);
  });

  it('open=false 不渲染', () => {
    renderModal({ open: false });

    expect(screen.queryByText('拉取到 3 个模型')).toBeNull();
  });

  it('「取消」回传 onCancel；footer 没有第三个按钮', () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    // 两颗按钮：取消 + 加入清单（不会再多出一颗「确定」之类）
    expect(document.querySelectorAll('[data-slot="dialog-footer"] button')).toHaveLength(2);
  });
});

describe('ProviderModelImportModal：勾选', () => {
  it('打开即默认全选（直接确定 = 全部加入，与挑选加入之前的旧行为一致）', () => {
    renderModal();

    expect(selectedCountText()).toBe('已选 3 / 3');
    for (const box of rowCheckboxes()) expect(box.checked).toBe(true);
  });

  it('行勾选框与按钮共享同一份勾选状态（受控）', () => {
    renderModal();

    fireEvent.click(rowCheckboxes()[0] as HTMLInputElement);

    expect(selectedCountText()).toBe('已选 2 / 3');
    expect((rowCheckboxes()[0] as HTMLInputElement).checked).toBe(false);
  });

  it('「全选」把部分勾选恢复成全选', () => {
    renderModal();
    fireEvent.click(rowCheckboxes()[0] as HTMLInputElement);
    fireEvent.click(rowCheckboxes()[1] as HTMLInputElement);
    expect(selectedCountText()).toBe('已选 1 / 3');

    fireEvent.click(screen.getByRole('button', { name: '全选' }));

    expect(selectedCountText()).toBe('已选 3 / 3');
  });

  it('「反选」翻转勾选集合（补集，不是清空也不是全选）', () => {
    renderModal();
    // 先只勾最后一条（已在清单那条），反选后应是前两条
    fireEvent.click(rowCheckboxes()[0] as HTMLInputElement);
    fireEvent.click(rowCheckboxes()[1] as HTMLInputElement);
    expect(selectedCountText()).toBe('已选 1 / 3');

    fireEvent.click(screen.getByRole('button', { name: '反选' }));

    expect(selectedCountText()).toBe('已选 2 / 3');
    expect((rowCheckboxes()[0] as HTMLInputElement).checked).toBe(true);
    expect((rowCheckboxes()[1] as HTMLInputElement).checked).toBe(true);
    expect((rowCheckboxes()[2] as HTMLInputElement).checked).toBe(false);
  });

  /**
   * 候选换一份（重新拉取）⇒ 勾选回到默认全选。沿用上一份的勾选集合，
   * id 对不上号就会出现「看着勾了 A、确定后进的是 B」。
   */
  it('候选变化后勾选重置为全选（不沿用上一份的勾选）', () => {
    const { rerender } = renderModal();
    fireEvent.click(rowCheckboxes()[0] as HTMLInputElement);
    expect(selectedCountText()).toBe('已选 2 / 3');

    rerender(
      <ProviderModelImportModal
        open
        models={[{ id: 'brand-new' }]}
        existingIds={EXISTING_IDS}
        importing={false}
        onImport={noop}
        onCancel={noop}
      />,
    );

    expect(selectedCountText()).toBe('已选 1 / 1');
    expect((rowCheckboxes()[0] as HTMLInputElement).checked).toBe(true);
  });
});

describe('ProviderModelImportModal：确定', () => {
  /**
   * 这次改造的核心守卫：确定**只回传勾选的**候选 —— 多传一条就是「拉到全加」的旧行为
   * （用户明确不要的 embedding / 图像型号一并进清单）；条目必须**原样**回传（含窗口 / 档位），
   * 丢能力格会让「预览看到的窗口」与「落盘的窗口」悄悄分家。
   */
  it('只回传勾选的候选，且条目原样（含窗口与输出上限）', () => {
    const onImport = vi.fn();
    renderModal({ onImport });

    // 只留最后一条（deepseek-chat：带两个能力格）
    fireEvent.click(rowCheckboxes()[0] as HTMLInputElement);
    fireEvent.click(rowCheckboxes()[1] as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: '加入清单' }));

    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onImport).toHaveBeenCalledWith([{ id: 'deepseek-chat', contextWindow: 64_000, maxOutputTokens: 8_192 }]);
  });

  it('零勾选时「加入清单」不可点（空提交没有语义）', () => {
    const onImport = vi.fn();
    renderModal({ onImport });

    fireEvent.click(screen.getByRole('button', { name: '全选' })); // 无操作：本来全选
    fireEvent.click(screen.getByRole('button', { name: '反选' })); // 翻成零选
    expect(selectedCountText()).toBe('已选 0 / 3');

    const submit = screen.getByRole('button', { name: '加入清单' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(onImport).not.toHaveBeenCalled();
  });

  it('importing 时「加入清单」转圈（loading 来自 props）', () => {
    renderModal({ importing: true });

    const submit = screen.getByRole('button', { name: '加入清单' });
    expect(submit).toHaveAttribute('data-loading', 'true');
    expect(submit).toBeDisabled();
  });
});
