# @aieval/agents —— 智能体适配包

把「驱动一个编码智能体（CLI / SDK）跑完一道题」这件事收成**一个函数**：

```ts
getProvider(kind).run(input): Promise<AgentRunResult>
```

三家（Claude Code / Codex / DeepSeek Harness）的差异——厂商包入口形状、环境变量落点、权限档位、
事件口径、释放方式——**全部挡在包内**。调用方（编排层 / 评分层）只按 `kind` 解析、只看元数据、
只读 `AgentRunResult`，因此加第四家 = 加一个 `providers/<id>/` 目录 + 注册表一行，调用方一行不改。

包的位置与定位：`packages/server/agents`，服务端五个包之一；**厂商 SDK 只允许出现在本包**
（依赖方向与边界由 `withBoundary()` 的 eslint 规则硬约束，见根 `README.md`「代码在哪」）。

---

## 1. 快速开始

```bash
pnpm install                         # 仓库根目录；仅允许 pnpm（preinstall 强制）
pnpm --filter @aieval/agents test        # 本包用例（19 文件 / 208 例，秒级）
pnpm --filter @aieval/agents typecheck   # 本包 tsc --noEmit
pnpm --filter @aieval/agents lint        # 本包 eslint
```

依赖侧的两件事：

- 本包 `main` / `types` / `exports` 都指向 `./src/index.ts`（**源码直出**，由 Next 的
  `transpilePackages` 转译），不产出 `dist`；
- `exports` **只映射 `.`**：内部模块一律不从包外可达，请从 `@aieval/agents` 导入，不要伸进 `src/`。

运行侧的前置条件（缺了会在 `run()` 里折成 `AGENT_FAILED` / `AGENT_LOAD_FAILED`，而不是在装包时报错）：

- 对应厂商包必须在 `node_modules` 里且导出面与适配器期望一致（三家都在本包 `dependencies` 里）；
- 对应 CLI 必须可用：`claude` / `dsh` 走 `PATH`；**codex 不用 `PATH`**——适配器解析厂商包自带的可执行文件（`providers/codex/appserver/binary.ts`）并 spawn `codex app-server`。本包不代装、不代为登录；
- 一行一份 `cwd` + `configHome`：适配器只负责把凭据注入**子进程环境**，不碰宿主的 `~/.claude` / `~/.codex`。

### 最小用法

```ts
import { getProvider, type AgentRunInput, type AgentRunResult } from '@aieval/agents';
import type { AgentEvent } from '@aieval/contracts';

/** ① 路由：一条「协议 + 网关 + 密钥 + 模型」四元组（只读输入） */
const route: AgentRunInput['route'] = {
  protocolType: 'anthropic',           // 必须与该家 metadata.protocolTypes 里的一条一致
  baseUrl: 'https://gw.example.com/anthropic',
  apiKey: 'sk-…',
  modelId: 'claude-sonnet-4-5',
};

/** ② 每行一份事件回调：同步消费、不 await；本层抛错会改变结论吗——不会（骨架吞掉并记 error 日志），
 *  但「把事件落盘」是你的职责，抛错会让那一条事件丢失 */
const onEvent = (event: AgentEvent): void => {
  appendRowEvent(rowId, event);        // 实现自便：落 events.jsonl / 推 SSE / 逐步回写快照
};

// ③ 工作区与独立配置目录由编排层的准备步骤产好（适配器不做 git 操作、不建目录）
const controller = new AbortController();   // 「终止」按钮 → controller.abort()
const input: AgentRunInput = {
  cwd: '/runs/run-1/rows/row-1/workspace',
  configHome: '/runs/run-1/rows/row-1/.agenthome',
  permission: 'full',                  // 执行阶段全权限；评分阶段传 'read-only'
  prompt: '把 README 的标题改成「示例项目」，然后结束。',
  route,
  signal: controller.signal,           // 用户点「终止」时 abort
  onEvent,
};

const result: AgentRunResult = await getProvider('claude-code').run(input);
if (!result.ok) console.error(result.error?.code, result.error?.message);
```

## 2. 公共 API 一览

从 `@aieval/agents` 导入的全部内容（`src/index.ts` 是唯一出口）：

| 导出 | 种类 | 作用 |
|---|---|---|
| `getProvider(kind)` | 函数 | 按 `kind` 解析适配器；未注册的 kind **抛错**（信息含可用清单） |
| `listAgentProviders()` | 函数 | 全部适配器（**返回副本**）；顺序 = 前端下拉顺序，与 `AGENT_KINDS` 同序 |
| `AGENT_KINDS` | 值 | 三家 kind 的清单，**再导出**自 `@aieval/contracts`（真源在那里） |
| `acceptsProtocol(metadata, protocol)` | 函数 | 该家能不能收这条协议（读 `metadata.protocolTypes` 的**集合**）；表单过滤、创建校验、评分智能体校验与编排层复检四处都读它，**不许各写一份** |
| `protocolMismatchMessage(metadata, protocol)` | 函数 | 协议不匹配时的**中文文案**（列出该家接受的**集合**而不是单值） |
| `ProtocolMismatchInput` | 类型 | 上面那个文案函数的入参（适配器元数据 + 目标协议） |
| `AgentKind` | 类型 | `'claude-code' \| 'codex' \| 'dsh'` |
| `AgentProvider` | 类型 | 适配器形状：`kind` / `displayName` / `metadata` / `run()` |
| `AgentProviderMetadata` | 类型 | 协议兼容性 / 行级能力 / 消息能力 / 档位域 |
| `AgentRunInput` | 类型 | 一次运行的全部输入 |
| `AgentRunResult` | 类型 | 一次运行的全部结果 |
| `AgentPermission` | 类型 | 权限档：`'full' \| 'read-only'` |
| `AgentExitReason` | 类型 | `'completed' \| 'timed-out' \| 'canceled' \| 'error'` |
| `AgentErrorCode` | 类型 | 领域归因码（**不是** contracts 的 `ErrorCode`，没有 HTTP 状态） |
| `ProtocolType` | 类型 | `'openai' \| 'anthropic'` |

事件类型（`AgentEvent`）的真源在 `@aieval/contracts`，包内只 import 不重复声明。

---

## 3. 方法说明

### 3.1 `getProvider(kind: AgentKind): AgentProvider`

按 kind 解析适配器，**同步**返回、不加载厂商 SDK（SDK 是函数作用域懒加载，第一次 `run()` 才 import）。

- 返回的是注册表里的**同一个实例**（`getProvider('codex') === getProvider('codex')`），可安全地反复调用；
- 未注册的 kind（例如手改过的 `config.json` 里写着 `"gemini"`）抛**裸 `Error`**，文案形如
  `[agents] 未注册的智能体：gemini；可用清单：claude-code / codex / dsh`。

> ⚠️ 调用方注意：这个错误**没有** `ServiceError` 语义，直接冒到 HTTP 层会折成 500「服务端内部错误」。
> 读配置得到 kind 的地方要先自己判枚举（`AGENT_KINDS.includes(kind)`）再解析，并折成可处置的错误
> （evaluator 的 `requireJudgeAgent` 就是这么做的）。

### 3.2 `listAgentProviders(): AgentProvider[]`

返回全部适配器的新数组（调用方 `pop()` / `sort()` 都改不到注册表本身）。
**顺序即界面顺序**，与 contracts 的 `AGENT_KINDS` 同序（有回归用例钉住）。

### 3.3 `provider.run(input: AgentRunInput): Promise<AgentRunResult>`

一次运行的唯一入口。**调用契约（重要）**：

| 承诺 | 说明 |
|---|---|
| **不抛** | 所有失败都折进 `result.ok === false` + `result.error`，调用方**不需要**给每一行套 try/catch（真正违约抛了的话，按「适配器违约」处置） |
| **不改宿主环境** | 绝不写 `process.env`——凭据进的是**替换型子进程环境**（有源码级静态断言守着） |
| **不动 git** | 工作区与分支由编排层备好；适配器只在该目录里跑 |
| **不设内层上限** | 没有 `timeoutMs` 也没有 `maxTurns`：一次运行只会因「跑完 / 失败 / 外部要求停止」结束 |
| **同步回调** | `onEvent` 同步调用、不 await；回调抛错会被吞掉并记 `logger.error`，**不改变**本次运行的结论 |

## 4. 属性说明

### 4.1 `AgentRunInput`（入参）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | `string` | ✅ | 该行工作区（编排层已备好）。适配器不做任何 git 操作 |
| `configHome` | `string` | ✅ | 该行**独立**配置目录：作为子进程的 `HOME` / `USERPROFILE` 与厂商配置目录。行与行共用它会互相注入 MCP / 插件定义，破坏「同一起点」 |
| `permission` | `AgentPermission` | ✅ | 权限档。**必填是刻意的**：执行阶段与评分阶段各表一次态，少给一个就编译不过，而不是运行时静默用一个谁也没选过的默认档 |
| `prompt` | `string` | ✅ | 考题 |
| `route` | `{ protocolType, baseUrl, apiKey, modelId }` | ✅ | 只读输入。协议必须在本家 `metadata.protocolTypes` 里，否则那家 CLI 根本驱动不了它 |
| `signal` | `AbortSignal` | ✅ | 外部要求停止（用户点「终止」）。**只**用来判 `canceled`，不用它推断其它原因；已 abort 时连进程都不起 |
| `outputSchema` | `Record<string, unknown>` | — | 要求模型**按这份 JSON Schema 生成**最终答复。缺省 = 不约束，行为与今天逐字相同。它是**中性事实**：翻成 claude 的 `outputFormat` 还是 codex 的 `outputSchema` 是适配器的事。该家不支持（`capability.structuredOutput: false`）时**降级**：`runTurn` 不把 schema 交给 `start`、包内记一条 WARN，结果里 `applied.structuredOutput = false`——调用方据它记账，不要自己再去查能力表 |
| `onEvent` | `(e: AgentEvent) => void` | ✅ | 事件回调：同步、不 await。每行独立一份，`seq` 从 1 在 run 内自增，`at` 是 ISO 8601 |

### 4.2 `AgentRunResult`（返回值）

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | `boolean` | 是否正常跑完（`exitReason === 'completed'` 时为 `true`） |
| `exitReason` | `AgentExitReason` | **给编排层的分类信号**：`completed` / `canceled` / `error` / `timed-out`。判定优先级固定：`signal` 已中止 → `canceled`，其余按实际结果。`timed-out` 当前**没有生产者**（适配器没有内层上限），保留是为了读历史 `run.json` 与重试判据 |
| `tokens` | `{ input, cached, output } \| null` | **采不到就是 `null`，绝不填 0**（0 会让人得出「这家很省」的错误结论）。三项齐了才认 |
| `turns` | `number \| null` | 轮次 = **一次模型 API 往返**（见 §5.4）；`null` = 一次都没观察到 |
| `durationMs` | `number` | 本次运行的墙钟耗时（适配器自报） |
| `finalText` | `string \| null` | 智能体的最终答复文本。**「未采到」（`null`）与「空答复」（`''`）是两件事**，不要互相兜底。需要结构化答复的调用方（评分智能体）从这里取文本，不要从事件流里重建 |
| `applied` | `{ structuredOutput: boolean }` | 这一次**实际按能力处置成了什么**（A1）。**必填**：调用方据此记账（`ScoreResult.structuredOutput` 就是它）。`false` = 该家不支持那个能力，或本次压根没要求 schema——要分开这两种情形就看入参 |
| `error` | `{ code, message, stack? }` | 失败与终止时都在；`code` 是 `AgentErrorCode` |

### 4.3 `AgentPermission`（权限档）——**按阶段给，不按厂商给**

| 档 | 用在哪 | claude-code | codex | dsh |
|---|---|---|---|---|
| `'full'` | 候选**执行**阶段 | `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | `sandboxMode: 'danger-full-access'` + `approvalPolicy: 'never'` | `DSH_PERMISSION_MODE=danger-full-access` |
| `'read-only'` | **评分**阶段 | `permissionMode: 'dontAsk'` + `permissionPrompts: 'none'` | `sandboxMode: 'read-only'` + `approvalPolicy: 'never'`（**Windows 上落 `danger-full-access`**） | `DSH_PERMISSION_MODE=read-only` |

这张表（`src/permission.ts`）是**唯一真源**，三份放一起才能逐格对照、也才能把「每一档在每一家都有落点」
写成一条可执行断言。三条不能不记的坑：

- **codex 的 `read-only` 在 Windows 上没有可用实现**（2026-10-07 真机）：该平台下 `read-only` 与
  `workspace-write` 连 `echo` / `git status` 都起不来（`CreateProcess … rejected: blocked by policy`），
  而 codex 读文件只能靠 shell ⇒ 评分会变成**盲评**（真机：候选三项全达成，却判 `0 / 25`）。故
  `codexPermissionOptions()` 在 Windows 上把只读档落成 `danger-full-access`，别的平台一字不改；
  代价（评审者能写工作区）由编排层「评分前后 diff 摘要对照」兜底——**不一致即该行失败**。
- claude 的 `bypassPermissions` **必须**配 `allowDangerouslySkipPermissions: true`（SDK 把它们拼成两个独立
  argv，少后者就静默失效——实测表现为候选 **0 改动**，评分在空 diff 上照样出分）；
- codex 的 `workspace-write` 默认**关掉网络**，所以「执行」不能用它：装依赖 / 跑测试会失败。
  `full` 走 `danger-full-access`（不设沙箱）。
- `read-only` 的语义是「读放行、写被拒」，**刻意不是 claude 的 `plan`**：`plan` 连 `git diff` 都跑不了，
  而评审者的工作正是自己去看改动。

### 4.4 `AgentProvider.metadata`——能力查询的唯一入口

```ts
metadata: {
  protocolTypes: readonly ProtocolType[],      // 该家能**接受**的协议集合（非空、去重；dsh 有两条 wire）
  capability: {
    cancelMidTurn: boolean,                    // false ⇒ 界面文案必须是「关闭运行时」而不是「终止」
    usage: boolean,                            // false ⇒ 界面显示「不支持计量」，不是 0
    structuredOutput: boolean,                 // 能不能把入参 outputSchema 落到实处（必填）
  },
  messageCapability: MessageCapability,        // 消息级能力（见下面第二张表）
  reasoningEfforts: readonly string[],         // 该家能表达的思考强度档位（完整值域，必填）
  defaultEffort?: string,                      // 「未选档位」时实际会用的档（只有 dsh 声明）
}
```

- **`protocolTypes` 是模型候选池过滤的数据源**，不要另写一份「智能体 ↔ 协议」的对应关系表：
  填错会让表单列出**不兼容的**网关（选完到运行时才失败）。

三家的实际取值（与 `registry.test.ts` 的期望表逐格一致，改动会红）：

| kind | displayName | protocolTypes | cancelMidTurn | usage | structuredOutput |
|---|---|---|---|---|---|
| `claude-code` | Claude Code | `['anthropic']` | `true` | `true` | `true` |
| `codex` | Codex | `['openai']` | `true` | `true` | `true` |
| `dsh` | DeepSeek Harness | `['openai','anthropic']` | `false` | `true` | `false` |

**消息能力声明**（`metadata.messageCapability`，spec v3 §2.5）在同一份元数据里，逐格声明
「思考正文 / 工具入参 / 工具结果 / 子任务 / 流式增量」能不能拿到、从哪条通道拿、拿不到时为什么，
外加这一族能力成立的前提（`notes`）。三家的差异只有两处结构性缺口：

| kind | thinkingText | toolInput | toolResult | subagent | streamingDelta |
|---|---|---|---|---|---|
| `claude-code` | `yes`（SDK 消息流，`full`） | `yes` | `yes` | `yes` | `yes`（仅主会话） |
| `codex` | `yes`（**app-server 通知流**，`full`） | `yes` | `yes` | `yes` | `yes` |
| `dsh` | `yes`（会话通知流，`full`） | `yes` | `yes` | `yes` | `yes` |

> codex 的消息由 **app-server 通知驱动**（增量与快照同源），收尾再用 `thread/read` 补齐**子线程历史**
> ——子线程的 `item/*` 是否推给本条连接由上游决定，`reader` 是那条路上唯一的兜底。
> 两条入口共用同一个归一函数，同一条消息不会落两次。

> `dsh` 的 `cancelMidTurn: false` 是**实测**结论（SDK 没有 wire-level cancel，只有 `close()`），
> 代价是：点「终止」后该行会**晚 5 秒**才变 `canceled`（走释放的第二段兜底）。
>
> `structuredOutput` 是**必填**（不是「可选 + 守卫」）：可选会被默认成 false 而无人验证。
> 降级由**包内**处置（A1）：`runTurn` 不把 schema 交给 `start`，同时记一条 WARN 与
> `applied.structuredOutput = false`——**用户可见的行事件由调用方按 `applied` 发**，
> 绝不让调用方以为「已经强约束」而实际什么都没发生。

---

## 5. 各家差异（使用时要知道的）

### 5.1 注入落点

| | claude-code | codex | dsh |
|---|---|---|---|
| 厂商包 | `@anthropic-ai/claude-agent-sdk` | `@openai/codex` | `@deepseek-ai/dsh-sdk-client` |
| base URL 处理 | **去掉**尾部 `/v1`（SDK 自己追加 `/v1/messages`） | **补上** `/v1`（CLI 只走 `POST {base}/v1/responses`） | **保留**尾部 `/v1`（其 adapter 自己补 `/messages`） |
| 配置目录 | `CLAUDE_CONFIG_DIR` + `HOME` | `CODEX_HOME` + `HOME` | `DSH_HOME`（**不是** HOME） |
| 凭据 | `ANTHROPIC_API_KEY` + `ANTHROPIC_AUTH_TOKEN`（部分网关只认后者） | `apiKey` 进子进程环境（`OPENAI_API_KEY`）+ 该 provider 的 `env_key: OPENAI_API_KEY`（**Bearer 由 `env_key` 指定**；换成 `requires_openai_auth: true` 会走 ChatGPT 登录态、一个头都不附 ⇒ 全 401） | `DEEPSEEK_API_KEY`（空 `configHome` 下**只有这个变量能救**） |
| 其它 | `settingSources: ['user','project','local']`（读得到被测仓库的 `CLAUDE.md`；`user` 档落在本行 `CLAUDE_CONFIG_DIR`，不是宿主 `~/.claude`）+ `settings.env` 把本次路由钉在 flag 档（否则仓库自带的 `.claude/settings.json` 会盖掉路由——2026-09-29 实测三档对照）；cwd 走 `realpathSync.native` 归一（Windows 8.3 短名会被 CLI 的安全门拦下、导致 0 改动）；`disallowedTools` 禁掉定时任务/推送等旁路工具（`WebSearch` 只在非 `claude` 模型上禁） | 注入完整 `model_providers` 条目 + `tools.web_search=false` + `features.multi_agent=true`（**显式打开**：子智能体是评测面之一，与 claude / dsh 两家口径一致；关掉只会让 `spawn_agent` 变成一次失败的工具调用、子任务面板恒空）；每次运行独占临时目录 | 通知流**先订阅再交提示词**（顺序错了会丢掉开头那批事件）；`start()` 先握手，失败归 `AGENT_FAILED` |

URL 归一只对**路径段**做，query / fragment 一个字符都不动（用户粘进来的地址可能带 `?x=1`）。

### 5.2 停止与释放

固定顺序：`interrupt()` → 等在途 turn 终结（最多 **5 秒**）→ `dispose()`。顺序不可颠倒：直接 dispose
会与在途 turn 争抢同一批资源（子进程、临时目录）。

| | `interrupt()` 是什么 | `dispose()` 做什么 |
|---|---|---|
| claude-code | SDK 的优雅停止（结束在途 turn，不是 kill 进程） | `controller.abort()` ⇒ SDK 杀掉仍在跑的子进程 |
| codex | `session.interrupt()`（发 `turn/interrupt`；协议能力，不 kill 进程） | `session.close()` 关掉 app-server 子进程 + 删本次运行的临时目录 |
| dsh | **刻意空实现**（不支持中途取消） | `runtime.close()`——唯一真实存在的终止通道 |

5 秒内没收场时：服务日志与**该行事件日志**各落一条 `[WARN] …（该适配器不响应停止信号，属已知能力差异）`，
然后强制 dispose。**非合作的适配器必须可见**，否则界面上会有一行永远停在 running 而没人知道为什么。

> ⚠️ 已知能力边界：`dispose()` 只能**尽力**让事件迭代结束——迭代卡在 `await` 上时，「关闭迭代」只是排队。
> 因此 **`run()` 可能无界返回**。「一行不会永远停在 running」这条用户可见的不变量由**编排层的兜底超时**
> 负责，不在本包。

### 5.3 事件流（`onEvent` 收到什么）

适配器只发三类事件，`status` / `diff-summary` / `score` / `end` 由编排层发：

| 事件 | 载荷 | 口径 |
|---|---|---|
| `log` | `{ stream: 'stdout' \| 'stderr', text }` | **未识别的厂商负载一律落成 log 并保留原始负载**，不得静默丢弃；唯一允许丢弃的是**重复事件** |
| `usage` | `{ tokens: {…} \| null, turns: number }` | 发射门槛是**轮次**不是 token：轮次一到就发，`tokens` 带的是「到目前为止」的累计值（一次没采到就是 `null`）；与上一条逐字段相同则不发 |
| `error` | `{ message, stack? }` | 失败结论的可见面（结论同时体现在 `AgentRunResult.error`） |

### 5.4 轮次（`turns`）与计量的口径

**轮次 = 一次模型 API 往返**：一次请求带着 `role=user` 的上下文、模型回一条 `role=assistant` 的答复，算一次。
三家各自从自己的事件流里数，**不混用「CLI 自己的 turn」**——codex 的 `turn.completed` 与 dsh 的 `turn/end`
都是**整段任务**一条（实测：真实 10 次模型调用只落 1 条），照它们数出来永远是 1，界面会一直停在「轮次 1」：

| | 计数键 | 保真度 |
|---|---|---|
| claude-code | 主循环 `assistant.message.id`（同一响应的多个内容块共享 id，去重后计数）；`parent_tool_use_id` 非空的子智能体消息不计 | 与 SDK 自己的 `maxTurns`（API round-trips）同口径；`num_turns` 只在我们一次都没数到时兜底 |
| codex | **模型答复条目**（app-server 的 `agentMessage`）的 `item.id`，**按线程分别去重**：主线程与子线程各数各的，收尾相加 | **近似值**：协议里没有逐次请求事件。误差方向如实登记：只发工具调用、**没有答复**的那几段**偏低**；一个答复条目都没有时轮次是 `null`（界面显示「未采集」，**不编 0**）。主线程与子线程共用同一把尺子，故 `subagentTurns ≤ turns` 成立 |
| dsh | `step/start`（实测序列 `turn/start → step/start → … → assistant/message → step/end → turn/end`） | 与 `assistant/message` 条数实测一致（59 = 59），而 `turn/end` 只有 1 条 |

计量的三条硬口径，三家和调用方都要守：

1. **采不到就是 `null`，绝不填 0**；
2. **估算值不进结果**（claude-code 的跑动期估算只走 `usage` 事件）；
3. `turns` 与 `tokens` **互不兜底**——轮次不因为 token 没采到就停涨，反之亦然。

---

## 6. 包边界与不变量（改代码前必读）

`src/index.ts` 的出口是**刻意收窄**的：`providers/*`、`runtime.ts`、`turn.ts`、`emit.ts`、`errors.ts`、
`json.ts`、`release.ts`、`route.ts`、`permission.ts`、`load-once.ts`、`testing/*` **一律不从包外可达**。

包内有几条**源码级**断言（`static-assertions.test.ts`，无运行期可观测量，只能扫源码）：

| 不变量 | 为什么 |
|---|---|
| 任何形式的 `process.env` **写入**都禁止（点号赋值 / 下标 / `Object.assign` / 自更新 / `delete` / `Reflect.set` / `defineProperty` / 裸令牌别名写入） | 并行跑多行时写入是**粘性**的：第二行起会拿到别人的凭据 |
| 厂商包只允许出现在**动态** `import()` 里，禁止顶层静态导入 | 静态导入会把「一家 SDK 故障」放大成「整包不可用」 |
| `src/**`（排除 `*.test.ts`，**不含** `probe/`）里不出现 `readdir` / `readdirSync` | 注册表必须显式静态注册：打包后目录扫描不可靠 |
| `dsh` 的 SDK 版本必须是 `0.1.x-rc.N` 精确值（不是 `latest` 线） | `latest` 线的 peer 依赖在本机装不上 |

厂商 SDK 的加载语义（`load-once.ts`）也是不变量：**函数作用域懒加载** + **只缓存成功的加载**
（一次镜像抖动不该毒化长驻服务的后续所有行）+ **注入优先**（测试注入表按包名查）。

## 7. 模块地图（包内维护者视角）

| 文件 | 职责 |
|---|---|
| `index.ts` | 唯一出口：注册表 + 类型 |
| `registry.ts` | kind → provider 的显式静态注册表（加第四家只改这里 + 新目录） |
| `types.ts` | 对外全部类型契约的真源 |
| `message.ts` | **三家共用的消息归一公共层**：覆盖合并（delta 追加 / snapshot 覆盖）、块序号分配、`messageId` 的 `seq`、工具归族（十个族名按工具名判）、`assembly` 收尾标记（spec v3 §6 的唯一一份实现） |
| `turn.ts` | **三家共用的运行骨架**：注入 → 消费事件流 → 释放 → 组装结果。判定优先级、轮次发射门槛、去重、消息合并器的接线都在这里，三家逐字一致（抄三遍必然漂移） |
| `permission.ts` | 权限档 → 三家厂商选项的映射表（唯一真源） |
| `route.ts` | base URL 归一 + 替换型子进程环境构造 |
| `release.ts` | 释放顺序、5 秒兜底、`createDisposer`（幂等关闭，绑定**被关闭的对象**） |
| `emit.ts` | 事件发射（补 `seq` / `at`）、未识别负载投影、`safeStringify` |
| `errors.ts` | 错误归因：HTTP 状态 → `AUTH_FAILED` / `RATE_LIMITED` / `AGENT_FAILED`；`AgentLoadError`（区分「包没装」与「装了但形状不对」） |
| `json.ts` | 任意负载的窄读取（不抛；Proxy / getter 抛错也当读不到） |
| `load-once.ts` | 厂商 SDK 懒加载 + 只缓存成功 + 测试注入优先 |
| `runtime.ts` | 测试注入点：`sdkModule`（包名 → 模块命名空间） |
| `providers/<kind>/{index,sdk,events}.ts` | 一家的三件事：适配器本体 / SDK 窄结构（唯一知道厂商入口形状的地方）/ 事件投影 |
| `providers/<kind>/message.ts` | 一家的**消息归一**（spec v3 §2）：把厂商载荷折成统一的 `AgentMessage` 与子任务行。三家的形状差异由 `src/message.ts` 的公共层吸收，这里只负责取值路径 |
| `testing/agent-fixtures.ts` | 假厂商件：单测「不碰真实 API、不碰真实 CLI」的全部物质基础 |
| `probe/` | 真实事件探测的产物：`raw-events.mts` 脚本 + `dumps/*.json`（三家入口形状与事件原文）。**不在** `src/**` 的源码级断言扫描面内 |

## 8. 测试：怎么替换掉真实厂商

单测**完全不碰真实 API 与真实 CLI**，靠两件事：运行时注入表 + 假厂商件。
下面的例子是**包内用例**的写法（相对导入、直接拿 provider 本体）；包外消费方接不到 `testing/*`，
要伪造适配器请 `vi.mock('@aieval/agents')`。

```ts
// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { claudeCodeProvider } from './providers/claude-code/index';
import { CLAUDE_PACKAGE_NAME } from './providers/claude-code/sdk';
import { setAgentRuntimeForTesting } from './runtime';
import { createFakeClaudeSdk, createRecorder, createRunInput } from './testing/agent-fixtures';

afterEach(() => setAgentRuntimeForTesting(null));   // 用例结束必须复位，否则污染同进程的其他用例

it('注入落点与结果贯通', async () => {
  const recorder = createRecorder();
  setAgentRuntimeForTesting({
    sdkModule: {
      [CLAUDE_PACKAGE_NAME]: createFakeClaudeSdk({
        recorder,
        events: [{ type: 'result', subtype: 'success', result: '改完了', usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 } }],
      }),
    },
  });

  const result = await claudeCodeProvider.run(createRunInput({ permission: 'read-only' }));
  // 可观测量：recorder.order（interrupt → turn-end → dispose 的顺序）、recorder.env（厂商拿到的子进程环境）、
  // recorder.options（注入的客户端选项）、recorder.closeCount（dispose 幂等）
  expect(result.ok).toBe(true);
  expect(recorder.env?.CLAUDE_CONFIG_DIR).toBe('D:/tmp/rows/row-1/.agenthome');
});
```

要点：

- 三家**共用** `sdkModule` 一个字段（不另起名字），一张假模块表能同时喂饱三家；
- 注入值**不缓存**：测试可以在同一进程里从「坏模块」换到「好模块」，验证「一次加载失败不会毒化后续运行」；
- 假件要**保真**（真生成器的排队语义、dsh 订阅 `close()` 会 reject 挂起的等待者）：夹具悄悄变弱时用例
  只会变成**假绿**，而不会变红——所以夹具自己也有回归网（`agent-fixtures.test.ts`）；
- 事件断言用 `collectEvents(sink)` 收 `AgentEvent`；假定时器下推进 promise 用 `settleWithFakeTimers`。

### 8.1 新增一家 SDK：接入清单与验证点

加一家时按序做这七步，每步都有可执行的判据。**顺序不能颠倒**——前三步的缺陷只有真机能拦，后面几步拦不住它们（2026-10-07 的 codex 改造即实例：agents 包 585 条全绿，真机上连挂「打包器把 `createRequire` 换掉」与「凭据/provider 没传到厂商进程」）。完整方案（失败分类学、四层结构、为什么不写假 SDK 替代真机）已熔炼进知识库 `docs/protocols/sdk-onboarding.md`（新增 SDK 接入流程）。

| # | 步骤 | 判据 |
|---|---|---|
| 1 | 写**能力声明**（§2.7 五态 × 五格 + `notes` 写清路由/模型前提） | 契约层「能力声明自身合规」 |
| 2 | 定**厂商入口的定位方式**（静态 import？子进程？）；走子进程就必须打包器免疫 | 静态层「打包器免疫」（`static-assertions.test.ts`） |
| 3 | 定**凭据与 provider 的传递**：密钥进子进程环境；provider 条目名与 `model_provider` 类字段**成对**给出；base_url 归一（该补 `/v1` 就补） | 真机冒烟第 ② 格 |
| 4 | 写 fixture 场景，**至少覆盖能力声明里所有 `yes` 的那几格** | 契约层「能力声明与产物互钉」 |
| 5 | 接**生命周期**：取消能终止在途轮次、`dispose` 真正回收子进程、清理遇 `EPERM` 重试 | 集成层 + 真机冒烟第 ①/③ 格 |
| 6 | 登记**缺失**：§7 缺失影响矩阵里每一格要么有产物、要么有 `MissingReason` | 契约层「缺失必须带原因」 |
| 7 | 跑**真机冒烟**，把四格证据写进当次关账记录 | 见下 |

**契约层**（与厂商无关，任何一家都得过；一次接入的全部成本就是一个 fixture）：

```ts
// providers/<kind>/conformance.test.ts
describeProviderConformance({
  kind: '<kind>',
  capability: codexProvider.metadata.messageCapability,   // 本家的能力声明
  scenarios: { 'plain-reply': () => …, 'thinking-full': () => …, subagent: () => … },
});
```

判据逐条挂在规范条目上：信封 §2.1 / 内容块 §2.2 / 行级事件 §2.3 / 计量 §2.4–2.6 / 能力声明 §2.7（含与产物**互钉**）/ 子任务桥 §2.8 / 环境 §2.9 / 行结果 §2.10 / 工具族 §5 / 合并键 §6.2。**形状不在这里重复写**——它由 `@aieval/contracts` 的 zod schema 管，套件只补 schema 表达不了的语义不变量（两份形状必然漂移）。

**真机冒烟**（装载与传输两类缺陷的**唯一**拦法；默认跳过，不进内循环）：

```bash
AIEVAL_LIVE_SMOKE=1 AIEVAL_LIVE_KIND=codex \
AIEVAL_LIVE_PROVIDER_ID=<provider uuid> AIEVAL_LIVE_MODEL_ID=<model id> \
pnpm vitest run packages/server/agents/src/providers/live-smoke.test.ts
```

四格：① **装载**（没有落到入口解析/加载类失败）② **传输**（服务端记录的路由与本次选择一致、且不是凭据类失败）③ **产物**（跑到 `judged` 且有分数）④ **形状**（`messages` 接口的**线上形态**逐个过 schema）。`AIEVAL_LIVE_KIND` **必填**——不给默认家，避免「默认跑的那家绿了就当四家都绿」。

## 9. 常见坑

| 现象 | 原因 / 处置 |
|---|---|
| 某家全部 0 改动，评分照样出分 | 权限档没生效。claude 检查 `allowDangerouslySkipPermissions` 是否成对给出；Windows 上另查 8.3 短名路径（已由 `canonicalCwd` 处理） |
| codex 装依赖 / 跑测试失败 | 用了 `workspace-write`：它默认**关掉网络**，执行阶段必须是 `danger-full-access` |
| codex 每次都报 `Codex Exec exited with code 1`，正文是 `Reading prompt from stdin...` | 那句是 CLI **每次都会打**的提示、零信息量。真正的失败原因在事件流里（已由骨架保留并把退出码写成补充）；stderr 全文在日志抽屉 |
| 界面上的轮次停在 1 | 别用 CLI 自己的 `turn.completed` / `turn/end` 数轮次（整段任务一条）；按 §5.4 的键去数 |
| 拉不到厂商包 / 报 `AGENT_LOAD_FAILED` | 两类语义要分开看文案：`missing`（没装，装法在文案里）与 `shape-mismatch`（装了但导出面变了 ⇒ **不要重装**，是回写问题） |
| 点「终止」后 dsh 行晚 5 秒才变 `canceled` | 是设计：`cancelMidTurn: false`，只能走释放的第二段（等 5 秒 + 落 WARN + 强制关闭） |
| 想让某家超时 | 本包**没有**内层超时（刻意的：执行与评分都不限时间）。超时由编排层负责，并且它无法中断一个卡住的迭代 ⇒ 该行的收敛靠兜底上限 |
| 拿 `kind` 直接调 `getProvider` 报 500 | 配置里的 kind 不是枚举值（`loadConfig` 不做 zod 校验）。调用方先判 `AGENT_KINDS`，折成可处置的错误 |
| 评分智能体把工作区改了 | 评分阶段忘了传 `permission: 'read-only'`（或用了 claude 的 `plan`——它连 `git diff` 都跑不了） |

## 10. 术语对照（读代码注释前先看这里）

本包注释里有一批反复出现、且有**固定含义**的说法，都不是随口形容：

| 说法 | 含义 |
|---|---|
| **采不到就是 `null`，绝不填 0** | 全包最硬的一条口径。0 是「采到了，值就是 0」，与「没采到」含义相反；混淆会让人得出「这家很省 / 这位候选没干活」的错误结论。`tokens` / `turns` / `finalText` 都按它办 |
| **估算 vs 上报** | 跑动期的用量有两种：`estimated`（推理出来的、只给界面看）与 `reported`（适配器上报值与终值同口径、可以落盘）。判据挂在**每一条 `usage` 事件**自带的 `tokensBasis` 上（A2，见 `@aieval/contracts` 的 `agent-event.ts`）——它是事件的性质，不是某一家的静态能力声明 |
| **轮次** | **一次模型 API 往返**，不是「CLI 自己的 turn」（那是整段任务一条）。见 §5.4 |
| **替换型子进程环境** | 以宿主环境为底、覆盖 `HOME` / `USERPROFILE` 与厂商变量后**整体交给**子进程，而不是往 `process.env` 里塞。并行多行时后者会互相串凭据 |
| **幂等关闭 / 恰好关一次** | `dispose()` 可能被「用户终止」与「兜底超时」先后触发，因此必须幂等；`createDisposer` 把「恰好一次」绑到**被关闭的那个对象**上（而不是运行时级闭锁，那会让新建的客户端没人关） |
| **受保护发射** | 调 `onEvent` 一律包在 try/catch 里：那是**消费方**的代码（写盘 / 推流都会抛），而 `run()` 承诺「永不抛」 |
| **`AGENT_*` 错误码** | 领域归因码（`AGENT_LOAD_FAILED` / `AGENT_FAILED` / `AGENT_TIMED_OUT` / `AGENT_CANCELED` / `AUTH_FAILED` / `RATE_LIMITED`）。**不是** contracts 的 `ErrorCode`：它没有 HTTP 状态，落点是该行的事件日志，不要塞进 `ERROR_CODES` |
| **`§5.6.x` / `R33` 这类编号** | `§` 指向 spec / 计划的章节；`R` 是**裁定项编号**（对上游事实的裁决，例如 R33 = dsh 依赖走 `next` 线而不是 `latest`）。这些编号指向的设计 spec 与冒烟记录已熔炼进知识库（`docs/protocols/` 下各篇），注释里的「实测」指那里 |
| **p3 / p4 / p5 / p6** | 历史实施计划的阶段代号（p3 适配器（本包）、p4 编排与评分、p5 评测域接口与界面、p6 真实冒烟与关账）；这些计划已按 ADR 0001 熔炼进知识库 |

## 11. 相关文档

- 根 [`README.md`](../../../README.md)：产品口径、使用手册、数据落在哪、排障表。
- [`AGENTS.md`](../../../AGENTS.md)：分层边界与工具链坑（改代码前先读）。
- [`docs/`](../../../docs/)：知识库（协议规范 / 功能说明 / 架构设计 / FAQ / 规约守卫五域，AGENTS.md「知识库」节）；历史设计 spec 与冒烟记录已按 ADR 0001 熔炼进知识文章
  （三家 SDK 的入口形状、事件 dump、权限档实测都记在那里，本包注释里的「实测」指的就是它们）。
