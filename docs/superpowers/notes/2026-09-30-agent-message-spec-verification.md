# Agent 消息规范 v2：未验证项真机验证报告（2026-09-30）

上位文档：`docs/superpowers/specs/2026-09-30-agent-message-spec-design.md`
探测代码：`packages/server/agents/probe/v2/`（脚本 + `lib/`），原始产物：`packages/server/agents/probe/dumps/v2/`（整个 `dumps/` 已 gitignore）

**一句话**：设计稿里 18 处「未验证 / 待实测」项，本轮**闭合 14 处**（其中 **3 处推翻原结论**）、
**2 处改为"已定位但被环境卡住"**（不再是"无法实测"）、**2 处确认仍不可得但给出了精确的原因**。
另有 **2 条设计稿当前的核心断言被真机推翻**（见 §0）。

---

## 0. 先看这三条（推翻原结论）

| # | 设计稿原话 | 真机结果 | 证据 |
|---|---|---|---|
| **A** | §7.0.2：「子智能体数据**永远不可能**从 `runStreamed` 的事件流里拿到」「联合里**没有** subagent 变体」 | **不成立**。事件流里存在 `item.type === 'collab_tool_call'`，字段含 `tool` / `sender_thread_id` / `receiver_thread_ids` / `prompt` / `agents_states` / `status` | `dumps/v2/codex-hook4-events.jsonl`（4 条 item.started/completed 对） |
| **B** | §7.5.5 ⑩ / §9.3：codex 的 `SubagentStart/Stop` 真实载荷「**无法实测**」（前提是网关必须提供 `gpt-6-*`） | **已抓到真实 `SubagentStart` 载荷**。做法：本机放一层**模型名中转**（`gpt-6-astra → gt-6-as-a`），codex 0.154.0 **认识** `gpt-6-astra`，multi_agent 执行器随之注册，hook 真的触发 | `dumps/v2/codex-hook4-hooks.jsonl`；中转脚本 `probe/v2/lib/codex-model-relay.mjs` |
| **C** | §7.6.2.1b A/B：`CLAUDE_CODE_ENABLE_TODO_TOOLS` 把工具表 **26 → 30**（新增 4 个 `Task*`） | **不重现**。同一个 CLI 版本（2.1.281）、三个模型（`Claude-Sonnet-4.6` / `claude-haiku-4-5` / `Claude-Opus-4.8`）各跑 A/B：**默认就是 30 项、开关打开仍是 30 项、增量恒为空** | `dumps/v2/claude-tooltable-ab.json`、`dumps/v2/claude-inbound-tools.json` |

> A 与 B 是同一件事的两面：`collab_tool_call` 就是子智能体的**事件流投影**，
> 而 hook 是它的**带外通道**。设计稿把"CLI 的事件 **type** 只有 5 种"误读成了
> "事件流里没有子智能体信息"——**事件类型封闭 ≠ item 类型封闭**（`item.type` 至少 8 种，见 §2.3）。

---

## 一、环境与可复现口径（本轮探测的可用性前提）

| 项 | 实测值 |
|---|---|
| Anthropic wire 端点 | `http://likecode-llm-proxy-test.jd.com`（**http**，测试环境）与 `https://likecode-llm-proxy.jd.com` 的 `/v1/messages` **都可用** |
| Responses wire 端点 | 同上，`/v1/responses` **可用**（`GPT-5.5` 能跑完一个 turn） |
| 凭据 | 40 字符 likecode token，取自 `~/.cc-switch/cc-switch.db` 的 `ANTHROPIC_AUTH_TOKEN`（只读抽取脚本：`probe/v2/cc-switch-read.mjs`，产物里只留前后缀） |
| 鉴权头 | `x-api-key` 与 `Authorization: Bearer` **三种 wire 都收**（早先"`/v1/models` 200 而 `/v1/messages` 401"是打到了**生产**环境，不是头的问题） |
| 测试环境噪声 | 会偶发把上游超时**当正常回复**返回（assistant 正文就是 `"Request timed out"`，`terminal_reason: 'api_error'`）⇒ 探测脚本都带重试/换端点开关 |
| claude CLI | PATH 上 **2.1.283**；SDK 自带的 **2.1.281**（A/B 用的是 2.1.281，与设计稿同版本） |
| codex CLI | PATH 上 **0.154.0**（本轮所有 codex 真机结论来自它）；SDK 自带的 **0.156.1 在本机起不来**（见 §2.4） |
| dsh | `@deepseek-ai/dsh@0.1.7-rc.1`，凭据取 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY` |

**两条环境边界**（是**本机进程树 + 沙箱**的产物，不是厂商行为，回写时不得当成能力结论）：

1. **经 node 的管道/命名管道拉起厂商 CLI 会 `拒绝访问 (os error 5)`**：
   - codex 0.156.1 无论 `--json` 还是 `--experimental-json` 都失败于
     `failed to initialize in-process app-server client: 拒绝访问。(os error 5)`；
   - claude 经 SDK 时 `Bash`/`PowerShell` 恒定 `EPERM: operation not permitted, mkdir '<TEMP>\claude\<slug>'`，
     `TaskCreate` 在存储层同样 EPERM/ENOENT（三档 `sandbox` 配置都一样）。
2. ⇒ 需要**成功执行**的探测改走 **CLI 直跑 + PowerShell 自己的管道**（`probe/v2/codex-cli-plan.ps1` 与
   `probe/v2/claude-cli-bash.mjs`）；只是**读形状**的探测仍在 SDK 路径上跑（消息外形不受影响）。

---

## 二、codex

### 2.1 §7.3.1 / §11.1 第 23 项：`update_plan` / `request_user_input` 落到哪个 `item.type` —— **已闭合（候选 ①）**

两条 A/B（`dumps/v2/codex-inbound-off.json` / `codex-inbound-on.json`，同一份 0.154.0 二进制）：

| 配置 | 入站 `tools[]` |
|---|---|
| 默认 | `exec_command, write_stdin, request_user_input, view_image, multi_agent_v1, get_goal, create_goal, update_goal, web_search`（**9 项，无 `update_plan`**） |
| 加 `tools.update_plan.enabled=true` | `exec_command, write_stdin, **update_plan**, request_user_input, view_image, multi_agent_v1, get_goal, create_goal, update_goal, web_search`（**10 项**） |

⇒ **`update_plan` 确实是一个工具**（`type: 'function'`），插在 `write_stdin` 之后，与设计稿 §7.6.2 ⑨ 的记载逐字吻合。

**它在事件流里的投影**（`dumps/v2/codex-cli-plan.jsonl`，一次真实计划任务）：

```
item.started   + item.type=todo_list   {"id":"item_2","type":"todo_list","items":[{"text":"提交初始三步计划","completed":false}, …]}
item.updated   + item.type=todo_list   （同一 id，items 状态推进）
item.completed + item.type=todo_list   （终态）
```

结论三条：

1. **候选 ① 成立**：`item.type === 'todo_list'`；`todo_list` 与 `update_plan` **是同一个东西**（第二次 `item.updated` 正是模型第二次调用 `update_plan` 的结果）；
2. ⇒ §7.6.2.2「codex 的面板**只能靠工具面重建**」**方案成立**（候选 ③ 不成立），且 §7.3 表里把 `todo_list` 写成 `attachment` 那一行**是错的**；
3. ⚠️ **但事件流给出的形状比工具输入窄**：工具描述逐字是「a list of plan items, each with a **step and status**. **At most one step can be in_progress at a time**」，
   而事件流里的 `todo_list` 只有 **`items: [{text, completed}]`——布尔，不是三态**。
   ⇒ 适配器从事件流**恢复不出 `in_progress`**；`TaskStep.status` 这一格在 codex 上只能得到 `pending` / `completed`。
   这一条与 §7.6.2 ⑨「codex 的 `update_plan` 与 dsh 的 `todo_write` 语义对齐」**不完全成立**，需要在契约里显式降级。

### 2.2 §11 第 10 项：`request_user_input` 会不会真的挂住 —— **不会，它在 exec 模式直接报错**

`dumps/v2/codex-request-user-input.jsonl` + 同次 stderr（`tools.experimental_request_user_input.enabled=true` + `features.default_mode_request_user_input=true`）：

```
turn.started
item.completed + item.type=agent_message  "已询问用户「是否继续？」，但当前没有收到选项回答。"
turn.completed                            ← 全run 18 秒结束，没有挂住
stderr: ERROR codex_app_server::bespoke_event_handling: request failed with client error:
        JSONRPCError { code: -32000, data: None, message: "request_user_input is not supported in exec mode for thread `01a0f2ca-…`" }
```

⇒ **答案是"结构性不支持"，比"会不会挂住"更硬**：`codex exec` 模式没有交互面，调用直接被 app-server 拒绝；
事件流里**连一条 `request_user_input` 的 item 都不会出现**（只有 `error` + `agent_message`）。
设计稿 §11 第 10 项「实测前不做禁用决定」——现在有了实测：在 **exec/SDK 这条路径上它根本不可用**。

### 2.3 事件与 item 类型全集（§7.0.2 / §7.0.5）

本轮 0.154.0 实测（多轮合并）：

- **事件类型 6 种**：`thread.started` · `turn.started` · `item.started` · **`item.updated`** · `item.completed` · `turn.completed`
  （另有失败态 `turn.failed` 与顶层 `error`）
  ⇒ §7.0.2 的「只有 5 种」**少了一个 `item.updated`**（计划任务里真的出现了）。
- **item 类型**：`agent_message` · `command_execution` · `todo_list` · **`collab_tool_call`** · `error`
  （`reasoning` / `file_change` / `mcp_tool_call` / `web_search` 本轮**未出现**）。`collab_tool_call` **不在 §7.3 的表里**。
- **`item.delta` 不存在**：全部运行里 `含 delta 的行数 = 0`（`dumps/v2/codex-files.jsonl`、`codex-stream.jsonl`）
  ⇒ §7.0.5 那一格「`item.delta` 若有则 `'delta'`（待验证）」**在本机不成立**，codex 侧 `chunk` 恒 `'snapshot'`。
- **`file_change` 未出现**（§7.6.6）：一次"新建文件 + 改文件"的任务里，两次都走 `command_execution`
  ⇒ 在 `code_mode_only` 下 codex **确实不发 `file_change`**。

### 2.4 §7.5.3 牌 A：provider profile 的真实门槛（**比设计稿更细**）

用抓包服务（`probe/v2/codex-capture-server.mjs`，回 400）逐个名字问 codex **认不认识**，判据是
有没有 `Model metadata for '…' not found` 告警：

| 名字 | codex **0.154.0** | 网关有没有 |
|---|---|---|
| **`gpt-6-astra`** | ✅ **认识** | ❌ 无（有 `gt-6-as-a`） |
| `gpt-6-sol` / `gpt-6-luna` | ❌ 不认识 | ❌ |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | ✅ 认识 | ✅ 有 |
| `gpt-5.5` / `gpt-5.4` / `codex-auto-review` / `gpt-daybreak-blue-latest` | ✅ 认识 | 部分有 |
| `gpt-5.3-codex` / `GPT 5.3-codex` | ❌ 不认识 | 有 |

⇒ 两条对设计稿的修正：

1. 「codex 认识哪 3 个 slug」**随版本变**：0.154.0 只认 `gpt-6-astra` 一个带 profile 的名字（不是三个）；
2. **`gpt-5.6-sol` 虽然被认识、网关也有，却跑不通**：网关回
   `Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified.`
   （设计稿 §9.4 把这条列为"网关噪声"，本轮确认它**会让整个 turn 立刻 `turn.failed`**，不是可忽略的噪声）。

### 2.5 §7.5.5 ⑩：`SubagentStart/Stop` 的真实载荷（**部分闭合**）

**做法**：起一层本机模型名中转（`probe/v2/lib/codex-model-relay.mjs`，先按 §9.4.1 的教训**逐块转发**），
把 codex 发的 `gpt-6-astra` 改写成网关有的 `gt-6-as-a`，并剔掉 `gt-6-*` 不认的加密推理载荷。
codex 于是用它**自己那份带 multi_agent profile 的元数据**注册执行器。

**抓到的真实载荷**（`dumps/v2/codex-hook4-hooks.jsonl`，逐字）：

```jsonc
// SessionStart
{ "session_id":"01a0f2d0-a7f5-7753-93cd-0abef6d75eed",
  "transcript_path":"C:\\Users\\…\\sessions\\2026\\09\\30\\rollout-2026-09-30T22-55-55-….jsonl",
  "cwd":"…\\aieval-v2-codex-hook4", "hook_event_name":"SessionStart", "model":"gpt-6-astra",
  "permission_mode":"bypassPermissions", "source":"startup" }

// SubagentStart（**本轮新抓**，设计稿此处原为"无法实测"）
{ "session_id":"01a0f2d0-a7f5-7753-93cd-0abef6d75eed",
  "turn_id":"01a0f2d0-c04f-7383-8391-b182f1ace954",
  "transcript_path":"C:\\Users\\…\\rollout-2026-09-30T22-56-02-….jsonl",
  "cwd":"…", "hook_event_name":"SubagentStart", "model":"gpt-6-astra",
  "permission_mode":"bypassPermissions",
  "agent_id":"01a0f2d0-c036-77d0-bc30-f5b7c1c07d8c",
  "agent_type":"default" }
```

**逐条核对设计稿 §7.5.5**：

| 设计稿的断言 | 真机 |
|---|---|
| ④ `SubagentStart` 必填 `agent_id`/`agent_type`/`cwd`/`hook_event_name`/`model`/`permission_mode`/`session_id`/`transcript_path`/`turn_id` | ✅ **逐字吻合**（多出的实测值：`agent_type: "default"`） |
| ⑨ **没有**任何任务名/描述字段 ⇒ `name` 只能从父消息的 `spawn_agent` 调用关联，否则退 `agent_type` | ✅ **吻合**：载荷里确实只有 `agent_id` + `agent_type` |
| ⑦ 信任闸门：不带 `--dangerously-bypass-hook-trust` 就不执行；带上才执行 | ✅ 吻合（本轮全程带该标志；事件流里回显两条同名告警 `item.type=error`） |
| ⑨ 附注：`transcript_path` 可能为 null | 实测**非 null**（两次都给绝对路径） |
| **hook 真的会因 multi_agent 而触发** | ✅ **本轮首次证到**：同一次运行里 `SubagentStart` 触发 2 次 |

**仍未拿到的一格**：**`SubagentStop` 的真实载荷**。
原因已从"没有模型名"变成了**另一个具体条件**：中转到上游的 `gt-6-as-a` 流会在 `response.completed` 之前断开，
父轮次以 `turn.failed` 收场 ⇒ 子智能体永远走不到收尾。**不改用真实带 profile 的模型名，这一格拿不到。**
⇒ 设计稿 §6.4 开头那条「`SubagentStop` 的 `status` 仅有 schema 级证据」**仍然成立**，但"无法实测"的定性应改为
"**通道已证可触发，只差一个能跑通的上游模型**"。

---

## 三、claude-code

### 3.1 §7.6.6 第 2 行：`Read` 结果里有没有 `<system-reminder>` —— **本轮没见到**

三次运行（SDK 隔离档 2 次 + CLI 直跑 1 次）、工作区内与工作区外各读一次，
`tool_use_result` 里含 `system-reminder` 的条数 = **0**（`dumps/v2/claude-consolidated.json`）。

`Read` 的**两种**返回（同一份文件，逐字）：

```
# 给模型看的文本结果（带制表符行号，且**多出一行空的第 6 行**）
"1\talpha\n2\tbeta\n3\tgamma\n4\tNEEDLE-one\n5\tdelta\n6\t"

# 结构化旁路 tool_use_result（**不带行号**，行数直接给）
{"type":"text","file":{"filePath":"…\\notes.txt","content":"alpha\nbeta\ngamma\nNEEDLE-one\ndelta\n","numLines":6,"startLine":1,"totalLines":6}}
```

⇒ 对 `read-file` 族的三条落地结论：
1. `lineNumbersIncluded: true`（给模型的文本**带行号**）；
2. `lineCount` **不用从末行解析**——结构化旁路直接给 `totalLines`；
3. 设计稿"必须剥掉 `<system-reminder>`"这一条**在本版 CLI 上不成立**（若将来出现，剥掉仍是对的）。

> 附带纠正一个易踩的坑：文本结果**末尾会多一行 `6\t`（空行）**，
> 若用"文本里行号的最大值"当 `lineCount` 会**系统性多算 1 行**。

### 3.2 §7.6.6 第 3 行：`Bash` 能不能拿到退出码 —— **拿不到结构化退出码；失败时退出码在文本里**

CLI 直跑（`dumps/v2/claude-cli-bash.json`，SDK 路径在本机被 EPERM 挡住，见 §1）：

```jsonc
// 失败：命令 node -e "process.exit(3)"
tool_result.is_error = true
tool_result.content  = "Exit code 3"                 // ← 退出码在这里，是**文本**
tool_use_result      = "Error: Exit code 3"           // ← 结构化旁路此时是**字符串**

// 成功：命令 node -e "console.log(123)"
tool_result.content  = "123"
tool_use_result      = {"stdout":"123","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}
```

并且 SDK 类型面 `BashOutput`（`sdk-tools.d.ts` 逐字）**没有任何 `exitCode` 字段**，只有
`stdout` / `stderr` / `interrupted` / `returnCodeInterpretation` / `persistedOutputPath` 等。

⇒ 三条落地结论：
1. `RunShellResult.exitCode` 在 claude 上**只能从失败文本 `"Exit code N"` 解析**，成功时**没有**（保持 `null`，**不填 0**）；
2. 设计稿「三家都只给合并后的输出」**对 claude 不成立**：它给的是**分开的 `stdout` / `stderr`**；
3. `status` 可由 `is_error` 直接判；长输出另有 `persistedOutputPath` / `persistedOutputSize`
   ⇒ **`outputPath` 有真来源**，不必靠描述推断。

### 3.3 §11.1 第 27 项：`TaskStep.id` 从哪来 —— **闭合：来自 `TaskCreate` 的返回**

CLI 直跑（`dumps/v2/claude-task-tools-cli.json`），四次调用的结构化旁路逐字：

| 工具 | 结构化返回 |
|---|---|
| `TaskCreate` | `{"task":{"id":"1","subject":"Probe task one"}}` |
| `TaskCreate` | `{"task":{"id":"2","subject":"Probe task two"}}` |
| `TaskList` | `{"tasks":[{"id":"1","subject":"…","status":"pending","blockedBy":[]},{"id":"2",…}]}` |
| `TaskUpdate` | `{"success":true,"taskId":"1","updatedFields":["status","blockedBy"],"statusChange":{"from":"pending","to":"in_progress"}}` |
| `TaskGet` | `{"task":{"id":"1","subject":"…","description":"…","status":"in_progress","blocks":[],"blockedBy":["2"]}}` |

⇒ **候选 ① 成立**：`id` 来自 **`TaskCreate` 的 result**（`tool_use_result.task.id`），是**序号字符串**（`"1"`、`"2"`），
`blockedBy` 因此**可以解析**——设计稿 §11.1 第 27 项「claude 侧的『依赖』维度会落空」**已解除**。

两条附带事实：
- `TaskList` 的条目里**没有 `owner` 字段**（本机样本：`id/subject/status/blockedBy`）⇒ 设计稿 §7.6.2 ⑨ 写的
  「`TaskList` 返回 `id/subject/status/owner/blockedBy`」在**未指派时**不出现 `owner`；
- **冷存储下 `Task*` 必失败**：`~/.claude/tasks/<sessionId>` 与其中的 `.lock` 目录 CLI 都不建，
  工具对 ENOENT **未兜底**（`ENOENT lstat '…\\.claude\\tasks\\<sessionId>'` → `ENOENT …\\.lock'` → `EPERM mkdir '…\\.lock.lock'`）。
  这是**厂商侧可复现的缺陷形状**，本仓若要用 `Task*` 必须自己先把这两级目录建出来。

### 3.4 §11 第 11 / 16 项：`AskUserQuestion` 在不在工具表里 —— **不在，且与 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 无关**

三个模型 × 两种开关，共 6 次采集（`dumps/v2/claude-inbound-tools.json`）：**30 项，增量恒为空**。
30 项逐字：

```
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree,
Glob, Grep, ListAgents, Monitor, NotebookEdit, PowerShell, PushNotification, Read, ReportFindings,
ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate,
WebFetch, WebSearch, Workflow, Write
```

- **`AskUserQuestion` 不在**，且**开 `CLAUDE_CODE_ENABLE_TODO_TOOLS` 也不会出现** ⇒ 设计稿 §11 第 16 项
  「是否受同一开关影响」**答案是否**；
- **`TodoWrite` 也不在**（§11 第 9 项的残留疑问继续成立）；
- **`Workflow` 在**（§11 第 7 项）：它的工具描述逐字要求**用户显式 opt-in**
  （"ONLY call this tool when the user has explicitly opted into multi-agent orchestration"，
  判据含关键词 `ultracode`、用户原话"use a workflow"等）⇒ **不会被默认触发**，
  "claude 用了编排而另两家没用"这类比较在默认提示词下**不会失真**；
- `~/.claude.json` 的 `toolUsage` 里**有** `AskUserQuestion` 与 `TodoWrite` 的历史计数
  ⇒ 它们**存在于某些配置/交互式会话**，只是**不在本机这套非交互 SDK 配置的工具表里**。

### 3.5 §11 第 6 项：`ReportFindings` 的语义 —— **查清**

工具描述逐字（`dumps/v2/claude-inbound-tools.json`）：

> "Report **code-review findings** as a typed list so **the host UI can render them**. Use this only when
> the active code-review instructions tell you to report findings with this tool … call it once with the
> verified findings ranked most-severe first (**empty array if nothing survived verification**)"

输入 schema：`{level?: 'low'|'medium'|'high'|'xhigh'|'max', findings:[{file, line, summary, short_summary?,
failure_scenario, category?, verdict?: 'CONFIRMED'|'PLAUSIBLE', outcome?: 'fixed'|'skipped'|'no_change_needed'}]}`。

⇒ 它**不是**"把结论交付给调用方"的通用投递工具，而是**代码评审结论的结构化上报口**，面向**宿主 UI**。
两轴取值应据此定：动作是 `deliver`，对象是**宿主/用户**（`user`），**不是 `agent`**——
设计稿 §7.6.8 的 `deliver / agent` 占位**应改**。

### 3.6 §6.4.5：`subagent_stats` 在 SDK 流里**确实存在**

三次运行里 `result` 消息上都带它（`dumps/v2/claude-consolidated.json`），形状与设计稿逐字一致：

```json
{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,
 "max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,
 "killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}}
```

⇒ "未收编进 **SDK 类型面**（`sdk.d.ts`）"这一点成立，但它**出现在运行时载荷上**——
适配器可以直接读，只是没有类型声明背书（`raw` 兜底口径适用）。

---

## 四、dsh

### 4.1 §6.5.2 / §11.1 第 20 项：失败 / 取消路径的 `subagent.finished` —— **已抓到（且不能按 `status` 映射）**

`dumps/v2/dsh-subagent-interrupt.jsonl`（父智能体 `interrupt_agent` 掉一个正在跑的后台子任务）：

```jsonc
{ "provider":"spawn",
  "agentId":"d4078553-fd02-4bfd-b065-f96d38126c94",
  "parentSessionId":"session-82769239a12849f3b74082a32a5c3970",
  "childSessionId":"d4078553-fd02-4bfd-b065-f96d38126c94",
  "status":"error",          // ← 非 ok 的真实取值
  "stopReason":"aborted",    // ← 取消路径
  "lastAssistantMessage":[{"type":"reasoning","text":"The user wants me to run a loop 40 times …"}] }
```

**三条必须回写的结论**：

1. **非 ok 取值是 `status: "error"` + `stopReason: "aborted"`**；
2. ⚠️ **不能只看 `status`**：`"error"` 字面像"失败"，而真实语义是**取消**（父智能体主动中断）。
   设计稿 §6.5.2 那张映射表只有「`status:"ok"` → `completed`」一行，**必须补上这一行并按 `stopReason` 判**，
   否则一次主动取消会被记成"子任务失败"——正是本仓最忌讳的假数据；
3. **被取消时 `lastAssistantMessage` 里可能只有 `reasoning` 块、没有 `text` 块**
   ⇒ `outcome` 那一格必须允许 `null`（不能退而取 reasoning 文本）。

**另一格（abandon 场景，`dumps/v2/dsh-subagent-abandon.jsonl`）**：子任务还在跑时直接关掉运行时，
**没有任何 `subagent.finished`**——派发面板上会留下一条永不收场的条目。这是真实的观测事实。

**顺带两条**：
- `subagent/catalog` 的 `mode` 本轮见到 **`"continuable"`**（设计稿记的是 `"one-shot"`）⇒ 该字段至少有这两个取值；
- 出现了设计稿 §7.2 映射表里**没有**的三个会话事件：`permission/preset` · `sandbox/mode` · `approval/policy`，
  以及**一条 `subagent/descriptor`**。

### 4.2 §7.6.6：`edit` / `grep` / `pwsh` / `write` 的结果形状 —— **全部拿到**

`dumps/v2/dsh-tools.json`（一次任务里 8 次 `tool/call` + 8 次 `tool/result`）。关键事实：
**dsh 的 `tool/result` 带一个 `meta` 字段，结构化数据全在那里**——而设计稿 §7.2 的映射表**完全没有提到它**。

| 工具 | `meta` 逐字 | 对族结构的落点 |
|---|---|---|
| `read` | `{"path":…,"offset":1,"lines":[{"number":1,"text":"alpha"},…],"totalLines":5}` | `lineCount = totalLines`；**不必解析文本**（§7.6.3 说"从末行取"是次优解） |
| `glob` | `{"shape":"paths","paths":[…],"truncated":false,"total":2}` | 与设计稿一致 |
| **`grep`** | `{"shape":"matches","files":[{"path":"notes.txt","matches":[{"lineNumber":4,"line":"NEEDLE-one"}]}],"truncated":false,"total":2}` | **设计稿缺这一格**：`mode` 应由 `meta.shape` 直接给（`'matches'` 等），**不要 parse 文本**；字段名是 `lineNumber`/`line`，不是 `line`/`text` |
| **`write`** | `{"operation":"create","diffs":[]}` | `created = (operation === 'create')` ——**`created` 有真来源**；`bytes` 仍拿不到 |
| **`edit`** | `{"diffs":[{"path":"src/app.ts","oldText":"…","newText":"…"}]}` | **厂商给了前后文本**（`oldText`/`newText`，不是 unified diff）⇒ `EditFileResult.diff` 可由它派生；`applied`/`replacements` 拿不到 |
| **`pwsh`** | （无 `meta`）文本为 `"(no output)\n[exit code: 1]"` | **退出码在文本尾部**（`[exit code: N]`），**成功时没有这个尾部** ⇒ `exitCode` 可解析、成功时保持 `null` |

> `read` 的给模型文本是 **`<path>/<type>/<content>` 三标签包裹 + `N: ` 行号 + `(End of file - total N lines)`**，
> `lineNumbersIncluded: true` 成立；`grep` 的文本是 `Found N matches` 加按文件分组。
> **但既然有 `meta`，族结构应当以 `meta` 为准、文本只作兜底**——这是本节最省事的一条结论。

### 4.3 §7.6.2 ⑩：`ask_user_question` 的两条非正常收场 —— **都拿到原文**

工具表实测 **25 项**（24 + `ask_user_question`），`request/header.data.header.tools[]` 逐字可查
（`dumps/v2/dsh-tool-table-and-stream.json`）。

**① 无人应答（本仓的必然分支）** —— `dumps/v2/dsh-ask-user.json`：

```
tool/call   name=ask_user_question   arguments={"questions":[{"id":"confirm","question":"…","header":"确认","options":[…]}]}
tool/result isError=true
            content=[{"type":"text","text":"Error: no user-questions answerer accepted the request"}]
```

**② 子智能体提问（被拒）** —— `dumps/v2/dsh-ask-user-child.json`：

```
tool/result isError=true
            content=[{"type":"text","text":"Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result"}]
```

⇒ 两条设计稿只有文档级依据的硬约束**都在真机上成立**，且**错误文案逐字可引用**。
设计稿 §7.6.2 ⑩ 写的"错误码 `DELEGATED_CALLER`"**没有出现在载荷里**——载荷只有消息文本，
`outcome: 'rejected'` 的判据只能按**消息文本**匹配。

### 4.4 流式：dsh 的块协议（§7.2 / §8）

`dumps/v2/dsh-tool-table-and-stream.json`，一次多工具任务里 `assistant/message.data.stream[]` 的条目类型全集：

```
chunk:block-start ×18   block-end ×18   chunk:usage ×5   chunk:finish ×5
reasoning-chunks ×5     text-chunks ×5   **tool-call-chunks ×16**
```

- **不存在任何 `*-delta`**（复核了 §7.2"dsh 不发 `reasoning-delta`"的结论 ✅），
  增量条目叫 `reasoning-chunks` / `text-chunks` / `tool-call-chunks`（复数、带数组）；
- ⚠️ 设计稿 §7.2 的映射表**只写了 `text-chunks`**，漏了 `reasoning-chunks`（推理的增量）与
  **`tool-call-chunks`**（工具调用的增量）。§8.1「dsh 的工具调用都没有 token 流」这句**与实测不符**；
- `assistant/message.message.content[]` 的块类型：`reasoning` / `text` / `tool-call`（8 次）；
  **推理文本非空**（本轮长度 188/176/70/200/81 字符）——继续支持 2026-09-30 的那次更正。

---

## 五、逐项对照表（设计稿的"未验证"标记 → 本轮结论）

| # | 设计稿位置 | 原状态 | 本轮结论 |
|---|---|---|---|
| 1 | §7.3.1 / §11.1-23 codex `update_plan`/`request_user_input` 的 item 落点 | ❌ 未验证 | ✅ **闭合**：`item.type='todo_list'`（候选 ①）；`todo_list ≡ update_plan`；形状是 `{text, completed}` 二态 |
| 2 | §7.0.5 / §7.3 codex `item.delta` | 待验证 | ✅ **闭合**：不存在（0 命中），`chunk` 恒 `snapshot` |
| 3 | §7.6.6 codex `file_change` 在 `code_mode_only` 下是否出现 | 未验证 | ✅ **闭合**：不出现（走 `command_execution`） |
| 4 | §7.0.2 codex 事件联合"只有 5 种、无 subagent 变体" | 已定论 | ❌ **推翻**：多一个 `item.updated`；且 `item.type` 有 `collab_tool_call`（子智能体！） |
| 5 | §7.5.5 ⑩ / §9.3 codex `SubagentStart/Stop` 真实载荷 | ❌ 无法实测 | ⚠️ **部分闭合**：`SubagentStart` 真机已抓（含 `agent_type:"default"`）；`SubagentStop` 仍缺，卡点变成"上游模型跑不通" |
| 6 | §11-10 `request_user_input` 会不会挂住 | 待实测 | ✅ **闭合**：不会挂住；`codex exec` 模式**结构性不支持**（JSON-RPC -32000） |
| 7 | §7.5.2/§7.5.3 codex 认识哪些带 profile 的 slug | 已定论（3 个） | ⚠️ **需更正**：0.154.0 只认 `gpt-6-astra`；`gpt-5.6-*` 虽被认识但网关侧 `tool_choice` 报错直接 `turn.failed` |
| 8 | §7.6.6 claude `Read` 是否恒带 `<system-reminder>` | 未验证 | ✅ **闭合**：本版（2.1.281/2.1.283）**不出现**；且文本末尾多一行空编号行（会多算 1 行） |
| 9 | §7.6.6 claude `Bash` 能否拿到退出码 | 倾向拿不到 | ✅ **闭合**：无结构化退出码；失败文本是 `"Exit code N"`；成功时 `tool_use_result` 给**分开的** `stdout`/`stderr` |
| 10 | §11.1-27 `TaskStep.id` 的来源 | ❌ 缺一环 | ✅ **闭合**：`TaskCreate` 的 `tool_use_result.task.id`（序号字符串），`blockedBy` 可解析 |
| 11 | §11-11 / §11-16 `AskUserQuestion` 是否在工具表、是否受同一开关影响 | 未确认 | ✅ **闭合**：不在；开关**无增量**（3 模型 × 2 档，30 项恒定） |
| 12 | §7.6.2.1b A/B「26 → 30」 | 已证 | ❌ **不重现**：默认就是 30；增量恒为空 |
| 13 | §11-7 claude 的 `Workflow` 是否会被默认触发 | 待确认 | ✅ **闭合**：需用户显式 opt-in（`ultracode` / 用户原话），默认不会 |
| 14 | §11-6 `ReportFindings` 的语义 | 待真机确认 | ✅ **闭合**：代码评审结论的结构化上报口，面向宿主 UI ⇒ 两轴应为 `deliver` / **`user`**（非 `agent`） |
| 15 | §6.4.5 `result.subagent_stats` 是否可达 | 未收编类型面 | ✅ **确认**：运行时载荷上**确实有**（`result` 消息），只是 `sdk.d.ts` 未收编 |
| 16 | §6.5.2 / §11.1-20 dsh 失败·取消路径 `status` 形态 | ❌ 未抓到 | ✅ **闭合**：`status:"error"` + `stopReason:"aborted"`；**必须按 `stopReason` 判**，否则取消会被记成失败 |
| 17 | §7.6.6 dsh `edit`/`grep`/`pwsh` 结果形状 | 仍无样本 | ✅ **闭合**：三者的结构化数据都在 `tool/result.meta` 里（详见 §4.2） |
| 18 | §7.6.2 ⑩ dsh `ask_user_question` 的 `unavailable` / `DELEGATED_CALLER` | 只有文档级依据 | ✅ **闭合**：两条错误原文都拿到；`DELEGATED_CALLER` 这个**码名不在载荷里** |
| 19 | §7.2 dsh「不发 `reasoning-delta`」 | 已证 | ✅ **复核成立**；但增量条目还有 `reasoning-chunks` 与 **`tool-call-chunks`**（映射表漏写） |
| 20 | §7.2 dsh `tool/result` 的形状 | 映射表只写了 `callId`/`status`/`text` | ❌ **需更正**：真实载荷多一个 **`meta`**，结构化字段全在那里 |

---

## 六、复现命令

```powershell
cd packages/server/agents

# 0) 端点与凭据（只读，不打印密钥）
node probe/v2/models.mjs
node probe/v2/cc-switch-read.mjs

# 1) dsh（本地凭据，最省事）
node probe/v2/dsh-tools.mjs              # read/glob/grep/write/edit/pwsh 结果形状 + 工具表 + 流式协议
node probe/v2/dsh-tool-table.mjs         # 工具表与 chunk 类型汇总
node probe/v2/dsh-subagent-nonok.mjs     # 子任务取消（interrupt_agent）与非收场（close）
node probe/v2/dsh-ask-user.mjs           # ask_user_question 无人应答
node probe/v2/dsh-ask-user-child.mjs     # 子智能体提问被拒

# 2) claude
node probe/v2/claude-tooltable-ab.mjs    # 工具表 A/B（SDK 路径）
node probe/v2/claude-inbound-tools.mjs   # 入站 tools[] 全文（含 description / schema），三模型 × 两档
node probe/v2/claude-tool-results.mjs    # Read / Task* 结果形状（SDK 路径）
node probe/v2/claude-cli-bash.mjs        # Bash 退出码（CLI 路径）
node probe/v2/claude-task-tools-cli.mjs  # TaskCreate/List/Update/Get 的返回形状
node probe/v2/claude-consolidate.mjs     # subagent_stats / 版本 / system-reminder 汇总

# 3) codex
node probe/v2/codex-capture-server.mjs 7998 v2/codex-inbound-on   # 另开一个终端；入站 tools[] 抓包
node probe/v2/codex-cli-plan.mjs         # update_plan 的 item 落点（需 CLI 直跑，见 .ps1）
pwsh -File probe/v2/codex-cli-plan.ps1   # 同上，走 PowerShell 自己的管道

# 4) codex 子智能体 hook（"牌 A"的本机复现）
node probe/v2/lib/codex-model-relay.mjs 7999 https://likecode-llm-proxy.jd.com
# 然后按 §2.5 的配置跑 codex（-m gpt-6-astra + features.multi_agent=true
#   + --dangerously-bypass-hook-trust + hooks.SubagentStart/Stop 指向 probe/v2/hook-log.cjs）
```

---

## 七、本轮仍未闭合（如实登记）

| 项 | 现状 | 还差什么 |
|---|---|---|
| codex `SubagentStop` 真实载荷（是否有 `status`） | **通道已证可触发**，`SubagentStart` 已抓；`SubagentStop` 未抓到 | 一个能跑通 `stream` 的带 profile 模型（本机中转到 `gt-6-as-a` 会在 `response.completed` 前断流） |
| codex 0.156.1（适配器实际 spawn 的那份）的**任何**行为 | 本机起不来（`拒绝访问 os error 5`） | 解除"经 node 管道拉起子进程"的沙箱限制；否则本轮 codex 结论都带 0.154.0 的版本前提 |
| claude 的 `Bash` 在 **SDK 路径**上 | 恒 `EPERM`（三档 sandbox 配置一致） | 同上；退出码结论取自 CLI 路径 |
| claude `Task*` 在**冷存储**下 | `~/.claude/tasks/<sessionId>` 与 `.lock` 需外部预建 | 厂商修；或本仓自己建（已给出确切路径） |
| dsh 派生面板的 `subagent/descriptor` | 只见到事件名，未解析 | 一次专门探测 |
