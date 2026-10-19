// @vitest-environment node
/**
 * 技能树的依赖纪律：这一面已经离开 antd / `@ant-design/x`，静态守卫钉住「别再回来」。
 *
 * 扫描面是**点名的清单**（树组件 + 它用的 vendored 原语），不是整个 composite：
 * 抽屉本身仍在用 antd 的 `Drawer`（那是抽屉那条线的票），整目录扫描会把「别处还没换」
 * 误报成「树换错了」。
 *
 * 判据覆盖四种说明符写法：静态 `from`、**裸 `import 'x'`**（会加载副作用，同样是真依赖）、
 * 动态 `import()`、`require()`。只查 `from` 会漏掉后三种——AGENTS 的边界规则也点了同一个缺口。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');

/** 技能树的扫描面：树组件自己 + 它直接引用的 vendored 原语（含搜索框那一族） */
const TREE_FILES = [
  'composite/skill-file-tree.tsx',
  'components/ui/collapsible.tsx',
  'components/ui/button.tsx',
  'components/ui/input-group.tsx',
  'components/ui/input.tsx',
  'components/ui/textarea.tsx',
] as const;

/** 去掉注释再匹配：注释里解释「为什么不 import antd」不算违规 */
function codeOf(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('技能树的依赖纪律', () => {
  it('树组件及其原语（含搜索框那一族）不出现 antd / @ant-design/* 说明符（含动态 import 与 require）', () => {
    const HIT = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](?:antd|@ant-design\/[^'"]+)['"]/;
    const hits: string[] = [];
    for (const file of TREE_FILES) {
      for (const [index, line] of codeOf(file).split('\n').entries()) {
        if (HIT.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
    expect(hits, '技能树里又有 antd 引用').toEqual([]);
  });
});
