import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.node';

// `@/*` 指**本包根目录**（`apps/web-next/tsconfig.json` 的 `"@/*": ["./*"]`，无 baseUrl）。
// vitest 不读 tsconfig 的 paths，必须显式给一份 resolve.alias，否则 app/api/**/route.ts
// 在测试里解析不到 `@/src/server-context`（收集阶段就失败，路由层等于没有守卫）。
// 用配置文件自身的位置推导而不是 process.cwd()：否则以 `--root` 从别的目录调用时
// 别名会指向调用目录，症状是「找不到模块」而非「CWD 不对」，极难排查。
// 用 mergeConfig 保留共享配置的 environment / include，避免两处各写一遍。
const packageRoot = import.meta.dirname;

export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: {
        '@/': `${packageRoot}/`,
        // `@aieval/evaluator` **不在本应用的依赖里**（`AGENTS.md` 的方向表：web-next 只到
        // api / core / ui / client / contracts），于是它的裸说明符从 apps/web-next 解析不到任何文件。
        // 后果不是「报错」而是**静默失效**（实测，Task 10）：路由测试里的
        // `vi.mock('@aieval/evaluator')` 只能注册在**未解析的裸说明符**上，而 api 包内部那次
        // import 解析到真实源文件——两个 module id 不相等 ⇒ mock 一条都不生效，
        // 测试侧拿到 `vi.fn()` 的同时、api 侧仍在跑真实编排层（日志里出现 `[evaluator] 评测开始`，
        // 也就是真的会去 spawn agent 子进程）。
        // 这里只在**测试配置**里把说明符指向真实源文件，让两侧解析到同一个 id；它不建依赖边
        // （package.json 不动）、也不进运行时（`next build` / `next dev` 完全不读本文件）。
        '@aieval/evaluator': `${packageRoot}/../../packages/server/evaluator/src/index.ts`,
      },
    },
  }),
);
