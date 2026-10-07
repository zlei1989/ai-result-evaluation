# 2026-10-04 「JSON 原文高亮格式化 + 查看原始返回搬到抽屉 footer」冒烟记录

**范围**：① 模型/厂商原文是 JSON 时**缩进格式化 + 语法高亮**，不是 JSON 时逐字原样（新增 `JsonText` 原语，替换 4 处）；
② 评分详情抽屉里删掉正文的「模型原始返回」标题、把「查看原始返回」按钮搬进**抽屉 footer**（开合态受控上移到页面）。

**落点**：`packages/client/ui/src/base/json-text.tsx`（新）、`base/json-text.test.tsx`（新）、
`composite/score-detail-view.tsx`、`composite/agent-log/{raw-output-panel,unrecognized-block-view,tool-item-detail}.tsx`、
`apps/web-next/app/runs/page.tsx`、`apps/web-next/src/runs-page-wiring.test.ts`。

## ① 范围清单

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 评分详情抽屉的 footer 有「查看原始返回」按钮，且按钮**在 footer 内** | ✅ | `footerExists: true`、`buttonInFooter: true`、`footerRect {x:632,y:680,w:800,h:41}` |
| 2 | 抽屉正文里**没有**「模型原始返回」标题（正文里那一行已拆掉） | ✅ | 正文 `textContent` 里 `模型原始返回` 出现 **0** 次 |
| 3 | 抽屉标题仍是「评分详情」，二级抽屉标题是「模型原始返回」 | ✅ | `.ant-drawer-title` = `["评分详情","模型原始返回"]` |
| 4 | 关着时二级抽屉正文不在 DOM（`destroyOnHidden`） | ✅ | `nestedDrawerInDom: false`、`rawBodyInDom: false` |
| 5 | 点 footer 按钮后，真实 `score.raw` 被格式化 + 高亮 | ✅ | 1332 字符 → **45 行**；token **121** 个（key 26 / string 17 / literal 8 / punct 70）；首三行 `{` / `  "judgments": [` / `    {` |
| 6 | 颜色真的来自 antd token（不是写死色值） | ✅ | 键 `rgb(22,119,255)`=colorInfo、字符串 `rgb(82,196,26)`=colorSuccess、字面量 `rgba(0,0,0,0.65)`=colorTextSecondary、标点 `rgba(0,0,0,0.45)`=colorTextTertiary |
| 7 | 等宽 + `pre-wrap`（格式化靠它才看得见换行） | ✅ | `fontFamily: SFMono-Regular, Consolas, …`、`whiteSpace: pre-wrap` |
| 8 | 关二级抽屉 → 正文消失、footer 按钮还在 | ✅ | `nestedRawGone: true`、`footerButtonStillThere: true` |
| 9 | 关主抽屉 → 无抽屉残留 | ✅ | `anyDrawerOpen: false` |
| 10 | **换一行重开评分详情，二级抽屉不自弹**（这次状态形状的靶子） | ✅ | `rawAutoOpened: false`、`footerButton: true`、正文仍是「57 分 · 共 8 项…」 |
| 11 | 夹具页（`/dev/agent-log`，dsh）「未识别的厂商载荷」格式化 + 高亮 | ✅ | `{\n  "title": "修 build 脚本"\n}`，5 个 token（punct/key/string） |
| 12 | 「原始结果」（卡片底部 `single` 变体）真机核对 | ⏭️ 跳过 | 三份夹具的这类卡片都落在「结果未采集」那一档（无原文可开），真机无可达路径；由 `raw-output-panel.test.tsx`（含回落那一支）+ 变异验证覆盖 |
| 13 | 「结构化结果」真机核对 | ⏭️ 跳过 | 夹具里所有 `tool-result.structured` 都是 `null`（`fixtures.ts`），无可达路径；由 `tool-item-detail.test.tsx` + 变异验证覆盖 |
| 14 | 空态（这一行还没有评分）不给 footer | ⏭️ 跳过 | 这一轮三行都已评分，构造不出该态；由 `runs-page-wiring.test.ts` 的文案判据 `footer={ scoreDetail === null ? null :` 钉住 |

## ② 操作路径

1. 打开 `http://localhost:3083/runs?panel=detail&id=2921fee3-6144-4df4-b2db-eb0f8fec678a`（已在跑的 dev server，PID 20992）；
2. 点第 1 行的「评分详情」→ 读 footer / 正文 / 二级抽屉状态；
3. 点 footer 的「查看原始返回」→ 读 `[data-testid="score-raw"]` 的行数、token 数与 `getComputedStyle` 的颜色；
4. 关二级抽屉 → 关主抽屉 → 点第 2 行的「评分详情」→ 查二级抽屉有没有自弹；
5. 打开 `http://localhost:3083/dev/agent-log`，dsh 夹具下展开「未识别的厂商载荷」→ 读 token。

## ③ 证据

- 浏览器：上面 ① 表里的每一项都是 `browser_evaluate` 读出的真实 DOM / `getComputedStyle`（不是截图目测）；
  唯一 console 报错是 `favicon.ico 404`（与本改动无关）。
- CLI 互证：`D:\.tmp\aieval\runs\2921fee3-…/run.json` 里 `score.raw` 实测长度 943–1048 字节、**单行** JSON
  ——与页面上「1 行变 45 行」对得上（这一份是 1332 字符的那一行）。
- 门禁：`pnpm typecheck` 通过；`pnpm lint` 只剩 `.tmp-page-module.js`（**别人未跟踪的临时产物**，按 AGENT.md 保持原样）；
  `pnpm vitest run packages/client/ui` = 761 passed / 14 failed，失败的 2 个文件
  （`stored-preference.test.tsx` 12 条、`list-detail-layout.test.tsx` 2 条）**与本改动无关**：
  报错是 `localStorage` 在该 jsdom 环境为 `undefined`（`reading 'setItem'/'removeItem'/'clear'`）与
  `window.getComputedStyle(elt, pseudoElt)` 未实现，两个文件都不 import 本次改动的任何模块。
- 变异验证：**19 条全部被拦住**（17 条主批 + 2 条补批），每条跑完即还原并核对 sha256 未变。

## ④ 未覆盖项与后续计划

- 上表 12–14 三格没有真机路径（原因见「跳过」列），已由单测 + 变异验证兜住；将来夹具补上
  「有结果的任务面板 / 有 `structured` 的工具结果 / 未评分的行」时，这三格应顺手在真机上复核一遍。
- `README.md` 第 177 行（评分详情那一行）现在写着「『查看原始返回』按钮（原文在二级抽屉里整段看，不再占正文高度）」，
  与本口径已有出入（按钮进了 **footer**、正文是 JSON 则格式化 + 高亮）。**该行当前正被另一个会话改动**
  （`git diff` 里 `@@ -177 +177 @@`），按 AGENT.md「不属于你的文件保持原样」没有动它——收口时请由那一侧的会话一并更新。
