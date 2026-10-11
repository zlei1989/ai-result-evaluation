# v10：codex 的 MCP 注入与「工具表时机」

一条结论：**codex 的 MCP 注入从来不是问题，问题是起轮次太早**——MCP 工具要 server 到 `ready` 之后才进
codex 的工具表，而工具表**随每条模型请求重算**；`thread/start` 一回来就 `turn/start` 的话，开局那几轮的
请求里根本没有 `mcp__<name>`，模型据此断言「当前会话没有暴露 MCP 工具」并整轮退化成 shell。

## 探针

| 文件 | 回答什么 | 花不花钱 |
|---|---|---|
| `codex-mcp-inject-status.mjs` | 注入成没成：原始通知（含 `warning` 的完整 params）+ `mcpServerStatus/list{threadId}` 的 `runtimeStatus` 与**工具表** | 不调模型 |
| `codex-mcp-tools-capture.mjs` | 工具进没进**请求体**：本机记录型中转抓 `/v1/responses` 的 `tools[]` | 调一次模型 |
| `codex-mcp-namespace-ab.mjs` | 网关侧：`type:"namespace"` 的工具模型看不看得见（同一批工具、只改那一台的形状） | 调两次模型 |
| `echo-server.mjs` | 最小 MCP stdio server（`probe_echo` + 调用落盘）；`PROBE_DELAY_MS` 让 `initialize` 晚回 | — |

用法（在仓库根，凭据取宿主 `~/.aieval/config.json` 的第一条 openai 供应商）：

```
node packages/server/agents/probe/v10/codex-mcp-inject-status.mjs --server=echo
node packages/server/agents/probe/v10/codex-mcp-tools-capture.mjs --server=playwright
node packages/server/agents/probe/v10/codex-mcp-namespace-ab.mjs
```

`codex-mcp-tools-capture.mjs` 的开关：`--server=echo|playwright`、`--delay=<ms>`（echo server 晚启动）、
`--waitready=true`（等 `startupStatus=ready` 再 `turn/start`；缺省 = 与适配器同序，**不等**）、
`--prompt=<文本>`。读数落 `probe/dumps/v10/`（整个 `dumps/` 已 gitignore）。

## 读数（2026-10-11，codex 0.156.1 / GLM-5.3 / 本机网关）

**① 注入成功**（`codex-mcp-inject-status.mjs --server=echo`，不调模型）：

```
mcpServer/startupStatus/updated  starting → ready
mcpServerStatus/list{threadId}   runtimeStatus: "connected"，tools: { probe_echo: … }，toolsError: null
```

真机那一行（run `bad59dce` 的 codex 行）同样是 `starting`(07:50:30.316) → `ready`(07:50:36.271)，
且请求体里有 `{"type":"namespace","name":"mcp__playwright","tools":[25 个 browser_*]}`。

**② 起轮次时机是唯一的自变量**（echo server 6 s 才 `ready`）：

| 臂 | 起轮次时机 | 第一条模型请求 |
|---|---|---|
| 与适配器同序 | `thread/start` 后立刻 `turn/start` | @1188ms `tools=12`，**没有** `namespace mcp__probe` |
| 等就绪 | 等 `startupStatus=ready` 再 `turn/start` | @6203ms `tools=13`，**有** `namespace mcp__probe` |

**③ 工具表按请求重算**（server 3 s 起、第一轮就让它调工具）：

```
@1190ms tools=12（无 MCP）      ready @3147ms      @4952ms tools=13（有 mcp__probe）
```

⇒ 起早了的代价是**头 1–2 轮看不见**，不是整轮丢失；但模型在第一轮就下了「没有这台工具」的结论，
之后 10 轮都在 shell 里绕路（真机 round 11 才回头去调，撞上的是 `unsupported call: browser_navigate`）。

**④ 命名空间本身能过网关**（`codex-mcp-namespace-ab.mjs`，同一批工具只改那一台形状）：

```
A 臂 namespace  → 模型列出：probe_echo, plain_marker
B 臂 扁平 function → 模型列出：mcp__probe__probe_echo, plain_marker
```

⇒ 工具**列得出来**；调不动是**回程**那一跳（上游 issue #23186：codex 把 MCP 工具按命名空间暴露，
自定义 Responses 网关在转发 / 回传时解不开这层壳），与本仓的注入链无关。

## 与产品的关系

适配器现在就在做 `--waitready` 那一臂：`appserver/session.ts` 的 `settleMcpStartup()` 在 `thread/start`
与 `turn/start` 之间等注入的每一台 MCP 落到终态（`ready` / `failed`）。探针的缺省（不等）保留成对照臂——
**它是这条缺陷的复现**，下次怀疑「工具表里又没 MCP」时先跑缺省那一臂看数，再跑 `--waitready=true` 对照。

回归守卫：单元在 `appserver/session.test.ts`（顺序、终态判定、历史兜底、预算、进程终止），
真机在 `live-mcp.test.ts` 的 C 臂（`AIEVAL_LIVE_MCP=1`）。

## 已知边界（未闭合）

- **上游命名空间缺口**：`unsupported call: <tool>`，MCP server 侧零 `tools/call`；本仓不硬解，
  判定只到「装上了」，文案见契约 `CODEX_MCP_DISPATCH_GAP_NOTE`。复跑判据：
  `AIEVAL_LIVE_MCP=1 pnpm vitest run packages/server/agents/src/providers/codex/live-mcp.test.ts`
  （A 臂现在会打出模型答复 `unsupported call: probe_echo`）。
- **`warning` 通知的 params 被丢掉**：产品日志里只有 `{"method":"warning"}`，而真机原文是
  ``Model metadata for `GLM-5.3` not found. Defaulting to fallback metadata…``。探针
  `codex-mcp-inject-status.mjs` 直接读原始通知，所以这一格在探针里看得见、在产品日志里看不见。

## 补记（同日晚）：回程缺 `namespace` 字段才是 `unsupported call` 的机制

codex 的入站 `ResponseItem::FunctionCall`（`codex-rs/protocol/src/models.rs`）有一格**独立的 `namespace`**：
注册表键是 `ToolName { namespace, name }`（`codex-mcp/src/tools.rs` 的 `canonical_tool_name()`）。自定义
Responses 网关回程把这一格丢掉、只留拍平的名字 ⇒ 查不到 ⇒ `unsupported call`。

探针里加两档（`--rewrite=true` + `--rewrite-mode=namespace-field`，或 `rename` + `--rewrite-template`）：

| 回程名字形态 | 读数 |
|---|---|
| 裸名 `probe_echo`（网关现状） | `unsupported call: probe_echo`，server 侧零调用 |
| `mcp__probe__probe_echo` | `unsupported call: mcp__probe.probe_echo` |
| `probe.probe_echo` / `probe__probe_echo` | 不结算 / `unsupported call: mcp__tools__probe_echo` |
| **name + `namespace: "mcp__probe"`** | **`mcpToolCall{server:probe,tool:probe_echo,status:completed}` + server 侧收到 `tools/call` + 模型答 `echo:hello`** |

真 playwright 臂（`--server=playwright --waitready=true`）同样分发成功（`browser_navigate` / `browser_tabs` /
`browser_close` 都进了 `mcpToolCall`；`browser_close` 回真实结果，`browser_navigate` 报 `Target crashed`
= 探针临时 HOME 里 Chromium 不匹配，与分发无关）。

⚠️ 探针缺省**不等** `ready`（那是复现上面那条时序缺陷的对照臂）——要验「工具能不能用」必须加 `--waitready=true`，
否则首条请求里根本没有那台 MCP，模型会先说「没有这个工具」，读数会被自己的对照臂带偏。

## 交给网关侧的最小复现

`gateway-namespace-repro.mjs`（**不经 codex**，一条 HTTP 请求）：按 codex 的形状发一台 namespace 工具 +
一个普通 function 当对照，把回程每个 output item 的 `type` / `name` / `namespace` 打出来。

```
$ node packages/server/agents/probe/v10/gateway-namespace-repro.mjs
[repro] POST http://likecode-llm-proxy-test.jd.com/v1/responses → HTTP 200（model=GLM-5.3）
[repro] 回程 output 条目 2 条：
   type=reasoning name=- namespace=(缺这一格)
   type=function_call name=probe_echo namespace=(缺这一格)      ← 期望 namespace="mcp__probe"
```

⇒ 这一格是**网关回程**丢的，与 codex、与本仓都无关；补上它 `unsupported call` 就消失（见上表）。
