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
| 流式增量 | 声明 yes 但 `includePartialMessages` 未开（仅主会话） | yes（`item/*/delta`） | **not-projected-by-vendor**（通知层没有 delta——文档说的层 ≠ 能拿到的层） |
| 消息级 usage | 恒 `null`（wire 上 `output_tokens` 恒 0） | 恒 `null`（协议只到线程级） | **有**（`assistant/message` 的 `data.usage`） |
| `reasoningTokens` | `output_tokens_details.thinking_tokens` | 按线程累计（`input − cached`） | 恒 `null`（路由 `mapUsage()` 有意不投影） |
| `apiMs` / `ttftMs` | 有（三家唯一） | 恒 `null` | 恒 `null` |
| effort off 落点 | `thinking:{type:'disabled'}` + env 覆盖层（两半各管一批模型） | `effort:'none'` + `model_reasoning_summary:'none'`（后者空转）；**off 关不掉思考（未闭合）** | `thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`（真机 0/0 成立） |
| 终结信号 | `result` 消息恰好一条 | 主线程那条 `turn/completed`（按 `threadId` 认） | `turn/end`（`status` + `stopReason` 两格合读） |

**内置工具交集**（精确同名）：dsh ∩ codex = `create_goal` / `get_goal` / `update_goal` / `web_search`；claude 与另两家**精确同名交集为空**；三家忽略大小写同为空 ⇒ 命名不是对齐键，族映射按语义类别做。异名同义例：codex `exec_command` ↔ dsh `pwsh`；claude `Task` ↔ `Agent` 是同一工具两种叫法。工具表项数随模型与开关浮动（claude 实测 23–30、dsh 24、codex 10），能力声明必须带前提。

**skill 注入对照**（三家都无编程式注册，skill 只能以文件落盘）：claude 三条加法（项目 `.claude/skills/` / 用户 `$CLAUDE_CONFIG_DIR/skills/` / 插件 `plugins`）+ 两个开关（`settingSources` / `skills`）；dsh 三条加法（`$DSH_HOME/skills/` / overlay `customSkillDirs` / 项目根 `.dsh/skills/` 自动发现）+ skill 根表 rank；codex 走 `config.mcp_servers` 同款配置面（snake_case）。三家共同坑：**项目根自动发现是跨家口径的静默差异**（被测仓库自带的 skill 目录会被启用）。

**MCP 接法对照**：claude `Options.mcpServers`（经 `--mcp-config` 内联 JSON，4 种传输，stdio **无 `cwd`**）；codex `config.mcp_servers.<name>`（snake_case，传输靠字段推断**无 `type`**，超时 30s/300s）；dsh 一台 server = 一个插件行（封闭方法表 ⇒ 只能走配置文件，2 种传输，`failOnStartupError` 默认 false）。工具名三家一致：`mcp__<server>__<tool>`。

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

- 知识文章：[《Claude Code 接入》](/protocols/claude-code)、[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)（字段级细节）、[《消息规范》](/protocols/message-spec)（归一契约）、[《进程生命周期》](/protocols/process-lifecycle)、[《Provider 抽象与 run 入口》](/protocols/provider-run)
- 活文档：三份厂商 FAQ（[Codex](/faq/codex) / [Claude Code](/faq/claude-code) / [DeepSeek Harness](/faq/deepseek-harness)）——按报错原文 grep
