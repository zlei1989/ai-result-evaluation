// @vitest-environment node
/**
 * 注册表：三家齐备、元数据与 spec §5.6.2 的表逐格一致、未注册 id 抛错且信息含可用清单。
 * 元数据那条是 F2（候选池按协议过滤）的**回归网**：表单读的是这里，不是另一份独立的对应关系表，
 * 所以任何一格改动（哪怕只是 usage 从 false 翻成 true）都必须与 provider 实现同一次提交里改掉期望。
 */
import { AGENT_KINDS, ProtocolTypeSchema } from '@aieval/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_PACKAGE_NAME } from './providers/claude-code/sdk';
import { CODEX_PACKAGE_NAME } from './providers/codex/sdk';
import { DSH_PACKAGE_NAME } from './providers/dsh/sdk';
import { acceptsProtocol } from './protocol';
import { getProvider, listAgentProviders } from './registry';
import { setAgentRuntimeForTesting } from './runtime';
import { createFakeCodexSdk, createFakeDshSdk, createRecorder, createRunInput } from './testing/agent-fixtures';
import type { AgentKind, AgentProviderMetadata } from './types';
import { permissiveMessageCapability } from './types';


afterEach(() => {
  setAgentRuntimeForTesting(null);
});

/**
 * spec §5.6.2 的表：`protocolTypes` 是**集合**（DSH 两条 wire 都能收，见契约 R37 的收口与
 * `docs/superpowers/plans/2026-09-30-dsh-dual-protocol.md`）。本步只搬形状，三家都还是单元素。
 */
const EXPECTED_METADATA: Record<AgentKind, AgentProviderMetadata> = {
  'claude-code': {
    protocolTypes: ['anthropic'],
    // 跑动期的用量是**估算**：SDK 只在 result 消息上给结算值，流式中间快照不是最终值
    // ⇒ 界面看得到（走 usage 事件），但**不许**回写快照（见 types.ts 的 liveUsage 注释）
    capability: { cancelMidTurn: true, usage: true, liveUsage: 'estimated', structuredOutput: true },
    // 消息能力声明由三家各自显式声明（`providers/<kind>/index.ts`）；这一份是形状桩，
    // 逐格取值另有 `message-conformance.test.ts` 与各家 index.test.ts 钉住
    messageCapability: permissiveMessageCapability(),
    // 档位域来自 Agent SDK 的 `Options.effort` / `EffortLevel`（spec §4.4 的表）
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isolation: 'subprocess',
  },
  codex: {
    protocolTypes: ['openai'],
    // 每轮 turn.completed 自带的用量是适配器上报值（与终值同口径）⇒ 可以逐步回写快照
    capability: { cancelMidTurn: true, usage: true, liveUsage: 'reported', structuredOutput: true },
    messageCapability: permissiveMessageCapability(),
    // 档位域来自 codex-sdk 的 `ModelReasoningEffort`（比上游网关用到的四个档更宽）
    reasoningEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
    isolation: 'subprocess',
  },
  dsh: {
    // 两条 wire 都能收（R37 的收口）：anthropic-messages 与 openai-responses 各真机跑通过一次，
    // 见 docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md
    protocolTypes: ['openai', 'anthropic'],
    // 实测确认：用量在 session.event → assistant/message → data.usage（探测报告 §3）
    // ⇒ 与 providers/dsh/{events,index}.ts 的提取消口径**同一次提交**改成 true（F2 的回归网会拦漂移）
    capability: { cancelMidTurn: false, usage: true, liveUsage: 'reported', structuredOutput: false },
    messageCapability: permissiveMessageCapability(),
    // 档位域来自 llm-deepseek 的 `reasoningEffort` schema（只有四档：没有 medium / xhigh）
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    isolation: 'subprocess',
  },
};

describe('listAgentProviders', () => {
  it('三家齐备且与 contracts 的 AGENT_KINDS 同序', () => {
    expect(listAgentProviders().map((provider) => provider.kind)).toEqual([...AGENT_KINDS]);
  });

  it('返回副本：调用方改不到注册表本身', () => {
    const first = listAgentProviders();
    first.pop();
    expect(listAgentProviders()).toHaveLength(3);
  });

  it('displayName 非空且互不相同（界面上要能区分）', () => {
    const names = listAgentProviders().map((provider) => provider.displayName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });
});

describe('元数据投影（F2 的回归网）', () => {
  it('三家与 spec §5.6.2 的表逐格一致（`messageCapability` 除外，它另有一处真源守卫）', () => {
    for (const provider of listAgentProviders()) {
      // 为什么排除 `messageCapability`：它由**各家自己**声明（三份真值在 `providers/<kind>/index.ts`），
      // 「声明过的东西真的拿得到」由 `message-conformance.test.ts` 钉住；这里再抄一份 stub 只会
      // 让同一件事有两个真源，而两份必然漂移。
      const { messageCapability: _declared, ...rest } = provider.metadata;
      const { messageCapability: _expected, ...wanted } = EXPECTED_METADATA[provider.kind];
      // 报错信息带上 kind：这一格是「哪一家错了」的定位线索（三家共用同一个断言体）
      expect(rest, `${provider.kind} 的元数据`).toEqual(wanted);
    }
  });

  it('每家的 protocolTypes 都是 contracts 枚举的子集、非空、无重复（前端过滤不会拿到悬空值）', () => {
    for (const provider of listAgentProviders()) {
      const types = provider.metadata.protocolTypes;
      // 三格分开断言：报错信息要能直接指出是「空了」「重了」还是「取值悬空」
      expect(types.length, `${provider.kind} 的 protocolTypes 为空`).toBeGreaterThan(0);
      expect(new Set(types).size, `${provider.kind} 的 protocolTypes 有重复`).toBe(types.length);
      for (const type of types) {
        expect(ProtocolTypeSchema.options, `${provider.kind} 的 ${type}`).toContain(type);
      }
    }
  });

  /**
   * 判据函数是**四个消费点共用的唯一入口**（api 的创建校验与候选池过滤、evaluator 的评分智能体校验
   * 与编排复检）。它自己错一格，四处会一起错——所以单独钉一条，而不是只靠消费点的用例间接覆盖。
   */
  it('acceptsProtocol 只认集合里的协议', () => {
    const claude = getProvider('claude-code').metadata;
    expect(acceptsProtocol(claude, 'anthropic')).toBe(true);
    expect(acceptsProtocol(claude, 'openai')).toBe(false);
  });

  /**
   * 跑动期用量口径必须**显式声明**（用户口径，2026-09-26）。
   *
   * 为什么要有这一条：`liveUsage` 在类型上是可选的（旧夹具与第三方 provider 不被 tsc 挡在门外），
   * 而 evaluator 的缺省处置是「当成估算、不回写快照」。缺省本身安全（不会把估算写进唯一落盘真相），
   * 但它也会**静默**丢掉一家本该有的逐步落库。这条守卫把「静默缺省」变成「当场变红」：
   * 新增第四家 provider 时，作者必须在这里明确表态。
   */
  it('每家都显式声明 liveUsage（缺省会被 evaluator 当成估算，不该靠默认值）', () => {
    for (const provider of listAgentProviders()) {
      expect(provider.metadata.capability.liveUsage, `${provider.kind} 的 liveUsage`).toBeDefined();
    }
  });

  /**
   * 结构化输出能力必须**显式声明**（spec D3）。
   *
   * 为什么要有这一条：`structuredOutput` 在类型上是必填，而**带类型标注**的构造点（本文件 `:22` 的
   * `Record<AgentKind, AgentProviderMetadata>`、三家 provider 的 `: AgentProvider`、
   * `evaluator/src/testing/fixtures.ts` 那处）由 tsc 兜住——tsc 真在这里抓到过缺口；真正拦不住的是
   * **未标注**的 `vi.mock` 字面量（例如 `orchestrator-live.test.ts` 的假 provider）。而契约层与编排层
   * 都**只认这一个查询点**（A3）——一格缺失就等于「这一家能不能强约束返回形状」没有答案。
   * 这条守卫把「靠默认值蒙混」变成当场变红。
   * 第二条把三家的**开集**钉死：新增第四家、或某一家悄悄翻值，都要在这里表一次态。
   */
  it('每家都显式声明 structuredOutput（能力只有一个查询点，不许靠默认值）', () => {
    for (const provider of listAgentProviders()) {
      // 类型上它是必填（spec D3）；这一条是运行期复核——夹具/provider 走 any 或断言时仍会红
      expect(typeof provider.metadata.capability.structuredOutput, `${provider.kind} 的 structuredOutput`).toBe('boolean');
    }
  });

  it('支持结构化输出的只有 claude-code 与 codex（dsh 的 SDK 客户端没有这一格）', () => {
    const supported = listAgentProviders()
      .filter((provider) => provider.metadata.capability.structuredOutput)
      .map((provider) => provider.kind)
      .sort();
    expect(supported).toEqual(['claude-code', 'codex']);
  });

  /**
   * 档位域必须**显式声明**（spec D11）。
   *
   * 为什么要有这一条：候选池给用户列的强度选项 = 上游档位 ∩ 这一格（D10），而交集为空时界面只给
   * 「默认」—— 缺了这一格，用户会看到一个「只有默认」的下拉，而没有任何地方说得出为什么。
   * 与 `liveUsage` / `structuredOutput` 同一条口径：**能力只有一个查询点**，不许靠默认值蒙混。
   */
  it('每家都显式声明 reasoningEfforts（交集规则靠它，缺一格就是静默少一批档位）', () => {
    for (const provider of listAgentProviders()) {
      expect(provider.metadata.reasoningEfforts.length, `${provider.kind} 的 reasoningEfforts`).toBeGreaterThan(0);
    }
  });
});

describe('getProvider', () => {
  it('按 kind 解析到同一个实例（编排层只按 kind 查，不持有运行时对象）', () => {
    expect(getProvider('codex')).toBe(getProvider('codex'));
  });

  it('未注册的 id 抛错，且错误信息含可用清单（§5.6.7）', () => {
    const call = (): unknown => getProvider('gemini' as AgentKind);
    expect(call).toThrow(/未注册的智能体/);
    expect(call).toThrow(/claude-code/);
    expect(call).toThrow(/codex/);
    expect(call).toThrow(/dsh/);
  });
});

describe('加载降级：失败面收窄到单家（Review Focus #4）', () => {
  it('只有坏掉的那家失败，其余两家照常运行（整包仍可导入）', async () => {
    const dshRecorder = createRecorder();
    setAgentRuntimeForTesting({
      sdkModule: {
        [CLAUDE_PACKAGE_NAME]: {}, // 装坏了：形状不对
        [CODEX_PACKAGE_NAME]: createFakeCodexSdk({ recorder: createRecorder(), events: [] }),
        [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: dshRecorder, events: [] }),
      },
    });
    const claudeResult = await getProvider('claude-code').run(createRunInput());
    expect(claudeResult.error?.code).toBe('AGENT_LOAD_FAILED');
    const codexResult = await getProvider('codex').run(createRunInput());
    expect(codexResult.ok).toBe(true);
    const dshResult = await getProvider('dsh').run(createRunInput());
    expect(dshResult.ok).toBe(true);
    expect(dshRecorder.closeCount).toBe(1);
  });
});
