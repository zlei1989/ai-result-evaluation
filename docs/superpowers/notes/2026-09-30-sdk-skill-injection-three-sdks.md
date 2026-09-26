# 三家 SDK 如何添加 skill：调研与落地口径

**调研对象**：本仓 `packages/server/agents` 已依赖的三家厂商 SDK，版本取自实际安装态（`node_modules/.pnpm`），不是文档里的版本号。

**一句话结论**：

| SDK | skill 是不是一等公民 | 加法 |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk@0.3.281` | **是**，有一整套类型面（开关 / 允许列表 / 重扫 / 上下文计量） | 落 `SKILL.md` 文件 + `settingSources` 放行 + `skills` 收窄 |
| `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1` | **SDK 客户端零 API，但被拉起的运行时默认全开**；加法是**给子进程一份 profile patch** | 写 `--patch` overlay 配置 `dsh-skill-filesystem` 的 `customSkillDirs`（或落 `$DSH_HOME/skills/`） |
| `@openai/codex-sdk@0.156.1` | **SDK 零 API**；内置 CLI 0.156.1 **有**完整 skill 子系统 | 落 `$CODEX_HOME/skills/<name>/SKILL.md`，用 `CodexOptions.env` 指 `CODEX_HOME` |

**三家共同的形状**：**skill 都是「磁盘上的文件」，没有一家提供「编程式注册 skill」的 SDK 调用**。差别只在「谁来发现它」和「怎么告诉 SDK 去看」。

---

## 0. 证据分层（读这份文档前必须知道）

本仓的既有口径是「类型面 > 官方文档 > 推测」。本文档对每条结论都标了层级：

| 标记 | 含义 | 可信度 |
|---|---|---|
| **[实测]** | 本机真机跑过，有可复跑脚本与产物 | 最高 |
| **[类型面]** | 随包发布的 `.d.ts` / `lib/*.d.ts` 逐字 | 高（即该版本的合同） |
| **[二进制]** | 从 `codex.exe` 里抽出的字符串 / 内嵌脚本 | 高（但需注意是"存在"而非"生效"） |
| **[文档]** | 官方文档逐字 | 中（版本可能漂移） |
| **[未实测]** | 只到 [类型面]/[文档]/[二进制]，**没跑过** | 需自行验证 |

⚠️ **本文档最重要的诚实声明**：Codex 一节的「运行期是否真的注入」**没有实测**。原因见 §3.6——本机当前对上游网关**不可达**（`Test-NetConnection` 两条均为 False），且 `~/.codex` 下**没有凭据**（`auth.json` 不存在）。Codex 一节因此止步于 [类型面]+[二进制]+[文档]，并附上**可复跑的验证脚本**让读者自行补上这一步。

另两节的证据来源要分开看：

- **Anthropic 一节**：运行期结论引自本仓**既有**的 `.probe-ws/claude-skills/` 真机实测（本地回环 mock，有落盘产物）；类型面结论由本次调研从 `sdk.d.ts` 逐字复核。
- **DSH 一节**：两段来源不同——(1)「运行时默认装载 skill 三行」是 [实测]，依据是 `.probe-ws/dsh-skills/dump-config-sdk.txt`（安装态 `--dump-config` 的真实解析产物）；(2) skill 文件格式、根表、调用契约、层序等取自 DSH 检出仓的**源码与文档**（`docs/subsystems/skills.md`、`packages/skill/*/README.md`、`docs/config-catalog.md`），属 [类型面]/[文档] 级。**本次没有真机跑过 dsh 的 skill 注入**。

---

## 1. `@anthropic-ai/claude-agent-sdk` —— 唯一把 skill 做进类型面的一家

### 1.1 核心结论

**skill 只能以文件形式落盘，SDK 不提供编程式注册 API。** 加法 = 把 `SKILL.md` 放进被扫描的目录之一，再用 `settingSources` 放行、用 `skills` 收窄。

官方逐字（决定了整个调研的形状）：

> Unlike subagents, which you can define in the [`agents` option], you create skills as files on disk. **The SDK doesn't provide a programmatic API for registering them.**

### 1.2 三条加法（全部有本机实测命中记录）

| # | 落点 | 放行条件 | 实测证据 |
|---|---|---|---|
| 1 | `<cwd>/.claude/skills/<name>/SKILL.md` | `settingSources` 含 `'project'`（**默认就含 user + project**） | `probe.mjs` / `probe2.mjs` |
| 2 | **`$CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md`** | `settingSources` 含 `'user'` | `probe2.mjs` 四候选对照 |
| 3 | `plugins: [{ type: 'local', path }]` 下的 `skills/<name>/SKILL.md` | **绕开 `settingSources`**（`settingSources: []` 也装载） | `probe1.mjs` 用例 D |

⚠️ **第 2 条是本仓最容易写错的一格**：用户级 skill 的落点是 `$CLAUDE_CONFIG_DIR/skills/`，**不是** `~/.claude/skills/`。两者仅在 `CLAUDE_CONFIG_DIR` 未显式设置时才等价。实测四候选：

```text
[命中]   probe-project               （<cwd>/.claude/skills/）
[命中]   probe-configdir             （$CLAUDE_CONFIG_DIR/skills/）
[未命中] probe-configdir-dotclaude   （$CLAUDE_CONFIG_DIR/.claude/skills/）
[未命中] probe-home-dotclaude        （$HOME/.claude/skills/，CLAUDE_CONFIG_DIR 已被改写）
```

**对本仓直接相关**：[`index.ts:161`](packages/server/agents/src/providers/claude-code/index.ts#L161) 把 `CLAUDE_CONFIG_DIR` 设成每行的 `input.configHome` ⇒ 本仓语境下「用户级 skill」= `<configHome>/skills/`，`~/.claude/skills/` **不会被读**。

第 3 条的**命名空间**：插件来源的 skill 名为 `插件名:技能名`（实测命中 `my-plugin:probe-plugin-skill`），`skills` 允许列表要用**全名**。`SdkPluginConfig` 另有 `skipMcpDiscovery?: boolean`——只要这个插件的 skills/hooks/agents/commands，不要它的 MCP 连接。

### 1.3 两个开关（「加完之后没生效」的全部原因）

| 开关 | 位置 | 类型 | 作用 |
|---|---|---|---|
| `Options.settingSources` | `sdk.d.ts:2185` | `SettingSource[]` | 决定**发不发现** |
| `Options.skills` | `sdk.d.ts:2208` | `string[] \| 'all'` | 决定**模型能调用哪些** |

`Options.skills` 的类型面逐字：

```ts
    /**
     * Skills to enable for the main session. This is the single place to turn
     * skills on; you do not need to add `'Skill'` to `allowedTools` yourself
     * when using this option.
     *
     * - omitted (default): no SDK auto-configuration. The CLI's own defaults
     *   still apply, so this is **not** "skills off."
     * - `'all'`: enable every discovered skill.
     * - `string[]`: enable only the listed skills. Names match the SKILL.md
     *   `name` / directory name, or `plugin:skill` for plugin-qualified skills.
     *
     * This is a context filter, not a sandbox: unlisted skills are hidden from
     * the model's listing and rejected by the Skill tool, but their files
     * remain on disk and are reachable via Read/Bash. Do not store secrets in
     * skill files.
     *
     * @example
     * ```typescript
     * skills: 'all'
     * skills: ['pdf', 'docx']
     * ```
     */
    skills?: string[] | 'all';
```

`settingSources` 的**发现门槛**（`.d.ts` 只提 CLAUDE.md，是**文档缺口而非矛盾**；官方 skills 文档补上了 skill 那半边，逐字）：

> Skills are discovered through the filesystem setting sources. … If you set `settingSources` explicitly, include `'project'` to keep project and added-directory skills and `'user'` to keep your personal skills, or use the `plugins` option to load skills from a specific path.

| `settingSources` | 个人级 `$CLAUDE_CONFIG_DIR/skills/` | 项目级 / 父目录 / `--add-dir` |
|---|---|---|
| 省略（默认全部） | ✅ | ✅ |
| `['project']` | ❌ | ✅ |
| `['user']` | ✅ | ❌ |
| `[]` | ❌ | ❌ |
| 任意 + `plugins` | n/a | ✅ 走插件 |

两条反直觉点，都有实测 + 类型面原话支撑：

1. **省略 ≠ 关闭**——`sdk.d.ts:2191` 逐字：「omitted (default): no SDK auto-configuration. The CLI's own defaults still apply, so this is **not** "skills off."」⇒ **`skills: []` 才是明确的关**。
2. **非法名在启动前就抛错**（`probe` 实测，`init` 事件根本没到）：
   ```text
   thrown         : Invalid skill name "docs:*": wildcard-suffix names are not allowed;
                    list each skill by its exact name.
   ```
   ⇒ **没有通配符**。要「全部」写 `'all'`，要列举就逐个写精确名。（TypeScript SDK 自 `0.3.221` 起有这道检查，本机 `0.3.281` 故生效。）

### 1.4 四条容易踩的性质（全部本机实测）

1. **`init.skills` 不是允许列表的反映**——设 `skills: ['probe-listed']`，`init.skills` 里**两个都在**。官方口径一致：「The array lists the same skills whether or not they're in your `skills` list.」⇒ 想确认允许列表生效，只能看**工具层实际调用结果**，看 `init.skills` 会得到假阳性。
2. **允许列表在工具层强制**：模型去调未列入的 skill，工具返回
   ```text
   <tool_use_error>Skill probe-unlisted is not in this session's skills allowlist</tool_use_error>
   ```
3. **⚠️ 允许列表挡不住提示词直接派发——它不是沙箱**（`probe6.mjs` 实测）：
   ```text
   [对照：普通提问 + 允许列表排除 unlisted]   未列入技能正文进了上下文吗 : false
   [关键：/<unlisted> 派发 + 允许列表排除它]  未列入技能正文进了上下文吗 : true   ← 正文确实进来了
   ```
   官方逐字：「Dispatch doesn't depend on the `skills` option. Sending `/<name>` runs a user-invocable skill even when your `skills` list omits it.」
   ⇒ **`skills` 只过滤「模型自主调用」，不过滤「提示词点名派发」。** 评测/多租户场景下它**不能**当隔离手段；真要隔离得靠**不放文件**（`settingSources: []` 且不给 `plugins`）。
4. **正文惰性加载**：`SKILL.md` 正文与 `allowed-tools` 的哨兵在请求体里**都搜不到**⇒ 只有 name + description 常驻。实测请求体分解（1 个项目级 skill）：整包 67983 字符，其中 `system` 225、`tools` 58801、`messages` 8535 —— **工具定义才是大头**。

**listing 落点**（想按 `system` 字段做上下文裁剪的会漏掉它）：在 `messages[1]`，且该消息 `role` 是 `"system"`（不是顶层 `system` 字段，也不是 `tools[]`）。

### 1.5 类型面完整接口清单

主会话 / 发现：

| 接口 | 位置 | 说明 |
|---|---|---|
| `Options.skills?: string[] \| 'all'` | `sdk.d.ts:2208` | 主会话启用哪些 skill |
| `Options.settingSources?: SettingSource[]` | `sdk.d.ts:2185` | 决定发不发现 |
| `Options.plugins?: SdkPluginConfig[]` | `sdk.d.ts:1971` | 插件路径加法 |
| `Options.pluginDelivery?: 'argv' \| 'initialize'` | `sdk.d.ts:1986` | 插件多时走 stdin，绕开 Windows 32767 命令行上限 |
| `Options.additionalDirectories?: string[]` | `sdk.d.ts:1463` | 走 `--add-dir`，其 `.claude/skills/` 随 `'project'` 档装载 |
| `Options.projectConfigRoot?: string` | `sdk.d.ts:1468` | 让 `.claude` 配置树（含 skills）改从别处取 |

子智能体（**语义与主会话不同**）：

| 接口 | 位置 | 说明 |
|---|---|---|
| `AgentDefinition.skills?: string[]` | `sdk.d.ts:67` | **预加载**进该子智能体上下文；**会**解析显示名与别名 |
| 线上协议 `SDKControlInitializeRequest.skills?: string[]` | `sdk.d.ts:4338` | **只有 `string[]`，没有 `'all'`**（`'all'` 是 SDK 侧糖）；主会话**不**解析别名 |

运行时：

| 接口 | 位置 | 说明 |
|---|---|---|
| `Query.supportedCommands(): Promise<SlashCommand[]>` | `sdk.d.ts:2858` | ⚠️ JSDoc 说 "available skills"，实际返回**全部**命令（含内置）——别拿它当 skill 枚举器 |
| `Query.reloadSkills(): Promise<{ skills: SlashCommand[] }>` | `sdk.d.ts:2955` | 运行中从磁盘重扫 |
| `Query.getContextUsage()` → `skills: { totalSkills, includedSkills, tokens, skillFrontmatter[] }` | `sdk.d.ts:2887` / `3856` | **可量化** skill 占了多少上下文；`totalSkills` vs `includedSkills` 看有没有被预算截断 |
| `SessionStart` hook 的 `reloadSkills?: boolean` | `sdk.d.ts:6281` | hook 装完 skill 后同会话可见 |
| `AddDirectory` 的 `reload_skills?: boolean` | `sdk.d.ts:4692` | ⚠️ 但 `register_repo_root` 是**未导出**的线上类型、**没有** `Query` 方法 ⇒ **公开 TS API 够不着** |
| `applyFlagSettings()` | `sdk.d.ts:2804` | `skillOverrides` 可中途改（下一轮生效）；**`skills` 允许列表不行** |

调优/管控格（都在 `Settings` 上，**不是** `Options`）：

| 键 | 默认 | 作用 |
|---|---|---|
| `skillListingMaxDescChars` | 1536 | 单条描述字符上限 |
| `skillListingBudgetFraction` | 0.01 | listing 占上下文窗口比例预算 |
| `skillOverrides` | absent = on | 逐条：`"on"` / `"name-only"` / `"user-invocable-only"` / `"off"` |
| `disableBundledSkills` | false | 关掉 CC 自带 bundled skill（≡ `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`） |
| `disableSkillShellExecution` | false | 禁 skill 里的内联 shell（安全阀） |
| `strictPluginOnlyCustomization` | — | 管理员锁：只允许插件来源的 skills/agents/hooks/mcp |
| `syncClaudeAiSkills` | — | 关掉从 claude.ai 同步的 skill（只认 `false`） |

`'Skill'` 的**弃用**：`Options.allowedTools`（`sdk.d.ts:1518`）与 `AgentDefinition.tools`（`sdk.d.ts:44`）都逐字写着「passing `'Skill'` here is deprecated — use the `skills` option/field instead」。

### 1.6 对本仓的落点

[`index.ts:108`](packages/server/agents/src/providers/claude-code/index.ts#L108) 与 [`index.ts:199`](packages/server/agents/src/providers/claude-code/index.ts#L199) 当前是：

```typescript
const CLAUDE_SETTING_SOURCES: readonly string[] = ['user', 'project', 'local'];
// ...
settingSources: [...CLAUDE_SETTING_SOURCES],
```

⇒ **三档全开，被测仓库自带的 `.claude/skills/` 会被自动发现并默认启用。** 按本仓一贯的「跨家可比」口径（同 `CLAUDE_CODE_ENABLE_TODO_TOOLS`、`forwardSubagentText` 的理由），这是一条**静默的口径差异**：带 `.claude/skills/` 的仓库与不带的，模型看到的上下文不同，而界面上完全看不出来。两条钉死路径：

- **全关**：`skills: []`（实测真能关掉 listing）。⚠️ **别用 `settingSources: []` 来关 skill**——它会把 `CLAUDE.md` 一起挡掉。
- **显式开**：`skills: 'all'`，把「发现到什么都算数」写成明账。

反过来若要**故意**给评测配 skill（例如考「模型会不会用给它的工具」），§1.2 第 3 条的 `plugins` 是最干净的加法：指定路径、不动 `settingSources`、名字带命名空间便于对齐。

复现方式见 `.probe-ws/claude-skills/`：`probe.mjs`（A–E）、`probe2.mjs`（落点四选一）、`probe3.mjs`（listing 原文 + 惰性加载 + 体积分解）、`probe4.mjs`（工具层拦截）、`probe5.mjs`（省略/`[]`/`'all'` 三档）、`probe6.mjs`（派发绕过允许列表）。

---

## 2. `@deepseek-ai/dsh-sdk-client` —— 客户端零 API，但运行时默认全开

### 2.1 核心结论

**SDK 客户端类型面里没有任何 skill 字段**（`src/types.ts` 全文 83 行，只有 launch/timeout/通知/结果四类）。但**它拉起的 `dsh --profile sdk` 运行时默认就装载了整套 skill 栈**——因为 `sdk-app` profile 叠在 `dsh-base` 之上，而 base 里这几行是**启用**的：

```yaml
    - id: skill
      name: '@deepseek-ai/dsh-skill'

    - id: skill-filesystem
      name: '@deepseek-ai/dsh-skill-filesystem'

    - id: skill-badge
      name: '@deepseek-ai/dsh-skill-badge'
      disabled: true

    - id: tool-skill
      name: '@deepseek-ai/dsh-tool-skill'
```

[实测] 本仓 `.probe-ws/dsh-skills/dump-config-sdk.txt:183-191` 是从**真实安装态**（`@deepseek-ai/dsh@0.1.7-rc.1`）`--dump-config` 落下来的解析结果，逐字包含上表四行 ⇒ 「默认全开」不是读源码推的，是解析出来的。

⇒ **所以「给 dsh 加 skill」= 「让被拉起的运行时看见文件」，而不是「调用某个 SDK 方法」。** 加法落在**配置层**，不在 API 层。

### 2.2 三条加法

**加法 A（最省事）：落文件到 `$DSH_HOME/skills/`**

`skill-filesystem` 的默认根表（rank 小者先赢同名）：

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | **`<dshHome>/skills`** |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` |

`projectRoot` = 最近的含 `.git` 的祖先；没有则用 cwd。

而 `HarnessClientOptions.dshHome` 会被 SDK 落成子进程的 **`DSH_HOME`**（`launch.ts:140-149` 逐字）：

```ts
  const dshHome = options.dshHome === undefined ? undefined : resolve(callerCwd, options.dshHome)
  return {
    ...
    environment: () => ({
      ...(options.env ?? process.env),
      ...dshLaunch.environment,
      ...dshHome === undefined ? {} : { DSH_HOME: dshHome },
    }),
```

⇒ **`dshHome: '<每行独立目录>'` + 在该目录下放 `skills/<name>/SKILL.md`，这一行的 skill 就生效了。** 这与本仓「每行一个 `.agenthome`」的隔离口径天然同构，是**最推荐**的一条。

**加法 B（最可控）：给一份 `--patch` overlay**

`HarnessClientOptions.patches` 会被拼成 `--patch <abs path>`（`launch.ts:136-143`），且**相对路径按宿主进程 cwd 解析 ⇒ 调用方必须给绝对路径**。overlay 是**最高层**（层序：bundle → profile → home → CLI），可以按 id 覆盖或新插行：

```yaml
# skill-overlay.cordis.yml —— 传给 new DeepSeekHarness({ patches: [abs] })
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    # ⚠️ 覆盖是「替换整格 config」，不是深合并 ⇒ 要用的键必须全量重述
    providerName: filesystem
    includeDefaultRoots: false
    customSkillDirs:
      - D:\eval-skills
    watch: true
```

⚠️ **两条硬约束**：
1. **patch 替换整格 `config`，不做深合并**（DSH 官方文档逐字：「a patch replaces a row's entire `config` value rather than deep-merging keys」）⇒ 上例若想保留 `watchMaxProjects` 之类，必须一并重述。
2. `includeDefaultRoots: false` 会**同时**砍掉项目根、用户根**和 `$DSH_BUNDLED_SKILL_DIR` 默认**，让这一行只看见 `customSkillDirs`。这正是评测要的「隔离：只给它我指定的 skill」。

**加法 C（不用配置）：项目根自动发现**

如果这一行的工作区里就有 `.dsh/skills/` 或 `.agents/skills/`，**不做任何配置**就会被 rank 100/200 扫到。注意这同样是一条**静默口径差异**——被测仓库自带 `.dsh/skills/` 会让这一行与别的行看到不同上下文（与 §1.6 的 claude 问题**同源同形**）。

### 2.3 skill 文件格式与调用契约

**格式**：目录 bundle `<name>/SKILL.md` 或平铺 `<name>.md`，位于被扫根的**第一层**（**不做** `**/SKILL.md` 递归发现）。YAML frontmatter：

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | kebab-case：`^[a-z0-9]+(?:-[a-z0-9]+)*$` |
| `description` | ✅ | 会话目录里渲染的描述（受 `catalogDescriptionMaxLength` 截断，默认 500） |
| `whenToUse` | — | 额外路由提示（⚠️ **目录里不渲染**，加载的包装里也不渲染） |
| `disable-model-invocation` | — | `true` ⇒ 模型目录与 `skill` 工具都看不见，**只**能 `/name` 人工调用 |
| `user-invocable` | — | `false` ⇒ 不进人工命令目录 |
| `metadata` | — | 任意对象 |

两个 invocation 键接受 YAML 布尔 + 大小写不敏感的 `true/false`、`yes/no`、`on/off`、`1/0`；**拼写不合规或给了非布尔值 ⇒ 整条 skill 连同警告一起丢弃**（而不是静默放行某个面）。

**调用**：模型侧有 `skill({ name })` 工具，返回 `<skill_content>` 块（含 `<skill_resources>` + `<skill_instructions>`）；人类侧有 `/name`。目录以 `<system-reminder>` + `<available_skills>` 形式在**首个 `agent/pre-step`** 注入，之后变更追加**整份替换**目录（删光则追加空目录以显式退役旧名）。

**目录 vs 正文的生命周期是分开的**：发现只解析 frontmatter 成目录项；**每次加载都重读当前文件** ⇒ 改正文不需要版本号或缓存失效，但也意味着**后来的工具结果不会改写先前的历史事实**。

### 2.4 与本仓现状的交叉

本仓 [`providers/dsh/sdk.ts:84-119`](packages/server/agents/src/providers/dsh/sdk.ts#L84-L119) 的 `DshHarnessOptions` 已经声明了 `cwd` / `dshHome` / `processCwd` / `patches` / `env`，其注释也逐字记着：

> 配置根是 `dshHome`（SDK 把它写成子进程的 `DSH_HOME`）…；`patches` … 相对路径按宿主进程 cwd 解析，故调用方必须给绝对路径。

⇒ **加法 A 与加法 B 都只需在现有适配器上补参数，不需要动 `sdk.ts` 的形状声明。** 若要走加法 B，本仓既有 `docs/superpowers/plans/2026-09-30-dsh-dual-protocol.md` 那条线的 patch 机制可直接复用。

⚠️ 另一条实测约束（同文件注释）：`dshHome` 指向**空目录**且环境里没有 `DEEPSEEK_API_KEY` 时，运行必然以 `turn/end(kind:'error')` 收场 ⇒ 用「每行独立 dshHome」做 skill 隔离时，**凭据必须另走环境变量或补进该 dshHome**，否则隔离目录会把凭据一起隔离掉。

---

## 3. `@openai/codex-sdk` —— SDK 零 API，CLI 有完整子系统

### 3.1 核心结论（本节的中心事实）

**`@openai/codex-sdk@0.156.1` 对 skill 的支持是「零」。** 独立复核过：全包（9 个文件）区分大小写与不区分大小写两种扫法**均无匹配**；`dist/index.d.ts` 全文 285 行里 `skill` 出现 **0** 次；`ThreadOptions` / `CodexOptions` / `TurnOptions` 里没有任何 `skill` / `instructions` / `systemPrompt` 字段。

**但同一版本的内置 CLI（`codex-cli 0.156.1`）有完整的 skill 子系统。** [二进制] 证据：

- `codex.exe` 里含 `skill` 的可打印字符串 **1001** 条（含 `SKILL.md` 的 **84** 条）；
- 模块路径 `ext\skills\src\loader\{discovery,host,host_merge,environment,metadata,namespace}.rs`、`ext\skills\src\host_prompt.rs`、`ext\skills\src\tools\{list,read}.rs`；
- 配置结构 `codex_config::skills_config` → `SkillsConfig { bundled, include_instructions, max_context_tokens }`；
- feature flag（`codex features list` 本机实测）：`skill_search stable true`、`skill_mcp_dependency_install stable true`、`skip_host_skill_discovery under development false`；
- 内嵌 Python 安装器逐字：
  ```python
  return os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))
  return os.path.join(_codex_home(), "skills")
  ```
- 内嵌系统提示词逐字：
  > A skill is a set of instructions provided through a SKILL.md source. Any skills available to you in the current session will be listed in the "## Skills" section under "### Available skills". Each entry includes a name, description, and location for its SKILL.md.
  > If the user names a skill (with $SkillName or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. …

⇒ **缺口是「SDK 没有透传口」，不是「CLI 没有功能」。** 这决定了加法只能是「落文件 + 用现有透传口把 CLI 指过去」。

### 3.2 加法：落 `$CODEX_HOME/skills/<name>/SKILL.md` + 用 `env` 指 home

```ts
import { Codex } from '@openai/codex-sdk';

const codex = new Codex({
  baseUrl,                       // 走到你自己的网关
  apiKey,
  // ⚠️ env 是**整体替换**：给了它就不再继承 process.env ⇒ 必须显式展开
  env: { ...process.env, CODEX_HOME: 'D:\\eval-codex-home' },
  // 可选：显式开/调 skills 上下文预算
  config: { skills: { include_instructions: true, max_context_tokens: 8000 } },
});

const thread = codex.startThread({ workingDirectory: cwd, skipGitRepoCheck: true });
await thread.run('...');
```

`CodexOptions.env` 的替换语义是**类型面逐字**的（`dist/index.d.ts:235-239`）：

```ts
    /**
     * Environment variables passed to the Codex CLI process. When provided, the SDK
     * will not inherit variables from `process.env`.
     */
    env?: Record<string, string>;
```

⚠️ **这正是本仓已经踩过的同一个坑**——[`providers/dsh/sdk.ts:20-22`](packages/server/agents/src/providers/dsh/sdk.ts#L20-L22) 的注释逐字记着 dsh 侧同一件事（「`env` 是**整体替换父进程环境**语义 ⇒ 调用方必须自己展开宿主环境」）。codex 侧**同样如此**，本仓 `buildSubprocessEnv` 是现成的展开器。

⚠️ **另一个坑**：本仓 [agents 侧没有任何 `skill` 处理代码](packages/server/agents/src)（grep 全 `src/` 零命中），且 [`providers/codex/index.ts:33`](packages/server/agents/src/providers/codex/index.ts#L33) 已把 `CODEX_HOME` 指向每行 `configHome` ⇒ **默认情况下每行用的是自己那个空的 `CODEX_HOME`，`~/.codex/skills/` 与宿主的 skill 一个都不会漏进来**。这是好事（隔离天然成立），但也意味着「想给 codex 行配 skill」必须**显式往那个 `configHome/skills/` 里放文件**。

### 3.3 skill 文件格式

`SKILL.md`（必需，YAML frontmatter `name` + `description`，两者都校验非空）+ 可选 `agents/openai.yaml`（`interface` / `dependencies` / `policy.allow_implicit_invocation`）+ 可选 `scripts/` / `references/` / `assets/`。

[二进制] 里逐字的校验失败文案（可以用来排障）：

```text
skill `<name>` is missing `SKILL.md`
skill `<name>` must start with YAML frontmatter
skill `<name>` frontmatter must be valid YAML / must be an object / is not closed
skill `<name>` frontmatter field `name` must be non-empty
skill `<name>` frontmatter field `description` must be non-empty
Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}
```

⚠️ 两条发现规则：**跳过隐藏目录**（`if skill_root.name.startswith(".") or not skill_root.is_dir(): continue`）⇒ 目录名不要以 `.` 开头；系统 skill 落在 `$CODEX_HOME/skills/.system/`（`skill-creator` / `skill-installer`），是**被这条规则跳过**的那一类。

⇒ **格式与 Anthropic 的 `SKILL.md` 同源（agentskills.io 形状），skill 文件在两家之间基本可以直接搬运。**

### 3.4 调用方式

[二进制] 显示是 **`$skill-name`**（逐字样例：`Use $skill-name at /path/to/skill-name to complete this realistic request.`）加一个 `/skills` 列表命令（逐字：`Use **/skills** to list available skills or ask Codex to use one.`）。

⚠️ **口径冲突，须注意**：官方文档写的是 `/use skill-name`，而 **0.156.1 的二进制写的是 `/skills`**。本仓既有口径是「厂商原文 > 文档」，故此处以二进制为准，并标注为待实测项。

### 3.5 用 SDK 能做什么、不能做什么

| 能力 | Claude Agent SDK 0.3.281 | Codex SDK 0.156.1 |
|---|---|---|
| `SKILL.md` 格式 | ✅ | ✅（同一形状，可直接搬运） |
| **有类型的 skill API** | ✅ 一整套 | ❌ **零** |
| 编程式选择/收窄 skill | ✅ `skills: [...] \| 'all'` | ❌ 只能靠「放不放文件」 |
| 编程式列举/读取 | ✅ `supportedCommands()` / `reloadSkills()` | ❌ CLI 侧有 `skills/list`、`skills.read`（`skill://` URI）、`skills/config/write`，**SDK 够不着** |
| 上下文占用计量 | ✅ `getContextUsage()` 给出 `skills.skillFrontmatter[].tokens` | ❌ 仅 `skills.max_context_tokens` 预算 + 截断日志 |
| 逐条策略 | ✅ `skillOverrides` 四档 | ⚠️ `agents/openai.yaml` 的 `policy.allow_implicit_invocation` |
| 中途重扫 | ✅ `reloadSkills()` | ❌ 无对应口 |

⇒ **对「跨家可比」的评测口径，这是当前最大的不对称**：claude 行可以用一个允许列表把 skill 面钉死并可计量，codex 行只能靠「文件在不在」这一件事，且**没有任何计量出口**。

### 3.6 ⚠️ 未实测声明（本节的关键限定）

**「`codex exec` 真的会把 `$CODEX_HOME/skills/` 的目录注入模型上下文」这一步，本次没有实测。** 已有的证据强度是：内嵌系统提示词 + `codex_skills_extension::host_prompt` 模块 + `skip_host_skill_discovery` feature flag + app-server 的 `skills/list` RPC ⇒ **结构性证据很强，但不是运行期事实**。

**为什么没测成**（两次真机尝试都失败，原因已定位）：

1. 本仓既有的 codex 真机探测靠 `probe/v2/lib/codex.mjs` 里那份上游网关凭据，而**本机当前对两条网关都不可达**：`Test-NetConnection likecode-llm-proxy-test.jd.com:80` → `False`，`likecode-llm-proxy.jd.com:443` → `False`。
2. `~/.codex` **没有凭据**（`auth.json` 不存在，目录下只有 `tmp`）⇒ 也没有第二条上游可走。
3. 探测脚本本身先踩了一个独立的坑并已修掉，值得记下来：**`execFileSync` 默认把父进程 stdin 传给子进程，`codex exec` 会打印 `Reading additional input from stdin...` 并挂住等 EOF，整条用例以 `ETIMEDOUT` 收场。** 解法是显式 `stdio: ['ignore', 'pipe', 'pipe']`。

**可复跑的验证脚本已落盘（入仓，不在 gitignore 的探针目录里）**：[`packages/server/agents/probe/v2/codex-skills.mjs`](packages/server/agents/probe/v2/codex-skills.mjs)。它的判据设计成**不依赖抓包**——落一个 description 带哨兵 `ZQX-SKILL-SENTINEL-7f3a91`、正文带另一个哨兵 `BODYONLY-SENTINEL-c4d208` 的 skill，然后问模型「列出你现在能看到的全部 skill 并逐字引用 description」，看答复里出现哪个哨兵：

- **description 哨兵命中 → skill 被发现了**（listing 进了上下文）；
- **只有正文哨兵命中 → 正文也常驻**（与 claude 的惰性加载相反）；
- **两个都不命中 + 自述 `NO-SKILLS-AVAILABLE` → 该路径下 skill 没生效**；
- 用例 B（同 home 不放 skill）作对照，排除「模型自己编名字」的假阳性。

⚠️ **落点选择的理由**：`probe/` 下只有 `dumps/` 被 gitignore（见本仓 `.gitignore` 的 `packages/server/agents/probe/dumps/`），**脚本本身是入仓的**——这与既有的 `probe/v2/codex-cli-plan.mjs`、`probe/v2/lib/codex.mjs` 一致。反过来 `.probe-*/` 整个被 gitignore，脚本放那儿会丢。

这个脚本本机已跑通到「二进制定位 + 落文件 + 起 CLI」这一步（脚本自身的路径与 stdio 坑都已修掉），只是卡在网关不可达。有网环境设两个变量即可复跑：

```powershell
$env:AIEVAL_V2_CODEX_BASE_URL = 'http://<你的网关>/v1'
$env:AIEVAL_V2_CODEX_API_KEY  = '<key>'
node packages\server\agents\probe\v2\codex-skills.mjs
```

---

## 4. 跨家对照：对本仓评测口径的含义

| 维度 | claude-agent-sdk | dsh-sdk-client | codex-sdk |
|---|---|---|---|
| 加法落点 | 文件 + `settingSources` + `skills` | **运行时 profile patch**（或 `dshHome`） | 文件 + `env.CODEX_HOME` |
| SDK 里的 skill API | 有（完整） | **无**（但运行时默认全开） | **无**（运行时也有，但无口） |
| 默认状态 | 默认**发现**（`settingSources` 默认含 user+project） | 默认**全开**（base 层 `skill`/`skill-filesystem`/`tool-skill` 启用） | 取决于 `$CODEX_HOME/skills/` 有无文件 |
| 能否钉成「零 skill」 | ✅ `skills: []`（**别**用 `settingSources: []`，会连带挡 `CLAUDE.md`） | ✅ patch 里 `includeDefaultRoots: false` + 空的 `customSkillDirs`，或干脆不给文件 | ⚠️ 只能靠「不放文件」（天然成立：本仓每行 `CODEX_HOME` 是空目录） |
| 「仓库自带 skill」会不会漏进来 | ⚠️ **会**（`'project'` 档开着） | ⚠️ **会**（rank 100/200 自动扫 `.dsh/skills`、`.agents/skills`） | 本仓当前**不会**（`CODEX_HOME` 已指向每行空目录） |
| 上下文占用可计量 | ✅ `getContextUsage()` | ✅ `tools` 目录由 `tool-skill` 管，但无逐条 token 出口 | ❌ |
| 允许列表是不是隔离 | ❌ **不是沙箱**（`/<name>` 派发绕过，§1.4-3） | ✅ `includeDefaultRoots: false` 是真隔离 | —（无允许列表） |

**三条对本仓最要紧的推论**：

1. **两个静默口径差异已经存在**：claude 行与 dsh 行都会**自动**吃进被测仓库自带的 skill（`.claude/skills/`、`.dsh/skills/`、`.agents/skills/`），codex 行不会。同一道题在三家看到的上下文不同，**而界面上完全看不出来**。这与本仓已经修过的 `CLAUDE_CODE_ENABLE_TODO_TOOLS`、`forwardSubagentText` 是同一类问题。
2. **要「跨家可比」，三家都得显式钉**：claude 用 `skills: []` 或 `'all'`、dsh 用 patch 里的 `includeDefaultRoots`、codex 用「`configHome/skills/` 放不放文件」。**不显式钉，比的就有一部分是「仓库里有没有 skill 目录」。**
3. **`skills` 允许列表不能当隔离手段**（§1.4-3 实测）。若产品上要「租户之间互不可见」，必须走「不放文件」，而不是「放文件 + 列表排除」。

---

## 5. 复现与产物

| 产物 | 位置 | 状态 |
|---|---|---|
| claude skill 六个探针 + 落盘输出 | `.probe-ws/claude-skills/probe{,2..6}.mjs`、`probe{4,5,6}.out.txt` | **[实测]** 可原样复跑，零 API 成本（本地回环 mock） |
| dsh 解析后的 sdk profile 配置 | `.probe-ws/dsh-skills/dump-config-sdk.txt` | **[实测]** 证明 skill 三行默认启用 |
| codex skill 探针 | [`packages/server/agents/probe/v2/codex-skills.mjs`](packages/server/agents/probe/v2/codex-skills.mjs) | **[未实测]** 待有网环境补跑；脚本自身的路径解析与 stdin 挂死两坑已修掉（`node --check` 通过，二进制定位已实测正确） |
| 三家适配器当前落点 | [`providers/claude-code/index.ts`](packages/server/agents/src/providers/claude-code/index.ts)、[`providers/dsh/sdk.ts`](packages/server/agents/src/providers/dsh/sdk.ts)、[`providers/codex/index.ts`](packages/server/agents/src/providers/codex/index.ts) | 读取核对 |

**方法学备注**：claude 探针走「本地 `http.createServer` 冒充上游 + 真实 CLI 子进程」，判据是**请求体里有没有哨兵**。两个坑记在既有笔记里，复跑时会再遇到：(1) CLI 会先发一次**标题生成**调用（提示词包在 `<session>…</session>` 里），不是正式轮次，拿它当第 1 轮会让轮次计数整体错位；(2) `/api/hello` 之类的非模型请求也会打到同一个 server ⇒ 判据用 `req.url.includes('/v1/messages')`。codex 探针改用**自述式判据**（问模型看到了什么）而不是抓包，正是为了绕开这类计数陷阱。

---

## 6. 参考来源

**类型面（首选，随包发布）**
- `@anthropic-ai/claude-agent-sdk@0.3.281` → `sdk.d.ts`（9578 行）、`sdk-tools.d.ts`；两个 pnpm peer 变体目录 `sdk.d.ts` **逐字节相同**（SHA256 已比对）
- `@openai/codex-sdk@0.156.1` → `dist/index.d.ts`（285 行）、`dist/index.js`
- `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1` → `lib/types/*.d.ts`；`@deepseek-ai/dsh@0.1.7-rc.1` 的 `dsh-skill-filesystem` → `lib/types/index.d.ts`
- 本仓 DSH checkout `D:\zhanglei1120\Github\deepseek-harness`：`packages/bundle/base/cordis.patch.yml`、`packages/bundle/sdk-app/cordis.patch.yml`、`docs/subsystems/skills.md`、`docs/config-catalog.md`、`docs/user/develop/basic/publish.md`（层序）

**官方文档**
- [Claude Agent SDK — Skills](https://code.claude.com/docs/en/agent-sdk/skills)、[Skills](https://code.claude.com/docs/en/skills)、[Settings reference](https://code.claude.com/docs/en/settings-reference)、[Agent Skills specification](https://agentskills.io/specification)
- [Codex — Skills（OpenAI Developers）](https://developers.openai.com/plugins/concepts/skills)、[Build skills](https://developers.openai.com/plugins/build/skills)；镜像 [mintlify.wiki Codex skills](https://mintlify.wiki/openai/codex/features/skills)
- [openai/skills 目录](https://github.com/openai/skills)（`.system` / `.curated` / `.experimental`）

**已知的文档与类型面落差（3 处，值得单独记）**

1. `settingSources` 与 skill 的关系：`.d.ts` 只提 `CLAUDE.md`，**只字未提 skill**；官方 skills 文档明写 skill 的发现受它管辖 ⇒ **文档补缺口，不是矛盾**。
2. `skills` 的**名校验规则**（禁通配符、错误文案）在 `.d.ts` 里**完全没有**，只在文档 + 运行期报错里。
3. `SKILL.md` 的 frontmatter 规格：`settingSources` 那条 JSDoc 之外，包内唯一的权威表述是 `sdk-tools.d.ts:2967` 的 `ProposeSkills` 工具 schema（「kebab-case … must not contain "claude" or "anthropic" … at most 64 characters」）——**那条规则属于 claude.ai 上传路径，不属于 Agent Skills 规范本身**，别把它当成所有 skill 的通用约束。
