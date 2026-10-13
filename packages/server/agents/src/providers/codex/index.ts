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
import { askUserCallDraft, noteThreadStarted, projectCodexMessages, projectSubagentRecord, projectThreadMessages, threadRoundTrips } from './message';
import { createCodexRunState, currentMcpStartup, observedTurns, type CodexRunState } from './run-state';

const logger = createLogger('agents/codex');

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
  const { contextWindow, reasoningSummary, mcpServers, askUser } = options;
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
    tools: {
      web_search: false,
      update_plan: { enabled: true },
      ...(askUser === true ? CODEX_ASK_SWITCH_TOOLS : {}),
    },
    features: {
      multi_agent: true,
      ...(askUser === true ? CODEX_ASK_SWITCH_FEATURES : {}),
    },
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
    ...(reasoningSummary === undefined ? {} : { model_reasoning_summary: reasoningSummary }),
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
  /** 本行已交出的权威读数（主线程没有用量通知时的兜底，也是收尾判「要不要再发一条」的依据） */
  lastTokens: UsageTokens | null;
  /** 收尾取数的结果（由 `startFinalizeReader` 在后台填；`null` = 还没落定） */
  readback: CodexReadback | null;
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
      mcpServers,
      /**
       * 提问工具的两格开关**只在挂了应答面时**打开（见 `CodexConfigOptions.askUser`）。
       * 反之，开了开关却没人答时厂商会一直等那一帧——所以「不问就不动」在这里同时是**安全边界**。
       */
      askUser: context.askUser.available,
    }),
    prompt: input.prompt,
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
  };
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
  // 收尾取数：以「本轮结算」为闸门在后台跑，`finalize` 只读已经落定的结果（见文件头第 4 条）
  const readback = startFinalizeReader(run, session);

  return {
    /**
     * 通知流：`session.notifications` 交出的**已经是**归一化载荷（`session.ts` 的职责），而骨架的
     * `project` 收的是原始消息 ⇒ 这里过一层显式断言。宽进严出：`project` 的入参是 `unknown`。
     *
     * `readback` 是汇合点：收尾取数必须在流**结束之前**落定，`finalize` 才能读到它（见 `asRawStream`）。
     */
    stream: asRawStream(session.notifications, readback, input.signal),
    interrupt: () => {
      // 中止就是给上游发 `turn/interrupt`：codex 的中途取消是协议能力（`cancelMidTurn: true`）
      void session.interrupt().catch((error: unknown) => {
        logger.warn('codex 中止请求失败（该行仍会按终止收场）', { error });
      });
    },
    dispose: createDisposer(() => session.close()),
    finalize: () => ({
      ...finalizeCodex(run),
      // 通道事实（每-run）：这一次真的把 schema 发进了 `turn/start` 吗（不是「这家有没有这个字段」）
      applied: { structuredOutput: outputSchema !== null },
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
      if (outcome === null) break;
      if (outcome.done === true) break;
      yield outcome.value as unknown;
      step = iterator.next();
    }
  } finally {
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
function startFinalizeReader(run: CodexRun, session: CodexSession): Promise<void> {
  return (async (): Promise<void> => {
    try {
      await session.settled;
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
function finalizeCodex(run: CodexRun): {
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

  const usage = usageOfRun(run, threads);
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
): { total: UsageTokens | null; subagent: UsageTokens | null; warn: string | null } {
  const mainTokens = tokensOfThread(run, run.mainThreadId) ?? run.lastTokens;
  if (threads === null) {
    return {
      total: null,
      subagent: null,
      warn: '[WARN] codex 子线程树不是全量（枚举失败）：这一行的**子智能体分量与轮次分量**都给不出（记 null，不编造、不填 0），合计退回主线程口径',
    };
  }
  if (threads.length === 0) {
    // 确实没有子智能体：分量是 `{0,0,0}`（与「没采到」是两件事）
    return { total: mainTokens, subagent: sumUsageTokens([]), warn: null };
  }
  const missing = threads.filter((one) => !run.runState.usageByThread.has(one.ref.threadId)).map((one) => one.ref.threadId);
  if (missing.length > 0) {
    return {
      total: null,
      subagent: null,
      warn: `[WARN] codex 子线程 ${missing.join('、')} 没有用量通知（协议只按线程报累计用量）：这一行的**子智能体分量与轮次分量**都给不出（记 null，不编造、不填 0），合计退回主线程口径`,
    };
  }
  const subagent = sumUsageTokens(
    threads.flatMap((one) => {
      const tokens = tokensOfThread(run, one.ref.threadId);
      return tokens === null ? [] : [tokens];
    }),
  );
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
      notes: [
        '思考全文取 `reasoning.content[]`；上游只回密文时该格为空 ⇒ `text:null` + `textKind:none`（不回落 summary 冒充全文），摘要另有一块走 `reasoning.summary[]`',
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
     * 耗时量级：一次运行在**分钟级**（含 `codex app-server` 的启动到收尾）。
     * 真机冒烟的默认等待预算按这一档派生——声明小了，那一轮会被自己的预算掐掉。
     */
    timing: {
      runScale: 'minutes',
      notes: ['本机实测：一次运行的墙钟在分钟级；app-server 启动是其中的固定开销'],
    },
    /**
     * 推理证据必须补 messages.jsonl：思考全文与工具结果正文**结构性不进** events.jsonl
     * （事件流只有摘要与结构件），唯一落点是消息账本 ⇒ 编排层据此给 codex 候选行多拼一份
     * messages.jsonl 证据，而不是把厂商名硬编码进编排层。
     */
    needsMessagesForReasoningEvidence: true,
    // 档位域 = app-server 的 `ReasoningEffort` **加上**本仓统一的关闭档 `off`（它翻成 CLI 的 `none`）
    reasoningEfforts: [EFFORT_OFF, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'],
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'codex',
      start: (context) => startCodex(context, codexProvider.runtimeHooks),
    }),
};
