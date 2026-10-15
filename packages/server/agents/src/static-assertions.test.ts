// @vitest-environment node
/**
 * 源码级不变量：没有运行期可观测量，只能扫源码。
 * 「写对了」与「写错了」在注入正确的用例里表现完全一样——一份写 `process.env` 的实现照样能让
 * 单测全绿，差别只在并行跑两行时第二行拿到别人的密钥。
 * 扫描范围是 agents 包自己的 src/**，**排除 *.test.ts**：本文件里的正则字面量与样本会把规则自己判违规。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 包内全部非测试源码（相对 src），Windows 分隔符统一成正斜杠。
 * 扩展名走**正向白名单**：`.ts` 之外还有 `.mts` / `.cts` / `.js` / `.mjs` / `.cjs`
 * （只认 `.ts` 时，往 `src/` 放一个 `.mjs` 就能整份绕开扫描）。
 * 必须保留 `*.test.ts` 排除：本文件自己的正则字面量与样本会把规则判成违规。
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
  // 另外三类：与上面四条是「同一件事的另外几种写法」
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
 * 裸令牌规则会把它们全部判成违规——「裸令牌纳入检查」只有在去注释后才可落地。
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
    violations.push('裸 process.env 令牌（别名写入）');
  }
  return violations;
}

/** 厂商包：只允许出现在动态 import() 与错误文案里（与 package.json 的一致性由专条断言钉住） */
const VENDOR_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex',
  '@deepseek-ai/dsh-sdk-client',
  '@earendil-works/pi-coding-agent',
  // pi 的**模型层**包：适配器要从它拿 `InMemoryCredentialStore`（凭据只进内存的那条通道）。
  // 它在清单里，因此也受「只能动态 import」管——与它的兄弟包 `pi-coding-agent` 同一条纪律。
  '@earendil-works/pi-ai',
  // pi 的**终端 UI** 包：本仓一行都不 import 它，它进依赖清单只是为了让 pi 的兄弟包（子智能体扩展）
  // 的 peer 落在同一份实例上。仍然登记——「反向」那条断言要求依赖清单里凡属厂商 scope 的包都在这张表里，
  // 漏了它这条 scope 的覆盖就静默变窄。
  '@earendil-works/pi-tui',
] as const;

/**
 * 厂商包的 **scope**（`@anthropic-ai` / `@openai` / …）：从 `VENDOR_PACKAGES` 的包名里取出来。
 * 为什么不用「包名以 `-sdk` 结尾」那种形状启发式：codex 走 CLI 包后名字是 `@openai/codex`、**不以
 * `-sdk` 结尾**，形状判据会把它漏掉；scope 不依赖后缀命名。
 */
const VENDOR_SCOPES: readonly string[] = [...new Set(VENDOR_PACKAGES.map((name) => name.split('/')[0]!))];

/**
 * 依赖清单里属于「厂商包」的那一类：`VENDOR_PACKAGES` 的 scope 之下的一切。
 *
 * 为什么**从 `VENDOR_PACKAGES` 派生**而不是手写一份 scope 白名单：两份清单必然漂移，而漂移是
 * **静默**的——新家的包名进了 `VENDOR_PACKAGES`（于是「只能动态 import」这条规则开始扫它），
 * 下面的交叉断言却仍按旧 scope 过滤，于是谁也发现不了「清单比规则窄」。派生之后，加一个包名
 * 就等于同时扩了 scope。
 *
 * **三条已知边界**（如实登记）：① 粒度是 scope——同一 scope 下的**兄弟包**（例如 pi 的
 * `@earendil-works/pi-tui`）也会落进这个集合，故正反两条交叉断言判的都是**清单里的那几个名字**
 * 有没有对上，而不是「集合与清单全等」；② 只读 `dependencies`，不读 `devDependencies`——把厂商包挪到
 * devDependencies 也会失去覆盖；③ 派生自包名 ⇒ scope 与包名不同源时（`@a/b` 写成了 `@c/b`）
 * 交叉断言会把 scope 当成 `@c`，而那正是「写错一个字母」应有的表现（清单里找不到 `@a/b` ⇒ 红）。
 */
const VENDOR_DEPENDENCY_PATTERN: RegExp = new RegExp(
  `^(?:${VENDOR_SCOPES.map((scope) => scope.replace(/[/@.]/g, '\\$&')).join('|')})/`,
);

/**
 * 顶层静态导入的**两条结构式**：
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
 * 为什么还必须补三处（两条结构式会漏三类写法）：
 *  - `export type { … } from` / `export type * from` ⇒ `(?:type\s+)?`；
 *  - `export*from'@pkg'`（零空格）⇒ `\s*` 而不是 `\s+`；
 *  - `export * as ns from` ⇒ `\*(?:\s+as\s+[\w$]+)?`。
 * 为什么 `[^;]*?` 只出现在第一条且要求 `\bfrom`：`import` 后面允许出现任意声明片段（含折行），但
 * 「非 `from` 形态」的 `import` 只剩 `import 'x'` / `import"x"`——`\s*` 后直接是引号即可，不需要
 * 让 `[^;]*` 去兜底，那样会把行首 `import(` 的动态导入也吞进来（`(?![(])` 是同一件事的显式守卫）。
 * **样本表就是这条判据的规格**：任何收紧/放宽都必须先扩样本表（见下面两条用例），别再靠「跑一遍全绿」判断。
 *
 * **下一次该动哪里：换成 TS AST，别再动正则。** 正则的洞与误报都来自**排版**（分号、空白、
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

/**
 * 允许出现 `readdirSync` 的**唯一一处例外**（读 claude 的子智能体会话文件）。
 *
 * 为什么这一条要写成一张**有界的表**、而不是让下面那条断言悄悄放过它：那条断言的判据是**标识符**
 * （`/\breaddir(Sync)?\s*\(/`），它守的是 A3 —— 「打包后扫不到模块」⇒ 本包的**注册表**必须是显式静态注册。
 * 而 `providers/cc/subagent-usage.ts` 扫的不是代码目录，是**运行期数据目录**
 * （`<configHome>/projects/<项目目录>/<sessionId>/subagents/`）：项目目录名是 CLI 自己按 cwd 拼的，
 * 本仓明确**不重算那条规则**（算错会静默读到空目录，见 `readClaudeSubagentUsage` 的注释）
 * ⇒ 列举是唯一诚实的取数方式，而它与「打包」无关。
 *
 * 表**不许变长**：每加一项都要先在这里写清「它与 A3 无关」的理由；配套的用例还要求这张表**逐字**
 * 等于下面那一个元素（改路径、加第二项都会红），且表里每一项都真的在扫盘（留下死条目等于悄悄撑大豁免面）。
 * 豁免只按**逐项路径**匹配（不做目录前缀匹配）⇒ **其余文件的覆盖一字不减**：任何一个别的文件出现
 * `readdir` / `readdirSync` 照样被下面那条断言点名。
 */
const READDIR_ALLOWED: readonly string[] = ['providers/cc/subagent-usage.ts'];

describe('源码级不变量', () => {
  it('源码里不出现任何写入宿主环境的写法（不变量 2）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      for (const violation of envWriteViolations(text)) offenders.push(`${file}：${violation}`);
    }
    expect(offenders).toEqual([]);
  });

  it('注释里提到 process.env 不算违规（去注释后才判裸令牌）', () => {
    const source = ['/** 本函数读 process.env 但绝不写入它 */', 'export const x = 1;'].join('\n');
    expect(envWriteViolations(source)).toEqual([]);
  });

  it('违规判定能拦住五种写入写法，并放行四种只读写法', () => {
    /**
     * 为什么单开一条：上面那条只能证明「当前源码干净」，不能证明规则**有覆盖**——别名写入与 `delete`
     * 在四条正则下双双逃逸。这里把写法直接喂给判定本身，规则被改窄时这条会红。
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

  it('静态导入判定拦住 15 种写法（含折行、子路径、零空格、export type / export * as），并放行 14 种动态/无关写法', () => {
    /**
     * 为什么单开一条：上一条只能证明「当前源码干净」，证明不了判据**有覆盖**——历史已经三次「没见过失败」
     * （`\b`→`[ \t]` 丢零空格 / `=` 前瞻没覆盖函数体这类），说明红与绿都不足以判断它对不对。
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
      // 零空格写法全部合法，且本仓没有 keyword-spacing ⇒ lint / typecheck / 断言三闸都拦不住
      'import"@vendor/sdk";',
      'import{VendorModule}from"@vendor/sdk";',
      'import*as vendor from"@vendor/sdk";',
      'export*from"@vendor/sdk";',
      // 换行后接引号：旧模式（[^\n]*）与 [ \t] 版都漏，现在一并覆盖
      'import\n"@vendor/sdk";',
      // 另五种（两条结构式会 MISS：缺 (?:type\s+)?、缺 export\s*、缺 * as）
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
      // **行首**的动态导入：`(?![(])` 放行它。注意：在两条结构式下，本样本其实由
      // 「`\s*` 后必须紧跟引号」天然挡住——`(?![(])` 真正守的是下面那条「同一句里出现 from "包名"」。
      'import(\n  "@vendor/sdk"\n);',
      '/** 本适配器只允许动态 import("@vendor/sdk")，绝不静态导入 */',
      'expect(message).toContain("@vendor/sdk");',
      // 跨语句不误伤：`[^;]*` 在分号处停住，别家包名不会把这一句连坐
      'import other from "other-package";\nconst text = "@vendor/sdk";',
      // 误报组：只是把包名写成字符串常量，**不建立静态依赖**，不该命中
      'export const X = "@vendor/sdk";',
      'const L = "@vendor/sdk"; export const X = L;',
      'export const X = /* c */ "@vendor/sdk";',
      // 转义样本：包名里的 `@` / `/` / `.` 必须当字面量，`@vendorXsdk` 不是 `@vendor/sdk`
      'import x from "@vendorXsdk";',
      // 误报组其二（「最自然的懒加载写法」）：函数体里出现 `import('@pkg')` 或引号包名
      'export async function f() { return import("@vendor/sdk"); }',
      'export function f() { return "@vendor/sdk"; }',
      'const loadRaw = createSdkLoader<unknown>(async () => import("@vendor/sdk"), NAME);',
      // `(?![(])` 的唯一承重形状：行首 `import(` 且**同一句里**出现 `from "包名"`（例如动态导入的参数区
      // 带一行注释）。少了那条前瞻，判据会误报一条真实的动态导入。
      'import(\n  // from "@vendor/sdk" 只允许动态导入\n  "@vendor/sdk"\n);',
    ];
    for (const form of allowedForms) {
      expect(staticallyImports(form, packageName), `不该命中：${form}`).toBe(false);
    }
  });

  /**
   * **清单不许窄于依赖**（本仓真发生过一次）：`VENDOR_PACKAGES` 与 `dependencies` 是两份清单，
   * 而两者都只在**新家的包名**上才需要同步。反向缺口是静默的：往 `dependencies` 里加一个
   * 厂商 scope 下的包（例如凭据存储所在的那个模型层包）却忘了登记进 `VENDOR_PACKAGES` 时，
   * 「厂商包只能动态 import」这条规则对它**一个字都不扫**，而所有断言照样全绿。
   *
   * 判据是「`dependencies` 里凡命中派生 scope 的包，都必须出现在清单里」——
   * 只判这个方向，不要求清单 ⊆ 依赖（那是下面那条既有断言在判），两条合起来才是双向一致。
   */
  it('反向：dependencies 里厂商 scope 下的包一个都不许漏出 VENDOR_PACKAGES（漏了那条规则就静默失去覆盖）', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const declaredVendorDeps = Object.keys(manifest.dependencies ?? {})
      .filter((name) => VENDOR_DEPENDENCY_PATTERN.test(name));

    for (const name of declaredVendorDeps) {
      expect(
        VENDOR_PACKAGES as readonly string[],
        `${name} 是厂商依赖却没进 VENDOR_PACKAGES：「只能动态 import」这条规则对它失去覆盖`,
      ).toContain(name);
    }
  });

  it('VENDOR_PACKAGES 的每一家都在 package.json 的厂商依赖里（清单与依赖清单不能有两个真源）', () => {
    // 为什么必须钉：将来新增/改名一家（或调整依赖）时，断言会**静默**失去覆盖——扫描照跑，
    // 只是再也没有一个源文件可能命中它。这里读 package.json 现比，不把版本或包名抄成测试字面量。
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const inManifest = Object.keys(manifest.dependencies ?? {});
    /**
     * 判据是**单向包含**（清单 ⊆ 依赖），不是全等：`VENDOR_DEPENDENCY_PATTERN` 的粒度是 scope，
     * 同一家旗下的兄弟包也会落进集合——它们是厂商 SDK 的**配套包**、不是本仓要加载的入口，
     * 未进依赖清单的那些自然也不该列进 `VENDOR_PACKAGES`。
     * 反向仍然钉死：**任何一个 `VENDOR_PACKAGES` 成员**（含 scope）都不在 `dependencies` 里 ⇒ 红
     * ——那正是「改了名 / 挪到 devDependencies / 写错 scope」这三种静默失效的形状。
     * 另一个方向由上面那条「反向」用例看管（依赖里有、清单里没有）。
     */
    for (const name of VENDOR_PACKAGES) {
      expect(inManifest, `${name} 不在 agents 包的 dependencies 里：这条规则对它即失去覆盖`).toContain(name);
    }
    /**
     * 顺带钉住「派生出来的 scope 真的能匹配到自家包名」：清单与正则若各写一份，漂移是静默的
     * ——扫描照跑，只是再也没有一个源文件可能命中它。这一条只判「枚举包含了清单里的包」，
     * 与下面那条形状样本分开（那条判的是**模式**本身的松紧）。
     */
    for (const name of VENDOR_PACKAGES) {
      expect(VENDOR_DEPENDENCY_PATTERN.test(name), `${name} 没被派生出的 scope 模式匹配上`).toBe(true);
    }
  });

  /**
   * 派生的 scope 模式必须**认得出自家包、且放得过无关包**——样本两条一起判，缺一条就会漏掉
   * 一整类漂移：只判「认得出」时，一个 `^@.*` 那样的宽模式照样全绿（于是「厂商包只能动态 import」
   * 这条规则会把无关包也扫进去）；只判「放得过」时，一个空模式（谁都不匹配）也照样全绿
   * （于是这条规则**静默失去覆盖**，正是 `VENDOR_DEPENDENCY_PATTERN` 从清单派生的理由）。
   * 样本用真实的四家包名与三个无关包名，不另造合成名——判据要贴的正是现实里的形状。
   */
  it('派生的厂商 scope 模式：四家的包都命中，无关包一个都不命中', () => {
    for (const name of VENDOR_PACKAGES) {
      expect(VENDOR_DEPENDENCY_PATTERN.test(name), `自家包没命中：${name}`).toBe(true);
      // 子路径形态（`@vendor/pkg/sub`）也算同一家：包名后面必须允许跟路径
      expect(VENDOR_DEPENDENCY_PATTERN.test(`${name}/dist/index.js`), `子路径没命中：${name}`).toBe(true);
    }
    for (const unrelated of ['zod', '@aieval/contracts', '@types/node']) {
      expect(VENDOR_DEPENDENCY_PATTERN.test(unrelated), `无关包被当成厂商包：${unrelated}`).toBe(false);
    }
  });

  /**
   * **工具调用块只准由公共草稿函数构造**。
   *
   * 契约的 `ToolCallBlock.payload` 是**可缺**的（老 `messages.jsonl` 里没有这一格，写成必填
   * 会让回放成片失败——与 `usage.timing` 同一条理由）。代价是**手搓一个 `tool-call` 块
   * 会静默少掉载荷**：那种块在界面上表现为「这一族的卡片没了」，而所有包的用例照样全绿。
   *
   * 本仓实际发生过两次（`providers/codex/events.ts` 的协作调用、`providers/codex/message.ts`
   * 的 `exec_command`），两处都已改为走 `toolCallBlockDraft`。这条断言就是那一类回归的网：
   * 扫描面是 `providers/**`，命中 `type: 'tool-call'` 字面量即违规。
   */
  it('providers/** 里不手搓 `tool-call` 块（手搓会静默少掉族载荷）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.startsWith('providers/')) continue;
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      if (/type:\s*'tool-call'/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * 库包不得把**全局**的 `NodeJS.ProcessEnv` 当自己的类型。
   *
   * 为什么值一条断言：`NodeJS.ProcessEnv` 是**全局接口**，下游应用可以给它补**必填**成员。
   * web-next 的 `next-env.d.ts`（跑过一次 `next dev` 就有，且已被 gitignore）会拉进 Next 16 的
   * `next/types/global.d.ts`：
   * ```ts
   * interface ProcessEnv { readonly NODE_ENV: 'development' | 'production' | 'test' }
   * ```
   * 而本仓的类型检查是「8 个包共用一个 tsc 程序」（`tsconfig.typecheck.json`）⇒ 本包（一个库）
   * 里每个 `{}` 形状的 env 字面量都被要求写 `NODE_ENV`：`appserver/client.ts` 的
   * `AppServerClientOptions.env` 与 `client.test.ts` 三处 TS2741；而**干净检出**下同一个 `{}` 合法
   * ⇒ 门禁随「这台机器跑没跑过 dev」变色。产品侧换成仓内自己的类型
   * （`AppServerEnv`，见那里的注释）。
   *
   * 为什么这条断言不可省：上面那个症状**只在跑过 `next dev` 的机器上出现**，
   * 干净检出（含 CI）上 `pnpm typecheck` 照样是绿的 ⇒ 「用 `NodeJS.ProcessEnv` 当自己的类型」
   * 在 CI 上永远不会被发现。本断言扫源码，两种机器上都在。
   *
   * 唯一的放行形态是 **`as NodeJS.ProcessEnv`**（断言）：全局那个类型只允许活在与 `spawn`
   * 交接的那一处边界上（`appserver/client.ts` 的 `defaultSpawn`），类型注解一律不许。
   * **范围如实登记**：只扫本包；今日全仓其余提到它的地方都是注释（`providers/dsh/sdk.ts`
   * 的口径说明），去注释后 0 命中。
   */
  it('库包不把全局的 NodeJS.ProcessEnv 当自己的类型（下游应用的全局增补会把它变成必填）', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = stripComments(readFileSync(join(import.meta.dirname, file), 'utf8')).replace(/\bas\s+NodeJS\.ProcessEnv\b/g, ' ');
      if (/\bNodeJS\.ProcessEnv\b/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('注册表是显式静态注册：src/**（排除 *.test.ts）里不出现 readdir / readdirSync，唯一例外是运行期数据目录读取（下方白名单，且不可静默变长）（A3：打包后扫描目录不可靠）', () => {
    // 标题对齐判据：本断言只拦 `readdir` / `readdirSync`（下面那条正则），扫描面是 `src/**`、
    // 排除 `*.test.ts`、**不含** `probe/`（`sourceFiles()` 的定义）——旧标题「包内不出现目录扫描」比
    // 判据宽，容易让人以为 `probe/` 也被覆盖。
    // 扫描面**复用**上面的 `sourceFiles()`（含它的 `*.test.ts` 排除）：`sourceFiles()` 自己就用
    // `readdirSync(..., { recursive: true })`，与本断言要禁的模式同形，全靠那个过滤器才不自我违规
    // ——`static-assertions.test.ts` 是本包唯一允许出现 `readdirSync` 的文件（本包的口径）。
    // `READDIR_ALLOWED` 是**第二类**例外，今天只有一项，理由与「表不许变长」见它的注释；
    // 它由下面那条「有界且无死条目」的用例看管。豁免按逐项路径匹配，别的文件一个字都不放过。
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (READDIR_ALLOWED.includes(file)) continue;
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      if (/\breaddir(Sync)?\s*\(/.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('扫盘例外表有界且无死条目：逐字等于那一个元素，且它真的在扫盘', () => {
    // 为什么要单独一条：上面那条断言对 `READDIR_ALLOWED` 本身**不设防**（往表里加一项就多豁免一个文件），
    // 而豁免面正是「注册表必须静态注册」这条不变量的缺口。三半合起来才说得清缺口有多大：
    //   · 表**逐字**等于那一个元素 —— 加第二项、换路径都必须回来改这条断言，评审一定看得见；
    //   · 表里每一项都真的命中那个正则 —— 留一个不再扫盘的条目，等于豁免面在没人察觉时变宽。
    expect(READDIR_ALLOWED).toEqual(['providers/cc/subagent-usage.ts']);
    for (const file of READDIR_ALLOWED) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(/\breaddir(Sync)?\s*\(/.test(text), `${file} 已不再扫盘，应从例外表里删掉`).toBe(true);
    }
  });

  /**
   * dsh 依赖**不落 `latest` 线**。
   *
   * 理由是 `latest`（0.0.1-rc.*）把那几个包声明成 peerDependencies，pnpm 自动装 peer 时
   * `dsh-session` 又 peer 到 `@deepseek-ai/dsh-type-meta`，而该包在三家公开源**全 404**
   * ⇒ 按 `latest` 装在本机**不可能完成**。
   *
   * 原有的依赖守卫（`:271` 的 VENDOR_PACKAGES 断言）只比**名字集合**、不碰版本区间，
   * 于是「把版本写成 `latest`」不会有任何测试变红 —— 而那会让 `pnpm install` 直接失败。
   * 这里补的判据刻意与应用侧的依赖守卫**同口径**：版本区间不抄成测试字面量，
   * 读 `package.json` 现比「它是一个精确的预发布版本、且不在 latest 线上」这一件事。
   *
   * 形状断言刻意是「任意 minor 的精确预发布版本（`x.y.z-<tag>.N`）+ 不是 latest 线的 `0.0.1-rc.*`」：
   * 该包的正式线在 `next`（`-rc.N`）与 `alpha`（`-alpha.N`）两个 tag 之间来回走，
   * 把 minor 或预发布标签钉死会让每次正常升级都要回来改守卫，而守卫真正要拦的只有
   * 「退回 latest 线（装不上）」与「写成带前缀的区间（预发布区间会静默漂移）」两件事。
   */
  it('dsh SDK 不落 latest 线：package.json 里是精确的预发布版本 x.y.z-<tag>.N', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const declared = manifest.dependencies?.['@deepseek-ai/dsh-sdk-client'];

    expect(declared, 'dsh SDK 必须声明在 agents 包的 dependencies 里').toBeTypeOf('string');
    // `latest` 线的形态是 `0.0.1-rc.N`，而 next / alpha 线是精确的 `x.y.z-<tag>.N` 预发布值
    // （pnpm 对预发布不写前缀，这也是「实测写入 0.1.7-rc.1」的由来）
    expect(declared).toMatch(/^\d+\.\d+\.\d+-[a-z]+\.\d+$/);
    expect(declared, '0.0.1-rc.* 是 latest 线，按它装在本机完不成').not.toMatch(/^0\.0\.1-/);
    expect(declared).not.toContain('latest');
    expect(declared).not.toMatch(/^[\^~]/);
  });
});

/**
 * 打包器免疫（真机故障的守卫）。
 *
 * 故障形态：厂商可执行文件的定位链在**纯 Node 下正常、在 Next 的服务端构建里必挂**——打包器
 * （Turbopack / webpack）把 `node:module` 的 `createRequire` 换成了自己的 `require`，其 `resolve()`
 * 返回**模块 id**（`[externals]/@openai/codex/package.json [external] (…)`）而不是文件路径；
 * `import.meta.url` 同时会被重写。⚠️ 真机读数（生产产物 + 生产进程 spy）显示**当前默认的 Turbopack
 * 生产构建并不这样**（`node:module` 就是真模块、`resolve()` 返回真文件路径）⇒ 这三条判据今天守的是
 * **别的打包器/构建配置**那一档，不是现网正在发生的事；判据本身照旧要留（换构建器时它是唯一的门禁）。
 *
 * 为什么只能写成静态断言：这类缺陷在单测里**原理上不可复现**——单测跑在纯 Node，解析器比打包产物宽松，
 * 夹具用假目录「怎么搭怎么解析」。所以判据落在**源码形状**上，三条缺一不可：
 *   ① 用 `process.getBuiltinModule('module')` 取真的 `node:module`（绕开打包器的替换）；
 *   ② 解析基准**多于一个**（`import.meta.url` 会被重写，单一基准在打包后未必落在包目录里）；
 *   ③ 校验解析结果是**文件路径**（模块 id 既非绝对路径、也可能带 `[external` 标记）。
 *
 * 反面形态（回归时最先出现的那一句）也逐条钉住：`createRequire(import.meta.url).resolve(` 直呼。
 */
function bundlerImmunityViolations(source: string): string[] {
  // **必须去注释再判**：文件头的说明里就写着 `process.cwd()` / `import.meta.url` / `getBuiltinModule`，
  // 按整份文本判会让「代码里删掉一个基准」这类回归静默通过。
  const text = stripComments(source);
  const violations: string[] = [];
  if (!text.includes('getBuiltinModule')) {
    violations.push('缺少 `process.getBuiltinModule`：解析器会被打包器的 `createRequire` 替换掉');
  }
  if (text.includes('createRequire(import.meta.url)')) {
    violations.push('出现 `createRequire(import.meta.url)` 直呼：打包后拿到的是模块 id，不是文件路径');
  }
  const anchors = ['import.meta.url', 'process.cwd()'].filter((anchor) => text.includes(anchor));
  if (anchors.length < 2) {
    violations.push(`解析基准少于两个（只有 ${anchors.join('、') || '无'}）：\`import.meta.url\` 在打包后会被重写`);
  }
  if (!text.includes('isAbsolute(')) {
    violations.push('缺少结果形态校验（`isAbsolute`）：模块 id 会被当成路径继续往下走');
  }
  return violations;
}

/**
 * **第二跳（平台包）的解析基准必须显式钉住**——它只能钉在 CLI 包自己的 `package.json` 上。
 *
 * 为什么写成静态断言：`@openai/codex-darwin-arm64/package.json` 这个说明符在**纯 Node** 下对默认的
 * 两条基准（`import.meta.url` / `process.cwd()`）**全部 MODULE_NOT_FOUND**（平台包是 CLI 包的
 * optionalDependency，只链在 CLI 包自己的 `node_modules` 下），所以删掉
 * `resolvePackageFile(…, [codexPackageJson])` 的第二个实参本该当场红。
 *
 * ⚠️ **「本该红」在门禁里却恒绿，元凶是 `NODE_PATH`，不是 vitest**：`node_modules/.bin/vitest`
 * 是 pnpm 的 bin shim，它在启动时注入 `NODE_PATH=<仓>/.pnpm/node_modules`，那里 `codex` 与
 * `codex-darwin-arm64` 两条软链都在 ⇒ 两条默认基准**都能解析到**。分水岭是**启动形态**：
 * 同一份探针换成裸 `node node_modules/vitest/vitest.mjs`（摘掉 `NODE_PATH`）跑，同一条变异
 * **立刻红**、与纯 Node 逐格一致。
 * ⇒ 这条判据今天仍守着门禁（要更硬的判据，就把 vitest 用裸 node 启动、或把 `NODE_PATH` 摘掉再跑）。
 *
 * 判据是**调用形态**：那一次 `resolvePackageFile(` 必须带第二个实参。
 */
function secondHopAnchorViolations(source: string): string[] {
  const text = stripComments(source);
  const violations: string[] = [];
  // 第二跳那一句的说明符由 `PLATFORM_PACKAGE_BY_TRIPLE` 的值拼出（`${platformPackage}/package.json`）
  const line = text.split('\n').find((one) => one.includes('${platformPackage}/package.json'));
  if (line === undefined) {
    violations.push('找不到第二跳（平台包 `package.json`）的 `resolvePackageFile` 调用：判据本身失效了');
    return violations;
  }
  if (!/,\s*\[/.test(line)) {
    violations.push('第二跳没有显式基准（`resolvePackageFile(…, [codexPackageJson])` 的第二个实参被删了）：真 Node 下两条默认基准都解析不到平台包');
  }
  return violations;
}

/**
 * **`thread/turns/list` 必须显式要 `itemsView: 'full'`**——厂商默认 `summary`。
 *
 * 要拦的缺陷：不传这一格 ⇒ 厂商回 `summary`（`items` 只剩摘要，真机实测 10 条条目只回 2 条），
 * 于是 `reader.ts` 里「turns 全是 `full` 就直接用、不必再跑 `thread/items/list` 分页」那条快路径
 * **永远不可达**，每条线程白付一次分页请求。改回去**单测不会红**（两种取法拿到的条目逐条相等，
 * 真机量过：`onlyA` / `onlyC` 皆空），所以判据只能落在**源码形状**上。
 *
 * 行为侧另有一条真机守卫（`turns-order-live.test.ts` 走真 app-server 读回内容），
 * 它保证这条路径**跑得通**；本判据保证**参数还在**。两者缺一，改回默认值就没人拦。
 */
function turnsItemsViewViolations(source: string): string[] {
  const text = stripComments(source);
  if (!text.includes('\'thread/turns/list\'')) return ['找不到 `thread/turns/list` 调用：判据本身失效了'];
  return text.includes('itemsView: \'full\'')
    ? []
    : ['`thread/turns/list` 没有显式要 `itemsView: \'full\'`：厂商默认 `summary`，条目只剩摘要，快路径不可达'];
}

describe('收尾取数：turns 的 itemsView', () => {
  it('`thread/turns/list` 显式要 `full`（不传就白付一次分页）', () => {
    const text = readFileSync(join(import.meta.dirname, 'providers/codex/appserver/reader.ts'), 'utf8');
    expect(turnsItemsViewViolations(text)).toEqual([]);
  });

  it('判据有区分力：删掉那一格就命中', () => {
    expect(turnsItemsViewViolations('client.request(\'thread/turns/list\', { threadId })')).not.toEqual([]);
    expect(turnsItemsViewViolations('client.request(\'thread/turns/list\', { threadId, itemsView: \'full\' })')).toEqual([]);
  });
});

describe('打包器免疫：厂商入口的解析器', () => {
  it('codex 的可执行文件解析器满足三条免疫要求', () => {
    const text = readFileSync(join(import.meta.dirname, 'providers/codex/appserver/binary.ts'), 'utf8');
    expect(bundlerImmunityViolations(text)).toEqual([]);
  });

  it('第二跳的基准显式钉在 CLI 包的 `package.json` 上（删掉它 ⇒ 真 Node 解析不到平台包，而单测仍绿）', () => {
    const text = readFileSync(join(import.meta.dirname, 'providers/codex/appserver/binary.ts'), 'utf8');
    expect(secondHopAnchorViolations(text)).toEqual([]);
  });

  it('第二跳那一条判据有区分力：删掉第二个实参就命中，留着就放行', () => {
    const withAnchor = 'const p = resolvePackageFile(`${platformPackage}/package.json`, [codexPackageJson]);';
    const withoutAnchor = 'const p = resolvePackageFile(`${platformPackage}/package.json`);';
    expect(secondHopAnchorViolations(withAnchor)).toEqual([]);
    expect(secondHopAnchorViolations(withoutAnchor)).not.toEqual([]);
    // 注释里写着「基准」不算数：判据按去注释后的文本判
    expect(secondHopAnchorViolations('// resolvePackageFile(`x/package.json`, [a])\nresolvePackageFile(`${p}/package.json`);')).not.toEqual([]);
  });

  it('判据拦住四种回归形态，放行合规形态（没见过失败的判据不算判据）', () => {
    const regressions = [
      // ① 退回单路径直呼（本次故障的原形态）
      'import { createRequire } from \'node:module\';\nconst p = createRequire(import.meta.url).resolve(\'@openai/codex/package.json\');',
      // ② 只用 import.meta.resolve（同样被打包器接管）
      'const p = import.meta.resolve(\'@openai/codex/package.json\');',
      // ③ 有 getBuiltinModule 但只用一个基准
      'const req = process.getBuiltinModule(\'module\').createRequire(import.meta.url);\nreq.resolve(\'x\');',
      // ④ 有真 require 也有两个基准，但不校验结果形态
      'const req = process.getBuiltinModule(\'module\').createRequire(import.meta.url);\nconst other = process.cwd();\nreq.resolve(\'x\');',
      // ⑤ 三条要求只写在**注释**里（按整份文本判的盲区：会放过它）
      '// 说明：本解析器用 process.getBuiltinModule 取真 require，基准有 import.meta.url 与 process.cwd()，并用 isAbsolute 校验\nconst p = req.resolve("x");',
    ];
    for (const form of regressions) {
      expect(bundlerImmunityViolations(form), `应当命中：${form}`).not.toEqual([]);
    }
    const conforming =
      'import { isAbsolute } from \'node:path\';\n' +
      'const factory = process.getBuiltinModule?.(\'module\')?.createRequire;\n' +
      'const anchors = [import.meta.url, join(process.cwd(), \'noop.js\')];\n' +
      'if (isAbsolute(resolved)) return resolved;';
    expect(bundlerImmunityViolations(conforming), '合规形态不该命中').toEqual([]);
  });
});

/**
 * MCP 翻译器的**共用写法**（同一个包里逐字两份的重复代码）。
 *
 * 为什么这类缺陷只能扫源码：重复实现与共享实现的**运行期行为逐字相同**，既有那批形状守卫
 * （`mcp.test.ts` / dsh 的 overlay 守卫）全绿——差别只在「改了一处、漏了另一处」的那天，
 * 而那天要等某一家厂商恰好踩到那一格才现形（YAML 解析失败 ⇒ 整行起不来）。
 * 扫描面是包内非测试源码（与上面几条同款），去注释后判。
 */
describe('MCP 翻译器的共用写法（每段逻辑只有一份）', () => {
  it('YAML 标量转义只有一份实现：`quoteYaml` 的定义只在 mcp.ts（dsh overlay 两处拼装共用它）', () => {
    const definitions: string[] = [];
    for (const file of sourceFiles()) {
      const text = stripComments(readFileSync(join(import.meta.dirname, file), 'utf8'));
      if (/function\s+quoteYaml\s*\(/.test(text)) definitions.push(file);
    }

    // 逐字相等（不是「包含」）：第二份抄在 dsh/index.ts 里时这条当场红
    expect(definitions, 'dsh overlay 的模型路由与 MCP 插件行必须共用同一份 YAML 转义').toEqual(['mcp.ts']);
  });

  it('可选键「缺席就不写」只有一种写法：MCP 翻译器里不再手写 `=== undefined ? {} : {` 三元', () => {
    const text = stripComments(readFileSync(join(import.meta.dirname, 'mcp.ts'), 'utf8'));

    // 六个可选格（claude / codex 各三格）统一走 `optional(key, value)`：
    // 手写三元时每一遍都要自己收窄一次，漏一次就是「显式声明为空」混进厂商配置
    expect(text, '又有手写的可选键三元——它该走 optional()').not.toMatch(/===\s*undefined\s*\?\s*\{\}\s*:\s*\{/);
    expect(text, 'optional() 本身不见了？').toMatch(/function\s+optional\s*</);
  });
});
