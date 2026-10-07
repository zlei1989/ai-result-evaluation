/**
 * SubagentBar：派发点上的导航入口。
 *
 * 七条守卫：
 *   · **任务名为空时用 id 前缀兜底**（`子任务 <subagentId 前 8 位>`），**不显示空白**；
 *   · `status` 七档各有一句中文，其中 **`unsettled` 与 `running` 必须是两句不同的话**
 *     （「等不到了」vs「还在等」——变异体 (v) 的落点，归并后一个被强杀的子任务会永远显示运行中）；
 *   · `statusMissing` 非空时**状态与「状态未采集」同时出现**（两句并列）；
 *   · 三格拿不到时各显示「未采集」；**`usage === null` 且主会话时整格不画**（它本来就不在这一格）；
 *   · **用量的三个数带千分位**（与事实条同一口径；改回裸数字当场就红）；
 *   · 「进入」不给回调时 disabled、「重试」不给回调时**不渲染**；
 *   · **版面是「头部左右 + 两行三格」**：身份在左、动作在右（重试先于进入），
 *     结果摘要独占一行，第二行左「用量」右「派发方式」——见文件末尾那一组。
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserverStub } from '../../testing/resize-observer';
import { SubagentBar } from './subagent-bar';
import type { SessionNode } from './types';
import { LOG_NODE_STATUS_LABELS } from './types';

// `Descriptions` 的响应式与 `EllipsisText` 的省略测量都要 `ResizeObserver` / `matchMedia`（jsdom 都没有）
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('SubagentBar', () => {
  it('任务名为 null 时用 subagentId 前 8 位兜底（不显示空白）', () => {
    render(<SubagentBar node={node({ name: null })} />);

    expect(screen.getByText('子任务 sub-1234')).toBeInTheDocument();
  });

  it('任务名与 subagentId 都没有时用节点 id 前 8 位兜底', () => {
    render(<SubagentBar node={node({ name: null, subagentId: null })} />);

    expect(screen.getByText('子任务 node-123')).toBeInTheDocument();
  });

  it('状态七档各出一句中文', () => {
    for (const status of Object.keys(LOG_NODE_STATUS_LABELS) as Array<keyof typeof LOG_NODE_STATUS_LABELS>) {
      const { unmount } = render(<SubagentBar node={node({ status })} />);
      expect(screen.getByText(LOG_NODE_STATUS_LABELS[status])).toBeInTheDocument();
      unmount();
    }
  });

  it('unsettled 与 running 是两句不同的话（「等不到了」不能被并进「还在等」）', () => {
    expect(LOG_NODE_STATUS_LABELS.unsettled).not.toBe(LOG_NODE_STATUS_LABELS.running);

    render(<SubagentBar node={node({ status: 'unsettled' })} />);
    expect(screen.queryByText(LOG_NODE_STATUS_LABELS.running)).toBeNull();
  });

  it('状态没采到时：状态与「状态未采集 · 原因」两句并列', () => {
    render(<SubagentBar node={node({ status: 'unknown', statusMissing: 'not-supported' })} />);

    expect(screen.getByText('状态未知')).toBeInTheDocument();
    expect(screen.getByText('状态未采集 · 这家结构上不支持')).toBeInTheDocument();
  });

  it('三格拿不到时各显示「未采集」而不是空白', () => {
    render(<SubagentBar node={node({ dispatchKind: null, outcome: null, usage: null })} />);

    expect(screen.getAllByText('未采集')).toHaveLength(2);
    expect(screen.getByText('用量未采集')).toBeInTheDocument();
  });

  it('主会话没采到用量时不画这一格（它本来就不在节点上）', () => {
    render(<SubagentBar node={node({ kind: 'main', usage: null })} />);

    expect(screen.queryByText('用量')).toBeNull();
    expect(screen.queryByText('用量未采集')).toBeNull();
  });

  it('子任务有用量时三项都显示', () => {
    render(<SubagentBar node={node()} />);

    expect(screen.getByText('输入 10 tok · 缓存 2 tok · 输出 3 tok')).toBeInTheDocument();
  });

  /**
   * 用量的三个数走 `formatUsageTriple`（千分位 + `tok` 单位，与事实条 / 逐轮页脚 / 里程碑同一出口）。
   * 为什么值得钉：`500864` 要一位一位数，而**同一个数**在事实条上已经是 `500,864 tok`——
   * 同一个量在两处长得不一样，会让人怀疑自己看错了行。这里**用字面量断言**：
   * 改回裸数字（`${usage.cached}`）或去掉单位当场就红。
   */
  it('用量三个数带千分位与 `tok` 单位，且真的 0 仍显示成 `0 tok`', () => {
    render(<SubagentBar node={node({ usage: { input: 15763, cached: 500864, output: 0 } })} />);

    expect(screen.getByText('输入 15,763 tok · 缓存 500,864 tok · 输出 0 tok')).toBeInTheDocument();
    // 千分位不该把真实的 0 吃掉（0 是读数，「未采集」不是）
    expect(screen.queryByText('用量未采集')).toBeNull();
  });

  it('「进入」给了回调才可点，点了把 nodeId 带出去', () => {
    const onEnter = vi.fn();
    const { unmount } = render(<SubagentBar node={node()} onEnter={onEnter} />);
    screen.getByText('进入 ▸').click();
    expect(onEnter).toHaveBeenCalledWith('node-12345678');
    unmount();

    render(<SubagentBar node={node()} />);
    expect(screen.getByText('进入 ▸').closest('button')).toBeDisabled();
  });

  it('「重试」只在给了 onRetry 时出现', () => {
    const onRetry = vi.fn();
    const { unmount } = render(<SubagentBar node={node()} />);
    expect(screen.queryByText('重试')).toBeNull();
    unmount();

    render(<SubagentBar node={node()} onRetry={onRetry} />);
    screen.getByText('重试').click();
    expect(onRetry).toHaveBeenCalledWith('node-12345678');
  });
});

/**
 * 版面：头部左右布局 + 两行三格。
 *
 * **为什么只钉结构、不钉几何**：jsdom 不做布局，`getBoundingClientRect()` 全是 0，
 * 真实坐标只能留给冒烟测试（AGENT.md「几何断言别靠眼睛」）。这里钉的是**结构**——谁是谁的兄弟、
 * 谁在谁前面、哪一格带 `marginInlineStart: auto`。这四条各自都能被单独变异掉：
 *   · 动作组不带 auto 外边距 / 退回 `justify="space-between"`（名称长到换行时它会被推到左端）；
 *   · 「重试」与「进入」调回原顺序；
 *   · 摘要被塞回第二行（三格并排，长文本只剩三分之一宽度）；
 *   · 第二行两格调换左右。
 *
 * 取「一格」的方式：标签是那格（竖向 Flex）的第一个子节点，故 `label.parentElement` 就是格子本身。
 */
function fieldBox(label: string): HTMLElement {
  return screen.getByText(label).parentElement as HTMLElement;
}

describe('SubagentBar 的版面', () => {
  it('头部左右布局：身份在左、动作在右，且「重试」排在「进入」之前', () => {
    render(<SubagentBar node={node()} onEnter={vi.fn()} onRetry={vi.fn()} />);

    const enter = screen.getByText('进入 ▸').closest('button') as HTMLElement;
    const retry = screen.getByText('重试').closest('button') as HTMLElement;
    const actions = enter.parentElement as HTMLElement;

    // 两个按钮同属一个动作组，不是散在身份那一行里
    expect(actions).toBe(retry.parentElement);
    // 组内顺序：重试在前、进入在后（导航入口占最右角）
    expect(actions.textContent).toBe('重试进入 ▸');
    // 动作组自己顶到右端：auto 外边距（换行之后也贴右；`justify` 只管当前行，换行后单元素会被推到左端）
    expect(actions.style.marginInlineStart).toBe('auto');

    // 身份组是它的前一个兄弟：左身份、右动作
    const identity = actions.previousElementSibling as HTMLElement;
    expect(identity.textContent).toContain('子任务');
    expect(identity.textContent).toContain('查资料');
    expect(identity.contains(enter)).toBe(false);
  });

  it('字段分两行：结果摘要独占一行，第二行左「用量」右「派发方式」', () => {
    render(<SubagentBar node={node()} />);

    const outcome = fieldBox('结果摘要');
    const secondRow = fieldBox('用量').parentElement as HTMLElement;
    const usage = fieldBox('用量');
    const dispatch = fieldBox('派发方式');

    // 摘要是**头部行的下一个兄弟**、不在第二行里：它是独占的一行，不是第二行的第一格
    expect(outcome.parentElement).not.toBe(secondRow);
    expect(outcome.previousElementSibling?.textContent).toContain('子任务');
    expect(secondRow.previousElementSibling).toBe(outcome);

    // 第二行两格：用量在左、派发方式在右（后者 auto 外边距顶到右端）
    expect(dispatch.parentElement).toBe(secondRow);
    expect(usage.compareDocumentPosition(dispatch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dispatch.style.marginInlineStart).toBe('auto');
    expect(usage.style.marginInlineStart).toBe('');
  });

  /**
   * 主会话没有用量那一格（它在 `facts.tokens` 上，不在节点上），此时第二行只剩「派发方式」。
   * 它必须**仍然贴右**——`justify="space-between"` 在只有一个子元素时会把它推到左端
   * （`base/toolbar.tsx` 的注释记着同一族事故），这一条就是那个写法的靶子。
   */
  it('第二行没有用量那一格时，「派发方式」仍在右端', () => {
    render(<SubagentBar node={node({ kind: 'main', usage: null })} />);

    expect(screen.queryByText('用量')).toBeNull();
    expect(fieldBox('派发方式').style.marginInlineStart).toBe('auto');
  });
});
