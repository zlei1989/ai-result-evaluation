# 事件流

## 定位

每候选行的 `events.jsonl` 是**执行的唯一真相源**：追加写、按 `seq` 去重续订、可回放；`messages.jsonl` 是与之**并行、互不合并**的内容通道。**评分阶段另有自己的两份文件**（`judge-events.jsonl` / `judge-messages.jsonl`）：评审者是另一个会话，它的流水不进执行日志。行级事件 SSE 与消息 SSE 是两条独立长连接；run 级还有第三条信号流。快照与事件同源（`setRowStatus` 成对落「status 事件 + `run.json` 状态」）。

## 形态与交互

**`AgentEvent` 九型**与发射方：

| 事件 | 谁发 | 要点 |
|---|---|---|
| `status` | 编排层 | `EvalRowStatus` |
| `log` | 适配器 | 唯一带「给人看的一句话」的类型：`text` 原文照旧逐字进原始输出面板、`summary?` 缺格＝这条没有可说的事，两格不许互相顶替 |
| `vendor-system` | 适配器 | 七格（`tools` / `slashCommands` / `agents` / `mcpServers` / `mcpChannel` / `permissionMode` / `outputStyle`，外加**可选**的 `skills`），只在厂商真的投送了那行时才有；未识别厂商负载一律落 `log` 保留原始负载（唯一允许丢的是重复事件） |
| `usage` | 适配器 | 见「数据与契约」 |
| `diff-summary` / `ask-user` / `score` / `error` | 编排层 | `score` 载 `ScoreResult`、`error` 载行级失败归因；`ask-user` 是一次提问的**收场**记录（收场方式 / 等待时长 / 提问工具来源），与消息账本 answer 那一半共用 `askId` / `callId`（见[《提问与应答》](/features/ask-user-answer)）。评审者自己的流水**不进这条流**（落 `judge-events.jsonl`，见下「分流判据」） |
| `end` | 编排层 | `exitReason` 契约是**开放字符串**（`z.string()`），现为七值两层（适配层 `completed` / `timed-out` / `canceled` / `error`，编排层 `interrupted` / `rescored` / `skipped`）⇒ 消费方按字符串原样渲染、不按四值穷举；**不在「原始输出」面板**（该面板只收 `type === 'log'`），落点是事件行与台账 |

**通道拓扑共六条**：run 级信号流 `GET /api/runs/events`（SSE，`event: run-updated` + `data: {"runId":"…"}`，打开即 `: ready`，响应头 `text/event-stream` + `no-cache` + `X-Accel-Buffering: no`——只带 `runId` 不载数据，驱动列表重验）；**待答清单**一条：信号流 `GET /api/ask-user/stream`（`event: ask-user-changed` + 一行**空的** `data:`，**无 `id:`**——待答内容由 `GET /api/ask-user` 快照给，`event.data` 是空串；那行 `data:` 不是可有可无的装饰：SSE 规范里没有 `data` 字段的块不派发任何事件，省掉它订阅端零交付）；**行级**两条：事件流 `…/stream`（`events.jsonl` 的 SSE 扇出）、消息流 `…/messages/stream`（`messages.jsonl`）；**评分**两条：`…/judge/events/stream`、`…/judge/messages/stream`。除待答那条外的五条响应头与心跳口径逐字相同，`runtime = 'nodejs'`（总线是进程内的）。

**分流判据是「产出者」不是事件类型**：评分那次 `run()` 交出来的事件与消息（`log` / `usage` / `vendor-system` / `error` / `AgentMessage` / 子任务行）全部走 `judge-*` 两份文件；编排层自己发的行级事件（`setRowStatus`、降级留痕、终止留痕、`score`）仍走 `events.jsonl`。两条流的 `seq` **各自一套**（`appendEvent` 按文件续号）⇒ 续订游标不许跨流复用；重跑 / 重评时两份评分产物与候选那两份**同一条清空口径**（`resetEvents` + `resetRecords`）。

**`?replay=0`**：记录流的「只校验行存在、不回放历史」档，给卡片活动行那条连接用——它要的是「此刻在打字的那一句」，而历史里没有增量（delta 不落盘），为一句文案把 4 MB 的`messages.jsonl` 搬过 socket 是纯浪费。校验照样在开流之前（省掉它，客户端拿到的就是一条「开了即静默」的连接，而不是带原因的 404）。

**消息流的出口合并（唯一一处「故意不发某条记录」）**：增量帧是**累积值**（每条都带「到现在为止的完整块列表」，见《消息规范》），一段 n 个 token 的回复按 token 发帧 = 第 k 帧重发前 k 个 token ⇒ 总字节 **O(n²)**，而这些中间态在客户端**注定被后一条覆盖**（折叠只留最后一条）⇒ 逐帧发出去是纯浪费（序列化、socket、浏览器事件循环三处付账，真机症状就是「浏览器卡死」）。故 `messages-stream.ts` 的 `createDeltaCoalescer` 按 `mergeKey` 在 **16ms 窗口**（对齐浏览器一帧）内只留最后一条：

- **只合并 `chunk === 'delta'`**：快照与子任务行一条都不许丢、也不许延迟——非增量记录是**屏障**，一到就先把待发增量冲出去，**顺序逐字不变**（增量排到快照后面会让界面从「已写完」退回半截）；
- **只丢被覆盖的中间态**：同一 `mergeKey` 的新帧覆盖旧帧才计数（`coalescedCount`），不同键各自留着；
- **窗口到点必发**：定时器不是「有流量才动」，否则静默 16ms 后最后一条永远发不出去、光标停在半路；
- **观测**：断连时一条 DEBUG（`AIEVAL_DEBUG=1`）给 `frames` / `bytes` / `coalesced` 三个数——排查「卡死」的第一手判据就是它们（不落 WARN，不落盘）；
- **契约不动**：这条合并是**传输层**的，`MessageAssembler` 的「帧即累积」保证与消费方的 last-wins 折叠一个字都没改（改契约去换传输收益是把两件事绑在一起）。

## 数据与契约

- **`usage` 事件**：必填只有 `turns`；`tokens` / `timing` / `subagentTokens` / `subagentTurns` / `turn` 可空。**发射门槛是轮次不是 token**（轮次一到就发，token 采不到不停发轮次）。`tokensBasis: 'reported' | 'estimated'`——**只有 `'reported'` 才回写行快照**（编排层只认显式 `'reported'`，缺格老事件按 `'estimated'`，安全侧）；它只描述 `tokens` 那一格，`turns` 与两格分量恒回写。去重判据必须含 `tokensBasis`（数值相同而「估算→权威」仍是真实变化）。
- **`vendor-system` 各格可空，`skills` 还多一档「整格缺席」**：`null` = 这一格厂商没投送到我们能读的通道（`not-exposed`）、`[]` = 采到了确实是空的——两者在界面上是两句不同的话。`skills` 那一格是**可选格**（早期落盘的事件里没有它，写成必填会让那些历史行整行解析失败），消费方把它当「缺席 = 未观测」，与 `null` / `[]` 分得开。**采不到时另有一条点名的 WARN**：「厂商没报」与「我们没读到」在事件流里长得一样，不许把后者写成前者还不留痕。逐条形状是 `{ name, source, path, origin }`——`origin` 由采集它的适配器判（那一层同时知道行配置目录与工作目录），界面只按标签表渲染。它回答「**厂商当时说它手里有哪几条**」，与行级 `EvalRow.skillInstall`（我们装的哪几条、凭什么）是两件事，见[《技能配置》](/features/skills-config)。
- **`subagentTokens` / `subagentTurns` 三档**：整格缺席＝本条不带（保持上一份）；`null`＝有子智能体但没采到（**必须清掉旧值**）；`{0,0,0}` / `0`＝确实没有。两格恒有 `subagentTokens ≤ tokens`、`subagentTurns ≤ turns`；分量与合计**同刻成对交出**（只给分量会让「主会话＝合计−分量」算出负数）。读侧两行语义相反不许合并：`tokens` 的 `null` **保留上一份**、子份两格的显式 `null` **必须清掉**。
- **两文件分工**：`events.jsonl` 与 `messages.jsonl` 同行目录、互不合并——事件按 `seq` 去重与续订（行级），记录按 `mergeKey` / `subagentId` 覆盖累积（内容级）；`RowRecord` 两种载体 `{type:'message'}` 与 `{type:'subagent'}`；**四格计量不在 `messages.jsonl` 里**（走 `usage` 事件与 `EvalRow`）；一行都不产出时不建文件；每次尝试开始清空。读侧容忍坏行（只跳过该行并 WARN——`message-log.ts` 对坏行与 schema 不过各落一条「已跳过」WARN）。历史产物删除、不做读侧兼容；契约新增可选格例外——读侧把「键缺席」与显式 `null` 当同一件事。

## 状态机与时序

- **`seq`** 从 1 单调递增，用于去重与断线续订（`Last-Event-ID` 语义）；`at` 是**本项目**写入时间，不是厂商时间。
- **续订游标只在同一世代内有意义**（世代 ＝ 一次尝试的日志）：`resetEvents` 删文件之后 `seq` 又从 1 起，而客户端手里的 `afterSeq` / `Last-Event-ID` 是上一代的最大号。服务端两侧都按**「游标超过当前水位即上一代」**认换代——续订入口把这种游标当 0（从头回放），实时去重闸门把它的 `lastSeq` 重新起算。少了前者，重连拿不到新一代的历史；少了后者，一直开着的那条连接会把新一代的 `1..k` 整段吃掉（连接活着、心跳照发，客户端因此看不出任何异常，界面上只是「执行日志一条都不动」）。
- **换代不靠「看到 `seq` 回到 1」**：那个信号在 SSE 续订下不可达——游标停在上一代时，新一代的头几条根本过不了服务端那道去重闸门；而同一代的 `seq 1` 又会被回放与 `/log` 两条来源各投一次（投两次≠换代）。客户端侧的主判据是**「这一次尝试」标识**（runs 页把行的 `attempts` 传给 `useRowStream`、进 effect 依赖，表见上一条），`restarts` 那套 `seq` 判据只兜两条路：**同一代的重叠投递**（`at` / `type` 逐字相同 ⇒ 不清空）与「浏览器自动重连后拿到更小 seq」。行在跑的那两条流（`useRunLiveMetrics` / `useRunActivity`）不需要这一格：它们的连接集合与依赖键只含在跑的行，重跑时本身就变。

### 活动行词表（四家统一，`agents/src/activity.ts` 唯一实现）

| 场景 | 统一产出 | 规则 |
|---|---|---|
| 工具调用 | `调用工具 <名>：<参数摘要>` | 参数按优先级取第一个非空字符串：`command`→`file_path`→`path`→`job_id`→`query`→`pattern`→`description`→`url`→`prompt`；再取改动清单（`changes[].path`，≤2 全列、更多「前两个 等 N 个」）；再紧凑 JSON；解析不动原样。缺名或缺参句子照样成立（不留空冒号） |
| 计划/待办 | `更新计划：N 步` | 入参含 `todos` / `plan` / `steps` 任一数组即整体替换（先于参数优先级；空数组说「0 步」） |
| 工具报错 | `工具报错：<内容>` | 只在报错时播；**成功返回一律不播，非零退出码也不播**（非零退出多是探测正常返回，播了是噪音） |
| 子任务派发 | `已派发子任务：<名>` | 无名则不带冒号 |
| 子任务收场 | `子任务已完成 / 失败 / 已停止：<名>` | `completed` / `failed` / `stopped` 三档；认不出的折「已结束」 |
| 模型答复 | 落 `log` **不带摘要** | 正文本身就是人话，`activityOf` 直取 `text` |
| **不播** | 工具成功返回 · 推理正文 · 轮次播报 · 未识别信封 | 证据照落盘（结果块 / 思考块 / 轮次格 / 原始输出面板） |

配套口径：`ACTIVITY_SUMMARY_MAX_LENGTH = 120`（前缀如「调用工具 `pwsh`：」不计入）；一律单行化后截断；`summary` 优先、无则回落 `text`，但都要过「不像机器负载」闸（整串 JSON 对象/数组或「`[标签]`+JSON」⇒ 挡下保留上一句）；一致性守卫 `activity-conformance.test.ts` 钉「同一件事四家逐字同一句 + 该沉默的一起沉默」，差异只允许出现在厂商自己的名字上。

**活动行的打字态（用户口径）**：卡片底部那一行有两档，按「是否有实时正文」分：

| 档 | 判据 | 渲染 |
|---|---|---|
| 打字态 | 运行态 + `useRunActivity` 折出的 `text` 非空，且**不是机器负载** | **最后一个非空段**（按 `\n` 切段：换行即清空重打）+ 还在写（`assembly === 'open'`）时挂 `▍` 闪烁光标；类名 `aieval-activity-typing`，换段靠 `key={段号}` 重挂那个 `span` 触发入场动画 |
| 静态档 | 有工具块 ⇒ 用它的 `summary`；否则 `log.summary`；再否则状态回落文案 | 一行文本 + `aieval-activity-sweep` 高光扫过 |

三条配套口径：① **实时优先、历史兜底**——实时那条记录流用 `?replay=0`（不回放），刷新页面它拿不到东西，于是回落到 `log.summary`（那条流有历史）；② 工具摘要**随消息块**给出（`tool-call.summary`，词表真源仍是 `activity.ts`，见《消息规范》），浏览器不重算；③ 打字文本不含推理与工具结果，候选 / 评分两阶段由 `useRunActivity` 按行状态**择一条流**（`judging` 看评分那条）。守卫落点：`agent-activity-line.test.tsx`（切段与分档）、`run-activity.test.tsx`（择流与 `?replay=0`）、`global-styles.test.ts`（类名 × CSS × 关键帧）。

**候选阶段的打字档多于评分阶段**：一次长回复会产生数千条增量帧；而评分阶段的增量几乎全是 thinking 流（非空正文极少），落盘的评分消息里正文只有最后那条评分结果 JSON，候选那侧的快照约四成含正文（逐字增量不落盘，只能在运行期订阅）⇒ **打字档主要发生在候选阶段**，评分阶段多数时间落在工具摘要那一档。这也是那条「机器负载」闸的由来：评分结果的 JSON 若不过闸，会被逐字滚到卡片上。
- **关流只认「历史末尾」的终态，回放路上遇到终态不关**：同一份 `events.jsonl` 里会出现**多个**终态事件——一次追问（`judged` → 追问那一段 → `judged` → `end`）、一次重新评分（追加 `judging` / `judged`）都会这样。回放若在第一个终态处 `close()`，**它之后的历史整段扣在服务端**：真机症状是「追问那一段的事件永远到不了、用量里程碑停在首段最后那条读数上、最后一条消息上没有用量」。判据因此是两条：回放期间**不关**；回放完**看末尾**——末尾是终态才关流（不订阅、不起心跳，`connected` 徽标回到「未连接」），否则挂总线继续推。
- **客户端那一侧：「换代」的判据是内容，不是「看到了 `seq 1`」**：SSE 续订与 `/log` 全量在边界上天然重叠——打开抽屉的顺序是「先 `/log` 拿全量（里面有 `seq 1`），再从游标 0 逐帧回放同一份历史」，回放的第一帧又是 `seq 1`。按「只要出现 1 就换代」判，这一帧会把刚拿到的全量**整批清掉**（去重表也跟着重置），此后只能靠回放一条条重新攒（症状同样是「历史比服务端给的少一段」）。判据取 `at` + `type`：同一条事件两处逐字相同 ⇒ 重复投递；换代后 `at` 必然不同（两代之间隔着一整轮）。判据必须在去重**之前**看——新一代的 `1..k` 与上一代同号，去重表会把它们全吃掉。守卫：`row-stream.test.tsx`「SSE 回放的第一帧是同一条 `seq 1`（与 /log 重叠）⇒ 不换代、不清空已收到的历史」与「同一行重跑（seq 从 1 重新开始）时按新一代重置去重」两条互为反面。
- **只有 `resetEvents` 会清空**，唯一调用点是候选阶段开始新尝试（`runRowAttempt`）；重新评分**追加**事件、不递增 `attempts`。清空即换代——续订游标只在这一代内有意义（见「状态机与时序」的世代口径）。服务重启时把仍处 `running` / `preparing` / `judging` 的行标记 `interrupted`。
- **实时链路**：runs 列表走「信号驱动重验」——`saveRun` 落盘即推 `run-updated`（毫秒级）；`/api/runs` 与 `/api/runs/{id}` 只在状态翻转时被调用、有活在跑时至多 60 秒一次慢兜底。行级实时指标（token 累计 / 轮次 / 耗时）走 `useRunLiveMetrics` 为在跑的行各开一条连接；日志那一路只在该行抽屉打开时订阅。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `usage` 去重判据不含 `tokensBasis` 之外的 `reasoningOutput` / `total`（「只有思考 token 变了」的新值发不出去） | 先改实现再补守卫；未改前如实登记 |
| codex「有子线程没报用量」一档代码与口径表不一致：分量判 `null` 但 `finalTurns` 照算、合计照样交 ⇒ `subagentTurns: null` 与 `turns: <全树>` 同时落快照 | **未裁决项**：要么合计也 `null`、要么改口径表承认「合计可全树、分量未知」 |
| `{0,0,0}` 的正确文案「本次未观察到子智能体」与「未启用联网」**当前无落点** | 属界面文案缺口，不写成已有行为 |
| 活动行「计划更新」档只有单测（真机模型没调过 `update_plan`）；**`subAgentActivity` 由「多智能体 v2」工具面触发**（真机读数）：`features.multi_agent_v2 = true`（或 `[features.multi_agent_v2] enabled = true`）⇒ 工具表从 `multi_agent_v1[5]` 变成 `collaboration[6]`（`spawn_agent` 多一个**必填** `task_name`），派发时投 `subAgentActivity{kind:'started'}` 与 `{kind:'completed'}`（带 `agentPath:"/root/<task_name>"` / `agentThreadId`），**且不再有 `collabAgentToolCall`**。⚠️ **只给 `[features.multi_agent_v2]` 配置表而不写 `enabled` 仍是 v1**（这一格最容易踩：配置表在、开关没开，读数就恒 0）；`multiAgentMode:'proactive'` / `collaborationMode` / `reasoningEffort:'ultra'` **都不是开关**。⚠️ **隐患**：v2 下「派发」那一句事件**没人播** —— `events.ts` 的 `subagentActivityDrafts` 只对终态播，理由是「派发时已经播过」，而那个前提是 v1 的 `collabAgentToolCall`；v2 的派发只有 `started` 条目。本仓产品路径今天打不开 v2（`buildCodexConfig` 不写 features）⇒ 是**未来隐患**，不是现网缺陷。
  **三条实测边界**：① **嵌套派不出来** —— v2 子线程的工具表只有 8 件、**没有 `collaboration` 命名空间**（主线程 9 件含 `collaboration[6]`），三档配置（缺省 / 表形态 / `[orchestrator] max_depth`）逐字相同，硬调回 `unsupported call: spawn_agent` ⇒ `agentPath` 的 `/root/<父>/<子>` 这种嵌套形态**未能实测**；② **子线程失败时只有 `started`、没有终态**（400 与 500 两档都是这样；400 ⇒ 子线程 `turn/completed.status="failed"` + `codexErrorInfo:"other"` + `thread/status → systemError`，500 ⇒ 重试 10 次后停在 `active`）；③ **跨多轮不是每轮一对** —— 第二趟出的是 `interacted`（id = 那次 followup 的 call id）加第二个 `completed`，`started` **全程只有一条**；而跨轮的正路是主线程调 `followup_task`（往 v2 子线程直投 `thread/queue/add` 会被拒：`-32600 direct app-server input is not allowed for multi-agent v2 sub-agents`） | 只有合成夹具；出现「上游只发 `item/completed`」同型问题时按既有判据同型修法处理 |
| codex 真机抓包重放守卫直接 `readFileSync` 本地 dump（`probe/dumps/` 已 gitignore）⇒ 干净克隆下 ENOENT | 只在带 dump 的机器上可复现 |
| run 级信号不覆盖删除（删除不落盘、无信号点） | 需要时另行加 |
| claude 转录读取静默跳过半截行 / 坏行：无逐行 WARN、无坏行计数 | 补观测的话收尾落一条汇总 WARN；补之前不按「有 WARN」排障 |
| `agents/src` 禁目录扫描 API（`/\breaddir(Sync)?\s*\(/`），唯一豁免＝claude 转录目录枚举 | 硬约束；新增豁免必须显式登记 |
| 增量帧**只广播不落盘** ⇒ 被中断的块没有快照，那段半截正文刷新后不可见 | **已认领的代价**（用户口径）；事后唯一痕迹是行快照的 `EvalRow.streamingDelta`（缺席＝没观测 / `0`＝观测到零帧 / `>0`＝有增量，`lastFrameChars` 回答「写到哪」），环境抽屉的「实测统计」组按它渲染 |
| 增量不产事件这条口径的守卫 | 一致性套件要求喂了增量帧的场景**必须声明事件条数**，四家夹具**收真事件**——夹具若把 `events` 恒填 `[]`，这条守卫在真漏增量的那一家上永远不可能红 |
| 评分阶段的 `log` / `vendor-system` **不进执行日志**（用户口径「与执行日志分开」） | **有意的**：执行日志只讲候选做了什么。`log` 的原始输出已接界面（评分详情抽屉 footer 的「原始输出 N 条」二级抽屉，`…/judge/events` REST + SSE 两条路由的消费方，见《评分》）；`vendor-system` 与其余事件类型仍在界面外，排障读 `judge-events.jsonl` |
| 评分 `usage` 落在 `judge-events.jsonl`（行级流里收不到） | 行为等价：卡片那几格本来就按 `candidateEnded` **冻结**、不收评审者的用量，「评分 usage 冒充候选读数」那条特判因此没有输入源。`stepLiveState` 的注释里留着那条判据（老数据仍可能带） |
| 打字态只有「最后一个非空段」这一档，长段仍会被单行省略号截断 | 口径如此（活动行是一位高，换行会把卡片撑高、把按钮挤出视口）；全量内容在读日志的地方 |

## 相关链接

- 活文档：`packages/server/agents/README.md`——§5.3 事件流（`onEvent` 收到什么）、§5.2 停止、释放与静止超时、§9 常见坑
- 知识文章：[《消息规范》](/protocols/message-spec)（姊妹篇，双流分工的另一半）、《进程生命周期》（终态事件从哪来、interrupt 后的收敛）、《行执行与日志》（抽屉与原始输出面板的消费侧）、《数据与存储》（`events.jsonl` 落盘与原子写）、《评分》（`score` 事件与两条评分通路）、[《技能配置》](/features/skills-config)（`vendor-system.skills` 那一格的判据与三态）
