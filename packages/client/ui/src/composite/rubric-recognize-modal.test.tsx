/**
 * RubricRecognizeModal：**框内只有一个多行文本域** + 取消 / 识别两个按钮。
 * 守卫（本组件的全部价值都在这两条上）：
 *   1. 识别失败时**弹窗不关、文本原样保留**——反例是「先清空再请求」：一次网络抖动就清掉用户刚粘进来的长文；
 *   2. 成功不回填（回填由调用方做）、关闭不写回（`onCancel` 只关窗）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RubricRecognizeModal } from './rubric-recognize-modal';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 既没有 ResizeObserver 也没有 matchMedia，而 antd 的 Modal（内部的 rc-resize-observer）
// 两者都要（见 src/testing/resize-observer.ts）：不打桩，挂载即抛 `ResizeObserver is not defined`。
beforeEach(() => {
  installResizeObserverStub();
});

describe('RubricRecognizeModal', () => {
  it('只有一个多行文本域（没有表格、没有其他控件）', () => {
    render(<RubricRecognizeModal open recognizing={false} onCancel={vi.fn()} onRecognize={vi.fn()} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByTestId('rubric-recognize-text')).toBeInTheDocument();
  });

  it('点「识别」把文本原样交给 onRecognize', async () => {
    const onRecognize = vi.fn(async () => undefined);
    render(<RubricRecognizeModal open recognizing={false} onCancel={vi.fn()} onRecognize={onRecognize} />);
    fireEvent.change(screen.getByTestId('rubric-recognize-text'), { target: { value: '## 一、生产代码 48 分' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));
    await waitFor(() => expect(onRecognize).toHaveBeenCalledWith('## 一、生产代码 48 分'));
  });

  it('识别失败：弹窗不关、文本原样保留', async () => {
    const onRecognize = vi.fn(async () => {
      throw new Error('评分模型返回的不是合法 JSON');
    });
    const onCancel = vi.fn();
    render(<RubricRecognizeModal open recognizing={false} onCancel={onCancel} onRecognize={onRecognize} />);
    fireEvent.change(screen.getByTestId('rubric-recognize-text'), { target: { value: '很长的一段评分要求' } });
    fireEvent.click(screen.getByTestId('rubric-recognize-submit'));

    await waitFor(() => expect(onRecognize).toHaveBeenCalledTimes(1));
    // 等一拍，确保「先清空再请求」那种实现也有机会把文本清掉，断言才有区分力
    await waitFor(() => expect(screen.getByTestId('rubric-recognize-text')).toHaveValue('很长的一段评分要求'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('识别中时按钮转圈且不可再点（避免连点两次花两次钱）', () => {
    render(<RubricRecognizeModal open recognizing onCancel={vi.fn()} onRecognize={vi.fn()} />);
    expect(screen.getByTestId('rubric-recognize-submit')).toBeDisabled();
  });

  it('点「取消」只调 onCancel（不写回任何东西）', () => {
    const onCancel = vi.fn();
    render(<RubricRecognizeModal open recognizing={false} onCancel={onCancel} onRecognize={vi.fn()} />);
    fireEvent.click(screen.getByTestId('rubric-recognize-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
