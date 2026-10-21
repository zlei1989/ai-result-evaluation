// @vitest-environment node
/**
 * **预检与厂商判据的差分对拍**：`preflightStructuredOutput` 的结论 vs 厂商真正的裁定。
 *
 * 为什么必须对拍：适配器的预检是**另一份实现**（它自己重写了厂商那套规则），两份实现只要有一处
 * 差集不一致，就会出现两种静默失败：
 *   · **假放行**（预检说能过、厂商拒）⇒ 采纳 `strict: 'require'`，而厂商在建请求那一刻抛：
 *     **零出站请求** + `stopReason: 'error'`，`prompt()` 还不 reject —— 界面上是「这个候选莫名其妙失败了」；
 *   · **假降级**（预检说不能过、厂商其实放行）⇒ 白白丢掉原生通道（`applied.structuredOutput` 恒 `false`），
 *     而没有任何报错。
 *
 * 真值取**厂商自己的裁定函数**（`@earendil-works/pi-ai` 的 `resolveJsonSchemaStrictSampling`
 * 加两条 wire 各自的 `isUnsupportedKeyword` 谓词），不是我们重写一遍规则——两边同一个来源的判据
 * 一起改会一起变，那种守卫是空转的。
 *
 * 语料是**逐条构造的边界**（每条对应厂商实现里的一行判据），不是随机样本：随机样本打不到
 * `minItems: 0/1/2` 这种三态、`format` 白名单、`anyOf` 里的可空对象、非枚举自有键这些点。
 * 新增预检规则时在这里补一条：这一份对拍表就是「预检有没有跟上厂商」的判据。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveJsonSchemaStrictSampling } from '@earendil-works/pi-ai/api/constrained-sampling';
import { preflightStructuredOutput } from './structured-output';

/** 一条语料：名字 + schema + 期望（`allowed` = 厂商放行；不给就是不预设、只看两侧是否一致） */
interface Case {
  name: string;
  schema: Record<string, unknown>;
  note: string;
}

const objectRoot = (properties: Record<string, unknown>, required?: string[]): Record<string, unknown> => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required === undefined ? {} : { required }),
});

/** 逐条打在厂商实现里的一行判据上 */
const CASES: Case[] = [
  { name: 'plain-string', schema: objectRoot({ a: { type: 'string' } }), note: '最简：应放行' },
  { name: 'nullable-union-type', schema: objectRoot({ a: { type: ['string', 'null'] } }), note: '可空标量：两边都放行' },
  { name: 'optional-scalar', schema: objectRoot({ a: { type: 'string' } }, []), note: '非必填标量：厂商会包 anyOf' },
  { name: 'nested-object', schema: objectRoot({ a: objectRoot({ b: { type: 'string' } }, ['b']) }, ['a']), note: '嵌套对象' },
  { name: 'array-of-string', schema: objectRoot({ a: { type: 'array', items: { type: 'string' } } }, ['a']), note: '数组' },
  { name: 'minItems-0', schema: objectRoot({ a: { type: 'array', items: { type: 'string' }, minItems: 0 } }, ['a']), note: 'anthropic 放行 0' },
  { name: 'minItems-1', schema: objectRoot({ a: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['a']), note: 'anthropic 放行 1' },
  { name: 'minItems-2', schema: objectRoot({ a: { type: 'array', items: { type: 'string' }, minItems: 2 } }, ['a']), note: 'anthropic 拒 ≥2' },
  { name: 'maxItems', schema: objectRoot({ a: { type: 'array', items: { type: 'string' }, maxItems: 2 } }, ['a']), note: 'anthropic 拒' },
  { name: 'minimum', schema: objectRoot({ a: { type: 'number', minimum: 1 } }, ['a']), note: 'anthropic 拒，openai 放行' },
  { name: 'format-email', schema: objectRoot({ a: { type: 'string', format: 'email' } }, ['a']), note: '白名单内' },
  { name: 'format-regex', schema: objectRoot({ a: { type: 'string', format: 'regex' } }, ['a']), note: '不在白名单 ⇒ anthropic 拒' },
  { name: 'format-nonstring', schema: objectRoot({ a: { type: 'string', format: 3 } }, ['a']), note: '非字符串 format ⇒ anthropic 拒' },
  { name: 'ref', schema: objectRoot({ a: { $ref: '#/$defs/x' } }, ['a']), note: '双方拒' },
  { name: 'defs', schema: { ...objectRoot({ a: { type: 'string' } }, ['a']), $defs: { x: { type: 'string' } } }, note: '双方拒' },
  { name: 'oneOf', schema: objectRoot({ a: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, ['a']), note: '双方拒' },
  { name: 'anyOf-nullable-scalar', schema: objectRoot({ a: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, ['a']), note: '手写可空标量：双方放行' },
  { name: 'anyOf-object', schema: objectRoot({ a: { anyOf: [{ type: 'object', additionalProperties: false, properties: {} }, { type: 'null' }] } }, ['a']), note: '对象进 union ⇒ 双方拒' },
  { name: 'anyOf-empty', schema: objectRoot({ a: { anyOf: [] } }, ['a']), note: '空 anyOf ⇒ 双方拒' },
  { name: 'items-tuple', schema: objectRoot({ a: { type: 'array', items: [{ type: 'string' }] } }, ['a']), note: 'tuple ⇒ 双方拒' },
  { name: 'additionalProperties-true', schema: { type: 'object', additionalProperties: true, properties: { a: { type: 'string' } }, required: ['a'] }, note: '双方拒' },
  { name: 'additionalProperties-schema', schema: { type: 'object', additionalProperties: { type: 'string' }, properties: { a: { type: 'string' } }, required: ['a'] }, note: '双方拒' },
  { name: 'additionalProperties-omitted', schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, note: '缺省 ⇒ 双方放行（厂商随后强制 false）' },
  { name: 'properties-without-object-type', schema: { type: 'string', properties: { a: { type: 'string' } } }, note: 'properties 但 type 不是 object ⇒ 双方拒' },
  { name: 'required-unknown-property', schema: objectRoot({ a: { type: 'string' } }, ['a', 'b']), note: 'required 点名不存在的属性 ⇒ 双方拒' },
  {
    name: 'required-prototype-key',
    schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: ['toString'] },
    note: '原型链上的名字：厂商用自有键判据 ⇒ 双方拒（预检若用 `in` 就会假放行）',
  },
  { name: 'boolean-subschema', schema: objectRoot({ a: true }, ['a']), note: '布尔子 schema ⇒ 双方拒' },
  { name: 'root-not-object', schema: { type: 'string' }, note: '根不是 object ⇒ 双方拒' },
  { name: 'not', schema: objectRoot({ a: { not: { type: 'string' } } }, ['a']), note: '`not` 在双方的禁用表里' },
  { name: 'if-then', schema: objectRoot({ a: { if: { type: 'string' }, then: { type: 'string' } } }, ['a']), note: '`if` / `then` 同族' },
  { name: 'maxProperties', schema: { ...objectRoot({ a: { type: 'string' } }, ['a']), maxProperties: 2 }, note: 'anthropic 拒' },
  { name: 'minProperties', schema: { ...objectRoot({ a: { type: 'string' } }, ['a']), minProperties: 1 }, note: 'anthropic 拒' },
  { name: 'properties-shape', schema: { type: 'object', additionalProperties: false, properties: 'not-an-object' }, note: '`properties` 不是对象 ⇒ 双方拒' },
  { name: 'required-shape', schema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } }, required: 'a' }, note: '`required` 不是数组 ⇒ 双方拒' },
  { name: 'empty-properties', schema: objectRoot({}), note: '空 properties' },
];

/** anthropic 那条 wire 的谓词（逐字来自 `anthropic-messages.js` 的 `isAnthropicStrictUnsupportedKeyword`） */
const ANTHROPIC_UNSUPPORTED = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'maxItems', 'uniqueItems', 'minContains', 'maxContains', 'minProperties', 'maxProperties',
]);
const ANTHROPIC_FORMATS = new Set([
  'date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid',
]);
const anthropicPredicate = (key: string, value: unknown): boolean => {
  if (ANTHROPIC_UNSUPPORTED.has(key)) return true;
  if (key === 'minItems') return value !== 0 && value !== 1;
  if (key === 'format') return typeof value !== 'string' || !ANTHROPIC_FORMATS.has(value);
  return false;
};

/**
 * 厂商的裁定：`resolveJsonSchemaStrictSampling(tool, supportsStrict, isUnsupportedKeyword)`。
 * 返回 `true` = 真的拿到了 strict（会带 `strict: true` 出站）；`undefined` = 回落成非 strict 声明。
 */
function vendorVerdict(schema: Record<string, unknown>, protocolType: 'openai' | 'anthropic'): 'strict' | 'fallback' | 'throws' {
  /**
   * 工具必须带 `constrainedSampling`：厂商这一步读的就是它（没有它一律 `undefined`）。
   * `strict: 'require'` 是**适配器在原生档上报的那一档**——那一档拿不到 strict 时厂商**抛**
   * （这正是「零出站请求 + 43 毫秒 + stopReason: error」的来源），故把它折成第三态 `throws`。
   */
  const tool = {
    name: 'submit_result',
    description: '提交结果',
    parameters: schema,
    constrainedSampling: { type: 'json_schema', strict: 'require' },
    // 厂商的 `Tool<TSchema>` 把 `parameters` 声明成它自己的 schema 类型；这一格只走运行时判据
  } as unknown as Parameters<typeof resolveJsonSchemaStrictSampling>[0];
  try {
    const verdict = protocolType === 'anthropic'
      ? resolveJsonSchemaStrictSampling(tool, true, anthropicPredicate)
      : resolveJsonSchemaStrictSampling(tool, true);
    return verdict === true ? 'strict' : 'fallback';
  } catch {
    return 'throws';
  }
}

describe('预检差分对拍：`preflightStructuredOutput` vs 厂商裁定', () => {
  for (const protocolType of ['openai', 'anthropic'] as const) {
    it(`${protocolType} wire：${CASES.length} 条语料逐条一致`, () => {
      const candidates = CASES.map((entry) => {
        const preflight = preflightStructuredOutput(entry.schema, protocolType);
        const vendor = vendorVerdict(entry.schema, protocolType);
        return {
          name: entry.name,
          note: entry.note,
          preflight: preflight.parameters === null ? 'reject' : 'accept',
          vendor,
          reason: preflight.reason,
        };
      });
      /**
       * 不一致的两种形态各自有名字（别合成一句「不一致」）：
       *   · 预检 accept + 厂商不发 strict（`fallback` / `throws`）⇒ **假放行**；
       *   · 预检 reject + 厂商发 strict ⇒ **假降级**。
       */
      const mismatches = candidates
        .map((row) => ({
          ...row,
          kind: row.preflight === 'accept' && row.vendor !== 'strict'
            ? '假放行（预检说能过，厂商拒 ⇒ 零出站请求）'
            : row.preflight === 'reject' && row.vendor === 'strict' ? '假降级（白丢原生通道）' : null,
        }))
        .filter((row) => row.kind !== null);
      dump(`07-preflight-${protocolType}`, { candidates, mismatches });
      // 一条不一致就是一条缺陷：假放行会打出「零出站请求」的失败，假降级会静默丢掉原生通道
      expect(
        mismatches.map((row) => `${row.kind}｜${row.name}: 预检=${row.preflight} 厂商=${row.vendor}｜${row.note}`),
      ).toEqual([]);
    });
  }
});

/**
 * 读数落盘：整张对拍表（含**没命中**的那些行，便于人工复核语料覆盖）。
 * 落 `probe/dumps/v12/`（已 gitignore）——它是探针产物，不是断言的一部分。
 */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
