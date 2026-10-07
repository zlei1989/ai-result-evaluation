# 冒烟记录：行卡片「供应商信息改挂模型名浮层」（2026-10-07）

> 目标页：`http://localhost:3083/runs?panel=detail&id=8df6ff65-6bea-4d8a-94d3-bf5fa1accbd0`
> （用例「简单测试」，仓库 `D:\tmp\proj` @ `1cf3c82`，并行 3 行：Claude Code / Codex / DeepSeek Harness）
> 用户口径（2026-10-07，逐字）：① 鼠标移入模型名 ⇒ tooltip 展示供应商信息，如「供应商：deepseek-openai（https://api.deepseek.com/）」；
> ② 删掉标题行上的供应商 Tag（截图里的 `deepseek-anthropic`）；③ 档位 tooltip 改成「思考强度：max」。
> **只记实测值**；读不出来的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么

| # | 改动 | 判据 | 落点 |
|---|---|---|---|
| 1 | 供应商信息（名字 + 接口地址）**挂在模型名上**，鼠标移入才浮出 | 浮层文案逐字 = `供应商：<providerName>（<baseUrl>）`，且触发元素是模型名那一格 | `packages/client/ui/src/composite/eval-row-card.tsx`（`Tooltip` 包 `Typography.Text code`） |
| 2 | 标题行上的**供应商 `Tag` 删除**（标题行只剩「智能体 · 模型 · 思考强度」） | 卡片标题行的可见文本里再也找不到供应商名 | 同上 |
| 3 | 普通档位的浮层压成一行 `思考强度：<档>` | 逐字 = `思考强度：max` | 同上 |

**刻意不跟着改的一格**：关闭档（`off`）的浮层仍是 spec 钉死的那句「这一行要求关闭思考」
（`docs/superpowers/specs/2026-10-06-effort-default-and-explicit-off-design.md` §4：措辞是**要求**不是结果），
它说的是「我们下发了什么」，照抄「思考强度：off」只会把用户读不懂的词重复一遍。
供应商信息**没有消失**：环境抽屉（`agent-environment-drawer.tsx`）与执行日志的环境文本里照旧各有「供应商 / 接口地址」两格。

## 2. 范围清单

| 项 | 判定 | 关键实测值 / 证据 |
|---|---|---|
| 模型名浮层给出供应商信息 | ✅ | 真实鼠标悬浮 `.ant-card-head-title code`（第 1 张卡）⇒ 可见浮层文本 = `供应商：deepseek-anthropic（https://api.deepseek.com/anthropic）` |
| 标题行不再有供应商 Tag | ✅ | 三张卡的标题行文本 = `第 1 名 / Claude Code / · / deepseek-flash / max`、`第 2 名 / DeepSeek Harness / · / deepseek-flash / max`、`Codex / · / deepseek-flash / max`；`document.body.innerText.includes('deepseek-anthropic') === false` |
| 档位浮层 = 「思考强度：max」 | ✅ | 真实鼠标悬浮 `.ant-card-head-title .ant-tag-purple` ⇒ 可见浮层文本 = `思考强度：max` |
| 供应商**不是**写死的（来自行数据快照） | ✅ | 磁盘 `run.json`：Claude Code 行 `providerName=deepseek-anthropic` / `baseUrl=https://api.deepseek.com/anthropic`；**Codex 行是另一家** `deepseek-openai` / `https://api.deepseek.com/`（正是用户举例的那一对）⇒ 同一张卡片上换一行就换文案 |
| 用户举例的那一对**逐字命中** | ✅ | 三张卡各悬浮一次：`供应商：deepseek-anthropic（https://api.deepseek.com/anthropic）`、同上、`供应商：deepseek-openai（https://api.deepseek.com/）` |
| 版面没被撑坏 / 没多套一层元素 | ✅ | 标题行仍是 `Flex` 的直接子元素（`Tooltip` 只克隆子节点、不插 wrapper）；三张卡逐一读几何：`.ant-card-head-title` 高 **22px**、内层 `Flex` 也是 22px（`clipped: false`）、`max` 标签完整落在标题框内（`tagInside: true`）⇒ 没被 `overflow: hidden` 裁掉 |
| 关闭档浮层**未**被这次压缩波及 | ✅ | 单测（`eval-row-card.test.tsx` 的 off 两条），真机本轮三行都是 `max`、没有 `off` 行 ⇒ 未在真机复现 |
| 其它页面的供应商展示 | ✅ 未动 | 环境抽屉、日志环境文本、创建表单的模型下拉各有一份（本轮一个字没改） |

## 3. 操作路径

1. 浏览器打开目标页（新标签，避免动到已开着的「执行日志」抽屉）；
2. `page.locator('.ant-card-head-title code').first().hover()` → 等 400ms → 读可见 `.ant-tooltip`
   （判据：`.ant-tooltip` 既不含 `ant-tooltip-hidden`、`offsetWidth/Height` 也不为 0）→ 截图；
3. `page.locator('.ant-card-head-title .ant-tag-purple').first().hover()` → 同样读一次 → 截图。

## 4. 证据（浏览器 + CLI 互证）

- **浏览器（DOM 读数，`browser_run_code_unsafe` 的返回值）**：
  `providerNameVisibleAsText: false`；`headTitleTexts` 三行如上；
  `afterHoverModel: ["供应商：deepseek-anthropic（https://api.deepseek.com/anthropic）"]`；
  `afterHoverEffortTag: ["思考强度：max"]`。
- **截图**（`C:\Users\Zlei1\.dsh\profiles\desktop\.playwright-mcp\`，MCP 的允许根）：
  `tooltip-provider.png`（模型名浮层）、`tooltip-effort.png`（`max` 浮层）、`tooltip-openai-row.png`（三行各悬浮一次的末帧）。
- **磁盘事实互证**：`D:\.tmp\aieval\runs\8df6ff65-6bea-4d8a-94d3-bf5fa1accbd0\run.json` 的三行
  `providerName` / `baseUrl` / `modelId` / `effort` 与页面读到的浮层文案逐字对得上（`effort` 三行都是 `max`）。
- **控制台**：只有 React DevTools 提示与 `[HMR] connected`，**没有** ref 相关告警
  （`Tooltip` 包 `Typography.Text` 若拿不到 ref，React 会在这里报警——这正是这次要看的风险点）；
  唯一的 error 是 `/favicon.ico` 的 404（与本次改动无关，改动前后都在）。

## 5. 守卫与变异验证

| 守卫（`packages/client/ui/src/composite/eval-row-card.test.tsx`） | 变异（把缺陷做回去） | 结果 |
|---|---|---|
| 鼠标移入模型名 ⇒ 浮层给出「供应商：名字（地址）」 | 去掉 `Tooltip`，模型名还原成裸 `Typography.Text` | ❌ 红 |
| 阴性面：标题行上再也没有供应商 Tag | 把 `<Tooltip><Tag>{row.providerName}</Tag></Tooltip>` 加回去 | ❌ 红（`expected <span class="ant-tag ant-tag-filled …"> to be null`） |
| 行上写了档位 ⇒ 浮层写「思考强度：high」 | 还原旧文案「这一行要求的思考强度：…」 | ❌ 红 |

三条一起变异 ⇒ 该文件 `3 failed | 52 passed`；还原后两个文件的 SHA256 与变异前**逐字节相同**
（`F178D7E6…` / `A7978913…`），全套用例恢复 `2 passed (2) / 85 passed`。

## 6. 未覆盖项与后续

- **关闭档（`off`）那一格没在真机复现**：本轮三行的 `effort` 都是 `max`。它由单测钉住（标签 + 浮层两条），
  且 spec §4 已把措辞定死——要真机看一眼得再建一轮带 `off` 的评测。
- **`pnpm typecheck` 有 3 条**（`packages/server/agents/src/providers/codex/appserver/client.test.ts` 的
  `ProcessEnv` 缺 `NODE_ENV`），**不在本次改动范围内**（该文件属另一条工作线，已提交在 `a71ec25`）；
  `pnpm lint` 全绿（退出码 0）。
- **`pnpm vitest run packages/client/ui` 有 14 条既有失败**（`base/stored-preference.test.tsx` 12 条 +
  `base/list-detail-layout.test.tsx` 2 条），根因是 jsdom 里 `localStorage` 为 `undefined`
  （`Cannot read properties of undefined (reading 'setItem')`）；这两个文件的 import 只有
  `./stored-preference` / `./list-detail-layout` / `../testing/resize-observer`，与本次改动的模块图不相交。
