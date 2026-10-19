/**
 * 评测契约：智能体真源、行状态机、评测与候选行形状、创建入参、diff 响应。
 * 四个必须成立的口径：
 *   1. `AGENT_KINDS` 是三家智能体 id 的**唯一真源**——agents 包再导出它，
 *      前端下拉与 `EvalRow.agentKind` 都从这里派生；contracts 反向不依赖 agents；
 *   2. `EvalRow.baselineCommit` 在 prepare 之后是 40 位**具体** hash——`commitHash: null` 时
 *      diff 没有可比基线，准备阶段必须把 `HEAD` 解析成具体 hash 再写入；
 *   3. `TERMINAL_ROW_STATUSES` 供 SSE 判断「收到它即可关连接」，
 *      `isRunnableRow` 供「开始」按钮判断哪些行会被执行，两者语义不同不可互相替代；
 *   4. 两张标签表都是 `Record<枚举, string>`——新增枚举成员时 tsc 直接报错，
 *      不会出现「界面上一格空白」；
 *   5. 四条行级动作判据（`isRunnableRow` / `canRunRow` / `canRescoreRow` / `canRetryRow`）**都只有这一份**：
 *      界面用它决定按钮的 `disabled`，服务端用它抛 `CONFLICT`。两处各写一份必然漂移，
 *      漂移的表现是「按钮可点、点下去 409」（`canRunRow` 见它自己的注释）；
 *   6. **两个按钮都是「重跑」出口，而不是「失败恢复」出口**（用户口径：
 *      「已出分、无报错时取消禁用」）：只要**跑过一次且产出了改动**（有可比基线 + 有 diff）就可以
 *      再跑一次，已经出分的行同样给。判据里**不看** `EvalRow.error` / `error.stage`——
 *      失败发生在哪一段不再决定按钮的可用性（那一格仍照旧落盘，只是不再参与判定）。
 *      「误点会白烧一次」这件事改由界面的 `Popconfirm` 二次确认承担。
 */
import { z } from 'zod';

/** 行状态与 MCP 通道住在叶子模块里（见 `row-vocab.ts` 的文件头）：本文件要用，也要转出给 `index.ts` */
import {
  ROW_MCP_CHANNELS,
  RowMcpChannelSchema,
  EvalRowStatusSchema,
  type RowMcpChannel,
  type EvalRowStatus,
} from './row-vocab';

export { ROW_MCP_CHANNELS, RowMcpChannelSchema, EvalRowStatusSchema, type RowMcpChannel, type EvalRowStatus };
// 本文件自己也要用 AgentKindSchema（EvalRow.agentKind 与创建入参的候选行）、AgentKind
// （`isSameRowTarget` 的入参类型）与 AGENT_LABELS（追问那一族的原因里要写「哪一家」），
// 而 `export … from` 只把名字转出去、不引入本地作用域——故这里另有一行 import（不是重复）。
import { AGENT_LABELS, AgentKindSchema, type AgentKind } from './agent';
// 追问判据要读「这一家声明的续接那一格」（`turnInjection.resume`）：类型从 agent-message 借，
// 判据本身留在本文件——它是行级动作判据那一族的一员（与 `canRescoreRow` / `canRetryRow` 同住）。
import type { TurnInjectionCell } from './agent-message';
// 从叶子取而不是从 `./checkpoint` 取：后者会经 inject-message → agent-message → agent-event 回到本文件，
// 形成环并在包根评估时撞 TDZ（见 `checkpoint-void.ts` 的文件头）
import { CheckpointVoidSchema } from './checkpoint-void';
import { RubricSchema } from './rubric';
import { ScoreResultSchema } from './score';

// 智能体真源已拆到 ./agent（见该文件头：score.ts 需要 AgentKindSchema，而 run.ts 已经 import score.ts）。
// 这里**原样再导出**：所有既有消费方都从 `@aieval/contracts` 包根取这四个名字，路径不变。
export { AGENT_KINDS, AGENT_LABELS, AgentKindSchema, type AgentKind } from './agent';

/** 执行模式：并行不设并发上限，串行一行跑完（含评分）才起下一行 */
export const ExecutionModeSchema = z.enum(['parallel', 'serial']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;


/**
 * 终态集合：SSE 收到它即可关连接。
 * 顺序不参与界面排序，只用于判定——`pending` 与三个运行态都不在内。
 */
export const TERMINAL_ROW_STATUSES: readonly EvalRowStatus[] = [
  'judged', 'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
];

/** 行状态的中文文案（「串行排队中」不在此列，那是界面按 mode + 位置派生的文案） */
export const ROW_STATUS_LABELS: Record<EvalRowStatus, string> = {
  pending: '待开始',
  preparing: '准备中',
  running: '执行中',
  judging: '评分中',
  judged: '已评分',
  failed: '失败',
  'timed-out': '已超时',
  canceled: '已终止',
  skipped: '未执行（串行队列）',
  interrupted: '被重启打断',
};

/**
 * **失败发生在哪一段**：候选智能体那一段（含准备）还是评分那一段。
 *
 * 为什么必须落盘、而不能从状态里推：两段失败落的行状态可以**逐字相同**（候选 agent 起不来与
 * 评分模型起不来都是 `failed` + `AGENT_FAILED`；候选超时与评分超时都是 `timed-out` +
 * `AGENT_TIMED_OUT`），从终态本身读不出「是哪一段坏了」。
 *
 * ⚠️ **它今天只是一格叙述性的事实记录**：两个按钮都放开给「跑过一次且有产出」的所有行
 * ⇒ **没有任何判据再读它**。
 * 留着是因为「这一笔失败发生在哪一段」是排障时最常问的那个问题（日志抽屉与 `run.json` 都靠它），
 * 而不是因为它还在参与控制流——改这里之前先确认没有判据依赖它。
 */
export const RowFailureStageSchema = z.enum(['agent', 'judge']);
export type RowFailureStage = z.infer<typeof RowFailureStageSchema>;

/**
 * 「本行 MCP」观测格的**结论**。四档缺一不可：
 *   · `connected`——有**硬证据**说它连上了（今天 = 厂商工具表里有它的工具，见 `judgedBy`）；
 *   · `unavailable`——有证据说它**没起来**（厂商报了失败状态）；
 *   · `unverified`——我们投送了，但证据只到「厂商知道有它」（`pending` / `needs-auth`）、
 *     或压根没有证据；**形状不对、压根没投送的那几条也记这一档**（`resolveMcpServers` 的 `invalid` 桶：
 *     那是我方配置问题，不是厂商起不来 ⇒ 不许记成 `unavailable`，也就不许升级成行失败）。
 *     **这一档既不许写成「已连上」也不许写成「没有」**；
 *   · `skipped`——**我们主动没投送**（`${ENV}` 占位未设置；或 `command` / `url` / `args` 里写了占位
 *     ——那几格不支持占位）。它与 `unavailable` 的区别是责任方：那是我们跳过的，
 *     不是厂商起不来的。
 *
 * ⚠️ 任何一档都**不许**由模型答复推出来（实测抓到过「MCP 没调上、模型却把结果编出来」）。
 */
export const RowMcpVerdictSchema = z.enum(['connected', 'unavailable', 'unverified', 'skipped']);
export type RowMcpVerdict = z.infer<typeof RowMcpVerdictSchema>;

/**
 * 厂商侧 MCP 事实的**通道**（三家各一格）——「这条事实是从哪儿读到的」。
 *
 * 值名直接写「谁说的」而不是「多可信」（与 `RowMcpBasisSchema` 同一条口径）。三档与三家一一对应：
 *   · `vendor-status`——claude 的 `system/init` 里 `mcp_servers[].status`；
 *   · `vendor-startup-status`——codex 的 `mcpServer/startupStatus/updated`（`starting` / `ready` / `failed`）；
 *   · `vendor-tool-table`——**工具表本身就是判据**的那一家（dsh 的 `request/header`）：它起不来时
 *     工具静默消失、会话照常跑完、没有结构化错误 ⇒ 「表在、里面没有它」就等于「没起来」。
 *
 * ⚠️ 通道**决定结论怎么读**，所以它必须跟着证据走、而不是按厂商名去查一张静态表：同一个形状
 * （「表里没有这一台」）在前两档是「不判失败」，在第三档是「判失败」。声明与实际读到的东西会各自漂移。
 */

/**
 * 那条结论是**凭什么**下的（判据来源的四档）= 三条通道 + `none`（没有任何厂商证据）。
 *
 * **从同一份值域派生**：两处各写一份枚举必然漂移，而漂移的表现是
 * 「事件自报 `vendor-startup-status`、观测格却记 `vendor-status`」——这一格唯一要回答的就是
 * 「凭什么这么说」。`none` 只在结论侧存在（我们投送了但厂商没报，或我们主动跳过），它不是通道。
 */
export const RowMcpBasisSchema = z.enum([...ROW_MCP_CHANNELS, 'none']);
export type RowMcpBasis = z.infer<typeof RowMcpBasisSchema>;

/** 来源**未知**时的取值（厂商没给 `source`，或这一台压根没到厂商那儿）。见下面 `source` 的注释 */
export const ROW_MCP_SOURCE_UNKNOWN = 'unknown';

/**
 * 观测格里的**一台**（四格：名称 / 来源 / 判据来源 / 结论）。
 */
export const RowMcpServerSchema = z.object({
  /** 服务名（= 设置页那个键，也是工具名前缀 `mcp__<name>__` 里的那一段） */
  name: z.string().min(1),
  /**
   * 这一台**从哪来**：**优先采信厂商原值**（claude 的 `source` 实测给 `dynamic` = 本仓程序化注入、
   * `project` = 被测仓库自带 `.mcp.json`），厂商没给这一格时记 `ROW_MCP_SOURCE_UNKNOWN`。
   *
   * 为什么是自由字符串而不是枚举：厂商原值是**证据**，翻译成我们的词表就是第二个真源
   * （与环境抽屉里那条口径逐字相同：「原值照抄、不翻译」）。`unknown` 是**我们**对这一格的
   * 如实交代，不是厂商的取值。
   */
  source: z.string().min(1),
  /** 结论的依据通道（见 `RowMcpBasisSchema`） */
  judgedBy: RowMcpBasisSchema,
  /** 结论（见 `RowMcpVerdictSchema`） */
  verdict: RowMcpVerdictSchema,
  /**
   * **如实呈现**用的一句说明（可选）。今天只有一种：两台服务器名在厂商工具表里同形
   * （`my-server` 与 `my_server`——厂商把名字里的 `-` 写成 `_`），那一批工具**归不到**具体哪一台。
   *
   * 它**不改结论**：既不写成已连上、也不写成没有（那两台届时都是 `unverified`）。
   * 可选是为了让绝大多数行与本格逐字同形——没有这句话时不写这一格。
   */
  note: z.string().min(1).optional(),
});
export type RowMcpServer = z.infer<typeof RowMcpServerSchema>;

/**
 * 四档结论的中文文案。**放契约里**（与 `ROW_STATUS_LABELS` 同一条理由）：
 * 环境抽屉与服务端日志说的是同一件事，各抄一份必然漂移，而漂移的表现是
 * 「设置页说已跳过、环境抽屉说未验证」。
 */
export const ROW_MCP_VERDICT_LABELS: Record<RowMcpVerdict, string> = {
  connected: '已连上',
  unavailable: '未启动',
  unverified: '未验证',
  skipped: '已跳过',
};

/** 四档判据来源的中文文案（同上一条理由） */
export const ROW_MCP_BASIS_LABELS: Record<RowMcpBasis, string> = {
  'vendor-status': '厂商连接状态',
  'vendor-tool-table': '厂商工具表',
  'vendor-startup-status': '厂商启动状态',
  none: '无厂商证据',
};

/**
 * 一行技能观测的**结论**三档。**没有 `skipped`**：落盘失败 = 该行失败，
 * 不存在「我们主动跳过一条」；被停用的那些根本不进清单（`installableSkills` 已经剔掉）。
 */
export const ROW_SKILL_VERDICTS = ['installed', 'missing', 'unverified'] as const;
export const RowSkillVerdictSchema = z.enum(ROW_SKILL_VERDICTS);
export type RowSkillVerdict = z.infer<typeof RowSkillVerdictSchema>;

/**
 * 那条结论是**凭什么**下的（判据来源三档）——「这条事实是从哪儿读到的」。
 *
 *   · `vendor-skill-list`——厂商有**结构化的技能清单**：codex 的 `skills/list`、
 *     dsh 的 `skill-catalog`、claude 的 `getContextUsage().skills`（本仓走这三条）；
 *   · `vendor-prompt-listing`——只见到厂商**请求**里出现了它（codex 的入站 developer 段）。
 *     比清单弱一档：它证明「厂商把它写进了提示词」，回答不了「清单里还有没有别的」；
 *   · `local-materialized`——**只有我们的落盘**（L1）：厂商侧一个字都没采到。
 *
 * ⚠️ 本仓今天**不产出** `vendor-prompt-listing`（没有读入站请求那一层）；它留在值域里是为了
 * 与 MCP 那一格的通道数**同形**，将来接上那条通道时不必再改契约（`RowMcpBasis` 的 `none` 同理）。
 */
export const ROW_SKILL_BASES = ['vendor-skill-list', 'vendor-prompt-listing', 'local-materialized'] as const;
export const RowSkillBasisSchema = z.enum(ROW_SKILL_BASES);
export type RowSkillBasis = z.infer<typeof RowSkillBasisSchema>;

/** 来源**未知**时的取值（厂商没给 `source`，或这一条压根没到厂商那儿） */
export const ROW_SKILL_SOURCE_UNKNOWN = 'unknown';

/**
 * 观测格里的**一条**（四格：名称 / 来源 / 判据来源 / 结论）。
 *
 * ⚠️ **命名撞车**：这一格回答「**这一行实际装上了哪几条、我们凭什么这么说**」，
 * 与 `SkillsSettingsSchema`（设置页的停用名单）、`VendorSkillSchema`（厂商当时说它手里有哪几条）
 * 是三件不同的事。
 */
export const RowSkillInstallSchema = z.object({
  /** 技能名（= 技能目录名 = 厂商清单里的名字，三处可直接配对） */
  name: z.string().min(1),
  /**
   * 这一条**从哪来**：**优先采信厂商原值**（claude 的 `source`、codex 的 `scope`），
   * 厂商没给这一格时记 `ROW_SKILL_SOURCE_UNKNOWN`。
   *
   * 为什么是自由字符串而不是枚举（与 `RowMcpServerSchema.source` 逐字同一条理由）：
   * 厂商原值是**证据**，翻译成我们的词表就是第二个真源。`unknown` 是**我们**对这一格的
   * 如实交代，不是厂商的取值。行级这格**不重复**来源分档（那是厂商侧那格的事，见 `VendorSkillSchema`）。
   */
  source: z.string().min(1),
  /** 结论的依据通道（见 `RowSkillBasisSchema`） */
  judgedBy: RowSkillBasisSchema,
  /** 结论（见 `RowSkillVerdictSchema`） */
  verdict: RowSkillVerdictSchema,
});
export type RowSkillInstall = z.infer<typeof RowSkillInstallSchema>;

/**
 * 三档结论的中文文案。**放契约里**（与 `ROW_MCP_VERDICT_LABELS` 同一条理由）。
 * 界面上那三句话由它 + `ROW_SKILL_BASIS_LABELS` 拼出：`已装上 · 判据 厂商清单` /
 * `未验证 · 判据 仅落盘` / `缺失 · 判据 厂商清单`。
 */
export const ROW_SKILL_VERDICT_LABELS: Record<RowSkillVerdict, string> = {
  installed: '已装上',
  missing: '缺失',
  unverified: '未验证',
};

/** 三档判据来源的中文文案（同上一条理由） */
export const ROW_SKILL_BASIS_LABELS: Record<RowSkillBasis, string> = {
  'vendor-skill-list': '厂商清单',
  'vendor-prompt-listing': '厂商提示词清单',
  'local-materialized': '仅落盘',
};

/**
 * **配对规则**：判据来源与结论必须自洽，否则这一格会同时说两句互相拆台的话
 * （「没采到厂商清单」+「厂商清单里没有它」）。
 *
 * 三条都是**单向蕴含**（与 MCP 那一格的配对规则同一条口径）：
 *   · `installed` ⇒ 必须带厂商证据（`local-materialized` 说的是「只有落盘」，
 *     而「文件在盘上被当成结论」正是 MCP 那趟踩过的坑）；
 *   · `missing` ⇒ 只在 `vendor-skill-list` 下成立（另两档都没有「清单里没有它」所需的完整性）；
 *   · `unverified` ⇒ 配 `local-materialized`（它是「没有证据」那一档，凭落盘下的结论）。
 *
 * 唯一真源放在契约里：推导（evaluator）与守卫（`run.test.ts`）读同一份，
 * 免得「服务端写了一个不可能的配对、界面照着渲染」。
 */
export function isValidSkillPairing(entry: Pick<RowSkillInstall, 'judgedBy' | 'verdict'>): boolean {
  if (entry.verdict === 'installed') return entry.judgedBy !== 'local-materialized';
  if (entry.verdict === 'missing') return entry.judgedBy === 'vendor-skill-list';
  return entry.judgedBy === 'local-materialized';
}

export const EvalRowSchema = z.object({
  id: z.string().min(1),
  agentKind: AgentKindSchema,
  /** 执行期定位凭据用：按 id 去 config.providers 取 apiKey；供应商改名后这里仍指向同一条 */
  providerId: z.string().min(1),
  /** 冗余快照：供应商被改名或删除后仍能追溯这一行用的什么模型 */
  providerName: z.string(),
  baseUrl: z.string(),
  modelId: z.string(),
  status: EvalRowStatusSchema,
  /** test/{rowId}：用行 id 而非轮 id，否则同用例下多候选会互相踩 */
  branch: z.string(),
  workspacePath: z.string(),
  /** 40 位具体 hash；**空串 = 尚未准备**：创建时为 ''，prepare 阶段解析 HEAD 后由编排层写入 */
  baselineCommit: z.string(),
  /**
   * null = 该次运行未采到计量；**绝不填 0**。
   *
   * ⚠️ **这一格是「全树」合计**（主会话 + 我们数到的每一个子智能体）。
   * 子那一份单列在 `subagentTokens`。
   * 为什么写在这里：**老 `run.json` 里这一格存在、值也合法**，只是口径不同（当时只含主会话），
   * 而读侧无法从形状上分辨两者 ⇒ 跨期比较（对比表、历史轮次）必须知道这条分界线。
   */
  tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable(),
  turns: z.number().nullable(),
  /**
   * **子智能体那一份**用量：`tokens` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量。
   * **可选**：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮
   * （与 `attempts` / `effort` / `error.stage` 同一条理由）。
   */
  subagentTokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable().optional(),
  /**
   * **子智能体那一份**轮次：`turns` 是「主会话 + 全部子智能体」的合计，
   * 这一格是其中的分量（口径与 `subagentTokens` 同源）。
   * **可选**：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮。
   * `null` = 有子智能体但轮次读不到（**不是 0**：`0` 说的是「确实没有子智能体」）；
   * 恒有 `subagentTurns ≤ turns`（分量关系，逐格）。
   */
  subagentTurns: z.number().nullable().optional(),
  /**
   * **候选侧「没答」**（三态）——评分通路读的 `finalText` 区分不了两种「空」，
   * 而适配器这一侧其实分得开（`providers/codex/events.ts` 的空正文**显式排除**：
   * 它刻意不让空块把「没采到」伪装成「答复了空串」），丢的是**行/上报这一层**没有字段记下来。
   *
   *   · `true` —— 候选侧**没答**（运行成功、但适配器没交出任何正文）；
   *   · `false` —— 候选侧答了；
   *   · **缺席 / `null` —— 未记录**：旧 `run.json` 没这一格，或本次运行本身失败
   *     （此时契约明说 `finalText` 不保证是模型答复，**不能拿它判「没答」**）。
   *
   * 为什么是三态而不是「缺席即 `false`」：对**旧的** `run.json` 我们并不知道当时有没有答，
   * 读成 `false` 等于**断言「它答了」**——而 `false` 恰好是要防的那个误读方向（真出了空答复
   * 却照旧拿分的行，回看时反而显示正常）。同 `subagentTurns` 那条「缺席 = 未采集、不与 0 混同」
   * 的惯例（对比 `tokens` / `turns`：`.nullable()` 但不 `.optional()`，旧文件必须有）。
   */
  emptyAnswer: z.boolean().nullable().optional(),
  /**
   * **候选 agent 那一段的耗时**（有适配器结果时取适配器自报值，否则取编排层的掐表），
   * 不含评分阶段——开「使用智能体评分」的轮次里评分自己也要跑一次 CLI（分钟级），
   * 那一截不在这个数里；重新评分也不改它（它只跑评分那一步）。
   * 口径由 evaluator 的 `runRowAttempt` 第 5 步写入，那里有为什么这么定的两条理由。
   */
  durationMs: z.number().nullable(),
  /** 只存计数摘要，diff 正文按需现算 */
  diff: z
    .object({
      filesChanged: z.number(),
      insertions: z.number(),
      deletions: z.number(),
      truncated: z.boolean(),
    })
    .nullable(),
  score: ScoreResultSchema.nullable(),
  /**
   * 失败归因：`code` 必填——界面靠它区分「超时 / 限流 / 密钥无效 / 评分解析失败」，
   * 只留 message 的话界面只能按文案猜。它是 `z.string()` 而不是枚举：这一格要同时容纳
   * agents 包的 `AgentErrorCode` 与接口层的 `ErrorCode`（如 `JUDGE_PARSE_FAILED`）。
   */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      stack: z.string().optional(),
      /**
       * 失败发生在哪一段（见 `RowFailureStageSchema`）。
       * **可选**是载重的：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮
       * （与 `attempts` / `useAgentJudge` 同一条理由）。它**只是叙述性的事实记录**：没有任何判据读它
       * （`canRescoreRow` 只看「不在跑 + 有基线 + 有 diff」，`canRetryRow` 与它**逐字相同**，
       * 而 `canRunRow` 只有「不在跑」一条——相对它才多出「跑过没有」），留着是因为
       * 「这一笔失败发生在哪一段」是排障时最常问的那个问题。
       */
      stage: RowFailureStageSchema.optional(),
    })
    .nullable(),
  /**
   * 这一行走过的**执行尝试次数**（含失败的那些），未跑过为 0。
   *
   * 为什么要落盘：瞬时失败（网络 / 5xx / 限流）在我们这一侧是**自动重试**的，而自动重试必须留痕——
   * 否则「这一次为什么慢了两倍」在事后没有任何线索，且「试了三次才成功」与「一次就成功」在界面上
   * 长得一模一样（后者才是正常情况，前者说明上游不稳）。
   * `.default(0)` 是**载重**的（与 `useAgentJudge` 同一条理由）：老 `run.json` 里没有这一格，
   * 必填会让 `listRuns()` 静默跳过那一轮。
   */
  attempts: z.number().int().min(0).default(0),
  /**
   * 这一行要求的思考强度。**可选**：老 `run.json` 没有这一格，必填会让 `listRuns()`
   * 静默跳过那一轮（与 `attempts` / `useAgentJudge` 同一条理由）。
   * 记的是**我们要求的**档位，不是**实际生效的**档位（cc 可能静默降档）。
   * **未选 = 走该家适配器的缺省**（dsh 是 `high`；claude / codex 是不传、由厂商推断），
   * **不是**「沿用厂商默认」也不是「关闭」；要关闭必须显式写 `EFFORT_OFF`（见 `./provider`）。
   */
  effort: z.string().min(1).optional(),
  /**
   * 这一行的**流式增量观测**：跑这一行时到底有没有、有多少条增量帧。
   *
   * 为什么需要它：增量帧**只广播不落盘**（`messages.jsonl` 里只有快照）⇒ 「本次有没有真的收到逐字流」
   * 在事后**没有任何痕迹**。而这件事的答案与厂商声明是两回事：声明 `yes` 的家可能在这一次什么都没投
   * （开关没生效 / 插件没挂上 / 厂商改了内部事件名），症状是「界面上就是不打字」，与「这家本来就没有」
   * 长得一模一样。这一格把两者分开，且**只记运行期证据、绝不回改厂商级静态声明**（声明是能力事实，
   * 证据是这一次的事实，混在一起会让声明随运行漂移）。
   *
   * **三态，且每态都必须可分辨**（缺一态就会有「观测到零帧」被读成「没观测」）：
   *   · **缺席 / `null`** = 未观测（老 `run.json` 没有这一格；这一行也没跑到统计那一步）；
   *   · **`frameCount === 0`** = 观测了，这一次**一条增量帧都没有**——就落这一格，不许与上一态合并；
   *   · **`frameCount > 0`** = 有增量，`lastFrameChars` 是**最后一帧**的累积正文字符数。
   *
   * `lastFrameChars` 是给**中断行**复盘用的：增量不落盘 ⇒ 半截正文刷新后见（口径见
   * `evaluator/src/row-messages.ts` 的分叉注释），这一格至少回答「它当时写到哪」。
   * 它**不是**「这一行写了多少字」：帧是累积值、不同合并键各自累积，这里取的是最后那一条帧的读数。
   *
   * **可选**：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮（与 `attempts` /
   * `subagentTokens` 同一条理由）。
   */
  streamingDelta: z
    .object({
      /** 转给实时通道的增量帧数（一条帧 = 一次 `onMessage` 的 `chunk === 'delta'`） */
      frameCount: z.number().int().min(0),
      /** 最后一帧的累积正文字符数（`text` 与 `thinking` 块的正文合计） */
      lastFrameChars: z.number().int().min(0),
    })
    .nullable()
    .optional(),
  /**
   * 这一行的 **MCP 观测格**（「本行 MCP」）：逐台记
   * **名称 / 来源 / 判据来源 / 结论**。
   *
   * 为什么单独立一格（而不是让界面去 `events.jsonl` 里现推）：事件流回答的是「厂商当时说了什么」，
   * 而这里要回答的是「**这一行实际装上了哪几台、我们凭什么这么说**」——后者要能刷新后复盘、
   * 也要能对**环境变量未设置而被我们主动跳过**的那几台给出结论（厂商事件里根本没有它们）。
   * 推导只在编排层做一次（`evaluator` 的 `deriveRowMcpServers`），界面只渲染，不重推。
   *
   * ⚠️ **判据不许是模型答复**：模型可能把「MCP 派发失败」的结果直接编出来 ⇒ `verdict` 的每一档
   * 都只由**厂商事件侧**的证据支撑（`judgedBy` 就是那条证据的名字），`connected` 更是要求工具表里
   * 真的出现 `mcp__<name>__*`（比厂商自报的 `status` 更硬）。
   *
   * **三态与 `streamingDelta` 逐条同构**：
   *   · **缺席 / `null`** = 未观测（老 `run.json` 没有这一格；这一行也没跑到候选执行）；
   *   · **`[]`** = 观测了，本行一台 MCP 都没有——不许与上一态合并（那是「压成没观测」的老毛病）；
   *   · 非空 = 逐台四格。
   *
   * **可选**：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮（与 `attempts` /
   * `subagentTokens` 同一条理由）。
   */
  mcpServers: z.array(RowMcpServerSchema).nullable().optional(),
  /**
   * 这一行的**技能观测格**（「本行技能」）：逐条记**名称 / 来源 / 判据来源 / 结论**。
   *
   * 与 `mcpServers` 回答两个不同的问题（两格分属两组，不合并）：`vendor-system.skills` 回答
   * 「**厂商当时说它手里有哪几条**」，这一格回答「**这一行实际装上了哪几条、我们凭什么这么说**」
   * ——后者要能对「厂商清单里没有它」（`missing`）下结论，而那条结论只有编排层同时拿得到
   * 我们的装入清单与厂商证据时才推得出来。
   *
   * ⚠️ **判据不许是模型答复**（硬要求，与 MCP 那一格同源）：本格一个字都不读消息流。
   * 真机抓到过「skill 没调上、模型却把结果编出来」——模型说「我按技能做了」在证据等级上是零。
   *
   * **三态与 `streamingDelta` / `mcpServers` 逐条同构**：
   *   · **缺席 / `null`** = 未观测（老 `run.json` 没有这一格；评分行不装技能）；
   *   · **`[]`** = 观测了，本行一条技能都没装——用户把清单全停用是**有意义**的状态，
   *     不许与上一态合并（那是「压成没观测」的老毛病）；
   *   · 非空 = 逐条四格。
   *
   * **可选**是载重的：老 `run.json` 里没有这一格，必填会让 `listRuns()` **静默跳过那一轮**
   * （与 `attempts` / `mcpServers` 同一条理由）。`.nullable()` 也必须在：读侧要同时容纳
   * 「字段缺席」与「显式 `null`」两种历史形态（写侧永不写 `null`——装入是我们自己的动作，
   * 不存在「第三方没投送」这回事）。
   */
  skillInstall: z.array(RowSkillInstallSchema).nullable().optional(),
  /**
   * 这一行跑在哪条**会话**上（`null` = 没有可续接的会话）。
   *
   * 为什么落进行快照：续接（第二期）复用工作区与会话再跑一段，而厂商侧的会话数据本来就落在行工作区里、
   * 跑完不清——唯一要落的就是这个 id 本身。**不冗余 `agentKind`**：行上本来就有，续接时拿它校验
   * id 没串家即可（同一形状的字段出现两处，下一个人必然要问哪个是真的）。
   *
   * `.default(null)` 是**载重**的（与 `attempts` / `useAgentJudge` 同一条理由）：老 `run.json` 里
   * 没有这一格，必填会让 `listRuns()` 静默跳过那一轮。缺格读成 `null` 也是语义正确的兜底——
   * **旧产物就是不能续接**，界面要给中文原因，**不许静默从头跑一遍**。
   */
  sessionId: z.string().min(1).nullable().default(null),
  /**
   * 这一行**已经送达的人工消息条数**（一条都没有为 0）：卡片上的「人工追问 ×N」读它，
   * **与消息账本对齐**（账本里 `origin: 'human'` 的条数）、不与队列表对齐——队列表里还有
   * 没投出去与已经消失的，那些模型一个字都没看到。
   *
   * 为什么落快照而不是让界面去数账本：列表视图的成本会随轮次数涨，而这一格是**一行一个数**。
   * 代价是「账本与计数」两份数据必须一致 ⇒ 计数递增与那一条落账本**必须在同一段代码里发生**。
   *
   * 它数的**不是追问轮次**（那是 `followUpRounds`）：人往运行中的一轮送的话与追问各算各的，
   * 一格兼两义的结果是「先送进去 2 条、再追问 1 次」被读成「追问了 3 次」。
   *
   * `.default(0)` 与 `attempts` 同一条理由（老 `run.json` 没有这一格）；非负整数是因为
   * 计数只增不减——负数与小数都不是「几条人话」。
   */
  followUps: z.number().int().min(0).default(0),
  /**
   * 这一行走过的**人工追问轮次**（没追问过为 0）：行日志里那句「第几次追问」读它。
   *
   * 与 `followUps` 分开的理由就是「一格不许兼两义」：追问一次会同时推进两个读数（它自己也是
   * 一条已送达的人话），运行中送进去的人话只推进 `followUps`。合成一格之后，
   * 「先有 2 条注入、再追问 1 次」的日志会写成 `[人工追问 ×3]`——用户读到的是三次追问，
   * 其中两次根本不存在。追问的序号（`[人工追问 ×N]` 里的 N）**必须**读这一格。
   *
   * `.default(0)` 与 `followUps` 同一条理由：老 `run.json` 没有这一格，必填会让 `listRuns()`
   * 静默跳过那一轮；缺格读成 0 也是语义正确的兜底（那一轮确实没追问过）。
   */
  followUpRounds: z.number().int().min(0).default(0),
  /**
   * **回到某一轮**留下的作废标记（追加，不删不改账本原文）。
   *
   * 每一条回答「从哪一点重开、作废到哪一段为止、作废那一截自己的量是多少」，读侧据此把作废段
   * 从历史 / 轮次计数 / 用量 / 排名里默认滤掉（判据见 `checkpoint.ts`）。
   *
   * **可选**是载重的：旧 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮；
   * 缺席读作「一无所作废」也是语义正确的兜底——老数据本来就没有回到过某一轮。
   * 这里**只追加、不重写**：一次回到某一轮给数组新增一条，账本（`messages.jsonl` /
   * `events.jsonl`）一行都不动。
   */
  checkpointVoids: z.array(CheckpointVoidSchema).optional(),
});
export type EvalRow = z.infer<typeof EvalRowSchema>;

/** 这一行的**流式增量观测**（`EvalRow.streamingDelta` 的形状，供 orchestration 与界面共用） */
export type RowStreamingDelta = NonNullable<EvalRow['streamingDelta']>;

export const EvalRunSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  /** 冗余快照：用例被删除后仍能追溯这一轮测的是什么 */
  caseTitle: z.string(),
  /**
   * 这一轮的**用户备注**（自由文本，空串 = 没写）：创建 / 编辑表单里的「备注」，用来记录
   * 这一次测试的目的（如「对比模型不同版本间的差异」）。评测列表的「标题」列把它接在用例标题后面，
   * 评测详情顶部也显示一行。
   *
   * 它不是用例快照：换用例不会重取它，只在编辑表单里改。
   *
   * `.default('')` 是**载重**的：磁盘上已有的 `run.json` 没有这一格，必填会让 `listRuns()`
   * **静默跳过那一轮**（与 `includeSteps` / `askUser` 同一条理由）；空串也是语义正确的兜底——
   * 老轮次本来就没有备注。
   */
  note: z.string().default(''),
  repoPath: z.string(),
  commitHash: z.string().nullable(),
  /** 冗余快照：用例被改分支或删除后，这一轮从哪个分支起跑仍可追溯（与 repoPath 同口径） */
  repoBranch: z.string().min(1).nullable().default(null),
  /**
   * 冗余快照：**这一轮用的是哪张评分表**（与 caseTitle / repoPath / repoBranch 同一条口径）。
   * 为什么必须快照：评分阶段读的是它而不是 `testCase.rubric`——改了用例的评分表之后，
   * 历史记录里的分数与它自己的满分仍然自洽，「重新评分」用的也仍是当初那把尺子。
   * **必填**：旧 run.json 没有这一格会 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮
   * （旧评测记录因此必须清掉）。
   */
  rubric: RubricSchema,
  /**
   * 创建时的「包含步骤」快照（与 `rubric` 同一条链：创建时从用例拍下、rescore 沿用、改用例不影响）。
   * `.default(false)` 是**载重**的：磁盘上已有的 `run.json` 没有这一列，必填会 `safeParse` 失败 ⇒
   * `listRuns()` 静默跳过那一轮；false 也是语义正确的兜底——老一轮评测本来就是「评分只看最终改动」。
   */
  includeSteps: z.boolean().default(false),
  status: z.enum(['idle', 'running', 'partial', 'done']),
  executionMode: ExecutionModeSchema,
  /**
   * 创建时的评分方式快照。`.default(false)` 是**载重**的：磁盘上已有的 `run.json` 没有这个字段，
   * 没有默认值就会 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮、`getRun()` 抛 INTERNAL
   * （使用者看到的是「我的评测记录凭空少了几轮」，两端都不报错）。
   */
  useAgentJudge: z.boolean().default(false),
  /**
   * 这一轮**有没有应答面**（模型问到人时有没有人能答）。`.default(false)` 是**载重**的：
   * 磁盘上已有的 `run.json` 没有这一格，必填会让 `listRuns()` 静默跳过那一轮（与
   * `useAgentJudge` 同一条理由）；`false` 也是语义正确的兜底——默认不介入。
   *
   * 为什么是**轮级快照**而不是一个全局设置：它是「有人介入过这一轮」这件事的唯一凭据。
   * 开着它的一轮里适配器会**挂厂商钩子 / 注册宿主工具 / 改权限档**（「不问就不动」那条边界的另一半），
   * 于是这些轮的产物与没开过的**不可直接比**（时长里含等人的时间，模型也可能因为问到了信息而少走弯路）。
   * 快照落盘之后，事后复盘不必去猜「这一行为什么停了三分钟」，横向对比也能按这一格分组。
   */
  askUser: z.boolean().default(false),
  /**
   * 这一轮**允不允许人往运行中的智能体发消息**（输入区闸门）。`.default(false)` 与 `askUser` 逐字
   * 同一条理由：磁盘上已有的 `run.json` 没有这一格，必填会让 `listRuns()` 静默跳过那一轮；
   * `false` 也是语义正确的兜底——**关着的时候适配器一格都不挂**，既有行为因此逐字不变。
   *
   * 为什么是**轮级快照**：开着它的一轮里产物与没插过话的**不可直接比**（人可能改变了任务走向），
   * 复盘时它是「这一轮被人介入过」的唯一凭据。`available === false` ⇒ 适配器一格都不挂，
   * 这就是「零回归」的判据。
   */
  injectMessages: z.boolean().default(false),
  rows: z.array(EvalRowSchema),
  workspaceBase: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

/** 创建评测：每候选行给智能体 + 供应商 + 模型；供应商名与 baseUrl 由服务端快照进行 */
export const RunCreateSchema = z.object({
  caseId: z.string().min(1),
  /**
   * 这一轮的备注（可选；缺省 = 没写，由 api 层收敛成 `EvalRun.note` 的空串）。
   *
   * **必须显式声明**：zod 3 的 `z.object` 默认 strip 未知键，不声明的话表单提交的备注会被
   * **静默丢弃**（不是 400），服务端永远收不到它。与 `askUser` / `injectMessages` 同一条理由。
   *
   * 用 `.optional()` 而不是 `.default('')`：这是**用户写的注解**，入参不必让每个调用方都补一份
   * 空串；磁盘上的形状（`EvalRunSchema.note`）才是永远有这一格的字符串。
   */
  note: z.string().optional(),
  executionMode: ExecutionModeSchema,
  /** 这一轮是否由评分智能体评分；缺省 false（老客户端与手工 POST 不带这个字段时仍然合法） */
  useAgentJudge: z.boolean().default(false),
  /**
   * 这一轮是否开启**应答面**（模型提问时等人回答）；缺省 false。
   *
   * **必须显式声明**：zod 3 的 `z.object` 默认 strip 未知键，不声明的话表单提交的这一格会被
   * **静默丢弃**（不是 400），服务端永远收不到它——而它的默认值恰好是「关」，
   * 于是「界面打开了、跑起来却没应答面」是一种没有任何报错的坏形状。
   */
  askUser: z.boolean().default(false),
  /**
   * 这一轮是否**允许人往运行中的智能体发消息**（输入区闸门）；缺省 false。
   *
   * **必须显式声明**（与 `askUser` 逐字同一条理由）：zod 3 的 `z.object` 默认 strip 未知键，
   * 不声明的话表单提交的这一格会被**静默丢弃**（不是 400），服务端永远收不到它——
   * 而它的缺省恰好是「关」，于是「界面打开了输入区、跑起来却一格都不挂」是一种没有任何报错的坏形状。
   */
  injectMessages: z.boolean().default(false),
  rows: z
    .array(
      z.object({
        agentKind: AgentKindSchema,
        providerId: z.string().min(1),
        modelId: z.string().min(1),
        /**
         * 这一行要求的思考强度（可选）。**必须显式声明**：zod 3 的 `z.object` 默认 strip 未知键，
         * 不声明的话表单提交的强度会被**静默丢弃**（不是 400），服务端永远收不到它。
         */
        effort: z.string().min(1).optional(),
      }),
    )
    .min(1),
});
export type RunCreate = z.infer<typeof RunCreateSchema>;

/**
 * 编辑交回的「这一轮应当长成什么样」：与创建的差别只有候选行可带 `id`（指认原来那一行）。
 * 为什么是**超集**而不是另一个形状：编辑表单与创建表单是同一张（`RunCreatePanel` 的 `mode`），
 * 字段表必须共用一个真源；两份形状各写一遍必然漂移成「创建能改的编辑改不了」。
 * 创建路径**不读** `id`（`RunCreateSchema` 逐字不变），服务端也不会把带 id 的创建入参当编辑读。
 *
 * 行元素是**派生**出来的（`RunCreateSchema.shape.rows.element.extend(...)`），不是把
 * `agentKind` / `providerId` / `modelId` 再抄一遍：手抄的那份在创建侧新增一个**可选**字段时
 * 会静默把它剥掉（两份都解析成功，只有「少一个字段」这件事没人看得见），而 `run.test.ts` 有一条
 * 守卫直接比两边的**键集合**，钉住「差一处，且只有这一处」。
 */
export const RunUpdateSchema = RunCreateSchema.extend({
  // `.array().min(1)` 仍写在数组这一层：zod 没有「读取既有数组约束」的公开 API（`_def.minLength`
  // 是内部实现），故这里与创建侧同值——它不参与上面那条键集合守卫，改创建侧的 `.min(1)` 时要一并改。
  rows: RunCreateSchema.shape.rows
    .element.extend({
      /** 有 id = 原地更新这一行（并保留它的结果）；没有 = 新增一行 */
      id: z.string().min(1).optional(),
    })
    .array()
    .min(1),
});
export type RunUpdate = z.infer<typeof RunUpdateSchema>;

/**
 * 「变更详情」抽屉首帧：文件索引，**不含任何 diff 正文**。
 *
 * 为什么拆成两个形状：正文有 256 KB 硬预算，但 `files` 没有上限——
 * 一次改一万个文件，旧形状会把一万条条目与正文一起塞进一个响应，那才是会卡死的那一步。
 * 索引负责「有哪些文件、大概改了多少」，正文按需另外取。
 *
 * `insertions` / `deletions` 是**全部文件**的合计（不是本页）：头部的
 * 「共 N 个文件 · +X −Y」要的是全局值，按页累加会让数字在翻页时跳动。
 */
export const RowDiffIndexSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      insertions: z.number(),
      deletions: z.number(),
      /** 该文件出现在「### 未跟踪文件」段里（`??` 新文件） */
      untracked: z.boolean(),
      /** 该文件是否有正文可取。false = 被 diffBudgetBytes 丢弃，界面不给加载入口 */
      hasBody: z.boolean(),
    }),
  ),
  /** 文件总数（不受分页影响） */
  total: z.number(),
  /** 本页起始下标 */
  offset: z.number(),
  insertions: z.number(),
  deletions: z.number(),
  /** 全部文件里有多少个没有正文（被预算丢弃） */
  noBodyCount: z.number(),
  truncated: z.boolean(),
  /** 被预算丢弃的文件名——语义逐字保留：评分模型看不到它们 */
  droppedFiles: z.array(z.string()),
});
export type RowDiffIndex = z.infer<typeof RowDiffIndexSchema>;

/**
 * 单个文件的改动正文。
 *
 * **没有 `truncated` 字段**：`truncateDiff` 按**整文件**丢弃，永远不会把一个文件的正文切一半，
 * 故「这个文件的正文被截断了」这个状态不可能出现；留一个恒为 false 的字段只会诱使下一个人
 * 写一条永远进不去的分支。被丢弃的文件根本走不到这个接口（api 层对它抛 CONFLICT）。
 */
export const RowDiffFileSchema = z.object({
  path: z.string(),
  /** 统一 diff 原文（该文件那一段） */
  patch: z.string(),
  insertions: z.number(),
  deletions: z.number(),
  /** 二进制/无文本改动：true 时界面不渲染 diff 视图 */
  binary: z.boolean(),
});
export type RowDiffFile = z.infer<typeof RowDiffFileSchema>;

/**
 * 「开始」按钮的可执行行判定：终态里除了 judged 都可重跑。
 * judged 排除在外是刻意的——已经出分的行不该被一次误点重跑掉几十分钟。
 */
export function isRunnableRow(status: EvalRowStatus): boolean {
  return (
    status === 'pending' ||
    status === 'failed' ||
    status === 'timed-out' ||
    status === 'canceled' ||
    status === 'interrupted' ||
    status === 'skipped'
  );
}

/** 该行此刻是否在跑（含准备与评分两段）：界面靠它禁用「开始」与启用「终止」 */
export function isRunningRow(status: EvalRowStatus): boolean {
  return status === 'preparing' || status === 'running' || status === 'judging';
}

/**
 * 这一轮此刻还有活在跑吗（轮级 running，或任一行处于 preparing / running / judging）。
 *
 * 这是**编辑与删除共用**的那一条判据：两个动作的可用条件是同一条（「不在运行中」），
 * 做成 `canEditRun` / `canDeleteRun` 是假一对。判据放 contracts 的理由与
 * `isRunnableRow` / `isRunningRow` / `canRescoreRow` / `canRetryRow` 逐字相同：
 * 界面靠它决定按钮的 `disabled`、服务端靠同一份抛 `CONFLICT`——两处各写一份必然漂移，
 * 漂移的表现是「按钮可点、点下去 409」。
 *
 * 为什么轮级状态也要看：`startRun` 把 `status: 'running'` **同步**落库、而行要等各自的任务起来
 * 才翻状态，中间那一拍只有轮级状态能反映「已经在跑了」。它**不是**「有没有行跑过」，
 * 也**不是**「能不能重新评测」——那两条各有自己的判据。
 */
export function hasLiveRows(run: EvalRun): boolean {
  return run.status === 'running' || run.rows.some((row) => isRunningRow(row.status));
}

/**
 * 编辑交回的这一行与现有行还是不是同一件事（`agentKind` / `providerId` / `modelId` / `effort` 逐字比较）。
 *
 * 为什么它必须在 contracts：这条判据有两个消费方——服务端的 `planRunUpdate` 用它决定重置哪一行，
 * 编辑表单用它**事先算出本次会作废哪几行**（保存前的确认框）。两处各写一份必然漂移，
 * 漂移的症状是「确认框说会作废 2 行，实际作废了 1 行」——而那正是用户唯一能核对的地方。
 * `providerName` / `baseUrl` 是服务端快照（供应商改名后它们会变），**不参与**判定：
 * 改个供应商名字不该把一行已经跑出来的成绩打掉。
 *
 * **强度（`effort`）参与判定，且「一侧没给」算改了**：档位是**被评对象**的一部分——
 * 同一个模型、同一家供应商，把 high 改成 low 跑出来的是另一次评测，旧分数不能留在快照里。
 * 为什么缺省按「改了」处理、而不是按「和上次一样」：编辑载荷是候选行集合的**全量替换**（
 * 表单交回来的永远是全量行集合，不是补丁），所以「这一格没有」只能读成「未指定档位」，
 * 读不出「沿用原来那一档」。这是**安全方向**——宁可多重置一行，也不能静默保留一个用户已经改过的
 * 档位跑出来的分（那正是本判据存在的理由）。
 * 编辑表单会回传它。**不回传的客户端，代价要说全**（本条是唯一记录这一支的地方）：
 * 判成「改了这一行」之后，那一行会被 `resetRow` **原地重置**——不只是「要重跑一次」，落盘的
 * `effort` 键也会被删掉（`api/src/runs.ts` 的重置按 resolved 那一格重建，缺省即不写键：界面从此
 * 显示「默认」档），连同这一行的 `score` / `diff` / 计量与 `attempts` 一起归零——用户看到的分数
 * 当场消失。本仓的编辑表单有一道保存前确认框会点名这些行（`invalidatedRows` 用的就是这条判据），
 * 而**不回声 effort 的客户端**没有那道提示：它的丢分是静默的。
 */
export function isSameRowTarget(
  row: EvalRow,
  next: { agentKind: AgentKind; providerId: string; modelId: string; effort?: string },
): boolean {
  return (
    row.agentKind === next.agentKind &&
    row.providerId === next.providerId &&
    row.modelId === next.modelId &&
    // `?? null` 把 undefined 与「缺这一格」并成同一格：两者都是「没指定档位」，不该被当成两种状态
    (row.effort ?? null) === (next.effort ?? null)
  );
}

/**
 * 该行能否「重新评分」：不重跑候选 agent，只在**既有工作区**上重跑评分步骤。
 * 三个条件缺一不可（用户口径「已出分、无报错时取消禁用」，故**不**要求 `error.stage === 'judge'`——
 * 那一条会把已经出分的行与候选阶段失败的行都挂上禁用）：
 *   · 不在运行中——正在跑的行有自己的生命周期，终止它是另一件事；
 *   · `baselineCommit !== ''`——prepare 阶段成功过，diff 才有可比基线；
 *   · `diff !== null`——collectDiff 跑过，说明候选 agent 阶段已经结束、有可复评的产出。
 * 于是可重评的面＝「跑过一次、产出了改动」的所有终态（`judged` / `failed` / `timed-out` /
 * `canceled` / `interrupted`），**与这一行是否失败过无关**。
 *
 * 为什么可以这么宽：重新评分不碰候选 agent（几十秒、不动工作区），它的语义就是「用本轮同一把尺子
 * 再量一次」——换了评分模型、改了评分标准项、或者只是想要一次可复现的重算，都要走它。
 * 代价（会把现有分数先清空、重评失败就丢掉旧分）由界面上的 `Popconfirm` 明说，
 * 而**不是**由判据替使用者做决定。
 *
 * `error.stage` **不再**是判据的一部分（那一格仍在落盘：它是「这一笔失败发生在哪一段」的事实记录，
 * 排障时要看；只是不再决定任何按钮的 `disabled`）。
 *
 * 判据放 contracts 而不是服务端独有：界面要靠它决定按钮的 `disabled`，而服务端要拿同一份判据
 * 抛 CONFLICT。两处各写一份必然漂移，漂移的表现是「按钮可点、点下去 409」——与
 * `isRunnableRow` / `isRunningRow` 同一个落点、同一条理由。
 */
export function canRescoreRow(row: EvalRow): boolean {
  return !isRunningRow(row.status) && row.baselineCommit !== '' && row.diff !== null;
}

/**
 * 该行能否**重新执行**（连候选 agent 带评分整段重跑；不重跑整轮、不重跑别的行）。
 * 界面上的按钮文案就是「重新执行」，内部名仍是 `retryRow` / `useRetryRow` / `.../retry` 路由
 * （改名要动全链路，而名字与文案的对应关系记在这里就够）。
 *
 * 语义上与 `canRescoreRow` **不是同一件事**（今天的条件恰好同形，历史上分叉过一次）：
 *   · 重新执行 = 候选 agent 与评分都重跑（工作区重新准备、分支重建）——「重跑这一行」；
 *   · 重新评分 = 保留候选产出，只重跑评分那一步——「重算这一行的分」。
 * 界面上是两个按钮，成本差一个数量级（分钟级 vs 几十秒），故不做成一个。
 *
 * 判据与 `canRescoreRow` 相同：「不在跑 + 有可比基线 + 有已产出的改动」。
 * **`judged` 不再是排除项**（口径「已出分、无报错时取消禁用」）：整段重跑一次
 * 已出分的行是分钟级成本，由 `Popconfirm` 二次确认拦一次，判据不再替使用者说不。
 * 硬前提仍然挡着「没跑过」的行——没有可比基线时重跑得到的 diff 没有对照物。
 */
export function canRetryRow(row: EvalRow): boolean {
  return !isRunningRow(row.status) && row.baselineCommit !== '' && row.diff !== null;
}

/**
 * 该行能否**单跑**（只跑这一行：候选 agent 与评分整段跑一遍，本轮其他行一律不动）。
 * 用户口径：「重新执行，只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
 *
 * 与 `canRetryRow` 的差别**只有一条**：「跑过没有」。`canRetryRow` 要求「有可比基线 + 有已产出的改动」
 * ——它回答的是「**重**跑这一行有没有对照物」；本判据只要求「不在跑」——它回答的是
 * 「能不能**就现在**把这一行跑起来」。所以**没跑过的行**（`pending` / `skipped`）也在这里放行。
 *
 * 为什么需要它：没跑过的行只能靠「开始」跑，而「开始」的语义是**所有可执行行**
 * （`isRunnableRow`）——想单独跑三行里的第二行时，它会把失败过的行一起重跑一遍，
 * 而「我只想跑这一个候选」在那条路上**无处表达**。
 *
 * 两个判据的**单调关系**（测试里有一条守卫钉着）：能重新执行 ⇒ 必然能单跑，反之不然。
 *
 * 它**不是**「这个按钮该不该显示」的判据：界面上那一个按钮的文案按行态分叉
 * （没跑过 = 「开始执行」、跑过 = 「重新执行」），可用性由本判据与「有别的执行在途」一起决定；
 * 而服务端在「上一次运行还没收尾」（`rowAborts` / `retryTasks` 里还有这一行）时仍会拒——
 * 那一格在编排层，契约看不见（同 `rescoreRefusal` 的 `settling`，见 evaluator 的注释）。
 */
export function canRunRow(row: EvalRow): boolean {
  return !isRunningRow(row.status);
}

/**
 * 「这次追问带的附件还在不在」的**事实**（`FollowUpFacts.attachments`）。
 *
 * 分三态而不是一个布尔：两种「没了」的处置不同——整棵附件根被清理过（`prepareRowWorkspace` /
 * `deleteRun` 干的）要把这一批重新上传一遍，而某一份文件被手工删掉只要补那一份。合成一句
 * 「附件没了」会把读者引向错的动作。`present` 也在值域里：这一格是「查过了、都在」，
 * 与「这次没带附件」（`null`）必须分得开。
 */
export type FollowUpAttachmentFact =
  | { state: 'root-missing'; root: string }
  | { state: 'missing'; paths: readonly string[] }
  | { state: 'present' };

/**
 * 追问判据要的**外部事实**：契约层读不了盘、也认不出厂商（它的依赖里只有 zod），
 * 故这几格由调用方量好递进来。
 *
 * 两个消费方量的是同一份东西、时机不同：编排层在**真追问**那一刻量（附件那一格来自请求体），
 * 服务端的可用性读侧在**渲染入口之前**量（那时还没有草稿，附件那一格恒为 `null`）。
 * 判据与文案因此只有这一份——两处各写一遍必然漂移，而漂移的表现正是「按钮写着能追问、点下去 409」。
 */
export interface FollowUpFacts {
  /**
   * 上一次运行**收了尾没有**（行已落终态，而 `rowAborts` / 在途追问任务里还有这一行）。
   * 这一格只有编排层量得到：那一刻放行会与迟到的旧任务抢状态（同 `rescoreRefusal` 的 `settling`）。
   */
  settling: boolean;
  /** 这一行的工作区目录此刻还在不在盘上（`workspacePath` 为空一律算不在） */
  workspaceExists: boolean;
  /**
   * 这一行的用例：`deleted` 带上 id——原因里要点名是哪一个用例没了（`run.caseId` 在轮上、
   * 不在行上，故它只能从事实这一侧进来）。
   */
  case: { state: 'present' } | { state: 'deleted'; caseId: string };
  /** 这次追问带的附件查下来是什么结果；`null` = 这次没带附件（无需查） */
  attachments: FollowUpAttachmentFact | null;
  /** 这一家声明的续接那一格（`turnInjection.resume`）；`undefined` = 能力表里没这一组 */
  resume: TurnInjectionCell | undefined;
}

/**
 * 追问判据的答复：**可行 + 不可行的中文原因**。
 *
 * 做成判别联合而不是 `{ ok: boolean; reason: string | null }`：后者允许「不可行却没原因」与
 * 「可行却带原因」两种说不通的组合存在，而界面要靠这一格直接说一句人话（不留半句）。
 * 形状与 `validateRubric` 同源（契约里既有的那条「结论 + 原因」）。
 */
export type FollowUpVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 「这一家为什么接不上会话」的一句实话。
 *
 * 四种「没有」必须分开说（结构上没有 / 厂商有但我们没接 / 版本没到 / 没验过 / 连声明都没读到）：
 * 合成一句会把排查引向错的动作——`turnInjection` 那五态词表就是为这件事存在的。
 * 能接（`yes`）时返回 `null`：这一格只回答「为什么不行」，不问「为什么行」。
 */
function resumeRefusalReason(agentKind: AgentKind, resume: TurnInjectionCell | undefined): string | null {
  const label = AGENT_LABELS[agentKind];
  if (resume === undefined) return `${label}没有声明「能不能续接会话」（能力表缺席按不知道处置）`;
  if (resume.state === 'yes') return null;
  if (resume.state === 'off-by-adapter') {
    return resume.gate === null
      ? `${label}的续接还没接上（厂商侧有那条路，我们这一侧没接）`
      : `${label}的续接要 ${resume.gate.version} 及以上才够得到（本仓 pin 的那一版没有）`;
  }
  if (resume.state === 'unverified') return `${label}的续接还没验证过`;
  return `${label}这一家结构上没有续接会话的落点`;
}

/**
 * 该行此刻能否**追问**：人补一句话，让它接着同一段会话再跑一段（不重建工作区、不重置计量、
 * 跑完自动重评）。
 *
 * 七档拒绝，顺序即**处置的紧急程度**；前两档与后五档分开——它们不是「这一行不能追问」，
 * 而是「此刻不是追问的时机」：
 *   ① 正在跑（`preparing` / `running` / `judging`）**或还没开始跑**（`pending`）：那句话该发进
 *      输入区**排队**，等这一轮跑完再追问。`pending` 与在跑的行同一档处置：它连会话都还没有，
 *      但它不是「这一行接不上」——把它读成后者会把人引向「重新执行」，而用户要的只是先把话排上队；
 *   ② 上一次运行还没收尾：该等（这一格只有编排层量得到，见 `FollowUpFacts.settling`）；
 *   ③ `sessionId === null`：还没跑过 / 没有这一格的旧产物 / 上一次没采到会话 id；
 *   ④ 工作区已被删除（`deleteRun` 删过、手工清过，或这一行从没准备成功过）；
 *   ⑤ 追问带的附件没了（整棵根没了 / 某一份没了）；
 *   ⑥ 用例已删除；
 *   ⑦ 这一家接不上会话（声明不是 `yes`，原因逐档分开说）。
 *
 * **为什么判据放 contracts**：界面靠它决定「追问」按钮的 `disabled` 与 Tooltip 文案、服务端拿
 * 同一份抛 `CONFLICT`——与 `canRescoreRow` / `canRetryRow` / `canRunRow` 同一个落点、同一条理由。
 * ⑦ 那一档的判据与文案**也在这里**（从事实里的声明读，不认厂商）：界面若自己编一句
 * 「这一家不支持续接」，那与厂商声明就是两份说法。
 *
 * ⚠️ **绝不静默从头跑一遍**是这一族判据存在的根：`runRow` 的第一步是 `prepareRowWorkspace`
 * （整删 `workspace/` + `.agenthome/`，后者正是要续接的会话的落点）。放行一条接不上的追问，
 * 用户看到的是「智能体什么都不记得了」，而界面上一切正常——那是这一面最坏的一种失败。
 */
export function canFollowUpRow(row: EvalRow, facts: FollowUpFacts): FollowUpVerdict {
  const refuse = (reason: string): FollowUpVerdict => ({ ok: false, reason });

  if (isRunningRow(row.status) || row.status === 'pending') {
    // 「正在跑」与「还没开始跑」是两句话（用户看到的那一刻状态不同），但处置**完全相同**：
    // 那句话发进输入区排队等这一轮跑完。它**不是**「这一行接不上」——落到第 ③ 档会把人引向
    // 「重新执行」，而那与用户想做的事（先把话排上队）正好相反
    const state = row.status === 'pending' ? '还没开始跑' : '正在运行中';
    return refuse(
      `该行${state}（${ROW_STATUS_LABELS[row.status]}）：请把这句话发进输入区排队，等这一轮跑完；`
        + '追问只对已经跑过的行有效',
    );
  }
  if (facts.settling) {
    return refuse('该行上一次的运行还没收尾，请稍候再试');
  }
  if (row.sessionId === null) {
    return refuse(
      '这一行没有可续接的会话（还没跑过，或是没有这一格的旧产物）：追问接不上原来那段上下文，'
        + '这里不会从头重跑该行——要重跑请点「重新执行」',
    );
  }
  if (row.workspacePath === '' || !facts.workspaceExists) {
    const where = row.workspacePath === '' ? '没有记录过工作区路径' : row.workspacePath;
    return refuse(
      `这一行的工作区已被删除（${where}）：追问要在原工作区上继续，这里不会从头重跑该行——`
        + '要重跑请点「重新执行」',
    );
  }
  if (facts.attachments !== null && facts.attachments.state !== 'present') {
    const because = facts.attachments.state === 'root-missing'
      ? `追问带的附件根不存在（${facts.attachments.root}）：附件随该行的工作区一起被清理过，请重新上传再追问。`
      : `追问带的附件不存在（${facts.attachments.paths.join('、')}）：请重新上传再追问。`;
    return refuse(`${because}这里不会从头重跑该行——要重跑请点「重新执行」`);
  }
  if (facts.case.state === 'deleted') {
    return refuse(`用例已删除（${facts.case.caseId}），无法追问；历史记录仍可查看`);
  }
  const resumeReason = resumeRefusalReason(row.agentKind, facts.resume);
  if (resumeReason !== null) {
    return refuse(`${resumeReason}：追问接不上原来那段上下文，这里不会从头重跑该行——要重跑请点「重新执行」`);
  }
  return { ok: true };
}

/**
 * 追问可用性的**线形状**（服务端的读侧 → 界面）：一行一句结论。
 *
 * 为什么是一条读侧而不是让界面对着行快照自己算：七档里有四档的事实（工作区 / 用例 / 附件 /
 * 这一家的声明）在盘上与厂商声明上，浏览器一格都看不到。界面自己编一句「这一家不支持续接」
 * 就是第二份说法——而那正是本仓反复禁止的那种漂移。
 */
export const FollowUpVerdictSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
]);

/** 一轮里每一行的追问可用性（顺序即 `run.rows` 的顺序） */
export const FollowUpAvailabilitySchema = z.object({
  rows: z.array(z.object({ rowId: z.string().min(1), verdict: FollowUpVerdictSchema })),
});
export type FollowUpAvailability = z.infer<typeof FollowUpAvailabilitySchema>;
