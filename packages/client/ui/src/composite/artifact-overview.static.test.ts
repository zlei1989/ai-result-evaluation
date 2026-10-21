// @vitest-environment node
/**
 * 「产物总览」的**源码形态**守卫（静态扫描：本目录既有手法，见 `rank-table.static.test.ts`）。
 *
 * 四条判据都是「行为测试测不到、而缺了会静默失效」的：
 *   ① **承载独立文档的那一档必须带 `sandbox`，且不许给 `allow-scripts` / `allow-same-origin`**：
 *      这两格一改，产物里的脚本就能在宿主页面里跑、能读抽屉里的东西；而**渲染用例照样全绿**
 *      （jsdom 只看得见属性，看不见它挡住什么）⇒ 只能按源码钉，并在变异矩阵里确认它见过红。
 *   ② **`md` 那一档不许改走 iframe**：走 iframe 就绕开了本仓的 markdown 外壳
 *      （原始 HTML 转义、标题降级、外链新窗口），而界面看起来「也渲染出来了」。
 *   ③ **三种 kind 分支都在**：契约加一档后缀时，漏一条分支的表现是那一份产物**渲染成空白**，
 *      没有报错、也没有占位。
 *   ④ **顺序与名次来自那两份既有判据**（`orderForDisplay` / `rankOf`）：自己排一次就会出现
 *      「卡片挂第 1 名、总览里排第 2」，而那看起来像数据坏了。
 *
 * 判据只吃**去掉注释后的代码**：本件的文件头正大光明地写着 `allow-scripts`、`sandbox` 这些词
 * （那是讲给读的人听的口径），扫全文的话负向断言会被注释直接判红——
 * `nested-drawer.test.tsx` 的注释里记着同一条教训（守卫误伤比漏放行更危险：会教人把守卫删掉）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(import.meta.dirname, 'artifact-overview.tsx'), 'utf8');
const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 两个导出常量的值**从源码里抠**，不 import 本件。
 *
 * 为什么不能 import：这个文件是 node 环境，而 `artifact-overview.tsx` 会拉起
 * `@ant-design/x-markdown` 的 CJS 产物（它内部 `require('./DebugPanel.css')`）⇒ 收集期就
 * `SyntaxError: Unexpected token '.'`（`apps/web-next/src/inject-declaration.test.ts` 的文件头记着同一条）。
 * 抠不到就抛：判据失效时不能静默通过（与 `drawer-geometry.test.ts` 同一手法）。
 */
function sourceConstant(pattern: RegExp, name: string): string {
  const matched = pattern.exec(source)?.[1];
  if (matched === undefined) throw new Error(`artifact-overview.tsx 里抠不到 ${name}（判据失效了）`);
  return matched;
}

const LABEL = sourceConstant(/export const ARTIFACT_OVERVIEW_LABEL = '([^']+)';/, 'ARTIFACT_OVERVIEW_LABEL');
const FRAME_HEIGHT = Number(sourceConstant(/export const ARTIFACT_FRAME_HEIGHT = (\d+);/, 'ARTIFACT_FRAME_HEIGHT'));

describe('独立文档那一档（html / svg）的沙箱', () => {
  it('iframe 必须带 `sandbox`，且是最严那一档（`allow-scripts` / `allow-same-origin` 一个都不许出现）', () => {
    expect(source, 'iframe 少了 sandbox：产物里的脚本会在宿主页面里跑').toContain('sandbox=""');
    expect(source, 'iframe 给了 allow-scripts：产物能执行脚本').not.toContain('allow-scripts');
    expect(source, 'iframe 给了 allow-same-origin：产物能读到宿主页面的东西').not.toContain('allow-same-origin');
  });

  it('高度走具名常量，不写裸数字（它是「量不到内容高度」这条取舍的唯一落点）', () => {
    expect(source, 'iframe 的高度没有走 ARTIFACT_FRAME_HEIGHT').toContain('height: ARTIFACT_FRAME_HEIGHT');
    expect(FRAME_HEIGHT, '一屏的高度至少要能看下一页内容').toBeGreaterThanOrEqual(320);
    // 裸数字写死高度时，改常量不会生效，而界面上只是「高度不对」——没有任何用例会红
    expect(source, 'iframe 里写死了像素高度').not.toMatch(/height:\s*\d+px/);
  });
});

describe('三种渲染分档', () => {
  it('md 走本仓的 markdown 外壳（`open` 显式给 false），不许改走 iframe', () => {
    expect(source, 'md 那一档没有走 XMarkdownText').toMatch(/case 'md':[\s\S]{0,200}?<XMarkdownText/);
    // 流式那一格必须显式表态：本仓对「静默拿到默认值」的容忍度是零（见 XMarkdownText 的 props 注释）
    expect(source, 'XMarkdownText 少了显式的 open={false}').toContain('open={false}');
  });

  it('html / svg 两档都在，且都走同一个沙箱件（不各写一个 iframe）', () => {
    expect(source, '分档里少了 case \'html\'').toContain('case \'html\':');
    expect(source, '分档里少了 case \'svg\'').toContain('case \'svg\':');
    // 一个 iframe 实现：两份各写一份时，sandbox 只会改到其中一处
    expect(source.match(/<iframe/g) ?? [], 'iframe 出现了不止一处：沙箱口径会被改漏').toHaveLength(1);
  });

  it('SVG 那一档前置最小 HTML 壳（否则 SVG 落在 300×150 的默认尺寸上）', () => {
    expect(source, 'SVG 那一档没有拼壳').toMatch(/case 'svg':[\s\S]{0,200}?SVG_FRAME_SHELL/);
  });
});

describe('顺序与名次只有一个判据', () => {
  it('卡片顺序来自 orderForDisplay（本件不许自己排）', () => {
    expect(source, '卡片顺序没有走 orderForDisplay').toContain('orderForDisplay(run.candidates)');
    // 自己排一次 = 第二个判据，两者迟早分叉
    expect(source, '本件自己写了一次排序').not.toMatch(/\.sort\(/);
  });

  it('名次来自 rankOf(run.candidates, …)（传整轮行集：名次是整轮的性质）', () => {
    expect(source, '名次没有走 rankOf').toContain('rankOf(run.candidates, row)');
  });

  it('面板标题只有一份拼法（页面与守卫共用 `artifactPanelTitle`）', () => {
    expect(source, '面板标题没有走 artifactPanelTitle').toContain('const label = artifactPanelTitle(row, rank);');
    // 四段的分隔符是那句拼法的实现细节，页面不该再拼一次
    expect(source.match(/' · '/g) ?? [], '四段标题被就地拼过一份').toHaveLength(1);
  });
});

describe('二级抽屉的入口文案', () => {
  it('抽屉标题与入口按钮同文（导出的那个常量就是唯一一份）', () => {
    expect(source, '抽屉标题没有走 ARTIFACT_OVERVIEW_LABEL').toContain('title={ARTIFACT_OVERVIEW_LABEL}');
    expect(LABEL).toBe('产物总览');
  });
});
