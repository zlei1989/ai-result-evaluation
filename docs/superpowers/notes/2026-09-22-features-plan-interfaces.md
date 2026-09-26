# 功能阶段实施计划集 —— 跨计划接口契约

日期：2026-09-22
分支：`docs/features-plan`
上位文档：`docs/superpowers/specs/2026-09-22-features-design.md`（功能设计，下称 **spec**）

**本文件是什么**：功能阶段的实施计划被拆成 7 份（见 §0）。7 份计划由不同的人/会话并行编写与执行，
如果各写各的名字，接缝处必然对不上（Task 之间调不到函数、类型名两处不同）。
本文件把**所有跨计划可见的名字与签名**钉死成一份真源；每份计划只负责自己的行为、测试与步骤，
**不得发明**本文件已钉死的名字，也不得把本文件钉死的签名改窄。

> 本文件不是设计文档，也不重复 spec 的理由陈述。spec 说「为什么」，计划说「怎么做、怎么验」，本文件说「叫什么」。

---

## 0. 计划集与依赖顺序

| 文档 | 范围 | 依赖 | 主要 spec 章节 |
|---|---|---|---|
| `plans/2026-09-22-features-p0-contracts-core.md` | 契约扩全 + `core` 的 git / 工作区 / 事件日志原语 + `evaluator` 的文本 API 外壳 | 脚手架 | §3 F13 · §5.5 第 1/2/6/7 步 · §6.3 · §7 · §9（git 原语、三样 diff、diff 裁剪） |
| `plans/2026-09-22-features-p1-settings.md` | 设置域：供应商 CRUD + 拉模型 + 评分配置 + 工作区 | p0 | §3 F1 · §6 · §8（providers 路由）· §10（供应商相关） |
| `plans/2026-09-22-features-p2-cases.md` | 用例域：CRUD + 仓库/commit 校验 + AI 生成评分提示词 + 删 `/demo` | p0 · p1 | §4 · §5.7（生成侧）· §8（cases 路由）· §10（仓库/commit） |
| `plans/2026-09-22-features-p3-agents.md` | `agents`：事件探测 + 注册表 + 三家适配器 | p0 | §5.6 全部 · §9（适配器行） |
| `plans/2026-09-22-features-p4-evaluator.md` | `evaluator`：编排状态机 + 评分器 + 事件落盘 + 重启恢复 | p0 · p3 | §3 F3/F4/F5/F9/F10/F12/F14 · §5.2 · §5.4 · §5.5 · §5.7 · §7.4 |
| `plans/2026-09-22-features-p5-runs.md` | 评测域：路由 + hooks + 评测页 + SSE + 三个产物抽屉 + 吸底栏 | p1 · p2 · p4 | §5.1 · §5.3 · §8 · §12 |
| `plans/2026-09-22-features-p6-smoke.md` | 冒烟 9 项 + 使用手册 + 关账 | p1–p5 | §9（冒烟）· §11 第 8 步 |

依赖是硬顺序：p0 不动，p1–p5 的 import 都可能编译不过。计划内部的任务顺序也必须满足「先出契约再做消费方」。

---

## 1. 通用口径（继承脚手架，7 份计划都适用）

- 包名 `@aieval/*`；依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束，**含动态 `import()` 与 `require()`，且禁跨包相对引用**（见 `AGENT.md` 的依赖方向表）。
- `core` 只用 Node 内置模块 + `contracts`；`agents` 是唯一允许引入厂商 SDK 的包；`api` 禁框架；`ui` 不调接口、不 import `client`；`client` 不 import `apps`。
- 源码一律 ESM（禁 `require`）；`verbatimModuleSyntax` 开着，类型必须 `import type`。
- 时间字段一律 **ISO 8601 带时区字符串**（`new Date().toISOString()`）；实体 id 一律 **UUID v4**（`node:crypto` 的 `randomUUID()`），由服务端在创建时生成。
- 写盘原子（临时文件 + `renameSync`），读盘容忍 UTF-8 BOM；配置目录 `AIEVAL_CONFIG_DIR` > `~/.aieval`，测试用 `setConfigDirForTesting()`。
- 注释 JSDoc 中文，先说「做什么」再说「怎么做」；文件头写职责 + 注意事项；日志走 `createLogger(scope)`，上下文走 `console` 第二参数（不 `JSON.stringify`）。
- 每个任务结束时 `pnpm typecheck` 零错误；收尾任务跑 `pnpm lint` 与 `pnpm test`。
- **提交用逐个显式 `git add <路径>`，禁 `git add -A`。**
- **每条新增的回归守卫必须做变异验证**：把要拦的缺陷人为制造回去（改实现，不改测试），确认守卫失败，再还原并核对文件哈希。没有见过失败的守卫不算守卫；计划里必须写出「制造哪个变异体 → 期望看到什么失败输出」这一步。
- 文档不写「TBD / 稍后补 / 类似 Task N」；代码步骤必须有可直接粘贴的完整代码块。

---

## 2. `packages/server/contracts/src/` —— 契约出口清单

p0 一次性建好**全部**契约；p1–p5 只消费。`index.ts` 汇总导出下列每一个名字。

### 2.1 `errors.ts`（改：追加三个错误码）

`ERROR_CODES` 追加（顺序追加在 `INTERNAL` 之前，保持「4xx 在前、5xx 在后」的现有排列）：

| 码 | HTTP | 语义 |
|---|---|---|
| `NOT_A_GIT_REPO` | 400 | 仓库路径非法 / 不是 git 仓库（§10） |
| `INVALID_REF` | 400 | commit hash 不存在（§10） |
| `JUDGE_PARSE_FAILED` | 500 | 评分模型返回不可解析 / 维度缺失（§5.7、§10） |

`AgentErrorCode`（§5.6.6 那一组）**不进 `ERROR_CODES`**，理由见 §5.6.6：它没有对应的 HTTP 状态。

### 2.2 `provider.ts`（新）

```ts
export const ProtocolTypeSchema = z.enum(['openai', 'anthropic']);
export type ProtocolType = z.infer<typeof ProtocolTypeSchema>;

/** 协议类型的中文标签：设置页与候选池提示共用，避免两处各写一份 */
export const PROTOCOL_LABELS: Record<ProtocolType, string>; // { openai: 'OpenAI 兼容', anthropic: 'Anthropic 兼容' }

export const ProviderModelSchema = z.object({ id: z.string().min(1), source: z.enum(['fetched', 'manual']) });
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/** 落盘形态：含明文 apiKey，只在服务端内部流转 */
export const ProviderSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), protocolType: ProtocolTypeSchema,
  baseUrl: z.string().min(1), apiKey: z.string().min(1),
  models: z.array(ProviderModelSchema),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Provider = z.infer<typeof ProviderSchema>;

/** 下行形态：apiKey 已掩码（§6.1「落盘后列表只显示掩码」） */
export const ProviderViewSchema = ProviderSchema.omit({ apiKey: true }).extend({ apiKeyMasked: z.string() });
export type ProviderView = z.infer<typeof ProviderViewSchema>;

export function maskApiKey(apiKey: string): string;   // 保留前 3 后 4，长度 <8 时全掩码

export const ProviderCreateSchema = z.object({
  name: z.string().min(1), protocolType: ProtocolTypeSchema, baseUrl: z.string().min(1),
  apiKey: z.string().min(1), models: z.array(ProviderModelSchema).default([]),
});
export type ProviderCreate = z.infer<typeof ProviderCreateSchema>;
export const ProviderPatchSchema = ProviderCreateSchema.partial();
export type ProviderPatch = z.infer<typeof ProviderPatchSchema>;

/** 单条模型的增删（§8 的 models 路由） */
export const ProviderModelInputSchema = ProviderModelSchema;
export type ProviderModelInput = z.infer<typeof ProviderModelInputSchema>;
```

### 2.3 `case.ts`（新）

```ts
export const TestCaseSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), repoPath: z.string().min(1),
  commitHash: z.string().min(1).nullable(),        // null = 默认分支 HEAD
  taskPrompt: z.string().min(1), judgePrompt: z.string().min(1),
  judgeProviderId: z.string().min(1).nullable(), judgeModelId: z.string().min(1).nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const CaseCreateSchema = z.object({
  title: z.string().min(1), repoPath: z.string().min(1),
  commitHash: z.string().min(1).nullable().default(null),
  taskPrompt: z.string().min(1), judgePrompt: z.string().min(1),
  judgeProviderId: z.string().min(1).nullable().default(null),
  judgeModelId: z.string().min(1).nullable().default(null),
});
export type CaseCreate = z.infer<typeof CaseCreateSchema>;
export const CasePatchSchema = CaseCreateSchema.partial();
export type CasePatch = z.infer<typeof CasePatchSchema>;

/** 仓库校验结果（§4.2「通过后回显仓库名与当前分支」） */
export const RepoInfoSchema = z.object({ repoPath: z.string(), repoName: z.string(), branch: z.string() });
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

/** commit 候选（§4.2 最近 20 条） */
export const CommitCandidateSchema = z.object({ hash: z.string(), subject: z.string() });
export type CommitCandidate = z.infer<typeof CommitCandidateSchema>;

/** 校验入参：**按仓库路径**而不是按 caseId（见 §11 R7） */
export const RepoPathInputSchema = z.object({ repoPath: z.string().min(1) });
export const GenerateJudgePromptSchema = RepoPathInputSchema.extend({
  taskPrompt: z.string().min(1),
  judgeProviderId: z.string().min(1).nullable().default(null),
  judgeModelId: z.string().min(1).nullable().default(null),
});
export type GenerateJudgePromptInput = z.infer<typeof GenerateJudgePromptSchema>;
```

### 2.4 `run.ts`（新）

```ts
/** 三家智能体 id 的**唯一真源**（见 §11 R1）：agents 包再导出它，contracts 反向不依赖 agents */
export const AGENT_KINDS = ['claude-code', 'codex', 'dsh'] as const;
export const AgentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AGENT_LABELS: Record<AgentKind, string>;   // { 'claude-code': 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' }

export const ExecutionModeSchema = z.enum(['parallel', 'serial']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const EvalRowStatusSchema = z.enum([
  'pending', 'preparing', 'running', 'judging', 'judged',
  'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
]);
export type EvalRowStatus = z.infer<typeof EvalRowStatusSchema>;
/** 终态集合：SSE 收到它即可关连接（§8）；顺序即界面排序无关，只用于判定 */
export const TERMINAL_ROW_STATUSES: readonly EvalRowStatus[];
export const ROW_STATUS_LABELS: Record<EvalRowStatus, string>;   // 中文文案（含「串行排队中」不在此列，那是派生文案）

export const EvalRowSchema = z.object({
  id: z.string().min(1), agentKind: AgentKindSchema,
  providerId: z.string().min(1), providerName: z.string(), baseUrl: z.string(), modelId: z.string(),
  status: EvalRowStatusSchema,
  branch: z.string(), workspacePath: z.string(),
  baselineCommit: z.string(),                        // 见 §11 R2：prepare 后是 40 位具体 hash；空串 = 尚未准备（p5 创建时为 ''）
  tokens: z.object({ input: z.number(), cached: z.number(), output: z.number() }).nullable(),
  turns: z.number().nullable(), durationMs: z.number().nullable(),
  diff: z.object({ filesChanged: z.number(), insertions: z.number(), deletions: z.number(), truncated: z.boolean() }).nullable(),
  score: ScoreResultSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string(), stack: z.string().optional() }).nullable(),
});
export type EvalRow = z.infer<typeof EvalRowSchema>;

export const EvalRunSchema = z.object({
  id: z.string().min(1), caseId: z.string().min(1),
  caseTitle: z.string(), repoPath: z.string(), commitHash: z.string().nullable(),   // 冗余快照（§7.2）
  status: z.enum(['idle', 'running', 'partial', 'done']),
  executionMode: ExecutionModeSchema, rows: z.array(EvalRowSchema),
  workspaceBase: z.string(),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
});
export type EvalRun = z.infer<typeof EvalRunSchema>;

/** 创建评测：每候选行给智能体 + 供应商 + 模型；供应商名与 baseUrl 由服务端快照进行 */
export const RunCreateSchema = z.object({
  caseId: z.string().min(1), executionMode: ExecutionModeSchema,
  rows: z.array(z.object({
    agentKind: AgentKindSchema, providerId: z.string().min(1), modelId: z.string().min(1),
  })).min(1),
});
export type RunCreate = z.infer<typeof RunCreateSchema>;

/** 「代码改动」抽屉的按需响应（§5.3 第三个抽屉 + §8 的 diff 路由） */
export const RowDiffSchema = z.object({
  text: z.string(), truncated: z.boolean(),
  files: z.array(z.object({ path: z.string(), insertions: z.number(), deletions: z.number() })),
  filesChanged: z.number(), insertions: z.number(), deletions: z.number(),
  droppedFiles: z.array(z.string()),
});
export type RowDiff = z.infer<typeof RowDiffSchema>;

/** 「开始」按钮的可执行行判定（§5.3）：终态里除了 judged 都可重跑 */
export function isRunnableRow(status: EvalRowStatus): boolean;   // pending/failed/timed-out/canceled/interrupted/skipped → true
export function isRunningRow(status: EvalRowStatus): boolean;    // preparing/running/judging → true
```

### 2.5 `score.ts`（新）

```ts
export const DimensionKeySchema = z.enum(['correctness', 'requirement', 'quality', 'robustness', 'maintainability']);
export type DimensionKey = z.infer<typeof DimensionKeySchema>;

/** 固定 5 维（§7.3），顺序即界面展示顺序 */
export const DIMENSIONS: readonly { key: DimensionKey; label: string }[];   // 中文标签见 spec §7.3 表
export const DIMENSION_COUNT = 5;

export const DimensionScoreSchema = z.object({
  key: DimensionKeySchema, label: z.string(), score: z.number().int().min(1).max(5), reason: z.string(),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

export const ScoreResultSchema = z.object({
  dimensions: z.array(DimensionScoreSchema),
  totalScore: z.number().int().min(0).max(100),
  verdict: z.string(), raw: z.string(),
  judgeProviderId: z.string(), judgeModelId: z.string(), judgedAt: z.string(),
});
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

/** 总分合成（§5.7）：round(sum(score) / (5 * n) * 100)，n = 维度数 —— 本期固定 5 维，
 *  故分母是**常量** DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION = 25，**不随传入个数变化**
 *  （传不满 5 维时分数只会更低，保守方向；缺维本身由 p4 的解析器判 failed）。见 §11 R16。 */
export function composeTotalScore(scores: readonly number[]): number;

/** 生成的提示词必须自带的输出契约文本（§4.3）：单一真源，生成侧与解析侧共用同一份字段名 */
export const JUDGE_OUTPUT_CONTRACT: string;
```

### 2.6 `agent-event.ts`（新）

```ts
/** 每候选行事件日志的一条（§7.4）。seq 单调递增且从 1 开始，由 core 的事件日志写入器分配 */
export const AgentEventSchema = z.discriminatedUnion('type', [ /* 七个成员，逐字对应 §7.4 */ ]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export const AGENT_EVENT_TYPES: readonly AgentEvent['type'][];
```

`AgentEvent` 的七个成员必须与 spec §7.4 的 TS 块**逐字段一致**（`status` / `log` / `usage` / `diff-summary` / `score` / `error` / `end`）。

### 2.7 `index.ts`（改）

按现有风格分组导出上述全部名字（含 `type` 导出）。

---

## 3. `packages/server/core/src/` —— git / 工作区 / 事件日志出口清单

### 3.1 `config-store.ts`（改：去重复类型）

`ProviderRecord` / `ProviderModelRecord` / `TestCaseRecord` / `ProtocolType` 四个**本地声明删掉**，改用 `contracts` 的 `Provider` / `TestCase` / `ProtocolType`（全仓仅 core 自己引用，`core/src/index.ts` 同步删掉这四个类型的再导出）。`AppConfig` 变为：

```ts
export interface AppConfig { settings: Settings; providers: Provider[]; cases: TestCase[] }
```

### 3.2 `git.ts`（新）

```ts
/** 是不是 git 工作树内（`git rev-parse --is-inside-work-tree`）；抛错一律折成 false */
export function isGitRepo(dir: string): boolean;

/** 校验目录并回显仓库名 + 当前分支；失败抛 NOT_A_GIT_REPO（含路径与 git 原文） */
export function resolveRepoInfo(repoPath: string): RepoInfo;

/** 判定 commit 存在（`git cat-file -e <hash>^{commit}`），返回完整 40 位 hash；失败抛 INVALID_REF */
export function assertCommit(repoPath: string, hash: string): string;

/** 最近 n 条提交（`git log --format=%h%x09%s -n <limit>`），默认 20（§4.2） */
export function listCommits(repoPath: string, limit?: number): CommitCandidate[];

/** 用例级本地缓存仓库（§5.5 第 1 步）：不存在才 `git clone <repoPath> <cacheDir>`；来源变了重克隆、
 *  `commitHash: null` 先刷新到来源当前 tip、请求的 hash 缺席先 fetch 一次再判（§11 R28） */
export function ensureCaseCache(repoPath: string, cacheDir: string, commitHash?: string | null): void;

/** 文件系统级目录复制（§5.5 第 2 步）：缓存 → 行工作区；目标父目录不存在则创建。
 *  源目录不是 git 仓库（缓存损坏）→ `INTERNAL`：`NOT_A_GIT_REPO` 留给用户填的仓库路径（spec §10） */
export function copyWorkspace(srcDir: string, destDir: string): void;

/** 在工作副本里取基线并建行分支（§5.5 第 2 步）：checkout <commit> → checkout -b <branch> */
export function checkoutRow(dir: string, commitHash: string | null, branch: string): { baselineCommit: string };

/** 三样 diff 合并 + 计数（§5.5 第 6 步，口径见 §11 R3）；`baselineCommit` 为空串（= 尚未准备，R2）
 *  直接抛 `INTERNAL`，绝不降级成 `git diff ..HEAD` 的空 diff */
export function collectDiff(dir: string, baselineCommit: string): {
  text: string; files: { path: string; insertions: number; deletions: number }[];
  filesChanged: number; insertions: number; deletions: number;
};

/** 按体积裁剪（§5.5 第 7 步 / §9）：按文件切分，保留到预算为止，输出含「已截断」标记与被丢弃文件清单 */
export function truncateDiff(text: string, budgetBytes: number): {
  text: string; truncated: boolean; droppedFiles: string[];
};
```

`collectDiff` 的文本格式固定为分段拼接（供评分模型与 diff 抽屉共用）：

```
### 已提交改动（<baseline>..HEAD）
<git diff 输出，无改动则该段留空并在段内写「（无）」>
### 未提交改动（工作区 vs HEAD）
<git diff HEAD 输出>
### 未跟踪文件
<git status --porcelain 的 ?? 清单，每行一个路径>
```

> **`collectDiff` 的 git 调用顺序以 §11 R3 / R21 的实测结论为准，不要自己再推导一遍**：先读 `git status --porcelain`（未跟踪清单，**必须**在 `-N` 之前），再 `git add --intent-to-add --all`，然后取两份 diff 正文、`--numstat {baseline}..HEAD`（已提交计数）与 `--numstat HEAD`（未提交计数，**必须在 `-N` 之后**，否则未跟踪文件的计数会缺席）。
> 未跟踪清单读晚了（在 `-N` 之后）会得到空清单——`?? b.txt` 那时已经变成 ` A b.txt`。

### 3.3 `workspace.ts`（新）

```ts
export function caseCacheDir(workspaceRoot: string, caseId: string): string;   // {root}/cases/{caseId}/cache
export function runDir(workspaceRoot: string, runId: string): string;          // {root}/{runId}
export function rowDir(workspaceRoot: string, runId: string, rowId: string): string;   // {runDir}/rows/{rowId}
export function rowWorkspaceDir(workspaceRoot: string, runId: string, rowId: string): string;  // {rowDir}/workspace
export function rowAgentHomeDir(workspaceRoot: string, runId: string, rowId: string): string;  // {rowDir}/.agenthome
export function rowEventsFile(workspaceRoot: string, runId: string, rowId: string): string;    // {rowDir}/events.jsonl
export function runSnapshotFile(workspaceRoot: string, runId: string): string;                 // {runDir}/run.json
/** 建行工作区：清掉同名旧目录里的 workspace 与 .agenthome（**不删 events.jsonl**，见 §11 R27）→ 复制缓存 → checkout 基线 → 建分支 → 建 .agenthome */
export function prepareRowWorkspace(input: {
  workspaceRoot: string; caseId: string; repoPath: string; runId: string; rowId: string;
  commitHash: string | null; branch: string;
}): { workspacePath: string; agentHome: string; baselineCommit: string };
```

### 3.4 `event-log.ts`（新）

```ts
/** 待写入事件：分配式 Omit（见 §11 R17）。p4 的 `PendingRowEvent` 是它的别名，不重复定义 */
export type PendingAgentEvent = DistributiveOmit<AgentEvent, 'seq' | 'at'> & { at?: string };   // 分配式 Omit，定义见 p0 的 event-log.ts（R17）
/** 追加一条事件并写入 events.jsonl（seq 由本模块分配：**静默的原始最大 seq 扫描 + 1**，见 §11 R24），返回写入的完整事件 */
export function appendEvent(file: string, event: PendingAgentEvent): AgentEvent;
/** 读全量（抽屉首帧 + 下载）；文件不存在返回 [] */
export function readEvents(file: string): AgentEvent[];
/** 只读 seq > afterSeq 的部分（SSE 按 Last-Event-ID 续订） */
export function readEventsAfter(file: string, afterSeq: number): AgentEvent[];
/** 清空该行的事件日志（重跑同一行前调用，避免新旧事件混在一个文件里） */
export function resetEvents(file: string): void;
```

### 3.5 `index.ts`（改）

按现有分组风格补齐上述全部出口（`git.ts` / `workspace.ts` / `event-log.ts`）。

**`core` 的包根只再导出「它自己产出的东西」**：函数与 `PendingAgentEvent`（R17）来自 `git/workspace/event-log/config-store/logger/paths`；
`RepoInfo` / `CommitCandidate` / `Provider` / `TestCase` / `Settings` 等**契约类型一律从 `@aieval/contracts` 取**，`core` 不再转出它们
（Task 8 已删掉四个本地重复声明的再导出，这里是同一条口径的延伸）。消费方（p1–p5）按类型来源分两处 import，不要指望 `@aieval/core` 转手。

---

## 4. `packages/server/agents/src/` —— 适配器出口清单

```ts
// types.ts
export type { AgentKind } from '@aieval/contracts';                  // 再导出，真源在 contracts（§11 R1）
export { AGENT_KINDS } from '@aieval/contracts';
export type ProtocolType = 'openai' | 'anthropic';                   // 与 contracts 同义，此处重复声明避免为两个字符串引入依赖（spec §5.6.2 明写）
export type AgentExitReason = 'completed' | 'timed-out' | 'canceled' | 'error';
export type AgentErrorCode =
  | 'AGENT_LOAD_FAILED' | 'AGENT_FAILED' | 'AGENT_TIMED_OUT' | 'AGENT_CANCELED' | 'AUTH_FAILED' | 'RATE_LIMITED';
export interface AgentRunInput { /* 逐字对应 spec §5.6.2 */ }
export interface AgentRunResult { /* 逐字对应 spec §5.6.2 */ }
export interface AgentProviderMetadata { /* 逐字对应 spec §5.6.2 */ }
export interface AgentProvider { readonly kind; readonly displayName; readonly metadata; run(input): Promise<AgentRunResult> }

// runtime.ts —— 厂商 SDK 测试注入点（§5.6.6「运行时上下文的 sdkModule 字段」）
export interface AgentRuntime { sdkModule?: unknown }
export function setAgentRuntimeForTesting(runtime: AgentRuntime | null): void;
export function getAgentRuntime(): AgentRuntime;

// registry.ts
export function getProvider(kind: AgentKind): AgentProvider;   // 未注册 id 抛错，错误信息含可用清单
export function listAgentProviders(): AgentProvider[];

// providers/<kind>/index.ts —— 三家各一个目录：run() + 事件投影 + 注入参数
// providers/<kind>/sdk.ts   —— 懒加载外壳（只缓存成功加载）
export function createSdkLoader<T>(load: () => Promise<T>, packageName: string): () => Promise<T>;

// index.ts —— 只导出 registry + types（providers/* 不外露，编排层只认 getProvider）
```

三家的 `AgentProviderMetadata` 逐格必须等于 spec §5.6.2 的表（claude-code `['anthropic']/true/true/subprocess`；codex `['openai']/true/true/subprocess`；dsh `['openai','anthropic']/false/true/subprocess`——`protocolTypes` 的集合形状与 dsh 的第二条协议按 **R37 的收口**落地、`usage` 按 Task 12 的探测改成 `true`，见 §11 **R37**）。

**三条接缝口径（p3 计划定稿，p4 必须照此实现，避免两边都发同一种事件）**：

1. **`seq` 与 `at` 的归属**：适配器发的是**运行内自增 seq（从 1 起）**加自己生成的 `at`；落盘时的 `seq` 一律由 `core.appendEvent` 按文件重新分配。p4 不得直接把适配器的 `seq` 当作 `events.jsonl` 的序号（两轮追加到同一个文件时会重号）。
2. **事件类型分工**：适配器只发 `log` / `usage` / `error`；`status` / `diff-summary` / `score` / `end` **只由编排层（p4）发**。spec 没写这条分工，两边都发会让同一语义出现两条事件、界面重复渲染。
3. **`agents` 包的导出面只有 registry + types**：`runtime.ts` 与 `providers/*` 不外露（契约 §4），因此 p4 的测试要伪造适配器只能 `vi.mock('@aieval/agents')`，不能去替换 `runtime` 的注入点。

---

## 5. `packages/server/evaluator/src/` —— 编排 / 评分 / 存储出口清单

```ts
// text-api.ts —— 非流式文本调用，生成提示词（api 层）与评分共用（§11 R5）
export interface TextRoute { protocolType: ProtocolType; baseUrl: string; apiKey: string; modelId: string }
export async function callTextApi(route: TextRoute, input: { system?: string; prompt: string }): Promise<string>;

// judge-route.ts —— 评分模型路由解析：用例覆盖 > 全局默认；都没有则抛 CONFLICT + 指向设置页的中文原因
// 为什么在这儿而不是 api 层：evaluator 在 p4 也要自己解析一次（评分阶段），而 evaluator 不能依赖 api
export function resolveJudgeRoute(input: { judgeProviderId: string | null; judgeModelId: string | null }): TextRoute;

// judge.ts
export interface JudgeInput { /* 逐字对应 spec §5.7 */ }
export function parseJudgeResponse(raw: string): ScoreResult['dimensions'] & { verdict: string };  // 纯函数，三类翻车点各有用例
export async function judgeRow(input: JudgeInput): Promise<ScoreResult>;   // 解析失败抛 JUDGE_PARSE_FAILED（保留 raw）

// run-store.ts —— 运行快照落盘（{workspaceRoot}/{runId}/run.json）
export function listRuns(): EvalRun[];                       // 扫 settings.workspaceRoot 下的 */run.json，读不出/损坏的跳过并 WARN
export function listRunsForCase(caseId: string): EvalRun[];
export function getRun(runId: string): EvalRun;               // 形状不合法抛 INVALID_QUERY（见 §11 R36）；合法但不存在抛 NOT_FOUND
export function saveRun(run: EvalRun): void;                  // 原子写；入口同样做 R36 的形状校验

// events.ts —— 事件总线（§11 R6：进程内订阅 + 文件回放）
export function publishRowEvent(runId: string, rowId: string, event: AgentEvent | PendingAgentEvent): void;   // 落盘 + 扇出；seq/at 一律以写入器为准（契约修正：原签名要求完整 AgentEvent，与 appendEvent 分配 seq 矛盾）
export function subscribeRowEvents(runId: string, rowId: string, listener: (e: AgentEvent) => void): () => void;

// orchestrator.ts
export function startRun(runId: string): EvalRun;             // 只跑 isRunnableRow 的行；已有运行中的行则抛 CONFLICT
export function abortRun(runId: string): EvalRun;             // 在跑的行 → canceled，串行未轮到的 → skipped
export function abortRow(runId: string, rowId: string): EvalRun;
export function recoverInterruptedRuns(): { recovered: number };   // 启动时把 preparing/running/judging → interrupted（§7.4 / F10）
export async function drainRunningTasks(): Promise<void>;     // 测试与关停用：等在途行结束

// index.ts —— 以上全部
```

`text-api.ts` 与 `judge-route.ts` 属于 **p0**（不是 p4）：用例域的「AI 生成评分提示词」（p2）在 evaluator 之前就要用它，
而它们本身自包含（双协议路由 + 一次非流式 HTTP 调用），不依赖编排状态机。p4 只消费，不重写。

**`TextRoute` 刻意不带 `providerId`**（p4 计划定稿）：它是 `callTextApi` 的入参，只需要协议 / 地址 / 密钥 / 模型四样。
`ScoreResult.judgeProviderId` 的取值由 **p4 的 `JudgeInput.judgeProviderId`** 承担（spec §5.7 的 `JudgeInput` 没有这个字段，
但「这一分是哪把尺子打的」必须记下来，与 §7.2 的冗余快照同一理由）。优先级表达式因此出现两处
（`resolveJudgeRoute` 内部一处、编排层记录一处），p4 用**接缝守卫**（断言两处结果恒等）钉住它们不漂移。

`recoverInterruptedRuns()` 的调用点**唯一**：`apps/web-next/instrumentation.ts` 的 `register()`（Next 的启动钩子）。
它**必须经 `@aieval/api` 转出后再调用**，web-next 不直接 import `@aieval/evaluator`（依赖方向表里 web-next 只到 api/core/ui/client/contracts；
`apps/web-next/package.json` 也没有 evaluator 这个依赖）。故 `api/src/index.ts` 要额外转出 `recoverInterruptedRuns`。
p4 负责建立它，p5 不得再挂第二处；实现前先读 `apps/web-next/node_modules/next/dist/docs/` 确认该版本钩子的写法（`AGENT.md` 的硬约束）。

---

## 6. `packages/server/api/src/` —— 业务服务层出口清单（每功能一文件）

```ts
// providers.ts（p1）
export function listProviders(): ProviderView[];
export function createProvider(input: ProviderCreate): ProviderView;
export function updateProvider(providerId: string, patch: ProviderPatch): ProviderView;
export function deleteProvider(providerId: string): void;
export function fetchProviderModels(providerId: string): Promise<ProviderView>;   // 合并而非覆盖（§6.1）；要发一次 HTTP，必然异步（契约修正 R15）
export function addProviderModel(providerId: string, modelId: string): ProviderView;
export function removeProviderModel(providerId: string, modelId: string): ProviderView;
/** 全部可选的评分模型（**两种协议都要**，§4.2 / §6.2）：用例表单与评分配置共用 */
export function listAllModelOptions(): { providerId: string; providerName: string; protocolType: ProtocolType; modelId: string; source: 'fetched' | 'manual' }[];

// cases.ts（p2）
export function listCases(): TestCase[];
export function getCase(caseId: string): TestCase;
export function createCase(input: CaseCreate): TestCase;
export function updateCase(caseId: string, patch: CasePatch): TestCase;
export function deleteCase(caseId: string): { affectedRuns: number };       // 同时删用例级缓存仓库（§4.4）
export function validateRepo(repoPath: string): RepoInfo;                   // 直通 core.resolveRepoInfo
export function listCommitCandidates(repoPath: string): CommitCandidate[];  // 直通 core.listCommits

// judge.ts（p2 的生成侧）
/** 生成结果：`GenerateJudgePromptResult` 是 p2 收口波补进契约的**具名出口**（R34），字段与上面那个内联结构逐字一致 */
export type GenerateJudgePromptResult = { prompt: string; dimensions: DimensionKey[] };
export function generateJudgePrompt(input: GenerateJudgePromptInput): Promise<GenerateJudgePromptResult>;   // 内部 await callTextApi，必然异步（契约修正 R15）
export { resolveJudgeRoute } from '@aieval/evaluator';   // 转出（HTTP 层要用它做「未配置评分模型」的即时报错）

// runs.ts（p5，创建/启动/终止的业务规则）
// 文件归属修正（R16）：p5 把它拆成 runs.ts（创建/启动/终止/候选池）+ run-artifacts.ts（diff / log 读取）+ run-stream.ts（SSE 帧），
// **出口清单与下面的签名不变**，只是不再挤在一个文件里。
export function listRunsView(): EvalRun[];
export function getRunView(runId: string): EvalRun;
export function createRun(input: RunCreate): EvalRun;      // 校验用例存在、每行供应商/模型存在且协议匹配 → 快照 providerName/baseUrl → 落库 idle；baselineCommit 落 ''（R2）
export function startRun(runId: string): EvalRun;
export function abortRun(runId: string): EvalRun;
export function abortRow(runId: string, rowId: string): EvalRun;
export function getRowDiff(runId: string, rowId: string): RowDiff;          // 按需现算，不预先落库（§7.2）
export function getRowLog(runId: string, rowId: string, afterSeq?: number): AgentEvent[];
export function streamRowEvents(runId: string, rowId: string, afterSeq: number): ReadableStream<Uint8Array>;  // SSE 帧由本函数产出（api 不依赖框架，只用 Web 标准类型）
/** 候选池投影：按智能体过滤模型（§5.1 F2）——协议来源是 agents 注册表元数据，不硬编码（A3） */
export function listModelOptions(agentKind: AgentKind): { providerId: string; providerName: string; modelId: string; source: 'fetched' | 'manual' }[];
```

`listModelOptions` 归 **p5**（不是 p1）：它要读 `agents` 注册表的 `protocolType`，而 `agents`（p3）在设置域（p1）之后才有内容；
p1 只提供不过滤的 `listAllModelOptions()`（评分模型两边协议都能用，本来就不需要过滤）。

`api/src/index.ts` 汇总导出以上全部（p1/p2/p5 各追加一段）。

---

## 7. `packages/client/client/src/` —— hooks 出口清单

```ts
// providers.ts（p1）
useProviders(): { providers: ProviderView[] | undefined; error: unknown; isLoading: boolean; refresh: () => void }
useCreateProvider(): { create: (input: ProviderCreate) => Promise<ProviderView>; isCreating: boolean }
useUpdateProvider(): { update: (id: string, patch: ProviderPatch) => Promise<ProviderView>; isUpdating: boolean }
useDeleteProvider(): { remove: (id: string) => Promise<void>; isDeleting: boolean }
useFetchProviderModels(): { fetchModels: (id: string) => Promise<ProviderView>; isFetching: boolean }
useProviderModels(): { add: (id: string, modelId: string) => Promise<ProviderView>; remove: (id: string, modelId: string) => Promise<ProviderView>; isMutating: boolean }

// cases.ts（p2）
useCases() / useTestCase(id: string | null) / useCreateCase() / useUpdateCase() / useDeleteCase()
useValidateRepo(): { validate: (repoPath: string) => Promise<RepoInfo>; isValidating: boolean }
useCommitCandidates(repoPath: string | null): { commits: CommitCandidate[] | undefined; isLoading: boolean }
useGenerateJudgePrompt(): { generate: (input: GenerateJudgePromptInput) => Promise<{ prompt: string; dimensions: DimensionKey[] }>; isGenerating: boolean }

/**
 * `COMMITS_KEY` / `matchesCommitsKey`（p2 收口波新增，**契约收口见 R34**）：
 * 候选提交那条 SWR key 的**唯一来源**。p2 的用例页要用 `mutateCache(matchesCommitsKey, undefined, { revalidate: true })`
 * 在「重新加载候选」时只重取候选、不顺带刷列表；若页面自带一份 URL 字面量，两处漂移的表现是
 * 「点了按钮什么都不发生」（过滤器匹配不到 ⇒ 一个请求都不发），没有任何报错。
 */
export const COMMITS_KEY: '/api/cases/commits';
export function matchesCommitsKey(key?: unknown): boolean;

// runs.ts（p5）
useRuns(): { runs: EvalRun[] | undefined; error: unknown; isLoading: boolean; refresh: () => void }   // 有 running 时 refreshInterval 3000
useRun(id: string | null)
useCreateRun() / useStartRun() / useAbortRun() / useAbortRow()
/** 候选池按智能体的协议过滤（F2/A3）；后端读 agents 注册表元数据（契约 §6 的 listModelOptions），不硬编码 */
useRunModelOptions(): {
  options: AgentOptionGroup[] | undefined;
  optionsFor: (agentKind: AgentKind) => AgentModelOption[];
  capabilityOf: (agentKind: AgentKind) => { usage: boolean; cancelMidTurn: boolean };
  isLoading: boolean;
  error: unknown;
}
// ↑ 本形状与 p5 Task 4 的交付一致（B3 `9dce472`）；`options` 供旧解构，`optionsFor` / `capabilityOf` 供按家过滤与能力查表
useRowDiff(runId: string, rowId: string, enabled: boolean)
useRowLog(runId: string, rowId: string, enabled: boolean)

// row-stream.ts（p5）
useRowStream(input: { runId: string; rowId: string; enabled: boolean }): {
  events: AgentEvent[];        // 首帧 /log 补全 + SSE 事件按 seq 去重后合并
  lastSeq: number; connected: boolean; error: unknown;
}
```

每个 hook 都遵循现有 `useSettings` 的回写约定：mutation 成功后 `populateCache` + `revalidate: false`，列表类在 mutation 后显式 `mutate` 一次刷新。

**hook 名以本契约为准**：spec §8 的 hooks 清单是示意（例如它写 `useFetchModels()` / `useValidateWorkspaceRoot()`），
本契约把名字收敛成 §7 这一份——工作区校验不单独开 hook（复用 `useSettings().update` 打 `PUT /api/settings`）。
`useRowStream(rowId)` 同样以本契约的 `{ runId, rowId, enabled }` 入参为准（只给 rowId 无法定位日志目录，行 id 在各自 run 下唯一而非全局唯一）。

---

## 8. `packages/client/ui/src/` —— 新增组件清单（纯展示，props 驱动，不调接口）

| 文件 | 出口 | 职责（一句话） | 关键 props |
|---|---|---|---|
| `base/mono-text.tsx` | `MonoText` | 等宽文本块（日志 / diff / raw），可限高、可滚动、支持尾部自动滚动 | `text, maxHeight?, autoScroll?, dataTestId?` |
| `base/score-bars.tsx` | `ScoreBars` | 5 维度评分条 + 分数 + 理由 | `dimensions: DimensionScore[], compact?` |
| `base/row-status-tag.tsx` | `RowStatusTag` | 行状态 → 彩色 Tag + 中文文案 | `status: EvalRowStatus` |
| `base/metric-line.tsx` | `MetricLine` | token / 轮次 / 耗时 / 得分一行摘要（`null` → 「未采集」/「不支持计量」） | `tokens, turns, durationMs, score` |
| `composite/provider-table.tsx` | `ProviderTable` | 供应商表格 + 操作列 | `providers, onEdit, onDelete, onCreate, loading?` |
| `composite/provider-form-modal.tsx` | `ProviderFormModal` | 供应商新增/编辑弹窗（协议 Radio、密钥 Password、模型清单增删 + 拉取按钮按协议禁用） | `open, initial, saving, fetchingModels, onSubmit, onCancel, onFetchModels, onAddModel, onRemoveModel` |
| `composite/judge-settings-card.tsx` | `JudgeSettingsCard` | 默认评分模型 Select（跨协议分组）+ 输出契约只读预览 + 行超时 + diff 上限 | `settings, providers, onChange(patch), saving` |
| `composite/workspace-settings-card.tsx` | `WorkspaceSettingsCard` | 工作区根目录 Input + 校验按钮 + 结果显示 | `settings, onValidate(root), saving, lastValidated` |
| `composite/case-form-panel.tsx` | `CaseFormPanel` | 用例创建/编辑表单（含 AI 生成、仓库校验、commit 候选下拉、维度只读预览） | `mode: 'new' \| 'edit', initial?, providers, judgeConfigured, saving, generating, validating, commits, repoInfo, dimensions, onSubmit, onCancel, onValidateRepo, onGenerate, onLoadCommits` |
| `composite/case-detail-panel.tsx` | `CaseDetailPanel` | 用例只读详情 + 编辑/删除 | `testCase, referencedRuns, onEdit, onDelete, deleting?`（`deleting?` 是 p2 收口波补进契约的可选 prop：删除请求在途时禁用两个按钮并让删除按钮转圈；缺省 `false`，R34） |
| `composite/run-create-panel.tsx` | `RunCreatePanel` | 创建评测表单（用例 Select、模式 Radio、`Form.List` 候选行 + 协议过滤内联 Alert） | `cases, modelOptionsFor(agentKind), saving, onSubmit, onCancel` |
| `composite/run-detail-panel.tsx` | `RunDetailPanel` / `RANK_BADGE_LIMIT` / `completionPercent(done, total)` | 顶部信息行 + 进度 + 候选卡片列表 + 吸底操作栏（开始/终止） | `run, onStart, onAbortRun, onAbortRow, onOpenLog, onOpenDiff, onOpenScore, starting, aborting` |
| `composite/eval-row-card.tsx` | `EvalRowCard` | 单候选卡片（标题行、分支、计量行、状态、按钮组、排队/截断标注） | `row, rank?, queued, onAbort, onOpenLog, onOpenDiff, onOpenScore` |
| `composite/score-detail-view.tsx` | `ScoreDetailView` | 评分详情（评分条 + 理由 + 总评 + 原始返回） | `score: ScoreResult` |
| `composite/diff-view.tsx` | `DiffView` | 文件清单 + 统一 diff 文本 + 截断提示 | `diff: RowDiff` |
| `composite/log-view.tsx` | `LogView` | 流式日志 + 自动滚底开关 + 下载 | `events: AgentEvent[], connected, onDownload` |
| `composite/provider-models-modal.tsx`（**2026-09-30 新增**） | `ProviderModelsModal` | 模型清单对话框：拉取 + 手工增删 + 逐条窗口/输出上限（从 `ProviderFormModal` 里提出来的） | `open, provider: ProviderView \| null, fetchingModels, onClose, onFetchModels, onAddModel(modelId), onRemoveModel(modelId), onSetModelContext(modelId, capability)` |

> **2026-09-30 修订（模型清单独立成对话框）**：上表 `provider-form-modal.tsx` 那一行的职责与 props **已过期**（模型清单与
> `fetchingModels` / `onFetchModels` / `onAddModel` / `onRemoveModel` / `onSetModelContext` 全部搬进了新增的
> `provider-models-modal.tsx`；编辑弹窗只剩 `open, initial, saving, onSubmit, onCancel`，宽度 720 → 560）。
> `provider-table.tsx` 同时多一个必填 prop `onModels`（「模型」按钮，排在「编辑」之前）。
> 原文保留不改，读法以本行为准；真源见 spec §6.1 的 2026-09-30 修订。

组件一律走 antd（主题 token / 紧凑密度 / 语义 `styles`）；**不手写字号、不手调行内边距、不裸写 `div` 布局**（`AGENT.md`）。
`ui` 的 `index.ts` 追加这些出口；`demo-list-page.tsx` 由 p2 删除（含它的导出）。

`run-detail-panel.tsx` 的**两个具名导出**是 p5 交付时新增的（B5 `b596ac5`，本次回填契约——契约是出口权威，已交付的形状必须对上）：`RANK_BADGE_LIMIT`（只有 1..3 名带徽标的阈值；导出它，用例里就不必再抄第二份 `3`）与 `completionPercent(done, total)`（串行进度百分比的纯函数，`total <= 0` 时返回 **0**，绝不让除零的 `NaN` 流进界面）。后者是**必须**抽出来的，不是风格取舍：`Progress` 的 `percent` 只决定条宽、不产生可断言的文案，留在组件里时「零行不出现 NaN」这条守卫（Review Focus 第 4 条）只能退化成间接断言——实测该变异体存活；抽成可直测的纯函数、组件侧再断言 `role="progressbar"` 的 `aria-valuenow === '0'` 之后，M2/M7 两个变异体才被杀。

---

## 9. `apps/web-next/` —— 路由与页面清单

```
app/api/
├── settings/route.ts                                    # 已有（GET/PUT），p1 只加注释说明它同时承担工作区与评分配置
├── providers/route.ts                                   # GET 列表 / POST 新增                    （p1）
├── providers/[providerId]/route.ts                      # PUT 改 / DELETE 删                      （p1）
├── providers/[providerId]/models/route.ts               # POST 加一条 / DELETE 删一条（query: modelId）（p1）
├── providers/[providerId]/models/fetch/route.ts         # POST 拉取并合并                          （p1）
├── cases/route.ts                                       # GET 列表 / POST 新建                    （p2）
├── cases/[caseId]/route.ts                              # GET / PUT / DELETE                      （p2）
├── cases/validate-repo/route.ts                         # POST { repoPath }                       （p2，见 §11 R7）
├── cases/commits/route.ts                               # POST { repoPath }                       （p2，见 §11 R7）
├── cases/generate-judge-prompt/route.ts                 # POST 生成评分提示词                      （p2）
├── runs/route.ts                                        # GET 列表 / POST 创建                    （p5）
├── runs/model-options/route.ts                          # GET 候选池（按智能体的协议过滤 + 能力元数据）（p5，见 §11 R11）
├── runs/[runId]/route.ts                                # GET                                    （p5）
├── runs/[runId]/start/route.ts                          # POST                                   （p5）
├── runs/[runId]/abort/route.ts                          # POST                                   （p5）
├── runs/[runId]/rows/[rowId]/abort/route.ts             # POST                                   （p5）
├── runs/[runId]/rows/[rowId]/diff/route.ts              # GET（按需现算）                          （p5）
├── runs/[runId]/rows/[rowId]/log/route.ts               # GET ?afterSeq=                          （p5）
└── runs/[runId]/rows/[rowId]/stream/route.ts            # GET（SSE，唯一实时通道）                  （p5）
```

页面：

| 文件 | 计划 | 形态 |
|---|---|---|
| `app/cases/page.tsx` | p2 | 重写：`ListDetailLayout` + 表格；右栏由 `?panel=detail\|new\|edit&id=` 决定（§4.1） |
| `app/runs/page.tsx` | p5 | 重写：列表 + 右栏（详情 / 创建表单，`?panel=` 同口径） |
| `app/settings/page.tsx` | p1 | 填三个占位 Tab（供应商 / 评分配置 / 工作区）；**「界面主题」Tab 是脚手架已实现的功能（§6.4），重写页面时必须原样保留，不得回退** |
| `app/demo/page.tsx` | p2 | **删除**；`src/nav.ts` 去掉 demo 项 |
| `app/page.tsx` | p5 | 落地页跳 `/runs`（§12） |

路由文件只做「zod 校验 → 调 api → 错误映射」，错误一律走 `apps/web-next/src/server-context.ts` 的 `handleApiError`。

**新增依赖边（R11）**：`api → @aieval/agents`。`listModelOptions(agentKind)` 必须读注册表的 `protocolType`（A3 的唯一来源），
而 `api` 不在 `AGENT.md` 的依赖方向表里连这一条。`eslint.shared.ts` 的 `FORBIDDEN.api` 只禁框架、不禁 `@aieval/*`，所以它**不会报错**——
即这条边需要**显式落文档**才不会变成隐性依赖：p5 的计划里有加 `api/package.json` 依赖并 `pnpm install` 的步骤，
执行时同时更新 `AGENT.md` 的依赖方向表（`api → evaluator / agents / core / contracts`）。

---

## 10. 落盘位置与目录结构

```
~/.aieval/config.json                  # settings + providers + cases（AppConfig）
{workspaceRoot}/cases/{caseId}/cache/  # 用例级缓存仓库（来源记录在 {cache}/.git/aieval-origin.json，见 R28）
{workspaceRoot}/{runId}/
├── run.json                           # EvalRun 快照（每次状态变更整体原子覆盖）
└── rows/{rowId}/
    ├── workspace/                     # 该行工作副本（分支 test/{rowId}）
    ├── .agenthome/                    # 该行独立配置目录（CLAUDE_CONFIG_DIR / CODEX_HOME / DSH_HOME / HOME）
    └── events.jsonl                   # 该行事件日志（唯一真相源）
```

---

## 11. 对 spec 的实现层修正（计划里必须显式引用，不得默默偏离）

| # | 修正 | 理由 | 归属计划 |
|---|---|---|---|
| **R1** | `AGENT_KINDS` / `AgentKind` 的真源放 `contracts`（`run.ts`），`agents` 包**再导出** | contracts 不能 import agents（依赖方向单向），而 §5.6.2 又要求前端下拉与 `EvalRow.agentKind` 都从同一处派生 | p0 定义、p3 再导出 |
| **R2** | `EvalRow` 增 `baselineCommit: string`（40 位具体 hash；**空串 = 尚未准备**） | `commitHash: null` 时 diff 没有可比基线；准备阶段把 `HEAD` 解析成具体 hash 才能算 `git diff {base}..HEAD`，顺带让「这轮从哪起算」可追溯。**null 的解析语义由 R20 细化（= 默认分支 tip，不是字面 HEAD）** | p0 定义、p4 写入、p5 展示 |
| **R3** | 三样 diff 的取法固定为：先读 `git status --porcelain`（拿 `??` 未跟踪清单）→ 再 `git add --intent-to-add --all`（只登记不暂存）→ 取 `git diff {baseline}..HEAD` + `git diff HEAD` | spec §5.5 要求「未跟踪的新文件也算产出」，但 `git diff HEAD` 默认不含未跟踪文件的**正文**——不登记就只有文件名、评分模型看不见新文件内容，与「三者合并才是完整产出」相悖。计数的读取时机见 R21（numstat 在 `-N` 之后） | p0 实现 + 回归用例 |
| **R4** | `NOT_A_GIT_REPO` / `INVALID_REF` / `JUDGE_PARSE_FAILED` 进 `ERROR_CODES`（400/400/500） | §10 要求这三个场景有错误码；`httpStatusFor` 要求每个 `ErrorCode` 都有 HTTP 映射。`AgentErrorCode` 仍独立成组（§5.6.6） | p0 |
| **R5** | 生成评分提示词与评分调用共用一个 `callTextApi` + 一个 `resolveJudgeRoute`（都在 `evaluator`，由 p0 建立） | 两处都是「非流式文本 API + 双协议路由」，写两份必然漂移；`api` 本来就依赖 `evaluator`。放 p0 是因为用例域（p2）在 evaluator 编排（p4）之前就要用生成能力 | p0 定义、p2/p4 消费 |
| **R6** | 事件总线是**进程内**订阅 + 从 `events.jsonl` 回放，不做跨进程 | 单 Next 服务进程（§12「单个 Next.js 应用」）；跨进程需要额外消息层，收益为零 | p4 |
| **R7** | 仓库校验与 commit 候选路由按**仓库路径**而非 `caseId`：`cases/validate-repo`、`cases/commits`（取代 spec §8 里的 `cases/[caseId]/validate-repo`、`cases/[caseId]/commits`） | 创建用例时还没有 caseId，而这两件事的输入本来就是仓库路径；按 caseId 会让「新建时校验」无法实现 | p2（并同步修正 spec §8 的路由清单） |
| **R8** | `EvalRow` 增 `providerId: string` | 执行该行要拿供应商的 `baseUrl` 与 `apiKey`；只存 `providerName`（展示快照）无法定位凭据。快照与 id 并存：id 用于执行、快照用于追溯 | p0 定义、p5 写入 |
| **R9** | `EvalRow.error` 增 `code: string` | §5.6.6 / §10 要求失败行带领域归因（`AGENT_FAILED` / `AGENT_TIMED_OUT` / `JUDGE_PARSE_FAILED` 等），只有 `message` 时界面与测试都只能靠文案匹配 | p0 定义、p3/p4 写入、p5 展示 |

以下 R10–R17 是**计划编写期（七份计划各自落地时）暴露并已裁决**的接缝，由契约持有者逐条裁定后回写：

| # | 裁决 | 理由 | 归属 |
|---|---|---|---|
| **R10** | 「改了工作区根目录后旧轮次仍可见」**本阶段接受局限**：`listRuns` / `getRun` 只扫当前 `settings.workspaceRoot`（同进程内另靠「记住 runId → workspaceBase」兜住）。**跨重启 + 改过根目录**的旧轮次既不在列表也 `getRun` 不到 | §6.3 要求「改了设置后找得到旧产物」。彻底解决需要一份「已知根目录索引」这个新落盘物（新增文件 + 写入点 + 迁移口径），而它是单机单用户工具里一次设置变更的边缘场景；把根目录改回去即可恢复可见。**取巧不取默**：界面照 §6.3 显示 `workspaceBase` 实际路径，p6 的关账记录必须把它写进「未做项与后续计划」 | p4 实现现状、p6 记录 |
| **R11** | 新增依赖边 `api → @aieval/agents`，并新增 `GET /api/runs/model-options` + `useRunModelOptions()` | F2 的候选池过滤要读注册表的 `protocolType`（A3 的唯一来源），浏览器够不到 `agents` 包；契约原表把 `listModelOptions` 归 p5 却没给它出口。eslint 的 `FORBIDDEN.api` 只禁框架，这条边**不会报错**，所以必须显式落文档（执行时同步更新 `AGENT.md` 的依赖方向表） | p5 |
| **R12** | `capability` 用三个**可选**透传 prop 送到界面：`MetricLine.usageUnsupported?`、`EvalRowCard.capability?`、`RunDetailPanel.capabilityOf?`（缺省按支持） | §5.6.2/§5.6.3 要求界面按 `usage` / `cancelMidTurn` 改文案，但 `EvalRow` 里没有这两项。备选方案是**把 capability 快照进 `EvalRow`**（更稳，但要动 p0 的契约与 p4 的写入），本阶段不采用，留作后续 | p5 |
| **R13** | spec §9 第 9 项（「故意配一个不存在的评分模型」）**无法按字面执行**：`resolveJudgeRoute` 在调用前就校验「模型在该供应商清单里」，而用例表单的评分模型是 `Select`（不能自由输入）。替代路径：先往供应商清单**手工加一条网关并不提供的模型**（`source: 'manual'`）→ 用例选中它 → 失败发生在上游调用 | 错误码按 `callTextApi` 的映射（401→`AUTH_FAILED`、429→`RATE_LIMITED`、其余→`INTERNAL`），该行仍落 `failed` 且消息可读，第 9 项要证明的「一行失败不拖累其它行」照样成立。**不改 spec**，差异写进 p6 的关账记录 | p6 |
| **R14** | `TextRoute` **不带** `providerId`；`ScoreResult.judgeProviderId` 由 `JudgeInput.judgeProviderId` 承担 | `TextRoute` 是 `callTextApi` 的入参，只需协议/地址/密钥/模型四样；优先级表达式因此出现两处，p4 用**接缝守卫**断言两处恒等来防漂移（与 p3 的元数据回归网同一手法） | p4 |
| **R15** | `fetchProviderModels` 与 `generateJudgePrompt` 的返回类型由同步改为 `Promise<…>` | 两者都必须发一次 HTTP（拉模型 / 调文本 API），原契约写的是同步签名——**不可实现**。名字与参数不变，只放宽返回类型 | 契约自身修正 |
| **R16** | `run-store.ts` 的**首个实现者是 p2**（不是 p4） | p2 的 `deleteCase` 要返回 `affectedRuns`，需要 `listRunsForCase`，而 p2 在 p4 之前执行。p4 落地时**先核验已存在**（`Test-Path`），存在则只跑核验、不重写；不存在才由 p4 建（p4 Task 1 已写成这个分支） | p2 建、p4 核验 |
| **R17** | `core.appendEvent` 的入参用**分配式 Omit**（`PendingAgentEvent`）；非分配 `Omit<AgentEvent, 'seq' \| 'at'>` 会让 p4 的对象字面量调用撞 TS2353 而 `typecheck` 红 | `keyof (A \| B)` 只留公共键，判别联合被压成 `{ type: … }`，成员字段（stream / text / tokens…）全部丢失。另记性能注记：`appendEvent` 每次全量回读定 seq（O(n)/条，长日志下退化 O(n²)），本阶段接受，修法（按文件缓存 max seq + 比对字节数）已写进 p0 的 JSDoc | p0 |
| **R18** | `composeTotalScore` 的分母是**常量 25**（`DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION`），**不是** `scores.length` | spec §5.7/§7.3 的 `round(sum(score) / (5 * n) * 100)` 里 n = **维度数**（本期固定 5），与「5 维满分 100」自洽；p0 原有的测试正是这么断言的（`[5]` → 20、`[5,5]` → 40）。p0 计划原先的实现行写成 `DIMENSION_COUNT * scores.length` 与它自己的 JSDoc、测试、spec 三处都矛盾，已按裁定改掉，p4 计划里据此写的两段理由也同步改写。传不满 5 维时分数只会更低（保守方向），缺维由 p4 的解析器判 `failed` | p0 实现、p4 消费 |
| **R19** | 三样 diff **不含被 gitignore 的文件**：`collectDiff` 的第三步只做 `git add --intent-to-add --all`（不带 `--include-ignored`，**那个选项在 `git add` 上根本不存在**） | 实测 `git version 2.47.0.windows.2`：`git add --intent-to-add --all --include-ignored` → `error: unknown option 'include-ignored'` + usage（退出码非 0，会让整条 `collectDiff` 直接抛错）。就算它存在也不该用：spec §5.5 第 6 步的第三个来源明确是 `git status --porcelain` 的 `??` 未跟踪文件（`??` 本就不含被忽略的文件），而把 `.env` 的正文送进评分提示词是**密钥泄漏**、把 `node_modules` 送进去是噪声淹没真改动。p0 计划里的实现行、JSDoc、R3 说明、两处变异体描述与此处的 gitignore 用例已全部按本条改写（用例反向断言：忽略文件的正文**不得**出现在 diff 里） | p0（Task 10） |
| **R20** | `checkoutRow(dir, null, branch)` 的基线 = **默认分支 tip**，不是「当前 HEAD 的字面值」：HEAD 不在行分支上 → 取 HEAD（生产路径：Task 12 总是先清行目录再复制缓存，HEAD 就是默认分支 tip）；HEAD 已在行分支上 → 取**唯一的非 `test/*` 本地分支**（`git clone` 本地路径只会建一个本地分支，其余映射到 `refs/remotes/origin/*`）；候选为 0 个或 ≥2 个 → 抛 `INTERNAL` 并点名发现的分支，绝不静默挑一个 | 字面读 HEAD 会在「工作区已被用过（HEAD 已在行分支上）」时把 **agent 自己的提交**当成基线——那正是「空 diff + 错误高分」的成因，也是这条测试要拦的事。spec §4.2 的「留空 = 默认分支 HEAD」指的是**仓库默认分支的 tip**。生产路径不依赖启发式（Task 12 保证工作区新鲜），启发式只是让 `checkoutRow` 的语义自身无歧义 | p0（Task 9），细化 R2 的措辞 |
| **R21** | 三条实测细化：①**未跟踪清单**（porcelain）在 `-N` **之前**读，**numstat 计数**（`git diff HEAD --numstat`）在 `-N` **之后**读；②`truncateDiff` 只对**文件片段**计费，段落头（`### 已提交改动…`）与截断标记**始终保留、不计入预算**；③实现里删掉 brief 多写的 import（`unused-imports/no-unused-imports` 是仓库的 error 级规则）并按仓库自己的 `eslint --fix` 修格式 | ①实测：pre-`-N` 的 `--numstat HEAD` **完全不含**未跟踪文件（pre = `1 0 tracked.txt`，post = 它 + `1 0 brand-new.txt`），而 `files`/`filesChanged`/`insertions` 按 spec §5.5 必须把未跟踪新文件算进去；②brief 的边界用例（单文件预算）里若把段落头也计费，会把**全部**文件丢掉，与「保留的文件正文仍在」的断言直接冲突，而截断标记必须恒在（Review Focus 1）；③lint 不通过就等于任务没交付 | p0（Task 10） |
| **R22** | `collectDiff` 的 `files` **按路径去重、增删求和**；`filesChanged` = 去重后的路径数；`text` 保留两段 hunk | 同一文件「已提交又脏」时 numstat 会给出两行同名路径，p5 的文件树会显示重复项（看起来像 bug）；而两段 diff 的改动区间不相交，求和正好等于相对基线的总改动。正文才是评分真源，故 `text` 不去重 | p0（Task 10）、p5 消费 |
| **R23** | 实现侧的 `execute` 也带 `-c core.autocrlf=false`（不只是测试 helper） | 测试侧 flag 修不了 `ensureCaseCache` 里 clone 的检出（实测无 flag 时得到 `'hello\r\n'`）；评测工作区的字节必须与源仓库一致，否则行尾噪声会污染 diff。`.gitattributes` 的显式 `eol` 仍然优先，故刻意用 CRLF 的仓库不受影响。代价：本工具自己的 git 调用不尊重用户的 `autocrlf` 偏好——这正是想要的 | p0（Task 9） |
| **R24** | `appendEvent` 分配 seq 用**静默的原始最大 seq 扫描**（解析 JSON 取数字 `seq`，不可解析的行跳过且**不** WARN），而不是读 `readEvents` 的（schema 过滤后）最大值 | 「可解析但不符合 schema」的既有行**仍然占着它的 seq**；用过滤后的最大值会把已存在的序号再发一次，而 `Last-Event-ID` 续订（§7.4/§8）遇到重复 seq 会**静默丢事件**。坏行告警是**读**路径的职责（`readEvents` 每行一次），写路径再报一次会随追加次数放大 | p0（Task 12） |
| **R25** | `prepareRowWorkspace` 在复制/检出/建目录任一失败时**回滚**（`rmSync` 掉刚建的行目录）后**原样重抛**原错误 | 一个带 `.git` 的「看起来建好了」的目录比没有目录更糟：重试或人工排查会把它当成可用基线；而 `INVALID_REF` 恰恰是用户最可能改完用例再重跑的情形。四步顺序不变，回滚只在失败路径触发；回滚本身若失败只记 WARN，不得掩盖原错误 | p0（Task 11） |
| **R26** | `appendEvent` 在**写侧**也做 `AgentEventSchema.safeParse`：不符合契约时抛中文 `ServiceError('INTERNAL', …)`（点名 zod 的 issue path）且**一个字节都不写**；读侧的容忍（坏行跳过 + WARN）保持不变 | `events.jsonl` 是本阶段的唯一真相源，而写侧容忍的后果不是「报错」而是**静默少一条**：类型正确的 `NaN` 载荷被 `JSON.stringify` 改写成 `null`、p3/p4 的形状漂移（缺 `text` 之类）都会写成功，却在 `readEvents` 的 schema 过滤里被丢掉——抽屉 / `/log` / SSE 回放里这条事件凭空消失，两端都不报错。写侧拦住的代价只是一次 `safeParse` | p0（Task 12） |
| **R27** | 重跑同一行时 `prepareRowWorkspace` **只清 `workspace/` 与 `.agenthome/`**，绝不整目录擦除 `{runId}/rows/{rowId}`；`events.jsonl` 的清空**唯一**由 `resetEvents`（契约 §3.4）负责，回滚路径（R25）同样不碰它 | 行目录里住着唯一真相源 `events.jsonl`。p4 的顺序是 `resetEvents` → 发 `preparing`（seq 1，这一步就把行目录建出来）→ `prepareRowWorkspace`：整目录删会把刚写下的 `preparing` 抹掉，下一次 `appendEvent` 又从 seq 1 发号，而 p5 的 `useRowStream` 按 seq 去重 → 清空后的第一条状态事件被**静默吞掉**，且每一轮都会发生（R24 要防的正是这种静默）。`run.json` 在运行目录里，不受影响 | p0（Task 11/12 的接缝） |
| **R28** | `ensureCaseCache(repoPath, cacheDir, commitHash?)` 把缓存当「**某一个**来源仓库的克隆」来管：①来源记录写在 `{cacheDir}/.git/aieval-origin.json`（来源路径 + tip + 时间戳），来源路径变了**或没有记录** → 删缓存重克隆；②`commitHash === null`（= 默认分支 HEAD，spec §4.2 / R2 / R20）先 `git fetch` + `reset --hard` 到来源当前 HEAD 再复制；③请求的 `commitHash` 不在缓存里 → 先 fetch 一次再判，仍没有才抛 `INVALID_REF`，message 与 context 点名**来源仓库路径**。来源记录放 `.git` 内而不是工作树根：工作树根的文件会被 `copyWorkspace` 复制进行工作区，再被 `git status` 当成「agent 新建的文件」计入三样 diff 与 p5 的文件树 | 「只克隆一次」若顺带把 tip 冻结在克隆那一刻，`commitHash: null` 就不再是「默认分支 HEAD」，来源新增的提交永远不会被评测（静默评测旧代码）；没有来源记录则会把**另一个仓库**的内容当成被测对象（用户改了用例里的仓库路径时尤其危险）；而 `INVALID_REF` 里出现行工作区路径会把用户指向与 p2 校验时（对着来源仓库校验）完全无关的地方。本地路径 `git fetch` 很便宜，故「每用例克隆一次」的承诺不变 | p0（Task 9/11） |
| **R29** | p4 的编排层**不再**单独调 `ensureCaseCache`：缓存准备已由 `prepareRowWorkspace` 内部完成（R28 的三参数形态）；若确实要预热，必须传第三个参数 `run.commitHash` | p4 计划里那句两参数的 `ensureCaseCache(run.repoPath, caseCacheDir(...))` 会落到 `commitHash === null` 分支：对**每个**钉了具体 commit 的行也 fetch + `reset --hard`（纯浪费），而且来源仓库暂时不可达时会直接抛 `NOT_A_GIT_REPO`——哪怕那一行的 commit 早就在缓存里 | p4（p0/p1 评审后同步） |
| **R30** | 消费方判「评分模型是否可用」必须**对着 `providers` 解析** `settings.defaultJudge` 的那一对 id（用例页的「AI 生成」禁用条件、评测侧同理），不能只判 `defaultJudge !== null` | 删除供应商、或在供应商里移除某个模型之后，`defaultJudge` 会变成**悬空引用**：只判非空会让「AI 生成」显示为可用、点下去才在 `resolveJudgeRoute` 抛 `CONFLICT`（p1 的设置卡已经会显示「已失效」，但那只覆盖设置页）。p2 计划里的 `judgeConfigured` 已按本条改写 | p1 评审（Important 2）→ p2 / p5 落地 |
| **R31** | **在 `apps/web-next/app/providers.tsx` 的 `ConfigProvider` 上补 `locale={zhCN}`**（`import zhCN from 'antd/locale/zh_CN'`）——这是「antd 内置文案默认英文」这整类的**根因修复**，由下一个动该文件的阶段落地（p2 若不动它，则归 p6） | 应用一直没有配 antd locale，于是只能靠「每个浮层显式给中文 okText/cancelText/emptyText」逐点补（p1 的 Global Constraint 就是这么写的），**漏一个就漏一个英文**。p1 的 fix wave 已经实证漏了两处：judge Select 的 `No data`（已补）与 `EmptyState` 的 SVG `<title>No data</title>`（**仍在**，只是不可见，属可访问名）；`Modal` 关闭按钮的 `aria-label="Close"` 同源。配一次 locale 可一次性关掉这一整类，且现有那些显式中文文案**不会因此变坏**（显式值优先）。注意：这会让 antd 的其它内置串（分页、日期等）也变中文，而本应用是中文界面，方向正确 | p1 评审（fix wave 的 out-of-scope 根因）→ p2 或 p6 |
| **R32** | 用例的评分模型覆盖是**全有或全无**：`judgeProviderId` 与 `judgeModelId` 必须**同时**非 null 或**同时**为 null。①**判定侧**（`apps/web-next/src/judge-gate.ts` 的 `isJudgeConfigured`）遇到「只填一个」判**不可用**（不回落全局默认）；②**写侧**（`api.createCase` / `updateCase`）拒绝把「只填一个」写进配置：`createCase` 一律校验，`updateCase` 在 `patch` **按值**触及任一评分字段时校验**合并后**的结果，抛 `INVALID_QUERY` + 中文 message；③`TestCaseSchema`（读路径）**不加**这条 refine | 服务端 `resolveJudgeRoute` 对半配置是**直接抛 CONFLICT、不回落**（p0 的「供应商与模型必须成对出现」是刻意校验）。于是「判定回落全局 + 按钮可用 + 点下去 409」构成第三个可达的错误结论（前两个已由 p2 修复波关掉）。两侧口径必须一致，且**一致性方向是「按服务端」**：既不软化服务端的校验（那会静默丢掉用户存进去的一半），也不让界面承诺一件会失败的事。写侧只在 `patch` 触及评分字段时校验，是为了不阻塞「修好一条历史半配置用例的标题」这类无关编辑；读路径不 refine 是为了让历史半配置用例仍然可见（否则它会在列表里凭空消失），可见性与诚实提示由判定侧负责。**⚠️ 实现陷阱（实测踩过两次，务必照做）**：`updateCase` 的「触及」必须按**值**判（`patch.X !== undefined && patch.X !== current.X`），**不能**按「字段出现没有」判——UI 的补丁**永远全量**（`case-form-panel.tsx` 的 `handleFinish` 无条件回交两个评分字段），按出现判定等于判据恒真，历史半配置用例会连标题都改不动（HTTP 400）。同理，守卫用例必须用**UI 真实的完整 payload 形状**写；手写 `{title}` 的守卫是空转的（与 p2 阶段评审的 High F1 同一形状，两次都是它把缺陷放过去的） | p2 修复波残留 → p2 收口波落地（并同步 p2 计划第 3799 行附近的 `judgeConfigured` 口径）；**`updateCase` 的按值判定**由 p2 收口波的 scoped re-review 补正（`N1`） |
| **R33** | p3 的 dsh 依赖走 **`next` 线**：`pnpm --filter @aieval/agents add … @deepseek-ai/dsh-sdk-client@next`（实测写入 **0.1.7-rc.1**），**不是** `latest` | `latest`（0.0.1-rc.1）把 `dsh-llm`/`dsh-session`/`dsh-invariants`/`dsh-sdk-protocol`/`cordis` 声明为 `peerDependencies`，pnpm 自动装 peer 时 `dsh-session` 又 peer 到 `@deepseek-ai/dsh-type-meta`，而该包在 `registry.npm.taobao.org` / `registry.npmmirror.com` / `registry.npmjs.org` **三家全 404**（本机唯一带凭据的内网源 `registry.m.jd.com` ETIMEDOUT）⇒ 按 `latest` 装在本机**不可能完成**。三家公开源结果一致说明这是上游发版问题而非本机网络问题；计划 Global Constraints 只要求「版本由 pnpm 写、不预先猜」，`next` 线满足该约束。代价：dsh 适配器与真实事件探测（Task 11）按 **0.1.7-rc.1** 的形态取证，探测报告必须写明实际安装版本，若上游修好 `latest` 再评估是否回切 | p3 Task 2（依赖落位受阻 → 控制方裁决） |
| **R34** | 契约**收口三个 p2 新增的跨包可见名字**（不改行为、只补文档，§6/§7/§8 已补上）：`GenerateJudgePromptResult`（api 出口的具名类型）、`COMMITS_KEY` + `matchesCommitsKey`（client 出口，候选提交那条 SWR key 的唯一来源）、`CaseDetailPanel.deleting?`（可选 prop，缺省 `false`） | p2 计划的 Global Constraints 写着「本计划不新增任何跨计划可见的名字」，而这三个名字确实跨包可见，且**方向正确**：`COMMITS_KEY`/`matchesCommitsKey` 正是为了消灭用例页里第二份 `/api/cases/commits` 字面量（漂移的表现是「点重新加载候选什么都不发生」，无任何报错）；`GenerateJudgePromptResult` 让 p5/后续不必再写第二个同名结构；`deleting?` 让删除在途时按钮状态有据可依。不补文档的代价是 p5 很可能再写一份字面量或第二个 `dimensions` 类型——这正是本条要防的 | p2 阶段评审（Nit F8）→ 控制方补契约 |
| **R35** | **三家厂商 SDK 必须同时声明在 `apps/web-next/package.json` 的 `dependencies` 里**（版本区间与 `packages/server/agents/package.json` 逐字相同），并且这个声明要由一条守卫测试钉住（`apps/web-next/src/runtime-deps.test.ts`） | p3 的 `serverExternalPackages` 只让 Next 把这三家**外置成裸说明符**，而裸说明符是 **Node 在产物目录里解析**的：产物在 `apps/web-next/.next/server/chunks/`，Node 逐级向上找 `node_modules`，而 pnpm 只把它们链在 `packages/server/agents/node_modules/` —— 实测从 `.next/server/chunks/`、`apps/web-next/`、仓库根三处解析**全部 `MODULE_NOT_FOUND`**。⇒ p4/p5 第一次真实 `import('@aieval/agents')`（webpack 已把它打进 server bundle，其动态 `import()` 会以裸说明符留给 Node）就会在**运行时**炸。这不是打包优化，是「能不能跑起来」的问题。**守卫的两条断言**：① 三家在 app 的 `dependencies` 里且区间与 agents 包**逐字相同**（两边都读 JSON 现比，不把版本抄成测试字面量）；② 从应用根目录能解析到。**一处实测修正（实现者测出、控制方原稿写错过）**：`createRequire().resolve()` 并**不**是「与 ESM/CJS 无关」——它走 exports 的 `require` 条件，而这三家都是 ESM-only（`type: module`、exports 无 `require`），故 codex 必抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（包本身的性质，不是声明缺失）。守卫因此**两条解析器都试**（CJS 优先、失败退到 ESM 的 `import.meta.resolve`），任一通即算解析得到。**残留风险（留给 p6 冒烟）**：该测试只保证「解析得到」，**不保证 Next 把外置说明符发成 `module` 而不是 `commonjs`** —— 若发了 `commonjs`，运行时仍会撞 `ERR_PACKAGE_PATH_NOT_EXPORTED`，那一幕只有在真实 `import()` 落地并起服务跑一行 agent 时才会暴露。**控制方独立复核（`2268f31`）**：删掉 app 的 `@openai/codex-sdk` 声明但**不重装**时只红第 ① 条（`node_modules` 里的链还在）；**删声明 + `pnpm install`** 后**两条全红**（① `expected undefined to be truthy`；② `expected null to be truthy`，即从应用根目录解析不到）⇒ ② 不是空转的，但它守的是**安装后的状态**（「改 package.json 的人忘了重装」这类回归），不是单纯的清单。还原后两份文件 blob 与提交逐字节一致、链恢复、测试回绿 | p3 Task 2 的 build 复核（实现者实测上报）→ 控制方裁决 |
| **R36** | **`runId` 的形状校验落在 `evaluator/run-store.ts` 的 `getRun` / `saveRun` 入口**（`assertRunId`）：空串、以 `.` 开头、含 `/`、`\`、`..` 一律抛 `INVALID_QUERY`（中文文案带原值，context 带 `runId`）。**消费方（p5 的路由）不要再写第二份校验，也不要把这种 id 当 `NOT_FOUND`** | `runId` 会被直接拼进 `{workspaceRoot}/{runId}/run.json`，而 p5 的 `GET /api/runs/{runId}` 把**用户可控的 URL 段**喂进来。p2 阶段评审 F5 提这条时口径是「今天不可达（调用方都传 `randomUUID()`）」——**当日就被实测推翻**：写侧守卫的变异体存活期间，测试探针 `'../../etc'` 真的在系统共享临时根建了目录并写了 `run.json`（已清理，探针也改成 per-run 的 `../escaped`）。⇒ 「只有 `randomUUID()` 会进来」不是安全论证；只要有人构造 id，逃逸当场可达。错误码选 `INVALID_QUERY` 而不是 `NOT_FOUND` 是为了让「形状不对」与「这一轮不存在」在排障时能分开 | p2 阶段评审 F5 → p2 收口波 `aef194b` → p5 消费 |
| **R37** | **`dsh.protocolType` 由 `openai` 改为 `anthropic`**（Task 11 实测：`dsh-llm-deepseek` 走 **`POST {root}/v1/messages`** + **`x-api-key`** 鉴权，讲的是 **Anthropic Messages** wire，不是 chat-completions）。落地清单：`providers/dsh/index.ts` 的元数据、`registry.test.ts` 的 `EXPECTED_METADATA`、spec §5.6.2 的表与 §5.1 第 130 行、契约本节上面的逐格表（`usage` 一并由 Task 12 的探测结论订正为 `true`）。**→ 2026-09-30 收口，见下方「R37 收口」** | `protocolType` 的语义是 spec §5.6.2 明写的「**§5.1 模型候选池按协议类型过滤的数据来源**」：保持 `openai` 会让表单给 DSH 列出**与之不兼容的 OpenAI 网关**（选完到运行时才失败），正是 §5.1 那条「过滤后无可选项时内联说明原因与出路，**而不是让人选完到运行时才失败**」要防的事。**影响面**：p5 的候选池分组里 DSH 从此归 **anthropic 组**（与 Claude Code 同池）；p4 的编排校验（`providerRecord.protocolType !== agentProvider.metadata.protocolType`）与 p6 冒烟读的是**同一份**注册表元数据，自动跟随，不需要各自再写一份对应关系（A3）。**残余不确定性**：只观测到 Anthropic 这一条路径（本机唯一可用网关只实现 `/v1/messages`）；**未验证** dsh 是否**也**支持 chat-completions —— 若将来发现它同时支持多条 wire，`protocolType` 这个**单值字段需要重新设计**（改成数组或加 `protocolTypes`），届时应连同本节与上面那张逐格表的消费方一起改。**证据出处**：探测报告 §4（与 §5.6.2 元数据表的差异）与 §7.2（回写清单）；真机请求路径见该报告 §4 对 `dsh-llm-deepseek/lib/index.js:120-122` 的引用 | p3 Task 11 探测 → 控制方裁决（2026-09-25）→ p3 收尾轮落地；p5 候选池 / p4 校验 / p6 冒烟按本条跟随 |
| **R37 收口（2026-09-30）** | **那条「残余不确定性」已被实测证实，并按其当时的预案落地**：dsh 侧**确实**存在第二条 wire。适配器统一到 **`llm-pi-ai`**，`anthropic → anthropic-messages`、`openai → openai-responses`，**两条都用产品自己的供应商记录真机跑通（含计量）**。因此：① `AgentProviderMetadata.protocolType`（单值）**整体替换**为 `protocolTypes: readonly ProtocolType[]`（计划 D4——不是并存加一格，那样会留下两份真源）；② 四个判定点（api 创建/编辑校验、api 候选池过滤、评分智能体校验、编排层复检）改读**同一个判据** `acceptsProtocol(metadata, protocolType)`，拒绝文案也收成同一份 `protocolMismatchMessage()`；③ `dsh` 的值是 `['openai','anthropic']`，claude-code / codex 仍是单元素数组；④ **不引入第三种 `ProtocolType`**（`openai` 只映射 responses，不映射 chat-completions），故 `ProtocolTypeSchema` 与 `contracts-alignment.test.ts` 一字未改。落地清单逐条指向计划 `docs/superpowers/plans/2026-09-30-dsh-dual-protocol.md` 的 **Task 1–7**（元数据集合化 / 四个判定点 / 传输形状与界面 / overlay 生成器 / 适配器接线 / 退役旧落点 / 放开 dsh 并补正向用例）。**已知边界（登记，不在本次修）**：`evaluator/src/text-api.ts` 的 openai 分支仍打 `POST {base}/chat/completions`——**非智能体评分通路**（`callTextApi`）用不了只讲 Responses 的网关，那是另一条待裁决项（计划 D2b） | 真机探测：`docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`（§2 请求形状、§3 两条 wire 端到端、§4 档位接受度、§7 版本偏斜）；适配器路径的端到端证据见同报告 §9（`probe/v3/dsh-adapter-dual-protocol.mts`，两条协议各一次 `ok:true` + 计量 + `turns≥1`） | 2026-09-30 计划 Task 0 探测 → Task 1–9 落地 → Task 10 收口 |
| **R38** | **SSE 的投递契约与订阅时机必须分开裁决（补 R6 的验收标准）。** ① **投递契约**：`streamRowEvents` 产出的是**具名事件**（`event: <type>`），消费方**必须**用 `EventSource.addEventListener(<type>)` 订阅（类型清单取 contracts 的 `AGENT_EVENT_TYPES`）；`onmessage` 只收默认事件，用它等于零交付。两侧的测试替身必须**具备浏览器语义**（替身要按事件名派发；不具备 `addEventListener` 的替身不得用于验证订阅行为）。 ② **订阅时机与去重**（R6 原文照旧）：先订阅、再读文件、按 seq 去重；`Last-Event-ID` 优先于 `?afterSeq=`。 ③ **验收守卫**：必须有一条**端到端**守卫（真实 HTTP + 真实 `EventSource` 语义），断言「订阅之后发布的事件会到达消费方」；单侧帧格式断言与单侧替身用例**都不算**（F1 已证明它们可以同时全绿而链路全死）。 ④ **已知限制（dev-only）**：dev（Turbopack）重新编译会重建服务端模块图，模块级状态（`subscribers` / `runRoots` / `eventsPaths`）随之换代，**已经建立**的长连接可能被孤立在新的总线之外；prod 无此现象。缓解：把这两处锚到 `globalThis`，或在 dev 流程里约定改完源码重开抽屉。 | p5 阶段评审（2026-09-26）实测：api 的 `toFrame` 发 `event: <type>` 具名事件，而客户端只绑 `onmessage` ⇒ 真实浏览器里 7 种事件**全部没有接收者**（历史靠 `/log`、终态靠 3 秒轮询兜底，症状只表现为「实时通道没有」）。R6 只规定了「订阅**时机**」与「**去重**」，**没有一个字**规定「帧发出去之后浏览器凭什么收得到」——F1 正是从这个缺口漏过去的：两侧各自符合自己的 brief、单测各自全绿、真实链路零交付；而 client 的测试替身**刻意不实现 `addEventListener`、`emit()` 一律喂 `onmessage`**（比真实浏览器弱），所以 24 个变异体一个都拦不住。修复落在客户端（保持帧格式不变：它是计划 Task 3 写死、api 有 4 条断言钉住的语义载体）+ 替身补齐浏览器语义 + 页面层把 `stream.error` 如实显示出来 | p5 整阶段评审（`phase-review-report.md` §2 C1 / §3.5 / §3.6）→ p5 修复波落地；**R6 原文不动**（它的前提——单 Next 进程、模块实例跨 route handler 共享——已被评审实测证实成立） |

| **R39** | **spec §9 第 1 项的判定口径收窄：本次端到端只覆盖 anthropic 协议路径。** spec §9 第 1 项的字面要求是「两个协议各有一个可用供应商、各跑一行」；本环境的实测事实是：**唯一可达的网关只讲 Anthropic Messages**（`/v1/responses` 与 `/v1/chat/completions` 实测 **503 空体**、`/models` 清单为空），codex 的 `wire_api` 硬编码 `'responses'` ⇒ **codex 路径在本环境完全不可达**。⇒ 口径收窄为：**端到端（真机跑）只覆盖 anthropic 路径**（claude-code + dsh 两家都走 anthropic）；**openai / codex 路径在本环境只有类型面与单测面证据**。这不是「未做」而是**环境边界**，按实测记账（p6 关账记录 §0 与 §8 第 3 条、`evidence/guards.md` 第 1–2 条）。**反向要求**：任何「协议覆盖」类的验收叙述都不得把 openai/codex 写成已端到端验过；补它们需要一台能讲 Responses 或 chat-completions 的网关 | p6 冒烟实测（`$smokeRoot\evidence\04-runA.md`、`guards.md`）→ 控制方裁决（2026-09-26）→ 随修复批回填契约 |
| **R40** | **行级计量与时间戳（`durationMs` / `tokens` / `startedAt` / `finishedAt`）只有终态才有。** `EvalRowSchema` **没有** 行级 `startedAt` / `finishedAt`，计量三项在跑动期恒为 `null`（`orchestrator.ts` 的 `result?.tokens ?? null` 口径，见契约 §2.4）⇒ **两处「实时跳动」的断言在改契约之前不可执行**：p6 计划里「跑动期间计量实时跳动」与「卡片耗时的实时跳动」两条，判据必须改成「跑动期恒 `null`、终态才有值」，否则它们要么写成对 `null` 的断言（等于没测实时性），要么直接不可满足。p6 的实测证实了这一点：四次采样跑动期恒 `null`、界面不出现 `0`（关账 §9-4 判定 4.3）。**要真正实现「实时跳动」需要先改契约**（给 `EvalRow` 加行级时间戳、并定义跑动期的部分计量语义），属后续立项 | p6 冒烟实测（关账 §9-4）→ 控制方裁决（2026-09-26） |
| **R41** | **`pnpm test` 满载的超时是已知噪声；根 `pnpm test` 是「根上单跑」，不是每包一行。** ① **超时噪声**：根 `pnpm test` 在一个进程里跑完全部 8 个包，满载时会出现 vitest 的 `Test timed out`（p6 实测：改前 3 条 / 改后 4 条），**零断言失败**（`AssertionError` = 0）；逐条**隔离复跑全部通过** ⇒ 判据是「**隔离复跑**看红不红」，不是「满载那一次的输出」。② **形态**：根 `test` 脚本是**根上单跑**（`vitest run` 走根 `vitest.config.ts` 的 `projects`，一次启动收集 8 个包），**不是** `pnpm -r test` 那种「每包一行输出」；因此**不能**用「输出里有没有 8 段包级汇总」判断它跑全了。③ **配套**：`.next/types` 陈旧会让 `pnpm typecheck` **假红**（删过源码后先重建产物）；单文件命令一律 `pnpm exec vitest run <单文件>`，**不要**用 `pnpm --filter <pkg> test -- <file>`（vitest 把 `--` 当测试名过滤符 ⇒ 收集整包、约 40 s/次，且容易被外部超时强杀） | p6 冒烟实测（`step5-test-{before,after}.txt`、`step5-test-isolated-reruns.txt`）→ 控制方裁决（2026-09-26） |


1. `add --intent-to-add` **之前**：`git diff HEAD` 只含已改文件，未跟踪文件**只有** `git status --porcelain` 里的 `?? b.txt` 一行，正文完全缺席。
2. `add --intent-to-add --all` **之后**：`git status --porcelain` 里 `?? b.txt` 变成 ` A b.txt`（**所以未跟踪清单必须在 `-N` 之前读**，否则拿不到 `??`），而 `git diff HEAD` 里出现 `new file mode 100644` + 正文。
3. `git diff HEAD --numstat` 直接给出每个文件的「插入/删除」两列（实测 `1 1 a.txt` / `1 0 b.txt`），`RowDiff.files` 的逐文件计数与 `filesChanged` / `insertions` / `deletions` 都由它派生，不必自己数 `diff --git` 块。

`ListDetailLayout` 是「列表 + 右栏」的唯一出口（脚手架已建）：p2 的用例页与 p5 的评测页都复用它，**不另写一套**；
右栏宽度偏好键各页一个（如 `cases-detail-width` / `runs-detail-width`），不得复用同一个键。

---

## 12. 每份计划的写作口径

1. 头部固定：标题、`> **For agentic workers:**` 提示、**Goal**、**Architecture**、**Tech Stack**、**Spec**（指向 spec 的**具体章节**，不是整份文档）、**Interfaces source**（指向本文件）。
2. **Global Constraints**：抄本文件 §1 + 本计划特有的硬约束（一行一条，含精确取值）。
3. **Review Focus**：本计划涉及、而 spec 未明说的 5 类输入/条件，一行一条（最可能伤到使用者的在前）。每条都要落到「拥有该代码的任务」的测试步骤里。
4. 任务按「能独立验收的最小交付」切分；每个任务写 **Files**（精确路径 + 若是改动要带行号锚点）、**Interfaces（Consumes / Produces，签名逐字来自本文件）**、编号 checkbox 步骤（写失败测试 → 跑测试看它失败 → 最小实现 → 跑测试看它通过 → 提交）。
5. 步骤里的命令必须是本仓真实可跑的：`pnpm --filter @aieval/<包> test`、`pnpm typecheck`、`pnpm lint`。
6. 提交信息中文，形如 `feat(core): …`；`git add` 逐个显式写路径。
7. 守卫类任务必须有**变异验证**步骤（制造缺陷 → 期望的失败输出 → 还原 → 核对哈希）。
8. 涉及 spec 明确修正的地方，写「本计划对 spec 的实现层修正」小节并引用 §11 的编号。
