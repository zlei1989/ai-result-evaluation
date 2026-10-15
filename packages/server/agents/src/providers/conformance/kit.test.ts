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
  askUserProductDigest,
  askUserProductDigestExcludingNotices,
  askUserProductDigestExcludingTool,
  vendorNoticeMethodOf,
  type AskUserProbe,
} from './ask-user';
import {
  checkCapabilityDeclaration,
  checkCapabilityNailing,
  checkContracts,
  checkEventShapes,
  checkFinalAnswer,
  checkInjectionNailing,
  checkInteractionNailing,
  checkLifecycle,
  checkLineEventsAndSources,
  checkMergeKeys,
  checkSubagentAttribution,
  checkSubagentBridge,
  checkSubagentNameStability,
  checkSubagentSingleRow,
  checkStructuredOutputGroup,
  checkTransportDeliveryGroup,
  checkUsagePairing,
  foldSubagentDeliveries,
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
    /**
     * 交互面默认「结构上没有」：消息面的正例不该被这一组牵连。
     * 交互面的正反例各自单独造（见「交互面（提问应答）」那一段）。
     */
    interaction: { askUser: 'no', askUserChannel: null, askUserReason: 'not-supported', askUserProofDriver: 'real-path', askUserProofDriverReason: null, notes: [] },
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
            // 子任务自己的消息：`subagentId` 是**子任务身份**，主会话那一格则是 `null`。
            // 少了这一条，子任务节点折叠后的轮次是空的（K1 拦的正是这种「只有终局行」的产物）
            message({
              mergeKey: mergeKeyOf({ subagentId: 'child-1', roundTrip: 1, role: 'assistant', parentCallId: 'call_1' }),
              subagentId: 'child-1',
              parentCallId: 'call_1',
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
  ['交互面互钉', checkInteractionNailing],
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

  it('subagentTokens 大于合计 tokens（界面按「主会话 = 合计 − 分量」推导）⇒ 红', () => {
    const broken = fixture({
      scenarios: {
        'plain-reply': () =>
          product({
            usage: {
              tokens: USAGE_OK,
              turns: 1,
              // 合计 6（1+2+3），分量 10：主会话会被算成负数
              subagentTokens: { input: 5, cached: 0, output: 5, reasoningOutput: null, total: null },
              subagentTurns: 1,
            },
          }),
      },
    });
    expect(() => checkUsagePairing(broken)).toThrow(/大于合计 tokens/);
  });

  it('给了 subagentTokens 却把合计 tokens 记成 null（分量独立收得到、合计没采到）⇒ 不抛', () => {
    const allowed = fixture({
      scenarios: {
        'plain-reply': () =>
          product({ usage: { tokens: null, turns: 1, subagentTokens: USAGE_OK, subagentTurns: 1 } }),
      },
    });
    expect(() => checkUsagePairing(allowed)).not.toThrow();
  });

  it('分量与合计相等（全是子会话、主会话零用量）⇒ 不抛：判据是「不大于」不是「小于」', () => {
    const allowed = fixture({
      scenarios: {
        'plain-reply': () =>
          product({ usage: { tokens: USAGE_OK, turns: 1, subagentTokens: USAGE_OK, subagentTurns: 1 } }),
      },
    });
    expect(() => checkUsagePairing(allowed)).not.toThrow();
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

/**
 * 子任务投递那一组（归属 / 折叠去重 / 名字稳定）。
 *
 * 正例刻意给**两条投递**（派发一条、收尾一条带终态与用量）：这一组的判据全部长在「多次投递」
 * 这个形状上，只给一条的话三条判据都成了空转——而它们在真机上要拦的恰恰是两条投递之间的差。
 */
describe('一致性套件：子任务投递（归属 / 折叠 / 名字）', () => {
  /** 派发那一条：状态还在跑、还没有结果与用量 */
  const dispatched = subagent({ subagentId: 'child-1', name: '审查页面', kind: 'spawn_agent', status: 'running', parentCallId: 'call_1' });
  /** 收尾那一条：完整快照（终态 + 结果 + 用量），名字与派发逐字相同 */
  const settled = subagent({
    subagentId: 'child-1',
    name: '审查页面',
    kind: 'spawn_agent',
    status: 'completed',
    outcome: '看完了',
    usage: { input: 3, cached: 0, output: 2, reasoningOutput: null, total: null },
    parentCallId: 'call_1',
  });
  /** 子任务自己的两条消息（两轮）——`subagentId` 挂的是子任务身份 */
  const childMessages = [
    message({
      mergeKey: mergeKeyOf({ subagentId: 'child-1', roundTrip: 1, role: 'assistant', parentCallId: 'call_1' }),
      subagentId: 'child-1',
      parentCallId: 'call_1',
    }),
    message({
      mergeKey: mergeKeyOf({ subagentId: 'child-1', roundTrip: 2, role: 'assistant', parentCallId: 'call_1' }),
      subagentId: 'child-1',
      parentCallId: 'call_1',
      roundTrip: 2,
    }),
  ];
  const withDeliveries = (records: SubagentRecord[], messages: AgentMessage[] = childMessages): ConformanceFixture =>
    fixture({ scenarios: { subagent: () => product({ subagents: records, messages }) } });

  it('两条投递（后者是完整快照）⇒ 三条判据都不抛', () => {
    const ok = withDeliveries([dispatched, settled]);
    expect(() => checkSubagentAttribution(ok)).not.toThrow();
    expect(() => checkSubagentSingleRow(ok)).not.toThrow();
    expect(() => checkSubagentNameStability(ok)).not.toThrow();
  });

  it('折叠成一行，且按首次出现顺序（后到的覆盖不挪位置）', () => {
    // 两条身份：第二条先收尾、第一条后收尾 ⇒ 折叠输出仍按「第一次被说到」的顺序
    const folded = foldSubagentDeliveries([
      dispatched,
      subagent({ subagentId: 'child-2', name: '另一个' }),
      settled,
    ]);
    expect(folded.map((record) => record.subagentId)).toEqual(['child-1', 'child-2']);
    expect(folded[0]).toMatchObject({ status: 'completed', outcome: '看完了' });
  });

  it('子任务行有、消息全挂主会话（没有一条带 subagentId）⇒ 红', () => {
    const broken = withDeliveries([dispatched, settled], [message({ mergeKey: 'main|1|assistant|-' })]);
    expect(() => checkSubagentAttribution(broken)).toThrow(/没有一条消息带 subagentId/);
  });

  it('归属键挂的是**派生它的调用 id**（两套 id）⇒ 仍归到同一个子任务节点，不抛', () => {
    // 消息上写调用 id、记录上写身份：别名解析要把它们认成一回事（真机形态）
    const aliased = [
      message({
        mergeKey: mergeKeyOf({ subagentId: 'call_1', roundTrip: 1, role: 'assistant', parentCallId: 'call_1' }),
        subagentId: 'call_1',
        parentCallId: 'call_1',
      }),
    ];
    expect(() => checkSubagentAttribution(withDeliveries([dispatched, settled], aliased))).not.toThrow();
  });

  it('有带 subagentId 的消息，但一条都不落在某个子任务节点上 ⇒ 红（点名到那个子任务）', () => {
    const broken = withDeliveries([dispatched, settled, subagent({ subagentId: 'child-2', name: '没人理它' })]);
    expect(() => checkSubagentAttribution(broken)).toThrow(/子任务 child-2 没有一条归属它自己的消息/);
  });

  it('收尾那条比派发那条**更瘦**（覆盖会把事实抹掉）⇒ 红', () => {
    const broken = withDeliveries([dispatched, subagent({ subagentId: 'child-1', name: '审查页面', status: 'completed' })]);
    expect(() => checkSubagentSingleRow(broken)).toThrow(/把 kind 投成了 null/);
  });

  it('什么都不带的重发（与上一条逐格相同）⇒ 红', () => {
    const broken = withDeliveries([dispatched, settled, { ...settled }]);
    expect(() => checkSubagentSingleRow(broken)).toThrow(/与上一条逐格相同/);
  });

  it('补全带新事实（收尾第一次拿到终态与用量）⇒ 不抛（判据是内容，不是「发过没有」）', () => {
    // 派发那一条已经带用量，收尾那一条把用量改大 ⇒ 有新事实，照发
    const grew = { ...settled, usage: { input: 9, cached: 0, output: 5, reasoningOutput: null, total: null } };
    expect(() => checkSubagentSingleRow(withDeliveries([{ ...dispatched, usage: settled.usage }, grew]))).not.toThrow();
  });

  it('派发时没有名字、收尾补上一个 ⇒ 不抛（补全不是改名）', () => {
    const filled = { ...settled, name: '审查页面' };
    expect(() => checkSubagentNameStability(withDeliveries([{ ...dispatched, name: null }, filled]))).not.toThrow();
  });

  it('收尾用厂商描述覆盖派发时的名字 ⇒ 红（并同时报出两个取值）', () => {
    const broken = withDeliveries([dispatched, { ...settled, name: 'Review the page' }]);
    expect(() => checkSubagentNameStability(broken)).toThrow(/名字被后来的投递改动/);
  });

  it('收尾把名字退回 null ⇒ 红（界面会在那一刻把标题换成 id 前 8 位）', () => {
    const broken = withDeliveries([dispatched, { ...settled, name: null }]);
    expect(() => checkSubagentNameStability(broken)).toThrow(/名字被后来的投递改动/);
  });

  it('派发时没名字、收尾补了两个不同的名字 ⇒ 红（补全过程中自己改了口）', () => {
    const broken = withDeliveries([
      { ...dispatched, name: null },
      { ...settled, name: '甲' },
      { ...settled, name: '乙' },
    ]);
    expect(() => checkSubagentNameStability(broken)).toThrow(/补全过程中出现了多个取值/);
  });

  it('没声明 subagent=yes 的家⇒ 归属判据空转（这一格不归它管）', () => {
    const noSubagent = fixture({
      capability: yesCapability({ subagent: 'no', subagentSource: null, subagentReason: 'not-supported' }),
      scenarios: { subagent: () => product({ subagents: [dispatched, settled] }) },
    });
    expect(() => checkSubagentAttribution(noSubagent)).not.toThrow();
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

  /**
   * **逐名绑定**（MCP 那一格的收紧）：判据不能再是「工具表里有**某个** `mcp__*`」。
   *
   * 三条用例各拦一类缺陷——「任一台缺席也算过」（改探针服务器名的形态）、「名单与事实不符」
   * （夹具改名而判据没跟）、「名字形态不同就不认」（厂商把 `-` 写成 `_`）。前两条是这一格的
   * 存在理由，第三条是共享匹配器那一半。
   */
  describe('MCP 逐名绑定', () => {
    const withServers = (names: readonly string[], tools: string[], declared?: readonly string[]): ConformanceFixture =>
      fixture({
        injection: mcpYes(),
        injectionProof: { mcp: 'mcp-injection' },
        ...(declared === undefined ? {} : { injectedMcpServers: declared }),
        scenarios: {
          'mcp-injection': () =>
            product({ events: [vendor({ tools })], injectionProbe: { mcpSent: sent, mcpServerNames: names } }),
        },
      });

    it('每一台都在工具表里 ⇒ 不抛；名字被厂商 sanitize（`-` ⇒ `_`）也认', () => {
      expect(() => checkInjectionNailing(withServers(['my-server'], ['Bash', 'mcp__my_server__echo'], ['my-server']))).not.toThrow();
    });

    it('只多出一台我们没注入的 `mcp__` 工具 ⇒ 红（「有某个 mcp__」不再算证据）', () => {
      expect(() => checkInjectionNailing(withServers(['probe'], ['mcp__other__x'], ['probe']))).toThrow(
        /厂商工具表里没有这几台的工具：probe/,
      );
    });

    it('两台里只到一台 ⇒ 红（点名缺的那一台，不是笼统说「没证据」）', () => {
      expect(() => checkInjectionNailing(withServers(['probe', 'ghost'], ['mcp__probe__echo'], ['probe', 'ghost']))).toThrow(
        /厂商工具表里没有这几台的工具：ghost/,
      );
    });

    it('声明的名单与请求侧探针不符 ⇒ 红（夹具改了名而判据没跟，这一格就白判了）', () => {
      expect(() => checkInjectionNailing(withServers(['probe-x'], ['mcp__probe-x__echo'], ['probe']))).toThrow(
        /声明的注入名单与请求侧探针不符/,
      );
    });
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

/**
 * 交互面（今天只有「能不能问人」那一格）：声明 `yes` 的家必须拿得出一个能造出「问了一次」的场景，
 * 且那次运行的产物要过 `./ask-user.ts` 的四格判据。
 *
 * ⚠️ 这一组与注入面**刻意不同的一格**在最后一条用例里钉住：**声明非 `yes` 也允许有场景**——
 * 非 `yes` 说的是适配器那一半没接，场景证的是骨架那一半（端口问得对、不传回调时一个字都不动）。
 * 写成注入面那样「非 yes 不许有场景」，接线之前四家就都得把场景删掉。
 */
describe('一致性套件：交互面（提问应答）', () => {
  const QUESTION = {
    header: '选路径',
    prompt: '用哪条路径？',
    options: [{ label: '选项 A', description: null, recommended: true }],
    multiSelect: false,
    allowOther: true,
    secret: false,
  };

  /**
   * 一次真答复：答案必须**非空**——空答复证明不了「答案进得了帧」。
   * 默认取**多选 + 自由输入**那一档（两格同时有值）：契约里它是「并存」，两半都要在帧里；
   * **单选**那一档（`selected` 为空、`custom` 有值 = 覆盖）另有独立用例，见下面两条。
   */
  const REPLY = {
    outcome: 'answered' as const,
    answers: [{ header: '选路径', selected: ['选项 A'], custom: '都不对，走第三条路' }],
  };

  /** 只把 askUser 声明成 `yes` 的交互面声明 */
  const askYes = (): ConformanceFixture['interaction'] => ({
    askUser: 'yes',
    askUserChannel: 'vendor-tool',
    askUserReason: null,
    askUserProofDriver: 'real-path',
    askUserProofDriverReason: null,
    notes: [],
  });

  /**
   * 账本里那条提问调用（判据见 `checkAskUserLedger`）：题面取**端口收到的那一份**。
   * 少了它，这一组的每个正例都会红在「提问那一半没进账本」上——那正是它要拦的形态。
   */
  const withLedger = (one: AskUserProbe, extra: Partial<ConformanceProduct> = {}): ConformanceProduct =>
    product({
      askUser: one,
      messages: [
        message({
          mergeKey: mergeKeyOf({ subagentId: null, roundTrip: 1, role: 'assistant', parentCallId: null }),
          blocks: [{
            type: 'tool-call',
            callId: 'call_ask_1',
            family: 'ask-user',
            name: one.requests[0]?.toolName ?? 'AskUserQuestion',
            input: null,
            payload: { kind: 'ask-user', questions: one.requests[0]?.questions ?? [] },
            summary: '向用户提问：选路径',
          }] as AgentMessage['blocks'],
        }),
      ],
      ...extra,
    });

  /** 探针：只填判据真正读的字段（形状由 `./ask-user.ts` 的接口管） */
  const probe = (overrides: Partial<AskUserProbe> = {}): AskUserProbe => ({
    calls: 1,
    requests: [{ questions: [QUESTION], toolName: 'AskUserQuestion', callId: 'call_ask_1', vendorBudgetMs: null, subagentId: null }],
    replies: [REPLY],
    answerFrame: { behavior: 'allow', updatedInput: { answers: REPLY.answers } },
    control: {
      calls: 0,
      reply: { outcome: 'unavailable', answers: null },
      digestWithCallback: '同一份产物',
      digestWithoutCallback: '同一份产物',
      digestWithCallbackExcludingAskTool: '同一份产物',
      digestWithoutCallbackExcludingAskTool: '同一份产物',
      requestTools: ['read', 'bash'],
    },
    ...overrides,
  });

  /** 宿主工具那一档的声明与探针（`vendor-tool` 的对照判据不许放宽，故两档各造一份） */
  const hostToolDeclaration = (): ConformanceFixture['interaction'] => ({
    askUser: 'yes',
    askUserChannel: 'host-tool',
    askUserReason: null,
    askUserProofDriver: 'real-path',
    askUserProofDriverReason: null,
    notes: [],
  });
  const HOST_TOOL = 'ask_user_question';
  const hostProbe = (overrides: Partial<AskUserProbe> = {}): AskUserProbe =>
    probe({
      requests: [{
        questions: [QUESTION],
        toolName: HOST_TOOL,
        callId: 'call_ask_1',
        vendorBudgetMs: null,
        subagentId: null,
      }],
      control: {
        calls: 0,
        reply: { outcome: 'unavailable', answers: null },
        digestWithCallback: '带那一件工具的答案（原始，逐字比会不同）',
        digestWithoutCallback: '带那一件工具的错误结果（原始，逐字比会不同）',
        digestWithCallbackExcludingAskTool: '两臂归一到同一形态之后的产物',
        digestWithoutCallbackExcludingAskTool: '两臂归一到同一形态之后的产物',
        missingToolError: `Tool ${HOST_TOOL} not found`,
        requestTools: ['read', 'bash'],
      },
      ...overrides,
    });
  const withHostAsk = (one: AskUserProbe): ConformanceFixture =>
    fixture({
      interaction: hostToolDeclaration(),
      askUserHostTool: HOST_TOOL,
      scenarios: { 'ask-user': () => withLedger(one) },
    });

  const withAsk = (one: AskUserProbe, declaration = askYes()): ConformanceFixture =>
    fixture({ interaction: declaration, scenarios: { 'ask-user': () => withLedger(one) } });

  it('声明 askUser=yes：场景在、探针四格齐 ⇒ 不抛', () => {
    expect(() => checkInteractionNailing(withAsk(probe()))).not.toThrow();
  });

  it('声明 askUser=yes 却没有能证明它的场景 ⇒ 红（声明过的东西必须真的拿得到）', () => {
    const broken = fixture({ interaction: askYes() });
    expect(() => checkInteractionNailing(broken)).toThrow(/没有任何能证明它的场景/);
  });

  it('证明场景的产物里没有提问应答探针 ⇒ 红（空转不许静默）', () => {
    const broken = fixture({ interaction: askYes(), scenarios: { 'ask-user': () => product({}) } });
    expect(() => checkInteractionNailing(broken)).toThrow(/没有提问应答探针/);
  });

  it('回调被调用了两次 ⇒ 红（同一个问题不许问两遍）', () => {
    expect(() => checkInteractionNailing(withAsk(probe({ calls: 2 })))).toThrow(/必须恰好一次/);
  });

  it('入参形状不对（厂商预算给了 0）⇒ 红（0 会被读成立刻超时）', () => {
    const broken = probe({
      requests: [{ questions: [QUESTION], toolName: 'AskUserQuestion', callId: 'call_ask_1', vendorBudgetMs: 0, subagentId: null }],
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/0 会被读成/);
  });

  it('答复没进到该家的应答帧里 ⇒ 红（装帧把答案丢了）', () => {
    const broken = probe({ answerFrame: { behavior: 'allow', updatedInput: {} } });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/找不到被选中的选项/);
  });

  /**
   * **提问那一半进账本**（`checkAskUserLedger`）：判据挂在**运行事实**上（端口真被问过），
   * 因此「账本里没有那条 `ask-user` 调用」这一形态必须当场红——codex 的提问走服务端请求、
   * 不进通知流，账本里那一半没有第二个来源，忘了物化时界面上只剩一条没有题目的答复行。
   */
  it('端口真被问过、账本里却没有 `ask-user` 调用 ⇒ 红（卡片没有驱动，只剩一条没题目的答复行）', () => {
    const broken = fixture({ interaction: askYes(), scenarios: { 'ask-user': () => product({ askUser: probe() }) } });
    expect(() => checkInteractionNailing(broken)).toThrow(/账本里却没有一条 `ask-user` 族的工具调用/);
  });

  it('账本里那条调用没有族载荷 ⇒ 红（没有题目就没有卡片）', () => {
    const broken = fixture({
      interaction: askYes(),
      scenarios: {
        'ask-user': () => {
          const one = withLedger(probe());
          const [first] = one.messages;
          return product({
            askUser: probe(),
            messages: [{
              ...first!,
              blocks: [{ type: 'tool-call', callId: 'call_ask_1', family: 'ask-user', name: 'AskUserQuestion', input: null, payload: null }],
            } as AgentMessage],
          });
        },
      },
    });
    expect(() => checkInteractionNailing(broken)).toThrow(/没有族载荷/);
  });

  it('账本里那条调用的 id 与端口收到的那一个不同 ⇒ 红（有卡片没答案）', () => {
    const broken = fixture({
      interaction: askYes(),
      scenarios: {
        'ask-user': () => {
          const one = withLedger(probe());
          const [first] = one.messages;
          return product({
            askUser: probe(),
            messages: [{
              ...first!,
              blocks: [{ type: 'tool-call', callId: 'call_别的', family: 'ask-user', name: 'AskUserQuestion', input: null, payload: { kind: 'ask-user', questions: [QUESTION] } }],
            } as AgentMessage],
          });
        },
      },
    });
    expect(() => checkInteractionNailing(broken)).toThrow(/就是「有卡片没答案」/);
  });

  it('账本里的题面与端口收到的那一份不同 ⇒ 红（卡片上问的与模型问的不是同一道题）', () => {
    const broken = fixture({
      interaction: askYes(),
      scenarios: {
        'ask-user': () => {
          const changed = probe({
            requests: [{
              questions: [{ ...QUESTION, header: '另一题' }],
              toolName: 'AskUserQuestion',
              callId: 'call_ask_1',
              vendorBudgetMs: null,
              subagentId: null,
            }],
          });
          return product({
            askUser: changed,
            messages: [
              message({
                mergeKey: mergeKeyOf({ subagentId: null, roundTrip: 1, role: 'assistant', parentCallId: null }),
                blocks: [{
                  type: 'tool-call',
                  callId: 'call_ask_1',
                  family: 'ask-user',
                  name: 'AskUserQuestion',
                  input: null,
                  payload: { kind: 'ask-user', questions: [QUESTION] },
                  summary: '向用户提问：选路径',
                }] as AgentMessage['blocks'],
              }),
            ],
          });
        },
      },
    });
    expect(() => checkInteractionNailing(broken)).toThrow(/账本里的题面与端口收到的那一份不同/);
  });

  it('账本里那一问没有任何一题允许自由输入 ⇒ 红（弹层永远没有输入框）', () => {
    const broken = probe({
      requests: [{
        // 提问形状里没有 `allowOther`（两家把自由输入写在**答复面**上，只读提问形状必然恒 false）
        questions: [{ ...QUESTION, allowOther: false }],
        toolName: 'AskUserQuestion',
        callId: 'call_ask_1',
        vendorBudgetMs: null,
        subagentId: null,
      }],
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/没有任何一题声明「允许自由输入」/);
  });

  it('声明了允许自由输入、答复里却没有一条自由输入 ⇒ 红（这一格是无区分力的空转）', () => {
    const broken = probe({
      replies: [{ outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: null }] }],
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/答复里却没有一条写下自己的答案/);
  });

  it('自由输入没进应答帧 ⇒ 红（只查被选中的选项会放过它）', () => {
    const broken = probe({
      answerFrame: { behavior: 'allow', updatedInput: { answers: [{ header: '选路径', selected: ['选项 A'] }] } },
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/找不到自由输入的答案/);
  });

  /**
   * **单选 + 自由输入 = 覆盖**：用户自己写的那句话就是全部答案，`selected` 为空数组。
   * 此时帧里只有那句话（选项一个都没有），判据不许把「没选任何选项」读成「答复没进帧」。
   */
  it('单选覆盖档：`selected` 为空、`custom` 有值且进了帧 ⇒ 不抛（覆盖不是丢答案）', () => {
    const override = probe({
      replies: [{ outcome: 'answered', answers: [{ header: '选路径', selected: [], custom: '都不对，走第三条路' }] }],
      answerFrame: { behavior: 'allow', updatedInput: { answers: { '用哪条路径？': '都不对，走第三条路' } } },
    });
    expect(() => checkInteractionNailing(withAsk(override))).not.toThrow();
  });

  it('既是空选又是空写 ⇒ 红（两条路都没走，等于没答）', () => {
    const empty = probe({
      replies: [{ outcome: 'answered', answers: [{ header: '选路径', selected: [], custom: null }] }],
      answerFrame: { behavior: 'allow', updatedInput: { answers: {} } },
    });
    expect(() => checkInteractionNailing(withAsk(empty))).toThrow(/既没选也没写/);
  });

  /** **多选 = 并存**：勾选的标签与自由输入是两半，少渲染哪一半都要红 */
  it('多选并存档：两半都在帧里 ⇒ 不抛；只装下选项那一半 ⇒ 红', () => {
    const both = probe({
      replies: [{ outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: '再加一句' }] }],
      answerFrame: { behavior: 'allow', updatedInput: { answers: { '用哪条路径？': ['选项 A', '再加一句'] } } },
    });
    expect(() => checkInteractionNailing(withAsk(both))).not.toThrow();
    const halfOnly = probe({
      replies: [{ outcome: 'answered', answers: [{ header: '选路径', selected: ['选项 A'], custom: '再加一句' }] }],
      answerFrame: { behavior: 'allow', updatedInput: { answers: { '用哪条路径？': ['选项 A'] } } },
    });
    expect(() => checkInteractionNailing(withAsk(halfOnly))).toThrow(/找不到自由输入的答案/);
  });

  it('不传回调的对照运行里回调仍被调用 ⇒ 红（「默认不介入」不成立）', () => {
    const broken = probe({
      control: {
        calls: 1,
        reply: { outcome: 'unavailable', answers: null },
        digestWithCallback: '同一份产物',
        digestWithoutCallback: '同一份产物',
        digestWithCallbackExcludingAskTool: '同一份产物',
        digestWithoutCallbackExcludingAskTool: '同一份产物',
        requestTools: ['read', 'bash'],
      },
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/「默认不介入」不成立/);
  });

  it('不传回调时端口没有立即给「无人应答」⇒ 红（不挂起这条边界）', () => {
    const broken = probe({
      control: {
        calls: 0,
        reply: { outcome: 'timeout', answers: null },
        digestWithCallback: '同一份产物',
        digestWithoutCallback: '同一份产物',
        digestWithCallbackExcludingAskTool: '同一份产物',
        digestWithoutCallbackExcludingAskTool: '同一份产物',
        requestTools: ['read', 'bash'],
      },
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/必须立即给「无人应答」/);
  });

  it('不传回调的对照运行产物与带回调那次不同 ⇒ 红（「不问就不动」不成立）', () => {
    const broken = probe({
      control: {
        calls: 0,
        reply: { outcome: 'unavailable', answers: null },
        digestWithCallback: '带回调的产物',
        digestWithoutCallback: '少了一次工具调用的产物',
        digestWithCallbackExcludingAskTool: '带回调的产物',
        digestWithoutCallbackExcludingAskTool: '少了一次工具调用的产物',
        requestTools: ['read', 'bash'],
      },
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/「不问就不动」不成立/);
  });

  it('**声明非 yes 也允许有场景** ⇒ 不抛（接线之前四家正是这个状态）', () => {
    // 与注入面刻意不同的那一格：`no` / `off-by-adapter` 说的是适配器那一半没接，
    // 而场景证的是骨架那一半——把这条写成注入面那样，接线之前四家的场景都得删掉
    const beforeWiring: ConformanceFixture['interaction'] = {
      askUser: 'off-by-adapter',
      askUserChannel: null,
      askUserReason: 'not-observed',
      askUserProofDriver: 'synthetic-fixture',
      askUserProofDriverReason: '夹具扮演厂商那一端（这一条判的是声明与场景的配对，与驱动器无关）',
      notes: [],
    };
    expect(() => checkInteractionNailing(withAsk(probe(), beforeWiring))).not.toThrow();
  });

  /**
   * **`host-tool` 档：对照臂判据的放宽与它的守卫**（理由见 `./ask-user.ts` 的模块头）。
   *
   * 这一档的对照运行里那件工具按定义不存在，于是同一条剧本的那一问必然落成一条错误结果——
   * 逐字比指纹在这一档**结构上做不到**。放宽的是「那一件工具」这一格，其余每一格照旧比对。
   * 下面几条各守一半：正例过；工具名不给 / 对照臂工具表里仍有它 / 拿不到「工具不存在」原文 /
   * 归一之后两臂仍不同——四种都必须红。
   */
  it('host-tool 档：对照臂里没有那件工具、拿到「工具不存在」原文、归一之后两臂相同 ⇒ 不抛', () => {
    expect(() => checkInteractionNailing(withHostAsk(hostProbe()))).not.toThrow();
  });

  it('host-tool 档却没交出那件工具的名字 ⇒ 红（这一档的对照臂判据无从谈起）', () => {
    const broken = fixture({
      interaction: hostToolDeclaration(),
      scenarios: { 'ask-user': () => withLedger(hostProbe()) },
    });
    expect(() => checkInteractionNailing(broken)).toThrow(/却没有交出那件工具的名字/);
  });

  it('host-tool 档没交出对照臂的出站工具表 ⇒ 红（产物里看不出「有没有声明出去」）', () => {
    const source = hostProbe();
    const broken = hostProbe({
      control: { ...source.control, requestTools: undefined },
    });
    expect(() => checkInteractionNailing(withHostAsk(broken))).toThrow(/出站工具表/);
  });

  it('host-tool 档的对照臂出站工具表里仍有那件工具 ⇒ 红（「不问就不动」在这一档的落点是「不注册它」）', () => {
    const source = hostProbe();
    const broken = hostProbe({
      control: { ...source.control, requestTools: ['read', 'bash', HOST_TOOL] },
    });
    expect(() => checkInteractionNailing(withHostAsk(broken))).toThrow(/出站工具表仍带着/);
  });

  it('host-tool 档的对照臂没落成「工具不存在」⇒ 红（两臂跑的不是同一件事）', () => {
    const source = hostProbe();
    const broken = hostProbe({ control: { ...source.control, missingToolError: null } });
    expect(() => checkInteractionNailing(withHostAsk(broken))).toThrow(/没有落成「工具不存在」类错误/);
  });

  it('host-tool 档归一之后两臂仍不同 ⇒ 红（放宽的只是那一件工具，不是整份判据）', () => {
    const source = hostProbe();
    const broken = hostProbe({
      control: {
        ...source.control,
        digestWithCallbackExcludingAskTool: '两臂归一到同一形态之后的产物',
        digestWithoutCallbackExcludingAskTool: '别处也变了（例如少了一条事件）',
      },
    });
    expect(() => checkInteractionNailing(withHostAsk(broken))).toThrow(/「不问就不动」不成立/);
  });

  it('`vendor-tool` 档不许走归一那条路：原始指纹不同就红', () => {
    // 同一份构造，声明仍是 `vendor-tool`：那一档比的就是原始指纹（那两格在这份探针里不同）
    const source = probe();
    const broken = probe({
      control: {
        ...source.control,
        digestWithCallback: '带回调的产物',
        digestWithoutCallback: '带一件错误结果的产物',
        digestWithCallbackExcludingAskTool: '带回调的产物（这一档也不许用归一那一格）',
        digestWithoutCallbackExcludingAskTool: '带一件错误结果的产物',
      },
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/「不问就不动」不成立/);
  });

  /**
   * **归一函数本身的两条守卫**：它只许抹掉那一件工具，别处一律照旧。
   *
   * 没有这两条，一个「把所有工具结果都抹掉」的实现也能让上面那条正例通过——判据会被放宽成空转。
   */
  it('归一函数：只抹那一件提问工具，别的工具调用与结果一字不动', () => {
    const blocks = (toolName: string): AgentMessage['blocks'] => [
      { type: 'tool-call', callId: 'call_ask', family: 'ask-user', name: toolName, input: { questions: [] }, payload: null },
      { type: 'tool-result', callId: 'call_ask', structured: null, isError: false, text: '答案', truncation: 'none' },
      { type: 'tool-call', callId: 'call_bash', family: 'shell', name: 'bash', input: { command: 'ls' }, payload: null },
      { type: 'tool-result', callId: 'call_bash', structured: null, isError: false, text: 'a.txt', truncation: 'none' },
    ] as AgentMessage['blocks'];
    const withAnswer = product({ messages: [message({ mergeKey: 'k', blocks: blocks(HOST_TOOL) })] });
    const withError = product({
      messages: [message({
        mergeKey: 'k',
        blocks: blocks(HOST_TOOL).map((block) =>
          block.type === 'tool-result' && block.callId === 'call_ask'
            ? { ...block, text: `Tool ${HOST_TOOL} not found`, isError: true }
            : block),
      })],
    });
    const digestOf = (value: ConformanceProduct): string => askUserProductDigestExcludingTool(value, HOST_TOOL);
    // 那一件工具被归一到同一形态 ⇒ 两臂相同
    expect(digestOf(withAnswer)).toBe(digestOf(withError));

    // 别的工具结果改了内容 ⇒ 指纹必须跟着变（归一没有波及它）
    const othersChanged = product({
      messages: [message({
        mergeKey: 'k',
        blocks: blocks(HOST_TOOL).map((block) =>
          block.type === 'tool-result' && block.callId === 'call_bash' ? { ...block, text: 'b.txt' } : block),
      })],
    });
    expect(digestOf(othersChanged)).not.toBe(digestOf(withAnswer));

    // 事件条数变了 ⇒ 也要跟着变（归一保留位置与条数这一格）
    const fewerEvents = product({
      messages: [message({ mergeKey: 'k', blocks: blocks(HOST_TOOL) })],
      events: [{ type: 'log', at: 1, text: 'x' }],
    });
    expect(digestOf(fewerEvents)).not.toBe(digestOf(withAnswer));
    // 事件里带那件工具名的那几条：归一之后两臂相同（它们在对照臂里是「工具不存在」的错误）
    const eventsWithTool = (isError: boolean): Record<string, unknown>[] => [
      { type: 'log', at: 1, toolName: HOST_TOOL, text: isError ? '工具报错' : '调用工具', summary: '那一问' },
    ];
    expect(digestOf(product({ events: eventsWithTool(true) }))).toBe(
      digestOf(product({ events: eventsWithTool(false) })),
    );
  });

  /**
   * **厂商通知那一格**（`control.askSwitchNotices`）：本仓对未识别通知的落点是抄原文 ⇒ 厂商自己的
   * 通知节奏进了产物，两臂对比必须点名允许出入的那几条。四条判据各有一条反例，缺一条这一格就会
   * 退化成「厂商爱发就发」。
   */
  const noticeProbe = (overrides: {
    notices?: Record<string, 'switch-only' | 'volatile'>;
    arms?: Record<string, { withCallback: boolean; withoutCallback: boolean }>;
    raw?: [string, string];
    normalized?: [string, string];
  } = {}): AskUserProbe => {
    const source = probe();
    const notices = overrides.notices ?? { warning: 'switch-only' };
    const arms = overrides.arms ?? { warning: { withCallback: true, withoutCallback: false } };
    return probe({
      control: {
        ...source.control,
        // 原始指纹不同（那一条通知只在一臂里）——这是登记这一格的前提
        digestWithCallback: overrides.raw?.[0] ?? '带回调（多一条厂商通知）',
        digestWithoutCallback: overrides.raw?.[1] ?? '对照臂',
        askSwitchNotices: notices,
        noticeArms: arms,
        // 归一之后两臂逐字相同
        digestWithCallbackExcludingAskTool: overrides.normalized?.[0] ?? '两臂归一之后',
        digestWithoutCallbackExcludingAskTool: overrides.normalized?.[1] ?? '两臂归一之后',
      },
    });
  };

  it('厂商通知：登记得对（只在恰好一臂出现、去掉之后两臂逐字相同）⇒ 不抛', () => {
    expect(() => checkInteractionNailing(withAsk(noticeProbe()))).not.toThrow();
  });

  it('登记了厂商通知，两臂的**原始**指纹却逐字相同 ⇒ 红（这一格没有区分力，等于白放宽）', () => {
    const broken = noticeProbe({ raw: ['同一份产物', '同一份产物'], normalized: ['a', 'b'] });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/原始.*逐字相同/);
  });

  it('点名的厂商通知在两臂里都没出现过 ⇒ 红（名字写错了，这一格什么都没抹掉）', () => {
    const broken = noticeProbe({ arms: { warning: { withCallback: false, withoutCallback: false } } });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/两臂里都没出现过/);
  });

  it('按 `switch-only` 记的厂商通知两臂都发（或都没发）⇒ 红（它与提问开关无关）', () => {
    const broken = noticeProbe({ arms: { warning: { withCallback: true, withoutCallback: true } } });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/switch-only/);
  });

  it('`volatile` 档允许两臂都发（厂商自己的节奏）⇒ 不抛', () => {
    const volatile = noticeProbe({
      notices: { 'account/rateLimits/updated': 'volatile' },
      arms: { 'account/rateLimits/updated': { withCallback: true, withoutCallback: true } },
    });
    expect(() => checkInteractionNailing(withAsk(volatile))).not.toThrow();
  });

  it('归一之后的两臂指纹与原始指纹一模一样 ⇒ 红（点名一条都没命中）', () => {
    const broken = noticeProbe({
      normalized: ['带回调（多一条厂商通知）', '对照臂'],
    });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/没有生效/);
  });

  it('去掉点名的厂商通知之后两臂仍不同 ⇒ 红（放宽的只是那几条，不是整份判据）', () => {
    const broken = noticeProbe({ normalized: ['两臂归一之后', '别处也变了（例如少了一条事件）'] });
    expect(() => checkInteractionNailing(withAsk(broken))).toThrow(/「不问就不动」不成立/);
  });

  /**
   * `vendorNoticeMethodOf` 与 `askUserProductDigestExcludingNotices` 各自的守卫：
   * 前者只认**严格形状**（放宽判据的地方认错了比不认更坏），后者只丢点名的那几条、并按剩下的重编 `seq`。
   */
  it('厂商通知的正身判据只认「正文是一个 `{method}` 或 `{method, params}` 的 JSON 对象」这一种形状', () => {
    expect(vendorNoticeMethodOf({ type: 'log', text: '{"method":"warning"}' })).toBe('warning');
    /**
     * **带 `params` 的那一形也要认**：各家的 `other` 分支把厂商原载荷一起抄下来（丢了它就分不清
     * 「上游换了载荷结构」与「上游没发」）⇒ 只认 `{method}` 会让这一格在带载荷的家上整个失效，
     * 表现是两臂指纹永远不相同（误红）。
     */
    expect(vendorNoticeMethodOf({ text: '{"method":"warning","params":{"a":1}}' })).toBe('warning');
    expect(vendorNoticeMethodOf({ text: '{"params":{"a":1},"method":"model/rerouted"}' })).toBe('model/rerouted');
    // 多出第三个键、没有 method、不是对象、方法名为空、根本不是 JSON —— 一律不认
    expect(vendorNoticeMethodOf({ text: '{"method":"warning","params":{},"extra":1}' })).toBeNull();
    expect(vendorNoticeMethodOf({ text: '{"params":{"a":1}}' })).toBeNull();
    expect(vendorNoticeMethodOf({ text: '["warning"]' })).toBeNull();
    expect(vendorNoticeMethodOf({ text: '{"method":""}' })).toBeNull();
    expect(vendorNoticeMethodOf({ text: '警告：Under-development features enabled' })).toBeNull();
    expect(vendorNoticeMethodOf({ text: '{"method":' })).toBeNull();
    expect(vendorNoticeMethodOf({})).toBeNull();
    expect(vendorNoticeMethodOf(null)).toBeNull();
  });

  it('按厂商通知归一：只丢点名的那几条、并按剩下的重编 `seq`，别处一律照旧', () => {
    const notice = (method: string): Record<string, unknown> => ({
      type: 'log',
      seq: 0,
      stream: 'stdout',
      text: `{"method":"${method}"}`,
      summary: `{"method":"${method}"}`,
    });
    const built = (): ConformanceProduct =>
      product({
        events: [
          { ...notice('warning'), seq: 1 },
          { type: 'log', seq: 2, stream: 'stdout', text: '正文', summary: '跑起来了' },
          { ...notice('account/rateLimits/updated'), seq: 3 },
          { type: 'usage', seq: 4 },
        ],
      });
    const digestOf = (methods: readonly string[]): string =>
      askUserProductDigestExcludingNotices(built(), methods);
    // 零条点名 = 与原始指纹逐字相同（这一档不碰任何东西）
    expect(digestOf([])).toBe(askUserProductDigest(built()));
    // 只丢 warning ⇒ 剩下的三条按 1/2/3 重编（不重编的话与「不丢」两臂会整体错位）
    expect(digestOf(['warning'])).not.toBe(digestOf([]));
    const renumbered = (): ConformanceProduct =>
      product({
        events: [
          { type: 'log', seq: 1, stream: 'stdout', text: '正文', summary: '跑起来了' },
          { ...notice('account/rateLimits/updated'), seq: 2 },
          { type: 'usage', seq: 3 },
        ],
      });
    expect(digestOf(['warning'])).toBe(askUserProductDigest(renumbered()));
    // 别处的正文照旧参与比对
    const changed = built();
    expect(digestOf(['warning'])).not.toBe(
      askUserProductDigestExcludingNotices(
        { ...changed, events: [...changed.events, { type: 'log', seq: 5, stream: 'stdout', text: '多一条' }] },
        ['warning'],
      ),
    );
  });

  it('产物指纹：厂商载荷里的线程身份（`threadId` / `turnId`）不算行为，别处的载荷差异照旧算', () => {
    const notice = (payload: Record<string, unknown>): Record<string, unknown> => ({
      type: 'log',
      seq: 1,
      stream: 'stdout',
      text: '{"method":"warning"}',
      // 真实形状：`text` 是方法名那一段、`summary` 是原始负载那一整段（见 `emit.ts` 的 `logDraft`）
      summary: JSON.stringify(payload),
    });
    // 同一条通知、两次运行各自的线程号 ⇒ 指纹相同（否则任何两臂比对都恒红）
    const first = product({ events: [notice({ method: 'warning', params: { threadId: '01a1-aaa', turnId: 'turn-1' } })] });
    const second = product({ events: [notice({ method: 'warning', params: { threadId: '01a1-bbb', turnId: 'turn-9' } })] });
    expect(askUserProductDigest(first)).toBe(askUserProductDigest(second));
    // ⚠️ 只抹那两个键的值：厂商正文不同照旧要区分得开
    const otherText = product({
      events: [notice({ method: 'warning', params: { threadId: '01a1-aaa', turnId: 'turn-1', message: '别的警告' } })],
    });
    expect(askUserProductDigest(first)).not.toBe(askUserProductDigest(otherText));
  });

  it('产物指纹：时刻不同 ⇒ 相同；归一产物变了 ⇒ 不同', () => {
    const log = (at: number): Record<string, unknown> => ({ type: 'log', at, stream: 'stdout', text: '跑起来了' });
    const first = product({ events: [log(1_000)] });
    const second = product({ events: [log(2_000)] });
    expect(askUserProductDigest(first)).toBe(askUserProductDigest(second));
    // 多一条行级事件（哪怕正文一样）就是行为不同：指纹只丢正文，不丢结构
    expect(askUserProductDigest(first)).not.toBe(askUserProductDigest(product({ events: [log(1_000), log(1_000)] })));
    // 归一产物的正文（消息内容块）照旧逐字比
    const said = (text: string): ConformanceProduct =>
      product({ messages: [message({ mergeKey: 'main|1|assistant|-', blocks: [{ type: 'text', text }] as AgentMessage['blocks'] })] });
    expect(askUserProductDigest(said('甲'))).not.toBe(askUserProductDigest(said('乙')));
    // 探针本身（两次运行按定义就不同）不进指纹
    expect(askUserProductDigest(product({ askUser: probe() }))).toBe(askUserProductDigest(product({})));
  });

  it('产物指纹：每次运行现生成的会话身份与计时读数都不算行为（它们只出现在原始载荷与时钟格上）', () => {
    // dsh 的会话号是每次运行现生成的随机串，厂商原文那一份会照进 `raw` 与「原始输出」的日志正文；
    // pi 的 provider id 由每行一份临时目录派生、载荷里还有 epoch 毫秒。三种都不进指纹。
    const frame = (sessionId: string, totalMs: number): ConformanceProduct =>
      product({
        events: [
          { type: 'log', at: 1, stream: 'stdout', text: `{"method":"session.status","params":{"sessionId":"${sessionId}"}}` },
          { type: 'usage', at: 2, timing: { totalMs, apiMs: null, ttftMs: null } },
        ],
        messages: [
          {
            mergeKey: 'main|1|assistant|-',
            raw: { params: { sessionId, timestamp: 1_791_864_915_571 } },
          } as unknown as AgentMessage,
        ],
      });
    expect(askUserProductDigest(frame('session-0bd8044e74dd48c0843e0f8604a2be2a', 0)))
      .toBe(askUserProductDigest(frame('session-18ae887c3dc84a04ba461c1570b45e38', 7)));
    // ⚠️ 只丢正文，不丢结构：日志的**条数与通道**照旧比——「不传回调时多出一条日志」仍然拦得住
    const withExtraLog = product({ events: [{ type: 'log', at: 1, stream: 'stdout', text: '一模一样的正文' }] });
    const withoutLog = product({ events: [] });
    expect(askUserProductDigest(withExtraLog)).not.toBe(askUserProductDigest(withoutLog));
  });
});
