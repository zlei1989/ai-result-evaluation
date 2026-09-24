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
    resolve: { alias: { '@/': `${packageRoot}/` } },
  }),
);
