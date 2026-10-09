/**
 * codex 可执行文件解析（app-server 取数用）。
 *
 * 为什么需要它：app-server 取数要自己 spawn `codex app-server`，而生产环境里 codex **不在 PATH 上**
 * ——它由 CLI 包 `@openai/codex` 以「平台包」形式自带（该包的 optionalDependencies 把
 * `@openai/codex-win32-x64` 之类的别名指到 `@openai/codex@<版本>-<平台>`，二进制落在其 `vendor/` 下）。
 *
 * 解析链（CJS 解析，与 CLI 自己那条同一把尺）：
 *   `<CLI 包>/package.json` → CLI 包根
 *   `<平台包>/package.json`（以 CLI 包为基准）→ 同级 `vendor/` 即二进制根
 *   `<vendor>/<triple>/bin/codex(.exe)`
 *
 * **打包器免疫（两条，缺一不可）**：Next 的服务端构建会把 `node:module` 的 `createRequire` 换成自己的
 * `require`，其 `resolve()` 返回**打包器的模块 id**（形如 `[externals]/@openai/codex/package.json …`）
 * 而不是文件路径；它还会重写 `import.meta.url`。⇒ ① 用 `process.getBuiltinModule('module')` 向 Node
 * 取真的 `createRequire`；② 解析基准按列表逐个试、且**校验结果是不是文件路径**，不是就换下一个基准。
 * 缺任一条的表现都是「纯 Node 下正常、打包后 `AGENT_LOAD_FAILED`」。
 *
 * 为什么解析子路径而不是裸说明符：`@openai/codex` **没有 `exports` 字段**（`type: module`，入口只有
 * `bin/codex.js`，既无 `main` 也无 `index.js`）⇒ 裸说明符在两条解析器下都无物可落，能解析的只有
 * `package.json` 子路径（无 exports 的包按 legacy 规则直接命中文件）。
 *
 * 失败一律抛 `AgentLoadError`，文案里带上**走到哪一级**——「包没装」与「平台包缺 vendor」是两件事，
 * 让调用方分得开。
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { AgentLoadError } from '../../../errors';

/** 本模块报错时点名的包：故障面是「codex CLI 包没装好」，安装提示要指向真正该装的那一个 */
const CODEX_PACKAGE_NAME = '@openai/codex';

/**
 * 平台三元组 → 平台包名。**逐字抄自** `@openai/codex/bin/codex.js` 的
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
 * 取**真实的** `node:module`。
 *
 * 打包器会替换 `node:module` 的 `createRequire`，替换品的 `resolve()` 返回模块 id 而非文件路径
 * ⇒ 打包后必然解析失败。`process.getBuiltinModule` 直接向 Node 取内置模块，绕开替换；
 * 静态导入只作不支持该 API 的运行时兜底。
 */
function createNodeRequire(from: string): NodeRequire {
  const builtin = process.getBuiltinModule?.('module') as typeof import('node:module') | undefined;
  const factory = builtin?.createRequire ?? createRequire;
  return factory(from);
}

/** 解析结果的形态判据：模块 id 既不是绝对路径，还可能带 `[external…]` 标记 */
function isFilesystemPath(value: string): boolean {
  return isAbsolute(value) && !value.includes('[external');
}

/**
 * 解析基准候选。
 *
 * 为什么是列表：`import.meta.url` 在打包后指向产物内的文件，而 `process.cwd()` 未必是本仓的包目录
 * （从仓库根启动时它解析不到 `@openai/codex`）——单一基准都会在某些启动方式下失效。
 */
function resolutionAnchors(): string[] {
  return [import.meta.url, join(process.cwd(), 'noop.js')];
}

/**
 * 按基准顺序解析一个子路径说明符，返回**真实文件路径**。
 *
 * 逐个基准试、任一成功即返回；解析器被污染时（结果不是文件路径）同样换下一个基准，
 * 而不是把模块 id 当路径继续往下走——「打包后失败、纯 Node 正常」正是那么来的。
 */
export function resolvePackageFile(
  specifier: string,
  anchors: readonly string[] = resolutionAnchors(),
  makeRequire: (from: string) => { resolve: (id: string) => string } = createNodeRequire,
): string {
  const failures: string[] = [];
  for (const anchor of anchors) {
    try {
      const resolved = makeRequire(anchor).resolve(specifier);
      if (isFilesystemPath(resolved)) return resolved;
      failures.push(`${anchor} ⇒ 非文件路径：${resolved}`);
    } catch (error) {
      failures.push(`${anchor} ⇒ ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`解析 ${specifier} 失败（${failures.join('；')}）`);
}

/**
 * 解析本机 codex 可执行文件的绝对路径。
 *
 * 每一步都记进 `steps`：报错时把它们拼进文案，直接看出断在哪一级（CLI 包 / 平台包 / 二进制文件）。
 */
export function resolveCodexBinary(): string {
  const triple = platformTargetTriple();
  const steps: string[] = [`平台=${process.platform}/${process.arch}`];
  try {
    if (triple === null) throw new Error('该平台没有对应的 codex 平台包');
    steps.push(`三元组=${triple}`);

    const codexPackageJson = resolvePackageFile(`${CODEX_PACKAGE_NAME}/package.json`);
    steps.push(`codex=${codexPackageJson}`);

    const platformPackage = PLATFORM_PACKAGE_BY_TRIPLE[triple];
    if (platformPackage === undefined) throw new Error(`三元组 ${triple} 没有登记平台包名`);
    // 第二跳以 CLI 包的 package.json 为基准：平台包是它的同级依赖，以本模块为基准在 pnpm 布局下拿不到
    const platformPackageJson = resolvePackageFile(`${platformPackage}/package.json`, [codexPackageJson]);
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
