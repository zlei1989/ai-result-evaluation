/**
 * 排队区（L1）：单行直出 / 多行折叠、默认收起、`gone` 跳过。
 *
 * 三条靶子（都在收起态下最要紧，因为收起时这一行是那条消息唯一的可见信息）：
 *   1. **`gone` 不许被画成排队项**（它留在快照里只为幂等；画错就是把一条已经消失的消息说成还在等）；
 *   2. **单行不套壳、两行起套壳**，且收起态**露出计数**（「N 条排队消息」是那两颗按钮被藏起来后
 *      唯一的可见信号）；
 *   3. **折叠态受控**：点标题开合要把新值回给调用方（本件不持开合态）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { InjectQueuePanel } from './inject-queue-panel';
import { INJECT_STATE_PRESENTATION } from './inject-vocab';
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

describe('四种状态的人话', () => {
  /**
   * 队列四态各有自己的一句人话——`queued` 不许被说成「已交给厂商」，`consumed` 不许被说成
   * 还撤得回来。`gone` 的处置不同：**词表里仍有一句如实的「已从队列消失」**（它为什么没了只能
   * 这样回答），但它**不进排队区**——画出来就是把一条已经消失的消息说成还在等。
   *
   * 两半合起来才是这一条：四句文案都在，DOM 里只有前三态。以后有人「顺手补全四态」，
   * 后半条会拦住他；有人把 `gone` 的文案删掉，前半条会拦住他。
   */
  it('四态各有自己的一句人话；`gone` 不许被画成还在等', async () => {
    const states = ['queued', 'delivered', 'consumed', 'gone'] as const;
    for (const state of states) {
      expect(INJECT_STATE_PRESENTATION[state].label, `${state} 没有标签`).not.toBe('');
      expect(INJECT_STATE_PRESENTATION[state].note, `${state} 没有那句人话`).not.toBe('');
    }
    // 四句标签互不相同（相同 = 两种状态在界面上分不开）
    expect(new Set(states.map((state) => INJECT_STATE_PRESENTATION[state].label)).size).toBe(4);
    // 「撤不回来」必须如实说：已经被模型读到的那一条，任何声明都救不回来
    expect(INJECT_STATE_PRESENTATION.consumed.note).toContain('撤不回来');

    renderPanel(
      [
        messageOf('m-q', { state: 'queued' }),
        messageOf('m-d', { state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
        messageOf('m-c', { state: 'consumed', deliveredAt: '2026-09-22T10:31:00.000Z', reason: '厂商说已经交给模型了' }),
        messageOf('m-g', { state: 'gone', outcome: 'timed-out', reason: '等太久了' }),
      ],
      { collapsed: false },
    );

    expect(screen.getByText('排队中')).toBeInTheDocument();
    expect(screen.getByText('已交给厂商')).toBeInTheDocument();
    expect(screen.getByText('已被模型读到')).toBeInTheDocument();
    expect(screen.queryByText('已从队列消失')).toBeNull();
    expect(screen.queryByText(/m-g 的正文/)).toBeNull();

    // 「撤不回来」不只是词表里的一句：悬停那一行时浮层里就是它。
    // 浮层监听的是**指针进入**（不是 `mouseenter`）：合成事件要打在触发器上，`delay=0` 下立即开
    const badge = screen.getByText('已被模型读到');
    const trigger = badge.closest('[data-slot="tooltip-trigger"]') ?? badge;
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    fireEvent.mouseEnter(trigger);
    expect(await screen.findByText(/撤不回来/)).toBeInTheDocument();
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
    // 收起态：行内容与两颗按钮都不在 DOM 里（`Collapsible` 收起即卸载面板）
    expect(screen.queryByText(/m-1 的正文/)).toBeNull();
  });

  it('展开态把每一行都画出来（`gone` 那一条仍然不在）', () => {
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
