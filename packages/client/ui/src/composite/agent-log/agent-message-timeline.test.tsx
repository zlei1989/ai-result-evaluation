/**
 * `AgentMessageTimeline`（L1）的守卫。四条：
 *   1. **逐轮 `map` 渲染**：50 轮就要在 DOM 里数到 50 行——这条钉的正是「L1 不虚拟化」（变异体 (n)）；
 *   2. **默认收起**：`openKeys` 为空时，思考正文与工具结果都不在 DOM 里（是真收起，不是视觉收起）；
 *   3. **进行中的组默认展开**：把 `defaultOpenKeysOf` 算出来的键传进去，正文必须立刻可见；
 *      **失败的组与失败的行都默认收起**（2026-10-03 用户口径：失败不再是展开的理由）；
 *   4. **分派**：`renderBlock` 不传走默认注册表，传了就用传入的（§9.2）。
 *
 * 断言用两个锚点：`data-turn-row` 数**轮次行**、`data-row-event` 数**行级事件行**（两者都由本组件自己标，
 * 不是 antd 的内部类名）。⚠️ 数用量行必须用后者（见 `eventRowTexts` 的注释）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, AgentMessage, RowRecord } from '@aieval/contracts';
import type {
  ContentBlock,
  LogTurn,
  SessionNode,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
} from './types';
import { buildAgentLogModel } from './build-model';
import { nodeIndex, type RenderBlock } from './render-blocks';
import { AgentMessageTimeline } from './agent-message-timeline';
import type { BlockRenderContext } from './block-renderer-registry';
import { defaultOpenKeysOf } from './use-agent-log-view';
import { installResizeObserverStub } from '../../testing/resize-observer';

// jsdom 没有 `ResizeObserver`，而展开的工具行里 `EllipsisText` 会 new 它（L0 的实现）：
// 不打桩，展开那一条就会在 effect 里抛 `ReferenceError`——环境缺口，不是被测代码的问题。
beforeEach(() => {
  installResizeObserverStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const AT = '2026-10-02T10:44:31.000Z';
const AT2 = '2026-10-02T10:44:41.000Z';

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

function thinkingBlock(id: string, text: string): ThinkingBlock {
  return {
    kind: 'thinking',
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
    textMissing: null,
    textKind: 'full',
  };
}

function toolCall(id: string, callId: string, name: string): ToolCallBlock {
  return {
    kind: 'tool-call',
    id,
    at: AT,
    messageId: 'm1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    usage: null,
    callId,
    name,
    nameMissing: null,
    family: 'run-shell',
    input: { value: 'pnpm vitest run', text: null, bytes: null },
    tool: null,
  };
}

function toolResult(id: string, callId: string, text: string, status: 'ok' | 'error' = 'ok'): ToolResultBlock {
  return {
    kind: 'tool-result',
    id,
    at: AT,
    messageId: 'm1',
    subagentId: null,
    role: 'tool',
    source: 'wire',
    assembly: 'snapshot',
    mergeKey: 'main|1|assistant|-',
    usage: null,
    callId,
    text,
    // 厂商的结构化结果这里不关心，但接口要求给一格（`null` = 这一家没给）
    structured: null,
    status,
    bytes: text.length,
    truncation: { kind: 'none' },
  };
}

function turn(overrides: Partial<LogTurn> & { blocks: ContentBlock[] }): LogTurn {
  return { round: 1, at: AT, subagentId: null, tokens: null, durationMs: null, running: false, ...overrides };
}

/** 会话节点：只为「派发点出占位条」这一条用例造一个（其余格按「都没有」补齐） */
function sessionNode(overrides: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    kind: 'subagent',
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

/**
 * 「主会话 + 一个**可达**子会话」的端到端夹具（下面两条水位用例共用）。
 *
 * 可达（`spawnedBy !== null`）是必须的：不可达节点的轮次不算「有家」，那条链上的归属会整体退回孤儿
 * （`build-model.test.ts`「不可达的子会话节点…」那条），这两条用例考的就不是水位了。
 * 主会话第 1 轮那条消息**就是**派发调用（与既有「整条链」用例同一手法），于是每条消息各占一个轮次。
 */
function sessionChainModel(input: { mainRounds: number; childRounds: number; events: AgentEvent[] }) {
  const record = (id: string, mergeKey: string, roundTrip: number, subagentId: string | null, blocks: AgentMessage['blocks']): RowRecord => ({
    type: 'message',
    message: {
      messageId: id,
      vendorId: null,
      role: 'assistant',
      source: 'wire',
      roundTrip,
      vendorTurn: null,
      step: null,
      parentCallId: null,
      subagentId,
      chunk: 'snapshot',
      assembly: 'snapshot',
      mergeKey,
      // 消息级用量：这一族用例不关心它（页脚那一组显式给）
      usage: null,
      blocks,
      raw: null,
    },
  });

  return buildAgentLogModel({
    records: [
      record('m-main-1', 'main|1|assistant|-', 1, null, [
        { type: 'tool-call', callId: 'call_sub', family: 'spawn-agent', name: 'spawn_agent', input: { description: '审查页面' } },
      ]),
      ...Array.from({ length: input.mainRounds - 1 }, (_, index) =>
        record(`m-main-${index + 2}`, `main|${index + 2}|assistant|-`, index + 2, null, [{ type: 'text', text: `主会话第 ${index + 2} 轮` }]),
      ),
      ...Array.from({ length: input.childRounds }, (_, index) =>
        record(`m-sub-${index + 1}`, `sub-1|${index + 1}|assistant|-`, index + 1, 'sub-1', [{ type: 'text', text: `子会话第 ${index + 1} 轮` }]),
      ),
      {
        type: 'subagent',
        subagent: {
          subagentId: 'sub-1',
          name: '审查页面',
          kind: 'spawn_agent',
          source: 'wire',
          status: 'completed',
          statusMissing: null,
          outcome: null,
          parentCallId: 'call_sub',
          parentSubagentId: null,
          usage: null,
        },
      },
    ],
    events: input.events,
    facts: {
      status: { tone: 'ok', label: '已评分' },
      startedAt: AT,
      endedAt: AT2,
      turns: { current: 0, total: null },
      tokens: null,
      thinking: null,
      domain: [],
      error: null,
      live: false,
    },
    startedAt: AT,
  });
}

/** 造一条用量事件（只写下面两条用例需要的那几格：`AgentEvent` 是判别联合，逐格补齐不是靶子） */
function usageEvent(seq: number, input: number, turn: { subagentId: string | null; round: number }): AgentEvent {
  return {
    at: new Date(Date.parse(AT) + seq * 1000).toISOString(),
    seq,
    type: 'usage',
    tokens: { input, cached: 0, output: 0, reasoningOutput: null, total: null },
    turns: turn.round,
    timing: null,
    turn,
  } as unknown as AgentEvent;
}

/**
 * 逐条**行级事件**的文本（判据是组件自己标的 `data-row-event` 锚点，不是 antd 内部类名）。
 *
 * ⚠️ **不要用 `data-turn-row` 数用量行**（2026-10-05 审查 Important C）：那个锚点只标在 `TurnRow` 上，
 * 事件标签（`RowEventLines`）根本没有锚点 ⇒ 数出来的恒等于**轮次数**，与这一轮挂了几条事件无关。
 * 于是「主会话节点里恰好只有它自己那两条用量」这类判据当时**没有被落实**——任何水位变异下它都绿。
 */
const eventRowTexts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-row-event]')].map((row) => row.textContent ?? '');

describe('AgentMessageTimeline', () => {
  it('逐轮 map 渲染：50 轮就在 DOM 里数到 50 行', () => {
    const turns = Array.from({ length: 50 }, (_, index) =>
      turn({ round: index + 1, blocks: [textBlock(`t${index}`, `第 ${index + 1} 轮正文`)] }),
    );

    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(50);
    expect(screen.getByText('第 50 轮正文')).toBeInTheDocument();
    expect(screen.getByText('轮次 50')).toBeInTheDocument();
  });

  it('思考块默认收起：正文不在 DOM 里（不是视觉收起）', () => {
    const turns = [turn({ blocks: [thinkingBlock('k1', '先看看 package.json 里的脚本长什么样')] })];

    render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(screen.getByText('思考')).toBeInTheDocument();
    expect(screen.queryByText('先看看 package.json 里的脚本长什么样')).toBeNull();
  });

  it('工具组默认收起：组头在，组内正文（参数摘要）不在', () => {
    const turns = [
      turn({ blocks: [toolCall('c1', 'call_1', 'pwsh'), toolResult('r1', 'call_1', '12 passed')] }),
    ];

    render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    const header = screen.getByRole('button', { name: /工具调用 × 1/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // 参数摘要只出现在组内的行摘要里（组头只有调用名汇总），收起时它不该在 DOM 里
    expect(screen.queryByText('pnpm vitest run')).toBeNull();
    expect(screen.queryByText('12 passed')).toBeNull();
  });

  it('进行中的工具组默认展开：defaultOpenKeysOf 算出来的键传进去，组体立刻挂载', () => {
    const turns = [
      turn({ running: true, blocks: [toolCall('c1', 'call_1', 'pwsh'), toolResult('r1', 'call_1', '12 passed')] }),
    ];
    const nodes = nodeIndex([]);
    const openKeys = defaultOpenKeysOf(turns, nodes);

    render(<AgentMessageTimeline turns={turns} nodes={nodes} openKeys={openKeys} />);

    expect(screen.getByRole('button', { name: /工具调用 × 1/ })).toHaveAttribute('aria-expanded', 'true');
    // 组体真的挂上了：组内那一行的参数摘要（组头里没有这一格）
    expect(screen.getByText('pnpm vitest run')).toBeInTheDocument();
  });

  it('失败的组与失败的行都默认收起：错误原文不在 DOM 里（键来自 defaultOpenKeysOf）', () => {
    const turns = [
      turn({ blocks: [toolCall('c1', 'call_1', 'pwsh'), toolResult('r1', 'call_1', 'FAIL render-blocks', 'error')] }),
    ];
    const nodes = nodeIndex([]);
    const openKeys = defaultOpenKeysOf(turns, nodes);

    render(<AgentMessageTimeline turns={turns} nodes={nodes} openKeys={openKeys} />);

    // 组收起 ⇒ 组内的行压根没挂载：错误原文与参数摘要都不在 DOM 里（真收起，不是视觉收起）
    expect(screen.getByRole('button', { name: /工具调用 × 1/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('FAIL render-blocks')).toBeNull();
    expect(screen.queryByText('pnpm vitest run')).toBeNull();
  });

  it('renderBlock 不传时走默认注册表；传了就用传入的分派', () => {
    const turns = [turn({ blocks: [thinkingBlock('k1', '思考正文')] })];

    const { unmount } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);
    expect(screen.getByText('思考')).toBeInTheDocument();
    unmount();

    const renderBlock = vi.fn((block: RenderBlock, ctx: BlockRenderContext) => (
      <span data-testid="custom-block">
        {block.kind}:{String(ctx.open)}
      </span>
    ));
    render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} renderBlock={renderBlock} />);

    expect(screen.getByTestId('custom-block')).toHaveTextContent('thinking:false');
    // 传入的分派接管之后，默认注册表的标题不再出现
    expect(screen.queryByText('思考')).toBeNull();
    expect(renderBlock).toHaveBeenCalledTimes(1);
  });

  /**
   * 卡片底部「原始结果」抽屉的**接线**：L1 从同一份折叠态里按 `${块键}|raw` 算开合，并把回调转给
   * `onOpenChange`。它是 L0 那两格（`rawOpen` / `onRawOpenChange`）的**唯一来源**——漏了它，
   * 卡片底部的「原始结果」就是一个点不动的按钮，而**没有任何别的用例会红**
   * （卡片的用例只验证「透传给 RawOutputPanel」，不知道键是怎么算出来的）。
   *
   * 判据走自定义 `renderBlock`：它是 L1 与块之间的唯一接口，直接读到 `ctx` 的两个新格。
   */
  it('每个块都拿到 rawOpen / onRawOpenChange，键是块键 + `|raw`（同一份折叠态）', () => {
    const turns = [turn({ blocks: [textBlock('t1', '正文')] })];
    const onOpenChange = vi.fn();
    const renderBlock = vi.fn((_block: RenderBlock, ctx: BlockRenderContext) => (
      <button type="button" data-testid="probe" onClick={() => ctx.onRawOpenChange(true)}>
        {String(ctx.rawOpen)}
      </button>
    ));

    const { unmount } = render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        openKeys={new Set()}
        onOpenChange={onOpenChange}
        renderBlock={renderBlock}
      />,
    );

    // 没开时是 false
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
    fireEvent.click(screen.getByTestId('probe'));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    const [key, next] = onOpenChange.mock.calls[0] ?? [];
    expect(next).toBe(true);
    expect(String(key).endsWith('|raw')).toBe(true);
    unmount();

    // 把那个键放进 `openKeys`：同一块必须报 `rawOpen: true`（键确实是同一份折叠态里的键）
    render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        openKeys={new Set([String(key)])}
        onOpenChange={onOpenChange}
        renderBlock={renderBlock}
      />,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
    // 且它**不等于**块自己的键：卡片收起时抽屉照样能开着（两个独立的东西）
    expect(screen.getByTestId('probe').textContent).not.toBe('true|true');
  });

  it('用户提示词摆最前、不折叠；notices 紧随其后', () => {
    const turns = [turn({ blocks: [textBlock('t1', '正文内容')] })];

    render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        userPrompt={{ text: '帮我把 build 脚本修好', at: AT }}
        notices={[<span key="n">该子任务的对话未转发（只投送了工具调用）</span>]}
      />,
    );

    const prompt = screen.getByTestId('agent-log-user-prompt');
    expect(prompt).toHaveTextContent('用户提示词');
    expect(prompt).toHaveTextContent('帮我把 build 脚本修好');
    // 顺序：提示词 → 补充提示 → 轮次
    const notice = screen.getByText('该子任务的对话未转发（只投送了工具调用）');
    expect(prompt.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(screen.getByText('正文内容')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('行级事件按 at 落在轮次之间，三档各用自己的标签色', () => {
    const turns = [
      turn({ round: 1, at: AT, blocks: [textBlock('t1', '第一轮')] }),
      turn({ round: 2, at: AT2, blocks: [textBlock('t2', '第二轮')] }),
    ];

    render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        rowEvents={[
          { at: AT, level: 'milestone', text: '用量创新高', turn: null },
          { at: AT2, level: 'warning', text: '配置项没认出来', turn: null },
          { at: AT2, level: 'error', text: '工具返回非零退出码', turn: null },
        ]}
      />,
    );

    expect(screen.getByText('用量创新高').closest('.ant-tag')).toHaveClass('ant-tag-default');
    expect(screen.getByText('配置项没认出来').closest('.ant-tag')).toHaveClass('ant-tag-warning');
    expect(screen.getByText('工具返回非零退出码').closest('.ant-tag')).toHaveClass('ant-tag-error');
  });

  /**
   * 归属规则（2026-10-05，spec §2.4）：**有归属键的只按号**（身份也必须对上），**无键的仍按时刻**。
   * 三个靶子：① 号对得上就落在那一轮（哪怕它的 `at` 与那一轮的时刻对不上）；② 身份对不上 ⇒ 本节点不显示
   * （子会话同号的轮次不许认领主会话的里程碑）；③ `error` 这类没有键的，行为与今天逐字相同。
   */
  it('有归属键的里程碑按「会话 + 号」归位；对不上本节点的不显示；无键的仍按时刻', () => {
    const turns = [
      turn({ round: 1, at: AT, blocks: [textBlock('t1', '第一轮')] }),
      turn({ round: 2, at: AT2, blocks: [textBlock('t2', '第二轮')] }),
    ];

    render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        rowEvents={[
          // ① `at` 是 AT（第一轮的时刻），但归属说它是第 2 轮 ⇒ 必须落在第 2 轮
          { at: AT, level: 'milestone', text: '主会话第 2 轮的用量', turn: { subagentId: null, round: 2 } },
          // ② 别的会话的同号轮次：本节点（主会话）没有这一轮 ⇒ 不显示
          { at: AT2, level: 'milestone', text: '别的会话的用量', turn: { subagentId: 'child-2', round: 2 } },
          // ③ 没有归属键：按时刻（AT2 ⇒ 挂在最后一轮）
          { at: AT2, level: 'error', text: '一条错误', turn: null },
        ]}
      />,
    );

    const rows = [...document.querySelectorAll('[data-turn-row]')];
    const textOf = (row: Element): string => row.textContent ?? '';
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0]!)).not.toContain('主会话第 2 轮的用量');
    expect(textOf(rows[1]!)).toContain('主会话第 2 轮的用量');
    expect(screen.queryByText('别的会话的用量')).toBeNull();
    expect(textOf(rows[1]!)).toContain('一条错误');
  });

  /**
   * 子会话节点的**主路径**（2026-10-05，Task 7 审查 Minor）：带**非空身份**的归属键必须能在它自己节点的
   * 对应轮次上命中——上一条用例只钉了「主会话命中」与「别的会话不命中」，而子会话时间轴上的用量里程碑
   * 走的正是这一格（数据层给子会话节点发的里程碑自带 `subagentId`）。
   *
   * 判据落在 `data-turn-row="round-1"` 那一行的 DOM 里（行键由 `turnKey` 给）：命中是一件**可观测的结构**，
   * 而不是「某个函数返回了 true」。事件的 `at`（AT2）特意与这一轮的 `at`（AT）不同，免得断言靠「两个时刻
   * 恰好相等」蒙对。
   *
   * ⚠️ 如实登记它**守不住什么**：它对「身份比对本身」没有区分力——把 `subagentId` 比对换成恒真时，
   * 同号同轮照样命中、本用例照样绿；而只有一个轮次时，按时刻的老规则（`index === 0` 那一支）对任何 `at`
   * 都成立 ⇒ 它也证明不了「不是按时刻落进来的」。它守的是「**非空身份能命中**」这条主路径；身份比对那一格
   * 由上面的用例（别的会话同号不命中）守。
   * 能证伪它的变异体：让有键的分支**只认主会话**（`turn.subagentId === null && event.turn.subagentId === null && …`）
   * ⇒ 本用例红（实测整个 `@aieval/ui` 包里只有这一条变红，见 `task-8-guard-mutants.txt`）。
   */
  it('子会话自己的用量里程碑落在 `sub-1` 那一轮的行里（非空身份能命中的主路径）', () => {
    const turns = [turn({ round: 1, subagentId: 'sub-1', at: AT, blocks: [textBlock('t1', '子会话第一轮')] })];

    render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        rowEvents={[
          // 归属键说的是 `sub-1` 的第 1 轮（`at` 与这一轮的时刻不同 ⇒ 落点由归属键给出）
          { at: AT2, level: 'milestone', text: '子会话自己的用量', turn: { subagentId: 'sub-1', round: 1 } },
        ]}
      />,
    );

    const rows = [...document.querySelectorAll('[data-turn-row]')];
    expect(rows).toHaveLength(1);
    // 行键就是「哪一轮」：它必须出现在 round-1 那一行里，而不是挂在别的行上或整条消失
    expect(rows[0]!.getAttribute('data-turn-row')).toBe('round-1');
    expect(rows[0]!.textContent ?? '').toContain('子会话自己的用量');
  });

  /**
   * **整条链**：`events → buildAgentLogModel → rowEvents → 时间轴`（计划守卫 15 的另一半，
   * 2026-10-05 终审 A 补；2026-10-07 改成主会话读数——子会话那一条已经不再折行）。
   *
   * 上面两条用例是 **props 级**的：`rowEvents` 由用例手写直接喂给组件，于是「数据层真算出来的
   * `model.rowEvents` 到底带不带归属键」这一半没有守卫（`build-model.test.ts` 那侧只断到
   * `model.rowEvents`、不渲进时间轴；两半各自绿、接起来仍可能错）。这条从 `buildAgentLogModel`
   * 的真入口起，把它的 `rowEvents` **原样**交给时间轴：那一条用量必须落在它归属的那一轮里，
   * 而**子会话节点一行都不出**（子智能体用量只在派发点那张子任务卡片里）。
   */
  it('整条链：`buildAgentLogModel` 算出的那一条用量渲进对应轮次，子会话节点一行都不出', () => {
    /** 造一条消息记录（本文件其余用例都是 props 级，故这里只写这条链需要的那几格） */
    const messageRecord = (input: { id: string; mergeKey: string; subagentId: string | null; blocks: AgentMessage['blocks'] }): RowRecord => ({
      type: 'message',
      message: {
        messageId: input.id,
        vendorId: null,
        role: 'assistant',
        source: 'wire',
        roundTrip: 1,
        vendorTurn: null,
        step: null,
        parentCallId: null,
        subagentId: input.subagentId,
        chunk: 'snapshot',
        assembly: 'snapshot',
        mergeKey: input.mergeKey,
        // 消息级用量：这一族用例不关心它（页脚那一组显式给）
        usage: null,
        blocks: input.blocks,
        raw: null,
      },
    });

    const model = buildAgentLogModel({
      records: [
        // 主会话里那次派发调用：子节点靠它才有入口
        messageRecord({
          id: 'm0',
          mergeKey: 'main|1|assistant|-',
          subagentId: null,
          blocks: [{ type: 'tool-call', callId: 'call_sub', family: 'spawn-agent', name: 'spawn_agent', input: { description: '审查页面' } }],
        }),
        messageRecord({ id: 'm1', mergeKey: 'sub-1|1|assistant|-', subagentId: 'sub-1', blocks: [{ type: 'text', text: '子会话第一轮' }] }),
        {
          type: 'subagent',
          subagent: {
            subagentId: 'sub-1',
            name: '审查页面',
            kind: 'spawn_agent',
            source: 'wire',
            status: 'completed',
            statusMissing: null,
            outcome: null,
            parentCallId: 'call_sub',
            parentSubagentId: null,
            usage: null,
          },
        },
      ],
      events: [
        {
          at: AT,
          seq: 1,
          type: 'usage',
          tokens: { input: 10, cached: 0, output: 0, reasoningOutput: null, total: null },
          turns: 1,
          timing: null,
          turn: { subagentId: null, round: 1 },
          // 这里刻意只写这条链关心的那几格：`AgentEvent` 是判别联合，逐格补齐不是本用例的靶子
        } as unknown as AgentEvent,
      ],
      facts: {
        status: { tone: 'ok', label: '已评分' },
        startedAt: AT,
        endedAt: AT2,
        turns: { current: 0, total: null },
        tokens: null,
        thinking: null,
        domain: [],
        error: null,
        live: false,
      },
      startedAt: AT,
    });

    // 前提：主会话节点真的有第 1 轮，且那一条用量**带着**归属键（不是孤儿）
    const main = model.nodes.find((node) => node.kind === 'main');
    const child = model.nodes.find((node) => node.kind === 'subagent');
    if (main?.content.status !== 'ready' || child?.content.status !== 'ready') throw new Error('两个会话节点的内容都应就绪');
    expect(main.content.data.map((turn) => turn.round)).toEqual([1]);
    expect(model.rowEvents).toHaveLength(1);
    expect(model.rowEvents[0]?.turn).toEqual({ subagentId: null, round: 1 });

    const mainView = render(<AgentMessageTimeline turns={main.content.data} nodes={nodeIndex([child])} rowEvents={model.rowEvents} />);

    // 落点：那一条用量必须渲染在主会话 `round-1` 的那一行里（数据层给的归属键一路兑现到 DOM）
    const rows = [...mainView.container.querySelectorAll('[data-turn-row]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-turn-row')).toBe('round-1');
    expect(rows[0]!.textContent ?? '').toContain('用量 输入 10 tok');
    mainView.unmount();

    // 子会话节点：一条行级事件都不出（它自己的用量在那张子任务卡片里）
    const childView = render(<AgentMessageTimeline turns={child.content.data} nodes={nodeIndex([child])} rowEvents={model.rowEvents} />);
    expect(eventRowTexts(childView.container)).toEqual([]);
  });
  /**
   * **整行一条的端到端**（2026-10-07 用户裁定）：主会话报了两轮、子会话也报了两轮，数据层只交出
   * **一条**（候选阶段里最后那条主会话读数）；DOM 上主会话节点恰好一行、子会话节点一行都没有。
   *
   * 旧口径（水位按会话分桶）在这里会有三条——真机 run `8df6ff65` 的 claude 行就是这么串出 5 条的。
   */
  it('端到端：整行只有一条用量行（取最后那条主会话读数），子会话节点一行都没有', () => {
    const model = sessionChainModel({
      mainRounds: 2,
      childRounds: 2,
      events: [
        usageEvent(1, 50000, { subagentId: null, round: 1 }),
        usageEvent(2, 1000, { subagentId: 'sub-1', round: 1 }),
        usageEvent(3, 60000, { subagentId: null, round: 2 }),
        usageEvent(4, 3000, { subagentId: 'sub-1', round: 2 }),
      ],
    });
    const main = model.nodes.find((node) => node.kind === 'main');
    const child = model.nodes.find((node) => node.kind === 'subagent');
    if (main?.content.status !== 'ready' || child?.content.status !== 'ready') throw new Error('两个会话节点的内容都应就绪');

    // 主会话节点：恰好一行，且是最后那一条读数
    // ⚠️ 数的是**行级事件**（`data-row-event`），不是轮次行：后者恒等于轮次数（审查 Important C）
    const mainView = render(<AgentMessageTimeline turns={main.content.data} nodes={nodeIndex([child])} rowEvents={model.rowEvents} />);
    const mainRows = eventRowTexts(mainView.container);
    expect(mainRows).toHaveLength(1);
    expect(mainRows[0]).toContain('用量 输入 60,000 tok');
    // 候选阶段早先那几条读数一条都不在（水位那一版会把 50000 也画出来）
    expect(mainRows.join('\n')).not.toContain('用量 输入 50,000 tok');
    mainView.unmount();

    // 子会话节点：它自己的读数**不进时间轴**（只在派发点那张子任务卡片里）
    const childView = render(<AgentMessageTimeline turns={child.content.data} nodes={nodeIndex([child])} rowEvents={model.rowEvents} />);
    expect(eventRowTexts(childView.container)).toEqual([]);
    childView.unmount();

    /**
     * 前提：那一条真的进了 `model.rowEvents`（否则上面数出 0 行会像「组件没渲染」）。
     * ⚠️ 刻意放在 DOM 断言**之后**（2026-10-05 审查 Important C 起）：这一格与 DOM 上的
     * `data-row-event` 数的是同一批行，先断言 DOM 才能让「折行把行丢了」在判据本身上见红，
     * 而不是停在数据层的前提上。
     */
    expect(model.rowEvents.map((row) => row.turn)).toEqual([{ subagentId: null, round: 2 }]);
  });

  /**
   * **候选阶段之后的读数不算这一行**（端到端）。真机形状：候选跑完 → 评分智能体在同一条流里接着报
   * 用量（轮次从 1 重新数、token 只有候选的零头）。折行若只按「最后一条」取，这一行的读数会被换成
   * 评审者的——那正是 `row-live.ts` 的口径 5 在实时侧挡掉的那件事，时间轴这一侧同样要挡。
   */
  it('端到端：`judging` 之后评分智能体报的用量不顶掉候选那一条', () => {
    const model = sessionChainModel({
      mainRounds: 2,
      childRounds: 1,
      events: [
        usageEvent(1, 42315, { subagentId: null, round: 2 }),
        { at: AT2, seq: 2, type: 'status', status: 'judging' } as unknown as AgentEvent,
        usageEvent(3, 1280, { subagentId: null, round: 1 }),
      ],
    });

    expect(model.rowEvents.map((row) => row.text)).toEqual(['用量 输入 42,315 tok · 缓存 0 tok · 输出 0 tok · 轮次 2']);
    expect(model.rowEvents.map((row) => row.turn)).toEqual([{ subagentId: null, round: 2 }]);
  });

  it('空轮次渲染一张空列表（不抛、不留半截 DOM）', () => {
    const { container } = render(<AgentMessageTimeline turns={[]} nodes={nodeIndex([])} />);

    expect(container.querySelectorAll('[data-turn-row]').length).toBe(0);
    expect(screen.getByTestId('agent-message-timeline')).toBeInTheDocument();
  });

  it('子任务占位条：`onEnterNode` 透传到注册表，点「进入」把节点 id 交回去', () => {
    // 派发点由 `spawnedBy.callId` 命中本轮那次调用（注册表的 `subagent-bar` 臂）
    const subagent = sessionNode({
      id: 'sub-1',
      spawnedBy: { messageId: 'm1', callId: 'call_spawn', at: AT },
      subagentId: 'agent-9c1f2b44',
    });
    const nodes = nodeIndex([subagent]);
    const turns = [turn({ blocks: [toolCall('c1', 'call_spawn', 'spawn_agent')] })];
    const onEnterNode = vi.fn();

    render(<AgentMessageTimeline turns={turns} nodes={nodes} onEnterNode={onEnterNode} />);

    const enter = screen.getByRole('button', { name: /进入/ });
    // 不给 `onEnterNode` 时这一格是禁用态（L0 的口径）：给了才可点
    expect(enter).toBeEnabled();
    fireEvent.click(enter);
    expect(onEnterNode).toHaveBeenCalledWith('sub-1');
  });
});

/**
 * 消息级用量页脚（2026-10-06，spec `2026-09-30-exec-log-drawer-redesign-design.md` §6.13；
 * 用户裁定「消息级没有 usage 就不展示，避免口径混乱」）。四条判据：
 *   ① 一条消息一行（多个块只出一行）；② `usage === null` 一行都不出；
 *   ③ 文案是「本条 …」而不是「用量 …」（同屏已有行级事实条与轮末里程碑 Tag 两处同形数字）；
 *   ④ 形制与里程碑两两可分：页脚是**纯文本行**，不许被 Tag / Badge 包成色块。
 */
describe('消息级用量页脚（2026-10-06）', () => {
  const usage = { input: 295, cached: 7424, output: 841 };
  const footers = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('[data-usage-footer]')].map((node) => node.textContent ?? '');

  it('一条消息的多个块只出一行页脚，数字按 `formatUsageTriple`（千分位 + `tok`）', () => {
    const turns = [
      turn({
        blocks: [
          { ...textBlock('t1', '正文'), usage },
          { ...toolCall('c1', 'call_1', 'pwsh'), usage },
        ],
      }),
    ];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual(['本条 输入 295 tok · 缓存 7,424 tok · 输出 841 tok']);
    // 形制与轮末里程碑 Tag 必须两两可分（用户 2026-10-06 追加口径）
    expect(container.querySelectorAll('[data-usage-footer].ant-tag')).toHaveLength(0);
  });

  it('usage 为 null 时一行都不出（不显示 0、也不显示「未采集」）', () => {
    const turns = [turn({ blocks: [{ ...textBlock('t1', '正文'), usage: null }] })];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual([]);
  });

  it('子会话节点的消息同样出页脚', () => {
    const turns = [
      turn({ subagentId: 'sub-1', blocks: [{ ...textBlock('t1', '子会话正文'), subagentId: 'sub-1', usage }] }),
    ];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual(['本条 输入 295 tok · 缓存 7,424 tok · 输出 841 tok']);
  });

  it('工具结果消息（role=tool）哪怕带 usage 也不出页脚——计量只挂在模型产出上', () => {
    const turns = [turn({ blocks: [{ ...toolResult('r1', 'call_1', '12 passed'), usage }] })];
    const { container } = render(<AgentMessageTimeline turns={turns} nodes={nodeIndex([])} />);

    expect(footers(container)).toEqual([]);
  });

  /**
   * 与轮末里程碑**是两个不同锚点**（spec §5 守卫 6 的后半）：同屏同时出现时，
   * 页脚归 `[data-usage-footer]`、里程碑归 `[data-row-event]`，互不嵌套
   * ⇒ 将来任一侧换形制（比如把页脚也做成 Tag）都能被各自的断言抓住。
   */
  it('与轮末里程碑是两个不同锚点：同屏共存、互不嵌套', () => {
    const turns = [turn({ blocks: [{ ...textBlock('t1', '正文'), usage }] })];
    const { container } = render(
      <AgentMessageTimeline
        turns={turns}
        nodes={nodeIndex([])}
        rowEvents={[{ at: AT, level: 'milestone', text: '用量 输入 295 tok · 缓存 7,424 tok · 输出 841 tok · 轮次 1', turn: null }]}
      />,
    );

    expect(footers(container)).toEqual(['本条 输入 295 tok · 缓存 7,424 tok · 输出 841 tok']);
    const events = [...container.querySelectorAll('[data-row-event]')];
    expect(events).toHaveLength(1);
    expect(events[0]?.textContent).toContain('轮次 1');
    // 两个锚点互不嵌套：页脚不在里程碑里、里程碑也不在页脚里
    expect(container.querySelector('[data-usage-footer] [data-row-event]')).toBeNull();
    expect(container.querySelector('[data-row-event] [data-usage-footer]')).toBeNull();
  });
});
