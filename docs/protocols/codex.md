# Codex 接入

## 定位

Codex 的适配器完全由 `codex app-server` 驱动与取数（JSON-RPC over stdio），厂商包是 `@openai/codex`（纯 JS 启动器，原生二进制在平台包 `@openai/codex-<platform>-<arch>` 的 `vendor/<triple>/bin/codex(.exe)`）。协议能力面与 DSH 逐格对齐且不降级，`cancelMidTurn` / **原生结构化输出通道** / 子任务父链与昵称深度 / `reasoningOutput` / 用量合计是 Codex 更强的格子。能力声明：`protocolTypes: ['openai']`，`cancelMidTurn` / `usage` 两格全 `true`；结构化输出不是能力位——`turn/start` 的 `outputSchema` 是原生通道，本次有没有真的走成由适配器在收尾上报（`applied.structuredOutput`）。

## 形态与交互

- **进程与帧**：TS 侧没有官方 app-server 客户端，适配器自建客户端——stdio 传输、**行分隔 JSON 帧**，只做 spawn / 握手 / 请求响应配对 / 收通知；坏帧计数不静默（`unparsedFrames()` 可查）。
- **一次运行一个 app-server 进程**：收尾取数复用同一客户端——线程树是该进程的内存态，进程没了树就没了。
- **握手顺序固定**：`initialize`（带 `experimentalApi`）→ `thread/start`（返回 `threadId`）→ `turn/start`（返回 `turnId`）。
- **URL 规则**：base 必须补 `/v1`（`ensureV1Suffix` 不能省）——CLI 在 base_url 后直接拼 `/responses`，故本仓统一打 `POST {base}/v1/responses`。
- **wire 只能钉 Responses**：`wire_api` 只接受 `responses`（**也不区分大小写地只认这一个**：`RESPONSES` 同样被拒；**缺省不给这一格则被接受**，等价于 Responses —— 真机逐值读数：`responses` ✅、缺省 ✅、`chat` / `chat_completions` / `completions` / `anthropic` / `messages` / 伪值 / 大写 ❌）；`chat` 及别名（`chat_completions` / `openai-chat` / `completions`）全被拒，`thread/start` 响应 `-32600`，报错原文：
  ```text
  failed to load configuration: `wire_api = "chat"` is no longer supported.
  How to fix: set `wire_api = "responses"` in your provider config.
  More info: https://github.com/openai/codex/discussions/7782
  ```
  根因不是配置写法：codex 客户端已删除 chat 实现（实测 0.156.1 二进制里 `chat/completions` / `v1/chat` / `use_chat_completions` 零命中；0.160.1 的 `WireApi` 枚举只剩 `Responses`），升级也换不回来。
- **注入落点**：线程级 `config` 由 `buildCodexConfig` 构造——`model_provider: 'aieval'` + `model_providers.aieval{ name, base_url, wire_api: 'responses', env_key: 'OPENAI_API_KEY', request_max_retries }}` + **顶层 `web_search: 'disabled'`** + `tools: { update_plan: { enabled: true } }` + `features: { multi_agent: true }`；`model_context_window` / `model_reasoning_summary` 只在已知时出现；设置页的**自定义请求头**写 `model_providers.aieval.http_headers`（字面值，空集时整个键不出现）——不用 `env_http_headers`：那是「头名 → 环境变量名」的间接表，会多一处密钥落点。⚠️ **内置联网工具的开关只在顶层**：`tools.web_search` 是 web search 的**参数容器**（filters / user_location / context size），给不给它出站请求体的工具表**逐字相同**（`type: "web_search"` 一直在），`web_search: 'disabled'` 才让它消失；默认值是 `Cached`（不给就等于开着）——判据是**厂商出站请求体**的工具表（`turn-injection-delivery.test.ts` 的真机守卫）。**模型请求重试次数**（设置页「基础」→「模型调用重试」）落 `request_max_retries`（**数字**，不是字符串）：设置给了就取那个值，没给保留 1；语义是「失败后再试几次」（不含首次），与本仓设置项 1:1。
- **权限档按平台选**：Windows 上只有 `danger-full-access` 能真正起子进程（`read-only` 与 `workspace-write` 下连 `echo` / `git status` 都被拒，stderr 原文 `Rejected(\"… rejected: blocked by policy\")`）；macOS（seatbelt）与 Linux（landlock）不动。**只读档拦写入是量得到的**：`apply_patch` 回的是 `patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings` —— **点名了依据**（它由厂商进程自己执行、只查策略）；而 `exec_command` 要派生沙箱子进程，外围已有沙箱时贴 profile 就会失败（详见下面那条 ⚠️）。⚠️ **但「档位起不来」在 macOS 上还有第二种签名，别读成「只读拦住了写」**：当**外层已经处在一个沙箱里**时，厂商贴 seatbelt profile 这一步就会失败，命令根本不执行、stderr 是 `sandbox-exec: sandbox_apply: Operation not permitted`（exit 71）。这与 Windows 那条 `blocked by policy` **成因不同**：后者是策略拒了命令，前者是 **profile 压根没贴上**。而且**这是本家的问题、不是环境的普遍限制** —— 同一个环境、同一类档位、同样是派生子进程去写文件，claude 的 `Bash` / `Write` 正常拦、正常放 ⇒ 要归因给「外层沙箱」之前先做一次跨家对照。判别办法：同时跑一档 `workspace-write`（它本该允许写 cwd 内文件）——若它也写不出来，就是环境成因、**本次读数对「权限策略管不管用」零证据力**。（请求侧 `sandbox` 是字符串 `'read-only'`，而响应侧 `environments[].sandbox` 回的是带类型标签的对象 `{"type":"readOnly"}`——两侧形状不同，本仓只发不读。）兜底：编排层「评分前后 diff 摘要对照」从 WARN 升级为候选失败。
- **停止与释放顺序固定**：`interrupt()`（发 `turn/interrupt`，是协议能力、不 kill 进程）→ 等在途 turn 终结（最多 5 秒）→ `dispose()`（`session.close()`：**杀整棵进程树并等 exit** + 删临时目录；Windows `taskkill /T /F`，POSIX 进程组 `SIGKILL`）。被终止的那一轮不等收尾取数；起手三步失败也要回收（`close()` 杀树失败退回直接 kill，等不到就如实回 `exited: false` 由调用方 WARN）。两条与「带哪一轮」有关的硬口径：**`turn/interrupt` 必须带当前在途轮**（厂商按在途轮校验；在途轮号由**流那一侧**维护，轮与轮之间没有在途轮时**不发这一帧**）。⚠️ 「发错轮号」在厂商那一侧有**三种**互不相同的下场：**自然收场**的轮 ⇒ `-32600 no active turn to interrupt`（1 ms 回错帧）；**被我们中断过**的轮再发一次 ⇒ **一帧都不回**（客户端白等一个超时）；**空闲线程 + 伪造 id** ⇒ `-32600 expected active turn id X but found Y`（把**当前在途轮号**写在报错里，1 ms）。适配器那两条保护因此都是必需的：没在途轮就不发（`session.interrupt(null)`），以及一轮只发一次（骨架的 `triggerRelease` 记忆化 ⇒ 第二种形状在本仓不可达）；**进程死在在途 ⇒ 这个候选按失败结算**——通知流里没有任何终态，失败事实只在会话的终态结算上，故流量正常产完时补一条 `sessionFailed` 载荷交给同一个投影出口（否则会按 `ok: true` 落盘）。

## 数据与契约

协议条目到本仓契约的映射（`turns` 是近似值——一条 Turn 内含多次模型往返）：

| app-server 协议条目 | 契约投影 |
|---|---|
| `item/agentMessage/delta` | `textBlockDraft(text, 'delta')`，`streamingDelta` 标 `yes`/`wire` |
| `item/completed(reasoning).content[]` | `thinking{ textKind: 'full' }`；`content` 空 ⇒ **全文那块**不产（`text: null` + `'none'`），而 `summary[]` 非空时**另产一块** `textKind: 'summary'`（那时没有 `none` 块）。「不回落 summary」指不把摘要写进全文那块，不是不产块 |
| `reasoning.summary[]` | `thinking{ textKind: 'summary' }` |
| `commandExecution` | 工具调用 + 结果块（命令 / 输出 / 退出码 / 耗时） |
| `fileChange` | `toolCallBlockDraft('apply_patch', …)` + `structured = { changes, status }`；`changes[].kind` 取厂商 `PatchChangeKind` 的**标签本身**（`add` / `delete` / `update`）——线上它是带标签的对象 `{"type":"add"}`，照字符串读会恒得 `null` |
| `mcpToolCall` | `name = '<server>.<tool>'`、`family: null`、`isError = error != null` |
| `plan` / `turn/plan/updated` | `family: 'task'` + `payload: { kind: 'plan', steps, note }` |
| `collabAgentToolCall` / `subAgentActivity` | 子任务行（身份 / 派发配对 / 终态三档） |
| `imageView` | `image-view` 块（`path` 原样）；拿不到非空路径 ⇒ `unrecognized{reason:'unmapped-shape'}`，原文照留 |
| `turn/completed` | 用量 + 时长（`timing{ source: 'events' }`，`apiMs` / `ttftMs` 恒 `null`） |
| `thread/tokenUsage/updated` | 按线程用量累计（`input − cached`） |
| `mcpServer/startupStatus/updated` | `vendor-system` 事件（`mcpChannel: 'vendor-startup-status'`，每台 `starting` / `ready` / `failed` + `error` 原文；每条交**累积之后的全量**） |

- **未归一的条目类型有一条兜底出口**：`ThreadItem` 19 个变体里声明消费 13 个（`imageView` 走 `image-view` 块），其余（`hookPrompt` / `sleep` / `imageGeneration` / `enteredReviewMode` / `exitedReviewMode` / `contextCompaction`）与**未来新增的类型**都归 `unrecognized` 块（`vendorType` = 厂商 `type` 原文、`raw` = 条目原文），只在 `item/completed` 产。⇒「厂商没发」与「厂商发了、我们没接」不再同形。
- **`finalText` 出口四条件缺一不可**：`itemCompleted`（`item/started` 正文可能半截）、`agentMessage`、主线程（子线程结论不顶主会话）、正文非空。评分通路只读 `finalText`，不从事件流重建——app-server 重构曾漏写这一格，表象是 `JUDGE_PARSE_FAILED：评分智能体没有给出可读的最终答复（该适配器未回传最终消息）`（会话 `ok=true`、上游也回了 JSON，只有本仓交不出答复）。
- **思考块规则**：`item/started` 的空占位不产块；`reasoningDrafts` 无条件补快照封口（同内容重发幂等覆盖）；界面层对无正文的思考块整块隐藏，不给占位文案。
- **读取契约**：只声明消费得到的字段，读不到就是 `null`——不做默认值填充、不用空串或 0 冒充「没采到」。
- **用量口径**：只从运行期 `thread/tokenUsage/updated` 通知累计（协议没有「按线程读用量」的请求，`thread/read` 不返回用量）。⚠️ **厂商那一份是「按线程」的、不是全树**：每条通知里的 `totalTokens` 只累计**那一条线程**自己那几趟往返（真机读数：主线程停在 51371，两条子线程各自 14930 / 15106，主线程那一格**不含**子线程）——「全树合计」是**我们**算的（主线程 + 逐个子线程），不是厂商给的。⇒ **行的合计**（`tokens`）= 主线程那一份 + 各子线程那一份；任一子线程拿不到用量 ⇒ `subagentTokens` / `subagentTurns` 两分量同时 `null` 并落点名 WARN。契约的 `UsageTokens.total` 是「厂商自报的快照」语义，两个会话的快照相加得到的是我们的算术 ⇒ 有子智能体分量时它记 `null`（见 `packages/server/agents/src/usage.ts`）。三条硬口径：采不到就是 `null` 绝不填 0；估算值不进结果；`turns` 与 `tokens` 互不兜底。
- **步数口径**：数**模型往返**（一次模型请求与它的产出算一次），按线程分别开号、收尾相加。判据是**响应身份**——模型产出条目（`reasoning` / `agentMessage`）的 id 后缀就是厂商的响应 id，同一次响应的推理与答复共享它（`rs_<响应 id>` / `msg_<响应 id>`，真机三种 id 格式都如此）；条目 id 里没有分隔符时退回结构判据（上一次产出之后跑过工具才算新的一次）。⚠️ **不能数答复条目**：一次往返里只有收尾那次会发 `agentMessage`，中间那些「想 + 调工具」的往返一条答复都没有 ⇒ 整个 turn 共用一个号，而合并键里只有 `roundTrip` 能区分同角色的消息，于是整轮被折叠成一条。一次产出都没有时 `null` 不编 0。

## wire 形态与事件

本仓消费的通知通道全集（未识别方法归 `other` 不抛错）。

⚠️ **「未识别」那一支不是边角**：真机台账（多轮臂的逐帧 `.jsonl` 合并直方图）里出现过 **26 种方法**，
其中 **11 种落 `other`** ——`thread/status/changed` 364 次之外，`account/rateLimits/updated` 228、
`warning` 188、`thread/readState/changed` 89、`remoteControl/status/changed` 60、**`thread/goal/updated` 60**、
`serverRequest/resolved` 16、`thread/queue/changed` 13、`deprecationNotice` 7、
`item/reasoning/summaryPartAdded` 5、**`turn/diff/updated` 3**、`thread/goal/cleared` 1。
兜底支**原样带上 `params`**（不是只留方法名），所以这些都在候选级产物里留了痕；但**没有一类有消费方**——
今天它们只出现在原始输出面板与排障里。

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
- ⚠️ **推理那两条通道在 0.163.0 上「哪一条会亮」是有前提的，别把下面那组读数读成「恒有」**：
  真机跑过两档路由（内网网关 `jd/deepseek-v4-flash-0731` 与脚本式上游喂 `reasoning` 输出条目），
  **没给 `effort` 那一档**整轮 **`item/*` 里一条 `reasoning` 都没有**（同一轮 `agentMessage` /
  `commandExecution` / `collabAgentToolCall` 都有），`item/reasoning/textDelta` 与 `summaryTextDelta`
  同样 0 条。⚠️ **但这不是「这条路由不给推理」**——同一条路由**给了档位**就有：

  | 给的 `effort` | 出站 `reasoning.effort` | 真机产出的推理条目数 |
  |---|---|---|
  | `medium` | `medium` | **1** |
  | `ultra` | `medium`（被降档） | **1** |
  | `persistent` | `disabled` | **0** |

  ⇒ 判据里必须带 **`effort` 这个自变量**；本节开头那句「哪一条会亮是有前提的」里的「前提」正是它
  （叠加「上游只回密文时正文结构性拿不到」那条边界）。⇒ `message.ts` 的 `reasoningDrafts`
  （`item/completed` 的快照封口）**在今天的路由上不亮**，它是**按协议写好、等上游给明文时才生效**的
  那一支；下面那组「快照/增量相等」的读数因此是**特定路由**下的读数，不是这家恒定行为。
- **推理正文（reasoning）现口径**：`codex exec --json` 里 `item.type === 'reasoning'` 恒 0 条（exec 的 JSONL 投影只取 `summary` 丢弃 `content`）——**取思考内容一律走 app-server**。快照取 `item/completed` 的 `reasoning.content[]`（`item/started` 那帧两格都是空数组，别在 started 取值）。⚠️ **全文（`content[]` 非空）的前提是「上游把推理全文发出来」**：脚本式上游逐形状对照（9 种写法）显示 —— 上游给 `reasoning_text`（无论有没有同时给 `summary_text`、无论写成字符串还是 `{type:'text'}` 块），厂商就把它落在 `content[]` 里；**不给就恒空**。而本仓常用网关（内网两条路由 × 2 个模型、10 次往返）都不发全文 ⇒ 那一格恒 `[]`。⇒ 按「**能力上取得到、本仓常用路由给不到**」读，别把「有全文」当默认；
  **外部一手资料支持这个取向**：官方 OpenAPI 规格的 `IncludeEnum` 里**没有一项**是「要明文推理正文」——最接近的 `reasoning.encrypted_content` 给的是**加密版**（原文 *Includes an encrypted version of reasoning tokens in reasoning item outputs*）。⇒ 协议上没有一个开关能让客户端**索要**明文，能不能拿到取决于上游是否**主动**回。所以这一格报 `summary`（描述实测拿得到哪一档）而不是 `full`（描述协议上有没有那条路）。增量 `item/reasoning/textDelta` 逐字拼接后与 `content[0]` 完全相等（记过一次 4/4，39 / 54 / 49 / 72 条，条数恰等于 `reasoningOutputTokens`，1 delta ≈ 1 token）——**它和全文是同一条路**：常用路由上 `textDelta` 一次未到，到的是 **`summaryTextDelta`**（走摘要那一块，不是全文那一块）。**摘要是这条路上实际拿得到的那一档**（`item/reasoning/summaryTextDelta` 确实会到，上面那张读数表里 `summary[]` 非空的 7 次就是这么来的），`model_reasoning_summary` 不设或写 `auto`；`effort === 'off'` 时注入的 `CODEX_OFF_REASONING_SUMMARY = 'none'` 真机上既不报错也不影响推理照常产出（空转格，别指望它关掉任何东西）。
- **线程树**：`thread/list{ ancestorThreadId }` 一次返回任意深度的全部后代（分页 `limit` 100、`nextCursor` 续读；不含主线程自身）；深度与昵称取厂商声明 `source.subagent.thread_spawn`（`{ depth, agent_path, agent_nickname }`），不按链长推算——旧 SDK 时代的深度 8 / 广度 32 上限不复存在。子智能体工具是 `collabAgentToolCall`（`spawnAgent` / `wait` / `closeAgent`），`wait` 的 `agentsStates[<childId>].message` 直接是子智能体结论原文。

## 部署约束（生产产物里的可执行文件解析）

`AGENT_LOAD_FAILED` 里那套「两条基准逐个试」的解析，在生产产物下的**第一跳基准是构建期的 `import.meta.url`** ——
而打包器把它定死成**构建机仓根的源码绝对路径**（该模块被内联进 server chunk），**不是产物内的文件**。
⇒ 产物必须与源码树**同机、同路径**地跑，否则第一跳恒失败、只剩 `process.cwd()` 那一跳（它要求 cwd 落在
`apps/web-next` 或 `packages/server/agents` 之下）。

**两条判据**：

- 部署形态换成「只发 `.next` + app 的 `node_modules`」时，必须**显式把仓根放到构建时的那个路径**，
  或改成从 `apps/web-next` 启动（让 `process.cwd()` 那一跳成立）；
- **本地/CI 上「跑得通」证明不了这一格**：开发机与构建机同路径，第一跳永远命中源码树。
  要验这一格得换一个 cwd、或把源码树挪走（真机读数：`.bin/vitest` 形态下假绿、裸 node 下才红）。

**为什么不在代码里兜**：两条免疫（`process.getBuiltinModule` / 结果形态校验）防的是「打包器换掉
`createRequire`」，而当前默认的 Turbopack 生产构建**并不这样**（`node:module` 就是真模块）——
它们是保险，不是这条约束的解药。改基准要产品决策，今天按**部署约束**登记。

## 提问与应答面

厂商在服务端协议里就有提问请求（`item/tool/requestUserInput`，**server→client 请求**），本仓声明 `askUser: yes` + `askUserChannel: 'vendor-tool'`，一致性场景走**真路径**（真 `codex app-server` + 本机假上游，只把上游模型脚本化）。

| 面 | 现时做法 |
|---|---|
| 通道 | 线程级配置里那两格提问开关（`tools.experimental_request_user_input` 与 `features.default_mode_request_user_input`）随应答面同生同灭；请求到了由适配器装帧回帧 |
| 递答案 | 答案**按题目 id** 配对：`{answers: {<question.id>: {answers: string[]}}}`——不是按序号、也不是按标题 |
| 等待预算 | 没有这一档：`autoResolutionMs` 已 `@deprecated` 且实测恒 `null`，`isBlocking: false` 也不让它收场（不回帧它会一直等） |
| 收场 | 「没人答 / 等超时 / 候选终止」三条都由我们回一帧**空表** `{answers: {}}`——那是厂商原生的「没有答案」语义，模型据此继续按最佳判断干活；收场方式按这一问的实际结果落 `answered` / `timeout` / `canceled`，**没有** `auto-resolved` 这条路径 |

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
- **「管道 stdin 拦不拦」有答案了**：`request_user_input requires an interactive stdin terminal` 那句属于厂商**自带的参照客户端**（它收到请求且自己的 fd 0 不是 TTY 时直接 `bail!`），**不是下发前的拦截**——`codex app-server` 本身**零 TTY 门禁**（`app-server/src` 里没有任何终端判定）⇒ 管道拉起合法：真路径驱动器里 fd 0 是管道时 `initialize` 照常成功返回（`userAgent` 里带 `dumb`，= 非 TTY），`request_user_input` 的调用照常下发。⚠️ 因此「问用户恒空」**不归因于交互式终端**——那是另一回事（开关管的是运行期收不收这次调用，见上一条）。
- **子线程发起的提问厂商自己就拒**（`… can only be used by the root thread`）；适配器另有一道自己的判据（比对 `threadId` 与主线程 id），命中时**直接回一帧 `unavailable`**、不进挂起表也不进账本。主线程 id 要等 `thread/start` 返回才落定——那一瞬间之前到达的请求在 `null` 上与「不是主线程」不可分，故按主线程处置并落一条点名 WARN。
- **审批类（`item/…/requestApproval`）仍只归类不回帧**：`approvalPolicy: never` 下厂商不会发，即便发来，回帧等于替用户批准。分界线是方法名，别放宽成「带 `id` 的都回」。
- **提问调用在厂商侧没有条目通知**：厂商只发一条 `serverRequest/resolved` 回执——它是「这一帧被收下了」，不是「厂商自己收场」，而线程条目（`ThreadItem`）的变体里没有提问这一格。⇒ 账本里那条 assistant `tool-call` 由适配器在请求到手时**补出**（`callId` 取厂商的 `itemId`，与编排层落的答复那一半同一个配对键；形状与另三家 wire 上那条逐字同形），不补的表现是执行日志里只剩一句没有题目的答复。
- **开关本身会带来一条厂商通知**：`features.default_mode_request_user_input` 打开时厂商多投一条 `warning`（正文 `Under-development features enabled: …`），而厂商用的是**同一条通道**投别的过路消息 ⇒ 一致性套件把它整条点名归一，两臂的**原始**指纹仍必须不同（相同说明这一格没有区分力）。

## skills 接法

codex **有原生 skills 机制**，落点是**文件**而不是配置键：把清单里的每条整目录复制进行配置目录的 `<configHome>/skills/<名称>/SKILL.md`，app-server 起来时自己扫。⚠️ 这面能力在 **CLI 与 app-server 协议**那一层，不在 SDK 封装层（SDK 的 `dist/index.d.ts` 里 `skill` 出现 0 次，静态看会以为这家没有 skills）。

- **发现根六个**（第一层扫描、不递归）：`$CODEX_HOME/skills`（scope `user`，源码注释 deprecated but kept）、`~/.agents/skills`（`user`）、`$CODEX_HOME/skills/.system`（`system`）、`<项目根>/.codex/skills`（`repo`）、项目根→cwd 每一层的 `.agents/skills`（`repo`）、`/etc/codex/skills`（`admin`）。**同名不去重**：两条都进清单。
- **时序：物化必须早于 spawn**（在 `hooks.createClient` 之前写完）。写完这一次会话就能看见，**不要赌 watch**——`skills/changed` 是空 params 的失效信号，本仓未捕获。
- **隔离要把 `HOME` 一起改**：`~/.agents/skills` 跟着 `HOME` 走，只改 `CODEX_HOME` 挡不住宿主家目录那一批（真机：宿主 27 条；候选内 `HOME` ⇒ 一条都不在）。`HOME` / `USERPROFILE` / `CODEX_HOME` 三格全指候选配置目录是本仓的 L2 前提。
- **内置那 6 条本仓不关**：`$CODEX_HOME/skills/.system` 在**每个候选首启时自动物化** 6 个内置 skill，而它与我们的条目**同住 `skills/` 这一层** ⇒ 物化函数**不删任何东西**、只按清单逐条覆盖（整目录清空会把内置静默抹掉）。要关只在线程级 `config` 里加 `skills: { bundled: { enabled: false } }`（实测生效，不必写 `config.toml`），本仓刻意不关：厂商能力面本就不同，压掉会让行为与默认分叉。
- **判据两条，强度差一档**：**结构化清单** = `skills/list`（本仓在 `startCodex` 的本地 `client` 上发 `{ cwds: [cwd] }`，不给会话开洞），每条带 `scope` 与落点 `path`——来源分档靠这两格；**行为确证** = 该 turn 入站 `/v1/responses` 的 developer 段里出现 `<skills_instructions>…### Available skills - name: desc (file: …)`，或模型在 `commandExecution` 里**真去读 `SKILL.md`**。
  - ⚠️ `path` 是**这家独有的落点证据**，而它报的是 app-server 自己看到的路径：与我们手里的候选配置目录常常只是**同一个目录的两种写法**（macOS 上临时目录给软链形态 `/var/folders/…`、真实路径是 `/private/var/folders/…`）⇒ 判「在不在那个目录之下」之前两侧都要按真实路径归一，只比字符串会让这条更细的判据**整条失效**（表现是那两条显示成「来源未证实」，而它本该是「本机启用项」）。
- **这家没有 `Skill` 工具**（工具表 9 项里没有）⇒「模型会用技能」表现为**读文件 + 按文件里的规则作答**。⚠️「出现在 `skills/list` 里」是**弱判据**：`enabled: false` 的条目照样列出，本仓因此把这类条目**丢弃**——不在可用技能面里的条目算成「厂商认了」就是假绿。
- 技能**不走模型工具调用**，所以本文《MCP 接法》那条「看得见、调不动」的上游缺口**不适用于 skills**（读文件走 shell，而 shell 在这条网关下正常）。

## MCP 接法

- **落点 = 线程级 `config.mcp_servers`**（`buildCodexConfig` 的第 4 格，随 `thread/start` 经 app-server 协议传入，与本次运行的路由同格）。形状：snake_case、**无 `type`**（传输靠字段推断）、`command` / `args` / `env` 或 `url` / `http_headers`，另加 `startup_timeout_sec`（本仓给 30 s ≥ 20 s 的等待预算——候选内首次注入 playwright MCP 要现下 61 MB）。
- **两条路都通**（同一 server / 同一模型两臂）：只给线程级 `config`、`$CODEX_HOME` 里**不写** `config.toml` ⇒ `starting → ready`；写 `$CODEX_HOME/config.toml` 的 `[mcp_servers.<name>]` 同样到 `ready`。**本仓取前者**（少写一份文件、少一处与 CLI 自身持久化层混在一起的落点，且与路由同一时刻同一进程读）。退路是后者，形状与本仓翻译器逐字相同（只是序列化成 TOML）——**退之前先复跑探针**。
- **判据**：`mcpServer/startupStatus/updated` 的 `failed` ⇒ 候选失败（文案 `MCP「<name>」未能启动：<error 原文首行>`，归因码 `AGENT_MCP_UNAVAILABLE`）；`ready` ⇒ 候选级观测格 `connected`（判据来源 `vendor-startup-status`，`mcpChannel: 'vendor-startup-status'`）。判据来源之所以是这家**唯一**的：codex 会为每台 server 投一条带 `error` 原文的结构化通知，比另两家的间接信号硬。
- ⚠️ **订阅必须建在 `thread/start` 之前**：这条通知落在 `thread/start` 与 `turn/start` 之间的窗口（真机 **+119 ms / +135 ms**），订阅若挂在 `turn/start` 之后 ⇒ 失败通知被**静默丢掉**、行照旧出分。判据是「首条 `mcpServer/startupStatus/updated` 的时间戳早于 `turn/start`」，夹具的投递语义也按真实客户端收紧。
- ⏳ **起轮之前等注入的 MCP 落定**（`appserver/session.ts` 的 `settleMcpStartup()`）：MCP 工具要 server `ready` 之后才进 codex 的工具表，而工具表**随每条模型请求重算**——`thread/start` 一回来就 `turn/start`（两者相差毫秒）会让开局 1–2 轮的请求里没有 `mcp__<name>`，模型据此断言「当前会话没有暴露 MCP 工具」并整轮改用 shell。五条边界：等的是**注入的每一台**且只认终态（`ready` / `failed`，`starting` 不算）；上限 = 各台申报的 `startup_timeout_sec` 取最大 + 余量（`CODEX_MCP_STARTUP_WAIT`），等超了只记 WARN 并照常起轮（**不改失败语义**）；app-server 在等待窗口里终止时立刻放行（不白等满预算，`turn/start` 照旧报进程已退出）；历史先扫一遍（`subscribe` 不补投历史）；没有注入就不订阅、不等待。判据：`appserver/session.test.ts` 的顺序守卫 + `live-mcp.test.ts` 的 C 臂（慢启动的 server 也要进**第一条**请求的工具表）。
- ⚠️ **能力缺口**：本机自定义 Responses 网关下 MCP 工具「看得见、调不动」（`unsupported call`，上游命名空间被拍平）——判定只到 `ready` 这一档，界面与文档都写明，**不当作本仓缺陷去修**。现象原文与三条出路见 [Codex FAQ](/faq/codex) 的 `unsupported call: probe_echo` 条；本仓面向用户的文案是契约的 `CODEX_MCP_DISPATCH_GAP_NOTE`。⇒ **候选级结论的语义边界**：`connected` 对这家只等于「装上了」，不等于「调得动」。
- 候选内首次注入 playwright MCP 的代价与缓解（17.2 s / 61 MB；registry 注入拉回 ~4 s 级）见[《MCP 配置》](/features/mcp-config)。

## 注入与续接

「人往运行中的这一轮送话」与「接着一条已有会话再跑一段」是契约的两格（`AgentRunInput.inject` / `resume`），在这一家的落点如下。

| 面 | 现时做法 |
|---|---|
| `'round'`（立即发送） | **`turn/steer`**：消息插进**当前在途那一轮**，由厂商在下一次模型往返之前落点。它**不发新的 `turn/started`** ⇒ 适配器不必替它找边界（直接发，厂商替我们等） |
| `'idle'`（排队） | **`thread/queue/add`** 登记进厂商线程自己的**耐久队列**（拿到提交 id，保住按身份撤）→ 再 **`thread/queue/start`** 起轮。交付判据是「**这一轮真的跑起来了**」：条目录在**空闲**线程上时厂商在 `add` 那一刻就自己把它撒成新一轮，`queue/start` 随即回 `queue is empty`——那**不是失败**，按「条目已不在可见队列里」判交付，并让流继续消费厂商起的那一轮（在途轮号由 `turn/started` 补；等不到就按 `CODEX_VENDOR_TURN_WAIT` 有界收场）。⚠️ **一批要逐条判，不能整体处置**：一次 `drain('idle')` 交出 ≥2 条时，第 1 条 `add` 就把线程占住 ⇒ 第 2 条只入队、`queue/start` 被拒（`thread already has an active or pending turn`）——而它**不是失败**：厂商会在当前轮收场后自己把它撒出去（真机读数：什么都不做也照样跑完）。处置是记住它、下一拍与 `thread/queue/list` 对账，被取走那一刻才登记交付，并让这个候选继续跑（`vendorDispatched`）；只有**一条都没被消费**时才按真失败处置（回滚 + 不登记） |
| 版本门 | `turn/steer` 的 **`expectedTurnId` 是必填的「当前在途轮」**（自 0.156.1 起；本机那一版的生成物里它在 `required` 里） |
| 撤回 | `'idle'` 按厂商的 `queuedSubmissionId` 撤（`thread/queue/delete`）；**`'round'` 没有按身份收回的面**——`turn/interrupt` 是无身份的全清（它终结整轮，不是撤回这一条） |
| 续接 | **`thread/resume{ threadId }`**：必填入参只有 `threadId` 一格（与 cwd 无关，cwd 只是可选覆盖），转录落在该候选自己的 `$CODEX_HOME` 下 |

四条今天仍成立的边界：

- **续接接不回**上一个进程**那一轮**：它早已收场，拿它的 turn id 去 steer 会被厂商拒（`-32600 no active turn to steer`）⇒ `'round'` 的有效范围只有**本进程内、`turn/start` 已起、未收场**的那一轮。⚠️ 但续接本身**不等于**只能走 `'idle'`：`thread/resume` 之后适配器照旧发一次 `turn/start`，那一轮同样有在途轮 ⇒ `'round'` 照样可用（`injection.test.ts` 正面钉住）。
- **受理之后才算交付**：`turn/steer` / `thread/queue/add` 返回成功才算交出去；被拒的那一条退回手上、由 `'idle'` 档兜住，**不假装投递成功**。错误分类只能靠 `message`（`no active turn to steer` 那两支的 `error.data` 是 `None`）。
- **`thread/queue/delete` 只回 `{deleted: boolean}`**：「已消费 / 已删过 / id 不对」三件事在它那里分不开 ⇒ 删不到时读一次 `thread/queue/list` 才分得开「厂商赢了竞态（它已经不在队列里）」与「撤不到也说不出为什么」。
- **会话身份只能由我们自己落盘**：候选的 MCP / 路由只写在**线程级 config** 里、从不落 `$CODEX_HOME/config.toml`，`thread/list{cwd}` 因此列不到这个候选的线程 ⇒ 不要用「cwd + 最近一条」找会话。`thread/resume` 也**不发 `thread/started` 通知帧**，线程 id 只从响应的 `thread.id` 取。

**声明的现状（界面按它置灰，不按机制猜）**：`'idle'` 档记 **`yes` + `real-path`**（驱动器 `testing/codex-injection-fixture.ts`：真二进制 + 脚本式上游，四条判据＝交付登记 / 那句话进**厂商出站请求体** / 那一轮跑完 / 答复成为候选 `finalText`；阴性对照不挂注入面）；`'round'` 档仍记 `unverified`（**投递点**没有读数：steer 落在哪一次模型往返之前、是否重置墙钟看门狗）。**两档都要 `experimentalApi`**：`thread/queue/*` 六个方法在 wire 上都在，但逐条带 `#[experimental(…)]` 标注（`thread/list{ancestorThreadId}` 是字段级），拿掉能力位时报的是 `… requires experimentalApi capability` ⇒ 投递与子线程枚举会一起静默失效。撤回两格按档分开：`'idle'` 是 `by-id`、`'round'` 是 `none`；续接是 `yes`（真二进制 → 真 app-server + 脚本式上游的真路径驱动器）。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| 带 `outputSchema` 的一轮跑满 180s 无答复（`settle=timeout`；同题面对照组 94s；复跑 1.7s 正常） | 未定位 | 与结构化输出的因果关系未证实；下一步带 relay 复现（`probe/v4 only=schema timeoutMs=420000`），判据「有没有 `response.completed`」 |
| **「试着跑但被拒」的工具调用** | **结构性缺（账本盲区）** | 命令真的被跑起来、又被沙箱/审批拒掉时，厂商**一个 `item/*` 都不发**（逐帧为证）⇒ 账本里 **0 条工具块**、事件流无痕，**而模型侧收到了失败原文**。原文只落在 `<CODEX_HOME>/sessions/**/rollout-*.jsonl` 的 `response_item{function_call\|function_call_output}` 里（`call_id` 就是我们铸的那个 id，可精确配对）⇒ 要补这一格得**另读 rollout 文件**（或如实登记为边界）；**不要在投影层补造**——那是编一条厂商没投的帧 |
| **`codexErrorInfo` 的两档** | 一档已定位、一档未观测到 | **`contextWindowExceeded`**：形状精确到一格 —— SSE `response.failed` ∧ `response.error.code` 逐字 `context_length_exceeded`，文案 `Codex ran out of room in the model's context window…`。**只有这一格触发**：HTTP 400/413、顶层 `error`、`response.incomplete`、只改文案或拼法**都不触发**；**「把 `model_context_window` 配小」也逼不出来**（1000/200 × 48000 字符 × 3 轮全 0）。**`sandboxError`**：13 种装配**未观测到** —— 沙箱贴不上（见上面那条 `sandbox_apply`）只让**工具级** exit 71，这一轮照常收场、`codexErrorInfo` 缺席 |
| 消息级用量 | 结构性缺 | app-server 只到线程级 ⇒ `AgentMessage.usage` 恒 `null`，点名记录，不用近似值顶替 |
| 计划更新的 `explanation`（模型自己写的「为什么改计划」） | **未闭合**（协议面上有、我们没采） | `TurnPlanUpdatedNotification = { threadId, turnId, explanation: string \| null, plan[] }`（本机 `codex app-server generate-ts` 生成物逐字），而 `appserver/protocol.ts` 的窄声明只读 `plan[]` ⇒ `ToolCallPayload.note` 恒 `null`。补它要动 `protocol.ts` + `message.ts` + `message-conformance.test.ts` 的 `note` 断言，属**扩展采集面**，单独开口 |
| 命令入参里的 `justification`（模型写的审批理由） | 结构性缺 | `codex-rs` 的 `ExecCommandArgs.justification` 只服务于沙箱升级审批，而 `ThreadItem.commandExecution` 的字段里**没有它**（协议面就丢了）⇒ 本仓读不到，也不该拿审批语义当「这一步在干什么」 |
| 工具调用的「人话描述」 | 结构性缺 | codex 全家族**没有** `description` 这一格（`command_execution` 只有 `command`/`cwd` 一族；`apply_patch` 是 FREEFORM lark 语法，补丁正文不在协议条目里）。所以摘要只能走「族拼法」：`exec_command` 给命令原文、`apply_patch` 给改动清单，见《四家横向对比》 |
| 只回密文路由的推理明文 | 结构性缺 | `content[]` 为空 ⇒ **全文那一块**不产（`text: null` + `'none'`），而**摘要另有一块**：`summary[]` 非空时就产 `textKind: 'summary'`（真机常见形状就是「`content[]` 空 + `summary[]` 有」⇒ 那时**没有 `none` 块**）。「不回落 summary」说的是**不把摘要写进全文那一块冒充全文**，不是「一个块都不产」 |
| 审批类（`item/…/requestApproval`） | 结构性缺（对本仓而言） | 协议形态是 server→client 请求，而 `approvalPolicy: never` 下厂商**不会**发；即便发来，本仓也**只归类不回帧**（应答等于替用户批准）⇒ 不合成消息 |
| 问用户（`item/tool/requestUserInput`） | 已接（`askUser: yes` + `vendor-tool`） | 通道、递答案、选择模式与收场见《提问与应答面》一节；**这一家只有单选**（题目对象没有多选格 ⇒ 多选得拆成多次提问），分界线是**审批类仍只归类不回帧**，子线程发起的提问厂商自己就拒 |
| 步数口径 | 已按响应身份定尺 | `Turn` ≠ 一次往返（一个 turn 里可以有多轮）；与 `subagentTurns` 同一把尺，一次产出都没有时 `null`。**已知边界**：条目 id 里没有 `_` 分隔符时退回结构判据（工具活动），此时「答复之后直接下一次往返」的那一轮（提问应答）会并号 |
| 内置 hosted `web_search` 的开关 | 已闭合 | 开关是**顶层** `web_search: 'disabled'`（`CODEX_WEB_SEARCH_OFF`）；`tools.web_search` 那一格是参数容器、关不掉它。判据：`index.test.ts` 的配置形状三条 + 真机守卫 `turn-injection-delivery.test.ts` 对**出站请求体**工具表的断言 |
| 主线程收场时子线程还在跑 | 已闭合 | 上游产完之后走一段**有界**静默窗口（`CODEX_DESCENDANT_QUIET_WAIT`）：每一拍把流停之后入队的通知投影掉（用量只从通知来），并等后代线程到终态；窗口结束才收尾，收尾取数等它放行。**没有后代线程时不花时间**，预算到点按现状收尾并点名。判据 `descendant-quiet-live.test.ts`（四格一起判） |
| 收尾取数的全量水合路径 | 已闭合 | 两步取数（`thread/read` 不带 `includeTurns` + `thread/turns/list`），不再触发厂商的 `deprecationNotice`；判据：`appserver/reader.test.ts` 五条 + 真机臂的「不许再出现 `deprecationNotice`」断言 |
| 二进制解析「第二跳基准」守卫缺口 | 未闭合 | vitest 里裸说明符解析被运行器接管比生产宽松，基准改错仍绿；两条闭合路径（真 Node 子进程验 / 形状式源码断言）都未做，如实登记 |
| 平台包空壳（`@openai/codex-darwin-arm64` 只剩空壳 ⇒ `Cannot find module '@openai/codex-darwin-arm64/package.json'`） | 环境坏 | pnpm 的「已安装」真源是 `node_modules/.pnpm/lock.yaml`，不校验盘上文件——`--frozen-lockfile` / 重装 / `--force` 全部无效；修法：取镜像 tarball 校验 `shasum` 后手工物化到 `.pnpm` 位置（保住 `0755`）；判据：真 Node 两跳解析通过、`codex --version` ⇒ `codex-cli 0.156.1`；清空 `node_modules` 重装会重踩 |
| 插件 startup sync（`thread/start` 时同步 curated 插件目录，spawn `git` 孙进程链） | 未闭合 | 线程级 `config` 管不到它（`features.plugins=false` 只有盘上 `config.toml` 或 `-c` 生效）；处置是 `close()` 异步杀整棵树并等 exit；真机守卫 `AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts` |
| skills：core 加载器的 frontmatter 精确允许集、同名 skill 的模型侧选择、spawn 后落盘能否被同 turn 看到、`SKILL.json` 用法 | 未证实 | 本仓只依赖「`<configHome>/skills/<名称>/SKILL.md` + spawn 前写完」这两条已实测的前提；其余按未证实处置，不写死 |
| skills：按 `name` 禁用会被 `path` 条目压制（推测）、`skills/extraRoots/set` 未测、`skills/changed` 通知未捕获 | 未闭合 | 本仓不用这三个通道（停用走文件级不放）；要用先跑探针 |
| skills：真实家目录里的**插件**技能未在真实会话验证 | 未覆盖 | 候选内 `HOME` 隔离已经实测挡住宿主家目录那一批；插件来源那一档仍按未证实登记 |
| `thread/list` 用量粒度是否到每个模型往返 | 无样本 | 文章不写死 |
| 退出码 | 结构性缺 | `app-server` 在 `turn/completed` 后不自退，kill 后退出码恒 `null`（4/4）⇒ 退出码不得当本轮成败判据，只认 `turn/completed.status` + `error` |

**终结闸门按 `threadId` 认本轮**：主线程与每个子线程各有自己的 turn，`turn/completed` 多条、`threadId` 各异——子线程先到不能当本轮终结（踩过的坑：拿到的是子线程结束时刻的快照）。收尾取数（`thread/list{ancestorThreadId}` 枚举后代 + **逐线程两步取数**）必须在 `finalize` 之前落定。两步取数是 `thread/read{threadId}`（**不带** `includeTurns`，只取元数据）+ `thread/turns/list{threadId}` 分页取 turn（`status` / 起止时刻 / 时长 / `itemsView` / `items`）：paginated 线程上带 `includeTurns` 的**全量水合已被厂商弃用**，真机会投 `deprecationNotice`，而替代路径的字段逐格等价。⚠️ **两格必须显式给，别吃厂商默认值**：`sortDirection` 厂商默认 **`descending`**（生成物原文 *"Optional turn pagination direction; defaults to descending."*）⇒ 不传就是最新一轮在前，而下游按 `turns.at(-1)` 读「最后一轮」会把**第一轮**当成子线程的终态与结论（真机两轮对照：不传 `["turn#2","turn#1"]` ⇒ `at(-1)` 拿到第一轮答复；传 `asc` ⇒ `["turn#1","turn#2"]`）；`itemsView` 厂商默认 **`summary`**（*"…defaults to summary."*）⇒ 不传就永远走不到 `itemsView === 'full'` 那条快路径，每条线程恒多付一次 `thread/items/list`。本仓显式传 `sortDirection: 'asc'`，条目一律以 `thread/items/list`（文档化的全量来源）为准。收尾读回与通知同源：读回的 reasoning 条目与 `item/completed` 逐字相同（4/4）。

## 相关链接

- 活文档：[Codex FAQ](/faq/codex)——加载与凭据、网关与 wire、评分通路、计量与思考、进程与收尾五组现象条目，拿报错原文一搜即命中
- 仓库内参考：`packages/server/agents/README.md`——§4.4 能力查询的唯一入口、§5 各家差异（注入落点 / 停止与释放 / 事件流 / 步数与计量）、§8.1 新增 SDK 接入清单
- 知识文章：[《DeepSeek Harness 接入》](/protocols/dsh)、[《Claude Code 接入》](/protocols/cc)、[《四家横向对比》](/protocols/comparison)、[《技能配置》](/features/skills-config)（四家 skills 的配置面与候选级判据）、[《评分》](/features/judging)（outputSchema 的评分侧全链）、[《候选执行与日志》](/features/candidate-execution)（用量与步数展示口径）、[《密钥与环境变量》](/guard/secrets-and-env)（`env_key` 与子进程环境凭据规则）
- 外部资料：[openai/codex discussions#7782](https://github.com/openai/codex/discussions/7782)（chat wire 移除）、[process.getBuiltinModule](https://nodejs.org/api/process.html#processgetbuiltinmodulemoduleid)（跨打包器取真 `createRequire`）
