// @vitest-environment node
/**
 * 供应商契约：协议枚举、掩码函数、入参 schema 的默认值与部分性。
 * 注意：这里最有价值的一条是「ProviderView 里绝不能出现明文 apiKey」——它是下行出口的唯一守卫。
 */
import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_LABELS,
  ProviderCreateSchema,
  ProviderModelInputSchema,
  ProviderModelSchema,
  ProviderPatchSchema,
  ProviderSchema,
  ProviderViewSchema,
  ProtocolTypeSchema,
  maskApiKey,
} from './provider';

/** 一条合法的落盘记录，作为各用例的基准 */
const provider = {
  id: 'p-1',
  name: 'DeepSeek 官方',
  protocolType: 'openai' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'sk-abcdefghijklmn',
  models: [{ id: 'deepseek-chat', source: 'fetched' as const }],
  createdAt: '2026-09-22T10:30:00.000Z',
  updatedAt: '2026-09-22T10:30:00.000Z',
};

describe('ProtocolTypeSchema', () => {
  it('只认 openai / anthropic 两种协议（F1 的唯一判据）', () => {
    expect(ProtocolTypeSchema.safeParse('openai').success).toBe(true);
    expect(ProtocolTypeSchema.safeParse('anthropic').success).toBe(true);
    expect(ProtocolTypeSchema.safeParse('gemini').success).toBe(false);
    expect(ProtocolTypeSchema.safeParse('OpenAI').success).toBe(false);
  });
});

describe('PROTOCOL_LABELS', () => {
  it('两种协议都有中文标签，且不含空文案', () => {
    expect(PROTOCOL_LABELS.openai).toBe('OpenAI 兼容');
    expect(PROTOCOL_LABELS.anthropic).toBe('Anthropic 兼容');
    for (const protocol of ProtocolTypeSchema.options) {
      expect(PROTOCOL_LABELS[protocol].length).toBeGreaterThan(0);
    }
  });
});

/**
 * 期望串的星号数按契约 §2.2「保留前 3 后 4，长度 <8 时全掩码」推导：
 * 掩码后长度恒等于原密钥长度（短密钥也不泄露长度之外的信息），故星号数 = 长度 - 7。
 * 计划文档里这几条字面量多敲/少敲了一位（如 17 位密钥写 11 颗星、'sk-abc' 写 7 颗星），
 * 且 8 位边界写成 `abc****h` 与「后 4」自相矛盾，此处以契约语义为准。
 */
describe('maskApiKey', () => {
  it('保留前 3 后 4', () => {
    expect(maskApiKey('sk-abcdefghijklmn')).toBe('sk-**********klmn');
  });

  it('长度 <8 时全掩码（前 3 后 4 会重叠，等于把密钥原样吐出来）', () => {
    expect(maskApiKey('sk-abc')).toBe('******');
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey('1234567')).toBe('*******');
  });

  it('掩码结果里绝不出现原文（8 位边界值：前 3 后 4 恰好覆盖前 7 位）', () => {
    const key = 'abcdefgh';
    const masked = maskApiKey(key);
    expect(masked).toBe('abc*efgh');
    expect(masked).not.toBe(key);
  });
});

describe('ProviderViewSchema', () => {
  it('解析后没有 apiKey 字段，只有 apiKeyMasked（下行出口的唯一守卫）', () => {
    const view = ProviderViewSchema.parse({ ...provider, apiKeyMasked: maskApiKey(provider.apiKey) });
    expect('apiKey' in view).toBe(false);
    expect(view.apiKeyMasked).toBe('sk-**********klmn');
    // keyof 层面的第二道：即便将来有人误用 strip 行为的对象，字段名也不该出现
    expect(Object.keys(view)).not.toContain('apiKey');
  });

  it('缺 apiKeyMasked 时校验失败（不允许「忘了掩码」的响应悄悄通过）', () => {
    expect(ProviderViewSchema.safeParse(provider).success).toBe(false);
  });
});

describe('Provider schema', () => {
  it('ProviderSchema 接受完整落盘记录，且拒绝空的 name / apiKey', () => {
    expect(ProviderSchema.safeParse(provider).success).toBe(true);
    expect(ProviderSchema.safeParse({ ...provider, name: '' }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, apiKey: '' }).success).toBe(false);
    expect(ProviderSchema.safeParse({ ...provider, models: [{ id: 'm', source: 'guess' }] }).success).toBe(false);
  });

  it('ProviderModelInputSchema 就是 ProviderModelSchema（增删单条模型共用一份口径）', () => {
    expect(ProviderModelInputSchema.safeParse({ id: 'gpt-4o', source: 'manual' }).success).toBe(true);
    expect(ProviderModelInputSchema.safeParse({ id: '', source: 'manual' }).success).toBe(false);
  });
});

/**
 * 窗口三格（spec §4.1）：它们必须**可选**（磁盘上已有的 config.json 一个都没有），
 * 同时必须真的**进得来**（zod 3 的 z.object 默认 strip 未知键：不声明就会静默丢掉）。
 */
describe('ProviderModelSchema 的窗口三格', () => {
  it('三格全部可选：老形态（只有 id + source）照常解析，缺字段就是未知', () => {
    const parsed = ProviderModelSchema.parse({ id: 'jd/GLM-5.3', source: 'fetched' });
    expect(parsed.contextWindow).toBeUndefined();
    expect(parsed.maxOutputTokens).toBeUndefined();
    expect(parsed.contextWindowSource).toBeUndefined();
  });

  it('窗口与来源往返不丢，且拒绝非正整数的窗口', () => {
    const model = {
      id: 'm',
      source: 'fetched' as const,
      contextWindow: 1_048_576,
      contextWindowSource: 'manual' as const,
    };
    expect(ProviderModelSchema.parse(model)).toEqual(model);
    // 0 / 负数 / 小数都不是窗口：契约层就挡下，别让它们流到适配器再被当成「已知」
    expect(ProviderModelSchema.safeParse({ id: 'm', source: 'fetched', contextWindow: 0 }).success).toBe(false);
    expect(ProviderModelSchema.safeParse({ id: 'm', source: 'fetched', contextWindow: -1 }).success).toBe(false);
    expect(ProviderModelSchema.safeParse({ id: 'm', source: 'fetched', contextWindow: 1.5 }).success).toBe(false);
  });
});

describe('ProviderCreateSchema / ProviderPatchSchema', () => {
  it('创建时 models 缺省为 []（新建供应商必然还没有模型清单）', () => {
    const parsed = ProviderCreateSchema.parse({
      name: '网关',
      protocolType: 'anthropic',
      baseUrl: 'https://gw.example.com/anthropic',
      apiKey: 'sk-x',
    });
    expect(parsed.models).toEqual([]);
  });

  it('补丁允许空对象与只给一个字段（不允许把 name 清空）', () => {
    expect(ProviderPatchSchema.safeParse({}).success).toBe(true);
    expect(ProviderPatchSchema.safeParse({ name: '新名字' }).success).toBe(true);
    expect(ProviderPatchSchema.safeParse({ name: '' }).success).toBe(false);
  });
});
