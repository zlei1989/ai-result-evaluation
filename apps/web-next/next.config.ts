/**
 * Next 配置：把 workspace 内的 TS 源码包纳入编译。
 * 这些包的 `main` 直接指向 `./src/index.ts`，不预先构建产物——Next 靠 transpilePackages 编译它们。
 * 注意：厂商 SDK 是**运行时依赖**——它们要定位自身的 CLI / 原生二进制 / 包内资产（pi 的 WASM 与
 * 包目录推导就在其中），被打进 server bundle 后定位会失效；故在 serverExternalPackages 里逐个外置。
 * 名单与 `packages/server/agents` 的依赖同步，缺一处即「编得过、跑不起来」：判据是
 * `src/runtime-deps.test.ts`（名单从那份依赖派生，不在这里手写第二份）。
 */
import type { NextConfig } from 'next';

/**
 * dev server 的额外来源。
 *
 * Next 只放行「启动时的 hostname」（默认 `localhost`）访问 `/_next` 的 dev 资源。同事用
 * `http://127.0.0.1:3083` 或内网 IP 打开时，HMR 握手被拒（ERR_INVALID_HTTP_RESPONSE），
 * 客户端停在**未水合**的 SSR 空壳：列表空着、骨架常驻、页签点不动，而界面上一点提示都没有。
 * 额外来源从 `AIEVAL_DEV_ORIGINS`（逗号分隔）读，默认只补回环地址；部署在别人的机器上时
 * 设一次这个变量即可（见 `docs/faq/` 的环境条目）。
 */
const devOrigins = (process.env.AIEVAL_DEV_ORIGINS ?? '127.0.0.1')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins,
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
