/**
 * 纯函数测试的共享配置：node 环境、不加载 DOM。各包 vitest.config.ts 直接复用它。
 *
 * `pool: 'threads'`：vitest 4 的默认池是 `forks`（每次起子进程），而本机的进程创建极贵——
 * 实测 `git --version` 350ms、`cmd /c exit 0` 250ms、`node -e ""` 400ms（企业杀软在进程
 * 创建上收税，与跑什么程序无关）。`threads` 用 worker_threads，免掉这层进程创建。
 * 实测 `@aieval/contracts`（11 个纯函数测试文件）：forks 3.4–4.1s → threads 2.25s。
 *
 * 为什么这里可以换、而本仓别处不敢换：本仓测试**不用** `process.chdir()`（worker 线程里
 * 不可用）、不用 `process.exit()`、不引原生模块——这三样正是 vitest 把默认池从 threads
 * 改回 forks 的原因（见 vitest 3 的迁移说明）。已核对全部 103 个测试文件与全部源码。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    pool: 'threads',
    /**
     * 默认的 5s 太紧：本机的计价单位是**进程创建**（实测 `git --version` 566ms、`node --version` 530ms，
     * 企业 DLP/EDR 在每个新进程上挂钩），而本仓大量用例要真跑 git 子进程。全量并发下的实测后果是
     * **假红**：同一条用例独占跑 2s，满载时越过 5s 就报 `Test timed out in 5000ms`，
     * 而它要测的断言根本没被走到（2026-09-28 一次全量里 20 条红里绝大多数是这一类）。
     * 2026-09-28 取 **40s**：并发把单条用例放大 5–13 倍（`git.repo.test.ts` 一条独占 3.1s 的用例
     * 满载越过 40s），故按最坏倍数留余量。真正的死循环仍会被挡住（口径与 core 40s / api 60s 一致）。
     */
    testTimeout: 40_000,
    /**
     * `hookTimeout` 默认 **10s**，而本仓的共享 harness 在 `beforeAll` 里建**夹具模板**
     * （真仓库 `init` + `add` + `commit` + `rev-parse`，远端那套还要 `clone --bare`）。
     * 独占时只要 1–2s，但满载（15 worker 抢同一条进程创建管道）时实测越过 10s——
     * 后果不是某条用例红，而是**整个文件在 suite 级失败**：
     * `Error: Hook timed out in 10000ms` + 该文件所有用例被标 skipped
     * （2026-09-28 实测一次全量里 9 个文件、92 条用例这样整块掉队）。
     * 提到 60s：与 `testTimeout` 同一口径——真正的死循环仍会被挡住。
     */
    hookTimeout: 60_000,
  },
});
