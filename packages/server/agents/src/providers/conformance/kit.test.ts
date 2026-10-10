// @vitest-environment node
/**
 * 一致性套件自己的守卫：**套件的每条判据都得见过失败**，否则它只是一堆「看起来会拦」的断言。
 *
 * 分工：
 *  · 语义组（合并键 / 子任务桥 / 用量配对 / 能力互钉 / 缺失原因 / 行级事件）测**正反两面**——
 *    正例用最小对象，只填该组真正读的字段；
 *  · `checkContracts` 只测**反例**（形状由 `@aieval/contracts` 的 zod schema 保证，
 *    这里不重复造一份合法消息——两份形状必然漂移）。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, MessageCapability, SubagentRecord } from '@aieval/contracts';
import {
  checkCapabilityDeclaration,
  checkCapabilityNailing,
  checkContracts,
  checkFinalAnswer,
  checkLineEventsAndSources,
  checkMergeKeys,
  checkMissingReasons,
  checkSubagentBridge,
  checkStructuredOutputGroup,
  checkTransportDeliveryGroup,
  checkUsagePairing,
  mergeKeyOf,
  type ConformanceFixture,
  type ConformanceProduct,
} from './kit';

/** 全部为 yes 的声明：能力互钉要求每个 yes 都有能证明它的场景 */
function yesCapability(overrides: Partial<MessageCapability> = {}): MessageCapability {
  return {
    thinkingText: 'yes',
    thinkingTextKind: 'full',
    toolInput: 'yes',
    toolResult: 'yes',
    subagent: 'yes',
    streamingDelta: 'yes',
    thinkingTextSource: 'wire',
    thinkingTextReason: null,
    toolInputSource: 'wire',
    toolInputReason: null,
    toolResultSource: 'wire',
    toolResultReason: null,
    subagentSource: 'wire',
    subagentReason: null,
    streamingDeltaSource: 'wire',
    streamingDeltaReason: null,
    notes: [],
    ...overrides,
  };
}

/** 造一条消息：只填判据真正读的字段，其余靠断言时的 `as`（形状由 schema 管，见文件头） */
function message(overrides: Partial<AgentMessage> & Pick<AgentMessage, 'mergeKey'>): AgentMessage {
  return {
    messageId: 'run:1',
    subagentId: null,
    roundTrip: 1,
    role: 'assistant',
    parentCallId: null,
    chunk: 'snapshot',
    source: 'wire',
    blocks: [],
    ...overrides,
  } as AgentMessage;
}

function subagent(overrides: Partial<SubagentRecord> & Pick<SubagentRecord, 'subagentId'>): SubagentRecord {
  return {
    name: null,
    kind: null,
    source: 'wire',
    status: 'completed',
    statusMissing: null,
    outcome: null,
    parentCallId: null,
    parentSubagentId: null,
    usage: null,
    ...overrides,
  } as SubagentRecord;
}

const USAGE_OK = { input: 1, cached: 2, output: 3, reasoningOutput: 0, total: null };

function product(overrides: Partial<ConformanceProduct> = {}): ConformanceProduct {
  return {
    messages: [],
    subagents: [],
    environment: null,
    events: [],
    usage: { tokens: USAGE_OK, turns: 1, subagentTokens: null, subagentTurns: null },
    // 缺省「跑成功、但没采到答复」：正例里没有主会话答复，故最终答复的通则不会被触发
    result: { ok: true, finalText: null },
    ...overrides,
  };
}

function fixture(overrides: Partial<ConformanceFixture> = {}): ConformanceFixture {
  return {
    kind: 'acme',
    capability: yesCapability(),
    scenarios: {
      'thinking-full': () =>
        product({
          messages: [
            message({
              mergeKey: mergeKeyOf({ subagentId: null, roundTrip: 1, role: 'assistant', parentCallId: null }),
              blocks: [{ type: 'thinking', text: '想了', textKind: 'full', signature: null }] as AgentMessage['blocks'],
            }),
          ],
        }),
      'tool-shell': () =>
        product({
          messages: [
            message({
              mergeKey: mergeKeyOf({ subagentId: null, roundTrip: 1, role: 'assistant', parentCallId: null }),
              blocks: [{ type: 'tool-call', callId: 'call_1', input: { command: 'ls' } }] as AgentMessage['blocks'],
            }),
          ],
        }),
      subagent: () =>
        product({
          messages: [
            message({
              mergeKey: mergeKeyOf({ subagentId: null, roundTrip: 1, role: 'assistant', parentCallId: null }),
              blocks: [{ type: 'tool-call', callId: 'call_1', input: {} }] as AgentMessage['blocks'],
            }),
          ],
          subagents: [subagent({ subagentId: 'child-1', parentCallId: 'call_1' })],
        }),
      'plain-reply': () => product({ messages: [message({ mergeKey: 'main|1|assistant|-', chunk: 'delta' })] }),
    },
    ...overrides,
  };
}

/** 语义组的正例：把这些判据逐个跑一遍，一条都不该抛 */
const SEMANTIC_CHECKS: ReadonlyArray<readonly [string, (one: ConformanceFixture) => void]> = [
  ['能力声明自身合规', checkCapabilityDeclaration],
  ['合并键公式', checkMergeKeys],
  ['子任务桥', checkSubagentBridge],
  ['用量配对', checkUsagePairing],
  ['能力互钉', checkCapabilityNailing],
  ['缺失原因', checkMissingReasons],
  ['最终答复口径', checkFinalAnswer],
  ['行级事件与来源', checkLineEventsAndSources],
];

describe('一致性套件：正例全通过', () => {
  for (const [title, check] of SEMANTIC_CHECKS) {
    it(`${title} 在合规 fixture 上不抛`, () => {
      expect(() => check(fixture())).not.toThrow();
    });
  }
});

describe('一致性套件：每条判据都能拦（反例）', () => {
  it('合并键不符公式 ⇒ 红', () => {
    const broken = fixture({
      scenarios: { 'plain-reply': () => product({ messages: [message({ mergeKey: '乱写的键' })] }) },
    });
    expect(() => checkMergeKeys(broken)).toThrow(/合并键应为/);
  });

  it('合并键对、但把 subagentId 写进键里而字段没写 ⇒ 红（公式两侧同时钉）', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () => product({ messages: [message({ mergeKey: 'child-1|1|assistant|-', subagentId: null })] }),
      },
    });
    expect(() => checkMergeKeys(broken)).toThrow(/合并键应为 main\|1\|assistant\|-/);
  });

  it('子任务的 parentCallId 指向不存在的工具调用 ⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        subagent: () =>
          product({
            messages: [message({ mergeKey: 'main|1|assistant|-', blocks: [{ type: 'text', text: 'x' }] as AgentMessage['blocks'] })],
            subagents: [subagent({ subagentId: 'child-1', parentCallId: 'call_不存在' })],
          }),
      },
    });
    expect(() => checkSubagentBridge(broken)).toThrow(/parentCallId 没有对应的工具调用块/);
  });

  it('parentSubagentId 指向不存在的子任务 ⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        subagent: () =>
          product({
            messages: [message({ mergeKey: 'main|1|assistant|-', blocks: [{ type: 'tool-call', callId: 'call_1', input: {} }] as AgentMessage['blocks'] })],
            subagents: [subagent({ subagentId: 'child-1', parentSubagentId: 'child-不存在' })],
          }),
      },
    });
    expect(() => checkSubagentBridge(broken)).toThrow(/parentSubagentId 不是本轮的任一子任务/);
  });

  it('未采到状态却写成具体状态（没用 unknown）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        subagent: () =>
          product({
            messages: [message({ mergeKey: 'main|1|assistant|-', blocks: [{ type: 'tool-call', callId: 'call_1', input: {} }] as AgentMessage['blocks'] })],
            subagents: [subagent({ subagentId: 'child-1', parentCallId: 'call_1', status: 'completed', statusMissing: 'not-observed' })],
          }),
      },
    });
    expect(() => checkSubagentBridge(broken)).toThrow(/status 必须是 unknown/);
  });

  it('声明状态采到了却又给 statusMissing ⇒ 红', () => {
    const broken = fixture({
      observedStatusIds: ['child-1'],
      scenarios: {
        subagent: () =>
          product({
            messages: [message({ mergeKey: 'main|1|assistant|-', blocks: [{ type: 'tool-call', callId: 'call_1', input: {} }] as AgentMessage['blocks'] })],
            subagents: [subagent({ subagentId: 'child-1', parentCallId: 'call_1', status: 'unknown', statusMissing: 'unverified' })],
          }),
      },
    });
    expect(() => checkSubagentBridge(broken)).toThrow(/状态声明为采到，却又给了 statusMissing/);
  });

  it('给了 subagentTurns 却把合计 turns 记成 null（分量比合计更清楚）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({ usage: { tokens: USAGE_OK, turns: null, subagentTokens: USAGE_OK, subagentTurns: 2 } }),
      },
    });
    expect(() => checkUsagePairing(broken)).toThrow(/合计 turns 记成 null/);
  });

  it('分量 token 有值而合计轮次未知（claude 的合法形态）⇒ 不抛', () => {
    const allowed = fixture({
      scenarios: {
        'plain-reply': () =>
          product({ usage: { tokens: USAGE_OK, turns: null, subagentTokens: USAGE_OK, subagentTurns: null } }),
      },
    });
    expect(() => checkUsagePairing(allowed)).not.toThrow();
  });

  it('subagentTurns 大于 turns（分量与合计不同尺）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({ usage: { tokens: USAGE_OK, turns: 1, subagentTokens: USAGE_OK, subagentTurns: 3 } }),
      },
    });
    expect(() => checkUsagePairing(broken)).toThrow(/subagentTurns 大于 turns/);
  });

  it('声明 thinkingText=yes 但场景里没有 thinking 块 ⇒ 红（这条堵的正是「声明与产物不符」）', () => {
    const broken = fixture({
      scenarios: { 'thinking-full': () => product({ messages: [message({ mergeKey: 'main|1|assistant|-' })] }) },
    });
    expect(() => checkCapabilityNailing(broken)).toThrow(/没有任何 thinking 块/);
  });

  it('声明 thinkingText=yes 却没有任何能证明它的场景 ⇒ 红', () => {
    const broken = fixture({ scenarios: { 'plain-reply': () => product() } });
    expect(() => checkCapabilityNailing(broken)).toThrow(/没有任何能证明它的场景/);
  });

  it('能力非 yes 但原因与态不对应 ⇒ 红', () => {
    const broken = fixture({
      capability: yesCapability({ toolResult: 'not-projected-by-vendor', toolResultSource: null, toolResultReason: 'not-supported' }),
    });
    expect(() => checkCapabilityNailing(broken)).toThrow(/原因必须是 not-exposed 之一/);
  });

  it('能力五态之外取值 ⇒ 红', () => {
    const broken = fixture({ capability: yesCapability({ subagent: 'maybe' as MessageCapability['subagent'] }) });
    expect(() => checkCapabilityNailing(broken)).toThrow(/不是契约五态之一/);
  });

  it('yes 却没给 source ⇒ 红（schema 层拦）', () => {
    const broken = fixture({ capability: yesCapability({ toolInputSource: null }) });
    expect(() => checkCapabilityDeclaration(broken)).toThrow(/不合规/);
  });

  it('非 yes 却没给 reason ⇒ 红（schema 层拦）', () => {
    const broken = fixture({
      capability: yesCapability({ streamingDelta: 'off-by-adapter', streamingDeltaSource: null, streamingDeltaReason: null }),
    });
    expect(() => checkCapabilityDeclaration(broken)).toThrow(/不合规/);
  });

  it('环境项标了 present:false 却没给 missing ⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({ environment: { groups: [{ id: 'g', title: 't', source: 'vendor', items: [{ present: false, id: 'sys' }] }] } }),
      },
    });
    expect(() => checkMissingReasons(broken)).toThrow(/标了 present:false 却没给 missing/);
  });

  it('行级事件出现契约外的类型 ⇒ 红', () => {
    const broken = fixture({
      scenarios: { 'plain-reply': () => product({ events: [{ type: 'score' }] }) },
    });
    expect(() => checkLineEventsAndSources(broken)).toThrow(/契约外的行级事件/);
  });

  it('log 事件缺少 stream ⇒ 红', () => {
    const broken = fixture({
      scenarios: { 'plain-reply': () => product({ events: [{ type: 'log', text: 'x' }] }) },
    });
    expect(() => checkLineEventsAndSources(broken)).toThrow(/log 事件缺少 stream/);
  });

  it('消息形状不合契约 ⇒ 红（zod 层，不重复造合法消息）', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () => product({ messages: [{ messageId: 'x' } as AgentMessage] }),
      },
    });
    expect(() => checkContracts(broken)).toThrow(/消息不合规/);
  });

  /**
   * 四条反例。第一条是**实锤过的那次缺陷**（codex 在 app-server 重构里漏写 `finalText`，
   * 各家自己的用例全绿而真机评分必挂）：产物里有答复、`finalText` 却是 `null`。
   */
  it('产物里有主会话答复、finalText 却是 null ⇒ 红（漏写那一格）', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({
            messages: [
              message({
                mergeKey: 'main|1|assistant|-',
                blocks: [{ type: 'text', text: '答复正文' }] as AgentMessage['blocks'],
              }),
            ],
          }),
      },
    });
    expect(() => checkFinalAnswer(broken)).toThrow(/finalText 是 null/);
  });

  it('finalText 是空串 ⇒ 红（「没采到」与「回了空答复」是两件事）', () => {
    const broken = fixture({ scenarios: { 'plain-reply': () => product({ result: { ok: true, finalText: '' } }) } });
    expect(() => checkFinalAnswer(broken)).toThrow(/空串/);
  });

  it('finalText 取自子线程（不是主会话答复）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () => product({ result: { ok: true, finalText: '子线程的结论' } }),
      },
    });
    expect(() => checkFinalAnswer(broken)).toThrow(/不是产物里任何一条主会话答复正文/);
  });

  it('场景声明了期望答复而实际不符 ⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({
            messages: [
              message({
                mergeKey: 'main|1|assistant|-',
                blocks: [{ type: 'text', text: '答复正文' }] as AgentMessage['blocks'],
              }),
            ],
            result: { ok: true, finalText: '答复正文' },
          }),
      },
      expectedFinalText: { 'plain-reply': '另一个答复' },
    });
    expect(() => checkFinalAnswer(broken)).toThrow(/finalText 应为/);
  });
});

describe('一致性套件：结构化输出', () => {
  it('给了探针且合规 ⇒ 不抛；不给探针 ⇒ 空转（消息级 fixture 看不到请求，不许它自述）', () => {
    const withProbe = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: {
              structuredOutput: true,
              hasOutputSchema: true,
              finalText: '{"verdict":"还行"}',
            },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(withProbe)).not.toThrow();
    expect(() => checkStructuredOutputGroup(fixture())).not.toThrow();
  });

  it('声明能用结构化却没把 schema 发给厂商 ⇒ 红（并点名到场景）', () => {
    const broken = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: { structuredOutput: true, hasOutputSchema: false, finalText: '{"verdict":"还行"}' },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(broken)).toThrow(/acme\/structured-output：.*没有把 schema 发给厂商/);
  });

  it('产出不可解析（既没结构化也没吐 JSON）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: { structuredOutput: false, hasOutputSchema: false, finalText: '我觉得还行' },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(broken)).toThrow(/不是可解析的 JSON/);
  });

  it('解析失败却没有归因（静默空评分）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: { structuredOutput: true, hasOutputSchema: true, finalText: null, failed: true, failureReason: '' },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(broken)).toThrow(/失败必须可见/);
  });
});

describe('一致性套件：传输时序（C 类）', () => {
  it('给了笔迹且合规 ⇒ 不抛；不给笔迹 ⇒ 空转（消息级 fixture 录不到订阅与响应）', () => {
    const withTranscript = fixture({
      scenarios: {
        'plain-reply': () =>
          product({
            transport: {
              steps: [{ kind: 'subscribe' }, { kind: 'push', id: 'n1' }, { kind: 'response' }],
              observed: ['n1'],
            },
          }),
      },
    });
    expect(() => checkTransportDeliveryGroup(withTranscript)).not.toThrow();
    expect(() => checkTransportDeliveryGroup(fixture())).not.toThrow();
  });

  it('订阅前的推送丢了 ⇒ 红（并点名到场景）', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({
            transport: { steps: [{ kind: 'push', id: 'early' }, { kind: 'subscribe' }], observed: [] },
          }),
      },
    });
    expect(() => checkTransportDeliveryGroup(broken)).toThrow(/acme\/plain-reply：.*没被消费方收到/);
  });

  it('终态早于响应 ⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({
            transport: {
              steps: [{ kind: 'subscribe' }, { kind: 'terminal', id: 'done' }, { kind: 'response' }],
              observed: ['done'],
            },
          }),
      },
    });
    expect(() => checkTransportDeliveryGroup(broken)).toThrow(/早于请求响应/);
  });
});
