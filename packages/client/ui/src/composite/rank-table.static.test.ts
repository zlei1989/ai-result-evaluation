// @vitest-environment node
/**
 * 排名表的**源码形态**守卫（静态扫描：本目录既有手法，见 `case-form-panel.static.test.ts`）。
 *
 * 五条判据都是「行为测试测不到、而缺了会静默失效」的：
 *   ① **首列的锁靠三处同时在场**：`fixed: 'left'` + 显式的 `width` + `scroll.x` 是**数值**。
 *      jsdom 读不到 `position: sticky`（吸边效果量不出来），而宽度不给时 rc-table 算不出吸边偏移
 *      ——`provider-table.tsx` 的文件头把这条写成口径，这里把它钉在源码上：删掉 `width`、
 *      把 `fixed` 挪到别的列、或把 `scroll.x` 换成 `true` / `'max-content'`，三种改法都会让这一列
 *      在真机上「看着正常但不钉」，且没有任何用例会红；
 *   ② **滚动条那一条由 antd 自己的语义槽给**（`styles.content.paddingBottom`）：这根滚动条是原生
 *      浮层、落点是滚动容器自己的底边，不留位置它就压在最后一行「总分」上（9 候选实测）。
 *      三条都只有真机量得出来：不给内边距 ⇒ 压住总分；自己去改全局 CSS / 算高度 ⇒ 多出跨包契约
 *      与一处会漂移的字面量；给 `scroll.y` ⇒ 表体的 `overflow-y` 被写死成 `scroll`，
 *      两三行时右侧也常驻一条空滚动条（`base/table-scroll-area.tsx` 文件头的实测）；
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
  it('首列 fixed 锁左，且**显式给宽度**（不给宽度，rc-table 的吸边偏移就算不出来）', () => {
    // `fixed: 'left'` 与 `width: RANK_LABEL_WIDTH` 必须落在**同一个列定义**里：
    // 中间不许出现 `}` 收掉对象，也不许跨过另一列（写散到别的列上不算数）
    expect(source, '标签列的列定义里少了 fixed 或 width').toMatch(
      /key: 'label'[\s\S]{0,400}?width: RANK_LABEL_WIDTH,[\s\S]{0,200}?fixed: 'left'/,
    );
  });

  it('不渲染表头：列头本来就是空的（名次落在「选手」行里），留一行空白只占高度', () => {
    expect(source, '表格必须显式关掉表头（showHeader={false}）').toMatch(/showHeader=\{false\}/);
    // 与「列头留空」是一条口径的两面：给了表头就必须有内容，而这张表的列头没有内容可放
    expect(source, '表格里不该再出现列头文案（title）').not.toMatch(/\btitle:\s*'/);
  });

  it('组名行不许横跨候选列：它必须留在锁列里（横跨 = 跟着横向滚动滑走）', () => {
    // 组名行的判据是「标签列的 onCell 不给 colSpan」：给了就会铺满整行、跟着滚走
    expect(source, '组名行又铺满整行了：横向滚动时分类名会滑出视野').not.toMatch(/colSpan:\s*columnCount/);
    // 候选列也不该再有「让位给铺满」的 colSpan: 0
    expect(source, '候选列还在为铺满的组名行让位（colSpan: 0）').not.toMatch(/colSpan:\s*0/);
  });

  it('标签列不截断：长目标折行显示（截断会让「这一项要做什么」看不见）', () => {
    // 标签格必须能折行（中文与长串没有词边界 ⇒ break-word / break-all 之一）
    expect(source, '标签格少了折行样式').toMatch(/wordBreak:\s*'break-(word|all)'/);
    // `ellipsis: true` 会把目标截成一行加浮层 ⇒ 目标原文在这个表里就看不全了
    expect(source, '标签列不许开 ellipsis').not.toMatch(/ellipsis:\s*true/);
  });

  it('`scroll.x` 是**具名函数算出来的数值**，不是 true / max-content（那两个取值会让固定列失效）', () => {
    expect(source, 'scroll.x 必须走 rankTableMinWidth(...)（给 true / max-content 固定列会失效）').toMatch(
      /scroll=\{\{\s*x:\s*rankTableMinWidth\(/,
    );
    expect(source, 'scroll.x 不许写成 true / max-content').not.toMatch(/scroll=\{\{\s*x:\s*(true|'max-content')/);
    // 求和式本身：标签列 + 每候选一列（两个常量，没有裸数字）
    expect(rankTableMinWidth(0)).toBe(RANK_LABEL_WIDTH);
    expect(rankTableMinWidth(2)).toBe(RANK_LABEL_WIDTH + 2 * RANK_CANDIDATE_WIDTH);
  });

  it('滚动条那一条走 antd 自己的语义槽（不写全局 CSS、不自己算高度、不许 scroll.y）', () => {
    // 落点必须是 `styles.content`（表格自己的横向滚动容器）：写在根节点上无效——它的下内边距
    // 不属于滚动容器的可滚动区，内容与滚动条都不会挪
    expect(source, '表格没有用 styles.content 给滚动条留位置').toMatch(
      /<Table<RankTableRow>[\s\S]{0,800}?styles=\{\{ content: \{ paddingBottom: RANK_SCROLLBAR_GUTTER \} \}\}/,
    );
    expect(RANK_SCROLLBAR_GUTTER, '滚动条那一条至少要有浏览器的 15px 高').toBeGreaterThanOrEqual(15);
    // `scroll={{ y }}` 会写死 `.ant-table-body` 的 overflow-y，空表也常驻滚动条（外层原语文件头的坑）
    expect(source, '不许给 scroll.y：纵向滚动由抽屉正文承担').not.toMatch(/scroll=\{\{[^}]*\by:/);
    // `sticky` 在这个组合下什么都不渲染（实测），留着只会让人以为滚动条归它管
    expect(source, '不要再给 sticky：它在这个组合下不渲染吸底滚动条').not.toMatch(/<Table<RankTableRow>[\s\S]{0,800}?\n\s*sticky\n/);
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
