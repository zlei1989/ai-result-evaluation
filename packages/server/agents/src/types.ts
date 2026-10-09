/**
 * agents 包对外的全部类型契约（spec §5.6.2）。
 * 三条注意：
 * 1. `AgentKind` / `AGENT_KINDS` 的真源在 `@aieval/contracts`（契约 §11 R1）：contracts 不能反向
 *    依赖 agents，而 `EvalRow.agentKind` 与前端下拉又必须与注册表同源，故这里只做**再导出**；
 * 2. `ProtocolType` 按 spec §5.6.2 明写「此处重复声明」——只为两个字符串引入一条依赖不划算，
 *    它与 contracts 的同义由 `contracts-alignment.test.ts` 的编译期断言钉住；
 * 3. `AgentEvent` 的形状真源同样在 contracts（§7.4），本文件只 import 不重复声明。
 */
import {
  AGENT_KINDS,
  type AgentEvent,
  type AgentKind,
  type AgentMessage,
  type MessageCapability,
  type SubagentRecord,
} from '@aieval/contracts';

export { AGENT_KINDS };
export type { AgentKind };

/** 与 §7.2 的 ProtocolType 同义；此处重复声明避免为两个字符串引入依赖（spec §5.6.2） */
export type ProtocolType = 'openai' | 'anthropic';

/** 与 §5.4 的行状态同名，便于 1:1 映射；刻意用 'timed-out' 而不是 'timeout' */
export type AgentExitReason = 'completed' | 'timed-out' | 'canceled' | 'error';

/**
 * 一次运行要哪种权限档（用户口径，2026-09-28）。**按阶段给，不按厂商给**：
 *   · `'full'`——智能体的执行阶段（候选改代码）。它要能装依赖、跑测试、写工作区之外的东西，
 *     所以「工作区可写」不够：codex 的 `workspace-write` 默认**关掉网络**（见 `permission.ts` 的
 *     `CODEX_PERMISSION_OPTIONS`），
 *     而「改完自己跑一遍测试」正是本产品要观察的行为之一 ⇒ 三家用各自的最宽档。
 *   · `'read-only'`——评分阶段。工作区是候选的产出，评审者改了它就污染「查看改动」抽屉
 *     （抽屉按需现算 diff）；编排层另有一次改动摘要对照（spec §7.4），本档是**执行层**的那一道。
 *
 * **刻意不做成配置项**：它由角色决定，用户没有可选项——「执行时给只读」不是一种用法，
 * 而是一个必须靠类型拦住的错误（该字段必填，就是为了让两处调用点各自表一次态）。
 *
 * 三家的落点（哪一档给哪个厂商选项，**真源是 `permission.ts`**——三份表放一起才能逐格对照，
 * 也才能让「三家都实现了同一份档位表」变成一条可执行的守卫）：
 *
 * | permission  | claude-code                                              | codex                                            | dsh                    |
 * |-------------|----------------------------------------------------------|--------------------------------------------------|------------------------|
 * | `'full'`    | `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | `sandboxMode: 'danger-full-access'` + `approvalPolicy: 'never'` | `DSH_PERMISSION_MODE=danger-full-access` |
 * | `'read-only'` | `permissionMode: 'dontAsk'` + `permissionPrompts: 'none'` | `sandboxMode: 'read-only'` + `approvalPolicy: 'never'`（**Windows 上落 `danger-full-access`**，见 `codexPermissionOptions`） | `DSH_PERMISSION_MODE=read-only` |
 *
 * ⚠️ 两家有**必须成对**的选项，少一个就静默失效：
 *   · claude 的 `bypassPermissions` 需要 `allowDangerouslySkipPermissions: true`——SDK 只是把两者
 *     拼成两个独立 argv（`--permission-mode` 与 `--allow-dangerously-skip-permissions`），
 *     少了后者，CLI 侧仍旧逐个工具要批准，而无人值守的评测里没有人能点这个批准；
 *   · dsh 的三档预设里 `danger-full-access` 才把 approval 一起设成 `never`（见 `dsh-base` 的
 *     `permission` 行）。`read-only` 档的 approval 仍是 `ask`——评审者越界时**不会**被自动放行，
 *     它会停在无人应答的批准上，**直到用户点「终止」**（2026-09-28 起不再有兜底超时：
 *     「执行不限时间、评分不限轮次和时间」）；这是「只读」在无交互环境下的正确收场（不是缺陷）。
 */
export type AgentPermission = 'full' | 'read-only';

/**
 * 领域归因码（§5.6.7）：**不是** contracts 的 `ErrorCode`。
 * 它没有对应的 HTTP 状态，落点是该行的事件日志；塞进 `ERROR_CODES` 会逼 `STATUS_BY_CODE`
 * 为它编造状态码。两组只在 `AUTH_FAILED` / `RATE_LIMITED` 上重名，含义各自独立。
 */
export type AgentErrorCode =
  | 'AGENT_LOAD_FAILED' // 厂商包缺失 / 加载失败
  | 'AGENT_FAILED' // CLI 未安装、进程非零退出、模型名不存在
  | 'AGENT_TIMED_OUT' // 适配器**自报**的超时（本层已无 `timeoutMs`；刻意与行状态 timed-out 同名）
  | 'AGENT_CANCELED' // 用户终止
  | 'AUTH_FAILED' // 密钥无效
  | 'RATE_LIMITED'; // 限流

/** 一次运行的全部输入。内部无厂商分支，**不写** `process.env`（宿主环境只读展开，用于补 `PATH` / `HOME`；§5.6.5） */
export interface AgentRunInput {
  /** 该行工作区（编排层第 1、2 步已备好）；适配器不做任何 git 操作（§5.6.6 末段） */
  cwd: string;
  /** 该行独立配置目录（第 3 步已备好）：适配器里作为 HOME / USERPROFILE / 厂商配置目录（§5.6.5 不变量 3） */
  configHome: string;
  /**
   * 权限档（见 `AgentPermission`）。**必填**：两个阶段（候选执行 / 评分）各表一次态，
   * 少给一个就会在编译期报错，而不是运行时静默用一个「谁也没选过」的默认档。
   */
  permission: AgentPermission;
  /** 考题提示词 */
  prompt: string;
  /** 路由：只读输入；适配器只读、不写回、也不写 process.env（§5.6.5 不变量 1） */
  route: {
    protocolType: ProtocolType;
    baseUrl: string;
    apiKey: string;
    modelId: string;
    /**
     * 该模型声明的上下文窗口（token）。**可选**：既有夹具与将来的第三方 provider 不该被它挡住，
     * 缺省 = 未知（各家保持自己的默认行为）。它是**事实**，不是方言：cc 读它决定要不要加 `[1m]` 后缀、
     * codex 读它填 `model_context_window`、dsh 读它写 per-run overlay 的 `contextWindow`——三种写法都不出现在这一格里。
     */
    contextWindow?: number;
    /** 单次输出上限；今天只有 dsh 的目录用得上（可选，理由同上） */
    maxOutputTokens?: number;
  };
  /** 外部要求停止（用户终止）；**不得**用它推断 exitReason（§5.6.6） */
  signal: AbortSignal;
  /**
   * 要求模型**按这份 JSON Schema 生成**最终答复（可选）。**语义是「我想要」**：
   * 不支持的适配器**降级**（骨架在 `runTurn` 里判能力，把这一格从交给 `start` 的输入里摘掉），
   * 并在结果里如实报 `applied.structuredOutput = false`。调用方**不再需要**先读注册表判能力。
   *
   * 为什么是中性事实（spec D2）：翻译成 claude 的 `outputFormat` 还是 codex 的 `outputSchema`
   * 是适配器的事；契约里出现某一家 CLI 的语法，等于让跨端契约知道厂商方言。
   */
  outputSchema?: Record<string, unknown>;
  /**
   * 要求的思考强度（可选，spec §5.1.1）。**为什么放这里而不是 route**：route 是**连接事实**
   * （协议 / 地址 / 密钥 / 模型名 / 窗口），而强度是**请求参数**——它与 `permission` 同类，
   * 且它的值域由该行选的智能体决定，与连接无关。
   * **未选 ≠ 关闭**（2026-10-06 更正）：未选表示「不指定」——dsh 的适配器给缺省档 `high`，
   * claude / codex 不传、由厂商推断；要关闭必须显式写 `EFFORT_OFF`（契约里的统一档名）。
   * 能不能收由创建时的候选校验保证（D10）。
   */
  effort?: string;
  /**
   * 事件回调：同步、不 await——事件流不能被消费者拖慢（§5.6.2）。
   *
   * 这里**不再有 `timeoutMs`**（用户口径，2026-09-28「执行不限时间、评分不限轮次和时间」）：
   * 一次运行只会因为「跑完 / 失败 / 外部要求停止」结束，适配器自己不设内层上限。
   * 代价照实登记：`runTurn` 本来就明写「可能无界返回」，删掉内层上限之后，
   * 唯一能停下它的就是这把 `signal`（用户点「终止」）与上游自己收场。
   */
  onEvent: (e: AgentEvent) => void;
  /**
   * 消息回调（spec v3 §2 的 `AgentMessage`）：**与 `onEvent` 并行**的一条流，承载内容级视图
   * （说话者、内容块、工具族、子智能体归属、模型往返序号）。
   *
   * 为什么与事件分两条流而不是塞进 `AgentEvent`：两者的消费方、去重键与生命周期都不同——事件是
   * 行级的（SSE 去重与续订按 `seq`），消息是内容级的（按合并键累积、会被快照覆盖）。
   * 把消息塞进事件联合会让消费方在两个维度上都拿到用不到的可选格。
   *
   * **可选**：不关心内容视图的调用方（例如评分通路只读 `finalText`）不传即可，此时适配器
   * 一个消息都不产出——合并与序号分配的开销也随之省掉。语义与 `onEvent` 一致：同步、不 await。
   */
  onMessage?: (message: AgentMessage) => void;
  /**
   * 子任务行回调（spec v3 §2.6 的 `SubagentRecord`）：一行一子任务，**同一身份会多次投递**
   * （派发时一条、收场时一条），后者是前者的完整快照 ⇒ 消费方按 `subagentId` 覆盖即可。
   *
   * 为什么不并进消息流：子任务不是消息（没有说话者与内容块），它的字段（名称、类型、父链、用量）
   * 与消息没有交集；并进去只会让两边的形状互相将就。
   */
  onSubagent?: (record: SubagentRecord) => void;
}

/** 一次运行的结果（§5.6.2）：计量采不到时一律 null，绝不填 0 */
export interface AgentRunResult {
  ok: boolean;
  exitReason: AgentExitReason;
  /**
   * null = 该次运行未采到计量；绝不填 0。
   *
   * ⚠️ **2026-10-04 起这一格的含义变了：它是「全树」合计**（主会话 + 我们数到的每一个子智能体，
   * spec `2026-10-01-agent-message-spec-design-v3.md` §2.4）——分量单列在 `subagentTokens`。
   * 为什么必须在这一行写明：只读 `tokens` 的消费方（对比表、历史数据）**无法从数值上**
   * 分辨一行是这次改动之前还是之后落的盘，而两边的口径不同 ⇒ 跨期比较会把口径差异读成能力差异。
   */
  tokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**用量（2026-10-04）：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量（口径见 spec `2026-10-01-agent-message-spec-design-v3.md` §2.4）。
   * `null` = 这一行没有子智能体、或**没采到**（含「有任何一个子智能体读失败」⇒ 合计退回主会话口径）。
   * 为什么与 `tokens` 一样必填：它决定界面画不画拆分那一行，缺格与 `null` 在消费侧是同一件事，
   * 少一种形态就少一处漂移（与 `usage` 事件的 `timing` 同一条处置）。
   */
  subagentTokens: { input: number; cached: number; output: number } | null;
  /**
   * **子智能体那一份**轮次（2026-10-04）：`turns` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量（口径见 spec `2026-10-01-agent-message-spec-design-v3.md` §2.4）。
   * `null` = 这一行没有子智能体、或**没采到**（含「有任何一个子智能体读失败」⇒ 合计退回主会话口径）；
   * `0` = 确实没有子智能体（子智能体一次模型往返都没跑）。
   * 为什么与 `subagentTokens` 一样必填：它决定界面画不画「轮次」那一格的拆分行，
   * 缺格与 `null` 在消费侧是同一件事，少一种形态就少一处漂移。
   * 恒有 `subagentTurns ≤ turns`（分量关系，逐格）——**轮次仍是全树合计**，它的语义不改。
   */
  subagentTurns: number | null;
  /**
   * **轮次 = 一次模型 API 往返**（用户口径，2026-09-28）：一次请求带着 role=user 的上下文、
   * 模型回一条 role=assistant 的答复，算一次。三家各自从自己的事件流里数（口径见各家的
   * `providers/<kind>/events.ts`），不混用「CLI 自己的 turn」——codex 的 `turn.completed` 与
   * dsh 的 `turn/end` 都是**整段任务**一条，照它们数出来永远是 1。
   * null = 一次都没观察到；绝不填 0。
   */
  turns: number | null;
  durationMs: number;
  error?: { code: AgentErrorCode; message: string; stack?: string };
  /**
   * 智能体的最终答复文本；null = 未采到。
   * 「未采到」与空串是两件事：前者是这一家没回传可读的最终消息、或本次运行没跑到那一步，
   * 后者是它明确回了一个空答复——与 tokens/turns 同一条「绝不填 0」的口径，不要互相兜底。
   * 用途：需要**结构化答复**的调用方（评分智能体）从这里取文本，而不是从事件流里重建
   * （codex 发增量 delta、dsh 的 assistant 文本不进事件流，重建三家各不相同且不可靠）。
   * 失败与终止的结论也带它：排障时要能回答「它到底说了什么」。
   *
   * ⚠️ **这是跨家契约，不是各家的实现细节**：一致性套件的「最终答复口径（§2.10）」按产物逐家钉住
   * 「有主会话答复就必须交得出」——漏写这一格的家会在套件上红（codex 在 app-server 重构里漏过一次，
   * 各家自己的用例全绿而真机评分永远拿不到答复，见 `docs/faq/codex.md`）。
   */
  finalText: string | null;
  /**
   * 这一次**实际按能力处置成了什么**（A1）。必填：调用方据此记账（`ScoreResult.structuredOutput` 就是它），
   * 缺格会让"降级了吗"变成"没采到"。
   */
  applied: {
    /** schema 是否**真的下发给了适配器**（false = 该家不支持，或本次压根没要求 schema） */
    structuredOutput: boolean;
  };
}

/** 注册表元数据（§5.6.2 的表）：协议兼容性 / 行级能力 / 消息能力 / 档位域的**唯一**查询点（A3） */
export interface AgentProviderMetadata {
  /**
   * 该智能体**能接受**的协议集合（非空、去重）：表单的候选池过滤、创建校验、评分智能体校验与
   * 编排层复检**四处都读它**，判据用 `acceptsProtocol()`，不许各写一份。
   *
   * 为什么是集合而不是单值（契约 §11 **R37** 的收口，2026-09-30）：R37 当时按实测把 dsh 钉成
   * `anthropic`，但逐字登记了残留不确定性——「未验证 dsh 是否也支持 chat-completions；若将来发现
   * 它同时支持多条 wire，`protocolType` 这个单值字段需要重新设计（改成数组或加 `protocolTypes`）」。
   * 2026-09-30 的真机探测确认 dsh 侧存在第二条 wire（pi-ai 路由同时讲 `anthropic-messages` 与
   * `openai-responses`，两条都跑通含计量）⇒ 按当时的预案改成集合。
   * 探针与结论：`docs/protocols/dsh.md`。
   *
   * claude-code / codex 仍是单元素（它们各自只讲一条 wire），集合形状对它们只是多一层数组。
   */
  protocolTypes: readonly ProtocolType[];
  /** **行级**能力：这一家在「跑这一行」这件事上能做什么（内容级能力见下面的 `messageCapability`） */
  capability: {
    /** false ⇒ 「终止」按钮在该行上退化为「关闭运行时」，界面文案必须不同 */
    cancelMidTurn: boolean;
    /**
     * false ⇒ 该适配器采不到 token，界面显示「不支持计量」而不是 0。
     * 跑动期那一条 `usage` 事件是**上报值还是估算**由事件自带的 `tokensBasis` 说明（A2）——
     * 那是每一条事件的性质，不是这一家的静态属性，故这里没有对应的能力格。
     */
    usage: boolean;
    /**
     * 该适配器能不能把 `AgentRunInput.outputSchema` 落到实处（**必填**）。
     * 为什么必填而不是「可选 + 守卫」：可选会被默认成 false 而无人验证；`cancelMidTurn` / `usage`
     * 已经是必填，这里保持 `capability` 内部同一形状。
     *
     * **A1 起这一格只有一个消费方**：适配器在 `run` 里把它**转发**进 `TurnHooks.capability`
     * （`providers/<kind>/index.ts`），由骨架 `runTurn` 在 `start` 之前统一处置——`false` 且调用方
     * 要了 schema ⇒ **摘掉这一格**再交给 `start`，并在结果里记 `applied.structuredOutput = false`。
     * 调用方（编排层）因此**不再需要**先读这一格自己判能力。
     *
     * 「适配器拿到 schema 就报错」那道纵深防御**随 A1 删除**（spec D12）：降级口径只该有一处。
     * 代价：绕过 `run` 直接构造 `AgentRunInput` 的旁路不再报错——知情接受并登记（spec §10 R4）。
     */
    structuredOutput: boolean;
  };
  /**
   * **消息能力声明**（spec v3 §2.5 / §3.5）：这一家在**消息层**到底能拿到什么，逐格给出取值、
   * 取数通道与缺失原因，并带上「这一族能力成立的前提」（路由 / 模型 / 开关）。
   *
   * 为什么与上面的 `capability` 分开：那一组说的是**行级**能力（能不能中止、能不能计量、
   * 能不能约束结构化输出），这一组说的是**内容级**能力（思考正文、工具入参、工具结果、子任务、
   * 流式增量）。两组的问题、消费方与变化原因都不同，合成一组会让「计量采不到」与「思考正文
   * 拿不到」挤进同一格。
   */
  messageCapability: MessageCapability;
  /**
   * 该家能表达的思考强度档位（**完整值域**，spec D11 的表）。**必填**并由 `registry.test.ts` 守卫：
   * 候选池的「上游档位 ∩ 智能体档位」交集（D10）全靠它，缺一格就是静默少一批可选档。
   * 值域依据：cc = Agent SDK 的 `EffortLevel`；codex = `codex app-server` 的 `ReasoningEffort`
   * （另加本仓统一的关闭档 `off`，适配器翻成 CLI 的 `none`）；
   * dsh = `llm-deepseek` 的 `reasoningEffort` schema（只认四档）。
   */
  reasoningEfforts: readonly string[];
  /**
   * 该家「**未选档位**时实际会用的档」（可选）。只有 dsh 声明它（`DSH_DEFAULT_EFFORT`）——
   * 它的「未选」会真的落到一个具体档上；claude / codex 不声明（未选由厂商推断，我们无从预知）。
   *
   * 为什么需要这一格：API 侧要拦「未选 + 该模型不支持那个缺省档」这种组合，否则要跑到
   * dsh 的硬校验处才失败（`UNSUPPORTED_REASONING_EFFORT`，症状离真因很远）。
   */
  defaultEffort?: string;
}

/** 一次运行的接口是函数而非类实例：编排层只按 kind 解析并调用（§5.6.2） */
export interface AgentProvider {
  readonly kind: AgentKind;
  readonly displayName: string;
  readonly metadata: AgentProviderMetadata;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/**
 * 一份**最宽松**的消息能力声明（六格全 `'yes'`、取数通道 `'wire'`）：给**包内测试夹具**用的默认值。
 * 为什么测试用「全 yes」而不是「全 unverified」：这些用例关心的是协议集合、档位域与运行骨架，
 * 一份 `unverified` 会反复断言同一件事而看不出差别；而**生产适配器必须各自显式声明**。
 * **不从包出口转出**（它今天只有包内消费方，出口面只该放跨包契约）。
 */
export function permissiveMessageCapability(): MessageCapability {
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
  };
}
