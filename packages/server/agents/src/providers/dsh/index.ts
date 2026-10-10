/**
 * dsh 适配器：路由注入 + 关闭式释放，入口形态以真实探测为准。
 * 两条关键差异都来自厂商元数据：
 *  - `cancelMidTurn: false`：SDK 没有 wire-level cancel（`HarnessClient.close()` 的 JSDoc 逐字），
 *    所以 `interrupt()` 是**刻意**的空实现，停止只能靠关闭运行时 ⇒ 终止与超时一定走释放兜底的第二段
 *    （等 5 秒、落一条 WARN、再强制关闭，界面上会看到这行晚 5 秒变 canceled）；
 *  - 通知流必须**先订阅再交提示词**：唯一的事件通道是客户端订阅，而
 *    `harness.run(prompt, { sessionId })` 在**下一次 idle** 才落定（`lib/index.js:740-772`）。
 *    顺序错了会丢掉开头那批事件（含 `turn/start`），所以订阅由**流自己**建立，`start()` 里不碰它。
 *
 * **注入模型**（判据与探测结论见 `docs/protocols/dsh.md` 的「pi-ai 路由与两条 wire」）：
 * 本行统一走 **pi-ai 路由**，
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
import { createLogger } from '@aieval/core';
import type { McpServers } from '@aieval/contracts';
import { logDraft, type AgentEventDraft } from '../../emit';
import { hostNpmrcPath, quoteYaml, readNpmrcText, toDshMcpPluginLines, writeRowNpmrc } from '../../mcp';
import { DSH_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix, stripV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult, ProtocolType } from '../../types';
import { projectDshNotification } from './events';
import { dshSilentChildSessions, dshSubagentTurns, dshSubagentUsage } from './message';
import { DSH_STREAM_FAILURE_TYPE, DSH_SUBAGENT_FINISHED_METHOD, DSH_TURN_END_TYPE } from './protocol';
import { loadDshSdk, type DshHarness, type DshNotification, type DshRuntime } from './sdk';
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
 * 每一行都跑在一个**全新的 `configHome`** 上（不变量 3），于是每次运行都是冷启动，
 * dsh 要解析整棵插件树才回 initialize。实测（`probe/v3/dsh-adapter-dual-protocol.mts`）：
 * 默认 10s 下 anthropic 与 openai **两条协议双双**以
 * `initialize timed out after 10000ms waiting for dsh profile "sdk"` 失败，被折成 `AGENT_FAILED`——
 * 症状（「这一行失败了」）离真因（握手预算给小了）很远，而它与协议、凭据、overlay 内容都无关。
 *
 * 取值依据：探测在相同的冷启动形状下用的就是 60s（`probe/v3/lib/harness.mjs` 的
 * `initializeTimeoutMs`，注释逐字写着「冷启动要解析整棵插件树；默认 10s 会偶发 initialize 超时」），
 * 那是本次唯一有执行级证据的值。这不是「执行超时」——用户口径是执行不限时间；它只是**握手**的上界，
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
     * 本行要注入的 MCP 条目；缺省 / 空集 ⇒ **一行插件都不插**。
   * 收的是 canonical 形状（与另两家同一份），翻译在 `toDshMcpPluginLines` 里一处完成。
   */
  mcpServers?: McpServers;
}

/**
 * 生成 per-launch overlay patch 的 YAML 文本（**纯函数**：无时间戳、无随机、无环境读取）。
 *
 * 两段内容：
 *   ① `- id: llm-pi-ai` 的 **id 定向覆盖**——patch 语义是「整份替换该行的 config，不是深合并」
 *      （dsh-base 的文件头逐字），所以我们只声明本次运行要用到的那一条路由与那一个模型；
 *   ② `- insert:` 把 `ask_user_question` 挂进 profile——**新增行必须走 insert**，
 *      顶层 `- id:` 只能改或禁既有行。
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
    // stream-tap 插件（流式增量旁路，见 `stream-tap.ts`）：**相对名**按 profile 目录解析
    //（loader 的 baseUrl 就是 <dshHome>/profiles/sdk/），插件文件由适配器在同一次启动里落盘。
    // 纯 node: 内建依赖 ⇒ 不需要 profile 的 pnpm 安装（与 `tool-ask-user` 不同，那个是包名）。
    '    - id: aieval-stream-tap',
    '      name: "./aieval-stream-tap.mjs"',
    // MCP：一台 server = 一行 `@deepseek-ai/dsh-mcp-client`，**同样走 insert**
    // （顶层 `- id:` 只能改或禁既有行）。空集时这里一行都不加——不写空壳行。
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
export interface DshRunState {
  /** 本行的**子会话白名单**：只在这里面的会话才计入「子智能体那一份」 */
  childSessions: Set<string>;
  /** 已收场的子会话（`subagent.finished`）：投影据此把「收场了却没报用量」判成事实缺失（null） */
  finishedSessions: Set<string>;
  /**
     * 上一条 `request/header` 的工具表：`request/header` 每个 step 都投一条，
   * 而投影只在表**变了**的时候发 `vendor-system`（否则同一份几十 KB 的表会被抄 N 遍）。
   */
  headerTools: string[] | null;
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
 *      （真机：`subagentId` 就是子会话 id）；第一条子会话事件没有义务带这个身份
 *      （实测它带 `sessionId` 但**不带** `subagentId`）⇒ 那一条可能被挡掉，
 *      从第二条起就通了。挡掉的只是「子会话的第一个事件」，状态与后续消息照常到达
 *      （读侧按 `subagentId` 覆盖累积，对缺开头本来就宽容）。
 *
 * 为什么不干脆「凡带 sessionId 的都放行」：同一个 harness 实例在多行之间共享，
 * 放行全部会话等于把**别的行**的事件混进这一行的落盘文件——那比丢几条更难查。
 */
function notificationStream(
  harness: DshHarness,
  sessionId: string,
  prompt: string,
  runState: DshRunState,
  tap: DshStreamTapGate,
): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const subscription = harness.client.subscribe((notification: DshNotification) => {
        deliveredNotifications += 1;
        /**
         * ⚠️ **过滤器绝不许抛**（真机事故的直接教训）：
         * SDK 的 `NotificationSubscriptionImpl.push()` 有一条硬语义——**过滤器抛错 = 这条订阅当场
         * detach 并带上终态错误**（`unsubscribe()` + `fail(error)`），此后 `next()` 立刻拒绝，
         * 而**兄弟订阅与传输读循环都不受影响**（也就是说：SDK 自己的那条订阅照常跑到收尾，
         * 我们这一条悄悄死了，外面完全看不出区别）。
         * 原样写这三行就等于把「通知流的生死」押在三个纯函数的健壮性上，而它们的失败模式是
         * **整段对话静默消失**：真机 run `7f05c765` 的 dsh 行，厂商会话日志 201 条事件、
         * 我们只收到前 13 条（+56ms 后彻底断），那次运行照旧判 `judged`、执行日志整段空白。
         * 故这里 **fail-open**：抛了就记 ERROR、放行该条，绝不把一条通知的解析问题升级成
         * 「这一轮的内容全不要了」。
         */
        try {
          noteChildSession(notification, sessionId, runState.childSessions);
          noteFinishedChildSession(notification, runState.finishedSessions);
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
       * 自己的会话先入；每放行一条真通知，把它带出的会话身份（`params.sessionId` 与
       * `subagent.*` 通知的子会话三级兜底）记进来。子会话的增量行必须等 `subagent.started`
       * **投影之后**才放——`sessionIdProfileSubagent` 只认登记过的 id，早放会把子智能体的话
       * 挤进主会话同 step 号的载体。
       */
      const knownSessions = new Set<string>([sessionId]);
      const noteKnown = (notification: DshNotification): void => {
        const sid = readSessionId(notification);
        if (sid !== null) knownSessions.add(sid);
        for (const identity of childSessionIdentities(notification)) knownSessions.add(identity);
      };
      let settled = false;
      /** 已放行的通知条数（失败上报时用它说明「断在哪」：收到 N 条之后就再没有了） */
      let received = 0;
      /**
       * **客户端投递**给我们的通知条数（SDK 对每条通知都会调用一次过滤器 ⇒ 这里就是投送总量）。
       * 它与 `received` 的差额是「断在消费侧还是投送侧」的唯一判据（排障的关键一格）。
       */
      let deliveredNotifications = 0;
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
        runPromise = harness.run(prompt, { sessionId });
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
      const nextOrSettled = (): Promise<{ notification: DshNotification | null }> =>
        (pendingNext ??= subscription.next().then(
          (notification) => ({ notification }),
          /**
           * 订阅 reject 有**两种**截然不同的含义，而原实现把它们当成同一件事（静默返回 `null`）：
           *   · **`close()`**（我们自己收尾调用的）⇒ 正常结束，流就该结束；
           *   · **`fail(error)`**（SDK 的 `push()` 在过滤器抛错时调的，或传输读循环死了）⇒
           *     **投送已经死了，而这一轮还远没结束**。
           * 把第二种读成第一种的后果是真机上看到的形状：厂商会话日志 201 条、
           * 我们只收到前 13 条，之后 138 秒的内容一条不剩，**而这一行照旧判 `judged`、
           * 执行日志整段空白、任何一条日志都没有**（run `7f05c765` 的 dsh 行）。
           * 所以这里把失败**留下来**（`streamFailure`），收尾时如实进行事件流。
           */
          (error: unknown) => {
            /**
             * 只有**run 还没落定**时的拒绝才算「投送中途死掉」：`finally` 里我们自己的
             * `close()` 同样会 reject 挂起的等待者（真实语义），那属于正常收尾——
             * 不加这一条，每次用户终止都会平白多一条「通知流中断」。
             */
            if (!settled) streamFailure ??= error;
            return { notification: null };
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
          if (settled) break;
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
            runPromise.then(() => ({ notification: null })),
            tapWake,
          ]);
          if (tapTimer !== undefined) clearTimeout(tapTimer);
          if (notification !== null) {
            received += 1;
            lastNotificationAt = Date.now();
            if (notificationEventType(notification) === DSH_TURN_END_TYPE) sawTurnEnd = true;
            yield notification;
            noteKnown(notification);
          }
          yield* tap.drain(knownSessions);
        }
        /**
         * 投送中途死掉 ⇒ **必须如实报出去**（这条流是这一行唯一的内容来源）：
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
        });
        if (end.kind === 'failed' || end.kind === 'stalled') {
          logger.error(
            end.kind === 'failed'
              ? 'dsh 通知订阅在中途失败：此后的事件与消息全部未采集（这一行的执行日志会不完整）'
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
 * 就认定投送在中途停住了（真机 run `7f05c765` 的 dsh 行是 **138 秒**）。
 *
 * 为什么用 5 秒：正常一轮的收尾几乎与最后一条通知同刻（`turn/end` → `session.status: idle` →
 * `run()` 落定），间隔是毫秒级；而长的工具调用虽然也让流静默，但那时 `run()` **还没落定**、
 * 循环仍在等——这个判据只在**循环退出时**看，所以不会把「模型在跑长命令」误判成停滞。
 */
export const DSH_SILENT_STALL_MS = 5_000;

/**
 * 循环退出时的**四种收场**（纯函数，故可单独钉住——这是「执行日志为什么是空的」的唯一答案来源）：
 *   · `ok`      —— 正常：见过 `turn/end`，或本来就是 `runError` 收场（失败归因另有出口）；
 *   · `failed`  —— 订阅被 SDK 判死（`fail(error)`：过滤器抛错 / 传输读循环死）；
 *   · `stalled` —— **没有报错，但投送就是停了**：没见过 `turn/end` 且静默超过阈值。
 *     真机第二次重跑（attempt 2）就是这一种：厂商会话日志 245 KB 内容齐全，我们 13 条之后再无音信。
 *   · `unknown` —— 没见过 `turn/end`，但静默没超过阈值（多半是夹具那种「事件吐完就落定」的形状）
 *     ⇒ **不报**：没有证据就不要编一个故障。
 */
export type DshStreamEnd =
  | { kind: 'ok' }
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
}): DshStreamEnd {
  if (input.failure !== null && input.failure !== undefined) {
    const reason = input.failure instanceof Error ? `${input.failure.name}: ${input.failure.message}` : String(input.failure);
    return { kind: 'failed', reason };
  }
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
 * 两个来源，缺一不可：
 *   · **顶层通知** `subagent.started` / `subagent.finished`：身份在 `params.subagentId`
 *     （它就是子会话 id，与随后子会话事件里的 `params.sessionId` 同值）；
 *   · **子会话事件自带 `subagentId`**：某些事件（如 `subagent/catalog` 或带身份的会话事件）
 *     会带上它，此时不必等顶层通知。
 *
 * `ownSessionId` 用来排除「主会话自己带了 subagentId」的误判（今天没有这种样本，
 * 但把主会话登记成子会话会让它的事件被重复放行，代价是重复内容而不是报错——预防比排查便宜）。
 */
function noteChildSession(
  notification: DshNotification,
  ownSessionId: string,
  childSessions: Set<string>,
): void {
  for (const identity of childSessionIdentities(notification)) {
    if (identity === ownSessionId) continue;
    childSessions.add(identity);
  }
}

/**
 * 一条通知里可能出现的**子会话身份**（三级兜底，真机逐条核过）：
 *   · 本机形状给 **`subagentId`**（与随后子会话事件里的 `params.sessionId` 同值）；
 *   · 规范描述的另一种形状给 `agentId`（与 `childSessionId` 同值）；
 *   · 再兜 `childSessionId`。
 * 三个名字指的是**同一个东西**，哪一格有值随版本/通道而变 ⇒ 全认；登记多一个不存在的 id 是无害的
 * （没有任何事件会带它），漏登记才有害。
 *
 * ⚠️ 必须是**唯一一份**：白名单登记（`noteChildSession`）与收场登记（`noteFinishedChildSession`）
 * 各写一遍的话，形状一变就会出现「白名单认得出、收场认不出」——症状正是 `null` 静默降级成
 * `{0,0,0}`（把「没采到」说成「确实没有」）。
 */
function childSessionIdentities(notification: DshNotification): string[] {
  const params = notification.params;
  if (params === undefined) return [];
  return [params.subagentId, params.childSessionId, params.agentId].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate !== '',
  );
}

/**
 * `subagent.finished` 的身份登记：投影据此区分「已经收场却没报用量」（事实缺失 ⇒ `null`）
 * 与「还在跑」（还没报就先当 0，它还会报）。
 *
 * 只登记身份、不产出任何事件——与 `noteChildSession` 同一层：两张集合都是「投影要读的事实」，
 * 而它们的唯一来源就是这条通知流（同一条通知先进这里、再决定放不放行）。
 * 身份取值与白名单**同源**（`childSessionIdentities`）。
 */
function noteFinishedChildSession(notification: DshNotification, finished: Set<string>): void {
  if (notification.method !== DSH_SUBAGENT_FINISHED_METHOD) return;
  for (const identity of childSessionIdentities(notification)) finished.add(identity);
}

/**
 * 收尾那条**点名 WARN**（第三档）：分量走 `null` 时，
 * 日志里必须说得出「是哪些子会话没报用量」——否则「没采到」与「确实没有子智能体」长得一样。
 *
 * 三条口径：
 *   · **一条**文案串起全部 id（`、` 分隔），不是每个 id 一条：这是**一个事实**（这一行的分量为什么
 *     是 `null`），刷成 N 条只会把日志淹掉；
   *   · 文案与另两家**同用途**（都是「点名谁没报」）**但句式刻意不同**：另两家说的是「这一行的
 *     tok / 缓存命中 / 轮次**都不含**它们」——那句话在 codex / claude 上成立（它们的合计真的会
 *     退回主线程口径），**在 dsh 上是假的**：dsh 的 `turns` 是**构造上的全树累加**
 *     （`step/start` 不按会话分叉），一个收场却没报用量的子会话，它的 `step` **已经在合计里**，
 *     缺的只是**分量**。所以这里逐格说对：「分量给不出」+「轮次含它的 step」+「tok 里没有它报过的
 *     用量」。这一行正是运维对着 `主 27 + 子 7 = 34` 复核时会读到的字，措辞必须与事实同尺。
 *   · 没有 id 时**一条都不发**：判据是 `dshSilentChildSessions`（与 `dshSubagentUsage` 的 `null` 档
 *     同源），空列表说明两处漂移了，此时宁可不出声也不要落一条没有名字的 WARN。
 */
function silentSubagentWarns(runState: DshRunState): AgentEventDraft[] {
  const silent = dshSilentChildSessions(runState);
  if (silent.length === 0) return [];
  return [
    logDraft(
      'stderr',
      `[WARN] 子会话 ${silent.join('、')} 已收场却没有用量事件：这一行的**子智能体分量**给不出`
        + '（tok 与轮次的分量都是 null，不编造、不填 0）；合计仍是已观察到的全树读数——'
        + '轮次含它的 step，tok 里没有它报过的用量',
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

async function startDsh(context: TurnContext): Promise<TurnStart> {
  const { input } = context;
  // **不要**在这里加「收到 `outputSchema` 就报错」的守卫：支持与否由 `run` 转发的
  // `capability.structuredOutput` 交给骨架，`runTurn` 在 `start` 之前就把这一格摘掉了 ⇒ 走到这里
  // 它必定不存在，再判一次是死代码。代价已登记：绕过 `run` 构造 `AgentRunInput`
  // 的旁路不报错、改为静默降级——这是「降级口径只该有一处」换来的。
  const sdk = await loadDshSdk();
  // 权限档（见 `permission.ts`）：dsh 的档位**烘在启动 profile 里**（「改了必须重建运行时」），
  // 所以它不是 SDK 的一个选项，而是子进程环境里的 `DSH_PERMISSION_MODE`——`dsh-base` 的
  // `sandbox-policy` 与 `approval` 两行都读它，不设时 dsh 自己回落到 `workspace-write`。
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
       * 「值为 undefined 就 delete」。不写这两行的话，宿主里若存在 `DEEPSEEK_API_KEY`
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
   * 那一步组装（`--patch` 由 SDK 拼进 argv）。写晚了这一行照样「跑完」，但合成树里**没有**我们的路由，
   * 症状是 `initialize` 阶段报 `no adapter registered for provider "aieval-route"`。
   *
   * 这条时序由 `onConstruct` 快照钉住（guard 见 `index.test.ts`）：写晚了快照读到的就是 `null`。
   * 文件是**整份重建**的（同一份输入两次调用逐字相同，见 `buildDshRoutePatch` 的纯函数用例），
   * 所以不存在「上一次运行的窗口残留」这类需要单独清理的状态。
   */
  const routePatchPath = join(input.configHome, DSH_ROUTE_PATCH_RELATIVE_PATH);
  /**
   * 写 overlay 之前**先建 `configHome`**：本适配器是三家唯一在厂商进程起来之前就往配置目录里写文件的
   * （另两家只把路径交给 CLI，由 CLI 自己建）。
   *
   * 为什么必须自己 mkdir：它**不能假设父进程已经建好**——`AgentRunInput.configHome` 的契约只说
   * 「该行独立配置目录」，没说它一定存在（生产路径上 `prepareRowWorkspace` 会建，但那是**编排层的
   * 实现细节**，不是这一层的输入前提）。不建的表现是 `ENOENT: open '…\.agenthome\aieval-route.patch.yml'`，
   * 归因成 `AGENT_FAILED`，而真正的原因（目录不存在）离得很远。
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
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  /**
   * 行内 npm registry：宿主的 `.npmrc` 里那一行**照抄**进行私有 `configHome`。
   *
   * 时机：与 overlay 同一段（都在 `new sdk.DeepSeekHarness(...)` 之前）——dsh 的插件行里
   * `npx -y @playwright/mcp@latest` 是**它自己**去拉包，等 runtime 起来再写就晚了。
   * 三条边界与 claude / codex 两侧逐字相同（宿主没有 ⇒ 什么都不做；只读宿主、只写行内；0600）。
   */
  const registryLine = writeRowNpmrc({
    configHome: input.configHome,
    hostNpmrc: readNpmrcText(hostNpmrcPath()),
  });
  /**
   * stream-tap 的两份落盘（**与 overlay 同一个时序**：boot 在 `new DeepSeekHarness(...)` 那一步
   * 读 patch 装配清单并 import 插件，写晚了这一行照样「跑完」，只是没有任何增量）：
   *   · 插件本体落 profile 目录（overlay 里 `./aieval-stream-tap.mjs` 的相对名按它解析）；
   *   · 旁路文件**整份清零**而不是「不存在就跳过」：重跑同一行时上一轮尝试的增量行绝不能
     *     当本轮的重放——增量只广播不落盘，重放的旧行会顶掉新一轮的实时视图。
   */
  const tapPluginPath = join(input.configHome, DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH);
  const tapFilePath = join(input.configHome, DSH_STREAM_TAP_RELATIVE_PATH);
  mkdirSync(dirname(tapPluginPath), { recursive: true });
  writeFileSync(tapPluginPath, DSH_STREAM_TAP_PLUGIN_SOURCE, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(tapFilePath, '', { encoding: 'utf8' });
  const runtime: DshRuntime = new sdk.DeepSeekHarness({
    cwd: input.cwd,
    dshHome: input.configHome,
    processCwd: input.cwd,
    model: input.route.modelId,
    // 路由键：与 overlay 的 `providers` 字典键、以及 `listProviders()` 里的 id **必须逐字相同**，
    // 否则 `initialize` 会以 `no adapter registered for provider "…"` 收场（源码同源，见 DSH_ROUTE_KEY）
    provider: DSH_ROUTE_KEY,
    // `patches` 是**绝对路径**：SDK 用 `resolve(callerCwd, path)` 解析，而 callerCwd 是宿主进程的 cwd
    // ⇒ 给相对路径会让文件落到别处（甚至根本不在本行的 .agenthome 里）
    patches: [routePatchPath],
    // 冷启动握手预算（SDK 默认 10s 不够；见 DSH_INITIALIZE_TIMEOUT_MS 的 JSDoc）
    initializeTimeoutMs: DSH_INITIALIZE_TIMEOUT_MS,
    // 思考强度：**恒带**——未选时用缺省档 `high`，
    // 没有「undefined 时一个键都不加」这条路（那在 dsh 上等于关闭，见 DSH_DEFAULT_EFFORT 的注释）。
    // 显式 `off` 原样交给 harness：它按 `DSH_REASONING_WIRE.off = null` 不写 reasoning 字段 ⇒ 关闭。
    reasoningEffort: input.effort ?? DSH_DEFAULT_EFFORT,
    env,
  });
  const sessionId = mintSessionId();
  // 在这里就把握手做完（而不是等流的第一次 `next()`）：启动失败属于「本次运行起不来」，
  // 归因要落在 `AGENT_FAILED` 上，且此时还没有「被关闭的对象」⇒ 不该有任何关闭动作。
  // `start()` 是幂等的（SDK 的 `this.initialized ??= …`），流里那次 `start()` 不会重复握手。
  await runtime.start();
  logger.debug('dsh 已注入路由并启动运行时', {
    model: input.route.modelId,
    // **只记名字**（条目的 env / headers 里可能有密钥，日志不该能把它带出去）；
    // registry 那一格同理只记「写没写进去」，不抄宿主那一行的内容（与 claude 侧同一条口径）
    mcpServers: Object.keys(input.mcpServers ?? {}),
    npmRegistry: registryLine === null ? null : 'row-npmrc-written',
    protocolType: input.route.protocolType,
    api: wireForProtocol(input.route.protocolType),
    contextWindow: input.route.contextWindow,
    effort: input.effort,
    route: DSH_ROUTE_KEY,
    sessionId,
  });
  /**
   * 本行的**子会话白名单**与**已收场集合**：三处共用——通知流的放行判据要在
   * 收到 `subagent.started` 时登记，投影要按同一份白名单算「子智能体那一份」用量，
   * 收尾（`finalize`）要用同一份取数面把结论折进结果。
   * 提到 run 作用域之前它是一个藏在 `notificationStream` 里的局部变量，投影看不到它。
   */
  const childSessions = new Set<string>();
  const finishedSessions = new Set<string>();
  const runState: DshRunState = { childSessions, finishedSessions, headerTools: null };
  return {
    stream: notificationStream(
      runtime,
      sessionId,
      input.prompt,
      runState,
      createDshStreamTapGate(tapFilePath),
    ),
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
    dispose: createDisposer(() => runtime.close()),
    /**
     * **收尾也交一次分量**。
     *
     * 为什么必须有：`usage` 事件的发射门槛是**轮次**（`turn.ts` 的发射点），而「子会话收场了却
     * 一条用量都没报到」这个结论是在**不带轮次**的那条通知（`subagent.finished`）上成立的
     * ⇒ 若这一轮之后再没有消息，结论就送不出去，`AgentRunResult.subagentTokens`（进而行快照）
     * 里留下的是骨架那个初值或上一版的旧数。收尾是**最后**一次机会：它每次运行都跑
     * （正常 / 失败 / 被终止都在 `finally` 里，见 `turn.ts` 的收尾投影），
     * 且 `subagentTokens` 的**显式 `null` 会覆盖**。
     *
     * 这一格走 `null` 时**必须点名**（第三档）：`null` 是
     * 「没采到」，而它与「确实没有子智能体」（`{0,0,0}`）在日志里本来长得一样——另两家都落一条
     * 点名的 WARN（`claude-code/index.ts` 的「读不到子智能体 …」、`codex/transcript.ts` 的
     * 「未找到子线程 …」），dsh 原来在这里给的是 `drafts: []` ⇒ 一格 `null` 悄无声息。
     * 活的那一半（`usage` 事件）由 `step/start`、`assistant/message` 与 `turn/end` 三条出口带
     * （**三处都同时带两格**，见 `events.ts` 的注记）。
     */
    finalize: () => {
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
        // 只有「事实缺失」那一档才落 WARN：`{0,0,0}` / `0`（确实没有）不该刷噪声
        drafts: subagentTokens === null ? silentSubagentWarns(runState) : [],
        subagentTokens,
        subagentTurns,
      };
    },
    project: (raw, state) =>
      projectDshNotification(raw, state, { kind: 'dsh', baseUrl: input.route.baseUrl }, runState),
  };
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
     * 顺序与 contracts 的枚举一致；它只影响候选池里两类模型的排列，判定一律走 `acceptsProtocol`。
     */
    protocolTypes: ['openai', 'anthropic'],
    capability: {
      cancelMidTurn: false, // 实测确认：SDK 没有 wire-level cancel，界面文案必须不同
      // 实测确认：用量在 `session.event → assistant/message → data.usage`
      // （`inputTokens` / `cacheReadTokens` / `outputTokens`）⇒ 打开提取并把这一格改成 true
      usage: true,
      // SDK 客户端没有 schema 入参（`DeepSeekHarnessOptions` 只有 cwd/provider/model/reasoningEffort/
      // maxTokens，argv 只有 --profile/--patch）⇒ 顶层会话拿不到结构化输出。
      // A1 起 `run` 把这一格转发给骨架，由 `runTurn` 摘掉 schema 并记 `applied.structuredOutput=false`。
      structuredOutput: false,
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
        '正文/思考增量经 stream-tap 采集（2026-10-09）：适配器把一个插件写进每行 profile 目录'
          + '（overlay `insert`、相对名按 profile 目录解析），插件订阅厂商进程内的 '
          + '`agent/assistant-stream`、把 chunk 帧旁路到 `<configHome>/aieval-stream-tap.jsonl`，'
          + '适配器 tail 后包成 `aieval/delta` 伪通知走同一条投影。stdio 通知流本身不投送增量'
          + '（jsonrpc-server 任何版本都不订阅该进程内事件，判例 `docs/faq/deepseek-harness.md`）。',
        '增量只广播不落盘（编排层 2026-10-09 三家统一）：`messages.jsonl` 里只有快照；'
          + '被打断的块没有快照，那段半截正文刷新后不可见（实时视图仍有、光标停在断点）。',
        '工具入参增量不投（block-start/block-end 只用于占位换算块位次）：tool-call 的参数走快照整块。',
        '思考增量按 wire 实际产出投送：本路由若不产 `reasoning-delta`，思考仍整块到达（`block-end`/快照）。',
        'max-tokens 截断的那次尝试：厂商把 `content[]` 里的 tool-call 全部丢弃，块位次按流序换算'
          + '可能与截断后的快照错位 ⇒ 实时视图或短暂出现重复块（快照覆盖后自愈；该行本就落截断终态）。',
        '子会话增量只放行「已登记」的会话（等 `subagent.started` 投影之后）——避免误归主会话载体。',
        '思考 token（`reasoningTokens`）结构性不可达：`llm-pi-ai` 的 `mapUsage()` 把推理并入 `outputTokens`，那一格恒 `null`',
        '子任务级用量不在 `subagent.*` 通知里 ⇒ 按 `params.sessionId` 把子会话的 `assistant/message.usage` 分组求和',
        '运行时被强制终止时收不到 `subagent.finished` ⇒ 界面必须能显示「未收场」',
        '`stopReason` 的 `error` / `refusal` 两档真机未观测 ⇒ 未覆盖档记 `unknown` + `statusMissing`，不猜',
      ],
    },
    // 档位域 = 本文件的 `DSH_REASONING_WIRE`（**与 overlay 声明同源派生**）：pi-ai 路由的档位是
    // 「档位名 → wire 拼写」的字典，两边各写一份必然漂移，而漂移的代价是「界面能选、运行时才失败」。
    // 为什么是这四档：`llm-deepseek` 的 `reasoningEffort` schema 只有 `off/low/high/max`
    //（没有 `medium` / `xhigh`）——上游网关的档位在 dsh 行上会因此被交集削掉两档，
    // 那是正确结果，不是缺陷。
    reasoningEfforts: DSH_REASONING_EFFORTS,
    // 未选档位时 dsh 实际会用的档（`DSH_DEFAULT_EFFORT`）：API 侧用它拦「未选 + 模型不支持缺省档」，
    // 免得跑到本家的硬校验处才以 `UNSUPPORTED_REASONING_EFFORT` 收场。另两家不声明这一格。
    defaultEffort: DSH_DEFAULT_EFFORT,
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> =>
    runTurn(input, {
      kind: 'dsh',
      // 能力从自己的 metadata 转发（骨架不反查注册表）：改 metadata 就是改这里的行为，两处同源
      capability: { structuredOutput: dshProvider.metadata.capability.structuredOutput },
      start: startDsh,
    }),
};
