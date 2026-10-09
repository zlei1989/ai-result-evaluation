/**
 * `AgentLogDrawer`（L2）的守卫。三条：
 *   1. `open === false` 时正文一个节点都不在 DOM 里（`destroyOnHidden`）；
 *   2. 打开时标题默认「执行日志」，可覆盖；
 *   3. **环境抽屉是内部件**：它挂在主抽屉的正文里，主抽屉没了它跟着没（不需要调用方接线）。
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
    usage: null,
    text,
  };
}

const TURNS: LogTurn[] = [
  { round: 1, at: AT, subagentId: null, blocks: [textBlock('b1', '抽屉里的正文')], tokens: null, durationMs: null, running: false },
];

function model(): AgentLogModel {
  const node: SessionNode = {
    kind: 'main',
    id: 'main',
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
  };
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
    nodes: [node],
    activeNodeId: 'main',
    rowEvents: [],
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
    render(<AgentLogDrawer open onClose={vi.fn()} model={model()} title="第 3 行的执行日志" />);

    expect(screen.getByText('第 3 行的执行日志')).toBeInTheDocument();
    expect(screen.queryByText('执行日志')).toBeNull();
  });

  it('页面侧的三个接线位透传到底（notice / liveError / connected）', () => {
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
    expect(screen.getByText('未连接')).toBeInTheDocument();
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
