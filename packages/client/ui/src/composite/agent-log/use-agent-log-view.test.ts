/**
 * `useAgentLogView` 与 `defaultOpenKeysOf` 的守卫。四组： * 1. **默认展开态**（表格 + 例外）：进行中的组展开、**失败的组与失败的行都收起**、
 * 思考收起、首次计划清单展开、`pending + running` 与异常收场的问答展开；
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
    usage: null,
    text: `正文 ${id}`,
  };
}

function thinkingBlock(id: string): ThinkingBlock {
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
    text: '想了想',
    textMissing: null,
    textKind: 'full',
  };
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
  return { round: 1, at: AT, subagentId: null, tokens: null, durationMs: null, running: false, ...overrides };
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
    },
    nodes,
    activeNodeId,
    rowEvents: [],
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

  it('思考块默认收起（不加键）', () => {
    expect(defaultOpenKeysOf([turn({ blocks: [thinkingBlock('k1')] })], nodes).size).toBe(0);
  });

  it('计划清单：首次（change 为 null）展开；其余收起；进行中或结果未采集时展开', () => {
    const first = defaultOpenKeysOf([turn({ blocks: [toolCall('card-1', 'call_t', taskPayload())] })], nodes);
    expect(first.has('card-1')).toBe(true);

    const later = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('card-2', 'call_t2', taskPayload({ change: { completed: 1, added: 0, removed: 0 }, result: { ok: true, raw: null, truncation: { kind: 'none' } } }))] })],
      nodes,
    );
    expect(later.has('card-2')).toBe(false);

    const running = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('card-3', 'call_t3', taskPayload({ change: { completed: 1, added: 0, removed: 0 }, running: true }))] })],
      nodes,
    );
    expect(running.has('card-3')).toBe(true);

    const noResult = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('card-4', 'call_t4', taskPayload({ change: { completed: 1, added: 0, removed: 0 } }))] })],
      nodes,
    );
    expect(noResult.has('card-4')).toBe(true);
  });

  it('问答卡片：pending + running 展开；timeout / unavailable / rejected 展开；其余收起', () => {
    const pendingRunning = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('ask-1', 'call_a', askPayload({ state: 'pending', questions: [], at: AT, running: true }))] })],
      nodes,
    );
    expect(pendingRunning.has('ask-1')).toBe(true);

    const pendingNoResult = defaultOpenKeysOf(
      [turn({ blocks: [toolCall('ask-2', 'call_a2', askPayload({ state: 'pending', questions: [], at: AT, running: false }))] })],
      nodes,
    );
    expect(pendingNoResult.has('ask-2')).toBe(false);

    for (const outcome of ['timeout', 'unavailable', 'rejected'] as const) {
      const keys = defaultOpenKeysOf(
        [turn({ blocks: [toolCall(`ask-${outcome}`, 'call_a3', askPayload({ state: 'settled', questions: [], outcome, answers: null, at: AT, result: null }))] })],
        nodes,
      );
      expect(keys.has(`ask-${outcome}`)).toBe(true);
    }

    for (const outcome of ['answered', 'skipped', 'canceled', 'auto-resolved'] as const) {
      const keys = defaultOpenKeysOf(
        [turn({ blocks: [toolCall(`ask-${outcome}`, 'call_a4', askPayload({ state: 'settled', questions: [], outcome, answers: null, at: AT, result: null }))] })],
        nodes,
      );
      expect(keys.has(`ask-${outcome}`)).toBe(false);
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
