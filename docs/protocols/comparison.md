# 四家横向对比

## 定位

cc / codex / dsh / pi 四家厂商智能体的逐项对照：接了四家之后，差异吸收在各自适配器里，但选型、写跨厂商代码、排障时需要一张按维度的对比表。命名不是对齐键——对齐只在语义类别层做。

## 形态与交互

**接入形状总表**：

| 维度 | cc | codex | dsh | pi |
|---|---|---|---|---|
| 厂商包 | `@anthropic-ai/claude-agent-sdk` | `@openai/codex` | `@deepseek-ai/dsh-sdk-client`（next 线，R33） | `@earendil-works/pi-coding-agent`（配套 `@earendil-works/pi-ai`） |
| 驱动形态 | 进程内 SDK，spawn 原生 CLI | `codex app-server`（JSON-RPC/stdio） | SDK spawn 运行时，通知流 | **进程内 SDK**：一行一次 `createAgentSession`，**没有可杀的 child** |
| `protocolTypes` | `['anthropic']` | `['openai']` | `['openai','anthropic']`（双协议一家） | `['openai','anthropic']`（协议决定 wire：`openai → openai-responses`、`anthropic → anthropic-messages`） |
| base URL 处理 | **剥**尾部 `/v1`（SDK 自己追加 `/v1/messages`） | **补** `/v1`（CLI 只走 `POST {base}/v1/responses`） | 按 wire 分叉：anthropic 剥、openai 补 | 按 wire 分叉，规则与 dsh 逐字相同（pi 不做任何归一化） |
| 配置目录 | `CLAUDE_CONFIG_DIR` + `HOME` | `CODEX_HOME` + `HOME` | `DSH_HOME`（**不是** HOME） | 行 `configHome`（装载器的 `agentDir`）；**进程级全局路径只认 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` / `~/.pi/agent`**（子会话与扩展走它，`agentDir` 管不到；第二格优先、只管落盘目录） |
| `cancelMidTurn` | true | true | **false**（终止晚 5 秒是设计） | true（`session.abort()` 毫秒级终结在途轮） |
| 结构化输出通道 | **原生**：`options.outputFormat`（收尾消息回 `structured_output`） | **原生**：`turn/start` 一等字段 `outputSchema` | **无原生通道 ⇒ 适配器内部填充层**：首轮提示词追加 schema 约束 + 骨架驱动的同会话修正轮 | **工具通道**：自定义工具 `submit_result` 带 `constrainedSampling`（strict），形状由厂商侧强制；预检不过 ⇒ 显式降级（降 `prefer` + 填充层） |
| `applied.structuredOutput` | 按本次收尾消息里有没有 `structured_output` 上报 | 按本次有没有把 schema 发进 `turn/start` 上报 | **恒 `false`**（填充层不是原生通道） | 按**本轮答复是否确实来自被 strict 约束的工具参数**上报（模型改走正文时翻回 `false`） |
| 权限 full 档 | `bypassPermissions` + `allowDangerouslySkipPermissions: true`（必须成对） | `danger-full-access`（`workspace-write` 默认关网络） | `DSH_PERMISSION_MODE=danger-full-access` | **工具白名单**（pi 没有权限标志位）：`read` / `bash` / `edit` / `write` + 子智能体扩展那三件 + `mcp__*` 通配 |
| 权限 read-only 档 | `dontAsk`（刻意不是 `plan`） | `read-only`（**Windows 上落 `danger-full-access`**） | `DSH_PERMISSION_MODE=read-only` | 工具白名单 `read` / `grep` / `find` / `ls`——**问答复用工具、子智能体扩展那三件与 `mcp__*` 通配都不给**（MCP 工具名由服务器自己定，通配等于把「服务器自带写工具」一并授权；真机曾读到 `mcp__ws__write_file` 在只读档真写成功）。`Agent` 派出的子会话另拿完整工具面、能写文件，那是权限提升 |
| 流式增量 | **yes**（`includePartialMessages: true` 常开，`stream_event`；**仅主会话**） | **yes**（`item/agentMessage/delta` + 两条 reasoning delta；`plan` / `commandExecution` 两条显式丢+计数） | **yes**（`source: 'hook'`：通知层没有 delta ⇒ 插件旁路 sidecar 文件 + 100 ms tail） | **yes**（`source: 'wire'`：`session.subscribe` 的事件里就有逐字增量，不需要旁路） |
| 消息级 usage | 恒 `null`（wire 上 `output_tokens` 恒 0） | 恒 `null`（协议只到线程级） | **有**（`assistant/message` 的 `data.usage`） | **有**（助手 `message_end.message.usage`，记的是那次往返的读数、不进任何合计） |
| `reasoningTokens` | `output_tokens_details.thinking_tokens` | 按线程累计（`input − cached`） | 恒 `null`（路由 `mapUsage()` 有意不投影） | 有（`usage.reasoning`，是 `output` 的子集） |
| `apiMs` / `ttftMs` | 两格都有（**四家唯一**） | 恒 `null` | 恒 `null` | 有 `apiMs`（厂商 `durationMs` **按轮交增量**、候选级累计由骨架 `mergeTiming` 相加；整格记 `'vendor'`）；`ttftMs` 恒 `null`（厂商不报首字时延） |
| effort off 落点 | `thinking:{type:'disabled'}` + env 覆盖层（两半各管一批模型） | `effort:'none'` + `model_reasoning_summary:'none'`（后者空转）；**off 关不掉思考（未闭合）** | `thinking:{type:'disabled'}` / `reasoning:{effort:'none'}`（真机 0/0 成立） | openai wire 是 `reasoning:{effort:'none'}`；anthropic wire 是 `thinking:{type:'disabled'}` |
| 终结信号 | `result` 消息：**挂上注入端口**（streaming input）时是**每一轮一条**（不再是运行结束那一帧）⇒ 可当**这一轮**的收轮信号，收场由适配器驱动（本轮收场**且**一条人话都没取到才收流）；没挂端口时一次运行恰好一条 | 主线程那条 `turn/completed`（按 `threadId` 认）。⚠️ 注入会多出终结信号：`'round'` 的 `turn/steer` **不发新的 `turn/started`**，而 `'idle'` 的耐久队列由厂商在该线程空闲后**另起一轮**投出 ⇒ 同一 `threadId` 上不止一条 | `turn/end`（`status` + `stopReason` 两格合读）。⚠️ `'idle'` 那一档的投递点是 `next-turn`（另起一轮）⇒ 一趟 run 里 `turn/end` 不止一条 | `agent_settled`（`agent_end` 之后还可能有 auto-retry、compaction 与排队输入） |
| 提问与应答面 | **厂商工具**：`AskUserQuestion` 走权限回调 `can_use_tool`，答复装进 `updatedInput.answers`（**键＝题目文本**） | **厂商工具**：server→client 请求 `item/tool/requestUserInput`，答案**按题目 id** 配对回帧（`{answers: {<id>: {answers: []}}}`）；**题目对象只有单选**（没有多选那一格 ⇒ 多选得拆成多次提问） | **厂商工具**：进程内 waterfall `user-questions/request`，旁边装一个**应答者插件**，答案走文件型 side channel（按厂商的 `wait.callId` 配对） | **宿主工具**：`ask_user_question` 由我们注册，`execute` 里同进程 `await` 回调（零 IPC） |
| 用户自己写的答案（弹层的自由输入） | 在选项值那一格里（单选取代选项、多选并入数组）；题面的 `allowOther` 恒 `true`——厂商 schema 写明「'Other' 由界面自动提供」 | 与选项标签并进同一个字符串数组（题面的 `allowOther` 来自厂商的 `isOther`） | 走该题的 `custom`（单选取代、多选补充）；题面的 `allowOther` 恒 `true`——答复项恒带可选 `custom` | 与选项标签并在同一段渲染文本里（题面的 `allowOther` 是我们自己 schema 里的一格） |
| 厂商侧等待预算 | 无（`askUserQuestionTimeout` 缺省 `never`）⇒ 超时由我们的预算产生 | 无（`autoResolutionMs` 已 `@deprecated` 且实测恒 `null`）⇒ 每一次收场都由我们回帧 | 等待档**随应答面派生**：挂了应答面回落**阻塞档**（`timed` + `timeout: -1`），没挂则 `timed` + 1 秒、到点交回厂商设计好的「待答」结果 | 无（`vendorBudgetMs` 恒 `null`）⇒ 超时由我们的预算产生 |
| 子智能体发起的提问 | 厂商自己拒（`not available inside subagents`） | 厂商自己拒（`can only be used by the root thread`） | 厂商自己拒（`assertLiveRoot` ⇒ `CALLER_NOT_LIVE` / `DELEGATED_CALLER`） | **未证实**：自定义工具只装在主会话的装配面上，没跑过子会话的工具表 |
| 没有人回答时交回什么（`answers === null` 的六态） | **拒这一次调用**（`deny.message` 被厂商渲染成工具结果）并**点名收场方式**。不交空表：那张空表在厂商侧与「每一题都没配上键」同形，模型会按「用户什么都没选」继续，而 `canceled` 那一档还会白放行一次工具执行 | **整张空表**（`{answers: {}}`）——那是厂商原生的「无答案」语义 | 插件 `next()` **交委派**，厂商随即以它自己的收场结束那一问 | 渲染一段**点名收场方式**的文本（`没有人回答（收场方式：…）`）交回工具结果 |
| 「问了但一题都没选」怎么区分 | `answers` 是**空数组**（不是 `null`）⇒ 照旧放行 + 如实的空表 | 那一题的格子是空数组（`{answers: []}`），与「整张表空」不同 | 该题落 `selected: []` 且不带 `custom`（「跳过」）；整份为空才走委派 | 逐问回填，没答案的问**也出现一行** |
| 投递两档（`'round'` 立即发送 / `'idle'` 排队） | `unverified`（`wire`，无版本门）：两档共用同一支**输入流**，`'round'` 在工具结果边界取件、`'idle'` 在本轮收场取件；**两档落点实测一致**（都被厂商读成另起一轮——折入窗口早于这两档的取件点，见《Claude Code 接入》的《注入与续接》） | `'round'` `unverified`（`wire`，**真版本门 `0.156.1`**：`expectedTurnId` 必填）；`'idle'` **`yes` + `real-path`**（`wire`：厂商耐久队列 `thread/queue/*`，真机守卫量到「那句话进厂商出站请求体 + 那一轮跑完 + 答复成为候选 `finalText`」） | **两档 `yes`**（四家唯一有 real-path 观测的）：`'round'` 走**进程内插件**、`'idle'` 走 `wire` | `off-by-adapter`（`in-process-sdk`）：窄壳声明了 `steer` / `followUp`，但**适配器一格端口都没挂** |
| 撤回两档 | `by-id`：按我们自铸的 uuid 撤（控制请求 `cancel_async_message`——**不在 SDK 公开面**，`Query` 接口与 `.d.ts` 都没有 ⇒ 运行时探测） | `'round'` **`none`**（在途注入没有按身份收回的面，`turn/interrupt` 是无身份的全清）/ `'idle'` `by-id`（厂商的 `queuedSubmissionId`） | `by-id`：按我们铸的 `messageId`（经插件 `inbox.remove`） | **`flush-only`**：只有 `clearQueue()`，两档一起清 ⇒ 界面上不许出现「撤回这一条」 |
| 续接 | `yes`：`query({ resume: <session_id> })`，`session_id` 从 `system/init` 取 | `yes`：`thread/resume{ threadId }`，必填入参只有 `threadId`（与 cwd 无关） | **`yes` + `real-path`**（`wire`：官方 `session/resume`，adopt 必须在该 id 的第一条 `prompt` 之前；真机守卫量到「adopt 落在同一条会话上 + 第一轮的历史进了第二轮的入站请求体」，并且配一条不 resume 的阴性对照） | `yes`：进程内 SDK 的 `SessionManager.open(<会话文件>)` |
| 投递的证据档（`state` 说能不能做，`proofDriver` 说这句结论怎么证出来的） | `synthetic-fixture`：wire 级探针 + 假 SDK 夹具，只证到「我们把消息放进了那条车道」 | `synthetic-fixture`：真机读数只证到 wire 上**存在**那些方法 | **`real-path`**：真运行时 + 真插件 + 脚本式上游，判据是哨兵有没有进模型看到的那份请求体 | `synthetic-fixture`：假 SDK 夹具（适配器没挂端口） |

**结构化输出：通道不同，交付契约相同**。四家都只有两种收场——交出一段符合 `outputSchema` 的 JSON，或如实失败（不合格的答复不会被静默当成合格）。差别在**谁来保证形状**：cc / codex 由厂商按 schema 约束（原生字段）、pi 也由厂商侧强制但走**工具参数**这条通道、dsh 靠适配器内部的填充层（首轮提示词追加 schema 约束 + 骨架驱动的同会话修正轮）兜住——**保证强度不同**（dsh 追问两轮后仍可能不合格；pi 那一格还有条件性：`ToolChoice` 只有 `auto / none`，模型完全可以用一段正文回答）。`applied.structuredOutput` 是**每-run 的通道事实**、不是能力位：它回答「这一次走的是哪条路」，不回答「答复合格不合格」——走填充层也可能交出一份完全合格的 JSON 而这一格仍是 `false`。判据四家共用一份（`packages/server/agents/src/structured-output.ts`，一致性套件的 `structured-output` 组同源）。

**提问与应答面：四家全 `yes`，但通道分两档**。`vendor-tool` 是「模型看到的提问工具由厂商提供」（cc / codex / dsh：工具与**提示词**都归厂商），`host-tool` 是「我们注册的工具」（pi：提示词三格全是我们自己写的）——「什么时候该问」的约束来源不同，消费侧要能区分。四家的 `yes` 都拿**真路径**驱动器证出来（真 CLI / 真服务端 / 真运行时，只把**上游模型**脚本化），夹具扮演厂商那一端的临时档已不剩一家。两处共同边界：**「厂商自己到点收场」在挂了应答面的那一臂四家都不成立**（cc 的 `askUserQuestionTimeout` 缺省 `never`、codex 的 `autoResolutionMs` 恒 `null`、dsh 挂了应答面即回落阻塞档、pi 没有这一格）⇒ 契约里的 `auto-resolved` 目前没有产出方；**答案落点统一**——问题在消息账本 `tool-call` 一半、答案与收场在 `tool-result` 一半，两半按 `callId` 配对（见[《消息规范》](/protocols/message-spec)）。

**内置工具交集**（精确同名）：codex ∩ dsh = `create_goal` / `get_goal` / `update_goal`（codex 的 hosted `web_search` 在适配器这一侧**关掉**——开关是顶层 `web_search='disabled'`，候选内工具表因此不含它）；**pi 的默认四件与 dsh 的同名工具重名**（`read` / `bash` 在真机与夹具里有据可查）；claude 与另三家**精确同名交集为空**，四家忽略大小写同为空 ⇒ 命名不是对齐键，族映射按语义类别做。异名同义例：codex `exec_command` ↔ dsh `pwsh`；claude `Task` ↔ pi `Agent` 是同一工具两种叫法。工具表项数随模型与开关浮动（claude 实测 23–30、dsh 26、codex 10、pi 执行档 5 件 + `mcp__*` 通配、只读档 4 件），能力声明必须带前提。**别名要逐个登记**：真机这批数据里 dsh 跑命令用的是 `bash` 而不是表里原有的 `pwsh`（7 次调用全是 `bash`），漏登记不会报错、只会让摘要退化成紧凑 JSON 且族标签消失 ⇒ 别名由 `tool-family.test.ts` 逐字钉住。

**叙述性字段（「模型自己写的一句话」）四家不一致**（一手证据：官方 SDK 类型、`codex app-server generate-ts` 的生成物、DSH `tool-catalog` 与本地包 schema、pi 真机出站入参）：

| 家 | 有这一格的工具 | 逐字字段名 | 必填性 | 我们读得到吗 |
|---|---|---|---|---|
| cc | `Bash` | `description` | **可选**（CLI 侧另有 `getToolUseSummary` 兜底合成一句，但那**只在 CLI 的 UI 层、不走 wire**） | 读得到 |
| cc | `Agent`（旧名 `Task`）/ `Monitor` / `TaskCreate` | `description` | 必填 | 读得到 |
| dsh | `bash` / `pwsh` / `subagent` | `description` | **必填**（JSON Schema `required` + 运行期校验 `invalid description: expected a non-empty string`） | 读得到 |
| pi | `Agent`（派发工具，由第三方扩展提供） | `description` | 入参里带它（真机实测入参 `{prompt, description, subagent_type, run_in_background}`）；**内置四件没有这一格** | 读得到 |
| codex | `update_plan` | `explanation` | 可选 | **读不到**：`TurnPlanUpdatedNotification.explanation` 协议面上有（本机 0.156.1 生成物逐字），但本仓 `appserver/protocol.ts` 的窄声明未收 ⇒ `payload.note` 恒 `null`（未闭合，见 FAQ） |
| codex | `exec_command` | `justification` | 可选（**审批语义**） | **读不到**：`ThreadItem.commandExecution` 的字段里没有它（协议面就丢了） |
| codex | `command_execution` / `apply_patch` / `web_search` / `dynamicToolCall` / `collab_tool_call` | — | — | 协议里**真没有**这一格 |

依据：Claude `BashInput.description` 的官方注释逐字 *"the user reads this description, often without seeing the command"*（`sdk-tools.d.ts`）；DSH 同一格的说明逐字 "…(shown in the UI)"。**所以「优先 `description`」在 claude 与 dsh 上立刻兑现，在 pi 上只有派发工具那一件兑现得了（内置四件与 codex 一样一笔都兑现不了）**——codex 与 pi 的摘要只能走「族拼法」（`exec_command` 给命令原文、`apply_patch` 给改动清单、pi 的 `bash` 给命令原文）。这不是实现偷懒，是协议与通道的差异，横向对比时会被反复问到，故记在这里。

**skill 对照**（四家都无编程式注册，skill 只能以文件落盘；配置面、落点与判据的完整写法见[《技能配置》](/features/skills-config)与各家接入文章各自的「skills 接法」）：

| 维度 | Claude Code | Codex | DeepSeek Harness | Pi Coding Agent |
|---|---|---|---|---|
| 落点 | `<configHome>/skills/<名称>/SKILL.md`（`configHome` = `CLAUDE_CONFIG_DIR`） | 同形（`configHome` = `CODEX_HOME`） | 同形（`configHome` = `DSH_HOME`） | 同形（`configHome` = 候选配置目录） |
| 落位时序 | 无更紧要求（`query()` 之前写完即可） | **必须早于 spawn app-server** | **必须早于 `new DeepSeekHarness(...)`**（boot 点） | **必须早于 `createAgentSession()`**；写晚了这几家**静默无 skill 且无报错** |
| 发现根 | 项目 `<cwd>/.claude/skills/`、用户 `$CLAUDE_CONFIG_DIR/skills/`、插件 `plugins[]` | 六个（`$CODEX_HOME/skills` / `~/.agents/skills` / `.system` / `<repo>/.codex/skills` / 每层 `.agents/skills` / `/etc/codex/skills`），**同名不去重** | 三条加法（`$DSH_HOME/skills/` / overlay `customSkillDirs` / 项目根自动发现），skill 根表按 rank 定胜负 | 候选白名单 ∪ `cwd` 之下的项目技能（`skillsOverride` 过滤掉 HOME 锚定的发现结果） |
| 同行同名谁赢 | **本机赢**（`userSettings` > `projectSettings`） | 两条都进清单（不去重） | **仓库赢**（项目级 rank 100/200 压过我们的 400） | **仓库赢**（项目自动发现压过我们的 `configHome`）；个人档被我们过滤掉 |
| 厂商内置 | `built-in` 一批（不压） | `.system` 下 6 条，**每个候选首启自动物化**，与我们的条目同住一层 | bundled 一批（不压） | 未证实（`skillsOverride` 只留白名单 ∪ 项目技能，厂商内置若存在也被这一层过滤） |
| L3 判据通道 | `getContextUsage().skills.skillFrontmatter`（带厂商原值 `source`，无落点） | `skills/list`（带 `scope` 与落点 `path`） | `user/message` 的 `source.kind === 'skill-catalog'`（只有名字 ⇒ 来源只能记「未证实」） | 出站请求 payload 的技能段（`before_provider_request` 观察者取证，按两条 wire 各读一次） |
| 行为确证长什么样 | 发 `tool_use(name='Skill')`——**本机网关下拿不到**（模型一次都不发） | **这家没有 `Skill` 工具**：认它真去读 `SKILL.md` | 真发 `skill` 工具调用 | 认它真去读 `SKILL.md`（模型真读才算行为档） |
| 判据弱档（拿到名字 ≠ 模型能用它） | `system/init` 的 `skills` / `tools` 两格：厂商自报的名字表，**不反映允许列表**（挡得住工具调用、挡不住 `/<name>` 提示词派发）⇒ 假阳性 | `skills/list`（app-server 的请求；`enabled: false` 的条目**也列**）+ 入站 developer 段（只证明它进了提示词，答不了「清单里还有没有别的」） | `user/message` 的 `skill-catalog`：**只有名字**（没有来源、没有落点 ⇒ 分档只能记「来源未证实」） | 出站请求里的技能段只证明「清单进了提示词」，答不了「模型会不会照它做」 |

- 四家共同坑：**项目根自动发现是跨家口径的静默差异**（被测仓库自带的 skill 目录会被启用），且**同名冲突四家解法不同**——设置页那条 Alert 只写原则，点名归候选详情的「候选技能」格。
- 四家的候选内装入都用**文件级不放**这一个手段表达「停用」（没有任何一家有按名字关的配置键）；候选级结论三态（`installed` / `missing` / `unverified`）由同一份契约推导，`missing` ⇒ 该候选失败且不自动重试。

**MCP 接法对照**（四家注入落点与判据通道均已真机验证；配置面、逐字形状与完整边界见[《MCP 配置》](/features/mcp-config)）：

| 维度 | Claude Code | Codex | DeepSeek Harness | Pi Coding Agent |
|---|---|---|---|---|
| 注入通道 | SDK 参数 `Options.mcpServers`（不落 `<configHome>/.claude.json`） | **线程级** `config.mcp_servers`（随 `thread/start`；退路 `$CODEX_HOME/config.toml`） | per-launch overlay（`aieval-route.patch.yml`）的 `insert` 插件行 | **零文件**：自给 `loadConfig` 的内存对象（不落任何 `mcp.json`，被测仓库的 `.pi/mcp.json` 连读都读不到） |
| 传输名 | `stdio` / `http` | **无 `type`**（靠字段推断） | `stdio` / `streamable-http` | `stdio` / `http` |
| http 的头叫 | `headers` | **`http_headers`** | `headers` | `headers` |
| stdio 的 `cwd` | **没有这个字段** | 没有（继承 app-server 的 cwd） | 没有（继承 harness 的 cwd） | 没有（继承会话的 cwd） |
| 额外格 | — | `startup_timeout_sec`（本仓给 30 s） | `serverName` / `toolCallTimeoutMs` / `failOnStartupError`（默认 false） | `exposure`（每台**显式** `'direct'`）/ 首次 prompt 启动等待 10 s |
| 判据来源 | `system/init` 的 `mcp_servers[].status` **+ 工具表**（工具表更硬） | `mcpServer/startupStatus/updated`（带 `error` 原文） | **只有** `request/header` 的 `data.header.tools` | **只有**厂商工具表（出站 payload 的 `tools` 里出现 `mcp__<名>__*`） |
| 失败长什么样 | `status: 'failed'` | `startupStatus: 'failed'` + `error` | **静默**：工具消失、会话照常跑完、无结构化错误 | **静默**：工具消失、会话照常跑完、无结构化错误 |
| 判据到什么档 | 已连上（工具表里有 `mcp__<name>__`） | **只到「装上了」**——自定义网关下有 `unsupported call` 的上游缺口 | 已连上（表里有 `mcp__<serverName>__*`） | 已连上（表里有 `mcp__<名>__*`） |

- 工具名四家同形（`mcp__<server>__<tool>`），但**服务器名那一段的字符处理不同**：pi 与 codex 把非 `[A-Za-z0-9_]` 的字符改写成 `_`（`my-server` ⇒ `mcp__my_server__echo`），claude 与 dsh 原样保留（`mcp__my-server__echo`）⇒ 候选级判据两种形态都认（`@aieval/contracts` 的 `matchMcpToolName`，先精确、再回退）。**同名优先级只有 claude 实测过**（程序化注入赢、只留一条，`strictMcpConfig` 关闭 ⇒ 不压制仓库自带），codex / dsh / pi 三家**未证实**（pi 的 `.pi/mcp.json` 被零文件注入直接绕开，另外两家均无已知的项目级 MCP 自动发现）。
- 四家都把各自的厂商信号归一成同一条 `vendor-system` 事件并用 `mcpChannel` 自报通道（`vendor-status` / `vendor-startup-status` / `vendor-tool-table`），候选级观测格（`EvalCandidate.mcpServers`）据此给出 `connected` / `unavailable` / `unverified` / `skipped` 四档结论；**`unverified` 不许写成「已连上」，也不许写成「没有」**。
- ⚠️ **账本里的 MCP 工具名两家不同形**（真机对照臂：同一台本机 stdio MCP server、同一次调用）：
  **cc** 落 `mcp__armprobe__probe_echo`，**codex** 落 `armprobe.probe_echo`——codex 真机走的是独立
  item 变体 `mcpToolCall`（`{server, tool, arguments, result, error, durationMs}`），账本名由
  `mcpDrafts` 拼成 `<server>.<tool>`，`family` 恒 `null`、界面走通用渲染并保留原名。
  ⇒ **按 `mcp__…__…` 前缀做的跨家统计会漏掉 codex**。上面那条「四家同形」讲的是**厂商工具表里
  的名字**（判「那台服务器在不在表里」用），**不是**账本名——两者不是同一件事。
- 四家都把候选内首次下载的成本留给了行：playwright MCP 首次 **17.2 s / 61 MB**（宿主 registry 是公网时）⇒ 等待预算 ≥ 20 s，缓解手段（候选内 `.npmrc` 只写宿主 registry 那一行）四家共用同一处实现。
- pi 的 `exposure` 档位与判据**绑定**：缺省档 `codemode` 下工具只可调用、不声明，模型侧看不到 ⇒ 观测格那条判据永不触发，故值域在类型上收成 `'direct'`。

## 数据与契约

- **用量合计口径四家不同源**：claude 从 `result.usage`（跑动期按同 `message.id` 后到覆盖求和作估算）；codex 只从 `thread/tokenUsage/updated` 通知累计（全树合计，任一子线程缺 ⇒ 两分量同时 null）；dsh 事件投影不按会话分流（用量步数含子智能体是构造上如此，分量按候选内白名单求和）；pi 从助手 `message_end.message.usage` 逐次往返累加，合计**含**子智能体那一份（主子自己的读数与子会话的读数覆盖面不相交，两份相加才是「这个候选一共花了多少」）。
- **思考正文**：claude `thinking` 块（含 signature）；codex `reasoning.content[]` 快照 + `textDelta` 增量（`exec --json` 恒 0 条别再用）；dsh `assistant/message` 整块；pi 助手消息的 `thinking` 块（`redacted === true` 或正文为空时不落正文）。空文本一律记 `text: null` + `textKind: 'none'`（不回落 summary）——**codex 是唯一有两块的例外**：它的全文（`content[]`）与摘要（`summary[]`）分开成块，`content[]` 空而 `summary[]` 有时产的是 `textKind: 'summary'` 的块、**没有 `none` 块**。
- **子任务身份**：四家都是厂商原生 id（claude 任务 id / codex 线程 id / dsh 子会话 id / pi 扩展的 `agentId`）；`parentCallId` 是消息与子任务记录之间唯一的桥——**dsh 恒 `null`**（载荷里没有可对齐的调用 id，不猜）；pi 有它（`Agent` 工具调用的 `toolCallId`，认领靠「总线描述与在飞派发逐字相同且唯一」），子任务行与子会话消息两处都带。
- **人工消息面（第五组 `turnInjection`）的取值快照**：投递两档——dsh 两档 `yes`（real-path）、codex `'idle'` `yes`（real-path）+ `'round'` `unverified`、cc 两档 `unverified`、pi `off-by-adapter`；撤回——cc / dsh `by-id`、codex `'round'` `none` + `'idle'` `by-id`、pi `flush-only`；续接——四家都 `yes`（dsh 那一格的正向证据走真路径）。逐格取值、通道与理由的**真源是各家的 `metadata.turnInjection`**（投影网在 `packages/server/agents/src/registry.test.ts`），本表只是横向快照。成文规矩是**声明不许先于夹具**：哪家接通，该格声明与那个能造出该事实的场景**同一次提交**进来；守卫按三格（`delivery.round` / `delivery.idle` / `resume`）逐格判四件事（声明自身合规、每格都要有证明安排、夹具登记的驱动器档位与声明**逐字相同**、`yes` ⇒ 真路径**且**观察到成立），落在 `providers/conformance/kit.ts` 的 `checkTurnInjectionNailing`；驱动器**真伪**另由 `providers/conformance/onboarding.test.ts` 静态核对（登记的驱动器在盘上、没有假厂商记号、真的走了产品那条造客户端的路）。

## 状态机与时序

四家收尾取数路径：claude 读 CLI 落盘转录（子智能体用量唯一权威源，只在收尾一次）；codex 收尾 `thread/list{ancestorThreadId}` + 逐线程 `thread/read`（不带 `includeTurns`）/`thread/turns/list`（必须在 `finalize` 前落定）；dsh 无收尾取数（读数都在通知流里）；pi 也无收尾取数（读数都在事件流里），收尾只把子智能体的终态快照折进合计。共同铁则：**「等一个终态再取数」先问这是哪条线程 / 哪个会话的终态**。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| 工具表 / 能力**随模型名与路由翻转**（`spawn_agent` 在 DeepSeek 路由跑通、内网网关 `unsupported call`） | 能力声明必须带前提；对比表数字标注「一次实测快照」 |
| effort 档位强度的效力四家都未证实（同档抖动不小于档间差） | 只展示「我们要求的档位」 |
| 跨家比较步数先核对口径（`roundTrip` 四家合成方法不同） | 「同口径可比」+ `source` 标注，不是「跨四家可比」 |
| pi 的结构化输出走工具通道 ⇒ 这个候选的工具表比另三家多一件（`submit_result`） | 跨家可比性的已知解释变量，登记而不隐藏（不启用 `codemode` / `tool_search` 是同一条口径） |
| **人工消息面的投递两档只有两家拿 real-path 证过**：dsh 两档 `yes`、codex `'idle'` `yes`（真机守卫量到那句话进厂商出站请求体）；codex `'round'`、cc 两档是 `unverified`（通道与接线都在，缺厂商侧投递点的端到端观测），pi 是 `off-by-adapter`（适配器一格端口都没挂） | 界面按声明置灰并**说清是哪一种「不能」**（`unverified` 说的是「还不能用：没验证过」，不是「投不进去」）；`state: yes` 才配 `real-path`——**别把「接线了」读成「投得进去」**。逐格理由在各自接入篇的《注入与续接》 |

## 相关链接

- 知识文章：[《Claude Code 接入》](/protocols/cc)、[《Codex 接入》](/protocols/codex)、[《DeepSeek Harness 接入》](/protocols/dsh)、[《Pi Coding Agent 接入》](/protocols/pi)（字段级细节）、[《MCP 配置》](/features/mcp-config)（四家 MCP 接法的配置面与失败判据）、[《技能配置》](/features/skills-config)（四家 skills 接法的配置面与三态判据）、[《消息规范》](/protocols/message-spec)（归一契约）、[《进程生命周期》](/protocols/process-lifecycle)、[《Provider 抽象与 run 入口》](/protocols/provider-run)
- 活文档：四份厂商 FAQ（[Codex](/faq/codex) / [Claude Code](/faq/claude-code) / [DeepSeek Harness](/faq/deepseek-harness) / [Pi Coding Agent](/faq/pi)）——按报错原文 grep
