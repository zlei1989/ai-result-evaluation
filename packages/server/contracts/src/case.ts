/**
 * 用例契约：用例实体、增删改入参、仓库与 commit 的校验入参。
 * 三个必须成立的口径：
 *   1. `commitHash: null` 的语义是「用默认分支 HEAD」，所以是 nullable 而不是 optional——
 *      空串不合法，避免「留空」在落盘时变成两种不同的值；
 *   2. `repoBranch: null` 同一口径（null = 用远端默认分支），且带 `.default(null)`：
 *      旧 config.json 里根本没有这一列，读回来必须是 null 而不是 undefined；
 *   3. 仓库校验与 commit 候选按**仓库路径**入参（§11 R7）：创建用例时还没有 caseId，
 *      而这两件事的输入本来就是仓库路径。
 *
 * **用例不再持有评分模型**：评分与「AI 生成」一律走设置页「评分配置」的全局默认
 * （`settings.defaultJudge`），这里刻意没有 `judgeProviderId` / `judgeModelId`——
 * 留着它们就等于留着一条「用例覆盖 > 全局默认」的优先级，而那条优先级已经从服务端消失。
 * 历史 config.json 里残留的那两列由 `api/cases.ts` 的读侧归一丢掉。
 */
import { z } from 'zod';
import { RepoSourceStringSchema } from './repo-source';
import { RubricSchema } from './rubric';

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 代码来源：本地绝对路径 或 远端 git 地址（形态判定见 repo-source.ts） */
  repoPath: RepoSourceStringSchema,
  /** null = 默认分支 HEAD；填了必须能通过 `git cat-file -e <hash>^{commit}` */
  commitHash: z.string().min(1).nullable(),
  /** 远端来源的分支；null = 远端默认分支。本地来源必须是 null（写侧拦） */
  repoBranch: z.string().min(1).nullable().default(null),
  taskPrompt: z.string().min(1),
  /**
   * 评分标准项（组 → 评分表）。**必填**，空表是 `{ groups: [] }` 而不是 undefined：
   * 契约层刻意不设 `.min(1)`（那会让「新建用例」这个动作本身非法），非空要求由 `validateRubric`
   * 在提交时给出。`judgePrompt`（一段自由文本）已随本次重构删除——评分口径现在只有这一份真源。
   */
  rubric: RubricSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

/** 新建用例入参：两个可空字段缺省为 null，表单不填就是「用默认」 */
export const CaseCreateSchema = z.object({
  title: z.string().min(1),
  repoPath: RepoSourceStringSchema,
  commitHash: z.string().min(1).nullable().default(null),
  repoBranch: z.string().min(1).nullable().default(null),
  taskPrompt: z.string().min(1),
  rubric: RubricSchema,
});
export type CaseCreate = z.infer<typeof CaseCreateSchema>;

/** 部分更新：只给要改的字段（改标题不该被迫重填仓库路径） */
export const CasePatchSchema = CaseCreateSchema.partial();
export type CasePatch = z.infer<typeof CasePatchSchema>;

/** 仓库校验结果：本地来源只填前三项 + kind='local'，远端另有镜像三件套与 tip（spec §4.3） */
export const RepoInfoSchema = z.object({
  repoPath: z.string(),
  repoName: z.string(),
  branch: z.string(),
  kind: z.enum(['local', 'remote']),
  mirrorPath: z.string().nullable(),
  mirrorReady: z.boolean(),
  mirrorFetchedAt: z.string().nullable(),
  tip: z.string().nullable(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

/** commit 候选（spec §4.2 最近 20 条）：纯便利功能，手工输入任意合法 hash 仍然可行 */
export const CommitCandidateSchema = z.object({
  hash: z.string(),
  subject: z.string(),
});
export type CommitCandidate = z.infer<typeof CommitCandidateSchema>;

/** 校验入参：**按仓库路径**而不是按 caseId（见 §11 R7） */
export const RepoPathInputSchema = z.object({ repoPath: z.string().min(1) });

/**
 * 来源 + 可选分支的入参：校验与候选共用同一形状。
 * 保留两个名字是因为它们在接口上是两件事（校验仓库 / 列提交候选），实现共用一份 schema——
 * 写两遍必然漂移，而漂移的症状是「两个接口对同一个来源给出不同判定」。
 */
const RepoSourceQuerySchema = RepoPathInputSchema.extend({
  repoBranch: z.string().min(1).nullable().default(null),
});
export const RepoValidateInputSchema = RepoSourceQuerySchema;
export const RepoCommitsInputSchema = RepoSourceQuerySchema;
export type RepoValidateInput = z.infer<typeof RepoValidateInputSchema>;
export type RepoCommitsInput = z.infer<typeof RepoCommitsInputSchema>;

/**
 * 生成评分标准项入参：两个动作共用一个入口，由 `prompt` 是否为空分派。
 *   · `prompt` 为空  ⇒ 「智能生成」：按题面 + 当前表格让 AI **补充**条目（用 `repoPath` 取仓库名）；
 *   · `prompt` 非空  ⇒ 「智能识别」：把用户粘贴的评分要求解析成表格，**不碰仓库**
 *     （故 `repoPath` 可空——「填了提示词却因为仓库路径没填而识别不了」这个组合被这条规则消灭）。
 * **不带评分模型**：两个动作都只用设置页「评分配置」的全局默认（`resolveJudgeRoute()` 无参），
 * 入参里再带一对 id 就等于让调用方能绕开设置页那一格。
 */
export const GenerateRubricSchema = z.object({
  /** 当前表格（「智能生成」的输入；识别分支忽略它）。空表就是 `{ groups: [] }` */
  rubric: RubricSchema,
  /** 题面：生成分支必填，识别分支可空（填了会作为识别上下文） */
  taskPrompt: z.string().default(''),
  /** 用户粘贴的评分要求：非空 ⇒ 走识别分支 */
  prompt: z.string().default(''),
  /** 仓库来源：生成分支用它取仓库名，识别分支可空 */
  repoPath: z.string().default(''),
});
export type GenerateRubricInput = z.infer<typeof GenerateRubricSchema>;
