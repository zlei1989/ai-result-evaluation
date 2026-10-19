/**
 * TaskPanelCard（`Plan` + `Queue` 形态）：摘要行 + 步骤 `TraceLine`，两段清单。
 *
 * 守卫（前两条是「不自己算」的落实）：
 *   · **计数照数据层给的渲染**：夹具里 `counts` 与 `steps.length` 故意不一致
 *     （7 vs 3），UI 自己数一遍就会显示成 `1/3 完成`；
 *   · 变化摘要只给非 0 的分量（`+1 完成 · +2 新增 · −1 移除`）；
 *   · 四态各出中文：`unknown` **不显示成成功**，且「未完成」段能看到它（它既不能算完成、也不能被藏起来）；
 *   · `steps` 空数组 → 「清单为空（这家报了空表）」；分母为 0 → 摘要行写「清单为空」；
 *   · `owner === null` **整格不显示**（这家没有「指派」这个概念）、`owner === ''` 显示「未指派」；
 *     `id === null` 时不画依赖（**不自己发号**）；
 *   · **形态是 Trace / Plan / Queue**（用例名见「摘要行是唯一触发器」「步骤是 TraceLine」
 *     与「已完成段默认收起」三条）：根节点是 `[data-slot="trace"]`、摘要行包在
 *     `TraceCollapsibleTrigger` 里（`aria-expanded` 跟受控 `open` 走）、步骤是 `[data-slot="trace-line"]`，
 *     **不再有 `<table>` / 列头 / 分页**；
 *   · **「进行中展开、完成收起」的第二半在组件里**：外层 `open` 由 `useAgentLogView` 下传
 *     （默认键只认 `running`），已完成那一段默认收起、由 `${cardId}|done` 键控开合；
 *   · `earlierCount > 0` 出「本轮另有 N 次更新」，`note` 可见。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskPanelCard } from './task-panel-card';
import type { TaskPanel, TaskStep } from './types';

const AT = '2026-10-02T08:00:00.000Z';

function step(overrides: Partial<TaskStep> = {}): TaskStep {
  return { id: 't1', subject: '写实现', status: 'pending', owner: null, blockedBy: null, ...overrides };
}

function panel(overrides: Partial<TaskPanel> = {}): TaskPanel {
  return {
    // 故意与 counts 不一致：UI 照 counts 渲染，自己数 steps 会得到 1/3
    steps: [
      step({ id: 't1', subject: '写实现' }),
      step({ id: 't2', subject: '跑测试', status: 'inProgress', owner: 'alice' }),
      step({ id: 't3', subject: '改文档', status: 'completed', owner: '', blockedBy: ['t1'] }),
    ],
    counts: { pending: 1, inProgress: 1, completed: 4, unknown: 1 },
    change: { completed: 1, added: 2, removed: 1 },
    note: '按评审意见调整了顺序',
    at: AT,
    result: { ok: true, raw: '{"todos":[]}', truncation: { kind: 'none' } },
    running: false,
    ...overrides,
  };
}

const props = {
  cardId: 'card-1',
  earlierCount: 0,
  open: true,
  onOpenChange: vi.fn(),
  rawOpen: false,
  onRawOpenChange: vi.fn(),
};

/** 摘要行（Plan 的那一行）：唯一带 `aria-expanded` 的「计划清单」按钮 */
const summaryTrigger = (): HTMLElement => screen.getByRole('button', { name: /计划清单/ });

/** 一条步骤行（按标题文本定位）；TraceLine 的 `data-slot` 是结构判据 */
const stepLine = (subject: string): HTMLElement => {
  const line = screen.getByText(subject).closest<HTMLElement>('[data-slot="trace-line"]');
  if (line === null) throw new Error(`「${subject}」没有画成 TraceLine`);
  return line;
};

describe('TaskPanelCard', () => {
  it('计数照数据层给的渲染（含 unknown 的那一格，分母是四格之和）', () => {
    render(<TaskPanelCard {...props} panel={panel()} />);

    expect(screen.getByText('4/7 完成')).toBeInTheDocument();
    // UI 自己数 steps 会显示成 1/3
    expect(screen.queryByText('1/3 完成')).toBeNull();
  });

  it('变化摘要：只显示非 0 的分量', () => {
    const { unmount } = render(<TaskPanelCard {...props} panel={panel()} />);
    expect(screen.getByText('+1 完成 · +2 新增 · −1 移除')).toBeInTheDocument();
    unmount();

    render(<TaskPanelCard {...props} panel={panel({ change: { completed: 2, added: 0, removed: 0 } })} />);
    expect(screen.getByText('+2 完成')).toBeInTheDocument();
    expect(screen.queryByText(/新增/)).toBeNull();
    expect(screen.queryByText(/移除/)).toBeNull();
  });

  it('没有可比的上一张清单（change === null）时不给变化摘要', () => {
    render(<TaskPanelCard {...props} panel={panel({ change: null })} />);

    expect(screen.queryByText(/完成 ·/)).toBeNull();
  });

  it('四态各出中文；unknown 在「未完成」段可见，且不显示成成功', () => {
    render(
      <TaskPanelCard
        {...props}
        panel={panel({
          counts: { pending: 1, inProgress: 1, completed: 1, unknown: 1 },
          steps: [
            step({ id: 's1', subject: '一', status: 'pending' }),
            step({ id: 's2', subject: '二', status: 'inProgress' }),
            step({ id: 's3', subject: '三', status: 'completed' }),
            step({ id: 's4', subject: '四', status: 'unknown' }),
          ],
        })}
      />,
    );

    expect(stepLine('一')).toHaveTextContent('待办');
    expect(stepLine('二')).toHaveTextContent('进行中');
    // 已完成项在收起的那一段里：摘要行给数量，行本身要点开才出来
    expect(screen.getByRole('button', { name: /1 已完成/ })).toBeInTheDocument();
    expect(screen.queryByText('三')).toBeNull();

    // `unknown` 留在未完成段：它既不能算完成，也不该被藏起来
    expect(stepLine('四')).toHaveTextContent('状态未知');
    expect(stepLine('四')).toHaveAttribute('data-step-status', 'unknown');
    expect(stepLine('四')).not.toHaveAttribute('data-status', 'running');
  });

  it('steps 为空数组时显示「清单为空（这家报了空表）」而不是空白面板', () => {
    render(<TaskPanelCard {...props} panel={panel({ steps: [] })} />);

    expect(screen.getByText('清单为空（这家报了空表）')).toBeInTheDocument();
  });

  it('分母为 0 时摘要行写「清单为空」，不写 0/0', () => {
    render(
      <TaskPanelCard
        {...props}
        open={false}
        panel={panel({ counts: { pending: 0, inProgress: 0, completed: 0, unknown: 0 } })}
      />,
    );

    expect(screen.getByText('清单为空')).toBeInTheDocument();
    expect(screen.queryByText('0/0 完成')).toBeNull();
  });

  it('owner 为 null 时整格不显示；owner 为空串时显示「未指派」', () => {
    render(
      <TaskPanelCard
        {...props}
        panel={panel({
          steps: [step({ id: 'a', subject: '没人认领的概念都没有' }), step({ id: 'b', subject: '有概念但空着', owner: '' })],
        })}
      />,
    );

    // `null` = 这一家没有「指派」这个概念 ⇒ 这一格整个不画
    expect(stepLine('没人认领的概念都没有')).not.toHaveTextContent('未指派');
    // `''` = 有概念但当前无人认领 ⇒ 明说
    expect(stepLine('有概念但空着')).toHaveTextContent('未指派');
  });

  it('id 为 null 时不画依赖（blockedBy 的值就是 id，不自己发号）', () => {
    render(
      <TaskPanelCard
        {...props}
        panel={panel({ steps: [step({ id: null, subject: '没有 id 的项', blockedBy: ['t1'] })] })}
      />,
    );

    expect(screen.queryByText(/依赖/)).toBeNull();
  });

  it('拿得到 id 时把依赖画出来', () => {
    render(
      <TaskPanelCard {...props} panel={panel({ steps: [step({ id: 't9', subject: '依赖项', blockedBy: ['t1', 't2'] })] })} />,
    );

    expect(screen.getByText('依赖 t1、t2')).toBeInTheDocument();
  });

  /**
   * **结构守卫：不再是整张表。**
   *
   * 三条各挡一种退回：根节点必须是 `Trace`（`Card` / `Table` 都会让这一条红）、
   * 摘要行必须是 `Trace` 的触发器（不是正文里的一行字）、
   * DOM 里任何位置都不许出现表格 / 列头 / 分页器。
   * 只断言文案（「4/7 完成」在不在）的话，退回两列表格照样全绿。
   */
  it('形态是 Trace / Plan：根节点是 trace，摘要行是唯一触发器，没有表格与列头', () => {
    const { container } = render(<TaskPanelCard {...props} panel={panel()} />);

    expect(container.querySelector('[data-slot="trace"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(summaryTrigger()).toHaveAttribute('aria-expanded', 'true');

    // 步骤是 trace-line，不是 `<td>`
    expect(stepLine('写实现')).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0);
    expect(container.querySelector('[data-slot="table"]')).toBeNull();
  });

  it('摘要行的开合受控：aria-expanded 跟着 open 走，点击只把 !open 交回调用方', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <TaskPanelCard {...props} open={false} onOpenChange={onOpenChange} panel={panel()} />,
    );
    expect(summaryTrigger()).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(summaryTrigger());
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(true);
    expect(summaryTrigger()).toHaveAttribute('aria-expanded', 'false');

    rerender(<TaskPanelCard {...props} open onOpenChange={onOpenChange} panel={panel()} />);
    expect(summaryTrigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('摘要行状态由 `panel.running` 派生：进行中是 running，收场后没有 status', () => {
    const { container, unmount } = render(<TaskPanelCard {...props} panel={panel({ running: true })} />);
    expect(container.querySelector('[data-slot="trace-line"]')).toHaveAttribute('data-status', 'running');
    unmount();

    const { container: done } = render(<TaskPanelCard {...props} panel={panel({ running: false })} />);
    expect(done.querySelector('[data-slot="trace-line"]')?.hasAttribute('data-status')).toBe(false);
  });

  /**
   * **Queue 的第二段默认收起**（「完成收起」的组分那半）：已完成项不在 DOM 里，
   * 摘要行只给数量；点开那一段才出现。`doneOpen` 是同一份折叠态里的 `${cardId}|done` 键，
   * 组件自己不持态（分层纪律 (d)）。
   */
  it('已完成段默认收起；点它的摘要行把 true 交回调用方，回写后行才进 DOM', () => {
    const onDoneOpenChange = vi.fn();
    const { rerender } = render(
      <TaskPanelCard {...props} onDoneOpenChange={onDoneOpenChange} panel={panel()} />,
    );

    const doneTrigger = screen.getByRole('button', { name: /4 已完成/ });
    expect(doneTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('改文档')).toBeNull();

    fireEvent.click(doneTrigger);
    expect(onDoneOpenChange.mock.calls[0]?.[0]).toBe(true);
    expect(doneTrigger).toHaveAttribute('aria-expanded', 'false');

    rerender(<TaskPanelCard {...props} doneOpen onDoneOpenChange={onDoneOpenChange} panel={panel()} />);
    expect(screen.getByRole('button', { name: /4 已完成/ })).toHaveAttribute('aria-expanded', 'true');
    expect(stepLine('改文档')).toHaveTextContent('已完成');
  });

  it('本轮另有 N 次更新与 note 都可见', () => {
    render(<TaskPanelCard {...props} earlierCount={2} panel={panel()} />);

    expect(screen.getByText(/本轮另有 2 次更新/)).toBeInTheDocument();
    expect(screen.getByText('按评审意见调整了顺序')).toBeInTheDocument();
  });

  it('结果没到手时连「原始结果」入口都不画（摘要行已写过结果未采集）', () => {
    const { unmount } = render(<TaskPanelCard {...props} panel={panel()} />);
    expect(screen.getByText('原始结果')).toBeInTheDocument();
    unmount();

    render(<TaskPanelCard {...props} panel={panel({ result: null, running: false })} />);
    expect(screen.queryByText('原始结果')).toBeNull();
    expect(screen.getByText('结果未采集')).toBeInTheDocument();
  });

  it('「原始结果」入口排在步骤之后（清单之后的动作，不是清单里的第一行）', () => {
    render(<TaskPanelCard {...props} panel={panel()} />);

    const raw = screen.getByText('原始结果');
    const lastStep = stepLine('跑测试');
    expect(lastStep.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * `rawOpen` 的**透传**：卡片自己不持态（L0 纪律），开合完全听调用方——
   * 这条钉住「卡片的 `rawOpen` 真的喂进了 `RawOutputPanel`」：漏了/写死 `false` 时，
   * 底部的「原始结果」就是一个点不开的按钮，而别的用例（只查入口文案在不在）**照样全绿**。
   *
   * ⚠️ 那一份原文是 JSON ⇒ 正文走 `JsonText`，被缩进格式化并切成高亮 token
   * （`{"todos":[]}` → 三行），故判据取「载荷片段 + 高亮标记」。
   */
  it('rawOpen 透传：为真时原文真的在抽屉里，为假时同一份原文不在 DOM', () => {
    const { unmount } = render(<TaskPanelCard {...props} rawOpen panel={panel()} />);
    expect(screen.getByTestId('raw-output-body')).toBeInTheDocument();
    expect(document.body.textContent).toContain('"todos"');
    expect(document.querySelectorAll('[data-json-token]').length).toBeGreaterThan(0);
    unmount();

    render(<TaskPanelCard {...props} rawOpen={false} panel={panel()} />);
    expect(screen.getByText('原始结果')).toBeInTheDocument();
    expect(screen.queryByTestId('raw-output-body')).toBeNull();
    expect(document.body.textContent).not.toContain('"todos"');
  });
});
