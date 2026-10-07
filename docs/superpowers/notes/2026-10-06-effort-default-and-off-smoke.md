# 思考强度（未选不关闭 + 显式关闭）真机冒烟 — 2026-10-06

> 任务：`docs/superpowers/plans/2026-10-06-effort-default-and-explicit-off.md` 的 Task 6 Step 3
> spec：`docs/superpowers/specs/2026-10-06-effort-default-and-explicit-off-design.md`（§1.5 / §5 / §6）
> 本工作线提交：`7d92a3a`（dsh 缺省 high）/ `561f18e`（claude `off` ⇒ `thinking:{type:'disabled'}`）/
> `e24540a`（codex `off` ⇒ `none`）/ `178d047`（api 候选放宽 + 未选也校验）/ `cadd697`+`036c1ba`（ui/client 下拉与文案）
> 完整报告：`.superpowers/sdd/2026-10-06-effort-default-and-explicit-off/task-6-report.md`
> **冒烟全程走用户正在用的 3083 服务（HTTP 调 API + 真浏览器点击）**：没有新起服务、没有 kill 任何进程。

---

## 一、范围清单（逐项 ✅ / ❌ / ⏭️）

| # | 项 | 结论 |
|---|---|---|
| 1 | 未选档位 ⇒ **dsh 行确实在思考** | ✅ 主线程 113 条含思考块（39,494 字）+ 子智能体 62 条（188,562 字） |
| 2 | 未选档位 ⇒ **claude 行确实在思考** | ✅ 主线程 1 条（56 字）+ 子智能体 5 条（5,476 字） |
| 3 | 显式 `off` ⇒ **dsh 行确实没思考** | ✅ **主线程 0 条 + 子智能体 0 条**（同期仍有 11 条正文消息 ⇒ 不是「什么都没干」） |
| 4 | 显式 `off` ⇒ **claude 行确实没思考** | ❌ **没有清零**：主线程仍有 1 条（52 字）、子智能体 1 条（21 字）。思考量从 5,532 字降到 73 字，但**不等于 0**。根因与归因见 §3.4 |
| 5 | codex 未选 ⇒ 请求体里**没有 `effort` 字段** | ✅ CLI 探针实测 `"reasoning":{"summary":"auto"}`；评测行的 rollout 里 `payload.collaboration_mode.settings.reasoning_effort` = **`null`**（brief 要核的那一格，**实测通过**；off 那行同格为 `"none"`） |
| 6 | codex 显式关闭 ⇒ 请求体里是 **`"effort":"none"`** | ✅ CLI 探针实测 `"reasoning":{"effort":"none","summary":"auto"}`（exit 0）；评测行 rollout 记到 `effort="none"`（**主线程与子线程两个 rollout 都是**） |
| 7 | 真下拉候选含关闭档且**排第一**（三家，上游未声明形态） | ✅ claude 6 项 / codex 9 项 / dsh 4 项，首项都是 `off（不思考）`（**文案已改**为 `off（要求不思考）`，见 §3.2 末尾的注） |
| 8 | 「未指定」与「关闭」是两件事 | ✅ 未选态占位符 = `未指定（dsh 用 high）`（清空态），下拉第一项是 `off（不思考）`（同上注） |
| 9 | 换档位后重开下拉：候选跟着换（Task 5 的待确认疑点） | ✅ 真机**会刷新**（claude 6 项 ↔ codex 9 项来回都对）⇒ 原 jsdom 现象是**环境产物**，不是产品缺陷 |
| 10 | **`effort:"none"` 真的等于「不思考」吗** | ❌ **不成立**（本次新发现）：codex 的 `off` 行实际推理 2,143 字（主）+ 18,869 字（子），**比未选那行还多**。见 §3.5 |
| 11 | 路径 B（智能生成 / 智能识别 / 文本评分） | ⏭️ 本次不改也不测（spec §4 已裁定）；它根本没有思考档位这一格 |
| 12 | 「上游声明过 `supportedEfforts`」的真机形态 | ⏭️ 本机两个 provider 都**没声明** ⇒ 只覆盖了「完整档位域」那条分支 |

---

## 二、操作路径

### 2.1 真实评测（一次 run，6 行，串行）

1. `POST /api/runs`（走已在跑的 `http://localhost:3083`）：
   `{caseId: d899e825-…（用例「简单测试」, repoPath D:\tmp\proj）, executionMode: "serial", useAgentJudge: false,
     rows: [dsh@deepseek-anthropic(未选), claude-code@deepseek-anthropic(未选), dsh(off), claude-code(off),
            codex@deepseek-openai(未选), codex(off)]}`
2. `POST /api/runs/f2cd60be-8ecf-4e0e-843d-3cded6477a8f/start`
3. 每 20s `GET /api/runs/{id}` 轮询到 `status=done`（12:20:01 → 12:46:06，约 26 分钟；6 行全部 `judged`）
4. 逐行读 `D:\.tmp\aieval\runs\<runId>\rows\<rowId>\messages.jsonl`：按 `mergeKey` **折叠成逻辑消息**后，
   统计含 `{"type":"thinking"}` 块的消息数（并拆分主线程 `subagentId === null` 与子智能体）
5. codex 两行另读该行 `.agenthome\sessions\**\rollout-*.jsonl` 的 `turn_context`

### 2.2 codex 请求体复验（CLI 探针，不入 repo、不动用户配置）

1. 起本次探测留下的 `%TEMP%\codex-probe\proxy.mjs`（只观察 + 转发到 `https://api.deepseek.com`，
   请求体落 `%TEMP%\codex-probe\requests-task6.jsonl`，**旧 `requests.jsonl` 一条都没动**）
2. 用 `%TEMP%\codex-probe` 里那份 **codex CLI 0.156.1** 跑三次 `codex exec`（`$CODEX_HOME/config.toml` 里给
   `model_provider=aieval` / `base_url=http://127.0.0.1:8899/v1` / `wire_api=responses`），
   三次只差 `model_reasoning_effort`：**整条不给** / `"none"` / `"off"`（提示词 `Reply with the single word: ok`）
3. 读落盘的请求体里的 `reasoning` 字段

### 2.3 真下拉（真浏览器，真实点击）

1. 打开 `http://localhost:3083/runs` → 点「创建评测」→ 选用例「简单测试」
2. 智能体 = `Claude Code`、模型 = `deepseek-flash@deepseek-anthropic` → **点开**「思考强度」读浮层候选
3. `Esc` 收起 → 智能体换成 `Codex` → 重选模型 `deepseek-flash@deepseek-openai` → **重开**同一个下拉读候选
4. `Esc` 收起 → 智能体换回 `Claude Code` → 重选模型 → **再重开**读候选
5. 全程**没有点「确定」**（最后点「取消」关闭面板）⇒ 没有产生任何 run

---

## 三、证据

### 3.1 真实评测的逐行读数（runId `f2cd60be-8ecf-4e0e-843d-3cded6477a8f`，status=done）

> 「含思考块的消息」= 按 `mergeKey` 折叠后的**逻辑消息**里出现 `{"type":"thinking"}` 块的条数；
> 「思考字数」= 这些块的正文总字数；同一行拆主线程 / 子智能体。

| 行（按创建序） | 行上的 `effort` | 主线程 thinking / 字数 | 子智能体 thinking / 字数 | 正文消息（主+子） | turns | 耗时 |
|---|---|---|---|---|---|---|
| dsh / bare | 未选 | **113 / 39,494** | 62 / 188,562 | 15 + 31 | 175 | 1,190,514ms |
| claude / bare | 未选 | **1 / 56** | 5 / 5,476 | 3 + 2 | 11 | 37,604ms |
| dsh / **off** | `off` | **0 / 0** | **0 / 0** | 3 + 12 | 17 | 54,029ms |
| claude / **off** | `off` | **1 / 52** | **1 / 21** | 3 + 1 | 6 | 20,130ms |
| codex / bare | 未选 | 6 / 1,484 | 1 / 2,418 | 7 + 2 | 8 | 92,777ms |
| codex / **off** | `off` | **3 / 2,143** | **10 / 18,869** | 4 + 11 | 5 | 128,363ms |

> 耗时列**逐格取自 `run.json` 的 `rows[].durationMs`**（2026-10-06 fix 轮更正：本表原先只有前两行是真值
> —— `dsh/off` 误写成 20,025ms（真值 **54,029**），另三格写成「—」而实际都有值
> （`claude/off` **20,130**、`codex/未选` **92,777**、`codex/off` **128,363**）。
> 口径：该字段是**候选 agent 那一段**的耗时（不含评分阶段），见 `EvalRowSchema.durationMs` 的注释。
> 「—」在本表里已不再表示「读不到」：六行都读到了。

- **dsh 的对照最干净**：未选 113+62 条思考块 ↔ `off` 0+0 条，而 `off` 行仍有 15 条正文消息 ⇒ 关闭档确实关掉了思考、且这一行照常干活。
- **claude 的 `off` 没有清零**（见 §3.4）；**codex 的 `off` 反而比未选思考更多**（见 §3.5）。
- 原始读数（含未折叠的行数）另存：`%TEMP%\task6-smoke-f2cd60be-….json`。

### 3.2 候选池与真下拉

- `GET /api/runs/model-options` 实测 `efforts`：claude `["off","low","medium","high","xhigh","max"]`、
  codex `["off","minimal","low","medium","high","xhigh","max","ultra","persistent"]`、dsh `["off","low","high","max"]`
  ⇒ Task 4 的「上游未声明 ⇒ 该家完整域 + 关闭档恒含且排第一」真机成立。
- 真浏览器读浮层（按 `aria-controls="rows_0_effort_list"` / 打开的 `.ant-select-dropdown` 取候选文本）：

| 步骤 | 重开后读到的候选 |
|---|---|
| Claude Code 行，第一次打开 | `off（不思考） / low / medium / high / xhigh / max`（6 项） |
| 换 Codex + 重选模型，**重开** | `off（不思考） / minimal / low / medium / high / xhigh / max / ultra / persistent`（**9 项**，不是旧的 6 项） |
| 换回 Claude Code + 重选模型，**再重开** | 又是 **6 项** |

⇒ **真机浮层跟着 `options` 刷新**。Task 5 fix 轮在 jsdom 里看到的「同一次挂载里换完模型重开仍是旧候选」
是 jsdom 的产物（真浏览器不复现）⇒ **不是产品缺陷**，无需登记产品问题；相应注释已据实改成 jsdom 限定。

> **文案口径的后续更正**（2026-10-06 fix 轮，本表记录的是当时的界面原文）：`off（不思考）` 已改成
> **`off（要求不思考）`**（候选与行卡片标签同一份文案，出处是 contracts 的 `effortLabel`；卡片浮层
> 同步改成「这一行要求关闭思考」）。原因就是本文件 §3.4 / §3.5 与 §一 的读数：claude / codex 选了
> `off` 之后**并没有真的停止思考** ⇒ 原文案是在向用户断言一件假事。契约定的是「记**我们要求的**
> 档位、不是**实际生效的**档位」，界面文案现在与它一致（见 spec §4）。

### 3.3 codex 请求体片段（本次复验，逐字）

`%TEMP%\codex-probe\requests-task6.jsonl`（8 条：1 + 1 + `off` 的 6 次重试）：

```
#1  2026-10-06T03:52:40Z  POST /v1/responses  model=deepseek-flash  reasoning={"summary":"auto"}                     ← 整条不给 effort（CLI exit 0）
#2  2026-10-06T03:53:09Z  POST /v1/responses  model=deepseek-flash  reasoning={"effort":"none","summary":"auto"}    ← none（CLI exit 0）
#3  2026-10-06T03:53:28Z  POST /v1/responses  model=deepseek-flash  reasoning={"effort":"off","summary":"auto"}     ← off（CLI exit 1，重试 6 次）
#4…#8 同上（`"effort":"off"` 的重试）
```

逐字片段（`body` 里的 `reasoning` 字段）：

- 不选档位：`"reasoning":{"summary":"auto"}` —— **没有 `effort` 字段** ✅（与 spec §1.5 一致）
- 关闭档（适配器送的就是这个值）：`"reasoning":{"effort":"none","summary":"auto"}` ✅
- 裸 `off`（**不经过适配器**的对照）：`"reasoning":{"effort":"off","summary":"auto"}` ⇒ 网关拒绝、CLI 重试 6 次后 exit 1
  ⇒ 再次证明 Task 3 的 `off → none` 映射是必要的。

评测行侧的对应证据（**按正确键路径重读**；`payload.reasoning_effort` 是少一层的错路径，见 §五 fix 轮 1）：

| 行 | `payload.collaboration_mode.settings.reasoning_effort`（brief 要核的那一格） | `payload.effort`（payload 顶层） | `payload.item.reasoning_effort`（`spawn_agent` 工具调用入参） |
|---|---|---|---|
| codex / bare（未选） | **`null`**（主 rollout 与子线程 rollout 都是） | 无此键 | `"medium"`（主线程派生子智能体时自己给的值） |
| codex / **off** | **`"none"`**（主 rollout 与子线程 rollout 都是） | `"none"`（两处都是） | `"none"` |

⇒ brief 的「codex 那行 rollout 的 `turn_context` 仍是 `reasoning_effort: null`」这一条**实测通过**；
顺带得到一条正面证据：**关闭档确实传到了子智能体**（子线程 rollout 同格是 `"none"`）。

### 3.4 ❌ claude 的 `off` 为什么还有思考块（归因到「不在本工作线的改动面」）

三段证据（都可复现）：

1. **适配器侧是对的**：单测 + 变异 M04/S02 证明 `effort: 'off'` 时我们确实给 SDK 的 `query()` 传了
   `thinking: {type:'disabled'}`、并且**不传** `effort`（Fake SDK 记录到的 options 就是如此）。
2. **网关侧是对的**：我直连同一端点（`https://api.deepseek.com/anthropic/v1/messages`，模型 `deepseek-flash`）实测两次：
   - 不带 `thinking`：`blocks=[{"type":"thinking","chars":292},{"type":"text","chars":49}]` ⇒ 会思考
   - 带 `thinking:{type:"disabled"}`：`blocks=[{"type":"text","chars":53}]` ⇒ **没有 thinking 块**（网关尊重这个开关）
3. **真机那一行仍然思考**：该行 `events.jsonl` 里 CLI 自己在上报 `system/thinking_tokens`
   （`estimated_tokens` 1→2→4→5→7→9… 递增），最终产出 1 条 52 字的思考块。

⇒ 落差在**中间的 CLI / Agent SDK**：这一层没有把 `Options.thinking = {type:'disabled'}` 落成「真的不思考」
（该版本 CLI 的 init 事件里另有 `per_turn_effort_active=false`，提示它可能改用 per-turn effort 这条通路）。
**本任务不修**（要拆 CLI/SDK 的参数落点，超出本工作线范围）。
**影响面**：用户口径「关闭档必须真的关掉」在 **claude × 本机 CLI/网关** 上**只部分成立**（5,532 字 → 73 字，但没有清零）。
**建议后续**：单开一项查「`Options.thinking` 在本机 claude CLI 版本上是否仍被尊重」；若已废弃，改走它支持的关闭通路。

### 3.5 ❌ codex 的 `effort:"none"` 不等于「不思考」（本次新发现）

- 请求体确实发了 `"effort":"none"`（§3.3 探针），CLI 也**处处**记成 `none`（`payload.collaboration_mode.settings.reasoning_effort`
  与 payload 顶层 `payload.effort`，**主 rollout 与子线程 rollout 都是**），
  **但**那一行仍产出 **2,143 字（主线程，3 条）+ 18,869 字（子智能体，10 条）**的推理正文，
  比**未选**那行（1,484 字主 + 2,418 字子）还多。抽样（逐字，截断）：

  ```
  [主线程] "The user wants to create a hello world page using CDN Vue3, and then use a subagent to review. Let me start by exploring the workspace.…"
  [子智能体] "The bytes: E5 BD 93 = UTF-8 for U+5F53 (当)? Let's check: …"
  ```
- ⇒ spec §1.5 的第 3 条结论「`none` ⇒ **能显式关闭**」是**过度推断**：它证明的只是「**网关接受**这个值」（请求 200、CLI 不重试），
  而**没有**证明「响应里不再有推理」。本次真机冒烟显示：**接受 ≠ 关闭**。
- **影响面**：codex 的「关闭思考」在本机网关上**做不到**（与 `off` 被拒是两件事）。用户口径里
  「必须显式配置才能关闭」在 codex 上目前**没有可用的旋钮**。
- **未定位的部分**：子线程的 `settings.reasoning_effort="none"` 已确认写进去了（且 `spawn_agent` 的入参也是 `"none"`）
  ⇒ 不是「参数没传到子线程」；更像网关对 `effort:none` 的处理（或 CLI 对 `none` 的理解）与我们的预期不同。
  **本任务只登记，不修**（改这里要重测网关语义，是另一次裁定）。

### 3.6 三件「额外核对」的结论

| 事项 | 结论 |
|---|---|
| 候选/下拉在真机上的表现 | ✅ 见 §3.2 |
| jsdom「重开不刷新浮层」是真缺陷还是环境产物 | ✅ **环境产物**（真机双向都会刷新）⇒ 注释已据实修 |
| codex 请求体复验 | ✅ 见 §3.3（未选无 `effort`；关闭 = `none`；裸 `off` 被拒） |

---

## 四、未覆盖项与后续

1. **claude 的 `off` 没清零**（§3.4）：根因在 CLI/SDK 层，未定位到具体参数落点 ⇒ 后续单开一项。
2. **codex 的 `effort:none` 关不掉思考**（§3.5）：后续要重测网关语义（或找别的旋钮）⇒ 另一次裁定。
3. **claude 的 `off` 行子智能体也有 1 条思考块**：claude 的子智能体会话是否继承 `thinking` 设置，本次没单独构造实验 ⇒ 未覆盖。
   （**codex 这一侧已有正面证据**：`spawn_agent` 的入参与子线程 rollout 的 `settings.reasoning_effort` 都是 `"none"` ⇒ 关闭档确实传到了子智能体。）
4. **上游声明过 `supportedEfforts` 的真机形态**：本机两个 provider 都没声明 ⇒ 「交集 ∪ 关闭档」只有单测（变异 M08 兜住）。
5. **同一个智能体下 A 模型 → B 模型的浮层刷新**：本机两个 provider 的 `deepseek-flash` 档位域完全相同，构造不出可区分的第二份候选
   ⇒ 真机上走的是「换智能体（会重置模型）⇒ 同一 `Select` 实例的 `options` 从一份换成另一份」这条路径，与 jsdom 用例的机制同类但不等同。
6. **codex 行的请求体**没有在**评测链路**里直接抓：那需要往用户真实 `config.json` 临时加一个指向本地代理的 provider
   （本次会话无法向用户请示，选择不动用户配置）⇒ 「适配器 → CLI 的 `modelReasoningEffort`」这一段只有
   `turn_context` 的 `effort="none"` 与单测/变异（M06/M07）兜住，**没有**端到端请求体。
7. **路径 B（智能生成 / 智能识别 / 文本评分）**：没有思考档位这一格，本次不测（spec §4）。
8. **`claude-code/index.test.ts:189-191` 的 8.3 短名环境断言**：既存红，非本次引入（本机 tmpdir 无短名）。

---

## 五、fix 轮 1（审查回来的一条 Important；本文件因此改了三处措辞）

**错在哪**：第一版读 rollout 用的是 `record.payload?.reasoning_effort` —— **少了一层键**，于是「原始读数」
（`%TEMP%\task6-smoke-f2cd60be-….json` 的 `codexTurnContexts`）对 codex/bare 与 codex/off **两行都**写成 `hasEffortKey:false`，
本文件与报告据此写成「读不到该字段：不是 `null`，是没这个键」——**失实**。审查者直接读 rollout 指出该键在
`payload.collaboration_mode.settings.reasoning_effort`，**该核对项其实通过**。

**正确读法**（深度遍历每条 rollout 记录，打印含 `effort` 的完整路径）已写进 §3.3 的表格：
未选 = `null`、关闭 = `"none"`（**结论不变、且顺带证明关闭档传到了子智能体**）。

**已做的三件事**：
1. 本文件 §2 核对项 5、§3.3 表格、§3.5、§4.3 按正确键路径重写（`payload.reasoning_effort` 的错路径在文中点名，免后人重踩）；
2. 那份错路径 JSON **就地修正**：`codexTurnContexts` 改名为 `codexTurnContextsWrongKeyPath`（**审计痕迹、勿引用**），
   新增按正确路径重读的 `codexRollouts`，并写 `meta.fixRound=1` / `meta.previousWrongKeyPath` / `meta.correctKeyPaths` / `meta.note`；
3. 门禁与本线 8 个测试文件在冻结提交 `0adb450` 上**重跑**，逐字输出落在
   `%TEMP%\task6-fix-typecheck.txt`、`task6-fix-typecheck-direct.txt`、`task6-fix-lint.txt`、`task6-fix-owned-tests.txt`
   （命令、退出码、错误条数与判据见报告的 §5.2 / §5.3）。**未跑全量 `pnpm test`**：evaluator 那 19/27 个文件会卡在收集阶段（§4.1）。

---

## 附：本次冒烟的临时件（不入 repo）

| 路径 | 用途 |
|---|---|
| `%TEMP%\task6-smoke.mjs` | 建 run / start / 轮询 / 落证据的驱动 |
| `%TEMP%\task6-smoke-evidence.mjs`、`task6-smoke-split.mjs`、`task6-smoke-thinking.mjs` | messages.jsonl 折叠与 thinking 块统计 |
| `%TEMP%\task6-codex-rollout.mjs`（第一版，键路径错，已废弃）、`task6-codex-rollout-fix.mjs`（正确路径，深度遍历） | 读 codex rollout 的 `reasoning_effort` / `effort` |
| `%TEMP%\task6-codex-run.mjs`、`task6-codex-probe.ps1`、`task6-probe-summary.mjs` | codex CLI 请求体复验 |
| `%TEMP%\task6-anthropic-thinking.mjs` | 直连网关判别 `thinking:{type:'disabled'}` 是否被尊重 |
| `%TEMP%\task6-fix-smoke-json.mjs` | fix 轮 1：把证据 JSON 里 codex 的读数按正确路径重读并就地修正 |
| `%TEMP%\codex-probe\requests-task6.jsonl`、`task6-scratch\` | 本次复验的请求体与 scratch（**旧的 `requests.jsonl` / `codexhome` 未改动**） |
| `%TEMP%\task6-smoke-f2cd60be-8ecf-4e0e-843d-3cded6477a8f.json` | 逐行原始读数（**fix 轮 1 已就地修正**：错路径字段改名、新增正确路径字段与 `meta` 说明） |
| `%TEMP%\task6-fix-typecheck.txt` / `task6-fix-typecheck-direct.txt` / `task6-fix-lint.txt` / `task6-fix-owned-tests.txt` | fix 轮 1 的门禁与测试逐字输出 |
