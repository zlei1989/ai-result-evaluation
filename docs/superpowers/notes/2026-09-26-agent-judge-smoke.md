# 冒烟记录：智能体评分（2026-09-26 agent-judge，实测于 2026-09-27）

口径来源：`docs/superpowers/specs/2026-09-26-agent-judge-design.md`（§10 展示 / §12 错误处理 / §14 已知边界）。
本文件是 Task 8「展示、文档与全链收尾」Step 7/8 的关账记录：**四道门禁 + 真实浏览器冒烟**，
按 `AGENT.md` 的「冒烟测试」一节写四要素（①范围清单 ②操作路径 ③证据 ④未覆盖项）。

## ⓪ 隔离口径（先说三个不变量）

全程用**临时 `AIEVAL_CONFIG_DIR` + 本地假网关**，不碰真实 `~/.aieval`：

- 真实 `~/.aieval/config.json` 的 sha256 **冒烟前后相同**：
  `31D3BF671215C48950F5CF60AC4F53FBF06507A15AF4F81967A1A87057B0E175`（20637 字节，
  mtime 停在 `2026-09-27T00:01:04.1983916Z` 未动）；真实 `~/.runs` 也没有新增产物。
- 临时目录：配置 `%LOCALAPPDATA%\Temp\aieval-task8\cfg`、工作区根 `…\Temp\aieval-task8\runs`、
  假网关 `http://127.0.0.1:3099`（Anthropic 打 `/v1/messages`、OpenAI 打 `/chat/completions`，
  每个请求打一行 stdout 作为「界面动作真的打到评分通路」的 CLI 侧证据）。
- 服务 **`http://localhost:3084`**（换端口，不打扰 :3083 上已在跑的实例）。
  为什么是 `next start` 而不是第二个 `next dev`：:3083 是同一目录（`apps/web-next`）的 `next dev`，
  `.next/dev/lock` 在；第二个 dev 实例会与它共用 `.next/dev`。而 `next build` 的 clean 步骤
  **显式保留** `cache|dev|lock`（`next/dist/build/index.js:538` 的
  `recursiveDeleteSyncWithAsyncRetries(distDir, /^(cache|dev|lock)/)`），
  所以先跑门禁里的 `pnpm build`、再用它的产物 `next start -p 3084`：实测 `.next/dev/lock` 与 dev 各
  manifest 的 mtime 在我方 build 前后**未变**，:3083 的 PID（82808）与端口占用也全程未动。

## ① 范围清单

| # | 项 | 结果 | 证据位置 |
|---|----|------|----------|
| 1 | 默认评分模型为 **Anthropic 兼容**时，「默认评分智能体」下拉里 **Codex 禁用**、Claude Code 与 DSH 可选 | ✅ | ③-1 |
| 2 | 选 DSH → 临时 `config.json` 的 `settings.defaultJudgeAgent === "dsh"` | ✅ | ③-2 |
| 3 | 「使用智能体评分」`Switch` **默认关闭**；打开后提交 → `run.json` 的 `useAgentJudge === true` | ✅ | ③-3 |
| 4 | 清空默认评分智能体后重开创建表单、打开开关 → **内联 warning Alert** | ✅ | ③-4 |
| 5 | 已评分行点「重新评分」→ `Popconfirm` → 确定 → 行状态 **评分中** → `[重新评分]` 进日志且**旧 `score` 事件仍在** | ✅ | ③-5 |
| 6 | 按钮对齐用 `getBoundingClientRect()` 读，不靠眼睛 | ✅ | ③-6 |
| 7 | 附加：开关打开但没配评分智能体 → 创建时 **409 CONFLICT**，文案与 README 排障行逐字一致 | ✅ | ③-7 |
| 8 | 附加：**智能体评分通路真机跑通一轮**（真 claude CLI + 本行工作区 + `.judgehome`） | ✅（模型侧用本地假网关） | ③-8 |
| 9 | 附加：工作区污染 `WARN` 真的出现一次 | ❌ **未观察到**（本轮评审者没改工作区；只由单测覆盖） | ⑤-2 |
| 10 | 附加：评分智能体超时（`AGENT_TIMED_OUT`，「评分智能体超过…」）真机触发 | 跳过——本轮没制造超时（单测覆盖，见 ⑤-2） | — |

## ② 操作路径（点击/输入序列）

1. 浏览器打开 `http://localhost:3084/settings` → 点「评分配置」Tab。
2. 展开「默认评分智能体」下拉 → **读 DOM**：`Codex（与当前默认评分模型协议不匹配）` 是
   `ant-select-item-option-disabled` + `aria-disabled="true"`；Claude Code / DeepSeek Harness 可点。
   ——「默认评分模型」那一对（Anthropic 兼容供应商 + `smoke-judge-model`）是**冒烟预置**在临时
   `config.json` 里的，本步骤**没有**点选它；被验的是下拉的禁用态，而它是从**当时的实时 DOM** 读出来的。
3. 点「DeepSeek Harness」→ CLI 复核临时 `config.json`。
4. `/runs?panel=new` →（读 DOM）开关 `aria-checked="false"` → 点「使用智能体评分」→ 选用例
   「冒烟-智能体评分」→ 选模型 `smoke-judge-model` → 点「确定」→ CLI 复核新 `run.json`。
5. 回 `/settings` →「评分配置」→ 点「默认评分智能体」的 Clear（`button.ant-select-clear` 第 2 个）→ CLI 复核。
6. `/runs?panel=new` → 打开开关 → 读内联 Alert。
7. `/runs?panel=detail&id=44444444-…`（预置的「已评分」轮次）→ 点「重新评分」→ 读 `Popconfirm`
   → 点「确定」→ 立刻读行状态与网络面板 → CLI 复核 `events.jsonl`。
8. 追加（探针）：把预置轮次切到智能体通路（临时 `run.json` 的 `useAgentJudge=true`、`rowTimeoutMs` 收到 2 分钟）
   → 再点「重新评分」→ **确定** → CLI 复核事件日志与 `.judgehome`。
9. 追加：清空默认评分智能体后重开创建表单、开开关、填用例与模型、点「确定」→ 读提示与 409。

## ③ 证据（浏览器状态 ↔ CLI 落盘互证）

- **③-1** 下拉 DOM：`[{Claude Code, disabled:false}, {Codex（与当前默认评分模型协议不匹配）, disabled:true}, {DeepSeek Harness, disabled:false}]`
  ↔ CLI：默认评分模型 `defaultJudge = {providerId: 1111…, modelId: smoke-judge-model}`，
  该供应商 `protocolType = "anthropic"`（临时 `config.json` 里另一个供应商是 `openai`）。
- **③-2** 浏览器卡片显示「默认评分智能体：DeepSeek Harness」
  ↔ CLI `settings.defaultJudgeAgent` 是 JSON 字符串 **`"dsh"`**（临时 `config.json` mtime 随之前移）。
- **③-3** 浏览器首帧开关 `aria-checked="false"`（默认关）→ 打开 → 提交后跳到
  `…/runs?panel=detail&id=3240ab30-3690-4df6-9ec6-f2ef895121b3`
  ↔ CLI 该轮 `run.json`：`"useAgentJudge": true`（`status=idle`、1 行 `pending`）。
  附带：模型下拉只列 `smoke-judge-model`（Anthropic 供应商）——`smoke-openai-model` 被协议过滤掉。
- **③-4** 浏览器：`form .ant-alert` 出现 `warning` 类型，文案
  「设置页还没有配置默认评分智能体 / 这一轮会先去跑候选，到评分那一步才失败。请先到「设置 → 评分配置」选一个默认评分智能体。」
  ↔ CLI：`settings.defaultJudgeAgent = null`。
  （**这句正文是当时的版本、且与代码不符**：服务端在**创建时**就以 409 拒收，一轮都不会跑起来
  （③-7 就是那条 409 的实测）。终审 FIX-10 已把正文改成「这一轮会创建失败（服务端当场拒绝，不会跑候选）」，
  本次修复轮之后浏览器里读到的应是新文案。）
  （注意一个 SWR 现象：我用 CLI 改配置后**不刷新页面**时，运行页仍拿旧缓存 ⇒ 不提示；重新加载后提示出现。
  界面上用设置页改则立即一致——这是 SWR 的既有行为，不是本次改动引入的。）
- **③-5**（文本通路重评，预置行得分 60）
  - 浏览器：`Popconfirm` 文案「重新评分这一行？ / 只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。」
    → 确定后网络面板 `POST …/rows/…/rescore => 200`，行标签变 **评分中**、得分变 **未评分**（旧分先被清掉）。
  - CLI 同一行 `events.jsonl`（共 14 条，**追加**）：
    `seq=9 log [重新评分] 用户请求重新评分（模式：评分模型），本次不重跑候选智能体`、
    `seq=6 score totalScore=60`（**旧分仍在**）、`seq=12 score totalScore=100`、
    `seq=14 end exitReason=rescored`；`run.json` 行 `status=judged`、`score.totalScore=100`。
  - 假网关 stdout：`POST /v1/messages …`（证明评分真的走了一次文本调用）。
- **③-6** `getBoundingClientRect()`：查看日志 / 查看改动 / 评分详情 / 重新评分 四个按钮
  `y=223.4`、`h=21`、中心 `cy=233.9`（`sameRow=true, sameHeight=true`）⇒ 新增按钮与既有三个同排同高。
- **③-7** 提交后 `POST /api/runs => 409 Conflict`，页面 message 逐字为
  「这一轮启用了智能体评分，但没有配置默认评分智能体：请先到「设置 → 评分配置」里选择默认评分智能体，或新建评测时关闭「使用智能体评分」」
  ↔ CLI：临时工作区根下**没有**新增轮次目录（仍只有预置轮 + ③-3 那一轮）。
- **③-8**（智能体通路真机一轮：`useAgentJudge=true` + `defaultJudgeAgent=claude-code`，`rowTimeoutMs=120000`）
  - CLI 事件日志：`seq=15 [重新评分]（模式：评分智能体）` → `seq=18 [评分智能体]` 里是 claude CLI 的
    `system/init`（`"cwd": "…\rows\5555…\workspace"`、`"model":"smoke-judge-model"`、
    `"apiKeySource":"ANTHROPIC_API_KEY"`、`"claude_code_version":"2.1.281"`）→ `seq=19/21 [评分智能体]` 是模型答复正文
    → `seq=20/22 usage` → `seq=23 score`（**`judgeAgentKind=claude-code`**）→ `seq=24 judged` → `seq=25 end exitReason=rescored`。
  - 产物：行目录下多出 **`.judgehome`**（内含 `sessions/ projects/ .claude.json` 等 claude 自己的布局）。
  - 快照未被污染：`row.tokens` 仍是候选的 `{input:1000,cached:0,output:200}`、`turns=3`、`diff` 未变
    ⇒ 「评分智能体的用量不进快照」在真实一轮里成立（`usage` 只出现在事件日志里）。
  - 假网关 stdout：4 次 `POST /v1/messages?beta=true`（5556B / 5557B / 69569B / 69570B）。
  - 浏览器「评分详情」抽屉：「**评分智能体：Claude Code · 模型：smoke-judge-model** · 评分时间：2026-09-27 22:52」；
    日志抽屉里那一条是「`评分 总分 100 · Claude Code（智能体）· smoke-judge-model`」
    ⇒ Task 8 Step 1–5 的两处展示改动在真实智能体评分下都成立，且与文本通路那一条
    「`评分 总分 100 · smoke-judge-model`」分得开。
  - 污染对照的阴性面：`git status` 与摘要三计数在评分前后一致 ⇒ **没有** `[WARN]` 行（见 ⑤-1 的辨析）。
  - 「查看改动」抽屉现算：「共 2 个文件 · +3 −1」（`app.ts 2/1`、`new-file.ts 1/0`）
    ↔ CLI `git diff <baseline> --stat` 同为 2 文件 / 3 insertions / 1 deletion。

## ④ 四道门禁（Step 7 实测 + 修复轮复跑）

**两轮读数都记在这里**（同一台机器、同一份仓库）：① 冒烟当时的 Step 7 读数；② 评审修复轮
`34efdf8` 的复跑读数。修复轮只动文档与注释（该提交共 7 个文件：`README.md` + 本记录 +
五处陈旧注释所在的 5 个文件），没有一行可执行逻辑落在评分通路上 ⇒ 两轮读数的差异只反映
**环境噪声**（这台机器的 60s 超时成员逐轮更换），不是回归。

| 命令 | 冒烟 Step 7 | 修复轮 `34efdf8` 复跑 | 备注 |
|---|---|---|---|
| `pnpm typecheck` | **0** | **0** | `tsc -p tsconfig.typecheck.json`，无输出 |
| `pnpm lint` | **0** | **0** | `eslint . --cache …`，无输出 |
| `pnpm test` | **1** | **1** | 见下 |
| `pnpm build` | **0** | **0** | next build 成功，路由表含 `/api/runs/[runId]/rows/[rowId]/rescore` |

`pnpm test` 满载读数（两轮，总数同为 1416）：

- **冒烟 Step 7**：Test Files 11 failed | 102 passed (113)；Tests **22 failed | 1394 passed (1416)**。
- **修复轮 `34efdf8`**：Tests **17 failed | 1399 passed（总数 1416）**——该轮的实际读数，
  逐字见于它的提交信息（`git show -s --format=%B 34efdf8`）。

> **只有「当前总数」，没有「改前总数」**：Step 7 原本要记改前/改后两个数，但**改前的基线已不可得**——
> 本批开工时上一个任务（`89ce3ba`）已把用例数推上去，而历史任务没有留下逐轮总数。
> 也不采用「去 `89ce3ba` 上跑一遍」的办法：那需要 `git checkout <sha>`（本仓明令禁止），
> 或另建 worktree 再装一遍依赖（为一个数字不值当）。故这里如实只记当前值 **1416**。

**两轮的 `AssertionError` 计数都是 0**。冒烟那一轮的 22 条失败里 **21 条是 `Test timed out`**
（5s/20s/60s 三档），另 1 条是 `api/providers.test.ts` 的
`ServiceError: 配置保存失败…EPERM: rename …config.json.tmp -> config.json`
（AGENT.md 明写的已知成因②：杀软/索引器瞬时占用；内置重试也没过去）；
修复轮那一轮的 17 条是 15 条超时 + 3 条环境 IO/EPERM（同一类）。**没有一条断言失败。**

下面的逐文件隔离复跑是**冒烟那一轮**的读数（修复轮没有重跑隔离矩阵——它没有改可执行逻辑）：

| 文件 | 满载 | 隔离第 1 轮 | 隔离第 2 轮 |
|---|---|---|---|
| `core/src/git-exec.test.ts` | 1 timeout | ✅ 8/8 全过 | — |
| `core/src/git.diff.test.ts` | 2 timeouts | ✅ 22/22 全过 | — |
| `core/src/git.repo.test.ts` | 2 timeouts | ❌ 1 timeout / 33 | ❌ 1 timeout / 33（同一条） |
| `core/src/mirror.test.ts` | 4 timeouts | ❌ 2 timeouts / 46 | ❌ 3 timeouts / 46（2 条是新的，1 条与第 1 轮相同） |
| `core/src/workspace.test.ts` | 3 timeouts | ❌ 1 timeout / 15 | ❌ 1 timeout / 15（同一条） |
| `api/src/cases.test.ts` | 1 timeout | ✅ 60/60 全过 | — |
| `api/src/providers.test.ts` | 1 EPERM | ✅ 48/48 全过 | — |
| `evaluator/src/orchestrator.test.ts` | 5 timeouts | ❌ 4 timeouts / 65 | ❌ 5 timeouts / 65（**换掉了 3 条**，仍有 2 条与第 1 轮相同） |
| `ui/src/composite/run-create-panel.test.tsx` | 1 timeout | ✅ 22/22 全过 | — |
| `web-next/src/route-cases.test.ts` | 1 timeout | ✅ 20/20 全过 | — |
| `web-next/src/route-run-artifacts.test.ts` | 1 timeout | ✅ 9/9 全过 | — |

7/11 个红文件隔离后**全绿**；剩下 4 个的失败**成员逐轮更换**——`orchestrator.test.ts` 的隔离第 1 轮与第 2 轮
只有 2 条重合（「串行下每行都有独立工作目录」「对已结束的行调用 abortRow → CONFLICT」），第 2 轮另有 3 条是新的，
且两轮与**满载**那一轮的 5 条几乎不重合（满载里的「没有在跑的行时 abortRun → CONFLICT」在隔离时是绿的）；
`mirror.test.ts` 第 2 轮的 3 条里 2 条是新的、1 条与第 1 轮相同
⇒ 与「同一份字节、超时成员随机」的既有环境噪声描述一致，
**不是断言失败、也不是本批改动引入**。
（原文这里写「本批只改了 `README.md`」——那是**冒烟当时**的事实，而修复轮 `34efdf8` 又动了
6 个文件（本记录、`case-form-panel.tsx`、`judge-settings-card.tsx`、`judge-settings-card.test.tsx`、
`providers.ts`、`judge.ts`），其中 5 个只落在注释与一处 `it()` 标题字符串上；该提交用
「`git diff -U0` 逐行 + 去注释转译后比对」证明可执行代码零差异。故这一句改为：**失败与改动无关**，
两轮的 `AssertionError` 都是 0。）
两轮都稳定超时的那两条（`git.repo` 的「ensureCaseCache 首次调用真的克隆出带 .git 的完整仓库」、
`workspace` 的「prepareRowWorkspace 重跑同一行：清掉旧工作区」）都在 20s 预算里做真实 `git clone`/复制，
是这台机器上的性能天花板，建议后续单独给它们抬预算或标注为慢用例（见 ⑤ 末条）。

## ⑤ 已知边界与未覆盖项

1. **评分智能体可以改动工作区，`WARN` 是唯一信号**——而那条 `WARN` 只比对
   「文件数 / 增删行数」三个计数（`diffSummaryOf`），所以**计数不变的改动不会触发它**。
   计数不变的只有两类，别把别的也算进来：① **只改暂存状态**（`git add` / `git restore --staged`：
   三个计数取自工作区相对基线的 `git diff`，暂存与否不改变它们。注意这一类**只**指暂存状态：
   **索引级别的模式变更**（`git update-index --chmod=+x`）与 `--intent-to-add` **会**改变计数，
   不属于这一类——后者见本段末尾的实测）；
   ② **改动落在被忽略的文件上**（被忽略的文件从不进 `git status --porcelain`，`git add --intent-to-add --all`
   也不会带上它们）。**「改文件权限」不是这一类**（评审实测）：POSIX 上 git 跟踪可执行位，
   `git diff --stat HEAD` 会报 `1 file changed, 0 insertions(+), 0 deletions(-)` ⇒ `filesChanged` 变了、
   WARN **会**响。**Windows 上同样会响**（终审 FIX-8 纠正：两位评审判别实测过
   `git update-index --chmod=+x` 之后 `git diff --stat HEAD` 仍报 `1 file changed, 0 insertions(+), 0 deletions(-)`）
   ——Windows 上被忽略的是**文件系统层面**的权限变化（`core.fileMode` 为 false 时纯权限位变化不进 diff），
   与**索引层面**的 `--chmod` 是两件事。故这条反例整体不成立，不能拿「权限」当「计数不变」的例子。
   本轮实测到一个**容易误读**的现象作为佐证：评分后
   `git status --porcelain` 里 `?? new-file.ts` 变成了 ` A new-file.ts`（intent-to-add 登记）——
   查代码后确认这是**我们自己**的 `collectDiff` 干的（`git.ts` 的 `git add --intent-to-add --all`，
   为了让未跟踪文件的正文进 diff），**不是**评审者改的。结论：这条 WARN 是「改动计数变了」的信号，
   不等于「工作区一定没被动过」；「查看改动」抽屉按需现算（实测与 CLI `git diff <baseline>` 一致），
   它显示的是**当前**状态。README 的排障行已把这条限制写明（「它只比对文件数与增删行数三个计数」）。
2. **未观察到 `WARN` 与评分智能体超时**：本轮 claude CLI 既没改工作区、也没超时，故
   `[WARN] 评分智能体执行期间工作区被改动` 与 `AGENT_TIMED_OUT`（「评分智能体超过 … 毫秒未返回，已强制释放」）
   只有单测面（`orchestrator.test.ts`）。真机触发需要一个会写工作区 / 会挂住的评审者。
3. **codex 的 `agent_message` item 形状从未被探测确认**：`probe/dumps/codex.json` 那次网络不通，
   只有 `item.type === 'error'`；`finalText` 对 codex 的采集点**只有类型面**支撑，没有任何一次真机回读。
   拿不到时表现为 `JUDGE_PARSE_FAILED`「评分智能体没有给出可读的最终答复（该适配器未回传最终消息）」。
4. **评分智能体的用量不进快照**：本轮实测 `row.tokens` 保持候选的值不变，`usage` 事件只在
   `events.jsonl` 里（`seq=20/22`）。界面上看不到「这次评分花了多少 token」，要看日志抽屉。
5. **`rowTimeoutMs` 现在同时约束两段、且两条评分通路都有界**：候选 agent 一段、评分阶段再一段。
   评分那一段的**外层兜底 + 硬停**（`orchestrator.ts` 的 `judgeBounded`）是**两条通路共用**的，
   上限为 `rowTimeoutMs + max(1000, rowTimeoutMs×10%) + 2000`，文本通路另有 `fetch` 的 `AbortSignal`。
   开智能体评分的轮次要相应调大，README 的「分数怎么来的」已写清。
   **`durationMs`（界面上的「耗时」）只算候选 agent 那一段**（终审 ADD-4，选定「写明口径」而不是改语义）：
   开智能体评分时评分自己也要跑一次 CLI（分钟级），那一截**不在**这个数里；重新评分也不改它。
   口径与两条理由写在 `runRowAttempt` 第 5 步的注释与 `EvalRowSchema.durationMs` 的注释里。
6. **文本 API 评分通路的上界（终审 FIX-1 已修，这一条从「已知缺口」改成「口径说明」）**：
   修复前 `judgeRow` 的入参里没有 signal、`callTextApi` 的 `fetch` 也没有自己的超时，这一条路唯一的
   边界来自 HTTP 客户端默认行为。实测（Node v24.17.0 的 undici）：**不响应**的服务器会被默认超时兜住
   ——never-headers 抛 `UND_ERR_HEADERS_TIMEOUT` 约 306,848 ms、headers-then-no-body 抛
   `UND_ERR_BODY_TIMEOUT` 约 306,818 ms；但**滴流响应**（头已到、正文一直来一点点）会不断重置
   `bodyTimeout`，那一条**真无界**。现在：`input.signal` 原样交给 `fetch`（**读正文那一步也在它管辖内**，
   滴流正是在那一步无界），外层另有兜底超时 + 硬停，于是「终止」真的能切断这次调用
   （旧注释里「按终止只同步落 canceled、调用继续跑到返回为止」已不成立）。
   落 `canceled`（用户终止）/ `timed-out` + `AGENT_TIMED_OUT`（我们自己超时，文案点名「评分模型（文本 API）」），
   与评分智能体那一段同一套终态映射（`settleAgentJudgeStop`）。**这两条只有单测覆盖**（见第 8 条）。
7. **重新评分沿用本轮模式**：一轮里只有一把尺子，行不能换通路重评；「新建一轮时忘了开开关、
   跑完才发现 diff 太大」的补救路径仍然只有新建一轮。且**重评会先清空该行快照里的旧分数**
   （实测：确定后行立刻显示「评分中 / 未评分」）——重评失败就丢掉上一次的分，历史只留在事件日志的
   `score` 事件里。
8. **未覆盖的路径（测试面）**：① 评分阶段的**外层兜底**（`backstop` / `hardDeadline` 那两条
   `AGENT_TIMED_OUT` 改写）没有真机触发——**两条通路都没有**（终审 FIX-1 补上文本通路之后，
   它同样只有单测：`orchestrator.test.ts` 的「文本评分调用永不返回 → timed-out」与
   「文本评分在飞时用户终止 → canceled、恰好一条 end」）；② 污染对照的**阳性面**（计数真的变了 → WARN）只有单测；
   ③ 重评的并发拒绝（`rescoreRefusal` 的 `settling` 分支、「正在运行中」分支）只有单测；
   ④ 创建时**协议不匹配**那条 `CONFLICT` 没有真机触发（本轮只触发了「未配置」那条 409）；
   ⑤ 评分智能体进程起不来 / 鉴权失败 / 限流（`AGENT_FAILED` / `AUTH_FAILED` / `RATE_LIMITED`）未真机触发；
   ⑥ **滴流响应**（不断重置 `bodyTimeout` 的那一种）没有真机触发——它的守卫也是单测
   （假 judgeRow 连 signal 都不看，比滴流更恶劣），真机复现需要一个会持续吐字节的服务器。
9. **未覆盖的环境前提**：本轮的「真机一轮」用的是**本地假网关**（模型答复是假网关给的固定 JSON），
   所以覆盖到的是「编排 + 真 CLI 子进程 + 工作区 + `.judgehome` + 事件落盘 + 展示」这整条链路，
   **不是**「真实上游供应商」；`dsh` 这个 CLI 本机 **不在 PATH**（`Get-Command dsh` 找不到），
   `codex` 未尝试。真机跑通「claude-code / codex / dsh 三家各自作为评分智能体 + 真实网关」仍需
   一台有三家 CLI 且能连到网关的机器。
10. **慢用例建议**：`git.repo.test.ts` 的 `ensureCaseCache` 与 `workspace.test.ts` 的
    「prepareRowWorkspace 重跑同一行」在隔离复跑里两轮都撞 20s 预算（无断言失败），
    建议后续单独抬这两条的 timeout 或标注 `slow`，以免每次全量都被算进红灯。

## ⑥ 本次冒烟顺带验证到的两条展示改动（Task 8 Step 1–5，提交 `a20a1cf`）

- 评分详情那一行：智能体评分时是「评分智能体：Claude Code · 模型：smoke-judge-model」，
  文本通路那一条仍是「评分模型：smoke-judge-model」（同一条日志抽屉里两条 `评分` 事件都看得到）。
- 日志行：智能体通路是「`评分 总分 100 · Claude Code（智能体）· smoke-judge-model`」，
  文本通路是「`评分 总分 100 · smoke-judge-model`」。
- 行卡片**没有**「智能体评分」Tag（§10 的口径：开关是轮级的，行上再标一遍没有新信息）——实测未见该 Tag。
