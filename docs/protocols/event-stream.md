# 事件流

## 定位

每候选行的 `events.jsonl` 是**执行的唯一真相源**：追加写、按 `seq` 去重续订、可回放；`messages.jsonl` 是与之**并行、互不合并**的内容通道。**评分阶段另有自己的两份文件**（`judge-events.jsonl` / `judge-messages.jsonl`）：评审者是另一个会话，它的流水不进执行日志。行级事件 SSE 与消息 SSE 是两条独立长连接；run 级还有第三条信号流。快照与事件同源（`setRowStatus` 成对落「status 事件 + `run.json` 状态」）。

## 形态与交互

**`AgentEvent` 八型**与发射方：

| 事件 | 谁发 | 要点 |
|---|---|---|
| `status` | 编排层 | `EvalRowStatus` |
| `log` | 适配器 | 唯一带「给人看的一句话」的类型：`text` 原文照旧逐字进原始输出面板、`summary?` 缺格＝这条没有可说的事，两格不许互相顶替 |
| `vendor-system` | 适配器 | 六格（`tools` / `slashCommands` / `agents` / `mcpServers` / `permissionMode` / `outputStyle`），只在厂商真的投送了那行时才有；未识别厂商负载一律落 `log` 保留原始负载（唯一允许丢的是重复事件） |
| `usage` | 适配器 | 见「数据与契约」 |
| `diff-summary` / `score` / `error` | 编排层 | 评分智能体输出也进同一条流，`text` 带 `[评分智能体] ` 前缀（`summary` 不戴） |
| `end` | 编排层 | `exitReason` 契约是**开放字符串**（`z.string()`），现为七值两层（适配层 `completed` / `timed-out` / `canceled` / `error`，编排层 `interrupted` / `rescored` / `skipped`）⇒ 消费方按字符串原样渲染、不按四值穷举；**不在「原始输出」面板**（该面板只收 `type === 'log'`），落点是事件行与台账 |

**通道拓扑共六条**：run 级信号流 `GET /api/runs/events`（SSE，`event: run-updated` + `data: {"runId":"…"}`，打开即 `: ready`，响应头 `text/event-stream` + `no-cache` + `X-Accel-Buffering: no`——只带 `runId` 不载数据，驱动列表重验）；**行级**两条：事件流 `…/stream`（`events.jsonl` 的 SSE 扇出）、消息流 `…/messages/stream`（`messages.jsonl`）；**评分**两条：`…/judge/events/stream`、`…/judge/messages/stream`。四条的响应头与心跳口径逐字相同，`runtime = 'nodejs'`（总线是进程内的）。

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
- **`subagentTokens` / `subagentTurns` 三档**：整格缺席＝本条不带（保持上一份）；`null`＝有子智能体但没采到（**必须清掉旧值**）；`{0,0,0}` / `0`＝确实没有。两格恒有 `subagentTokens ≤ tokens`、`subagentTurns ≤ turns`；分量与合计**同刻成对交出**（只给分量会让「主会话＝合计−分量」算出负数）。读侧两行语义相反不许合并：`tokens` 的 `null` **保留上一份**、子份两格的显式 `null` **必须清掉**。
- **两文件分工**：`events.jsonl` 与 `messages.jsonl` 同行目录、互不合并——事件按 `seq` 去重与续订（行级），记录按 `mergeKey` / `subagentId` 覆盖累积（内容级）；`RowRecord` 两种载体 `{type:'message'}` 与 `{type:'subagent'}`；**四格计量不在 `messages.jsonl` 里**（走 `usage` 事件与 `EvalRow`）；一行都不产出时不建文件；每次尝试开始清空。读侧容忍坏行（只跳过该行并 WARN——`message-log.ts` 对坏行与 schema 不过各落一条「已跳过」WARN）。历史产物删除、不做读侧兼容；契约新增可选格例外——读侧把「键缺席」与显式 `null` 当同一件事。

## 状态机与时序

- **`seq`** 从 1 单调递增，用于去重与断线续订（`Last-Event-ID` 语义）；`at` 是**本项目**写入时间，不是厂商时间。

### 活动行词表（三家统一，`agents/src/activity.ts` 唯一实现）

| 场景 | 统一产出 | 规则 |
|---|---|---|
| 工具调用 | `调用工具 <名>：<参数摘要>` | 参数按优先级取第一个非空字符串：`command`→`file_path`→`path`→`job_id`→`query`→`pattern`→`description`→`url`→`prompt`；再取改动清单（`changes[].path`，≤2 全列、更多「前两个 等 N 个」）；再紧凑 JSON；解析不动原样。缺名或缺参句子照样成立（不留空冒号） |
| 计划/待办 | `更新计划：N 步` | 入参含 `todos` / `plan` / `steps` 任一数组即整体替换（先于参数优先级；空数组说「0 步」） |
| 工具报错 | `工具报错：<内容>` | 只在报错时播；**成功返回一律不播，非零退出码也不播**（非零退出多是探测正常返回，播了是噪音） |
| 子任务派发 | `已派发子任务：<名>` | 无名则不带冒号 |
| 子任务收场 | `子任务已完成 / 失败 / 已停止：<名>` | `completed` / `failed` / `stopped` 三档；认不出的折「已结束」 |
| 模型答复 | 落 `log` **不带摘要** | 正文本身就是人话，`activityOf` 直取 `text` |
| **不播** | 工具成功返回 · 推理正文 · 轮次播报 · 未识别信封 | 证据照落盘（结果块 / 思考块 / 轮次格 / 原始输出面板） |

配套口径：`ACTIVITY_SUMMARY_MAX_LENGTH = 120`（前缀如「调用工具 `pwsh`：」不计入）；一律单行化后截断；`summary` 优先、无则回落 `text`，但都要过「不像机器负载」闸（整串 JSON 对象/数组或「`[标签]`+JSON」⇒ 挡下保留上一句）；一致性守卫 `activity-conformance.test.ts` 钉「同一件事三家逐字同一句 + 该沉默的一起沉默」，差异只允许出现在厂商自己的名字上。

**活动行的打字态（用户口径）**：卡片底部那一行有两档，按「是否有实时正文」分：

| 档 | 判据 | 渲染 |
|---|---|---|
| 打字态 | 运行态 + `useRunActivity` 折出的 `text` 非空，且**不是机器负载** | **最后一个非空段**（按 `\n` 切段：换行即清空重打）+ 还在写（`assembly === 'open'`）时挂 `▍` 闪烁光标；类名 `aieval-activity-typing`，换段靠 `key={段号}` 重挂那个 `span` 触发入场动画 |
| 静态档 | 有工具块 ⇒ 用它的 `summary`；否则 `log.summary`；再否则状态回落文案 | 一行文本 + `aieval-activity-sweep` 高光扫过 |

三条配套口径：① **实时优先、历史兜底**——实时那条记录流用 `?replay=0`（不回放），刷新页面它拿不到东西，于是回落到 `log.summary`（那条流有历史）；② 工具摘要**随消息块**给出（`tool-call.summary`，词表真源仍是 `activity.ts`，见《消息规范》），浏览器不重算；③ 打字文本不含推理与工具结果，候选 / 评分两阶段由 `useRunActivity` 按行状态**择一条流**（`judging` 看评分那条）。守卫落点：`agent-activity-line.test.tsx`（切段与分档）、`run-activity.test.tsx`（择流与 `?replay=0`）、`global-styles.test.ts`（类名 × CSS × 关键帧）。

**候选阶段的打字档多于评分阶段**：一次长回复会产生数千条增量帧；而评分阶段的增量几乎全是 thinking 流（非空正文极少），落盘的评分消息里正文只有最后那条评分结果 JSON，候选那侧的快照约四成含正文（逐字增量不落盘，只能在运行期订阅）⇒ **打字档主要发生在候选阶段**，评分阶段多数时间落在工具摘要那一档。这也是那条「机器负载」闸的由来：评分结果的 JSON 若不过闸，会被逐字滚到卡片上。
- **事件流与消息流生命周期不同**：事件流在终态帧后自行关闭；消息流保持打开（靠终态关流会让「打开一个跑完的行的对话视图」立刻断连，而那份历史正是要看的东西）。消息流**没有 `Last-Event-ID` 续订**（记录无单调序号）：每次连接回放全量折叠视图，客户端按 `mergeKey` 覆盖累积，重放幂等 ⇒ **SSE 帧不带 `id:` 帧头**（带了浏览器重连会带一个解释不了的值，表现为重连后少一段历史且不报错）。
- **只有 `resetEvents` 会清空**，唯一调用点是候选阶段开始新尝试（`runRowAttempt`）；重新评分**追加**事件、不递增 `attempts`。服务重启时把仍处 `running` / `preparing` / `judging` 的行标记 `interrupted`。
- **实时链路**：runs 列表走「信号驱动重验」——`saveRun` 落盘即推 `run-updated`（毫秒级）；`/api/runs` 与 `/api/runs/{id}` 只在状态翻转时被调用、有活在跑时至多 60 秒一次慢兜底。行级实时指标（token 累计 / 轮次 / 耗时）走 `useRunLiveMetrics` 为在跑的行各开一条连接；日志那一路只在该行抽屉打开时订阅。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `usage` 去重判据不含 `tokensBasis` 之外的 `reasoningOutput` / `total`（「只有思考 token 变了」的新值发不出去） | 先改实现再补守卫；未改前如实登记 |
| codex「有子线程没报用量」一档代码与口径表不一致：分量判 `null` 但 `finalTurns` 照算、合计照样交 ⇒ `subagentTurns: null` 与 `turns: <全树>` 同时落快照 | **未裁决项**：要么合计也 `null`、要么改口径表承认「合计可全树、分量未知」 |
| `{0,0,0}` 的正确文案「本次未观察到子智能体」与「未启用联网」**当前无落点** | 属界面文案缺口，不写成已有行为 |
| 活动行「计划更新」档只有单测（真机模型没调过 `update_plan`）；`subAgentActivity` 与 MCP / 联网 / 动态工具的 `item/started` 无真机样本 | 只有合成夹具；出现「上游只发 `item/completed`」同型问题时按既有判据同型修法处理 |
| codex 真机抓包重放守卫直接 `readFileSync` 本地 dump（`probe/dumps/` 已 gitignore）⇒ 干净克隆下 ENOENT | 只在带 dump 的机器上可复现 |
| run 级信号不覆盖删除（删除不落盘、无信号点） | 需要时另行加 |
| claude 转录读取静默跳过半截行 / 坏行：无逐行 WARN、无坏行计数 | 补观测的话收尾落一条汇总 WARN；补之前不按「有 WARN」排障 |
| `agents/src` 禁目录扫描 API（`/\breaddir(Sync)?\s*\(/`），唯一豁免＝claude 转录目录枚举 | 硬约束；新增豁免必须显式登记 |
| 增量帧**只广播不落盘** ⇒ 被中断的块没有快照，那段半截正文刷新后不可见 | **已认领的代价**（用户口径）；事后唯一痕迹是行快照的 `EvalRow.streamingDelta`（缺席＝没观测 / `0`＝观测到零帧 / `>0`＝有增量，`lastFrameChars` 回答「写到哪」），环境抽屉的「实测统计」组按它渲染 |
| 增量不产事件这条口径的守卫 | 一致性套件要求喂了增量帧的场景**必须声明事件条数**，三家夹具**收真事件**——夹具若把 `events` 恒填 `[]`，这条守卫在真漏增量的那一家上永远不可能红 |
| 评分阶段的 `log` / `vendor-system` **不进执行日志**（用户口径「与执行日志分开」） | **有意的**：执行日志只讲候选做了什么。代价如实登记——这些原始输出在当前界面**没有落点**（活动行只取一句话，抽屉只画候选那条流），排障要直接读 `judge-events.jsonl`；`…/judge/events` 两条路由已备好，接界面是后续动作 |
| 评分 `usage` 落在 `judge-events.jsonl`（行级流里收不到） | 行为等价：卡片那几格本来就按 `candidateEnded` **冻结**、不收评审者的用量，「评分 usage 冒充候选读数」那条特判因此没有输入源。`stepLiveState` 的注释里留着那条判据（老数据仍可能带） |
| 打字态只有「最后一个非空段」这一档，长段仍会被单行省略号截断 | 口径如此（活动行是一位高，换行会把卡片撑高、把按钮挤出视口）；全量内容在读日志的地方 |

## 相关链接

- 活文档：`packages/server/agents/README.md`——§5.3 事件流（`onEvent` 收到什么）、§5.2 停止与释放、§9 常见坑
- 知识文章：[《消息规范》](/protocols/message-spec)（姊妹篇，双流分工的另一半）、《进程生命周期》（终态事件从哪来、interrupt 后的收敛）、《行执行与日志》（抽屉与原始输出面板的消费侧）、《数据与存储》（`events.jsonl` 落盘与原子写）、《评分》（`score` 事件与前缀）
