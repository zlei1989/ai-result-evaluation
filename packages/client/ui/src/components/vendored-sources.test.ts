// @vitest-environment node
/**
 * vendored 组件的说明符纪律：`components/ui/**` 与 `lib/utils.ts` 里**只允许**相对路径与 npm 包，
 * 不得出现 `@/` 开头的内部别名。
 *
 * 为什么需要这条守卫：这些文件是上游 registry 的产物，靠一份**机械改写表**落盘（registry 的兄弟件引用
 * → 相对路径，`cn` → `../../lib/utils`）。本包没有 `@/` 别名——tsconfig 没有 `paths`、vitest 没有
 * `resolve.alias`、Next 侧也没有约定——所以一条漏改就是一个**只在编译期才炸**的解析错；而
 * 「重跑 vendor 脚本」是最可能的日常动作：上游哪天多引一个兄弟件，脚本的改写表若没跟上，
 * 落盘的文件就带着 `@/` 进来。这条守卫是那条链路唯一的回归防线。
 *
 * 扫描面**自我定义**（`components/ui` 下全部 `.ts/.tsx`，排除用例），新增 vendored 件不必回来登记；
 * 但四个首件与 `lib/utils.ts` 单独钉存在性——目录改名或整体丢失时守卫不能因为「扫到 0 个文件」
 * 而空转成绿。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 包源码根（`src/`） */
const SRC = join(import.meta.dirname, '..');
const UI_DIR = join(SRC, 'components', 'ui');
const UTILS = join(SRC, 'lib', 'utils.ts');

/** 首批落盘的四个件：它们缺一个，`@/` 守卫的扫描面就不再覆盖「组件」这一半 */
const EXPECTED_COMPONENTS = ['button.tsx', 'card.tsx', 'badge.tsx', 'separator.tsx'];

/**
 * `@/` 开头的内部别名（上游 registry 的兄弟件引用、`@/lib/utils` 那一类）。
 * 单双引号都认：上游产物统一用双引号，但手改一处就可能换引号，而换引号不该让守卫失明。
 * 只看 `from` 说明符：注释里提到别名是说明文字，不是可执行的解析请求。
 */
const INTERNAL_ALIAS = /\bfrom\s+['"]@\//;

/** 递归收集目录下的 `.ts` / `.tsx`；目录不存在时返回空（由存在性用例负责报红） */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** 扫描面：相对 `src/` 的路径，排序只为让失败信息稳定 */
const SCANNED = [...walk(UI_DIR), UTILS]
  .filter((file) => existsSync(file))
  .filter((file) => !/\.test\.tsx?$/.test(file))
  .map((file) => relative(SRC, file))
  .sort();

describe('vendored 源码的说明符纪律', () => {
  it('四个首件与 lib/utils.ts 都在扫描面上（守卫不空转）', () => {
    for (const name of EXPECTED_COMPONENTS) {
      expect(SCANNED, `components/ui/${name} 缺失：vendored 组件没落盘`).toContain(
        join('components', 'ui', name),
      );
    }
    expect(SCANNED, 'lib/utils.ts 缺失：`cn` 的落点没落盘').toContain(join('lib', 'utils.ts'));
  });

  it('扫描面里没有 @/ 内部别名', () => {
    const hits = SCANNED.flatMap((file) =>
      readFileSync(join(SRC, file), 'utf8')
        .split('\n')
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => INTERNAL_ALIAS.test(text))
        .map(({ line, text }) => `${file}:${line}: ${text.trim()}`),
    );
    // 修法：补 vendor 脚本的改写表（registry 的兄弟件引用 → 相对路径），再重跑脚本；
    // **不要**为了让它变绿去建 `@/` 别名——那要把 tsconfig / vitest / Next 三处都搭起来。
    expect(hits, '`@/` 别名在本仓无解析路径，落盘即编译错').toEqual([]);
  });
});
