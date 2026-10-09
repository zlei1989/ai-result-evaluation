# 13: 功能说明：行执行与日志

**What to build:** 《行执行与日志》一篇：每候选行状态机、一轮评测的内部时序、执行日志抽屉（观测面）、实时状态、单行执行、用量与轮次展示——行执行的完整观测口径一页读全。

**Blocked by:** 02（《Codex 接入》打通全链）、06（《功能总览》目录层）.

**Status:** resolved

- [ ] 六节骨架齐全，标题合规
- [ ] 覆盖：行状态机（含清理失败与重跑的流转）、内部时序与收集死锁的现时结论、执行日志抽屉（虚拟列表自持滚动）、实时状态改造口径、单行执行、逐消息用量与轮次 Tooltip
- [ ] 《功能总览》对应条目补链；守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-09-22-features-design.md` §5.4/§5.5/§7.4/§7.5、`docs/superpowers/specs/2026-09-30-exec-log-drawer-redesign-design.md`（3592 行主源）、`docs/superpowers/notes/2026-10-02-exec-log-spec-structure-findings.md`、`docs/superpowers/notes/2026-10-02-exec-log-spec-content-baseline.md`、`docs/superpowers/notes/2026-10-02-exec-log-visual-measurements.md`、`docs/superpowers/notes/2026-10-02-exec-log-drawer-redesign-smoke.md`、`docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`、`docs/superpowers/notes/2026-09-29-single-row-execution-smoke.md`、`docs/superpowers/notes/2026-10-08-run-events-realtime-smoke.md`、`docs/superpowers/notes/2026-10-06-dsh-per-message-usage-smoke.md`、`docs/superpowers/notes/2026-10-05-subagent-turns-tooltip-smoke.md`。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
