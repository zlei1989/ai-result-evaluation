// @vitest-environment jsdom
/**
 * `buildRenderBlocks` 的守卫：这一层是整套设计里**最容易做错**的一块
 * （`callId` 配对、连续合并、两族卡片提出、派发点定位都在这儿），而它错起来的样子
 * 全都长得像「内容不对」而不是报错，故逐条钉住。
 *
 * 每条用例的靶子写在 `it` 的说明里；其中三条有专门的变异体：
 *   · 把 `callId` 配对改成「按出现顺序两两配对」 ⇒ 第一条必须红；
 *   · 把两族卡片改回留在工具组内 ⇒ 「组头的 N 不含提出去的调用」必须红；
 *   · 把同轮多次 `task` 调用画成多张面板 ⇒ 「只出最后一张」必须红。
 */
import { describe, expect, it } from 'vitest';
import { buildRenderBlocks, nodeIndex, type ToolItem } from './render-blocks';
import type { ContentBlock, LogNode, CandidateNode, SessionNode, ToolCardResult, ToolFamilyPayload } from './types';

/** 块信封的公共部分（用例只关心差异的那几格） */
function base(id: string, at = '2026-10-02T10:44:31.000Z') {
  return {
    id,
    at,
    messageId: 'm1',
    subagentId: null,
    role: 'assistant' as const,
    source: 'wire' as const,
    assembly: 'snapshot' as const,
    // 逻辑消息身份与消息级用量：这一族用例不关心它们（页脚那一组显式给）
    mergeKey: 'main|1|assistant|-',
    segment: 0,
    usage: null,
  };
}

function call(id: string, callId: string | null, name: string, family: ToolItem['family'] = null): ContentBlock {
  return {
    ...base(id),
    kind: 'tool-call',
    callId,
    name,
    nameMissing: null,
    family,
    input: { value: '{"a":1}', text: '{"a":1}', bytes: 7, description: null },
    tool: null,
  };
}

/**
 * 带「参数解析失败原文」的工具块（契约 `tool-call.inputError`）：界面上必须能把它带出去，
 * 否则坏参数与「模型真传了空对象」在摘要行/详情里逐字同形。
 */
function callWithInputError(id: string, callId: string, error: string): ContentBlock {
  const block = call(id, callId, 'read') as Extract<ContentBlock, { kind: 'tool-call' }>;
  return { ...block, input: { value: null, text: null, bytes: null, description: null }, inputError: error };
}

function result(id: string, callId: string | null, status: 'ok' | 'error' | 'unknown' = 'ok'): ContentBlock {
  return {
    ...base(id),
    kind: 'tool-result',
    callId,
    text: `out-${id}`,
    // 用例不关心结构化结果，但接口要求给一格（`null` = 这一家没给）
    structured: null,
    status,
    bytes: 6,
    truncation: { kind: 'none' },
  };
}

function text(id: string, value = '正文'): ContentBlock {
  return { ...base(id), kind: 'text', text: value };
}

/** 带族载荷的 `task` 调用（`steps` 只用于让面板非空） */
function taskCall(id: string, callId: string, steps = 1): ContentBlock {
  const payload: ToolFamilyPayload = {
    family: 'task',
    panel: {
      steps: Array.from({ length: steps }, (_, index) => ({ id: String(index), subject: `步骤 ${index}`, status: 'pending' as const, owner: null, blockedBy: null })),
      counts: { pending: steps, inProgress: 0, completed: 0, unknown: 0 },
      change: null,
      note: null,
      at: '',
      result: null,
      running: false,
    },
  };
  return { ...call(id, callId, 'todo_write', 'task'), tool: payload } as ContentBlock;
}

/** 带族载荷的 `ask-user` 调用 */
function askCall(id: string, callId: string): ContentBlock {
  const payload: ToolFamilyPayload = {
    family: 'ask-user',
    interaction: { state: 'pending', questions: [], at: '', running: true },
  };
  return { ...call(id, callId, 'ask_user_question', 'ask-user'), tool: payload } as ContentBlock;
}

/**
 * **已收场**的 `ask-user` 调用：卡片有答案与结果可显示（`AskUserSettled` 那一支）。
 * `result` 可以给 `null`——契约允许「收场了但原文没采到」，那时卡片没有结果可显示。
 */
function settledAskCall(id: string, callId: string, result: ToolCardResult | null = settledResult): ContentBlock {
  const payload: ToolFamilyPayload = {
    family: 'ask-user',
    interaction: { state: 'settled', questions: [], outcome: 'answered', answers: null, at: '', result },
  };
  return { ...call(id, callId, 'ask_user_question', 'ask-user'), tool: payload } as ContentBlock;
}

const settledResult: ToolCardResult = { ok: true, raw: '这一问的答案（收场方式：answered）', truncation: { kind: 'none' } };

function sessionNode(id: string, spawnedBy: SessionNode['spawnedBy']): SessionNode {
  return {
    kind: 'subagent',
    id,
    parentId: 'main',
    spawnedBy,
    status: 'completed',
    statusMissing: null,
    startedAt: null,
    endedAt: null,
    content: { status: 'ready', data: [] },
    contentTruncatedReason: null,
    capability: {},
    capabilityNotes: [],
    source: 'wire',
    subagentId: id,
    vendorId: null,
    dispatchKind: 'spawn_agent',
    name: null,
    nameMissing: null,
    userPrompt: null,
    usage: null,
    outcome: null,
    sessionFacts: null,
  };
}

function candidateNode(id: string): CandidateNode {
  return {
    kind: 'row',
    id,
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
    counts: { subagents: 3, completed: 2, failed: 1 },
    facts: {
      status: { tone: 'ok', label: '已评分' },
      startedAt: null,
      endedAt: null,
      turns: { current: 0, total: null },
      tokens: null,
      thinking: null,
      domain: [],
      error: null,
    },
  };
}

/** 轮上下文：`firstTurn: true` 表示这是该节点的第一轮（候选级汇总那条说明行只在第一轮出现） */
const TURN = { at: '2026-10-02T10:44:31.000Z', running: false, messageId: 'm1', nodeId: 'main', firstTurn: true };

describe('buildRenderBlocks：callId 配对', () => {
  it('配上的结果并入同一个条目（组里只有一条，且它有 output）', () => {
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'read_file'), result('r1', 'call_1')], nodeIndex([]), TURN);
    expect(blocks).toHaveLength(1);
    const group = blocks[0];
    expect(group?.kind).toBe('tool-group');
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries).toHaveLength(1);
    expect(group.entries[0]?.kind).toBe('call');
    if (group.entries[0]?.kind !== 'call') throw new Error('应为调用条目');
    expect(group.entries[0].output?.text).toBe('out-r1');
  });

  it('`callId` 为 null 的调用与结果各成一条（**不按出现顺序两两配对**）', () => {
    const blocks = buildRenderBlocks([call('c1', null, 'mystery'), result('r1', null)], nodeIndex([]), TURN);
    const group = blocks[0];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries.map((entry) => entry.kind)).toEqual(['call', 'orphan-result']);
    // 配对成功的话这里会是 1 条且带 output —— 这正是这条守卫要拦的形状
    expect(group.entries[0]?.kind === 'call' ? group.entries[0].output : 'unexpected').toBeNull();
  });

  it('配不上的结果独立成条，**不被丢弃**', () => {
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'read_file'), result('r1', 'call_2')], nodeIndex([]), TURN);
    const group = blocks[0];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries).toHaveLength(2);
    expect(group.entries[1]?.kind).toBe('orphan-result');
  });

  it('条目带上源块的 id（行键的兜底身份：同一轮两条孤立结果不能共用一个键）', () => {
    // 两条配不上调用的结果：`at` 是轮次派生的、两条逐字相同 ⇒ 唯一性只能来自源块 id
    const blocks = buildRenderBlocks([result('r1', 'call_1'), result('r2', 'call_2')], nodeIndex([]), TURN);
    const group = blocks[0];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries.map((entry) => entry.blockId)).toEqual(['r1', 'r2']);
    expect(new Set(group.entries.map((entry) => entry.blockId)).size).toBe(group.entries.length);
    // 调用条目同样带：`callId` 缺失时它是行键唯一剩下的来源
    const [callEntry] = buildRenderBlocks([call('c1', null, 'mystery')], nodeIndex([]), TURN);
    if (callEntry?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(callEntry.entries[0]?.blockId).toBe('c1');
  });
});

describe('buildRenderBlocks：工具组合并', () => {
  it('相邻的工具条目合并成一个组', () => {
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'a'), call('c2', 'call_2', 'b')], nodeIndex([]), TURN);
    expect(blocks).toHaveLength(1);
    const group = blocks[0];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries).toHaveLength(2);
  });

  it('中间夹一条正文 ⇒ 前后各成一组（不合并）', () => {
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'a'), text('t1'), call('c2', 'call_2', 'b')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['tool-group', 'text', 'tool-group']);
  });
});

describe('buildRenderBlocks：两族卡片', () => {
  it('`task` 卡片从工具组里提出，并**切断**合并链（前后各成一组）', () => {
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'a'), taskCall('c2', 'call_2'), call('c3', 'call_3', 'b')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['tool-group', 'task-panel', 'tool-group']);
    // 组头的 `工具调用 × N` 必须**不含**提出去的调用 —— 靶子
    const first = blocks[0];
    if (first?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(first.entries).toHaveLength(1);
  });

  it('同轮多次 `task` 调用**只出最后一张面板**，更早的记进 `earlierCount`', () => {
    const blocks = buildRenderBlocks([taskCall('c1', 'call_1'), taskCall('c2', 'call_2'), taskCall('c3', 'call_3')], nodeIndex([]), TURN);
    const panels = blocks.filter((block) => block.kind === 'task-panel');
    expect(panels).toHaveLength(1);
    if (panels[0]?.kind !== 'task-panel') throw new Error('应为清单面板');
    expect(panels[0].cardId).toBe('c3');
    expect(panels[0].earlierCount).toBe(2);
  });

  it('`ask-user` 卡片同样提出工具组，且**不去重**（每次提问各一张）', () => {
    const blocks = buildRenderBlocks([askCall('c1', 'call_1'), askCall('c2', 'call_2')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['ask-user-card', 'ask-user-card']);
  });

  /**
   * 回归守卫：
   *
   * 装配层一度把 `AskUserInteraction.at` 写成**空串**（现已改成块的时刻，`build-model.ts` 的 `familyPayloadOf`），
   * 而「等待答复中… 12m」与固定区那枚「等待答复」徽标**都读这一格**。
   * 少了这道回填，卡片只写「等待答复中…」不带时长；更糟的是 `waitingSinceOf` 回的是 `''`，
   * `Date.parse('')` 得 NaN ⇒ 徽标恒显「等待答复 0s」且**永远不涨**——看起来像「刚问完」，把长等待读成没等。
   * 与 `task` 那一支同一口径：载荷没带时刻就用调用块的时刻。
   */
  it('`ask-user` 的空时刻用调用块的时刻回填（否则「等待了多久」恒为 0）', () => {
    const blocks = buildRenderBlocks([askCall('c1', 'call_1'), askCall('c2', 'call_2')], nodeIndex([]), TURN);
    const cards = blocks.filter((block) => block.kind === 'ask-user-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      if (card.kind !== 'ask-user-card') throw new Error('应为问答卡片');
      expect(card.interaction.at).toBe(TURN.at);
    }
    // 载荷**自己带了**时刻时不许被覆盖（回填只补空缺）
    const asked = askCall('c3', 'call_3');
    const withAt = { ...asked, tool: { family: 'ask-user', interaction: { state: 'pending', questions: [], at: '2026-10-02T09:00:00.000Z', running: true } } } as ContentBlock;
    const kept = buildRenderBlocks([withAt], nodeIndex([]), TURN).filter((block) => block.kind === 'ask-user-card');
    expect(kept[0]?.kind === 'ask-user-card' ? kept[0].interaction.at : null).toBe('2026-10-02T09:00:00.000Z');
  });

  it('族载荷缺失（`tool === null`）时该次调用**回退成普通工具行**（不消失、不空面板）', () => {
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'todo_write', 'task')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['tool-group']);
    const group = blocks[0];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    // `family` 非空但 `tool` 为 null ⇒ 通用工具行（与「适配器不认识」不是一回事）
    expect(group.entries[0]?.kind === 'call' ? group.entries[0].family : null).toBe('task');
  });
});

/**
 * 被提成卡片的调用**仍然拥有自己的结果**：`callId` 就是配对键，卡片只是那次调用的显示位。
 *
 * 不登记它们的话，同轮后到的结果在配对照里找不到主人，会落成 `orphan-result`——
 * 界面上是一组没有调用的「工具调用 × 0」展开成「孤立结果（配不上调用）」，
 * 而那条结果的主人恰恰就在它上面一张卡片里。判据是「卡片有没有把结果画出来」：
 * 画了就别再重复一行；没画（还没收场 / 收场了但原文没采到）**不许丢**，照旧独立成条。
 */
describe('buildRenderBlocks：卡片接管的调用，结果归卡片', () => {
  it('已收场的 `ask-user` 卡片：同轮的结果由卡片显示，**不再另起孤立结果**', () => {
    // 同一次调用两条结果（编排层的结算 + 厂商回显）是真实形状：两条都归卡片
    const blocks = buildRenderBlocks(
      [settledAskCall('c1', 'call_1'), result('r1', 'call_1'), result('r2', 'call_1')],
      nodeIndex([]),
      TURN,
    );
    expect(blocks.map((block) => block.kind)).toEqual(['ask-user-card']);
  });

  it('`task` 面板：同轮的结果由面板显示（`panel.result`），**不再另起孤立结果**', () => {
    const blocks = buildRenderBlocks([taskCall('c1', 'call_1'), result('r1', 'call_1')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['task-panel']);
    const [panel] = blocks;
    if (panel?.kind !== 'task-panel') throw new Error('应为清单面板');
    expect(panel.panel.result?.raw).toBe('out-r1');
  });

  it('卡片**没有**结果可显示时（还没收场），结果仍然留在时间轴上', () => {
    const blocks = buildRenderBlocks([askCall('c1', 'call_1'), result('r1', 'call_1')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['ask-user-card', 'tool-group']);
    const group = blocks[1];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries[0]?.kind === 'orphan-result' ? group.entries[0].output.text : null).toBe('out-r1');
  });

  it('**收场了但原文没采到**（`result: null`）时同样不吞掉结果', () => {
    const blocks = buildRenderBlocks([settledAskCall('c1', 'call_1', null), result('r1', 'call_1')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['ask-user-card', 'tool-group']);
  });

  it('卡片**只接管自己那次调用**：别人的结果照旧独立成条', () => {
    const blocks = buildRenderBlocks([settledAskCall('c1', 'call_1'), result('r1', 'call_9')], nodeIndex([]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['ask-user-card', 'tool-group']);
    const group = blocks[1];
    if (group?.kind !== 'tool-group') throw new Error('应为工具组');
    expect(group.entries[0]?.kind).toBe('orphan-result');
  });
});

describe('buildRenderBlocks：派发点与汇总节点', () => {
  it('`spawnedBy.callId` 命中的节点在该轮出 `subagent-bar`，且**不进工具组**', () => {
    const nodes: LogNode[] = [sessionNode('subagent:s1', { messageId: 'm1', callId: 'call_spawn', at: '2026-10-02T10:44:31.000Z' })];
    const blocks = buildRenderBlocks(
      [call('c1', 'call_spawn', 'spawn_agent'), call('c2', 'call_2', 'read_file')],
      nodeIndex(nodes),
      TURN,
    );
    // 派发条把工具组也切断了：调用在前、条在中、后面还有一个组
    expect(blocks.map((block) => block.kind)).toEqual(['tool-group', 'subagent-bar', 'tool-group']);
  });

  it('`callId` 为 null 时按 `messageId` 命中；命不中的挂在轮末而**不是**被丢掉', () => {
    const nodes: LogNode[] = [
      sessionNode('subagent:s1', { messageId: 'm1', callId: null, at: '2026-10-02T10:44:31.000Z' }),
      sessionNode('subagent:s2', { messageId: 'm1', callId: null, at: '2026-10-02T10:44:31.000Z' }),
    ];
    const blocks = buildRenderBlocks([text('t1')], nodeIndex(nodes), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'subagent-bar', 'subagent-bar']);
  });

  it('`kind: \'row\'` 的节点出 `row-summary` 而**不是** `subagent-bar`（类型上也点不进去）', () => {
    const blocks = buildRenderBlocks([text('t1')], nodeIndex([candidateNode('row-1')]), TURN);
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'row-summary']);
  });

  it('`row-summary` **只画一次**：不是第一轮时不出现（它是整个节点的事实，不是每轮的事实）', () => {
    // 冒烟实测的缺陷形状：两轮的节点上出现两句一模一样的「汇总 已完成 子任务 1 · 完成 1 · 失败 0」
    const later = buildRenderBlocks([text('t1')], nodeIndex([candidateNode('row-1')]), { ...TURN, firstTurn: false });
    expect(later.map((block) => block.kind)).toEqual(['text']);
  });
});

describe('buildRenderBlocks：只转发、不推断', () => {
  it('`assembly` 被如实带出（本函数不碰它，也不产生任何 `streaming` 判据）', () => {
    const open: ContentBlock = { ...text('t1'), assembly: 'open' };
    const blocks = buildRenderBlocks([open], nodeIndex([]), TURN);
    expect(blocks[0]?.kind === 'text' ? blocks[0].block.assembly : null).toBe('open');
  });

  it('`ToolItem.running` **只由 `LogTurn.running` 转发**（不由 output 是否存在推断）', () => {
    // 一个被中断的轮次：块停在那里，`output` 永远不来
    const blocks = buildRenderBlocks([call('c1', 'call_1', 'slow_tool')], nodeIndex([]), { ...TURN, running: false });
    const group = blocks[0];
    if (group?.kind !== 'tool-group' || group.entries[0]?.kind !== 'call') throw new Error('应为调用条目');
    // 有调用、没有结果、且轮次已结束 ⇒ **不是** 进行中（要显示「结果未采集」）
    expect(group.entries[0].running).toBe(false);
    expect(group.entries[0].output).toBeNull();
  });
});


/**
 * `inputError` 的透传（界面侧的唯一来源）：块上有它 ⇒ `ToolItem` 带出来；老账本没有这一格 ⇒ `null`。
 *
 * 变异体：把 `render-blocks.ts` 里 `inputError: block.inputError ?? null` 那一行删掉 ⇒ 第一条红。
 */
describe('工具块的 `inputError` 透传', () => {
  it('块带 inputError ⇒ ToolItem 逐字带出；不带 ⇒ null（不是空串）', () => {
    const withError = buildRenderBlocks(
      [callWithInputError('c1', 'toolu_bad', 'Unexpected token: not valid JSON')],
      nodeIndex([]),
      TURN,
    );
    const item = withError
      .flatMap((group) => (group.kind === 'tool-group' ? group.entries : []))
      .find((one): one is ToolItem => one.kind === 'call');
    expect(item?.inputError).toBe('Unexpected token: not valid JSON');

    const without = buildRenderBlocks([call('c2', 'toolu_ok', 'read')], nodeIndex([]), TURN);
    const plain = without
      .flatMap((group) => (group.kind === 'tool-group' ? group.entries : []))
      .find((one): one is ToolItem => one.kind === 'call');
    expect(plain?.inputError, '老账本/正常参数 ⇒ null，界面据此不显示任何提示').toBeNull();
  });
});
