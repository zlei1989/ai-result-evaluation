# 用量里程碑「整行一条」冒烟 + 守卫记录 — 2026-10-07

> 用户口径（2026-10-07，逐字）：
> 「1、dsh 包含本条消息级模型用量，可以直接从 sdk 获得，和最终的轮次结束的用量，subagent 用量只在消息卡片中展示。
> 2、codex 和 claude 无法从 sdk 直接获取消息级模型用量，所以只展示最终的轮次结束的用量，subagent 用量只在消息卡片中展示。」
>
> 补充裁定（同一次对话，选项式确认）：时间轴上那一条是**整行一条**（只在该行结束时出、取终态结算读数）；
> 「消息卡片」= 时间轴上派发点那张**子任务卡片**（`SubagentBar` 的 Card，用量格来自 `SubagentRecord.usage`）。

## 0. 改动落点（一处，界面折行规则）

- `packages/client/ui/src/composite/agent-log/build-model.ts`
  - `rowEventsOf`：`usage` 由「累计创新高就出一条（按会话分水位）」改成「**候选阶段里最后一条主会话带计量的读数**，整行一条」；
    新增两条闸门——候选阶段边界（第一条 `judging` / 终态状态帧，与 `@aieval/client` 的 `row-live.ts` 口径 5 同一条判据）
    与「子会话读数不入折行」；那一条**按事件次序**插回原位（`error` 行的相对顺序不变）。
  - `turnHomesOf`：只收**主会话**的轮次（2026-10-05 那条「不可达子节点不算有家」随子会话里程碑一起退役）。
- 契约、三家适配器、`events.jsonl` 落盘、`EvalRow` 快照、行卡片、抽屉顶部事实条、`usage` 事件的发射口径**一个字节都没动**
  ⇒ 跑动期「tok 在动」那条既有口径不受影响。

改动前的真机症状（run `8df6ff65`，用户点名的 DOM4/DOM5）：
claude-code 行同一轮先出跑动期估算（`输出 0`）、一秒后再出厂商结算值 ⇒ 两条几乎一样的「用量 … · 轮次 4」；
整行共 5 条（轮次 1/2/3/4/4）。根因是 `usage` 事件**每次模型往返一条**、带的是「到目前为止」的累计值，
而旧折行规则按「累计创新高」逐条出行。

## 1. 冒烟

### ① 范围清单

| 项 | 结果 | 证据 |
|---|---|---|
| 里程碑整行一条（claude-code 行） | ✅ | 抽屉里 `[data-row-event]` **1 条**：`用量 输入 15763 · 缓存 45824 · 输出 2164 · 轮次 4`（改前 5 条，含 `输出 0` 的估算那一条） |
| 里程碑整行一条（dsh 行） | ✅ | **1 条**：`用量 输入 42315 · 缓存 165376 · 输出 13607 · 轮次 4`（= `run.json` 的 `row.tokens` 逐字相同） |
| 里程碑整行一条（codex 行，**仍在跑**） | ✅ | **1 条**：`用量 输入 22865 · 缓存 723968 · 输出 20065 · 轮次 25`（= 该行收尾那条读数） |
| dsh 的「本条」页脚与里程碑**共存** | ✅ | dsh 行同屏：里程碑 1 条 + `[data-usage-footer]` `本条 输入 229 · 缓存 13,056 · 输出 906` |
| 子会话节点**不出**里程碑 | ✅ | 进入 dsh 行的子会话（`Review Vue 3 Hello World page`）后 `[data-row-event]` **0 条** |
| 子会话节点里消息级页脚仍在 | ✅ | 同屏 3 条页脚，首条 `本条 输入 913 · 缓存 7,424 · 输出 169`（= `messages.jsonl` 里子会话那条 message 的 `usage`） |
| 子智能体用量只在**子任务卡片** | ✅ | 卡片末尾 `用量 输入 31925 · 缓存 133248 · 输出 10276`（= `run.json` 的 `subagentTokens` 逐字相同） |
| 控制台无错 | ✅ | 38 条 console 消息，error 0 / warning 0 |
| 截图 | ⏭ 跳过 | 判据是「条数 + 文本」，截图读不出条数；与 AGENTS.md「几何断言别靠眼睛」同一条理由 |
| 被杀 / 中断行上「那一条是当时的累计读数」 | ⏭ 跳过 | 本 run 三行都不是被杀，无真机样本；口径写进了用例与 `rowEventsOf` 的注释，留给下次有中断行的 run 复核 |

### ② 操作路径

1. 打开 `http://localhost:3083/runs?panel=detail&id=8df6ff65-6bea-4d8a-94d3-bf5fa1accbd0`（三行都在详情里）。
2. 依次点三行卡片上的「执行日志」（第 1 行 claude-code / 第 2 行 dsh / 第 3 行 codex），每次在抽屉里读
   `[data-row-event]`（里程碑锚点）与 `[data-usage-footer]`（本条页脚）——**刻意数组件自己标的属性，不数 antd 类名**。
3. dsh 行：把虚拟列表滚到顶（`ant-listy-holder.scrollTop = 0`，否则只渲染最后几轮）→ 看到派发点的子任务卡片 →
   点「进入 ▸」→ 数子会话节点的里程碑（0 条）与页脚（3 条）→ 点面包屑「主会话」回主会话，读卡片末尾的用量格。

### ③ 证据（页面 ↔ 落盘互证）

| 行 | 抽屉里的那一条 | `events.jsonl` 里对应的事件 | 与快照对照 |
|---|---|---|---|
| claude-code `ec1edaad` | `15763 · 45824 · 2164 · 轮次 4` @01:59:25 | seq **469**（`timing.source: "vendor"`；改前同轮的 seq 466 估算「输出 0」也各自成行） | — |
| dsh `7aeef3e9` | `42315 · 165376 · 13607 · 轮次 4` @02:00:12 | seq **98**（候选阶段最后一条主会话读数；改前主会话 5 条 + 子会话节点 5 条） | `run.json` `tokens` 逐字相同 |
| codex `016f7ee0` | `22865 · 723968 · 20065 · 轮次 25` @02:14:05 | seq **103** | `run.json` `tokens` 逐字相同 |
| 子会话 `1058d41a…`（dsh 行） | 里程碑 **0 条**；页脚 3 条；卡片 `31925 · 133248 · 10276` | 子会话读数是 `turn.subagentId` 非空的那一类（改前会折成 5 条落在子会话节点） | 卡片值 = `run.json` `subagentTokens` |

命令行侧读数（与上面表格逐条对上）：
`Get-Content events.jsonl | Select-String '"type":"usage"'` 数出 claude 行 12 条 / dsh 行 36 条 / codex 行 26 条
`usage` 事件——事件一条没少，只是**折行**从「逐条」变成了「整行一条」。

### ④ 未覆盖项与后续计划

1. **被杀 / 中断的行**：那一条仍是当时的累计读数（claude 还没等到 `result`），与抽屉顶部事实条同源、不落快照。
   本 run 无样本，留给下次。
2. **「评分读数更高」的形状**：本 run 三行的评分读数都**低于**候选终值（改前靠水位挡住、改后靠候选阶段闸门挡住），
   真机只验到「没被顶掉」；「更高」那一支只有用例（`build-model.test.ts` 的 `judging` 那一条）。
3. **跑动期的移动语义**：codex 行仍在跑时看到一次快照（那一条跟着最新读数走），未做跨分钟的连续观察。

## 2. 守卫与变异验证（每条都见过失败）

`packages/client/ui/src/composite/agent-log/build-model.test.ts` + `agent-message-timeline.test.tsx`：

| 守卫 | 被哪条变异体杀死 |
|---|---|
| 整行只出最后一条候选读数（真机形状：估算 + 结算同轮） | M1 取第一条 / M4 跳过无归属格 / M9 不传 `homes` |
| `error` 逐条进、且那一条按事件次序落位 | M1 / M8 一律追加到末尾 |
| 归属键原样带出；归属轮次整行不存在 ⇒ 抹成 `null` | M1 / M6 不校验「整行真有那一轮」 |
| 子会话读数一条都不出（纯函数 + 可达节点 + 端到端三层） | M2 不拦子会话读数 |
| 子任务卡片的用量格仍有值（防顺手删数据源） | M7 卡片用量改成 `null` |
| `judging` / 终态之后的读数不出（评分智能体的） | M3 不拦候选阶段之后的读数 |
| 老日志（无 `turn` 格、无状态帧）照样出一条 | M1 / M4 |
| 混排「整格缺省 + 显式 `subagentId: null`」只出一条 | M1 / M4 |
| 最后一条读数是 0 也照样出 | M5 加 `total > 0` 闸门 |
| 整条链：算出的那一条渲进对应轮次、子会话节点零行 | M2 / M9 |

变异验证做法：`build-model.ts` 备份 → 逐个变异体改回缺陷 → 跑两个用例文件（51 条）→ 记录变红的用例名 → 还原。
九个变异体全部被杀（最少 1 条红、最多 8 条红），还原后三个文件的 SHA256 与变异前**逐字相同**。

## 3. 门禁

- `pnpm typecheck`：本改动**零报错**。仓库里另有 3 条**既有**报错在
  `packages/server/agents/src/providers/codex/appserver/client.test.ts`（`ProcessEnv` 缺 `NODE_ENV`），
  该文件不在本次 diff 里，与本改动无关（改动前后逐字相同）。
- `pnpm lint`：exit 0，无告警。
- `pnpm vitest run packages/client/ui/src/composite/agent-log/...`：51 条全绿。
- `packages/client/ui` 整包：14 条红全在 `src/base/`（`stored-preference.test.tsx` / `list-detail-layout.test.tsx`），
  原因是本机 Node 的 `localStorage is not available because --localstorage-file was not provided`。
  **已用 `git stash` 把本次改动退回 HEAD 复跑同一批用例：同样 14 条红** ⇒ 既有环境问题，与本改动无关。
