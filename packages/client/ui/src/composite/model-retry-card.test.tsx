/**
 * ModelRetryCard：默认值、值域边界与「打字中间态不下发」。
 *
 * 为什么这些行为必须逐条钉在**卡片**上：本仓的应用层（apps/web-next）不能写 `.tsx` 测试，
 * 页面只做接线，全部判定都在卡片里。而这一张卡最容易坏的两种写法都不报错：
 *   · `|| 默认值` 式的兜底会把用户填的 `0` 吞成 10 —— 用户以为关掉了重试，实际还在重试；
 *   · 把打字过程中的 `null` / `2.5` / `25` 直接下发 —— 每次都是服务端 400，输入框还会闪回上一个值。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MODEL_RETRIES_MAX, MODEL_RETRIES_MIN } from '@aieval/contracts';
import { ModelRetryCard, type ModelRetryCardProps } from './model-retry-card';
import { installResizeObserverStub } from '../testing/resize-observer';

// jsdom 不提供 matchMedia，而 antd 的 Form.Item / Grid 会无条件读它（口径见 workspace-settings-card.test.tsx）
beforeEach(() => {
  installResizeObserverStub();
});

const noop = (): void => {};

function renderCard(overrides: Partial<ModelRetryCardProps> = {}): ReturnType<typeof render> {
  return render(<ModelRetryCard value={10} saving={false} onChange={noop} {...overrides} />);
}

/** 那个唯一的数字输入框（可访问名与本文件的测试名同源） */
function input(): HTMLInputElement {
  return screen.getByRole('spinbutton', { name: '模型调用失败重试次数' }) as HTMLInputElement;
}

describe('ModelRetryCard', () => {
  it('渲染设置里那一份值（默认 10）', () => {
    renderCard();

    expect(input()).toHaveValue('10');
  });

  it('改成 4 ⇒ onChange(4)', () => {
    const onChange = vi.fn();
    renderCard({ onChange });

    fireEvent.change(input(), { target: { value: '4' } });

    expect(onChange).toHaveBeenCalledWith(4);
  });

  /** `0` 是「不重试」的合法值：它最容易被 `||` 一类的兜底吞成默认值 */
  it('0 照发（= 不重试），不被兜底吞成默认值', () => {
    const onChange = vi.fn();
    renderCard({ onChange });

    fireEvent.change(input(), { target: { value: '0' } });

    expect(onChange).toHaveBeenCalledWith(0);
  });

  /** 打字中间态：清空给 `null`、小数与越界都可能先出现，任何一种都不该变成一次 400 */
  it('清空 / 小数 / 越界都不下发', () => {
    const onChange = vi.fn();
    renderCard({ onChange });

    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.change(input(), { target: { value: '2.5' } });
    fireEvent.change(input(), { target: { value: String(MODEL_RETRIES_MAX + 1) } });
    fireEvent.change(input(), { target: { value: String(MODEL_RETRIES_MIN - 1) } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('saving 时置灰（避免并发提交把后一次的值盖掉）', () => {
    renderCard({ saving: true });

    expect(input()).toBeDisabled();
  });
});
