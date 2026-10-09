# 界面原语与主题

## 定位

`@aieval/ui` 按 base + composite 两层提供**纯展示**原语：不调接口、不依赖路由库，纯数据驱动（props 进、JSX 出），`ui → contracts` 是唯一内部依赖边。antd 6 的主题三处同步、紧凑密度字号反推、`Splitter` 受控回写这类反直觉坑，由原语层一次性收口，页面不再各自处理。

## 形态与交互

三层组织：`src/base/` 单一职责原语、`src/composite/` 面向功能块的组装（`AppTopNav`、`eval-row-card`、`agent-log/` 全家、`provider-*`、`rubric-*` 等）、`src/testing/` jsdom 桩。base 随真实消费者生长（脚手架期只实现有消费者的），当前核心原语与各自的实现契约：

- **PageShell**（页面根容器，「弹性布局 + 横向沾满」唯一出口）：四条不变量——纵向 Flex 根 + `width:100%` + `minWidth:0` + `height:100%`；**刻意不设 `alignItems`**（纵向 Flex 的交叉轴是水平方向，`flex-start` 会让子元素不横向拉伸）；`padding` / `gap` 默认不落 style（原语默认值一旦非 0，页面迁移会凭空新增间距）；**`minHeight:0` 无条件写**（高度链每个 scroll 模式共用，内容撑开容器时页面根收缩不到 flex 分配的高度，整页被顶出「顶栏那一截」）。结构性不变量自己写进**内联 style**——antd 的 `display` / `flex-direction` 走 CSS 类，内联读不到；不变量若只活在类名里，antd 换实现或改类名就静默失效。
- **ResizableColumns**（多栏可拖）：尺寸口径三条（读 antd `useSizes.js` / `useResize.js` 得出）——任一 Panel 带 `size` 整体走 propSizes 分支 ⇒ **弹性列必须不给 `size`**（条件展开而非 `size={0}`，给它传期望值会让它钉死、另一栏被压成 0）；`size` 是响应式受控入口，还原宽度必须给 `size`（`defaultSize` 刷新回旧值）；**受控拖拽必须把 `onResize` 回写进 `size`** 否则松手弹回（以 `onResize` 为准，别只监听 `onResizeEnd`）。`HANDLE_HIT_WIDTH = 6`；`restoreWidthsToAvailable` 是比例还原纯函数（弹性列原样回填）。栏增减后必须重收集宿主观察器，否则 `onPaneWidthChange` 从此**静默失效**。
- **ListDetailLayout**（「列表 + 可拖拽右栏」唯一出口，用例页 / 评测页复用）：右栏显示条件 = `detailOpen && detail !== null && detail !== undefined`（**两个都判**，只判开关会渲染一条空栏）；单栏退化不用宽 0 的 Panel、不用 SplitPane；`PANE_PADDING`（= 8）导出常量（同时是吸底操作栏对齐依据）。内部已是 `PageShell`，页面**不再自己套一层**。
- **SplitPane**（两栏薄适配）：`defaultSize`（挂载读一次），**不支持刷新还原拖过的宽度**——需要还原用 ResizableColumns；现状**无生产消费者**，保留为「不需要还原宽度时的两栏原语」。
- **stored-preference**（偏好记忆）：URL 记「在看什么」（`?panel=` / `?id=`）、localStorage 记「怎么显示」（栏宽、开关）——个人偏好不该随链接串味。读取路径**绝不抛错**（SSR / 隐私模式 / 禁用 / 脏值一律回落默认）；`useStoredWidth` **挂载后再读**（首帧读会产生水合不一致）。
- **theme-resolve + app-theme**（主题）：拆纯函数 + hook 两文件；`readAppliedThemeMode()` / `useAppliedThemeMode()` 读已解析明暗，消费方一律用这两个，不再自行解析一次。
- **density + density-context**（紧凑密度）：全站紧凑唯一收口；设置页以 `density="default"` 豁免。
- **AppTopNav**（顶栏，composite）：`Layout.Header` + `Menu`，导航项顺序**评测 / 用例 / 设置**；刻意不含产品名与主题切换（唯一入口在设置页，两处真源会打架）；**显式 `height: 40`**（`.ant-layout-header` 的 CSS 变量 `--ant-layout-header-height` 只在 Layout 嵌套作用域提供，根作用域实测为空、顶栏塌成 24.67px）+ **`flexShrink: 0`**（默认 1 时被压到 37.84px / 38.27px——随视口浮动，别当常数）；图标 `aria-hidden`；`aria-current` 由组件自己在 `<a>` 上给。
- **EmptyState / Toolbar / EllipsisText**：纯 props 展示。**format.ts**：`formatBytes`（1024 进制、非有限数按 0）/ `formatDateTime`（ISO → `YYYY-MM-DD HH:mm`，非法输入原样返回）/ `shortHash`；原则是任何非法输入都要有可读兜底，绝不让 `NaN` / `Invalid Date` 上界面。
- **testing/resize-observer.ts**：jsdom 无 `ResizeObserver`，antd Splitter 直接 `new` 全局构造器会 `ReferenceError`；桩**刻意不进共享 setup**（否则「无 ResizeObserver 也报初值」兜底分支永远测不到）；`installResizeObserverStub()` **顺带**装 matchMedia 桩（antd Table 两个 api 都要用，分两个入口必漏装一个）；替身只记账、从不调回调。
- **globals.css**（应用侧）：主题底色变量（`--app-bg/-fg/-border/-muted/-selected`）+ 盒模型复位；字号间距一律 antd token。`.ant-app` 高度链必须内联到位（`height:100%` + 纵向 flex，断链则整页被内容撑长、滚动条不出现）。两组动效类（`aieval-activity-sweep` / `aieval-stream-cursor`）类名由 ui 包带上、样式只在此一处定义，只用既有主题变量（不构成第三处真源）；`prefers-reduced-motion` 兜底（动效静止成动态文本且颜色一起还原；光标保留只是不闪）。
- **providers.tsx**（应用侧根 ConfigProvider 两项应用级配置）：`locale={zhCN}`（不配则 antd 内置文案全英文——`No data`、`aria-label="Close"` 一整类问题一次性关掉）；`button` 组件配 `autoInsertSpace: false`（否则「编辑」渲染成「编 辑」，可访问名 ≠ 可见文案，按名定位失配）。

## 数据与契约

- 原语接口契约就是「props 表 + 尺寸口径 + 偏好记忆口径」三件套（见上节）；composite 面板收的全是 contracts 类型。
- `ui → contracts` 是唯一内部依赖边：类型全部来自 contracts，纯数据驱动。`@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型——**类型转出不算依赖边**（编译期即被抹掉），只允许 `export type`，写成值导出就真有运行时依赖，得回来改依赖方向表。
- 主题底色变量按实际消费点分层：`--app-bg` / `--app-border` 由 ui 包的 `AppTopNav` 内联消费，`--app-muted` / `--app-fg` 由 globals.css 自消费（含动效渐变），`--app-selected` 由应用页的选中行样式消费（`app/runs/page.tsx`、`app/cases/page.tsx`）。

## 机制与演化

- **主题三处同步**：`ConfigProvider theme` + `html[data-theme]` + `ConfigProvider.config({ holderRender })`，缺一处就是半亮主题（「组件亮了、底色还是暗的」）。配套口径：`data-theme` 恒为解析后的 light / dark，`data-theme-preference` 保留偏好原值（auto 要能区分出来）；偏好未就绪按暗色兜底（SSR 不闪白）；auto 即时跟随系统无需刷新；主题唯一入口在设置页。
- **紧凑密度机制**：明暗算法与 `compactAlgorithm` 组成 `algorithm` 数组按序应用；`COMPACT_THEMES` 按明暗预生成（避免每次 render 重建 ThemeConfig，algorithm 数组引用也保持稳定）。字号只给 `fontSizeSM: 11`（见下）。
- **高度链机制**：`.ant-app` → `PageShell` → `Layout.Content` 的 `flex:auto + min-height:0`——断在任一环，整页被内容撑长、该出现的滚动条不出现。
- **`useAppliedThemeMode` 用 `useSyncExternalStore`**（首帧不闪）：订阅的是 `data-theme` 属性变化（`providers` 写完属性后通知所有消费方），server snapshot 恒 `'dark'`。
- **jsdom 缺口机制**：`matchMedia` 由用例自己注入；`ResizeObserver` 桩不进共享 setup（兜底分支要可达）；真实拖拽不可达（容器尺寸 0），`Splitter` 的 `onResize` 回写要在真实调用方处钉。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| 双击复位不是 antd 能力 | 已纠正的口径 | antd 6.6.5 `Splitter` 无内置双击复位（`es/splitter/SplitBar.js:203` 只把双击转给可选的 `onDraggerDoubleClick`，无人传）；需要时调用方自行实现，本期不做 |
| ListDetailLayout 比例还原实测未生效 | 已知弱点，本期不修 | 传给 `restoreWidthsToAvailable` 的 `widths` 是 `[0, preferredWidth]`（弹性列写死 0），只要 `available ≥ preferredWidth + 6` 就原样返回 ⇒ 缩窄时右栏恒保偏好宽（实测恒 380），左栏被压到 88px、16px——低于它声明的 `min: 120`；修法（扣掉弹性列 min，或把左栏实测宽喂进 widths）留给后续。底线是「窗口变窄不崩」，勿把比例收缩写成已兑现能力 |
| SplitPane 无生产消费者 | 保留 | 留在 ui 出口作「不需要还原宽度的两栏原语」；「右栏一律用 `end`」是给未来调用方的约定，非现状描述 |
| `CopyOnClick` / `OperationStatus` 未实现 | 现状 | 别照脚手架期的占位去代码里找；中止按钮分别写在 `run-detail-panel.tsx`（运行级）与 `eval-row-card.tsx`（行级），未抽成原语 |
| `.tsx` 测试只能在库包写 | 硬边界 | web-next 必须留 `jsx: preserve`（Next 需要），Vite 的 import-analysis 会报 `make sure to not set jsx to preserve`，改 vitest 的 `esbuild.jsx` / `esbuild.tsconfigRaw` 都无效；应用内测试一律 `.ts` |
| `styles.dragger` 覆盖陷阱 | 实测钉住 | 传 `width` 会把命中带改成 0（实测三条分隔条全为 0）；命中带宽度由 antd 尺寸变量决定，运行时变量名是 `--ant-splitter-split-bar-size` 等（`--ant-splitter-bar-size` 不存在）；两栏**间距**是组件自己写的 CSS `gap`，与 antd 无关 |
| 顶栏高度的两处实测数字 | 实测钉住 | `height: 40` 与 `flexShrink: 0` 都是确定值；37.84px / 38.27px 随视口浮动，**不要当固定常数**引用 |
| `Splitter` / `Flex` / `Button` 各坑 | 收口在原语层 | 受控 `size` + `onResize` 回写、弹性列不给 `size`；`Flex` 的 `display` / `flex-direction` 走 CSS 类（结构性不变量写内联 style）；antd 6 `Button` 的 `variant` 单给不生效（须与 `color` 成对，或用 `type` 语法糖，单给 `variant="dashed"` 静默渲染成实线）——三坑的完整表述以 `AGENTS.md`「边界与工具链的已知坑」表为真源，本文不复制第二份 |

## 相关链接

- 仓库内活文档：`AGENTS.md`「约束」（antd / 不手写字号 / 不裸写 `div` 的 UI 纪律）、「边界与工具链的已知坑」（紧凑密度、Button variant、主题三处同步、Splitter、Flex 各行）、「测试」（jsdom 缺口行）——按节名定位，坑表的真源在那里，本文不复制
- [契约体系](/architecture/contracts) —— ui → contracts 依赖边、`ProviderView` 掩码下行
- [用例管理](/features/case-management) —— ListDetailLayout 的真实消费方之一（列表 + 右栏三态）
- [《评测详情与候选行》](/features/run-detail)、[《设置》](/features/settings) —— ListDetailLayout 的另一消费方、主题唯一入口在设置页
