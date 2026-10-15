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

判据：`packages/server/agents/src/providers/pi/allowlist.test.ts` 的两条用例——「full 档：默认四件 + MCP 工具都在请求里」「read-only 档：四件只读工具 + MCP 工具在，**内置**写能力（`bash` / `edit` / `write`）可证不在」。⚠️ 只读档**不给** `mcp__*` 通配（通配只进全权限档）：真机曾读到只读档出站表里有 `mcp__ws__write_file` 且模型真写成功，收紧后同一台 MCP 服务器在只读档一件工具都不出现。**走真 SDK**（真包 + 假网关 + 真 stdio MCP 服务器），判的是**出站请求体**而不是我们传了什么参数。两条变异都见过红：① 白名单改回裸名单 ⇒ 两条用例红（`payload.tools` 里没有 `mcp__*`）；② 只读档改成 `+` 加集形式 ⇒ 红（`bash` / `edit` / `write` 出现在请求里）。

**⚠️ 这条最值钱的教训：判据落在「我们传了什么」上，差集永远测不到**。原先覆盖这一格的 `injection.test.ts` 用例走**假 SDK + 手搓 `requestPayloads`**，从未经过真 SDK 的白名单交互 ⇒ **产品坏掉它照样绿**——测试环境里没有那个成员匹配器，运行环境里才有。

**相关资料**：`@earendil-works/pi-coding-agent` 的 `dist/core/sdk.js`（修饰符语义与 `allowedToolNames` 的三种落法）、`dist/core/agent-session.js`（`_refreshToolRegistry` 与 `_isAllowedTool` 两处口径）。

---

## `This extension ctx is stale after session replacement or reload.`（后台档子智能体活过本行时，完成回调打旧 ctx ⇒ 未处理的 Promise 拒绝）

**日期**：2026-10-13

**现象**：`Agent` 工具派出的子智能体活过了本行。行已收尾、会话已释放之后，扩展的完成回调仍拿着装载时的旧 `ctx` 去发总线事件，抛出上面那句原文（厂商在 `dist/core/extensions/runner.js` 里的逐字文案是 `This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().`）；而且**没有人 catch 那条 promise** ⇒ 表现为一次**未处理拒绝**，长驻服务下会掀进程，测试里只是多一条 unhandled rejection、用例本身照样可能绿。同一时刻本行的子任务分量按格记 `null` 并落一条点名 WARN。

**根因**：机制层是三个事实叠在一起：

1. `@tintinweb/pi-subagents` 的 `Agent` 工具 **`run_in_background` 缺省 `true`**——不给参数就是后台档，工具立刻返回一个 ID，子智能体与父会话解耦；
2. 扩展的完成回调**捕获**了装载期的 `ctx`，而 pi 的 `runner` 在会话替换 / `reload()` 之后把旧 `ctx` 判为失效并**主动抛错**——那是厂商侧有意的守卫，不是厂商缺陷；
3. 回调那条 promise 链**没有终止 catch**，于是守卫抛出的错误升级成进程级未处理拒绝。

**解决方案**：**未闭合**（第三方缺陷，修在扩展侧——完成回调要么改从 `withSession` 拿新 `ctx`，要么自己 catch 并降级成一条日志）。当前处置是**如实登记、不掩盖**：子智能体若在本行收尾那一刻还没收场，`subagentTokens` / `subagentTurns` 两格都记 `null`（**不填 0**）+ 一条点名 WARN，合计退回主会话口径。两格**各自判完整性**：用量那一格来自总线终态载荷（`subagents:completed` / `failed` 的 `usage`，读得到就照交），轮次那一格只在 `Agent` 工具结果的 `details.turnCount` 里，而**后台档工具派发即返回、总线终态载荷里没有这一格** ⇒ 后台档结构上拿不到轮次（记 `null` 并点名「后台档：…总线终态载荷里不带 turnCount」，用量不受它连坐）。代价两层：默认路径下（模型不显式给 `run_in_background: false`）轮次那一格拿不到，而子智能体确实跑了几轮；服务进程多一次未处理拒绝的风险面。复现判据：真机跑一轮让模型派后台子智能体，看收尾后的 stderr（未处理拒绝）与行上那条 WARN 原文；两条 wire 下分量各自的可读性见 `providers/pi/events.test.ts` 的后台档用例。

**同一现象的第二半（已闭合）——那一格状态被降级成 `unknown`**：后台档下总线只报得起一条 `subagents:started`，而它**没有** `status` 字段；收尾对账读的正是那条记录，于是派发时已经投出去的 `running` 行被覆盖成 `unknown`——与「从终态退回运行中」同类的倒退，只是方向相反（把「已知在跑」说成「不知道」）。修在收尾那一侧：`Agent` 工具收尾快照里的状态（后台档是 `background`）记进派发记录，收尾快照**沿用**它（两处都没有才是真的没采集）。同一批还把那条 WARN 的措辞补成能自己解释的形态——``agent-1（派发即分离、活过了本行：收尾那一刻的状态是 background）``，而不是一句要用户猜的「还没收场」。判据：`providers/pi/events.test.ts` 的「后台档（总线只报 started）⇒ 收尾快照沿用派发那一刻的状态，不降级成 unknown」；变异验证：把 `rawStatus: event?.rawStatus ?? dispatch?.rawStatus ?? null` 改回只读总线 ⇒ 该用例见红（收尾多投一条内容不同的行）。

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

**解决方案**：**能改的只有我们自己这一侧**——凡是要起 pi 的 CLI 或它的扩展的地方（探针、脚本、测试），**先把 `PI_CODING_AGENT_DIR` 与 `PI_CODING_AGENT_SESSION_DIR` 都指到临时目录**再动手；子智能体的**会话落盘目录**那一格实际由后者决定（扩展先读它、再退回前者），只设前者时子会话仍会落到 `~/.pi` 下（`packages/server/agents/src/providers/pi/conformance.test.ts` 的 `subagent` 场景就靠它隔离）。产品侧不需要改：适配器是 in-process，不 spawn pi 的 CLI，也不写 `process.env`——这条只影响「本仓自己在真机上起 pi CLI 或扩展」的那类动作。
⚠️ 反过来说：**任何声称「隔离了 pi」的测试，如果只设了 `agentDir` 而没设 `PI_CODING_AGENT_DIR`，它就没有隔离**——子会话与扩展照样写真实家目录。

---

## 思考正文重复 5 段（同一段推理在执行日志的思考块里出现 5 次）

**日期**：2026-10-13

**现象**：真机一轮跑完，执行日志里那条思考块把**同一段正文渲染了 5 遍**（界面对话视图里也是 5 段并排）。

**根因**：**未定位**。已核到的边界只到下沿一层：**厂商载荷层 `raw.message.content` 里那个块本身就是 5 段**——不是我们数错，也不是界面重复渲染（适配器按块拼接、界面照实渲染，两处都无辜）。问题因此在更上游（厂商 SDK 组消息，或网关返回的 `content` 数组本身），机制未定性。

**下一步**（要一次带真网关的最小复现）：把同一轮的 `raw.message.content` **逐字 dump** 出来，比对「一次请求返回的 `content` 数组长度与各块 `type`」与「我们读到的段数」。若厂商侧确实发了 5 个同文本块，则往上追是 SDK 组包还是网关重复；若只有一个块而我们有 5 段，那才轮到适配器这一层。**拿到这份 dump 之前不写「可能」当结论**。

**解决方案**：**未闭合**（未定位 ⇒ 无处置）。当前行为是**如实渲染**：不去重、不合并——按文本去重会把「模型真的重复思考了同一段」也一起吃掉，那比多显示 4 段更坏。落点：`packages/server/agents/src/providers/pi/message.ts` 的助手消息归一（每个 `thinking` 块一条思考块，空块与 `redacted` 块不发）。

---

## `MCP「my-server」未能启动：工具表里没有它的工具（这一家起不来时不投结构化错误）`（行落 `failed` + `AGENT_MCP_UNAVAILABLE`，而那一台的工具就在出站请求里）

**日期**：2026-10-13

**现象**：配置里那台 MCP 服务器叫 **`my-server`**（带连字符，名字正则本来就允许），真包 + 假网关 + 真 stdio 服务器跑一轮：出站请求体里明明有 `mcp__my_server__echo`，模型侧调得动，但这一行以 **`AGENT_MCP_UNAVAILABLE`** 收场，文案逐字是 ``MCP「my-server」未能启动：工具表里没有它的工具（这一家起不来时不投结构化错误）``——引擎里没有的这台，观测格却记 `{"name":"my-server","judgedBy":"vendor-tool-table","verdict":"unavailable"}`。

**根因**：**「我们配置的名字」与「厂商工具表里的名字」不是同一个字符串，而判据拿原始名拼精确前缀**。pi 的 `createMcpToolName` 对**整条**工具名做 `replace(/[^A-Za-z0-9_]/g, "_")`（`dist/extensions/mcp/tools.js`；厂商 CHANGELOG 记的修复原文是 *Like in Codex … `mcp__my-server__x` is now `mcp__my_server__x`*）⇒ `server` 段里的 `-` 照样变 `_`。行级判据当时用 `` `mcp__${serverName}__` `` 精确前缀 ⇒ 判「表里没有它」，而 `vendor-tool-table` 通道下这一档**就是整行失败**（不是「未验证」）。**测试环境 ≠ 运行环境**：单测喂的工具表是**原样保留**形态（`mcp__my-server__echo`，那正是 cc / dsh 的形态），与 pi / codex 的真实形态差一个字符 ⇒ 单测全绿、真机红。

**解决方案**：判据换成共享匹配器 `matchMcpToolName`（`packages/server/contracts/src/mcp-tool-name.ts`）：**先精确、再回退到归一化形态**，`row-mcp.ts` 与 pi 的一致性套件共用同一份。撞名（`my-server` 与 `my_server` 归一化后同形）时那一批工具**归不到**具体哪一台 ⇒ 那几台记 `unverified` + 一句说明（`RowMcpServer.note`，抽屉里画在自己那行后面），**不判失败**、也不互相记账。判据：`row-mcp.test.ts`（带连字符判 `connected`、撞名不判失败）与 `mcp-tool-name.test.ts`（精确优先、前缀必须整段）。两条变异都见过红：① 匹配改回原始名精确前缀 ⇒ `my-server` 那条用例红；② 无条件两边都 sanitize ⇒ 撞名那条用例红。

**相关资料**：`@earendil-works/pi-coding-agent` 的 `dist/extensions/mcp/tools.js`（`createMcpToolName` 的整条 `replace`）、`dist/core/mcp-servers.js`（`mcpNamespace()` 的 `-` ⇒ `_`）。

---

## `MCP「X Y」未能启动：工具表里没有它的工具`（条目的 `headers` 键名不合法，却被读成「厂商起不来」）

**日期**：2026-10-16

**现象**：http 服务器配了 `headers: { "X Y": "v" }`（带空格的键）。真机读数三层对不上：契约层 `resolveMcpServers.injectable` **含这一台**，pi 适配器层 `toPiMcpServers` 把它摘进 `dropped`（理由 `headers 的键 "X Y" 不合法`），而行级观测格记 `{"name":"…","judgedBy":"vendor-tool-table","verdict":"unavailable"}` ⇒ 整行以 **`AGENT_MCP_UNAVAILABLE`** 收场，文案逐字是 ``MCP「X Y」未能启动：工具表里没有它的工具（这一家起不来时不投结构化错误）``。**这一台根本没起过**，真因只活在服务端进程日志里（`logger.warn`）。

**根因**：**两层判据分家**。契约的 `headers` 当时是 `z.record(z.string().min(1), z.string())`（任何非空字符串都算合法键），而适配器的形状闸是 `/[\s:]/`（拒空白与冒号）——后者比前者严。适配器摘掉之后，编排层的注入集**仍按契约把它算成 `injectable`**，而行级判据在 `vendor-tool-table` 通道上的读法是「表在、里面没有它 ⇒ `unavailable`」⇒ 失败档；这个条目不在编排层的 `invalid` 桶里（那个桶的语义是「弱判据不装强结论」，走的正是「行照跑 + `unverified`」那一档）。**测试环境 ≠ 运行环境**：适配器那层有一条「坏条目摘掉」的用例（喂 `X Y` 进去、断言它进 `dropped`），契约那层没有对应用例 ⇒ 两边各自绿，合起来是整行假失败——「第二道防线」摘掉一个**上游认为合法**的条目时，下游没有任何机制能知道。

**解决方案**：把判据提到**契约层**——`MCP_HEADER_KEY_PATTERN`（HTTP field-name 的 token 语法：字母数字与 `` !#$%&'*+-.^_`|~ ``）进 `McpServerConfigSchema.headers` 的键，契约与适配器共用同一份模式。落这一层之后该条目走 `invalid` 桶：行照跑、观测格记 `unverified`、日志点名到格（`headers 的键 "X Y" 不合法：…`），用户去设置页改键名即可。适配器那一层保留同一份判据作为第二道防线（手改 `config.json` 的路），并新增一条**可见的 `log`**：被它摘掉的条目在产物里点名（厂商的启动报告走 `ctx.ui.notify`，SDK 装配下那是 `noOpUIContext`，一个字都不会出现）。判据：`contracts/src/mcp.test.ts` 的「headers 键按 HTTP field-name 收」、`providers/pi/injection.test.ts` 的「被摘掉的条目落一条点名 log」。变异验证：① 契约那格改回 `z.string().min(1)` ⇒ 契约用例红；② 适配器那格放宽回「只拒空键」⇒ 适配器用例红。

**相关资料**：RFC 9110 §5.1 `field-name = token`、§5.6.2 `tchar`。

---

## `TypeError: (entry.args ?? []).findIndex is not a function`（`args` 被手改成字符串，第二道防线自己炸了）

**日期**：2026-10-16

**现象**：手改 `config.json` 把某台 stdio 服务器的 `args` 写成字符串（`"args": "a.js"`）。绕过编排层直接调 `agentProvider.run`（或将来新加的调用点）时，这一行以 `TypeError: (entry.args ?? []).findIndex is not a function` 收场：`run` resolve 成 `{ok:false, exitReason:'error', finalText:null}`、**零出站请求**，而产物里看不出是 `args` 写错了。

**根因**：`toPiMcpServers` 的形状闸在 `args` 这一格上**只判了元素类型**（`findIndex((arg) => typeof arg !== 'string')`），没判容器本身是不是数组——容器是字符串时 `.findIndex` 直接不存在。而这一层的定位是「第二道防线，拦手改配置与将来多出来的调用点」，口径是**跳过 + 行照跑**：抛出去与这条口径正好相反。编排层路径上它被上游 zod 闸先拦成 `invalid`（`args 不合法：Expected array, received string`），所以这个洞只在绕过编排层时可达——而那正是这一层存在的理由。

**解决方案**：容器格先判形状（`entry.args !== undefined && !Array.isArray(entry.args)` ⇒ 摘掉并点名），再判元素。判据：`providers/pi/injection.test.ts` 的「args 不是数组 ⇒ 摘掉并点名，不抛」。变异验证：删掉那两行 ⇒ 该用例与「被摘掉的条目落一条点名 log」同时见红，且红的就是 `TypeError`。

---

## 「触发 subagent 的时候，没有立即展示 subagent 卡片，找不到查看 subagent 消息流的入口，直到 subagent 执行完成以后才展示」

**日期**：2026-10-15

**现象**：pi 行派发子智能体时，执行日志时间轴的派发点上**什么都没有**——既没有子任务卡片，也没有「进入 ▸」入口，整段运行期这个子任务在界面上不可达；直到子智能体收场那一刻，卡片才连同终态一起冒出来。产物一侧的形状（真机 `messages.jsonl` 逐行序）：`{"type":"tool_execution_start","toolCallId":"call_00_722yy…","toolName":"Agent","args":{…,"run_in_background":false}}`（`07:25:41.076`）→ `{"type":"tool_execution_end","toolCallId":"call_00_722yy…","toolName":"Agent",…}`（`07:25:59.397`，18 秒）→ **第一条** `subagent` 记录，且 `status` 直接是 `"completed"`。另三家同轮次的同一格里第一条都是 `status: "running"`、且落在工具结果之前。

**根因**：**这一家前台档（`run_in_background: false`）的 `Agent` 是阻塞工具，而子任务行只在 `tool_execution_end` 上造**——`providers/pi/events.ts` 的 `projectToolExecutionEnd` → `projectDispatchEnd` 是当时唯一的行来源，它要的身份（`details.agentId`）只有工具结果里才有。派发到收场之间父会话收不到任何「子任务已经开始」的行，于是界面按「没有记录 ⇒ 没有节点 ⇒ 没有卡片」如实渲染（UI 侧没有门限：任何一条 `SubagentRecord` 都会立刻生成节点与入口）。契约与另三家都要求**派发时一条**（`AgentRunInput.onSubagent`：「同一身份会多次投递（派发时一条、收场时一条）」）：cc / dsh / codex 都照做，只有 pi 违约。**测试环境 ≠ 运行环境**：一致性套件那条 `subagent` 场景走的是真包 + 真扩展，但它只查**产物形状**、不查「派发行在不在」，所以这条缺口在套件里是绿的。

**解决方案**：`providers/pi/events.ts` 增派发时刻那条通路——`PiRunState.dispatchStarts` 在 `tool_execution_start` 记下这次调用的 `name` / `description`（原来是只记名字的 `dispatchNames`），`projectPiEvent` 包一层：每个事件投影完再补发一次「总线已报 `subagents:started`、而这次工具还没收尾」的子任务行（`deliverStartedSubagents`），`status: 'running'`、身份取总线 id、`parentCallId` 取那次调用、用量与结果记未采集（「还没采到」不是「没有」）。两条认领判据：**总线载荷只有 `{id, type, description}`、没有工具调用 id** ⇒ 认领靠描述逐字相同且**唯一**，零条或多条一律不认领、不投，只落一条点名的 WARN（宁可晚一条，也不把卡片挂到别人的派发点上）；总线已报终态的身份不投（那会让状态从终态退回运行中）。判据：`providers/pi/events.test.ts` 的「pi 的子任务投影」五条（派发即出行 / 同一次派发只出一条 / 描述撞名不认领 / 已报终态不投 / 同一批次里派发行排在收尾行之前）。三条变异都见过红：① 去掉补发 ⇒ 四条红；② 认领放宽成「先到先得」⇒ 撞名那条红；③ 去掉描述比对 ⇒ 顺序那条红。真机读数（前台档、`Agent` 起手 `08:36:19.406`）：**0.3 s 内卡片已上屏且 Tag 是「运行中」**，而 `messages.jsonl` 里那条 `running` 行落在该次工具结果**之前**——这是「派发行真的在派发时刻投出去」的合格判据（对照修之前：第一条 subagent 记录在 `tool_execution_end` 之后、状态直接是 `completed`）。

**已知边界**：子任务的**逐步骤正文**走两条通路（见 `docs/protocols/pi.md` 已知边界表）：首选 wire（`subagent-wire.ts`，注册表快照 + 订阅子会话事件流，跑动期逐消息跟出、无「补录」角标），转写文件为兜底与订阅前缺口的补充（`providers/pi/transcript.ts`，见下一条）；wire 不可用的行，子任务节点退回「补录」形态，与「没有对话记录」仍分得开。

---

## 「这个子任务没有逐条对话记录」（pi 行的子任务节点点进去是空的：子会话的步骤不在父会话的事件流里）

**日期**：2026-10-13

**现象**：pi 行派发过子智能体、子任务行有终态与用量，但界面上点进那个子任务节点只有一句**「这个子任务没有逐条对话记录」**——它自己那几十步（读文件、跑命令、思考）一条都看不到。产物一侧的形状：`messages.jsonl` 里带非空 `subagentId` 的消息**一条都没有**（只有主会话消息 + 两条 `subagent` 记录）。

**根因**：**子会话是另一个 pi 会话**（`@tintinweb/pi-subagents` 在同一进程里另起一个），它的事件**不进父会话的 `session.subscribe` 流** ⇒ 投影层从来没有机会给任何消息挂 `subagentId`。而界面按 `message.subagentId` 把消息分给会话节点、按 `message.roundTrip` 给每个节点分轮（`build-model.ts`）⇒ 那个节点**零轮次**，只能渲染成空态。三条排查要点：① 缺的是**消息**不是日志——`log` 事件在契约里根本没有 `subagentId` 这一格，界面也不把 `log` 折进时间轴，**拿日志事件找归属是找错了地方**；② `AgentMessage.turn` 是**厂商轮号**（`z.number().nullable()`，pi 没有 ⇒ 恒 `null` 是正确值），**不是**归属键，别拿它当「有没有对齐」的判据；③ 另外两条候选通道都取不到正文——扩展事件总线除 `subagents:started/completed/failed` 外只有身份与元数据频道，`Agent` 工具的 `tool_execution_update` 载荷只有一行 spinner 活动文案（按帧动画频率刷）。

**解决方案**：读扩展自己写的**逐 agent 转写文件**（`@tintinweb/pi-subagents` 的 `output-file.ts`，默认开：`<tmpdir>/pi-subagents-<uid>/<cwd 编码>/<会话 id>/tasks/<子任务 id>.output`，JSONL，`turn_end` 时 flush）。落点是骨架的**收尾接缝**（与 codex 读 `rollout-*.jsonl` 同一格），实现见 `packages/server/agents/src/providers/pi/transcript.ts`：正文复用既有的助手 / 工具结果归一（转写的 `message` 与 `message_end.message` 同构），逐条盖上 `subagentId` 与 `source: 'session-file'`，轮次按**该子会话自己**的模型往返序从 1 起（与 claude 的 `roundTripOfSession` 同一条口径——共用一个计数器会让几十条消息全挤进一个轮次行）。路径由**本行的 `cwd` 与本会话的 `sessionId`** 拼出，**不扫目录**（转写根是全机共享的，扫目录会让并发的两行互相认领对方的子任务）；读不到**不失败**，如实落一条点名 WARN（子任务节点为空即这条边界）。判据：`transcript.test.ts`（路径公式、轮次与 `subagentId` 挂载、坏行与半截末行、上限截断、文件缺失）与 `events.test.ts`（收尾搬运正文、缺失时不改结论）。三条变异都见过红：① 去掉投影 ⇒ `transcript.test.ts` 9 条红；①b 收尾不搬运正文 ⇒「收尾把子会话转写折成子任务的消息」红；② 去掉 `subagentId` 挂载 ⇒「逐条带 subagentId」与「文件在时读得到」红；③ 去掉子任务行去重 ⇒「同身份同内容只出一条」红。

**已知边界**：转写文件通道今天是**兜底**（wire 不可用的整行、以及 wire 订阅前的缺口都由它补；跑动期增量投递挂在每个事件的投影上、按身份节流读盘，收尾只补差量——载体键与 wire 对齐后由投影层去重，`messages.jsonl` 不留双份）。子任务正文的**首选来源是 wire**（`subagent-wire.ts`：经 `globalThis[Symbol.for("pi-subagents:manager")]` 快照本行的 manager、订阅子会话自己的事件流，`source: 'wire'`、无「补录」角标；机制与取舍见 `docs/protocols/pi.md` 已知边界表）。「补录」角标只在兜底通路上出现。扩展关掉转写（`output_transcript`）且 wire 也不可用时，子任务节点回到空态并留一条 WARN。

**相关资料**：`@tintinweb/pi-subagents` 的 `src/output-file.ts`（`encodeCwd` / `sessionTaskDir` / `streamToOutputFile`）与 `src/index.ts` 的 `createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId())`。

---

## `TypeError: sdk.getDefaultSessionDir is not a function`（想知道文件型会话的默认落点，却拿不到那个函数）

**日期**：2026-10-14

**现象**：探针要读「不给 `sessionDir` 时厂商把会话落到哪」，按 `session-manager.d.ts` 的 JSDoc 去调 `sdk.getDefaultSessionDir(cwd, agentDir)`，当场抛：

```text
TypeError: sdk.getDefaultSessionDir is not a function
```

**根因**：**那一格没有出口**。`getDefaultSessionDir` 有 `export`（`dist/core/session-manager.js:296`，JSDoc 在 `dist/core/session-manager.d.ts:203`），但包的 `package.json` 的 `exports` 只露 `.`（→ `dist/index.js`），而 `dist/index.d.ts:21` 从 `./core/session-manager.ts` 转出的名单里**没有它**（`findMostRecentSession` / `loadEntriesFromFile` 同样不在；转出的只有 `SessionManager`、`buildSessionContext` / `buildSessionProjection`、`parseSessionEntries` 与几个类型）。⇒ 「默认落点」这件事在**出口面上根本不存在**，只能在**实例**上问：`SessionManager.create(cwd).getSessionDir()`（`dist/core/session-manager.d.ts:244`）——而那正是 SDK 在调用方不给 `sessionManager` 时自己走的那一步（`dist/core/sdk.js:76` 的 `options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir))`）。

**解决方案**：要读默认落点就**造一条 manager 再问它**，并且**必须先把 `PI_CODING_AGENT_DIR` 指到临时目录**——`create(cwd)` 会把默认会话目录 `mkdirSync` 出来（`dist/core/session-manager.js:296-302`），不指变量就会在真实家目录下长出 `~/.pi/agent/sessions/--…--/`（与「只跑一次 `pi --help`」那条同根因）。探针里的落点是一格独立 role：`packages/server/agents/probe/v11/pi-session-resume.mjs` 的 `--role=default-dir`，判据是三条读数覆盖两个轴——同一 home 换 cwd、同一 cwd 换 home，路径都不同（`<agentDir>/sessions/--<cwd 里 `/` 与 `:` 换成 `-`>--`）。派生公式在 `dist/core/session-manager.js:290-295`。

**相关资料**：`@earendil-works/pi-coding-agent` 的 `dist/index.d.ts:21`（转出名单）、`dist/core/session-manager.js:296`（`getDefaultSessionDir` 本体）、`dist/core/sdk.js:76`（SDK 自己的默认那一步）。

---

## 会话文件在盘上、`buildSessionContext()` 里也有暗号，模型却回「不知道」（同一个文件的下一轮就答对）

**日期**：2026-10-14

**现象**：跨进程续接探针的正面臂（新 node 进程 + `SessionManager.open(<上一进程写的会话文件>)`）里，模型回答逐字是 `不知道`；而**同一个进程在 `prompt()` 之前**读到的厂商投影 `manager.buildSessionContext().messages` 里，那条带暗号的用户消息**在场**（3 条：`system` / `user:请记住这串暗号：AIEVAL-…` / `assistant:记住了`）。紧接着的下一格拿**同一个会话文件**再问一次，答案就是那串暗号。三轮真机共 12 个「带暗号的问回」格，其中 **2 格**出现这个形状（`open` 与 `continueRecent` 各一次），且两次的投影读数都是「暗号在场」。

**根因**：**未定位到模型侧**（不是 SDK 这一层）。已排除的两条：① 会话文件没内容——`getEntryCount()` 与文件行数都在（同格读数 `entries=7`）；② SDK 没把历史灌进上下文——`dist/core/sdk.js:84` 取 `sessionManager.buildSessionContext()`、`:259` 把它交给 `Agent({ initialState: { messages: existingSession.messages } })`，而这一格读到的投影里暗号在场。⇒ 剩下的位置是**模型/网关这一侧**：端到端的暗号回读**会偶发假红**（本机这一档约 1/6），而机制层读数**每次都对**。

**解决方案**：**判据不许只取单次端到端回读**。凡是要判「这家能不能续接」，必须**同时**读厂商自己的投影（`buildSessionContext()`，在 `prompt()` 之前取，不花额度）与模型答复：投影是机制判据，答复是端到端判据，两者都成立才算过；只有答复不成立而投影成立时，记成**模型抖了一次**而不是「不支持」。落点：`packages/server/agents/probe/v11/pi-session-resume.mjs` 的 `projectionHasNonce`（每格都落进 dump）。⚠️ 那一格判据自己也有一个坑：`nonce !== ''` 不能省——空串是任何字符串的子串，省掉它会让**每一格**（含阴性对照）都报「投影里有暗号」，那正是这条探针要防的假绿。

---

## 「pi subagent 启动时进入 subagent 执行日志 里面是空的无消息，当 subagent 执行完成时消息一次性全部显示」

**日期**：2026-10-15

**现象**：pi 行派发子智能体后，执行期点进那个子任务节点：一条消息都没有（空态「这个子任务还在跑 · 逐步骤正文还没到」）；子智能体乃至整行收尾的那一刻，它的全部逐步骤消息**一次性**涌出。产物一侧的形状（真机 `86e02ea1…/rows/f394dd00` 的 `messages.jsonl` 逐行序，共 25 行）：主会话 18 条 wire 消息（round 1–9）之后，子任务的 7 条 `source: "session-file"` 消息（round 1–4）**全部挤在文件尾**；而子智能体其实 `07:25:59` 就随 `Agent` 工具收尾交了 `completed` 的子任务行，消息却要等**整行** `agent_settled`（约 20 秒后）才落盘。

**根因**：**不是消息的关联键没对齐**（`subagentId` 与别名解析是通的——完成时能整齐点亮就是证据），是**谁来触发采集**。子会话是另一个 pi 会话，它的事件不进父会话流；两条取数通路（wire 订阅缓冲、转写文件读盘）的**排空点都挂在父会话事件的投影上**。而 `Agent` 是**阻塞工具**：派发期父会话的帧**不带子任务正文**——这正是子智能体在干活的那整段时间。于是缓冲只进不出，到工具收尾那一刻才被一次性取走。

**这一格此前判断错的是「心跳」**：曾假定扩展会在派发期往父会话刷 spinner 帧（`tool_execution_update`）当心跳，并据此断言派发期**一帧都没有**。**那个断言与厂商事实相反，而且当时的判法是失效的**——`events.jsonl` 里数不到这一帧（产品对 `tool_execution_update` 显式丢弃，按 `JSON.parse(e.text).type` 数**恒为 0**，阳性对照同样数到 0）。可用的判法是**直接数原始帧**（订阅回调原样记类型）：真机（脚本式上游，`Agent` 派发一轮）派发到收场之间父会话发 **1 帧 `entry_appended`**，外加**数量不定**的 `tool_execution_update`（取决于工具在跑的时候有没有输出可刷：同一条探针不同次运行读到过 4 与 0），而**没有一帧带子任务正文**。结论因此收窄成：心跳帧存在，但它不是正文通道 ⇒ 挂在它上面的「跑动期增量」在前台档里出不来（按它的节奏只能一小段一小段地漏，或整段攒到工具收尾）。**测试环境 ≠ 运行环境**：假件在 `subscribe` 那一刻把排下的事件同步吐完，于是父会话「永远有下一个事件」，这个缺陷在单测里看不见。

**解决方案**：wire 通道自带**合成帧泵**（`providers/pi/subagent-wire.ts`）——缓冲进账即往父事件流里塞一帧本层自造的帧（`PI_SUBAGENT_WIRE_TICK_TYPE`），换来一次投影，也就是一次排空；不再依赖父会话说话。四条约束：① **至多一帧在飞**（`drain` 跑过才消旗），一轮十几条收尾只换一帧；② 节流 25 ms（`PI_SUBAGENT_WIRE_TICK_MS`）；③ **排空后按剩余续泵**——一次正常投递要两帧（第一帧让子任务行落账，`deliveredEarlier` 是投影前的快照 ⇒ 那一帧自己取不到，第二帧才真排空），没有续泵第二帧又会回去等父会话；④ **空转封顶**（`PI_SUBAGENT_WIRE_MAX_FRUITLESS_TICKS`）挡住「永远不会落账的身份」（派发认领失败那一档）把泵拖成按节拍的永久空转，有新内容即归零。合成帧在 `events.ts` 的判别链**最先判、投影成空**，漏判它会掉进兜底分支、把「未识别的厂商载荷」刷满原始输出面板。泵按**活动区间**接（`attachPump`，首轮与每个修正轮各一份），接上那一刻缓冲非空就补一帧（区间缝隙里进来的正文不至于再等）。

判据：`subagent-wire.test.ts`「合成帧泵」用例组七条（钉值 / 进账即推 / 至多一帧 / 续泵 / 空转封顶 / 接泵补帧 / 摘泵与 dispose 不推），`events.test.ts` 一条（合成帧投影成空），`index.test.ts` 一条**端到端**守卫——夹具按真机形状搭：父会话交完派发的 `tool_execution_start` 就静默（`hangPrompt`），判「子任务正文在父会话没有下一个事件时就已到达 `onMessage`」。六处变异全部见过红，还原后逐个核对过文件哈希；其中「摘掉泵接线」那一处复现的正是本条现象（子任务消息为 `[]`）。

**相关资料**：本仓 `docs/protocols/pi.md` 的「子任务节点的逐步骤正文」条目（现行口径）；`@tintinweb/pi-subagents` 的 `src/output-file.ts`（`turn_end` flush 的转写落盘，兜底通路）。

**后续（逐字流式）**：泵把「整条消息」的时延压到毫秒级之后，子任务正文又从**整条到达**改成了**逐字到达**——子会话的 `message_update` 增量帧现在也进 wire 缓冲，口径与影响见下一条。

---

## 「subagent 的消息能不能像主会话那样逐字出？」（子任务节点整条消息才出现，长答复时等待感明显）

**日期**：2026-10-16

**现象**：不是报错，是体验缺口。合成帧泵修好「实时」之后，子任务节点仍是**整条消息**一次性出现（一轮答复要等它写完才显示），主会话却是逐字长出来的——同一个界面里两种节奏，长答复时子任务那一侧的等待感明显。

**根因**：wire 通道当初只收**两种权威收尾**（`message_end` 的助手行、`tool_execution_end`），`message_update` 的逐字增量被显式丢掉（「其余帧不入缓冲」）。放开它要先解决一处**潜在错账**：子会话消息的载体去重按 `carrierKeyOf`（`subagentId|轮次|role|parentCallId`）记账，而**同一轮的增量与它的收尾快照键逐字相同** ⇒ 先到的 delta 会占死键、权威快照被整条丢掉。那时界面上消息会永远停在半截（且不会报错）。

**解决方案**：三件一起落。

1. **去重判据从「按载体」改成「按载体 + 快照语义」**（`events.ts` 的 `emitSubagentDrafts`）：增量一律放行、只有快照之间互斥。成立前提是**只有 wire 产增量**——转写文件读的是已完成消息数组，天然只有快照，故放行增量不会引入重复内容。
2. **增量入缓冲**（`subagent-wire.ts` 的 `absorbEvent`）：轮次取**当前轮 + 1**（增量属于那条**还没收尾**的消息；`round` 只在 `message_end` 自增 ⇒ 用当前值会把增量挂到上一轮已收尾的消息上），且**不自增计数器**（否则一轮几十帧各占一轮）。归一沿用主会话那条 `piDeltaMessageDraft`（自带「只认 text_delta / thinking_delta」「空片段丢掉」两道闸）。
3. **越界淘汰按块形态分档**（`evictOverflow`）：**先吃增量、快照垫底**。增量放开后越界不再是稀有事件（一条几千 token 的答复就是几千帧），而按到达序一刀切会先把第 1 轮那条**权威快照**顶出去——界面上「少一整轮」与「本来就没说」长得一样。点名也分两档：丢快照是「丢权威正文」，丢增量只说「少了几帧实时预告，收尾快照会覆盖 ⇒ 正文不丢」。

**落盘与节流两件事不必动，但理由要写清**：编排层对 `chunk: 'delta'` **只扇出不落盘**（`orchestrator.ts` 的 `onMessage` 分叉），故逐字帧不进 `messages.jsonl`、账本不虚胖；节流 25 ms 压的是**投影次数**而不是正文新鲜度——**一拍之内攒下的增量由同一次 `drain` 整批取走**（守卫：「一拍只推一帧，但那一帧把这一拍攒下的增量整批取走」），帧再密都不丢、不推迟。界面侧不用改：客户端按 `mergeKey` 覆盖累积，而服务端合并器每条增量发的是**到目前为止的累积块** ⇒ 子任务节点上就是一段逐字变长的文本。

**判据与一处假绿**：`events.test.ts` 三条（增量投出且不挡快照 / 增量不占死载体让转写快照照样放行 / 快照之间仍互斥）、`subagent-wire.test.ts` 四条（增量按「下一轮」归属 / 只认两种增量形状 / 越界优先淘汰增量 / 两档点名措辞）＋ 一条节流语义（整批取走）、`conformance.test.ts` 一条真链路。五处变异全部见过红，还原后核对过文件哈希。

⚠️ **真链路那条守卫第一版是假绿**：它只断言「有 delta 且有 snapshot 且同键」，而把去重变异回「按载体」之后**仍然全绿**——因为权威快照被挡掉时，合并器的 `sealOpen` 会按增量累积值**补发一条** `chunk: 'snapshot'`，chunk 与 mergeKey 都长得一样。真正分得开的是**用量**：它只在子会话的 `message_end` 上（增量一律 `usage: null`）⇒ 判据改成「收尾快照里必须有带用量的那条」，变异才见红。凡是「快照被挡掉」这类缺陷，**不要只看 chunk**。

**相关资料**：本仓 `docs/protocols/pi.md` 的「子会话正文的首选通道是 wire」条目；`packages/server/evaluator/src/orchestrator.ts` 的 `onMessage` 分叉（delta 只扇出不落盘）。

---

## 路由不给 API key 时**零出站请求**、这一行却报成功（`No API key found for aieval-pi-…`）

**日期**：2026-10-16

**现象**：网关条目没有 API key（本机自建网关不带鉴权很常见）时，pi 行以 `ok:true` / `exitReason: 'completed'` / `finalText: null` / `error: null` 收场，而**一次出站请求都没发出去**（假网关的 `requests` 计数为 0）。同一剧本把 key 换成非空串就一切正常。厂商抛出的原文是：

```text
No API key found for aieval-pi-6d04f99c1bbe.

Use /login to log into a provider via OAuth or API key. See: …/docs/providers.md
```

**根因**：**厂商的 `prompt()` 除了「运行期失败」（走 `stopReason` / `errorMessage`）之外，还会在起请求之前直接抛**——`.d.ts` 的 `@throws` 一族有五种（`no model selected or no API key available` / `Cannot submit a prompt while compaction is in progress.` / `Agent is already processing. Specify streamingBehavior …` / `formatNoModelSelectedMessage()` / `Authentication failed for "…"`）。适配器把「提示词落定」与「提示词抛错」归成了同一个信号（`run().then(note, note)`），于是拒绝被吞在流内部：骨架的 `catch` 与 `classifyAgentFailure` 都看不到它，结论由「没有任何失败信号」推出 ⇒ 一次凭据缺失被读成「成功了、只是没说话」。候选行据此记 `completed`（看起来就是「这个候选什么都没干」），评分行则报「适配器未回传最终消息」——两处都指向错误的方向。

**解决方案**：`packages/server/agents/src/providers/pi/index.ts` 的 `sessionEventStream` 把拒绝**单独记下**（`promptFailed` / `promptError`），队列里剩的事件先交完，再在流收尾时抛给骨架 ⇒ 归 `AGENT_FAILED`（外部要求停止那一档仍走 `canceled`，因为骨架先判 `stopRequested`）。判据：`index.test.ts` 的「prompt() 在建请求前抛错 ⇒ 折成失败（不许静默成功），且释放照旧」（假 SDK 把 `prompt` 换成 reject）真机判据：`providers/pi/index.test.ts` 的「路由不给 apiKey ⇒ 零出站请求、结论是失败（不是静默成功）」（真包 + 假网关，同一剧本只差 `apiKey` 一格；有 key 的对照臂正常拿到答复）。变异验证：把吞拒绝的那一行改回去，守卫见红。

---

## 失败/中止的那一轮把 `tokens` 写成 `{0,0,0}`、日志里还是 `metered: true`（厂商的 `usage` 是全 0 冻结对象）

**日期**：2026-10-16

**现象**：假网关回 500 的一轮（连接失败 / 被中止 / 网关没回 usage 块同理）跑完，行结果里 `tokens` 是 `{input:0,cached:0,output:0,total:0}`、`turns: 1`，而那条「这一条助手消息没有可读的用量，本行按「未采集计量」处理（不填 0）」的 WARN **一条都不落**：

```json
{"ok":false,"exitReason":"error","tokens":{"input":0,"cached":0,"output":0,"reasoningOutput":null,"total":0},"turns":1,"usageLogs":0}
```

**根因**：厂商的 `AssistantMessage.usage` 是**必填字段**，pi-ai 构造消息时把它初始化成**全 0**（`api/openai-completions.js` 的 usage 组装里 `completion_tokens || 0` 那一族）；请求失败、被中止、网关没回 usage 块这三条**都不是异常路径**，都会把这份冻结的全 0 原样留在最终消息上。适配器原来按「三个键在场 ⇒ 厂商报过用量」判，于是「没采到」被读成「采到了 0 token」——而契约（`tokens` 采不到就是 `null`）与界面读法（0 会让人得出「这家很省」）双双被违反，且 `orchestrator` 会把这一格当终态事实写进行快照。同一处还有一格：openai 那条 wire 把缺失的推理明细补成 `reasoning: 0`（`completion_tokens_details?.reasoning_tokens || 0`），anthropic 那条只在真有思考 token 时才写 ⇒ 同一份 `reasoning: 0` 在两条 wire 上是两句不同的话。

**解决方案**：`packages/server/agents/src/providers/pi/message.ts` 的 `readPiUsageTokens` 拒掉**四项同时为 0**（输入 / 缓存 / 输出 / 厂商自报总量——一次真实往返不可能全 0）⇒ 回 `null`，让那条点名 WARN 真正生效；`reasoningZeroIsMissing` 由调用方按消息自带的 `api` 决定（openai 那条 wire 传 `true`）。判据：`events.test.ts` 的「厂商的冻结全 0 用量 ⇒ 既不给 tokens 也不给 total，并落那条「没有可读的用量」WARN」与「openai wire 的 reasoning=0 算「没报」」；真机判据：`providers/pi/index.test.ts` 的「上游回 500（失败的一轮）⇒ tokens 是 null，不是「采到了 0 token」」（真包 + 假网关）。

---

## `run()` 返回后 MCP stdio 子进程还活着（`AgentSession.dispose()` 不 emit `session_shutdown`）

**日期**：2026-10-16

**现象**：真包 + 真 stdio MCP 服务器 + 假网关跑完一行，`run()` 已返回（生命周期观测里 `disposeCount === 1`），而那一台 MCP 服务器的子进程仍可 `kill(pid, 0)` 探到存活、握手记录里的 `initialize` / `tools/list` 都在：

```json
{"pid":52222,"stillAlive":true,"handshake":"initialize\ninitialized\ntools/list\n"}
```

**根因**：pi 的 MCP 扩展把连接（进而 stdio 子进程）的生命周期挂在**扩展事件 `session_shutdown`** 上（`dist/extensions/mcp/index.js`：`pi.on("session_shutdown", async () => { session.abort(); … servers = []; … })`），而 emit 这个事件的只有三处：`agent-session.js` 的 `reload`、`agent-session-runtime.js` 的 `teardownCurrent` / `AgentSessionRuntime.dispose`——**`AgentSession.dispose()` 不 emit**（它只做 abort×5 + `_extensionRunner.invalidate` + `_disconnectFromAgent` + 清监听 + `cleanupSessionResources`）。适配器用的是 `createAgentSession(...)` 返回的 `AgentSession`（窄壳只声明了这一条入口），SDK 自己的 `killProcessTree` 又只按 **pid / 进程组**回收它自己 spawn 的**工具**子进程 ⇒ 扩展拉起的 MCP 子进程没有任何回收点。进程归属表里 pi 那一格原来写「整组已验证」而没有限定作用域，把这一半也罩进去了；补上那一发之后限定撤回，归属格恢复成「整组已验证」（判据就是下面那条进程事实）。

**解决方案**：**适配器在释放序列里自己补发那一发**——`packages/server/agents/src/providers/pi/index.ts` 的 `createSessionDisposer` 按厂商 `AgentSessionRuntime.dispose()` 的同一条顺序走：`abort()` → `waitForIdle()` → `emit(session_shutdown, { reason: 'quit' })` → `session.dispose()`。用的是**公开面**（`AgentSession.extensionRunner` 的 getter + `ExtensionRunner.hasHandlers` / `emit`，两者都在包根导出），不碰私有字段、也不必为此换成 `createAgentSessionRuntime()`（那条路要扩窄壳、且 runtime 自己管会话替换）。投递失败只记日志、不挡 `dispose()`；没人监听时静默跳过。

判据两条：① 确定性——假 SDK 里装一个 `session_shutdown` 监听者，释放序列必须是 `['session_shutdown:quit', 'dispose']`，没有监听者时一次都不发（`providers/pi/index.test.ts`）；② **真机进程事实**——真包 + 真 stdio MCP 服务器跑一行，`run()` 返回后那个 pid 必须已经不存在（同文件「MCP 子进程回收」一组）。变异验证：把补发那一行删掉，两条守卫都见红（真机那条复现的正是本条现象：pid 仍存活）；把 `reason` 从 `quit` 改掉，确定性那条见红。

---

## `expected 'session-file' to be 'wire'` + `子任务一条逐字增量都没有`（满载时 red、空载时 green 的假红）

**日期**：2026-10-16

**现象**：同一条守卫（`providers/pi/conformance.test.ts`）在 `vitest run packages/server/agents/src/providers/pi` 满载时红两条：

```text
AssertionError: 子任务正文必须标流式来源 wire（wire 不可用才退 session-file 补录）: expected 'session-file' to be 'wire'
AssertionError: 子任务一条逐字增量都没有——wire 的 message_update 那一支没进缓冲: expected 0 to be greater than 0
```

空载连跑三次全绿、单文件跑 29 全绿 ⇒ 判据本身没有说谎，是**时序**。

**根因**：wire 通道在总线报 `subagents:started` 之后才去 `getRecord(id).session` 并 `subscribe()`，而 `subscribe()` **只收订阅之后的事件**。假网关是瞬时回包，「拿到句柄」那一次 20 ms 轮询在 CPU 争抢下可能整体输给子会话的一整轮往返 ⇒ 那一轮的助手 / 工具事件一条都没进缓冲，正文全部由转写文件兜底（`session-file`、无增量帧）。**测试环境 ≠ 运行环境**：真网关是秒级往返，这个窗口赢面极大；争抢只出现在并行跑测试的机器上。

**解决方案**：**根治在适配器里**——订阅那一刻用 `session.messages`（已完成消息数组）把缺口**补账**进缓冲（`packages/server/agents/src/providers/pi/subagent-wire.ts` 的 `backfillHistory`：助手消息按绝对序定轮次、工具结果沿用当前轮，与转写路径的助手行序对齐 ⇒ 载体键相同、去重照旧收敛）。于是该身份的历史与新事件同形地走同一条通路，`source` 恒为 `wire`，转写退成真正的兜底（`session.messages` 也读不出时）。判据：`subagent-wire.test.ts` 的「订阅前已完成的消息由 session.messages 补账：来源 wire、轮次绝对序、后续事件接着数」。变异验证：去掉那一句补账，守卫见红。
