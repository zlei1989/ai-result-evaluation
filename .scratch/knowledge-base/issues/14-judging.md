# 14: 功能说明：评分

**What to build:** 《评分》一篇：评分器与两条评分通路、rubric 组→项权重体系、结构化输出（outputSchema 全链）、effort 档位、评分详情抽屉、智能调整。

**Blocked by:** 02（《Codex 接入》打通全链）、06（《功能总览》目录层）.

**Status:** resolved

- [ ] 六节骨架齐全，标题合规
- [ ] 覆盖：两条评分通路的分工（智能体评分 / 文本 API 评分）、rubric 权重与旧数据处置、结构化输出三家落点与有痕降级、effort 默认/显式关闭的真机结论、评分详情抽屉、「智能调整」全链路
- [ ] 《功能总览》对应条目补链；守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-09-22-features-design.md` §5.5.1/§5.5.2/§5.6.4/§5.7/§7.3、`docs/superpowers/plans/2026-09-29-rubric-scoring.md`（4148 行主源）、`docs/superpowers/notes/2026-09-28-structured-judge-output-progress.md`、`docs/superpowers/notes/2026-09-29-rubric-scoring-smoke.md`、`docs/superpowers/notes/2026-10-08-rubric-adjust-live-smoke.md`、`docs/superpowers/notes/2026-10-06-effort-default-and-off-smoke.md`、`docs/superpowers/notes/2026-10-06-effort-off-really-disables-thinking-smoke.md`、`docs/superpowers/notes/2026-10-07-agent-run-capability-judge-effort-smoke.md`。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
