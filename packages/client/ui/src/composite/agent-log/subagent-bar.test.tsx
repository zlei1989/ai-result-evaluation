/**
 * SubagentBar（`Subagent` 形态）：派发点上的一条 `TraceCollapsible` + 导航入口。
 *
 * 七条语义守卫：
 * · **任务名为空时用 id 前缀兜底**（`子任务 <subagentId 前 8 位>`），**不显示空白**；
 * · `status` 七档各有一句中文，其中 **`unsettled` 与 `running` 必须是两句不同的话**
 *   （「等不到了」vs「还在等」——归并后一个被强杀的子任务会永远显示运行中）；
 * · `statusMissing` 非空时**状态与「状态未采集」同时出现**（两句并列）；
 * · 三格拿不到时各显示「未采集」；**`usage === null` 且主会话时整格不画**（它本来就不在这一格）；
 * · **用量的三个数带千分位**（与事实条同一口径；改回裸数字当场就红）；
 * · 「进入」不给回调时 disabled、「重试」不给回调时**不渲染**；
 * · **耗时**（`endedAt - startedAt`）在摘要行上，如 `48s`。
 *
 * 三条形态守卫（本票的核心：**它不再是一整张卡**）：
 * · 根节点是 `[data-slot="trace"]`，**没有 Card**；
 * · 收起态 DOM 里只有**一行** `[data-slot="trace-line"]`，展开体（结果摘要 / 用量 / 派发方式）
 *   根本没挂载——「高度明显下降」在结构上就是这个意思，不是只换文案；
 * · `aria-expanded` 完全来自受控 `open`（组件不持态）；「进入」「重试」是**触发器的兄弟节点**，
 *   不在触发器里面（按钮不能嵌套按钮），且进出子任务仍是这一行上**唯一有副作用**的动作。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubagentBar } from './subagent-bar';
import type { SessionNode } from './types';
import { LOG_NODE_STATUS_LABELS } from './types';

function node(overrides: Partial<SessionNode> = {}): SessionNode {
  return {
    id: 'node-12345678',
    parentId: null,
    spawnedBy: null,
    status: 'running',
    statusMissing: null,
    startedAt: null,
    endedAt: null,
    content: { status: 'ready', data: [] },
    contentTruncatedReason: null,
    capability: {},
    capabilityNotes: [],
    kind: 'subagent',
    source: 'wire',
    subagentId: 'sub-12345678',
    vendorId: null,
    dispatchKind: 'Task',
    name: '查资料',
    nameMissing: null,
    userPrompt: null,
    usage: { input: 10, cached: 2, output: 3 },
    outcome: '找到 3 条相关记录',
    sessionFacts: null,
    ...overrides,
  };
}

const base = { open: false, onOpenChange: vi.fn() };

describe('SubagentBar', () => {
  it('任务名为 null 时用 subagentId 前 8 位兜底（不显示空白）', () => {
    render(<SubagentBar node={node({ name: null })} {...base} />);

    expect(screen.getByText('子任务 sub-1234')).toBeInTheDocument();
  });

  it('任务名与 subagentId 都没有时用节点 id 前 8 位兜底', () => {
    render(<SubagentBar node={node({ name: null, subagentId: null })} {...base} />);

    expect(screen.getByText('子任务 node-123')).toBeInTheDocument();
  });

  it('状态七档各出一句中文', () => {
    for (const status of Object.keys(LOG_NODE_STATUS_LABELS) as Array<keyof typeof LOG_NODE_STATUS_LABELS>) {
      const { unmount } = render(<SubagentBar node={node({ status })} {...base} />);
      expect(screen.getByText(LOG_NODE_STATUS_LABELS[status])).toBeInTheDocument();
      unmount();
    }
  });

  it('unsettled 与 running 是两句不同的话（「等不到了」不能被并进「还在等」）', () => {
    expect(LOG_NODE_STATUS_LABELS.unsettled).not.toBe(LOG_NODE_STATUS_LABELS.running);

    render(<SubagentBar node={node({ status: 'unsettled' })} {...base} />);
    expect(screen.queryByText(LOG_NODE_STATUS_LABELS.running)).toBeNull();
  });

  it('耗时在摘要行上：`endedAt - startedAt` 写成 48s', () => {
    render(
      <SubagentBar
        node={node({ startedAt: '2026-10-02T08:00:00.000Z', endedAt: '2026-10-02T08:00:48.000Z' })}
        {...base}
      />,
    );

    expect(screen.getByText('48s')).toBeInTheDocument();
  });

  it('状态没采到时：状态与「状态未采集 · 原因」两句并列（原因在展开体里）', () => {
    render(
      <SubagentBar node={node({ status: 'unknown', statusMissing: 'not-supported' })} open onOpenChange={vi.fn()} />,
    );

    expect(screen.getByText('状态未知')).toBeInTheDocument();
    expect(screen.getByText('状态未采集 · 这家结构上不支持')).toBeInTheDocument();
  });

  it('三格拿不到时各显示「未采集」而不是空白', () => {
    render(
      <SubagentBar
        node={node({ dispatchKind: null, outcome: null, usage: null })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText('未采集')).toHaveLength(2);
    expect(screen.getByText('用量未采集')).toBeInTheDocument();
  });

  it('主会话没采到用量时不画这一格（它本来就不在节点上）', () => {
    render(<SubagentBar node={node({ kind: 'main', usage: null })} open onOpenChange={vi.fn()} />);

    expect(screen.queryByText('用量')).toBeNull();
    expect(screen.queryByText('用量未采集')).toBeNull();
  });

  it('子任务有用量时三项都显示', () => {
    render(<SubagentBar node={node()} open onOpenChange={vi.fn()} />);

    expect(screen.getByText('输入 10 tok · 缓存 2 tok · 输出 3 tok')).toBeInTheDocument();
  });

  /**
   * 用量的三个数走 `formatUsageTriple`（千分位 + `tok` 单位，与事实条 / 逐轮页脚 / 里程碑同一出口）。
   * 为什么值得钉：`500864` 要一位一位数，而**同一个数**在事实条上已经是 `500,864 tok`——
   * 同一个量在两处长得不一样，会让人怀疑自己看错了行。这里**用字面量断言**：
   * 改回裸数字（`${usage.cached}`）或去掉单位当场就红。
   */
  it('用量三个数带千分位与 `tok` 单位，且真的 0 仍显示成 `0 tok`', () => {
    render(
      <SubagentBar
        node={node({ usage: { input: 15763, cached: 500864, output: 0 } })}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(screen.getByText('输入 15,763 tok · 缓存 500,864 tok · 输出 0 tok')).toBeInTheDocument();
    // 千分位不该把真实的 0 吃掉（0 是读数，「未采集」不是）
    expect(screen.queryByText('用量未采集')).toBeNull();
  });

  it('「进入」给了回调才可点，点了把 nodeId 带出去', () => {
    const onEnter = vi.fn();
    const { unmount } = render(<SubagentBar node={node()} {...base} onEnter={onEnter} />);
    fireEvent.click(screen.getByText('进入 ▸'));
    expect(onEnter).toHaveBeenCalledWith('node-12345678');
    unmount();

    render(<SubagentBar node={node()} {...base} />);
    expect(screen.getByText('进入 ▸').closest('button')).toBeDisabled();
  });

  it('「重试」只在给了 onRetry 时出现', () => {
    const onRetry = vi.fn();
    const { unmount } = render(<SubagentBar node={node()} {...base} />);
    expect(screen.queryByText('重试')).toBeNull();
    unmount();

    render(<SubagentBar node={node()} {...base} onRetry={onRetry} />);
    fireEvent.click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalledWith('node-12345678');
  });
});

describe('SubagentBar 的形态（不再是一整张卡）', () => {
  /**
   * **结构 + 高度语义**：根节点是 `Trace`，收起态只有一行 `TraceLine`，展开体不在 DOM 里。
   * 四条各挡一种退回：退回 `Card`（第一条）、退回「四行头部 + 字段」的整张卡面（第二条）、
   * 把展开体做成视觉收起（第三条，`Trace` 的 Panel 默认卸载）、
   * 把「进入」塞进触发器（第四条，按钮嵌套按钮是无效 HTML）。
   */
  it('收起态：根是 trace、只有一行 trace-line、展开体没挂载、没有 Card', () => {
    const { container } = render(<SubagentBar node={node()} {...base} />);

    expect(container.querySelector('[data-slot="trace"]')).not.toBeNull();
    // 形态是 Trace 那一条线，不是一张卡；「antd 不许回来」由仓库级守卫
    // `apps/web-next/src/antd-free.test.ts` 守，这里只钉新栈的结构
    expect(container.querySelector('[data-slot="card"]')).toBeNull();

    expect(container.querySelectorAll('[data-slot="trace-line"]')).toHaveLength(1);
    // 展开体里的三格都不在 DOM 里 ⇒ 高度就是那一行，而不是「四行卡面」
    expect(screen.queryByText('结果摘要')).toBeNull();
    expect(screen.queryByText('用量')).toBeNull();
    expect(screen.queryByText('派发方式')).toBeNull();
  });

  it('摘要行是触发器、开合受控：aria-expanded 跟 open 走，点击只把 !open 交回调用方', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<SubagentBar node={node()} open={false} onOpenChange={onOpenChange} />);

    const trigger = screen.getByRole('button', { name: /查资料/ });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(true);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    rerender(<SubagentBar node={node()} open onOpenChange={onOpenChange} />);
    expect(screen.getByRole('button', { name: /查资料/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('结果摘要')).toBeInTheDocument();
  });

  it('「进入」「重试」是触发器的兄弟节点（不在按钮里面），且排在触发器之后', () => {
    render(<SubagentBar node={node()} {...base} onEnter={vi.fn()} onRetry={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: /查资料/ });
    const enter = screen.getByText('进入 ▸').closest('button') as HTMLElement;
    const retry = screen.getByText('重试').closest('button') as HTMLElement;

    expect(trigger.contains(enter)).toBe(false);
    expect(trigger.contains(retry)).toBe(false);
    // 同一行里：触发器在前、动作组在后（动作组靠 auto 外边距顶到右端）
    expect(enter.parentElement).toBe(retry.parentElement);
    expect(trigger.parentElement).toBe(enter.parentElement?.parentElement);
  });
});
