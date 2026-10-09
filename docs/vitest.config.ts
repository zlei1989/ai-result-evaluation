/**
 * docs 测试配置：知识库内容守卫（`.vitepress/guards/`）的唯一真源。
 *
 * 与各包配置并列、被根 `vitest.config.ts` 的 projects 收集（根配置注释里的规矩：
 * 新目录自带 vitest.config.ts 即自动并入，改收集方式后必须核对全仓用例总数）。
 * 守卫全部是 node 环境的「读磁盘断言」，不起服务、不加载产品代码。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // 守卫文件放在 .vitepress/ 下：与站点配置同层，且被 srcExclude 一并排除出页面构建
    include: ['.vitepress/guards/**/*.test.ts'],
  },
});
