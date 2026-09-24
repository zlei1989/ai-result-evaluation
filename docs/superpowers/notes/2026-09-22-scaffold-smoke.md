# 脚手架示例页（/demo）11 项交互冒烟记录

- 任务：Task 13（示例页 —— 列表 + 右边栏）
- 分支 / 起始提交：`feat/scaffold` @ `7b6e87a`
- 日期：2026-09-24
- 运行环境：Next 16.2.7（Turbopack）+ React 19.2.7 + antd 6.6.5；浏览器 = Playwright 驱动的 Chrome，视口 **1440×900**（另有标注者除外）
- 地址：**http://localhost:3083/demo**（按文档约定用 `localhost`，不用 `127.0.0.1`）

## 1. 范围清单

覆盖：点行选中、拖拽分隔条（含拖动过程与方向）、刷新后宽度持久化、窗口变窄 / 变宽、双击分隔条、关闭右栏、三档主题、跟随系统 + 系统深浅色切换、右栏内部滚动与页面高度链、`message` 提示。
不覆盖（见 §5）：空列表态的真机路径、键盘 / 触摸操作分隔条、`holderRender` 静态浮层的配色断言、`127.0.0.1` 的 Next 16 跨源拦截复现。

## 2. 服务与进程

| 项 | 值 |
|---|---|
| 启动命令（后台 job） | `$env:AIEVAL_CONFIG_DIR="$env:TEMP\dsh-task13\aieval-config"; pnpm dev` |
| job | `pwsh-357`（主冒烟）；`pwsh-358`（补一次「全新加载 @520 + 右栏打开」探针） |
| 就绪日志 | `▲ Next.js 16.2.7 (Turbopack)` / `- Local: http://localhost:3083` / `✓ Ready in 835ms` |
| 收尾 | 两个 job 均已 `job_kill`；`Get-NetTCPConnection -LocalPort 3083 -State Listen` → **无监听**（只剩 TIME_WAIT / FIN_WAIT2 残连接）；无残留 `next dev` 进程 |
| 真实配置目录 | 全程未被写：`C:\Users\zhanglei1120\.aieval\config.json` 冒烟前后同为 `LastWrite 2026-09-24 16:33:34` / `219 B` / `SHA256 F16DCB0D…FB595080`；`[config-store] 配置已保存` 全部指向 `…\Temp\dsh-task13\aieval-config\config.json` |

## 3. 操作路径与证据

### 第 1 项 点列表任意一行 → 右栏显示该行详情

- 操作：`/demo` 加载完成后点第 1 行（`tr[data-row-key="1"]` 的第一个 `td`）。
- 证据（`browser_evaluate` 实测）：
  - 点击前：栏宿主 `[data-pane-key]` 0 个、分隔条 0 个（未选中时按设计退化为单栏）。
  - 点击后：栏宿主 2 个、分隔条 1 个；左栏 988px、右栏 420px；右栏渲染出「记录详情」卡片（标题 / 路径 / 完整哈希 / 状态 / 大小 / 更新时间）与「说明」卡片。
  - 选中行样式：内联 `background: var(--app-selected)`，计算值 `rgb(230, 244, 255)`（明亮主题）；全表 12 行里**只有 1 行**背景非透明。
- 截图：`task13-item1-selected-1440x900.png`（1440×900 全屏）。
- 判定：**通过**。

### 第 2 项 拖右栏左侧分隔条

- 操作：`mouse.down` 抓分隔条，按住状态下分 5 段移动并**在按住期间**逐点采样宽度，最后 `mouse.up`。
- 证据（全新状态：清掉 `demo-detail-width`，右栏默认 420，左栏 988，分隔条 x=1001）：

| 阶段 | 左栏宽 | 右栏宽 | 分隔条 x | localStorage |
|---|---|---|---|---|
| 拖动前 | 988 | 420 | 1001 | null |
| 按住 @+40px（向右拖） | 1028 | 380 | 1041 | 380 |
| 按住 @+80px | 1068 | 340 | 1081 | 340 |
| 按住 @+120px | 1088 | 320（到下限） | 1101 | 320 |
| 松手后 | 1088 | 320 | 1101 | 320 |
| 松手后再乱移鼠标 | 1088 | 320 | 1101 | 320 |

- 反方向复测（从右栏 420 起向左拖）：@-30px → 左栏 1058 / 右栏 350；@-60px → 左栏 1028 / 右栏 380。
- 结论：分隔条**跟随光标实时移动**——每次位移两栏同步变化同样的 Δ，且都在按住期间就已生效（不是松手才跳）；松手后不再跟随（拖拽正常结束）。
- **与 brief 的期望方向相反**：brief 写「拖向左 → 右栏变窄、列表栏变宽」，实测是「拖向左 → 右栏变**宽**、列表栏变**窄**」。要让右栏变窄需**向右**拖（上表）。分隔条自身始终停在光标处（分隔条 x = 起始 x + 位移），这是标准的分隔条语义。
- 判定：**几何行为通过；brief 的期望方向写反了**（见 §4 待裁决）。

### 第 3 项 刷新页面 → 宽度保持（必须留证）

- 操作：拖到右栏 380 → `page.reload()` → 等水合 → 点第 1 行。
- 证据：

| 阶段 | 左栏 | 右栏 | 分隔条 x | localStorage |
|---|---|---|---|---|
| 拖动后（松手） | 1028 | **380** | 1041 | "380" |
| 刷新后（未选中，右栏按设计不渲染） | — | — | — | "380" |
| 刷新后 + 点第 1 行 | 1028 | **380** | 1041 | "380" |

- 对照：清空 `localStorage` 后重新加载，右栏为默认 **420**（第 2 项首行）。两次同一操作路径、只差存储值，证明 380 确实来自偏好而不是巧合。
- 判定：**通过**。

### 第 4 项 窗口从宽拖到窄 → 两栏按比例收

- 操作：`page.setViewportSize` 依次 1440 → 1100 → 900 → 700 → 500 → 420 → 380（高度固定 900），每次等 450ms 后读两栏宽度。
- 证据：

| 视口宽 | Splitter 宽 | 左栏 | 右栏 |
|---|---|---|---|
| 1440 | 1408 | 1028 | 380 |
| 1100 | 1068 | 688 | 380 |
| 900 | 868 | 488 | 380 |
| 700 | 668 | 288 | 380 |
| 500 | 468 | **88** | 380 |
| 420 | 388 | **16** | 380 |
| 380 | 348 | 16 | **342** |

- 观察：1440 → 420 区间里右栏**一直保持偏好值 380**，全部收缩量由左栏承担，左栏被压到 88px、16px（**低于它自己声明的 `min: 120`**）；只有视口 ≲ 418（容器窄于「偏好 + 分隔条」）时右栏才开始按比例收（380 → 342 = round((348−6)/380 × 380)）。
- 原因（读码 + 实测）：`ListDetailLayout` 调 `restoreWidthsToAvailable([0, preferredWidth], …)`，数组里的 `total` 只统计非弹性列，于是 `total <= budget` 在「容器比偏好宽」时恒成立，比例还原几乎不触发；同时 antd 给弹性列的自动补白不遵守 `min`（实测 88 / 16 < 120）。
- 判定：**不符合期望**（见 §4 待裁决）。最小修法（**未应用**）：把弹性列的 `min` 从预算里扣掉（或把左栏实测宽喂进 `widths`），让右栏在左栏还能保住 120 时就开始收。

### 第 5 项 窗口拖回宽 → 右栏恢复偏好宽度

- 证据：900 → 左栏 488 / 右栏 **380**；1440 → 左栏 1028 / 右栏 **380**（与第 3 项持久化值一致）。
- 判定：**通过**。

### 第 6 项 双击分隔条 → 宽度复位

- 操作：`locator('.ant-splitter-bar-dragger').dblclick()`，间隔 600ms 测两次。
- 证据：双击前 左栏 1028 / 右栏 **380** / 存储 "380"；第 1 次双击后 完全不变；第 2 次双击后 完全不变。
- 根因（读 antd 源码）：antd 6.6.5 的 Splitter **没有内置双击复位**——`es/splitter/SplitBar.js:203` 只把 `onDoubleClick` 转给 `onDraggerDoubleClick` 这个 prop，而 `ResizableColumns` 与 `ListDetailLayout` 都没有传它（`grep DoubleClick antd/es/splitter/**` 只有这两处命中）。`resizable-columns.tsx` 文件头「拖拽、夹紧、键盘、双击、aria 语义全在 antd Splitter 里」这句对 6.6.5 而言，双击那半句不成立。
- 判定：**不符合期望**（见 §4 待裁决）。最小修法（**未应用**）：`ListDetailLayout` 传 `onDraggerDoubleClick` 把偏好重置回 `defaultDetailWidth`（420）；或退一步先改掉文件头那句不成立的声明。
- 附带确认：双击之后单次拖拽仍然可用（双击守卫没有把拖拽一起吃掉）。

### 第 7 项 点右栏「关闭」→ 右栏消失、列表占满

- 操作：点详情卡右上「关闭」（注意 antd 会给两个汉字插空格，DOM 文本是 `关 闭`，可访问名同为「关 闭」）。
- 证据：分隔条 **1 → 0**；栏宿主 **2 → 0**；选中行内联背景被清掉（计算值回到 `rgba(0, 0, 0, 0)`）；列表退回单栏占满。
- 判定：**通过**。

### 第 8 项 顶栏切「明亮」→ 组件与页面底色同时变白（必须留证）

- 操作：先点「暗色」再点「明亮」，各等 900ms，读 `data-theme` / `data-theme-preference` 与计算色。

| 阶段 | data-theme | data-theme-preference | --app-bg | html / body / 顶栏底色 | 顶栏文字 | Alert 底色 | color-scheme |
|---|---|---|---|---|---|---|---|
| 起始（跟随系统，系统=亮） | light | auto | #fff | rgb(255,255,255) | rgba(0,0,0,0.88) | rgb(230,244,255) | light |
| 点「暗色」 | dark | dark | #141414 | rgb(20,20,20) | rgba(255,255,255,0.85) | rgb(17,26,44) | dark |
| 点「明亮」 | light | light | #fff | rgb(255,255,255) | rgba(0,0,0,0.88) | rgb(230,244,255) | light |

- 页面底色、顶栏底色、组件文字色、`color-scheme` 同一次操作内一起翻，没有「组件亮了底色还暗」的半亮。
- 截图：`task13-item8-light.png`。
- 判定：**通过**。

### 第 9 项 主题选「跟随系统」后改系统深浅色 → 即时跟随、无需刷新（必须留证）

- 操作：点「跟随系统」→ 用 `page.emulateMedia({ colorScheme })` 改变 `prefers-color-scheme`（应用订阅的正是 `matchMedia('(prefers-color-scheme: dark)')` 的 change 事件，见 `packages/client/ui/src/base/app-theme.tsx`）→ 不刷新页面。
- 证据：

| 阶段 | data-theme | data-theme-preference | 系统 prefers-dark | --app-bg | body 底色 | 顶栏文字 | 页面探针 `window.__task13Marker` |
|---|---|---|---|---|---|---|---|
| 起点（显式 明亮） | light | light | false | #fff | rgb(255,255,255) | rgba(0,0,0,0.88) | alive |
| 点「跟随系统」 | light | **auto** | false | #fff | rgb(255,255,255) | rgba(0,0,0,0.88) | alive |
| 系统切深色 | **dark** | auto | true | **#141414** | **rgb(20,20,20)** | **rgba(255,255,255,0.85)** | **alive** |
| 系统切回浅色 | **light** | auto | false | #fff | rgb(255,255,255) | rgba(0,0,0,0.88) | **alive** |

- 「未刷新」的证明：探针 `window.__task13Marker` 全程 `alive`，且 `performance.getEntriesByType('navigation')[0].type` 仍是 `reload`（没有产生新导航）。
- 三个消费点（`ConfigProvider` 组件层、`html[data-theme]` 变量层、静态 holderRender）中前两者由本次实测覆盖；第三点见 §5。
- 判定：**通过**。

### 第 10 项 第 1 行（note 含多段长文本）→ 右栏内部滚动、页面不滚动（必须留证）

- 操作：选中第 1 行，读 `documentElement.scrollHeight/clientHeight` 与右栏宿主的 `scrollHeight/clientHeight`；再把 `scrollTop` 拉到底看是否真的能滚。
- 证据 A（默认 1440×900）：
  - `documentElement.scrollHeight = clientHeight = 900` → **页面不出现纵向滚动条 ✓**
  - 右栏宿主 `clientHeight = 806`、`scrollHeight = 806`、溢出 **0** → **右栏没有内部滚动 ✗**（整份详情内容自然高度只有 487px：`记录详情` 卡 ~300 + `说明` 卡 ~180）
  - 结论：brief 里「第三段用来把内容撑到超过视口高度」这句在这个视口尺寸下不成立——夹具文本不够长，断言后半条无从成立。
- 证据 B（1440×520，右栏打开，缩短窗口）：
  - 右栏宿主 `clientHeight = 451`、`scrollHeight = 543`、溢出 **92px**，`scrollTop` 实际能从 0 移到 **92.67** → **右栏内部滚动成立 ✓**
  - `documentElement.scrollHeight = 545` > `clientHeight = 520` → **页面自身溢出了 25px ✗**
  - 截图：`task13-item10-rightpane-scrollbar.png`（右栏滚到底 + 页面右侧出现滚动条）。
- 25px 的定位（全部为运行时实测；`.ant-app` 是纵向 flex，装着顶栏 + PageShell）：
  1. 右栏**关闭**、视口 520（无论全新加载还是缩下来的）：溢出 0，PageShell 高 495.33（= 520 − 24.67）。
  2. 右栏**打开**、视口 520：溢出 25，PageShell 高 520（<-- 没收缩），顶栏高 24.67 → 24.67 + 520 = 544.67。
  3. 右栏打开、视口 900：溢出 0，PageShell 高 875.33。
  4. 视口 520 时用运行时内联样式把 PageShell 的 `min-height` 压成 `0`：溢出 **0**，PageShell 高 495.33。
  - 即：`PageShell`（`height:100%` + `min-height:auto`）在右栏内容存在、视口又矮到一定程度时，无法收缩到 flex 分配的目标高度，于是整页被顶出「顶栏那么高」的一截。最小修法（**未应用**，`PageShell` 属 Task 11 的文件、不在本任务改动范围内）：把 `minHeight: '0px'` 与已有的 `minWidth: '0px'` 并列写进 `PageShell` 的结构性不变量（该文件已为 `scroll="inner"` 记录过同一理由）。
- 判定：**两半断言各自在不同的配置下失败**（见 §4 待裁决）。

### 第 11 项 点「新建示例」→ message 提示、不新增数据

- 操作：真实点击工具栏「新建示例」。
- 证据：+100ms / +300ms / +700ms 三次采样，`.ant-message` 容器存在且文案为 **「示例页不持久化数据」**；表格行数 **12 → 12**（没有新增）；这段时间没有新的 console 错误。
- 判定：**通过**。

## 4. 未通过项与待裁决（本次**未**改代码）

| 项 | 现象 | 原因定位 | 最小修法（未应用） |
|---|---|---|---|
| 2 | 拖动方向与 brief 期望相反 | 分隔条跟随光标是标准语义：向左拖 → 左栏窄、右栏宽 | 改 brief 的期望描述；操作改为「向右拖」 |
| 4 | 窄窗口下右栏不让位、左栏被压到 88 / 16px（低于自身 min 120） | `ListDetailLayout` 传给 `restoreWidthsToAvailable` 的 `total` 只含非弹性列；antd 对弹性列不施加 `min` | 预算里扣掉弹性列的 `min`，或把左栏实测宽喂进 `widths` |
| 6 | 双击分隔条无任何反应 | antd 6.6.5 Splitter 无内置双击复位，`onDraggerDoubleClick` 无人传 | `ListDetailLayout` 传 `onDraggerDoubleClick` 复位到 420 |
| 10 | 900 高时右栏不溢出；520 高时右栏能滚但页面溢出 25px | 夹具文本不够长；`PageShell` 缺 `minHeight:0` | 夹具加长 note（或按视口高度断言）；`PageShell` 补 `minHeight:'0px'` |

## 5. 未覆盖项 / 已知局限

1. **空列表态**：`/demo` 的 `records` 来自非空常量 `DEMO_RECORDS`，页面上无法走到 `records.length === 0` 分支。用 ui 包的临时用例（跑完已删）验证：空数组时渲染「还没有记录」+ 引导按钮、且不渲染 `<table>`、不渲染任何栏宿主。同一临时用例里非空表格与右栏两条断言在 jsdom 下因环境缺口失败（antd Table 需要 `window.matchMedia`——ui 的测试 setup 刻意不装它——以及 `getScrollBarSize`），这也是**不给这个展示页加单测**的原因；这部分由浏览器冒烟覆盖。
2. **分隔条的键盘 / 触摸操作**未验证（只做了鼠标拖拽与双击）。
3. **`holderRender` 静态浮层配色**未断言：`message` 只验证了文案，没有断言它在深色下的配色。
4. **`127.0.0.1` 的跨源 dev 资源拦截**本次未复现（Task 12 已记录），全程只用 `localhost:3083`。
5. **`/favicon.ico`**：本次实测 **404**（`Invoke-WebRequest http://localhost:3083/favicon.ico` → 404；浏览器内 `fetch('/favicon.ico', {cache:'no-store'})` → `status 404`、0 字节）。但本浏览器在导航时**不会自动请求 favicon**，Next 16 的 dev 日志也不打印这一行——所以它是否出现在控制台取决于是否真的请求了图标，本次干净加载的 console 里**没有**这条。
6. **主题 9 的「系统深浅色」**由 `emulateMedia` 模拟媒体查询变化，不是真的改操作系统设置；应用消费的正是同一个 `prefers-color-scheme` 变化事件。

## 6. 控制台与 dev 日志卫生

- 一次干净加载（`goto /demo` → 点第 1 行 → 等 2.5s）的完整 console：`[Fast Refresh] rebuilding` / `done in 119ms`、React DevTools 提示、`[HMR] connected`，以及**唯一一条 error**：
  `Warning: [antd: Alert] 'message' is deprecated. Please use 'title' instead.`
  （antd 6.6.5 已废弃 `Alert.message`，改用 `Alert.title`；本页按 brief 逐字使用了 `message=`。）
- **没有** hydration mismatch、**没有** `act(...)` 警告、**没有** 未捕获异常、**没有** pageerror。
- dev 日志：所有请求 200（`/demo`、`/api/settings`、`/runs`、`/cases`、`/settings`），Next 自身没有打印任何 404 行；唯一反复出现的是上面那条 Alert 弃用警告（浏览器 console 被转发到终端，每次 `/demo` 渲染一条）。
