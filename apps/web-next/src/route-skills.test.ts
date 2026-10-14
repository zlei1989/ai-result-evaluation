// @vitest-environment node
/**
 * 路由层端到端：`GET /api/skills`、`GET /api/skills/<name>/tree`、`GET /api/skills/<name>/file`。
 *
 * 四条只有真路由才钉得住的事实：
 *   1. **读失败必须打到 500**（而「目录不存在」是 200 + 一条根级 warning）。两者在服务函数里
 *      只差一个 try/catch，但界面上是「一条红色说明」与「还没有技能」的区别——后者是假结论；
 *   2. 动态段的名字走的是**契约的 `SkillNameSchema`**（同一份 zod）：非法名 400 而不是 500，
 *      `..` 这类路径穿越在进文件系统之前就被拦下；
 *   3. **技能内路径的两道门**：绝对路径 / `..` / 空段在路由这一层被 `SkillFilePathSchema` 拒掉，
 *      core 再用 `realpath` 复核真实路径没越出技能目录——两道各自独立成立；
 *   4. 这一份用了 `@/src/server-context` 别名，顺带守住 `vitest.config.ts` 里那份 `resolve.alias`
 *      （vitest 不读 tsconfig 的 `paths`，缺了它在收集阶段就失败）。
 *
 * 配置目录一律指向 `mkdtempSync` 出来的临时目录，并在 `afterEach` 复位——绝不碰真实 `~/.aieval`。
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, type SkillFileText, type SkillList, type SkillTree } from '@aieval/contracts';
import { getSkillsRoot, loadConfig, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { GET as getSkillFile } from '@/app/api/skills/[name]/file/route';
import { GET as getSkillTree } from '@/app/api/skills/[name]/tree/route';
import { GET as getSkills } from '@/app/api/skills/route';
import { removeTreeWithRetry } from './testing/cleanup';

let configDir: string;
let root: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'aieval-route-skills-'));
  setConfigDirForTesting(configDir);
  root = getSkillsRoot();
});

afterEach(() => {
  setConfigDirForTesting(null);
  removeTreeWithRetry(configDir);
});

/** 造一条合格 skill；`body` 里刻意带上 markdown 与原始 HTML（抽屉要按原样渲染） */
function seedSkill(name: string, body = '# 规则\n\n只推荐一首。\n'): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: 一件技能\n---\n${body}`, 'utf8');
}

/** 停用名单直接落盘（界面那条写路径是另一张票的事） */
function seedDisabled(entries: Record<string, { disabled: true }>): void {
  saveConfig({ ...loadConfig(), settings: { ...SETTINGS_DEFAULTS, skills: { entries } } });
}

/**
 * 动态段那两条路由的入参：与 Next 交给路由的形状一致（`params` 是 Promise，且 **URL 已解码**——
 * 解码是 Next 的事，路由拿到的是原始名字，故这里直接喂原始值，不要自己再 encode 一次）。
 * 技能内路径走 query：`URL` 的 query 不做路径规范化，`..` 能原样送到路由手上。
 */
function treeCall(name: string): [Request, { params: Promise<{ name: string }> }] {
  return [new Request(`http://localhost/api/skills/${name}/tree`), { params: Promise.resolve({ name }) }];
}

function fileCall(name: string, path: string | null): [Request, { params: Promise<{ name: string }> }] {
  const url = new URL(`http://localhost/api/skills/${name}/file`);
  if (path !== null) url.searchParams.set('path', path);
  return [new Request(url), { params: Promise.resolve({ name }) }];
}

describe('GET /api/skills', () => {
  it('200：按名字码位升序、坏条目在列、每条恒给 disabled', async () => {
    seedSkill('zulu');
    seedSkill('alpha');
    // 缺 SKILL.md 的目录：照旧一行，带中文原因
    mkdirSync(join(root, 'broken'), { recursive: true });
    seedDisabled({ zulu: { disabled: true } });

    const res = await getSkills();
    const list = (await res.json()) as SkillList;

    expect(res.status).toBe(200);
    expect(list.root).toBe(root);
    expect(list.skills.map((skill) => skill.name)).toEqual(['alpha', 'broken', 'zulu']);
    expect(list.skills.map((skill) => skill.disabled)).toEqual([false, false, true]);
    expect(list.skills[1]?.ok).toBe(false);
    expect(list.skills[1]?.reason).toContain('SKILL.md');
    expect(list.skillWarnings).toEqual([]);
  });

  it('目录不存在 ⇒ 200 + 空列表 + 一条根级 warning（不是错误）', async () => {
    const res = await getSkills();
    const list = (await res.json()) as SkillList;

    expect(res.status).toBe(200);
    expect(list.skills).toEqual([]);
    expect(list.skillWarnings[0]?.reason).toContain('还不存在');
  });

  /**
   * **读失败 ⇒ 500**。判据取「技能根存在、但它是个文件」：`readdir` 抛 ENOTDIR，
   * 服务端折成含路径的中文 INTERNAL。界面据此渲染错误说明，而不是「还没有技能」——
   * 少了这条断言，把读失败也 return 成空列表的改法可以全绿。
   */
  it('读失败 ⇒ 500，错误里带路径与中文原因（不许冒充空列表）', async () => {
    writeFileSync(root, 'not a directory', 'utf8');

    const res = await getSkills();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.message).toContain(root);
  });
});

describe('GET /api/skills/<name>/tree', () => {
  it('200：根是技能名，递归列到附属文件；path 是叶子名、children 恒为数组', async () => {
    seedSkill('with-refs', '## 规则\n');
    mkdirSync(join(root, 'with-refs', 'reference'), { recursive: true });
    writeFileSync(join(root, 'with-refs', 'reference', 'API.md'), '# API\n', 'utf8');

    const res = await getSkillTree(...treeCall('with-refs'));
    const tree = (await res.json()) as SkillTree;
    const [reference, skillMd] = tree.root.children;

    expect(res.status).toBe(200);
    expect(tree.name).toBe('with-refs');
    expect(tree.dir).toBe(join(root, 'with-refs'));
    expect(tree.truncated).toBe(false);
    expect(tree.root.path).toBe('with-refs');
    // 目录在前、同类按名字码位升序
    expect(tree.root.children.map((node) => node.path)).toEqual(['reference', 'SKILL.md']);
    expect(reference?.isDirectory).toBe(true);
    expect(reference?.children.map((node) => node.path)).toEqual(['API.md']);
    // 单个文件的字节数；目录为 null（目录体积要递归求和，是另一件事）
    expect(skillMd?.sizeBytes).toBe(statSync(join(root, 'with-refs', 'SKILL.md')).size);
    expect(reference?.sizeBytes).toBeNull();
    expect(reference?.children[0]?.sizeBytes).toBe(statSync(join(root, 'with-refs', 'reference', 'API.md')).size);
  });

  it('名字不合法 ⇒ 400 INVALID_QUERY（路径穿越在进文件系统之前被拦下）', async () => {
    for (const name of ['..', '../config', 'Bad_Name']) {
      const res = await getSkillTree(...treeCall(name));

      expect(res.status, `${name} 应被拒`).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_QUERY');
    }
  });

  it('这条技能不在磁盘上 ⇒ 404 NOT_FOUND + 含路径的中文原因', async () => {
    const res = await getSkillTree(...treeCall('not-there'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain(join(root, 'not-there'));
  });
});

describe('GET /api/skills/<name>/file', () => {
  it('200：技能内相对路径 + 整份原文（不切 frontmatter）', async () => {
    seedSkill('tang-poem-meal', '## 规则\n\n**只推荐一首**。\n');

    const res = await getSkillFile(...fileCall('tang-poem-meal', 'SKILL.md'));
    const file = (await res.json()) as SkillFileText;

    expect(res.status).toBe(200);
    expect(file.path).toBe('SKILL.md');
    // 整份文件的原样：frontmatter 的围栏也在里面（界面按 markdown 渲染它）
    expect(file.text).toBe(
      '---\nname: tang-poem-meal\ndescription: 一件技能\n---\n## 规则\n\n**只推荐一首**。\n',
    );
  });

  it('附属文件也读得出来（树上有它就要能看）', async () => {
    seedSkill('with-refs');
    mkdirSync(join(root, 'with-refs', 'reference'), { recursive: true });
    writeFileSync(join(root, 'with-refs', 'reference', 'API.md'), '# API\n', 'utf8');

    const res = await getSkillFile(...fileCall('with-refs', 'reference/API.md'));

    expect(res.status).toBe(200);
    expect(((await res.json()) as SkillFileText).text).toBe('# API\n');
  });

  it('缺 path ⇒ 400 + 中文原因（这句会直接显示在预览格里）', async () => {
    seedSkill('tang-poem-meal');

    const res = await getSkillFile(...fileCall('tang-poem-meal', null));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toContain('path');
  });

  it('路径穿越 / 绝对路径 / 空段 / 太深 ⇒ 400（契约那道门）', async () => {
    seedSkill('tang-poem-meal');
    const traversals = ['../config.json', '/etc/passwd', 'a//b', 'a/./b', 'a/b/c/d/e/f/g/h'];

    for (const path of traversals) {
      const res = await getSkillFile(...fileCall('tang-poem-meal', path));

      expect(res.status, `${path} 应被拒`).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_QUERY');
    }
  });

  it('是目录 ⇒ 400；文件不在 ⇒ 404（两种「点开了却没有正文」分开说）', async () => {
    seedSkill('with-refs');
    mkdirSync(join(root, 'with-refs', 'reference'), { recursive: true });

    const asDirectory = await getSkillFile(...fileCall('with-refs', 'reference'));
    const missing = await getSkillFile(...fileCall('with-refs', 'reference/nope.md'));

    expect(asDirectory.status).toBe(400);
    expect((await asDirectory.json()).error.message).toContain('目录');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.message).toContain(join(root, 'with-refs', 'reference', 'nope.md'));
  });

  it('二进制文件 ⇒ 400 + 「这一类不预览」+ 字节数（不给乱码正文）', async () => {
    seedSkill('with-refs');
    // 一段非法 UTF-8 字节：0x80 0x81 —— `readFileSync(..., 'utf8')` 会把它们换成替换字符
    writeFileSync(join(root, 'with-refs', 'blob.bin'), Buffer.from([0x80, 0x81, 0x82]));

    const res = await getSkillFile(...fileCall('with-refs', 'blob.bin'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_QUERY');
    expect(body.error.message).toContain('不预览');
    expect(body.error.message).toContain('3 B');
  });
});
