// @vitest-environment node
/**
 * 技能**物化**守卫：清单 → 行配置目录里那份自足的副本。
 *
 * 为什么每一条都要一条守卫（这一层全是「静默失效」型）：
 *   · **整目录复制**：只抄 `SKILL.md` 时，带 `scripts/`、`references/` 的 skill 在行内是**半条**
 *     （模型按正文里的相对路径去读附属文件，读到的是「不存在」）；
 *   · **逐条覆盖、清单外不碰**：清了 `skills/` 就会抹掉 codex 的 `.system/`（6 个内置 skill 住在同一层），
 *     而那件事**不报错**——只是内置 skill 凭空消失；
 *   · **源目录读不到 ⇒ 抛**：不抛的话这一行照跑、厂商侧静默没有这条 skill，
 *     用户看到的是一个「看起来正常」的分数（这一层最要防的假绿）；
 *   · **路径穿越**：`name` 来自扫描结果的目录名，拼进目标路径前必须过最严那道门；
 *     `..` 一旦拼进去，写入点就跑到行配置目录之外了；
 *   · **幂等**：每次 `run` 前都重放一次，两次落盘必须逐字相同（否则「同一份输入」会漂）。
 *
 * 全程只碰 `mkdtempSync` 出来的临时目录，任何真实配置目录都不会被读到。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigDirForTesting } from './config-store';
import { SkillMaterializeError, installableSkills, materializeSkills, type SkillSource } from './skill-materialize';
import { getSkillsRoot } from './skill-store';
import { removeTreeWithRetry } from './testing/cleanup';

let tempRoot: string;
let configDir: string;
let configHome: string;
let skillsRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'aieval-materialize-'));
  configDir = join(tempRoot, 'config');
  setConfigDirForTesting(configDir);
  configHome = join(tempRoot, 'row', '.agenthome');
  skillsRoot = getSkillsRoot();
});

afterEach(() => {
  setConfigDirForTesting(null);
  removeTreeWithRetry(tempRoot);
});

/** 造一条 skill：目录 + `SKILL.md` + 两个附属目录（装入必须把它们一起带过去） */
function seedSkill(name: string, description = '示例技能'): SkillSource {
  const dir = join(skillsRoot, name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`, 'utf8');
  writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
  writeFileSync(join(dir, 'references', 'notes.md'), '# 附注\n', 'utf8');
  return { name, sourceDir: dir };
}

/** 一棵目录树里每个文件的相对路径 → 内容（用来做「逐字相同」级别的比较） */
function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      files[relative(root, path).replace(/\\/g, '/')] = readFileSync(path, 'utf8');
    }
  };
  walk(root);
  return files;
}

describe('materializeSkills：整目录复制', () => {
  it('一条 skill 整目录落进 <行配置目录>/skills/<名称>，附属文件逐字相同', () => {
    const skill = seedSkill('tang-poem-meal');

    materializeSkills({ configHome, skills: [skill] });

    const installed = join(configHome, 'skills', 'tang-poem-meal');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(skill.sourceDir, 'SKILL.md'), 'utf8'));
    // 附属文件一个都不能少：只抄入口文件 = 行内是半条 skill（正文里的相对路径全指向不存在）
    expect(snapshotTree(installed)).toEqual(snapshotTree(skill.sourceDir));
  });

  it('落点全部在行配置目录之下（物化后的路径断言）', () => {
    materializeSkills({ configHome, skills: [seedSkill('alpha')] });

    const skillsDir = join(configHome, 'skills');
    for (const file of Object.keys(snapshotTree(skillsDir))) {
      expect(relative(configHome, join(skillsDir, file)).startsWith('..')).toBe(false);
    }
    expect(readdirSync(skillsDir)).toEqual(['alpha']);
  });

  it('宿主没配任何前置目录也照样建行配置目录（不是「等别人建好」）', () => {
    // configHome 此刻压根不存在：契约只说「该行独立配置目录」，没有第二个人保证它存在
    expect(() => statSync(configHome)).toThrow();

    materializeSkills({ configHome, skills: [seedSkill('alpha')] });

    expect(statSync(join(configHome, 'skills', 'alpha', 'SKILL.md')).isFile()).toBe(true);
  });
});

describe('materializeSkills：清单外不碰 + 幂等', () => {
  it('绝不整目录清空：预置的 skills/.system/x 在物化之后还在', () => {
    // codex 的 6 个内置 skill 就住在同一个 skills/ 目录下（.system/），整目录清空会静默抹掉它们
    const systemDir = join(configHome, 'skills', '.system', 'x');
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(join(systemDir, 'SKILL.md'), '内置\n', 'utf8');

    materializeSkills({ configHome, skills: [seedSkill('alpha')] });

    expect(readFileSync(join(systemDir, 'SKILL.md'), 'utf8')).toBe('内置\n');
    expect(readdirSync(join(configHome, 'skills')).sort()).toEqual(['.system', 'alpha']);
  });

  it('同一份输入两次落盘逐字相同（每次 run 前重放是幂等的）', () => {
    const skills = [seedSkill('alpha'), seedSkill('beta')];

    materializeSkills({ configHome, skills });
    const first = snapshotTree(join(configHome, 'skills'));
    materializeSkills({ configHome, skills });

    expect(snapshotTree(join(configHome, 'skills'))).toEqual(first);
  });

  it('同一行两次物化之间源目录被改过 ⇒ 行内那份跟着更新（覆盖式重放）', () => {
    const skill = seedSkill('alpha');
    materializeSkills({ configHome, skills: [skill] });
    writeFileSync(join(skill.sourceDir, 'SKILL.md'), '---\nname: alpha\ndescription: 改过了\n---\n\n新正文\n', 'utf8');

    materializeSkills({ configHome, skills: [skill] });

    expect(readFileSync(join(configHome, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('新正文');
  });
});

describe('materializeSkills：路径穿越与源目录读不到', () => {
  it('名字带 `..` ⇒ 抛错，且行配置目录之外一个文件都没写', () => {
    // 源目录**必须真的存在**：拿一个不存在的源来测穿越，这条守卫会因为「源读不到」而假绿
    // ——两条路径抛的是同一个错误类型，只有「外面真的多了一个目录」能分辨它们
    const skill = seedSkill('alpha');
    const bad: SkillSource = { name: '../evil', sourceDir: skill.sourceDir };
    // `join(<配置目录>/skills, '../evil')` 的落点：技能根之外、配置目录之内
    const outside = join(configDir, 'evil');

    expect(() => materializeSkills({ configHome, skills: [bad] })).toThrow(SkillMaterializeError);
    expect(() => statSync(outside)).toThrow();
    expect(() => statSync(join(configHome, 'skills', 'evil'))).toThrow();
  });

  it('名字是绝对路径 / 带分隔符 ⇒ 抛错（最严那道门的另外两种形状）', () => {
    for (const name of ['/tmp/evil', 'a/b', '..']) {
      expect(() => materializeSkills({ configHome, skills: [{ name, sourceDir: skillsRoot }] })).toThrow(
        SkillMaterializeError,
      );
    }
  });

  it('源目录读不到 ⇒ 抛错并点名哪一条（绝不静默跳过）', () => {
    const missing: SkillSource = { name: 'ghost', sourceDir: join(skillsRoot, 'ghost') };

    // 报错文案必须点名到条：不点名的话，多条的清单里没人知道是哪一个没装上
    expect(() => materializeSkills({ configHome, skills: [missing] })).toThrow(/ghost/);
  });

  it('源路径存在但不是技能目录（缺 SKILL.md）⇒ 抛错并点名', () => {
    const notASkill = join(skillsRoot, 'half');
    mkdirSync(notASkill, { recursive: true });

    expect(() => materializeSkills({ configHome, skills: [{ name: 'half', sourceDir: notASkill }] })).toThrow(/half/);
  });
});

describe('installableSkills：本行要装入的那一份清单', () => {
  it('停用的不进清单（停用 = 文件级「不放」，这是三家统一的停用手段）', () => {
    seedSkill('alpha');
    seedSkill('beta');

    // alpha 停用、beta 启用：装入的那一份里只有 beta（源目录路径指回技能根下那一条）
    expect(installableSkills({ alpha: { disabled: true } })).toEqual([
      { name: 'beta', sourceDir: join(skillsRoot, 'beta') },
    ]);
  });

  it('清单里只有扫描合格的那几条，且按名字码位升序（界面与装入同一份顺序）', () => {
    seedSkill('beta');
    seedSkill('alpha');
    // 半条：缺 SKILL.md（它在列表里显示成「不可用」，但装不了）
    mkdirSync(join(skillsRoot, 'broken'), { recursive: true });

    expect(installableSkills({}).map((skill) => skill.name)).toEqual(['alpha', 'beta']);
  });

  it('停用名单是「缺省 = 开启」：键不在名单里就是启用（其余值是手改坏的数据，不算停用）', () => {
    seedSkill('alpha');
    seedSkill('beta');

    // 手改 config.json 写进去的 `disabled: false` 不是停用（最严判据：只有字面量 true 才算）
    const handEdited = { alpha: { disabled: false } } as unknown as Parameters<typeof installableSkills>[0];
    expect(installableSkills(handEdited).map((skill) => skill.name)).toEqual(['alpha', 'beta']);
    // 名单整个缺席（老配置文件 / 还没放过 skill）= 全部启用，不是全部停用
    expect(installableSkills(undefined).map((skill) => skill.name)).toEqual(['alpha', 'beta']);
  });
});
