# p3 适配器真实事件探测报告（2026-09-22）

上位文档：`docs/superpowers/specs/2026-09-22-features-design.md` §5.6.3 / §11 第 5 步
计划：`docs/superpowers/plans/2026-09-22-features-p3-agents.md` Task 11

**结论一句话**：**三家都跑通了**；claude / codex 的计量字段名与 §5.6.3 的表**逐字一致**，dsh **确实有 usage**
（`session.event` → `assistant/message` → `data.usage`，字段名 `inputTokens` / `cacheReadTokens` / `outputTokens`）
⇒ 元数据 `usage: false → true` 成立。**但 dsh 的入口形态、通知外形、失败通道与注入口径与计划/spec 的描述
有四处实质差异**（入口无 `createRuntime`、通知是 `{method,params}`、用量挂在 `assistant/message` 而非「轮次结束
通知」、凭据只能靠环境变量 `DEEPSEEK_API_KEY` 而不是配置文件），已按实测回写（见 §7）。

## 0. 本次探测的可用性前提（如实登记）

| 项 | 事实 |
|---|---|
| `AIEVAL_PROBE_*` 全部环境变量 | **实测为空**（`Get-ChildItem env: AIEVAL*` 无输出） |
| `ANTHROPIC_*` / `OPENAI_*` / `DEEPSEEK_*` | **实测为空** |
| 唯一可用网关 | `cc-switch`（PID 32496）在 `http://127.0.0.1:15721` 上的本地中继；**只实现 `/v1/messages`**（`/v1/responses`、`/v1/chat/completions` 实测 **503 空体**），凭据由它自己管理（`ANTHROPIC_AUTH_TOKEN=PROXY_MANAGED`） |
| 公司网关 | `likecode-llm-proxy.jd.com` / `likecode-llm-proxy-test.jd.com` / `hubrouter-uat.jd.com` **全部连接超时**（网络不可达） |
| dsh 凭据 | `~/.dsh/.credentials.yaml` 里有 `DEEPSEEK_API_KEY`（35 字符）——dsh 探测即用它 |
| CLI | `claude` 2.1.281 ✓、`codex` 0.154.0 ✓、`dsh` **不在 PATH**（用 SDK 自带的 0.1.7-rc.1，见 §2） |

> ⇒ 计划 Step 1 的「四类前置条件」在本机**只有 dsh 一家天然满足**。协议口径迫使三家分流：
> claude 走本地 Anthropic 中继、dsh 走 `deepseek-official`（真实 DeepSeek API）、codex 因**没有任何可达的
> Responses 网关**而只能对着不可达的地址跑（结果见 §2）。

## 1. 环境与命令

| 项 | 值 |
|---|---|
| 网关 host | claude：`127.0.0.1:15721`（本地中继） / dsh：`api.deepseek.com`（`deepseek-official` route，SDK 默认） / codex：`likecode-llm-proxy.jd.com`（**不可达**） |
| 模型 | claude-code: `claude-haiku-4-5` / codex: `jd/GLM-5.3` / dsh: `deepseek-flash` |
| cwd | `%TEMP%\aieval-probe-cwd`（含一个 `README.md` 的最小目录） |
| 提示词 | 脚本默认：`回答一个字：好。不要调用任何工具，不要写文件。`（比计划默认的「新建 PROBE.txt」更省，且不产生文件改动） |
| 命令 | `node packages/server/agents/probe/raw-events.mts --kind=<kind>`（三家各一次）；`--mode=entry` 另跑三家入口形态 |

dump 位置：`packages/server/agents/probe/dumps/<kind>.json`（已 gitignore，未提交；**密钥复核见 §6**）

### 与计划的偏离（三处，逐条有理由）

1. **`<kind>` 专属环境变量**：`AIEVAL_PROBE_BASE_URL_CLAUDE_CODE` 之类优先于通用的 `AIEVAL_PROBE_BASE_URL`。
   计划假设「同一个网关分别兼容三种协议」，本机实测**不存在**这样的网关（本地中继只讲 Anthropic Messages），
   不分流就一家都跑不了。通用名仍然有效，专属名只是逐家覆盖。
2. **`configHome` 默认不再覆盖 HOME**：计划把 `HOME` / `USERPROFILE` 指向一个**新建的空临时目录**。三家 CLI 的
   登录态**都在真实的 `$HOME/<tool>` 里**，换掉 HOME 等于让三家一起变成「没登录」。改成：`configHome` 存进
   `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME`（这三格才是各家真正的配置根），HOME 保持宿主；
   需要旧行为的用 `AIEVAL_PROBE_OVERRIDE_HOME=1`，且 dump 里 `homeOverridden` 会留痕。
3. **dsh 的凭据必须显式注入**：见 §5 的四格对照 —— 空的 `configHome` 会让 dsh 直接以
   `turn/end(kind:'error')` 收场。加 `AIEVAL_PROBE_DEEPSEEK_API_KEY_DSH`（或通用的 `AIEVAL_PROBE_API_KEY_DSH`）。

## 2. 实测事件类型

### claude-code（24 条，走本地 Anthropic 中继）

```
  system × 21        （subtype: init ×1 + thinking_tokens ×20）
  assistant × 2      （content 分别是 thinking / text）
  result × 1
```

`system:init` 实测：`{"model":"claude-haiku-4-5","tools":27,"apiKeySource":"ANTHROPIC_API_KEY","cwd":"…\\aieval-probe-cwd","permissionMode":"default"}`

### codex（6 条，网关不可达）

```
  thread.started × 1
  turn.started × 1
  item.completed × 3
  error × 1
```

逐条原文（脱敏后）：

```
{"type":"thread.started","thread_id":"01a0d8b4-…"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n  session-flags: `disable_response_storage` is ignored.\n  session-flags: `tools.multi_agent` is ignored."}}
{"type":"item.completed","item":{"id":"item_1","type":"error","message":"…同上，重复一条…"}}
{"type":"item.completed","item":{"id":"item_2","type":"error","message":"Model metadata for `jd/GLM-5.3` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}
```

**这一家是「跑起来了但没跑通」**：CLI 起来了、`thread.started` 有了、配置解析的真实告警也有了，
但**一次模型调用都没成功**（`turn.completed` **零条**、usage **零条**）⇒ codex 的计量字段名**未能用实测确认**。

**但本次失败本身产出四条有价值的实测事实**：

1. **`disable_response_storage` 与 `tools.multi_agent` 对真实 CLI 是「不认识的配置项」**（`is ignored`，不是报错）
   ⇒ §5.6.4 表里「必须同时设置的项」这两格**在 codex-cli 上不生效**（不会 400，只是被忽略）。
2. **codex 的重试没有上界**：网关不可达时事件流**永不结束**（实测 >5 分钟无输出，脚本被外部超时杀掉）
   ⇒ 探测脚本与适配器都必须自带时限。
3. **失败通道的形状**：非致命告警走 `item.completed` + `item.type === 'error'` + `item.message`（**`item.text` 缺席**）；
   致命网络失败走**顶层** `{"type":"error","message":…}`。两者都被 codex 适配器现有的
   `item.*`（`text === null`）与 `type === 'error'` 两个分支覆盖到，**未发现漏投影**。
4. **模型元数据缺失是告警不是失败**（`item_2`）⇒ 不能把 `item.type === 'error'` 一律当运行失败。

### dsh（18 条，真实跑通）

```
  method:session.event × 15
  method:session.status × 2
  <无 type/method> × 1     （脚本自己塞的 __runResult 格子）
```

`session.event` 的 `event.type` 全序列（本次运行）：

```
  3 agent/inbox/spliced
  4 turn/start
  5 agent/inbox/spliced
  6 step/start
  7 system/message
  8 user/message
  9 user/message
 10 user/message
 11 request/header
 12 request/context
 13 session/title
 14 session-log-deepseek/delivery-accepted
 15 assistant/message          ← usage 在这里
 16 step/end
 17 turn/end                   ← 轮次结束在这里
```

`session.status` 两条：`{"sessionId":"session-…","status":"running"}` → `{"sessionId":"session-…","status":"idle"}`。

**`RunResult` 原文**（脚本 dump 在最后一条）：`{sessionId, finalResponse:"好", events:15, notifications:17}`。

## 3. 计量字段名对照表

| kind | §5.6.3 的说法 | 实测 | 结论 |
|---|---|---|---|
| claude-code | `result` 的 `usage`（输入 / 缓存读 / 输出）+ `num_turns` | `result.usage = {input_tokens:23798, cache_creation_input_tokens:0, cache_read_input_tokens:0, output_tokens:22, …}`、`result.num_turns = 1` | **一致**，`providers/claude-code/events.ts` 不用改 |
| codex | `turn.completed` 携带的 usage 负载 | **未观测到**（网关不可达，`turn.completed` 零条）。类型面（`dist/index.d.ts`）为 `Usage = {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` | 现有代码（`turn.completed` + `cached_input_tokens`）**与类型面一致**，真机未证实 |
| dsh | 待探测 | **有**：`session.event`（`method`）→ `params.event.type === 'assistant/message'` → `params.event.data.usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`；轮次结束是 `turn/end`（`params.event.data.reason.kind === 'completed'`） | **`usage: true`**；字段名见 §7 回写记录 |

三条补充口径（都来自实测原文）：

- `TokenUsage` 的计数是**互斥**的（`dsh-llm` 的 `.d.ts` 逐字）：
  「`inputTokens` is uncached input only; cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens`」
  ⇒ 映射到本仓三元组的 `input` / `cached` 不会双计。
- `cacheReadTokens` / `cacheWriteTokens` **是可选的**：本次实测两条都在，但类型上是 `?` ⇒
  回写时把「字段不存在」判成**未采到（null）**而不是 0，并复用既有的 WARN 口径。
- claude 的 `assistant.message.usage` 与 `result.usage` **同时存在**，但 `assistant` 侧的
  `output_tokens` 在两条消息里都是 `0`、只有 `result` 侧给出真值 ⇒ **继续只认 `result` 是对的**。

## 4. 与 §5.6.2 / §5.6.4 元数据表的差异

| 元数据格 | 计划/spec 的值 | 实测 | 处置 |
|---|---|---|---|
| `dsh.capability.usage` | `false`（探测前保守值） | **有 usage** | 改成 `true`（与提取逻辑同一次提交） |
| `dsh.capability.cancelMidTurn` | `false` | **确认 `false`**：SDK 的 `HarnessClient` JSDoc 逐字「There is no wire-level cancel: a timed-out request stays running server-side until the runtime is closed」；`close()` 是 EOF→SIGTERM→SIGKILL 阶梯 | **不变** |
| `dsh.protocolType` | `openai` | **实测偏斜**：`dsh-llm-deepseek` 走的是 **Anthropic Messages**（`POST {root}/v1/messages`，`x-api-key` 鉴权），不是 chat-completions | **照实测保留 `openai`**：这一格是「前端候选池按协议过滤」的口径（§5.1），改它要动契约与 p4/p6；差异登记在 §6，交裁决 |
| `dsh.isolation` | `subprocess` | 确认（SDK 用 `spawn(node, [dsh bin, --profile sdk])`） | 不变 |
| claude/codex 其余格 | — | 未发现冲突 | 不变 |

**§5.6.4 的「base URL 规范化」一格对 dsh 是「保留尾部 `/v1`」**：实测**成立但机制不是计划写的那样**。
真实实现（`dsh-llm-deepseek/lib/index.js:120-122`）：

```js
function messagesApiRoot(baseURL) {
  const base = baseURL.replace(/\/+$/u, "");
  return new URL(base).pathname.endsWith("/v1") ? base : `${base}/v1`;
}
```

⇒ **没有 `/v1` 就补、有就保留**（双向），最终打到 `{root}/v1/messages`。计划 Task 11 头部写的
「其 adapter 自己追加 `/chat/completions`」**是错的**（方法名不对）。本仓 `route.ts` 的 `keepBaseUrl`
（只去尾斜杠、处理重复斜杠）落在正确的一侧，**不需要改**。

**§5.6.4 的「必须同时设置的项」对 dsh 是「用 `configHome` 作为该行的 `HOME`（隔离会话与配置）」**：实测**不成立**：

- dsh 的配置根是 `DSH_HOME`（SDK 的 `resolveDshLaunch` 只认 `dshHome` → `DSH_HOME`，`lib/index.js:161-190`），
  **不是 `HOME`**；
- 而 `DSH_HOME` 一旦指向空的 `configHome`，凭据库里就没有 key，运行**必然**以
  `turn/end(kind:'error')` 收场（§5 四格对照的格 2）。

## 5. 注入对象核对（§5.6.4）

| kind | 注入点 | dump 里的实际值 | 与 §5.6.4 一致？ |
|---|---|---|---|
| claude-code | `ANTHROPIC_BASE_URL` | `http://127.0.0.1:15721`（**无 `/v1` 结尾**） | ✅ 一致（拆 `/v1`） |
| claude-code | `CLAUDE_CONFIG_DIR` | `C:\Users\…\.claude` | 计划写的是改 `HOME`；实测改用 `CLAUDE_CONFIG_DIR` 更准（§1 偏离 2） |
| codex | `model_providers.aieval.base_url` | `http://likecode-llm-proxy.jd.com/v1`（**补上 `/v1`**） | ✅ 一致 |
| codex | `wire_api` / `requires_openai_auth` | `responses` / `true` | ✅ 字段落点一致；**但 CLI 忽略另外两格**（§2） |
| dsh | `DSH_HOME` | 临时空目录 | 机制与 spec 描述不同（§4） |
| dsh | `DEEPSEEK_BASE_URL` | 探测时注入；**`dsh-llm-deepseek` 真的读它**（`BASE_URL_ENV = "DEEPSEEK_BASE_URL"`，`lib/index.js:2057,2136`） | ✅ 一致（保留 `/v1`） |
| dsh | `DEEPSEEK_API_KEY` | 探测时注入；**这是空 `configHome` 下唯一能拿到凭据的通道** | ⚠️ spec 未写这一条，是本次新增的口径 |

### 凭据来源的四格对照（这是本报告最要紧的实测之一）

在 `packages/server/agents` 里对着真实 SDK 跑的四个格子，唯一变量是 `dshHome` 与 `DEEPSEEK_API_KEY`：

| # | `dshHome` | 环境里有 `DEEPSEEK_API_KEY` | 结果 |
|---|---|---|---|
| 1 | 真实 `~/.dsh` | 否 | ✅ `finalResponse="好"` |
| 2 | 空临时目录 | 否 | ❌ `turn/end(kind:'error')`：`llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service` |
| 3 | 空临时目录 | 是 | ✅ `finalResponse="好"` |
| 4 | 真实 `~/.dsh` | 是 | ✅ `finalResponse="好"` |

⇒ **`configHome` 独立（§5.6.4 不变量 3）与 dsh 的凭据落点是矛盾的**，解药只有环境变量。
适配器注入 `DEEPSEEK_API_KEY` **不违反** §5.6.4 不变量 1/2（那是「不写 `process.env`」，
这里是「把凭据放进**替换型**子进程环境」——与 claude 的 `ANTHROPIC_API_KEY` 完全同形，且本仓的
`buildSubprocessEnv` 已经是那个通道）。

## 6. 未覆盖与后续

1. **codex 的 usage 字段名仍是类型面结论，不是真机结论**（唯一没跑通的一家，见 §2）。要闭合它需要：
   一个可达的、讲 OpenAI **Responses** wire 的网关（本机三家候选全部超时）。**p6 冒烟时补一次**
   `--kind=codex`；若那时仍不可达，`codex/events.ts` 的 `cached_input_tokens` 就只有类型面背书。
2. **`item.started` 是否带非空 `text`（台账 M3）**：本次**无法观测**（codex 未跑到模型调用）。
   类型面（`AgentMessageItem.text: string` 必填）**指向「带非空 text」**，而 JSDoc 又写
   「Typically the item is initially "in progress"」——两者都不能代替实测。**M3 保持开着**。
3. **dsh 的 `protocolType` 偏斜**（§4）：实测 `dsh-llm-deepseek` 讲 Anthropic Messages。改这一格要动
   契约 §5.6.2 的表与 p4/p6 的候选池语义 ⇒ **本次不改，交控制方裁决**（登记在台账）。
4. **dsh 的 `subagent.started` / `subagent.finished` 通知未触发**（本次提示词不派生子智能体）
   ⇒ 投影的默认分支（保留原始负载）对它们成立，但**没有实测样本**。
5. **dsh 的多轮 / 工具调用未覆盖**（提示词刻意要求不调用工具）。`tool/call`、`tool/result`、
   `step/end` 的多次出现都只在类型面上见过。
6. **本地中继（`cc-switch`）与生产网关不是同一个东西**：claude 与 dsh 的探测都经过它，
   它自己的上游路由会改写 `model`（实测请求 `claude-haiku-4-5` 回来 `model: "deepseek-v4-flash"`）
   ⇒ **事件「形状」可信，模型的「身份」不代表生产**。
7. **`codex-cli 0.154.0`（PATH 上）与 SDK 自带的 `@openai/codex 0.156.1` 不是同一个二进制**：
   `@openai/codex-sdk@0.156.1` 依赖自己那一份（`node_modules/.pnpm/@openai+codex-sdk@0.156.1/node_modules/@openai/codex`），
   适配器 spawn 的是 **0.156.1**。§2 的告警来自 0.156.1。
8. **dsh 的版本偏斜已澄清**：`D:\zhanglei1120\Github\deepseek-harness`（CLI 0.1.5-rc.2）**不是**适配器会 spawn 的那个；
   SDK 自带 `@deepseek-ai/dsh@0.1.7-rc.1`（`resolveDshLaunch` → `installedDshNodeLaunch()`，同版本校验通过）。
   ⇒ 「CLI 与 SDK 不同线」这条担心**在适配器路径上不成立**；两份 dsh 会在同一台机器上并存。

## 7. 回写记录（Task 12）

### 7.1 一处对 §1 偏离 2 的**更正**（后续实测推翻了我自己的中间结论）

§1 偏离 2 写「`configHome` 默认不再覆盖 HOME」。**再测一轮后更正**：真正必要的只有
**`DEEPSEEK_API_KEY` 必须进子进程环境**这一条。第五格实测（`HOME` 与 `USERPROFILE` **都**指向该行
`configHome`（空目录）+ `DSH_HOME` 同值 + 环境里的 key）**跑通了**（`finalResponse="好"`、
`turn/end: completed`）。所以：

- `configHome`（空目录）当 HOME 是**可以的**，spec §5.6.4 不变量 3 的隔离与 dsh 不冲突；
- 冲突只在「**既**隔离目录、**又**不给环境变量」这一格（§5 表格的格 2）⇒ 适配器注入
  `DEEPSEEK_API_KEY` 就闭合了它；
- 探测脚本仍然保留 `AIEVAL_PROBE_OVERRIDE_HOME` 这个开关（默认关），因为 claude 的登录态在宿主
  `~/.claude` 里，探测与生产的取舍不同。

### 7.2 回写清单

| 回写项 | 文件:行 | 改动 | 依据 |
|---|---|---|---|
| dsh 入口形态 | `src/providers/dsh/sdk.ts:26-111` | `createRuntime` 的假设窄结构 → 真实入口 `DeepSeekHarness` / `client.subscribe` / `run` / `close`（含 `HarnessNotification` / `NotificationSubscription` / `RunResult` 的真实外形） | Step 0 dump §2 |
| 形状校验 | `src/providers/dsh/sdk.ts:115-134` | 判据从 `createRuntime` 换成 `DeepSeekHarness`；`expected` 文案随之改 | Step 0 第 1 问 |
| dsh 事件判别字段 | `src/providers/dsh/events.ts:29-46` | `payload.type` → `payload.method` + `params.event.type`；新增四个导出常量（`DSH_SESSION_EVENT_METHOD` / `DSH_ASSISTANT_MESSAGE_TYPE` / `DSH_TURN_END_TYPE` / `DSH_USAGE_FIELDS`）逐字来自 dump | §2/§3 |
| dsh usage 提取 | `src/providers/dsh/events.ts:88-105` | 打开提取：`params.event.data.usage.{inputTokens,cacheReadTokens,outputTokens}`；缺项 → null + WARN（不填 0） | §3 |
| dsh 轮次与失败 | `src/providers/dsh/events.ts:59-86` | 轮次从 `turn/end` 计；失败读 `reason.kind === 'error'` 的 `reason.error`（**对象与字符串两种形状都认**） | §2/§3 |
| dsh usage 与轮次的**跨通知配对** | `src/turn.ts:49-66`、`src/providers/dsh/events.ts:69-76` | `TurnState` 增三个累计字段；dsh 在 `assistant/message` 上累计、在 `turn/end` 上连同轮次交出（§7.4 的 schema 要求 `turns` 必填，而两者不在同一条通知里） | §2 事件序列 |
| dsh 注入 | `src/providers/dsh/index.ts:117-131` | 新增 `DEEPSEEK_API_KEY`（凭据通道）、`dshHome` / `processCwd` / `env`（替换型） | §5 四格对照 |
| dsh usage 元数据 | `src/providers/dsh/index.ts:170` | `usage: false → true`（与提取逻辑同一次提交） | §3 |
| dsh 通知订阅 | `src/providers/dsh/index.ts:33-113` | 自己 `client.subscribe(filter)` 建流（**先订阅再交提示词**）；run 的 promise 当结束信号；run 的拒绝在排空队列后抛出（否则传输中断会被报成 `ok: true`） | §2 通知外形 |
| 夹具假入口 | `src/testing/agent-fixtures.ts:439-560` | `createRuntime` 的假件 → `createFakeDshSdk` 的 `DeepSeekHarness` 同形假件（含 `subscribe` + filter、`run` 以拒绝收场、`close` 让在途消费收到 rejection） | Step 0 + 复评 I1 的教训 |
| 夹具回归网 | `src/testing/agent-fixtures.test.ts:73-175` | 三格按新入口改写（close 早于/晚于挂起点、`startError`），**新增**「订阅过滤器真的挡住别的会话」一格 | 同上 |
| dsh 测试 | `src/providers/dsh/{events,index}.test.ts` | 全部构造数据换成实测外形；新增失败通道两格、用量提取一格、`usage` 事件一格 | §2/§3 |
| 元数据回归网 | `src/registry.test.ts:24-29` | `EXPECTED_METADATA.dsh.capability.usage → true` | §3 |

**未回写（照实测判定的「不需要改」）**：`providers/claude-code/events.ts` 的
`input_tokens` / `cache_read_input_tokens` / `output_tokens` / `num_turns`（§3 逐字一致）；
`providers/codex/events.ts` 的 `cached_input_tokens` 与 `turn.completed` 分支（类型面一致，
真机未证实 ⇒ 不改）；`src/route.ts` 的 `keepBaseUrl`（§4 判定方向正确，只订正了注释里的方法名）。

### 7.3 变异验证（每条守卫：改实现不改测试 → 红 → 还原 → `git hash-object` 相同）

**18 条变异体全部 KILLED**（另有 3 条当场判定为**等价变异体**，逐条给了理由，见 7.4）：

| # | 变异体 | 命令 | 红输出（首条） | 还原后哈希 |
|---|---|---|---|---|
| M1 | `sdk.ts` 形状校验回到 `createRuntime` | `npx vitest run src/providers/dsh/index.test.ts` | `expected undefined to be 'https://gw.example.com/deepseek/v1'`（9 failed / 1 passed） | SAME |
| M2 | `events.ts` 不再读 `usage` | `… src/providers/dsh/events.test.ts src/providers/dsh/index.test.ts` | `expected null to deeply equal { input: 218, cached: 8832, output: 2 }`（2/17） | SAME |
| M3 | 缓存读字段名改回猜的 `cachedTokens` | 同上 | `expected { ok: true, …(4) } to match object { ok: true, …(3) }`（1/18） | SAME |
| M4 | 失败时不再落 `error` 事件 | `… src/providers/dsh/events.test.ts` | `expected false to be true`（2/7） | SAME |
| M5 | `turn/end` 不再累加轮次 | 同 M2 | `expected +0 to be 1`（3/16） | SAME |
| M6 | 未识别通知静默丢弃 | 同 M2 | `expected [] to have a length of 1 but got +0`（5/14） | SAME |
| M7 | 不再注入 `DEEPSEEK_API_KEY` | `… src/providers/dsh/index.test.ts` | `expected undefined to be 'sk-dsh'`（1/9） | SAME |
| M8 | 会话过滤失效 | 同上 | **SURVIVED ⇒ 见 7.4（等价变异体）** | SAME |
| M9 | `run()` 的拒绝被吞 | 同上 | `expected true to be false`（1/9） | SAME |
| M10 | `usage` 元数据翻回 `false` | `… src/registry.test.ts` | `dsh 的元数据: expected {…} to deeply equal {…}`（1/7） | SAME |
| M11 | 握手不再 `await` | `… src/providers/dsh/index.test.ts` | `expected [ 'dispose' ] to deeply equal [ 'start', 'dispose' ]`（2/8） | SAME |
| M12 | 夹具订阅过滤器被绕过 | `… src/testing/agent-fixtures.test.ts` | `expected { method: 'session.status', …(1) } to deeply equal {…}`（1/5） | SAME |
| M13 | 夹具 `close` 不 reject 挂起的等待者 | 同上 | `expected [Function] to throw … but got '夹具在这一格挂住了…'`（1/5） | SAME |
| M14 | 夹具 `startError` 不再抛 | `… src/testing/agent-fixtures.test.ts src/providers/dsh/index.test.ts` | `promise resolved "undefined" instead of rejecting`（2/14） | SAME |
| M15 | 夹具 `hang` 时也发 idle | `… src/providers/dsh/index.test.ts` | `expected 'completed' to be 'canceled'`（1/9） | SAME |
| M16 | 夹具通知不带会话归属 | 同上 | `expected { ok: true, …(4) } to match object {…}`（4/6） | SAME |
| M17 | `turn.ts` 的 usage `turns` 守卫失效 | 同上 | `expected +0 to be 1`（1/9） | SAME |
| M18 | 夹具传输中断不再抛 | 同上 | `expected true to be false`（1/9） | SAME |
| M19 | `events.ts` 的 tokens 只在 draft 里交、不从投影返回 | 同上 | **SURVIVED ⇒ 见 7.4** | SAME |
| M20 | `events.ts` 放宽「未识别通知」的判定 | `… src/providers/dsh/events.test.ts` | **SURVIVED ⇒ 见 7.4** | SAME |
| M21 | `sdk.ts` 形状校验完全不查 | `… src/providers/dsh/index.test.ts` | `expected 'AGENT_FAILED' to be 'AGENT_LOAD_FAILED'`（2/8） | SAME |

### 7.4 三条**等价变异体**（存活，但不当缺陷处理）

| # | 变异体 | 为什么不可杀 |
|---|---|---|
| M8 | `index.ts` 的会话过滤器恒真 | 适配器的每次运行只 mint **一个** 会话，夹具投递的通知全部带那个 id（`tagSession` 保证同形）⇒ 过滤与不过滤**可观测行为完全相同**。「过滤别的会话」这件事由夹具自己那一格（`agent-fixtures.test.ts` 的「订阅按会话过滤」）钉住；适配器这一侧要产生跨会话通知，需要一个真实的多会话 runtime，探测里没有这种形状。**登记为等价变异体**，不补假用例（复评 I1 的教训：假前提下的守卫是假绿）。 |
| M19 | `turn/end` 的投影返回 `tokens: null`（draft 里仍有 usage） | `takeTurnTokens` 的**副作用**（清空本轮累计）仍在，且 usage 事件已经由 draft 发出、骨架的 `tokens` 也会在同一条投影上被赋回同一个值 ⇒ 与不改**完全等价**。 |
| M20 | 去掉「method 必须是 `session.event`」这道前置判断 | 两种实现都落到同一个 `unknown(raw)`（非 `session.event` 的通知本来就没有 `params.event`，`type` 读出来是 null，两个分支都不匹配 `assistant/message` / `turn/end`）⇒ 不可区分。**但这条判断仍然保留**：它是「哪条通知是什么」的显式口径，未来 `session.status` 之外新增方法时是唯一的分流点（`session.status` 那一格就是靠它落到「保留原始负载」）。 |

### 7.5 真机端到端验证（**不是夹具**）

把**真实的** SDK 模块注入运行时、用**真实的适配器**跑了一次（一次性探针，跑完删除）：

```
REAL RESULT {"ok":true,"exitReason":"completed","tokens":{"input":6583,"cached":768,"output":2},"turns":1,"durationMs":6246}
REAL USAGE {"type":"usage","tokens":{"input":6583,"cached":768,"output":2},"turns":1}
```

⇒ 适配器在真机上从「唯一结论是 `AGENT_LOAD_FAILED`」（Task 12 之前）变成**能跑通并采到计量**。
注意 `REAL EVENT TYPES` 里 `usage` 出现**两次**：一次是 dsh 投影在 `turn/end` 上发的，一次是骨架
的循环内发射口（它看到本条投影同时给了 `tokens` 与 `turns`）。两条内容相同、只是 `seq` 不同
——落盘侧由 `core` 的 `appendEvent` 重新分配 seq 并去重（契约 §3.4），这里**如实登记**为
已知的重复发射，不在 Task 12 范围内改动骨架的公共发射口。

