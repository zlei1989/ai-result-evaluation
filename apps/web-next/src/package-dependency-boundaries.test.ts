// @vitest-environment node
/**
 * **依赖清单与方向表的一致性**（AGENTS.md 的「依赖方向」那一节）。
 *
 * 为什么需要这一条：那张表此前**只写在文档里**，`pnpm lint` 与 `pnpm typecheck` 都看不见它，
 * 于是「清单在撒谎」可以一直活下去。真机实例（2026-10-03）：`@aieval/client` 的 `package.json`
 * 把 `@aieval/ui` 写在 **`dependencies`** 里，而表里 client 的字面依赖只有 contracts
 * ⇒ 「client 不依赖 ui」这条原则从"没被违反"退化成"没被检查过"。
 * 这个错位**没有任何可观测后果**（client 包里对 ui 只有一条 `export type`，编译期即被抹掉），
 * 所以它不会被任何运行时用例逮住——只能靠读清单本身。
 *
 * 判据分三段，都只读 `package.json`、不加载任何模块：
 *   1. **内部依赖必须在表里**：每个包的 `dependencies` 里出现的 `@aieval/*`，
 *      必须是表里那一行为它列出的包（表是**真源**，本文件不另抄一份清单）；
 *   2. **反向也要**：表里列出、而清单里**没有**的边同样是错位（少声明会在运行期才炸）；
 *   3. **类型期的边只准放 devDependencies**：`devDependencies` 里的 `@aieval/*` 不算运行时边，
 *      与表无关（`client` 就是这样持有 `@aieval/ui` 的）。
 *
 * 解析方式刻意用**正则读 AGENTS.md 的代码块**而不是在这里硬编码一份依赖表：硬编码等于造出
 * 第二个真相源，两处一旦漂移，这条守卫就会替错的那一份背书。表改了、解析不到，本文件**报错**
 * 而不是静默跳过（漏收集一整个包是静默漏测，解析失败同样不能静默）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 仓库根：本文件在 `apps/web-next/src/` 下 */
const repoRoot = join(import.meta.dirname, '..', '..', '..');

/**
 * 8 个包 → 目录。**这张映射必须与 `eslint.shared.ts` 的 `PACKAGE_DIRS` 同集**：
 * 漏一个包就等于那个包的清单不受检（而这条守卫的存在意义正是「清单没人看」）。
 */
const PACKAGE_DIRS: Record<string, string> = {
  core: 'packages/server/core',
  agents: 'packages/server/agents',
  evaluator: 'packages/server/evaluator',
  api: 'packages/server/api',
  contracts: 'packages/server/contracts',
  ui: 'packages/client/ui',
  client: 'packages/client/client',
  'web-next': 'apps/web-next',
};

/**
 * 从 `AGENTS.md` 的依赖方向代码块里解析出 `包 → 允许的内部依赖`。
 *
 * 认的正是那一节的字面形状：左边包名、箭头（**对齐空格可有可无**——真源里既有
 * `core     → contracts` 也有 `evaluator→ agents`）、右边到行尾。
 * 右侧写的是**裸包名**（`contracts` / `core`，不带 `@aieval/` 前缀），
 * 故这里按「裸名 → 包目录里存在这个包」判定，而不是去找 `@aieval/` 字样。
 *
 * 箭头用 `String.fromCharCode(0x2192)` 现造、不写成字面量：本文件的读写路径上，
 * 多字节字符被工具链改写时**不会报错**，只会让匹配静默失败（实测踩过一次），
 * 而这条守卫的失效方式必须是「响亮的报错」。同理，解析不出 8 行就抛，不静默通过。
 */
function readDependencyTable(): Map<string, Set<string>> {
  const arrow = String.fromCharCode(0x2192);
  const doc = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  const table = new Map<string, Set<string>>();
  for (const raw of doc.split('\n')) {
    const line = raw.trim();
    const cut = line.indexOf(arrow);
    if (cut <= 0) continue;
    const name = line.slice(0, cut).trim();
    if (!(name in PACKAGE_DIRS)) continue;
    // 右侧按裸包名收录：表里写的是 `api / core / ui / client / contracts` 这种形状
    const allowed = new Set(
      (line.slice(cut + arrow.length).match(/[a-z][a-z0-9-]*/g) ?? []).filter((word) => word in PACKAGE_DIRS),
    );
    table.set(name, allowed);
  }
  if (table.size !== Object.keys(PACKAGE_DIRS).length) {
    throw new Error(
      `AGENTS.md 的依赖方向表只解析出 ${table.size} 行（应有 ${Object.keys(PACKAGE_DIRS).length} 行）` +
        '：表的排版变了，这条守卫已失效——先修解析，别让它静默通过',
    );
  }
  return table;
}

/** 读一个包的清单；文件不存在直接抛（路径写错不该表现成「这个包没问题」） */
function readManifest(name: string): PackageJsonShape {
  const dir = PACKAGE_DIRS[name];
  if (dir === undefined) throw new Error(`没有 ${name} 的目录映射`);
  return JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as PackageJsonShape;
}

/** 一个清单里声明的内部包名（去掉 `@aieval/` 前缀），按字典序，便于断言稳定的报错文案 */
function internalNames(manifest: Record<string, string> | undefined): string[] {
  return Object.keys(manifest ?? {})
    .filter((key) => key.startsWith('@aieval/'))
    .map((key) => key.slice('@aieval/'.length))
    .sort();
}

const table = readDependencyTable();

describe('依赖清单与 AGENTS.md 的方向表一致', () => {
  it('解析出来的表就是那 8 个包（解析失败的兜底：少一行就报错，不是静默）', () => {
    expect([...table.keys()].sort()).toEqual(Object.keys(PACKAGE_DIRS).sort());
    // 抽查两行，钉住解析结果不是「全都解析成空集」这种假绿
    expect([...(table.get('client') ?? new Set<string>())].sort()).toEqual(['contracts']);
    expect([...(table.get('api') ?? new Set<string>())].sort()).toEqual(['agents', 'contracts', 'core', 'evaluator'].sort());
  });

  /**
   * **清单不许出现表外的内部依赖**——这就是 `@aieval/client` 曾经犯的错。
   * 判据直接用表当允许集；`devDependencies` 不参与（它不建运行时边）。
   */
  it.each(Object.keys(PACKAGE_DIRS))('%s 的 dependencies 没有表外的内部包', (name) => {
    const allowed = table.get(name) ?? new Set<string>();
    const declared = internalNames(readManifest(name).dependencies);
    const extra = declared.filter((dep) => !allowed.has(dep));
    expect(extra, `${name} 声明了方向表里没有的内部依赖（表：${[...allowed].join(', ') || '无'}）`).toEqual([]);
  });

  /** 反向：表里有、清单里没有 = 少声明（运行期才炸的那种） */
  it.each(Object.keys(PACKAGE_DIRS))('%s 的 dependencies 覆盖了表里的每一条边', (name) => {
    const declared = new Set(internalNames(readManifest(name).dependencies));
    const missing = [...(table.get(name) ?? new Set<string>())].filter((dep) => !declared.has(dep)).sort();
    expect(missing, `${name} 少了方向表里的内部依赖`).toEqual([]);
  });

  /**
   * 类型期的边**只准**放 `devDependencies`：`@aieval/client` 用 `export type … from '@aieval/ui'`
   * 把界面模型的类型转给页面（AGENTS.md 明文允许），而它在运行时与 ui 之间没有任何 import。
   * 这条断言把「只活在类型期的边」钉在清单的哪一格上——写回 `dependencies` 就红。
   */
  it('client 对 ui 的引用落在 devDependencies（类型期边不进 dependencies）', () => {
    const manifest = readManifest('client');
    expect(internalNames(manifest.devDependencies)).toContain('ui');
    expect(internalNames(manifest.dependencies)).not.toContain('ui');
  });
});
