# 冒烟记录：供应商表格「名称列左悬浮 / 操作列右悬浮」（2026-10-08）

> 目标页：`http://localhost:3083/settings` 的第二个页签「模型供应商」
> 用户口径（2026-10-08，逐字）：「名称列左悬浮，操作列右悬浮」；生效条件经拍板取「**窄于最小宽度才滚动**」
> —— 宽屏铺满、一条滚动条都不出，卡片窄到装不下时才表格内部横向滚动并把两侧钉住。
> **只记实测值**；读不出来的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么

| # | 改动 | 判据 | 落点 |
|---|---|---|---|
| 1 | 卡片窄到装不下五列时，`名称` 钉左、`操作` 钉右，中间三列从固定列下面滑过 | 窄视口下容器 `scrollWidth (900) > clientWidth (642)`，且滚动前后名称 `td` 的 `left` / 操作 `td` 的 `right` 逐字节不变、中间列位移 | `packages/client/ui/src/composite/provider-table.tsx`（`scroll={{ x: PROVIDER_TABLE_MIN_WIDTH }}` + 名称列 `fixed: 'left'` + 操作列 `fixed: 'right'`） |
| 2 | 最小宽度 `900` = 四列申报宽（180 / 150 / 90 / 200）+ 地址列下限 280 | 五个加数全是具名常量（`PROVIDER_COLUMN_WIDTH` + `BASE_URL_MIN_WIDTH`），求和式里没有裸数字 | 同上（`PROVIDER_TABLE_MIN_WIDTH`） |
| 3 | 形态守卫（含变异验证） | 见 §5 | `packages/client/ui/src/composite/provider-table.test.tsx` |

四列宽改成从 `PROVIDER_COLUMN_WIDTH` 一处取，是为了让「列宽」与「最小宽度」不会各自漂移
（地址列仍**刻意不给宽度**：它是唯一吃剩余宽度的列，见该列注释）。

## 2. 范围清单

| 项 | 判定 | 关键实测值 |
|---|---|---|
| 窄卡片横向滚动起来了 | ✅ | 视口 700 ⇒ 容器 `clientWidth 642` / `scrollWidth 900`，表格实测宽 **900**；可滚距离 258（滚到 `scrollLeft=258` 即到底） |
| `名称` 列钉在左边（表头 + 表体） | ✅ | 滚动前 `td.left = 29`，滚到底仍 `29`；`th` 同样 `29 → 29`（`-fix-start`） |
| `操作` 列钉在右边（表头 + 表体） | ✅ | 滚动前 `td.right = 671`，滚到底仍 `671`；`th` 同样 `671 → 671`（`-fix-end`） |
| 中间列**确实**从固定列下面滑过（不是整体没动） | ✅ | `协议类型` 单元格 `left: 209 → -49`（滚到底时被钉住的名称列盖住一半） |
| 宽屏**不出现**滚动条、按 100% 铺满 | ✅ | 视口 1400 ⇒ 容器 `clientWidth 1342` / `scrollWidth 1342`，表格宽 1342；五列实测宽 `[180, 150, 722, 90, 200]`（多出来的 442 全归地址列） |
| 地址列仍吃剩余宽度（没被最小值写死） | ✅ | 同上：宽屏 722 / 窄屏 280（正好是 `PROVIDER_TABLE_MIN_WIDTH` 里那一格） |
| 行数据照常渲染 | ✅ | 两次导航页面上都有 **2** 行（`likecode-anthropic`、`deepseek`），文本与改前一致 |
| 表格其余行为未被波及 | ✅ | `pnpm vitest run packages/client/ui`：**72 文件 / 878 用例全绿**（改前同命令同结果） |
| 类型与格式门禁 | ✅ | 全链 `tsc -p tsconfig.typecheck.json` 退出码 **0**；`pnpm lint` 退出码 **0** |

## 3. 操作路径

本会话**没有** Playwright MCP 浏览器工具（工具集里只有 `read_picked_element`，它只能读已选元素，
不能改视口、不能滚动、不能量滚动前后的差），故改用本机 `chrome-headless-shell` + **CDP** 直接驱动
（零新增依赖，脚本落在 `mktemp -d` 的临时目录，**未入库**）：

1. 起 `~/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
   （`--remote-debugging-port=9411 --no-sandbox --disable-gpu --disable-dev-shm-usage`，独立 `--user-data-dir`）；
2. `Emulation.setDeviceMetricsOverride` 定视口 → `Page.navigate` 到 `/settings`；
3. **点一下「模型供应商」页签**（antd 的未激活面板不渲染，不点就查不到表格）；
4. 等 `tbody tr.ant-table-row` 出现 → 读 `getBoundingClientRect()`（`MEASURE` 表达式：容器 `scrollLeft/clientWidth/scrollWidth` + 表格 + 五个 `th` / 五个 `td`）；
5. `scrollLeft = 0` 量一次 → `scrollLeft = 99999` 量一次（浏览器自己夹到 258）；
6. 换视口 1400 重走 2–4，核对「铺满 + 无滚动」。

**为什么要走 CDP 而不是看截图**：`sticky` 是否真的吸边，只有滚动前后的 `left/right` 差值说得清；
截图里 2px 的差看不出来，而「固定列没吸住」与「吸住了」在截图里长得一样。

⚠️ `--no-sandbox --disable-gpu` 不是可选项：不带这两个参数时 chromium 在本机沙箱里
`GPU process isn't usable. Goodbye.` **直接 FATAL 退出**，CDP 连接随之 1006 关闭
（症状是脚本的 `await send('Page.enable')` 永远不 settle —— 看起来像脚本挂住，实际是浏览器已经死了）。

## 4. 证据（浏览器 + CLI 互证）

浏览器侧（CDP `Runtime.evaluate` 的返回值，两次导航各一份完整 JSON）：

- 窄视口：容器 `642 / 900`，表格 900；滚到左端 `名称 td {left:29,right:209}` / `协议 td {left:209,right:359}` / `操作 td {left:471,right:671}`；
  滚到右端 `名称 td {29,209}` / `协议 td {-49,101}` / `操作 td {471,671}`；
  六条判定 `hasHorizontalScroll / middleColumnMoved / nameCellPinnedLeft / actionCellPinnedRight / nameHeaderPinnedLeft / actionHeaderPinnedRight` **全 true**。
- 宽视口：容器 `1342 / 1342`，表格 1342，五列 `[180,150,722,90,200]`；
  `noHorizontalScroll / tableFillsCard` **全 true**。

CLI 侧互证（改动落在磁盘上的事实）：

- `git status --short` 只有本轮的三个文件（外加两处**别人的**在改文件，未 add）；
- `shasum -a 256 packages/client/ui/src/composite/provider-table.tsx` 在变异前 / 还原后都等于
  `4dcee61b0a2c38622cc65d5efbe4bba48d385b2f8d4723c598bea43dc9fbbaa6`；
- 服务是真实 dev（`lsof -iTCP:3083` 有 LISTEN，`GET /settings` 200），量的是真页面而不是夹具。

## 5. 守卫与变异验证

守卫：`provider-table.test.tsx` 的 `卡片装不下时横向滚动，且名称列钉左、操作列钉右（P-COLUMN-FIXED）`
（照 `run-create-panel.test.tsx` 的 `C-COLUMN-FIXED` 写：容器 `overflow-x: auto`、表格
`width: 900px / min-width: 100% / table-layout: fixed`、首末 `th`+`td` 带 `-fix-start` / `-fix-end`、
中间三列**不带**、`colgroup` 宽度序列 `['180px','150px','','90px','200px']`）。

| 变异（把缺陷人为做回去） | 结果 | 命中的断言 |
|---|---|---|
| 拿掉 `scroll={{ x: PROVIDER_TABLE_MIN_WIDTH }}` | ❌ 红（`1 failed \| 8 passed`） | `expect(content).toHaveStyle({ overflowX: 'auto' })` —— 没有它容器拿不到滚动、表格也没有内联宽度 |
| 拿掉名称列 `fixed: 'left'` | ❌ 红（`1 failed \| 8 passed`） | 首列 `th` 不再带 `ant-table-cell-fix-start` |
| 拿掉操作列 `fixed: 'right'` | ❌ 红（`1 failed \| 8 passed`） | 末列 `th` 不再带 `ant-table-cell-fix-end` |

三个变异逐个做、逐个还原（三个变异在「把 280 提成 `BASE_URL_MIN_WIDTH` 之前后各做过一轮，两轮结果相同）；
全部还原后该文件哈希与变异前**逐字节相同**（`4dcee61b…baa6`），单文件 `9 passed`、ui 包 `878 passed`。

## 6. 未覆盖项与后续

- **`pnpm typecheck` 在本机跑不起来**（既存问题，与本次改动无关）：根 `package.json` 的
  `typecheck` 脚本是裸 `tsc -p tsconfig.typecheck.json`，但根 `devDependencies` 里**没有 `typescript`**
  （8 个包各自有），于是 `node_modules/.bin/tsc` 不存在、命令直接 `sh: tsc: command not found`。
  本轮的绕过办法是直连仓库里那份编译器：
  `node node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc -p tsconfig.typecheck.json`（退出码 0）。
  要闭合得在根 `package.json` 补一条 `typescript` devDependency（会动 `pnpm-lock.yaml`，**没做**，先报备）。
- **只在 headless chromium 里量过**：`deviceScaleFactor` 固定 1、未试暗色主题与浏览器缩放；
  亚像素渲染与真实 Chrome GUI 可能有差，但「固定列吸不吸边」是布局层的事，与该差异无关。
- **`/cases` 列表的表格未动**（用户在同一次会话里也选中过它，但没有下口径）；若同样要两侧固定，
  它有一张「两张列表都带 `sticky`」的既有注释（`ellipsis-text.tsx`），得连着那条一起改。
- **CDP 冒烟脚本未入库**（一次性产物，落在 `$TMPDIR`）：本轮只为「几何断言不能靠眼睛」留证据；
  若以后常规要用，值得收成 `scripts/` 下的一个脚本（那属于另一件事）。
