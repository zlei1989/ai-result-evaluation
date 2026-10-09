# 15: 功能说明：设置与数据存储

**What to build:** 两篇知识文章：《设置》覆盖供应商管理、评分配置、工作区、界面主题；《数据与存储》覆盖存储位置、事件日志文件、评分口径、配置原子写与 BOM 容错。

**Blocked by:** 02（《Codex 接入》打通全链）、06（《功能总览》目录层）.

**Status:** resolved

- [ ] 两篇文章六节骨架齐全，标题合规
- [ ] 《设置》覆盖：模型供应商的协议与能力表、评分配置、工作区、主题三处同步
- [ ] 《数据与存储》覆盖：配置目录优先级、events.jsonl 唯一真相源、原子写（临时文件 + rename、EPERM 两成因）、BOM 容错与损坏报错口径
- [ ] 《功能总览》对应条目补链；守卫全绿，`pnpm docs:build` 退出 0

**取材档案（仅票内参考，不进文章正文）：** `docs/superpowers/specs/2026-09-22-features-design.md` §6/§7.1/§7.2、`docs/superpowers/notes/2026-09-30-provider-models-modal-smoke.md`、`docs/superpowers/notes/2026-10-08-provider-table-sticky-columns-smoke.md`、`docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`；活文档 AGENTS.md 的「持久化」「命令」节可互链。

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
