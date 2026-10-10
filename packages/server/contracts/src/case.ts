/**
 * 用例契约：用例实体、增删改入参、仓库与 commit 的校验入参。
 * 三个必须成立的口径：
 *   1. `commitHash: null` 的语义是「用默认分支 HEAD」，所以是 nullable 而不是 optional——
 *      空串不合法，避免「留空」在落盘时变成两种不同的值；
 *   2. `repoBranch: null` 同一口径（null = 用远端默认分支），且带 `.default(null)`：
 *      旧 config.json 里根本没有这一列，读回来必须是 null 而不是 undefined；
 *   3. 仓库校验与 commit 候选按**仓库路径**入参：创建用例时还没有 caseId，
 *      而这两件事的输入本来就是仓库路径。
 *
 * **用例不再持有评分模型**：评分与「AI 生成」一律走设置页「评分配置」的全局默认
 * （`settings.defaultJudge`），这里刻意没有 `judgeProviderId` / `judgeModelId`——
 * 留着它们就等于留着一条「用例覆盖 > 全局默认」的优先级，而那条优先级已经从服务端消失。
 * 历史 config.json 里残留的那两列由 `api/cases.ts` 的读侧归一丢掉。
 */
import { z } from 'zod';
import { RepoSourceStringSchema } from './repo-source';
// 值（schema）与类型都要：`GenerateRubricResult` 的形状直接引用它们
import { RubricSchema, type Rubric, type RubricChange } from './rubric';

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 代码来源：本地绝对路径 或 远端 git 地址（形态判定见 repo-source.ts） */
  repoPath: RepoSourceStringSchema,
  /** null = 默认分支 HEAD；填了必须能通过 `git rev-parse --verify <hash>^{commit}`（一条命令判定存在并把短哈希归一成 40 位） */
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

/**
 * 用例 id 的形状判据（**文件名安全**）。
 *
 * 为什么必须有这条判据：用例现在一文件一落（`<casesRoot>/<case-id>.json`），id 会**直接当文件名**用，
 * 而今天的 id 从 `randomUUID()` 来、路上没有任何人校验过它。一个带 `/` 或 `..` 的 id
 * （手工造的用例文件、外部脚本写进来的）会让读写跑到 `<casesRoot>` 之外去——读侧是路径穿越，
 * 写侧是往用户目录里落文件。runId 早有同类判据（core 的 `isRunIdShapeValid`），用例这一侧是缺的。
 *
 * 值域与 UUID 兼容（十六进制 + 连字符，大小写都收），同时容得下手写的可读 id，
 * 上限 64 与运行目录口径一致：宁可在写侧拒掉一个奇怪 id，也不要在磁盘上留一个走不出去的目录。
 */
export const CASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** id 是否满足文件名安全形状（写侧拒绝、读侧跳过，见 core 的 `assertCaseId`） */
export function isCaseIdShapeValid(caseId: string): boolean {
  return CASE_ID_PATTERN.test(caseId);
}

/**
 * 用例列表的下行形状：`cases` + **跳过的坏文件原因**。
 *
 * 为什么把 warnings 放在同一份响应里而不是只写日志：用例一文件一落后，`<casesRoot>` 里多出一个
 * 手改坏的 / 非法的文件是很自然的事，读侧又是**跳过**（一条坏文件不能让整页列表 500）。
 * 跳过而不说，用户的症状是「我的用例不见了」却查不到原因；这一格就是那句话的唯一出口。
 */
export interface CaseList {
  cases: TestCase[];
  warnings: string[];
}

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

/** 仓库校验结果：本地来源只填前三项 + kind='local'，远端另有镜像三件套与 tip */
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

/** commit 候选（最近 20 条）：纯便利功能，手工输入任意合法 hash 仍然可行 */
export const CommitCandidateSchema = z.object({
  hash: z.string(),
  subject: z.string(),
});
export type CommitCandidate = z.infer<typeof CommitCandidateSchema>;

/** 校验入参：**按仓库路径**而不是按 caseId */
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
 * 「生成 / 识别 / 调整」三个动作**共用一个入口**，由 `mode` 显式分派。
 *
 * 为什么原来是隐式的（`prompt` 空不空）而现在必须显式：两支时「有没有粘文本」刚好等于「走哪一支」，
 * 加上第三支（`adjust`：拿一句话改**现有的**表）之后这个等式就不成立了——`recognize` 与 `adjust`
 * 都需要 `prompt`，靠它再也分不出意图，于是只能由调用方猜。三支各自要什么：
 *   · `generate` 「智能生成」：题面 + **当前表格**（AI 只补缺的，见 `mergeRubric`）+ `repoPath`（取仓库名）；
 *   · `recognize`「智能识别」：`prompt`（用户粘进来的评分要求），**不碰仓库**，结果是**整表替换**；
 *   · `adjust`   「智能调整」：`prompt`（一句话指令）+ **当前表格**，结果仍是完整表格，外加一份
 *     改动清单（`diffRubric` 从「旧表 vs 新表」算出来，见 `GenerateRubricResult.changes`）。
 * **不带评分模型**：三个动作都只用设置页「评分配置」的全局默认（`resolveJudgeRoute()` 无参），
 * 入参里再带一对 id 就等于让调用方能绕开设置页那一格。
 */
export const GenerateRubricSchema = z.object({
  /** 走哪一支。**必填**：见上面那段「为什么从隐式改成显式」 */
  mode: z.enum(['generate', 'recognize', 'adjust']),
  /** 当前表格（生成分支的合并基线、调整分支的改造对象；识别分支忽略它）。空表就是 `{ groups: [] }` */
  rubric: RubricSchema,
  /** 题面：生成分支必填；识别 / 调整分支可空（填了会作为理解文本的上下文） */
  taskPrompt: z.string().default(''),
  /** 用户写的文本：识别分支是「粘进来的评分要求」，调整分支是「一句话指令」；生成分支不用它 */
  prompt: z.string().default(''),
  /** 仓库来源：生成分支用它取仓库名，识别 / 调整分支可空 */
  repoPath: z.string().default(''),
});
export type GenerateRubricInput = z.infer<typeof GenerateRubricSchema>;

/**
 * 三个动作的**共同响应形状**（放契约里而不是 api 包里：api / client / ui / 页面四层都要它，
 * 谁都不该为了一个响应类型去引 `@aieval/api` —— 那会凭空造出跨包依赖边）。
 *
 * 三格里只有 `rubric` 是三支共有的；另外两格各有归属，看它们的注释，别拿 `addedItems === 0`
 * 去判「什么都没发生」（识别与调整分支恒为 0）。
 */
export interface GenerateRubricResult {
  /** 回填的完整表格：生成分支是**合并后**的、识别分支是**整表替换**的、调整分支是**模型改完**的那张 */
  rubric: Rubric;
  /**
   * **只有生成分支**有意义：这一次往当前表格里**新增**了多少项（0 ⇒ 模型说「已经完备」，界面显示「未新增条目」）。
   * **识别 / 调整分支恒为 0**——它绝不代表「什么都没识别 / 什么都没改」，那两支要判成败得看 `rubric` 与 `changes`。
   */
  addedItems: number;
  /**
   * **只有调整分支**有：模型改完的那张表与用户原来那张表的**逐条差异**，由 `diffRubric` 从两张表算出来
   * （不是模型自述——单一真源是那张表本身）。界面拿它做「改动清单」，**用户确认之后才回写表格**。
   * 空数组表示「模型认为不需要改」，此时调用方**不要**回写。
   */
  changes?: RubricChange[];
  /** 只在需要解释时出现（「未新增条目」/「不需要修改」）。**识别分支不带它** */
  note?: string;
}
