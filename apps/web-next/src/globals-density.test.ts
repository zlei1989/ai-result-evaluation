// @vitest-environment node
/**
 * 密度作用域的**静态**守卫（三半判据里的「甲」）。
 *
 * jsdom 没有 CSS 级联，量不到渲染后的字号；真机那半只在冒烟里。这里钉的是
 * `globals.css` 里那几块**必须存在的字面量**，以及它们的**层叠位置**：
 *
 * ① 紧凑块与豁免块都在**层外**（`@layer` 之外的顶层）。这是硬约束——写进 `@layer base`
 *    会被 Tailwind 的 `@layer theme` 反超，密度**静默失效**（浏览器不报错、构建不报警，
 *    只有真机量字号才看得出来）；
 * ② 紧凑值与豁免值逐字在，且豁免档的方向钉死（正文更大）。只判「两份不相等」时，
 *    把两份值写反也照样绿；
 * ③ `@theme inline` 的别名必须是 `var(--density-*)` 形态。写成字面量会在构建期烤死，
 *    作用域块再也切不动它——这一条也是静态可拦的唯一一处。
 *
 * 抠不到就抛：守卫不许静默失效（与 `global-styles.test.ts` 同一套做法）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = join(import.meta.dirname, '..');
const cssPath = join(appRoot, 'app', 'globals.css');
const source = readFileSync(cssPath, 'utf8');
/** 去掉注释再扫括号：注释里的花括号会把深度算歪 */
const css = source.replace(/\/\*[\s\S]*?\*\//g, '');

/** 从 `from` 处的 `{` 开始做括号配对，返回块体（不含外层花括号）与块结束下标 */
function matchBlock(text: string, from: number): { body: string; end: number } {
  const open = text.indexOf('{', from);
  if (open < 0) throw new Error(`globals.css 里 ${text.slice(from, from + 40)} 之后没有块，本守卫无法核对`);
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), end: index };
    }
  }
  throw new Error('globals.css 的块没有闭合，本守卫无法核对');
}

/** 选择器出现位置的嵌套深度：0 = 顶层（层外），>0 = 在某个 at-rule / 规则里 */
function depthAt(text: string, at: number): number {
  let depth = 0;
  for (let index = 0; index < at; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') depth -= 1;
  }
  return depth;
}

/** 取某条规则的块体；找不到就抛 */
function ruleBody(selector: string): { body: string; index: number } {
  const index = css.indexOf(selector);
  if (index < 0) throw new Error(`globals.css 里找不到 ${selector}，本守卫无法核对`);
  return { body: matchBlock(css, index).body, index };
}

/** 从块体里读一个自定义属性的值；读不到就抛 */
function varOf(body: string, name: string): string {
  const matched = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
  const value = matched?.[1]?.trim();
  if (value === undefined) throw new Error(`块里找不到 ${name}，本守卫无法核对`);
  return value;
}

/** rem 值转数字，用来钉「豁免档更大」的方向 */
function remValue(value: string, context: string): number {
  const matched = /^([\d.]+)rem$/.exec(value);
  if (matched?.[1] === undefined) throw new Error(`${context} 的值不是 rem：${value}，本守卫无法核对`);
  return Number(matched[1]);
}

describe('globals.css 的密度变量组', () => {
  it('紧凑块在层外（写进 @layer base 会被 @layer theme 反超、静默失效）', () => {
    const { index } = ruleBody('[data-density=\'compact\']');
    expect(
      depthAt(css, index),
      '[data-density=\'compact\'] 不在顶层：层内的声明打不过 Tailwind 的 @layer theme，密度会静默失效',
    ).toBe(0);
    // 再直接排掉「写在 @layer base 的花括号里」这一种具体写法（即使有人把它缩进坏了）
    for (const layer of ['@layer base', '@layer theme', '@layer components', '@layer utilities']) {
      let searchFrom = 0;
      for (;;) {
        const layerIndex = css.indexOf(`${layer} {`, searchFrom);
        if (layerIndex < 0) break;
        const { end } = matchBlock(css, layerIndex);
        expect(index < layerIndex || index > end, `[data-density='compact'] 落在 ${layer} 块内`).toBe(true);
        searchFrom = end;
      }
    }
  });

  it('豁免块在层外，且方向钉死：default 的正文比 compact 更大', () => {
    const compact = ruleBody('[data-density=\'compact\']');
    const exempt = ruleBody('[data-density=\'default\']');
    expect(depthAt(css, exempt.index), '[data-density=\'default\'] 不在顶层').toBe(0);

    const compactBody = varOf(compact.body, '--density-text-body');
    const exemptBody = varOf(exempt.body, '--density-text-body');
    expect(remValue(exemptBody, 'default --density-text-body')).toBeGreaterThan(
      remValue(compactBody, 'compact --density-text-body'),
    );
  });

  it('紧凑档的字号与间距逐字在（改一档就会静默变松/变紧）', () => {
    const { body } = ruleBody('[data-density=\'compact\']');
    expect(varOf(body, '--density-text-body')).toBe('0.8125rem');
    expect(varOf(body, '--density-text-sub')).toBe('0.75rem');
    expect(varOf(body, '--density-text-title')).toBe('0.875rem');
    expect(varOf(body, '--density-space-2xs')).toBe('0.25rem');
    expect(varOf(body, '--density-space-xs')).toBe('0.25rem');
    expect(varOf(body, '--density-space-sm')).toBe('0.5rem');
    expect(varOf(body, '--density-space-md')).toBe('1rem');
    expect(varOf(body, '--density-space')).toBe('0.5rem');
  });

  it('豁免档给全的一组（只写半组会让嵌套的紧凑壳继承外层的宽松值）', () => {
    const { body } = ruleBody('[data-density=\'default\']');
    expect(varOf(body, '--density-text-sub')).toBe('0.8125rem');
    expect(varOf(body, '--density-text-title')).toBe('1rem');
    expect(varOf(body, '--density-space-xs')).toBe('0.5rem');
    expect(varOf(body, '--density-space-sm')).toBe('0.75rem');
    expect(varOf(body, '--density-space-md')).toBe('1.25rem');
    expect(varOf(body, '--density-space')).toBe('1rem');
  });

  it('@theme inline 的密度别名回指变量（不允许烤成字面量：作用域会切不动）', () => {
    const { body } = ruleBody('@theme inline');
    expect(varOf(body, '--text-body')).toBe('var(--density-text-body)');
    expect(varOf(body, '--text-sub')).toBe('var(--density-text-sub)');
    expect(varOf(body, '--text-title')).toBe('var(--density-text-title)');
    expect(varOf(body, '--leading-body')).toBe('var(--density-leading)');
    expect(varOf(body, '--spacing-hair')).toBe('var(--density-space-2xs)');
    expect(varOf(body, '--spacing-snug')).toBe('var(--density-space-sm)');
    expect(varOf(body, '--spacing-roomy')).toBe('var(--density-space-md)');
    expect(varOf(body, '--spacing-page')).toBe('var(--density-space)');
  });

  it('暗色变体仍认属性（`shadcn init` 会把它覆盖回 .dark，覆盖后 dark: 全部静默失效）', () => {
    expect(source).toContain('@custom-variant dark (&:where([data-theme=\'dark\'], [data-theme=\'dark\'] *));');
  });
});


/**
 * Tailwind **产出物**那一半：`@theme inline` 漏写 `inline` 时，`globals.css` 的字面值
 * 一个都不会变（静态块照样绿），只有构建产物会把 `text-body` 烤成 `0.75rem`，
 * 于是 `[data-density='default']` 再也切不动它。这一条直接编译真实样式表来拦它。
 */
describe('Tailwind 产出物：密度别名必须回指变量', () => {
  it('text-body / gap-snug / leading-body 都落成 var(--density-*)', async () => {
    const { compile } = await import('tailwindcss');
    const require = createRequire(import.meta.url);
    const cssDir = join(appRoot, 'app');
    const compiler = await compile(readFileSync(cssPath, 'utf8'), {
      base: cssDir,
      from: cssPath,
      async loadStylesheet(id, base) {
        if (id === 'tailwindcss/theme.css') {
          const path = require.resolve('tailwindcss/theme.css');
          return { path, content: readFileSync(path, 'utf8'), base: dirname(path) };
        }
        if (id === 'tailwindcss/utilities.css') return { path: cssPath, content: '@tailwind utilities;', base: cssDir };
        if (id === 'tw-animate-css') {
          const path = join(appRoot, 'node_modules', 'tw-animate-css', 'dist', 'tw-animate.css');
          return { path, content: readFileSync(path, 'utf8'), base: dirname(path) };
        }
        const path = resolve(base, id);
        return { path, content: readFileSync(path, 'utf8'), base: dirname(path) };
      },
    });
    const output = compiler.build(['text-body', 'text-sub', 'leading-body', 'gap-snug', 'p-page']);

    expect(output, 'text-body 被烤成字面量：@theme 漏了 inline，作用域切不动').toContain(
      'font-size: var(--density-text-body)',
    );
    expect(output, 'leading-body 被烤成字面量').toContain('line-height: var(--density-leading)');
    expect(output, 'gap-snug 被烤成字面量').toContain('gap: var(--density-space-sm)');
    expect(output, 'p-page 被烤成字面量').toContain('padding: var(--density-space)');
    // 反面：工具类声明里不许出现被烤死的紧凑值（`0.75rem` 只允许出现在变量定义里）
    expect(output).not.toMatch(/\.text-body \{[^}]*font-size: 0\.75rem/);
    expect(output).not.toMatch(/\.gap-snug \{[^}]*gap: 0\.5rem/);
  });
});
