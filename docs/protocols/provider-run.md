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

**三家的实际能力值**（与 `registry.test.ts` 的期望表逐格一致，改动会红）：

| kind | displayName | protocolTypes | cancelMidTurn | usage | structuredOutput |
|---|---|---|---|---|---|
| `claude-code` | Claude Code | `['anthropic']` | `true` | `true` | `true` |
| `codex` | Codex | `['openai']` | `true` | `true` | `true` |
| `dsh` | DeepSeek Harness | `['openai','anthropic']` | `false` | `true` | `false` |

`metadata.messageCapability` 逐格声明「思考正文 / 工具入参 / 工具结果 / 子任务 / 流式增量」能不能拿到、从哪条通道拿、拿不到时为什么（`MissingReason` 四句：`not-supported` / `not-exposed` / `not-observed` / `unverified`），外加成立前提（`notes`）。

## 数据与契约

**`run(input)` 的调用契约（五条承诺）**：

| 承诺 | 说明 |
|---|---|
| **不抛** | 所有失败折进 `result.ok === false` + `result.error`；调用方不需要给每一行套 try/catch（真违约抛了按「适配器违约」处置） |
| **不改宿主环境** | 绝不写 `process.env`——凭据进**替换型子进程环境**（以宿主为底、覆盖 `HOME` / `USERPROFILE` 与厂商变量后整体交给子进程；并行多行时往 `process.env` 塞会互相串凭据） |
| **不动 git** | 工作区与分支由编排层备好；适配器只在该目录里跑 |
| **不设内层上限** | 没有 `timeoutMs` 也没有 `maxTurns`：一次运行只会因「跑完 / 失败 / 外部要求停止」结束 |
| **同步回调** | `onEvent` / `onMessage` / `onSubagent` 同步调用、不 await；回调抛错被吞掉并记 `logger.error`，**不改变**本次运行结论（受保护发射） |

**入参 `AgentRunInput`**：`cwd`（行工作区）、`configHome`（行独立配置目录，行与行共用会互相注入 MCP / 插件）、`permission`（**必填是刻意的**：执行与评分各表一次态，少给一个就编译不过）、`prompt`、`route`（`protocolType` / `baseUrl` / `apiKey` / `modelId`，只读）、`signal`（只用来判 `canceled`，已 abort 时连进程都不起）、`outputSchema`（要求模型按 JSON Schema 生成最终答复；该家不支持时**降级**——`runTurn` 不交给 `start`、包内记 WARN、结果里 `applied.structuredOutput = false`，调用方据它记账，不要自己再去查能力表）、`onEvent`、`onMessage`（内容级消息回调，见下）、`onSubagent`。

**`onMessage` 把内容视图接进入参**（与它同层的是 `onSubagent`；两者与 `onEvent` **并行**，不是它的子集）：

| 事实 | 说明 |
|---|---|
| **可选**（`?`） | 不传 ⇒ 适配器**一个消息都不产出**：`runTurn` 里合并器整条链路不启用，块序号分配与覆盖合并的开销一并省掉。只读 `finalText` 的调用方（评分通路、用例同步）因此都不传 |
| **同步、不 await** | 与 `onEvent` 同一语义（见上面的五条承诺）；消费方抛错被吞掉并记 `logger.error`，**不改变**本次运行的结论 |
| **收到的是消息不是事件** | 载荷是 `AgentMessage`（内容级：说话者 / 内容块 / 工具族 / 子智能体归属 / 模型往返序号）。**为什么分两条流**：消费方与去重键都不同——事件是行级的（SSE 去重与续订按 `seq`），消息是内容级的（按 `mergeKey` 累积、会被快照覆盖）；塞进 `AgentEvent` 只会让两边都拿到用不到的可选格 |
| **一条逻辑消息会多次投递** | 每次给的是该消息**到现在为止的完整块**（不是本次新增那几块）⇒ 消费方按 `mergeKey` **整条覆盖**即可，不必自己维护累积状态；`assembly: 'open'` = 还有块停在增量累积值上（进程被中断），**不要用 `truncated` 表达**（那是 `tool-result` 块自己的字段） |
| **id 由适配器分配** | `messageId` = `run-<kind>:<seq>`，**不含真实 run id、跨运行重号** ⇒ 别当全局唯一键；`seq` 与合并器同生命周期（一份 run 一个） |

`onSubagent` 交的是**子任务行**（`SubagentRecord`）而非消息：一行一子任务，同一身份会**多次投递**（派发时一条、收场时一条），后者是前者的完整快照 ⇒ 消费方按 `subagentId` 覆盖即可。它不并进消息流，是因为子任务没有说话者与内容块，字段（名称、类型、父链、用量）与消息没有交集。

**返回 `AgentRunResult`**：`ok` / `exitReason`（判定优先级固定：`signal` 已中止 → `canceled`；`timed-out` 当前**没有生产者**，保留为读历史与重试判据）/ `tokens`（**采不到就是 `null`，绝不填 0**——0 会让人得出「这家很省」的错误结论）/ `turns`（轮次 = **一次模型 API 往返**；`null` = 一次都没观察到）/ `durationMs` / `finalText`（**「未采到」（`null`）与「空答复」（`''`）是两件事**，不互相兜底；需要结构化答复的调用方从这里取，不要从事件流里重建）/ `applied.structuredOutput` / `error`（`code` 是 `AGENT_*` 领域归因码，没有 HTTP 状态，落点是该行的事件日志）。

**权限档按阶段给，不按厂商给**（`permission.ts` 是唯一真源）：

| 档 | 用在哪 | 三家落点要点 |
|---|---|---|
| `'full'` | 候选**执行**阶段；**用例同步**（写提交信息 / 分叉合并裁定，`cwd` = 用例目录） | claude `bypassPermissions` + `allowDangerouslySkipPermissions: true`（**必须成对**，少后者静默失效、表现为候选 0 改动）；codex `danger-full-access`（`workspace-write` 默认**关网络**，装依赖会失败）；dsh `DSH_PERMISSION_MODE=danger-full-access` |
| `'read-only'` | **评分**阶段 | claude `dontAsk`（**刻意不是 `plan`**——`plan` 连 `git diff` 都跑不了）；codex `read-only`（**Windows 上落 `danger-full-access`**——该平台只读连 `echo` 都起不来，评分会盲评；代价由编排层污染对照兜底）；dsh `read-only` |

## 状态机与时序

**调用点（全仓三处，都不流式：结果从 `run` 的返回值取）**：

| 调用点 | 档 / `cwd` | 说明 |
|---|---|---|
| `evaluator/src/orchestrator.ts`（候选执行） | `'full'` / 行工作区 | 增量走 `onEvent` / `onMessage`，终态看 `AgentRunResult`；**全仓唯一传 `onMessage` / `onSubagent` 的生产调用点**（另两处只读 `finalText`，因此收不到任何消息）。消息按**块形态**分叉：`chunk === 'snapshot'` 落 `messages.jsonl` 并扇出（唯一真相源），`delta` **只扇出、不落盘**（块结束必有快照，中间态在折叠读侧全被盖掉）；**顺手记观测**——`EvalRow.streamingDelta` = 增量帧数 + 末帧累积字数（增量不落盘 ⇒ 这是「这次到底有没有真的收到逐字流」的唯一事后痕迹，环境抽屉按它渲染三态）；行已终态之后到达的迟到消息与事件同一条闸门，一并丢弃。出口另有一层 16ms 合并（见《事件流》「消息流的出口合并」） |
| `evaluator/src/judge-agent.ts`（智能体评分） | `'read-only'` / 行工作区 | 提示词明写只读：工作区是候选的产出，改了就污染「查看改动」抽屉 |
| `api/src/case-sync.ts`（用例同步；**两处调用**：写提交信息、分叉合并裁定） | `'full'` / `casesRoot` | **唯一发生在评测轮次之外**的调用——它不挂在任何一轮 / 一行的生命周期上，编排与队列因此落在 api 层（见《仓库分层与依赖方向》）；对它只要求「读仓库、回一段 JSON」或「把远端合进来」，提交与推送仍由服务端自己执行 |

**超时只能由调用方收口**：`AgentRunInput` 没有 `timeoutMs`，唯一取消手段是 `signal`。用例同步因此在调用方用 `AbortController` + 定时器做 10 分钟硬上限（`case-sync.ts` 的 `SYNC_AGENT_TIMEOUT_MS`），**不扩 `run` 的签名**——真要更细的超时语义，按「扩展 `run` 前先澄清」的规矩走。

- 一次运行的生命周期：`run(input)` →（懒加载 SDK）→ spawn 厂商进程 → 通知流 → 终态 → 收尾取数 → 释放。停止固定顺序：`interrupt()` → 等在途 turn 终结（最多 **5 秒**）→ `dispose()`——顺序不可颠倒，直接 dispose 会与在途 turn 争抢同一批资源。
- `dispose()` 幂等（可能被「用户终止」与「兜底超时」先后触发）；`createDisposer` 把「恰好一次」绑到**被关闭的那个对象**上（不是运行时级闭锁，那会让新建的客户端没人关）。
- dsh 的 `cancelMidTurn: false` 是实测结论（SDK 没有 wire-level cancel，只有 `close()`）——点「终止」后该行晚 5 秒才变 `canceled` 是设计。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| `getProvider` 对未注册 kind 抛裸 Error（无 `ServiceError` 语义） | 调用方先判 `AGENT_KINDS`（`loadConfig` 不做 zod 校验，手改 config.json 写 `"gemini"` 到不了这里才对） |
| `timed-out` 没有生产者 | 适配器没有内层超时（刻意的）；超时由编排层负责，且它无法中断卡住的迭代 ⇒ 收敛靠兜底上限 |
| `structuredOutput` 是必填（不是「可选 + 守卫」） | 可选会被默认成 false 而无人验证；降级由包内处置，用户可见的行事件由调用方按 `applied` 发 |
| `protocolTypes` 是候选池过滤的数据源 | 不要另写一份「智能体 ↔ 协议」对应表——填错会列出不兼容的网关（选完到运行时才失败） |

## 相关链接

- 活文档：`packages/server/agents/README.md`——§2 API 一览、§3 方法说明、§4 属性说明（本篇的真源，互链不复制）
- 知识文章：[《新增 SDK 接入流程》](/protocols/sdk-onboarding)、[《Claude Code 接入》](/protocols/claude-code)、[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)、[《三家横向对比》](/protocols/comparison)、[《消息规范》](/protocols/message-spec)（事件类型的契约侧）
