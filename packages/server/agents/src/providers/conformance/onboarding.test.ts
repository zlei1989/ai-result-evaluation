// @vitest-environment node
/**
 * **接入守卫**：把「新家交出了一致性套件 fixture」这件事本身变成判据。
 *
 * 为什么需要这一层：套件的 12 组判据由各家自己在 `providers/<kind>/conformance.test.ts` 里
 * `import` 并调用（`describeProviderConformance`），**没有总驱动**。于是套件再严也只是自愿参加的
 * ——新家压根不写那个文件时，没有任何用例会红，「这家对不对齐」全凭接入者照抄同形。
 * 本文件判的就是「参加」本身。
 *
 * 判据两层，逐层收窄：
 *   ① **目录与注册表一致**：`providers/` 下每个 provider 目录都登记在 `AGENT_KINDS` 里，反之亦然
 *      ——加了目录没登记、或登记了没目录，都当场红；
 *   ② **每家都交 fixture 且覆盖自家声明**：`providers/<kind>/conformance.test.ts` 存在、真的调用了
 *      套件、并且能力声明里声明 `yes` 的格都有对应证明场景。判据表与套件运行时共用
 *      `capabilityProofGroups()`，两处不会各自定义一遍「覆盖」。
 *
 * **为什么「覆盖」这一层是源码扫描而不是运行期**：三家的 fixture 都在模块加载期用
 * `setAgentRuntimeForTesting` 注入各自的假厂商件（`sdkModule` / `runtimeHooks` 是**模块级**的），
 * 把三家 import 进同一个文件会让注入互相覆盖 ⇒ 总驱动拿不到真 fixture。所以这一层看的是
 * **源码里的场景名**：它判不出「场景名写了但产物是假的」，那一层由各家 fixture 的能力互钉
 * 与 `kit.test.ts` 的反例自测守。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_KINDS } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import { getProvider } from '../../registry';
import { capabilityProofGroups } from './kit';

/** `providers/` 目录：本文件住在 `providers/conformance/`，往上一层就是它 */
const PROVIDERS_DIR = join(import.meta.dirname, '..');

/** 非 provider 的子目录：套件自己 */
const SUITE_DIR = 'conformance';

/**
 * 某一家的 fixture 源码；读不到给 `null`（由用例名点出「谁没交」，
 * 而不是让 `readFileSync` 抛一个不带 kind 的 ENOENT）。
 */
function fixtureSourceOf(kind: string): string | null {
  try {
    return readFileSync(join(PROVIDERS_DIR, kind, 'conformance.test.ts'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 取 `describeProviderConformance({…})` 里 `scenarios:` 那一段源码（花括号配对截取）。
 *
 * 为什么必须限定在这一段：fixture 文件里另有一份**场景定义表**（`SCENARIOS = { 'thinking-full': … }`），
 * 拿全文去查名字会让「定义了却没提交给套件」也命中——覆盖判据随即失去区分力
 * （把提交行删掉不会有任何反应）。
 */
function scenariosBlockOf(source: string): string {
  const key = source.indexOf('scenarios:');
  if (key === -1) return '';
  const open = source.indexOf('{', key);
  if (open === -1) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return '';
}

/**
 * 源码里有没有点名这个场景。两种写法都算：带引号的字符串（`products['subagent']`、
 * 对象里写成 `'plain-reply':`）与裸键（`subagent:`——合法标识符在对象字面量里不必加引号）。
 */
function mentionsScenario(source: string, name: string): boolean {
  return source.includes(`'${name}'`) || new RegExp(`\\b${name}\\s*:`).test(source);
}

/** 仓库根：从本文件往上找到带 `pnpm-workspace.yaml` 的那一级（不数层级，挪包也不会失效） */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let step = 0; step < 12; step += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到仓库根（没有 pnpm-workspace.yaml 的祖先目录）');
}

/** 从源码里取 `injectionProof: { <格>: '<场景名>' }` 的映射（格 → 场景名） */
function injectionProofOf(source: string): Record<string, string> {
  return inlineStringMapAt(source, 'injectionProof');
}

/** 从源码里取 `injectionProofElsewhere: { <格>: '<仓库内路径>' }` 的映射（格 → 路径） */
function injectionElsewhereOf(source: string): Record<string, string> {
  return inlineStringMapAt(source, 'injectionProofElsewhere');
}

/** 从源码里取 `lifecycleElsewhere: '<仓库内路径>'` 的字面量（没有就给 `null`） */
function lifecycleElsewhereOf(source: string): string | null {
  return /lifecycleElsewhere\s*:\s*'([^']+)'/.exec(source)?.[1] ?? null;
}

/**
 * 读一个内联的「键 → 单引号字符串」对象字面量。
 *
 * 匹配必须**带冒号**（`injectionProof:`）：注释里常提到 `injectionProofElsewhere` 这个词，
 * 只认裸标识符会让解析从注释处开始、截到一段不相干的源码——判据于是静默失效。
 *
 * 只认**内联**写法（三家 fixture 都是内联的）：把映射挪进常量再引用时这条判据读不到，
 * 那时要在接入守卫里显式登记——宁可当场红一次，也不要静默放过。
 */
function inlineStringMapAt(source: string, key: string): Record<string, string> {
  const at = new RegExp(`\\b${key}\\s*:`).exec(source)?.index ?? -1;
  if (at === -1) return {};
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  if (open === -1 || close === -1) return {};
  const map: Record<string, string> = {};
  for (const matched of source.slice(open + 1, close).matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    const [, cell, value] = matched;
    if (cell !== undefined && value !== undefined) map[cell] = value;
  }
  return map;
}

describe('接入守卫：provider 目录与注册表一一对应', () => {
  it('providers/ 下每个目录都已登记，且每家都有自己的目录', () => {
    const dirs = readdirSync(PROVIDERS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name !== SUITE_DIR)
      .sort();
    // 双向比对：「加了目录没登记」与「登记了没目录」都要红，故不是子集断言
    expect(dirs, 'providers/ 下的目录与 AGENT_KINDS 不一致').toEqual([...AGENT_KINDS].sort());
  });
});

describe('接入守卫：每家都交出一致性套件 fixture', () => {
  for (const kind of AGENT_KINDS) {
    it(`${kind}：conformance.test.ts 存在且真的调用了套件`, () => {
      const source = fixtureSourceOf(kind);
      expect(source, `${kind} 没有 providers/${kind}/conformance.test.ts——一致性套件对它整份不生效`).not.toBeNull();
      expect(source, `${kind} 的 fixture 没有调用 describeProviderConformance`).toContain('describeProviderConformance(');
      expect(source, `${kind} 的 fixture 没有交 scenarios（空套件等于没参加）`).toContain('scenarios:');
    });

    it(`${kind}：fixture 覆盖自家声明为 yes 的每一格`, () => {
      const block = scenariosBlockOf(fixtureSourceOf(kind) ?? '');
      expect(block, `${kind} 的 fixture 里找不到 scenarios 块——覆盖判据无从谈起`).not.toBe('');
      const groups = capabilityProofGroups(getProvider(kind).metadata.messageCapability);
      for (const group of groups) {
        const hit = group.some((name) => mentionsScenario(block, name));
        expect(
          hit,
          `${kind} 把这组能力声明成 yes（证明场景：${group.join(' / ')}），但提交给套件的 scenarios 里一个都没有`,
        ).toBe(true);
      }
    });
  }
});

describe('接入守卫：注入面（MCP / skills）的声明必须有证明安排', () => {
  for (const kind of AGENT_KINDS) {
    it(`${kind}：声明 yes 的格有证明场景，或点名了证明在哪一层（且那一层真的存在）`, () => {
      const source = fixtureSourceOf(kind) ?? '';
      const { injection } = getProvider(kind).metadata;
      const proofs = injectionProofOf(source);
      const elsewhere = injectionElsewhereOf(source);
      for (const cell of ['mcp', 'skills'] as const) {
        if (injection[cell].state !== 'yes') continue;
        const target = elsewhere[cell];
        expect(
          proofs[cell] !== undefined || target !== undefined,
          `${kind}：注入面的 ${cell} 声明 yes，但 fixture 既没有证明场景、也没有登记它在哪一层被证明`,
        ).toBe(true);
        if (target === undefined) continue;
        // 登记不是免检：点名的文件必须真的在——写一个不存在的路径比不写更糟，
        // 那是把「空转」伪装成「有判据」，而下一个人会以为这一格有人管
        expect(existsSync(join(repoRoot(), target)), `${kind}：${cell} 登记的证明位置不存在：${target}`).toBe(true);
      }
    });
  }
});

describe('接入守卫：生命周期（释放 / 取消）必须有观测或登记', () => {
  for (const kind of AGENT_KINDS) {
    it(`${kind}：fixture 给了生命周期观测，或登记了它在哪一层（且那一层真的存在）`, () => {
      const source = fixtureSourceOf(kind) ?? '';
      const elsewhere = lifecycleElsewhereOf(source);
      expect(
        /\blifecycle\s*:/.test(source) || elsewhere !== null,
        `${kind}：fixture 既没有生命周期观测、也没有登记它在哪一层被证明——释放与取消不许静默`,
      ).toBe(true);
      if (elsewhere === null) return;
      // 登记不是免检（与注入面的登记同一条口径）：点名的文件必须真的在
      expect(existsSync(join(repoRoot(), elsewhere)), `${kind}：生命周期登记的证明位置不存在：${elsewhere}`).toBe(true);
    });
  }
});
