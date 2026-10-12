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
  checkEventShapes,
  checkFinalAnswer,
  checkInjectionNailing,
  checkLifecycle,
  checkLineEventsAndSources,
  checkMergeKeys,
  checkSubagentBridge,
  checkStructuredOutputGroup,
  checkTransportDeliveryGroup,
  checkUsagePairing,
  mergeKeyOf,
  type ConformanceFixture,
  type ConformanceProduct,
  type LifecycleEvidence,
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
    /**
     * 注入面默认声明「两条通路都没有」且不给证明场景：消息面的正例不该被这一组牵连。
     * 注入面的正反例各自单独造（见「注入面」那一段）。
     */
    injection: {
      mcp: { state: 'no', reason: 'not-supported' },
      skills: { state: 'no', reason: 'not-supported' },
      notes: [],
    },
    injectionProof: {},
    /**
     * 生命周期：正例只要求「有安排」，故默认登记到别处——一个真实存在的仓内文件
     * （文件存在性由接入守卫核对，这里只管判据不抛）。生命周期自己的正反例见文件末尾那一段。
     */
    cancelMidTurn: true,
    lifecycleElsewhere: 'packages/server/agents/src/providers/cc/index.test.ts',
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
              // 调用与它的结果**成对**给：`toolResult=yes` 的证明只认 tool-result 块，
              // 只给 tool-call 是不够的（那正是这条判据原先漏掉的形态）
              blocks: [
                { type: 'tool-call', callId: 'call_1', input: { command: 'ls' } },
                { type: 'tool-result', callId: 'call_1', structured: null, isError: false, text: 'a.txt', truncation: 'none' },
              ] as AgentMessage['blocks'],
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
const SEMANTIC_CHECKS: ReadonlyArray<readonly [string, (one: ConformanceFixture) => void | Promise<void>]> = [
  ['能力声明自身合规', checkCapabilityDeclaration],
  ['合并键公式', checkMergeKeys],
  ['子任务桥', checkSubagentBridge],
  ['用量配对', checkUsagePairing],
  ['能力互钉', checkCapabilityNailing],
  ['注入面互钉', checkInjectionNailing],
  ['事件形状', checkEventShapes],
  ['生命周期', checkLifecycle],
  ['最终答复口径', checkFinalAnswer],
  ['行级事件与来源', checkLineEventsAndSources],
];

describe('一致性套件：正例全通过', () => {
  for (const [title, check] of SEMANTIC_CHECKS) {
    it(`${title} 在合规 fixture 上不抛`, async () => {
      // `Promise.resolve` 包一层：这一组里既有同步判据也有异步判据（生命周期要真跑两次运行）
      await expect(Promise.resolve(check(fixture()))).resolves.toBeUndefined();
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

  it('声明 thinkingText=yes 但只有密文思考（text 为 null）⇒ 红（「有思考」与「拿得到正文」是两件事）', () => {
    const base = fixture();
    const broken: ConformanceFixture = {
      ...base,
      scenarios: {
        ...base.scenarios,
        'thinking-full': () =>
          product({
            messages: [
              message({
                mergeKey: 'main|1|assistant|-',
                blocks: [{ type: 'thinking', text: null, textKind: 'none', signature: 'sig' }] as AgentMessage['blocks'],
              }),
            ],
          }),
      },
    };
    expect(() => checkCapabilityNailing(broken)).toThrow(/密文思考证明不了 thinkingText=yes/);
  });

  it('声明 toolResult=yes 但产物里只有工具调用、没有结果块 ⇒ 红（入参那一格证明不了结果那一格）', () => {
    // 只换掉 tool-shell 这一格：其余场景照旧，红的原因才唯一指向「结果块缺席」
    const base = fixture();
    const broken: ConformanceFixture = {
      ...base,
      scenarios: {
        ...base.scenarios,
        'tool-shell': () =>
          product({
            messages: [
              message({
                mergeKey: 'main|1|assistant|-',
                blocks: [{ type: 'tool-call', callId: 'call_1', input: { command: 'ls' } }] as AgentMessage['blocks'],
              }),
            ],
          }),
      },
    };
    expect(() => checkCapabilityNailing(broken)).toThrow(/没有 tool-result 块/);
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

  it('行级事件形状不合契约（status 事件缺 status 格）⇒ 红', () => {
    const broken = fixture({
      scenarios: { 'plain-reply': () => product({ events: [{ type: 'status' }] }) },
    });
    expect(() => checkEventShapes(broken)).toThrow(/行级事件不合契约/);
  });

  it('行级事件出现契约外的类型 ⇒ 红', () => {
    const broken = fixture({
      scenarios: { 'plain-reply': () => product({ events: [{ type: 'nonsense' }] }) },
    });
    expect(() => checkLineEventsAndSources(broken)).toThrow(/契约外的行级事件/);
  });

  it('契约内的 vendor-system 事件不判违规（闭集从 schema 派生，不是手抄的那三类）', () => {
    const ok = fixture({
      scenarios: { 'plain-reply': () => product({ events: [{ type: 'vendor-system' }] }) },
    });
    expect(() => checkLineEventsAndSources(ok)).not.toThrow();
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
              nativeChannel: true,
              hasOutputSchema: true,
              finalText: '{"verdict":"还行"}',
            },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(withProbe)).not.toThrow();
    expect(() => checkStructuredOutputGroup(fixture())).not.toThrow();
  });

  it('没有原生通道（填充层）但答复是可解析 JSON ⇒ 过（dsh 的形状）', () => {
    const filling = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: {
              nativeChannel: false,
              hasOutputSchema: false,
              finalText: '{"verdict":"还行"}',
              expected: { verdict: '还行' },
            },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(filling)).not.toThrow();
  });

  it('上报走了原生通道却没把 schema 发给厂商 ⇒ 红（并点名到场景）', () => {
    const broken = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: { nativeChannel: true, hasOutputSchema: false, finalText: '{"verdict":"还行"}' },
          }),
      },
    });
    expect(() => checkStructuredOutputGroup(broken)).toThrow(/acme\/structured-output：.*没有把 schema 发给厂商/);
  });

  it('产出不可解析（既没走原生通道也没吐 JSON）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'structured-output': () =>
          product({
            structuredOutput: { nativeChannel: false, hasOutputSchema: false, finalText: '我觉得还行' },
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
            structuredOutput: { nativeChannel: true, hasOutputSchema: true, finalText: null, failed: true, failureReason: '' },
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

describe('一致性套件：注入面（MCP / skills）', () => {
  /** 一条合成的 `vendor-system` 事实（形状由 `checkEventShapes` 管，这里只喂这一组读的那几格） */
  const vendor = (facts: Record<string, unknown>): Record<string, unknown> => ({ type: 'vendor-system', ...facts });

  /** 只把 mcp 声明成 yes 的注入面声明（skills 留 no，免得两条通路互相干扰） */
  const mcpYes = (): ConformanceFixture['injection'] => ({
    mcp: { state: 'yes', reason: null },
    skills: { state: 'no', reason: 'not-supported' },
    notes: [],
  });

  /** 请求侧事实：形如「适配器真的把这份配置交给了厂商」（真实夹具里由假件在 run 期间记录） */
  const sent = { probe: { transport: 'stdio', command: 'node' } };

  it('声明 mcp=yes：请求侧与厂商侧都在 ⇒ 不抛', () => {
    const ok = fixture({
      injection: mcpYes(),
      injectionProof: { mcp: 'mcp-injection' },
      scenarios: {
        'mcp-injection': () =>
          product({ events: [vendor({ mcpServers: [{ name: 'probe' }] })], injectionProbe: { mcpSent: sent } }),
      },
    });
    expect(() => checkInjectionNailing(ok)).not.toThrow();
  });

  it('MCP 事实的**另一台通道**也算数：只有工具表（dsh 的形态）⇒ 不抛', () => {
    const ok = fixture({
      injection: mcpYes(),
      injectionProof: { mcp: 'mcp-injection' },
      scenarios: {
        'mcp-injection': () =>
          product({ events: [vendor({ tools: ['Bash', 'mcp__probe__echo'] })], injectionProbe: { mcpSent: sent } }),
      },
    });
    expect(() => checkInjectionNailing(ok)).not.toThrow();
  });

  it('声明 mcp=yes 却既没证明场景、也没登记别处 ⇒ 红（空转不许静默）', () => {
    const broken = fixture({ injection: mcpYes() });
    expect(() => checkInjectionNailing(broken)).toThrow(/既没有证明场景、也没有登记/);
  });

  it('声明 mcp=yes 但**请求侧为空**（适配器没把入参交给厂商）⇒ 红——只判厂商侧时这一整类缺陷看不见', () => {
    const broken = fixture({
      injection: mcpYes(),
      injectionProof: { mcp: 'mcp-injection' },
      scenarios: { 'mcp-injection': () => product({ events: [vendor({ mcpServers: [{ name: 'probe' }] })] }) },
    });
    expect(() => checkInjectionNailing(broken)).toThrow(/没有\*\*请求侧\*\*事实/);
  });

  it('声明 mcp=yes 且请求侧有、产物里却没有 MCP 事实 ⇒ 红（发出去了但厂商没认）', () => {
    const broken = fixture({
      injection: mcpYes(),
      injectionProof: { mcp: 'mcp-injection' },
      scenarios: {
        'mcp-injection': () => product({ events: [vendor({ tools: ['Bash'] })], injectionProbe: { mcpSent: sent } }),
      },
    });
    expect(() => checkInjectionNailing(broken)).toThrow(/没有任何 MCP 事实/);
  });

  it('声明 mcp=yes 且登记了别处 ⇒ 不抛（那一层由接入守卫核对文件存在）', () => {
    const ok = fixture({ injection: mcpYes(), injectionProofElsewhere: { mcp: 'providers/cc/skills.test.ts' } });
    expect(() => checkInjectionNailing(ok)).not.toThrow();
  });

  it('声明 mcp=no 却给了证明场景 ⇒ 红（声明不支持、却造得出事实）', () => {
    const broken = fixture({ injectionProof: { mcp: 'mcp-injection' } });
    expect(() => checkInjectionNailing(broken)).toThrow(/自相矛盾/);
  });

  it('skills 的证明要看**厂商侧清单**：工具表里有 MCP 项不算技能事实', () => {
    const broken = fixture({
      injection: { mcp: { state: 'no', reason: 'not-supported' }, skills: { state: 'yes', reason: null }, notes: [] },
      injectionProof: { skills: 'skill-injection' },
      scenarios: {
        'skill-injection': () =>
          product({ events: [vendor({ tools: ['mcp__probe__echo'] })], injectionProbe: { skillsInstalled: ['alpha'] } }),
      },
    });
    expect(() => checkInjectionNailing(broken)).toThrow(/技能清单为空/);
  });

  it('skills 的证明也要看**请求侧落盘**：只有厂商侧清单、没有副本 ⇒ 红', () => {
    const broken = fixture({
      injection: { mcp: { state: 'no', reason: 'not-supported' }, skills: { state: 'yes', reason: null }, notes: [] },
      injectionProof: { skills: 'skill-injection' },
      scenarios: { 'skill-injection': () => product({ events: [vendor({ skills: [{ name: 'alpha' }] })] }) },
    });
    expect(() => checkInjectionNailing(broken)).toThrow(/没有\*\*请求侧\*\*事实/);
  });
});

describe('一致性套件：生命周期（释放 / 取消）', () => {
  const evidence = (overrides: Partial<LifecycleEvidence> = {}): LifecycleEvidence => ({
    disposeAfterRun: 1,
    disposeAfterCancel: 1,
    canceledMidTurn: true,
    ...overrides,
  });

  /** 一份带生命周期观测的 fixture（`cancelMidTurn` 是声明，观测值另给） */
  const withLifecycle = (observed: LifecycleEvidence, cancelMidTurn = true): ConformanceFixture =>
    fixture({ cancelMidTurn, lifecycle: () => Promise.resolve(observed) });

  it('两条出口都恰好释放一次、取消与声明一致 ⇒ 不抛', async () => {
    await expect(checkLifecycle(withLifecycle(evidence()))).resolves.toBeUndefined();
  });

  it('正常运行收尾后**没释放**（泄漏子进程）⇒ 红', async () => {
    await expect(checkLifecycle(withLifecycle(evidence({ disposeAfterRun: 0 })))).rejects.toThrow(/释放了 0 次/);
  });

  it('取消之后没释放 ⇒ 红', async () => {
    await expect(checkLifecycle(withLifecycle(evidence({ disposeAfterCancel: 0 })))).rejects.toThrow(/取消之后释放了 0 次/);
  });

  it('重复释放（>1 次）⇒ 红', async () => {
    await expect(checkLifecycle(withLifecycle(evidence({ disposeAfterCancel: 2 })))).rejects.toThrow(/释放了 2 次/);
  });

  it('声明能中途取消、观测却没有终结在途轮次 ⇒ 红（声明能、实际不能）', async () => {
    await expect(checkLifecycle(withLifecycle(evidence({ canceledMidTurn: false }), true))).rejects.toThrow(/声明与观测不符/);
  });

  it('声明不能中途取消、观测也没终结它 ⇒ 不抛（如实登记那一档的边界）', async () => {
    await expect(checkLifecycle(withLifecycle(evidence({ canceledMidTurn: false }), false))).resolves.toBeUndefined();
  });

  it('既没有观测、也没有登记别处 ⇒ 红（释放与取消不许静默）', async () => {
    // 显式清掉默认登记：反例要的正是「两样都没有」那种形态
    const broken = fixture({ cancelMidTurn: true, lifecycleElsewhere: undefined });
    await expect(checkLifecycle(broken)).rejects.toThrow(/既没有生命周期观测、也没有登记/);
  });

  it('登记了别处 ⇒ 不抛（那一层由接入守卫核对文件存在）', async () => {
    const ok = fixture({ cancelMidTurn: true, lifecycleElsewhere: 'packages/server/agents/src/providers/cc/index.test.ts' });
    await expect(checkLifecycle(ok)).resolves.toBeUndefined();
  });
});
