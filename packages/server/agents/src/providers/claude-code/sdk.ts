/**
 * claude-code 的厂商 SDK 懒加载外壳。
 * 本文件是**唯一**知道 `@anthropic-ai/claude-agent-sdk` 入口形状的地方：窄结构在这里自定义、
 * 不从厂商包 import type（§5.6.2 末段），于是厂商的类型变更打不到本仓的 typecheck。
 * 注意：`import()` 必须是动态的——顶层静态导入会把「一家 SDK 故障」放大成「整包不可用」（A6）；
 * 字段名以真实事件探测的 dump 为准（§5.6.3，探测回写任务按实测修正本文件）。
 */
import { AgentLoadError } from '../../errors';
import { createSdkLoader } from '../../load-once';
import type { ClaudePermissionMode } from '../../permission';

/**
 * 包名字面量：**不能**写成 `export const CLAUDE_PACKAGE_NAME = '@anthropic-ai/claude-agent-sdk';`。
 * 为什么：T5 的「厂商包只能动态 import」断言按 `^\s*(import|export)…[^;]*['"]<包名>['"]` 扫源码，
 * 而那个模式区分不出 `export … from '@pkg'` 与 `export const X = '@pkg'`（行首关键字 + 引号包名即命中），
 * 于是**行首 export 的常量声明会被误判成静态导入**（实测：本文件按 brief 原文写就报
 * `providers/claude-code/sdk.ts：静态导入 @anthropic-ai/claude-agent-sdk`）。
 * 故字面量落在非 export 的语句里再转出：断言照样拦得住真正的静态导入，包名也仍是唯一真源。
 * 收窄那条模式归 T10 / 阶段评审；在它收窄前，三个适配器都按本写法落地。
 */
const CLAUDE_PACKAGE_NAME_LITERAL = '@anthropic-ai/claude-agent-sdk';

export const CLAUDE_PACKAGE_NAME = CLAUDE_PACKAGE_NAME_LITERAL;

export interface ClaudeQueryOptions {
  cwd: string;
  env: Record<string, string>;
  model: string;
  /**
   * 权限档的落点（2026-09-28 起由 `permission.ts` 的 `CLAUDE_PERMISSION_OPTIONS` 决定）。
   * 值域逐字取自安装态 SDK 的类型面：`sdk.d.ts:2417` 的
   * `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`。
   *
   * 为什么这里写**完整的**联合而不是某一个值：本仓此前的窄结构把这一格钉成 `'acceptEdits'`，
   * 于是「加一个只读档」在编译期就被这层外壳挡住——外壳比厂商窄，就等于把厂商的能力
   * 关在门外（本仓实测：`Type '"dontAsk"' is not assignable to type '"acceptEdits"'`）。
   * ⚠️ 它只放宽「编辑要不要逐个批准」，**不放宽路径安全门**（那道门与权限模式无关）⇒
   * 与 `index.ts` 的 `canonicalCwd` 是两条一起做才完整的修法。
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
   *    一起挡在门外（2026-09-29 前的口径，已改）；
   *  · 打开它就等于**允许 `${cwd}/.claude/settings.json` 的 `env` 块改写本次路由**（该文件在
   *    candidate 的可写工作区里）⇒ 必须与下面的 `settings` 成对给，缺一半就是路由被接管。
   */
  settingSources: readonly string[];
  /**
   * 等价 CLI 的 `--settings`（flag 档）。合并优先级**高于** `user` / `project` / `local`
   * （本机实测：只开 `settingSources` 时被测仓库 settings 的 `env` 赢；补上这一格后本次路由赢）。
   * 本仓只用它的 `env`：把 §5.6.5 的注入点（base URL + 两份凭据）钉在最外层，仓库改不动。
   *
   * 厂商声明的类型是 `string | Settings`（一个完整 settings 对象或文件路径）；这里只声明用到的那一格。
   */
  settings?: { env: Record<string, string> };
  /** 硬中止入口：dispose 时 abort，SDK 据此杀掉仍在跑的子进程 */
  abortController: AbortController;
  /**
   * **不再有 `maxTurns`**（用户口径，2026-09-28）：它是「最大 API 往返次数」，而本仓执行与评分
   * 都不限轮次。原来这里是必填的 `number`、`index.ts` 写死 60 —— 那个 60 实测把一次 60 次往返的
   * 评测截在 `error_max_turns` 上。SDK 侧该选项本身可选，不给就是不限。
   */
  /**
   * 把子智能体的**文本与思考**也当作 assistant/user 消息转发，并带上 `parent_tool_use_id`
   * （`sdk.d.ts` 的 `Options.forwardSubagentText`，默认 `false`）。spec §6.4.2。
   *
   * 厂商 JSDoc 逐字：*"By default, only tool_use/tool_result blocks from subagents are emitted
   * (enough for a heartbeat counter). When true, the full subagent conversation is forwarded
   * so consumers can render a nested transcript."*
   *
   * ⚠️ **这一格曾经不在这里，而 SDK 支持它**——本接口是「比厂商窄的外壳」，
   * 而文件上游（`permissionMode` 那一段）已经把这个教训写死了：
   * *「外壳比厂商窄，就等于把厂商的能力关在门外」*。
   * 这次的表现更隐蔽：**不报错、不缺数据，只是子智能体永远只有工具流水**（静默的空）。
   * 真机 A/B：不开时子智能体消息 5 条、开了 10 条（多出 `thinking:3` + `text:3`）。
   */
  forwardSubagentText?: boolean;
  /**
   * 流式增量（`Options.includePartialMessages`，SDK 拼成 CLI 的 `--include-partial-messages`）。
   * 开了之后 wire 上**先出 `stream_event` 再出完整快照**：`content_block_delta` 的
   * `text_delta` / `thinking_delta` / `signature_delta` 三种增量由 `message.ts` 的 `streamEvent`
   * 投影成 `chunk: 'delta'` 的消息草稿（编排层只广播不落盘，2026-10-09）。
   *
   * 两个已知边界（`includePartialMessages` 的 JSDoc 与本仓探针一致）：
   *  · **只覆盖主会话**：`stream_event` 的 `parent_tool_use_id` 恒 `null`，子智能体没有 token 级增量
   *    （子任务视图不做逐字动画，等快照整块到）；
   *  · 开销：wire 上多一批增量帧（1 delta ≈ 1 token）。编排层对 delta **不落盘** ⇒ `messages.jsonl`
   *    不膨胀，代价只在传输与广播。
   *
   * ⚠️ 与 `forwardSubagentText` 同一条教训的镜像：**这格不声明、调用方不传，wire 上就永远不出
   * `stream_event`**——解析路径（`streamEvent`）整条空转，能力声明 `streamingDelta: 'yes'` 与实现
   * 不一致（docs/protocols/message-spec 已知边界表 2026-10-09 前的旧账）。真机探针
   * `probe/v4/claude-official-remedies.mjs` ② 验证过它确实给真增量。
   */
  includePartialMessages?: boolean;
}

export interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
  /** 优雅停止：结束在途 turn（不是 kill 进程） */
  interrupt?: () => unknown;
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
