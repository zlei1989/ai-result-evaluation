# 17: 架构设计：契约体系与界面原语

**What to build:** 两篇知识文章：《契约体系》讲清 zod schema 的组织、两份契约投影同批替换的规则、错误码与领域类型；《界面原语与主题》讲清界面原语的实现契约、antd 主题三处同步、紧凑密度与已知坑表。

**Blocked by:** 02（《Codex 接入》打通全链）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《契约体系》自含：schema 分层、投影同批替换口径、类型期 vs 运行期依赖边的区分
- [ ] 《界面原语与主题》自含：界面原语清单与实现契约、主题三处同步、compactAlgorithm 字号反推坑、Splitter/Flex/Button 已知坑
- [ ] 守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-09-22-features-design.md` §7.2、`docs/superpowers/specs/2026-09-22-scaffold-design.md` §6（界面原语章）、`docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`；活文档 AGENTS.md 的「边界与工具链的已知坑」表可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
