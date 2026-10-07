# 「失败的工具调用也默认折叠」的改动与冒烟记录（2026-10-03）

口径来源：**用户 2026-10-03**「执行日志，失败的工具调用默认也折叠，不展开」。
用户当场选定的落法是**两层都不展开 + 组头留「失败 N」标记**（而不是「组头不加任何标记」或
「只取消失败行」那两种）——理由是：失败不再自动展开之后，收起态必须还说得出「这一组里有失败」。
落点在 `packages/client/ui/src/composite/agent-log/`，spec
（`2026-09-30-exec-log-drawer-redesign-design.md` §4.2 末段 / §6.1 细则 2 / §10 测试表与变异体 (z) / §11 验收 5）
已同步改写：原稿的例外 2「失败的工具自动展开」**作废**。

## ① 范围清单

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 失败的工具组**默认收起** | ✅ | 夹具页 `/dev/agent-log`：组头 `aria-expanded="false"`，错误原文 `FAIL packages/client/ui/src/composite/agent-log/render-blocks.test.ts` **不在 DOM 里** |
| 2 | 组内那条失败行**默认收起** | ✅ | 点开组后，那一行的摘要行可见（带红色「失败」Tag）而它自己 `aria-expanded="false"`；错误原文仍不在 DOM |
| 3 | 收起态**看得出有失败** | ✅ | 组头右侧红色 `失败 1`（`ant-tag-error`）；**一条失败都没有时整格不渲染** |
| 4 | 进行中的工具组仍默认展开（没被这条口径带走） | ✅ | `defaultOpenKeysOf` 的 running 支路未动，两条单测钉住（`use-agent-log-view.test.ts`） |
| 5 | 计划清单 / 问答卡片的展开规则一字不动 | ✅ | 夹具页上唯一展开的块是「计划清单 1/4 完成 · 结果未采集」（结果未采集 ⇒ 展开，与改动前一致） |

## ② 操作路径

`http://localhost:3083/dev/agent-log`（`next dev -p 3083`，源码改动由 HMR 生效）→
页面里那份 dsh 夹具的**第 2 轮**正好是「一次失败的命令」（`pwsh` + 结果 `isError: true`）→
读组头的 `aria-expanded` 与 DOM 文本 → 点一次组头 → 再读组内那一行的 `aria-expanded` 与 DOM 文本。

## ③ 证据

浏览器 `browser_evaluate`（改动生效后，改前这份夹具的该组是**展开**的）：

```json
{ "headerCount": 7,
  "failed": [{ "cls": "ant-collapse-header", "text": "工具调用 × 1pwsh失败 1", "expanded": "false" }],
  "failedTagClass": "ant-tag ant-tag-filled ant-tag-error css-dev-only-do-not-override-oc1rc0 ...",
  "failTextPresent": false, "inputPresent": false,
  "expandedTitles": ["计划清单1/4 完成结果未采集"] }
```

再点一次组头之后（组开了，**那一行仍收起**）：

```json
{ "groupExpanded": "true",
  "rowHeaders": [{ "text": "pwsh{\"command\":\"pnpm vitest run\"}跑命令失败", "expanded": "false" }],
  "failTextPresent": false }
```

截图：`.playwright-mcp/exec-log-failed-group-collapsed.png`（收起态组头：`工具调用 × 1 pwsh` + 右侧红色 `失败 1`）。

单测：`pnpm vitest run packages/client/ui/src/composite/agent-log/` → **27 文件 / 251 用例全绿**；
三条新/改用例**先红后绿**（改实现前该轮是 5 条红）。

**变异验证**（本仓硬口径，五个靶子逐个制造回去，均确认变红后还原；五个源文件 SHA256 与改前逐字相同）：

| # | 造回去的缺陷 | 变红的守卫 |
|---|---|---|
| M1 | `if (running \|\| failed)`（失败 ⇒ 组展开） | `use-agent-log-view.test.ts`「失败的工具组与失败的行都默认收起」 |
| M2 | 写回「失败的行也入键」 | 同上 + 「组内有失败而轮次还在跑时……但那一行失败仍收起」 |
| M3 | 组头不渲染失败标记（`failed > 0 &&` 换 `null &&`） | `tool-group-panel.test.tsx` 两条 |
| M4 | 失败数只数 `call`（漏掉失败的孤立结果） | `tool-group-panel.test.tsx` 的计数用例 |
| M5 | 无条件渲染（恒画「失败 0」） | `tool-group-panel.test.tsx` 的「不画恒为 0 的读数」 |

## ④ 未覆盖项

- **失败行「要点两次」是这条口径的直接代价**：组收起时组内的行压根没挂载（`destroyOnHidden`），
  所以错误原文必须「展开组 → 展开行」两下才看得到。spec §6.1 细则 2 已把原稿那句
  「失败的证据不该要用户点两次才看得到」标为**作废**，并把补偿口径（组头「失败 N」）写在那里。
- **真实评测未复跑**：夹具页覆盖了「失败调用」与「失败的孤立结果」两种形态（后者计入 `N`）；
  真实一轮里成片失败的观感没有再跑一次评测验证（分钟级成本），形态与夹具同源。
- **同工作树里另有一处在改 `raw-output-panel` / `BlockRenderContext`（`rawOpen`）**，与本改动无交集：
  本次 `pnpm typecheck` 报的 7 条错全在那两处的文件（`fixtures.test.tsx` 3 条、
  `raw-output-panel.test.tsx` 4 条），本改动涉及的 5 个文件一条都没有。
  另：`src/base/stored-preference.test.tsx`（12 条）与 `list-detail-layout.test.tsx`（2 条）在本次全量 UI 跑里红，
  成因是环境里 `window.localStorage` 为 `undefined`（Node 打出 `localStorage is not available because
  --localstorage-file was not provided`），与本改动无关（那两个文件不 import `agent-log` 任何东西）。
