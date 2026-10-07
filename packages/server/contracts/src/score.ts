/**
 * 评分结果契约：逐项判定、总分合成口径、以及**送模型的输出契约的两个投影**。
 * 四条必须成立的口径：
 *   1. 模型**不给总分**，只给逐项 `achieved`（布尔）+ 一句理由。总分由 `composeTotalScore` 按权重加总
 *      —— 于是「模型算错总分」这一整类问题从根上消失（旧体系要专门防御「不采信自报的 totalScore」）；
 *   2. `maxScore` 是**满分快照**：生成这一分时评分表的权重之和。评分表改了之后，这一分
 *      与它自己的满分仍然自洽（与 `EvalRun.caseTitle` 同一套冗余快照口径）；
 *   3. `JUDGE_OUTPUT_CONTRACT`（文本）与 `JUDGE_OUTPUT_JSON_SCHEMA`（结构化输出）是
 *      **同一条契约的两个投影**，必须**同批修改**——只动一侧就会让「模型按 schema 回的」与
 *      「解析器按提示词认的」分叉，而那种分叉在界面上表现为「模型回得挺好、解析就是失败」；
 *   4. 两份投影里**都没有 `totalScore`**（口径 1）。`judgments` **不设 minItems/maxItems**：
 *      项数由每个用例的评分表决定，而 schema 是编译期字面量，表达不了「恰好等于这张表的项数」
 *      ——那一条只能由结构检查判（缺一项即整行失败）。
 */
import { z } from 'zod';
import { AgentKindSchema } from './agent';

/** 单项判定：评分表里那一项的**引用键** + 二元 `achieved` + 一句理由。**没有分数**（口径 1：模型不给分） */
export const RubricJudgmentSchema = z.object({
  /** 评分表里那一项的**引用键**（有 id 用 id，没 id 用 `#k`），模型原样照抄 */
  id: z.string().min(1),
  /** 达成 = 拿到该项全部权重；未达成 = 0。**二元判定，没有部分分** */
  achieved: z.boolean(),
  reason: z.string(),
});
/** 单项判定的类型：`composeTotalScore` 的入参就是它（`rubric.ts` 按名字 import 这个类型） */
export type RubricJudgment = z.infer<typeof RubricJudgmentSchema>;

/** 一次评分的完整结果：逐项判定 + 总分 + 满分快照 + 尺子与时间。**总分由系统算**（口径 1、2） */
export const ScoreResultSchema = z.object({
  /** 逐项判定。**必须与快照评分表逐项对齐**：少一项即整行失败（缺项 = 判不了，不等于没达成） */
  judgments: z.array(RubricJudgmentSchema),
  /** 达成项权重之和 */
  totalScore: z.number().int().min(0),
  /** 满分快照 = 生成这一分时评分表的权重之和。**必须为正**：空表的分数不该存在 */
  maxScore: z.number().int().positive(),
  /** 一句话总评 */
  verdict: z.string(),
  /** 模型原始返回，排障用（判断是提示词问题还是模型问题） */
  raw: z.string(),
  judgeProviderId: z.string(),
  judgeModelId: z.string(),
  judgedAt: z.string(),
  /**
   * 这一分是哪个智能体打的；null ⇔ 走纯文本 API。
   * 与 `judgeProviderId` / `judgeModelId` 并列，是「尺子」的一部分：光有模型名回答不了
   * 「这个分是文本请求打的还是智能体会话打的」。`.default(null)` 同 `EvalRunSchema.useAgentJudge`。
   */
  judgeAgentKind: AgentKindSchema.nullable().default(null),
  /**
   * 这一分是不是在 **schema 约束**下拿到的（false = 只靠提示词契约）。
   * ⚠️ 它记的是**我们传了 schema**，不是「上游认了」（网关可能把这格丢掉）。
   * `.default(false)` 同 `judgeAgentKind`：磁盘上已有的评分记录要能读回。
   */
  structuredOutput: z.boolean().default(false),
});
/** 一次评分的完整结果类型（`EvalRow.score` / `AgentEvent.score` 存的就是它） */
export type ScoreResult = z.infer<typeof ScoreResultSchema>;

/**
 * 评分输出的 JSON Schema（结构化输出用）：给 claude-code 的 `outputFormat` 与 codex 的 `outputSchema` 用。
 * 四条口径：
 *   1. **只用可移植子集**：不出现 `oneOf` / `const` / `prefixItems` / `uniqueItems`；
 *   2. **与 `JUDGE_OUTPUT_CONTRACT` 同形**：改一份必须同批改另一份；
 *   3. **没有 `minItems` / `maxItems`**：项数由每张评分表决定，编译期字面量表达不了（见文件头口径 4）；
 *   4. `achieved` 取 `boolean` **严档**：请求侧阻止字符串，代价是网关不透传时模型仍可能回 `"true"`
 *      —— 解析侧对此**宽容读**（`collectJudgeJudgments`），这是一处**有意登记的差异**，
 *      与旧体系「schema 拒 6 分、解析器夹紧到 5」同一形状。
 */
export const JUDGE_OUTPUT_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['judgments', 'verdict'],
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'achieved', 'reason'],
        properties: {
          id: { type: 'string' },
          achieved: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string' },
  },
} as const);

/**
 * 生成的提示词必须自带的输出契约文本：**单一真源**，生成侧与解析侧共用同一份字段名。
 * 写死「只输出 JSON」是必需的——否则模型回一段散文，解析侧就翻车。
 * 第 5 条（不要给总分）不是修辞：模型一旦自报总分，界面上就可能出现两个互相矛盾的数。
 */
export const JUDGE_OUTPUT_CONTRACT = [
  '输出要求（务必严格遵守）：',
  '1. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字，不要使用 markdown 代码围栏；',
  '2. 字段结构固定为：',
  '   {',
  '     "judgments": [',
  '       { "id": "评分表里的引用键，原样照抄", "achieved": true, "reason": "一句中文说明" }',
  '     ],',
  '     "verdict": "一句话中文总评"',
  '   }',
  '3. 评分表里的**每一项**都必须恰好给出一条判定：不许多、不许少、不许合并、不许改 id；',
  '4. "achieved" 只允许 true / false 两个值：目标达成给 true，未达成给 false；',
  '5. 你的回复里**不要**给总分——总分由系统按「达成项的权重之和」计算。',
].join('\n');
