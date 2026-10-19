// @vitest-environment node
/**
 * 静态守卫：`/settings` 这一屏的**整个引用子图**里没有 antd 说明符。
 *
 * 为什么按引用链而不是按文件名列举：按名列举只能证明「我想到的那些文件干净」。
 * 这一屏的组件还会引用同包里的共享件（`../base/*`、`./mcp-probe-result` 之类），
 * 下一个被引用的文件不在名单里时，守卫照样全绿而屏幕上已经混进 antd。
 * 判据因此改成：从这一屏的入口出发，沿着相对 import 递归走完整张图，每条边都判一次说明符。
 *
 * 两个刻意的边界：
 *   · **只追 `packages/client/ui/src` 内的相对说明符**。装配侧（`apps/web-next`）的 `@/src/*`
 *     与包说明符（`@aieval/*`）是叶子：顶栏与图标属于别的票，追进去只会把守卫变成
 *     「全仓 antd 清零」。页面文件本身仍然直接扫一遍（它的直接 antd import 就是最源头的违例）。
 *   · **不追动态形式**：本仓 ESM-only，`require()` 已被 lint 与边界规则禁止；
 *     动态 `import()` 在这里一并按说明符识别，但不递归求值路径（静态解析做不到）。
 *
 * 反例的证据：给链上任一文件注入 `import { Button } from 'antd'`，这条会红并打印整条链。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const UI_ROOT = join(REPO_ROOT, 'packages/client/ui/src');

const PAGE_FILE = 'apps/web-next/app/settings/page.tsx';

/**
 * 这一屏的**入口**：页面本身（直接扫）+ 它在 ui 包里的组件根。
 * 页面经包根 `@aieval/ui` 取组件（包说明符是叶子），故组件根必须单列；
 * 一旦某个组件引用新的同包文件，那一跳会被递归追到，不需要回来改名单。
 */
const SCREEN_ROOTS = [
  PAGE_FILE,
  'packages/client/ui/src/composite/provider-table.tsx',
  'packages/client/ui/src/composite/provider-form-modal.tsx',
  'packages/client/ui/src/composite/provider-models-modal.tsx',
  'packages/client/ui/src/composite/provider-model-import-modal.tsx',
  'packages/client/ui/src/composite/mcp-server-table.tsx',
  'packages/client/ui/src/composite/mcp-server-form-modal.tsx',
  'packages/client/ui/src/composite/mcp-paste-modal.tsx',
  'packages/client/ui/src/composite/skill-table.tsx',
  'packages/client/ui/src/composite/judge-settings-card.tsx',
  'packages/client/ui/src/composite/workspace-settings-card.tsx',
  // 设置屏新抽出的三件小组件（告警 / 二次确认 / 空态）也是组件根：
  // 它们被这一屏的十来个组件共用，混进 antd 同样是「这一屏又回去了」
  'packages/client/ui/src/composite/settings-alert.tsx',
  'packages/client/ui/src/composite/confirm-dialog.tsx',
  'packages/client/ui/src/composite/settings-empty.tsx',
] as const;

/** antd 系说明符：整包与作用域包（图标）都算 */
const ANTD_SPECIFIER = /^(?:antd|@ant-design\/)/;

/** 去掉块注释与整行注释：JSDoc 里提到 antd 是说明文字，不是解析请求 */
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
  // 同一行里 `import type … from` 与上面的主正则可能重复命中；去重不影响判据
  return [...new Set(specs)];
}

/** 相对说明符 → 真实文件（补 `.ts` / `.tsx` / `index.*`），解析不到返回 null */
function resolveRelative(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

interface Violation {
  file: string;
  specifier: string;
  chain: string[];
}

/** 从入口出发的整张子图：只追 ui 包内的相对引用，其余说明符只判不追 */
function collectViolations(): { violations: Violation[]; visited: string[] } {
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const queue: { file: string; chain: string[] }[] = SCREEN_ROOTS.map((root) => ({
    file: join(REPO_ROOT, root),
    chain: [root],
  }));

  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    if (visited.has(next.file)) continue;
    visited.add(next.file);

    for (const specifier of importSpecifiers(readFileSync(next.file, 'utf8'))) {
      if (ANTD_SPECIFIER.test(specifier)) {
        violations.push({
          file: relative(REPO_ROOT, next.file),
          specifier,
          chain: [...next.chain, specifier],
        });
        continue;
      }
      const resolved = resolveRelative(specifier, next.file);
      // 只追 ui 包内部：`@/src/*`、`@aieval/*` 与 node_modules 都是叶子
      if (resolved === null || !resolved.startsWith(UI_ROOT)) continue;
      queue.push({ file: resolved, chain: [...next.chain, relative(REPO_ROOT, resolved)] });
    }
  }

  return { violations, visited: [...visited] };
}

describe('settings 屏的引用子图里 antd 说明符归零', () => {
  it('从页面与组件根出发，沿相对 import 走完整张图，没有任何 antd / @ant-design 说明符', () => {
    const { violations, visited } = collectViolations();

    const report = violations.map(
      (violation) =>
        `${violation.file}: ${violation.specifier}\n  引用链：${violation.chain.join(' -> ')}`,
    );

    // visited 的数量本身也是判据：解析全挂时 visited 只剩入口，下面的断言会假绿
    expect(visited.length, '引用图几乎没有被走开——相对 import 的解析可能坏了').toBeGreaterThan(
      SCREEN_ROOTS.length,
    );
    expect(
      report,
      '这一屏的引用链上还挂着 antd / @ant-design：请把那一处换成 @aieval/ui 从 components/ui 转出的原语',
    ).toEqual([]);
  });
});
