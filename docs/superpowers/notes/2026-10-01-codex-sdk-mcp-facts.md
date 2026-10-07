# Codex SDK（TypeScript）如何添加 MCP server —— 事实清单

> 调研对象：`@openai/codex-sdk@0.156.1`（包装 `codex exec --experimental-json`）+ 本地真实 CLI `codex.exe 0.156.1`
> 调研方式：**本地已安装包源码**（最权威）＋**真实 CLI 只读探测**（独立 `CODEX_HOME`，未触碰真实 `~/.codex`）＋**官方仓库源码/文档**
> 所有字段均为三类证据之一：① 本地类型定义/JS 实现原文 ② 真实 CLI 输出 ③ 官方源码或官方文档。**凡未能证实者一律列入文末「不确定/未能证实」。**
>
> 版本锚点：`@openai/codex-sdk` 0.156.1 / `codex-cli 0.156.1` / git tag `rust-v0.156.1` = `b412ff32c417f855c2b2d1581b77058eed87c84b`；Node v24.17.0；Windows x64。

---

## 0. 一句话结论

Codex SDK **没有** `mcpServers` 之类的专用选项。**唯一的注入通道**是把 Codex 原生 `config.toml` 的 `[mcp_servers.<name>]` 表写进 `new Codex({ config: { mcp_servers: { ... } } })`（SDK 会摊平成 `--config mcp_servers.<name>.<key>=<TOML字面量>` 重复传给 CLI），或用 `configOverrides: string[]` 直接传原始 `--config` 字符串。

---

## 1. 结论速查表

| # | 问题 | 结论 | 证据强度 |
|---|---|---|---|
| A | 有专门的 `mcpServers` 选项吗？ | **没有**。`CodexOptions` 只有 `codexPathOverride` / `baseUrl` / `apiKey` / `config` / `configOverrides` / `env`。注入通道只有 `config` 与 `configOverrides` | 本地 `dist/index.d.ts:214-240` 原文 |
| B | 键名？ | `config.mcp_servers.<serverName>.<field>`，**全小写 snake_case**。`mcpServers`（驼峰）不是 Codex 的键（那是别的工具的格式） | `codex-rs/core/src/config/mod.rs:852`；`mcp_types.rs:342-403` |
| B | 传输方式怎么定？ | **靠字段推断，没有 `type` 字段**：有 `command` ⇒ stdio；只有 `url` ⇒ streamable_http；都没有 ⇒ `invalid transport`；**两个都给 ⇒ 报错** | `mcp_types.rs:455-510`；实测 `url is not supported for stdio` |
| B | 超时单位？ | `startup_timeout_sec`=**秒**(f64)、`tool_timeout_sec`=**秒**(f64，可小数)、`startup_timeout_ms`=**毫秒**(u64，**legacy**，仅当 sec 未设时生效) | `mcp_types.rs:372-377, 440-446`；实测 `startup_timeout_ms=5000` → 输出 `5.0` 秒 |
| B | 默认超时？ | **30 秒启动 / 300 秒单工具**（0.156.1 源码）。注意：旧官方文档写的是 10 秒 / 60 秒 | `codex-mcp/src/rmcp_client.rs:103-104` vs 旧文档 |
| C | undefined 会怎样？ | **静默跳过**（不报错、不传） | `dist/index.js:343-345` |
| C | null / 嵌套数组会怎样？ | `null` ⇒ **SDK 抛异常**；嵌套数组 ⇒ SDK **不拦**，CLI 报 `invalid type: sequence, expected a string` | `index.js:379-380`；实测 |
| C | `env` 里带 `.` 的键？ | **会被点号拆成嵌套表而损坏**（`env.A.B` 被当成 `env.A` 下的 `B`）→ CLI 报 `invalid type: map, expected a string` | 实测 P10 |
| D | `-c` 与 `config.toml` 谁赢？ | **`-c` 赢**（同名标量覆盖）；CLI help 原文即写 "Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`" | 实测 P2；`codex --help` |
| D | SDK 注入顺序？ | 结构化 `config` → `configOverrides`（后写者胜）→ SDK 托管项（`baseUrl` 等）→ 线程选项 | `index.js:178-235`；README:149-160 |
| D | `CODEX_HOME`？ | 默认 `~/.codex`，决定 `config.toml`/会话/日志位置。**SDK 不会设置它**，所以 SDK 注入是叠加在用户真实 `~/.codex/config.toml` 之上的 | 实测隔离生效；README:150 "without modifying `CODEX_HOME`" |
| D | 项目级 `.codex/config.toml`？ | **实测 0.156.1 不生效**（`mcp list` 返回 `[]`，`doctor` 报 `mcp servers: 0`） | 实测 P4-1 / P4-2 |
| E | 工具名形态？ | **`mcp__<server>__<tool>`**（命名空间前缀 `mcp__`，分隔符 `__`），有净化/去重/128 字节截断与 `_<12位sha1>` 后缀 | `codex-mcp/src/tools.rs:22,225,228-234,296`；二进制真实串 `mcp__codex_apps__user_messaging__send_message` |
| E | 需要 `--experimental` 开关吗？ | **不需要**。MCP 无总开关特性位；SDK 传的 `exec --experimental-json` 在 0.156.1 **被接受**（对照：非法 flag 退出码 2） | `codex features list`；实测 |
| E | 非交互审批？ | `codex exec` 默认打印 `approval: never \| sandbox: read-only`，即**不弹交互审批**；字段级控制为 `default_tools_approval_mode` 与 `tools.<tool>.approval_mode` | 实测 stderr；`mcp_types.rs:264,387` |
| E | `enabled=false` 语义？ | **跳过初始化该 server**（仍留在配置里、`mcp list` 仍显示） | `mcp_types.rs:229-231`；实测 `"enabled": false` |
| F | Windows 需要 `cmd /c npx` 吗？ | **不需要**。Codex 自己用 `which` crate 按 `PATHEXT` 解析 `.cmd`/`.bat`，官方注释明确 `npx`/`pnpm`/`yarn` 可直接写 | `rmcp-client/src/program_resolver.rs:31-39,54` |
| F | `--strict-config` 会拒绝 `mcp_servers` 吗？ | **不会**。所有真实字段全部通过；但它**会**拒绝未知字段（含 `mcp_servers` 内部的拼错键）。另：`codex mcp` 子命令**不支持** `--strict-config` | 实测 T3/P4-P7 |
| G | 版本 | 本地 0.156.1；npm `latest` 已是 **0.159.2**（alpha 0.161.0-alpha.4）→ 本地落后 | npm registry |

---

## 2. 字段全量（带出处）

### 2.1 `CodexOptions` 完整原文（`dist/index.d.ts:214-240`）

```ts
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = {
    [key: string]: CodexConfigValue;
};
type CodexOptions = {
    codexPathOverride?: string;
    baseUrl?: string;
    apiKey?: string;
    /**
     * Additional `--config key=value` overrides to pass to the Codex CLI.
     *
     * Provide a JSON object and the SDK will flatten it into dotted paths and
     * serialize values as TOML literals so they are compatible with the CLI's
     * `--config` parsing.
     */
    config?: CodexConfigObject;
    /**
     * Raw `--config key=value` overrides to pass unchanged to the Codex CLI after
     * structured configuration and before SDK-managed or thread-specific overrides.
     */
    configOverrides?: string[];
    /**
     * Environment variables passed to the Codex CLI process. When provided, the SDK
     * will not inherit variables from `process.env`.
     */
    env?: Record<string, string>;
};
```

**注意**：这里**没有** `mcpServers`；导出符号清单（`index.d.ts:285`）里也没有任何 MCP 相关的*选项*类型。MCP 只出现在**事件**类型里（`McpToolCallItem`，`index.d.ts:42-63`，含 `server` / `tool` / `arguments` / `result` / `error` / `status`）。

`ThreadOptions`（`index.d.ts:246-259`）同样**没有** MCP 字段：`model` / `threadSource` / `sandboxMode` / `workingDirectory` / `skipGitRepoCheck` / `modelReasoningEffort` / `networkAccessEnabled` / `webSearchMode` / `webSearchEnabled` / `approvalPolicy` / `additionalDirectories`。

### 2.2 `[mcp_servers.<name>]` 字段全量（源自 `codex-rs/config/src/mcp_types.rs`，tag `rust-v0.156.1`）

`RawMcpServerConfig`（`mcp_types.rs:342-403`，注意 `#[schemars(deny_unknown_fields)]`）即 TOML 可反序列化的完整字段集：

**stdio 传输（写了 `command` 即选中）**

| 字段 | 类型 | 必填 | 出处 |
|---|---|---|---|
| `command` | string | ✅（stdio 必需） | `mcp_types.rs:346` |
| `args` | array\<string\>，默认 `[]` | ✕ | `:348` |
| `env` | map\<string,string\> | ✕ | `:350` |
| `env_vars` | array\<string \| {name, source?}\>，`source` ∈ `local`\|`remote` | ✕ | `:352`、`:103-110`、`:131-138` |
| `cwd` | string（路径） | ✕ | `:354` |

**streamable HTTP 传输（写了 `url` 即选中）**

| 字段 | 类型 | 出处 |
|---|---|---|
| `url` | string | `:360` |
| `bearer_token_env_var` | string（**环境变量名**，非 token 本身） | `:363` |
| `http_headers` | map\<string,string\> 静态头 | `:355`（在 `:464` 被限定为 HTTP-only） |
| `env_http_headers` | map\<string,string\>，值=环境变量名 | `:357` |
| `http_headers_helper` | string，本机 shell 命令，输出动态头 JSON；**仅本地环境可用** | `:364`、`:486-500` |

**共用**

| 字段 | 类型 / 取值 | 默认 | 出处 |
|---|---|---|---|
| `enabled` | bool | `true` | `:379`、`:558-560`；语义 `:229` |
| `required` | bool，`true` 时 `codex exec` 在该 server 初始化失败时**报错退出** | `false` | `:381`、`:233` |
| `supports_parallel_tool_calls` | bool | `false` | `:383` |
| `startup_timeout_sec` | f64 **秒** | 30（源码常量） | `:372`；`codex-mcp/src/rmcp_client.rs:103` |
| `startup_timeout_ms` | u64 **毫秒**（legacy，仅当 sec 未设时生效） | — | `:374`、`:440-446` |
| `tool_timeout_sec` | f64 **秒**（可小数） | 300（源码常量） | `:377`、`:598-622`；`rmcp_client.rs:104` |
| `enabled_tools` | array\<string\> 白名单 | — | `:389`、语义 `:266` |
| `disabled_tools` | array\<string\> 黑名单（在 `enabled_tools` **之后**生效） | — | `:391`、语义 `:270` |
| `default_tools_approval_mode` | `auto` \| `prompt` \| `writes` \| `approve` | — | `:387`、`:26-33` |
| `tools` | map\<toolName, {`approval_mode`?, `output_token_limit`?}\> | — | `:402`、`:84-92` |
| `auth` | `oauth`(默认) \| `chatgpt` \| `ema_auth` | `oauth` | `:370`、`:192-209` |
| `environment_id` | string | `"local"` | `:368`、`:23` |
| `scopes` | array\<string\> | — | `:393` |
| `oauth` | {`client_id`?, `callback_url`?, `callback_port`?(u16), `authorization_server_issuer`?} | — | `:395`、`:162-188` |
| `oauth_resource` | string（RFC 8707） | — | `:397` |
| `omit_tools_from` | array\<ToolExposureSurface\> | — | `:385` |
| `name` | string —— **legacy 显示名，被接受但忽略** | — | `:398-400` |
| `bearer_token` | string —— 结构里有，但**对 stdio 与 http 都被显式拒绝**，等于不可用 | — | `:362`、`:462`、`:485` |

> **`type` 不是字段**、**`headers` 不是字段**（要用 `http_headers`）、**`oauth_client_id` 不是顶层字段**（要用 `oauth.client_id`）—— 三者均被 `--strict-config` 判为 `unknown configuration field`。
> **`experimental_use_rmcp_client` 在 0.156.1 已被删除**（旧文档里有，二进制里搜不到该字符串，strict-config 判为未知字段）。

---

## 3. 真实探测记录（命令 + 输出 + 退出码）

> 所有 CLI 探测均设 `CODEX_HOME=D:\zhanglei1120\Github\ai-result-evaluation\.probe-mcp\codex-home*`（独立临时目录），**未读写真实 `~/.codex`**。
> `codex.exe` 路径：`node_modules\.pnpm\@openai+codex@0.156.1-win32-x64\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe`
> 为避免 PowerShell 破坏引号（`"` 被吞导致 TOML 解析失败），**凡涉及带引号 TOML 的注入，都用 Node 的 `child_process.spawn` 以 argv 数组直传**，这也正是 SDK 的真实调用方式。

### 3.1 版本与命令面

```
$ codex --version
codex-cli 0.156.1
exit=0

$ codex --help    # 摘录关键行
  mcp               Manage external MCP servers for Codex
  -c, --config <key=value>
          Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`.
          Use a dotted path (`foo.bar.baz`) to override nested values. The `value` portion is parsed
          as TOML. If it fails to parse as TOML, the raw string is used as a literal.
      --strict-config
          Error out when config.toml contains fields that are not recognized by this version of Codex
exit=0

$ codex mcp --help
Commands:
  list  get  add  remove  login  logout  help
exit=0

$ codex mcp add --help    # 摘录
Usage: codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)
      --env <KEY=VALUE>            Environment variables ... Only valid with stdio servers
      --url <URL>                  URL for a streamable HTTP MCP server
      --bearer-token-env-var <ENV_VAR>   ... Only valid with streamable HTTP servers
      --oauth-client-id <CLIENT_ID>
      --oauth-client-registration <AUTO|CIMD|DCR>
      --oauth-resource <RESOURCE>
exit=0
```

`codex features list`（节选 MCP 相关，默认值在最后一列）：

```
apps                                     stable             true
enable_mcp_apps                          under development  false
mcp_2026_07_28                           under development  false
mcp_oauth_refresh_coordination           under development  false
non_prefixed_mcp_tool_names              under development  false   ← 工具名前缀开关，默认关=带 mcp__ 前缀
tool_call_mcp_elicitation                stable             true
apps_mcp_path_override                   removed            false
tool_search_always_defer_mcp_tools       removed            true
exit=0
```
→ **没有任何"MCP 总开关"特性位**，说明 MCP 默认可用。

### 3.2 SDK 摊平代码 → CLI 端到端回放（决定性实验）

方法：从 `dist/index.js` 中**按字节切片取出真实发货代码** `serializeConfigOverrides` / `flattenConfigOverrides` / `toTomlValue` / `formatTomlKey`，用 `new Function` 执行（**不是重写**），再把产出的字符串以 argv 传给真实 `codex.exe mcp list --json`。

```
########## C1 stdio minimal ##########
SDK-produced override strings:
  --config "mcp_servers.local.command=\"node\""
  --config "mcp_servers.local.args=[\"C:\\\\tmp\\\\server.js\"]"
exit=0
stdout:
[ { "name": "local", "enabled": true, "disabled_reason": null,
    "transport": { "type": "stdio", "command": "node",
                   "args": [ "C:\\tmp\\server.js" ],
                   "env": null, "env_vars": [], "cwd": null },
    "startup_timeout_sec": null, "tool_timeout_sec": null, "auth_status": "unsupported" } ]

########## C2 stdio full field spread ##########
SDK-produced override strings:
  --config "mcp_servers.full.command=\"npx\""
  --config "mcp_servers.full.args=[\"-y\", \"@modelcontextprotocol/server-everything\"]"
  --config "mcp_servers.full.env.FOO=\"bar\""
  --config "mcp_servers.full.env.NUM=\"1\""
  --config "mcp_servers.full.cwd=\"D:\\\\tmp\""
  --config "mcp_servers.full.startup_timeout_sec=20"
  --config "mcp_servers.full.tool_timeout_sec=120"
  --config "mcp_servers.full.enabled=true"
  --config "mcp_servers.full.enabled_tools=[\"a\", \"b\"]"
  --config "mcp_servers.full.disabled_tools=[\"c\"]"
exit=0    # args/env/cwd/超时全部被正确解析

########## C3 http ##########
  --config "mcp_servers.http1.url=\"http://127.0.0.1:9/mcp\""
  --config "mcp_servers.http1.bearer_token_env_var=\"MY_TOKEN\""
  --config "mcp_servers.http1.http_headers.X-Static=\"v1\""
  --config "mcp_servers.http1.env_http_headers.X-Dyn=\"MY_DYN\""
exit=0
stdout transport: { "type": "streamable_http", "url": "...", "bearer_token_env_var": "MY_TOKEN",
                    "http_headers": {"X-Static":"v1"}, "env_http_headers": {"X-Dyn":"MY_DYN"},
                    "http_headers_helper": null }

########## C4 enabled=false ##########
  --config "mcp_servers.off.command=\"node\""
  --config "mcp_servers.off.enabled=false"
exit=0     stdout: "enabled": false, "disabled_reason": null

########## C5 undefined is skipped ##########
（输入含 mcp_servers.u.bogus = undefined）
  --config "mcp_servers.u.command=\"node\""      ← undefined 键被静默丢弃
exit=0

########## C6 null -> SDK throws ##########
SDK flatten THREW: Codex config override at mcp_servers.n.command cannot be null

########## C7 wrong type timeout (string 'abc') ##########
  --config "mcp_servers.t.tool_timeout_sec=\"abc\""
exit=1
stderr: Error: failed to load bootstrap configuration
        Caused by: invalid type: string "abc", expected f64
        in `mcp_servers.t.tool_timeout_sec`

########## C8 truly bogus key = 1 ##########
  --config "mcp_servers.b.bogus_key_xyz=1"
exit=0     ← 未知键被静默忽略！（这就是为什么"能跑通"不能证明字段存在）

########## C9 nested empty object ##########
  --config "mcp_servers.e={}"
exit=1
stderr: Caused by: invalid transport
        in `mcp_servers.e`

########## C10 startup_timeout_ms (legacy?) ##########
  --config "mcp_servers.m.startup_timeout_ms=5000"
exit=0
stdout: "startup_timeout_sec": 5.0     ← 毫秒字段被识别并换算成秒
```

> **C8 是本次调研最重要的方法论警告**：`codex mcp list` **不校验**未知键（因为它不支持 `--strict-config`）。所以"某字段被 CLI 接受"**不能**证明该字段存在。本清单中字段存在性的判据一律改用 §3.4 的 `--strict-config` 矩阵。

### 3.3 覆盖优先级 / CODEX_HOME / 项目级配置

配置文件 `CODEX_HOME/config.toml`：
```toml
[mcp_servers.dup]
command = "from_file_cmd"
[mcp_servers.fileonly]
command = "file_only_cmd"
[mcp_servers.full]
command = "from_file_full"
[totally_unknown_top_level]
x = 1
```

```
########## P1 mcp list --json （只读文件） ##########
exit=0   → dup/fileonly/full 三个都在，command 为 from_file_*

########## P2 -c 覆盖同名键 ##########
$ codex mcp list --json -c 'mcp_servers.dup.command="from_cli_cmd"'
exit=0   → dup.command = "from_cli_cmd"   ★ CLI 赢；fileonly/full 不受影响（是合并，不是替换）

########## P3 未知顶层 section，无 --strict-config ##########
exit=0   → [totally_unknown_top_level] 被静默忽略

########## P8 项目级 .codex/config.toml（cwd=含 .codex/config.toml 的目录，CODEX_HOME 为空） ##########
$ codex mcp list --json
exit=0   stdout: []        ← 项目级配置未被读取

########## P4-1 codex doctor --json （cwd=proj4，其中有 .codex/config.toml 且含 projlevel server） ##########
checks["config.load"].details:
  { "CODEX_HOME": "...\\.probe-mcp\\codex-home-empty",
    "config.toml": ["...\\codex-home-empty\\config.toml", "missing"],   ← 只列了 CODEX_HOME 的
    "configuration scope": "invocation config, including cloud-managed policy",
    "mcp servers": "0",                                                 ← 项目级的没被算进去
    "model": "<default>", ... }
checks["mcp.config"].details: {}
```

### 3.4 `--strict-config` 字段存在性矩阵（权威判据）

判据：`codex exec --strict-config --skip-git-repo-check <base> -c <被测键=值> hi`，若 stderr 含
`` unknown configuration field `<path>` `` 则该键**不存在**；否则（能走到后续流程或报其他类型错误）**存在**。
（对照组：非法 flag 退出码 2、`error: unexpected argument`。）

```
FIELD RECOGNITION under `codex exec --strict-config`

  RECOGNIZED    command / args / env.FOO / cwd / enabled / enabled_tools / disabled_tools
  RECOGNIZED    startup_timeout_sec / startup_timeout_ms / tool_timeout_sec
  RECOGNIZED    url / bearer_token_env_var / http_headers.X-Static / env_http_headers.X-Dyn
  RECOGNIZED    env_vars / required / supports_parallel_tool_calls / default_tools_approval_mode
  RECOGNIZED    tools.<t>.approval_mode / tools.<t>.output_token_limit
  RECOGNIZED    scopes / oauth.client_id / oauth.callback_url / oauth.callback_port
  RECOGNIZED    oauth.authorization_server_issuer / oauth_resource / auth / environment_id
  RECOGNIZED    http_headers_helper / name（legacy） / omit_tools_from   ← 见下注
  NOT A FIELD   type                              → unknown configuration field `mcp_servers.p.type`
  NOT A FIELD   headers（应为 http_headers）        → unknown configuration field `mcp_servers.p.headers`
  NOT A FIELD   oauth_client_id（扁平写法）          → unknown configuration field `mcp_servers.p.oauth_client_id`
  NOT A FIELD   experimental_use_rmcp_client      → unknown configuration field `mcp_servers.p.experimental_use_rmcp_client`
  NOT A FIELD   bogus_xyz（对照）                   → unknown configuration field `mcp_servers.p.bogus_xyz`
```
注：`omit_tools_from` / `oauth.authorization_server_issuer` / `bearer_token` 退出码为 1 但**不是** unknown-field 错误，属于"字段存在、取值/组合不合法"（分别对应枚举值非法、需 `auth="ema_auth"`、两种传输都禁用），与 `mcp_types.rs:385, 515-523, 462/485` 的校验逻辑完全一致。

其它 strict-config 行为：
```
$ codex --strict-config mcp list --json
exit=1  stderr: Error: `--strict-config` is not supported for `codex mcp`      ← mcp 子命令不支持

$ codex exec --strict-config --skip-git-repo-check hi     # config.toml 含 [unknown_top_level_section_xyz]
exit=1  stderr: Error loading config.toml:
                ...config.toml:5:2: unknown configuration field `unknown_top_level_section_xyz`
                  |
                5 | [unknown_top_level_section_xyz]
                  |  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^

$ codex exec --skip-git-repo-check -c totally_unknown_xyz=1 hi        # 不带 strict
exit=null（进程继续跑到调用模型后被我方 12s 超时杀死）  ← 未知键静默忽略
$ codex exec --strict-config --skip-git-repo-check -c totally_unknown_xyz=1 hi
exit=1  stderr: Error loading config.toml: unknown configuration field `totally_unknown_xyz` in -c/--config override
```
→ **`--strict-config` 同时校验 `-c` 覆盖**（错误信息里明确写 `in -c/--config override`）。

### 3.5 传输冲突 / 类型错误的报错原文

```
$ codex mcp list --json -c 'mcp_servers.both.command="node"' -c 'mcp_servers.both.url="http://127.0.0.1:9/mcp"'
exit=1  Caused by: url is not supported for stdio        in `mcp_servers.both`

$ codex mcp list --json -c 'mcp_servers.cmdarr.command=["npx", "-y", "pkg"]'
exit=1  Caused by: invalid type: sequence, expected a string    in `mcp_servers.cmdarr.command`

$ codex mcp list --json -c 'mcp_servers.na.command="node"' -c 'mcp_servers.na.args=[["nested"], "flat"]'
exit=1  Caused by: invalid type: sequence, expected a string    in `mcp_servers.na.args`
```

### 3.6 `--experimental-json` 是否仍被接受（SDK 依赖它）

```
CONTROL invalid flag   ["exec","--definitely-not-a-flag-xyz","hi"]
  exit=2   stderr: error: unexpected argument '--definitely-not-a-flag-xyz' found

experimental-json      ["exec","--experimental-json","hi"]
  exit=null（12s 超时杀死 = flag 被接受、进程继续）
json (plain)           ["exec","--json","hi"]                     exit=null（接受）
baseline no flag       ["exec","hi"]                              exit=null
strict-config + exp-json  ["exec","--experimental-json","--strict-config","hi"]  exit=null（接受）
```
→ 退出码 2 与 `unexpected argument` 是对照组，证明 `--experimental-json` **确实被 0.156.1 接受**（虽然它没出现在 `codex exec --help` 里）。`codex exec` 打印的默认策略头：

```
OpenAI Codex v0.156.1
--------
workdir: ... | model: gpt-6-astra | provider: openai | approval: never | sandbox: read-only
```

### 3.7 MCP 健康检查（`codex doctor --json`）

`codex doctor` 有专门的 `mcp.config` 检查项，可直接用来诊断 server 配置：

```
$ codex doctor --json -c 'mcp_servers.ghost.command="definitely-not-a-real-binary-xyz"'
exit=1（因 auth.credentials fail，与 MCP 无关）
checks["mcp.config"]:
  { "id": "mcp.config", "category": "mcp", "status": "warning",
    "summary": "MCP configuration has optional issues",
    "details": { "configured servers": "1", "disabled servers": "0", "stdio servers": "1",
                 "ghost": "stdio command \"definitely-not-a-real-binary-xyz\" is not resolvable (not found on PATH)" },
    "remediation": "Set the missing MCP env vars or disable the affected server." }
```

### 3.8 二进制字符串证据（工具名形态）

对 `codex.exe`（323,383,088 字节）做只读字符串搜索：

```
"mcp__"                       -> 命中（首个上下文）:
   ")`. Tool names are exposed as normalized JavaScript identifiers,
    for example `await tools.mcp__ologs__get_profile(...)`."
   第 2 处上下文（真实工具名表）:
   "...commanddescriptionapproval policy disallowed sandbox approval prompt
    mcp__codex_apps__user_messaging__send_message..."
"tool_timeout_sec" / "startup_timeout_sec" / "startup_timeout_ms"
"enabled_tools" / "disabled_tools" / "env_http_headers" / "bearer_token_env_var"  -> 均命中
"experimental_use_rmcp_client" -> NOT FOUND      ← 该字段已删除
"non_prefixed_mcp_tool_names"  -> 命中（tool_registry 特性表内）
```

### 3.9 官方源码中的工具命名与启动失败形态

`codex-rs/codex-mcp/src/tools.rs`（tag `rust-v0.156.1`）：
```rust
const LEGACY_MCP_TOOL_NAME_PREFIX: &str = "mcp__";        // :22
const MCP_TOOL_NAME_DELIMITER: &str = "__";               // :225
const MAX_TOOL_NAME_LENGTH: usize = 128;                  // :226
const CALLABLE_NAME_HASH_LEN: usize = 12;                 // :227
fn callable_namespace_with_prefix(namespace: &str, prefix_mcp_tool_names: bool) -> String {
    if !prefix_mcp_tool_names || namespace.starts_with(LEGACY_MCP_TOOL_NAME_PREFIX) {
        namespace.to_string()
    } else {
        format!("{LEGACY_MCP_TOOL_NAME_PREFIX}{namespace}")   // :232
    }
}
// 最终模型可见名 = namespace + tool_name
let model_name = format!("{namespace}{tool_name}");        // :296
```
→ 模型看到的名字是 `mcp__<server>__<tool>`；重名/超长时追加 `_<sha1前12位>`（`:243-246, :269-315`）。

`codex-rs/codex-mcp/src/connection_manager/startup.rs:104-144` 的启动失败文案：
```
超时     : MCP client for `<name>` timed out after <N> seconds. Add or adjust `startup_timeout_sec` in your config.toml:
           [mcp_servers.<key>]
           startup_timeout_sec = XX
未登录   : The <name> MCP server is not logged in. Run `codex mcp login <name>`.
           （或 "requires OAuth reauthentication"）
GitHub特例: GitHub MCP does not support OAuth. Log in by adding a personal access token (...) and config.toml:
           [mcp_servers.<key>]
           bearer_token_env_var = CODEX_GITHUB_PERSONAL_ACCESS_TOKEN
其它     : MCP client for `<name>` failed to start: <error>
```

`codex-rs/rmcp-client/src/program_resolver.rs:31-39`（Windows `npx` 问题的官方答案）：
```rust
/// Resolves a program to its executable path on Windows systems.
/// ... uses the `which` crate to search the `PATH` environment variable and find
/// the full path to the executable, including necessary script extensions
/// (`.cmd`, `.bat`, etc.) defined in `PATHEXT`.
///
/// This enables tools like `npx`, `pnpm`, and `yarn` to work correctly on Windows
/// without requiring users to specify full paths or extensions in their configuration.
```

---

## 4. 最小可用示例

### 4.1 stdio（TypeScript）

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({
  config: {
    mcp_servers: {
      everything: {
        command: "npx",                                   // Windows 上直接写 npx，无需 cmd /c
        args: ["-y", "@modelcontextprotocol/server-everything"],
        env: { LOG_LEVEL: "info" },                       // 键名请勿含 "."（见 §5.2）
        startup_timeout_sec: 30,
        tool_timeout_sec: 300,
        enabled: true,
      },
    },
  },
});

const thread = codex.startThread({ skipGitRepoCheck: true, sandboxMode: "read-only" });
const turn = await thread.run("列出你可用的 MCP 工具，并说明它们的名字");
console.log(turn.finalResponse);
// MCP 调用会以 item.type === "mcp_tool_call" 出现，含 server / tool / arguments / result
```

等价 `config.toml`：

```toml
[mcp_servers.everything]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-everything"]
startup_timeout_sec = 30
tool_timeout_sec = 300
enabled = true

[mcp_servers.everything.env]
LOG_LEVEL = "info"
```

### 4.2 streamable HTTP（TypeScript）

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({
  config: {
    mcp_servers: {
      linear: {
        url: "https://mcp.linear.app/mcp",       // 有 url 且无 command ⇒ streamable_http
        bearer_token_env_var: "LINEAR_MCP_TOKEN", // 这里放"环境变量名"，不是 token 本身
        http_headers: { "X-Client": "codex-sdk" },
        env_http_headers: { "X-Tenant": "TENANT_ID" },
        tool_timeout_sec: 120,
      },
    },
  },
  // ⚠ 一旦提供 env，SDK 不再继承 process.env —— 必须自己带上 PATH 等
  env: {
    ...(process.env as Record<string, string>),
    LINEAR_MCP_TOKEN: process.env.LINEAR_MCP_TOKEN ?? "",
    TENANT_ID: process.env.TENANT_ID ?? "",
  },
});

const thread = codex.startThread({ skipGitRepoCheck: true });
const turn = await thread.run("用 linear 的 MCP 工具列出我最近的 issue");
```

等价 `config.toml`：

```toml
[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
bearer_token_env_var = "LINEAR_MCP_TOKEN"
http_headers = { "X-Client" = "codex-sdk" }
env_http_headers = { "X-Tenant" = "TENANT_ID" }
tool_timeout_sec = 120
```

### 4.3 无法用点号路径表达时的逃生舱：`configOverrides`

```ts
const codex = new Codex({
  config:    { mcp_servers: { srv: { command: "node" } } },
  // 原始 TOML 片段，原样作为独立 --config 参数传入；晚于 config 生效，优先级更高
  configOverrides: [
    'mcp_servers.srv.env={ "A.B" = "v", "WEIRD KEY" = "w" }',
    'mcp_servers.srv.tools.my_tool.approval_mode="prompt"',
  ],
});
```

---

## 5. 坑与注意事项

### 5.1 SDK 侧

1. **没有 `mcpServers` 选项**，别按 Claude/Cursor 习惯写 `mcpServers`。Codex 的键是 `mcp_servers`（下划线）。（二进制里确实存在 `mcpServers` 字符串，但那是*迁移其他 agent 配置*用的：`expected migrated MCP config to be a TOML table … .cursor-plugin/plugin.json .mcp.json`。）
2. **SDK 不设置 `CODEX_HOME`**（README:150 明确 "without modifying `CODEX_HOME`"）。因此 `config`/`configOverrides` 是**叠加**在用户真实 `~/.codex/config.toml` 之上的；要完全隔离必须在 `env` 里显式给 `CODEX_HOME`，而且要记得 `env` 一旦提供就**不继承 `process.env`**。
3. **`env` 替换而非合并**（`index.js:245-253`）：`Object.assign(env, this.envOverride)` 走的是 override 分支，`process.env` 完全不参与。SDK 仍会注入 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 与 `CODEX_API_KEY`（`:254-259`）。
4. **`--strict-config` 是唯一能抓拼写错误的开关，而 SDK 从不传它**。所以 `config` 里键名写错（如 `toolTimeoutSec`、`startup_timeout_ms` 想当秒用）在 SDK 路径下**会被静默忽略**，表现为"MCP server 没生效但也不报错"。
5. **`apiKey` 走环境变量而非 `--config`**：`env.CODEX_API_KEY = args.apiKey`（`:257-259`）；而 `baseUrl` 走 `--config openai_base_url="..."`（`:188-193`，注意值是 **JSON.stringify 带双引号**）。
6. **argv 顺序即优先级**（`index.js:178-235`）：结构化 `config` → `configOverrides` → `baseUrl` → `--model` → 线程选项。README:159-160 原文："Raw overrides are applied after structured configuration and take precedence over them. SDK-managed settings, such as `baseUrl`, and thread-specific options are applied afterward and take precedence."
7. **`codexPathOverride` 必须是真正的可执行文件**。SDK 用 `spawn(path, args, {env, signal})`（`index.js:263-266`）**不带 `shell: true`**；在 Node 18.20/20.12+ 的安全修复之后，`.cmd`/`.bat` 包装器无法被这样直接 spawn。若要自定义 CLI，请指向 `codex.exe` 本体。

### 5.2 摊平/转义相关（有实测）

1. **`env` 的键含 `.` 会被拆成嵌套表而损坏**：
   `env: { "A.B": "v" }` → `--config mcp_servers.p.env.A.B="v"` → CLI 报
   `invalid type: map, expected a string in \`mcp_servers.esc.env.A\``（实测 P10）。绕法：用 `configOverrides` 传内联表。
2. **点号路径里的键不做 TOML bare-key 转义**。`formatTomlKey`（`index.js:386-389`）只用于**内联表**的键；点号路径部分直接拼接，实测含 `"` 的 env 键生成了破损的
   `mcp_servers.esc.env.with"quote="q"`。
3. **字符串用 `JSON.stringify`**（`:356`），产物是 TOML basic string。JSON 的转义集合（`\" \\ \b \f \n \r \t \uXXXX`）与 TOML 兼容，**中文、反斜杠 Windows 路径、`${ENV}` 字面量均安全**（实测 P10 中除上述点号/引号键外全部正确回读）。
4. **嵌套数组 SDK 不拦**：`args: [["nested"], "flat"]` → `[["nested"], "flat"]` → CLI 报 `invalid type: sequence, expected a string`。
5. **`undefined` 静默丢弃、`null` 直接抛异常**、非有限数字抛异常、`function/symbol/bigint` 抛 `Unsupported ... value at path: <type>`（`:343-345, 357-361, 379-384`）。
6. **空对象**：子层 `{}` → `prefix={}`（会触发 CLI `invalid transport`）；顶层 `{}` → 不产生任何 override（`:332-338`）。

### 5.3 配置语义相关

1. **`command` 与 `url` 互斥**，同给报 `url is not supported for stdio`（传输由二者**存在性**推断，没有 `type` 字段）。
2. **超时单位极易搞错**：`startup_timeout_sec`/`tool_timeout_sec` 是**秒**；`startup_timeout_ms` 是**毫秒且为 legacy**（`mcp_types.rs:440-446`：只有 `startup_timeout_sec` 缺失时才用 ms）。把 `10000` 写进 `startup_timeout_sec` = 10000 秒 ≈ 2.8 小时。
3. **默认超时不是旧文档写的 10s/60s，而是 30s/300s**（`codex-mcp/src/rmcp_client.rs:103-104`）。
4. `enabled_tools` 先白名单、再 `disabled_tools` 黑名单（`mcp_types.rs:266-272`）。
5. `enabled=false` 只是跳过初始化，配置仍在（`mcp list` 会显示 `"enabled": false`）；`required=true` 才会让 `codex exec` 在启动失败时报错退出。
6. `tool_timeout_sec` 默认 300s 是**每次工具调用**的超时，长任务（如跑测试）容易撞上。

### 5.4 Windows 专属

- **`npx`/`pnpm`/`yarn` 直接写即可，不需要 `cmd /c`**（`program_resolver.rs:31-39`）。Codex 用 `which::which_in(program, PATH, cwd)` 按 `PATHEXT` 解析到 `.cmd`/`.bat` 全路径；解析失败才回退原名让 `Command::new()` 报错（`:54-63`）。
- 解析失败的**可观测形态**（来自 `codex doctor --json` 的 `mcp.config`）：
  `stdio command "<x>" is not resolvable (not found on PATH)`。
- MCP server 的 `env` 由 Codex 构造（`rmcp-client/src/utils.rs` 有 `DEFAULT_ENV_VARS` 白名单）；Windows 上 `PATH` 大小写（`Path` vs `PATH`）在 SDK 侧被专门处理（`index.js:485-503`），但**自定义 `env` 时若只给 `PATH` 而系统期望 `Path`**，仍可能影响子进程查找。

### 5.5 验证手法建议

- 校验手写配置：`codex exec --strict-config ...`（**不要**用 `codex mcp list --strict-config`，它直接报不支持）。
- 看当前生效的 server 列表：`codex mcp list --json`（注意：**不校验未知键**）。
- 诊断 MCP 配置问题：`codex doctor --json`，看 `checks["mcp.config"]`。
- 隔离实验务必设 `CODEX_HOME` 指向临时目录（本次调研即如此，未触碰真实 `~/.codex`）。

---

## 6. 不确定 / 未能证实的地方

| 项 | 状态 | 说明 |
|---|---|---|
| `developers.openai.com/codex/mcp`、`/config-reference`、`/sdk/` 的**当前正文** | **未获取** | 三个 URL 在本环境一律 **HTTP 403**（PowerShell 直连、浏览器 UA、真实 Playwright 浏览器三种方式全部 403）。因此本文官方文档类证据改用 **openai/codex 仓库内 `docs/config.md`（提交 `88abbf58`）** 与 **tag `rust-v0.156.1` 的 Rust 源码**。 |
| 线上文档所述的**当前默认超时值** | 存疑 | 可获取的官方文档（`88abbf58`）写 `startup_timeout_sec` 默认 10、`tool_timeout_sec` 默认 60；0.156.1 源码常量为 30 / 300。二者不一致，**以本地二进制行为为准**，但无法排除线上新文档已改。 |
| MCP 工具在 `exec` 中的**实际调用与审批落地行为** | **未实测** | 环境无 Codex 凭据/模型不可达：`codex exec` 打印 `model: gpt-6-astra, provider: openai, approval: never, sandbox: read-only` 后即挂起（被超时杀死）。因此只能给出**配置字段**（`default_tools_approval_mode`、`tools.<tool>.approval_mode`）与"exec 不弹交互审批"的**默认策略头**证据，未观测到真实 `mcp_tool_call` 事件与审批分支。 |
| Windows 上 `command="npx"` 的**真实握手成功** | **未实测** | 同因（`mcp list`/`doctor` 不做握手，`exec` 走不到 MCP 工具调用）。结论来自 `program_resolver.rs` 官方源码注释与实现，**未**做端到端 npx handshake。 |
| stdio server **启动失败**在 `exec` 中的最终文案 | 部分未实测 | 文案来自源码 `connection_manager/startup.rs`；实测仅通过 `codex doctor --json` 的 `mcp.config` 拿到"not resolvable"形态。 |
| 项目级 `.codex/config.toml` | **实测不生效，但代码中似有该概念** | 0.156.1 上 `mcp list --json`（cwd=含 `.codex/config.toml` 的目录）返回 `[]`；`doctor --json` 报 `mcp servers: 0` 且 `config.toml` 只列 `CODEX_HOME` 那个（标 `missing`）。但 `codex.exe` 内含 `Error parsing project config file`、`Failed to read project config file`、`.codex`、`dotCodexFolder` 等字符串 ⇒ 概念存在于代码，可能需其他触发条件（信任、managed 层、或非 MCP 用途）。**结论：不要依赖项目级 `.codex/config.toml` 配 MCP。** |
| `omit_tools_from` 的**合法枚举值** | 未确定 | 字段确认为存在（非 unknown-field 错误），但 `["codex"]` 被判非法；未穷举 `ToolExposureSurface` 取值。 |
| `bearer_token`（明文） | 存在但不可用 | 结构体里有该字段，但 `mcp_types.rs:462`（stdio）与 `:485`（http）都对其 `throw_if_set` ⇒ 两种传输下都会报错。是否有任何可用场景未证实。 |
| `http_headers_helper` 的**实际行为** | 仅源码 | 声明为"仅本地环境的 shell 命令，输出动态 HTTP 头 JSON，命令可能被本机进程检查窥见，勿内嵌凭据"（`mcp_types.rs:591-594`）；未实测。 |
| SDK 在 **macOS/Linux** 上的行为 | 未实测 | 本次全部探测在 Windows x64 + Node v24.17.0 完成。 |
| 0.156.1 → 0.159.2 之间是否还有 MCP 相关 breaking change | 未核实 | 本地仅装 0.156.1；npm `latest` 为 0.159.2。本文未对比其 changelog。 |

---

## 7. 参考链接

- Codex 仓库（tag `rust-v0.156.1` = `b412ff32c417f855c2b2d1581b77058eed87c84b`）：<https://github.com/openai/codex/tree/rust-v0.156.1>
  - MCP 配置类型（字段全量权威）：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/mcp_types.rs>
  - 顶层 `mcp_servers` 字段：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/config/mod.rs>
  - 工具命名 `mcp__` / `__`：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-mcp/src/tools.rs>
  - 启动失败文案：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-mcp/src/connection_manager/startup.rs>
  - Windows 程序解析（npx 无需 cmd /c）：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/rmcp-client/src/program_resolver.rs>
  - 默认超时常量：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-mcp/src/rmcp_client.rs>
  - MCP CLI 实现：<https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/cli/src/mcp_cmd.rs>
- 官方配置文档（仓库内历史版本，含 MCP 字段与旧默认值）：<https://github.com/openai/codex/blob/88abbf58cec9843a7cebe250d71146314ebbcf1a/docs/config.md>
- 官方文档站（**本环境 403，未能读取正文**）：<https://developers.openai.com/codex/mcp>、<https://developers.openai.com/codex/config-reference>、<https://developers.openai.com/codex/sdk/>
- npm：<https://www.npmjs.com/package/@openai/codex-sdk>（registry 元数据：0.156.1 发布于 2026-09-23；`dist-tags`：`latest`=0.159.2、`alpha`=0.161.0-alpha.4）
- 本地包（最权威）：`node_modules/.pnpm/@openai+codex-sdk@0.156.1/node_modules/@openai/codex-sdk/dist/index.d.ts`、`dist/index.js`、`README.md`
