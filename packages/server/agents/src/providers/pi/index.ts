/**
 * pi（`@earendil-works/pi-coding-agent`）适配器：**in-process SDK**，每个本次运行一个自注册 provider。
 *
 * 元数据是**真值**（每条声明的依据写在对应字段的注释里），改动前先核那几条结构事实：
 *   · `protocolTypes` 是 `openai` **与** `anthropic`：协议决定 wire
 *     （`openai → openai-responses`、`anthropic → anthropic-messages`），两条都能收。
 *     `openai` 指的是 **Responses** 接口（`POST {base}/v1/responses`），不是 Chat Completions；
 *     文本评分通路（evaluator 的 `text-api`）与这里用同一个判据，故两条通路打到同一个端点；
 *   · `subagent` 是 **`yes` / `wire`**：派发能力整条来自白名单装载的扩展
 *     `@tintinweb/pi-subagents`（`additionalExtensionPaths`），子任务的身份 / 状态 / 用量经
 *     扩展事件总线到达——取数路径、每个本次运行隔离与已知代价写在 `subagents.ts` 的文件头；
 *   · `defaultEffort: 'medium'`：pi 的「未选档位」会**真的**落到一个具体档
 *     （`DEFAULT_THINKING_LEVEL`），声明它，API 侧才能拦「未选 + 该模型不支持这个缺省档」。
 *
 * 一处实现现状（写给读代码的人，不是待办清单）：事件投影在 `providers/pi/events.ts`（运行级事件、
 * 计量、轮次、失败与结束信号），厂商载荷 → 统一消息在 `providers/pi/message.ts`，请求侧取证在
 * `providers/pi/observer.ts`（两条 L3 判据都读它抓到的 payload），MCP 的条目翻译与 `loadConfig`
 * 在 `providers/pi/mcp.ts`；本文件负责装配、凭据投射、`vendor-system` 的取数与把三者接到
 * `runTurn` 骨架的钩子上。`needsMessagesForReasoningEvidence: false` 成立的前提
 * 是那两处把思考正文与工具结果正文逐条投影进 `log`——这是适配器的**实现义务**，别在那里做取舍。
 *
 * ⛔ 本文件**不许**写 `process.env`、也不许用 `${ENV}` 插值：pi 的 bash 工具把
 * `{...process.env}` 整体交给被测 agent（`utils/shell.js` 的 `getShellEnv()`），
 * 写宿主环境等于把网关密钥直接交到被测仓库手里。静态断言扫的就是这一条。
 */
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createLogger, materializeSkills } from '@aieval/core';
import { classifySkillOrigin, type VendorSkill } from '@aieval/contracts';
import { logDraft, vendorSystemDraft, type AgentEventDraft } from '../../emit';
import { AgentLoadError } from '../../errors';
import { PI_MCP_TOOL_PATTERN, PI_PERMISSION_OPTIONS } from '../../permission';
import { createDisposer } from '../../release';
import { sendableRequestHeaders } from '../../request-headers';
import { ensureV1Suffix, stripV1Suffix } from '../../route';
import { runTurn, type TurnContext, type TurnProjection, type TurnStart, type TurnState } from '../../turn';
import type { AgentProvider, AgentRunInput, AgentRunResult, ProtocolType } from '../../types';
import {
  assertPiMcpExtension,
  assertPiSessionShape,
  loadPiAi,
  loadPiSdk,
  type PiCustomTool,
  type PiProviderConfig,
  type PiProviderModel,
  type PiResourceLoader,
  type PiSdkModule,
  type PiSession,
  type PiSkills,
} from './sdk';
import { PI_MCP_STARTUP_WAIT_MS, createPiMcpLoadConfig, toPiMcpServers } from './mcp';
import { buildPiAskUserTools, PI_ASK_USER_TOOL, type PiAskUserParams } from './ask-user';
import { createPiObserver, piRequestSkills, piRequestToolNames, type PiRequestObserver, type PiWire } from './observer';
import {
  PI_STRUCTURED_REJECTION_BUDGET,
  createPiRunState,
  finalizePiSubagents,
  notePiStopRequest,
  projectPiEvent,
} from './events';
import {
  PI_STRUCTURED_OUTPUT_DESCRIPTION,
  PI_STRUCTURED_OUTPUT_TOOL,
  adoptStructuredOutput,
  createStructuredOutputProjection,
  structuredOutputApplied,
} from './structured-output';
import {
  PI_SUBAGENTS_PACKAGE,
  createPiSubagentRecorder,
  piSubagentsExtensionPath,
  piSubagentsVersion,
} from './subagents';
import { readPiSubagentTranscript, type PiSubagentTranscript } from './transcript';
import { PI_SUBAGENT_WIRE_TICK_TYPE, createPiSubagentWire, type PiSubagentWire } from './subagent-wire';

const logger = createLogger('agents/pi');

/** 本次运行的技能根（相对 `configHome`）：`materializeSkills` 写的就是这一层（`core` 的 `skillsDirOf`） */
export const PI_SKILLS_RELATIVE_PATH = 'skills';

/**
 * 未选档位时 pi 实际会用的思考档。
 *
 * 值来自 pi 自己的缺省（`core/defaults.js` 的 `DEFAULT_THINKING_LEVEL`），不是本仓选的；
 * 声明的意义是让 API 侧能提前拦「未选 + 上游模型不支持 `medium`」这种组合，而不是等运行时
 * 被 clamp（模型不支持时 pi 会把它夹到相邻档，这一层是 `notes` 里那句「会被静默夹档」）。
 * 它同时是 `piThinkingLevel` 的兜底值——声明里的「未选会落到哪一档」与实际发出去的那一档是同一份。
 */
export const PI_DEFAULT_EFFORT = 'medium';

/**
 * 本仓档位 → pi 的 `thinkingLevel`（会话级一档，pi 按 wire 换算成出站参数）：
 *   · `off` ⇒ openai wire `reasoning: { effort: 'none' }`（**显式关闭**，Responses 的关闭就是这一档）、
 *     anthropic wire `thinking: { type: 'disabled' }`；
 *   · `minimal|low|medium|high` **同名直传**；anthropic 侧换算成 `budget_tokens`
 *     （1024 / 2048 / 8192 / 16384）并被 `maxTokens - 1024` 夹住；
 *   · `max` 走模型上那条显式映射（见 `PI_THINKING_LEVEL_MAP`），anthropic 侧按 `high` 的预算下发；
 *   · 域外值（`xhigh` 或任何认不出的串）**落到缺省档**，原因见下面那一段。
 *
 * 未选（`undefined`）与显式选了 `medium` 在这一层是同一个值：本仓「未选 ≠ 关闭」，
 * 「未选 = 本家的缺省档」，而那一档必须与 metadata 的 `defaultEffort` 逐字一致。
 *
 * **域外值为什么必须自己收口**：厂商对认不出的档名**不报错**，而是静默夹到另一档——真机出站请求
 * （本地假网关捕获的请求体）逐条实测：
 *   · `xhigh` ⇒ openai wire `reasoning: { effort: 'max' }`（**升档**）；
 *   · 任意认不出的串 ⇒ openai wire `reasoning: { effort: 'none' }`（等于关闭）、anthropic wire
 *     `thinking: { type: 'disabled' }`（也是关闭）。
 * 三种落法都不是调用方给的那一档，而这条路上一个字都不报 ⇒ 本层把域外值换成**声明过**的缺省档，
 * 并在调用点落一条点名 WARN（见 `startPi` 里那一处）。产品路径到不了这里（本次运行池按
 * `intersectEfforts` 收窄过），但批量入口与评测脚本能把 `effort` 直接交给本层。
 */
export function piThinkingLevel(effort: string | undefined): string {
  return effort === undefined || !PI_REASONING_EFFORTS.includes(effort) ? PI_DEFAULT_EFFORT : effort;
}

/**
 * 本家能表达的档位域：metadata 的 `reasoningEfforts`、`piThinkingLevel` 的判据与「域外值点名」
 * **同源**（三处各写一份时，改了一处就会出现「声明收、实际不收」这类静默缺口）。
 *
 * 依据是 pi 的思考档：`off/minimal/low/medium/high` 恒可用，`max` 靠模型上那条显式映射
 * （`PI_THINKING_LEVEL_MAP`）才存在；`xhigh` 不在内建表里（见 `piThinkingLevel` 的注释）。
 */
export const PI_REASONING_EFFORTS: readonly string[] = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'max']);

/**
 * 模型上的档位映射：**只给 `max` 一条**，值就是厂商要看到的字面串。
 *
 * 为什么 `max` 必须映射才可用：pi 只让 `off/minimal/low/medium/high` 恒可用，`xhigh` / `max`
 * 要 `thinkingLevelMap` 里有显式条目才算存在；没有映射时 `max` 会被夹到 `high`——界面能选、
 * 实际降档，比不给这一档更糟。
 *
 * ⛔ **不许给 `off` 标 `null`**：厂商用 `null` 表示「这一档不支持」，pi 于是把 `off` 从可用档里
 * 剔除，`clamp('off')` 落到 `minimal` ⇒ **「关闭」变成静默打开**（anthropic 侧连
 * `thinking: { type: 'disabled' }` 那一句都会被跳过）。这是本文件最容易写错的一格。
 *
 * 值在 `providerModel` 里**逐行复制**：注册面可能长期持有这份对象，共享一个可变对象等于让并发
 * 的两行有机会互相改档（与权限档的工具清单同一条处置）。
 */
export const PI_THINKING_LEVEL_MAP: Readonly<Record<string, string>> = Object.freeze({ max: 'max' });

/**
 * 上下文窗口 / 单次输出上限的**兜底值**：本仓的路由契约里这两格是**可缺**的
 * （`route.contextWindow` / `route.maxOutputTokens`，缺省 = 未知），而 pi 的 `Model` 把它们声明成**必填**。
 *
 * 两条都不能走「照抄 pi 的默认值」（`registerProvider` 那条路**没有**任何兜底：
 * 缺 `contextWindow` 时 agent 循环按 `?? 0` 处理 ⇒ 第一轮就判上下文溢出，症状离真因很远）。
 * 所以缺省时给一组**可辨认的上界**：判据是「本仓口径里『缺省 = 未知』不得被伪装成一个像样的数字」，
 * 而这一组数字大到不会在我们跑的任务上触发溢出、又小到不是任何真实模型的规格。
 * 给了值就**逐字透传**，绝不覆盖调用方的事实。
 */
const PI_UNKNOWN_CONTEXT_WINDOW = 1_000_000;
const PI_UNKNOWN_MAX_TOKENS = 8_192;

/**
 * 本次运行自注册 provider 的 id：由 **`configHome` 派生**（每个本次运行唯一）。
 *
 * 为什么必须是**运行内唯一**：编排层是无界并发（`orchestrator.ts` 的 `Promise.all`），
 * 而 `ModelRuntime` 的 provider 注册是**按 id 索引的全局表**。复用内建 id 或写死一个常量 id，
 * 两本次运行就会互相改掉对方的 `baseUrl` / `apiKey`——症状是「A 本次运行的请求带着 B 本次运行的密钥打到 B 本次运行的网关」，
 * 且只在并发时出现。
 *
 * 为什么用哈希而不是把 `configHome` 直接拼进 id：目录名里有 `/`、空格与中文，而 id 会进
 * 请求路径与日志；形状稳定的短 id 让「哪一行」在排障时仍可辨认（前 12 位十六进制）。
 */
export function piProviderId(configHome: string): string {
  const digest = createHash('sha256').update(configHome).digest('hex').slice(0, 12);
  return `aieval-pi-${digest}`;
}

/**
 * 本仓协议 → pi 的 wire。两条都真跑通过（见 `docs/protocols/pi.md`）：
 * `openai` 打 `POST {baseUrl}/v1/responses`（Responses）、`anthropic` 打
 * `POST {baseUrl}/v1/messages?beta=true`。
 * **不要**把 `openai` 改回 `openai-completions`：本仓 `openai` 的语义是 Responses 接口，
 * 评分通路的文本调用（evaluator 的 `text-api`）与这里用同一个判据；改回去会让同一份
 * 供应商配置在「跑智能体」与「评分」上打到两个端点（一边 200、另一边 404）。
 */
export function wireForProtocol(protocolType: ProtocolType): 'openai-responses' | 'anthropic-messages' {
  return protocolType === 'anthropic' ? 'anthropic-messages' : 'openai-responses';
}

/**
 * 按 wire 归一化 baseUrl（规则与 dsh 那条通路逐字相同）：pi **不做任何归一化**，`model.baseUrl`
 * 原样交给厂商 SDK——
 *   · `openai-responses` 自己只追加 `/responses`、**不插** `/v1` ⇒ 裸 host 会打到 `{root}/responses`
 *     （实测 404），故这里补上 `/v1`；
 *   · `anthropic-messages` 由 `@anthropic-ai/sdk` 追加 `/v1/messages` ⇒ 尾部带 `/v1` 会变成
 *     `/v1/v1/messages`。
 */
export function baseUrlForWire(baseUrl: string, protocolType: ProtocolType): string {
  return protocolType === 'openai' ? ensureV1Suffix(baseUrl) : stripV1Suffix(baseUrl);
}

/**
 * 两条 wire 的 `compat` **显式开**。
 *
 * 为什么不能省：`detectCompat()` 对不认识的自建 provider 一律给 `false`，而「strict 工具 schema」
 * 这条能力位关着时 pi 会把整轮判成配置错误——**零出站请求**、43 毫秒、`stopReason: 'error'`，
 * 症状是一个与本次运行配置毫无关系的失败。
 *
 * 为什么只开这一格：本机网关对默认 auto-detect 发出的 `store: false` / `prompt_cache_key` /
 * `max_output_tokens` / `developer` 角色 / `reasoning.effort` **全部接受**，
 * 多开一格就是给「零覆盖」这条实测结论加一个没有依据的覆盖。
 */
export function compatForWire(wire: 'openai-responses' | 'anthropic-messages'): unknown {
  return wire === 'anthropic-messages'
    ? { supportsStrictTools: true }
    : { supportsStrictMode: true };
}

/**
 * 一条模型定义。三格是**必须显式给**的（厂商的 `Model` 把它们声明成必填，而 `registerProvider`
 * 这条路一个默认值都不补）：
 *   · `cost` 四费率全 0——上游不报成本，本仓也没有价格来源；缺这一格会让厂商的计价函数直接 TypeError，
 *     所以给 0 而不是省掉它；
 *   · `contextWindow` / `maxTokens`——路由缺省时用可辨认的上界（见上面那两个常量）；
 *   · `compat`——见 `compatForWire`。
 *
 * `reasoning: true` 与 `thinkingLevelMap` 是**档位映射生效的前提**，两格缺一不可：
 *   · `reasoning: false` 的模型在 pi 眼里只有 `off` 一档，任何档位都被夹成关闭 ⇒ metadata 声明的
 *     档位域整体失效（用户选了 `high`，出站一个 reasoning 参数都没有）；
 *   · 没有 `thinkingLevelMap` 就没有 `max` 这一档（会被夹到 `high`）。
 * 「上游模型到底会不会思考」是路由条目的事（`supportedEfforts` 收窄本次运行），不是这一格能断言的；
 * 这里声明的是**我们这条 wire 支持按档位下发**。
 */
function providerModel(input: AgentRunInput, wire: string, baseUrl: string): PiProviderModel {
  return {
    id: input.route.modelId,
    name: input.route.modelId,
    api: wire,
    baseUrl,
    // 本仓今天没有图片输入通路
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 档位可下发（映射规则与地雷见 `piThinkingLevel` / `PI_THINKING_LEVEL_MAP`）
    reasoning: true,
    // 逐行复制：这份对象会被注册面长期持有，不与其他行共用（见那个常量的注释）
    thinkingLevelMap: { ...PI_THINKING_LEVEL_MAP },
    contextWindow: input.route.contextWindow ?? PI_UNKNOWN_CONTEXT_WINDOW,
    maxTokens: input.route.maxOutputTokens ?? PI_UNKNOWN_MAX_TOKENS,
    compat: compatForWire(wire as 'openai-responses' | 'anthropic-messages'),
  };
}

/**
 * 本次运行物化的技能根（**绝对路径**）。
 * 为什么必须绝对：相对路径按 `cwd` 解析（实测传 `'skills'` ⇒ 发现 0 条技能），
 * 而我们的技能住在**运行配置目录**里，与工作区没有任何相对关系。
 */
export function candidateSkillsPath(configHome: string): string {
  return join(configHome, PI_SKILLS_RELATIVE_PATH);
}

/**
 * 留白名单 ∪ `cwd` 之下的项目技能、丢掉 HOME 锚定的发现结果。
 *
 * 为什么要**过滤**而不是全关：HOME 锚定的 `~/.agents/skills` 不受项目信任开关约束
 *（`trust: false` 也砍不掉它）——不过滤就会把宿主个人的技能交给被测智能体；而
 * 「被测仓库自带的技能」是被测内容的一部分（与另三家同口径），必须留住。
 * `noSkills: true` 做不到这件事：它把项目技能一起关掉。
 *
 * 判据是**路径前缀**而不是技能名：「白名单」在这里指的就是「本次运行物化出去的那棵树」，
 * 按名字比对会让同在 cwd 之下、只是恰好同名的另一条被误留。
 */
export function keepCandidateAndProjectSkills(
  base: PiSkills,
  roots: { candidateSkillsDir: string; cwd: string },
): PiSkills {
  const skills = base.skills.filter(
    (skill) => isUnder(skill.filePath, roots.candidateSkillsDir) || isUnder(skill.filePath, roots.cwd),
  );
  return { skills, diagnostics: base.diagnostics };
}

/**
 * `path` 是否在 `root` 之下（含 root 自身）。
 * 为什么不用 `startsWith`：`/a/bc` 会被 `/a/b` 前缀匹配上——那是「把别的目录当成自己的」这类
 * 静默漏检的经典形状。分隔符两侧都要比对，且 **`cwd` 自身也要算在内**（`filePath === root`）。
 */
function isUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const withSeparator = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`;
  return path.startsWith(withSeparator) || path.startsWith(`${withSeparator.replace(/\//g, '\\')}`);
}

/**
 * 释放：`abort()` 终结在途轮次 → `waitForIdle()` 等它真的停 → **给扩展一次 `session_shutdown`**
 * → `dispose()` 断开驱动并做 SDK 自己的收尾。
 *
 * 为什么 `abort()` 之后还要 `waitForIdle()`：`abort()` 只发停止信号，在途的那次模型往返要自己
 * 收尾；不等它就让下一本次运行的运行时与本次运行的会话交错，是「跑完的行偶尔还发事件」的形状。
 * 顺序不可颠倒（与另三家同一条口径：直接 dispose 会与在途轮次争抢同一批资源），
 * 且**必须幂等**（看门狗与用户终止可能先后触发）。
 *
 * 为什么要自己发 `session_shutdown`：厂商把扩展的关闭钩子挂在这个事件上（MCP 扩展的连接清理
 * ——进而 stdio 子进程的回收——就是它），而 `AgentSession.dispose()` **不 emit** 它：
 * 只有 `AgentSessionRuntime.dispose()` 与 `reload()` 会。窄壳走的是 `createAgentSession()`，
 * 于是这一发由我们按**厂商 `AgentSessionRuntime.dispose()` 的同一条顺序**补上
 * （`emit(session_shutdown, reason: 'quit')` → `session.dispose()`），用的是公开面
 * （`session.extensionRunner` 的 getter + `ExtensionRunner` 的 `hasHandlers` / `emit`），
 * 不碰私有字段、也不为这一格换掉整条 runtime。
 */
function createSessionDisposer(session: PiSession): () => Promise<void> {
  return createDisposer(async () => {
    try {
      await session.abort();
      await session.waitForIdle();
      await emitPiSessionShutdown(session);
    } finally {
      session.dispose();
    }
  });
}

/**
 * 给扩展投一次「会话关掉了」。**失败只记日志**：它是关闭序列里的一步，不能挡住 `dispose()`
 * （那一步在 `finally` 里，而它才是回收本次运行资源的那一下）。没有运行器 / 没有监听者时静默跳过。
 */
async function emitPiSessionShutdown(session: PiSession): Promise<void> {
  const runner = session.extensionRunner;
  if (runner === undefined) return;
  try {
    if (!runner.hasHandlers('session_shutdown')) return;
    await runner.emit({ type: 'session_shutdown', reason: 'quit' });
  } catch (error) {
    logger.warn('pi 的 session_shutdown 投递失败（扩展自己的清理可能没跑：MCP 连接会留在那边）', { error });
  }
}

/**
 * **厂商侧事实的取数器**（`vendor-system`）：工具表与技能面一个出口，两份判据互钉。
 *
 * 做什么：每次投影被调用时看一眼观察者——**有新请求**（`before_provider_request` 抓到了新 payload）
 * 或**技能清单变了**才产一条 `vendor-system`，其余时候一条都不产（同一份工具表逐条抄进
 * `events.jsonl` 只是噪声，观测格的读法是「取最后一条」）。
 *
 * 两份事实各自的判据来源（这是本家与另三家最不同的一处，别照抄）：
 *   · **MCP 走 `vendor-tool-table`**：`direct` 档下工具真的进 payload 的 `tools`，于是
 *     「表在、里面没有 `mcp__<名>__`」就等于**没起来**（`row-mcp.ts` 按通道决定读法）。
 *     服务清单那一格给 `null`——pi 没有「每台一张状态表」这种东西，而工具表已经是最硬的证据；
 *   · **技能走 `getSkills()` 非空清单**：它是 SDK 的权威面。⚠️ **不许拿 payload 里的技能段当厂商清单**
 *     ——那是 L3 判据（模型侧可见），采不到时会把「我们没读到」误判成「厂商没认」并让整本次运行失败。
 *
 * **同名冲突**在这里作如实呈现：清单里那个名字由厂商侧的胜者顶着（名字仍然在，故运行级结论是
 * `installed`），我们把 `winnerPath` / `loserPath` 落成一条 WARN——**不判 `missing`**：
 * `missing` 的语义是「厂商没认这个名字」，而它在清单里，判它就是让整本次运行失败且文案说假话。
 */
function createPiVendorFactsReader(params: {
  observer: PiRequestObserver;
  wire: PiWire;
  readSkills: () => PiSkills;
  layout: { configHome: string; cwd: string };
  /** 我们本次运行真的装进去的那几条名字（`AgentRunInput.skills`），供 L3 装载档逐名比对 */
  materialized: readonly string[];
}): () => AgentEventDraft[] {
  const { observer, wire, readSkills, layout, materialized } = params;
  let emittedRequests = 0;
  let emittedSkillsKey: string | null = null;
  let announcementsDone = false;
  return () => {
    const requests = observer.count();
    // 一次请求都还没发出去 ⇒ 两份判据都没有取证点（技能清单也要与「这一轮真的带了它」配对才有意义）
    if (requests === 0) return [];
    const skills = vendorSkillsOf(readSkills(), layout);
    const skillsKey = skills.map((skill) => `${skill.name}\u0000${skill.path ?? ''}\u0000${skill.origin}`).join('\n');
    if (requests === emittedRequests && skillsKey === emittedSkillsKey) return [];
    emittedRequests = requests;
    emittedSkillsKey = skillsKey;

    const drafts: AgentEventDraft[] = [];
    /**
     * 一次运行只播一次的两条播报：L3 装载档的缺口与同名冲突。
     * 都挂在「第一次真的读到请求」那一刻——早于它我们手里还没有任何请求侧事实。
     */
    if (!announcementsDone) {
      announcementsDone = true;
      drafts.push(...piSkillFaceAnnouncements(piRequestSkills(observer.latest(), wire), materialized, readSkills()));
    }
    drafts.push(vendorSystemDraft({
      tools: piRequestToolNames(observer.latest()),
      slashCommands: null,
      agents: null,
      // 这一家没有「每台一张状态表」：MCP 的事实只有工具面这一格
      mcpServers: null,
      mcpChannel: 'vendor-tool-table',
      permissionMode: null,
      outputStyle: null,
      skills,
    }));
    return drafts;
  };
}

/**
 * 两条**只在第一次读到请求时**播一次的 WARN（都不改变任何结论，但缺了它们这两件事在事件里
 * 一个字都没有）：
 *   · **L3 装载档的缺口**：我们装入的技能没出现在这一轮请求的系统段里（逐名比对）。
 *     它与运行级判据是两张脸——运行级看厂商清单（`getSkills()`），这里看**模型侧真的收到了什么**；
 *   · **同名冲突**：厂商侧的胜者路径与我们那一份的路径一起落，供用户自己判断以谁为准。
 *     措辞**不许暗示「厂商没认」**：名字在清单里，运行级结论就是 `installed`。
 */
function piSkillFaceAnnouncements(
  requestSkills: readonly { name: string; location: string }[],
  materialized: readonly string[],
  skills: PiSkills,
): AgentEventDraft[] {
  const drafts: AgentEventDraft[] = [];
  const inPrompt = new Set(requestSkills.map((skill) => skill.name));
  const absent = materialized.filter((name) => !inPrompt.has(name));
  if (absent.length > 0) {
    drafts.push(logDraft(
      'stderr',
      `[WARN] 本轮请求的系统提示词里没有出现这些技能：${absent.join('、')}`
        + '（名字逐条比对技能段；装载档判「厂商清单里有没有」是另一条判据）',
    ));
  }
  for (const collision of skillCollisions(skills)) {
    drafts.push(logDraft(
      'stderr',
      `[WARN] 技能「${collision.name}」同名冲突：厂商装载的是 ${collision.winnerPath}，`
        + `${collision.loserPath} 那一份被顶掉。这一条仍按厂商清单判「已装上」（名字在清单里），`
        + '结论不受影响。',
    ));
  }
  return drafts;
}

/** 装载诊断里的同名冲突（厂商的 `ResourceDiagnostic`：`collision` 那一格两端的路径都给了） */
function skillCollisions(skills: PiSkills): Array<{ name: string; winnerPath: string; loserPath: string }> {
  const collisions: Array<{ name: string; winnerPath: string; loserPath: string }> = [];
  for (const diagnostic of skills.diagnostics) {
    const record = asRecord(diagnostic);
    if (record?.['type'] !== 'collision') continue;
    const collision = asRecord(record['collision']);
    const name = collision?.['name'];
    const winnerPath = collision?.['winnerPath'];
    const loserPath = collision?.['loserPath'];
    if (typeof name !== 'string' || typeof winnerPath !== 'string' || typeof loserPath !== 'string') continue;
    collisions.push({ name, winnerPath, loserPath });
  }
  return collisions;
}

/**
 * 厂商清单 → `vendor-system.skills`：名字照抄、落点照抄、来源分档由 `classifySkillOrigin` 判。
 *
 * `source` 给的是厂商原值（`sourceInfo.scope`：`user` / `project` / `temporary`）——**不翻译**：
 * 那一格是证据，翻成我们的词表就是第二个真源（与另三家同一条口径）。
 * 分档判的是**落点**：本次运行物化的那几条在 `configHome` 之下 ⇒ 本机启用项；被测仓库自带的在 `cwd`
 * 之下 ⇒ 被测仓库自带（环境抽屉那句安全提示由此自动生效，不另造说明位）。
 */
function vendorSkillsOf(skills: PiSkills, layout: { configHome: string; cwd: string }): VendorSkill[] {
  return skills.skills.map((skill) => {
    const source = skill.sourceInfo?.scope ?? null;
    return {
      name: skill.name,
      source,
      path: skill.filePath,
      // `resolveRealPath` 由这一侧注入：契约是同构包，不许自己引 `node:fs`（界面也读它的标签表）
      origin: classifySkillOrigin({ source, path: skill.filePath, ...layout, resolveRealPath: realpathSync }),
    };
  });
}

/** 未识别形状的窄化（`diagnostics` 在 SDK 类型里是不透明的，逐格取用前先收窄） */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 一次运行的装配（顺序是硬要求，别重排）：
 * `mkdir` → 物化 skills → 建 `DefaultResourceLoader` → `reload({ resolveProjectTrust })`
 * → 建 `ModelRuntime` 并注册本次运行的 provider → `createAgentSession` → `bindExtensions({ mode: 'rpc' })`。
 *
 * 两个「写晚了照样跑完、只是静默少东西」的时刻，都由**用例**钉住：
 *   · 技能物化必须早于 `reload`（技能表在那一刻扫出来）；
 *   · provider 注册必须早于 `createAgentSession`（会话按 provider id 解析模型）。
 *
 * 为什么 `resolveProjectTrust` 显式给 `true`：与另三家同口径——**被测仓库自带的 skills / settings
 * 是被测内容的一部分**（用户口径「不压制、如实呈现」）。不显式给时走的是 SDK 的内建探测，
 * 而那个默认值将来变了我们不会知道；写死它，这一格就只由本文件决定。
 */
async function startPi(context: TurnContext): Promise<TurnStart> {
  const { input } = context;
  const sdk = await loadPiSdk();
  const ai = await loadPiAi();

  /**
   * ① `configHome` 由本层自己建：契约只说「本次运行有一个自己的配置目录」，**没保证它一定存在**
   * （生产路径上编排层会建，但那是它的实现细节）。不建的表现是 `ENOENT: open '…/.agenthome/…'`，
   * 归因成一个离真因很远的失败。
   */
  mkdirSync(input.configHome, { recursive: true });
  const candidateSkillsDir = candidateSkillsPath(input.configHome);

  /**
   * ② 本次运行的技能装入：整目录复制进 `<configHome>/skills/<名称>`。
   *
   * **物化必须发生在建装载器之前**：技能表是 `reload()` 那一刻扫出来的，写晚了本次运行照样跑完，
   * 只是**没有任何技能、也没有任何报错**。不传 `skills` ⇒ 一次都不调（连目录都不建）：
   * 评分与用例同步两处不该有技能面，而「不传」是这条口径唯一的表达方式。
   * 落不下去时物化函数**抛**（点名哪一条），由骨架归成 `AGENT_SKILLS_UNAVAILABLE`、本次运行失败。
   */
  if (input.skills !== undefined) {
    materializeSkills({ configHome: input.configHome, skills: input.skills });
  }

  /**
   * ②-b **MCP 的注入集**（canonical 条目 → 厂商条目）与观察者。
   *
   * 两个「什么时候做」的判据：
   *   · 条目的翻译在**建装载器之前**完成——扩展工厂是装载器的构造选项，装晚了本次运行照样跑完，
   *     只是一台 MCP 都没有、也没有任何报错；
   *   · `input.mcpServers === undefined` ⇒ **不装 MCP 扩展**（与「不传 `skills` 就不物化」同一条口径）：
   *     编排层只在注入集非空时才带这一格，于是「本次运行没有 MCP」这件事在装配面上也看得出来。
   *
   * 被我们摘掉的条目**必须说出来**：静默摘掉的表现是「我配的那台怎么没注入」，而线索
   * （哪一条、哪一格）只存在于这一刻。同一个原因串还会随 `loadConfig` 进厂商的启动报告。
   */
  const mcpPlan = toPiMcpServers(input.mcpServers ?? {});
  for (const item of mcpPlan.dropped) {
    logger.warn('MCP 条目未注入：形状或占位在我们这一层就没过（行照跑）', {
      configHome: input.configHome,
      name: item.name,
      reason: item.reason,
    });
  }
  /**
   * 被摘掉的条目**必须在产物里看得见**，不能只活在服务端进程日志里。
   *
   * 为什么：这一层是**契约之后的第二道闸**（手改配置 / 将来的新调用点），而编排层的注入集里
   * 这一台仍算 `injectable` ⇒ 运行级观测格在 `vendor-tool-table` 通道上把「工具表里没有它」
   * 读成**失败**（`AGENT_MCP_UNAVAILABLE`，文案是「未能启动」）——它根本没起过。
   * 事件里那一条 `log` 是这条链上**唯一**说得出真因的地方（厂商的启动报告走 `ctx.ui.notify`，
   * 而 SDK 装配下那是 no-op，见 `createPiMcpLoadConfig` 的注释）。落到 stdout 而不是 stderr：
   * 它是「本次运行的环境里有一台没进去」的事实陈述，不是错误输出。
   */
  const mcpDropDrafts: AgentEventDraft[] = mcpPlan.dropped.map((item) => logDraft(
    'stdout',
    `[WARN] MCP 条目「${item.name}」未注入（行照跑）：${item.reason}`
      + '。这一台在厂商侧不会出现工具，故运行级观测格里它记「未验证」而不是「起不来」——'
      + '要让它生效请按上面这条原因改配置。',
  ));
  /** 请求侧观察者：两份 L3 判据的唯一取证点（见 `observer.ts`） */
  const observer = createPiObserver();
  /**
   * **结构化输出的装配期裁定**（原生通道 / 降级档，两格互斥）。
   *
   * 为什么必须在装配期定：pi 的 `strict: 'require'` 拿不到 strict 时**抛在建请求那一刻**，表现为
   * 零出站请求 + `stopReason: 'error'` 的 43 毫秒收场（`prompt()` 还不 reject）——从界面上看就是
   * 「本次运行莫名其妙失败了」，与真因离得很远。预检把这件事提前成一次可判的裁定；判不过时**由我们
   * 显式降级**（工具改声明成 `'prefer'` + 填充层 + 修正轮兜底，记 `false` + 一条 WARN），
   * 而不是让厂商炸。降级档的工具照旧出站，只是那一档的 schema 没有厂商侧强制。
   *
   * **不收窄 schema**：降级时那份原样的 schema 进工具参数、提示词与修正轮——四家拿到的题目必须逐字相同。
   */
  const structured = adoptStructuredOutput(input.outputSchema, input.route.protocolType);
  /**
   * 投影记账：`applied.structuredOutput` 的唯一依据（见 `structuredOutputApplied`）。
   * `enforced` 那一维由采纳档位定死——降级档的工具调用**不算**走了原生通道。
   */
  const structuredProjection = createStructuredOutputProjection(structured.tool?.strict === 'require');
  /**
   * 结构化输出那一件自定义工具（要了 schema 就装；原生档与降级档各带各的强度）。
   *
   * 三条口径写在 `structured-output.ts` 的文件头，这里落实的是最要紧的那条：
   * **`parameters` 就是调用方原 schema 本身**（同一个引用，未经任何改写、也没有预先算成 strict 形态）。
   * pi 自己会在建请求时把它交给 `makeStrictJsonSchema`，而那个函数**非幂等**——预先归一化过的
   * schema 再喂一次会被它自己拒（零出站请求）；降级档那条路连转换都不做，原样出站。
   *
   * `execute` 是「只记账、不干活」：把这次的参数交给投影（`project` 那一侧写最终答复），
   * 回一条给模型看的确认文本，并置 `terminate` 让当前 agent 循环在参数落盘后收尾。
   * 它**不是**调用方要的工具调用（`toolCallSummary` 里看不出它），故不进任何工具面统计。
   */
  const structuredTools: PiCustomTool[] = structured.tool === null ? [] : [{
    name: PI_STRUCTURED_OUTPUT_TOOL,
    label: '提交结果',
    description: PI_STRUCTURED_OUTPUT_DESCRIPTION,
    parameters: structured.tool.parameters,
    constrainedSampling: { type: 'json_schema', strict: structured.tool.strict },
    execute: async () => ({
      content: [{ type: 'text', text: '已收到最终结果。' }],
      details: { accepted: true },
      terminate: true,
    }),
  }];
  if (structured.preflightReason !== null) {
    /**
     * 降级必须点名，而且**必须说清这一档到底交付了什么**——三种形态的兜底强度不一样，
     * 合成一句「按填充层交付」会在其中两种上说假话（读数：字符串 schema 那一路
     * `toolDeclared=false` + `fallbackDeclared=false`，一个字都没交付，却打着「按提示词级交付」）：
     *   · 工具 + 填充层都在 ⇒ 形状由提示词级保证，原生通道没有；
     *   · 只有工具（`renderable` 不是 JSON 对象 ⇒ 填充层没有可渲染的 schema）⇒ 更弱；
     *   · 两者都没有 ⇒ 只剩骨架的修正轮。
     */
    const toolDeclared = structuredTools.length > 0;
    const fallbackDeclared = structured.fallback !== null;
    const delivery = toolDeclared && fallbackDeclared
      ? '工具通道与填充层都在，但形状没有厂商侧强制'
      : toolDeclared
        ? '只声明了工具通道（这一份 schema 渲染不出填充层），形状没有厂商侧强制'
        : '工具通道与填充层都没有交付，只剩骨架的修正轮兜底';
    logger.warn(`这份 JSON Schema 落不到 pi 的 strict 子集里：${delivery}（本轮上报 false）`, {
      protocolType: input.route.protocolType,
      reason: structured.preflightReason,
      toolDeclared,
      fallbackDeclared,
    });
  }
  /**
   * **提问那一件宿主工具**（`ask_user_question`）：两个条件同时成立才造得出来。
   *
   *   · 有应答面（`input.onAskUser` 传了）——没有应答面时`ask` 一定回「无人应答」，
   *     把工具装上去只会让模型对着一个永远问不出结果的出口打转。不传 ⇒ 这个数组是空的，
   *     会话选项因此**逐字不变**（零回归判据）；
   *   · **全权限档**：提问是「往运行外面要一次人工输入」，而只读档的整个意义是不接触外部状态
   *     （它的工具面里连 `bash` 都不给）⇒ 只读档不装这一件。应答面存在与否不改变这条裁定。
   *
   * `ask` 直接把骨架的提问端口接上去：等待语义（本次运行终止 / 预算 / 静止超时豁免 / 回调抛错）
   * 全在端口那一层，这里只补厂商没有的那两格——`vendorBudgetMs` 恒 `null`（pi 没有厂商预算），
   * `subagentId` 恒 `null`（这一件只装在主会话上，见 `subagents.ts` 的子会话语境）。
   */
  const askUserTools = buildPiAskUserTools(
    input.onAskUser === undefined || input.permission !== 'full'
      ? null
      : async (params: PiAskUserParams, callId: string) =>
        context.askUser.ask({
          questions: params.questions,
          toolName: PI_ASK_USER_TOOL,
          callId,
          vendorBudgetMs: null,
          subagentId: null,
        }),
  );
  /**
   * 交给 `createAgentSession({ tools })` 的名单。**三件自定义工具都必须是成员**：`tools` 是成员
   * 匹配器，名单外的工具连声明都不会发出去（`_isAllowedTool` 在注册那一步就把它删掉），
   * 症状是「装配了工具但模型看不到」，一个字都不报。
   */
  const sessionTools = [
    ...PI_PERMISSION_OPTIONS[input.permission].tools,
    /**
     * `mcp__*` 通配**只进全权限档**。为什么不能两档都给：MCP 服务器的工具名由服务器自己定，
     * 通配符是唯一能把它们放进闭集名单的写法，于是**只读档给出通配就等于把「服务器自带写工具」
     * 一并授权**——真机读数：read-only 出站表里出现 `mcp__ws__write_file`，模型调它**真写成功**
     * （`interaction/report.md` 的 P1）。而这一档的整个意义是不接触外部状态（连 `bash` 都不给，
     * 提问工具也不装）。产品路径今天不组合这两者（MCP 只在本次运行执行阶段注入，那一档是全权限），
     * 所以这条改动对现时产物零影响；将来若真有「只读 + MCP」的调用点，它会以
     * `AGENT_MCP_UNAVAILABLE`（注入的服务器没进工具表）**响着失败**，而不是静默给出写能力。
     */
    ...(input.permission === 'full' ? [PI_MCP_TOOL_PATTERN] : []),
    ...structuredTools.map((tool) => tool.name),
    ...askUserTools.map((tool) => tool.name),
  ];
  /** 自定义工具合并成一份：`customTools` 只有一格，两件工具共用它 */
  const customTools = [...structuredTools, ...askUserTools];
  /**
   * 首轮提示词：走原生通道时**一个字都不加**（那份 schema 由工具声明本身传达，再在提示词里复述一遍
   * 就是第二份可能与它漂移的副本）；降级时追加骨架的约束段（与 dsh 的填充层同一份原料）。
   */
  const initialPrompt = structured.fallback === null ? input.prompt : `${input.prompt}\n${structured.fallback.instruction}`;
  /**
   * **子智能体收数器**：扩展生命周期事件（`pi.events` 的 `subagents:*`）的唯一取证点。
   *
   * 与观察者同一条处置——回调只记不改（见 `subagents.ts`）；`providerId` 那一侧每个本次运行唯一，
   * 这一条同样每个本次运行一份（总线本身也是每个本次运行一个装载器各自 `createEventBus()`）。
   * 钩子把「开始 / 终态」扇给 wire 通道（订阅启停），收数器仍是总线的唯一监听者。
   */
  const subagentWire = createPiSubagentWire();
  const subagentRecorder = createPiSubagentRecorder({
    onStarted: (agentId) => subagentWire.onStarted(agentId),
    onSettled: (agentId) => subagentWire.onSettled(agentId),
  });
  /**
   * 扩展入口的绝对路径。**在这里解析而不是在装载器参数里现取**：解析失败要**点名**本次运行装不上
   * （「声明挂了子智能体、实际没装」是假声明），而那是一个与厂商 SDK 无关的、当场可判的失败。
   */
  const subagentsExtensionPath = piSubagentsExtensionPath();
  /** 本次运行的 wire：模型投射、观察者的判据读法、L3 取证三处共用同一份（只算一次） */
  const wire = wireForProtocol(input.route.protocolType);
  const extensionFactories: unknown[] = [observer.factory, subagentRecorder.factory];
  if (input.mcpServers !== undefined) {
    // MCP 那一格只有配了 MCP 的行走（缺了它不该让不配 MCP 的本次运行失败），故校验落在使用点
    assertPiMcpExtension(sdk);
    extensionFactories.push(sdk.createMcpExtension({
      loadConfig: createPiMcpLoadConfig(mcpPlan),
      startupWaitMs: PI_MCP_STARTUP_WAIT_MS,
    }));
  }

  /**
   * ③ 资源装载器。四格隔离各有理由（见 `PiLoaderOptions`）：
   *   · `additionalSkillPaths` 给**绝对路径**；
   *   · `skillsOverride` 留白名单 ∪ 项目技能、丢掉 HOME 锚定的发现结果；
   *   · `noExtensions: true` 挡住被测仓库 `.pi/extensions/*.ts` 的任意代码执行；
   *   · `additionalExtensionPaths` **白名单子智能体扩展**（这一家唯一的派发能力来源）。
   * **刻意不设** `noContextFiles`（缺省 `false` 才读得到被测仓库的 `AGENTS.md`，与另三家对齐）
   * 与 `noSkills`（会把项目技能一起关掉）。
   *
   * ⚠️ `noExtensions` 与 `additionalExtensionPaths` **不冲突**：前者只筛「发现来的」路径
   * （被测仓库与宿主的 `.pi/extensions/`），后者是我们显式交出去的那几条。实测两者同时在时，
   * 扩展表里正是「我们那一条 + 内联工厂」，且 `foreignExtensions` 断言为零。
   */
  const createLoader = (): PiResourceLoader => new sdk.DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.configHome,
    additionalSkillPaths: [candidateSkillsDir],
    noExtensions: true,
    additionalExtensionPaths: [subagentsExtensionPath],
    extensionFactories,
    skillsOverride: (base) => keepCandidateAndProjectSkills(base, { candidateSkillsDir, cwd: input.cwd }),
    settingsManager: sdk.SettingsManager.inMemory(),
  });
  let loader = createLoader();

  /**
   * ④ `reload` 必须在建会话之前：技能表与扩展表在这一步才成形。
   *
   * reload 走 wire 通道的互斥壳（`subagentWire.reload`）：扩展工厂在 reload 里执行、
   * 也是它挂 manager 注册表的地方——壳保证「reload + 快照 + 删槽」跨行串行，
   * 并发两行时各自的 manager 各归各行（机制见 `subagent-wire.ts` 的文件头）。
   */
  await subagentWire.reload(() => loader.reload({ resolveProjectTrust: async () => true }));

  /**
   * ⑤ 运行期断言：`noExtensions: true` 之下**发现来的扩展必须是 0**。
   *
   * 为什么要有这一条：`noExtensions` 只筛「发现路径」——这是它对我们**有利**的一面（工厂与白名单
   * 不受它管），也是它**唯一**的一面。一旦它对某个版本失效，被测仓库里的扩展就会带着任意代码执行
   * 进来，而装配面上不会出现任何异常。判据取「扩展表里的每一条都来自我们」：
   * 我们装进来的那些路径是合成的 `<inline:…>` 或运行配置目录里的文件，其余一律算发现来的。
   *
   * 兜底是**丢掉这一份装载器、按不信任项目重建一份**（代价：同时失去项目技能，可比性降级），
   * 而不是把信任开关改回去重载——`noExtensions` 失效时正是「装载即执行」，要在**装载之前**
   * 就把项目挡在外面。⛔ **不要用 `extensionsOverride` 当兜底**：它在扩展装载**之后**才应用，
   * 那时代码已经跑过了。
   */
  const foreign = foreignExtensions(loader, input.configHome, [subagentsExtensionPath]);
  if (foreign.length > 0) {
    logger.error('pi 的 noExtensions 未挡住发现来的扩展：改按不信任项目重建装载器（本次运行将失去项目技能）', {
      configHome: input.configHome,
      extensions: foreign,
    });
    loader = createLoader();
    // 兜底重建的这一次 reload 同样执行工厂（claim 点），必须走同一把互斥壳；
    // 后一次快照覆盖前一次——前一份 manager 随被丢弃的装载器一起死掉
    await subagentWire.reload(() => loader.reload({ resolveProjectTrust: async () => false }));
    const stillForeign = foreignExtensions(loader, input.configHome, [subagentsExtensionPath]);
    if (stillForeign.length > 0) {
      throw new Error(
        `[agents] pi 的扩展隔离失败：仍装载了 ${stillForeign.join('、')}——`
          + '本次运行拒绝在被测仓库能执行任意代码的前提下运行。',
      );
    }
  }

  /**
   * ⑤-b **厂商侧事实的取数器**（`vendor-system`）：工厂在这儿建、**调用发生在投影里**——
   * 厂商的扩展回调不在骨架的 try/catch 里，一次抛错就能带走整行（见 `observer.ts` 的口径）。
   * 技能面读的是**装载器**那一份（`getSkills()` 是厂商侧权威面），不是 payload 里的技能段。
   * 建在兜底之后：万一装载器被重建过，这里读到的就是最终生效的那一份。
   */
  const readVendorFacts = createPiVendorFactsReader({
    observer,
    wire,
    readSkills: () => loader.getSkills(),
    layout: { configHome: input.configHome, cwd: input.cwd },
    materialized: (input.skills ?? []).map((skill) => skill.name),
  });

  /**
   * ⑤-c **装载断言：子智能体扩展必须真的在扩展表里**。
   *
   * 为什么必须断言而不是「装不上就算了」：能力位声明的是 `subagent: yes`——
   * 声明与事实分家的两种表现（扩展没装上、路径被 `noExtensions` 顺手挡掉）**都不会抛错**，
   * 只是本次运行悄悄没有派发工具，而界面上「这家支持子智能体」照样写着 `yes`。
   * 判据取**扩展表里的路径**（`loader.getExtensions()` 是 SDK 的权威面），失败时点名包名与版本，
   * 归因走 `AGENT_LOAD_FAILED`——「声明支持却加载不上」不是厂商运行期错误，
   * 与「包没装 / 入口解析不出来」（`piSubagentsExtensionPath` 那一处）同一码。
   *
   * 装载器被兜底重建过时这里读的是最终生效的那一份——断言因此放在兜底**之后**。
   */
  const mounted = loader.getExtensions().extensions.some((extension) => extension.path === subagentsExtensionPath);
  if (!mounted) {
    // 装载器把失败记成 `{ path, error }`（形状是不透明的 unknown，逐格取用前先收窄）
    const failure = loader
      .getExtensions()
      .errors.map((entry) => asRecord(entry))
      .find((entry) => entry?.['path'] === subagentsExtensionPath);
    const reason = failure?.['error'];
    const version = piSubagentsVersion(subagentsExtensionPath);
    throw new AgentLoadError(
      PI_SUBAGENTS_PACKAGE,
      new Error(
        `入口 ${subagentsExtensionPath} 没有进扩展表`
          + `${version === null ? '' : `（${PI_SUBAGENTS_PACKAGE}@${version}）`}`
          + `${reason === undefined ? '' : `；装载器报：${String(reason)}`}。`
          + '本次运行拒绝在没有派发能力的前提下声称支持子智能体。',
      ),
    );
  }

  /**
   * ⑤-d **wire 通道的快照落空要点名**：扩展已确认在表里（上面的断言），它的工厂就一定
   * 执行过、也就一定 claim 过注册表——此刻快照还是空的只可能是互斥缝隙或厂商改了挂载行为，
   * 属于「应该到而没到」的异常。落 WARN 而不是失败：子任务正文退回转写文件通道，
   * 结论与子任务行一个字都不受影响（降级姿态见 `subagent-wire.ts` 的文件头）。
   */
  if (!subagentWire.available) {
    logger.warn('pi 的子智能体 wire 通道快照落空：子任务正文退回转写文件通道（补录角标）', {
      configHome: input.configHome,
    });
  }

  /**
   * ⑤ 凭据通道**只有一条：内存**。`InMemoryCredentialStore` + `modelsPath: null`
   * 绕开默认的 `DefaultAuthStorage`（它**读一下**就建出 2 字节空壳 `auth.json`）与 `models.json`。
   * provider 逐行自注册，id 由 `configHome` 派生（并发隔离见 `piProviderId`）。
   */
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const providerId = piProviderId(input.configHome);
  const baseUrl = baseUrlForWire(input.route.baseUrl, input.route.protocolType);
  /**
   * 自定义请求头（设置页那一张卡）：pi-ai 的 provider 级 `headers` 是唯一落点，它随每一次请求发送。
   * 空集 / 缺省 ⇒ **不写这个键**（与 `mcpServers` / `effort` 同一条口径：给了空表等于向厂商声明
   * 「这个 provider 显式零条头」），可发送性闸与另三家共用 `sendableRequestHeaders`。
   */
  const providerHeaders = sendableRequestHeaders(input.requestHeaders);
  const provider: PiProviderConfig = {
    name: 'AIEval Gateway',
    baseUrl,
    api: wire,
    models: [providerModel(input, wire, baseUrl)],
    ...(providerHeaders === undefined ? {} : { headers: providerHeaders }),
  };
  runtime.registerProvider(providerId, provider);
  // 密钥只进运行时的内存覆盖层：不落盘、不进 env、不经 `${ENV}` 插值
  await runtime.setRuntimeApiKey(providerId, input.route.apiKey);
  const model = runtime.getModel(providerId, input.route.modelId);

  /**
   * ⑥ **会话落盘**：管理器是文件型的，落点显式钉在运行配置目录里；续接时打开会话文件。
   *
   * 三条都是硬要求（各自的失败形态都不报错、只是行为悄悄不对）：
   *   · **文件型而不是内存型**：内存型跑完盘上什么都没有，续接（本仓声明 `resume: yes`）无从谈起；
   *   · **`sessionDir` 显式给**：厂商默认落点是 `agentDir` × `cwd` **两轴**的函数，而工作区会被重建
   *     ⇒ 不给这一格，「本次运行的会话落在哪」就成了算不出来的东西；
   *   · **续接用 `open(会话文件)` 不用 `continueRecent`**：后者取目录里 mtime 最新的一条，
   *     而运行内重跑会在同一目录里留下上一次尝试的会话 ⇒ 接回来的是**上一次尝试**的上下文。
   *
   * 设置仍然全走内存（`SettingsManager.inMemory`）：它不含任何要跨进程带走的东西。
   */
  /**
   * 域外档位**点名**：`piThinkingLevel` 会把它换成缺省档（厂商自己会静默夹到另一档，见那个函数的
   * 注释），这里把「收到了什么、用了什么」写成一句可搜的话——没有这一句，一次批量入口传错档名
   * 只会表现为「本次运行好像比预期慢 / 好像没思考」，没有任何线索指向入参。
   */
  if (input.effort !== undefined && !PI_REASONING_EFFORTS.includes(input.effort)) {
    logger.warn('pi 收到域外的思考档位：本家收不了它，改用缺省档（厂商会静默夹到另一档，故不能沉默）', {
      effort: input.effort,
      fallback: PI_DEFAULT_EFFORT,
      domain: PI_REASONING_EFFORTS,
    });
  }
  const { session } = await sdk.createAgentSession({
    cwd: input.cwd,
    agentDir: input.configHome,
    modelRuntime: runtime,
    model,
    // 本仓档位落到会话上（换算规则、域外值与地雷见 `piThinkingLevel`）
    thinkingLevel: piThinkingLevel(input.effort),
    settingsManager: sdk.SettingsManager.inMemory({
      // 关掉 pi 自带重试：连接类失败默认重试 3 次会把墙钟放大到十几秒，
      // 而重试语义在编排层（本层不重复实现）
      retry: { enabled: false },
    }),
    resourceLoader: loader,
    sessionManager: openPiSessionManager(sdk, input),
    // 档位名单是**闭集**：名单外的工具这一轮不被声明（只读档的 `bash` / `edit` / `write` 由此可证不在）。
    // MCP 工具的名字连接之后才知道，故补一格 `mcp__*` 通配——它是成员而不是修饰符，
    // 名单因此仍然是闭集（修饰符形态会把白名单整个丢掉，见 `PI_MCP_TOOL_PATTERN`）。
    // 两件自定义工具（结构化输出、提问）也必须是成员，见 `sessionTools` 的注释。
    tools: sessionTools,
    ...(customTools.length === 0 ? {} : { customTools }),
  });

  // 会话面形状断言：实例格只有真建出会话才看得到（改名时续接能力会静默消失，见 `assertPiSessionShape`）
  assertPiSessionShape(session);

  /**
   * 释放入口**在扩展绑定点之前**建好。`bindExtensions` 会执行扩展工厂并投 `session_start`，它抛错时
   * 骨架手里的 `started` 还是 `undefined` ⇒ 骨架那一条释放兜底落空（真机读数：`dispose` / `abort` /
   * `waitForIdle` / `session_shutdown` / provider 注销**全 0**），而 MCP 的 stdio 子进程清理挂在
   * `session_shutdown` 上 ⇒ 那一档会留下一个连不上也关不掉的子进程。故这一段自己兜：先按同一条
   * 释放链收干净，再把错误抛给骨架归因。
   */
  const dispose = createSessionDisposer(session);

  /**
   * ⑦ 扩展装配收尾：`mode` **必须写死 `'rpc'`**（缺省 `'print'` 会让按 rpc 写的扩展判定配置错误）。
   * 本次运行装了三样扩展（观察者、子智能体收数器、可选的 MCP），`bindExtensions` 是它们的绑定点；
   * 厂商把扩展工厂的执行点放在 `loader.reload()`（见 `subagent-wire.ts` 的文件头），两步都不能省。
   */
  try {
    await session.bindExtensions({
      mode: 'rpc',
      onError: (error) => {
        // 扩展自身的失败不改变本次运行的结论（与另三家的扩展错误同一条处置），但必须留痕
        logger.warn('pi 扩展报错（不改变本次运行的结论）', { configHome: input.configHome, error });
      },
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  /** 本次运行的投影状态：记录「有没有被要求停、是不是用户点的」（结论由骨架按停止来源给） */
  const runState = createPiRunState();
  /**
   * 合成帧入口的**转交**：包一层而不是把方法摘下来传——wire 的实现今天是闭包对象
   * （不用 `this`），但「摘方法传出去」在本家已经坑过一次（子会话 `subscribe` 丢 `this`
   * ⇒ 该身份静默退回转写通道），这一层不留同形的隐患。
   */
  const attachWirePump: PiSubagentWire['attachPump'] = (push) => subagentWire.attachPump(push);
  /** 骨架逐条传给 `project` 的那一份状态（收尾要用它的累计读数，见 `project` 里的注释） */
  let latestState: TurnState | null = null;
  /** 被摘掉的 MCP 条目只播一次（挂在第一条投影上，见 `projectCandidate` 里那一段） */
  let mcpDropsAnnounced = false;
  /** 结构化输出的预算中止只发一次（同一本次运行里可能连着好几条收尾帧） */
  let structuredBudgetAborted = false;
  /**
   * 子智能体转写的读取口：跑动期增量与收尾补差量**共用同一份**——路径的两格
   * （`cwd` 与 `sessionId`）都来自本次运行的装配，两处各写一遍会在其中一侧漂移。
   */
  const readTranscript = (agentId: string): PiSubagentTranscript =>
    readPiSubagentTranscript({ cwd: input.cwd, sessionId: session.sessionId, agentId });

  logger.debug('pi 已装配本次运行的运行时与会话', {
    model: input.route.modelId,
    provider: providerId,
    api: wire,
    baseUrl,
    permission: input.permission,
    tools: sessionTools,
    skills: loader.getSkills().skills.length,
    extensions: loader.getExtensions().extensions.length,
    // 会话身份与落点**两格都记**：身份是转写目录的键（子智能体那一路要用），落点是续接的键。
    // 真机排障时这两个都要能一眼看到，尤其是「续接到了哪一条」——那一格只有路径说了算。
    sessionId: session.sessionId,
    sessionFile: session.sessionFile ?? null,
  });

  /**
   * **中途终止**：走 SDK 的 `abort()`（毫秒级终结在途轮次）。这里刻意**不 await**：
   * `interrupt` 是同步契约，等待由释放路径的 `waitForIdle()` 负责。
   *
   * 停止请求先记一笔再发信号：`agent_settled.aborted` 分不出「用户点的」与「看门狗 / 宿主停机停的」，
   * 而 `input.signal` 有没有翻转是适配器这一层唯一的判据（见 `PiRunState`）。
   *
   * **整 run 一份**：所有活动区间（首轮与每一次追问）共用它——同一个 `session`、同一个停止来源。
   */
  const interruptCandidate = (): void => {
    notePiStopRequest(runState, input.signal.aborted);
    void session.abort().catch((error: unknown) => {
      logger.warn('pi 的中止信号失败（释放路径仍会兜底）', { error });
    });
  };
  /**
   * **整 run 一次的释放**：所有活动区间共用同一份。
   *
   * 为什么不能只挂在首轮那一格：骨架的释放闭包读的是**当时**的活动区间（`turn.ts` 的
   * `handle?.dispose()`，而 `handle` 每消费一个区间就被换成新的那个）⇒ 追问区间若交一个
   * 空操作，首轮那个闭包就再也没有调用点（`session.dispose()` / `waitForIdle()` /
   * `subagentWire.dispose()` / `unregisterProvider()` 全部跳过）。`createDisposer` 保证
   * 「恰好一次」绑定在被关闭的对象上，所以共用一份不会重复释放。
   */
  const disposeCandidate = async (): Promise<void> => {
    // wire 通道先关：它的子会话订阅在骨架的收尾路径之外，越早退订越不占厂商资源
    subagentWire.dispose();
    await dispose();
    /**
     * run 结束**注销本次运行的 provider**：`ModelRuntime` 是每次运行新造的，本可以随它一起被回收，
     * 但显式注销让「本次运行的注册在 run 的边界内」成为一条可断言的事实
     * （守卫：并发用例里两行各自只看得见自己的 provider）。
     */
    runtime.unregisterProvider(providerId);
  };
  /**
   * **一次活动区间**（首轮与每一次追问逐字同形）：同一个 `session`、同一个运行时、同一份
   * 释放与停止入口。
   *
   * `continue` 必须**继续暴露**：骨架的修正循环每一轮都读**当前**区间的 `continue`
   * （`turn.ts` 的 `askAgain = handle?.continue`）⇒ 追问区间不给自己这一格的话，修正预算会
   * 从 2 轮静默缩到 1 轮，而日志里写的是「该适配器不支持同会话修正」——与事实相反。
   * 交给骨架的是**一条新的用户消息**（`prompt()`），不是 SDK 内部的 `agent.continue()`：
   * 修正轮要带上问题清单与 schema 原文，而且 `continue()` 在「上一条是助手消息」时会抛
   * （`Cannot continue from message role: assistant`）——首轮以正文收尾时正是那个形状。
   */
  const activityInterval = (run: () => Promise<void>): TurnStart => ({
    stream: sessionEventStream(session, run, attachWirePump),
    interrupt: interruptCandidate,
    dispose: disposeCandidate,
    continue: async (prompt) => activityInterval(() => session.prompt(prompt)),
    project: (raw, state) => projectCandidate(raw, state),
  });

  return {
    // 首轮活动区间：与每一个追问区间同一条构造路径（少一处会漂移的复制）
    ...activityInterval(() => session.prompt(initialPrompt)),
    /**
     * 事件投影（归一、计量、失败与结束信号）住在 `events.ts`：本文件只把它接到骨架上。
     *
     * `vendor-system` 那一条**由这里追加**而不是塞进 `events.ts` 的判别链：它读的是
     * 「本次运行装配了什么」（观察者抓到的 payload、装载器的技能表），而那三样东西都在本闭包里，
     * 一条都不在投影函数拿得到的状态上。取数器自带去重（同一份事实只发一次）。
     */
    project: (raw, state) => projectCandidate(raw, state),
    /**
     * 收尾：子任务行的**终态快照**与那两格分量（子智能体的用量与终态只在扩展事件总线上到达，
     * 而它到达的时刻与父会话的事件流没有先后保证——见 `finalizePiSubagents`），
     * 外加本次运行的**通道事实**与**会话落点**。
     * 没有派发过子智能体时它原样返回空，一个字都不改。
     */
    finalize: () => ({
      ...(latestState === null
        ? { drafts: [] }
        : finalizePiSubagents(latestState, runState, subagentRecorder, readTranscript, subagentWire)),
      /**
       * **会话落点**：落的是**会话文件路径**，不是 `session.sessionId`。
       *
       * 文件名是 `<ISO 时间戳>_<会话 id>.jsonl`——时间戳不可预知 ⇒ 拿 id 拼不回路径，
       * 续接那一格就只能落路径（消费方原样把它交回 `resume.sessionId`，本层照它 `open`）。
       * 厂商没给路径（不落盘的会话）时如实不报：`null` 与缺席同义（骨架保持结果里那一格为 `null`），
       * 「这条会话没落盘」与「落了但我们没记」在消费侧都是「不能续接」。
       */
      sessionId: session.sessionFile ?? null,
      /**
       * 通道事实：**只有本轮答复确实来自被 strict 约束的工具参数**才为真。
       * 三格 `false` 的含义不同（降级 / 模型没调工具 / 之后改走正文），分档写在
       * `structuredOutputApplied` 的注释里；`tools` 那一件装没装不参与判定——
       * 「声明发出去了」不等于「输出受约束」。
       */
      applied: { structuredOutput: structuredOutputApplied(structuredProjection) },
    }),
  };

  /**
   * 一条活动区间的投影：骨架每来一条原始事件就调一次。
   *
   * `latestState` 那一手引用是收尾要的（`finalize` 的契约不带参数）；`structuredProjection` 只传给
   * 结构化输出那一件的采用点——它是「当前最终答复是谁产出的」的记账，别的分支不碰它。
   */
  function projectCandidate(raw: unknown, state: TurnState): TurnProjection {
    latestState = state;
    const projection = projectPiEvent(
      raw,
      state,
      { kind: 'pi', baseUrl: input.route.baseUrl },
      runState,
      subagentRecorder,
      structuredProjection,
      readTranscript,
      subagentWire,
    );
    /**
     * **越界参数的无界往返必须由这里掐住**：投影层交出 `failure` 只是记一笔，厂商的 agent loop
     * 不会因此停下（真机读数：15 秒 1337 次出站请求）。超出预算时主动 `abort()` 终结这一轮，
     * 并把停止来源记成「本层自己发起的」——`readAssistantFailure` 对 `aborted` 的处置会另给一条
     * 失败原因，不记这一笔的话它会盖掉投影层那条点名原因。
     */
    if (runState.structuredRejections > PI_STRUCTURED_REJECTION_BUDGET && !structuredBudgetAborted) {
      structuredBudgetAborted = true;
      runState.selfAborted = true;
      notePiStopRequest(runState, false);
      logger.warn('pi 的结构化输出参数连续被厂商拒：中止这一轮（避免无界的步数）', {
        rejections: runState.structuredRejections,
        budget: PI_STRUCTURED_REJECTION_BUDGET,
      });
      void session.abort().catch((error: unknown) => {
        logger.warn('pi 的结构化输出预算中止失败（释放路径仍会兜底）', { error });
      });
    }
    const facts = readVendorFacts();
    /**
     * 三条来源合成一批草稿：投影自己的、厂商事实取数器的、以及**装配期就定下的那几条**
     * （被我们摘掉的 MCP 条目）。
     *
     * 第三条为什么要走投影而不是在第一帧就发出去：骨架的产物只有「投影」与「收尾」两个出口
     * （`TurnStart.project` / `finalize`），装配期没有一个能发事件的通道。挂在**第一条投影**上
     * 是这两条路里最早的一个点，且它必然是本次运行跑起来之后——没有请求就没有「本次运行的环境是什么」
     * 可言（与 `readVendorFacts` 自己那条「先读到请求再播报」同一条判据）。
     * `mcpDropDrafts` 只在这里读一次、发一次（`mcpDropsAnnounced`）。
     */
    const drops = mcpDropsAnnounced ? [] : mcpDropDrafts;
    mcpDropsAnnounced = true;
    const extra = [...drops, ...facts];
    return extra.length === 0 ? projection : { ...projection, drafts: [...projection.drafts, ...extra] };
  }
}

/**
 * 会话事件流：把 `subscribe` 的回调折成 `AsyncIterable`，由一次提示词（或追问）的落定收尾。
 *
 * 为什么**先订阅再交提示词**：`prompt()` 一进去就开始产事件，订阅晚了会丢掉开头那批
 * （与 dsh 那条「先订阅再 run」的教训同形）。所以订阅在流的第一次迭代时就建立，
 * 提示词在订阅建立之后才发出。
 *
 * 为什么收的是**一个无参动作**而不是提示词字符串：首轮与追问是同形的两条活动区间，
 * 而它们要交的东西不同（一个是调用方的题面、一个是修正轮的问题清单）——收成动作之后这一层
 * 不必知道「这一次交的是什么」，订阅 / 排空 / 收尾这套逻辑因此只有一份。
 *
 * 收尾判据是「提示词落定 **且** 队列已排空」：它只在本次往返收尾时 resolve，
 * 而它 resolve 之后队列里可能还有最后几条事件（`agent_settled` 之类）——先排空再结束，
 * 否则尾部事件会静默消失。
 * ⚠️ pi 的 `prompt()` 对**运行期失败**（传输失败、被中止、自带超时）永不抛——那些只体现在
 * `stopReason` / `errorMessage` 上（见 `events.ts`）；但它在**起请求之前**会抛（凭据 / 模型 /
 * 压缩 / 已有在跑的轮次，厂商 `.d.ts` 的 `@throws` 一族）⇒ 那一路必须抛给骨架，见本函数里
 * `promptFailed` 那一段。
 *
 * `attachPump` 是**子会话正文的实时性那一格**：这条流除了厂商事件，还收 wire 通道按需塞进来的
 * 合成帧（取值 `PI_SUBAGENT_WIRE_TICK_TYPE`，`events.ts` 认出即空投影）。每条活动区间各接一份、
 * 收尾时摘掉——它与本条流的生命周期严格同寿，不接也只是回到「等父会话下一个事件」。
 */
function sessionEventStream(session: PiSession, run: () => Promise<void>, attachPump?: PiSubagentWire['attachPump']): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      let settled = false;
      /**
       * 提示词的**拒绝**（与「落定」是两件事）。
       *
       * 厂商的 `prompt()` 在**起请求之前**就会抛——没有可用凭据 / 模型未选 / 正在压缩 /
       * 已有在跑的轮次（厂商 `.d.ts` 的 `@throws` 一族）。把它与落定归成同一个信号的话，
       * 骨架的 catch 与归因层都看不到它：一次「凭据缺失」会被读成 `ok:true / completed /
       * finalText:null`，即「本次运行成功了、只是没说话」——最坏的一种误读。
       */
      let promptError: unknown = null;
      let promptFailed = false;
      const unsubscribe = session.subscribe((event) => {
        queue.push(event);
        wake?.();
      });
      /**
       * 子会话正文的**合成帧入口**：wire 缓冲进账时往这条流里塞一帧，换来一次投影
       * （也就是一次排空）。派发期父会话一个事件都不产，没有这一下那批正文要攒到
       * `Agent` 工具收尾才一次性涌出——机制与封顶写在 `subagent-wire.ts` 的文件头。
       *
       * 合成帧与厂商事件**同走一条队列**：顺序因此是到达序，`project` 也只有一个入口。
       * `settled` 之后不再入队——那一刻起只排队里剩的，塞进去的帧没人会取。
       */
      const detachPump = attachPump?.(() => {
        if (settled) return;
        queue.push({ type: PI_SUBAGENT_WIRE_TICK_TYPE });
        wake?.();
      });
      const note = (): void => {
        settled = true;
        wake?.();
      };
      // 提示词在订阅之后发出；它的落定是「不会再有新事件」的信号（不是失败信号）
      const prompted = run().then(note, (error: unknown) => {
        promptFailed = true;
        promptError = error;
        note();
      });
      try {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (settled) {
            /**
             * **剩的事件先交完，再把拒绝交给骨架**：投影已经落过的事件不该因为一次
             * 起请求前的失败而消失（「本次运行说过什么」与「这一次为什么没跑成」是两件事）。
             * 抛出去之后归 `runTurn` 的 catch 处置：外部要求停止 ⇒ canceled；否则
             * `classifyAgentFailure` 归成 `AGENT_*`。
             */
            if (promptFailed) throw promptError;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        unsubscribe();
        detachPump?.();
        await prompted;
      }
    },
  };
}

/**
 * 装载器里**不是我们装进来的**那些扩展（路径判据见 `startPi` 的断言注释）。
 *
 * 「我们装进来的」有三类，缺一类都会把自家扩展误判成发现来的：
 *   · 内联工厂（合成路径 `<inline:…>`）；
 *   · 落在运行配置目录下的文件（扩展自己写出来的那些）；
 *   · **显式白名单的那几条绝对路径**（`additionalExtensionPaths`——子智能体扩展住在本仓的
 *     `node_modules` 里，既不是内联也不在配置目录下）。
 * 漏了第三类的症状不是「漏检」而是**假红**：装载器被无谓地按不信任项目重建，随后那一条仍在表里
 * ⇒ 整行以「扩展隔离失败」收场（真机形态见 `providers/pi/index.test.ts` 的那条断言）。
 */
function foreignExtensions(loader: PiResourceLoader, configHome: string, allowedPaths: readonly string[]): string[] {
  return loader
    .getExtensions()
    .extensions.map((extension) => extension.path)
    .filter((path) => !path.startsWith('<inline:') && !isUnder(path, configHome) && !allowedPaths.includes(path));
}

/**
 * 本次运行的会话落点：`<configHome>/sessions`。
 *
 * 为什么显式钉在**运行配置目录**下而不是让厂商自己算：厂商默认落点是
 * `<agentDir>/sessions/--<编码后的 cwd>--`，也就是「家目录 × 工作区」两轴的函数。运行工作区会被
 * 重建（`retryCandidate` / 重新执行），配置目录也会随行变 ⇒ 靠默认值的话，「本次运行的会话落在哪」
 * 每次都得靠两条都会变的路径重新推导。钉在 `configHome` 下之后，**换行即换目录**，
 * 「按行隔离」这一条不需要第二个机制（真机探针验过：同一个 cwd 只换会话目录就已经隔开）。
 */
export function piSessionDir(configHome: string): string {
  return join(configHome, 'sessions');
}

/**
 * 这一轮用哪份会话管理器：**续接**打开指定的会话文件，否则在运行内落点开一条新的。
 *
 * 续接**必须用 `open` 而不是 `continueRecent`**：后者取目录里 mtime 最新的一条，而运行内重跑会在
 * 同一目录里留下上一次尝试的会话 ⇒ 接回来的是上一次尝试的上下文（用户以为在追问，模型答的是
 * 另一轮的题）。
 *
 * 打开之前**自己判文件在不在**：厂商的 `open(path)` 在文件不存在时**不抛**，它当场在同名路径上
 * 造一条新的 ⇒ 「会话没了」与「接上了」在调用点完全同形。这里的失败是**响**的（本次运行以中文原因
 * 收场）：用户明确要求接着上一轮跑，而产物已经不在了，静默开新会话正是本仓最不接受的那种
 * 「看起来一切正常」的错。
 */
function openPiSessionManager(sdk: PiSdkModule, input: AgentRunInput): unknown {
  const resume = input.resume;
  if (resume === undefined) return sdk.SessionManager.create(input.cwd, piSessionDir(input.configHome));
  if (!existsSync(resume.sessionId)) {
    throw new Error(
      `[agents] pi 的续接会话文件不存在：${resume.sessionId}——`
        + '本次运行的会话产物已被清理，无法把上一轮的上下文带回来；本层不静默开新会话',
    );
  }
  /**
   * **0 字节与「不存在」同档**：文件在场但一运行内容都没有（上次写到一半被中断、或被截断）时，
   * 厂商的 `open()` 照样成功——它开出来的是一条**没有历史的会话**，于是「用户以为在追问、
   * 模型什么都不记得」这件事在产物上长得与成功续接**逐字一样**（真机读数：`{ok:true,
   * requests:1}`、`sessionId` 就是同一个文件）。半截 JSON 会被厂商拒（`Session file is not a
   * valid pi session`），零行不会 ⇒ 判据必须落在这一层。
   */
  if (statSync(resume.sessionId).size === 0) {
    throw new Error(
      `[agents] pi 的续接会话文件是空的（0 字节）：${resume.sessionId}——`
        + '里面没有任何可以带回来的上下文，接上去只会是一条空白会话；本层不静默开新会话',
    );
  }
  return sdk.SessionManager.open(resume.sessionId);
}

export const piProvider: AgentProvider = {
  kind: 'pi',
  displayName: 'Pi Coding Agent',
  metadata: {
    /**
     * 两条 wire 都能收：`openai` → `openai-responses`（补 `/v1` + `/responses`）、
     * `anthropic` → `anthropic-messages`（剥尾 `/v1` + `/v1/messages`）。少声明一条会平白砍掉
     * 一半现有供应商条目的本次运行。
     */
    protocolTypes: ['openai', 'anthropic'],
    capability: {
      // 取消走 SDK 的 `abort()`，在途轮次毫秒级终结
      cancelMidTurn: true,
      // 用量取 `message_end.message.usage`（权威；`reasoning` 是 `output` 的子集，不双计）
      usage: true,
    },
    /**
     * 消息能力：**五格 `yes` + `subagent` 也 `yes`**。
     *
     * 判据分两处，都是「真拿得到」而不是「这家理论上支持」：
     *   · 思考正文 / 工具入参 / 工具结果 / 增量：`session.subscribe` 的事件里就有（故 `streamingDelta`
     *     的取数通道是 `wire`，不需要像 dsh 那样挂插件旁路）；
     *   · 子任务：装 `@tintinweb/pi-subagents` 后由它提供——派发工具（`Agent`）在父会话事件流里
     *     留下 `tool_execution_*`，子智能体的**身份 / 状态 / 用量 / 结果**经扩展事件总线
     *     （`pi.events` 的 `subagents:*`）结构化到达。取数路径写在 `subagents.ts` 的文件头。
     */
    messageCapability: {
      thinkingText: 'yes',
      // 思考正文是**全文**（不是摘要），`thinkingLevelMap.off = null` 会让「关闭」变成静默打开，
      // 故适配器不许把 `off` 写成 `null`
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
      // `yes` ⇒ 必须给出这一格的取数通道（契约的 `superRefine` 拦在解析层）
      subagentSource: 'wire',
      subagentReason: null,
      streamingDeltaSource: 'wire',
      streamingDeltaReason: null,
      notes: [
        '成本不可用：上游不报成本，本次运行的成本这一格没有真值（model 的四条费率全 0 只为让 SDK 的计价函数不炸）',
        '一步 = `turns` 的一格：assistant `message_end` 与 `turn_start` 同数，一次工具调用算两轮',
        '子任务由扩展 @tintinweb/pi-subagents@0.21.0 提供：派发工具与子任务身份 / 状态 / 用量都挂在扩展上，'
          + '扩展没装上时本次运行**失败并点名**（不许「声明支持、实际没装」）',
        '派发能力整条在扩展里，但**模型也可以自己用 `bash` 拉起宿主 `pi` CLI 凑一个子智能体**——'
          + '那条路径**不在我们的观测面内**：真机实测里子智能体真跑了、真交了报告，而本次运行 `subagentTurns: 0`、'
          + 'token 不进行的、事件流里一个字都没有 ⇒ 子任务那几格只回答「经扩展派发的那些」。'
          + '**工具可用 ≠ 模型一定用它**：装了扩展这条边界依然成立',
        '子会话**继承主会话的模型与网关 / 密钥**（`subagentSource` 之所以是 `wire`）：父会话的 `modelRegistry` 与 '
          + '`modelRuntime` 原样传下去 ⇒ 子智能体打的是同一台网关，**不需要**配置文件 / 环境变量 / 宿主 CLI',
        '子任务行的取数路径是扩展事件总线（`pi.events` 的 `subagents:*`），'
          + '`Agent` 工具结果的 `details` 只作交叉核对——结果正文那句 `Agent completed in …` 是给人看的排版文本，'
          + '不从中解析任何字段',
        '子任务只到**顶层**：扩展只给顶层子智能体发生命周期事件，子会话自己再派发的那些'
          + '在父会话里一个字都没有 ⇒ 子任务行的 `parentSubagentId` 恒 `null`',
        '合计（`tokens` / `turns`）**含**子智能体那一份：主子自己的读数与子会话的读数覆盖面不相交，'
          + '两份相加才是「本次运行一共花了多少」，界面按「主会话 = 合计 − 分量」推导',
        '子会话的**会话文件与 settings/memory 落真实 `~/.pi`**：它们走 SDK 的进程级 `getAgentDir()`'
          + '（装载器的 `agentDir` 那一格管不到子会话），可用的开关只有 `PI_CODING_AGENT_DIR` 与'
          + '`PI_CODING_AGENT_SESSION_DIR`（后者优先，只管落盘目录）——本适配器不写宿主环境变量'
          + '⇒ 默认档下并发 pi 行共享这一部分，只读/沙箱家目录下整次派发以 `EPERM` 失败。'
          + '转写正文不在这里（落共享 `os.tmpdir()/pi-subagents-<uid>/…`），见 `docs/protocols/pi.md`',
        '思考档位出站形态：`off` 在 openai wire 上是 `reasoning:{effort:"none"}`、在 anthropic wire 上是 `thinking:{type:"disabled"}`；'
          + '`minimal/low/medium/high` 同名直传；`max` 靠模型上的显式映射才可用；`xhigh` 不在档位域里（会被静默夹档）',
        'anthropic wire 的档位换算成 `budget_tokens`（minimal 1024 / low 2048 / medium 8192 / high 16384）并被 `maxTokens-1024` 夹住'
          + '⇒ `maxTokens` 小时档位会塌缩（medium 与 high 同值），两条 wire 的同一档不等价',
        '模型不支持所选的档时 pi 夹到相邻档：不报错，也不回落成关闭',
      ],
    },
    /**
     * 注入面：**两格都 `yes`**，两格都有硬前提（写在 `notes` 里，是声明成立的条件而不是补充说明）：
     * MCP 必须显式走 `exposure: 'direct'`，skills 靠白名单 + `skillsOverride` 过滤。
     */
    injection: {
      mcp: { state: 'yes', reason: null },
      skills: { state: 'yes', reason: null },
      notes: [
        'MCP 的前提是显式 `exposure: "direct"`：默认暴露方式下工具不会进这一轮的可用集',
        'skills 的前提是白名单 + `skillsOverride` 过滤：全量放开等于把宿主技能目录一起交给被测智能体',
        'MCP 的观测格走「厂商工具表」这一条通道：`direct` 档下工具真的进请求，表在、里面没有它 ⇒ 未启动；'
          + '这一家没有「每台一张状态表」那种东西，工具面就是最硬的证据',
        '技能的同名冲突如实呈现：厂商清单里仍是那个名字（结论判「已装上」），两端路径落一条 WARN——'
          + '冲突**不判**「缺失」，那会让整本次运行失败且文案说假话',
        'MCP 的 OAuth 登录不补（401 落到 `needs sign-in`，与另三家同档）：**可补、不构成未覆盖项**——'
          + '公开包 `@earendil-works/pi-mcp/oauth` 与 `createMcpExtension({ credentials })` 这两处入口存在（厂商 `mcp/index.js`），'
          + '但**补法未验证**：本仓没有任何调用点或探针跑过 OAuth 刷新那条路',
      ],
    },
    /**
     * **注入面（第五组）**：人往运行中的一轮送话、以及接着一条已有会话再跑一段，这一家各能做什么。
     *
     * 逐格取值与依据：
     *   · **投递两档 `off-by-adapter`**：厂商侧两档**都有原生落点**（`steer` = 本仓的 `'round'`、
     *     `followUp` = `'idle'`，窄壳已按 `1.1.0` 的实际面声明），但适配器今天**一格都不挂**
     *     ——没接就是没接（`reason: 'not-observed'`），事实面由 `index.test.ts` 那条
     *     「端口挂着也不投」钉住。通道写 `in-process-sdk`：那两件是进程内 SDK 的方法，不走 wire；
     *   · **撤回两档 `flush-only`**：唯一的撤回面是 `clearQueue()`，它把两档**一起**清
     *     （`steering` 与 `followUp` 两份队列同时返回）。故界面上不许出现「撤回这一条」的文案；
     *   · **续接 `yes`**：`SessionManager.open(会话文件)` 塞回 `createAgentSession`，
     *     真机同形夹具（真包 + 脚本式上游）验过暗号回读、阴性对照与按行隔离，
     *     见 `testing/pi-session-fixture.ts` 与 `session-resume.test.ts`。无版本门、非 experimental。
     *
     * 两条写进 `notes` 的前提（都是「不看就会用错」的那类）：
     *   · 续接**必须**用 `open(文件)` 而不是 `continueRecent`（后者取目录里 mtime 最新的一条，
     *     运行内重跑会接到上一次尝试）；落点是**会话文件路径**而不是会话 id（文件名嵌着不可预知的时间戳）；
     *   · `'round'` 那一档只在**同一条命**里有效：跨进程续接之后没有在途轮，
     *     续接之后的追问天然落在排队那一档。
     */
    turnInjection: {
      delivery: {
        round: {
          state: 'off-by-adapter',
          reason: 'not-observed',
          channel: 'in-process-sdk',
          gate: null,
          experimental: false,
          // 窄壳声明了 `steer` / `followUp`，但适配器一格端口都不挂 ⇒ 厂商侧的投递没被验过
          proofDriver: 'synthetic-fixture',
          proofDriverReason: '适配器一格端口都没挂（窄壳声明了 `steer` / `followUp`），'
            + '厂商侧的投递没被真机验过 ⇒ 今天的证据来自假 SDK 夹具',
        },
        idle: {
          state: 'off-by-adapter',
          reason: 'not-observed',
          channel: 'in-process-sdk',
          gate: null,
          experimental: false,
          proofDriver: 'synthetic-fixture',
          proofDriverReason: '适配器一格端口都没挂（窄壳声明了 `steer` / `followUp`），'
            + '厂商侧的投递没被真机验过 ⇒ 今天的证据来自假 SDK 夹具',
        },
      },
      retract: {
        round: { state: 'flush-only', reason: '只有 `clearQueue()`，它把 steering 与 followUp 两条队列一起清空——没有按条撤回的面' },
        idle: { state: 'flush-only', reason: '只有 `clearQueue()`，它把 steering 与 followUp 两条队列一起清空——没有按条撤回的面' },
      },
      /**
       * 续接是 `yes`：真路径（真包装配 + 真会话管理器 + 真 JSONL 落盘），假网关只扮演上游模型；
       * 驱动器在 `testing/pi-session-fixture.ts`，三条判据（机制 / 端到端 / 阴性对照 + 按行隔离）都成立。
       */
      resume: {
        state: 'yes',
        reason: null,
        channel: 'in-process-sdk',
        gate: null,
        experimental: false,
        proofDriver: 'real-path',
        proofDriverReason: null,
      },
      notes: [
        '续接必须用 `SessionManager.open(会话文件)`，不能用 `continueRecent`：后者取会话目录里 mtime 最新的一条，'
          + '而运行内重跑会在同一目录里留下上一次尝试的会话 ⇒ 接回来的是上一次尝试的上下文',
        '要落的键是**会话文件路径**（不是会话 id）：文件名是 `<ISO 时间戳>_<会话 id>.jsonl`，时间戳不可预知 ⇒ id 拼不回路径',
        '会话落点显式钉在运行配置目录下的 `sessions/`：不给这一格时厂商按 `agentDir` × `cwd` 两轴推导默认落点，'
          + '而工作区会被重建 ⇒「本次运行的会话在哪」变成算不出来的东西',
        '续接的会话文件不存在时本次运行失败并点名路径：厂商的 `open()` 在文件不存在时不抛、当场新造一条，'
          + '静默开新会话正是「用户以为在追问、模型什么都不记得」的那种失败',
        '`round` 那一档只在同一条命（同一个进程内、本轮未收场）里有效：跨进程续接之后没有在途轮，'
          + '续接之后的追问天然落在排队那一档',
        '投递两档今天还没接（`off-by-adapter`）：窄壳声明了 `steer` / `followUp`，但适配器一格都不挂端口',
      ],
    },
    /**
     * 交互面：**宿主工具**那一档——模型看到的提问工具由我们注册（`ask-user.ts` 的 `ask_user_question`），
     * 厂商侧既没有这个工具、也不下发这一类控制请求，所以 `askUserChannel` 是 `host-tool` 而不是
     * `vendor-tool`：两者的**提示词来源不同**（厂商给 vs 我们自己写），消费侧要能区分。
     *
     * 三条成立条件（都是装配面的事实，不是补充说明）：
     *   · 只在**有应答面**时注册（不传 `onAskUser` ⇒ 这个工具不存在，会话选项逐字不变）；
     *   · 只装在**全权限**档（只读档的工具面刻意不接触外部状态，连 `bash` 都不给）；
     *   · 等待预算没有厂商那一格（`vendorBudgetMs` 恒 `null`），超时只由骨架的预算产生。
     */
    interaction: {
      askUser: 'yes',
      askUserChannel: 'host-tool',
      askUserReason: null,
      /**
       * 真路径：厂商那一侧真跑（真包 + 可编排的假网关），假网关只扮演**上游模型**，
       * 工具是我们注册进会话装配面的那一件、答复同进程 `await` 回调。
       */
      askUserProofDriver: 'real-path',
      askUserProofDriverReason: null,
      notes: [
        '宿主工具：厂商的工具面里没有提问工具、也不下发这一类控制请求，这一件由我们自己注册',
        '只在有应答面时注册，且只装在全权限档——只读档的工具面不接触外部状态（连 bash 都不给）',
        '没有厂商侧等待预算：超时由骨架的预算产生（工具名沿用既有 ask-user 族表已识别的那个）',
      ],
    },
    /**
     * 耗时量级：**秒级**（in-process SDK，没有子进程冷启动）。
     * 真机冒烟的等待预算按这一档派生——声明小了那一轮会被自己的预算掐掉。
     */
    timing: {
      runScale: 'seconds',
      notes: ['前提是本机网关 + 短提示词；运行内首次 import pi 另计 300–450 ms 与约 90 MB RSS'],
    },
    // 事件流即齐（见本文件头那条实现义务）：不需要补 messages.jsonl
    needsMessagesForReasoningEvidence: false,
    /**
     * 档位域：与 `piThinkingLevel` 的判据、域外值点名共用 `PI_REASONING_EFFORTS` 一份。
     *
     * `max` 收得下是因为模型定义上有一条显式映射（`PI_THINKING_LEVEL_MAP`）——没有它 `max` 会被
     * 静默夹到 `high`。`xhigh` **不收**：pi 对它没有内建映射，给了 `max` 的映射之后会被往上夹到
     * `max`（静默升档）、认不出的串更是落到「关闭」那一档，两种都不是用户点的那一档。
     */
    reasoningEfforts: PI_REASONING_EFFORTS,
    // 未选档位时真的会落到 `medium`（见 `PI_DEFAULT_EFFORT`）
    defaultEffort: PI_DEFAULT_EFFORT,
  },
  /** 运行骨架：装配与凭据投射在 `startPi`，事件归一见本文件头 */
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runTurn(input, { kind: 'pi', start: startPi });
  },
};
