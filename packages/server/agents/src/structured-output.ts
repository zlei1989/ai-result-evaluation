/**
 * 结构化输出的**判据与修正原料**（与厂商、与业务都无关）。
 *
 * 为什么需要它：`AgentRunInput.outputSchema` 是一份中性事实（调用方「想要」按这份 JSON Schema 出答复），
 * 但**能不能落实**在每家不一样——有的厂商有原生 schema 通道（形状由它保证），有的只能在提示词里交代
 * 并由我们自己判。要把这两种家对齐，就必须有一处**统一判据**回答「这段答复算不算合格」，并交出
 * 一份**能直接回灌给模型**的问题清单。本模块就是那一处：
 *   · `planStructuredOutput` —— 把 JSON Schema 编译成 zod（一次），编译不了就退化成「只判可解析」；
 *   · `inspectStructuredOutput` —— 按计划判一段答复，产出「合格 / 问题清单」；
 *   · `buildStructuredOutputInstruction` / `buildStructuredOutputFeedback` —— 两段提示词原料
 *     （首轮交代约束、修正轮交代问题）。
 *
 * 三条口径：
 *   1. **判据只有一处**：一致性套件（`providers/conformance/structured-output.ts`）与运行时的修正循环
 *      共用本模块；各写一份必然漂移，而漂移的表现是「套件绿、运行时红」。
 *   2. **fail-open**：不认识的 keyword 不生成约束（记进 `ignoredKeywords` 由调用方落 DEBUG）；
 *      整份 schema 编不出来（非对象 / 结构非法）就退回「只 `JSON.parse`」并把 `degraded` 置真。
 *      绝不因为「我们不认识它」而把一次合格答复判成不合格、白跑一轮修正。
 *   3. **永不抛**：厂商负载与调用方给的 schema 都是 `unknown`，读之前先收窄；任何解析意外都折成
 *      一条问题，绝不把异常冒进适配器主流程（与 `json.ts` 同一条纪律）。
 *
 * 与 evaluator 的关系：`evaluator/src/judge.ts` 的 `stripCodeFence` 与 `RAW_KEEP_CHARS` 是**业务侧**
 * 的同名判据（它还管引用键、总分与宽容读）。依赖方向不允许本包反向 import 它，故那一小段围栏判据
 * 在这里**必须**有一份同形副本；改一处必须同批改另一处（两处都是「只剥整段以 ``` 开头」）。
 */
import { z } from 'zod';
import { asRecord } from './json';

/** 一条问题：`path` 是点号路径（`judgments[0].achieved`），`message` 是可直接展示的中文说明 */
export interface StructuredOutputProblem {
  path: string;
  message: string;
}

/**
 * 一次编译的结果。`schema` 分支可以直接校验；`parse-only` 分支只保证「是合法 JSON」——
 * 调用方**必须**把 `reason` 落进日志，否则「我们其实没校验形状」这件事就静默了。
 */
export type StructuredOutputPlan =
  | { kind: 'schema'; schema: z.ZodTypeAny; ignoredKeywords: string[] }
  | { kind: 'parse-only'; reason: string };

/** 一次检查的结论：`degraded` 为真 = 这一判只到「可解析」为止（形状没判） */
export type StructuredOutputInspection =
  | { ok: true; value: unknown; degraded: boolean }
  | { ok: false; problems: StructuredOutputProblem[]; degraded: boolean };

/** 修正轮里随答复一起回灌的原文上限：要装得下整份 JSON，又不至于把上下文撑爆 */
export const REPAIR_RAW_KEEP_CHARS = 20_000;

/**
 * 剥掉 markdown 围栏。
 * 只在「整段回答以 ``` 开头」时剥：中间夹散文的情况故意不救——契约要求只输出 JSON，
 * 从散文里抠 JSON 会把「模型没守契约」静默变成「成功」，而暴露它正是检查的职责。
 */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) return text;
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/** 路径拼接：根用 `$`，属性用 `.name`，数组下标用 `[i]`（与 JSON Pointer 的读法一致，只是更好读） */
function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base === '$' ? `$.${key}` : `${base}.${key}`;
}

/**
 * 把一个 JSON Schema 节点编译成 zod。
 * 返回 `null` = **这个节点编不出来**（认得的 keyword 给出了非法值）⇒ 整份 schema 退化成只判可解析。
 * 认不得的 keyword 不算失败（见文件头的 fail-open），只把名字收进 `ignored`。
 *
 * 覆盖面刻意停在**本仓用得到的可移植子集**上（`contracts/src/score.ts` 已把这条口径写成守卫：
 * 不出现 `oneOf` / `const` / `prefixItems` / `uniqueItems`）：`type`、`properties`、`required`、
 * `items`、`enum`、`additionalProperties`。`type` 缺席时按「有 `properties`/`required` 就当对象、
 * 有 `items` 就当数组」推断——本仓两份 schema 都显式写了 `type`，这条推断只为让第三方 schema 不至于
 * 因为少写一个键就整份退化。
 */
function compileNode(node: unknown, path: string, ignored: Set<string>): z.ZodTypeAny | null {
  if (node === true) return z.unknown();
  if (node === false) return z.never();
  const record = asRecord(node);
  if (record === null) return null;

  const known = new Set([
    'type',
    'properties',
    'required',
    'items',
    'enum',
    'additionalProperties',
    'description',
    'title',
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) ignored.add(`${path}.${key}`);
  }

  let base: z.ZodTypeAny;

  if (record.enum !== undefined) {
    const values = Array.isArray(record.enum) ? record.enum : null;
    if (values === null || values.length === 0) return null;
    // JSON Schema 的 enum 是**深比较**（对象/数组也能当取值），zod 的 literal 只收基本类型
    // ⇒ 用规范序列化后的集合判等，文案里把允许的取值原样列出来
    const allowed = new Set(values.map((value) => canonical(value)));
    const shown = values.map((value) => JSON.stringify(value)).join(' / ');
    base = z.custom<unknown>((value) => allowed.has(canonical(value)), { message: `期望取值为 ${shown}` });
  } else if (Array.isArray(record.items) || record.items !== undefined) {
    // `items` 是数组（tuple / prefixItems 时代写法）不在子集里 ⇒ 编不出来
    if (Array.isArray(record.items)) return null;
    const item = compileNode(record.items, joinPath(path, 'items'), ignored);
    if (item === null) return null;
    base = z.array(item);
  } else if (record.properties !== undefined || record.required !== undefined) {
    const shape: Record<string, z.ZodTypeAny> = {};
    const properties = record.properties === undefined ? {} : asRecord(record.properties);
    if (properties === null) return null;
    const required = record.required === undefined ? [] : record.required;
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) return null;
    const requiredSet = new Set(required as string[]);
    for (const [key, value] of Object.entries(properties)) {
      const compiled = compileNode(value, joinPath(path, key), ignored);
      if (compiled === null) return null;
      shape[key] = requiredSet.has(key) ? compiled : compiled.optional();
    }
    // `required` 里点名了但 `properties` 里没有的键：JSON Schema 里它可以是任意值（只要出现）
    // ⇒ 记成 unknown 必填，别当「编不出来」
    for (const key of requiredSet) {
      if (!(key in shape)) shape[key] = z.unknown();
    }
    // `additionalProperties` 的三态：`false` 拒多余字段（严格对象）、给了子 schema 就逐格校验、
    // 其余（`true` / 缺席）按 zod 默认（多余的键剥掉，不判失败）——与 JSON Schema 的默认放行等价
    if (record.additionalProperties === false) {
      base = z.object(shape).strict();
    } else if (record.additionalProperties !== undefined && record.additionalProperties !== true) {
      const extra = compileNode(record.additionalProperties, joinPath(path, '*'), ignored);
      if (extra === null) return null;
      base = z.object(shape).catchall(extra);
    } else {
      base = z.object(shape);
    }
  } else {
    const type = record.type;
    const names = typeof type === 'string' ? [type] : Array.isArray(type) ? type : type === undefined ? [] : null;
    if (names === null || names.some((name) => typeof name !== 'string')) return null;
    if (names.length === 0) return z.unknown();
    const variants = names.map((name) => primitiveFor(name as string));
    if (variants.some((variant) => variant === null)) return null;
    base = variants.length === 1 ? (variants[0] as z.ZodTypeAny) : z.union(variants as [z.ZodTypeAny, z.ZodTypeAny]);
  }

  return base;
}

/** 基本类型名 → zod；认不得的类型名返回 null（那份 schema 我们判不了，交给退化路径） */
function primitiveFor(name: string): z.ZodTypeAny | null {
  switch (name) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'object':
      return z.object({}).passthrough();
    case 'array':
      return z.array(z.unknown());
    default:
      return null;
  }
}

/** 规范序列化（键排序）：只用于 enum 的深比较，避免两边键序不同判成不等 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = asRecord(value);
  if (record !== null) {
    const entries = Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * 编译一次（每个 run 一次即可）：schema 是常量，重复编译只是白花钱。
 * 非对象 / 结构非法 / 压缩过程抛错 ⇒ `parse-only`，把原因如实带出去。
 */
export function planStructuredOutput(outputSchema: unknown): StructuredOutputPlan {
  try {
    const ignored = new Set<string>();
    const compiled = compileNode(outputSchema, '$', ignored);
    if (compiled === null) {
      return { kind: 'parse-only', reason: '这份 JSON Schema 不在可编译的子集里（或结构非法）' };
    }
    return { kind: 'schema', schema: compiled, ignoredKeywords: [...ignored] };
  } catch (error) {
    return {
      kind: 'parse-only',
      reason: `编译 JSON Schema 时抛错：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** zod 的 issue → 可展示的问题（路径 + 中文说明）；`unrecognized_keys` 这类没有 expected 的另写 */
function describeIssue(issue: z.ZodIssue): StructuredOutputProblem {
  const path = issue.path.reduce<string>(
    (acc, key) => joinPath(acc, typeof key === 'number' ? key : String(key)),
    '$',
  );
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      // zod 这两格是**类型名字符串**（`'string'` / `'undefined'` / `'nan'` / `'array'`…），
      // 不是原始值：直接透出即可，别拿 `typeof` 再算一遍（那会把缺失读成「实际 string」）
      return { path, message: `期望 ${issue.expected}，实际 ${issue.received}` };
    case z.ZodIssueCode.unrecognized_keys:
      return { path, message: `不允许多余字段：${issue.keys.join('、')}` };
    case z.ZodIssueCode.invalid_enum_value:
      return { path, message: `期望取值为 ${issue.options.map((one) => JSON.stringify(one)).join(' / ')}` };
    default:
      return { path, message: issue.message };
  }
}

/**
 * 按计划判一段答复：剥围栏 → `JSON.parse` → zod 校验。
 * 三条边界：
 *   · 空串按「没有答复」处理（与 `finalText === null` 是两件事，那一格由调用方判）；
 *   · 解析不出 JSON 时 `problems` 只有一条，路径写 `$`（问题在整段文本，不在某个字段）；
 *   · 结果**永不抛**。
 */
export function inspectStructuredOutput(plan: StructuredOutputPlan, text: string): StructuredOutputInspection {
  const degraded = plan.kind === 'parse-only';
  const stripped = stripCodeFence(text);
  if (stripped === '') {
    return { ok: false, problems: [{ path: '$', message: '答复是空的' }], degraded };
  }
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch (error) {
    return {
      ok: false,
      problems: [
        { path: '$', message: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` },
      ],
      degraded,
    };
  }
  if (degraded) return { ok: true, value, degraded: true };
  const parsed = plan.schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data, degraded: false };
  return { ok: false, problems: parsed.error.issues.map(describeIssue), degraded: false };
}

/** 截断并留下明确标记：要能区分「模型只说了这么多」与「我们截了」 */
export function truncateForRepair(text: string, max = REPAIR_RAW_KEEP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（原文共 ${text.length} 字符，此处截断）`;
}

/** schema 原文的展示形态：缩进两格，交给模型与日志看 */
export function renderSchema(schema: unknown): string {
  try {
    return JSON.stringify(schema, null, 2) ?? String(schema);
  } catch {
    return String(schema);
  }
}

/**
 * 收窄成「可以交给厂商的 JSON Schema 对象」：非对象（数组 / 字符串 / null / 数字）返回 `null`。
 *
 * 为什么要有这一格：`AgentRunInput.outputSchema` 是 `unknown`（调用方给什么都有可能），
 * 而有原生通道的两家要把它塞进厂商选项的 `Record<string, unknown>` 里——不在这里收窄，
 * 一个 `"{}"` 字符串或 `[]` 就会被当成合法 schema 透下去，症状是厂商侧报一句离真因很远的错。
 * 返回 `null` 时调用方**什么都不传**（并按无原生通道处置：仍有填充层与骨架的修正轮兜着）。
 */
export function asSchemaObject(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  return record === null ? null : record;
}

/**
 * 首轮就要交代的约束：**没有原生 schema 通道的家**把这一段追加在调用方提示词之后
 * （有原生通道的家不需要它——厂商自己会传达）。措辞刻意保持中性：本包不知道调用方在做什么。
 */
export function buildStructuredOutputInstruction(outputSchema: unknown): string {
  return [
    '',
    '## 输出约束',
    '本次答复**必须**是一个 JSON 对象，且符合下面这份 JSON Schema：',
    '```json',
    renderSchema(outputSchema),
    '```',
    '只输出这个 JSON 对象本身：不要解释、不要道歉、不要 markdown 代码围栏、不要输出 JSON 以外的任何文字。',
  ].join('\n');
}

/**
 * 修正轮的追问文本（四段）：点名问题 → 给出 schema → 附上它自己的原文 → 硬要求。
 * 「不要重新读取工作区、不要重新执行任务」是**这一层的核心承诺**：修正只修形状，
 * 不重跑任务、不重评——模型手里已经有全部上下文，回头再干一遍活既慢又会改掉结论。
 */
export function buildStructuredOutputFeedback(input: {
  outputSchema: unknown;
  raw: string;
  problems: readonly StructuredOutputProblem[];
}): string {
  const problems = input.problems.length === 0
    ? ['- （未给出具体问题）']
    : input.problems.map((problem) => `- ${problem.path}：${problem.message}`);
  return [
    '你上一次的答复没有通过本次运行的 JSON Schema 校验，**不能**作为结果使用。',
    '',
    '具体问题：',
    ...problems,
    '',
    '本次要求的 JSON Schema：',
    '```json',
    renderSchema(input.outputSchema),
    '```',
    '',
    '你上一次的答复是（可能被截断）：',
    '```',
    truncateForRepair(input.raw),
    '```',
    '',
    '请给出**修正后**的答复。硬性要求：',
    '1. 只输出一个 JSON 对象：不要解释、不要道歉、不要 markdown 代码围栏、不要输出 JSON 以外的任何文字；',
    '2. **不要重新读取工作区、不要重新执行任务、不要改变你已经得出的判定**，只按上面的问题修正形状；',
    '3. 其余内容照抄你上一次的答复：不要丢字段、不要改字段名、不要多造字段。',
  ].join('\n');
}
