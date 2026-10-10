/**
 * 共享 ESLint flat 配置 + 分层边界规则工厂。
 * 边界即架构：core/agents/evaluator/api/contracts 禁框架；ui 禁 client/api/apps；client 禁 apps。
 * 注意：禁止名单用 `patterns.group` 展开而不是 `paths.name`——后者是精确匹配，
 * `next/*` 这类条目会被 `next/headers` 这样的子路径绕过。
 *
 * 导出两个入口，共用同一份 `boundaryConfigs()`，因此**不存在抄两遍漂移**：
 * - `withBoundary(pkg)`：包内 `eslint.config.ts` 用，glob 相对包根；
 * - `workspaceConfig`：仓库根 `eslint.config.ts` 用，把每个包的 glob 前缀到自己的目录，
 *   于是 `eslint .` 在根上跑**一个**进程就能覆盖全仓（8 个包各起一个进程时，
 *   实测 14.5s 里有 12s 是 8 次 Node + 插件加载的启动税，94 个文件本身不到 1s）。
 */
import type { Linter } from 'eslint';
import stylistic from '@stylistic/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import tsParser from '@typescript-eslint/parser';

export type PackageName =
  | 'core' | 'agents' | 'evaluator' | 'api' | 'contracts' | 'ui' | 'client' | 'web-next';

/** 各包禁止 import 的模块名（精确名或带 * 的通配名） */
const FORBIDDEN: Record<PackageName, string[]> = {
  core: ['next', 'next/*', 'react', 'react-dom'],
  // agents 允许三家 agent SDK 与 HTTP 客户端，但同样不许知道框架与 React 的存在
  agents: ['next', 'next/*', 'react', 'react-dom'],
  evaluator: ['next', 'next/*', 'react', 'react-dom'],
  api: ['next', 'next/*', 'react', 'react-dom'],
  contracts: ['next', 'next/*', 'react', 'react-dom'],
  ui: ['@aieval/client', '@aieval/api', '@aieval/web-next', 'next', 'next/*'],
  client: ['@aieval/web-next'],
  'web-next': [],
};

/** 各包在仓库中的目录（相对仓库根，用 `/` 分隔）：根配置据此把包级 glob 限定到对应目录 */
const PACKAGE_DIRS: Record<PackageName, string> = {
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
 * 源码一律 ESM：仓库里不允许出现 `require()`。
 * 为什么必须显式禁止：三处都不拦它——`@types/node` 声明了 `var require` 所以 tsc 过、
 * 边界规则的 no-restricted-syntax 只按禁止说明符过滤所以 eslint 过、
 * Vitest 的 SSR runner 会给模块注入一个模块级 require 所以运行时也过。
 * 实测在 api 包里写 require('node:os') 能 12/12 全绿通过，就是这条规则要拦的情形。
 *
 * 做成常量是因为它必须在**两个** no-restricted-syntax 数组里各出现一次（baseConfig 一处、
 * withBoundary 一处）：flat config 对同一条规则是**整体替换**而不是选项合并，withBoundary
 * 生成的对象排在 baseConfig 之后、匹配同一批文件，会把 baseConfig 的这条整个盖掉。
 * 同一段中文文案抄两遍正是最容易漂移的写法，所以只留这一份真源。
 *
 * 选择器里 `callee.name` 的值用双引号包：外层字符串被 `@stylistic/quotes` 钉死成单引号，
 * 内层再写单引号就得转义；esquery 对两种引号完全等价，故让内层改用双引号。
 */
const esmOnlyRequire: { selector: string; message: string } = {
  selector: 'CallExpression[callee.name="require"]',
  message: '源码一律 ESM：改用 import（仓库内不允许 require）',
};

export const baseConfig: Linter.Config[] = [
  // 生成物一律不 lint。`**/probe/dumps/**` 这一条是**必须显式写**的（2026-10-01 实测）：
  // 它在 `.gitignore` 里（探测 dump 可能含网关返回的敏感原文，不入库），而 **ESLint 的 flat config
  // 不读 `.gitignore`**（只默认忽略 `node_modules`）⇒ 两者的忽略集合本来就不一致。
  // 后果不是「多扫几个文件」：真机探针会把第三方插件模板整棵克隆进 `probe/dumps/**`，
  // 里面就有 `.ts`（实测一次 63 个）⇒ `pnpm lint` 从 0 报错变成 **14050 条**（几乎全是
  // 「Strings must use singlequote」这类对着别人的模板发的报错），一条门禁指令就这样被一次探测跑红。
  // 口径：**凡是 `.gitignore` 里以「生成物」为由忽略的目录，只要可能落 `.ts`/`.tsx`，都要在这里再写一遍。**
  // `**/.vitepress/cache/**` 与 `**/.vitepress/dist/**` 是 2026-10-09 补的同类（知识库构建产物）：
  // VitePress 的依赖预打包把第三方 `.js` 整份复制进 `cache/deps/`，其中一条 `es5/no-es6-methods`
  // 会以「Definition for rule … was not found」让 `pnpm lint` 直接退出码 1（`.gitignore:26-27` 已忽略它们，
  // 但 flat config 不读 `.gitignore`，故必须在这里再写一遍）。
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/probe/dumps/**',
      '**/.vitepress/cache/**',
      '**/.vitepress/dist/**',
    ],
  },
  {
    // files 含 `.mts`：VitePress 的站点配置是 ESM-only，配置文件必须用 `.mts` 后缀
    // （`.ts` 会走 require 通路，报 "ESM file cannot be loaded by require"）。
    // 根 glob 原来不含该后缀，docs 工具链文件会成为 lint 盲区，故显式补上；
    // 对 8 个包的现有文件是纯增量，不触碰 boundaryConfigs 的任何一条。
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: { parser: tsParser },
    plugins: { '@stylistic': stylistic, 'import-x': importX, 'unused-imports': unusedImports },
    // import-x 内置的 node 解析器默认只认 ['.mjs', '.cjs', '.js', '.json', '.node']，不含 TS；
    // 本仓所有包都直出 TS 源码、import 说明符又按 TS 习惯不带扩展名，于是下面那条
    // `no-relative-packages` 内部的 resolve() 会解析失败并**静默 return**（规则源码第 18–22 行）。
    // 实测：只开规则不加这段 settings 时，`import '../../../client/ui/src/index'` 仍以退出码 0 通过。
    // 补上 TS 扩展名，这条边界规则才真的会开火。
    settings: {
      'import-x/resolver': {
        node: { extensions: ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.jsx', '.json'] },
      },
    },
    rules: {
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/indent': ['error', 2],
      'unused-imports/no-unused-imports': 'error',
      'import-x/no-duplicates': 'error',
      // 相对路径的跨包 import 是边界规则的一个盲区：no-restricted-imports 只看模块说明符，
      // 而 `../../client/ui/src/index` 这种写法（本仓所有包都直出 TS 源码，所以它真的能跑通）
      // 既不是包名、也不在禁止名单里，会以零信号绕过分层。这一条把相对路径的跨包引用一并关掉。
      'import-x/no-relative-packages': 'error',
      // 仓库级：源码一律 ESM，任何 require() 都不允许（理由见 esmOnlyRequire 的 JSDoc）。
      // 注意它只对 FORBIDDEN 为空的包（web-next）真正生效：其余包的 withBoundary 会用
      // 自己的 no-restricted-syntax 把它整条替换掉，故那边必须再放一份。
      'no-restricted-syntax': ['error', esmOnlyRequire],
    },
  },
  // 各包根部的 eslint.config.ts / vitest.config.ts / next.config.ts 必须相对引用仓库根的
  // 共享配置（`../../../eslint.shared`、`../../../vitest.node`，见 brief Step 10），而仓库根
  // package.json 自带 name，会被上面那条规则判成「引用了另一个包」。这些文件既不发包、
  // 也不会被任何包的源码 import，不构成分层绕过路径，故豁免。
  // 豁免名单必须**按文件名**限定死，不能写成 `**/*.config.{ts,tsx}`：那样是任意深度匹配，
  // `packages/server/core/src/foo.config.ts` 这类产品模块会被顺带豁免掉，
  // 跨包相对引用又能零信号通过——实测过，退化成「对老实人有效」。
  {
    files: ['**/{eslint,vitest,next}.config.{ts,tsx}'],
    rules: { 'import-x/no-relative-packages': 'off' },
  },
];

/** 边界违规时的报错文案：必须指明是哪个包、禁了什么、去哪看规则 */
function boundaryMessage(pkg: PackageName, name: string): string {
  return `[分层边界] ${pkg} 禁止 import ${name}（见 docs/architecture/layering.md「依赖方向」）`;
}

/**
 * 把禁止名单展开为 no-restricted-imports 的 patterns 组：
 * 精确名匹配自身，非通配名另加「名/*」子路径组；已带 * 的保持通配。
 */
function toGroups(pkg: PackageName, names: string[]): Array<{ group: string; message: string }> {
  return names.flatMap((name) => {
    const message = boundaryMessage(pkg, name);
    if (name.endsWith('*')) return [{ group: name, message }];
    return [
      { group: name, message },
      { group: `${name}/*`, message },
    ];
  });
}

/** 按包名生成带边界约束的配置（与 baseConfig 合并使用；glob 相对**包根**） */
export function withBoundary(pkg: PackageName): Linter.Config[] {
  return [...baseConfig, ...boundaryConfigs(pkg)];
}

/**
 * 仓库根配置：`eslint .` 一次覆盖全仓，取代「每个包各起一个 eslint 进程」。
 * 做法是把每个包的边界配置**限定到该包的目录**：包内那条匹配任意深度 ts/tsx 的
 * `files` glob，前缀后变成 `packages/server/core/` 下面的同款 glob。包与包之间目录
 * 不重叠，flat config 的「后者整体替换前者」因而永远不会跨包误伤。
 *
 * `baseConfig` 只放一次且**不加前缀**：它自带的那条 ignores-only 对象是仓库级忽略
 * （忽略任意深度的 node_modules / dist / .next 等），按包前缀化反而会把忽略范围
 * 缩到各包内部。
 */
export const workspaceConfig: Linter.Config[] = [
  ...baseConfig,
  ...(Object.entries(PACKAGE_DIRS) as Array<[PackageName, string]>).flatMap(([pkg, dir]) =>
    scopeToDir(dir, boundaryConfigs(pkg)),
  ),
];

/**
 * 把包级配置里的 `files` / `ignores` 前缀到包目录。
 * 只处理后两个键：其余键（rules / plugins / languageOptions / settings）与路径无关，原样透传。
 *
 * 包级 glob 只有两种形态，前缀化对二者都保持语义：
 * - 以 `**` 开头的「任意深度」glob —— 拼上包目录后就是「该包目录下的任意深度」；
 * - 以 `**` 开头的相对精确路径（web-next 的 `next-env.d.ts`）—— 拼上包目录后
 *   正好是相对仓库根的该文件路径。
 */
function scopeToDir(dir: string, configs: Linter.Config[]): Linter.Config[] {
  return configs.map((config) => {
    const scoped: Linter.Config = { ...config };
    if (config.files) scoped.files = config.files.map((pattern) => `${dir}/${pattern}`);
    if (config.ignores) scoped.ignores = config.ignores.map((pattern) => `${dir}/${pattern}`);
    return scoped;
  });
}

/**
 * 包级边界配置（不含 baseConfig）。glob 相对包根，故既能被包内 `eslint.config.ts`
 * 直接导出，也能被 `workspaceConfig` 前缀化后复用。
 */
function boundaryConfigs(pkg: PackageName): Linter.Config[] {
  const names = FORBIDDEN[pkg];
  const configs: Linter.Config[] = [
    // next dev / next build 生成的类型声明：内容是双引号的三斜线引用与指向 .next/ 的相对
    // import，既不由本仓维护（文件头自述「should not be edited」）也已被 gitignore，
    // 故不纳入 lint。放在包级配置里而不是根配置里，是为了 `pnpm --filter @aieval/web-next lint`
    // 与根 `eslint .` 两条路径都覆盖到（根路径下这条会被前缀化成 apps/web-next/next-env.d.ts）。
    ...(pkg === 'web-next' ? [{ ignores: ['next-env.d.ts'] }] : []),
  ];
  if (names.length === 0) return configs;
  // 说明符必须整串等于某个禁止名，或等于「禁止名 + / 至少一个字符」（子路径）。
  // `^…$` 锚定是必要的：没有它 `react` 会顺带匹配 `react-dom`。
  const forbiddenSpecifier = `^(${names
    // 名称里的正则元字符先转义（`@aieval/client` 的 `/`、`next/*` 的 `*` 都要按字面处理）
    .map((name) => escapeRegExp(name.replace(/\/\*$/, '')))
    .join('|')})(\\/.+)?$`;

  return [
    ...configs,
    {
      files: ['**/*.{ts,tsx}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: toGroups(pkg, names).map(({ group, message }) => ({ group: [group], message })),
          },
        ],
        // no-restricted-imports 的访问器只覆盖静态 import / export 语句（ImportDeclaration、
        // ExportNamedDeclaration、ExportAllDeclaration、TSImportEqualsDeclaration），
        // **不看动态 import，也不看 require** —— 实测 `() => import('react')` 与
        // `require('react-dom')` 在 core 里都能以退出码 0 通过 lint。
        // 故这里显式补上这两种绕过路径；漏了它，边界就只是「对老实人有效」。
        //
        // 选择器必须按**说明符**过滤，不能用裸的 `ImportExpression` /
        // `CallExpression[callee.name='require']`：那样会连同包自己的 `import('./x')`、
        // `require('./m')` 一起禁掉，既挡住 ui/client 之后要做的 React.lazy 代码分割，
        // 又给出与包名无关的误导文案。
        'no-restricted-syntax': [
          'error',
          // 这一条在 baseConfig 里已经有了，这里**必须再放一遍**：flat config 对同一条规则是
          // 整体替换而非选项合并，本对象排在 baseConfig 之后且匹配同一批文件，只用边界那两条
          // 会把 baseConfig 里的 ESM 禁 require 整条盖掉。实测（core/src/index.ts 里写
          // `require('react-dom')`）：不重复这一条时只剩边界规则的 1 条报告，而
          // `require('node:os')` 这类非禁止模块会**一条都不报**——正是这条规则要堵的盲区。
          esmOnlyRequire,
          {
            selector: `ImportExpression[source.value=/${forbiddenSpecifier}/]`,
            message: `[分层边界] ${pkg} 禁止动态 import 该模块（${names.join(' / ')}）`,
          },
          {
            selector: `CallExpression[callee.name="require"] > Literal.arguments:first-child[value=/${forbiddenSpecifier}/]`,
            message: `[分层边界] ${pkg} 禁止 require 该模块（${names.join(' / ')}）——require 不受 import 规则约束`,
          },
        ],
      },
    },
  ];
}

/** 转义正则元字符：禁止名单里的 `@aieval/client`、`next/*` 都要按字面匹配 */
function escapeRegExp(input: string): string {
  // `/` 必须一起转义，不能省：这条正则最终被拼进 esquery 选择器的 `/…/` 字面量
  // （`[source.value=/…/]`）。`/` 在 RegExp 里不是元字符，所以常见的 escapeRegExp
  // 实现都漏掉它；可一旦漏掉，`@aieval/client` 的 `/` 会**提前闭合字面量**，
  // esquery 抛 `Invalid regular expression: /^(@aieval/: Unterminated group`，
  // ESLint 直接以退出码 2 崩溃——ui / client 两个包的禁止名单里都有 `@aieval/*`，
  // 必然踩中（core 这类名单里没有 `/` 的包反而看不出来）。转义成 `\/` 后语义不变。
  return input.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
