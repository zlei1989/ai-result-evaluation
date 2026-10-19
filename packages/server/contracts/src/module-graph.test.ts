// @vitest-environment node
/**
 * `contracts` 的模块图必须是**无环**的（守卫）。
 *
 * 要挡的缺陷：`import` 成环。环形依赖在 ESM 里不一定当场炸——**取决于评估入口**：
 * 环上某个模块若先被别的路径初始化过，环就悄悄成立；而从包根进来时它会撞 TDZ
 * （`ReferenceError: Cannot access 'X' before initialization`）。
 *
 * 为什么其余门禁都拦不住：
 *   · `tsc` 只看类型，不看评估顺序；
 *   · 每个用例文件只 import 自己需要的模块，**几乎没有人 import 包根**，于是环总有一头
 *     已经被别的路径填好，永远踩不到；
 *   · 症状只在真正的消费方那里出现——最典型是 `pnpm dev`：进程起来就退，任何页面都打不开。
 *
 * 所以判据必须是**静态**的（不依赖运行时是否恰好踩中）：把 `src/*.ts`（不含用例）的相对
 * `import` 组成有向图，找出环并打印完整路径。成环即红，报错里直接给出可点的环。
 *
 * 断环的做法是**下沉**：环上被多处共用的那份值域挪进只依赖第三方的叶子模块，两边都从叶子取
 * （`checkpoint-void.ts` 与 `row-vocab.ts` 就是这么来的）。**别用 `z.lazy` 之类绕**——
 * 那只是把炸点推迟到运行期。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;
const SPECIFIER = /from '\.\/([A-Za-z0-9._-]+)'/g;

/** 相对 import 的图（只收包内 `.ts`，用例文件是叶子、不参与） */
function buildGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const text = readFileSync(join(SRC, name), 'utf8');
    const deps = [...text.matchAll(SPECIFIER)].map((m) => m[1]?.replace(/\.ts$/, '') ?? '');
    graph.set(name.replace(/\.ts$/, ''), [...new Set(deps)].filter((dep) => dep !== ''));
  }
  return graph;
}

describe('contracts 的模块图无环', () => {
  it('不存在环形 import（成环会在包根评估时撞 TDZ，且只有真机才看得见）', () => {
    const graph = buildGraph();
    expect(graph.size, '一个模块都没扫到，守卫已失效').toBeGreaterThan(10);

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const found: string[][] = [];

    const visit = (node: string, stack: string[]): void => {
      color.set(node, GRAY);
      stack.push(node);
      for (const next of graph.get(node) ?? []) {
        if (!graph.has(next)) continue;
        if (color.get(next) === GRAY) found.push([...stack.slice(stack.indexOf(next)), next]);
        else if ((color.get(next) ?? WHITE) === WHITE) visit(next, stack);
      }
      stack.pop();
      color.set(node, BLACK);
    };
    for (const node of graph.keys()) if ((color.get(node) ?? WHITE) === WHITE) visit(node, []);

    expect(found, `发现 ${found.length} 个环：${found.map((c) => c.join(' → ')).join('；')}`).toEqual([]);
  });
});
