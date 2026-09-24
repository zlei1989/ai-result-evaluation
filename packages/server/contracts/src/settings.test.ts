// @vitest-environment node
/** 设置契约：默认值、解析容错、补丁的部分性与边界校验。 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, SettingsPatchSchema, SettingsSchema } from './settings';

describe('SETTINGS_DEFAULTS', () => {
  it('给出可直接落地运行的默认值', () => {
    expect(SETTINGS_DEFAULTS.theme).toBe('auto');
    expect(SETTINGS_DEFAULTS.workspaceRoot).toBe('~/.runs');
    expect(SETTINGS_DEFAULTS.defaultJudge).toBeNull();
    expect(SETTINGS_DEFAULTS.rowTimeoutMs).toBe(1_800_000);
    expect(SETTINGS_DEFAULTS.diffBudgetBytes).toBe(262_144);
  });

  it('默认值本身能通过 schema 校验（防止默认值与契约漂移）', () => {
    expect(SettingsSchema.safeParse(SETTINGS_DEFAULTS).success).toBe(true);
  });
});

describe('SettingsSchema', () => {
  it('拒绝未知的主题取值', () => {
    const result = SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, theme: 'blue' });
    expect(result.success).toBe(false);
  });

  it('拒绝非正 / 非整数的行超时与 diff 预算', () => {
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, rowTimeoutMs: 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, rowTimeoutMs: -1 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, rowTimeoutMs: 1.5 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, diffBudgetBytes: 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, diffBudgetBytes: 1.5 }).success).toBe(false);
  });

  it('defaultJudge 允许为 null（未配置）或完整的一对 id', () => {
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: null }).success).toBe(true);
    expect(
      SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1', modelId: 'm1' } }).success,
    ).toBe(true);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1' } }).success).toBe(false);
  });
});

describe('SettingsPatchSchema', () => {
  it('允许空补丁（无字段即无改动）', () => {
    expect(SettingsPatchSchema.safeParse({}).success).toBe(true);
  });

  it('允许只给一个字段（部分更新）', () => {
    const result = SettingsPatchSchema.safeParse({ theme: 'dark' });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ theme: 'dark' });
  });

  it('同样拒绝非法取值（补丁不能绕过校验）', () => {
    expect(SettingsPatchSchema.safeParse({ theme: 'blue' }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ rowTimeoutMs: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ rowTimeoutMs: 1.5 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ diffBudgetBytes: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ diffBudgetBytes: 1.5 }).success).toBe(false);
  });
});
