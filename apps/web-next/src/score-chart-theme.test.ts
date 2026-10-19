// @vitest-environment node
/**
 * 评分对比图的**主题来源**守卫（跨包字符串契约，手法同 `global-styles.test.ts`）。
 *
 * 缺口长什么样：官方 chart 模板把明暗写死成 `.dark` 类与十六进制色，而本仓的主题真源是
 * `html[data-theme]` + `globals.css` 里的 `--chart-*`。两边对不上时浏览器不会报错——
 * 表现只是「切到亮色后柱子还是暗色那套颜色」，组件用例与其余守卫都不会红。
 *
 * 三条断言：
 *   ① 图色只走语义变量（`var(--primary)` / `var(--chart-*)`）：组件源码里不许出现十六进制 / `rgb()` / `oklch()` 字面量；
 *      本仓只有一支品牌色，柱色取 `--primary`，图与主操作 / 选中同源；
 *   ② 不许读写 `.dark` 类（本仓没有这个类；主题是 `<html data-theme>` 上的属性）；
 *   ③ `--chart-1` 在 globals.css 的**明暗两处**都有定义——变量本身跟着 `data-theme` 换值，
 *      组件才不需要知道当前是哪套主题。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = join(import.meta.dirname, '..');
const chartTsx = readFileSync(join(appRoot, '..', '..', 'packages', 'client', 'ui', 'src', 'composite', 'score-chart.tsx'), 'utf8');
const globalsCss = readFileSync(join(appRoot, 'app', 'globals.css'), 'utf8');

describe('评分对比图的主题取值', () => {
  it('图色只走 CSS 变量：没有十六进制 / rgb / oklch 字面量', () => {
    expect(chartTsx, '图色没走语义变量').toMatch(/var\(--(?:chart-\d|primary)\)/);
    expect(chartTsx, '组件里出现了十六进制色').not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(chartTsx, '组件里出现了 rgb()/rgba()/oklch() 字面量').not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
  });

  it('不碰 `.dark` 类：本仓的明暗是 `html[data-theme]` 属性', () => {
    expect(chartTsx, '组件里还在用 `.dark` 类').not.toMatch(/['"`]\.?dark['"`]/);
    expect(chartTsx, '组件里在读 classList 上的 dark').not.toMatch(/classList[\s\S]{0,40}dark/);
  });

  it('`--chart-1` 明暗两套都在 globals.css 里（变量自己跟着 data-theme 换值）', () => {
    const lightBlock = /:root\s*\{[\s\S]*?\}/.exec(globalsCss)?.[0] ?? '';
    const darkBlock = /html\[data-theme='dark'\]\s*\{[\s\S]*?\}/.exec(globalsCss)?.[0] ?? '';
    expect(lightBlock, 'globals.css 的 :root 里没有 --chart-1').toContain('--chart-1:');
    expect(darkBlock, 'globals.css 的 html[data-theme=\'dark\'] 里没有 --chart-1').toContain('--chart-1:');
  });
});

describe('评分对比图挂在排名抽屉里', () => {
  it('抽屉正文渲染了 ScoreChart（不挂上去就是死代码）', () => {
    const page = readFileSync(join(appRoot, 'app', 'runs', 'page.tsx'), 'utf8');
    expect(page, '排名抽屉里没有 ScoreChart').toMatch(/<ScoreChart\b/);
  });
});
