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
 * 2026-10-08 扩口（用户口径：「标题列左悬浮」，先 `/cases` 后 `/runs`）：两张表都**必须**给
 * `scroll={{ x }}` 与标题列 `fixed: 'left'`，否则左栏被拖窄时各列只会被按比例压扁（标题是唯一
 * 吃剩余宽度的列，第一个被压成省略号）、更谈不上吸边。口径**没有放松**：那一刀仍砍在 `y` 上
 * （下面第 2 条断言，两种页面都管）；横向那一格只许钉**标题列**，钉到别的列上照红（第 4 条）。
 *
 * 为什么是读源码的文本守卫：`apps/web-next` 不能写 `.tsx` 测试（AGENTS.md 硬约束：该应用
 * `jsx: preserve`），页面这一层没有渲染测试面——与本目录另外两个 `*-page-wiring.test.ts` 同一处境。
 * 断言口径分两块，都要**抠到就断、抠不到就抛**（守卫不许静默失效）：
 *   · `<TableScrollArea> … </TableScrollArea>` 之间（表格元素与它的 props）；
 *   · `const columns: TableColumnsType<…> = [ … ];` 那一段（列定义在滚动容器**外面**，是独立变量；
 *     第一版守卫就是在这里踩了空切片，靠「抠不到就抛」当场发现）。
 * 两块之外的换行重构不会误红，而上面几种缺陷必红。「这些不变量真的落在渲染结果上」由
 * `packages/client/ui/src/base/table-scroll-area.test.tsx` 与 `provider-table.test.tsx` 各守一半，
 * 真机几何（吸边 + 吸顶同时成立）由 `docs/superpowers/notes/2026-10-08-*.md` 的冒烟记录看着。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 两个页面。列定义与列名各不相同，故四格都由这里给（抠不到就抛）：
 * `columnsAnchor` = columns 定义的起始行原文；`titleMarker` / `nextMarker` = 标题列与它后面那一列的
 * `title`（用正则字面量写，`title: '标题'` 里的单引号才不会撞 `@stylistic/quotes`）；
 * `scrollXPattern` = 「给了数值型 scroll.x」的判据，常量名写死才拦得住「改成裸数字」。
 */
const PAGES = [
  {
    name: 'runs',
    file: join(import.meta.dirname, '..', 'app', 'runs', 'page.tsx'),
    columnsAnchor: 'const columns: TableColumnsType<EvalRun> = [',
    titleMarker: /title: '标题'/,
    nextMarker: /title: '状态'/,
    scrollXPattern: /scroll=\{\{\s*x:\s*RUNS_TABLE_MIN_WIDTH\s*\}\}/,
  },
  {
    name: 'cases',
    file: join(import.meta.dirname, '..', 'app', 'cases', 'page.tsx'),
    columnsAnchor: 'const columns: TableColumnsType<TestCase> = [',
    titleMarker: /title: '标题'/,
    nextMarker: /title: '仓库'/,
    scrollXPattern: /scroll=\{\{\s*x:\s*CASES_TABLE_MIN_WIDTH\s*\}\}/,
  },
] as const;

type Page = (typeof PAGES)[number];

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

/** 抠出列表表格的 `columns` 定义区（列定义在 `<TableScrollArea>` **外面**，是独立变量）；抠不到就抛 */
function columnsSlice({ file, columnsAnchor }: Page): string {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(columnsAnchor);
  if (start < 0) throw new Error(`找不到 columns 定义（${columnsAnchor}）—— 列定义改写法了？`);
  const end = source.indexOf('\n  ];', start);
  if (end < 0) throw new Error('找不到 columns 定义的结尾');
  return source.slice(start, end);
}

/** 抠出「标题」列那一段列定义（从它的 title 到下一列的 title）；抠不到就抛 */
function titleColumnSlice(page: Page): string {
  const area = columnsSlice(page);
  const start = area.search(page.titleMarker);
  if (start < 0) throw new Error('找不到标题列的 title（列序改了？）');
  const end = area.search(page.nextMarker);
  if (end < 0) throw new Error('找不到标题列后面那一列的 title（它改名了？）');
  if (end < start) throw new Error('标题列后面那一列跑到标题列前面了（列序被换了）');
  return area.slice(start, end);
}

describe.each(PAGES)('$name 页面的列表表格滚动口径', (page) => {
  it('表格在 TableScrollArea 里面（在外面就会被栏宿主裁掉，长列表下面的行点不到）', () => {
    expect(scrollAreaSlice(page.file), '滚动容器里没有表格').toContain('<Table<');
  });

  it('表头用 sticky（不是 scroll.y）', () => {
    const area = scrollAreaSlice(page.file);

    expect(area, 'Table 少了 sticky —— 外层滚动时表头会跟着划走').toContain('sticky');
    // 唯一那一刀砍在 `y` 上：`scroll.y` 一回来，那条常驻空滚动条也就回来了（本质是 rc-table 写死 scroll）。
    // 注意 `[^}]*` 不能跨过右括号去误伤别的属性，也不能把 `scroll={{ x: … }}` 判成违规。
    expect(area, 'Table 又传了 scroll.y —— rc-table 会把 .ant-table-body 的 overflow-y 写死成 scroll').not.toMatch(
      /scroll=\{\{[^}]*\by\s*:/,
    );
  });

  it('表格给了数值型 scroll.x（左栏够不够宽的判据就是它）', () => {
    // 常量名而不是裸数字：宽度真源只有一处（每页一个 `*_TABLE_MIN_WIDTH`），改名会在这里红
    expect(scrollAreaSlice(page.file), `表格没给 scroll.x（应为 ${String(page.scrollXPattern)}）`).toMatch(
      page.scrollXPattern,
    );
  });

  it('固定列只钉标题列，且标题列确实钉在左边', () => {
    const columns = columnsSlice(page);

    expect(titleColumnSlice(page), '标题列没钉 —— 横向滚动时它跟着滑走').toMatch(/fixed: 'left'/);
    // 反向钉：只有标题列许钉（钉到别的列上会把可滚动区挤没），故 `fixed` 全表只许出现一次
    expect(columns.match(/fixed:\s*'/g) ?? [], '固定列不止一处 —— 只有标题列许钉').toHaveLength(1);
  });
});
