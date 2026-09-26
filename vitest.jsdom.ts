/**
 * 组件测试的共享配置：jsdom 环境 + setup（注册 jest-dom 断言、每个用例后清理 DOM）。
 * 注意：**不注入 matchMedia 桩**——jsdom 本身没有 `matchMedia`，而这正是主题模块
 * 「无 matchMedia 时按暗色」兜底路径要被覆盖的前提；需要模拟系统偏好的用例自己注入桩，
 * 见 `packages/client/ui/src/base/app-theme.test.tsx` 里那个用 `vi.fn()` 记调用的实现。
 *
 * `pool: 'threads'` 的理由与 `vitest.node.ts` 同源（本机进程创建约 250–400ms，forks 每次
 * 起子进程都在付这笔税；threads 用 worker_threads 免掉它）。jsdom 在 worker 线程里照常可用。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['./src/testing/setup.ts'],
    pool: 'threads',
    /**
     * 理由与 `vitest.node.ts` 同源：全量并发下 5s 会让本来 1–2s 的组件用例变成
     * `Test timed out in 5000ms` 的假红（jsdom 渲染 + antd 组件树在满载时明显变慢）。
     * 2026-09-28 取 **40s**：jdom 这一档的余量最紧——`run-create-panel.test.tsx` 的用例独占 6s，
     * 并发下的放大倍数（实测 5–13 倍）会越过 20s。真正的死循环仍会被挡住。
     */
    testTimeout: 40_000,
    /** 理由与 `vitest.node.ts` 同源：钩子（组件测试里可能是异步准备）在满载时会越过默认的 10s */
    hookTimeout: 60_000,
  },
});
