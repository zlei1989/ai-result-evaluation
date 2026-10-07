# `@anthropic-ai/claude-agent-sdk` 如何添加 skill（实测调研）

**一句话结论：skill 只能以文件形式落盘，SDK 不提供编程式注册 API。** 加 skill = 把 `SKILL.md` 放进三个被扫描的目录之一，再用 `settingSources` 放行、用 `skills` 收窄。

- 调研对象：本机安装的 `@anthropic-ai/claude-agent-sdk@0.3.281`（内置 CLI `2.1.281`）。
- 证据分三层，**每层都在下文标明出处**：SDK 类型面（`sdk.d.ts`，最高）、官方文档、本机真机回环实测。
- 实测脚本全部落在 `.probe-ws/claude-skills/`，可原样复跑，**零 API 成本**（本地 mock，不产生真实模型调用）。

---

## 0. 权威来源

| 层 | 来源 | 权威性 |
|---|---|---|
| 类型面 | `node_modules/.pnpm/@anthropic-ai+claude-agent-_cbdca19109b707e2aa583597049da2ca/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（9578 行） | 最高，随包发布 |
| 文档 | `https://code.claude.com/docs/en/agent-sdk/skills` | 高 |
| 运行时 | `.probe-ws/claude-skills/probe*.mjs`：真实 CLI 子进程 + 本地回环 mock，抓 `/v1/messages` 请求体 | 最高（运行时报文） |

官方逐字（决定了整个调研的形状）：

> Unlike subagents, which you can define in the [`agents` option](...), you create skills as files on disk. **The SDK doesn't provide a programmatic API for registering them.**

⇒ 「添加 skill」这件事没有 SDK 调用可写，只有**文件 + 开关**。

---

## 1. 三条加法（全部本机实测命中）

### 1.1 项目级 —— `<cwd>/.claude/skills/<name>/SKILL.md`

```text
<cwd>/.claude/skills/security-check/
└── SKILL.md
```

```markdown
---
name: security-check
description: Run a security vulnerability scan
---

Analyze the codebase for security vulnerabilities including: ...
```

放行条件：`settingSources` 含 `'project'`。**默认（不传 `settingSources`）就已经含 user + project**，所以这一步通常不用写。

### 1.2 用户级 —— `$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`

⚠️ 这是本次调研最容易被写错的一格，值得单独记：**用户级 skill 的落点是 `$CLAUDE_CONFIG_DIR/skills/`，不是 `~/.claude/skills/`。** 两者只在 `CLAUDE_CONFIG_DIR` 未显式设置时才等价（它默认就是 `~/.claude`）。

实测（`probe2.mjs`，四个候选落点同时放 skill，看哪个被识别）：

```text
[命中]   probe-project               （<cwd>/.claude/skills/）
[命中]   probe-configdir             （$CLAUDE_CONFIG_DIR/skills/）
[未命中] probe-configdir-dotclaude   （$CLAUDE_CONFIG_DIR/.claude/skills/）
[未命中] probe-home-dotclaude        （$HOME/.claude/skills/，CLAUDE_CONFIG_DIR 已被改写）
```

**对本仓直接相关**：`packages/server/agents/src/providers/claude-code/index.ts:161` 把 `CLAUDE_CONFIG_DIR` 设成了每行的 `input.configHome`。所以本仓语境下「用户级 skill」= `<configHome>/skills/`，而 `~/.claude/skills/` **不会**被读。

### 1.3 插件级 —— `plugins: [{ type: 'local', path }]`

```typescript
plugins: [{ type: 'local', path: './my-plugin' }]   // 绝对或相对路径
```

插件目录里放 `skills/<name>/SKILL.md`。这是**唯一能指定任意路径**的加法，也是绕开 `settingSources` 的加法。

实测（`probe1.mjs` 用例 D）：`settingSources: []`（项目/用户档全关）+ `plugins: [...]` ⇒ skill 照常装载，且**名字带命名空间**：

```text
init.skills 中命中 : ["my-plugin:probe-plugin-skill"]
```

⇒ 插件来源的 skill 名为 `插件名:技能名`。`skills` 允许列表要用这个**全名**。

补：`SdkPluginConfig` 还有 `skipMcpDiscovery?: boolean`（`sdk.d.ts:5403`）——只要这个插件的 skills/hooks/agents/commands，不要它的 MCP 连接。

---

## 2. 两个开关（这是「加完之后没生效」的全部原因）

### 2.1 `settingSources` —— 决定「发不发现」

`sdk.d.ts:2185`，类型 `SettingSource[]`。

| 值 | 效果（实测） |
|---|---|
| 省略 | 默认含 user + project，skill **会发现** |
| `['project']` | 项目级命中，用户级不命中 |
| `[]` | **探针 skill 全部消失**（`probe1.mjs` 用例 B） |

### 2.2 `skills` —— 决定「模型能调用哪些」

`sdk.d.ts:2208`，类型 `string[] | 'all'`。

实测三种取值（`probe5.mjs`，判据是请求体里那条 listing 还在不在）：

| 取值 | listing 进上下文 | 探针技能名进上下文 |
|---|---|---|
| 省略 | ✅ | ✅ |
| `[]` | ❌ | ❌ |
| `'all'` | ✅ | ✅ |

⚠️ 两个反直觉点，都有类型面原话支撑：

1. **省略 ≠ 关闭**。`sdk.d.ts:2191` 逐字：「omitted (default): no SDK auto-configuration. The CLI's own defaults still apply, so this is **not** "skills off."」
2. **`[]` 才是明确的关**。文档：「pass `skills` as `"all"`, a list of skill names, or `[]` to disable all。」

### 2.3 非法名在**启动前**就抛错（实测）

`skills: ['docs:*']` 的结果 —— 注意 `init` 事件根本没到，是**启动前**拒绝：

```text
result subtype : (none)
thrown         : Invalid skill name "docs:*": wildcard-suffix names are not allowed;
                 list each skill by its exact name.
init.skills    : null
```

⇒ **没有通配符**。要「全部」就写 `'all'`，要列举就逐个写精确名。触发规则：空名、含括号/逗号/控制字符、首尾空白、裸 `*` 或 `:*` 后缀。TypeScript SDK 自 `0.3.221` 起才有这道检查（本机 `0.3.281`，故生效）。

---

## 3. 四条容易踩的性质（全部实测）

### 3.1 `init.skills` **不是**允许列表的反映 —— 别拿它做判据

设 `skills: ['probe-listed']`（只允许一个），`init.skills` 里**两个都在**：

```text
允许列表              : ["probe-listed"]
init.skills 里的探针项 : ["probe-listed","probe-unlisted"]   ← 未列入的也在
```

文档口径一致：「The array lists the same skills whether or not they're in your `skills` list.」

⇒ 想确认允许列表生效，**只有在工具层看实际调用结果**（见 3.2），看 `init.skills` 会得到假阳性。

### 3.2 允许列表在工具层强制（实测原文）

模型自己去调未列入的 skill，工具返回：

```text
tool_result(is_error=true)
<tool_use_error>Skill probe-unlisted is not in this session's skills allowlist</tool_use_error>
```

且未列入技能的正文字符串**没有**进上下文。`Skill` 工具的 `input_schema` 实测为：

```json
{"type":"object","properties":{
  "skill":{"description":"The name of a skill from the available-skills list. Do not guess names.","type":"string"},
  "args":{"description":"Optional arguments for the skill","type":"string"}},
 "required":["skill"],"additionalProperties":false}
```

### 3.3 ⚠️ `skills` 允许列表**挡不住提示词直接派发** —— 它不是沙箱

`settingSources: ['project']` + `skills: ['probe-listed6']`（排除 `probe-unlisted6`），然后**直接把 `/<name>` 当提示词发**：

```text
[对照：普通提问 + 允许列表排除 unlisted]
  未列入技能正文进了上下文吗 : false

[关键：/<unlisted> 派发 + 允许列表排除它]
  未列入技能正文进了上下文吗 : true      ← 正文确实进来了
```

与官方逐字一致：

> Dispatch doesn't depend on the `skills` option. Sending `/<name>` runs a user-invocable skill even when your `skills` list omits it.

⇒ **`skills` 只过滤「模型自主调用」这一条路，不过滤「提示词点名派发」那一条。** 对评测/多租户场景，这意味着 `skills: [...]` 不能当作隔离手段；真要隔离得靠**不放文件**（`settingSources: []` 且不给 `plugins`）。

同理，`sdk.d.ts:2197` 也自陈：「This is a context filter, not a sandbox: unlisted skills are hidden from the model's listing and rejected by the Skill tool, but **their files remain on disk and are reachable via Read/Bash**. Do not store secrets in skill files.」

### 3.4 正文是惰性加载的，只有 name + description 常驻

实测：`SKILL.md` 正文里写了个哨兵字符串，**请求体里搜不到**；`allowed-tools` frontmatter 也搜不到。

```text
SKILL.md 正文哨兵是否出现在请求体里 : false
allowed-tools 是否出现在请求体里     : false
```

⇒ 这正是 skill 相对「往 system prompt 里塞说明书」的价值：几十个 skill 也只花 listing 的钱。

请求体体积实测（`probe3.mjs`，1 个项目级 skill）：

```text
整个请求体(字符)   : 67983
  system 字段      :   225
  tools 字段       : 58801      ← 工具定义才是大头
  messages 字段    :  8535
```

### 3.5 listing 落在哪 —— 不在 `system`，也不在 `tools`

⚠️ 这一格值得单独记，因为「想按 `system` 字段做上下文裁剪」的做法会**漏掉 skill listing**。

实测位置：`messages[1]`，且该消息的 `role` 是 `"system"`（不是顶层 `system` 字段，也不是 `tools[]`）。原文形状：

```text
The following skills are available for use with the Skill tool:

- probe-listing: 探针技能，用于核对 listing 形状。
- dataviz: Use this skill whenever you are about to create ANY chart, ...
```

该 `role: system` 的块总共 7648 字符（含 Environment / agent 清单 / skill listing 三段）。

---

## 4. SDK 类型面上的完整接口清单

| 接口 | 位置 | 说明 |
|---|---|---|
| `Options.skills?: string[] \| 'all'` | `sdk.d.ts:2208` | 主会话启用哪些 skill（第 2.2 节） |
| `Options.settingSources?: SettingSource[]` | `sdk.d.ts:2185` | 决定发不发现（第 2.1 节） |
| `Options.plugins?: SdkPluginConfig[]` | `sdk.d.ts:1971` | 插件路径加法（第 1.3 节） |
| `Options.pluginDelivery?: 'argv' \| 'initialize'` | `sdk.d.ts:1986` | 插件多时走 stdin，绕开 Windows 32767 命令行上限 |
| `AgentDefinition.skills?: string[]` | `sdk.d.ts:67` | **子智能体**把 skill **预加载**进上下文（与主会话不同：这里会解析显示名与别名） |
| `Query.supportedCommands(): Promise<SlashCommand[]>` | `sdk.d.ts:2858` | 运行时列出可用 skill/命令 |
| `Query.reloadSkills()` | `sdk.d.ts:2955` | 运行中从磁盘重扫 skill |
| `Query.getContextUsage()` | `sdk.d.ts:2887` | 返回 `skills: { totalSkills, includedSkills, tokens, skillFrontmatter[] }`（`sdk.d.ts:3856`）——**可用来量化 skill 占了多少上下文** |
| `SessionStart` hook 的 `reloadSkills?: boolean` | `sdk.d.ts:6281` | hook 装完 skill 后同会话可见 |
| `AddDirectory` 的 `reload_skills?: boolean` | `sdk.d.ts:4692` | 加目录同时重扫 |

调优/管控格（都在 `Settings` 上，非 `Options`）：

| 键 | 默认 | 作用 |
|---|---|---|
| `skillListingMaxDescChars` | 1536 | 单条描述字符上限，超出截断 |
| `skillListingBudgetFraction` | 0.01 | listing 占上下文窗口的比例预算，超了就缩短描述 |
| `skillOverrides` | — | 按 skill 名逐条覆盖：`"name-only"` / `"user-invocable-only"` / `"off"` |
| `disableBundledSkills` | false | 关掉 CC 自带的 bundled skill |
| `disableSkillShellExecution` | false | 禁掉 skill 里的内联 shell 执行（安全阀） |
| `strictPluginOnlyCustomization` | — | 管理员锁：只允许插件来源的 skills/agents/hooks/mcp |
| `syncClaudeAiSkills` | — | 关掉从 claude.ai 同步的 skill |

---

## 5. 与本仓现状的交叉（值得单独决策）

`packages/server/agents/src/providers/claude-code/index.ts:108` 与 `:199`：

```typescript
const CLAUDE_SETTING_SOURCES: readonly string[] = ['user', 'project', 'local'];
// ...
settingSources: [...CLAUDE_SETTING_SOURCES],
```

⇒ **本仓当前三档全开，而被测仓库自带的 `.claude/skills/` 会被自动发现并默认启用。** 这不是中性的：同一道题，带 `.claude/skills/` 的仓库与不带的仓库，模型看到的上下文不同——按本仓一贯的「跨家可比」口径（见 `CLAUDE_CODE_ENABLE_TODO_TOOLS`、`forwardSubagentText` 那两处的理由），这是一条**静默的口径差异**：界面上完全看不出来。

若要钉死这一格，两条路：

- **全关**：`skills: []`（实测真能关掉 listing，见 2.2）。注意 `settingSources: []` 会把 `CLAUDE.md` 一起挡掉（`sdk.d.ts:2183` 逐字：「Must include `'project'` to load CLAUDE.md files」），所以别用它来关 skill。
- **显式开**：`skills: 'all'`，把「发现到什么都算数」写成明账。

若反过来要**故意**给评测配 skill（例如考「模型会不会用给它的工具」），第 1.3 节的 `plugins` 是最干净的加法：指定路径、不动 `settingSources`、名字带命名空间便于对齐。

---

## 6. 复现方式

```powershell
node .probe-ws\claude-skills\probe.mjs   # A–E：基线/反例/过滤/插件/非法名
node .probe-ws\claude-skills\probe2.mjs  # 用户级落点四选一 + listing 定位
node .probe-ws\claude-skills\probe3.mjs  # listing 原文 + 惰性加载 + 体积分解
node .probe-ws\claude-skills\probe4.mjs  # 允许列表在工具层拦截
node .probe-ws\claude-skills\probe5.mjs  # 省略 / [] / 'all' 三档对照
node .probe-ws\claude-skills\probe6.mjs  # /<name> 派发绕过允许列表
```

手法：起一个本地 `http.createServer`，把 `ANTHROPIC_BASE_URL` 指过去，捕获入站 `POST /v1/messages?beta=true` 请求体后回一段最小合法 SSE。走的是**真实 CLI 子进程 + 真实 skill 发现逻辑**，但不产生任何真实模型调用。隔离靠把 `HOME` / `USERPROFILE` / `CLAUDE_CONFIG_DIR` 全指到探针自建的目录，保证用户真实 `~/.claude/skills` 不漏进来。

### 写这种回环 mock 的两个坑（本次踩到，记下来）

1. **CLI 会先发一次「标题生成」调用**，提示词包在 `<session>…</session>` 里并要求 `Write the title in the predominant language of the session`。它不是正式轮次；拿它当第 1 轮会让轮次计数整体错位，表现为「tool_use 发出去却永远不回来」。
2. **`/api/hello` 之类的非模型请求也会打到同一个 server**，同样不能参与轮次计数。判据用 `req.url.includes('/v1/messages')`。

---

## 7. 未实测项（据文档/类型面，未做真机验证）

- `AgentDefinition.skills` 的「预加载」语义（`sdk.d.ts:65` 注释为 "preload into the agent context"）——需要真的派发子智能体才能验，本次未做。
- `additionalDirectories` 里每个目录的 `.claude/skills/` 会被 `'project'` 档覆盖（文档口径）。
- `reloadSkills()` / `skillListingMaxDescChars` / `skillOverrides` / `disableBundledSkills` 等调优格的实际效果。
- `skills: []` 关闭后，提示词 `/<name>` 派发是否仍然可用（按 3.3 的性质**推测仍然可用**，因为 3.3 证过允许列表管不住派发；但 `[]` 与 `['x']` 是否同一条路径，未单独实测）。
