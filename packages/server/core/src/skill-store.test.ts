// @vitest-environment node
/**
 * 技能扫描器守卫：识别单位（只认 `<根>/<名称>/SKILL.md`、不递归）、四条准入判据、
 * 「缺目录不是错误 / 读失败是错误」这对分界、坏条目**入列**、以及按名字码位升序。
 *
 * 为什么这几条各自要一条守卫：
 *   · 识别单位错了 ⇒ 用户放在第二层的 skill 永远扫不到，而界面上只是「少了一条」，没有任何报错；
 *   · 坏条目被静默丢掉 ⇒ 用户看到的是「我放的 skill 不见了」，而不是「它哪里不合格」；
 *   · 「缺目录」被当成错误 ⇒ 首次使用的用户一进设置页就是一片红（那不是故障，是还没放东西）；
 *     反过来「读失败」被当成空列表更坏——把一次权限故障说成「你还没放 skill」；
 *   · 排序：名字域是 `[a-z0-9-]`，码位序确定、不随 locale / ICU 变。用 `localeCompare` 时
 *     `A-skill` 会排到 `a-skill` 之后（实测），而界面**不再排**——顺序就是这一处的输出。
 *
 * 全程只碰 `mkdtempSync` 出来的临时配置目录：`setConfigDirForTesting` 一并搬走技能根，
 * 真实 `~/.aieval` 一次都不会被读到。
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { getConfigDir, setConfigDirForTesting } from './config-store';
import {
  compareSkillNames,
  getSkillsRoot,
  readSkillFile,
  scanSkills,
  type ScannedSkill,
  type SkillScan,
} from './skill-store';
import { removeTreeWithRetry } from './testing/cleanup';

let configDir: string;
let root: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'aieval-skills-'));
  setConfigDirForTesting(configDir);
  root = getSkillsRoot();
});

afterEach(() => {
  setConfigDirForTesting(null);
  removeTreeWithRetry(configDir);
});

/** 造一条 skill：目录 + SKILL.md（`frontmatter` 传 null 表示不写 frontmatter 块） */
function seedSkill(dirName: string, fields: Record<string, string> | null, body = '正文\n'): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  const head = fields === null ? '' : ['---', ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), '---', ''].join('\n');
  writeFileSync(join(dir, 'SKILL.md'), `${head}${body}`, 'utf8');
}

/** 按名字取一条（取不到直接抛：守卫不许因为条目丢了而静默通过） */
function entryOf(scan: SkillScan, name: string): ScannedSkill {
  const found = scan.skills.find((skill) => skill.name === name);
  if (found === undefined) throw new Error(`扫描结果里没有 ${name}（实际：${scan.skills.map((s) => s.name).join(', ')}）`);
  return found;
}

describe('getSkillsRoot', () => {
  it('技能根 = 配置目录下的 skills，跟着 setConfigDirForTesting 一起搬走', () => {
    // 没有第二个 override：改配置目录就是改技能根（`AIEVAL_CONFIG_DIR` 与 `~/.aieval` 同理）
    expect(getSkillsRoot()).toBe(join(configDir, 'skills'));
    expect(getSkillsRoot()).toBe(join(getConfigDir(), 'skills'));
  });

  it('扫描本身不建目录、不写文件（这是一条只读路径）', () => {
    const before = readdirSync(configDir);

    expect(scanSkills()).toEqual({ skills: [], skillWarnings: [{ path: root, reason: expect.stringContaining('还不存在') }] });
    expect(readdirSync(configDir)).toEqual(before);
  });
});

describe('scanSkills：缺目录 vs 读失败', () => {
  it('缺目录 ⇒ 空列表 + 一条根级 warning，**不抛**', () => {
    const scan = scanSkills();

    expect(scan.skills).toEqual([]);
    expect(scan.skillWarnings).toHaveLength(1);
    expect(scan.skillWarnings[0]?.path).toBe(root);
    expect(scan.skillWarnings[0]?.reason).toContain('技能目录还不存在');
  });

  it('目录存在但为空 ⇒ 空列表且**没有** warning（「不存在」与「空」是两句不同的话）', () => {
    mkdirSync(root, { recursive: true });

    expect(scanSkills()).toEqual({ skills: [], skillWarnings: [] });
  });

  it('读失败（技能根是个文件）⇒ 抛含路径的中文 INTERNAL，不冒充空列表', () => {
    writeFileSync(root, 'not a directory', 'utf8');

    expect(() => scanSkills()).toThrowError(ServiceError);
    try {
      scanSkills();
    } catch (error) {
      expect((error as ServiceError).code).toBe('INTERNAL');
      expect((error as ServiceError).message).toContain(root);
    }
  });
});

describe('scanSkills：识别单位与准入', () => {
  it('合法条目：ok=true、description 来自 frontmatter、sizeBytes 是这一条的体积', () => {
    seedSkill('tang-poem-meal', { name: 'tang-poem-meal', description: '推荐唐诗' });

    const entry = entryOf(scanSkills(), 'tang-poem-meal');

    expect(entry.ok).toBe(true);
    expect(entry.reason).toBeUndefined();
    expect(entry.description).toBe('推荐唐诗');
    expect(entry.dir).toBe(join(root, 'tang-poem-meal'));
    // 体积是整条目录的字节数（SKILL.md 自己至少算进去）
    expect(entry.sizeBytes).toBe(statSync(join(root, 'tang-poem-meal', 'SKILL.md')).size);
  });

  it('附属文件也算进体积（装入是整目录复制，只报入口文件会低报）', () => {
    seedSkill('with-refs', { name: 'with-refs', description: '带附属文件' });
    mkdirSync(join(root, 'with-refs', 'references'), { recursive: true });
    writeFileSync(join(root, 'with-refs', 'references', 'x.md'), 'x'.repeat(100), 'utf8');

    const entry = entryOf(scanSkills(), 'with-refs');

    expect(entry.sizeBytes).toBe(statSync(join(root, 'with-refs', 'SKILL.md')).size + 100);
  });

  it('不递归：第二层的 SKILL.md 扫不到，装它的那一层照旧是一行「缺 SKILL.md」', () => {
    seedSkill(join('group', 'nested-skill'), { name: 'nested-skill', description: '藏在第二层' });

    const scan = scanSkills();

    expect(scan.skills.map((skill) => skill.name)).toEqual(['group']);
    expect(entryOf(scan, 'group').ok).toBe(false);
    expect(entryOf(scan, 'group').reason).toContain('缺 SKILL.md');
  });

  it('目录缺 SKILL.md ⇒ ok=false + 中文原因（照旧一行，不静默丢）', () => {
    mkdirSync(join(root, 'no-file'), { recursive: true });

    const entry = entryOf(scanSkills(), 'no-file');

    expect(entry.ok).toBe(false);
    expect(entry.reason).toContain('缺 SKILL.md');
    expect(entry.description).toBe('');
  });

  it('裸 .md 文件 ⇒ 一行「缺 SKILL.md」（扁平形态不是识别单位）', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: 扁平的\n---\n正文', 'utf8');

    const entry = entryOf(scanSkills(), 'flat.md');

    expect(entry.ok).toBe(false);
    expect(entry.reason).toContain('缺 SKILL.md');
  });

  it('名称不合法（大写 / 下划线 / 超长）⇒ ok=false + 点名原因', () => {
    seedSkill('bad-name', { name: 'Bad_Name', description: '名字不合法' });
    seedSkill('too-long', { name: 'a'.repeat(65), description: '太长了' });

    expect(entryOf(scanSkills(), 'bad-name').reason).toContain('名称不合法');
    expect(entryOf(scanSkills(), 'too-long').reason).toContain('名称不合法');
  });

  it('frontmatter 缺 name ⇒ ok=false（准入的第一条就过不去）', () => {
    seedSkill('no-name', { description: '只写了 description' });

    expect(entryOf(scanSkills(), 'no-name').reason).toContain('名称不合法');
  });

  it('目录名与 frontmatter 的 name 不一致 ⇒ ok=false + 两个名字都点名', () => {
    seedSkill('dir-name', { name: 'other-name', description: '名字对不上' });

    const reason = entryOf(scanSkills(), 'dir-name').reason ?? '';

    expect(reason).toContain('dir-name');
    expect(reason).toContain('other-name');
    expect(reason).toContain('不一致');
  });

  it('缺 description / 纯空白 description ⇒ ok=false + 点名「description」', () => {
    seedSkill('no-desc', { name: 'no-desc' });
    seedSkill('blank-desc', { name: 'blank-desc', description: '   ' });

    expect(entryOf(scanSkills(), 'no-desc').reason).toContain('description');
    expect(entryOf(scanSkills(), 'blank-desc').reason).toContain('description');
  });

  it('description 超长（1025）⇒ ok=false', () => {
    seedSkill('long-desc', { name: 'long-desc', description: 'a'.repeat(1025) });

    expect(entryOf(scanSkills(), 'long-desc').ok).toBe(false);
  });

  it('没有 frontmatter 的 SKILL.md ⇒ ok=false（name 与 description 都缺）', () => {
    seedSkill('no-frontmatter', null, '# 直接就是正文\n');

    const entry = entryOf(scanSkills(), 'no-frontmatter');

    expect(entry.ok).toBe(false);
    expect(entry.reason).toContain('名称不合法');
  });

  it('坏条目一律带上绝对路径与体积能算就算（坏条目也要能点开抽屉看路径）', () => {
    seedSkill('bad-name-2', { name: 'Bad', description: '名字不合法' });

    const entry = entryOf(scanSkills(), 'bad-name-2');

    expect(entry.dir).toBe(join(root, 'bad-name-2'));
    expect(entry.sizeBytes).toBe(statSync(join(root, 'bad-name-2', 'SKILL.md')).size);
  });
});

/**
 * 排序：**码位升序**（`a.name < b.name`），不是 `localeCompare`。
 *
 * 判别用例刻意混一个**大写开头**的目录名：`Z-skill` 与 `a-skill` 在两种实现下的先后不同
 * （码位序 `Z"(0x5A) < "a"(0x61)，`localeCompare` 会把它排到最后），而它同时是「坏条目也参与排序」
 * 的证据。两个名字必须**互不相等**——大小写不敏感的卷上 `A-skill` 与 `a-skill` 是同一个目录，
 * 用那一对做判据会在这种卷上悄悄退化成一条只有一个元素的断言。
 *
 * 实现口径与比较器分开钉：`compareSkillNames` 的用例与文件系统无关（任何平台上都判别得出
 * `localeCompare`），扫描那一组钉的是「排序真的被调用了」——它的判别力依赖 `readdir` 的返回顺序
 * 不等于排序结果（APFS / 多数 Linux 文件系统成立；NTFS 的目录索引按名字有序，这一条在那种卷上
 * 会退化成恒真）。
 */
describe('scanSkills：按 name 码位升序', () => {
  it('compareSkillNames 是码位序：大写排在小写之前（localeCompare 会给出相反的顺序）', () => {
    const names = ['b-skill', 'a-skill', 'Z-skill'];

    expect([...names].sort(compareSkillNames)).toEqual(['Z-skill', 'a-skill', 'b-skill']);
    // 反面证据：本地化排序把 Z-skill 排到最后，与上面那条断言互斥
    expect([...names].sort((left, right) => left.localeCompare(right))).toEqual(['a-skill', 'b-skill', 'Z-skill']);
  });

  it('乱序建目录，输出仍是码位升序（含大写开头的坏条目）', () => {
    seedSkill('b-skill', { name: 'b-skill', description: 'b' });
    seedSkill('a-skill', { name: 'a-skill', description: 'a' });
    mkdirSync(join(root, 'Z-skill'), { recursive: true });

    const scan = scanSkills();

    expect(scan.skills.map((skill) => skill.name)).toEqual(['Z-skill', 'a-skill', 'b-skill']);
    expect(entryOf(scan, 'Z-skill').ok).toBe(false);
  });

  it('同名冲突不存在，但顺序稳定：连续两次扫描结果逐字相同', () => {
    seedSkill('one', { name: 'one', description: '一' });
    seedSkill('two', { name: 'two', description: '二' });

    expect(scanSkills()).toEqual(scanSkills());
  });
});

describe('readSkillFile：抽屉要的那一份', () => {
  it('返回逐字的 frontmatter 与正文原文', () => {
    seedSkill('tang-poem-meal', { name: 'tang-poem-meal', description: '推荐唐诗' }, '# 规则\n\n只推荐一首。\n');

    const file = readSkillFile('tang-poem-meal');

    expect(file.frontmatter).toBe(['---', 'name: tang-poem-meal', 'description: 推荐唐诗', '---'].join('\n'));
    expect(file.body).toBe('# 规则\n\n只推荐一首。\n');
  });

  it('名字不合法 ⇒ INVALID_QUERY（这是防路径穿越的那一道门）', () => {
    expect(() => readSkillFile('../../etc/passwd')).toThrowError(ServiceError);
    expect(() => readSkillFile('..')).toThrowError(ServiceError);
    try {
      readSkillFile('../outside');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
    }
  });

  it('目录在但 SKILL.md 不在 ⇒ NOT_FOUND + 含路径的中文原因', () => {
    mkdirSync(join(root, 'no-file'), { recursive: true });

    try {
      readSkillFile('no-file');
      throw new Error('本该抛 NOT_FOUND');
    } catch (error) {
      expect((error as ServiceError).code).toBe('NOT_FOUND');
      expect((error as ServiceError).message).toContain(join(root, 'no-file'));
    }
  });

  it('技能根整个不存在 ⇒ NOT_FOUND，不是 INTERNAL（「还没放 skill」不是故障）', () => {
    try {
      readSkillFile('whatever');
      throw new Error('本该抛 NOT_FOUND');
    } catch (error) {
      expect((error as ServiceError).code).toBe('NOT_FOUND');
    }
  });
});
