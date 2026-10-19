/**
 * codex 适配器：`codex app-server`（JSON-RPC / stdio）驱动本次运行，通知流给内容，收尾用 `reader` 补齐。
 *
 * 四条结构约定：
 *   1. **一次运行一个 app-server 进程**：`session.ts` 建线程、起轮次、流式交通知；取数面
 *      （`reader.ts` 的 `thread/list{ancestorThreadId}` + `thread/read`）**复用同一个客户端**
 *      ——线程树是那个进程的内存态，另起一个进程读不到，重开一个会话更不是「读同一件事」。
 *   2. **内容由通知驱动，收尾补齐子线程**：运行期每条通知都投影成事件与草稿；收尾用 `reader` 把
 *      **没推给本条连接**的那些子线程历史补上。两条入口共用 `message.ts` 的同一个归一函数
 *      ⇒ 同一条条目从哪进来都归一成同样的块。
 *   3. **用量与轮次同源**：用量只从运行期的 `thread/tokenUsage/updated` 累计（协议没有「按线程读
 *      用量」的请求），轮次只数「模型答复条目」。任一子线程拿不到用量 ⇒ `subagentTokens` 与
 *      `subagentTurns` **同时**为 `null` 并落一条点名 WARN（分量与它所属的合计必须同刻、同尺）。
 *   4. **收尾取数在后台先跑**：`TurnStart.finalize` 是**同步**出口，而 `reader` 的请求是异步的
 *      ⇒ 收尾取数在运行期就以「会话结算」为闸门启动，`finalize` 只读它已经落定的结果。
 *
 * 能力面与 `providers/dsh` 逐格对齐；结构性给不了的格子登记在 `messageCapability.notes` 与
 * `docs/protocols/codex.md`（Codex 接入，含能力对齐判据）。
 */
import { realpathSync } from 'node:fs';
import { createLogger, materializeSkills } from '@aieval/core';
import { classifySkillOrigin, EFFORT_OFF, type SubagentRecord, type UsageTokens, type VendorSkill } from '@aieval/contracts';
import { logDraft, vendorSystemDraft, type AgentEventDraft } from '../../emit';
import type { MessageDraft } from '../../message';
import {
  hostNpmrcPath,
  readNpmrcText,
  toCodexMcpServers,
  writeRowNpmrc,
  type CodexMcpServer,
} from '../../mcp';
import { codexPermissionOptions } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix } from '../../route';
import { asSchemaObject } from '../../structured-output';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult } from '../../types';
import { addUsage, sumUsageTokens } from '../../usage';
import { resolveCodexBinary } from './appserver/binary';
import { createAppServerClient, type AppServerClient, type AppServerEnv } from './appserver/client';
import type { AppServerNotificationPayload } from './appserver/protocol';
import { createCodexAskResponder, type CodexAskResponder } from './ask-user';
import {
  listDescendantThreads,
  listSkills,
  readThreadContent,
  type AppServerThreadContent,
  type AppServerThreadRef,
} from './appserver/reader';
import { startCodexSession, type CodexSession } from './appserver/session';
import { breakdownToTokens, projectCodexEvent } from './events';
import { createCodexInjection } from './turn-injection';
import { askUserCallDraft, noteThreadStarted, projectCodexMessages, projectSubagentRecord, projectThreadMessages, threadRoundTrips } from './message';
import { createCodexRunState, currentMcpStartup, observedTurns, type CodexRunState } from './run-state';

const logger = createLogger('agents/codex');

/**
 * 一次运行里「人话续跑」最多起几轮。
 *
 * 为什么必须有上限：人一直发消息就能一直续跑，而这一行**永远不收场**——编排层的等待预算只在
 * 适配器返回之后才开窗口，靠它兜不住这里。上限到点就当没有更多话，按正常收场走。
 * 写成可变对象是给用例压小用的（`beforeEach` 读产品默认值再改、`afterEach` 还原）。
 */
export const CODEX_IDLE_CONTINUATION = { rounds: 3 };

/**
 * 等「厂商自己投递起的那一轮」出现 `turn/started` 的预算（毫秒）。
 *
 * 为什么要等：那一种起轮不是我们发起的（`thread/queue/add` 落在空闲线程上时厂商当场就投），
 * 于是没有 `thread/queue/start` 的返回值可拿 turd id；而**绝不能当场收场**——收场即 `dispose` 杀进程，
 * 那一轮连同人话一起没（真机复现）。
 *
 * 为什么要有界：厂商若因为任何原因没把这一轮跑起来（例如投递失败、线程又忙了），
 * 没有这一格这一行会一直挂在流上（看门狗只在适配器返回之后才由编排层兜）。读数取 5 秒：
 * 真机上 `turn/started` 与 `queue/add` 在同一拍内到达（毫秒级），5 秒是两个数量级的余量。
 * 写成可变对象是给用例压小用的（口径同 `CODEX_IDLE_CONTINUATION`）。
 */
export const CODEX_VENDOR_TURN_WAIT = { waitMs: 5_000 };

/**
 * 「等后代线程静下来」的预算（毫秒）与轮询间隔。
 *
 * 为什么需要这一段：本轮结算的闸门是**主线程的 `turn/completed`**，而模型派出去的子智能体往往
 * 还在跑。那一刻收尾取数会把子线程读成半截（真机读数：`thread/read{child}` 的
 * `status = {"type":"active"}`、`items` 只有 1 条 `userMessage`）、子任务行记成
 * `status:"running"/outcome:null`、它的用量通知也没人投影，随后 `dispose` 把那一轮掐掉
 * （那一轮的花费白付）。这里给一个**有界**的静默窗口：窗口内继续消化通知，树静了就收尾。
 *
 * 三条口径：
 *   · **没有后代线程时不花任何时间**：第一次枚举回空表就直接放行（绝大多数行走这一档）；
 *   · **有界**：到点按现状收尾，由既有的 WARN 如实点名「不是全量」，不把一行永久挂住；
 *   · **取消那一档不等**：用户点了终止就立刻放行（那条通路本来就不取数）。
 * 写成可变对象是给用例压小用的（口径同 `CODEX_IDLE_CONTINUATION`）。
 */
export const CODEX_DESCENDANT_QUIET_WAIT = { waitMs: 10_000, pollMs: 250 };

/** 本仓统一的关闭档名（契约与界面都用它；这一家要翻成 CLI 的 `none`） */
const CODEX_OFF_EFFORT = EFFORT_OFF;

/**
 * 关闭档的**第二格**：CLI 的 `model_reasoning_summary`。
 * 它与 `effort: 'none'` 是**两格一起**才生效的前后半：只给 effort 时请求体里仍有 `summary: 'auto'`，
 * 而 `include ∧ summary` 的合取让网关照旧推理（两半各缺一次都会退回）。
 */
const CODEX_OFF_REASONING_SUMMARY = 'none';

/** 网关凭据的环境变量名：provider 的 `env_key` 由它取 Bearer（值进子进程环境，不写 process.env） */
export const CODEX_API_KEY_ENV = 'OPENAI_API_KEY';

/**
 * 档位名 → CLI 的 `model_reasoning_effort` 取值。**只有关闭档不同名**：CLI 的关闭档是 `none`，
 * 而契约与界面统一用 `off`（`off` 会被网关拒）。其余档位逐字透传。
 */
export function codexEffortOf(effort: string): string {
  return effort === CODEX_OFF_EFFORT ? 'none' : effort;
}

/** 本仓注入的 provider 条目名：`model_providers` 的键与 `model_provider` 的取值必须同名 */
const CODEX_PROVIDER_ID = 'aieval';

/**
 * 关掉内置 hosted 联网工具的**唯一生效开关**：顶层 `web_search`。
 *
 * ⚠️ **不是** `tools.web_search`：那一格只是 web search 的**参数容器**（filters / user_location /
 * context size），真机 A/B 两臂里给不给它，出站请求体的工具表**逐字相同**（`web_search` 一直在），
 * 而 `web_search: 'disabled'` 一给，`type:"web_search"` 那一项当场消失（C 臂，含正对照）。
 * 默认值是 `Cached`（= 会带上这件工具）⇒ 不显式关掉就等于一直开着。
 *
 * 为什么要关：本仓的评测面要求四家的工具表尽量可比（claude 只在非 claude 模型上禁 `WebSearch`、
 * dsh 那一侧是凭据缺失挂着），而 hosted 工具由厂商服务端执行、自定义网关上并不保证兑现。
 */
const CODEX_WEB_SEARCH_OFF = 'disabled';

/**
 * 提问工具的两格线程级开关：**两格一起**才让厂商在运行期受理那次调用。
 *
 * 为什么非要开：0.156.1 默认就把 `request_user_input` 列进工具表（系统提示与工具表都不随这两格变），
 * 开关管的是**运行期收不收这次调用**——不开时厂商把调用弹回
 * `request_user_input is unavailable in Default mode`，一条服务端请求都不下发。⇒ 不开就没有提问可言。
 *
 * 为什么开到 `features` 那一格：`tools.experimental_request_user_input.enabled` 只过 `ToolsToml`
 * 的成员表，另一格在特性表里（`features.default_mode_request_user_input`）；两格都开是照探针的臂定义，
 * 「只开一格够不够」没有读数，不猜。
 */
const CODEX_ASK_SWITCH_TOOLS = { experimental_request_user_input: { enabled: true } } as const;
const CODEX_ASK_SWITCH_FEATURES = { default_mode_request_user_input: true } as const;

/** `buildCodexConfig` 的可选面：每一格缺席时**整个键都不出现**（= 「我们没意见」，见各格注释） */
export interface CodexConfigOptions {
  /** 模型上下文窗口：CLI 内置目录里没有我们网关的模型名，这个数只能由我们告诉它 */
  contextWindow?: number | undefined;
  /** `model_reasoning_summary`：关闭档的第二格，见 `CODEX_OFF_REASONING_SUMMARY` */
  reasoningSummary?: string | undefined;
  /**
   * 线程级的推理档位（`model_reasoning_effort`）。
   *
   * 为什么**同时**写进 config：`turn/start` 那一格只管它起的那一轮，而人话续跑起的那一轮走
   * `thread/queue/start`——那个请求的参数**只有** `threadId` 与 `queuedSubmissionId`（探针 dump
   * `v2/ThreadQueueStartParams.json` 的 `required`），带不了档位 ⇒ 只能靠线程级这一格兜住。
   * 不给的话，续跑那一轮会按线程默认档跑，而行快照上写着用户选的那一档（一句半真话）。
   * 同一个值写两处不是重复：一处管本轮、一处管线程默认，取值同源（都来自 `input.effort`）。
   */
  reasoningEffort?: string | undefined;
  /** MCP 条目（形状由 `toCodexMcpServers` 一处定）；空集整个键都不给 */
  mcpServers?: Record<string, CodexMcpServer> | undefined;
  /**
   * 本次运行有没有应答面（`AskUserPort.available`）。`true` ⇒ 打开上面那两格提问开关。
   *
   * 为什么必须由调用方显式给、而不是这里自己读环境：不挂应答面时那两格**一个字都不该动**
   * ——「默认不介入」这条边界要能被断言成「配置逐字不变」。
   */
  askUser?: boolean | undefined;
}

/**
 * 线程级配置：把本次运行的路由写进 app-server 的 `config`。
 *
 * 为什么整份给 `model_providers` 而不是只给一个 base URL：环境里已有的 `~/.codex` 配置会**赢过**
 * 我们注入的地址，只有显式建条目才由我们说了算。键名按本仓探测过的 CLI 配置面：
 * `wire_api` 只能是 `responses`、**`env_key` 决定 Bearer 从哪个环境变量取**（缺它一个头都不附，
 * 全部 401）、`features.multi_agent` 决定子智能体工具是否注册（关掉之后模型照样会调，只是拿回一句配置提示）。
 *
 * ⚠️ **`model_provider` 与 `model_providers` 是一对，少哪个都不行**：只建条目而不指定
 * `model_provider` 时，CLI 会退回它**内置的默认 provider**（`api.openai.com`）——表现是
 * `Reconnecting... waiting for network`（网络层连不上），而不是我们网关的 401，极难从表象归因。
 *
 * ⚠️ **`requires_openai_auth` 必须保持 `false`**：`true` 走的是 ChatGPT 登录态那条路，即使
 * `OPENAI_API_KEY` 就在子进程环境里也 `auth.header_attached=false` ⇒ 全部 401（`api_request`
 * 日志里三格同时出现：`status_code=401` / `header_attached=false` / `env_openai_api_key_present=true`）。
 * 换 `env_key` 后同一网关 `status_code=200` 且 `header_attached=true`。
 *
 * 两格**只在已知时出现**（`undefined` ⇒ 键整个不存在，那才是「我们没意见」的形态）：
 *   · `model_context_window`：CLI 内置目录里没有我们网关的模型名，这个数只能由我们告诉它；
 *   · `model_reasoning_summary`：关闭档的第二格，见 `CODEX_OFF_REASONING_SUMMARY`。
 *
 * 提问工具那两格（`tools` / `features`）**只在挂了应答面时**并进去（见 `CodexConfigOptions.askUser`）：
 * 开了开关却没人答，厂商会一直等那一帧（`isBlocking: false` 与 `autoResolutionMs: null` 都不让它自己收场）。
 */
export function buildCodexConfig(baseUrl: string, options: CodexConfigOptions = {}): Record<string, unknown> {
  const { contextWindow, reasoningSummary, reasoningEffort, mcpServers, askUser } = options;
  return {
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'aieval gateway',
        base_url: baseUrl,
        wire_api: 'responses',
        env_key: CODEX_API_KEY_ENV,
        request_max_retries: 1,
      },
    },
    // 内置联网工具：开关在**顶层**（见 `CODEX_WEB_SEARCH_OFF`），`tools` 那一格管不到它
    web_search: CODEX_WEB_SEARCH_OFF,
    tools: {
      update_plan: { enabled: true },
      ...(askUser === true ? CODEX_ASK_SWITCH_TOOLS : {}),
    },
    features: {
      multi_agent: true,
      ...(askUser === true ? CODEX_ASK_SWITCH_FEATURES : {}),
    },
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
    ...(reasoningSummary === undefined ? {} : { model_reasoning_summary: reasoningSummary }),
    ...(reasoningEffort === undefined ? {} : { model_reasoning_effort: reasoningEffort }),
    /**
      * MCP 条目：形状由 `toCodexMcpServers` 一处定（snake_case、无 `type`），
     * 这里只决定「放不放进去」。**空集整个键都不给**（与 effort 同一条口径）：给了空表等于向
     * codex 声明「本行显式要零台」，与「本次没有程序化注入」不是一件事。
     */
    ...(mcpServers === undefined || Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers }),
  };
}

/**
 * codex 的 **MCP 能力缺口**：本机自定义 OpenAI 兼容 Responses 网关下，
 * 注入成功（`mcpServer/startupStatus: ready`）、零审批请求，但模型发起的调用回来是
 * `unsupported call: <tool>`，MCP server 侧零 `tools/call`；同轮内置 shell 工具正常。
 *
 * 根因（定性）：codex 自 0.156 起按「命名空间」暴露 MCP 工具，而自定义网关转发时把它**拍平**
 * （上游同型 issue：#26977 / #20652 / #26234）；本地矩阵五组全败（两模型 / 一个特性开关 /
 * 升级到 0.163.0-alpha.5）⇒ **不是本仓能解的**，写进已知边界而不是硬修。
 *
 * 面向用户的文案是契约里的 `CODEX_MCP_DISPATCH_GAP_NOTE`（界面与知识库共用那一份）——
 * 适配器这一侧只留**事实与证据**：启动状态事件照投（`mcpChannel: 'vendor-startup-status'`），
 * 一个字都不暗示「工具可用」。
 */

/**
 * 一次运行的取数面（可注入）。
 *
 * 为什么挂在 provider 对象上而不是模块级可变量：注册表是「按 kind 解析出 provider 再调 run」的
 * 唯一入口，注入必须**跟着这一个对象**走，「并行跑两行、一行用假客户端」这件事的边界才清楚。
 * 两个函数合成一个入口：`session.ts` 与 `reader.ts` 必须共用**同一个** `AppServerClient`。
 */
export interface CodexRuntimeHooks {
  /**
   * 建客户端；缺省 = 真 spawn `codex app-server`。
   *
   * `onServerRequest` 由适配器按本次运行的提问端口造好（见 `ask-user.ts`）：注入口必须把它传下去，
   * 漏了的表现是**静默**的——提问请求照旧到达、厂商照旧一直等那一帧（没有报错、没有事件）。
   *
   * `wrapServerRequest` 是给**观察者**用的（真路径夹具要读厂商下发的原始 params、抄一份我们写回去的帧）：
   * 它包在**产品那一个应答者外面**，包装器拿到的那一份仍是产品造的，因此产品在应答者里做的事
   * （把提问那一半投进账本、主线程判据）照旧发生——注入方**替换**应答者时那一半会整个消失，
   * 而症状是界面上只剩一条没有题目的答复行。
   */
  createClient: (input: {
    binary: string;
    env: AppServerEnv;
    onServerRequest?: CodexAskResponder | undefined;
    wrapServerRequest?: ((inner: CodexAskResponder) => CodexAskResponder) | undefined;
  }) => AppServerClient;
  /** 解析 codex 可执行文件；缺省 = SDK 自带的平台包（`appserver/binary.ts`） */
  resolveBinary: () => string;
}

/**
 * 生产缺省：真 spawn。
 *
 * `appserver/client.ts` 只依赖 Node 内置（`child_process`），不像三家厂商 SDK 那样可能整个缺装
 * ⇒ 静态导入不会把「一家故障」放大成「整包不可用」（A6），故这里不做动态 import。
 */
export const defaultCodexRuntimeHooks: CodexRuntimeHooks = {
  createClient: (input) => {
    const inner = input.onServerRequest;
    const onServerRequest = inner === undefined
      ? undefined
      : (input.wrapServerRequest === undefined ? inner : input.wrapServerRequest(inner));
    return createAppServerClient({
      binary: input.binary,
      env: input.env,
      ...(onServerRequest === undefined ? {} : { onServerRequest }),
    });
  },
  resolveBinary: resolveCodexBinary,
};

/** 一次运行的内部句柄：会话 + 客户端 + 状态 + 收尾取数的落点 */
interface CodexRun {
  client: AppServerClient;
  runState: CodexRunState;
  /** 主线程 id：`thread/list{ancestorThreadId}` 的锚点，也是「会话身份」的判据 */
  mainThreadId: string;
  /** 本行已交出的权威读数（主线程没采到用量时的兜底，也是收尾判「要不要再发一条」的依据） */
  lastTokens: UsageTokens | null;
  /** 收尾取数的结果（由 `startFinalizeReader` 在后台填；`null` = 还没落定） */
  readback: CodexReadback | null;
  /**
   * 流内投影**已经折过失败**没有（`turn/completed{failed}` 那条路）。
   * 收尾那条兜底失败（`sessionFailed`）要靠它去重：同一件事不许落两条。
   */
  sawTerminalFailure: boolean;
}

/** 收尾取数的落点：要么是一份**全量**，要么是「这一份不是全量」 */
interface CodexReadback {
  /**
   * `null` = **枚举失败**（或收尾整体失败）⇒ 分量整格记 `null`（「全量或 null」）。
   *
   * ⚠️ **单条线程的 `thread/read` 失败不走这一档**：那条线程仍进数组、只把它的 `content` 记
   * `null`（内容少一份 ≠ 用量不是全量）——用量与轮次分量照给。
   */
  threads: Array<{ ref: AppServerThreadRef; content: AppServerThreadContent | null }> | null;
}

async function startCodex(context: TurnContext, hooks: CodexRuntimeHooks): Promise<TurnStart> {
  const { input } = context;
  const env = buildSubprocessEnv({
    homeDir: input.configHome,
    injected: {
      // 该行独立的 codex home：会话记录、配置、缓存都落在它下面（行与行之间不共享状态）
      CODEX_HOME: input.configHome,
      // 网关凭据进**子进程环境**（不写 process.env）：provider 的 `env_key` 由它取 Bearer
      [CODEX_API_KEY_ENV]: input.route.apiKey,
    },
  });
  const baseUrl = ensureV1Suffix(input.route.baseUrl);
  /**
   * 本行的**技能装入**：把清单里那几条整目录复制进 `<CODEX_HOME>/skills/`（= `configHome/skills`）。
   *
   * 时机：必须在 `hooks.createClient(...)` **之前**——app-server 起来的那一刻就把
   * `<CODEX_HOME>/skills` 扫进技能清单，写晚了这一次 spawn 就看不到它们，而**它不报错**
   * （只是这一行按「没有这条 skill」跑完）。
   *
   * **不传 `skills` ⇒ 一次都不调**（连 `skills/` 目录都不建）：评分与用例同步两处不该有技能面，
   * 而「不传」是这条口径唯一的表达方式（空数组会被物化成「建了目录、零条」）。
   * 落不下去时物化函数**抛**（点名哪一条），由骨架归成 `AGENT_SKILLS_UNAVAILABLE`、该行失败。
   */
  if (input.skills !== undefined) {
    materializeSkills({ configHome: input.configHome, skills: input.skills });
  }
  /**
   * 行内 npm registry（与 claude / dsh 同一条口径）：宿主的 `.npmrc` 里那一行**照抄**进
   * 行私有 `configHome`。本行的 `HOME` 已被换成行私有目录 ⇒ npm 的 `userconfig` 从 `~/.npmrc`
   * 变成 `<行HOME>/.npmrc`（不存在）⇒ registry 掉回公网，行内首次注入 playwright MCP 从 ~4 s
   * 变成 17.2 s / 61 MB（≥ 20 s 的等待预算就是被它撑起来的）。
   * 时机：必须在 app-server 起 MCP 子进程**之前**——写完再 spawn。
   */
  const registryLine = writeRowNpmrc({
    configHome: input.configHome,
    hostNpmrc: readNpmrcText(hostNpmrcPath()),
  });
  /**
   * MCP 条目 → 线程级 config 的 `mcp_servers`。
   * 落点为什么是线程级 config（而不是 `$CODEX_HOME/config.toml`）见 `toCodexMcpServers` 的 JSDoc
   * （两条路都真机验过：A 臂走 config 能到 `ready`，B 臂写文件是已知可达的对照）。
   */
  const mcpServers = toCodexMcpServers(input.mcpServers ?? {});
  const binary = hooks.resolveBinary();
  /**
   * 提问应答者的落点：**与客户端同生**（服务端请求可能在 `thread/start` 一返回就下发，
   * 那时补挂已经晚了）。主线程 id 要到 `thread/start` 才知道 ⇒ 用取值函数把那一格推后。
   *
   * `onAskRequest` 把**提问那一半**投进账本（见 `ask-user.ts` 的该选项）：这一家的提问不进通知流，
   * 账本里没有第二个来源，而 `runState` 与主线程 id 都已经在手上 ⇒ 建客户端之前就能接上。
   */
  let mainThreadId: string | null = null;
  const runState = createCodexRunState();
  const askResponder = createCodexAskResponder({
    port: context.askUser,
    mainThreadId: () => mainThreadId,
    onAskRequest: (params) => {
      // 主线程 id 未落定时按应答者同一口径处置（它那一刻也把这一问按主线程接）：两个判据同源
      context.emitMessage(askUserCallDraft(params, runState, { mainThreadId: mainThreadId ?? params.threadId }));
    },
  });
  const client = hooks.createClient({ binary, env, onServerRequest: askResponder });
  /**
   * 权限档（见 `permission.ts`）：执行阶段 danger-full-access（workspace-write 默认关掉网络，
   * 装依赖 / 跑测试会因此失败），评分阶段只读；批准策略两档都是 never——评测是非交互的。
   * **走 `codexPermissionOptions()` 而不是直接索引那张表**：Windows 上只读档没有可用实现，
   * 那一层把豁免收在一处（否则评分智能体会在 Windows 上盲评，见该函数的注释）。
   */
  const permissionOptions = codexPermissionOptions(input.permission);
  // 收窄一次交给厂商：非对象一律按「没给」处置（见 `asSchemaObject` 的注释）
  const outputSchema = asSchemaObject(input.outputSchema);
  /**
   * **回到某一轮**的源线程：`thread/fork` 必须有一条源线程可分，而这一行的源线程就是
   * `resume.sessionId`。收到 `fork` 却没有源线程时**抛中文错**（不许静默开新会话——
   * 那会让「回到第 N 轮」变成「什么都不记得的新会话」，而界面上一切正常）。
   */
  if (input.fork !== undefined && input.resume === undefined) {
    throw new Error('[agents] codex 收到 fork 但没有源线程（resume.sessionId）：无法分叉，本层不静默开新会话');
  }
  const forkThreadId = input.fork === undefined ? null : input.resume?.sessionId ?? null;

  const session = await startCodexSession({
    binary,
    env,
    cwd: input.cwd,
    model: input.route.modelId,
    ...(input.effort === undefined ? {} : { effort: codexEffortOf(input.effort) }),
    sandbox: permissionOptions.sandboxMode,
    approvalPolicy: permissionOptions.approvalPolicy,
    config: buildCodexConfig(baseUrl, {
      contextWindow: input.route.contextWindow,
      reasoningSummary: input.effort === CODEX_OFF_EFFORT ? CODEX_OFF_REASONING_SUMMARY : undefined,
      // 线程级也写一份：人话续跑起的那一轮走 `thread/queue/start`，那个请求带不了档位（见该格注释）
      reasoningEffort: input.effort === undefined ? undefined : codexEffortOf(input.effort),
      mcpServers,
      /**
       * 提问工具的两格开关**只在挂了应答面时**打开（见 `CodexConfigOptions.askUser`）。
       * 反之，开了开关却没人答时厂商会一直等那一帧——所以「不问就不动」在这里同时是**安全边界**。
       */
      askUser: context.askUser.available,
    }),
    prompt: input.prompt,
    /**
     * **续接**：`AgentRunInput.resume.sessionId` 就是上一次运行交回来的 `threadId`。
     * 给了就走 `thread/resume{threadId}`——键只有它（与 cwd 无关），且**绝不回落 `thread/start`**
     * （静默开新会话会让「追问」变成「智能体什么都不记得」，而界面上一切正常）。
     * 接上之后**照旧发一次 `turn/start`** ⇒ 续接轮同样有在途轮，人话两档都可用
     * （`'round'` 的有效范围见 `turn-injection.ts` 的第 1 条）。
     */
    ...(input.resume === undefined ? {} : { resumeThreadId: input.resume.sessionId }),
    // **回到某一轮**：`thread/fork` 从源线程分出一条新线（源线程 = `resume.sessionId`）；
    // `fork` 缺席时这一格整个不出现 ⇒ 既有 `thread/resume` 行为逐字不变。
    ...(forkThreadId === null ? {} : { forkThreadId }),
    /**
     * 结构化输出按需带：给了 schema ⇒ 交给 `turn/start` 的一等字段 `outputSchema`
     * （形状由 codex 侧约束）。非对象（字符串 / 数组 / null）**什么都不传**——那不是一个能交给
     * 厂商的 JSON Schema（收窄理由见 `asSchemaObject`）。
     */
    ...(outputSchema === null ? {} : { outputSchema }),
    client,
  });
  // 主线程 id 落定：应答者靠它把**子线程**发起的提问挡在人面前之外（见 `ask-user.ts`）
  mainThreadId = session.threadId;
  logger.debug('codex 已启动 app-server 会话', {
    model: input.route.modelId,
    contextWindow: input.route.contextWindow,
    effort: input.effort,
    baseUrl,
    threadId: session.threadId,
    // **只记名字**（条目的 env / http_headers 里可能有密钥，日志不该能把它带出去）；
    // registry 那一格同理只记「写没写进去」，不抄宿主那一行的内容（与 claude 侧同一条口径）
    mcpServers: Object.keys(mcpServers),
    // 技能那一格只记条名（源目录路径进日志没有额外信息量，且可能很长）
    skills: (input.skills ?? []).map((skill) => skill.name),
    npmRegistry: registryLine === null ? null : 'row-npmrc-written',
  });

  const run: CodexRun = {
    client,
    runState,
    mainThreadId: session.threadId,
    lastTokens: null,
    readback: null,
    sawTerminalFailure: false,
  };
  /**
   * **注入接线**：两档各自的落点见 `turn-injection.ts`。三件事在这里定：
   *   · 端口读**骨架包装过的那一份**（`context.inject`）：缺席与关闭已由骨架归一成同一个关闭档，
   *     等待登记（「在等人工消息」那一格）也在包装层——适配器只剩 `available` 一个判据要读，
   *     而这条判据只在 `createCodexInjection` 内部读一次（`available === false` ⇒ 接线是空实现，
   *     这一轮一格都不挂，「零回归」的判据）；
   *   · `activeTurnId` 由**流那一侧**维护：`turn/steer` 的 `expectedTurnId` 必须是当前在途那一轮，
   *     而「本轮收场了」这件事我们比端口更早看到（终态通知）；
   *   · 收场投递要在流结束**之前**落定：`dispose` 一关客户端，那条消息就再也交不出去。
   */
  let activeTurnId: string | null = session.turnId;
  /**
   * 「在等厂商**自己**投递起的那一轮」：`deliverIdle` 的 `vendorDispatched` 分支把它置真。
   *
   * 为什么需要这一格：那种起轮不是我们发起的（没有 `thread/queue/start` 的返回值），它的 turn id
   * 只能从 `turn/started` 进流那一刻拿到——而那一帧排在我们当前这一拍**之后**（我们正站在
   * `turn/completed` 的处理里）。所以这里只记「在等」，等到了就补在途轮号；
   * 等不到就用一个**有界**的预算收场（见 `CODEX_VENDOR_TURN_WAIT`），不把一行永久挂住。
   */
  let awaitingVendorTurn = false;
  let vendorTurnTimer: ReturnType<typeof setTimeout> | null = null;
  const clearVendorTurnWait = (): void => {
    awaitingVendorTurn = false;
    if (vendorTurnTimer !== null) {
      clearTimeout(vendorTurnTimer);
      vendorTurnTimer = null;
    }
  };
  const injection = createCodexInjection({
    port: context.inject,
    activeTurnId: () => activeTurnId,
    steer: (one) => session.steer(one),
    queueAdd: (one) => session.queueAdd(one),
    queueDelete: (id) => session.queueDelete(id),
    queueList: () => session.queueList(),
    queueStart: (id) => session.queueStart(id),
  });
  /**
   * **续跑闸门**：这一行的**收场时机**由它决定。
   *
   * 为什么需要它：`'idle'` 档的人话只能靠「厂商起一轮」进模型上下文，而那一轮必须有人接着消费
   * 事件流——流若在第一轮收场时就结束，`dispose` 随即杀掉 app-server，那条消息就白投了
   * （那正是这一档过去的缺陷）。闸门让主线程一轮收场时**先别结算**，等这一拍把端口里的人话
   * 交出去、起了新的一轮再继续。
   *
   * 三条边界，每条挡一种错法：
   *   · **只在挂了注入面时装**（`context.inject.available`）：不挂时一格都不碰 ⇒ 帧序与过去逐字相同
   *     （「不挂应答面就不动」的零回归判据）；
   *   · **失败与取消都不续跑**：一轮已经失败（401 / 429 / 上游 5xx）或用户点了终止时再起一轮没有
   *     意义，而厂商在中断之后本来就把队列置为暂停；
   *   · **有上限**：人一直发就能一直续跑的话，这一行永远不收场，而编排层的等待预算根本不会被触发
   *     （它只在适配器返回之后才开窗口）⇒ 上限到了就当没有更多话，正常收场。
   */
  const continuation = { used: 0 };
  if (context.inject.available) {
    session.installTurnGate((outcome) => {
      if (outcome.status === 'failed') return false;
      if (input.signal.aborted) return false;
      return continuation.used < CODEX_IDLE_CONTINUATION.rounds;
    });
  }
  /**
   * 技能面：**起会话之后立刻取一次**（app-server 已就绪、`thread/start` 已回来 ⇒ 连接可用）。
   * **只在本行真的装了技能时取**（`input.skills` 给过）：评分与用例同步那两处不传这一格，
   * 它们不该付这次 RPC 的钱、也不该在事件流里多出一条「采不到」的 WARN（与物化同一条判据）。
   *
   * 之所以在这里同步 await 而不是像收尾取数那样后台跑：它是一次**本地进程**的 RPC（不是模型调用），
   * 耗时毫秒级；而收尾取数读的是「跑到收尾才知道」的会话文件，两者不是一类东西。
   * 失败**只记文案**（`entries: null`）：观测是补充信息，不许把一次正常运行翻成失败。
   * 落点在 `runState`（不是 `CodexRun` 的另一个字段）：事件投影也要读它，两处各存一份必然漂移。
   */
  if (input.skills !== undefined) {
    run.runState.skillProbe = await probeCodexSkills(client, { configHome: input.configHome, cwd: input.cwd });
  }
  /**
   * 「后代线程静下来」这道闸门的放行口：`asRawStream` 的静默窗口结束时放行（取消那一档也放行）。
   * 收尾取数等它——否则取数会赶在子线程收场之前把树读成半截。
   */
  let releaseQuiet: () => void = () => undefined;
  const quiet = new Promise<void>((resolve) => {
    releaseQuiet = resolve;
  });
  // 收尾取数：以「本轮结算 + 树静」为闸门在后台跑，`finalize` 只读已经落定的结果（见文件头第 4 条）
  const readback = startFinalizeReader(run, session, quiet);

  return {
    /**
     * 通知流：`session.notifications` 交出的**已经是**归一化载荷（`session.ts` 的职责），而骨架的
     * `project` 收的是原始消息 ⇒ 这里过一层显式断言。宽进严出：`project` 的入参是 `unknown`。
     *
     * `readback` 是汇合点：收尾取数必须在流**结束之前**落定，`finalize` 才能读到它（见 `asRawStream`）。
     */
    stream: asRawStream(session.notifications, readback, input.signal, {
      /**
       * 有界静默窗口：每一拍把**流停之后入队的**通知取出来交给调用方投影（用量只从通知来），
       * 同时问一次「后代线程还活着吗」。三条出口——树静了 / 没有后代 / 预算到点。
       * 取消那一档在外层判掉（`asRawStream` 不会走这一支），这里不再看信号。
       */
      settleDescendants: async function* (): AsyncGenerator<AppServerNotificationPayload> {
        const deadline = Date.now() + CODEX_DESCENDANT_QUIET_WAIT.waitMs;
        for (;;) {
          for (const leftover of session.drainPending()) yield leftover;
          let busy: boolean;
          try {
            const refs = await listDescendantThreads(run.client, run.mainThreadId);
            busy = refs.some((one) => one.status.type === 'active');
          } catch (error) {
            // 枚举失败：不再等（收尾取数那一侧会把「不是全量」如实点名）
            logger.warn('codex 等后代线程静默时枚举失败（不再等，按现状收尾）', { error });
            return;
          }
          if (!busy) return;
          if (Date.now() >= deadline) {
            logger.warn('codex 后代线程在预算内没有收场（按现状收尾：内容与用量可能只拿到一部分）', {
              waitMs: CODEX_DESCENDANT_QUIET_WAIT.waitMs,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, CODEX_DESCENDANT_QUIET_WAIT.pollMs));
        }
      },
      releaseQuiet: () => releaseQuiet(),
      onPayload: async (payload) => {
        /**
         * **在途轮号由流维护**：`turn/steer` 的 `expectedTurnId` 与 `turn/interrupt` 的 `turnId`
         * 都必须是**当前在途那一轮**（厂商按在途轮校验，真机读数：拿已收场的 id 发会被拒）。
         * 起轮有两条路，都落在这里：我们起的（`thread/queue/start` ⇒ 下面 `continueWith` 那一支
         * 直接赋值）与**厂商自己投递起的**（`vendorDispatched` ⇒ 只能在这里补）。
         */
        if (payload.kind === 'turnStarted' && payload.threadId === run.mainThreadId) {
          activeTurnId = payload.turnId;
          clearVendorTurnWait();
        }
        if (payload.kind === 'turnCompleted' && payload.threadId === run.mainThreadId) {
          /**
           * 本轮收场：先断掉在途那一档（这一刻起 steer 必被厂商拒），再看这一拍要不要续跑。
           *
           * 四条分支各有依据：
           *   · **没被闸门拦下**（不挂注入面 / 失败 / 取消 / 上限到）⇒ 什么都不投，直接让它收场
           *     ——起不动的那一批留在端口里，由编排层的等待窗口按预算如实收落 `gone`，不假装已交付；
           *   · **我们起轮成功**：把这一批人话交出去 ⇒ 更新在途轮号并让流继续消费。
           *     判据里那次「回的轮号必须**不是**刚收场那一轮」是必需的：线程忙时厂商回什么没有读数，
           *     保守地按「同一个 id ⇒ 没起成」处置，否则我们会去等一轮永远不会再收场的终态；
           *   · **厂商自己投递起了一轮**（`vendorDispatched`，真机形状：`thread/queue/add` 落在空闲
           *     线程上时厂商当场就把条目撒出去了）⇒ **绝不能收场**：收场即 `dispose` 杀进程，
           *     那一轮连同那句话一起没（真机复现过）。**暂存的结局照旧留着**（不 `continueWith`）：
           *     那一轮真收场时它会替换掉这一份，于是这一行的结论取最后一轮；
           *   · 否则收场。
           */
          const settledTurnId = activeTurnId;
          activeTurnId = null;
          if (!session.heldTurn()) return;
          const { continuedTurnId, vendorDispatched } = await injection.onTurnSettled();
          if (continuedTurnId !== null && continuedTurnId !== settledTurnId) {
            continuation.used += 1;
            activeTurnId = continuedTurnId;
            session.continueWith(continuedTurnId);
            return;
          }
          if (vendorDispatched === true && !input.signal.aborted) {
            continuation.used += 1;
            /**
             * **重新起表之前先撤掉上一只表**：厂商那一轮的 `turn/started` 可能在本拍**之前**就到了
             * （`queue/add` 落在空闲线程上时它在 add 那一拍就投，而我们正站在 `turn/completed` 的
             * 处理里）⇒ 上一只表的「等到了」永远不会再触发，它到点就会把这一行收场——那一轮连同
             * 还在厂商队列里的那些话一起没。每一拍都以自己那一刻起表。
             */
            clearVendorTurnWait();
            awaitingVendorTurn = true;
            vendorTurnTimer = setTimeout(() => {
              vendorTurnTimer = null;
              if (!awaitingVendorTurn) return;
              clearVendorTurnWait();
              logger.warn('厂商投递起的那一轮在预算内没有出现 turn/started，按正常收场', {
                waitMs: CODEX_VENDOR_TURN_WAIT.waitMs,
              });
              session.endPending();
            }, CODEX_VENDOR_TURN_WAIT.waitMs);
            return;
          }
          session.endPending();
          return;
        }
        injection.onNotification();
      },
      /**
       * 流**正常产完**之后的兜底：进程死在在途这一条路上，通知流里一条终态都没有
       * （`core.end` 只结算 `session.outcome`），而 `project` 只认流里的载荷 ⇒ 不补这一条，
       * 崩溃的行会按 `ok:true / exitReason:'completed'` 落盘（真机复现：两臂都 `ok:true`、
       * `finalText/tokens/turns` 全空、只在日志里留一条"子线程树不是全量"）。
       *
       * 三条排除：**已取消**（结论归 canceled 那条通路）、**不是 failed**（正常收场）、
       * **流内已经折过失败**（`turn/completed{failed}` 那条路，别落两条）。
       */
      onStreamEnd: async () => {
        if (input.signal.aborted) return null;
        const outcome = await session.outcome;
        if (outcome.status !== 'failed' || run.sawTerminalFailure) return null;
        return { kind: 'sessionFailed', error: outcome.error ?? 'codex app-server 在途失败（未给出原因）' };
      },
    }),
    interrupt: () => {
      /**
       * 中止就是给上游发 `turn/interrupt`（codex 的中途取消是协议能力，`cancelMidTurn: true`）。
       * **带的是当前在途轮号**：厂商按「当前在途轮」校验，建会话时那一个（首轮）在续跑之后早就收场了
       * ⇒ 拿它发必被拒（**自然收场**的轮回 `-32600 no active turn to interrupt`；**被我们中断过**的轮再发一次则**一帧都不回**，客户端要白等一个超时），中途取消会退化成杀进程树。
       */
      void session.interrupt(activeTurnId).catch((error: unknown) => {
        logger.warn('codex 中止请求失败（该行仍会按终止收场）', { error });
      });
    },
    // 收工顺序：先把在飞的投递等回来，再关客户端（关早了那次投递只会拿到「客户端已关闭」）
    dispose: createDisposer(async () => {
      clearVendorTurnWait();
      await injection.settle();
      await session.close();
    }),
    finalize: () => ({
      // 「这一轮是不是被终止」决定分量缺失那条 WARN 的措辞（见 `usageOfRun`）
      ...finalizeCodex(run, { canceled: input.signal.aborted }),
      // 通道事实（每-run）：这一次真的把 schema 发进了 `turn/start` 吗（不是「这家有没有这个字段」）
      applied: { structuredOutput: outputSchema !== null },
      /**
       * **会话身份**：codex 的续接键就是 `threadId` 本身（`thread/resume` 的必填入参只有它一格）。
       * 落盘之后，第二期的追问才有键可指；这里如实交回。
       */
      sessionId: run.mainThreadId,
    }),
    project: (raw, state) => projectNotification(run, input, raw, state),
  };
}

/**
 * 取一次 codex 的技能面（**永不抛**）。
 *
 * 失败与「形状不认识」都归成 `error` 文案，调用方落一条点名的 WARN 并把这一格记成 `null`
 * （= 采不到）——与 claude 侧同一条处置：观测失败不改本次运行的结论。
 */
async function probeCodexSkills(
  client: AppServerClient,
  layout: { configHome: string; cwd: string },
): Promise<{ entries: VendorSkill[] | null; error: string | null }> {
  try {
    const entries = await listSkills(client, layout.cwd);
    if (entries === null) return { entries: null, error: 'skills/list 的响应形状不认识' };
    return {
      entries: entries.map((entry) => ({
        name: entry.name,
        // 厂商原值照抄（真机实测 `user` / `system`），拿不到记 null（界面写「来源未证实」）
        source: entry.scope,
        path: entry.path,
        // `resolveRealPath` 由这一侧注入：契约是同构包，**不许自己引 `node:fs`**（界面也读它的标签表，
        // 顶层引 node 内建会让浏览器那侧打包直接失败，而 tsc / eslint / 单测都看不见这一层）
        origin: classifySkillOrigin({ source: entry.scope, path: entry.path, ...layout, resolveRealPath: realpathSync }),
      })),
      error: null,
    };
  } catch (error) {
    return { entries: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 归一化通知流 → 骨架要的原始流。
 * 为什么用生成器转发而不是直接 `as`：断言只发生在**每一个元素**上，流的语义（何时结束、
 * 何时 `return`）原样透传，`dispose` 里那条「停止消费」的路径不受影响。
 *
 * `readback` 是收尾取数的完成信号：**正常跑完时流要等它落定才结束**。三条判据——
 *   · `finalize` 是**同步**出口（`turn.ts` 在流结束后立刻调它），而收尾取数必然晚于 `session.settled`
 *     （那是它的闸门）⇒ 不在这里汇合，读数会稳定地慢一个微任务：枚举明明成功，分量却被记成
 *     `null` 并落一条「子线程树不是全量」的 WARN（名不副实，会把真失败也淹掉）；
 *   · 汇合点选在流的终止处而不是 `dispose` 之前：`dispose` 关客户端，收尾取数用的正是同一个客户端，
 *     故「读完了再关」；`startFinalizeReader` 自己不抛（枚举失败落 `readback.threads = null`，
 *     单条线程读失败只把该线程的 `content` 记 `null`；两条路都只记日志），
 *     这里的等待不会把一次正常运行翻成失败；
 *   · **被终止的那一轮不等**：取消时这一轮本就没有实测可取（`interrupt` 之后线程树还在长，
 *     正是「不采数」的场景），而客户端要到释放阶段才关、`settled` 才落定 ⇒ 等下去会把一次
 *     取消拖满释放宽限期（`releaseTurn` 的 5 秒），用户看到的是「点了停止还得等 5 秒」。
 *     判据用 `signal.aborted`——它与骨架的 `signalCanceled` 同源（`cancelMidTurn` 的终止）。
 *
 * 竞速必须包住**迭代本身**，不能只写在 `finally`：取消时上游那一轮本来就不会再产终态
 * （`session.ts` 的通知流停在 await 上），迭代不被打断就永远进不到 `finally`。这里用
 * `Promise.race` 自己驱动迭代器而不是 `for await`——`return()` 会提前触发 `settled`、
 * 让收尾取数在客户端已关的窗口里跑，反而把「不等」变成「等一个注定失败的取数」。
 */
async function* asRawStream(
  payloads: AsyncIterable<AppServerNotificationPayload>,
  readback: Promise<void>,
  signal: AbortSignal,
  hooks: {
    /**
     * 上游正常产完之后问一次「后代线程静下来了没有」，并把这一窗里到达的通知交出来投影。
     * 实现见 `waitForDescendantQuiet`；**没有后代线程时立刻回空**，不给普通行加任何延迟。
     */
    settleDescendants: () => AsyncGenerator<AppServerNotificationPayload>;
    /** 静默窗口结束（或根本不必等）时放行收尾取数；**幂等**，取消那一档也会走到 */
    releaseQuiet: () => void;
    /**
     * 每推进一格问一次（**要 await**）：在途那一档的取件挂在通知边界上，而本轮的终态那一格
     * 还要把剩下的交给耐久队列——那件事必须在流结束之前落定，否则 `dispose` 关掉客户端，
     * 投递再没有出口。
     */
    onPayload: (payload: AppServerNotificationPayload) => Promise<void>;
    /**
     * 上游**正常产完**之后问一次：这一行有没有一个「流内投影表达不出来」的失败要补一条载荷。
     * 返回 `null` = 没有（正常收场）；返回一条载荷 = 交给 `onPayload` 投影（本函数负责 yield）。
     *
     * 为什么这个口必须在流的终点：真机形状是「app-server 进程死在在途」——通知流被 `core.end`
     * 唤醒后正常产完，流里一条终态都没有，而失败事实只落在 `session.outcome` 上。
     */
    onStreamEnd: () => Promise<AppServerNotificationPayload | null>;
  },
): AsyncGenerator<unknown> {
  /** 只作「取消 ⇒ 不必再等」的信号，不承载取消本身（那是骨架与 `session.interrupt` 的职责） */
  let onCancel: (() => void) | null = null;
  const canceled = new Promise<null>((resolve) => {
    onCancel = () => resolve(null);
    if (signal.aborted) onCancel();
    else signal.addEventListener('abort', onCancel, { once: true });
  });
  const iterator = payloads[Symbol.asyncIterator]();
  /** 迭代推进：`null` 表示上游产完了 */
  let step = iterator.next();
  try {
    while (true) {
      // 取消与「下一条通知」赛跑：取消赢 ⇒ 立刻跳出，不等上游那一轮
      const outcome = await Promise.race([step, canceled]);
      // 取消赢 ⇒ 立刻跳出（结论归 canceled 那条通路，不必再问收尾）
      if (outcome === null) break;
      if (outcome.done === true) {
        // 上游产完了：问一次有没有「流内表达不出来」的失败要补（见 `onStreamEnd`）
        const terminal = await hooks.onStreamEnd();
        if (terminal !== null) {
          await hooks.onPayload(terminal);
          yield terminal as unknown;
        }
        /**
         * **后代线程可能还在跑**：主线程的 `turn/completed` 一到，本轮的结算闸门就放行了，
         * 而模型派出去的子智能体往往还没收场。这里用一个**有界**的静默窗口把这一窗里到达的通知
         * 继续投影掉（用量只从通知来），窗口结束才让流收尾 ⇒ 收尾取数读到的树才是静的。
         * 没有后代线程时这一支立刻结束，普通行一格延迟都不加。
         */
        for await (const extra of hooks.settleDescendants()) {
          await hooks.onPayload(extra);
          yield extra as unknown;
        }
        break;
      }
      await hooks.onPayload(outcome.value as AppServerNotificationPayload);
      yield outcome.value as unknown;
      step = iterator.next();
    }
  } finally {
    // 放行收尾取数（幂等）：取消 / 提前 return 那两条路也要放行，否则取数会等一个永不放行的闸门
    hooks.releaseQuiet();
    /**
     * 消费者提前 `return`（`dispose` 那条停止消费的路径）时也要汇合：`session.notifications` 的
     * 收尾会因此落定 `settled`、放行收尾取数，否则这里的等待会一直等一个还没被触发的任务。
     * 取消那条路不等取数——那次读数本就取不到，等下去只是把取消拖满释放宽限期。
     */
    await Promise.race([readback, canceled]);
    // 摘除监听器：一次运行一条流，别让 signal 上留着已作废的监听器（正常跑完时它也不会再触发）
    if (onCancel !== null) signal.removeEventListener('abort', onCancel);
  }
}

/**
 * 一条通知 → 三条出口（事件 / 消息 / 子任务行）。
 * 一条通知只在一处归一：行级在 `events.ts`、内容级在 `message.ts`，这里只做接线。
 */
function projectNotification(
  run: CodexRun,
  input: AgentRunInput,
  raw: unknown,
  state: Parameters<TurnStart['project']>[1],
): ReturnType<TurnStart['project']> {
  const payload = raw as AppServerNotificationPayload;
  if (payload.kind === 'threadStarted') {
    // 昵称是子任务行上的展示名：越早登记，行上的名字越早对得上（收尾时 reader 给更权威的一份）
    noteThreadStarted(payload.thread.id, payload.thread.agentNickname, run.runState);
  }
  const event = projectCodexEvent(payload, state, run.runState, {
    kind: 'codex',
    baseUrl: input.route.baseUrl,
    mainThreadId: run.mainThreadId,
  });
  if (event.tokens !== null) run.lastTokens = event.tokens;
  // 流内已经折过失败没有：收尾那条兜底失败（`sessionFailed`）靠它去重（同一件事不许落两条）
  if (event.projection.failure !== null) run.sawTerminalFailure = true;
  const messages = projectCodexMessages(payload, run.runState, { mainThreadId: run.mainThreadId });
  return {
    ...event.projection,
    ...(messages.drafts.length === 0 ? {} : { messages: messages.drafts }),
    ...(messages.subagents.length === 0 ? {} : { subagents: messages.subagents }),
  };
}

/**
 * 后台收尾取数：等本轮结算（那时线程树已经定型），再枚举全部后代并读回它们的内容。
 *
 * 三条判据：
 *   · **闸门是「本轮结算」**：`session.settled` 在通知流停下来之后落定（见 `session.ts`），
 *     它保证正在跑的 turn 已经有结论、子线程树不再增长；
 *   · **失败不抛**：**枚举失败**（或收尾整体失败）记 `readback.threads = null`（= 这一份不是全量），
 *     由 `finalize` 把分量整格记 `null` 并点名；⚠️ **单条线程的 `thread/read` 失败不算**——那条线程
 *     仍进数组、只把 `content` 记 `null`，分量照给（内容少一份不等于用量不是全量）。
 *     两条路都只记日志、都不把一次成功的运行翻成失败；
 *   · **`finalize` 不等待**：它只读这里已经填好的结果；还没落定时按「不是全量」处置（保守方向）。
 *     返回的 promise 是给**流**用的汇合点（见 `asRawStream`）：流等它落定，`finalize` 就必然读得到。
 */
function startFinalizeReader(run: CodexRun, session: CodexSession, quiet: Promise<void>): Promise<void> {
  return (async (): Promise<void> => {
    try {
      await session.settled;
      /**
       * **再等一次「后代线程静下来」**：`settled` 只说通知流停了，而子线程往往还在跑
       * （真机读数：`thread/read{child}` 那一刻 `status = {"type":"active"}`）。
       * 不等它，子线程的内容只会读回半截（1 条 `userMessage`）、子任务行记成 `running`。
       */
      await quiet;
      let refs: AppServerThreadRef[];
      try {
        refs = await listDescendantThreads(run.client, run.mainThreadId);
      } catch (error) {
        logger.error('codex 子线程枚举失败（本行的子智能体分量按「未采集」处理）', { error });
        run.readback = { threads: null };
        return;
      }
      const threads: Array<{ ref: AppServerThreadRef; content: AppServerThreadContent | null }> = [];
      for (const ref of refs) {
        try {
          threads.push({ ref, content: await readThreadContent(run.client, ref.threadId) });
        } catch (error) {
          logger.error('codex 子线程内容读取失败（该线程按「未采集」处理）', { error, threadId: ref.threadId });
          threads.push({ ref, content: null });
        }
      }
      run.readback = { threads };
    } catch (error) {
      logger.error('codex 收尾取数失败（本行的子智能体分量按「未采集」处理）', { error });
      run.readback = { threads: null };
    }
  })();
}

/**
 * 收尾：把 `reader` 补回的子线程折进消息、子任务行、用量与轮次。
 *
 * 五条口径：
 *   1. **线程树由协议给**（`thread/list{ancestorThreadId}` 一次拿到任意深度的后代），不再扫盘；
 *   2. **内容按需回退**（`readThreadContent` 的 `itemsView` 判据在 `reader.ts`），读不到的线程
 *      在结果里记 `null` 并**点名**（不静默）；
 *   3. **用量「全量或 null」**：任一子线程没报过用量 ⇒ 分量整格 `null`，而且**轮次分量同时为 `null`**
 *      ——两格是一对，只给其一都会让界面按「主会话 = 合计 − 分量」算出一个不存在的主会话；
 *   4. **轮次同一把尺**：分母 = 主线程答复条目数 + 各子线程答复条目数（同一个函数），
 *      分子 = 各子线程之和 ⇒ `subagentTurns ≤ turns` 是构造上的性质；
 *   5. **收尾不改结论**：读不到子线程只是少几行内容与一格分量，不影响本次运行的成功与失败。
 */
function finalizeCodex(run: CodexRun, options: { canceled: boolean }): {
  drafts: AgentEventDraft[];
  messages: MessageDraft[];
  subagents: SubagentRecord[];
  tokens?: UsageTokens;
  subagentTokens: UsageTokens | null;
  subagentTurns: number | null;
  turns?: number;
} {
  const drafts: AgentEventDraft[] = [];
  const messages: MessageDraft[] = [];
  const subagents: SubagentRecord[] = [];
  const context = { mainThreadId: run.mainThreadId };
  const readback = run.readback;
  /**
   * 逐条线程补内容与行。`content === null`（那一条读失败）时仍出子任务行：行的**身份与终态**
   * 来自 `thread/list` 的元数据（那一份拿到了），缺的只是它自己的条目。
   */
  const threads = readback?.threads ?? null;
  for (const entry of threads ?? []) {
    if (entry.content !== null) {
      messages.push(...projectThreadMessages(entry.ref.threadId, entry.content.items, run.runState, context));
    }
    subagents.push(projectSubagentRecord(entry.ref, entry.content?.thread ?? null, run.runState, context));
  }

  /**
   * 轮次：主线程那一份来自 `runState`（与运行期**同一个函数**数的），子线程那一份来自收尾读回的条目。
   * 两者同源 ⇒ 分子分母同尺。`mainTurns === null`（一次答复条目都没数到）时合计也是 `null`
   * ——**不编一个 0**。
   */
  const mainTurns = observedTurns(run.runState, run.mainThreadId);
  /**
   * 被**显式丢弃**的增量通道：`item/plan/delta` 与 `item/commandExecution/outputDelta`
   * 没有渲染落点，但「丢」必须留痕——否则排障时分不清「我们主动丢了」与「上游没发」。
   * 一条 DEBUG 汇总，不落任何事件（落事件就把原始输出面板刷满了，那正是这条口径要防的事）。
   */
  if (run.runState.droppedDeltas.size > 0) {
    logger.debug('codex 显式丢弃的增量通道统计', {
      dropped: Object.fromEntries(run.runState.droppedDeltas),
    });
  }
  const subagentTurns = threads === null ? null : threads.reduce((sum, one) => sum + threadRoundTrips(one.content, one.ref.threadId, run.runState), 0);
  const finalTurns = mainTurns === null || subagentTurns === null ? null : mainTurns + subagentTurns;

  const usage = usageOfRun(run, threads, options);
  if (usage.warn !== null) drafts.push(logDraft('stderr', usage.warn));

  /**
   * 收尾那条 `usage`：**合计与分量成对**交出（只给一个会让界面算出负数）。
   * `finalTurns === null` 时两格都不发——轮次那一格没有诚实的值（计量绝不填 0），而一个孤儿分量
   * 会让界面按「主会话 = 合计 − 分量」推出一个不存在的主会话。
   */
  if (usage.total !== null && finalTurns !== null) {
    drafts.push({
      type: 'usage',
      tokens: usage.total,
      subagentTokens: usage.subagent,
      subagentTurns,
      timing: null,
      /**
       * 归属：**主线程**的轮次——这条读数就是主线程那一份。拿合计顶替会把这条读数挂到别的会话同号的
       * 轮次上；一次答复条目都没数到时保持 `null`（那一刻没有诚实的号可填，按时刻归位），
       * 而那种情形下 `finalTurns` 也是 `null`、这条根本发不出去。
       */
      turn: mainTurns === null ? null : { subagentId: null, round: mainTurns },
      /**
       * 来源：这一条是**结算值**（`usageOfRun` 从会话文件读回的累计），与跑动期那些
       * `thread/tokenUsage/updated` 同源、同口径 ⇒ `'reported'`。填错成 `'estimated'` 的代价是
       * 编排层不回写这一条的 tokens——它恰好是收尾那一刻唯一的权威值。
       */
      tokensBasis: 'reported',
      turns: finalTurns,
    });
  }

  /**
   * **技能面那一条事件**（`vendor-system.skills`）：起会话时采到的 `skills/list` 清单。
   *
   * 为什么在收尾才发、而且带**整份**事实：`vendor-system` 的消费方（行级 MCP 证据、环境抽屉的
   * 厂商那一组）都是**取最后一条**读的，故这一条必须把 MCP 那一格一起带上（用
   * `currentMcpStartup` 的累积全量），否则最后那条事件里的 MCP 事实是空的，把先前那几拍
   * （`starting → ready`）在界面上抹掉。
   *
   * 采不到时**这一条不发**、只落一条点名的 WARN（见下面那一段）：`skills: null` 的读数是
   * 「厂商回了、确实一条都没有」，而我们那时一个字都没读到。
   */
  const skillProbe = run.runState.skillProbe;
  if (skillProbe?.entries !== undefined && skillProbe.entries !== null) {
    /**
     * `mcpServers` **只在厂商真的报过启动状态时给**：一条都没有的时候给 `[]` 说的是
     * 「厂商投送了、确实一台都没有」，而事实是「这一家压根没投这一格」——两句话不许混
     * （`vendor-system` 的三态纪律）。
     */
    const startup = currentMcpStartup(run.runState);
    drafts.push(
      vendorSystemDraft({
        tools: null,
        slashCommands: null,
        agents: null,
        mcpServers:
          startup.length === 0
            ? null
            : startup.map((one) => ({ name: one.name, status: one.status, source: null, error: one.error })),
        mcpChannel: 'vendor-startup-status',
        permissionMode: null,
        outputStyle: null,
        skills: skillProbe.entries,
      }),
    );
  }
  /**
   * 采不到时**不发 vendor-system 事件**、只落这一条 WARN：一条 `skills: null` 的事件在界面上的
   * 读数是「厂商没投送这一格」——那是替厂商说一句我们并不知道的话；而「我们没采到」有这条日志
   * 自己承载（行级判据据此降级成 `unverified`，不会误判成 `missing`）。
   */
  if (skillProbe !== null && skillProbe.error !== null) {
    drafts.push(
      logDraft('stderr', `[WARN] 采不到 codex 的技能清单（${skillProbe.error}）：本行「技能」判据降级为未验证，不据此判失败`),
    );
  }

  return {
    drafts,
    messages,
    subagents,
    ...(usage.total === null ? {} : { tokens: usage.total }),
    /**
     * 两格都进结果：编排层终态那一步用 `result.*` 覆盖快照，只在事件里给数会被随后那次写入清掉。
     *
     * `subagentTurns` 跟着 `subagentTokens` 一起记 `null`：有子线程、但它没报用量时，
     * `usageOfRun` 已经把分量整格判成「未采集」，此时那一份**份数**同样随本次缺失一起作废
     * ——只把计量记 `null`、份数照旧交累计值，界面会按「主会话 = 合计 − 分量」拿一个只剩份数的
     * 孤儿分量去配一个不存在的计量（两格是一对，见 `usageOfRun` 的口径）。
     */
    subagentTokens: usage.subagent,
    subagentTurns: usage.subagent === null ? null : subagentTurns,
    ...(finalTurns === null ? {} : { turns: finalTurns }),
  };
}

/**
 * 用量合成（**全量或 null**）。
 *
 * 逐格判据：
 *   · 主线程那一份缺失 ⇒ 拿不出合计（绝不拿子那一份冒充总数，界面按「主会话 = 合计 − 分量」会算出负数）；
 *   · 任一子线程没报过用量 ⇒ 分量整格 `null`（**不是 `{0,0,0}`**：那是「确实没有子智能体」）；
 *   · 没有子线程 ⇒ 分量是 `{0,0,0}`，合计就是主线程那一份（`addUsage` 对逐格为零的子那份返回原值）。
 * 返回的 `warn` 是那条**点名 WARN**（没有缺失时为 `null`）。
 */
function usageOfRun(
  run: CodexRun,
  threads: CodexReadback['threads'],
  options: { canceled: boolean },
): { total: UsageTokens | null; subagent: UsageTokens | null; warn: string | null } {
  const mainTokens = tokensOfThread(run, run.mainThreadId) ?? run.lastTokens;
  if (threads === null) {
    /**
     * 「不是全量」有三**因**，处置相同、文案必须分开——后两条都不该说成「枚举失败」，
     * 那会把「我们主动不采 / 客户端已关」读成「厂商枚举坏了」，方向正好相反：
     *   · 这一轮被**终止**：取消那一轮按口径不等取数（`asRawStream` 的取消分支），而取数若赶在
     *     释放之后跑，`thread/list` 只会拿到「客户端已关闭」——归因要落在「终止」上；
     *   · 取数**没落定**（`readback === null`，同样是终止那一档的形态）；
     *   · 落定了、也不是终止 ⇒ 才是**枚举失败**（`startFinalizeReader` 的 catch 已点过名）。
     */
    const why = options.canceled
      ? '[WARN] codex 收尾取数在终止之后没有拿到全量（这一轮被终止）'
      : run.readback === null
        ? '[WARN] codex 收尾取数没有落定（这一轮被终止）'
        : '[WARN] codex 子线程树不是全量（枚举失败）';
    return {
      total: null,
      subagent: null,
      warn: `${why}：这一行的**子智能体分量与轮次分量**都给不出（记 null，不编造、不填 0），合计退回主线程口径`,
    };
  }
  if (threads.length === 0) {
    // 确实没有子智能体：分量是 `{0,0,0}`（与「没采到」是两件事）
    return {
      total: mainTokens,
      subagent: sumUsageTokens([]),
      /**
       * 主线程那一份也可能缺（一条用量通知都没来过）。这一档**合计给不出**，而「没有子智能体」
       * 这件事是真的 ⇒ 分量照旧 `{0,0,0}`，只把缺失点名出来：不点名的话界面上只是「计量空着」，
       * 排障时分不清「这一家不报用量」与「这一次没采到」。
       */
      warn:
        mainTokens === null
          ? '[WARN] codex 主线程的用量本行没有采到（协议只按线程报累计用量；通知若在流收尾之后才到，就没有人再把它投影进读数）：这一行的**合计计量**给不出（记 null，不编造、不填 0）'
          : null,
    };
  }
  /**
   * 分量「**全量或 null**」的判据：每一条子线程都要能给出一份**读得出来的**用量。
   *
   * 判据与求和走**同一个函数**（`tokensOfThread`），而不是拿 `usageByThread.has()` 当判据、
   * 再用 `breakdownToTokens` 求和。两者今天**等价**——归一化层的 `readTokenUsage` 要求六项齐全，
   * 残缺载荷整条落 `other`、压根进不了 `usageByThread` ⇒ 「有这一条」与「读得出来」同真同假。
   * 同源因此是**结构性防御**而非修一个现存的洞：它让这一处不依赖上游那一层的严格度，
   * 归一化哪天放宽成「三项齐就认」，这里也不会出现「既不进缺失名单、又不进和里」的线程
   * （那种漏法的症状是分量静默少算一个线程，却照旧交出一个名义上是全量的非 null 数）。
   */
  const resolved = threads.map((one) => ({ threadId: one.ref.threadId, tokens: tokensOfThread(run, one.ref.threadId) }));
  const missing = resolved.filter((one) => one.tokens === null).map((one) => one.threadId);
  if (missing.length > 0) {
    /**
     * 文案只说**我们这一侧**的事实（「本行没采到」），**不替厂商下结论**。
     *
     * 为什么不能写「没有用量通知」：用量只从运行期的 `thread/tokenUsage/updated` 通知累计，而通知
     * 是在**流那一侧**投影进 `runState` 的——流在本轮结算那一刻就停（`iterate()` 排空队列后
     * `return`），此后到达的通知仍会进队列却**没人再投影**。真机读数（子线程用量通知 @158、
     * 收尾取数 @161）：通知明明到了，落盘的却是「没有用量通知」⇒ 排查的人会朝厂商的方向找，
     * 而真因在本仓的收尾时序上。二者在读数上分不开，就不该在文案里选一个说。
     */
    return {
      total: null,
      subagent: null,
      warn: `[WARN] codex 子线程 ${missing.join('、')} 的用量本行没有采到（协议只按线程报累计用量；通知若在流收尾之后才到，就没有人再把它投影进读数）：这一行的**子智能体分量与轮次分量**都给不出（记 null，不编造、不填 0），合计退回主线程口径`,
    };
  }
  const subagent = sumUsageTokens(resolved.flatMap((one) => (one.tokens === null ? [] : [one.tokens])));
  return { total: addUsage(mainTokens, subagent), subagent, warn: null };
}

/** 某线程运行期采到的累计用量（读不到就是 `null`：三项缺一即整格 `null`，**不填 0**） */
function tokensOfThread(run: CodexRun, threadId: string): UsageTokens | null {
  const usage = run.runState.usageByThread.get(threadId);
  return usage === undefined ? null : breakdownToTokens(usage.total);
}

export const codexProvider: AgentProvider & { runtimeHooks: CodexRuntimeHooks } = {
  kind: 'codex',
  displayName: 'Codex',
  /**
   * 取数面的注入点（见 `CodexRuntimeHooks`）：缺省 = 生产行为（真 spawn `codex app-server`）。
   * 测试换掉它，「接线」与「协议交互」两件事各自可测、互不牵连。
   */
  runtimeHooks: defaultCodexRuntimeHooks,
  metadata: {
    // 只讲一条 wire（codex CLI 走 Responses）⇒ 集合只有一个元素
    protocolTypes: ['openai'],
    /**
     * `cancelMidTurn: true`——app-server 有 `turn/interrupt`（协议能力，不是本适配器模拟的）。
     */
    capability: { cancelMidTurn: true, usage: true },
    /**
     * 消息能力声明：五格与 `providers/dsh` 逐格同形同口径（`'yes'` 必须配 `source`、
     * 非 `'yes'` 必须配 `reason`——契约的 `superRefine` 会在解析层拦下自相矛盾的组合）。
     */
    messageCapability: {
      thinkingText: 'yes',
      thinkingTextKind: 'summary',
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
      notes: [
        '思考正文的两格是**分开**的：全文取 `reasoning.content[]`、摘要取 `reasoning.summary[]`；`content[]` 为空时**不回落 summary 冒充全文**（那一格给 `text:null` + `textKind:none`）。⚠️ 真机常见形状是**「`content[]` 全空 + `summary[]` 有」**（真网关 × 多模型上 7 次推理条目全是这一形状，到的是 `item/reasoning/summaryTextDelta`、`textDelta` 一次未到）⇒ 那种情况下产出的是 `textKind:summary` 的块、**没有 `none` 块**，所以「`none`」描述的是 `summary[]` 也空的那一档，不是「上游只回密文」的同义语',
        '`thinkingTextKind` 报 `summary`：这一格描述的是**实测拿得到哪一档**，不是协议层「能不能」。协议上全文那条路确实存在（脚本式上游投 `reasoning_text` 时厂商会把全文落在 `content[]`），但真网关 2 路由 × 103 个路由-模型 × 153 格往返里 `content[]` **非空 0 格**、`summary[]` 非空 40 格 ⇒ 本仓实际只能拿到摘要',
        '文件改动与 MCP 调用按 `apply_patch` / `<server>.<tool>` 出工具消息；MCP 不进那十族（`family:null`），界面走通用渲染',
        '命令输出是 stdout 与 stderr 的合流（`aggregatedOutput`）⇒ 归一结果里不编 `stderr`',
        '消息级用量（`AgentMessage.usage`）结构性给不出：app-server 只到线程级累计，差分无法证明归属 ⇒ 恒 `null`',
        '审批与问用户都是 server→client 请求：**审批类只归类不回帧**（`approvalPolicy: never` 下也不会被问到），问答类由应答者回帧、但厂商不为此发条目通知 ⇒ 两者都不合成消息',
        '子任务终态由 `turn.status` / `turn.error` / `thread.status` 推出三档（completed / failed / stopped）；推不出来记 `unknown` + `statusMissing`',
        '子线程的实时性取决于上游是否把它的 `item/*` 推给本条连接：收尾一律用 `thread/read` 补齐，两条入口共用同一个归一函数',
      ],
    },
    /**
     * 注入面能力：MCP 随 `thread/start` 的**线程级配置**下发，skill 副本落在 `<CODEX_HOME>/skills/`
     * 并由 app-server 的 `skills/list` 报回来——两条通路都通。
     */
    injection: {
      mcp: { state: 'yes', reason: null },
      skills: { state: 'yes', reason: null },
      notes: [
        'MCP 的判据通道是 `mcpServer/startupStatus/updated`（带厂商 `error` 原文），档位**只到「装上了」**：自建网关路由下工具调用可能被上游判 `unsupported call`',
        'skill 的判据通道是 `skills/list`（带 `scope` 与落点 `path`）——它证明厂商认出了清单，且 `enabled: false` 的条目也会列出来',
      ],
    },
    /**
     * 交互面：厂商在服务端协议里就有提问请求，本适配器**开开关 + 回帧**两件都做了。
     *
     * 三条口径：
     *   · 开关**不是**「模型看不看得见那件工具」：0.156.1 默认就把 `request_user_input` 列进工具表
     *     （`tools.experimental_request_user_input` 不开也在，系统提示逐字不变），开关管的是**运行期
     *     收不收这次调用**——不开时厂商把调用弹回 `request_user_input is unavailable in Default mode`，
     *     一条服务端请求都不下发。两格随应答面同生同灭（`CodexConfigOptions.askUser`）。
     *   · **没有一档收场由厂商自己结束**：`autoResolutionMs` 已 `@deprecated` 且实测恒 `null`，
     *     `isBlocking: false` 也不让它收场——不回帧它会一直等（实测 45 s 无下一轮、无收束通知）
     *     ⇒ 「没人答 / 等超时 / 行终止」三条都由我们回一帧**空答案**（厂商原生的「没有答案」语义），
     *     那一问的收场方式因此落在我们自己的预算上（`timeout`），**没有** `auto-resolved` 这条路径。
     *   · 分界线：**审批类仍然只归类不回帧**（`approvalPolicy: never` 下也不会被问到；回帧等于替用户
     *     批准）；子线程发起的提问厂商自己就拒（`… can only be used by the root thread`），
     *     真到了我们手里也按「子智能体不能向用户提问」收场。
     */
    interaction: {
      askUser: 'yes',
      askUserChannel: 'vendor-tool',
      askUserReason: null,
      /**
       * 驱动器是真的：真 `codex app-server` 跑起来、厂商自己在运行期下发
       * `item/tool/requestUserInput`、我们的应答帧被厂商折成**真的工具结果**交给下一轮请求。
       */
      askUserProofDriver: 'real-path',
      askUserProofDriverReason: null,
      notes: [
        '厂商的提问请求是 `item/tool/requestUserInput`，答案按**题目 id** 配对回帧（`{answers: {<question.id>: {answers: string[]}}}`）',
        '一致性场景走真路径（真服务端 + 脚本式上游，开关与回帧都是产品那条链路，见 `testing/codex-real-path-fixture.ts`）',
      ],
    },
    /**
     * **注入面能力（第五组）**：人往运行中的一轮送话、以及接着一条已有会话再跑一段，这一家各能做什么。
     *
     * 取值来源逐格可查：两档的**方法名与前置条件**来自本机 0.156.1 的 wire 表与生成物
     * （`turn/steer` 的 `expectedTurnId` 是必填的「当前在途轮」前置；`thread/queue/{add,update,list,delete,reorder,start}`
     * 六个都在 wire 上，且都要 `experimentalApi`——逐方法标注见上游 `common.rs`，本机两档读数见
     * `probe` 那一批臂）。`'idle'` 档走的是**真路径**（`testing` 那套装配 + `probes/inject-idle-live.test.ts`），
     * `'round'` 档仍只有 wire 形状与假件 ⇒ 两档的证据强度不同，声明也照实分开。
     */
    turnInjection: {
      delivery: {
        round: {
          state: 'unverified',
          reason: 'unverified',
          channel: 'wire',
          // 真版本门：`expectedTurnId` 自 0.156.1 起必填（本机那一版的生成物里它在 `required` 里）
          gate: { version: '0.156.1' },
          experimental: false,
          // 真机读数只证到 wire 上**存在**这些方法：我们这条投递路径没被观测过
          proofDriver: 'synthetic-fixture',
          proofDriverReason: '真机读数只证到 wire 上存在 `turn/steer`；我们这条投递路径'
            + '（steer 落在哪一次模型往返之前）没被验过 ⇒ 今天的证据来自假 wire 夹具',
        },
        idle: {
          /**
           * **`yes`（真路径）**：真 `codex app-server` 下，人话在收场那一刻交出去之后**真的进到了模型面前**，
           * 而且那一轮的答复成了本行的结论——三件事都在产品路径上发生，只把上游模型换成脚本式：
           *   · 交付**登记**了（`markDelivered` 收到那个 id）；
           *   · 那句话出现在**厂商出站请求体**里（判据是 `/v1/responses` 的原文，不经过我们任何投影）；
           *   · 厂商起的那一轮**跑完**（`turn/started` 与 `turn/completed` 同数，没被 `dispose` 杀掉），
           *     且它的答复就是本行 `finalText`。
           * 起轮的形状与上游语义一致：条目录在**空闲**线程上时厂商在 `thread/queue/add` 那一刻自己就投，
           * 我们的 `thread/queue/start` 因此常拿到 `queue is empty`——按「条目已被消费」判交付（见 `deliverIdle`）。
           */
          state: 'yes',
          reason: null,
          channel: 'wire',
          gate: null,
          // `thread/queue/*` 逐方法带 `#[experimental(...)]`：不开实验能力，这几个方法一律被拒
          experimental: true,
          proofDriver: 'real-path',
          proofDriverReason: null,
        },
      },
      retract: {
        round: {
          state: 'none',
          reason: '在途注入没有按身份收回的面：`turn/steer` 交出去之后没有对应的撤回方法，'
            + '`turn/interrupt` 是无身份的全清（它终结整轮，不是撤回这一条）',
        },
        idle: {
          state: 'by-id',
          reason: '按厂商的 `queuedSubmissionId` 撤（`thread/queue/delete`）；它只回 `{deleted}`，'
            + '「已消费 / 已删过 / id 不对」三种失败**逐字相同**。删不到时读一次 `thread/queue/list` 分两桶：'
            + 'id **还在**表里 ⇒ 身份对不上（`unknown`）；id **不在**表里 ⇒ 只证「它已经不在队列里了」，'
            + '两件事都能造成这个结果，故取「已消费」是**基于本行自己销账的推断**（本行是唯一的删除方，'
            + '撤回路径上我们没有删过它），不是厂商告诉我们的',
        },
      },
      /**
       * **续接**：`thread/resume{threadId}`——必填入参只有 `threadId` 一格（与 cwd 无关，
       * cwd 只是可选覆盖），转录落在该行自己的 `$CODEX_HOME` 下。
       * 真路径驱动器在 `testing/codex-resume-fixture.ts`（真二进制 → 真 app-server + 脚本式上游）。
       */
      resume: {
        state: 'yes',
        reason: null,
        channel: 'wire',
        gate: null,
        experimental: false,
        proofDriver: 'real-path',
        proofDriverReason: null,
      },
      notes: [
        '`\'idle\'` 档走真路径（真二进制 + 脚本式上游，见 `probes/inject-idle-live.test.ts`）⇒ 记 `yes`；'
        + '`\'round\'` 档的**投递点**仍未验（steer 落在哪一次模型往返之前）⇒ 仍记 `unverified`',
        '**接不回的是「上一个进程」那一轮**：它早已收场，拿它的 turn id 去 steer 会被厂商拒（`-32600 no active turn to steer`）⇒ `\'round\'` 的有效范围是本进程内 `turn/start` 已起、未收场的那一轮。续接**不**落在这条约束外：`thread/resume` 之后照旧发一次 `turn/start` ⇒ 续接轮同样有在途轮、两档都可用',
        '`thread/queue/*` 的方法在 wire 上一直都在，但它们各自带 `#[experimental]` 闸门 ⇒ 要靠握手的 `experimentalApi: true`（本仓已开，见 `appserver/client.ts` 的 `initialize`）；`--experimental` 改的只是 schema 产物',
        '`\'idle\'` 档的交付判据是「**这一轮真的跑起来了**」：先 `thread/queue/add{clientUserMessageId}` 登记（保住按身份撤），再 `thread/queue/start`；'
        + '起轮成不成看**条目还在不在可见队列里**——厂商在空闲线程上会在 `add` 那一刻自己把它撒成一轮（上游 README 的 "dispatches … once the thread is idle"），'
        + '此时 `queue/start` 回 `queue is empty`，那**不是失败**：按交付登记并让流继续消费厂商起的那一轮（`vendorDispatched`）；条目还留在队列里才是真没投成（回滚 + 不登记）',
        '`\'idle\'` 档起的那一轮**带不了档位**（`thread/queue/start` 的参数只有 `threadId` 与可空的 `queuedSubmissionId`）⇒ 档位同时写进线程级 `config.model_reasoning_effort`，续跑那一轮由它兜住（同一个值写两处：一处管本轮、一处管线程默认）',
        '`\'idle\'` 档续跑**有上限**（`CODEX_IDLE_CONTINUATION.rounds`）：没有它，人一直发就能一直续跑、这一行永远不收场，而编排层的等待预算只在适配器返回之后才开窗口，兜不住这里',
        '跨轮的运行靠 `turnStarted` 重置墙钟（`TurnProjection.roundTripStarted`）：否则上一轮耗掉的预算会算进新起的那一轮里',
        '`thread/resume` 不发 `thread/started` 通知帧 ⇒ 线程 id 只从响应的 `thread.id` 取，续接后的终态判据也挂在那个 id 上',
        '**不用「cwd + 最近一条」找会话**：本行的 MCP / 路由只写在**线程级 config** 里、从不落 `$CODEX_HOME/config.toml`，`thread/list{cwd}` 因此列不到这一行的线程（真机读数）⇒ 会话身份只能由我们自己落盘',
      ],
    },
    /**
     * 耗时量级：一次运行在**分钟级**——但**分钟来自模型与工具的实际工作，不来自进程启动**。
     * 真机冒烟的默认等待预算按这一档派生——声明小了，那一轮会被自己的预算掐掉。
     *
     * ⚠️ **「分钟级」的原因不是启动开销**（那是最容易顺手写下的错归因）：
     * 本机五轮实测（中位数）：`codex --version` 起进程 **7 ms**；`codex app-server`
     * **冷启 57 ms**（51–61）/ **热启 21 ms**（20–25）；`thread/start` 10 ms；
     * `turn/start` 到首轮 **54 ms** ⇒ 一次**脚本式**往返的整条链路约 **64 ms**。
     * 也就是说：进程与握手是**毫秒级**的固定开销（三个数量级以下的误差都盖得住），
     * 一分钟以上的墙钟一律来自模型推理与工具执行 ⇒ 排障时按「模型/工具慢」查，
     * 别去查 app-server 启动。
     */
    /**
     * **回到某一轮**：走 `thread/fork`（协议方法名，见 `codex app-server` 的 `strings`）。分叉点实现落在
     * `appserver/session.ts` 的 `startOrResumeThread`。
     *
     * 工作区回退**没有**语义定位（`thread/revert` 是否连带改动未定位）⇒ `filesRewind: false`，
     * 文案只说「不动文件」，不许承诺撤销。
     */
    checkpoint: {
      supported: true,
      mode: 'fork',
      filesRewind: false,
      reason: null,
      notes: [
        '分叉走 `thread/fork`；`thread/revert` 的回退范围（轮 / 条目 / 是否动工作区）未定位，本仓不声明文件回退',
      ],
    },
    timing: {
      runScale: 'minutes',
      notes: [
        '本机实测：一次运行（真模型、真工具）的墙钟在分钟级，而进程与握手是毫秒级——'
        + '`app-server` 冷启中位 57 ms / 热启 21 ms、`thread/start` 10 ms、`turn/start` 到首轮 54 ms',
      ],
    },
    /**
     * 推理证据必须补 messages.jsonl：思考全文与工具结果正文**结构性不进** events.jsonl
     * （事件流只有摘要与结构件），唯一落点是消息账本 ⇒ 编排层据此给 codex 候选行多拼一份
     * messages.jsonl 证据，而不是把厂商名硬编码进编排层。
     */
    needsMessagesForReasoningEvidence: true,
    /**
     * 档位域 = app-server 的 `ReasoningEffort` **加上**本仓统一的关闭档 `off`（它翻成 CLI 的 `none`）。
     *
     * ⚠️ **真机读数：九个值里有两个被厂商自己改写，界面上那两格因此名不副实**（每档一条新线程、
     * 只发 `turn/start{effort}`，读的是**出站请求体**里的 `reasoning.effort`，各 3 次）：
     *   · `'ultra'` ⇒ 被**降到该模型支持的最高档**，而降到哪一档**随模型变**：
     *     已知模型 `gpt-6.1-sol` 上降到 **`xhigh`**、未知模型（脚本式上游那个名字）上降到 **`medium`**；
     *   · `'persistent'` ⇒ **两个模型上都变成 `disabled`**（名字最「持久」，实际把推理**关掉**）。
     * 对照臂说明这不是「什么都不校验」：`'bogus'` 与 `'HIGH'` **原样透传**，空串与数字被拒
     * （`-32600 Invalid request: reasoning_effort must not be empty` / `invalid type: integer \`42\``）。
     * ⚠️ 同一次读数里 `reasoning` 那一格的**形状也随模型变**：已知模型带 `context: "all_turns"`，
     * 未知模型只有 `summary: "auto"` ⇒「codex 怎么翻译档位」依赖它认不认这个模型，
     * 单模型读数**不足以**给这一格下结论：`ultra` 写成「固定映射到 `medium`」就是只测了一个模型
     * 得出的错结论。
     * ⇒ 这两格的取舍**已定：保留这两个值，由本条注释承担说明**（去掉会丢掉「厂商将来真支持时」的入口）。
     * 于是界面仍会提供这两格，读了本条就别再把「选了 persistent」当成「推理拉满」。
     */
    reasoningEfforts: [EFFORT_OFF, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'codex',
      start: (context) => startCodex(context, codexProvider.runtimeHooks),
    }),
};
