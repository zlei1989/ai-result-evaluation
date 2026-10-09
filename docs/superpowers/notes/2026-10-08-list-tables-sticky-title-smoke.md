# 冒烟记录：两个列表页（/cases、/runs）的「标题列左悬浮」（2026-10-08）

> 目标页：`http://localhost:3083/cases`、`http://localhost:3083/runs`（都是左栏列表）
> 用户口径（2026-10-08，逐字，分两次给）：「标题列左悬浮」——先用例页，后评测页
> **只记实测值**；读不出来的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么

| 页面 | 改动 | 判据 | 落点 |
|---|---|---|---|
| `/cases` | 左栏窄到装不下四列时，`标题` 钉在左边，其余三列滑走 | 窄栏下 `.ant-table-body` 的 `scrollWidth (700) > clientWidth (364)`；滚动前后标题 `td`/`th` 的 `left` 逐字节不变、仓库列位移 | `apps/web-next/app/cases/page.tsx`（`scroll={{ x: CASES_TABLE_MIN_WIDTH }}` + 标题列 `fixed: 'left'`） |
| `/runs` | 同上，五列版 | 窄栏下 `662 > 364`；标题列不动、状态列位移 | `apps/web-next/app/runs/page.tsx`（`RUNS_TABLE_MIN_WIDTH` + 标题列 `fixed: 'left'`） |
| 两页 | 最小宽度全是具名常量，求和式里没有裸数字 | `/cases` = 200+110+150+240 = **700**；`/runs` = 96+80+96+150+240 = **662**（标题列下限两页同取 240：两页的标题列本来就逐字同形） | 两页各自的 `*_TABLE_MIN_WIDTH` / `*_COLUMN_WIDTH` / `*_TITLE_MIN_WIDTH` |
| 守卫 | 接线守卫扩到两页（见 §5） | —— | `apps/web-next/src/list-table-scroll-wiring.test.ts` |

**扩口没有放松原有那一刀**：该文件原先断言「列表表格里不许出现 `scroll={`」（防的是 `scroll.y`
的常驻空滚动条）。现在拆成三档：① `scroll.y` 两种页面都禁（原缺陷仍拦得住）；② 两页都**必须**
给数值型 `scroll.x`；③ 固定列只许钉标题列，钉到别的列上照红。

## 2. 范围清单

| 页 | 项 | 判定 | 关键实测值 |
|---|---|---|---|
| cases | 宽栏不出现横向滚动 | ✅ | 视口 1400、右栏关 ⇒ `clientWidth 1384` / `scrollWidth 1384`，表格宽 1384（铺满） |
| cases | 窄栏横向滚动 + 标题钉左 | ✅ | 视口 800 + 点第一行开右栏 ⇒ 容器 `364 / 700`，可滚 336；标题 `td`/`th` 恒 `8–248`，仓库列 `248 → -88` |
| cases | 表头与表体横向同步 | ✅ | 滚到底时仓库 `th.left (-88) === td.left (-88)` |
| runs | 宽栏不出现横向滚动 | ✅ | 同上视口 ⇒ `1384 / 1384`，表格宽 1384 |
| runs | 窄栏横向滚动 + 标题钉左 | ✅ | 容器 `364 / 662`，可滚 298；标题 `td`/`th` 恒 `8–248`，状态列 `248 → -50` |
| runs | 表头与表体横向同步 | ✅ | 滚到底时状态 `th.left (-50) === td.left (-50)` |
| 两页 | **表头吸顶没被 `scroll.x` 破坏**（本轮最大风险点） | ✅ | 把外层滚动容器压到 60px 后滚到底：cases 表头 `th.top = 85` **精确等于**容器顶 85、数据行 `td.top = 100`（滚了 14px）；runs 表头 `85`、数据行 `98`（滚了 16px）⇒ sticky 仍吸在容器顶，且不是「内容没动」造成的假绿 |
| 两页 | 标题列宽度随左栏伸缩（没被最小值写死） | ✅ | cases 宽栏时标题列 = 1384 − 460 = 924、窄栏 = 240；runs 窄栏 = 662 − 422 = 240 |
| 两页 | 类型与格式门禁 | ✅ | 全链 `tsc` 退出码 **0**；`pnpm lint` 退出码 **0** |
| 两页 | 其它用例未被波及 | ✅ | `pnpm vitest run apps/web-next`：**23 文件 / 254 用例全绿**（守卫从 6 条长到 8 条） |

## 3. 操作路径

本会话没有 Playwright MCP 浏览器工具（`read_picked_element` 只能读已选元素，不能改视口 / 滚动 /
量滚动前后的差），故用本机 `chrome-headless-shell` + **CDP** 直接驱动（零新增依赖，脚本落在
`mktemp -d`、**未入库**），只量 `getBoundingClientRect()` / `scrollLeft`：

1. 视口 1400 → `Page.navigate` 到目标页 → 等 `tbody tr.ant-table-row` 出现 → 量一次（宽栏基线）；
2. 视口收到 800 → **点第一行**打开右栏（左栏随之变窄，这是它开始横向滚动的真实用户路径）→
   等 `.ant-table-body` 的 `scrollWidth > clientWidth`；
3. `body.scrollLeft = 0` 量一次 → `= 99999` 量一次（浏览器自己夹到底），比对标题列与第二列；
4. **纵向**：把 `.ant-table-wrapper` 的父元素（`TableScrollArea` 那个 Flex）内联改成
   `flex: none; height: 60px` 再 `scrollTop = 99999` —— 两页各只有 1 行数据、自然状态下滚不动，
   压矮容器是**在不造数据的前提下**制造真实纵向滚动的唯一办法；量表头 `th.top` 与容器顶。

⚠️ 第 4 步的判据必须**同时**看三个数：只看「表头没动」是假绿（容器压根没滚成），
所以要 `scrollHeight > clientHeight`、数据行 `top` 变了、表头 `top` 没变，三条一起成立才算。

## 4. 证据（浏览器 + CLI 互证）

浏览器侧（CDP `Runtime.evaluate` 的返回值）：

- `/cases`：宽栏 `1384 / 1384`；窄栏 `364 / 700`，标题 `td {8,248}` 恒定、仓库 `td {248,448} → {-88,112}`；
  六条判定 `hasHorizontalScroll / repoColumnMoved / titleBodyPinnedLeft / titleHeaderPinnedLeft /
  headerFollowedBodyScroll / headerSyncsWithBody` **全 true**；纵向容器 `60 / 74 / 14`、容器顶 85、
  表头 85、数据行 100。
- `/runs`：宽栏 `1384 / 1384`；窄栏 `364 / 662`，标题 `td {8,248}` 恒定、状态 `td {248,344} → {-50,46}`；
  同样六条 **全 true**；纵向容器 `60 / 76 / 16`、容器顶 85、表头 85、数据行 98。

CLI 侧互证：

- `pnpm vitest run apps/web-next` = 23 文件 / 254 用例全绿；`pnpm lint` 0；全链 `tsc` 0；
- 四个变异逐个做完后还原，两个页面文件的 SHA256 与变异前**逐字节相同**：
  `apps/web-next/app/runs/page.tsx` = `ceef95bec94307f5efd8ee5a5002505f1ca4397ec60958ce1acfc87a0d5a2513`、
  `apps/web-next/app/cases/page.tsx` = `764d866311cfce2189e6703b7a77ebb18590764ecaa21009e0c9ff560c4c26cf`；
- 服务是真实 dev（`lsof -iTCP:3083` 有 LISTEN），量的是真页面。

## 5. 守卫与变异验证

守卫：`apps/web-next/src/list-table-scroll-wiring.test.ts`（读源码的文本守卫 —— `apps/web-next` 不能写
`.tsx` 测试，页面这一层没有渲染测试面）。两页 × 四条断言，两块切片，**抠不到就抛**：

- `<TableScrollArea> … </TableScrollArea>`：页面里有表格、有 `sticky`、**没有** `scroll.y`、
  **有**数值型 `scroll={{ x: <该页常量> }}`；
- `const columns: TableColumnsType<EvalRun|TestCase> = [ … ];`（列定义在滚动容器**外面**，第一版守卫
  就是在这里踩了空切片 —— 抠不到直接抛，才当场发现）：标题列必须 `fixed: 'left'`，且全表 `fixed`
  **只许一处**。

| 变异（把缺陷人为做回去） | 结果 | 命中的断言 |
|---|---|---|
| ① 拿掉 `/runs` 的 `scroll={{ x }}` | ❌ 红（`1 failed \| 7 passed`） | 「表格给了数值型 scroll.x」 |
| ② 拿掉 `/cases` 的标题列 `fixed: 'left'` | ❌ 红 | 「固定列只钉标题列，且标题列确实钉在左边」 |
| ③ 把 `scroll={{ y: 300 }}` 加回 `/runs` | ❌ 红 | 「表头用 sticky（不是 scroll.y）」—— 原缺陷仍拦得住 |
| ④ 把 `/runs` 的 `fixed: 'left'` 挪到「状态」列 | ❌ 红 | 「固定列只钉标题列…」（钉错列也拦得住） |

四个变异逐个做、逐个还原；全部还原后两个页面文件与变异前**逐字节相同**，守卫恢复 `8 passed`。

## 6. 未覆盖项与后续

- **纵向只滚了 14 / 16px**：两页真机各只有 1 条数据（列表内容 74 / 76px、容器压到 60px）。
  判据的区分力够（sticky 若失效，`th.top` 会跟着上移到 71 / 69），但「长列表滚很深时表头是否
  一直吸住」没在真机走到，只由 `sticky` 的语义与 `table-scroll-area` 的既有用例兜着。
- **`scroll.x` + `sticky` 的组合结论只在本机 chromium 量过**：rc-table 的 `fixHeader || isSticky`
  分支把 `scrollXStyle` 落在 `.ant-table-body`、表头另拆 `.ant-table-sticky-holder` —— 本轮实测证伪了
  「`.ant-table-content` 的 `overflow-y: hidden` 会把表头吸顶废掉」这个担心；但这是**实现细节**，
  升 rc-table 大版本时要重测这一格。
- **两页的标题列下限（240）是两份独立的常量**：数值相同是「两页标题列同形」的结果，不是共享真源。
  真要改成一份就得新开模块（为一格数字建模块属过度设计）；漂移的代价只是两页最小宽度不同，不是缺陷。
- **`pnpm typecheck` 在本机仍跑不起来**（根 `package.json` 缺 `typescript` devDependency，既存问题）：
  本轮照旧直连 `node_modules/.pnpm/typescript@5.9.3/.../bin/tsc`（退出码 0）。详见
  `2026-10-08-provider-table-sticky-columns-smoke.md` §6。
- **暗色主题 / 浏览器缩放 / `deviceScaleFactor ≠ 1` 未测**（吸边是布局层的事，与该差异无关）。
