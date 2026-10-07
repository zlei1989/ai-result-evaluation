# 调研：`@openai/codex-sdk` 的替代方案 —— 能不能拿到**子智能体消息**

> 调研日期：2026-10-05 · 调研方式：本机一手探测（仓库已安装的 codex 二进制）+ 上游源码/issue/PR + npm/PyPI 生态检索 + 三个并行子代理调研
>
> **结论（一句话）**：**没有「原地替换 `@openai/codex-sdk`」的库**（上游 SDK 到 0.160.0/main 的 `ThreadItem` 联合里都没有任何子智能体变体）；
> 但**同一个自带二进制里的官方 `codex app-server` 协议**已经把子智能体线程、身份、生命周期、条目流与按线程用量全部暴露出来——
> 生态里已有大量客户端在用它（**包括 DSH 上游自己**：`@deepseek-ai/dsh-subagent-codex`「One-shot Codex subagent provider over the official app-server protocol」）。
> 换 agent 运行时（opencode / Mastra / Strands 等）是另一条路，但对「三家横向评测」的代价最大。

---

## 0. 判据（四条，缺一条不算「能拿到子智能体消息」）

| # | 判据 | 含义 |
|---|---|---|
| C1 | **归属** | 事件/条目能区分「主线程」与「子智能体」 |
| C2 | **身份** | 能拿到子智能体的稳定 id（不是从文件名猜） |
| C3 | **生命周期** | 能拿到开始 / 交互 / 中断 / 结束状态 |
| C4 | **内容与用量** | 能拿到子智能体**自己的消息正文**与 token 用量 |

本仓现状（v3 规格 §1.1 / §3.2.1 / §4.2）：C1 靠事件流 `collab_tool_call.receiver_thread_ids` 做**种子**、C2 取该 id、
C3 取同条目的 `agents_states[id].status`、**C4 只能读子线程 rollout 会话文件**（沿 spawn 链递归发现）。
⇒ 痛点精确落在 **C4 与实时性**。

---

## 1. Codex 侧：SDK 与协议的能力差（一手证据）

### 1.1 上游 SDK 的能力面（两条独立证据）

| 证据 | 事实 |
|---|---|
| 本机 `@openai/codex-sdk@0.156.1` 的 `dist/index.d.ts`（285 行全文扫描） | `collab` / `subagent` / `receiverThreadIds` **命中 0 次**。`ThreadItem` 只有 8 个变体：`agent_message` · `reasoning` · `command_execution` · `file_change` · `mcp_tool_call` · `web_search` · `todo_list` · `error`；`ThreadEvent` 只有 `thread.started` / `turn.started` / `turn.completed` / `turn.failed` / `item.started\|updated\|completed` / `error` |
| 上游 `main` 的 `sdk/typescript/src/items.ts`（npm `latest` = **0.160.0**，Apache-2.0） | `ThreadItem` 仍是**同一批 8 类**，无任何 collab / subagent 变体 |

> ⇒ 换 SDK 版本**解决不了**：子智能体面从来没进过 SDK 的类型面。
> 上游 issue：[#28318](https://github.com/openai/codex/issues/28318)（`collab_tool_call` 缺 TS 类型，**仍 open**，原文："TypeScript consumers have to cast `event.item` to `unknown`/`any`"）、
> [#34919](https://github.com/openai/codex/issues/34919)（`exec --experimental-json` 流里 `spawn_agent` 条目**整体缺失**、`wait.receiver_thread_ids` 恒 `[]`，
> 而**同一轮**的 rollout 与 `state_5.sqlite.thread_spawn_edges` 是对的 ⇒ "任何通过公开事件流观察子智能体派发的 SDK 使用者拿到的是**假阴性**"）。

### 1.2 官方 `codex app-server` 协议面（本机 0.156.1 实测导出）

复现（**不改仓库、不装包**，直接读仓库已安装的 SDK 自带二进制）：

```powershell
$codexExe = 'D:\Github\ai-result-evaluation\node_modules\.pnpm\@openai+codex@0.156.1-win32-x64\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
& $codexExe --version                                                   # codex-cli 0.156.1
& $codexExe app-server generate-ts --experimental --out <临时目录>       # 867 个 .ts 文件
```

导出物里与子智能体直接相关的声明（逐条为**一手事实**）：

| 声明 | 原文要点 | 覆盖判据 |
|---|---|---|
| `v2/ThreadListParams.ts` | `parentThreadId?`（"Optional direct parent thread filter"）与 `ancestorThreadId?`（"Returns spawned descendants **at any depth**, excluding the ancestor itself"，两者互斥） | C1/C2，**递归发现不必再扫盘** |
| `v2/Thread.ts` | `parentThreadId`（注释原文："This will only be set if this thread is a **subagent**."）、`agentNickname` / `agentRole`、`status`、`source: SessionSource`、`turns` | C1/C2/C3 |
| `SubAgentSource.ts` | `"review" \| "compact" \| { thread_spawn: { parent_thread_id, depth, agent_path, agent_nickname, agent_role } } \| "memory_consolidation" \| { other }` | C2（身份 + 父链 + 深度 + 昵称） |
| `v2/ThreadItem.ts` | `collabAgentToolCall`：`receiverThreadIds: string[]`、`prompt`、`model`、`reasoningEffort`、`agentsStates`；`subAgentActivity`：`{ kind, agentThreadId, agentPath }` | C1/C3 |
| `v2/SubAgentActivityKind.ts` | `"started" \| "interacted" \| "interrupted" \| "completed"` | C3（**规范化活动条目**） |
| `v2/CollabAgentState.ts` | `{ status: CollabAgentStatus, message: string \| null }` | C3/C4（子智能体最终答复就在 `message`） |
| `v2/ItemCompletedNotification.ts` | `{ item: ThreadItem, threadId, turnId, completedAtMs }` —— **每条条目都带归属线程 id** | C1/C4 |
| `v2/ThreadItemsListParams.ts` | `{ threadId, turnId?, cursor?, limit?, sortDirection? }` —— **按 threadId 分页取条目**（子线程一样适用） | C4 |
| `v2/ThreadStatus.ts` | `notLoaded \| idle \| systemError \| active{activeFlags}` + `thread/status/changed` 通知 | C3 |
| `ServerNotification.ts` | `thread/started` · `thread/status/changed` · `turn/started` · `turn/completed` · `item/*` · `thread/tokenUsage/updated`（**按线程**用量） | C3/C4 |

**取法（重要，别误解）**：app-server **不是**"订阅子线程事件流"——通知联合里**没有任何 collab/subagent 专用 method**，
有 `thread/unsubscribe` 但**没有** `thread/subscribe`（订阅是 `thread/start|resume|fork` 的副作用）。
拿到子智能体消息是**两级**：
1. 父线程的 `item/*` 给 `subAgentActivity.agentThreadId` / `collabAgentToolCall.receiverThreadIds` 拿到**子线程 id**；
   或直接 `thread/list {parentThreadId}`（experimental，需 `initialize.capabilities.experimentalApi: true`）枚举直接子级，孙级递归；
2. 用该 id 调 `thread/read {includeTurns: true}` 或 `thread/items/list {threadId}` 取**子线程历史与消息**。

> 官方 PR [#26662](https://github.com/openai/codex/pull/26662) 的动机原文正好承认这个缺口：
> "Clients that display or coordinate spawned subagents need an authoritative snapshot … when they connect to app-server or **recover after missing live events** …
> clients must otherwise **scan unrelated threads or reconstruct relationships from rollout history and transient events**."

### 1.3 本机可行性探针（**已实测通过**，2026-10-05）

用 0.156.1 自带 exe 起 `app-server`（stdio），发 `initialize` + `thread/list`（含 `parentThreadId`），`CODEX_HOME` 指向临时目录（不碰真实 `~/.codex`）：

```text
{"id":1,"result":{"userAgent":"aieval-probe/0.156.1 (Windows 10.0.26200; x86_64) …","platformFamily":"windows"}}
{"id":2,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}     # thread/list
{"id":3,"result":{"data":[],"nextCursor":null,"backwardsCursor":null}}     # thread/list + parentThreadId
```

- 握手、`thread/list`、**experimental 的 `parentThreadId`** 全部被接受（只有畸形 id 才会 `-32600`）。
- stderr 仅一条无害警告（`CODEX_HOME` 在 `%TEMP%` 下时拒绝在那里创建 PATH helper 别名）——
  与本仓此前 `codex exec` 撞到的 `failed to initialize in-process app-server client: 拒绝访问。(os error 5)` **不是同一件事**：那是 ACL/权限，`app-server` 子命令本机可正常跑。
- 本次只验到协议可用，**未跑 turn**（无子智能体实况）⇒ 见 §4。

### 1.4 生态：驱动方式与现成库（npm / PyPI / hex 检索，2026-10-05）

**驱动方式对比**

| 方式 | 官方 | 能否拿子智能体消息 | 证据 |
|---|---|---|---|
| `codex app-server`（JSON-RPC / stdio 默认，ws experimental） | 官方 | **能**（两级，见 §1.2） | 本机 0.156.1 导出 schema + [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) |
| `thread/list {parentThreadId}` / `{ancestorThreadId}` | 官方（experimental） | **能**（枚举子/孙线程） | [PR #26662](https://github.com/openai/codex/pull/26662) |
| Python 官方 SDK **`openai-codex`**（PyPI 0.160.0，依赖 `openai-codex-cli-bin==0.160.0`） | 官方 | **部分能**：它本身就走 app-server，`Thread.read(include_turns=True)` 可读任意 threadId 历史；但 `TurnHandle.stream()/run()` **只消费本 turn** 的通知 | [api-reference.md](https://github.com/openai/codex/blob/main/sdk/python/docs/api-reference.md) |
| hooks：`SubagentStart` / `SubagentStop`（hook input 带 `agent_id` = 子线程 id、`agent_type` = 子智能体角色） | 官方（**已合并**） | **只能拿生命周期与身份，拿不到消息体** | [PR #22782](https://github.com/openai/codex/pull/22782) · [PR #22882](https://github.com/openai/codex/pull/22882) |
| `@openai/codex-sdk`（`exec --experimental-json`） | 官方 | **不能** | 见 §1.1 |
| `codex mcp-server` | 官方 | **未找到证据**（只把 Codex 当工具暴露） | — |
| 直接解析 `$CODEX_HOME/sessions/**/rollout-*.jsonl` | 非官方（格式**不是**稳定接口） | **能**（当前事实标准，本仓在用） | 本仓实现 + 社区（[agenthud schema](https://github.com/neochoon/agenthud/blob/main/docs/schemas/codex-session.md)） |

> ⚠️ **对本仓 v3 规格的一处更正（本机 0.156.1 已复核）**：规格写「codex 这家**不发 hook 回调**」——那是当时的实测口径。
> 本机从**已安装的 0.156.1 二进制**导出的 schema 里，`v2/HookEventName.ts` 明明白白有
> `"subagentStart" | "subagentStop"`（同一联合里还有规格未提的 `preCompact` / `postCompact` / `sessionEnd` / `interrupt`），
> `ManagedHooksRequirements` 也把 `SubagentStart` / `SubagentStop` 列为可配置项。
> hook input 里的 `agent_id`（= 子线程 id）/`agent_type` 来自上游已合并的 [PR #22782](https://github.com/openai/codex/pull/22782) / [#22882](https://github.com/openai/codex/pull/22882)
> ——**这半条本机未核对 payload 形状**。⇒ 结论：hooks 可作**子智能体发现与配对的带外通道**，但**不含正文**。

**现成库（社区）**

| 库 | 语言 / 分发 | 做什么 |
|---|---|---|
| `@deepseek-ai/dsh-subagent-codex` | TS / npm · BSD-3 | "**One-shot Codex subagent provider over the official app-server protocol**"（源在 `deepseek-ai/deepseek-harness` 的 `packages/subagent/subagent-codex`，devDeps 直接依赖 `@openai/codex`） |
| `@openclaw/codex` | TS / npm · 周下载 ~7.8 万 | "OpenClaw Codex app-server harness and **native session supervision** plugin" |
| `codex-app-server-sdk` | TS / npm · MIT | "standalone TypeScript extraction of the Codex app-server client that currently lives inside **OpenClaw**"（typed JSON-RPC + 进程 transport + generated types） |
| `@pwrdrvr/codex-app-server-protocol` | TS / npm · MIT | `codex app-server generate-ts --experimental` 的产物，**版本号跟随 CLI**（0.159.2，`codexExperimental: true`） |
| `codex-app-server-bridge` / `codex-app-server-client` / `openclaw-codex-app-server` / `mcp-codex-worker` / `@nyssance/codex-acp-v2` | TS / npm · MIT 等 | 客户端 / 插件 / MCP 桥 / **ACP v2 适配器**（多种宿主接入形态） |
| `dsh-codex-app-server` · `dsh-llm-codex-app-server` | TS / npm | DSH 的 AgentFactory / LLM provider，均 "backed by the Codex App Server" |
| **`codex_sdk`**（`Codex.Subagents`） | **Elixir** / hex | 最贴近需求：`children(parent_id)` = `thread/list` 按 parent；`read(thread_id)` = `thread/read`；`await(child_id)` = 轮询 `thread/read(include_turns:true)` 到终态 |
| `codex-agent-sdk-go` | Go | 第三方 SDK（`RunStreamed`、`GetThreadMessages`） |
| `subagent-auto-manager` | TS / npm · MIT | Codex 子智能体**账本** CLI + hooks（SQLite） |
| `cc-session-core` · `agent-session-format` | Py / TS | **读盘**路线：无损解析 rollout / 转统一 IR（与 `@usetemi/codex-sdk` 这类"上游 SDK 包装"都不是本题答案） |

> **未找到证据**：npm/PyPI 上**没有**一个库的定位是「消费 app-server 事件流并按线程分组（含子线程）」的**通用 TS** 库——
> TS 侧没有官方 app-server 客户端；社区最接近的是 OpenClaw 抽出来的 `codex-app-server-sdk` 与上面那批 adapter。

### 1.5 上游 issue / PR 证据

| 来源 | 关键事实 |
|---|---|
| [#34919](https://github.com/openai/codex/issues/34919)（open，label `subagent`） | `exec --experimental-json`（SDK 消费的那条流）**缺** `spawn_agent` 条目、`wait.receiver_thread_ids` 恒空；rollout 与 `thread_spawn_edges` 却是对的 |
| [#28318](https://github.com/openai/codex/issues/28318)（open） | `@openai/codex-sdk` 的 `ThreadItem` 缺 `collab_tool_call` 类型 ⇒ TS 使用者只能 cast |
| [#26662](https://github.com/openai/codex/pull/26662)（merged） | `thread/list` 新增 `parentThreadId`（experimental），实现走 `thread_spawn_edges`；**Review / Guardian 线程不在内**（不参与 spawn-edge 生命周期） |
| [#27166](https://github.com/openai/codex/pull/27166) | app-server 的 `ThreadWatchManager`（`note_turn_started` / `loaded_status_for_thread` / `remove_thread`）+ `ThreadItem::SubAgentActivity{kind, agent_thread_id, agent_path}` 通知 |
| [fddbaa9](https://github.com/openai/codex/commit/fddbaa9ffcc04938e38c2ad2853ff132e5b48ac0) | "feat(core): emit canonical sub-agent activity items"：legacy `EventMsg::SubAgentActivity` 弃用，注释原文 "App-server v2 receives the canonical SubAgentActivity item lifecycle instead." |
| [#9095](https://github.com/openai/codex/pull/9095)（merged） | collab 工具（spawn/interaction/wait/close）的起止在 app-server 上以 `item/started` / `item/completed` 暴露 |
| [#32737](https://github.com/openai/codex/issues/32737)（open） | **反向证据**：客户端日志显示 app-server 连接上**确实收到了子线程的 `turn/*`、`item/*` 事件**（bug 是客户端没注册这些线程："Received … for unknown conversation"，135 个子线程全被丢）——但这是客户端报告 + 日志，非官方承诺 |
| [#25341](https://github.com/openai/codex/issues/25341) · [#33670](https://github.com/openai/codex/issues/33670) · [#35781](https://github.com/openai/codex/issues/35781) · [#50498](https://github.com/openai/codex/issues/50498) | 上游未修：子线程被算进顶层会话 / spawn edge 悬挂 · Guardian 线程不在 `thread_spawn_edges` · 孤儿子线程事件发给客户端 · spawn edge 不闭合导致 fd 耗尽 |
| [manaflow-ai/cmux#2480](https://github.com/manaflow-ai/cmux/issues/2480) | 社区完整设计：共享 `codex app-server --listen ws://…`，用 `thread.source.subAgent.thread_spawn.parent_thread_id` + `thread/list`/`thread/read`/`thread/status/changed` 作**真源**；并披露 **`Prompt`/`Agent` hook 上游明确 skip**（hook 不是这条路） |
| [openclaw/openclaw#83445](https://github.com/openclaw/openclaw/pull/83445) | 生产实现：监听 `thread/started`（`source.subAgent.thread_spawn`）、`thread/status/changed`、`collabAgentToolCall`（`receiverThreadIds`/`agentsStates`）、父线程 `rawResponseItem/completed` 里的 `<subagent_notification>{agent_path,status:{completed:"…"}}</subagent_notification>`；**并且仍以 rollout 读盘为兜底**（`findTranscriptCompletion`） |

### 1.6 代价与坑（决定要不要迁）

| 项 | 说明 |
|---|---|
| 性质 | **协议迁移**，不是换库：长驻子进程 + JSON-RPC 帧 + 通知处理 + `initialize` 能力协商（`experimentalApi`） |
| 与本仓策略冲突 | v2/v3 规格把 app-server 记为「本期不采」，理由正是「与『不直接操作厂商 CLI』的策略冲突」⇒ 需要**显式修订该策略** |
| 过滤器边界 | `parentThreadId` 只覆盖 **spawn-edge 生命周期内的直接子线程**；Review / Guardian 线程**不在内**（#26662 原文） |
| 上游 bug 面 | §1.5 最后一行四条，均 open |
| 传输 | stdio 默认稳定；**websocket 仍标 experimental**（多客户端/远端要自己兜） |
| 协议漂移 | 大量方法带 `experimental(...)`；`thread/rollback` **已被移除**（先例）⇒ 迁移后要钉版本 + 守卫 |
| 「完成正文」可靠性 | 连 OpenClaw 都把 rollout 读盘留作兜底 ⇒ 迁移**未必能删掉**读盘那一层 |

### 1.7 迁移覆盖矩阵：app-server 能否覆盖现状？能否不再读 rollout？

**对照物**：本仓 codex 适配器现在消费的东西 = ① `exec --experimental-json` 事件流（`providers/codex/events.ts` + `message-events.ts`）
+ ② rollout 会话文件（`providers/codex/transcript.ts`：`readTranscript` / `reasoningTextOf` / `discoverChildThreads` / `projectTranscriptDrafts` / `projectChildThreadUsage`）
+ ③ 适配器选项面（`providers/codex/sdk.ts` 的 `CodexThreadOptions` / `CodexConfig`）。
**右列逐条来自本机 0.156.1 导出的 schema（一手）**。

| # | 现状能力 | 现在从哪来 | app-server 对应声明 | 结论 |
|---|---|---|---|---|
| 1 | 主线程 id / 轮次边界 | wire `thread.started` | `thread/start` 响应 + `thread/started` + `Turn{id,startedAt,completedAt,durationMs,status,error}` | ✅ |
| 2 | 助手消息正文 | wire `item.*` `agent_message` | `agentMessage{text,phase,questions}` + **`AgentMessageDeltaNotification`** | ✅（多了流式增量） |
| 3 | **推理正文** | **rollout** `reasoning.content[].reasoning_text` | `ThreadItem.reasoning = { id, summary: string[], content: string[] }`；`ReasoningItemContent = {type:'reasoning_text',text}\|{type:'text',text}`；**`ReasoningTextDeltaNotification{threadId,turnId,itemId,delta,contentIndex}`** | ✅ schema 层成立（**密文时一样为空**——与读盘同源，需实测） |
| 4 | 命令执行（命令/输出/退出码/耗时） | wire `command_execution` | `commandExecution{command, cwd, status, commandActions, aggregatedOutput, exitCode, durationMs, processId}` + `CommandExecutionOutputDeltaNotification` | ✅（字段比 wire 多） |
| 5 | 文件改动 | wire `file_change` | `fileChange{changes,status}` + `FileChangeOutputDeltaNotification` | ✅ |
| 6 | MCP 调用 | wire `mcp_tool_call` | `mcpToolCall{server,tool,arguments,result,error,durationMs,appContext}` | ✅ |
| 7 | **工具真名**（wire 只有派生条目名） | **rollout** | `functionCallOutput{name, namespace}` / `dynamicToolCall{namespace,tool,arguments,status,durationMs}` / `collabAgentToolCall{tool}` | ✅（不必读盘） |
| 8 | 计划面板 | wire `todo_list`；`PlanUpdate` 只在 rollout/app-server | `plan{text}` item + `TurnPlanUpdatedNotification` + `PlanDeltaNotification` | ✅（**新增原生面板数据**） |
| 9 | 子线程身份 / 父链 / 深度 / 昵称 | wire `receiver_thread_ids` + **rollout `thread_spawn`** | `SubAgentSource.thread_spawn{parent_thread_id,depth,agent_path,agent_nickname,agent_role}` + `Thread.parentThreadId/agentNickname/agentRole` + `subAgentActivity{kind,agentThreadId,agentPath}` | ✅（不必读盘） |
| 10 | **嵌套子线程发现**（现靠递归读派发者文件） | **rollout** `discoverChildThreads` | `thread/list{parentThreadId}`（直接子级）/ **`{ancestorThreadId}`（任意深度）** | ✅（不必读盘） |
| 11 | **子线程消息 / 工具调用 / 正文** | **rollout**（文件名即线程 id） | 子线程 `thread/items/list{threadId,turnId?,cursor,limit,sortDirection}`（每项 `ThreadItemEntry{turnId,item}`）/ `thread/read{includeTurns:true}` | ✅（不必读盘；**实时推送待实测**，见 §4.1） |
| 12 | 按线程用量 | **rollout** `token_count` + 子线程文件 | `thread/tokenUsage/updated` + `ThreadTokenUsage{total, last, modelContextWindow}`，`TokenUsageBreakdown{total,input,cachedInput,cacheWriteInput,output,reasoningOutput}` | ✅/⚠️ 线程级 total + **最近一轮** last；**「每个模型往返一次」的粒度要靠 `total` 差分**，若上游只在轮边界发通知则该粒度需实测 |
| 13 | 上下文窗口 | rollout `token_count.info.model_context_window` | `ThreadTokenUsage.modelContextWindow` | ✅ |
| 14 | 失败原因 | SDK 退出错误（stderr 全文） | `TurnError`（`Turn.error`）/ `error` 通知 / JSON-RPC error | ✅（形状要重映射） |
| 15 | **结构化输出**（评分用） | `TurnOptions.outputSchema` → `--output-schema` | **`TurnStartParams.outputSchema`** | ✅ |
| 16 | 模型 / 强度 / sandbox / 审批 / cwd | `CodexThreadOptions` | `ThreadStartParams{model,cwd,sandbox\|permissions,approvalPolicy,config}` + `TurnStartParams{model,cwd,effort,sandboxPolicy,approvalPolicy,summary}` | ✅（`effort` 是 turn 级一等字段；`AskForApproval` 含 `"never"`） |
| 17 | 网关路由（`model_providers.aieval` / `base_url` / `model_context_window` / `tools` / `features`） | SDK `config` → 摊平成 `--config` | `ThreadStartParams.config: {[key]: JsonValue}`（**JSON 直给，不过摊平**） | ✅（可绕开 SDK 摊平那两个已知 bug） |
| 18 | `skipGitRepoCheck` | `CodexThreadOptions.skipGitRepoCheck` | **协议里没有对应字段**（`ThreadStartParams`/`TurnStartParams` 全文无匹配） | ⚠️ **待验证**：可能 app-server 本来就不做该检查（或改走 project trust），但这是**唯一一个找不到直接映射的选项** |
| 19 | 会话文件路径 | 扫 `$CODEX_HOME/sessions` | `Thread.path`（注释标 **`[UNSTABLE] Path to the thread on disk`**） | ⚠️ 存在但**别当稳定接口** |
| 20 | shell 里再起 codex 的会话 id（CLI 横幅正则） | **rollout** `function_call_output` | **无对应**（那不是它派发的子线程，是另一个独立会话） | ❌ 协议外的边缘能力；若本仓要保留，只能继续从 stdout/文件里取 |
| 21 | fork 前缀导致的「幻影轮」 | **rollout** 判据（`CONSUMED_RECORD_TYPES` / `turnBuckets`） | 同源数据（fork 复制历史）仍会带前缀 ⇒ 判据要**迁移**到 items 上 | ⚠️ 逻辑迁移，不是数据缺口 |
| 22 | 审批 / 用户输入 | wire 上**不可达**（JSON-RPC `-32000`，本仓登记为 `unavailable`） | `CommandExecutionRequestApproval` / `FileChangeRequestApproval` / `PermissionsRequestApproval` / `agentMessage.questions{AsyncUserInputQuestion}` | ✅ **超集**，但**必须实现 server→client 请求应答**，否则该行可能挂住 |
| 23 | 流式增量 | **没有**（本仓 codex 恒 snapshot） | `AgentMessageDelta` / `ReasoningTextDelta` / `ReasoningSummaryTextDelta` / `CommandExecutionOutputDelta` / `FileChangeOutputDelta` / `PlanDelta` | ✅ **超集** |

**结论 1｜功能覆盖：是「超集」，但有 1 个待验证项 + 1 个逻辑迁移 + 1 个协议外能力**

- 待验证：**#18 `skipGitRepoCheck`** 在 app-server 上没有对应字段（是要另行配置、还是 app-server 不做该检查，必须实测）。
- 逻辑迁移：**#21 fork 幻影轮**——数据同源，判据得从「文件行」改写成「items」。
- 协议外：**#20 shell 里再起 codex 的横幅发现**——这条能力在协议里没有对应物（它不是 spawn-edge 子线程）；影响面是边缘形状，可如实降级为"不覆盖"。
- 反过来，app-server 带来 4 项现在**没有**的能力：#8 原生计划、#15（等价）之外的 **#22 审批/用户输入**、**#23 流式增量**、以及 #17 绕开 SDK 的 config 摊平。

**结论 2｜「不再读 rollout」：可以，但要分清「不读」与「兜底不读」**

1. **数据面已经够**：上表 #3/#7/#9/#10/#11/#12/#13 这 7 项正是本仓现在**只能读盘**才拿到的（推理正文、工具真名、子线程身份/父链、嵌套发现、子线程消息、子线程用量、上下文窗口）——每一项在协议里都有对应声明。
2. **但有三处风险要实测**（任一不成立就得保留读盘兜底）：
   - 推理 `content` 在真实网关路由下是否**有明文**（schema 有字段 ≠ 上游给了明文；本仓已知有些路由只回密文，那时读盘同样是 `null`）；
   - `thread/tokenUsage/updated` 的**发送频率**是否细到「每个模型往返」，否则 #12 只能给到轮级；
   - #11 子线程 items 的**实时推送**（若只支持按 threadId 拉，就必须在轮内轮询子线程）。
3. **app-server 仍然会写 rollout**（`Thread.path` 指向它）⇒ 读盘随时可作兜底，**建议照 OpenClaw 的策略：reader 降级为兜底而不是删除**。删掉它等于把「协议某字段忽然为空」变成静默的数据缺失。
4. **新增成本（读盘没有的）**：JSON-RPC 客户端 + `initialize` 能力协商 + **server→client 请求应答（审批）** + 长驻进程生命周期 + 协议版本钉死（`thread/rollback` 被移除是漂移先例）。

**两条迁移形态（风险差一个量级）**

| 形态 | 做法 | 好处 | 代价 |
|---|---|---|---|
| **B1 全量** | 运行与取数都走 app-server（`thread/start` + `turn/start` + 通知） | 一次到位：实时增量 + 子线程 + 审批 + 计划全原生 | 适配器大改；审批应答与进程生命周期都要自己写 |
| **B2 只换读** | **运行仍用 `@openai/codex-sdk`**（保持现有 wire 路径），只在**取数**侧起一个 app-server（同 `CODEX_HOME`）用 `thread/list{parentThreadId\|ancestorThreadId}` + `thread/items/list` 读子线程 | 改动面小得多；仍然干掉 `discoverChildThreads` 的扫盘递归；风险集中在读 | 多一个进程；依赖 exec 与 app-server **共享同一份 rollout + `thread_spawn_edges`**（[#34919](https://github.com/openai/codex/issues/34919) 的 reporter 证实：SDK/exec 跑出来的 6 轮，`state_5.sqlite.thread_spawn_edges` **都正确记了父子边**）⇒ 这条依赖有证据但需本机复验 |

---

## 2. 换运行时：其他 agent SDK / runtime 的子智能体面

> 方法：三路并行调研（编码 CLI 系 / 通用框架系 / Codex 驱动系），逐条按 C1–C4 核对；`@anthropic-ai/claude-agent-sdk` 作基线
> （同一条流里带 `parent_tool_use_id`，另有 `task_started`/`task_progress`/`task_notification`，工具结果带 `agentId: <id>`，本仓已用 `forwardSubagentText: true`）。

### 2.1 编码型 CLI 的 SDK

| 项目 | 可嵌入 SDK / headless | 子智能体机制 | 子智能体消息（C1–C4） | 置信档 |
|---|---|---|---|---|
| **opencode**（`anomalyco/opencode`，原 sst/opencode） | `@opencode-ai/sdk`（TS，1.18.34，MIT）+ `opencode serve`（headless HTTP，OpenAPI 3.1 于 `/doc`） | **child session**：`POST /session { parentID? }`；`GET /session/:id/children`；`GET /session/status`；`GET /session/:id/message`；SSE `GET /event` | ✅ **四条齐**：`Session.id` + `Session.parentID`（归属/身份）、`children()`（枚举）、`messages()`（正文与 `sessionID` 同给）、`SessionStatus`（状态）——**不需要读落盘文件** | 文档明说（[server 文档](https://opencode.ai/docs/server/) 本机已复核） |
| **GitHub Copilot SDK** | `@github/copilot-sdk`（TS 1.0.16，MIT；另有 Py/.NET/Go/Java/Rust） | Custom agents 作 sub-agent，事件与父会话**同流**，信封级 `agentId`（根 agent 事件省略该字段） | ✅ 最贴合"主/子同流可分流"的形态：`subagent.selected/started/completed/failed/deselected`，`subagent.completed` 带 `durationMs` / **`totalTokens`** / `totalToolCalls`。⚠️ **正文事件是否也带 `agentId` 文档未举例**，落地前需抓一帧实测 | 文档明说 |
| **goose**（`aaif-goose/goose`，原 block/goose） | Rust 库 + `goosed` server API + ACP（Node 侧要经 HTTP/ACP） | `delegate` 调度 subagent → **child session**（含 parent session） | ✅ 设计上齐：`delegate` **立即返回 child session ID**，"results are always read from the child conversation"；⚠️ 受 `GOOSE_STATE_MACHINE=1` 门控，legacy 循环下 `delegate` 仍是阻塞实现 | 文档明说（路线/门控） |
| **Roo-Code** | 只有 VS Code 扩展 + socket.io API（`@roo-code/types`），无独立可嵌入 SDK | Subtask / `new_task` 委派 | ✅ 事件契约其实很好：`taskSpawned`/`taskDelegated`/`taskDelegationCompleted`、`message{taskId,...}` 正文、`taskCompleted{isSubtask}` + 按 taskId 的 token 统计。⛔ **仓库已归档**（`archived: true`，push 停在 2026-05-15）⇒ 不宜作新替代 | 源码可见 + 归档事实 |
| **cline** | `@cline/sdk`（重导出 core/agents/llms/shared），Node ≥22 | Subagents + `enableAgentTeams`（`team_spawn_teammate` 等） | ⚠️ 部分：`agent.subscribe()` 有 `content_*` / `usage` / `done`，`cline.subscribe(listener,{sessionId})` 可按会话过滤 ⇒ 归属单位是 `sessionId`；**teammate 子会话 id 从哪个事件字段取，未找到证据** | 文档明说（归属粒度不足） |
| **qwen-code** | `@qwen-code/sdk`（TS 0.1.18，Apache-2.0）+ Py/Java(alpha) + daemon / Typed Event Schema v1 | SubAgents（foreground / fork / background，最多 10 并发） | ⚠️ 部分：单会话单一 SSE 流，**没有** per-subagent 订阅；身份只在工具 `_meta.provenance='subagent'` 与 `qwen-code.subagent` span；**设计文档把「per-subagent token usage aggregation」明确列为 Out-of-scope（Phase 4）** ⇒ C4 用量不满足 | 文档明说 |
| **Google Gemini CLI** | `@google/gemini-cli-core`（0.62.0）+ `--output-format stream-json` | Subagents（`codebase_investigator` / `generalist` / …） | ❌ **流里拿不到**：`JsonStreamEvent` 只有 `init/message/tool_use/tool_result/error/result`，`ToolUseEvent`/`ToolResultEvent` **无 `agentId`**，`stats.models` 按 model 而非按 subagent；`agentId` 只落进 JSONL 聊天记录（PR #25092）⇒ **与 codex 同款痛点**（子轨迹只存在于落盘文件） | 源码可见 |
| **Amp**（Sourcegraph） | `amp --execute --stream-json` | Specialist subagents（Search / Oracle / …） | ⚠️ `session_id` + **`parent_tool_use_id`** 在 schema 里（对齐 Claude Code 的归属字段），但文档未举子智能体消息样例，且明说"主 agent 只收到 final summary" | 文档明说（字段在）/样例缺失 |
| Factory Droid | `droid exec -o stream-json` / `stream-jsonrpc` + `--mission`（`--worker-model`/`--validator-model`） | multi-agent orchestration | ❓ **未找到证据**（无事件字段清单） | 未找到证据 |
| Cursor CLI · crush · iFlow · continue · Kilo | — | crush 官方工具清单里**没有** task/agent 工具 | ❓ **未找到证据**（continue 仅有 PR 标题 "feat: subagents" #9128） | 未找到证据 |

> **opencode 的项目面（本机复核 GitHub API）**：MIT · TypeScript · star ≈ 21.2 万 · fork ≈ 2.8 万 · 默认分支 `dev` · 最近一次 push 2026-10-05（当日）。
> ⇒ 在"换运行时"这条路上，它是**唯一同时满足「可嵌入 headless + 子会话是一等公民 + 项目活跃」**的候选。
> **若只想要"事件流里带归属字段"的形态**，GitHub Copilot SDK 的 envelope 级 `agentId` 设计最接近本仓契约
> （根 agent 事件省略该字段 ⇒ 天然可分流），但它不是 codex 家的替代（是另一门运行时），且正文归属待实测。

### 2.2 通用 agent 框架（相对基线）

| 方案 | 子智能体范式 | 子智能体消息可获取性 | 相对基线 |
|---|---|---|---|
| **claude-agent-sdk**（基线） | Agent tool / `agents` | `parent_tool_use_id` + `SDKTask*Message` + `agentId` + 子消息 `usage` | 基线（四条全中） |
| **Mastra**（TS） | 父 Agent 的 `agents:` = supervisor | delegation 派发为 tool call（`toolCallId`）；`onDelegationStart/Complete` 给 `primitiveId` + `result.usage` + `subAgentThreadId`；`background-task-*` chunk 明确带 `agentId` | **Node 内最接近**，但要把 tool call 与 hook 两边拼装；普通 delegation 的 `text-delta` 是否带子 agent id **未证实** |
| **deepagents / LangGraph**（Py 优先） | `task` 工具 + subgraph | `stream(..., subgraphs=True)` 的 **namespace**（`()`=主，`("tools:<id>",)`=子）归属最干净 | 相当/更强（Python 优先；完成态要自己判；node 级 usage **未找到证据**） |
| **Google ADK** | `sub_agents` + transfer / `AgentTool` | `Event.author` + `branch`（层级路径）；官方 issue 实测 `mode='single_turn'` 下并发也能正确关联，**但默认 agent-as-tool 路径 `await` 完成后子事件永不流出 wrapper** | 部分相当、部分更弱 |
| **Vercel AI SDK `ai`** | 子智能体 = 包在 `tool()` 里的 agent；另有 **`HarnessAgent`**（可跑 Claude Code / Codex / Pi） | 子流不自动并入父流，官方方案是"初步工具结果"；**父流里没有"这个 chunk 属于哪个子智能体"的字段** | 弱于基线；但 `HarnessAgent` 是"换适配层"思路的候选（**标 experimental**，且未证实能透出 harness 内部子智能体归属/用量） |
| **Strands Agents** | swarm / graph | `MultiAgentNodeStartEvent(node_id,…)` / `MultiAgentNodeStreamEvent(node_id, agent_event)` / `...CompleteEvent` / `HandoffEvent` | 相当/更强（node 级 usage **未找到证据**） |
| OpenAI Agents SDK（Py/JS） | agent-as-tool / handoff | 顶层流只有主智能体；嵌套流要自己用 `asTool({onStream})` 接；Py 侧 `stream_inner_events` PR **closed 未合并** | 弱（维护者明确拒绝把嵌套流并入顶层） |
| AutoGen / AG2 / Microsoft Agent Framework | agent-as-tool | 子任务在**独立 stream** 跑完只回最终文本；MAF 文档原文 "**Limited visibility**"；AutoGen 还要求**禁用并行工具调用** | 明显更弱 |
| Pydantic AI | 委托工具 / `SubAgents` | 用量靠 `ctx.usage` 累加；可观测性走 Logfire/OTel，**不是**流式契约 | 弱 |
| CrewAI / smolagents | — | **未找到证据** | 不可判定 |
| OpenAI Swarm | handoff | README：已被 Agents SDK 取代（"experimental, educational"） | 不适合 |

**通用框架的总结论**：**没有任何一个框架做到「四条判据全中且开箱即用」**——它们的"子智能体"多是同进程内的 LLM 工具调用，
没有文件/命令权限模型、没有子任务终态语义、也没有可 resume 的身份。**对本仓真正有价值的不是"换框架"，而是"换适配层"**
（Vercel AI SDK `HarnessAgent` 或直接走 app-server），因为 codex 家的缺口在**驱动协议**，不在编排框架。

---

## 3. 对本仓的三个选项

| 选项 | 做法 | 收益 | 代价 |
|---|---|---|---|
| **A. 维持现状（读盘）** | `collab_tool_call.receiver_thread_ids` 种子 + `discoverChildThreads` 递归读 rollout | 零迁移；已真机验证 | C4 是**事后**（跑完才读）；嵌套线程只能从**派发者自己的文件**里发现；fork 复制的"幻影轮"要额外判据；缺规范化的活动/状态条目 |
| **B. 换驱动层（SDK → app-server）** | 见 §1.7 的两种形态：**B1 全量**（运行+取数都走 app-server）／**B2 只换读**（运行仍用 SDK，取数侧起 app-server 读子线程）；类型可用 `@pwrdrvr/codex-app-server-protocol`（版本随 CLI）或本地 `generate-ts` | 覆盖矩阵见 §1.7：现状 23 项能力里 **19 项 ✅、3 项 ⚠️（待验证/逻辑迁移）、1 项 ❌（协议外）**，并多出 4 项超集能力（原生计划、审批/用户输入、流式增量、`config` 直给） | 适配器大改 + 长驻进程管理 + **策略修订**；上游 bug 面要自己兜；**建议保留读盘兜底**（协议仍会写 rollout） |
| **C. 换运行时** | 换成 opencode 等子智能体面原生的一门（§2） | 一次到位 | 评测面整体换家（模型路由/网关、工具面、跨家可比性全部重来）⇒ 与"三家横向评测"目标冲突，代价最大 |

> 若目标是"codex 家的子智能体轨迹实时、且不靠读盘"，**B 是唯一对症的选项**；A = 现状；C 不是同一层的问题。
> 若只想要**更省事的 C4**（不追求实时）：可以在 A 上加**hooks（`SubagentStart`/`SubagentStop` + `agent_id`）做发现与配对**，正文仍读盘。

---

## 4. 未验证 / 不确定性（如实登记）

### 4.1 Codex app-server 侧（决定 §1.7 的迁移结论）

1. **`skipGitRepoCheck` 无对应字段**（§1.7 #18）：`ThreadStartParams` / `TurnStartParams` 全文无匹配。要么另有配置键、要么 app-server 不做该检查——**必须实测**，这是唯一找不到直接映射的适配器选项。
2. **推理 `content` 是否真有明文**（#3）：schema 有字段，但本仓已知"有些路由只回密文"（那时读盘也是 `null`）⇒ 需在真实网关路由上抓一次 `reasoning` item / `ReasoningTextDelta` 对比 rollout 的 `reasoning_text`。
3. **`thread/tokenUsage/updated` 的发送频率**（#12）：若只在轮边界发，则"每个模型往返一次"的用量粒度拿不到，只能给线程级 total + 最近一轮 last ⇒ `roundTrip` 级用量可能仍需读盘。
4. **子线程 items 的实时性**（#11）：协议里既无 `thread/subscribe` 也无明文承诺"子线程事件自动投递"；#32737 的客户端日志显示**会**投递（推断档）。已证的是"子线程可枚举 + 可按 threadId 读 items + 有 `thread/started`/`thread/status/changed` 通知"。
5. **`thread/read {includeTurns:true}` 对子线程是否真返回完整 items**：依据只有 `Thread.turns` 的源码注释 + Elixir `Codex.Subagents` 的轮询实现，**本轮未一手实测**；`Turn.itemsView` 还有 `notLoaded|summary|full` 三态，`summary` 时 items 不全。
6. **B2 形态的共享前提**：exec 进程写的 `thread_spawn_edges` 是否被另起的 app-server 正常读到（#34919 的 reporter 证实写进去了，但**本机未复验**）。
7. 本机探针**只到握手与 `thread/list`**，没有真跑一轮带子智能体的会话（需要凭据 + `features.multi_agent=true`）。
8. `parentThreadId` 的过滤**语义**（只含直接子级、排除 Review/Guardian）来自 upstream README / PR，未在本机复现；本机只验到"参数被接受、返回空页"。
9. **协议漂移**：0.156.1 与 0.159.2 / 0.160.0 的字段级差异**未逐版比对**；`thread/rollback` 被移除是漂移先例；大量方法带 `experimental(...)`。
10. 社区包（`@openclaw/codex`、`codex-app-server-sdk` 等）**未审源码**，只读 registry 元数据与 README；接入前需自行审计许可、凭据处理与维护活跃度。

### 4.2 其他运行时侧

1. §2 的结论**以二手/文档为主**（三路并行子代理产出，已在其报告内标注「文档明说 / 源码可见 / 推测 / 未找到证据」）：§2.1 的 gemini-cli / qwen-code 部分因 `raw.githubusercontent.com` 间歇不可达，改用 npm dist 的 `.d.ts` 与 GitHub Contents API 快照（gemini-cli-core **0.62.0**、qwen-code main@**2026-10-05**）⇒ **换版本需复核**。
2. **GitHub Copilot SDK 的正文归属未证实**：文档只说 "sub-agent-originated session events … include envelope-level `agentId`"，举例全是生命周期事件 ⇒ **`agentId` 是否也出现在子智能体的正文消息事件上，必须先抓一帧真实 stream**（成本很低）。这决定它是"完整替代形态"还是"只有生命周期"。
3. **opencode 的两点待实测**：① `session.status`/`session.idle` 是否稳定携带父会话信息（issue 标题指向此处，正文未取到，**不采信**）⇒ 归属应从 `session.updated.info.parentID` 或 `session.children()` 取；② 子会话消息是否需要**按子会话单独拉**而非单流订阅。
4. **其余未证实项**：goose 的 `GOOSE_STATE_MACHINE=1` 是否已成默认（issue #11539 仍开放）；cline 的 teammate 子会话 id 来自哪个事件字段（未找到证据）；Amp 的 `parent_tool_use_id` 是否真被填成 Task 工具的 tool_use_id（**推测档**，按"兼容 Claude Code 格式"推断）；deepagents 的 v0.6 event streaming 是否含 usage、Strands 的 node 级 usage、Mastra 普通 delegation 的 `text-delta` 是否带子 agent id（三者均**未证实**，分别影响"完整替代"还是"只有归属"）；CrewAI / smolagents / Cursor / Kilo / Droid / iFlow / continue 为"**未找到证据**"，不等于不满足。

---

## 附：复现命令

```powershell
# 1) 导出本机（0.156.1）的 app-server 协议面
$codexExe = '<repo>\node_modules\.pnpm\@openai+codex@0.156.1-win32-x64\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
& $codexExe app-server generate-ts --experimental --out $env:TEMP\codex-ts-probe
Select-String -Path "$env:TEMP\codex-ts-probe\**\*.ts" -Pattern 'parentThreadId|SubAgentActivity|receiverThreadIds'

# 2) 握手 + thread/list 探针（CODEX_HOME 隔离到临时目录，不碰真实 ~/.codex）
$env:CODEX_HOME = "$env:TEMP\codex-probe-home"; New-Item -ItemType Directory -Path $env:CODEX_HOME -Force
# stdin 依次写入：
#   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","title":null,"version":"0.0.1"},"capabilities":{"experimentalApi":true,"requestAttestation":false}}}
#   {"jsonrpc":"2.0","id":2,"method":"thread/list","params":{"limit":3}}
#   {"jsonrpc":"2.0","id":3,"method":"thread/list","params":{"limit":3,"parentThreadId":"00000000-0000-0000-0000-000000000001"}}
```
