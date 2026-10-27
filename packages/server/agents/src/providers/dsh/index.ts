/**
 * dsh 适配器：路由注入 + 关闭式释放，入口形态以真实探测为准。
 * 两条关键差异都来自厂商元数据：
 *  - `cancelMidTurn: false`：SDK 没有 wire-level cancel（`HarnessClient.close()` 的 JSDoc 逐字），
 *    所以 `interrupt()` 是**刻意**的空实现，停止只能靠关闭运行时 ⇒ 终止与超时一定走释放兜底的第二段
 *    （等 5 秒、落一条 WARN、再强制关闭，界面上会看到这行晚 5 秒变 canceled）；
 *  - 通知流必须**先订阅再交提示词**：唯一的事件通道是客户端订阅，而
 *    `harness.run(prompt, { sessionId })` 在**下一次 idle** 才落定（`lib/index.js` 的
 *    `HarnessSession.run`，0.2.1-alpha.3 在 800-839 行）。
 *    顺序错了会丢掉开头那批事件（含 `turn/start`），所以订阅由**流自己**建立，`start()` 里不碰它。
 *
 * **注入模型**（判据与探测结论见 `docs/protocols/dsh.md` 的「pi-ai 路由与两条 wire」）：
 * 本次运行统一走 **pi-ai 路由**，
 * 协议决定 wire（`anthropic → anthropic-messages`、`openai → openai-responses`）。
 * 四个落点：
 *  1. **per-run overlay**（`<configHome>/aieval-route.patch.yml`，见 `DSH_ROUTE_PATCH_RELATIVE_PATH`）——
 *     路由 / `baseURL` / 模型 / 档位 / `ask_user_question` 的挂载都写在这里，作为 `--patch` 交给 dsh；
 *  2. **子进程环境**（`buildSubprocessEnv` 的替换型语义）：配置根 `DSH_HOME`、**自定义**凭据变量
 *     `AIEVAL_ROUTE_API_KEY`，以及 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 的**显式删除**（见 `startDsh`）；
 *  3. **权限档** `DSH_PERMISSION_MODE`：本适配器按运行阶段**显式**定档，不吃 dsh 的默认值（见 `permission.ts`）；
 *  4. **握手预算** `initializeTimeoutMs`：SDK 默认 10s 对冷启动不够（见 `DSH_INITIALIZE_TIMEOUT_MS`）。
 *
 * 已退役：`<configHome>/settings.yaml`（旧版本迁移 shim）、`DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY`
 * 这条注入通道、以及本适配器对 `profiles/sdk/cordis.patch.yml` 的整份重写（见 `DSH_LEGACY_PROFILE_PATCH_RELATIVE_PATH`）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger, materializeSkills } from '@aieval/core';
import type { McpServers, UsageTokens } from '@aieval/contracts';
import { logDraft, type AgentEventDraft } from '../../emit';
import { hostNpmrcPath, quoteYaml, readNpmrcText, toDshMcpPluginLines, writeCandidateNpmrc } from '../../mcp';
import { sendableRequestHeaders } from '../../request-headers';
import { DSH_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix, stripV1Suffix } from '../../route';
import { asSchemaObject, buildStructuredOutputInstruction } from '../../structured-output';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult, ProtocolType } from '../../types';
import {
  DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH,
  DSH_ASK_ANSWERER_PLUGIN_SOURCE,
  DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH,
  DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH,
  DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS,
  DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS,
  startDshAskAnswerer,
  type DshAskAnswererBridge,
} from './ask-user';
import { projectDshNotification, type DshDispatchStart, type DshProjectionRunState } from './events';
import {
  DSH_INJECT_PLUGIN_RELATIVE_PATH,
  DSH_INJECT_PLUGIN_SOURCE,
  DSH_INJECT_QUEUE_RELATIVE_PATH,
  DSH_INJECT_RECEIPTS_RELATIVE_PATH,
  startDshInjection,
  type DshInjectionDriver,
} from './inject';
import { countSessionSteps } from './session-log';
import {
  dshSessionPermissionOf,
  seedDshSessionRoundHighWater,
  dshSessionRoundOf,
  dshSessionUsageOf,
  dshSilentChildSessions,
  dshSubagentTurns,
  dshSubagentUsage,
} from './message';
import {
  DSH_STREAM_FAILURE_TYPE,
  DSH_SUBAGENT_FINISHED_METHOD,
  DSH_TURN_END_TYPE,
  dshChildSessionIdentities,
} from './protocol';
import {
  DSH_PACKAGE_NAME,
  loadDshSdk,
  type DshHarness,
  type DshNotification,
  type DshRuntime,
  type DshSessionHandle,
} from './sdk';
import {
  createDshStreamTapGate,
  DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH,
  DSH_STREAM_TAP_PLUGIN_SOURCE,
  DSH_STREAM_TAP_POLL_MS,
  DSH_STREAM_TAP_RELATIVE_PATH,
  type DshStreamTapGate,
} from './stream-tap';

const logger = createLogger('agents/dsh');

/** 与 SDK 内部 `session()` 的生成口径逐字一致（`session-` + 去掉连字符的 uuid），便于与 dump 对照。 */
function mintSessionId(): string {
  return `session-${randomUUID().replaceAll('-', '')}`;
}

/**
 * 读 adopt 出来的会话的有效 cwd，**失败给 `null`**（只用于 DEBUG 日志那一格）。
 *
 * 为什么吞错：这一格是**观测**，不是运行前提。`session/working-directory/get` 是一次真实 wire
 * 往返（runtime 已收场、超时、连接断了都会拒），写成不可失败的表达式就等于让「读一个排障读数」
 * 拥有把整轮折成 `AGENT_FAILED` 的权力——观测手段没有资格制造失败。
 * 读不到与「没有这一格」在日志里都是 `null`，这是可接受的降级（真值仍在会话自己的 cwd 里）。
 */
async function readWorkingDirectoryOrNull(
  session: { getWorkingDirectory?: () => Promise<string> },
): Promise<string | null> {
  try {
    return (await session.getWorkingDirectory?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * 本次运行声明的**路由键**：`llm-pi-ai` 的 `providers` 字典键，也是交给 harness 的 `provider`
 * 以及 `llm.listProviders()` 里的 provider id（三者必须逐字相同，否则 `initialize` 会以
 * `no adapter registered for provider "…"` 收场）。
 * 选这个名字是因为实跑的 `pi-ai@0.85.1` catalog 的 39 个 provider 键里没有它——撞上 catalog 键会让
 * 「手声明路由」变成「收窄某个 catalog 路由」，语义完全不同。
 */
export const DSH_ROUTE_KEY = 'aieval-route';

/**
 * overlay patch 相对 `configHome` 的落点。
 * 为什么是 per-launch overlay，而不是 `settings.yaml` 或 profile patch 文件：
 *   · `settings.yaml` 是**旧版本迁移 shim**（dsh-settings 启动即改名 `.imported` 再逐段 `update()`），
 *     把新能力压在一条将来会消失的兼容层上不划算；
 *   · `profiles/sdk/cordis.patch.yml` 是 **dsh 自己的持久化层**（Settings / config-editor 会写它），
 *     而本适配器整份重写它——两者混在一份文件里，排障时分不清是谁写的；
 *   · `--patch` overlay 是最高层（bundle → profile → home → CLI），dsh 自己不写它。
 */
export const DSH_ROUTE_PATCH_RELATIVE_PATH = 'aieval-route.patch.yml';

/**
 * 凭据引用名：overlay 里 `apiKeyEnv` 写的名字与子进程环境里的键名**必须逐字一致**。
 * 值走 `buildSubprocessEnv` 的替换型子进程环境（不写 `process.env`），由 pi-ai 逐请求经
 * credential seam 解析。
 */
export const DSH_ROUTE_API_KEY_ENV = 'AIEVAL_ROUTE_API_KEY';

/**
 * 初始 profile 握手的墙钟上限（毫秒）。
 *
 * 为什么**不能**吃 SDK 的默认值（10000，`launch.d.ts` 的 `DEFAULT_INITIALIZE_TIMEOUT_MS`）：
 * 每个本次运行都跑在一个**全新的 `configHome`** 上（不变量 3），于是每次运行都是冷启动，
 * dsh 要解析整棵插件树才回 initialize。实测（`probe/v3/dsh-adapter-dual-protocol.mts`）：
 * 默认 10s 下 anthropic 与 openai **两条协议双双**以
 * `initialize timed out after 10000ms waiting for dsh profile "sdk"` 失败，被折成 `AGENT_FAILED`——
 * 症状（「本次运行失败了」）离真因（握手预算给小了）很远，而它与协议、凭据、overlay 内容都无关。
 *
 * 取值依据：探测在相同的冷启动形状下用的就是 60s（`probe/v3/lib/harness.mjs` 的
 * `initializeTimeoutMs`，注释逐字写着「冷启动要解析整棵插件树；默认 10s 会偶发 initialize 超时」），
 * 那是本次唯一有执行的级证据的值。这不是「执行超时」——用户口径是执行不限时间；它只是**握手**的上界，
 * 真正起不来的 dsh 仍然会被挡住，而不是永远挂着。
 */
export const DSH_INITIALIZE_TIMEOUT_MS = 60_000;

/**
 * 档位域与它在本条路由上的 **wire 拼写**——两者放一起是刻意的：注册表元数据（`reasoningEfforts`）
 * 与 overlay 声明**同源派生**，不可能漂移。漂移的代价不是「少显示一个选项」：界面上能选而 patch 里没有
 * ⇒ dsh 在 `initialize` 阶段以 `UNSUPPORTED_REASONING_EFFORT` 收场，用户**选完到运行时才失败**。
 *
 * 值怎么定的（真机实测）：
 *   · `off: null` ⇒ pi-ai 生成 `thinkingLevelMap` 时**不写入 `off` 键**，于是 harness 不传 reasoning，
 *     实测落到 `thinking:{type:'disabled'}`（Messages）/ `reasoning:{effort:'none'}`（Responses）——
 *     即「显式关闭」，而不是「什么都不发」（后者只在整份不写 `off` 键时成立）；
 *   · 其余三个原样透传：Responses 的 OpenAI 枚举里其实**没有 `max`**，但实测该网关对
 *     `none/minimal/low/medium/high/xhigh/max` **七种全部 200**（pi-ai 也不做枚举校验），故不降级。
 *     换网关若拒 `max`，在这里改一格即可（界面仍是四档——档位域是智能体的能力，不是网关的词汇表）。
 */
const DSH_REASONING_WIRE: Readonly<Record<string, string | null>> = {
  off: null,
  low: 'low',
  high: 'high',
  max: 'max',
};

/** 该家能表达的档位（**完整值域**）：由上面那张映射表的键派生，避免两处各写一份 */
const DSH_REASONING_EFFORTS: readonly string[] = Object.keys(DSH_REASONING_WIRE);

/**
 * 未选档位时**显式**使用的缺省档（用户口径：「不能默认关闭，必须显式配置」）。
 *
 * 为什么 dsh 不能「不传」：这一家的「不传」落到 `reasoning:{effort:'none'}`（= 关闭）。
 * 用户口径要求未选时仍然思考 ⇒ 缺省必须给一个非 `off` 的档。
 * 与 `DSH_REASONING_WIRE` 同源：`index.test.ts` 有一条守卫断言它在档位域里且不是关闭档。
 */
export const DSH_DEFAULT_EFFORT = 'high';

/** 协议 → pi-ai 的 wire 名（`openai` **只**走 responses，不映射 chat-completions） */
export function wireForProtocol(protocolType: ProtocolType): 'anthropic-messages' | 'openai-responses' {
  return protocolType === 'openai' ? 'openai-responses' : 'anthropic-messages';
}

/**
 * 按 wire 归一化 baseURL（计划 **D8**）。
 *
 * 为什么必须由我们做：pi-ai **不做任何归一化**——模型请求收到的是配置原样的 baseURL
 * （只有 discovery 的列表 URL 会归一化 `/v1` 段，见其 README）。实测：
 *   · `anthropic-messages` → `{baseURL}` 原样 + `/v1/messages?beta=true`
 *     ⇒ 尾部带 `/v1` 的地址会变成 `/v1/v1/messages`；
 *   · `openai-responses` → `{baseURL}` 原样 + `/responses`，**不插 `/v1`**
 *     ⇒ 裸 host 会打到 `{root}/responses`。
 * 所以复用本仓已有的两个规范化函数（与 claude / codex 两侧同源）：anthropic 剥尾 `/v1`、openai 补 `/v1`。
 *
 * 等价于旧路 `keepBaseUrl` + `llm-deepseek`（它自己「没 `/v1` 就补、有就保留」再追加
 * `/messages`）在两条分支上与 `stripV1Suffix` + pi-ai 的结果**逐字相同**。
 */
export function baseUrlForWire(baseUrl: string, protocolType: ProtocolType): string {
  return protocolType === 'openai' ? ensureV1Suffix(baseUrl) : stripV1Suffix(baseUrl);
}

/** `buildDshRoutePatch` 的输入：**只收事实**（协议 / 地址 / 模型 / 能力），不收「写去哪」 */
export interface DshRoutePatchInput {
  protocolType: ProtocolType;
  /** 供应商地址（**未归一化**；归一化按协议在里面做） */
  baseUrl: string;
  modelId: string;
  /** 上下文窗口；缺省 = 未知 ⇒ **不写这个键**（不兜底成默认值） */
  contextWindow?: number;
  /** 单次输出上限；缺省 = 未知 ⇒ 不写 */
  maxOutputTokens?: number;
  /**
     * 本次运行要注入的 MCP 条目；缺省 / 空集 ⇒ **一行插件都不插**。
   * 收的是 canonical 形状（与另两家同一份），翻译在 `toDshMcpPluginLines` 里一处完成。
   */
  mcpServers?: McpServers;
  /**
   * 这一轮挂没挂**应答面**（= 调用方传了 `onAskUser`，见 `ask-user.ts`）：它同时决定
   * 「插不插应答者那一行」与「等待档取哪一档」。两处若各写一份必然漂移，而漂移的表现是
   * 「插件在、没人认领」或「有人认领、等待档却先到点收场」——两种都只在真机上现形。
   */
  askUserAnswerer?: boolean;
  /**
   * 这一轮挂没挂**人工消息面**（= 调用方传了开着的 `inject` 端口，见 `inject.ts`）：
   * `'round'` 档与撤回都只能走进程内插件 ⇒ 这一格决定插不插那一行。
   * 没挂 ⇒ 一本次运行都不插、插件也不落盘（「不进人工消息就一处都不动」在磁盘上就是这样）。
   */
  injectMessages?: boolean;
  /**
   * 自定义请求头：落到 `llm-pi-ai` 路由的 `headers` 格（每条路由自己的请求头）。空集 ⇒ 这一块整个不出现。
   *
   * 两条厂商侧的边界（都不在本仓能改的范围里）：
   *   · **attribution 头恒赢**：`llm-pi-ai` 组装请求前会按名字（不区分大小写）滤掉保留头
   *     （Harness 自己的归属头），用户填了同名只会被静默丢掉——那不是故障，是厂商的保留名单；
   *   · **值按字面发送，不做 `${ENV}` 插值**：与 MCP 的占位语义刻意不同（见 `AgentRunInput.requestHeaders`）。
   * 此外这一格在装配期会过 `new Headers([[名, 值]])`：发不出去的值会让**整次启动失败**，
   * 所以调用方必须先过 `sendableRequestHeaders`（本文件的调用点已经这么做了）。
   */
  headers?: Record<string, string>;
}

/**
 * 生成 per-launch overlay patch 的 YAML 文本（**纯函数**：无时间戳、无随机、无环境读取）。
 *
 * 两段内容：
 *   ① `- id: llm-pi-ai` 的 **id 定向覆盖**——patch 语义是「整份替换本次运行的 config，不是深合并」
 *      （dsh-base 的文件头逐字），所以我们只声明本次运行要用到的那一条路由与那一个模型；
 *   ② `- insert:` 把 `ask_user_question` 挂进 profile——**新增行必须走 insert**，
 *      顶层 `- id:` 只能改或禁既有行。同一份 insert 里还有我们自己那两个插件行
 *      （stream-tap 与提问应答者），各自的落点与相对名基准见 `stream-tap.ts` / `ask-user.ts`。
 *
 * ⚠️ 字符串一律双引号 + 转义：模型名可能含 `:`（`jd/GLM-5.3`）或 `"`，裸写会被 YAML 解析成别的结构。
 * 判据是**读回来逐字相等**，而不是「文件里出现了某个字符串」。
 */
export function buildDshRoutePatch(input: DshRoutePatchInput): string {
  const effortLines = Object.entries(DSH_REASONING_WIRE)
    .map(([level, wire]) => `              ${level}: ${wire === null ? 'null' : quoteYaml(wire)}`);
  return [
    '# 由 ai-result-evaluation 写入：本次运行的路由、模型与档位（overlay，叠在 profile 之上）',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${DSH_ROUTE_KEY}:`,
    `        api: ${wireForProtocol(input.protocolType)}`,
    `        baseURL: ${quoteYaml(baseUrlForWire(input.baseUrl, input.protocolType))}`,
    `        apiKeyEnv: ${DSH_ROUTE_API_KEY_ENV}`,
    // 自定义请求头：每条路由自己的 `headers`（见 `DshRoutePatchInput.headers` 的两条边界）。
    // 键值一律走 `quoteYaml`：头名里可能有 `-`、值里可能有 `:`，裸写会被 YAML 解析成别的结构。
    ...(input.headers === undefined || Object.keys(input.headers).length === 0
      ? []
      : [
        '        headers:',
        ...Object.entries(input.headers).map(([name, value]) => `          ${quoteYaml(name)}: ${quoteYaml(value)}`),
      ]),
    '        models:',
    `          - id: ${quoteYaml(input.modelId)}`,
    ...(input.contextWindow === undefined ? [] : [`            contextWindow: ${input.contextWindow}`]),
    ...(input.maxOutputTokens === undefined ? [] : [`            maxTokens: ${input.maxOutputTokens}`]),
    '            reasoningEfforts:',
    ...effortLines,
    '',
    '# 新增行必须走 insert（顶层 `- id:` 只能覆盖既有行）——见 dsh-base 的文件头',
    '- insert:',
    '    - id: tool-ask-user',
    '      name: "@deepseek-ai/dsh-tool-ask-user"',
    // 等待档：**与应答面同源派生**（见 `ask-user.ts` 的两个常量各自的取值理由）——
    // 挂了应答面走阻塞档（`-1`：既不到点收场、又带 `wait.callId`），没挂走定时档 1 秒
    //（到点交回厂商设计好的「待答」结果，而不是让模型一问就吃一个工具错误）。
    // ⚠️ 四处口子，改本次运行之前先读：
    //   ① `timeout: -1` **不构成**定时档——源码只在 `timeout !== -1` 时才走定时档，`-1` 回落阻塞档；
    //      而这一格的工具描述主动鼓励模型在「不给答案就没法继续」时传 `-1` ⇒ 那一问照样拿到工具错误。
    //   ② 定时档的 schema 比阻塞档**多一个模型可见参数** `timeout`（`TIMED_WAIT_PARAMETER`），且 dsh
    //      判定「本次运行是哪一档」读的是 `request/header` 里记下的**工具 schema**
    //      （`isTimedAskUserQuestionSchema`）、不是调用实参 ⇒ 档位只能落在装配产物上。
    //   ③ 守卫钉的是**配置文本**、钉不到模型实参：定时档的效果是「**默认**不报错」，不是「免疫」。
    //   ④ 「待答」这一格契约里今天没有（本适配器不改契约）⇒ 它在模型眼里与一个普通工具结果无异；
    //      且那句「用户还能答」只对**没挂应答面**的那一档是假的（那一档本来就没人在看界面），
    //      模型可能在「继续干」与「再问一次」之间反复。
    '      config:',
    '        mode: "timed"',
    `        timeout: ${input.askUserAnswerer === true
      ? DSH_ASK_WAIT_TIMEOUT_ANSWERED_SECONDS
      : DSH_ASK_WAIT_TIMEOUT_UNANSWERED_SECONDS}`,
    // stream-tap 插件（流式增量旁路，见 `stream-tap.ts`）：**相对名**按 `<dshHome>` 解析
    //（overlay 里写 `./<文件名>`，插件文件由适配器在同一次启动里落到 `configHome` 根）。
    // 纯 node: 内建依赖 ⇒ 不需要 profile 的 pnpm 安装（与 `tool-ask-user` 不同，那个是包名）。
    '    - id: aieval-stream-tap',
    '      name: "./aieval-stream-tap.mjs"',
    // 提问应答者（见 `ask-user.ts`）：**只在挂了应答面时**才有本次运行。没挂应答面时不插、
    // 插件文件也不落盘——厂商那个提问工具照旧 fail-closed，「不问就不动」在磁盘上就是这样。
    ...(input.askUserAnswerer === true
      ? [
        '    - id: aieval-ask-answerer',
        '      name: "./aieval-ask-answerer.mjs"',
      ]
      : []),
    // 人工消息面（见 `inject.ts`）：契约的 `'round'` 档与「撤回已投递」在 wire 上都没有落点，
    // 只能由本次运行插件在 runtime 进程内接出来。**只在挂了注入端口时**才有本次运行。
    ...(input.injectMessages === true
      ? [
        '    - id: aieval-inject',
        '      name: "./aieval-inject.mjs"',
      ]
      : []),
    // MCP：一台 server = 一行 `@deepseek-ai/dsh-mcp-client`，**同样走 insert**
    // （顶层 `- id:` 只能改或禁既有行）。空集时这里一本次运行都不加——不写空壳行。
    ...toDshMcpPluginLines(input.mcpServers ?? {}),
    '',
  ].join('\n');
}

/**
 * 一次运行的**取数面**：通知流的放行判据与投影共用这两张集合。
 *
 * 为什么提到 run 作用域（原来是藏在 `notificationStream` 里的局部变量）：投影要按**同一份**
 * 白名单算「子智能体那一份」用量，而投影在流的外面（骨架逐条调用 `project`）——
 * 流里那个 `const childSessions` 投影根本看不见。
 */
export interface DshRunState extends DshProjectionRunState {
  /** 本次运行的**子会话白名单**：只在这里面的会话才计入「子智能体那一份」 */
  childSessions: Set<string>;
  /** 已收场的子会话（`subagent.finished`）：投影据此把「收场了却没报用量」判成事实缺失（null） */
  finishedSessions: Set<string>;
  /**
     * 上一条 `request/header` 的工具表：`request/header` 每个 step 都投一条，
   * 而投影只在表**变了**的时候发 `vendor-system`（否则同一份几十 KB 的表会被抄 N 遍）。
   */
  headerTools: string[] | null;
  /**
   * 上一条 `user/message`（`source.kind === 'skill-catalog'`）里的**技能目录**：厂商说本次运行
   * 有哪些 skill（真机全轮恰好一条）。与 `headerTools` 同一处置——只在清单变了的时候发事件，
   * 且**两条通道各自发出时都要带上对方那一格**（消费方取最后一条读，缺一格就等于把它抹掉）。
   * `null` = 还没采到（不是「清单是空的」）。
   */
  skillCatalog: string[] | null;
  /**
   * 派发记账三格（见 `DshProjectionRunState` 的说明）：厂商的 `subagent.*` 通知里没有派发调用 id，
   * 而子任务行要落进界面上的某一轮就必须有它（或一个有区分力的名字）⇒ 投影在父会话的 `tool/call`
   * 上记一笔、目录项到时认领一次，收尾那条再带上同一格。三格都**必需**（不是可选）：
   * 少传一格就是「派发行永远落不进任何一轮」这种静默故障。
   */
  dispatchStarts: Map<string, DshDispatchStart>;
  claimedDispatches: Map<string, string>;
  deliveredStarts: Map<string, string>;
}

/**
 * 把一次 `harness.run()` 通知流包成骨架要的 `AsyncIterable`。
 * 为什么不挂 `onNotification`：那个回调要等 `run()` 被调用之后才存在，而适配器要的是
 * 「迭代一开始就等于订阅已建立」——所以这里**自己订阅**，并把 run 的 promise 当**结束信号**
 * （它在会话下一次 idle 时落定，最后一条通知恰好是 `session.status: idle`）。
 *
 * **放行判据是「会话树」而不是「同一个会话」**（用后者会漏掉子会话的事件）：
 *
 * 「认领第一个带 `sessionId` 的通知，之后只放行同一个 id」这条判据不成立：**子智能体的会话事件
 * 在同一条通知流里**（SDK 类型面写的就是「for the root session and discovered descendants」），
 * 子会话的 `params.sessionId` 是**子会话自己的 id** ⇒ 那一条判据把子智能体的
 * `assistant/message` / `tool/call` / `tool/result` **全部丢掉**。用户可见的形状：
 * dsh 的子任务占位条在、点进去**一个字都没有**（一整轮跑完，落盘文件里只出现过
 * 主会话一个 id，而探针在订阅口上明明收到了第二个 id）。
 *
 * 放行规则（三条）：
 *   1. **不带会话归属的通知一律放行**——`subagent.started` / `subagent.finished` 是**顶层通知**
 *      （没有 `params.sessionId`），它们正是「谁是子会话」的唯一来源，丢了就再也认不出来；
 *   2. **本会话（`sessionId` 参数那个 id）的事件一律放行**；
 *   3. **已发现的子会话的事件放行**。子会话靠 `subagent.started` 载荷里的身份认出来
 *      （真机那一对是 `{parentSessionId, childSessionId}`——身份格是 `childSessionId`，
 *      见 `protocol.ts` 的 `dshChildSessionIdentities`）；子会话的**第一条**事件有没有义务带身份
 *      取决于厂商是哪一档派发，缺开头时那一条可能被挡掉，从第二条起就通了。
 *      挡掉的只是「子会话的第一个事件」，状态与后续消息照常到达
 *      （读侧按会话 id 覆盖累积，对缺开头本来就宽容）。
 *
 * 为什么不干脆「凡带 sessionId 的都放行」：同一个 harness 实例在多行之间共享，
 * 放行全部会话等于把**别的行**的事件混进本次运行的落盘文件——那比丢几条更难查。
 */
function notificationStream(
  harness: DshHarness,
  sessionId: string,
  prompt: string,
  runState: DshRunState,
  tap: DshStreamTapGate,
  runPrompt: (prompt: string) => Promise<unknown>,
  /** 「我们自己已经发起关闭了」的读法（见 `disposeRuntime` 那一格的注释） */
  isClosing: () => boolean,
  /**
   * **收流前**的等待钩子（`settled` 之后、`break` 之前调一次）：返回 `true` 表示「真等过」，
   * 循环要回到顶部把这段时间里到达的通知消费掉。`null` = 不等。
   *
   * 为什么由外面传进来：本函数是模块级的，看不到 `startDsh` 里的 `runState` / `sessionId` /
   * 运行时句柄；而「等子会话收场」要读这三样。
   */
  beforeSettle: (() => Promise<boolean>) | null,
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      /**
       * **投送计数**：过滤器对每条被投送的通知调用一次，与 `received` 的差额是
       * 「断在消费侧还是投送侧」的唯一判据（排障的关键一格）。
       *
       * ⚠️ 声明在 `subscribe()` **之前**：过滤器可能被同步调用，而闭包里的 `let` 那时还没初始化
       * （TDZ 抛错会被 SDK 判成「过滤器抛错」⇒ 这条订阅当场 detach，整段对话静默消失）。
       */
      let deliveredNotifications = 0;
      /** 收流前那次等待只做一次（等完要回到循环顶部消费通知，不能每圈都等） */
      let settleWaited = false;
      const subscription = harness.client.subscribe((notification: DshNotification) => {
        deliveredNotifications += 1;
        /**
         * ⚠️ **过滤器绝不许抛**（真机事故的直接教训）：
         * SDK 的 `NotificationSubscriptionImpl.push()` 有一条硬语义——**过滤器抛错 = 这条订阅当场
         * detach 并带上终态错误**（`unsubscribe()` + `fail(error)`），此后 `next()` 立刻拒绝，
         * 而**兄弟订阅与传输读循环都不受影响**（也就是说：SDK 自己的那条订阅照常跑到收尾，
         * 我们这一条悄悄死了，外面完全看不出区别）。
         * 原样写这三本次运行就等于把「通知流的生死」押在三个纯函数的健壮性上，而它们的失败模式是
         * **整段对话静默消失**：真机 run `7f05c765` 的 dsh 行，厂商会话日志 201 条事件、
         * 我们只收到前 13 条（+56ms 后彻底断），那次运行照旧判 `judged`、执行日志整段空白。
         * 故这里 **fail-open**：抛了就记 ERROR、放行该条，绝不把一条通知的解析问题升级成
         * 「这一轮的内容全不要了」。
         */
        try {
          noteChildSession(notification, sessionId, runState.childSessions, runState);
          /**
           * 这两笔登记发生在**过滤器**里（投送时），而投影在消费时读它们 ⇒ 投影可能提前看到
           * 「一条之后才轮到的事实」（已收场集合里先有了下一个子会话）。后果只有一种、
           * 且是安全方向：`subagentTokens` / `subagentTurns` 可能**早一条**变成 `null`
           * （「没采到」），而那个事实本身是真的——下一批带轮次的出口会把同一个结论再交一次。
           * 反过来把登记挪到消费侧则不安全：子会话的**第一条**事件会在它的 `subagent.started`
           * 还没被消费时到达过滤器，那时白名单里没有它 ⇒ 整条子会话的内容被挡掉。
           */
          noteFinishedChildSession(notification, sessionId, runState.finishedSessions);
          return acceptsRunNotification(notification, sessionId, runState.childSessions);
        } catch (error) {
          logger.error('dsh 通知过滤器抛错（已 fail-open 放行该条；订阅若被 SDK 判死会另记 ERROR）', {
            method: notification?.method,
            reason: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : null,
          });
          return true;
        }
      });
      /**
       * **会话已知表**（stream-tap 的放行判据，见 `stream-tap.ts` 的门闸注释）：
       * 自己的会话 + **本次运行已登记的子会话**先入（`runState.childSessions` 与放行判据同一份事实，
       * 由过滤器在收到 `subagent.started` 时写入）；每放行一条真通知，再把它带出的会话身份
       * （`params.sessionId` 与 `subagent.*` 通知的子会话三级兜底）记进来。子会话的增量行必须等
       * `subagent.started` **投影之后**才放——`dshSubagentIdOf` 只认登记过的 id，
       * 早放会把子智能体的话挤进主会话同 step 号的载体。
       *
       * ⚠️ 播种必须带 `runState.childSessions`：这张表是**每条活动区间一份**（追问会再造一条），
       * 只放自己的会话 id 会让上一轮登记过的子会话在追问区间里重新变成「未知」——
       * 那些增量本次运行被门闸挂住，最后随 `tap.close()` 一起丢掉（子智能体的话缺一段，零报错）。
       */
      const knownSessions = new Set<string>([sessionId, ...runState.childSessions]);
      const noteKnown = (notification: DshNotification): void => {
        const sid = readSessionId(notification);
        if (sid !== null) knownSessions.add(sid);
        for (const identity of childSessionIdentities(notification, sessionId)) knownSessions.add(identity);
      };
      let settled = false;
      /** 已放本次运行的通知条数（失败上报时用它说明「断在哪」：收到 N 条之后就再没有了） */
      let received = 0;
      /** 最后一次收到通知的时刻（停滞判据的输入） */
      let lastNotificationAt = Date.now();
      /** 这一轮有没有见过终态信号 `turn/end`（dsh 的终结信号，见《进程生命周期》） */
      let sawTurnEnd = false;
      // 「run 交出去」与「promise 落定」分开记：promise 的 rejection **必须被消费掉**，否则会成为
      // unhandled rejection；但也**不能就此丢掉**——传输中断时 run() 直接拒绝、流里一条失败通知都没有，
      // 丢掉它本次运行就会被报成 `ok: true, completed`（「界面显示成功、实际没干活」）。
      // 所以记下来，在队列排空之后抛出去，交给骨架归因（AGENT_FAILED / AUTH_FAILED / …）。
      let runError: { error: unknown } | null = null;
      /**
       * 通知订阅**失败**的原因（`fail(error)`，不是 `close()`）。非 null 表示「投送在中途死了」——
       * 与「这一轮本来就没内容」必须分得开：前者要如实报出去（见 `nextOrSettled` 的注释与收尾那一段），
       * 否则整段对话静默消失，而行照旧判成功。
       */
      let streamFailure: unknown = null;
      let runPromise: Promise<unknown>;
      try {
        runPromise = runPrompt(prompt);
      } catch (error) {
        subscription.close();
        tap.close();
        throw error;
      }
      void runPromise.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          runError = { error };
        },
      );
      /**
        * **在飞的 `next()` 只能有一份，且绝不许丢弃**（真机事故的根因）。
       *
       * 症状：客户端把**全部** 181 条通知都投递了、过滤器也全部接受，而我们的生成器只
       * `yield` 了**前 15 条**（都在前 50 ms 内），此后 137 秒一条不落地丢掉，且**没有任何报错**——
       * `messages.jsonl` 为 0、执行日志整段空白、行照旧判成功。
       *
       * 机制：循环每 `DSH_STREAM_TAP_POLL_MS`（100 ms）被 `tapWake` 唤醒一次，而**每一次竞速都新建**
       * 一个 `subscription.next()`。竞速输给 `tapWake` 之后那个 promise 没人再 await，但它**仍然挂在
       * SDK 的 waiter 队列里**（`NotificationSubscriptionImpl.push()` 是
       * `const waiter = this.state.waiters.shift(); if (waiter !== undefined) waiter.resolve(notification)`）
       * ⇒ 此后每一条通知都被交给队列里最老的**孤儿** promise（resolve 后丢弃），真正在等的那一个永远
       * 拿不到。孤儿数量随静默时长线性增长，于是「握手之后彻底静默」成了必然，而不是偶发。
       *
       * 为什么探针复现不出：探针是连续 `await next()`，没有与超时竞速 ⇒ 从不产生孤儿。
       * 判据：把在飞的 promise 记住并复用（`pendingNext`），它 settle 之后才允许再建一个。
       */
      let pendingNext: Promise<{ notification: DshNotification | null }> | null = null;
      /**
       * **等待者已经交出来的那条通知**（跨迭代保留）。
       *
       * 为什么必须单独存一份：竞速有三条路（`next()` / run 落定 / tap 拍），而 `next()` 的等待者
       * 一旦被 `push()` resolve，那条通知就**离开了 SDK 的队列**（`tryNext()` 再也看不到它）。
       * 竞速若判另外两条路赢，这条值就只存在于一个没人持有的已 settle promise 里 ⇒ 静默丢掉。
       * 所以 `nextOrSettled()` 在 resolve 的那一刻把它记进这里，消费侧每次迭代先看这一格。
       */
      let inHand: { notification: DshNotification | null } | null = null;
      /**
       * 取出「等待者已经交出来的那条」并**立刻从 `inHand` 摘掉**（取到即消费，避免同一条放行两次）。
       *
       * 为什么写成函数而不是内联判断：那两处判断之间隔着一次 `await`（收尾栅栏的 0 ms 拍子），
       * 而等待者的 `.then` 正是在那段时间里把值写进 `inHand` 的。内联判断会让 TS 的控制流分析
       * 认定「前面查过了、这里必然是 null」，把分支收成 `never`（编译期红）——函数调用会重置这条推断。
       */
      const takeInHand = (): DshNotification | null => {
        const held = inHand;
        if (held === null || held.notification === null) return null;
        inHand = null;
        return held.notification;
      };
      const nextOrSettled = (): Promise<{ notification: DshNotification | null }> =>
        (pendingNext ??= subscription.next().then(
          (notification) => {
            inHand = { notification };
            return inHand;
          },
          /**
           * 订阅 reject 有**两种**截然不同的含义，而原实现把它们当成同一件事（静默返回 `null`）：
           *   · **`close()`**（我们自己收尾调用的）⇒ 正常结束，流就该结束；
           *   · **`fail(error)`**（SDK 的 `push()` 在过滤器抛错时调的，或传输读循环死了）⇒
           *     **投送已经死了，而这一轮还远没结束**。
           * 把第二种读成第一种的后果是真机上看到的形状：厂商会话日志 201 条、
           * 我们只收到前 13 条，之后 138 秒的内容一条不剩，**而本次运行照旧判 `judged`、
           * 执行日志整段空白、任何一条日志都没有**（run `7f05c765` 的 dsh 行）。
           * 所以这里把失败**留下来**（`streamFailure`），收尾时如实进行事件流。
           */
          (error: unknown) => {
            /**
             * 只有**run 还没落定、而且不是我们自己发起的关闭**时，这个拒绝才算「投送中途死掉」。
             * `finally` 里的 `close()` 与 `disposeRuntime` 走的 `runtime.close()` 同样会 reject
             * 挂起的等待者（真实语义），那属于预期收场。
             *
             * 两个条件缺一不可：`!settled` 单看是不够的——关闭运行时是**同步**终结订阅的
             * （SDK 的 `failSubscriptions` 遍历订阅表，我们这条建得比它内部那条早 ⇒ 先被拒），
             * 而 `run()` 的 promise 要到下一个微任务才落定 ⇒ 每次终止都恰好落在 `settled` 还是
             * `false` 的那一刻，于是平白多一条「通知流中断…执行日志因此不完整」。
             */
            if (!settled && !isClosing()) streamFailure ??= error;
            inHand = { notification: null };
            return inHand;
          },
        ).finally(() => {
          // 这一份已经 settle ⇒ 允许下一次迭代再建一个（复用而不是遗弃，孤儿因此不可能出现）
          pendingNext = null;
        }));
      try {
        for (;;) {
          // **先排空再判结束**：run 落定与通知入队是两件事，`settled` 只是「不会再有新的了」，
          // 已经投递进队列的必须取完（实测形状里 `assistant/message`、`turn/end`、`session.status: idle`
          // 都在 run 落定之前入队，顺序反了会把它们全丢掉、用量一条都采不到）
          const immediate = subscription.tryNext();
          if (immediate !== undefined) {
            // 计数必须**两条路径都算**：只数 `next()` 那一路会把「已放行 14 条」报成 6 条
            received += 1;
            lastNotificationAt = Date.now();
            if (notificationEventType(immediate) === DSH_TURN_END_TYPE) sawTurnEnd = true;
            yield immediate;
            noteKnown(immediate);
            // 每放行一条真通知就读一轮旁路：子会话身份刚记进表，未知的增量行自然被门闸挂住
            yield* tap.drain(knownSessions);
            continue;
          }
          /**
           * **等待者已经交出来的那条**：竞速可能判「没有通知」那一路赢（run 落定 / tap 拍），
           * 而它已经在 `push()` 的那一刻离开了 SDK 的队列 ⇒ 只能从这里取。
           */
          const handed = takeInHand();
          if (handed !== null) {
            received += 1;
            lastNotificationAt = Date.now();
            if (notificationEventType(handed) === DSH_TURN_END_TYPE) sawTurnEnd = true;
            yield handed;
            noteKnown(handed);
            yield* tap.drain(knownSessions);
            continue;
          }
          /**
           * **收尾栅栏**：`settled` 只说明「不会再新建等待者」，不等于「在飞的那一个没有值」。
           *
           * 竞速会把已经交给等待者的那条通知丢掉：SDK 的 `push()` 是「有等待者就 resolve 它、
           * 没有才入队」，而 `pendingNext` 是 `next().then(…).finally(…)` 三段链，
           * 比 `runPromise.then(…)` 多两跳——一批通知与 run 落定撞进同一个宏任务时，
           * 批头那条已经被交给等待者、竞速却判 run 赢，循环回到这里时 `tryNext()` 是空的、
           * `settled` 又是真 ⇒ 直接 break，那条值再没人读。
           * 真机读数（约 160 次运行命中 1 次）：`deliveredNotifications: 25, receivedNotifications: 24,
           * sawTurnEnd: false`，同一轮照旧 `exitReason: 'completed'`。最坏形状是丢掉的那条正好是
           * `turn/end(kind:'error')` ⇒ **失败的运行被判成功**。
           *
           * 判据是**零墙钟**的：`pendingNext` 若已经 settle，它的微任务在下面这个 0 ms 宏任务
           * 之前就跑完了（那条通知会被取出来交给投影）；真没有值时才由 0 ms 那一档放行退出——
           * 不给正常收尾塞进任何与内容无关的等待预算。
           */
          if (settled) {
            /**
             * 判据是**零墙钟**的：一个 0 ms 宏任务拍子足以让已经 settle 的等待者把值写进
             * `inHand`（它的微任务先于宏任务跑完）；真没有值时才放行退出——
             * 不给正常收尾塞进任何与内容无关的等待预算。
             */
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 0);
              // 只等一个宏任务拍子，且不让它把进程留活（Node 的 Timeout 带 unref）
              (timer as { unref?: () => void }).unref?.();
            });
            const tail = takeInHand();
            if (tail !== null) {
              received += 1;
              lastNotificationAt = Date.now();
              if (notificationEventType(tail) === DSH_TURN_END_TYPE) sawTurnEnd = true;
              yield tail;
              noteKnown(tail);
              yield* tap.drain(knownSessions);
              continue;
            }
            /**
             * **根会话已经 idle，但白名单里还有子会话没收场** ⇒ 先把它们等出来再收流。
             *
             * 为什么必须在这里等而不是在释放时等：分量（`subagentTokens` / `subagentTurns`）与子任务
             * 终态是**收流之后 `finalize` 现算**的，等在释放那一步就改不了任何结果；而此刻子会话的
             * `turn/end` / `subagent.finished` 与它的用量读数还有机会被投影。
             * 只做一次；等完回到循环顶部把这段时间里到达的通知消费掉。
             */
            if (!settleWaited && beforeSettle !== null) {
              settleWaited = true;
              if (await beforeSettle()) continue;
            }
            break;
          }
          /**
           * **tap 轮询拍**（stream-tap 的关键一环）：流式期间厂商通知流是**静默**的——
           * 一个 step 内没有任何 session 事件，增量只在旁路文件里长。没有这一拍，
           * 增量要等到 `assistant/message` 快照之后才被读出，打字机根本不会动。
           */
          let tapTimer: ReturnType<typeof setTimeout> | undefined;
          const tapWake = new Promise<{ notification: DshNotification | null }>((resolve) => {
            tapTimer = setTimeout(() => resolve({ notification: null }), DSH_STREAM_TAP_POLL_MS);
          });
          /**
           * 订阅一旦失败，`nextOrSettled()` 会**立刻**拒绝 ⇒ 再把它放进 race 就是 100% CPU 的忙循环
           * （每次迭代秒回、跑满整轮）。故失败之后只等「run 落定」与 tap 拍——旁路是独立通道，
           * 订阅死了它照样可能还有帧。
           */
          const { notification } = await Promise.race([
            ...(streamFailure === null ? [nextOrSettled()] : []),
            /**
             * `run()` 的落定与**拒绝**都只是「不会再有新的通知了」：拒绝的原因已经由上面那条
             * `runPromise.then(…, …)` 记进 `runError`，在这里再把它抛出去会**跳过收尾排空**——
             * 队列里可能正躺着 `turn/end(kind:'error')`（厂商原文，比 SDK 的异常信息更有归因价值），
             * 而循环的 `finally` 会连同订阅一起把它丢掉。故两条路径都收成同一个 `null`：
             * 先把队列读完，出循环之后再抛 `runError`。
             */
            runPromise.then(() => ({ notification: null }), () => ({ notification: null })),
            tapWake,
          ]);
          if (tapTimer !== undefined) clearTimeout(tapTimer);
          if (notification !== null) {
            // 这一条是竞速从等待者手里拿到的 ⇒ 把 `inHand` 里的同一份清掉，别在下一次迭代再放一遍
            inHand = null;
            received += 1;
            lastNotificationAt = Date.now();
            if (notificationEventType(notification) === DSH_TURN_END_TYPE) sawTurnEnd = true;
            yield notification;
            noteKnown(notification);
          }
          yield* tap.drain(knownSessions);
        }
        /**
         * 投送中途死掉 ⇒ **必须如实报出去**（这条流是本次运行唯一的内容来源）：
         * 一条 ERROR 日志（带原因与堆栈，给排障）+ **一条 stderr 的 `log` 事件**（给界面——
         * 否则「执行日志整段空白」就成了一句无法解释的现象，真机事故里正是如此）。
         * 顺序在 `runError` 之前：先留下「内容为什么不全」，再让骨架按 run 的失败归因收场。
         */
        const end = diagnoseStreamEnd({
          failure: streamFailure,
          delivered: deliveredNotifications,
          received,
          sawTurnEnd,
          silentMs: Date.now() - lastNotificationAt,
          closing: isClosing(),
        });
        if (end.kind === 'failed' || end.kind === 'stalled') {
          logger.error(
            end.kind === 'failed'
              ? 'dsh 通知订阅在中途失败：此后的事件与消息全部未采集（本次运行的执行日志会不完整）'
              : 'dsh 通知流静默停滞：既没有 turn/end、也没报错，此后的事件与消息全部未采集',
            {
              sessionId,
              receivedNotifications: received,
              sawTurnEnd,
              silentMs: Date.now() - lastNotificationAt,
              reason: end.reason,
              stack: streamFailure instanceof Error ? streamFailure.stack : null,
            },
          );
          yield streamFailureNotification(sessionId, end.reason, received);
        } else if (end.kind === 'unknown') {
          /**
           * **没见过 `turn/end`、静默也没超过阈值**：界面上一律不报（没有证据就别编一个故障），
           * 但**服务端要留一条痕**——失败通道只有 `turn/end` 一条，而「收尾那条通知已经被
           * `shift()` 出来、却在竞速里没人读它的值」这条路径会把它整条丢掉（见 FAQ 的
           * `24 / 24 / 25 / 25` 条）：那时本次运行照旧判成功，且**任何日志、任何事件都没有**，
           * 排障只能去翻厂商会话日志。这一条 WARN 就是那种形状的唯一线索。
           */
          logger.warn('dsh 通知流结束但整轮没收到 turn/end（结论不改写：界面不报，这里留痕）', {
            sessionId,
            deliveredNotifications,
            receivedNotifications: received,
            silentMs: Date.now() - lastNotificationAt,
            sawTurnEnd,
          });
        }
        // 队列已空、run 也已落定：若它是**拒绝**收场的，把原因抛出去。
        // 注意顺序——先 drain 再抛：`turn/end(kind:'error')` 那条通知可能已经在队列里，
        // 它带着厂商原文（更有归因价值），骨架会先看见它。
        if (runError !== null) throw (runError as { error: unknown }).error;
        // 收尾排空：settle 之后旁路上仍可能有未读的行（最后一批增量先于 idle 落盘）
        yield* tap.drain(knownSessions);
      } finally {
        subscription.close();
        tap.close();
      }
    },
  };
}

/**
 * 「静默停滞」的判据阈值：一轮结束前**超过这么久**没有任何通知、且整轮**没见过 `turn/end`**，
 * 就认定投送在中途停住了（真机 run `7f05c765` 的 dsh 本次运行是 **138 秒**）。
 *
 * 为什么用 5 秒：正常一轮的收尾几乎与最后一条通知同刻（`turn/end` → `session.status: idle` →
 * `run()` 落定），间隔是毫秒级；而长的工具调用虽然也让流静默，但那时 `run()` **还没落定**、
 * 循环仍在等——这个判据只在**循环退出时**看，所以不会把「模型在跑长命令」误判成停滞。
 */
export const DSH_SILENT_STALL_MS = 5_000;

/**
 * 循环退出时的**五种收场**（纯函数，故可单独钉住——这是「执行日志为什么是空的」的唯一答案来源）：
 *   · `ok`      —— 正常：见过 `turn/end`（`runError` 收场不走这一档：它在流末尾直接抛出去，
 *     归因交给骨架——见 `notificationStream` 收尾那一段）；
 *   · `failed`  —— 订阅被 SDK 判死（`fail(error)`：过滤器抛错 / 传输读循环死）。
 *     ⚠️ 这一档**先于**「我们自己关的」判：投送真的死过一次的运行，即使随后又走到终止，
 *     也必须如实说「内容不全」——那一次是真的丢了；
 *   · `closed`  —— **我们自己发起的关闭**（用户终止 / 看门狗 / 停机 / 收尾）之后流断了。
 *     流断在这里是**预期收场**：关闭运行时会同步终结订阅、之后也不会再有通知，
 *     「没收到 `turn/end`」与「静默超过阈值」都只是这个事实的另一面。**不报**——
 *     否则每一次终止都会往本次运行事件流里落一句「执行日志因此不完整」，而其实一条都没丢；
 *   · `stalled` —— **没有报错、也不是我们关的，但投送就是停了**：没见过 `turn/end` 且静默超过阈值。
 *     真机第二次重跑（attempt 2）就是这一种：厂商会话日志 245 KB 内容齐全，我们 13 条之后再无音信。
 *   · `unknown` —— 没见过 `turn/end`，但静默没超过阈值（多半是夹具那种「事件吐完就落定」的形状）
 *     ⇒ **不报**：没有证据就不要编一个故障。
 */
export type DshStreamEnd =
  | { kind: 'ok' }
  | { kind: 'closed' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stalled'; reason: string }
  | { kind: 'unknown' };

export function diagnoseStreamEnd(input: {
  failure: unknown;
  /** 客户端**投递**给我们的通知条数（SDK 的过滤器每条都会被调用一次） */
  delivered: number;
  /** 我们真正**放行给消费侧**的条数 */
  received: number;
  sawTurnEnd: boolean;
  silentMs: number;
  /** 这个拒绝 / 这段静默是不是发生在**我们自己发起的关闭**之后（见上面 `closed` 那一档） */
  closing: boolean;
}): DshStreamEnd {
  if (input.failure !== null && input.failure !== undefined) {
    const reason = input.failure instanceof Error ? `${input.failure.name}: ${input.failure.message}` : String(input.failure);
    return { kind: 'failed', reason };
  }
  if (input.closing) return { kind: 'closed' };
  if (input.sawTurnEnd) return { kind: 'ok' };
  if (input.silentMs < DSH_SILENT_STALL_MS) return { kind: 'unknown' };
  return {
    kind: 'stalled',
    /**
     * 原因里**同时给两个数**（客户端投递了几条 vs 我们消费了几条）——排障时最关键的一格：
     * 只报「我们收到 N 条」会把矛头指向厂商，
     * 而真相是客户端把 181 条全投递了、我们只消费了 15 条（生成器把 `next()` promise 遗弃成孤儿）。
     */
    reason: input.delivered > input.received
      ? `未收到 turn/end：客户端投递了 ${input.delivered} 条，我们只消费了 ${input.received} 条`
        + `（最后一条距今 ${Math.round(input.silentMs / 1000)} 秒）⇒ 断点在我们这一侧的消费循环`
      : `未收到 turn/end：客户端也只投递了 ${input.delivered} 条`
        + `（最后一条距今 ${Math.round(input.silentMs / 1000)} 秒）⇒ 断点在投送侧`,
  };
}

/** 一条通知里的会话事件类型（`params.event.type`）；不是会话事件就是 `null` */
function notificationEventType(notification: DshNotification): string | null {
  const event = notification.params?.event;
  if (event === null || typeof event !== 'object') return null;
  const type = (event as Record<string, unknown>).type;
  return typeof type === 'string' ? type : null;
}

/** 从一条通知里读会话归属：两条已知方法都把它放在 `params.sessionId`。 */
function readSessionId(notification: DshNotification): string | null {
  const value = notification.params?.sessionId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 造一条**通知流中断**的伪通知（`aieval/stream-failure`，见 `protocol.ts`）。
 *
 * 它走与真通知**完全相同**的投影路径（`projectDshNotification` → 一条 stderr 的 `log`）：
 * 读侧零分叉，且这条诊断会出现在用户当时正在看的那个「原始输出」面板里——
 * 真机事故（run `7f05c765` 的 dsh 行）里那份面板有 38,164 行、却**没有一行**
 * 说明「执行日志为什么是空的」。
 */
function streamFailureNotification(sessionId: string, reason: string, receivedNotifications: number): DshNotification {
  return {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: DSH_STREAM_FAILURE_TYPE,
        seq: 0,
        time: Date.now(),
        data: { reason, receivedNotifications },
      },
    },
  };
}

/**
 * **这条通知要不要进本次运行的事件流**（放行规则见 `notificationStream` 的 JSDoc）。
 *
 * 抽成导出的纯函数是为了让「子会话的事件也放行」这条判据**可被单独钉住**：
 * 它错了的表现是「子智能体一个字都没有」，而那种缺口在整链用例里很容易被别的断言盖过去。
 */
export function acceptsRunNotification(
  notification: DshNotification,
  ownSessionId: string,
  childSessions: ReadonlySet<string>,
): boolean {
  const candidate = readSessionId(notification);
  // ① 顶层通知（子任务派发/收场）没有会话归属 ⇒ 必须放行（它是子会话 id 的唯一来源）
  if (candidate === null) return true;
  // ② 本会话的事件
  if (candidate === ownSessionId) return true;
  // ③ 已发现的子会话的事件
  return childSessions.has(candidate);
}

/**
 * 认出「这一条通知说的是一个子会话」并把它的 id 记下来（放行规则 ③ 的唯一依据）。
 *
 * 三个来源（取值规则住在 `protocol.ts` 的 `dshChildSessionIdentities`，缺一不可）：
 *   · **顶层通知** `subagent.started` / `subagent.finished`：身份在 `params.childSessionId`
 *     （与随后子会话事件里的 `params.sessionId` 同值；`subagent.finished` 另有同值的 `agentId`）；
 *   · **子会话事件自带身份格**：某些事件（如 `subagent/catalog`）会带上它，此时不必等顶层通知；
 *   · **信封 `params.sessionId`（`subagent/descriptor` 那一档）**：身份就在信封里 ⇒
 *     少了它，子会话的事件被挡掉、它的 tok 也不算进「子智能体那一份」。
 *
 * `ownSessionId` 用来排除「主会话自己的信封 id」与信封那一格的自我登记
 * （把主会话登记成子会话会让它的事件被重复放行，代价是重复内容而不是报错——预防比排查便宜）。
 *
 * 导出是为了让「信封那一格也算身份」这条判据可被单独钉住：它的失效形状是
 * 「子智能体的话与它的 tok 一起消失」，在整链用例里很容易被别的断言盖过去。
 */
export function noteChildSession(
  notification: DshNotification,
  ownSessionId: string,
  childSessions: Set<string>,
  /**
   * 本次运行的取数面：给了就顺手记下「这个子会话**在本次 run 登记它时**已有的累计量」。
   *
   * 为什么必须有这一格：`sessionUsage` 与按会话的往返计数都是**模块级、跨 run 不清**的
   * （同一个子会话 id 在追问 / 续接的下一个 run 里会被重新登记），而「子智能体那一份」问的是
   * **本 run** 的增量 ⇒ 没有基线，第二个 run 的分量会把前一个 run 一起算上
   * （真机形状：运行快照上出现「合计 60 / 子分量 2010」）。基线只记一次：同一个 id 在本 run 内
   * 再登记也不覆盖。
   */
  runState?: {
    childUsageBaseline?: Map<string, UsageTokens>;
    childTurnsBaseline?: Map<string, number>;
  },
): void {
  for (const identity of childSessionIdentities(notification, ownSessionId)) {
    if (identity === ownSessionId) continue;
    if (childSessions.has(identity)) continue;
    childSessions.add(identity);
    if (runState === undefined) continue;
    runState.childUsageBaseline ??= new Map<string, UsageTokens>();
    runState.childTurnsBaseline ??= new Map<string, number>();
    if (!runState.childUsageBaseline.has(identity)) {
      const snapshot = dshSessionUsageOf(identity);
      if (snapshot !== null) runState.childUsageBaseline.set(identity, snapshot);
      else runState.childUsageBaseline.set(identity, { input: 0, cached: 0, output: 0, reasoningOutput: null, total: null });
    }
    if (!runState.childTurnsBaseline.has(identity)) {
      runState.childTurnsBaseline.set(identity, dshSessionRoundOf(identity) ?? 0);
    }
  }
}

/**
 * 一条通知里的子会话身份：**取值规则住在 `protocol.ts`**（`dshChildSessionIdentities`，
 * 白名单登记与收场登记共用同一份，两处各写一遍必然漂移）。
 *
 * ⚠️ 唯一一条本地的补充是**信封排除**：信封 `params.sessionId` 等于本会话 id 时不算子会话
 * （投影的 `session.event` 一律带它，会把本会话登记成自己的子会话）。
 * `subagent/descriptor` 那一档靠的就是信封那一格——真机上 `subagent` 工具派发只投它。
 */
function childSessionIdentities(notification: DshNotification, ownSessionId: string): string[] {
  const params = notification.params;
  if (params === undefined) return [];
  return dshChildSessionIdentities(params).filter((identity) => identity !== ownSessionId);
}

/**
 * `subagent.finished` 的身份登记：投影据此区分「已经收场却没报用量」（事实缺失 ⇒ `null`）
 * 与「还在跑」（还没报就先当 0，它还会报）。
 *
 * 只登记身份、不产出任何事件——与 `noteChildSession` 同一层：两张集合都是「投影要读的事实」，
 * 而它们的唯一来源就是这条通知流（同一条通知先进这里、再决定放不放行）。
 * 身份取值与白名单**同源**（`childSessionIdentities`）。
 */
function noteFinishedChildSession(
  notification: DshNotification,
  ownSessionId: string,
  finished: Set<string>,
): void {
  if (notification.method !== DSH_SUBAGENT_FINISHED_METHOD) return;
  for (const identity of childSessionIdentities(notification, ownSessionId)) finished.add(identity);
}

/**
 * 收尾那条**点名 WARN**（第三档）：分量走 `null` 时，
 * 日志里必须说得出「是哪些子会话没报用量」——否则「没采到」与「确实没有子智能体」长得一样。
 *
 * 三条口径：
 *   · **一条**文案串起全部 id（`、` 分隔），不是每个 id 一条：这是**一个事实**（本次运行的分量为什么
 *     是 `null`），刷成 N 条只会把日志淹掉；
   *   · 文案与另两家**同用途**（都是「点名谁没报」）**但句式刻意不同**：另两家说的是「本次运行的
 *     tok / 缓存命中 / 轮次**都不含**它们」——那句话在 codex / claude 上成立（它们的合计真的会
 *     退回主线程口径），**在 dsh 上是假的**：dsh 的 `turns` 是**构造上的全树累加**
 *     （`step/start` 不按会话分叉），一个收场却没报用量的子会话，它的 `step` **已经在合计里**，
 *     缺的只是**分量**。所以这里逐格说对：「分量给不出」+「步数含它的 step」+「tok 里没有它报过的
 *     用量」。本次运行正是运维对着 `主 27 + 子 7 = 34` 复核时会读到的字，措辞必须与事实同尺。
 *   · 没有 id 时**一条都不发**：判据是 `dshSilentChildSessions`（与 `dshSubagentUsage` 的 `null` 档
 *     同源），空列表说明两处漂移了，此时宁可不出声也不要落一条没有名字的 WARN。
 */
function unsettledSubagentWarns(runState: DshRunState): AgentEventDraft[] {
  const pending = [...runState.childSessions].filter((id) => !runState.finishedSessions.has(id));
  if (pending.length === 0) return [];
  return [
    logDraft(
      'stderr',
      `[WARN] 释放运行时之前没能等到子会话 ${pending.join('、')} 收场：它们的用量与步数分量给不出`
        + '（按「事实缺失」交 null，不按 0 计——运行一释放它们就被掐死，不会再有读数）',
    ),
  ];
}

function silentSubagentWarns(runState: DshRunState): AgentEventDraft[] {
  const silent = dshSilentChildSessions(runState);
  if (silent.length === 0) return [];
  return [
    logDraft(
      'stderr',
      `[WARN] 子会话 ${silent.join('、')} 已收场却没有用量事件：本次运行的**子智能体分量**给不出`
        + '（tok 与步数的分量都是 null，不编造、不填 0）；合计仍是已观察到的全树读数——'
        + '步数含它的 step，tok 里没有它报过的用量',
    ),
  ];
}

/**
 * 插件面的**点名 WARN**：这一轮配了人工消息面 / 应答面，但**整轮没有等到插件的加载收据**。
 *
 * 为什么必须有它：插件没被厂商加载或激活时，这一侧**所有**出口都是静默的——
 *   · 人工消息面：投递流水写了没人读（`steered` 收据永远不来）、撤回拿不到结果，
 *     最坏是人工消息永远不投、一直等到编排层的超时；
 *   · 应答面：提问流水永远是空的（模型的问题落回厂商自己的等待档或超时）。
 * 而厂商那边只会在它的 stderr 留一行 `N entries did not activate`（加上一条详情）——
 * **适配器不读它的 stderr**（正常收场时 SDK 的 `stderrTail` 也是 0 行）。于是「功能没了」与
 * 「这一轮没人发消息」在界面上长得一模一样。真机形状（受控实验：让插件在加载期抛错）：
 * 进程照旧存活、运行照旧成功，只是那两座桥从此哑掉。
 *
 * 口径与前几条 WARN 同尺：**只说话、不改结论、不改观测格**（这一轮的投递/提问事实本来就是空的，
 * 补一个假事实比不出声更坏）；两座桥**各说各的**（配了哪一个就只报哪一个）。
 */
function pluginWarns(input: {
  injectBridge: DshInjectionDriver | null;
  askBridge: DshAskAnswererBridge | null;
}): AgentEventDraft[] {
  const drafts: AgentEventDraft[] = [];
  const injectLoaded = input.injectBridge?.pluginLoaded() ?? null;
  /**
   * ⚠️ **不按「加载那一刻的 `hasAgents`」报警**：插件自己写明加载那刻多半取不到服务（服务由另一行
   * 插件 provide，加载顺序不保证），投递时才是现取的；真机复跑证实「加载行 false、同一轮的 `steered`
   * 行 true」。真正失败的形状（投递回 `agent-not-found`）由 `handleReceipt` 的失败分支点名。
   */
  if (input.injectBridge !== null && injectLoaded === null) {
    drafts.push(
      logDraft(
        'stderr',
        '[WARN] 人工消息面配了插件，但整轮没等到它的加载收据：这一轮的人工消息**投不进模型**、'
          + '撤回也拿不到结果（界面上与「没人发消息」长得一样）。厂商侧只会留一行 '
          + '`did not activate`（适配器不读它的 stderr）——请查 <DSH_HOME> 下那份插件文件与厂商启动日志',
      ),
    );
  }
  if (input.askBridge !== null && input.askBridge.pluginLoaded() === null) {
    drafts.push(
      logDraft(
        'stderr',
        '[WARN] 提问应答面配了插件，但整轮没等到它的加载收据：模型提的问题不会到达提问端口'
          + '（落回厂商自己的等待档），人的答复也交不回模型。厂商侧只会留一行 `did not activate`'
          + '——请查 <DSH_HOME> 下那份插件文件与厂商启动日志',
      ),
    );
  }
  return drafts;
}

/**
 * 技能面的**点名 WARN**：这一轮装了 N 条技能，却一次都没观测到厂商的技能目录。
 *
 * 为什么必须有它：厂商**首次发布且这次会话里零条技能**时根本不投 `skill-catalog` 那条消息
 * （`dsh-tool-skill` 的 `if (!history.published && skills.length === 0) return;`）⇒ 观测格
 * `vendor-system.skills` 给不出数，而「我们装进去的技能被厂商**全丢了**」（frontmatter 不合它的
 * YAML 判据、键名被它拒收…）与「厂商就是没投」在 wire 上是**同一格 `null`**——`deriveCandidateSkillInstall`
 * 因此读成 `unverified`，界面显示「未能核验」，**行照跑照出分**。真机读数：10 条臂里 7 条一次
 * `[]` 都没读到，其中 3 条磁盘上确实物化好了技能、厂商一条都没认领 ⇒ 这一格必须有人说话。
 *
 * 三条口径：
 *   · **只在「装了 ≥1 条」且「一次都没观测到目录」时发**：装了 0 条时厂商不投是设计（真机 `[]`
 *     与 `null` 的差别本来就在这里），没装却报警会把常态刷成噪声；
 *   · **不改结论、不改观测格**：这一格仍然是 `null`（采不到），WARN 只是把「说不清」说出来——
 *     把 `null` 补成 `[]` 会把另两种厂商不投的情况（发现不完整 / `skill` 工具没挂）误判成失败；
 *   · **点名到条数**：文案要说清「装了几条」与「厂商一条都没认领」，否则读的人无法判断该不该查。
 */
/**
 * **续接段要了非 full 档，而厂商这一会话的档位观测不到** ⇒ 点名 WARN。
 *
 * 厂商把权限档当**会话属性**：`permission/preset` 只在会话起手投一条（续接段不重投，真机
 * `vendor-system.permissionMode` 在续接段恒 `null`），而实际生效的是**首次创建那条会话时的档**
 * ——本段拿不到这个读数。真机反例（R4-A 的 F1）：首段 `full` 建会话、第二段 `read-only` + 续接，
 * 写文件**照样成功**（对照臂：新会话 read-only 同一动作被拒）。
 *
 * 为什么只报非 full：`full` 那一档即使实际被降级，表现是工具报错（可见），风险方向相反；
 * 而在只读档下静默拿到写权限是**评分阶段最不能接受**的那一类（评审者一改工作区，抽屉里的 diff
 * 就不再是本次运行交的那一份）。修在编排层（对「会话起手档 vs 本次 permission」加断言）之前，
 * 至少要让这件事有出口。
 */
function permissionMismatchWarns(runState: DshRunState, resumed: boolean, sessionId: string): AgentEventDraft[] {
  const desired = runState.permissionDesired ?? null;
  if (desired === null) return [];
  /**
   * **本进程里知道这条会话的档位**（早先那段观测到过，会话级记忆）⇒ 与本次要求直接对照，
   * **两个方向都要报**：要 `full` 却拿到 `read-only` 是功能面（写工具会莫名失败），
   * 要 `read-only` 却拿到 `full` 是安全面（评分阶段最不能接受的那一类）。
   * 这一支与厂商重投那条（`events.ts` 的 `permission/preset`）互补：续接段厂商不重投，
   * 只有这条能发现差异。
   */
  // 只在本段**没观测到**厂商重投时用会话记忆（厂商重投了的话，`events.ts` 那一支已经报过一条，
  // 两个出口同时说话就是同一件事说两遍）
  const known = (runState.permissionPreset ?? null) === null ? dshSessionPermissionOf(sessionId) : null;
  if (known !== null && known !== desired) {
    return [
      logDraft(
        'stderr',
        `[WARN] 本次运行要求权限档 ${desired}，但这条会话的档位是 ${known}`
          + '（厂商把它当会话属性：续接 / 追问都不会改）——本段实际按后者的档跑',
      ),
    ];
  }
  if (!resumed || desired === 'danger-full-access') return [];
  // `undefined`（这一轮压根没观测到）与 `null`（显式没采到）同义：都当「观测不到档位」
  if ((runState.permissionPreset ?? null) !== null) return [];
  return [
    logDraft(
      'stderr',
      `[WARN] 本次运行要求权限档 ${desired}，但这一轮是**续接**同一条会话：厂商把权限档当会话属性，`
        + '本段既不重投也不改（实测 read-only + 续接照样写得进文件），实际生效的是那条会话**首次创建**时的档，'
        + '而本段观测不到它。要在只读档下跑就别续接这条会话（新建一条）',
    ),
  ];
}

function skillCatalogWarns(runState: DshRunState, injectedSkillCount: number, resumed: boolean): AgentEventDraft[] {
  if (injectedSkillCount === 0) return [];
  if ((runState.skillCatalog ?? null) !== null && (runState.skillCatalog ?? []).length > 0) return [];
  /**
   * ⚠️ **续接 / 追问段不报**：厂商的 `agent/pre-step` 先扫会话历史里那条 `skill-catalog`，摘要没变
   * 就直接 return（不重发）——「这一段没看到目录」在那里是**设计**，不是「被丢弃」。判据只能是
   * 「会话起手那一段装了技能却没看到目录」（真机：那一段厂商必投）。
   */
  if (resumed) return [];
  return [
    logDraft(
      'stderr',
      `[WARN] 本次运行装了 ${injectedSkillCount} 条技能，但整轮都没观测到厂商的技能目录`
        + '（`<available_skills>` 那条消息）：无法区分「厂商把这几条都丢了」与「厂商根本没投」——'
        + '技能面的观测格因此是「未能核验」，本次运行不会因此失败；要收口请看磁盘上 `<DSH_HOME>/skills/` 的落点'
        + '与每条的 frontmatter（厂商用严格 YAML 解析，解析不了的文件它静默丢弃）',
    ),
  ];
}

/**
 * dsh 自己的持久化层文件（`profiles/sdk/cordis.patch.yml`）——适配器**不写它**。
 *
 * 留着这条常量只为让「不写它」这件事可断言：`ask_user_question` 的 `insert` 住在 per-launch overlay
 * （`DSH_ROUTE_PATCH_RELATIVE_PATH`），而这个文件是 **dsh 自己的持久化层**
 * （Settings / config-editor 会写它）——适配器若整份重写它，两份来源混在一个文件里，排障时
 * 分不清是谁写的。守卫：`index.test.ts` 有一条反向断言，检查适配器**不**写这个文件。
 */
export const DSH_LEGACY_PROFILE_PATCH_RELATIVE_PATH = 'profiles/sdk/cordis.patch.yml';

/**
 * 释放运行时之前，为「还在跑的子会话」留的等待上限。
 *
 * 为什么需要等：`run()` 在**根**会话 idle 时就落定（厂商门面如此），而后台派出去的子智能体可能
 * 还在跑（真机实测落定后子会话又跑了 8.6 s）。此时释放运行时会**连根拔掉**它们：
 * `subagent.finished` 永远不来、子智能体那一份用量与轮次只到一半、子任务行没有终态。
 * `session/wait` 正是补这条缺口的原语（等整棵子树收场），门面没包、只能走 `client.request`。
 *
 * 取值口径：**上限不是预算**——正常子任务以秒计，60 s 覆盖常见形状；到点就按现状收场并留一条 WARN
 * （那说明这个子任务本身该被设计成后台作业，而不是让整行陪它等）。**终止路径不等**：
 * 用户在等的是停机（`cancelMidTurn: false` 的代价已经登记在别处），多等一分钟是错的。
 */
export const DSH_SUBAGENT_DRAIN_MS = 60_000;

async function startDsh(context: TurnContext): Promise<TurnStart> {
  const { input } = context;
  // **不要**在这里加「收到 `outputSchema` 就报错」的守卫：支持与否由 `run` 转发的
  // `capability.structuredOutput` 交给骨架，`runTurn` 在 `start` 之前就把这一格摘掉了 ⇒ 走到这里
  // 它必定不存在，再判一次是死代码。代价已登记：绕过 `run` 构造 `AgentRunInput`
  // 的旁路不报错、改为静默降级——这是「降级口径只该有一处」换来的。
  const sdk = await loadDshSdk();
  /**
   * **会话 id 在这里铸**（不是等运行时起来之后）：
   *   · 续接（`input.resume`）时它就是**要 adopt 的那条**——新会话才现场铸一个；
   *   · 人工消息面的插件要按它在 runtime 进程里找那条 `Agent`（投递流水里带的就是它），
   *     而插件文件与 overlay 都在 `new sdk.DeepSeekHarness(...)` **之前**落盘 ⇒ 铸造必须更早。
   * 取值口径与 SDK 内部 `session()` 逐字一致（`session-` + 去掉连字符的 uuid）。
   */
  const sessionId = input.resume?.sessionId ?? mintSessionId();
  /**
   * **续接时播种往返号**（见 `session-log.ts`）：厂商的 `turn` 跨段持久，而我们的发号表是进程局部的
   * ⇒ 不播种的话第二段又从 1 起、与第一段 `mergeKey` 逐个撞车。读不到日志就不播种（退回今天的行为）。
   */
  if (input.resume !== undefined) {
    seedDshSessionRoundHighWater(
      sessionId,
      countSessionSteps({ configHome: input.configHome, cwd: input.cwd, sessionId }),
    );
  }
  /**
   * 这一轮的**人工消息端口**：读**骨架包装过的那一份**（`context.inject`，恒有：缺席已由骨架
   * 归一成关闭档，等待登记也在包装层）——适配器只剩 `available` 一个判据要读，关着 ⇒ 一格都不挂
   * ——不插 overlay 那行、不落插件、不起桥，既有行为因此逐字不变（「零回归」的判据）。
   */
  const injectionPort = context.inject.available ? context.inject : null;
  // 权限档（见 `permission.ts`）：dsh 的档位**烘在启动 profile 里**（「改了必须重建运行时」），
  // 所以它不是 SDK 的一个选项，而是子进程环境里的 `DSH_PERMISSION_MODE`——`dsh-base` 的
  // `sandbox-policy` 与 `approval` 两本次运行都读它，不设时 dsh 自己回落到 `workspace-write`。
  // 注入通道仍是 `buildSubprocessEnv`（替换型子进程环境），**不碰** `process.env`。
  const { env: permissionEnv } = DSH_PERMISSION_OPTIONS[input.permission];
  const env = buildSubprocessEnv({
    homeDir: input.configHome,
    injected: {
      // 本次运行的路由凭据：**自定义变量名**，由 overlay 的 `apiKeyEnv` 逐字引用。
      // 与 claude 的 ANTHROPIC_API_KEY 同形：凭据进的是**替换型子进程环境**，不写 `process.env`
      [DSH_ROUTE_API_KEY_ENV]: input.route.apiKey,
      DSH_HOME: input.configHome,
      /**
       * **退役旧通道：显式删除，而不是「不再注入」**。
       *
       * `buildSubprocessEnv` 是「以宿主环境为底展开、再覆盖本次注入」，而它的删除语义正是
       * 「值为 undefined 就 delete」。不写这两本次运行的话，宿主里若存在 `DEEPSEEK_API_KEY`
       * （开发机上很常见）就会被子进程继承，于是：
       *   ① 那条已无人配置的 `deepseek-official` 路由**静默可用**——安装态 0.1.7 的 llm-deepseek
       *      是「账号 token 优先于 API key」，配上公网 api.deepseek.com 就会**悄悄发请求并计费**；
       *   ② `web_search` 会拿宿主的密钥去打 DeepSeek 搜索接口。
       * 两条都是「看起来没配、其实在花钱」，而静默是这个仓最不接受的一类失败。
       */
      DEEPSEEK_API_KEY: undefined,
      DEEPSEEK_BASE_URL: undefined,
      ...permissionEnv,
    },
  });
  /**
   * **overlay 必须在 `new sdk.DeepSeekHarness(...)` 之前落盘**——那是 dsh 的 boot 点，profile 在
   * 那一步组装（`--patch` 由 SDK 拼进 argv）。写晚了本次运行照样「跑完」，但合成树里**没有**我们的路由，
   * 症状是 `initialize` 阶段报 `no adapter registered for provider "aieval-route"`。
   *
   * 这条时序由 `onConstruct` 快照钉住（guard 见 `index.test.ts`）：写晚了快照读到的就是 `null`。
   * 文件是**整份重建**的（同一份输入两次调用逐字相同，见 `buildDshRoutePatch` 的纯函数用例），
   * 所以不存在「上一次运行的窗口残留」这类需要单独清理的状态。
   */
  const routePatchPath = join(input.configHome, DSH_ROUTE_PATCH_RELATIVE_PATH);
  /**
   * 自定义请求头：先过可发送性闸再写进 overlay。
   *
   * 为什么**必须在写盘之前**过闸：`llm-pi-ai` 装配 profile 时会对每条路由的 `headers` 跑
   * `new Headers([[名, 值]])`，一条发不出去的头会让**整次启动**失败（`initialize` 阶段就炸），
   * 而那是一个「设置里某一格手改坏了」变成「这个候选跑不了」的放大器。摘掉 + WARN 才是对的那一手。
   */
  const routeHeaders = sendableRequestHeaders(input.requestHeaders);
  /**
   * 这一轮挂没挂**应答面**：骨架的提问端口说了算（= 调用方传了 `onAskUser`）。
   * overlay 那一行与插件落盘都由它派生（见 `DshRoutePatchInput.askUserAnswerer`）。
   */
  const askAnswerer = context.askUser.available;
  /**
   * 写盘之前**先建 `configHome`**：三家适配器都在厂商进程起来之前往运行配置目录里写文件
   * （技能物化、运行内 `.npmrc`、本家的 overlay 与 stream-tap），谁都不许假设父进程已经建好它。
   *
   * 为什么必须自己 mkdir：`AgentRunInput.configHome` 的契约只说「本次运行独立配置目录」，没说它一定存在
   * （生产路径上 `prepareCandidateWorkspace` 会建，但那是**编排层的实现细节**，不是这一层的输入前提）。
   * 不建的表现是 `ENOENT: open '…\.agenthome\aieval-route.patch.yml'`，归因成 `AGENT_FAILED`，
   * 而真正的原因（目录不存在）离得很远。
   */
  mkdirSync(input.configHome, { recursive: true });
  writeFileSync(
    routePatchPath,
    buildDshRoutePatch({
      protocolType: input.route.protocolType,
      baseUrl: input.route.baseUrl,
      modelId: input.route.modelId,
      contextWindow: input.route.contextWindow,
      maxOutputTokens: input.route.maxOutputTokens,
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      ...(routeHeaders === undefined ? {} : { headers: routeHeaders }),
      askUserAnswerer: askAnswerer,
      injectMessages: injectionPort !== null,
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  /**
   * 本次运行的**技能装入**：把清单里那几条整目录复制进 `<DSH_HOME>/skills/`（= `configHome/skills`）。
   *
   * 时机：必须在 `new sdk.DeepSeekHarness(...)` **之前**——那是 dsh 的 boot 点，技能目录在那一刻进
   * 装配清单。写晚了本次运行照样「跑完」，但**没有任何 skill、也没有任何报错**（日志里连线索都没有）。
   *
   * **不传 `skills` ⇒ 一次都不调**（连 `skills/` 目录都不建）：评分与用例同步两处不该有技能面，
   * 而「不传」是这条口径唯一的表达方式（空数组会被物化成「建了目录、零条」）。
   * 落不下去时物化函数**抛**（点名哪一条），由骨架归成 `AGENT_SKILLS_UNAVAILABLE`、本次运行失败。
   */
  /** 本轮**实际装进去**的技能条数（技能面「装了却没观测到目录」那条 WARN 的判据） */
  const injectedSkillCount = input.skills?.length ?? 0;
  if (input.skills !== undefined) {
    materializeSkills({ configHome: input.configHome, skills: input.skills });
  }
  /**
   * 运行内 npm registry：宿主的 `.npmrc` 里那一行**照抄**进行私有 `configHome`。
   *
   * 时机：与 overlay 同一段（都在 `new sdk.DeepSeekHarness(...)` 之前）——dsh 的插件本次运行里
   * `npx -y @playwright/mcp@latest` 是**它自己**去拉包，等 runtime 起来再写就晚了。
   * 三条边界与 claude / codex 两侧逐字相同（宿主没有 ⇒ 什么都不做；只读宿主、只写运行内；0600）。
   */
  const registryLine = writeCandidateNpmrc({
    configHome: input.configHome,
    hostNpmrc: readNpmrcText(hostNpmrcPath()),
  });
  /**
   * stream-tap 的两份落盘（**与 overlay 同一个时序**：boot 在 `new DeepSeekHarness(...)` 那一步
   * 读 patch 装配清单并 import 插件，写晚了本次运行照样「跑完」，只是没有任何增量）：
   *   · 插件本体落 `configHome` 根（overlay 里 `./aieval-stream-tap.mjs` 的相对名按 `<dshHome>` 解析）；
   *   · 旁路文件**整份清零**而不是「不存在就跳过」：重跑同一行时上一轮尝试的增量行绝不能
     *     当本轮的重放——增量只广播不落盘，重放的旧本次运行会顶掉新一轮的实时视图。
   */
  const tapPluginPath = join(input.configHome, DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH);
  const tapFilePath = join(input.configHome, DSH_STREAM_TAP_RELATIVE_PATH);
  mkdirSync(dirname(tapPluginPath), { recursive: true });
  writeFileSync(tapPluginPath, DSH_STREAM_TAP_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  // 旁路文件里是**模型输出的逐字转录**：这里先建空文件时就要 0600（插件那边的 append 对已存在文件不改权限）
  writeFileSync(tapFilePath, '', { encoding: 'utf8', mode: 0o600 });
  /**
   * 提问应答者的三份落盘（**同一个时序**，理由同上：装配清单在 boot 那一步读）：插件本体落
   * `configHome` 根（相对名按 `<dshHome>` 解析，与 stream-tap 同一条基准），两份 sidecar 整份清零
   * ——它们是追加型的，重跑同一行时上一轮的提问与答复绝不能被当成本次那一问的。
   *
   * 全都在 `askAnswerer` 之下：不挂应答面 ⇒ 插件文件不落盘、两份 sidecar 也不建，
   * 叠加配置里那一行同样没有（见 `buildDshRoutePatch`）——「不问就不动」不留痕迹。
   */
  const askPluginPath = join(input.configHome, DSH_ASK_ANSWERER_PLUGIN_RELATIVE_PATH);
  const askTranscriptPath = join(input.configHome, DSH_ASK_ANSWERER_TRANSCRIPT_RELATIVE_PATH);
  const askRepliesPath = join(input.configHome, DSH_ASK_ANSWERER_REPLIES_RELATIVE_PATH);
  if (askAnswerer) {
    writeFileSync(askPluginPath, DSH_ASK_ANSWERER_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
    /**
     * ⚠️ 两份流水的权限必须**在这里**就给 0600：它们先由本函数建成空文件，插件那边
     * `appendFileSync(..., { mode: 0o600 })` 对**已存在**的文件是空操作（真机实测 0644）——
     * 「提问正文 + 人的答复」对同机其他用户可读，而代码里那句 `0o600` 会让人以为已经收紧了。
     */
    writeFileSync(askTranscriptPath, '', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(askRepliesPath, '', { encoding: 'utf8', mode: 0o600 });
  }
  /**
   * 人工消息面的三份落盘（**同一个时序**，理由同上：装配清单在 boot 那一步读）：插件本体落
   * `configHome` 根，两份流水整份清零——投递流水是我们的追加出口（重跑同一行时上一轮的条目
   * 绝不能被再投一次），收据流水是插件的回执（上一轮的回执同样会污染本轮的判据）。
   *
   * 全都在 `injectionPort` 之下：没挂端口 ⇒ 插件文件不落盘、两份流水也不建，叠加配置里那一行
   * 同样没有（见 `buildDshRoutePatch`）。
   */
  const injectPluginPath = join(input.configHome, DSH_INJECT_PLUGIN_RELATIVE_PATH);
  const injectQueuePath = join(input.configHome, DSH_INJECT_QUEUE_RELATIVE_PATH);
  const injectReceiptsPath = join(input.configHome, DSH_INJECT_RECEIPTS_RELATIVE_PATH);
  if (injectionPort !== null) {
    writeFileSync(injectPluginPath, DSH_INJECT_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
    // 同上：权限只能在这里给——插件那边的 `mode` 对已存在的文件不生效，人工消息正文会留在 0644 上
    writeFileSync(injectQueuePath, '', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(injectReceiptsPath, '', { encoding: 'utf8', mode: 0o600 });
  }
  const runtime: DshRuntime = new sdk.DeepSeekHarness({
    cwd: input.cwd,
    dshHome: input.configHome,
    processCwd: input.cwd,
    model: input.route.modelId,
    // 路由键：与 overlay 的 `providers` 字典键、以及 `listProviders()` 里的 id **必须逐字相同**，
    // 否则 `initialize` 会以 `no adapter registered for provider "…"` 收场（源码同源，见 DSH_ROUTE_KEY）
    provider: DSH_ROUTE_KEY,
    // `patches` 是**绝对路径**：SDK 用 `resolve(callerCwd, path)` 解析，而 callerCwd 是宿主进程的 cwd
    // ⇒ 给相对路径会让文件落到别处（甚至根本不在本次运行的 .agenthome 里）
    patches: [routePatchPath],
    // 冷启动握手预算（SDK 默认 10s 不够；见 DSH_INITIALIZE_TIMEOUT_MS 的 JSDoc）
    initializeTimeoutMs: DSH_INITIALIZE_TIMEOUT_MS,
    // 思考强度：**恒带**——未选时用缺省档 `high`，
    // 没有「undefined 时一个键都不加」这条路（那在 dsh 上等于关闭，见 DSH_DEFAULT_EFFORT 的注释）。
    // 显式 `off` 原样交给 harness：它按 `DSH_REASONING_WIRE.off = null` 不写 reasoning 字段 ⇒ 关闭。
    reasoningEffort: input.effort ?? DSH_DEFAULT_EFFORT,
    env,
  });
  /**
   * **释放：先停两座桥，再关运行时**。这一份 disposer 跨全部活动区间（首轮与每次追问共用同一份）：
   * 运行时与两座桥本来就是整 run 一份，而骨架只释放首轮那一格（`releaseTurn` 记忆化）。
   * `createDisposer` 幂等，超时兜底与用户终止先后到达也只会关一次。
   *
   * ⚠️ **它必须建在 `runtime.start()` 之前**（两座桥的引用先声明、后面再赋值，闭包在关闭时才读它们）：
   * `start()` 是 spawn 子进程那一步，从它返回到「骨架拿到 `TurnStart`」之间还有几步会抛
   * （`resumeSession` 的 adopt、两座桥的构造）——那时 `runTurn` 手里的 `started` 还是 `undefined`，
   * 它的 `finally` 碰不到任何可关闭对象 ⇒ 谁都不关运行时，一个 dsh 子进程就留在盘上捏着本次运行的
   * `.agenthome`（Windows 上还会让下一轮的行产物清理 `EPERM`）。把 disposer 提前 + 出错时关一次，
   * 这条路径就没有孤儿。
   */
  /**
   * 本次运行的**子会话白名单**与**已收场集合**：三处共用——通知流的放行判据要在
   * 收到 `subagent.started` 时登记，投影要按同一份白名单算「子智能体那一份」用量，
   * 收尾（`finalize`）要用同一份取数面把结论折进结果；**释放前那条 drain 也读它**
   * （还有子会话在跑就先等它们，见 `DSH_SUBAGENT_DRAIN_MS`）。
   *
   * ⚠️ 声明位置必须在 `disposeRuntime` **之前**：析构体在失败路径上会被立刻调用
   * （`resumeSession` 抛错那条），而那时若 `runState` 还没初始化，读它就是 TDZ 抛错
   * ——回收本身失败会把本次运行的真因掩盖掉。
   */
  const childSessions = new Set<string>();
  const finishedSessions = new Set<string>();
  const runState: DshRunState = {
    childSessions,
    finishedSessions,
    headerTools: null,
    skillCatalog: null,
    jobFailures: new Map<string, boolean>(),
    childUsageBaseline: new Map<string, UsageTokens>(),
    childTurnsBaseline: new Map<string, number>(),
    // 本次运行要求的档（与厂商实际报的 `permission/preset` 对照，见 events.ts 那一支）
    permissionDesired: permissionEnv.DSH_PERMISSION_MODE,
    // 派发记账：**每个本次运行一份**（与 childSessions 同一条理由——两行并发时不许互相认领对方的派发）
    dispatchStarts: new Map(),
    claimedDispatches: new Map(),
    deliveredStarts: new Map(),
  };
  let askBridge: DshAskAnswererBridge | null = null;
  let injectBridge: DshInjectionDriver | null = null;
  /**
   * **我们自己发起了关闭**（用户终止 / 看门狗 / 停机 / 正常收尾都会走到 `disposeRuntime`）。
   *
   * 为什么必须有这一格：关闭运行时会**同步终结订阅**（SDK 的 `failSubscriptions`），
   * 而通知流的消费循环此刻还挂在 `next()` 上——它拿到的拒绝与「传输中途死掉」是**同一个形状**
   * （`TransportClosedError`）。两者的区别只有我们自己知道：`dispose` 一旦开始，
   * 流里的失败就是**预期收场**，不是「内容丢了」。少了这一格，每一次终止都会往本次运行事件流里
   * 落一条「通知流中断…执行日志因此不完整」——把排障引向「我们丢内容了」，而其实一条都没丢。
   */
  let closing = false;
  /**
   * 还有子会话在跑就先等它们收场（见 `DSH_SUBAGENT_DRAIN_MS`）。
   *
   * 三条边界：**没有在跑的子会话 ⇒ 一次都不调**（绝大多数运行走这一支，零开销）；
   * **已经终止（`signal.aborted`）⇒ 不等**；**请求失败 / 到点 ⇒ 吞掉并留痕**——
   * 观测与收尾的手段没有资格把一次已完成的运行变成失败。
   */
  /** 收流前那次「等子会话收场」只做一次（等完要回到循环顶部消费通知，不能每圈都等） */
  let drainAttempted = false;
  const drainLiveSubagents = async (): Promise<boolean> => {
    const pending = [...runState.childSessions].filter((id) => !runState.finishedSessions.has(id));
    if (pending.length === 0) return false;
    /**
     * **已终止 ⇒ 不等**（停机不能被一分钟的等待拖住），但**必须记下「这些子会话不会再有读数」**：
     * 不记的话收尾会让分量按「还在跑、以后会报」交 `{0,0,0}` + `turns`，而运行马上释放、它们再也不会报
     * ——正是那个字段注释里说「不能这样交」的形状（真机：终止先于进入那一支零 WARN）。
     */
    if (input.signal.aborted) {
      runState.subagentsUnsettled = true;
      logger.debug('运行已终止：不再等子智能体收场，分量按「事实缺失」交', { sessionId, pending });
      return false;
    }
    const wait = runtime.client.request('session/wait', { sessionId }, DSH_SUBAGENT_DRAIN_MS);
    /**
     * **终止要能打断等待**：用户按停止之后还让 `session/wait` 跑满 60 s 是错的（真机形状：
     * 6.059 s 按的停止、那一次请求照旧跑满 60 003 ms，`run.json` 最后还给 `completed`）。
     * 等待发生在**收流之前** ⇒ `requestStop()` 此刻正好能把它打断（骨架在 finally 里摘 `onAbort`）。
     */
    const aborted = new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error('aborted while waiting for subagents'));
      if (input.signal.aborted) {
        fail();
        return;
      }
      input.signal.addEventListener('abort', fail, { once: true });
      // 请求先结束就摘掉监听器（别把闭包留在信号上）
      void wait.then(
        () => input.signal.removeEventListener('abort', fail),
        () => input.signal.removeEventListener('abort', fail),
      );
    });
    // 竞速输的那一条仍会 settle：吞掉它的拒绝，别变成 unhandled rejection
    void wait.catch(() => {});
    try {
      await Promise.race([wait, aborted]);
      logger.debug('释放前等到了子智能体收场', { sessionId, waited: pending.length });
      return true;
    } catch (error) {
      /**
       * 等不到就**如实记下来**：`pending` 里那些子会话马上会被 `runtime.close()` 掐死，
       * 「还在跑、以后会报」是假话 ⇒ 分量按「事实缺失」交 `null` 并点名（见 `subagentsUnsettled`）。
       */
      runState.subagentsUnsettled = true;
      logger.warn('释放前等待子智能体收场没成功：这些子任务不会再有读数，分量按「缺失」交 null', {
        sessionId,
        pending,
        error,
      });
      return true;
    }
  };
  const disposeRuntime = createDisposer(async () => {
    closing = true;
    askBridge?.close();
    injectBridge?.close();
    // ⚠️ 这里**不等**子智能体：`finalize` 在释放之前就算完了分量，等在这之后改不了任何结果。
    // 「等」发生在通知流里（`settled` 之后、`break` 之前）——那时子会话的终态与用量还能被投影。
    await runtime.close();
  });
  /** adopt 出来的那条会话（`null` = 这一轮是新会话）；它决定每一轮从哪个入口跑 */
  let adopted: DshSessionHandle | null = null;
  /** 握手有没有成功过（决定出错时该不该由我们回收：见 `catch` 里的两条分支） */
  let runtimeStarted = false;
  /** 这一轮要 adopt 的那条会话（`null` = 新会话）；取值只依赖入参，抛错面在下面的 `try` 里 */
  const resumedSessionId = input.resume?.sessionId ?? null;
  try {
    /**
     * **续接的 adopt**（`input.resume`）：必须在该 id 的第一条 `prompt` **之前**做完
     * ——对已 open 的 id 再 resume 会被厂商拒（`already open or opening`）。
     *
     * 两条口径：
     *   · **客户端没有这一格就如实抛错**（装到比 `0.2.1-alpha.3` 更旧的
     *     `dsh-sdk-jsonrpc-server` 就是这一档：那条 wire 上的 `session/resume` 自它起才有）。
     *     绝不退化成「开一条新会话」——那会让用户以为在追问、而智能体什么都不记得，
     *     界面上一切正常。抛在 `start()` 之前：连冷启动都不必花。
     *   · **adopt 出来的会话句柄是这一轮唯一的跑法**：`session.run()` 与 `harness.run()` 同形，
     *     但身份已经定死；对它再用 `harness.run(text, { sessionId })` 会撞 `already exists`
     *     （那条 wire 永远 create-or-fail，见 `docs/faq/deepseek-harness.md`）。
     */
    if (resumedSessionId !== null && runtime.resumeSession === undefined) {
      throw new Error(
        `本次运行要续接到会话 ${resumedSessionId}，但当前安装的 ${DSH_PACKAGE_NAME} 没有 session/resume`
          + '（该 wire 方法自 @deepseek-ai/dsh-sdk-jsonrpc-server@0.2.1-alpha.3 起才有）'
          + '⇒ 不静默开一条新会话',
      );
    }
    // 在这里就把握手做完（而不是等流的第一次 `next()`）：启动失败属于「本次运行起不来」，
    // 归因要落在 `AGENT_FAILED` 上。`start()` 是幂等的（SDK 的 `this.initialized ??= …`），
    // 流里那次 `start()` 不会重复握手。
    await runtime.start();
    runtimeStarted = true;
    /** adopt 出来的那条会话（`null` = 这一轮是新会话）；它决定每一轮从哪个入口跑 */
    adopted = resumedSessionId === null ? null : await runtime.resumeSession?.(resumedSessionId) ?? null;
    /**
     * 应答面的**父进程那一半**：轮询插件写的提问流水，把每一问交给提问端口，再把答复写回答复流水。
     * 在 `runtime.start()` 之后起——起不来的运行不该留一个空转的轮询（插件也没被加载）。
     */
    askBridge = askAnswerer
      ? startDshAskAnswerer({
        port: context.askUser,
        transcriptPath: askTranscriptPath,
        repliesPath: askRepliesPath,
      })
      : null;
    /**
     * 人工消息面的**父进程那一半**：取件（两档各走各的路）、写投递流水、读收据。
     * 与应答面同一条时序理由：插件是 boot 那一步加载的，桥要在运行时起来之后才谈得上取件。
     *
     * `'idle'` 档的出口是 wire 的 `session/prompt`（它落 `next-turn`）；`'round'` 档写投递流水，
     * 由插件在 runtime 进程内 `agent.steer`（落 `next-step`）。两条都返回厂商那条消息的身份，
     * 撤回按它配对。
     */
    injectBridge = injectionPort === null
      ? null
      : startDshInjection({
        port: injectionPort,
        sessionId,
        queuePath: injectQueuePath,
        receiptsPath: injectReceiptsPath,
        // `client.prompt` 交回的就是那条消息的身份（wire 的 `{messageId}` 已被客户端解开）
        prompt: (text: string) => runtime.client.prompt(sessionId, [{ type: 'text', text }]),
      });
  } catch (error) {
    /**
     * 回收分两支，判据是「握手成功过没有」：
     *   · **`start()` 自己抛**（包没装、握手超时、进程起不来）⇒ 不去关：那是 SDK 拥有的回收点，
     *     它的实现里失败即清理（关掉客户端、换一个新的实例再抛）。此时我们手里也确实没有一个
     *     「已经起来的运行时」——多关一次只会把一个未启动的客户端标成永久关闭。
     *   · **握手之后的任何一步抛**（`resumeSession` 的 adopt、两座桥的构造）⇒ 运行时已经在跑，
     *     而骨架此刻手上还没有 `TurnStart` ⇒ 它没有可释放的对象。这里是唯一能回收的落点：
     *     关一次（幂等），再抛出原始错误——关闭失败只记日志，不许顶替本次运行的真因。
     */
    if (runtimeStarted) {
      try {
        await disposeRuntime();
      } catch (closeError) {
        logger.error('运行时回收失败（已忽略，避免掩盖本次运行的真因）', { sessionId, error: closeError });
      }
    }
    throw error;
  }
  /**
   * 一轮的跑法：新会话走 `harness.run(text, { sessionId })`，续接走 adopt 出来的会话句柄
   * （`adopt` 的围栏见上面那段注释）。写成 `const` 是为了让 `intervalFor` 的闭包拿到一个
   * 不再变化的入口——adopt 的成败在 `try` 里已经定死。
   */
  const adoptedSession = adopted;
  const runPrompt: (prompt: string) => Promise<unknown> = adoptedSession === null
    ? (text: string) => runtime.run(text, { sessionId })
    : (text: string) => adoptedSession.run(text);
  logger.debug('dsh 已注入路由并启动运行时', {
    model: input.route.modelId,
    // **只记名字**（条目的 env / headers 里可能有密钥，日志不该能把它带出去）；
    // registry 那一格同理只记「写没写进去」，不抄宿主那一本次运行的内容（与 claude 侧同一条口径）
    mcpServers: Object.keys(input.mcpServers ?? {}),
    // 技能那一格只记条名（源目录路径进日志没有额外信息量，且可能很长）
    skills: (input.skills ?? []).map((skill) => skill.name),
    npmRegistry: registryLine === null ? null : 'row-npmrc-written',
    protocolType: input.route.protocolType,
    api: wireForProtocol(input.route.protocolType),
    contextWindow: input.route.contextWindow,
    effort: input.effort,
    route: DSH_ROUTE_KEY,
    sessionId,
    // 续接那一格只记「这一轮是不是 adopte 的」（id 已经在上面那一格）与 adopt 之后的有效 cwd
    resumed: resumedSessionId !== null,
    /**
     * 有效 cwd 只作**排障读数**，故它**失败即 `null`**（`readWorkingDirectoryOrNull`）：
     * 写成不可失败的表达式时，一次纯读数的失败（runtime 已收场 / 超时）会把整轮折成
     * `AGENT_FAILED`——观测手段没有资格制造失败。
     */
    resumedWorkingDirectory: adopted === null ? null : await readWorkingDirectoryOrNull(adopted),
    // 应答面那一格只记「这一轮挂没挂」：它是插件落盘与等待档的共同自变量
    askUserAnswerer: askAnswerer,
    // 人工消息面同理（它是插件落盘与 overlay 那一本次运行的共同自变量）
    injectMessages: injectionPort !== null,
  });
  /**
   * **填充层**：dsh 的 SDK 没有 schema 入参（`DeepSeekHarnessOptions` 只有 cwd / provider /
   * model / reasoningEffort / maxTokens，argv 只有 `--profile` / `--patch`）⇒ 原生通道不存在。
   * 要对齐另两家「要了 schema 就按它出 JSON」，这里补两件事：
   *   1. **首轮就把约束写进提示词**（把原生通道本该传达的那份 JSON Schema 附在最后一段）；
   *   2. **提供同会话追问**（`continue`）：骨架发现答复形状不对时回到这里，用**同一个 `sessionId`**
   *      再跑一条 prompt——模型手里已经有工作区与自己的答复，只改形状、不重跑任务。
   * `applied.structuredOutput` 因此**恒为 false**：那一格记的是「有没有走原生 schema 通道」，
   * 填充层是提示词级的，不算（见 `AgentRunResult.applied` 的 JSDoc）。
   */
  const outputSchema = asSchemaObject(input.outputSchema);
  const promptWithSchema = outputSchema === null
    ? input.prompt
    : `${input.prompt}\n${buildStructuredOutputInstruction(outputSchema)}`;
  /**
   * **一份 tap 门闸跨全部活动区间**：它持有旁路文件的读偏移与块位次表（见 `stream-tap.ts`），
   * 每次追问都新建一个会让偏移归零——第一轮的增量会被当成新内容重放一遍。
   * 每条区间的流收尾时都会 `close()` 它（幂等、不重置偏移）⇒ 下一条区间重新打开文件接着读。
   */
  const tap = createDshStreamTapGate(tapFilePath);
  /** 造一条活动区间（首轮与每次追问同形）：同一运行时、同一会话、同一份 runState 与门闸 */
  const intervalFor = (prompt: string): TurnStart => ({
    stream: notificationStream(runtime, sessionId, prompt, runState, tap, runPrompt, () => closing, () => drainLiveSubagents()),
    // 刻意空实现：dsh 不支持中途取消（元数据 cancelMidTurn: false），
    // 停止请求会由第二段兜底成「关闭运行时」
    interrupt: () => {
      logger.debug('dsh 不支持中途取消，停止请求交由第二段强制关闭处理');
    },
    /**
     * 释放走 SDK 的 `close()`（唯一的硬停止通道，`cancelMidTurn: false`）。
     *
     * ⚠️ **这一类同样是「SDK 代 spawn」**：dsh 运行时进程由 SDK 拉起，`HarnessClient` 的公开面
     * 没有任何 pid（`lib/types/*.d.ts` 里一个都没有）⇒ 本仓拿不到整棵树，回收只能**尽力**。
     * 归属与残留风险登记在《厂商进程生命周期规范》的归属表里；行产物清理不假设它一定干净
     * （core 的 `removeTreeWithRetry`）。对照：codex 由本仓自己 spawn，`close()` 必须整棵回收 + 等退出。
     */
    dispose: disposeRuntime,
    /**
     * **收尾也交一次分量**。
     *
     * 为什么必须有：`usage` 事件的发射门槛是**轮次**（`turn.ts` 的发射点），而「子会话收场了却
     * 一条用量都没报到」这个结论是在**不带轮次**的那条通知（`subagent.finished`）上成立的
     * ⇒ 若这一轮之后再没有消息，结论就送不出去，`AgentRunResult.subagentTokens`（进而运行快照）
     * 里留下的是骨架那个初值或上一版的旧数。收尾是**最后**一次机会：它每次运行都跑
     * （正常 / 失败 / 被终止都在 `finally` 里，见 `turn.ts` 的收尾投影），
     * 且 `subagentTokens` 的**显式 `null` 会覆盖**。
     *
     * 这一格走 `null` 时**必须点名**（第三档）：`null` 是
     * 「没采到」，而它与「确实没有子智能体」（`{0,0,0}`）在日志里本来长得一样——另两家都落一条
     * 点名的 WARN（`cc/index.ts` 的「读不到子智能体 …」、`codex/transcript.ts` 的
     * 「未找到子线程 …」），dsh 原来在这里给的是 `drafts: []` ⇒ 一格 `null` 悄无声息。
     * 活的那一半（`usage` 事件）由 `step/start`、`assistant/message` 与 `turn/end` 三条出口带
     * （**三处都同时带两格**，见 `events.ts` 的注记）。
     */
    finalize: () => {
      /**
       * **终止路径也要如实标记「不会再有读数」**：终止时通知流可能**根本没走到** drain（骨架直接收流），
       * 那一条早退分支就不会执行 ⇒ 分量会按「还在跑、以后会报」交 `{0,0,0}` + `turns`，而运行马上释放、
       * 那些子会话再也不会报（真机：这一支零 WARN，与该字段注释自相矛盾）。判据放在收尾这一处，
       * 无论有没有进过 drain 都成立。
       */
      if (input.signal.aborted && [...runState.childSessions].some((id) => !runState.finishedSessions.has(id))) {
        runState.subagentsUnsettled = true;
      }
      const subagentTokens = dshSubagentUsage(runState);
      /**
       * 轮次那一格的分量走**同一个**判据（`dshSilentChildSessions`），且与用量那一格在**同一次
       * 求值**里算出 ⇒ 结果里两格要么都有数、要么都是 `null`（WARN 的条件因此只需看一格）。
       * ⚠️ 别把这句话推广到**事件**层：两格是否同时出现在**某一条**事件上由分支决定——
        * `assistant/message`、`turn/end`、`step/start` 都同时带两格，
       * 其余分支（`turn/start` / `tool/call` / …）**两格都不带**。
       */
      const subagentTurns = dshSubagentTurns(runState);
      return {
        /**
         * ⚠️ 这两格走**结果**（`TurnFinalize.subagentTokens` / `subagentTurns`，骨架折进
         * `AgentRunResult` 与运行快照），**不另发 `usage` 事件**：事件流最后一次读数停在最后一个
         * 带轮次的投影上，而收尾算出的更准的值要到行落终态、界面重新读快照时才显示。
         * 代价登记：极窄的窗口里（「子会话收场却没报用量」且此后没有任何带轮次的通知）
         * 界面上的分量可能比 `run.json` 慢一拍——补一条 `usage` 事件能消掉它，
         * 但那要动三家共用的发射口径，不在本适配器单方面决定。
         */
        // 只有「事实缺失」那一档才落 WARN：`{0,0,0}` / `0`（确实没有）不该刷噪声
        drafts: [
          // 「等不到子会话收场」这一档**独立于分量是不是 null**：它说的是「不会再有读数」这件事，
          // 而分量在那一档也可能已经有部分读数（真机：被杀的子任务交 `{0,0,0}`）
          ...(runState.subagentsUnsettled === true
            ? unsettledSubagentWarns(runState)
            : subagentTokens === null
              ? silentSubagentWarns(runState)
              : []),
          // 技能面「装了却没观测到目录」与插件面「配了却没等到加载收据」：同一处收尾各求值一次
          ...skillCatalogWarns(runState, injectedSkillCount, resumedSessionId !== null),
          ...permissionMismatchWarns(runState, resumedSessionId !== null, sessionId),
          ...pluginWarns({ injectBridge, askBridge }),
        ],
        subagentTokens,
        subagentTurns,
        /**
         * **会话身份如实上报**：它就是本次运行会话的快照键——落了盘之后，跨进程续接才有键可指。
         * 取值恒有（新会话是自己铸的那个、续接是 adopt 的那一个）⇒ 这一格不会走 `null` 档。
         */
        sessionId,
        // 通道事实：dsh 没有原生 schema 通道 ⇒ 恒 false（填充层不算原生，见上面那段注释）
        applied: { structuredOutput: false },
      };
    },
    project: (raw, state) =>
      projectDshNotification(raw, state, { kind: 'dsh', baseUrl: input.route.baseUrl }, runState),
    /**
     * 同会话追问：同一个 `runtime` + 同一个 `sessionId` 再跑一条 prompt。
     * 新会话那一档走 SDK 的 `run(input, { sessionId })`——对已存在的 id 就是「在这条会话上
     * 再跑一轮」（`lib/types/api.d.ts`：「Run one prompt on a fresh (or named) session」）；
     * 续接那一档走 adopt 出来的句柄（`session.run`），两条路都由 `runPrompt` 统一。
     * 会话历史留在厂商进程里 ⇒ 模型看得见自己上一轮的答复与全部工具结果。
     */
    continue: async (nextPrompt: string) => intervalFor(nextPrompt),
  });
  return intervalFor(promptWithSchema);
}
export const dshProvider: AgentProvider = {
  kind: 'dsh',
  displayName: 'DeepSeek Harness',
  metadata: {
    /**
     * **两条 wire 都能收**：适配器把路由声明成 pi-ai 路由，
     * 协议决定 `api`——`anthropic` → `anthropic-messages`、`openai` → `openai-responses`
     * （openai 只走 responses，不映射 chat-completions）。
     * 真机证据：两条 wire 用**产品自己的供应商记录**各跑通一次（含计量），
     * 见 `docs/protocols/dsh.md`。
     *
     * 顺序与 contracts 的枚举一致；它只影响本次运行池里两类模型的排列，判定一律走 `acceptsProtocol`。
     */
    protocolTypes: ['openai', 'anthropic'],
    capability: {
      cancelMidTurn: false, // 实测确认：SDK 没有 wire-level cancel，界面文案必须不同
      // 实测确认：用量在 `session.event → assistant/message → data.usage`
      // （`inputTokens` / `cacheReadTokens` / `outputTokens`）⇒ 打开提取并把这一格改成 true
      usage: true,
    },
    /**
     * 消息能力声明：**五格** `'yes'`。正文增量经 **stream-tap**（`'hook'`：挂进
     * 厂商进程的插件采集）——stdio 通知流本身仍不投送增量（判例见
     * `docs/faq/deepseek-harness.md`），机制与边界全在 `stream-tap.ts` 的文件头。
     * **思考 token**（**没有对应能力维度** ⇒ 只在 `notes` 里记「那一格恒 `null`」）（`reasoningTokens` 在本仓这条 pi-ai 路由上永不投影——`mapUsage()` 有意把推理并入
     * `outputTokens`，而上游确实给了这个数）记 `not-projected-by-vendor`。
     */
    messageCapability: {
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
      streamingDeltaSource: 'hook',
      streamingDeltaReason: null,
      notes: [
        '正文/思考增量经 stream-tap 采集：适配器把一个插件写进每个本次运行 profile 目录'
          + '（overlay `insert`、相对名按 profile 目录解析），插件订阅厂商进程内的 '
          + '`agent/assistant-stream`、把 chunk 帧旁路到 `<configHome>/aieval-stream-tap.jsonl`，'
          + '适配器 tail 后包成 `aieval/delta` 伪通知走同一条投影。stdio 通知流本身不投送增量'
          + '（jsonrpc-server 任何版本都不订阅该进程内事件，判例 `docs/faq/deepseek-harness.md`）。',
        '增量只广播不落盘（编排层三家统一）：`messages.jsonl` 里只有快照；'
          + '被打断的块没有快照，那段半截正文刷新后不可见（实时视图仍有、光标停在断点）。',
        '工具入参增量不投（block-start/block-end 只用于占位换算块位次）：tool-call 的参数走快照整块。',
        '思考增量按 wire 实际产出投送：本路由若不产 `reasoning-delta`，思考仍整块到达（`block-end`/快照）。',
        'max-tokens 截断的那次尝试：厂商把 `content[]` 里的 tool-call 全部丢弃，块位次按流序换算'
          + '可能与截断后的快照错位 ⇒ 实时视图或短暂出现重复块（快照覆盖后自愈；本次运行本就落截断终态）。',
        '子会话增量只放行「已登记」的会话（等 `subagent.started` 投影之后）——避免误归主会话载体。',
        '思考 token（`reasoningTokens`）结构性不可达：`llm-pi-ai` 的 `mapUsage()` 把推理并入 `outputTokens`，那一格恒 `null`',
        '子任务级用量不在 `subagent.*` 通知里 ⇒ 按 `params.sessionId` 把子会话的 `assistant/message.usage` 分组求和',
        '运行时被强制终止时收不到 `subagent.finished` ⇒ 界面必须能显示「未收场」',
        '`stopReason` 的 `error` / `refusal` 两档真机未观测 ⇒ 未覆盖档记 `unknown` + `statusMissing`，不猜',
      ],
    },
    /**
     * 注入面能力：MCP 走 per-launch overlay 的 `insert` 插件行，skill 副本落在 `<DSH_HOME>/skills/`
     * 并由 `user/message` 的 `skill-catalog` 报回来——两条通路都通。
     */
    injection: {
      mcp: { state: 'yes', reason: null },
      skills: { state: 'yes', reason: null },
      notes: [
        'MCP 的判据通道**只有** `request/header` 的 `data.header.tools`（没有服务状态那一格）：起不来时工具静默消失、会话照常跑完、不投结构化错误',
        'skill 的判据通道是 `user/message` 的 `source.kind`：值为 `skill-catalog` 时只有名字 ⇒ 来源只能记「未证实」（`unverified`）',
      ],
    },
    /**
     * 交互面：**能被问**，而模型看到的那个提问工具是**厂商自己的包**。
     *
     * 工具由适配器挂载（overlay 的 `insert` 一行 `@deepseek-ai/dsh-tool-ask-user`），工具名、
     * schema、提示词与两档等待语义全归厂商；我们只在它旁边装一个应答者——厂商的进程内提问服务沿
     * `user-questions/request` 派发到它，由它按 `<configHome>` 下的文件型 side channel 取答复
     * （`providers/dsh/ask-user.ts`）。「通道是我们造的」不等于「工具是我们造的」⇒ 这一格是
     * `vendor-tool` 而不是 `host-tool`。
     *
     * ⚠️ 没有应答面时那一问仍然会拿到厂商自己的收场：等待档随应答面派生（见 overlay 那两个常量），
     * 没挂应答面的轮次走定时档、到点交回厂商设计好的「待答」结果。
     */
    interaction: {
      askUser: 'yes',
      askUserChannel: 'vendor-tool',
      askUserReason: null,
      /**
       * 驱动器是真的：真运行时跑起来、厂商自己的进程内提问服务沿 `user-questions/request` 派发到
       * 我们的应答者插件、答复被厂商折成**真的工具结果**交给下一次模型往返；两臂只差「这一轮挂没挂
       * 应答面」那一格（`testing/dsh-real-path-fixture.ts`）。
       */
      askUserProofDriver: 'real-path',
      askUserProofDriverReason: null,
      notes: [
        '厂商的提问走**进程内**服务（`user-questions/request` 这条 Cordis waterfall），不投送到 SDK 约定的那条通道 ⇒ 应答者只能是一个插件，由适配器写进行配置目录',
        '一致性场景走真路径（真运行时 + 脚本式上游 + 适配器的应答者插件，见 `testing/dsh-real-path-fixture.ts`）：答案按题目 id 配对回给插件，厂商把它逐字折进工具结果',
        '没有应答面的轮里提问工具仍然挂着（工具由适配器挂载、与应答面无关）：那一档的收场归厂商的定时档（到点交回「待答」结果）',
      ],
    },
    /**
     * **人工消息面（第五组）**：人往运行中的一轮送话、以及接着一条已有会话再跑一段。
     *
     * 两档各走一条路（判据是真机读数，机制见 `inject.ts`）：
     *   · `'idle'`（排队）走 **wire** 的 `client.prompt`（`session/prompt` → `followup` → `next-turn`）；
     *   · `'round'`（立即发送）走**进程内插件**的 `agent.steer`（→ `next-step`，比 wire 早一档）
     *     ——wire 上**没有**这条落点，只能照 stream-tap / 提问应答者那套成法写一支插件。
     * 两条都由**同一个身份**认人（我们铸的 `messageId` / wire 回执的那个 id）⇒ 撤回按 id，
     * 同文本两条不会误伤（与 pi 的「按文本相等」相反）。
     *
     * 续接那一格走官方 wire 的 `session/resume`：`input.resume` 走
     * `harness.resumeSession(id)` → adopt 出来的 `session.run(text)`（`harness.run` 一次都不碰）。
     * 正向判据是真路径（`resume-real-path.test.ts`：真运行时 + 脚本式上游，跨三个独立运行）；
     * 装到**更旧**的客户端（没有这一格）时如实抛错，不许静默开一条新会话。
     */
    turnInjection: {
      delivery: {
        round: {
          state: 'yes',
          reason: null,
          channel: 'in-process-plugin',
          gate: null,
          experimental: false,
          // 真路径：`injection-real-path.test.ts` 走真运行时 + 真插件 + 脚本式上游，判据是
          // 「哨兵进没进模型看到的那份请求体」——假件把 SDK 换掉之后这件事根本看不见
          proofDriver: 'real-path',
          proofDriverReason: null,
        },
        idle: {
          state: 'yes',
          reason: null,
          channel: 'wire',
          gate: null,
          experimental: false,
          proofDriver: 'real-path',
          proofDriverReason: null,
        },
      },
      retract: {
        round: {
          state: 'by-id',
          reason: '按我们铸的 messageId（投递时就是厂商那条消息的 id）经进程内插件 inbox.remove 撤；'
            + '返回值只有 boolean，回 false 读作「已被模型吃掉」（竞态里厂商赢），超时读作「说不出为什么」',
        },
        idle: {
          state: 'by-id',
          reason: '按 wire 回执的 messageId 经同一支插件 inbox.remove 撤'
            + '（wire 入队的消息同样落在厂商的待处理队列里）',
        },
      },
      resume: {
        state: 'yes',
        reason: null,
        channel: 'wire',
        gate: null,
        experimental: false,
        // 正向判据是真路径：真运行时 + 脚本式上游，跨三个独立运行（写 / adopt / 阴性对照）
        proofDriver: 'real-path',
        proofDriverReason: null,
      },
      notes: [
        '两档的分工来自真机读数：wire 上唯一可入队的 session/prompt 落 next-turn（= 排队档），'
          + '而 agent.steer 落 next-step（= 立即发送档）',
        '立即发送档要一支常驻插件：插件落 <DSH_HOME> 根、overlay 里以相对名 insert，'
          + '投递与撤回都经文件型 side channel（与 stream-tap / 提问应答者同一种成法）',
        '插件里的 agent 服务必须**每次用时现取**：它由另一行插件 provide，插件加载那一刻多半还没就位',
        '续接走官方 wire 的 session/resume：顺序是 initialize → session/resume → session/prompt，'
          + 'adopt 必须在该 id 的第一条 prompt 之前（对已 open 的 id 再 resume 会被拒）',
        'resume 之后通知流不回放历史 ⇒ 恢复判据只能是入站请求体或磁盘转录，不能拿通知流当证据',
        '那条 wire 永远 create-or-fail：对已存在的 id 直接 session/prompt 会撞 already exists'
          + ' ⇒ 续接必须先 resume 认领',
      ],
    },
    /**
     * 耗时量级：一次运行在**分钟级**（含 overlay 注入、stream-tap 插件到收尾）。
     * 真机冒烟的默认等待预算按这一档派生——声明小了，那一轮会被自己的预算掐掉。
     */
    timing: {
      runScale: 'minutes',
      notes: ['本机实测：一次运行的墙钟在分钟级；运行内首次注入与插件落盘是其中的固定开销'],
    },
    /**
     * 推理证据 events.jsonl 即齐（思考正文与工具结果都在事件流里）⇒ 不需要补 messages.jsonl。
     */
    needsMessagesForReasoningEvidence: false,
    // 档位域 = 本文件的 `DSH_REASONING_WIRE`（**与 overlay 声明同源派生**）：pi-ai 路由的档位是
    // 「档位名 → wire 拼写」的字典，两边各写一份必然漂移，而漂移的代价是「界面能选、运行时才失败」。
    // 为什么是这四档：`llm-deepseek` 的 `reasoningEffort` schema 只有 `off/low/high/max`
    //（没有 `medium` / `xhigh`）——上游网关的档位在 dsh 本次运行上会因此被交集削掉两档，
    // 那是正确结果，不是缺陷。
    reasoningEfforts: DSH_REASONING_EFFORTS,
    // 未选档位时 dsh 实际会用的档（`DSH_DEFAULT_EFFORT`）：API 侧用它拦「未选 + 模型不支持缺省档」，
    // 免得跑到本家的硬校验处才以 `UNSUPPORTED_REASONING_EFFORT` 收场。另两家不声明这一格。
    defaultEffort: DSH_DEFAULT_EFFORT,
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'dsh',
      start: startDsh,
    }),
};
