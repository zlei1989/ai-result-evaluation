# Codex 接入

## 定位

Codex 的适配器完全由 `codex app-server` 驱动与取数（JSON-RPC over stdio），厂商包是 `@openai/codex`（纯 JS 启动器，原生二进制在平台包 `@openai/codex-<platform>-<arch>` 的 `vendor/<triple>/bin/codex(.exe)`）。协议能力面与 DSH 逐格对齐且不降级，`cancelMidTurn` / `structuredOutput` / 子任务父链与昵称深度 / `reasoningOutput` / 用量合计是 Codex 更强的格子。能力声明：`protocolTypes: ['openai']`，`cancelMidTurn` / `usage` / `structuredOutput` 三格全 `true`。

## 形态与交互

- **进程与帧**：TS 侧没有官方 app-server 客户端，适配器自建客户端——stdio 传输、**行分隔 JSON 帧**，只做 spawn / 握手 / 请求响应配对 / 收通知；坏帧计数不静默（`unparsedFrames()` 可查）。
- **一次运行一个 app-server 进程**：收尾取数复用同一客户端——线程树是该进程的内存态，进程没了树就没了。
- **握手顺序固定**：`initialize`（带 `experimentalApi`）→ `thread/start`（返回 `threadId`）→ `turn/start`（返回 `turnId`）。
- **URL 规则**：base 必须补 `/v1`（`ensureV1Suffix` 不能省）——CLI 在 base_url 后直接拼 `/responses`，故本仓统一打 `POST {base}/v1/responses`。
- **wire 只能钉 Responses**：`wire_api` 只接受 `responses`；`chat` 及别名（`chat_completions` / `openai-chat` / `completions`）全被拒，`thread/start` 响应 `-32600`，报错原文：
  ```text
  failed to load configuration: `wire_api = "chat"` is no longer supported.
  How to fix: set `wire_api = "responses"` in your provider config.
  More info: https://github.com/openai/codex/discussions/7782
  ```
  根因不是配置写法：codex 客户端已删除 chat 实现（实测 0.156.1 二进制里 `chat/completions` / `v1/chat` / `use_chat_completions` 零命中；0.160.1 的 `WireApi` 枚举只剩 `Responses`），升级也换不回来。
- **注入落点**：线程级 `config` 由 `buildCodexConfig` 构造——`model_provider: 'aieval'` + `model_providers.aieval{ name, base_url, wire_api: 'responses', env_key: 'OPENAI_API_KEY', request_max_retries: 1 }` + `tools: { web_search: false, update_plan: { enabled: true } }` + `features: { multi_agent: true }`；`model_context_window` / `model_reasoning_summary` 只在已知时出现。
- **权限档按平台选**：Windows 上只有 `danger-full-access` 能真正起子进程（`read-only` 与 `workspace-write` 下连 `echo` / `git status` 都被拒，stderr 原文 `Rejected(\"… rejected: blocked by policy\")`）；macOS（seatbelt）与 Linux（landlock）不动。兜底：编排层「评分前后 diff 摘要对照」从 WARN 升级为行失败。
- **停止与释放顺序固定**：`interrupt()`（发 `turn/interrupt`，是协议能力、不 kill 进程）→ 等在途 turn 终结（最多 5 秒）→ `dispose()`（`session.close()`：**杀整棵进程树并等 exit** + 删临时目录；Windows `taskkill /T /F`，POSIX 进程组 `SIGKILL`）。被终止的那一轮不等收尾取数；起手三步失败也要回收（`close()` 杀树失败退回直接 kill，等不到就如实回 `exited: false` 由调用方 WARN）。

## 数据与契约

协议条目到本仓契约的映射（`turns` 是近似值——一条 Turn 内含多次模型往返）：

| app-server 协议条目 | 契约投影 |
|---|---|
| `item/agentMessage/delta` | `textBlockDraft(text, 'delta')`，`streamingDelta` 标 `yes`/`wire` |
| `item/completed(reasoning).content[]` | `thinking{ textKind: 'full' }`；`content` 空 ⇒ `text: null` + `'none'`（不回落 summary） |
| `reasoning.summary[]` | `thinking{ textKind: 'summary' }` |
| `commandExecution` | 工具调用 + 结果块（命令 / 输出 / 退出码 / 耗时） |
| `fileChange` | `toolCallBlockDraft('apply_patch', …)` + `structured = { changes, status }` |
| `mcpToolCall` | `name = '<server>.<tool>'`、`family: null`、`isError = error != null` |
| `plan` / `turn/plan/updated` | `family: 'task'` + `payload: { kind: 'plan', steps, note }` |
| `collabAgentToolCall` / `subAgentActivity` | 子任务行（身份 / 派发配对 / 终态三档） |
| `turn/completed` | 用量 + 时长（`timing{ source: 'events' }`，`apiMs` / `ttftMs` 恒 `null`） |
| `thread/tokenUsage/updated` | 按线程用量累计（`input − cached`） |

- **`finalText` 出口四条件缺一不可**：`itemCompleted`（`item/started` 正文可能半截）、`agentMessage`、主线程（子线程结论不顶主会话）、正文非空。评分通路只读 `finalText`，不从事件流重建——app-server 重构曾漏写这一格，表象是 `JUDGE_PARSE_FAILED：评分智能体没有给出可读的最终答复（该适配器未回传最终消息）`（会话 `ok=true`、上游也回了 JSON，只有本仓交不出答复）。
- **思考块规则**：`item/started` 的空占位不产块；`reasoningDrafts` 无条件补快照封口（同内容重发幂等覆盖）；界面层对无正文的思考块整块隐藏，不给占位文案。
- **读取契约**：只声明消费得到的字段，读不到就是 `null`——不做默认值填充、不用空串或 0 冒充「没采到」。
- **用量口径**：只从运行期 `thread/tokenUsage/updated` 通知累计（协议没有「按线程读用量」的请求，`thread/read` 不返回用量）；`total` 是全树合计（主会话 + 数到的每个子智能体），任一子线程拿不到用量 ⇒ `subagentTokens` / `subagentTurns` 两分量同时 `null` 并落点名 WARN。三条硬口径：采不到就是 `null` 绝不填 0；估算值不进结果；`turns` 与 `tokens` 互不兜底。
- **轮次口径**：数模型答复条目（`agentMessage` 的 `item.id`），按线程分别去重、收尾相加；只发工具调用没有答复的段偏低（近似值），一个答复都没有时 `null` 不编 0。

## wire 形态与事件

本仓消费的通知通道全集（未识别方法归 `other` 不抛错）：

```text
thread/started
thread/status/changed
turn/started
turn/completed
item/started
item/completed
item/agentMessage/delta
item/reasoning/textDelta
item/reasoning/summaryTextDelta
item/plan/delta
item/commandExecution/outputDelta
thread/tokenUsage/updated
turn/plan/updated
```

- **`item/*` 通知无条件下发**，不受 `show_raw_agent_reasoning` 之类开关影响（那些只作用于 legacy 投影与 TUI / exec 输出）。
- **审批类是 server→client 请求**（`item/…/requestApproval`，带 `id`）：单独归类、**不回帧**——`approvalPolicy: never` 下应答等于替用户批准。
- **结构化输出的 wire 落点**：`turn/start` 一等字段 `outputSchema`（协议原文「Optional JSON Schema used to constrain the final assistant message for this turn」）落到 Responses 请求的 `text.format = { format: { type: 'json_schema', strict: true, name: 'codex_output_schema', schema: … } }`。A/B 真机对照证明 schema 真被执行：对抗题面「请用中文散文回答，不要输出 JSON」——带 schema 回仍是 JSON（模型 reasoning 自述「the response format schema is enforced by the system. I must comply with the schema」），不带回中文散文。
- **推理正文（reasoning）现口径**：`codex exec --json` 里 `item.type === 'reasoning'` 恒 0 条（exec 的 JSONL 投影只取 `summary` 丢弃 `content`）——**取思考内容一律走 app-server**。快照取 `item/completed` 的 `reasoning.content[]`（一项即全文，实测 4 case 117 / 227 / 151 / 278 字；`item/started` 那帧两格都是空数组，别在 started 取值）；增量 `item/reasoning/textDelta` 逐字拼接后与 `content[0]` 完全相等（4/4，实测 39 / 54 / 49 / 72 条，条数恰等于 `reasoningOutputTokens`，1 delta ≈ 1 token）。摘要在 DeepSeek 网关上结构性拿不到（`summaryTextDelta` 恒 0 条，上游不给），`model_reasoning_summary` 不设或写 `auto`；`effort === 'off'` 时注入的 `CODEX_OFF_REASONING_SUMMARY = 'none'` 真机上既不报错也不影响推理照常产出（空转格，别指望它关掉任何东西）。
- **线程树**：`thread/list{ ancestorThreadId }` 一次返回任意深度的全部后代（分页 `limit` 100、`nextCursor` 续读；不含主线程自身）；深度与昵称取厂商声明 `source.subagent.thread_spawn`（`{ depth, agent_path, agent_nickname }`），不按链长推算——旧 SDK 时代的深度 8 / 广度 32 上限不复存在。子智能体工具是 `collabAgentToolCall`（`spawnAgent` / `wait` / `closeAgent`），`wait` 的 `agentsStates[<childId>].message` 直接是子智能体结论原文。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| 带 `outputSchema` 的一轮跑满 180s 无答复（`settle=timeout`；同题面对照组 94s；复跑 1.7s 正常） | 未定位 | 与结构化输出的因果关系未证实；下一步带 relay 复现（`probe/v4 only=schema timeoutMs=420000`），判据「有没有 `response.completed`」 |
| 消息级用量 | 结构性缺 | app-server 只到线程级 ⇒ `AgentMessage.usage` 恒 `null`，点名记录，不用近似值顶替 |
| 只回密文路由的推理明文 | 结构性缺 | `content[]` 为空 ⇒ `text: null` + `'none'`，不回落 summary |
| 审批 / 问用户 | 结构性缺 | 协议形态是 server→client 请求，本仓不应答 ⇒ `unavailable`，不合成消息 |
| 轮次近似 | 取舍 | `Turn` ≠ 一次往返；与 `subagentTurns` 同一把尺，无答复条目时 `null` |
| 二进制解析「第二跳基准」守卫缺口 | 未闭合 | vitest 里裸说明符解析被运行器接管比生产宽松，基准改错仍绿；两条闭合路径（真 Node 子进程验 / 形状式源码断言）都未做，如实登记 |
| 平台包空壳（`@openai/codex-darwin-arm64` 只剩空壳 ⇒ `Cannot find module '@openai/codex-darwin-arm64/package.json'`） | 环境坏 | pnpm 的「已安装」真源是 `node_modules/.pnpm/lock.yaml`，不校验盘上文件——`--frozen-lockfile` / 重装 / `--force` 全部无效；修法：取镜像 tarball 校验 `shasum` 后手工物化到 `.pnpm` 位置（保住 `0755`）；判据：真 Node 两跳解析通过、`codex --version` ⇒ `codex-cli 0.156.1`；清空 `node_modules` 重装会重踩 |
| 插件 startup sync（`thread/start` 时同步 curated 插件目录，spawn `git` 孙进程链） | 未闭合 | 线程级 `config` 管不到它（`features.plugins=false` 只有盘上 `config.toml` 或 `-c` 生效）；处置是 `close()` 异步杀整棵树并等 exit；真机守卫 `AIEVAL_LIVE_DISPOSE=1 pnpm vitest run packages/server/agents/src/providers/codex/lifecycle-live.test.ts` |
| `thread/list` 用量粒度是否到每个模型往返 | 无样本 | 文章不写死 |
| 退出码 | 结构性缺 | `app-server` 在 `turn/completed` 后不自退，kill 后退出码恒 `null`（4/4）⇒ 退出码不得当本轮成败判据，只认 `turn/completed.status` + `error` |

**终结闸门按 `threadId` 认本轮**：主线程与每个子线程各有自己的 turn，`turn/completed` 多条、`threadId` 各异——子线程先到不能当本轮终结（真机踩过：拿到的是子线程结束时刻的快照）。收尾取数（`thread/list` + 逐线程 `thread/read`，`itemsView` 从 `summary` 到 `full` 有降级判据）必须在 `finalize` 之前落定。收尾读回与通知同源：读回的 reasoning 条目与 `item/completed` 逐字相同（4/4）。

## 相关链接

- 活文档：[Codex FAQ](/faq/codex)——加载与凭据、网关与 wire、评分通路、计量与思考、进程与收尾五组现象条目，拿报错原文一搜即命中
- 仓库内参考：`packages/server/agents/README.md`——§4.4 能力查询的唯一入口、§5 各家差异（注入落点 / 停止与释放 / 事件流 / 轮次与计量）、§8.1 新增 SDK 接入清单
- 知识文章：[《DeepSeek Harness 接入》](/protocols/dsh)、[《Claude Code 接入》](/protocols/claude-code)、[《三家横向对比》](/protocols/comparison)、[《评分》](/features/judging)（outputSchema 的评分侧全链）、[《行执行与日志》](/features/row-execution)（用量与轮次展示口径）、[《密钥与环境变量》](/guard/secrets-and-env)（`env_key` 与子进程环境凭据规则）
- 外部资料：[openai/codex discussions#7782](https://github.com/openai/codex/discussions/7782)（chat wire 移除）、[process.getBuiltinModule](https://nodejs.org/api/process.html#processgetbuiltinmodulemoduleid)（跨打包器取真 `createRequire`）
