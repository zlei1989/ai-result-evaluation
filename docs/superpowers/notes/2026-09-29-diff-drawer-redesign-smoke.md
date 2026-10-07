# 「变更详情」抽屉重设计 冒烟记录（2026-09-29）

**对象**：`docs/superpowers/specs/2026-09-29-diff-drawer-redesign-design.md`
**环境**：真实浏览器（Playwright + Chromium 真窗口，非 jsdom）→ `http://localhost:3083`；
被测数据是**真实的评测产物**，不是造的夹具。

- 轮：`d63d3da4-841d-45ef-8b05-aa6a47756e38`（`[新增功能]向行云需求添加关注人`，已完成）
- 行：`79ad8832-7e36-4074-a98c-361bee67675b`
- 工作区：`D:\export\runs\d63d3da4-…\rows\79ad8832-…\workspace`
- 基线：`8ae84f68b97d4c1facde4be3b21db9840ee7d878`
- 这一轮的改动恰好覆盖三样：4 个已改未提交 + 1 个未跟踪新文件

## 逐条结论

| # | 断言 | 期望 | 实测证据 | 判定 |
|---|---|---|---|---|
| 1 | 行卡片按钮叫「变更详情」 | 文案与位置都不变 | 可访问名快照：`查看日志 / 变更详情 / 重新执行 / 评分详情 / 重新评分`（第 2 位） | ✅ |
| 2 | 抽屉标题 | 「变更详情」 | `.ant-drawer-title` 文本 = `变更详情` | ✅ |
| 3 | 宽度 = `max(50vw, 800px)` | 1920 → 960；1430 → 800 | 视口 1920 实测 **960px**；视口 1430 实测 **800px**（下限生效） | ✅ |
| 4 | 窄屏不撑出屏幕 | 700px 视口下不溢出 | 视口 700：抽屉 **700px**、`left=0`、`right=700`、`overflowed=false`，关闭按钮 `x∈[0,700]` 可见 | ✅ |
| 5 | 内容区 `padding: 0` | 计算值 0px | `getComputedStyle(body).padding === '0px'` | ✅ |
| 6 | 高度自适应 | 随窗口变、吃满 header 之外的高度 | 视口 769 → 抽屉 769；视口 900 → 抽屉 900（等同视口高） | ✅ |
| 7 | 只有一个滚动容器 | 页面与抽屉都不出第二条滚动条 | body `overflowY=auto` 且 `scrollHeight(2611) > clientHeight(713)`；diff 正文块 `maxHeight:60vh` 自滚 | ✅ |
| 8 | 文件标题吸顶 | 下滚时当前文件标题停在容器顶部，且交接 | 逐步下滚实测：`top=0` 处**恰好一个**标题——scrollTop 400→文件1、900→文件2、1600→文件4（交接正确，不叠加） | ✅ |
| 9 | 正文惰性加载 | 首帧只拉索引；正文按文件单独拉 | 网络：`…/diff?offset=0&limit=30`（索引，无正文），随后 5 条 `…/diff?file=<urlencoded>`，每个文件一条 | ✅ |
| 10 | 索引不含正文 | 响应里没有 `text` | 索引响应体：`{files[5], total:5, offset:0, insertions:229, deletions:4, noBodyCount:0, truncated:false, droppedFiles:[]}` | ✅ |
| 11 | 未跟踪文件如实标注 | 新文件 `untracked: true` | 索引里 `OpenControllerWireKeysIntegrationTest.java` → `untracked:true`；CLI `git status` 同文件是 ` A ` | ✅ |
| 12 | **与 CLI 逐字一致**（最关键） | 抽屉正文 = `git diff` | 同一文件：CLI `git diff --no-color HEAD -- …FileChangeLogItemDTO.java` 的两处 hunk（`+ * @param agent …`、`- String aiCodeRatio` → `+ String aiCodeRatio,` `+ String agent`）与抽屉渲染出的行**逐字相同**。**⚠️ 这条当时是错的，见下方「第四轮」** | ⚠️ 已修正 |
| 13 | 计数与 CLI 对得上 | 5 个文件 / +229 −4 | 抽屉头部「共 5 个文件 · +229 −4」；CLI `git status --porcelain` 恰好 5 条（4 ` M` + 1 ` A`） | ✅ |
| 14 | 明暗主题下 diff 配色正确 | 跟随 `data-theme` | `data-theme=light` 时：正文 `rgba(0,0,0,0.88)`、新增行底 `rgba(46,160,67,0.15)`；语法高亮生效（Java 的 `*`/注解分色） | ✅ |

## 证据锚点

- 网络三条（Playwright 记录）：`?offset=0&limit=30` → 200；`?file=modules%2Flc-export%2F…java` → 200；其余 4 条 `?file=` 同样 200。
- 吸顶采样（滚动容器为 `.ant-drawer-body`）：
  `scrollTop 0 → 无`、`400 → 文件1`、`900 → 文件2`、`1600 → 文件4`、`1898(到底) → 文件4`。
- 几何采样：`{视口 1920×900 → 抽屉 960×900}`、`{视口 1430×769 → 抽屉 800×769}`、`{视口 700×800 → 抽屉 700×800}`。

## 两条**顺带发现**（不阻塞本 spec 的验收，已记入 ledger）

1. **`data-testid` 里嵌了文件路径，含 `.` / `/` 的路径会让 CSS 选择器失效。**
   本轮路径是 `…/FileChangeLogItemDTO.java`，`querySelector('[data-testid="diff-file-title-….java"]')`
   直接抛 `not a valid selector`（同理 `getByTestId('…java')` 在测试里也会抛）。
   现有单测用的是 `lib/a.ts`——`.ts` 在当前选择器实现下没触发，所以测试没红。
   **建议**：testid 改成按**下标**（`diff-file-title-0`）而不是路径。本轮没改，因为它超出了本次验收范围
   （spec 没规定 testid 形状），且改动会牵动 Task 7 的断言。
2. `dark` prop 在抽屉打开那一刻取值，之后切主题不会追进已挂载的抽屉；重新打开即正确。
   与「抽屉里是打开时看一眼的快照」的既有口径一致，spec §11 未要求实时跟随。

## 第二轮修订（2026-09-29，用户口径）

首轮验收通过后用户提了四条，其中第 4 条**是一个真 bug**，逐条记录：

| # | 口径 | 处置与证据 |
|---|---|---|
| 1 | 正文适配内容高度，**不显示右侧滚动条** | 去掉 `DiffContentViewer` 外层 `maxHeight: 60vh; overflow: auto` 包裹。实测：diff 内部 `overflow: auto/scroll` 的容器数 **0**，滚动条只剩 `.ant-drawer-body` 一条 |
| 2 | 文件路径**不用 Tag 包裹**，过长用省略号 | 标题改用 `EllipsisText`（省略号 + Tooltip 显全量），去掉 `<Tag>`（只有「未跟踪」仍用文字标签）。实测：`text-overflow: ellipsis` 生效、标题内 `.ant-tag` 数为 0 |
| 3 | 变更行数等信息**不能换行** | 标题 Flex 去掉 `wrap`，行数块加 `white-space: nowrap` 且 `flex-shrink: 0`。实测行数高 22px（单行） |
| 4 | **亮色主题背景问题** | 见下 §「亮色主题 bug」 |

### 亮色主题 bug（第 4 条）——根因与修复

**症状**：亮色主题下 diff 的表格底色是暗色（`rgb(46,48,60)`），新增行是浅绿底配**白字**，几乎读不出来。
但 antd 的 `data-theme` 明明是 `light`。

**根因**（`apps/web-next/app/runs/page.tsx`，本轮 Task 8 引入）：
页面为了拿 `dark` 又调了一次 `useResolvedTheme()`，而**没传 `preference`**；
`app-theme.tsx` 里 `rawPreference ?? 'dark'` 的兜底（本是给 SSR 不闪白用的）于是生效，
页面拿到的 `mode` 恒为 `'dark'`。两个后果：

1. diff 视图按暗色主题渲染，而 `ConfigProvider` 是明亮主题 ⇒ 半亮半暗；
2. `useResolvedTheme` 的 `apply` 副作用把 `html[data-theme]` 写回 `dark`，
   与 `providers.tsx` 里那次**正确**的解析互相打架（两处 Effect 都在写同一个属性）。

这与 `app-theme.tsx` 头注释里警告过的「半亮主题」是同一个坑，只是这次的第二份判据来自页面。

**修复**：新增 `useAppliedThemeMode()`（`app-theme.tsx` 导出），读**已经解析好**的
`html[data-theme]`（本仓既有口径：该属性恒为解析后的明暗），用 `useSyncExternalStore` 订阅其变化；
页面改用它，删掉那次多余的 `useResolvedTheme()`。判据回到 `providers.tsx` 一处。

**证据**（真实浏览器，`data-theme=light`）：

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `<table>` 底色 | `rgb(46, 48, 60)`（暗） | `rgb(255, 255, 255)` |
| 新增行文字 | `rgb(255, 255, 255)`（白字） | `rgb(33, 37, 41)` |
| 新增行底色 | `rgba(46, 160, 67, 0.15)` | `rgb(230, 255, 237)` |

回归守卫：`packages/client/ui/src/base/applied-theme-mode.test.tsx`（4 条，含「读的是已解析值、
不是偏好」与「跟随 `data-theme` 变化」）。

## 第三轮：截断路径的真实数据验证（补首轮的空白）

首轮用的那一轮只有 5 个文件 / 229 行，远小于 256 KB，**没有触发截断**，故当时只能靠单测。
后来把 `设置 → 评分配置 → diff 体积上限` 临时改成 **1 字节**，用真实数据把这条路径整条走通：

| 断言 | 实测 |
|---|---|
| 索引报截断 | `truncated=true`、`noBodyCount=5`、`droppedFiles` 逐个列出 5 个文件 |
| 每个文件 `hasBody=false` | 5/5 都是 `false` |
| 单文件接口拒绝取正文 | **409** `CONFLICT`，文案「该文件超出体积上限，未包含在本轮评分输入中（…）：调大「设置 → 评分配置 → diff 体积上限」后重开抽屉」 |
| 界面告警 | 「diff 已按体积上限截断：5 个文件未包含，**评分模型看不到它们**」+「被丢弃的文件：…」逐个列出 |
| 界面不给加载入口 | 5 个文件都显示「该文件超出体积上限，未包含在本轮评分输入中」，diff 容器数 **0** |

**顺带确认了 30 秒缓存的语义**：把预算改回 262144 后，**立刻**请求仍返回 `truncated=true`
（缓存还在，属预期）；等过 TTL 再请求即恢复 `truncated=false, noBodyCount=0`。
即「打开抽屉这半分钟内的快照」这条注释与实现一致，改动设置后最多 30 秒生效。

（预算已改回 262144。）

## 第四轮：独立 code review 推翻了我自己的两条结论（2026-09-29）

对本轮改动做了一次**全新上下文**的代码复审。它抓到两个 must-fix，其中一条直接推翻了下面第 12 条断言。

### ① 我上面的第 12 条断言是**错的**（未修改的行被画成了改动）

我当时只核对了「还原出的两侧正文」与 CLI 是否一致，**没有核对最终渲染出的 diff 输出**。
而 `reconstructSides` 会把短的一侧补空串到等长（当时按计划写成「口径③」），
补空串让两侧**结尾不同**（一侧以换行收尾、另一侧以内容收尾），组件内部的 jsdiff 于是重新配对尾部，
把**未修改的行也画成红绿**。

用**这一轮的真实文件**（补丁真值 +3 / −1）实测：

| | removed | added | 与补丁比 |
|---|---|---|---|
| 补空串（当时的实现） | 3 | 4 | 多 2 行假删除、1 行假新增 ❌ |
| 不补（修正后） | **1** | **3** | **完全一致** ✅ |

即：**上面第 12 条「逐字一致」当时并不成立**——多出两行红绿。已修正实现，
并补了一条用**真实补丁 + 组件真正调用的那次 `diffLines`** 来断言的回归用例
（`diff-patch.test.ts`），这才是能抓住它的断言；原来的用例只断言了下标位置。

### ② 分页在客户端是**断的**：第 31 个之后的文件根本拿不到

`useRowDiffIndex` 把 `offset=0&limit=30` 写死，页面也从没传 `onLoadMore`，
而哨兵只在 `onLoadMore` 存在时才挂 ⇒ 超过 30 个文件时列表只显示 30 条，
头部却写着「共 N 个文件」，过滤提示还老实说「仅在已加载的 30 个文件里过滤（共 N 个）」——
**没有任何前进的路**。旧的抽屉是列全的，所以这是一次能力回退。

这是**计划本身的缺陷被忠实执行**（Task 5 漏了 offset/limit，Task 8 没接 `onLoadMore`），
而当时的测试没有一条覆盖哨兵/翻页路径，所以它一路绿灯溜到了这里。

已修：hook 收 `offset`/`limit`；页面累积已加载的页（带「只并当前请求的那一页」的守卫，
否则晚到的响应会并错页并自我触发下一页）；`DiffView` 的哨兵回调改走 ref
（内联箭头函数进依赖会让观察者每帧重建、反复触发加载）。补了两条用例。

### 同一轮修掉的其它两条

- **路由把 `?file=` 解了两次码**：`searchParams.get` 已经解过，再解一次会让含 `%` 的真实路径
  抛 `URIError` ⇒ 500，而字面量 `%20` 的路径会解错 ⇒ 404。已去掉多余那次。
- **缓存两处**：命中不续期 ⇒ 超过 30 秒的抽屉会话会在中途重算，且翻页时索引与正文可能来自
  两次不同的计算（「索引说 hasBody=true、取正文却 409」）；模块级 Map 无上限 ⇒ 长期运行会漏内存
  （它存的是**未裁剪**的正文）。已续期 + 加 32 条上限按最旧淘汰。

### 一条**被复审纠正的我自己的误报**

第三轮记的 `data-testid` 那条 FINDING（「路径含 `.` 会让选择器失效」）是**误报**：
带引号的属性选择器接受 `.` 与 `/`，那种写法并不抛错。我当时看到抛错，是因为我用**字符串拼接**
造了一个**没带引号**的选择器。已在 ledger 更正为「不是缺陷」。


