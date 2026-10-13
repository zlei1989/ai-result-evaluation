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
import { capabilityProofGroups, interactionProofGroups } from './kit';

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
 *
 * 键认「带引号」与「裸标识符」两种写法，且裸键允许连字符（`structured-output` 就是那样写的）：
 * 只认 `\w+` 时带连字符的格会被静默丢掉，而丢掉的表现是「明明登记了却仍报没有安排」——
 * 判据把实情读反。
 */
function inlineStringMapAt(source: string, key: string): Record<string, string> {
  const at = new RegExp(`\\b${key}\\s*:`).exec(source)?.index ?? -1;
  if (at === -1) return {};
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  if (open === -1 || close === -1) return {};
  return entriesOf(source.slice(open + 1, close));
}

/**
 * 读一段对象字面量**体内**的「键 → 单引号字符串」条目。
 *
 * 键认「带引号」与「裸标识符」两种写法，且裸键允许连字符（`structured-output` 就是那样写的）：
 * 只认 `\w+` 时带连字符的格会被静默丢掉，而丢掉的表现是「明明登记了却仍报没有安排」——
 * 判据把实情读反。
 */
function entriesOf(body: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const matched of body.matchAll(/'([\w-]+)'\s*:\s*'([^']+)'|([\w-]+)\s*:\s*'([^']+)'/g)) {
    const cell = matched[1] ?? matched[3];
    const value = matched[2] ?? matched[4];
    if (cell === undefined || value === undefined) continue;
    map[cell] = value;
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
      // 消息面与交互面两张表都要过：翻一个 `yes` 要连带的那三处（能力格 / 证明场景 / 计数登记）
      // 在**声明**这一侧是同一件事——手上没有 fixture 时能判的只有「源码里点没点那个场景名」
      const declaration = getProvider(kind).metadata;
      const groups = [
        ...capabilityProofGroups(declaration.messageCapability),
        ...interactionProofGroups(declaration.interaction),
      ];
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

/**
 * **假 SDK 注入的收口**：证据文件里出现这一格，就说明它在 SDK 边界上换了假件
 * （`sdkModule` / `runtimeHooks` 是模块级的，注进去之后「我们传了什么」看得见、
 * 「厂商拿它做了什么」看不见）。这一格是**证据成不成立**的判据，不是风格问题。
 */
const FAKE_SDK_MARKER = 'setAgentRuntimeForTesting';

/**
 * 出站事实的两格 → 在证据文件里该看到的断言记号。
 *
 * 判据是**记号**而不是「断言写对了」：RHS 的正确性由各家自己的用例保证（那才是判据本体），
 * 接入守卫只能判「这一格的证据存在、且是照着真请求写的」。两格都缺 ⇒ 新家的工具面与
 * 结构化输出这一整类缺陷没有任何用例管。
 */
const OUTBOUND_FACTS = {
  mcp: 'mcp__',
  'structured-output': 'strict',
} as const;

/**
 * **出站请求真的发出去过**的记号：本地假网关的落点（`127.0.0.1:<port>`）与请求体捕获对象。
 *
 * 为什么必须从出站请求判、而不是从我们交给 SDK 的入参判：入参是**我们交出去的东西**，不是厂商
 * 发出去的那一份——白名单是成员匹配器、`strict` 由 compat 开关决定，两者都可能在我们传对之后
 * **静默失效**（`compat` 少开一格时厂商是零请求 + `stopReason: 'error'` 收场），而那一类缺陷
 * 只有请求体看得见。
 */
const OUTBOUND_REQUEST_MARKERS = ['127.0.0.1', 'localhost'] as const;

/**
 * 请求体**捕获对象**的记号：读它的用例才谈得上「从真实请求体断言」。
 *
 * 只认读**捕获结果**的那几种写法（`.body` / `requestTools` / `strictTool` / `requests[`）：
 * 裸 `requests` / `Request` 太泛（一份用例正文里出现「请求」这个词就命中），会让判据失去区分力。
 */
const REQUEST_BODY_MARKERS = ['.body', 'requestTools', 'strictTool', 'requests['] as const;

/** 取 `realOutboundEvidence: [...]` 里那几段单引号字面量（相对仓库根的路径） */
function realEvidenceOf(source: string): string[] {
  const at = /\brealOutboundEvidence\s*:/.exec(source)?.index ?? -1;
  if (at === -1) return [];
  const open = source.indexOf('[', at);
  const close = source.indexOf(']', open);
  if (open === -1 || close === -1) return [];
  return [...source.slice(open + 1, close).matchAll(/'([^']+)'/g)].flatMap((matched) =>
    matched[1] === undefined ? [] : [matched[1]],
  );
}

/**
 * 取 `realOutboundGaps: { <格>: '<仓库内路径>' }` 的映射（格 → 它在哪一层被守）。
 *
 * 用**花括号配对**截取：这一格的声明上方常有一段解释性注释，注释里的 `}` 会让「截到第一个
 * 右花括号」的读法提前收尾，于是判据读到一张空表——那一层的表现是「明明登记了却仍报没有安排」，
 * 把实情读反。
 */
function realGapsOf(source: string): Record<string, string> {
  const at = /\brealOutboundGaps\s*:/.exec(source)?.index ?? -1;
  if (at === -1) return {};
  const open = source.indexOf('{', at);
  if (open === -1) return {};
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return entriesOf(source.slice(open + 1, index));
    }
  }
  return {};
}

/**
 * 按 `it(` 切出的用例块（含标题与正文）：`setAgentRuntimeForTesting` 是**文件级**的注入表，
 * 而一个文件里常常既有装假件的用例、也有走真包的用例（pi 的 `index.test.ts` 就是那样）。
 * 判据必须落在**用例**上，否则「这个文件里有假件」会把文件里真出站的那几条一起否掉。
 */
function casesOf(source: string): string[] {
  const at = [...source.matchAll(/\bit\(/g)].map((matched) => matched.index ?? 0);
  return at.map((start, index) => source.slice(start, at[index + 1] ?? source.length));
}

/**
 * 声明里那些证据文件**真的立得住**吗：存在、有真出站的用例、且那些用例没在 SDK 边界上换假件。
 * 返回它们出现过的那几格记号（调用方据此判「两格各有证据还是登记了缺口」）。
 *
 * 「真出站的用例」判据是**读请求体**：出站事实只在协议序列化之后才存在，断言我们交给 SDK 的入参
 * 代替不了它——`options.disallowedTools` / `outputFormat` 是我们交出去的东西，而白名单是成员匹配器、
 * `strict` 由 compat 开关决定，两者都可能在传对之后**静默失效**。
 */
function assertEvidenceFiles(kind: string, declared: readonly string[]): Set<string> {
  const covered = new Set<string>();
  for (const relative of declared) {
    const file = join(repoRoot(), relative);
    expect(existsSync(file), `${kind}：声明的真出站证据文件不存在：${relative}`).toBe(true);
    const source = readFileSync(file, 'utf8');
    /**
     * 「真出站」的用例块：读请求体捕获对象，或把厂商那一端指向本地假网关。
     *
     * 块里一条记号都没有时退回**整份文件**判（捕获对象常常在 `it` 外的前置函数里定义——
     * `pi/allowlist.test.ts` 的 `runProbeRow` 就是那样）；再没有就说明这个文件根本没做出站请求。
     */
    const hasCapture = REQUEST_BODY_MARKERS.some((marker) => source.includes(marker));
    const gatewayInSource = OUTBOUND_REQUEST_MARKERS.some((marker) => source.includes(marker));
    const byBlock = casesOf(source).filter((block) => REQUEST_BODY_MARKERS.some((marker) => block.includes(marker)));
    /**
     * 捕获对象在 `it` 里 ⇒ 逐块判；捕获对象在 `it` 外的前置函数里（`pi/allowlist.test.ts` 的
     * `runProbeRow` 就是那样）⇒ 退回整份文件判，但要求这个文件真的指向了本地网关
     * （只读一份夹具、没有任何出站落点的文件在这里落空）。
     */
    const real = byBlock.length > 0 ? byBlock : hasCapture && gatewayInSource ? [source] : [];
    expect(
      real.length > 0,
      `${kind}：${relative} 里没有一条读**请求体**的用例（断言我们交给 SDK 的入参代替不了读出站请求）`,
    ).toBe(true);
    for (const block of real) {
      expect(
        block.includes(FAKE_SDK_MARKER),
        `${kind}：${relative} 里有一条读请求体的用例同时装了假 SDK（${FAKE_SDK_MARKER}）——`
        + '假件只看得见我们传进去的参数，看不见厂商拿它做了什么，「传了名单」与「名单生效」会被混为一谈',
      ).toBe(false);
    }
    for (const [cell, marker] of Object.entries(OUTBOUND_FACTS)) {
      if (real.some((block) => block.includes(marker))) covered.add(cell);
    }
  }
  return covered;
}

describe('接入守卫：真出站证据（走真包、从请求体断言工具面与结构化输出）', () => {
  for (const kind of AGENT_KINDS) {
    it(`${kind}：真出站证据立得住，且工具面与结构化输出两格各有证据或如实登记`, () => {
      const source = fixtureSourceOf(kind) ?? '';
      const declared = realEvidenceOf(source);
      const covered = assertEvidenceFiles(kind, declared);
      /**
       * 两格各自要么有证据、要么**如实登记**（与注入面 / 生命周期同一条口径）。登记不是免检：
       * 点名的文件必须真的在——写一个不存在的路径比不写更糟，那是把空转伪装成有判据。
       */
      const gaps = realGapsOf(source);
      for (const cell of Object.keys(OUTBOUND_FACTS) as Array<keyof typeof OUTBOUND_FACTS>) {
        const hasEvidence = covered.has(cell);
        const gap = gaps[cell];
        expect(
          hasEvidence || gap !== undefined,
          `${kind}：真出站证据里没有 ${cell} 这一格的事实（记号 ${OUTBOUND_FACTS[cell]}），`
          + '也没有在 realOutboundGaps 里登记它在哪一层被守——这一格没有任何用例管',
        ).toBe(true);
        if (gap === undefined) continue;
        expect(
          !hasEvidence,
          `${kind}：${cell} 已经有真出站证据，却还登记着缺口——两处只能留一处`
          + '（留旧缺口会让下一个人以为这一格没人管）',
        ).toBe(true);
        expect(existsSync(join(repoRoot(), gap)), `${kind}：${cell} 登记的守点不存在：${gap}`).toBe(true);
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
