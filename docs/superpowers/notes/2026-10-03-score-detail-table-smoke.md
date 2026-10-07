# 评分详情改用 antd 表格（`Table size="small"`）的冒烟记录（2026-10-03）

口径来源：用户 2026-10-03「评分详情里面用 antd table size=small」。
改的是 `packages/client/ui/src/composite/score-detail-view.tsx` 的**逐项明细**那一块：
手写的 Flex 行 → antd `Table`（`size="small"`），**一组一张表**（组名是评分表自己的结构，
摊成一张大表反而要多一列「组名」，而那一列每行都重复一遍）。列：引用键 / 目标 / 权重 / 判定 / 理由。

目标页：`http://localhost:3083/runs?panel=detail&id=2921fee3-6144-4df4-b2db-eb0f8fec678a`（`next dev -p 3083`）。

## ① 范围清单

| # | 验收项 | 结果 | 证据（真机 DOM / 实测数字） |
|---|---|---|---|
| 1 | 逐项明细是 antd 表格 | ✅ | 抽屉正文里 `table` × **2**（两组各一张）；表头五列 `引用键 / 目标 / 权重 / 判定 / 理由`；行是 `<tr>` |
| 2 | 紧凑尺寸 | ✅ | `.ant-table-small` × **2**（antd 6 的 size 枚举是 `large \| medium \| small`，`small` 落在 `.ant-table-small`） |
| 3 | 一行一项、判定与理由在同一行 | ✅ | 8 项 ⇒ 8 个 `tr[data-testid^="score-judgment-"]`，每行 5 格（键 / 目标 / 权重 / 判定 Tag / 理由） |
| 4 | **未达成与达成仍分得开**（改版不许把这条摊平） | ✅（单测口径） | 标记仍挂在**行**上：`data-achieved="yes / no"` + 未达成行的行内语义色。⚠️ 真机这一轮 3 行**都没有未达成项**，见 ⑥ |
| 5 | 「缺少判定」仍显式写出（不静默跳过） | ✅ | 判定列渲染 `<Tag color="warning">缺少判定</Tag>`（单测 `评分表里有、判定里没有的项被显式标出`） |
| 6 | 表格不撑破抽屉（宽屏 / 窄屏） | ✅ | 视口 1432：表格总宽 **753**、两个 `.ant-table-content` 的 `scrollWidth === clientWidth`（无横向滚动）；视口 **700**：同样 `scrollWidth === clientWidth = 653` |
| 7 | 引用键不像被折断 | ✅ | 8 个键全部单行、未被省略（`scrollWidth ≤ clientWidth`）；列宽自适应到 **128 / 143**（最长键 `runnable-directly`） |

## ② 操作路径

1. 打开目标页 → 点第一行卡片的「评分详情」→ 抽屉开着；
2. 量 `.ant-drawer-body` 里的 `table` / `.ant-table-small` / 表头文案 / 每行 `data-*` 与各列宽；
3. 视口改 700 × 900，重复第 1–2 步（看横向溢出）。

> 该环境下 rc-drawer 的入场过渡仍停在首帧：量之前要 `document.getAnimations().forEach(a => a.finish())`
> （与 `2026-10-03-drawer-width-unification-smoke.md` 同一条注意事项）。

## ③ 证据（实测）

- 列宽（视口 1432，抽屉 800）：引用键 **128**（第二组 143）/ 目标 254 / 权重 88 / 判定 96 / 理由 187，合计 753；
- 行：`tr[data-testid="score-judgment-vue3-cdn"]` 等 8 个，格内容依次 `vue3-cdn` / 目标全文 / `10 分` / `达成` / 理由全文；
- 窄屏 700：抽屉 700，两个表 `scrollWidth = clientWidth = 653`（**无横向滚动条**），键仍单行。

## ④ 改动清单

| 文件 | 改动 |
|---|---|
| `packages/client/ui/src/composite/score-detail-view.tsx` | 逐项明细改 `Table<ScoreRow>`（`size="small"`、`pagination={false}`、`rowKey` 用组内序号）；列定义提到组件外并**每列显式给 `key`**（判定 / 理由两列都没有 `dataIndex`，不给 `key` 会撞成同一列键）；判定与语义色经 `onRow` 落在 `<tr>` 上；引用键走 `EllipsisText`（标识符不许词中折行） |
| `packages/client/ui/src/composite/score-detail-view.test.tsx` | 补 `ResizeObserver` / `matchMedia` 打桩（antd `Table` 两者都要，与 `rubric-table.test.tsx` 同一手法）；**新增一条形态守卫**（行是 `<tr>` / 两组两张表 / `.ant-table-small` × 2） |

两处**顺手修掉的既有隐患**（都不是这次要求的，但都在被改的那几行里）：

- 引用键原先按**对象反查**（`items.indexOf(item)`）取——两项内容完全相同时永远命中第一项，
  第二项的判定会被贴到第一行上；改用 `rubricItemKeys` 按组切片对齐（与 `rubric-table` 同一手法）；
- 组的 React `key` 由 `group.name` 改成 `组序号-组名`：两份同名的组（脏数据）不再撞成同一个 key。

## ⑤ 守卫与变异验证

新增守卫在 `score-detail-view.test.tsx`，2 个变异体逐个制造回去，**全部转红**，还原后逐个核对 SHA256 与变异前一致：

| 变异体 | 结果 |
|---|---|
| M1 去掉 `Table` 的 `size="small"` | ✅ 红（`.ant-table-small` 计数为 0） |
| M2 两组只画一张表（「摊成一张大表」的代理变异） | ✅ 红（`table` 计数为 1） |

> M1 第一次没跑成：变异点字符串 `size="small"` 在文件里出现 **2 次**（文件头注释里也写了一次），
> 变异脚本按「命中必须唯一」直接拒绝执行——这条自检拦下了一次无效变异。

`pnpm --filter @aieval/ui typecheck` 与 `pnpm typecheck` 均绿；`packages/client/ui/src/composite` **44 个文件 / 567 条用例全绿**；
本次两个文件单独跑 eslint 0 错。

## ⑥ 未覆盖项

- **未达成的红行没有在真机复现**：这一轮 3 行的评分里 `未达成` 数都是 **0**（8/8 达成），
  故行内语义色只有单测口径（自定义 `colorError` token + 行内 style 断言）在守；本机也没有第二轮回放数据。
  要真机复核它，得等一轮有未达成项的评测；
- 只看了**暗色**（全站当前主题）；亮色未复核；
- 表格的**排序 / 分页**没做（也不在口径里）：一组最多十几项，分页关掉；
- 窄屏只点到 700（抽屉的下限口径），更窄的宽度（如 480）未量。
