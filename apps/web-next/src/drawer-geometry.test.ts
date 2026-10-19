/**
 * 抽屉几何守卫（「抽屉几何」）。
 *
 * 现在有两套壳（评测详情 / 排名 / 二级层都是 Base UI `Sheet`，只剩技能预览还是 antd `Drawer`），
 * 但宽度口径只有一份，且**数值只写在应用全局样式里**：
 *
 *   ① **档位是语义**：`WIDE_DRAWER_SIZE` / `NESTED_DRAWER_SIZE` 在 `base/drawer-geometry.ts`
 *      里指向 `--drawer-main-width` / `--drawer-nested-width`；数值只在 `globals.css` 写一次。
 *      这条一旦破，症状是**静默**的：抽屉照样弹出来，只是宽窄不一，jsdom 测不出布局。
 *   ② **消费者真的接上了**：`AgentLogDrawer`、`RunDetailDrawer` 与页面的排名抽屉都必须摊开
 *      共享几何；新加一个抽屉却忘了宽度时，它会掉回 `Sheet` 的默认档。
 *   ③ **二级层让位读 Base UI 的嵌套计数**：`--drawer-nested-shift` 从 `--nested-dialogs` 算出来，
 *      全局样式再用 `[data-drawer='main']` 消费它。写死像素（例如旧的 360）会让宽屏上的
 *      「我在第二层」重新变成看不出来，且与二级层宽度脱钩。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 用本文件的位置推导目录，**不用 `process.cwd()`**：从仓库根跑 `pnpm test`（根 vitest.config.ts
// 一次收集 8 个包）时 CWD 是仓库根，`process.cwd()/app/runs/page.tsx` 不存在，套件在收集期就
// 以 ENOENT 整份死掉——症状是「永远红的门禁」，而不是某条断言失败。
const appRoot = join(import.meta.dirname, '..');
const repositoryRoot = join(appRoot, '..', '..');
const uiRoot = join(repositoryRoot, 'packages', 'client', 'ui', 'src');
const GEOMETRY_PATH = join(uiRoot, 'base', 'drawer-geometry.ts');
const LOG_DRAWER_PATH = join(uiRoot, 'composite', 'agent-log', 'agent-log-drawer.tsx');
const RUN_DETAIL_DRAWER_PATH = join(uiRoot, 'composite', 'run-detail-drawer.tsx');
const NESTED_DRAWER_PATH = join(uiRoot, 'base', 'nested-drawer.tsx');

const source = readFileSync(join(appRoot, 'app', 'runs', 'page.tsx'), 'utf8');
const geometry = readFileSync(GEOMETRY_PATH, 'utf8');
const logDrawer = readFileSync(LOG_DRAWER_PATH, 'utf8');
const runDetailDrawer = readFileSync(RUN_DETAIL_DRAWER_PATH, 'utf8');
const nestedDrawer = readFileSync(NESTED_DRAWER_PATH, 'utf8');
const globalsCss = readFileSync(join(appRoot, 'app', 'globals.css'), 'utf8');

/**
 * 从全局样式里取一个变量的字面量。取不到直接抛：变量改名 / 改形状时，
 * 下面的宽度关系必须**当场失效**，而不是拿 `undefined` 去比大小后静默放过。
 */
function cssVar(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(globalsCss);
  const value = match?.[1]?.trim();
  if (value === undefined) throw new Error(`globals.css 里抠不到 --${name}（判据失效了）`);
  return value;
}

/**
 * 把宽度表达式算成某个视口下的实测宽度（px）。
 *
 * jsdom 没有布局引擎，「主抽屉比二级抽屉宽」这件事在用例里看不见（两档只是拿到的 inline style
 * 不同，渲染结果都是 0×0）。表达式形状只有 `fn(a vw, b px)` 一种，故按这个形状解析；
 * `maxWidth: 100vw` 那道兜底也要算进去：窄屏上两档都被视口宽度削平，不削平会高估差值。
 */
function widthAt(expression: string, viewport: number): number {
  const match = /^(max|min)\((\d+(?:\.\d+)?)vw,\s*(\d+(?:\.\d+)?)px\)$/.exec(expression);
  const fn = match?.[1];
  const vw = match?.[2];
  const px = match?.[3];
  if (fn === undefined || vw === undefined || px === undefined) {
    throw new Error(`几何变量的形状变了，求值器失效：${expression}`);
  }
  const value = (Number(vw) * viewport) / 100;
  return Math.min(fn === 'max' ? Math.max(value, Number(px)) : Math.min(value, Number(px)), viewport);
}

describe('抽屉几何', () => {
  it('数值只有一处：全局样式定义变量，几何常量只引用变量名', () => {
    expect(globalsCss).toContain('--drawer-main-width: max(61vw, 800px);');
    expect(globalsCss).toContain('--drawer-nested-width: min(60vw, 900px);');
    expect(globalsCss).toContain('--drawer-nested-give-way: 20vw;');

    expect(geometry).toContain('export const MAIN_DRAWER_WIDTH_VAR = \'--drawer-main-width\';');
    expect(geometry).toContain('export const NESTED_DRAWER_WIDTH_VAR = \'--drawer-nested-width\';');
    expect(geometry).toContain('export const WIDE_DRAWER_SIZE = `var(${MAIN_DRAWER_WIDTH_VAR})`;');
    expect(geometry).toContain('export const NESTED_DRAWER_SIZE = `var(${NESTED_DRAWER_WIDTH_VAR})`;');

    // 消费方不许再各写一份宽度表达式
    for (const [file, text] of [
      ['page.tsx', source],
      ['run-detail-drawer.tsx', runDetailDrawer],
      ['agent-log-drawer.tsx', logDrawer],
      ['nested-drawer.tsx', nestedDrawer],
    ] as const) {
      expect(text, `${file} 又自己写了一份宽度`).not.toMatch(/(?:max|min)\(\d+vw/);
    }
  });

  it('主抽屉恒宽于二级抽屉（两档只差一个 vw 数，反序是静默的）', () => {
    const main = cssVar('drawer-main-width');
    const nested = cssVar('drawer-nested-width');
    // 端点取在关系最容易翻转的地方：下限刚接管的两侧（1311 / 1312）、以及两档各自吃满的宽屏
    for (const viewport of [700, 800, 1024, 1311, 1312, 1440, 1920, 2560]) {
      expect(
        widthAt(main, viewport),
        `视口 ${viewport} 上主抽屉不宽于二级抽屉（档位反序：推出来的那层更宽了）`,
      ).toBeGreaterThan(widthAt(nested, viewport));
    }
  });

  it('主抽屉的消费者都摊开共享几何：评测详情、执行日志、排名', () => {
    expect(runDetailDrawer, '评测详情抽屉没有接共享几何').toContain('style={MAIN_DRAWER_STYLE}');
    expect(runDetailDrawer, '评测详情抽屉不是主抽屉（嵌套让位不会生效）').toContain('data-drawer="main"');
    expect(logDrawer, '执行日志抽屉没有接共享几何').toContain('style={MAIN_DRAWER_STYLE}');
    expect(logDrawer, '执行日志抽屉不是主抽屉').toContain('data-drawer="main"');

    // 页面：排名是仅剩的页面级主抽屉
    expect(source).toContain('const DRAWER_STYLE = MAIN_DRAWER_STYLE;');
    const rankSheet = source.slice(source.indexOf('open={drawer?.kind === \'rank\'}'));
    expect(rankSheet, '排名抽屉没有接共享几何').toContain('style={DRAWER_STYLE}');
    expect(rankSheet, '排名抽屉不是主抽屉').toContain('data-drawer="main"');
  });

  it('页签面板靠 `hidden` 属性隐藏：没有 preflight 时必须显式兑现它', () => {
    // 过渡期不引 preflight ⇒ 带 `display: flex` 的页签面板即使写了 `hidden` 仍会显示，
    // 三个面板会同时铺开（真机实测：每个 280px、日志可视区只剩 280px）
    expect(globalsCss).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });

  it('二级层让位由 `--nested-dialogs` 驱动（不再依赖 360px 这个魔法距离）', () => {
    // 公式：嵌套层数 × 让位档；计数由 Base UI 写在父弹层上
    expect(geometry).toContain(
      '\'--drawer-nested-shift\': \'calc(var(--nested-dialogs, 0) * var(--drawer-nested-give-way))\'',
    );
    // 消费方：主抽屉贴右 ⇒ margin-right 等价于整体左移
    expect(globalsCss).toMatch(
      /\[data-drawer='main'\]\s*\{\s*margin-right:\s*var\(--drawer-nested-shift,\s*0px\);/,
    );
    expect(source, '页面又出现了 rc-drawer 的推动量').not.toContain('push:');
    expect(geometry, '几何常量里又出现了写死的推动距离').not.toContain('360');
    expect(source, '页面又出现了写死的推动距离').not.toContain('360');
  });

  it('主抽屉是 Base UI Sheet：页面里不再有 antd Drawer', () => {
    expect(source, '评测页又出现了 antd Drawer').not.toContain('<Drawer');
    expect(source, '评测页又传了 rc-drawer 的推动量').not.toContain('push:');
    expect(nestedDrawer, '二级抽屉又写了 push——那一格不会生效').not.toContain('push=');
    expect(nestedDrawer, '二级抽屉又投回了 antd').not.toMatch(/from\s+'antd'/);
  });

  it('页签头：日志 / 变更 / 评分在同一个抽屉里，排名仍是独立主抽屉', () => {
    // 页签文案住 `RunDetailDrawer`（页面只递内容），三个入口与三个页签一一对应
    for (const label of ['日志', '变更', '评分']) {
      expect(runDetailDrawer, `页签头少了「${label}」`).toContain(`label: '${label}'`);
    }
    expect(source, '页面没有用同一个抽屉承载三个视图').toContain('<RunDetailDrawer');
    // 三个入口的语义不变：各自直达自己的页签
    expect(source).toContain('onOpenLog={(rowId) => setDrawer({ kind: \'row\', rowId, tab: \'log\' })}');
    expect(source).toContain('onOpenDiff={(rowId) => setDrawer({ kind: \'row\', rowId, tab: \'diff\' })}');
    expect(source).toContain('onOpenScore={(rowId) => setDrawer({ kind: \'row\', rowId, tab: \'score\' })}');
    // 排名仍是页面级视图（不分行）
    expect(source).toContain('onOpenRank={() => setDrawer({ kind: \'rank\' })}');
    expect(source).toContain('open={drawer?.kind === \'rank\'}');
  });
});
