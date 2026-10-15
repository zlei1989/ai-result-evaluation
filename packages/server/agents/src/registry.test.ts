// @vitest-environment node
/**
 * 注册表：三家齐备、元数据与表逐格一致、未注册 id 抛错且信息含可用清单。
 * 元数据那条是**回归网**（候选池按协议过滤）：表单读的是这里，不是另一份独立的对应关系表，
 * 所以任何一格改动（哪怕只是 usage 从 false 翻成 true）都必须与 provider 实现同一次提交里改掉期望。
 */
import { AGENT_KINDS, EFFORT_OFF, ProtocolTypeSchema } from '@aieval/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_PACKAGE_NAME } from './providers/cc/sdk';
import { createFakeAppServer } from './providers/codex/appserver-fixtures';
import { codexProvider } from './providers/codex/index';
import { DSH_PACKAGE_NAME } from './providers/dsh/sdk';
import { acceptsProtocol } from './protocol';
import { getProvider, listAgentProviders } from './registry';
import { setAgentRuntimeForTesting } from './runtime';
import { createFakeDshSdk, createRecorder, createRunInput } from './testing/agent-fixtures';
import type {
  AgentKind,
  AgentProviderMetadata,
  InteractionCapability,
  TurnInjectionCapability,
} from './types';
import { permissiveMessageCapability } from './types';


afterEach(() => {
  setAgentRuntimeForTesting(null);
});

/**
 * 交互面声明的**五格取值**（`notes` 不进比对：它是「为什么」的说明，随事实更新，与注入面的
 * `notes` 同一条处置）。
 *
 * 抽成一个函数是为了让「比哪几格」在投影网与逐家断言两处只有一份写法——两处各列一遍字段，
 * 漏一格的那种漂移看起来仍然全绿。
 */
function interactionCells(declaration: InteractionCapability): InteractionCapability {
  return {
    askUser: declaration.askUser,
    askUserChannel: declaration.askUserChannel,
    askUserReason: declaration.askUserReason,
    askUserProofDriver: declaration.askUserProofDriver,
    askUserProofDriverReason: declaration.askUserProofDriverReason,
    notes: [],
  };
}

/** 声明侧与期望表共同满足的结构：两边都按同一份投影被读 */
type TurnInjectionDeclarationShape = {
  delivery: Record<'round' | 'idle', TurnInjectionCellValues>;
  retract: Record<'round' | 'idle', TurnInjectionCapability['retract']['round']>;
  resume: TurnInjectionCellValues;
};

/**
 * 注入面（第五组）声明的**取值格**，`notes`、撤回的 `reason` 与 `proofDriverReason` 不进比对：
 * 前者是「这一族能力成立的前提」、后两者是判据的散文（「按什么认人 / 是不是整条清」、
 * 「今天为什么不是真路径」），三者都随实测更新，逐字进回归网只会逼两处同改
 * （与另两组的 `notes` 同一条处置）。撤回的**四档取值**与每格的 `proofDriver` 仍逐格比
 * ——前者是界面「能不能按条撤」的唯一判据，后者是「这句结论是拿真路径证的还是夹具代跑的」的唯一判据。
 *
 * 缺席照原样返回 `undefined`：没声明这一组的家与期望表逐格相等（都是 `undefined`），
 * 不会因为「没声明」被误判成「声明错了」；而**悄悄把整组声明删掉**也会红——
 * 一边有、一边没有即不同，不与「还没接」混成同一种绿。
 */
function turnInjectionCells(declaration: TurnInjectionDeclarationShape | undefined): unknown {
  if (declaration === undefined) return undefined;
  /** 一格的取值：散文那一格（`proofDriverReason`）留在原地，其余逐格进回归网 */
  const cellOf = (cell: TurnInjectionCellValues): unknown => ({
    state: cell.state,
    reason: cell.reason,
    channel: cell.channel,
    gate: cell.gate,
    experimental: cell.experimental,
    proofDriver: cell.proofDriver,
  });
  return {
    delivery: { round: cellOf(declaration.delivery.round), idle: cellOf(declaration.delivery.idle) },
    retract: { round: declaration.retract.round.state, idle: declaration.retract.idle.state },
    resume: cellOf(declaration.resume),
  };
}

/** 注入面里**进回归网**的一格取值（`proofDriverReason` 是散文，声明与期望表都不带它） */
type TurnInjectionCellValues = Omit<TurnInjectionCapability['resume'], 'proofDriverReason'>;

/**
 * 注入面在期望表里的形状：与 `turnInjectionCells()` 的投影**逐格同形**
 * （`proofDriverReason` 与 `notes` 是散文，两边都不进——各写一份「比哪几格」的话，
 * 漏一格的那种漂移看起来仍然全绿）。
 */
type TurnInjectionCellsShape = TurnInjectionDeclarationShape & {
  /** 这一格是散文、不进比对（原文在 `providers/<kind>/index.ts` 的声明里） */
  notes: string[];
};

/** 期望表：除注入面之外逐格就是 `AgentProviderMetadata`，注入面按投影后的取值格写 */
type ExpectedMetadata = Omit<AgentProviderMetadata, 'turnInjection'> & {
  turnInjection?: TurnInjectionCellsShape;
};

/**
 * `protocolTypes` 是**集合**（DSH 两条 wire 都能收，见
 * "docs/protocols/dsh.md"）。本步只搬形状，三家都还是单元素。
 */
const EXPECTED_METADATA: Record<AgentKind, ExpectedMetadata> = {
  'cc': {
    protocolTypes: ['anthropic'],
    capability: { cancelMidTurn: true, usage: true },
    // 消息能力声明由三家各自显式声明（`providers/<kind>/index.ts`）；这一份是形状桩，
    // 逐格取值另有 `message-conformance.test.ts` 与各家 index.test.ts 钉住
    messageCapability: permissiveMessageCapability(),
    // 注入面只比 `mcp` / `skills` 两格：`notes` 是「这一族能力成立的前提」，随实测更新，不进回归网
    injection: { mcp: { state: 'yes', reason: null }, skills: { state: 'yes', reason: null }, notes: [] },
    // 交互面只比取值那几格（`notes` 同上不进回归网）：厂商自带提问工具，通道是权限回调
    // （`vendor-tool`），真路径驱动器已接（真 CLI + 脚本化上游）
    interaction: {
      askUser: 'yes',
      askUserChannel: 'vendor-tool',
      askUserReason: null,
      askUserProofDriver: 'real-path',
      askUserProofDriverReason: null,
      notes: [],
    },
    // 耗时量级同理只比 `runScale`：`notes` 是实测前提的说明，随真机更新
    timing: { runScale: 'minutes', notes: [] },
    // 推理证据 events.jsonl 即齐（assistant 文本与思考都进事件流），不需要补 messages.jsonl
    needsMessagesForReasoningEvidence: false,
    // 档位域来自 Agent SDK 的 `Options.effort` / `EffortLevel`，**外加**
    // 本仓统一的关闭档 `off`：用户口径「未选 ≠ 关闭」，
    // 「关闭」只能由显式选 `off` 触发，而 claude 的 SDK 档位域里没有 `off` ⇒ 适配器把它翻成
    // `thinking: { type: 'disabled' }`（另一个字段），档名仍进档位域供界面选择。
    reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    /**
     * 注入面（第五组）：投递两档 `unverified`（接线与生产调用方都已落地，缺的是厂商侧投递点的
     * 端到端真路径观测），撤回两档 `by-id`，续接 `yes`。逐格理由写在 `providers/cc/index.ts`
     * 那一份里；这里进回归网的是**取值**——改一格就改了界面上「这家收不收人话」的结论。
     */
    turnInjection: {
      delivery: {
        round: { state: 'unverified', reason: 'unverified', channel: 'wire', gate: null, experimental: false, proofDriver: 'synthetic-fixture' },
        idle: { state: 'unverified', reason: 'unverified', channel: 'wire', gate: null, experimental: false, proofDriver: 'synthetic-fixture' },
      },
      retract: {
        round: {
          state: 'by-id',
          reason: '按我们自铸的 uuid 撤这一条（控制请求 `cancel_async_message`）；它不在 SDK 公开面'
            + '（`Query` 接口与 `.d.ts` 都没有）⇒ 运行时探测，缺席时如实回 unsupported',
        },
        idle: {
          state: 'by-id',
          reason: '按我们自铸的 uuid 撤这一条（控制请求 `cancel_async_message`）；它不在 SDK 公开面'
            + '（`Query` 接口与 `.d.ts` 都没有）⇒ 运行时探测，缺席时如实回 unsupported',
        },
      },
      resume: { state: 'yes', reason: null, channel: 'wire', gate: null, experimental: false, proofDriver: 'real-path' },
      notes: [],
    },
  },
  codex: {
    protocolTypes: ['openai'],
    capability: { cancelMidTurn: true, usage: true },
    messageCapability: permissiveMessageCapability(),
    // 注入面只比 `mcp` / `skills` 两格：`notes` 是「这一族能力成立的前提」，随实测更新，不进回归网
    injection: { mcp: { state: 'yes', reason: null }, skills: { state: 'yes', reason: null }, notes: [] },
    // 交互面只比取值那几格：厂商自带提问通道（`vendor-tool`），产品里开关与回帧都已接上，
    // 真路径驱动器已接（真 `codex app-server` + 脚本式上游）
    interaction: {
      askUser: 'yes',
      askUserChannel: 'vendor-tool',
      askUserReason: null,
      askUserProofDriver: 'real-path',
      askUserProofDriverReason: null,
      notes: [],
    },
    /**
     * 注入面（第五组）：**两档的证据强度不同**——`'idle'` 档有真路径读数（那句话进厂商出站请求体、
     * 那一轮跑完、答复成为本行 `finalText`）⇒ `yes` + `real-path`，且 `thread/queue/*` 要
     * `experimentalApi`（`experimental: true`）；`'round'` 档仍 `unverified`（**投递点**没验），
     * 带真版本门（`expectedTurnId` 自 0.156.1 起必填）、在非实验面上就有。
     * 撤回按档分开：在途那一档**没有**撤回面（`none`）、耐久队列那一档按身份可撤（`by-id`）；
     * 续接是 `yes`（真机两条独立判据都过），键只有 `threadId`。
     */
    turnInjection: {
      delivery: {
        round: { state: 'unverified', reason: 'unverified', channel: 'wire', gate: { version: '0.156.1' }, experimental: false, proofDriver: 'synthetic-fixture' },
        idle: { state: 'yes', reason: null, channel: 'wire', gate: null, experimental: true, proofDriver: 'real-path' },
      },
      retract: {
        round: { state: 'none', reason: '在途注入没有按身份收回的面（`turn/interrupt` 是无身份的全清）' },
        idle: { state: 'by-id', reason: '按厂商的 `queuedSubmissionId` 撤（`thread/queue/delete`）' },
      },
      resume: { state: 'yes', reason: null, channel: 'wire', gate: null, experimental: false, proofDriver: 'real-path' },
      notes: [],
    },
    // 耗时量级同理只比 `runScale`：`notes` 是实测前提的说明，随真机更新
    timing: { runScale: 'minutes', notes: [] },
    // 思考全文与工具结果正文结构性不进 events.jsonl，唯一落点是 messages.jsonl ⇒ 必须补
    needsMessagesForReasoningEvidence: true,
    // 档位域来自 `codex app-server` 的 `ReasoningEffort`（比上游网关用到的四个档更宽），**外加**
    // 本仓统一的关闭档 `off`：用户口径「未选 ≠ 关闭」，
    // 「关闭」只能由显式选 `off` 触发，而 codex 的关闭档在 CLI 里叫 `none`（`off` 会被网关拒）
    // ⇒ 适配器用 `codexEffortOf` 把 `off` 翻成 `none`，档名仍进档位域供界面选择。
    reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  },
  dsh: {
    // 两条 wire 都能收：anthropic-messages 与 openai-responses 各真机跑通过一次，
    // 见 docs/protocols/dsh.md「pi-ai 路由与两条 wire」
    protocolTypes: ['openai', 'anthropic'],
    // 实测确认：用量在 session.event → assistant/message → data.usage
    // ⇒ 与 providers/dsh/{events,index}.ts 的提取消口径**同一次提交**改成 true（回归网会拦漂移）
    capability: { cancelMidTurn: false, usage: true },
    messageCapability: permissiveMessageCapability(),
    // 注入面只比 `mcp` / `skills` 两格：`notes` 是「这一族能力成立的前提」，随实测更新，不进回归网
    injection: { mcp: { state: 'yes', reason: null }, skills: { state: 'yes', reason: null }, notes: [] },
    // 交互面只比取值那几格：提问工具是厂商自己的包（适配器只挂载它），应答者插件挂在旁边
    // （`providers/dsh/ask-user.ts`）⇒ 通道是 `vendor-tool`；真路径驱动器已接
    interaction: {
      askUser: 'yes',
      askUserChannel: 'vendor-tool',
      askUserReason: null,
      askUserProofDriver: 'real-path',
      askUserProofDriverReason: null,
      notes: [],
    },
    // 耗时量级同理只比 `runScale`：`notes` 是实测前提的说明，随真机更新
    timing: { runScale: 'minutes', notes: [] },
    // 推理证据 events.jsonl 即齐，不需要补 messages.jsonl
    needsMessagesForReasoningEvidence: false,
    // 人工消息面：两档各走一条路（`'idle'` 是 wire、`'round'` 是进程内插件）；
    // 续接走官方 wire 的 `session/resume`，正向证据是真路径驱动器
    turnInjection: {
      delivery: {
        round: { state: 'yes', reason: null, channel: 'in-process-plugin', gate: null, experimental: false, proofDriver: 'real-path' },
        idle: { state: 'yes', reason: null, channel: 'wire', gate: null, experimental: false, proofDriver: 'real-path' },
      },
      retract: {
        round: { state: 'by-id', reason: '' },
        idle: { state: 'by-id', reason: '' },
      },
      resume: {
        state: 'yes',
        reason: null,
        channel: 'wire',
        gate: null,
        experimental: false,
        proofDriver: 'real-path',
      },
      notes: [],
    },
    // 档位域来自 llm-deepseek 的 `reasoningEffort` schema（只有四档：没有 medium / xhigh）
    reasoningEfforts: ['off', 'low', 'high', 'max'],
    // dsh 的「未选」会真的落到一个具体档上 ⇒ 它必须声明 `defaultEffort`（另两家由厂商推断，
    // 不声明）；这一格同时是 API 侧「未选也校验」的判据，值由 `DSH_DEFAULT_EFFORT` 给出
    defaultEffort: 'high',
  },
  pi: {
    // 两条 wire 都能收（in-process SDK 自注册 provider，协议决定 wire）：
    // openai → openai-responses、anthropic → anthropic-messages
    protocolTypes: ['openai', 'anthropic'],
    // 取消走 SDK 的 `abort()`（在途轮次毫秒级终结）；用量取 `message_end.message.usage`
    capability: { cancelMidTurn: true, usage: true },
    messageCapability: permissiveMessageCapability(),
    // 注入面只比 `mcp` / `skills` 两格：`notes` 是「这一族能力成立的前提」，随实测更新，不进回归网
    injection: { mcp: { state: 'yes', reason: null }, skills: { state: 'yes', reason: null }, notes: [] },
    // 交互面只比取值那几格：这一家的提问工具由**我们**注册（厂商侧没有这个工具，见适配器的
    // `ask-user.ts`）⇒ 通道是 `host-tool` 而不是 `vendor-tool`
    interaction: { askUser: 'yes', askUserChannel: 'host-tool', askUserReason: null, askUserProofDriver: 'real-path', askUserProofDriverReason: null, notes: [] },
    /**
     * 注入面（第五组）：投递两档今天**还没接**（窄壳按 1.1.0 的实际面声明了 `steer` / `followUp`，
     * 但适配器一格都不挂端口）；撤回只有 `clearQueue()` 那一条整条清空的路；续接走进程内 SDK 的
     * `SessionManager.open(会话文件)`，真机同形夹具在 `providers/pi/session-resume.test.ts`。
     */
    turnInjection: {
      delivery: {
        round: { state: 'off-by-adapter', reason: 'not-observed', channel: 'in-process-sdk', gate: null, experimental: false, proofDriver: 'synthetic-fixture' },
        idle: { state: 'off-by-adapter', reason: 'not-observed', channel: 'in-process-sdk', gate: null, experimental: false, proofDriver: 'synthetic-fixture' },
      },
      retract: {
        round: { state: 'flush-only', reason: '只有 clearQueue()，两档一起清' },
        idle: { state: 'flush-only', reason: '只有 clearQueue()，两档一起清' },
      },
      resume: { state: 'yes', reason: null, channel: 'in-process-sdk', gate: null, experimental: false, proofDriver: 'real-path' },
      notes: [],
    },
    // 耗时量级是**秒级**：in-process SDK，没有子进程冷启动（另三家都要 spawn 一个 CLI）
    timing: { runScale: 'seconds', notes: [] },
    // 思考正文与工具结果正文都在 `session.subscribe` 的事件流里 ⇒ 不需要补 messages.jsonl。
    // 这一格成立的前提写在适配器的实现义务里：原始事件必须被投影进 `log`。
    needsMessagesForReasoningEvidence: false,
    // 档位域来自 pi 的 `ThinkingLevel` 去掉 `xhigh`：它在 pi 那边没有内建映射，会被静默夹到
    // `high`（有 `max` 的映射时则往上夹到 `max`）⇒ 收它就等于允许静默升降档。
    // `max` 进档位域的前提是模型定义上有 `thinkingLevelMap: { max: 'max' }`（那一条在适配器里）。
    // `off` 也进（本仓统一档名：未选 ≠ 关闭，关闭只能显式选）。
    reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'max'],
    // pi 的「未选」会真的落到一个具体档（`DEFAULT_THINKING_LEVEL` = medium）⇒ 必须声明
    defaultEffort: 'medium',
  },
};

describe('listAgentProviders', () => {
  it('每一家齐备且与 contracts 的 AGENT_KINDS 同序', () => {
    expect(listAgentProviders().map((provider) => provider.kind)).toEqual([...AGENT_KINDS]);
  });

  it('返回副本：调用方改不到注册表本身', () => {
    const first = listAgentProviders();
    first.pop();
    // 数目按真源现算（不写 3 或 4 这类字面量）：这条断言判的是「副本」，
    // 数字写死会让加一家时它顺带变红，而那种红指向的是别的事
    expect(listAgentProviders()).toHaveLength(AGENT_KINDS.length);
  });

  it('displayName 非空且互不相同（界面上要能区分）', () => {
    const names = listAgentProviders().map((provider) => provider.displayName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.length).toBeGreaterThan(0);
  });
});

describe('元数据投影（回归网）', () => {
  it('各家与表逐格一致（`messageCapability` 与三组 `notes` 除外，它们各有真源）', () => {
    for (const provider of listAgentProviders()) {
      // 为什么排除 `messageCapability`：它由**各家自己**声明（三份真值在 `providers/<kind>/index.ts`），
      // 「声明过的东西真的拿得到」由 `message-conformance.test.ts` 钉住；这里再抄一份 stub 只会
      // 让同一件事有两个真源，而两份必然漂移。
      const { messageCapability: _declared, injection, interaction, timing, turnInjection, ...rest } = provider.metadata;
      const {
        messageCapability: _expected,
        injection: expectedInjection,
        interaction: expectedInteraction,
        timing: expectedTiming,
        turnInjection: expectedTurnInjection,
        ...wanted
      } = EXPECTED_METADATA[provider.kind];
      // 报错信息带上 kind：这一格是「哪一家错了」的定位线索（多家共用同一个断言体）
      expect(rest, `${provider.kind} 的元数据`).toEqual(wanted);
      // 注入面的两格进回归网：悄悄把 `yes` 改成 `no` 会直接改变界面上「这家不支持 MCP / skills」
      // 的结论，必须与适配器同一次提交里改掉期望。`notes` 不进——它是实测前提的说明，随真机更新。
      expect(
        { mcp: injection.mcp, skills: injection.skills },
        `${provider.kind} 的注入面声明`,
      ).toEqual({ mcp: expectedInjection.mcp, skills: expectedInjection.skills });
      // 交互面同理只比三格取值：改一格就改了「这家能不能被问」的结论
      expect(
        interactionCells(interaction),
        `${provider.kind} 的交互面声明`,
      ).toEqual(interactionCells(expectedInteraction));
      /**
       * 注入面（第五组）同理：取值那几格进回归网，`notes` 不进。
       * **未声明**也是一条要被钉住的事实（缺席按「不知道」处置，界面不许编一份都支持的）
       * ⇒ 两边都缺席才算一致，一边有、一边没有即红。
       * 两档的档位、通道、版本门与撤回档都是界面文案与编排路径的输入，改一格就改结论。
       */
      expect(
        turnInjectionCells(turnInjection),
        `${provider.kind} 的注入面（第五组）声明`,
      ).toEqual(turnInjectionCells(expectedTurnInjection));
      // 耗时量级同理：改档会改真机冒烟的等待预算，属于「必须与适配器同一次提交里改掉」的那类
      expect(timing.runScale, `${provider.kind} 的耗时量级`).toBe(expectedTiming.runScale);
    }
  });

  /**
   * **交互面：三种「没有」逐家说得清**（取值 + 通道 + 原因非空）。
   *
   * 为什么值得单独一条、而不是只靠上面的投影网：这张表存在的**全部理由**是区分三种「没有」——
   * 结构上没有（pi）、厂商有那条通道但我们没接（cc / codex）、厂商有服务但不投送到我们拿得到的
   * 通道（dsh）。三者互换在消费侧的结论完全不同（「白写代码」vs「写代码能解决」），
   * 而写错之后读起来一样顺：把 dsh 写成 `no`、把 pi 写成 `off-by-adapter`，投影网那一条
   * 只有在期望表也一起改错时才放行，故这里把「每一家各自是哪一档」独立再钉一次。
   */
  it('交互面：每家的档位、通道与原因逐格一致，且都写下了「为什么」', () => {
    for (const kind of AGENT_KINDS) {
      const { interaction } = getProvider(kind).metadata;
      const expected = EXPECTED_METADATA[kind].interaction;
      expect(interaction.askUser, `${kind} 的 askUser`).toBe(expected.askUser);
      expect(interaction.askUserChannel, `${kind} 的 askUserChannel`).toBe(expected.askUserChannel);
      expect(interaction.askUserReason, `${kind} 的 askUserReason`).toBe(expected.askUserReason);
      // `notes` 是唯一放得下「为什么」的地方：空数组等于把这一档又收回成一句「不支持」，
      // 而这一组声明存在的意义正是让排查的人不必去读代码猜
      expect(
        interaction.notes.filter((note) => note.trim() !== '').length,
        `${kind} 的交互面 notes（要写清是「结构上没有」还是「有但没接」）`,
      ).toBeGreaterThan(0);
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
    const claude = getProvider('cc').metadata;
    expect(acceptsProtocol(claude, 'anthropic')).toBe(true);
    expect(acceptsProtocol(claude, 'openai')).toBe(false);
  });

  /**
   * 结构化输出的**通道事实**必须由适配器上报，框架里不留任何能力位。
   *
   * 为什么要有这一条：`structuredOutput` 曾经是 `metadata.capability` 上的必填格，由骨架读它决定
   * 「摘不摘 schema」。那条路把厂商差异写进了框架——现在能力差异全部落在适配器内部
   * （dsh 用自己的填充层：提示词注入 + 同会话修正轮），框架只搬运适配器上报的每-run 事实
   * （`TurnFinalize.applied`）。这条守卫把「悄悄把能力位加回来」变成当场变红：
   * 三家的 `capability` 只允许 `cancelMidTurn` / `usage` 两格。
   */
  it('capability 只有 cancelMidTurn 与 usage 两格（结构化输出不再有框架级能力位）', () => {
    for (const provider of listAgentProviders()) {
      const keys = Object.keys(provider.metadata.capability).sort();
      expect(keys, `${provider.kind} 的 capability 格数`).toEqual(['cancelMidTurn', 'usage']);
    }
  });

  /**
   * 推理证据需求必须**显式声明**，且开集只有 codex。
   *
   * 为什么要有这一条：编排层据它决定「评分证据要不要补 messages.jsonl」——codex 的思考全文与
   * 工具结果正文**结构性不进 events.jsonl**（事件流只有摘要与结构件），唯一落点是 messages.jsonl；
   * 另两家的事件流本就齐。这一格若靠默认值蒙混，漏成 `false` 会让 codex 候选的评分证据**静默缺一块**
   * （链路全通、结论偏掉，见 docs/faq/codex.md 的盲评形状）；把别家翻成 `true` 则会去读一份
   * 根本不存在的账本。开集钉死：哪一家翻值都要在这里表一次态。
   */
  it('推理证据需求：只有 codex 需要 messages.jsonl（另两家 events.jsonl 即齐）', () => {
    for (const provider of listAgentProviders()) {
      // 类型上它是必填；这一条是运行期复核——夹具/provider 走 any 或断言时仍会红
      expect(
        typeof provider.metadata.needsMessagesForReasoningEvidence,
        `${provider.kind} 的 needsMessagesForReasoningEvidence`,
      ).toBe('boolean');
    }
    const needs = listAgentProviders()
      .filter((provider) => provider.metadata.needsMessagesForReasoningEvidence)
      .map((provider) => provider.kind)
      .sort();
    expect(needs).toEqual(['codex']);
  });

  /**
   * 档位域必须**显式声明**。
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
   * `defaultEffort`（可选）必须落在自家档位域里、且**不是关闭档**。
   *
   * 为什么要有这一条：API 侧用它拦「未选档位 + 上游模型不支持那个缺省档」的组合（`runs.ts` 的
   * `resolveRunRows`）——它不是展示用的，而是**校验判据**。写歪一格的后果分两种，都很隐蔽：
   *   · 不在自家档位域里 ⇒ 未选一定被判成「不支持」，用户看到「未选也跑不了」而无从理解；
   *   · 写成关闭档 ⇒ 用户什么都没选却把思考**关掉**了，正是「未选 ≠ 关闭」要消灭的事情。
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

  it('未注册的 id 抛错，且错误信息含可用清单', () => {
    const call = (): unknown => getProvider('gemini' as AgentKind);
    expect(call).toThrow(/未注册的智能体/);
    // 逐字锚定整张清单（顺序即注册表顺序）：`cc` 只有两个字符，用 `/cc/` 断言等于没断言——
    // 任何含 "cc" 的文案都能蒙混过去，而清单漏一家、串了顺序都要红
    expect(call).toThrow(/可用清单：cc \/ codex \/ dsh \/ pi/);
  });
});

describe('加载降级：失败面收窄到单家', () => {
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
      const claudeResult = await getProvider('cc').run(createRunInput());
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
