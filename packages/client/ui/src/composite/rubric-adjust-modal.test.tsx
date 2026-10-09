/**
 * RubricAdjustModal：「智能调整」弹窗的**两段式**行为。
 *
 * 本文件的头号守卫是那条**贯穿全部用例的否定断言**——`onApply` 只在点了「应用改动」之后才被调用：
 * 这个弹窗是「用一句话改现有评分标准」唯一的把关点，而现有标准可能是用户调了很久、甚至已经跑过
 * 评测的那一份。反面写法（拿到模型结果就写回表格、把清单当成事后的通知）在界面上**看起来完全一样**：
 * 用户照样看到清单，只是表格已经被换掉了——他再点一次「取消」，改就落了地。
 * 所以每条用例都带 `expect(onApply).not.toHaveBeenCalled()`，只有「应用」那一条反过来钉。
 *
 * 其余四条与识别弹窗同源的口径：失败不清文本、不关窗；在途取消 ⇒ 这次结果作废；空指令不发请求；
 * 清单为空时不给「应用」（新表与旧表逐字节相同，没有可应用的东西）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Rubric, RubricChange } from '@aieval/contracts';
import { RubricAdjustModal } from './rubric-adjust-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 没有 ResizeObserver，而清单里的 `EllipsisText`（Typography 的 ellipsis）会直接 new 它
beforeEach(() => {
  installResizeObserverStub();
});

/** 用户手上那张表（与界面无关的一份夹具：弹窗只吃「新表 + 清单」） */
const CURRENT: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 18 }] }],
};

/** 模型改完的新表：把 A1 提到 30 分（就一处改动） */
const UPDATED: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 30 }] }],
};

const CHANGES: RubricChange[] = [
  {
    kind: 'update-item',
    groupName: '一、生产代码',
    before: { id: 'A1', goal: '追加 agent 字段', weight: 18 },
    after: { id: 'A1', goal: '追加 agent 字段', weight: 30 },
  },
];

interface SetupOptions {
  adjusting?: boolean;
  onAdjust?: (instruction: string) => Promise<{ rubric: Rubric; changes: RubricChange[] }>;
  onApply?: (rubric: Rubric) => void;
  onCancel?: () => void;
}

function setup(options: SetupOptions = {}) {
  const onAdjust = vi.fn(options.onAdjust ?? (async () => ({ rubric: UPDATED, changes: CHANGES })));
  const onApply = vi.fn(options.onApply ?? (() => {}));
  const onCancel = vi.fn(options.onCancel ?? (() => {}));
  const view = render(
    <RubricAdjustModal
      open
      adjusting={options.adjusting ?? false}
      onCancel={onCancel}
      onAdjust={onAdjust}
      onApply={onApply}
    />,
  );
  return { onAdjust, onApply, onCancel, ...view };
}

/** 写一句话并点「生成改动」，等清单出来 */
async function requestPreview(text = '把 A1 提到 30 分'): Promise<void> {
  fireEvent.change(screen.getByTestId('rubric-adjust-text'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('rubric-adjust-submit'));
  await screen.findByTestId('rubric-adjust-changes');
}

describe('RubricAdjustModal：不点「应用改动」就不回写（本功能的把关点）', () => {
  it('生成改动只把清单摆出来：`onApply` 一次都不许被调用', async () => {
    const { onAdjust, onApply } = setup();

    await requestPreview('把 A1 提到 30 分');

    expect(onAdjust).toHaveBeenCalledWith('把 A1 提到 30 分');
    expect(screen.getByTestId('rubric-adjust-changes')).toBeInTheDocument();
    // 头号守卫：清单出来了，但表格一个字都没变
    expect(onApply).not.toHaveBeenCalled();
  });

  it('点「返回修改」回到输入段：文本还在，`onApply` 仍未被调用', async () => {
    const { onApply } = setup();
    await requestPreview('把 A1 提到 30 分');

    fireEvent.click(screen.getByTestId('rubric-adjust-back'));

    expect(await screen.findByTestId('rubric-adjust-text')).toHaveValue('把 A1 提到 30 分');
    expect(onApply).not.toHaveBeenCalled();
  });

  it('点「取消」只通知调用方：`onApply` 未被调用（关窗不等于应用）', async () => {
    const { onApply, onCancel } = setup();
    await requestPreview('把 A1 提到 30 分');

    fireEvent.click(screen.getByTestId('rubric-adjust-back'));
    fireEvent.click(screen.getByTestId('rubric-adjust-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('点「应用改动」才回写，且交出去的是**模型改完的新表**（不是清单、不是旧表）', async () => {
    const { onApply } = setup();
    await requestPreview('把 A1 提到 30 分');

    fireEvent.click(screen.getByTestId('rubric-adjust-apply'));

    expect(onApply).toHaveBeenCalledWith(UPDATED);
  });
});

describe('RubricAdjustModal：清单本身的呈现', () => {
  it('改权重那条显示「18 → 30」与组名（用户要有得核对，而不是一句「改了 1 项」）', async () => {
    setup();

    await requestPreview();

    const list = screen.getByTestId('rubric-adjust-changes');
    expect(list).toHaveTextContent('一、生产代码');
    expect(list).toHaveTextContent('18');
    expect(list).toHaveTextContent('30');
    expect(list).toHaveTextContent('A1');
  });

  it('清单为空 ⇒ 给一句说明、且「应用改动」禁用（新表与旧表逐字节相同，没有可应用的东西）', async () => {
    setup({ onAdjust: async () => ({ rubric: CURRENT, changes: [] }) });

    fireEvent.change(screen.getByTestId('rubric-adjust-text'), { target: { value: '需要改吗' } });
    fireEvent.click(screen.getByTestId('rubric-adjust-submit'));

    expect(await screen.findByTestId('rubric-adjust-empty')).toBeInTheDocument();
    expect(screen.getByTestId('rubric-adjust-apply')).toBeDisabled();
  });

  it('空要求 / 只有空白时「生成改动」禁用（一次调用是真的钱，空指令必然只换回「保持原样」）', () => {
    setup();

    expect(screen.getByTestId('rubric-adjust-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('rubric-adjust-text'), { target: { value: '   ' } });
    expect(screen.getByTestId('rubric-adjust-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('rubric-adjust-text'), { target: { value: '加一条' } });
    expect(screen.getByTestId('rubric-adjust-submit')).toBeEnabled();
  });
});

describe('RubricAdjustModal：失败与在途取消', () => {
  it('调整失败：文本原样保留、窗不关、也不回写（一次抖动不许毁掉刚写的要求）', async () => {
    const onAdjust = vi.fn(async () => {
      throw new Error('调整失败');
    });
    const { onApply } = setup({ onAdjust });

    fireEvent.change(screen.getByTestId('rubric-adjust-text'), { target: { value: '很长的一句要求' } });
    fireEvent.click(screen.getByTestId('rubric-adjust-submit'));

    await waitFor(() => expect(onAdjust).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('rubric-adjust-text')).toHaveValue('很长的一句要求');
    expect(screen.queryByTestId('rubric-adjust-changes')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  /**
   * 在途取消：请求还在飞的时候用户按了取消，结果回来时**不许**把清单糊到他已经放弃的那次操作上。
   * 判据是「清单不出现」——若代次那道门被拿掉，`setPreview` 会在取消之后照常执行
   * （`destroyOnHidden` 挡不住它：组件此刻仍挂着，只是弹窗在关）。
   */
  it('在途取消 ⇒ 回来的结果作废，清单不再出现', async () => {
    // 用一个容器装那把「放行」的函数：`let release = null` 会被 TS 的控制流分析**收窄成 never**
    // （赋值发生在 Promise 构造器的回调里，它不做跨函数分析），于是 `release?.()` 直接编译不过
    const gate: { release: (() => void) | null } = { release: null };
    const onAdjust = vi.fn(
      () =>
        new Promise<{ rubric: Rubric; changes: RubricChange[] }>((resolve) => {
          gate.release = () => resolve({ rubric: UPDATED, changes: CHANGES });
        }),
    );
    const { onApply, onCancel } = setup({ onAdjust });

    fireEvent.change(screen.getByTestId('rubric-adjust-text'), { target: { value: '把 A1 提到 30 分' } });
    fireEvent.click(screen.getByTestId('rubric-adjust-submit'));
    // 还在途：这时用户按了取消
    fireEvent.click(screen.getByTestId('rubric-adjust-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    gate.release?.();
    await waitFor(() => expect(onAdjust).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('rubric-adjust-changes')).toBeNull();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('请求在途时「生成改动」转圈并禁用（避免连点两次花两次钱）', () => {
    setup({ adjusting: true });

    const submit = screen.getByTestId('rubric-adjust-submit');
    expect(submit).toBeDisabled();
    expect(submit.className).toContain('ant-btn-loading');
  });
});
