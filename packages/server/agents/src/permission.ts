/**
 * 权限档到**三家厂商选项**的映射表（唯一真源，2026-09-28）。
 *
 * 为什么单独一个文件、而不是各自写在 provider 里：这三份表只有**放在一起**才能逐格对照，
 * 而它们必须同时正确——「两家给全权限、第三家忘给」正是 p6 冒烟实测过的缺陷形状
 *（claude-code 当时是三家唯一没设写使能的那家，7 行候选**全部 0 改动**、评分在空 diff 上打出 20 分，
 * 见 `docs/superpowers/notes/2026-09-22-features-smoke.md` 的 A1）。放一起之后，
 * `permission.test.ts` 能把「每一档在每一家都有落点」写成一条可执行断言。
 *
 * ⚠️ 这张表里的选项**值域来自厂商包的类型面**（不是猜的），改之前先核这三处：
 *   · claude：`@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 `PermissionMode` 与
 *     `allowDangerouslySkipPermissions` / `permissionPrompts` 的 JSDoc；
 *   · codex：`codex app-server` 协议的 `SandboxMode`（`thread/start` 的 `sandbox` 一等字段）与
 *     `AskForApproval`（同请求的 `approvalPolicy`）——取值域以 `providers/codex/appserver/protocol.ts`
 *     的声明与测试为准，不再经 SDK 的类型面；
 *   · dsh：`@deepseek-ai/dsh-base/cordis.patch.yml` 的 `sandbox-policy` / `approval` / `permission`
 *     三行——`DSH_PERMISSION_MODE` 同时决定沙箱档与批准策略，**无需**再传别的开关。
 *
 * 这里只放**权限相关**的选项；模型、cwd、env、超时等仍由各适配器自己拼。
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

/** codex 的权限选项：建线程时固定（改了必须重建线程，§5.6.6） */
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
 * 为什么需要这一层（2026-10-07 真机）：`read-only` 沙箱在 **Windows 上没有可用实现**——
 * 实测 `read-only` 与 `workspace-write` 下 codex 连 `echo hello` / `git status --porcelain`
 * 都起不来（`codex_core::tools::router: error=exec_command failed: CreateProcess { … rejected: blocked by policy }`），
 * 而 codex **没有独立的文件读取工具**，读文件只能靠 shell ⇒ 评分阶段（只读档）在 Windows 上等于
 * **盲评**：链路全通（`ok`、`judgments` 齐、`structuredOutput: true`），结论全错
 * （真机：候选确实做到了三项，评分 `0 / 25`）。三档矩阵见 `docs/codex-faq.md`。
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
 * 注入通道是适配器已有的 `buildSubprocessEnv`（SDK 的 `env` 是**替换型**语义，见 §5.6.1 决策 A5），
 * 落在**子进程环境**而不是 `process.env`——静态断言（`static-assertions.test.ts`）仍然成立。
 */
export const DSH_PERMISSION_OPTIONS: Readonly<Record<AgentPermission, DshPermissionOptions>> = {
  full: { env: { DSH_PERMISSION_MODE: 'danger-full-access' } },
  'read-only': { env: { DSH_PERMISSION_MODE: 'read-only' } },
};
