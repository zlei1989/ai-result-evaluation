// @vitest-environment node
/**
 * pi 事件投影的口径守卫（逐条对着 `events.ts` 文件头那份口径写）。
 *
 * 判据一律取**产物**：投影交出来的 `drafts` / `messages` / `tokens` / `turns` / `failure`。
 * 刻意不断言实现里调了哪个函数——那样的守卫改一次实现就红，而缺陷照样能溜过去。
 *
 * 三条最要紧的：
 *   · **思考正文与工具结果正文必须能在 `log` 里逐字查到**（`needsMessagesForReasoningEvidence: false`
 *     的全部依据）；
 *   · **增量帧零行级事件**（一旦掉进兜底，原始输出面板会被刷成 JSON 流水，上面那条证据也就没人看得见）；
 *   · **`reasoning` 不并进 `output`**（并了就是双计，症状是「这家 tok 偏大」而且看不出来）。
 */
import { describe, expect, it } from 'vitest';
import { SubagentRecordSchema } from '@aieval/contracts';
import { createTurnState } from '../../testing/agent-fixtures';
import type { MessageDraft } from '../../message';
import { mergeTiming, type TimingSpan, type TurnProjection, type TurnState } from '../../turn';
import { createPiRunState, finalizePiSubagents, notePiStopRequest, projectPiEvent, type PiRunState } from './events';
import { PI_SUBAGENT_DISPATCH_TOOL, createPiSubagentRecorder, type PiSubagentRecorder } from './subagents';

const CONTEXT = { kind: 'pi', baseUrl: 'https://gw.example.com/v1' } as const;

/** 投影一条事件（每次都给一份干净状态时用；连续场景自己传 state） */
function project(
  raw: unknown,
  state: TurnState = createTurnState(),
  runState: PiRunState = createPiRunState(),
  subagents?: PiSubagentRecorder,
): TurnProjection {
  return projectPiEvent(raw, state, CONTEXT, runState, subagents);
}

/** 产物里的日志正文（`log` 草稿的 `text`，顺序即产出顺序） */
function logTexts(projection: TurnProjection): string[] {
  return projection.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : []));
}

/** 产物里带摘要的日志（活动行那一句） */
function summaries(projection: TurnProjection): string[] {
  return projection.drafts.flatMap((draft) => (draft.type === 'log' && draft.summary !== undefined ? [draft.summary] : []));
}

/** 一份真机形状的助手消息（缺省是「一句话答复」，用例只覆盖自己关心的格） */
function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '好的' }],
    api: 'openai-completions',
    provider: 'aieval-pi-test',
    model: 'GLM-5.3',
    usage: {
      input: 846,
      output: 12,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 11,
      totalTokens: 858,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function messageEnd(message: Record<string, unknown>): unknown {
  return { type: 'message_end', message };
}

function turnStart(): unknown {
  return { type: 'turn_start' };
}

/** 一条只有 `stopReason` 不同的助手收尾（「哪些档位不是失败」那几条用它） */
function endWithStopReason(stopReason: string): unknown {
  return messageEnd(assistantMessage({ stopReason }));
}

describe('pi 的助手快照', () => {
  it('思考正文与工具入参都进 log：整条原始负载逐字可查', () => {
    const message = assistantMessage({
      content: [
        { type: 'thinking', thinking: 'One sentence.', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: '读完了' },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'note.txt' } },
      ],
    });
    const projection = project(messageEnd(message));

    // 产物级判据：思考正文能在日志里逐字查到（不是「我们声称会落」）
    expect(logTexts(projection).some((text) => text.includes('One sentence.'))).toBe(true);
    // 答复正文另有一条人话日志（活动行取它，不给摘要）
    expect(logTexts(projection)).toContain('读完了');
    expect(summaries(projection)).toEqual([]);

    const blocks = projection.messages?.[0]?.blocks ?? [];
    expect(blocks.map((draft) => draft.block.type)).toEqual(['thinking', 'text', 'tool-call']);
    const thinking = blocks[0]?.block;
    expect(thinking?.type === 'thinking' ? thinking.text : null).toBe('One sentence.');
    expect(thinking?.type === 'thinking' ? thinking.textKind : null).toBe('full');
    // 工具入参在 pi 上已经是对象（dsh 那种 JSON 字符串才需要解析）
    const call = blocks[2]?.block;
    expect(call?.type === 'tool-call' ? call.input : null).toEqual({ path: 'note.txt' });
    expect(call?.type === 'tool-call' ? call.callId : null).toBe('call_1');
  });

  it('块序号取厂商的 contentIndex：增量与快照落进同一个槽位', () => {
    const state = createTurnState();
    project(turnStart(), state);
    // 增量帧：正文是 contentIndex 1（0 号是思考块）
    project(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: '读' } },
      state,
    );
    const snapshot = project(
      messageEnd(assistantMessage({
        content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '读完了' }],
      })),
      state,
    );
    const identities = (snapshot.messages?.[0]?.blocks ?? []).map((draft) => draft.identity);
    expect(identities).toEqual([
      { kind: 'index', index: 0 },
      { kind: 'index', index: 1 },
    ]);
  });

  it('密文思考（redacted）正文记 null、档位记 none：不拿占位串冒充全文', () => {
    const projection = project(
      messageEnd(assistantMessage({
        content: [{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true, thinkingSignature: 'cipher' }],
      })),
    );
    const block = projection.messages?.[0]?.blocks[0]?.block;
    expect(block?.type === 'thinking' ? block.text : 'x').toBeNull();
    expect(block?.type === 'thinking' ? block.textKind : 'x').toBe('none');
    expect(block?.type === 'thinking' ? block.signature : 'x').toBe('cipher');
  });

  it('raw 是当场快照：厂商对象随后被原地改写也不影响已交出的消息', () => {
    const message = assistantMessage({ content: [{ type: 'text', text: '原文' }] });
    const projection = project(messageEnd(message));
    // pi 的 `partial` 是同一个被原地 mutate 的对象 ⇒ 存引用的话这里会跟着变
    (message['content'] as Array<Record<string, unknown>>)[0]!['text'] = '被改写的';
    expect(JSON.stringify(projection.messages?.[0]?.raw)).toContain('原文');
    expect(JSON.stringify(projection.messages?.[0]?.raw)).not.toContain('被改写的');
  });

  it('答复只取 text 块：思考块不进 finalText', () => {
    const state = createTurnState();
    project(turnStart(), state);
    project(
      messageEnd(assistantMessage({
        content: [{ type: 'thinking', thinking: '这是推理，不是答复' }, { type: 'text', text: '答复' }],
      })),
      state,
    );
    expect(state.finalText).toBe('答复');
  });
});

describe('pi 的工具结果', () => {
  it('结果正文进 log，并按 callId 配对成一条工具结果消息', () => {
    const projection = project(
      {
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'read',
        isError: false,
        durationMs: 3,
        result: {
          content: [{ type: 'text', text: 'pi ticket fixture\n' }],
          details: { lines: 1 },
          structuredContent: { ignored: true },
        },
      },
      createTurnState({ turns: 1 }),
    );

    expect(logTexts(projection).some((text) => text.includes('pi ticket fixture'))).toBe(true);
    // 成功返回不给摘要（活动行保留上一句人话，结果的落点是结果块与原始输出面板）
    expect(summaries(projection)).toEqual([]);

    const message = projection.messages?.[0];
    expect(message?.role).toBe('tool');
    expect(message?.parentCallId).toBe('call_1');
    const block = message?.blocks[0]?.block;
    expect(block?.type === 'tool-result' ? block.callId : null).toBe('call_1');
    expect(block?.type === 'tool-result' ? block.text : null).toBe('pi ticket fixture\n');
    expect(block?.type === 'tool-result' ? block.structured : null).toEqual({ lines: 1 });
    expect(block?.type === 'tool-result' ? block.isError : null).toBe(false);
  });

  it('失败的结果给摘要（那是「这一行出事了」的唯一行级出口）', () => {
    const projection = project(
      {
        type: 'tool_execution_end',
        toolCallId: 'call_2',
        toolName: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'command not found' }] },
      },
      createTurnState({ turns: 1 }),
    );
    expect(summaries(projection).join('')).toContain('command not found');
    const block = projection.messages?.[0]?.blocks[0]?.block;
    expect(block?.type === 'tool-result' ? block.isError : null).toBe(true);
  });

  it('工具的部分输出刻意不投影（一帧一条事件会把原始输出面板刷成流水）', () => {
    const projection = project(
      { type: 'tool_execution_update', toolCallId: 'call_1', toolName: 'bash', partialResult: { content: 'x' } },
      createTurnState({ turns: 1 }),
    );
    expect(projection.drafts).toEqual([]);
    expect(projection.messages).toBeUndefined();
  });
});

describe('pi 的计量与轮次', () => {
  it('用量逐次往返累加，且 reasoning 不并进 output（子集不双计）', () => {
    const state = createTurnState();
    project(turnStart(), state);
    project(messageEnd(assistantMessage()), state);
    project(turnStart(), state);
    const last = project(
      messageEnd(assistantMessage({
        usage: {
          input: 36,
          output: 38,
          cacheRead: 832,
          cacheWrite: 0,
          reasoning: 3,
          totalTokens: 906,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      })),
      state,
    );

    expect(last.tokens).toEqual({
      input: 846 + 36,
      cached: 0 + 832,
      // 12 + 38：**不含** reasoning 的 11 + 3（加了就是双计）
      output: 12 + 38,
      reasoningOutput: 11 + 3,
      total: 858 + 906,
    });
  });

  it('用量读不全时给 null 并留一条 WARN：绝不填 0', () => {
    const projection = project(messageEnd(assistantMessage({ usage: { input: 1 } })));
    expect(projection.tokens).toBeNull();
    expect(logTexts(projection).some((text) => text.includes('[WARN]'))).toBe(true);
  });

  it('轮次按一次模型往返计：一次工具调用算两轮，且第二轮起手时轮次已经推进', () => {
    const state = createTurnState();
    project(turnStart(), state);
    const first = project(messageEnd(assistantMessage({ content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }], stopReason: 'toolUse' })), state);
    expect(first.turns).toBe(1);
    project(turnStart(), state);
    // 第二轮的增量帧要落到第二轮（按 message_end 计数时这里还是 1）
    const delta = project(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好' } },
      state,
    );
    expect(delta.messages?.[0]?.roundTrip).toBe(2);
    const second = project(messageEnd(assistantMessage()), state);
    expect(second.turns).toBe(2);
  });

  it('无子智能体：分量恒 {0,0,0} / 0（「确实没有」不是「没采到」）', () => {
    const projection = project(turnStart());
    expect(projection.subagentTokens).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(projection.subagentTurns).toBe(0);
    // 分量与合计同一条投影交出去（配对不变量：分量不可能比合计更清楚）
    expect(projection.turns).toBe(1);
  });

  it('还没数到任何一轮时分量与合计都不交：那个读数是自相矛盾的', () => {
    // 形状异常：助手收尾先到、`turn_start` 没到（真机上不会发生，但夹具与将来版本都可能造出来）
    const projection = project(messageEnd(assistantMessage()));
    expect(projection.turns).toBeNull();
    expect(projection.turn).toBeNull();
    expect(projection.subagentTurns).toBeUndefined();
    expect(projection.subagentTokens).toBeUndefined();
  });
});

describe('pi 的时长（只用厂商那一把尺子）', () => {
  /**
   * 两个端点与 `apiMs` 全部取自厂商消息自带的两个数：`timestamp`（请求起点）与 `durationMs`
   * （厂商从该起点量到响应收尾）⇒ `lastMs = timestamp + durationMs`，整格 `'vendor'`。
   * `ttftMs` 恒 `null`：首帧只能我们按自己的时钟测，那是另一把尺子。
   * 入参在这里定死（时刻 + 毫秒数都是合成值）：真机往返只有十几毫秒，自测的墙钟与厂商的
   * `durationMs` 在数值上几乎相等 ⇒ 把估算塞进这一格的变异体只有这组用例能确定地照出来
   * （线上那一层在 `timing.test.ts`，钉的是报了什么、来源是什么）。
   */
  it('厂商的 timestamp + durationMs → 同一把尺子的两个端点与 apiMs，ttftMs 为空', () => {
    const projection = project(messageEnd(assistantMessage({ timestamp: 1_700_000_000_000, durationMs: 250 })));
    expect(projection.timing).toEqual({
      firstMs: 1_700_000_000_000,
      lastMs: 1_700_000_000_250,
      apiMs: 250,
      ttftMs: null,
      source: 'vendor',
    });
  });

  /**
   * `durationMs` 缺席（历史消息、延迟取回的结果）：只有一个端点算不出跨度 ⇒ **不带这一格**。
   * 不拿 0、也不拿别处的时刻冒充——「算不出来」与「耗时 0」在消费方那里含义相反。
   */
  it('厂商没给 durationMs 时不带这一格（算不出来就是没采到）', () => {
    const withoutDuration = project(messageEnd(assistantMessage({ durationMs: undefined })));
    expect(withoutDuration.timing).toBeUndefined();
    // 非有限数同样按没采到处置（NaN / Infinity 不能变成事件里的一个数）
    const broken = project(messageEnd(assistantMessage({ durationMs: Number.NaN })));
    expect(broken.timing).toBeUndefined();
  });

  /**
   * 跨轮：`apiMs` 是「本行到目前为止厂商自报的模型往返时间」——与 claude 的 `duration_api_ms`
   * 同一格，口径必须是累计而不是最后一轮（只交最后一轮会让跨家对比变成两种口径）。
   */
  it('`apiMs` 逐轮累加（本行到目前为止），端点仍由骨架保留首末两点', () => {
    const state = createTurnState();
    const runState = createPiRunState();
    project(turnStart(), state, runState);
    const first = project(messageEnd(assistantMessage({ timestamp: 1_000, durationMs: 40 })), state, runState);
    expect(first.timing).toEqual({ firstMs: 1_000, lastMs: 1_040, apiMs: 40, ttftMs: null, source: 'vendor' });

    project(turnStart(), state, runState);
    const second = project(messageEnd(assistantMessage({ timestamp: 5_000, durationMs: 25 })), state, runState);
    expect(second.timing).toEqual({ firstMs: 5_000, lastMs: 5_025, apiMs: 65, ttftMs: null, source: 'vendor' });
    // 骨架按「首见即起点、再见即终点」合并 ⇒ 整行的跨度是 1_000 → 5_025，apiMs 是 65
    const merged = mergeTiming(first.timing as TimingSpan, second.timing as TimingSpan);
    expect(merged).toEqual({ firstMs: 1_000, lastMs: 5_025, apiMs: 65, ttftMs: null, source: 'vendor' });
  });
});

describe('pi 的增量帧', () => {
  it('增量只产内容消息、零行级事件', () => {
    const state = createTurnState();
    project(turnStart(), state);
    const text = project(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好' } },
      state,
    );
    expect(text.drafts).toEqual([]);
    expect(text.messages?.[0]?.chunk).toBe('delta');
    expect(text.messages?.[0]?.blocks[0]?.phase).toBe('delta');

    const thinking = project(
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: '想' } },
      state,
    );
    const block = thinking.messages?.[0]?.blocks[0]?.block;
    expect(block?.type === 'thinking' ? block.text : null).toBe('想');
    expect(thinking.drafts).toEqual([]);
  });

  it('工具入参片段与块边界帧什么都不产（权威值在快照里）', () => {
    for (const frame of [
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"path"' },
      { type: 'text_start', contentIndex: 0 },
      { type: 'text_end', contentIndex: 0, content: '好' },
      { type: 'done', reason: 'stop' },
    ]) {
      const projection = project({ type: 'message_update', assistantMessageEvent: frame }, createTurnState({ turns: 1 }));
      expect(projection.drafts, JSON.stringify(frame)).toEqual([]);
      expect(projection.messages, JSON.stringify(frame)).toBeUndefined();
    }
  });
});

describe('pi 的失败归因', () => {
  it('stopReason=error 时读 errorMessage，厂商英文短句翻成带 host 的中文原因', () => {
    const cases: Array<[string, string]> = [
      ['Connection error.', '无法连接上游'],
      ['Request timed out.', '上游请求超时'],
      ['terminated', '切断了连接'],
    ];
    for (const [original, expected] of cases) {
      const projection = project(messageEnd(assistantMessage({ stopReason: 'error', errorMessage: original })));
      expect(projection.failure?.code, original).toBe('AGENT_FAILED');
      expect(projection.failure?.message, original).toContain(expected);
      // host 与厂商原文都要在文案里（前者是路由事实，后者是排障要搜的那一句）
      expect(projection.failure?.message, original).toContain('gw.example.com');
      expect(projection.failure?.message, original).toContain(original);
    }
  });

  it('未知文案不编：带上 host 原样交出', () => {
    const projection = project(messageEnd(assistantMessage({ stopReason: 'error', errorMessage: 'boom' })));
    expect(projection.failure?.message).toContain('boom');
    expect(projection.failure?.message).toContain('gw.example.com');
  });

  it('正常档位不是失败（stop / toolUse / length 都不算）', () => {
    for (const stopReason of ['stop', 'toolUse', 'length', 'pending', 'deferred']) {
      expect(project(endWithStopReason(stopReason)).failure, stopReason).toBeNull();
    }
  });

  it('中止不是失败：本侧发过停止请求就不归因（结论由停止来源那条通路给）', () => {
    const runState = createPiRunState();
    notePiStopRequest(runState, false);
    const projection = project(
      messageEnd(assistantMessage({ stopReason: 'aborted', errorMessage: 'Request aborted' })),
      createTurnState({ turns: 1 }),
      runState,
    );
    expect(projection.failure).toBeNull();
  });

  it('厂商自己中止（本侧没发过停止请求）必须归成失败，不许静默收成 completed', () => {
    const projection = project(
      messageEnd(assistantMessage({ stopReason: 'aborted' })),
      createTurnState({ turns: 1 }),
    );
    expect(projection.failure?.code).toBe('AGENT_FAILED');
  });

  it('agent_settled.aborted 记下「谁停的」：看门狗/宿主停机与用户终止分得开', () => {
    const byWatchdog = createPiRunState();
    notePiStopRequest(byWatchdog, false);
    expect(logTexts(project({ type: 'agent_settled', aborted: true }, createTurnState({ turns: 1 }), byWatchdog)).join(''))
      .toContain('看门狗或宿主停机');

    const byUser = createPiRunState();
    notePiStopRequest(byUser, true);
    expect(logTexts(project({ type: 'agent_settled', aborted: true }, createTurnState({ turns: 1 }), byUser)).join(''))
      .toContain('用户终止');

    // 正常收场不写那句 WARN（`aborted` 是判据，不是「跑完就有」）
    const normal = logTexts(project({ type: 'agent_settled', aborted: false }, createTurnState({ turns: 1 })));
    expect(normal.join('')).not.toContain('被中止');
  });

  it('停止请求的记账：用户那一档靠 signal 翻转区分，另两档一律记成非用户发起', () => {
    const userStop = createPiRunState();
    notePiStopRequest(userStop, true);
    // 逐字段比整份状态：新加的格（派发记账、时长累计）必须显式出现在这里，不能悄悄长出来
    expect(userStop).toEqual({
      stopRequested: true,
      watchdogFired: false,
      apiMsTotal: 0,
      dispatched: false,
      dispatchNames: new Map(),
      dispatches: new Map(),
    });

    const watchdogStop = createPiRunState();
    notePiStopRequest(watchdogStop, false);
    expect(watchdogStop.stopRequested).toBe(true);
    expect(watchdogStop.watchdogFired).toBe(true);
  });
});

describe('pi 的结束信号与兜底', () => {
  it('agent_settled 才是收尾：它把最新的计量与轮次再交一次', () => {
    const state = createTurnState();
    project(turnStart(), state);
    project(messageEnd(assistantMessage()), state);
    const settled = project({ type: 'agent_settled', aborted: false }, state);
    expect(settled.turns).toBe(1);
    expect(settled.tokens?.output).toBe(12);
  });

  it('agent_end 不是结束：它后面的轮次照旧推进（auto-retry / compaction / steer 都可能跟在后面）', () => {
    const state = createTurnState();
    project(turnStart(), state);
    project(messageEnd(assistantMessage()), state);
    const afterAgentEnd = project({ type: 'agent_end', messages: [], willRetry: true }, state);
    expect(afterAgentEnd.turns).toBeNull();
    // 兜底：仍是「保留原始负载」的一条日志，不吞
    expect(logTexts(afterAgentEnd).join('')).toContain('willRetry');
    project(turnStart(), state);
    expect(project(messageEnd(assistantMessage()), state).turns).toBe(2);
  });

  it('未识别的会话事件保留原始负载（含会话级事件），身份补充不丢', () => {
    const projection = project({ type: 'queue_update', steering: ['a'], followUp: ['b'] });
    expect(logTexts(projection).join('')).toContain('queue_update');
    expect(projection.tokens).toBeNull();
    expect(projection.turns).toBeNull();
  });

  it('非助手的 message_end（system / user / toolResult）只留原始负载，不重复投影工具结果', () => {
    for (const role of ['system', 'user', 'toolResult']) {
      const projection = project(messageEnd({ role, content: [{ type: 'text', text: 'x' }] }));
      expect(projection.messages, role).toBeUndefined();
      expect(logTexts(projection).join(''), role).toContain(role);
    }
  });
});

/**
 * 子任务投影：取数路径与两条计量口径。
 *
 * 判据一律取**产物**：子任务行本身、`subagentTokens` / `subagentTurns`、以及那几条 WARN 的措辞。
 * 这里刻意不碰真实扩展——「扩展真能装上」由 `index.test.ts` 与一致性套件那条真跑场景守，
 * 本组守的是**载荷形状到行字段**那一段映射（形状取自真机实测的载荷）。
 */
describe('pi 的子任务投影', () => {
  /** 真机形状的扩展总线载荷（`subagents:completed`） */
  function completedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'agent-1',
      type: 'general-purpose',
      description: 'probe one',
      result: 'PONG',
      status: 'completed',
      toolUses: 0,
      durationMs: 981,
      usage: { input: 3052, output: 3, cacheRead: 2048, cacheWrite: 0, totalTokens: 5103, cost: { total: 0 } },
      ...overrides,
    };
  }

  /** 真机形状的 `Agent` 工具收尾事件（`details` 是交叉核对源） */
  function dispatchEnd(overrides: {
    toolCallId?: string;
    details?: Record<string, unknown>;
  } = {}): unknown {
    return {
      type: 'tool_execution_end',
      toolName: PI_SUBAGENT_DISPATCH_TOOL,
      toolCallId: overrides.toolCallId ?? 'call_1',
      isError: false,
      durationMs: 982,
      result: {
        content: [{ type: 'text', text: 'Agent completed in 1.0s (0 tool uses, 3.1k token).\n\nPONG' }],
        details: {
          displayName: 'Agent',
          description: 'probe one',
          subagentType: 'general-purpose',
          toolUses: 0,
          tokens: '3.1k token',
          turnCount: 1,
          durationMs: 981,
          status: 'completed',
          agentId: 'agent-1',
          ...overrides.details,
        },
      },
    };
  }

  function dispatchStart(args: Record<string, unknown> = {}): unknown {
    return {
      type: 'tool_execution_start',
      toolName: PI_SUBAGENT_DISPATCH_TOOL,
      toolCallId: 'call_1',
      args: { prompt: '回一句话', description: 'probe one', subagent_type: 'general-purpose', ...args },
    };
  }

  /** 跑一轮「派发 → 收场」，返回最终状态（连续场景用） */
  function runDispatch(
    recorder: PiSubagentRecorder,
    runState: PiRunState,
    state: TurnState,
  ): TurnProjection {
    project(turnStart(), state, runState, recorder);
    project(messageEnd(assistantMessage({ usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } })), state, runState, recorder);
    project(dispatchStart({ name: 'pong-agent' }), state, runState, recorder);
    return project(dispatchEnd(), state, runState, recorder);
  }

  it('行字段全部来自结构化载荷：身份 / 名字 / 状态 / 结果 / 用量，一个都不从结果文本里解析', () => {
    const recorder = createPiSubagentRecorder();
    const runState = createPiRunState();
    // 总线在工具收尾之前到达（真机就是这一次序：管理器先收场、工具再返回）
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const projection = runDispatch(recorder, runState, createTurnState());

    expect(projection.subagents).toHaveLength(1);
    const row = projection.subagents?.[0];
    expect(row).toMatchObject({
      subagentId: 'agent-1',
      // 入参里的 `name` 优先（它是模型给这一行起的名字）；没有才退回 `details.description`
      name: 'pong-agent',
      kind: PI_SUBAGENT_DISPATCH_TOOL,
      source: 'wire',
      status: 'completed',
      statusMissing: null,
      outcome: 'PONG',
      parentCallId: 'call_1',
      // 这一家的嵌套子任务恒 null（扩展只给顶层发生命周期事件）
      parentSubagentId: null,
      // 用量走与主子同一个读法：`cacheWrite` / `cost` 丢弃，三格缺一即整格 null
      usage: { input: 3052, cached: 2048, output: 3, reasoningOutput: null, total: 5103 },
    });
  });

  it('状态与结果以**总线**为准：`details` 只作交叉核对（后台档下它是派发那一刻的半截快照）', () => {
    const recorder = createPiSubagentRecorder();
    const runState = createPiRunState();
    // 总线说失败，而 `details` 说还在跑——两者不一致时不许按「好填的那个」取
    recorder.factory({
      events: {
        on: (_channel, handler) => handler(completedPayload({ status: 'error', result: '跑挂了' })),
      },
    });
    const projection = project(
      dispatchEnd({ details: { status: 'background', turnCount: null } }),
      createTurnState(),
      runState,
      recorder,
    );
    expect(projection.subagents?.[0]).toMatchObject({ status: 'failed', statusMissing: null, outcome: '跑挂了' });
  });

  it('总线上没有那一条时：状态退回 `details`，而结果与用量记 null（**不从结果文本里切答复**）', () => {
    const projection = project(dispatchEnd({ details: { status: 'background' } }), createTurnState(), createPiRunState(), createPiSubagentRecorder());
    expect(projection.subagents?.[0]).toMatchObject({
      status: 'running',
      statusMissing: null,
      // 结果正文里那句 `…\n\nPONG` 是给人看的排版文本，格式一变就会静默切到半句 ⇒ 不解析
      outcome: null,
      usage: null,
    });
  });

  it('认不出的状态记 `unknown` + 「没观察到」，绝不猜成完成', () => {
    const projection = project(
      dispatchEnd({ details: { status: 'weird-state' } }),
      createTurnState(),
      createPiRunState(),
      createPiSubagentRecorder(),
    );
    expect(projection.subagents?.[0]).toMatchObject({ status: 'unknown', statusMissing: 'not-observed' });
  });

  it('结果里没有身份时不造行，落一条点名的 WARN（拿工具调用 id 冒充身份会让派发点永远对不上）', () => {
    const projection = project(
      dispatchEnd({ details: { agentId: undefined } }),
      createTurnState(),
      createPiRunState(),
      createPiSubagentRecorder(),
    );
    expect(projection.subagents).toEqual([]);
    expect(logTexts(projection).join('')).toContain('[WARN]');
    expect(logTexts(projection).join('')).toContain('身份');
  });

  it('派发工具的收尾给活动行一句摘要（「子任务已结束：<名字>」）', () => {
    const projection = project(dispatchEnd(), createTurnState(), createPiRunState(), createPiSubagentRecorder());
    expect(summaries(projection).join('')).toContain('子任务');
  });

  it('跑动期的分量：没派发过是 `{0,0,0}` / `0`（确实没有），派发过是 `null`（有但还没采到）', () => {
    const bare = project(turnStart(), createTurnState({ turns: 0 }), createPiRunState());
    expect(bare.subagentTokens).toEqual({ input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    expect(bare.subagentTurns).toBe(0);

    const runState = createPiRunState();
    const state = createTurnState();
    project(dispatchStart(), state, runState, createPiSubagentRecorder());
    const during = project(turnStart(), state, runState, createPiSubagentRecorder());
    // 子智能体跑在自己的会话里，它的用量只在收场那一刻到达 ⇒ 跑动期唯一诚实的值是「没采到」
    expect(during.subagentTokens).toBeNull();
    expect(during.subagentTurns).toBeNull();
  });

  it('收尾：合计 = 主子 + 子，分量 = 子，且 `subagentTurns ≤ turns` 是构造上的', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const runState = createPiRunState();
    const state = createTurnState();
    runDispatch(recorder, runState, state);

    const final = finalizePiSubagents(state, runState, recorder);
    /**
     * 主子那一份：一次往返、input 100 / output 10。
     *
     * `total` 两处都是 `null`：**跨会话不相加**（两个会话各自自报的总量相加得到的是我们的算术，
     * 而契约里那一格的语义是「厂商原文」）。单会话那一份留着它的原文——子任务行自己的
     * `usage.total` 与无子智能体时的合计都不受影响。
     */
    expect(final.subagentTokens).toEqual({ input: 3052, cached: 2048, output: 3, reasoningOutput: null, total: null });
    expect(final.tokens).toEqual({ input: 3152, cached: 2048, output: 13, reasoningOutput: null, total: null });
    // 轮次 = 主子的 1 + 子智能体的 `turnCount` 1
    expect(final.subagentTurns).toBe(1);
    expect(final.turns).toBe(2);
    expect(final.subagentTurns!).toBeLessThanOrEqual(final.turns!);
    /**
     * 子任务行在**工具收尾那一步**已经交出（并把名字、状态、结果、用量一并带上）；
     * 收尾这一份与它逐字相同 ⇒ 收数器挡掉，产物里这个身份只有**一条**行。
     */
    expect(final.subagents).toEqual([]);
    expect(final.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : [])).join('')).toBe('');
  });

  it('工具收尾那一条自己就把身份 / 名字 / 状态 / 结果 / 用量交全（收尾因此没有新事实可补）', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const runState = createPiRunState();
    const state = createTurnState();
    const onToolEnd = runDispatch(recorder, runState, state);
    expect(onToolEnd.subagents?.[0]).toMatchObject({
      subagentId: 'agent-1',
      // 名字取**入参的 `name`**（模型给这一行起的名字），不是任务描述
      name: 'pong-agent',
      status: 'completed',
      outcome: 'PONG',
    });
  });

  /**
   * **合计 ≥ 分量（逐格 + 轮次）**——这条不变量是界面「主会话 = 合计 − 分量」那个减法的前提，
   * 少了它界面会算出负的主会话用量。
   *
   * 为什么 pi 这里是**相加**而不是「防双计」：子智能体跑在**另一个会话**里，父会话助手消息的
   * `usage` 覆盖不到它（真机实测：主子那一轮的读数与子任务那一条各自独立）。两份读数
   * **覆盖面不相交** ⇒ 相加是补全「这一行一共花了多少」，不是把同一笔算两遍。
   * 正好拿一个「子比主大得多」的形状来钉：若实现改回「不把子折进合计」，这一条当场红。
   */
  it('合计逐格 ≥ 分量、轮次分量 ≤ 合计轮次（界面按「主会话 = 合计 − 分量」推导的前提）', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({
      events: {
        on: (_channel, handler) => handler(completedPayload({
          // 子智能体花得比主子多（长任务派发的常态）
          usage: { input: 9000, output: 700, cacheRead: 500, cacheWrite: 0, totalTokens: 10200, cost: { total: 0 } },
        })),
      },
    });
    const runState = createPiRunState();
    const state = createTurnState();
    runDispatch(recorder, runState, state);

    const final = finalizePiSubagents(state, runState, recorder);
    const total = final.tokens!;
    const part = final.subagentTokens!;
    // 逐格：合计 − 分量恰好是主子自己那一份（input 100 / output 10 / cached 0）
    expect(total.input).toBe(part.input + 100);
    expect(total.cached).toBe(part.cached + 0);
    expect(total.output).toBe(part.output + 10);
    expect(total.input).toBeGreaterThanOrEqual(part.input);
    expect(total.cached).toBeGreaterThanOrEqual(part.cached);
    expect(total.output).toBeGreaterThanOrEqual(part.output);
    // 轮次：子那一份是合计的一部分（合计 = 主子的 turn_start 数 + 子智能体的 turnCount）
    expect(final.subagentTurns!).toBeLessThanOrEqual(final.turns!);
    expect(final.turns! - final.subagentTurns!).toBe(state.turns);
  });

  it('子智能体没收到场（后台档活过本行）⇒ 分量整格 null + 点名 WARN，合计退回主会话口径', () => {
    const recorder = createPiSubagentRecorder();
    const runState = createPiRunState();
    const state = createTurnState();
    // 派发过、但一条终态事件都没有
    runDispatch(recorder, runState, state);

    const final = finalizePiSubagents(state, runState, recorder);
    expect(final.subagentTokens).toBeNull();
    expect(final.subagentTurns).toBeNull();
    // 合计那一格**不交**（缺省 = 保持骨架里的主子口径），绝不能交出「主子 + 半个分量」
    expect(final.tokens).toBeUndefined();
    expect(final.turns).toBeUndefined();
    expect(final.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : [])).join('')).toContain('分量给不出');
  });

  it('收场了但读不出轮次（`details` 里没有 `turnCount`）⇒ 分量同样整格 null，不拿 `toolUses` 顶替', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const runState = createPiRunState();
    const state = createTurnState();
    project(turnStart(), state, runState, recorder);
    project(messageEnd(assistantMessage()), state, runState, recorder);
    project(dispatchStart(), state, runState, recorder);
    // `turnCount` 缺席 ⇒ 收尾那一条记不出轮次
    project(dispatchEnd({ details: { turnCount: undefined } }), state, runState, recorder);

    const final = finalizePiSubagents(state, runState, recorder);
    expect(final.subagentTurns).toBeNull();
    expect(final.subagentTokens).toBeNull();
  });

  it('没有派发过就不动任何计量：收尾原样返回空（一个字段都不改）', () => {
    const recorder = createPiSubagentRecorder();
    const state = createTurnState();
    project(turnStart(), state, createPiRunState(), recorder);
    const final = finalizePiSubagents(state, createPiRunState(), recorder);
    expect(final).toEqual({ drafts: [] });
  });

  it('子任务行过契约 schema（形状不对时在读侧就是一条解析失败）', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const runState = createPiRunState();
    const projection = runDispatch(recorder, runState, createTurnState());
    expect(() => SubagentRecordSchema.parse(projection.subagents?.[0])).not.toThrow();
  });

  /**
   * 同一个子智能体有**两条**投递通路：`Agent` 工具的收尾与收尾对账。
   * 两条都逐字相同地发一遍，产物里同一个身份就是两行 `subagent`（真机：同身份、同终态、同报告）。
   */
  it('收尾对账不重发工具收尾已经交过的那一行：同身份同内容只出一条', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const state = createTurnState();
    const runState = createPiRunState();
    const onToolEnd = runDispatch(recorder, runState, state);
    expect(onToolEnd.subagents).toHaveLength(1);

    const final = finalizePiSubagents(state, runState, recorder);
    // 收尾这一份与工具那一份**逐字相同** ⇒ 不再发第二条
    expect(final.subagents).toEqual([]);
  });

  it('收尾带来的新事实照发（后台档下这才第一次拿到终态与用量：补全不是重复）', () => {
    const recorder = createPiSubagentRecorder();
    const state = createTurnState();
    const runState = createPiRunState();
    // 派发那一刻总线还没说话：`details` 只给「还在跑」，故工具收尾交出去的是一条半截快照
    project(turnStart(), state, runState, recorder);
    project(messageEnd(assistantMessage({ usage: { input: 100, output: 10, cacheRead: 0, totalTokens: 110 } })), state, runState, recorder);
    project(dispatchStart(), state, runState, recorder);
    const onToolEnd = project(dispatchEnd({ details: { status: 'background', turnCount: null } }), state, runState, recorder);
    expect(onToolEnd.subagents?.[0]?.status).toBe('running');

    // 子智能体随后收场：收尾这一条带着终态与用量，必须发出去（界面靠它从「跑动中」翻成终态）
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const final = finalizePiSubagents(state, runState, recorder);
    expect(final.subagents).toHaveLength(1);
    expect(final.subagents?.[0]?.status).toBe('completed');
  });

  /**
   * 子任务的逐步骤正文只从**转写文件**来（子会话的事件不在父会话的流里）。
   * 这条从收尾的真入口走：转写读到的消息必须逐条带上子任务身份与它自己的轮次。
   */
  it('收尾把子会话转写折成子任务的消息：逐条带 subagentId，轮次是它自己的 1..N', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const state = createTurnState();
    const runState = createPiRunState();
    runDispatch(recorder, runState, state);

    const final = finalizePiSubagents(state, runState, recorder, () => ({
      messages: [
        { ...messageDraftForTranscript(1) },
        { ...messageDraftForTranscript(2) },
      ],
      warning: null,
    }));
    expect(final.messages?.map((message) => [message.subagentId, message.roundTrip])).toEqual([
      ['agent-1', 1],
      ['agent-1', 2],
    ]);
    // 读到了就不落噪声：正文取全时没有那条 WARN
    expect(logTexts({ drafts: final.drafts } as TurnProjection).some((text) => text.includes('逐步骤正文'))).toBe(false);
  });

  it('转写读不到时：正文为空 + 一条**点名**的 WARN，而结论与子任务行一个字都不改', () => {
    const recorder = createPiSubagentRecorder();
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });
    const state = createTurnState();
    const runState = createPiRunState();
    const onToolEnd = runDispatch(recorder, runState, state);

    const final = finalizePiSubagents(state, runState, recorder, () => ({
      messages: [],
      warning: '子任务 agent-1 的转写读不到（ENOENT）：这个子任务的步骤不在产物里',
    }));
    expect(final.messages).toEqual([]);
    // 子任务行照旧在产物里（正文是补充信息，缺了不影响终态：它已在工具收尾那一步交出）
    expect(onToolEnd.subagents?.[0]?.subagentId).toBe('agent-1');
    expect(final.subagentTokens).not.toBeNull();
    expect(logTexts({ drafts: final.drafts } as TurnProjection).some((text) => text.includes('逐步骤正文没取全'))).toBe(true);
  });
});

/** 一条子会话消息草稿的**最小信封**（转写投影另有用例钉形状，这里只钉收尾怎么搬运它） */
function messageDraftForTranscript(roundTrip: number): MessageDraft {
  return {
    vendorId: null,
    role: 'assistant',
    source: 'session-file',
    roundTrip,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: 'agent-1',
    chunk: 'snapshot',
    usage: null,
    blocks: [{ phase: 'snapshot', identity: { kind: 'index', index: 0 }, block: { type: 'text', text: `第 ${roundTrip} 轮` } }],
    raw: { type: 'pi-subagent-transcript' },
  };
}
