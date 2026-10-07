# 三个右侧抽屉统一宽度的冒烟记录（2026-10-03）

口径来源：`docs/superpowers/specs/2026-09-29-diff-drawer-redesign-design.md` §7.2.1 ①（**三个**抽屉
宽度 = `max(50vw, 800px)`）。本次是把这条口径**真正落到代码上**——antd 6 废弃 `width` 之后，
「变更详情」「评分详情」两处的宽度整个掉了（掉回 antd 默认 378px），而「执行日志」是 800px，
于是同一次评测里两个抽屉一宽一窄（起因与修法见 ④）。

目标页：`http://localhost:3083/runs?panel=detail&id=2921fee3-6144-4df4-b2db-eb0f8fec678a`（`next dev -p 3083`）。

## ① 范围清单

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 评分详情与执行日志**等宽** | ✅ | 视口 1432：两者 `.ant-drawer-content-wrapper` 的 `getBoundingClientRect().width` 都是 **800**，`style.width` 都是 `max(50vw, 800px)` |
| 2 | 变更详情同宽（口径是「三个抽屉一份几何」） | ✅ | 同上，**800** |
| 3 | 宽屏走 `50vw`、窄屏走 `800px` 下限 | ✅ | 视口 **1920 → 960**（= 50vw）；**1432 → 800**（下限生效） |
| 4 | 再窄也不许撑出屏幕 | ✅ | 视口 **700 → 三个抽屉都 700**（`maxWidth: 100vw` 生效：`x=0`、`right=700`） |
| 5 | 宽度只有**一处**字面量 | ✅ | 字面量只在 `packages/client/ui/src/base/drawer-geometry.ts` 的 `WIDE_DRAWER_SIZE`；`AgentLogDrawer` 与评测页都引用常量（守卫 + 7 个变异体验证，见 ⑤） |
| 6 | 明暗两态 | ⏭ 跳过 | 本轮量的是几何（宽度与主题无关）。暗色下的实际观感未逐态复核——**记为未覆盖项** |

## ② 操作路径

1. 打开目标页（`panel=detail`，三个抽屉都关着）；
2. 依次点行卡片的 `变更详情` / `评分详情` / `执行日志` → 每次等抽屉开完，量 `.ant-drawer-content-wrapper`；
3. 点抽屉右上角关闭按钮 → 等 wrapper 从 DOM 里消失再点下一个（`destroyOnHidden`）；
4. 把视口依次改成 1920 / 1432 / 700，重复第 2–3 步。

> 量之前要把动画推到终态（`document.getAnimations().forEach(a => a.finish())`）：该环境下
> rc-drawer 的入场过渡停在首帧，直接量 `getBoundingClientRect().left` 会读到**未入场的**
> 位置（宽度是对的，位置是错的）。这与被测代码无关，但会让「抽屉到底开没开」看起来像失败。

## ③ 证据（实测数字）

| 视口 | 变更详情 | 评分详情 | 执行日志 | 说明 |
|---|---|---|---|---|
| 1920 | 960 | 960 | 960 | `50vw = 960 > 800` ⇒ 走 50vw |
| 1432 | 800 | 800 | 800 | `50vw = 716 < 800` ⇒ 走下限 800 |
| 700 | 700 | 700 | 700 | `maxWidth: 100vw` 兜底，不撑出屏幕 |

三处 wrapper 的 `style.width` 都是 `max(50vw, 800px)`（同一条 CSS 表达式，同一个常量）。

## ④ 改了什么（以及为什么必须这么改）

| 文件 | 改动 |
|---|---|
| `packages/client/ui/src/base/drawer-geometry.ts` | **新增**：`WIDE_DRAWER_SIZE`（`'max(50vw, 800px)'`）与 `WIDE_DRAWER_STYLES`（`wrapper.maxWidth: '100vw'` + `body.padding: 0`）——宽度的唯一字面量 |
| `packages/client/ui/src/index.ts` | 从包根转出这两个常量（评测页要用同一份） |
| `packages/client/ui/src/composite/agent-log/agent-log-drawer.tsx` | `size="max(50vw, 800px)"` → `size={WIDE_DRAWER_SIZE}`；`styles={{…}}` → `styles={WIDE_DRAWER_STYLES}` |
| `apps/web-next/app/runs/page.tsx` | 删掉只压 `maxWidth`、**不带宽度**的 `DRAWER_STYLES`；新增 `DRAWER_GEOMETRY = { size, styles }`，`变更详情` / `评分详情` / 执行日志的两个瞬时态（`LOG_FALLBACK_DRAWER`）都摊开它 |

成因一句话：antd 6 把 `width` 废弃成 `size`（控制台只打一句 warning），页面那两处**只删了 `width`、没补 `size`**
⇒ 抽屉静默掉回默认 **378px**，而**没有任何用例变红**（这正是本次新增守卫的靶子）。

## ⑤ 守卫与变异验证

守卫：`apps/web-next/src/drawer-geometry.test.ts`（三层：常量内容 / 两个包的消费者都引它 / 页面上
**每个** `<Drawer>` 都摊开了这份几何）。7 个变异体逐个制造回去，**全部转红**，还原后逐个核对
SHA256 与变异前一致：

| 变异体 | 结果 |
|---|---|
| M1 执行日志抽屉写回宽度字面量 | ✅ 红 |
| M2 页面几何丢掉宽度（= 这次的缺陷成因） | ✅ 红 |
| M3 评分详情抽屉不摊开几何（掉回 378px） | ✅ 红 |
| M4 几何常量丢掉 `maxWidth` 兜底 | ✅ 红 |
| M5 几何常量丢掉 `body.padding` | ✅ 红 |
| M6 主抽屉写 `size="large"` | ✅ 红 |
| M7 宽度常量被调成别的数 | ✅ 红 |

> M4 / M5 第一次**没有红**：那两条当时写成「文件全文含 `maxWidth: '100vw'` / `padding: 0`」，
> 而文件头注释里就写着这两个串 ⇒ 常量掏空也照样绿。改成**钉整个 `WIDE_DRAWER_STYLES` 定义**
> 之后才拦得住。守卫误放行比误伤更危险，故这两个变异体保留在上表里。

## ⑥ 未覆盖项与本机环境事实

- **明暗两态**未逐态复核（与主题无关的几何已量；暗色观感记为未覆盖）；
- 视口宽度**连续变化**（拖窗口）未逐帧验证：只点了 700 / 1432 / 1920 三点，`max()` 由浏览器算，
  中间值未量；
- 环境抽屉（`min(42vw, 640px)`）**有意不统一**：它是主抽屉内部的第二层抽屉，比主抽屉窄是设计口径。

**本机环境事实（2026-10-03，与本次改动无关，供下一个人别误判成回归）**：

| 现象 | 实测原因 |
|---|---|
| `stored-preference.test.tsx`（12）与 `list-detail-layout.test.tsx`（2）红 | **Node v26.7.0 自带实验性 `localStorage` 全局**（`--localstorage-file` 未给 ⇒ 它是 `undefined`），把 jsdom 那份盖掉了：探针实测 `typeof window.localStorage === 'undefined'`，节点警告原文 `localStorage is not available because --localstorage-file was not provided`。**判据与改动无关**：这两个文件的依赖图只有 react + testing-library |
| `route-run-artifacts.test.ts`（1）/ `route-cases.test.ts`（5）红 | `EPERM, Permission denied` 落在 `%TEMP%\aieval-route-artifacts-*`（机器级临时目录权限/占用），不在抽屉这条链上 |
| `pnpm lint` 16 处缩进错误 | 全部在另一会话当次正在改的行上（`app/runs/page.tsx` 的 `logEnvironment` 块、`packages/client/client/src/build-environment.ts`）；**本次触碰的 4 个文件单独跑 eslint = 0 错**，`pnpm typecheck` 当次全绿 |
