// @vitest-environment node
/**
 * `binary.ts` 的行为契约。
 *
 * 前两组是纯函数（跨平台可测，不依赖本机装了什么）；最后一组是**真机守卫**——
 * 解析链断在哪一级（CLI 包换导出形态、平台包改名、vendor 布局变化）都要在这里红，
 * 而不是等到生产环境 spawn 出 `ENOENT`。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformTargetTriple, resolveCodexBinary, resolvePackageFile, vendorBinaryPath } from './binary';

describe('platformTargetTriple —— 平台三元组', () => {
  it('按 platform/arch 给出 SDK 认的三元组', () => {
    expect(platformTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(platformTargetTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
    expect(platformTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(platformTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(platformTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(platformTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
  });

  it('不认识的组合返回 null（不猜一个近似的出来）', () => {
    expect(platformTargetTriple('sunos', 'sparc')).toBeNull();
    expect(platformTargetTriple('win32', 'ia32')).toBeNull();
    expect(platformTargetTriple('linux', 'ppc64')).toBeNull();
  });
});

describe('vendorBinaryPath —— vendor 下的二进制路径', () => {
  it('win32 用 codex.exe，其余平台用 codex', () => {
    expect(vendorBinaryPath('/v', 'x86_64-pc-windows-msvc', 'win32')).toBe(
      join('/v', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    );
    expect(vendorBinaryPath('/v', 'x86_64-apple-darwin', 'darwin')).toBe(
      join('/v', 'x86_64-apple-darwin', 'bin', 'codex'),
    );
  });
});

describe('resolveCodexBinary —— 真机解析链', () => {
  it('解析到平台包 vendor 下真实存在的可执行文件', () => {
    const binary = resolveCodexBinary();
    const triple = platformTargetTriple();
    expect(triple).not.toBeNull();
    // 判据是**路径形状**而不是「文件存在」：CLI 包自己的 `bin/codex.js` 同样存在，
    // 但那是 node 脚本、不是能 spawn `codex app-server` 的原生可执行文件。
    const segments = binary.split(/[\\/]/);
    expect(segments.slice(-4)).toEqual([
      'vendor',
      triple,
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    ]);
    expect(existsSync(binary)).toBe(true);
    /**
     * 覆盖边界（如实登记）：测试进程里裸说明符的解析由运行器接管（vite-node/vitest 的解析器，
     * 带 pnpm store 感知），比生产 Node 的 `createRequire` 宽松 ⇒ 本用例只钉**解析结果的形状**，
     * 对「第二跳的基准写成 `import.meta.url`」那一类缺陷是盲的。第二跳的基准由 `binary.ts` 的
     * `resolvePackageFile(…, [codexPackageJson])` 承担：平台包是 CLI 包的 optionalDependency，
     * 只链在 CLI 包自己的 `node_modules` 下。
     * 「解析器被打包器换掉」另有一组守卫（见下），不依赖运行器行为。
     */
  });
});

describe('resolvePackageFile —— 解析器被污染或基准失效时换下一个', () => {
  const realPath = join(process.cwd(), 'node_modules', '@openai', 'codex', 'package.json');

  it('解析器返回打包器的模块 id 时跳过该基准，而不是把它当文件路径', () => {
    // 打包器（Next 服务端构建）把 node:module 的 createRequire 换成自己的 require，
    // resolve() 于是返回 `[externals]/…` 这样的模块 id —— 生产就是这么挂的。
    const resolved = resolvePackageFile('@openai/codex/package.json', ['file:///a.js', 'file:///b.js'], (from) =>
      from === 'file:///a.js'
        ? { resolve: () => '[externals]/@openai/codex/package.json [external] (@openai/codex/package.json, cjs)' }
        : { resolve: () => realPath },
    );
    expect(resolved).toBe(realPath);
  });

  it('所有基准都拿不到文件路径 ⇒ 抛错，并留下每个基准的失败原因', () => {
    const call = (): string =>
      resolvePackageFile('@openai/codex/package.json', ['file:///a.js'], () => ({
        resolve: () => '[externals]/@openai/codex/package.json [external]',
      }));
    expect(call).toThrow(/非文件路径/);
  });

  it('某个基准直接抛错时继续试下一个', () => {
    const resolved = resolvePackageFile('@openai/codex/package.json', ['file:///a.js', 'file:///b.js'], (from) => ({
      resolve: () => {
        if (from === 'file:///a.js') throw new Error('MODULE_NOT_FOUND');
        return realPath;
      },
    }));
    expect(resolved).toBe(realPath);
  });
});
