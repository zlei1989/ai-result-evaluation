// @vitest-environment node
/**
 * 排名表的**源码形态**守卫（静态扫描：本目录既有手法，见 `case-form-panel.static.test.ts`）。
 *
 * 判据都是「行为测试测不到、而缺了会静默失效」的：
 *   ① **首列的锁靠「声明宽度 + pinned」**：`size: RANK_LABEL_WIDTH` 与 `pinned: 'start'` 必须在
 *      同一个列定义里。jsdom 读不到 `position: sticky`（吸边效果量不出来），而偏移输入就是声明宽度
 *      ——删掉 `size` 会被套件的运行期守卫拒掉，把 `pinned` 挪到别的列则没有任何用例会红；
 *   ② **滚动条留位**（`scrollStyle.paddingBottom`）：这根滚动条是原生浮层、落点是滚动容器自己的
 *      底边，不留位置它就压在最后一行「总分」上；
 *   ③ **判据说明与 `compareRows` 同源**：那句话由 `RANK_CRITERIA_PARTS` 拼装，三段分别对应
 *      总分 / 耗时 / token 三级判据。散写成一句字面量时，`compareRows` 改了判据说明不会跟着改
 *      ——界面照常显示，只是在说一件不再成立的事。
 *
 * 判据只吃 `rank-table.tsx` 这一段源码：行为与结构断言在 `rank-table.test.tsx` 里。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RANK_CRITERIA_PARTS,
  RANK_CANDIDATE_WIDTH,
  RANK_LABEL_WIDTH,
  RANK_SCROLLBAR_GUTTER,
  rankTableMinWidth,
} from './rank-table';

const source = readFileSync(join(import.meta.dirname, 'rank-table.tsx'), 'utf8');

describe('排名表的锁列结构', () => {
  it('首列 pinned 锁左，且**显式给宽度**（偏移输入就是声明的 size）', () => {
    // `size: RANK_LABEL_WIDTH` 与 `pinned: 'start'` 必须落在**同一个列定义**里：
    // 中间不许出现 `}` 收掉对象，也不许跨过另一列（写散到别的列上不算数）
    expect(source, '标签列的列定义里少了 size 或 pinned').toMatch(
      /id: 'label'[\s\S]{0,400}?size: RANK_LABEL_WIDTH,[\s\S]{0,200}?pinned: 'start'/,
    );
    // 候选列同样逐列声明宽度（表宽 = 标签列 + 每候选一列）
    expect(source, '候选列没有声明宽度').toMatch(/size: RANK_CANDIDATE_WIDTH/);
  });

  it('不渲染表头：列头本来就是空的（名次落在「选手」行里），留一行空白只占高度', () => {
    expect(source, '表格必须显式关掉表头（showHeader={false}）').toMatch(/showHeader=\{false\}/);
  });

  it('组名行不许横跨候选列：它必须留在锁列里（横跨 = 跟着横向滚动滑走）', () => {
    expect(source, '组名行又铺满整行了：横向滚动时分类名会滑出视野').not.toMatch(/colSpan:\s*columnCount/);
    expect(source, '候选列还在为铺满的组名行让位（colSpan: 0）').not.toMatch(/colSpan:\s*0/);
  });

  it('标签列不截断：长目标折行显示（截断会让「这一项要做什么」看不见）', () => {
    // 标签格必须能折行（中文与长串没有词边界 ⇒ break-word / break-all 之一）
    expect(source, '标签格少了折行样式').toMatch(/wordBreak:\s*'break-(word|all)'/);
    // 套件没有 ellipsis 开关；这条防的是有人给标签格套 `truncate`
    expect(source, '标签列不许截断').not.toMatch(/truncate/);
  });

  it('列宽由具名常量算出来（没有裸数字，也没有 max-content）', () => {
    expect(rankTableMinWidth(0)).toBe(RANK_LABEL_WIDTH);
    expect(rankTableMinWidth(2)).toBe(RANK_LABEL_WIDTH + 2 * RANK_CANDIDATE_WIDTH);
    expect(source, '不许把列宽写成 max-content / auto').not.toMatch(/max-content/);
  });

  it('给横向滚动条留一条下内边距（不留位置就压在最后一行「总分」上）', () => {
    expect(source, '滚动容器没有给滚动条留位置').toMatch(
      /<DataTable<RankTableRow>[\s\S]{0,900}?scrollStyle=\{\{ paddingBottom: RANK_SCROLLBAR_GUTTER \}\}/,
    );
    expect(RANK_SCROLLBAR_GUTTER, '滚动条那一条至少要有浏览器的 15px 高').toBeGreaterThanOrEqual(15);
    // 不许回到 `scroll={{ y }}` 那种固定表体高度：空表也会常驻滚动条
    expect(source, '不许给固定表体高度').not.toMatch(/scroll=\{\{[^}]*\by:/);
  });
});

describe('判据说明的单一落点', () => {
  it('说明由具名片段拼装（散写成一句字面量时，改判据就会漏改说明）', () => {
    // 拼装在源码里看得见：正文必须由数组拼出来
    expect(source, '判定说明不能是散写的字面量，必须由 RANK_CRITERIA_PARTS 拼装').toMatch(
      /RANK_CRITERIA_TEXT = `\$\{RANK_CRITERIA_PARTS\.join/,
    );
    // 片段顺序就是说明的读法：总分 → 耗时 → tok（三级判据的先后），空数组会让「拼装」名存实亡
    expect(RANK_CRITERIA_PARTS.length, '判据片段不能是空的').toBeGreaterThan(0);
  });
});
