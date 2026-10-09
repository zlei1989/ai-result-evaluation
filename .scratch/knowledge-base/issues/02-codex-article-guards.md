# 02: 《Codex 接入》打通全链（示范票）

**What to build:** 第一篇知识文章《Codex 接入》落地，同时把内容守卫缝整条打通：知识文章的六节骨架、自含纪律、标题规范由真实文章验证；docs 守卫测试进根测试聚合；五项内容守卫（自含 / 骨架 / 标题 / llms.txt 同步 / 单一真源）与 llms.txt 构建期生成器全部随本票交付，每个守卫带变异验证记录。此后所有内容票走本票铺好的轨道。

**Blocked by:** 01（站点骨架与构建缝）.

**Status:** resolved

- [ ] 《Codex 接入》成文：六节骨架齐全（定位 / 形态与交互→协议域为 wire 形态与事件 / 数据与契约 / 状态机或时序 / 已知边界与取舍 / 相关链接），标题合规（无编号前缀、≤10 字、不用内部代号）
- [ ] 正文自含：不出现任何指向冻结档案的链接；从文章可倒推原档案的现时结论（app-server 协议、`wire_api: 'responses'` 约束、结构化输出、reasoning 缺失处置、thread 树与用量口径）
- [ ] docs 自带 vitest 配置并入根测试聚合；改收集方式后核对全仓用例总数（漏收一个 project 是静默漏测）
- [ ] 五项守卫落地且全部做过变异验证（制造要拦的缺陷 → 守卫红 → 还原 → 核对文件哈希）：自含、骨架、标题、llms.txt 同步、单一真源
- [ ] llms.txt 构建期生成，清单与已发布页面集合一致
- [ ] `pnpm docs:build` 退出 0；`pnpm lint` / `pnpm typecheck` 保持绿

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/plans/2026-10-05-codex-appserver-refactor.md`、`docs/superpowers/specs/2026-10-07-codex-dsh-parity.md`、`docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`（codex 相关节）、`docs/superpowers/notes/2026-10-01-codex-sdk-mcp-facts.md`、`docs/superpowers/notes/2026-10-07-codex-structured-output-live.md`、`docs/superpowers/notes/2026-09-30-agent-builtin-tools-inventory.md`（codex 部分）；活文档 `docs/codex-faq.md` 与 `packages/server/agents/README.md` 正文可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
