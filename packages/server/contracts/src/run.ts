/**
 * 评测契约：智能体真源、行状态机、评测与候选行形状、创建入参、diff 响应。
 * 四个必须成立的口径：
 *   1. `AGENT_KINDS` 是三家智能体 id 的**唯一真源**（§11 R1）——agents 包再导出它，
 *      前端下拉与 `EvalRow.agentKind` 都从这里派生；contracts 反向不依赖 agents；
 *   2. `EvalRow.baselineCommit` 在 prepare 之后是 40 位**具体** hash（§11 R2）——`commitHash: null` 时
 *      diff 没有可比基线，准备阶段必须把 `HEAD` 解析成具体 hash 再写入；
 *   3. `TERMINAL_ROW_STATUSES` 供 SSE 判断「收到它即可关连接」（§8），
 *      `isRunnableRow` 供「开始」按钮判断哪些行会被执行（§5.3），两者语义不同不可互相替代；
 *   4. 两张标签表都是 `Record<枚举, string>`——新增枚举成员时 tsc 直接报错，
 *      不会出现「界面上一格空白」；
 *   5. 四条行级动作判据（`isRunnableRow` / `canRunRow` / `canRescoreRow` / `canRetryRow`）**都只有这一份**：
 *      界面用它决定按钮的 `disabled`，服务端用它抛 `CONFLICT`。两处各写一份必然漂移，
 *      漂移的表现是「按钮可点、点下去 409」（`canRunRow` 是 2026-09-29 追加的，见它的注释）；
 *   6. **两个按钮都是「重跑」出口，而不是「失败恢复」出口**（2026-09-28 晚间用户口径：
 *      「已出分、无报错时取消禁用」）：只要**跑过一次且产出了改动**（有可比基线 + 有 diff）就可以
 *      再跑一次，已经出分的行同样给。判据里**不看** `EvalRow.error` / `error.stage`——
 *      失败发生在哪一段不再决定按钮的可用性（那一格仍照旧落盘，只是不再参与判定）。
 *      「误点会白烧一次」这件事改由界面的 `Popconfirm` 二次确认承担。
 */
import { z } from 'zod';
// 本文件自己也要用 AgentKindSchema（EvalRow.agentKind 与创建入参的候选行）与 AgentKind
// （`isSameRowTarget` 的入参类型），而 `export … from` 只把名字转出去、不引入本地作用域——
// 故这里另有一行 import（不是重复）。
import { AgentKindSchema, type AgentKind } from './agent';
import { RubricSchema } from './rubric';
import { ScoreResultSchema } from './score';

// 智能体真源已拆到 ./agent（见该文件头：score.ts 需要 AgentKindSchema，而 run.ts 已经 import score.ts）。
// 这里**原样再导出**：所有既有消费方都从 `@aieval/contracts` 包根取这四个名字，路径不变。
export { AGENT_KINDS, AGENT_LABELS, AgentKindSchema, type AgentKind } from './agent';

/** 执行模式：并行不设并发上限，串行一行跑完（含评分）才起下一行（spec §5.2） */
export const ExecutionModeSchema = z.enum(['parallel', 'serial']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const EvalRowStatusSchema = z.enum([
  'pending', 'preparing', 'running', 'judging', 'judged',
  'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
]);
export type EvalRowStatus = z.infer<typeof EvalRowStatusSchema>;

/**
 * 终态集合：SSE 收到它即可关连接（§8）。
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
 * **失败发生在哪一段**（2026-09-28 追加）：候选智能体那一段（含准备）还是评分那一段。
 *
 * 为什么必须落盘、而不能从状态里推：两段失败落的行状态可以**逐字相同**（候选 agent 起不来与
 * 评分模型起不来都是 `failed` + `AGENT_FAILED`；候选超时与评分超时都是 `timed-out` +
 * `AGENT_TIMED_OUT`），从终态本身读不出「是哪一段坏了」。
 *
 * ⚠️ **它今天只是一格叙述性的事实记录**（2026-09-28 晚间起）：早先版本用它决定给「重新执行」
 * 还是「重新评分」，后来两个按钮都放开给「跑过一次且有产出」的所有行 ⇒ **没有任何判据再读它**。
 * 留着是因为「这一笔失败发生在哪一段」是排障时最常问的那个问题（日志抽屉与 `run.json` 都靠它），
 * 而不是因为它还在参与控制流——改这里之前先确认没有判据依赖它。
 */
export const RowFailureStageSchema = z.enum(['agent', 'judge']);
export type RowFailureStage = z.infer<typeof RowFailureStageSchema>;

export const EvalRowSchema = z.object({
  id: z.string().min(1),
  agentKind: AgentKindSchema,
  /** 执行期定位凭据用（R8）：按 id 去 config.providers 取 apiKey；供应商改名后这里仍指向同一条 */
  providerId: z.string().min(1),
  /** 冗余快照：供应商被改名或删除后仍能追溯这一行用的什么模型（§7.2） */
  providerName: z.string(),
  baseUrl: z.string(),
  modelId: z.string(),
  status: EvalRowStatusSchema,
  /** test/{rowId}：用行 id 而非轮 id，否则同用例下多候选会互相踩（§5.5） */
  branch: z.string(),
  workspacePath: z.string(),
  /** 40 位具体 hash（§11 R2）；**空串 = 尚未准备**：创建时为 ''，prepare 阶段解析 HEAD 后由 p4 写入 */
  baselineCommit: z.string(),
  /** null = 该次运行未采到计量；**绝不填 0**（§5.6.3） */
  tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable(),
  turns: z.number().nullable(),
  /**
   * **候选 agent 那一段的耗时**（有适配器结果时取适配器自报值，否则取编排层的掐表），
   * 不含评分阶段——开「使用智能体评分」的轮次里评分自己也要跑一次 CLI（分钟级），
   * 那一截不在这个数里；重新评分也不改它（它只跑评分那一步）。
   * 口径由 evaluator 的 `runRowAttempt` 第 5 步写入，那里有为什么这么定的两条理由。
   */
  durationMs: z.number().nullable(),
  /** 只存计数摘要，diff 正文按需现算（§7.2） */
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
   * 失败归因（R9）：`code` 必填——界面靠它区分「超时 / 限流 / 密钥无效 / 评分解析失败」，
   * 只留 message 的话界面只能按文案猜。它是 `z.string()` 而不是枚举：这一格要同时容纳
   * agents 包的 `AgentErrorCode`（§5.6.6）与接口层的 `ErrorCode`（如 `JUDGE_PARSE_FAILED`）。
   */
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      stack: z.string().optional(),
      /**
       * 失败发生在哪一段（2026-09-28 追加，见 `RowFailureStageSchema`）。
       * **可选**是载重的：老 `run.json` 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮
       * （与 `attempts` / `useAgentJudge` 同一条理由）。读侧的处置见 `canRescoreRow`：
       * 读不到阶段 = 不确认是评分失败 ⇒ **不给**「重新评分」（宁可少给一个按钮，
       * 也不给一个会跑错段的按钮）。
       */
      stage: RowFailureStageSchema.optional(),
    })
    .nullable(),
  /**
   * 这一行走过的**执行尝试次数**（含失败的那些），未跑过为 0（2026-09-27 追加）。
   *
   * 为什么要落盘：瞬时失败（网络 / 5xx / 限流）在我们这一侧是**自动重试**的，而自动重试必须留痕——
   * 否则「这一次为什么慢了两倍」在事后没有任何线索，且「试了三次才成功」与「一次就成功」在界面上
   * 长得一模一样（后者才是正常情况，前者说明上游不稳）。
   * `.default(0)` 是**载重**的（与 `useAgentJudge` 同一条理由）：老 `run.json` 里没有这一格，
   * 必填会让 `listRuns()` 静默跳过那一轮。
   */
  attempts: z.number().int().min(0).default(0),
  /**
   * 这一行要求的思考强度（spec D12）。**可选**：老 `run.json` 没有这一格，必填会让 `listRuns()`
   * 静默跳过那一轮（与 `attempts` / `useAgentJudge` 同一条理由）。
   * 记的是**我们要求的**档位，不是**实际生效的**档位（cc 可能静默降档，见 spec §9 第 7 条）。
   */
  effort: z.string().min(1).optional(),
});
export type EvalRow = z.infer<typeof EvalRowSchema>;

export const EvalRunSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  /** 冗余快照：用例被删除后仍能追溯这一轮测的是什么（§7.2） */
  caseTitle: z.string(),
  repoPath: z.string(),
  commitHash: z.string().nullable(),
  /** 冗余快照：用例被改分支或删除后，这一轮从哪个分支起跑仍可追溯（与 repoPath 同口径） */
  repoBranch: z.string().min(1).nullable().default(null),
  /**
   * 冗余快照：**这一轮用的是哪张评分表**（与 caseTitle / repoPath / repoBranch 同一条口径）。
   * 为什么必须快照：评分阶段读的是它而不是 `testCase.rubric`——改了用例的评分表之后，
   * 历史记录里的分数与它自己的满分仍然自洽，「重新评分」用的也仍是当初那把尺子。
   * **必填**：旧 run.json 没有这一格会 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮
   * （这正是本次升级要求清掉旧评测记录的原因，见计划 §兼容性）。
   */
  rubric: RubricSchema,
  status: z.enum(['idle', 'running', 'partial', 'done']),
  executionMode: ExecutionModeSchema,
  /**
   * 创建时的评分方式快照。`.default(false)` 是**载重**的：磁盘上已有的 `run.json` 没有这个字段，
   * 没有默认值就会 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮、`getRun()` 抛 INTERNAL
   * （使用者看到的是「我的评测记录凭空少了几轮」，两端都不报错）。
   */
  useAgentJudge: z.boolean().default(false),
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
  executionMode: ExecutionModeSchema,
  /** 这一轮是否由评分智能体评分；缺省 false（老客户端与手工 POST 不带这个字段时仍然合法） */
  useAgentJudge: z.boolean().default(false),
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
 * 为什么拆成两个形状（spec §4）：正文有 256 KB 硬预算，但 `files` 没有上限——
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
 * 「开始」按钮的可执行行判定（§5.3）：终态里除了 judged 都可重跑。
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
 * 编辑表单用它**事先算出这次会作废哪几行**（保存前的确认框）。两处各写一份必然漂移，
 * 漂移的症状是「确认框说会作废 2 行，实际作废了 1 行」——而那正是用户唯一能核对的地方。
 * `providerName` / `baseUrl` 是服务端快照（供应商改名后它们会变），**不参与**判定：
 * 改个供应商名字不该把一行已经跑出来的成绩打掉。
 *
 * **强度（`effort`）参与判定，且「一侧没给」算改了**（2026-09-29 追加）：档位是**被评对象**的一部分——
 * 同一个模型、同一家供应商，把 high 改成 low 跑出来的是另一次评测，旧分数不能留在快照里。
 * 为什么缺省按「改了」处理、而不是按「和上次一样」：编辑载荷是候选行集合的**全量替换**（spec §5.1，
 * 表单交回来的永远是全量行集合，不是补丁），所以「这一格没有」只能读成「未指定档位」，
 * 读不出「沿用原来那一档」。这是**安全方向**——宁可多重置一行，也不能静默保留一个用户已经改过的
 * 档位跑出来的分（那正是本判据存在的理由）。
 * Task 8 的编辑表单会回传它。**不回传的客户端，代价要说全**（本条是唯一记录这一支的地方）：
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
 * 三个条件缺一不可（**2026-09-28 晚间放开**：原来还要求 `error.stage === 'judge'`，
 * 于是已经出分的行与候选阶段失败的行都挂着禁用——用户口径改成「已出分、无报错时取消禁用」）：
 *   · 不在运行中——正在跑的行有自己的生命周期，终止它是另一件事；
 *   · `baselineCommit !== ''`——prepare 阶段成功过，diff 才有可比基线（§11 R2）；
 *   · `diff !== null`——第 6 步（collectDiff）跑过，说明候选 agent 阶段已经结束、有可复评的产出。
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
 * **`judged` 不再是排除项**（2026-09-28 晚间口径「已出分、无报错时取消禁用」）：整段重跑一次
 * 已出分的行是分钟级成本，由 `Popconfirm` 二次确认拦一次，判据不再替使用者说不。
 * 硬前提仍然挡着「没跑过」的行——没有可比基线时重跑得到的 diff 没有对照物。
 */
export function canRetryRow(row: EvalRow): boolean {
  return !isRunningRow(row.status) && row.baselineCommit !== '' && row.diff !== null;
}

/**
 * 该行能否**单跑**（只跑这一行：候选 agent 与评分整段跑一遍，本轮其他行一律不动）。
 * 2026-09-29 追加，用户口径：「重新执行，只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
 *
 * 与 `canRetryRow` 的差别**只有一条**：「跑过没有」。`canRetryRow` 要求「有可比基线 + 有已产出的改动」
 * ——它回答的是「**重**跑这一行有没有对照物」；本判据只要求「不在跑」——它回答的是
 * 「能不能**就现在**把这一行跑起来」。所以**没跑过的行**（`pending` / `skipped`）也在这里放行。
 *
 * 为什么需要它（这是这次口径修订要解决的唯一问题）：过去没跑过的行只能靠「开始」跑，而「开始」的语义是
 * **所有可执行行**（`isRunnableRow`，spec §5.3）——想单独跑三行里的第二行时，它会顺带把失败过的行
 * 一起重跑一遍，而「我只想跑这一个候选」在这条路上**无处表达**。
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
