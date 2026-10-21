/**
 * `AgentLogDrawer`（L2）的守卫。五条：
 *   1. `open === false` 时正文一个节点都不在 DOM 里（`destroyOnHidden`）；
 *   2. 打开时标题默认「执行日志」，可覆盖；
 *   3. **环境抽屉是内部件**：它挂在主抽屉的正文里，主抽屉没了它跟着没（不需要调用方接线）。
 *   4. **标题栏 = 标题 + 竖分隔线 + 连接状态点 + 节点面包屑**：面包屑只此一份（正文工具条行不再画），
 *      分隔线与它同生共死（空模型时不留一根孤线）；连接状态只有点，文字在 Tooltip 里；
 *   5. 标题栏与正文**读同一份视图态**：点面包屑换节点，正文跟着换（两份 state 时只有标题栏变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentLogModel, LogTurn, SessionNode, TextBlock } from './types';
import { AgentLogDrawer } from './agent-log-drawer';
import { installResizeObserverStub } from '../../testing/resize-observer';

const AT = '2026-10-02T10:44:31.000Z';

beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function textBlock(id: string, text: string): TextBlock {
  return {
    kind: 'text',
    id,
    at: AT,
    messageId: 'm1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
    text,
  };
}

const TURNS: LogTurn[] = [
  {
    round: 1,
    segment: 0,
    at: AT,
    subagentId: null,
    blocks: [textBlock('b1', '抽屉里的正文')],
    // 兜底定位键（规则 3）：夹具里就是首块的消息 id
    fallbackMessageId: 'm1',
    tokens: null,
    durationMs: null,
    running: false,
  },
];

/** 一轮一条正文：换节点时正文跟着换，用例靠这段文字判断「现在看的是哪个节点」 */
function turnWith(text: string): LogTurn {
  return {
    round: 1,
    segment: 0,
    at: AT,
    subagentId: null,
    blocks: [textBlock(`b-${text}`, text)],
    fallbackMessageId: 'm1',
    tokens: null,
    durationMs: null,
    running: false,
  };
}

/** 会话节点夹具：只覆盖要考的那几格，其余给「主会话、跑着的空会话」 */
function sessionNode(overrides: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    kind: 'main',
    parentId: null,
    spawnedBy: null,
    status: 'running',
    statusMissing: null,
    startedAt: AT,
    endedAt: null,
    content: { status: 'ready', data: TURNS },
    contentTruncatedReason: null,
    capability: {},
    capabilityNotes: [],
    source: 'wire',
    subagentId: null,
    vendorId: null,
    dispatchKind: null,
    name: null,
    nameMissing: null,
    userPrompt: null,
    usage: null,
    outcome: null,
    sessionFacts: null,
    ...overrides,
  };
}

function model(nodes: readonly SessionNode[] = [sessionNode({ id: 'main' })], activeNodeId = 'main'): AgentLogModel {
  return {
    specVersion: 1,
    facts: {
      status: { tone: 'running', label: '执行中' },
      startedAt: AT,
      endedAt: null,
      turns: { current: 1, total: null },
      tokens: null,
      thinking: null,
      domain: [],
      error: null,
    },
    nodes,
    activeNodeId,
    candidateEvents: [],
    // 段这一层的事实：本夹具没有追问，故一个段标题都不画
    segments: [],
    empty: false,
  };
}

describe('AgentLogDrawer', () => {
  it('open === false 时不渲染正文', () => {
    render(<AgentLogDrawer open={false} onClose={vi.fn()} model={model()} />);

    expect(screen.queryByText('抽屉里的正文')).toBeNull();
    expect(screen.queryByTestId('agent-log-layout')).toBeNull();
  });

  it('open === true 时标题是「执行日志」，正文取满抽屉（布局在里面）', () => {
    render(<AgentLogDrawer open onClose={vi.fn()} model={model()} />);

    expect(screen.getByText('执行日志')).toBeInTheDocument();
    expect(screen.getByTestId('agent-log-layout')).toBeInTheDocument();
    expect(screen.getByText('抽屉里的正文')).toBeInTheDocument();
  });

  it('标题可覆盖（默认只是省事的那个）', () => {
    render(<AgentLogDrawer open onClose={vi.fn()} model={model()} title="第 3 候选的执行日志" />);

    expect(screen.getByText('第 3 候选的执行日志')).toBeInTheDocument();
    expect(screen.queryByText('执行日志')).toBeNull();
    // 覆盖的只是标题文字：导航（面包屑）仍跟着走，不因换标题而消失
    expect(screen.getByTestId('log-node-breadcrumb')).toHaveTextContent('主会话');
  });

  /**
   * 面包屑住在**标题栏**：`执行日志 | 主会话`。
   *
   * 判据是「在标题栏、且只此一份」：`AgentLogLayout` 里那份仍在（内嵌形态要用），
   * 抽屉必须让它别画（`nodeBreadcrumbPlacement: 'header'`）——两处各画一份、
   * 视觉上就是同一句「主会话」出现两次。
   */
  it('标题栏 = 标题 + 竖分隔线 + 面包屑（正文工具条行不再画第二份）', () => {
    render(<AgentLogDrawer open onClose={vi.fn()} model={model()} />);

    const breadcrumb = screen.getByTestId('log-node-breadcrumb');
    // 正文事实条也有竖分隔线（用量｜耗时｜步数），故只取**标题栏里**那一根
    const header = document.querySelector('.ant-drawer-header');
    const divider = header?.querySelector('[role="separator"]');
    expect(divider).not.toBeNull();
    // `expect` 不参与类型收窄：这里显式挡住 `null`，下面才敢直接读
    if (divider === null || divider === undefined) throw new Error('标题栏里没有竖分隔线');

    expect(screen.getAllByTestId('log-node-breadcrumb')).toHaveLength(1);
    expect(breadcrumb).toHaveTextContent('主会话');
    // 两者都不在布局里 ⇒ 在标题栏（布局是正文的根）
    expect(breadcrumb.closest('[data-testid="agent-log-layout"]')).toBeNull();
    expect(divider.closest('[data-testid="agent-log-layout"]')).toBeNull();
    // 同一行、且分隔线在标题与面包屑之间
    expect(divider.parentElement).toBe(breadcrumb.parentElement);
    expect(divider.compareDocumentPosition(breadcrumb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('空模型：不画面包屑，也不留一根后面什么都没有的竖线', () => {
    render(<AgentLogDrawer open onClose={vi.fn()} model={model([], '')} />);

    expect(screen.queryByTestId('log-node-breadcrumb')).toBeNull();
    // 正文事实条的竖分隔线不算：这条判的是**标题栏里**有没有一根孤线
    expect(document.querySelector('.ant-drawer-header [role="separator"]')).toBeNull();
    expect(screen.getByText('执行日志')).toBeInTheDocument();
  });

  /**
   * 标题栏与正文**读同一份视图态**：点面包屑里那一段回退到主会话，正文跟着换。
   * 两份 state 各自 `useAgentLogView` 时，标题栏那份点了只改标题栏 ⇒ 正文永远是子任务，
   * 而这条用例是唯一会红的地方（结构断言看不出「两份 state」）。
   */
  it('点标题栏面包屑换节点，正文跟着换（标题栏与正文共用一份视图态）', () => {
    const main = sessionNode({ id: 'main', content: { status: 'ready', data: [turnWith('主会话正文')] } });
    const sub = sessionNode({
      id: 'sub',
      kind: 'subagent',
      parentId: 'main',
      subagentId: 'sa-1',
      name: '子任务甲',
      content: { status: 'ready', data: [turnWith('子任务正文')] },
    });

    render(<AgentLogDrawer open onClose={vi.fn()} model={model([main, sub], 'sub')} />);

    // 初始站在子任务上：面包屑是「主会话 / 子任务甲」，正文是子任务的
    expect(screen.getByTestId('log-node-breadcrumb')).toHaveTextContent('主会话');
    expect(screen.getByTestId('log-node-breadcrumb')).toHaveTextContent('子任务甲');
    expect(screen.getByText('子任务正文')).toBeInTheDocument();

    // 同层只有一个节点 ⇒ 「主会话」那一段本身就是入口（没有下拉），点它回退
    fireEvent.click(screen.getByText('主会话'));

    expect(screen.getByText('主会话正文')).toBeInTheDocument();
    expect(screen.queryByText('子任务正文')).toBeNull();
  });

  it('页面侧的三个接线位透传到底（notice / liveError / connected）', async () => {
    render(
      <AgentLogDrawer
        open
        onClose={vi.fn()}
        model={model()}
        notice="日志可能不完整：事件文件读失败，手上这份是已收到的部分"
        liveError="实时通道已断"
        connected={false}
      />,
    );

    expect(screen.getByTestId('agent-log-notice')).toHaveTextContent('日志可能不完整');
    expect(screen.getByTestId('agent-log-live-error')).toHaveTextContent('实时通道已断');

    /*
     * 连接状态现在只有**一个点**、文字进 Tooltip：判据分三层——
     * ① 文案挂在 `aria-label` 上（读屏不靠悬停）；② 点在面包屑**之前**（标题栏里的位置）；
     * ③ 那句话真的能浮出来（只挂 `aria-label` 而 Tooltip 空着，鼠标用户就什么都看不到）。
     */
    const dot = screen.getByTestId('agent-log-connection');
    expect(dot).toHaveAttribute('aria-label', '离线未连接');
    expect(dot).toHaveTextContent('');
    expect(dot.closest('.ant-drawer-header')).not.toBeNull();
    const breadcrumb = screen.getByTestId('log-node-breadcrumb');
    expect(dot.compareDocumentPosition(breadcrumb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.mouseEnter(dot);
    expect(await screen.findByText('离线未连接')).toBeInTheDocument();
  });

  it('连接状态：连上时是 processing 档；不传 connected 就没有那一格', () => {
    const { rerender } = render(<AgentLogDrawer open onClose={vi.fn()} model={model()} connected />);
    const dot = screen.getByTestId('agent-log-connection');
    expect(dot).toHaveAttribute('aria-label', '实时连接中');
    // `processing` 的动效是「真的在流」的信号，断线时必须是中性档（上面那条用例钉的 false 支）
    expect(dot.querySelector('.ant-badge-status-processing')).not.toBeNull();

    rerender(<AgentLogDrawer open onClose={vi.fn()} model={model()} />);
    expect(screen.queryByTestId('agent-log-connection')).toBeNull();
  });

  it('主抽屉关闭时环境抽屉不在 DOM 里（结构性保证：它是内部件）', () => {
    // 关着的时候：正文与环境抽屉**都不在**（`destroyOnHidden`；不是渲染一个空壳再靠 CSS 藏起来）
    const closed = render(<AgentLogDrawer open={false} onClose={vi.fn()} model={model()} />);
    expect(closed.queryByTestId('agent-log-layout')).toBeNull();
    expect(closed.queryByTestId('agent-environment-drawer')).toBeNull();
    closed.unmount();

    // 开着的时候：环境抽屉**只在主抽屉的正文里**存在（它是 `AgentLogLayout` 的内部件）
    const opened = render(<AgentLogDrawer open onClose={vi.fn()} model={model()} />);
    fireEvent.click(opened.getByRole('button', { name: '环境信息' }));
    expect(opened.getByTestId('agent-environment-drawer')).toBeInTheDocument();

    // 主抽屉一卸载，第二层跟着没：调用方不需要记得「关主抽屉时一起关」。
    // 用 `unmount()` 而不是 `rerender(open={false})` 是有意的：rc-drawer 的面板 motion 是
    // `removeOnLeave: false`，离场要等 `transitionend` 才结算，而 jsdom 从不发这个事件
    // ⇒ 「关掉之后 DOM 还在（挂着 hidden 类）」是环境事实，不是被测代码的问题。
    opened.unmount();
    expect(screen.queryByTestId('agent-environment-drawer')).toBeNull();
    expect(screen.queryByTestId('agent-log-layout')).toBeNull();
  });
});
