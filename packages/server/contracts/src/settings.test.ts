// @vitest-environment node
/** 设置契约：默认值、解析容错、补丁的部分性与边界校验。 */
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, SettingsPatchSchema, SettingsSchema } from './settings';

describe('SETTINGS_DEFAULTS', () => {
  it('给出可直接落地运行的默认值', () => {
    expect(SETTINGS_DEFAULTS.theme).toBe('auto');
    expect(SETTINGS_DEFAULTS.workspaceRoot).toBe('~/.aieval-runs');
    expect(SETTINGS_DEFAULTS.defaultJudge).toBeNull();
    expect(SETTINGS_DEFAULTS.diffBudgetBytes).toBe(262_144);
  });

  it('默认值本身能通过 schema 校验（防止默认值与契约漂移）', () => {
    expect(SettingsSchema.safeParse(SETTINGS_DEFAULTS).success).toBe(true);
  });

  /**
   * MCP 播种的**内容**守卫。
   *
   * 为什么不满足于「默认值能被 schema 解析」：解析只管形状对不对，管不了**内容**——
   * 预置项被删成 `{}`、名字被改掉、`--isolated` 被顺手拿掉，schema 一条都不会红，
   * 而用户第一次打开设置页看到的就不再是那两台能用的服务器。
   * 期望值**逐字写死**（不是从 `SETTINGS_DEFAULTS` 现算的——那是拿实现证实现）。
   */
  it('mcpServers 的默认值是那两台（context7 + playwright）', () => {
    expect(SETTINGS_DEFAULTS.mcpServers).toEqual({
      context7: {
        transport: 'http',
        enabled: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
      },
      playwright: {
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--browser=chrome', '--isolated'],
      },
    });
  });

  /**
   * 名字住在 **map 的键**上，条目里没有 `name` 字段。供应商那套是「条目自带 id」，
   * 照抄过来就会让名字有两个来源（键与字段），而 `McpServerConfigSchema` 是 strip 语义——
   * 多写的 `name` 落盘后又被丢掉，界面读回来的名字与用户填的那份静默不一致。
   * `enabled` 的另一半：它**必须显式写出**（不靠 schema 的 `.default(true)`），这份默认值会被原样落盘，
   * 「没写」与「写了 false」在文件里长得一样是最坏的失败方式。
   */
  it('默认项里没有 name 字段（名字只住键上），且 enabled 是显式写出的 true', () => {
    for (const entry of Object.values(SETTINGS_DEFAULTS.mcpServers)) {
      expect('name' in entry).toBe(false);
      expect(entry.enabled).toBe(true);
    }
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

  // 用户口径：执行与评分都不限时间 ⇒ 设置里没有「单行超时」这一格。
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

  it('defaultJudge 允许带一个可缺省的 effort（老配置读盘后是 undefined = 未指定）', () => {
    const withoutEffort = SettingsSchema.safeParse({
      ...SETTINGS_DEFAULTS,
      defaultJudge: { providerId: 'p1', modelId: 'm1' },
    });
    expect(withoutEffort.success).toBe(true);
    // 读回值本身也要钉住：老配置（磁盘上没这一格）必须落成 `undefined`，不能是 `''` 之类的哨兵值、
    // 也不能被补成某一档——「未指定（一个强度键都不加）」与「显式关闭（off）」是两件事，数据上必须可分
    expect(withoutEffort.success && withoutEffort.data.defaultJudge?.effort).toBeUndefined();
    expect(
      SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1', modelId: 'm1', effort: 'max' } })
        .success,
    ).toBe(true);
    // 关闭档存的是上游词汇原样（off），它是一份**指定**，不能被 min(1) 顺手拒掉
    expect(
      SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1', modelId: 'm1', effort: 'off' } })
        .success,
    ).toBe(true);
    // 空串不是「未指定」：它是填坏了的档位，放行就会一路传到请求体里
    expect(
      SettingsSchema.safeParse({ ...SETTINGS_DEFAULTS, defaultJudge: { providerId: 'p1', modelId: 'm1', effort: '' } })
        .success,
    ).toBe(false);
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
