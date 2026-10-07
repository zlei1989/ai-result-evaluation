# 执行日志抽屉重设计的冒烟记录（2026-10-02）

设计：`docs/superpowers/specs/2026-09-30-exec-log-drawer-redesign-design.md`
预览页：`/dev/agent-log`（只吃 `@aieval/ui` 的 `allFixtures()`，**不读任何接口**）

## ① 范围清单

| # | 验收项（设计 §11 编号） | 结果 | 证据 |
|---|---|---|---|
| 1 | 事实进度条常驻可见、轮次与时间轴**同源** | ✅ | `[data-testid="agent-log-facts-turns"]` 文本 `轮次 4 轮`；时间轴护栏 `已渲染 3 / 共 4 轮`（前者是这一行跑到第几轮，后者是虚拟列表挂了几项，两个数不互相替代） |
| 2 | 每轮按「思考 → 工具调用 → 正文」呈现；`text` 走 markdown | ✅ | dsh 第 1 轮：`思考` 折叠项 → `工具调用 × 1 read_file` → 正文里的 `build` 渲染成 `<code>` |
| 3 | 连续工具调用合成一个面板，N 与实际行数一致 | ✅ | dsh 第 2 轮 `工具调用 × 1 pwsh`（`task` 卡片被提出后**不计入** N）；孤立结果另起一行 `孤立结果（配不上调用）` |
| 4 | `task` 计划清单面板（计数 / 变化 / 四态） | ✅ | `计划清单 1/4 完成 结果未采集`，四项状态 Tag：`已完成` / `进行中` + `me` / `待办` / **`状态未知`**（未识别状态值不冒充成功） |
| 5 | `ask-user` 问答卡片（等待态独立成支） | ✅ | `问题 2 个 发布范围 结果未采集`，正文含「在等你选发布环境——这一步在无人值守的运行里会一直等到轮次被取消」 |
| 6 | 子任务占位条 `可点`，与主会话**同形** | ✅ | `子任务 sub-7f3a 已完成 进入 ▸` + 派发方式 / 结果摘要 / 自己的用量三格 |
| 7 | 任务名为空的子任务用 id 前 8 位兜底 | ✅ | 该子任务 `name: null`，界面显示 `子任务 sub-7f3a`（不空白） |
| 8 | 虚拟滚动：DOM 里的轮次节点数远小于总轮次 | ✅ | 4 轮的数据在 411px 视口里只挂 3 行；`holder.scrollHeight = 1572`、`clientHeight = 411`；滚到底后第 4 行（问答卡片）出现 |
| 9 | 「回到最新」与工具条开关**同一份 state** | ✅ | 上翻后在角落浮出按钮，点回工具条开关同步（组件用例 `agent-log-layout.test.tsx` 同口径） |
| 10 | 「原始输出」逐字原文、默认收起 | ✅ | `原始输出 2 条 ▾` 收起态；展开后逐行 `[HH:mm:ss] stdout/stderr 原文` |
| 11 | 「补录」与「摘要」两种角标（谁说的 / 哪来的） | ✅ | codex 夹具：`思考` + `摘要` + `补录` 三个 Tag 同时出现 |
| 12 | 三种「空」分得开 | ✅ | claude-code 夹具显示「该子任务的对话未转发（只投送了工具调用）」，**不是**「它什么都没说」 |
| 13 | `kind: 'row'` 的节点出计数说明行、不可点、整条时间轴只一次 | ✅ | codex 夹具：`汇总 已完成 子任务 1 · 完成 1 · 失败 0`，全文只出现一次（缺陷已在冒烟中修掉，见 ④） |
| 14 | 环境抽屉（§6.8） | ✅ | 摘要七项（智能体 / 模型 / 强度 / 供应商 / 接口 / 工作区 / 基线）+ 四组来源标；`已调度的工具`（厂商系统层）与`用过的工具及次数`（实测统计）**分列两组**；缺失项写原因（`被禁用的工具 · 没验证过`）；**没有「用户提示词」这一格** |
| 15 | 环境抽屉随主抽屉一起消失（结构保证） | ✅ | 关掉主抽屉后环境抽屉随之卸载（组件用例 `agent-environment-drawer.test.tsx` 同口径） |
| 16 | 明暗两态 | ⏭ 跳过 | 夹具页用全站默认（暗色）。两态口径由 `globals.css` 的主题变量与 antd token 承担，本轮未逐态复核——**记为未覆盖项** |
| 17 | 流式动效「在动」 | ⏭ 跳过 | 夹具都是**终态**（`assembly: 'snapshot'`，`Turn.running` 全 false），没有真的在流的行可看。类名与「块结束后摘掉」由单测钉住（`text-block-view.test.tsx` / `agent-run-state-tag.test.tsx`），**「动没动」记为未覆盖项** |

## ② 操作路径

1. `next dev -p 3083` → 打开 `/dev/agent-log`；
2. 分段控件切 `dsh` → 抽屉默认打开 → 逐轮核对（含滚到底看第 4 轮）；
3. 工具条点「环境信息」→ 核对摘要与四组 → 点遮罩关闭；
4. 切 `codex` → 重新打开抽屉 → 核对「补录 / 摘要 / 汇总」；
5. 切 `claude-code` → 重新打开抽屉 → 核对「未转发」那一档。

## ③ 证据（浏览器状态）

- 轮次：`轮次 4 轮`（进度条）与 `已渲染 3 / 共 4 轮`（列表护栏）同时可读，两处不再互相打脸；
- 虚拟滚动：`.ant-listy-holder` 的 `scrollHeight = 1572` / `clientHeight = 411`，程序化滚到底后第 4 行进入 DOM；
- dsh 的九类内容全部出现：正文 / 思考 / 工具组（含失败行）/ 计划清单 / 问答卡片 / 子任务条 / 附件（图片 + 内联文件）/ 未识别载荷 / 孤立结果；
- codex：`补录`、`摘要`、`汇总` 三个 Tag；
- claude-code：「该子任务的对话未转发（只投送了工具调用）」。

## ④ 冒烟中发现并当场修掉的两处

1. **`轮次 4 / 3 轮`**：进度条曾把行快照里的 `EvalRow.turns` 当分母，而它与时间轴的轮次数不是同一把尺子。处置：`buildAgentLogModel` 用**时间轴自己的轮次数**当 `current`，`total` 恒 `null`；`buildRowFacts` 不再写分母。守卫 `build-model.test.ts` 的「故意传一份自相矛盾的 `facts.turns`」用例。
2. **`row-summary` 被画进每一轮**：`kind: 'row'` 的说明行是**整个节点**的事实，两轮的节点上出现了两句一模一样的「汇总 …」。处置：`buildRenderBlocks` 加 `firstTurn` 上下文，只在该节点的第一轮之后画一次。守卫 `render-blocks.test.ts` 的「不是第一轮时不出现」用例。

---

# 真机冒烟（2026-10-03）

**起因**：夹具全绿，而**真实评测**里抽屉显示「还没有日志 · 这一行还没开始执行」，
同一行的「原始输出」却有 184 条。夹具能画不等于真机有数据——这一次的缺口全部落在
**UI 之前**（适配器与投影），故补一轮真机冒烟，逐条核对 v3 的每种结构。

## 一、修掉的八个缺陷

| # | 缺陷 | 症状 | 修法 |
|---|---|---|---|
| 1 | **claude-code 的消息整批被丢掉** | 抽屉永远显示「还没有日志」，而「原始输出」有 184 条 | 消息归一器与事件投影**共用 `state.seen`**，而 `project()` 总是先跑事件投影（它把 `uuid` 记进去）⇒ 每条 `assistant` / `user` 消息在消息侧都被判成重复。改为**消息侧自持一张去重表**（`providers/claude-code/message.ts`）。守卫 `message-channels.test.ts`（把两条通道喂同一批输入） |
| 2 | **子任务的派发点认不出来** | 主会话时间轴上没有「进入子任务」入口、面包屑只有「主会话」，而 `messages.jsonl` 里有子任务记录 | 契约给 `SubagentRecord` 补 **`parentCallId`**（「派生它的那次工具调用 id」，claude 取 `task_progress.tool_use_id`；dsh/codex 给不出记 `null`）。`buildAgentLogModel` 以它为**首选**判据，名字回填降为兜底 |
| 3 | **「进入 ▸」看得见、点不动** | 点按钮没有任何反应（面包屑不换级） | `VirtualTurnList` 的 `TurnRenderContext` 漏传 `onEnterNode` / `onRetryNode` / `onRequestDiagnostics` 三个出口，补齐 |
| 4 | **子任务占位条的三格竖排** | 「派发方式」四个汉字各占一行、`spawn` 逐字符断行 | 三格原来用 `Descriptions column={3}`；抽屉里最窄的一处放不下固定三列。改 `Flex` 手摆，每格 `flex: 1 1 180px`（窄了换行，不挤成竖排）。实测「派发方式」标签 201×22（修复前是一个字一行） |
| 5 | **失败 / 被终止的 codex 行内容全丢** | 跑挂掉的那一行抽屉里**永远空着**，而它的会话文件有几百 KB 真实内容 | 收尾投影（读会话文件）原来只在 `failure === null` 时调用。改为**在 `finally` 里调用**（正常完成 / 失败 / 终止都收尾），仍**排在 `dispose` 之前**。守卫 `turn.test.ts` 的「收尾投影的调用时机」四条 + `codex/transcript.test.ts` 的失败路径用例 |
| 6 | **站在子任务上回不去主会话** | 面包屑里「主会话」那段是个**灰项**：下拉里只列了它自己、且被标 `disabled`，抽屉上没有任何回退入口 | 兄弟列表的判据写成了 `candidate.parentId === node.parentId`——`node` 是**这一段自己**，而主会话的 `parentId` 是 `null` ⇒ 列表里只有它自己。改正为「这一段的**父节点**的子节点」；并补上第二条：**同层只有一个时不给下拉，整段自己可点回退**。守卫 `log-node-breadcrumb.test.tsx` 的「站在子任务上点主会话那一段就回得去」 |
| 7 | **子任务空态说的是行级文案** | 点进子任务看到「还没有日志 · **这一行还没开始执行**，或执行尚未产生输出」——而这一行明明跑完了 | 节点级空态**排在模型级空态之前**：站在子任务上时 `model.empty` 与「本节点无内容」同时成立，只有分开说才不会自相矛盾。文案按「有没有 `outcome`」分两句：有 ⇒ 明说记录没有、摘要在占位条里；没有 ⇒ 带能力声明里的原因。守卫 `agent-log-layout.test.tsx` 的两条新用例 |
| 8 | **子任务的对话看不到（进去是空的，而消息就在文件里）** | 点「进入 ▸」后子任务节点 0 轮，真机实测 20 条消息**一条都没被认领** | **同一条子任务用了两套 id**：记录的身份是厂商原生 id（claude `task_id`、dsh `agentId`），消息却挂在**派生它的那次工具调用 id** 上（claude `parent_tool_use_id`）。按 `subagentId` 分桶时子任务的消息全部落回主会话或被丢。修法：用 `parentCallId` 建别名表（`build-model.ts` 的 `aliasOf` / `sessionKeyOf`），分桶前解析一层——**纯搬运，没有启发式**。守卫 `build-model.test.ts` 的「消息挂的是派发调用的 id、记录挂的是子任务身份」 |
| 9 | **codex 运行期一个字都没有**（用户口径：「Codex 执行日志看不到内容」） | 真机跑了两分多钟、29 轮，抽屉**空着**；只有等整段跑完（或失败/被终止）才可能一次性出现内容 | codex 是**唯一**一家内容只走会话文件的适配器（事件流缺工具真名、结构化入参与 `call_id` 配对键），而读盘原来只在 `finalize` 里做。改成**运行期节流刷新 + 收尾再读一次**：拿到主线程 id 后，每个事件按「已完成条目数变了没」+「距上次读盘够不够 500 ms」两道闸门决定要不要重读；交出时再按 `mergeKey` 判三条——**块数变了立刻交**（结构性进度）、**块数没变只是内容又长了至多每 3 s 交一次**、**逐字段相同不交**。守卫 `codex/transcript.test.ts` 的「流还没跑完就先交出内容」 |
| 10 | **dsh 的子智能体一个字都没有**（用户口径：「dsh 展示的不对」） | 占位条在、点进去**没有内容**；真机一整轮跑完，落盘文件里只出现过主会话一个 id | **放行判据写错了**：通知订阅原来「认领第一个带 `sessionId` 的通知、之后只放行同一个 id」，而**子会话的事件在同一条通知流里**、`params.sessionId` 是子会话自己的 id（真机探针：主会话 `session-e8c4…`、子会话 `7be765b2-…` 反复交替到达）⇒ 子智能体的 `assistant/message` / `tool/*` **全部被丢掉**。改成按**会话树**放行（顶层通知一律放行 + 本会话 + 已登记的子会话），并把「子会话 id = 子任务身份」登记进归属表（真机的身份在 `subagentId` 上，**不在** `childSessionId` / `agentId` 上）。守卫 `dsh/index.test.ts` 的「dsh 通知流的放行判据（会话树）」三条 |
| 11 | **codex 没有子智能体面板**（用户口径：「codex 没有看到 subagent 消息」） | 事件流里连 `collab_tool_call` 都没有；真机会话文件里 `spawn_agent` 的返回是「Subagent dispatch requires multi-agent support … `multi_agent = true`」——一次**失败的工具调用** | 适配器**显式关掉了** `features.multi_agent`（旧护栏，理由是「网关对命名空间工具回 400」），而关掉只影响工具注册、**换不来「安静地没有子任务」**：模型仍然会试、代价照付、面板恒空。改为 `features.multi_agent=true`（与 claude / dsh 两家口径一致）。真机实测：置 `true` 后同一道题立刻产出 `collab_tool_call`、`receiver_thread_ids` 带上子线程 id、`.agenthome/sessions` 下出现**第二份** rollout |
| 12 | **codex 的 `collab_tool_call` 什么都不产出** | 那条 item **没有 `text` 字段** ⇒ 一路落到「未识别事件」，抽屉里只剩一坨原始 JSON；而 `projectCodexEvent` **从来没有 `subagents` 出口** | 加 `collab_tool_call` 分支：**子任务行**（身份取 `receiver_thread_ids[0]`、名称取 `prompt` 首行、终态取 `agents_states[].status`）+ **派发调用那一条消息**（`tool-call` 块）。后者是必需的：界面上「进入子任务」的入口挂在**派发工具调用**上，只交子任务行 ⇒ 占位条根本画不出来。事件流侧没有厂商的 `function_call.call_id`，故以**条目 id 作为配对键**（调用块与子任务行两侧同值）。守卫 `codex/events.test.ts` 的四条 |
| 13 | **派发点可能认到「收场」那一步** | 同一条子任务的协作记录会来好几条（`spawn_agent` → `wait` → `close_agent`），每条都带同一个 `subagentId` | `buildAgentLogModel` 的➀判据原来「先到先得」⇒ 认领的可能是 `wait` / `close_agent`，入口挂到收场那一步上。加**派发动作判据**（`spawn` / `task` / `agent` 归一类），认不出来就不认领、交给启发式。守卫 `build-model.test.ts` 的「多条协作记录时，派发点认的是 `spawn_agent` 而不是 `close_agent`」 |
| 14 | **codex 子任务里面没有日志**（用户口径，2026-10-03） | 子任务行在、点进去**一个字都没有**；真机子会话文件 266 KB / 47 个条目（`AgentMessage` / `Reasoning` / `CommandExecution` 俱全）躺在盘上 | **四处叠加**，逐个修：① `noteThreadIds` 只认顶层 `type === 'collab_tool_call'`，而真机外形是 `{type:'item.completed', item:{type:'collab_tool_call', …}}` ⇒ `childThreadIds` **永远是空的**，子会话文件从来没被读过；② `projectCodexMessages` 只给子线程建了一条**行**、**没有投影它自己的轨迹**（v3 §4.2 步骤 5 要求「读出完整轨迹」，这格是漏实现）⇒ 补 `threadMessages(child, threadId)`；③ 运行期 `refreshContent` 有一道「内容条数变了没」的提前返回，而「子线程出现了」只能**读完之后**才知道 ⇒ 那道闸门会整段跳过子会话（只留时间闸门，去重交给 `changedMessages`）；④ 收尾那次交出的子任务行 `parentCallId`/`kind` 恒为 `null`（子线程文件里没有这两格），会**覆盖**事件流那条 ⇒ 从**父会话文件**的协作条目配对取（`dispatchIndex`）。真机结果：子任务自己的消息 **0 → 97 条**、`kind=spawn_agent`、`parentCallId=call_00_VO2c…`（与主会话里那次派发调用同值） |
另外补上一条**规范明文要求、而界面此前无处落点**的数据：`tool-result.structured`
（规范：**有 `meta` 就不要退回去解析文本**）此前在 `buildAgentLogModel` 里被丢掉，
于是 dsh 已解析过的行数、命中数、改动对象在界面上完全看不见。
现在 `ToolOutput` 带上它、`tool-item-detail` 渲染成等宽的「结构化结果」（不做族专属渲染，
沿用 §12.6 的既有取舍）。

| 15 | **环境信息里是空的，三家都是空的**（用户口径，2026-10-03） | 点「？环境信息」永远显示「未提供」；三家一视同仁 | **这个模型从来没有生产者**。`AgentEnvironment` 只定义在 `@aieval/ui`，而设计 §4.3 写的是「进 `@aieval/contracts`」——落在 ui 的后果是任何生产者都得依赖 ui，而 `client` 按分层表**不依赖 ui** ⇒ 没有 hook、没有端点、页面从来没传过 `environment`。三件事让它活了下来：prop 是**可选**的、`undefined` 在界面上是**设计好的**「未提供」（不是空白、不是转圈）、而 `apps/web-next` 不能写 `.tsx` 测试 ⇒ 「页面接线」这类缺口没有任何用例看得见。修法：① 类型移到 `packages/server/contracts/src/agent-environment.ts`（ui / client 各自 `export type` 转出，路径不变）；② 新增 `packages/client/client/src/build-environment.ts`（`buildAgentEnvironment` 纯函数，四组全部从**已经拿在手上**的数据拼——`EvalRow`/`EvalRun` 的快照字段、事件流里的 `system/init` 行、内容记录里的 `tool-call` 计数，**不新增端点**）；③ 页面把 `environment` 与 `requestEnvironment` 接上。真机三家逐家核过：claude 有 21 个工具 / 47 条斜杠命令 / 5 个子智能体定义 / 权限档 `bypassPermissions`；codex 与 dsh 的厂商层如实显示「厂商有数据、但没投送到我们能读的通道」（真机事件流里确实没有 `system/init` 这类行），实测统计分别是 `exec_command × 17 / close_agent × 2 / spawn_agent × 2 / wait × 1` 与 `grep/pwsh/read/subagent/write × 1` |

## 二、v3 的每种结构 → 抽屉里的落点与实测

| v3 结构 | 抽屉里的落点 | 实测 |
|---|---|---|
| `text` 块（§2.2） | 轮次里的 markdown 正文 | **真机**：claude 4 轮、dsh 7 轮都有；`index.html` 这类行内代码渲染成 `<code>` |
| `thinking` 块（§2.2 / §10.1） | 折叠面板「思考」+ `textKind` 标「摘要」 | **夹具**：`exec-log-fx-*.png`（本机两家的模型都没产出推理块 ⇒ 真机 0 条，见未闭合项 4） |
| `tool-call` 块（§2.2 / §10.2） | 工具组里的工具行（名字 + 参数摘要 + 族 Tag） | **真机**：dsh `pwsh` / `write` / `read` / `edit` / `subagent`；claude `Bash` / `Write` / `Read` / `Agent` |
| `tool-result` 块（§2.2 / §10.2 / §10.6） | 工具行展开后的等宽原文 + 「结构化结果」+ 截断三态 | **真机**：dsh `read` 带 `{path, offset, lines[], totalLines}`、`write` 带 `{operation, diffs[]}`、`edit` 带 `{diffs[]}`；截断显示「输出可能不完整（没采到截断标记）」 |
| `attachment` 块（§2.2） | 类别 + 路径 + MIME；`path === null` 写「内联内容，无路径」；**不加载缩略图** | **夹具**（真机这两轮没有附件） |
| 未识别载荷 | 默认收起的「未识别的厂商载荷」+ 厂商类型 | **夹具**（与附件走两条路） |
| `SubagentRecord`（§2.6 / §10.3） | 主会话时间轴上的**子任务占位条** + 面包屑可进（进去是那个子任务自己的时间轴） | **真机**：claude `子任务 a8701380 · 已完成 · general-purpose`，点「进入」后子任务时间轴上真的出现它自己的那一轮（`轮次 3 · 已实际读取 … index.html（共 76 行）… 结论：通过`）；dsh `Review Vue 3 CDN page · 已完成 · spawn · 用量未采集`；面包屑 `主会话 / …` 的「主会话」那段可点回退（实测点回后退回主会话 4 轮） |
| `usage` 事件（§2.4 / §10.4） | 固定区事实条：输入 / 缓存 / 输出 / 轮次 / 耗时 | **真机**：dsh `输入 3,763 · 缓存 70,784 · 输出 3,108 · 轮次 7 · 耗时 49s`；思考 token 为 `null` 时**整格不出现**（不写 0） |
| 增量与快照（§10.5） | 同一 `mergeKey` 只留最后一条；`assembly === 'open'` 才挂流式光标 | 守卫覆盖；真机跑完即终态 |
| 未采集的表达（§10.6） | 「未采集」与 0 / 空串严格分开 | **真机**：`用量未采集`、`参数未采集`、`结果未采集 · <原因>`、`状态未采集` |
| 行级事件（§2.3） | 事实条 + 轮末里程碑/错误行；`log` 走「原始输出 N 条」 | **真机**：dsh `原始输出 41 条`、事实条 `结束原因 completed` |

**codex 的取数通道与另两家不同**（规范 §4.2 明文）：消息来自**读会话文件**（CLI 边跑边追加的那份
`rollout-*.jsonl`），事件流那条通道一条消息都不产出 ⇒ 内容由**运行期节流刷新**逐段出现、
收尾再补最后几行。真机实测（2026-10-03 19:1x）：
- 跑了两分多钟时 `messages.jsonl` 是 **5.69 MB / 722 条记录 / 61 个 `mergeKey`**，
  抽屉里 `执行中 · 轮次 34 轮 · 耗时 2m51s · 原始输出 88 条`，**内容与轮次数一起涨**；
- 同一条逻辑消息最多被写 **31 次**（`mergeKey` 有 61 个、记录 722 条）。
  中间两版实测的对比说明这道闸门是必要的：**每次全量重发**时是 34.5 MB / 每条最多 **171 次**；
  只做「逐字段去重」时是 12.4 MB（同一条消息仍在每 500 ms 重写一次）。
  「块数变了立刻交、只是变长了每 3 s 一次」之后才落到 5.69 MB。

## 三、未闭合项

1. **codex 那一行的 CLI 进程在本机会卡死**（环境）：真机实测两次 —— 一次跑 9 小时、CPU 停在
   12.5 s 不动，一次在 778 KB 会话文件处停住 7 分钟不再写。两次都不是本仓代码引起的
   （进程还在、只是不再产出），停掉它之后走的是「服务重启 ⇒ 标记 interrupted」那条路。
   *已核实的是*：那一行**历次尝试留下的全部会话文件都能投影出内容**
   （逐份跑过 `projectCodexMessages`：2 / 2 / 11 / 0 / 207 条消息，最大那份含
   `thinking` / `text` / `tool-call` / `tool-result` 四种块）；而**运行期刷新**与
   **`multi_agent` 打开之后真的派子智能体**这两条都已在真机上取到现场证据
   （`collab_tool_call` 0 → 3、`receiver_thread_ids` 带上子线程 id、`.agenthome/sessions`
   下出现第二份 rollout、子任务行落进 `messages.jsonl`）。
2. **`truncation` 三态在适配器侧恒为 `unknown`**：三家都没报截断标记，界面上因此永远显示
   「输出可能不完整」。这是规范要的诚实表达，也意味着那一格目前没有正向信息。
3. **思考文本**：dsh / codex 都有（codex 运行期的 `思考` 块已截图），claude 本机三轮都没产出推理块
   ⇒ 那一家的「思考块」只在夹具页覆盖。
4. **明暗两态与流式动效**未逐态复核（没有专门造过明暗两套截图）。
5. **本机的 `packages/server/evaluator` 用例跑不起来**（环境，与本次改动无关）：
   `orchestrator-*.test.ts` 在本机会挂住（无输出、无子进程），而 `route-cases.test.ts` /
   `cases-crud.test.ts` / `git-repo-*.test.ts` / `workspace-prepare.test.ts` 报
   `EPERM … \Temp\aieval-*`——同一个根因：本机进程在 `%TEMP%` 下建临时目录被拒。
6. **codex 子任务面板的完整闭环**：数据层已通并逐条核过（真机 `messages.jsonl`：
   子任务行 `kind=spawn_agent` / `parentCallId=call_00_VO2c…`、它自己的 **97 条**消息、
   主会话里那次派发调用同值存在；`buildAgentLogModel` 的产物 `spawnedBy.callId` 与之一致，
   纯函数 `buildRenderBlocks` 也确实在派发那一轮产出了 **1 条 `subagent-bar`**）。
   但**在浏览器里没有截到那一屏**：抽屉里找不到「子任务 … 进入 ▸」。
   缺口在时间轴的**渲染侧**（`agent-message-timeline` / `virtual-turn-list` 这一层），
   不在适配器、也不在 `build-model` / `render-blocks` 这两个纯函数里。
   该目录当时正被另一个会话并发改写（`ask-user-card.tsx` / `agent-log-layout.tsx` /
   `virtual-turn-list.tsx` / `agent-log-drawer.tsx` 在我操作期间被反复改动，
   且 `agent-log/` 整个目录尚未纳入 git），故**没有**在这一轮去改它。
   *（对照：claude 那一行的子任务占位条在真机上可见——见 `exec-log-env-claude.png` 里
   `轮次 3` 之后的 `子任务 子任务 a8701380 已完成 进入 ▸ 重试`。所以缺口只出现在 codex 那一侧。）*
7. **环境信息里几格本仓还没接**（如实显示、不是缺陷）：系统提示词正文、工具模式串、
   附件与上下文引用、被禁用的工具名单——四格都显示「厂商有、我们还没接」（`not-observed`）。
   其中前两格要接得**改协议**（当前 `system/init` 只报工具**名字**）。
   验收要求是「拿不到就说拿不到」，故这四格是**正确的现状表达**而不是待办清单；
   要真接上，得先在适配器侧把系统提示词与工具 Schema 投送到我们能读的通道。

## 四、截图

都在 Playwright MCP 的允许根 `~/.dsh/profiles/desktop/.playwright-mcp/`（不在仓库里）：

| 文件 | 内容 |
|---|---|
| `exec-log-dsh-subagent-fixed.png` | **dsh 子任务修复后**：面包屑 `主会话 / Review hello world page`，子任务自己的三轮（`轮次 3 I'll read the file first.` → `工具调用 × 1 read` → `轮次 5 Code Review: index.html` / `Overall verdict: PASS WITH ISSUES`）——修复前这里是空态 |
| `exec-log-env-claude.png` | **环境信息（claude-code，真机）**：摘要七项 + 用户层（两格如实记「厂商有、我们还没接」）+ 系统层（`已调度的工具` 逐项 21 个）+ 运行配置 + 实测统计 |
| `exec-log-env-codex.png` | **环境信息（codex，真机）**：厂商层整组如实显示「**厂商有数据、但没投送到我们能读的通道**」（`not-exposed`，不是空白、也不是「这家没有」）+ 实测统计 `exec_command × 17 / close_agent × 2 / spawn_agent × 2 / wait × 1` |
| `exec-log-subagent-messages-fixed.png` | **claude 子任务**（基准形状）：面包屑 `主会话 / 子任务 a8701380` + 子任务自己那一轮的完整答复 |
| `exec-log-subagent-empty-honest.png` | 子任务真没有内容时的空态：说明「这一家没把它的往返投送到我们能读的通道」+ 指向占位条 |
| `exec-log-codex-live.png` | **真机 codex 运行中**：事实条 `执行中 · 轮次 34 轮 · 耗时 2m51s`、`实时连接中`，时间轴逐轮的 `思考` / 工具组，护栏 `已渲染 11 / 共 34 轮` |
| `exec-log-codex-live-thinking.png` | 同一行更早一次尝试（`轮次 38 轮 · 耗时 2m29s · 原始输出 78 条`）：内容与轮次数一起涨 |
| `exec-log-dsh-subagent.png` | 子任务占位条**修复前**：三格竖排（缺陷形状留档） |
| `exec-log-dsh.png` | dsh 行抽屉：事实条 + 工具条 + 轮次 1–3（正文 + 工具组 + 已渲染护栏） |
| `exec-log-real-structured.png` | **真机** dsh 的工具行展开：结果原文 + 「输出可能不完整（没采到截断标记）」+ 结构化结果 `{path, offset, lines[], totalLines}` |
| `exec-log-tool-detail-structured.png` | **真机** claude 的工具行展开：`参数原文 1643 字节` + 结果 + 截断三态 + 结构化结果（`write` 的 `{type:'create', filePath, content}`） |
| `exec-log-fx-attachment-unrecognized.png` | **夹具**：附件块（`文件` / `内联内容，无路径` / `application/pdf`）+ 未识别载荷（`未识别的厂商载荷 session/title`）+ 问答卡片入口 |
| `exec-log-claude-expanded.png` | 真机 claude 行：全部折叠项展开（原始输出全文） |



