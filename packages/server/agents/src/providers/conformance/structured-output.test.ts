// @vitest-environment node
/**
 * 结构化输出判据的自测：**每条判据都要见过失败**。
 *
 * 正例覆盖两条通路（厂商结构化产出 / 文本里提取的 JSON）——两条都必须能过，否则
 * 「不支持结构化的那一家永远评不了分」这条风险没有判据。
 */
import { describe, expect, it } from 'vitest';
import { checkStructuredOutput, type StructuredOutputProbe } from './structured-output';

function probe(overrides: Partial<StructuredOutputProbe> = {}): StructuredOutputProbe {
  return {
    structuredOutput: true,
    hasOutputSchema: true,
    finalText: '{"judgments":[{"id":"a","achieved":true}],"verdict":"还行"}',
    expected: { judgments: [{ id: 'a', achieved: true }], verdict: '还行' },
    ...overrides,
  };
}

describe('结构化输出判据：正例', () => {
  it('结构化通路：schema 带上了、产出可解析且与期望相符', () => {
    expect(() => checkStructuredOutput(probe())).not.toThrow();
  });

  it('降级通路：该家声明不支持结构化（没有 schema），但文本里吐出了可解析 JSON ⇒ 同样过', () => {
    expect(() =>
      checkStructuredOutput(probe({ structuredOutput: false, hasOutputSchema: false, expected: undefined })),
    ).not.toThrow();
  });

  it('键序不同不算不符（比对前做了规范化）', () => {
    expect(() =>
      checkStructuredOutput(probe({ finalText: '{"verdict":"还行","judgments":[{"achieved":true,"id":"a"}]}' })),
    ).not.toThrow();
  });

  it('失败场景带归因 ⇒ 过（不要求有产出）', () => {
    expect(() =>
      checkStructuredOutput(probe({ failed: true, failureReason: 'JUDGE_PARSE_FAILED：模型未按 schema 作答', finalText: null })),
    ).not.toThrow();
  });
});

describe('结构化输出判据：每条都能拦（反例）', () => {
  it('声明能用结构化却没把 schema 发给厂商 ⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ hasOutputSchema: false }))).toThrow(/没有把 schema 发给厂商/);
  });

  it('最终答复是空串（把「没采到」伪装成答复）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: '' }))).toThrow(/空串/);
  });

  it('非失败场景却没有最终答复 ⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: null }))).toThrow(/没有最终答复/);
  });

  it('产出不是可解析 JSON（既没结构化又没吐 JSON）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: '我觉得还行' }))).toThrow(/不是可解析的 JSON/);
  });

  it('产出可解析但与期望不符（拼接/改写过的文本）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: '{"verdict":"不行","judgments":[]}' }))).toThrow(
      /结构化产出与期望不符/,
    );
  });

  it('以解析失败收场却没有任何归因（静默空评分）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ failed: true, failureReason: '   ', finalText: null }))).toThrow(/失败必须可见/);
  });

  it('失败场景但 finalText 是空串（用空串冒充「失败无产出」）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ failed: true, failureReason: 'X', finalText: '' }))).toThrow(/空串/);
  });
});
