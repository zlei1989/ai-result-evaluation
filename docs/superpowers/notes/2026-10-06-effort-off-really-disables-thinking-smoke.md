# 统一关闭档 `off` 真机复验（claude 0 思考块 / codex 0 条 reasoning + 未选对照）— 2026-10-06

> 任务：`.superpowers/sdd/2026-10-06-effort-off-really-disables-thinking/task-5-brief.md`
> 前作（同一被测对象的上一轮真机读数）：`docs/superpowers/notes/2026-10-06-effort-default-and-off-smoke.md`
> 本工作线提交：`8398c5a`（T1 claude 注入 `CLAUDE_CODE_EXTRA_BODY`）/ `6b2a91a`（T3 落 WARN）/
> `c372d24`+`aeef3a6`（T2 codex 补 `model_reasoning_summary:'none'`）
> 完整报告：`.superpowers/sdd/2026-10-06-effort-off-really-disables-thinking/task-5-report.md`
> **冒烟全程走用户正在用的 3083 服务（HTTP 调 API）**：没有新起服务、没有 kill 任何进程、没碰别人的在途文件。

---

## 一、范围清单（逐项 ✅ / ❌ / ⏭️）

| # | 项 | 结论 |
|---|---|---|
| 1 | 前置①：跑评测的进程里**没有** `CLAUDE_CODE_EXTRA_BODY` | ✅ 我的 shell 里**一个 `CLAUDE_CODE_*` 都没有**；并直接读 **dev server 进程的 PEB 环境块**复核：`ABSENT`（§3.1） |
| 2 | 前置②：跑评测的进程里**没有** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | ✅ 同上 PEB 复核 `ABSENT`；且该行 `events.jsonl` 里那条 WARN **0 命中** |
| 3 | **判据 A**：claude / `off` ⇒ **0 个思考块**（主 + 子两列都要 0） | ✅ **`thinkingMain=0` 且 `thinkingSubagent=0`**；且**原始记录口径**也是 0（不是折叠出来的 0） |
| 4 | **判据 B**：codex / `off` ⇒ **0 条 reasoning** | ❌ **28 条**（主 15 + 子 13），推理正文 28,169 字，网关自述 `reasoning_output_tokens` **7,347**（**最终值** = rollout 末次 `total_token_usage`：主 1,747 + 子 5,600；此前记的 **5,514** 是**中途快照** —— **T5 门审实测修正**；方向是**低估**，改大后判据 B 更红，**不改变任何判据与结论**）。**本次改动在 codex 上没生效**（§3.5） |
| 5 | **判据 C**：两家的「未选」对照行**都必须 > 0** | ✅ claude 未选 主 1 / 子 0（brief 口径，敏感口径 3+3）；codex 未选 **13** 条。⇒ A / B 有对照，本轮**可判读** |
| 6 | claude 的 `off` 行**确实干了活**（排除「0 = 没跑起来」） | ✅ 11 轮、输出 4,878 tok、改出 66 行 diff、status=`judged`、`attempts=1`、无 error |
| 7 | codex 的 `off` 行确实干了活 | ✅ 12 轮、输出 19,233 tok、status=`judged`、`attempts=1`、无 error |
| 8 | T1 的覆盖层**对子智能体也生效吗**（前作 §4.3 登记为「未覆盖」） | ✅ **本轮覆盖到、且是正面**：claude/`off` 行**派了**子智能体（折叠后 20 条逻辑消息 = 主 7 + **子 13**、子轮次 7），子智能体思考块 **0**；同期对照行子智能体 **3** 条 ⇒ 覆盖层确实传到子智能体 |
| 9 | codex **子线程**的 `summary` 取值（前作 §4.4 登记为「未覆盖」） | ✅ **本轮覆盖到**：`off` 行**主 rollout 与子线程 rollout 都记 `payload.summary="none"`**（对照行是 `"auto"`）⇒ T2 那一格**确实到了 CLI，也到了子线程** |
| 10 | ② codex 出网**请求体**是否逐字复现 stepF（`summary` 消失） | ⏭️ **未覆盖**：评测链路里抓请求体要往真实配置加一个指向本地代理的 provider ⇒ 不动用户配置（与前作 §4.6 同一处置） |
| 11 | ③ claude 的 hipaa 策略位 | ⏭️ **不可观测**（只能从「0 思考块」反推），照实登记 |
| 12 | ④ 备选开关 `CLAUDE_CODE_MODEL_CAPABILITIES` | ⏭️ **未真机验**（本设计不采用）；PEB 复核也确认该变量不在场 |
| 13 | 某档位未测（`low`/`medium`/`high`/`xhigh`/`max`） | ⏭️ 本 Task 只测 `off` 与「未选」两格，与 brief 写死的 4 行一致 |

---

## 二、操作路径

### 2.1 前置核对（先做，缺了这轮就是自证）

1. 我的 shell：`Get-ChildItem Env:CLAUDE_CODE_*` ⇒ **空**（连一条都没有）。
2. 持久化环境：`[Environment]::GetEnvironmentVariable(<名>,'User'|'Machine')` ⇒ **四条全空**。
3. **直接读 dev server 进程的环境块**（本轮新增的硬证据，见 §3.1）：`NtQueryInformationProcess` → PEB →
   `RTL_USER_PROCESS_PARAMETERS.Environment` → 逐字搜三个变量名。
   - 读 `PID 15536`（真正 spawn 智能体子进程的 `next-server`）与 `PID 8300`（`next dev`）。

### 2.2 真实评测（一次 run，4 行，串行）——**只跑了这一次，没有补跑**

1. `GET /api/cases` ⇒ `caseId = d899e825-8378-4a4e-aea3-f2dfec53ea0b`（用例「简单测试」，`repoPath D:\tmp\proj`）
2. `GET /api/runs/model-options` ⇒ claude-code@`deepseek-anthropic`(`66082791-…`)、codex@`deepseek-openai`(`baf094b1-…`)，模型都是 `deepseek-flash`
3. `POST /api/runs`，`executionMode: "serial"`、`useAgentJudge: false`，4 行：
   claude(off) / claude(**不写 `effort` 键**) / codex(off) / codex(**不写 `effort` 键**)
4. `POST /api/runs/{id}/start`，每 20s `GET /api/runs/{id}` 轮询到 `done`（08:36:51 → 08:42:42，约 6 分钟）
5. 逐行读 `D:\.tmp\aieval\runs\<runId>\rows\<rowId>`：claude 读 `messages.jsonl`，codex 读 `.agenthome\sessions\**\rollout-*.jsonl`

### 2.3 读数脚本（临时件，`%TEMP%\off-verify\`，不入 repo）

| 脚本 | 用途 |
|---|---|
| `count-thinking.mjs` | **brief 逐字原样**的 claude 计数（折叠口径） |
| `count-reasoning.mjs` | **brief 逐字原样**的 codex 计数——⚠️ **它跑不起来**（§3.6 缺陷 1） |
| `count-reasoning-fixed.mjs` | 上一份的可解析版（**逻辑逐字相同**，只改注释里的 `**/`） |
| `count-thinking-raw.mjs` | **敏感口径**：原始记录 + 同 `mergeKey` 取块类型**并集**（brief 口径会把思考块折没，§3.6 缺陷 2） |
| `analyze-reasoning.mjs` / `reasoning-tokens.mjs` | reasoning 条目的**正文长度**与**网关自述 token** |
| `dump-turn-context.mjs` / `read-proc-env.ps1` / `explore-*.mjs` | 读 `turn_context`、读进程环境块、结构探查 |

---

## 三、证据

### 3.1 前置核对的原始输出

**(a) 我的 shell（将要发起 run 的那一侧）**

```text
=== CLAUDE_CODE_EXTRA_BODY ===            (empty)
=== CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === (empty)
=== all CLAUDE_CODE_* ===                 (无任何条目)
[User]/[Machine] 两条变量均为 ''
```

**(b) dev server 进程的环境块（真正 spawn 智能体的那一侧）**

```text
################ PID 15536 (next-server) ################
TOTAL ENV ENTRIES: 4258
=== CLAUDE_CODE_* / ANTHROPIC_* / AIEVAL_* ===
  CLAUDE_AGENT_SDK_VERSION=0.3.281          <-- 说明读到的确实是真实内容，不是空壳
=== exact probe ===
  ABSENT : CLAUDE_CODE_EXTRA_BODY
  ABSENT : CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  ABSENT : CLAUDE_CODE_MODEL_CAPABILITIES
################ PID 8300 (next dev) ################
  (none)
  ABSENT : CLAUDE_CODE_EXTRA_BODY
  ABSENT : CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
```

**(c) T3 那条 WARN 的自证**：claude/`off` 行 `events.jsonl` 里 `DISABLE_EXPERIMENTAL_BETAS` **0 命中**
（注：该 WARN 走 `logger.warn` ⇒ 落在 **dev server 控制台**，不在行的 `events.jsonl` 里；
`events.jsonl` 的事件类型只有 `log/usage/status/score/end/vendor-system/diff-summary`，没有 warn 通道。
⇒ 这条前置的**判据是 (b) 的 PEB 直读**，比 grep 日志更强）。

### 3.2 逐行读数（`runId = 78ef5b58-3d6a-473c-9354-80539b8a6fd1`，`status=done`）

| # | rowId | agentKind | `effort` | 状态 | 轮次 | in / cached / out | 时长 | **A/B/C 那一格** |
|---|---|---|---|---|---|---|---|---|
| 1 | `53cb8de5-c675-410b-8c4a-8c193f8af2f6` | claude-code | `off` | judged | 11 | 33406 / 137600 / 4878 | 41.9s | **thinkingMain=0, thinkingSubagent=0** |
| 2 | `6322a846-5843-491d-838a-cbf7d8e9b240` | claude-code | *(缺键)* | judged | 6 | 32167 / 61696 / 7620 | 39.4s | thinkingMain=**1**, thinkingSubagent=0（敏感口径 3+3） |
| 3 | `f158f64e-1790-42c5-bdf3-42898ce9d6bc` | codex | `off` | judged | 12 | 21272 / 536192 / 19233 | 158.2s | **reasoningTotal=28**（主 15 + 子 13） |
| 4 | `8bcd6d7b-c43f-47a0-aac5-03e1bdc41122` | codex | *(缺键)* | judged | 8 | 10700 / 260608 / 8649 | 93.6s | reasoningTotal=**13**（主 11 + 子 2） |

四行 `attempts` 都是 1、`error` 都是空、`status=judged`。

**两套口径并列（claude 两行）**——只列 brief 口径会低估，故一并留档：

| 行 | brief 折叠口径（主/子） | 敏感口径：逻辑消息（主/子） | 敏感口径：原始记录（主/子） |
|---|---|---|---|
| claude / `off` | **0 / 0** | **0 / 0** | **0 / 0** |
| claude / 未选 | 1 / 0 | 3 / 3 | 4 / 3 |

⇒ 判据 A 的「0」在**三套口径下都是 0**（不依赖折叠假定）；对照行在**三套口径下都 > 0**。

### 3.3 判据 A / B / C 的逐条结论

| 判据 | 期望（brief 写死） | 实测 | 结论 |
|---|---|---|---|
| **A** claude/`off` | `thinkingMain === 0` 且 `thinkingSubagent === 0` | `0` 且 `0`（三套口径一致） | ✅ **绿** |
| **B** codex/`off` | `reasoningTotal === 0` | **28**（主 15 + 子 13） | ❌ **红** |
| **C** claude/未选 **与** codex/未选 | claude `thinkingMain > 0` 且 codex `reasoningTotal > 0` | claude `1`（敏感口径 3）／codex `13` | ✅ **绿** |

**A / B / C 合起来的读法**：C 绿 ⇒ 这一轮的**读数是有对照的、链路是通的**（同一套链路、同一模型、同一任务，
对照行确实采到了思考），所以 A 的「0」是**真 0**、B 的「28」是**真没关掉**。

**B 红的归因（按 brief Step 5 的固定顺序，没有跳到重跑）**：

1. **T2 那一格确实到了 CLI**——`off` 行两个 rollout 的 `turn_context` 都记
   `payload.effort = "none"`、`payload.summary = "none"`；而改动前的同款行（`effort=max`）记的是
   `"max"` / `"auto"`。⇒ **不是「键被改名 / 被忽略」**，也不是「没传到子线程」。
2. **网关侧照样产出推理**——`off` 行：28 条 reasoning、正文 **28,169 字**（主 7,429 + 子 20,740）、
   网关自述 `reasoning_output_tokens` **7,347**（主 1,747 + 子 5,600；rollout **末次** `total_token_usage`，与同行 usage 事件
   `tokens.reasoningOutput=7347` / `subagentTokens.reasoningOutput=5600` 一致 —— **最终值**，见 §一 第 4 行的注）。
   抽样逐字（截断）：`"The user wants me to create a hello world page using Vue 3 via CDN, then use a subagent to review it. …"`
3. ⇒ 按 brief 自己那条判读树：**「`summary` 消失了却仍有 reasoning ⇒ 网关侧的组合行为变了」**。
   T2 的设计前提（spec §2.3 引探针 stepF：请求体里 `summary` 消失 ⇒ `reasoning_tokens: 0`、rollout 0 条）
   **在真机评测链路上不成立**。
4. **一处必须点名的差异（未实测，只登记）**：stepF 是**单轮、无工具、无子智能体**的 CLI 直跑；本次是
   **12 轮、带工具、带子智能体**的智能体评测。最可能的解释是 stepF 的「0」**不外推到 agentic 长链路**，
   但这需要抓请求体才能定论（§4.2）。

**A 绿的归因**：claude/`off` 行 11 轮、4,878 输出 token、66 行 diff ⇒ 模型确实在干活；
但**一条 thinking 块都没有落盘**（连原始记录都没有），而它在同一轮里的对照行有 3 条 ⇒
T1 的 `CLAUDE_CODE_EXTRA_BODY` 覆盖层**真的把思考关掉了**（这正是上一轮读数 1+1 的那个缺陷被修好的证据）。

### 3.4 Step 6 的四条登记

| # | 项 | 本轮登记 |
|---|---|---|
| ① | claude 覆盖层是否对**子智能体**生效 | ✅ **本轮有读数**：`off` 行的子智能体思考块 **0**（对照行 3）⇒ **生效**。前作 §4.3 的「未覆盖」**可以销掉** |
| ② | codex **子线程**的 `summary` 取值 | ✅ **本轮有读数**：子线程 rollout 的 `turn_context.payload.summary = "none"`（对照 `"auto"`）⇒ 那一格**传到了子线程**。前作 §4.4 的「未覆盖」**可以销掉**（但注意：传到了 ≠ 生效，B 仍红） |
| ③ | claude 的 **hipaa 策略位** | ⏭️ 仍然**不可观测**：我们只能从「0 思考块」反推，没有独立读数 |
| ④ | 备选开关 `CLAUDE_CODE_MODEL_CAPABILITIES='<model>=-rejects_disabled_thinking'` | ⏭️ 仍然**未真机验**（本设计不采用）；PEB 复核确认该变量不在场 |

### 3.5 本轮发现的**两处 brief 缺陷**（后人重跑前必读）

**缺陷 1：`count-reasoning.mjs` 根本跑不起来（语法错误）。**
它的文件头 JSDoc 里写了路径 `.agenthome/sessions/**/rollout-*.jsonl`，
其中 `**/` 里的 `*/` **提前闭合了块注释**，剩下 `rollout-*.jsonl` 变成代码：

```text
file:///C:/Users/…/off-verify/count-reasoning.mjs:2
 * 递归数一个 codex 行的 `.agenthome/sessions/**/rollout-*.jsonl` 里的 reasoning 条目数，
                                                  ^
SyntaxError: Unexpected token '*'
```

⇒ 我另写 `count-reasoning-fixed.mjs`（**逻辑逐字相同**，只把注释里那段的 `*/` 拆开）。

**缺陷 2：`count-thinking.mjs` 的「折叠」会把思考块**抹掉**，对判据 A 是假绿、对判据 C 是假红。**
它按 `mergeKey` 取**最后一条**并假定「后到的 `blocks` 已是全量」。真机上这个假定**不成立**——
实测一条主线程消息的落盘序列是：

```text
*thinking  ==>  text  ==>  text,tool-call          （最后一条没有 thinking 块）
```

拿改动前那轮真机的 claude/`max` 行校准（`ec1edaad-75fc-438d-b42f-74dab50d6b57`）：

| 口径 | 主线程 | 子智能体 |
|---|---|---|
| brief 折叠口径 | **0** | **1** |
| 敏感口径（逻辑消息并集） | **4** | **4** |
| 敏感口径（原始记录） | 4 | 6 |

⇒ **同一行，brief 口径读成 0，敏感口径读成 4。** 若本轮对照行也落在「最后一条丢思考」那一支，
判据 C 就会**假红**、整轮被误判成「无法判读」。本轮两个口径都落了绿（对照行 brief 口径 1 > 0），
所以 A / B / C 的结论**不依赖口径选择**；但这个坑**必须留档**。
（附带的产品面观察：`foldMessages` 是 API/界面视图用的同一函数——我实测
`GET /api/runs/{id}/rows/{id}/messages` 返回的 14 条里也只有 1 条带思考块，
与折叠口径逐字一致 ⇒ 界面看到的思考块**比模型真实产出的少**。这**不在本 Task 改动面**，只登记。）

---

## 四、未覆盖项与后续

1. **codex 「关闭思考」在本机网关上仍然做不到**（判据 B 红）：T2 补的 `model_reasoning_summary:'none'`
   **确实到了 CLI 与子线程**，但网关照样推理。⇒ 需要一次**新裁定**：这是本线的**结论**，不是读数瑕疵。
2. **② codex 出网请求体未在评测链路里抓**：要往用户真实 `config.json` 临时加一个指向本地代理的 provider
   ⇒ 不动用户配置（与前作 §4.6 同一处置）。**「配置到 CLI」这一段有 `turn_context` 直证，
   「CLI 到出网请求体」这一段只有 stepF 的历史读数与单测兜住，本轮没有端到端请求体。**
3. **③ claude 的 hipaa 策略位不可观测**（同 §3.4）。
4. **④ `CLAUDE_CODE_MODEL_CAPABILITIES` 未真机验**（同 §3.4）。
5. **只测了 `off` 与「未选」两格**：其余档位（`low`/`medium`/`high`/`xhigh`/`max`/`ultra`/…）本轮无读数。
6. **dsh 没进这一轮的 4 行**：brief 只要求 claude / codex 各两行（dsh 的关闭档在
   `2026-10-06-effort-default-and-off-smoke.md` 里已有 0/0 的正面读数）。
7. **思考块被折叠抹掉**这件事的产品面影响（界面少显示思考块）本轮只登记、未定位根因、未修。
8. **claude 侧没有「注入确实发生」的直接产物**：`events.jsonl` 不记录 spawn 的 env，
   该行的证据是「行为读数（0）+ 同轮对照（3）+ 单测」；没有像 codex 那样的 `turn_context` 式直证。

---

## 附：本次冒烟的临时件（不入 repo）

| 路径 | 用途 |
|---|---|
| `%TEMP%\off-verify\read-proc-env.ps1` | 读 dev server 进程的 PEB 环境块（前置核对） |
| `%TEMP%\off-verify\poll-run.ps1` / `runid.txt` / `run-final.json` | 建 run／start／轮询／落最终读数 |
| `%TEMP%\off-verify\count-thinking.mjs`、`count-reasoning.mjs` | **brief 逐字原样**（后者跑不起来，留作缺陷证据） |
| `%TEMP%\off-verify\count-thinking-raw.mjs`、`count-reasoning-fixed.mjs` | 敏感口径 / 可解析版 |
| `%TEMP%\off-verify\analyze-reasoning.mjs`、`reasoning-tokens.mjs`、`dump-turn-context.mjs` | reasoning 正文与网关 token、`turn_context` |
| `%TEMP%\off-verify\explore-*.mjs`、`dump-messages.mjs`、`raw-scan-thinking.mjs`、`read-codex-logs.mjs` | 结构探查（含 codex `logs_2.sqlite` 只读查请求体——**空表，无留痕**） |
