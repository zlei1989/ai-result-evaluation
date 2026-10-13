/**
 * Next 配置：把 workspace 内的 TS 源码包纳入编译。
 * 这些包的 `main` 直接指向 `./src/index.ts`，不预先构建产物——Next 靠 transpilePackages 编译它们。
 * 注意：厂商 SDK 是**运行时依赖**——它们要定位自身的 CLI / 原生二进制 / 包内资产（pi 的 WASM 与
 * 包目录推导就在其中），被打进 server bundle 后定位会失效；故在 serverExternalPackages 里逐个外置。
 * 名单与 `packages/server/agents` 的依赖同步，缺一处即「编得过、跑不起来」：判据是
 * `src/runtime-deps.test.ts`（名单从那份依赖派生，不在这里手写第二份）。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@aieval/contracts', '@aieval/core', '@aieval/agents', '@aieval/evaluator', '@aieval/api', '@aieval/ui', '@aieval/client'],
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex',
    '@deepseek-ai/dsh-sdk-client',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    '@tintinweb/pi-subagents',
    'typebox',
  ],
  reactStrictMode: true,
};

export default nextConfig;
