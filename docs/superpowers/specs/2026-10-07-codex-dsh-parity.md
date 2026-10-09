# codex ↔ dsh 能力对齐规格

本文件定义「codex 家与 dsh 家无差别」的可执行判据，以及结构性给不了的格子。改造实施见 `docs/superpowers/plans/2026-10-05-codex-appserver-refactor.md`。

## 1. 对齐定义

1. 同一格里两家都给得出值 ⇒ **逐字段同形同口径**；给不出 ⇒ `null` + `messageCapability` 的 `source`/`reason` 点名。
2. **不把更强的一家降级**（见 §4）。
3. 结构性给不了的格子写进 §3，**不用近似值顶替**。

## 2. 差异矩阵

`dsh` = 现状；`codex` = 换 app-server 之前的现状；`差距` = 待办方向。

| # | 能力 | dsh | codex（换之前） | 差距 |
|---|---|---|---|---|
| 1 | 文本增量 | 声明 `yes`/`wire`，投影恒 `snapshot` | 声明 `no`，投影恒 `snapshot` | 值面一致，声明面不一致；app-server 有 `item/agentMessage/delta` |
| 2 | 思考正文 | `wire` 推送、`textKind:'full'` | 读盘、`raw_content` 优先 `summary` 兜底 | 通道换成 wire |
| 3 | 思考摘要 | 无独立格 | 事件流给摘要 | 保留（codex 更强） |
| 4 | 工具调用族 | 每次调用都出消息 | 只出 shell 与协作两类 | **缺**：fileChange / mcpToolCall / plan / webSearch |
| 5 | 命令输出增量 | 无 | 无 | 两家都无；app-server 有 `item/commandExecution/outputDelta` |
| 6 | 文件改动 | `write`/`edit` 工具消息 + `meta.diffs` | 消息面无 | **缺** |
| 7 | MCP 调用 | 与普通工具同形、`family:null` | 消息面无 | **缺** |
| 8 | 计划/待办 | `todo_write` → `family:'task'` | 工具已开但生产不投影 | **缺**；app-server 另有原生 `plan` + `turn/plan/updated` |
| 9 | 审批/问用户 | 模型侧工具 `ask_user_question` | `approvalPolicy:'never'` | 结构性缺，见 §3.3 |
| 10 | 用量粒度 | 每条 assistant 消息（按 step） | `turn.completed`（整轮） | 粒度不同；两份 `liveUsage` 都是 `'reported'` |
| 11 | 用量口径 | `inputTokens` 不含 cache | `input − cached_input` | 已对齐 |
| 12 | 思考 token / 厂商总量 | `reasoningOutput` 不可达 | 有 `reasoning_output_tokens`/`total_tokens` | codex 更强，见 §4 |
| 13 | 消息级用量 | 有（`AgentMessage.usage`） | 恒 `null` | 结构性缺，见 §3.1 |
| 14 | 轮次口径 | 数 `step/start` | 数 `agent_message` 条目（近似） | 需显式选尺，见 §3.5 |
| 15 | 轮次归属 | 每会话 step 号 | 只有主线程 | **缺子会话归属** |
| 16 | 子任务行 | 四档 `status×stopReason` | 两档 `completed\|unknown` | codex 父链更强、dsh 终态词汇更强 |
| 17 | 子智能体消息 | 同流按 `sessionId` 归属、实时 | 读子线程文件、500ms 轮询 | 通道换成通知驱动 |
| 18 | 子智能体用量 | 白名单按会话求和、三档 | spawn 链递归、全量或 null | 口径已对齐，通道换掉 |
| 19 | 子智能体身份与父链 | 两层以上给不出 | `thread_spawn{depth,agent_path,agent_nickname}` | codex 更强 |
| 20 | 时长/时间戳 | 事件自带时间 | 事件流无时间字段 | app-server `Turn{startedAt,completedAt,durationMs}` |
| 21 | 失败分类 | `turn/end.reason` → `classifyAgentMessage` | `turn.failed`/`error` + stderr 特判 | 同源；退出码不得当结论 |
| 22 | 中止 | `cancelMidTurn:false` | `true` | codex 更强，见 §4 |
| 23 | 结构化输出 | 不支持 | 支持 | codex 更强，见 §4 |
| 24 | 能力声明 | 五格 `yes`/`wire` + notes | 四格 + `streamingDelta:'no'` | 逐格对齐或显式登记 |
| 25 | 环境/会话元数据 | 无 `vendor-system` | 无 | 两家都缺 |
| 26 | 技能注入 | 适配器级未实现 | 未实现 | 不构成差距 |
| 27 | 隔离与释放 | subprocess + per-run overlay | subprocess + scratchDir | 对齐 |

## 3. 结构性缺口（记 `null`，不用近似值）

1. **消息级用量**：app-server 只到线程级 `ThreadTokenUsage{total,last}`；对 `total` 差分在并发子线程与 turn/item 边界不一致时无法证明归属 ⇒ `AgentMessage.usage` 恒 `null`。
2. **推理明文**：只回密文的路由上 `reasoning.content[]` 为空（与传输层无关）⇒ `text:null` + `'none'`，不回落 summary。
3. **审批/问用户**：协议形态是 server→client 请求（需回帧才算应答），与 dsh 的「模型侧工具」不同构；本仓不应答 ⇒ 记 `unavailable`，不合成消息。
4. **每次模型往返的序号**：厂商给的是 `Turn.id`（标识，非序号）⇒ 只能自编号，与 dsh「厂商给号」不同源。
5. **`Turn` ≠ 一次模型往返**：一条 `Turn` 内含多次往返 ⇒ `turns` 为近似，且必须与 `subagentTurns` 同一把尺（`subagentTurns ≤ turns`）。

## 4. 反向差异（不得降级）

| 格子 | codex | dsh |
|---|---|---|
| `reasoningOutput` | 有 | 结构性不可达 |
| `total`（厂商自报总量） | 有 | 有 |
| `cancelMidTurn` | `true` | `false` |
| `structuredOutput` | `true` | `false` |
| 子任务父链/昵称/深度 | 有 | 恒 `null` |
| `parentCallId`（派发调用配对） | 有 | 恒 `null` |
| 子任务终态原始字段 | 三档（由 `turn.status`/`thread.status` 推出） | `vendorStatus`/`stopReason` 原始值 |

> `structuredOutput` 这一格已于 2026-10-07 真机核实：CLI 把 schema 原样放进 Responses 的 `text.format`（`json_schema` + `strict: true`），上游 200 且**确实执行**（同一份「要散文不要 JSON」的题面对照：带 schema 回 JSON、不带回散文）。
> 核实中同时修掉一处链路断裂——codex 从不写骨架的 `state.finalText`（评分通路读的那一格），见 `docs/codex-faq.md` 与 `docs/superpowers/notes/2026-10-07-codex-structured-output-live.md`。

## 5. 已知漂移（必须随改造一并修正）

`providers/codex/index.ts` 的能力 note 写「消息只在运行结束时投递一次」，而实现自 2026-10-03 起每 500ms 投递一次。
