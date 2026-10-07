import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../../vitest.node';

// 默认的 5s 单用例超时对「真跑 git 子进程」的用例太紧（口径同 core 包的 vitest.config.ts）：
// cases.test.ts 的「候选不是白名单」用例要造 25 次提交（每次 add + commit + rev-parse 共 3 个进程，
// 合计 75 次 git 进程），本机实测这 75 次进程就要 18.3s，加上 createCase / listCommitCandidates
// 自身的若干次 git 调用，整条用例约 20.5s——恰好压在 core 那份 20s 的边界上。
// 故这里放宽到 60s：真正的死循环仍会被挡住（用例本身只跑一次 git 夹具），
// 而「机器慢一点 / 杀软扫描 git.exe」不再变成 `Error: Test timed out in 5000ms` 的假红。
// 用 mergeConfig 保留共享配置的 environment/include，不 fork 一份出来。
export default mergeConfig(base, defineConfig({ test: { testTimeout: 60_000 } }));
