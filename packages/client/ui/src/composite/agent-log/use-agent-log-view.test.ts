/**
 * `useAgentLogView` 与 `defaultOpenKeysOf` 的守卫。四组： * 1. **默认展开态**（表格 + 例外）：进行中的组展开、**失败的组与失败的行都收起**、
 * 思考块进行中展开/结束收起、计划清单进行中展开/完成收起、**问答卡片一格都不加**
 * （卡片不折叠，里面的问题面板默认全收起）；
 *   2. **折叠态是「默认 ∪ 手动开 ∖ 手动关」**：用户关得掉一个默认展开的块（否则那个开关是假的）；
 *   3. **节点回落**：模型换了、选中的节点没了 ⇒ 回到默认节点；
 *   4. **过滤两格的 AND 叠加**（判据见 `turnMatchesFilters`）。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type {
  AgentLogModel,
  AskUserInteraction,
  ContentBlock,
  LogNode,
  LogTurn,
  SessionNode,
  TaskPanel,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultBlock,
} from './types';
import { nodeIndex } from './render-blocks';
import { defaultActiveNodeId, defaultOpenKeysOf, useAgentLogView } from './use-agent-log-view';
import { turnMatchesFilters } from './agent-log-layout';

const AT = '2026-10-02T10:44:31.000Z';

function textBlock(id: string): TextBlock {
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
    text: `正文 ${id}`,
  };
}

function thinkingBlock(id: string, assembly: ThinkingBlock['assembly'] = 'snapshot'): ThinkingBlock {
  return {
    kind: 'thinking',
    id,
    at: AT,
    messageId: 'm1',
    subagentId: null,
    role: 'assistant',
    source: 'wire',
    assembly,
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
    text: '想了想',
    textMissing: null,
    textKind: 'full',
  };
}

/** 只有一个节点的模型（主会话装这几轮）；`useAgentLogView` 的默认展开键按它的轮次算 */
function mainModel(turns: readonly LogTurn[]): AgentLogModel {
  return model([sessionNode({ id: 'main', kind: 'main', content: { status: 'ready', data: turns } })], 'main');
}

function toolCall(id: string, callId: string, tool: ToolCallBlock['tool'] = null): ToolCallBlock {
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
    segment: 0,
    usage: null,
    callId,
    name: 'pwsh',
    nameMissing: null,
    family: tool === null ? 'run-shell' : tool.family,
    input: { value: null, text: null, bytes: null, description: null },
    tool,
  };
}

function toolResult(id: string, callId: string, status: 'ok' | 'error' = 'ok'): ToolResultBlock {
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
    segment: 0,
    usage: null,
    callId,
    text: '结果',
    // 用例不关心结构化结果，但接口要求给一格（`null` = 这一家没给）
    structured: null,
    status,
    bytes: 2,
    truncation: { kind: 'none' },
  };
}

function taskPayload(overrides: Partial<TaskPanel> = {}): ToolCallBlock['tool'] {
  return {
    family: 'task',
    panel: {
      steps: [],
      counts: { pending: 0, inProgress: 0, completed: 0, unknown: 0 },
      change: null,
      note: null,
      at: AT,
      result: null,
      running: false,
      ...overrides,
    },
  };
}

function askPayload(interaction: AskUserInteraction): ToolCallBlock['tool'] {
  return { family: 'ask-user', interaction };
}

function turn(overrides: Partial<LogTurn> & { blocks: ContentBlock[] }): LogTurn {
  // 兜底定位键的夹具口径：**投递顺序上第一条块**的 `messageId`（用例可以用 overrides 覆写它）
  const fallbackMessageId = overrides.fallbackMessageId ?? overrides.blocks[0]?.messageId ?? null;
  return { round: 1, segment: 0, at: AT, subagentId: null, tokens: null, durationMs: null, running: false, ...overrides, fallbackMessageId };
}

function sessionNode(overrides: Partial<SessionNode> & { id: string }): SessionNode {
  return {
    kind: 'subagent',
    parentId: null,
    spawnedBy: null,
    status: 'completed',
    statusMissing: null,
    startedAt: null,
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

function model(nodes: LogNode[], activeNodeId: string): AgentLogModel {
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
      contextUsed: null,
      contextWindow: null,
    },
    nodes,
    activeNodeId,
    rowEvents: [],
    // 段这一层的事实：本夹具没有追问，故一个段标题都不画
    segments: [],
    empty: false,
  };
}

const NODES = [sessionNode({ id: 'main', kind: 'main' }), sessionNode({ id: 'sub', parentId: 'main' })];

describe('defaultOpenKeysOf（内置默认展开态）', () => {
  const nodes = nodeIndex([]);

  it('进行中的工具组默认展开（组键带 tool-group: 前缀，与组内行键不撞）', () => {
    const keys = defaultOpenKeysOf([turn({ running: true, blocks: [toolCall('c1', 'call_1')] })], nodes);

    expect(keys.has('tool-group:call_1')).toBe(true);
    // 行键是另一格：组展开不等于那一行也展开
    expect(keys.has('call_1')).toBe(false);
  });

  it('组内有 running 的调用时，即使轮次本身没标 running 也展开', () => {
    const blocks = [toolCall('c1', 'call_1')];
    const turns = [turn({ blocks })];
    // `ToolItem.running` 由 `LogTurn.running` 转发 ⇒ 先确认它确实为 false
    expect(defaultOpenKeysOf(turns, nodes).has('tool-group:call_1')).toBe(false);

    const runningEntry = defaultOpenKeysOf([turn({ running: true, blocks })], nodes);
    expect(runningEntry.has('tool-group:call_1')).toBe(true);
  });

  /**
   * 覆盖的例外 2「失败的工具自动展开」：
   * 失败的工具调用**默认也折叠**，组与组内那一行都不展开。
   * 失败不再是展开的理由——「收起态仍看得出这组有失败」由组头的「失败 N」标记承担（`ToolGroupPanel`）。
   */
  it('失败的工具组与失败的行都默认收起（不加键就是收起）', () => {
    const keys = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('c1', 'call_1'), toolResult('r1', 'call_1', 'error')] })],
      nodes,
    );

    expect(keys.has('tool-group:call_1')).toBe(false);
    expect(keys.has('call_1')).toBe(false);
  });

  it('组内有失败而轮次还在跑时，仍因「进行中」展开——但那一行失败仍收起', () => {
    const keys = defaultOpenKeysOf(
      [turn({ running: true, blocks: [toolCall('c1', 'call_1'), toolResult('r1', 'call_1', 'error')] })],
      nodes,
    );

    expect(keys.has('tool-group:call_1')).toBe(true);
    // 展开组之后，失败的证据还要用户点一次：这是刻意的口径
    expect(keys.has('call_1')).toBe(false);
  });

  /**
   * **思考块的 `open ?? running`：第一段「用户还没表态」由默认键承担。**
   *
   * 判据是块自己的 `assembly`（流式的唯一判据）：还在流 ⇒ 进默认键（自动展开）；
   * 收成快照 ⇒ 不进键（自动收起）。两档必须一起钉：只钉前者时「结束不收起」照样绿。
   */
  it('思考中自动展开：`assembly` 为 open 的思考块进默认展开键；结束（snapshot）后不进键（自动收起）', () => {
    expect(defaultOpenKeysOf([turn({ blocks: [thinkingBlock('k1', 'open')] })], nodes).has('k1')).toBe(true);
    expect(defaultOpenKeysOf([turn({ blocks: [thinkingBlock('k1')] })], nodes).has('k1')).toBe(false);
  });

  /**
   * 计划清单：**进行中展开、完成收起**（不看「首次」也不看「结果采没采到」）。
   *
   * 「首次」不是展开的理由：一张已完成的清单把结论写在摘要行上（`4/7 完成` + 状态词），
   * 展开只会多占一屏。结果未采集也不是：那是「这一格的证据没到」，
   * 与「这一步还在跑」是两件事（状态行自己会说原因）。
   */
  it('计划清单：进行中展开；已完成（无论是否首次、结果采没采到）收起', () => {
    const running = defaultOpenKeysOf(
      [turn({ running: true, blocks: [toolCall('card-1', 'call_t', taskPayload({ running: true }))] })],
      nodes,
    );
    expect(running.has('card-1')).toBe(true);

    // 首次（`change === null`）+ 已完成 ⇒ 收起（旧口径在这一格是「展开」，正是本票要改的默认行为）
    const firstDone = defaultOpenKeysOf([turn({ blocks: [toolCall('card-2', 'call_t2', taskPayload())] })], nodes);
    expect(firstDone.has('card-2')).toBe(false);

    const laterDone = defaultOpenKeysOf(
      [
        turn({
          blocks: [
            toolCall(
              'card-3',
              'call_t3',
              taskPayload({ change: { completed: 1, added: 0, removed: 0 }, result: { ok: true, raw: null, truncation: { kind: 'none' } } }),
            ),
          ],
        }),
      ],
      nodes,
    );
    expect(laterDone.has('card-3')).toBe(false);

    // 结果未采集但已收场 ⇒ 同样收起（摘要行的状态词负责说「结果未采集」）
    const noResult = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('card-4', 'call_t4', taskPayload({ change: { completed: 1, added: 0, removed: 0 } }))] })],
      nodes,
    );
    expect(noResult.has('card-4')).toBe(false);
  });

  /**
   * 问答卡片**一格默认展开键都不加**：卡片是 `Card` 外壳、本身不折叠，
   * 里面一问一格面板全部默认收起（等待态由卡面那枚「等待答复中… 12m」承担）。
   *
   * 靶子是「按收场态决定展开」那套旧口径：收场方式与「要不要展开」无关了，
   * 任何一态都不得给卡片加键——加了就会让某一类收场的面板自己弹开，而卡片外观一致、看不出区别。
   */
  it('问答卡片不加默认键：任何收场态（含等待中）都不展开', () => {
    const states: AskUserInteraction[] = [
      { state: 'pending', questions: [], at: AT, running: true },
      { state: 'pending', questions: [], at: AT, running: false },
      ...(['answered', 'auto-resolved', 'skipped', 'timeout', 'unavailable', 'rejected', 'canceled'] as const).map(
        (outcome): AskUserInteraction => ({ state: 'settled', questions: [], outcome, answers: null, at: AT, result: null }),
      ),
    ];

    for (const [index, interaction] of states.entries()) {
      const cardId = `ask-${index}`;
      const keys = defaultOpenKeysOf([turn({ blocks: [toolCall(cardId, `call_a${index}`, askPayload(interaction))] })], nodes);
      expect(keys.has(cardId), `${cardId} 不该有默认展开键`).toBe(false);
      // 问题面板的键（`<卡片 id>|q<序号>`）同样一个都不加
      expect([...keys].some((key) => key.startsWith(`${cardId}|`)), `${cardId} 的问题面板不该预展开`).toBe(false);
    }
  });
});

describe('useAgentLogView', () => {
  it('activeNodeId 的默认值：模型给的若在 nodes 里就用它，否则主会话，再次是第一个节点', () => {
    expect(defaultActiveNodeId(model(NODES, 'sub'))).toBe('sub');
    expect(defaultActiveNodeId(model(NODES, '不存在的节点'))).toBe('main');
    expect(defaultActiveNodeId(model([sessionNode({ id: 'only' })], ''))).toBe('only');
  });

  it('模型换了、选中的节点没了 ⇒ 回落到默认节点', () => {
    const { result, rerender } = renderHook(({ current }) => useAgentLogView({ model: current }), {
      initialProps: { current: model(NODES, 'sub') },
    });
    expect(result.current.activeNodeId).toBe('sub');

    // 新模型里没有 `sub` 了（重新跑了一行、会话树整个换掉）
    rerender({ current: model([sessionNode({ id: 'main', kind: 'main' })], 'sub') });
    expect(result.current.activeNodeId).toBe('main');
  });

  it('折叠态：手动开过的加进去、手动关掉的移出去', () => {
    const { result } = renderHook(() => useAgentLogView({ model: model(NODES, 'main') }));

    act(() => result.current.onOpenChange('k', true));
    expect(result.current.openKeys.has('k')).toBe(true);

    act(() => result.current.onOpenChange('k', false));
    expect(result.current.openKeys.has('k')).toBe(false);
  });

  it('默认展开的块也关得掉（用户的动作覆盖内置规则）', () => {
    const { result } = renderHook(() =>
      useAgentLogView({ model: model(NODES, 'main'), defaultOpenKeys: new Set(['auto']) }),
    );
    expect(result.current.openKeys.has('auto')).toBe(true);

    act(() => result.current.onOpenChange('auto', false));

    expect(result.current.openKeys.has('auto')).toBe(false);
  });

  it('不传 defaultOpenKeys 时按当前节点的轮次自己算（进行中的组自动展开）', () => {
    const turns = [turn({ running: true, blocks: [toolCall('c1', 'call_1')] })];
    const { result } = renderHook(() =>
      useAgentLogView({ model: model([sessionNode({ id: 'main', kind: 'main', content: { status: 'ready', data: turns } })], 'main') }),
    );

    expect(result.current.openKeys.has('tool-group:call_1')).toBe(true);
  });

  /**
   * **思考块的三段语义**（`open ?? running`，判据来自块自己的 `assembly`）：
   *   ① 用户还没表态 ⇒ 跟 `running`（默认键）；② 用户点开过 ⇒ 听用户的（`openedKeys`）；
   *   ③ 用户点收过 ⇒ 听用户的（`closedKeys`，**即使它还在流**）。
   *
   * 三段落全部由 `useAgentLogView` 的合并式（默认 ∪ 点开 ∖ 点收）承担，组件只吃一个受控 `open`
   * ——组件里没有第二份 state（分层纪律 (d)）。三条用例各钉一段，任一段退化都能单独见红。
   */
  it('思考块：进行中自动展开，结束后自动收起（默认键随 `assembly` 来去）', () => {
    const streaming = mainModel([turn({ blocks: [thinkingBlock('k1', 'open')] })]);
    const { result, rerender } = renderHook(({ current }) => useAgentLogView({ model: current }), {
      initialProps: { current: streaming },
    });
    expect(result.current.openKeys.has('k1')).toBe(true);

    // 同一条思考结束：块收成快照 ⇒ 默认键消失 ⇒ 自动收起
    rerender({ current: mainModel([turn({ blocks: [thinkingBlock('k1')] })]) });
    expect(result.current.openKeys.has('k1')).toBe(false);
  });

  it('思考块：用户手动收起后，后续流式更新不会把它重新展开（第二段之后听用户的）', () => {
    const { result, rerender } = renderHook(({ current }) => useAgentLogView({ model: current }), {
      initialProps: { current: mainModel([turn({ blocks: [thinkingBlock('k1', 'open')] })]) },
    });
    expect(result.current.openKeys.has('k1')).toBe(true);

    act(() => result.current.onOpenChange('k1', false));
    expect(result.current.openKeys.has('k1')).toBe(false);

    // 流还在继续（新模型、新数组、assembly 仍是 open）：默认键会重新算出来，但「点收」压住它
    rerender({ current: mainModel([turn({ blocks: [thinkingBlock('k1', 'open')] })]) });
    expect(result.current.openKeys.has('k1')).toBe(false);
  });

  it('思考块：用户手动展开的，结束后保持展开（第三段的另一面）', () => {
    const { result, rerender } = renderHook(({ current }) => useAgentLogView({ model: current }), {
      initialProps: { current: mainModel([turn({ blocks: [thinkingBlock('k1')] })]) },
    });
    expect(result.current.openKeys.has('k1')).toBe(false);

    act(() => result.current.onOpenChange('k1', true));
    // 结束后默认键已不存在，但「点开」那份记忆还在
    rerender({ current: mainModel([turn({ blocks: [thinkingBlock('k1')] })]) });
    expect(result.current.openKeys.has('k1')).toBe(true);
  });

  it('filters 是两格一个对象：setFilters 原样落进 state（AND 由判据函数负责）', () => {
    const { result } = renderHook(() => useAgentLogView({ model: model(NODES, 'main') }));

    act(() => result.current.setFilters({ onlyTools: true, onlyErrors: true }));

    expect(result.current.filters).toEqual({ onlyTools: true, onlyErrors: true });
  });

  it('两个过滤 AND 叠加：只开一个时只认那一条，两个都开时两条都要满足', () => {
    const toolsTurn = turn({ blocks: [toolCall('c1', 'call_1'), toolResult('r1', 'call_1', 'error')] });
    const textTurn = turn({ blocks: [textBlock('t1')] });

    expect(turnMatchesFilters(toolsTurn, [], { onlyTools: true, onlyErrors: false })).toBe(true);
    expect(turnMatchesFilters(textTurn, [], { onlyTools: true, onlyErrors: false })).toBe(false);
    // 两个都开：纯文本那一轮两条都不满足
    expect(turnMatchesFilters(textTurn, [], { onlyTools: true, onlyErrors: true })).toBe(false);
    // 工具有、但没错误 ⇒ 两个都开时不命中
    const okTools = turn({ blocks: [toolCall('c2', 'call_2'), toolResult('r2', 'call_2')] });
    expect(turnMatchesFilters(okTools, [], { onlyTools: true, onlyErrors: true })).toBe(false);
  });
});
