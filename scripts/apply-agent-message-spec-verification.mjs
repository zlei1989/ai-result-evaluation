/**
 * 把 2026-09-30 真机验证轮的结论**回写**进设计稿（合并两批，共 25 处）。
 *
 * 为什么用脚本而不是逐条手改：要改 25 处，每处都必须**恰好命中一次**——
 * 写错锚点会静默不改（或改错位置）。本脚本对每条替换断言「原文出现次数 === 1」，
 * 任何一条不满足就整体失败、不落盘（这个文件同时有别的会话在改，宁可不动也不能改错）。
 *
 * ⚠️ 本文件必须由**支持 UTF-8 的工具**写盘：曾用 `Get-Content -Raw` + `Set-Content -Encoding utf8`
 * 在 PowerShell 里做字符串替换，结果把中文整体转成乱码——**不要再用那条路子改它**。
 *
 * 用法：node scripts/apply-agent-message-spec-verification.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FILE = 'docs/superpowers/specs/2026-09-30-agent-message-spec-design.md';
const CHECK_ONLY = process.argv.includes('--check');
/** 证据报告的相对链接（specs/ → notes/）。 */
const EVIDENCE = '[验证报告](../notes/2026-09-30-agent-message-spec-verification.md)';

const EDITS = [
  {
    name: '0.2-2 falsified: subagent IS in the event stream',
    from: '- ⇒ **子智能体数据永远不可能从 `runStreamed` 拿到**，只能走 hook 或 rollout 会话文件。',
    to: `- ⇒ **子智能体数据永远不可能从 \`runStreamed\` 拿到**，只能走 hook 或 rollout 会话文件。

> ### ⚠️ 上面这一条已被真机**推翻**（2026-09-30 验证轮，证据见 ${EVIDENCE}）
>
> **事件 \`type\` 封闭 ≠ \`item.type\` 封闭**——初稿把两者混为一谈，于是得出了一个错误的"永远"。
>
> | 实测（codex 0.154.0，\`multi_agent\` 真的跑起来时） | 结果 |
> |---|---|
> | 事件 \`type\` 全集 | \`thread.started\` · \`turn.started\` · \`item.started\` · **\`item.updated\`** · \`item.completed\` · \`turn.completed\`（**6 种**，不是 5 种） |
> | 事件联合本身 | 确实没有 subagent 变体（初稿这一点是对的） |
> | **\`item.type\` 里的子智能体变体** | ✅ **存在**：\`collab_tool_call\`，字段 \`tool\` / \`sender_thread_id\` / \`receiver_thread_ids\` / \`prompt\` / \`agents_states\` / \`status\` |
>
> \`\`\`jsonc
> {"type":"item.started","item":{"id":"item_3","type":"collab_tool_call","tool":"wait",
>   "sender_thread_id":"01a0f2d8-…","receiver_thread_ids":[],"prompt":null,
>   "agents_states":{},"status":"in_progress"}}
> \`\`\`
>
> ⇒ 修正后的口径：**子智能体在事件流上有投影**（\`collab_tool_call\`），
> **hook 仍是更完整的带外通道**（hook 带 \`agent_id\` / \`agent_type\`，\`collab_tool_call\` 不带）。
> 「必须走 hook」的**设计结论仍成立**（§6 的 \`source\` 字段照样必需），
> 但立项理由要从"事件流拿不到"改成"**事件流给的身份不如 hook 完整**"。`,
  },
  {
    name: '6.5.2 dsh non-ok values captured',
    from: '| `status: <非 ok>` + `stopReason` | 待实测（失败/取消的形态**没抓到**） | 需另跑 |',
    to: `| **\`status: "error"\` + \`stopReason: "aborted"\`**（2026-09-30 **已抓到**） | \`'canceled'\` | 真机：父智能体 \`interrupt_agent\` 掉一个正在跑的后台子任务，载荷逐字 \`{"status":"error","stopReason":"aborted",…}\`（${EVIDENCE}） |`,
  },
  {
    name: '6.5.2 stopReason is the criterion',
    from: `⇒ 真机只覆盖了**成功路径**。失败/取消的 \`status\` 取值**未验证** ⇒ 未知取值**原样透出**，
不假装映射成 \`'failed'\`（与 §7.5.1 的 \`stderr\` 口径同一原则）。`,
    to: `⇒ **取消路径已于 2026-09-30 实测**（见上表新增行）；**失败**（非取消）路径仍未覆盖。

> **⚠️ 判据必须是 \`stopReason\`，不能只看 \`status\`**（2026-09-30 真机更正）：
> 取消时厂商给的是 \`status: "error"\` + \`stopReason: "aborted"\`——\`"error"\` 字面像"失败"，
> 而真实语义是**主动取消**。若只按 \`status\` 映射，一次主动取消会被记成"子任务失败"，
> 正是本仓最忌讳的假数据。⇒ \`mapSubagentStatus()\` 必须**同时**读两格。
>
> 同轮另一条实测：被取消时 \`lastAssistantMessage\` 里**可能只有 \`reasoning\` 块、没有 \`text\` 块**
> ⇒ \`outcome\` 在那一格必须是 \`null\`，**不得**退而取 reasoning 文本。
>
> 未覆盖的失败路径继续"未知取值原样透出"，不假装映射成 \`'failed'\`（与 §7.5.1 的 \`stderr\` 口径同一原则）。`,
  },
  {
    name: '7.2 add tool/result.meta',
    from: "| `type==='tool/result'` | `tool-result` 块：`callId` = `data.message.toolCallId`，`status` 按 `data.message.isError` |",
    to: `| \`type==='tool/result'\` | \`tool-result\` 块：\`callId\` = \`data.message.toolCallId\`，\`status\` 按 \`data.message.isError\` |
| **\`type==='tool/result'\` 的 \`data.meta\`**（2026-09-30 补：初稿漏了这一整块） | **族结构的权威来源**——\`read\` 给 \`{path,offset,lines[],totalLines}\`、\`glob\` 给 \`{shape:'paths',paths[],truncated,total}\`、**\`grep\` 给 \`{shape:'matches',files[{path,matches[{lineNumber,line}]}],truncated,total}\`**、**\`write\` 给 \`{operation:'create'\\|'update',diffs[]}\`**、**\`edit\` 给 \`{diffs[{path,oldText,newText}]}\`**。**有 \`meta\` 就不要解析文本** |`,
  },
  {
    name: '7.2 add reasoning-chunks',
    from: "| `data.stream[].type==='text-chunks'` | `message` 事件，`chunk: 'delta'`，`blocks[].text` = 增量文本 |",
    to: `| \`data.stream[].type==='text-chunks'\` | \`message\` 事件，\`chunk: 'delta'\`，\`blocks[].text\` = 增量文本 |
| **\`data.stream[].type==='reasoning-chunks'\`**（2026-09-30 补） | 同上，内容是**推理**的增量 |`,
  },
  {
    name: '7.2 add tool-call-chunks (contradicts 8.1)',
    from: "| `data.stream[].chunk.type==='block-end'` | `message` 事件，`chunk: 'snapshot'`（完整块） |",
    to: `| \`data.stream[].chunk.type==='block-end'\` | \`message\` 事件，\`chunk: 'snapshot'\`（完整块） |
| **\`data.stream[].type==='tool-call-chunks'\`**（2026-09-30 补） | 同上，内容是**工具调用**的增量。⚠️ §8.1 写的「dsh 的工具调用都没有 token 流」**与实测不符**——真机 16 条命中 |`,
  },
  {
    name: '7.3 item.delta verified absent',
    from: "| `item.delta` | `message` 事件，`chunk: 'delta'`（**待真机验证**：`ItemDelta` 存在于上游 `ThreadEvent`，但本仓实测的事件形状里文本是**累积**的，未观察到 delta 变体） |",
    to: "| `item.delta` | **实测不存在**（2026-09-30）：多轮运行里 `含 delta 的行数 = 0` ⇒ codex 侧 `chunk` **恒为 `'snapshot'`**，`streamingDelta: 'no'` |",
  },
  {
    name: '7.3 todo_list landing corrected',
    from: '| `item.*` + `item.type===\'todo_list\'` | **见下**——初稿写「`attachment` 块」，与 §7.6.2.2 的"面板靠工具面重建"**矛盾**，已更正 |',
    to: "| `item.*` + `item.type==='todo_list'` | **`task` 族的唯一来源**（2026-09-30 实测确认，见 §7.3.1）：`item.started/updated/completed` 三态都发，载荷是 `{id, type:'todo_list', items:[{text, completed}]}`。**它不是 `attachment`** |",
  },
  {
    name: '7.3 add collab_tool_call row',
    from: '| **子智能体生命周期** | **不在本事件流上**——走 hook / session-file，见 §7.5 |',
    to: "| **子智能体生命周期** | **部分在事件流上**（2026-09-30 更正）：`item.type==='collab_tool_call'`，带 `tool` / `sender_thread_id` / `receiver_thread_ids` / `prompt` / `agents_states` / `status`；但**不带 `agent_id`/`agent_type`** ⇒ 完整身份仍走 hook / session-file，见 §7.5 |",
  },
  {
    name: '7.3.1 title -> resolved',
    from: '#### 7.3.1 两个开关打开后，`update_plan` / `request_user_input` 落到哪个 item（**待验证**）',
    to: '#### 7.3.1 两个开关打开后，`update_plan` / `request_user_input` 落到哪个 item（**2026-09-30 已定案：候选 ①**）',
  },
  {
    name: '7.3.1 known/unknown table rows',
    from: `| 它**以哪种 \`item.type\` 出现在 \`exec --json\` 事件流里** | ❌ **未验证**——本机无可用 multi_agent 网关，仓库内也无 \`todo_list\` 探测样本，**不得推断** |
| \`todo_list\` 与 \`update_plan\` 是否同一个东西 | ❌ 未验证 |`,
    to: `| 它**以哪种 \`item.type\` 出现在 \`exec --json\` 事件流里** | ✅ **已实测（2026-09-30）：\`item.type === 'todo_list'\`**——\`item.started\` / \`item.updated\` / \`item.completed\` 三态都发 |
| \`todo_list\` 与 \`update_plan\` 是否同一个东西 | ✅ **是同一个东西**：模型每次调用 \`update_plan\`，事件流就多发一条同 \`item.id\` 的 \`todo_list\` |
| \`update_plan\` 到底是工具还是内部功能 | ✅ **是工具**：入站 \`tools[]\` A/B 实测 9 项 → 10 项，新增的正是 \`update_plan\`（插在 \`write_stdin\` 之后） |
| 事件流给的形状与工具输入是否一致 | ⚠️ **不一致**：工具描述是 \`{step, status}\`（三态、至多一个 \`in_progress\`），事件流只给 \`{text, completed}\`（**二态**）⇒ \`TaskStep.status\` 在 codex 上**恢复不出 \`in_progress\`** |`,
  },
  {
    name: '7.3.1 candidates -> candidate 1',
    from: `⇒ **候选落点（待实测择一，不要先写死）**：
① \`item.type === 'todo_list'\`（\`item.items: [{text, completed}]\` 已在 SDK 类型面出现，见 \`@openai/codex-sdk\` 的 \`TodoListItem\`）；
② 某个 plan 专用 item 类型；
③ 调用只以 \`agent_message\` 文本形式留痕（**若属实则 §7.6.2.2 的"工具面重建"方案不成立**，需改走 §7.5.4 的 hook/session-file 通道）。`,
    to: `⇒ **实测结论（2026-09-30）：候选 ① 成立**（真机原文见 ${EVIDENCE}）：
\`item.type === 'todo_list'\`，载荷 \`items: [{text, completed}]\`，与 \`@openai/codex-sdk\` 的 \`TodoListItem\` 同形。

- **候选 ② 否**（没有 plan 专用 item 类型）；**候选 ③ 否**（不是只在 \`agent_message\` 里留痕）
  ⇒ ✅ **§7.6.2.2 的"工具面重建面板"方案成立**，不必改走 hook/session-file；
- ⚠️ 但**契约要降级**：工具输入的 \`status\`（三态）在事件流里被压成 \`completed\`（布尔），
  适配器**拿不到 \`in_progress\`**。codex 的 \`TaskStep.status\` 只能映射成 \`pending\` / \`completed\`，
  第三态**必须如实标 \`unknown\`**，不能猜。`,
  },
  {
    name: '7.5.3 card A corrections',
    from: '这是**一行配置级**的改动，比改协议便宜得多。',
    to: `这是**一行配置级**的改动，比改协议便宜得多。

> ### ⚠️ 2026-09-30 验证轮的三条更正（证据见 ${EVIDENCE}）
>
> 1. **「codex 认识哪 3 个 slug」随版本变**：真机逐名探测（判据是 \`Model metadata for '…' not found\` 告警）
>    显示 **0.154.0 只认 \`gpt-6-astra\` 一个**，**不认 \`gpt-6-sol\` / \`gpt-6-luna\`**
>    （0.156.1 才是三个都认）。⇒ 下表是**版本相关**的事实，不能当成"codex 的能力"。
> 2. **\`gpt-5.6-sol\` 虽被认识、网关也有，却跑不通**：网关回
>    \`Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified.\`，
>    整个 turn 立刻 \`turn.failed\`。§9.4 把它列为"网关噪声"是**低估**——它是**致命**的。
> 3. **"gpt-6-\\* 只能由网关给"这条前提可以在本机绕开（仅用于探测）**：
>    \`gpt-6-astra\` 被 0.154.0 认识，而网关有对应的 \`gt-6-as-a\`；
>    在本机放一层**模型名中转**（逐块转发，见 §9.4.1 的教训）把 \`gpt-6-astra\` 改写成 \`gt-6-as-a\`，
>    codex 就会用**它自己那份带 multi_agent profile 的元数据**注册执行器，
>    \`spawn_agent\` 真的跑起来、\`SubagentStart\` hook 真的触发（§7.5.5 ⑩ 因此从"无法实测"变成"已抓到一半"）。
>    ⇒ **这不是产品解法**（产品仍应要求网关直接给带 profile 的名字），
>    但它证明：**卡点确实只在"名字"这一格**，与初稿的根因判断一致。`,
  },
  {
    name: '7.5.5-10 partially verified',
    from: `**⑩ 仍未验证的一格**

\`SubagentStart\` / \`SubagentStop\` **从未真实触发过**——因为 §7.5.3 牌 A 未解决
（无带 multi_agent profile 的模型名），\`spawn_agent\` 跑不起来。
上面两条 schema 来自二进制内嵌的 JSON Schema（权威），但**没有真实载荷样本**。
⇒ 牌 A 落地后必须先跑一次真机，核对 \`agent_id\` 的形态与 \`agent_transcript_path\` 是否可读。`,
    to: `**⑩ 验证进展（2026-09-30 更新：从"从未触发"变成"已抓到一半"）**

用 §7.5.3 更正 3 的**本机模型名中转**（\`gpt-6-astra → gt-6-as-a\`），
codex 0.154.0 的 \`spawn_agent\` **真的跑起来了**，hook **真的触发**：

- ✅ **\`SubagentStart\` 真实载荷已抓到**（逐字见 ${EVIDENCE}）：④ 的必填字段**逐字吻合**，
  实测值 \`agent_type: "default"\`、\`transcript_path\` **非 null**；
  ⑨「没有任何任务名/描述字段」**再次确证**——载荷里只有 \`agent_id\` + \`agent_type\`；
  ⑦ 的信任闸门也吻合（不带 \`--dangerously-bypass-hook-trust\` 就不执行）。
- ❌ **\`SubagentStop\` 仍未抓到**，但卡点已经变了：不是"没有模型名"，
  而是中转过去的 \`gt-6-as-a\` **流会在 \`response.completed\` 之前断开**，
  父轮次以 \`turn.failed\` 收场 ⇒ 子智能体走不到收尾。
  ⇒ §6.4 开头那条「\`SubagentStop\` 的 \`status\` 只有 schema 级证据」**仍然成立**；
  「无法实测」的定性应改为「**通道已证可触发，只差一个能跑通的上游模型**」。`,
  },
  {
    name: '7.6.2.1b A/B does not reproduce',
    from: `| | toolCount | 新增 | 移除 |
|---|---|---|---|
| 默认（不开开关） | **26** | — | — |
| \`CLAUDE_CODE_ENABLE_TODO_TOOLS=1\` | **30** | **\`TaskCreate\` · \`TaskGet\` · \`TaskList\` · \`TaskUpdate\`** | 无 |`,
    to: `| | toolCount | 新增 | 移除 |
|---|---|---|---|
| 默认（不开开关） | **26** | — | — |
| \`CLAUDE_CODE_ENABLE_TODO_TOOLS=1\` | **30** | **\`TaskCreate\` · \`TaskGet\` · \`TaskList\` · \`TaskUpdate\`** | 无 |

> ### ⚠️ 这张 A/B **在 2026-09-30 的验证轮里不重现**
>
> 同一个 CLI 版本（**2.1.281**，与本节采集时同版本）、**三个模型**
> （\`Claude-Sonnet-4.6\` / \`claude-haiku-4-5\` / \`Claude-Opus-4.8\`）× 两档开关，
> 共 6 次采集（\`system/init\` 与**入站 \`tools[]\`** 两处都看了）：
> **默认就是 30 项、开了仍是 30 项、增量恒为空数组**。
>
> | 模型 | 默认 | 开开关 | 新增 | 移除 |
> |---|---|---|---|---|
> | \`Claude-Sonnet-4.6\` | 30 | 30 | — | — |
> | \`claude-haiku-4-5\` | 30 | 30 | — | — |
> | \`Claude-Opus-4.8\` | 30 | 30 | — | — |
>
> ⇒ 结论改成：**\`Task*\` 在当前版本上已经是默认工具**；
> \`CLAUDE_CODE_ENABLE_TODO_TOOLS=1\` 变成**冗余的护栏**（留着无害，但**不能再当成"打开任务工具"的开关**）。
> D12「统一打开」的**目标仍然成立**（三家一致地不额外配置也能有规划数据），
> 但理由要从"不开就没有"改成"**开着以防版本回退**"。
>
> 仍然成立的部分：**\`TodoWrite\` 不在**、**\`AskUserQuestion\` 也不在**，
> 且这两者都**不因这个开关出现**（见 §11 第 11 / 16 项的更新）。`,
  },
  {
    name: '7.6.6 five rows closed',
    from: `| dsh 的 \`read\`/\`edit\`/\`grep\`/\`pwsh\` **结果**形状 | **部分已闭合**（2026-09-30 真机）：\`read\` 与 \`glob\` 已拿到真实形状（见 §7.6.3）；\`edit\`/\`grep\`/\`pwsh\` **仍无样本**——那一轮的提示词没触发它们。**未采样者仍按工具描述推断** |
| claude 的 \`Read\` 是否恒带 \`<system-reminder>\` | 未验证。若恒带，则必须剥掉；若只在特定条件带，\`lineNumbersIncluded\` 的判据要更细 |
| claude 的 \`Bash\` 能否拿到退出码 | 倾向**拿不到**（文本结果），但未真机确认 |
| codex 的 \`file_change\` 是否在 \`code_mode_only\` 下出现 | 未验证。若出现，应并入 \`edit-file\`（\`changes[].kind\` 映射到 \`applied\`） |`,
    to: `| dsh 的 \`read\`/\`edit\`/\`grep\`/\`pwsh\` **结果**形状 | ✅ **全部闭合**（2026-09-30 真机，逐字见 ${EVIDENCE}）：**结构化数据全在 \`tool/result.meta\` 里**——\`grep\` 是 \`{shape:'matches',files[{path,matches[{lineNumber,line}]}]}\`、\`write\` 是 \`{operation:'create'\\|'update'}\`、\`edit\` 是 \`{diffs[{path,oldText,newText}]}\`、\`pwsh\` 的退出码在文本尾部 \`[exit code: N]\`（成功时无此尾部）。**有 \`meta\` 就不要解析文本** |
| claude 的 \`Read\` 是否恒带 \`<system-reminder>\` | ✅ **已闭合**：2.1.281 / 2.1.283 上**不出现**（工作区内、外各读一次，3 次运行 0 命中）⇒ "必须剥掉"这一条**在本版不成立**（将来若出现，剥掉仍是对的）。附带坑：文本末尾**多一行空编号行**（\`6\\t\`），用"行号最大值"当 \`lineCount\` 会**系统性多算 1 行**；而结构化旁路直接给 \`totalLines\` |
| claude 的 \`Bash\` 能否拿到退出码 | ✅ **已闭合**：**没有**结构化退出码（\`BashOutput\` 类型面里根本没有 \`exitCode\`）；失败时退出码在**文本**里——\`tool_result\` 正文是 \`"Exit code 3"\`、结构化旁路是字符串 \`"Error: Exit code 3"\`；成功时结构化旁路给 \`{stdout, stderr, interrupted, …}\` ⇒ ①\`exitCode\` 只能从失败文本解析、成功时保持 \`null\`（**不填 0**）；②**\`stdout\`/\`stderr\` 是分开的**，"三家都只给合并后的"对 claude 不成立；③长输出另有 \`persistedOutputPath\` ⇒ \`outputPath\` 有真来源 |
| codex 的 \`file_change\` 是否在 \`code_mode_only\` 下出现 | ✅ **已闭合**：**不出现**。一次"新建文件 + 改文件"的任务里两次都走 \`command_execution\` ⇒ 该族在 codex 上确实恒由 shell 承载 |`,
  },
  {
    name: '7.6.8 ReportFindings axes corrected',
    from: '| `ReportFindings`(cc) ※ | `deliver` | `agent`（语义待查，开放问题 6） |',
    to: '| `ReportFindings`(cc) | `deliver` | **`user`**（2026-09-30 查清：它是**代码评审结论的结构化上报口**，面向**宿主 UI**；原占位 `agent` 是错的） |',
  },
  {
    name: '11-6 resolved',
    from: `6. **\`ReportFindings\` 的语义未查清**（claude 独有）——按 §7.6.0「未收录 ⇒ \`null\`」的口径，
   在查清前它应保持两轴为 \`null\`，不写兜底值。暂按 \`deliver / agent\`
   占位（语义上像是"把结论交付给调用方"），待真机确认。`,
    to: `6. ~~**\`ReportFindings\` 的语义未查清**~~ **已查清（2026-09-30 真机）**：它是
   **代码评审结论的结构化上报口**，面向**宿主 UI**（工具描述逐字："Report **code-review findings** as a
   typed list so **the host UI can render them**"），输入是
   \`{level?, findings:[{file, line, summary, short_summary?, failure_scenario, category?, verdict?, outcome?}]}\`。
   ⇒ 两轴取 **\`deliver\` / \`user\`**（§7.6.8 已改）；原占位 \`deliver / agent\` 是错的。
   **本项关闭。**`,
  },
  {
    name: '7.8.1-1 needs prompt opt-in',
    from: '（**如实登记**：这意味着提示词里出现 `ultracode` 会额外提高触发率——评测提示词要避免无意带上它。）',
    to: `（**如实登记**：这意味着提示词里出现 \`ultracode\` 会额外提高触发率——评测提示词要避免无意带上它。）

> ### ⚠️ 2026-09-30 真机补一条：**\`enableWorkflows\` 只管"能不能"，不管"会不会"**
>
> \`Workflow\` 的工具描述**逐字**把触发条件写死在提示词侧：
>
> > "**ONLY call this tool when the user has explicitly opted into multi-agent orchestration.**
> > Workflows can spawn dozens of agents and consume a large amount of tokens; **the user must request that
> > scale, not have it inferred.** … The user included the keyword \`ultracode\` … The user directly asked you
> > to run a workflow or use multi-agent orchestration **in their own words** ("use a workflow", "run a workflow",
> > "fan out agents", "orchestrate this with subagents"). **The ask must be in the user's words** — a task that
> > would merely benefit from a workflow does not count."
> >
> > "For any other task — **even one that would clearly benefit from parallelism** — do **NOT** call this tool."
>
> 实测（本机 30 项工具表里 \`Workflow\` **在**，无需额外开关）：\`enableWorkflows: true\` 打开的是**功能可用性**；
> 模型**仍不会**在普通提示词下调用它。
> ⇒ 两条落地口径：
> ① **\`enableWorkflows: true\` 是必要的**（不设就是 "default by plan"，不可控），但**不是充分的**——
>    "3 家都没用编排"很可能只是**提示词没 opt-in**，不能读成"能力差异"；
> ② 若评测确实要比"编排能力"，**三家都要在同一段提示词里显式 opt-in**（否则这一格是提示词差异，不是能力差异）；
>    反之若不想引入编排，**提示词里必须避免 \`ultracode\` 与"用 workflow / 并行开 agent"这类原话**。`,
  },
  {
    name: '11-10 resolved: unsupported in exec mode',
    from: `10. **\`request_user_input\` 会不会真的挂住**（口径已变）——~~是否应主动禁用~~
    发现 \`RequestUserInputEvent\` 带 **\`isBlocking\`** 与 **\`autoResolutionMs\`**（§7.6.2 ⑩），
    说明**存在自动决议机制**、未必无界挂起。⇒ **先实测**：开
    \`tools.experimental_request_user_input.enabled\` + \`features.default_mode_request_user_input\`
    后跑一次，看它是否被调用、以及是否走 \`auto-resolution\` 收场。**实测前不做禁用决定**。`,
    to: `10. ~~**\`request_user_input\` 会不会真的挂住**~~ **已实测（2026-09-30）：不会挂住，因为在 exec 模式
    下它结构性不可用**。开了两个开关后跑一次，全程 **18 秒**正常收场，\`turn.completed\` 照常发出；
    真相在 stderr 逐字：
    \`\`\`
    ERROR codex_app_server::bespoke_event_handling: request failed with client error:
    JSONRPCError { code: -32000, data: None, message: "request_user_input is not supported in exec mode for thread \`…\`" }
    \`\`\`
    事件流里**连一条 \`request_user_input\` 的 item 都没有**（只有 \`error\` + \`agent_message\`，
    模型自述"已询问用户…但当前没有收到选项回答"）。
    ⇒ 在本仓的传输路径（\`codex exec\` / SDK）上，该工具**不是"可能挂起"而是"不可能成功"**；
    \`autoResolutionMs\` 那条线索在**这条路径上无从生效**。**本项关闭**（若要真用它，得换到 app-server 交互面）。`,
  },
  {
    name: '11-11 residual answered',
    from: `    残留待确认：**claude 的 \`AskUserQuestion\` 未出现在本机 27 项工具表里**——
    是 feature-gated 还是本机 preset 未启用，未验证（与 \`TodoWrite\` 同一疑问）。`,
    to: `    残留已于 2026-09-30 验证：**\`AskUserQuestion\` 不在工具表里**（3 模型 × 2 档共 6 次采集，
    工具表恒为 30 项、无 \`AskUserQuestion\`），且**开 \`CLAUDE_CODE_ENABLE_TODO_TOOLS\` 也不会出现**。
    但它**确实存在于产品里**：\`~/.claude.json\` 的 \`toolUsage\` 里有 \`AskUserQuestion\` 的历史计数
    ⇒ **是 feature-gated / 交互式会话才有，不是"这家没有"**。
    ⇒ 该族在 claude 侧的可得性应标 \`'off-by-adapter'\`（或 \`'unverified'\`），**不是 \`'no'\`**。`,
  },
  {
    name: '11-16 last sentence answered',
    from: '    ⇒ **不是版本过低，是默认裁剪**。`AskUserQuestion` 是否受同一开关影响**仍未确认**。',
    to: `    ⇒ **不是版本过低，是默认裁剪**。\`AskUserQuestion\` **不受该开关影响**（2026-09-30 实测：
    3 模型 × 2 档，开关前后工具表都是 30 项，增量为空）。另需更正：**\`Task*\` 在本版已是默认工具**
    （同一批实测的另一个结论，见 §7.6.2.1b 的更正块）⇒ 这个环境变量的作用已从"开任务工具"
    退化为"防版本回退的护栏"。`,
  },
  {
    name: '11.1-20 dsh cancel path closed',
    from: "    **剩余**：dsh 的**失败/取消**路径 `status` 形态未抓到（§6.5.2）⇒ 那边目前 `statusMissing: 'unverified'`。",
    to: `    **剩余（2026-09-30 更新）**：dsh 的**取消**路径已抓到（\`status:"error"\` + \`stopReason:"aborted"\`，
    见 §6.5.2 的新增行）⇒ 那一格可以从 \`statusMissing: 'unverified'\` 收紧为**按 \`stopReason\` 映射**；
    **失败**（非取消）路径仍未覆盖，继续 \`'unverified'\`。
    另一条同轮实测：子任务仍在跑时**直接关掉运行时**，**一条 \`subagent.finished\` 都不会来**
    ⇒ 派发面板会留下永不收场的条目（这是真实观测，UI 要能吃）。`,
  },
  {
    name: '11.1-23 resolved',
    from: `23. **codex 的 \`update_plan\` / \`request_user_input\` 落到哪个 \`item.type\`**（§7.3.1）——
    三个候选，**不得推断**。若结果落在候选 ③（只以 \`agent_message\` 文本留痕），
    则 §7.6.2.2 的"工具面重建面板"方案**不成立**，需改走 hook/session-file。`,
    to: `23. ~~**codex 的 \`update_plan\` / \`request_user_input\` 落到哪个 \`item.type\`**~~ **已定案（2026-09-30 真机）**：
    \`update_plan\` → **\`item.type === 'todo_list'\`**（候选 ①；\`item.started/updated/completed\` 三态都发）。
    ⇒ §7.6.2.2 的"工具面重建面板"方案**成立**，候选 ③ 被排除。
    \`request_user_input\` 在 exec 模式下**结构性不可用**（JSON-RPC -32000，见 §11 第 10 项），
    因此它在事件流里**没有任何 item 落点**——这一格在 SDK 路径上应当**恒为 \`null\` + \`not-observed\`**。
    ⚠️ 新登记一条待办：\`todo_list\` 的事件载荷是 \`{text, completed}\` **二态**，
    恢复不出工具输入里的 \`in_progress\` ⇒ \`TaskStep.status\` 需要"第三态如实标 \`unknown\`"的口径。`,
  },
  {
    name: '11.1-27 resolved: id from TaskCreate result',
    from: `27. **\`TaskStep.id\` 的来源缺一环**（§7.6.2 ⑨）——\`TaskCreate\` 的输入**没有 \`taskId\`**
    （\`{subject, description, activeForm?, metadata?}\`），而 \`blockedBy\` 要靠 \`id\` 解析。
    \`id\` 从哪来（\`TaskCreate\` 的 result 形状未登记、\`TaskCreated\` hook 在 ⑨ 里没被用）**未说**
    ⇒ claude 侧的"依赖"维度（\`blockedBy\`）**会落空**。需真机看一次 \`TaskCreate\` 的返回。`,
    to: `27. ~~**\`TaskStep.id\` 的来源缺一环**~~ **已闭合（2026-09-30 真机）**：\`id\` 来自 **\`TaskCreate\` 的返回**——
    结构化旁路逐字 \`{"task":{"id":"1","subject":"…"}}\`（序号字符串），于是 §7.6.2 ⑨ 的候选 ① 成立、
    **\`blockedBy\` 可以解析**（\`TaskUpdate\` 返回 \`{"success":true,"taskId":"1","updatedFields":["status","blockedBy"],…}\`、
    \`TaskGet\` 返回 \`{"task":{…,"blockedBy":["2"]}}\`）。
    ⇒ claude 侧的"依赖"维度**不再落空**；候选 ②（hook）/ ③（自己发号）都不需要用。
    两条附带实测：①\`TaskList\` 在**未指派**时**不出现 \`owner\` 字段**（设计稿 §7.6.2 ⑨ 写的
    \`id/subject/status/owner/blockedBy\` 是"指派后"的形状）；②**冷存储下 \`Task*\` 必失败**——
    \`<HOME>/.claude/tasks/<sessionId>\` 与其中的 \`.lock\` **目录** CLI 都不建，
    工具对 ENOENT 未兜底（\`ENOENT lstat '…tasks/<sessionId>'\` → \`ENOENT …/.lock\` → \`EPERM mkdir '…/.lock.lock'\`）
    ⇒ 本仓若要用 \`Task*\`，**必须自己先把这两级目录建出来**（这是厂商侧可复现的缺陷形状）。`,
  },
];

let text = readFileSync(FILE, 'utf8');
const before = createHash('sha256').update(text).digest('hex');
const report = [];

for (const edit of EDITS) {
  const hits = text.split(edit.from).length - 1;
  if (hits !== 1) {
    report.push({ name: edit.name, hits, ok: false });
    continue;
  }
  text = text.replace(edit.from, edit.to);
  report.push({ name: edit.name, hits, ok: true });
}

const failed = report.filter((row) => !row.ok);
for (const row of report) console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${row.name} (hits=${row.hits})`);

if (failed.length > 0) {
  console.error(`\n${failed.length} anchors not uniquely matched; nothing written.`);
  process.exit(1);
}

const after = createHash('sha256').update(text).digest('hex');
console.log(`\nedits=${report.length}; hash ${before.slice(0, 12)} -> ${after.slice(0, 12)}`);
if (CHECK_ONLY) {
  console.log('--check: no write');
} else {
  writeFileSync(FILE, text, 'utf8');
  console.log('written', FILE);
}
