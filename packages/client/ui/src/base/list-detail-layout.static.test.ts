// @vitest-environment node
/**
 * 静态守卫：`base/list-detail-layout.tsx` 的**整个引用子图**里没有 antd 说明符。
 *
 * 为什么按引用链而不是只扫这一个文件：本组件自己不 import antd，antd 可能藏在它引用的
 * 分栏原语、布局壳或任意共享件里——只扫文件本体会全绿，而屏幕上仍是 antd 的 Splitter。
 * 判据因此是：从入口沿相对 import 递归走完 ui 包内的每个文件，每条边都判一次说明符。
 *
 * 边界：只追 `packages/client/ui/src` 内的相对说明符；包说明符（`@aieval/*`）与 npm 包
 * （`react-resizable-panels`、`cn` 等）是叶子——它们的内部实现不归本守卫管。
 * 入口文件本身也直接判一次，它的 import 就是最源头的违例。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const ENTRY = join(import.meta.dirname, 'list-detail-layout.tsx');

/** antd 系说明符：整包与作用域包（图标）都算 */
const ANTD_SPECIFIER = /^(?:antd|@ant-design\/)/;

/** 去掉块注释与整行注释：JSDoc 里提到 antd 是说明文字，不是解析请求 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 文件里的模块说明符：静态 import / 再导出 / 副作用 import / 动态 import 都收 */
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

/** 相对说明符 → 真实文件（补 `.ts` / `.tsx` / `index.*`），解析不到返回 null */
function resolveRelative(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

describe('ListDetailLayout 的引用子图里 antd 说明符归零', () => {
  it('从 list-detail-layout.tsx 沿相对 import 走完整张图，没有 antd / @ant-design 说明符', () => {
    const violations: { file: string; specifier: string; chain: string[] }[] = [];
    const visited = new Set<string>();
    const queue: { file: string; chain: string[] }[] = [{ file: ENTRY, chain: ['base/list-detail-layout.tsx'] }];

    while (queue.length > 0) {
      const next = queue.pop();
      if (next === undefined) break;
      if (visited.has(next.file)) continue;
      visited.add(next.file);

      for (const specifier of importSpecifiers(readFileSync(next.file, 'utf8'))) {
        if (ANTD_SPECIFIER.test(specifier)) {
          violations.push({
            file: relative(SRC, next.file),
            specifier,
            chain: [...next.chain, specifier],
          });
          continue;
        }
        const resolved = resolveRelative(specifier, next.file);
        if (resolved === null || !resolved.startsWith(SRC)) continue;
        queue.push({ file: resolved, chain: [...next.chain, relative(SRC, resolved)] });
      }
    }

    // 守卫不能因为「一个文件都没走到」而空转：入口必须存在且真的被解析
    expect(visited.size, '引用链一个文件都没走到：入口路径失效').toBeGreaterThan(1);
    expect(
      violations.map((violation) => `${violation.file} → ${violation.specifier}\n  链路：${violation.chain.join(' → ')}`),
      'ListDetailLayout 的引用链里又出现了 antd',
    ).toEqual([]);
  });
});
