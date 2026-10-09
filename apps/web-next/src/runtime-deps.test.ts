// @vitest-environment node
/**
 * 外置厂商包在**应用侧**的声明与可解析性（契约 R35）。
 *
 * 为什么存在：`apps/web-next/next.config.ts` 的 `serverExternalPackages` 把三家厂商包登记成
 * **运行期按裸说明符 / 按路径定位**的依赖，而那种定位是 **Node 在产物目录里做**的：产物落在
 * `apps/web-next/.next/server/chunks/`，Node 从那里逐级向上找 `node_modules`，而 pnpm 的隔离式布局
 * 只把它们链在 `packages/server/agents/node_modules/`。⇒ 少了 app 侧这条声明，运行期第一次定位
 * 就会 `MODULE_NOT_FOUND`。这不是打包优化，是「能不能跑起来」的问题。
 *
 * 两家与 codex 的**运行期需要不同**，判据因此不同（判据必须与运行期真正解析的东西一致）：
 *  · `@anthropic-ai/claude-agent-sdk` / `@deepseek-ai/dsh-sdk-client`：适配器 `await import('<包名>')`
 *    ⇒ 解析的是**裸说明符**。两家都是 ESM-only（`exports` 只有 `import`/`types`，没有 `require`/`default`），
 *    故 `createRequire().resolve()` 必抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`——那是包本身的性质，
 *    不是声明缺失。这里两条解析器都试：CJS 优先，失败退到与 `await import()` 同路的 ESM，任一通即算通过。
 *  · `@openai/codex`：适配器**不 import 它**，只用
 *    `createRequire(import.meta.url).resolve('@openai/codex/package.json')` 定位包根，再按平台三元组
 *    往下找平台包 `vendor/<triple>/bin/codex(.exe)`（见 `providers/codex/appserver/binary.ts`）。
 *    该包的形态是**既无 `exports` 也无 `main`**（`type: module`，入口只有 `bin/codex.js`）
 *    ⇒ 裸说明符在两条解析器下都无入口可落、**都解析不到**，可解析的只有子路径 `package.json`
 *    （无 `exports` 的包按 legacy 规则直接命中文件）。判据因此固定成「CJS 解析器 + 那条子路径」：
 *    这正是运行期真正走的解析器与说明符，换成裸说明符就等于判了一条运行期不存在的路径。
 *
 * 两条断言的分工：
 * 1. **声明与区间**：三家必须在 app 的 `dependencies` 里，且与 `agents` 包的区间**逐字相同**。
 *    区间刻意不写进本文件当字面量——那等于造出第二个真相源；这里两边都读 JSON 现比。
 * 2. **真解析**：只解析路径、**不加载模块**，钉住「Node 从应用侧找不找得到它」这个失败面。
 *    本文件只保证「解析得到」，不保证真实 import 落地后 Next 选了哪种外置形态——那要在起服务跑一行
 *    agent 时证。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 三家厂商包：声明名（与 `agents` 包的 `dependencies` 同名）+ 运行期真正要解析的说明符 + 哪条解析器算数。
 * `'either'` = 两条都试（ESM-only 的裸说明符）；`'cjs'` = 只有 CJS 那条（见文件头关于 `@openai/codex` 形态的说明）。
 */
const EXTERNAL_SDKS = [
  { name: '@anthropic-ai/claude-agent-sdk', specifier: '@anthropic-ai/claude-agent-sdk', resolvers: 'either' },
  { name: '@openai/codex', specifier: '@openai/codex/package.json', resolvers: 'cjs' },
  { name: '@deepseek-ai/dsh-sdk-client', specifier: '@deepseek-ai/dsh-sdk-client', resolvers: 'either' },
] as const;

interface PackageJsonShape {
  dependencies?: Record<string, string>;
}

/** 应用根目录（`apps/web-next`）：用文件自身位置推导，不依赖 `process.cwd()` */
const appRoot = join(import.meta.dirname, '..');
/** agents 包目录：这三家的**声明真源**（spec §5.6.2 把它们装在这个包） */
const agentsRoot = join(appRoot, '..', '..', 'packages', 'server', 'agents');
/** 以「应用根目录下的一个文件」为基准的 CJS 解析器：等价于产物在 `.next/server/chunks/` 里 require */
const requireFromApp = createRequire(join(appRoot, 'probe.js'));

/** 读某个包 `dependencies` 的现值；缺失的依赖不会出现在返回对象里 */
function readDependencies(root: string): Record<string, string> {
  const raw = readFileSync(join(root, 'package.json'), 'utf8');
  return (JSON.parse(raw) as PackageJsonShape).dependencies ?? {};
}

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

describe('外置厂商包的应用侧声明（契约 R35）', () => {
  it('三家都在 apps/web-next 的 dependencies 里，且区间与 agents 包逐字相同', () => {
    const appDeps = readDependencies(appRoot);
    const agentsDeps = readDependencies(agentsRoot);
    for (const { name } of EXTERNAL_SDKS) {
      expect(appDeps[name], `${name} 必须声明在 apps/web-next 的 dependencies 里`).toBeTruthy();
      expect(appDeps[name], `${name} 的版本区间必须与 agents 包逐字相同`).toBe(agentsDeps[name]);
    }
  });

  it('三家的运行期说明符都能从应用根目录解析（用各家可用的那条解析器）', () => {
    for (const { name, specifier, resolvers } of EXTERNAL_SDKS) {
      const resolved =
        resolvers === 'cjs' ? tryCjsResolve(specifier) : (tryCjsResolve(specifier) ?? tryEsmResolve(specifier));
      expect(
        resolved,
        `${name} 从 apps/web-next 解析不到 ${specifier}：运行期会在产物目录里 MODULE_NOT_FOUND`,
      ).toBeTruthy();
    }
  });
});
