// @vitest-environment node
/**
 * `binary.ts` 的行为契约。
 *
 * 前两组是纯函数（跨平台可测，不依赖本机装了什么）；最后一组是**真机守卫**——
 * 解析链断在哪一级（SDK 换导出条件、平台包改名、vendor 布局变化）都要在这里红，
 * 而不是等到生产环境 spawn 出 `ENOENT`。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformTargetTriple, resolveCodexBinary, vendorBinaryPath } from './binary';

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
  it('解析到本机真实存在的文件', () => {
    const binary = resolveCodexBinary();
    expect(binary.length).toBeGreaterThan(0);
    expect(binary.endsWith('codex.exe') || binary.endsWith('codex')).toBe(true);
    expect(existsSync(binary)).toBe(true);
  });
});
