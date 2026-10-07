/**
 * codex 可执行文件解析（app-server 取数用）。
 *
 * 为什么需要它：app-server 取数要自己 spawn `codex app-server`，而生产环境里 codex **不在 PATH 上**
 * ——它由 `@openai/codex-sdk` 以「平台包」形式自带（`@openai/codex` 的 optionalDependencies 把
 * `@openai/codex-win32-x64` 之类的别名指到 `@openai/codex@<版本>-<平台>`）。
 *
 * 解析链**逐级复刻 SDK 自己那条**（该包 `dist/index.js` 的 `findCodexPath`），不猜路径、不新增依赖：
 *   `import.meta.resolve('@openai/codex-sdk')`             → SDK 入口 URL（**必须走 ESM**：
 *                                                            require 条件会 `ERR_PACKAGE_PATH_NOT_EXPORTED`）
 *   `createRequire(该 URL).resolve('@openai/codex/package.json')`
 *   `createRequire(该路径).resolve('<平台包>/package.json')` → 同级 `vendor/` 即二进制根
 *   `<vendor>/<triple>/bin/codex(.exe)`
 *
 * 失败一律抛 `AgentLoadError`，文案里带上**走到哪一级**——「包没装」与「平台包缺 vendor」是两件事，
 * 让调用方分得开。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AgentLoadError } from '../../../errors';

/** 本模块报错时点名的包（与 `sdk.ts` 同值：故障面仍是「codex 那家 SDK 没装好」） */
const CODEX_PACKAGE_NAME = '@openai/codex-sdk';

/**
 * 平台三元组 → 平台包名。**逐字抄自** `@openai/codex-sdk/dist/index.js` 的
 * `PLATFORM_PACKAGE_BY_TARGET`（换 CLI 版本时这一格要跟着核对，错的表现是 MODULE_NOT_FOUND）。
 */
const PLATFORM_PACKAGE_BY_TRIPLE: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

/** 平台三元组；不认识的组合返回 `null`（**不猜**一个近似的出来） */
export function platformTargetTriple(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'win32') {
    if (arch === 'x64') return 'x86_64-pc-windows-msvc';
    if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
    return null;
  }
  if (platform === 'darwin') {
    if (arch === 'x64') return 'x86_64-apple-darwin';
    if (arch === 'arm64') return 'aarch64-apple-darwin';
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'x86_64-unknown-linux-musl';
    if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
    return null;
  }
  return null;
}

/** vendor 根 + 三元组 ⇒ 二进制路径（Windows 下带 `.exe`） */
export function vendorBinaryPath(
  vendorRoot: string,
  triple: string,
  platform: string = process.platform,
): string {
  return join(vendorRoot, triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex');
}

/**
 * 取 `import.meta.resolve`。
 *
 * 为什么要绕这一下：它是 ESM 能力，类型面随 `module` 设置而变——显式取一次并自证可用，
 * 比让编译器的 lib 设置决定这段代码能不能编译更稳（缺了就给明确错误，而不是运行期 `undefined()`）。
 */
function resolveEsmEntry(specifier: string): string {
  const meta = import.meta as ImportMeta & { resolve?: (one: string) => string };
  if (typeof meta.resolve !== 'function') {
    throw new Error('当前运行时不支持 import.meta.resolve，无法解析 codex 可执行文件');
  }
  return meta.resolve(specifier);
}

/**
 * 解析本机 codex 可执行文件的绝对路径。
 *
 * 每一步都记进 `steps`：报错时把它们拼进文案，直接看出断在哪一级（SDK 入口 / `@openai/codex` /
 * 平台包 / 二进制文件）。
 */
export function resolveCodexBinary(): string {
  const triple = platformTargetTriple();
  const steps: string[] = [`平台=${process.platform}/${process.arch}`];
  try {
    if (triple === null) throw new Error('该平台没有对应的 codex 平台包');
    steps.push(`三元组=${triple}`);

    const sdkEntry = resolveEsmEntry(CODEX_PACKAGE_NAME);
    steps.push(`sdk=${sdkEntry}`);

    const codexPackageJson = createRequire(sdkEntry).resolve('@openai/codex/package.json');
    steps.push(`codex=${codexPackageJson}`);

    const platformPackage = PLATFORM_PACKAGE_BY_TRIPLE[triple];
    if (platformPackage === undefined) throw new Error(`三元组 ${triple} 没有登记平台包名`);
    const platformPackageJson = createRequire(codexPackageJson).resolve(`${platformPackage}/package.json`);
    steps.push(`平台包=${platformPackageJson}`);

    const binary = vendorBinaryPath(join(dirname(platformPackageJson), 'vendor'), triple);
    steps.push(`二进制=${binary}`);
    if (!existsSync(binary)) throw new Error('解析出的路径下没有该文件');

    return binary;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AgentLoadError(
      CODEX_PACKAGE_NAME,
      new Error(`找不到 codex 可执行文件：${reason}（${steps.join(' → ')}）`),
    );
  }
}
