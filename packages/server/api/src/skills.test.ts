// @vitest-environment node
/**
 * 技能清单服务守卫：**合并**（缺省 = 开启）、排序、`skillWarnings` 透传、坏条目照旧入列。
 *
 * 这一层的存在理由只有一个：**「缺省 = 开启」这条规则只留服务端一份**。界面拿到的是
 * 「每条恒给 `disabled: boolean`」，它不做「这一格没出现是不是就等于开着」的推理——
 * 那种推理只要界面与配置文件各写一遍，就会出现「界面显示开着、注入时被跳过」这类谁也说不清的结果。
 *
 * 排序的**唯一实现**在 core（`compareSkillNames`），这里钉的是整条管道（扫盘 → 合并）的输出顺序：
 * 排序若被挪走或去掉，core 那一组先红，这一组给出「端到端顺序也变了」的证据。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS } from '@aieval/contracts';
import { getSkillsRoot, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { listSkills } from './skills';
import { removeTreeWithRetry } from './testing/cleanup';

let configDir: string;
let root: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'aieval-api-skills-'));
  setConfigDirForTesting(configDir);
  root = getSkillsRoot();
});

afterEach(() => {
  setConfigDirForTesting(null);
  removeTreeWithRetry(configDir);
});

/** 造一条合格 skill：目录名与 frontmatter 的 name 逐字相同 */
function seedSkill(name: string, description = '一件技能'): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`, 'utf8');
}

/** 把停用名单写进落盘配置（界面那条写路径还没接上，这一层先直接落盘造状态） */
function seedDisabled(entries: Record<string, { disabled: true }>): void {
  saveConfig({
    ...loadConfig(),
    settings: { ...SETTINGS_DEFAULTS, skills: { entries } },
  });
}

describe('listSkills：扫到的条目恒给 disabled 布尔', () => {
  it('没有停用名单 ⇒ 每条都是 disabled:false（缺省 = 开启，服务端算好）', () => {
    seedSkill('tang-poem-meal');

    const list = listSkills();

    expect(list.skills).toHaveLength(1);
    expect(list.skills[0]?.disabled).toBe(false);
    // 「恒给」包括 false：这一格缺席的话界面就得自己判「缺省 = 开启」，那是第二份实现
    expect(Object.keys(list.skills[0] ?? {})).toContain('disabled');
  });

  it('名单里有的那条是 disabled:true，没进的照旧 false（缺省 = 开启）', () => {
    seedSkill('disabled-one');
    seedSkill('enabled-one');
    seedDisabled({ 'disabled-one': { disabled: true } });

    const list = listSkills();

    expect(list.skills.map((skill) => [skill.name, skill.disabled])).toEqual([
      ['disabled-one', true],
      ['enabled-one', false],
    ]);
  });

  it('坏条目也能被停用：开关是用户的意图，不因当前磁盘状态而丢', () => {
    mkdirSync(join(root, 'broken'), { recursive: true });
    seedDisabled({ broken: { disabled: true } });

    const list = listSkills();

    expect(list.skills[0]?.ok).toBe(false);
    expect(list.skills[0]?.disabled).toBe(true);
  });

  it('残留条目（目录已删）保留在配置里、但不出现在列表里', () => {
    seedSkill('still-here');
    seedDisabled({ 'long-gone': { disabled: true } });

    expect(listSkills().skills.map((skill) => skill.name)).toEqual(['still-here']);
    // 保留 = 目录回来时那个开关还在：这里断言的是**没被写盘路径顺手清掉**
    expect(loadConfig().settings.skills.entries['long-gone']).toEqual({ disabled: true });
  });
});

describe('listSkills：排序与根级异常', () => {
  it('输出按 name 码位升序（乱序建目录也一样）', () => {
    seedSkill('zulu');
    seedSkill('alpha');
    seedSkill('mike');

    expect(listSkills().skills.map((skill) => skill.name)).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('缺目录 ⇒ 空列表 + 一条根级 warning 原样透传（不是错误）', () => {
    const list = listSkills();

    expect(list.skills).toEqual([]);
    expect(list.root).toBe(root);
    expect(list.skillWarnings).toEqual([{ path: root, reason: '技能目录还不存在' }]);
  });

  it('目录存在但为空 ⇒ 空列表且没有 warning（「不存在」与「空」两句不同的话）', () => {
    mkdirSync(root, { recursive: true });

    expect(listSkills()).toEqual({ root, skills: [], skillWarnings: [] });
  });

  it('技能根一路下行：空列表时界面无从反推，只能由服务端给', () => {
    expect(listSkills().root).toBe(root);
  });
});
