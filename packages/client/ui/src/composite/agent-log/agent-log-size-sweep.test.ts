// @vitest-environment node
/**
 * 「执行日志里每个带 `size` 的组件都写死 `size="small"`」这条口径的可执行形式（用户 2026-10-03 口径）。
 *
 * 它是**静态扫描**而不是渲染断言：这类漂移没有任何运行时症状（`size` 缺一格，页面照样工作，
 * 只是那一格比旁边大一圈），既有的行为守卫会全绿——只有专门扫源文件的一条能拦住。
 * 与 `agent-log-layering.test.ts` 同一手法（用 `fs` 读本目录的源文件）。
 *
 * 三条边界，都是**刻意**的：
 *   1. **按组件名逐个查开标签**，不是「整份文件里有 `size="small"` 就算过」——后者只被一个按钮满足，
 *      剩下九处全漏（本仓多次实测过这类「无区分力的守卫」）；
 *   2. **查的是「开标签里的 `size`」**，所以抽屉几何那两处（`size="max(50vw, 800px)"` /
 *      `size={NESTED_DRAWER_SIZE}`）不是靶子：它们给的是**宽度**，不在 `SIZED_COMPONENTS` 里，
 *      且 `Drawer` 的 `size` 类型是 `'default' | 'large' | number | string`——收不到 `'small'`；
 *   3. **`Tag` / `Listy` 不在扫描面上**：antd 6.6.5 实测 `TagProps` 与 `ListyProps` 都没有 `size`，
 *      写上去只会多一个读的人以为生效的属性。**最后两条用例**把这条依据钉住，
 *      antd 升版后不至于靠记忆（升版真加了 `size` 时这两条会红，那就是该回来扩扫描面的信号）。
 *
 * `Badge` 是唯一「写了也不改变外观」的一格：`Badge.js` 把这个值只拼进**计数**徽标的
 * `ScrollNumber`（`${prefixCls}-count-sm`），status 圆点徽标那条分支不带它。
 * 仍写出来是因为这条口径取的是**一致性**（全件同形、可静态核对），而不是「哪一格偏大才压哪一格」。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 本目录（渲染件都在这一层） */
const dir = import.meta.dirname;
/** 依赖解析的起点用**本文件**：pnpm 的每个包都看得到自己声明过的依赖 */
const require_ = createRequire(import.meta.url);

/**
 * 依赖源码/类型声明的真实落点。
 *
 * **不用 `join(dir, '..', '..', …)` 拼相对路径**：数错几层就是个读不到的文件，而 `readFileSync`
 * 会以 ENOENT 把整份套件弄死（不是断言失败），症状离病因很远；pnpm 下连层数都不是固定的。
 * 分两跳：① 用 Node 解析 `包/相对路径`（hoist 与不 hoist 都能命中）；
 * ② 解析不到时（pnpm 把传递依赖放在**依赖者自己的** `node_modules` 里，例如 `@rc-component/listy`），
 *    从 `antd` 的安装位置再解析一次。
 */
function installedFile(specifier: string): string {
  try {
    return readFileSync(require_.resolve(specifier), 'utf8');
  } catch {
    const fromAntd = createRequire(require_.resolve('antd/package.json'));
    return readFileSync(fromAntd.resolve(specifier), 'utf8');
  }
}

/** 执行日志目录里**渲染**的源文件（`*.test.*` 不渲染；`types.ts` / `build-model.ts` / `fixtures.ts` 也不是渲染件） */
const RENDER_FILES = readdirSync(dir)
  .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
  .sort();

/**
 * 扫描面上的组件：全部来自 **antd 6.6.5 的 `*.d.ts` 实测**——`index.d.ts` 直接写 `size?:` 的
 * （`descriptions` / `input-number` / `switch` …），或 `button/Button.d.ts`、`card/Card.d.ts`、
 * `badge/Badge.d.ts` 的 Props 接口里有的。没有实测过的名字不进这张表：
 * 宁可少扫，也不要写一个在本仓根本查不到东西的靶子。
 *
 * `Table` 是 2026-10-07 加进来的（计划清单改成两列 small Table）：依据同样是实测
 * ——`antd/es/table/InternalTable.d.ts:52` 写 `size?: SizeType`。本目录里只有计划清单那一处
 * `<Table>`，故这一格是真的有靶子，不是凑数。
 */
const SIZED_COMPONENTS = ['Badge', 'Button', 'Card', 'Descriptions', 'InputNumber', 'Switch', 'Table'] as const;

/** 合法标识符起头 ⇒ `<Badge` 其实更长的名字（闭包组件的前缀） */
const IDENTIFIER_START = /^[A-Za-z0-9_$]/;

/**
 * 三种引号：单引号 / 双引号 / 反引号。
 *
 * 为什么用 `\u0022` 而不是字面量：本仓的 `@stylistic/quotes` 要求字符串一律单引号，
 * 于是双引号字符没有合法的字面量写法——写成 `'"'` 会被判「本可以用单引号」，
 * 写成 `"\""` 又会被 `avoidEscape: false` 拦下。转义码是这条规则唯一放行的写法。
 */
const QUOTES = new Set(['\'', '\u0022', '`']);

/** 命中的一次组件开标签：开标签原文 + 它在源码里的字符下标（报错时换算行号用） */
interface Hit {
  value: string;
  index: number;
}

/**
 * 找出一个组件在本文件里的**开标签**（含跨行属性）。
 *
 * 为什么要自己走一遍括号而不是怼一个正则：`items={[` 这种属性里有嵌套的 `[`/`{`，
 * `/<Card[^>]*>/` 会在第一个 `>` 上停住（或干脆误吞到下一个标签），于是「查整个开标签」
 * 就退化成「查它前面那半截」——漏报正是这么来的。
 *
 * 同理要**先跳过显式类型参数**（2026-10-07 补）：`<Table<TaskStep> …>` 里那个 `>` 也是尖括号，
 * 不是标签结束。不跳的话，扫描面上一出现泛型写法，这一格就报成「缺 `size="small"`」——
 * 明明是写了的（实测：`<Table<TaskStep>` 加了那四行 `size="small"` 仍然判红），
 * 而误伤会让人去改产品代码迁就守卫，那正是本仓不肯要的方向。
 */
function openingTags(source: string, name: string): Hit[] {
  const hits: Hit[] = [];
  let from = 0;
  for (;;) {
    const index = source.indexOf(`<${name}`, from);
    if (index === -1) break;
    // 只看标签起始，跳过 `<BadgeGroup` 这类前缀相同的名字
    const next = source[index + name.length + 1] ?? '>';
    if (IDENTIFIER_START.test(next)) {
      from = index + name.length + 1;
      continue;
    }
    // 紧跟组件名的那一对尖括号 = 类型参数（属性位置上不会出现 `<`，故只看这一个字符）：
    // 跳到它闭合之后，里面的 `>` 一个都不当标签结束。**`=>` 的 `>` 不算闭合**
    // （2026-10-07 复核实测：`<Table<Record<string, (row: string) => void>>` 不排除箭头就早停，
    // 于是「写了 size 仍判红」——那正是本条要消灭的误伤）。
    //
    // 已知局限（如实登记，与 `agent-log-layering.test.ts` 的 stripComments 同处置）：类型实参里的
    // **字符串字面量**含 `>`（`<Table<Foo<'>'>>`）仍会提前收尾。收尾之后落到哪一段**取决于后面的字符**：
    // 多半是误报（判红），但若接下来的 `}` 把深度压到负数，扫描会一路吞到下一个深度 0 的 `>`——
    // 那时整个开标签（连 `size="small"`）都进了 hit，于是**静默放过**。两种方向都实测到过
    // （`probe?: () => void` 那种形状就是后者），故这半句不能写成「只会误报」。
    // 本仓没有这种形态；真要写的时候得把这一段改成按引号走一遍。
    let start = index + name.length + 1;
    if (source[start] === '<') {
      let angle = 0;
      for (; start < source.length; start += 1) {
        const ch = source[start];
        if (ch === undefined) break;
        if (ch === '<') angle += 1;
        else if (ch === '>' && source[start - 1] !== '=') {
          angle -= 1;
          // 闭合成对之后多走一格：`<` 与 `>` 本身都不进下面那段扫描
          if (angle === 0) {
            start += 1;
            break;
          }
        }
      }
    }
    let depth = 0;
    let quote: string | null = null;
    let end = -1;
    for (let i = start; i < source.length; i += 1) {
      // 索引可能越界（`noUncheckedIndexedAccess`）⇒ 缺字符按「不是引号也不是括号」处理，
      // 循环本身由 `i < source.length` 收口
      const ch = source[i];
      if (ch === undefined) break;
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      // `>` 出现在字符串属性值里（`text="a > b"`）不算标签结束，故要跟引号
      if (QUOTES.has(ch)) quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1) break;
    hits.push({ value: source.slice(index, end), index });
    from = end;
  }
  return hits;
}

/** 扫描面上全部命中 */
function sizedHits(): { file: string; name: string; hit: Hit }[] {
  const hits: { file: string; name: string; hit: Hit }[] = [];
  for (const file of RENDER_FILES) {
    const source = readFileSync(join(dir, file), 'utf8');
    for (const name of SIZED_COMPONENTS) {
      for (const hit of openingTags(source, name)) hits.push({ file, name, hit });
    }
  }
  return hits;
}

describe('执行日志的 size 口径：带 size 的组件一律 small', () => {
  it('扫描面非空（RENDER_FILES 与 SIZED_COMPONENTS 都真的命中）', () => {
    // 没有这一条时，把 RENDER_FILES 的筛选条件写错（例如扩展名写错）会让下面两条**全绿地空转**
    expect(RENDER_FILES.length).toBeGreaterThan(10);
    expect(RENDER_FILES).toContain('agent-log-layout.tsx');
    expect(sizedHits().length).toBeGreaterThan(8);
  });

  it('每个带 size 的组件开标签都写着 size="small"', () => {
    const missing = sizedHits().filter(({ hit }) => !hit.value.includes('size="small"'));
    expect(
      missing.map(({ file, name, hit }) => {
        const source = readFileSync(join(dir, file), 'utf8');
        const line = source.slice(0, hit.index).split('\n').length;
        return `${file}:${line} <${name}> 缺 size="small"`;
      }),
    ).toEqual([]);
  });

  it('没有别的 size 值（medium / default / large 一个都不许留）', () => {
    const wrong = sizedHits().flatMap(({ file, name, hit }) => {
      const values = [...hit.value.matchAll(/size=(["'])([^"']*)\1/g)].map((match) => match[2] ?? '');
      const bad = values.filter((value) => value !== 'small');
      if (bad.length === 0) return [];
      const source = readFileSync(join(dir, file), 'utf8');
      const line = source.slice(0, hit.index).split('\n').length;
      return [`${file}:${line} <${name}> size=${bad.join(' / ')}`];
    });
    expect(wrong).toEqual([]);
  });

  it('`Tag` 不在扫描面上：antd 6 的 TagProps 没有 size', () => {
    const tagTypes = installedFile('antd/es/tag/index.d.ts');
    expect(tagTypes).not.toMatch(/\bsize\s*\??:/);
    expect(SIZED_COMPONENTS).not.toContain('Tag');
  });

  it('`Listy` 也不支持 size，spec 表格里那句「Listy size="small"」是 antd 6 的过期写法', () => {
    const listyTypes = installedFile('@rc-component/listy/es/List.d.ts');
    expect(listyTypes).not.toMatch(/\bsize\s*\??:/);
    // 2026-10-07：任务清单改成 `Table`（那一处的 size 已由上面 `SIZED_COMPONENTS` 那一格守着），
    // 还在 `Listy` 面上的只剩这两处
    for (const file of ['ask-user-card.tsx', 'virtual-turn-list.tsx']) {
      expect(RENDER_FILES).toContain(file);
      expect(readFileSync(join(dir, file), 'utf8'), `${file} 给 Listy 写了一个不存在的属性`).not.toMatch(
        /<Listy[^>]*\ssize=/,
      );
    }
  });
});
