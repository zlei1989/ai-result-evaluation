// @vitest-environment node
/**
 * 运行期外置的厂商包在**应用侧**的声明与可解析性。
 *
 * 为什么存在：`apps/web-next/next.config.ts` 的 `serverExternalPackages` 把厂商包登记成
 * **运行期按裸说明符 / 按路径定位**的依赖，而那种定位是 **Node 在产物目录里做**的：产物落在
 * `apps/web-next/.next/server/chunks/`，Node 从那里逐级向上找 `node_modules`，而 pnpm 的隔离式布局
 * 只把它们链在 `packages/server/agents/node_modules/`。 ⇒ 少了 app 侧这条声明，运行期第一次定位
 * 就会 `MODULE_NOT_FOUND`。这不是打包优化，是「能不能跑起来」的问题。
 *
 * **名单从 `packages/server/agents` 的 `dependencies` 派生**，不在这里手写第二份：手写的那一份与
 * 依赖清单必然漂移，而漂移是**静默**的——新接一家厂商 SDK 时补了依赖、忘了 app 侧声明，本文件照样全绿，
 * 直到运行期才炸。派生之后，加一条依赖就自动进这张表。
 * 两类显式例外（都要在这里写一行并说明理由，默认是「必须声明」）：
 *  · `BUNDLED_DEPENDENCIES`：随源码被编译进 server chunk 的纯 JS 依赖，不经产物目录解析；
 *  · `RESOLUTION_FORMS`：运行期解析形态与默认不同的包（今天只有 codex）。
 *
 * 两家的**运行期需要不同**，判据因此不同（判据必须与运行期真正解析的东西一致）：
 *  · `@anthropic-ai/claude-agent-sdk` / `@deepseek-ai/dsh-sdk-client` / `@earendil-works/pi-coding-agent`：
 *    适配器 `await import('<包名>')` ⇒ 解析的是**裸说明符**。三家都是 ESM-only（`exports` 只有
 *    `import`/`types`，没有 `require`/`default`），故 `createRequire().resolve()` 必抛
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED`——那是包本身的性质，不是声明缺失。这里两条解析器都试：
 *    CJS 优先，失败退到与 `await import()` 同路的 ESM，任一通即算通过。
 *  · `@openai/codex`：适配器**不 import 它**，只用
 *    `createRequire(import.meta.url).resolve('@openai/codex/package.json')` 定位包根，再按平台三元组
 *    往下找平台包 `vendor/<triple>/bin/codex(.exe)`（见 `providers/codex/appserver/binary.ts`）。
 *    该包的形态是**既无 `exports` 也无 `main`**（`type: module`，入口只有 `bin/codex.js`）
 * ⇒ 裸说明符在两条解析器下都无入口可落、**都解析不到**，可解析的只有子路径 `package.json`
 * （无 `exports` 的包按 legacy 规则直接命中文件）。判据因此固定成「CJS 解析器 + 那条子路径」：
 *    这正是运行期真正走的解析器与说明符，换成裸说明符就等于判了一条运行期不存在路径。
 *
 * 三条断言的分工：
 * 1. **声明与区间**：派生出的每一家必须在 app 的 `dependencies` 里，且与 `agents` 包的区间**逐字相同**。
 *    区间刻意不写进本文件当字面量——那等于造出第二个真相源；这里两边都读 JSON 现比。
 * 2. **真解析**：只解析路径、**不加载模块**，钉住「Node 从应用侧找不找得到它」这个失败面。
 *    本文件只保证「解析得到」，不保证真实 import 落地后 Next 选了哪种外置形态——那要在起服务跑一行
 *    agent 时证。
 * 3. **外置清单与派生集合逐项相同**：漏外置（该外置的没外置）与多外置（外置了本表不认识的包）都要红。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

/** 解析器选择：`'either'` = CJS 与 ESM 两条都试；`'cjs'` = 只有 CJS 那条（见文件头关于 codex 形态的说明） */
type ResolverKind = 'either' | 'cjs';

interface ExternalSdk {
  name: string;
  specifier: string;
  resolvers: ResolverKind;
}

/**
 * 已随源码编译进 server chunk 的依赖：**不经**产物目录解析，故不进本表。
 * 只有写在这里的名字才被排除——漏写一个厂商包的表现是运行期 `MODULE_NOT_FOUND`，所以默认是严的。
 */
const BUNDLED_DEPENDENCIES: readonly string[] = ['zod'];

/** 运行期解析形态与默认（裸说明符 + 两条解析器）不同的包 */
const RESOLUTION_FORMS: Record<string, { specifier: string; resolvers: ResolverKind }> = {
  '@openai/codex': { specifier: '@openai/codex/package.json', resolvers: 'cjs' },
  // 扩展包同样**没有任何入口字段**（`main` / `module` / `exports` / `types` / `type` 全无，根下也没有
  // `index.js`）：裸说明符在两条解析器下都无入口可落 ⇒ 可解析的只有子路径 `package.json`，
  // 适配器也是拿它定位包根、再拼出交给 pi 扩展加载器的 `src/index.ts`
  '@tintinweb/pi-subagents': { specifier: '@tintinweb/pi-subagents/package.json', resolvers: 'cjs' },
};

interface PackageJsonShape {
  dependencies?: Record<string, string>;
}

/** 应用根目录（`apps/web-next`）：用文件自身位置推导，不依赖 `process.cwd()` */
const appRoot = join(import.meta.dirname, '..');
/**agents 包目录：这些厂商包的**声明真源**（把它们装在这个包） */
const agentsRoot = join(appRoot, '..', '..', 'packages', 'server', 'agents');
/** 以「应用根目录下的一个文件」为基准的 CJS 解析器：等价于产物在 `.next/server/chunks/` 里 require */
const requireFromApp = createRequire(join(appRoot, 'probe.js'));

/** 读某个包 `dependencies` 的现值；缺失的依赖不会出现在返回对象里 */
function readDependencies(root: string): Record<string, string> {
  const raw = readFileSync(join(root, 'package.json'), 'utf8');
  return (JSON.parse(raw) as PackageJsonShape).dependencies ?? {};
}

/**
 * 从 `agents` 的 `dependencies` 派生本表：工作区包（`workspace:` 区间）由 `transpilePackages` 编译、
 * 不经 node_modules 定位，故排除；其余按名字排序，形态取 `RESOLUTION_FORMS` 的例外或默认。
 */
function deriveExternalSdks(): ExternalSdk[] {
  return Object.entries(readDependencies(agentsRoot))
    .filter(([name, range]) => !range.startsWith('workspace:') && !BUNDLED_DEPENDENCIES.includes(name))
    .map(([name]) => ({ name, ...(RESOLUTION_FORMS[name] ?? { specifier: name, resolvers: 'either' as const }) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const EXTERNAL_SDKS = deriveExternalSdks();

/** 走 exports 的 `require` 条件（`createRequire` 与「无 exports 的包」的 legacy 解析都在这条路上）；解析不到返回 null */
function tryCjsResolve(name: string): string | null {
  try {
    return requireFromApp.resolve(name);
  } catch {
    return null;
  }
}

/** 走 exports 的 `import` 条件（本包的动态 import() 即此路）；解析不到返回 null */
function tryEsmResolve(name: string): string | null {
  try {
    return fileURLToPath(import.meta.resolve(name));
  } catch {
    return null;
  }
}

describe('外置厂商包的应用侧声明', () => {
  it('派生集合非空且不含工作区包（派生被改窄成空集时，下面两条会静默通过）', () => {
    expect(EXTERNAL_SDKS.length).toBeGreaterThan(0);
    for (const { name } of EXTERNAL_SDKS) {
      expect(name.startsWith('@aieval/'), `${name} 是工作区包，不该进外置表`).toBe(false);
    }
  });

  it('派生的每一家都在 apps/web-next 的 dependencies 里，且区间与 agents 包逐字相同', () => {
    const appDeps = readDependencies(appRoot);
    const agentsDeps = readDependencies(agentsRoot);
    for (const { name } of EXTERNAL_SDKS) {
      expect(appDeps[name], `${name} 必须声明在 apps/web-next 的 dependencies 里`).toBeTruthy();
      expect(appDeps[name], `${name} 的版本区间必须与 agents 包逐字相同`).toBe(agentsDeps[name]);
    }
  });

  it('每一家的运行期说明符都能从应用根目录解析（用各家可用的那条解析器）', () => {
    for (const { name, specifier, resolvers } of EXTERNAL_SDKS) {
      const resolved =
        resolvers === 'cjs' ? tryCjsResolve(specifier) : (tryCjsResolve(specifier) ?? tryEsmResolve(specifier));
      expect(
        resolved,
        `${name} 从 apps/web-next 解析不到 ${specifier}：运行期会在产物目录里 MODULE_NOT_FOUND`,
      ).toBeTruthy();
    }
  });

  /**
   * 两个方向都要钉：外置了一个本表不认识的包 ⇒ 它该进 `agents` 的依赖或本不该外置；
   * 派生的某一家人没被外置 ⇒ 它会**被打进 server bundle**，包内的路径定位（CLI / 原生二进制 /
   * WASM 与包目录推导）随之失效——那正是「编得过、跑不起来」。
   */
  it('serverExternalPackages 与派生集合逐项相同（漏外置与多外置都红）', () => {
    const external = nextConfig.serverExternalPackages ?? [];
    expect(external.length).toBeGreaterThan(0);
    expect([...external].sort(), '外置清单必须与 agents 的运行期依赖逐项对上').toEqual(
      EXTERNAL_SDKS.map((sdk) => sdk.name),
    );
  });
});
