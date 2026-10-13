# Pi Coding Agent 接入

## 定位

pi（`@earendil-works/pi-coding-agent`，配套 `@earendil-works/pi-ai`）是第四家厂商智能体，**进程内 SDK**：一行一次 `createAgentSession`，事件经 `session.subscribe` 回流，中途取消走 `session.abort()`。`protocolTypes` 是 `['openai', 'anthropic']`——协议决定 wire（`openai → openai-completions`、`anthropic → anthropic-messages`），两条都能收。派发能力由白名单装载的第三方扩展 `@tintinweb/pi-subagents` 提供。

## 形态与交互

- **装配序列**：`mkdir <configHome>/skills/<name>` → 物化全部 `SKILL.md` → `new DefaultResourceLoader({...})` → `reload()` → `ModelRuntime.create()` + `registerProvider()` → `createAgentSession()` → `bindExtensions({ mode: 'rpc' })`。顺序错了的两种表现都是静默的：技能写晚了装载器扫不到（这一行照跑、一条技能都没有），扩展在 `createAgentSession` 之后才 `reload()` 时 handler 注册上了却一次都不被调用。
- **凭据只有内存一条**：`InMemoryCredentialStore` + `modelsPath: null` + `SessionManager.inMemory()` + `SettingsManager.inMemory()`。provider 逐行自注册，id 由 `configHome` 派生（前 12 位十六进制）——`ModelRuntime` 的注册是**按 id 索引的全局表**，复用常量 id 会让并发两行互相改掉对方的 `baseUrl` / `apiKey`。
- **baseUrl 按 wire 分叉**（pi 不做任何归一化）：`openai-completions` 自己只追加 `/chat/completions` ⇒ 裸 host 补 `/v1`；`anthropic-messages` 由 `@anthropic-ai/sdk` 追加 `/v1/messages` ⇒ 尾部 `/v1` 剥掉。
- **档位映射**：本仓档位 → 会话级 `thinkingLevel`。`off` 在 openai wire 上**不发 `reasoning_effort` 键**、在 anthropic wire 上是 `thinking: { type: 'disabled' }`；`minimal/low/medium/high` 同名直传；`max` 靠模型上的显式映射（`thinkingLevelMap`）才可用，没有映射会被静默夹到 `high`。模型定义必须带 `reasoning: true` 与 `thinkingLevelMap`，否则档位域整体失效。
- **隔离序列**：`noExtensions: true` 挡住被测仓库 `.pi/extensions/*.ts` 的任意代码执行；`additionalExtensionPaths` 白名单装载子智能体扩展（**不受 `noExtensions` 管**）；`skillsOverride` 只留「本行白名单 ∪ `cwd` 之下的项目技能」、丢掉 HOME 锚定的发现结果。**刻意不设** `noContextFiles`（缺省才读得到被测仓库的 `AGENTS.md`）与 `noSkills`（它会把项目技能一起关掉）。装载器被兜底重建过时，扩展表断言放在兜底**之后**读。
- **MCP 零文件注入**：canonical 条目翻成 `createMcpExtension({ loadConfig })` 读的**内存对象**，不落任何 `mcp.json`——被测仓库的 `.pi/mcp.json` 因此连读都读不到（SDK 下那个项目信任开关对 MCP 是死的）。每台**显式**给 `exposure: 'direct'`：pi 的缺省档 `codemode` 下工具**只可调用、不声明**，模型侧看不到，观测格那条判据永不触发，且 `codemode` 还依赖一个我们没启用的扩展。首次 prompt 等 `direct` 档服务器 **10 s**（不是连接超时，超时之后照常重连）；坏条目在我们这一层**摘掉 + 日志 + 行照跑**（自给 `loadConfig` 绕过了 pi 自己的校验，而 pi 的姿态是「让这台失败」而不是「跳过它」）。行级观测格的判据通道是**厂商工具表**——`direct` 档下工具真的进请求，`payload.tools` 里有 `mcp__<名>__*` 才算装上（这一家把名字里非 `[A-Za-z0-9_]` 的字符改写成 `_`：配置名 `my-server` 出站就是 `mcp__my_server__echo`，判据两种形态都认，见[《MCP 配置》](/features/mcp-config)的失败判据一节）；这一家**没有**「每台一张状态表」那种东西，工具面就是最硬的证据。失败形态与 dsh 同档：**静默**（工具消失、会话照常跑完、无结构化错误）。**OAuth 登录不补**（与三家对齐）：需要登录的服务器回 401，落到 `needs sign-in` 那一格。它**可补、不构成未覆盖项**——公开包 `@earendil-works/pi-mcp/oauth` 自换 token 后交给 `createMcpExtension({ credentials })` 即可，不需要 patch 厂商包。
- **看门狗与释放**：`interrupt()` 走 SDK 的 `abort()`（毫秒级终结在途轮次，`cancelMidTurn: true`）；`dispose()` 恰好一次，**注销本行的 provider 注册**。追问（`continue`）**不新建会话**，释放仍只由首轮那一格负责。

## 数据与契约

- **轮次**＝一次模型往返：`turn_start` 上 +1（真机与助手 `message_end` 条数恒等，而它先到——按 `message_end` 数会让第 N+1 轮的增量帧落进第 N 轮那条消息里）。一次工具调用算两轮。
- **用量**：助手 `message_end.message.usage` 逐次往返累加（`reasoning` 是 `output` 的子集，不双计）；`cost` 丢弃（本仓没有成本格）。合计（`tokens` / `turns`）**含**子智能体那一份——主子自己的读数与子会话的读数覆盖面不相交，两份相加才是「这一行一共花了多少」。
- **时长**：助手消息自带 `timestamp`（厂商记的请求起点）与 `durationMs` ⇒ 时间跨度整格记 `source: 'vendor'`。`ttftMs` **恒为 `null`**（厂商不报首字时延，唯一测法是我们自己的第一帧——混两把尺子会让 `mergeTiming` 整格作废）。
- **思考正文与工具结果正文逐条进 `log`**：这是 `needsMessagesForReasoningEvidence: false` 成立的**前提**，不许在这两条上过滤、摘要化或截断。与之配套的是**增量帧绝不产事件**（只有 `message_update` 产内容消息）。
- **结束信号只有 `agent_settled`**：`agent_end` 之后还可能有 auto-retry、compaction 与排队输入（`steer` / `followUp`）。
- **失败只有一条通道**：`prompt()` **永不抛**，失败体现在助手消息的 `stopReason` / `errorMessage` 上（厂商给的是裸英文短句，转发前先翻成带 host 的中文原因）。
- **子任务**：派发工具（`Agent`）由第三方扩展 `@tintinweb/pi-subagents` 提供，按 `additionalExtensionPaths` 白名单装载（**不 import 它的 `dist/index.js`**：该包无入口字段且是 ESM-in-CJS）；扩展没装上 ⇒ **整行失败并点名包名与版本**（不许「声明支持、实际没装」）。身份 / 状态 / 用量经扩展事件总线（`pi.events` 的 `subagents:*`）到达；`Agent` 工具结果里那句 `Agent completed in …` 是给人看的排版文本，**不从中解析任何字段**（结构化 `details` 只作交叉核对，`turnCount` 只有它有 ⇒ 轮次取它）。只到顶层（`parentSubagentId` 恒 `null`）。
- **结构化输出**（原生通道，工具参数即权威 schema）：

  | 环节 | 做法 |
  |---|---|
  | 通道 | 自定义工具 `submit_result` + `constrainedSampling: { type: 'json_schema', strict: 'require' }`——pi 建请求时把这份 schema 交给 `makeStrictJsonSchema` 转成 strict 形态，作为工具参数出站并带 `strict: true`，形状由**厂商侧强制** |
  | 装配期预检 | 按两条 wire 的差集判调用方 schema 是否落在 strict 子集内；判不过 ⇒ **显式降级**（工具降 `strict: 'prefer'` + 骨架的填充层 + 修正轮），记 `false` 并落一条点名的 WARN。**不收窄 schema**——四家拿到的题目必须逐字相同 |
  | 两条铁律 | ① **永远把调用方原 schema 交给工具参数**：`makeStrictJsonSchema` **非幂等**（含可选对象 / 数组属性的 schema，其 strict 产物再喂一次会被拒），预归一化的代价是**整轮零出站请求**；② **把工具参数投影回最终答复**：产物落在工具参数里，而评分通路只读 `finalText` |
  | 修正轮 | 两条路都实现 `continue`（同一 `session` 再交一条用户消息）。原生通道有**条件性**：`ToolChoice` 只有 `auto / none`，模型完全可以用一段正文回答 |
  | `applied.structuredOutput` | **只有本轮答复确实来自被 strict 约束的工具参数**才为真。三种 `false` 分得开：① 降级档（`'prefer'`）的工具调用——参数照样投影进最终答复，但那一档没有厂商侧强制；② 模型没调工具、走正文；③ 调过之后某一轮（含修正轮）改走了正文。备选通路（`before_provider_request` 注 `response_format`）机制成立、能出站、网关 200，但**本机网关不兑现** ⇒ 只作软压力，**不得**上报成原生通道 |

- **两条 wire 的 `compat` 必须显式开**（`openai → supportsStrictMode`、`anthropic → supportsStrictTools`）：不开时 strict 工具声明拿不到支持，pi 把整轮判成配置错误——**零出站请求**、43 毫秒、`stopReason: 'error'`，`prompt()` 还不 reject。其余键（`store` / `stream_options` / `max_completion_tokens` / `developer` 角色 / `reasoning_effort`）本机网关全部接受，多开一格就是给「零覆盖」这条实测结论加一个没有依据的覆盖。

## wire 形态与事件

- **两条 wire 的端点**：`POST {base}/v1/chat/completions`（openai）、`POST {base}/v1/messages?beta=true`（anthropic）。
- **strict 工具的落点按 wire 分叉**：openai 在 `tools[].function.{strict,parameters}`、anthropic 在 `tools[].{strict,input_schema}`。判据读 `observer.ts` 的纯函数（两条 wire 一次遍历同时认），不另写一份解析。
- **事件全集**：`agent_start` → `turn_start` → `message_start/end`（system、user）→ `message_start`（assistant）→ `message_update`（`text_start` / `text_delta` / `thinking_delta` / `toolcall_delta`）→ `message_end`（assistant）→ `tool_execution_start` / `_update` / `_end` → `message_start/end`（toolResult）→ `turn_end` → … → `agent_end` → `agent_settled`。另有 `auto_retry_*`、`compaction_*`、`queue_update`、`entry_appended`、`bash_execution_update`、`session_info_changed`、`thinking_level_changed` 等会话级事件。
- **三档处置**：**产消息**（`message_update` / `message_end` 助手 / `tool_execution_end`）、**产事件 + 计量**（`turn_start` / `message_end` 助手 / `agent_settled`）、**其余（含未识别）** 一条保留原始负载的 `log`——什么都不丢，也不假装认识。
- **流式增量走 `wire`**：`session.subscribe` 的事件里就有逐字增量，不需要像 dsh 那样挂插件旁路（能力位 `streamingDeltaSource: 'wire'`）。
- **订阅先于提示词**：订阅在流的第一次迭代时建立，提示词在订阅之后才发出；收尾判据是「提示词落定 **且** 队列已排空」（它 resolve 之后队列里可能还有 `agent_settled` 之类）。
- **请求侧取证**：`before_provider_request` 的 payload 由观察者抓下来，技能装载档与工具表两条判据都读它（技能段条数与 MCP 工具名只在出站请求里）。

## 已知边界与取舍

| 边界 | 性质 | 处置与判据 |
|---|---|---|
| 结构化输出走**工具通道** ⇒ 本行的工具表比另三家多一件（`submit_result`） | 跨家可比性的已知解释变量 | 登记而不隐藏：另三家走各自的原生字段（cc 的 `outputFormat`、codex 的 `turn/start.outputSchema`）与填充层，pi 多一次工具声明；不启用 `codemode` / `tool_search` 是同一条「少一个与题目无关的解释变量」的口径 |
| 模型**可以不调用** `submit_result`（`ToolChoice` 只有 `auto / none`，pi 没有强制工具选择） | 通道的条件性 | 那一轮的最终答复来自正文，`applied.structuredOutput` 记 `false`——这一格记的是**方法**（形状由谁保证），不是结果；修正轮是唯一的兜底（骨架对所有给了 schema 的家统一跑） |
| provider 侧**是否真的施加了约束**判不出来 | 未证实 | 带 strict 与不带 strict 的可观测行为无可分辨差异（模型自己读懂了 schema 里的 `additionalProperties: false` 并拒绝违规），小 schema + 硬要求违规的压力测试下模型宁可不调工具；正面反证只在 `response_format` 那条路上拿到（注了 `strict: true` 仍吐出 schema 外字段）。**不许**把它写成既成事实 |
| strict 子集外的构造（`$ref` / `$defs` / `oneOf` 双方拒；`minItems ≥ 2` / `maxItems` / `minimum` 仅 anthropic 拒；手写 `anyOf` 可空对象双方拒） | 厂商方言 | 装配期预检拦下并显式降级；可空标量写 `type: ['string','null']`（两边都放行）。子集边界与逐条字段路径见 `packages/server/agents/src/providers/pi/structured-output.ts` |
| 子会话**继承主会话的模型与网关 / 密钥**（`subagentSource` 取 `wire` 的由来） | 扩展的取数方式 | 父会话的 `modelRegistry` 与 `modelRuntime` 原样传下去 ⇒ 子智能体打的是同一台网关，**不需要**配置文件 / 环境变量 / 宿主 CLI；子任务那几格因此是厂商侧真值而不是我们的推断。**唯一不继承的是 `agentDir`**（见下一行） |
| 子智能体的转写与 settings / memory / `subagents.json` 落**真实 `~/.pi`** | 厂商限制 | 子会话与扩展走 SDK 的**进程级**全局路径（`getAgentDir()` 只认 `PI_CODING_AGENT_DIR` 与 `~/.pi/agent`），装载器的 `agentDir` 那一格**管不到它们**——**并发 pi 行共享这一部分**。凡本仓自己起 pi 的 CLI 或它的扩展（探针 / 脚本 / 测试）一律先把 `PI_CODING_AGENT_DIR` 指到临时目录；只设 `agentDir` 不设这个变量的隔离是假隔离 |
| 派发能力整条来自第三方扩展；**模型也可以自己用 `bash` 拉起宿主 `pi` CLI 凑一个子智能体** | 观测面外 | 那条路径**不在我们的观测面内**：真机实测里子智能体真跑了、真交了报告，但本行 `subagentTurns: 0`、token 不进本行、事件流里一个字都没有——行上那几格只回答「经扩展派发的那些」。它同时是「模型会去宿主家目录翻凭据」的动机来源 |
| `Agent` 的 `run_in_background` **缺省 `true`**（派发即分离、工具立刻返回 ID） | 第三方默认值 | 默认路径下子智能体可能活过本行：两格分量记 `null`（**不填 0**）+ 一条点名 WARN，合计退回主会话口径——总线载荷没有 `turnCount`，后台档拿不到收尾值 |
| 后台档子智能体活过本行时，完成回调打旧 ctx 抛 `This extension ctx is stale after session replacement or reload.`，且是**未处理的 Promise 拒绝** | 第三方缺陷（未闭合） | 修在扩展侧（回调改从 `withSession` 拿新 ctx，或自己 catch 并降级成日志）；长驻服务下会掀进程。见 FAQ 条目 |
| 子智能体转写固定落共享 `os.tmpdir()/pi-subagents-<uid>/…` | 第三方缺陷（未闭合） | 不随行隔离：并发两行共享这一格，且它的清理不属于本行的释放序列。子智能体转写不作为本行产物、不进 `diff`、不进评分 |
| 子任务节点的**逐步骤正文**只从扩展写的逐 agent 转写文件取，且**只在收尾读一次** | 第三方旁路通道（子会话不在父会话的事件流里） | 唯一带正文的通道是 `<tmpdir>/pi-subagents-<uid>/<cwd 编码>/<会话 id>/tasks/<子任务 id>.output`（JSONL，扩展在 `turn_end` flush）。投影见 `transcript.ts`：转写的 `message` 与父会话 `message_end.message` 同构 ⇒ 复用既有的助手 / 工具结果归一，逐条盖 `subagentId` 与 `source: 'session-file'`，轮次取**该子会话自己**的模型往返序（与 claude 的 `SessionRoundIds` 同一条口径）。**路径由本行 `cwd` 与本会话 `sessionId` 拼出，不扫目录**——转写根是全机共享的，扫目录会让并发的两行互相认领对方的子任务。读不到记空 + 一条点名 WARN，**不改结论**。⚠️ 边上那两条候选通道取不到正文：扩展总线除 `started/completed/failed` 外只有身份与元数据，`tool_execution_update` 只有一行 spinner 文案（按帧动画频率刷） |
| 子任务行的**两条投递通路**（`Agent` 工具收尾 / 收尾对账） | 骨架的「同一身份多次投递、后者是完整快照」约定 | 同一身份**逐字相同**的重发在收数器里挡掉 ⇒ 产物里每个 `subagentId` 只留一条行；收尾带来新事实（后台档下第一次拿到终态与用量）时照发。名字由**派发那一刻**定下（模型给的 `name`，退回 `details.description`），收尾不再改用总线描述——两条通路的名字因此逐字一致，界面不会在收尾那一刻换标题 |
| 嵌套派发（子会话自己再派子智能体）不进父会话 | 厂商限制 | 扩展只给**顶层**发生命周期事件 ⇒ 子任务行的 `parentSubagentId` 恒 `null`，界面的层级永远只有一层 |
| MCP 观测格成立的前提是每台显式 `exposure: 'direct'` | 注入档位与判据绑定 | `direct` 档工具进 payload 的 `tools`（表里没有它 ⇒ 没起来）；`deferred` / `codemode` 只把服务器写进系统提示词、`hidden` 连段都没有——档位一改，「表里没有这一台」这条读法就跟着失真，故值域在类型上收成 `'direct'` |
| 成本不可用：上游不报成本，model 的四条费率全 0 只为让 SDK 的计价函数不炸 | 本仓不引入成本格 | `Usage.cost` 直接丢弃（删掉损失零个上游事实——usage 是上游报的、cost 是我们算的） |
| `maxTokens` 小时 anthropic 侧的档位会塌缩（预算被 `maxTokens - 1024` 夹住，medium 与 high 同值） | 厂商换算 | 两条 wire 的同一档不等价；逐档对照的夹具把 `maxOutputTokens` 给足，免得四档互相塌缩 |
| 模型不支持所选档位时 pi 夹到相邻档：不报错、也不回落成关闭 | 厂商行为 | `xhigh` 因此不在档位域里（有 `max` 映射时静默升档、没有时静默降档）；`off` 不许在 `thinkingLevelMap` 里标 `null`（那会让「关闭」变成静默打开） |
| 行内首次 `import` pi 另计 300–450 ms 与约 90 MB RSS | 运行期成本 | `timing.runScale` 记 `seconds`（秒级，没有子进程冷启动） |

## 相关链接

- 仓库内参考：`packages/server/agents/src/providers/pi/`——`index.ts`（装配与凭据投射）、`events.ts`（事件投影与计量）、`message.ts`（内容级归一）、`transcript.ts`（子会话转写 → 子任务消息）、`mcp.ts`（MCP 零文件注入与坏条目摘除）、`observer.ts`（请求侧取证）、`subagents.ts`（扩展取数）、`structured-output.ts`（strict 预检与结构化产出投影）
- 知识文章：[《四家横向对比》](/protocols/comparison)（结构化输出那一行按「谁保证形状」读）、[《消息规范》](/protocols/message-spec)、[《事件流》](/protocols/event-stream)、[《进程生命周期》](/protocols/process-lifecycle)、[《Provider 抽象与 run 入口》](/protocols/provider-run)、[《新增 SDK 接入流程》](/protocols/sdk-onboarding)（两条合法接法与上报口径）、[《MCP 配置》](/features/mcp-config)、[《技能配置》](/features/skills-config)
- 活文档：[Pi Coding Agent FAQ](/faq/pi)——按报错原文 grep（白名单静默滤工具、后台档子智能体、转写落点、真实家目录写入）
