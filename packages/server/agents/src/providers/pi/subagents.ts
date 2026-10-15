/**
 * pi 的子智能体面：**装载白名单该扩展**、订阅它的生命周期事件、把事件折成子任务行。
 *
 * ## 为什么是「装载一个第三方扩展」而不是自己实现派发
 *
 * 裸 pi 没有子智能体入口（`docs/protocols/pi.md` 的接入结论），派发能力整条都在
 * `@tintinweb/pi-subagents` 里。它注册三个 LLM 可调工具（`Agent` / `get_subagent_result` /
 * `steer_subagent`）与一条 `/agents` 命令，子会话在同一进程里另起一个 pi 会话
 * （模型与网关凭据**继承父会话**，见下）。
 *
 * ⛔ **不许 `import` 它的 `dist/index.js`**：该包没有 `exports` 入口字段，而 `dist/index.js` 是
 * ESM-in-CJS（`package.json` 无 `"type": "module"`）⇒ Node 按 CJS 解析会直接 `SyntaxError`。
 * 唯一合法的装载通道是 `DefaultResourceLoader` 的 `additionalExtensionPaths`——它把路径交给 SDK
 * 自己的扩展装载器（认得 `.ts`），与 `noExtensions` 那条「只筛发现路径」互不干涉。
 *
 * ## 取数路径：扩展事件总线，不解析文本
 *
 * 扩展在 `pi.events` 上发 `subagents:started` / `subagents:completed` / `subagents:failed`，
 * 载荷是**结构化**的：`{id, type, description, result, error, status, toolUses, durationMs,
 * tokens, usage}`。这是本模块的**主源**——`usage` 与 `status` 都带真值，不需要解析任何中英文句子。
 *
 * `tool_execution_end.result.details` 是同一件事的**第二份**（`agentId` / `status` /
 * `subagentType` / `description` / `toolUses` / `turnCount` / `durationMs`），用作交叉核对：
 *   · 两处都有的格（`status`）不一致时**以总线为准**（它是子会话收场那一刻的记录，
 *     而 `details` 是 `Agent` 工具返回值里的一份快照——后台档下它在子智能体还没收场时就定下了）；
 *   · `turnCount` **只有** `details` 有（总线载荷里没有这一格）⇒ 它单独取，不拿 `toolUses` 顶替。
 *
 * ### 总线是**每行一份**的
 *
 * `DefaultResourceLoader` 的 `eventBus` 缺省时自己 `createEventBus()`（每次调用一个新
 * EventEmitter2），而本适配器**每行新建一个装载器** ⇒ 两行并发时各自的 `pi.events` 互不可见。
 * 这不是推测：装载器实例化那一行是 `this.eventBus = options.eventBus ?? createEventBus()`，
 * 且实测两个装载器各自 emit/on 互不可见。
 *
 * ### 收数在**扩展回调**里、产事件在**投影**里
 *
 * 与 `observer.ts` 同一条口径：厂商的扩展回调不在骨架的 try/catch 里，一次抛错就能带走整行。
 * 所以这里的回调**只记不改**（不发射器、不抛），子任务行由 `events.ts` 在投影里造出来。
 *
 * ## 子会话继承什么
 *
 * 模型与网关/密钥**继承父会话**（`dist/agent-runner.js` 的 `resolveDefaultModel(ctx.model, …)`
 * 与 `parentModelRuntime`）⇒ 本仓每 run 自注册的 provider 会原样进子会话，子智能体打的是同一台网关，
 * 不需要 `auth.json` / 宿主 CLI。**唯一不继承的是 `agentDir`**：它硬编码走 SDK 的 `getAgentDir()`
 * （只认进程级 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` 与 `~/.pi/agent`），而本适配器的
 * 硬不变量是绝不写 `process.env` ⇒ 子会话的**会话文件**与 settings/memory 落真实 `~/.pi`，
 * 并发 pi 行共享这一部分；**家目录不可写时整次派发以
 * `EPERM: operation not permitted, mkdir '<home>/.pi/agent/sessions/…'` 失败**（子任务行记 `failed`，
 * 不是「没跑到」）。**转写正文不在这里**——它落 `os.tmpdir()/pi-subagents-<uid>/…`（见 `transcript.ts`）。
 * 这是采纳该扩展时明确接受的代价，登记在 `docs/protocols/pi.md` 的已知边界里。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type { SubagentRecord, UsageTokens } from '@aieval/contracts';
import { AgentLoadError } from '../../errors';
import { asRecord, readNumber, readString } from '../../json';
import { readPiUsageTokens } from './message';

/** 扩展包名：解析失败时要**点名**（「声明挂了子智能体、实际没装」是假声明） */
export const PI_SUBAGENTS_PACKAGE = '@tintinweb/pi-subagents';

/** 这一家的派发工具名（扩展注册面里的那一个；白名单按档位收它，见 `permission.ts`） */
export const PI_SUBAGENT_DISPATCH_TOOL = 'Agent';

/** 该包在 `package.json` 的 `pi.extensions` 里声明的入口，相对包根（唯一被 SDK 认的那一份） */
const PI_SUBAGENTS_ENTRY = 'src/index.ts';

/**
 * 取**真实的** `node:module`。
 *
 * 打包器会把 `node:module` 的 `createRequire` 换掉，替换品的 `resolve()` 返回模块 id 而不是文件
 * 路径 ⇒ 打包后必然解析失败。`process.getBuiltinModule` 直接向 Node 取内置模块，绕开替换；
 * 静态导入只作不支持该 API 的运行时兜底。
 */
function createNodeRequire(from: string): NodeRequire {
  const builtin = process.getBuiltinModule?.('module') as typeof import('node:module') | undefined;
  const factory = builtin?.createRequire ?? createRequire;
  return factory(from);
}

/** 解析结果的形态判据：模块 id 既不是绝对路径，还可能带 `[external…]` 标记 */
function isFilesystemPath(value: string): boolean {
  return isAbsolute(value) && !value.includes('[external');
}

/**
 * 扩展入口的**绝对路径**（`additionalExtensionPaths` 要的就是它）。
 *
 * 解析基准是列表而不是单点：`import.meta.url` 在 Next 的服务端产物里指向 bundle 内的文件，
 * 而 `process.cwd()` 未必是本仓的包目录——单一基准都会在某些启动方式下失效。
 * 任一基准拿到文件路径即返回；全失败就按 `AGENT_LOAD_FAILED` **抛**，由装配面把这一行判成失败
 * （绝不静默少装一个扩展）：解析不出入口与「解析出来了但装载器没挂上」是同一类姿态，
 * 两者都归这一码、都由装配面点名包名。
 */
export function piSubagentsExtensionPath(anchors: readonly string[] = [import.meta.url, join(process.cwd(), 'noop.js')]): string {
  const failures: string[] = [];
  for (const anchor of anchors) {
    try {
      const manifest = createNodeRequire(anchor).resolve(`${PI_SUBAGENTS_PACKAGE}/package.json`);
      if (!isFilesystemPath(manifest)) {
        failures.push(`${anchor} ⇒ 非文件路径：${manifest}`);
        continue;
      }
      const entry = join(dirname(manifest), PI_SUBAGENTS_ENTRY);
      if (!existsSync(entry)) {
        failures.push(`${anchor} ⇒ 入口不存在：${entry}`);
        continue;
      }
      return entry;
    } catch (error) {
      failures.push(`${anchor} ⇒ ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new AgentLoadError(PI_SUBAGENTS_PACKAGE, new Error(`解析扩展入口失败（${failures.join('；')}）`));
}

/** 该扩展声明的版本（失败姿态与登记都要点名版本；读不到给 `null`，不编一个） */
export function piSubagentsVersion(extensionPath: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(extensionPath)), 'package.json'), 'utf8')) as unknown;
    return readString(asRecord(manifest), 'version');
  } catch {
    return null;
  }
}

/**
 * 总线载荷收窄后的形状（只声明本模块读的那几格；`tokens` **不读**——它是去掉 `cacheRead` 的
 * 展示用总和，读它会让子任务用量与主子用量不同尺，见 `readPiUsageTokens` 的口径）。
 */
export interface PiSubagentEvent {
  /** 子智能体身份（`AgentDetails.agentId` / 总线载荷的 `id`，同一套 id） */
  id: string;
  /** 派发的 agent 类型（总线载荷的 `type`，如 `general-purpose`） */
  type: string | null;
  /** 任务描述（与 `Agent` 入参的 `description` 同值） */
  description: string | null;
  /** 结果摘要（子智能体的最终答复）；取消 / 后台未收场时为 `null` */
  outcome: string | null;
  /** 厂商原文状态（`completed` / `error` / `stopped` / `aborted` / `steered` …） */
  rawStatus: string | null;
  /** 子智能体自己那一份用量（结构化；读数口径与主子完全一致，见 `readPiUsageTokens`） */
  usage: UsageTokens | null;
  /** 是不是终态事件（`completed` / `failed` 两档为真，`started` 为假） */
  settled: boolean;
}

/** 扩展面里本模块用到的那一格（收窄到用到的形状，不抄厂商的 `.d.ts`） */
export interface PiSubagentExtensionApi {
  events?: { on: (channel: string, handler: (data: unknown) => void) => void };
}

/** 一次运行的子智能体收数器 */
export interface PiSubagentRecorder {
  /** 扩展工厂：进 `DefaultResourceLoader({ extensionFactories })` */
  factory: (pi: PiSubagentExtensionApi) => void;
  /** 按身份取**最新**的那一条（`started` 先到、终态后到 ⇒ 后到的整条覆盖前一条） */
  latest: (agentId: string) => PiSubagentEvent | null;
  /** 已经收到**终态**事件的那些身份（顺序即到达顺序）；收尾据此补最后一次完整快照 */
  settledIds: () => string[];
  /**
   * 收到过 `subagents:started` 的那些身份（顺序即到达顺序）。
   *
   * 为什么要这一格：这一家的子任务行有**三条**投递通路，其中最要紧的是**派发那一刻**那条
   * （`Agent` 前台档是阻塞工具，只靠工具收尾那条通路的话整段运行期界面上没有卡片也没有入口）。
   * 总线载荷只有 `{id, type, description}` ⇒ 投影层拿它去与在飞的派发调用对账（见 `events.ts`
   * 的 `deliverStartedSubagents`）。
   */
  startedIds: () => string[];
  /**
   * 投递一条子任务行：**同一身份、同一内容只发一次**，重复的投递返回空数组。
   *
   * 为什么要在这里挡：同一个子智能体有**两条**投递通路——`Agent` 工具的收尾
   * （`projectDispatchEnd`，此刻可能还没收场 ⇒ 快照是半截的）与收尾对账
   * （`finalizePiSubagents`，总线到齐后的完整快照）。两条都发，磁盘上同一个 `subagentId`
   * 就是**两行**（真机：同身份、同终态、同报告的两条 `subagent` 记录）。
   *
   * 判据是**内容**而不是「发过没有」：收尾那一条若带来了新事实（后台档下这才第一次拿到终态
   * 与用量），它必须照发——那正是骨架「同一身份多次投递、后者是完整快照」那条约定要的补全。
   * 挡掉的只是**逐字相同**的重发，于是两条通路各自到达都不会在产物里留下重复行。
   */
  deliver: (record: SubagentRecord) => SubagentRecord[];
  /**
   * 已经投出过子任务行（无论哪条通路、哪份快照）的那些身份。
   *
   * 为什么要这一格：跑动期的转写增量以它为闸——消息必须晚于**它自己的子任务行**进账
   * （turn.ts 的骨架在同一批投影里先发消息、后发子任务行，同批混发会让这批消息在
   * 行到达之前被客户端归进主会话）。收数器是投递的唯一闸口，「谁已经出去过」只有它知道。
   */
  deliveredIds(): string[];
}

/**
 * 造一个收数器。**每行一份**：收的是这一行那次会话的扩展事件，跨行共享等于让两行并发的子任务
 * 互相串（与 `PiRunState` / 请求侧观察者同一条处置）。
 *
 * 回调里只做两件事——收窄载荷、写表（外加 `hooks` 的纯通知）。**不发射器、不抛**：那个时刻不在
 * 骨架的 try/catch 里，一次抛错就能带走整行（一次运行的价值远大于一条子任务行的即时性）。
 * `hooks`（可选）是总线事件的**旁听钩子**：`started` / 终态各报一次身份，不改收数器自己的账——
 * wire 通道（`subagent-wire.ts`）靠它启停订阅；挂在构造参数而不是接口成员上，因为它是一次性的
 * 接线输入，不是收数器运行期对外提供的能力。
 */
export function createPiSubagentRecorder(hooks?: { onStarted?: (agentId: string) => void; onSettled?: (agentId: string) => void }): PiSubagentRecorder {
  const byId = new Map<string, PiSubagentEvent>();
  const settled: string[] = [];
  /** 报过「开始」的那些身份（顺序即到达顺序；见 `startedIds`） */
  const started: string[] = [];
  /** 已经投递出去的那些行，按「身份 + 内容」记（见 `deliver` 的判据） */
  const delivered = new Set<string>();
  /** 已经投出过**任意一份**快照的身份（见 `deliveredIds`：跑动期转写增量的闸门） */
  const deliveredAgents = new Set<string>();
  const absorb = (data: unknown, isSettled: boolean): void => {
    const record = asRecord(data);
    const id = readString(record, 'id');
    if (id === null) return;
    const event: PiSubagentEvent = {
      id,
      type: readString(record, 'type'),
      description: readString(record, 'description'),
      outcome: readString(record, 'result'),
      rawStatus: readString(record, 'status'),
      usage: readPiUsageTokens(record?.['usage']),
      settled: isSettled,
    };
    byId.set(id, event);
    if (isSettled && !settled.includes(id)) settled.push(id);
    if (!isSettled && !started.includes(id)) started.push(id);
    // 钩子在收账**之后**纯通知：wire 通道据此启停，看到的已是登记完的事实
    if (isSettled) hooks?.onSettled?.(id);
    else hooks?.onStarted?.(id);
  };
  return {
    factory: (pi) => {
      // 扩展面缺 `events` 时**什么都不做**：这一行的子任务行会缺分量并落一条点名 WARN，
      // 而在回调里抛错会让整行连结论都没有
      if (typeof pi.events?.on !== 'function') return;
      pi.events.on('subagents:started', (data) => absorb(data, false));
      pi.events.on('subagents:completed', (data) => absorb(data, true));
      pi.events.on('subagents:failed', (data) => absorb(data, true));
    },
    latest: (agentId) => byId.get(agentId) ?? null,
    settledIds: () => [...settled],
    startedIds: () => [...started],
    deliver: (record) => {
      /**
       * 签名走完整序列化：这一行的每一格都是标量或 `null`（`usage` 是四个数），
       * 没有一个会序列化不了；字段顺序由同一个构造点固定，故同一份快照的签名逐字相同。
       */
      const signature = `${record.subagentId}|${JSON.stringify(record)}`;
      if (delivered.has(signature)) return [];
      delivered.add(signature);
      deliveredAgents.add(record.subagentId);
      return [record];
    },
    deliveredIds: () => [...deliveredAgents],
  };
}

/**
 * 厂商状态 → 契约的五态。
 *
 * 取值域来自扩展自己的 `AgentDetails.status`
 * （`queued` / `running` / `completed` / `steered` / `aborted` / `stopped` / `error` / `background`），
 * 映射判据：
 *   · `queued` / `running` / `background` ⇒ `running`（后台档派发后工具立刻返回，子智能体还在跑）；
 *   · `completed` / `steered` ⇒ `completed`（`steered` 是「撞到轮次上限后收尾」，它有结果）；
 *   · `stopped` / `aborted` ⇒ `stopped`（被停下的，不是跑错的）；
 *   · `error` ⇒ `failed`；
 *   · 认不出的取值 ⇒ `unknown` + `not-observed`（**不猜**：把没见过的状态翻成 `completed`
 *     会让一次失败的派发在界面上显示成跑完了）。
 */
export function piSubagentStatus(raw: string | null): Pick<SubagentRecord, 'status' | 'statusMissing'> {
  switch (raw) {
    case 'completed':
    case 'steered':
      return { status: 'completed', statusMissing: null };
    case 'error':
      return { status: 'failed', statusMissing: null };
    case 'stopped':
    case 'aborted':
      return { status: 'stopped', statusMissing: null };
    case 'queued':
    case 'running':
    case 'background':
      return { status: 'running', statusMissing: null };
    default:
      return { status: 'unknown', statusMissing: 'not-observed' };
  }
}

/** 造一条子任务行（唯一的构造点：字段来源与取舍写在下面） */
export function piSubagentRecord(params: {
  agentId: string;
  name: string | null;
  rawStatus: string | null;
  outcome: string | null;
  /** 派发它的那次 `Agent` 工具调用 id（`tool_execution_*` 的 `toolCallId`） */
  parentCallId: string | null;
  usage: UsageTokens | null;
}): SubagentRecord {
  const { status, statusMissing } = piSubagentStatus(params.rawStatus);
  return {
    subagentId: params.agentId,
    name: params.name,
    /**
     * 派发方式 = 那次工具调用的名字（与 codex 的 `dispatch.tool` 同一口径）。
     * 这一家的派发工具只有一个名字，故是常量；写成常量而不是取运行时值，是因为它来自
     * 扩展的注册面（`SUBAGENT_TOOL_NAMES.AGENT`），不是这一次调用的数据。
     */
    kind: PI_SUBAGENT_DISPATCH_TOOL,
    source: 'wire',
    status,
    statusMissing,
    outcome: params.outcome,
    /**
     * ⚠️ 这一家的**嵌套子任务恒 `null`**：扩展只给**顶层**子智能体发生命周期事件
     * （`isTopLevelAgent` 过滤），被派发的子会话自己再派发的那些属于它自己，
     * 父会话的事件流里一个字都没有 ⇒ 本适配器产出的行**全是顶层**，没有父链可挂。
     * **给不出时记 `null`，不猜。**
     */
    parentSubagentId: null,
    parentCallId: params.parentCallId,
    usage: params.usage,
  };
}

/** `Agent` 工具结果里的 `details`（交叉核对源）→ 本模块认的那几格 */
export interface PiSubagentDetails {
  agentId: string | null;
  description: string | null;
  rawStatus: string | null;
  /** 子智能体自己的模型往返数（**只有这里给**：总线载荷里没有这一格） */
  turnCount: number | null;
}

export function readPiSubagentDetails(result: unknown): PiSubagentDetails {
  const details = asRecord(asRecord(result)?.['details']);
  return {
    agentId: readString(details, 'agentId'),
    description: readString(details, 'description'),
    rawStatus: readString(details, 'status'),
    turnCount: readNumber(details, 'turnCount'),
  };
}
