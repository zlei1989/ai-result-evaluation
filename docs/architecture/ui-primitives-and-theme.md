# 界面原语与主题

## 定位

`@aieval/ui` 用三类东西搭界面：**vendored 原语**（`src/components/ui/`，shadcn registry 的产物，只做说明符改写）、**Tailwind 语义类**（颜色 / 字号 / 间距全部来自 `apps/web-next/app/globals.css` 的主题与密度变量）、以及包在两者之上的本仓原语与功能组件。包对外只暴露纯展示件：不调接口、不依赖路由库，props 进、JSX 出，`ui → contracts` 是唯一内部依赖边。界面同时适配 `light` / `dark` 与弹性尺寸，窄视口降级见「形态与交互」的 `ListDetailLayout` 段。

主题与密度各只有**一处真源**，组件不持有第二份：明暗是 `html[data-theme]` 属性，密度是最近的 `[data-density]` 祖先。因此不存在「组件亮了、底色还是暗的」这种半亮状态——没有第二处可不同步。

页面长什么样只由**组装层**决定：主题层（`globals.css` 的语义变量）给变量、原语层（`components/ui/**`，registry 产物）给结构、组装层（`base/`、`composite/` 与 `app/**` 的页面骨架）决定页面。原语层不承载业务外观，组装层不重写原语的外观。

## 形态与交互

**四层组织**：

- `src/components/ui/`：vendored 原语（Button / Card / Dialog / Sheet / Select / Tabs / Table / Input / Textarea / InputGroup / Attachment / Collapsible / Field / MessageScroller / Trace / CodeBlock …）。结构照上游，本仓只在说明符层面改写；换合并库只改 `src/lib/utils.ts` 的 `cn` 一处。
- `src/base/`：单一职责原语（PageShell、PageHeader、ListDetailLayoutgit、DataTable、VirtualList、drawer-geometry、app-theme、stored-preference、toast、Hint、EllipsisText、MonoText、EmptyState、Toolbar、RowStatusTag、MetricLine、ContextWindowTag、XMarkdownText 等）。
- `src/composite/`：面向功能块的组装（`AppTopNav`、`cases-table`、`run-*`、`provider-*`、`mcp-*`、`rubric-*`、`agent-log/` 全家、命令面板、设置屏几件）。
- `src/testing/`：jsdom 桩（`ResizeObserver` / `matchMedia` / 滚动几何），只给用例用；`src/dev/ui-probe.tsx` 是原语矩阵的真机验收页。

**原语层逐字不动**：`src/components/ui/` 是上游 registry 产物，字号、颜色、圆角、边框、阴影都不在这里改。要变外观：优先传布局类（宽高 / 对齐 / 间距）或改组装层；确有依据的适配（去掉上游滚动特效、补焦点环）必须同时跑 `node scripts/vendored-manifest.mjs` 更新哈希清单并在提交说明里写理由——`components/vendored-manifest.test.ts` 会把任何未登记的改动判红。页面骨架用 `PageShell` / `PageHeader` / `ListDetailLayout` / `DataTable` 这些出口组装，不手写裸 `div` 拼布局。

**颜色只用语义 token**（`background` / `foreground` / `muted-foreground` / `border` / `card` …）。**没有品牌色**：`--primary` 就是墨黑（dark 为近白），主操作、选中、进度与图表柱都用它；层级靠字号、字重、间距与发丝边框建立，不靠色相。`success` / `warning` / `info` / `destructive` 只标状态，不做装饰；图表走 `--chart-1..5` 的中性阶。唯一的第二处例外是 `base/row-status-tag.tsx` 的十种行状态色：它们靠色相区分十种状态，集中在一张映射表里；加状态只改表，不把调色板类散到调用点。

**页面标题区**：`PageHeader` 是三个主页面的唯一出口——标题 `text-2xl font-semibold tracking-tight`、描述 `text-sm text-muted-foreground`、动作靠右；它**不跟密度档**（密度管正文与行高）。不许给页标题挂密度字号（`text-title`）。理由：页标题一旦压到正文同号，整页失去视觉重心；标题层级只由这一处决定，页面不再各写一份 `<h1>`（守卫 `apps/web-next/src/page-header.test.ts`）。

**表格铺满容器**：`DataTable` 的表宽默认等于列宽之和；页面级列表传 `fillColumnId`（主标识列吃掉容器余量）。余量在**列定义**层加，不在 `<table>` 的宽度样式上加——`getStart()`、`<colgroup>` 与单元格宽度都读 `column.getSize()`，只改表格宽度会让固定列偏移与真实列宽错位。容器比列宽之和还窄时保持声明宽度并横向滚动；宽屏下不许只占左侧一段、右边留出死区。

**空态不拉满整栏**：`EmptyState` 固定 `flex-none`（vendored `Empty` 自带 `flex-1`），不要在纵向 flex 里把空态撑满再垂直居中；空态高度不随视口增高。

**页面骨架的高度链**：`html` / `body` 的 `height: 100%` → `PageShell` 的 `h-full` + `min-h-0`。`PageShell` 是页面根的唯一出口，无条件写 `min-h-0`（纵向主轴默认 `min-height: auto`，内容撑开时页面根收缩不到 flex 分配的高度，整页会被顶出顶栏那一截、内部滚动随之失效）。顶栏是 `PageShell` 的兄弟节点，显式 `height: 56`（shadcn 的 h-14）+ `flex-shrink: 0`：不写死高度时它的百分比高度与 flex 收缩会让它随视口浮动。**没有组件库的根节点承担这一段**——`Providers` 里没有任何 Provider 壳，`Toaster` 不产出包裹节点。

**`PageShell` 的四条不变量**：纵向 flex 根 + `w-full` + `min-w-0` + `h-full`；刻意不设 `items-*`（纵向 flex 的交叉轴是水平方向，`items-start` 会让子元素不横向拉伸）；`padding` / `gap` 默认不落类，显式传入时只落密度间距档（`p-page` / `gap-page`）；`data-density` 无条件写（属性不在，整页落回 `:root` 的紧凑档）。

**`ListDetailLayout`**（列表 + 可拖拽右栏的唯一出口）用 `react-resizable-panels` 的 `Group` / `Panel` / `Separator`：

- `Panel` **没有受控 `size`**，宽度由库维护（拖拽、键盘、双击复位），外部只能 `panelRef.resize(px)` 命令式写回。存量值、右栏重新出现、视口变化都按规划出的**像素**写一次——按比例送会随窗口宽漂移。
- 详情栏声明 `groupResizeBehavior="preserve-pixel-size"`：窗口变宽变窄时它保持像素宽，列表栏吃掉变化；`maxSize` 不每帧改（改 max 会触发约束重算，把像素意图冲成比例）。
- `Separator` 自带双击复位；`onResize` 的 `inPixels` 是像素宽唯一可靠来源，落盘只在 `isUserInteraction` 为真时做（窗口缩放导致的夹紧不是用户意图）。
- 右栏显示条件是 `detailOpen` **且** `detail` 非空——只判开关会渲染一条空栏；`PANE_PADDING`（= 8）与 `PANE_SEPARATOR_WIDTH` 是几何常量，不各写一份。

**窄视口降级**：`ListDetailLayout` 在 `(max-width: 1279px)` 下默认把详情放进 `Sheet` 覆盖层（`narrowDetail="overlay"`），列表保持整宽——并排在 1280 以下会把列表压到六列表格的列宽之和（770）以下，只能横向滚动。覆盖层自带标题栏与「关闭详情」，关闭走调用方的 `onRequestCloseDetail`，布局本身不改 `detailOpen`。存量栏宽只在并排模式下有意义，覆盖模式下不读也不写。

**`DataTable`**（TanStack Table v9 headless + 行虚拟化）：固定的唯一输入是列定义里的 `size`——TanStack 的固定列偏移算声明宽之和而非 DOM 实测，钉住的列缺 `size` 是静默错位，组件在渲染前直接抛错；行虚拟化以固定行高为前提，调用方必须给**有界高度**（否则滚动容器按内容撑开，虚拟化只剩空转）；滚动只由这一层容器承担且是 `overflow: auto`（空表不挂常驻滚动条）。列显隐 / 排序 / 行选择默认关闭。

**`VirtualList`** 是 `useVirtualizer` 的**唯一持有者**：量不到高度（jsdom 的 `clientHeight === 0`、环境无 `ResizeObserver`）就退化为全量渲染、不抛错；宿主必须是有确定高度的 flex 子项，否则静默地不虚拟化。

**抽屉几何**（`base/drawer-geometry.ts`）：主抽屉与二级抽屉各一档，**数值只写在全局样式**（`--drawer-main-width` / `--drawer-nested-width` / `--drawer-nested-give-way`），组件只引用变量。主抽屉恒宽于二级（61vw、下限 800px 对 60vw、上限 900px）；二级层打开时主抽屉的让位读 `--nested-dialogs`（Base UI 每开一层加一），不写死像素距离。三处抽屉壳与二级层都走 Base UI `Sheet`。

**正文渲染**（`base/x-markdown.tsx`）：`streamdown` + `Code Block` + `Typeset`。四条口径——原始 HTML 只挂 `sanitize` + `harden`（不挂 raw 插件，标签转义成看得见的字面量）；`open` 必填且是「这一块还没收尾」的唯一判据（翻成 `isAnimating` 只有那一行）；围栏代码块不折行（超宽横向滚动）；`h1` → `<h4>`、`h2`–`h6` → `<h5>`。正文根的稳定钩子是 `data-slot="markdown"`。

**输入区**是 Prompt Input 形态：一个 `InputGroup` 里装 `InputGroupTextarea`，附件清单在 `block-start` 的 addon（每份带移除键），「添加附件」与「发送」在 `block-end` 的 addon。两个入口（运行中的人工消息、跑完后的追问）共用 `composer-input.tsx` 的状态机与形态，各自只决定「这句话怎么发出去」；附件不往任何别处传，落盘走调用方的 multipart 回调。

**禁用态必须说清原因**：`Hint` 是唯一壳——提示挂在**包住控件的真实元素**上，禁用按钮自己收不到鼠标事件；`TooltipProvider` 的打开延迟压到 0。

**布局验收读几何**：960 / 1440 / 1920 三档下读 `getBoundingClientRect()`，主内容宽度 ÷ 容器宽度 ≥ 90%，空态高度不随视口增高。截图只作留档，不作判据。

## 界面文案

界面是中文、给做 AI 编码选型的工程师看，而且**人常常不在场**：一次评测跑几十分钟，回来看的是「发生了什么、该点什么」。因此文案按下面四组规则写，风格偏好一律让位于这四组。

**一个概念一个词**。同一个东西在全局只有一种叫法，量词也钉住：

| 概念 | 界面用 | 不用 |
|---|---|---|
| 被评测的题面 | 用例 | 案例、测试用例 |
| 一次评测 | 评测（量词：**次**，「这一次评测」） | 用「轮」数评测 |
| 模型一次 API 往返 | 轮次 / 本轮 | ——（「轮」只此一处，见 `GLOSSARY.md` 的「段」） |
| 模型 × 智能体 的那一条 | 候选 | 行、候选行（`EvalRow` 是内部名） |
| 跑在候选里的执行体 | 智能体 | 中文句子里夹 `agent` |
| 可被装入的技能 | 技能 | 中文句子里夹 `skill` |
| 候选产出的代码差量 | 变更 | 改动、`diff`（`diff 上限` 是体积预算这个旋钮的专名） |
| 相对位置 | 名次 | 排序；「排名」只作视图名（按钮 / 抽屉） |
| 评测的起点提交 | 基线提交 | commit（`基线` 与契约 `baselineCommit` 同词） |
| 工作区落盘根 | 工作区根目录 | 工作基目录 |
| 行状态 `pending` | 待开始 | 未开始 |
| 缓存读入的 token | 缓存命中 | 缓存读 |

**动作键写动作**。`ConfirmDialog`（`base/` 与 `composite/` 两份）的 `confirmLabel` 是**必填**，写被执行的那个动作（「删除这次评测」「终止」「重新评分」），不写「确定」「确认删除」——笼统的确认键在「终止这一行」与「删除这一次评测」上长得一模一样，用户只能回读标题才知道按的是什么。缺省值一旦存在，新调用点就会照抄它。同理，解释某颗按钮的浮层文案必须叫出**界面上真实存在的那个名字**（按钮叫「开始执行」，浮层就不能写「点『开始』」）。右栏表单的提交键另属一类：它提交的是整张已经写明动作的表单，标签固定按模式分两态（新建「确定」/ 编辑「保存」），不随标题改写。

**四态分开写**。首次使用给下一步动作（「先创建一个用例，再新建一次评测」）；过滤后为空说是过滤造成的；读失败说清**哪一份**没读到、服务端中文原因、以及恢复路径（「刷新页面会重新请求」）——SWR 读失败时保留上一份数据，只报「加载失败」而列表还在，读起来像「加载成功但内容没变」；未就绪说清缺哪个前提、去哪儿补（「设置页还没有配置默认评分智能体」+ 去哪儿配）。

**错误三段式**：什么失败了（点名对象）→ 为什么（服务端中文原因原样透出，不知道就不写）→ 现在能做什么。归因码（`AGENT_FAILED` 这类）照旧上屏——团队按报错原文 grep，`docs/faq/` 就是这么索引的——但排在中文原因**之后**（`中文原因（CODE）`），它回答不了「发生了什么」。

`tok`、`MCP`、`HEAD`、`schema`、`JSON` 是这一行的行话，不译；产品名在 `PRODUCT.md` 里仍是未决项，别在界面里替它选一个。

## 数据与契约

- 原语接口契约 = 「props 表 + 尺寸口径 + 偏好记忆口径」三件套；composite 面板收的全是 contracts 类型。
- `ui → contracts` 是唯一内部依赖边。`@aieval/client` 用 `export type … from '@aieval/ui'` 转出界面类型——**类型转出不算依赖边**（编译期即被抹掉），只允许 `export type`，写成值导出就真有运行时依赖，得回来改依赖方向表。
- 个人偏好分两处存：URL 记「在看什么」（`?panel=` / `?id=`），localStorage 记「怎么显示」（栏宽、开关）。`useStoredWidth` **挂载后再读**（首帧读会产生水合不一致），读取路径绝不抛错（SSR / 隐私模式 / 脏值一律回落默认）。
- 任何非法输入都要有可读兜底，绝不让 `NaN` / `Invalid Date` 上界面（`formatBytes` / `formatDateTime` / `shortHash`）。

## 机制与演化

**明暗单一真源**：`useResolvedTheme({ preference })` 只写两个属性——`data-theme`（解析后的 `light` / `dark`，SSR 由 `<html data-theme="dark">` 兜底、不闪白）与 `data-theme-preference`（偏好原值，`auto` 要能区分出来）。偏好来自设置（`GET /api/settings`），`auto` 走 `matchMedia` 即时跟随系统。需要布尔的消费方读 `useAppliedThemeMode()`（`useSyncExternalStore` 订阅 `data-theme`），**不再自行解析一次**。主题唯一入口在设置页。

**颜色变量的两层名字**：`globals.css` 的 `:root` / `[data-theme='dark']` 给出语义变量（`--background` / `--foreground` / `--card` …），`@theme inline` 把它们映射成 Tailwind 的 `--color-*`。于是工具类 `bg-background` 落地成 `var(--background)`，手写 CSS 读 `var(--color-background)`——**改一个颜色要两处名字都对上**。`--app-bg/-fg/-border/-muted/-selected` 是给内联 style 与动画类留的别名，值一律指回语义色。

**密度**：`PageShell` 写 `[data-density]`，缺省 `compact`，设置页豁免 `default`。字号 / 行高 / 间距只从作用域变量取（`text-body` / `text-sub` / `leading-body` / `gap-*` / `p-page`），组件里**不手写 `fontSize` 或行内 padding**——手写会把那一格从密度档上摘下来，切档时不跟随，而且没有用例会红。密度只管正文、行高与间距；页标题、区块标题、卡片标题的字号不跟密度档。两档变量都写全：只写一档时，嵌套的另一种密度壳会继承外层值，两档齐全才是「最近一层赢」。

**Tailwind v4 从源文本抽候选，注释也算**：它在被 `@source` 覆盖的源文件里按**原始文本**找类名，注释里的字面量同样算数；`node_modules` 不在扫描范围。后果：上游组件硬编码的类（例如 `Streamdown` 根上的 `space-y-4`）在产物里本来**不生成**，一旦把它照抄进注释「说明上游用了什么」，那条 utility 就会**真的出现**并参与层叠。所以注释里别写 utility 类名；要说明上游行为时用代码块以外的措辞。判据：`grep` 构建产物里有没有那个选择器。

**`@layer` 顺序的坑**：`globals.css` 声明 `@layer theme, base, components, utilities`。密度变量块**必须写在层外**（文件顶层，不在任何 `@layer` 里）：Tailwind 的默认主题变量输出在 `@layer theme`，层内声明永远输给层外的声明，写进 `@layer base` 也会被 `theme` 反超——尺寸静默变回 Tailwind 默认值，浏览器不报错。

**跳过 preflight 的补偿**：管线只引 `tailwindcss/theme.css` 与 `utilities.css`，不引 `@import "tailwindcss"` 展开出的 preflight——那层全局复位（`*` 的 `margin` / `padding` / `border`、标题与表单控件的字号继承）会连带改掉原生元素与 vendored 原语的默认度量。代价是 preflight 自带的两条基础复位要自己补：

- `* { box-sizing: border-box }`；
- `[hidden] { display: none !important }`：UA 对 `[hidden]` 只给一条 `display: none`，作者样式里任何 `display`（本仓大量元素带 `flex` / `grid` 类）都会盖掉它 ⇒ 写了 `hidden` 仍然显示。Base UI 的页签面板靠这个属性隐藏非活动页签（`Tabs.Panel keepMounted`），缺了它三个面板会同时铺开。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| jsdom 没有 CSS 级联与布局 | 硬边界 | 字号实效、省略号、拖拽、`[data-density]` 切换后的真实度量都只能在真机量（读 `getBoundingClientRect` / `getComputedStyle`）；单测只钉可计算的几何与结构属性 |
| 虚拟化在 jsdom 里退化 | 有意 | `clientHeight === 0` 时全量渲染：用例数得到全部内容，但虚拟化本身测不到；真机冒烟看「已渲染 N」锚点 |
| `.tsx` 测试只能在库包写 | 硬边界 | `apps/web-next` 必须留 `jsx: preserve`（Vite 的 import-analysis 会拒绝），应用内测试一律 `.ts` |
| 颜色变量有两个名字 | 现状 | `--color-*`（手写 CSS 用）与 `--*`（工具类落地用）同源但不同名，改颜色两处都要对 |
| 密度块必须写在层外 | 硬约束 | 写进任何 `@layer` 都会被 `@layer theme` 的默认值反超，症状是切到宽松档无效且无报错 |
| 主题没有 Provider | 现状 | 只认 `html[data-theme]`；不要在 `Providers` 里重新引入一层主题上下文，那等于开第二处真源 |
| `streamdown` 的 `tailwind-merge` | 现状 | 由 pnpm `overrides` 别名到仓内 `cn`（`clsx` 沿用树里已有的版本） |
| 真实拖拽不可达 | 硬边界 | jsdom 容器尺寸为 0；`ListDetailLayout` 的 `onResize` 回写要在真实调用方处钉 |

## 相关链接

- [冒烟测试方法论](/guard/smoke-testing) —— 几何断言与真机验收；[测试策略与提速](/guard/test-strategy) —— jsdom 缺口与 `.tsx` 测试的边界
- [工具链与命令聚合](/architecture/toolchain) —— vendored manifest 脚本、构建与依赖口径
- [分层与依赖方向](/architecture/layering) —— `ui → contracts` 边与装配侧职责
- [契约体系](/architecture/contracts) —— 界面吃的领域类型来源
- [《用例管理》](/features/case-management)、[《评测详情与候选行》](/features/run-detail)、[《设置》](/features/settings) —— `ListDetailLayout` 的消费方、主题唯一入口
