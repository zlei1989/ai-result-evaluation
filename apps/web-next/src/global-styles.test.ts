// @vitest-environment node
/**
 * 全局样式 × ui 组件的**跨包字符串契约**守卫（用户口径，2026-09-29 的活动行）。
 *
 * 缺口长什么样：活动行那条高光扫过全靠 `app/globals.css` 里的类名与 `@keyframes`，而组件那一侧
 * 只是把一个字符串挂到 `className` 上。**两边对不上时浏览器不会报错**——表现只是「文字静止」，
 * 组件用例（只测类名带没带上）与其余守卫都不会红，这样的静默漂移在本仓已经发生过多次。
 *
 * 三条断言各有各的靶子（都能被单独变异掉）：
 *   ① CSS 里有这个类名——删掉类 = 组件带了个不存在的类名；
 *   ② CSS 里有同名 `@keyframes`——删掉它只剩静态渐变，肉眼几乎分不出差别；
 *   ③ 「减少动态效果」兜底存在**且把颜色还回来**——只关动画的话 `color: transparent` 会让
 *      这一行整行消失（比没有动效严重得多），而这一条在任何浏览器里都不会自己浮出来。
 *
 * **为什么读源码抠字面量、而不是 `import { ACTIVITY_SWEEP_CLASS } from '@aieval/ui'`**：
 * 后者会把整条 antd 依赖图拖进这个 node 环境文件（实测 `import` 阶段 27.6s），而本仓的墙钟
 * 「由最长的那个文件决定」（AGENT.md），一个字符串不值得当那个长杆。抠不到就**抛**——
 * 守卫不许静默失效（与 `runs-page-wiring.test.ts` 抠调用实参块同一套做法）。
 * 链条的另一半在 ui 那侧：`agent-activity-line.test.tsx` 断言渲染出来的类名就是那个常量。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 应用根目录（`apps/web-next`）：用文件自身位置推导，不依赖 `process.cwd()`（同 `runs-page-wiring.test.ts`） */
const appRoot = join(import.meta.dirname, '..');
const cssPath = join(appRoot, 'app', 'globals.css');
const componentPath = join(appRoot, '..', '..', 'packages', 'client', 'ui', 'src', 'base', 'agent-activity-line.tsx');

/** 从组件源码里抠出那个类名；抠不到直接抛（守卫不许静默失效） */
function sweepClass(): string {
  const source = readFileSync(componentPath, 'utf8');
  const matched = /export const ACTIVITY_SWEEP_CLASS = '([^']+)'/.exec(source);
  const value = matched?.[1];
  if (value === undefined) {
    throw new Error('agent-activity-line.tsx 里找不到 ACTIVITY_SWEEP_CLASS 的字面量定义，本守卫无法核对');
  }
  return value;
}

describe('globals.css 里的活动行高光', () => {
  it('定义了组件带上的那个类名（对不上时浏览器保持静默）', () => {
    expect(readFileSync(cssPath, 'utf8')).toContain(`.${sweepClass()} {`);
  });

  it('定义了同名 @keyframes（少了它只剩静态渐变，看不出差别）', () => {
    expect(readFileSync(cssPath, 'utf8')).toContain(`@keyframes ${sweepClass()} {`);
  });

  it('「减少动态效果」下静止但**把颜色还回来**（只关动画会让这一行整行消失）', () => {
    const source = readFileSync(cssPath, 'utf8');
    const start = source.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start, 'globals.css 里没有 prefers-reduced-motion 兜底').toBeGreaterThanOrEqual(0);
    // 媒体查询那一整块：它内部的规则是缩进的，只有最外层那个 `}` 顶格
    const block = source.slice(start, source.indexOf('\n}', start) + 2);

    expect(block, '兜底里没有关掉动画').toContain('animation: none');
    expect(
      block,
      '兜底没有把 -webkit-text-fill-color 从 transparent 换回来：这一行会整行消失',
    ).toContain('-webkit-text-fill-color: var(--app-muted)');
  });
});
