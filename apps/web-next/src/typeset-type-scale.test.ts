// @vitest-environment node
/**
 * markdown 正文**排版尺度**的静态守卫。
 *
 * jsdom 没有 CSS 级联，量不到渲染后的字号与段前距（真机那半只在冒烟里）。这里钉的是
 * `globals.css` 里「排版尺度（typeset）」那一块的**字面值与位置**——它坏掉时的症状是
 * 「标题比正文还小」「标题和段落的段前距一样」，两种都只有肉眼看得出，浏览器与构建都不报错。
 *
 * 四条断言各有各的靶子：
 * ① 字号档必须**每一级都严格大于正文**（14px）且级间递减——只判「有定义」时，
 *    把 `h5` 写回 `.875em` 那种「比正文小」的值照样绿；
 * ② 段前距档必须大于段落的 flow 且级间递减——差异化失效时标题与段落会贴着同样的距离；
 * ③ 块必须写在**层外**：层内规则打不过 typeset 自己的 `@layer components` 与
 *    `Streamdown` 根节点带来的 `@layer utilities`，尺度会静默失效（与密度档同一个坑）；
 * ④ 块里**不许出现 `!important`**：压过 typeset 靠的是层外位置，不靠优先级暴力——
 *    一旦用了 `!important`，后续任何正常覆盖都再也调不动这一块。
 *
 * 抠不到就抛：守卫不许静默失效（与 `globals-density.test.ts`、`global-styles.test.ts` 同一套做法）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = join(import.meta.dirname, '..');
const cssPath = join(appRoot, 'app', 'globals.css');
const source = readFileSync(cssPath, 'utf8');
/** 去掉注释再扫括号：注释里的花括号会把深度算歪 */
const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
/** 正文那一档（`--density-text-body` 的豁免值）：标题的每一级都必须严格大于它 */
const BODY_REM = 0.875;

/** 排版尺度块的变量组：从 `--typeset-heading-1` 的位置反推它所在的那条规则 */
function scaleBlock(): { body: string; open: number } {
  const at = css.indexOf('--typeset-heading-1');
  if (at < 0) throw new Error('globals.css 里找不到 --typeset-heading-1，本守卫无法核对');
  const open = css.lastIndexOf('{', at);
  if (open < 0) throw new Error('--typeset-heading-1 不在任何规则块里，本守卫无法核对');
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return { body: css.slice(open + 1, index), open };
    }
  }
  throw new Error('排版尺度块没有闭合，本守卫无法核对');
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

/** 从块体里读一个自定义属性的值；读不到就抛 */
function varOf(body: string, name: string): string {
  const matched = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body);
  const value = matched?.[1]?.trim();
  if (value === undefined) throw new Error(`排版尺度块里找不到 ${name}，本守卫无法核对`);
  return value;
}

/** rem 值转数字：`1rem` → 1 */
function remValue(value: string, context: string): number {
  const matched = /^([\d.]+)rem$/.exec(value);
  if (matched?.[1] === undefined) throw new Error(`${context} 的值不是 rem：${value}，本守卫无法核对`);
  return Number(matched[1]);
}

/** 六级标题的名字：`1`..`6` */
const LEVELS = [1, 2, 3, 4, 5, 6] as const;

describe('globals.css 的排版尺度（typeset）', () => {
  it('块带显眼的标记注释（它是标题档与块间距的唯一真源）', () => {
    expect(source).toContain('/* ── 排版尺度（typeset）');
  });

  it('块写在层外（写进 @layer 会被 typeset / utilities 反超、静默失效）', () => {
    const { open } = scaleBlock();
    // 变量组与标题规则必须都在顶层：层内声明永远输给后面的层
    expect(depthAt(css, open), '排版尺度块不在顶层，尺度会静默失效').toBe(0);
    for (const level of LEVELS) {
      const at = css.indexOf(`.typeset :where(h${level})`);
      if (at < 0) throw new Error(`globals.css 里找不到 h${level} 的标题规则，本守卫无法核对`);
      expect(depthAt(css, at), `h${level} 的标题规则不在层外`).toBe(0);
    }
  });

  it('每一级标题都严格大于 14px 正文，且 h1 > … > h6 递减', () => {
    const { body } = scaleBlock();
    const sizes = LEVELS.map((level) =>
      remValue(varOf(body, `--typeset-heading-${level}`), `--typeset-heading-${level}`),
    );
    for (const [index, size] of sizes.entries()) {
      expect(
        size,
        `h${index + 1} 的字号（${size}rem）没有严格大于正文（${BODY_REM}rem）`,
      ).toBeGreaterThan(BODY_REM);
    }
    expect(sizes, '标题字号没有逐级递减（h1 > h2 > … > h6）').toEqual(
      [...sizes].sort((left, right) => right - left),
    );
    // 逐条钉死方向：排序相等只说明「不递增」，这里要求每一对都严格递减
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index - 1]!, `h${index} 与 h${index + 1} 的字号没有拉开`).toBeGreaterThan(sizes[index]!);
    }
  });

  it('标题的段前距显著大于段落，且逐级递减（级别越高越松）', () => {
    const { body } = scaleBlock();
    const flow = remValue(varOf(body, '--typeset-flow'), '--typeset-flow');
    const gaps = LEVELS.map((level) =>
      remValue(varOf(body, `--typeset-heading-gap-${level}`), `--typeset-heading-gap-${level}`),
    );
    for (const [index, gap] of gaps.entries()) {
      expect(
        gap,
        `h${index + 1} 的段前距（${gap}rem）没有大于段落的 flow（${flow}rem）`,
      ).toBeGreaterThan(flow);
    }
    for (let index = 1; index < gaps.length; index += 1) {
      expect(gaps[index - 1]!, `h${index} 与 h${index + 1} 的段前距没有拉开`).toBeGreaterThan(gaps[index]!);
    }
  });

  it('段间距用 rem 而不是 em（em 会按各元素自己的字号结算，等于没有差异化）', () => {
    const { body } = scaleBlock();
    expect(varOf(body, '--typeset-flow'), '--typeset-flow 用了 em：标题与段落会算成同一个绝对值').toMatch(
      /^[\d.]+rem$/,
    );
  });

  it('字号档真的被消费（只定义变量、不绑规则等于没改）', () => {
    const { body } = scaleBlock();
    expect(body).toContain('--typeset-heading-1');
    for (const level of LEVELS) {
      const rule = new RegExp(
        `\\.typeset :where\\(h${level}\\) \\{[^}]*font-size: var\\(--typeset-heading-${level}\\)[^}]*margin-block-start: var\\(--typeset-heading-gap-${level}\\)[^}]*\\}`,
        's',
      );
      expect(css, `h${level} 的规则没有把字号档与段前距档绑上`).toMatch(rule);
    }
  });

  it('块里不许出现 !important（压过 typeset 靠层外位置，不靠优先级暴力）', () => {
    const { body } = scaleBlock();
    expect(body).not.toContain('!important');
  });

  /**
   * 块间距的**两侧**都要由本块给死。
   *
   * 缺口长什么样：`Streamdown` 根节点自带 `space-y-4`，而它是否被产出取决于 Tailwind 扫到
   * 哪个源文件——任何一处写出这个名字，utilities 层就会把子块的 `margin-block-start` 归零、
   * `margin-block-end` 统一成 1rem。只写段前距时，段与段的留白会从「20px 段前」变成
   * 「16px 段后 + 标题与正文贴死」，而字号仍然是对的 ⇒ 只有真机看得出，静态断言多半是绿的。
   */
  it('块间距两侧都由本块给死（utilities 归零一侧时也改不动它）', () => {
    const flowRule = /\.typeset :where\(p, ul, ol, dl, details, blockquote, table, figure, pre\) \{([^}]*)\}/.exec(css)?.[1];
    expect(flowRule, 'globals.css 里没有块间距那条规则').toBeDefined();
    expect(flowRule ?? '', '块间距没有写段前距').toContain('margin-block-start: var(--typeset-flow)');
    expect(flowRule ?? '', '块间距没有收段后距：utilities 的尾距会漏进来').toContain('margin-block-end: 0');

    for (const level of LEVELS) {
      const rule = new RegExp(`\\.typeset :where\\(h${level}\\) \\{([^}]*)\\}`, 's').exec(css)?.[1];
      expect(rule, `h${level} 的规则里没有收段后距`).toContain('margin-block-end: 0');
    }

    // 代码块是根节点的直接子元素：它也得有段前距，否则夹在段落之间会贴死
    expect(css).toMatch(/\.typeset > :where\(\[data-slot\]\) \{[^}]*margin-block-start: var\(--typeset-flow\)/s);
  });
});
