# Codex 接入

## 定位

Codex 的适配器完全由 `codex app-server` 驱动与取数（JSON-RPC over stdio），厂商包是 `@openai/codex`（纯 JS 启动器，原生二进制在平台包 `@openai/codex-<platform>-<arch>` 的 `vendor/<triple>/bin/codex(.exe)`）。协议能力面与 DSH 逐格对齐且不降级，`cancelMidTurn` / **原生结构化输出通道** / 子任务父链与昵称深度 / `reasoningOutput` / 用量合计是 Codex 更强的格子。能力声明：`protocolTypes: ['openai']`，`cancelMidTurn` / `usage` 两格全 `true`；结构化输出不是能力位——`turn/start` 的 `outputSchema` 是原生通道，本次有没有真的走成由适配器在收尾上报（`applied.structuredOutput`）。

## 形态与交互

- **进程与帧**：TS 侧没有官方 app-server 客户端，适配器自建客户端——stdio 传输、**行分隔 JSON 帧**，只做 spawn / 握手 / 请求响应配对 / 收通知；坏帧计数不静默（`unparsedFrames()` 可查）。
- **一次运行一个 app-server 进程**：收尾取数复用同一客户端——线程树是该进程的内存态，进程没了树就没了。
- **握手顺序固定**：`initialize`（带 `experimentalApi`）→ `thread/start`（返回 `threadId`）→ `turn/start`（返回 `turnId`）。
- **URL 规则**：base 必须补 `/v1`（`ensureV1Suffix` 不能省）——CLI 在 base_url 后直接拼 `/responses`，故本仓统一打 `POST {base}/v1/responses`。
- **wire 只能钉 Responses**：`wire_api` 只接受 `responses`；`chat` 及别名（`chat_completions` / `openai-chat` / `completions`）全被拒，`thread/start` 响应 `-32600`，报错原文：
  ```text
  failed to load configuration: `wire_api = "chat"` is no longer supported.
  How to fix: set `wire_api = "responses"` in your provider config.
  More info: https://github.com/openai/codex/discussions/7782
  ```
  根因不是配置写法：codex 客户端已删除 chat 实现（实测 0.156.1 二进制里 `chat/completions` / `v1/chat` / `use_chat_completions` 零命中；0.160.1 的 `WireApi` 枚举只剩 `Responses`），升级也换不回来。
- **注入落点**：线程级 `config` 由 `buildCodexConfig` 构造——`model_provider: 'aieval'` + `model_providers.aieval{ name, base_url, wire_api: 'responses', env_key: 'OPENAI_API_KEY', request_max_retries: 1 }` + `tools: { web_search: false, update_plan: { enabled: true } }` + `features: { multi_agent: true }`；`model_context_window` / `model_reasoning_summary` 只在已知时出现。
- **权限档按平台选**：Windows 上只有 `danger-full-access` 能真正起子进程（`read-only` 与 `workspace-write` 下连 `echo` / `git status` 都被拒，stderr 原文 `Rejected(\"… rejected: blocked by policy\")`）；macOS（seatbelt）与 Linux（landlock）不动。兜底：编排层「评分前后 diff 摘要对照」从 WARN 升级为行失败。
- **停止与释放顺序固定**：`interrupt()`（发 `turn/interrupt`，是协议能力、不 kill 进程）→ 等在途 turn 终结（最多 5 秒）→ `dispose()`（`session.close()`：**杀整棵进程树并等 exit** + 删临时目录；Windows `taskkill /T /F`，POSIX 进程组 `SIGKILL`）。被终止的那一轮不等收尾取数；起手三步失败也要回收（`close()` 杀树失败退回直接 kill，等不到就如实回 `exited: false` 由调用方 WARN）。

## 数据与契约

协议条目到本仓契约的映射（`turns` 是近似值——一条 Turn 内含多次模型往返）：

| app-server 协议条目 | 契约投影 |
|---|---|
| `item/agentMessage/delta` | `textBlockDraft(text, 'delta')`，`streamingDelta` 标 `yes`/`wire` |
| `item/completed(reasoning).content[]` | `thinking{ textKind: 'full' }`；`content` 空 ⇒ `text: null` + `'none'`（不回落 summary） |
| `reasoning.summary[]` | `thinking{ textKind: 'summary' }` |
| `commandExecution` | 工具调用 + 结果块（命令 / 输出 / 退出码 / 耗时） |
| `fileChange` | `toolCallBlockDraft('apply_patch', …)` + `structured = { changes, status }` |
| `mcpToolCall` | `name = '<server>.<tool>'`、`family: null`、`isError = error != null` |
| `plan` / `turn/plan/updated` | `family: 'task'` + `payload: { kind: 'plan', steps, note }` |
| `collabAgentToolCall` / `subAgentActivity` | 子任务行（身份 / 派发配对 / 终态三档） |
| `turn/completed` | 用量 + 时长（`timing{ source: 'events' }`，`apiMs` / `ttftMs` 恒 `null`） |
| `thread/tokenUsage/updated` | 按线程用量累计（`input − cached`） |
| `mcpServer/startupStatus/updated` | `vendor-system` 事件（`mcpChannel: 'vendor-startup-status'`，每台 `starting` / `ready` / `failed` + `error` 原文；每条交**累积之后的全量**） |

- **`finalText` 出口四条件缺一不可**：`itemCompleted`（`item/started` 正文可能半截）、`agentMessage`、主线程（子线程结论不顶主会话）、正文非空。评分通路只读 `finalText`，不从事件流重建——app-server 重构曾漏写这一格，表象是 `JUDGE_PARSE_FAILED：评分智能体没有给出可读的最终答复（该适配器未回传最终消息）`（会话 `ok=true`、上游也回了 JSON，只有本仓交不出答复）。
- **思考块规则**：`item/started` 的空占位不产块；`reasoningDrafts` 无条件补快照封口（同内容重发幂等覆盖）；界面层对无正文的思考块整块隐藏，不给占位文案。
- **读取契约**：只声明消费得到的字段，读不到就是 `null`——不做默认值填充、不用空串或 0 冒充「没采到」。
- **用量口径**：只从运行期 `thread/tokenUsage/updated` 通知累计（协议没有「按线程读用量」的请求，`thread/read` 不返回用量）；`total` 是全树合计（主会话 + 数到的每个子智能体），任一子线程拿不到用量 ⇒ `subagentTokens` / `subagentTurns` 两分量同时 `null` 并落点名 WARN。三条硬口径：采不到就是 `null` 绝不填 0；估算值不进结果；`turns` 与 `tokens` 互不兜底。
- **轮次口径**：数模型答复条目（`agentMessage` 的 `item.id`），按线程分别去重、收尾相加；只发工具调用没有答复的段偏低（近似值），一个答复都没有时 `null` 不编 0。

## wire 形态与事件

本仓消费的通知通道全集（未识别方法归 `other` 不抛错）：

```text
thread/started
thread/status/changed
turn/started
turn/completed
item/started
item/completed
item/agentMessage/delta
item/reasoning/textDelta
item/reasoning/summaryTextDelta
item/plan/delta
item/commandExecution/outputDelta
thread/tokenUsage/updated
turn/plan/updated
```

- **`item/*` 通知无条件下发**，不受 `show_raw_agent_reasoning` 之类开关影响（那些只作用于 legacy 投影与 TUI / exec 输出）。
- **审批类是 server→client 请求**（`item/…/requestApproval`，带 `id`）：单独归类、**不回帧**——`approvalPolicy: never` 下应答等于替用户批准。
- **结构化输出的 wire 落点**：`turn/start` 一等字段 `outputSchema`（协议原文「Optional JSON Schema used to constrain the final assistant message for this turn」）落到 Responses 请求的 `text.format = { format: { type: 'json_schema', strict: true, name: 'codex_output_schema', schema: … } }`。A/B 真机对照证明 schema 真被执行：对抗题面「请用中文散文回答，不要输出 JSON」——带 schema 回仍是 JSON（模型 reasoning 自述「the response format schema is enforced by the system. I must comply with the schema」），不带回中文散文。
- **推理正文（reasoning）现口径**：`codex exec --json` 里 `item.type === 'reasoning'` 恒 0 条（exec 的 JSONL 投影只取 `summary` 丢弃 `content`）——**取思考内容一律走 app-server**。快照取 `item/completed` 的 `reasoning.content[]`（一项即全文，实测 4 case 117 / 227 / 151 / 278 字；`item/started` 那帧两格都是空数组，别在 started 取值）；增量 `item/reasoning/textDelta` 逐字拼接后与 `content[0]` 完全相等（4/4，实测 39 / 54 / 49 / 72 条，条数恰等于 `reasoningOutputTokens`，1 delta ≈ 1 token）。摘要在 DeepSeek 网关上结构性拿不到（`summaryTextDelta` 恒 0 条，上游不给），`model_reasoning_summary` 不设或写 `auto`；`effort === 'off'` 时注入的 `CODEX_OFF_REASONING_SUMMARY = 'none'` 真机上既不报错也不影响推理照常产出（空转格，别指望它关掉任何东西）。
- **线程树**：`thread/list{ ancestorThreadId }` 一次返回任意深度的全部后代（分页 `limit` 100、`nextCursor` 续读；不含主线程自身）；深度与昵称取厂商声明 `source.subagent.thread_spawn`（`{ depth, agent_path, agent_nickname }`），不按链长推算——旧 SDK 时代的深度 8 / 广度 32 上限不复存在。子智能体工具是 `collabAgentToolCall`（`spawnAgent` / `wait` / `closeAgent`），`wait` 的 `agentsStates[<childId>].message` 直接是子智能体结论原文。

## 提问与应答面

厂商在服务端协议里就有提问请求（`item/tool/requestUserInput`，**server→client 请求**），本仓声明 `askUser: yes` + `askUserChannel: 'vendor-tool'`，一致性场景走**真路径**（真 `codex app-server` + 本机假上游，只把上游模型脚本化）。

| 面 | 现时做法 |
|---|---|
| 通道 | 线程级配置里那两格提问开关（`tools.experimental_request_user_input` 与 `features.default_mode_request_user_input`）随应答面同生同灭；请求到了由适配器装帧回帧 |
| 递答案 | 答案**按题目 id** 配对：`{answers: {<question.id>: {answers: string[]}}}`——不是按序号、也不是按标题 |
| 等待预算 | 没有这一档：`autoResolutionMs` 已 `@deprecated` 且实测恒 `null`，`isBlocking: false` 也不让它收场（不回帧它会一直等） |
| 收场 | 「没人答 / 等超时 / 行终止」三条都由我们回一帧**空表** `{answers: {}}`——那是厂商原生的「没有答案」语义，模型据此继续按最佳判断干活；收场方式按这一问的实际结果落 `answered` / `timeout` / `canceled`，**没有** `auto-resolved` 这条路径 |

### 选择模式：只有单选

厂商自己出的类型（`codex app-server generate-ts --experimental`，ts-rs 从 Rust 结构体直出）给出题目对象的**全部六格**——**没有多选这一格**（本仓契约的 `multiSelect` 在厂商线上没有对应物）：

```ts
// EXPERIMENTAL. Represents one request_user_input question and its required options.
export type ToolRequestUserInputQuestion = { id: string, header: string, question: string,
  isOther: boolean, isSecret: boolean, options: Array<ToolRequestUserInputOption> | null };
// EXPERIMENTAL. Defines a single selectable option for request_user_input.
export type ToolRequestUserInputOption = { label: string, description: string };
```

模型拿到的那份参数说明把这条口径写死（厂商二进制里的逐字文本，字段名与它自己的说明相邻）：

```text
label:     User-facing label (1-5 words).
description: One short sentence explaining impact/tradeoff if selected.
options:   Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its
           label with "(Recommended)". Do not include an "Other" option in this list; the client will
           add a free-form "Other" option automatically.
id:        Stable identifier for mapping answers (snake_case).
header:    Short header label shown in the UI (12 or fewer chars).
question:  Single-sentence prompt shown to the user.
questions: Questions to show the user. Prefer 1 and do not exceed 3
```

运行期另有一条门禁（同一份原文）：`request_user_input requires non-empty options for every question`——**每一题都必须给候选项**，连「没有候选项的开放问」都不受理。JSON schema 那条路（`codex app-server generate-json-schema --experimental`）是本条的第二种可复现形式：`ToolRequestUserInputQuestion` 的 `required` 只有 `header / id / question`，`options` 是 `["array","null"]` 且无 `minItems` ⇒ 「必须有候选项」不是 schema 约束，而是上面那条运行期门禁。

⇒ **多选只能拆成多次提问**：N 个选项里让用户挑多个，要么一题一个「要不要」问 N 次（每次仍须给候选项），要么让用户把多个值写进那一段自由输入。代价两条：① 每一问各占一次人机往返（模型在两问之间会停一轮，两题不共享一次答复）；② 题面与实际交互会分叉——真机上模型把第 2 题写成「（可多选，可勾选多个）」，而界面仍是互斥单选，模型自己也如实记下「schema 只支持互斥选项、没有多选开关」。

### 应答帧：字符串数组，但不含多选语义

```ts
// EXPERIMENTAL. Response payload mapping question ids to answers.
export type ToolRequestUserInputResponse = { answers: { [key in string]?: ToolRequestUserInputAnswer } };
// EXPERIMENTAL. Captures a user's answer to a request_user_input question.
export type ToolRequestUserInputAnswer = { answers: Array<string> };
```

两件事必须分开说：

- **装得下**：每题的答案格是 `Array<string>`（JSON schema 里也是 `{"items":{"type":"string"},"type":"array"}`，无 `maxItems`），塞多段文本不违反 schema；
- **装得下 ≠ 能多选**：厂商侧没有任何一格声明「多个元素 = 同时选中 N 个选项」——那一格的说明只有上面那句 *Captures a user's answer to a request_user_input question.*，而厂商自己的 TUI 在题面上只有这几句（同一份二进制里的原文）：`←/→ to navigate questions`、`Type your answer (optional)`、`Optionally, add details in notes (tab).`、`None of the above`、`Other (write an answer)`——**没有任何「勾选多个」的控件或用词**，候选项是互斥选择、外加一个自动补的 free-form「Other」，两者是**替代**关系而不是并列。真机读数印证：我们回的两题各只有一个元素（`{"answers":{"favorite_animal":{"answers":["兔"]},"favorite_plants":{"answers":["月季、杜鹃"]}}}`），模型据此把两者都读成**一段自由文本**。

⇒ 想让用户在同一题里同时给出「勾选的选项 + 自己写的一段」，只能由**本仓**约定成数组里的多个元素（适配器的拼法是 `[...selected, ...custom]`）：那是我们这一侧的约定，模型侧没有保证（它可以读成「同一题的多条回答」），厂商客户端也没有任何控件能产出这种帧。**本仓不靠它做多选**——codex 的 `multiSelect` 恒 `false`（厂商线上没有这一格，编个默认值会让族载荷与判据一起说谎），而单选的覆盖口径（自由输入 ⇒ 选项作废、值就是那一段文本）由宿主保证：真机两题都是 `selected: []` + `custom` 各一段，拼出来的数组恰好一个元素。

**配对键：厂商按 `id`、契约按 `header`**——适配器在两者之间做唯一一次映射（`codexAnswerFrameOf`：按题序取 `questions[i].id` 回帧、按 `header` 从答复里查那一题）；`id` 只活在厂商这一侧，`header` 才是契约的配对键。同一次提问里两题共用一个 `header` 时**整场不问人**（端口层的 `duplicateHeaderOf`）：那样一份答复在结构上说不清它答的是哪一题。

六条今天仍成立的边界：

- **开关管的不是「模型看不看得见那件工具」**：0.156.1 默认就把 `request_user_input` 列进工具表，两格开关都不改模型看到的工具表与系统提示；开关管的是**运行期收不收这次调用**——不开时调用被弹回，模型拿到的工具结果逐字是 `ERROR codex_core::tools::router: error=request_user_input is unavailable in Default mode`，一条服务端请求都不下发。
- **「管道 stdin 拦不拦」有答案了**：`request_user_input requires an interactive stdin terminal` 那句属于厂商**自带的参照客户端**，不是下发前的拦截——真路径驱动器里 fd 0 是管道时请求照样下发。
- **子线程发起的提问厂商自己就拒**（`… can only be used by the root thread`）；适配器另有一道自己的判据（比对 `threadId` 与主线程 id），命中时**直接回一帧 `unavailable`**、不进挂起表也不进账本。主线程 id 要等 `thread/start` 返回才落定——那一瞬间之前到达的请求在 `null` 上与「不是主线程」不可分，故按主线程处置并落一条点名 WARN。
- **审批类（`item/…/requestApproval`）仍只归类不回帧**：`approvalPolicy: never` 下厂商不会发，即便发来，回帧等于替用户批准。分界线是方法名，别放宽成「带 `id` 的都回」。
- **提问调用在厂商侧没有条目通知**：厂商只发一条 `serverRequest/resolved` 回执——它是「这一帧被收下了」，不是「厂商自己收场」，而线程条目（`ThreadItem`）的变体里没有提问这一格。⇒ 账本里那条 assistant `tool-call` 由适配器在请求到手时**补出**（`callId` 取厂商的 `itemId`，与编排层落的答复那一半同一个配对键；形状与另三家 wire 上那条逐字同形），不补的表现是执行日志里只剩一句没有题目的答复。
- **开关本身会带来一条厂商通知**：`features.default_mode_request_user_input` 打开时厂商多投一条 `warning`（正文 `Under-development features enabled: …`），而厂商用的是**同一条通道**投别的过路消息 ⇒ 一致性套件把它整条点名归一，两臂的**原始**指纹仍必须不同（相同说明这一格没有区分力）。

## skills 接法

codex **有原生 skills 机制**，落点是**文件**而不是配置键：把清单里的每条整目录复制进行配置目录的 `<configHome>/skills/<名称>/SKILL.md`，app-server 起来时自己扫。⚠️ 这面能力在 **CLI 与 app-server 协议**那一层，不在 SDK 封装层（SDK 的 `dist/index.d.ts` 里 `skill` 出现 0 次，静态看会以为这家没有 skills）。

- **发现根六个**（第一层扫描、不递归）：`$CODEX_HOME/skills`（scope `user`，源码注释 deprecated but kept）、`~/.agents/skills`（`user`）、`$CODEX_HOME/skills/.system`（`system`）、`<项目根>/.codex/skills`（`repo`）、项目根→cwd 每一层的 `.agents/skills`（`repo`）、`/etc/codex/skills`（`admin`）。**同名不去重**：两条都进清单。
- **时序：物化必须早于 spawn**（在 `hooks.createClient` 之前写完）。写完这一次会话就能看见，**不要赌 watch**——`skills/changed` 是空 params 的失效信号，本仓未捕获。
- **隔离要把 `HOME` 一起改**：`~/.agents/skills` 跟着 `HOME` 走，只改 `CODEX_HOME` 挡不住宿主家目录那一批（真机：宿主 27 条；行内 `HOME` ⇒ 一条都不在）。`HOME` / `USERPROFILE` / `CODEX_HOME` 三格全指行配置目录是本仓的 L2 前提。
- **内置那 6 条本仓不关**：`$CODEX_HOME/skills/.system` 在**每行首启时自动物化** 6 个内置 skill，而它与我们的条目**同住 `skills/` 这一层** ⇒ 物化函数**不删任何东西**、只按清单逐条覆盖（整目录清空会把内置静默抹掉）。要关只在线程级 `config` 里加 `skills: { bundled: { enabled: false } }`（实测生效，不必写 `config.toml`），本仓刻意不关：厂商能力面本就不同，压掉会让行为与默认分叉。
- **判据两条，强度差一档**：**结构化清单** = `skills/list`（本仓在 `startCodex` 的本地 `client` 上发 `{ cwds: [cwd] }`，不给会话开洞），每条带 `scope` 与落点 `path`——来源分档靠这两格；**行为确证** = 该 turn 入站 `/v1/responses` 的 developer 段里出现 `<skills_instructions>…### Available skills - name: desc (file: …)`，或模型在 `commandExecution` 里**真去读 `SKILL.md`**。
  - ⚠️ `path` 是**这家独有的落点证据**，而它报的是 app-server 自己看到的路径：与我们手里的行配置目录常常只是**同一个目录的两种写法**（macOS 上临时目录给软链形态 `/var/folders/…`、真实路径是 `/private/var/folders/…`）⇒ 判「在不在那个目录之下」之前两侧都要按真实路径归一，只比字符串会让这条更细的判据**整条失效**（表现是那两条显示成「来源未证实」，而它本该是「本机启用项」）。
- **这家没有 `Skill` 工具**（工具表 9 项里没有）⇒「模型会用技能」表现为**读文件 + 按文件里的规则作答**。⚠️「出现在 `skills/list` 里」是**弱判据**：`enabled: false` 的条目照样列出，本仓因此把这类条目**丢弃**——不在可用技能面里的条目算成「厂商认了」就是假绿。
- 技能**不走模型工具调用**，所以本文《MCP 接法》那条「看得见、调不动」的上游缺口**不适用于 skills**（读文件走 shell，而 shell 在这条网关下正常）。

## MCP 接法

- **落点 = 线程级 `config.mcp_servers`**（`buildCodexConfig` 的第 4 格，随 `thread/start` 经 app-server 协议传入，与本次运行的路由同格）。形状：snake_case、**无 `type`**（传输靠字段推断）、`command` / `args` / `env` 或 `url` / `http_headers`，另加 `startup_timeout_sec`（本仓给 30 s ≥ 20 s 的等待预算——行内首次注入 playwright MCP 要现下 61 MB）。
- **两条路都通**（同一 server / 同一模型两臂）：只给线程级 `config`、`$CODEX_HOME` 里**不写** `config.toml` ⇒ `starting → ready`；写 `$CODEX_HOME/config.toml` 的 `[mcp_servers.<name>]` 同样到 `ready`。**本仓取前者**（少写一份文件、少一处与 CLI 自身持久化层混在一起的落点，且与路由同一时刻同一进程读）。退路是后者，形状与本仓翻译器逐字相同（只是序列化成 TOML）——**退之前先复跑探针**。
- **判据**：`mcpServer/startupStatus/updated` 的 `failed` ⇒ 行失败（文案 `MCP「<name>」未能启动：<error 原文首行>`，归因码 `AGENT_MCP_UNAVAILABLE`）；`ready` ⇒ 行级观测格 `connected`（判据来源 `vendor-startup-status`，`mcpChannel: 'vendor-startup-status'`）。判据来源之所以是这家**唯一**的：codex 会为每台 server 投一条带 `error` 原文的结构化通知，比另两家的间接信号硬。
- ⚠️ **订阅必须建在 `thread/start` 之前**：这条通知落在 `thread/start` 与 `turn/start` 之间的窗口（真机 **+119 ms / +135 ms**），订阅若挂在 `turn/start` 之后 ⇒ 失败通知被**静默丢掉**、行照旧出分。判据是「首条 `mcpServer/startupStatus/updated` 的时间戳早于 `turn/start`」，夹具的投递语义也按真实客户端收紧。
- ⏳ **起轮次之前等注入的 MCP 落定**（`appserver/session.ts` 的 `settleMcpStartup()`）：MCP 工具要 server `ready` 之后才进 codex 的工具表，而工具表**随每条模型请求重算**——`thread/start` 一回来就 `turn/start`（两者相差毫秒）会让开局 1–2 轮的请求里没有 `mcp__<name>`，模型据此断言「当前会话没有暴露 MCP 工具」并整轮改用 shell。五条边界：等的是**注入的每一台**且只认终态（`ready` / `failed`，`starting` 不算）；上限 = 各台申报的 `startup_timeout_sec` 取最大 + 余量（`CODEX_MCP_STARTUP_WAIT`），等超了只记 WARN 并照常起轮次（**不改失败语义**）；app-server 在等待窗口里终止时立刻放行（不白等满预算，`turn/start` 照旧报进程已退出）；历史先扫一遍（`subscribe` 不补投历史）；没有注入就不订阅、不等待。判据：`appserver/session.test.ts` 的顺序守卫 + `live-mcp.test.ts` 的 C 臂（慢启动的 server 也要进**第一条**请求的工具表）。
- ⚠️ **能力缺口**：本机自定义 Responses 网关下 MCP 工具「看得见、调不动」（`unsupported call`，上游命名空间被拍平）——判定只到 `ready` 这一档，界面与文档都写明，**不当作本仓缺陷去修**。现象原文与三条出路见 [Codex FAQ](/faq/codex) 的 `unsupported call: probe_echo` 条；本仓面向用户的文案是契约的 `CODEX_MCP_DISPATCH_GAP_NOTE`。⇒ **行级结论的语义边界**：`connected` 对这家只等于「装上了」，不等于「调得动」。
- 行内首次注入 playwright MCP 的代价与缓解（17.2 s / 61 MB；registry 注入拉回 ~4 s 级）见[《MCP 配置》](/features/mcp-config)。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| 带 `outputSchema` 的一轮跑满 180s 无答复（`settle=timeout`；同题面对照组 94s；复跑 1.7s 正常） | 未定位 | 与结构化输出的因果关系未证实；下一步带 relay 复现（`probe/v4 only=schema timeoutMs=420000`），判据「有没有 `response.completed`」 |
| 消息级用量 | 结构性缺 | app-server 只到线程级 ⇒ `AgentMessage.usage` 恒 `null`，点名记录，不用近似值顶替 |
| 计划更新的 `explanation`（模型自己写的「为什么改计划」） | **未闭合**（协议面上有、我们没采） | `TurnPlanUpdatedNotification = { threadId, turnId, explanation: string \| null, plan[] }`（本机 `codex app-server generate-ts` 生成物逐字），而 `appserver/protocol.ts` 的窄声明只读 `plan[]` ⇒ `ToolCallPayload.note` 恒 `null`。补它要动 `protocol.ts` + `message.ts` + `message-conformance.test.ts` 的 `note` 断言，属**扩展采集面**，单独开口 |
| 命令入参里的 `justification`（模型写的审批理由） | 结构性缺 | `codex-rs` 的 `ExecCommandArgs.justification` 只服务于沙箱升级审批，而 `ThreadItem.commandExecution` 的字段里**没有它**（协议面就丢了）⇒ 本仓读不到，也不该拿审批语义当「这一步在干什么」 |
| 工具调用的「人话描述」 | 结构性缺 | codex 全家族**没有** `description` 这一格（`command_execution` 只有 `command`/`cwd` 一族；`apply_patch` 是 FREEFORM lark 语法，补丁正文不在协议条目里）。所以摘要只能走「族拼法」：`exec_command` 给命令原文、`apply_patch` 给改动清单，见《四家横向对比》 |
| 只回密文路由的推理明文 | 结构性缺 | `content[]` 为空 ⇒ `text: null` + `'none'`，不回落 summary |
| 审批类（`item/…/requestApproval`） | 结构性缺（对本仓而言） | 协议形态是 server→client 请求，而 `approvalPolicy: never` 下厂商**不会**发；即便发来，本仓也**只归类不回帧**（应答等于替用户批准）⇒ 不合成消息 |
| 问用户（`item/tool/requestUserInput`） | 已接（`askUser: yes` + `vendor-tool`） | 通道、递答案、选择模式与收场见《提问与应答面》一节；**这一家只有单选**（题目对象没有多选格 ⇒ 多选得拆成多次提问），分界线是**审批类仍只归类不回帧**，子线程发起的提问厂商自己就拒 |
| 轮次近似 | 取舍 | `Turn` ≠ 一次往返；与 `subagentTurns` 同一把尺，无答复条目时 `null` |
| 二进制解析「第二跳基准」守卫缺口 | 未闭合 | vitest 里裸说明符解析被运行器接管比生产宽松，基准改错仍绿；两条闭合路径（真 Node 子进程验 / 形状式源码断言）都未做，如实登记 |
| 平台包空壳（`@openai/codex-darwin-arm64` 只剩空壳 ⇒ `Cannot find module '@openai/codex-darwin-arm64/package.json'`） | 环境坏 | pnpm 的「已安装」真源是 `node_modules/.pnpm/lock.yaml`，不校验盘上文件——`--frozen-lockfile` / 重装 / `--force` 全部无效；修法：取镜像 tarball 校验 `shasum` 后手工物化到 `.pnpm` 位置（保住 `0755`）；判据：真 Node 两跳解析通过、`codex --version` ⇒ `codex-cli 0.156.1`；清空 `node_modules` 重装会重踩 |
| 插件 startup sync（`thread/start` 时同步 curated 插件目录，spawn `git` 孙进程链） | 未闭合 | 线程级 `config` 管不到它（`features.plugins=false` 只有盘上 `config.toml` 或 `-c` 生效）；处置是 `close()` 异步杀整棵树并等 exit；真机守卫 `AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts` |
| skills：core 加载器的 frontmatter 精确允许集、同名 skill 的模型侧选择、spawn 后落盘能否被同 turn 看到、`SKILL.json` 用法 | 未证实 | 本仓只依赖「`<configHome>/skills/<名称>/SKILL.md` + spawn 前写完」这两条已实测的前提；其余按未证实处置，不写死 |
| skills：按 `name` 禁用会被 `path` 条目压制（推测）、`skills/extraRoots/set` 未测、`skills/changed` 通知未捕获 | 未闭合 | 本仓不用这三个通道（停用走文件级不放）；要用先跑探针 |
| skills：真实家目录里的**插件**技能未在真实会话验证 | 未覆盖 | 行内 `HOME` 隔离已经实测挡住宿主家目录那一批；插件来源那一档仍按未证实登记 |
| `thread/list` 用量粒度是否到每个模型往返 | 无样本 | 文章不写死 |
| 退出码 | 结构性缺 | `app-server` 在 `turn/completed` 后不自退，kill 后退出码恒 `null`（4/4）⇒ 退出码不得当本轮成败判据，只认 `turn/completed.status` + `error` |

**终结闸门按 `threadId` 认本轮**：主线程与每个子线程各有自己的 turn，`turn/completed` 多条、`threadId` 各异——子线程先到不能当本轮终结（踩过的坑：拿到的是子线程结束时刻的快照）。收尾取数（`thread/list` + 逐线程 `thread/read`，`itemsView` 从 `summary` 到 `full` 有降级判据）必须在 `finalize` 之前落定。收尾读回与通知同源：读回的 reasoning 条目与 `item/completed` 逐字相同（4/4）。

## 相关链接

- 活文档：[Codex FAQ](/faq/codex)——加载与凭据、网关与 wire、评分通路、计量与思考、进程与收尾五组现象条目，拿报错原文一搜即命中
- 仓库内参考：`packages/server/agents/README.md`——§4.4 能力查询的唯一入口、§5 各家差异（注入落点 / 停止与释放 / 事件流 / 轮次与计量）、§8.1 新增 SDK 接入清单
- 知识文章：[《DeepSeek Harness 接入》](/protocols/dsh)、[《Claude Code 接入》](/protocols/cc)、[《四家横向对比》](/protocols/comparison)、[《技能配置》](/features/skills-config)（四家 skills 的配置面与行级判据）、[《评分》](/features/judging)（outputSchema 的评分侧全链）、[《行执行与日志》](/features/row-execution)（用量与轮次展示口径）、[《密钥与环境变量》](/guard/secrets-and-env)（`env_key` 与子进程环境凭据规则）
- 外部资料：[openai/codex discussions#7782](https://github.com/openai/codex/discussions/7782)（chat wire 移除）、[process.getBuiltinModule](https://nodejs.org/api/process.html#processgetbuiltinmodulemoduleid)（跨打包器取真 `createRequire`）
