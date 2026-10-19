---
name: AI 代码评测
description: 同一个起点、同一把尺子的 AI 编码评测台账
colors:
  primary: "oklch(0.205 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  border: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  success: "oklch(0.627 0.17 149.2)"
  warning: "oklch(0.57 0.15 60)"
  info: "oklch(0.623 0.188 255.5)"
  destructive: "oklch(0.577 0.245 27.325)"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.6667
  sub:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.6667
  mono:
    fontFamily: "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, Courier, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.6667
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  "2xl": "18px"
spacing:
  hair: "4px"
  tight: "4px"
  snug: "8px"
  roomy: "16px"
  page: "8px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "0 10px"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 10px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "16px"
---

# Design System: AI 代码评测

## Overview

**Creative North Star: "实验台账 / The Lab Ledger"**

这是一本给同行复核的实验记录本，不是仪表盘。每一轮评测是一件有编号的台账：同一个起点、同一把尺子、逐项「达成 / 未达成 + 一句理由」。界面把注意力让给数字、状态与证据，装饰只做两件事——分隔信息、标出当前选中的那一行。密度高是刻意的：使用者一次要扫十几轮、几十分项，留白只出现在能帮助分组的地方。

没有品牌色。主色就是墨黑本身（暗色下翻转成近白），强调靠字号、字重、间距与发丝边框建立；颜色只承担语义（背景、文字、边框、状态）。这套系统从 shadcn 的中性骨架长出来，但比默认更克制：不引入第二支色相，也不靠色块与阴影制造层级。

深度是平的：卡片与抽屉靠 1px 边框和底色分层；阴影只属于真正浮在页面之上的层（抽屉、浮层、对话框）。任何在静止卡片上加阴影的做法都会让长列表变吵。

**Key Characteristics:**
- 纯中性灰阶，没有品牌色
- 平面 + 发丝边框；阴影只给浮层
- 13px 正文的紧凑密度（设置页放宽到 14px）
- 页标题 24px / 600，与正文拉开两档
- 状态色只标状态；图表也走同一支中性阶

## Colors

中性灰承担几乎全部表面与文字层级。没有品牌色——强调来自对比，不来自色相。

### Primary
- **墨黑 Ink** (`oklch(0.205 0 0)`, light)：主按钮、选中行左条、进度条、排名图柱。白字对比 14.9:1。
- **反白 Paper Inverse** (`oklch(0.922 0 0)`, dark)：暗色主题下的主色；深色字 13.4:1。

### Neutral
- **纸白 Paper** (`oklch(1 0 0)`)：页面与卡片底色（light）。
- **墨黑 Ink** (`oklch(0.145 0 0)`)：正文与标题（light）；dark 下翻转为 `oklch(0.985 0 0)`。
- **批注灰 Annotation** (`oklch(0.556 0 0)`)：次级文字、说明、时间戳；白底 4.7:1。
- **发丝灰 Hairline** (`oklch(0.922 0 0)`)：1px 分隔线、卡片边框、表格线。
- **聚焦灰 Ring** (`oklch(0.708 0 0)`)：键盘焦点环。

### Status
- **达成绿 Success** (`oklch(0.627 0.17 149.2)`)：只标成功与达成。
- **警示橙 Warning** (`oklch(0.57 0.15 60)`)：未出分、部分完成、待处理。
- **信息蓝 Info** (`oklch(0.623 0.188 255.5)`)：中性提示、进行中。
- **失败红 Destructive** (`oklch(0.577 0.245 27.325)`)：失败、删除、终止。

### Named Rules
**The No-Accent Rule.** 没有品牌色。需要强调时先加字重、字号或间距；颜色是最后手段，且只用语义色。

**The Status-Only Rule.** success / warning / info / destructive 只标状态，永不做装饰底色或品牌强调。

## Typography

**Display / Title Font:** `ui-sans-serif, system-ui, sans-serif`（无自定义字体；跟随系统）
**Body Font:** 同族
**Mono Font:** `SFMono-Regular, Consolas, 'Liberation Mono', Menlo, Courier, monospace`

**Character:** 系统无衬线的中文正文，配等宽体承载标识符、diff 与日志。没有一套「品牌字体」——这是台账，不是海报；字重与字号差就是层级。

### Hierarchy
- **Title** (600, 1.5rem / 24px, 1.25)：页面标题，`PageHeader` 专用，不跟密度档。
- **Section** (600, 0.875rem–1rem)：卡片标题、抽屉标题、表单分组标题。
- **Body** (400, 0.8125rem / 13px, 1.6667)：表格正文、卡片正文、表单值（紧凑档）。
- **Sub** (400, 0.75rem / 12px, 1.6667)：说明、时间戳、表头、徽标文字。
- **Mono** (400, 0.75rem)：commit、分支、文件名、事件原文、diff。

### Named Rules
**The Two-Step Rule.** 页标题必须比正文大两档（24 / 13）；卡片与区块标题至少比正文大一档。标题与正文同号会让整页失去重心。

**The No-Handwritten-Size Rule.** 正文字号与间距只从密度档取（`text-body` / `text-sub` / `gap-snug` / `p-page`）；组件里手写 `font-size` 或行内 padding 会把那一格摘出密度档。

## Layout

- **外壳**：顶栏（56px，sticky）+ 页面壳（吃满剩余高度，`p-page` 8px）。
- **主形态**：列表 + 可拖拽右栏。`ListDetailLayout` 在 1280px 以下把右栏整体收进 `Sheet`（覆盖式，列表保持整宽）；桌面右栏默认 420px，双击分隔条复位。
- **表格**：页面级列表必须铺满容器——`DataTable` 的 `fillColumnId` 把剩余宽度给主标识列；列宽之和大于容器时横向滚动，不缩列。
- **密度**：默认紧凑档（正文 13 / 次级 12 / 标题 14；间距 4 / 8 / 16），设置页放宽（14 / 13 / 16；4 / 8 / 12 / 20）。两档都写在 `[data-density]` 作用域里。
- **抽屉**：主抽屉 `max(61vw, 800px)`；二级抽屉 `min(60vw, 900px)`；二级打开时主抽屉左移 20vw 让位。

## Elevation & Depth

平面系统。表面之间靠 1px 发丝边框与底色差（background / card / muted）分层，静止卡片没有阴影。阴影只属于浮层：Sheet、Dialog、Popover、Toast，由 vendored 原语统一给出。

### Named Rules
**The Flat-At-Rest Rule.** 卡片、表格、面板在静止态一律无阴影；需要「浮起来」时，它应该真的浮在页面上（抽屉 / 浮层），而不是靠阴影伪装。

## Shapes

- 圆角：`--radius: 0.625rem`（10px）为基准，`sm 6 / md 8 / lg 10 / xl 14 / 2xl 18`。
- 按钮与输入用 `md`（8px）；卡片与面板用 `xl`（14px）；抽屉用 `2xl` 一侧。
- 徽标是胶囊（`rounded-full`），但只有状态类徽标；计数与标签用 `rounded-md`。
- 边框恒为 1px；不用 2px 装饰边框（选中条是 2px 的功能信号，不是装饰）。

## Components

### Buttons
- **Shape:** 8px 圆角；默认高 32px，`sm` 高 28px。
- **Primary:** 墨黑底 + 近白字（dark 反转）；每屏最多一个。
- **Outline:** 透明底 + 发丝边框；次级动作。
- **Ghost:** 无边框，hover 才出现 `muted` 底；最低权重（重跑、重评、追问）。
- **Focus:** 2px ring + 3px 半透明光晕，颜色取 `--ring`。

### Cards / Containers
- **Corner Style:** 14px。
- **Background:** `card`；嵌套面板用 `muted`。
- **Shadow Strategy:** 无（见 Elevation）。
- **Border:** 1px `border`。
- **Internal Padding:** 16px（`p-roomy`）。

### Inputs / Fields
- **Style:** 1px `input` 边框，8px 圆角，高 32px，`background` 底。
- **Focus:** 边框转 `ring` + 3px 半透明光晕。
- **Error / Disabled:** 错误用 `destructive` 边框与文案；禁用降透明度，不禁用可读性。

### Navigation
- 顶栏 56px，sticky，`card` 底 + 1px 下边框。
- 当前项：`muted` 底 + `foreground` 字 + 500 字重；非当前项 `muted-foreground`。
- 图标 16px，与文字 6px 间距；图标 `aria-hidden`，语义由文字承担。

### Table
- 表头 `sticky`，12px `muted-foreground`，字重 400。
- 行高 40px；行是可聚焦按钮（Enter / Space 打开）；选中 = `muted` 底 + 首列 2px 主色条；焦点 = 2px `ring`。
- 数值列右对齐? 否——本仓数值列左对齐，用 `tabular-nums` 对齐位数。

## Do's and Don'ts

### Do:
- **Do** 用墨黑/近白的主色标「主操作 / 选中 / 进度 / 图表柱」，一屏不超过一处主操作。
- **Do** 让页标题保持 24px，正文走密度档（13 / 12）。
- **Do** 用 1px 边框和底色差分层，浮层才给阴影。
- **Do** 用 `tabular-nums` 让分数、tok、时间按位对齐。
- **Do** 让状态色只出现在状态上，并同时给文字（不只靠颜色）。

### Don't:
- **Don't** 引入品牌色或第二支色相；需要区分时用字重、字号、间距或状态色。
- **Don't** 在静止卡片上加阴影。
- **Don't** 手写 font-size / 行内 padding 绕过密度档。
- **Don't** 用彩色图表；排名柱与主操作同一支中性阶。
- **Don't** 用阴影或圆角制造「层级」，层级应由字号与间距建立。
