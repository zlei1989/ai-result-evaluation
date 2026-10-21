// @vitest-environment node
/**
 * skill 契约守卫：名字准入、`description` 边界、**落盘只允许 `{disabled:true}`**、列表形状、
 * 以及 `SKILL.md` 的 frontmatter 切分。
 *
 * 为什么这些边界必须有守卫：三条准入规则（名字、长度、description）是**「三家都装得上」的前提**，
 * 判错一条的后果不是「显示得不好看」，而是那一行在厂商侧被**静默丢弃**（dsh）或在启动前抛错（claude）。
 * 落盘那一侧同理：`{disabled:false}` 一旦被放行，「启用 = 删键」这条不变量当场破掉，而文件里看不出错。
 *
 * frontmatter 这一组钉的是**外部输入**：`SKILL.md` 可能随被测仓库克隆进来，切分规则必须
 * 在「逐字可核」与「字段够用」之间守住口径——正文要能原样交给 markdown 渲染，字段要能判准入。
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_NAME,
  SKILL_NAME_MAX_LENGTH,
  SkillEntrySchema,
  SkillFilePathSchema,
  SkillFileTextSchema,
  SkillListSchema,
  SkillNameSchema,
  SkillsPatchSchema,
  SkillsSettingsSchema,
  classifySkillOrigin,
  isValidSkillDescription,
  namedVendorSkill,
  splitSkillMarkdown,
} from './skill';

describe('SkillNameSchema：最严准入规则', () => {
  it('接受小写字母 / 数字与单个连字符分隔的名字', () => {
    for (const name of ['a', '0', 'tang-poem-meal', 'x1-y2', 'a'.repeat(SKILL_NAME_MAX_LENGTH)]) {
      expect(SkillNameSchema.safeParse(name).success, `${name} 应合法`).toBe(true);
    }
  });

  it('拒绝大小写混用、下划线、点、空格与中文', () => {
    for (const name of ['Tang', 'tang_poem', 'tang.poem', 'tang poem', '唐诗', 'tang/poem']) {
      expect(SkillNameSchema.safeParse(name).success, `${name} 应不合法`).toBe(false);
    }
  });

  it('拒绝首尾连字符与连续连字符', () => {
    for (const name of ['-tang', 'tang-', '--', 'tang--poem']) {
      expect(SkillNameSchema.safeParse(name).success, `${name} 应不合法`).toBe(false);
    }
  });

  it('长度上限 64：恰好 64 通过、65 拒绝', () => {
    expect(SkillNameSchema.safeParse('a'.repeat(SKILL_NAME_MAX_LENGTH)).success).toBe(true);
    expect(SkillNameSchema.safeParse('a'.repeat(SKILL_NAME_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('isValidSkillDescription：必填、非空、≤1024', () => {
  it('非空且不超长即合法', () => {
    expect(isValidSkillDescription('当用户让你推荐唐诗时，必须按本技能的规则作答')).toBe(true);
    expect(isValidSkillDescription('a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH))).toBe(true);
  });

  it('空串与纯空白都按「缺 description」处置', () => {
    // 纯空白不是描述：放行的话那条 skill 在 dsh 侧会因为 required 字段为空被整条丢弃
    expect(isValidSkillDescription('')).toBe(false);
    expect(isValidSkillDescription('   ')).toBe(false);
    expect(isValidSkillDescription('\n\t ')).toBe(false);
  });

  it('超过 1024 字符不合法', () => {
    expect(isValidSkillDescription('a'.repeat(SKILL_DESCRIPTION_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('SkillsSettingsSchema：落盘只允许 {disabled:true}', () => {
  it('接受 {entries:{<name>:{disabled:true}}}', () => {
    const parsed = SkillsSettingsSchema.parse({ entries: { 'tang-poem-meal': { disabled: true } } });

    expect(parsed.entries['tang-poem-meal']).toEqual({ disabled: true });
  });

  it('拒绝 disabled:false —— 「启用」不落盘（启用 = 删键）', () => {
    const result = SkillsSettingsSchema.safeParse({ entries: { foo: { disabled: false } } });

    expect(result.success).toBe(false);
  });

  it('拒绝多余的键：值里只允许 disabled 这一个字段', () => {
    expect(SkillsSettingsSchema.safeParse({ entries: { foo: { disabled: true, enabled: false } } }).success).toBe(
      false,
    );
  });

  it('键走最严名字规则（非法名进不来）', () => {
    expect(SkillsSettingsSchema.safeParse({ entries: { Foo: { disabled: true } } }).success).toBe(false);
    expect(
      SkillsSettingsSchema.safeParse({ entries: { ['a'.repeat(SKILL_NAME_MAX_LENGTH + 1)]: { disabled: true } } })
        .success,
    ).toBe(false);
  });

  it('空 entries 合法（默认就是空——skills 没有预置项）', () => {
    expect(SkillsSettingsSchema.parse({ entries: {} })).toEqual({ entries: {} });
  });

  it('缺 entries 不合法：这一格必须在文件里，否则读盘时整段被静默丢掉', () => {
    expect(SkillsSettingsSchema.safeParse({}).success).toBe(false);
  });
});

/**
 * 补丁那条与落盘那条**刻意不同形**：补丁收的是**期望状态**（`disabled: boolean`），落盘只存停用。
 * 两条合成一条的两种改法各坏一半：放宽落盘这条 ⇒「配置里只出现停用」这条不变量没人守；
 * 让补丁继承落盘那条 ⇒「再打开」（`{disabled:false}` ⇒ 删键）在 API 门口就被判 400。
 */
describe('SkillsPatchSchema：补丁收的是期望状态', () => {
  it('接受 disabled:false 与 disabled:true（落盘那条仍然只认 true）', () => {
    for (const disabled of [true, false]) {
      expect(SkillsPatchSchema.safeParse({ entries: { 'tang-poem-meal': { disabled } } }).success).toBe(true);
    }
    expect(SkillsSettingsSchema.safeParse({ entries: { 'tang-poem-meal': { disabled: false } } }).success).toBe(
      false,
    );
  });

  it('键走同一把最严名字尺子（非法名从 API 进不来）', () => {
    for (const name of ['Tang', 'tang_poem', 'tang/poem', '..', 'a'.repeat(SKILL_NAME_MAX_LENGTH + 1)]) {
      expect(SkillsPatchSchema.safeParse({ entries: { [name]: { disabled: true } } }).success, name).toBe(false);
    }
  });

  it('值里只允许 disabled 一个字段：多给的键是自相矛盾的输入，说出来而不是静默 strip', () => {
    expect(SkillsPatchSchema.safeParse({ entries: { foo: { disabled: true, enabled: false } } }).success).toBe(
      false,
    );
  });

  it('entries 这一层不能省：空 entries 合法（无改动），缺 entries 不合法', () => {
    expect(SkillsPatchSchema.parse({ entries: {} })).toEqual({ entries: {} });
    expect(SkillsPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe('SkillListSchema：坏条目在列表里', () => {
  const ROOT = '/home/u/.aieval/skills';

  it('接受一条 ok:false 带中文原因的条目', () => {
    const parsed = SkillListSchema.parse({
      root: ROOT,
      skills: [{ name: 'broken', dir: `${ROOT}/broken`, description: '', ok: false, reason: '缺 SKILL.md', disabled: false }],
      skillWarnings: [{ path: ROOT, reason: '技能目录还不存在' }],
    });

    expect(parsed.skills[0]?.reason).toBe('缺 SKILL.md');
  });

  /**
   * 体积这一格**不在契约里**（见 `SkillEntrySchema` 的注释）：那个键现在要被剥掉，
   * 而不是被当成一个「多出来的无害字段」收下——strip 之后它还在的话，说明有消费方
   * 悄悄读着一个已经退场的字段。
   */
  it('体积不是这一格的字段：多余键被剥掉', () => {
    const base = { name: 'a', dir: '/x/a', description: 'd', ok: true, disabled: true };

    expect(SkillEntrySchema.safeParse(base).success).toBe(true);
    expect(SkillEntrySchema.parse({ ...base, sizeBytes: 2048 })).not.toHaveProperty('sizeBytes');
  });

  it('三格都必填：root（界面要显示它）+ 两个数组（`skills: []` 表示「扫过且没有」，不许缺席冒充）', () => {
    expect(SkillListSchema.safeParse({ skills: [], skillWarnings: [] }).success).toBe(false);
    expect(SkillListSchema.safeParse({ root: ROOT, skillWarnings: [] }).success).toBe(false);
    expect(SkillListSchema.safeParse({ root: ROOT, skills: [] }).success).toBe(false);
    expect(SkillListSchema.parse({ root: ROOT, skills: [], skillWarnings: [] })).toEqual({
      root: ROOT,
      skills: [],
      skillWarnings: [],
    });
  });
});

describe('SkillFilePathSchema：技能内相对路径的第一道门', () => {
  it('收正常相对路径（含子目录），原样返回', () => {
    expect(SkillFilePathSchema.parse('SKILL.md')).toBe('SKILL.md');
    expect(SkillFilePathSchema.parse('reference/API.md')).toBe('reference/API.md');
  });

  it('绝对路径 / `..` / `.` / 空段 / 太深一律拒（这些都要在进文件系统之前被拦下）', () => {
    const rejected = ['/etc/passwd', '../config.json', 'a/../b', './a', 'a//b', 'a/b/c/d/e/f/g/h'];

    for (const bad of rejected) {
      expect(SkillFilePathSchema.safeParse(bad).success, `${bad} 应被拒`).toBe(false);
    }
  });
});

describe('SkillFileTextSchema：读到的那个文件', () => {
  it('path 与 text 都在，且 path 也要过同一道门', () => {
    expect(SkillFileTextSchema.parse({ path: 'SKILL.md', text: '# 正文\n' })).toEqual({
      path: 'SKILL.md',
      text: '# 正文\n',
    });
    // 路径那格不是自由字符串：`../x` 连解析都不该过
    expect(SkillFileTextSchema.safeParse({ path: '../x', text: '' }).success).toBe(false);
  });
});

describe('splitSkillMarkdown：frontmatter 逐字 + 正文原文', () => {
  const RAW = ['---', 'name: tang-poem-meal', 'description: 推荐唐诗', '---', '', '# 规则', '', '只推荐一首。', ''].join(
    '\n',
  );

  /** 带嵌套映射与注释的 frontmatter：验证「只看顶层标量」这条边界 */
  function splitMarkdownWithNested(): ReturnType<typeof splitSkillMarkdown> {
    return splitSkillMarkdown(
      ['---', '# 注释', 'metadata:', '  author: someone', 'name: ok-name', '---', '正文'].join('\n'),
    );
  }

  it('frontmatter 含首尾围栏逐字返回，body 是围栏之后的原文', () => {
    const split = splitSkillMarkdown(RAW);

    expect(split.frontmatter).toBe(['---', 'name: tang-poem-meal', 'description: 推荐唐诗', '---'].join('\n'));
    // 正文**不减不改**：空白与缩进都是 markdown 语法的一部分，修剪会改掉围栏代码块的语义
    expect(split.body).toBe(['', '# 规则', '', '只推荐一首。', ''].join('\n'));
  });

  it('解析顶层字段：裸值与引号值都去掉包裹', () => {
    const split = splitSkillMarkdown(
      ['---', 'name: "tang-poem-meal"', 'description: \'推荐唐诗\'', 'allowed-tools: Read', '---', '正文'].join('\n'),
    );

    expect(split.fields).toEqual({
      name: 'tang-poem-meal',
      description: '推荐唐诗',
      'allowed-tools': 'Read',
    });
  });

  it('块标量按 YAML 的折叠 / 字面规则拼接', () => {
    const folded = splitSkillMarkdown(['---', 'description: >', '  第一段', '  第二段', '---', '正文'].join('\n'));
    const literal = splitSkillMarkdown(['---', 'description: |', '  第一行', '  第二行', '---', '正文'].join('\n'));

    expect(folded.fields['description']).toBe('第一段 第二段');
    expect(literal.fields['description']).toBe('第一行\n第二行');
  });

  it('只看顶层字段：嵌套结构的值不冒充顶层字段、注释行不成条目', () => {
    const split = splitMarkdownWithNested();

    expect(split.fields['name']).toBe('ok-name');
    // 嵌套映射的键与值都不进 fields：混进来会让「目录名 vs frontmatter name」的判定读到别人的字段
    expect(split.fields['author']).toBeUndefined();
    expect(Object.values(split.fields)).not.toContain('someone');
    // 注释行不是字段
    expect(Object.keys(split.fields).some((key) => key.startsWith('#'))).toBe(false);
  });

  it('没有 frontmatter 时 frontmatter 为 null、正文是整份原文', () => {
    const split = splitSkillMarkdown('# 直接就是正文\n');

    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe('# 直接就是正文\n');
    expect(split.fields).toEqual({});
  });

  it('只有开围栏没有闭合时按「没有 frontmatter」处置（半个块不算）', () => {
    const split = splitSkillMarkdown(['---', 'name: broken'].join('\n'));

    expect(split.frontmatter).toBeNull();
    expect(split.body).toBe(['---', 'name: broken'].join('\n'));
  });

  it('CRLF 与 BOM 都不影响识别：围栏仍被认出', () => {
    const split = splitSkillMarkdown('\uFEFF---\r\nname: crlf-skill\r\n---\r\n正文\r\n');

    expect(split.fields['name']).toBe('crlf-skill');
    expect(split.body).toBe('正文\r\n');
  });
});

describe('SKILL_FILE_NAME', () => {
  it('识别单位是 <根>/<名称>/SKILL.md，文件名大小写敏感', () => {
    expect(SKILL_FILE_NAME).toBe('SKILL.md');
  });
});

/**
 * **来源分档**（本机启用项 / 厂商内置 / 被测仓库自带 / 来源未证实）。
 *
 * 为什么这一格要有守卫：它是「已下发的技能」那一格里唯一由**我们**下的结论，而两处容易猜错——
 *   · 判据必须**先看落点再看原值**：codex 的 `.system/` 内置目录与我们的那几条**同居**
 *     `<候选配置目录>/skills/` 之下，顺序反了会把厂商内置说成「本机启用项」；
 *   · 原值表里的取值**逐字来自真机**（claude：`userSettings` / `projectSettings` / `built-in`；
 *     codex：`user` / `system`），不认识的取值一律 `unverified`——**不许按命名推测**
 *     （猜错的表现是来源那一格说了一句假话，而它在界面上与真话长得一模一样）。
 */
describe('classifySkillOrigin（来源分档）', () => {
  const layout = { configHome: '/runs/run-1/candidates/candidate-1/.agenthome', cwd: '/runs/run-1/candidates/candidate-1/workspace' };

  it('落点在候选配置目录之下 ⇒ 本机启用项（厂商原值只是旁证）', () => {
    expect(
      classifySkillOrigin({ source: null, path: `${layout.configHome}/skills/alpha/SKILL.md`, ...layout }),
    ).toBe('local-enabled');
  });

  it('`.system/` 那一档排在前面：codex 的内置与我们的条目同居一个 `skills/` 之下', () => {
    expect(
      classifySkillOrigin({ source: 'system', path: `${layout.configHome}/skills/.system/imagegen/SKILL.md`, ...layout }),
    ).toBe('vendor-builtin');
  });

  it('落点在工作目录之下 ⇒ 被测仓库自带（那句安全提示的计数就是它）', () => {
    expect(
      classifySkillOrigin({ source: 'user', path: `${layout.cwd}/.codex/skills/repo-owned/SKILL.md`, ...layout }),
    ).toBe('repo-provided');
    expect(
      classifySkillOrigin({ source: null, path: `${layout.cwd}/.claude/skills/repo-owned/SKILL.md`, ...layout }),
    ).toBe('repo-provided');
  });

  it('没有落点时按厂商原值表（真机三档 + codex 的 system）', () => {
    expect(classifySkillOrigin({ source: 'userSettings', path: null, ...layout })).toBe('local-enabled');
    expect(classifySkillOrigin({ source: 'projectSettings', path: null, ...layout })).toBe('repo-provided');
    expect(classifySkillOrigin({ source: 'built-in', path: null, ...layout })).toBe('vendor-builtin');
    expect(classifySkillOrigin({ source: 'system', path: null, ...layout })).toBe('vendor-builtin');
  });

  it('落点与原值都给不出结论 ⇒ 来源未证实（不许猜）', () => {
    // codex 的 `scope: "user"` 单独出现时说明不了「是本机启用项还是别的 user 根」——那是原值，
    // 不是结论（候选内的 `~` 会指到候选配置目录，但我们没有落点可核）
    expect(classifySkillOrigin({ source: 'user', path: null, ...layout })).toBe('unverified');
    expect(classifySkillOrigin({ source: null, path: null, ...layout })).toBe('unverified');
    expect(classifySkillOrigin({ source: 'whatever', path: '/opt/other/skills/x/SKILL.md', ...layout })).toBe('unverified');
  });

  it('`namedVendorSkill`：只有名字的通道（dsh 的目录）一律记来源未证实', () => {
    expect(namedVendorSkill('alpha')).toEqual({ name: 'alpha', source: null, path: null, origin: 'unverified' });
  });

  /**
   * 同一个目录的**两种写法**必须都认得出「在我这个目录之下」。
   *
   * 为什么这条要在真文件系统上造不对称：厂商报的落点是**它自己看到的路径**，而我们手里的
   * `configHome` / `cwd` 来自配置——两者常常只是写法不同（macOS 上 `os.tmpdir()` 给的是
   * 软链形态 `/var/folders/…`，真实路径是 `/private/var/folders/…`）。纯字符串前缀比较在
   * 这种环境下**落点这一条分支整体失效**，只剩原值兜底，而 codex 的原值 `user` 给不出结论
   * ⇒ 界面上把「我们自己刚装进去的那两条」显示成「来源未证实」。
   *
   * 覆盖面按 `classifySkillOrigin` 的三支各来一条：候选配置目录（含 `.system` 那一档）、
   * 工作目录；两侧的形态**交叉给**（软链形态 vs 真实形态各占一半），任一侧不归一都见红。
   */
  it('软链形态与真实形态是同一个目录：落点分档不许因为写法不同而失效', () => {
    const base = mkdtempSync(join(tmpdir(), 'aieval-skill-origin-'));
    const realBase = realpathSync(base);
    /** 软链形态的那一份（指向同一个目录）：模拟 `/tmp` 与 `/private/tmp` 这层不对称 */
    const linkOf = (name: string, realDir: string): string => {
      const link = join(base, `${name}-link`);
      symlinkSync(realDir, link, 'dir');
      return link;
    };

    /** 判据落在**真实存在的文件**上：`realpathSync` 对不存在的路径会回落成原样，那样这条守卫就测不到东西 */
    const place = (rel: string): string => {
      const file = join(realBase, rel);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '---\nname: x\ndescription: x\n---\n', 'utf8');
      return file;
    };
    const realCandidate = join(realBase, 'candidate');
    place('candidate/skills/tang-poem-meal/SKILL.md');
    place('candidate/skills/.system/imagegen/SKILL.md');
    place('workspace/.claude/skills/repo-owned/SKILL.md');
    const linkCandidate = linkOf('candidate', realCandidate);

    const layout = { configHome: '/runs/run-1/candidates/candidate-1/.agenthome', cwd: '/runs/run-1/candidates/candidate-1/workspace' };

    /** 解析器由 **Node 侧**注入（契约不许引 `node:fs`）；这一条用例验的就是两种形态要归一 */
    const classify = (
      evidence: Parameters<typeof classifySkillOrigin>[0],
    ): ReturnType<typeof classifySkillOrigin> =>
      classifySkillOrigin({ ...evidence, resolveRealPath: realpathSync });

    // ① 真实形态的 configHome + 软链形态的落点 ⇒ 仍要认成「本机启用项」（codex 原值 `user`）
    expect(
      classify({ source: 'user', path: `${linkCandidate}/skills/tang-poem-meal/SKILL.md`, configHome: realCandidate, cwd: layout.cwd }),
    ).toBe('local-enabled');

    // ② 反向：软链形态的 configHome + 真实形态的落点
    expect(
      classify({ source: 'user', path: `${realCandidate}/skills/tang-poem-meal/SKILL.md`, configHome: linkCandidate, cwd: layout.cwd }),
    ).toBe('local-enabled');

    // ③ `.system/` 那一档同样要过真实路径：落点优先于原值，认不出就只剩兜底（`user` ⇒ 未证实）
    expect(
      classify({ source: 'user', path: `${realCandidate}/skills/.system/imagegen/SKILL.md`, configHome: linkCandidate, cwd: layout.cwd }),
    ).toBe('vendor-builtin');

    // ④ 工作目录那一侧同理（被测仓库自带的那条走 `.claude/skills/`）
    const realWorkspace = join(realBase, 'workspace');
    const linkWorkspace = linkOf('workspace', realWorkspace);
    expect(
      classify({
        source: null,
        path: `${realWorkspace}/.claude/skills/repo-owned/SKILL.md`,
        configHome: layout.configHome,
        cwd: linkWorkspace,
      }),
    ).toBe('repo-provided');
  });
});
