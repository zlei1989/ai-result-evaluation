# Claude Code 接入

## 定位

Claude Code 的适配器由 `@anthropic-ai/claude-agent-sdk`（进程内 SDK，spawn 原生 CLI 二进制）驱动：`query({ prompt, options })` 返回异步迭代器，逐条产出消息流。厂商包按平台 optionalDependencies 分发原生二进制（8 个平台变体），缺包即报 `AGENT_FAILED：Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.`。能力声明：`protocolTypes: ['anthropic']`。

## 形态与交互

- **SDK 接入形状**：`Options.env` 是**整体替换**子进程环境（省略才继承 `process.env`），要自己展开宿主环境再注入；`pathToClaudeCodeExecutable` 可指定 CLI 路径；`extraArgs` 透传 CLI 参数（null = 布尔 flag）。SDK 补丁号与内含 CLI 版本同步（0.3.281 ⇒ 2.1.281）。
- **建会话**：`cwd` 过 `realpathSync.native` 归一（Windows 8.3 短名会被 CLI 安全门拦下，表现为 0 改动；归一失败回落原值记 DEBUG）；注入 `ANTHROPIC_BASE_URL`（去尾部 `/v1`，SDK 自己追加 `/v1/messages`）、`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CONFIG_DIR`（= 每个候选 `input.configHome`）；`contextWindow ≥ 1_000_000` 时模型名追加 `[1m]` 后缀（幂等、大小写不敏感）。⚠️ **按行隔离只有一条路：每个候选一个 `CLAUDE_CONFIG_DIR`**——`cwd` **不是**隔离键：同一 configDir 下换一个 cwd，`resume` 照样按 `session_id` 接上、返回的 id 不变、原转录被继续追加；换 configDir 才被拒。故「每个候选一个配置目录」不是卫生习惯而是**会话隔离的机制本身**。
- **effort 三档**：未选 ⇒ `effort` / `thinking` 两格都不加；显式 `off` ⇒ `thinking: { type: 'disabled' }` 且不传 `effort`，**另有 spawn 时 env 覆盖层** `CLAUDE_CODE_EXTRA_BODY = JSON.stringify({ thinking: { type: 'disabled' } })`（逐字节 `{"thinking":{"type":"disabled"}}`，CLI 对非法 JSON 静默忽略整条）；其余档位原样透传。`--thinking disabled` 到得了 CLI：**模型目录里认识的模型**直接写进请求体，**不认识的模型名**才被丢（CLI 判 `rejects_disabled_thinking`）而由 env 覆盖层补——**两半各管一批，删任何一半都会让某批模型的 off 失效**。非 off 档的 `claudeExtraEnvFor` 必须给空对象（`undefined` 值的键会被删掉，反而改变其它档行为）。
- **effort 的落地由 CLI 的模型目录决定**：`options.effort` 一定会拼成 `--effort <值>` 交给 CLI，但是否写进请求体的 `output_config.effort` 由 CLI 按模型条目决定。真机出站请求体 A/B（CLI 2.1.301）：`claude-sonnet-4-5` 选 `high` ⇒ **`output_config` 整格不出现**；`opus-4-5` 与非 Claude 名（`deepseek-flash`）⇒ `{"effort":"high"}`。**两版 CLI 同形**（2.1.281 也丢 sonnet）⇒ 这是既有的静默 no-op，不是升级回归。⚠️ `system/init` 的 `per_turn_effort_active` **不是**「effort 生效」的判据（落地的臂它照样是 `false`，四条臂无反例）；要证「网关真的按它算」只能抓**真网关**请求体——本机假上游只能证明我们发出去什么。能力位 `reasoningEfforts` 声明的是**值域**，不支持面按模型名而变。
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
| `result` | 终局用量与时延；**流式输入下是「每一轮一条」**（不再是运行结束那一帧）⇒ 可当**这一轮**的收轮信号，收场必须由我们驱动（见《注入与续接》）；结构化输出的兜底落点（字段优先、`result` 文本兜底，不一致落 WARN） |

- **覆盖合并（关键）**：同一条 `assistant.message.id` 按内容块分多条投递（每条只带一个块）⇒ 新块追加到末尾、同键覆盖，块序号按首次到达分配。⚠️ **块序号那本账必须按 `message.id` 跨投递存活**（`ordinalBooks`）：每条投递新建一本会让后投的块拿到 `i:0`、把先投的思考从槽里盖掉——真机症状是**原始输出里有思考、执行日志里没有**；工具调用块按 `c:<callId>` 分槽，撞不上 `i:0`，所以那个症状只在「两次投递都是文本 / 思考」时出现。
- **计量**：从 `result.usage` 取 `input_tokens`（不含缓存）/ `cache_read_input_tokens` / `output_tokens` / `output_tokens_details.thinking_tokens`；三项必填格缺一 ⇒ 整格 `null` + WARN，**绝不补 0**；`total` 恒 `null`（厂商无自报总量格）。**四家里只有这家 `apiMs` / `ttftMs` 两格都有**（pi 有 `apiMs`、首字时延恒 `null`）。⚠️ **全 0 的结算值也算「没采到」**，但要分两档：`num_turns: 0`（这次收尾本来就没有模型往返，零是**事实**）⇒ 静默判 `null`；`num_turns` 缺席或非 0 而三项全 0 ⇒ 判 `null` **并落一条点名 WARN**（崩溃 / 启动错误那一档的占位零）。两档都不许把 0 填进计量——`0` 会让人得出「这家很省」的错误结论。
- **跑动期估算**：按 `assistant.message.usage` 同 `message.id` 后到覆盖求和（侧链消息与缺 id 的不算、三项全 0 的快照丢弃）⇒ `tokensBasis: 'estimated'`，只进 usage 事件、不进结果。编排层回写判据：`tokensBasis === 'reported'` 才写快照。
  **跑动期读数与结果是同一个口径（「候选到目前为止的累计」），且单调不减**——这一条在**多轮**那条路上才承重，两件事缺一不可：
  - **每条 `result` 清一次估算表**：`result` 在流式输入下是每一轮一条，而估算表若整行只增不清，权威值到手之后**下一条 `assistant` 消息**又会把全表和交出去，骨架的 `liveTokens = estimatedTokens ?? tokens` 于是**退回估算**（界面上 tok 往回跳、`tokensBasis` 翻回 `estimated`）。清掉之后这张表的语义收窄成「**还没结算的那一轮**」。
  - **交给骨架的那一格由适配器合成**：权威值交**累计后**的值；估算交「已结算的累计 **+** 还没结算那一轮的估算」。累计点只有一处（`mainTokens`）。不做这一步的话，投影原样透传「本轮」那一份、而骨架对 `tokens` 是**覆盖**语义 ⇒ `usage` 事件只剩最后一轮，而收尾交的是全轮累加，界面与 `run.json` 各说各话（方向是事件流偏小）。
- **子智能体用量**：唯一权威源是 CLI 落盘转录 `<configHome>/projects/<项目>/<sessionId>/subagents/agent-<agentId>.jsonl`。⚠️ **续接段（`resume`）只算这一段自己产生的转录**：会话目录按 `configHome` + `sessionId` 定位，而续接用的就是同一个目录（CLI 只往原转录后面追加）⇒ 适配器在 `query()` **之前**按 `input.resume.sessionId` 取一份「此刻已有的 id 快照」，收尾读盘时把它从枚举结果里减掉（**名单里点名的除外**——被续跑的后台子智能体会沿用原 `task_id` 往原文件继续追加）。不减的话，第二段一次派发都没有也会交回上一段那一份，而候选级计量是**累加**的 ⇒ 追问一次就把那份算两遍。读数规则只有一条：只认 `type === 'assistant'`、按 `message.id` 去重后到覆盖（同一次往返按内容块出现多次，第一条 `output_tokens` 是 0，逐条相加会双计 input / cached）；三项缺一或无 id ⇒ 整份文件作废。**思考 token 与主会话读同一个字段**（`usage.output_tokens_details.thinking_tokens`，缺这一格是 `null` 不是 0）——真机转录里那一格在，不读就等于把「子智能体也想」标成「未采集」。「全量或 null」：`missing` 非空 ⇒ `subagentTokens` / `subagentTurns` 两格一起 `null` + 点名 WARN，读到的**不进合计**。
- **子任务三档产行判据**（先判形状再产行，只按 `start` 帧，**两级**）：① **厂商显式标记优先**——`task_type === 'local_agent'` ⇒ 派发，`task_type ∈ {local_bash, local_workflow, mcp_task}` ⇒ 幻影；② 这一格说不出话（缺席、或厂商新增了没见过的取值）才回落到形状：`subagent_type` / `spawn_depth` / `prompt` 至少一格非 `null`（`''` 与 `0` 都算「给了」）。`'dispatch'` 产行、`'phantom'`（CLI 给非 Agent 任务也发 `task_started`）不产行、`'unjudged'`（只见到收场帧）照产行 + 「可能少算」WARN。⚠️ **只按形状判会放行 `Workflow`**：那条 `task_started` 的 `prompt` 是**整份工作流脚本源码**（非空）、而 `subagent_type` / `spawn_depth` 都缺 ⇒ 会被判成一次派发，活动行播「已派发子任务」、收尾再喊「读不到子智能体」；`task_type` 是唯一判得干净的格。
- **任务台账（`Task*` 的整表从哪来）**：这一家的任务工具是**工作项注册表**——`TaskCreate` 建一项、`TaskUpdate` 改一项的某个字段，`TaskCreateOutput` / `TaskUpdateOutput` 都不含整表（`TaskCreateOutput` 只有 `{task: {id, subject}}`，**没有状态**；id 也**只有结果才有**，工具自己发号），整表只有 `TaskListOutput.tasks` 有。`providers/cc/task-registry.ts` 因此按 run 持一份台账：建项入账、`TaskUpdate` 的入参改状态（`owner` / `addBlockedBy` 读到的就投），两者的**结果**补它权威的那一半（创建结果回填 id / subject、更新结果的 `statusChange.to` 落状态），每个 `Task*` 调用块因此都带上「此刻的整张清单」；结果入账后**重投那条调用所在逻辑消息的快照**，刷新后的整表就落回同一个块。四条口径：「刚建、还没更新过」记 `pending`（`TaskCreateOutput` 没有状态格，依据是 `TaskUpdate` 结果的 `statusChange.from` 逐字 `"pending"`）、`deleted` 按**移除**处置（面板画的是清单当前状态）、没见过的 id 只记补丁账**不凭空造行**、**入参连标题都读不出的 `TaskCreate` 不建行**（建出来那一行标题永远空着，而它会出现在此后每一个 `Task*` 块的整表里；结果到达时凭权威的 `{task:{id,subject}}` 补建）。`TaskList` / `TaskGet` 的结果形状未观测，不入账；`addBlocks`（反向边）不投。
  ⚠️ **「这次没谈状态」与「谈了但认不出」必须分开**：`taskStepStatusOf` 的契约是「认不出一律 `'unknown'`」（它为「厂商给了一个我们不认识的串」而设）⇒ 把缺席的 `status` 直接喂给它得到的**永远**是 `'unknown'`、永远不是 `null`，而落值判据是 `status !== null` ⇒ 一次**只改 `owner` / `addBlockedBy`** 的调用会把那一行从 `inProgress` **打回 `unknown`**（面板上那条任务「做着做着变成未知」）。补丁账的合并（`patch.status ?? existing.status`）同病。故先判缺席、再翻译。
- **收尾快照的字段回填与重发**：派发帧采到的 `subagent_type` 按 run 记账，收尾帧不带这一格时**沿用派发时的值**、不覆盖成 `null`——否则消费方按 `subagentId` 覆盖后那条子任务行会退回半截（`name` 与 `kind` 都要有这层兜底）。同一身份的快照再按「身份 + 整条快照」判重：**只挡逐字相同的重发**，带新事实（终态 / 用量）的补全照发。
- **步数归属**：主会话只数主循环 `assistant.message.id`（`parent_tool_use_id` 非空直接返回 null 不计数），`num_turns` 只作兜底；侧链消息按**每会话自己的步号**编号（`roundTripOfSession`）——不能按父会话分步，否则子会话节点只有一行且读数漏进主会话。
- **工具面**：`disallowedTools` 六项无条件（`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup` / `PushNotification` / `DesignSync`）+ 非 Claude 模型（`modelId` 子串 `/claude/i` 不敏感）再追加 `WebSearch`；只禁工具不禁网络（`Bash` / `WebFetch` 照旧）。`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 常开补齐 `TaskCreate/TaskGet/TaskList/TaskUpdate`（真机读数：不开 21 项里没有 `Task*`、开了才有）。**没有「无条件七项」这回事**（早先那句登记与之矛盾，已删）：永远禁的就是那六项，`WebSearch` 随模型名分档。

## wire 形态与事件

- **消息通道**：`assistant` / `user` / `system` / `result` 四类是消费主干；**同 `message.id` 覆盖合并**是这家独有的投递形态。
- **`assistant` 帧自带的两格错误事实**（厂商在**合成的 API-error 消息**上写它们，`sdk.d.ts` 的 `SDKAssistantMessage.error` / `.aborted`）：
  - **`error` 分两档**，判据是「重试会不会让它变好」。**终局档**（`authentication_failed` / `oauth_org_not_allowed` / `account_on_hold` / `verification_required` / `cloud_credential_error` / `billing_error` / `invalid_request` / `model_not_found`）⇒ 落点名日志 + **折成候选失败**（前五条归 `AUTH_FAILED`，后三条归 `AGENT_FAILED`）；**可重试档**（`overloaded` / `rate_limit` / `server_error` / `max_output_tokens` …）⇒ **只落 WARN、不判失败**。
    为什么必须分档：`api_retry` 帧用的是**同一个** `SDKAssistantMessageError` 枚举 ⇒ 可重试档是「失败了一次、厂商马上自己退避重试」，而 `max_output_tokens` 另有自愈通道（`resumed_from_incomplete_thinking`：下一轮接着上一轮的思考块跑完）；而骨架那一侧的 `failure` 是**最后写入者赢且不会被清除** ⇒ 把可重试档写进去，就等于让一次自己恢复了的运行永远判失败。反过来，终局档**不能只等 `result.is_error`**：进程被杀 / 流被掐断时根本到不了那一帧，这一格是它们唯一的候选级出口。
    ⚠️ 归因**不走** `classifyAgentMessage`：那份表的入口是 **HTTP 状态**（读 `status` / `statusCode` 或从文案里抓数字），而厂商在这一格只给枚举名、不给状态——硬凑一个 `401` 才能命中那张表，等于编造一个上游从未发过的状态。故适配器自带一张**枚举名 → 归因码**的表（与那张是两个定义域，不是同一份映射抄两遍）。
  - **`aborted`** ⇒ 落一条「正文可能断在词中间」的 WARN，**不判失败**：被终止的行由骨架的 `canceled` 通路给结论（判定优先级），这里抢着判会把一次用户主动终止说成 `AGENT_FAILED`。
- **`system/permission_denied`**（`SDKPermissionDeniedMessage`）⇒ 一条**带人话摘要**的日志（`工具被拒 <名>：<原因>`）**＋原始负载照发**。它是**评分档的常态**——那一段走 `dontAsk` + `permissionPrompts: 'none'`（本进程没有批准面），厂商据此把该拒的当场拒掉并发这一帧；它又是「模型想写盘但被拒」的**唯一候选级出口**。原因按信息量取第一个非空：`decision_reason` → `message` → `decision_reason_type`，三格都没有就只留前半句（**不编原因**）。**不折成 failure**：被拒一次不是这个候选失败了——模型会看到工具结果并换一条路。摘要刻意与 `工具报错` 分成两句话：工具**自己跑失败**与**压根没被允许跑**的排障下一步完全不同（前者看命令，后者看权限档与放行范围）。
- **`isReplay` 的历史重放帧**（续接时 CLI 把已发生过的用户侧消息再投一遍）⇒ **两侧都零产出**，另不算投递边界。完整理由与登记见《消息规范》「非渲染增量 / 进度帧 / 重放帧」表。
- **`task_*` 帧上的 `ambient` / `skip_transcript`** ⇒ **显式标记优先于形状推断**：标了就判幻影（不产子任务行、不进事实核对名单、活动行不给摘要，但**原始负载照发**）。厂商 JSDoc 逐字 *"True for tasks that are not activity … **hosts should exclude them from activity indicators**"* ——这正是三格形状判据（`subagent_type` / `spawn_depth` / `prompt` 至少一格非 `null`）想推断的同一件事，而厂商已经直接给了答案。⚠️ 它**不影响用量**：合计读走的是「枚举会话目录」那条路，盘上有转录就照读照算，这一格只决定「面板上要不要有它这个候选」。
- **流式增量通道**：`includePartialMessages: true` **已常开**，`stream_event`（`message_start` → `content_block_delta` → `message_stop`）折成 `chunk: 'delta'` 的内容消息。四种子类型的处置**各不相同**（统一表见《消息规范》「非渲染增量」）：`text_delta` / `thinking_delta` 进通道；`signature_delta` **不进**（它是同一个思考块的一部分，落点是随后那份快照的 `signature` 字段）；`input_json_delta` **不进**（`partial_json` 是 JSON 片段，当 `input` 落库会让消费方拿到半截字符串，工具调用一律按块结束的完整快照产出）。**只覆盖主会话**（`stream_event` 的 `parent_tool_use_id` 恒 `null`），子智能体没有 token 级增量。事件侧零产出（见「已知边界」），`uuid` 去重照常生效。
- **skills 注入**（skill 只能以文件落盘，SDK 无编程式注册）：三条加法——项目级 `<cwd>/.claude/skills/<name>/SKILL.md`、用户级 `$CLAUDE_CONFIG_DIR/skills/`（⚠️ 不是 `~/.claude/skills/`）、插件级 `plugins: [{ type:'local', path }]`（唯一能指定任意路径并绕开 `settingSources`，skill 名带命名空间 `插件名:技能名`）。两个开关：`settingSources` 决定发不发现（`[]` 会把 CLAUDE.md 一起挡掉，别用它关 skill）、`options.skills` 决定模型能调哪些。⚠️ **`options.skills` 的三档有两档落在 argv 上、`[]` 不在**：`'all'` ⇒ `--allowedTools Skill`、`['a']` ⇒ `--allowedTools Skill(a)`，而 **`[]` 在 argv 上与「省略」逐字节相同**——真正生效的是 stdin `initialize` 载荷里的 `skills: []`（`sdk.d.ts` 原文 *Omit to load every discovered skill*）；实测 `skills: []` ⇒ `getContextUsage().skills` 整格缺席、零条进技能面。非法名（通配符后缀、空名）**启动前**抛 `Invalid skill name "docs:*": wildcard-suffix names are not allowed`。
- **本仓的 skills 落地口径**：落点 = 候选配置目录的 `<configHome>/skills/<名称>/`（`configHome` 就是 `CLAUDE_CONFIG_DIR`），每次 `run` 之前**整目录物化**；这一家对时序没有更紧的要求（文件在 `query()` 之前落盘即可，对照 codex 必须早于 spawn、dsh 必须早于 boot）。**`options.skills` 本仓不传**：它是「模型能调哪些」的筛选而不是注入，停用统一走**文件级不放**（被停用的根本不进清单）——不传即「加载所有已发现的 skill」，正是要的语义。代价是 `settingSources` 三档全开时被测仓库自带的 `.claude/skills/` 也会被发现（见下一条）。**判据 = `getContextUsage().skills.skillFrontmatter`**（每个元素带厂商原值 `source`：`userSettings` / `projectSettings` / `built-in`），在流循环里 `system/init` 之后采一次并缓存，收尾同步交出。
- **skills 非沙箱**：允许列表挡得住工具调用（`<tool_use_error>Skill probe-unlisted is not in this session's skills allowlist</tool_use_error>`）但**挡不住 `/<name>` 提示词派发**；`init.skills` 不反映允许列表（假阳性判据）；真隔离靠不放文件。本仓 `settingSources` 三档全开（`['user','project','local']`，且与 `settings.env` 成对给——打开才能读被测仓库 `CLAUDE.md`，开了就要用 flag 档把仓库 `.claude/settings.json` 的 `env` 块钉回去，实测层级 user < project < local < flag）⇒ 被测仓库自带 `.claude/skills/` 会被自动发现，是跨家口径的静默差异。⚠️ **清单的送达还有一跳，与装入无关**：CC 把整份 `<system-reminder>` 放在 `messages[]` 里一条 `role: "system"` 的消息上，网关不认这个角色就整条丢掉——`vendor-system.skills` 报的是 CLI 的装配读数，它**不蕴含**模型收到过（见下表同一条）。
- **MCP 接法**（本仓已落地）：**通道 = SDK 参数 `Options.mcpServers`**（不落 `<configHome>/.claude.json`）——参数是编程入口，同名时**高于**磁盘配置，且不落盘就不会与宿主那份混起来。条目由 `toClaudeMcpServers` 一处翻译：stdio 是 `{type:'stdio', command, args?, env?}`（**无 `cwd` 字段**）、http 是 `{type:'http', url, headers?}`；可选格缺席就**不写那个键**（空数组 / 空对象在厂商侧是「显式声明为空」，与「没声明」不是一件事）。SDK 侧另两种传输（sse 已弃用、sdk 进程内）本仓不做。`strictMcpConfig` **保持关闭**：它会**完全压制**仓库自带的 `.mcp.json`（本仓要的是不压制），同名的判定：**程序化注入赢且只留一条**（替换，不并存不改名；`source: 'dynamic'` 顶掉 `'project'`）。宿主 `~/.claude.json` 与注入同名时谁赢**未单独测**，勿写死。工具名 `mcp__<server>__<tool>`；allow 规则里 `mcp__*` 非法（`Wildcard tool name "mcp__*" is not supported in allow rules`）。不写 `allowedTools` ⇒ 工具可见但需授权，headless 无 `canUseTool` 时 `ask` 是终止性拒绝。
  - **判据链**（只看事件侧 / server 侧）：`system/init` 的 `mcp_servers[].status === 'failed'` ⇒ **候选失败**（归因码 `AGENT_MCP_UNAVAILABLE`，文案 `MCP「<name>」未能启动：<厂商原文首行>`）；**工具表里有 `mcp__<name>__` 前缀的工具 ⇒ 已连上**（比 `status` 更硬）；`status` 是 `pending` / `needs-auth` 或根本没有这台 ⇒ `unverified`，**不判失败**。`system/init` 是一次性事件，**不等待**。硬证据永远是 **MCP server 进程自己的输入里有 `tools/call`**（模型答复不算证据——派发失败时模型可能把预期结果编出来）。
  - **候选内首次注入 playwright MCP = 17.2 s / 61 MB**（宿主 registry 是公网时）⇒ 行的 `HOME` 一换，npm 的 `userconfig` 就从 `~/.npmrc` 变成 `<行HOME>/.npmrc`（不存在），registry 从内网镜像掉回公网。缓解：把宿主 npm 配置里的 **registry 那一行**写进行 `configHome` 的 `.npmrc`（只那一行、`0600`、不碰宿主），拉回 ~4 s 级；等待预算仍按 **≥ 20 s** 留。配置面与完整边界见[《MCP 配置》](/features/mcp-config)。
- **内置工具清单**（一次实测快照 27 项，随模型与开关浮动 23～30）：`Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, WebFetch, WebSearch, Workflow, Write`。`Task` 与 `Agent` 是同一工具两种叫法，族映射须归同族；精确同名交集 claude∩dsh = 空、claude∩codex = 空 ⇒ 对齐只能在语义类别层做。

## 提问与应答面

厂商自带提问工具（`AskUserQuestion`），本仓声明 `askUser: yes` + `askUserChannel: 'vendor-tool'`，一致性场景走**真路径**（真 CLI + 本机假上游，只把上游模型脚本化）。

| 面 | 现时做法 |
|---|---|
| 通道 | **权限回调**（`can_use_tool`，线级帧带 `requires_user_interaction: true`）——不是对话框通道：`request_user_dialog` 那条路本仓不实现，走它的提问落「无人应答」 |
| 递答案 | 宿主把答复装进 `updatedInput.answers` 交回，**键是题目文本**（不是 `header`、不是序号）：单选给选项标签串、多选给数组；厂商把它渲染进工具结果念给模型。自由输入单选时**取代**选项（值取 `custom`，此时答卷的 `selected` 为空）、多选时与选项标签**拼成同一个数组**（厂商那一侧只有一格可用）——两档都经这一格到模型眼里，见下面 `response` 那条边界的理由。题面认不出来（题头配不上）或**题面是空串**（厂商没给 `question`）就跳过该题：厂商按题面文本查表，`''` 配不上任何一题 ⇒ 写进去等于「这一题没答」而我们以为答了，两题都缺题面时还会互相覆盖 |
| 等待预算 | 厂商侧没有：`askUserQuestionTimeout` 缺省 `never`（没人答就一直挂着）⇒ 端口那一侧如实给 `vendorBudgetMs: null`，超时只由我们的预算（缺省十分钟）产生。⚠️ 正因为没有厂商预算，**入参认不出（归一后一道题都没有）时压根不问人、当场放行**：否则一帧畸形入参会让界面出现一张**没有任何问题**的卡片、而没有人可能答它，整行被白等满一个预算 |
| 收场 | **有答案**（`answered`）⇒ 放行并把答案装进 `updatedInput.answers`；**没有人回答**（其余六态：`timeout` / `unavailable` / `rejected` / `canceled` / `skipped` / `auto-resolved`）⇒ **拒这一次工具调用**并把收场方式讲给模型（`deny.message` 被厂商渲染成工具结果，文案点名收场方式 + 「请按你的最佳判断继续，不要重复提问」）。为什么不是「放行 + 空答案表」：那张空表在厂商侧与「每一题都没配上键」**同形**，模型会按「用户什么都没选」继续，而 `canceled`（行已终止）那一档还会白放行一次工具执行。⚠️ **「问了但一题都没选」不走这条**（`answers` 是空数组而非 `null`）——那是如实的空表，与「没有人答」是两件事 |

四条今天仍成立的边界：

- **不挂钩子 ⇒ 这个工具被禁用**：厂商在 headless 下没有批准面就不把提问工具提供给模型，脚本式调用拿到 `<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session, in subagents as well as here.</tool_use_error>` ⇒「不问就不动」在这一家是**结构性**的，不是靠我们拦。
- **接它不需要动权限档**：全权档只遮蔽普通工具（`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告指的是那一批，普通工具根本到不了回调），提问工具带 `requires_user_interaction`，两档的控制帧逐字相同。
- **只读档问不到人**：`dontAsk` + `permissionPrompts: 'none'` 下厂商把提问工具一并从模型工具表撤掉、控制帧一条都不发 ⇒ 那一档即使挂了应答面也落「无人应答」（评分阶段因此不会向人提问），本模块不为它写分支。
- **子智能体发起的提问到不了宿主**：厂商自己就拒（`not available inside subagents`，子会话工具表 25 项 vs 父会话 30 项）⇒ 端口收到的 `subagentId` 恒 `null`——不是「没读到」，是这一家拿不到；`rejected` 那条收场留给厂商自己。

两处跨臂差异要如实登记（它们让「有人答的轮」与「没答的轮」在工具面上天然不同）：**挂上应答面会让厂商工具表多出几件**（`AskUserQuestion` / `EnterPlanMode` / `ExitPlanMode`，`Monitor` 两臂都有），命令面那一列也跟着变；一致性套件把实测到的那几件**逐件点名**归一，点名之外仍有差异即红。选项侧的 `recommended` 在这一家恒 `false`（厂商的提问工具入参里没有这一格，它用「排首位」表达）；问题侧的 `allowOther` 恒 `true`——这一格读的不是提问形状而是**答案面**：厂商的 schema 逐字写着「不要给 'Other' 选项，那个界面上自动提供」，用户写的那句话经选项值那一格进 `answers`，工具结果逐字 `The user answered: "<题面>"="<自由输入>"`（真机读数出自探针 `probe/v11/cc-ask-answer.mjs` 的 `answer-custom` 臂）。

## 注入与续接

「人往运行中的这一轮送话」与「接着一条已有会话再跑一段」是契约的两格（`AgentRunInput.inject` / `resume`），在这一家的落点如下。

| 面 | 现时做法 |
|---|---|
| `'round'`（立即发送） | 在「**任一条**工具结果到达」（不区分主会话/侧链、也不看同批还有没有别的工具在跑）取件，把它推进 CLI 的**输入流**（`SDKUserMessage`）。**落点由竞速定**：同批仍有工具在途时厂商多半把它**折进本轮**（塞进某条 `tool_result.content`，或另起一个兄弟 `text` 块），否则另起一轮——真机 6 次复采 4 次折入（见下面那条边界） |
| `'idle'`（排队） | 同样推进输入流，但取件时刻是**这一轮收场**（`result` 到达）——CLI 据此**另起一轮**接着跑 |
| 投递车道 | **缺省车道**：不写 `priority`（CLI 按 `'next'` 处理）。两档的差别因此不在 `priority` 而在**取件时刻**——`'idle'` 那一档不写 `later`，靠「本轮收场之后才推」达到与 `'round'` 相同的落点 |
| 撤回 | 控制请求 `cancel_async_message`（SDK 方法名 `cancelAsyncMessage`），**按我们自铸的 uuid** 认人（厂商侧那一格可选）⇒ 这个 uuid 在投递时才存在，撤回身份因此是我们自己的 |
| 续接 | `query({ resume: <session_id> })`；`session_id` 从 `system/init` 取、随结果上报进行的快照 |

四条今天仍成立的边界：

- **投递只在 streaming input 那一支存在**：字符串题面下 CLI 判 `isSingleUserTurn`，首条 `result` 一到就关 stdin，中途什么都塞不进去。**题面本身也从这条流进去**（streaming input 下没有「一次性 prompt」那一格）。
- **消费方必须读 `tool_result` 的 `content`**（字符串与块数组两种形状都要认）：工具结果本体（命令输出、文件内容）就在那里面，只认 `text` 块会把工具结果读成空。
- **落点是竞速的结果，两种都真实存在**（CLI 2.1.301 六次复采的读数）：
  - **折入本轮**——同批仍有工具在途时，消息在厂商**构造那条请求之前**进了队列，于是被折进去。厂商自己挑形状（两种外形都出现过）：**塞进某条 `tool_result.content` 的字符串里**（形如 `…\n\n<system-reminder>\nThe user sent a new message while you were working:\n<正文>\n…</system-reminder>`），或**在同一条 user 消息里另起一个兄弟 `text` 块**。CLI 的措辞自己就把这条路径当正规形态：*"within the running turn, often alongside the next tool result, **rather than as a separate conversation turn**"*。
  - **另起一轮**——消息只能在工具跑完之后被取件，那批工具已经收尾 ⇒ 厂商另开一轮。
  - **判据**：`'round'` 取件**不蕴含**折入（同批还有别的工具在途才更可能折入），`'idle'` 取件**蕴含**另起一轮（那是本轮收场之后）。同一份剧本两跑跑出两种落点（探针 08a 与 11 逐字同剧本）⇒ **界面与文档都不许把任一种写成必然**：按「折进本轮」写动效会在另起一轮时骗人，按「一定另起一轮」写文案会在折入时骗人。要**保证**折入得先有一条更早的边界（那属契约变更，见《Provider 抽象与 run 入口》的注入面）。
  - 折入**不影响账本**：适配器侧的 `user` 帧不带那段 reminder，那条工具结果的正文在 `messages.jsonl` 里是干净的（真机 31 字符），不存在「同一内容写两遍」。
- **输入流不 `end()` 时查询不会自己结束** ⇒ 收场必须由我们驱动（`end()` / `interrupt()` / `abortController`）；适配器的口径是「本轮收场**且**一条人话都没取到」才收流。
- **取消之后一条都不再投**：`interrupt()` **先立停止位、先收流，再发厂商的 interrupt**。顺序是判据的一部分——厂商在 `interrupt()` 之后不当场闭嘴，它会把被中断那一轮的 `result` 照样送上来，而那一帧会走到流循环里的取件分支 ⇒ 不先立这一格的话，队列里剩下的人话会在「已经要求停止」之后被投给 CLI，并且因为「投出去了」而**不收流**（CLI 另起一轮，再被 5 秒后的 `dispose()` 硬杀在半路，那一轮的产物归属不明）。症状不是报错，而是「点了停止，它又跑了一轮」。收流幂等，且**不丢**队列里那些——它们仍由编排层持有。
- **只有真进了厂商队列的那些才登记「已投递」**：`markDelivered` 的契约是「适配器把消息真交给厂商**之后**」才调。推不进去（流已收）的那条只落 WARN、**不登记**——它已经被 `drain` 从编排层队列里取走，却一个字节都没进 CLI 的命令队列，登记之后撤回面会拿它的 uuid 去问厂商、厂商回 `false`，而 `false` 在这一家的读法里是「**已经交给智能体了，撤不回来**」⇒ 界面会告诉用户「来不及了」，而它根本没交出去。

**续接用 `resume` 不用 `continue`**：`resume` 按 id 指名道姓；`continue` 取当前目录最近一条，而候选内重跑复用同一个 `cwd` ⇒ 它会静默续上一次尝试的上下文（配合上面那条「cwd 不是隔离键」，两种错会叠在一起）。定位键只有 `CLAUDE_CONFIG_DIR` 一个。

**声明的现状（界面按它置灰，不按机制猜）**：投递两档记 `unverified` / `unverified`，界面据此置灰并说「没验证过」。这格 `unverified` **指的是「折进本轮」那句口径**，不是「投不投得出去」——两件事要分开读：
- **已真路径证到的一半**：消息真被厂商收下（出站请求体里出现那句话的逐字正文），并**开了一轮新的模型往返**；
- **仍是 `unverified` 的一半**：契约 `'round'` 要的「折进本轮那条带工具结果的请求」做不到（机制见上一条边界）⇒ 声明里也不写成做得到。

撤回两格记 `by-id`（`cancelAsyncMessage` **不在 SDK 公开面**：`Query` 接口与 `.d.ts` 都没有它，但安装态的 `sdk.mjs` 里**有实现** ⇒ 运行时探测，缺席时才回 `unsupported`）；续接那一格是 `yes`，判据是**经产品适配器**跑通的端到端续接：同 `configHome` 命中上一进程埋下的暗号、阴性对照不命中、换 cwd 仍续得上、换 `configHome` 被拒。

## 已知边界与取舍

| 边界 | 性质 | 处置与判据 |
|---|---|---|
| darwin-arm64 平台包空壳（pnpm 11 headless 只信 `.package-map.json` + lockfile，`--force` 也 "Already up to date"） | 环境坏 | 全删 `node_modules` 重装（warm store 约 4 分 18 秒）；守卫 `native-cli.test.ts` 复刻 SDK 解析链断言本机平台二进制可解析 |
| 流式增量只覆盖**主会话**（`stream_event` 的 `parent_tool_use_id` 恒 `null`） | 厂商投送面 | 子智能体不做逐字动画；能力位带这条前提，消费方按「实际到达的块形态」渲染而不是按「有增量」写动效 |
| 流式增量不进原始日志（事件侧零产出） | 有意取舍 | `events.ts` 对 `stream_event` 显式 `emptyProjection()`：一次运行几百上千条增量帧落进未识别兜底会把「原始输出」面板刷成 JSON 流水，真要看 stderr / init 反而被冲掉；它的落点只有实时消息通道（只广播不落盘） |
| `system` / `thinking_tokens` **思考进度帧**同样零事件产出 | 真机量级 | 形状 `{"type":"system","subtype":"thinking_tokens","estimated_tokens":N,…}`，**每个思考 token 一条**。真机 run `7f05c765` 的 claude 行：**11,629 条**（占该候选 12,509 条 `log` 的 93%），评分智能体那条路再叠 **670 条** ⇒ 原始输出抽屉刷屏且卡死、单行 `events.jsonl` 涨到 MB 级。SDK 自述它是 *approximate progress for spinners/pills, not the authoritative billed `output_tokens`* ⇒ 权威值在收尾 `result.usage.output_tokens_details.thinking_tokens`。守卫：`events.test.ts` 的零事件产出用例 + 一致性套件的增量隔离判据（claude `plain-reply` 场景里真的喂了一条这种帧、事件条数仍声明 2） |
| 嵌套父链用 `parent_task_id`（真机：内层派发那条 `task_started` 带这一格，值**逐字等于**外层那条的 `task_id`，同时 `spawn_depth` 进 2） | 厂商原生字段 | 直接填 `SubagentRecord.parentSubagentId`（界面按它把子任务挂到 `subagent:<父 id>` 下）。**收场帧不带这一格** ⇒ 按同一个 `task_id` 回填，否则收尾那一刻整棵子树挂回主会话。顶层派发本来就没有父 ⇒ `null` |
| **上下文压缩的两条状态帧**（`system/status` 的 `compacting` 与 `compact_result: success\|failed`） | 已接（活动行） | 压缩是长过程，此前只躺在原始 JSON 里 ⇒ 界面既不知道在压缩、也不知道压失败了。现在两档各给一句活动行摘要（`compact_error` 原样带上）；**`status: 'requesting'` 是每轮一条的心跳**（实测 25 轮的运行里 25 条），照旧只落原始负载、不占活动行 |
| `system/compact_boundary`（压缩边界，带 `compact_metadata`） | **未观测** | 从未在真机抓到过它（`compacting` 那一档抓到过、**成功**压缩没复现出来）⇒ 今天它走「未识别兜底」：原始负载留证、活动行不说。**不按类型面猜它的行为**。已确证的三条（都在 `getContextUsage()` 与状态帧的真机读数上）：① `settings.autoCompactWindow` **生效**（设 100000 ⇒ CLI 自报 `maxTokens: 100000`；设 1000000 ⇒ 仍是 200000 ⇒ 这个设置只在不超过模型窗口时生效）；② **阈值 = 窗口 − 33000**（两点逐字吻合：100000 → 67000、200000 → 167000；`× 0.67` 只在 100000 那一档巧合成立）；③ **判据不是 `count_tokens` 的返回**——count_tokens 请求体到 457 KB（≈114K tokens，远超 67000）仍未触发，而触发过的那次 `messages` 请求体是 517 KB（未触发那次只有 227 KB）⇒ 上界线索指向**请求体规模**；`Read` 大结果的截断又与「已有多少上下文」耦合（首轮空上下文不截断、已有上下文时截断），故假上游下很难同时凑齐「多组可压」与「上下文超阈值」 |
| **`system/task_updated` 的 `patch` 今天不消费**（子任务状态只由 `task_started` → `task_notification` 两端决定） | **未闭合**（缺契约槽位） | 厂商那一帧带 `patch.status`，值域是 `pending` / `running` / `completed` / `failed` / `killed` / `paused`，JSDoc 要求 *"Clients merge into their local task map"*；它也是唯一带 `patch.error` 与「移到后台」（`patch.is_backgrounded`）的通道 ⇒ 不接的代价是**面板上那一行从派发到收场之间一直停在 `running`**、中途失败的原因不可见。没有现在就接的原因：契约的 `SubagentStatusSchema` 是 `running` / `completed` / `failed` / `stopped` / `unknown` 五值，厂商的 `pending` 与 `paused` **没有对应槽位**，而把它们压成 `unknown`（那一格的语义是「状态没采到」）是写一句假话。要闭合得先裁定契约值域（动它会波及 ui 的子任务行与另三家的归一） |
| `Bash` 无结构化退出码（`tool_use_result` 只有分开的 stdout/stderr） | 厂商无此字段 | 退出码恒 `null`，显示「未采集」不得显示「0 = 成功」 |
| **`--add-dir` 只认目录**（传文件路径时 `dontAsk` 照旧拒读，`Read` 与 `Bash{cat}` 两条路都拒；与符号链接形态无关） | 厂商语义 | 适配器把 `extraReadPaths` 的**文件项换算成父目录**（`additionalDirectoriesFor`：目录项原样、去重保序、路径不存在按文件项处置），放行面因此比调用方写的宽一个目录；精确到单个文件的另一条通道是 `settings.permissions.allow: ["Read(//<绝对路径>)"]`（双斜杠前缀才认），但它只覆盖 `Read` 工具、`Bash{cat}` 仍被拒，故未采用 |
| **追问（`resume`）段的技能目录不会自动收缩**：上一段装进 `<configHome>/skills/` 的那些，在这一段清单里没有也仍在盘上，而 CC 的 `settingSources` 含 `'user'`、`CLAUDE_CONFIG_DIR` 正是这个目录 ⇒ 照旧被发现（模型仍可调用） | 未闭合（跨 core 与四家） | `materializeSkills` 的清理口径是「有则覆盖」，它把「不需要自己清理」的理由写成「重跑时 `prepareCandidateWorkspace` 会整删 `.agenthome`」，而**追问那条路刻意不 prepare**（复用既有 `.agenthome` 才能续接）⇒ 该理由不成立。落点要先在 core 侧记一份「候选装过哪些名字」的清单（不能整目录清空：`skills/.system/` 住着 codex 的内置技能），再让各家的调用点在本段清单为空时也走一次清理——另三家各自的追问路径都要真机复核，故本期只登记 |
| 子智能体转录读不到（目录不存在 / 文件读不动 / 空文件 / 三项缺一 / 无 id） | 全量或 null | 两格一起 `null` + 点名 WARN；名单空 ⇒ `{0,0,0}` 不点名 |
| 工具结果截断两档（我们截 >20 000 字符记 `truncated`「输出已被截断」，厂商截记 `unknown`「输出可能不完整」） | 有意取舍 | 两档都不得写「完整」 |
| skills 允许列表非沙箱（`/<name>` 派发绕过、文件盘上可达） | 厂商设计 | 真隔离靠不放文件；别把 `skills: [...]` 当多租户隔离 |
| **技能面确证在、模型一次 `Skill` 调用都不发**（`getContextUsage().skills.skillFrontmatter` 里有它、来源 `userSettings`；答复里哨兵串不命中） | 厂商 × 网关路由组合 | 缺口是**网关转换器的一行显式丢弃**：`proxyGateway` 的 `lib/convert/anthropic.js` 的 `anthropicToOpenAI` 里 `if (role === "system") continue;` —— CC 2.1.281 把整份 `<system-reminder>`（工作目录、agent 类型表、技能清单、token 预算、当天日期）放在 `messages[]` 里一条 `role:"system"` 上，非直连目标（chat / responses / gemini）整条丢；`anthropic → anthropic` 直连路由反而走 `convertSystemToUser` **就地转 user**，两条路由两种处置。判据是**同一请求体只改这一格**的差分复放：原样 ⇒ `Skill` 调用 0/3 且上游 usage 与「整条删掉」逐字相同（内容没进上下文）；改成 `user` ⇒ 两个模型各 3/3 发出 `tool_use(name='Skill')`。装入链与 `settingSources` 均已排除（四档 A/B：剔掉 `'user'` 我们的 skill 才从请求体消失）。**网关侧已改为就地降级为 user + `mid_sequence_system_downgraded_to_user` 诊断，待部署**；本机端到端已验（真实抓包 ⇒ 上游收到 `[system, user, user 7694]`）。复验命令与现象原文见 [Claude Code FAQ](/faq/claude-code) |
| MCP 服务器启动失败不抛异常 | 厂商设计 | 读 `system/init` 的 `mcp_servers[].status`（`failed` / `needs-auth` / `pending`；pending ≠ 失败） |
| 转录绝对路径 300+ 字符，PowerShell `Get-ChildItem -Recurse` 报 `DirectoryNotFound`（MAX_PATH） | 环境坑 | 用 node `fs` 枚举 / 读取 |
| 回环 mock 两坑：CLI 先发「标题生成」调用（提示词包 `<session>…</session>`，非正式请求）；`/api/hello` 也打到 server | 方法论 | 步数判据用 `req.url.includes('/v1/messages')` |

## 相关链接

- 活文档：[Claude Code FAQ](/faq/claude-code)——含平台包空壳条目（报错原文可 grep）
- 仓库内参考：`packages/server/agents/README.md`——§3.2 run、§4.3 权限档、§5 各家差异、§8.1 新增 SDK 接入清单、§10 术语对照
- 知识文章：[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)（对照面）、[《消息规范》](/protocols/message-spec)（块归一口径）、[《Provider 抽象与 run 入口》](/protocols/provider-run)、[《事件流》](/protocols/event-stream)、[《进程生命周期》](/protocols/process-lifecycle)、[《四家横向对比》](/protocols/comparison)、[《技能配置》](/features/skills-config)（四家 skills 的配置面与候选级判据）、[《评分》](/features/judging)（结构化输出 outputFormat）
