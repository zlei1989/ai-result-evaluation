# Claude Code 接入

## 定位

Claude Code 的适配器由 `@anthropic-ai/claude-agent-sdk`（进程内 SDK，spawn 原生 CLI 二进制）驱动：`query({ prompt, options })` 返回异步迭代器，逐条产出消息流。厂商包按平台 optionalDependencies 分发原生二进制（8 个平台变体），缺包即报 `AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`。能力声明：`protocolTypes: ['anthropic']`。

## 形态与交互

- **SDK 接入形状**：`Options.env` 是**整体替换**子进程环境（省略才继承 `process.env`），要自己展开宿主环境再注入；`pathToClaudeCodeExecutable` 可指定 CLI 路径；`extraArgs` 透传 CLI 参数（null = 布尔 flag）。SDK 补丁号与内含 CLI 版本同步（0.3.281 ⇒ 2.1.281）。
- **建会话**：`cwd` 过 `realpathSync.native` 归一（Windows 8.3 短名会被 CLI 安全门拦下，表现为 0 改动；归一失败回落原值记 DEBUG）；注入 `ANTHROPIC_BASE_URL`（去尾部 `/v1`，SDK 自己追加 `/v1/messages`）、`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CONFIG_DIR`（= 每行 `input.configHome`）；`contextWindow ≥ 1_000_000` 时模型名追加 `[1m]` 后缀（幂等、大小写不敏感）。
- **effort 三档**：未选 ⇒ `effort` / `thinking` 两格都不加；显式 `off` ⇒ `thinking: { type: 'disabled' }` 且不传 `effort`，**另有 spawn 时 env 覆盖层** `CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ thinking: { type: 'disabled' } })`（逐字节 `{"thinking":{"type":"disabled"}}`，CLI 对非法 JSON 静默忽略整条）；其余档位原样透传。`--thinking disabled` 到得了 CLI、被丢在组装请求体那格；env 覆盖层补另一批模型——**两半各管一批，删任何一半都会让某批模型的 off 失效**。非 off 档的 `claudeExtraEnvFor` 必须给空对象（`undefined` 值的键会被删掉，反而改变其它档行为）。
- **off 的前置与观测**：前置 = `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 不在场（hipaa 策略本仓不可独立观测）。被破坏 ⇒ **静默失效**；守卫是 `hostDisablesBetas(合并后 env, effort)` 纯函数 → 点名 WARN（模板常量 `CLAUDE_OFF_DISABLED_WARNING_TEXT`），观测不拦截。真机判据：读 `messages.jsonl` 折叠后含 `thinking` 块的消息条数，必须与同 run 未选对照行成对读（对照行 > 0 才可判读）。
- **收尾时序**：`turn.ts` 的 `finally` 保证收尾读盘在正常 / 失败 / 被终止三条路上都跑；子会话用量读数只在收尾出现（流里 `output_tokens` 恒 0，凑不出三元组）。

## 数据与契约

消息流到契约的归一映射：

| SDK 消息 | 契约投影 |
|---|---|
| `assistant`（按 `message.content[]` 分块） | `text` / `thinking`（含 `signature`；空文本记 `text: null` + `textKind: 'none'`）/ `tool_use`；其余类型静默丢弃 |
| `user` 含 `tool_result` | `tool-result` 块；同时读 `tool_use_result` 作 `structured`（工具完整 Output 对象，非发给模型的字符串） |
| `system`（`init`） | `vendor-system` 事件（六格：`tools` / `slashCommands` / `agents` / `mcpServers` / `permissionMode` / `outputStyle`；非数组记 `null`、空数组记 `[]`）+ **记下 `session_id`**（定位子智能体转录目录的唯一钥匙） |
| `system`（`task_started` / `task_notification`） | 子任务通道 |
| `result` | 终局用量与时延；一次 turn **恰好一条**，可当收轮信号；结构化输出的兜底落点（字段优先、`result` 文本兜底，不一致落 WARN） |

- **覆盖合并（关键）**：同一条 `assistant.message.id` 按内容块分多条投递（每条只带一个块）⇒ 新块追加到末尾、同键覆盖，块序号按首次到达分配。⚠️ **块序号那本账必须按 `message.id` 跨投递存活**（`ordinalBooks`）：每条投递新建一本会让后投的块拿到 `i:0`、把先投的思考从槽里盖掉——真机症状是**原始输出里有思考、执行日志里没有**；工具调用块按 `c:<callId>` 分槽，撞不上 `i:0`，所以那个症状只在「两次投递都是文本 / 思考」时出现。
- **计量**：从 `result.usage` 取 `input_tokens`（不含缓存）/ `cache_read_input_tokens` / `output_tokens` / `output_tokens_details.thinking_tokens`；三项必填格缺一 ⇒ 整格 `null` + WARN，**绝不补 0**；`total` 恒 `null`（厂商无自报总量格）。**四家里只有这家 `apiMs` / `ttftMs` 两格都有**（pi 有 `apiMs`、首字时延恒 `null`）。
- **跑动期估算**：按 `assistant.message.usage` 同 `message.id` 后到覆盖求和（侧链消息与缺 id 的不算、三项全 0 的快照丢弃）⇒ `tokensBasis: 'estimated'`，只进 usage 事件、不进结果；结算值到即作废。编排层回写判据：`tokensBasis === 'reported'` 才写快照。
- **子智能体用量**：唯一权威源是 CLI 落盘转录 `<configHome>/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl`。读数规则只有一条：只认 `type === 'assistant'`、按 `message.id` 去重后到覆盖（同一次往返按内容块出现多次，第一条 `output_tokens` 是 0，逐条相加会双计 input / cached）；三项缺一或无 id ⇒ 整份文件作废。「全量或 null」：`missing` 非空 ⇒ `subagentTokens` / `subagentTurns` 两格一起 `null` + 点名 WARN，读到的**不进合计**。
- **子任务三档产行判据**（先判形状再产行，只按 `start` 帧）：`subagent_type` / `spawn_depth` / `prompt` 至少一格非 `null`（`''` 与 `0` 都算「给了」）；`'dispatch'` 产行、`'phantom'`（CLI 给非 Agent 任务也发 `task_started`）不产行、`'unjudged'`（只见到收场帧）照产行 + 「可能少算」WARN。
- **任务台账（`Task*` 的整表从哪来）**：这一家的任务工具是**工作项注册表**——`TaskCreate` 建一项、`TaskUpdate` 改一项的某个字段，`TaskCreateOutput` / `TaskUpdateOutput` 都不含整表（`TaskCreateOutput` 只有 `{task: {id, subject}}`，**没有状态**；id 也**只有结果才有**，工具自己发号），整表只有 `TaskListOutput.tasks` 有。`providers/cc/task-registry.ts` 因此按 run 持一份台账：建项入账、`TaskUpdate` 的入参改状态（`owner` / `addBlockedBy` 读到的就投），两者的**结果**补它权威的那一半（创建结果回填 id / subject、更新结果的 `statusChange.to` 落状态），每个 `Task*` 调用块因此都带上「此刻的整张清单」；结果入账后**重投那条调用所在逻辑消息的快照**，刷新后的整表就落回同一个块。三条口径：「刚建、还没更新过」记 `pending`（`TaskCreateOutput` 没有状态格，依据是 `TaskUpdate` 结果的 `statusChange.from` 逐字 `"pending"`）、`deleted` 按**移除**处置（面板画的是清单当前状态）、没见过的 id 只记补丁账**不凭空造行**。`TaskList` / `TaskGet` 的结果形状未观测，不入账；`addBlocks`（反向边）不投。
- **收尾快照的字段回填与重发**：派发帧采到的 `subagent_type` 按 run 记账，收尾帧不带这一格时**沿用派发时的值**、不覆盖成 `null`——否则消费方按 `subagentId` 覆盖后那条子任务行会退回半截（`name` 与 `kind` 都要有这层兜底）。同一身份的快照再按「身份 + 整条快照」判重：**只挡逐字相同的重发**，带新事实（终态 / 用量）的补全照发。
- **轮次归属**：主会话只数主循环 `assistant.message.id`（`parent_tool_use_id` 非空直接返回 null 不计数），`num_turns` 只作兜底；侧链消息按**每会话自己的轮次号**编号（`roundTripOfSession`）——不能按父会话轮分轮，否则子会话节点只有一行且读数漏进主会话。
- **工具面**：`disallowedTools` 六项无条件（`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` / `PushNotification` / `DesignSync`）+ 非 Claude 模型（`modelId` 子串 `/claude/i` 不敏感）再追加 `WebSearch`；只禁工具不禁网络（`Bash` / `WebFetch` 照旧）。`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 常开补齐 `TaskCreate/TaskGet/TaskList/TaskUpdate`。「无条件七项」是尚未落地的裁决，现值为分档。

## wire 形态与事件

- **消息通道**：`assistant` / `user` / `system` / `result` 四类是消费主干；**同 `message.id` 覆盖合并**是这家独有的投递形态。
- **流式增量通道**：`includePartialMessages: true` **已常开**，`stream_event`（`message_start` → `content_block_delta` → `message_stop`）折成 `chunk: 'delta'` 的内容消息。四种子类型的处置**各不相同**（统一表见《消息规范》「非渲染增量」）：`text_delta` / `thinking_delta` 进通道；`signature_delta` **不进**（它是同一个思考块的一部分，落点是随后那份快照的 `signature` 字段）；`input_json_delta` **不进**（`partial_json` 是 JSON 片段，当 `input` 落库会让消费方拿到半截字符串，工具调用一律按块结束的完整快照产出）。**只覆盖主会话**（`stream_event` 的 `parent_tool_use_id` 恒 `null`），子智能体没有 token 级增量。事件侧零产出（见「已知边界」），`uuid` 去重照常生效。
- **skills 注入**（skill 只能以文件落盘，SDK 无编程式注册）：三条加法——项目级 `<cwd>/.claude/skills/<name>/SKILL.md`、用户级 `$CLAUDE_CONFIG_DIR/skills/`（⚠️ 不是 `~/.claude/skills/`）、插件级 `plugins: [{ type:'local', path }]`（唯一能指定任意路径并绕开 `settingSources`，skill 名带命名空间 `插件名:技能名`）。两个开关：`settingSources` 决定发不发现（`[]` 会把 CLAUDE.md 一起挡掉，别用它关 skill）、`options.skills` 决定模型能调哪些。⚠️ **`options.skills` 的三档有两档落在 argv 上、`[]` 不在**：`'all'` ⇒ `--allowedTools Skill`、`['a']` ⇒ `--allowedTools Skill(a)`，而 **`[]` 在 argv 上与「省略」逐字节相同**——真正生效的是 stdin `initialize` 载荷里的 `skills: []`（`sdk.d.ts` 原文 *Omit to load every discovered skill*）；实测 `skills: []` ⇒ `getContextUsage().skills` 整格缺席、零条进技能面。非法名（通配符后缀、空名）**启动前**抛 `Invalid skill name "docs:*": wildcard-suffix names are not allowed`。
- **本仓的 skills 落地口径**：落点 = 行配置目录的 `<configHome>/skills/<名称>/`（`configHome` 就是 `CLAUDE_CONFIG_DIR`），每次 `run` 之前**整目录物化**；这一家对时序没有更紧的要求（文件在 `query()` 之前落盘即可，对照 codex 必须早于 spawn、dsh 必须早于 boot）。**`options.skills` 本仓不传**：它是「模型能调哪些」的筛选而不是注入，停用统一走**文件级不放**（被停用的根本不进清单）——不传即「加载所有已发现的 skill」，正是要的语义。代价是 `settingSources` 三档全开时被测仓库自带的 `.claude/skills/` 也会被发现（见下一条）。**判据 = `getContextUsage().skills.skillFrontmatter`**（每个元素带厂商原值 `source`：`userSettings` / `projectSettings` / `built-in`），在流循环里 `system/init` 之后采一次并缓存，收尾同步交出。
- **skills 非沙箱**：允许列表挡得住工具调用（`<tool_use_error>Skill probe-unlisted is not in this session's skills allowlist</tool_use_error>`）但**挡不住 `/<name>` 提示词派发**；`init.skills` 不反映允许列表（假阳性判据）；真隔离靠不放文件。本仓 `settingSources` 三档全开（`['user','project','local']`，且与 `settings.env` 成对给——打开才能读被测仓库 `CLAUDE.md`，开了就要用 flag 档把仓库 `.claude/settings.json` 的 `env` 块钉回去，实测层级 user < project < local < flag）⇒ 被测仓库自带 `.claude/skills/` 会被自动发现，是跨家口径的静默差异。⚠️ **清单的送达还有一跳，与装入无关**：CC 把整份 `<system-reminder>` 放在 `messages[]` 里一条 `role: "system"` 的消息上，网关不认这个角色就整条丢掉——`vendor-system.skills` 报的是 CLI 的装配读数，它**不蕴含**模型收到过（见下表同一条）。
- **MCP 接法**（本仓已落地）：**通道 = SDK 参数 `Options.mcpServers`**（不落 `<configHome>/.claude.json`）——参数是编程入口，同名时**高于**磁盘配置，且不落盘就不会与宿主那份混起来。条目由 `toClaudeMcpServers` 一处翻译：stdio 是 `{type:'stdio', command, args?, env?}`（**无 `cwd` 字段**）、http 是 `{type:'http', url, headers?}`；可选格缺席就**不写那个键**（空数组 / 空对象在厂商侧是「显式声明为空」，与「没声明」不是一件事）。SDK 侧另两种传输（sse 已弃用、sdk 进程内）本仓不做。`strictMcpConfig` **保持关闭**：它会**完全压制**仓库自带的 `.mcp.json`（本仓要的是不压制），同名的判定：**程序化注入赢且只留一条**（替换，不并存不改名；`source: 'dynamic'` 顶掉 `'project'`）。宿主 `~/.claude.json` 与注入同名时谁赢**未单独测**，勿写死。工具名 `mcp__<server>__<tool>`；allow 规则里 `mcp__*` 非法（`Wildcard tool name "mcp__*" is not supported in allow rules`）。不写 `allowedTools` ⇒ 工具可见但需授权，headless 无 `canUseTool` 时 `ask` 是终止性拒绝。
  - **判据链**（只看事件侧 / server 侧）：`system/init` 的 `mcp_servers[].status === 'failed'` ⇒ **行失败**（归因码 `AGENT_MCP_UNAVAILABLE`，文案 `MCP「<name>」未能启动：<厂商原文首行>`）；**工具表里有 `mcp__<name>__` 前缀的工具 ⇒ 已连上**（比 `status` 更硬）；`status` 是 `pending` / `needs-auth` 或根本没有这台 ⇒ `unverified`，**不判失败**。`system/init` 是一次性事件，**不等待**。硬证据永远是 **MCP server 进程自己的输入里有 `tools/call`**（模型答复不算证据——派发失败时模型可能把预期结果编出来）。
  - **行内首次注入 playwright MCP = 17.2 s / 61 MB**（宿主 registry 是公网时）⇒ 行的 `HOME` 一换，npm 的 `userconfig` 就从 `~/.npmrc` 变成 `<行HOME>/.npmrc`（不存在），registry 从内网镜像掉回公网。缓解：把宿主 npm 配置里的 **registry 那一行**写进行 `configHome` 的 `.npmrc`（只那一行、`0600`、不碰宿主），拉回 ~4 s 级；等待预算仍按 **≥ 20 s** 留。配置面与完整边界见[《MCP 配置》](/features/mcp-config)。
- **内置工具清单**（一次实测快照 27 项，随模型与开关浮动 23～30）：`Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, WebFetch, WebSearch, Workflow, Write`。`Task` 与 `Agent` 是同一工具两种叫法，族映射须归同族；精确同名交集 claude∩dsh = 空、claude∩codex = 空 ⇒ 对齐只能在语义类别层做。

## 提问与应答面

厂商自带提问工具（`AskUserQuestion`），本仓声明 `askUser: yes` + `askUserChannel: 'vendor-tool'`，一致性场景走**真路径**（真 CLI + 本机假上游，只把上游模型脚本化）。

| 面 | 现时做法 |
|---|---|
| 通道 | **权限回调**（`can_use_tool`，线级帧带 `requires_user_interaction: true`）——不是对话框通道：`request_user_dialog` 那条路本仓不实现，走它的提问落「无人应答」 |
| 递答案 | 宿主把答复装进 `updatedInput.answers` 交回，**键是题目文本**（不是 `header`、不是序号）：单选给选项标签串、多选给数组；厂商把它渲染进工具结果念给模型。自由输入单选时**取代**选项（值取 `custom`，此时答卷的 `selected` 为空）、多选时与选项标签**拼成同一个数组**（厂商那一侧只有一格可用）——两档都经这一格到模型眼里，见下面 `response` 那条边界的理由。题面认不出来就跳过该题，不猜键 |
| 等待预算 | 厂商侧没有：`askUserQuestionTimeout` 缺省 `never`（没人答就一直挂着）⇒ 端口那一侧如实给 `vendorBudgetMs: null`，超时只由我们的预算（缺省十分钟）产生 |
| 收场 | 没人答时交回的是**空答案表**，厂商据此渲染 `The user did not answer the questions.`；收场方式按这一问的实际结果落 `answered` / `timeout` / `canceled`，**没有**厂商自收场这一档 |

四条今天仍成立的边界：

- **不挂钩子 ⇒ 这个工具被禁用**：厂商在 headless 下没有批准面就不把提问工具提供给模型，脚本式调用拿到 `<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>` ⇒「不问就不动」在这一家是**结构性**的，不是靠我们拦。
- **接它不需要动权限档**：全权档只遮蔽普通工具（`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告指的是那一批，普通工具根本到不了回调），提问工具带 `requires_user_interaction`，两档的控制帧逐字相同。
- **只读档问不到人**：`dontAsk` + `permissionPrompts: 'none'` 下厂商把提问工具一并从模型工具表撤掉、控制帧一条都不发 ⇒ 那一档即使挂了应答面也落「无人应答」（评分阶段因此不会向人提问），本模块不为它写分支。
- **子智能体发起的提问到不了宿主**：厂商自己就拒（`not available inside subagents`，子会话工具表 25 项 vs 父会话 30 项）⇒ 端口收到的 `subagentId` 恒 `null`——不是「没读到」，是这一家拿不到；`rejected` 那条收场留给厂商自己。

两处跨臂差异要如实登记（它们让「有人答的轮次」与「没答的轮次」在工具面上天然不同）：**挂上应答面会让厂商工具表多出几件**（`AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode`，`Monitor` 两臂都有），命令面那一列也跟着变；一致性套件把实测到的那几件**逐件点名**归一，点名之外仍有差异即红。选项侧的 `recommended` 在这一家恒 `false`（厂商的提问工具入参里没有这一格，它用「排首位」表达）；问题侧的 `allowOther` 恒 `true`——这一格读的不是提问形状而是**答案面**：厂商的 schema 逐字写着「不要给 'Other' 选项，那个界面上自动提供」，用户写的那句话经选项值那一格进 `answers`，工具结果逐字 `The user answered: "<题面>"="<自由输入>"`（真机读数出自探针 `probe/v11/cc-ask-answer.mjs` 的 `answer-custom` 臂）。

## 已知边界与取舍

| 边界 | 性质 | 处置与判据 |
|---|---|---|
| darwin-arm64 平台包空壳（pnpm 11 headless 只信 `.package-map.json` + lockfile，`--force` 也 "Already up to date"） | 环境坏 | 全删 `node_modules` 重装（warm store 约 4 分 18 秒）；守卫 `native-cli.test.ts` 复刻 SDK 解析链断言本机平台二进制可解析 |
| 流式增量只覆盖**主会话**（`stream_event` 的 `parent_tool_use_id` 恒 `null`） | 厂商投送面 | 子智能体不做逐字动画；能力位带这条前提，消费方按「实际到达的块形态」渲染而不是按「有增量」写动效 |
| 流式增量不进原始日志（事件侧零产出） | 有意取舍 | `events.ts` 对 `stream_event` 显式 `emptyProjection()`：一次运行几百上千条增量帧落进未识别兜底会把「原始输出」面板刷成 JSON 流水，真要看 stderr / init 反而被冲掉；它的落点只有实时消息通道（只广播不落盘） |
| `system` / `thinking_tokens` **思考进度帧**同样零事件产出 | 真机量级 | 形状 `{"type":"system","subtype":"thinking_tokens","estimated_tokens":N,…}`，**每个思考 token 一条**。真机 run `7f05c765` 的 claude 行：**11,629 条**（占该行 12,509 条 `log` 的 93%），评分智能体那条路再叠 **670 条** ⇒ 原始输出抽屉刷屏且卡死、单行 `events.jsonl` 涨到 MB 级。SDK 自述它是 *approximate progress for spinners/pills, not the authoritative billed `output_tokens`* ⇒ 权威值在收尾 `result.usage.output_tokens_details.thinking_tokens`。守卫：`events.test.ts` 的零事件产出用例 + 一致性套件的增量隔离判据（claude `plain-reply` 场景里真的喂了一条这种帧、事件条数仍声明 2） |
| 嵌套父链恒 `null`（`task_started` 只有 `spawn_depth`，`parent_agent_id` 载荷从未出现） | 厂商无此字段 | 平铺不推测父节点 |
| `Bash` 无结构化退出码（`tool_use_result` 只有分开的 stdout/stderr） | 厂商无此字段 | 退出码恒 `null`，显示「未采集」不得显示「0 = 成功」 |
| 子智能体转录读不到（目录不存在 / 文件读不动 / 空文件 / 三项缺一 / 无 id） | 全量或 null | 两格一起 `null` + 点名 WARN；名单空 ⇒ `{0,0,0}` 不点名 |
| 工具结果截断两档（我们截 >20 000 字符记 `truncated`「输出已被截断」，厂商截记 `unknown`「输出可能不完整」） | 有意取舍 | 两档都不得写「完整」 |
| skills 允许列表非沙箱（`/<name>` 派发绕过、文件盘上可达） | 厂商设计 | 真隔离靠不放文件；别把 `skills: [...]` 当多租户隔离 |
| **技能面确证在、模型一次 `Skill` 调用都不发**（`getContextUsage().skills.skillFrontmatter` 里有它、来源 `userSettings`；答复里哨兵串不命中） | 厂商 × 网关路由组合 | 缺口是**网关转换器的一行显式丢弃**：`proxyGateway` 的 `lib/convert/anthropic.js` 的 `anthropicToOpenAI` 里 `if (role === "system") continue;` —— CC 2.1.281 把整份 `<system-reminder>`（工作目录、agent 类型表、技能清单、token 预算、当天日期）放在 `messages[]` 里一条 `role:"system"` 上，非直连目标（chat / responses / gemini）整条丢；`anthropic → anthropic` 直连路由反而走 `convertSystemToUser` **就地转 user**，两条路由两种处置。判据是**同一请求体只改这一格**的差分复放：原样 ⇒ `Skill` 调用 0/3 且上游 usage 与「整条删掉」逐字相同（内容没进上下文）；改成 `user` ⇒ 两个模型各 3/3 发出 `tool_use(name='Skill')`。装入链与 `settingSources` 均已排除（四档 A/B：剔掉 `'user'` 我们的 skill 才从请求体消失）。**网关侧已改为就地降级为 user + `mid_sequence_system_downgraded_to_user` 诊断，待部署**；本机端到端已验（真实抓包 ⇒ 上游收到 `[system, user, user 7694]`）。复验命令与现象原文见 [Claude Code FAQ](/faq/claude-code) |
| MCP 服务器启动失败不抛异常 | 厂商设计 | 读 `system/init` 的 `mcp_servers[].status`（`failed` / `needs-auth` / `pending`；pending ≠ 失败） |
| 转录绝对路径 300+ 字符，PowerShell `Get-ChildItem -Recurse` 报 `DirectoryNotFound`（MAX_PATH） | 环境坑 | 用 node `fs` 枚举 / 读取 |
| 回环 mock 两坑：CLI 先发「标题生成」调用（提示词包 `<session>…</session>`，非正式轮次）；`/api/hello` 也打到 server | 方法论 | 轮次判据用 `req.url.includes('/v1/messages')` |

## 相关链接

- 活文档：[Claude Code FAQ](/faq/claude-code)——含平台包空壳条目（报错原文可 grep）
- 仓库内参考：`packages/server/agents/README.md`——§3.2 run、§4.3 权限档、§5 各家差异、§8.1 新增 SDK 接入清单、§10 术语对照
- 知识文章：[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)（对照面）、[《消息规范》](/protocols/message-spec)（块归一口径）、[《Provider 抽象与 run 入口》](/protocols/provider-run)、[《事件流》](/protocols/event-stream)、[《进程生命周期》](/protocols/process-lifecycle)、[《四家横向对比》](/protocols/comparison)、[《技能配置》](/features/skills-config)（四家 skills 的配置面与行级判据）、[《评分》](/features/judging)（结构化输出 outputFormat）
