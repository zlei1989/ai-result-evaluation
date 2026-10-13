/**
 * cc 的厂商 SDK 懒加载外壳。
 * 本文件是**唯一**知道 `@anthropic-ai/claude-agent-sdk` 入口形状的地方：窄结构在这里自定义、
 * 不从厂商包 import type，于是厂商的类型变更打不到本仓的 typecheck。
 * 注意：`import()` 必须是动态的——顶层静态导入会把「一家 SDK 故障」放大成「整包不可用」（A6）；
 * 字段名以真实事件探测的 dump 为准。
 */
import { AgentLoadError } from '../../errors';
import { createSdkLoader } from '../../load-once';
import type { ClaudeMcpServer } from '../../mcp';
import type { ClaudePermissionMode } from '../../permission';

/**
 * 包名字面量：**不能**写成 `export const CLAUDE_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';`。
 * 为什么：「厂商包只能动态 import」的断言按 `^\s*(import|export)…[^;]*['"]<包名>['"]` 扫源码，
 * 而那个模式区分不出 `export … from '@pkg'` 与 `export const X = '@pkg'`（行首关键字 + 引号包名即命中），
 * 于是**行首 export 的常量声明会被误判成静态导入**（报 `providers/cc/sdk.ts：静态导入
 * @anthropic-ai/claude-agent-sdk`）。故字面量落在非 export 的语句里再转出：断言照样拦得住真正的
 * 静态导入，包名也仍是唯一真源；三个适配器都按本写法落地。
 */
const CLAUDE_PACKAGE_NAME_LITERAL = '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_PACKAGE_NAME = CLAUDE_PACKAGE_NAME_LITERAL;

export interface ClaudeQueryOptions {
  cwd: string;
  env: Record<string, string>;
  model: string;
  /**
   * 权限档的落点（由 `permission.ts` 的 `CLAUDE_PERMISSION_OPTIONS` 决定）。
   * 值域逐字取自安装态 SDK 的类型面：`sdk.d.ts:2417` 的
   * `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。
   *
   * 为什么这里写**完整的**联合而不是某一个值：本仓此前的窄结构把这一格钉成 `'acceptEdits'`，
   * 于是「加一个只读档」在编译期就被这层外壳挡住——外壳比厂商窄，就等于把厂商的能力
   * 关在门外（本仓实测：`Type '"dontAsk"' is not assignable to type '"acceptEdits"'`）。
   * ⚠️ 它只放宽「编辑要不要逐个批准」，**不放宽路径安全门**（那道门与权限模式无关）⇒
   * 与 `index.ts` 的 `canonicalCwd` 是两条一起做才完整。
   */
  permissionMode: ClaudePermissionMode;
  /**
   * 结构化输出（`sdk.d.ts:1905-1917` 的 `Options.outputFormat` / `JsonSchemaOutputFormat`）。
   * 不给 ⇒ 与今天逐字相同；给了 ⇒ CLI 负责让模型按 schema 生成，并在形状不符时**自己重问**
   * （用尽后以 `error_max_structured_output_retries` 收场，见 `events.ts` 的中文归因）。
   * ⚠️ 这一格**不是**权限项：它不影响能不能写工作区，故不进 `permission.ts` 那张表。
   */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /**
   * 思考强度（`sdk.d.ts` 的 `Options.effort`：`'low' | 'medium' | 'high' | 'xhigh' | 'max' | number`）。
   * 值域取 SDK 的**具名档位**（不含 number 那一支：本仓传的是供应商声明的档位名）。
   * 不给 ⇒ 沿用模型自己的默认档。
   */
  effort?: string;
  /**
   * 思考模式（`sdk.d.ts:1831-1842` 的 `Options.thinking` / `ThinkingConfig`）。
   * 本仓只用**关闭**这一档：`{ type: 'disabled' }`（SDK 的 `EffortLevel` 里没有 off，
   * 「不思考」必须走这个字段；`thinking` 的优先级高于已废弃的 `maxThinkingTokens`）。
   */
  thinking?: { type: 'disabled' };
  /**
   * `permissionMode: 'bypassPermissions'` 的**成对开关**（厂商 JSDoc 逐字：
   * 「Must be set to `true` when using `permissionMode: 'bypassPermissions'`」；SDK 把它们拼成
   * 两个独立 argv）。只给前者时 CLI 仍旧逐个工具要批准，而评测里没有人能点这个批准。
   */
  allowDangerouslySkipPermissions?: boolean;
  /**
   * 谁回答批准请求。`'none'` = 没有任何批准面：本该弹批准的操作**当场被拒**并把原因回给模型，
   * 而不是挂在一个永远没人应答的批准上（后者只会把该行拖到兜底超时，界面上看起来像「评分超时」）。
   */
  permissionPrompts?: 'host' | 'none';
  /**
   * 权限范围内**额外放行**的只读绝对路径（`sdk.d.ts:1467` 的 `Options.additionalDirectories`，
   * SDK 拼成 CLI 的 `--add-dir`；厂商 JSDoc 逐字：「Additional directories Claude can access
   * beyond the current working directory. Paths should be absolute.」）。
   *
   * 与 `dontAsk` 兼容：工作目录内的读由 `dontAsk` 预授权，这一格把预授权范围扩到 cwd 之外的
   * 目录/文件，语义仍是「未预授权的一律拒」——它只扩大**读**的放行范围，不改变写仍被拒。
   * 路径必须是绝对路径（厂商口径）；空数组在 SDK 侧不追加任何 argv。
   */
  additionalDirectories?: readonly string[];
  /**
   * 从模型上下文里摘掉的内置工具名（厂商把它拼成 `--disallowedTools <逗号分隔>`，非空才追加）。
   * 只读地传：名单由 `index.ts` 的 `ALWAYS_DISALLOWED_TOOLS` / `NON_CLAUDE_DISALLOWED_TOOLS` 持有，
   * 每次运行按 `disallowedToolsFor(modelId)` 现拼一份（`WebSearch` 随模型名分档）——厂商声明的是
   * `string[]` 且我们从不改写，故这里放宽成 `readonly string[]`。不认识的工具名厂商不报错，
   * 名单可以**先于**厂商版本存在。
   */
  disallowedTools?: readonly string[];
  /**
   * 加载哪些**文件系统 settings**：`'user'` = `~/.claude/settings.json`（本仓的隔离下 = 本行
   * `CLAUDE_CONFIG_DIR/settings.json`）、`'project'` = `${cwd}/.claude/settings.json`、
   * `'local'` = `${cwd}/.claude/settings.local.json`；`[]` = 隔离模式（不读任何文件系统 settings）。
   *
   * 值域与语义逐字取自安装态 SDK 的 JSDoc（`sdk.d.ts:2175-2185`），其中两条是承重的：
   *  · 「Must include `'project'` to load CLAUDE.md files」——`[]` 会把被测仓库的 `CLAUDE.md`
   *    一起挡在门外；
   *  · 打开它就等于**允许 `${cwd}/.claude/settings.json` 的 `env` 块改写本次路由**（该文件在
   *    candidate 的可写工作区里）⇒ 必须与下面的 `settings` 成对给，缺一半就是路由被接管。
   */
  settingSources: readonly string[];
  /**
   * 等价 CLI 的 `--settings`（flag 档）。合并优先级**高于** `user` / `project` / `local`
   * （只开 `settingSources` 时被测仓库 settings 的 `env` 赢；补上这一格后本次路由赢）。
   * 本仓只用它的 `env`：把注入点（base URL + 两份凭据）钉在最外层，仓库改不动。
   *
   * 厂商声明的类型是 `string | Settings`（一个完整 settings 对象或文件路径）；这里只声明用到的那一格。
   */
  settings?: { env: Record<string, string> };
  /**
   * 权限钩子（`sdk.d.ts:1525` 的 `Options.canUseTool`）：CLI 遇到「需要用户介入」的工具调用时
   * 发一帧 `can_use_tool`，由宿主回答允许 / 拒绝——提问工具走的就是这条通道
   * （`requires_user_interaction: true`，与普通工具不同：普通工具在全权档上被预授权、不进这一格）。
   *
   * ⚠️ 只声明本仓用得到的两格。厂商那一侧 `PermissionResult` 还有 `updatedPermissions` /
   * `decisionClassification` 等格，本仓不消费；`updatedInput` 是**递答案的唯一落点**
   * （提问工具的答复经它回到厂商，见 `index.ts` 的 `askUserPermission`）。
   */
  canUseTool?: ClaudeCanUseTool;
  /** 硬中止入口：dispose 时 abort，SDK 据此杀掉仍在跑的子进程 */
  abortController: AbortController;
  /**
   * **没有 `maxTurns`**（用户口径）：它是「最大 API 往返次数」，而本仓执行与评分都不限轮次。
   * 写死 60 会把一次 60 次往返的评测截在 `error_max_turns` 上。SDK 侧该选项本身可选，不给就是不限。
   */
  /**
   * 把子智能体的**文本与思考**也当作 assistant/user 消息转发，并带上 `parent_tool_use_id`
   * （`sdk.d.ts` 的 `Options.forwardSubagentText`，默认 `false`）。
   *
   * 厂商 JSDoc 逐字：*"By default, only tool_use/tool_result blocks from subagents are emitted
   * (enough for a heartbeat counter). When true, the full subagent conversation is forwarded
   * so consumers can render a nested transcript."*
   *
   * ⚠️ **这一格必须在壳里**（SDK 支持它）——本接口是「比厂商窄的外壳」，
   * 而文件上游（`permissionMode` 那一段）已经把这个教训写死了：
   * *「外壳比厂商窄，就等于把厂商的能力关在门外」*。
   * 漏掉它**不报错、不缺数据，只是子智能体永远只有工具流水**（静默的空）。
   * 判据：不开时子智能体消息 5 条、开了 10 条（多出 `thinking:3` + `text:3`）。
   */
  forwardSubagentText?: boolean;
  /**
   * 流式增量（`Options.includePartialMessages`，SDK 拼成 CLI 的 `--include-partial-messages`）。
   * 开了之后 wire 上**先出 `stream_event` 再出完整快照**：`content_block_delta` 的
   * `text_delta` / `thinking_delta` / `signature_delta` 三种增量由 `message.ts` 的 `streamEvent`
   * 投影成 `chunk: 'delta'` 的消息草稿（编排层只广播不落盘）。
   *
   * 两个已知边界（`includePartialMessages` 的 JSDoc 与本仓探针一致）：
   *  · **只覆盖主会话**：`stream_event` 的 `parent_tool_use_id` 恒 `null`，子智能体没有 token 级增量
   *    （子任务视图不做逐字动画，等快照整块到）；
   *  · 开销：wire 上多一批增量帧（1 delta ≈ 1 token）。编排层对 delta **不落盘** ⇒ `messages.jsonl`
   *    不膨胀，代价只在传输与广播。
   *
   * ⚠️ 与 `forwardSubagentText` 同一条教训的镜像：**这格不声明、调用方不传，wire 上就永远不出
   * `stream_event`**——解析路径（`streamEvent`）整条空转，能力声明 `streamingDelta: 'yes'` 与实现
   * 不一致（见 `docs/protocols/message-spec` 的已知边界表）。探针
   * `probe/v4/claude-official-remedies.mjs` ② 验证过它确实给真增量。
   */
  includePartialMessages?: boolean;
  /**
   * 本次注入的 **MCP 服务器**（本仓一律走 SDK 参数，**不落
   * `<configHome>/.claude.json`**）。
   *
   * 为什么走参数而不是磁盘配置：
   *   · 参数是**编程入口**，同名时程序化注入赢且只留一条（`source: 'dynamic'` 顶掉 `'project'`）；
   *   · 不落盘就不会与宿主那份 `.claude.json` 混起来——本行的 `CLAUDE_CONFIG_DIR` 是一个空目录，
   *     磁盘上那份配置从哪来、谁改过，都不必再追。
   *
   * 形状是窄结构 `ClaudeMcpServer`（`../../mcp`，同一份真源，别在这里重抄一遍）：
   * stdio = `{type:'stdio',command,args?,env?}`（**无 `cwd`**）、http = `{type:'http',url,headers?}`。
   *
   * **`strictMcpConfig` 刻意不在这里声明**（用户口径：不压制）：本仓不传它，
   * 于是被测仓库自带的 `.mcp.json` 照常生效——那一格一旦打开，仓库那几台会**整批消失**，
   * 而界面上没有任何提示（只剩「已下发的 MCP 服务」少了几行）。真要压制时再声明它，
   * 并同步改那条守卫（`index.test.ts` 的「保持关闭」）。
   */
  mcpServers?: Record<string, ClaudeMcpServer>;
}

/**
 * 权限钩子的应答（`sdk.d.ts:2440` 的 `PermissionResult` 里本仓用得到的两支）。
 *
 * `allow` 带 `updatedInput` = 「允许执行，但把入参换成这一份」——递答案正是靠它；
 * `deny` 要一句给模型看的 `message`（厂商把它渲染成工具结果）。返回 `null` 是 SDK 类型面允许的
 * 第三支（已经用带外通道答过了），本仓不用：不小心返回 `null` 等于**没有 control_response**，
 * 那一问会一直挂着。
 */
export type ClaudePermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };

/**
 * 权限钩子：CLI 每次要宿主批准一个工具调用时调一次，`input` 是**该工具 checkPermissions 归一后的入参**
 * （与模型给的原文可能有别，改写入参要基于这一份）。
 *
 * `options.toolUseID` 是这一帧的调用 id，与消息账本里的 `tool-call` 块同值——递答案时要把它带回去
 * （`updatedInput` 那一支的 `toolUseID` 与它配对，见 `probe/v11/lib/cc-ask.mjs` 抄回的线级帧）。
 */
export type ClaudeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID?: string; requestId?: string },
) => Promise<ClaudePermissionResult | null>;

export interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {  /** 优雅停止：结束在途 turn（不是 kill 进程） */
  interrupt?: () => unknown;
  /**
   * 上下文用量快照（SDK 的控制请求 `get_context_usage`）。
   *
   * 为什么要它：本仓**唯一**能确证「这条 skill 真进了会话的技能面」的通道就在这里
   * ——`skills.skillFrontmatter[].name` 是厂商自己列出来的那份清单（带 `source`），
   * 比 `system/init` 的 `skills` 数组硬（那个数组不受允许列表影响、且内置项永远在里面 ⇒ 假绿）。
   *
   * 两个坑：
   *   · **它是异步的，而 `TurnStart.finalize` 是同步的**（`turn.ts` 在 `finally` 里调一次、不 await）
   *     ⇒ 不能在 `finalize` 里发起，必须在流循环里 await 一次再把结果交出去；
   *   · 必须在**会话已建**之后调（`system/init` 到了才算），否则拿到的是空的那一份。
   *
   * 返回 `unknown`：形状由 `readClaudeContextUsage` 收窄成我们那几格，不从厂商包 `import type`。
   */
  getContextUsage?: (opts?: { detail?: 'summary' | 'full' }) => Promise<unknown>;
}

/**
 * 我们**用得到的那几格**上下文用量（厂商返回 `SDKControlGetContextUsageResponse`，字段远多于此）。
 *
 * 只声明 `skills` 一格：它是本仓唯一消费的东西（其余各格是 `/context` 面板的排版素材）。
 * 读成 `unknown` 再逐个字段判形状——厂商加字段打不到这里，字段改名则**降级成采不到**
 * （`null`）而不是崩。
 */
export interface ClaudeContextUsage {
  skills: {
    totalSkills: number;
    includedSkills: number;
    skillFrontmatter: { name: string; source: string }[];
  } | null;
}

/** 一个非负整数格；不是数字就 `null`（厂商形态变了 ⇒ 采不到，不猜） */
function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 把厂商的上下文用量**收窄成我们那几格**。
 *
 * 三条处置：
 *   · 整格 `skills` 缺席（厂商口径：没有任何 skill 占用上下文时它省略）⇒ `skills: null`
 *     ——那是**采不到**，与「投送了、确实是空的」（`includedSkills: 0` + 空数组）不是一回事；
 *   · `skillFrontmatter` 里名字读不出来的条目**整条丢掉**：这一格的主键是名字，
 *     没名字就没法与我们的清单配对，留着只会在界面上多一行空白（来源读不出记空串）；
 *   · 形状不对（整格不是对象、两个计数格读不出）⇒ 返回 `null`，调用方据此记一条点名的 WARN、
 *     判据降级成 `unverified`。
 */
export function readClaudeContextUsage(raw: unknown): ClaudeContextUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const skills = (raw as { skills?: unknown }).skills;
  if (skills === undefined || skills === null) return { skills: null };
  if (typeof skills !== 'object') return { skills: null };
  const record = skills as { totalSkills?: unknown; includedSkills?: unknown; skillFrontmatter?: unknown };
  const total = readCount(record.totalSkills);
  const included = readCount(record.includedSkills);
  if (total === null || included === null) return { skills: null };
  const rows = Array.isArray(record.skillFrontmatter) ? record.skillFrontmatter : [];
  const skillFrontmatter: { name: string; source: string }[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { name, source } = row as { name?: unknown; source?: unknown };
    if (typeof name !== 'string' || name === '') continue;
    skillFrontmatter.push({ name, source: typeof source === 'string' ? source : '' });
  }
  return { skills: { totalSkills: total, includedSkills: included, skillFrontmatter } };
}

export interface ClaudeMessage {
  type: string;
  [key: string]: unknown;
}

export interface ClaudeSdkModule {
  query: (params: { prompt: string; options: ClaudeQueryOptions }) => ClaudeQuery;
}

const loadRaw = createSdkLoader<unknown>(
  async () => import('@anthropic-ai/claude-agent-sdk'),
  CLAUDE_PACKAGE_NAME,
);

/** 懒加载 + 形状校验：形状不对与「包没装」归为同一类（AGENT_LOAD_FAILED），文案点名包名 */
export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  const raw = await loadRaw();
  if (typeof (raw as { query?: unknown }).query !== 'function') {
    throw new AgentLoadError(CLAUDE_PACKAGE_NAME, new Error('模块缺少 query 导出'));
  }
  return raw as ClaudeSdkModule;
}
