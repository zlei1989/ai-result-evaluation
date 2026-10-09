/**
 * `AgentLogLayout`（L2）的守卫。七条：
 *   1. 节点内容四态：`empty` ⇒ 空态、「未到」⇒ `Skeleton`（**不是**空态）、读失败 ⇒ `Alert`（+ 有重试回调才给按钮）；
 *   2. 过滤在**轮次级**生效：不含目标块的轮次整轮隐藏，并给出 `命中 N / M 轮`；
 *   3. `timeline` 槽传函数时用传入的实现（S1/S5 的接缝）；
 *   4. **`actions` 传了用传入的、不传用预设**（变异体 (p) 的守卫）；
 *   5. `environment` 未提供时环境抽屉里显示「未提供」，而不是空白；
 *   6. 跟随最新**只有一份 state**：工具条开关与角落浮出按钮同步；
 *   7. 「这一类内容没被转发」如实说明（三条判据各一句）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

const AT = '2026-10-02T10:44:31.000Z';
const AT2 = '2026-10-02T10:44:41.000Z';

// 布局里的 `Listy` 与展开的工具行都会 new `ResizeObserver`（jsdom 没有）
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
    usage: null,
    callId,
    name: 'pwsh',
    nameMissing: null,
    family: 'run-shell',
    input: { value: null, text: null, bytes: null },
    tool: null,
  };
}

function turn(overrides: Partial<LogTurn> & { blocks: ContentBlock[] }): LogTurn {
  return { round: 1, at: AT, subagentId: null, tokens: null, durationMs: null, running: false, ...overrides };
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
};

function modelOf(node: LogNode, overrides: Partial<AgentLogModel> = {}): AgentLogModel {
  return {
    specVersion: 1,
    facts: FACTS,
    nodes: [node],
    activeNodeId: node.id,
    rowEvents: [],
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

    expect(container.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByText('还没有日志')).toBeNull();
  });

  /**
   * **站在子任务节点上的空态**（2026-10-03 真机修正）。
   *
   * 这一档原先落到模型级空态，显示「还没有日志 · **这一行还没开始执行**，或执行尚未产生输出」
   * ——而那一行明明跑完了（真机：主会话 7 轮、子任务记录齐备、`outcome` 非空）。
   * 站在子任务上的读者会把那句话读成「界面坏了」。
   */
  it('子任务节点且没有内容 ⇒ 说的是这个子任务，不是「这一行还没开始执行」', () => {
    const node = sessionNode({
      id: 'sub-1',
      kind: 'subagent',
      parentId: 'main',
      name: '整理变更清单',
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
   * **「结果未采集」要说出为什么**（2026-10-04 收口）。
   *
   * `AgentRunStateTag` 的 `missingReason` 这一格在设计里就写着「（`capability` 给…）」，
   * 但 `BlockRenderContext` 里没有 `capability` ⇒ 三个调用点**全部**硬写 `null`
   * （`tool-group-panel` ×2、`task-panel-card` ×1）。于是它恒等于那句光秃秃的
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
   * 「下载台账」在**原文行**、排在「原始输出 N 条」之后（用户 2026-10-03 口径）。
   *
   * 判据是**DOM 顺序 + 不在工具条那一行**，不是「按钮在不在」：落错行的症状恰恰是
   * 「按钮还在、只是跑到面包屑那一行」，按存在性断言会全绿。顺序用 `compareDocumentPosition`
   * （本仓既有手法）取，不猜 id/类名。动作走**预设**（`actions` 不传 ⇒ `useAgentLogToolbarPreset`），
   * 故这一条同时钉住「preset 的 `placement: 'raw'`」与「layout 按 placement 分两行渲」。
   *
   * ⚠️ **不钉它与「重新读取」的相对顺序**：那一格是原文面板自己的重试按钮，属于面板内部排布，
   * 钉死它会让「把重试挪个位置」这种无关改动假红（守卫的靶子是「下载台账落在哪一行」）。
   */
  it('「下载台账」在原文行、「原始输出 N 条」之后（不在工具条那一行）', () => {
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
    const download = screen.getByRole('button', { name: '下载台账' });

    expect(rawEntry.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向那一条：工具条那一行（面包屑所在行）里**没有**下载台账
    expect(screen.getByTestId('log-node-breadcrumb').parentElement?.textContent ?? '').not.toContain('下载台账');
    // 两条判据一起才说明「它在原文行、且排在原文入口之后」，而不是「它在页面上某处」
    expect(download.closest('[data-testid="log-node-breadcrumb"]')).toBeNull();

    /**
     * **原文行的三个按钮同形**（用户 2026-10-03 口径：「重新读取」原先写成 `type="text"`，
     * 与旁边两个并排时像另一类东西）。判据取 `className` 逐字相同——它同时覆盖
     * 类别（default vs text）、色档与尺寸三件事；只断言「有这个按钮」的话，
     * 把它改回无边框文本按钮会全绿。
     */
    const retry = screen.getByRole('button', { name: '重新读取' });
    expect(retry.className, '「重新读取」又变成了另一类按钮（与旁边两个不同形）').toBe(rawEntry.className);
    expect(download.className, '「下载台账」与原文入口不同形').toBe(rawEntry.className);
  });

  /**
   * **节点能力声明要流到环境抽屉**（2026-10-04 收口）。
   *
   * `LogNode.capability` 此前没有任何界面消费者：装配层把五格算好了、`AgentLogLayout` 只拿它
   * 判「这一类没被转发」，而那个专门渲染能力声明的组件**谁也够不到**——整条声明链在界面上是死的，
   * 三家一律显示「没验证过」。这一条钉的是「抽屉拿到的是**当前节点**的声明」：
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

  it('跟随最新只有一份 state：上翻关掉、角落按钮点回来', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    // 不传 `actions`：这一条要验的正是「预设里的开关与角落浮出按钮是同一份 state」
    const { container } = render(<AgentLogLayout model={modelOf(node)} />);
    expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked();

    const holder = container.querySelector<HTMLElement>('.ant-listy-holder');
    expect(holder).not.toBeNull();
    if (holder === null) return;
    // 第一次滚动只记基线（容器刚认出来）；第二次是**向上**滚 ⇒ 自动关闭跟随
    holder.scrollTop = 120;
    fireEvent.scroll(holder);
    holder.scrollTop = 20;
    fireEvent.scroll(holder);

    expect(screen.getByRole('switch', { name: '跟随最新' })).not.toBeChecked();
    const backButton = screen.getByRole('button', { name: /回到最新/ });
    expect(backButton).toHaveTextContent('回到最新（0 轮未读）');

    // 同一个 `follow`：点浮出按钮就把开关也打开
    fireEvent.click(backButton);
    expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /回到最新/ })).toBeNull();
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
   * `connected`：只在传了时渲染那一格；断线时不能用 `processing` 的动效（§6.7）。
   *
   * 这一条同时钉「**传了连接状态就必须有一行承载它**」：本用例的 `actions={[]}` 且没有 `diagnostics`
   * ⇒ 原文行按「有没有原文 / 有没有挂在那一行的动作」判本来是不渲的，而连接状态住那一行
   * （用户 2026-10-07 口径：与「原始输出 N 条」合并成一行省空间），故它现在是那一行的第三个理由。
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
    expect(document.querySelector('.ant-badge-status-processing')).not.toBeNull();

    rerender(<AgentLogLayout model={settled} actions={[]} connected={false} />);
    expect(screen.getByText('未连接')).toBeInTheDocument();
    // §6.7：`processing` 的动效是「真的在流」的信号，断线时必须是中性档
    expect(document.querySelector('.ant-badge-status-processing')).toBeNull();
  });

  /**
   * 连接状态的位置（用户 2026-10-07 口径）：与「原始输出 N 条」**同一行**，且是那一行的**最左**。
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
        // 「下载台账」是预设里挂在原文行的动作（`visible: onDownload !== undefined`）：
        // 不给它，那一行上就没有第二个兄弟，也就验证不了「同一行」
        onDownload={vi.fn()}
        source={{ requestDiagnostics: vi.fn() }}
      />,
    );

    const badge = screen.getByTestId('agent-log-connection');
    const rawEntry = screen.getByTestId('raw-output-open');

    // 同一行**且同一层**：入口按钮就是那一行的直接子节点——用户 2026-10-07 口径要求把原先那层
    // 包裹去掉、按钮拿出来（`raw-output-panel.tsx` 口径 7），故这里判的是**同一父节点**；
    // 把包裹加回去时 `rawEntry.parentElement` 变成内层那个 flex，这条立刻红
    expect(badge.parentElement, '连接徽标与「原始输出 N 条」不在同一层').toBe(rawEntry.parentElement);
    expect(rawEntry.parentElement?.contains(screen.getByRole('button', { name: '下载台账' }))).toBe(true);
    // 最左：徽标排在原文入口之前
    expect(badge.compareDocumentPosition(rawEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向判据：它**不在**事实条那一行里（挪回去时这条红）
    expect(badge.closest('[data-testid="agent-log-facts-bar"]')).toBeNull();
  });

  /**
   * **领域事实自占一行**（用户 2026-10-07 口径）：它是固定区里与事实条**并列的第二个 flex 行**，
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
     * 判据是**父容器是纵向 Flex**，不只是「同一个父节点」：把这两行再包进一个横向 `Flex` 时
     * 它们的父节点仍然相同、顺序也仍然在，页面上却已经并回一行（靠 `wrap` 折行）——那正是用户
     * 2026-10-07 要去掉的形态。`Flex vertical` 在本仓走 CSS 类（不在内联 style 里），故取类名。
     */
    expect(bar.parentElement, '领域事实行与事实条不在同一层').toBe(fixedArea);
    expect(fixedArea?.className, '两行被并回了同一行（父容器不是纵向 Flex）').toContain('ant-flex-vertical');
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
