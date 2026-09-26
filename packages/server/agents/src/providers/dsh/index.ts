/**
 * dsh 适配器：**按真实探测的入口形态回写** + 路由注入 + 关闭式释放（§5.6.4 / §5.6.5）。
 * 两条关键差异都来自实测的元数据：
 *  - `cancelMidTurn: false`：SDK 没有 wire-level cancel（`HarnessClient.close()` 的 JSDoc 逐字），
 *    所以 `interrupt()` 是**刻意**的空实现，停止只能靠关闭运行时 ⇒ 终止与超时一定走 §5.6.5 的第二段
 *    （等 5 秒、落一条 WARN、再强制关闭，界面上会看到这行晚 5 秒变 canceled）；
 *  - 通知流必须**先订阅再交提示词**：唯一的事件通道是客户端订阅，而
 *    `harness.run(prompt, { sessionId })` 在**下一次 idle** 才落定（`lib/index.js:740-772`）。
 *    顺序错了会丢掉开头那批事件（含 `turn/start`），所以订阅由**流自己**建立，`start()` 里不碰它。
 *
 * **注入模型在 2026-09-30 整体换过**（计划 `2026-09-30-dsh-dual-protocol.md`，探测报告
 * `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`）：本行统一走 **pi-ai 路由**，
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
import { join } from 'node:path';
import { createLogger } from '@aieval/core';
import { DSH_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { buildSubprocessEnv, ensureV1Suffix, stripV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnStart } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult, ProtocolType } from '../../types';
import { projectDshNotification } from './events';
import { loadDshSdk, type DshHarness, type DshNotification, type DshRuntime } from './sdk';

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
 * 「手声明路由」变成「收窄某个 catalog 路由」，语义完全不同（清单见探测报告 §6）。
 */
export const DSH_ROUTE_KEY = 'aieval-route';

/**
 * overlay patch 相对 `configHome` 的落点。
 * 为什么是 per-launch overlay，而不是 `settings.yaml` 或 profile patch 文件（计划 D3/D3b）：
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
 * 每一行都跑在一个**全新的 `configHome`** 上（§5.6.4 不变量 3），于是每次运行都是冷启动，
 * dsh 要解析整棵插件树才回 initialize。真机实测（Task 9，`probe/v3/dsh-adapter-dual-protocol.mts`）：
 * 默认 10s 下 anthropic 与 openai **两条协议双双**以
 * `initialize timed out after 10000ms waiting for dsh profile "sdk"` 失败，被折成 `AGENT_FAILED`——
 * 症状（「这一行失败了」）离真因（握手预算给小了）很远，而它与协议、凭据、overlay 内容都无关。
 *
 * 取值依据：Task 0 的真机探测在相同的冷启动形状下用的就是 60s（`probe/v3/lib/harness.mjs` 的
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
 * 值怎么定的（真机探测报告 §2/§4）：
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

/** 该家能表达的档位（**完整值域**，spec D11）：由上面那张映射表的键派生，避免两处各写一份 */
const DSH_REASONING_EFFORTS: readonly string[] = Object.keys(DSH_REASONING_WIRE);

/** 协议 → pi-ai 的 wire 名（计划 D2：`openai` **只**走 responses，不映射 chat-completions） */
export function wireForProtocol(protocolType: ProtocolType): 'anthropic-messages' | 'openai-responses' {
  return protocolType === 'openai' ? 'openai-responses' : 'anthropic-messages';
}

/**
 * 按 wire 归一化 baseURL（计划 **D8**）。
 *
 * 为什么必须由我们做：pi-ai **不做任何归一化**——模型请求收到的是配置原样的 baseURL
 * （只有 discovery 的列表 URL 会归一化 `/v1` 段，见其 README）。实测（探测报告 §2）：
 *   · `anthropic-messages` → `{baseURL}` 原样 + `/v1/messages?beta=true`
 *     ⇒ 尾部带 `/v1` 的地址会变成 `/v1/v1/messages`；
 *   · `openai-responses` → `{baseURL}` 原样 + `/responses`，**不插 `/v1`**
 *     ⇒ 裸 host 会打到 `{root}/responses`。
 * 所以复用本仓已有的两个规范化函数（与 claude / codex 两侧同源）：anthropic 剥尾 `/v1`、openai 补 `/v1`。
 *
 * 与改动前的等价性：旧路 `keepBaseUrl` + `llm-deepseek`（它自己「没 `/v1` 就补、有就保留」再追加
 * `/messages`）在两条分支上与 `stripV1Suffix` + pi-ai 的结果**逐字相同**。
 */
export function baseUrlForWire(baseUrl: string, protocolType: ProtocolType): string {
  return protocolType === 'openai' ? ensureV1Suffix(baseUrl) : stripV1Suffix(baseUrl);
}

/** YAML 双引号标量：反斜杠与双引号都要转义（模型名里 `:` / `/` / `"` 都出现过） */
function quoteYaml(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
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
    '',
  ].join('\n');
}

/**
 * 把一次 `harness.run()` 通知流包成骨架要的 `AsyncIterable`。
 * 为什么不挂 `onNotification`：那个回调要等 `run()` 被调用之后才存在，而适配器要的是
 * 「迭代一开始就等于订阅已建立」——所以这里**自己订阅**，并把 run 的 promise 当**结束信号**
 * （实测：它在会话下一次 idle 时落定，最后一条通知恰好是 `session.status: idle`）。
 *
 * 为什么过滤器是「认领第一个带 sessionId 的通知、其余同会话的才放行」而不是 `subscribeSessionTree(id)`：
 * 会话 id 由本函数自己 mint 并交给 `run()`，而订阅必须**早于** `run()`；`subscribeSessionTree` 要求
 * 先有 id，但适配器的窄结构里没有 `session()`（它是 SDK 的实现细节，不从厂商类型面 import）。
 * 于是用通配 `subscribe()` 起订阅，从第一条带 `sessionId` 的通知认领它。
 * 实测依据：每次运行的第一条通知就是 `session.status: {sessionId, status:'running'}`，
 * 第一条 `session.event` 在它之后。**不带 `sessionId` 的通知一律放行**（今天没有实测样本，
 * 但「多投影」比「静默丢事件」安全——未识别的通知本来就会保留原始负载）。
 */
function notificationStream(harness: DshHarness, sessionId: string, prompt: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      let claimed: string | null = null;
      const subscription = harness.client.subscribe((notification: DshNotification) => {
        const candidate = readSessionId(notification);
        if (candidate === null) return true; // 不带会话归属的通知一律放行（多投影安全，静默丢事件不安全）
        claimed ??= candidate; // 认领：第一条带会话归属的通知就是本会话的
        return claimed === candidate;
      });
      let settled = false;
      // 「run 交出去」与「promise 落定」分开记：promise 的 rejection **必须被消费掉**，否则会成为
      // unhandled rejection；但也**不能就此丢掉**——传输中断时 run() 直接拒绝、流里一条失败通知都没有，
      // 丢掉它这次运行就会被报成 `ok: true, completed`（「界面显示成功、实际没干活」）。
      // 所以记下来，在队列排空之后抛出去，交给骨架归因（AGENT_FAILED / AUTH_FAILED / …）。
      let runError: { error: unknown } | null = null;
      let runPromise: Promise<unknown>;
      try {
        runPromise = harness.run(prompt, { sessionId });
      } catch (error) {
        subscription.close();
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
      const nextOrSettled = (): Promise<{ notification: DshNotification | null }> =>
        subscription.next().then(
          (notification) => ({ notification }),
          // 订阅在关闭时 reject 挂起的等待者（真实语义）：那一刻流就该结束
          () => ({ notification: null }),
        );
      try {
        for (;;) {
          // **先排空再判结束**：run 落定与通知入队是两件事，`settled` 只是「不会再有新的了」，
          // 已经投递进队列的必须取完（实测形状里 `assistant/message`、`turn/end`、`session.status: idle`
          // 都在 run 落定之前入队，顺序反了会把它们全丢掉、用量一条都采不到）
          const immediate = subscription.tryNext();
          if (immediate !== undefined) {
            yield immediate;
            continue;
          }
          if (settled) break;
          const { notification } = await Promise.race([
            nextOrSettled(),
            runPromise.then(() => ({ notification: null })),
          ]);
          if (notification !== null) yield notification;
        }
        // 队列已空、run 也已落定：若它是**拒绝**收场的，把原因抛出去。
        // 注意顺序——先 drain 再抛：`turn/end(kind:'error')` 那条通知可能已经在队列里，
        // 它带着厂商原文（更有归因价值），骨架会先看见它。
        if (runError !== null) throw (runError as { error: unknown }).error;
      } finally {
        subscription.close();
      }
    },
  };
}

/** 从一条通知里读会话归属：两条已知方法都把它放在 `params.sessionId`。 */
function readSessionId(notification: DshNotification): string | null {
  const value = notification.params?.sessionId;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 本行 profile patch 的旧落点——**已退役**（2026-09-30，计划 D3b）。
 *
 * 留着这条常量只为让「退役」这件事可断言：`ask_user_question` 的 `insert` 已搬进 per-launch overlay
 * （`DSH_ROUTE_PATCH_RELATIVE_PATH`），因为 `profiles/sdk/cordis.patch.yml` 是 **dsh 自己的持久化层**
 * （Settings / config-editor 会写它），而适配器曾整份重写它——两份来源混在一个文件里，排障时
 * 分不清是谁写的。守卫：`index.test.ts` 有一条反向断言，检查适配器**不再**写这个文件。
 */
export const DSH_LEGACY_PROFILE_PATCH_RELATIVE_PATH = 'profiles/sdk/cordis.patch.yml';

async function startDsh(context: TurnContext): Promise<TurnStart> {
  const { input } = context;
  /**
   * **第二道防线**（第一道在编排层：它按注册表能力 `capability.structuredOutput` 决定不传这个字段，
   * 所以这道守卫在生产路径上不可达）。它拦的是**旁路**：`AgentRunInput` 是公开类型，谁都能构造一条带
   * `outputSchema` 的输入直接喂给 `dshProvider.run()`，绕过编排层的那一道。
   *
   * 为什么「悄悄忽略」才是缺陷：dsh 的 SDK 客户端**没有**结构化输出通道（`DeepSeekHarnessOptions`
   * 没有 schema 格，argv 只有 `--profile`/`--patch`，见本文件 `structuredOutput: false` 那一格），
   * 而调用方给出 `outputSchema` 表达的是「请按这份 schema 生成最终答复」。静默丢掉它，这一行**照样
   * 以 `ok: true` 收场**（修之前实测如此），调用方于是以为「返回形状已经被强约束」——实际什么都没发生，
   * 下游解析到一段自由文本时才失败，且失败点离真正的原因很远。**必须报错**（契约 spec D11 / types.ts
   * 的 `AgentRunInput.outputSchema` JSDoc），让「不支持」这件事在**提交请求的那一刻**就可见。
   *
   * 判据：**既非 `undefined` 也非 `null` 才拦**——空值口径与 codex 侧（Task 4）逐字统一，`null` 与
   * 「没给」在这条路径上同义（`null` 说的是「这一格没有值」，不是「要一份 schema」），不能因为一个
   * 显式 `null` 就把一次本来能跑的运行拦下来。局部变量刻意标成 `unknown`：类型面上这一格不可为空，
   * 而这道守卫防的恰恰是类型面之外的调用方。
   *
   * 位置：`loadDshSdk()` **之前**——都要报「这个入参不支持」了，没必要顺手把厂商 SDK 加载起来。
   */
  const outputSchema: unknown = input.outputSchema;
  if (outputSchema !== undefined && outputSchema !== null) {
    throw new Error(
      'deepseek harness 的 SDK 客户端不支持结构化输出（没有 schema 入参）：这一行只能用提示词契约约束返回形状，'
      + '需要 schema 约束请把评分智能体换成 claude-code 或 codex',
    );
  }
  const sdk = await loadDshSdk();
  // 权限档（见 `permission.ts`）：dsh 的档位**烘在启动 profile 里**（§5.6.5 明写「改了必须重建运行时」），
  // 所以它不是 SDK 的一个选项，而是子进程环境里的 `DSH_PERMISSION_MODE`——`dsh-base` 的
  // `sandbox-policy` 与 `approval` 两行都读它，不设时 dsh 自己回落到 `workspace-write`。
  // 注入通道仍是 `buildSubprocessEnv`（替换型子进程环境，§5.6.4），**不碰** `process.env`。
  const { env: permissionEnv } = DSH_PERMISSION_OPTIONS[input.permission];
  const env = buildSubprocessEnv({
    homeDir: input.configHome,
    injected: {
      // 本次运行的路由凭据：**自定义变量名**，由 overlay 的 `apiKeyEnv` 逐字引用。
      // 与 claude 的 ANTHROPIC_API_KEY 同形：凭据进的是**替换型子进程环境**，不写 `process.env`
      [DSH_ROUTE_API_KEY_ENV]: input.route.apiKey,
      DSH_HOME: input.configHome,
      /**
       * **退役旧通道：显式删除，而不是「不再注入」**（计划 D6a）。
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
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
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
    // 冷启动握手预算（SDK 默认 10s，真机实测不够；见 DSH_INITIALIZE_TIMEOUT_MS 的 JSDoc）
    initializeTimeoutMs: DSH_INITIALIZE_TIMEOUT_MS,
    // 思考强度按需带（spec §6.4 / D13）：`undefined` 时一个键都不加 —— 这一格是硬校验的
    ...(input.effort === undefined ? {} : { reasoningEffort: input.effort }),
    env,
  });
  const sessionId = mintSessionId();
  // 在这里就把握手做完（而不是等流的第一次 `next()`）：启动失败属于「这次运行起不来」，
  // 归因要落在 `AGENT_FAILED` 上，且此时还没有「被关闭的对象」⇒ 不该有任何关闭动作。
  // `start()` 是幂等的（SDK 的 `this.initialized ??= …`），流里那次 `start()` 不会重复握手。
  await runtime.start();
  logger.debug('dsh 已注入路由并启动运行时', {
    model: input.route.modelId,
    protocolType: input.route.protocolType,
    api: wireForProtocol(input.route.protocolType),
    contextWindow: input.route.contextWindow,
    effort: input.effort,
    route: DSH_ROUTE_KEY,
    sessionId,
  });
  return {
    stream: notificationStream(runtime, sessionId, input.prompt),
    // 刻意空实现：dsh 不支持中途取消（元数据 cancelMidTurn: false，§5.6.2），
    // 停止请求会由第二段兜底成「关闭运行时」
    interrupt: () => {
      logger.debug('dsh 不支持中途取消，停止请求交由第二段强制关闭处理');
    },
    dispose: createDisposer(() => runtime.close()),
    project: (raw, state) => projectDshNotification(raw, state, { kind: 'dsh', baseUrl: input.route.baseUrl }),
  };
}
export const dshProvider: AgentProvider = {
  kind: 'dsh',
  displayName: 'DeepSeek Harness',
  metadata: {
    /**
     * **两条 wire 都能收**（契约 §11 R37 的收口，2026-09-30）：适配器把路由声明成 pi-ai 路由，
     * 协议决定 `api`——`anthropic` → `anthropic-messages`、`openai` → `openai-responses`
     * （计划 D2：openai 只走 responses，不映射 chat-completions）。
     * 真机证据：两条 wire 用**产品自己的供应商记录**各跑通一次（含计量），
     * 见 `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`。
     *
     * 顺序与 contracts 的枚举一致；它只影响候选池里两类模型的排列，判定一律走 `acceptsProtocol`。
     */
    protocolTypes: ['openai', 'anthropic'],
    capability: {
      cancelMidTurn: false, // 实测确认：SDK 没有 wire-level cancel，界面文案必须不同
      // 实测确认（探测报告 §3）：用量在 `session.event → assistant/message → data.usage`
      // （`inputTokens` / `cacheReadTokens` / `outputTokens`）⇒ 打开提取并把这一格改成 true
      usage: true,
      // liveUsage: 'reported' —— 用量与轮次都是适配器自己报的（`turn/end` 时连同轮次交出，
      // 见 providers/dsh/events.ts 的 usageInput/usageCached/usageOutput）⇒ 可逐步回写快照
      liveUsage: 'reported',
      // SDK 客户端没有 schema 入参（`DeepSeekHarnessOptions` 只有 cwd/provider/model/reasoningEffort/
      // maxTokens，argv 只有 --profile/--patch）⇒ 顶层会话拿不到结构化输出。降级由编排层留痕（spec D4）。
      structuredOutput: false,
    },
    /**
     * 消息能力声明（spec v3 §3.5）：五格 `'yes'`，唯一的结构性缺口是**思考 token**
     * （`reasoningTokens` 在本仓这条 pi-ai 路由上永不投影——`mapUsage()` 有意把推理并入
     * `outputTokens`，而上游确实给了这个数）⇒ 那一格记 `not-projected-by-vendor`。
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
        '思考没有逐字增量（本路由不产出 `reasoning-delta`，推理整块在 `block-end` 到达）⇒ 思考按整块渲染',
        '思考 token（`reasoningTokens`）结构性不可达：`llm-pi-ai` 的 `mapUsage()` 把推理并入 `outputTokens`，那一格恒 `null`',
        '子任务级用量不在 `subagent.*` 通知里 ⇒ 按 `params.sessionId` 把子会话的 `assistant/message.usage` 分组求和',
        '运行时被强制终止时收不到 `subagent.finished` ⇒ 界面必须能显示「未收场」',
        '`stopReason` 的 `error` / `refusal` 两档真机未观测 ⇒ 未覆盖档记 `unknown` + `statusMissing`，不猜',
      ],
    },
    isolation: 'subprocess',
    // 档位域 = 本文件的 `DSH_REASONING_WIRE`（**与 overlay 声明同源派生**）：pi-ai 路由的档位是
    // 「档位名 → wire 拼写」的字典，两边各写一份必然漂移，而漂移的代价是「界面能选、运行时才失败」。
    // 为什么是这四档：`llm-deepseek` 的 `reasoningEffort` schema 只有 `off/low/high/max`
    //（没有 `medium` / `xhigh`）——上游网关的档位在 dsh 行上会因此被交集削掉两档（spec §9 第 6 条），
    // 那是正确结果，不是缺陷。
    reasoningEfforts: DSH_REASONING_EFFORTS,
  },
  run: (input: AgentRunInput): Promise<AgentRunResult> => runTurn(input, { kind: 'dsh', start: startDsh }),
};
