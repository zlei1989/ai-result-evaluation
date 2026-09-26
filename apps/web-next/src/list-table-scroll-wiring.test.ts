// @vitest-environment node
/**
 * 两个列表页（`/runs`、`/cases`）的**表格滚动口径**接线守卫。
 *
 * 要挡的缺陷（2026-09-28 用户口径：「右侧那条常驻滚动条藏起来」）：
 *   ① 把 `scroll={{ y: … }}` 加回 `Table` —— 给了它之后 rc-table 会把 `.ant-table-body` 的
 *      `overflow-y` 写死成 `scroll`（`@rc-component/table` 的 `Table.js`），数据只有两三行、
 *      毫无可滚内容时右侧也永远挂着一条空滚动条，而**没有任何用例会红**（页面照常渲染、
 *      类型照常通过）；
 *   ② 丢掉 `sticky` —— 表头不再钉住：外层容器滚动时表头跟着划走，长列表里连列名都看不到；
 *   ③ 表格落到 `TableScrollArea` 外面 —— 栏宿主的 `overflow: hidden` 会直接裁掉超出的行，
 *      下面的行点不到（`minHeight` / `float` 那类高度链问题同理，见下面 UI 组件的用例）。
 *
 * 为什么是读源码的文本守卫：`apps/web-next` 不能写 `.tsx` 测试（AGENT.md 硬约束：该应用
 * `jsx: preserve`），页面这一层没有渲染测试面——与本目录另外两个 `*-page-wiring.test.ts` 同一处境。
 * 断言口径：只扫「`<TableScrollArea> … </TableScrollArea>` 之间」这一小块，其余部分换行重构不会误红，
 * 而上面三种缺陷必红；抠不到就抛（守卫不许静默失效）。「这三条不变量真的落在渲染结果上」由
 * `packages/client/ui/src/base/table-scroll-area.test.tsx` 守，两层各守一半。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 两个页面：源码路径 + 用例里报错时用的名字 */
const PAGES = [
  { name: 'runs', file: join(import.meta.dirname, '..', 'app', 'runs', 'page.tsx') },
  { name: 'cases', file: join(import.meta.dirname, '..', 'app', 'cases', 'page.tsx') },
] as const;

/** 抠出滚动容器包住的那一段源码；任一端的标签缺失都抛，避免守卫退化成空断言 */
function scrollAreaSlice(file: string): string {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('<TableScrollArea>');
  if (start < 0) throw new Error('页面里找不到 <TableScrollArea>（列表表格必须由它接管滚动）');
  const end = source.indexOf('</TableScrollArea>');
  if (end < 0) throw new Error('找不到 </TableScrollArea>（滚动容器的闭合标签被删了？）');
  if (end < start) throw new Error('</TableScrollArea> 出现在 <TableScrollArea> 之前');
  return source.slice(start, end);
}

describe.each(PAGES)('$name 页面的列表表格滚动口径', ({ file }) => {
  it('表格在 TableScrollArea 里面（在外面就会被栏宿主裁掉，长列表下面的行点不到）', () => {
    expect(scrollAreaSlice(file), '滚动容器里没有表格').toContain('<Table<');
  });

  it('表头用 sticky（不是 scroll.y）', () => {
    const area = scrollAreaSlice(file);

    expect(area, 'Table 少了 sticky —— 外层滚动时表头会跟着划走').toContain('sticky');
    // 反过来钉：`scroll={{ y }}` 一回来，那条常驻空滚动条也就回来了（本质是 rc-table 写死 scroll）
    expect(area, 'Table 又传了 scroll —— rc-table 会把 .ant-table-body 的 overflow-y 写死成 scroll').not.toMatch(
      /scroll=\{/,
    );
  });
});
