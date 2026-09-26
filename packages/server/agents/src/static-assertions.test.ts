// @vitest-environment node
/**
 * 源码级不变量：没有运行期可观测量，只能扫源码。
 * 「写对了」与「写错了」在注入正确的用例里表现完全一样——一份写 `process.env` 的实现照样能让
 * 单测全绿，差别只在并行跑两行时第二行拿到别人的密钥（Review Focus #2）。
 * 扫描范围是 agents 包自己的 src/**，**排除 *.test.ts**：本文件里的正则字面量与变异体样本会把规则自己判违规。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 包内全部非测试源码（相对 src），Windows 分隔符统一成正斜杠。
 * 扩展名走**正向白名单**：`.ts` 之外还有 `.mts` / `.cts` / `.js` / `.mjs` / `.cjs`
 * （评审 F2 的文件面：只认 `.ts` 时，往 `src/` 放一个 `.mjs` 就能整份绕开扫描）。
 * 必须保留 `*.test.ts` 排除：本文件自己的正则字面量与变异体样本会把规则判成违规。
 */
function sourceFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry) && !entry.endsWith('.test.ts'));
}

/** 命中即违规的写法：任何形式的宿主环境写入 */
const ENV_WRITE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\s*=[^=]/g, '点号赋值'],
  [/\bprocess\.env\s*\[/g, '下标读写（本仓只允许点号读取）'],
  [/\bObject\.assign\s*\(\s*process\.env/g, 'Object.assign 批量写入'],
  [/\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*\s*(\+\+|--|\+=|-=|\*=|\?\?=|\|\|=|&&=)/g, '自更新'],
  // 评审 F2 补的三类：与上面四条是「同一件事的另外几种写法」
  [/\bdelete\s+process\.env\b/g, 'delete 也是写入'],
  [/\bReflect\.set\s*\(\s*process\.env/g, 'Reflect.set 写入'],
  [/\bObject\.defineProperty\s*\(\s*process\.env/g, 'defineProperty 写入'],
];

/** 裸 `process.env` 令牌：别名写入（`const host = process.env; host.X = '1'`）唯一能落网的地方 */
const BARE_ENV_TOKEN = /\bprocess\.env\b/g;

/**
 * 紧跟在 `process.env` **之后**的只读形态：取属性 / 展开 / 作实参 / 结构收尾。
 * 为什么需要：写侧几乎总会在令牌后面出现 `=`、`[`、`,`、`;`，而只读用法后面必然是这些字符之一。
 */
const READ_ONLY_AHEAD = /^\s*(\)|\}|\]|\.|,)/;

/**
 * 紧挨在 `process.env` **之前**的只读形态：`Object.entries(process.env)` / `Object.keys(…)` / `Object.values(…)`。
 * 这三个是枚举宿主环境的合法读法（`buildSubprocessEnv` 就在用第一个）；`Object.assign(process.env` 刻意不在其中
 * ——它已经被上面那条显式模式拦住。
 */
const READ_ONLY_BEHIND = /\bObject\.(entries|keys|values)\s*\(\s*$/;

/**
 * 去掉注释，只留可执行源码。
 * 为什么必须去：本仓的注释里到处在说 `process.env`（`route.ts` 的不变量说明、`types.ts` 的字段注释），
 * 裸令牌规则会把它们全部判成违规——评审 F2 要求的「裸令牌纳入检查」只有在去注释后才可落地。
 * 已知局限（如实登记）：正则不区分字符串字面量里的 `//`，含 `://` 的字符串常量会被从该行截断，
 * 于是**同一行**注释后面的代码看不见——方向是漏报而不是误报，且本仓没有那种形态。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** 找出裸 `process.env` 令牌（排除只读白名单）；返回命中片段用于报错信息 */
function bareEnvTokens(text: string): string[] {
  const hits: string[] = [];
  for (const match of text.matchAll(BARE_ENV_TOKEN)) {
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 40), index);
    const after = text.slice(index + match[0].length, index + match[0].length + 120);
    if (READ_ONLY_BEHIND.test(before)) continue;
    if (READ_ONLY_AHEAD.test(after)) continue;
    hits.push(match[0]);
  }
  return hits;
}

/** 一份源码里全部违规写法（含裸令牌）；`readonly` 只用于报错文案 */
function envWriteViolations(source: string): string[] {
  const text = stripComments(source);
  const violations: string[] = [];
  for (const [pattern, why] of ENV_WRITE_PATTERNS) {
    const hits = text.match(pattern);
    if (hits !== null) violations.push(`${why}（${hits.join(' / ')}）`);
  }
  if (bareEnvTokens(text).length > 0) {
    violations.push('裸 process.env 令牌（别名写入，评审 F2）');
  }
  return violations;
}

/** 三家厂商包：只允许出现在动态 import() 与错误文案里（与 package.json 的一致性由专条断言钉住，评审 F7） */
const VENDOR_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  '@deepseek-ai/dsh-sdk-client',
] as const;

/**
 * 依赖清单里属于「厂商包」的那一类：作用域前缀 + 包名以 `-sdk` 或 `-sdk-client` 结尾。
 * **两条已知边界（复评 O4）**：① 这是**名称形状启发式**——将来新增一家不叫 `-sdk` 的厂商包
 * （例如 `@google/genai`）时，下面的交叉断言照样通过，`VENDOR_PACKAGES` 却静默失去覆盖；
 * ② 只读 `dependencies`，不读 `devDependencies` ——把厂商包挪到 devDependencies 也同样失去覆盖。
 * 也就是说这条断言守的是「现有三家的名字与位置不漂移」，不是「任何形式的厂商依赖都被纳入」。
 */
const VENDOR_DEPENDENCY_PATTERN = /-(?:sdk|sdk-client)$/;

/**
 * 顶层静态导入的**两条结构式**（阶段评审 M3 的修正版，逐字采纳）：
 * ```
 * ^\s*import(?![(])\s*(?:[^;]*?\bfrom\s*)?['"]<pkg>(?:/[^'"]*)?['"]
 * ^\s*export\s*(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]<pkg>(?:/[^'"]*)?['"]
 * ```
 * 为什么拆成两条：`import …` 与 `export … from` 的语法形状不同。旧的一条
 * `^\s*(import|export)(?![^;]*=)…` 靠「到下一个分号为止没有 `=`」来区分「真静态导入」与
 * 「只是把包名写成字符串常量」，代价是**误报**——`export async function f() { return import('@pkg'); }`
 * 与 `export function f() { return '@pkg'; }` 都不建立静态依赖，却双双命中（懒加载最自然的两种写法！
 * 假红会诱使人削弱这条断言，而它现在是 A6 唯一的网）。两条结构式把「`export` 后面必须直接是
 * `*` / `{…}` / `type …`」写进语法层，误报面归零。
 * 为什么还必须补三处（初稿的两条在评审探针里实测**新增三类漏报**）：
 *  - `export type { … } from` / `export type * from` ⇒ `(?:type\s+)?`；
 *  - `export*from'@pkg'`（零空格）⇒ `\s*` 而不是 `\s+`；
 *  - `export * as ns from` ⇒ `\*(?:\s+as\s+[\w$]+)?`。
 * 为什么 `[^;]*?` 只出现在第一条且要求 `\bfrom`：`import` 后面允许出现任意声明片段（含折行），但
 * 「非 `from` 形态」的 `import` 只剩 `import 'x'` / `import"x"`——`\s*` 后直接是引号即可，不需要
 * 让 `[^;]*` 去兜底，那样会把行首 `import(` 的动态导入也吞进来（`(?![(])` 是同一件事的显式守卫）。
 * **样本表就是这条判据的规格**：任何收紧/放宽都必须先扩样本表（见下面两条用例），别再靠「跑一遍全绿」判断。
 *
 * **下一次该动哪里（评审 §4(c)）：换成 TS AST，别再动正则。** 这条断言已经三次「收窄一次、开一个新洞」
 * （T5 空转 / `\b`→`[ \t]` 丢零空格 / `=` 前瞻没覆盖函数体），而洞与误报都来自**排版**（分号、空白、
 * 关键字、语句边界）而不是语义——继续改正则就是跟格式化规则赛跑。仓库已具备条件：`typescript` 已在
 * `devDependencies` 里，用 `ts.createSourceFile(file, text, ScriptTarget.Latest, true)` 遍历节点，
 * 判 `ts.isImportDeclaration` / `ts.isExportDeclaration` / `ts.isImportEqualsDeclaration` 的
 * `moduleSpecifier.text`，外加 `require('@pkg')` 调用即可；那时零空格 / 折行 / `export type` /
 * `export * as ns` 全部变成精确判定，`@stylistic/semi` 这条前提也随之消失。
 * **今天仍然存在的残余边界（如实登记）**：`const A = require('@pkg')` 与 `import A = require('@pkg')`
 * 两条**都抓不到**（正则做不到，AST 方案能覆盖）。
 */
function staticImportPatterns(packageName: string): readonly RegExp[] {
  // 包名里的 `@` / `/` / `.` 必须转义成字面量，否则 `@vendor/sdk` 会被当成正则元字符
  const escaped = packageName.replace(/[/@.]/g, '\\$&');
  const specifier = `${escaped}(?:/[^'"]*)?['"]`;
  return [
    new RegExp(`^\\s*import(?![(])\\s*(?:[^;]*?\\bfrom\\s*)?['"]${specifier}`, 'm'),
    new RegExp(`^\\s*export\\s*(?:type\\s+)?(?:\\*(?:\\s+as\\s+[\\w$]+)?|\\{[^}]*\\})\\s*from\\s*['"]${specifier}`, 'm'),
  ];
}

/** 任一条结构式命中即「静态导入了厂商包」（无状态：两条模式都不带 `g`，`test` 不推进 lastIndex） */
function staticallyImports(text: string, packageName: string): boolean {
  return staticImportPatterns(packageName).some((pattern) => pattern.test(text));
}

describe('源码级不变量', () => {
  it('源码里不出现任何写入宿主环境的写法（§5.6.4 不变量 2）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const violation of envWriteViolations(text)) offenders.push(`${file}：${violation}`);
    }
    expect(offenders).toEqual([]);
  });

  it('注释里提到 process.env 不算违规（去注释后才判裸令牌，评审 F2）', () => {
    const source = ['/** 本函数读 process.env 但绝不写入它 */', 'export const x = 1;'].join('\n');
    expect(envWriteViolations(source)).toEqual([]);
  });

  it('违规判定能拦住五种写入写法，并放行四种只读写法（评审 F2 的覆盖面）', () => {
    /**
     * 为什么单开一条：上面那条只能证明「当前源码干净」，不能证明规则**有覆盖**——别名写入与 `delete`
     * 在旧的四条正则下双双逃逸（评审的变异体 M6 存活）。这里把写法直接喂给判定本身，规则被改窄时这条会红。
     * 注意判定是「显式模式 + 裸令牌」两半合起来生效的：别名写入只有裸令牌能拦，而 `delete` / `Reflect.set`
     * 后面跟的是 `.` 或 `,`（属于只读形态），只能靠各自的显式模式——两半缺一都会留下洞。
     */
    const writeForms = [
      'process.env.AIEVAL_ENV_PROBE = "1";',
      'const host = process.env;\nhost.AIEVAL_ENV_PROBE_ALIAS = "1";',
      'delete process.env.AIEVAL_ENV_PROBE_DELETED;',
      'Reflect.set(process.env, "AIEVAL_ENV_PROBE_SET", "1");',
      'Object.defineProperty(process.env, "AIEVAL_ENV_PROBE_DEF", {});',
    ];
    for (const form of writeForms) {
      expect(envWriteViolations(form), `应当命中：${form}`).not.toEqual([]);
    }

    const readForms = [
      'Object.entries(process.env)',
      '{ ...process.env }',
      '{ ...process.env, HOME: "x" }',
      'expect(env.PATH).toBe(process.env.PATH);',
    ];
    for (const form of readForms) {
      expect(envWriteViolations(form), `不该命中：${form}`).toEqual([]);
    }
  });

  it('厂商包只能动态 import（顶层静态导入会把「一家故障」放大成「整包不可用」，A6）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const packageName of VENDOR_PACKAGES) {
        if (staticallyImports(text, packageName)) offenders.push(`${file}：静态导入 ${packageName}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('静态导入判定拦住 15 种写法（含折行、子路径、零空格、export type / export * as），并放行 14 种动态/无关写法（评审 M3）', () => {
    /**
     * 为什么单开一条：上一条只能证明「当前源码干净」，证明不了判据**有覆盖**——历史已经三次「没见过失败」
     * （T5 空转 / `\b`→`[ \t]` 丢零空格 / `=` 前瞻没覆盖函数体），说明红与绿都不足以判断它对不对。
     * 这里把写法直接喂给判据本身：判据被改窄成任一种旧形态，这条立刻红。
     * 样本都是字符串字面量，本文件是 `*.test.ts`（被 sourceFiles 排除），不会与上一条互相判违规。
     */
    // 用一个**合成的**包名，所有写法都对同一个判据断言（用真包名混着写会变成「A 家的样本配 B 家的模式」，
    // 那样即使模式正确也会假红）
    const packageName = '@vendor/sdk';
    const staticForms = [
      'import type { VendorModule } from "@vendor/sdk";',
      'import {\n  VendorModule,\n  other,\n} from "@vendor/sdk";',
      'import x from "@vendor/sdk/dist/index.js";',
      'import "@vendor/sdk";',
      'export type { VendorModule } from "@vendor/sdk";',
      // 复评 NEW-1：零空格写法全部合法，且本仓没有 keyword-spacing ⇒ lint / typecheck / 断言三闸都拦不住
      'import"@vendor/sdk";',
      'import{VendorModule}from"@vendor/sdk";',
      'import*as vendor from"@vendor/sdk";',
      'export*from"@vendor/sdk";',
      // 换行后接引号：旧模式（[^\n]*）与 [ \t] 版都漏，现在一并覆盖
      'import\n"@vendor/sdk";',
      // 阶段评审 M3 补的五种（初稿的两条结构式在这五种上实测 MISS：缺 (?:type\s+)?、缺 export\s*、缺 * as）
      'export { A, B } from "@vendor/sdk";',
      'export { default as X } from "@vendor/sdk";',
      'export type * from "@vendor/sdk";',
      'export * as ns from "@vendor/sdk";',
      'export{V}from"@vendor/sdk";',
    ];
    for (const form of staticForms) {
      expect(staticallyImports(form, packageName), `应当命中：${form}`).toBe(true);
    }

    const allowedForms = [
      'const module = await import("@vendor/sdk");',
      'const module = await import(\n  "@vendor/sdk"\n);',
      // **行首**的动态导入：`(?![(])` 放行它。注意（M3 的复核结论）：在两条结构式下，本样本其实由
      // 「`\s*` 后必须紧跟引号」天然挡住——`(?![(])` 真正守的是下面那条「同一句里出现 from "包名"」。
      'import(\n  "@vendor/sdk"\n);',
      '/** 本适配器只允许动态 import("@vendor/sdk")，绝不静态导入 */',
      'expect(message).toContain("@vendor/sdk");',
      // 跨语句不误伤：`[^;]*` 在分号处停住，别家包名不会把这一句连坐
      'import other from "other-package";\nconst text = "@vendor/sdk";',
      // 误报组（T7 实测上报，M3 修正版修好）：只是把包名写成字符串常量，**不建立静态依赖**，不该命中
      'export const X = "@vendor/sdk";',
      'const L = "@vendor/sdk"; export const X = L;',
      'export const X = /* c */ "@vendor/sdk";',
      // 转义样本：包名里的 `@` / `/` / `.` 必须当字面量，`@vendorXsdk` 不是 `@vendor/sdk`
      'import x from "@vendorXsdk";',
      // 误报组其二（评审 §4(a) 点名的「最自然的懒加载写法」）：函数体里出现 `import('@pkg')` 或引号包名
      'export async function f() { return import("@vendor/sdk"); }',
      'export function f() { return "@vendor/sdk"; }',
      'const loadRaw = createSdkLoader<unknown>(async () => import("@vendor/sdk"), NAME);',
      // `(?![(])` 的唯一承重形状：行首 `import(` 且**同一句里**出现 `from "包名"`（例如动态导入的参数区
      // 带一行注释）。去掉那条前瞻时本样本变 HIT ⇒ 判据会误报一条真实的动态导入（M3 变异 ①）。
      'import(\n  // from "@vendor/sdk" 只允许动态导入\n  "@vendor/sdk"\n);',
    ];
    for (const form of allowedForms) {
      expect(staticallyImports(form, packageName), `不该命中：${form}`).toBe(false);
    }
  });

  it('VENDOR_PACKAGES 与 package.json 的厂商依赖集合相同（同一份三元组不能有两个真源，评审 F7）', () => {
    // 为什么必须钉：将来新增/改名一家（或 T10 调整依赖）时，断言会**静默**失去覆盖——扫描照跑，
    // 只是再也没有一个源文件可能命中它。这里读 package.json 现比，不把版本或包名抄成测试字面量。
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const inManifest = Object.keys(manifest.dependencies ?? {})
      .filter((name) => VENDOR_DEPENDENCY_PATTERN.test(name))
      .sort();
    expect(inManifest).toEqual([...VENDOR_PACKAGES].sort());
  });

  it('注册表是显式静态注册：src/**（排除 *.test.ts）里不出现 readdir / readdirSync（A3：打包后扫描目录不可靠）', () => {
    // 标题对齐判据（评审 N2）：本断言只拦 `readdir` / `readdirSync`（`:293` 的正则），扫描面是 `src/**`、
    // 排除 `*.test.ts`、**不含** `probe/`（`sourceFiles()` 的定义）——旧标题「包内不出现目录扫描」比
    // 判据宽，容易让人以为 `probe/` 也被覆盖。
    // 扫描面**复用**上面的 `sourceFiles()`（含它的 `*.test.ts` 排除）：`sourceFiles()` 自己就用
    // `readdirSync(..., { recursive: true })`，与本断言要禁的模式同形，全靠那个过滤器才不自我违规
    // ——`static-assertions.test.ts` 是本包唯一允许出现 `readdirSync` 的文件（T3/T4 的实测口径）。
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      if (/\breaddir(Sync)?\s*\(/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * R33 的守卫（终审 §2-M7 点名它「有落点但无守卫」）。
   *
   * R33 的裁决内容是「p3 的 dsh 依赖走 **`next` 线**，实测写入 **0.1.7-rc.1**，**不是** `latest`」，
   * 理由是 `latest`（0.0.1-rc.1）把那几个包声明成 peerDependencies，pnpm 自动装 peer 时
   * `dsh-session` 又 peer 到 `@deepseek-ai/dsh-type-meta`，而该包在三家公开源**全 404**
   * ⇒ 按 `latest` 装在本机**不可能完成**。
   *
   * 原有的依赖守卫（`:271` 的 VENDOR_PACKAGES 断言）只比**名字集合**、不碰版本区间，
   * 于是「有人把版本改回 `latest`」不会有任何测试变红 —— 而那会让 `pnpm install` 直接失败。
   * 这里补的判据刻意与 R35 的应用侧守卫**同口径**：版本区间不抄成测试字面量，
   * 读 `package.json` 现比「它是 next 线上的预发布版本」这一件事。
   */
  it('dsh SDK 走 next 线：package.json 里是 0.1.x-rc 形状的精确版本，不是 latest 线（R33）', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const declared = manifest.dependencies?.['@deepseek-ai/dsh-sdk-client'];

    expect(declared, 'dsh SDK 必须声明在 agents 包的 dependencies 里').toBeTypeOf('string');
    // `latest` 线的形态是 `0.0.1-rc.1`（或带 ^ 的区间），而 next 线是 `0.1.x-rc.N` 精确值
    // （pnpm 对预发布不写前缀，这也是 R33 原文「实测写入 0.1.7-rc.1」的由来）
    expect(declared).toMatch(/^0\.1\.\d+-rc\.\d+$/);
    expect(declared).not.toContain('latest');
    expect(declared).not.toMatch(/^[\^~]/);
  });
});
