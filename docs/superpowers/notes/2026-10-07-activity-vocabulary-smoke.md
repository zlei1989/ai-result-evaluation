# 冒烟：活动行（流信息）统一词表 —— 真机一轮 codex

**日期**：2026-10-07
**改动**：`docs/superpowers/specs/2026-09-22-features-design.md` §5.6.9（活动行统一词表）
**环境**：本机 `pnpm dev`（web-next :3083，Turbopack）+ 真机 codex app-server（`deepseek-openai` / `deepseek-flash`，档位 `max`）

## 1. 范围清单

| # | 项 | 结果 | 依据 |
|---|---|---|---|
| 1 | 改动前基线：活动行冻在计划那一句 | ✅ 复现 | run `7d8d5f3b` 的行 `4f13cf46`：`events.jsonl` 74 条事件 / 44 条 log / **10 条带摘要且全是「更新计划：N 步」**；界面上那一行（用户点的 DOM13）原文就是「更新计划：4 步」 |
| 2 | 重启 dev 让新代码生效 | ✅ | kill 监听 3083 的进程（pid 27340）→ `pnpm dev`；启动日志 `[instrumentation] 服务启动：已完成被中断候选行的恢复 { recovered: 0 }` |
| 3 | codex 工具调用进活动行（完整命令行） | ✅ 真机 | 同一行的新事件流：**15 条摘要 = 14 × `调用工具 exec_command：…` + 1 × `调用工具 wait`**（改动前同一行 0 条命令摘要） |
| 4 | 活动行**在滚动**（不是冻住） | ✅ 浏览器 | 连采样 8 次得到 4 个不同值：命令 → 模型答复文本 → 命令 → 终态后**收起**（`activityText` 对终态返回 null） |
| 5 | 答复文本仍能上活动行（2026-09-29 口径） | ✅ | 真机那 4 个值里有一句 `The file content is proper UTF-8 (PowerShell 5.1 just displayed it as mojibake)…`——它来自**没有摘要**的 log 的 `text`，由 `activityOf` 直取 |
| 6 | 原始输出面板：摘要优先、原文照旧 | ✅ 浏览器 | 面板里成对出现：`调用工具 exec_command：…` 与它下面的 `[18:55:14] stdout {"kind":"commandExecution","id":"call_00_giLp0tplZyIyKlUP5ptX3190","command":…` |
| 7 | 证据不带输出正文 | ✅ | 上述 `text` 里只有 `kind` / `id` / `command` / `cwd` / `status`，**没有 `output`**（一次构建的几万行输出不进事件流） |
| 8 | 计划更新（`更新计划：N 步`） | ⏭️ 跳过 | 这一轮模型没调 `update_plan` ⇒ 真机未触发（该路径只有单测覆盖） |
| 9 | 子任务派发 / 收场、工具报错 | ⏭️ 跳过 | 这一轮没派发子智能体、没有 MCP / 补丁报错 ⇒ 真机未触发（只有 `activity-conformance.test.ts` 与各家单测覆盖） |
| 10 | dsh / claude 两家的改动 | ⏭️ 跳过 | 本轮只跑了 codex 真机；两家的改动方向都是**减少播报**（工具调用加参数、去掉结果/推理/轮次的摘要），风险面比 codex 那一侧小，但仍属未真机复核 |

## 2. 操作路径

1. 浏览器打开 `http://localhost:3083/runs?panel=detail&id=7d8d5f3b-c390-4c56-9873-db3da411c2d0`（用户点 DOM13 的那一页），确认基线那一行是「更新计划：4 步」。
2. `Get-NetTCPConnection -LocalPort 3083` 取监听进程 → `Stop-Process` → `pnpm dev` 起新进程。
3. 该 run 的行被「重新执行」（`POST /api/runs/7d8d5f3b…/rows/4f13cf46…/retry`，dev 日志可见）——它用的就是新代码。
4. 等这一轮跑完（`[agents/codex] 适配器运行结束 { exitReason: 'completed', durationMs: 163691, turns: 15, metered: true }`），期间每 5s 采样一次活动行。
5. 打开「执行日志」→「原始输出 67 条」逐字核对摘要行与证据行。

## 3. 证据（浏览器 + CLI 互证）

| 面 | 读数 |
|---|---|
| CLI（`events.jsonl`） | `totalEvents=39 summaries=15`；摘要前缀分布 `[["调用工具 exec_command",14],["调用工具 wait",1]]`；`logs withSummary=15 withoutSummary=23`；无摘要样例 `我先看一下工作区当前状态。` |
| 浏览器（活动行） | `调用工具 exec_command："C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'Get-Content -Raw verify.cjs…` → `The file content is proper UTF-8 …` → `调用工具 exec_command："…" -Command '[Net.ServicePointManager]::…` → `(none)`（行结束后收起） |
| 浏览器（原始输出） | `[18:55:13] stdout 我先看一下工作区当前状态。` / `调用工具 exec_command：…` / `[18:55:14] stdout {"kind":"commandExecution","id":"call_00_giLp0tplZyIyKlUP5ptX3190","command":"…` |
| 磁盘（run 状态） | 该行 `status=judged`，最后三条事件 `score` → `status: judged` → `end { exitReason: 'completed' }` |

## 4. 独立审查这一轮（提交 58b489b 之后）

冒烟跑在 `58b489b`（修复前）上，随后做了一轮对抗式代码审查，**抓到一条 Blocker 与三条 Important**，
全部复核成立并已修（修复随下一个提交进库）：

| 级别 | 问题 | 处置 |
|---|---|---|
| Blocker | codex「已派发子任务」在生产里**永不播**：判据钉在 `item/started`，而真机那一刻 `receiverThreadIds` 是空数组（抓包 `L48`），id 到 `item/completed` 才出现（`L51`）；原夹具写了厂商不产出的形状 ⇒ 假绿 | 派发改到 `item/completed`；**新增真机抓包重放守卫**（97 条真实通知过一遍投影，钉住派发/等待/收场各一次且有序）；变异 J 复现原缺陷 ⇒ 4 条红 |
| Important | 子线程的 `turn/completed` 没接成收场来源：模型不再调 `wait` / `closeAgent` 时活动行会停在「调用工具 spawnAgent」，而子任务行已写「已完成」 | 接上第三个来源，与 `message.ts` 的 `terminalStatusOf` 同一张表；变异 G ⇒ 1 条红 |
| Important | codex 运行期拿不到子任务昵称（子线程不发 `thread/started`，昵称只在收尾 `thread/list` 响应里）⇒ 派发/收场行恒无名，而守卫靠手动塞内部台账 | 把**无名当主形态**写进守卫与文档（features-design §5.6.9 的「子任务名」表与末条边界）；昵称那一档保留为次要用例 |
| Important | 「工具失败」三类 item 三套判据：`commandExecution` 的 `failed` / `declined` 一个字都不播 | 补上（非零退出码仍不播，那是另一件事）；`mcpToolCall` 的判据改成「错误对象在 ∨ `status: 'failed'`」 |
| Nit | 词表丢掉了 dsh 的 `job_id`（`job_output` / `job_kill` 只有这一格） | 补回优先键；变异 H ⇒ 1 条红 |
| Nit | `changes` 为空时产出「改文件被拒（）」 | 不留空括号；变异 I ⇒ 1 条红 |
| Nit | 一致性守卫的 `summaryOf` 分不出「没落日志」与「落了不带摘要」；三家的收场只有 dsh 被逐字对拍 | 改钉**草稿**（不给摘要 ∧ 证据照落），claude / codex 的收场纳入逐字对拍，另补「轮次播报不占活动行」 |

**审查也确认了未发现问题的三处**（不必再查）：dsh 推理证据仍可查（原始信封里有正文，且有思考块出口）；
去掉摘要不影响评分通路（`judge-agent` 用 `summary ?? text` 兜底）；去重方向正确（先 `running` 后终态算一次变化）。

⇒ **本次冒烟的结论仍然成立**（活动行从「更新计划：N 步」变成实时的命令行/工具行），但它**没有覆盖**
派发与收场两档——那两档由真机抓包重放守卫与单测覆盖，真机新 run 未再跑（首个 run 因下面第 3 条的队列问题无法启动）。

## 5. 第二轮：三家真机复核（完成闭合）

前面留下的「只跑了 codex」这一格，用一轮**三行并行**的评测补上（run `e68351a5`，用例 `简单测试`，
claude-code / codex / dsh 各一行，`deepseek-flash`）：

| 行 | 摘要分布（`events.jsonl`） | 活动行观感（折叠真机事件复算） |
|---|---|---|
| dsh `05966cfd` | 26 条摘要：`调用工具 pwsh/get/edit/write/read/glob/web_search/list_agents/job_list/send_message/read_image/subagent`（**都带参数**）、`工具报错` ×2、`已派发子任务`、**`子任务已完成：Review hello world Vue page`** | 模型答复 → `调用工具 pwsh：Remove-Item "D:\…"` → `工具报错：Error: cannot read "D:\…"` → 答复 → `子任务已完成：…` —— **不再出现英文推理** |
| codex `883f6148` | 51 × `调用工具 exec_command：<完整命令行>`、5 × `工具报错`、**2 × `已派发子任务`**、3 × `调用工具 wait`、**2 × `子任务已完成`**、2 × `调用工具 sendInput` | 命令行与答复交替滚动；派发/收场各出现 2 次（该轮派了两个子智能体）——**B1 的修复在生产链路上成立** |
| claude `c1b60b53` | 5 条摘要：`调用工具 Write`、**`调用工具 Agent：Review Vue 3 hello world page`**、`已派发子任务：Review Vue 3 hello world page`、`调用工具 Read：D:\…`、`子任务已完成` | 答复 → `调用工具 Agent：<任务名>` → `已派发子任务：<任务名>` → 子智能体答复 → `子任务已完成`（收场当时**无名**——见下） |

三条由此得到的事实：

1. **codex 的 `工具报错：命令失败` ×5 都是真的**（不是噪声）：模型用 PowerShell 跑 `apply_patch`
   失败，随后自己改成 .NET 写文件（日志原文：「`apply_patch.bat` 会经 `cmd.exe` 破坏多行参数」）。
   这正是 2026-10-07 那条判据（`status: failed/declined` 要播、非零退出码不播）想要的信号。
2. **claude 的收场无名是两边共同造成的**：真机 `task_notification` 的键集里**没有**
   `description`（`probe/dumps/v4/claude-subagent-usage.jsonl`；`task_started` 才有）⇒ 已补
   「派发帧记名 → 收场帧回填」（`message.ts` 顶部的名字表 + `events.ts` 回填，变异 K 见过失败）。
   修好后同一形状的摘要变成 `子任务已完成：<名>`。
3. **「开始」按钮的真实路径正常**（纠正本文件初版的一条错判）：点「开始」→ 确认框
   （`.ant-modal-wrap`，标题「开始执行这一轮评测？」，列出将执行的候选）→ 点框里的**「开始」**
   → `POST /api/runs/<id>/start` → 行开跑（活动行「正在思考…」）。
   初版记的「队列不自动推进 / 点开始无反应」是**我的自动化写错了**：既假设了确认框的按钮文案是
   「确定」（实际是「开始」），又用 `.ant-modal-content` 去查（antd 6 的容器是 `.ant-modal-wrap`）
   ⇒ 框开着没点。**应用侧无缺陷**，这条观察项撤回。

## 6. 未覆盖项与后续

1. **计划更新这一档仍只有单测**：两轮的模型都没调 `update_plan`（codex 的 `turn/plan/updated` 在更早的
   run `7d8d5f3b` 上出现过，但那时是修复前的代码）。子任务派发/收场已在第二轮拿到真机读数
   （codex 各 2 次、claude 与 dsh 各 1 次）。
2. **dsh / claude 已在第二轮真机复核**（见 §5 的表）：活动行轨迹都对，claude 的收场名字按 §5 第 2 条补齐。
3. **`subAgentActivity` 与 MCP / 联网 / 动态工具 / 补丁的 `item/started` 仍无真机样本**（全库 dump 零命中）
   ⇒ 这几类只有合成夹具，出现时按 features-design §5.6.9 判据 2 的同型修法处理。
4. **观察项：codex 的中止请求与关闭抢跑**（dev 日志出现 2 次，属**中止/释放**那条链路，不在本次改动范围内）：
   `[WARN] [agents/codex] codex 中止请求失败（该行仍会按终止收场）` ——
   `Error: codex app-server 客户端已关闭；未完成的请求：turn/interrupt`（栈：`client.ts:168 rejectAll` ← `client.ts:299 close` ← `session.ts:195` ← `codex/index.ts:226` ← `release.ts` ← `turn.ts:476 dispose` ← `runTurn`）。
   现象是**降级而非失败**（该行照旧按终止收场），登记在此以免被当成「本次活动行改动引入的噪声」。
5. **本机基线不是干净工作树**：同一工作树里还有另一个会话的在飞改动（`providers/codex/appserver/*`、`client/ui/**` 等），全量测试有 **1 条红**来自它们（`@aieval/ui` 的 `agent-log-size-sweep.test.ts` 报 `task-panel-card.tsx:175 <Table> 缺 size="small"`），与本改动无关；本改动范围内的包全绿。
