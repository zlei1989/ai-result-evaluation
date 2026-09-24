/** 纯函数测试的共享配置：node 环境、不加载 DOM。各包 vitest.config.ts 直接复用它。 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
