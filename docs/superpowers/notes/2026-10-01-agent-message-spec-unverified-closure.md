# Agent 消息规范 v2：未验证项真机验证报告·续（2026-10-01）

上位文档：`docs/superpowers/specs/2026-09-30-agent-message-spec-design.md`
上一轮报告：`docs/superpowers/notes/2026-09-30-agent-message-spec-verification.md`
本轮探测代码：`packages/server/agents/probe/v4/`；原始产物：`packages/server/agents/probe/dumps/v4/`

**一句话**：上一轮报告末尾"仍未闭合"的 5 项里，本轮**闭合 3 项**（另 1 项闭合到边界、1 项仍未闭合），
另把设计稿正文里 13 处"待验证 / 未验证 / 待真机确认"标记逐一落到实证
（**claude 侧 5 项、codex 侧 6 项、dsh 侧 6 项、本地判据 3 项**），
并在 **VPN 恢复后的追加轮**里回到内网网关（适配器真实路径）复跑——**那次复跑收回了本条 1 处过头结论**（见 §8）。
**最重的一条**：codex 的 `SubagentStop` 真实载荷抓到了——**确证没有 `status`**，
且发现设计稿 ⑤ 的字段表**少列一个**（`stop_hook_active`）。
剩下未闭合的都是**本机/厂商侧不可解**（网关 `tool_choice` / 厂商沙箱 / 无 Procmon 归因），**每一条都登记了确切卡点**。

---

## 0. 本轮最重要的八条（先看这个）

| # | 设计稿原话 | 本轮真机结果 | 证据 |
|---|---|---|---|
| **A** | §6.5.2：只有"取消"那一格需要看 `stopReason`（`status:"error"` + `stopReason:"aborted"` 字面像失败、实为取消） | **反方向还有一格，而且更危险**：子任务被输出上限截断时厂商给的是 **`status:"ok"` + `stopReason:"max-tokens"`**——`status` 这一格**两个方向都会骗人**，映射必须**同时**读两格。**映射已定案：`'failed'`**（用户口径 2026-10-01） | `dumps/v4/dsh-subagent-failure.json` |
| **B** | §11.1-30：dsh 的 `tool-web` 覆盖"是合并还是整份替换未验证" | **整份替换（REPLACE）**：`{search:false}` 会把 `dsh-base` 的 `fetch:true` 与 `searchTimeoutMs:60000` 一起抹掉；再叠一层**插件 zod 默认值**后，`fetch` 回到 `true` 而 `searchTimeoutMs` **静默从 60000 掉到 30000** ⇒ 实现必须写全三格（已验修法成立） | `dumps/v4/dsh-tool-web-override.json` |
| **C** | §7.7.2 dsh 行：`reasoningTokens` "真机未观测到"（＝只是没采到） | **不是采样问题，是结构性不可达**：本仓用的 `@deepseek-ai/dsh-llm-pi-ai` 的 `mapUsage()` **只映射 input/output/total + cache 两格，从不写 `reasoningTokens`**（源码逐字，附 README 的"reasoning 并入 output"口径）；真机上上游**确实给了** `reasoning_tokens`（31）而 dsh 侧仍是 `{inputTokens,outputTokens,totalTokens}` 三格 | `dumps/v4/dsh-reasoning-tokens.json` + `dumps/v4/wire-usage-shape.json` |
| **D** | §7.8.4：闸门日志"**在 CLI 的 stdout/stderr 上**" | **不在**。那行日志只在 **debug 通道**上（`--debug` → `~/.claude/debug/<session>.txt`，或 `--debug-file <path>`）；plain `-p` 的两条标准流里**永远没有**。不设变量时对照干净 ⇒ **按原话去找会找不到，然后误判"闸门没生效"** | `dumps/v4/q2d-debug-channel.json`、`q2c-size-warning.json` |
| **E** | §7.6.2.1b：「`CLAUDE_CODE_ENABLE_TODO_TOOLS` 无增量（恒 30 项）」 | **只对 claude 模型名成立**。换 `deepseek-chat`：**默认 23 → 开开关 27（+4 个 `Task*`）**；`claude-sonnet-4-5` 仍是 27→27 ⇒ **工具表是模型相关的**，读这一节必须带模型名 | `dumps/v4/q4-inbound-tools.json` |
| **F** | §6.4 开头：「codex 的 `status` **拿不到**」只有 **schema 级**证据 | **真机抓到了**：`SubagentStop` 载荷 **12 字段、确证没有任何 `status`** ⇒ 证据等级从「中」升到「强」。⚠️ 同时发现 **§7.5.5 ⑤ 少列了一个字段**：真机比 `SubagentStart` **多三个**（`agent_transcript_path` / **`stop_hook_active`** / `last_assistant_message`），不是"多两个" | `dumps/v4/codex-hooks-deepseek.json` |
| **G** | §7.7.2 codex 行：「`reasoning_output_tokens` 从未出现（3 个样本全是 0）」 | **9/9 非 0**（123/50/65/53/117/56/84/51/61），且 **9/9 恒 ≤ `output_tokens`** ⇒ `basis` 可升 `'subset-of-output'` | `dumps/v4/codex-deepseek-events.json` |
| **H** | §7.5.2：「`spawn_agent` 本仓无解，只能等网关给带 profile 的模型名」 | ⚠️ **结论与路由相关**（2026-10-01 追加轮更正）：DeepSeek 路由上**真跑通了**（子智能体算出 `1+1 = 2`），但**内网网关（适配器真实路径）上仍 `unsupported call: spawn_agent`** ⇒ 原结论**对它自己的路径依然成立**，DeepSeek 是唯一观测到的例外；且**"认不认识模型名"不是决定因素**（两边都是 fallback 元数据） | `dumps/v4/codex-deepseek-events.json` + `dumps/v4/codex-gateway-events.json` |

> **A / C / F 是同一种毛病**：设计稿把"**我没采到**"或"**schema 里有**"当成了"**事实如此**"——
> A 把"看 `stopReason`"限定在取消一格（实际**两个方向都要看**），
> C 把"结构性拿不到"写成了"还没采到"（`'unverified'` 让人以为再跑一次就有），
> F 把 schema 级当成了定论（真机一跑，**schema 还少列了一个字段**）。

---

## 一、环境与可复现口径（本轮换了靶子，必须写在最前）

| 项 | 实测值 |
|---|---|
| **内网网关** | `likecode-llm-proxy.jd.com` **已不可达**（`Test-NetConnection` 443 → False；HTTP 20s 超时）；`-test` 同样不可达。**上一轮全部 codex/claude 结论都基于它**，故本轮不能直接复跑那些脚本 |
| **本轮的靶子** | **DeepSeek 官方 API**（`api.deepseek.com`，实测可达）：`/anthropic/v1/messages`、`/v1/responses`、`/chat/completions` **三条 wire 全通**（16 token 最小推理） |
| 凭据 | `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`（**不落进仓库、不打印**） |
| dsh | `@deepseek-ai/dsh@0.1.7-rc.1`（`probe/v4/lib/dsh-harness.mjs` 走 `DeepSeekHarness` + per-run overlay，与适配器同路径） |
| 一般网络 | 通（`baidu.com` 200）⇒ 上面那条不是"断网"，是**内网/VPN 不通** |

**两条方法学约束（本轮全程遵守）**：
1. **先证链路、再下结论**（§9.4.1 的教训）：任何"厂商不产出 X"的判断，都必须先证明**上游确实产出了 X**
   ——本轮 C 就是靠这一步把"dsh 不投影"与"上游不给"分开的（第 5.1 节的两档对照）。
2. **不许用字符串搜索当形态证据**：本报告里凡"某字段不存在"的结论，都附**原始形态**（键名数组或逐字载荷）。

---

## 二、dsh：本轮闭合 5 格

### 2.1 §11.1-30 / §7.9.1 注意点 1：`tool-web` 覆盖 = **整份替换**（✅ 闭合）

**判据**：同一份 dsh 二进制，只切一个 patch，跑 `dsh --profile sdk --dump-config` 看**合成树**（不是推断）。

```powershell
# 基线（无 patch）
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000

# 只写 search:false
# == @deepseek-ai/dsh-base, patched by …\tool-web.patch.yml
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    search: false                       # ← fetch 与 searchTimeoutMs 都不见了
```

⇒ **dict 层是整份替换**，设计稿 §7.9.1 注意点 1 的担心**成立**。

**再补一截设计稿没写的（本轮新增）**：合成树里的 config 会**再过一遍插件自己的 zod schema**，
而 `@deepseek-ai/dsh-tool-web/lib/index.js:845-853` 逐字是：

```js
const Config = z.object({
  search: z.boolean().default(true),
  fetch: z.boolean().default(true),
  searchMaxResults: z.number().default(8),
  searchMaxQueries: z.number().default(4),
  fetchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),   // 3e4
  searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS),  // 3e4
  fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),
});
```

⇒ **`fetch` 会回到 `true`（web_fetch 不会消失），但 `searchTimeoutMs` 会静默从 `60000` 变成 `30000`**——
"顺手改掉 `web_fetch` 的行为"这件事**真的会发生**，只是形态不是"关掉"而是"超时预算腰斩"。
这一格 `--dump-config` **看不到**（它只 dump 声明层，不 dump zod 解析后的值）⇒ 只靠 dump 会漏判，**必须读插件源码**。

**修法（已实测成立）**：把三格一起写出：

```yaml
- id: tool-web
  config:
    search: false
    fetch: true
    searchTimeoutMs: 60000
```

合成树逐字：`{search: false, fetch: true, searchTimeoutMs: 60000}` ✅（`dumps/v4/dsh-tool-web-override.json` 的 `fixed` 档）

### 2.2 §6.5.2 / §11.1-20：子任务**失败（非取消）**路径（✅ 闭合，且结论比设计稿更强）

**做法**：把本次运行的路由 `maxTokens` 压到 `400`，让前台子智能体的普通 turn 撞上输出上限。

**真机逐字载荷**（`dumps/v4/dsh-subagent-failure.json`）：

```jsonc
{ "provider":"spawn",
  "agentId":"2a951dad-779c-4d2a-b324-a002d07c842a",
  "parentSessionId":"session-261c2e95d84b42179a13244ccd4a0be7",
  "childSessionId":"2a951dad-779c-4d2a-b324-a002d07c842a",
  "status":"ok",                 // ← 字面是"成功"
  "stopReason":"max-tokens",     // ← 真相：被输出上限截断，文章只写了一半
  "lastAssistantMessage":[{"type":"text","text":"# 海洋：从蔚蓝深处到人类文明的摇篮…（截断）"}] }
```

**三条必须回写的结论**：

1. **`status` 两个方向都会骗人**：取消时是 `status:"error"`（看着像失败、实为主动取消），
   截断时是 `status:"ok"`（看着像成功、实为没跑完）⇒ `mapSubagentStatus()` **必须同时读 `status` 与 `stopReason`**，
   单读任一格都会产出假数据。设计稿 §6.5.2 的"判据必须是 `stopReason`"**方向对但覆盖不全**（它只举了取消那一例）。
2. **`stopReason` 的取值域**（类型面逐字，`@deepseek-ai/dsh-subagent` 的 typert 声明）：
   ```ts
   export interface SubagentStopReasonMap {
     completed: 'completed'; aborted: 'aborted'; error: 'error';
     'max-tokens': 'max-tokens'; refusal: 'refusal';
   }
   ```
   本轮真机覆盖到 **3/5**：`completed`（成功）、`aborted`（取消）、**`max-tokens`（本轮新增）**；
   `error` 与 `refusal` **仍未观测**（`subagent` 工具入参只有 `{description, prompt, run_in_background}`，
   没有可用来制造模型侧错误的 `model`/`provider` 覆盖口 ⇒ 本机没有再省事的构造法）。**如实登记，不猜**。
3. **`max-tokens` 的映射已定案（用户口径 2026-10-01）：`'failed'`**——§6 的 `status` 四值里
   "做完没做完"是唯一的判据轴，截断就是没做完；**不为它新增枚举值**（那会让另两家去理解一个
   它们永远不会产生的值）；`outcome` 里仍留着半篇文本 ⇒ **信息不丢**。
   **配套硬规则**：`stopReason !== 'completed'` 一律**不得**记 `'completed'`；
   未观测取值（`error` / `refusal`）仍走 `status: null` + `statusMissing`，**不许猜**。

**另一条顺带实测**：截断时 `lastAssistantMessage` 里**有** `text` 块（半篇文章）⇒ `outcome` 该填就填；
这与取消路径的"可能只有 `reasoning` 块、没有 `text` 块"**不矛盾**（两条路径形状不同，适配器要各自判）。

### 2.3 `subagent/descriptor` 载荷与归属（✅ 解析完成）

设计稿原话：「只见到事件名，未解析」。本轮拿到**载荷 + 归属机制**（`dumps/v4/dsh-subagent-descriptor.json`）：

```jsonc
// ① 父会话里的事件，带身份
{ "method":"session.event",
  "params":{ "sessionId":"session-1de4f42d…",         // ← 父会话
             "event":{ "type":"subagent/catalog", "seq":…,
                       "data":{ "version":0, "childId":"21b1e5ff…", "childCreatedAt":…,
                                "mode":"one-shot", "label":"Child one" } } } }

// ② 子会话里的事件，**data 里没有身份字段**
{ "method":"session.event",
  "params":{ "sessionId":"21b1e5ff-4e85-4489-9ad4-5047f630fe0c",   // ← 子会话 id 就是身份
             "event":{ "type":"subagent/descriptor", "seq":5,
                       "data":{ "version":3, "mode":"one-shot", "provider":"spawn", "label":"Child one" } } } }
```

**三条结论**：

1. **`subagent/descriptor` 不是逐子任务必发**：一次运行派了 **3** 个子任务，只出现 **2** 条 descriptor
   （缺的那条正是 `mode: "continuable"` 的后台子任务）⇒ **适配器不得把它当身份来源**；
   身份来自 `subagent/catalog`（父会话里带 `childId`）或顶层 `subagent.started/finished`。
2. **它的身份只在信封上**（`params.sessionId` = 子会话 id），`data` 里**没有 `childId`**
   ⇒ 消费方若只解析 `data` 会拿不到归属（这正是设计稿「不许只凭字段名推断」的又一例）。
3. **`subagent/catalog.mode` 的取值域本轮一次运行内两种都见到**：`one-shot`（前台）与 `continuable`（后台）
   ⇒ §6.5.2 的 `kind` 来源（`mode`）至少有这两个值，**不得硬编码 `one-shot`**。

### 2.4 §7.2 / §7.7.2：dsh 的思考 token —— **结构性不可达**（✅ 闭合，更正 `'unverified'`）

**两段证据（缺一不可）**：

| 段 | 做了什么 | 结果 |
|---|---|---|
| **① 链路（上游给不给）** | 直接打 DeepSeek 三条 wire × 两个模型（`dumps/v4/wire-usage-shape.json`） | `openai /responses` + `deepseek-reasoner` ⇒ `usage.output_tokens_details.reasoning_tokens = 31`（output=33）；`chat/completions` ⇒ `completion_tokens_details.reasoning_tokens = 35`（completion=37）；**anthropic wire 完全没有这一格** |
| **② 投影（dsh 给不给）** | 用**真实 harness + 本仓的 pi-ai 路由**跑两档（`dumps/v4/dsh-reasoning-tokens.json`） | `openai-responses` 档：usage 逐字 `{inputTokens:7437, outputTokens:116, totalTokens:7553}`——**上游给了，dsh 没给**；`anthropic-messages` 档同样没有 |

**根因在源码里，且是**有意的**（`@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1362-1375`）**：

```js
/** Map pi-ai usage (reasoning folded into output by pi-ai). */
function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
  };
}
```

README 逐字印证：*"pi-ai folds reasoning tokens into output usage when the provider does not report them
separately, and preserves its exact `totalTokens` value unchanged."*

**⇒ 结论与设计稿不同**：
- `TokenUsage.reasoningTokens?: number` 在 `@deepseek-ai/dsh-llm` 的**类型面上确实存在**
  （`lib/types/types.d.ts:174`），但**本仓用的那条路由永远不会写它**；
- 因此 dsh 的 `usageCapability.thinkingTokens` **不应停留在 `'unverified'`**（那读起来像"再跑一次就有"），
  而应写成 **`'off-by-adapter'`**（能力在类型面上、但当前路由的适配器**有意不投影**），
  并把"reasoning 被并入 output"写进依据；
- `thinkingTokensBasis` 对 dsh：pi-ai 的口径是 **"folds reasoning into output"** ⇒ 语义上等价于
  `'subset-of-output'`，但**我们拿不到那个子集的值**，故这一格仍**不可用于相加或跨家比较**；
  本文建议保留 `'unknown'` 并附注"厂商侧语义是 subset，但本路由不暴露该值"。

### 2.5 §7.6.8 两轴表的 "※ 待真机确认"：`exit_plan_mode` **在 dsh 工具表里**（✅ 闭合）

从本轮扫描的 v2 产物里把 dsh 的入站工具表逐字取出（**25 项**）：

```
ask_user_question, create_goal, edit, exit_plan_mode, get_goal, glob, grep, interrupt_agent,
job_kill, job_list, job_output, list_agents, pwsh, read, read_image, send_message, skill,
subagent, subagent_fork, todo_write, update_goal, web_fetch, web_search, workflow, write
```

⇒ `exit_plan_mode`（§7.6.8 记 `send / task`）**确实存在**，该行的 ※ 可以去掉。

### 2.6 claude 侧同批查到的两条（本地判据，不花模型调用）

打包 `claude.exe` 的字符串计数 vs 入站工具表（`dumps/v4/tool-table-check.json`）：

| 名字 | 二进制字符串计数 | 入站工具表（30 项）里有没有 |
|---|---|---|
| `ExitPlanMode` | **29** | ❌ **没有** |
| `TodoWrite` | **18** | ❌ **没有** |
| `AskUserQuestion` | **70** | ❌ **没有** |
| `ReportFindings` | 2 | ✅ 有 |
| `Workflow` | — | ✅ 有 |
| `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` | **6** | （环境变量，非工具） |
| `CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS` | **3** | （环境变量，非工具） |
| `workflow: concurrent agent gate` | **2** | （日志文案，非工具） |

⇒ **`ExitPlanMode` 与 `AskUserQuestion` / `TodoWrite` 同一档**：二进制里有（不是"这家没有"），
但**不在本机非交互 SDK 配置的工具表里**（是 feature/mode 门控）⇒ 能力位应标
`'off-by-adapter'` 或 `'unverified'`，**不得标 `'no'`**（§11 第 11 项的同一口径）。

**顺带一条小更正**：设计稿 §11 第 6 项写 `DesignSync`「该名字在本机 SDK 2.1.281 的工具表里不存在」——
上一轮报告录的 30 项工具表里**有 `DesignSync`** ⇒ 那句已过时。

---

## 三、claude-code：4 项闭合、2 项更正设计稿、1 项环境边界

**本轮的靶子换了**：claude CLI 2.1.283 / SDK 0.3.281 直连 **DeepSeek 的 anthropic 兼容端点**
（`https://api.deepseek.com/anthropic`）。**先证链路**：CLI **5 个变体全部 `exit=0` 且都产 `type:"result"`**
（`ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` / `--model` / `deepseek-reasoner` / `ANTHROPIC_API_KEY`），
SDK `query()` 两个模型也都 `subtype=success`。stderr 有一条**非致命**警告，逐字：
`[claude-code:unrecognized_model] {"model":"deepseek-chat","query_source":"sdk"}`。
⇒ **"claude 能不能用非 Anthropic 后端"这一格本轮闭合**（这也让上一轮那批"必须内网网关"的结论多了一条替代路径）。

### 3.1 §7.8.4 判据①：闸门日志**在，但不在 stdout/stderr 上**（设计稿要改）

二进制逐字（本轮复核）：
```js
let Ot = a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS ?? Fr;
if (a.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS !== void 0)
  t(`workflow: concurrent agent gate = ${Ot} (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)`);
```
真机逐字（**只在设了变量时才打**）：
```
2026-09-30T19:22:53.167Z [DEBUG] workflow: concurrent agent gate = 8 (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)
```

| 跑法（都真的调用了 Workflow） | stdout | stderr | debug 日志 |
|---|---|---|---|
| 不设变量 + `--debug`（对照） | ✗ | ✗ | ✗ |
| 设变量 + **不**加 `--debug` | ✗ | ✗ | —（扫了 `<ws>/.claude`、`~/.claude`、`%TEMP%\claude` 三个根，13 个新增/变动文件 0 命中） |
| 设变量 + `--debug` | ✗ | ✗ | **✓ `~/.claude/debug/<session>.txt`** |
| 设变量 + `--debug --debug-file <path>` | ✗ | ✗ | ✓ `<path>` |

⇒ **设计稿 §7.8.4 写的「它在 CLI 的 stdout/stderr 上」不准确**，应改为
「在 CLI 的 **debug 日志**上，需 `--debug` / `--debug-file`；plain `-p` 的 stdout/stderr 里没有」。
**这条是本报告最"实操"的一条**：按原话去找那行日志会**找不到，然后误判"闸门没生效"**。

### 3.2 §7.8.4 判据②：DeepSeek **能驱动 Workflow**（与预判相反）

6 次运行里 **5 次真的调了 `Workflow`**；`"use a workflow to …"` 与含 `ultracode` 的提示词都能触发。
12-agent 那次**真跑完了**（12 个 agent 全部走到 `state:"done"`）。
⇒ 闸门日志与"工具是否被调用"是**独立两件事**：日志在工具被调用时打，不依赖编排成功与否。

### 3.3 §7.8.4 判据③：规模告警**进不去任何可见流**（闭合，与设计稿的 if-not 分支一致）

为了让"没触发"不冒充"没产生"，先**造出确定性触发条件**：`CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS=8`
+ `workflowSizeGuideline: medium`(=10)，提示词明确要 **12 个 agent**（实测流里确实排了 12 个 label：
`count:part-01.txt` … `count:part-12.txt`）。在此前提下，5 个 token
（`workflow_size_warning` / `tengu_workflow_size_warning_shown` / `scheduled_agents` / `agent_cap` / `cap_from_guideline`）
在 **stdout ✗ / stderr ✗ / debug 日志 ✗ / SDK 消息流 ✗** 全部 0 命中。
二进制佐证：这些字段只出现在**遥测调用**里，且那段代码在 React-compiler 风格的 memo 块（UI 层）。

⇒ **§7.8.1 ③ 的告警在本仓的 print/SDK 路径下退化成"纯我们自己的计数留痕"**，可以直接定稿。

**必须保留的例外（探测者自己标出来的）**：另起 OTLP 接收器验证遥测通路（`CLAUDE_CODE_ENABLE_TELEMETRY=1`）
**确实被访问 21 次**，但 OTEL 日志的 `event.name` 只有固定 8 个
（`api_request`/`assistant_response`/`managed_settings_resolved`/`plugin_loaded`/`skill_activated`/`tool_decision`/`tool_result`/`user_prompt`），
**从不承载 `tengu_*`**（那条走 Statsig 的另一条网络通路，未观测）。
⇒ **能说"不进可见事件流"，不能说"事件不产生"**——这条保留写得对，应照抄进规范。

### 3.4 §7.8.1 ①：`enableWorkflows` 的语义**与设计稿写的不一样**（抓包逐字）

| settings | `Workflow` 在不在工具表里 |
|---|---|
| **不给** `enableWorkflows` | **在**（23 项） |
| `enableWorkflows: false` | **不在**（22 项，`workflowPresent=false`，描述为空） |
| `enableWorkflows: true` | 在 |

⇒ 设计稿 §7.8.1 ① 的理由「SDK 逐字 "Unset = **default by plan**"，那是评测环境里不可控的输入」
**在本 build 上不成立**：不给 settings 时工具**就在**，`false` 才是把它摘掉的那一格。
**处置不变**（照样显式写 `true`——显式永远比隐式好），但**理由要改成"钉住行为"而不是"不设就没有"**。

**顺带确认 `workflowSizeGuideline` 是真吃的，且只改工具描述里那句指引**（与设计稿一致）：
- 不给 setting：`This session has the default workflow size guideline: medium — keep workflows under 10 agents. …The user can raise or remove it with "Dynamic workflow size" in /config.`
- 显式给时**换了措辞**：`A workflow size guideline is configured for this session: small — keep workflows under 5 agents. This is a guideline, not a hard limit …`
- `small`→**5**、`large`→**50**、`unrestricted`→**整句消失**
- **`workflowSizeGuideline: '8'` 被忽略、回落成默认 medium/10** ⇒ 设计稿「档位只有 5/10/50，表达不了 8」**实测成立**

> **一次差点误诊（值得记）**：第一版正则只匹配了默认措辞 `This session has the …`，于是对
> `small`/`large`/`unrestricted` 报"描述里找不到该句"。**打印原文后**才发现厂商在显式设定时**换了措辞**。
> 这正是 §9.4.1 那条"报告某字段为空之前，先打印它的原始形态"的又一例。

### 3.5 §7.6.2.1b 的 A/B：**推翻上一轮的"无增量"，但要带模型名说**

入站 `/v1/messages` 请求体 `tools[]` 全量抓包（4 次）：

| 模型 | 默认 | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | 增量 |
|---|---|---|---|
| **`deepseek-chat`** | **23** | **27** | **+ `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`** |
| `claude-sonnet-4-5` | **27** | 27 | 无 |

⇒ 上一轮的「30 项恒定、开关无增量」是**在 claude 模型名下**测的。**工具表是模型相关的**：
DeepSeek 名下 TODO 工具**默认关、开关真的有效（+4）**；claude 模型名下**无增量**。
**这条必须按模型名分别写**，否则两轮结论会看起来互相矛盾。

**同时更正一条工具名口径**（新发现）：入站 `tools[]` 里子智能体工具叫 **`Agent`**
（描述首句 `Launch a new agent to handle complex, multi-step tasks.`），而 `system/init` 的 `tools[]` 里叫 **`Task`**
——同一件东西**两个名字**，且 **`Task` 在入站表里根本不存在**。
⇒ §7.6.8 两轴表里写 `Task`(cc) 时**必须注明是 `system/init` 的名字**，否则按入站表查会查不到（与 §7.6.8 那条"两类工具名"的警告同源，但这次是**同一家的两个面**）。

### 3.6 §7.7.2 claude 行的一条**后端相关**警告

`result.usage.output_tokens_details.thinking_tokens` **在本轮的后端上恒为 0**：
`{"thinking_tokens": 0}`（`deepseek-chat` 与 `deepseek-reasoner` 两次都是），
而同一次 `deepseek-reasoner` 运行里模型**确实产出了 thinking 正文**（assistant 消息有 `{"type":"thinking",…}` 块），
CLI 只能用 `system/thinking_tokens` 的 `estimated_tokens`（**本地估算**）近似。

**根因已被 wire 证据钉死**：DeepSeek 的 **anthropic** wire **完全不返回思考 token 字段**
（`usage` 只有 `input_tokens`/`cache_*`/`output_tokens`/`service_tier`），
而它的 **openai** wire 返回（`output_tokens_details.reasoning_tokens: 40`、`completion_tokens_details.reasoning_tokens: 48`）。
⇒ **`thinkingTokens` 这一格对 claude 是"有样本但取值依赖于上游"**：
在真 Anthropic 后端上是真值（§5.1 的 19 条样本），在**第三方 anthropic 兼容后端上可能是恒 0 的假值**。
**规范必须据此加一条口径**：`thinkingTokens: 0` **不得**被读成"这家不思考"，它在第三方后端上**只是"上游没报"**。

### 3.7 上一轮报告的"claude `Bash` 在 SDK 路径恒 EPERM"：**仍未闭合，但归因已换人**

逐字复现（`Bash` 与 `PowerShell` 两条 `tool_result` **字符串完全相同**，`is_error=true`）：
```
EPERM: operation not permitted, mkdir 'C:\Users\ZHANGL~1\AppData\Local\Temp\claude\C--Users-ZHANGL-1-AppData-Local-Temp-aieval-v4-cc-0PrBdW'
```
**三条判别性证据（本轮新增，把嫌疑逐个排除）**：
1. **不是 DSH 文件策略**——当前是 danger-full-access；
2. **不是 OS/ACL**——同一父目录用 node `fs.mkdirSync(recursive)` 建得成、PS `New-Item` 建得成，
   `%TEMP%\claude` 的 ACL 上当前用户是 `FullControl`；
3. **不是历史脏状态**——把 `CLAUDE_CODE_TMPDIR` 指到**全新空目录**再跑，仍然 EPERM。

旁证：同一次运行里 CLI **主进程能**建出 `%TEMP%\claude\<slug>\<session>\tasks\*.output`，
**只有工具级 mkdir 被拒**。⇒ 这是 **claude.exe 自身工具沙箱**在 Windows 上的拒绝，**改 DSH 策略解决不了**。
**含义**：claude 的 shell 工具在本机**全不可用** ⇒ 任何依赖 Bash/PowerShell 的观测都拿不到真实结果。
**处置**：登记为**环境边界**，并建议正文把上一轮那句"经 node 的管道/命名管道拉起厂商 CLI 会拒绝访问"
**换成本条更准的归因**（否则读者会去改沙箱配置，改了也没用）。

---

## 四、codex：**4 项闭合（其中 3 项推翻前论）**、1 项被环境卡住但边界已定死

**靶子**：`https://api.deepseek.com/v1`（`wire_api: "responses"`）。**先证链路**：
`deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-pro` / `deepseek-flash` **四个模型都能跑完 turn**（exit 0）；
`gpt-5.5` 被 DeepSeek 拒（原文：`The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed gpt-5.5.`）。
`Model metadata for '…' not found` 是**预期警告**（0.154.0 / 0.156.1 都打）。

### 4.1 **`SubagentStop` 的真实载荷抓到了**——而且设计稿的 ⑤ 少列了一个字段（✅ 最重要的一条）

`SubagentStart` 与 `SubagentStop` 在 **0.154.0 与 0.156.1 上各触发 1 次**（`--dangerously-bypass-hook-trust` 必带，
不带则 0 载荷——⑦ 的信任闸门再次吻合）。**`SubagentStop` 逐字载荷**（去掉路径后的完整字段集）：

```jsonc
{ "session_id":"01a0f3d2-c3f9-…",
  "turn_id":"01a0f3d3-18e7-…",
  "transcript_path":"…\\rollout-…-01a0f3d2-c3f9-….jsonl",        // 父会话
  "agent_transcript_path":"…\\rollout-…-01a0f3d3-0dd9-….jsonl",  // 子会话（**新增字段**）
  "cwd":"…", "hook_event_name":"SubagentStop",
  "model":"deepseek-chat", "permission_mode":"bypassPermissions",
  "stop_hook_active":false,                                       // ← **设计稿 ⑤ 没列这一格**
  "agent_id":"01a0f3d3-0dd9-7e81-a2a2-cf5d7c6de8e3",              // 与 SubagentStart 的 agent_id 同值
  "agent_type":"default",
  "last_assistant_message":"2" }                                  // 另一版："2 — adding one and one gives a total of two."
```

**三条结论**：

1. ⚠️ **设计稿 §7.5.5 ⑤ 写「在 `SubagentStart` 全部字段之外**多两个**」是错的——真机是**多三个****
   （`agent_transcript_path` / **`stop_hook_active`** / `last_assistant_message`）。
   `stop_hook_active` 只在 schema 之外的运行时载荷里出现 ⇒ **又一条"schema 级不等于实测级"的证据**。
2. ✅ **确证 payload 里没有任何 `status`/状态字段**：`subagent-end.status` 在 codex 上**只能**走
   `last_assistant_message` 推或留 `null` + `statusMissing`。⇒ §6.4 开头那条"仅有 schema 级证据"的保留
   **现在可以升级为真机结论**（证据等级从「中」升到「强」）。
3. **机制对照（防止把"命令坏了"误判成"没触发"）**：同一次运行里 `SessionStart` 1 条、`UserPromptSubmit` 2 条
   ⇒ 配置被接受、闸门已开、hook 命令**真的被执行**。探测者自陈：第一版把日志器路径少写了一层 `probe`，
   三格全是 0 载荷，**差点得出"hook 不触发"的错误结论**；现在的脚本带**手工自检**
   （拿合成载荷喂同一条命令行，确认落盘）——这条做法值得写进 §7.6.5 的验证策略。

**顺带一个新通道（设计稿没有）**：**子智能体自己的 `UserPromptSubmit` 载荷带 `agent_id` / `agent_type`
以及它收到的 prompt 原文**（逐字：`"agent_id":"01a0f3d3-…","agent_type":"default",…"prompt":"请计算 1+1 的值…"`），
且 `agent_id` 与 `SubagentStart.agent_id` 对齐
⇒ §7.5.5 ⑨「`name` 只能从父消息的 `spawn_agent` 调用关联」之外**多了一条通道**（hook 侧直接拿到 prompt 原文）。

### 4.2 `spawn_agent` **在 DeepSeek 路由上真跑通了**（⚠️ 标题原写"推翻 §7.5「本仓无解」"——**追加轮已更正，见 §8.2**）

`features: { multi_agent: true }` + DeepSeek 路由 ⇒ `collab_tool_call` **18 条**，
且**不是空壳**：0.154.0 与 0.156.1 上都是完整的一条派发链，逐字（截取）：

```jsonc
{"type":"item.started","item":{"id":"item_1","type":"collab_tool_call","tool":"spawn_agent",
  "sender_thread_id":"01a0f3ce-a7fd-…","receiver_thread_ids":[],"prompt":"请计算 1+1 的结果，…",
  "agents_states":{},"status":"in_progress"}}
// 完成态：子线程 id 真的被填进来
{"id":"item_1","tool":"spawn_agent","receiver_thread_ids":["01a0f3ce-b2fc-…"],
 "agents_states":{"01a0f3ce-b2fc-…":{"status":"pending_init","message":null}},"status":"completed"}
// 然后 wait：子智能体真的回了答案
{"id":"item_2","tool":"wait","agents_states":{"01a0f3ce-b2fc-…":{"status":"completed","message":"1+1 = 2"}},"status":"completed"}
// 再 close_agent
```

⇒ **DeepSeek 路由下 codex 的 multi-agent 是能跑的**（子智能体真算出了 1+1=2）。
**这对 §7.5.2 的根因结论是一记重要限定**：那条"模型预设必须自带 `multi_agent` profile"是
**在内网网关那套模型名上**得出的；**本机这条路由（codex 不认识的模型名 ⇒ 落 fallback 元数据）
反而注册出了执行器**。⇒ 规范里"本仓无解、只能等网关"的措辞**至少不普适**，
应改成"**取决于路由与模型元数据，实测两种情形都出现过**"。
（本文不据此宣布问题已解——**未验证 fallback 元数据为何带执行器**，如实登记。）

### 4.3 `reasoning_output_tokens` **全部非 0**——推翻上一轮的"3/3 恒 0"

9 个完成的 run **9/9 非 0**：**123 / 50 / 65 / 53 / 117 / 56 / 84 / 51 / 61**。逐字样例：

```json
{"input_tokens":8152,"cached_input_tokens":6656,"cache_write_input_tokens":0,
 "output_tokens":165,"reasoning_output_tokens":123}
```

**与 `output_tokens` 的关系：9/9 恒 ≤**（123≤165、50≤97、65≤104、53≤93、117≤162、56≤89、84≤345、51≤324、61≤370）
⇒ codex 的 `thinkingTokensBasis` **有真机支撑可以升为 `'subset-of-output'`**
（与 claude 同形；这也解释了为什么两边都不是"第四个加数"）。

**但 `item.type === 'reasoning'` 一条都没有**（37 条 item 里 0 条）。**按本仓硬规矩先打印原始形态**：
wire 层 `POST /v1/responses`（`deepseek-reasoner`）的 `output[0]` 逐字是
```jsonc
{"type":"reasoning","id":"94c4fb5f-…","status":"completed",
 "content":[{"type":"reasoning_text","text":"我们需要回答中文。用户要求…（整段推理原文）…最终简洁。 "}],
 "summary":[],                       // ← 摘要是**空的**
 "encrypted_content":"7e1cadc3-…"}
```
⇒ **是 codex 没把 wire 的 `reasoning` 投影进 `exec` 事件流，不是抓取链路丢了它**。
两条落地含义：① §7.3 那行 `item.completed + item.type==='reasoning'` → `thinking` 块
**在本机这些后端上恒不触发**；② 设计稿说 codex 的思考文本是"推理**摘要**"（`textKind: 'summary'`）——
**逐字对**（`summary` 字段），但**这个后端给的是空的**，全文在 `content[].reasoning_text` 里而 codex 不投影它。

### 4.4 **事件 type 是 7 种**（补 `item.started`）；item type 3 种

```
事件 type 全集：thread.started · turn.started · item.started · item.completed · turn.completed · error · turn.failed
item  type 全集：error · agent_message · collab_tool_call
usage 键全集  ：input_tokens · cached_input_tokens · cache_write_input_tokens · output_tokens · reasoning_output_tokens
```
⇒ §7.0.2 / §0.2 的"5 种"、"6 种"都应写成 **7 种**（第三次数事件类型，前两次都少数了：
先漏 `item.updated`，这次补上 `item.started` 与两个失败态 `error`/`turn.failed`）。

### 4.5 §7.5.5 ⑧ 的前提被推翻：**0.156.1 能起来，但有一个致命的位置约束**

| 探测 | 结果 |
|---|---|
| 0.156.1 exe `--version` / `--help` | **exit 0**（`codex-cli 0.156.1`） |
| 0.156.1 exe `exec`（`$CODEX_HOME` 在用户目录） | exit 1，stderr 逐字 `WARNING: proceeding, even though we could not create PATH aliases: 拒绝访问。 (os error 5)` + `Error: failed to initialize in-process app-server client: 拒绝访问。 (os error 5)` |
| **同一个 exe 用 PowerShell 自己的管道 + 文件重定向直跑** | **同一条错误** ⇒ **上一轮"沙箱限制 node 管道/命名管道"的归因被推翻**（三条互不相干的通路都复现） |
| 0.154.0 同 argv/env/cwd | exit 0，5 条事件 ⇒ 差异在 0.156.1 自己 |

**9 组实验定出的边界（可复现，不是猜测）**：

| exe 位置 | `$CODEX_HOME` 位置 | 结果 |
|---|---|---|
| 仓库内（pnpm 原件） | 仓库内 | ✅ |
| 仓库内 | 仓库外（C: TEMP / 用户目录 / ProgramData / D: 仓库外） | ❌ os error 5 |
| 仓库内**复制件** | 仓库外 | ❌ |
| 仓库外**复制件** | 仓库外 | ✅ |
| 仓库外**复制件** | 仓库内 | ✅ |

⇒ **规则：exe 在工作区内时，`$CODEX_HOME` 也必须落在工作区内；exe 在工作区外则任意位置都行。**
（junction 双向对照排除了"路径字符串"解释，判的是**物理目录**。）

**对适配器的直接影响（这条是行动项）**：`src/providers/codex/index.ts:28` 是
`mkdtempSync(join(tmpdir(), 'aieval-codex-'))` ⇒ 落在 `C:\…\Temp` ⇒ **正好落在失败格**
⇒ **当前环境下 codex 这一家 0% 可用**（不是偶发）。两条已验证绕行：
① 把该行 scratch / `CODEX_HOME` 放到**工作区内**；② 把整棵 `vendor\x86_64-pc-windows-msvc` 复制到**工作区外**，
用 `codexPathOverride` 指过去。

**仍未定（如实登记）**：**机制未定**——已逐个排除盘符 / `%TEMP%` / 路径串 / cwd / ACL（补 Everyone、
三个沙箱账户、仓库根 SDDL 原件、`S-1-4-…`、logon SID 均无效）/ git 工作树 / 预建 sqlite / exe 文件本身
（pnpm 硬链接 vs 就地复制）。最像"DSH 对**工作区内镜像**启动的进程施加写限制、只放行工作区"，
但本机无 Procmon/ETW，**只能给边界，不能给机制**。

### 4.6 §7.5.5 的 JSONL 开关口径（闭合）

`codex exec --help` 逐字（0.154.0 / 0.156.1 **完全一致**）：`--json` / `Print events to stdout as JSONL`。
**`--experimental-json` 不在 help 里**（隐藏别名）但**被接受**；真跑 4 格（两版本 × 两 flag）
全部 **exit 0、5 行纯 JSONL**。SDK 0.156.1 用的正是 `--experimental-json`（与 §7.0 逐字一致）。

> ### 🔒 顺手发现的一个**真实密钥泄露**（与本轮无关，但必须报）
>
> `packages/server/agents/probe/v2/codex-cli-plan.ps1:26` **硬编码了一个 40 字符的明文网关密钥**
> （`$env:CODEX_API_KEY = '96c7…'`；同一文件第 27 行的网关是 `-test` 那台）。该文件**在提交里**
> （`probe/v2/` 是已跟踪目录）⇒ **密钥已进 git 历史**。
>
> **本轮已做的**：把那一行改成从环境变量 `AIEVAL_PROBE_GATEWAY_API_KEY` 读，未设置则**显式 throw**
> （不再有明文落盘）。**本轮没做的（越权，需你决定）**：
> ① **轮换那把 key**——它是唯一真正止血的动作，改文件不能撤销历史里的暴露；
> ② 若要清历史，得 rewrite（`filter-repo` / BFG），会改写所有 commit id，另议。
> 判定依据：该串是 40 位十六进制、与 `probe/v3/lib/gateway.mjs` 记录的 `apiKeys.likecode` 形态一致，
> 且被当作 `CODEX_API_KEY` 喂给 `-test` 网关。

---

## 五、逐项对照表（设计稿的"未验证"标记 → 本轮结论）

| # | 设计稿位置 | 原状态 | 本轮结论 |
|---|---|---|---|
| 1 | §11.1-30 / §7.9.1 `tool-web` override 语义 | ❌ 未验证 | ✅ **闭合**：**整份替换**；且 zod 默认值会把 `searchTimeoutMs` 静默 60000→30000；修法（写全三格）已验 |
| 2 | §6.5.2 / §11.1-20 dsh 子任务**失败（非取消）**路径 | ❌ 未抓到 | ✅ **闭合**：`status:"ok"` + `stopReason:"max-tokens"` ⇒ 证明 `status` 两方向都会骗人；`error`/`refusal` 仍未观测（已说明构造不可得） |
| 3 | dsh `subagent/descriptor`（§7「只见到事件名」） | ❌ 未解析 | ✅ **闭合**：载荷已逐字拿到；身份**只在信封 `params.sessionId`**；**不是逐子任务必发**（3 子任务 2 条） |
| 4 | dsh `subagent/catalog.mode` 取值域 | 只见过一种 | ✅ **闭合**：一次运行内同时见到 `one-shot` 与 `continuable` |
| 5 | §7.2 / §7.7.2 / §9.3 dsh 思考 token `reasoningTokens` | ❌ "真机未观测" | ✅ **闭合（更正结论）**：**结构性不可达**——本仓路由的 `mapUsage()` 从不写它；上游**确实给了** `reasoning_tokens` |
| 6 | §7.6.8 `exit_plan_mode`(dsh) 的 ※ 待真机确认 | ❌ 待确认 | ✅ **闭合**：在 dsh 入站工具表（25 项）里 |
| 7 | §7.6.8 claude 的 `ExitPlanMode`(cc) | ⚠️ 待确认 | ✅ **闭合**：二进制 29 处，但**不在**入站工具表 ⇒ 与 `AskUserQuestion`/`TodoWrite` 同档（mode/feature 门控），**不是"没有"** |
| 8 | §11 第 6 项 `DesignSync` 的"不存在"附注 | ⚠️ 过时 | ✅ **更正**：上一轮录的 30 项工具表里**有** `DesignSync` |
| 9 | §7.3 / §7.0.5 codex `item.delta` 的"待验证" | ⚠️ 待验证 | ✅ 上一轮已证不存在（0 命中）；本轮仅需把正文标记改掉 |
| 10 | §7.2 末"`subagent.started/finished` 从未被真机触发过" | ⚠️ 过时 | ✅ **已过时**：§6.5.1 已抓；本轮又抓 3 个子任务 × 3 种 stopReason |
| 11 | §7.6.2.1c「较新模型默认不带任务工具」的推论（待验证） | ⚠️ 待验证 | ✅ 上一轮 A/B 已推翻（默认就是 30 项）；正文标记需改 |
| 12 | §9.3 claude Workflow 闸门与规模告警 | ❌ 待实测 | ✅ **闭合（三条判据）**：① 闸门日志**在 debug 日志上、不在 stdout/stderr**（设计稿要改）；② DeepSeek 后端**真能驱动 Workflow**（12-agent 编排真跑完）；③ **规模告警进不去任何可见流** ⇒ 退化成纯计数留痕 |
| 12b | §7.8.1 ① `enableWorkflows` 的必要性 | 已定论 | ⚠️ **更正**：**不给 settings 时 `Workflow` 就在**（23 项）；`false` 才把它摘掉（22 项）⇒ 理由改为"钉住行为"，不是"不设就没有" |
| 12c | §7.6.2.1b「A/B 不重现」 | 已更正 | ⚠️ **再更正一次**：**工具表是模型相关的**——`deepseek-chat` 默认 23 → 开开关 27（**+4**）；`claude-sonnet-4-5` 27 → 27（无增量）⇒ 读这一节必须带模型名 |
| 12d | §7.6.8 里 claude 的子智能体工具名 | 未登记 | ✅ **新发现**：入站 `tools[]` 里叫 **`Agent`**、`system/init` 里叫 **`Task`**，**`Task` 在入站表里不存在** |
| 13 | §6.4 / §7.5.5 ⑩ / §9.3 codex `SubagentStop` 载荷与 status | ❌ 待实测 | ✅ **闭合（证据等级从「schema」升到「真机」）**：`SubagentStart`/`SubagentStop` 在 0.154.0 与 0.156.1 上各触发 1 次；`SubagentStop` 载荷 **12 字段、确证没有 `status`**；⚠️ 但**设计稿 ⑤ 说"多两个"是错的——真机多三个**（多 `stop_hook_active`） |
| 14 | §9.3 思考 token claude 行（`output_tokens_details.thinking_tokens`） | ❌ 无样本 | ✅ **已有真机取值样本**：19 条，取值全非负且**恒 ≤ output**（最大比 0.545）⇒ `basis` 的 `'subset-of-output'` **有真机支撑**（`dumps/v2/thinking-tokens.json`、`thinking-basis.json`） |
| 14b | claude 的 `thinking_tokens` 在第三方后端上的取值 | 未登记 | ⚠️ **新增登记**：经 DeepSeek 的 anthropic 端点**恒 0**（该端点不返回思考 token 字段，其 openai 端点才返回）⇒ **`0` 不得读成"这家不思考"** |
| 14c | 上一轮"claude `Bash` 在 SDK 路径恒 EPERM"的**归因** | 环境边界 | ✅ **归因改正**：不是 DSH 文件策略（当前 danger-full-access）、不是 OS/ACL（node/PS 都建得成、ACL FullControl）、不是脏状态（换全新 `CLAUDE_CODE_TMPDIR` 仍复现）⇒ 是 **claude.exe 自身工具沙箱**的拒绝。**仍未闭合**（本机无绕过开关） |
| 15 | §7.7.2 codex 行（`reasoning_output_tokens`） | ❌ 无样本 | ✅ **闭合（推翻上一轮"3/3 恒 0"）**：**9/9 非 0**（123/50/65/53/117/56/84/51/61），且 **9/9 恒 ≤ `output_tokens`** ⇒ `basis` 可升 `'subset-of-output'` |
| 15b | §7.3 `item.type === 'reasoning'` → `thinking` 块 | 映射已写但无样本 | ⚠️ **真机恒不触发**：37 条 item 里 0 条；而 **wire 层确实有** `reasoning`（`reasoning_text` 全文 + **空的 `summary`**）⇒ **是 codex 不投影，不是链路丢了** |
| 15c | §7.5.2「`spawn_agent` 本仓无解、只能等网关」 | 已定论（外部依赖） | ⚠️ **降级为"与路由相关"**（追加轮复跑后更正）：DeepSeek 路由 **能跑**（`1+1 = 2`，`collab_tool_call` 18 条）；**内网网关仍 `unsupported call`** ⇒ 原结论对**它自己的路径依然成立**，DeepSeek 是例外。且"认不认识名字"**不是**决定因素（两边都是 fallback 元数据） |
| 15d | §7.0.2 / §0.2 codex 事件 type 全集 | 5 种 / 6 种 | ⚠️ **第三次修正：7 种**（`thread.started`·`turn.started`·**`item.started`**·`item.completed`·`turn.completed`·`error`·`turn.failed`） |
| 15e | 上一轮「codex 0.156.1 起不来」的归因 | 环境边界 | ✅ **归因推翻 + 边界定死**：不是 node 管道（pwsh 直跑同样报错）；真规则是「**exe 在工作区内 ⇒ `$CODEX_HOME` 也必须在工作区内**」。适配器用 `tmpdir()` ⇒ **正好落在失败格（0% 可用）**；两条绕行已实测。**机制仍未定** |
| 🔒 | `probe/v2/codex-cli-plan.ps1:26` 的**明文网关密钥** | 未登记 | ⚠️ **已进 git 历史的真实密钥泄露**（非本轮引入）⇒ 建议**立刻轮换**该 key，并把该行改成从环境变量读 |

### 5.1 对 claude 思考 token 那 19 条样本的独立核对（本轮复核）

| 事实 | 值 |
|---|---|
| 样本数 | **19**（`claude-*.jsonl` 里全部 `result` 消息） |
| 字段出现率 | **19/19**（`usage.output_tokens_details.thinking_tokens` 恒在） |
| 取值集合 | 0、7、134、147、180、223、419、837、976、1027、1089、1268、1401 |
| 与 `output_tokens` 的关系 | **可用对 14 条**（`thinking-basis.mjs` 剔除了 `output_tokens = 0` 的 5 条空跑结果）；**零违例**，最大比 **0.5449** |
| 交叉校验档 `modelUsage[].thinkingTokens` | 与主源**同量级但不等**（例：223 vs `outputTokens` 541、`thinking_tokens` 223 vs `modelUsage` 223——同一格；换一条：主源 0 而 `modelUsage` 24）⇒ 印证 §7.7.2 的"不作主源" |
| 一条值得注意的差异 | `claude-tool-results.jsonl` 里有一条 **主源 `thinking_tokens = 0` 而 `modelUsage.Claude-Sonnet-4.6.outputTokens = 24`** ⇒ 两个来源**确实不同范围**，混用就会出现"思考 > 输出"式的自相矛盾读数 |

⇒ **claude 的 `usageCapability.thinkingTokens` 可以从 `'unverified'` 升为 `'yes'`**（有真机取值样本），
`basis` 保持 `'subset-of-output'`（类型面逐字 **＋** 真机 14 条可用对零违例）。

---

## 六、本轮仍未闭合（如实登记）

| 项 | 现状 | 还差什么 |
|---|---|---|
| dsh `stopReason` 的 `error` / `refusal` 两档 | 类型面有，真机未观测 | `subagent` 工具入参没有模型/供应商覆盖口，本机没有省事的构造法；要么等真实失败，要么改工具面 |
| ~~dsh `max-tokens` 的**定案**映射~~ **✅ 已定案（用户口径 2026-10-01）** | 真机值已拿到，映射已定 | **`'failed'`**（截断＝没做完；`outcome` 仍留半篇文本、信息不丢）；硬规则：**`stopReason !== 'completed'` 一律不得记 `'completed'`**，未观测取值（`error`/`refusal`）仍走 `null` + `statusMissing` |
| **codex 为什么 fallback 元数据也能注册 multi-agent 执行器** | **追加轮把它收窄了**：DeepSeek 路由能跑、**内网网关仍 `unsupported call`** ⇒ **"认不认识模型名"不是决定因素**（两边都是 fallback 元数据）；**真正的决定因素仍未定位** | 需要对比两条路由的 `wire_api` / 认证 / 上游响应形状（本轮只证到"不是名字"） |
| **codex 0.156.1 起不来的机制** | 边界已定死（exe 在工作区内 ⇒ home 也必须在工作区内），**9 组实验可复现** | 已排除盘符 / TEMP / 路径串 / cwd / ACL / git 工作树 / sqlite / exe 文件本身；**本机无 Procmon/ETW ⇒ 只能给边界** |
| **codex 为何不投影 wire 的 `reasoning`** | **追加轮把它降级了**：DeepSeek 路由上 0 条；**网关路径拿不到证据**（4 个 case 里 3 个因 `tool_choice` 提前失败、1 个用未知模型只产出一条 `agent_message`）⇒ 只能说"**在 DeepSeek 路由上不投影**" | 需要一个**能跑完 turn 的网关模型**（当前 47 个名字里**没有 `gpt-5.5`**，且带 tools 的请求被网关以 `tool_choice` 拒） |
| **claude 的 shell 工具在本机全不可用** | claude.exe **自身工具沙箱**拒绝工具级 `mkdir`（EPERM） | 厂商修；或找到那个工具沙箱的开关（本轮**未找到**）。**含义**：任何依赖 `Bash`/`PowerShell` 的 claude 观测在这台机器上都拿不到真实结果 |
| 规模告警"是否产生"（而非"是否可见"） | 只能证"**不进可见事件流**" | `tengu_*` 走 Statsig 的另一条网络通路，本轮**未观测** ⇒ **不得**据此说"事件不产生" |
| ~~内网网关（`likecode-llm-proxy.jd.com`）不可达~~ **✅ 已恢复（2026-10-01 追加轮）** | **网络可达**（3/4 端点），但两条新卡点：① `/v1/models` **不校验凭据**（假 key 也 200）；② 推理端点只认**那把曾被明文提交的 key**（config 里 4 把 + cc-switch 6 段**全 401**，报文「登录态丢失，请重启再试」**误导**） | 轮换并改用 `AIEVAL_PROBE_GATEWAY_API_KEY`；清掉过期的 key。**注意**：网关虽可达，**codex 仍跑不通**（见下两行） |
| **网关路径上 codex 目前不可用**（追加轮新登记） | `gpt-5.6-sol` / `-terra` → `tool_choice is only allowed when 'tools' are specified`（**带 tools 的请求被网关拒**，非"噪声"）；`gt-6-as-a` → `unsupported call` + `invalid_encrypted_content`；且 **47 个模型里已无 `gpt-5.5`** | 网关侧修 `tool_choice` 处理；或给 `gpt-6-astra` 这类**带 profile** 的名字（§7.5.3 牌 A 仍未满足） |
| **codex 这家当前 0% 可用（本机环境）** | 适配器 `src/providers/codex/index.ts:28` 用 `tmpdir()` ⇒ 落在失败格 | 改 scratch 落点（工作区内）或 `codexPathOverride` + vendor 外置——**两条都已实测可行，属实现改动，不在本轮范围** |
| **claude `Task*` 冷存储的"修法"**（上一轮报告 §七 的遗留） | 上一轮已证**失败形状**（`~/.claude/tasks/<sessionId>` 与 `.lock` 都不建、对 ENOENT 未兜底）；**"自己预建这两级目录就能修好"这一步本轮没验** | 一次 `TaskCreate` 的 A/B（冷存储 vs 预建目录）——**本轮未做**，如实登记为遗留；症状与判据已在 §11.1 第 27 项写全 |
| **`30 vs 27` 里 `Monitor` / `PushNotification` 的缺失**（追加轮新登记） | 逐名 diff 已知：`Task`→`Agent` 是**改名**，另两个**不是**；从 exe 捞出的相关 `CLAUDE_CODE_*` 候选变量逐个开，**一个都没把它们带回来** | 差异**不止"模型名 + 环境开关"两个轴**（还含 CLI/SDK 版本或那条采集的参数）；**如实登记为未解释，不硬凑解释** |

---

## 七、VPN 恢复后的复跑（2026-10-01 追加轮）

> **触发**：用户告知 VPN 已恢复。本轮的目标原本是"在**适配器真实路径（内网网关）**上复跑那些
> 只在 DeepSeek 路由上验过的结论"。**结论是：复跑做了，但它没能把结论往好的方向推——反而推翻了我自己上一节的一条过头话。**

### 8.1 先纠正一条方法论错误：`/v1/models` **不校验凭据**

网关恢复后我第一件事是打 `GET /v1/models`：**3/4 端点 200、47 个模型**，于是我在对话里说了"网关回来了"。
**这句话的下半截是错的**——用一把**故意写错**的 key 打同一个端点，**照样 200**：

| 探测 | 结果 |
|---|---|
| `GET /v1/models` + 真 key | 200 |
| `GET /v1/models` + **假 key**（`definitely-not-a-real-key`） | **200** ⇒ 该端点**不校验凭据** |
| `POST /v1/responses` + `proxygateway` 的 4 把 key（`joybuilder`/`likecode`/`likecode2`/`likecode-glm52`） | **全部 401** |
| `POST /v1/responses` + `cc-switch.db` 里 6 段候选 | **全部 401** |
| 同上 × 3 端点 × 2 路径（`/responses`、`/chat/completions`）× 2 头部（`Bearer`、`x-api-key`） | 40/48 是 401 |
| **`codex-cli-plan.ps1` 提交版里那把（本轮已从小抄撤下、仍在 git 历史）** | **8/8 组合 200** ✅ |

⇒ 两条要记的：
1. **"models 200"证明不了"能推理"**（这正是 §9.4.1"先证链路"的又一例，我差点又按一个不校验的端点下结论）；
2. 401 的报文是「**登录态丢失，请重启再试**」——它读起来像"网关自己到上游的会话掉了"，
   **实际含义是"这把凭据不被推理端点接受"**。按字面去"重启网关"是白费劲；
   **本机当前唯一能推理的凭据，恰好就是那把被明文提交过的 key**（这也是它当初被写进脚本的原因）。
   ⇒ 处置建议不变：**轮换它、放进 `AIEVAL_PROBE_GATEWAY_API_KEY`**，然后把 `proxygateway` 那几把过期的清掉。

### 8.2 ⚠️ 更正我上一节的一条**过头话**：§7.5.2 的结论**没有被推翻**

上一节我写「`spawn_agent` **真的跑通了** ⇒ §7.5.2「本仓无解」的定性**至少不普适**」。
在网关路径上复跑之后，正确的说法是**更弱的**那一个：

| 路径 | `features.multi_agent=true` 下的结果 |
|---|---|
| **内网网关** + `gt-6-as-a`（codex 不认识 ⇒ fallback 元数据） | ❌ 模型自述逐字：「工具表里有 `spawn_agent`，但调用时返回 **`unsupported call: spawn_agent`**」 |
| **内网网关** + `gpt-5.6-sol`（codex 认识，`multi_agent` profile 为 `null`） | ❌ turn 直接失败（见 8.3），**连模型的话都没出来** |
| **DeepSeek 路由** + `deepseek-chat`（同样 fallback 元数据） | ✅ `collab_tool_call` 18 条、子智能体真算出 `1+1 = 2` |

⇒ **"认不认识模型名"不是决定因素**：两边都是 fallback 元数据，结果相反。
**§7.5.2 的结论对它自己的那条路径（内网网关）依然成立**——我上一节说"推翻"是**越界**了，
准确措辞是「**结论与路由相关；DeepSeek 路由是已观测到的例外，机制未定**」。
（这条更正的代价很小、收益很大：把"已经解决了"的错觉挡在了规范之外。）

**同一批实验还顺带钉死了"执行器由什么决定"的一半**：`codex debug models` 逐模型解析（本地、0 调用）显示，
本机 0.154.0 的 **11 个模型里只有 `gpt-6-astra` 一个**在 `model_messages.multi_agent` 上带 profile：

```
gpt-6-astra  v2  带 profile        gpt-5.6-sol/-terra/-luna  v2/v2/v1  null
gpt-daybreak-blue/red-latest  v2  null        gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.2  null
codex-auto-review  v1  null
```

而**网关的 47 个模型里一个 `gpt-6-*` 都没有**（只有 `gt-6-as-a` / `gt-6-sol-a` / `gt-6-lu-a`，
codex **不认识**这三个名字）⇒ **§7.5.3「牌 A」的前提至今仍未满足**，与上一轮一致。

### 8.3 网关路径**当前连普通 turn 都跑不通**（新的环境事实）

四个 case 全部 `turn.failed`，两种失败模式**逐字**：

| case | 模型 | 失败原文 |
|---|---|---|
| `known-model-multi` / `known-model-reason` / `known-model-terra-reason` | `gpt-5.6-sol` / `gpt-5.6-terra` | `Invalid value for 'tool_choice': 'tool_choice' is only allowed when 'tools' are specified.` |
| `unknown-model-multi` | `gt-6-as-a` | 先 `unsupported call: spawn_agent`（模型自述），再 `invalid_encrypted_content`（`Encrypted content could not be decrypted or parsed`） |

**两条重要含义**：
1. `tool_choice` 那条**不是"噪声"**：上一轮报告 §2.4 已把它从"网关噪声"升级为"致命"，
   本轮**在 codex 的真实工具调用载荷上再次复现**——只要 codex 带着 tools 发请求，网关就拒。
   ⇒ **网关路径上 codex 目前不可用**（而这正是适配器唯一会走的那条路）。
2. **上一轮"唯一能跑完一个 turn 的模型名是 `GPT-5.5`"已过时**：本轮 47 个模型清单里**没有 `gpt-5.5`**。
   ⇒ "换个模型名就能跑"的老办法**这条路上也没了**。

### 8.4 因此有三条结论要**收回或降级**

| 上一节的写法 | 复跑后的写法 |
|---|---|
| "`spawn_agent` 真跑通 ⇒ §7.5.2 被推翻" | **降级**：「结论与路由相关；内网网关仍 `unsupported call`；DeepSeek 路由是唯一观测到的例外，机制未定」 |
| "codex 为何不投影 wire 的 `reasoning`：与后端无关" | **收回**：网关这四个 case 里 **3 个因 `tool_choice` 提前失败、1 个用未知模型只产出一条 `agent_message`** ⇒ **本次拿不到证据**（失败早于 reasoning 产出）。"不投影"目前**只在 DeepSeek 路由上成立** |
| "`reasoning_output_tokens` 9/9 非 0（可升 `'subset-of-output'`）" | **限定**：9/9 非 0 是 **DeepSeek 路由**的读数；网关路径**没有跑完的 turn ⇒ 无样本**。⇒ 那条升级**保留但必须带路由前提** |

### 8.5 顺带收口：`30 vs 27` 那处数字

用本机抓包（请求**到不了模型** ⇒ 与后端无关）把 09-30 的四个模型名逐字重跑，
读数一律 **27→27**（`CLAUDE_CODE_ENABLE_TODO_TOOLS` 全无增量）；逐名 diff 的结果是：

```
今天的 27 = 09-30 的 30 − {Task, Monitor, PowerShell, PushNotification} + {Agent}
```

- **`Task` → `Agent` 是改名**（同一件东西，已由 Q4 的双名发现独立佐证）；
- 我又从 exe 里把与这三个工具相关的 `CLAUDE_CODE_*` 候选变量捞出来逐个开，**一个都没把那三个名字带回来**
  ⇒ **`Monitor` / `PushNotification` 仍缺解释**。
- 结论：差异**不止"模型名 + 环境开关"两个轴**（还应含 CLI/SDK 版本或那条采集的参数）。
  **如实登记为未解释**，不硬凑一个解释。

> 这一条也再次证明 §9.4.1 那句"**报告某字段为空之前，先打印它的原始形态**"值钱：
> `codex debug models` 我第一版按"顶层 `multi_agent`"去抠，**抠出 0 个模型**；
> 打印原文才发现真实的落点是 **`model_messages.multi_agent`**，且**每个模型都有这个键**、
> 区别只在值是 `null` 还是对象。**按键名猜结构必然出错。**

### 8.6 一条**不成立的推断**，先挡住：网关路径上 hook 没落盘 ≠ hook 没触发

四次网关运行的 `hookByName` **全是空的**（连 `SessionStart` / `UserPromptSubmit` 都没有）。
而 DeepSeek 路由上这两条是**确实会触发**的（`SessionStart` 1 条 + `UserPromptSubmit` 2 条），所以有两种可能：
① 与 `tool_choice` 失败同源（turn 在第一次请求就被拒，钩子时序早于落盘）；② 网关路径的 hook 配置没生效。
**本轮没有把这两者分开** ⇒ **不得**据此说"网关路径上 hook 不触发"。
可复用的判据已在 §4.1 记着：**配一条手工自检**（拿合成载荷喂同一条命令行、确认落盘）——
否则"日志器坏了"会被读成"hook 没触发"，这正是上一轮差点踩的坑。

---

## 八、复现命令（本轮全部产物都由这些命令生成）

```powershell
cd packages/server/agents

# 0) 先证明链路（不花模型调用）
node probe/v4/smoke.mjs                     # DeepSeek 两条 wire + dsh 二进制解析

# 1) dsh：tool-web override 语义（本地，不花模型调用）
node probe/v4/dsh-tool-web-override.mjs

# 2) dsh：思考 token（三段证据：上游两条 wire + dsh 两档路由）
node probe/v4/wire-usage-shape.mjs          # 上游给不给
node probe/v4/dsh-reasoning-tokens.mjs      # dsh 投不投影

# 3) dsh：子任务失败路径 + descriptor
node probe/v4/dsh-subagent-failure.mjs      # status=ok + stopReason=max-tokens
node probe/v4/dsh-subagent-descriptor.mjs   # descriptor 的归属与 mode 取值域

# 4) 本地判据（不花模型调用）
node probe/v4/tool-table-check.mjs          # 二进制字符串计数 vs 入站工具表

# 5) codex（DeepSeek 路由；**注意 exe 与 CODEX_HOME 的位置约束**，见 §4.5）
node probe/v4/codex-sdk-deepseek.mjs        # Q1b：SDK 真跑（0.156.1 能不能起来）
node probe/v4/codex-deepseek-events.mjs     # Q2/Q3：事件与 item 全集、usage、collab_tool_call
node probe/v4/codex-hooks-deepseek.mjs      # Q4：SubagentStart/SubagentStop 真实载荷（带自检）
node probe/v4/codex-json-flag.mjs           # Q5：--json vs --experimental-json
node probe/v4/codex-156-location-matrix.mjs # Q1：exe 位置 × CODEX_HOME 位置的 9 组边界

# 6) claude（DeepSeek 的 anthropic 端点）
node probe/v4/q1-cli-anthropic.mjs          # Q1：CLI 5 个变体
node probe/v4/q1b-sdk-anthropic.mjs         # Q1：SDK 路径
node probe/v4/q2c-size-warning.mjs          # Q2 判据③：规模告警（构造 12 个 agent）
node probe/v4/q2d-debug-channel.mjs         # Q2 判据①：闸门日志到底在哪个通道
node probe/v4/q3-bash-sdk.mjs               # Q3：shell 工具的 EPERM
node probe/v4/q4-inbound-tools.mjs          # Q4：入站 tools[] 的模型相关性
node probe/v4/claude-report.mjs             # 汇总入口（→ dumps/v4/claude-report.json）

# 7) VPN 恢复后的追加轮（内网网关路径）
node probe/v4/gateway-restored.mjs          # 网关可达性 + 清单里有没有带 profile 的名字
node probe/v4/gateway-credentials.mjs       # 凭据矩阵（10 条 × 3 端点）
node probe/v4/gateway-credential-boundary.mjs  # 把责任边界钉死（含"models 端点不校验凭据"的对照）
node probe/v4/codex-gateway-events.mjs      # 网关路径复跑：spawn_agent / reasoning / hook
node probe/v4/codex-debug-models.mjs        # 哪些模型在 model_messages.multi_agent 上带 profile
node probe/v4/claude-tooltable-names.mjs    # 09-30 那三个模型名逐字重跑（30 vs 27）
node probe/v4/claude-tool-gates.mjs         # 哪些环境开关能带出 Monitor / PowerShell / PushNotification
```
