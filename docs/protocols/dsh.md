# DeepSeek Harness 接入

## 定位

DSH（`@deepseek-ai/dsh-sdk-client`，next 线 `0.2.0-rc.2`——R33 裁决不走 latest；该包从未发过非预发布版本，「稳定版」即 next 线最新 rc。与 `0.1.7-rc.1` 相比：客户端 `lib/` 逐字节相同，只有锁定的 runtime 0.1.7→0.2.0；真机双协议探针跑通含计量）是三家厂商里唯一「双协议一家」的智能体：`protocolTypes: ['openai', 'anthropic']`，两条 wire 统一走 pi-ai 路由。适配器 = 路由注入（overlay patch）+ 通知投影（`session.event`）+ 关闭式释放（SDK 无 wire-level cancel）。

## 形态与交互

- **SDK 入口形态**：`new DeepSeekHarness(options)` → `start()`（幂等 spawn + initialize 握手）→ `client.subscribeSessionTree(sessionId)` 拿通知流 → `run(prompt, { sessionId })`（下一次 idle 落定）。值出口 7 个（`DeepSeekHarness` / `HarnessClient` / `HarnessSession` / `JsonRpcResponseError` / `RequestTimeoutError` / `SdkProtocolError` / `TransportClosedError`）。
- **路由注入**：per-run overlay（`<configHome>/aieval-route.patch.yml`，经 `--patch <绝对路径>`——SDK 按**宿主进程 cwd** 解析相对路径，必须给绝对路径；`- id: llm-pi-ai` 定向覆盖）+ 子进程环境（`DSH_HOME`、`AIEVAL_ROUTE_API_KEY`、`DSH_PERMISSION_MODE`、**显式删除** `DEEPSEEK_*`——不显式删就会继承宿主，宿主有 key 时 `deepseek-official` 路由静默可用并悄悄计费）。
- **两条 wire**：`anthropic → anthropic-messages`（`POST {base}/v1/messages?beta=true`，`x-api-key` + `anthropic-version: 2023-06-01`）、`openai → openai-responses`（`POST {base}/v1/responses`，`Authorization: Bearer <key>`）。**不映射 chat-completions**（决策 D2）。
- **baseURL 归一化分叉是唯一正确解**：pi-ai 不做任何归一化（执行级证据）⇒ anthropic 剥尾部 `/v1`（`stripV1Suffix`）、openai 补 `/v1`（`ensureV1Suffix`）由适配器做；写反会出现 `/v1/v1/messages?beta=true`。
- **effort 档位**（七种全接受）：`off → thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`（**显式关闭**，不是不发字段）；`low / high / max` 原样（该网关七种 effort 全 200；「网关是否校验」是网关属性，换网关要重验）。anthropic 侧 `budget_tokens` 由档位名推（minimal 1024 / low 2048 / medium 8192 / high 16384，xhigh/max 夹到 high）且被 `model.maxTokens` 夹住。
- **停止通路**：`cancelMidTurn: false`——SDK 无 wire-level cancel（`HarnessClient.close()` JSDoc 逐字："There is no wire-level cancel: a timed-out request stays running server-side until the runtime is closed"）⇒ `interrupt()` 刻意空实现，终止走「等 5 秒宽限 → WARN → 强制关闭」（`RELEASE_GRACE_MS = 5_000`）。

## 数据与契约

- **协议集合判定**：`protocolTypes`（数组，替换旧单值字段——不留并存避免两份真源）+ 唯一判据 `acceptsProtocol(metadata, protocolType)`，四个消费点共用（api 创建校验 / api 候选池过滤 / 评分智能体校验 / 编排层复检）；拒绝文案抽成 `protocolMismatchMessage()`。不引入第三种 `ProtocolType`——供应商的 `protocolType` 仍是单值（协议是供应商的属性，集合是智能体的能力）。
- **通知外形**：`{method, params}`，method 只有四种：`session.event` / `session.status` / `subagent.started` / `subagent.finished`；事件全在 `session.event` 里，判别字段 `params.event.type`。事件序列：`turn/start → step/start → request/header → request/context → assistant/message → step/end → … → turn/end`；一次模型 API 往返 = 一个 step，轮次从 `step/start` 数。
- **失败通道**：`turn/end` 的 `reason.kind === 'error'`；`reason.error` 两种形状都要认——结构化 `{message, code:"TRANSPORT"}` 与纯字符串（`errorChain` 折成 `{message, code:'UNKNOWN'}`）——否则失败运行被投影成普通日志、骨架 `ok:true, completed`。
- **逐消息用量**（这家独有）：`assistant/message` 的 `data.usage.{inputTokens, cacheReadTokens, outputTokens}`（另有 `cacheWriteTokens?` / `totalTokens?`）进消息信封；claude / codex 构造点 `usage: null`。真机：23 条 message 里 16 条带 usage、7 条 null（全是 role:'tool'）——页脚与 wire 0 处不符。消息级不进任何合计；行级与消息级并存的差额来自流式中间帧与收尾投影（不带 usage 的投递）——不是对不上账。同一逻辑消息多次投递带的用量相同 ⇒ 合并器「带值覆盖、缺省保留」。
- **计量与计时**：`reasoningTokens` 恒 `null`（`llm-pi-ai` 的 `mapUsage()` 有意不投影，能力位 `not-projected-by-vendor`——不许拿 `outputTokens` 去凑）；`apiMs` / `ttftMs` 恒 `null`（载荷无时间字段，时间只在 `params.event.time`）⇒ `timing` 一律 `source:'events'` 且是累计口径。
- **子任务**：`agentId` 与 `childSessionId` 同值；名称 / 类型在 `subagent/catalog`；终态两格合读 `status`（ok/error）+ `stopReason`（五档）——取消是 `error + aborted`、截断是 `ok + max-tokens`，单读一个方向都会骗人。

## wire 形态与事件

- **既成口径：用量与轮次不按会话分叉**——事件投影只认 `event.type`、不按 `sessionId` 分流：`assistant/message` 无条件累进本行 usage、`step/start` 无条件 turns+1 ⇒ dsh 三格从第一天起就含子智能体，是构造上如此（有意并钉住）。分量（`subagentTokens` / `subagentTurns`）按本行子会话白名单求和；`dshSilentChildSessions` 是分量缺失谓词 + 收尾点名 WARN 的唯一判据。要改主 / 子两把尺子是另一次口径变更。
- **订阅先于提示词**：唯一事件通道是客户端订阅，`run()` 在下一次 idle 才落定；顺序错了丢开头那批事件（含 turn/start）⇒ 订阅由流自己建立，`start()` 不碰。
- **冷启动握手预算 60s**：SDK 默认 10s 不够（每行全新 configHome ⇒ 每次都冷启动，dsh 要解析整棵插件树才回 initialize；真机：空闲 4–7s 侥幸过、带负载两次超时，报错原文 `AGENT_FAILED  initialize timed out after 10000ms waiting for dsh profile "sdk"`）⇒ 显式 `DSH_INITIALIZE_TIMEOUT_MS = 60_000`。这类缺陷只有走真适配器的端到端能发现。
- **overlay 写入时序**：必须在 `new DeepSeekHarness(...)` 之前写好（dsh boot 时读装配清单；写晚了「run 结束后文件在」的用例照样绿而生产路由不存在）。
- **同源同算**（D7）：patch 里 `provider` / `model` / `reasoningEfforts` 与交给 harness 的三个值必须同源，dsh 的 `initialize` 会 `resolveCallConfig` 二次校验，漂移报 `UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT` / `no adapter registered for provider "…"`。路由键 `aieval-route` 不与 pi-ai@0.85.1 catalog 的 39 个键撞车 ⇒ 走手声明路径；404 重试走 harness 的 `llm/retry`（实测 ×5），pi-ai 自己 `maxRetries: 0`，不会双重重试。
- **skill 注入**（SDK 客户端零 skill API，但运行时默认全开——「给 dsh 加 skill」= 让运行时看见文件，落在配置层）：三条加法——**A** 落 `$DSH_HOME/skills/<name>/SKILL.md`（与每行 `.agenthome` 隔离天然同构）；**B** overlay 里 `skill-filesystem` 的 `customSkillDirs` + `includeDefaultRoots: false`（真隔离；⚠️ patch 替换整格 config 不深合并，要用的键必须全量重述）；**C** 项目根 `.dsh/skills/` / `.agents/skills/` 自动发现（rank 100/200——静默口径差异，与 claude 的 `.claude/skills/` 问题同源同形）。skill 根表 rank：100 project-dsh / 200 project-agents / 300 custom / 400 user-dsh / 500 user-agents / 600 bundled，rank 小者先赢同名，第一层扫描不递归。隔离约束：`dshHome` 指向空目录且无 `DEEPSEEK_API_KEY` 时运行必然 `turn/end(kind:'error')`（`llm-deepseek: no API key for provider route "deepseek-official"`）⇒ 走 pi-ai 后凭据走 `AIEVAL_ROUTE_API_KEY`，隔离目录不再隔离凭据。
- **MCP 接法**（本仓已落地）：SDK 的 JSON-RPC 方法表**封闭三个**（`initialize` / `session/prompt` / `shutdown`），服务端对未知方法直接抛错 ⇒ MCP **只能走配置文件**。一台 server = 一个插件行，**落点 = per-launch overlay（`<configHome>/aieval-route.patch.yml`）的 `insert`**——新增行必须走 `insert`（顶层 `- id:` 只能改或禁既有行）；`toDshMcpPluginLines` 一处翻译，空集一行都不插。逐字形状：`- id: mcp-<name>` / `name: "@deepseek-ai/dsh-mcp-client"` / `config: { serverName: "<我们的名字>", transport: stdio|streamable-http, command, args?, env? | url, headers? }`——`transport` 是 dsh 的两档（**不是** canonical 的 `http`），回包或请求里 http 的头**仍叫 `headers`**（与 claude 同、与 codex 的 `http_headers` 不同）。传输只有 `stdio` 与 `streamable-http`；`serverName` 须匹配 `[A-Za-z0-9_-]{1,32}`、`toolCallTimeoutMs` 默认 60000、`failOnStartupError` 默认 **false**（连接失败 harness 照常启动、工具静默消失）。stdio 子进程环境先清洗（`/KEY|PASSWORD|SECRET|TOKEN/i` 命中的与所有 `DSH_*` 被删）再合并 `config.env`——宿主的 `GITHUB_TOKEN` 不会自动传进去（这条也是验收项的检查点之一）。工具名 `mcp__<serverName>__<tool>`。
  - **判据只有工具表一条**：`request/header` 的 `data.header.tools` 里有 `mcp__<serverName>__*` ⇒ 已连上；表在、里面没有它 ⇒ **行失败**（`AGENT_MCP_UNAVAILABLE`）——这一家起不来时工具**静默**消失、会话照常跑完、没有任何结构化错误（`failOnStartupError` 真假在观察面上无差异），**所以判据取不到「厂商状态」那一格，只能取工具表**。适配器据此每个 step 投一条 `vendor-system`（`mcpChannel: 'vendor-tool-table'`，只在表变了的时候发、每次交全量）。
  - 配置面与完整边界（含行内 `.npmrc` 的 registry 注入、等待预算 ≥ 20 s）见[《MCP 配置》](/features/mcp-config)。
- **流式增量旁路**：通知层不投送逐字流（见「已知边界」），而打字机要 token 级增量 ⇒ 适配器**换一层拿**：`startDsh` 在 boot 前把一份零依赖插件写到 `<configHome>/profiles/sdk/aieval-stream-tap.mjs`（overlay `insert` 一条，`name: "./aieval-stream-tap.mjs"` 必须是**相对名**——loader 按 profile 目录解析），插件订阅 runtime 进程内的 `agent/assistant-stream`，把 `block-start` / `text-delta` / `reasoning-delta` / `block-end` 四类 chunk 帧追加写到 `<configHome>/aieval-stream-tap.jsonl`；父进程按 `DSH_STREAM_TAP_POLL_MS = 100` tail 该文件，折成 `session.event` 信封、事件类型 `aieval/delta`（`DSH_STREAM_DELTA_TYPE`）的伪通知，再由 `dshStreamDeltaDraft` 归一成 `chunk: 'delta'`、`source: 'hook'` 的内容消息。三条硬约束：① **绝不伪造 `session/event`**——runtime 对它是「先落厂商会话日志、再通知」，伪造型会混进厂商持久化日志（故走 sidecar 文件）；② 该支**只产消息、零事件草稿**（落进 `log` 兜底会把原始输出面板刷成 JSON 流水）；③ **会话门闸**——子会话的增量行可能早于 `subagent.started` 落盘，未登记的 sid 会被当主会话，故未知会话的伪通知**挂起**，等放行过 `subagent.started` 再补投。块位次按「该次尝试内首见顺序」发号（与厂商 `BlockAssembler.order` 同算法），保证增量与随后快照落进同一槽位。
- **内置工具清单**（24 项，`request/header` 原文顺序）：`create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill, job_list, job_output, list_agents, pwsh, read, read_image, send_message, skill, subagent, subagent_fork, todo_write, update_goal, web_fetch, web_search, workflow, write`。dsh ∩ codex = `create_goal / get_goal / update_goal / web_search`（精确同名）；claude 与另两家精确同名交集为空 ⇒ 命名不是对齐键。dsh 独有 `pwsh`（与 codex 的 `exec_command` 异名同义）。

## 已知边界与取舍

| 边界 | 性质 | 处置与判据 |
|---|---|---|
| `text-api.ts` 的 openai 分支仍打 `POST {base}/chat/completions`——非智能体评分通路用不了只讲 Responses 的网关 | 待裁决 | 由 `protocolTypes` 的声明侧收口；不在 dsh 适配器层修 |
| 版本偏斜：实跑 pi-ai@0.85.1，上游 O(n²) 修复打在 0.87.1 上打不到（实测 8KB→13.7ms、512KB→37.7s） | 已裁决可接受 | 代价是一次性 CPU 税非挂起；触发条件「大文件写入明显停顿」再启动三步预案；**不要只升版本**（`^0.85.1` 对 0.x 只允许 <0.86，会与 peer 校验打架） |
| 退役 `DEEPSEEK_*` 必须显式删除（不删则继承宿主 ⇒ `deepseek-official` 静默可用并计费） | 已修 | 守卫：宿主环境守卫用例（先塞假键再断言子进程环境里没有）——只断言「没注入」是假绿 |
| `web_search` 必然失败（`searchProvider: deepseek-official`，错误码 `WEB_PROVIDER_CREDENTIAL_MISSING`） | 已知 | 非新回归；要不要 overlay 关掉 tool-web 默认不动 |
| streamingDelta：厂商 LLM 层有 `text-delta` 但 SDK 订阅的**通知层**没有（真机 20 条通知、增量类 0 条） | 已修（换通道） | 通知层判定不变，**改从进程内事件取**：适配器往行 profile 目录写一个 tap 插件，它订阅 `agent/assistant-stream` 把 chunk 帧追加到 `<configHome>/aieval-stream-tap.jsonl`，父进程 100 ms tail 成 `aieval/delta` 伪通知 ⇒ 能力位 `yes` + `streamingDeltaSource: 'hook'`。**最值钱教训保留**：文档说的层 ≠ 我们能拿到的层——解法不是「厂商投送了」，而是**换一层拿**。代价与失效模式见《接入》「流式增量旁路」与《事件流》已知边界 |
| `session.status` 刻意不投影（与轮次语义无关，投影只添噪声） | 有意取舍 | 「已识别且有意不投影」，不是未识别 |
| `turn/end` 的 kind 实测只有 completed / error，类型面另有 aborted / blocked / max-tokens / interrupted / forked | 口径 | 按类型面写防未来 |
| MCP 重连预算耗尽后工具被注销且不再自动恢复（默认 10 次连续失败） | 厂商设计 | 停机期间工具仍列出但调用失败 |
| 改配置要重启运行时进程（sdk profile 的 bundle `hmr: disabled: true`） | 厂商设计 | — |
| 未跑真实评测任务（带工具调用、多轮、大文件写入）；skill 注入没有真机跑过 dsh | 未覆盖 | 如实登记证据层级 |
| 消费循环**把 `subscription.next()` 的 promise 遗弃成孤儿**（每 100 ms 的 `tapWake` 竞速输一次就留一个）⇒ SDK 按「先到先得」把后续每条通知都交给孤儿，真正在等的那一个永远拿不到 | 已修 | 症状：客户端投递并接受 **181 条**、我们只 `yield` **15 条**（全在前 50 ms），之后 137 秒静默且**零报错**；`messages.jsonl` 为 0、执行日志整段空白、行照旧判成功。修法：在飞的 promise **记忆化复用**（`pendingNext ??=`），settle 后才新建。守卫：`dsh/index.test.ts` 的「投递 150ms > 轮询拍 100ms」用例（夹具若只留一个 waiter，孤儿根本造不出来——替身比真实实现弱）。证据见 [DeepSeek Harness FAQ](/faq/deepseek-harness) 的 `原始输出 38164 行，但执行日志是空的` 条 |
| stream-tap 插件**从未被加载**：`name: "./aieval-stream-tap.mjs"` 由运行时按 **`dshHome`** 解析，而适配器写在 `profiles/sdk/` | 已修 | stderr 每次只有 `dsh: warning: 1 entry did not activate` + `aieval-stream-tap (file:///<dshHome>/aieval-stream-tap.mjs): failed to import` ⇒ 旁路文件恒 0 字节、能力位声称 `streamingDelta: yes` 而界面一条增量都没有。改 `DSH_STREAM_TAP_PLUGIN_RELATIVE_PATH = 'aieval-stream-tap.mjs'`；探针实证 stderr 干净、**旁路文件 0 → 720 字节**（`probe/v3/dsh-tap-truncation.mjs` 变体 B） |

## 相关链接

- 活文档：[DeepSeek Harness FAQ](/faq/deepseek-harness)——含「声明 streamingDelta=yes 但没有 delta 消息」条目（文档说的层 ≠ 能拿到的层）
- 仓库内参考：`packages/server/agents/README.md`——§4.4 能力查询的唯一入口、§5 各家差异、§10 术语对照（R33 在表里）
- 知识文章：[《Codex 接入》](/protocols/codex)、[《Claude Code 接入》](/protocols/claude-code)（对照面）、《Provider 抽象与 run 入口》（protocolTypes 是 metadata 一格）、[《消息规范》](/protocols/message-spec)（roundTrip=step 号）、《事件流》《进程生命周期》（interrupt 空实现与 5 秒宽限）、《三家横向对比》《评分》（D2b 归评分侧）
