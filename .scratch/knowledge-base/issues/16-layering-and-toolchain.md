# 16: 架构设计：分层依赖与工具链

**What to build:** 两篇知识文章：《仓库分层与依赖方向》讲清分包结构、依赖方向表（真源在 AGENTS.md）与边界守卫机制（清单与表双向比对）；《工具链与命令聚合》讲清三条聚合命令为何一个进程、为什么不走 `pnpm -r`。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《仓库分层与依赖方向》自含：8 包职责、依赖方向与例外口径（类型转出不算边、测试期别名）、边界守卫双向比对与变异验证口径
- [ ] 《工具链与命令聚合》自含：根 eslint 前缀化、根 vitest projects、tsconfig 并集三件套，单进程聚合的实测理由
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-09-22-scaffold-design.md` §4/§5、`docs/superpowers/notes/2026-10-03` 前后的依赖表守卫注释（`apps/web-next/src/package-dependency-boundaries.test.ts` 文件头注释）；活文档 AGENTS.md 的「依赖方向」「命令」节是真源，正文互链不复制。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
