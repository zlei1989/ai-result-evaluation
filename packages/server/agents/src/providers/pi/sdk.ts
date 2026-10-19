/**
 * pi 的厂商 SDK 懒加载外壳：**唯一**知道 `@earendil-works/pi-coding-agent` 入口形状的地方。
 * 只负责三件事——动态 `import()`（顶层静态导入会把「一家 SDK 故障」放大成「整包不可用」）、
 * 装载前的 Node 版本闸、以及入口形状校验；会话装配与凭据投射不在这一层。
 *
 * 为什么必须有版本闸：pi 的 `engines.node: >=22.19.0` **只是 npm 元数据**，它的 `dist/` 里没有任何
 * 运行时版本判断（`engines` 只在安装器开了 `engine-strict` 时才拦）⇒ Node 太老不会在装载处报错，
 * 而是在别处以与版本无关的症状暴露。适配器因此自己比一次 `process.versions.node`，不合格就
 * `AGENT_LOAD_FAILED` 点名下限（见 `assertPiNodeVersion`）。
 *
 * 包名字面量落在**非 export** 的常量里再转出：「厂商包只能动态 import」的断言区分不出
 * `export … from '@pkg'` 与 `export const X = '@pkg'`（行首 export + 引号包名即命中），
 * 直接 export 字符串常量会被误判成静态导入。
 */
import { AgentLoadError, exportedNames } from '../../errors';
import { createSdkLoader } from '../../load-once';

const PI_PACKAGE_NAME_LITERAL = '@earendil-works/pi-coding-agent';
export const PI_PACKAGE_NAME = PI_PACKAGE_NAME_LITERAL;

/**
 * pi 的模型层包名（`@earendil-works/pi-ai`）：**凭据存储在这里**。
 *
 * 为什么单独一个包：`InMemoryCredentialStore` 不在 `pi-coding-agent` 的出口面里，而
 * 「凭据只进内存、不落盘」这条要求必须拿到它——默认的 `DefaultAuthStorage` 会在**读一下**的时候就
 * 建出一个空壳 `auth.json`。所以这一格是本仓显式声明 `@earendil-works/pi-ai` 依赖的唯一理由。
 *
 * 它与 `pi-coding-agent` 用的是**同一份实例**（后者把它声明成自己的依赖，pnpm 的解析结果同一条）：
 * 拿本仓这一条路径引进来的类，与 `ModelRuntime` 内部校验凭据时所期待的形状是同一个实现。
 */
const PI_AI_PACKAGE_NAME_LITERAL = '@earendil-works/pi-ai';
export const PI_AI_PACKAGE_NAME = PI_AI_PACKAGE_NAME_LITERAL;

/** pi 自己声明的 Node 下限（其 `package.json` 的 `engines.node`）：低于它不保证能跑，装载前拦下 */
export const PI_MIN_NODE_VERSION = '22.19.0';

/**
 * 版本闸：本机 Node 低于 pi 要求的下限时抛 `AGENT_LOAD_FAILED`（文案点名下限与本机版本）。
 * 入参只为用例可注入——生产路径上永远读宿主自己的 `process.versions.node`。
 */
export function assertPiNodeVersion(version: string = process.versions.node): void {
  if (isAtLeast(version, PI_MIN_NODE_VERSION)) return;
  throw new AgentLoadError(
    PI_PACKAGE_NAME_LITERAL,
    new Error(`需要 Node ≥${PI_MIN_NODE_VERSION}，当前 ${version}`),
    { variant: 'node-version', required: `≥${PI_MIN_NODE_VERSION}`, current: version },
  );
}

/**
 * 主次版本逐位比较（只看 major/minor，忽略 patch 与预发布后缀）。
 * 为什么不用字符串比较：字典序下 `'22.9.0' > '22.19.0'`，会把不合格的运行时放过去。
 * 为什么不为一次比较引 `semver`：本包不含该依赖，代价大于收益。
 */
function isAtLeast(version: string, min: string): boolean {
  const [major, minor] = parseMajorMinor(version);
  const [minMajor, minMinor] = parseMajorMinor(min);
  if (major !== minMajor) return major > minMajor;
  return minor >= minMinor;
}

/** 取 `major.minor` 两个数字；缺失或非数字的段按 0 处理（读版本绝不能让装载抛在别的错上） */
function parseMajorMinor(version: string): [number, number] {
  const [major = '', minor = ''] = version.split('.');
  return [toNumber(major), toNumber(minor)];
}

function toNumber(part: string): number {
  const value = Number.parseInt(part, 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * 适配器眼里 pi 的模块面：**只声明装配序列真正用到的那几格**。
 *
 * 为什么收窄到「用到的」而不是照抄厂商的 `.d.ts`：抄一份选项表就会随厂商升级漂移，而漂移在这里
 * 没有判据——装配面只用得到默认导出 `createAgentSession` 加四个构造器。
 * 形状校验要拦的是「装错了包 / 装错了版本」，所以判据是**入口存在且可调用**，
 * 内部形状由装配面对着自己声明的窄结构收窄（模型 / 会话那几格全是不透明类型）。
 */
export interface PiSdkModule {
  createAgentSession: (options: PiSessionOptions) => Promise<{ session: PiSession }>;
  DefaultResourceLoader: new (options: PiLoaderOptions) => PiResourceLoader;
  /**
   * 会话管理器工厂（三条构造路径，形状照厂商 `session-manager.d.ts`）。
   *
   *   · `create(cwd, sessionDir)`：开一条**新**会话，落点由 `sessionDir` 显式钉住。不给它时走厂商的
   *     默认落点，而那个落点是 `agentDir` × `cwd` **两轴**的函数（`<agentDir>/sessions/--<编码后的
   *     cwd>--`）⇒ 本仓必须显式给，否则「这一行的会话落在哪」由两个会漂的量共同决定；
   *   · `open(path)`：打开一条**指定**会话文件的会话（续接的唯一正确入口）。文件不存在时它**不抛**
   *     ——当场在同名路径上造一条新的，故「文件在不在」由适配器自己先判（见 `index.ts` 的续接段）；
   *   · `continueRecent(cwd, sessionDir)`：取该目录里 **mtime 最新**的那条。本仓**刻意不用**它——
   *     行内重跑（`retryRow` 重建工作区）会在同一目录里留下上一次尝试的会话，取最近一条接的是
   *     **上一次尝试**，不是这一行该续的那条。它仍进声明：一是把这一格的取舍写在类型上，
   *     二是给用例一根可以做成会抛的桩——适配器改回 `continueRecent` 时守卫当场见红。
   *
   * 管理器本身**不透明**（返回值收成 `unknown`）：适配器只把它交给 `createAgentSession`，从不读它的
   * 成员——要落的会话文件路径读的是**会话**上的那一格（见 `PiSession.sessionFile`）。
   */
  SessionManager: {
    create: (cwd: string, sessionDir?: string) => unknown;
    open: (path: string, sessionDir?: string, cwdOverride?: string) => unknown;
    continueRecent: (cwd: string, sessionDir?: string) => unknown;
  };
  SettingsManager: { inMemory: (settings?: unknown) => unknown };
  ModelRuntime: { create: (options: PiModelRuntimeOptions) => Promise<PiModelRuntime> };
  /**
   * MCP 扩展工厂（包出口导出）：**必须显式装配**，且**必须同时自给 `loadConfig`**。
   *
   * 两条真机事实决定了这个形状（见 `createMcpExtension` 的选项注释）：
   *   · 不装它时，`<agentDir>/mcp.json` 躺在盘上也**一台都不连**（这是 SDK 与 CLI 的差别）；
   *   · 只装扩展、不给 `loadConfig`，它读的是 `getAgentDir()`（`PI_CODING_AGENT_DIR` / `~/.pi/agent`）
   *     而**不是** `createAgentSession({ agentDir })`，且项目 `.pi/mcp.json` 在 SDK 下**恒可信**。
   */
  createMcpExtension: (options: PiMcpExtensionOptions) => (pi: unknown) => void;
}

/**
 * 资源装载器的构造选项（**只声明我们真给的那几格**）。
 *
 * 三格的存在理由各不相同，别把它们当成「顺手关掉的开关」：
 *   · `additionalSkillPaths`：本行物化的技能根，**必须绝对路径**（相对路径按 `cwd` 解析）；
 *   · `skillsOverride`：唯一能丢掉 HOME 锚定发现结果的通道（`noSkills` 会把**项目技能一起**关掉，
 *     而「被测仓库自带的技能照见」是对齐目标）；
 *   · `noExtensions`：挡住被测仓库 `.pi/extensions/*.ts` 的任意代码执行；它**只筛发现路径**，
 *     我们经 `extensionFactories` / `additionalExtensionPaths` 装入的那些不受它管。
 * 刻意**不声明** `noSkills` 与 `noContextFiles`：这两个键的缺省正是我们要的（见装配面的注释）。
 */
export interface PiLoaderOptions {
  cwd: string;
  agentDir: string;
  settingsManager?: unknown;
  additionalSkillPaths?: string[];
  extensionFactories?: unknown[];
  additionalExtensionPaths?: string[];
  noExtensions?: boolean;
  skillsOverride?: (base: PiSkills) => PiSkills;
}

/** 技能表与它的诊断（`skillsOverride` 的进出形状；装载器的 `getSkills()` 给的就是它） */
export interface PiSkills {
  /** 装载成功的那几条：名字 + 落点 + 来源分档（`sourceInfo.scope` 是厂商原值，照抄不翻译） */
  skills: Array<{ name: string; filePath: string; sourceInfo?: { scope?: string } }>;
  diagnostics: unknown[];
}

/** 装载器：装配面只读这三处事实（技能表、扩展表、上下文文件表） */
export interface PiResourceLoader {
  getSkills: () => PiSkills;
  getExtensions: () => { extensions: Array<{ path: string }>; errors: unknown[] };
  reload: (options?: { resolveProjectTrust?: (input: unknown) => Promise<boolean> }) => Promise<void>;
}

/**
 * `createAgentSession` 的选项（同上：只有我们真给的那几格）。
 *
 * `sessionManager` 收成 `unknown`：那一格是**不透明**的构造产物（`SessionManager.create` / `open`
 * 的返回值），适配器只转交、不读它的成员——会话文件路径读的是会话上的 `sessionFile`。
 */
export interface PiSessionOptions {
  cwd: string;
  agentDir: string;
  modelRuntime: PiModelRuntime;
  model: unknown;
  settingsManager: unknown;
  resourceLoader: PiResourceLoader;
  sessionManager: unknown;
  tools: string[];
  /**
   * 思考档（本仓 `input.effort` 的落点）。**必须显式给**：不给时这一格由 pi 自己的设置与缺省
   * （`DEFAULT_THINKING_LEVEL`）决定，而本仓 metadata 已经把那个缺省声明成 `defaultEffort`
   * ——靠厂商默认值兑现的声明，厂商改了我们就静默说错话。
   */
  thinkingLevel?: string;
  /**
   * 我们自己的工具（结构化输出那一件、提问那一件）。形状见 `PiCustomTool`：**只声明我们真给的那几格**。
   *
   * ⚠️ 它与 `tools`（名字白名单）是**两件事**，缺一不可：不在白名单里的自定义工具连声明都不会
   * 被声明出去（`_isAllowedTool` 先筛一遍），于是「装配了工具但模型看不到」——症状是模型永远走正文，
   * 而 `applied.structuredOutput` 因此恒 `false`，看起来像「这家就是没有原生通道」。
   */
  customTools?: PiCustomTool[];
}

/**
 * 一个自定义工具：参数即 JSON Schema（pi 的 `TSchema` 就是 JSON Schema 对象），
 * `constrainedSampling` 是厂商侧强制的那一格。
 *
 * 形状收窄到本仓用到的那几格——厂商 `ToolDefinition` 上还有渲染、命名空间、暴露档等一大堆字段，
 * 抄一份就会随厂商升级漂移，而那里面我们一个都不用（非 TUI 下没有渲染面）。
 */
export interface PiCustomTool {
  name: string;
  /** 人读的标签（非 TUI 下不用，但**必填**——厂商的 `ToolDefinition` 就是这么声明的） */
  label: string;
  description: string;
  /**
   * 默认系统提示词 `## Available tools` 段的**一行**。不给 ⇒ 这个工具在该段里根本不出现
   * （厂商按「有没有这一格」过滤，而不是按有没有这个工具）——宿主注册的工具因此要靠它才进得了那一段。
   */
  promptSnippet?: string;
  /**
   * 默认系统提示词 `## Guidelines` 段的条目（本工具激活时逐条追加）。
   * 宿主注册的工具没有厂商给的时机提示，行为约束只能写在这里（`description` 只说能力）。
   */
  promptGuidelines?: string[];
  parameters: unknown;
  /**
   * 提供商侧的受约束采样声明，两档语义相反：
   *   · `'require'` = 「这份 schema 拿不到 strict 就**抛错**」（零出站请求 + `stopReason: 'error'`）
   *     ⇒ 前提是装配期预检已判过能过；
   *   · `'prefer'` = 「拿不到 strict 就**静默回落**成非 strict 声明」——工具照旧出站、模型照旧能调，
   *     只是形状没有厂商侧强制（预检不过那一档走的就是它，配合填充层 + 修正轮兜底）。
   * 同一件工具的档位由装配期的采纳结论定死（见 `structured-output.ts` 的 `StructuredOutputAdoption`）。
   */
  constrainedSampling: { type: 'json_schema'; strict: 'require' | 'prefer' } | false;
  /**
   * 工具实现的返回值。`terminate: true` = 这一批工具结果落盘后结束当前 agent 循环
   * （厂商不强制调用本工具，故它只是「调了就收尾」，不是「一定会收尾」）。
   */
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<PiToolResult>;
}

/** 工具的返回值：`content` 是给模型看的一条文本，`terminate` 见 `PiCustomTool.execute` */
export interface PiToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: unknown;
  terminate?: boolean;
}

/** `ModelRuntime.create` 的选项：内存凭据 + 不读不写 `models.json` */
export interface PiModelRuntimeOptions {
  credentials: PiCredentialStore;
  modelsPath: null;
  allowModelNetwork: boolean;
  refreshOnCreate: boolean;
}

/** 一次模型运行时的注册面（provider 注册 + 内存密钥 + 注销） */
export interface PiModelRuntime {
  registerProvider: (providerId: string, config: PiProviderConfig) => void;
  setRuntimeApiKey: (providerId: string, apiKey: string) => Promise<void>;
  unregisterProvider: (providerId: string) => void;
  getModel: (providerId: string, modelId: string) => unknown;
}

/** 自注册 provider 的配置：协议（`api`）决定 wire，模型目录随它一起声明 */
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  models: PiProviderModel[];
}

/** 一条模型：`cost` / `contextWindow` / `maxTokens` 是厂商的必填格，`compat` 决定这条 wire 收不收工具 */
export interface PiProviderModel {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning: boolean;
  /**
   * 档位映射：本仓档名 → **厂商要看到的那一个字面串**（值原样进 `reasoning.effort`）。
   *
   * 值域刻意只有字符串：厂商用 `null` 标「这一档不支持」，而对 `off` 这么标是**地雷**
   * （pi 会把关闭的请求夹到最小档 ⇒ 静默打开）——窄类型让那个写法在我们这里根本写不出来。
   */
  thinkingLevelMap?: Record<string, string>;
  contextWindow: number;
  maxTokens: number;
  compat?: unknown;
}

/**
 * 会话：**装配面用到的全部方法**。
 * `subscribe` 是事件流的唯一入口；`bindExtensions` 是扩展装配的收尾一步（`mode` 必须写死 `'rpc'`，
 * 缺省 `'print'` 会让按 rpc 写的扩展判定配置错误）；`abort` / `waitForIdle` 是释放路径。
 *
 * 追问（结构化输出的形状修正）走 `prompt()`，**不声明 SDK 的同会话 `continue()`**：那一格在「上一条是
 * 助手消息」时直接抛（`Cannot continue from message role: assistant`），而首轮以正文收尾正是要走追问的
 * 形状；`prompt()` 既承接通用的会话上下文，也允许把问题清单与 schema 原文作为一条新的用户消息带上。
 */
export interface PiSession {
  /**
   * 本会话的身份（厂商 `AgentSession.sessionId`，就是其 `sessionManager.getSessionId()`）。
   *
   * 为什么要收这一格：派发扩展把每个子智能体的转写写到
   * `<tmpdir>/pi-subagents-<uid>/<cwd 编码>/<会话 id>/tasks/<子任务 id>.output`，
   * 而那一格取的正是**父会话**的这个 id ⇒ 本仓要读转写就得有它。
   * 它**不是**续接要落的键（那一格是 `sessionFile`）：这个 id 是厂商当场生成的 uuid，
   * 而会话文件名是 `<ISO 时间戳>_<id>.jsonl`——时间戳不可预知，id 拼不回路径。
   */
  sessionId: string;
  /**
   * 本会话落盘的**绝对路径**（厂商 `AgentSession.sessionFile`）；`undefined` = 这条会话不落盘。
   *
   * 为什么续接落的键是它而不是 `sessionId`：文件名里嵌着不可预知的时间戳，拿 id 反查要么拼路径
   * （拼不出）、要么扫目录（还得知道会话目录，而那正是另一格）。落路径之后，续接只要
   * `SessionManager.open(这个路径)`，与「这一行的会话目录在哪」解耦。
   */
  sessionFile: string | undefined;
  subscribe: (listener: (event: unknown) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  /**
   * **投递档**：把一条消息排到「当前这一轮的工具都跑完、下一次模型往返之前」（= 本仓的 `'round'`）。
   *
   * 返回值是厂商的 `QueuedInputDisposition`（两值：`'handled' | 'queued'`）：
   * `'handled'` 表示这句话被某个扩展**当场吃掉**（本仓装着的 `@tintinweb/pi-subagents` 命中
   * `@名字 …` 时会 `return { action: 'handled' }`）⇒ 它**没有**进队列，消费方不得当成已投递。
   * 空闲 / 已收工时调用**不抛、不丢、也不起一轮**（只推队列），故投递方不能靠异常判成败。
   */
  steer: (text: string) => Promise<'handled' | 'queued'>;
  /**
   * **排队档**：排到「这一次 run 没活可干了」（= 本仓的 `'idle'`）。与 `steer` 同一条返回语义
   * （含 `'handled'` 那一档）；它唤不醒已经收工的会话——真正的收场由编排层的等待预算兜底。
   */
  followUp: (text: string) => Promise<'handled' | 'queued'>;
  /**
   * **同一个会话文件内**导航到某个节点（「回到某一轮」的落点）。
   *
   * 与 `fork(entryId)` 的差别：`navigateTree` 仍在**同一个会话文件**里，会话 id 不变 ⇒ 这一行的
   * `sessionId` 照旧成立（续接键不被打断）；`fork` 会另开一个文件、换掉会话 id。
   * `summarize: true` 把被放弃的那一段折成一条 branch summary，而不是直接丢弃。
   *
   * **可选**：窄壳只声明我们真用到的格子，假件与旧版本都可能没有它；适配器在收到 `fork`
   * 而它缺席时**抛中文错**（不许静默退化成普通续接）。
   */
  navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<unknown>;
  abort: () => Promise<void>;
  waitForIdle: () => Promise<void>;
  dispose: () => void;
  bindExtensions: (bindings: { mode: 'rpc'; onError?: (error: unknown) => void }) => Promise<void>;
  getLastAssistantText: () => string | undefined;
  /**
   * **扩展运行器**（厂商 `AgentSession.extensionRunner` 的公开 getter）——只用两格公开方法。
   *
   * 为什么释放序列要碰它：厂商把「扩展自己的关闭钩子」挂在 `session_shutdown` 事件上
   * （MCP 扩展的连接清理正是它：`pi.on("session_shutdown", …) → session.abort() → servers = []`），
   * 而 `AgentSession.dispose()` **不 emit** 这个事件——只有 `AgentSessionRuntime.dispose()` 与
   * `AgentSession.reload()` 会（前者的实体就是「emit(session_shutdown, reason: 'quit') → session.dispose()」）。
   * 窄壳只走 `createAgentSession()`，所以这一发由**我们按厂商同一条顺序补上**：
   * 不碰任何私有字段，也不为了这一格换掉整条 runtime。
   *
   * 收成**可选**：假件与将来的版本都可能没有它，缺了就跳过（与「拿不到会话句柄」同一条降级姿态）。
   */
  extensionRunner?: PiExtensionRunner;
}

/** 扩展运行器里我们用到的那两格（见 `PiSession.extensionRunner`） */
export interface PiExtensionRunner {
  /** 有没有扩展监听这个事件（没有就不发，免得白走一趟 emit） */
  hasHandlers: (eventType: string) => boolean;
  /** 投递一个扩展事件（厂商 `ExtensionRunner.emit` 的公开方法） */
  emit: (event: unknown) => Promise<unknown>;
}

/**
 * 一台 MCP 服务器的**厂商条目**（`loadConfig` 的产物元素）。
 *
 * 只声明我们要给的那几格，外加一格**必给**的 `exposure`：pi 的缺省曝光档是 `codemode`，
 * 那一档下工具只可调用、**不进模型可见的工具表**——我们会因此丢掉最硬的一条判据，
 * 而 MCP 注入本身也会依赖一个我们没启用的 codemode 扩展。值域收成字面量 `'direct'`：
 * 写成别的档在这一层根本编译不过（见装配面的 `exposure` 注释）。
 */
export interface PiMcpServerEntry {
  name: string;
  config: PiMcpServerConfig;
}

export interface PiMcpServerConfig {
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  exposure: 'direct';
}

/** `loadConfig` 的返回值：服务器清单 + 配置级错误原文（启动报告照抄）+ 是否自动启用 codemode */
export interface PiLoadedMcpConfig {
  servers: PiMcpServerEntry[];
  errors: string[];
  autoEnableCodemode: boolean;
}

/**
 * `createMcpExtension` 的选项面：**只声明我们要摸的那几格**，外加两格显式不给的。
 *
 *   · `loadConfig`（必给）：自给之后配置只从我们的内存对象来——默认那个读 `getAgentDir()`
 *     （`PI_CODING_AGENT_DIR` / `~/.pi/agent`，**不是** `createAgentSession({ agentDir })`），
 *     并且会把被测仓库的 `.pi/mcp.json` 一起读进来（SDK 下 `isProjectTrusted()` 恒 `true`，
 *     `resolveProjectTrust` 挡不住它）。自给是我们这一层唯一的关法；
 *   · `startupWaitMs`：第一次 prompt 等 `direct` 档服务器多久（默认 10 s），显式钉住；
 *   · `createTransport`：**不给**。换传输层要深路径 import 厂商内部实现（包出口只有
 *     `createMcpExtension`），而工具表已经是最硬的一条证据——为它引一条会被升级打断的依赖不划算；
 *   · `credentials`：**不给**。OAuth 第一版不做（与三家对齐），没有 token store 可交；
 *     补法是公开包 `pi-mcp/oauth` 自换 token 后交给这一格，可补、不构成未覆盖项。
 */
export interface PiMcpExtensionOptions {
  loadConfig: (context: unknown) => PiLoadedMcpConfig;
  startupWaitMs?: number;
  createTransport?: (entry: PiMcpServerEntry, cwd: string, authProvider: unknown) => unknown;
  credentials?: unknown;
}

const loadRaw = createSdkLoader<unknown>(
  async () => import('@earendil-works/pi-coding-agent'),
  PI_PACKAGE_NAME_LITERAL,
);

/**
 * 某个值是不是「对象**或类**，且这几格都是函数」——形状校验的共用判据（缺一格就点名那一格）。
 *
 * 类也算：厂商这几格有的是类（`ModelRuntime.create` 是**静态**方法，`typeof` 是 `'function'`），
 * 有的是普通对象（`SessionManager`）——成员取值方式一样，判据不该把它们分成两档。
 */
function hasFunctions(value: unknown, names: readonly string[]): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const record = value as Record<string, unknown>;
  return names.every((name) => typeof record[name] === 'function');
}

/**
 * 装配序列**恒要**的模块面：`loadPiSdk` 逐格判「在不在、能不能用」，缺哪一格就点名哪一格。
 *
 * 为什么要逐格判而不是只判入口：这些格子都是**构造期**就要用的（`new DefaultResourceLoader(...)`、
 * `SettingsManager.inMemory(...)`、`ModelRuntime.create(...)`），缺了它们的爆点分别是
 * `sdk.DefaultResourceLoader is not a constructor` / `Cannot read properties of undefined (reading
 * 'inMemory')` 这类**离真因很远**的裸 TypeError，而且会被归成 `AGENT_FAILED`——那一格在编排层的
 * 自动重试表里 ⇒ 一次形状漂移白跑两遍，日志里还没有一句「是哪个导出没了」。
 *
 * `createMcpExtension` **不在这一张表里**：只有配了 MCP 的行才用它，缺了它不该让不配 MCP 的行失败
 * ——那一格在使用点判（见 `assertPiMcpExtension`）。
 */
const PI_SDK_REQUIRED_CELLS: ReadonlyArray<{
  entry: keyof PiSdkModule & string;
  shape: string;
  usable: (module: Record<string, unknown>) => boolean;
}> = [
  { entry: 'createAgentSession', shape: '函数', usable: (module) => typeof module['createAgentSession'] === 'function' },
  {
    entry: 'DefaultResourceLoader',
    shape: '可 `new` 的构造器',
    usable: (module) => typeof module['DefaultResourceLoader'] === 'function',
  },
  {
    entry: 'SessionManager',
    shape: '对象或类，且 `create` / `open` / `continueRecent` 都是函数',
    usable: (module) => hasFunctions(module['SessionManager'], ['create', 'open', 'continueRecent']),
  },
  {
    entry: 'SettingsManager',
    shape: '对象或类，且 `inMemory` 是函数',
    usable: (module) => hasFunctions(module['SettingsManager'], ['inMemory']),
  },
  {
    entry: 'ModelRuntime',
    shape: '对象或类，且 `create` 是函数',
    usable: (module) => hasFunctions(module['ModelRuntime'], ['create']),
  },
];

/**
 * 懒加载 + 形状校验：先过版本闸（不合格不必付出一次 import 的代价），再逐格确认装配面要用的导出。
 * 形状不对与「包没装」都归 `AGENT_LOAD_FAILED`，但文案必须分开：前者重装恒无效，
 * 要拿的是「适配器期望的入口 vs 实测导出面」。
 */
export async function loadPiSdk(): Promise<PiSdkModule> {
  assertPiNodeVersion();
  const raw = await loadRaw();
  const module = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const missing = PI_SDK_REQUIRED_CELLS.find((cell) => !cell.usable(module));
  if (missing !== undefined) {
    throw new AgentLoadError(PI_PACKAGE_NAME_LITERAL, new Error(`模块的 ${missing.entry} 形状不对（期望：${missing.shape}）`), {
      variant: 'shape-mismatch',
      expected: `${missing.entry}（${missing.shape}）`,
      actual: exportedNames(raw),
    });
  }
  return raw as PiSdkModule;
}

/** MCP 扩展工厂的**使用点**校验：只有配了 MCP 的行走这一格（不配的行不该因为它缺席而失败） */
export function assertPiMcpExtension(sdk: PiSdkModule): void {
  if (typeof sdk.createMcpExtension === 'function') return;
  throw new AgentLoadError(PI_PACKAGE_NAME_LITERAL, new Error('模块缺少 createMcpExtension 导出（本行配了 MCP，装配面要用它）'), {
    variant: 'shape-mismatch',
    expected: 'createMcpExtension（函数）',
    actual: exportedNames(sdk),
  });
}

/**
 * 会话面的**装配断言**：拿到会话之后逐格确认「本层一定会用到的那几格」在场。
 *
 * 为什么装载期的模块校验拦不住这一档：它们是**实例方法**与**实例字段**，只有真建出会话才看得到。
 * 现实里的漂移形态是「某一格改了名」——`sessionFile` 被改名时续接能力会**静默消失**
 * （适配器读 `session.sessionFile ?? null` ⇒ 行照旧 `ok:true`、`sessionId` 记 `null`，
 * 用户看到的是「这一行不能续接」却没有任何报错）。所以这里判的是**键在不在**，
 * 不是值真不真：`sessionFile` 的值合法地可以是 `null`（不落盘的会话）。
 */
const PI_SESSION_REQUIRED: ReadonlyArray<{ entry: string; usable: (session: Record<string, unknown>) => boolean }> = [
  { entry: 'subscribe', usable: (session) => typeof session['subscribe'] === 'function' },
  { entry: 'prompt', usable: (session) => typeof session['prompt'] === 'function' },
  { entry: 'abort', usable: (session) => typeof session['abort'] === 'function' },
  { entry: 'waitForIdle', usable: (session) => typeof session['waitForIdle'] === 'function' },
  { entry: 'dispose', usable: (session) => typeof session['dispose'] === 'function' },
  { entry: 'bindExtensions', usable: (session) => typeof session['bindExtensions'] === 'function' },
  { entry: 'sessionFile', usable: (session) => 'sessionFile' in session },
];

export function assertPiSessionShape(session: PiSession): void {
  const record = session as unknown as Record<string, unknown>;
  const missing = PI_SESSION_REQUIRED.find((cell) => !cell.usable(record));
  if (missing === undefined) return;
  throw new AgentLoadError(PI_PACKAGE_NAME_LITERAL, new Error(`createAgentSession 返回的会话缺少 ${missing.entry} 这一格`), {
    variant: 'shape-mismatch',
    expected: `会话面的 ${missing.entry}`,
    actual: Object.keys(record).sort(),
  });
}

/**
 * 适配器眼里 pi 模型层（pi-ai）的模块面：只要一个**纯内存**的凭据存储实现。
 * 形状校验的必要性与 SDK 那一层相同：`credentials` 传错形态时 SDK 的失败点离真因很远。
 */
export interface PiAiModule {
  InMemoryCredentialStore: new () => PiCredentialStore;
}

/**
 * pi-ai 的 `CredentialStore` 在适配器眼里的形状：**不透明**。
 *
 * 适配器只把它原样交给 `ModelRuntime.create({ credentials })`，从不读它的成员 ⇒ 这里刻意不抄
 * 厂商的五个方法（抄一份就会随厂商升级漂移，而漂移在这里没有判据）。真实契约由 SDK 在构造时校验，
 * 本仓的判据是「`InMemoryCredentialStore` 这个导出存在且可构造」。
 */
export interface PiCredentialStore {
  readonly __piCredentialStoreBrand?: never;
}

const loadAiRaw = createSdkLoader<unknown>(
  async () => import('@earendil-works/pi-ai'),
  PI_AI_PACKAGE_NAME_LITERAL,
);

/**
 * 懒加载 pi-ai 并校验凭据存储的导出：与 `loadPiSdk` 同一条处置（失败归 `AGENT_LOAD_FAILED`，
 * 形状不对的文案点名「期望入口 vs 实测导出面」，不含恒无效的安装命令）。
 */
export async function loadPiAi(): Promise<PiAiModule> {
  const raw = await loadAiRaw();
  if (typeof (raw as { InMemoryCredentialStore?: unknown } | null)?.InMemoryCredentialStore !== 'function') {
    throw new AgentLoadError(PI_AI_PACKAGE_NAME_LITERAL, new Error('模块缺少 InMemoryCredentialStore 导出'), {
      variant: 'shape-mismatch',
      expected: 'InMemoryCredentialStore',
      actual: exportedNames(raw),
    });
  }
  return raw as PiAiModule;
}
