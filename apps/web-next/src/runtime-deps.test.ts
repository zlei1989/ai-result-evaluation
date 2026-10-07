// @vitest-environment node
/**
 * 外置厂商 SDK 的**应用侧声明**（契约 R35）。
 *
 * 为什么存在：`apps/web-next/next.config.ts` 的 `serverExternalPackages` 只让 Next 把三家 SDK
 * **外置成裸说明符**（形如 `import '@openai/codex-sdk'`），而裸说明符是 **Node 在产物目录里解析**的：
 * 产物落在 `apps/web-next/.next/server/chunks/`，Node 从那里逐级向上找 `node_modules`，而 pnpm 的
 * 隔离式布局只把它们链在 `packages/server/agents/node_modules/`。实测（p3 Task 2 的 build 复核）：
 * 从 `.next/server/chunks/`、`apps/web-next/`、仓库根三处 `createRequire().resolve()` 三家**全部
 * `MODULE_NOT_FOUND`** ⇒ 少了 app 侧这条声明，p4/p5 第一次真实 `import('@aieval/agents')` 就会在
 * **运行时**炸。这不是打包优化，是「能不能跑起来」的问题。
 *
 * 两条断言的分工：
 * 1. **声明与区间**：三家必须在 app 的 `dependencies` 里，且与 `agents` 包的区间**逐字相同**。
 *    区间刻意不写进本文件当字面量——那等于造出第二个真相源；这里两边都读 JSON 现比。
 * 2. **真解析**：只解析路径、**不加载模块**，钉住「Node 从应用侧找不找得到它」这个失败面。
 *    ⚠️ 实测修正：`createRequire().resolve()` **不是**与 ESM/CJS 无关——它走 exports 的 `require` 条件，
 *    而 `@openai/codex-sdk` 是 ESM-only（exports 只有 `import`/`types`，没有 `require`/`default`），
 *    于是它必抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`（包本身的性质，不是声明缺失）。故这里**两条解析器都试**：
 *    CJS 解析器（`require` 条件）优先，失败则退到 ESM 解析器（`import` 条件，与我们的 `await import()` 同路），
 *    只要有一条能从应用侧找到它即算通过。
 *    ⚠️ 但这也意味着：**若 Next 最终按 `commonjs` 外置 codex，运行时会撞 ERR_PACKAGE_PATH_NOT_EXPORTED**。
 *    本文件只保证「解析得到」，不保证「Next 选了哪种外置形态」——那要等真实 import 落地后在 p6 冒烟里证。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 三家厂商 SDK：与 `agents` 包的 `dependencies` 同名同区间 */
const EXTERNAL_SDKS = ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk', '@deepseek-ai/dsh-sdk-client'];

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

/** 走 exports 的 `require` 条件（Next 若按 commonjs 外置即此路）；解析不到返回 null */
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

describe('外置厂商 SDK 的应用侧声明（契约 R35）', () => {
  it('三家都在 apps/web-next 的 dependencies 里，且区间与 agents 包逐字相同', () => {
    const appDeps = readDependencies(appRoot);
    const agentsDeps = readDependencies(agentsRoot);
    for (const name of EXTERNAL_SDKS) {
      expect(appDeps[name], `${name} 必须声明在 apps/web-next 的 dependencies 里`).toBeTruthy();
      expect(appDeps[name], `${name} 的版本区间必须与 agents 包逐字相同`).toBe(agentsDeps[name]);
    }
  });

  it('三家都能从应用根目录解析（CJS 或 ESM 解析器至少一条通）', () => {
    for (const name of EXTERNAL_SDKS) {
      const resolved = tryCjsResolve(name) ?? tryEsmResolve(name);
      expect(resolved, `${name} 从 apps/web-next 解析不到：裸说明符会在产物目录里 MODULE_NOT_FOUND`).toBeTruthy();
    }
  });
});
