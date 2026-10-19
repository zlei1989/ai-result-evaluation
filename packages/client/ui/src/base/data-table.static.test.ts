// @vitest-environment node
/**
 * `DataTable` 的源码形态守卫（静态扫描，手法同 `rank-table.static.test.ts`）：
 *
 *   ① 固定列的偏移必须来自 `column.getStart('start')` / `column.getAfter('end')`，
 *      且列宽只能来自声明值（允许 `fillColumnId` 整表读一次容器 `clientWidth`，把余量加进
 *      列定义；禁止按单元格实测 `getBoundingClientRect` / `offsetWidth`——那会让偏移与声明分家）；
 *   ② 组件必须在建表前调用 `assertPinnedColumnsHaveSize`（运行期守卫的接线不能断）；
 *   ③ 扫描仓库里的列定义：任何 `pinned: 'start' | 'end'` 都必须与 `size` 写在同一个对象里；
 *   ④ 滚动容器只允许 `overflow: auto`，不许 `scroll`。
 *
 * jsdom 量不到吸边与滚动条，这四条是「删掉会静默失效」的那一半。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(import.meta.dirname, 'data-table.tsx'), 'utf8');

/** 递归收集产品源码（跳过依赖、构建产物、过程目录与测试文件；测试里的反例由运行期守卫覆盖） */
function listSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.scratch') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSources(path));
    } else if (
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      !entry.name.includes('.test.')
    ) {
      files.push(path);
    }
  }
  return files;
}

const repoRoot = join(import.meta.dirname, '../../../../..');
const scanned = [
  ...listSources(join(import.meta.dirname)),
  ...listSources(join(repoRoot, 'apps/web-next/app')),
  ...listSources(join(repoRoot, 'apps/web-next/src')),
];

describe('DataTable 固定列的源码形态', () => {
  it('偏移走 getStart/getAfter，列宽只允许「整表一次」的容器实测', () => {
    expect(source, '起始侧偏移必须走 column.getStart("start")').toMatch(/getStart\('start'\)/);
    expect(source, '结束侧偏移必须走 column.getAfter("end")').toMatch(/getAfter\('end'\)/);
    // 允许 `clientWidth`：`fillColumnId` 需要量一次滚动容器，把剩余宽度加进**列定义**
    // （随后 `getStart` / `<col>` / 单元格宽度读的都是放大后的声明值，三处仍同源）。
    // 仍然禁止按单元格实测（`getBoundingClientRect` / `offsetWidth`）——那会让偏移与声明宽度分家。
    expect(source, '列宽与偏移不许改成逐格 DOM 实测').not.toMatch(
      /getBoundingClientRect|offsetWidth/,
    );
  });

  it('建表前调用 pin 的 size 校验（运行期守卫不能被绕过）', () => {
    expect(source, '缺少 assertPinnedColumnsHaveSize(effectiveColumns)').toMatch(
      /assertPinnedColumnsHaveSize\(effectiveColumns\)/,
    );
  });

  it('扫描列定义：钉住的列必须在同一个对象里声明 size', () => {
    const violations: string[] = [];
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8');
      // 平铺的列定义对象：含 pinned 且不跨到下一个对象；嵌套对象（cell 渲染函数）不在扫描面内，
      // 运行期守卫仍是最终兜底
      for (const match of text.matchAll(/\{[^{}]*\bpinned:\s*'(?:start|end)'[^{}]*\}/g)) {
        if (!/\bsize:\s*\d+/.test(match[0])) {
          violations.push(`${file}: ${match[0].replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }
    expect(violations, '钉住的列缺 size：偏移会按默认 150px 算，固定位置静默错开').toEqual([]);
  });

  it('只引入用得到的 feature：筛选/分组/分页/展开都不在 tableFeatures 里', () => {
    // v9 是 feature 制：没列出的会被 tree-shake，列出的就进包。这六个本票没有消费方，
    // 误加不会报错，只会白背体积（而且会悄悄改变行模型的形状）。
    expect(source, '不用的 feature 被引入了').not.toMatch(
      /columnFilteringFeature|columnGroupingFeature|rowPaginationFeature|rowExpandingFeature|rowAggregationFeature|globalFilteringFeature|columnFacetingFeature/,
    );
  });

  it('滚动容器只允许 overflow auto（scroll 会在空表上留一条常驻滚动条）', () => {
    expect(source, '滚动容器必须使用 DATA_TABLE_SCROLL_STYLE').toMatch(/DATA_TABLE_SCROLL_STYLE/);
    expect(source, '不许写 overflow: scroll').not.toMatch(/overflow:\s*'scroll'/);
  });
});
