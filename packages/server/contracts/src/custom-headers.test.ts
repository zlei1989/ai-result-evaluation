// @vitest-environment node
/**
 * 自定义请求头契约：形状（键名 token / 值不许换行 / 大小写不敏感去重）、默认空、落盘必填、
 * 出口掩码与补丁消解。
 *
 * 为什么这几条非有不可：这张表会**原样发给网关**，四家在四个位置各自翻一遍方言。契约漏一格
 * 形状错误，表现不是报错，而是「某一家静默少带了一条头 / 带了一条畸形头」——那只能靠
 * 对着网关抓包才发现，代价比在这里拦住大得多。掩码那一条更硬：漏了它，保存一次就把真值
 * 写成了掩码串，症状要到下一次运行才以 401 现身。
 *
 * `settings.ts` 与本文件互相 import（那边取这两个工具，这边取它的 schema 与常量），环在求值期成立；
 * 本文件让 `./custom-headers` 先于 `./settings` 求值，是「两侧入口都能加载」的那半边判据
 * （另半边在 `settings.test.ts` 与经包根加载的 `index.test.ts` 里）。
 */
import { describe, expect, it } from 'vitest';
import { customHeaderIssue, maskCustomHeaders, preserveUnchangedCustomHeaders } from './custom-headers';
import { maskApiKey } from './provider';
import {
  CUSTOM_HEADER_KEY_MESSAGE,
  CUSTOM_HEADER_VALUE_MESSAGE,
  CustomHeadersSchema,
  SETTINGS_DEFAULTS,
  SettingsPatchSchema,
  SettingsSchema,
  preserveUnchangedSecrets,
  toSettingsView,
} from './settings';

describe('CustomHeadersSchema', () => {
  it('接受空表与常见的几条头', () => {
    expect(CustomHeadersSchema.safeParse({}).success).toBe(true);
    expect(
      CustomHeadersSchema.safeParse({
        'X-Trace-Id': 'abc-123',
        'x-team': '评测组',
        'X-Gateway-Route': 'gw-a:443',
      }).success,
    ).toBe(true);
  });

  it('键名按 HTTP field-name 的 token 语法收：空白 / 冒号 / 空串都拒', () => {
    for (const bad of ['X Trace', 'X:Trace', '', 'X\tTrace']) {
      const result = CustomHeadersSchema.safeParse({ [bad]: 'v' });
      expect(result.success, `键名「${bad}」应被拒`).toBe(false);
    }
  });

  it('值里不许有 CR / LF（Header 注入的形状）', () => {
    for (const bad of ['a\r\nX-Evil: 1', 'a\nb', 'a\rb']) {
      const result = CustomHeadersSchema.safeParse({ 'X-Trace-Id': bad });
      expect(result.success, `值「${JSON.stringify(bad)}」应被拒`).toBe(false);
    }
    // 空值合法：它表示「这条头发出去但值为空」，与会话无关
    expect(CustomHeadersSchema.safeParse({ 'X-Trace-Id': '' }).success).toBe(true);
  });

  /**
   * 大小写不敏感去重：`X-Trace` 与 `x-trace` 在 map 里是两行、发出去只有一条。
   * 放行它 = 落盘与真实行为分家，而界面上看不到任何异常。
   */
  it('同名（忽略大小写）只能出现一次', () => {
    const result = CustomHeadersSchema.safeParse({ 'X-Trace': '1', 'x-trace': '2' });

    expect(result.success).toBe(false);
    expect(result.success || result.error.issues[0]?.message).toContain('不区分大小写');
  });
});

describe('customHeaderIssue', () => {
  it('合法回 null；不合法回第一处的中文原因（与 schema 同源）', () => {
    expect(customHeaderIssue({})).toBeNull();
    expect(customHeaderIssue({ 'X-Trace': '1' })).toBeNull();
    expect(customHeaderIssue({ 'X Trace': '1' })).toBe(CUSTOM_HEADER_KEY_MESSAGE);
    expect(customHeaderIssue({ 'X-Trace': 'a\nb' })).toBe(CUSTOM_HEADER_VALUE_MESSAGE);
  });
});

describe('SETTINGS_DEFAULTS.customHeaders', () => {
  it('默认是空表——没有预置项，空表本身就是「一条都不发」', () => {
    expect(SETTINGS_DEFAULTS.customHeaders).toEqual({});
  });

  it('这一格是必填：缺了它 schema 不过（读盘归一化的键表取自默认值，缺键 = 落盘值被静默丢掉）', () => {
    const { customHeaders: _omitted, ...withoutHeaders } = SETTINGS_DEFAULTS;

    expect(SettingsSchema.safeParse(withoutHeaders).success).toBe(false);
    expect(SettingsSchema.safeParse(SETTINGS_DEFAULTS).success).toBe(true);
  });

  it('补丁可以只带 customHeaders，也可整个缺席', () => {
    expect(SettingsPatchSchema.safeParse({ customHeaders: { 'X-Trace': '1' } }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true);
  });

  it('补丁同样拦非法形状（补丁不能绕过校验）', () => {
    expect(SettingsPatchSchema.safeParse({ customHeaders: { 'X Trace': '1' } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ customHeaders: { 'X-Trace': 'a\r\nb' } }).success).toBe(false);
  });
});

/** 落盘那份：一条敏感头 + 一条非敏感头 */
const STORED = { 'X-Api-Key': 'plain-secret-0003', 'X-Trace-Id': 'abc' };

describe('出口掩码', () => {
  it('敏感键的值被掩码、非敏感键原样；两张表各判各的', () => {
    const view = toSettingsView({ ...SETTINGS_DEFAULTS, customHeaders: STORED });

    expect(view.customHeaders).toEqual({ 'X-Api-Key': maskApiKey('plain-secret-0003'), 'X-Trace-Id': 'abc' });
  });

  it('出口 JSON 里搜不到明文，且落盘那份一字未动（就地改写会把掩码写进文件）', () => {
    const stored = { ...SETTINGS_DEFAULTS, customHeaders: { ...STORED } };
    const view = toSettingsView(stored);

    expect(JSON.stringify(view)).not.toContain('plain-secret-0003');
    expect(stored.customHeaders).toEqual(STORED);
    // 出口那张表是**新对象**：调用方就地改它不该连带改掉落盘那份
    expect(view.customHeaders).not.toBe(stored.customHeaders);
  });

  it('maskCustomHeaders 不改入参', () => {
    const input = { ...STORED };

    const masked = maskCustomHeaders(input);

    expect(input).toEqual(STORED);
    expect(masked).not.toBe(input);
  });
});

describe('补丁消解 preserveUnchangedCustomHeaders', () => {
  it('回传掩码串 ⇒ 换回落盘原值（不这么做，保存一次就把真密钥写成了掩码）', () => {
    const resolved = preserveUnchangedCustomHeaders(STORED, {
      'X-Api-Key': maskApiKey('plain-secret-0003'),
      'X-Trace-Id': 'abc',
    });

    expect(resolved).toEqual(STORED);
  });

  it('敏感键留空 ⇒ 保留原值；非敏感键留空 ⇒ 照收（用户真把这条改成空值了）', () => {
    const resolved = preserveUnchangedCustomHeaders(STORED, { 'X-Api-Key': '', 'X-Trace-Id': '' });

    expect(resolved).toEqual({ 'X-Api-Key': 'plain-secret-0003', 'X-Trace-Id': '' });
  });

  it('换了新值就照收（新密钥不能被原值盖掉）', () => {
    const resolved = preserveUnchangedCustomHeaders(STORED, { 'X-Api-Key': 'brand-new-secret' });

    expect(resolved['X-Api-Key']).toBe('brand-new-secret');
  });

  it('大小写不同只是重敲了一遍：仍认作同一条头，密钥不丢', () => {
    const resolved = preserveUnchangedCustomHeaders(STORED, { 'x-api-key': '' });

    expect(resolved['x-api-key']).toBe('plain-secret-0003');
  });

  it('落盘里没有这个键时不给「原值」：补丁值照收（否则用户新填的密钥被静默吃掉）', () => {
    const resolved = preserveUnchangedCustomHeaders({}, { 'X-Api-Key': '' });

    expect(resolved['X-Api-Key']).toBe('');
  });

  it('preserveUnchangedSecrets 同一趟把两张表都消解了（漏掉 customHeaders 就是密钥被掩码覆盖）', () => {
    const current = { ...SETTINGS_DEFAULTS, customHeaders: { ...STORED } };

    const patch = preserveUnchangedSecrets(current, {
      customHeaders: { 'X-Api-Key': maskApiKey('plain-secret-0003') },
      mcpServers: {},
    });

    expect(patch.customHeaders).toEqual({ 'X-Api-Key': 'plain-secret-0003' });
    expect(patch.mcpServers).toEqual({});
  });

  /**
   * 只带 `customHeaders` 的补丁也要消解（上一条同时带了 `mcpServers`，两条路走的是同一个分支判断——
   * 但那一半若被写成「有 mcpServers 才顺带处理」，只有本用例会红）。
   */
  it('补丁里只有 customHeaders 时同样消解（不被 mcpServers 那一路的判据顺带挡住）', () => {
    const current = { ...SETTINGS_DEFAULTS, customHeaders: { ...STORED } };

    const patch = preserveUnchangedSecrets(current, {
      customHeaders: { 'X-Api-Key': maskApiKey('plain-secret-0003'), 'X-Trace-Id': 'abc' },
    });

    expect(patch.customHeaders).toEqual(STORED);
    expect('mcpServers' in patch).toBe(false);
  });

  it('补丁里没有这两张表时，结果里也不凭空长出它们（「没改」不许被读成「改成空」）', () => {
    const patch = preserveUnchangedSecrets(SETTINGS_DEFAULTS, { theme: 'dark' });

    expect('customHeaders' in patch).toBe(false);
    expect('mcpServers' in patch).toBe(false);
  });
});
