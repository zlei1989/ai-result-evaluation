// @vitest-environment node
/**
 * 技能扫描器守卫：识别单位（只认 `<根>/<名称>/SKILL.md`、不递归、第一层只有目录与软链是候选）、
 * 四条准入判据、「缺目录不是错误 / 读失败是错误」这对分界、坏条目**入列**、以及按名字码位升序。
 *
 * 为什么这几条各自要一条守卫：
 *   · 识别单位错了 ⇒ 用户放在第二层的 skill 永远扫不到，而界面上只是「少了一条」，没有任何报错；
 *   · 坏条目被静默丢掉 ⇒ 用户看到的是「我放的 skill 不见了」，而不是「它哪里不合格」；
 *   · 第一层的普通文件被当成技能 ⇒ `.DS_Store` / `README.md` / 扁平 `.md` 各占一行「缺 SKILL.md」，
 *     看起来像「我放的技能坏了」；但**软链不能跟着一起滤掉**——技能目录常常整条是软链；
 *   · 「缺目录」被当成错误 ⇒ 首次使用的用户一进设置页就是一片红（那不是故障，是还没放东西）；
 *     反过来「读失败」被当成空列表更坏——把一次权限故障说成「你还没放 skill」；
 *   · 排序：名字域是 `[a-z0-9-]`，码位序确定、不随 locale / ICU 变。用 `localeCompare` 时
 *     `A-skill` 会排到 `a-skill` 之后（实测），而界面**不再排**——顺序就是这一处的输出。
 *
 * 全程只碰 `mkdtempSync` 出来的临时配置目录：`setConfigDirForTesting` 一并搬走技能根，
 * 真实 `~/.aieval` 一次都不会被读到。
 */
import { mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceError, SKILL_PREVIEW_MAX_BYTES } from '@aieval/contracts';
import { getConfigDir, setConfigDirForTesting } from './config-store';
import {
  compareSkillNames,
  getSkillsRoot,
  readSkillFileText,
  readSkillTree,
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
  it('合法条目：ok=true、description 来自 frontmatter', () => {
    seedSkill('tang-poem-meal', { name: 'tang-poem-meal', description: '推荐唐诗' });

    const entry = entryOf(scanSkills(), 'tang-poem-meal');

    expect(entry.ok).toBe(true);
    expect(entry.reason).toBeUndefined();
    expect(entry.description).toBe('推荐唐诗');
    expect(entry.dir).toBe(join(root, 'tang-poem-meal'));
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

  it('第一层的普通文件不是技能：.DS_Store / README / 扁平 .md 一律不入列', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.DS_Store'), '', 'utf8');
    writeFileSync(join(root, 'README.md'), '# 这里放技能目录\n', 'utf8');
    // 扁平形态（`<根>/<名称>.md`）同样是文件：它不是识别单位，也不再占一行「缺 SKILL.md」
    writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: 扁平的\n---\n正文', 'utf8');
    seedSkill('real-skill', { name: 'real-skill', description: '真技能' });

    expect(scanSkills().skills.map((skill) => skill.name)).toEqual(['real-skill']);
  });

  it('第一层的噪声目录（.git / node_modules）也不占一行「缺 SKILL.md」', () => {
    seedSkill('real-skill', { name: 'real-skill', description: '真技能' });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });

    expect(scanSkills().skills.map((skill) => skill.name)).toEqual(['real-skill']);
  });

  it('软链形态的技能照旧入列（过滤只挡普通文件，不许把软链一起滤掉）', () => {
    // 技能常住在仓库里、在技能根挂一条软链：`isDirectory()` 对软链恒为 false，判据漏了它就整条不见
    const source = join(configDir, 'skill-source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: linked-skill\ndescription: 软链进来的\n---\n正文\n', 'utf8');
    mkdirSync(root, { recursive: true });
    symlinkSync(source, join(root, 'linked-skill'));

    const entry = entryOf(scanSkills(), 'linked-skill');

    expect(entry.ok).toBe(true);
    expect(entry.dir).toBe(join(root, 'linked-skill'));
  });

  it('断链的软链照旧入列一行「缺 SKILL.md」（链接坏了要看得出来，不是静默消失）', () => {
    mkdirSync(root, { recursive: true });
    symlinkSync(join(configDir, 'not-there'), join(root, 'broken-link'));

    const entry = entryOf(scanSkills(), 'broken-link');

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

  /**
   * `disable-model-invocation: true` 是「装载但不进提示词」的陷阱格：厂商清单里会有它
   * （观测格报「已装上」），模型却看不到它。本仓的停用是**文件级不放**，故这一条不收。
   */
  it('disable-model-invocation 藏起来的技能 ⇒ ok=false + 说明「不受支持」', () => {
    seedSkill('hidden', { name: 'hidden', description: '想藏起来', 'disable-model-invocation': 'true' });
    // 值写 `false` 的等于没写：那不是「藏起来」，照旧合格
    seedSkill('shown', { name: 'shown', description: '正常', 'disable-model-invocation': 'false' });

    const hidden = entryOf(scanSkills(), 'hidden');
    expect(hidden.ok).toBe(false);
    expect(hidden.reason).toContain('disable-model-invocation');
    expect(entryOf(scanSkills(), 'shown').ok).toBe(true);
  });

  /**
   * 厂商**硬拒收**的三个旧写法键（`rejectLegacyInvocationKey`：命中即抛、那一份技能被静默丢弃）。
   * 我们的判据比它宽时就是假绿：界面「合格」+ 文件物化到位，而厂商一条都不认领。
   */
  it('旧写法键（userInvocable / modelInvocable / disableModelInvocation）⇒ ok=false + 点名正名', () => {
    seedSkill('legacy-user', { name: 'legacy-user', description: '旧写法', userInvocable: 'true' });
    seedSkill('legacy-model', { name: 'legacy-model', description: '旧写法', modelInvocable: 'false' });
    seedSkill('legacy-disable', { name: 'legacy-disable', description: '旧写法', disableModelInvocation: 'true' });
    // 正名照旧合格（厂商支持 `user-invocable` 与 `disable-model-invocation`）
    seedSkill('canonical', { name: 'canonical', description: '正名', 'user-invocable': 'true' });

    const scan = scanSkills();
    expect(entryOf(scan, 'legacy-user').ok).toBe(false);
    expect(entryOf(scan, 'legacy-user').reason).toContain('user-invocable');
    expect(entryOf(scan, 'legacy-model').ok).toBe(false);
    expect(entryOf(scan, 'legacy-model').reason).toContain('disable-model-invocation');
    expect(entryOf(scan, 'legacy-disable').ok).toBe(false);
    expect(entryOf(scan, 'canonical').ok).toBe(true);
  });

  it('没有 frontmatter 的 SKILL.md ⇒ ok=false（name 与 description 都缺）', () => {
    seedSkill('no-frontmatter', null, '# 直接就是正文\n');

    const entry = entryOf(scanSkills(), 'no-frontmatter');

    expect(entry.ok).toBe(false);
    expect(entry.reason).toContain('名称不合法');
  });

  it('坏条目一律带上绝对路径（坏条目也要能点开抽屉看路径）', () => {
    seedSkill('bad-name-2', { name: 'Bad', description: '名字不合法' });

    const entry = entryOf(scanSkills(), 'bad-name-2');

    expect(entry.dir).toBe(join(root, 'bad-name-2'));
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

describe('readSkillTree：左树那一栏', () => {
  it('根是技能名，递归列到附属文件；path 是叶子名、children 恒为数组', () => {
    seedSkill('with-refs', { name: 'with-refs', description: '带附属文件' }, '# 规则\n');
    mkdirSync(join(root, 'with-refs', 'reference'), { recursive: true });
    writeFileSync(join(root, 'with-refs', 'reference', 'API.md'), '# API\n', 'utf8');

    const tree = readSkillTree('with-refs');

    expect(tree.name).toBe('with-refs');
    expect(tree.dir).toBe(join(root, 'with-refs'));
    expect(tree.truncated).toBe(false);
    expect(tree.root.path).toBe('with-refs');
    expect(tree.root.isDirectory).toBe(true);
    expect(tree.root.children.map((node) => node.path)).toEqual(['reference', 'SKILL.md']);
    // 目录的体积是 `null`、文件是真实字节数（`null ≠ 0`：目录体积要递归求和，是另一件事）
    expect(tree.root.children[0]?.sizeBytes).toBeNull();
    expect(tree.root.children[1]?.sizeBytes).toBe(statSync(join(root, 'with-refs', 'SKILL.md')).size);
  });

  it('目录在前、同类按名字码位升序（界面不再排）', () => {
    seedSkill('order', { name: 'order', description: '排序' });
    mkdirSync(join(root, 'order', 'zzz'), { recursive: true });
    mkdirSync(join(root, 'order', 'aaa'), { recursive: true });
    writeFileSync(join(root, 'order', 'b.txt'), 'b', 'utf8');
    writeFileSync(join(root, 'order', 'a.txt'), 'a', 'utf8');

    // 两个目录在前（码位升序），随后是文件：`SKILL.md`（`S` = 0x53）排在 `a.txt` / `b.txt` 之前
    expect(readSkillTree('order').root.children.map((node) => node.path)).toEqual([
      'aaa',
      'zzz',
      'SKILL.md',
      'a.txt',
      'b.txt',
    ]);
  });

  it('表外的点文件照列（藏与不藏的边界是一张名单，不是「点开头就藏」）', () => {
    seedSkill('dotted', { name: 'dotted', description: '点文件' });
    writeFileSync(join(root, 'dotted', '.hidden'), 'x', 'utf8');

    expect(readSkillTree('dotted').root.children.map((node) => node.path)).toContain('.hidden');
  });

  it('常见噪声条目（.DS_Store / .git / node_modules）哪一层都不列，且不说「没列全」', () => {
    seedSkill('noisy', { name: 'noisy', description: '带噪声' });
    writeFileSync(join(root, 'noisy', '.DS_Store'), 'x', 'utf8');
    mkdirSync(join(root, 'noisy', '.git', 'objects'), { recursive: true });
    mkdirSync(join(root, 'noisy', 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(root, 'noisy', 'node_modules', 'left-pad', 'index.js'), '', 'utf8');
    mkdirSync(join(root, 'noisy', 'reference'), { recursive: true });
    writeFileSync(join(root, 'noisy', 'reference', '.DS_Store'), 'x', 'utf8');
    writeFileSync(join(root, 'noisy', 'reference', 'API.md'), '# API\n', 'utf8');

    const tree = readSkillTree('noisy');

    expect(tree.root.children.map((node) => node.path)).toEqual(['reference', 'SKILL.md']);
    // 子树里也拦得住，同层其余文件照旧在
    expect(tree.root.children[0]?.children.map((node) => node.path)).toEqual(['API.md']);
    // 这是「有意不列」，不是「没列全」：那一句亮了会让用户以为树读坏了
    expect(tree.truncated).toBe(false);
  });

  it('名字不合法 ⇒ INVALID_QUERY（防路径穿越的那一道门）', () => {
    expect(() => readSkillTree('../../etc')).toThrowError(ServiceError);
  });

  it('技能不在磁盘上 ⇒ NOT_FOUND + 含路径的中文原因', () => {
    try {
      readSkillTree('not-there');
      throw new Error('本该抛 NOT_FOUND');
    } catch (error) {
      expect((error as ServiceError).code).toBe('NOT_FOUND');
      expect((error as ServiceError).message).toContain(join(root, 'not-there'));
    }
  });

  it('符号链接指向技能目录**之内** ⇒ 跟（技能目录常常整条是软链）', () => {
    seedSkill('inner', { name: 'inner', description: '内部软链' });
    mkdirSync(join(root, 'inner', 'real'), { recursive: true });
    writeFileSync(join(root, 'inner', 'real', 'x.md'), '# x\n', 'utf8');
    symlinkSync(join(root, 'inner', 'real'), join(root, 'inner', 'alias'));

    const tree = readSkillTree('inner');
    const alias = tree.root.children.find((node) => node.path === 'alias');

    expect(alias?.isDirectory).toBe(true);
    expect(alias?.children.map((node) => node.path)).toEqual(['x.md']);
    expect(tree.truncated).toBe(false);
  });

  it('符号链接指向技能目录**之外** ⇒ 不跟，并如实说「没列全」', () => {
    seedSkill('linked', { name: 'linked', description: '外部软链' });
    const outside = join(configDir, 'outside-secret.md');
    writeFileSync(outside, '# 外面\n', 'utf8');
    symlinkSync(outside, join(root, 'linked', 'escape.md'));

    const tree = readSkillTree('linked');

    expect(tree.root.children.map((node) => node.path)).not.toContain('escape.md');
    expect(tree.truncated).toBe(true);
  });

  it('深度到上限 ⇒ 截断并如实说「没列全」（不静默少列）', () => {
    seedSkill('deep', { name: 'deep', description: '深目录' });
    // 造一条比深度上限更深的链
    mkdirSync(join(root, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g'), { recursive: true });

    expect(readSkillTree('deep').truncated).toBe(true);
  });
});

describe('readSkillFileText：预览那一栏', () => {
  it('返回技能内路径与整份原文（不切 frontmatter）', () => {
    seedSkill('tang-poem-meal', { name: 'tang-poem-meal', description: '推荐唐诗' }, '# 规则\n');

    const file = readSkillFileText('tang-poem-meal', 'SKILL.md');

    expect(file.path).toBe('SKILL.md');
    // 围栏也在原文里（界面按 markdown 渲染整份文件）
    expect(file.text).toContain('name: tang-poem-meal');
    expect(file.text).toContain('# 规则');
  });

  it('附属文件也读得出来（树上有它就要能看）', () => {
    seedSkill('with-refs', { name: 'with-refs', description: '带附属文件' });
    mkdirSync(join(root, 'with-refs', 'reference'), { recursive: true });
    writeFileSync(join(root, 'with-refs', 'reference', 'API.md'), '# API\n', 'utf8');

    expect(readSkillFileText('with-refs', 'reference/API.md').text).toBe('# API\n');
  });

  it('名字不合法 / 路径穿越 / 绝对路径 / 空段 ⇒ INVALID_QUERY（两道门各自成立）', () => {
    seedSkill('ok-skill', { name: 'ok-skill', description: '正常' });

    expect(() => readSkillFileText('../../etc', 'SKILL.md')).toThrowError(ServiceError);
    for (const path of ['../config.json', '/etc/passwd', 'a//b', 'a/./b']) {
      expect(() => readSkillFileText('ok-skill', path), `${path} 应被拒`).toThrowError(ServiceError);
    }
    try {
      readSkillFileText('ok-skill', '../config.json');
      throw new Error('本该抛 INVALID_QUERY');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
    }
  });

  it('软链指到技能目录之外 ⇒ INVALID_QUERY（`realpath` 复核那一层）', () => {
    seedSkill('linked', { name: 'linked', description: '外部软链' });
    const outside = join(configDir, 'outside.md');
    writeFileSync(outside, '秘密', 'utf8');
    symlinkSync(outside, join(root, 'linked', 'escape.md'));

    try {
      readSkillFileText('linked', 'escape.md');
      throw new Error('本该抛 INVALID_QUERY');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
      expect((error as ServiceError).message).toContain('越出');
    }
  });

  it('文件不在 ⇒ NOT_FOUND；是目录 ⇒ INVALID_QUERY + 中文原因（两句话分开）', () => {
    seedSkill('dir-skill', { name: 'dir-skill', description: '有子目录' });
    mkdirSync(join(root, 'dir-skill', 'sub'), { recursive: true });

    try {
      readSkillFileText('dir-skill', 'nope.md');
      throw new Error('本该抛 NOT_FOUND');
    } catch (error) {
      expect((error as ServiceError).code).toBe('NOT_FOUND');
    }
    try {
      readSkillFileText('dir-skill', 'sub');
      throw new Error('本该抛 INVALID_QUERY');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
      expect((error as ServiceError).message).toContain('目录');
    }
  });

  it('二进制 ⇒ INVALID_QUERY +「不预览」+ 字节数（不给乱码正文）', () => {
    seedSkill('bin-skill', { name: 'bin-skill', description: '有二进制' });
    // 非法 UTF-8 字节：解码后会出现替换字符 U+FFFD，那一格就是「这不是文本」的判据
    writeFileSync(join(root, 'bin-skill', 'blob.bin'), Buffer.from([0x80, 0x81]));

    try {
      readSkillFileText('bin-skill', 'blob.bin');
      throw new Error('本该抛 INVALID_QUERY');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
      expect((error as ServiceError).message).toContain('不预览');
      expect((error as ServiceError).message).toContain('2 B');
    }
  });

  it('超过预览上限 ⇒ INVALID_QUERY +「超过预览上限」（与「装得上」那条上限不是一回事）', () => {
    seedSkill('big-skill', { name: 'big-skill', description: '有大文件' });
    writeFileSync(join(root, 'big-skill', 'big.md'), 'x'.repeat(SKILL_PREVIEW_MAX_BYTES + 1), 'utf8');

    try {
      readSkillFileText('big-skill', 'big.md');
      throw new Error('本该抛 INVALID_QUERY');
    } catch (error) {
      expect((error as ServiceError).code).toBe('INVALID_QUERY');
      expect((error as ServiceError).message).toContain('超过预览上限');
    }
  });
});
