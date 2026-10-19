/**
 * 用例表单的 form-local 校验与提交归一（zod resolver）。
 *
 * 三条边界：
 *   1. **不整份复用 `CaseCreateSchema`**：契约的 `min(1)` 没有中文 message（表单会冒出英文默认文案），
 *      且表单里「没填分支 / commit」是空串而契约要 `null`。文案逐字抄界面原有的那几句。
 *   2. **能复用的格子直接嵌契约**：`repoPath` 用 `RepoSourceStringSchema` —— 它已经把「纯空白」与
 *      「协议白名单」都做成中文 issue，字段级提示因此与保存时是**同一句话**（`ftp://…` 会拿到
 *      完整的协议白名单，而不只是「请填写 git 地址」）。这里是字段级 `safeParse` 再搬 issue，
 *      因为该字段在「无来源」态是隐藏的，不能无条件校验。
 *   3. **整表规则复用写侧函数**：`rubric` 调 `validateRubric`（提交 / 落盘 / 设置页共用同一份），
 *      自己再写一份「至少一组、组名非空…」必然漂移，漂移的症状是「表单放过去、服务端拒掉」。
 *
 * 来源态是**界面态**（用户显式选的那个 Radio），以回调注入、校验那一刻才读：
 * 它只决定「校验不校验 repoPath」，不参与服务端的形态判定；提交时的归一在 `toCaseCreate`。
 */
import {
  NONE_SOURCE,
  RepoSourceStringSchema,
  RubricSchema,
  validateRubric,
  type CaseCreate,
  type Rubric,
} from '@aieval/contracts';
import { z } from 'zod';

/** 来源类型：界面显式选择；「无」提交时把哨兵值 `none://` 写进 `repoPath` */
export type CaseSourceKind = 'local' | 'remote' | 'none';

/** 表单内部值：`commitHash` / `repoBranch` 允许空串（输入框清空拿到的是空串，提交时归一成 null） */
export interface CaseFormInput {
  title: string;
  taskPrompt: string;
  /** 评分标准项：表单里的一个字段，空表也是合法值，非空由 `validateRubric` 拦 */
  rubric: Rubric;
  repoPath: string;
  commitHash?: string;
  repoBranch?: string;
  /** 「包含步骤」开关：只影响评分阶段，提交时原值透传 */
  includeSteps: boolean;
}

export function caseFormSchema(sourceKind: () => CaseSourceKind) {
  return z
    .object({
      // 两条规则各管一段：`min(1)` 只判空串，`trim()` 那条才判纯空白。少了后者，只有空格的标题
      // 会先被提交时的 trim 变成 ''，用户白等一次往返、拿到的还是一句与字段无关的笼统报错
      title: z
        .string()
        .min(1, '请填写标题')
        .refine((value) => value.trim() !== '', '标题不能只有空格'),
      taskPrompt: z.string().min(1, '请填写考题提示词'),
      rubric: RubricSchema.superRefine((rubric, ctx) => {
        const checked = validateRubric(rubric);
        if (!checked.ok) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: checked.message });
        }
      }),
      // 这一格的规则在对象级 superRefine 里：无来源态它不参与校验（整格隐藏，提交落哨兵值）
      repoPath: z.string(),
      commitHash: z.string().optional(),
      repoBranch: z.string().optional(),
      includeSteps: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (sourceKind() === 'none') return;
      const parsed = RepoSourceStringSchema.safeParse(values.repoPath);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repoPath'], message: issue.message });
      }
    });
}

export type CaseFormSchema = ReturnType<typeof caseFormSchema>;
export type CaseFormOutput = z.output<CaseFormSchema>;

/**
 * 提交归一：表单值 → 契约的 `CaseCreate`（空串 → `null`、无来源落哨兵值、两侧空白 trim）。
 *
 * 放在校验**之后**单独一步，而不是 zod `.transform`：`RubricSchema` 的 `id` 有 `.default('')`，
 * 带 transform 的整链会让 `setValue('rubric', …)` / `useWatch` 在输入侧与输出侧各推一个类型，
 * 而两者只差「id 在不在」——那点差异制造出的类型断言比这段 5 行的归一更贵。
 * 归一仍然只此一处，而且它的入参是 resolver 已经校验过的值。
 */
export function toCaseCreate(
  values: CaseFormOutput,
  sourceKind: CaseSourceKind,
): CaseCreate {
  const commitHash = (values.commitHash ?? '').trim();
  const branch = (values.repoBranch ?? '').trim();
  return {
    title: values.title.trim(),
    repoPath: sourceKind === 'none' ? NONE_SOURCE : values.repoPath.trim(),
    // 无来源：服务端对「无 + 分支 / commit」是硬拒绝，两格恒为 null
    commitHash: sourceKind === 'none' || commitHash === '' ? null : commitHash,
    // 分支必须交真实值：编辑一条远端用例时交 null 等于静默清掉它的分支（保存后这一轮会换起点）
    repoBranch: sourceKind === 'remote' && branch !== '' ? branch : null,
    taskPrompt: values.taskPrompt,
    rubric: values.rubric,
    includeSteps: values.includeSteps,
  };
}
