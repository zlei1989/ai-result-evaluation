// @vitest-environment node
/**
 * 结构化输出判据的自测：**每条判据都要见过失败**。
 *
 * 正例覆盖两条通路（厂商原生 schema 通道 / 没有原生通道、靠适配器内填充层）——两条都必须能过，
 * 否则「没有原生通道的那一家永远评不了分」这条风险没有判据；
 * 反例里第一条是这条契约的核心：**上报走了原生通道却没把 schema 发给厂商**（声明与请求不符）。
 */
import { describe, expect, it } from 'vitest';
import { checkStructuredOutput, type StructuredOutputProbe } from './structured-output';

function probe(overrides: Partial<StructuredOutputProbe> = {}): StructuredOutputProbe {
  return {
    nativeChannel: true,
    hasOutputSchema: true,
    finalText: '{"judgments":[{"id":"a","achieved":true}],"verdict":"还行"}',
    expected: { judgments: [{ id: 'a', achieved: true }], verdict: '还行' },
    ...overrides,
  };
}

describe('结构化输出判据：正例', () => {
  it('原生通道：schema 带上了、产出可解析且与期望相符', () => {
    expect(() => checkStructuredOutput(probe())).not.toThrow();
  });

  it('填充层通路：没有原生通道（也没把 schema 发给厂商），答复仍是可解析 JSON ⇒ 同样过', () => {
    expect(() =>
      checkStructuredOutput(probe({ nativeChannel: false, hasOutputSchema: false })),
    ).not.toThrow();
  });

  it('整段包在 ``` 围栏里的答复 ⇒ 过（与运行时同一份剥围栏口径）', () => {
    expect(() =>
      checkStructuredOutput(
        probe({ finalText: '```json\n{"judgments":[{"id":"a","achieved":true}],"verdict":"还行"}\n```' }),
      ),
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
  it('上报走了原生通道却没把 schema 发给厂商 ⇒ 红（声明与请求不符）', () => {
    expect(() => checkStructuredOutput(probe({ hasOutputSchema: false }))).toThrow(/没有把 schema 发给厂商/);
  });

  it('没有原生通道、答复又不可解析 ⇒ 红（「允许没有原生通道」不等于「可以不交 JSON」）', () => {
    expect(() =>
      checkStructuredOutput(probe({ nativeChannel: false, hasOutputSchema: false, finalText: '我觉得还行' })),
    ).toThrow(/不是可解析的 JSON/);
  });

  it('最终答复是空串（把「没采到」伪装成答复）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: '' }))).toThrow(/空串/);
  });

  it('非失败场景却没有最终答复 ⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: null }))).toThrow(/没有最终答复/);
  });

  it('原生通道的产出不是可解析 JSON（厂商没按 schema 交东西）⇒ 红', () => {
    expect(() => checkStructuredOutput(probe({ finalText: '我觉得还行' }))).toThrow(/不是可解析的 JSON/);
  });

  it('围栏里也不是 JSON ⇒ 红（剥围栏不是「从散文里抠 JSON」）', () => {
    expect(() => checkStructuredOutput(probe({ finalText: '```\n我觉得还行\n```' }))).toThrow(/不是可解析的 JSON/);
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
