// @vitest-environment node
/** 设置契约：默认值、解析容错、补丁的部分性与边界校验。 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, SettingsPatchSchema, SettingsSchema } from './settings';

describe('SETTINGS_DEFAULTS', () => {
  it('给出可直接落地运行的默认值', () => {
    expect(SETTINGS_DEFAULTS.theme).toBe('auto');
    expect(SETTINGS_DEFAULTS.workspaceRoot).toBe('~/.runs');
    expect(SETTINGS_DEFAULTS.defaultJudge).toBeNull();
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

  it('拒绝非正 / 非整数的 diff 预算', () => {
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, diffBudgetBytes: 0 }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, diffBudgetBytes: 1.5 }).success).toBe(false);
  });

  // 2026-09-28 用户口径：执行与评分都不限时间 ⇒ 「单行超时」这一格从设置里删掉。
  // 这条守卫钉两件事：① 契约里确实没有这一格了（加回来会红）；② 旧 config.json 里多出来的
  // 那一键**不会**让解析失败——它由 zod 的对象语义 strip 掉，老配置照常能读。
  it('没有 rowTimeoutMs 这一格，且旧配置里多出来的 rowTimeoutMs 不会让解析失败', () => {
    expect('rowTimeoutMs' in SETTINGS_DEFAULTS).toBe(false);
    const legacy = { ...SETTINGS_DEFAULTS, rowTimeoutMs: 1_800_000 };
    const parsed = SettingsSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'rowTimeoutMs' in parsed.data).toBe(false);
  });

  it('defaultJudge 允许为 null（未配置）或完整的一对 id', () => {
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: null }).success).toBe(true);
    expect(
      SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1', modelId: 'm1' } }).success,
    ).toBe(true);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1' } }).success).toBe(false);
  });

  it('defaultJudgeAgent 默认未配置，且只认三家智能体', () => {
    expect(SETTINGS_DEFAULTS.defaultJudgeAgent).toBeNull();
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudgeAgent: null }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudgeAgent: 'dsh' }).success).toBe(true);
    // 自造的名字必须被拒：写进配置之后评分阶段才炸，等于让人去设置页反复确认一个填了的字段
    expect(SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudgeAgent: 'gemini' }).success).toBe(false);
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
    expect(SettingsPatchSchema.safeParse({ diffBudgetBytes: 0 }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ diffBudgetBytes: 1.5 }).success).toBe(false);
  });
});
