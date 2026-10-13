# Pi Coding Agent FAQ

pi（`@earendil-works/pi-coding-agent`）在**真实运行环境**里踩过的坑。每条四格：现象做小标题、日期、根因、解决方案；有外部资料就补第五格。

规矩：现象用**日志/界面里的原文**做标题（改写过的描述搜不到）；只写已证实的根因；同一现象只留一条最新的，与事实冲突时改旧条目不新开。

---

## `mcp__<服务器>__<工具>` 握手成功却不在出站请求的 `tools` 里（SDK 注释原文：`MCP tools kept registered without being named stay inactive`）

**日期**：2026-10-12

**现象**：真包 + 本地假网关 + **真 stdio MCP 服务器**跑一轮：握手全走完（服务器进程起来了、`initialize` 也回了），但首个出站请求体里 `payload.tools` 只有那四件默认工具，一个 `mcp__*` 都没有；`vendor-system` 那一格同样没有 MCP 工具。**全程不报错**——不抛、不 WARN，会话照常跑完。SDK 自己的注释逐字写着这件事（`dist/core/agent-session.js` 的 `_refreshToolRegistry`）：

```text
// Naming or matching a tool activates it even when it is not active by default. MCP tools
// kept registered without being named stay inactive.
```

**根因**：**「注册成功」与「声明给模型」被拆开，而两处口径不一致**。装配会话时交的是**裸名单** `['read','bash','edit','write']`：

- `dist/core/sdk.js`：`tools` 里**不带** `+`/`-` 修饰符时 `allowedToolNames = options.tools`，整份名单当白名单用；
- `dist/core/agent-session.js` 的 `_refreshToolRegistry`：`allowedTools` 有值时**只激活** `allowedTools(name) === true` 的工具 ⇒ `mcp__<服务器>__<工具>` 被判掉，永远进不了 `payload.tools`；
- **同一个文件**的 `_isAllowedTool` 却对 MCP 名字**有豁免**（`return !this._allowlistFiltersMcp && isMcpToolName(name)`）——注册表那一侧认它合法，激活那一侧不认。

于是「工具注册了」与「工具被声明给模型」是两件事，中间的差集**没有任何报错**。MCP 的服务器名与工具名由服务器自己定、连接之后才拿得到 ⇒ 我们装配会话时枚举不出来，这处不一致恰好落在唯一够不着的那一格上。

**解决方案**：`packages/server/agents/src/permission.ts` 的两档白名单改成**成员名单 + MCP 通配**——`PI_PERMISSION_OPTIONS` 的 full 档 `['read','bash','edit','write', …子智能体扩展那三件]`、read-only 档 `['read','grep','find','ls']`，装配时两档再各拼一格 `PI_MCP_TOOL_PATTERN = 'mcp__*'` 进 `createAgentSession({ tools })`。

**为什么不是修饰符形态**（两条都试过、都否决）：

- **纯修饰符名单会让白名单整个失效**——`dist/core/sdk.js` 里 `toolModifiers` 有值时 `allowedToolNames` 落 `undefined` ⇒ 之后任何注册进会话的工具都会进模型可见的工具表，那是「只留这些」的反面；
- **`+name` 的语义是「加进默认集」而不是「只留这些」**——pi 的默认集固定是 `read` / `bash` / `edit` / `write`，只读档若写成 `+read,+grep,+find,+ls`，默认集里的 `bash` / `edit` / `write` **仍然在** ⇒ 静默的权限放宽，比「名单少了一格」更坏。

判据：`packages/server/agents/src/providers/pi/allowlist.test.ts` 的两条用例——「full 档：默认四件 + MCP 工具都在请求里」「read-only 档：四件只读工具 + MCP 工具在，写能力可证不在」。**走真 SDK**（真包 + 假网关 + 真 stdio MCP 服务器），判的是**出站请求体**而不是我们传了什么参数。两条变异都见过红：① 白名单改回裸名单 ⇒ 两条用例红（`payload.tools` 里没有 `mcp__*`）；② 只读档改成 `+` 加集形式 ⇒ 红（`bash` / `edit` / `write` 出现在请求里）。

**⚠️ 这条最值钱的教训：判据落在「我们传了什么」上，差集永远测不到**。原先覆盖这一格的 `injection.test.ts` 用例走**假 SDK + 手搓 `requestPayloads`**，从未经过真 SDK 的白名单交互 ⇒ **产品坏掉它照样绿**——测试环境里没有那个成员匹配器，运行环境里才有。

**相关资料**：`@earendil-works/pi-coding-agent` 的 `dist/core/sdk.js`（修饰符语义与 `allowedToolNames` 的三种落法）、`dist/core/agent-session.js`（`_refreshToolRegistry` 与 `_isAllowedTool` 两处口径）。

---

## `This extension ctx is stale after session replacement or reload.`（后台档子智能体活过本行时，完成回调打旧 ctx ⇒ 未处理的 Promise 拒绝）

**日期**：2026-10-13

**现象**：`Agent` 工具派出的子智能体活过了本行。行已收尾、会话已释放之后，扩展的完成回调仍拿着装载时的旧 `ctx` 去发总线事件，抛出上面那句原文（厂商在 `dist/core/extensions/runner.js` 里的逐字文案是 `This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().`）；而且**没有人 catch 那条 promise** ⇒ 表现为一次**未处理拒绝**，长驻服务下会掀进程，测试里只是多一条 unhandled rejection、用例本身照样可能绿。同一时刻本行的子任务分量整格记 `null` 并落一条点名 WARN。

**根因**：机制层是三个事实叠在一起：

1. `@tintinweb/pi-subagents` 的 `Agent` 工具 **`run_in_background` 缺省 `true`**——不给参数就是后台档，工具立刻返回一个 ID，子智能体与父会话解耦；
2. 扩展的完成回调**捕获**了装载期的 `ctx`，而 pi 的 `runner` 在会话替换 / `reload()` 之后把旧 `ctx` 判为失效并**主动抛错**——那是厂商侧有意的守卫，不是厂商缺陷；
3. 回调那条 promise 链**没有终止 catch**，于是守卫抛出的错误升级成进程级未处理拒绝。

**解决方案**：**未闭合**（第三方缺陷，修在扩展侧——完成回调要么改从 `withSession` 拿新 `ctx`，要么自己 catch 并降级成一条日志）。当前处置是**如实登记、不掩盖**：后台档的子智能体活过本行时，`subagentTokens` / `subagentTurns` 两格记 `null`（**不填 0**）+ 一条点名 WARN，合计退回主会话口径。代价两层：默认路径下（模型不显式给 `run_in_background: false`）子智能体的用量与轮次拿不到，而它是真的花了；服务进程多一次未处理拒绝的风险面。复现判据：真机跑一轮让模型派后台子智能体，看收尾后的 stderr（未处理拒绝）与行上那两格 WARN。

---

## 子智能体转写固定落 `os.tmpdir()/pi-subagents-<uid>/…`（不随行隔离）

**日期**：2026-10-13

**现象**：并发跑两条 pi 行，两行的子智能体转写都写进**同一个**共享目录 `os.tmpdir()/pi-subagents-<uid>/`。行级隔离（每行独占 `.agenthome`）在这一格上不成立。

**根因**：机制层是**路径来源没有注入面**——扩展内部用 `os.tmpdir()` 加 uid 自己拼目录，不接受宿主传入的行级目录；而 SDK 的 `getAgentDir()` 是**进程级**那一格（只认 `PI_CODING_AGENT_DIR` 与 `~/.pi/agent`），`createAgentSession({ agentDir })` 只管会话自己的 settings / memory，管不到扩展的这一格。⇒ 只要同一个宿主进程里并发跑两行，这一格必然共享。

**解决方案**：**未闭合**（第三方缺陷，修在扩展侧——接受一个宿主给的转写根）。当前处置是登记并接受代价：子智能体的转写**不作为本行产物**、不进 `diff`、不进评分；行与行在这一格上不隔离，排障时按 `pi-subagents-<uid>` 这个共享目录读，别当成某一行的私有产物。⚠️ 附带影响：这个目录的清理**不属于本行的释放序列**（我们删的是 `.agenthome`），它会跨行攒着。

---

## 只跑一次 `pi --help`，真实家目录长出 `~/.pi/agent/auth.json` 与 `~/.pi/agent/models-store.json`

**日期**：2026-10-13

**现象**：探针只想读一下 CLI 的帮助文本（`pi --help`，本意是只读），跑完发现**真实家目录**被写了：`~/.pi/agent/auth.json`、`~/.pi/agent/models-store.json`。测试与探针的隔离假设（「配置一律落临时目录」）在这一格上不成立。

**根因**：**与「子会话目录不可注入」同根因**——pi 的**全局路径**只认 `PI_CODING_AGENT_DIR` 与 `~/.pi/agent` 两个来源。`createAgentSession({ agentDir })` 是**每会话**那一格，既管不到 pi 自己的 CLI 启动路径，也管不到扩展；CLI 一启动就按全局路径建目录并写 `auth.json` / `models-store.json`（哪怕只是 `--help`）。

**解决方案**：**能改的只有我们自己这一侧**——凡是要起 pi 的 CLI 或它的扩展的地方（探针、脚本、测试），**先把 `PI_CODING_AGENT_DIR` 指到临时目录**再动手；它同时也是子智能体会话目录的**唯一**开关（`packages/server/agents/src/providers/pi/conformance.test.ts` 的 `subagent` 场景就靠它隔离）。产品侧不需要改：适配器是 in-process，不 spawn pi 的 CLI，也不写 `process.env`——这条只影响「本仓自己在真机上起 pi CLI 或扩展」的那类动作。
⚠️ 反过来说：**任何声称「隔离了 pi」的测试，如果只设了 `agentDir` 而没设 `PI_CODING_AGENT_DIR`，它就没有隔离**——子会话与扩展照样写真实家目录。

---

## 思考正文重复 5 段（同一段推理在执行日志的思考块里出现 5 次）

**日期**：2026-10-13

**现象**：真机一轮跑完，执行日志里那条思考块把**同一段正文渲染了 5 遍**（界面对话视图里也是 5 段并排）。

**根因**：**未定位**。已核到的边界只到下沿一层：**厂商载荷层 `raw.message.content` 里那个块本身就是 5 段**——不是我们数错，也不是界面重复渲染（适配器按块拼接、界面照实渲染，两处都无辜）。问题因此在更上游（厂商 SDK 组消息，或网关返回的 `content` 数组本身），机制未定性。

**下一步**（要一次带真网关的最小复现）：把同一轮的 `raw.message.content` **逐字 dump** 出来，比对「一次请求返回的 `content` 数组长度与各块 `type`」与「我们读到的段数」。若厂商侧确实发了 5 个同文本块，则往上追是 SDK 组包还是网关重复；若只有一个块而我们有 5 段，那才轮到适配器这一层。**拿到这份 dump 之前不写「可能」当结论**。

**解决方案**：**未闭合**（未定位 ⇒ 无处置）。当前行为是**如实渲染**：不去重、不合并——按文本去重会把「模型真的重复思考了同一段」也一起吃掉，那比多显示 4 段更坏。落点：`packages/server/agents/src/providers/pi/message.ts` 的 `piThinkingBlocks`（每个 `thinking` 块一条思考块，空块与 `redacted` 块不发）。

---

## `MCP「my-server」未能启动：工具表里没有它的工具（这一家起不来时不投结构化错误）`（行落 `failed` + `AGENT_MCP_UNAVAILABLE`，而那一台的工具就在出站请求里）

**日期**：2026-10-13

**现象**：配置里那台 MCP 服务器叫 **`my-server`**（带连字符，名字正则本来就允许），真包 + 假网关 + 真 stdio 服务器跑一轮：出站请求体里明明有 `mcp__my_server__echo`，模型侧调得动，但这一行以 **`AGENT_MCP_UNAVAILABLE`** 收场，文案逐字是 ``MCP「my-server」未能启动：工具表里没有它的工具（这一家起不来时不投结构化错误）``——引擎里没有的这台，观测格却记 `{"name":"my-server","judgedBy":"vendor-tool-table","verdict":"unavailable"}`。

**根因**：**「我们配置的名字」与「厂商工具表里的名字」不是同一个字符串，而判据拿原始名拼精确前缀**。pi 的 `createMcpToolName` 对**整条**工具名做 `replace(/[^A-Za-z0-9_]/g, "_")`（`dist/extensions/mcp/tools.js`；厂商 CHANGELOG 记的修复原文是 *Like in Codex … `mcp__my-server__x` is now `mcp__my_server__x`*）⇒ `server` 段里的 `-` 照样变 `_`。行级判据当时用 `` `mcp__${serverName}__` `` 精确前缀 ⇒ 判「表里没有它」，而 `vendor-tool-table` 通道下这一档**就是整行失败**（不是「未验证」）。**测试环境 ≠ 运行环境**：单测喂的工具表是**原样保留**形态（`mcp__my-server__echo`，那正是 cc / dsh 的形态），与 pi / codex 的真实形态差一个字符 ⇒ 单测全绿、真机红。

**解决方案**：判据换成共享匹配器 `matchMcpToolName`（`packages/server/contracts/src/mcp-tool-name.ts`）：**先精确、再回退到归一化形态**，`row-mcp.ts` 与 pi 的一致性套件共用同一份。撞名（`my-server` 与 `my_server` 归一化后同形）时那一批工具**归不到**具体哪一台 ⇒ 那几台记 `unverified` + 一句说明（`RowMcpServer.note`，抽屉里画在自己那行后面），**不判失败**、也不互相记账。判据：`row-mcp.test.ts`（带连字符判 `connected`、撞名不判失败）与 `mcp-tool-name.test.ts`（精确优先、前缀必须整段）。两条变异都见过红：① 匹配改回原始名精确前缀 ⇒ `my-server` 那条用例红；② 无条件两边都 sanitize ⇒ 撞名那条用例红。

**相关资料**：`@earendil-works/pi-coding-agent` 的 `dist/extensions/mcp/tools.js`（`createMcpToolName` 的整条 `replace`）、`dist/core/mcp-servers.js`（`mcpNamespace()` 的 `-` ⇒ `_`）。

---

## 「这个子任务没有逐条对话记录」（pi 行的子任务节点点进去是空的：子会话的步骤不在父会话的事件流里）

**日期**：2026-10-13

**现象**：pi 行派发过子智能体、子任务行有终态与用量，但界面上点进那个子任务节点只有一句**「这个子任务没有逐条对话记录」**——它自己那几十步（读文件、跑命令、思考）一条都看不到。产物一侧的形状：`messages.jsonl` 里带非空 `subagentId` 的消息**一条都没有**（只有主会话消息 + 两条 `subagent` 记录）。

**根因**：**子会话是另一个 pi 会话**（`@tintinweb/pi-subagents` 在同一进程里另起一个），它的事件**不进父会话的 `session.subscribe` 流** ⇒ 投影层从来没有机会给任何消息挂 `subagentId`。而界面按 `message.subagentId` 把消息分给会话节点、按 `message.roundTrip` 给每个节点分轮（`build-model.ts`）⇒ 那个节点**零轮次**，只能渲染成空态。三条排查要点：① 缺的是**消息**不是日志——`log` 事件在契约里根本没有 `subagentId` 这一格，界面也不把 `log` 折进时间轴，**拿日志事件找归属是找错了地方**；② `AgentMessage.turn` 是**厂商轮号**（`z.number().nullable()`，pi 没有 ⇒ 恒 `null` 是正确值），**不是**归属键，别拿它当「有没有对齐」的判据；③ 另外两条候选通道都取不到正文——扩展事件总线除 `subagents:started/completed/failed` 外只有身份与元数据频道，`Agent` 工具的 `tool_execution_update` 载荷只有一行 spinner 活动文案（按帧动画频率刷）。

**解决方案**：读扩展自己写的**逐 agent 转写文件**（`@tintinweb/pi-subagents` 的 `output-file.ts`，默认开：`<tmpdir>/pi-subagents-<uid>/<cwd 编码>/<会话 id>/tasks/<子任务 id>.output`，JSONL，`turn_end` 时 flush）。落点是骨架的**收尾接缝**（与 codex 读 `rollout-*.jsonl` 同一格），实现见 `packages/server/agents/src/providers/pi/transcript.ts`：正文复用既有的助手 / 工具结果归一（转写的 `message` 与 `message_end.message` 同构），逐条盖上 `subagentId` 与 `source: 'session-file'`，轮次按**该子会话自己**的模型往返序从 1 起（与 claude 的 `roundTripOfSession` 同一条口径——共用一个计数器会让几十条消息全挤进一个轮次行）。路径由**本行的 `cwd` 与本会话的 `sessionId`** 拼出，**不扫目录**（转写根是全机共享的，扫目录会让并发的两行互相认领对方的子任务）；读不到**不失败**，如实落一条点名 WARN（子任务节点为空即这条边界）。判据：`transcript.test.ts`（路径公式、轮次与 `subagentId` 挂载、坏行与半截末行、上限截断、文件缺失）与 `events.test.ts`（收尾搬运正文、缺失时不改结论）。三条变异都见过红：① 去掉投影 ⇒ `transcript.test.ts` 9 条红；①b 收尾不搬运正文 ⇒「收尾把子会话转写折成子任务的消息」红；② 去掉 `subagentId` 挂载 ⇒「逐条带 subagentId」与「文件在时读得到」红；③ 去掉子任务行去重 ⇒「同身份同内容只出一条」红。

**已知边界**：正文**只在收尾取到**（不随流实时增量——转写按 `turn_end` flush，没有文件监听的接缝）；扩展关掉转写（`output_transcript`）或换成不写转写的版本时，子任务节点回到空态并留一条 WARN。

**相关资料**：`@tintinweb/pi-subagents` 的 `src/output-file.ts`（`encodeCwd` / `sessionTaskDir` / `streamToOutputFile`）与 `src/index.ts` 的 `createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId())`。
