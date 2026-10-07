# 三家 SDK 怎么加 MCP：Claude Agent SDK / DSH SDK Client / Codex SDK

调研日期 2026-10-01。**本文的每一条字段名与行为都有本地实测支撑**，判据写在正文里；
凡是"文档说"而不是"我跑过"的，都标注了出处；凡是没能证实的，集中在 §6 列出。

证据分两档，正文里逐条标了是哪一档：

- **[实测]** —— 我在本机跑出来的（三家 SDK 各一次端到端 MCP 工具调用 + 负对照 + 字段矩阵）；
- **[同批]** —— 同批调研的姊妹清单给出的，带文件与行号/Rust 源码出处，但**我没独立复现**
  （见 §8 末尾的两份清单）。凡标 [同批] 的结论都写明了它没做到的那一步是什么。

被测版本（都是本仓 `packages/server/agents/package.json` 里锁定的那几个）：

| 包 | 本机版本 | 形态 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `0.3.281`（内含 `claude.exe` 2.1.281） | 进程内 SDK，spawn 一个 Claude Code CLI |
| `@deepseek-ai/dsh-sdk-client` | `0.1.7-rc.1` | 进程内 SDK，spawn 一个 `dsh --profile sdk` 运行时 |
| `@openai/codex-sdk` | `0.156.1` | 进程内 SDK，spawn 一个 `codex exec --experimental-json` |

---

## 0. 结论速查表

| 问题 | Claude Agent SDK | DSH SDK Client | Codex SDK |
|---|---|---|---|
| 有原生的 MCP 选项吗？ | **有**，一级公民 | **没有**（一处都没有） | **没有**（一处都没有） |
| 注入落点 | `Options.mcpServers` | `DeepSeekHarnessOptions.patches[]` → cordis patch YAML | `CodexOptions.config.mcp_servers` |
| 字段名 | `mcpServers`（camelCase） | 无 —— 写 `@deepseek-ai/dsh-mcp-client` 插件行 | `mcp_servers`（snake_case） |
| 值从哪来 | JS 对象直接传（SDK 序列化成 inline JSON） | **必须先落盘成 YAML 文件**（只能传路径） | JS 对象直接传（SDK 摊平成 `--config k=v`） |
| stdio 支持 | ✅ `command` / `args` / `env` | ✅ `command` / `args` / `env` / `cwd` | ✅ `command` / `args` / `env` / `cwd` |
| 有 `cwd` 吗 | ❌ **没有** | ✅ `cwd` | ✅ `cwd` |
| HTTP 传输 | ✅ `'http'` + `'sse'`（sse 已弃用） | ✅ `streamable-http` | ✅ 只给 `url` 即 streamable HTTP |
| 进程内 server | ✅ `createSdkMcpServer()` + `tool()` | ❌ 不支持（只能外部进程/HTTP） | ❌ 不支持 |
| 工具命名 | `mcp__<server>__<tool>` | `mcp__<server>__<tool>` | `mcp__<server>__<tool>`（三家一致） |
| 非交互审批 | `permissionMode` + `allowedTools`；`bypassPermissions` 放行 | 无 MCP 专用审批门，挂上即可用 | ⚠️ **必须** `tools.<工具>.approval_mode`，否则 `approvalPolicy:'never'` 下必然失败 |
| 失败表现 | 不抛异常；查 `system/init` 的 `mcp_servers[].status` | `failOnStartupError:false`（默认）静默缺工具 | CLI 严格校验配置；server 连不上时 `mcp_tool_call` 项报错 |

**一句话选型**：Claude 是"一行配置"，Codex 是"一行配置 + 一个审批开关"，DSH 是"先写一个 YAML 文件再配置"。

---

## 1. `@anthropic-ai/claude-agent-sdk`

### 1.1 怎么加

`Options.mcpServers` 是一个 `Record<服务器名, 配置>`，服务器名就是工具名里的中段：

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: '用 mcp__probe__dsn_echo 回显 from-claude-probe',
  options: {
    cwd: '/path/to/workdir',
    mcpServers: {
      // ① stdio：`type` 可省（省略即 stdio），但显式写更清楚
      probe: {
        type: 'stdio',
        command: process.execPath,
        args: ['/abs/path/echo-mcp-server.mjs'],
        env: { PROBE_TOKEN: 's3cret' },
      },
      // ② Streamable HTTP
      remote: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer …' },
      },
      // ③ SSE（已弃用，仅为兼容老服务）
      legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
    },
    // 只认 mcpServers（+ 显式传入的 agent 定义），忽略磁盘上的 .mcp.json / settings / 插件
    strictMcpConfig: true,
    allowedTools: ['mcp__probe__dsn_echo'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  },
})) {
  // …
}
```

### 1.2 字段全量（出自安装态 `sdk.d.ts`）

| 类型 | 行号 | 字段 |
|---|---|---|
| `McpStdioServerConfig` | 1270–1284 | `type?: 'stdio'`、`command: string`、`args?: string[]`、`env?: Record<string,string>`、`timeout?: number`、`alwaysLoad?: boolean` |
| `McpHttpServerConfig` | 1114–1129 | `type: 'http'`、`url: string`、`headers?: Record<string,string>`、`tools?: McpServerToolPolicy[]`、`timeout?`、`alwaysLoad?` |
| `McpSSEServerConfig` | 1253–1268 | 同 http，`type: 'sse'` |
| `McpSdkServerConfigWithInstance` | 1131–1146 | `type: 'sdk'`、`name: string`、`instance: McpServer`、`timeout?` |
| `McpServerConfig`（联合） | 1151 | 上面四种 |
| `Options.mcpServers` | 1899 | `Record<string, McpServerConfig>` |
| `Options.strictMcpConfig` | 2234 | `boolean`，映射 CLI `--strict-mcp-config` |

**stdio 没有 `cwd` 字段** —— 这一点三家不同，别照抄 DSH/Codex 的配置。

进程内 server（工具跑在你的 Node 进程里，不 spawn 任何东西）：

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const server = createSdkMcpServer({
  name: 'probe',
  version: '1.0.0',
  tools: [
    tool('dsn_echo', '回显 marker', { marker: z.string() }, async ({ marker }) => ({
      content: [{ type: 'text', text: `MCP_PROBE_OK marker=${marker}` }],
    })),
  ],
});
// server 是 McpSdkServerConfigWithInstance，直接塞进 mcpServers
options.mcpServers = { probe: server };
```

带 `instance` 的条目会被 SDK 从命令行里**剔除**，改由 initialize 控制请求的 `sdkMcpServers`
（+ 0.3.281 新增的 `sdkMcpServerManifests` 握手缓存）注册，因此它**不出现**在 `--mcp-config` 里。
它对面的 `McpServerConfigForProcessTransport`（`sdk.d.ts:1153`）就是"能进 `--mcp-config` 的那一半"。

### 1.3 工具命名与授权

- 名字是 `mcp__<服务器名>__<工具名>`，服务器名就是 `mcpServers` 的 key（实测见 §1.5）。
- `allowedTools` 里通配符**只能出现在工具位**：`mcp__github__*`、`mcp__github__get_*` 合法；
  `mcp__*` 在 allow 规则里**非法**（校验器原文：`globs are permitted only in the tool position after a literal mcp__<server>__ prefix`）。
- 不写 `allowedTools`：工具**可见但需要授权**；在无 `canUseTool` 的 SDK 场景下，`ask` 决策是**终止性拒绝**。
- `permissionMode: 'acceptEdits'` **不**自动批准 MCP 工具；`'bypassPermissions'`（+ `allowDangerouslySkipPermissions: true`）才会。

### 1.4 本机实测

`.probe-dsh-mcp/claude-probe.mjs`（脚本原文见 §7）跑出来：

```text
initMcpServers: [{ "name": "probe", "status": "connected", "source": "dynamic" }]
initTools:      ["mcp__probe__dsn_echo"]
toolUses:       ["mcp__probe__dsn_echo"]
finalResponse:  "MCP_PROBE_OK marker=from-claude-probe"
mcpFrameCount:  8      ← 替身 server 自己落盘的帧数
mcpMethods:     initialize / notifications/initialized / tools/list / tools/call
```

替身 server 看到的第一帧逐字是：

```json
{"method":"initialize","params":{"protocolVersion":"2025-11-25","clientInfo":{"name":"claude-code","version":"2.1.281"}}}
```

判据链：`mcp_servers[].status === 'connected'` + 工具出现在 init 的工具表里 + 模型真的发出了 `tool_use`
+ **MCP server 进程自己的输入里有 `tools/call`**。最后一条是硬证据——前三者都可能被"看起来对"的实现伪造。

### 1.5 坑

1. **stdio 无 `cwd`**：配置里指定不了工作目录，只能用绝对路径的 `command`/`args`。
2. **连接失败不抛异常**：看 `system/init` 的 `mcp_servers[].status`（`connected` / `failed` / `needs-auth` / `pending`）
   或调 `mcpServerStatus()` / `reconnectMcpServer()`。`pending` 不等于失败。
3. **0.3.142 起的破坏性变更**：MCP 默认**后台连接**，慢 server 在 init 里就是 `pending`。
4. `url` 不带 `type` 是配置错误——没有 `type` 会被当成 stdio。JSON 里 `streamable-http` 是 `http` 的别名，
   但 SDK 的类型只声明 `"http"`。
5. 工具搜索结果默认延迟加载（tool search），`alwaysLoad: true` 可豁免，代价是启动要等该 server 连上（5s 上限）。
6. `settingSources` 默认是 `['user','project','local']`（**含 project**）——即默认会读磁盘上的 `.mcp.json`。
   要"只用我传的这几台"，就得 `strictMcpConfig: true`。

---

## 2. `@deepseek-ai/dsh-sdk-client`

### 2.1 核心事实：SDK 里没有 MCP 字段

`HarnessClientOptions` / `DeepSeekHarnessOptions` / `RunOptions` / `InitializeParams`
**全都没有** `mcpServers` 或任何 MCP 字段。SDK 的 JSON-RPC 方法表是**封闭的三个**：
`initialize` / `session/prompt` / `shutdown`（`packages/sdk/protocol/src/types.ts`），
服务端对未知方法直接抛错（`packages/sdk/server/src/server.ts`）。

⇒ **MCP 只能走配置文件**。这不是"类型被收窄导致送不进去"，是**服务端根本没有对应方法**。

### 2.2 怎么加：写一个 cordis patch，然后传路径

DSH 的运行时是一棵 Cordis 插件树，"一台 MCP server = 一个插件行"。SDK 侧唯一的注入通道是
`patches: string[]`，它被拼成 `--patch <绝对路径>`：

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

await using harness = new DeepSeekHarness({
  cwd: '/path/to/workdir',
  dshHome: '/path/to/config-home',   // → 子进程的 DSH_HOME
  model: 'deepseek-flash',
  provider: 'my-route',
  // ★ 唯一的注入落点。相对路径按**宿主进程的 cwd** 解析，务必给绝对路径。
  patches: ['/abs/path/mcp.cordis.yml', '/abs/path/route.cordis.yml'],
  env: { /* 完整子进程环境，替换型语义 */ },
});
```

配套的 `mcp.cordis.yml`：

```yaml
# 一台 stdio server
- insert:
    - id: mcp-my-local                 # 行 id，唯一即可
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mylocal            # 必须匹配 [A-Za-z0-9_-]{1,32}
        transport: stdio
        command: node
        args: ['/abs/path/my-mcp-server.mjs']
        env:
          MY_TOKEN: !!js process.env.MY_TOKEN     # 环境变量这样注入
        cwd: /abs/path/workdir
        toolCallTimeoutMs: 60000
        failOnStartupError: true       # 排错时打开：启动失败直接拒绝激活
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10

# 一台 Streamable HTTP server
- insert:
    - id: mcp-my-remote
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: myremote
        transport: streamable-http
        url: http://localhost:3000/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

### 2.3 字段全量（`packages/mcp/mcp-client/src/index.ts` 的 schemastery）

传输**只有两种**：`'stdio'` 与 `'streamable-http'`。**没有独立的 `sse` 类型**。

| 字段 | stdio | streamable-http | 默认 | 说明 |
|---|---|---|---|---|
| `transport` | 必填 | 必填 | — | 判别式 |
| `serverName` | 必填 | 必填 | — | `[A-Za-z0-9_-]{1,32}`，一个作用域内唯一 |
| `command` / `args` / `env` / `cwd` | ✅ | ❌ | `args:[]` `env:{}` `cwd:''` | `args` **无 shell 插值** |
| `url` / `headers` | ❌ | ✅ | `headers:{}` | HTTP 端点与附加请求头 |
| `toolCallTimeoutMs` | ✅ | ✅ | `60000` | 每次 `tools/call` |
| `maxInstructionBytes` | ✅ | ✅ | `32768` | 服务器指令 UTF-8 字节上限，超限**拒绝连接** |
| `failOnStartupError` | ✅ | ✅ | `false` | `true` = 初始连接/工具同步失败时拒绝插件激活 |
| `reconnect.*` | ✅ | ✅ | `enabled:true` `500` `30000` `10` | 断线自动重连 |

**不存在**的字段（已全仓 grep 证实）：`enabled`（开关是**插件行级**的 `disabled:`，不在 `config` 里）、
`disabledTools` / `allowedTools` / `enabledTools`（DSH 原生没有工具过滤）、独立的连接/发现超时。

### 2.4 配置层级与优先级

后应用的层覆盖前面的层，**逐行替换整个 `config`，不是深合并**：

```text
bundle patches  →  profiles/<name>/cordis.patch.yml  →  $DSH_HOME/cordis.patch.yml
                →  --patch overlays（SDK 的 patches 在这一层，最高）  →  telemetry 开关
```

想持久化（不想每次传 patch）就写进 `$DSH_HOME/profiles/sdk/cordis.patch.yml`（单 profile）
或 `$DSH_HOME/cordis.patch.yml`（全 profile）。**要合并，不要覆盖**——那两份文件里可能已经有别的用户 patch。

### 2.5 本机实测

`.probe-dsh-mcp/driver.mjs` + `mcp-probe.cordis.yml`：

```text
sdkOptionsAcceptedKeys: [clientInstance, closed, createClient, cwd, initialized,
                         maxTokens, model, provider, reasoningEffort]
                        ← 逐字没有 mcpServers（形状探测；注入了 marker 后 maxTokens 与 model 可见）
finalResponse:  "MCP_PROBE_OK marker=from-dsh-probe"
toolNames:      ["mcp__probe__dsn_echo"]
mcpMethods:     server/discover → initialize → notifications/initialized → tools/list → tools/call
```

`server/discover` 那一帧值得注意：DSH 的 bridge 用的是 `@modelcontextprotocol/client@2.0.0`，
它**先试 2026-07-28 版的 `server/discover`**，我的替身回 `-32601`，它才回落 `initialize`（2025-11-25）。

**负对照**（同一份驱动、同一个提示词，只摘掉 MCP 那层 overlay）：

```text
mcpServerSpawned: false
toolNames:        []
finalResponse:    "…My tool list has no dsn_echo (and no MCP tools whatsoever)…"
```

### 2.6 坑

1. **配置必须先落盘**：`patches` 只收路径。想"运行时动态决定 MCP 清单"，就得自己写文件
   （本仓 DSH 适配器写路由 overlay 已经是这个模式）。
2. **初始化预算默认只有 10 秒**（`initializeTimeoutMs`，`DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000`）。
   这个预算量的是**整个 dsh profile 启动 + 握手**：本机实测在机器带负载时会被撞穿，报
   `initialize timed out after 10000ms waiting for dsh profile "sdk"`。**那是机器慢，不是配置错**
   （同一份代码在安静时稳定通过）——但它会让"接了 MCP 之后启动变慢"看起来像随机失败。
   挂的 MCP server 越多、stdio 协商越慢，这个预算越容易不够：`initializeTimeoutMs` 是必调的旋钮。
3. **`failOnStartupError` 默认 `false`**：连接失败时 harness 照常启动、工具静默消失，只留一条错误日志。
   排错时打开它。
4. **改配置要重启运行时进程**：SDK profile 的 bundle 里 `hmr` 是 `disabled: true`。
5. **stdio 子进程环境会被清洗**：`/KEY|PASSWORD|SECRET|TOKEN/i` 命中的变量名与所有 `DSH_*` 变量被删除，
   再把 `config.env` 合并上去。所以宿主里的 `GITHUB_TOKEN` **不会**自动传进去，必须显式写进 `config.env`。
6. **重连预算耗尽后工具被注销且不再自动恢复**（默认 10 次连续失败）；停机期间工具仍列出但调用失败。
7. **默认一台都没有**：每个 profile 都挂了 `mcp-resources`，但**没有任何 profile 挂 `mcp-client`**
   （`apps/cli/tests/profile-mcp.spec.ts` 对每个 profile 硬断言这件事）。

---

## 3. `@openai/codex-sdk`

### 3.1 怎么加

Codex SDK **没有** `mcpServers` 选项。唯一的通道是 `CodexOptions.config`——
SDK 把它摊平成 `--config key=value` 传给 CLI：

```ts
import { Codex } from '@openai/codex-sdk';

const codex = new Codex({
  apiKey,
  config: {
    model_provider: 'myroute',
    model_providers: {
      myroute: {
        name: 'gateway',
        base_url: 'https://gw.example.com/v1',
        wire_api: 'responses',
        requires_openai_auth: true,   // 缺它 CLI 不发 Bearer，全部 401
      },
    },
    mcp_servers: {
      probe: {
        command: process.execPath,
        args: ['/abs/path/echo-mcp-server.mjs'],
        env: { PROBE_TOKEN: 's3cret' },
        cwd: '/abs/path/workdir',
        startup_timeout_sec: 20,
        tool_timeout_sec: 30,
        // ★ 非交互场景必需：见 3.3
        tools: { dsn_echo: { approval_mode: 'approve' } },
      },
      remote: {
        url: 'https://mcp.example.com/mcp',
        bearer_token_env_var: 'PROBE_BEARER',
        http_headers: { 'X-Api-Key': 'k' },
        env_http_headers: { 'X-Tenant': 'TENANT_ID' },
      },
    },
  },
  env: { ...process.env, CODEX_HOME: '/isolated/home' },
});
```

等价的 `config.toml`：

```toml
[mcp_servers.probe]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["/abs/path/echo-mcp-server.mjs"]
cwd = "D:\\work"
startup_timeout_sec = 20
tool_timeout_sec = 30
[mcp_servers.probe.env]
PROBE_TOKEN = "s3cret"
[mcp_servers.probe.tools.dsn_echo]
approval_mode = "approve"

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "PROBE_BEARER"
```

### 3.2 摊平规则（SDK 源码 `dist/index.js:317-389`）

- 嵌套对象 → 点号路径（`mcp_servers.probe.command`）。
- 值序列化成 **TOML 字面量**：字符串 `JSON.stringify`（带引号与转义）、数字裸写、布尔 `true/false`、
  数组 `[a, b]`、对象 `{k = v}`。
- **`undefined` 的键被跳过；`null` 直接抛错**（`cannot be null`）；`NaN`/`Infinity` 抛错。
- 键名不是 `[A-Za-z0-9_-]+` 时用 JSON 引号包起来。
- `configOverrides: string[]` 是逃生门：原样透传的 TOML 片段，**排在 `config` 之后**（优先级更高）。

CLI 侧 `-c/--config` 的官方说明逐字："The `value` portion is parsed as TOML. If it fails to parse as TOML,
the raw string is used as a literal." —— 与 SDK 的序列化规则正好对齐。

**同批调研发现的两个摊平真 bug**（来自 [`2026-10-01-codex-sdk-mcp-facts.md`](./2026-10-01-codex-sdk-mcp-facts.md)，
本机实测、未由我复现）：① `env` 的键含 `.`（如 `A.B`）会被当成点号路径拆成嵌套表，
CLI 报 `invalid type: map, expected a string in mcp_servers.x.env.A`；② `formatTomlKey` 只用于内联表，
**点号路径部分不做 bare-key 转义**，键里含 `"` 会生成破损的 TOML。
两个都只在"键名本身很怪"时触发，但排查起来非常难定位——`env` 的键别用点号与引号。

### 3.3 ⚠️ 非交互场景的硬阻断：MCP 工具审批

**这是本次调研最值钱的一条发现**，也是文档里查不到的。

本仓 codex 适配器用 `approvalPolicy: 'never'`（评测没有人能点批准）。在这个策略下，
MCP 工具调用**一律失败**，原文：

```text
MCP tool call requires approval, but approval policy is never
```

解药是 per-tool 的 `approval_mode`，枚举由 CLI 自己报出来（`unknown variant …, expected one of …`）：

| 值 | 含义 |
|---|---|
| `auto` | 模型自己判断要不要批准 |
| `prompt` | 每次问人（评测里没有人 ⇒ 必挂） |
| `writes` | 只对写操作问人 |
| `approve` | 该工具直接批准 ← 非交互场景用这个 |

字段路径是 `mcp_servers.<serverName>.tools.<rawToolName>.approval_mode`（注意是**按原始工具名**，
不是 `mcp__server__tool` 那个公开名）。服务器级还有一个 `default_tools_approval_mode`（同一套枚举），
但我**没有**对它做端到端验证（见 §6）。

### 3.4 字段全量

**判据说明（这一节踩过两次坑，值得单独讲）：**

`codex mcp list` **不校验未知键** —— `mcp_servers.t.bogus_field=1` 返回 exit 0、静默忽略。
所以"CLI 接受了"在那里**不构成**"字段存在"的证据。
真正有区分力的判据是 **`codex exec --strict-config`**：

```text
$ codex --config 'mcp_servers.t.bogus_xyz=1' exec --strict-config --sandbox read-only x
Error: unknown configuration field `mcp_servers.t.bogus_xyz` in -c/--config override
```

本机（CLI 0.156.1）用这个判据跑了一张字段矩阵，四个反例对照（`bogus_xyz` / `type` / `headers` /
`experimental_use_rmcp_client`）全部被正确判为 `unknown configuration field`，
证明这个判据是有区分力的（无区分力的判据长什么样：所有行报同一个错——本机确实先踩到过一次，
原因是我把 `CODEX_HOME` 指向了一个**不存在**的目录，CLI 直接 `Error finding codex home` 退出）。

**已由 `exec --strict-config` 判为存在的字段：**

| 字段 | 传输 | 说明 |
|---|---|---|
| `command` / `args` / `env` / `cwd` / `env_vars` | stdio | `args` 必须是序列（写成字符串报 `expected a sequence`） |
| `url` / `bearer_token_env_var` / `http_headers` / `env_http_headers` | HTTP | HTTP 字段在 stdio 下报 `not supported for stdio` |
| `enabled` | 两者 | 布尔（`"yes"` 报 `expected a boolean`）；`false` = 跳过初始化该 server |
| `required` | 两者 | 布尔；`true` 时该 server 初始化失败会让 `codex exec` **报错退出** |
| `enabled_tools` / `disabled_tools` | 两者 | 工具白/黑名单（**本仓需要的工具过滤能力，DSH 原生没有**） |
| `supports_parallel_tool_calls` | 两者 | 布尔 |
| `startup_timeout_sec` / `tool_timeout_sec` | 两者 | **秒**（`tool_timeout_sec` 可为小数） |
| `startup_timeout_ms` / `tool_timeout_ms` | 两者 | 毫秒，**legacy**；实测 `startup_timeout_ms=5000` 被回读成 `startup_timeout_sec: 5.0` |
| `tools.<工具名>.approval_mode` | 两者 | 见 3.3，**已端到端验证**（本机用 `dsn_echo` 验的） |
| `tools.<工具名>.output_token_limit` | 两者 | per-tool 输出上限 |
| `default_tools_approval_mode` | 两者 | 服务器级审批默认值（同 3.3 的枚举）；**只判定了存在性** |
| `name` | 两者 | legacy，**被忽略**（但被接受） |

**已被明确判为不存在 / 已删除的字段**（写配置时别用）：

| 写法 | 实情 |
|---|---|
| `type` | **没有这个字段**。传输靠 `command` / `url` 推断 |
| `headers` | 不存在，正确的是 `http_headers` |
| `experimental_use_rmcp_client` | 0.156.1 已删除（strict-config 判为未知字段） |

**传输判别是互斥的**：`url` 与 `command` 同时给 → `url is not supported for stdio`；
两个都不给 → `invalid transport`。

> ⚠️ **超时单位坑**：`startup_timeout_sec` 是**秒**。把 `10000`（毫秒的直觉）写进 `_sec`
> 等于给自己设了 **2.8 小时**的启动等待——配置"看起来设了超时"，实际等于没设。

> ⚠️ **共享 `CODEX_HOME` 会互相污染**：本次调研里我复用兄弟探测留下的 `CODEX_HOME` 时，
> 它残留的 `config.toml` 里有一个 `[totally_unknown_top_level]`，导致 `--strict-config` 对
> **每一个**待测键都报同一个错、矩阵整体失去区分力。`CODEX_HOME` 要么专目录专用，要么每次都核一遍内容。

### 3.5 本机实测

`.probe-dsh-mcp/codex-e2e.mjs`：

```text
mcpToolCall: { server: "probe", tool: "dsn_echo", arguments: {marker:"from-codex-probe"},
               result: { content: [{type:"text", text:"MCP_PROBE_OK marker=from-codex-probe"}] },
               status: "completed" }
finalResponse: "MCP_PROBE_OK marker=from-codex-probe"
mcpMethods:    initialize / notifications/initialized / tools/list / tools/call
```

**A/B 对照**（同一脚本、同一提示词，只差 `tools.dsn_echo.approval_mode`）：

| 配置 | 结果 |
|---|---|
| 不写 `approval_mode` | `status: "failed"`，`error.message: "MCP tool call requires approval, but approval policy is never"` |
| `approval_mode: 'approve'` | `status: "completed"`，拿到真实回显 |

**负对照**（`--no-mcp`，摘掉整个 `mcp_servers`）：`mcpServerSpawned: false`，模型回
"…no MCP tool is available to me in this session. My tool list contains only shell, file/image viewing,
sub-agent, and goal tools; there is no `probe` server entry and no `dsn_echo` tool…"

### 3.6 坑

1. **`approval_mode` 是必需项**，不是优化项（见 3.3）。
2. **`args` 必须是数组**：SDK 的序列化会给你 `["a", "b"]`（带方括号），别自己再包一层引号。
3. **`null` 会让 SDK 抛错**：想"这个键不给"就用 `undefined` 或干脆不写。
4. **`~/.codex/config.toml` 会被叠加**：SDK 的 `--config` 是覆盖（且是**按键合并**，别的 server 保留），
   但宿主里已有的 `mcp_servers` 条目可能一起生效。要隔离就把 `CODEX_HOME` 指向独立目录——
   注意 **SDK 自己不设 `CODEX_HOME`**，得在 `env` 里显式给；而 `env` 一旦提供就**不继承 `process.env`**。
5. **`~/.codex/config.toml` 里的未知键会让 `--strict-config` 整体失败**：排障时会表现得像
   "我注入的键有问题"，实际是别处的残留（本机踩过，见 §3.4 的第二个 ⚠）。
6. **stdio 的 `cwd` 是有的**（与 Claude 不同），但 `command` 用相对路径仍按 CLI 进程的 cwd 解析——
   稳妥起见给绝对路径。
7. **配置错了 CLI 会在启动阶段就响亮失败**（`failed to load bootstrap configuration`），
   这比静默缺工具好排障。**但 SDK 路径从不传 `--strict-config`**：键名写错在 SDK 下**完全不报错**，
   只能自己跑 `codex exec --strict-config` 或 `codex doctor --json`（看 `checks["mcp.config"]`）来核。
8. **超时默认值比公开文档新**：同批调研引 `codex-mcp/src/rmcp_client.rs:103-104` 得出
   启动 **30 s** / 工具 **300 s**（文档里写的还是旧的 10 s / 60 s）。我**没有**独立复现这两个数字。

---

## 4. 三家横向对比

### 4.1 同一件事，三种写法

给同一台 stdio MCP server（`node /abs/echo-mcp-server.mjs`，服务器名 `probe`）：

```ts
// Claude —— JS 对象，SDK 序列化成 inline JSON 塞进 --mcp-config
mcpServers: { probe: { type: 'stdio', command: node, args: [ECHO] } }
```

```ts
// Codex —— JS 对象，SDK 摊平成 --config k=v
config: { mcp_servers: { probe: { command: node, args: [ECHO],
          tools: { dsn_echo: { approval_mode: 'approve' } } } } }
```

```yaml
# DSH —— 必须先落盘成 YAML，然后把路径交给 SDK
- insert:
    - id: mcp-probe
      name: '@deepseek-ai/dsh-mcp-client'
      config: { serverName: probe, transport: stdio, command: node, args: [/abs/echo-mcp-server.mjs] }
```

### 4.2 共同的"看起来成功"陷阱

三家都会出现"配置写了、进程起来了、但工具没用上"，而且**都不抛异常**：

| SDK | 静默失败的表现 | 观测点 |
|---|---|---|
| Claude | server 状态是 `failed` / `pending` | `system/init` 的 `mcp_servers[]`、`mcpServerStatus()` |
| DSH | 工具消失，只留一条错误日志 | `failOnStartupError:true` 让它响亮；`$DSH_HOME/logs/` |
| Codex | `mcp_tool_call` 项 `status:"failed"` | 事件流里的 `error.message`；配置错则 `codex exec --strict-config` + `codex doctor --json` |

⇒ **判据要选"外部进程自己的输入"，而不是"配置被解析了"**。本次调研用的办法是：
让替身 MCP server 把收到的每一帧 JSON-RPC 落盘，然后核对是否存在 `tools/call`。
这一条无法被上游的"看起来对"伪造——`initialize` + `tools/list` 只能证明**连上了**，
只有 `tools/call` 才能证明**模型真的用了**。

**判据还有第二层陷阱：工具自己说"我接受了"也可能是假的。** Codex 的 `mcp list` 对未知配置键
返回 exit 0、静默忽略；我用它做字段矩阵时，**每一行都报同一个错**却都"通过了"。
有区分力的判据必须能**证伪**——所以字段矩阵里刻意放了四个已知不存在的键作反例对照，
它们全被正确拒绝，那张矩阵才算数（详见 3.4 与 §6 第 1 条）。

### 4.3 工具命名三家一致

`mcp__<serverName>__<rawName>`。这对本仓有意义：**一行评测记录里出现的工具名不需要按智能体分叉**，
投影层可以共用一条解析规则。DSH 与 Claude/Codex 还有一处细节相同：发给 MCP server 的
`tools/call` 用的是**原始工具名**，公开名只用于模型可见面。

---

## 5. 落到本仓（`packages/server/agents`）的建议

现状：三个适配器的 `providers/<kind>/sdk.ts` 是"唯一知道厂商 SDK 入口形状的地方"，
新增字段一律加在各自的窄结构接口上。按本文结论，最小改动分别是：

| 家 | 改动点 | 形态 |
|---|---|---|
| claude-code | `ClaudeQueryOptions` 加 `mcpServers?`，`index.ts` 里按 input 传入 | 一个可选字段，零落盘 |
| codex | `CodexConfig` 加 `mcp_servers?`；`buildCodexConfig` 增一个参数 | 一个可选字段，零落盘 |
| dsh | `patches` 已经是数组，追加一个 MCP overlay 文件即可 | **需要写文件**（复用 `buildDshRoutePatch` 的同款纯函数模式） |

两条与评测口径直接相关的注意事项：

1. **codex 侧必须同时生成 `tools.<name>.approval_mode`**，否则在现有
   `approvalPolicy: 'never'`（`CODEX_PERMISSION_OPTIONS`）下，MCP 工具调用 100% 失败。
   这是"接了但用不了"的典型——配置看起来完全正常。
2. **claude 侧的 `settingSources` 已经是 `[]`（隔离模式）**，这意味着磁盘上的 `.mcp.json` 不会生效；
   要接 MCP 只能走 `Options.mcpServers`。反过来，如果哪天把 `settingSources` 打开，
   被测仓库里的 `.mcp.json` 就会变成一条**可以改变评测口径**的输入——那需要与 `settings` 同款的
   "本次路由赢"处理。
3. **codex 侧还有一个现成的工具过滤能力**：`enabled_tools` / `disabled_tools`（已由 strict-config 判为存在）。
   本仓 claude 侧有 `disallowedTools` 名单、dsh 侧**没有**对应能力。评测口径要"三家只看同一批工具"的话，
   这是**唯一能补齐 dsh 缺口的地方**——但它只在 codex 上有效，反而会把三家拉得更不一致，
   所以先想清楚口径再动。

不建议现在做的事：给三家做一个统一的 `mcpServers` 配置面。三家的字段集差别是**结构性**的
（Claude 没有 `cwd`、DSH 没有 HTTP 之外的第二种、Codex 多一个审批枚举），
压成一个共享类型必然要在某一侧丢字段——正是本仓已经写死过的教训：
"外壳比厂商窄，就等于把厂商的能力关在门外"。

---

## 6. 不确定 / 未能证实

1. **Codex 的 `default_tools_approval_mode`（服务器级审批默认值）没有端到端验证**：
   `codex exec --strict-config` 判它**存在**（§3.4 的矩阵），但没有像
   `tools.<name>.approval_mode` 那样跑过"模型真的调一次工具"的对照。
   ⇒ 生产用法仍推荐 **per-tool** 的 `tools.<工具名>.approval_mode`（已端到端验证）。
2. **Claude 的 `--mcp-config` 载荷形态**：本机探测的 spawn 拦截**没有捕获到 argv**
   （进程确实起来了、MCP 也确实连上了，但 `captured` 为空）。因此
   "SDK 把 `mcpServers` 序列化成 inline JSON 交给 `--mcp-config`"这一条是**读 `sdk.mjs` 源码得出**的，不是实测。
   `mcp_servers[].source === 'dynamic'` 这个实测值与文档里 `--mcp-config` 的归类一致，属于**间接**旁证。
3. **Claude 的 `Options.mcpServers` 与同名 `.mcp.json` 谁优先**：官方优先级列表只覆盖磁盘作用域，
   没有点名 `--mcp-config`。本机没做成对照实验，故不下结论。
4. **Windows 下 stdio 用 `npx` / `.cmd`**：
   - Codex：同批调研引用 `rmcp-client/src/program_resolver.rs` 的官方注释
     （*"This enables tools like `npx`, `pnpm`, and `yarn` to work correctly on Windows without requiring
     users to specify full paths or extensions"*，按 `PATHEXT` 解析）⇒ Codex 侧**不需要** `cmd /c`。
     我**没有**独立复现这条（本机探测一律用 `process.execPath`）。
   - Claude：官方文档**没有** Windows 专属说明，只有社区 issue 报告裸 `npx` 触发 `spawn ENOENT`
     （非官方来源，未采信）。
   ⇒ 稳妥做法仍是绝对路径的可执行文件 + 绝对路径的脚本参数。
5. **DSH 的 `toolCallTimeoutMs` / `maxInstructionBytes` 实际生效边界**：只从字段表与 README 取得，未实测。
6. **Codex 的 `env_vars` / `env_http_headers` / `output_token_limit` / `supports_parallel_tool_calls`
   的行为语义**：字段存在性已判定，但**没做行为验证**（只测了"CLI 接受它"）。
7. **Codex 的项目级 `.codex/config.toml`**：同批调研实测**不生效**（`mcp list` 返回 `[]`），
   但二进制里有 `Error parsing project config file` / `dotCodexFolder` 等串，触发条件未明。

---

## 7. 探测脚本与复现方法

脚本都在 `.probe-dsh-mcp/`（被 `.gitignore` 的 `.probe-*/` 忽略，不入库；这里给出可直接抄的原文）。
复现需要一个**零依赖的替身 MCP server**——它的作用是"把收到的每一帧落盘"，这是全篇的判据来源：

```js
// echo-mcp-server.mjs（零依赖 MCP stdio server）
import { appendFileSync } from 'node:fs';
const FRAMES = process.env.DSH_PROBE_FRAMES ?? '';
const trace = (d, p) => { if (FRAMES) appendFileSync(FRAMES, `${d} ${JSON.stringify(p)}\n`, 'utf8'); };
const send = (m) => { trace('OUT', m); process.stdout.write(`${JSON.stringify(m)}\n`); };
const TOOL = 'dsn_echo';
const tools = [{ name: TOOL, description: 'Echo a marker string back.',
  inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] } }];

function handle({ id, method, params }) {
  if (id === undefined) { trace('NOTE', { method }); return; }
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: {
    // 协议版本按客户端请求回抄：客户端只接受它请求的那个版本
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'aieval-mcp-probe', version: '1.0.0' } } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') return send({ jsonrpc: '2.0', id, result: {
    content: [{ type: 'text', text: `MCP_PROBE_OK marker=${String(params?.arguments?.marker ?? '(missing)')}` }] } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  // 未知方法必须回错误：DSH 的 client@2.0.0 靠这个回落 initialize
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf('\n');
    if (nl < 0) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    trace('IN', message);
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
```

三家各自的跑法与本机实测输出：

| 家 | 脚本 | 关键判据 |
|---|---|---|
| Claude | `.probe-dsh-mcp/claude-probe.mjs` | `system/init` 的 `mcp_servers[].status==='connected'` + init 工具表含 `mcp__probe__dsn_echo` |
| DSH | `.probe-dsh-mcp/driver.mjs`（`--no-mcp` 为负对照） | `result.events` 里有 `tool/call` 且 `name==='mcp__probe__dsn_echo'` |
| Codex | `.probe-dsh-mcp/codex-e2e.mjs`（`--no-mcp` 为负对照） | `item.completed` 的 `mcp_tool_call.status==='completed'` |
| Codex（字段判定·弱） | `.probe-dsh-mcp/codex-fields.mjs` | `codex mcp list` 的 serde 错误串。⚠️ **不校验未知键**，只用来看类型错 |
| Codex（字段判定·强） | `.probe-dsh-mcp/codex-strict-fields.mjs` | `codex exec --strict-config` + 四个已知不存在的键作反例对照 |

三家都用同一个循环：**先跑正例，再跑只摘掉 MCP 配置的负对照**。
只看正例是不够的——"工具名出现了"与"模型本来就瞎猜"在没有负对照时无法区分。

Codex 的字段矩阵额外揭示了一条通用的方法论：**判据必须被反例证明过有区分力**。
我第一次跑那张矩阵时，所有键（包括真键）都返回同一句
`unknown configuration field \`totally_unknown_top_level\`` —— 因为 `CODEX_HOME` 指向了一个
**不存在**的目录，CLI 在配置校验之前就退出了。那张矩阵当时的"结论"全是噪声。
加上四个已知不存在的键作对照之后，矩阵才第一次具备区分力。

---

## 8. 参考

**本地类型定义 / 源码**（权威，版本与实测一致）

- `node_modules/.pnpm/@anthropic-ai+claude-agent-_cbdca19109b707e2aa583597049da2ca/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  （`McpStdioServerConfig:1270`、`McpServerConfig:1151`、`Options.mcpServers:1899`、`Options.strictMcpConfig:2234`、
  `createSdkMcpServer:547`、`tool:9355`）
- `D:\zhanglei1120\Github\deepseek-harness\packages\mcp\mcp-client\src\index.ts`（config schema）、
  `src/transport.ts`（stdio 环境清洗）、`src/tools.ts`（`publicToolName` 命名算法）
- `D:\zhanglei1120\Github\deepseek-harness\packages\sdk\client\src\{types,launch}.ts`
  （`patches` → `--patch`、`dshHome` → `DSH_HOME`）
- `D:\zhanglei1120\Github\deepseek-harness\apps\cli\config\examples\mcp-memory\*.cordis.yml`（官方示例）
- `node_modules/.pnpm/@openai+codex-sdk@0.156.1/node_modules/@openai/codex-sdk/dist/index.{js,d.ts}`
  （`CodexOptions.config`、`flattenConfigOverrides:322`、`tomlValue:354`）
- 真实 CLI：`node_modules/.pnpm/@openai+codex@0.156.1-win32-x64/…/bin/codex.exe`（§3.4 的字段判定由它给出）

**在线**

- [Claude Agent SDK · MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
- [Claude Agent SDK · TypeScript 参考](https://code.claude.com/docs/en/agent-sdk/typescript)（⚠️ 该页的类型块漏了 `timeout`/`alwaysLoad`/`tools`，以本地 `.d.ts` 为准）
- [Claude Code · MCP](https://code.claude.com/docs/en/mcp)
- [DSH 官方文档 · Memory MCP 指南](https://deepseek-harness.github.io/deepseek-harness/en/guide/mcp-memory)
- [DSH 官方文档 · Plugin Config Catalog](https://deepseek-harness.github.io/deepseek-harness/en/reference/config-catalog)
- [Codex · MCP](https://developers.openai.com/codex/mcp) —— ⚠️ 同批调研实测该站三个文档 URL 在本环境**一律 HTTP 403**，线上正文未能核验；Codex 侧的字段结论以本机 CLI 判定 + `openai/codex` 仓库 tag `rust-v0.156.1` 的 Rust 源码为准
- [@openai/codex-sdk · npm](https://www.npmjs.com/package/@openai/codex-sdk)

**同批调研的原始事实清单**（更长的逐行出处，本文是它们的收敛版；两者对同一结论的证实力不同，见下表）

| 文件 | 覆盖 | 本文采信到哪一步 |
|---|---|---|
| [2026-10-01-claude-agent-sdk-mcp-facts.md](./2026-10-01-claude-agent-sdk-mcp-facts.md) | Claude 全字段、`sdk.mjs` 源码分析、官方文档 URL | §1 的字段与坑 |
| [2026-10-01-codex-sdk-mcp-facts.md](./2026-10-01-codex-sdk-mcp-facts.md) | Codex 33 键字段矩阵（`exec --strict-config`）、Rust 源码、摊平 bug | §3.2 的两个摊平 bug、§3.4 的字段存在性、§3.6 第 8 条 |

> **两份清单都没能实测"模型真的调了一次 MCP 工具"**（它们的探针环境无凭据 / 模型不可达）。
> 本文 §1.4 / §2.5 / §3.5 的端到端结果由我这边跑出来 —— 这是它们与本文最强的一处互补。
