# 10: 协议规范：进程生命周期与三家横向对比

**What to build:** 两篇知识文章：《进程生命周期》讲清厂商进程 spawn 到整棵回收的口径、清理失败的处置（EPERM 两成因两种处置）；《三家横向对比》以对比表收拢内置工具、MCP 接法、skill 注入、用量与思考口径的厂商差异，互链三篇厂商页。

**Blocked by:** 03（《Claude Code 接入》）、04（《DSH 接入》）——对比页须链接三篇厂商文章（含 02 的 Codex）。

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《进程生命周期》自含：spawn/整棵回收/清理失败三段口径、EPERM 两成因的区分判据、轮次与计量的归属
- [ ] 《三家横向对比》自含：工具清单、MCP、skill 注入、用量、思考/effort 的逐项对比，互链《Codex 接入》《Claude Code 接入》《DSH 接入》
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-10-07-agent-process-lifecycle.md`、`docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`、`docs/superpowers/notes/2026-09-30-agent-builtin-tools-inventory.md`、`docs/superpowers/notes/2026-10-01-mcp-in-three-sdks.md`、`docs/superpowers/notes/2026-09-30-sdk-skill-injection-three-sdks.md`；活文档 `docs/codex-faq.md` 的 EPERM 条目可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
