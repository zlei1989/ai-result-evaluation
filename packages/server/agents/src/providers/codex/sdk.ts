/**
 * codex 的厂商 SDK 懒加载外壳 + 一份**完整的** model_providers 条目构造。
 * 本文件是唯一知道 `@openai/codex-sdk` 入口形状的地方（窄结构自声明，不从厂商包 import type）。
 * 注意：
 *  - `requires_openai_auth` 不是可选优化——缺它 CLI 不发 Bearer，全部 401（§5.6.4）；
 *  - 显式 model_providers 条目同样必需：环境里已有的 ~/.codex 配置会赢过我们注入的 base URL；
 *  - config 的键名与层级以真实探测运行的 dump 为准（探测脚本会把注入对象原文一起 dump）；
 *  - 包名只允许出现在**非 import/export 起始**的语句里（T5 的静态导入断言区分不出
 *    `export … from '@pkg'` 与 `export const X = '@pkg'`，见 CLAUDE_PACKAGE_NAME 的同款说明）。
 */
import { AgentLoadError } from '../../errors';
import { createSdkLoader } from '../../load-once';

const CODEX_PACKAGE_NAME_LITERAL = '@openai/codex-sdk';

export const CODEX_PACKAGE_NAME = CODEX_PACKAGE_NAME_LITERAL;

/** 注入的 provider id：与宿主 ~/.codex 里可能存在的同名条目互不冲突 */
export const CODEX_PROVIDER_ID = 'aieval';

export interface CodexProviderEntry {
  name: string;
  /** Responses wire 的完整根：`{base}/v1`（CLI 只走 `POST {base}/v1/responses`） */
  base_url: string;
  /**
   * **只能是 `'responses'`**——CLI 的 `wire_api` 是**单变体枚举**，实测（2026-10-01，两份二进制
   * 0.154.0 与适配器实际 spawn 的 0.156.1 行为一致，配置校验阶段即失败、与网络无关）：
   *
   * ```
   * -c 'model_providers.aieval.wire_api="chat"'             → Error loading config.toml:
   *     `wire_api = "chat"` is no longer supported.  How to fix: set `wire_api = "responses"` …
   * -c 'model_providers.aieval.wire_api="chat_completions"'  → unknown variant `chat_completions`, expected `responses`
   * -c 'model_providers.aieval.wire_api="openai"'            → unknown variant `openai`, expected `responses`
   * -c 'model_providers.aieval.wire_api="completions"'       → unknown variant `completions`, expected `responses`
   * ```
   *
   * 那句 `expected \`responses\`` 就是枚举的全部取值。**所以"改走 chat 接口以拿到 reasoning_content"
   * 这条路在本机 codex 上不存在**：改了会让**每一次运行都在启动阶段失败**。
   * 类型写成字面量而非 `string`，就是为了让这件事在编译期就拦住（证据见
   * `probe/dumps/v4/codex-wire-api-matrix.json`；codex 侧拿思考正文的唯一可行通道是"本地中继直读上游响应体"）。
   */
  wire_api: 'responses';
  /** 缺它不发 Bearer，全部 401（§5.6.4） */
  requires_openai_auth: true;
  request_max_retries: number;
}

export interface CodexConfig {
  model_provider: string;
  model_providers: Record<string, CodexProviderEntry>;
  /**
   * **工具**开关：只放这个 CLI 版本认的键。
   *
   * 逐条实测过（2026-09-27，CLI 0.156.1，判据是 CLI 自己的
   * 「Codex is ignoring unrecognized configuration settings … `<key>` is ignored」告警，
   * 它在 `turn.started` 之前就打出来、与网络无关）：
   *   · `tools.web_search=false` —— ✅ 被接受（保留）；
   *   · `tools.multi_agent=false` —— ❌ **被忽略**（这个 CLI 版本把它归到**特性**里，不在 `tools` 下）。
   *
   * **`tools.update_plan.enabled=true`（2026-09-30 新增，用户口径：统一打开）**：
   * codex 的计划工具**默认关闭**，开它的理由是评测口径要三家一致
   * （claude 走 `CLAUDE_CODE_ENABLE_TODO_TOOLS`、dsh 默认就开）。
   * 实测：不设该键时入站 `tools[]` 里**没有** `update_plan`；设成 `true` 后它出现在
   * `write_stdin` 之后。它的形态是整表提交（「a list of plan items, each with a step and status」），
   * 与 dsh 的 `todo_write` 同族（`commitModel: 'replace-whole-list'`）。
   * ⚠️ 它与 codex 的 Plan mode **互斥**（内嵌文案逐字：
   * `update_plan is a TODO/checklist tool and is not allowed in Plan mode`），
   * 而本仓从不进 Plan mode，故不冲突。
   */
  tools: { web_search: false; update_plan: { enabled: true } };
  /**
   * **特性**开关（`multi_agent` 归这里）。
   *
   * 为什么是 `true`（2026-10-03 用户口径修正，理由是**三家口径必须一致**）：
   *   · 子智能体是本仓的评测面之一——claude 走 `CLAUDE_CODE_ENABLE_TODO_TOOLS`、
   *     dsh 默认就开，只有 codex 被本适配器关掉 ⇒ 同一道题在三家上跑的不是同一件事；
   *   · 关掉之后**不是「安静地没有子任务」，而是模型仍然会试**：真机会话文件里
   *     `spawn_agent` 调用的返回是
   *     「Subagent dispatch requires multi-agent support … `[features] multi_agent = true`」
   *     ——一次**失败的工具调用**，代价照付（token 花了、轮次占了、工具结果里躺一句配置提示），
   *     而事件流里连 `collab_tool_call` 都没有 ⇒ 抽屉里子任务面板恒空
   *     （用户口径：「codex 没有看到 subagent 消息」）。
   *   关掉它换来的那份「保护」在这里也站不住：那条护栏的原始理由是「网关对命名空间工具回 400」，
   *   而**关掉只影响工具注册，不影响请求本身**——真机实测工具表里没有 `multi_agent_v1` 时
   *   上游照样正常收下请求（这一行跑完了、还拿了 57/57）。
   *
   * ⚠️ 登记一条已知边界（不是本适配器可解）：**有些路由上 `spawn_agent` 会被判 `unsupported call`**
   * （真机在自建网关上复现过；同一个 CLI 在 DeepSeek 路由上真跑通过，`collab_tool_call` 18 条）。
   * 那是路由侧的事，表现是「模型调了、被拒」——**事件流里会有那条失败的工具结果**，
   * 界面据此说「派发被路由拒绝」，而不是「没派子任务」。能力声明随路由翻转（v3 §4.2 步骤 8）。
   *
   * 为什么要写这一格、而不是靠 CLI 的默认值：`multi_agent` 的默认是 **true**
   * （`codex features list` 里 `multi_agent stable true`），本仓要的是**显式**表达
   * 「这一格我们开着」——默认值会随 CLI 版本变，而评测口径不该跟着厂商默认漂。
   */
  features: { multi_agent: true };
  /**
   * 模型的上下文窗口（token）。**只在已知时出现**：CLI 内置目录里没有我们网关的模型名
   * （实测 `codex debug models` 的 11 条全是 GPT 系），所以这个数只能由我们告诉它；
   * 未知时**整个键都不给**，让 CLI 按自己的兜底走 —— 与「我们替它编一个数字」相比，那是更诚实的行为（spec D8）。
   * 本机实测（CLI 0.154.0）：`codex exec --strict-config -c model_context_window=1000000 …` 通过配置校验，
   * 而 `-c <任意不存在的键>=1` 会立刻 `Error loading config.toml: unknown configuration field`。
   */
  model_context_window?: number;
  /**
   * 推理摘要档（CLI 的 `model_reasoning_summary`）。**只在关闭档出现**，值为 `'none'`。
   *
   * 为什么需要它（spec §2.3，探针 D-C / E1 / stepF）：CLI **无条件**在请求体里塞
   * `include:["reasoning.encrypted_content"]`（上游 `client.rs:946`，不可配），而它与
   * `reasoning.summary` **同时存在**时，网关会无视 `reasoning.effort:"none"` 照样推理
   * ——触发条件是两者的**合取**：只有 `include` ⇒ 0 个 reasoning token，`effort:'none'` +
   * `summary:'auto'` + `include` ⇒ 137 个。**不给这一格**，CLI 就不往请求体里写 `summary`
   * （上游 `build_reasoning`：`supports_reasoning_summary_parameter && summary != None`）。
   *
   * ⚠️ 未知时**整个键都不给**（调用方传 `undefined`），与 `model_context_window` 同一写法：
   * 「键不存在」才是「我们没意见」的**形态**。为什么要钉形态而不看值：配置对象是我们与 CLI 之间
   * 唯一的对账面（逐键等于「我们注入了什么」），而**值为 `undefined`** 这一形态会让对账多一层解释。
   * ⚠️ **不要**沿用早先那句「显式 `undefined` 会被摊成字符串交给 CLI」—— 那是**错的**：本仓装的
   * SDK 对值为 `undefined` 的键直接跳过（`dist/index.js:343-345` 的 `if (child === void 0) continue;`
   * ⇒ **不产出任何 `--config` 参数**），两种形态今天**行为等价**。保留形态判据是为了对账与
   * **抗 SDK 漂移**（升级后若把 `undefined` 改成写空值或报错，形态判据仍然拦得住）。
   */
  model_reasoning_summary?: string;
}

export interface CodexClientOptions {
  apiKey: string;
  baseUrl: string;
  config: CodexConfig;
  env: Record<string, string>;
}

export interface CodexThreadOptions {
  model: string;
  workingDirectory: string;
  /** 建线程时固定：改了必须重建线程（§5.6.5），本适配器每次运行新建一个 */
  sandboxMode: string;
  /** 评测是非交互的：任何走人工批准的路径都只会让该行走到超时 */
  approvalPolicy: string;
  skipGitRepoCheck: boolean;
  /**
   * 思考强度（codex-sdk 的 `ModelReasoningEffort`：minimal/low/medium/high/xhigh/max/ultra/persistent）。
   * **不给 ⇒ 沿用模型自己的默认档**（2026-10-06 本机实测：请求体里只有 `"reasoning":{"summary":"auto"}`、
   * **没有** `effort` 字段 ⇒ 由网关/模型决定；这一家的「不传」**不是**关闭，关闭只有显式档才有）。
   * ⚠️ **类型面落后于 CLI**（2026-10-06 实测）：CLI 还接受 `none`（= 关闭思考），而类型面里没有它；
   * 本仓这一格是 `string`，所以能用——但**别**把「类型面没有」当成「这家做不到」。
   */
  modelReasoningEffort?: string;
}

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexRun {
  events: AsyncIterable<CodexEvent>;
}

export interface CodexThread {
  /**
   * `options` 与厂商的 `TurnOptions` 同形：`signal` 之外新增可选的 `outputSchema`
   * （SDK 把它落成 `--output-schema <FILE>`，见该包 README 的 "Structured output"）。
   * 刻意**不**在这里收窄成「只有 signal」：外壳比厂商窄，就等于把厂商的能力关在门外——
   * 窄结构存在的意义是「不 import 厂商类型也能自证形状」，不是「替厂商裁剪能力」。
   */
  runStreamed: (
    prompt: string,
    options: { signal: AbortSignal; outputSchema?: Record<string, unknown> },
  ) => Promise<CodexRun>;
}

export interface CodexClient {
  startThread: (options: CodexThreadOptions) => CodexThread;
}

export interface CodexSdkModule {
  Codex: new (options: CodexClientOptions) => CodexClient;
}

/**
 * 一份完整的 model_providers 条目：环境里已有的 ~/.codex 配置会赢过我们注入的 base URL（§5.6.4）。
 *
 * 键名逐条**实测过**（2026-09-27，CLI 0.156.1）：`features.multi_agent=false` 与
 * `tools.web_search=false` 都被 CLI 接受；而旧写法 `tools.multi_agent` /
 * `disable_response_storage` 会被回一句「is ignored」后**照默认值跑**（`multi_agent` 默认 true）。
 * 判据是 CLI 自己的「unrecognized configuration settings」告警——它在 `turn.started` 之前就打出来，
 * 与网络无关，所以可以离线核验（见冒烟记录 §6）。
 */
export function buildCodexConfig(
  baseUrl: string,
  contextWindow?: number,
  /** 关闭档的第二格（spec §3.2）。`undefined` ⇒ 键整个不出现，CLI 照它自己的默认 `summary:"auto"` 跑 */
  reasoningSummary?: string,
): CodexConfig {
  return {
    model_provider: CODEX_PROVIDER_ID,
    model_providers: {
      [CODEX_PROVIDER_ID]: {
        name: 'aieval gateway',
        base_url: baseUrl,
        wire_api: 'responses',
        requires_openai_auth: true,
        request_max_retries: 1,
      },
    },
    tools: { web_search: false, update_plan: { enabled: true } },
    features: { multi_agent: true },
    ...(contextWindow === undefined ? {} : { model_context_window: contextWindow }),
    // 与上面同一判据形态：`undefined` ⇒ **键整个不出现**（不是「值为 undefined」）
    ...(reasoningSummary === undefined ? {} : { model_reasoning_summary: reasoningSummary }),
  };
}

const loadRaw = createSdkLoader<unknown>(async () => import('@openai/codex-sdk'), CODEX_PACKAGE_NAME);

/** 懒加载 + 形状校验：形状不对与「包没装」归为同一类（AGENT_LOAD_FAILED），文案点名包名 */
export async function loadCodexSdk(): Promise<CodexSdkModule> {
  const raw = await loadRaw();
  if (typeof (raw as { Codex?: unknown }).Codex !== 'function') {
    throw new AgentLoadError(CODEX_PACKAGE_NAME, new Error('模块缺少 Codex 导出'));
  }
  return raw as CodexSdkModule;
}
