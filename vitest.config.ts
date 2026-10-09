/**
 * 仓库根 Vitest 配置：`pnpm test` 靠它用**一个**进程跑完全部 8 个包的测试。
 * 逐包跑（`pnpm -r test`）时每个包都要重新起 Node + 加载 Vite/vitest，实测 22.6s 里
 * 约 20s 是启动税——各包测试自身的 Duration 只有 600ms 上下。
 *
 * 各包自己的 `vitest.config.ts` 仍是**唯一真源**（environment、include、`@/*` 别名都在那边），
 * 根配置只负责「一次启动、把 8 个包都收集进来」，故这里按**路径**引用而不是内联配置对象：
 * 同一个包的测试范围写两遍必然漂移。`pnpm --filter @aieval/<包> test` 走的仍是包内那份配置。
 *
 * 收集形态是**双形态**：包目录用 glob（`packages/{server,client}/*` 与 `apps/*`——新增包
 * 只要自带 vitest.config.ts 就自动被收集，不会出现「新包没进根测试」的静默漏测）；
 * docs 不是 workspace 包、glob 罩不到，故显式列一条路径（知识库守卫工程）。
 * 两边改动收集方式后，都必须核对全仓用例总数（漏收一整个工程是静默漏测）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/server/*/vitest.config.ts',
      'packages/client/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      // docs 是知识库的内容守卫工程（读磁盘断言，node 环境）——2026-10-09 票 02 并入。
      // 显式列出而非 glob：docs/ 不是 workspace 包，glob `*/vitest.config.ts` 会把无关目录也扫进来
      'docs/vitest.config.ts',
    ],
    /**
     * 并发档位：**不设上限**（vitest 默认 `availableParallelism() - 1`），理由是一条会随代码演化的实测。
     *
     * 2026-09-28 上午：本机（i7-1260P，4 性能核 + 8 能效核）的计价单位是**进程创建**
     * （`git --version` 566ms、`node --version` 530ms，企业 DLP/EDR 在每个新进程上挂钩），
     * 而当时全量里有两个 250–370s 的巨型文件（`cases.test.ts` / `mirror.test.ts`）在跑，
     * 15 路 worker 一起 spawn 会把单条用例放大 5–13 倍 ⇒ 假红一片。当时取 `maxWorkers: 8`：
     * 同一棵树实测 默认并发 307.0s / 20 红，8 路 343.5s / 8 红（拿 +12% 墙钟换 −60% 假红）。
     *
     * 2026-09-28 夜：长杆文件全部拆成 ≤80s 的小文件（`scripts/split-test-file.mjs` /
     * `slice-describe.mjs`），那个「巨型文件 + 高并发」的组合不复存在。同一份代码重测
     * core + evaluator（46 文件 / 409 用例）：
     *     6 路 156.7s / 8 路 150.5s / 12 路 129.9s / **15 路 125.4s**（四档全部 0 失败）
     * ⇒ 上限从 8 拿掉，回到默认。**若日后又出现巨型文件且伴随 `Test timed out` 假红，
     * 先拆文件，再把 `--maxWorkers` 调低当临时手段**（命令行覆盖永远赢过这里）。
     */
  },
});
