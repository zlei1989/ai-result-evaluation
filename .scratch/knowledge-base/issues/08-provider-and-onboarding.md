# 08: 协议规范：Provider 抽象与新增 SDK 接入流程

**What to build:** 两篇知识文章：《Provider 抽象与 run 入口》讲清 `agentProvider.run` 唯一入口、metadata 能力查询、权限档与包边界不变量；《新增 SDK 接入流程》给出七步接入清单与每步判据（conformance kit 正文在此），接新厂商不靠试错。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《Provider 抽象与 run 入口》自含：run 唯一入口的约束（不 spawn 厂商 CLI、不深路径 import、不再包一层门面）、metadata 能力查询、权限档按阶段给
- [ ] 《新增 SDK 接入流程》自含：七步清单、顺序不可颠倒的理由、每步可执行判据、conformance kit 用法
- [ ] 守卫全绿，`pnpm docs:build` 退出 0；与《Codex 接入》互链一致

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/plans/2026-10-07-agents-provider-conformance.md`、`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §1、`docs/superpowers/specs/2026-09-22-features-design.md` §5.1/§5.6；活文档 `packages/server/agents/README.md` 正文可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
