/**
 * 共享 ESLint flat 配置 + 分层边界规则工厂。
 * 边界即架构：core/agents/evaluator/api/contracts 禁框架；ui 禁 client/api/apps；client 禁 apps。
 * 注意：禁止名单用 `patterns.group` 展开而不是 `paths.name`——后者是精确匹配，
 * `next/*` 这类条目会被 `next/headers` 这样的子路径绕过。
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
 */
const esmOnlyRequire: { selector: string; message: string } = {
  selector: "CallExpression[callee.name='require']",
  message: '源码一律 ESM：改用 import（仓库内不允许 require）',
};

export const baseConfig: Linter.Config[] = [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/out/**', '**/coverage/**'] },
  {
    files: ['**/*.{ts,tsx}'],
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
  return `[分层边界] ${pkg} 禁止 import ${name}（见 docs/superpowers/specs/2026-09-22-scaffold-design.md §4.1）`;
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

/** 按包名生成带边界约束的配置（与 baseConfig 合并使用） */
export function withBoundary(pkg: PackageName): Linter.Config[] {
  const names = FORBIDDEN[pkg];
  if (names.length === 0) return [...baseConfig];
  // 说明符必须整串等于某个禁止名，或等于「禁止名 + / 至少一个字符」（子路径）。
  // `^…$` 锚定是必要的：没有它 `react` 会顺带匹配 `react-dom`。
  const forbiddenSpecifier = `^(${names
    // 名称里的正则元字符先转义（`@aieval/client` 的 `/`、`next/*` 的 `*` 都要按字面处理）
    .map((name) => escapeRegExp(name.replace(/\/\*$/, '')))
    .join('|')})(\\/.+)?$`;

  return [
    ...baseConfig,
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
            selector: `CallExpression[callee.name='require'] > Literal.arguments:first-child[value=/${forbiddenSpecifier}/]`,
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
