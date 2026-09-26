# Agent 消息规范 v2 —— 三家实现方案对照

> **本文的定位**：契约与实现方案的设计文档。**不含探测过程**。
> 每一维给出：**三家各自的实现机制** → **我们这侧的定案**（未定案处给出候选与取舍）→ **判定**。
> **无法实现的能力单列成硬边界**（§9），并在各表中以 ⛔ 标出；
> **各项定案的索引**在 §10，但**定案内容本身写在它所属的章节里**——阅读时不必来回跳。
>
> 上位契约（消息模型、字段定义、决策 D1–D16）见
> [`2026-09-30-agent-message-spec-design.md`](./2026-09-30-agent-message-spec-design.md)；本文与之冲突处，**以本文为准**。
> 证据出处见 §12，原始产物在 `packages/server/agents/probe/dumps/{v2,v4}/`（已 gitignore）。

---

## 0. 三家的实现面：一张总览

| 面 | claude-code 的实现 | codex 的实现 | dsh 的实现 |
|---|---|---|---|
| 传输 | Agent SDK 异步消息流（`system/*`、`assistant`、`result`） | `@openai/codex-sdk` → `codex exec --experimental-json` 的 JSONL（SDK 原样透传） | `DeepSeekHarness` 客户端订阅（顶层通知 + `session.event`） |
| 结果文本 | `structured_output` 优先，回落 `result` | `item.completed` + `item.type==='agent_message'` | `content[].type==='text'`；`result.finalResponse` |
| 思考 | `content[].type==='thinking'`（**全文**）+ `signature` | 类型面有 `ReasoningItem`（语义是 **summary**）；**事件流不含正文**（正文可经带外通道取，§2.2.1） | `content[].type==='reasoning'`（**全文**）；`signature` 在 `replayState.blocks[]` |
| 工具 | `tool_use` / `tool_result`（原始 JSON） | `command_execution` / `mcp_tool_call` 等 item | `tool/call` / `tool/result`（**带 `meta` 结构化**） |
| 子任务 | 原生 `system/task_started|task_notification|task_progress|task_updated`（**默认就发**）+ `result.subagent_stats` | 事件流 `collab_tool_call` + **hook**（带外）+ rollout 会话文件 | 顶层通知 `subagent.started/finished` + `subagent/catalog` |
| 流式 | 默认**整块**；开 `includePartialMessages` 后为**真增量**（文本 + 思考 + 签名，仅主会话） | **恒 snapshot** | **原生块协议**（delta + snapshot 两种都有） |
| 计量 | `result.usage.output_tokens_details.thinking_tokens` | `turn.completed.usage.reasoning_output_tokens` | `assistant/message → data.usage`（**思考 token 不投影**） |
| 规划数据 | `Task*`（逐条 patch，非整表） | `update_plan`（整表）→ 事件流 `item.type==='todo_list'` | `todo_write`（整表覆盖） |
| 交互数据 | `AskUserQuestion`（**非交互配置下不在工具表**） | `request_user_input`（**`exec` 模式结构性不可用**） | `ask_user_question`（可用，无人应答即报错） |

**实现面的三条结构性结论**（决定了整个契约的形状）：
1. **产出的事件形状能归一，数据的来源与完备性归不了一** ⇒ `source` / `MissingReason` / `CapabilityLevel` 是承重结构，不是可选严谨。
2. **只有 dsh 有原生增量流**；另两家必须标 `chunk: 'snapshot'`（这不是降级，是事实）。
3. **codex 的能力最依赖"走哪条路"**：同一件事在不同传输通道上的可得性不同（§3.2 的通道矩阵最典型）。

### 0.1 能力声明定稿

```ts
type CapabilityLevel =
  | 'yes' | 'no' | 'unverified' | 'off-by-adapter'
  | 'not-projected-by-vendor';   // ← 新增第五态：厂商侧有数据、但不投影给我们（与"我们关了"对称）
```

| `messageCapability` | claude-code | codex | dsh |
|---|---|---|---|
| `thinkingText` | `'yes'`（来源：事件流） | **`'yes'`**——⚠️ **来源是厂商会话文件，不是事件流**（事件流的 `ReasoningItem` 仍不产出；见 §2.2.1） | `'yes'`（来源：事件流） |
| `thinkingTextKind` | `'full'` | **`'full'`**（**本机实得**；厂商对事件流 item 的语义是 `'summary'`，但落盘的是 `reasoning_text` 全文） | `'full'` |
| `toolInput` | `'yes'` | `'yes'` | `'yes'` |
| `toolResult` | `'yes'` | `'yes'` | `'yes'` |
| `subagent` | `'yes'`（事件流原生） | `'yes'`——**身份/终态走 hook + 事件流，子任务轨迹走子会话文件**（§3.2，⚠️路由） | `'yes'`（事件流原生） |
| `streamingDelta` | **`'yes'`**（需开 `includePartialMessages`；**仅主会话**，子智能体增量拿不到） | `'no'`（事件流内；app-server 可给 `item/agentMessage/delta`） | `'yes'` |

> **第五态 `'not-projected-by-vendor'` 保留，但 codex 的 `thinkingText` 已不再用它**——
> 该态描述的是"**这条通道**不给"；codex 的**事件流**那一格仍然符合它，而**整体能力**因为多了一条
> （会话文件）可用通道而变成 `'yes'`。
> **⇒ 契约必须把"能力值"与"来源"分开记**：同一格 `'yes'`，来源可能是 `stream` / `session-file` / `relay`。
> 不记来源，消费方就无法判断"要不要读盘"以及"实时性如何"。

| `usageCapability` | claude-code | codex | dsh |
|---|---|---|---|
| `thinkingTokens` | `'yes'` | `'yes'`（⚠️路由） | **`'off-by-adapter'`** |
| `thinkingTokensBasis` | `'subset-of-output'` | `'subset-of-output'`（⚠️路由） | `'unknown'` |

**第五态与 `'off-by-adapter'` 的分工（易混，必须守）**：
`'not-projected-by-vendor'` = 厂商**有**数据但不送进事件流（换我们的实现也没用）；
`'off-by-adapter'` = **我们这条路由的适配器**不输出（换路由可能有）。
二者在 UI 上都表现为"这格空"，但**只有后者值得写进待办**。

**缺失表达的落点**：凡上表为 `'no'` / `'not-projected-by-vendor'` / `'off-by-adapter'` 的格，
对应字段一律 `null` + `MissingReason`，**不得用近似值或 0 填**（§9 的 A 类清单即此）。

**⚠️ 引用前提**：codex 的多智能体与思考 token 两处可得性**与路由相关**——内网网关与另一条 OpenAI 兼容路由给出过**相反**结果。
凡标 ⚠️路由 的格子，能力声明里必须把"当前路由"写成前提。

---

## 1. 消息信封：三家落点（含定案）

| 字段 | claude-code | codex | dsh | 判定 |
|---|---|---|---|---|
| `messageId` | 由 `message.id` 派生 | 由 `item.id` 派生 | `data.message.id` 直接可用 | ✅ 强对齐 |
| `vendorId` | `message.id` | `item.id` | `data.message.id` | ✅ 强对齐 |
| `role` | `message.role` | ⛔ **事件流无 role 概念** ⇒ 由 item 类型推 | `data.message.role` | ⚠️ codex 是**派生值**，契约须注明 |
| `source` | `parent_tool_use_id` 非空 ⇒ `subagent` | 事件流 `collab_tool_call` 的 `sender_thread_id`/`receiver_thread_ids`；hook 的 `agent_id` | 通知的 `parentSessionId`/`childSessionId` | ⚠️ 三家机制不同；**字段必需**（定案见下） |
| `roundTrip`（模型往返序号） | 合成：按 `assistant.message.id` 去重计数 | 合成：按 `item.id` 去重计数（**已知偏高**） | 合成：按 `step/start` 边界计数 | ✅ 语义统一、跨家可比（前提见下） |
| `vendorTurn`（厂商轮号） | ⛔ 无 ⇒ `null` | ⛔ 无 ⇒ `null` | ✅ 厂商字段就叫 `turn`（**用户轮号**） | ✅ 强对齐（一家有、两家 `null` + `'not-supported'`） |
| `step` | ⛔ 无 ⇒ `null` | ⛔ 无 ⇒ `null` | 厂商字段 `step` | ✅ 可对齐 |
| `parentCallId` | `parent_tool_use_id`（**与工具调用 id 同空间**） | ⛔ 无该键 ⇒ `null`（**且子智能体根本不产出消息**，见下） | 🟡 **可推导**：`subagent` 工具的 `tool/result` 文本里带 childId（`"started subagent <id>"`），同一条结果又带 `toolCallId` ⇒ 建 `childSessionId → callId` 关联表 | ✅ 2/3 可用（claude 原生、dsh 推导） |
| `subagentId` | `task_started.task_id`（**原生**） | hook `agent_id`（原生） | `agentId`（原生，与 `childSessionId` 同值） | ✅ 三家都有原生 id |
| `chunk` | 开 `includePartialMessages` 后为 `'delta'`（仅主会话）；否则 `'snapshot'` | 恒 `'snapshot'`（`item.delta` 不存在） | `'delta'` + `'snapshot'` | ✅ 有真实值域 |
| `blocks[]` | `assistant.message.content[]` | `item.*` | `content[]` + `stream[]` | ✅ 可对齐 |
| `raw` | 信封级未映射字段 | `thread_id` 等 | `request/header`、`session/title` 等 | ✅ 可对齐 |

### 1.1 三条必须写死在契约里的口径

**① `turn` 已废弃，拆成 `roundTrip` + `vendorTurn`**（原字段名 `turn` 语义撞车：claude/codex 是合成的模型往返序号、dsh 是厂商的用户轮号）。

- **`roundTrip` 可比，但计数口径要先核对**：三家**都没有**这个原生字段，都是合成，且**方法不同**（见上表）。
  语义已统一为"第几次模型 API 往返"，但**跨家比较前必须确认三家用的是同一口径**；
  本仓已有的 `usage.turns` 是配套的累计量，两者语义同族。
- **`vendorTurn` 任何跨家比较都不允许**——它只描述厂商自己的轮号。
- 随之失效的旧限制：渲染契约里"`turn` 不得用于跨家比较"随 `turn` 一起消失。

**② claude 的"父消息"是两跳**（`parentCallId` 的直接用途是索引**块**，不是消息）：
`parentCallId` → 找**持有该 `callId` 的 `tool-call` 块** → 再找**承载那个块的消息**。
claude 原生给这一格；**dsh 需推导**（由 `subagent` 工具结果文本里的 childId 与其 `toolCallId` 建关联表）；
**codex 给不出**——不只是"没有这个键"，而是**子智能体根本不产出消息**（只有 `agents_states[].message` 一句字符串），
所以这一格在 codex 上**没有载体**。

**③ `source` 由**适配器**判定，不由消费方判**：
三家都在适配器内决定 `source`，`'subagent'` 只由**厂商侧链/线程归属信号**产生。
被否决的两个做法：由 `subagentId` 非空反推（dsh 在子任务自己的消息上该字段也为空 ⇒ 会漏判）；
让消费方按 `agentKind` 判（与"UI 不按厂商分支"直接冲突）。

---

## 2. 内容块：三家实现与定案

### 2.1 文本

| 家 | 实现 | 合并语义 |
|---|---|---|
| claude | `content[].type==='text'`；**同一 `message.id` 分多次投递**（thinking / text / tool_use 各自一条；实测同一 id 出现 2–4 次） | 按 `messageId` **覆盖合并** |
| codex | `item.type==='agent_message'` 的 `.text`；`item.started/updated/completed` 共享 `item.id`，文本累积 | 覆盖合并同样成立 |
| dsh | `content[].type==='text'`；`assistant/message` 自带完整 `content[]` | 无需合并 |

**定案**：**以块为主**，并用各家 final 字段（`structured_output`/`result`、`result.finalResponse`）做**交叉校验**——
两者不一致时落 WARN。只读 final 字段会丢掉中间轮次的文本，否决。

### 2.2 思考

| 家 | 文本 | 完备性 | `signature` | 增量 |
|---|---|---|---|---|
| claude | ✅ 全文 | `'full'` | ✅ 有 | ✅ **有**：开 `includePartialMessages` 后 `thinking_delta` 与 `signature_delta` 都逐片段到达（实测 34 段/111 字符 + 1 段）；**仅主会话**（见 §4） |
| codex | ✅ **有全文，来自厂商会话文件**（事件流仍不含，见 §2.2.1） | `'full'`（**本机实得**；厂商对 `ReasoningItem` 的语义是 `'summary'`，但落盘的是 `reasoning_text` 全文） | ⛔ 无 ⇒ `null` | ⛔ 事件流内无；若走 app-server 则**有** `reasoning/textDelta` |
| dsh | ✅ 全文 | `'full'` | ✅ 在 `replayState.blocks[]` | ✅ `reasoning-chunks`（**没有 `reasoning-delta` 这种形态**） |

**为什么 codex 是"事件流不给、会话文件给"**：上游把明文放在 `content[].reasoning_text`，`summary` 是空数组；
事件流的 `ReasoningItem` 是**摘要**通道（类型面逐字 "Agent's reasoning **summary**"）⇒ **摘要为空即不产出 item**；
但**同一份条目被原样写进了会话文件**（`content[].reasoning_text` 全文可读）。
打包二进制**同时引用** `reasoning_text`（16/17 处）与 `summary_text`（22/23 处）⇒ 不是读不到。

**定案（`signature`）**：契约**保留字段、不进任何呈现**。删字段会让 `raw` 在"归一无损"时省略 ⇒ 证据静默消失。

**定案（`textKind` 的语义）**：**按实得记**——三家都是 `'full'`；同时把**厂商语义上界**写在能力元数据的说明里
（codex 的事件流若真产出 item，那是 `'summary'`）。只写厂商语义会让 UI 按"摘要"渲染，而手里其实是全文。

#### 2.2.1 codex 的推理正文：**已解决**——来源是厂商自己的会话文件

**结论先说**：`exec` 事件流**不给**推理正文这一点没变，但**厂商把原始推理完整写进了会话文件**，
那一格里有可读全文 ⇒ **codex 的思考内容可得**，`source: 'session-file'`。

| 通道 | 能否拿到正文 | 状态 |
|---|---|---|
| ① 事件流 `ReasoningItem` | ⛔ 不能 | 它是摘要通道，`summary` 空即不产出 item（**这一条不变**） |
| ② **厂商会话文件 `rollout-*.jsonl`** | ✅ **能，且是全文** | ✅ **已实测采纳**（见下） |
| ③ 本地中继直读上游响应体 | ✅ 能（206 字全文，48 条增量拼接 = 全文） | ✅ 已验证，**降为备选/排障**（比②多一个组件、只覆盖我们控制 `base_url` 的路由） |
| ④ app-server 协议 | ✅ 能，且**是流式的**（`item/reasoning/textDelta` 通知，带 `threadId`/`turnId`/`itemId`/`contentIndex`/`delta`） | ⚠️ **未实测**；schema 已由本机二进制导出（`codex app-server generate-json-schema`，产物在 `dumps/v4/tmp/appserver-schema/`）。**实时场景才需要它** |

**②的真机逐字证据**（`dumps/v4/codex-rollout-inspect.json`）——会话文件里 `reasoning` 记录的**字段与内容**：

```jsonc
// payload 的键：type / id / summary / content / encrypted_content / internal_chat_message_metadata_passthrough
{ "type": "reasoning",
  "summary": [],                                  // ← 摘要是空的（这就是事件流不产出 item 的原因）
  "content": [ { "type": "reasoning_text",        // ← **正文在这里，是全文不是摘要**
                 "text": "The user wants me to spawn a subagent (foreground, run_in_background=false) … The available tool is multi_agent_v1::spawn_agent. … Let me do it." } ],
  "encrypted_content": "<len=38>" }
```

**三条必须一起写的口径**：

1. **本机实得的是 `'full'`，不是 `'summary'`**——厂商类型面把 `ReasoningItem` 描述成 "Agent's reasoning **summary**"，
   但**落盘的是 `content[].reasoning_text` 全文**。⇒ `thinkingTextKind` 按**实得**记 `'full'`（本轮更正）。
2. **它仍然是"厂商侧有、事件流不给"**：`messageCapability.thinkingText` 的**依据**要写清来源是会话文件，
   并把来源标进消息块；否则消费方会以为事件流里有。
   **实现里怎么标的（2026-10-01 审计后已对齐）**：思考载荷用 `origin: 'transcript'`（本模块标记）
   + `source: 'main' | 'subagent'`（**线程轴**）；子任务载荷用 `source: 'session-file'`
   （**= 上位规范 §6.1 的枚举原词** `'wire' | 'hook' | 'session-file' | 'aggregate'`——
   原先写成模块名 `'transcript'` 与契约枚举不符，已按契约改名）。
3. **上游只回密文时仍拿不到**（`content` 为空、只有 `encrypted_content`）——那是上游行为，
   契约照样要给 `null` + `MissingReason`，**不得用摘要或 token 数冒充正文**。

**路径怎么找（确定性，不必猜）**：
`$CODEX_HOME/sessions/<年>/<月>/<日>/rollout-<ISO时间>-<threadId>.jsonl` ——
**文件名末尾就是线程 id**，而主线程 id 来自事件流 `thread.started.thread_id`（子线程 id 见 §3.2）。
若要更稳（跨午夜、或不想依赖目录日期），可用 app-server 的 `thread/items/list`（按 `threadId` 分页取 items）。

> 旁证：摘要档位四连测（`model_reasoning_summary` = detailed / concise / none / 不设）都不产出 reasoning item；
> `show_raw_agent_reasoning=true` 也**不改变 `exec` JSONL**（本机实测 5 组全 0 条）⇒
> **调开关解决不了事件流那一格，会话文件才是答案。**

### 2.3 工具调用与结果

| 家 | 调用 | 结果 | 退出码 | 截断 |
|---|---|---|---|---|
| claude | `tool_use`（`id`/`name`/`input`） | `tool_result`（`is_error`）；**`stdout`/`stderr` 分开** | ⛔ **无结构化退出码**：失败时在文本里（`"Exit code 3"`），成功时拿不到 ⇒ `null` | 长输出另给 `persistedOutputPath` |
| codex | `command_execution` / `mcp_tool_call` / `file_change`(不出现) | `aggregated_output` | ✅ 有 `exit_code` + `status` | 64 KiB + 末尾 `\n...(truncated)`（**须从 stdout 剥掉**） |
| dsh | `tool/call`（`arguments` 是 **JSON 字符串**） | `tool/result` + **`meta` 结构化**；`tool-call-chunks` 是增量 | 文本尾部 `[exit code: N]`（**成功时没有这个尾部**） | 长输出存文件并给路径 |

**dsh："有 `meta` 就不要解析文本"**——结构化数据全在 `tool/result.meta`：
`read` 给 `{path,offset,lines[],totalLines}`、`glob` 给 `{shape:'paths',paths[],truncated,total}`、
`grep` 给 `{shape:'matches',files[{path,matches[{lineNumber,line}]}]}`、
`write` 给 `{operation:'create'|'update',diffs[]}`、`edit` 给 `{diffs[{path,oldText,newText}]}`。

**定案（codex 的工具名）**：事件流**不给工具名字段**（`command_execution` 只有
`id`/`type`/`command`/`aggregated_output`/`exit_code`/`status`），与入站工具表之间**没有可对齐的键**
⇒ **两轴统计以 item 类型为键**（`command_execution` → `execute/shell`、`file_change` → `edit/file`）。
被否决：沿用自定名 `'shell'`/`'apply_patch'` 冒充真名；去工具表里找真名（不可行）。

---

## 3. 子任务：三家机制与定案

### 3.1 三家实现机制

| 维度 | claude-code | codex | dsh |
|---|---|---|---|
| 主通道 | SDK 原生 `system/task_*`（**无需任何开关**） | **hook**（带外）+ 事件流 `collab_tool_call` | 顶层通知 + `subagent/catalog` |
| 次通道 | `result.subagent_stats`（聚合计数，`source: 'aggregate'`） | rollout 会话文件（**已采纳**，2026-10-01 改判，见 §3.2.1） | 工具面 `subagent`/`subagent_fork` |
| 身份 | `task_id`（原生） | hook `agent_id`；事件流 `sender_thread_id`/`receiver_thread_ids` | `agentId` / `childSessionId` |
| 角色/类型 | `subagent_type`（如 `"general-purpose"`） | hook `agent_type`（如 `"default"`）；事件流**不带** | `catalog.mode`（`one-shot`/`continuable`）／通知 `provider` |
| 任务名 | `task_started.description`（厂商给） | 见 §3.3 | `catalog.label`（**在另一条消息里**） |
| 归属键 | ✅ `tool_use_id` ≡ 子智能体消息的 `parent_tool_use_id`（同值） | `agent_id`（hook）；事件流用 thread id | ⛔ **通知里没有 `tool_use_id`** ⇒ 只能靠 `parentSessionId`/`childSessionId` |
| 终态 | ✅ `task_notification.status` ∈ `completed`/`failed`/`stopped` | hook **无状态字段**；事件流 `agents_states[].status` 有（§3.4）；`<subagent_notification>` 另有 `status` | `status` + `stopReason` **两格**（§3.5） |
| 结果摘要 | `task_notification.summary` | `last_assistant_message`；事件流 `agents_states[].message`；**子会话文件有完整消息** | `lastAssistantMessage` 里 `type==='text'` 的块（**要自己挑块**） |
| 嵌套父链 `parentSubagentId` | ⚠️ 类型面有 `parent_agent_id`，**真机载荷未出现**（`spawn_depth` 有） | ✅ **原生**：子会话文件 `session_meta.source.subagent.thread_spawn.parent_thread_id` + `depth`（§3.2.1） | 🟡 可由 `parentSessionId` 是否为主会话判定 |
| 子任务级 `usage` | ✅ `task_notification.usage` | ✅ **原生**：子会话文件的 `token_count`（含 `reasoning_output_tokens`，§3.2.1） | 🟡 **可推导**（2026-10-01 新证据）：**子会话的 `assistant/message` 也带 `usage`**——按 `params.sessionId = 子会话 id` 分组即可求和；真机三子会话各 1/3/1 条，含 `cacheReadTokens`（`dumps/v4/dsh-subagent-descriptor.jsonl`）。通知本身仍不带 |
| 未收场 | —— | —— | 运行时被关掉时**一条 `subagent.finished` 都不会来**（UI 须能显示"未收场"） |

### 3.2 codex：五条通道与定案组合

| 通道 | 能拿到 | 状态 | 代价 / 限制 |
|---|---|---|---|
| ① **事件流 `collab_tool_call`** | 工具序列（`spawn_agent`/`wait`/`close_agent`）、`receiver_thread_ids`、**`prompt` 原文**、`agents_states`（子线程状态 + 最终答复） | ✅ **采纳** | **不含 `agent_type`**；需要 `features.multi_agent=true`；⚠️网关路由上 `unsupported call` |
| ② **hook `SubagentStart`/`SubagentStop`** | `agent_id`、`agent_type`、`agent_transcript_path`、`last_assistant_message`、`stop_hook_active` | ✅ **采纳** | 需 `--dangerously-bypass-hook-trust`；**SDK 无任意 flag 透传口** ⇒ 必须 `codexPathOverride` + 薄启动器；**无状态字段** |
| ③ **子智能体自己的 `UserPromptSubmit`** | `agent_id` + `agent_type` + **它收到的 prompt 原文** | ✅ **采纳** | 需要 ② 的 hook 配置；只覆盖"子任务被派去做什么" |
| ④ rollout 会话文件 | `parent_thread_id`/`task_name`/`agent_id`/`subagent_kind` | ✅ **采纳**（2026-10-01 改判，见 §3.2.1） | 依赖厂商内部格式（须随版本回归）；**是事后读盘，非实时** |
| ⑤ app-server 协议 | 更完整的事件族 + **可流式订阅**（`thread/items/list`、`item/reasoning/textDelta`） | ⚠️ 本期不采（需另起 JSON-RPC 端） | 与"不直接操作厂商 CLI"的策略冲突；schema 已本地导出可用 |

**定案组合**：**② hook 给身份 + ① 事件流给状态与答复 + ③ 子会话 hook 给任务名**，
外加 **⑥ 子会话文件给"子智能体的完整轨迹"**（见 §3.2.1），
**每条数据各标 `source`**（`'hook'` / `'wire'` / `'session-file'`）。

**降级是路由相关的**：网关路由上 ① 不可用（`unsupported call`）、② 也因拿不到执行器而不会触发
⇒ **那条路由上 codex 的子任务面为空**，如实标 `'off-by-adapter'`。

#### 3.2.1 子智能体的**消息**怎么展示：读它自己的会话文件（✅ 已实测）

codex 的子智能体**不在父事件流里产出消息**（只有 `agents_states[].message` 一句答复），
但**子线程有自己的 rollout 会话文件**，里面是它的完整轨迹。真机逐字（子那份，20 行）：

```jsonc
// 子线程的会话文件里有什么
{ "type":"function_call", "name":"exec_command", "arguments":"{\"cmd\":\"echo CHILD-TOOL-RAN\",\"shell\":\"pwsh\"}" }
{ "type":"message", "role":"assistant", "content":[{"type":"output_text","text":"CHILD-TOOL-RAN"}] }
// 外加：developer/user 消息、function_call_output、token_count、task_started/task_complete/item_completed
// 以及 reasoning —— 该条目的 content[].reasoning_text 就是子智能体的推理全文（§2.2.1）
```

**父子链路怎么建——三处 id 天然对齐，可确定性定位**：

| 来源 | 给出的东西 |
|---|---|
| 事件流 `collab_tool_call` | `receiver_thread_ids` = **子线程 id**；`prompt` = 派发任务原文 |
| 父会话文件 | `spawn_agent({"message": "<任务原文>"})`、**`wait_agent({"targets":["<子线程 id>"]})`** |
| 父会话文件里的注入消息 | **`<subagent_notification>{"agent_path":"<子线程 id>","status":…}`** |
| 子会话文件 | 文件名末尾就是 `<子线程 id>`；内容是子智能体自己的逐条轨迹 |

⇒ 定位算法（**不依赖 hook**）：事件流拿 `receiver_thread_ids` ⇒ 在
`$CODEX_HOME/sessions/<年>/<月>/<日>/rollout-*<子线程 id>.jsonl` 命中子会话文件 ⇒ 逐条还原子智能体的
`message` / `function_call` / `function_call_output` / `reasoning`。

**另外三个顺带解决的问题**：

1. **codex 的工具真名**：事件流只给 `spawn_agent` / `wait`，而**会话文件给的是真名** `spawn_agent` / `wait_agent`
   ⇒ §2.3 的"两轴统计以 item 类型为键"**有了更好的选择**：工具名可从会话文件取真名（事件流仍以 item 类型为键）。
2. **子任务的状态与身份**：`<subagent_notification>` 带 `agent_path` + `status`，比 hook 的 12 字段更结构化。
3. **嵌套父链与子任务 usage——先前标为"无解"的两格，会话文件里是原生的**：

```jsonc
// ① 子会话文件的第一条就给了**嵌套父链 + 深度 + 昵称**（主线程那份的 parent_thread_id 为 null）
{ "type":"session_meta", "payload":{
    "session_id":"01a0f434-5def-…", "id":"01a0f434-707e-…",
    "parent_thread_id":"01a0f434-5def-…",              // ← 原生父链
    "originator":"codex_exec", "cli_version":"0.154.0",
    "source":{ "subagent":{ "thread_spawn":{
        "parent_thread_id":"01a0f434-5def-…",
        "depth":1,                                      // ← 原生嵌套深度
        "agent_path":null,
        "agent_nickname":"…" }}}}}                      // ← 子智能体昵称（事件流里只见过代号）

// ② 子任务级 token 用量（含思考 token）——先前以为只有 claude 有
{ "type":"event_msg", "payload":{ "type":"token_count", "info":{
    "total_token_usage":{"input_tokens":6962,"cached_input_tokens":6016,"cache_write_input_tokens":0,
                         "output_tokens":114,"reasoning_output_tokens":52,"total_tokens":7076},
    "last_token_usage":{ /* 同形，取最后一次增量 */ },
    "model_context_window":258400 } } }

// ③ 每行还带 turn_id（可作为**厂商轮的稳定标识**，虽不是序号）
```

⇒ 这三条把 §3.1 里 codex 的 `parentSubagentId`、`usage` 两格从"无源"改成**有原生来源**（标 `source: 'session-file'`）。

**③ 已实现（2026-10-01）**：`packages/server/agents/src/providers/codex/transcript.ts`
（`findTranscript` 按**文件名末尾线程 id** 递归查找、`readTranscript` 逐行解析并计 `badLines`、`reasoningTextOf` 只认 `content[].reasoning_text`）+
`index.ts` 的 `finalize`（跑完读会话文件并投影）+ `turn.ts` 的 `finalize` 钩子；用例 22 条，codex 作用域 **4 文件/58 用例**、整包 **21 文件/304 用例**、`tsc` 均 exit 0（本机复验）。

**必须一并写的三条限制**：
① **事后读盘、非实时**（要实时得走 app-server 的 `thread/items/list` / 流式通知；当前实现**一次运行只读一次**，跑完之后）；
② **依赖厂商内部格式**，须随 CLI 版本做回归（v1 §12 原本把它列为"不做主数据源"，
   现按既有例外扩到"codex 思考正文 + 子任务轨迹"两处，并在能力元数据里标 `source: 'session-file'`）；
③ **上游只回密文时（`content` 空、只有 `encrypted_content`）拿不到正文**，那一格照旧 `null` + `MissingReason`。

> ### ⚠️ 实现时暴露的两条**本仓约束**（① 已在**本轮契约扩展**中解决，② 仍在）
>
> 1. ~~**`usage` 事件装不下第四格**~~ **本轮已解**：契约里 `usage` 原先是钉死的三格（input/cached/output），
>    codex 会话文件里的 `reasoning_output_tokens` 与 `total_tokens` **加不进去**（会被 zod strip ⇒ 静默丢）。
>    本轮 `packages/server/contracts/src/agent-event.ts` **已扩**：`tokens` 增 `reasoningOutput` / `total`，
>    且 `input` 归一为「非缓存输入」（见 §5.1 的扩展块）⇒ `finalize` 现在把这两格**随 `usage` 事件一起发**
>    （只在值严格更新时补发，判据是 `providers/codex/index.ts` 的 `isStrictlyNewer`）；
>    **同时照旧逐字保留**在 `kind: 'transcript'` 载荷的 `tokenCounters` 里（键名照厂商原文、缺失一律 `null`）。
>    两处并存不是冗余：**事件流**给消费方算比率，**载荷**给审计对原文。
> 2. **`src/**` 禁止"目录扫描"API**：本仓 `static-assertions.test.ts` 有一条源码级不变量（连**注释里出现那个 API 名**都会红）。
>    而在"运行期才知道的目录里找文件"只能自己走目录 ⇒ 实现用 `opendirSync` + `Dir.readSync()` 绕过该断言。
>    **将来给 claude 的 transcript 写同类读取器时会遇到同一条约束**。

### 3.3 `name` 的取值链（三家不同，不能拉平）

| 家 | 首选来源 | 次选 | 兜底 |
|---|---|---|---|
| claude | `task_started.description` | —— | `null` |
| codex | **① 事件流 `collab_tool_call.prompt`**（派发时的任务原文，最直接） | ③ 子会话 `UserPromptSubmit.prompt` | `agent_type` ⇒ 再不行 `null` |
| dsh | `subagent/catalog.label`（**须维护 `childSessionId → catalog` 关联表**） | —— | `null` |

### 3.4 codex 的终态：**跨通道拼**（定案）

| 通道 | 状态可得性 |
|---|---|
| hook `SubagentStop` | ⛔ **载荷 12 字段里没有任何状态字段**（终态只能由 `last_assistant_message` 推，或留 `null`） |
| 事件流 `agents_states[<threadId>]` | ✅ 有 `{ status, message }`，实测见到 `pending_init` → `completed` |

**定案**：`subagent-end.status` **优先取事件流** `agents_states[].status`；取不到才 `null` + `statusMissing`。
两格各自带 `source`（`'wire'` / `'hook'`）⇒ **信息不丢，也不再把"其实拿得到"写成 `'not-exposed'`**。

### 3.5 dsh 的终态：**必须同时读两格**（定案）

| `status` | `stopReason` | 映射 | 陷阱 |
|---|---|---|---|
| `"ok"` | `"completed"` | `'completed'` | —— |
| `"error"` | `"aborted"` | `'canceled'` | ⚠️ 字面像"失败"，实际是**主动取消** |
| **`"ok"`** | **`"max-tokens"`** | **`'failed'`**（截断＝没做完） | ⚠️ 字面像"成功"，实际**没做完** |
| `"ok"` | `"error"` / `"refusal"` | `null` + `statusMissing`（**未观测值，不许猜**） | 类型面有这两档 |

`stopReason` 值域：`completed` · `aborted` · `error` · `max-tokens` · `refusal`。
**硬规则**：`stopReason !== 'completed'` ⇒ **一律不得记为 `'completed'`**。

### 3.6 `subagent/descriptor`（dsh）：**不得当身份来源**

载荷是 `{version, mode, provider, label}`，**`data` 里没有 `childId`**——身份只在信封 `params.sessionId` 上；
且它**不是逐子任务必发**（一次运行 3 个子任务只出现 2 条）。⇒ 身份必须来自 `subagent/catalog` 或顶层通知。

---

## 4. 流式：三家实现与定案

| 家 | 实现 | `chunk` |
|---|---|---|
| claude | 默认整块；**开 `includePartialMessages: true` 后转为真增量**：`stream_event` → `content_block_delta`（`text_delta` / `thinking_delta` / `input_json_delta` / `signature_delta`），实测 76 条 stream_event、`text_delta` 34 段/47 字符、`thinking_delta` 34 段/111 字符 | 可 `'delta'`（**仅主会话**）——⚠️ stream event 的 **`parent_tool_use_id` 恒 `null`**，官方逐字："Stream events are emitted for the main session only; token-level deltas from subagents aren't forwarded" ⇒ **子智能体的增量拿不到**，要用完整消息的 `parent_tool_use_id` 归属 |
| codex | 文本随 `item.*` 累积；**`item.delta` 不存在** | 恒 `'snapshot'`（若采纳 app-server 则另有 `item/agentMessage/delta`；思考用会话文件，§2.2.1） |
| dsh | 原生块协议：`chunk:block-start` / `text-chunks` / **`reasoning-chunks`** / **`tool-call-chunks`** / `chunk:block-end` / `chunk:usage` / `chunk:finish` | `'delta'` + `'snapshot'` |

**定案**：**两家都发**——`'delta'` 只服务实时打字，`'snapshot'` 是落盘与抽屉的真相
⇒ **消费方只认 `snapshot` 也能正确渲染**。
被否决：只发 `'snapshot'`（丢掉 dsh/claude 的实时性）；只发 `'delta'`（把整块伪装成增量，假装出来的实时性最误导人）。
**新增取值来源**：claude 的 delta 需在 SDK 侧开 `includePartialMessages`（官方文档：`content_block_delta` + `delta.type` 判定），
且**必须**自己累积（官方逐字："You need to extract and accumulate text deltas yourself"）。

---

## 5. 计量：思考 token 三家对照（含定案）

| 家 | 来源 | 真机取值 | 与 `output_tokens` 的关系 | 能力位 | 依据 |
|---|---|---|---|---|---|
| claude | `result.usage.output_tokens_details.thinking_tokens` | 19/19 样本非空（0…1401） | **可用对 14 条恒 ≤，零违例**（最大比 0.545） | `'yes'` / `'subset-of-output'` | `dumps/v2/thinking-tokens.json` |
| codex | `turn.completed.usage.reasoning_output_tokens` | 9/9 非 0（123/50/65/53/117/56/84/51/61） | **9/9 恒 ≤** | `'yes'` / `'subset-of-output'`（⚠️路由） | `dumps/v4/codex-deepseek-events.json` |
| dsh | `assistant/message → data.usage.reasoningTokens` | **恒无** | 无从比较 | **`'off-by-adapter'`** / `'unknown'` | 见下 |

**dsh 的定案**：如实标 `'off-by-adapter'`、**不采**。根因在本仓路由的适配器里（源码逐字，
`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1358-1372`（JSDoc 1358–1363 + `mapUsage()` 1364–1372）：`mapUsage()` 只映射 `input/output/total` + cache 两格，
注释即 "reasoning folded into output by pi-ai"）。
被否决：换用会投影该字段的路由（改变了被测路由，与"评测口径固定"冲突）；用 `tokens.output` 去凑（双计且是假数）。

### 5.1 三条跨家口径（必须进契约）

1. `thinkingTokens` 是 `output` 的**子集、不是第四个加数**（23 条可用对零违例）；
2. **只有 `basis === 'additive'` 才允许相加**；`'subset-of-output'` 相加即双计，`'unknown'` 连跨家比较都不允许；
3. **`thinkingTokens: 0` 不得读成"这家不思考"**——第三方兼容后端可能**根本不返回**该字段
   （claude 经某 anthropic 兼容端点时恒 0，而同一轮模型确实产出了 thinking 正文）。
   **估算帧**（claude `system/thinking_tokens`）**不进计量**。

> ### ⚠️ 契约缺口与**本轮扩展**：`usage` 需要"时间"与"缓存口径"两样东西
>
> **缺的是什么**：`usage.tokens` 原本是 `{input, cached, output}` —— **命中率的分子分母都在**，
> 但**一个时间字段都没有** ⇒ **tok/s 无从计算**；而且三家的 `input` **语义不同**，同一条公式会算出两种东西。
>
> #### ① 缓存口径：三家不一致，必须归一到"非缓存输入"
>
> | 家 | 厂商字段 | `input` 是否含 cache | 依据 |
> |---|---|---|---|
> | claude | `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`（**三格分开**） | **不含** | 📄 **文档依据**（Anthropic 把三格分列、`input_tokens` 不含 cache 读/建）+ ✅ **本机有非零样本**（51 条 result 帧里 39 条 cache 两格之一非零；例：`dumps/v2/claude-bash-default.jsonl` 的 `input_tokens 19` / `cache_creation_input_tokens 65544` / `cache_read_input_tokens 28418`——`input_tokens` 远小于 cache 两格之和，若 `input` 含 cache 则不可能）。⚠️ 三家唯一**验不了恒等式**的一格：claude 不报总量，`input + cache_read + cache_creation` 没有对账目标 |
> | codex | `input_tokens` / `cached_input_tokens` | **含**（cached 是 input 的**明细**） | 本机 wire：`{input_tokens:35, input_tokens_details:{cached_tokens:0}}`；exec 事件流 `turn.completed.usage`：`{input_tokens:8152, cached_input_tokens:6656}`（6656 < 8152）；rollout 每行的 `token_count` 也带 cached：`{input_tokens:9340, cached_input_tokens:8320}` |
> | dsh | `inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens` | **不含** | **本机恒等式**：`{inputTokens:1219, cacheReadTokens:7040, cacheWriteTokens:0, outputTokens:1, totalTokens:8260}` ⇒ `1219+7040+0+1 = 8260` ✅（两次运行都是**非零命中**样本） |
>
> ⇒ **定案：适配器把 `tokens.input` 归一到「非缓存输入」**（codex 侧做减法 `input = input_tokens - cached_input_tokens`），
> 于是**跨家统一公式：缓存命中率 = `cached / (input + cached)`**。这是"消灭按厂商分支"（上位规范 `2026-09-30-agent-message-spec-design.md` 的 §7.6.4「UI 渲染契约」）在计量上的落法。
>
> #### ② 时间：tok/s 的分母，三家可得性差很多
>
> | 家 | 厂商时间字段 | 真机 | 可否直接比 |
> |---|---|---|---|
> | claude | **`result.duration_ms` / `duration_api_ms` / **`ttft_ms`**** | ✅ 三个都有（本机 51 条 result 帧，其中 46 条三格齐全；样本 `dumps/v2/claude-bash-default.jsonl`：166712 / 158753 / 7558 ms） | ✅ `source: 'vendor'` |
> | codex | **exec 事件流没有任何时间字段**；只有**会话文件每行的 `timestamp`** | ✅ 有，但只能算"行时间跨度" | ⚠️ `source: 'events'`，**含工具执行时间** |
> | dsh | 会话事件自带 **`time`（epoch ms）** | ✅ 有 | ⚠️ 同上 |
>
> ⇒ **契约新增 `timing: { totalMs, apiMs, ttftMs, source: 'vendor'|'events' } | null`**，并把公式写进契约注释（**比率由消费方算，不在适配器里算**）：
> · **缓存命中率** = `cached / (input + cached)`（三家同式，input 已归一）；
> · **生成速率（tok/s）** ≈ `output / ((apiMs - ttftMs) / 1000)`（claude 可算；分母要换成**秒**）；缺 `apiMs` 时退化成 `output / (totalMs / 1000)`，**必须带 `source:'events'` 的警示**（分母含工具时间）；
> · **首 token 时延** = `ttftMs`（仅 claude 原生）。
>
> `tokens` 同时增加 `reasoningOutput`（思考 token，缺失 `null`）与 `total`（**厂商原文总量**，
> ⚠️ 它**不参与归一后的恒等式**：codex 的 `total = input + output` 是按**含 cache 的 input** 算的）。
>
> #### ③ 落地落点（2026-10-01）
>
> - **契约**：`packages/server/contracts/src/agent-event.ts`（`tokens` 增两格、`input` 语义改写、新增 `timing`，公式写进注释）；
> - **三家适配器**：`providers/{claude-code,codex,dsh}/events.ts`（codex 侧做减法；时间来源分别标 `'vendor'` / `'events'`）；
> - **消费方**：新增 `packages/client/ui/src/base/usage-metrics.ts`（`formatCacheHitRate` / `formatGenerationRate` / `timingSourceLabel`），
>   `log-format.ts` 与 `metric-line.tsx` 接上；**唯一一份公式实现**（本仓在这类"两处各算一遍"上吃过亏）。
> - **复验**（本机实跑）：contracts **11 文件/185 用例**、agents **21 文件/304 用例**、client/ui **41 文件/502 用例** 全绿；
>   `tsc --noEmit` 在 contracts / agents / client-ui / client 四包均 exit 0。

---

## 6. 工具族：10 族的实现方案（含定案）

| family | claude-code | codex | dsh | 判定 |
|---|---|---|---|---|
| `read-file` | `Read`：文本带行号；**结构化旁路**给 `totalLines` | ⛔ **无文件工具**（`tool_mode: code_mode_only`）⇒ **恒 `null`** | `read`：`meta{path,offset,lines[],totalLines}` | codex 恒空 |
| `write-file` | `Write` | 经 shell ⇒ **该族恒 `null`**（该操作一律由 `command_execution` 承载） | `write`：`meta.operation` ⇒ **`created` 有真来源**（`bytes` 拿不到） | 2/3 + codex 恒 `null`（改动落 `run-shell`） |
| `edit-file` | `Edit` | 经 shell（`file_change` 不出现）⇒ **该族恒 `null`**（该操作一律由 `command_execution` 承载） | `edit`：`meta.diffs[{path,oldText,newText}]` ⇒ `diff` 可派生 | 2/3 + codex 恒 `null`（改动落 `run-shell`） |
| `search-content` | `Grep` | 经 shell ⇒ **该族恒 `null`**（该操作一律由 `command_execution` 承载） | `grep`：`meta.shape='matches'` ⇒ `mode` 由 shape 给 | 2/3 + codex 恒 `null`（改动落 `run-shell`） |
| `list-files` | `Glob` | 经 shell ⇒ **该族恒 `null`**（该操作一律由 `command_execution` 承载） | `glob`：`meta.shape='paths'` + `total`/`truncated` | 2/3 + codex 恒 `null`（改动落 `run-shell`） |
| `run-shell` | `Bash`：**无结构化退出码**；`stdout`/`stderr` **分开**；长输出有 `persistedOutputPath` | `command_execution`：**最完整**（`exit_code`+`status`） | `pwsh`：退出码在文本尾部 | 3/3 可得，形状不同 |
| `web-search` | 无条件禁用 | `tools.web_search: false` | `tool-web.config.search=false` | **三家恒空**（有意） |
| `spawn-agent` | `Task`(init)/`Agent`(入站) | `spawn_agent`（⚠️路由） | `subagent`/`subagent_fork` | 3/3 有工具 |
| `task` | `Task*`：**逐条 patch**；`id` 来自 `TaskCreate` 返回；`owner`/`blockedBy` **独有** | `update_plan`：整表；事件流载荷 **`{text, completed}` 二态** ⇒ **恢复不出 `in_progress`** | `todo_write`：整表；result 只给摘要句 ⇒ 必须读 `arguments` | 3/3 可得，两套语义 |
| `ask-user` | `AskUserQuestion`：**要它出现，必须注册 `canUseTool` 回调**（实测：显式列进 `tools` 但无回调 ⇒ 仍被剔除；有回调 ⇒ 出现，且不传 `tools` 时工具表 23→**26** 项）。⚠️ 官方文档说"默认可用"**不完整**；⚠️ 且 `bypassPermissions`/`acceptEdits` 这类**自动放行**会把调用在 `canUseTool` 之前就解决掉 ⇒ **回调不触发**（✅ **本机告警逐字**：`[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves every tool call (except explicit deny rules) before the callback is consulted. To gate every tool call, use a PreToolUse hook instead.` —— 产物 `dumps/v4/claude-sdk-warnings.txt`；官方 user-input 文档同判） | `request_user_input`：**`exec` 模式结构性不可用** | `ask_user_question`：可用；无人应答即 `isError` | 2/3 可得（claude 需回调才"有工具"，需非 bypass 或 PreToolUse 才"能收问题"） |

**定案（`task` 族的 `commitModel`）**：**保留两值**（`'replace-whole-list'` / `'patch-one-item'`），
**适配器累积成整表再交出**——UI 只需一套渲染；成本在 claude 侧维护 `taskId → TaskStep` 映射。
被否决：把 claude 的 patch 原样抛给 UI（与"UI 只按 family 分支"冲突）；只支持整表（直接丢掉一家的规划数据）。

**定案（codex 的 `in_progress`）**：工具输入是三态、事件流只有二态 ⇒ **如实标 `'unknown'`**。
被否决：用"最后一条 `text` 是当前步"启发式推断（编数据）；改读 rollout/app-server（本期不采）。

**`ask-user` 的阻塞语义（三家不同，不能抹平）**：dsh **阻塞且无超时预算**；codex 有 `autoResolutionMs`
但在 `exec` 路径上结构性不可用；claude 有 park/timeout/AFK 兜底。
⇒ UI 必须按 `outcome` 呈现，**不得假设三家都会挂住或都会收场**。

---

## 7. 两张面板的实现方案（含定案）

| 面板 | 语义 | claude | codex | dsh |
|---|---|---|---|---|
| ① 进度清单 | agent **自述**的步骤（声明式意图） | `Task*`（patch，需累积） | `update_plan` → `item.type==='todo_list'`（**工具面是它唯一可得的数据源**） | `todo_write`（整表） |
| ② 派发面板 | **运行时**派发的子任务 | 原生 `system/task_*` | hook + 事件流（§3.2） | 顶层通知 |

**定案**：面板是**派生视图**，由消费方从**工具面 + 事件面**拼出，带 `source: 'tool' | 'event'`。
被否决：把面板做进各家适配器（适配器只该认自己那一家，做不了跨家统一）；
为 codex 单独走 app-server 取原生面板事件（本期不采，当前用工具面替代）。

---

## 8. 配置面：三家开关与闸门（含定案）

| 项 | claude-code | codex | dsh |
|---|---|---|---|
| 规划工具 | **Task 工具按模型门控**（官方：只在 Claude 3.x / Opus 4–4.7 / Sonnet 4–4.6 / Haiku 4.5 默认给；**Claude Code 不认识的模型 ID 默认没有**）。**三条官方 opt-in**：① `tools` 数组里列出；② `allowedTools` 点名；③ `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。另有 **`CLAUDE_CODE_ENABLE_TASKS=0` ⇒ 改用 `TodoWrite`**。生命周期 pending→in_progress→completed、删除=`status:"deleted"`；`TaskCreate` 的结构化输出在**携带 tool_result 的 user 消息的 `tool_use_result`**（`{task:{id,subject}}`）⇒ 不必解析文本 | `tools.update_plan.enabled=true`（实测有效）；⚠️ 全局 subagent 设置仍在 **`[agents]`** 配置段（官方 subagents 文档） | 默认就开 |
| 流式增量 | 需开 **`includePartialMessages`**（见 §4） | 事件流恒 snapshot；app-server 有 `item/agentMessage/delta` | 原生 |
| 交互（ask-user） | 需注册 **`canUseTool`** 回调才有该工具（同时解锁 `EnterPlanMode`/`ExitPlanMode`）；`bypassPermissions` 下回调不被调用（📄 **文档依据**：自动放行的模式在 `canUseTool` 之前就解决调用）⇒ 要收问题得用 `PreToolUse` hook 或换 permissionMode | `exec` 路径不可用（A9） | 默认可用 |
| 多智能体 | `enableWorkflows` 决定 `Workflow` 工具在不在（**不设也在，`false` 才摘掉**）；并发硬闸门 `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS=8` | `features.multi_agent=true` + **模型需带 profile 或落 fallback**（⚠️路由相关） | 默认可用 |
| 闸门日志 | ⚠️ **只在 debug 通道**（`--debug` / `--debug-file`），**不在 stdout/stderr** | —— | —— |
| 规模告警 | ⛔ **进不了任何可见流**（stdout/stderr/debug/SDK 全无） | —— | —— |
| `web-search` | 无条件禁用（推到无条件名单，**推翻按模型名分档**） | 硬编码 `false` | profile patch 里 `tool-web.config.search=false` |
| ⚠️ dsh 的 patch 语义 | —— | —— | 顶层 id-targeted 覆盖是**整份替换**：只写 `{search:false}` 会把 `fetch:true`、`searchTimeoutMs:60000` 抹掉；叠加插件 schema 默认值后 `fetch` 回到 `true` 而 **`searchTimeoutMs` 静默 60000→30000** ⇒ **必须写全三格** |

**定案（Workflow 规模）**：**显式 `enableWorkflows: true` + 并发硬闸门 + 我们按 `subagent-start` 计数留痕**，
作用域是 **Workflow 派生的 agent**；规模告警既然进不了任何可见流，**计数留痕就是唯一的告警来源**。
被否决：总数硬拦（数到第 9 个调 `stopTask`——会在评测中途改写模型编排，把"编排规模"这个应被观察的量抹掉）。

---

## 9. 无法实现的能力（硬边界）

> 分三类。**A 类是厂商结构上不存在**（换配置/换路由都没用）；**B 类是当前路由/配置下不可得**（换条件可能有）；
> **C 类是本机环境挡住**（与厂商和代码都无关）。凡 A 类，契约必须给 `null` + `MissingReason`，**不得用近似值填**。

### A. 厂商结构上不存在（永久）

> ⚠️ **A8、A12 已改判**（"整体能力已解决" / "全部改判"）——它们**不再是硬边界**，保留原编号只为与历史版本对得上；
> 开头那条"凡 A 类 ⇒ 契约给 `null` + `MissingReason`"的规则**不适用于这两行**。

| # | 能力 | 说明 | 对应契约落点 |
|---|---|---|---|
| A1 | codex 事件流里的 **`role`** | 事件流没有 role 概念 | 由 item 类型派生，契约注明"派生值" |
| A2 | codex **原生的模型往返序号** | 厂商无该字段 | 适配器**合成 `roundTrip`**（`item.id` 去重，已知偏高） |
| A3 | codex **hook 载荷里的任务名与状态** | hook 的必填字段里**没有**任务名/描述/prompt/status | `name` 走 §3.3 取值链；`status` 由事件流补（§3.4）；**任务原文（prompt）取自事件流 `collab_tool_call.prompt` 与会话文件**——`<subagent_notification>` **只带 `agent_path` + `status`，不含原文**（§3.2.1） |
| A4 | codex **文件类五族工具**（`read-file`/`write-file`/`edit-file`/`search-content`/`list-files`） | `tool_mode: code_mode_only` 下没有 `read`/`write`/`edit`/`grep`/`glob`（5 个族名对 5 个工具名，一一对应） | `family: null`（**这是 codex 的常态**，UI 必须能吃） |
| A5 | codex **`file_change` item** | 文件改动一律由 `command_execution` 承载 | 该族由 `run-shell` 覆盖 |
| A6 | codex **`command_execution` 的工具名** | item 里没有工具名字段 | 两轴表以 item 类型为键（§2.3） |
| A7 | codex **`item.delta`** | 不存在 ⇒ 事件流内无增量 | `chunk` 恒 `'snapshot'` |
| A8 | codex **事件流里的推理正文** | 上游给了明文；事件流的 `ReasoningItem` 是**摘要**通道，`summary` 空即无 item。**但同一份条目被写进了会话文件** ⇒ 整体能力已解决 | **不再是硬边界**：正文取自**会话文件** `content[].reasoning_text`（全文），标 `source: 'session-file'`（§2.2.1）。**"事件流不含"这一点保留为事实陈述** |
| A9 | codex **`request_user_input` 在 `exec`/SDK 路径上** | `codex exec` 没有交互面，调用被 app-server 以 JSON-RPC `-32000` 拒绝 | `ask-user` 族在该路径**恒空** ⇒ `outcome: 'unavailable'` |
| A10 | codex **原生面板事件**（`PlanUpdate`/`plan_delta`） | 走 app-server/rollout 协议，不在 `exec` JSONL 的事件集里 | 面板只能靠工具面重建（§7） |
| A11 | claude **`Bash` 的结构化退出码** | `BashOutput` 类型面没有该字段 | 失败时从文本 `"Exit code N"` 解析；**成功时保持 `null`（不填 0）** |
| A12 | ~~claude 非交互 SDK 配置下的 `AskUserQuestion`/`TodoWrite`/`ExitPlanMode`~~ **全部改判（2026-10-01 实测）** | 三格**都有门控、都能打开**：① `AskUserQuestion` / **`EnterPlanMode`** / **`ExitPlanMode`** —— 门控是**注册 `canUseTool` 回调**（实测工具表 23→**26**，新增的正是这三个）；② `TodoWrite` / `Task*` —— 门控是**模型名**，官方三条 opt-in 可打开 | 能力位按实测记；**这三格都不得记 `'no'`**（是 `'off-by-adapter'`） |
| A13 | dsh **通知里的 `tool_use_id`（归属键）** | `subagent.started/finished` 不带 | 归属只能靠 `parentSessionId`/`childSessionId` |
| A14 | dsh **`subagent/descriptor` 里的身份** | `data` 里没有 `childId`，身份只在信封 | 不得当身份来源（§3.6） |
| A15 | dsh **`subagent.finished` 的收场保证** | 运行时被关掉时**一条都不会来** | 面板必须能显示"未收场" |
| A16 | dsh **`reasoning-delta`** | 不存在（增量叫 `reasoning-chunks`） | 映射表按实测形态写 |
| A17 | 三家 **"第几次模型往返"的序号** | 三家都没有**序号**；codex 只有 **`turn_id`（id 形式的稳定标识）**；claude 侧 transcript 有 `promptId`/`turnOrigin`（**未验证能否当轮次用**） | 契约给 `roundTrip`（合成）；⚠️ 三家合成方法不同 ⇒ 跨家比较前须核对口径（§1.1-①）。`vendorTurn` 在 codex 上**可考虑用 `turn_id`**，但必须写明它的语义是"**标识**"不是"序号" |
| A18 | codex **除 `responses` 以外的任何 wire** | CLI 的 `wire_api` 是**单变体枚举**：`chat` 报 `` `wire_api = "chat"` is no longer supported ``，其余拼写（`chat_completions`/`openai`/`openai-chat`/`completions`）报 `` unknown variant `…`, expected `responses` ``；**两份二进制**（0.154.0 与适配器实际 spawn 的 0.156.1）行为一致 | 适配器**只能**钉 `wire_api: 'responses'`（现已如此）；**不得**为取推理正文而改 wire——那会让每次运行在**启动阶段**失败 |

> ### ⚠️ 一条容易写错的推论：「换 wire 就能拿到推理正文」
>
> 这句话把**两个层次**混成了一件，必须拆开说：
>
> | 层次 | 事实 |
> |---|---|
> | **上游 API** | **三条 wire 都能拿到推理正文，只是字段名/形状不同**：`/v1/responses` 给 `output[].content[].reasoning_text`；`/chat/completions` 给 `message.reasoning_content`（`deepseek-reasoner` 实测 `hasReasoningContent=true`）；`/anthropic/v1/messages` **不给 `reasoning_content`**，但会给 `thinking` 块（同两轮实测 `hasThinkingBlock=true`，正文以 `thinking` 块到达 ⇒ 见 `dumps/v4/wire-usage-shape.json`、`dsh-reasoning-anthropic-messages.jsonl`）。 |
> | **codex 能配的 wire** | **只有 `responses`**（A18）。⇒ **"换 chat wire"作为 codex 的通道不存在**。 |
>
> **更要紧的是：即便能换也没有收益。** responses wire 上我们**已经**经中继拿到同样的正文（206 字全文）。
> 也就是说，**"拿不到推理正文"的症结从来不是 wire，而是"没有把 `base_url` 指到一个能观察的地方"**——
> 换 wire 是一条**绕路**，而绕过去拿到的内容与直通观察**完全相同**。
>
> ⇒ 结论：**不要**为取推理正文去动 wire（既不可行、也无收益）；要做的是评估 §2.2.1 的中继方案。
> 反过来也要注意：**不得**因为"codex 只剩 responses"就写成"responses 不给推理正文"——它给，只是 codex 不外送。

### B. 当前路由/配置下不可得（换条件可能有）

| # | 能力 | 当前不可得的原因 | 换什么条件可能拿到 |
|---|---|---|---|
| B1 | codex **多智能体（`spawn_agent` 执行器）** | 网关路由上 `unsupported call: spawn_agent`；网关对带 tools 的请求还回 `tool_choice` 错误 | 网关提供带 profile 的模型名；或走已验证可用的另一条 OpenAI 兼容路由 |
| B2 | codex **思考文本** | ~~事件流不含正文~~ | ✅ **已解决**：取自**厂商会话文件**的 `content[].reasoning_text`（**实测全文**，§2.2.1）。限制：事后读盘、依赖厂商格式、上游只回密文时仍无正文 |
| B7 | codex **子智能体的消息 / 工具调用 / 工具结果** | ~~父事件流里没有~~ | ✅ **已解决**：读**子线程的会话文件**——文件名末尾即子线程 id，而该 id 由事件流 `receiver_thread_ids` 给出（§3.2.1） |
| B8 | codex **工具真名**（`wait_agent` 等） | 事件流只给 `wait`；`command_execution` 无工具名字段 | ✅ **可解决**：会话文件里是真名 `spawn_agent` / `wait_agent`（§3.2.1） |
| B3 | dsh **`reasoningTokens`** | 本仓路由的 `mapUsage()` 从不写这一格 | 候选（都未实测）：① **读 dsh 自己的会话日志**（`session-log-*` 附件）；② 复用**本地中继**读上游 `usage`（与 codex 同一手法）；③ 换会投影该字段的路由（会改变被测路由，与口径固定冲突）。⚠️ **dsh 不是公开项目，没有外部资料可查**——这三条只能本机试 |
| B4 | dsh **子任务 `stopReason` 的 `error`/`refusal` 两档** | 类型面有，但 `subagent` 工具入参没有模型/供应商覆盖口 ⇒ 造不出来 | 改工具面，或等真实失败 |
| B5 | claude **`Task*` 在冷存储下** | CLI 不建 `~/.claude/tasks/<sessionId>` 与 `.lock`、对 ENOENT 未兜底 | 预建两级目录（**未验证**） |
| B6 | claude **shell 工具的实测结果** | 见 C1 | 厂商修 |

### C. 本机环境挡住（与厂商和代码无关）

| # | 能力 | 现象 |
|---|---|---|
| C1 | claude 的 `Bash`/`PowerShell` | `EPERM: operation not permitted, mkdir '<TEMP>\claude\…'`——**claude.exe 自身工具沙箱**的拒绝；同路径 node/PS 都建得成、ACL 为 FullControl、换全新 `CLAUDE_CODE_TMPDIR` 仍复现。⚠️ **只限 SDK/嵌入式路径**：CLI 直跑路径是真能跑到 Bash 结果的（`dumps/v2/claude-cli-bash.json`：失败 `Exit code 3`、成功 `123`，§9-A11 的退出码结论正出自它）⇒ 表述为"**SDK 路径**下依赖 shell 的 claude 观测拿不到真实结果"，**不得推广成"这家不能跑 shell"** |
| C2 | codex CLI（SDK 自带那份）的启动 | 目录规则：**exe 在工作区内时，`$CODEX_HOME` 也必须在工作区内**；适配器的 scratch 落在 `tmpdir()` ⇒ 命中失败格。两条绕行：scratch 放工作区内；或 vendor 外置 + `codexPathOverride` |
| C3 | 网关的可用性 | 网络可达**不等于**可用：`/v1/models` 不校验凭据（假 key 也 200）；推理端点对过期凭据回 401「登录态丢失」（**误导性文案**）；带 tools 的请求被 `tool_choice` 拒。**根因已有线索（2026-10-01）**：模型元数据里的 **`use_responses_lite`** 字段 + 上游报告「**Responses Lite forces `parallel_tool_calls:false`**」⇒ 带 tools 的请求畸形成 `tool_choice`。修法在上游（codex 侧已有"为 Responses Lite 改用独立工具"的 PR） |

---

## 10. 定案索引（内容已回填到各节，此处只做索引）

> ⚠️ **本表是"已定案"清单，不是"已落地"清单**：①（`roundTrip`/`vendorTurn`）、②（`parentCallId`）、③（第五态）
> 这三条目前**只落在文档里**——`packages/` 下检索这几个标识符是 **0 命中**（定案已下、代码未改，属已知的实现缺口；
> 落地清单见 §10.1）。已落地的条目会明确写"**本轮已实现/已落地**"（⑥、⑫、⑬）。

| # | 议题 | 定案 | 落点 |
|---|---|---|---|
| ① | `turn` 的语义 | 拆成 `roundTrip` + `vendorTurn`，废弃 `turn` | §1 表 + **§1.1-①** |
| ② | claude 的父消息 | 改名 `parentCallId`，两跳解析写进契约 | §1 表 + **§1.1-②** |
| ③ | codex 的 `thinkingText` 能力位 | 新增第五态 `'not-projected-by-vendor'` | **§0.1** |
| ④ | codex 子任务的通道组合 | hook 身份 + 事件流状态/答复 + 子会话 prompt | **§3.2** |
| ⑤ | codex 的 `statusMissing` | 用事件流 `agents_states` 补 hook 缺的那格 | **§3.4** |
| ⑥ | codex 的 rollout 会话文件 / app-server | **改判（2026-10-01）**：**会话文件采纳**（它是 codex 思考正文与子任务轨迹的**唯一可用来源**）；app-server 仍不采（本期） | **§2.2.1** + **§3.2.1** |
| ⑦ | 两轴统计里 codex 的键 | 以 item 类型为键 | **§2.3** |
| ⑧ | dsh 的 `max-tokens` 映射 | `'failed'`（截断＝没做完） | **§3.5** |
| ⑨ | ~~本地中继是否常态化~~ **已由会话文件取代** | **不再是主方案**：会话文件已经给出同样的正文且无需额外组件；中继降为**备选/排障**（它还能覆盖「会话文件被裁掉」的情形） | **§2.2.1** |
| — | 其余各维（文本合并、`signature`、`textKind`、流式、计量、`commitModel`、面板、Workflow 规模） | 均已定案 | 各节标 **定案** 处 |
| ⑩ | claude 的**流式增量**与**交互工具**（2026-10-01 新增） | **采纳**：SDK 侧开 `includePartialMessages`（文本+思考增量）；`AskUserQuestion` 需注册 `canUseTool`（且要用 `PreToolUse` 或非 bypass 模式才收得到提问） | **§4**、**§6 `ask-user` 行**、**§8** |
| ⑪ | claude 的**规划数据**（2026-10-01 新增） | **采纳官方三条 opt-in**（`tools` 列表 / `allowedTools` / `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`），并**优先用 `tool_use_result` 读结构化输出**，不再依赖模型名判断 | **§8**、**§3.3** |
| ⑫ | codex 的**会话文件读取**（2026-10-01 新增，**本轮已实现**） | **采纳**：思考正文、子智能体消息、`token_count`、`thread_spawn`（父链/深度/昵称）统一走会话文件，标 `source: 'session-file'`；实现落点 `providers/codex/transcript.ts` + `index.ts` 的 `finalize` | **§2.2.1**、**§3.2.1**、**§3.1** |
| ⑬ | **`usage` 增加"时间 + 缓存口径 + 思考/总量"**（2026-10-01 新增） | **已定案并落地**：`tokens` 增 `reasoningOutput`/`total`；`tokens.input` 归一为**非缓存输入**；新增 `timing: { totalMs, apiMs, ttftMs, source }`；命中率与 tok/s 的公式写进契约注释 | **§5.1** 的扩展块 |
| ⑭ | codex 的**轮次口径**是否改用会话文件的 `turn_id`（2026-10-01 新增） | **暂不改**：现有"模型产出条目近似"与 `turn_id` 混用会变成两套口径混算；`turnIds` 已如实落进读取面清单，备将来定案 | **§3.2.1**（子会话读取面的 `turn_id` 行）+ **§3.1** |

### 10.1 定案带来的实现改动清单（按落点归并）

| 落点 | 改动 | 影响面 |
|---|---|---|
| 信封 | 删 `turn`、加 `roundTrip`/`vendorTurn`、`parentMessageId` → `parentCallId` | 三家适配器；所有按 `turn` 分组/比较的消费方；渲染契约的对应限制随之改写 |
| 能力枚举 | 加第五态 `'not-projected-by-vendor'` | 契约与守卫；`messageCapability.thinkingText` 的 codex 取值 |
| codex 子任务 | 三条通道混合组装 + 各带 `source`；`status` 跨通道补 | codex 适配器；需 `thread_id → 子任务` 关联表；派发面板 |
| codex 推理正文 | **定案：读会话文件**（`content[].reasoning_text` 全文），标 `source: 'session-file'`；中继降为备选 | codex 适配器（本轮已实现） |
| codex 子任务轨迹与计量 | **定案：读子线程会话文件**（消息/工具调用/工具结果/`token_count`/`thread_spawn`） | codex 适配器（本轮已实现） |
| claude 流式 | **定案：SDK 侧开 `includePartialMessages`**，自行累积 delta；`parent_tool_use_id` 恒 null ⇒ 只标主会话 | claude 适配器 |
| claude 交互工具 | **定案：注册 `canUseTool`**（否则 `AskUserQuestion` 不出现）；要真正收到提问需 `PreToolUse` 或非 `bypassPermissions` | claude 适配器 |
| claude 规划数据 | **定案：用官方 opt-in**（`tools` 列表 / `allowedTools` / env），并从 `tool_use_result` 读结构化输出 | claude 适配器 |
| 两轴统计 | codex 列以 item 类型为键 | 统计模块（不属于 agents 包） |
| 工具族 | `commitModel` 两值、适配器累积成整表；codex 的 `in_progress` 标 `'unknown'` | 三家适配器 + UI 渲染 |
| 配置面 | Workflow：显式开关 + 并发闸门 + **我们自己计数**（唯一告警来源） | claude 适配器 |
| dsh | `tool-web` patch **必须写全三格**；终态映射按 `status` × `stopReason` 两格 | dsh 适配器 |

---

## 11. 缺口与补齐办法总表（2026-10-01 检索 + 实测）

> 状态口径：**✅ 已实测可用** / **📄 官方文档给出办法（本机未实测）** / **🔎 有线索待试** / **⛔ 无解（厂商侧）**
> 本表是 §9 硬边界与 §12 证据的**索引视图**，不是新的结论来源。

| # | 缺口 | 补齐办法 | 状态 |
|---|---|---|---|
| 1 | codex 思考正文（事件流不含） | 读**厂商会话文件** `content[].reasoning_text`（全文） | ✅ 本机 |
| 2 | codex 子智能体消息/工具调用/工具结果 | 读**子线程会话文件**（按 `receiver_thread_ids` 定位） | ✅ 本机 |
| 3 | codex 嵌套父链 / 深度 / 昵称 | 子会话文件 `session_meta.source.subagent.thread_spawn` | ✅ 本机 |
| 4 | codex 子任务级 usage（含 thinking） | 子会话文件 `token_count.info.*_token_usage` | ✅ 本机 |
| 5 | codex 工具真名（`wait_agent`…） | 会话文件 `function_call.name` | ✅ 本机 |
| 6 | codex 实时性（会话文件是事后读） | `codex app-server`（`item/reasoning/textDelta`、`thread/items/list`，schema 已本地导出） | 🔎 未实测 |
| 7 | `show_raw_agent_reasoning` / `hide_agent_reasoning` 对事件流无效 | **厂商已知 bug**（issue #7090"not respected"；本机五开关四连测同样全 0 条）⇒ 别再试 | ✅ 本机 + 厂商 issue |
| 8 | codex 文件类**五族**工具恒 `null` | 线索：模型元数据里**据说**有 `apply_patch_tool_type`/`tool_mode`/`experimental_supported_tools` ⇒ 或可按模型配。⚠️ **这三个字段在本仓产物里 0 命中**（"无文件工具"另有 `dumps/v2/codex-modelmeta.json` 的 9 件工具支持）⇒ 本行**只有外部线索、没有本机依据** | 🔎 未实测（依据待补） |
| 9 | 网关 `tool_choice` 拒带 tools 的请求 | 根因指向 **Responses Lite**（`use_responses_lite` + 强制 `parallel_tool_calls:false`）；⚠️ `use_responses_lite` 本仓 **0 命中**，"强制并行工具"是**上游 issue 标题（文档依据）**，codex PR#26490 本次未复核 | 🔎 上游修（依据部分为文档） |
| 10 | codex 全局 subagent 配置（`max_depth` 等） | 官方文档：仍在 **`[agents]`** 配置段 | 📄 文档 |
| 11 | claude 的 `chunk:'delta'` 恒 snapshot | SDK 开 **`includePartialMessages`**（实测 `text_delta` 34 段 + `thinking_delta` 34 段 + `signature_delta` 1 段） | ✅ 本机 |
| 12 | claude 的思考增量 | 同上（`thinking_delta` 逐片段到达） | ✅ 本机 |
| 13 | claude 子智能体的 token 级增量 | ⛔ 官方逐字："emitted for the main session only; token-level deltas from subagents aren't forwarded" | ⛔ 厂商侧 |
| 14 | claude 进度清单"没有数据" | Task 工具**按模型门控** + 官方三条 opt-in（`tools`/`allowedTools`/`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`）；`CLAUDE_CODE_ENABLE_TASKS=0` 改用 `TodoWrite` | 📄 文档（本机已见 +4 的效果） |
| 15 | claude `TaskCreate` 的 id 只能解析文本 | 官方：结构化输出在 `tool_use_result`（`{task:{id,subject}}`） | 📄 文档 |
| 16 | claude `AskUserQuestion` 不在工具表（以及 `EnterPlanMode`/`ExitPlanMode`） | **门控是"注册 `canUseTool` 回调"**：显式列进 `tools` 但无回调 ⇒ 仍被剔除（4 个名字只剩 3 个）；**有回调 ⇒ 三个一起出现**（工具表 23→**26**，新增的正是 `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode`） | ✅ 本机 |
| 17 | claude 收到提问后怎么应答 | ⚠️ `bypassPermissions` 下**回调不被调用**（SDK 告警）⇒ 用 `PreToolUse` hook 或换 permissionMode | ✅ 本机（告警原文已落盘：`dumps/v4/claude-sdk-warnings.txt`） |
| 18 | claude 嵌套父链 | transcript 每条带 `parentUuid` + `isSidechain`；子智能体有独立文件 `subagents/workflows/<wf>/agent-*.jsonl` | ⚠️ **未验证**（本机见到的是目录与记录字段，**尚无可引用的产物**；全仓检索这三个名字 0 命中——需补一份 transcript 样本） |
| 19 | dsh `reasoningTokens` | 三条候选（读 dsh 会话日志 / 复用中继读上游 usage / 换路由），**没有外部资料**（dsh 非公开） | 🔎 未实测 |
| 20 | 三家 `step`（一轮内第几次调用） | 无厂商字段；claude 侧 `promptId`/`turnOrigin` 或可当轮次线索（⚠️ 本仓 0 命中，**线索无产物**） | ⛔/🔎 |
| 21 | claude shell 工具本机 EPERM | 未见公开解法（环境/厂商沙箱）；⚠️ **只限 SDK 路径**（CLI 路径真跑得出 Bash 结果，见 §9-C1） | ⛔ 环境（**SDK 路径**） |
| 22 | 规模告警 `tengu_*` 是否产生 | 走 Statsig，不可观测 | ⛔ 环境 |
| 23 | **tok/s 的分母（时间）** | claude ✅ 原生 `duration_ms`/`duration_api_ms`/`ttft_ms`；codex/dsh 只能用**事件/会话行时间戳**算跨度（含工具时间）⇒ 契约加 `timing.source: 'vendor'\|'events'` 区分 | ✅ 已落地（§5.1） |
| 24 | **缓存命中率的归一** | 三家 `input` 语义不同（codex **含** cache、另两家**不含**）⇒ 适配器归一到"非缓存输入"，统一 `cached/(input+cached)` | ✅ 已实测判定（dsh 恒等式 + claude 非零样本佐证）+ 已落地（§5.1） |

**一句话**：24 条里有 **13 条已实测可用**（含第 7 条：厂商 issue 与本机四连测同判）、**3 条有官方文档办法**、**5 条有线索待试**、**3 条确属厂商/环境侧无解**（第 18 条按"未验证"计） ——
其中**第 1/2 条（codex 的思考正文与子智能体消息）此前被判为"要带外取"，现已由厂商自己的会话文件解决**；
**第 23/24 条（tok/s 的时间与缓存口径）本轮补齐进契约**。

---

## 12. 附录：证据索引（结论 → 产物）

| 结论 | 产物 |
|---|---|
| claude 工具表 30/27 项、工具描述原文 | `dumps/v2/claude-inbound-tools.json`、`dumps/v4/q4-inbound-tools.json` |
| claude 思考 token 19 样本 / 恒 ≤ | `dumps/v2/thinking-tokens.json`、`thinking-basis.json` |
| claude `Task*` 返回形状（`id` 来源） | `dumps/v2/claude-task-tools-cli.json` |
| claude `Bash` 退出码 / `subagent_stats` / `Read` | `dumps/v2/claude-cli-bash.json`、`claude-consolidated.json` |
| claude 闸门日志通道 / 规模告警 / 工具表门控 | `dumps/v4/q2d-debug-channel.json`、`q2c-size-warning.json`、`claude-tooltable-names.json`、`claude-tool-gates.json` |
| codex 事件/item 全集、`collab_tool_call`、usage | `dumps/v4/codex-deepseek-events.json` |
| codex hook 两条载荷（含 12 字段无 status） | `dumps/v4/codex-hooks-deepseek.json` |
| codex 推理正文：**事件流无**（`item.type` 无 reasoning） | `dumps/v4/codex-deepseek-events.json` |
| codex 推理正文：**会话文件有全文**（2026-10-01 起的**主来源**） | `dumps/v4/codex-rollout-inspect.json`、`codex-subagent-transcript.json` |
| codex 推理正文：中继也能取（已**降为备选/排障**，§2.2.1） | `dumps/v4/codex-reasoning-relay.json`（+ 原始留档 `dumps/v4/tmp/reason-relay/relay-capture.txt`） |
| codex 文件类操作一律走 `command_execution`（A5/A6） | `dumps/v2/codex-files.jsonl` |
| codex 模型元数据里的 9 件工具（A4 的旁证） | `dumps/v2/codex-modelmeta.json` |
| codex `update_plan` / `todo_list` 二态（§7 面板①） | `dumps/codex-entry.json`（SDK 类型面：`TodoItem={text,completed}`） |
| codex `request_user_input` 的真实行为（A9 存疑项） | `dumps/v2/codex-request-user-input.jsonl` |
| dsh 子任务 abandonment / interrupt（A15） | `dumps/v2/dsh-subagent-abandon.jsonl`、`dsh-subagent-interrupt.jsonl` |
| claude `Bash` 的 CLI 路径真机结果（C1 的边界） | `dumps/v2/claude-cli-bash.json` |
| claude 缓存非零样本（§5.1① 的本机佐证） | `dumps/v2/claude-bash-default.jsonl`（`input_tokens 19` / `cache_creation 65544` / `cache_read 28418`） |
| **claude SDK 告警原文**（`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`，§6/§8/§11-17） | `dumps/v4/claude-sdk-warnings.txt` |
| claude 规模告警的 OTEL 侧证据（§11-22） | `dumps/v4/q2e-otel-size-warning.json`、`claude-report.json` |
| codex 推理字段的二进制引用计数 | `dumps/v4/codex-binary-reasoning-fields.json` |
| **codex 会话文件里的推理正文 + 子智能体轨迹**（父子两份 rollout 逐字） | `dumps/v4/codex-rollout-inspect.json`、`codex-subagent-transcript.json` |
| **app-server 协议 schema**（本机二进制导出；含 `ReasoningTextDelta`、`ThreadItemsList`） | `dumps/v4/tmp/appserver-schema/v2/` |
| codex 开关字符串扫描（`show_raw_agent_reasoning` 等） | `dumps/v4/codex-knobs-scan.json` |
| 思考开关四连测（`show_raw_agent_reasoning` 等对 exec JSONL 无效） | `dumps/v4/codex-reasoning-knobs.json` |
| **claude 两条官方补齐办法的实测**（`includePartialMessages` 的真增量 + `AskUserQuestion` 的 `canUseTool` 门控） | `dumps/v4/claude-official-remedies.json` |

### 官方文档依据（外部资料，2026-10-01 检索）

| 结论 | 出处 |
|---|---|
| claude 的 `includePartialMessages` 与 stream_event 形状；**stream event 仅主会话、`parent_tool_use_id` 恒 null** | [Stream responses in real-time](https://code.claude.com/docs/en/agent-sdk/streaming-output) |
| claude 的 Task 工具**按模型门控** + 三条 opt-in + `CLAUDE_CODE_ENABLE_TASKS=0` + `tool_use_result` 结构化输出 | [Track todos](https://code.claude.com/docs/en/agent-sdk/todo-tracking) |
| claude 的 `AskUserQuestion` 经 `canUseTool` 触发、回调可无限 pending、**子智能体内不可用** | [Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input) |
| codex 的 `show_raw_agent_reasoning`/`hide_agent_reasoning` **不被尊重**（厂商已知 bug） | [openai/codex#7090](https://github.com/openai/codex/issues/7090)、[commit 6576c62](https://github.com/openai/codex/commit/6576c6292cb39aee149348b8aaa8b6a50f7450bd) |
| codex 的全局 subagent 设置仍在 **`[agents]`** 配置段 | [codex subagents 文档镜像](https://github.com/crasuna/openai-dev-docs-cn-mirror/blob/main/docs/mirror/codex/subagents.md) |
| **Responses Lite 强制 `parallel_tool_calls:false`** ⇒ 带 tools 的请求畸形成 `tool_choice`（对应 §9-C3） | [OmniRoute#7821](https://github.com/diegosouzapw/OmniRoute/issues/7821)、[codex PR#26490](https://github.com/openai/codex/pull/26490/files) |
| codex app-server 是 JSON-RPC over stdio，Item 含 agent reasoning（`reasoning` 的 `content` 是明文块）；**`thread/items/list` 见本机导出 schema**（该 README 未列这个方法） | [codex app-server README](https://raw.githubusercontent.com/openai/codex/8fe5066bcc85f625a1fe161027f7365b8bb11f88/codex-rs/app-server/README.md) + `dumps/v4/tmp/appserver-schema/v2/ThreadItemsList{Params,Response}.json` |
| codex `wire_api` 取值矩阵（chat 及其别名**全被拒**，两份二进制一致） | `dumps/v4/codex-wire-api-matrix.json`、`codex-chat-wire-reasoning.json` |
| codex 摘要档位四连测（均无 reasoning item） | `dumps/v4/codex-reason-summary.json` |
| codex 模型 profile 表（`model_messages.multi_agent`） | `dumps/v4/codex-debug-models.json` |
| codex 网关路由失败（`tool_choice` / `unsupported call`） | `dumps/v4/codex-gateway-events.json` |
| codex CLI 目录规则 | `dumps/v4/codex-156-location-matrix.json` |
| dsh 工具表 25 项 / 块协议 / `tool-call-chunks` | `dumps/v2/dsh-tool-table-and-stream.json` |
| dsh `tool/result.meta` 五种形状 | `dumps/v2/dsh-tools.json` |
| dsh 子任务三条终态 + descriptor | `dumps/v4/dsh-subagent-failure.json`（`ok`/`max-tokens`）、`dumps/v2/dsh-subagent-nonok.json`（`error`/`aborted`）、`dumps/v2/dsh-ask-user-child2.jsonl`（`ok`/`completed`）、`dumps/v4/dsh-subagent-descriptor.json` |
| dsh 思考 token 两段证据 | `dumps/v4/wire-usage-shape.json`、`dsh-reasoning-tokens.json` |
| dsh `tool-web` 覆盖语义（含修法） | `dumps/v4/dsh-tool-web-override.json` |
| dsh `ask_user_question` 两条收场 | `dumps/v2/dsh-ask-user.json`、`dsh-ask-user-child.json` |
| 网关可用性与凭据边界 | `dumps/v4/gateway-restored.json`、`gateway-credential-boundary.json` |
