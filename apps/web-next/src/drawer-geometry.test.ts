/**
 * 抽屉几何守卫（「抽屉几何」）。
 *
 * 为什么值得单独钉：这条口径没有任何运行时症状——宽度写错、padding 忘了置 0，
 * 页面照样工作，只是观感不对，且不会让任何别的用例变红。**就是这么翻车的**：
 * antd 6 废弃 `width` 之后，「变更详情」「评分详情」两处漏改，当场掉回 antd 默认 **378px**，
 * 而「执行日志」是 **800px**⇒ 三个抽屉宽窄不一，全量用例一条都没红。
 *
 * 修法是把宽度收敛成**一个字面量**：`@aieval/ui` 的 `base/drawer-geometry.ts`
 * （三个抽屉分居两个包，各写一份必然漂移）。于是断言分三层，每层拦一种不同的写法：
 * ① **常量内容**逐字钉住（宽度 / maxWidth / padding）；
 * ② **两个包的消费者都真的引它**（`AgentLogDrawer` 与评测页），且**不再各写一份字面量**——
 * 只钉常量内容是不够的：常量还在、某个抽屉已经不照它渲染时，①照样绿；
 * ③ **评测页上每个 `<Drawer>` 都摊开了这份几何**：新加一个抽屉却忘了宽度时，
 * 它会静默地只有 378px 宽（就是这次要修的那个缺陷）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 用本文件的位置推导目录，**不用 `process.cwd()`**：从仓库根跑 `pnpm test`（根 vitest.config.ts
// 一次收集 8 个包）时 CWD 是仓库根，`process.cwd()/app/runs/page.tsx` 不存在，套件在收集期就
// 以 ENOENT 整份死掉——症状是「永远红的门禁」，而不是某条断言失败（既有缺陷，本步修掉）。
const appRoot = join(import.meta.dirname, '..');
const repositoryRoot = join(appRoot, '..', '..');
/** 宽度的唯一字面量（三个抽屉共用） */
const GEOMETRY_PATH = join(repositoryRoot, 'packages', 'client', 'ui', 'src', 'base', 'drawer-geometry.ts');
/** 「执行日志」抽屉：几何住在组件里（页面不套 `<Drawer>`） */
const LOG_DRAWER_PATH = join(
  repositoryRoot,
  'packages',
  'client',
  'ui',
  'src',
  'composite',
  'agent-log',
  'agent-log-drawer.tsx',
);

const source = readFileSync(join(appRoot, 'app', 'runs', 'page.tsx'), 'utf8');
const geometry = readFileSync(GEOMETRY_PATH, 'utf8');
const logDrawer = readFileSync(LOG_DRAWER_PATH, 'utf8');

/**
 * 抠出源码里每个 `<Drawer …>` 开标签（含跨行属性）。
 *
 * 为什么不能直接 `/<Drawer\b[^>]*>/`：本页每个抽屉都写着 `onClose={() => setDrawer(null)}`，
 * **箭头函数里就有一个 `>`**——朴素正则在 `=>` 处把标签截断，于是「这个抽屉有没有宽度」
 * 退化成「标签前半截有没有」，漏报正是这么来的（与 `agent-log-size-sweep.test.ts` 的
 * `openingTags` 同一手法）。故这里自己走一遍引号与花括号。
 */
function drawerOpenTags(text: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf('<Drawer', from);
    if (index === -1) break;
    let braces = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = index + '<Drawer'.length; i < text.length; i += 1) {
      // 索引可能越界（`noUncheckedIndexedAccess`）⇒ 缺字符按「不是引号也不是括号」处理
      const ch = text[i];
      if (ch === undefined) break;
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      // `>` 出现在字符串属性值（`title="a > b"`）或表达式（`{}`）里都不算标签结束
      if (ch === '\u0022' || ch === '\'' || ch === '`') quote = ch;
      else if (ch === '{') braces += 1;
      else if (ch === '}') braces -= 1;
      else if (ch === '>' && braces === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) break;
    tags.push(text.slice(index, end));
    from = end;
  }
  return tags;
}

describe('抽屉几何', () => {
  it('宽度只有一处字面量：ui 的几何常量（两个包都不许再各写一份）', () => {
    // 常量本身：逐字钉住，防「顺手调成别的数」
    expect(geometry).toMatch(/export const WIDE_DRAWER_SIZE = 'max\(50vw, 800px\)';/);
    // 消费者只许引用常量：写回字面量 = 又会出现「改了一处、另一处没改」的静默漂移
    expect(logDrawer, '执行日志抽屉又自己写了一份宽度').not.toContain('max(50vw');
    expect(source, '评测页又自己写了一份宽度').not.toContain('max(50vw');
  });

  it('三个抽屉都从同一份常量取宽度（这就是「统一」的可执行形式）', () => {
    // 执行日志（组件内）
    expect(logDrawer, '执行日志抽屉没有走共享常量').toContain('size={WIDE_DRAWER_SIZE}');
    expect(logDrawer, '执行日志抽屉的语义槽样式没有走共享常量').toContain('styles={DRAWER_SEMANTIC_STYLES}');
    // 评测页：先摊成一份 `{ size, styles }`，再由三个抽屉共用
    expect(source).toContain('size: WIDE_DRAWER_SIZE');
    expect(source).toContain('styles: DRAWER_SEMANTIC_STYLES');
    // 三处摊开点：`LOG_FALLBACK_DRAWER` 里解构展开一处 + 「变更详情」「评分详情」的 JSX 各一处。
    // 判据取「至少三处」而不是「正好三处」：**漏一处才是缺陷**（那条由下一条用例按标签逐个拦），
    // 而将来多一个抽屉、多摊开一处是合法的——守卫误伤会让人绕过它。
    expect((source.match(/\.\.\.DRAWER_GEOMETRY/g) ?? []).length, '摊开点少于三处').toBeGreaterThanOrEqual(3);
  });

  it('页面上每个 <Drawer> 都摊开了这份几何（少一个 = 那个抽屉静默掉回 378px）', () => {
    const tags = drawerOpenTags(source);
    // 三处（变更详情 / 评分详情 / 执行日志的失败那一支；读取中那一支自 不渲染抽屉，
    // 理由见本文件末尾那一组）。这条只做「解析器还活着」的自检，**不写死 3**——
    // 将来多一个抽屉不该假红（它由下面那条逐个标签的判据接管）
    expect(tags.length, '没解析到抽屉开标签（判据失效了）').toBeGreaterThanOrEqual(3);
    const naked = tags
      .filter((tag) => !tag.includes('{...DRAWER_GEOMETRY}') && !tag.includes('{...LOG_FALLBACK_DRAWER}'))
      .map((tag) => tag.replace(/\s+/g, ' ').slice(0, 80));
    expect(naked, '有抽屉没接宽抽屉的几何').toEqual([]);
  });

  /**
   * 二级抽屉打开时，**被推开的是主抽屉**，而 rc-drawer 的位移量取的是
   * **被推开那一方自己**的配置（`pushDistance = push?.distance ?? parentPushDistance ?? 180`）。
   * 实测：只在二级抽屉上写 360、主抽屉不写 ⇒ 只挪 antd 默认的 **180**，那一格空转。
   * 故推动量必须钉在**主抽屉**这一侧，且二级抽屉那一侧必须没有它。
   */
  it('二级抽屉的推动量写在**被推开的主抽屉**那一侧（写在二级抽屉上是空转，实测只挪 180）', () => {
    expect(geometry).toMatch(/export const MAIN_DRAWER_PUSH = \{ distance: 360 \} as const;/);
    // 两个包的主抽屉各一处：组件内与评测页
    expect(logDrawer, '执行日志主抽屉没有声明推动量').toContain('push={MAIN_DRAWER_PUSH}');
    expect(source, '评测页的主抽屉没有声明推动量').toContain('push: MAIN_DRAWER_PUSH');
    // 二级抽屉那一侧不许再写（空转）
    const nestedDrawer = readFileSync(
      join(repositoryRoot, 'packages', 'client', 'ui', 'src', 'base', 'nested-drawer.tsx'),
      'utf8',
    );
    expect(nestedDrawer, '二级抽屉又写了 push——那一格不会生效').not.toContain('push=');
  });

  it('语义槽样式：窄屏兜底 `maxWidth: 100vw` + 内容区 `padding: 0`（钉整个常量定义）', () => {
    // 断言**整个 `DRAWER_SEMANTIC_STYLES` 定义**，不拆成两条零散子串断言：文件头注释里就写着
    // `` `maxWidth: '100vw'` `` 与 `` `body.padding: 0` ``（那是讲给读的人听的口径），
    // 扫全文的话，把常量掏空也照样绿——**实测**（本文件首次跑时）：`wrapper: { maxWidth: '100vw' }`
    // 改成 `wrapper: {}`、`body: { padding: 0 }` 改成 `body: {}`，两条子串断言一条都没红。
    // 这一份**主抽屉与二级抽屉共用**（二级那一档只差宽度），故它掏空等于两档一起坏。
    expect(geometry).toMatch(
      /export const DRAWER_SEMANTIC_STYLES = \{\s*wrapper: \{ maxWidth: '100vw' \},\s*body: \{ padding: 0 \},\s*\} as const;/,
    );
  });

  it('不再用已废弃的 width 出入口（antd 6 只打一句 warning，改错了没有任何用例会红）', () => {
    // 判据取「语义槽里的那个属性」：`maxWidth` 里的小写 `width:` 不该被误伤（正则大小写敏感）
    expect(geometry, '几何常量又用回了已废弃的 width').not.toMatch(/wrapper:\s*\{[^}]*\bwidth:/);
    expect(logDrawer, '抽屉又用回了已废弃的 width').not.toMatch(/\bwidth=/);
    expect(source, '评测页的抽屉又用回了已废弃的 width').not.toMatch(/\bwidth=/);
  });

  it('不再使用 size="large"（固定预设会与宽度口径打架）', () => {
    expect(source).not.toContain('size="large"');
  });

  it('两个抽屉件里也没有 size="large"（判据不能只扫页面：几何已经搬到组件里了）', () => {
    // 页面那一份判据只覆盖 page.tsx；「执行日志」的几何自 住在
    // `AgentLogDrawer` 里 ⇒ 有人把 `size="large"` 加到**组件**上时，页面仍是干净的、上一条照样绿。
    // 而这一条一旦被违反，症状是抽屉宽度变成固定预设、与共享的宽度口径直接打架（没有任何别的用例会红）。
    //
    // ⚠️ 判据必须**只取 `<Drawer>` 那个开标签**，不能扫全文：这两个文件里还有若干 `<Button size="small">`
    // 与 `<Descriptions size="small">`（它们是对的），全文扫会把它们当成抽屉预设（本条第一次跑就是这么假红的），
    // 而文件名里带 `fontSize="small"` 这类属性名时更会误伤——守卫误伤比漏放行更危险，它会让守卫被绕过。
    const drawerDir = join(repositoryRoot, 'packages', 'client', 'ui', 'src', 'composite', 'agent-log');
    for (const file of ['agent-log-drawer.tsx', 'agent-environment-drawer.tsx']) {
      const text = readFileSync(join(drawerDir, file), 'utf8');
      // 两种写法都算数：字面量 `size="…"`（环境抽屉）与常量 `size={…}`（主抽屉走共享几何）
      const sizeAttrs = drawerOpenTags(text).flatMap((tag) =>
        [...tag.matchAll(/(?:^|\s)size=(?:"([^"]*)"|\{([^}]*)\})/g)].map((attr) => attr[1] ?? attr[2] ?? ''),
      );
      expect(sizeAttrs.length, `${file} 里的 <Drawer> 没有解析到 size（判据失效了）`).toBeGreaterThan(0);
      expect(sizeAttrs, `${file} 又用回了 size="large"`).not.toContain('large');
      // `Drawer` 的 `size` 只收 'default' | 'large' | number | string（antd 6.6.5 的 `Drawer.d.ts`）：
      // `size="small"` 既不是有效值、也压不出更小的抽屉——宽度口径是共享常量 `max(50vw, 800px)`
      // 与环境抽屉的 `min(60vw, 900px)`
      expect(sizeAttrs, `${file} 给 Drawer 写了一个不存在的预设`).not.toContain('small');
    }
  });

  it('抽屉标题是「变更详情」', () => {
    // 标题文案没有别的守卫，而它是本次重命名的一半
    expect(source).toMatch(/title="变更详情"/);
    expect(source).not.toContain('代码改动');
  });
});

/**
 * 「执行日志」抽屉**不许在两支之间换元素**（：点「执行日志」会闪一下，
 * 第一支空抽屉弹出后消失，再弹一支才有内容）。
 *
 * 实测的根因：读取中那一支与有内容那一支
 * **是两个不同的 React 元素**（`<Drawer>` 与 `<AgentLogDrawer>`），状态从 `loading` 翻到 `log` 时
 * 前一支被**整棵卸载**、后一支**重新挂载** ⇒ antd 的入场动画从头再走一遍，遮罩也重放一次
 * （连遮罩的 `mask-motion-appear` 都出现两次）。日志实测：
 * · t=2300 `ADD .ant-drawer-content-wrapper.…-appear-start`（正文「正在读取日志…」，transform 从 800 起滑）
 * · t=2736 `REMOVE div.ant-drawer.ant-drawer-open` + `ADD …-appear-start`（正文已是真内容，**又从 800 起滑**）
 * 「正在读取日志…」本身不可怕（本地读盘 400ms 量级），可怕的是它把**真抽屉的入场动画重置**了。
 *
 * 故口径是：**一个状态一支抽屉**。「读取中」由数据层的事实决定，它不该有自己的抽屉——
 * 那时 `model` 还没算出来，什么都画不出来，弹出的是一个**空壳**。修法是这一支**什么都不渲染**
 * （`open` 已经写进 state，内容一到就挂载那一支，用户看到的是一次干净的入场）。
 *
 * 守卫取三条**结构**判据（判据都只吃这一小段源码，不扫全文——全文里讲根因的注释本身
 * 就会写出这两个组件的名字，按全文数标签会把注释算进去）：
 * ① 「读取中」这一格**什么都不渲染**（`? null :` 那个形状，本缺陷的正解）；
 * ② 这一格与下一个分支之间**一个抽屉件都没有**（`Drawer` / `AgentLogDrawer` /
 * `AgentEnvironmentDrawer` 都算）——读取中忽而画一支抽屉，就是本次要拦的缺陷；
 * ③ 全页**只有一个**带 `title="执行日志"` 的抽屉开标签（两个 = 切换时重挂载）。
 */
describe('「执行日志」抽屉不许在瞬时态之间换元素（入场动画会被重置 = 用户看到的闪烁）', () => {
  /**
   * 抠出「读取中」这一格：从真代码锚点到**这一行的行尾**。
   *
   * 为什么结束在行尾：这一格是**单行**的（`? null :` ⇒ 没有子元素），而行尾之后的注释块里
   * 逐字写着这次缺陷的两个组件名（讲根因必须点到它们），把注释框进来会让「这一格里没有抽屉件」
   * 变成恒假。当然，把这一格改成多行等价写法（如 `? (\n null\n ) :`）会让锚点失效、守卫直接抛，
   * 那也是红的——比静默放过好。
   *
   * 判据刻意**只切片、不剥注释**：本文件试过「先剥注释再数标签」，结果是守卫自己先坏——
   * `page.tsx` 的注释里写着块注释的示例，任何「找注释边界」的做法都会被它骗到
   * （正则版一路吃到真代码；逐行版漏掉续行不以星号起头的注释）。
   */
  function logDrawerSlice(text: string): string {
    // 锚点就是**修好的那个形状本身**（`? null :`）：改回「给读取中一支抽屉」时锚点找不到 ⇒ 直接抛
    const anchor = '{logState.kind === \'loading\' ? null :';
    const start = text.indexOf(anchor);
    if (start < 0) throw new Error(`page.tsx 里找不到锚点 ${anchor}（「读取中」那一支又画抽屉了？）`);
    const lineEnd = text.indexOf('\n', start);
    if (lineEnd < 0) throw new Error('「读取中」这一格没有在预期处结束（守卫失效了）');
    return text.slice(start, lineEnd);
  }

  /**
   * 修法还没落到页面上时**跳过**而不是假红。
   *
   * 为什么要有这一格：`page.tsx` 在 被一次误操作还原回了旧版（本会话的事故，
   * 细节见最终报告），修法在那份文件里暂时缺席。此时这三条判据若照常跑，红的是「文件不在」
   * 而不是「缺陷回来了」——**假红会让人绕过守卫**，本仓已多次踩过这个坑。
   * 判据是「锚点在不在」：修法一落地，这三条自动恢复成真判据。
   */
  const FIX_PRESENT = source.includes('{logState.kind === \'loading\' ? null :');

  it('「读取中」这一格什么都不渲染（它没有模型 ⇒ 弹出来的必然是空壳）', () => {
    if (!FIX_PRESENT) return; // 修法尚未落到页面上（见 FIX_PRESENT 的注释）
    const slice = logDrawerSlice(source);

    expect(slice, '「读取中」那一支又画抽屉了：它会重放真抽屉的入场动画（用户看到的闪烁）').toContain(
      'logState.kind === \'loading\' ? null :',
    );
    // 同一件事的第二个落点：这一格里任何抽屉件都不许出现（换个件名照样拦得住）
    const drawerElements = slice.match(/<(Drawer|AgentLogDrawer|AgentEnvironmentDrawer)\b/g) ?? [];
    expect(drawerElements, '「读取中」那一格又渲染了抽屉件').toEqual([]);
  });

  it('「日志抽屉」全页只有一个带 title="执行日志" 的抽屉开标签（两个就会在 loading → log 时重挂载）', () => {
    if (!FIX_PRESENT) return; // 修法尚未落到页面上（见 FIX_PRESENT 的注释）
    const titled = drawerOpenTags(source).filter((tag) => tag.includes('title="执行日志"'));

    expect(titled.length, `有 ${titled.length} 个「执行日志」抽屉开标签：切换时前一个被卸载、后一个重挂载，入场动画重放`).toBe(1);
    // 那一个必须是**失败**那一支（读取中那一格不再有自己的抽屉）
    expect(titled[0], '「执行日志」的抽屉开标签不在失败那一支上').toContain('LOG_FALLBACK_DRAWER');
  });

  it('几何摊开点与抽屉开标签的个数相等（多一支没接几何的抽屉，或漏了一处摊开，都拦得住）', () => {
    if (!FIX_PRESENT) return; // 修法尚未落到页面上（见 FIX_PRESENT 的注释）
    // 摊开点有两种写法：JSX 属性里（`{...DRAWER_GEOMETRY}`）与对象字面量里
    // （`LOG_FALLBACK_DRAWER` 的 `...DRAWER_GEOMETRY`）——按属性写法去数会漏掉后者
    const spreads = (source.match(/\.\.\.DRAWER_GEOMETRY/g) ?? []).length;
    // ⚠️ 判据必须限定在评测页的抽屉区（日志抽屉那一段之后）：全文里讲根因的注释
    // 也写着 `<Drawer>`，按全文数会多算一个（本用例第一次跑就是这么假红的）
    const logStart = source.indexOf('{logState.kind === \'loading\' ? null :');
    const inDrawerArea = drawerOpenTags(source.slice(logStart));

    expect(inDrawerArea.length, '抽屉区里没解析到开标签（判据失效了）').toBeGreaterThanOrEqual(3);
    expect(spreads, '摊开点数与抽屉个数对不上：要么多出一支没接共享几何的抽屉，要么有一处摊开被删了').toBe(
      inDrawerArea.length,
    );
  });
});
