/**
 * Next 配置：把 workspace 内的 TS 源码包纳入编译。
 * 这些包的 `main` 直接指向 `./src/index.ts`，不预先构建产物——Next 靠 transpilePackages 编译它们。
 * 注意：厂商 SDK 是**运行时依赖**（spec §5.6.2）——它们要定位自身的 CLI / 原生二进制，
 * 被打进 server bundle 后定位会失效；故在 serverExternalPackages 里逐个外置。
 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@aieval/contracts', '@aieval/core', '@aieval/agents', '@aieval/evaluator', '@aieval/api', '@aieval/ui', '@aieval/client'],
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    '@deepseek-ai/dsh-sdk-client',
  ],
  reactStrictMode: true,
};

export default nextConfig;
