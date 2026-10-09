# Playwright MCP

用 MCP 浏览器工具前先读本文件。规则是硬约束，不是建议。

## 图片路径：必须闭环验证

**工具回显「成功」不等于文件写到了你以为的位置。** 保存图片一律走这三步，缺一不可：

1. **传完整绝对路径**：`filename` 的值必须是绝对路径（相对路径不按会话工作目录解析，见下）。
2. **立刻用同一个绝对路径读回**：`read_image` 传**逐字相同**的路径。
3. **读回失败就当作图片不存在**：不要拿它支撑任何结论，先定位文件实际落在哪里。

未读回之前，不得在回复里引用该图片、不得基于它下判断（写了「已截图」却读不回，等于没截）。

写死这个写法，两个路径必须逐字相同：

```text
截图：browser_take_screenshot  filename: "<允许根>\.playwright-mcp\<名字>.png"
读回：read_image               file_path: "<允许根>\.playwright-mcp\<名字>.png"
```

- **相对路径的解析基准是 MCP 服务进程的 cwd，不是会话工作目录**：传 `"./x.png"` 会回显成功却落在别处，于是按工作目录拼出的路径必然 `not found`。
- **允许根只有两个，且不在会话工作目录内**。传根外的绝对路径会被明确拒绝，**报错原文里就列着当时的两个允许根**——照抄它，不要凭记忆或旧笔记填（允许根随 profile 变）。
- 截图默认落点是允许根里的 `.playwright-mcp` 目录，优先用它。
- 同一规则适用于所有带 `filename` 的浏览器工具：`browser_take_screenshot`、`browser_snapshot`、`browser_console_messages`、`browser_network_requests`、`browser_evaluate`、`browser_find`。

## 不许删除不认识的产物

误落到别处（仓库根、会话工作目录）的文件**不要自行删除**：列出来交给用户。删文件前先读 `docs/powershell.md`「文件删除安全」。

## 几何断言别靠眼睛

判断「宽度变了」「布局塌了」时读 `getBoundingClientRect()`（用 `read_picked_element` 或 `browser_evaluate`），不要凭截图判断——2px 的差异在截图里看不出来，但会决定用例红不红。

## 与冒烟测试的衔接

冒烟用真实服务 + 真实用户路径操作，并用 CLI 复核落盘事实（配置文件内容、git 分支与 diff），页面展示与磁盘事实互证。每次冒烟后在对应关账记录的「冒烟」小节写四要素：范围清单（逐项 ✅/❌/跳过+理由）、操作路径、证据（浏览器状态 + CLI 输出）、未覆盖项与后续计划。
