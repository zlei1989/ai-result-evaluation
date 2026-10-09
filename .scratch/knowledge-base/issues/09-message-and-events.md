# 09: 协议规范：消息规范与事件流

**What to build:** 两篇知识文章：《消息规范》给出消息事件的现行 v3 口径与真机验证结论（哪条字段是权威定义、四句缺失原因的分工）；《事件流》讲清行级事件流与 SSE 双流的分工、`events.jsonl` 作为执行唯一真相源的口径。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《消息规范》自含：现行口径的字段与事件形状、已验证/未验证边界、版本演进只留结论不抄过程
- [ ] 《事件流》自含：行级事件流与消息 SSE 两条独立流的分工、事件类型清单、追加写与读侧口径
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`（主源）、`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v2.md`（演进结论）、`docs/superpowers/notes/2026-09-30-agent-message-spec-verification.md`、`docs/superpowers/notes/2026-10-01-agent-message-spec-unverified-closure.md`、`docs/superpowers/specs/2026-09-22-features-design.md` §5.3/§7.4、`docs/superpowers/notes/2026-10-08-run-events-realtime-smoke.md`、`docs/superpowers/notes/2026-10-07-activity-vocabulary-smoke.md`。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
