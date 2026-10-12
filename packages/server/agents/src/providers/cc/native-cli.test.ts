// @vitest-environment node
/**
 * 环境级不变量：Claude Code SDK 的**本机平台二进制**真实躺在 node_modules 里。
 *
 * 故障形态：`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.281` 只剩空目录骨架
 * （中断的 install 留下的残缺 slot），而 pnpm 的 lockfile 与 `node_modules/.package-map.json` 都认为
 * 它已装好 ⇒ 后续 `pnpm install` 永远 "Already up to date"，缺陷静默存活。真机评测跑到
 * `provider.run` 时 SDK 才抛 `AGENT_FAILED: Native CLI binary for darwin-arm64 not found. …`。
 *
 * 为什么全套单测拦不住它（测试环境 ≠ 运行环境，如实登记）：evaluator / orchestrator 的用例把
 * SDK 换成假 fixture（`testing/agent-fixtures.ts`），二进制的解析链根本不跑 ⇒ `pnpm test` 全绿
 * 与「真机能起」毫无关系。本守卫不 mock、不 spawn、不加载 SDK 模块本体——只复刻 SDK 内部 BK 的
 * 解析步骤（从 sdk.mjs 实际位置 `createRequire`，`resolve('<平台包>/claude')` + 存在性检查），
 * 把「二进制在不在」从真机运行期提前到测试期。
 *
 * 覆盖边界（如实登记）：只拦「resolve 不到 / 文件不存在」两类形态；「文件在但损坏或被杀软清空」
 * 不在射程内（与 SDK 自身的 exists 检查同边界，那种形态 SDK 自己也会放行）。
 */
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { CLAUDE_PACKAGE_NAME } from './sdk';

/**
 * 复刻 SDK `BK` 的平台包解析（判据源：安装态 `sdk.mjs` 里 `pathToClaudeCodeExecutable`
 * 未提供时的定位链）。逐点对齐：
 *   · 解析基点：sdk.mjs 的**实际落点**（`.pnpm` 实体目录），与本测试所在目录无关；
 *   · 说明符：`<SDK 包名>-<platform>-<arch>/claude`（win32 加 `.exe`，与 BK 同形）；
 *   · linux 双候选：BK 用 glibc 探测决定 gnu/musl 顺序，但两个候选都在它的列表里——
 *     「按序试到成功」与「任一存在即绿」语义等价；
 *   · 失败形态：候选逐个试，resolve 抛错或文件不存在就落空（与 BK 的 for-catch 同形）。
 *
 * @param target 允许注入 platform/arch（默认取本机），供负例证明判据「能红」。
 */
function resolveClaudeNativeBinary(target: { platform: string; arch: string } = process): string | undefined {
  const suffix = target.platform === 'win32' ? '.exe' : '';
  const candidates =
    target.platform === 'linux'
      ? [
        `${CLAUDE_PACKAGE_NAME}-linux-${target.arch}-musl/claude${suffix}`,
        `${CLAUDE_PACKAGE_NAME}-linux-${target.arch}/claude${suffix}`,
      ]
      : [`${CLAUDE_PACKAGE_NAME}-${target.platform}-${target.arch}/claude${suffix}`];
  // 第一跳：从本测试文件出发解析 SDK 主入口，拿到 sdk.mjs 的绝对路径（exports["."] -> ./sdk.mjs；
  // require.resolve 只解析路径、不加载模块，ESM-only 无碍）
  const requireAtSdk = createRequire(createRequire(import.meta.url).resolve(CLAUDE_PACKAGE_NAME));
  for (const specifier of candidates) {
    try {
      const resolved = requireAtSdk.resolve(specifier);
      if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
    } catch {
      // 该平台包不在解析路径上（未安装 / 空壳残缺）——继续试下一个候选，全部落空即判「缺陷在」
    }
  }
  return undefined;
}

describe('Claude Code 平台二进制的环境守卫', () => {
  it('本机平台的 claude 原生二进制可被 SDK 的解析链找到（复刻 BK；空壳残缺会红）', () => {
    const resolved = resolveClaudeNativeBinary();
    // 报错文案带判据来源：红的时候一眼能看出缺的是哪个平台包、该走什么修复路径
    expect(resolved, `SDK 的 BK 解析落空：${CLAUDE_PACKAGE_NAME}-${process.platform}-${process.arch} 未安装或为空壳`).toBeTypeOf('string');
  });

  it('判据在「平台包缺失」形态下真的红（freebsd 是 SDK 根本不发布的平台，任何机器上都缺失）', () => {
    /**
     * 为什么单开一条：上面那条只能证明「当前环境是好的」，证明不了判据**有覆盖**——
     * 没见过失败的守卫不算守卫。freebsd 平台包在 npm 上不存在，任何机器上都 resolve 不到，
     * 是无需人为制造、跨平台稳定的缺失形态（用 linux-x64 之类做负例会在对应机器上假红）。
     */
    expect(resolveClaudeNativeBinary({ platform: 'freebsd', arch: 'x64' })).toBeUndefined();
  });
});
