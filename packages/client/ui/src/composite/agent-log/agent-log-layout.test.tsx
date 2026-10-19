/**
 * `AgentLogLayout`（L2）的守卫。七条：
 * 1. 节点内容四态：`empty` ⇒ 空态、「未到」⇒ `Skeleton`（**不是**空态）、读失败 ⇒ `Alert`（+ 有重试回调才给按钮）；
 * 2. 过滤在**轮次级**生效：不含目标块的轮次整轮隐藏，并给出 `命中 N / M 轮`；
 * 3. `timeline` 槽传函数时用传入的实现（S1/S5 的接缝）；
 * 4. **`actions` 传了用传入的、不传用预设**（变异体 (p) 的守卫）；
 * 5. `environment` 未提供时环境抽屉里显示「未提供」，而不是空白；
 * 6. 跟随最新**只有一份 state**：工具条开关与角落浮出按钮同步；活边由 Message Scroller 判，未读仍是轮次水位；
 * 7. 「这一类内容没被转发」如实说明（三条判据各一句）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  AgentLogFacts,
  AgentLogModel,
  ContentBlock,
  LogNode,
  LogTurn,
  MessageCapabilityMap,
  SessionNode,
  TextBlock,
  ToolCallBlock,
} from './types';
import { AgentLogLayout } from './agent-log-layout';
import type { AgentLogViewState } from './use-agent-log-view';
import { installResizeObserverStub } from '../../testing/resize-observer';
import { installScrollGeometry } from '../../testing/scroll-geometry';

const AT = '2026-10-02T10:44:31.000Z';
const AT2 = '2026-10-02T10:44:41.000Z';

// 布局里的虚拟列表与展开的工具行都会 new `ResizeObserver`（jsdom 没有）
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function textBlock(id: string, text: string, at = AT): TextBlock {
  return {
    kind: 'text',
    id,
    at,
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

function toolCall(id: string, callId: string, at = AT): ToolCallBlock {
  return {
    kind: 'tool-call',
    id,
    at,
    messageId: 'm1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
    callId,
    name: 'pwsh',
    nameMissing: null,
    family: 'run-shell',
    input: { value: null, text: null, bytes: null, description: null },
    tool: null,
  };
}

function turn(overrides: Partial<LogTurn> & { blocks: ContentBlock[] }): LogTurn {
  // 兜底定位键的夹具口径：**投递顺序上第一条块**的 `messageId`（用例可以用 overrides 覆写它）
  const fallbackMessageId = overrides.fallbackMessageId ?? overrides.blocks[0]?.messageId ?? null;
  return { round: 1, segment: 0, at: AT, subagentId: null, tokens: null, durationMs: null, running: false, ...overrides, fallbackMessageId };
}

function sessionNode(overrides: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    kind: 'main',
    parentId: null,
    spawnedBy: null,
    status: 'running',
    statusMissing: null,
    startedAt: AT,
    endedAt: null,
    content: { status: 'ready', data: [] },
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

/** 行级事实的默认值（连接状态那一条用例要把它改成终态，否则事实条的 processing 会干扰断言） */
const FACTS: AgentLogFacts = {
  status: { tone: 'running', label: '执行中' },
  startedAt: AT,
  endedAt: null,
  turns: { current: 1, total: null },
  tokens: null,
  thinking: null,
  domain: [],
  error: null,
  contextUsed: null,
  contextWindow: null,
};

function modelOf(node: LogNode, overrides: Partial<AgentLogModel> = {}): AgentLogModel {
  return {
    specVersion: 1,
    facts: FACTS,
    nodes: [node],
    activeNodeId: node.id,
    rowEvents: [],
    // 段这一层的事实：缺省没有追问；要考段标题的用例用 `overrides` 给
    segments: [],
    empty: false,
    ...overrides,
  };
}

function viewState(overrides: Partial<AgentLogViewState> = {}): AgentLogViewState {
  return {
    activeNodeId: 'main',
    setActiveNodeId: vi.fn(),
    follow: true,
    setFollow: vi.fn(),
    filters: { onlyTools: false, onlyErrors: false },
    setFilters: vi.fn(),
    environmentOpen: false,
    setEnvironmentOpen: vi.fn(),
    openKeys: new Set<string>(),
    onOpenChange: vi.fn(),
    ...overrides,
  };
}

function capabilityWithSubagentUnavailable(): MessageCapabilityMap {
  return { subagent: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' } };
}

const TWO_TURNS: LogTurn[] = [
  turn({ round: 1, blocks: [textBlock('t1', '第一轮：只有正文')] }),
  turn({ round: 2, at: AT2, blocks: [toolCall('c2', 'call_2', AT2)] }),
];

describe('AgentLogLayout', () => {
  it('empty 为真 ⇒ 空态（「还没有日志」），而不是空时间轴', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: [] } });

    render(<AgentLogLayout model={modelOf(node, { empty: true })} actions={[]} />);

    expect(screen.getByText('还没有日志')).toBeInTheDocument();
    expect(screen.getByText('这一行还没开始执行，或执行尚未产生输出')).toBeInTheDocument();
    expect(screen.queryByTestId('virtual-turn-list')).toBeNull();
  });

  it('内容未到 ⇒ Skeleton（不是空态文案）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'loading' } });

    const { container } = render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText('还没有日志')).toBeNull();
  });

  /**
   * **站在子任务节点上的空态**。
   *
   * 这一档若落到模型级空态，会显示「还没有日志 · **这一行还没开始执行**，或执行尚未产生输出」
   * ——而那一行明明跑完了（真机：主会话 7 轮、子任务记录齐备、`outcome` 非空）。
   * 站在子任务上的读者会把那句话读成「界面坏了」。
   */
  it('子任务节点且没有内容 ⇒ 说的是这个子任务，不是「这一行还没开始执行」', () => {
    const node = sessionNode({
      id: 'sub-1',
      kind: 'subagent',
      parentId: 'main',
      name: '整理变更清单',
      // 终态：正文确实不会再来（这一档才是「没有对话记录」）
      status: 'completed',
      content: { status: 'ready', data: [] },
    });
    // 整行只有主会话的内容 ⇒ `model.empty` 与「本节点无内容」同时成立，正是真机的形状
    render(<AgentLogLayout model={modelOf(node, { empty: true })} actions={[]} />);

    expect(screen.getByText('这个子任务没有对话记录')).toBeInTheDocument();
    expect(
      screen.queryByText('这一行还没开始执行，或执行尚未产生输出'),
      '子任务节点上出现了行级文案（会被读成「界面坏了」）',
    ).toBeNull();
  });

  /**
   * **还在跑的子任务节点**：正文只是还没到，不是「没有」。
   *
   * 派发那一刻就有一条子任务行（卡片与入口当场可点），而这一家的逐步骤正文可能要到收尾才交出来
   * ⇒ 这一档是**正常的中途态**。说成「没有对话记录」会被读成「这家不投送」，
   * 而读者要做的事完全不同：一个是再等等，一个是别等了。
   */
  it('子任务还在跑且没有内容 ⇒ 说「还在跑 / 正文还没到」，不说「没有对话记录」', () => {
    const node = sessionNode({
      id: 'sub-live',
      kind: 'subagent',
      parentId: 'main',
      name: '检查 hello world',
      status: 'running',
      content: { status: 'ready', data: [] },
    });
    render(<AgentLogLayout model={modelOf(node, { empty: true })} actions={[]} />);

    expect(screen.getByText('这个子任务还在跑')).toBeInTheDocument();
    expect(screen.queryByText('这个子任务没有对话记录')).toBeNull();
    expect(screen.queryByText('这个子任务没有逐条对话记录')).toBeNull();
  });

  /**
   * **「结果未采集」要说出为什么**。
   *
   * `AgentRunStateTag` 的 `missingReason` 由 `BlockRenderContext.capability` 供。
   * 这一格拿不到时，那三个调用点（`tool-group-panel` ×2、`task-panel-card` ×1）只能硬写 `null`，
   * 它恒等于那句光秃秃的
   * 「结果未采集」：使用者知道**没采到**，却看不到「是这家没投送、还是我们没接」——
   * 而这两件事要去做的事完全不同（一个去找厂商，一个改我们自己）。
   *
   * 两条断言成对，缺一条就失去区分力：
   *   ① 有声明 ⇒ 把那一维的**原因**接上去；
   *   ② 没有那一维 ⇒ 退回光秃秃那句（**不编一句话**，也不因为拿不到原因就显示成「进行中」）。
   */
  it('工具结果未采集时写出能力声明的原因（不是一句光秃秃的「结果未采集」）', () => {
    const node = sessionNode({
      id: 'main',
      content: { status: 'ready', data: [turn({ round: 1, blocks: [toolCall('c1', 'call_1')] })] },
      capability: { toolResult: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' } },
    });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByText('结果未采集 · 厂商有数据、但没投送到我们能读的通道')).toBeInTheDocument();
  });

  it('能力声明里没有 `toolResult` 那一维 ⇒ 退回光秃秃那句（不编原因）', () => {
    const node = sessionNode({
      id: 'main',
      content: { status: 'ready', data: [turn({ round: 1, blocks: [toolCall('c1', 'call_1')] })] },
      // 声明里只谈了子任务那一维：工具结果这一维「没谈到」不等于「没有这个能力」
      capability: { subagent: { level: 'not-projected-by-vendor', source: null, reason: 'not-exposed' } },
    });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByText('结果未采集')).toBeInTheDocument();
  });

  /** 第二个调用点：计划清单卡片的状态行同样要吃那一维（同一个原因，不许两处各写一遍） */
  it('计划清单的结果未采集时也写出同一个原因', () => {
    const node = sessionNode({
      id: 'main',
      content: {
        status: 'ready',
        data: [
          turn({
            round: 1,
            blocks: [
              {
                ...toolCall('c1', 'call_1'),
                family: 'task',
                tool: {
                  family: 'task',
                  panel: {
                    steps: [{ id: null, subject: '改 README', status: 'pending', owner: null, blockedBy: null }],
                    counts: { pending: 1, inProgress: 0, completed: 0, unknown: 0 },
                    change: null,
                    note: null,
                    at: AT,
                    // 结果没到、轮次也结束了 ⇒ 这一格正是「未采集」
                    result: null,
                    running: false,
                  },
                },
              },
            ],
          }),
        ],
      },
      capability: { toolResult: { level: 'off-by-adapter', source: null, reason: 'not-observed' } },
    });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByText('结果未采集 · 厂商有、我们还没接')).toBeInTheDocument();
  });

  it('子任务有 `outcome` 时明说「逐条记录没有、摘要在占位条里」（不让人以为什么都没采到）', () => {
    const node = sessionNode({
      id: 'sub-1',
      kind: 'subagent',
      parentId: 'main',
      name: '整理变更清单',
      // 收场载荷里的最终答复：它是**另一条通道**，与轨迹无关
      outcome: '我读完了整个文件，结论是页面正确。',
      content: { status: 'ready', data: [] },
    });
    render(<AgentLogLayout model={modelOf(node, { empty: true })} actions={[]} />);

    expect(screen.getByText('这个子任务没有逐条对话记录')).toBeInTheDocument();
    expect(screen.getByText(/结果摘要与用量在上面那条子任务占位条里/)).toBeInTheDocument();
  });

  it('内容读失败 ⇒ Alert；给了 retryNode 才渲染重试按钮', () => {
    const node = sessionNode({ id: 'main', content: { status: 'error', error: new Error('读盘失败') } });

    const { rerender } = render(<AgentLogLayout model={modelOf(node)} actions={[]} />);
    expect(screen.getByText('节点内容读取失败')).toBeInTheDocument();
    // 不给 `retryNode`：Alert 在，按钮不在（一个点了没反应的按钮比没有按钮更糟）
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();

    const retryNode = vi.fn();
    rerender(<AgentLogLayout model={modelOf(node)} actions={[]} source={{ retryNode }} />);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retryNode).toHaveBeenCalledWith('main');
  });

  it('过滤在轮次级生效：不含目标块的轮次整轮隐藏，并显示命中数', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    const { container } = render(
      <AgentLogLayout
        model={modelOf(node)}
        actions={[]}
        viewState={viewState({ filters: { onlyTools: true, onlyErrors: false } })}
      />,
    );

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(1);
    expect(screen.queryByText('第一轮：只有正文')).toBeNull();
    expect(screen.getByText('工具调用 × 1')).toBeInTheDocument();
    expect(screen.getByText(/命中 1 \/ 2 轮/)).toBeInTheDocument();
  });

  it('没开过滤时不显示命中数（那是废话），也不隐藏任何一轮', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    const { container } = render(<AgentLogLayout model={modelOf(node)} actions={[]} viewState={viewState()} />);

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(2);
    expect(screen.queryByText(/命中 /)).toBeNull();
  });

  it('timeline 槽传函数时用传入的实现（那一条不渲染「已渲染 N 共 M 轮」）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(
      <AgentLogLayout
        model={modelOf(node)}
        actions={[]}
        timeline={(slot) => (
          <div data-testid="custom-timeline">
            自定义时间轴：{slot.turns.length} 轮 / 分派是{typeof slot.renderBlock}
          </div>
        )}
      />,
    );

    expect(screen.getByTestId('custom-timeline')).toHaveTextContent('自定义时间轴：2 轮 / 分派是function');
    expect(screen.queryByText(/已渲染 /)).toBeNull();
    expect(screen.queryByTestId('virtual-turn-list')).toBeNull();
  });

  it('actions 传了时用传入的、不传时用预设（变异体 (p)）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const onSelect = vi.fn();

    const { rerender } = render(
      <AgentLogLayout model={modelOf(node)} actions={[{ key: 'custom', label: '自定义动作', onSelect }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '自定义动作' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    // 传了 actions 就不再出现预设的那几个动作
    expect(screen.queryByRole('switch', { name: '跟随最新' })).toBeNull();

    rerender(<AgentLogLayout model={modelOf(node)} />);
    expect(screen.getByRole('switch', { name: '跟随最新' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '环境信息' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '自定义动作' })).toBeNull();
  });

  it('environment 未提供时，环境抽屉里显示「未提供」而不是空白', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(
      <AgentLogLayout
        model={modelOf(node)}
        actions={[]}
        environment={undefined}
        viewState={viewState({ environmentOpen: true })}
      />,
    );

    expect(screen.getByTestId('agent-environment-drawer')).toBeInTheDocument();
    expect(screen.getByText('未提供')).toBeInTheDocument();
  });

  /**
   * 「下载日志」在**原文行**、排在「原始输出 N 条」之后。
   *
   * 判据是**DOM 顺序 + 不在工具条那一行**，不是「按钮在不在」：落错行的症状恰恰是
   * 「按钮还在、只是跑到面包屑那一行」，按存在性断言会全绿。顺序用 `compareDocumentPosition`
   * （本仓既有手法）取，不猜 id/类名。动作走**预设**（`actions` 不传 ⇒ `useAgentLogToolbarPreset`），
   * 故这一条同时钉住「preset 的 `placement: 'raw'`」与「layout 按 placement 分两行渲」。
   *
   * ⚠️ **不钉它与「重新读取」的相对顺序**：那一格是原文面板自己的重试按钮，属于面板内部排布，
   * 钉死它会让「把重试挪个位置」这种无关改动假红（守卫的靶子是「下载日志落在哪一行」）。
   */
  it('「下载日志」在原文行、「原始输出 N 条」之后（不在工具条那一行）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(
      <AgentLogLayout
        model={modelOf(node)}
        diagnostics={{
          status: 'ready',
          data: {
            lines: [{ at: AT, source: 'stdout', text: '第一行原文', summary: null }],
            truncatedReason: null,
          },
        }}
        onDownload={vi.fn()}
        source={{ requestDiagnostics: vi.fn() }}
      />,
    );

    const rawEntry = screen.getByTestId('raw-output-open');
    const download = screen.getByRole('button', { name: '下载日志' });

    expect(rawEntry.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向那一条：工具条那一行（面包屑所在行）里**没有**下载日志
    expect(screen.getByTestId('log-node-breadcrumb').parentElement?.textContent ?? '').not.toContain('下载日志');
    // 两条判据一起才说明「它在原文行、且排在原文入口之后」，而不是「它在页面上某处」
    expect(download.closest('[data-testid="log-node-breadcrumb"]')).toBeNull();

    /**
     * **原文行的三个按钮同形**（「重新读取」写成 `type="text"` 时与旁边两个并排像另一类东西）。
     * 判据取 `className` 逐字相同——它同时覆盖
     * 类别（default vs text）、色档与尺寸三件事；只断言「有这个按钮」的话，
     * 把它改回无边框文本按钮会全绿。
     */
    const retry = screen.getByRole('button', { name: '重新读取' });
    expect(retry.className, '「重新读取」又变成了另一类按钮（与原文入口不同形）').toBe(rawEntry.className);
    // 「下载日志」走 vendored Button，原文入口仍是 antd：换栈期间两者外形不同，
    // 这里只钉「它在同一行且是个按钮」，同形那一半等原文面板换栈后再恢复
    expect(download.tagName).toBe('BUTTON');
  });

  /**
   * **节点能力声明要流到环境抽屉**。
   *
   * `LogNode.capability` 必须有界面消费者：装配层把五格算好之后，若没有组件把它渲染出来，
   * 整条声明链在界面上就是死的，三家一律显示「没验证过」。这一条钉的是「抽屉拿到的是**当前节点**的声明」：
   * 换成一份写死的、或永远传主会话的那一份，这里的四句原因就会对不上。
   */
  it('环境抽屉拿到当前节点的能力声明与前提（不是写死的一份）', () => {
    const node = sessionNode({
      id: 'main',
      content: { status: 'ready', data: TWO_TURNS },
      capability: capabilityWithSubagentUnavailable(),
      capabilityNotes: ['多智能体随路由变化'],
    });

    render(
      <AgentLogLayout
        model={modelOf(node)}
        actions={[]}
        viewState={viewState({ environmentOpen: true })}
      />,
    );

    expect(screen.getByTestId('capability-notes')).toBeInTheDocument();
    // 等级 → 原因文案走 `CAPABILITY_TO_MISSING_REASON`：`not-projected-by-vendor` 的唯一那句话
    expect(screen.getByText('厂商有数据、但没投送到我们能读的通道')).toBeInTheDocument();
    expect(screen.getByText('能力随路由/模型变化：多智能体随路由变化')).toBeInTheDocument();
  });

  it('点「环境信息」同时开抽屉并向数据层上报一次', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const requestEnvironment = vi.fn();
    // 用真的内部视图态（不传 viewState）才能验「点按钮 ⇒ 抽屉打开」这条接线
    render(<AgentLogLayout model={modelOf(node)} onDownload={undefined} source={{ requestEnvironment }} />);

    fireEvent.click(screen.getByRole('button', { name: '环境信息' }));

    expect(requestEnvironment).toHaveBeenCalledTimes(1);
    expect(screen.getByText('未提供')).toBeInTheDocument();
  });

  /** 假几何里每行的高度（px）：与 `VirtualList` 的默认估值取同一个数，行高测量不会让总高抖动 */
  const ROW_HEIGHT = 96;
  const VIEWPORT_HEIGHT = 200;

  /**
   * 读者上翻 ⇒ 库判「下方还有内容」⇒ 本仓释放跟随；新内容到达时**不抢视口**；
   * 点「回到最新」⇒ 显式恢复跟随，之后的新内容重新被跟上。
   *
   * 这一条的判据都在**可见行为**上：工具条开关的勾选、`scrollTop` 有没有被改写、
   * 浮出按钮的 `data-active`（库给的可点态）。jsdom 没有布局，几何由 `installScrollGeometry` 假造。
   */
  it('读者上翻后新内容不追、点「回到最新」恢复跟随（库判活边）', async () => {
    const uninstall = installScrollGeometry({ viewportHeight: VIEWPORT_HEIGHT, rowHeight: ROW_HEIGHT });
    try {
      const turns = [
        turn({ round: 1, blocks: [textBlock('t1', '第一轮：只有正文')] }),
        turn({ round: 2, at: AT2, blocks: [toolCall('c2', 'call_2', AT2)] }),
        turn({ round: 3, blocks: [textBlock('t3', '第三轮正文')] }),
      ];
      const modelOfTurns = (data: readonly LogTurn[]): AgentLogModel =>
        modelOf(sessionNode({ id: 'main', content: { status: 'ready', data: [...data] } }));

      const { rerender } = render(<AgentLogLayout model={modelOfTurns(turns)} />);
      const viewport = screen.getByTestId('agent-log-scroll-viewport');
      expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked();

      // 等虚拟化把总高度写到内容区（首帧量不到高度时是退化渲染，第二帧才虚拟化）
      const contentHeight = (): number =>
        Number.parseFloat(
          viewport.querySelector<HTMLElement>('[data-slot="message-scroller-content"]')?.style.height ?? '0',
        );
      await waitFor(() => expect(contentHeight()).toBe(3 * ROW_HEIGHT));

      // 视口落到底：库认为「下方没有内容」，跟随成立
      viewport.scrollTop = 3 * ROW_HEIGHT - VIEWPORT_HEIGHT;
      fireEvent.scroll(viewport);

      // 上翻：滚轮意图（库在这一步释放自己的 following 模式）+ 向上滚动（库据此算「下方还有内容」）
      fireEvent.wheel(viewport, { deltaY: -ROW_HEIGHT });
      viewport.scrollTop = 40;
      fireEvent.scroll(viewport);
      await waitFor(() => expect(screen.getByRole('switch', { name: '跟随最新' })).not.toBeChecked());

      // 新内容到达：不追（`scrollTop` 原地不动），浮出按钮由库标成可点
      const four = [...turns, turn({ round: 4, blocks: [textBlock('t4', '第四轮正文')] })];
      rerender(<AgentLogLayout model={modelOfTurns(four)} />);
      expect(viewport.scrollTop).toBe(40);
      const back = screen.getByTestId('agent-log-back-to-latest');
      expect(back).toHaveAttribute('data-active', 'true');

      // 回到最新：显式恢复跟随，库的 `scrollToEnd` 落到新内容的底
      fireEvent.click(back);
      await waitFor(() => expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked());
      await waitFor(() => expect(viewport.scrollTop).toBe(4 * ROW_HEIGHT - VIEWPORT_HEIGHT));

      // 恢复之后再来的内容重新被跟上
      const five = [...four, turn({ round: 5, blocks: [textBlock('t5', '第五轮正文')] })];
      rerender(<AgentLogLayout model={modelOfTurns(five)} />);
      await waitFor(() => expect(viewport.scrollTop).toBe(5 * ROW_HEIGHT - VIEWPORT_HEIGHT));
    } finally {
      uninstall();
    }
  });

  /**
   * **未读仍是本仓的轮次水位**：`filtered.length - readCountRef.current`。
   *
   * Message Scroller 没有未读数 API——它能替的是「跟随 / 释放 / 回到最新」，
   * 这一条钉住「数字不变」：释放跟随的那一刻水位冻住，之后到几轮就是几轮未读。
   */
  it('未读数仍是轮次水位：不跟随时新到 N 轮 ⇒ 未读 = N（库没有未读 API）', async () => {
    const uninstall = installScrollGeometry({ viewportHeight: VIEWPORT_HEIGHT, rowHeight: ROW_HEIGHT });
    try {
      const turns = [
        turn({ round: 1, blocks: [textBlock('t1', '第一轮：只有正文')] }),
        turn({ round: 2, at: AT2, blocks: [toolCall('c2', 'call_2', AT2)] }),
        turn({ round: 3, blocks: [textBlock('t3', '第三轮正文')] }),
      ];
      const modelOfTurns = (data: readonly LogTurn[]): AgentLogModel =>
        modelOf(sessionNode({ id: 'main', content: { status: 'ready', data: [...data] } }));

      const { rerender } = render(<AgentLogLayout model={modelOfTurns(turns)} />);
      const viewport = screen.getByTestId('agent-log-scroll-viewport');

      // 上翻释放跟随（水位冻在 3）
      viewport.scrollTop = 3 * ROW_HEIGHT - VIEWPORT_HEIGHT;
      fireEvent.scroll(viewport);
      fireEvent.wheel(viewport, { deltaY: -ROW_HEIGHT });
      viewport.scrollTop = 0;
      fireEvent.scroll(viewport);
      await waitFor(() => expect(screen.getByRole('switch', { name: '跟随最新' })).not.toBeChecked());

      // 新到两轮、读者仍不跟随 ⇒ 未读 = 5 - 3 = 2
      const five = [
        ...turns,
        turn({ round: 4, blocks: [textBlock('t4', '第四轮正文')] }),
        turn({ round: 5, blocks: [textBlock('t5', '第五轮正文')] }),
      ];
      rerender(<AgentLogLayout model={modelOfTurns(five)} />);

      const back = screen.getByTestId('agent-log-back-to-latest');
      expect(back).toHaveAttribute('aria-label', '回到最新（2 轮未读）');
      expect(back).toHaveAttribute('title', '回到最新（2 轮未读）');
    } finally {
      uninstall();
    }
  });

  it('「这一类内容没被转发」如实说明：会话文件 + 未结束 ⇒ 等运行结束', () => {
    const node = sessionNode({
      id: 'sub',
      kind: 'subagent',
      source: 'session-file',
      endedAt: null,
      content: { status: 'ready', data: [turn({ blocks: [toolCall('c1', 'call_1')] })] },
    });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByText('运行期只有派发事件与状态，完整轨迹要等运行结束')).toBeInTheDocument();
  });

  it('「这一类内容没被转发」如实说明：能力声明说拿不到 ⇒ 把原因带上', () => {
    const node = sessionNode({
      id: 'sub',
      kind: 'subagent',
      source: 'wire',
      endedAt: AT2,
      capability: capabilityWithSubagentUnavailable(),
      content: { status: 'ready', data: [turn({ blocks: [toolCall('c1', 'call_1')] })] },
    });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByText(/子任务轨迹不可用 · 厂商有数据、但没投送到我们能读的通道/)).toBeInTheDocument();
  });

  it('「这一类内容没被转发」如实说明：其余情况不写「它什么都没说」', () => {
    const node = sessionNode({
      id: 'sub',
      kind: 'subagent',
      source: 'wire',
      endedAt: AT2,
      content: { status: 'ready', data: [turn({ blocks: [toolCall('c1', 'call_1')] })] },
    });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByText('该子任务的对话未转发（只投送了工具调用）')).toBeInTheDocument();
  });

  it('notice / liveError：固定区各一个 Alert；不传就一个空位都不留', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    const { rerender } = render(<AgentLogLayout model={modelOf(node)} actions={[]} />);
    expect(screen.queryByTestId('agent-log-notice')).toBeNull();
    expect(screen.queryByTestId('agent-log-live-error')).toBeNull();

    rerender(
      <AgentLogLayout
        model={modelOf(node)}
        actions={[]}
        notice="日志可能不完整：只保留了最近 500 条"
        liveError="实时通道已断"
      />,
    );

    expect(screen.getByTestId('agent-log-notice')).toHaveTextContent('日志可能不完整：只保留了最近 500 条');
    expect(screen.getByTestId('agent-log-live-error')).toHaveTextContent('实时通道已断');
    // 两者在固定区**最上面**：排在事实条之前
    const notice = screen.getByTestId('agent-log-notice');
    expect(notice.compareDocumentPosition(screen.getByTestId('agent-log-facts-bar')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * `connected`：只在传了时渲染那一格；断线时不能用 `processing` 的动效。
   *
   * 这一条同时钉「**传了连接状态就必须有一行承载它**」：本用例的 `actions={[]}` 且没有 `diagnostics`
   * ⇒ 原文行按「有没有原文 / 有没有挂在那一行的动作」判本来是不渲的，而连接状态住那一行
   * （与「原始输出 N 条」合并成一行省空间），故它现在是那一行的第三个理由。
   */
  it('connected：只在传了时渲染那一格；断线时不能用 processing 的动效', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    // 事实条本身也在用 `Badge status`：这里把它按终态给，免得它的 processing 干扰断言
    const settled = modelOf(node, { facts: { ...FACTS, status: { tone: 'ok', label: '已评分' } } });

    const { rerender } = render(<AgentLogLayout model={settled} actions={[]} />);
    expect(screen.queryByText('实时连接中')).toBeNull();
    expect(screen.queryByText('未连接')).toBeNull();

    rerender(<AgentLogLayout model={settled} actions={[]} connected />);
    expect(screen.getByText('实时连接中')).toBeInTheDocument();
    expect(document.querySelector('[data-testid="agent-log-connection"][data-status="processing"]')).not.toBeNull();

    rerender(<AgentLogLayout model={settled} actions={[]} connected={false} />);
    expect(screen.getByText('未连接')).toBeInTheDocument();
    //：`processing` 的动效是「真的在流」的信号，断线时必须是中性档
    expect(document.querySelector('[data-testid="agent-log-connection"][data-status="processing"]')).toBeNull();
  });

  /**
   * 连接状态的位置：与「原始输出 N 条」**同一行**，且是那一行的**最左**。
   *
   * 只断言文案在页面上是不够的——挪回事实条那一行它照样在。故两条判据一起给：
   * 同属一个容器 + 排在原文入口之前，再加一条反向判据「不在事实条里」。
   */
  it('连接徽标与「原始输出 N 条」同行，且排在它前面（最左）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(
      <AgentLogLayout
        model={modelOf(node)}
        diagnostics={{
          status: 'ready',
          data: {
            lines: [{ at: AT, source: 'stdout', text: '第一行原文', summary: null }],
            truncatedReason: null,
          },
        }}
        connected
        // 「下载日志」是预设里挂在原文行的动作（`visible: onDownload !== undefined`）：
        // 不给它，那一行上就没有第二个兄弟，也就验证不了「同一行」
        onDownload={vi.fn()}
        source={{ requestDiagnostics: vi.fn() }}
      />,
    );

    const badge = screen.getByTestId('agent-log-connection');
    const rawEntry = screen.getByTestId('raw-output-open');

    // 同一行**且同一层**：入口按钮就是那一行的直接子节点——把包裹那一层
    // 包裹去掉、按钮拿出来（`raw-output-panel.tsx` 口径 7），故这里判的是**同一父节点**；
    // 把包裹加回去时 `rawEntry.parentElement` 变成内层那个 flex，这条立刻红
    expect(badge.parentElement, '连接徽标与「原始输出 N 条」不在同一层').toBe(rawEntry.parentElement);
    expect(rawEntry.parentElement?.contains(screen.getByRole('button', { name: '下载日志' }))).toBe(true);
    // 最左：徽标排在原文入口之前
    expect(badge.compareDocumentPosition(rawEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向判据：它**不在**事实条那一行里（挪回去时这条红）
    expect(badge.closest('[data-testid="agent-log-facts-bar"]')).toBeNull();
  });

  /**
   * **领域事实自占一行**：它是固定区里与事实条**并列的第二个 flex 行**，
   * 排在事实条那一行**下面**——不是并进事实条、靠 `wrap` 自然折行的尾巴。
   *
   * 为什么值得钉：并回事实条时页面上照样看得见「智能体 … 评分」，只有**父子关系**能区分「两行」
   * 与「一行里被折行的尾巴」；而这两组信息（谁在跑 / 改了多少、得了多少分）要连起来读。
   */
  it('领域事实自占一行：与事实条同层、排在它后面，且不在事实条里面', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const domain: AgentLogFacts['domain'] = [
      {
        id: 'agent',
        label: '智能体',
        value: 'Claude Code',
        segments: [{ text: 'Claude Code', tag: true, tagTone: 'blue' }],
      },
      {
        id: 'diff',
        label: '改动',
        value: '1 个文件 +2 −1',
        segments: [{ text: '1 个文件 ' }, { text: '+2', tone: 'insertion' }, { text: ' −1', tone: 'deletion' }],
      },
      { id: 'score', label: '评分', value: '8/10', tone: 'success' },
    ];

    render(<AgentLogLayout model={modelOf(node, { facts: { ...FACTS, domain } })} actions={[]} />);

    const bar = screen.getByTestId('agent-log-facts-bar');
    const domainRow = screen.getByTestId('agent-log-domain-facts');
    const fixedArea = domainRow.parentElement;

    /**
     * 判据是**父容器是纵向 Flex**，不只是「同一个父节点」：把这两行再包进一个横向 `Flex` 时     * 它们的父节点仍然相同、顺序也仍然在，页面上却已经并回一行（靠 `wrap` 折行）——那正是要去掉的形态。`Flex vertical` 在本仓走 CSS 类（不在内联 style 里），故取类名。
     */
    expect(bar.parentElement, '领域事实行与事实条不在同一层').toBe(fixedArea);
    expect(fixedArea?.className, '两行被并回了同一行（父容器不是纵向 flex）').toContain('flex-col');
    // 顺序：领域事实排在事实条之后（它是第二行）
    expect(bar.compareDocumentPosition(domainRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向判据：它**不在**事实条里面（塞进事实条组件内部时这条红）
    expect(bar.contains(domainRow)).toBe(false);
    // 格名与值照画：顺序是数据层的，界面不重排
    expect(domainRow).toHaveTextContent('智能体');
    expect(domainRow).toHaveTextContent('评分');
  });

  it('领域事实为空时那一行不出现（不留一段空 gap）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByTestId('agent-log-facts-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-log-domain-facts')).toBeNull();
  });
});

/**
 * **浮动件与底部槽的几何关系**（静态判据，真机读数在冒烟里）。
 *
 * 浮动件（「回到最新」）必须以**滚动区**为定位基准，不能挂在根节点上：挂在根节点时它的
 * `position: absolute` 量的是整个布局，量到的「距底 `paddingMD`」会正好落在底部槽里 ——
 * 压住输入区的发送键，表现是**那颗键点不动**（`elementFromPoint` 命中的是浮出按钮）。
 *
 * 住在滚动区里就没有这个错位：滚动区的高度已经扣掉了底部槽（flex 的既有行为），所以有没有
 * footer 都不必算高度差。jsdom 没有布局（`getBoundingClientRect` 恒 0）⇒ 这里只能钉住那一处
 * **结构**：滚动区带 `position: relative`、且浮动件出现在它内部。
 */
describe('浮动件住在滚动区里（不压底部槽的输入区）', () => {
  it('滚动视口是定位基准，浮出按钮在它之后、底部槽之前', () => {
    const scroller = readFileSync(join(import.meta.dirname, 'log-scroller.tsx'), 'utf8');
    // Root 带 `relative`：浮出按钮的 `position: absolute` 量的是它
    const rootAt = scroller.indexOf('MessageScroller className="relative');
    const viewportAt = scroller.indexOf('<MessageScrollerViewport');
    const backAt = scroller.indexOf('{backToLatest}');
    const rootEnd = scroller.indexOf('</MessageScroller>');
    expect(rootAt).toBeGreaterThan(-1);
    expect(viewportAt).toBeGreaterThan(rootAt);
    expect(backAt).toBeGreaterThan(viewportAt);
    expect(rootEnd).toBeGreaterThan(backAt);

    // 底部槽排在滚动区之后：滚动区按它的实际高度自动缩水（flex 的既有行为，不算高度差）
    const layout = readFileSync(join(import.meta.dirname, 'agent-log-layout.tsx'), 'utf8');
    const scrollAt = layout.indexOf('<LogScroller');
    const footerAt = layout.indexOf('data-testid="agent-log-footer"');
    expect(scrollAt).toBeGreaterThan(-1);
    expect(footerAt).toBeGreaterThan(scrollAt);
  });
});

/**
 * 连接状态的第二层语义：**终态行没有实时流是正常的**。
 *
 * 同一个「未连接」在终态行上会被读成故障（跑完了却像是通道挂了）。`settled` 把它改成「已结束」，
 * 状态点也从 processing 档退到中性档——两处都钉住，避免只改文案、点还在呼吸。
 */
describe('连接状态：终态行不说「未连接」', () => {
  it('settled 时文案是「已结束」，状态点不是 processing', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const model = modelOf(node, { facts: { ...FACTS, status: { tone: 'ok', label: '已评分' } } });

    render(<AgentLogLayout model={model} actions={[]} connected={false} settled />);

    expect(screen.getByText('已结束')).toBeInTheDocument();
    expect(screen.queryByText('未连接')).toBeNull();
    expect(document.querySelector('[data-testid="agent-log-connection"][data-status="settled"]')).not.toBeNull();
  });
});
