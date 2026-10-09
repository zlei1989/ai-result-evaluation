# 01: 站点骨架与构建缝

**What to build:** 本地可跑的知识库站点：起本地服务即可在浏览器里按五域导航浏览全部编入内容，构建命令退出 0 即验收（死链即构建错误）。三份厂商 FAQ 与 PowerShell、Playwright 五份活文档以原文编入站点（单一真源，不复制），冻结档案排除出构建。docs 工具链文件进 lint / typecheck 检查范围且保持绿。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [ ] 新增 `docs:dev` / `docs:build` 根命令；`docs:dev` 起本地站点，五域导航（协议规范 / 功能说明 / 架构设计 / FAQ / 规约守卫）可见
- [ ] `docs:build` 退出 0：VitePress 配置合法、导航完整、死链即构建错误
- [ ] 三份厂商 FAQ、`powershell.md`、`playwright-mcp.md` 原文编入站点可浏览，仓内无第二份副本
- [ ] 冻结档案（`docs/superpowers/`）排除出构建，不生成页面、不进产物
- [ ] VitePress 依赖落仓库根 devDependencies（不建 workspace 包、不进依赖方向表），`pnpm lint` / `pnpm typecheck` 保持绿
- [ ] 站点口径为本地/内网：不做公网部署配置

## Comments

- 2026-10-09 关账：随集成分支 knowledge-base 落地；验收证据见对应提交信息与守卫套件（docs 工程 84 用例全绿）。
