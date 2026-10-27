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
 *   · **增量帧零候选级事件**（一旦掉进兜底，原始输出面板会被刷成 JSON 流水，上面那条证据也就没人看得见）；
 *   · **`reasoning` 不并进 `output`**（并了就是双计，症状是「这家 tok 偏大」而且看不出来）。
 */
import { describe, afterEach, expect, it } from 'vitest';
import { SubagentRecordSchema } from '@aieval/contracts';
import { createTurnState } from '../../testing/agent-fixtures';
import { createFakePiChildSession } from '../../testing/pi-sdk-fixture';
import type { MessageDraft } from '../../message';
import { mergeTiming, type TimingSpan, type TurnProjection, type TurnState } from '../../turn';
import { createPiRunState, finalizePiSubagents, notePiStopRequest, projectPiEvent, type PiRunState } from './events';
import { PI_SUBAGENT_DISPATCH_TOOL, createPiSubagentRecorder, type PiSubagentRecorder } from './subagents';
import { PI_SUBAGENTS_MANAGER_KEY, PI_SUBAGENT_WIRE_TICK_TYPE, createPiSubagentWire, resetPiSubagentWireForTesting, type PiSubagentWire } from './subagent-wire';
import type { PiSubagentTranscript } from './transcript';

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
    api: 'openai-responses',
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

  it('失败的结果给摘要（那是「这个候选出事了」的唯一候选级出口）', () => {
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

  /**
   * **厂商的「冻结全 0」= 没采到，不是「0 用量」**。
   *
   * pi-ai 构造助手消息时把 `usage` 初始化成全 0，而请求失败、被中止、网关没回 usage 块这三条路
   * 都会把这份全 0 原样留在最终消息上 ⇒ 照「键在场」读会把一次失败记成「采到了：0 token」，
   * 契约（`tokens` 采不到就是 `null`）与界面读法（0 会让人得出「这家很省」）双双被违反。
   */
  it('厂商的冻结全 0 用量 ⇒ 既不给 tokens 也不给 total，并落那条「没有可读的用量」WARN', () => {
    const projection = project(messageEnd(assistantMessage({
      stopReason: 'error',
      errorMessage: 'Connection error.',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    })));
    expect(projection.tokens, '冻结全 0 被读成了「采到了 0 token」').toBeNull();
    expect(logTexts(projection).some((text) => text.includes('没有可读的用量'))).toBe(true);
  });

  /**
   * **openai 那条 wire 把缺失的推理明细补成 0**（`output_tokens_details?.reasoning_tokens || 0`），
   * anthropic 那条只在真有思考 token 时才写 ⇒ 同一份 `reasoning: 0` 在两条 wire 上是两句不同的话。
   * 判成真值会让人得出「这家不做推理」。
   */
  it('openai wire 的 reasoning=0 算「没报」；anthropic wire 的 0 照原样交', () => {
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15 };
    const openai = project(messageEnd(assistantMessage({ api: 'openai-responses', usage })));
    expect(openai.tokens?.reasoningOutput).toBeNull();
    const anthropic = project(messageEnd(assistantMessage({ api: 'anthropic-messages', usage })));
    expect(anthropic.tokens?.reasoningOutput).toBe(0);
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
   * 跨轮：投影交的是**当轮那一份** `apiMs`（厂商对「一次响应」的定义），累计由骨架的
   * `mergeTiming` 相加得出——那一层的约定就是「每条投影交增量」。
   *
   * 为什么这一条要钉死：自己在这一层累加会与骨架的相加叠成平方级偏大。真机读数（三轮各约 160 ms
   * 的网关延迟）：候选级 `apiMs` 读到 966 ms，而整行跨度 `totalMs` 只有 483 ms——比它自己装着的
   * 那段时间还长。两个断言合起来才拦得住：单条是增量、合并后是总和。
   */
  it('`apiMs` 逐条交当轮那一份（增量），累计由骨架 `mergeTiming` 相加', () => {
    const state = createTurnState();
    const runState = createPiRunState();
    project(turnStart(), state, runState);
    const first = project(messageEnd(assistantMessage({ timestamp: 1_000, durationMs: 40 })), state, runState);
    expect(first.timing).toEqual({ firstMs: 1_000, lastMs: 1_040, apiMs: 40, ttftMs: null, source: 'vendor' });

    project(turnStart(), state, runState);
    const second = project(messageEnd(assistantMessage({ timestamp: 5_000, durationMs: 25 })), state, runState);
    // 单条交 25（当轮），不是 65（累计）——累计由下面那次合并给出
    expect(second.timing).toEqual({ firstMs: 5_000, lastMs: 5_025, apiMs: 25, ttftMs: null, source: 'vendor' });
    // 骨架按「首见即起点、再见即终点」合并 ⇒ 整候选的跨度是 1_000 → 5_025，apiMs 是 40 + 25
    const merged = mergeTiming(first.timing as TimingSpan, second.timing as TimingSpan);
    expect(merged).toEqual({ firstMs: 1_000, lastMs: 5_025, apiMs: 65, ttftMs: null, source: 'vendor' });
  });
});

describe('pi 的增量帧', () => {
  it('增量只产内容消息、零候选级事件', () => {
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

  /**
   * **增量帧的 `raw` 只留这一帧的增量**，不复制厂商帧里的 `partial`。
   *
   * 判据为什么必须有：`partial` 是「到目前为止的整条助手消息」（厂商 `.d.ts` 原文 *the shared live
   * response-so-far helper*）⇒ 逐帧深拷贝它，一条几千 token 的答复就是几千次 O(长度) 拷贝，
   * 而增量消息还会被扇出到 SSE（不落盘、不参与判据）⇒ 浏览器为了拿几个字符要收整段正文。
   * 「当场快照」这条纪律由新建一个只带标量的对象满足，与「不复制 partial」不冲突。
   */
  it('增量帧不把整条 partial 复制进 raw（逐字流量的成本不许与答复长度成平方）', () => {
    const longPartial = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(4096) }] };
    const projection = project(
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好', partial: longPartial },
      },
      createTurnState({ turns: 1 }),
    );
    const raw = projection.messages?.[0]?.raw;
    expect(JSON.stringify(raw)).not.toContain('xxxx');
    expect(raw).toEqual({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '好' } });
  });
});

describe('pi 的失败归因', () => {
  /**
   * 失败归因走**两拍**：`message_end` 只把结论暂存进运行态，`agent_end(willRetry:false)` 才交给骨架。
   * 判据是「暂存那拍必须为 null」——它保的是「第一次失败、随后被厂商重试成功」不被判成失败
   * （骨架的 `failure` 一旦写入就不再清除）。
   */
  function failureAfterAgentEnd(message: unknown): TurnProjection['failure'] {
    const runState = createPiRunState();
    const staged = project(message, createTurnState({ turns: 1 }), runState);
    expect(staged.failure, '失败不应在 message_end 当场交出（会被厂商重试骗成失败）').toBeNull();
    return project({ type: 'agent_end', willRetry: false }, createTurnState({ turns: 1 }), runState).failure;
  }

  it('stopReason=error 时读 errorMessage，厂商英文短句翻成带 host 的中文原因', () => {
    const cases: Array<[string, string]> = [
      ['Connection error.', '无法连接上游'],
      ['Request timed out.', '上游请求超时'],
      ['terminated', '切断了连接'],
    ];
    for (const [original, expected] of cases) {
      const failure = failureAfterAgentEnd(messageEnd(assistantMessage({ stopReason: 'error', errorMessage: original })));
      /**
       * **自报超时必须归 `AGENT_TIMED_OUT`**（`types.ts`：「上游自己报的超时也归它」）：
       * `AGENT_FAILED` 在自动重试表里，而重试改变不了上游超时 ⇒ 那一档会被白跑两遍。
       * 另两句（连接错误 / 响应中断）仍是 `AGENT_FAILED`——它们是可重试的瞬时故障。
       */
      expect(failure?.code, original)
        .toBe(original === 'Request timed out.' ? 'AGENT_TIMED_OUT' : 'AGENT_FAILED');
      expect(failure?.message, original).toContain(expected);
      // host 与厂商原文都要在文案里（前者是路由事实，后者是排障要搜的那一句）
      expect(failure?.message, original).toContain('gw.example.com');
      expect(failure?.message, original).toContain(original);
    }
  });

  it('未知文案不编：带上 host 原样交出', () => {
    const failure = failureAfterAgentEnd(messageEnd(assistantMessage({ stopReason: 'error', errorMessage: 'boom' })));
    expect(failure?.message).toContain('boom');
    expect(failure?.message).toContain('gw.example.com');
  });

  /**
   * 厂商自动重试的那条链：失败暂存 ⇒ `agent_end.willRetry:true` 丢掉暂存 ⇒ 重试成功 ⇒ 全程无失败。
   * 真机形态（`agent-session.js`）：`message_end(stopReason:error)` → `agent_end(willRetry:true)` →
   * `auto_retry_start` → 下一条成功消息 → `auto_retry_end(success:true)` → `agent_settled`。
   */
  it('失败会被厂商重试 ⇒ 不判失败（agent_end.willRetry 是判据，auto_retry_start 是第二道）', () => {
    const runState = createPiRunState();
    project(
      messageEnd(assistantMessage({ stopReason: 'error', errorMessage: 'Connection error.' })),
      createTurnState({ turns: 1 }),
      runState,
    );
    const retried = project({ type: 'agent_end', willRetry: true }, createTurnState({ turns: 1 }), runState);
    expect(retried.failure).toBeNull();

    // 第二道：即便 agent_end 不在（队列 / 压缩路径），auto_retry_start 也把暂存清掉
    project(
      messageEnd(assistantMessage({ stopReason: 'error', errorMessage: 'Connection error.' })),
      createTurnState({ turns: 2 }),
      runState,
    );
    const started = project(
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 500, errorMessage: 'Connection error.' },
      createTurnState({ turns: 2 }),
      runState,
    );
    expect(started.failure).toBeNull();
    expect(summaries(started).join('')).toContain('厂商自动重试第 1 次/2');

    // 重试成功：成功助手消息把暂存清空，收尾无失败
    project(
      messageEnd(assistantMessage({ stopReason: 'stop' })),
      createTurnState({ turns: 3 }),
      runState,
    );
    expect(project({ type: 'agent_settled' }, createTurnState({ turns: 3 }), runState).failure).toBeNull();
  });

  it('重试用尽 ⇒ 失败照常交出，且收尾那一拍也带着它', () => {
    const runState = createPiRunState();
    project(
      messageEnd(assistantMessage({ stopReason: 'error', errorMessage: 'Connection error.' })),
      createTurnState({ turns: 1 }),
      runState,
    );
    const released = project({ type: 'agent_end', willRetry: false }, createTurnState({ turns: 1 }), runState);
    expect(released.failure?.code).toBe('AGENT_FAILED');
    expect(project({ type: 'agent_settled' }, createTurnState({ turns: 1 }), runState).failure?.code).toBe('AGENT_FAILED');
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
    const failure = failureAfterAgentEnd(messageEnd(assistantMessage({ stopReason: 'aborted' })));
    expect(failure?.code).toBe('AGENT_FAILED');
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
    // 逐字段比整份状态：新加的格（派发记账、转写增量记账、wire 载体去重）必须显式出现在这里，不能悄悄长出来
    expect(userStop).toEqual({
      stopRequested: true,
      pendingFailure: null,
      structuredRejections: 0,
      selfAborted: false,
      watchdogFired: false,
      dispatched: false,
      dispatchStarts: new Map(),
      unclaimedWarned: new Set(),
      dispatches: new Map(),
      transcriptEmitted: new Map(),
      transcriptReadAt: new Map(),
      subagentCarriers: new Set(),
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

  /**
   * 合成帧（`subagent-wire.ts` 的泵塞进事件流的那一帧）是**我们自己造的**，不是厂商事件：
   * 它一个字的正文都没有，存在的全部意义是换一次排空。漏判它就会掉进上一条的兜底分支，
   * 把「未识别的厂商载荷」按子会话的事件密度刷满原始输出面板。
   */
  it('wire 的合成帧投影成空：不落日志、不动计量，更不当成未识别载荷', () => {
    const projection = project({ type: PI_SUBAGENT_WIRE_TICK_TYPE });
    expect(logTexts(projection).join('')).toBe('');
    expect(projection.drafts).toEqual([]);
    expect(projection.tokens).toBeNull();
    expect(projection.turns).toBeNull();
    expect(projection.failure).toBeNull();
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

  function dispatchStart(args: Record<string, unknown> = {}, toolCallId = 'call_1'): unknown {
    return {
      type: 'tool_execution_start',
      toolName: PI_SUBAGENT_DISPATCH_TOOL,
      toolCallId,
      args: { prompt: '回一句话', description: 'probe one', subagent_type: 'general-purpose', ...args },
    };
  }

  /**
   * 真机形状的扩展总线载荷（`subagents:started`）：扩展只发这三格（`src/index.ts` 的 onStart 分支），
   * **没有工具调用 id** —— 派发行与那次调用对账靠的就是这里的 `description`。
   */
  function startedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { id: 'agent-1', type: 'general-purpose', description: 'probe one', ...overrides };
  }

  /**
   * 可**后置触发**的假总线：真机里总线事件与父会话事件流没有先后保证，而「注册即触发」的假件
   * 造不出「先派发、后收场」的时序（现有用例里那几种形状也都要它）。
   */
  function bus(): { recorder: PiSubagentRecorder; emit: (channel: string, payload: unknown) => void } {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const recorder = createPiSubagentRecorder();
    recorder.factory({
      events: {
        on: (channel, handler) => handlers.set(channel, [...(handlers.get(channel) ?? []), handler]),
      },
    });
    return {
      recorder,
      emit: (channel, payload) => {
        for (const handler of handlers.get(channel) ?? []) handler(payload);
      },
    };
  }

  /** 一条与工具调用无关的会话事件（派发的挂靠点就是「任意下一个事件」，用它来推一拍） */
  function unrelatedEvent(): unknown {
    return { type: 'tool_execution_update', toolCallId: 'call_other', toolName: 'read_file', partialResult: {} };
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
      // 入参里的 `name` 优先（它是模型给这个候选起的名字）；没有才退回 `details.description`
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

  /**
   * **派发那一刻的子任务行**。
   *
   * 为什么这条是这一组里最要紧的：这一家前台档的 `Agent` 是**阻塞工具**（子智能体跑完才返回），
   * 只靠工具收尾那条通路的话，派发到收场之间界面上**没有节点、没有卡片、也没有「进入」入口**
   * ——而另三家都在派发时投一条 `running` 行。判据取的是那份产物形状，不是「调了哪个函数」。
   */
  it('派发那一刻就投一条 `running` 行：身份取总线、派发点取那次工具调用、用量与结果记未采集', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(turnStart(), state, runState, recorder);
    project(dispatchStart({ name: 'pong-agent' }), state, runState, recorder);
    // 真机时序：总线那条晚于工具调用开始 ⇒ 由**下一个**事件把派发行带出去
    emit('subagents:started', startedPayload());
    const during = project(unrelatedEvent(), state, runState, recorder);

    expect(during.subagents).toHaveLength(1);
    expect(during.subagents?.[0]).toMatchObject({
      subagentId: 'agent-1',
      // 名字取入参的 `name`（与收尾那条同一条回落链，界面不会在收尾那一刻换标题）
      name: 'pong-agent',
      kind: PI_SUBAGENT_DISPATCH_TOOL,
      source: 'wire',
      status: 'running',
      statusMissing: null,
      outcome: null,
      parentCallId: 'call_1',
      parentSubagentId: null,
      usage: null,
    });
    // 这一条必须能过契约：界面按它建节点、按 `parentCallId` 定位派发点
    expect(SubagentRecordSchema.safeParse(during.subagents?.[0]).success).toBe(true);
  });

  it('同一次派发只出一条 `running` 行（派发挂在每个事件上，逐字相同的重发由收数器挡掉）', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(dispatchStart(), state, runState, recorder);
    emit('subagents:started', startedPayload());
    expect(project(unrelatedEvent(), state, runState, recorder).subagents).toHaveLength(1);
    expect(project(unrelatedEvent(), state, runState, recorder).subagents ?? []).toEqual([]);
    expect(project(unrelatedEvent(), state, runState, recorder).subagents ?? []).toEqual([]);
  });

  it('描述撞名（两条在飞的派发同名）时**不认领、不投**，落一条点名的 WARN 且只落一次', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(dispatchStart({}, 'call_a'), state, runState, recorder);
    project(dispatchStart({}, 'call_b'), state, runState, recorder);
    emit('subagents:started', startedPayload());
    const first = project(unrelatedEvent(), state, runState, recorder);

    expect(first.subagents ?? []).toEqual([]);
    expect(logTexts(first).join('')).toContain('[WARN]');
    expect(logTexts(first).join('')).toContain('派发时刻');
    // 挂靠点在每个事件上：同一条 WARN 不许跟着刷
    expect(logTexts(project(unrelatedEvent(), state, runState, recorder)).join('')).toBe('');
  });

  it('总线已报终态的身份不投 `running` 行（那会让状态从终态退回运行中）', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(dispatchStart(), state, runState, recorder);
    emit('subagents:started', startedPayload());
    emit('subagents:completed', completedPayload());

    expect(project(unrelatedEvent(), state, runState, recorder).subagents ?? []).toEqual([]);
    // 终态那条照旧由工具收尾交出去（完整快照）
    expect(project(dispatchEnd(), state, runState, recorder).subagents?.[0]).toMatchObject({ status: 'completed' });
  });

  /**
   * **同一批次里的顺序与「不补多余行」**。
   *
   * 两个同时在飞的派发：一个收尾、另一个刚报「开始」——同一批产物里必须**先派发行、后收尾行**
   * （反过来的话，界面按身份覆盖会先把状态推到终态、再退回运行中）。
   * 另一半判据是**同身份的收尾那条在场时不再补派发行**：那一条本身就是完整快照。
   *
   * 这一档的时序不是假想的：总线的 `completed` 与工具收尾是两条通路，两者之间没有先后保证。
   */
  it('同一批次里派发行排在收尾行之前；同身份已经收尾时不再补派发行', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(dispatchStart({}, 'call_1'), state, runState, recorder);
    project(dispatchStart({ description: 'probe two' }, 'call_2'), state, runState, recorder);
    // 第二个派发刚报「开始」；第一个的收尾与它落在同一个投影里
    emit('subagents:started', startedPayload({ id: 'agent-2', description: 'probe two' }));

    const batch = project(dispatchEnd(), state, runState, recorder);
    expect(batch.subagents?.map((record) => [record.subagentId, record.status])).toEqual([
      ['agent-2', 'running'],
      ['agent-1', 'completed'],
    ]);

    // 同身份那一条收尾在场时，派发行不补：单独跑一遍，产物里只有收尾那条
    const { recorder: solo, emit: emitSolo } = bus();
    const soloRun = createPiRunState();
    project(dispatchStart({ name: 'pong-agent' }), state, soloRun, solo);
    emitSolo('subagents:started', startedPayload());
    const atEnd = project(dispatchEnd(), state, soloRun, solo);
    expect(atEnd.subagents?.map((record) => record.status)).toEqual(['completed']);
    expect(atEnd.subagents?.[0]).toMatchObject({
      subagentId: 'agent-1',
      // 名字与派发行同一条回落链：界面不会在收尾那一刻换标题
      name: 'pong-agent',
      parentCallId: 'call_1',
    });
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
      // 名字取**入参的 `name`**（模型给这个候选起的名字），不是任务描述
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
   * **覆盖面不相交** ⇒ 相加是补全「这个候选一共花了多少」，不是把同一笔算两遍。
   * 正好拿一个「子比主大得多」的形状来钉：若实现改回「不把子折进合计」，这一条当场红。
   */
  it('合计逐格 ≥ 分量、步数分量 ≤ 合计步数（界面按「主会话 = 合计 − 分量」推导的前提）', () => {
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

  it('子智能体没收到场（候选收尾时它还没跑完）⇒ 两格都 null + 逐格点名 WARN，合计退回主会话口径', () => {
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
    const logs = final.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : [])).join('');
    // 逐格点名：哪一格缺（用量 / 轮次）与为什么缺（候选的释放序列终结了它）都要读得出来
    expect(logs).toContain('子智能体用量给不出');
    expect(logs).toContain('子智能体步数给不出');
    expect(logs).toContain('本次运行的释放序列会连同它一起终结');
  });

  /**
   * **派发记录缺失时按格处置，并按总线身份补终态行**。
   *
   * `runState.dispatches` 只在 `Agent` 工具的收尾结果带得出 `details.agentId` 时才登记，而
   * `runState.dispatched` 在 `tool_execution_start` 上就置真：工具收尾交的是**厂商自己合成的裸错误**
   * （`Operation aborted` / 工具不存在那一档，没有 `details`）时两者就分家。对账集合取
   * 「派发记录 ∪ 总线身份」——**用量**那一格来自总线终态载荷，照旧交得出；**轮次**只在
   * `details.turnCount` 里，这一档没有来源 ⇒ 记 `null` 并点名。绝不能整个集合求和成
   * `{0,0,0}` / `0`（＝「确实没有子智能体」，与事实相反）。
   */
  it('派发记录缺失（工具结果里没有身份）⇒ 用量照交、轮次 null + 点名 WARN，并给总线报过终态的身份补一条终态行', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(turnStart(), state, runState, recorder);
    project(messageEnd(assistantMessage({ usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } })), state, runState, recorder);
    project(dispatchStart({ name: 'pong-agent' }), state, runState, recorder);
    // 总线报「开始」与终态，但工具收尾的结果里**没有 `details`**
    emit('subagents:started', startedPayload());
    emit('subagents:completed', completedPayload());
    project(
      {
        type: 'tool_execution_end',
        toolName: PI_SUBAGENT_DISPATCH_TOOL,
        toolCallId: 'call_1',
        isError: true,
        result: { content: [{ type: 'text', text: 'Operation aborted' }] },
      },
      state,
      runState,
      recorder,
    );
    expect(runState.dispatches.size, '这一档本来就不该登记派发记录').toBe(0);

    const final = finalizePiSubagents(state, runState, recorder);
    // 用量那一格：总线终态载荷里有它 ⇒ 交出来（不是 {0,0,0}，也不是 null）
    expect(final.subagentTokens).toEqual({ input: 3052, cached: 2048, output: 3, reasoningOutput: null, total: null });
    expect(final.subagentTurns).toBeNull();
    const logs = final.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : [])).join('');
    expect(logs, '承诺的点名 WARN 缺席').toContain('子智能体步数给不出');
    expect(logs, 'WARN 要点名是哪个身份缺记录').toContain('agent-1');
    // 总线报过终态的身份要拿到它那条终态行：否则界面上的卡片永远停在「运行中」
    expect(final.subagents?.map((record) => [record.subagentId, record.status])).toEqual([['agent-1', 'completed']]);
  });

  /**
   * **后台档的结构性缺口**（真机形状：真网关派一个 `run_in_background: true` 的子智能体，它在候选
   * 收尾前就 `completed`、终态候选的 `usage` 读得到，而 `Agent` 工具的收尾快照里没有轮次）。
   *
   * 两件事要同时成立：① 用量那一格**不能**跟着轮次一起作废（那是「给不出」，而它确实花掉了一整轮
   * 输入）；② 文案不能指向另一件事（它已收场，说「活过了本次运行」会让排障的人去查一个不存在的问题）。
   */
  it('后台档收场了但拿不到轮次：用量照交、轮次 null，点名文案不许说「活过了本次运行」', () => {
    const recorder = createPiSubagentRecorder();
    const state = createTurnState();
    const runState = createPiRunState();
    project(turnStart(), state, runState, recorder);
    project(messageEnd(assistantMessage({ usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } })), state, runState, recorder);
    project(dispatchStart(), state, runState, recorder);
    // 后台档：工具派发那一刻状态是 background ⇒ 收尾记录刻意把轮次记 null（半截的数不是读数）
    project(dispatchEnd({ details: { status: 'background', turnCount: null } }), state, runState, recorder);
    // 子智能体随后收场：总线终态带上用量（与真机读数同形）
    recorder.factory({ events: { on: (_channel, handler) => handler(completedPayload()) } });

    const final = finalizePiSubagents(state, runState, recorder);
    expect(final.subagentTokens, '用量读得到就必须交出来，不许被轮次那一格连坐').toEqual({
      input: 3052,
      cached: 2048,
      output: 3,
      reasoningOutput: null,
      total: null,
    });
    expect(final.subagentTurns).toBeNull();
    // 合计带上分量（`subagentTokens ≤ tokens` 的前提），轮次那一格仍不交（保持主会话口径）
    expect(final.tokens).toEqual({ input: 3152, cached: 2048, output: 13, reasoningOutput: null, total: null });
    expect(final.turns).toBeUndefined();
    const logs = final.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : [])).join('');
    expect(logs).toContain('后台档');
    expect(logs, '它已经收场了，说「活过了本次运行」会把排障指向错误的方向').not.toContain('活过了本次运行');
    expect(logs, '用量那一格交得出，就不该有为它而落的那条 WARN').not.toContain('子智能体用量给不出');
  });

  it('收场了但读不出轮次：轮次记 null、用量照交，不拿 `toolUses` 或 0 顶替', () => {
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
    // 拿 0 / `toolUses` 顶替会让「没采到」变成「确实是 0 轮」——两句话含义相反
    expect(final.subagentTurns).toBeNull();
    // 用量那一格与轮次无关：总线终态载荷里读得到就交得出
    expect(final.subagentTokens).not.toBeNull();
  });

  it('没有派发过就不动任何计量：收尾原样返回空（一个字段都不改）', () => {
    const recorder = createPiSubagentRecorder();
    const state = createTurnState();
    project(turnStart(), state, createPiRunState(), recorder);
    const final = finalizePiSubagents(state, createPiRunState(), recorder);
    expect(final).toEqual({ drafts: [] });
  });

  /**
   * **收尾那一份快照不许把状态从「运行中」改写成「未知」**（后台档的形状）。
   *
   * 后台派发（`run_in_background` 缺省 `true`）下总线只报得起 `subagents:started`
   * （它**没有** `status` 字段），而收尾对账读的正是 `latest()` 那一条 ⇒ 只读总线的实现会把
   * 派发时已经投出去的 `running` 行覆盖成 `unknown`。那是与「从终态退回运行中」同类的**倒退**，
   * 只是方向相反：把「已知在跑」说成「不知道」，界面上子任务卡片的那一格凭空变灰。
   *
   * 修法不是「有总线就不看派发」，而是**沿用在飞派发已经记下的状态**：`Agent` 工具的收尾快照里
   * 写着 `background` ⇒ `piSubagentStatus` 映成 `running`，收尾快照沿用它。
   */
  it('后台档（总线只报 started）⇒ 收尾快照如实记「已停止」（被候选释放序列终结），不降级成 unknown', () => {
    const { recorder, emit } = bus();
    const runState = createPiRunState();
    const state = createTurnState();
    project(turnStart(), state, runState, recorder);
    project(messageEnd(assistantMessage()), state, runState, recorder);
    // 模型省略 run_in_background ⇒ 扩展的缺省是「派发即分离」，工具的收尾快照状态是 background
    project(dispatchStart({ description: 'probe one' }), state, runState, recorder);
    const atDispatch = project(
      // `agentId` 必须在（派发记录按它登记）；只把状态与轮次换成后台档的形状
      dispatchEnd({ details: { agentId: 'agent-1', status: 'background', turnCount: undefined } }),
      state,
      runState,
      recorder,
    );
    // 派发那一刻投出去的那条候选就是 `running`（工具收尾通路，见 `projectDispatchEnd`）
    expect(atDispatch.subagents?.map((record) => record.status), '派发那一刻就该是运行中').toEqual(['running']);
    // 总线晚一步报「开始」，此后**没有**终态事件（候选收尾会终结这个子会话）
    emit('subagents:started', startedPayload());

    const final = finalizePiSubagents(state, runState, recorder);
    /**
     * 收尾这一份快照**必须**与派发那一份不同：它把「运行中」如实改成**已停止**——候选的释放序列
     * 会连同这个子会话一起终结（真机 `dispose-only` 一臂即足以让它一个模型往返都跑不起来）。
     * 变异体：把状态改回沿用派发的 `background` ⇒ 这里又变回空数组（界面永远停在「运行中」），
     * 或者改成 `unknown` ⇒ 那是从「已知在跑」退回「不知道」的倒退，同样当场红。
     */
    expect(final.subagents?.map((record) => [record.subagentId, record.status])).toEqual([['agent-1', 'stopped']]);
    // 分量与轮次仍然只能记 null（它没跑完，读数本来就不存在），但「为什么」必须点出来
    expect(final.subagentTokens).toBeNull();
    expect(final.subagentTurns).toBeNull();
    const logs = final.drafts.flatMap((draft) => (draft.type === 'log' ? [draft.text] : [])).join('');
    /**
     * 文案的判据是**机制**：候选的释放序列（`session.dispose()` → 扩展运行器作废）会把这个子会话
     * 一起终结——真机五档对照里 `dispose-only` 那一臂就足以让它一个模型往返都跑不起来。
     * 写成「活过了本次运行」会把排障指向「它还在后台跑」，而事实是它已经死了。
     */
    expect(logs, 'WARN 要说清是候选的释放序列终结了它，不是一句「活过了本次运行」')
      .toContain('本次运行的释放序列会连同它一起终结');
    expect(logs).not.toContain('活过了本次运行');
    expect(logs).toContain('background');
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

  describe('跑动期增量：转写在执行中逐轮跟出（不再等收尾一次性涌出）', () => {
    /** 带读口的投影（`project` 那一件不收读口；这里直接走全参入口） */
    const projectWith = (
      raw: unknown,
      agent: { state: TurnState; runState: PiRunState; recorder: PiSubagentRecorder },
      readTranscript?: (agentId: string) => PiSubagentTranscript,
    ): TurnProjection =>
      projectPiEvent(raw, agent.state, CONTEXT, agent.runState, agent.recorder, undefined, readTranscript);

    /**
     * 跑到「总线已报 started、派发已登记、子任务行还没落账」的那一刻——
     * 下一批事件就是行落账的那一批（增量从这里开始才有资格跟出）。
     */
    function armedAgent(): {
      state: TurnState;
      runState: PiRunState;
      recorder: PiSubagentRecorder;
      emit: (channel: string, payload: unknown) => void;
    } {
      const harness = bus();
      const state = createTurnState();
      const runState = createPiRunState();
      project(turnStart(), state, runState, harness.recorder);
      project(dispatchStart(), state, runState, harness.recorder);
      harness.emit('subagents:started', startedPayload());
      return { state, runState, recorder: harness.recorder, emit: harness.emit };
    }

    /** 可增长的假转写：`content` 是当前已 flush 的消息（只增不改，与真文件同纪律），`calls` 记读盘次数 */
    function fakeTranscript(initial: MessageDraft[]): {
      read: (agentId: string) => PiSubagentTranscript;
      content: MessageDraft[];
      calls: () => number;
    } {
      let calls = 0;
      const content = [...initial];
      const read = (): PiSubagentTranscript => {
        calls += 1;
        return { messages: content, warning: null };
      };
      return { content, calls: () => calls, read };
    }

    /** 把节流拨回「可以再读」：不引 fake timers，直接把上次读盘时刻拨出窗外 */
    const rewindThrottle = (runState: PiRunState): void => {
      runState.transcriptReadAt.set('agent-1', Date.now() - 60_000);
    };

    it('子任务行落账的那一批不带增量，下一批才跟出（骨架先发消息后发行，同批混发会让消息先于行进账、掉进主会话）', () => {
      const agent = armedAgent();
      const fake = fakeTranscript([messageDraftForTranscript(1)]);
      const candidateBatch = projectWith(unrelatedEvent(), agent, fake.read);
      // 行在这一批投出（running）；闸门按「更早一批」判 ⇒ 这一批连读都没读
      expect(candidateBatch.subagents?.map((row) => row.status)).toEqual(['running']);
      expect(candidateBatch.messages ?? []).toHaveLength(0);
      expect(fake.calls()).toBe(0);
      const next = projectWith(unrelatedEvent(), agent, fake.read);
      expect(next.messages?.map((message) => [message.subagentId, message.roundTrip])).toEqual([['agent-1', 1]]);
      expect(fake.calls()).toBe(1);
    });

    it('只投新增的那一段：转写长出来一轮投一轮，已投过的不再投', () => {
      const agent = armedAgent();
      projectWith(unrelatedEvent(), agent); // 行落账（这一批不需要读口）
      const fake = fakeTranscript([messageDraftForTranscript(1), messageDraftForTranscript(2)]);
      const first = projectWith(unrelatedEvent(), agent, fake.read);
      expect(first.messages?.map((message) => message.roundTrip)).toEqual([1, 2]);
      // 转写又 flush 了一轮：前两轮逐字不变、第三轮是新的 ⇒ 只投第三轮
      fake.content.push(messageDraftForTranscript(3));
      rewindThrottle(agent.runState);
      const second = projectWith(unrelatedEvent(), agent, fake.read);
      expect(second.messages?.map((message) => message.roundTrip)).toEqual([3]);
    });

    it('读盘按身份节流：间隔内的下一批事件不再读（flush 粒度本来就是秒级的 turn_end）', () => {
      const agent = armedAgent();
      projectWith(unrelatedEvent(), agent); // 行落账
      const fake = fakeTranscript([messageDraftForTranscript(1)]);
      projectWith(unrelatedEvent(), agent, fake.read); // 读 1 次、投 1 条
      const within = projectWith(unrelatedEvent(), agent, fake.read);
      expect(fake.calls()).toBe(1);
      expect(within.messages ?? []).toHaveLength(0);
    });

    it('总线已报终态的身份不再增量（尾巴归收尾对账补）：读口一次都不叫', () => {
      const agent = armedAgent();
      projectWith(unrelatedEvent(), agent); // 行落账
      agent.emit('subagents:completed', completedPayload());
      const fake = fakeTranscript([messageDraftForTranscript(1)]);
      const batch = projectWith(unrelatedEvent(), agent, fake.read);
      expect(fake.calls()).toBe(0);
      expect(batch.messages ?? []).toHaveLength(0);
    });

    it('没有子任务行的身份不读也不投：认领不上时宁可晚一批，也不让消息先于行进账', () => {
      const harness = bus();
      const state = createTurnState();
      const runState = createPiRunState();
      project(dispatchStart(), state, runState, harness.recorder);
      // 描述与在飞的派发对不上 ⇒ 认领失败 ⇒ 没有行（这一档由工具收尾那条通路兜底）
      harness.emit('subagents:started', startedPayload({ description: '与在飞派发对不上的描述' }));
      const fake = fakeTranscript([messageDraftForTranscript(1)]);
      const batch = projectWith(unrelatedEvent(), { state, runState, recorder: harness.recorder }, fake.read);
      expect(fake.calls()).toBe(0);
      expect(batch.messages ?? []).toHaveLength(0);
    });

    it('收尾对账只补差量：跑动期投过的不再投，收场后 flush 的尾巴在这里落地', () => {
      const agent = armedAgent();
      projectWith(unrelatedEvent(), agent); // 行落账
      const fake = fakeTranscript([messageDraftForTranscript(1), messageDraftForTranscript(2)]);
      projectWith(unrelatedEvent(), agent, fake.read); // 增量投了 1、2 两轮
      agent.emit('subagents:completed', completedPayload());
      projectWith(dispatchEnd(), agent, fake.read); // 工具收尾：dispatches 记账、completed 行落账
      // 收场之后转写又 flush 了一轮 ⇒ 收尾只补第 3 轮（1、2 已在账上）
      fake.content.push(messageDraftForTranscript(3));
      const final = finalizePiSubagents(agent.state, agent.runState, agent.recorder, fake.read);
      expect(final.messages?.map((message) => message.roundTrip)).toEqual([3]);
    });
  });

  describe('wire 通道：子会话事件不经转写文件直接跟出（source: wire，无补录角标）', () => {
    /** 假子会话与键常量取共享夹具（`pi-sdk-fixture.ts` 的 `createFakePiChildSession`） */
    const fakeChildSession = createFakePiChildSession;

    /** 子会话的助手收尾（最小形状：内容块进消息，用量可缺） */
    const childAssistantEnd = (text: string): unknown => ({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

    /** 真机形状的子会话**逐字增量**帧（与主会话 `message_update` 同构） */
    const childTextDelta = (delta: string, contentIndex = 0): unknown => ({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex, delta },
    });

    /** 固定内容的假转写（本组只关心「同一条消息到没到」，读盘计数那套在上一组） */
    const transcriptReader = (messages: MessageDraft[]): ((agentId: string) => PiSubagentTranscript) => {
      const content = [...messages];
      return () => ({ messages: content, warning: null });
    };

    /**
     * **产品形态的接线**：收数器的 started / 终态钩子直连 wire（`index.ts` 同一条线），
     * registry 条目在「reload」里挂上（真实 claim 点）。返回的 `emit` 是扩展总线。
     */
    async function wiredBus(session: unknown, messages: unknown[] = []): Promise<{
      state: TurnState;
      runState: PiRunState;
      recorder: PiSubagentRecorder;
      wire: PiSubagentWire;
      emit: (channel: string, payload: unknown) => void;
    }> {
      const handlers = new Map<string, Array<(payload: unknown) => void>>();
      const wire = createPiSubagentWire();
      const recorder = createPiSubagentRecorder({
        onStarted: (agentId) => wire.onStarted(agentId),
        onSettled: (agentId) => wire.onSettled(agentId),
      });
      recorder.factory({
        events: {
          on: (channel, handler) => handlers.set(channel, [...(handlers.get(channel) ?? []), handler]),
        },
      });
      const child = session ?? fakeChildSession([], messages);
      await wire.reload(async () => {
        (globalThis as Record<symbol, unknown>)[PI_SUBAGENTS_MANAGER_KEY] = {
          getRecord: (id: string) => (id === 'agent-1' ? { session: child } : undefined),
        };
      });
      const state = createTurnState();
      const runState = createPiRunState();
      project(turnStart(), state, runState, recorder);
      project(dispatchStart(), state, runState, recorder);
      const emit = (channel: string, payload: unknown): void => {
        for (const handler of handlers.get(channel) ?? []) handler(payload);
      };
      return { state, runState, recorder, wire, emit };
    }

    /** 带 wire 的投影（第 8 参；转写读口与 wire 可同批共存） */
    const projectWire = (
      raw: unknown,
      agent: { state: TurnState; runState: PiRunState; recorder: PiSubagentRecorder },
      wire: PiSubagentWire,
    ): TurnProjection =>
      projectPiEvent(raw, agent.state, CONTEXT, agent.runState, agent.recorder, undefined, undefined, wire);

    afterEach(() => {
      resetPiSubagentWireForTesting();
    });

    it('总线报 started 即订阅：子会话事件折成 wire 消息（盖 subagentId、来源 wire、轮次自 1 起）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      session.emit(childAssistantEnd('子任务第一步'));
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账的那一批（闸门按「更早一批」判）
      const next = projectWire(unrelatedEvent(), agent, agent.wire);
      expect(next.messages?.map((message) => [message.subagentId, message.source, message.roundTrip]))
        .toEqual([['agent-1', 'wire', 1]]);
    });

    it('行落账的那一批不带 wire 消息（骨架先发消息后发行，同批混发会把消息先于行记进主会话）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      session.emit(childAssistantEnd('子任务第一步'));
      const candidateBatch = projectWire(unrelatedEvent(), agent, agent.wire);
      expect(candidateBatch.subagents?.map((row) => row.status)).toEqual(['running']);
      expect(candidateBatch.messages ?? []).toHaveLength(0);
    });

    it('行还没落账的身份：事件留在缓冲等下一批（wire 是一次性的，不像转写可以重读——不丢是硬要求）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      session.emit(childAssistantEnd('还在等行落账'));
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      const next = projectWire(unrelatedEvent(), agent, agent.wire);
      expect(next.messages?.map((message) => message.roundTrip)).toEqual([1]);
      // 再排是空的：缓冲已消费，不重放
      expect(projectWire(unrelatedEvent(), agent, agent.wire).messages ?? []).toHaveLength(0);
    });

    it('载体去重（wire 先到）：转写随后给出同一条消息时整条滤掉，账本不留双份', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      session.emit(childAssistantEnd('同一条消息'));
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      projectWire(unrelatedEvent(), agent, agent.wire); // wire 投出 agent-1|1|assistant|-
      // 转写此时才 flush 同一条（轮次同源 ⇒ 载体键相同）
      const read = transcriptReader([messageDraftForTranscript(1)]);
      const viaTranscript = projectPiEvent(
        unrelatedEvent(), agent.state, CONTEXT, agent.runState, agent.recorder, undefined, read, agent.wire,
      );
      expect(viaTranscript.messages ?? []).toHaveLength(0);
    });

    it('载体去重（转写先到）：wire 随后给出同一条消息时同样滤掉（先到者胜出是对称的）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      const read = transcriptReader([messageDraftForTranscript(1)]);
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      // 转写先投（wire 还没产过事件）
      const viaTranscript = projectPiEvent(
        unrelatedEvent(), agent.state, CONTEXT, agent.runState, agent.recorder, undefined, read, agent.wire,
      );
      expect(viaTranscript.messages?.map((message) => message.source)).toEqual(['session-file']);
      session.emit(childAssistantEnd('转写已经投过的同一条'));
      const viaWire = projectWire(unrelatedEvent(), agent, agent.wire);
      expect(viaWire.messages ?? []).toHaveLength(0);
    });

    /**
     * **逐字增量**那一组：子会话的 delta 帧要能一路到消息流，且**不与它自己的收尾快照互相吃掉**。
     *
     * 这是去重键那一格的靶子：载体键只有「身份 + 轮次 + role + parentCallId」四格，
     * delta 与随后的 snapshot **键相同** ⇒ 按载体去重会让先到的 delta 占死键、真正的收尾快照
     * 被整条丢掉（消息永远停在半截）。判据取产物：两种 chunk 都要出得来，顺序是 delta 在前。
     */
    it('子会话的 delta 帧照常投出，且不挡住它自己的收尾快照（去重按载体 + 快照语义，不是按载体）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      session.emit(childTextDelta('第一'));
      session.emit(childTextDelta('步'));
      const deltas = projectWire(unrelatedEvent(), agent, agent.wire);
      expect(deltas.messages?.map((message) => [message.chunk, message.source, message.subagentId, message.roundTrip]))
        .toEqual([
          ['delta', 'wire', 'agent-1', 1],
          ['delta', 'wire', 'agent-1', 1],
        ]);
      // 同一轮的收尾快照**必须照样出得来**（它与上面两条 delta 的载体键逐字相同）
      session.emit(childAssistantEnd('第一步'));
      const snapshot = projectWire(unrelatedEvent(), agent, agent.wire);
      expect(snapshot.messages?.map((message) => [message.chunk, message.roundTrip])).toEqual([['snapshot', 1]]);
    });

    it('delta 不占死载体：转写随后给出同一轮的快照时照样放行（兜底通道不被 delta 挡掉）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      session.emit(childTextDelta('半截'));
      expect(projectWire(unrelatedEvent(), agent, agent.wire).messages).toHaveLength(1);
      // wire 只给过 delta（没给快照）⇒ 转写那条快照是这一轮**唯一**的收尾，必须放行
      const read = transcriptReader([messageDraftForTranscript(1)]);
      const viaTranscript = projectPiEvent(
        unrelatedEvent(), agent.state, CONTEXT, agent.runState, agent.recorder, undefined, read, agent.wire,
      );
      expect(viaTranscript.messages?.map((message) => [message.chunk, message.source])).toEqual([['snapshot', 'session-file']]);
    });

    it('快照之间仍然互斥：wire 的快照先到，转写同一轮的快照整条滤掉（去重没有被放开）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      session.emit(childTextDelta('逐字'));
      session.emit(childAssistantEnd('逐字出来的那条'));
      projectWire(unrelatedEvent(), agent, agent.wire);
      const read = transcriptReader([messageDraftForTranscript(1)]);
      const viaTranscript = projectPiEvent(
        unrelatedEvent(), agent.state, CONTEXT, agent.runState, agent.recorder, undefined, read, agent.wire,
      );
      expect(viaTranscript.messages ?? []).toHaveLength(0);
    });

    it('终态之后缓冲里的尾巴照常排（wire 无重读竞态，不需要转写那条「终态即停」的闸）', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      session.emit(childAssistantEnd('收场前的第一步'));
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      projectWire(unrelatedEvent(), agent, agent.wire); // 第一步已投
      session.emit(childAssistantEnd('最后一批父事件之后的尾巴'));
      agent.emit('subagents:completed', completedPayload());
      project(dispatchEnd(), agent.state, agent.runState, agent.recorder);
      const final = finalizePiSubagents(agent.state, agent.runState, agent.recorder, undefined, agent.wire);
      expect(final.messages?.map((message) => message.roundTrip)).toEqual([2]);
    });

    it('收尾排空 wire 尾巴之后再读转写差量：同键的滤掉、wire 没覆盖到的照投', async () => {
      const session = fakeChildSession();
      const agent = await wiredBus(session);
      agent.emit('subagents:started', startedPayload());
      session.emit(childAssistantEnd('第 1 轮'));
      projectWire(unrelatedEvent(), agent, agent.wire); // 行落账
      projectWire(unrelatedEvent(), agent, agent.wire); // wire 投出第 1 轮
      session.emit(childAssistantEnd('收尾才排的尾巴')); // 第 2 轮：只进缓冲，没有父事件再排它
      agent.emit('subagents:completed', completedPayload());
      project(dispatchEnd(), agent.state, agent.runState, agent.recorder);
      // 转写整份都在（没跑过增量 ⇒ emitted = 0）：第 1、2 轮与 wire 同键，第 3 轮只有转写有
      const read = transcriptReader([
        messageDraftForTranscript(1),
        messageDraftForTranscript(2),
        messageDraftForTranscript(3),
      ]);
      const final = finalizePiSubagents(agent.state, agent.runState, agent.recorder, read, agent.wire);
      expect(final.messages?.map((message) => [message.roundTrip, message.source]))
        .toEqual([[2, 'wire'], [3, 'session-file']]);
    });
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
