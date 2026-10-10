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

/** 三家厂商包：只允许出现在动态 import() 与错误文案里（与 package.json 的一致性由专条断言钉住） */
const VENDOR_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex',
  '@deepseek-ai/dsh-sdk-client',
] as const;

/**
 * 依赖清单里属于「厂商包」的那一类：三条厂商 scope（`@anthropic-ai/` / `@openai/` / `@deepseek-ai/`）下的依赖。
 * 为什么不用「包名以 `-sdk` 结尾」那种形状启发式：codex 走 CLI 包后名字是 `@openai/codex`、**不以 `-sdk`
 * 结尾**，形状判据会把三家之一漏掉（`VENDOR_PACKAGES` 随即静默失去覆盖）；scope 判据不依赖后缀命名，
 * 同一家旗下的新包照样落进集合。
 * **两条已知边界**：① 判据是 scope 白名单——新增一家不在这三条 scope 下的厂商包
 * （例如 `@google/genai`）时，下面的交叉断言照样通过，`VENDOR_PACKAGES` 却静默失去覆盖；
 * ② 只读 `dependencies`，不读 `devDependencies` ——把厂商包挪到 devDependencies 也同样失去覆盖。
 * 也就是说这条断言守的是「现有三家的名字与位置不漂移」，不是「任何形式的厂商依赖都被纳入」。
 */
const VENDOR_DEPENDENCY_PATTERN = /^@(?:anthropic-ai|openai|deepseek-ai)\//;

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
 * 而 `providers/claude-code/subagent-usage.ts` 扫的不是代码目录，是**运行期数据目录**
 * （`<configHome>/projects/<项目目录>/<sessionId>/subagents/`）：项目目录名是 CLI 自己按 cwd 拼的，
 * 本仓明确**不重算那条规则**（算错会静默读到空目录，见 `readClaudeSubagentUsage` 的注释）
 * ⇒ 列举是唯一诚实的取数方式，而它与「打包」无关。
 *
 * 表**不许变长**：每加一项都要先在这里写清「它与 A3 无关」的理由；配套的用例还要求这张表**逐字**
 * 等于下面那一个元素（改路径、加第二项都会红），且表里每一项都真的在扫盘（留下死条目等于悄悄撑大豁免面）。
 * 豁免只按**逐项路径**匹配（不做目录前缀匹配）⇒ **其余文件的覆盖一字不减**：任何一个别的文件出现
 * `readdir` / `readdirSync` 照样被下面那条断言点名。
 */
const READDIR_ALLOWED: readonly string[] = ['providers/claude-code/subagent-usage.ts'];

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

  it('VENDOR_PACKAGES 与 package.json 的厂商依赖集合相同（同一份三元组不能有两个真源）', () => {
    // 为什么必须钉：将来新增/改名一家（或调整依赖）时，断言会**静默**失去覆盖——扫描照跑，
    // 只是再也没有一个源文件可能命中它。这里读 package.json 现比，不把版本或包名抄成测试字面量。
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const inManifest = Object.keys(manifest.dependencies ?? {})
      .filter((name) => VENDOR_DEPENDENCY_PATTERN.test(name))
      .sort();
    expect(inManifest).toEqual([...VENDOR_PACKAGES].sort());
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
    expect(READDIR_ALLOWED).toEqual(['providers/claude-code/subagent-usage.ts']);
    for (const file of READDIR_ALLOWED) {
      const text = readFileSync(join(import.meta.dirname, file), 'utf8');
      expect(/\breaddir(Sync)?\s*\(/.test(text), `${file} 已不再扫盘，应从例外表里删掉`).toBe(true);
    }
  });

  /**
   * dsh 依赖走 **`next` 线**，不是 `latest`。
   *
   * 理由是 `latest`（0.0.1-rc.1）把那几个包声明成 peerDependencies，pnpm 自动装 peer 时
   * `dsh-session` 又 peer 到 `@deepseek-ai/dsh-type-meta`，而该包在三家公开源**全 404**
   * ⇒ 按 `latest` 装在本机**不可能完成**。
   *
   * 原有的依赖守卫（`:271` 的 VENDOR_PACKAGES 断言）只比**名字集合**、不碰版本区间，
   * 于是「把版本写成 `latest`」不会有任何测试变红 —— 而那会让 `pnpm install` 直接失败。
   * 这里补的判据刻意与应用侧的依赖守卫**同口径**：版本区间不抄成测试字面量，
   * 读 `package.json` 现比「它是 next 线上的预发布版本」这一件事。
   *
   * 版本取 **0.2.0-rc.2**（用户口径「选择刚发的稳定版」：该包**从未发过非预发布版本**，
   * 最新非 alpha 即 next 线的 0.2.0-rc.2）。形状断言刻意是
   * 「任意 minor 的精确 rc 版本 + 不是 latest 线的 0.0.1-rc.1」——next 线会继续往前走，
   * 把 minor 钉死在 0.1 会让每次正常升级都要回来改守卫，而守卫真正要拦的只有
   * 「退回 latest 线（装不上）」与「写成带前缀的区间（预发布区间会静默漂移）」两件事。
   */
  it('dsh SDK 走 next 线：package.json 里是精确的 x.y.z-rc.N 版本，不是 latest 线', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const declared = manifest.dependencies?.['@deepseek-ai/dsh-sdk-client'];

    expect(declared, 'dsh SDK 必须声明在 agents 包的 dependencies 里').toBeTypeOf('string');
    // `latest` 线的形态是 `0.0.1-rc.1`，而 next 线是精确的 `x.y.z-rc.N` 预发布值
    // （pnpm 对预发布不写前缀，这也是「实测写入 0.1.7-rc.1」的由来）
    expect(declared).toMatch(/^\d+\.\d+\.\d+-rc\.\d+$/);
    expect(declared).not.toBe('0.0.1-rc.1');
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
 * `import.meta.url` 同时会被重写。
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

describe('打包器免疫：厂商入口的解析器', () => {
  it('codex 的可执行文件解析器满足三条免疫要求', () => {
    const text = readFileSync(join(import.meta.dirname, 'providers/codex/appserver/binary.ts'), 'utf8');
    expect(bundlerImmunityViolations(text)).toEqual([]);
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
