# 04: 《DSH 接入》

**What to build:** 第三篇厂商知识文章：DSH 的接入技术细节一页读全——pi-ai 双协议路由、逐消息用量、会话过滤、skill 注入，走 02 铺好的守卫轨道。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 《DSH 接入》六节骨架齐全，标题合规
- [ ] 正文自含，覆盖：pi-ai 路由与两条 wire（`openai → openai-responses`、`anthropic → anthropic-messages`）、`protocolTypes` 集合判定、逐消息用量口径、会话过滤、skill 注入
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/plans/2026-09-30-dsh-dual-protocol.md`、`docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`、`docs/superpowers/notes/2026-10-06-dsh-per-message-usage-smoke.md`、`docs/superpowers/notes/2026-09-30-sdk-skill-injection-three-sdks.md`（dsh 部分）、`docs/superpowers/notes/2026-10-01-mcp-in-three-sdks.md`（dsh 部分）、`docs/superpowers/notes/2026-09-30-agent-builtin-tools-inventory.md`（dsh 部分）；活文档 `docs/deepseek-harness-faq.md` 正文可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
