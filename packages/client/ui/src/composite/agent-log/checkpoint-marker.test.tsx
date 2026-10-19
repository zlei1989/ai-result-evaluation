/**
 * `CheckpointMarker`：轮末「回到这里」的可用性与文案。
 *
 * 三条判据（本文件只碰组件边界，不碰厂商实现）：
 *   · **不支持时按钮禁用且原因可见**——用 DSH 的声明形状（`supported: false` +
 *     `reason: 'not-supported'`）证明「不是能点但无声失败」；
 *   · **原因同源**：界面上那句话必须逐字等于 `MISSING_REASON_LABELS` 里对应那一句，
 *     不许在组件里另写一套说法；
 *   · **文案不承诺撤销、文件回退逐厂商说明**：`filesRewind: false` 必须出现「不修改工作区文件」。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CheckpointMarker, checkpointFileNote, checkpointReasonOf } from './checkpoint-marker';
import { MISSING_REASON_LABELS } from './types';
import type { CheckpointCapability } from '@aieval/contracts';

/** DSH 的声明形状：结构上没有这个能力 */
const dshCapability = {
  supported: false,
  mode: null,
  filesRewind: false,
  reason: 'not-supported',
  notes: [],
} as const satisfies CheckpointCapability;

/** CC 的声明形状：同会话截断 + 支持文件回退 */
const ccCapability = {
  supported: true,
  mode: 'resume-at',
  filesRewind: true,
  reason: null,
  notes: [],
} as const satisfies CheckpointCapability;

/** Pi 的声明形状：分叉、不动文件 */
const piCapability = {
  supported: true,
  mode: 'fork',
  filesRewind: false,
  reason: null,
  notes: [],
} as const satisfies CheckpointCapability;

describe('CheckpointMarker：不支持的家（DSH）', () => {
  it('按钮禁用、原因可见，且那句话与能力词表逐字同源', () => {
    render(<CheckpointMarker segment={0} turn={2} capability={dshCapability} />);

    const button = screen.getByRole('button', { name: '回到这里' });
    expect(button).toBeDisabled();
    // 「同源」的判据是**逐字相等**：组件里另写一句「这家做不到」也算漂移
    expect(screen.getByText(`不可用：${MISSING_REASON_LABELS['not-supported']}`)).toBeInTheDocument();
  });

  it('禁用时点下去不发生任何动作（不是「能点但无声失败」）', () => {
    const onCheckpoint = vi.fn();
    render(<CheckpointMarker segment={0} turn={2} capability={dshCapability} onCheckpoint={onCheckpoint} />);

    fireEvent.click(screen.getByRole('button', { name: '回到这里' }));
    expect(onCheckpoint).not.toHaveBeenCalled();
  });

  it('声明缺席（还没取到）按「没验证过」置灰，不替厂商下「不支持」的结论', () => {
    render(<CheckpointMarker segment={0} turn={1} capability={null} />);
    expect(screen.getByRole('button', { name: '回到这里' })).toBeDisabled();
    expect(screen.getByText(`不可用：${MISSING_REASON_LABELS.unverified}`)).toBeInTheDocument();
  });
});

describe('CheckpointMarker：支持的家', () => {
  it('CC 可点，且文案说明「支持文件回退、本次不自动改文件」', () => {
    const onCheckpoint = vi.fn();
    render(<CheckpointMarker segment={0} turn={3} capability={ccCapability} onCheckpoint={onCheckpoint} />);

    const button = screen.getByRole('button', { name: '回到这里' });
    expect(button).toBeEnabled();
    expect(screen.getByText(/这家支持把工作区文件回退到这一轮/)).toBeInTheDocument();
    // 不承诺「撤销」：界面不出现这两个字
    expect(screen.queryByText(/撤销/)).toBeNull();

    fireEvent.click(button);
    expect(onCheckpoint).toHaveBeenCalledWith({ segment: 0, turn: 3 });
  });

  it('Pi（filesRewind: false）明确写「不修改工作区文件」', () => {
    render(<CheckpointMarker segment={2} turn={1} capability={piCapability} />);
    expect(screen.getByText(/不修改工作区文件/)).toBeInTheDocument();
    expect(checkpointFileNote(piCapability)).toBe('不修改工作区文件');
  });

  it('支持但这一轮缺厂商条目：用调用方给的这一次原因置灰（不与静态声明混同）', () => {
    expect(checkpointReasonOf(piCapability, '这一轮没有可用的厂商条目')).toBe('这一轮没有可用的厂商条目');
    render(
      <CheckpointMarker segment={0} turn={1} capability={piCapability} disabledReason="这一轮没有可用的厂商条目" />,
    );
    expect(screen.getByRole('button', { name: '回到这里' })).toBeDisabled();
    expect(screen.getByText('不可用：这一轮没有可用的厂商条目')).toBeInTheDocument();
  });
});
