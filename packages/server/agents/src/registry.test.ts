// @vitest-environment node
/**
 * 注册表：三家齐备、元数据与 spec §5.6.2 的表逐格一致、未注册 id 抛错且信息含可用清单。
 * 元数据那条是 F2（候选池按协议过滤）的**回归网**：表单读的是这里，不是另一份独立的对应关系表，
 * 所以任何一格改动（哪怕只是 usage 从 false 翻成 true）都必须与 provider 实现同一次提交里改掉期望。
 */
import { AGENT_KINDS, EFFORT_OFF, ProtocolTypeSchema } from '@aieval/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_PACKAGE_NAME } from './providers/claude-code/sdk';
import { createFakeAppServer } from './providers/codex/appserver-fixtures';
import { codexProvider } from './providers/codex/index';
import { DSH_PACKAGE_NAME } from './providers/dsh/sdk';
import { acceptsProtocol } from './protocol';
import { getProvider, listAgentProviders } from './registry';
import { setAgentRuntimeForTesting } from './runtime';
import { createFakeDshSdk, createRecorder, createRunInput } from './testing/agent-fixtures';
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
    capability: { cancelMidTurn: true, usage: true, structuredOutput: true },
    // 消息能力声明由三家各自显式声明（`providers/<kind>/index.ts`）；这一份是形状桩，
    // 逐格取值另有 `message-conformance.test.ts` 与各家 index.test.ts 钉住
    messageCapability: permissiveMessageCapability(),
    // 档位域来自 Agent SDK 的 `Options.effort` / `EffortLevel`（spec §4.4 的表），**外加**
    // 本仓统一的关闭档 `off`。2026-10-06 变更：此前这里是五档、无 `off`；用户裁定
    // 「未选 ≠ 关闭」，「关闭」只能由显式选 `off` 触发，而 claude 的 SDK 档位域里没有 `off`
    // ⇒ 适配器把它翻成 `thinking: { type: 'disabled' }`（另一个字段），档名仍进档位域供界面选择。
    reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  },
  codex: {
    protocolTypes: ['openai'],
    capability: { cancelMidTurn: true, usage: true, structuredOutput: true },
    messageCapability: permissiveMessageCapability(),
    // 档位域来自 `codex app-server` 的 `ReasoningEffort`（比上游网关用到的四个档更宽），**外加**
    // 本仓统一的关闭档 `off`。2026-10-06 变更：此前这里是八档、无 `off`；用户裁定「未选 ≠ 关闭」，
    // 「关闭」只能由显式选 `off` 触发，而 codex 的关闭档在 CLI 里叫 `none`（`off` 会被网关拒）
    // ⇒ 适配器用 `codexEffortOf` 把 `off` 翻成 `none`，档名仍进档位域供界面选择。
    reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  },
  dsh: {
    // 两条 wire 都能收（R37 的收口）：anthropic-messages 与 openai-responses 各真机跑通过一次，
    // 见 docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md
    protocolTypes: ['openai', 'anthropic'],
    // 实测确认：用量在 session.event → assistant/message → data.usage（探测报告 §3）
    // ⇒ 与 providers/dsh/{events,index}.ts 的提取消口径**同一次提交**改成 true（F2 的回归网会拦漂移）
    capability: { cancelMidTurn: false, usage: true, structuredOutput: false },
    messageCapability: permissiveMessageCapability(),
    // 档位域来自 llm-deepseek 的 `reasoningEffort` schema（只有四档：没有 medium / xhigh）
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    // dsh 的「未选」会真的落到一个具体档上 ⇒ 它必须声明 `defaultEffort`（另两家由厂商推断，
    // 不声明）；这一格同时是 API 侧「未选也校验」的判据，值由 `DSH_DEFAULT_EFFORT` 给出
    defaultEffort: 'high',
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
   * 结构化输出能力必须**显式声明**（spec D3）。
   *
   * 为什么要有这一条：`structuredOutput` 在类型上是必填，而**带类型标注**的构造点（本文件 `:29` 的
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
   * 与 `structuredOutput` 同一条口径：**能力只有一个查询点**，不许靠默认值蒙混。
   */
  it('每家都显式声明 reasoningEfforts（交集规则靠它，缺一格就是静默少一批档位）', () => {
    for (const provider of listAgentProviders()) {
      expect(provider.metadata.reasoningEfforts.length, `${provider.kind} 的 reasoningEfforts`).toBeGreaterThan(0);
    }
  });

  /**
   * `defaultEffort`（可选）必须落在自家档位域里、且**不是关闭档**（2026-10-06）。
   *
   * 为什么要有这一条：API 侧用它拦「未选档位 + 上游模型不支持那个缺省档」的组合（`runs.ts` 的
   * `resolveRunRows`）——它不是展示用的，而是**校验判据**。写歪一格的后果分两种，都很隐蔽：
   *   · 不在自家档位域里 ⇒ 未选一定被判成「不支持」，用户看到「未选也跑不了」而无从理解；
   *   · 写成关闭档 ⇒ 用户什么都没选却把思考**关掉**了，正是本计划（未选 ≠ 关闭）要消灭的事情。
   * 可选是因为 claude / codex 的「未选」由厂商推断、我们无从预知，故它们不声明（不是漏写）。
   */
  it('声明了 defaultEffort 的家：该值必须在自己的档位域里，且不是关闭档', () => {
    for (const kind of AGENT_KINDS) {
      const { metadata } = getProvider(kind);
      if (metadata.defaultEffort === undefined) continue;
      expect(metadata.reasoningEfforts).toContain(metadata.defaultEffort);
      expect(metadata.defaultEffort).not.toBe(EFFORT_OFF);
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
        [DSH_PACKAGE_NAME]: createFakeDshSdk({ recorder: dshRecorder, events: [] }),
      },
    });
    /**
     * codex 不再加载厂商 SDK 模块（改为解析自带可执行文件 + spawn `codex app-server`）
     * ⇒ 它的假体从「假 SDK 模块」换成 `runtimeHooks`：假客户端由 `createFakeAppServer` 提供，
     * 取数面的方法必须登记（未登记会响亮失败，防止拿到空线程树造成假绿）。
     */
    const fake = createFakeAppServer({
      respond: {
        'thread/list': () => ({ data: [], nextCursor: null }),
        'thread/read': () => ({ thread: { id: 'thread-main', turns: [] } }),
        'thread/items/list': () => ({ data: [], nextCursor: null }),
      },
    });
    const originalHooks = codexProvider.runtimeHooks;
    codexProvider.runtimeHooks = {
      resolveBinary: () => 'C:/fake/codex.exe',
      createClient: () => fake.client,
    };
    try {
      const claudeResult = await getProvider('claude-code').run(createRunInput());
      expect(claudeResult.error?.code).toBe('AGENT_LOAD_FAILED');
      const codexRun = getProvider('codex').run(createRunInput());
      // 订阅是在 `thread/start` 与 `turn/start` 返回之后才建立的 ⇒ 终态必须**之后**手动投递，
      // 用夹具的 `notifications`（提交时即投）会赶在订阅之前，表现为本轮永不结算。
      await new Promise((resolve) => setTimeout(resolve, 0));
      fake.emit('turn/completed', {
        threadId: fake.threadId,
        turn: { id: fake.turnId, items: [], status: 'completed' },
      });
      const codexResult = await codexRun;
      expect(codexResult.ok).toBe(true);
      const dshResult = await getProvider('dsh').run(createRunInput());
      expect(dshResult.ok).toBe(true);
      expect(dshRecorder.closeCount).toBe(1);
    } finally {
      codexProvider.runtimeHooks = originalHooks;
    }
  });
});
