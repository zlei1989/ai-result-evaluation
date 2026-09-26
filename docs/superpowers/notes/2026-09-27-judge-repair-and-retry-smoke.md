# 冒烟记录：评分结构修复 + 行级重试（2026-09-27）

> **后续口径变更（2026-09-28）**：本文里「三行都仍有 `重新评分` 按钮」那一格已不成立——
> 用户口径先收紧成「已经测试完成且没有报错的行不能重新评测；评分也只有评分失败报错时才可重新评分」，
> 按钮「重试」也改名为「重新评测」；**同日晚间又放开**成「已出分、无报错时取消禁用」，
> 按钮文案改成「重新执行」。判据与实测见
> [`2026-09-28-reevaluate-and-rescore-gating-smoke.md`](2026-09-28-reevaluate-and-rescore-gating-smoke.md)
> 与 [`2026-09-28-reopen-reevaluate-and-rescore-smoke.md`](2026-09-28-reopen-reevaluate-and-rescore-smoke.md)。

> 目标页：`http://localhost:3083/runs?panel=detail&id=ae798e52-59df-4fa9-9d2b-dc89e5e98378`
> （用例「增加需求关注人」，仓库 `git@coding.jd.com:FlowAI/rbac-server.git` @ `8ae84f6`，串行 3 行）
> 上位口径：`README.md` 的「⑤′ 重试：三种失败、三条出路」与「分数怎么来的」。
> **只记实测值**；读不出来的写「未覆盖 + 原因」，不写「看起来正常」。

## 1. 本轮改了什么（先说清判据，再看证据）

| # | 能力 | 判据 | 落点 |
|---|---|---|---|
| 1 | 评分结果异常 ⇒ **结构检查 → 把错误回问大模型**（第二轮，最多 2 轮） | 第一轮不合格时**必须**发出第二轮请求，且那一轮对话里带「它自己的原文 + 具体错误 + 5 个 key 清单」；第二轮合格即正常出分（总分仍由 5 维重算） | `evaluator/src/judge.ts`（`validateJudgeResponse` / `buildJudgeFeedback` / `judgeRow` 的修复循环）、`text-api.ts` 的 `callTextApiConversation` |
| 2 | 瞬时失败（网络 / 5xx / 限流）**自动重试**，且**候选 agent 阶段的 failed 也走这条路**（原来只有「抛异常」那条路会重试，`AGENT_FAILED` 这类最常见的瞬时失败**一次都不重试**——本轮修掉了） | 文本请求最多 3 次尝试（复用同一段对话）；整行最多自动重跑 2 次（间隔 3 秒）；每次留痕（事件日志 + `attempts`） | `text-api.ts` 的 `TEXT_API_RETRY`、`orchestrator.ts` 的 `ROW_RETRY` / `runRow` / `runRowAttempt` 的返回值 |
| 3 | 单个评测项**手动重试**（执行 / 评分失败） | 行卡片「重试」按钮 → `POST /api/runs/{runId}/rows/{rowId}/retry` → 只重跑这一行（候选 agent + 评分），`attempts` 累加 | `orchestrator.ts` 的 `retryRow`、`api/src/runs.ts`、新路由、`useRetryRow`、行卡片按钮 |

**不变量**（修复只改形状、不改尺子）：5 维固定、各 1–5 整数、总分一律 `round(sum/25*100)` 重算、
维度缺失仍然失败（不按缺项算平均）。修复轮不改变其中任何一条。
**实测旁证**：本轮真实评分里模型自报 `totalScore: 97`，落盘是 **96**（= 5+4+5+5+5 → `round(24/25×100)`）——
「不采信自报总分」这条口径在真实数据上生效了。

## 2. 范围清单

| 项 | 判定 | 关键实测值 / 证据 |
|---|---|---|
| 目标页加载（3 行、状态与错误可见） | ✅ | 三张卡片：`Claude Code 失败`（`INTERNAL：文本 API 返回的不是合法 JSON…`）、`Codex 失败`（`AGENT_FAILED：Codex Exec exited with code 1`）、`DeepSeek Harness 已终止` |
| 新按钮「重试」出现且可点（失败行） | ✅ | 三行都有 `button "重试"`；三行都可点（都不是在途状态） |
| 未跑过的行禁用「重试」并给出原因 | ✅ | 单测钉住（`eval-row-card.test.tsx` 的三条否决面 + Tooltip 文案） |
| 「重试」的二次确认弹窗（写清「候选 agent 与评分都会重跑」） | ✅ | 实测弹窗文案：`重试这一行？/ 候选 agent 与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。` |
| 点击确认后服务端真的重跑该行 | ✅ | 页面状态 `准备中 → 执行中 → 已评分`；`events.jsonl` 第 1、2 条是 `status/preparing`、`status/running`（时间戳 22:01:19 / 22:01:26）；候选 agent 真的又跑了一次（11827 条 log、60 轮） |
| 出分正确（总分由 5 维重算） | ✅ | `run.json`：五维 `5/4/5/5/5` → `totalScore: 96`；模型自报 97 被忽略 |
| 「重新评分」仍可用（回归） | ✅ | 三行都仍有 `重新评分` 按钮；未点（本轮不重复消耗上游） |
| **结构修复回问**在日志抽屉里可见 | ⏭ 未在真机复现 | 本轮评分**一次就合格**（JSON 合法、5 维齐全），故没有触发回问。该路径由单测覆盖：`judge.test.ts` 的「多轮修复」三条 + 编排层留痕一条；**变异验证**：把 `JUDGE_REPAIR_ROUNDS` 改成 0，那两条立刻变红（见 §5） |
| **瞬时失败自动重试**在真机可见 | ⏭ 未在真机复现 | 上游在本轮里没有抖（评分一次成功）。该路径由单测覆盖：`orchestrator.test.ts` 的「瞬时失败的自动重试」六条 + `text-api.test.ts` 的六条；**变异验证**见 §5 |

## 3. 环境

| 项 | 实测值 |
|---|---|
| 地址 | `http://localhost:3083`（`pnpm dev`，Next 16.2.7 Turbopack） |
| 上游网关 | `likecode-llm-proxy-test.jd.com`（默认评分模型 `jd/GLM-5.3`，anthropic 协议） |
| 上游可用性 | 实测一次 `500 {"type":"error","error":{"type":"api_error","message":"服务维护中，请稍后重试"}}`（13:xx）；重试时段**已恢复**（评分一次成功） |
| 服务端改动生效方式 | **重启 dev server**（改了 `packages/**` 的源码，旧进程的模块表是旧的）。重启前先 `Stop-Process` 占端口的进程 |

## 4. 操作路径与证据

**操作路径**（真实浏览器，MCP Playwright）：

1. 打开 `http://localhost:3083/runs?panel=detail&id=ae798e52-59df-4fa9-9d2b-dc89e5e98378`；
2. 点第一行（`Claude Code · DeepSeek-V4.1-Flash-a · likecode`）的「重试」；
3. 确认框里点「确定」；
4. 页面自动变成「准备中」，随后「执行中」；
5. 约 6 分 30 秒后卡片变「已评分 / 得分 96 / 第 1 名」。

**证据互证**

| 侧 | 读数 |
|---|---|
| 页面（浏览器 DOM） | 卡片标题：`Claude Code · DeepSeek-V4.1-Flash-a · likecode`，extra：`已评分`，指标行：`缓存命中 99% · 轮次 60 · 耗时 6m00s · 得分 96`，带 `第 1 名` 徽标；`评分详情` 按钮由 `disabled` 变可点 |
| 盘上（`run.json`） | `status: judged`、`attempts: 1`、`error: null`、`score.totalScore: 96`、`score.judgeModelId: jd/GLM-5.3`、`score.judgeAgentKind: null`（纯文本通路）、`tokens: {input: 30029, cached: 1976320, output: 22331}`、`turns: 60`、`diff: {filesChanged: 5, insertions: 241, deletions: 4, truncated: false}` |
| 盘上（`events.jsonl`） | `seq 1 status/preparing`（22:01:19）→ `seq 2 status/running`（22:01:26）→ …（11827 条候选日志）→ `diff-summary` → `score`（22:08:46.633）→ `status/judged` → `end/completed`。**事件总数 11832 条**，时间线自洽（准备 → 执行 → 算 diff → 评分 → 终结） |
| 文件编码 | `run.json` 首字节 `7B 0A 20 20 22 69 64 22 3A`（`{` + LF，**无 BOM**）；用 UTF-8 严格解码 + `ConvertFrom-Json` **解析成功**（PowerShell 控制台里显示的中文乱码是控制台代码页的问题，不是文件问题——同一份文本用 `read` 工具读是正常中文） |

**`attempts` 的读法（一处必须写清的口径）**：这一轮是**老快照**（schema 加 `attempts` 之前落的盘），
所以它没有这一格、按 `.default(0)` 读成 0；本轮手动重试把它推到 **1**。
换成新创建的轮次，同样的操作会得到 **2**（首次执行 1 + 重试 1）——这是 `attempts` 的**累计**语义，
不是「重试次数」。

## 5. 变异验证（守卫必须见过红）

| 变异 | 期望 | 实测 |
|---|---|---|
| M1：`runRowAttempt` 在候选/评分 `failed` 时不再把 `RowOutcome` 交回调用方（退回 `return null`） | 「瞬时失败的自动重试」三条红 | ✅ 3 failed（`expected 'failed' to be 'judged'`、`expected [ … ] to have a length of 3 but got 1`） |
| M2：`JUDGE_REPAIR_ROUNDS = 0`（关掉回问） | 「多轮修复」两条红 | ✅ 2 failed（`结构检查已回问模型 0 轮，仍未得到合格输出`） |
| M3：`TEXT_API_RETRY.attempts = 1`（关掉文本层重试） | 默认值那条红 | ✅ 1 failed（`expected 1 to be 3`） |
| M4：撤掉「退出错误不顶替原因」那一段（`if (false && …)`） | `turn.test.ts` 的样板用例红 | ✅ 1 failed（`expected 'Codex Exec exited with code 1: Readin…' to contain 'high demand'`） |
| M5：`appendAttemptRecord` 直接 return（账本不写） | 账本用例红 | ✅ 1 failed（`重试的每一次都进尝试账本`） |
| 还原 | orchestrator / judge / text-api / turn 四个文件的 SHA256 与变异前**逐字相同** | ✅（turn.ts 为新增改动，无基线可对比；其余三个见前一行） |

## 5. 追加：Codex 行报错的**误判纠正**（2026-09-27 晚，用户点名）

### 5.1 问题与结论

用户看到的行内报错是 `AGENT_FAILED：Codex Exec exited with code 1: Reading prompt from stdin...`，
问「codex 是否使用 SDK 方式操作」。**答案：是 SDK 方式，且链路正确**；那句话**不是失败原因**。

| 核查项 | 实测 |
|---|---|
| 适配器是否走 SDK | ✅ `packages/server/agents/src/providers/codex/index.ts` 用 `await loadCodexSdk()` → `new sdk.Codex({apiKey, baseUrl, config, env})` → `client.startThread(...)` → `thread.runStreamed(prompt, {signal})`。**没有**任何手写 `spawn`/`exec` 或自己拼 CLI 参数（`spawn` 只出现在 SDK 内部与我们未使用的 `bin/codex.js` 启动器里） |
| 谁拼的 CLI 参数 | ✅ 由 SDK 拼：`commandArgs = ['exec','--experimental-json', …--config…, '--model', …, '--sandbox', …, '--cd', …, '--skip-git-repo-check']`，然后把 prompt **从 stdin 喂进去**（SDK 源码 `dist/index.js` 的 `CodexExec.run`） |
| `Reading prompt from stdin...` 是什么 | ✅ **codex CLI 每次运行都会打印的提示**（stderr），与成功失败无关。**实测**：把同一份 argv 打到一个本地假 Responses API 上，退出码 **0**、事件流正常（`thread.started → turn.started → agent_message → turn.completed`），而 stderr 里**照样**是这一行 |
| 它为什么会出现在错误文案里 | ⚠️ **SDK 的缺陷**：`Codex Exec exited with code ${code}: ${stderrBuffer}` 把 **stderr 全文**拼进 message。CLI 的 banner 与 SDK 的前缀**在同一行**（`Codex Exec exited with code 1: Reading prompt from stdin...`），于是这一行里没有一个字是原因 |
| 真正的失败原因 | ✅ 上游网关：`500 {"type":"error","error":{"type":"api_error","message":"服务维护中，请稍后重试"}}`（`/v1/responses` 直接探测，同一时段三次都是 500）。事件流里本来就有 `{"type":"error","message":"We're currently experiencing high demand, which may cause temporary errors."}` → 1/5…5/5 重连失败 → CLI 退出码 1 |

### 5.2 改动（两处，都做了变异验证）

| # | 改动 | 落点 |
|---|---|---|
| A | **退出错误不再顶替真正的原因**：`runTurn` 的 catch 现在只有两条判据成立时才用退出错误覆盖流内错误——① 它自带可识别的 HTTP 状态（401/403/429/400/404）；② stderr 剥掉 SDK 前缀与 CLI 样板之后还有实质内容。否则**保留流内原因**，并把「随后 CLI 以退出码 N 收场」作为补充写进文案 | `packages/server/agents/src/turn.ts`（`exitErrorAddsDetail` / `stripCliBoilerplate`） |
| B | **尝试账本** `{rowDir}/attempts.jsonl`（追加、**永不清空**）：每次尝试的 start 与 end（结局 / 归因码 / 是否还会重试）。原因：自动重试每次都 `resetEvents`，于是实测「`attempts = 9` 而 `events.jsonl` 里零条重试记录」——界面说「已重试 8 次」，日志抽屉里查不到任何一次 | `packages/server/core/src/workspace.ts` 的 `rowAttemptsFile`、`packages/server/evaluator/src/orchestrator.ts` 的 `appendAttemptRecord` |

### 5.3 真机复验（同一目标页，Codex 行再点一次「重试」）

| 侧 | 改前 | 改后（实测） |
|---|---|---|
| 行内报错 | `AGENT_FAILED：Codex Exec exited with code 1: Reading prompt from stdin...`（**没有一个字是原因**） | `AGENT_FAILED：We're currently experiencing high demand, which may cause temporary errors.（随后 codex CLI 以退出码 1 收场）` |
| 重试留痕 | `events.jsonl` 里 **0 条**重试记录（每轮都被 `resetEvents` 清掉） | `attempts.jsonl` 三条尝试、六条记录全部在盘：`#1 start / #1 end failed AGENT_FAILED retrying=true / #2 … / #3 end failed`，每条都带**真正的原因**文案。`events.jsonl` 仍只有当前尝试的 19 条（两条口径各司其职） |
| `run.json` | `attempts: 6` | `attempts: 9`（累计语义） |

**仍未通过的原因（如实登记）**：那一行最终仍是 `failed`——**上游网关在这一时段持续 500（服务维护中）**，
不是本工具的缺陷；等网关恢复后点该行「重试」即可，且届时那条 `attempts.jsonl` 会把这一次的过程完整留着。

## 6. 追加：目标改为「所有测试项都要跑完 测试 + 评价 两个环节」（2026-09-28）

目标口径变成「**确保所有测试项都能正确完成测试与评价 2 个环节**」。目标页三行的实测状态：

| 行 | 测试环节（候选 agent） | 评价环节（评分） | 状态 |
|---|---|---|---|
| Claude Code | ✅ 60 轮、11827 条事件、diff 5 文件 | ✅ 得分 96 | **两环节都完成** |
| DeepSeek Harness | ✅ 18 文件 +227 −3 | ✅ 得分 96 | **两环节都完成** |
| Codex | ❌ 退出码 1（0 文件改动） | —（没有改动可评） | **卡在第一环节** |

### 6.1 Codex 那一行的根因：上游 OpenAI 协议侧全线下线（外部）

同一时刻对同一个网关、同一把密钥逐端点各打 3 次：

| 端点 | 结果 |
|---|---|
| `POST /v1/messages`（Anthropic） | `500` × 3 → 之后一度恢复为 200（Claude/DSH 两行正是在恢复窗口里跑完的） |
| `POST /v1/chat/completions`（OpenAI 兼容） | `500` × 3（另一次连打 10 次全 500） |
| `POST /v1/responses`（OpenAI Responses） | `500` × 3（换四个模型、最小请求体、含不存在的模型名，一律 `{"error":{"message":"服务维护中，请稍后重试"}}`） |

不存在的模型名也回**同一句**「服务维护中」⇒ 说明该路由**整条不可用**，不是模型/请求的问题。
Codex CLI 自己重试 5 次后以退出码 1 收场（`Reconnecting... 1/5 … 5/5 (We're currently experiencing high demand…)`），
我们这一层的自动重试再补 2 次；**从 01:26 到 01:28 的两次「重试」都以同一句失败**。
结论：**这是外部依赖不可用，不是本工具的缺陷**；Anthropic 侧的另两行能在短暂窗口里跑完，正是因为它们走的是还活着的 `/v1/messages`。

### 6.2 顺带修掉一个**真的从未生效**的护栏（Codex 命名空间工具）

Codex 的每一行失败时事件流里都有这句（一直被忽略）：

```
Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.
  session-flags: `disable_response_storage` is ignored.
  session-flags: `tools.multi_agent` is ignored.
```

离线核验（**判据是 CLI 自己的忽略告警**，它在 `turn.started` 之前就打出来、与网络无关）：

| 注入的键 | CLI 0.156.1 的反应 |
|---|---|
| `tools.multi_agent=false`（旧实现） | ❌ **被忽略** |
| `disable_response_storage=true`（旧实现） | ❌ **被忽略** |
| `tools.web_search=false` | ✅ 被接受 |
| `features.multi_agent=false` | ✅ 被接受 |

而 `codex features list` 显示 **`multi_agent stable true`**——也就是说旧写法让「关掉多智能体」这条护栏
（§5.6.4 的理由：命名空间工具在网关侧常回 400）**从来没有生效过**：CLI 忽略未知键后照**默认值 true** 跑，
只在事件流里留一句谁也不会看的告警。

**修正**：`tools` 里只留 `web_search`，`multi_agent` 改走 `features.multi_agent=false`，并删掉无效的
`disable_response_storage`。核验（同一探针，两两对照）：

```
[cfg-final] fixed  => ignored: (none)
[cfg-final] legacy => ignored: disable_response_storage, tools.multi_agent, …
```

守卫：`packages/server/agents/src/providers/codex/index.test.ts` 断言 `config.features === { multi_agent: false }`
且 `config.tools === { web_search: false }`——只断言 `tools.multi_agent === false` 的实现**变异体照样绿**
（那正是它曾经漏掉这件事的原因）。

## 7. 未覆盖项与后续

1. **两条自动路径没在真机上复现**（结构修复回问、瞬时失败自动重试）——原因：上游在本轮里既没有回不合格
   JSON、也没有抖动。**这不是「跳过了」，是「没有靶子」**。要造靶子只能人为让上游回坏 JSON（本机没有可用的
   旁路代理），故本轮以单测 + 变异验证收口；真实环境再次遇到时，日志抽屉里会有
   `[评分] 第 N 轮返回未通过结构检查：…` / `[编排] 该行判定为瞬时失败（…），将在 3000 ms 后自动重试第 1/2 次`。
2. **「已重试 N 次」徽标没在真机上看到**——同样因为没有自动重试发生；`attempts` 的读法见 §4。
3. **本轮环境的两次自伤（如实登记，避免下次再踩）**：
   - 为核对基线建了一个 `git worktree` 并**手工建了一个指向主仓 `node_modules` 的 junction**；
     事后 `pnpm install` 报 `Already up to date` 但 `.pnpm` 里缺包（`@ant-design/colors` 等整目录不在），
     Turbopack 因此报一屏 `Module not found`。**处置**：把 `node_modules` 移开、`pnpm install --frozen-lockfile`
     重装（26s）。**教训**：`pnpm install` 认为「已是最新」时不会修复缺失的实体目录，**只能重装**；
     更根本的是**不要**为了跑基线在仓库里造指向主仓 `node_modules` 的链接。
   - 清掉 `.next` 后必须重启 dev server 才生效（Turbopack 会把旧的解析结果缓存进 `.next`）。
4. **`packages/server/core` 的 6 条用例在本机全量/单包跑时超时**（`git clone` 33s+，vitest 上限 20–30s）。
   已用 `git stash` 回到基线复验：**同样的失败**（`prepareRowWorkspace 首次调用` 超时）⇒
   与本轮改动无关，属既有环境/负载问题（本机另有一个 DSH Web 进程长期占 CPU）。
   全量套件里的 `route-run-artifacts`、`run-create-panel` 两条同类超时也在隔离复跑时全绿。
