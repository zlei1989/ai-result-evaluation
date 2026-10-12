// @vitest-environment node
/**
 * 结构化输出判据：编译（可移植子集 / fail-open / 退化）、检查（围栏、路径、多余字段）、两段提示词原料。
 * 每条判据都要见过失败——尤其是「不认识的 keyword 不许把人判红」这条 fail-open。
 */
import { describe, expect, it } from 'vitest';
import {
  buildStructuredOutputFeedback,
  buildStructuredOutputInstruction,
  inspectStructuredOutput,
  planStructuredOutput,
  truncateForRepair,
} from './structured-output';

/** 中性夹具：形状照抄本仓真实 schema 的层级（对象 → 数组 → 对象 + 三个必填），但不含任何业务词 */
const FIXTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'verdict'],
  properties: {
    items: {
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
};

const plan = planStructuredOutput(FIXTURE_SCHEMA);

describe('planStructuredOutput', () => {
  it('可移植子集编译成 schema 计划（本仓两份 schema 的形状都能编译）', () => {
    expect(plan.kind).toBe('schema');
  });

  it('认不得的 keyword 不生成约束、只记名字（fail-open：绝不因为不认识而判红）', () => {
    const planned = planStructuredOutput({
      type: 'object',
      properties: { name: { type: 'string', pattern: '^a' } },
      oneOf: [{ type: 'string' }],
    });
    expect(planned.kind).toBe('schema');
    if (planned.kind !== 'schema') return;
    expect(planned.ignoredKeywords).toEqual(['$.oneOf', '$.name.pattern']);
    // 认不得的约束不生效：`pattern` 被忽略 ⇒ 任意字符串都过
    expect(inspectStructuredOutput(planned, '{"name":"zzz"}').ok).toBe(true);
  });

  it('整份编不出来就退化成只判可解析（非对象 / 认不得的类型名 / items 是数组）', () => {
    for (const schema of [null, 'object', 42, { type: 'quaternion' }, { type: 'array', items: [{}] }]) {
      const degraded = planStructuredOutput(schema);
      expect(degraded.kind, `schema=${JSON.stringify(schema)}`).toBe('parse-only');
    }
  });

  it('退化计划仍然放行合法 JSON，并把 degraded 如实带出去', () => {
    const degraded = planStructuredOutput({ type: 'quaternion' });
    const inspected = inspectStructuredOutput(degraded, '{"whatever":1}');
    expect(inspected).toEqual({ ok: true, value: { whatever: 1 }, degraded: true });
  });

  it('布尔 schema 按 JSON Schema 语义处置（true = 无约束、false = 恒不合格）', () => {
    expect(inspectStructuredOutput(planStructuredOutput(true), '"任意值"').ok).toBe(true);
    expect(inspectStructuredOutput(planStructuredOutput(false), '{}').ok).toBe(false);
  });

  it('type 数组与 integer / enum 都按子集落实', () => {
    const nullable = planStructuredOutput({ type: ['string', 'null'] });
    expect(inspectStructuredOutput(nullable, '"x"').ok).toBe(true);
    expect(inspectStructuredOutput(nullable, 'null').ok).toBe(true);
    expect(inspectStructuredOutput(nullable, '3').ok).toBe(false);

    const counted = planStructuredOutput({ type: 'integer' });
    expect(inspectStructuredOutput(counted, '3').ok).toBe(true);
    expect(inspectStructuredOutput(counted, '3.5').ok).toBe(false);

    const picked = planStructuredOutput({ enum: ['a', { b: 1 }] });
    expect(inspectStructuredOutput(picked, '{"b":1}').ok).toBe(true);
    expect(inspectStructuredOutput(picked, '"c"').ok).toBe(false);
  });
});

describe('inspectStructuredOutput', () => {
  const okText = '{"items":[{"id":"a","achieved":true,"reason":"done"}],"verdict":"fine"}';

  it('合格：直接给解析后的值，不成问题清单', () => {
    expect(inspectStructuredOutput(plan, okText)).toEqual({
      ok: true,
      value: { items: [{ id: 'a', achieved: true, reason: 'done' }], verdict: 'fine' },
      degraded: false,
    });
  });

  it('只剥「整段以 ``` 开头」的围栏；中间夹散文故意不救', () => {
    expect(inspectStructuredOutput(plan, `\`\`\`json\n${okText}\n\`\`\``).ok).toBe(true);
    const withProse = inspectStructuredOutput(plan, `结果如下：\n${okText}`);
    expect(withProse.ok).toBe(false);
    if (withProse.ok) return;
    expect(withProse.problems[0]?.message).toContain('不是合法 JSON');
  });

  it('问题清单带点号路径与中文说明（缺必填 / 类型不符 / 多余字段）', () => {
    const inspected = inspectStructuredOutput(
      plan,
      '{"items":[{"id":"a","achieved":"true","reason":"done","extra":1}]}',
    );
    expect(inspected.ok).toBe(false);
    if (inspected.ok) return;
    const byPath = new Map(inspected.problems.map((problem) => [problem.path, problem.message]));
    expect(byPath.get('$.items[0].achieved')).toBe('期望 boolean，实际 string');
    expect(byPath.get('$.items[0]')).toContain('不允许多余字段');
    expect(byPath.get('$.verdict')).toBe('期望 string，实际 undefined');
    expect(inspected.degraded).toBe(false);
  });

  it('空答复与非法 JSON 各给一条问题，路径都是根', () => {
    const empty = inspectStructuredOutput(plan, '   ');
    const broken = inspectStructuredOutput(plan, '{"items":');
    for (const inspected of [empty, broken]) {
      expect(inspected.ok).toBe(false);
      if (inspected.ok) continue;
      expect(inspected.problems).toHaveLength(1);
      expect(inspected.problems[0]?.path).toBe('$');
    }
  });

  it('永不抛：schema 里塞了会抛的 getter 也只退化成「只判可解析」', () => {
    const hostile = {
      type: 'object',
      get properties(): never {
        throw new Error('boom');
      },
    };
    const degraded = planStructuredOutput(hostile);
    expect(degraded.kind).toBe('parse-only');
    expect(inspectStructuredOutput(degraded, '{}').ok).toBe(true);
  });
});

describe('提示词原料', () => {
  it('首轮约束：带上 schema 原文与「只输出 JSON」的硬要求', () => {
    const text = buildStructuredOutputInstruction(FIXTURE_SCHEMA);
    expect(text).toContain('## 输出约束');
    expect(text).toContain('"additionalProperties": false');
    expect(text).toContain('不要 markdown 代码围栏');
  });

  it('修正轮：问题清单 + schema + 它自己的原文 + 不许重跑任务', () => {
    const text = buildStructuredOutputFeedback({
      outputSchema: FIXTURE_SCHEMA,
      raw: '{"items":[]}',
      problems: [{ path: 'verdict', message: '期望 string，实际 undefined' }],
    });
    expect(text).toContain('- verdict：期望 string，实际 undefined');
    expect(text).toContain('"required"');
    expect(text).toContain('{"items":[]}');
    expect(text).toContain('不要重新读取工作区、不要重新执行任务');
  });

  it('原文超限时截断并标注（能分清「模型只说了这么多」与「我们截了」）', () => {
    const long = 'x'.repeat(50);
    const cut = truncateForRepair(long, 10);
    expect(cut.startsWith('x'.repeat(10))).toBe(true);
    expect(cut).toContain('原文共 50 字符，此处截断');
    expect(truncateForRepair(long, 50)).toBe(long);
  });
});
