/**
 * 排队区（L1）：单行直出 / 多行折叠、默认收起、`gone` 跳过。
 *
 * 三条靶子（都在收起态下最要紧，因为收起时这个候选是那条消息唯一的可见信息）：
 *   1. **`gone` 不许被画成排队项**（它留在快照里只为幂等；画错就是把一条已经消失的消息说成还在等）；
 *   2. **单行不套壳、两行起套壳**，且收起态**露出计数**（「N 条排队消息」是那两颗按钮被藏起来后
 *      唯一的可见信号）；
 *   3. **折叠态受控**：点标题开合要把新值回给调用方（本件不持开合态）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { InjectQueuePanel } from './inject-queue-panel';
import { installMatchMediaStub } from '../../testing/match-media';
import { installResizeObserverStub } from '../../testing/resize-observer';

beforeEach(() => {
  installResizeObserverStub();
  installMatchMediaStub();
});

function messageOf(messageId: string, overrides: Partial<InjectMessage> = {}): InjectMessage {
  return {
    messageId,
    text: `${messageId} 的正文`,
    attachments: [],
    requires: 'idle',
    state: 'queued',
    createdAt: '2026-09-22T10:30:00.000Z',
    deliveredAt: null,
    settledAt: null,
    outcome: null,
    reason: null,
    ...overrides,
  };
}

const YES = { state: 'yes' as const, reason: null, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'real-path' as const, proofDriverReason: null };
const DECLARATION: TurnInjectionCapability = {
  delivery: { round: YES, idle: YES },
  retract: { round: { state: 'by-id', reason: '按身份撤' }, idle: { state: 'by-id', reason: '按身份撤' } },
  resume: YES,
  notes: [],
};

const handlers = { onPromote: vi.fn(), onRetract: vi.fn() };

function renderPanel(messages: InjectMessage[], options: { collapsed?: boolean; onCollapsedChange?: (next: boolean) => void } = {}) {
  return render(
    <InjectQueuePanel
      messages={messages}
      declaration={DECLARATION}
      collapsed={options.collapsed ?? true}
      onCollapsedChange={options.onCollapsedChange ?? vi.fn()}
      {...handlers}
    />,
  );
}

describe('空队列与 `gone`', () => {
  it('一条都没有 ⇒ 一个节点都不渲染（输入区上面不留一段空白）', () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('★ `gone` 跳过：它留在快照里只为幂等，不许被画成一个还在等的人话', () => {
    renderPanel([
      messageOf('m-1'),
      messageOf('m-2', { state: 'gone', outcome: 'timed-out', reason: '等太久了', settledAt: '2026-09-22T10:32:00.000Z' }),
    ]);
    expect(screen.getByText(/m-1 的正文/)).toBeInTheDocument();
    expect(screen.queryByText(/m-2 的正文/)).toBeNull();
  });

  it('只剩一条 `gone` ⇒ 整段不渲染（同「空」那条）', () => {
    const { container } = renderPanel([messageOf('m-9', { state: 'gone', outcome: 'discarded' })]);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('单行直出 / 多行折叠', () => {
  it('一条 ⇒ 直接画那一行，不套折叠壳（标题比内容还长）', () => {
    renderPanel([messageOf('m-1')]);
    expect(screen.getByText(/m-1 的正文/)).toBeInTheDocument();
    expect(screen.queryByText(/条排队消息/)).toBeNull();
  });

  it('两条 ⇒ 收进折叠面板；收起态**露出计数**（按钮被藏起来后唯一的可见信号）', () => {
    renderPanel([messageOf('m-1'), messageOf('m-2')], { collapsed: true });
    expect(screen.getByText('2 条排队消息')).toBeInTheDocument();
    // 收起态：候选内容与两颗按钮都不在 DOM 里（antd 的 `destroyOnHidden` 语义由 Collapse 自己给）
    expect(screen.queryByText(/m-1 的正文/)).toBeNull();
  });

  it('展开态把每个候选都画出来（`gone` 那一条仍然不在）', () => {
    renderPanel([messageOf('m-1'), messageOf('m-2'), messageOf('m-3', { state: 'gone', outcome: 'retracted' })], {
      collapsed: false,
    });
    expect(screen.getByText('2 条排队消息')).toBeInTheDocument();
    expect(screen.getByText(/m-1 的正文/)).toBeInTheDocument();
    expect(screen.getByText(/m-2 的正文/)).toBeInTheDocument();
    expect(screen.queryByText(/m-3 的正文/)).toBeNull();
  });

  it('点标题把新的开合值回给调用方（折叠态受控，本件不持态）', () => {
    const onCollapsedChange = vi.fn();
    renderPanel([messageOf('m-1'), messageOf('m-2')], { collapsed: true, onCollapsedChange });
    fireEvent.click(screen.getByText('2 条排队消息'));
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('展开态点标题回 `true`（收起）', () => {
    const onCollapsedChange = vi.fn();
    renderPanel([messageOf('m-1'), messageOf('m-2')], { collapsed: false, onCollapsedChange });
    fireEvent.click(screen.getByText('2 条排队消息'));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });
});
