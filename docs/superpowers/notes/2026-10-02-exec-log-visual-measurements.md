# 执行日志抽屉：视觉检查实测数据（2026-10-02）

> **用途**：本文件是 spec 重写时「详细 UI 审美描述」一节的**唯一数据来源**。
> 其中的每个数字都是在真实渲染的页面上量出来的，不是从 antd 文档抄的、也不是估的。
>
> **取证方式**：临时候选页 `apps/web-next/app/preview/exec-log/`（夹具 + 渲染），
> `next dev -p 3083`，Playwright 读 `getComputedStyle` / `getBoundingClientRect`，
> 对比度按 WCAG 相对亮度公式自算（含半透明前景与背景的 alpha 合成）。
> 预览页与夹具属一次性检查件，检查完即删；本文件保留。

## 1. 主题 token 实测值（紧凑密度，`fontSizeSM: 11`）

配置口径来自 `packages/client/ui/src/base/density.ts`：
`algorithm: [defaultAlgorithm | darkAlgorithm, compactAlgorithm]`，`token: { fontSizeSM: 11 }`。
下表用 `theme.getDesignToken()` 直接算出，**明暗两态的字体/间距/圆角完全一致，只有颜色不同**。

| token | 值 | 用途 |
|---|---|---|
| `fontSizeSM` | **11** | Tag、次级标注 |
| `fontSize` | **12** | 正文、Collapse 头、面包屑、按钮 |
| `fontSizeLG` | **14** | 一级标题、卡片标题 |
| `fontSizeXL` | 16 | —— |
| `fontSizeHeading1/2/3/4/5` | 32 / 26 / 20 / 16 / 14 | 抽屉内**不用** |
| `lineHeight` | **1.667**（≈20px @12px） | 正文行高 |
| `lineHeightSM` | 1.8 | 小字行高 |
| `controlHeight` | **28** | 默认控件高 |
| `controlHeightSM` | **21** | `size="small"` 控件高 |
| `controlHeightLG` | 35 | —— |
| `paddingXXS` / `XS` | **4** | 最紧的间隙 |
| `paddingSM` | **8** | 块内间隙 |
| `padding` | **8** | 同上 |
| `paddingMD` / `LG` | **16** | 区与区之间、抽屉内边距 |
| `paddingXL` | **32** | —— |
| `marginXXS` / `XS` | **4** | 行内元素间距 |
| `marginSM` / `margin` | **8** | 块与块之间 |
| `marginMD` / `LG` | **16** | 轮次之间 |
| `marginXL` | **32** | —— |
| `borderRadius` | **6** | —— |
| `borderRadiusSM` | **4** | Tag、Button |
| `borderRadiusLG` | **8** | Card、Collapse |
| `sizeStep` / `sizeUnit` | 4 | 4px 网格的根据 |

**关键含义**：紧凑密度下 `fontSize = 12`（antd 默认是 14）。
**≥4px 的所有间距都是 `sizeStep` 的整数倍**——写 spec 时引 token 名，不写像素。

## 2. 颜色（两态实测）

| 语义 | 亮色 | 暗色 |
|---|---|---|
| `colorText` | `rgba(0,0,0,.88)` | `rgba(255,255,255,.85)` |
| `colorTextSecondary` | `rgba(0,0,0,.65)` | `rgba(255,255,255,.65)` |
| `colorTextTertiary` | `rgba(0,0,0,.45)` | `rgba(255,255,255,.45)` |
| `colorTextQuaternary` | `rgba(0,0,0,.25)` | `rgba(255,255,255,.25)` |
| `colorBorder` | `#d9d9d9` | `#424242` |
| `colorBorderSecondary` | `#f0f0f0` | `#303030` |
| `colorBgContainer` | `#ffffff` | `#141414` |
| `colorBgElevated` | `#ffffff` | `#1f1f1f` |
| `colorBgLayout` | `#f5f5f5` | `#000000` |
| `colorPrimary` | `#1677ff` | `#1668dc` |

全局底色变量（`apps/web-next/app/globals.css`，供 ui 包内联 `var()` 消费）：
`--app-bg` `#141414` / `#ffffff`、`--app-fg`、`--app-border`、`--app-muted` `#888`（两态同值）、`--app-selected`。

## 3. 组件实测尺寸（暗色，紧凑密度）

| 元素 | 实测 | 口径 |
|---|---|---|
| `Tag` | 高 **21.4** · padding `0/7` · 圆角 **4** · 字号 **11** · 行高 19.8 | `borderRadiusSM` + `fontSizeSM` |
| `Button size="small"` | 高 **21** · padding `0/7` · 圆角 4 · 字号 12 | `controlHeightSM` |
| `Button type="text"`（图标） | **21 × 21** · padding 0 | 同上 |
| `Badge status` 圆点 | **5.5 × 5.5** | antd 默认 |
| `Badge status` 文本 | 字号 12 · 左间距 **4** | `marginXS` |
| `Switch size="small"` | **24 × 14**，手柄 10 × 10，圆角 100px | `controlHeightSM` 系 |
| `InputNumber size="small"` | 高 **21.6** · padding `0/7` · 圆角 4 | —— |
| `Collapse` 头 | 高 **28** · padding `4/8/4/4` · 字号 12 · 展开图标 **11 × 20** | 头高 = `controlHeight` |
| `Card` body | padding **12** · 圆角 **8** · 边框 `0.8px colorBorderSecondary` | `borderRadiusLG` |
| `List` item（含 `size="small"`） | padding `4/12` | ⚠️ 见 §5，`List` 已废弃 |
| `MonoText` 内 `code` | 字号 **10.2** · padding `2.04/4.08/1.02` · 圆角 3 · 底色 `rgba(150,150,150,.1)` | ⚠️ **全页最小的字**，见 §4 |
| 浮动「回到最新」按钮 | 高 **28**（`shape="round"`） | `controlHeight` |
| 浏览器滚动条 | 15（未自定义） | —— |

## 4. 结构几何（实测）

| 项 | 实测值 | 说明 |
|---|---|---|
| 固定区总高 | **52** | facts-bar 单行 + 「原始输出」折叠入口 |
| 轮次左槽宽 | **64** + 右侧 padding **8** | ⇒ 与右内容间距 **24** |
| 轮次内块间距 | **8**（`marginSM`） | 块与块之间 |
| `rowEvents` 行距 | **4**（`marginXXS`） | 事件条目之间 |
| 滚动容器 | 占满剩余高度（`flex: 1` + `minHeight: 0`） | 见 §6 |

## 5. antd 6 的 API 变更（spec 现有写法已过时）

实测控制台直接报废弃警告，**spec §9.6 / §6.8 的写法需改**：

| spec 现写 | antd 6 实际 | 处置 |
|---|---|---|
| `List`（§9.6「计划清单面板」「问答卡片」用 `List`） | **已废弃**，警告原文：「The `List` component is deprecated and will be removed in the next major version. If you're using version 6.6.0 or later, please use `Listy` instead.」 | 改 `Listy`（`antd/listy`，已确认存在） |
| `Drawer width={...}`（§5.1 / §6.8 的几何） | **已废弃**：「`width` is deprecated. Please use `size` instead.」`size?: 'default' \| 'large' \| number \| string` | 改 `size="max(50vw, 800px)"` / `size="min(42vw, 640px)"`（`size` 收 string，可直接给 CSS 表达式） |
| `maskClosable`（§6.8 的 mask 口径） | **已废弃**：「Please use `mask.closable` instead」 | 改 `mask={{ enabled: true, closable: true }}` |
| `Divider orientation="left"` | **已废弃** | 改 `titlePlacement="start"` |
| `Segmented multiple`（§9.6 的过滤控件备选） | **不支持多选**（`SegmentedValue = string \| number`） | 用 `Tag.CheckableTag`（§9.6 本来就写了这个备选） |
| —— | **`Listy` 直接把虚拟滚动做进来了** | 见 §7，可能免掉 `@rc-component/virtual-list` 依赖 |

## 6. 「内嵌场景」的一个真实陷阱（实测，必须写进 spec）

**现象**：把本页嵌在根 `Providers` 之下、用自己的 `ConfigProvider` 换成暗色时，
`Card` / `Tag` / `Button`（读 token 的组件）颜色**正确**，
但**所有靠继承拿颜色的文字变成近黑**，落在暗底上**对比度 1.0（完全不可读）**。

**根因链**（逐层实测）：

| 节点 | `color` |
|---|---|
| `.ant-app`（根 `Providers` 的 `<App>`，带的是**外层**主题类名） | `rgba(0,0,0,.88)` |
| 页面容器（只是 `div`，无 color 声明） | `rgba(0,0,0,.88)`（继承自 `.ant-app`） |
| `html` / `body` | `rgba(255,255,255,.85)`（`--app-fg`，**已是暗色**） |
| 同一页的 `.ant-card` | `rgba(255,255,255,.85)`（正确，因为它自己有类） |

⇒ **`html`/`body` 是暗的，`.ant-app` 把外层亮色的正文色注入到继承链里**，
内层 `ConfigProvider` 只换了 CSS 变量，换不掉那个已声明的 `color`。

**修法**：组件必须在**自己的根节点**上显式声明 `color: token.colorText`
与 `background: token.colorBgLayout`，不能只依赖 `ConfigProvider`。

**对 spec 的含义**：§2.1 场景 S1（内嵌只读视图）必须写明这一条。
否则把 `agent-log` 嵌进宿主页面时会出现「组件正常、正文发黑」的怪状，
而它**在 jsdom 里完全测不出来**（jsdom 不做真实级联）。

## 7. 对比度实测（WCAG，含 alpha 合成）

### 暗色（底色 `rgb(20,20,20)`）

| 元素 | 前景 | 对比度 | 判定 |
|---|---|---|---|
| 正文（`colorText`） | `rgba(255,255,255,.85)` | **13.4** | ✅ 远超 AA |
| `Tag(default)`（底 `#272727`） | `rgba(255,255,255,.85)` | **11.17** | ✅ |
| `MonoText` 内 `code` | `rgba(255,255,255,.85)` | **13.55** | ✅（但**字号只有 10.2**） |
| `Typography secondary` | `rgba(255,255,255,.45)` | **4.52** | ⚠️ 刚过 AA（4.5），**几乎无余量** |
| `Switch`（选中，底 `#1668dc`） | 手柄 | **5.19** | ✅ |

### 亮色

| 元素 | 前景 | 底色 | 对比度 | 判定 |
|---|---|---|---|---|
| 正文 | `rgba(0,0,0,.88)` | `#fff` | **16.56** | ✅ |
| 正文（在 Card 上） | `rgba(0,0,0,.88)` | `#f5f5f5` | **15.39** | ✅ |
| `Typography secondary` | `rgba(0,0,0,.45)` | `#fff` | **3.35** | ❌ **低于 AA 4.5** |

### 语义状态色（**全部低于 AA 4.5，这是本轮最要紧的发现**）

字号均为 **11px**（Tag）/ 12px（Typography），底色是 antd 给的淡色底。

| 元素 | 前景 | 底色 | 对比度 |
|---|---|---|---|
| `Tag warning`「1 项状态未知」 | `rgb(250,173,20)` | `rgb(255,251,230)` | **1.83** |
| `Tag success`「完成 2」 | `rgb(82,196,26)` | `rgb(246,255,237)` | **2.21** |
| `Typography success`「评分 8/10」 | `rgb(82,196,26)` | `#fff` | **2.27** |
| `Tag gold`「推荐」 | `rgb(212,136,6)` | `rgb(255,251,230)` | **2.76** |
| `Tag error`「失败 1」 | `rgb(255,77,79)` | `rgb(255,242,240)` | **2.99** |
| `Tag processing`「进行中」 | `rgb(22,119,255)` | `rgb(230,244,255)` | **3.66** |

**根因**：`fontSizeSM: 11` 的紧凑密度让字形变小、笔画变细，而 WCAG 的阈值不变
⇒ **同样的色板在紧凑密度下更容易不达标**。antd 的预设语义色板本身是按 14px 调的。

**处置口径（写进 spec）**：状态色**不得只靠颜色传达信息**——必须同时有文字
（本设计本来就是这么做的：`Tag` 里始终有中文，不是纯色点）。
对比度不足是**已知取舍**，理由是：① 这是紧凑密度的既定口径，全站一致；
② 信息不依赖颜色（色 + 字双通道）；③ 改色板会与全站其它页面不一致。
**但 §6.7 的「进行中」动效不得作为唯一信号**，因为 `Tag processing` 只有 3.66。

## 8. 未取到 / 无法验证的项（如实登记）

| 项 | 原因 |
|---|---|
| 环境抽屉的几何 | 该抽屉在预览页里由按钮触发，本轮未展开测量（`push` / `size="min(42vw,640px)"` 待实测） |
| `Alert` / `Skeleton` / `Empty`（`EmptyState`）的间距 | 预览页里只摆了元素、未逐个测量 |
| `Descriptions` 的标签列宽 | 同上 |
| 虚拟滚动的真实几何（展开面板后下方轮次不跳） | 预览页用的是普通滚动容器，**没有**接虚拟列表；spec §7.2 的那条冒烟项仍未验 |
| 2 位以上有效数字的颜色值 | 部分取自 `getComputedStyle` 的字符串，未做色彩空间换算 |
