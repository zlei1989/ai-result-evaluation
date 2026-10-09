# 19: 规约守卫：密钥环境与测试策略

**What to build:** 两篇知识文章：《密钥与环境变量》讲清网关 key 只从环境变量读的硬规则、测试环境 ≠ 运行环境的假绿防控；《测试策略与提速》讲清进程创建预算、内循环跑法、负载下假红的识别与处置。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《密钥与环境变量》自含：key 从环境变量读的判据、硬编码 key 需轮换的既有事实口径、测试与运行环境差异点名法
- [ ] 《测试策略与提速》自含：进程创建计价、夹具 beforeAll 模板、长文件按 describe 拆、负载假红的阈值判据、vi.mock 逐文件重复的静默坑
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** 活文档 AGENTS.md 的「测试」「日志」「删除与 PowerShell 安全」（key 相关段）节；`docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md` 的实测段（进程创建计价与负载阈值口径）、`docs/superpowers/notes/2026-09-22-features-smoke.md` 的 F4/B 类条目。提速的历史基线数字以 deadlock 探测记录里的转述为准（其引用的 test-speedup 计划文件已不在树中，勿寻）。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
