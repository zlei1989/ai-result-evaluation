# 「变更详情」抽屉重设计（逐文件 + 吸顶标题 + 惰性加载）

日期：2026-09-29
状态：待评审
影响面：`@aieval/contracts`、`@aieval/core`、`@aieval/api`、`@aieval/client`、`@aieval/ui`、`apps/web-next`

## 1. 要解决的问题

现在的「代码改动」抽屉（`packages/client/ui/src/composite/diff-view.tsx`）是三段式：
一张全量文件表 + 一大坨统一 diff 正文（`MonoText`，限高 420px 自滚）。

三条具体的不好用：

1. **文件与内容对不上。** 上面是文件清单，下面是一整块文本。想知道 `lib/http.ts` 改了什么，
   只能自己在几千行文本里 `Ctrl+F`。
2. **文件和正文是两个存储。** `RowDiff.files` 来自 `--numstat` 计数，`RowDiff.text` 是三段
   diff 拼出的字符串，两者在界面上没有关联，也没有锚点可跳。
3. **没有滚动定位。** 表格自己滚、正文自己滚、抽屉自己滚——三个滚动容器叠着，
   滚到哪都说不清「现在是哪个文件」。

目标形态：**文件名 + 内容的列表**，向下滚动时当前文件标题吸顶，改动内容用 diff 组件渲染。

## 2. 目标与非目标

**目标**

- 抽屉标题改为「变更详情」。
- 一个可滚动列表，每个文件一项：吸顶的文件名标题 + 该文件的 diff 正文。
- diff 正文用 `react-diff-viewer-continued` 渲染。
- 万级文件变更下打开不卡死（见 §4）。
- 保住既有的截断语义：评分模型看不到的改动必须让人知道（spec §5.5 第 7 步）。

**非目标**

- 不改 `truncateDiff` 的预算口径与「评分模型看不到」的文案含义。
- 不改服务端每次现算 diff 的总体策略（spec §7.2：diff 正文不预先落库）。
- 不做 diff 行内评论、不做并排/内联切换的偏好持久化、不做文件树（本期只做平铺列表）。

## 3. 组件选型：为什么不是字面上的 `react-diff-viewer`

需求里点名的是 `react-diff-viewer`。**它在本仓库不能用**：

| | 版本 | peer `react` | 最后发布 |
|---|---|---|---|
| `react-diff-viewer` | 3.1.1 | `^15.3.0 \|\| ^16.0.0` | 2020-05-22 |
| `react-diff-viewer-continued` | 4.4.0 | `^15 \|\| ^16 \|\| ^17 \|\| ^18 \|\| ^19` | 2026-07-14 |

本仓库是 React `19.2.7`。原包已 6 年未发版且 peer 不含 19，装进来只能靠 `--force` 压过 peer 校验，
运行期用 React 19 渲染一个按 React 16 生命周期写的 class 组件——不是可接受的赌注。

`react-diff-viewer-continued` 是同一 API 的维护分支（同样的 `oldValue` / `newValue` /
`splitView` / `styles` props），已实测在本仓库安装成功（新增 66 个依赖包，
`pnpm peers check` 未新增任何 peer 冲突——唯一那条 `zod` 告警来自
`@anthropic-ai/claude-agent-sdk`，是既有问题，与本次无关）。
额外白拿两项能力：`highlightLanguage` 语法高亮、内置行虚拟化。

**采用 `react-diff-viewer-continued@4.4.0`。**

### 3.1 一个必须写清楚的接口错配

`react-diff-viewer` 系列的 `oldValue` / `newValue` 收的是**完整文件正文**，不是 diff 文本。
而服务端给的是**统一 diff**（`@@` hunk 带上下文行）。两者不是同一种输入。

若把 diff 文本直接当 `newValue` 传进去，`oldValue` 传空串，得到的是
「把这份 diff 当新文件全文」——即它会把 `+` / `-` 前缀当作正文内容逐行对比，
渲染出**一份完全错误的 diff**（`+foo` 会被显示成新增了一行字面量 `+foo`）。

两条出路：

- **(a) 服务端额外给 `oldValue` / `newValue` 全文。** 要靠 `git show baseline:path` 与
  读工作区文件，多两次 IO、还要处理二进制与超大文件。
- **(b) 由 diff 文本还原两侧正文。** 解析 hunk 头拿行号，用上下文行与 `/^-/` 行拼出旧侧、
  用上下文行与 `/^+/` 行拼出新侧，再把两侧正规化到同一个行号起点交给组件。

**采 (b)。** 理由：diff 文本已经是服务端算好的唯一真源，(a) 会让「界面显示的改动」与
「评分模型看到的改动」变成两次独立计算，而这两者必须逐字一致——spec §5.5 第 7 步整个
截断语义都建立在「界面如实反映评分输入」之上。(b) 是纯函数，可单测，且失败面只在渲染层。

**关键推论：hunk 之间的未修改行在 diff 文本里是不存在的。**
把两侧正文只按 hunk 内容拼接、却不做行号对齐，会把「相隔 200 行的两处改动」渲染成相邻行，
再叠上 `hideSummary` 之外的折叠逻辑，读者会得到错误的相邻关系。
故还原算法**必须用 hunk 头的行号把两侧补空行对齐**（缺失行填 `''`），
组件那边同时传 `showDiffOnly={false}`，让对齐后的空行如实显示为「未修改」。
`extraLinesSurroundingDiff` 保持默认，不额外造内容。

`oldValue === newValue` 时（纯二进制改动、`--numstat` 两列为 `-`）不渲染 diff 视图，
改显示「二进制文件，无文本改动可显示」。

## 4. 「超万个文件变更怎么办」——分页与惰性加载

先摆两个既成事实，它们决定了方案边界：

1. **diff 正文已经有硬上限。** `RowDiff.text` 经 `truncateDiff(text, settings.diffBudgetBytes)` 裁剪，
   默认预算 **262144 字节（256 KB）**（`packages/server/contracts/src/settings.ts:48`）。
   `truncateDiff` 按 `diff --git` 整段保留到预算为止，超出部分只留文件名。
   故**正文永远不可能有万级文件**——万级文件的正文在服务端就已经被裁掉了。
2. **但 `RowDiff.files` 没有任何上限。** `truncateDiff` 只裁 `text`；`files` 直接来自
   `--numstat`（`mergeFilesByPath`）。一次改一万个文件，`files` 就是一万条。

所以真正的风险不在渲染 diff，而在**文件清单本身**：一次性把一万条 `{path, insertions, deletions}`
序列化下发并渲染，才是会卡死的那一步。三条对策：

**① 文件索引与正文拆成两个接口。** 索引响应不含任何 diff 正文，一万条也只是一份纯 JSON。
索引按 `offset` / `limit` **分页**（每页 30），界面用虚拟化/无限滚动逐页追加——
DOM 里始终只有几十行。

**② 正文按需、逐个文件加载。** 列表滚到哪个文件才请求哪个文件的正文
（`IntersectionObserver` 触发），任何一次响应都不会携带「全部文件」。
这同时消掉了「首帧一次卡死」这个风险类别本身，而不是去缓解它。

**③ 单个文件的正文不做二次截断。** 一个文件只要在预算内，它的正文就是**完整**的一段；
超出预算的文件**整段**被丢（`truncateDiff` 的既有口径），在索引里表现为 `hasBody: false`，
界面直接不给加载入口。故不存在「某文件正文显示了一半」这种状态——
这是刻意的：半份正文比没有正文更危险，看的人会以为改动就这么多。
（本条同时解释了为什么 `RowDiffFile` 没有 `truncated` 字段，见 §5。）

**副产品：吸顶与惰性加载是同一个机制。** 因为滚动正是加载的触发器，
「文件标题吸顶」与「正文开始加载」在同一时刻发生，不需要两套滚动监听。

**服务端计算缓存。** 惰性加载意味着同一个文件反复请求会让 `collectDiff` 反复跑 git
（本仓库已知进程创建 ≈ 0.5s/次，`git.ts:565` 有实测）。故 api 层加一个**进程内**结果缓存：
键 `(runId, rowId)`，值 = `collectDiff` 的原始输出 + 预算裁剪结果，**TTL 30 秒**。

- 为什么是 TTL 而不是按 `baselineCommit` 键控：行在跑的时候工作区内容一直在变，
  键控会让「同一次评测里翻同一个文件」拿到不同结果；TTL 的语义是
  「打开抽屉这半分钟内的快照」，与 `useRowDiff` 现有的 `revalidateOnFocus: false`
  口径一致（`packages/client/client/src/runs.ts:341` 已解释过为什么要当快照看）。
- 为什么不做主动失效：候选中途会写盘，主动失效需要在编排层埋钩子，属于把复杂度放到错误的一层。
  30 秒 TTL 到期后自然重算，已足够。
- 缓存**只在内存**、进程重启即失效，与 `config-store` 那类落盘配置无关。

## 5. 契约变更

`packages/server/contracts/src/run.ts` 现有的 `RowDiffSchema`（第 226 行）替换为两个形状。
**是替换而不是并存**：并存意味着两套序列化路径都得维护，而调用方只有抽屉一处。

```ts
/** 「变更详情」抽屉首帧：文件索引（不含任何 diff 正文） */
export const RowDiffIndexSchema = z.object({
  /** 这一页的文件条目，已按路径排序 */
  files: z.array(z.object({
    path: z.string(),
    insertions: z.number(),
    deletions: z.number(),
    /** 该文件是否在「未跟踪文件」段里（`??` 新文件），供界面打标签 */
    untracked: z.boolean(),
    /** 该文件是否有正文可取。false = 被 256 KB 预算丢弃，界面不给加载入口 */
    hasBody: z.boolean(),
  })),
  /** 文件总数（不受分页影响，用于「共 N 个文件」与继续加载的判断） */
  total: z.number(),
  /** 本页起始下标 */
  offset: z.number(),
  /** **全部文件**的增删行数合计（不是本页——头部的「共 N 个文件 · +X −Y」要的是全局值，
   *  若按页累加，翻页时这个数会跳动） */
  insertions: z.number(),
  deletions: z.number(),
  /** 全部文件里有多少个没有正文（被预算丢弃） */
  noBodyCount: z.number(),
  truncated: z.boolean(),
  /** 被预算丢弃的文件名（原有语义逐字保留：评分模型看不到它们） */
  droppedFiles: z.array(z.string()),
});

/** 单个文件的改动正文 */
export const RowDiffFileSchema = z.object({
  path: z.string(),
  /** 统一 diff 原文（该文件那一段） */
  patch: z.string(),
  insertions: z.number(),
  deletions: z.number(),
  /** 二进制/无文本改动：true 时界面不渲染 diff 视图 */
  binary: z.boolean(),
});

export type RowDiffIndex = z.infer<typeof RowDiffIndexSchema>;
export type RowDiffFile = z.infer<typeof RowDiffFileSchema>;
```

**为什么 `RowDiffFile` 没有 `truncated` 字段（一条被自我审查删掉的字段）：**
`truncateDiff` 是按**整文件**丢弃的（`git.ts:746-754` 只在整段装不下时 `dropped`），
**永远不会把一个文件的正文切一半**。故「这个文件的正文被截断了」这个状态**不可能出现**——
留一个恒为 `false` 的字段，下一个人会照着它写一条永远进不去的分支。
「被截断」这件事只在**索引**层有真语义（丢了哪些文件），那里已经有
`truncated` + `droppedFiles` + `noBodyCount` 三个字段说清楚了。
按预算被丢弃的文件**根本不会**走到单文件接口（§6.2 对它抛 `CONFLICT`），
所以单文件响应里没有任何需要标注截断的场景。

`hasBody` 的存在理由：**让「被预算丢弃」在界面上是可预期的，而不是点一下才发现没有。**
它由服务端在生成索引时按预算算出，与 `droppedFiles` 同源，不会漂移。

## 6. 服务端

### 6.1 `core`：把逐文件切分暴露出来

`packages/server/core/src/git.ts` 已有私有函数 `splitDiffFiles(text)`（第 776 行），
它正是「按 `diff --git` 切段 + 取路径」的实现，也是 `truncateDiff` 依赖的那一个。
新增一个导出的只读查询：

```ts
/** 按路径取某一段 diff 原文；路径不存在返回 undefined */
export function extractDiffFile(text: string, path: string): string | undefined
```

**必须复用 `splitDiffFiles`，不得另写一份切分逻辑。** 两份切分器漂移的表现是
「索引里有的文件，正文永远取不到」，而且只在路径含特殊字符时才出现——最难查的那一类。

**这里有一个已存在的陷阱，必须在实现时处理掉。**
`splitDiffFiles` 从 `diff --git a/X b/Y` 里取路径时是**原样取**的：

```ts
return { path: headerMatch?.[2] ?? '', text: chunk };   // git.ts:781，未规范化
```

而 `RowDiff.files[].path` 来自 `--numstat` 并**经过 `rewriteRenamePath` 规范化**
（`git.ts:696`）——花括号重命名 `packages/{old => new}/x.ts` 会被改写成
`packages/new/x.ts`。**两个来源的路径键因此可能不相等**，
而 `extractDiffFile` 正是「用索引里的 path 去 diff 文本里找段落」，
按未规范化的键去找，重命名文件的正文会永远取不到。

故 `extractDiffFile` **必须对 `splitDiffFiles` 取出的路径同样套一次 `rewriteRenamePath`**
再比对（该函数对已规范化的路径是幂等的，故对无重命名的普通路径无副作用）。
§8 的测试表里有专门一条钉这个（`{a => b}` 形态）。

**同名文件在「已提交」与「未提交」两段都出现时，取「未提交」那一段。**
理由：未跟踪文件的正文只在未提交段里（`git add -N` 之后 `git diff HEAD` 才带它，
见 `git.ts:581-584` 的注释），而未提交段反映的是**工作区当前状态**——
用户打开抽屉想看的正是「现在这个文件被我改成什么样了」。已提交段是历史。

### 6.2 `api`：两个读取函数

`packages/server/api/src/run-artifacts.ts`：

- `getRowDiffIndex(runId, rowId, offset, limit): RowDiffIndex`
- `getRowDiffFile(runId, rowId, path): RowDiffFile`

两者共用一次 `collectDiff` 结果（即 §4 的 30 秒缓存），保证索引与正文同源。

`getRowDiffFile` 对未知路径抛 `NOT_FOUND`（路径来自 URL，可能是脏的或拼错的）；
对 `hasBody === false` 的路径抛 `CONFLICT` 并说明是被预算丢弃——
这两条**必须分开**：「这个文件不存在于本次改动」与「它存在但正文被裁了」在排障时是两回事。

### 6.3 路由

`apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts` 改造为读查询参数：

- `?offset=0&limit=30` → `RowDiffIndex`（`limit` 服务端封顶 200，防手改 URL 拉全量）
- `?file=<path>` → `RowDiffFile`

`file` 参数需要 `decodeURIComponent` 且**路径不得被当作文件系统路径使用**——
它只用来在内存里比对 diff 段落中的路径字符串，不参与任何 `path.join`。
`offset` / `limit` 非法（负数、非整数、超封顶）一律按默认值处理而不是 400：
这是只读的展示接口，宽容降级比报错更有用。

## 7. 客户端

### 7.1 `@aieval/client`

`packages/client/client/src/runs.ts`：

- `useRowDiffIndex(runId, rowId, enabled, offset, limit)` —— 沿用 `revalidateOnFocus: false`
  与既有的「打开时看一眼的快照」口径（第 341 行的理由逐字适用）。
- `useRowDiffFile(runId, rowId, enabled, path)` —— 按文件键控的 SWR。
  **`path` 为 `undefined` 时 key 传 `null`**：这正是「滚动到才加载」的开关，
  不需要另造一个 enabled 布尔。

### 7.2 `@aieval/ui`：`DiffView` 重写

`packages/client/ui/src/composite/diff-view.tsx` 的 props 改为：

```ts
export interface DiffViewProps {
  index: RowDiffIndex | undefined;
  /** 逐文件正文：由调用方注入，本包不调接口（ui 包的既有约定，见 index.ts 头注释） */
  loadFile: (path: string) => { patch: string | undefined; error: unknown; isLoading: boolean };
  /** 继续加载下一页索引；undefined = 没有更多 */
  onLoadMore?: () => void;
  /** 实际生效的明暗，透传给 diff 组件的 useDarkTheme */
  dark: boolean;
}
```

**布局**（自上而下）：

1. **汇总条**：`共 N 个文件 · +X −Y` + 截断提示（`truncated` 时）。
   截断提示沿用原文案「评分模型看不到它们」——这是 spec §5.5 第 7 步的硬要求，
   改成「已截断」会让人以为只是界面没显示全（`diff-view.test.tsx:55` 有专门用例钉这条）。
2. **搜索框**（按路径过滤）。万级文件下这是把「能不能找到」从「滚多久」变成「打几个字」的关键，
   且实现只是对已加载页做 `includes` 过滤 + 提示「仅过滤已加载的 N 个文件」，
   不做服务端搜索（避免为一个展示功能再造一个查询接口）。
3. **文件列表**：每项 = 吸顶标题 + 正文。
   - **吸顶**：标题 `position: sticky; top: 0`，**滚动容器是列表自己**（`overflow: auto`）。
     这是唯一能吸顶的做法——sticky 相对最近的滚动祖先定位，
     若列表不自己滚（靠抽屉滚），标题会吸在抽屉顶部而盖住上面所有内容。
     故抽屉内**只有一个滚动容器**，这也顺手解决了 §1 第 3 条「三个滚动容器」的问题。
   - 标题内容：路径（等宽）+ `+X −Y` + 未跟踪标签 + 该文件正文的截断/二进制标记。
   - `hasBody === false` 的条目：标题照常吸顶，正文位置显示
     「该文件超出体积上限，未包含在本轮评分输入中」——不显示加载入口。
   - 正文**惰性触发**：`IntersectionObserver` 观察该条目，进入视口才 `loadFile(path)`。
   - 正文加载中：**骨架占位**（`Skeleton`），不是空白。
     空白会被误读成「这个文件没改动」，而「没改动」在语义上根本不该出现在列表里。
   - 渲染：`react-diff-viewer-continued` 的 `DiffViewer`，`disableWorker` 传 `true`
     （每行一个 worker 在几十个文件同时进视口时是纯开销，且 jsdom 里没有 worker，
     会让 `diff-view.test.tsx` 无法运行）。
4. **列表底部**：`onLoadMore` 存在时挂一个哨兵元素，同样用 `IntersectionObserver` 触发加载下一页。

### 7.2.1 抽屉几何（三个抽屉共用，2026-09-29 补充）

三条约束由需求方给定，**执行日志 / 变更详情 / 评分详情三个抽屉都适用**。

**① 宽度 = 50vw，下限 800px：**

```tsx
styles={{ wrapper: { width: 'max(50vw, 800px)', maxWidth: '100vw' } }}
```

用 CSS `max()` 而不是在 JS 里量 `window.innerWidth`：后者要挂 resize 监听、首帧还得处理
SSR 无水 `window` 的情况，而 `max()` 由浏览器直接算，不需要第二份判据。
`maxWidth: '100vw'` 与 antd 自带的 `.ant-drawer-content-wrapper{max-width:100vw}` 同值，
**显式写出来是为了让「窄屏下 800px 下限不许把抽屉撑出屏幕」这条意图留在代码里**——
否则下一个人看到 `max(50vw, 800px)` 会以为窄屏必然溢出。

去掉原来的 `size="large"`：它是个固定预设值，与 `styles.wrapper.width` 同时给会打架
（antd 的 `size` 同样落到 wrapper 上）。

**② 内容区 `padding: 0`：**

antd 的 `.ant-drawer-body` 默认 `padding: var(--ant-padding-lg)`。用语义槽覆盖：

```tsx
styles={{ body: { padding: 0 } }}
```

内边距改由**每个抽屉的内容自己提供**（三个抽屉各自处理，#1 的结论）：

| 抽屉 | 内边距由谁给 |
|---|---|
| 变更详情 | 汇总条与搜索框各自带横向 padding；**文件标题条与 diff 正文也带横向 padding**（否则文字贴死抽屉边框），但标题条的**吸顶底色要铺满整宽**，故 padding 加在内层元素上而不是标题条本身 |
| 执行日志 | `LogView` 的最外层 `Flex` 加 padding（状态条、开关、正文一起内缩） |
| 评分详情 | `ScoreDetailView` 的最外层加 padding |

**③ 限高改成自适应：**

原来的 `maxHeight={420}`（`diff-view.tsx:56`）是写死的像素值，**去掉**——
新抽屉里 `MonoText` 整块被逐文件列表取代，本来也不再有这一处调用。

高度链已经由 antd 自己铺好了，**不需要手写任何高度计算**：

```
.ant-drawer-content-wrapper   position:absolute; top/right/bottom:0   ← 满高，宽度由 ① 定
  .ant-drawer-section          display:flex; flex-direction:column; height:100%
    .ant-drawer-header         （自带高度）
    .ant-drawer-body           flex:1; min-height:0; overflow:auto      ← 取出剩余高度
```

故「随窗口尺寸自适应」= 什么都不写：抽屉满高，body 拿走 `header` 之外的全部高度，
窗口变大变小由 flex 自动跟随。

**这里有一个必须写明的取舍（否则吸顶会失效）：**
`.ant-drawer-body` 自己就是 `overflow: auto`，即它**已经是一个滚动容器**。
本 spec §7.2 要求文件标题用 `position: sticky`，而 sticky 相对**最近的滚动祖先**定位——
所以滚动容器应当**就是 `.ant-drawer-body`**，而不是在它内部再套一个 `overflow: auto` 的列表。

结论：**抽屉内只有一个滚动容器，就是 body 自己。**

- 内容高度用 `minHeight: '100%'`（**不是 `height`**）：内容少于可视高度时铺满、多于时自然撑开，
  两者都让 body 决定滚动。
- 标题的 `position: sticky; top: 0` 相对 body 定位。**已核实 body 没有任何祖先带 `transform`**：
  `.ant-drawer` 是 `position: fixed`、content-wrapper 是 `position: absolute`，
  `transition` 不是 `transform`。若日后有人给抽屉加滑动动画（`transform` 会创建新的包含块），
  吸顶会静默失效——这一条是那一处的护栏。

**④ 一个刻意不做的事：不给抽屉加 `resizable`。**
antd 6 的 `Drawer` 有内建 `resizable?: boolean | DrawerResizableConfig`，本仓
`ListDetailLayout` 也已有自己的宽度拖拽（`useStoredWidth`）。这里**不启用**：
需求方给的是确定口径（50vw / 下限 800px），再加一层可拖拽会让「宽度是多少」出现两个答案。
真要放开拖拽时，正确做法是接进 `ListDetailLayout` 那套宽度偏好，而不是各写一份。

**`dark` 由调用方传入**，不从 `@aieval/ui` 内部猜：`useResolvedTheme()` 已经是本仓
主题的唯一真源（`app-theme.tsx`），在页面层取 `mode === 'dark'` 传进来，
避免第二份主题判据（这正是 `app-theme.tsx` 头注释警告的「半亮主题」）。

### 7.3 `apps/web-next/app/runs/page.tsx`

抽屉 `title` 由「代码改动」改为「变更详情」，内容换成新的 `DiffView`：
把 `useRowDiffIndex` / `useRowDiffFile` 与 `useResolvedTheme().mode` 接进去。
抽屉的数据加载三态（loading / failed / 正常）沿用现有写法。

## 8. 测试计划

契约变更会打破现有断言，**替换而不是保留**：

| 文件 | 变化 |
|---|---|
| `packages/client/ui/src/composite/diff-view.test.tsx` | 重写。保留「截断提示必须说『评分模型看不到』」这条用例（逐字），新增吸顶、骨架、`hasBody=false` 文案、惰性触发用例 |
| `packages/server/core/src/git.diff.test.ts` | 新增 `extractDiffFile` 用例：正常路径、路径不存在、重命名 `=>`、`{a => b}`、含空格路径、**同名文件在两段中都出现时取未提交段** |
| `packages/server/api/src/run-artifacts.test.ts` | 新增索引分页与 `hasBody` 用例；`getRowDiffFile` 的 NOT_FOUND / CONFLICT 两条分开断言 |
| `apps/web-next/src/route-run-artifacts.test.ts` | 新增 `?offset/limit`、`limit` 封顶、`?file=` 用例 |
| `packages/server/contracts/src/run.test.ts` | 替换 `RowDiffSchema` 相关断言 |

新增一条**还原算法**的单测（§3.1 的 (b)）：给一段含两个相隔很远的 hunk 的 diff，
断言还原出的两侧正文长度一致、且第二处改动的行号与 hunk 头一致——
这条用例是防「相隔 200 行的改动被渲染成相邻」的回归守卫，是整个重设计里最容易写错的一处。

## 9. 验收标准

1. 抽屉标题是「变更详情」。
2. 列表每项显示文件名，向下滚动时当前文件标题吸顶，正文用 `react-diff-viewer-continued` 渲染。
3. 万级文件变更下打开抽屉不卡死：首帧只请求一页索引（30 条），DOM 行数始终为几十。
4. 正文只在该文件进入视口时请求；加载中显示骨架。
5. 被 256 KB 预算丢弃的文件，标题照常显示且明示「未包含在本轮评分输入中」。
6. 截断提示文案仍含「评分模型看不到」，`diff-view.test.tsx` 对应用例逐字保留。
7. 明暗主题下 diff 配色都正确（`dark` 透传生效）。
8. **三个抽屉宽度都是 `max(50vw, 800px)`**；窗口缩到 800px 以下时抽屉不撑出屏幕（`maxWidth: 100vw` 生效）。
9. **三个抽屉内容区 `padding: 0`**，且内边距由各抽屉自己的内容提供——日志与评分详情的正文不贴边，
   变更详情的文件标题条吸顶底色铺满整宽而文字不贴边。
10. **抽屉高度随窗口自适应**：窗口拉高/压矮时抽屉跟着变，内容区拿满 `header` 之外的高度；
   页面与抽屉都不出现第二条滚动条（整页只有 `.ant-drawer-body` 一个滚动容器）。
11. 依次跑通 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`。

## 10. 风险

| 风险 | 处置 |
|---|---|
| 还原算法把不相邻的 hunk 渲染成相邻 | §3.1 明文要求按 hunk 行号补空行对齐 + `showDiffOnly={false}`；§8 专用回归用例 |
| 两份 `diff --git` 切分逻辑漂移 | §6.1 强制复用 `splitDiffFiles`，不另写 |
| **重命名文件的正文永远取不到**（`splitDiffFiles` 取原始路径、`numstat` 取规范化路径，两个键不相等） | §6.1 明文要求 `extractDiffFile` 对切出的路径套 `rewriteRenamePath`；§8 有 `{a => b}` 专用用例 |
| `react-diff-viewer-continued` 的样式与 antd 6 主题打架（它是 emotion + 自己的配色） | `useDarkTheme` + `styles` 覆盖；验收标准 7 在明暗两态各看一次 |
| 30 秒缓存让「刚跑完的行」看到旧结果 | 缓存只在抽屉打开期间有意义，且行跑完后重开抽屉即重算；不影响落库的评分输入（那是编排层自己算的） |
| 抽屉内容区高度算不出、吸顶失效 | §7.2.1 ③：高度链由 antd 的 `.ant-drawer-section`（flex 列 + height:100%）铺好，**不手写高度**；内容用 `minHeight: '100%'`（不是 `height`，否则内容短于视口时铺不满）；滚动容器就是 `.ant-drawer-body` 本身，不再内套一层 |
| 日后给抽屉加 `transform` 动画导致吸顶静默失效 | §7.2.1 ③ 明文写了这条护栏：`transform` 会创建新的包含块，sticky 会改相对它定位 |

## 11. 已确认的决策（与需求方逐条对齐）

- 逐文件切分**放在服务端**（契约变更），不在前端解析大 blob。
- 「未跟踪文件」段**不单独呈现**，只靠文件清单里该条目的「未跟踪」标签体现。
- 正文加载中显示**骨架占位**。
- 组件用 `react-diff-viewer-continued@4.4.0`（原 `react-diff-viewer` 与 React 19 不兼容）。
