/**
 * 权限档到**各家厂商选项**的映射表（唯一真源）。
 *
 * 为什么单独一个文件、而不是各自写在 provider 里：这几份表只有**放在一起**才能逐格对照，
 * 而它们必须同时正确——「两家给全权限、第三家忘给」正是冒烟实测过的缺陷形状
 *（cc 当时是三家唯一没设写使能的那家，7 行候选**全部 0 改动**、评分在空 diff 上打出 20 分，
 * 见 `docs/protocols/provider-run.md`「权限档按阶段给」表）。放一起之后，
 * `permission.test.ts` 能把「每一档在每一家都有落点」写成一条可执行断言。
 *
 * ⚠️ 这张表里的取值**来自厂商自己的面**（类型面 / 配置面，不是猜的），改之前先核这几处：
 *   · claude：`@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `PermissionMode` 与
 *     `allowDangerouslySkipPermissions` / `permissionPrompts` 的 JSDoc；
 *   · codex：`codex app-server` 协议的 `SandboxMode`（`thread/start` 的 `sandbox` 一等字段）与
 *     `AskForApproval`（同请求的 `approvalPolicy`）——取值域以 `providers/codex/appserver/protocol.ts`
 *     的声明与测试为准，不再经 SDK 的类型面；
 *   · dsh：`@deepseek-ai/dsh-base/cordis.patch.yml` 的 `sandbox-policy` / `approval` / `permission`
 *     三行——`DSH_PERMISSION_MODE` 同时决定沙箱档与批准策略，**无需**再传别的开关；
 *   · pi：`@earendil-works/pi-coding-agent` 的 `ToolName` 联合与 `CreateAgentSessionOptions.tools`
 *     白名单（`createCodingTools()` / `createReadOnlyTools()` 两个工厂给出的正是默认的那两套），
 *     见下面 `PiPermissionOptions` 的注释。
 *
 * 这里只放**权限相关**的选项；模型、cwd、env、超时等仍由各适配器自己拼。
 *
 * **`AgentRunInput.extraReadPaths` 刻意不落这几张表**：它只被 claude 消费——翻成 SDK 的
 * `Options.additionalDirectories`（`--add-dir`），是 **query option** 而不是权限档选项
 * （转发点在 `providers/cc/index.ts`，与权限档并列地扩进 `dontAsk` 的预授权范围）。
 * codex / dsh 不映射它：codex 的 read-only 沙箱官方语义全盘可读、dsh 的 read-only 只拦写读全放行，
 * 两家的读放行不需要额外通道；pi 的读得到什么由只读档的工具白名单决定，也不需要这一格。
 * 把它塞进表里只会让这几家去消费一个它们不映射的格；
 * 各表的键集合由 `permission.test.ts` 逐字钉死（守卫名：「extraReadPaths 不进这几份权限档表」）。
 */
import type { AgentPermission } from './types';

/**
 * claude 的 `PermissionMode` 值域（逐字来自 `sdk.d.ts` 的 `PermissionMode`）。
 * 为什么照抄而不是用 `string`：SDK 的 `query()` 选项在这一格上收窄成了**字面量联合**，
 * 给它一个 `string` 连编译都过不去（本仓实测：`Type 'string' is not assignable to type '"acceptEdits"'`）。
 * 抄一份的代价是它会随厂商升级漂移——但那正是 `permission.test.ts` 存在的理由（值域变了当场红）。
 */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

/** claude 的权限选项：`permissionMode` 与它的两个配套开关（JSDoc 里写明「必须同时给」的那两个） */
export interface ClaudePermissionOptions {
  permissionMode: ClaudePermissionMode;
  /** 必须为 true 才能让 `bypassPermissions` 真正生效（见下表 `full` 一行的注释） */
  allowDangerouslySkipPermissions?: boolean;
  /** `'none'` = 没有批准面：任何「本该弹批准」的操作**立即被拒**，而不是挂到超时 */
  permissionPrompts?: 'host' | 'none';
}

/** codex 的权限选项：建线程时固定（改了必须重建线程） */
export interface CodexPermissionOptions {
  sandboxMode: string;
  approvalPolicy: string;
}

/** dsh 的权限选项：一个环境变量（dsh-base 的 `sandbox-policy` 与 `approval` 两行都读它） */
export interface DshPermissionOptions {
  env: { DSH_PERMISSION_MODE: string };
}

/**
 * claude：`full` 走 `bypassPermissions`，**必须**同时给 `allowDangerouslySkipPermissions: true`。
 *
 * 判据不是猜的：SDK 的 CLI 参数拼装是两句独立的 `if`（`sdk.mjs` 的
 * `if(b)z.push("--permission-mode",b);if(x)z.push("--allow-dangerously-skip-permissions")`），
 * 类型面也逐字写着「Must be set to `true` when using `permissionMode: 'bypassPermissions'`」
 * ——少了它，CLI 侧仍旧逐个工具要批准，而评测是无人值守的。
 *
 * `read-only` 走 `dontAsk` + `permissionPrompts: 'none'`（**刻意不是 `plan`**）：
 *   · `plan` 的语义是「不执行任何工具」，评审者连 `git diff` 都跑不了，而它的工作是**自己去看改动**
 *     （这正是不走文本通路的理由，见 `judge-agent.ts` 头注）；
 *   · `dontAsk` 的语义是「不弹批准，未预授权的一律拒」——读放行、写被拒，正是「只读」；
 *   · `permissionPrompts: 'none'` 再钉死一层：本进程没有任何批准面，越界操作**当场被拒**
 *     并把原因回给模型，而不是挂在一个永远没人应答的批准上（后者只会把该行拖到兜底超时）。
 */
export const CLAUDE_PERMISSION_OPTIONS: Readonly<Record<AgentPermission, ClaudePermissionOptions>> = {
  full: { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
  'read-only': { permissionMode: 'dontAsk', permissionPrompts: 'none' },
};

/**
 * codex：`full` 走 `danger-full-access`。
 *
 * 为什么不是 `workspace-write`（本仓此前的值）：那一档**默认关掉网络**——SDK 只在
 * `networkAccessEnabled !== undefined` 时才写 `sandbox_workspace_write.network_access=…`，
 * 而 `danger-full-access` 是「不设沙箱」。评测要观察的正是「改完自己跑不跑得起来」，
 * 装依赖 / 跑测试都不能因为沙箱断网而失败。
 *
 * `approvalPolicy` 两档都是 `'never'`：评测是非交互的，任何走人工批准的路径都只会让该行走到超时。
 * 「只读」靠 `sandboxMode: 'read-only'` 本身——**不靠模型自觉**。
 */
export const CODEX_PERMISSION_OPTIONS: Readonly<Record<AgentPermission, CodexPermissionOptions>> = {
  full: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
  'read-only': { sandboxMode: 'read-only', approvalPolicy: 'never' },
};

/**
 * codex 的**运行时**权限选项：表是上面的常量，这里是唯一入口（新增平台豁免时的唯一落点）。
 *
 * 为什么需要这一层：`read-only` 沙箱在 **Windows 上没有可用实现**——
 * 实测 `read-only` 与 `workspace-write` 下 codex 连 `echo hello` / `git status --porcelain`
 * 都起不来（`codex_core::tools::router: error=exec_command failed: CreateProcess { … rejected: blocked by policy }`），
 * 而 codex **没有独立的文件读取工具**，读文件只能靠 shell ⇒ 评分阶段（只读档）在 Windows 上等于
 * **盲评**：链路全通（`ok`、`judgments` 齐、`structuredOutput: true`），结论全错
 * （真机：候选确实做到了三项，评分 `0 / 25`）。三档矩阵见 `docs/faq/codex.md`。
 *
 * 处置：**只在 Windows 上**把只读档落成 `danger-full-access`（读得到），代价是评审者**能写**工作区
 * ——那一条由编排层的「评分前后 diff 摘要对照」兜底（不一致即该行失败，见 `judgeStageAttempt`）。
 * 别的平台保持真只读：macOS 的 seatbelt / Linux 的 landlock 有可用的只读实现，不受这条豁免影响。
 *
 * 为什么平台是**入参**而不是直接读 `process.platform`：这一格要能在两个平台上都被测到
 * （`permission.test.ts` 用它把「豁免只发生在 Windows」钉成字面量）。
 */
export function codexPermissionOptions(
  permission: AgentPermission,
  platform: string = process.platform,
): CodexPermissionOptions {
  const base = CODEX_PERMISSION_OPTIONS[permission];
  if (permission === 'read-only' && platform === 'win32') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: base.approvalPolicy };
  }
  return base;
}

/**
 * dsh：一个环境变量定档（`dsh-base/cordis.patch.yml` 逐字）：
 * ```
 * - id: sandbox-policy
 *   config: { mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write', … }
 * - id: approval
 *   config: { policy: !!js (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask' }
 * ```
 * ⇒ 不设它时 dsh 自己回落到 `workspace-write`（本仓此前的实际档位），设了才由我们说了算。
 *
 * 注入通道是适配器已有的 `buildSubprocessEnv`（SDK 的 `env` 是**替换型**语义），
 * 落在**子进程环境**而不是 `process.env`——静态断言（`static-assertions.test.ts`）仍然成立。
 *
 * ⚠️ **非 `danger-full-access` 的档位落到 `approval: ask`，而本仓没有批准面**（SDK 的 wire 上只有
 * 七个请求、四个通知，没有「服务端问客户端」那一类）。这一格**不会挂起**：厂商自己的 runtime-context
 * 消息里逐字写着「without an available answerer, the request fails closed」，真机复核
 * （`read-only` 档 + 模型写工作区内文件）也是当场被拒、墙钟 827 ms、文件没有长出来。
 * 也就是说「没有批准面」等价于「越界操作立即被拒」，不会把该行拖到静止超时。
 */
export const DSH_PERMISSION_OPTIONS: Readonly<Record<AgentPermission, DshPermissionOptions>> = {
  full: { env: { DSH_PERMISSION_MODE: 'danger-full-access' } },
  'read-only': { env: { DSH_PERMISSION_MODE: 'read-only' } },
};

/**
 * pi 的权限选项：**工具白名单**（`createAgentSession({ tools })`）。
 *
 * ⚠️ pi **没有权限标志位**——`.d.ts` 与真机都找不到 permission / sandbox 面（另三家的
 * `PermissionMode` / `SandboxMode` / `DSH_PERMISSION_MODE` 在这里没有对应物）。
 * 所以这一档**不是照抄三家的形状**，而是映射到「这一行拿得到哪些工具」：
 * `createAgentSession({ tools })` 是 SDK 的**一等白名单**（`CreateAgentSessionOptions.tools`），
 * 名单外的工具这一轮根本不在可用集里。
 *
 * 为什么不能像三家那样「只给一个权限开关、工具集不动」：pi 的写能力就住在工具集里。
 * 评分阶段（`read-only`）若沿用默认工具集，评审者会拿到 `edit` / `write` / `bash`，
 * 而工作区是候选的产出——它一改，抽屉里看到的 diff 就不再是候选交的那一份
 * （编排层另有一次改动摘要对照，本档是**执行层**的那一道）。
 *
 * 名单取自 SDK 的 `ToolName` 联合（`read | bash | powershell | edit | write | grep | find | ls`）：
 *   · `full` ＝ `createCodingTools()` 的默认四件（read / bash / edit / write）——评测要观察的
 *     正是「改完自己跑不跑起来」，所以 `bash` 必须在（装依赖、跑测试都靠它）；
 *   · `read-only` ＝ `createReadOnlyTools()` 的四件（read / grep / find / ls）——只读且能自己看改动，
 *     刻意**不含 `bash`**：它能写盘，等于把只读档绕过去。
 *
 * `powershell` 两档都不给：它与 `bash` 是同一件事的另一条平台通路，给了等于在 Windows 上
 * 多开一个与 `bash` 等价的写口子，而本仓的评测任务不区分平台 shell。
 */
export interface PiPermissionOptions {
  /** 传给 `createAgentSession({ tools })` 的工具名白名单，可含 `*` 通配（`+name` / `-name` 形态不使用） */
  tools: readonly string[];
}

/**
 * 子智能体扩展注册的三个 LLM 可调工具（`SUBAGENT_TOOL_NAMES` 去掉工作流那一件）。
 *
 * ⚠️ **名字必须逐个列进白名单**：`tools` 是**成员匹配器**——名单外的工具这一轮根本不被启用，
 * 而「没启用」与「没装上」在装配面上**一个字都不报**（真机实测：名单里只写内置四件时，
 * 请求体的 `tools` 数组就是那四件，扩展注册的 `Agent` 静默消失）。这与 MCP 白名单那一格是同一个坑：
 * 两者都是**成员匹配器**，名单外的工具既不报错、也不出现在请求里。
 *
 * ⛔ **只读档一个都不给**：`Agent` 派出的子会话能写文件（它拿的是完整工具面），
 * 给了它等于把只读档从侧门绕过去。`get_subagent_result` / `steer_subagent` 在没有 `Agent` 的
 * 会话里本来也无事可做，一并留在档外——**只读档的工具面里没有任何扩展工具**。
 */
export const PI_SUBAGENTS_TOOL_NAMES = ['Agent', 'get_subagent_result', 'steer_subagent'] as const;

/**
 * pi 两档的工具白名单（见上面的理由：这家靠**工具选择**分档，没有权限标志位）。
 *
 * `full` 档在默认四件之外加上扩展那三件：不然「声明 `subagent: yes`」与「实际拿得到派发工具」
 * 就是两句话（声明归声明，工具面静默没有它）。
 */
export const PI_PERMISSION_OPTIONS: Readonly<Record<AgentPermission, PiPermissionOptions>> = {
  full: { tools: ['read', 'bash', 'edit', 'write', ...PI_SUBAGENTS_TOOL_NAMES] },
  'read-only': { tools: ['read', 'grep', 'find', 'ls'] },
};

/**
 * 白名单里为 MCP 工具留的那一格：`mcp__*` 通配。
 *
 * **为什么必须是通配**：`direct` 曝光档下厂商把一台服务器的工具命名为 `mcp__<服务器>__<工具>`
 * （服务器名里的 `-` 换成 `_`），而工具名由 MCP 服务器自己定、连接之后才拿得到
 * ⇒ 我们装配会话时**枚举不出来**，只能按前缀通配。
 *
 * ⚠️ **为什么走「成员名单 + 通配」这条通道，而不是 `+name` / `-name` 修饰符**：
 * pi 对**纯修饰符**名单的处理是把白名单整个丢掉（`allowedToolNames = undefined`），
 * 之后任何注册进会话的工具都会进模型可见的工具表——那是「只留这些」的反面。
 * 本档要的是**闭集**：名单外的工具在这个会话里根本不该被声明。
 *
 * ⚠️ **`+name` 的语义是「加进默认集」而不是「只留这些」**：pi 的默认集固定是
 * `read` / `bash` / `edit` / `write`，所以只读档若写成 `+read,+grep,+find,+ls` 这类加集形式，
 * 默认集里的 `bash` / `edit` / `write` **仍然在**——那是静默的权限放宽，比「名单少了一格」更坏。
 * 因此本模块的两档一律用成员名单：名单内的是全部，`bash` 之类**可证不在**出站请求里。
 */
export const PI_MCP_TOOL_PATTERN = 'mcp__*';
