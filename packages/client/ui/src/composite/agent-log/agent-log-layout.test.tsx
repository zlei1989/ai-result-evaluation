/**
 * `AgentLogLayout`（L2）的守卫。七条：
 * 1. 节点内容四态：`empty` ⇒ 空态、「未到」⇒ `Skeleton`（**不是**空态）、读失败 ⇒ `Alert`（+ 有重试回调才给按钮）；
 * 2. 过滤在**步级**生效：不含目标块的步整步隐藏，并给出 `命中 N / M 步`；
 * 3. `timeline` 槽传函数时用传入的实现（S1/S5 的接缝）；
 * 4. **`actions` 传了用传入的、不传用预设**（变异体 (p) 的守卫）；
 * 5. `environment` 未提供时环境抽屉里显示「未提供」，而不是空白；
 * 6. 跟随最新**只有一份 state**：工具条开关与角落浮出按钮同步；内容变矮 / 视口变高
 *    把 `scrollTop` 钳回上限时**不算上翻**（自动收起的折叠面板不许关掉跟随）；
 * 7. 「这一类内容没被转发」如实说明（三条判据各一句）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// 布局里的 `Listy` 与展开的工具候选都会 new `ResizeObserver`（jsdom 没有）
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

/** 候选级事实的默认值（连接状态那一条用例要把它改成终态，否则事实条的 processing 会干扰断言） */
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
    candidateEvents: [],
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
  /**
   * **界面术语**：一次模型调用叫「一步」（`第 N 步` / `步数 N`），不叫「轮次」。
   * 轮只指用户每发送一次提示词。这一条同时钉住时间轴与事实条两个出口：
   * 只改一处（例如把时间轴改回「轮次」）就会在这里见红。
   */
  it('模型调用一律叫「步」：时间轴与事实条都不出现「轮次」', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(
      <AgentLogLayout
        model={modelOf(node, { facts: { ...FACTS, turns: { current: 2, total: null } } })}
        actions={[]}
      />,
    );

    expect(screen.getByText('第 1 步')).toBeInTheDocument();
    expect(screen.getByText('第 2 步')).toBeInTheDocument();
    expect(screen.getByText('步数 2')).toBeInTheDocument();
    expect(screen.queryByText(/轮次/), '界面上又出现了「轮次」这个说法').toBeNull();
  });

  it('empty 为真 ⇒ 空态（「还没有日志」），而不是空时间轴', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: [] } });

    render(<AgentLogLayout model={modelOf(node, { empty: true })} actions={[]} />);

    expect(screen.getByText('还没有日志')).toBeInTheDocument();
    expect(screen.getByText('这个候选还没开始执行，或执行尚未产生输出')).toBeInTheDocument();
    expect(screen.queryByTestId('virtual-turn-list')).toBeNull();
  });

  it('内容未到 ⇒ Skeleton（不是空态文案）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'loading' } });

    const { container } = render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(container.querySelector('.ant-skeleton')).not.toBeNull();
    expect(screen.queryByText('还没有日志')).toBeNull();
  });

  /**
   * **站在子任务节点上的空态**。
   *
   * 这一档若落到模型级空态，会显示「还没有日志 · **这个候选还没开始执行**，或执行尚未产生输出」
   * ——而那一行明明跑完了（真机：主会话 7 轮、子任务记录齐备、`outcome` 非空）。
   * 站在子任务上的读者会把那句话读成「界面坏了」。
   */
  it('子任务节点且没有内容 ⇒ 说的是这个子任务，不是「这个候选还没开始执行」', () => {
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
      screen.queryByText('这个候选还没开始执行，或执行尚未产生输出'),
      '子任务节点上出现了候选级文案（会被读成「界面坏了」）',
    ).toBeNull();
  });

  /**
   * **还在跑的子任务节点**：正文只是还没到，不是「没有」。
   *
   * 派发那一刻就有一条子任务行（卡片与入口当场可点），而这一家的每一步正文可能要到收尾才交出来
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

  it('过滤在步级生效：不含目标块的步整步隐藏，并显示命中数', () => {
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
    expect(screen.getByText(/命中 1 \/ 2 步/)).toBeInTheDocument();
  });

  /**
   * 过滤到一步不剩 ⇒ **antd 空态**（`Empty`），不是一行灰字。
   * 这是「过滤的结果」而不是「还没有日志」，两者的画面要有区别：灰字夹在事实条底下
   * 会被当成一句提示语扫过去，空态图才让人看出「这里本来有内容、被筛掉了」。
   */
  it('过滤到一步不剩时用空态（`.ant-empty`）说明，不是一行灰字', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    const { container } = render(
      <AgentLogLayout
        model={modelOf(node)}
        actions={[]}
        viewState={viewState({ filters: { onlyTools: true, onlyErrors: true } })}
      />,
    );

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(0);
    expect(screen.getByText('没有命中过滤的步骤').closest('.ant-empty')).not.toBeNull();
  });

  it('没开过滤时不显示命中数（那是废话），也不隐藏任何一轮', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    const { container } = render(<AgentLogLayout model={modelOf(node)} actions={[]} viewState={viewState()} />);

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(2);
    expect(screen.queryByText(/命中 /)).toBeNull();
  });

  it('timeline 槽传函数时用传入的实现（那一条不挂默认的虚拟列表）', () => {
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
   * 工具条那一候选的**尾部顺序**：「环境信息」→「原始输出」入口→「下载台账」。
   *
   * 判据是「哪一个候选里有它 + 同排谁在前」：落错行或顺序反了的症状都是「按钮还在、位置不对」，
   * 按存在性断言会全绿。顺序用 `compareDocumentPosition`（本仓既有手法）取，不猜 id/类名。
   * 动作走**预设**（`actions` 不传 ⇒ `useAgentLogToolbarPreset`），故这一条同时钉住预设里的
   * 数组顺序（`environment` 之后是 `raw`、再是 `download`）与原文入口按那一格次序渲染。
   */
  it('「原始输出」入口排在「环境信息」之后、「下载台账」之前', () => {
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
    const environment = screen.getByRole('button', { name: '环境信息' });

    const toolbarCandidate = screen.getByTestId('log-node-breadcrumb').parentElement;
    expect(toolbarCandidate?.contains(download), '「下载台账」不在工具条那一行').toBe(true);
    expect(toolbarCandidate?.contains(environment)).toBe(true);
    expect(environment.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向判据：它不在面包屑自身里（挂在面包屑节点里同样「在同一行」）
    expect(download.closest('[data-testid="log-node-breadcrumb"]')).toBeNull();
    // 「环境信息」也是圆形透明底，图标换成 BugFilled（`anticon-bug`）
    expect(environment.className).toContain('ant-btn-circle');
    expect(environment.className).toContain('ant-btn-variant-text');
    expect(environment.querySelector('.anticon-bug')).not.toBeNull();
    // 原文入口也住这个候选，且排在「环境信息」之后、「下载台账」之前
    expect(toolbarCandidate?.contains(rawEntry), '「原始输出」入口不在工具条那一行').toBe(true);
    expect(environment.compareDocumentPosition(rawEntry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rawEntry.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    /**
     * 尾部这几颗是**同一簇次级动作**（`iconGroup`）：合进一个渲染区、组内 4px；
     * 工具条整体仍是 12px——开关与数值框不跟着收紧。
     * jsdom 没有布局，判据只能读 inline style（`Flex` 的 gap 是内联的）。
     */
    const iconGroup = screen.getByTestId('agent-log-toolbar-icon-group');
    expect((iconGroup as HTMLElement).style.gap).toBe('4px');
    expect((toolbarCandidate as HTMLElement | null)?.style.gap).toBe('12px');
    expect((environment.parentElement as HTMLElement | null)?.style.gap).toBe('4px');
    // 三颗都在簇里；开关不在
    for (const button of [environment, download, rawEntry]) expect(iconGroup.contains(button)).toBe(true);
    expect(iconGroup.contains(screen.getByLabelText('跟随最新'))).toBe(false);

    /**
     * 「下载台账」是**圆形、透明底**的纯图标按钮：内容只有一枚下载图标，文案走 `aria-label` 与 Tooltip。
     * 判据三件一起看：text 形态（透明底）、circle（圆形）、无可见文字 + 图标是 download；
     * 退回带边框方按钮或改回文字按钮都会红。
     */
    expect(download.className).toContain('ant-btn-variant-text');
    expect(download.className).toContain('ant-btn-circle');
    expect(download.textContent).toBe('');
    expect(download.querySelector('.anticon-download')).not.toBeNull();
    expect(download.getAttribute('aria-label')).toBe('下载台账');
  });

  /**
   * 「追问」是这一簇里的**第一个**入口：图标是 `MessageFilled`，可访问名与 Tooltip 都是「追问」。
   * 它与「环境信息」「下载台账」同属圆形透明底——退回带边框方按钮会与那一簇断开。
   */
  it('追问图标按钮：MessageFilled + aria-label「追问」，住在图标簇里', () => {
    const onFollowUp = vi.fn();
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(<AgentLogLayout model={modelOf(node)} onFollowUp={onFollowUp} followUpVerdict={{ ok: true }} />);

    const button = screen.getByRole('button', { name: '追问' });
    expect(button.querySelector('.anticon-message')).not.toBeNull();
    expect(button.className).toContain('ant-btn-variant-text');
    expect(button.className).toContain('ant-btn-circle');
    expect(button.textContent).toBe('');
    expect(button).toBeEnabled();
    // 与「环境信息」「下载台账」同一簇：组内 4px，不是散在工具条上
    const iconGroup = screen.getByTestId('agent-log-toolbar-icon-group');
    expect(iconGroup.contains(button)).toBe(true);
    expect(button.parentElement?.parentElement).toBe(iconGroup);

    fireEvent.click(button);
    expect(onFollowUp).toHaveBeenCalledTimes(1);
  });

  /**
   * 不可追问时按钮**禁用而不是消失**：它答的是「这个候选现在不能接着跑」，删掉按钮会让人以为
   * 这个入口不存在；Tooltip 那句原因由调用方从服务端读侧带下来。
   */
  it('追问图标按钮：判据说不可行时禁用', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(
      <AgentLogLayout
        model={modelOf(node)}
        onFollowUp={vi.fn()}
        followUpVerdict={{ ok: false, reason: '这个候选的工作区已被删除' }}
      />,
    );

    expect(screen.getByRole('button', { name: '追问' })).toBeDisabled();
  });

  /** 没有写动作就不渲染那颗按钮（同「下载台账」：点不动的按钮比没有按钮更糟） */
  it('没给 onFollowUp ⇒ 追问按钮不渲染', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(<AgentLogLayout model={modelOf(node)} />);

    expect(screen.queryByRole('button', { name: '追问' })).toBeNull();
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
    // 前提逐条落进「能力前提」那一段（每句整行，不是拼成一句话）
    expect(screen.getByText('能力前提（随路由 / 模型 / 开关变化）')).toBeInTheDocument();
    expect(screen.getByText('多智能体随路由变化')).toBeInTheDocument();
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
    // 未读数从**文案**变成 **`badge`**：按钮的可视内容只剩一个图标，
    // 所以「回到最新（N 步未读）」这句只能由 `aria-label` 承载（否则读屏只剩一个无名按钮）
    expect(backButton).toHaveAttribute('aria-label', '回到最新（0 步未读）');
    expect(container.querySelector('.ant-float-btn')).not.toBeNull();

    // 同一个 `follow`：点浮出按钮就把开关也打开
    fireEvent.click(backButton);
    expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /回到最新/ })).toBeNull();
  });

  /**
   * 自动收起不是用户动作。
   *
   * 运行中的工具组默认展开，运行结束时默认展开键消失 ⇒ 面板自动收起、内容变矮；
   * 浏览器把 `scrollTop` 钳到新的上限并补发 scroll 事件。把那一串「scrollTop 变小」
   * 当上翻处理，就会在每次跑完时静默关掉跟随（开关变灰、后续内容不再滚到底）。
   */
  it('内容变矮引起的 scrollTop 回退不算上翻：跟随保持开启', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const { container } = render(<AgentLogLayout model={modelOf(node)} />);

    const holder = container.querySelector<HTMLElement>('.ant-listy-holder');
    expect(holder).not.toBeNull();
    if (holder === null) return;

    // jsdom 不量布局：按真机语义注入两个高度，让「内容变矮 / 贴底」这两条判据有靶子
    let contentHeight = 1600;
    const viewportHeight = 700;
    Object.defineProperty(holder, 'scrollHeight', { configurable: true, get: () => contentHeight });
    Object.defineProperty(holder, 'clientHeight', { configurable: true, get: () => viewportHeight });

    // 基线（离底，故下面那一次只可能由「内容变矮」解释）
    holder.scrollTop = 800;
    fireEvent.scroll(holder);

    // 自动收起一个面板 ⇒ 内容矮 300px，位置随之上移；此时离底还有一段
    contentHeight = 1300;
    holder.scrollTop = 500;
    fireEvent.scroll(holder);

    expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /回到最新/ })).toBeNull();
  });

  it('视口变高把 scrollTop 钳回上限时不算上翻（仍在底部）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const { container } = render(<AgentLogLayout model={modelOf(node)} />);

    const holder = container.querySelector<HTMLElement>('.ant-listy-holder');
    expect(holder).not.toBeNull();
    if (holder === null) return;

    // 内容高度不变，只有视口变高（抽屉变高 / 窗口 resize）：scrollTop 被钳回新的上限
    let viewportHeight = 700;
    Object.defineProperty(holder, 'scrollHeight', { configurable: true, get: () => 1600 });
    Object.defineProperty(holder, 'clientHeight', { configurable: true, get: () => viewportHeight });

    holder.scrollTop = 900;
    fireEvent.scroll(holder);

    viewportHeight = 1000;
    holder.scrollTop = 600;
    fireEvent.scroll(holder);

    expect(screen.getByRole('switch', { name: '跟随最新' })).toBeChecked();
  });

  it('真机上翻（离底）仍然关掉跟随：贴底判据不吞用户动作', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    const { container } = render(<AgentLogLayout model={modelOf(node)} />);

    const holder = container.querySelector<HTMLElement>('.ant-listy-holder');
    expect(holder).not.toBeNull();
    if (holder === null) return;

    Object.defineProperty(holder, 'scrollHeight', { configurable: true, get: () => 1600 });
    Object.defineProperty(holder, 'clientHeight', { configurable: true, get: () => 700 });

    // 基线：滚到底
    holder.scrollTop = 900;
    fireEvent.scroll(holder);

    // 内容高度不变、scrollTop 变小且已离开底部 ⇒ 这是用户上翻
    holder.scrollTop = 300;
    fireEvent.scroll(holder);

    expect(screen.getByRole('switch', { name: '跟随最新' })).not.toBeChecked();
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
   * **领域事实自占一行**：它是固定区里与事实条**并列的第二个 flex 行**，
   * 排在事实条那一行**下面**——不是并进事实条、靠 `wrap` 自然折候选的尾巴。
   *
   * 为什么值得钉：并回事实条时页面上照样看得见「智能体 … 评分」，只有**父子关系**能区分「两行」
   * 与「一个候选里被折候选的尾巴」；而这两组信息（谁在跑 / 改了多少、得了多少分）要连起来读。
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
    const domainCandidate = screen.getByTestId('agent-log-domain-facts');
    const fixedArea = domainCandidate.parentElement;

    /**
     * 判据是**父容器是纵向 Flex**，不只是「同一个父节点」：把这两行再包进一个横向 `Flex` 时     * 它们的父节点仍然相同、顺序也仍然在，页面上却已经并回一行（靠 `wrap` 折行）——那正是要去掉的形态。`Flex vertical` 在本仓走 CSS 类（不在内联 style 里），故取类名。
     */
    expect(bar.parentElement, '领域事实行与事实条不在同一层').toBe(fixedArea);
    expect(fixedArea?.className, '两个候选被并回了同一行（父容器不是纵向 Flex）').toContain('ant-flex-vertical');
    // 顺序：领域事实排在事实条之后（它是第二行）
    expect(bar.compareDocumentPosition(domainCandidate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向判据：它**不在**事实条里面（塞进事实条组件内部时这条红）
    expect(bar.contains(domainCandidate)).toBe(false);
    // 格名与值照画：顺序是数据层的，界面不重排
    expect(domainCandidate).toHaveTextContent('智能体');
    expect(domainCandidate).toHaveTextContent('评分');
  });

  it('领域事实为空时那一行不出现（不留一段空 gap）', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });

    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByTestId('agent-log-facts-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-log-domain-facts')).toBeNull();
  });
});

/**
 * **根节点裁掉亚像素溢出**：抽屉 body 不许出现第二根滚动条（真机读数在冒烟里）。
 *
 * 固定区与滚动区的高度都是小数（行高 / 间距的亚像素），加起来比 `height: 100%` 多出不到 1px；
 * 溢出会顺着祖先一路传出去 ⇒ 抽屉 body 自己也长出一根原生滚动条，与虚拟列表那根并存。
 * jsdom 没有布局（量不到 `scrollHeight`）⇒ 这里只钉住兜底那一处：根节点 `overflow: hidden`。
 */
describe('根节点裁掉溢出（滚动只在虚拟列表里）', () => {
  it('根节点 overflow: hidden', () => {
    const node = sessionNode({ id: 'main', content: { status: 'ready', data: TWO_TURNS } });
    render(<AgentLogLayout model={modelOf(node)} actions={[]} />);

    expect(screen.getByTestId('agent-log-layout').style.overflow).toBe('hidden');
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
  it('滚动区是定位基准，浮动件在它里面', () => {
    const source = readFileSync(join(import.meta.dirname, 'agent-log-layout.tsx'), 'utf8');
    const scrollAt = source.indexOf('ref={scrollAreaRef}');
    const floatAt = source.indexOf('<FloatButton');
    const footerAt = source.indexOf('data-testid="agent-log-footer"');
    expect(scrollAt).toBeGreaterThan(-1);
    expect(floatAt).toBeGreaterThan(-1);
    // 浮动件在滚动区之后、底部槽之前（底部槽那一格排在滚动区之后）
    expect(floatAt).toBeGreaterThan(scrollAt);
    expect(floatAt).toBeLessThan(footerAt);
    // 滚动区带 `position: 'relative'`（浮出按钮的 `position: absolute` 量的是它的底边）
    const scrollBlock = source.slice(scrollAt, floatAt);
    // 用正则而不是字符串字面量：被断言的那一段源码里本身带引号，而本仓的引号规则不许转义
    expect(scrollBlock).toMatch(/position:\s*'relative'/);
  });
});
