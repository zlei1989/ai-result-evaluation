/**
 * 组件测试的共享配置：jsdom 环境 + setup（注册 jest-dom 断言、每个用例后清理 DOM）。
 * 注意：**不注入 matchMedia 桩**——jsdom 本身没有 `matchMedia`，而这正是主题模块
 * 「无 matchMedia 时按暗色」兜底路径要被覆盖的前提；需要模拟系统偏好的用例自己注入桩，
 * 见 `packages/client/ui/src/base/app-theme.test.tsx` 里那个用 `vi.fn()` 记调用的实现。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/testing/setup.ts'],
  },
});
