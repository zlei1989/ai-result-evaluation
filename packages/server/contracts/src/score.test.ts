// @vitest-environment node
/**
 * 评分结果契约：逐项判定、满分快照，以及**两份契约投影的同形守卫**。
 *
 * 本文件最重要的一组断言是「schema 与契约文本同形」：`JUDGE_OUTPUT_CONTRACT` 是模型真正读到的
 * 那份提示词，`JUDGE_OUTPUT_JSON_SCHEMA` 是我们真正传给 CLI 的那份约束——它们是同一条契约的两个
 * 投影，任一侧多一个或少一个字段，模型看到的形状与解析器认的形状就会分叉。
 * 手抄一份字段名只能证明「我抄的与 schema 一致」，证明不了**契约文本**与 schema 一致，
 * 所以这里直接从文本里正则抽字段名。
 */
import { describe, expect, it } from 'vitest';
import {
  JUDGE_OUTPUT_CONTRACT,
  JUDGE_OUTPUT_JSON_SCHEMA,
  RubricJudgmentSchema,
  ScoreResultSchema,
} from './score';

const judgments = [
  { id: 'A1', achieved: true, reason: '字段进了契约' },
  { id: '#2', achieved: false, reason: '没补 Javadoc' },
];

/** 一份合格的评分结果（多处用例共用，避免各写一份形状） */
function goodScore(): Record<string, unknown> {
  return {
    judgments,
    totalScore: 18,
    maxScore: 22,
    verdict: '大体完成',
    raw: '{"judgments":[]}',
    judgeProviderId: 'p-1',
    judgeModelId: 'deepseek-chat',
    judgedAt: '2026-09-29T10:30:00.000Z',
  };
}

describe('RubricJudgmentSchema', () => {
  it('接受 id / achieved / reason，且 achieved 必须是布尔', () => {
    expect(RubricJudgmentSchema.safeParse({ id: 'A1', achieved: true, reason: '好' }).success).toBe(true);
    expect(RubricJudgmentSchema.safeParse({ id: 'A1', achieved: 'true', reason: '好' }).success).toBe(false);
    expect(RubricJudgmentSchema.safeParse({ id: '', achieved: true, reason: '好' }).success).toBe(false);
  });
});

describe('ScoreResultSchema', () => {
  it('接受完整结果；totalScore 可以为 0 且**可以大于 100**（300 分的表）', () => {
    expect(ScoreResultSchema.safeParse(goodScore()).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), totalScore: 0 }).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), totalScore: 300, maxScore: 300 }).success).toBe(true);
  });

  it('maxScore 必须存在且为正（空表的分数不该存在：满分 0 意味着无从判定）', () => {
    const { maxScore: _drop, ...withoutMax } = goodScore();
    expect(ScoreResultSchema.safeParse(withoutMax).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), maxScore: 0 }).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), maxScore: -1 }).success).toBe(false);
  });

  it('raw 必须保留（排障用：判断是提示词问题还是模型问题）', () => {
    expect(ScoreResultSchema.safeParse({ ...goodScore(), raw: undefined }).success).toBe(false);
  });

  it('judgeAgentKind 缺省为 null、structuredOutput 缺省为 false（老记录读盘要能过）', () => {
    const parsed = ScoreResultSchema.safeParse(goodScore());
    if (!parsed.success) throw new Error(`合格结果必须解析成功：${parsed.error.message}`);
    expect(parsed.data.judgeAgentKind).toBeNull();
    expect(parsed.data.structuredOutput).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), judgeAgentKind: 'dsh' }).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), judgeAgentKind: 'gemini' }).success).toBe(false);
  });

  it('judgeEffort 缺省为 null（磁盘上已有的评分记录要能读回）', () => {
    // 老快照的形状：那一份 score 里**没有** judgeEffort（也没有 judgeAgentKind / structuredOutput）
    const legacy = {
      judgments: [{ id: 'A1', achieved: true, reason: '有' }],
      totalScore: 18,
      maxScore: 32,
      verdict: '还行',
      raw: '{}',
      judgeProviderId: 'p1',
      judgeModelId: 'deepseek-chat',
      judgedAt: '2026-10-07T00:00:00.000Z',
    };
    const parsed = ScoreResultSchema.parse(legacy);
    expect(parsed.judgeEffort).toBeNull();
    // `null` 只表达「未指定」，不是「关闭」：关闭档记的是上游词汇原样（off），两者必须可分，
    // 否则「跨轮次可比」这件事（不同强度打的分数在数据上区分得开）就没了
    expect(ScoreResultSchema.parse({ ...legacy, judgeEffort: 'off' }).judgeEffort).toBe('off');
  });

  /**
   * 评分**自己**的用量与耗时（2026-10-08 加）：界面顶部那一段说的是「这一分是谁花的、花了多少」，
   * 于是这两格必须与 `judgeAgentKind` / `judgeModelId` 同源（都在 `score` 上），
   * 而不是拿候选行的 `tokens` / `durationMs` 顶上——那是**执行**那一份，两者差了整整一个阶段。
   *
   * `.default(null)` 同 `judgeAgentKind`：磁盘上已有的评分记录里没有这两格，必填会让
   * `listRuns()` 静默跳过那一轮（老记录的分数还在，却整轮从列表里消失）。
   */
  it('judgeTokens / judgeDurationMs 缺省为 null，真实取值原样读回（老记录要能读盘）', () => {
    const legacy = ScoreResultSchema.parse(goodScore());
    expect(legacy.judgeTokens).toBeNull();
    expect(legacy.judgeDurationMs).toBeNull();

    const scored = ScoreResultSchema.parse({
      ...goodScore(),
      judgeTokens: { input: 24_968, cached: 2_283_520, output: 67_101 },
      judgeDurationMs: 29_000,
    });
    expect(scored.judgeTokens).toEqual({ input: 24_968, cached: 2_283_520, output: 67_101 });
    expect(scored.judgeDurationMs).toBe(29_000);

    // 真实的 0 是**读数**（这一家一个 token 都没花 / 掐表不到 1 秒），与「没采到」相反，
    // 不许被真值判断兜成 null
    expect(ScoreResultSchema.parse({ ...goodScore(), judgeDurationMs: 0 }).judgeDurationMs).toBe(0);

    // 三元组缺一格非法：与 `EvalRow.tokens` 同一个形状口径（半份用量比没有用量更难解释）
    expect(ScoreResultSchema.safeParse({ ...goodScore(), judgeTokens: { input: 1, cached: 2 } }).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...goodScore(), judgeTokens: { input: '1', cached: 2, output: 3 } }).success).toBe(false);
  });
});

describe('JUDGE_OUTPUT_CONTRACT（新文本）', () => {
  it('含解析器读的每个字段名，且明确要求「不要输出 JSON 以外的任何文字」', () => {
    for (const field of ['judgments', 'id', 'achieved', 'reason', 'verdict']) {
      expect(JUDGE_OUTPUT_CONTRACT).toContain(field);
    }
    expect(JUDGE_OUTPUT_CONTRACT).toContain('不要输出');
  });

  it('明确要求「每一项都必须恰好给出一条判定」与「不要给总分」', () => {
    // 断言到**整句条款**：裸的 `不要` 会被第 1 条「不要输出 JSON 以外的任何文字」满足，
    // 于是「必须给总分」这种反向文本照样能过——那这条守卫就白写了
    expect(JUDGE_OUTPUT_CONTRACT).toContain('都必须恰好给出一条判定');
    expect(JUDGE_OUTPUT_CONTRACT).toContain('你的回复里**不要**给总分');
  });
});

describe('JUDGE_OUTPUT_JSON_SCHEMA：结构化输出的单一真源', () => {
  const schema = JUDGE_OUTPUT_JSON_SCHEMA;

  it('顶层 required 与 properties 同集合，且不允许多余字段', () => {
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it('judgments 项的形状：id / achieved / reason 三个必填，achieved 是布尔', () => {
    const item = schema.properties.judgments.items;
    expect([...item.required].sort()).toEqual(['achieved', 'id', 'reason']);
    expect(item.properties.achieved.type).toBe('boolean');
    expect(item.additionalProperties).toBe(false);
  });

  /**
   * 守卫：`judgments` **不许**出现 minItems / maxItems。
   * 项数由每个用例的评分表决定，而 schema 是编译期字面量——写死任何一个数字都是错的
   * （旧体系能写 `minItems: DIMENSION_COUNT` 是因为 5 维是常量）。
   * 缺了这条，后人会「顺手补回来」，而补回来的那一刻 schema 就开始拒绝合法的表。
   */
  it('judgments 没有 minItems / maxItems（项数由每张评分表决定）', () => {
    expect(Object.keys(schema.properties.judgments)).not.toContain('minItems');
    expect(Object.keys(schema.properties.judgments)).not.toContain('maxItems');
  });

  it('顶层被冻结（共享全局值：谁都不能在运行期往上加一格或改一格）', () => {
    expect(Object.isFrozen(JUDGE_OUTPUT_JSON_SCHEMA)).toBe(true);
  });

  /**
   * 同形守卫（本文件最重要的一条）：schema 的字段名与契约文本里列的完全一致，多一个少一个都红。
   * 正则命中的是契约里那段 JSON 骨架的键名（去掉重复后是 judgments / id / achieved / reason / verdict）。
   */
  it('字段名与 JUDGE_OUTPUT_CONTRACT 文本里列的完全一致（多一个少一个都红）', () => {
    const names = new Set([...JUDGE_OUTPUT_CONTRACT.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]));
    const schemaNames = new Set([
      ...Object.keys(schema.properties),
      ...Object.keys(schema.properties.judgments.items.properties),
    ]);
    const missingInContract = [...schemaNames].filter((name) => !names.has(name));
    const extraInContract = [...names].filter((name) => name !== undefined && !schemaNames.has(name));
    expect(missingInContract).toEqual([]);
    expect(extraInContract).toEqual([]);
    // 钉住抽取本身没抽空（两侧都空集也会「相等」，那是假绿）
    expect(names.size).toBeGreaterThanOrEqual(schemaNames.size);
  });

  it('两份投影里都不出现 totalScore（模型不给总分，这是本次重构的核心口径之一）', () => {
    expect(JUDGE_OUTPUT_CONTRACT).not.toContain('totalScore');
    expect(Object.keys(schema.properties)).not.toContain('totalScore');
  });
});

/* ===================================================================================================
 * 值域守卫（Task 1 延后项，2026-09-29 Task 3 补回）
 *
 * 上面那组同形守卫只比字段**名**：`type` 写错（`achieved: { type: 'string' }`）、`required` 少一项、
 * `additionalProperties` 忘了关——这些**值域与必需性**的漂移一条都拦不住，而它们的后果与字段名写错
 * 一模一样：模型按 schema 回的与解析器认的分叉。
 * 为什么最小校验器够用：本仓的 schema 是**编译期字面量**、只用到五个关键字（见 `SUPPORTED_KEYWORDS`），
 * 引一个 JSON Schema 库反而是引入一份比被测对象复杂得多的依赖。
 * =================================================================================================== */

/** 本仓 schema 的静态形状：校验器只按关键字读它，不关心它是不是冻结的 */
type JsonSchemaNode = { readonly [keyword: string]: unknown };

/** 只实现本仓 schema 真正用到的关键字；**多一个都不认识**（不认识就抛，见校验器第一段） */
const SUPPORTED_KEYWORDS = new Set(['type', 'required', 'properties', 'additionalProperties', 'items']);

/** 报错里显示一个值：字符串带引号（否则「空串」与「没这一格」在消息里长得一样） */
function shown(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(JSON.stringify(value));
}

/**
 * 最小 JSON Schema 校验器（**仅测试用**）：值不合 schema 就抛中文原因。
 * 遇未实现的关键字**必须抛**：静默放过会让整组值域守卫变成「看起来在守、其实什么都没守」——
 * 那正是补回这组用例要消灭的东西。
 */
function validateJsonSchema(value: unknown, schema: JsonSchemaNode, path = '$'): void {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `${path} 用了最小校验器不认识的关键字「${keyword}」：请实现它，或把它从 schema 里删掉——静默放过等于这条守卫不存在`,
      );
    }
  }
  const type = schema.type;
  if (type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} 应为 string，实际是 ${shown(value)}`);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${path} 应为 boolean，实际是 ${shown(value)}`);
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} 应为 array，实际是 ${shown(value)}`);
    const items = schema.items;
    if (typeof items !== 'object' || items === null) throw new Error(`${path} 是 array 却没有 items：项的形状无从判定`);
    for (const [index, item] of value.entries()) validateJsonSchema(item, items as JsonSchemaNode, `${path}[${index}]`);
    return;
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${path} 应为 object，实际是 ${shown(value)}`);
    }
    const record = value as Record<string, unknown>;
    const required = schema.required;
    if (!Array.isArray(required)) throw new Error(`${path} 是 object 却没有 required 数组：必需性无从判定`);
    for (const name of required) {
      // `in` 而不是 `!== undefined`：显式写了 `undefined` 的字段在 JSON 里根本不存在，
      // 而它在内存里「有这一格」——两种形状必须同样算缺（与解析侧 JSON.parse 之后的形状一致）
      if (!(name in record)) throw new Error(`${path} 缺少必填字段「${String(name)}」`);
    }
    const properties = schema.properties;
    if (typeof properties !== 'object' || properties === null) {
      throw new Error(`${path} 是 object 却没有 properties：字段的形状无从判定`);
    }
    const props = properties as Record<string, JsonSchemaNode>;
    for (const [key, item] of Object.entries(record)) {
      const sub = props[key];
      if (sub !== undefined) {
        validateJsonSchema(item, sub, `${path}.${key}`);
        continue;
      }
      if (schema.additionalProperties === false) throw new Error(`${path} 多出未声明的字段「${key}」`);
    }
    return;
  }
  throw new Error(`${path} 的 type 是「${String(type)}」：最小校验器不支持（只认 string / boolean / array / object）`);
}

describe('JUDGE_OUTPUT_JSON_SCHEMA 的值域（最小校验器）', () => {
  const schema = JUDGE_OUTPUT_JSON_SCHEMA;
  const item = schema.properties.judgments.items;

  it('根是 object、judgments 是 array、项里 id / reason 是 string、achieved 是 boolean', () => {
    expect(schema.type).toBe('object');
    expect(schema.properties.judgments.type).toBe('array');
    expect(item.type).toBe('object');
    expect(item.properties.id.type).toBe('string');
    expect(item.properties.reason.type).toBe('string');
    // achieved 的**严档**：请求侧把字符串挡在门外，解析侧才做宽容读（见 score.ts 口径 4）
    expect(item.properties.achieved.type).toBe('boolean');
  });

  it('一份合格的返回能过这个校验器（此前没有任何一条断言「合格样例能过」）', () => {
    const valid = { judgments, verdict: '大体完成' };
    expect(() => validateJsonSchema(valid, schema)).not.toThrow();
    // 空 judgments 也合法：项数由每张评分表决定，schema 表达不了（口径 3）
    expect(() => validateJsonSchema({ judgments: [], verdict: '还没评' }, schema)).not.toThrow();
  });

  /**
   * 「校验器本身能被证伪」——缺了这条，上面那条「合格样例能过」在一个**什么都不检查**的空壳
   * 校验器上照样绿（与 `expect(names.size).toBeGreaterThanOrEqual(...)` 是同一类自证）。
   */
  it('校验器本身能被证伪：类型错 / 缺必填 / 多字段 / 未实现的关键字，四种都要抛', () => {
    expect(() => validateJsonSchema({ judgments: [{ id: 'A1', achieved: 'true', reason: '好' }], verdict: 'v' }, schema)).toThrow(
      /achieved/,
    );
    expect(() => validateJsonSchema({ judgments: [{ id: 'A1', achieved: true }], verdict: 'v' }, schema)).toThrow(/reason/);
    expect(() => validateJsonSchema({ judgments: [{ id: 'A1', achieved: true, reason: '好' }] }, schema)).toThrow(/verdict/);
    expect(() =>
      validateJsonSchema({ judgments: [{ id: 'A1', achieved: true, reason: '好', score: 3 }], verdict: 'v' }, schema),
    ).toThrow(/score/);
    expect(() => validateJsonSchema({ judgments, verdict: 'v' }, { type: 'object', minLength: 1 })).toThrow(/minLength/);
  });

  /**
   * **登记一处有意的不对称**（与 `achieved` 的严档 / 宽档同一处置）：请求侧 `id` 只有 `type: 'string'`
   * （没有 `minLength`），解析侧 `RubricJudgmentSchema.id` 是 `z.string().min(1)`（空串非法）。
   *
   * 为什么两侧**不该**顺手对齐：两边拦的不是同一件事——请求侧拦的是**形状**（这一格得是字符串），
   * 解析侧拦的是**身份**（空串不是一把有效的引用键，一次判定会被记到一个不存在的项上）。
   * 给请求侧补 `minLength: 1` 只会让「引用键写空」的返回被上游直接拒掉、连它想评哪一项都看不到，
   * 而解析侧该判它非法还是得判。这条差异写在这里，是为了让后人「顺手对齐」掉某一侧时先红一次。
   */
  it('登记的不对称：请求侧 id 只约束类型（无 minLength），解析侧 min(1) 拒绝空串', () => {
    expect(item.properties.id).not.toHaveProperty('minLength');
    expect(() => validateJsonSchema({ judgments: [{ id: '', achieved: true, reason: '好' }], verdict: 'v' }, schema)).not.toThrow();
    expect(RubricJudgmentSchema.safeParse({ id: '', achieved: true, reason: '好' }).success).toBe(false);
  });
});
