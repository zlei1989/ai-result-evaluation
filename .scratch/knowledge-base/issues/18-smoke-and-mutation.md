# 18: 规约守卫：冒烟方法论与变异验证

**What to build:** 两篇知识文章：《冒烟测试方法论》讲清四要素（范围清单 / 操作路径 / 证据页面与 CLI 互证 / 未覆盖项与后续计划）与几何断言不靠眼睛的口径；《变异验证》讲清「没见过失败的守卫不算守卫」的操作步骤与判据。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《冒烟测试方法论》自含：四要素定义、页面与磁盘互证、几何断言读 getBoundingClientRect 的口径、真机红/绿判据
- [ ] 《变异验证》自含：制造缺陷 → 守卫红 → 还原 → 哈希核对的完整步骤、判据表达法
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** 活文档 AGENTS.md 的「冒烟测试」节、`docs/playwright-mcp.md`（活文档，可互链）；四要素的实际形状参照 `docs/superpowers/notes/` 下任意两份近期 smoke 记录的结构（如 `2026-10-08-rubric-adjust-live-smoke.md`）。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
