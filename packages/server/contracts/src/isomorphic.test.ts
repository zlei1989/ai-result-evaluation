// @vitest-environment node
/**
 * `@aieval/contracts` 是**同构**包：服务端与**浏览器**都要读它（界面渲染标签表、错误码文案就从这里来）。
 *
 * 因此它的源码**一个 `node:*` 内建都不能引**——顶层引一个，客户端那侧打包就直接失败
 * （`the chunking context (unknown) does not support external modules (request: node:fs)`），
 * 而 `tsc`、`eslint`、其余单测**全都看不见这一层**：它们跑在 Node 里，`node:fs` 解析得好好的。
 * 这条守卫补的就是这个盲区，判据是「源码里有没有 `node:` 说明符」，与哪个文件、什么用途无关。
 *
 * 需要文件系统 / 路径解析的能力（例如跟随软链的真实路径）**由 Node 侧的调用方注入**，
 * 不在这里 import——`classifySkillOrigin` 的 `resolveRealPath` 就是这个形状的先例。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 契约源码根（测试文件自己不受这条约束：它们只在 Node 里跑） */
const SOURCE_DIR = join(__dirname);

/** `node:` 说明符的三种出现形态：静态 import/export、动态 import()、require() */
const NODE_SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]node:[a-z/]+['"]/g;

describe('契约包是同构的：源码不许引 node 内建', () => {
  it('`src/**` 里没有任何 `node:` 说明符', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SOURCE_DIR)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const text = readFileSync(join(SOURCE_DIR, name), 'utf8');
      for (const match of text.matchAll(NODE_SPECIFIER)) offenders.push(`${name}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('守卫本身有效：把 `node:fs` 混进源码会被认出来', () => {
    // 判据的**变异验证**做在断言里：正则认不出的守卫等于没有守卫
    const probe = 'import { readFileSync } from \'node:fs\';\nconst x = require(\'node:path\');\nawait import(\'node:os\');';
    expect([...probe.matchAll(NODE_SPECIFIER)].map((m) => m[0])).toHaveLength(3);
  });
});
