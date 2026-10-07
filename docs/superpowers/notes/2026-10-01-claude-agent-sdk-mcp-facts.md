# @anthropic-ai/claude-agent-sdk（TypeScript）如何添加 MCP server —— 事实清单

> 调研日期：以本机安装包为准
> **本地实测版本**：`@anthropic-ai/claude-agent-sdk@0.3.281`（`claudeCodeVersion: 2.1.281`）
> **npm 最新版本**（调研时 registry 返回）：`0.3.285`（`claudeCodeVersion: 2.1.285`）
> 证据类型标记：**[本地类型]** = 安装包 `.d.ts`；**[本地 JS]** = 安装包 `sdk.mjs`（minify 单行 bundle，只能给字符偏移 + 原文片段）；**[CLI]** = 本机 `claude.exe --help` / 子命令实测；**[官方文档]** = code.claude.com（未带版本号，即"最新版"）；**[变更日志]** = 官方 CHANGELOG；**[社区]** = GitHub issue（非官方）。

## 0. 证据路径速查

| 代号 | 路径 |
| :- | :- |
| `SDK/` | `D:\zhanglei1120\Github\ai-result-evaluation\node_modules\.pnpm\@anthropic-ai+claude-agent-_cbdca19109b707e2aa583597049da2ca\node_modules\@anthropic-ai\claude-agent-sdk\` |
| `SDK/sdk.d.ts` | `SDK/` 下的 `sdk.d.ts`（9578 行，全部类型） |
| `SDK/sdk.mjs` | `SDK/` 下的 `sdk.mjs`（~1.1 MB minify bundle） |
| `SDK/package.json` | `SDK/package.json`（version = 0.3.281） |
| `BIN/` | `D:\zhanglei1120\Github\ai-result-evaluation\node_modules\.pnpm\@anthropic-ai+claude-agent-sdk-win32-x64@0.3.281\node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\`（`claude.exe` + `package.json` version 0.3.281） |

注：`.pnpm` 下有两个含 `claude-agent-sdk` 的哈希目录（`@anthropic-ai+claude-agent-_cbdca19109b707e2aa583597049da2ca`、`..._f46869867c539b0e889a7e78eff4e916`），二者内容与版本完全相同（均 0.3.281）；上面选第一个作为引用基准。真正的 JS + `.d.ts` 在 `claude-agent-sdk/` 子目录中（另一个 `@anthropic-ai/sdk@0.123.0` 是 Anthropic API SDK，与 MCP 无关）。

---

## 1. 结论速查表

| 问题 | 结论 | 证据 |
| :- | :- | :- |
| 加 MCP server 的入口 | `query({ prompt, options: { mcpServers: { <名字>: <配置> } } })`，类型 `Record<string, McpServerConfig>` | [本地类型] `SDK/sdk.d.ts:1899`（JSDoc 示例 1885–1898）；[官方文档] <https://code.claude.com/docs/en/agent-sdk/mcp> |
| 支持几种传输 | **4 种**：stdio / sse / http / sdk（进程内）；另有 `claudeai-proxy`（仅出现在状态与内部类型中，不在 `McpServerConfig` 联合里） | [本地类型] `SDK/sdk.d.ts:1151`（联合）、`1104`（claudeai-proxy） |
| stdio 的 `type` | **可选**（`type?: 'stdio'`），省略即 stdio | [本地类型] `SDK/sdk.d.ts:1271`；[官方文档] <https://code.claude.com/docs/en/mcp>（"an entry with no `type`" 被读作 stdio） |
| sse / http / sdk 的 `type` | **必需**（`type: 'sse'` / `'http'` / `'sdk'`） | [本地类型] `SDK/sdk.d.ts:1254 / 1115 / 1132` |
| stdio 有 `cwd` 字段吗 | **没有**。字段只有 `type? / command / args? / env? / timeout? / alwaysLoad?` | [本地类型] `SDK/sdk.d.ts:1270–1284`；[官方文档] typescript 参考页的 `McpStdioServerConfig` 同样无 `cwd` |
| 支持进程内 SDK server 吗 | **支持**：`createSdkMcpServer()` + `tool()`，实例塞进 `mcpServers` | [本地类型] `SDK/sdk.d.ts:547`、`9355`、`1144`；[官方文档] <https://code.claude.com/docs/en/agent-sdk/custom-tools> |
| 工具命名 | `mcp__<serverName>__<toolName>`，`serverName` 就是 `mcpServers` 的 key | [官方文档] mcp 页 "Tool naming convention"、custom-tools 页 "Call a custom tool" |
| 通配符 | **allow 规则里通配符只允许出现在工具位、且 server 段必须是字面量**：`mcp__github__*`、`mcp__github__get_*` 合法；`mcp__*` 在 allow 规则里**非法**（deny/ask 规则允许任意位置通配） | [本地 JS] `SDK/sdk.mjs` 字符偏移 ~832664 的校验器（原文见 §4.3） |
| 不写 `allowedTools` 会怎样 | MCP 工具**可见但需授权**；SDK/headless 下没有 `canUseTool` 时，"ask" 直接变成终止性拒绝（不会抛错） | [官方文档] mcp 页 "Allow MCP tools"；[本地类型] `SDK/sdk.d.ts:5313` |
| `mcpServers` 与磁盘配置关系 | SDK 通过 `--mcp-config` **内联 JSON** 下发；`strictMcpConfig: true` 时只认它（映射 `--strict-mcp-config`） | [本地 JS] `SDK/sdk.mjs` ~1023401；[CLI] `claude.exe --help`；[本地类型] `SDK/sdk.d.ts:2227–2234` |
| `settingSources` 默认值 | **默认 = `['user','project','local']`（含 project，与 CLI 一致）**；0.1.0 曾改成"默认不读文件系统设置"，随后**回退** | [官方文档] typescript 参考页 "Default behavior"；[官方文档] migration-guide "Settings sources default"；[本地 JS] `SDK/sdk.mjs` ~1010034 `rNe=["user","project","local"]` |
| MCP 配置失败会不会报错 | **不抛异常**：失败体现在 `system/init` 的 `mcp_servers[].status`（`failed` / `needs-auth` / `pending`） | [官方文档] mcp 页 "Error handling" |
| 默认连接超时 | 连接/首轮等待 `MCP_TIMEOUT` 默认 **30 秒**；启动阻塞阶段上限默认 **5 秒**（`MCP_CONNECT_TIMEOUT_MS`） | [官方文档] mcp 页 "Connection timing"、"Connection timeouts"；[变更日志] 0.3.142 |
| Windows 下 `npx` | 官方文档（我读到的几页）**没有任何 Windows 专属说明**；社区 issue 大量报告 bare `npx`（实为 `npx.cmd`）触发 `spawn ENOENT` | [社区] 见 §6.4（明确标注为非官方） |

---

## 2. A. 传输形态与完整字段（带出处）

### 2.1 联合类型

```ts
// SDK/sdk.d.ts:1151
export declare type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;

// SDK/sdk.d.ts:1153 —— 可交给子进程/CLI 的"可序列化"子集（用于 AgentDefinition.mcpServers）
export declare type McpServerConfigForProcessTransport =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;
```

### 2.2 stdio（`SDK/sdk.d.ts:1270–1284`）

```ts
export declare type McpStdioServerConfig = {
    type?: 'stdio';          // ← 可选！
    command: string;         // ← 必填
    args?: string[];
    env?: Record<string, string>;
    timeout?: number;        // 每次 tool call 的硬超时(ms)，<1000 被视为无效
    alwaysLoad?: boolean;    // 不被 tool search 延迟加载
};
```
**没有 `cwd` 字段**（这是原始类型的全部字段）。

### 2.3 http（`SDK/sdk.d.ts:1114–1129`）

```ts
export declare type McpHttpServerConfig = {
    type: 'http';            // ← 必填
    url: string;
    headers?: Record<string, string>;
    tools?: McpServerToolPolicy[];   // 逐个工具的权限策略（always_allow/always_ask/always_deny）
    timeout?: number;
    alwaysLoad?: boolean;
};
```

### 2.4 sse（`SDK/sdk.d.ts:1253–1268`）

```ts
export declare type McpSSEServerConfig = {
    type: 'sse';             // ← 必填
    url: string;
    headers?: Record<string, string>;
    tools?: McpServerToolPolicy[];
    timeout?: number;
    alwaysLoad?: boolean;
};
```

### 2.5 sdk（进程内，`SDK/sdk.d.ts:1131–1146`）

```ts
export declare type McpSdkServerConfig = {
    type: 'sdk';
    name: string;
    timeout?: number;
};
/** MCP SDK server config with an actual McpServer instance. Not serializable - contains a live McpServer object. */
export declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
    instance: McpServer;
};
```

### 2.6 其他相关类型

- `McpClaudeAIProxyServerConfig = { type: 'claudeai-proxy'; url; id; timeout? }` — `SDK/sdk.d.ts:1104–1112`（用于 `McpServerStatusConfig`，**不在** `McpServerConfig` 联合里）。
- `McpServerToolPolicy = { name; permission_policy?: 'always_allow'|'always_ask'|'always_deny'; org_max_permission? }` — `SDK/sdk.d.ts:1226–1233`。
- `McpServerStatus`（`mcpServerStatus()` 返回）：`name / status: 'connected'|'failed'|'needs-auth'|'pending'|'disabled' / serverInfo? / error? / config? / scope? / source? / tools?` — `SDK/sdk.d.ts:1169–1219`。
- `McpServerProvenance = { name; source }`，`source` 取值开放集：`sdk | plugin | user | project | local | dynamic | managed | enterprise | claudeai | agent`，其中 **`dynamic` = `--mcp-config` / `mcp_set_servers` 传入的进程服务器** —— `SDK/sdk.d.ts:1156`（以及 `1199` 的字段注释）。这就是 SDK `mcpServers` 服务器在运行时的来源标签。

### 2.7 官方文档列的类型 vs 本地类型的差异（重要）

官方 TypeScript 参考页（<https://code.claude.com/docs/en/agent-sdk/typescript#mcpserverconfig>）给出的三个 process-transport 类型**只列了**：

```ts
type McpStdioServerConfig  = { type?: "stdio"; command: string; args?: string[]; env?: Record<string,string> };
type McpSSEServerConfig    = { type: "sse";  url: string; headers?: Record<string,string> };
type McpHttpServerConfig   = { type: "http"; url: string; headers?: Record<string,string> };
type McpSdkServerConfigWithInstance = { type: "sdk"; name: string; timeout?: number; instance: McpServer };
```

即文档**漏掉了 `timeout` / `alwaysLoad` / `tools`**（这三个在 0.3.281 的 `.d.ts` 里确实存在）。写文档时以本地 `.d.ts` 为准，并注明"文档页为简写"。

### 2.8 `AgentDefinition.mcpServers`（子代理）

`agents: Record<string, AgentDefinition>`，其中 `AgentDefinition.mcpServers?: AgentMcpServerSpec[]`，`AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>`（`SDK/sdk.d.ts:59`、`124`）。
即：可以是"父会话 `mcpServers` 里的服务器名"，也可以是内联配置（但不能是进程内实例）。另外 `strictMcpConfig` 的文档明确说：仍会使用**显式传入的 agent 定义**里声明的服务器（`SDK/sdk.d.ts:2228–2232`）。

---

## 3. B. 进程内 SDK MCP server（`createSdkMcpServer` + `tool`）

**支持，且是官方推荐的自定义工具方式。**

### 3.1 真实签名（[本地类型]）

```ts
// SDK/sdk.d.ts:547
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;

// SDK/sdk.d.ts:549–577
declare type CreateSdkMcpServerOptions = {
    name: string;
    version?: string;
    instructions?: string;                                  // initialize 返回、作为 MCP instructions block 给模型
    tools?: Array<SdkMcpToolDefinition<any>>;
    alwaysLoad?: boolean;                                   // 通过每个工具的 _meta['anthropic/alwaysLoad'] 生效
    timeout?: number;                                        // 该服务器 tool call 超时(ms)，<1000 无效
};

// SDK/sdk.d.ts:9355–9359
export declare function tool<Schema extends AnyZodRawShape>(
    _name: string,
    _description: string,
    _inputSchema: Schema,
    _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    _extras?: {
        annotations?: ToolAnnotations;
        searchHint?: string;
        alwaysLoad?: boolean;
    }
): SdkMcpToolDefinition<Schema>;

// SDK/sdk.d.ts:5096–5103
export declare type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
    name: string;
    description: string;
    inputSchema: Schema;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

配套约束：`inputSchema` 用 **Zod**（Zod 3 与 Zod 4 都支持，见 `SDK/sdk.d.ts:5091–5095` 注释与 [官方文档] custom-tools 页）；`package.json` 的 `peerDependencies` 要求 `zod ^4.0.0`、`@modelcontextprotocol/sdk ^1.29.0`、`@anthropic-ai/sdk >=0.93.0`（`SDK/package.json`）。

### 3.2 进程内实例是怎么送进 CLI 的（不是走 `--mcp-config`）

- **[本地 JS]** 启动器（`SDK/sdk.mjs` 字符偏移 ~1087897）把 `mcpServers` 一分为二：

```js
let mx={},gx=new Map;
if(rx) for(let[jt,Qt] of Object.entries(rx))
  if(Qt.type==="sdk"&&Qt.instance) gx.set(jt,Qt);   // 进程内，留在 SDK 进程
  else mx[jt]=Qt;                                    // 其余 → 命令行
```

之后 Query 拿到的是 `mcpServers:mx`（同文件 ~1089109），而 `mx` 才会进入 `--mcp-config`。
- **[本地 JS]** `initialize` 控制请求里带上进程内服务器名单（~1048059）：`{ subtype:"initialize", hooks, sdkMcpServers:t, sdkMcpServerConfigs:r, sdkMcpServerManifests:e, ... }`。
- **[本地类型]** `SDKControlInitializeRequest`：`sdkMcpServers?: string[]`（4287）、`sdkMcpServerConfigs?: Record<string,{timeout?:number}>`（4291）、`sdkMcpServerManifests?`（4300，0.3.281 新增的握手结果缓存，注释里说明它让 N 个进程内服务器在首轮前**不产生任何 mcp_message 往返**）。
- **[变更日志]** 0.3.281："Improved startup time for `query()` sessions with in-process MCP servers (`createSdkMcpServer`) by running their handshake inside the SDK; `initialize` may now wait up to 250 ms for them"。
- **[官方文档]** mcp 页："Only an SDK host application … can register an in-process `"type": "sdk"` server. Claude Code skips a `"type": "sdk"` entry in `.mcp.json`, `~/.claude.json`, or settings"（即磁盘配置写 `sdk` 无效）。

### 3.3 运行时增删

`Query.setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>`（`SDK/sdk.d.ts:3058`），实现里同样把 `type==='sdk' && 'instance' in l` 的分出来本地连接，其余走 `mcp_set_servers` 控制请求（[本地 JS] ~1062129）。返回值 `{ added: string[]; removed: string[]; errors: Record<string,string> }`（`SDK/sdk.d.ts:1238–1251`）。

---

## 4. C. 工具命名与启用

### 4.1 命名规则

`mcp__<server-name>__<tool-name>`（双下划线，前后各两个）。官方文档原话："MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>`. For example, a GitHub server named `"github"` with a `list_issues` tool becomes `mcp__github__list_issues`."（[官方文档] <https://code.claude.com/docs/en/agent-sdk/mcp> "Tool naming convention"）
custom-tools 页补充："The key in `mcpServers` becomes the `{server_name}` segment in each tool's fully qualified name: `mcp__{server_name}__{tool_name}`."

工具名解析实现（[本地 JS] `SDK/sdk.mjs` ~830683）：

```js
function tC(e){ let t=e.split("__"),[n,r,...o]=t;
  if(n!=="mcp"||!r) return null;
  let s=o.length>0?o.join("__"):void 0;
  return { serverName:r, toolName:s }; }
```

即：第一段必须字面是 `mcp`，第二段是服务器名，**其余全部**（含 `__`）算工具名。

### 4.2 `allowedTools` 里的写法

官方示例（[官方文档] mcp 页 "Auto-approve with allowedTools"）：

```ts
allowedTools: [
  "mcp__github__*",          // github 服务器的所有工具
  "mcp__db__query",          // 只要 db 的 query
  "mcp__slack__send_message" // 只要 slack 的 send_message
]
```

官方原话："Wildcards (`*`) let you allow all tools from a server without listing each one individually."

### 4.3 通配符的确切边界（本地实测的校验器源码）

`SDK/sdk.mjs` 字符偏移 ~832664（allow 规则校验，函数名 `AH`）：

```js
function AH(e){
  if(!Lm(e)) return null;                       // Lm = 字符串里含 "*"
  let t=tC(e);
  if(t && !Lm(t.serverName)) return null;       // 是 mcp__<字面 server>__... 且通配符不在 server 段 → 合法
  return { valid:!1,
    error:`Wildcard tool name "${e}" is not supported in allow rules`,
    suggestion:"An allow pattern must name the scope it widens — globs are permitted only in the tool position after a literal mcp__<server>__ prefix. Deny and ask rules accept wildcards anywhere",
    examples:["mcp__puppeteer__*","mcp__github__get_*"] };
}
```

同一模块（~833719）：

```js
error:"MCP rules do not support patterns in parentheses",
suggestion:`Use "${r.toolName}" without parentheses, or use "mcp__${o.serverName}__*" for all tools`,
examples:[`mcp__${o.serverName}`, `mcp__${o.serverName}__*`, `mcp__${o.serverName}__${o.toolName}`]
```

由此可确定：

| 写法 | allow（`allowedTools` / `permissions.allow`） | 备注 |
| :- | :- | :- |
| `mcp__github__list_issues` | ✅ | 精确工具 |
| `mcp__github__*` | ✅ | 该服务器全部工具 |
| `mcp__github__get_*` | ✅ | 工具名前缀通配 |
| `mcp__github` | ✅（校验器把它列为建议写法之一） | 等价于"该服务器"级别；[变更日志] 0.3.178 明确 `mcp__server` 是 **`disallowedTools`** 的服务器级写法 |
| `mcp__*` | ❌ 在 allow 规则里报 `Wildcard tool name "mcp__*" is not supported in allow rules` | 但 `AgentDefinition.disallowedTools` 明确接受 `mcp__*`（[官方文档] typescript#agentdefinition："`mcp__server` or `mcp__server__*` removes every tool from that server, and `mcp__*` removes every MCP tool from any server"） |
| `mcp__github__list_issues(pattern)` | ❌ | "MCP rules do not support patterns in parentheses" |

⚠️ 出处说明：上面这段是**安装包里 SDK 打包的 CLI 权限规则模块**。官方文档把 `allowedTools` 描述为 allow 规则（"Listed tools run without a permission prompt"、Permissions 页的 allow/deny rules），因此我判定它同样适用于 `--allowedTools`；但我**没有**单独跑通"`--allowedTools mcp__*` 被拒"的端到端实测 → 见 §7 不确定项 4。

### 4.4 不写 `allowedTools` 时的默认可见性/权限

- 可见性：**默认可见**（在模型上下文里或经 tool search 的延迟列表），但未授权。官方原话："MCP tools require explicit permission before Claude can use them. Without permission, Claude will see that tools are available but won't be able to call them."（[官方文档] mcp 页）
- 授权路径：命中 `allowedTools` / settings allow 规则 / 权限模式 → 直接执行；否则进入权限流程：有 `canUseTool` 就回调它，没有就按"没人回答"处理。
- **[本地类型]** `SDK/sdk.d.ts:5313`（`SDKPermissionDeniedMessage` 的注释）："Without one (bare `-p` / SDK `query()` with no `canUseTool`), 'ask' decisions are terminal, so this event also covers those implicit denials." → 即 **SDK 里既不写 `allowedTools` 也不给 `canUseTool` 时，MCP 调用会被直接拒绝（不是挂起、不是抛错）**。
- 权限模式（[官方文档] mcp 页 Note）：`permissionMode: "acceptEdits"` **不会**自动批准 MCP 工具（只管文件编辑/文件系统 Bash）；`"bypassPermissions"` 会，但范围过宽；官方建议用 `allowedTools` + 通配符精确放开。
- `permissionMode` 类型（[本地类型] `SDK/sdk.d.ts:2417`）：`'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`；文档同（typescript#permissionmode）。注意 CLI `--permission-mode` 的 choices 是 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`（[CLI] `claude.exe --help`）——CLI 用 `manual`，SDK 用 `default`，别混用。
- `disallowedTools` 是"可用性 + 权限"双层：裸名（如 `Bash`、或 `mcp__server`）会把工具从上下文移除；带作用域的规则只拦匹配调用（[官方文档] custom-tools 页 "Configure allowed tools" 表）。
- `tools` 选项**不影响** MCP 工具（只筛内置工具）："`tools: ["Read","Grep"]` … MCP tools are unaffected."（同上）。`tools: []` 时"Claude 只能用你的 MCP 工具"。

---

## 5. D. 配置来源叠加顺序

### 5.1 SDK 侧：`Options.mcpServers` → `--mcp-config`（内联 JSON）

[本地 JS] `SDK/sdk.mjs` 字符偏移 ~1023401（命令行拼装，节选）：

```js
if(ae.length>0) z.push("--allowedTools", ae.join(","));
if(N.length>0)  z.push("--disallowedTools", N.join(","));
...
if(ie && Object.keys(ie).length>0) z.push("--mcp-config", ne({mcpServers:ie}));   // ie = options.mcpServers（已剔除 sdk 实例）
if(k!==void 0) z.push(`--setting-sources=${k.join(",")}`);                        // k = options.settingSources
if(_e) z.push("--strict-mcp-config");                                             // _e = options.strictMcpConfig
if(b)  z.push("--permission-mode", b);
```

其中 `ne` 就是 `JSON.stringify`（同文件 ~215339：`function ne(e,t,n){ ... return JSON.stringify(e,t,n) }`）。
→ **`--mcp-config` 拿到的是内联 JSON 字符串 `{"mcpServers":{...}}`，不是临时文件**（CLI 本身两种都收，见 §6.2）。

### 5.2 磁盘侧作用域与优先级（[官方文档] <https://code.claude.com/docs/en/mcp> "Scope hierarchy and precedence"）

原话："When the same server is defined in more than one place, Claude Code connects to it once, using the definition from the highest-precedence source. **The entire server entry from that source is used; fields are not merged across scopes.**"

优先级（高→低）：
1. Local scope —— `~/.claude.json` 里该项目路径下的条目（默认作用域）
2. Project scope —— 项目根 `.mcp.json`（可提交）
3. User scope —— `~/.claude.json` 顶层
4. Plugin-provided servers
5. claude.ai connectors
（组织通过 `managedMcpServers` 下发的定义高于以上全部；需要 Claude Code ≥ 2.1.259）

同一文档另一处表格：`local` → `~/.claude.json`（仅当前项目私有）；`project` → 项目根 `.mcp.json`（团队共享）；`user` → `~/.claude.json`（跨项目）。

**本机实测旁证**（隔离 `CLAUDE_CONFIG_DIR` 后）：
- user scope 读的是 `$CLAUDE_CONFIG_DIR/.claude.json`（本机 `C:\Users\zhanglei1120\.claude.json` 原本不存在）；
- 同名 server 同时存在于 user scope 和 project `.mcp.json` 时，`claude mcp list` 打印 `MCP config diagnostics` → `[Conflicting scopes] Server "probe" is defined in multiple scopes with different endpoints: user (...), project (...)`，并提示 `claude mcp remove probe -s user|project`。这与文档"按名字匹配重复、不合并字段"一致。
- project `.mcp.json` 未审批时：`probe: … - ⏸ Pending approval (run \`claude\` to approve)`，**不会去连接它**（我的探针进程没有被启动）。文档说明：交互式会话会先问；`claude -p`、Agent SDK、cloud session 里无法弹窗，于是**不问直接加载**。

### 5.3 `strictMcpConfig`

[本地类型] `SDK/sdk.d.ts:2227–2234`：

> Only use MCP servers passed via the `mcpServers` option (and servers declared by explicitly-passed agent definitions in `agents`), ignoring all other MCP configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter — including subagent frontmatter MCP. Maps to the CLI `--strict-mcp-config` flag.

[CLI] `claude.exe --help`：`--strict-mcp-config  Only use MCP servers from --mcp-config, ignoring all other MCP configurations`。
默认 `false`（[官方文档] typescript 参考页 Options 表）。

### 5.4 `settingSources`：默认值确实"改过又改回来"

- **[官方文档] typescript#settingsource "Default behavior"**："When `settingSources` is omitted or `undefined`, `query()` loads the same filesystem settings as the Claude Code CLI: **user, project, and local**."
- **[官方文档] migration-guide "Settings sources default"**（直接回答了你的疑问）："This default was **briefly changed in v0.1.0** to load no filesystem settings and **then reverted**, so no migration action is needed." 当前行为：省略即加载 user/project/local，包含 `~/.claude/settings.json`、`.claude/settings.json`、`.claude/settings.local.json`、CLAUDE.md、自定义命令。
- **[本地 JS]** 同一默认值在安装包内也能看到：`SDK/sdk.mjs` ~1010034 `rNe=["user","project","local"]`，~1009842 `nNe={user:"userSettings",project:"projectSettings",local:"localSettings"}`，settings 加载器用 `(e.settingSources ?? rNe).map(...)`；而 Query 只在 `settingSources !== undefined` 时才追加 `--setting-sources=`（~1023401），缺省时交给 CLI 默认（[本地类型] `SDK/sdk.d.ts:2181` 注释："When omitted, all sources are loaded (matches CLI defaults)"）。
- 类型：`SettingSource = 'user' | 'project' | 'local'`（`SDK/sdk.d.ts:9033`）。
- `settingSources: []` = 不读 user/project/local（[本地类型] `SDK/sdk.d.ts:2182`；[变更日志] 0.2.90 修过 `--setting-sources ""` 吃掉下一个 flag 的 bug）。
- `.mcp.json` 何时生效（[官方文档] mcp 页）："The file is picked up when the `project` setting source is enabled, which it is for default `query()` options. If you set `settingSources` explicitly, include `"project"` for this file to load."
- 设置合并优先级（[官方文档] typescript#settings-precedence，高→低）：local > project > user；**"Programmatic options such as `agents`, `allowedTools`, and `settings` override user, project, and local filesystem settings. Managed policy settings take precedence over programmatic options."**（注意：这句话里**没有点名 `mcpServers`** → 见 §7 不确定项 1。）

### 5.5 其它影响 MCP 加载的开关

- 交互式审批相关设置：`enableAllProjectMcpServers`、`enabledMcpjsonServers`、`disabledMcpjsonServers`；`disabledMcpServers`/`enabledMcpServers`（项目内开关，存 `~/.claude.json`）。企业侧：`allowedMcpServers` / `deniedMcpServers`（[官方文档] mcp 页 / settings-reference）。
- 工作区信任：v2.1.196 起，未信任目录里，提交进 repo 的 `.claude/settings.json` 里的 `enableAllProjectMcpServers` / `enabledMcpjsonServers` **被忽略**，服务器停在 `⏸ Pending approval`（[官方文档] mcp 页 "Project server approvals and workspace trust"）。
- 保留名：`workspace`、`claude-in-chrome`、`computer-use`、`Claude Preview`、`Claude Browser`，自定义同名会被跳过并告警。
- `plugins[].skipMcpDiscovery`（[本地类型] `SDK/sdk.d.ts:5401`）：加载插件的 skills/hooks 但不读它的 `.mcp.json`/mcpServers 声明。

---

## 6. E. 环境变量与 CLI 透传

### 6.1 `env`

[本地类型] `SDK/sdk.d.ts:1580–1598`：

> When set, this value **REPLACES the subprocess environment entirely** — it is not merged with `process.env`. Spread `process.env` yourself if the subprocess still needs inherited variables like `PATH`, `HOME`, or `ANTHROPIC_API_KEY`. When omitted, the subprocess inherits `process.env`.

[官方文档] typescript Options 表：`env | Record<string,string|undefined> | process.env | …this replaces the subprocess environment instead of merging…`。
这也解释了历史上"必须 `env: { ...process.env, X }`"的写法。
MCP 相关的 env 变量都在这个子进程环境里生效（例如 `MCP_TIMEOUT`、`MCP_TOOL_TIMEOUT`、`CLAUDE_CODE_MCP_STARTUP_WAIT_MS`、`MCP_CONNECTION_NONBLOCKING`）。

### 6.2 `pathToClaudeCodeExecutable` 与 CLI 子进程

- `pathToClaudeCodeExecutable?: string`（`SDK/sdk.d.ts:1919–1921`）："Path to the Claude Code executable. Uses the built-in executable if not specified."
- 本机 0.3.281 通过 optionalDependency 分发**原生二进制**：`BIN/claude.exe`（240 MB），`SDK/package.json` 的 optionalDependencies 列出 8 个平台包。缺包时 SDK 抛 `Native CLI binary for <platform>-<arch> not found`（[官方文档] typescript#installation）。
- `extraArgs?: Record<string, string | null>`（`SDK/sdk.d.ts:1609–1613`）："Additional CLI arguments to pass to Claude Code. Keys are argument names (without --), values are argument values. Use `null` for boolean flags."（能否用它再塞一个 `mcp-config`/`strict-mcp-config` 我没验证 → §7）
- **`--mcp-config` 是"文件或内联 JSON 字符串"两种都行**：
  - [CLI] `claude.exe --help`：`--mcp-config <configs...>  Load MCP servers from JSON files or strings (space-separated)`。
  - [本地 JS]：SDK 用的永远是**内联字符串**：`z.push("--mcp-config", ne({mcpServers:ie}))`（`ne` = `JSON.stringify`，见 §5.1）。
- `--setting-sources=<逗号分隔>`：仅在 `options.settingSources` 显式给出时追加（[本地 JS] ~1023401）。[CLI] help：`--setting-sources <sources>  Comma-separated list of setting sources to load (user, project, local).`
- 进程内 SDK server **不经过命令行**（见 §3.2）。

### 6.3 MCP 相关环境变量与超时（官方文档值）

| 变量 | 作用 | 默认 | 出处 |
| :- | :- | :- | :- |
| `MCP_TIMEOUT` | 连接超时 / 首轮等待上限（毫秒） | **30000 ms** | [官方文档] mcp 页 "Connection timing"/"Connection timeouts" |
| `MCP_CONNECT_TIMEOUT_MS` | `MCP_CONNECTION_NONBLOCKING=0` 时阻塞启动的上限 | **5000 ms** | [官方文档] mcp 页；[本地类型] `alwaysLoad` 注释 "capped at the standard 5s connect timeout"（`sdk.d.ts:1125`） |
| `MCP_CONNECTION_NONBLOCKING` | `0` = 恢复"阻塞等待"旧行为 | 非阻塞（0.3.142 起） | [变更日志] 0.3.142 标注 **Breaking** |
| `CLAUDE_CODE_MCP_STARTUP_WAIT_MS` | 自己指定首轮等待；`0` 跳过 | 未设 | [官方文档] mcp 页（需 Claude Code ≥ 2.1.274）；[变更日志] 0.3.274 |
| `MCP_TOOL_TIMEOUT` | 单次 tool call 超时 | 未设时"effectively unbounded" / 约 28 小时 | [本地类型] `sdk.d.ts:543–545`、`1276`；[官方文档] mcp 页 "The per-server `timeout` … falls through to `MCP_TOOL_TIMEOUT`, or to its default of about 28 hours" |
| 每个服务器配置里的 `timeout` | 覆盖该服务器的 `MCP_TOOL_TIMEOUT`，硬墙钟，进度通知不延长；**<1000 被忽略** | 无 | [本地类型] `sdk.d.ts:1276`、`1109/1120/1259` |
| `MAX_MCP_OUTPUT_TOKENS` | 单条 MCP 输出上限 | **25000 tokens**（超过 10000 告警） | [官方文档] mcp 页 "MCP output limits and warnings" |
| `CLAUDE_PROJECT_DIR` | **由 Claude Code 注入到 stdio MCP server 的环境里**，值为项目根 | — | [官方文档] mcp 页 Option 3 |
| `CLAUDE_CODE_MCP_SERVER_URL`、`headersHelper` | 动态 header 相关 | — | [官方文档] mcp 页 |
| `MCP_DISCOVERY_CACHE=1/0` | 工具列表发现缓存 | 默认关（除非灰度） | [官方文档] mcp 页 |

### 6.4 首轮等待 / 连接时序（官方文档 mcp 页 "Connection timing"）

| 服务器类型 | 是否延迟首轮 | 首轮等待上限 |
| :- | :- | :- |
| stdio、或无缓存工具列表的 HTTP/SSE | 是，直到连上 | `MCP_TIMEOUT`，默认 30 s |
| 有缓存工具列表的远程服务器 | 否 | 首次调用才连 |
| 进程内 SDK server | 是（连上并 list 完工具） | `MCP_TIMEOUT` 默认 30 s/次尝试 |

来自 settings 文件/插件的服务器常显示 `pending`；当 `options.mcpServers` 里有 stdio/http/sse 时，首轮也会等这些 pending 服务器；当 `options.mcpServers` 为空或只含 SDK server 时，等待上限改为 **2 秒**（[变更日志] 0.3.284 补充：即使 `CLAUDE_CODE_MCP_STARTUP_WAIT_MS=0`，被 `allowedTools` 或 `mcp_tool` hook 点名的服务器仍会等最多 2 秒）。

---

## 7. F. 已知坑与注意事项

1. **stdio server 没有 `cwd` 字段**（`SDK/sdk.d.ts:1270–1284`）→ 无法在配置里指定服务器工作目录。
   官方可见的相关信息只有两条：(a) Claude Code 会把 `CLAUDE_PROJECT_DIR` 注入到被 spawn 的 stdio server 环境里（"so your server can resolve project-relative paths without depending on the working directory"）；(b) `headersHelper` 的工作目录表里写着：**"A server from the SDK's `mcpServers` option or `setMcpServers()` method, or `--mcp-config` → The session's primary working directory"**（[官方文档] mcp 页 "Where the helper runs"）。后者是关于 helper 命令的表格，属于**间接**证据。直接结论（stdio server 进程的 cwd 就是会话主工作目录 / `Options.cwd`）我**没有**拿到官方明文 → §8 不确定项 2。
2. **服务器启动失败不报错、也不阻塞**：`query()` 不会因为 MCP 连接失败而抛异常。要自己读 `system/init` 的 `message.mcp_servers`，判断 `status === 'failed' | 'needs-auth'`（`pending` 不等于失败）。可调用 `query.mcpServerStatus()` / `reconnectMcpServer()` / `toggleMcpServer()`（`SDK/sdk.d.ts:3058` 附近，[官方文档] mcp 页 "Error handling"）。远程服务器掉线会回到 `pending`，重试 5 次后变 `failed`。
3. **端口/安静失败的具体形态**：`claude mcp list` 里我实测到 `× Failed to connect — CONNECTION_CLOSED: Connection closed`，以及配置诊断 `[Conflicting scopes]` 警告块；`.mcp.json` 未审批是 `⏸ Pending approval (run claude to approve)`。
4. **Windows 下 `npx`**：官方文档（mcp 页 / agent-sdk mcp 页 / agent-sdk typescript 页）在我读到的内容里**没有任何** Windows 专属说明（也没有 `cmd /c`、`.cmd` 的指导）。社区有大量报告：bare `npx`（Windows 上是 `npx.cmd`）在 MCP 配置里会 `spawn ENOENT`，需要 `cmd /c npx …` 或写全路径 —— 例如 [anthropics/claude-code#18067](https://github.com/anthropics/claude-code/issues/18067)（"Inconsistent Windows `npx` wrapper requirements in MCP and Agent SDK examples"）、[#58510](https://github.com/anthropics/claude-code/issues/58510)（"plugin-shipped MCP servers using bare npx fail with spawn ENOENT"）、[#46360](https://github.com/anthropics/claude-code/issues/46360)、[microsoft/playwright-mcp#1540](https://github.com/microsoft/playwright-mcp/issues/1540)。**这些是社区 issue，不是官方结论**，只能当"风险提示"写进文档。
5. **`"url"` 但没 `"type"` = 配置错误**：Claude Code 把没有 `type` 的条目当 stdio，于是报 `MCP server "<name>" has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry`（v2.1.202 起是这个信息；此前是 `command: expected string, received undefined`）— [官方文档] mcp 页。
6. **`"type": "sdk"` 写在磁盘配置里无效**：只有 SDK 宿主进程能注册；CLI 会跳过并报 `Skipped — MCP server "<name>" declares type "sdk", which only an SDK host application can register`（[官方文档] mcp 页）。
7. **`type:"sdk"` 但缺 `instance` 的条目**：类型上允许（`McpServerConfigForProcessTransport` 含无实例的 `McpSdkServerConfig`，用于 agent 定义），但 SDK 启动器只把"有 `instance`"的挑出来本地注册（`Qt.type==="sdk"&&Qt.instance`），剩下的会进 `--mcp-config`，于是被 CLI 跳过。→ §8 不确定项 6。
8. **大小写/命名**：服务器名就是 `mcpServers` 的 key，直接拼进工具名；重名跨作用域会冲突并产生上面的诊断警告。保留名（`workspace` 等）会被跳过。`claude mcp add` 限制名字只能用字母数字连字符下划线。
9. **tool search 默认开启** → MCP 工具默认**延迟加载**（首轮只给紧凑列表），`alwaysLoad: true`（server 级或 tool 级）可豁免；豁免会**阻塞启动直到该服务器连上（上限同 5 s 连接上限）**（`SDK/sdk.d.ts:1125`、`1280`；[官方文档] custom-tools 页）。
10. **输出截断**：>25 000 tokens 且无图片时，输出被写进 session 的 `tool-results` 目录，模型只看到文件路径；可用 `MAX_MCP_OUTPUT_TOKENS` 或工具 `_meta["anthropic/maxResultSizeChars"]`（上限 500 000 字符）调整。图片结果另存文件需要 Claude Code ≥ 2.1.283。
11. **SSE 已弃用**：官方 Warning "The SSE (Server-Sent Events) transport is deprecated. Use HTTP servers instead"；`claude mcp add --transport http` 会先试 HTTP、失败自动切 SSE（需 ≥ 2.1.265）。JSON 配置里 `"streamable-http"` 是 `"http"` 的别名，但 **SDK 的 `McpHttpServerConfig` 只声明 `"http"`**，代码里请写 `type: "http"`（[官方文档] mcp 页 + typescript 参考页）。`"ws"` 只在 JSON 配置里支持，`claude mcp add --transport` 不接受 `ws`。
12. **0.3.142 的破坏性变更**：MCP 服务器改为**后台连接**，会话立刻启动，慢服务器在 `init` 里显示 `pending`；`MCP_CONNECTION_NONBLOCKING=0` 恢复旧的"最多等 5 s"，或给服务器 `alwaysLoad: true` 要求它首轮就绪。
13. **0.2.90 的老 bug 类**：`settingSources: []` 曾经产生 `--setting-sources ""` 并吃掉下一个 CLI flag；0.1.28 曾有"自定义工具 30 秒超时而不遵守 `MCP_TOOL_TIMEOUT`"；0.2.94 曾"MCP 子进程在 session 结束时没被清理"。升级到 0.3.281 都已修。
14. **`.mcp.json` 的 `${VAR}` 展开**：支持 `${VAR}` 与 `${VAR:-default}`，可展开于 `command`/`args`/`env`/`url`/`headers`；但**远程服务器的 `url`/`headers` 里，形如凭据的环境变量会被当成空值**（防止把 Claude Code 自己的凭据发给第三方服务器）。`CLAUDE_PROJECT_DIR` 在该 server 自己的环境里，所以要在 `.mcp.json` 的 `command`/`args` 里引用它必须写 `${CLAUDE_PROJECT_DIR:-.}`。

---

## 8. 最小可用示例（全部取自官方文档原文 / 本地类型）

### 8.1 stdio（[官方文档] agent-sdk/mcp 页，npx 文件系统服务器）

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "List files in my project",
  options: {
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
      }
    },
    allowedTools: ["mcp__filesystem__*"]
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

`env` 传凭据（[官方文档] 同页 "Pass credentials via environment variables"）：

```ts
mcpServers: {
  "api-server": {
    command: "npx",
    args: ["-y", "@your-org/api-mcp-server"],
    env: { API_KEY: process.env.API_KEY }
  }
},
allowedTools: ["mcp__api-server__*"]
```

### 8.2 http（[官方文档] agent-sdk/mcp 页 Quickstart + "HTTP headers for remote servers"）

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Use the docs MCP server to explain what hooks are in Claude Code",
  options: {
    mcpServers: {
      "claude-code-docs": {
        type: "http",
        url: "https://code.claude.com/docs/mcp"
      }
    },
    allowedTools: ["mcp__claude-code-docs__*"]
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

带鉴权头（[官方文档] 同页）：

```ts
"secure-api": {
  type: "http",
  url: "https://api.example.com/mcp",
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }
}
```

### 8.3 sse（[官方文档] agent-sdk/mcp 页 "HTTP/SSE servers"）

```ts
mcpServers: {
  "remote-api": {
    type: "sse",
    url: "https://api.example.com/mcp/sse",
    headers: { Authorization: `Bearer ${process.env.API_TOKEN}` }
  }
},
allowedTools: ["mcp__remote-api__*"]
```

### 8.4 进程内 SDK server（[官方文档] agent-sdk/custom-tools 页原文）

```ts
import { tool, createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// 1) 定义工具：name / description / Zod schema / handler
const getTemperature = tool(
  "get_temperature",
  "Get the current temperature at a location",
  {
    latitude: z.number().describe("Latitude coordinate"),
    longitude: z.number().describe("Longitude coordinate")
  },
  async (args) => {
    // args 由 schema 推出类型：{ latitude: number; longitude: number }
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m&temperature_unit=fahrenheit`
    );
    const data: any = await response.json();
    return {
      content: [{ type: "text", text: `Temperature: ${data.current.temperature_2m}°F` }]
    };
  }
);

// 2) 包成进程内 MCP server（返回 McpSdkServerConfigWithInstance，含活实例，不可序列化）
const weatherServer = createSdkMcpServer({
  name: "weather",
  version: "1.0.0",
  tools: [getTemperature]
});

// 3) 通过 mcpServers 传入；key "weather" 决定工具名前缀 mcp__weather__*
for await (const message of query({
  prompt: "What's the temperature in San Francisco?",
  options: {
    mcpServers: { weather: weatherServer },
    allowedTools: ["mcp__weather__get_temperature"]
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

可选的 extras（[官方文档] custom-tools 页 / typescript 参考页）：

```ts
tool("get_temperature", "…", { latitude: z.number() }, async (args) => ({ content: [] }), {
  annotations: { readOnlyHint: true },   // 输出：{ content: [...], isError?: true, structuredContent?: {...} }
  alwaysLoad: true,                      // 不被 tool search 延迟
  searchHint: "current weather by coordinates"
});

createSdkMcpServer({ name: "weather", version: "1.0.0", tools: [...], timeout: 600000, alwaysLoad: false });
```

handler 的约定（[官方文档] custom-tools 页）：返回对象必须含 `content`（数组，元素 `type` 为 `"text" | "image" | "audio" | "resource" | "resource_link"`），可选 `structuredContent`、`isError: true`。**handler 抛异常不会中断 agent loop**：SDK 的进程内 MCP server 会把异常转成 error result 给模型。

---

## 9. G. 版本信息与 MCP 相关的破坏性变更

- **本地安装版本**：`@anthropic-ai/claude-agent-sdk@0.3.281`（`SDK/package.json` 的 `version` 字段），`claudeCodeVersion: "2.1.281"`；平台包 `@anthropic-ai/claude-agent-sdk-win32-x64@0.3.281`（`BIN/package.json`）；`BIN/manifest.json` 里 `version: 2.1.281`、`buildDate: 2026-09-23`。
- **npm 最新**（调研时）：`0.3.285`，`claudeCodeVersion: 2.1.285`（<https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest>，包页 <https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk>）。0.3.281 → 0.3.285 之间无 MCP 相关的破坏性变更（0.3.282/283/284/285 的 MCP 条目都是修复类，如 `toggleMcpServer` 连接未关闭、MCP elicitation 拒绝等）。
- **版本对齐规则**（[官方文档] typescript#installation）："The SDK version tracks the bundled Claude Code version. SDK v0.3.191 bundles Claude Code v2.1.191, so a feature on this page that requires a Claude Code version needs the SDK release with the same patch number or later." → 文档页无版本号，即"最新版"；本地 0.3.281 落后 4 个补丁。
- **`/core` 子入口**：文档提到 `@anthropic-ai/claude-agent-sdk/core`（导出 `query/tool/createSdkMcpServer/resolveSettings`），**要求 ≥ 0.3.282**；本地 0.3.281 的 `package.json` `exports` 里**没有** `./core`（只有 `.`、`./extract`、`./browser`、`./bridge`、`./sdk-tools`）→ 本地不能用。
- **MCP 相关的破坏性/行为变更（CHANGELOG 摘录，按版本）**：
  - `0.1.0`：Settings 默认值短暂改为"不读文件系统设置"（**后已回退**，见 §5.4）；`customSystemPrompt`/`appendSystemPrompt` 合并为 `systemPrompt`。
  - `0.2.27`：`tool()` 支持 `annotations`；`mcpServerStatus()` 开始包含 SDK/动态服务器的工具。
  - `0.2.69`：修 SDK 模式 MCP server 被后台插件安装刷新时掉线；声明 `type:"http"` 的服务器在严格 Streamable HTTP 服务端上 406 的修复在 `0.2.70`。
  - `0.2.91`：`PermissionMode` 增加 `'auto'`（影响权限类型，进而影响"哪些模式会自动批准 MCP 工具"）。
  - `0.3.142`：**Breaking** —— MCP 服务器默认后台连接，`init` 里可能出现 `pending`；`MCP_CONNECTION_NONBLOCKING=0` 恢复旧行为。
  - `0.3.178`：修 `disallowedTools` 里 `mcp__server` / `mcp__server__*` 被静默忽略。
  - `0.3.221`：修 `mcpServers` 传入的外部服务器首轮前未连接（导致模型把工具调用当纯文本输出）。
  - `0.3.248`：`createSdkMcpServer({ timeout })` 新增。
  - `0.3.257`：修 `mcp_reconnect`/`mcp_toggle` 误作用于同名 `.mcp.json`/`~/.claude.json` 服务器（即 SDK/`--mcp-config` 服务器与磁盘同名服务器是**并存**的）。
  - `0.3.274`：`canUseTool` 新增 `mcpServer: {name, source}`、工具 hook 输入新增 `mcp_server`、`McpServerStatus` 新增 `source`；新增 `CLAUDE_CODE_MCP_STARTUP_WAIT_MS`。
  - `0.3.281`（=本地）：进程内 MCP server 握手改到 SDK 内完成，`initialize` 最多多等 250 ms。
  - `0.3.282`：新增 `/core` 入口（MCP 工具助手也在其中）。

---

## 10. 不确定 / 未能证实的地方（明确标注）

1. **`Options.mcpServers`（即 `--mcp-config`，运行时 source=`dynamic`）与同名磁盘配置（`.mcp.json` / `~/.claude.json`）之间到底谁赢：官方文档没有写。**
   文档只给了**配置作用域之间**的优先级（local > project > user > plugin > claude.ai，且不合并字段），`--mcp-config`/SDK 传入的服务器不在这个列表里。文档 typescript#settings-precedence 只说"programmatic options（举例 `agents`/`allowedTools`/`settings`）覆盖 user/project/local 文件设置"，**没有点名 `mcpServers`**。
   [变更日志] 0.3.257 只能证明两者**可以同名并存**（且能分别操作）。
   我尝试实测但**失败**：`claude mcp list --mcp-config ...` 被 CLI 拒绝（`error: unknown option '--mcp-config'`，该子命令不解析这个全局 flag）；改用"隔离 `CLAUDE_CONFIG_DIR` + user scope 探针"时，CLI 确实读到并识别了配置（打印了 `Conflicting scopes` 与 `Failed to connect — CONNECTION_CLOSED`），**但我的探针进程始终没有执行**（没有写出标记文件，绝对路径 node 也一样）——判断是本 harness 的进程沙箱阻断了子进程/管道，而不是 CLI 行为。因此**"谁优先"这一条我没有拿到可信证据**，请勿在文档里写死；如需确定，建议在无沙箱的机器上跑一次 `claude -p` / SDK `query()` 并用两个同名但端点不同的服务器观察 `init.mcp_servers[].config`。
   （次要旁证：我实测到未审批的 project `.mcp.json` 服务器**不生效**，此时低优先级的 user scope 定义会被连接 —— 说明"审批状态"会先于优先级起作用。）
2. **stdio MCP server 进程的实际 `cwd`：无官方明文。** 类型里没有 `cwd`；文档只说明 (a) `CLAUDE_PROJECT_DIR` 会被注入到该 server 的环境、(b) `headersHelper` 命令在 "the session's primary working directory" 下运行（这是 helper 的规则，不是 server 进程的规则）。我的 spawn 探针因上述沙箱问题没能跑起来，所以无法实测。**结论只能写到"配置里无法指定 cwd；官方文档未明确说明 spawn 时的工作目录，但会在环境里提供 `CLAUDE_PROJECT_DIR`"这个程度。**
3. **Windows 下 `.cmd` / `npx` 的处理：没有官方文档依据。** 我只找到社区 issue（§7.4）。安装包 `sdk.mjs` 里确实有一段 Windows 专用命令解析（`$ue = new Set([".com",".exe",".bat",".cmd"])`、调用 `where.exe` 的 `Hue()`，字符偏移 ~388102 附近），但**无法确认它是否用于 MCP stdio spawn**（MCP 子进程是原生 CLI 启动的），因此不作为证据。
4. **`--allowedTools` CLI flag 是否与 settings 的 allow 规则走同一套校验器**：校验器代码在安装包内的权限规则模块里（§4.3），文档把 `allowedTools` 描述为 allow 规则，逻辑上应一致，但我没有端到端实测"`mcp__*` 在 allowedTools 里被拒"。写文档时建议把 `mcp__*` 列为"不要在 `allowedTools` 里用"（有校验器原文支持），而不是"CLI 一定报错"。
5. **官方文档页与 0.3.281 的字段差异**：typescript 参考页的类型块缺少 `timeout`/`alwaysLoad`/`tools`（§2.7）。我不知道这是文档简化还是文档滞后；**以本地 `.d.ts` 为准**。
6. **`type:"sdk"` 但无 `instance` 的条目**：类型允许（子代理场景），SDK 启动器只把"有 instance"的挑出来（`Qt.type==="sdk"&&Qt.instance`），所以我**推断**无 instance 的 sdk 条目会被写进 `--mcp-config` 并被 CLI 跳过（CLI 文档明确说会跳过 `type:"sdk"` 条目）。该推断未实测。
7. **`extraArgs` 里塞 `mcp-config` / `strict-mcp-config` 的效果**（会不会与 SDK 自己拼的参数冲突、顺序如何）未验证。
8. **`0.3.281` 里 `initialize` "最多多等 250 ms"（进程内服务器握手）** 只有 CHANGELOG 文字，没有实测。
9. **`mcp_set_servers` 的运行时增删与 `strictMcpConfig` 的交互**、`setMcpServers()` 对同名磁盘服务器的影响，未验证（0.3.257 的修复暗示两者并存且按来源区分）。
10. **文档版本**：code.claude.com 的页面不带版本号，无法确认我引用的是否与 0.3.285 完全一致；按官方"same patch number or later"规则，0.3.281 应具备其中 2.1.281 及以前描述的能力（例如 "requires v2.1.283 or later" 的图片落盘能力本地就还没有）。

---

## 11. 引用清单（URL）

- Agent SDK + MCP：<https://code.claude.com/docs/en/agent-sdk/mcp>（`.md` 纯文本版：<https://code.claude.com/docs/en/agent-sdk/mcp.md>）
- Agent SDK 自定义工具（进程内 MCP server）：<https://code.claude.com/docs/en/agent-sdk/custom-tools>
- TypeScript 全量参考（Options / McpServerConfig / SettingSource / PermissionMode / CanUseTool）：<https://code.claude.com/docs/en/agent-sdk/typescript>
- 迁移指南（`settingSources` 默认值变更与回退）：<https://code.claude.com/docs/en/agent-sdk/migration-guide>
- Claude Code CLI 的 MCP（作用域与优先级、`.mcp.json`、超时、输出上限）：<https://code.claude.com/docs/en/mcp>
- 变更日志（本报告大量版本证据）：<https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/main/CHANGELOG.md>（仓库 <https://github.com/anthropics/claude-agent-sdk-typescript>）
- npm 包页 / registry：<https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk>、<https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest>
- 社区（非官方，Windows npx 问题）：<https://github.com/anthropics/claude-code/issues/18067>、<https://github.com/anthropics/claude-code/issues/58510>、<https://github.com/anthropics/claude-code/issues/46360>
