# Pi Coding Agent 接入

## 定位

pi（`@earendil-works/pi-coding-agent`，配套 `@earendil-works/pi-ai`）是第四家厂商智能体，**进程内 SDK**：一行一次 `createAgentSession`，事件经 `session.subscribe` 回流，中途取消走 `session.abort()`。`protocolTypes` 是 `['openai', 'anthropic']`——协议决定 wire（`openai → openai-responses`、`anthropic → anthropic-messages`），两条都能收；`openai` 指 **Responses** 接口（`POST {base}/v1/responses`），与评分通路的文本调用同一个判据。派发能力由白名单装载的第三方扩展 `@tintinweb/pi-subagents` 提供。

## 形态与交互

- **装配序列**：`mkdir <configHome>/skills/<name>` → 物化全部 `SKILL.md` → `new DefaultResourceLoader({...})` → `reload()` → `ModelRuntime.create()` + `registerProvider()` → `createAgentSession()` → `bindExtensions({ mode: 'rpc' })`。顺序错了的两种表现都是静默的：技能写晚了装载器扫不到（这个候选照跑、一条技能都没有），扩展在 `createAgentSession` 之后才 `reload()` 时 handler 注册上了却一次都不被调用。
- **凭据只有内存一条**：`InMemoryCredentialStore` + `modelsPath: null` + **文件型** `SessionManager`（`create` / `open`，落点显式钉在 `<configHome>/sessions`）+ `SettingsManager.inMemory()`。provider 逐行自注册，id 由 `configHome` 派生（前 12 位十六进制）——`ModelRuntime` 的注册是**按 id 索引的全局表**，复用常量 id 会让并发两行互相改掉对方的 `baseUrl` / `apiKey`。
- **baseUrl 按 wire 分叉**（pi 不做任何归一化）：`openai-responses` 自己只追加 `/responses`、不插 `/v1` ⇒ 裸 host 补 `/v1`；`anthropic-messages` 由 `@anthropic-ai/sdk` 追加 `/v1/messages` ⇒ 尾部 `/v1` 剥掉。
- **档位映射**：本仓档位 → 会话级 `thinkingLevel`。`off` 在 openai wire 上是 `reasoning: { effort: 'none' }`、在 anthropic wire 上是 `thinking: { type: 'disabled' }`；`minimal/low/medium/high` 同名直传；`max` 靠模型上的显式映射（`thinkingLevelMap`）才可用，没有映射会被静默夹到 `high`。模型定义必须带 `reasoning: true` 与 `thinkingLevelMap`，否则档位域整体失效。
- **隔离序列**：`noExtensions: true` 挡住被测仓库 `.pi/extensions/*.ts` 的任意代码执行；`additionalExtensionPaths` 白名单装载子智能体扩展（**不受 `noExtensions` 管**）；`skillsOverride` 只留「候选白名单 ∪ `cwd` 之下的项目技能」、丢掉 HOME 锚定的发现结果。**刻意不设** `noContextFiles`（缺省才读得到被测仓库的 `AGENTS.md`）与 `noSkills`（它会把项目技能一起关掉）。装载器被兜底重建过时，扩展表断言放在兜底**之后**读。
- **MCP 零文件注入**：canonical 条目翻成 `createMcpExtension({ loadConfig })` 读的**内存对象**，不落任何 `mcp.json`——被测仓库的 `.pi/mcp.json` 因此连读都读不到（SDK 下那个项目信任开关对 MCP 是死的）。每台**显式**给 `exposure: 'direct'`：pi 的缺省档 `codemode` 下工具**只可调用、不声明**，模型侧看不到，观测格那条判据永不触发，且 `codemode` 还依赖一个我们没启用的扩展。首次 prompt 等 `direct` 档服务器 **10 s**（不是连接超时，超时之后照常重连）；坏条目在我们这一层**摘掉 + 事件里点名 + 行照跑**（自给 `loadConfig` 绕过了 pi 自己的校验，而 pi 的姿态是「让这台失败」而不是「跳过它」）。两处细节是判据而不是修辞：**能拦的都拦在契约层**（`resolveMcpServers` 的 `invalid` 桶——那一档走「行照跑 + 观测格 `unverified`」），适配器这一层只兜手改配置与将来的新调用点；**被它摘掉的条目必须落一条可见的 `log`**，因为厂商那边的启动报告走 `ctx.ui.notify`、而 SDK 装配下那是 `noOpUIContext` ⇒ 不落的话，这一台会被候选级观测格读成「厂商没起来」（整行 `AGENT_MCP_UNAVAILABLE`，文案指着一台从没起过的服务器）。候选级观测格的判据通道是**厂商工具表**——`direct` 档下工具真的进请求，`payload.tools` 里有 `mcp__<名>__*` 才算装上（这一家把名字里非 `[A-Za-z0-9_]` 的字符改写成 `_`：配置名 `my-server` 出站就是 `mcp__my_server__echo`，判据两种形态都认，见[《MCP 配置》](/features/mcp-config)的失败判据一节）；这一家**没有**「每台一张状态表」那种东西，工具面就是最硬的证据。失败形态与 dsh 同档：**静默**（工具消失、会话照常跑完、无结构化错误）。**OAuth 登录不补**（与三家对齐）：需要登录的服务器回 401，落到 `needs sign-in` 那一格。它**可补、不构成未覆盖项**——公开包 `@earendil-works/pi-mcp/oauth` 自换 token 后交给 `createMcpExtension({ credentials })` 即可，不需要 patch 厂商包。
- **看门狗与释放**：`interrupt()` 走 SDK 的 `abort()`（毫秒级终结在途轮，`cancelMidTurn: true`）；释放**整 run 一次**（`abort()` → `waitForIdle()` → **补发扩展事件 `session_shutdown`** → `session.dispose()` → 注销候选的 provider 注册），所有活动区间（首轮与每一次追问）共用同一份释放入口——追问区间若各自交一份空操作，释放链会整个跳过。**那一发 `session_shutdown` 是我们自己补的**：厂商把扩展的连接清理（MCP 的 stdio 子进程）挂在它上面，而 `AgentSession.dispose()` 不 emit 它（只有 `AgentSessionRuntime.dispose()` 与 `reload()` 会）⇒ 按厂商同一条顺序走公开面补发。追问（`continue`）**不新建会话**。

## 数据与契约

- **步数**（界面叫「步」）＝一次模型往返：`turn_start` 上 +1（真机与助手 `message_end` 条数恒等，而它先到——按 `message_end` 数会让第 N+1 轮的增量帧落进第 N 轮那条消息里）。一次工具调用算两轮。
- **用量**：助手 `message_end.message.usage` 逐次往返累加（`reasoning` 是 `output` 的子集，不双计）；`cost` 丢弃（本仓没有成本格）。合计（`tokens` / `turns`）**含**子智能体那一份——主子自己的读数与子会话的读数覆盖面不相交，两份相加才是「这个候选一共花了多少」。
- **时长**：助手消息自带 `timestamp`（厂商记的请求起点）与 `durationMs` ⇒ 时间跨度整格记 `source: 'vendor'`。`ttftMs` **恒为 `null`**（厂商不报首字时延，唯一测法是我们自己的第一帧——混两把尺子会让 `mergeTiming` 整格作废）。
- **思考正文与工具结果正文逐条进 `log`**：这是 `needsMessagesForReasoningEvidence: false` 成立的**前提**，不许在这两条上过滤、摘要化或截断。与之配套的是**增量帧绝不产事件**（只有 `message_update` 产内容消息）。
- **结束信号只有 `agent_settled`**：`agent_end` 之后还可能有 auto-retry、compaction 与排队输入（`steer` / `followUp`）。
- **失败两条通道**：**运行期**失败（传输失败、被中止、自带超时）不抛，只体现在助手消息的 `stopReason` / `errorMessage` 上；而**起请求之前**会抛（凭据缺失 / 模型未选 / 压缩中 / 已有在跑的轮）——那一路必须抛给骨架，否则会被读成「这个候选成功了、只是没说话」（厂商给的是裸英文短句，转发前先翻成带 host 的中文原因）。
- **子任务**：派发工具（`Agent`）由第三方扩展 `@tintinweb/pi-subagents` 提供，按 `additionalExtensionPaths` 白名单装载（**不 import 它的 `dist/index.js`**：该包无入口字段且是 ESM-in-CJS）；扩展没装上 ⇒ **整候选失败并点名包名与版本**（不许「声明支持、实际没装」）。身份 / 状态 / 用量经扩展事件总线（`pi.events` 的 `subagents:*`）到达；`Agent` 工具结果里那句 `Agent completed in …` 是给人看的排版文本，**不从中解析任何字段**（结构化 `details` 只作交叉核对，`turnCount` 只有它有 ⇒ 步数取它）。只到顶层（`parentSubagentId` 恒 `null`）。子任务行有**三条**投递通路：**派发那一刻**（总线报 `subagents:started` 时投一条 `status: 'running'` 的行——前台档的 `Agent` 是阻塞工具，没有这一条则整段运行期界面上没有卡片与入口）、`Agent` 工具收尾、收尾对账；三条按身份折叠，后者是前者的完整快照。
- **结构化输出**（原生通道，工具参数即权威 schema）：

  | 环节 | 做法 |
  |---|---|
  | 通道 | 自定义工具 `submit_result` + `constrainedSampling: { type: 'json_schema', strict: 'require' }`——pi 建请求时把这份 schema 交给 `makeStrictJsonSchema` 转成 strict 形态，作为工具参数出站并带 `strict: true`，形状由**厂商侧强制** |
  | 装配期预检 | 按两条 wire 的差集判调用方 schema 是否落在 strict 子集内；判不过 ⇒ **显式降级**（工具降 `strict: 'prefer'` + 骨架的填充层 + 修正轮），记 `false` 并落一条点名的 WARN（**那一句要说清这一档到底交付了什么**：工具+填充层 / 只有工具 / 两者都没有，三种兜底强度不同）。**不收窄 schema**——四家拿到的题目必须逐字相同。交付面按**结构**分档：「压根不是 JSON 对象」⇒ 什么都不交付；「是 JSON 对象但根不是 `type: object`」⇒ 降级档照旧交付（非 strict 档只取根节点的 `type/properties/required`，根是数组时那一份会退化成空对象形态——这是 schema 形态的已知代价，不是「按没给处置」） |
  | 两条铁律 | ① **永远把调用方原 schema 交给工具参数**：`makeStrictJsonSchema` **非幂等**（含可选对象 / 数组属性的 schema，其 strict 产物再喂一次会被拒），预归一化的代价是**整轮零出站请求**；② **把工具参数投影回最终答复**：产物落在工具参数里，而评分通路只读 `finalText` |
  | 修正轮 | 两条路都实现 `continue`（同一 `session` 再交一条用户消息）。原生通道有**条件性**：`ToolChoice` 只有 `auto / none`，模型完全可以用一段正文回答 |
  | `applied.structuredOutput` | **只有本轮答复确实来自被 strict 约束的工具参数**才为真。三种 `false` 分得开：① 降级档（`'prefer'`）的工具调用——参数照样投影进最终答复，但那一档没有厂商侧强制；② 模型没调工具、走正文；③ 调过之后某一轮（含修正轮）改走了正文。备选通路（`before_provider_request` 注 `response_format`）机制成立、能出站、网关 200，但**本机网关不兑现** ⇒ 只作软压力，**不得**上报成原生通道 |

- **两条 wire 的 `compat` 必须显式开**（`openai → supportsStrictMode`、`anthropic → supportsStrictTools`）：不开时 strict 工具声明拿不到支持，pi 把整轮判成配置错误——**零出站请求**、43 毫秒、`stopReason: 'error'`，`prompt()` 还不 reject。其余键（`store` / `prompt_cache_key` / `max_output_tokens` / `developer` 角色 / `reasoning.effort`）本机网关全部接受，多开一格就是给「零覆盖」这条实测结论加一个没有依据的覆盖。

## wire 形态与事件

- **两条 wire 的端点**：`POST {base}/v1/responses`（openai）、`POST {base}/v1/messages?beta=true`（anthropic）。
- **strict 工具的落点**：两条 wire 都在 `tools[]` 的顶层（`{type:'function', name, strict, parameters}`；anthropic 的参数键叫 `input_schema`）。判据读 `observer.ts` 的纯函数（平铺声明与 Chat Completions 的 `function.{}` 嵌套一次遍历同时认），不另写一份解析。
- **事件全集**：`agent_start` → `turn_start` → `message_start/end`（system、user）→ `message_start`（assistant）→ `message_update`（`text_start` / `text_delta` / `thinking_delta` / `toolcall_delta`）→ `message_end`（assistant）→ `tool_execution_start` / `_update` / `_end` → `message_start/end`（toolResult）→ `turn_end` → … → `agent_end` → `agent_settled`。另有 `auto_retry_*`、`compaction_*`、`queue_update`、`entry_appended`、`bash_execution_update`、`session_info_changed`、`thinking_level_changed` 等会话级事件。
- **三档处置**：**产消息**（`message_update` / `message_end` 助手 / `tool_execution_end`）、**产事件 + 计量**（`turn_start` / `message_end` 助手 / `agent_settled`）、**其余（含未识别）** 一条保留原始负载的 `log`——什么都不丢，也不假装认识。
- **流式增量走 `wire`**：`session.subscribe` 的事件里就有逐字增量，不需要像 dsh 那样挂插件旁路（能力位 `streamingDeltaSource: 'wire'`）。**子会话同样逐字**：子任务正文走的是同构的那条订阅（见已知边界表「子会话正文的首选通道是 wire」），故主会话与子任务节点在界面上是同一种节奏。
- **订阅先于提示词**：订阅在流的第一次迭代时建立，提示词在订阅之后才发出；收尾判据是「提示词落定 **且** 队列已排空」（它 resolve 之后队列里可能还有 `agent_settled` 之类）。
- **请求侧取证**：`before_provider_request` 的 payload 由观察者抓下来，技能装载档与工具表两条判据都读它（技能段条数与 MCP 工具名只在出站请求里）。

## 提问与应答面

pi 结构上没有「向用户提问」这件工具，而模型能调的每一个工具都来自会话装配面 ⇒ 这一格由**宿主注册**（`providers/pi/ask-user.ts` 的 `ask_user_question`）。本仓声明 `askUser: yes` + `askUserChannel: 'host-tool'`，一致性场景走真路径（真包 + 本机假网关，只把上游模型脚本化）。

| 面 | 现时做法 |
|---|---|
| 通道 | **宿主工具**：厂商的工具面里没有提问工具、也不下发这一类控制请求。工具名沿用既有 `ask-user` 族表已识别的那个 ⇒ 族载荷归一、卡片与七态全部复用，族表一行都不用改；它与 pi 的全部内置工具（`read` / `bash` / `powershell` / `edit` / `write` / `grep` / `find` / `ls`）以及本仓装进来的子智能体那三件都不撞 |
| 递答案 | 同一个进程：`execute` 里直接 `await` 提问端口（零 IPC），答复映射进工具结果（`answers` 那一支）。参数形状与契约的 `AskUserQuestion` **逐字同形**（`questions` 是唯一必填的根键，族载荷归一正是靠它认这一族；少一个字段名会让卡片与答案回填各自静默降级） |
| 等待预算 | 没有厂商那一格（`vendorBudgetMs` 恒 `null`）⇒ 超时只由骨架的预算产生 |
| 收场 | 骨架那一套：`answered` / `timeout` / `canceled`（回调抛错时另落 `unavailable`）；**没有**厂商自收场这一档 |

宿主工具这条通道的**固有限制**（与厂商工具那一档的差别全在这里，换一家自注册工具时同样成立）：

- **提示词三格全是我们自己写的**（`description` / `promptSnippet` / `promptGuidelines`）：厂商工具那一档「什么时候该问」由厂商的提示词管，这一档只能由我们给——唯一落点是 `promptGuidelines`（`description` 只描述能力），而它必须点明两侧：只写「该问」那一半，模型会把能从工作目录、代码或文档里查到的事也拿去问人。`promptSnippet` 只写「这是什么」，厂商把它渲染成 `- <name>: <这一格>`，再写一遍名字就会重复；**不给这一格时自定义工具在工具段里根本不出现**（厂商按有没有这一格过滤，不是按有没有这个工具）。
- **只在有应答面且全权限档时注册**：不传 `onAskUser` ⇒ 工具名与 `customTools` 都不出现（会话选项逐字不变）；只读档的工具面刻意不接触外部状态（连 `bash` 都不给），那一档不装这一件——应答面存在与否不改变这条裁定。
- **「不问就不动」在这一档的落点是「不注册那件工具」** ⇒ 对照臂里同一句剧本那一问必然落成一条「工具不存在」的错误结果，两臂指纹因此**结构上做不到逐字相等**。判据换成三条等价强度的事实：对照臂的**出站工具表**里没有那个名字（白名单是成员匹配器，名字没拼进去时厂商**静默**少一件，只有请求侧看得见）、那一问拿到工具不存在类错误原文、把那一件工具归一到同一形态之后两臂指纹仍逐字相同。
- **不声明 `constrainedSampling`**：契约问题形状里的可选字段形态（例如 `description` 可为 `null`）不在厂商 strict 采样支持的子集里，开了反而会被它拒；每一层都给 `additionalProperties: false`——多给的键不会进卡片，静默丢掉比当场被厂商校验拒更坏。
- **子智能体会话拿不到这一件**：`customTools` 只装在主会话的 `createAgentSession` 上，子会话的工具表**没跑过**（未证实）；编排层那一道兜底与四家共用（请求带 `subagentId` 就落 `rejected`）。

## 注入与续接

「人往运行中的这一轮送话」与「接着一条已有会话再跑一段」是契约的两格（`AgentRunInput.inject` / `resume`）。这一家的两档各有**原生方法**（不必像 dsh 的 `'round'` 那样为它常驻一支插件），落点与粒度如下。

| 面 | 现时做法 |
|---|---|
| `'round'`（立即发送） | `session.steer(text)`——排到「当前这一轮的工具都跑完、下一次模型往返之前」。**这是本仓的 `'round'`**，比 `'idle'` 早一档，但仍不是「一次工具调用跑完」那一档 |
| `'idle'`（排队） | `session.followUp(text)`——排到「这一次 run 没活可干了」。**它唤不醒已经收工的会话**（只推队列）；真正的收场由编排层的等待预算兜底 |
| 返回值 | 两件都回厂商的 `QueuedInputDisposition`：`'queued'`（进队列了）/ **`'handled'`（被某个扩展当场吃掉）**——本仓装着的子智能体扩展命中 `@名字 …` 时会走这一支 ⇒ **`'handled'` 不得当成已投递** |
| 撤回 | **只有整条清空**：厂商会话上的 `clearQueue()` 把 steering 与 followUp 两条队列**一起**清 ⇒ 没有按条撤回的面；本仓窄壳也没有接它（本期不用） |
| 续接 | **`SessionManager.open(会话文件)`** 塞回 `createAgentSession`——落的键是**会话文件路径**，不是会话 id |

四条今天仍成立的边界：

- **空闲 / 已收工时调用不抛、不丢、也不起一轮**（只推队列）⇒ 投递方**不能靠异常判成败**，只能读那一格返回值。
- **`'handled'` 是这家独有的失败形态**：话被扩展吃掉之后既没进队列也没到模型，而界面上一路正常 ⇒ 适配器必须如实处置这一档（不许把「推出去了」当「投进去了」）。
- **续接必须用 `open(文件)` 不能用 `continueRecent`**：后者取会话目录里 mtime 最新的一条，而候选内重跑会在同一目录留下上一次尝试的会话 ⇒ 接回来的是上一次的上下文。
- **要落的键是会话文件路径**（文件名是 `<ISO 时间戳>_<会话 id>.jsonl`，时间戳不可预知 ⇒ **id 拼不回路径**）；会话落点显式钉在候选配置目录下的 `sessions/`——不给这一格时厂商按 `agentDir` × `cwd` 两轴推导默认落点，而工作区会被重建 ⇒「这个候选的会话在哪」变成算不出来的东西。会话文件不存在时该候选**失败并点名路径**：厂商的 `open()` 在文件不存在时不抛、当场新造一条，静默开新会话正是「用户以为在追问、模型什么都不记得」的那种失败。

**声明的现状（界面按它置灰，不按机制猜）**：投递两档记 `off-by-adapter` / `not-observed`——厂商侧两档都有原生落点，窄壳也按实际面声明了 `steer` / `followUp`，但**适配器今天一格端口都不挂**（没接就是没接，事实面由「端口挂着也不投」那条用例钉住）。撤回两格记 `flush-only`，**故界面上不许出现「撤回这一条」的文案**（`delivered` 上禁用并如实说「这一家只支持清空整条队列」）。续接那一格是 `yes`（真路径：真包装配 + 真会话管理器 + 真 JSONL 落盘，假网关只扮演上游模型；暗号回读、阴性对照与按行隔离三条判据都成立）。

## 已知边界与取舍

| 边界 | 性质 | 处置与判据 |
|---|---|---|
| 结构化输出走**工具通道** ⇒ 候选的工具表比另三家多一件（`submit_result`） | 跨家可比性的已知解释变量 | 登记而不隐藏：另三家走各自的原生字段（cc 的 `outputFormat`、codex 的 `turn/start.outputSchema`）与填充层，pi 多一次工具声明；不启用 `codemode` / `tool_search` 是同一条「少一个与题目无关的解释变量」的口径 |
| 模型**可以不调用** `submit_result`（`ToolChoice` 只有 `auto / none`，pi 没有强制工具选择） | 通道的条件性 | 那一轮的最终答复来自正文，`applied.structuredOutput` 记 `false`——这一格记的是**方法**（形状由谁保证），不是结果；修正轮是唯一的兜底（骨架对所有给了 schema 的家统一跑） |
| 越界参数会被反复重交，而**厂商那两个环都没有轮数上限** | 厂商侧缺口 + 本层收口 | 厂商在参数**校验失败**时返回的是不带 `terminate` 的错误结果（校验在 `terminate` 之前，`pi-agent-core` 的 `executeToolCalls*` 里 `preparation.kind === 'immediate'` 之后照样 `emit(tool_execution_end)`）⇒ 模型每交一次就换来一条错误、再交一次。真机读数（脚本式上游，永久回同一段越界调用）：**15 秒 1337 次出站请求**，不挂看门狗直接 OOM。本层因此自己收口：投影层数 `submit_result` 的 `isError` 次数，超过 `PI_STRUCTURED_REJECTION_BUDGET = 3` 交出一条点名 `failure`，**并在同一个判据上 `session.abort()`**——只交 `failure` 停不下厂商的 agent loop（骨架记下它、循环照跑）。中止那一轮由本层发起，故记 `selfAborted`：厂商把它报成 `stopReason: 'error'` + `This operation was aborted`，不记这一笔的话那条失败会盖掉点名原因 |
| provider 侧**是否真的施加了约束**要**按 wire** 看 | 已实测（1.3.0 + 本机网关） | 压力测试（同一份小 schema + 硬要求越界的提示词，N=12）：**anthropic wire 注了 `strict: true` 仍越界 11/12**（不注 strict 的那一臂 12/12，无差别）；**openai wire 的 strict 臂 0/12**（真拦住了）⇒「声明了 strict」只在 openai 那条路上等于「形状被强制」。产品路径（anthropic，6 行）首交 6/6 越界，靠骨架的修正轮补问一次才合格，而 `applied.structuredOutput` 仍记 `true`——那一格记的是**答复来自工具参数**这件方法，不是形状被强制。**根因不属本仓可观测范围**：代理丢字段，还是上游不做约束解码——两者都在**网关背后**，本仓能测的只有「出站请求里声明了什么」与「答复是否越界」这两端（本仓没有任何能看代理出入参的位置）。因此这一格的现时口径就是上面那组读数，**换网关必须重验**（enforcement 是网关属性，不是 pi 的属性）；**不许**把它写成「厂商保证了形状」 |
| strict 子集外的构造（`$ref` / `$defs` / `oneOf` 双方拒；`minItems ≥ 2` / `maxItems` / `minimum` 仅 anthropic 拒；手写 `anyOf` 可空对象双方拒） | 厂商方言 | 装配期预检拦下并显式降级；可空标量写 `type: ['string','null']`（两边都放行）。子集边界与逐条字段路径见 `packages/server/agents/src/providers/pi/structured-output.ts` |
| 子会话**继承主会话的模型与网关 / 密钥**（`subagentSource` 取 `wire` 的由来） | 扩展的取数方式 | 父会话的 `modelRegistry` 与 `modelRuntime` 原样传下去 ⇒ 子智能体打的是同一台网关，**不需要**配置文件 / 环境变量 / 宿主 CLI；子任务那几格因此是厂商侧真值而不是我们的推断。**唯一不继承的是 `agentDir`**（见下一行） |
| 子会话的**会话文件**与 settings / memory 落**真实 `~/.pi`** | 厂商限制 | 子会话与扩展走 SDK 的**进程级**全局路径（`getAgentDir()` 只认 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` 与 `~/.pi/agent`；**后者优先、只管落盘目录**），装载器的 `agentDir` 那一格**管不到它们**——**并发 pi 行共享这一部分**，且**家目录不可写时整次派发以 `EPERM` 失败**（子任务行记 `failed`）。**转写正文不在这里**：它落共享的 `os.tmpdir()/pi-subagents-<uid>/…`。凡本仓自己起 pi 的 CLI 或它的扩展（探针 / 脚本 / 测试）一律先把这两格指到临时目录；只设 `agentDir` 不设环境变量的隔离是假隔离 |
| 派发能力整条来自第三方扩展；**模型也可以自己用 `bash` 拉起宿主 `pi` CLI 凑一个子智能体** | 观测面外 | 那条路径**不在我们的观测面内**：真机实测里子智能体真跑了、真交了报告，但候选 `subagentTurns: 0`、token 不进行的、事件流里一个字都没有——行上那几格只回答「经扩展派发的那些」。它同时是「模型会去宿主家目录翻凭据」的动机来源 |
| `Agent` 的 `run_in_background` **缺省 `true`**（派发即分离、工具立刻返回 ID） | 第三方默认值 | 两格分量**各自判完整性**：用量那一格来自总线终态载荷（`subagents:completed` / `failed` 的 `usage`），读得到就照交；步数那一格只在 `Agent` 工具结果的 `details.turnCount` 里，后台档工具派发即返回、那一刻子智能体还没跑，而**总线终态载荷里没有 `turnCount` 这一格** ⇒ 后台档结构上拿不到步数，记 `null` 并落一条点名 WARN（哪个身份、哪一格、为什么）。子智能体若在候选收尾前还没收场，两格都记 `null`（**不填 0**）+ 一条点名 WARN，合计退回主会话口径。两格不互相作废：绑在一起会让一份真读到了的用量跟着作废 |
| 后台档子智能体活过候选时，完成回调打旧 ctx 抛 `This extension ctx is stale after session replacement or reload.`，且是**未处理的 Promise 拒绝** | 第三方缺陷（未闭合） | 修在扩展侧（回调改从 `withSession` 拿新 ctx，或自己 catch 并降级成日志）；长驻服务下会掀进程。见 FAQ 条目 |
| 子智能体转写固定落共享 `os.tmpdir()/pi-subagents-<uid>/…` | 第三方缺陷（未闭合） | 不随行隔离：并发两行共享这一格，且它的清理不属于候选的释放序列。子智能体转写不作为候选产物、不进 `diff`、不进评分 |
| 子会话正文的**首选通道是 wire**（`subagent-wire.ts`，零改厂商包） | 宿主侧旁路（SDK 订阅是实例级的，子会话事件不进父会话流） | 扩展把 `AgentManager` 挂在 `globalThis[Symbol.for("pi-subagents:manager")]`（其 `docs/rpc.md` 记载的跨包单例，**先到先得**）。每个候选 reload 落定后把当时的注册表条目**快照进行的、随即删掉全局槽**——下一行 reload 时扩展工厂见槽为空就会挂上自己的 manager ⇒ 并发多行各拿各的；「reload + 快照 + 删槽」走**模块级互斥链**跨行串行（工厂的执行点在 `loader.reload()` 里，只包 bindExtensions 包不到 claim）。`subagents:started` 后轮询 `getRecord(id).session` 拿到子会话活句柄并 `subscribe()`（先同步试一次再按 20 ms 重试到 60 s 的放弃上限），订阅回调只**快照载荷 + 入缓冲**，收的是三种帧：助手 `message_end`、`tool_execution_end`，以及**逐字增量 `message_update`**（子任务节点因此与主会话同节奏地边产边长字；步数取「当前步 + 1」——增量属于那条还没收尾的消息，且不自增计数器，否则一步几十帧各占一步）；投影层在每个父事件之后 `drain(已落账的身份)` 折成消息（`source: 'wire'`、盖 `subagentId`，**界面不再有「补录」角标**）。**排空由本层自带的合成帧泵兜底**：缓冲进账即往父事件流里塞一帧自造的帧（`PI_SUBAGENT_WIRE_TICK_TYPE`，`events.ts` 的判别链最先判、投影成空），换来一次排空；**至多一帧在飞**（`drain` 跑过才消旗）、节流 25 ms、**排空后按剩余续泵**（一次正常投递要两帧：第一帧让子任务行落账，第二帧才排空），并对「永远不会落账的身份」做空转封顶（有新内容即归零）。**它今天值多少（真机量过，别按设计意图读）**：派发期并非「父会话一帧都不产」——`pi 1.3.0` 的原始帧计数里派发到收场之间有 **1 帧 `entry_appended`**、以及**数量不定**的 `tool_execution_update`（都不带子任务正文；后者的条数取决于工具在跑的时候有没有输出可刷——同一条探针不同次运行读到过 4 与 0，**别把某一个数字当成常量**），而父会话另有 `message_start` / `message_update` / `turn_start` 这类帧也会排空；真网关每臂 3 样本对照（接泵 / 不接泵，指标 = 正文首条到账相对父会话下一帧的先后）读到的是**接泵臂稳定早 2–3 ms、不接泵臂出现过 85 / 124 ms 的提前量** ⇒ 前台派发这条路上它的收益**量不到**。保留的唯一理由是**彻底静默的父会话**那一档（`index.test.ts` 的 `hangPrompt` 守卫钉住，摘泵即挂到超时）；**要删它的判据**：先删那条守卫与夹具，并证明真机不存在完全静默的派发窗口。泵按活动区间接（`attachPump`），接上那一刻缓冲非空就补一帧。步数基数取 `session.messages` 的助手数——与转写路径的助手行序对齐 ⇒ 同一条消息在两条通路上**载体键相同**，投影层按「第一条到达者胜出」去重（`runState.subagentCarriers`），wire 先到的通常赢；**订阅前的缺口在订阅那一刻用 `session.messages` 补账**（`backfillHistory`：总线报 started 到拿到句柄之间有窗口，快网关可能已经跑完一轮，那一段的事件不会重放），转写因此退成真正的兜底。**去重的判据是「载体 + 快照语义」而不是「载体」**：同一轮的增量与它的收尾快照载体键逐字相同 ⇒ 按载体记账会让先到的 delta 占死键、权威快照被整条丢掉（消息永远停在半截，且不报错）。故增量一律放行、只有快照之间互斥——成立前提是**只有 wire 产增量**（转写读的是已完成消息数组，天然只有快照）。快照落空 / 拿不到会话 / 订阅抛错 ⇒ **静默退回转写通道**（快照落空在装配面落 WARN，其余不点名）；缓冲上限 5000 条，**越界淘汰按块形态分档**（`evictOverflow`：先吃增量、快照垫底）——增量放开后越界不再稀有（几千 token 的答复就是几千帧），按到达序一刀切会把第 1 步那条权威快照顶出去，而界面上「少一整步」与「本来就没说」长得一样；点名也分两档（丢快照＝丢权威正文，丢增量只少几帧实时预告、收尾快照会覆盖 ⇒ 正文不丢）。逐字增量**不落盘**：编排层对 `chunk: 'delta'` 只扇出不写 `messages.jsonl`（`orchestrator.ts` 的 `onMessage` 分叉），界面侧按 `mergeKey` 覆盖累积、而合并器每条增量发的是「到目前为止的累积块」⇒ 子任务节点上就是一段逐字变长的文本 |
| 子会话正文的**兜底通道是转写文件**（`transcript.ts`） | 第三方旁路通道（wire 不可用时整行退到这里；`session.messages` 也读不出时那一段缺口由它补） | 唯一带正文的文件通道是 `<tmpdir>/pi-subagents-<uid>/<cwd 编码>/<会话 id>/tasks/<子任务 id>.output`（JSONL，扩展在 `turn_end` flush ⇒ 边跑边可读）。跑动期增量挂在每个事件的投影之后（`events.ts` 的 `deliverTranscriptIncrements`，同吃 wire 的合成帧——前台档父会话自己不产事件），四条闸门：总线已报终态的身份归收尾、子任务行必须已在**更早一批**投影里落账（骨架同一批投影先发消息后发行，同批混发会让消息先于行进账、被客户端归进主会话）、按身份节流读盘（250 ms）、只投差量切片（转写 append-only ⇒ 下标稳定；与 wire 同键的整条被载体去重滤掉）；收尾（`finalizePiSubagents`）对已收场身份补差量（先排 wire 尾巴，转写只补 wire 没覆盖到的载体）。转写的 `message` 与父会话 `message_end.message` 同构 ⇒ 复用既有的助手 / 工具结果归一，逐条盖 `subagentId` 与 `source: 'session-file'`（**「补录」角标只在这条通道上出现**），步数取**该子会话自己**的模型往返序（与 claude 的 `SessionRoundIds` 同一条口径）。**路径由候选 `cwd` 与本会话 `sessionId` 拼出，不扫目录**——转写根是全机共享的，扫目录会让并发的两行互相认领对方的子任务。读不到记空 + 一条点名 WARN，**不改结论**（跑动期读不到是常态，静默跳过；权威 WARN 在收尾那一条）。⚠️ 收窄厂商对象时**方法必须经原始对象原地调用**：把 `subscribe` 摘进新对象再调会丢 `this` 绑定，SDK 内部实例字段读不到、订阅当场抛 TypeError——这一档缺陷在不用 `this` 的假件上测不出来（共享假子会话 `createFakePiChildSession` 的 `subscribe` 真用 `this` 即为钉住它） |
| 收尾那一份子任务快照**沿用在飞派发记下的状态**（状态不许倒退） | 适配器侧的记账口径 | 后台档下总线只报得起 `started`（没有 `status` 字段），而收尾对账读的就是那条记录；只读它会把派发时已投出的 `running` 行覆盖成 `unknown`——与「从终态退回运行中」同类的倒退、方向相反。故 `Agent` 工具收尾快照里的状态记进派发记录、收尾快照沿用；两处都没有才是 `unknown` + `not-observed` |
| 子任务行的**三条投递通路**（派发那一刻 / `Agent` 工具收尾 / 收尾对账） | 骨架的「同一身份多次投递、后者是完整快照」约定 | 同一身份**逐字相同**的重发在收数器里挡掉 ⇒ 产物里每个 `subagentId` 只留一条行；收尾带来新事实（后台档下第一次拿到终态与用量）时照发。**派发那条**由 `deliverStartedSubagents` 在每个事件投影之后补发（总线报 `subagents:started` 而这次工具还没收尾时），认领判据是「总线描述与某次在飞派发的 `description` 逐字相同且唯一」——总线载荷没有工具调用 id，零条或多条一律不认领、不投并落一条点名 WARN；总线已报终态的身份不投（避免状态从终态退回运行中）。名字由**派发那一刻**定下（入参 `name`，退回那次派发的 `description`），收尾不再改用总线描述——各条通路的名字因此逐字一致，界面不会在收尾那一刻换标题 |
| 嵌套派发（子会话自己再派子智能体）不进父会话 | 厂商限制 | 扩展只给**顶层**发生命周期事件 ⇒ 子任务行的 `parentSubagentId` 恒 `null`，界面的层级永远只有一层 |
| MCP 观测格成立的前提是每台显式 `exposure: 'direct'` | 注入档位与判据绑定 | `direct` 档工具进 payload 的 `tools`（表里没有它 ⇒ 没起来）；`deferred` / `codemode` 只把服务器写进系统提示词、`hidden` 连段都没有——档位一改，「表里没有这一台」这条读法就跟着失真，故值域在类型上收成 `'direct'` |
| 成本不可用：上游不报成本，model 的四条费率全 0 只为让 SDK 的计价函数不炸 | 本仓不引入成本格 | `Usage.cost` 直接丢弃（删掉损失零个上游事实——usage 是上游报的、cost 是我们算的） |
| `maxTokens` 小时 anthropic 侧的档位会塌缩（预算被 `maxTokens - 1024` 夹住，medium 与 high 同值） | 厂商换算 | 两条 wire 的同一档不等价；逐档对照的夹具把 `maxOutputTokens` 给足，免得四档互相塌缩 |
| 模型不支持所选档位时 pi 夹到相邻档：不报错、也不回落成关闭 | 厂商行为 | 认不出的档名一律在本层换成**声明过**的缺省档并落一条点名 WARN（`PI_REASONING_EFFORTS` 同时是 metadata 的档位域）——厂商侧实测：`xhigh` 在 openai wire 上被抬成 `reasoning.effort: "max"`（升档），任意认不出的串在 openai 上落 `reasoning.effort: "none"`、anthropic 上落 `thinking: { type: 'disabled' }`（都等于**关闭**），两条路都不报错。`off` 不许在 `thinkingLevelMap` 里标 `null`（那会让「关闭」变成静默打开） |
| 候选内首次 `import` pi 另计 300–450 ms 与约 90 MB RSS | 运行期成本 | `timing.runScale` 记 `seconds`（秒级，没有子进程冷启动） |
| 参数不是合法 JSON 的工具调用，在块层与「模型真传了 `{}`」**不可区分** | 契约缺格（未闭合） | 厂商 1.3.0 在 `ToolCall` 上带 `argumentsError`（原文：*Set when the model's complete arguments text was not a valid JSON object. `arguments` is then `{}`. Describes the problem and includes the text the model sent*），而契约的 `tool-call` 块只有 `input` / `summary` / `payload` 三格可落（`payload` 是各族的结构化联合，不是自由文本）⇒ 今天那一格读成 `input: {}`，与「模型真的传了空对象」逐字同形；厂商原文只随整条原始消息进 `raw`（`events.jsonl` 里能读，界面上看不到）。闭合需要一个承载格（契约层决策），在此之前**如实登记**：块层给不出「参数解析失败」，要判它请读 `raw` 或该调用的工具结果（结果是 `isError`，正文里有厂商那句原因） |

## 相关链接

- 仓库内参考：`packages/server/agents/src/providers/pi/`——`index.ts`（装配与凭据投射）、`events.ts`（事件投影与计量）、`message.ts`（内容级归一）、`subagent-wire.ts`（子会话 wire 通道：注册表快照 / 订阅 / 排空）、`transcript.ts`（子会话转写 → 子任务消息，wire 的兜底）、`mcp.ts`（MCP 零文件注入与坏条目摘除）、`observer.ts`（请求侧取证）、`subagents.ts`（扩展取数）、`structured-output.ts`（strict 预检与结构化产出投影）
- 知识文章：[《四家横向对比》](/protocols/comparison)（结构化输出那一行按「谁保证形状」读）、[《消息规范》](/protocols/message-spec)、[《事件流》](/protocols/event-stream)、[《进程生命周期》](/protocols/process-lifecycle)、[《Provider 抽象与 run 入口》](/protocols/provider-run)、[《新增 SDK 接入流程》](/protocols/sdk-onboarding)（两条合法接法与上报口径）、[《MCP 配置》](/features/mcp-config)、[《技能配置》](/features/skills-config)
- 活文档：[Pi Coding Agent FAQ](/faq/pi)——按报错原文 grep（白名单静默滤工具、后台档子智能体、转写落点、真实家目录写入）
