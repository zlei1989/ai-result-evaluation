/**
 * 排队行（L0）：一行人工消息的五格与两颗按钮。
 *
 * 这一组用例的靶子是**按钮的可用性来自声明**与**三态各说各的话**——两者坏掉都没有运行时症状
 * （按钮照旧画得出来，只是点下去做的事不是那句话说的）。四态与声明取值的判定在
 * `inject-vocab.test.ts` 里逐条钉；这里钉的是「渲染出来的是不是那一份判定」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InjectMessage, TurnInjectionCapability } from '@aieval/contracts';
import { InjectMessageRow } from './inject-message-row';
import { installMatchMediaStub } from '../../testing/match-media';
import { installResizeObserverStub } from '../../testing/resize-observer';

function messageOf(overrides: Partial<InjectMessage> = {}): InjectMessage {
  return {
    messageId: 'm-1',
    text: '顺便把 changelog 也补上，只写这一版的用户可见变更',
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
const OFF = { state: 'off-by-adapter' as const, reason: 'not-observed' as const, channel: 'wire' as const, gate: null, experimental: false, proofDriver: 'synthetic-fixture' as const, proofDriverReason: '夹具扮演厂商那一端（测试夹具，只为形状）' };

function declarationOf(overrides: {
  retract?: Partial<TurnInjectionCapability['retract']>;
  delivery?: Partial<TurnInjectionCapability['delivery']>;
} = {}): TurnInjectionCapability {
  return {
    delivery: { round: YES, idle: YES, ...overrides.delivery },
    retract: {
      round: { state: 'by-id', reason: '按身份撤' },
      idle: { state: 'by-id', reason: '按身份撤' },
      ...overrides.retract,
    },
    resume: OFF,
    notes: [],
  };
}

/**
 * jsdom 没有 `ResizeObserver`，而 `EllipsisText` 的 `Tooltip`（rc-tooltip → rc-resize-observer）
 * 挂载时直接 `new` 全局构造器：不打桩就是 `ReferenceError`——环境缺口，不是被测代码的问题
 * （见 `src/testing/resize-observer.ts`）。`matchMedia` 同理由 antd 的响应式 hook 读。
 */
beforeEach(() => {
  installResizeObserverStub();
  installMatchMediaStub();
});

const handlers = { onPromote: vi.fn(), onRetract: vi.fn() };

function renderRow(message: InjectMessage, declaration: TurnInjectionCapability | null, busy = false) {
  return render(<InjectMessageRow message={message} declaration={declaration} busy={busy} {...handlers} />);
}

describe('一行人工消息的五格', () => {
  it('正文、投递档、附件条数、登记时刻都在（收起态下这一行就是它的全部可见信息）', () => {
    renderRow(messageOf({ requires: 'round', attachments: [{ kind: 'file', path: '/tmp/a.md', mimeType: null }] }), declarationOf());
    expect(screen.getByText(/changelog/)).toBeInTheDocument();
    expect(screen.getByText('立即发送')).toBeInTheDocument();
    expect(screen.getByText('附件 1 个')).toBeInTheDocument();
    // 登记时刻走 ISO 格式化那一档（`formatDateTime`）：输出是 YYYY-MM-DD HH:mm，不是原样吐 ISO 串
    expect(screen.getByText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it('没有附件时那一格不出现（不画一个恒为 0 的读数）', () => {
    renderRow(messageOf(), declarationOf());
    expect(screen.queryByText(/附件/)).toBeNull();
  });

  it('三态各显示自己的那一句标签（`queued` 不许被显示成「已交给厂商」）', () => {
    const { unmount } = renderRow(messageOf({ state: 'queued' }), declarationOf());
    expect(screen.getByText('排队中')).toBeInTheDocument();
    unmount();
    const { unmount: unmount2 } = renderRow(
      messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
      declarationOf(),
    );
    expect(screen.getByText('已交给厂商')).toBeInTheDocument();
    unmount2();
    renderRow(messageOf({ state: 'consumed', deliveredAt: '2026-09-22T10:31:00.000Z', reason: '厂商说已经交给模型了' }), declarationOf());
    expect(screen.getByText('已被模型读到')).toBeInTheDocument();
  });
});

describe('两颗操作按钮的可用性来自声明', () => {
  it('`queued` + 要求排队 + 这一家两档都行 ⇒ 两颗都可点', () => {
    renderRow(messageOf({ state: 'queued' }), declarationOf());
    expect(screen.getByRole('button', { name: '立即发送' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled();
  });

  it('★ 撤回档为 `flush-only`（pi 那一档）⇒ 已交给厂商的那条「删除」禁用，且原因带在这一格上', async () => {
    renderRow(
      messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }),
      declarationOf({ retract: { idle: { state: 'flush-only', reason: '只有 clearQueue()' } } }),
    );
    const remove = screen.getByRole('button', { name: '删除' });
    expect(remove).toBeDisabled();
    /**
     * 浮层挂在**按钮外面那层**上（不是按钮上）：禁用态的 `Button` 不派发鼠标事件，
     * 挂在它上面时那句话永远读不到——而禁用态恰恰最需要「为什么不能点」。
     * 这条断言因此同时钉住「原因写对了」与「它真的能看见」。
     */
    fireEvent.mouseEnter(screen.getByTestId('inject-retract-m-1'));
    expect(await screen.findByText(/整条/)).toBeInTheDocument();
  });

  it('`consumed` ⇒ 「删除」任何时候都禁用（不看声明能不能撤）', () => {
    renderRow(messageOf({ state: 'consumed', deliveredAt: '2026-09-22T10:31:00.000Z' }), declarationOf());
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
  });

  it('声明缺席（`null`）⇒ 已交给厂商的那条禁用（「不知道」不读作「能撤」）', () => {
    renderRow(messageOf({ state: 'delivered', deliveredAt: '2026-09-22T10:31:00.000Z' }), null);
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
    // 还在排队的那条不依赖声明：它没交给厂商，摘掉就完了
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
  });

  it('`busy` 时两颗都禁用（同一个动作连点两次没有意义，而多发一条是有害的）', () => {
    renderRow(messageOf({ state: 'queued' }), declarationOf(), true);
    expect(screen.getByRole('button', { name: '立即发送' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
  });
});

describe('点击把哪一条交出去', () => {
  it('两颗按钮各自带着**这一条**的 messageId 回调（画错行会把别人的消息撤掉）', () => {
    const onPromote = vi.fn();
    const onRetract = vi.fn();
    render(
      <InjectMessageRow
        message={messageOf({ messageId: 'm-7', state: 'queued' })}
        declaration={declarationOf()}
        onPromote={onPromote}
        onRetract={onRetract}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '立即发送' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onPromote).toHaveBeenCalledWith('m-7');
    expect(onRetract).toHaveBeenCalledWith('m-7');
  });
});
