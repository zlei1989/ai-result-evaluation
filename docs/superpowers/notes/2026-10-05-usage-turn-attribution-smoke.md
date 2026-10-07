# 用量里程碑归位（`usage.turn`）真机冒烟记录 — 2026-10-05

> 对应任务：Task 9（本计划最后一个任务）。
> 权威设计：`docs/superpowers/specs/2026-10-05-usage-turn-attribution-design.md` §3.3（门禁与冒烟）。
> 本记录按 AGENT.md 的「冒烟测试」四要素写：① 范围清单 ② 操作路径 ③ 证据 ④ 未覆盖项与后续计划。

## 0. 冒烟对象与结论一句话

- **新 run id**：`155f7f1e-fa9f-48c5-8c1f-b58caa63eb31`（用例「简单测试」，并行，三家各一行）。
- **为什么必须跑新的一轮**：旧的 `2921fee3` 那一轮的事件在本次改动**之前**落的盘、`usage` 里**没有 `turn` 格**，
  验不了归位；本轮全部 `usage` 事件都带 `turn`。
- **结论**：三行（+ dsh 子会话节点）**判据全通过，无 ❌**。
  每条「用量 … · 轮次 N」都渲染在 `data-turn-row="round-N"` 那一行里，没有一条落错行、没有一条消失。

## 1. 范围清单

| # | 检查项 | 结果 | 依据 |
|---|---|---|---|
| 1 | 用真实用户路径跑一轮新评测（三家都选上、都落终态） | ✅ | 新 run `155f7f1e`，三行 `status=judged`；§2 |
| 2 | claude-code 行：每条里程碑落在同号轮次 | ✅ | round-1/2/3 各就各位；§3.1 |
| 3 | codex 行：每条里程碑落在同号轮次 | ✅ | 唯一一条落在 round-18；§3.2 |
| 4 | dsh 行（主会话节点）：每条里程碑落在同号轮次 | ✅ | round-1/2/3 各就各位；§3.3 |
| 5 | 条数与「创新高才出一条」的条数一致（不增不减） | ✅ | 三行均逐条对账；§3.4 |
| 6 | dsh 子会话节点：里程碑与**该节点自己的**轮次号一致（跨会话不串） | ✅ | 子节点 round-1/2，主会话的 round-3 **未**出现；§4 |
| 7 | CLI 侧互证：`usage.turn.round` ⊆ 该行 `messages.jsonl` 的 `roundTrip` 取值集合 | ✅ | 三行都成立；§5 |
| 8 | CLI 侧互证：codex 主线程消息最大 `roundTrip` == 最后一个 `usage.turn.round` | ✅ | 18 == 18；§5.2 |
| 9 | CLI 侧互证：dsh `usage.turn.subagentId` 与消息 `subagentId` 同一套 id | ✅ | `48b5bcf6-…` 两侧一致；§5.3 |
| 10 | 记录写进 `docs/superpowers/notes/2026-10-05-usage-turn-attribution-smoke.md` | ✅ | 本文件 |
| 11 | 全量门禁 `pnpm test`（三包聚合） | ⏭️ 跳过 | 见 §7：本机从仓库根聚合跑 vitest 会卡死（Task 2 / Task 8 两次实测）；按仓规全量留给门禁，本轮不改产品代码、不做回归判定 |
| 12 | `pnpm lint` | ⏭️ 跳过 | 同上：本轮只跑/只看/只记录，无代码改动可 lint；lint 的结论由本任务的实现任务各自负责 |
| 13 | codex 行「多轮、多条里程碑」这条更难的情形 | ⏭️ 跳过（未覆盖） | 本轮的 codex 行**只产出了 1 条**里程碑（原因见 §3.2：20 条 usage 事件里只有最后两条带 `tokens`，且两条数值完全相同 ⇒ 按高水位规则只出一条）⇒ 这一条只验到「那 1 条没有落错行」，**没验到**「多条里程碑各按自己的号归位」；后者只在 claude-code / dsh 上覆盖 |

## 2. 操作路径（真实用户路径，逐字点击序列）

服务：`pnpm dev` 已在 `http://localhost:3083` 运行（PID 20992，`/api/providers` 与 `/` 均 200）。**未另起服务器。**

| 步 | 动作 | 落点 |
|---|---|---|
| 1 | 新开标签页 → `http://localhost:3083/runs?panel=new`（「创建评测」入口） | 右栏 = 新建表单 |
| 2 | 点「用例」下拉 → 选 `简单测试 · proj · 默认分支 HEAD` | 用例 = `d899e825-8378-4a4e-aea3-f2dfec53ea0b` |
| 3 | 候选 1 的「智能体」下拉 → 选 `Claude Code`；「模型」下拉 → 选 `deepseek-flash (deepseek-anthropic)` | 第 1 候选就位 |
| 4 | 点「添加候选」→ 候选 2「智能体」→ `Codex`；「模型」→ `deepseek-flash (deepseek-openai)` | 第 2 候选就位 |
| 5 | 点「添加候选」→ 候选 3「智能体」→ `DeepSeek Harness`；「模型」→ `deepseek-flash (deepseek-openai)` | 第 3 候选就位 |
| 6 | 执行模式单选 → `并行` | 创建前定稿 |
| 7 | 点「确定」 | 新 run 创建成功 → URL 变为 `…/runs?panel=detail&id=155f7f1e-fa9f-48c5-8c1f-b58caa63eb31` |
| 8 | 点页脚「开始」（运行级） | 弹出确认框 |
| 9 | **确认框里的**「开始」（`.ant-modal-confirm-btns button.ant-btn-primary`） | 三行同时开跑（并行） |
| 10 | 轮询等三行落终态 | `run=done`，三行均 `judged` |

> ⚠️ 第 8 步与第 9 步是**两个**按钮：只点页脚的「开始」只会弹确认框（实测点了之后 200 秒
> `run.json` 仍是 `idle` + 三行 `pending`），必须再点确认框里的「开始」才真的开跑。
> 记录这一条是因为它容易被当成「点了没反应」。

三行（按界面排名顺序，即「执行日志」按钮的 DOM 次序；耗时为**终态**读数，取自行卡片与 `run.json`）：

| 界面排名 | 家 | 行 id | 耗时（终态卡片 / `run.json`） |
|---|---|---|---|
| 第 1 名 | DeepSeek Harness | `2fb86bb2-edff-454c-8f20-d901d52729f9` | 21s / `21338` ms |
| 第 2 名 | Claude Code | `d753e186-7ed3-427d-99ab-807fc75088bd` | 29s / `29309` ms |
| 第 3 名 | Codex | `8857c1e8-c97a-4e5f-bec2-df3e1640b416` | 9m46s / `586009` ms |

> 三行的终态行卡片（DOM `innerText` 原文，用于和 §3 的抽屉读数区分开）：
>
> ```
> DeepSeek Harness   tok 7,355   缓存命中 91%  轮次 5  耗时 21s  得分 57
> Claude Code        tok 36,370  缓存命中 59%  轮次 5  耗时 29s  得分 57
> Codex              tok 118,205 缓存命中 98%  轮次 21 耗时 9m46s 得分 57
> ```
>
> `run.json` 同刻读数：dsh `turns=5 subagentTurns=2`、claude-code `turns=5 subagentTurns=2`、
> codex `turns=21 subagentTurns=3`。
> （早前轮询时看到的 dsh `24s` / claude-code `26s` 是**运行中途**的读数，终态以本表为准。）

## 3. 页面侧逐行核对（读 DOM，不靠截图）

方法：对每一行点「执行日志」打开抽屉，然后用 `browser_evaluate` 读 `[data-turn-row]`：

```js
() => [...document.querySelectorAll('[data-turn-row]')].map((row) => ({
  key: row.getAttribute('data-turn-row'),
  usage: [...row.querySelectorAll('.ant-tag')].map((t) => t.textContent).filter((t) => t?.startsWith('用量')),
}))
```

⚠️ **抽屉是虚拟滚动**（实测每行的 `scrollHeight` 远大于 `clientHeight`，如 claude-code 行 1364 / 476、
codex 行 7483 / 476），只有可见的轮次行在 DOM 里 ⇒ 先 `scrollTop = 0` 读一遍，再按
「`clientHeight - 60`」步进推到 `scrollHeight`（每步停 350ms）并逐次读，最后再补一次 `scrollTop = scrollHeight`，
把各次读到的行按 `data-turn-row` 合并去重，才得到**完整**清单。

**判据**：每条用量标签里的 `轮次 N` 都必须出现在 `data-turn-row="round-N"` 那一行里；
没有一条落在别的轮次行里；条数与「用量创新高」的条数一致。

### 3.1 claude-code 行（`d753e186…`）

```
round-1  ← 用量 输入 14305 · 缓存 0 · 输出 0 · 轮次 1
round-2  ← 用量 输入 14527 · 缓存 15616 · 输出 0 · 轮次 2
round-3  ← 用量 输入 15830 · 缓存 31872 · 输出 0 · 轮次 3
           用量 输入 15830 · 缓存 31872 · 输出 2495 · 轮次 3
```

判定：3 个轮次行、4 条用量标签，**逐条同号**（`轮次 1`→round-1、`轮次 2`→round-2、两条 `轮次 3`→round-3），
程序化对账 `misplaced = []`。✅

> 对照旧行为（spec §1.1 的实测表）：同一功能改动前，claude-code 的 5 条里 4 条挤在最后一轮、只有 `轮次 1` 碰巧对。
> 本轮 4 条**全部**就位。

### 3.2 codex 行（`8857c1e8…`）

```
round-18 ← 用量 输入 41548 · 缓存 2592384 · 输出 76657 · 轮次 18
```

判定：`轮次 18` 落在 `data-turn-row="round-18"`，`misplaced = []`。✅

> **为什么只有一条**（如实登记，这是本轮覆盖面的限制）：该行 20 条 `usage` 事件里，
> 前 18 条 `tokens` 全是 `null`（轮次刚起、还没有读数），只有 `seq=129` 与 `seq=132` 带数值，
> 且两条**完全相同**（41548 / 2592384 / 76657）；`build-model.ts:684` 的规则是 `total <= highWater` 就跳过
> ⇒ 只出一条里程碑。**这不是缺陷**，是「创新高才出一条」的既定语义。
> 但代价是：codex 这一行这轮验不到「多条里程碑各归各轮」，只验到「那一条没有落错行」。

### 3.3 dsh 行 / 主会话节点（`2fb86bb2…`）

```
round-1  ← 用量 输入 295 · 缓存 7424 · 输出 841 · 轮次 1
round-2  ← 用量 输入 505 · 缓存 15872 · 输出 1403 · 轮次 2
round-3  ← 用量 输入 3871 · 缓存 40832 · 输出 3484 · 轮次 3
```

判定：3 个轮次行、3 条用量标签，逐条同号，`misplaced = []`。✅
另：该行行卡片显示「轮次 5」（整行 = 主 3 + 子 2；`run.json` 的 `turns=5`、`subagentTurns=2` 正是这个 5），
而时间轴只有 3 轮（= 当前节点）——这正是 spec §2.5 显式登记的「两个尺度」，**不是本次引入的矛盾**。

### 3.4 条数对账（不增不减）

⚠️ **水位是「行级共享」的，不是每个会话各自一个**：`build-model.ts:676` 的 `highWater` 在**整行**范围内单调递增
（主会话与子会话的读数共用一个水位），`total <= highWater` 就跳过。所以「哪几条成为里程碑」不能按单个会话
自己复算——必须按**整行时间序**复算。dsh 那一格下面给了完整的水位推进序列。

| 行 | 抽屉里的用量标签数 | 磁盘上「创新高」的条数（整行水位序列） | 一致？ |
|---|---|---|---|
| claude-code | 4 | 4（无子会话读数，四条元组互不相同且逐条抬高） | ✅ |
| codex | 1 | 1（`seq=129` 与 `seq=132` 两条元组**完全相同** ⇒ 第二条撞 `<=` 被跳过） | ✅ |
| dsh 主会话 | 3 | 3（整行水位共 5 步，其中主会话占 3 步，见下） | ✅ |

dsh 行的**整行**水位序列（按整行时间序，括号内为元组之和 `输入+缓存+输出`）：

```
8560  (主 r1: 295 + 7424 + 841)
17780 (主 r2: 505 + 15872 + 1403)
26130 (子 r1: 1323 + 23296 + 1511)
36983 (子 r2: 2325 + 31616 + 3042)
48187 (主 r3: 3871 + 40832 + 3484)
```

⇒ 整行共 5 条创新高。其中**前两条与最后一条**归主会话节点（`subagentId: null`）⇒ 主会话节点 3 条；
中间两条归子会话节点 ⇒ 子节点 2 条。3 + 2 = 5，与抽屉实测（主节点 3 条、子节点 2 条）一致。✅

> 这一条正是「行级水位」的直接证据：主会话 r3 的**更早**那一条读数（2325/31616/3042，和 36983）
> 之所以没成为里程碑，是因为**子会话**已经把整行水位抬到 36983 —— 不是因为它比主会话自己前一条低。
> 若按「每个会话各自一个水位」复算，会得到 4 条主会话里程碑，与 DOM 的 3 条**不符**。

### 3.5 复核方式（避免虚拟滚动漏读 / 抽屉串味）

第一次逐行读时，三次读**共用了同一个抽屉实例**（关闭再打开），合并结果可能在实例之间串味。
为排除这一点，做了**隔离复读**：每行先关干净抽屉（点 `.ant-drawer-close` 并等 900ms），
再点该行自己的「执行日志」，每行独立合并、独立判定。两次结果**逐字一致**，
且隔离复读里每行都额外输出了 `misplaced: []`（程序化判据，不是肉眼比对）。

两次运行的逐条对账（`misplaced` = 「标签里的 `轮次 N` 与本行 `data-turn-row` 不同号」的清单）：

```
首轮（共用抽屉实例）    0_dsh: rows=3 tags=3  1_claude: rows=3 tags=4  2_codex: rows=1 tags=1
隔离复读（各自新抽屉）  0_dsh: rows=3 tags=3 misplaced=[]  1_claude: rows=3 tags=4 misplaced=[]  2_codex: rows=1 tags=1 misplaced=[]
```

两次的 `rows` / `tags` 计数与逐行内容完全相同（`misplaced` 两次都是空），
即「共用抽屉」这次没有造成漏读或串味。隔离复读的完整读数见 §3.1–§3.3 的三段代码块。

## 4. dsh 子会话节点（跨会话不串的另一面）

dsh 行里有子任务占位条：`子任务 Review Vue 3 page 已完成 进入 ▸ 重试`。
点「进入 ▸」进子会话节点后，同样读 `[data-turn-row]`：

```
round-1  ← 用量 输入 1323 · 缓存 23296 · 输出 1511 · 轮次 1
round-2  ← 用量 输入 2325 · 缓存 31616 · 输出 3042 · 轮次 2
（该节点共 2 轮）
```

判定：子节点上两条里程碑的 `轮次 N` 与该节点自己的 `round-N` 一致（1→round-1、2→round-2）。✅

**更关键的反面**：主会话的 `轮次 3` 里程碑（输入 3871 · 缓存 40832 · 输出 3484）**没有**出现在子会话节点里；
子会话的两条（元组之和 26130 与 36983，见 §3.4 的水位序列）也**没有**出现在主会话节点里。
即「有键但对不上本节点 ⇒ 本节点不显示」这条规则在真机上生效，两个会话节点**没有互相串**。✅

## 5. CLI 侧互证（磁盘事实）

命令（`$run` = 新 run id，`$row` = 该行 id）：

```powershell
Get-Content "D:\.tmp\aieval\runs\$run\rows\$row\events.jsonl" -Encoding UTF8 |
  Select-String '"type":"usage"'
Get-Content "D:\.tmp\aieval\runs\$run\rows\$row\messages.jsonl" -Encoding UTF8 |
  Select-String '"roundTrip"'
```

> 注意：`roundTrip` **不在** `messages.jsonl` 的顶层，而在 `message` 里
> （`{"type":"message","message":{…,"roundTrip":1,…}}`）⇒ 直接 `Select-String '"roundTrip"'` 能看到行，
> 但要做集合运算得取 `$_.message.roundTrip`。
> 另：`messages.jsonl` 的**行数 ≠ 消息条数** —— 文件里还混着 `type="subagent"` 的行
> （claude-code 3 行、dsh 2 行、codex 59 行）。本节计数一律写成「N 行（M 条 message）」。

### 5.1 claude-code 行

`events.jsonl` 的 `usage`（4 条）：

```
seq=69  turns=1 turn.round=1 turn.subagentId=null
seq=221 turns=2 turn.round=2 turn.subagentId=null
seq=294 turns=3 turn.round=3 turn.subagentId=null
seq=297 turns=3 turn.round=3 turn.subagentId=null
```

`messages.jsonl` 17 行（14 条 `message` + 3 行 `subagent`）；`message.roundTrip` 取值集合 = `{1, 2, 3}`（主线程同集合）。

⇒ `turn.round` 集合 `{1,2,3}` ⊆ `roundTrip` 集合 `{1,2,3}`。✅
（`turns` 与 `turn.round` 在这行重合，是因为 claude-code 的读数只由主循环触发、且无子智能体读数进这一格。）

### 5.2 codex 行（两把尺子合一）

`events.jsonl` 的 `usage`（20 条）`turn.round` 依次为 `1..18`，其中带数值的两条：

```
seq=129 turns=18 turn.round=18 tokens={41548, 2592384, 76657}
seq=132 turns=21 turn.round=18 tokens={41548, 2592384, 76657}
```

`messages.jsonl` 1288 行（1229 条 `message` + 59 行 `subagent`）主线程（`subagentId === null`）`roundTrip` 取值集合 =
`{1,2,3,…,18}`，**最大值 18**；子线程 `subagentId` = `01a10d4c-4553-7890-b206-511f6b0cab32`。

⇒ **主线程消息的最大 `roundTrip`（18）== 最后一个 `usage.turn.round`（18）**：两把尺子合一。✅
  ⚠️ **限定半句**（2026-10-05 终审 Important 2）：这**只**指**主线程**与 `usage.turn` 之间；
  **子节点自己的轮次与行合计的子分量 `subagentTurns` 仍不同源**——前者按 `AgentMessage` 条目数
  （子节点时间轴排到 round 13），后者按会话文件的 `turn_id` 数（本行 `subagentTurns = 3`）
  ⇒ **行卡片的「轮次 21（主 18 + 子 3）」与两个节点显示的 18 轮 / 13 轮互不自洽**（18 + 13 ≠ 21）。
  这不是本次引入的（旧口径下子节点会显示 ~36 轮），且真修要动 `EvalRow.turns`（spec §2.5 明文不动）
  ⇒ 本次**只登记、不改计算**。
⇒ 且 `turn.subagentId` 恒为 `null` ⇒ 里程碑只出现在主会话节点，子线程节点不会再「碰巧同号」。✅

### 5.3 dsh 行（子会话 id 同一套）

`events.jsonl` 的 `usage`（12 条）按 `(subagentId, turn.round)` 归组：

```
主会话 (null)                          : round 1, 2, 3
子会话 48b5bcf6-1788-4c72-bcce-2af5ea3f84b1 : round 1, 2
```

`messages.jsonl` 13 行（11 条 `message` + 2 行 `subagent`）按会话分组：

```
sub=<main>                                      rounds=[1,2,3]
sub=48b5bcf6-1788-4c72-bcce-2af5ea3f84b1        rounds=[1,2]
```

⇒ `usage.turn` 的 `subagentId` 与消息的 `subagentId` 是**同一套 id**（`48b5bcf6-…`），
且**同一套号**（主 1/2/3、子 1/2）。✅
⇒ 「per-session `step`」这一改动在真机上落地：主会话时间轴是 `1,2,3`（不再是旧的 `1,2,5,6`，不再有洞），
而 `state.turns`（行级）仍是全局自增（主会话 usage 的 `turns` 走到 5，见 `seq=53/55/57`）。✅
（对照：旧 run `2921fee3` 的 dsh 主会话 `roundTrip` 恰为 `{1,2,5,6}` —— 正是这次改动要消灭的「有洞的号」。）

## 6. 本机环境事实（本轮实测）

> 这一节存在的理由：**「门禁红」怎么读**取决于机器状态与预存红。不写清楚，下一个人会把预存红当成回归。

1. **根级聚合 vitest 会卡死**（Task 2 与 Task 8 两次实测；**本轮第三次复现，取到了判据读数**）。

   ⚠️ 复现路径要说清楚：本轮跑的是
   `pnpm vitest run packages/server/evaluator`（**路径过滤**）。
   仓库根 `vitest.config.ts` 用 `projects` 收齐 8 个包 ⇒ 这条命令仍然**先起全部 8 个 project 的 server**，
   再按路径筛用例。也就是说它走的是**根级聚合那条路**，不是单包路径
   （单包应走 `pnpm --filter @aieval/evaluator test`）。**下一个人想避开卡死就得走单包命令。**

   本轮观测到的形状（这就是「卡死」的判据）：

   ```
   vitest 进程 PID=20356  启动 02:32:47
   log 最后写入 = 02:32:59      ← 此后 8 分钟以上再无任何输出
   观测时刻     = 02:41:22
   PID=20356 CPU = 13.4s  WS = 510MB   ← 13 秒 CPU 摊在 8 分钟里 ≈ 1%，**不是死循环跑满，是挂着不动**
   ```

   跑到哪儿停的（`@aieval/evaluator` 27 个测试文件里**只有 6 个**出了完成行）：

   ```
   ✓ |@aieval/evaluator| src/static-assertions.test.ts (6 tests) 15ms
   ✓ |@aieval/evaluator| src/judge.test.ts (27 tests) 23ms
   ✓ |@aieval/evaluator| src/judge-route.test.ts (13 tests) 53ms
   ✓ |@aieval/evaluator| src/events.test.ts (9 tests) 87ms
   ✓ |@aieval/evaluator| src/run-store.test.ts (27 tests) 185ms
   ✓ |@aieval/evaluator| src/text-api.test.ts (32 tests) 10935ms
   （没有 `Test Files` / `Tests` / `Duration` 汇总行 = 没跑完）
   ```

   ⇒ **27 个文件里 21 个没跑完**（6 完成 / 27 总数），与既有的「20 个未跑完」同一现象。
   ⇒ 本记录里的测试结论**都不来自**根级聚合；`route-runs.test.ts` 那一条是**单文件**路径跑出来的（§6.3）。
2. **仓库级 `pnpm typecheck` 红 3 条**（本轮实操复跑，非转抄）：

   ```
   EXIT=1   （error TS 计数 = 3）
   packages/server/agents/src/providers/codex/appserver/client.test.ts(70,71): error TS2741: Property 'NODE_ENV' is missing in type '{}' but required in type 'ProcessEnv'.
   packages/server/agents/src/providers/codex/appserver/client.test.ts(161,7): error TS2741: Property 'NODE_ENV' is missing in type '{}' but required in type 'ProcessEnv'.
   packages/server/agents/src/providers/codex/appserver/client.test.ts(172,57): error TS2741: Property 'NODE_ENV' is missing in type '{}' but required in type 'ProcessEnv'.
   ```

   3 条**全部**落在 `codex/appserver/client.test.ts` —— 该文件属于**并发会话的未跟踪改动**
   （`git status` 显示 `?? packages/server/agents/src/providers/codex/appserver/client.test.ts`），
   **不是本计划的改动**。按仓规「`git status` 里出现不属于你的文件时保持原样」，本轮**未动**该文件。
   本轮 `git status` 里不属于本任务的文件（`M docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`、
   `?? …codex-subagent-messages-alternatives.md`、`?? …codex-appserver-thread-source.md`、
   `?? …codex/appserver/client.ts` 与 `client.test.ts`）**全程原样未动**。
3. **预存红 3 类**（与本计划无关，确定性）：
   - claude-code 的 **8.3 短名**用例：`providers/claude-code/index.test.ts:173`
     「cwd 做 realpath 归一：8.3 短名路径不得原样交给 SDK」。该用例自带跳过保护
     （`tmpdir()` 不含 `~1` 时 `ctx.skip`），本机 `tmpdir()` 是短名形态
     （`C:\Users\ZHANGL~1\AppData\Local\Temp`）⇒ 前提成立、**真跑**。
     ⚠️ 本轮**未**单独复跑该文件（时间预算给了冒烟本身），归类依据是任务书给定的既有实测；按「未见失败证据」的仓规，
     **这一条在本轮是「未复核」而不是「已确认」**。
   - `evaluator/core/api/web-next` 的 **`rmSync` EPERM 家族**（Windows 上测试清理临时目录时被杀软/索引器占用）。
   - web-next `route-runs.test.ts:400` 的 `/api/runs/model-options` **键集合钉未跟上 `messageCapability`**：
     **本轮复跑，确认确定性红**：

     ```
     FAIL |@aieval/web-next| src/route-runs.test.ts > GET /api/runs/model-options
          > 按协议过滤候选池，并带上三种智能体的能力元数据
     AssertionError: expected [ 'agentKind', 'cancelMidTurn', …(5) ] to deeply equal [ 'agentKind', 'cancelMidTurn', …(4) ]
     Test Files  1 failed (1)
          Tests  1 failed | 22 passed (23)
     ```

     即 `route-runs.test.ts:400` 钉的键集是 6 格（`agentKind` / `cancelMidTurn` / `efforts` / `options` /
     `protocolTypes` / `usage`），而实现（`packages/server/api/src/runs.ts:450`）已多出第 7 格 `messageCapability`
     ⇒ 「谁偷偷加字段都会在这里失败」这道守卫**按设计真的响了**，钉没有跟着更新。
     注意：**这不是本计划的改动**（`messageCapability` 属 spec v3 的另一条线），但它是**在途的失败面**。
4. **TEMP 有 `aieval-*` 残留未清**：本轮清点，`$env:TEMP` 下有大量 `aieval-cases-*` / `aieval-evaluator-*` /
   `aieval-origin-template-*` / `aieval-remote-template-*` / `aieval-route-cases-*` / `aieval-ws-*` /
   `aieval-codex-*` 目录，以及 `aieval-*.log` / `aieval-*.mjs` / `aieval-*.txt` 文件（最早可追到 2026-10-02）。
   按裁定**本轮不动**（谁都不该顺手删别人的证据）；建议人工清空后复跑一次全量门禁，以把 EPERM 家族的影响面缩小。
5. **`@aieval/evaluator` 27 个测试文件里 20 个未跑完**。
   本轮实测复现并取到读数：27 个文件里**只跑完 6 个**（21 个未跑完），卡死点与读数见 §6.1。
   因此**没有**可用的 evaluator 全量结论；本计划对 evaluator 的判定**不依赖**该全量
   （归位逻辑的守卫在 contracts / agents / ui 三处，各有自己的文件级用例）。
6. **`pnpm.ps1` 被执行策略拦** ⇒ 本轮全部用 `pnpm.cmd`（`D:\nvm4w\nodejs\pnpm.cmd`）。
7. **vitest 4 没有 `--reporter=basic`**：本轮第一次跑测试时用了 `--reporter=basic`，
   报 `loadCustomReporterModule` / `RunnerError` 而**不是**测试失败。换默认 reporter 后正常。
   记这一条是为了避免下一个人把「reporter 用错」误读成仓库红。

## 7. 变异验证证据（计划 §3.2 的六个变异体 + 各任务补做的）

> 仓规：**没见过失败的守卫不算守卫**。本计划新增的每条守卫都把它要拦的缺陷**人为造回去**，
> 确认变红、再还原并核对哈希。本节把证据**全部内联**（不引用 `.superpowers/…` 的工作区文件——
> 那个工作区在终审后会删，引用会悬空）。
>
> 表内「守卫红了」一律给：**用例名 + 失败原文一句 + 红数**；「还原」一律给 **SHA256 前 12 位**或
> 「`git diff` / `git status` 对该文件为空」。
>
> ⚠️ 命名冲突提醒：各任务**各自**从 M1 开始编号，所以「M2」在下面两张表里指**不同**变异体
> （计划 §3.2 的 M2 = 删 `noteDshSessionTurn`；任务书 Task 2 的 M2 = 草稿去掉 `turn: liveTurn`）。
> 表里用「§3.2-Mn」与「Task n-Mn」区分。

### 7.1 计划 §3.2 点名的六个变异体（全部有失败证据）

| # | 变异体（人为制造的缺陷） | 它要拦的缺陷 | 守卫红了（用例名 + 失败原文） | 还原 |
|---|---|---|---|---|
| §3.2-M1 | dsh：`roundTrip` 改回**全局** `state.turns` 计数 | 守卫 4「主会话的号不被别的会话推高」（`1,2,3` 而不是 `1,2,5,6`） | `src/providers/dsh/events.test.ts > projectDshNotification：归属（每会话自己的 step） > 消息的轮次号是**该会话自己的** step：别的会话插进来也不会把它推高`<br>`AssertionError: expected 1 to be 2 // Object.is equality`<br>红数 `1 failed \| 92 passed (93)`（2 个文件） | ✅ `hash=3080E64F9308`（`restored-identical=True`） |
| §3.2-M2 | dsh：`step/start` 分支删掉 `noteDshSessionTurn(sessionId)`（每会话计数不再维护） | 守卫 6「`turn/end` 归到该会话最后一个 step」＋ `subagentTurns` 分量（两条独立机制） | **7 条红、分布在 2 个文件**：<br>`events.test.ts`（1 条）`× 归属带上会话身份：子会话的 step 归到它自己名下；turn/end 归到该会话最后一个 step`<br>`index.test.ts`（6 条）`× 端到端：轮次在 step/start 就涨（不等模型回答），计量一到补一条，收尾不重复发` / `× 两个 step：轮次实时涨到 2，计量是**累计**值` / `× 子会话的 step/start 单独计入分量，且与合计**同一条事件**上同刻更新（主 1 + 子 1）` / `× 子会话跑了 3 轮 ⇒ 分量 3，合计主 1 + 子 3` / `× 白名单里的子会话跑过 2 轮 ⇒ 分量是 2，合计同刻为 3（主 1 + 子 2）` / `× turn/end 也带分量：正常与失败两条出口都是最新值`<br>汇总 `Test Files 2 failed (2)` / `Tests 7 failed \| 86 passed (93)` | ✅ `3080E64F93089A74…`（前后逐字节一致，`=> 逐字节一致 OK`） |
| §3.2-M3 | codex **文件侧**把 `Reasoning` 加回计数键（`MODEL_ITEM_TYPES`） | 守卫 8「会话文件里推理条目不再推高轮次号」 | `src/providers/codex/transcript.test.ts > 会话文件 → 消息与子任务行（spec v3 §2 / §4.2） > 会话文件的轮次只数 AgentMessage：推理条目不推高号，重复…`<br>`AssertionError: expected [ 1, 2, 3, 3 ] to deeply equal [ 1, 1, 1, 1 ]`<br>（事件流侧同一规则另有 `codex/events.test.ts` 的 M1：`expected 1 to be null`） | ✅ `RESTORED SHA256=2B250F84978A… SAME-AS-BASELINE=True` |
| §3.2-M4 | 界面：有键但**本节点对不上**的里程碑回落成按时刻 | 守卫 14「有键但对不上 ⇒ 本节点不显示」（回落就是用户报的那个毛病） | `src/composite/agent-log/agent-message-timeline.test.tsx > AgentMessageTimeline > 有归属键的里程碑按「会话 + 号」归位；对不上本节点的不显示；无键的仍按时刻`<br>`AssertionError: expected '轮次 118:44:31第一轮主会话第 2 轮的用量18:44:31' not to contain '主会话第 2 轮的用量'`<br>红数 `1 failed \| 11 skipped (12)` | ✅ `310FA679BF3E…`（前后一致，「逐字节一致 OK」） |
| §3.2-M5 | 契约：`turn` 去掉 `.optional()`（写成**必填**） | 守卫 1「老 `usage` 行（没有 `turn` 格）解析成功」 | `src/agent-event.test.ts` 里 `usage` 的归属格那一组：<br>`usage 的归属格 turn 可缺可空、带上时原样保留（老日志必须照样解析）`（`:157`）<br>`usage 的计量是三个数字…`（`:74`）<br>`usage 的 reasoningOutput / total 可空、可缺，但不接受非数字`（`:181`）<br>`status 成员只接受 EvalRowStatus 的取值…`（`:238`）<br>`exit 1`，`Tests 1 failed \| 21 skipped (22)`（整格缺席那一条先撞红）<br>（同组另两个变异体：M1 `round` 去掉 `.int().positive()`、M3 `turn` 去掉 `.nullable()`，各自也 `exit 1` + 同样红数） | ✅ `baseline sha256 = 1B7D7CACA386350A…` = `restored sha256`，`HASH UNCHANGED = True` |
| §3.2-M6 | 骨架：`sameUsage` 去掉 `if (!sameTurn(previous.turn, turn)) return false;` | 「只有归属变了的读数也要再发一条」（否则界面停在旧轮次） | `src/turn.test.ts`（Task 2 记为「`expected [ Array(2) ] to deeply equal [ Array(3) ]`，缺的正是 `{ subagentId: 'child-1', round: 1 }`——只有归属变了的那条被去重吃掉」） | ✅ 该次变异后 `turn.ts` / `emit.ts` 的 SHA256 与备份逐字节相同，且 `git grep MUTATION HEAD` 无命中 |

**六个变异体全部有失败证据** ⇒ 计划 §3.2 的「至少这些变异体必须有失败证据」这一条**满足**。

### 7.2 各任务补做的变异体（超出 §3.2 的六个，按任务列出）

这些是各实现任务在自己的范围内额外做的守卫变异（同样每条都见过失败）。列出来是为了说明
**每个新增守卫都有区分力**，而不是「顺带绿」。

| 变异体 | 人为制造的缺陷 | 守卫红了（用例名 + 失败原文一句） | 还原 |
|---|---|---|---|
| Task 1-M1 | 契约 `round: z.number().int().positive()` → `z.number()` | `agent-event.test.ts` 的 `round: 0` / `round: 1.5` 两档：`exit 1`，`Tests 1 failed \| 21 skipped` | ✅ 同 M5 的哈希基线 |
| Task 1-M3 | 契约 `turn` 去掉 `.nullable()` | `agent-event.test.ts` 显式 `null` 那一档：`exit 1`，`Tests 1 failed \| 21 skipped` | ✅ 同上 |
| Task 2-M1 | `emit.ts` 的 `withMeta` 去掉 `turn: draft.turn,` | `emit.test.ts`：`1 failed \| 5 passed`（红的正是新用例） | ✅ `2181626489015A15…AFD833B` |
| Task 2-M2 | `turn.ts` 的事件草稿去掉 `turn: liveTurn,` | `expected [ undefined, undefined, undefined ] to deeply equal [ Array(3) ]` | ✅ `BDD5EC2A9B78C80F…E67565` |
| Task 2-M4 | `liveTurn` 改成**结转**上一条（`projection.turn ?? emittedUsage?.turn ?? null`） | 第三条期望 `null`，实得 `{ subagentId: 'child-1', round: 1 }`（钉「不结转」这条语义） | ✅ 逐字节相同 |
| Task 3-M2 | dsh：归属丢掉**会话身份** | `events.test.ts`：`AssertionError: expected { subagentId: null, round: 1 } to deeply equal { subagentId: 'child-1', round: 1 }`（原文被截断为 `…'child-1', round: 1 }`） | ✅ `hash=6B6B7FB929B6` |
| Task 3-M3 | dsh：`turn/end` 缺 `data.step` 时**不回落**到该会话上一个 step | `events.test.ts`：`expected null to deeply equal { subagentId: 'child-1', round: 1 }`；另有 `index.test.ts` 2 条 → `Tests 3 failed \| 90 passed (93)` | ✅ `hash=6B6B7FB929B6` |
| Task 3-M4 | dsh：**行级** `turns` 也改成每会话计数 | 5 条红（`轮次继续含子会话的 step（既成事实的守卫）`、`归属按每会话自己的 step 走，而 turns 仍是全树合计（两把尺子不互相顶替）`、`子会话的 step/start 单独计入分量，且与合计同一条事件上同刻更新`、`子会话跑了 3 轮 ⇒ 分量 3，合计主 1 + 子 3`、`白名单里的子会话跑过 2 轮 ⇒ 分量是 2，合计同刻为 3`）→ `Tests 5 failed \| 59 passed (64)` | ✅ `hash=3080E64F9308` |
| Task 4-M1…M6 / F1…F6 | claude-code：四个出口的 `turn` 分别删掉或硬编码 `round: 1`；去掉侧链早返回；无号时编 `round: 0` | 逐条命中 `events.test.ts` 的两条用例（`usage 投影带归属（主会话 + 主循环计数）；侧链消息不带归属也不发 usage`、`result 的每个返回点都带归属；一次号都没数到时整格是 null（不编一个号）`、`归属的轮次是数出来的：第二条主循环消息之后，四个出口都报 round 2`、`子智能体的消息不计入轮次、也不计用量`）；典型 `expected undefined to deeply equal { subagentId: null, round: 1 }` / `expected { subagentId: null, round: +0 } to be null` | ✅ 每条「还原后 blob 哈希与基线一致 = True」（基线 `b50c48b` / `b44bd3f`） |
| Task 5-M1…M8 | codex：把 `reasoning` 加回计数键（事件流 / 会话文件两侧）、`turn.completed` 与 item 出口的 `turn` 写成 `null`、丢掉 `itemId` 去重、收尾 usage 归属写成 `finalTurns` / 硬编码 `1` / 回到 `null` | 命中 `codex/events.test.ts`（`轮次只数 agent_message（按 item.id 去重）；reasoning 条目不再推高`：`expected 1 to be null`；`turn.completed：只交计量…`：`expected null to deeply equal { subagentId: null, round: 1 }`）、`codex/transcript.test.ts`（`expected [ 1, 2, 3, 3 ] to deeply equal [ 1, 1, 1, 1 ]`；去重那条 `expected [ 1, 1, 1, 2 ] to deeply equal [ 1, 1, 1, 1 ]`）、`codex/index.test.ts`（`收尾那条 usage 的归属 = 主线程轮次（lastTurns），不是本行合计 finalTurns`：`expected { round: 3 } to deeply equal { round: 2 }` 等） | ✅ 每条 `RESTORED SHA256=… SAME-AS-BASELINE=True` |
| Task 6-M1 / M2 | ui `build-model.ts`：①孤儿**不回落**（归属键一律照收）；②文案用**本行累计号**而不是归属号 | 两条都命中同一条用例：`build-model.test.ts > 行级事件的去向 > 用量里程碑带归属键，文案用归属号；没有归属与孤儿都抹成 null（⇒ 按时刻，不丢）`<br>① `AssertionError: expected [ Array(3) ] to deeply equal [ Array(3) ]`<br>② `AssertionError: expected '用量 输入 10 · 缓存 0 · 输出 0 · 轮次 4' to contain '轮次 2'`<br>各 `1 failed \| 17 skipped (18)` | ✅ 变异前/还原后哈希同为 `C976CD5F02F8075B6C9B2C2AADEE5C09E658D73D5CBF5CD049A8D69E402F7328` |
| Task 7-① | `build-model.ts:619` 退回 `rowEventsOf(input.events)`（不传 `homes`） | `build-model.test.ts > 整链接线：主会话真有那一轮时，usage 的归属键被认下并原样带出（不是孤儿）`：`AssertionError: expected null to deeply equal { subagentId: null, round: 1 }`，`1 failed \| 18 passed (19)` | ✅ 逐字还原 + SHA256 比对 |
| Task 7-② | `turnHomesOf` 直接 `return new Set()` | 同一条用例：`expected null to deeply equal { subagentId: null, round: 1 }`，`1 failed \| 18 passed (19)` | ✅ 同上 |
| Task 7-③ | `rowEventsOfTurn` 丢掉**身份**比对，只比号 | `agent-message-timeline.test.tsx > 有归属键的里程碑按「会话 + 号」归位；对不上本节点的不显示；无键的仍按时刻`：`AssertionError: expected <span …(1)></span> to be null`，`1 failed \| 11 passed (12)` | ✅ 同上 |
| Task 7-⑤ | `rowEventsOfTurn` 的无键分支恒 `false` | 2 条红：`行级事件按 at 落在轮次之间，三档各用自己的标签色`（`Unable to find an element with the text: 用量创新高`）与上面那条（`expected '轮次 218:44:41第二轮主会话第 2 轮的用量18:44:31' to contain '一条错误'`） | ✅ 同上 |
| Task 8-靶子① | 时间轴有键分支**只认主会话**（子会话自己的里程碑收不到） | 新增用例 `子会话自己的用量里程碑落在 sub-1 那一轮的行里（非空身份能命中的主路径）`：聚焦跑 `1 failed \| 12 passed (13)`；整包 `@aieval/ui` `Tests 15 failed \| 777 passed (792)`（基线 14 failed ⇒ **新红的只有这一条**） | ✅ `310FA679BF3E…` 前后一致 |
| Task 8-靶子② | `turnHomesOf` 只收**主会话**节点 | ⚠️ **没能变红**：聚焦 `build-model.test.ts` `19 passed`、`agent-message-timeline.test.tsx` `13 passed`，整包 14 failed = 基线 ⇒ **全包 0 条新红** | ✅ `C976CD5F02F8…` 前后一致 |

### 7.3 如实登记：一条变异体没变红（**这是已知的守卫缺口，不是证据缺失**）

§7.2 的 **Task 8-靶子②**（`turnHomesOf` 跳过子会话节点）**全包 0 条红**：
现有用例守不到它（`build-model.test.ts` 的「整链接线」那条只覆盖**主会话**；新用例是 props 级的，不走 `turnHomesOf`）。
要补得在 `build-model.test.ts` 里加一条**子会话**的整链用例——Task 8 按「只提交指定那条用例」的要求**没有**擅自加。

⇒ 结论是「这个数据层缺口已被发现并登记」，而不是「守卫全都有区分力」。除这一条外，
上表所有变异体都至少让一条守卫变红。

**另外如实登记一次工具错误**（Task 8）：§3.2-M2 的第一次跑，把两个测试路径塞进**一个**实参
（`'src/…/events.test.ts src/…/index.test.ts'`），结果只跑了 1 个文件；分成两个实参重跑后才是
上面那个「7 条红 / 2 个文件」的读数。

## 8. 未覆盖项与后续计划

1. **codex 的「多条里程碑各归各轮」未覆盖**（本轮该行只出一条，见 §3.2）。
   后续要覆盖它，需要一轮**中途就产生高水位跃迁**的 codex 运行——即让 `usage` 读数在**早期轮次**就带上
   `tokens`（本机 DeepSeek 路由下 codex 的读数往往堆到末尾）。建议人工挑一个更长的用例再跑一轮，
   或在有 codex 多里程碑的历史 run 上补验（但历史 run 没有 `turn` 格 ⇒ 只能验「不落错行」不能验「按号归位」）。
2. **全量门禁（`pnpm test` / `pnpm lint`）本轮未跑**（§1 第 11/12 项）。理由：本机根级聚合会卡死（§6.1），
   且本任务只跑/只看/只记录。建议在 TEMP 清干净、机器空载时，由门禁任务按
   `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000` 复跑。
3. **claude-code 的 8.3 短名用例未单独复核**（§6.3 第 1 条）。
4. **`route-runs.test.ts:400` 的键集合钉未更新**（§6.3 第 3 条）：本轮**未修**（不属于本任务、且会动别人的在途改动）。
   建议由 `messageCapability` 那条线的负责人补上第 7 格。
5. **本记录的浏览器侧证据只覆盖 `[data-turn-row]` 与其中的 `.ant-tag` 文本**：
   没有断言里程碑在轮次分组内的**几何位置**（AGENT.md 说几何断言要读 `getBoundingClientRect()`）。
   本轮判据是「归属对不对」，DOM 结构（`data-turn-row` 的归属）已足以判定；几何位置不是本功能的判据。
6. **变异验证有一条已知缺口**（见 §7.3）：`turnHomesOf` 跳过子会话节点这一缺陷**全包 0 条红**，
   即数据层缺一条**子会话**整链用例。本轮**未补**（Task 9 只跑/只看/只记录）。
   建议由补测任务在 `build-model.test.ts` 里加一条子会话的整链用例，并重做该变异体验证。
