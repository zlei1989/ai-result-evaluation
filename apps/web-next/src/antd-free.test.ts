// @vitest-environment node
/**
 * 仓库级静态守卫：**antd 与 `@ant-design/*` 在全仓为零**——源码零说明符、包清单零依赖。
 *
 * 三条判据各有一个靶子，缺一条就有一类回潮能溜过去：
 *   ① **源码文本**扫全部 `.ts` / `.tsx`（不只 `.tsx`）：`import type { CollapseProps } from 'antd'`
 *      这种**纯类型**引用不会进运行期依赖图，`.tsx` 扫描与引用图遍历都看不见它，但它同样是一条
 *      「还在用这套件」的声明，并且会让包清单的删除显得可有可无；
 *   ② **包清单**扫 `packages/` 与 `apps/` 下的全部 `package.json`：源码清干净之后，依赖仍可能被
 *      谁「顺手加回来」——那一刻不会有任何用例变红，只有安装体积与一套并行的样式来源回来；
 *   ③ **屏上不可达**：从各屏入口沿相对 import 走完整张图，除了本仓（ui 包）以外任何一跳都不许
 *      接回 antd。只做 ①② 时，一个没人引用的残留文件也会被算进来；只做 ③ 时，预埋的下一处消费者
 *      会漏（入口没引用到它）。三条一起，才同时回答「文本还在不在」「依赖还在不在」「屏幕上还能不能连到」。
 *
 * 说明符构造用拼接：守卫自己不许命中自己（否则它永远为红，或者要给自己开白名单）。
 * 相对说明符、`@/` 别名与 `@aieval/ui` 包根都要解析：页面经包根取组件，不解析包根的话整张图在
 * 页面那一层就断了，`visited` 只剩几个页面，断言会**假绿**。其余 `@aieval/*` 是叶子：它们不渲染界面。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const UI_ROOT = join(REPO_ROOT, 'packages/client/ui/src');
const WEB_ROOT = join(REPO_ROOT, 'apps/web-next');

/** 判据只认 `antd` 整包（含子路径）与 `@ant-design/*` 作用域包 */
const ANTD_SPECIFIER = new RegExp(`^(?:ant${'d'}(?:/|$)|@ant-design/)`);

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.scratch', '.turbo']);

/** 去掉块注释与整行注释：JSDoc 里提到这套件是说明文字，不是解析请求 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * 文件里的模块说明符：静态 `import … from 'x'`、再导出 `export … from 'x'`、
 * 副作用 `import 'x'` 与动态 `import('x')` 都收。
 */
function importSpecifiers(text: string): string[] {
  const source = stripComments(text);
  const specs: string[] = [];
  for (const match of source.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) {
    if (match[1] !== undefined) specs.push(match[1]);
  }
  return [...new Set(specs)];
}

/** 递归收集某一层里的源码与包清单（跳过依赖、构建产物与取材目录） */
function collect(dir: string, accept: (name: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collect(path, accept));
    else if (accept(entry.name)) files.push(path);
  }
  return files;
}

const isSource = (name: string): boolean => name.endsWith('.ts') || name.endsWith('.tsx');

/** ① 源码里的 antd 说明符（返回 `相对路径:行号: 该行原文`） */
function sourceHits(): string[] {
  const files = [...collect(join(REPO_ROOT, 'packages'), isSource), ...collect(join(REPO_ROOT, 'apps'), isSource)];
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const specs = importSpecifiers(text);
    if (specs.length === 0) continue;
    const offending = specs.filter((spec) => ANTD_SPECIFIER.test(spec));
    if (offending.length === 0) continue;
    const code = stripComments(text).split('\n');
    for (const [index, line] of code.entries()) {
      if (offending.some((spec) => line.includes(`'${spec}'`) || line.includes(`"${spec}"`))) {
        hits.push(`${relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  return hits.sort();
}

/** ② 包清单里的 antd 依赖：`dependencies` / `devDependencies` / `peerDependencies` 三处都算 */
function manifestHits(): string[] {
  const files = [
    join(REPO_ROOT, 'package.json'),
    ...collect(join(REPO_ROOT, 'packages'), (name) => name === 'package.json'),
    ...collect(join(REPO_ROOT, 'apps'), (name) => name === 'package.json'),
  ];
  const hits: string[] = [];
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const block = manifest[field];
      if (block === undefined || block === null || typeof block !== 'object') continue;
      for (const name of Object.keys(block)) {
        if (ANTD_SPECIFIER.test(name)) hits.push(`${relative(REPO_ROOT, file)} ${field}.${name}`);
      }
    }
  }
  return hits;
}

/** 各屏入口：页面 + 根布局（布局是唯一经 `providers.tsx` 的路径） */
function screenEntries(): string[] {
  const appRoot = join(WEB_ROOT, 'app');
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'page.tsx' || entry.name === 'layout.tsx') entries.push(path);
    }
  };
  walk(appRoot);
  return entries.sort();
}

/** 解析一个说明符到真实文件；解析不到返回 null（叶子） */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith('.')) {
    candidates.push(resolve(dirname(fromFile), spec));
  } else if (spec === '@aieval/ui') {
    candidates.push(join(UI_ROOT, 'index.ts'));
  } else if (spec.startsWith('@/')) {
    candidates.push(join(WEB_ROOT, spec.slice(2)));
  } else {
    return null;
  }
  for (const base of candidates) {
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

interface GraphResult {
  violations: string[];
  visited: string[];
}

/** ③ 从各屏入口出发走完整张图：只追本仓（ui 包 + web-next）的引用，其余说明符只判不追 */
function walkFromEntries(): GraphResult {
  const violations: string[] = [];
  const visited = new Set<string>();
  const roots = screenEntries();
  const queue = roots.map((root) => ({ file: root, chain: [relative(REPO_ROOT, root)] }));

  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    if (visited.has(next.file)) continue;
    visited.add(next.file);

    for (const specifier of importSpecifiers(readFileSync(next.file, 'utf8'))) {
      if (ANTD_SPECIFIER.test(specifier)) {
        violations.push(`${relative(REPO_ROOT, next.file)}: ${specifier}\n  引用链：${[...next.chain, specifier].join(' -> ')}`);
        continue;
      }
      const resolved = resolveSpecifier(specifier, next.file);
      if (resolved === null) continue;
      // 只追本仓：ui 包与 web-next 之外（contracts / client / node_modules）都是叶子
      if (!resolved.startsWith(UI_ROOT) && !resolved.startsWith(WEB_ROOT)) continue;
      queue.push({ file: resolved, chain: [...next.chain, relative(REPO_ROOT, resolved)] });
    }
  }

  return { violations, visited: [...visited] };
}

describe('antd 与 @ant-design/* 全仓归零', () => {
  it('① 源码（含纯类型引用）里没有任何 antd 说明符', () => {
    expect(sourceHits(), '源码里又出现了 antd / @ant-design：界面原语一律走 components/ui 的 vendored 实现').toEqual([]);
  });

  it('② 包清单里没有任何 antd 依赖', () => {
    expect(manifestHits(), '包清单里又加回了 antd / @ant-design：源码已不用，依赖只会带进第二套样式来源').toEqual([]);
  });

  it('③ 从各屏入口走完整张引用图，一跳都不连到 antd', () => {
    const { violations, visited } = walkFromEntries();
    // visited 本身也是判据：解析全挂时只剩入口那几页，下面的断言会假绿
    expect(visited.length, '引用图几乎没有被走开——相对说明符 / 包根 / 别名的解析可能坏了').toBeGreaterThan(
      screenEntries().length + 5,
    );
    expect(violations, '屏上还能连到 antd：请把那一处换成 components/ui 的原语').toEqual([]);
  });
});
