/**
 * 创建评测表单的 form-local 校验（zod resolver）。
 *
 * 三条口径：
 *   1. **候选行是数组字段**：`rows` 至少一行、每行的智能体与模型都必须选（模型用编码值 `providerId::modelId`
 *      承载，解码在组件里做——schema 只判「非空」）。
 *   2. **行内错误必须是层级路径**：zod issue 的 path 是 `['rows', index, 'agentKind']`，
 *      RHF 会把它落成 `errors.rows[index].agentKind`；写成扁平键（`rows.1.agentKind`）挂不上红字。
 *   3. **用例与备注可为空态输入**：`caseId` 在新建时没有初值（下拉未选），所以 schema 的**输入**允许
 *      `undefined`，对象级 superRefine 给「请选择用例」，最终 transform 成必填字符串——
 *      这样 `defaultValues` 能把下拉留在「未选」的占位态，而不是塞一个空串进去。
 */
import { AGENT_KINDS, type AgentKind, type ExecutionMode } from '@aieval/contracts';
import { z } from 'zod';

/** 行值的表单形状：模型用编码值 `providerId::modelId`，编辑时另带原行 id */
export interface RunRowInput {
  id?: string;
  agentKind: AgentKind;
  modelKey: string;
  effort?: string;
}

/** 表单值（resolver 的输入侧）：`caseId` 未选时是 `undefined`（下拉占位态） */
export interface RunFormInput {
  caseId?: string;
  note: string;
  executionMode: ExecutionMode;
  useAgentJudge: boolean;
  askUser: boolean;
  injectMessages: boolean;
  rows: RunRowInput[];
}

/** resolver 的输出侧：`caseId` 已确认非空，其余原样 */
export interface RunFormValid {
  caseId: string;
  note: string;
  executionMode: ExecutionMode;
  useAgentJudge: boolean;
  askUser: boolean;
  injectMessages: boolean;
  rows: RunRowInput[];
}

export function runCreateFormSchema() {
  return z
    .object({
      caseId: z.string().optional(),
      note: z.string(),
      executionMode: z.enum(['serial', 'parallel'], {
        errorMap: () => ({ message: '请选择执行模式' }),
      }),
      useAgentJudge: z.boolean(),
      askUser: z.boolean(),
      injectMessages: z.boolean(),
      // 列表级非空：`useFieldArray` 没有 `rules`，这条只能落在 schema 上
      rows: z
        .array(
          z.object({
            // 编辑时的原行 id：编辑载荷是行集合的全量替换，丢了它整轮结果会被当成新行
            id: z.string().optional(),
            agentKind: z.enum(AGENT_KINDS, { errorMap: () => ({ message: '请选择智能体' }) }),
            modelKey: z.string().min(1, '请选择模型'),
            // 强度按需带：没选就**不写这个键**（服务端把「没说」与「说了某个档」分得很清）
            effort: z.string().optional(),
          }),
        )
        .min(1, '至少需要一个候选行'),
    })
    .superRefine((values, ctx) => {
      if (values.caseId === undefined || values.caseId === '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['caseId'], message: '请选择用例' });
      }
    })
    .transform((values): RunFormValid => ({ ...values, caseId: values.caseId ?? '' }));
}

export type RunCreateFormSchema = ReturnType<typeof runCreateFormSchema>;
