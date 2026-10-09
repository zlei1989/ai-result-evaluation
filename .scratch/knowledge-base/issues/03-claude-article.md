# 03: 《Claude Code 接入》

**What to build:** 第二篇厂商知识文章：Claude Code 的接入技术细节一页读全——skills 注入、MCP 接法、子会话用量、思考块，走 02 铺好的守卫轨道。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 《Claude Code 接入》六节骨架齐全，标题合规
- [ ] 正文自含，覆盖：skills 注入口径、MCP server 接法、子会话逐轮用量、思考块口径、与 run 入口的对接形状
- [ ] 守卫全绿（自含 / 骨架 / 标题 / llms.txt 同步 / 单一真源），`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/notes/2026-09-30-claude-agent-sdk-skills.md`、`docs/superpowers/notes/2026-10-01-claude-agent-sdk-mcp-facts.md`、`docs/superpowers/notes/2026-10-05-claude-subagent-own-usage-smoke.md`、`docs/superpowers/notes/2026-09-30-sdk-skill-injection-three-sdks.md`（claude 部分）、`docs/superpowers/notes/2026-10-01-mcp-in-three-sdks.md`（claude 部分）、`docs/superpowers/notes/2026-09-30-agent-builtin-tools-inventory.md`（claude 部分）；活文档 `docs/claude-code-faq.md` 正文可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
