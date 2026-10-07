# 用例详情「考题提示词」改用 react-markdown 渲染

- 任务：按用户点选的页面元素（`/cases?panel=detail` 右栏「考题提示词」卡片，`div.ant-typography` + `white-space: pre-wrap`）把提示词从纯文本改为 markdown 渲染
- 分支 / 基线提交：`feat/features` @ `2fc3228`
- 日期：2026-09-29
- 运行环境：Next 16.2.7（dev，**已由用户启动**，端口 3083，进程 80688）+ React 19.2.7 + antd 6.6.5；浏览器 = Playwright MCP 驱动的 Chrome
- 地址：**http://localhost:3083/cases?panel=detail&id=229bef96-89d0-409e-a09a-c786180fa70e**（用户点选该元素时所在的用例）
- 截图目录：`D:\zhanglei1120\Github\deepseek-harness\`（Playwright MCP 的输出目录，本仓外）

## 1. 变更（bounded，无 spec/plan 文档）

| 文件 | 改动 |
|---|---|
| `packages/client/ui/package.json` | 新增 `react-markdown@10.1.0` + `remark-gfm@4.0.1`（均为 ESM，peer `react>=18`） |
| `packages/client/ui/src/base/markdown-text.tsx` | 新增 `MarkdownText`：外层 `<Typography>` 建立 `.ant-typography` 上下文，只映射 h1（Title 4 级）/ h2–h6（Title 5 级）/ p / a（`target=_blank` + `rel=noreferrer`）/ pre（`white-space: pre` + 横向滚动）；`code / strong / del / ul / ol / blockquote / table` 全部交给 antd 排版样式 |
| `packages/client/ui/src/composite/case-detail-panel.tsx` | 「考题提示词」卡片**只换孩子**（`Typography.Paragraph` → `MarkdownText`）；卡片的 `size` / `title` / 边框、右栏 `Flex` 布局、卡片标题栏与编辑/删除按钮一律不动。「评分提示词」卡片**保持 `pre-wrap` 纯文本** |
| `packages/client/ui/src/index.ts` | 转出 `MarkdownText` |

为什么带 `remark-gfm`：该用例的考题提示词 8855 字符里有 **23 行 GFM 表格**（实测 `GET /api/cases/229bef96…`），不带插件这些行会退化成一堆竖线文本。
为什么不带 `rehype-raw`：提示词是外部输入（模型 / 外部系统产生），默认转义成文本即可看见内容，又不引入 XSS 面。

## 2. 测试与变异验证

`pnpm vitest run packages/client/ui` → **35 文件 / 405 用例全绿**；`pnpm vitest run apps/web-next` → 19 文件 / 174 用例全绿；`pnpm typecheck` → 0；`pnpm lint` → 0。

新增/更新守卫 9 条，逐条按 AGENT.md 做**变异验证**（人为把缺陷造回去 → 确认变红 → 还原 → 核对 SHA256 与基线逐字节一致）：

| 变异 | 造回的缺陷 | 变红的守卫 |
|---|---|---|
| M1 | `h1` 不映射成 Title（退化成文本） | 标题按层级映射到 antd Title |
| M2 | 去掉 `remarkPlugins={[remarkGfm]}` | GFM 表格渲染成 table / columnheader / cell |
| M3 | `pre` 改成 `div` | 围栏代码块保留原文的换行与前导空格 |
| M4 | 链接去掉 `target` / `rel` | 链接以新标签打开，并带 noreferrer |
| M5 | 加 `skipHtml`（HTML 被悄悄吞掉） | 原始 HTML 只当文本，不生成 img / script 元素 |
| M8 | `strong` 被剥掉 | 粗体成 strong、行内代码成 code 元素 |
| M9 | 段落渲染成空 | 纯文本原样显示 |
| M6 | 面板退回 `pre-wrap` 纯文本 | 考题提示词卡片：markdown 被渲染，且内容仍在这张卡内 |
| M7 | 评分提示词也改成 `MarkdownText` | 评分提示词卡片：markdown 语法原样显示 |

还原后哈希：`markdown-text.tsx` = `17EE6C18…BD6E`、`case-detail-panel.tsx` = `669CB282…C53C`（与变异前一致）。
TDD 口径：`MarkdownText` 的 7 条断言先跑出 `Failed to resolve import "./markdown-text"`（缺实现，非笔误），面板的 markdown 守卫先跑出「找不到 4 级标题」，实现后才转绿。

## 3. 冒烟四要素

### ① 范围清单

| 项 | 结果 |
|---|---|
| 考题提示词卡片渲染出 markdown 标题（真实提示词的 14 行标题 → 1 个 `h4` + 13 个 `h5`） | ✅ |
| 4 张 GFM 表格渲染成真表格（表头底色、单元格分隔线、行内 code 芯片） | ✅ |
| 6 个围栏代码块：等宽字体 + 底纹 + `white-space: pre` + `overflow-x: auto`，链路图前导空格未丢 | ✅ |
| 110 处行内 code 渲染成 `<code>` 芯片 | ✅ |
| **卡片本身未被替换**：标题栏「考题提示词」在、边框在（`0.666667px solid`）、卡片宽 689px | ✅ |
| 评分提示词卡片仍是纯文本（`white-space: pre-wrap`，卡内无 `h1–h5 / table / pre`） | ✅ |
| 段落里无 markdown 语法残留（`**` / ``` ``` ``` 只出现在 `language-java` 围栏代码块的 Javadoc 字面量里） | ✅ |
| 控制台无 error / warning（4 条 info） | ✅ |
| 暗色主题 | 跳过（见 ④） |

### ② 操作路径

1. Playwright 打开 `http://localhost:3083/cases?panel=detail&id=229bef96-89d0-409e-a09a-c786180fa70e`（用户点选元素时所在页面，dev server 由用户启动，未重启、未改动设置）
2. `browser_evaluate` 按卡片标题定位「考题提示词」卡片，读取 `getBoundingClientRect()` 与 `getComputedStyle`
3. 滚动右栏到卡片顶部 → 截图 `case-markdown-card.png`
4. 分别对第一张表格与链路图代码块做元素截图：`markdown-table.png`、`markdown-pre.png`
5. `browser_console_messages` 读控制台
6. 遍历卡片内文本节点，核对 `**` / ``` ``` ``` 的落点（确认只在代码块字面量里）

### ③ 证据（几何 + 计算样式，非截图目测）

```text
考题提示词卡片：headTitle=「考题提示词」，border=0.666667px solid，rect 689×4038
card-body：687×4009；headingCount=14（H4:使用 TDD 向接口 /api/open…，H5:背景、需求、影响范围…）
table：4 张，首张 639×171，td border-bottom=0.666667px，th background=rgba(0,0,0,0.02)（token.colorFillAlter）
pre：6 个，white-space=pre，overflow-x=auto，font-family=SFMono-Regular, Consolas, …（token.fontFamilyCode），
     background=rgba(150,150,150,0.1)，border-radius=3px（均来自 antd 排版重置样式）
h4：font-size=16px（antd Title 4 级 + 紧凑密度），font-weight=600
评分提示词卡片：white-space=pre-wrap，卡内 h1–h5/table/pre 计数 = 0
控制台：Total 4（Errors: 0, Warnings: 0）
```

截图：`case-markdown-card.png`（卡片顶部：标题层级 + 代码块 + 列表）、`markdown-table.png`（字段语义表）、`markdown-pre.png`（ASCII 链路图）。

### ④ 未覆盖项与后续

- **暗色主题未真机切换**：主题偏好落在应用配置里（`useResolvedTheme` 由设置页的 `themePreference` 驱动），切换会改写用户真实配置，故未动。机制上的依据是：新组件里 **没有任何写死的颜色 / 字号 / 内边距**（grep `#hex|rgba(|fontSize|padding|margin|color:` → 0 命中），样式全部来自 antd 排版的 token / CSS 变量，随 `darkAlgorithm` 自动生效。需要像素级结论时再按真实路径切一次主题。
- **链接**（`target=_blank` / `rel`）只由 jsdom 单测钉住：该用例提示词里的 0 个外链（`linkCount=0`），真机上没有可点的样本。
- **窄栏横向滚动**：当前右栏宽 689px，最宽代码块 `scrollWidth == clientWidth`（无需滚动）；未在 320px 窄栏下实测滚动条出现。
- dev server 未重启（Next dev 增量编译已吃到新依赖与源码）；生产构建 `pnpm build` 未跑。

## 4. 并发工作区注记

`packages/client/ui/package.json` 与 `pnpm-lock.yaml` 在本次改动**之前**已被另一个会话改脏（diff 抽屉改造：`react-diff-viewer-continued@4.4.0`，见 `git status` 里的 `README.md` / `docs/superpowers/specs/2026-09-29-diff-drawer-redesign-design.md` / `eval-row-card.*` / `orchestrator.ts`）。本次**未提交任何文件**：`git add` 这两个共享文件会把别人在途的依赖一起卷进提交。本次新增的 md 依赖已写入这两个文件的工作区状态，等对方落地后一起提交，或由用户决定提交时机。
