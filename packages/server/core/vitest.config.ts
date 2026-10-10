import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../../vitest.node';

// 默认的 5s 单用例超时对「真跑 git 子进程」的用例太紧：一个用例里 collectDiff 调两次
// 就是 12 次 git 进程，本机实测 4.0–4.7s；全包并行（`git-repo-*.test.ts` 与 `git-diff-*.test.ts`
// 同时跑）时会翻过 5s，表现为 `Error: Test timed out in 5000ms` 的假红——红绿由机器负载决定。
// 放宽到 20s：真正的死循环仍会被挡住，机器慢一点不再变成失败。
// 放宽到 40s 之后又提到 **60s**：并发（哪怕已把 `maxWorkers` 压到 8）
// 仍会把单条用例放大 5–13 倍——`mirror-fetch.test.ts` 的 `fetchMirror` 用例独占 6.6s，
// 在 8 路并发下越过 40s。判据仍是「有没有上限」，不是「上限多短」。
// 用 mergeConfig 保留共享配置的 environment/include，不 fork 一份出来。
export default mergeConfig(base, defineConfig({ test: { testTimeout: 60_000 } }));
