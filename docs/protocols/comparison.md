# 三家横向对比

## 定位

claude-code / codex / dsh 三家厂商智能体的逐项对照：接了三家之后，差异吸收在各自适配器里，但选型、写跨厂商代码、排障时需要一张按维度的对比表。命名不是对齐键——对齐只在语义类别层做。

## 形态与交互

**接入形状总表**：

| 维度 | claude-code | codex | dsh |
|---|---|---|---|
| 厂商包 | `@anthropic-ai/claude-agent-sdk` | `@openai/codex` | `@deepseek-ai/dsh-sdk-client`（next 线，R33） |
| 驱动形态 | 进程内 SDK，spawn 原生 CLI | `codex app-server`（JSON-RPC/stdio） | SDK spawn 运行时，通知流 |
| `protocolTypes` | `['anthropic']` | `['openai']` | `['openai','anthropic']`（双协议一家，两条 wire 统一走 pi-ai 路由） |
| base URL 处理 | **剥**尾部 `/v1`（SDK 自己追加 `/v1/messages`） | **补** `/v1`（CLI 只走 `POST {base}/v1/responses`） | 按 wire 分叉：anthropic 剥、openai 补（pi-ai 不归一化） |
| 配置目录 | `CLAUDE_CONFIG_DIR` + `HOME` | `CODEX_HOME` + `HOME` | `DSH_HOME`（**不是** HOME） |
| `cancelMidTurn` | true | true | **false**（终止晚 5 秒是设计） |
| `structuredOutput` | true（`options.outputFormat`） | true（`turn/start` 的 `outputSchema`） | **false**（SDK 无此格，骨架摘格 + 有痕降级） |
| 权限 full 档 | `bypassPermissions` + `allowDangerouslySkipPermissions: true`（必须成对） | `danger-full-access`（`workspace-write` 默认关网络） | `DSH_PERMISSION_MODE=danger-full-access` |
| 权限 read-only 档 | `dontAsk`（刻意不是 `plan`） | `read-only`（**Windows 上落 `danger-full-access`**） | `DSH_PERMISSION_MODE=read-only` |
| 流式增量 | **yes**（`includePartialMessages: true` 常开，`stream_event`；**仅主会话**） | **yes**（`item/agentMessage/delta` + 两条 reasoning delta；`plan` / `commandExecution` 两条显式丢+计数） | **yes**（`source: 'hook'`：通知层没有 delta ⇒ 插件旁路 sidecar 文件 + 100 ms tail，见《接入》「流式增量旁路」） |
| 消息级 usage | 恒 `null`（wire 上 `output_tokens` 恒 0） | 恒 `null`（协议只到线程级） | **有**（`assistant/message` 的 `data.usage`） |
| `reasoningTokens` | `output_tokens_details.thinking_tokens` | 按线程累计（`input − cached`） | 恒 `null`（路由 `mapUsage()` 有意不投影） |
| `apiMs` / `ttftMs` | 有（三家唯一） | 恒 `null` | 恒 `null` |
| effort off 落点 | `thinking:{type:'disabled'}` + env 覆盖层（两半各管一批模型） | `effort:'none'` + `model_reasoning_summary:'none'`（后者空转）；**off 关不掉思考（未闭合）** | `thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`（真机 0/0 成立） |
| 终结信号 | `result` 消息恰好一条 | 主线程那条 `turn/completed`（按 `threadId` 认） | `turn/end`（`status` + `stopReason` 两格合读） |

**内置工具交集**（精确同名）：dsh ∩ codex = `create_goal` / `get_goal` / `update_goal` / `web_search`；claude 与另两家**精确同名交集为空**；三家忽略大小写同为空 ⇒ 命名不是对齐键，族映射按语义类别做。异名同义例：codex `exec_command` ↔ dsh `pwsh`；claude `Task` ↔ `Agent` 是同一工具两种叫法。工具表项数随模型与开关浮动（claude 实测 23–30、dsh 24、codex 10），能力声明必须带前提。**别名要逐个登记**：真机这批数据里 dsh 跑命令用的是 `bash` 而不是表里原有的 `pwsh`（7 次调用全是 `bash`），漏登记不会报错、只会让摘要退化成紧凑 JSON 且族标签消失 ⇒ 别名由 `tool-family.test.ts` 逐字钉住。

**叙述性字段（「模型自己写的一句话」）三家不一致**（一手证据：官方 SDK 类型、`codex app-server generate-ts` 的生成物、DSH `tool-catalog` 与本地包 schema）：

| 家 | 有这一格的工具 | 逐字字段名 | 必填性 | 我们读得到吗 |
|---|---|---|---|---|
| claude-code | `Bash` | `description` | **可选**（CLI 侧另有 `getToolUseSummary` 兜底合成一句，但那**只在 CLI 的 UI 层、不走 wire**） | 读得到 |
| claude-code | `Agent`（旧名 `Task`）/ `Monitor` / `TaskCreate` | `description` | 必填 | 读得到 |
| dsh | `bash` / `pwsh` / `subagent` | `description` | **必填**（JSON Schema `required` + 运行期校验 `invalid description: expected a non-empty string`） | 读得到 |
| codex | `update_plan` | `explanation` | 可选 | **读不到**：`TurnPlanUpdatedNotification.explanation` 协议面上有（本机 0.156.1 生成物逐字），但本仓 `appserver/protocol.ts` 的窄声明未收 ⇒ `payload.note` 恒 `null`（未闭合，见 FAQ） |
| codex | `exec_command` | `justification` | 可选（**审批语义**） | **读不到**：`ThreadItem.commandExecution` 的字段里没有它（协议面就丢了） |
| codex | `command_execution` / `apply_patch` / `web_search` / `dynamicToolCall` / `collab_tool_call` | — | — | 协议里**真没有**这一格 |

依据：Claude `BashInput.description` 的官方注释逐字 *"the user reads this description, often without seeing the command"*（`sdk-tools.d.ts`）；DSH 同一格的说明逐字 "…(shown in the UI)"。**所以「优先 `description`」在 claude 与 dsh 上立刻兑现，在 codex 上一笔都兑现不了**——codex 的摘要只能走「族拼法」（`exec_command` 给命令原文、`apply_patch` 给改动清单）。这不是实现偷懒，是协议与通道的差异，横向对比时会被反复问到，故记在这里。

**skill 注入对照**（三家都无编程式注册，skill 只能以文件落盘）：claude 三条加法（项目 `.claude/skills/` / 用户 `$CLAUDE_CONFIG_DIR/skills/` / 插件 `plugins`）+ 两个开关（`settingSources` / `skills`）；dsh 三条加法（`$DSH_HOME/skills/` / overlay `customSkillDirs` / 项目根 `.dsh/skills/` 自动发现）+ skill 根表 rank；codex 走 `config.mcp_servers` 同款配置面（snake_case）。三家共同坑：**项目根自动发现是跨家口径的静默差异**（被测仓库自带的 skill 目录会被启用）。

**MCP 接法对照**（三家注入落点与判据通道均已真机验证；配置面、逐字形状与完整边界见[《MCP 配置》](/features/mcp-config)）：

| 维度 | Claude Code | Codex | DeepSeek Harness |
|---|---|---|---|
| 注入通道 | SDK 参数 `Options.mcpServers`（不落 `<configHome>/.claude.json`） | **线程级** `config.mcp_servers`（随 `thread/start`；退路 `$CODEX_HOME/config.toml`） | per-launch overlay（`aieval-route.patch.yml`）的 `insert` 插件行 |
| 传输名 | `stdio` / `http` | **无 `type`**（靠字段推断） | `stdio` / `streamable-http` |
| http 的头叫 | `headers` | **`http_headers`** | `headers` |
| stdio 的 `cwd` | **没有这个字段** | 没有（继承 app-server 的 cwd） | 没有（继承 harness 的 cwd） |
| 额外格 | — | `startup_timeout_sec`（本仓给 30 s） | `serverName` / `toolCallTimeoutMs` / `failOnStartupError`（默认 false） |
| 判据来源 | `system/init` 的 `mcp_servers[].status` **+ 工具表**（工具表更硬） | `mcpServer/startupStatus/updated`（带 `error` 原文） | **只有** `request/header` 的 `data.header.tools` |
| 失败长什么样 | `status: 'failed'` | `startupStatus: 'failed'` + `error` | **静默**：工具消失、会话照常跑完、无结构化错误 |
| 判据到什么档 | 已连上（工具表里有 `mcp__<name>__`） | **只到「装上了」**——自定义网关下有 `unsupported call` 的上游缺口 | 已连上（表里有 `mcp__<serverName>__*`） |

- 工具名三家一致：`mcp__<server>__<tool>`；**同名优先级只有 claude 实测过**（程序化注入赢、只留一条，`strictMcpConfig` 关闭 ⇒ 不压制仓库自带），codex / dsh 两家**未证实**（均无已知的项目级 MCP 自动发现）。
- 三家都把各自的厂商信号归一成同一条 `vendor-system` 事件并用 `mcpChannel` 自报通道（`vendor-status` / `vendor-startup-status` / `vendor-tool-table`），行级观测格（`EvalRow.mcpServers`）据此给出 `connected` / `unavailable` / `unverified` / `skipped` 四档结论；**`unverified` 不许写成「已连上」，也不许写成「没有」**。
- 三家都把行内首次下载的成本留给了行：playwright MCP 首次 **17.2 s / 61 MB**（宿主 registry 是公网时）⇒ 等待预算 ≥ 20 s，缓解手段（行内 `.npmrc` 只写宿主 registry 那一行）三家共用同一处实现。

## 数据与契约

- **用量合计口径三家不同源**：claude 从 `result.usage`（跑动期按同 `message.id` 后到覆盖求和作估算）；codex 只从 `thread/tokenUsage/updated` 通知累计（全树合计，任一子线程缺 ⇒ 两分量同时 null）；dsh 事件投影不按会话分流（用量轮次含子智能体是构造上如此，分量按行内白名单求和）。
- **思考正文**：claude `thinking` 块（含 signature）；codex `reasoning.content[]` 快照 + `textDelta` 增量（`exec --json` 恒 0 条别再用）；dsh `assistant/message` 整块。空文本一律记 `text: null` + `textKind: 'none'`（不回落 summary）。
- **子任务身份**：三家都是厂商原生 id（claude 任务 id / codex 线程 id / dsh 子会话 id）；`parentCallId` 是消息与子任务记录之间唯一的桥——dsh 恒 `null`（真机载荷无可对齐的调用 id，不猜）。

## 状态机与时序

三家收尾取数路径：claude 读 CLI 落盘转录（子智能体用量唯一权威源，只在收尾一次）；codex 收尾 `thread/list` + 逐线程 `thread/read`（必须在 `finalize` 前落定）；dsh 无收尾取数（读数都在通知流里）。共同铁则：**「等一个终态再取数」先问这是哪条线程 / 哪个会话的终态**。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| 工具表 / 能力**随模型名与路由翻转**（`spawn_agent` 在 DeepSeek 路由跑通、内网网关 `unsupported call`） | 能力声明必须带前提；对比表数字标注「一次实测快照」 |
| effort 档位强度的效力三家都未证实（同档抖动不小于档间差） | 只展示「我们要求的档位」 |
| 跨家比较轮次先核对口径（`roundTrip` 三家合成方法不同） | 「同口径可比」+ `source` 标注，不是「跨三家可比」 |

## 相关链接

- 知识文章：[《Claude Code 接入》](/protocols/claude-code)、[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)（字段级细节）、[《MCP 配置》](/features/mcp-config)（三家 MCP 接法的配置面与失败判据）、[《消息规范》](/protocols/message-spec)（归一契约）、[《进程生命周期》](/protocols/process-lifecycle)、[《Provider 抽象与 run 入口》](/protocols/provider-run)
- 活文档：三份厂商 FAQ（[Codex](/faq/codex) / [Claude Code](/faq/claude-code) / [DeepSeek Harness](/faq/deepseek-harness)）——按报错原文 grep
