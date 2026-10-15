// @vitest-environment node
/**
 * 探针 11：**「非对象 schema 按没给处置」这条注释与事实是否一致**——根非 object 的 schema 会怎样。
 *
 * `structured-output.ts` 的 `adoptStructuredOutput` 写着：
 *   「⛔ 非对象（数组 / 标量 / 字符串）按『没给』处置：没有可声明的工具，**也不追加提示词**」。
 * 判据取的是 `asSchemaObject(outputSchema) === null`，而那个函数只判「是不是一个对象」
 * ——**根 `type: 'array'` 的 schema 本身就是一个对象**，于是它会走「降级档」那一支。
 *
 * 两条读数各自都是可观测的（不需要模型配合）：
 *   ① 请求里那件 `submit_result` **有没有被声明出去**（工具表 + 它的非 strict 声明形态）；
 *   ② 提示词里**有没有**那段「必须是 JSON 对象」的约束；
 *   ③ 降级档 anthropic 的 `input_schema` 退化成什么（`legacyInputSchema` 只取根节点的
 *      `type/properties/required`）——它是不是与题面（数组）自相矛盾。
 *
 * 阴性对照：真对象 schema 走原生通道（`strict: true`、参数是那份 schema）——同一支探针里跑，
 * 免得「读不到工具声明」被误读成「这一格没跑起来」。
 *
 * 用法（不需要凭据）：
 *   node_modules/.bin/vitest run packages/server/agents/src/providers/pi/probe/11-nonobject-schema.test.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicText, runPiConformanceRow } from '../../../testing/pi-conformance-fixture';
import { piRequestToolDeclaration } from '../observer';
import { PI_STRUCTURED_OUTPUT_TOOL } from '../structured-output';

/** 根是数组的 schema（本仓评分 schema 是 object 根，这一档来自「调用方给了别的形状」） */
const ARRAY_ROOT_SCHEMA = { type: 'array', items: { type: 'string' } };

describe('根非 object 的 schema 落在哪一档', () => {
  /**
   * **两支的分界是「结构」而不是「根 `type` 是什么」**：这份 schema 是一个 JSON 对象
   * ⇒ 走降级档（工具照旧声明、填充层照旧追加）。真机读数里那一件出站声明的参数是
   * `{type:'object',properties:{},required:[]}`——pi 的非 strict 档只取根节点的
   * `type/properties/required`，根是数组时那一份必然退化成空对象形态。这是 schema 形态的
   * 已知代价（不是「按没给处置」），判据钉住它，免得下一个人以为这一档什么都不交付。
   */
  it('根数组 schema：降级档照旧交付工具与填充层（出站声明的形态如实钉住）', async () => {
    const run = await runPiConformanceRow({
      script: [anthropicText('我按题面回答。')],
      prompt: '请给出结论。',
      outputSchema: ARRAY_ROOT_SCHEMA,
    });
    const body = run.requests.at(-1)?.body ?? {};
    const declared = piRequestToolDeclaration(body, PI_STRUCTURED_OUTPUT_TOOL);
    /** 提示词里那段填充层约束的前缀（`buildStructuredOutputInstruction` 的第一句） */
    const hasFallbackInstruction = JSON.stringify(body).includes('本次答复**必须**是一个 JSON 对象');

    const reading = {
      requestCount: run.requests.length,
      toolDeclared: declared !== null,
      declaredStrict: declared === null ? null : (declared as unknown as Record<string, unknown>)['strict'] ?? null,
      declaredParameters: declared?.parameters ?? null,
      hasFallbackInstruction,
      applied: run.outcome.applied.structuredOutput,
      finalText: run.outcome.finalText,
    };
    dump('11-nonobject-schema', reading);

    expect(reading.toolDeclared, '这一档要有出口：模型没有工具可调才是更坏的失败').toBe(true);
    // 非 strict 档的声明里**没有** `strict` 键（`undefined` 序列化后读回来就是 `null`）
    expect(reading.declaredStrict, '根非 object 拿不到原生通道 ⇒ 只能降级').toBeNull();
    expect(hasFallbackInstruction, '填充层要带上那份原样的 schema（模型据此知道题面是数组）').toBe(true);
    // 出站声明的形态：非 strict 档只取根节点的 type/properties/required ⇒ 退化成空对象
    expect(reading.declaredParameters).toEqual({ type: 'object', properties: {}, required: [] });
    // 这一档没有厂商侧强制 ⇒ 上报恒 false（哪怕模型真调了那件工具）
    expect(reading.applied).toBe(false);
  }, 180_000);

  /**
   * **压根不是 JSON 对象**（字符串 / 数组字面量 / 标量）⇒ 两样都不交付。
   * 与上面那一档分得开：这里连「可声明的参数」都没有，`asSchemaObject` 给 `null`。
   */
  it('不是 JSON 对象（字符串 schema）⇒ 工具与填充层都不落，只剩修正轮', async () => {
    const run = await runPiConformanceRow({
      script: [anthropicText('我按题面回答。')],
      prompt: '请给出结论。',
      outputSchema: '{"type":"object"}',
    });
    const body = run.requests.at(-1)?.body ?? {};
    const reading = {
      toolDeclared: piRequestToolDeclaration(body, PI_STRUCTURED_OUTPUT_TOOL) !== null,
      hasFallbackInstruction: JSON.stringify(body).includes('本次答复**必须**是一个 JSON 对象'),
      applied: run.outcome.applied.structuredOutput,
    };
    dump('11-nonobject-schema-string', reading);
    expect(reading).toEqual({ toolDeclared: false, hasFallbackInstruction: false, applied: false });
  }, 180_000);

  it('阴性对照：真对象 schema 走原生通道（工具声明 + `strict: true` + 参数是那份 schema）', async () => {
    const objectSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['verdict'],
      properties: { verdict: { type: 'string' } },
    };
    const run = await runPiConformanceRow({
      script: [anthropicText('按 schema 交。')],
      prompt: '请给出结论。',
      outputSchema: objectSchema,
    });
    const body = run.requests.at(-1)?.body ?? {};
    const declared = piRequestToolDeclaration(body, PI_STRUCTURED_OUTPUT_TOOL);
    dump('11-nonobject-schema-control', { declared });
    expect(declared, '对象 schema 那一条没声明工具 ⇒ 这一格没跑起来').not.toBeNull();
    expect((declared as unknown as Record<string, unknown>)['strict']).toBe(true);
  }, 180_000);
});

/** 读数落盘到 `probe/dumps/v12/` */
function dump(name: string, payload: unknown): void {
  const dir = join(import.meta.dirname, '..', '..', '..', '..', 'probe', 'dumps', 'v12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
