# Provider 抽象与 run 入口

## 定位

`@aieval/agents` 的对外面只有一张 provider 注册表：`getProvider(kind).run(input)` 是调智能体的**唯一入口**——包外不许自己 spawn 厂商 CLI、不许深路径 import `providers/*`、也不许再包一层「跑一次」的门面。`run` 不够用就扩展 `run` 本身，不是绕开它。

## 形态与交互

**公共 API 一览**（`src/index.ts` 是唯一出口）：

| 导出 | 作用 |
|---|---|
| `getProvider(kind)` | 按 kind 解析适配器；未注册的 kind **抛裸 `Error`**（文案含可用清单）——没有 `ServiceError` 语义，直接冒到 HTTP 层会折成 500，读配置得到 kind 的地方要先判 `AGENT_KINDS` 枚举再解析 |
| `listAgentProviders()` | 全部适配器（**返回副本**）；顺序 = 前端下拉顺序，与 `AGENT_KINDS` 同序（有回归用例钉住） |
| `acceptsProtocol(metadata, protocol)` | 该家能不能收这条协议（读 `metadata.protocolTypes` 的**集合**）；表单过滤、创建校验、评分智能体校验与编排层复检四处都读它，**不许各写一份** |
| `protocolMismatchMessage(metadata, protocol)` | 协议不匹配时的中文文案（列出该家接受的**集合**而不是单值） |

`getProvider` 同步返回、不加载厂商 SDK（SDK 是函数作用域懒加载，第一次 `run()` 才 import）；返回注册表里的**同一个实例**。

**四家的实际能力值**（与 `registry.test.ts` 的期望表逐格一致，改动会红）：

| kind | displayName | protocolTypes | cancelMidTurn | usage |
|---|---|---|---|---|
| `cc` | Claude Code | `['anthropic']` | `true` | `true` |
| `codex` | Codex | `['openai']` | `true` | `true` |
| `dsh` | DeepSeek Harness | `['openai','anthropic']` | `false` | `true` |
| `pi` | Pi Coding Agent | `['openai','anthropic']` | `true` | `true` |

`metadata.capability` 只有 **`cancelMidTurn`**（`false` ⇒ 「终止」按钮在该候选退化为「关闭运行时」）与 **`usage`**（`false` ⇒ 界面显示「不支持计量」而不是 0）两格。**结构化输出不在这里**：它不是「这一家有没有这个能力」的静态声明，而是**每-run 的通道事实**（`applied.structuredOutput`），由适配器按本次运行上报——把它写成能力位等于让框架替厂商判降级，也会把「厂商这一轮没照做」误记成「这家没有这个能力」。

`metadata.messageCapability` 逐格声明「思考正文 / 工具入参 / 工具结果 / 子任务 / 流式增量」能不能拿到、从哪条通道拿、拿不到时为什么（`MissingReason` 四句：`not-supported` / `not-exposed` / `not-observed` / `unverified`），外加成立前提（`notes`）。

## 数据与契约

**`run(input)` 的调用契约（六条承诺）**：

| 承诺 | 说明 |
|---|---|
| **不抛** | 所有失败折进 `result.ok === false` + `result.error`；调用方不需要给每个候选套 try/catch（真违约抛了按「适配器违约」处置） |
| **不改宿主环境** | 绝不写 `process.env`——凭据进**替换型子进程环境**（以宿主为底、覆盖 `HOME` / `USERPROFILE` 与厂商变量后整体交给子进程；并行多行时往 `process.env` 塞会互相串凭据） |
| **不动 git** | 工作区与分支由编排层备好；适配器只在该目录里跑 |
| **不设内层上限** | 没有 `timeoutMs` 也没有 `maxTurns`：一次运行只会因「跑完 / 失败 / 外部要求停止 / 静止超时」结束。**总时长仍不限**——唯一的时限是 `watchdog` 的两级**静止**上限（见《进程生命周期》的「静止超时」） |
| **同步回调** | `onEvent` / `onMessage` / `onSubagent` 同步调用、不 await；回调抛错被吞掉并记 `logger.error`，**不改变**本次运行结论（受保护发射） |
| **提问回调可 await**（`onAskUser`，可选） | 与上面那三条**不是同一种形状**：它**必须 await**、允许阻塞本次运行，而且**会改变**本次运行结论——用户答了什么，模型就照什么干。**缺省不传这一格就一次都不调用**（行为与没有它之前逐字相同）。等待语义由骨架唯一实现：与候选终止信号、这一问自己的等待预算赛跑；等待期间挂起静止超时（见《进程生命周期》「静止超时」）；回调抛错只让这一问落「无人应答」而**不改变** `ok` / `exitReason`。适配器只负责两件事——把厂商的钩子接上来、把答复按各家的形状喂回去 |
| **注入端口由适配器主动取件**（`inject`，可选） | 又一种形状，与上一条**恰好相反**：它不是「骨架回调适配器」而是「适配器在**它自己认得的边界**上向端口要人话」——骨架不认识「队列」这个词（业务无关那一刀），只认「端口说现在在等」。**能阻塞本次运行的只有上一条（`onAskUser`）；这一格不能**——它由适配器拉，拉不到就是空数组。三格语义：`drain(boundary)` **同步**返回这一批（`'round'` 只取要求「立即发送」的条目、`'idle'` 取全部且前者排前面；**不抛**、取不到就是空数组）、`markDelivered(ids, retract)` 在**厂商真的收下之后**同步登记「怎么把它要回来」、`retract(id)` 是**编排层发起**的异步动作（**不抛**，四值 `'retracted'` / `'already-consumed'` / `'unsupported'` / `'unknown'` 如实交回）。适配器什么时候问、问几次全由它自己的事件语义决定（等待与收场归编排层的那张表，见《候选执行与日志》）。**缺席 ⇒ 适配器一格都不挂**——这是「零回归」的判据 |

**入参 `AgentRunInput`**：`cwd`（候选工作区）、`configHome`（行独立配置目录，候选与候选共用会互相注入 MCP / 插件 / 技能）、`permission`（**必填是刻意的**：执行与评分各表一次态，少给一个就编译不过）、`prompt`、`route`（`protocolType` / `baseUrl` / `apiKey` / `modelId`，只读）、`signal`（只用来判 `canceled`，已 abort 时连进程都不起）、`watchdog`（可选：两级**静止**上限 `{ idleTimeoutMs?, turnWallClockMs? }`，缺省常亮 180 s / 600 s；显式给 `0` 关掉那一级。它判的是「这个候选还在动吗」，不是工作时长）、`outputSchema`（**要求模型按 JSON Schema 生成最终答复**，类型是 `unknown`。语义只有「我想要」：**一律交给 `start`**，走原生通道还是填充层由各适配器自己决定——有原生通道的家翻成厂商方言（claude 的 `outputFormat`、codex 的 `outputSchema`），没有的家在适配器内部**填充**（首轮提示词追加 schema 约束 + 自校验 + 同会话修正轮）。非对象（数组 / 字符串 / `null`）不是任何一家能用的 schema ⇒ 适配器按「没给」处置（不传原生通道、也不追加提示词）；骨架那一侧的判据这时退化成「只判合法 JSON」并记 WARN。结果里那一格记的是**这一次有没有真的走原生通道**，调用方据它记账，不要自己另查能力表——`capability` 里没有这一格）、`extraReadPaths`（可选：read-only 档下**额外放行**的只读绝对路径——只扩大「哪些路径可以读」、写仍被拒；**只 claude 消费**，映射 SDK `additionalDirectories`（`--add-dir`）；codex / dsh / pi 不映射，只读档读本就全放行）、`mcpServers`、`skills`（候选要装入的技能清单，逐条 `{ name, sourceDir }`）、`onEvent`、`onMessage`（内容级消息回调，见下）、`onSubagent`、`onAskUser`（提问通道，形状与三条同步流不同，见上表最后一条）、`inject`（**可选**：这一轮运行中收不收人话——缺席 = 适配器一格都不挂，给了就由它按两档边界取件；与下面的 `resume` **正交**，两格是两件事、不是「一个功能的两半」）、`resume`（**可选**：从哪条会话接着跑，`{ sessionId }`；缺席 = 开新会话。**刻意不做成 `{ mode: 'new' | 'resume' }` 判别联合**——多出来的那一档没人填，却会逼每一处构造入参的地方写 `mode`。**不支持续接的家收到它必须抛错**（中文原因），**不许静默开新会话**：那是最坏的一种，用户以为在追问、智能体其实什么都不记得，而界面上一切正常）。

**`skills` 那一格的三条口径**（与 `mcpServers` 同层，但语义刻意不同）：

| 事实 | 说明 |
|---|---|
| **缺席 ≠ 空数组** | **不传** `skills` ⇒ 一个文件都不写（连 `skills/` 目录都不建）；传 `[]` 会被物化成「建了目录、零条」。**「这个候选不装技能」唯一的表达方式是「不传」**——评分与用例同步两处因此都不传 |
| **落点是候选配置目录** | `<configHome>/skills/<名称>/SKILL.md`（四家同形），适配器只调 `core` 的物化函数（`agents` 包禁 readdir）；落不下去时物化**抛**并点名哪一条，由骨架归成 `AGENT_SKILLS_UNAVAILABLE`、该候选失败 |
| **时序逐家不同** | claude 无更紧要求；codex 必须早于 spawn app-server；dsh 必须早于 `new DeepSeekHarness(...)`（boot 点）；pi 必须早于 `createAgentSession()`——写晚了四家都**静默无 skill 且无报错**，所以时序判据在装配时刻取快照 |

调用点：**候选执行那一处传它**（`installableSkills(settings.skills?.entries)` 的一处快照），评分与用例同步两处不传——「只有候选执行阶段装入」由**类型 + 调用点**共同保证，静态断言钉住填点恰好一处。完整链路（扫盘 → 准入 → 停用剔除 → 物化 → 采集 → 三态结论）见[《技能配置》](/features/skills-config)。

**`onMessage` 把内容视图接进入参**（与它同层的是 `onSubagent`；两者与 `onEvent` **并行**，不是它的子集）：

| 事实 | 说明 |
|---|---|
| **可选**（`?`） | 不传 ⇒ 适配器**一个消息都不产出**：`runTurn` 里合并器整条链路不启用，块序号分配与覆盖合并的开销一并省掉。只读 `finalText` 的调用方（评分通路、用例同步）因此都不传 |
| **同步、不 await** | 与 `onEvent` 同一语义（见上面的五条承诺）；消费方抛错被吞掉并记 `logger.error`，**不改变**本次运行的结论 |
| **收到的是消息不是事件** | 载荷是 `AgentMessage`（内容级：说话者 / 内容块 / 工具族 / 子智能体归属 / 模型往返序号）。**为什么分两条流**：消费方与去重键都不同——事件是候选级的（SSE 去重与续订按 `seq`），消息是内容级的（按 `mergeKey` 累积、会被快照覆盖）；塞进 `AgentEvent` 只会让两边都拿到用不到的可选格 |
| **一条逻辑消息会多次投递** | 每次给的是该消息**到现在为止的完整块**（不是本次新增那几块）⇒ 消费方按 `mergeKey` **整条覆盖**即可，不必自己维护累积状态；`assembly: 'open'` = 还有块停在增量累积值上（进程被中断），**不要用 `truncated` 表达**（那是 `tool-result` 块自己的字段） |
| **id 由适配器分配** | `messageId` = `run-<kind>:<seq>`，**不含真实 run id、跨运行重号** ⇒ 别当全局唯一键；`seq` 与合并器同生命周期（一份 run 一个） |

`onSubagent` 交的是**子任务行**（`SubagentRecord`）而非消息：一行一子任务，同一身份会**多次投递**（派发时一条、收场时一条），后者是前者的完整快照 ⇒ 消费方按 `subagentId` 覆盖即可。它不并进消息流，是因为子任务没有说话者与内容块，字段（名称、类型、父链、用量）与消息没有交集。

**返回 `AgentRunResult`**：`ok` / `exitReason`（判定优先级固定：外部要求停止（用户点「终止」/ 宿主停机）→ 看门狗判定的静止超时 → 其余按实际结果；`timed-out` 的生产者就是骨架的看门狗，见《进程生命周期》的「静止超时」）/ `tokens`（**采不到就是 `null`，绝不填 0**——0 会让人得出「这家很省」的错误结论）/ `turns`（步数 = **一次模型 API 往返**；`null` = 一次都没观察到）/ `durationMs` / `finalText`（**「未采到」（`null`）与「空答复」（`''`）是两件事**，不互相兜底；需要结构化答复的调用方从这里取，不要从事件流里重建）/ `applied.structuredOutput`（**适配器上报的每-run 通道事实**：这一次有没有把答复落到原生 schema 通道上。骨架只搬运、缺省 `false`；`false` 不等于答复不合格——走填充层的家可能交出一份完全合格的 JSON 而这一格仍是 `false`）/ `sessionId`（**恒有的一格**：这次跑在哪条会话上，`null` = 这次没拿到。它与 `tokens` / `subagentTokens` / `subagentTurns` 同形——本包结果里那几个「可能采不到」的格子全是 `| null`、没有一个是可选键。「这家有没有会话这个概念」由**能力声明**回答、不进结果，于是「没采到」（值得 WARN）与「这家没这个概念」（什么也不用说）在消费方分得开；消费方是候选快照的 `sessionId`，它落盘之后跨进程续接才有键可指）/ `error`（`code` 是 `AGENT_*` 领域归因码，没有 HTTP 状态，落点是该候选的事件日志）。

**权限档按阶段给，不按厂商给**（`permission.ts` 是唯一真源）：

| 档 | 用在哪 | 四家落点要点 |
|---|---|---|
| `'full'` | 候选**执行**阶段；**用例同步**（写提交信息 / 分叉合并裁定，`cwd` = 用例目录） | claude `bypassPermissions` + `allowDangerouslySkipPermissions: true`（**必须成对**，少后者静默失效、表现为候选 0 改动）；codex `danger-full-access`（`workspace-write` 默认**关网络**，装依赖会失败）；dsh `DSH_PERMISSION_MODE=danger-full-access`；pi 没有权限标志位，档位落成**工具白名单**（full = `read` / `bash` / `edit` / `write` + 子智能体扩展那三件 + `mcp__*` 通配） |
| `'read-only'` | **评分**阶段 | claude `dontAsk`（**刻意不是 `plan`**——`plan` 连 `git diff` 都跑不了）；codex `read-only`（**Windows 上落 `danger-full-access`**——该平台只读连 `echo` 都起不来，评分会盲评；代价由编排层污染对照兜底）；dsh `read-only`；pi 只读档 = 只给 `read` / `grep` / `find` / `ls`（**问答复用工具、子智能体扩展那三件与 `mcp__*` 通配都不给**——通配只进全权限档，见《四家横向对比》同一行）。`Agent` 派出的子会话另拿完整工具面、能写文件，那是权限提升 |

- **`extraReadPaths` 不是第四档**：它只扩大 read-only 下的**读范围**、不改变「写仍被拒」，也**刻意不落**上面四份档位表（`permission.ts` 的键集合有守卫钉死）——codex 的 read-only 沙箱与 dsh 的只读档本就全盘可读，pi 的读范围由只读档的工具白名单决定，把这一格塞进表里等于让它们消费一个它们不映射的选项。当前唯一消费方是智能体评分通路：执行过程记录（`events.jsonl` / `messages.jsonl`）落在 cwd 之外，路径经这一格透传，让 claude 的 `dontAsk` 把 `--add-dir` 扩进预授权范围。

## 状态机与时序

**调用点（今天全仓四处，都不流式：结果从 `run` 的返回值取）**——**这张表是举例，不是契约**：调用点随功能增长，别按候选数或候选内容校验；真正的契约是上面那张入参与返回值。

| 调用点 | 档 / `cwd` | 说明 |
|---|---|---|
| `evaluator/src/orchestrator.ts`（候选执行） | `'full'` / 候选工作区 | 增量走 `onEvent` / `onMessage`，终态看 `AgentRunResult`；**全仓唯一传 `onMessage` / `onSubagent` 的生产调用点**（另两处只读 `finalText`，因此收不到任何消息），也是**唯一传 `skills` / `mcpServers` 的调用点**。**`onAskUser` 只有这一处传，且按轮级开关 `EvalRun.askUser` 决定传不传**——不开启的轮一格都不传，四家行为逐字不变。消息按**块形态**分叉：`chunk === 'snapshot'` 落 `messages.jsonl` 并扇出（唯一真相源），`delta` **只扇出、不落盘**（块结束必有快照，中间态在折叠读侧全被盖掉）；**顺手记观测**——`EvalCandidate.streamingDelta` = 增量帧数 + 末帧累积字数（增量不落盘 ⇒ 这是「这次到底有没有真的收到逐字流」的唯一事后痕迹，环境抽屉按它渲染三态），技能那一侧另记 `EvalCandidate.skillInstall`（逐条四格：名称 / 厂商原值来源 / 判据通道 / 结论三态，由编排层推导一次）；行已终态之后到达的迟到消息与事件同一条闸门，一并丢弃。出口另有一层 16ms 合并（见《事件流》「消息流的出口合并」） |
| `evaluator/src/orchestrator.ts`（人工追问） | `'full'` / 候选工作区（**复用**，不 prepare） | 对**已经跑过**的行接着同一段上下文再跑一段：复用候选工作区与会话，`resume` 填候选快照的 `sessionId`（`null` 在拒绝面就被挡住）。注入面按同一个轮级开关照开——行在跑，人就能往这一轮送话；`onMessage` / `onEvent` / `skills` / `mcpServers` 与候选那一处同形（**上下文续接不带厂商侧的工具面，少传一次工具就在这一段静默消失**）。计量口径与候选那一处**相反**（累加、`attempts` 不变、跑完自动重评），见《候选执行与日志》 |
| `evaluator/src/judge-agent.ts`（智能体评分） | `'read-only'` / 候选工作区 | 提示词明写只读：工作区是候选的产出，改了就污染「查看改动」抽屉 |
| `api/src/case-sync.ts`（用例同步；**两处调用**：写提交信息、分叉合并裁定） | `'full'` / `casesRoot` | **唯一发生在评测轮之外**的调用——它不挂在任何一轮 / 一行的生命周期上，编排与队列因此落在 api 层（见《仓库分层与依赖方向》）；对它只要求「读仓库、回一段 JSON」或「把远端合进来」，提交与推送仍由服务端自己执行 |

**没有「整候选级」的超时**：`AgentRunInput` 没有 `timeoutMs`（时间旋钮只有 `watchdog` 的两级**静止**上限与 `signal`），**「跑满 N 分钟就掐」是本层刻意不提供的语义**。真要它由调用方自己收口：用例同步就用 `AbortController` + 定时器做 10 分钟硬上限（`case-sync.ts` 的 `SYNC_AGENT_TIMEOUT_MS`），**不扩 `run` 的签名**——更细的超时语义按「扩展 `run` 前先澄清」的规矩走。

- 一次运行的生命周期：`run(input)` →（懒加载 SDK）→ 起厂商运行时（子进程型 spawn 进程、in-process 型建会话）→ 事件流 → 终态 → 收尾取数 → 释放。停止固定顺序：`interrupt()` → 等在途 turn 终结（最多 **5 秒**）→ `dispose()`——顺序不可颠倒，直接 dispose 会与在途 turn 争抢同一批资源。
- `dispose()` 幂等（可能被「用户终止」与「看门狗判定的静止超时」先后触发）；`createDisposer` 把「恰好一次」绑到**被关闭的那个对象**上（不是运行时级闭锁，那会让新建的客户端没人关）。
- dsh 的 `cancelMidTurn: false` 是实测结论（SDK 没有 wire-level cancel，只有 `close()`）——点「终止」后该候选晚 5 秒才变 `canceled` 是设计。

**结构化输出：要了 schema 就得交出符合它的 JSON**（四家同一条交付契约，保证强度不同）：

| 环节 | 口径 |
|---|---|
| 通道 | 有原生 schema 通道的家把入参翻成厂商选项（cc 的 `outputFormat`、codex 的 `turn/start` 的 `outputSchema`）；pi 走**工具通道**（自定义工具 `submit_result` + `constrainedSampling` 的 strict），入参 schema 交给厂商侧强制；没有原生通道的家在适配器内部**填充**——首轮把 schema 约束追加在调用方提示词之后，并由 `continue` 支持同会话追问 |
| 判据 | 剥「整段以 ``` 开头」的围栏 → `JSON.parse` → 「JSON Schema 子集 → zod」校验（`src/structured-output.ts`）。不认识的 keyword **不生成约束**（fail-open，记 DEBUG）；整份 schema 编不出来 ⇒ 退化成「只判合法 JSON」并记 WARN |
| 修正轮 | 首轮答复**拿到了但不合格**时，骨架把「问题清单（点号路径 + 说明）+ schema 原文 + 它自己的原文（上限 20000 字符，截断处标注）」交给 `continue`，上限 **2 轮**（`STRUCTURED_OUTPUT_REPAIR_ROUNDS`）；提示词明写只输出一个 JSON、不要围栏、不要重新读工作区 / 不要重新执行任务 / 不要改判定 |
| 不做修正的四条边界 | 没要求 schema；首轮就以 `failure` 收场（那是「没问到」，不是「答错了」）；已要求停止；没采到最终答复（`finalText === null`，没有可回灌的原文） |
| 耗尽 | **不改写结论**：`ok` / `exitReason` / `finalText` 保持最后一轮原样，由调用方按「答复不可解析」处置；没有 `continue` 的家在第一条不合格答复上就如实收场（落一条 WARN） |
| 记账 | 修正轮只发该候选日志事件（`[WARN] 结构化输出未通过校验，要求模型修正（第 N/2 轮）：<首条问题>` 一类），它是模型往返 ⇒ 自然计入 `turns` / `tokens`；**没有新增结果字段** |
| 留痕 | `applied.structuredOutput` 由适配器上报本次事实：cc 按「收尾消息里有没有 `structured_output`」、codex 按「这次有没有把 schema 发进 `turn/start`」、pi 按「本轮答复是否确实来自被 strict 约束的工具参数」（模型改走正文时翻回 `false`）、dsh 恒 `false` |

**`run` 的内部骨架**（`turn.ts`，包内类型、不从包出口转出）按 `TurnHooks = { kind; start; continue? }` 组织：`start` 造出一次运行的消费句柄 `TurnStart`（`stream` / `interrupt` / `dispose` / `finalize?` / `continue?` / `project`），骨架负责消费、按固定顺序释放、组装结果；`continue` 是**可选的同会话追问**，返回一段新的活动区间、与首轮逐字同形地消费（同一运行时、同一会话、释放仍只做一次）。**只有能同会话再跑一轮的家实现它**——实现不了的家如实收场，不假装修正过。注入端口由**骨架备好**再交给适配器（`TurnContext.inject`，**恒有**）：调用方没传时替代物是一个**关闭档**（`available: false`、取件恒空、撤回恒 `'unsupported'`），于是「没传端口」与「传了一个关着的端口」在适配器那一侧**同形**，适配器只有一个判据要读（`available`），「没开闸门 ⇒ 一格都不挂」这条零回归判据也只有一个形状。骨架另在端口外面包一层，替适配器登记「现在在等队列」（`'idle'` 边界空手而归 = 适配器已收工），用于静止超时豁免——见《进程生命周期》「静止超时」。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `getProvider` 对未注册 kind 抛裸 Error（无 `ServiceError` 语义） | 调用方先判 `AGENT_KINDS`（`loadConfig` 不做 zod 校验，手改 config.json 写 `"gemini"` 到不了这里才对） |
| `timed-out` 只由骨架的看门狗生产 | 适配器没有内层超时（刻意的），编排层也没有整候选级的兜底定时器；「上游自己报的超时」走 `error`（归因码同样可以是 `AGENT_TIMED_OUT`）——**「我们掐的」与「它自己超时」在日志里必须分得开**。`timed-out` 行不进自动重试 |
| 结构化输出是**每-run 通道事实**（`applied.structuredOutput`），不是能力位 | 由适配器上报、骨架只搬运；「有没有走原生通道」与「答复合格不合格」是两件事——`false` 可能是一份完全合格的 JSON（填充层交出来的），用户可见的行事件由调用方按 `applied` 发 |
| 修正轮的花销不可见 | 修正轮**只进日志**：界面「输出约束」那一格仍只回答「有没有走原生通道」，不反映追问了几轮；花销在 `turns` / `tokens` 里（修正轮是模型往返） |
| `protocolTypes` 是候选池过滤的数据源 | 不要另写一份「智能体 ↔ 协议」对应表——填错会列出不兼容的网关（选完到运行时才失败） |

## 相关链接

- 活文档：`packages/server/agents/README.md`——§2 API 一览、§3 方法说明、§4 属性说明（本篇的真源，互链不复制）
- 知识文章：[《新增 SDK 接入流程》](/protocols/sdk-onboarding)、[《Claude Code 接入》](/protocols/cc)、[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)、[《四家横向对比》](/protocols/comparison)、[《消息规范》](/protocols/message-spec)（事件类型的契约侧）、[《技能配置》](/features/skills-config)（`skills` 入参与 `skillInstall` 观测格的全链）
