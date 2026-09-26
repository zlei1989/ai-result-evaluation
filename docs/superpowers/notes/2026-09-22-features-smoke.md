# 功能阶段冒烟记录与关账（p6）

> 上位文档：`docs/superpowers/specs/2026-09-22-features-design.md`（下称「设计文档」）；
> 契约与计划集：`docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`（下称「接口契约」）。
> 计划：`docs/superpowers/plans/2026-09-22-features-p6-smoke.md`（Task 1–10）。
> 执行：2026-09-26 02:07–03:24（本机 `Asia/Shanghai`），分两批（Task 1–2 / Task 3–8；Task 9–10 为第三批）。
> 分支：`feat/features`。**开工基线 `445c4f0`**；本阶段入库提交 3 枚：
> `9820457`（R31：应用级 antd locale）、`5d3358c`（README 使用手册）、Task 10 的关账提交（本文件 + 计划回填）。
> **只记实测值**：每条判定都能指向证据文件、HTTP 原文、磁盘文件或 CLI 输出；
> 读不出实测值的写「未执行 + 原因 + 证据路径」，**不写**「看起来正常」。

## 0. 运行环境与隔离（照脚手架冒烟记录的写法）

| 项 | 实测值 |
|---|---|
| 分支 / 起始提交 | `feat/features` @ `445c4f007c6e560d2cb6ac7752783333eb220631` |
| Node / pnpm / git | Node **v24.17.0** / pnpm **11.18.0** / `git version 2.47.0.windows.2` |
| Next / React / antd | Next **16.2.7**（Turbopack，dev）/ React 19.2.7 / antd **6.6.5** |
| 浏览器视口 | MCP Playwright（Edge），视口 **1440×900**（本阶段未做 `setViewportSize` 变更；所有几何读数都在该视口下取得） |
| 地址 | **`http://localhost:3083`**（按文档约定用 `localhost`，不用 `127.0.0.1`——Next 16 dev 的资源跨源拦截） |
| 沙箱 `$smokeRoot` | `C:\Users\ZHANGL~1\AppData\Local\Temp\aieval-p6-smoke-20260926-0207`（**不入库**；开工 22 份证据 → 批 2 收工 65 份 → Task 9/10 后 **72 份**） |
| 隔离配置 | `$smokeRoot\aieval-config\config.json`（每次落盘都显式带 `AIEVAL_CONFIG_DIR`）；本会话**唯一**被写的配置 |
| 真实 `~/.aieval\config.json` | SHA256 四个时点全同 `750BBF152C0EDDA0651284085E96F6176531B54D19492A135C1A4BCB195F191D`；`Length 219`、`LastWriteTime 2026/9/24 17:39:36`、文件数 1；`~/.runs` 存在性 `False → False` |
| CLI | `claude` 2.1.281 ✓ / `codex` 0.154.0（PATH）与 SDK 自带 `@openai/codex 0.156.1` ✓ / `dsh` **不在 PATH**（SDK 自带 0.1.7-rc.1） |
| 唯一可达网关 | `cc-switch` 本地中继 `http://127.0.0.1:15721`，**只讲 Anthropic Messages**（`/v1/responses`、`/v1/chat/completions` 实测 503 空体） |

**隔离是怎么被证成的**：计划 Step 10 指定的 `[System.Diagnostics.Process]::GetProcessById(...).StartInfo.EnvironmentVariables`
对**外部进程**读数不可信（实测报 81 项且不含 `AIEVAL_CONFIG_DIR`，而同进程内自读 83 项且含、启动器起的 node 子进程也读到该值）。
故改用更强的**哨兵回环**：把沙箱配置的 `workspaceRoot` 写成只可能来自沙箱的哨兵路径，
再让服务自己回答 `GET /api/settings` ⇒ 回该哨兵值 ⇒ 服务读的是沙箱配置。
证据：`evidence/service-isolation-sentinel.txt`、`evidence/service-launcher-env.txt`、`evidence/service-launcher-env-restart.txt`。
（Task 3 之后哨兵被真实沙箱 workspace 取代，这是计划要求的动作；判定改为「真实配置哈希四个时点不变」。）

---

## 1. 范围清单（设计文档 §9 的 9 项 + §5.6.7 的 3 项 + p1 交接 2 项）

| 项 | 判定 | 关键实测值 | 证据文件与行号 |
|---|---|---|---|
| §9-1 两个供应商（openai 拉模型 / anthropic 手工模型） | **❌（降级：环境缺口）** | 只建成 1 个供应商 `冒烟-Anthropic`（`protocolType=anthropic`，2 条 `manual` 模型）；openai 协议整条不可达 ⇒ 拉模型与「合并而非覆盖」断言**无靶子** | `evidence/02-providers.md` §0/§2/§7 判定 1–2、§7 判定 4；`evidence/probe.txt` §1；`evidence/models.json` |
| §9-2 建用例（AI 生成评分提示词、仓库与 commit 校验） | **✅** | 提示词回填 **1822** 字符（1 次真实文本调用）；`commitHash` 40 位 == `git rev-parse`；5 维 key 缺失 **0**；两个负例（非 git 仓库 / 40 个 0）都给出含原因的中文错误且不放行保存 | `evidence/03-case.md` §1–§5.3（判定表在 §5.2）；`evidence/gen-judge-prompt.txt` |
| §9-3 建并行评测 2 行（协议过滤） | **✅（行构成降级）** | `mode=parallel rows=2`；用例 Select = `冒烟-最小示例 · repo · efc5a0a`；默认「并行」；claude-code 池只有 anthropic 两条；Codex 空池 `Alert` rect **292×50** | `evidence/04-runA.md` §0/§1 |
| §9-4 两行同时 running + 计量实时跳动 | **❌（前半 ✅，后半不成立）** | 四次采样（02:50:41.759/45.162/48.278/51.388）两行都 `running` ✅；但 `durationMs`/`tokens` 在跑动期间**恒为 `null`**，行结束才一次性跳到位 ⇒ 「实时跳动」**不存在**（见 A5） | `evidence/04-runA.md` §2 判定 4.1/4.2；`evidence/runA-poll.jsonl` |
| §9-5 CLI 复核分支与 diff（与页面一致） | **⚠️ 部分通过（claude-code 侧 ❌）** | branch 两行都 == `test/{rowId}` ✅、两行 workspace 互不相同 ✅；但 claude-code 的 **7 行 `porcelain` 全 0 改动** ❌（CLI 写权限门，见 A1）；**页面 == CLI 的等式成立但为退化值 0/0/0**。**非零互证由 dsh 行给出**：` M math.js`、numstat `4 0`、`run.json` `filesChanged=1 insertions=4`、事件 `diff-summary`、界面「共 1 个文件 · +4 −0」四处**非零相等** | `evidence/04-runA.md` §3；`evidence/06-adapters.md` 第 2 项；`evidence/cwd-changes.txt`；`evidence/05-runB.md` §5 |
| §9-6 出分核对（总分算式与 5 维） | **✅** | 两行 5 维各 1 分 → 期望 `round(5/25×100)=20`、实际 **20**（两行都成立）；维度 key 顺序 == `score.ts` 的 `DIMENSIONS`；两行同分 ⇒ 都是「第 1 名」（并列不硬拆）；`run.status=done`；吸底「开始」`disabled=true` + Tooltip「没有可执行的行（全部已评分）」 | `evidence/04-runA.md` §4 |
| §9-7 串行 3 行中途终止（canceled / skipped） | **✅（载体由 Run B 改为 Run C）** | 任意采样 `running ≤ 1` ✅；行 2 在行 1 出分后才起 ✅；终止后 row2 `canceled` + `end.exitReason=canceled`（终止发生在首个 agent 事件之后：seq 3 @19:09:19.935）；row3 `skipped` **只有 2 条事件**（无 agent 日志/usage）；5 个 agent PID 全消失 | `evidence/05-runB.md` §2/§3；`evidence/06-adapters.md` 第 3 项 |
| §9-8 再开始只跑未完成行（已 judged 不重跑） | **✅** | 确认框**只列 2 行**（`· Claude Code · claude-opus-4-8` / `· DeepSeek Harness · claude-haiku-4-5`），**不含**已 judged 的 row1；重启后 row1 仍 `judged` 且 `judgedAt`（`2026-09-25T19:09:16.290Z`）逐字符不变 | `evidence/05-runB.md` §4.2 |
| §9-9 坏评分模型 → 该行 failed、其余行不受影响 | **✅ 逻辑成立 / ❌ 文案口径** | 两行都 `failed` + `error.code=INTERNAL`、`run.status=partial`、两行 `diff`/`durationMs` 非 null（失败只落在评分阶段）；**R13 的替代路径在本环境还要再降一级**（改用指向死端口的供应商，见 §7.B 的 B-R13）；文案 = `调用文本 API 失败（127.0.0.1:15999）：fetch failed` ⇒ **含英文原文 `fetch failed` 且不含模型名** | `evidence/05-runB.md` §4.1/§4.3 |
| §5.6.7-1 宿主环境变量跑完后未变 | **⚠️ 部分成立** | 81 vs 81 行，差异 **2 行**（都是 `DSH_SESSION_ID`，DSH 自身会话 id）；7 个注入变量**全部 `[absent]`**；两个快照来自不同 dev 进程（74528 → 72176）。**更强的替代证据**：`process.env` 不变这条守卫经**变异验证**有区分力（0 → 1 failed → 逐字节还原 → 0） | `evidence/06-adapters.md` 第 1 项；`evidence/host-env-{before,after}.txt`；`evidence/step7-guard-{before,mutated,restored}.txt` |
| §5.6.7-2 工作目录里确实产生了文件改动（逐 agent + 负控） | **❌（claude-code）/ ✅（dsh）/ 负控未执行** | 3 个 run、8 行逐行量：claude-code **7 行全 0**；**dsh 行 ` M math.js`、+4/−0** ✅；负控（备好但没跑的行）**不可得**——Run C 的 skipped 行后来真跑了。替代区分力证据：同一夹具下 7 行 0 改动 vs 1 行 1 改动 | `evidence/06-adapters.md` 第 2 项；`evidence/cwd-changes.txt`；`evidence/cwd-row-workspaces.txt` |
| §5.6.7-3 三种终止语义 + 子进程确实消失 | **⚠️ 1 家完整 / 1 家只有文案 / 1 家不可达** | claude-code ✅（中间终止 → `canceled` + 子进程消失 + 文案「终止」）；dsh **只拿到文案「关闭运行时」**、未真被终止；codex **连行都建不出来**；闭包差集 **3**（≥3）✅、终止后 5 个 PID（5016/23896/66224/75784/78336）全部消失 ✅；**Run D 整体未执行**（见 A8） | `evidence/06-adapters.md` 第 3 项；`evidence/07-cleanup.md` Step 2 |
| p1 交接-工作区校验（沙箱 root 落定 + 不可写负控 + 落盘未变） | **✅** | 正例：绿 Alert「工作区可用：…」+ 盘上一致；负控：`NOT_WRITABLE` + 含失败路径的中文原因 + **输入保留** + **盘上值未变**；收尾恢复绿 | `evidence/02-providers.md` §5 |
| p1 交接-接口与界面正控（两汉字按钮不插空格、anthropic 拉取 400、响应只有 `apiKeyMasked`） | **✅ / 一项正控不可得** | 插空格命中 **0**；`POST …/models/fetch` → **400** +「Anthropic 兼容协议没有 /models 接口」；HTTP 出口键名只有 `apiKeyMasked`、带明文 `apiKey` 键的条数 **0**、明文不出现在响应里。**「app 级正控」不可得**：空态引导按钮文案长度都是 4（无 `len == 2` 的 app 级按钮）⇒ 只证明了「没有被插空格的按钮」 | `evidence/02-providers.md` §4/§6；`evidence/fetch-anth.body`；`evidence/providers-list.body` |

**小结**：**✅ 完全通过 5 项**（§9-2、§9-3、§9-6、§9-7、§9-8）+ **p1 交接 2 项**（其中一项含一处不可得的正控）；
**⚠️ 部分通过 4 项**（§9-5、§5.6.7-1、§5.6.7-3、p1 交接正控那一半）；
**❌ 3 项**（§9-1 降级、§9-4 后半、§5.6.7-2 的 claude-code 侧）；
**未执行的构成部分**：openai 拉模型与合并断言、**Run D 整体**、codex 的一切真跑、dsh 的真实终止、§5.6.7-2 的负控。

**§9-1 的判定口径收窄（控制方裁决，本节照此写）**：

> **本次端到端只覆盖 anthropic 协议路径；openai / codex 路径在本环境只有类型面与单测面证据。**

---

## 2. 服务与进程

| 项 | 实测 |
|---|---|
| 启动命令 | `powershell -NoProfile -ExecutionPolicy Bypass -File %TEMP%\p6-dev-launch.ps1 -SmokeRoot <smokeRoot>`（脚本内显式 `$env:AIEVAL_CONFIG_DIR = <smokeRoot>\aieval-config` 并先落盘自证） |
| 批 1 服务 | job **`pwsh-597`** / 监听 pid **74528**（`node.exe`）——**批 2 开工时已不存在**（job 列表为空、3083 无监听、pid 不存在） |
| 批 2 重启 | 按 Task 1 Step 9 同口径重启：`%TEMP%\p6-dev-launch2.ps1`（**只设 `AIEVAL_CONFIG_DIR`、不改写 config.json**，避免冲掉已建好的供应商/用例）⇒ job **`pwsh-599`** / pid **72176**（`node.exe`，Started 2026/9/26 02:36:55） |
| 就绪日志三行原文 | `▲ Next.js 16.2.7 (Turbopack)` / `- Local:         http://localhost:3083` / `✓ Ready in 1117ms`（批 1 是 `1069ms`）；紧随一条 `[INFO] [instrumentation] 服务启动：已完成被中断候选行的恢复 { recovered: 0 }` |
| 路由实测 | `/settings` 200、`/api/runs` 200、`/api/providers` 200、`/api/settings` 200、`/api/cases` 200 |
| 收尾动作 | **在普通（非受管 job）pwsh 调用里按 pid 停**：`Stop-Process -Id 72176 -Force` @ **2026-09-26 03:14:56**；随后 job `pwsh-599` **自行结束、exit code 0**（未复现批 1 的 `4294967295`）。`job_kill` **未使用**——按派发稿口径，它的返回本身**不算**收尾 |
| 收尾三条判据 | ① 3083 无 LISTEN：`Get-NetTCPConnection -State Listen` → **0 条** ✅；② dev 进程传递闭包：pid 72176 存在 = False、闭包 = **0** ✅；③ 运行期记录过的 **5 个 agent PID 全部 False** ✅（5016 conhost / 23896 node / 66224 conhost / 75784 claude / 78336 claude）。TIME_WAIT 29 条按计划口径**不算监听** |
| 真实配置前后四项对比 | SHA256 `750BBF15…F191D` → **逐字符相同**；`Length 219 → 219`；`LastWriteTime /Date(1790242776990)/`（= 2026/9/24 17:39:36）→ **相同**；文件数 `1 → 1`；`~/.runs` `False → False` |
| 沙箱内被写的配置 | `$smokeRoot\aieval-config\config.json`（唯一）：1 个供应商 + 1 条用例 + `defaultJudge` + `workspaceRoot` |
| 残留探针 | `$env:USERPROFILE` 与仓库下的 `.aieval-probe-*` 均为 **0** ✅；仓库 `git status --porcelain` 只有别人那一行未跟踪文件 ✅ |

证据：`evidence/service.json`、`evidence/service-batch2.json`、`evidence/dev-pid.txt`、`evidence/dev-pid-batch2.txt`、
`evidence/service-launcher-env*.txt`、`evidence/service-isolation-sentinel.txt`、`evidence/07-cleanup.md`、
`evidence/proc-*.json`、`evidence/real-config-before.*`。

> **一条写给后续的实测坑**：`Stop-Process -Force` 在**受管后台任务内部**执行时，harness 的 Windows Job runner 会返回
> `subprocess-local: Windows Job runner exited with exit code 4294967295 before proving its managed range empty`，命令输出丢失。
> 有效做法是「在普通 pwsh 调用里按 pid 逐个 `Stop-Process`，然后**另起一次调用**核验端口与残留」；
> 且**不要**去杀 harness 祖先链（`node --import tsx … web --port=3088`），那会打断 DSH 自身的 job runner。

---

## 3. 操作路径与证据（12 项逐项）

每一项的「操作路径」是**真的点到过**的编号序列；几何与数值一律是实测值（`getBoundingClientRect()` /
`config.json` / `run.json` / `events.jsonl` / `git` / `Get-NetTCPConnection`）。

### §9-1 两个供应商（openai 拉模型 / anthropic 手工模型）

- 操作路径：`/settings` → Tab「模型供应商」→「添加供应商」→ 填 名称 `冒烟-Anthropic` / 协议「Anthropic 兼容」/ `http://127.0.0.1:15721` / 密钥 `PROXY_MANAGED` →「保存」→ 表格行点「编辑」→ 读「拉取模型」按钮 →（新建态无模型区）→「添加」两条模型。
- 证据：表格六列 `名称 | 协议类型 | API 地址 | 密钥掩码 | 模型数 | 操作`，实测行 = `冒烟-Anthropic | Anthropic 兼容 | http://127.0.0.1:15721 | PRO******AGED | 2 | 编辑 删除`；盘上 `apiKey` 明文（服务端要原 token）、HTTP 出口只有 `apiKeyMasked`；编辑态 `fetchButton.disabled = true`、rect **72×24**、可见提示含 `/models`（**无 Tooltip 节点**——`tooltipNodes: []`、`title` 属性 `null`）。
- **判定：❌（降级，环境缺口）**。`providers.Count = 1`、协议集合 `{anthropic}`；Step 2–5（openai 供应商 + 拉模型 + 合并断言）**整体未执行**——归因**环境坏**（上游网关的 openai 面不可达），**不是实现坏**（同一中继的 anthropic 面实测 2xx；anthropic 协议的 `/models` 拒绝是**设计**，服务端 400 原文在位）。

### §9-2 建用例（AI 生成评分提示词、仓库与 commit 校验）

- 操作路径：`/settings` → Tab「评分配置」→ 默认评分模型选 `claude-haiku-4-5` →「保存」→ `/cases` →「创建用例」→ 依次填 标题 / 考题提示词 / 代码仓库 →「校验」→「重新加载候选」→ 选/手工填 commit →「AI 生成」→「创建」。
- 证据：右栏（非弹窗）表单六字段 label = `标题 / 考题提示词 / 评分提示词 / 代码仓库 / commit hash / 默认评分模型`；「校验」回显 `仓库：repo · 当前分支：main`（与 CLI 逐字相同）；候选下拉恰好 2 条、与 `git log --format='%h%x09%s' -n 20` 逐字一致；手工输入 40 位 hash 未被截断（`length = 40`）；「AI 生成」返回 200 且 TextArea `value.length = 1822`；落盘 `cases=1`、`commitHash` 40 位 == `git rev-parse`、5 维 key 缺失 **0**。
- 两个负例：非 git 仓库 →「不是 git 仓库：…（fatal: not a git repository …）」+ `400`；40 个 0 → `INVALID_REF` + `400`，URL 仍 `?panel=new`（未放行保存）。
- **判定：✅**（一处**断言作废**已如实登记：设计文档口径的「真源 12 字抽查」取到的是 `score.ts` **文件头注释**，该断言**恒为 False**，与实现无关——见 A11②；已换等价断言「契约正文 5 段字面量」，全 True）。

### §9-3 建并行评测 2 行（协议过滤）

- 操作路径：`/runs` →「创建评测」→ 选用例 → 确认执行模式（默认「并行」）→ 添加 2 行候选（智能体 + 模型）→（把一行临时切成 Codex 看空池告警，再切回）→「创建」。
- 证据：URL = `/runs?panel=new`；表单 label = `用例 / 执行模式 / 并行 / 串行 / 智能体 / 模型`；用例 Select 选项文本 = `冒烟-最小示例 · repo · efc5a0a`；`并行 checked=true / 串行 checked=false`；`GET /api/runs/model-options` 实测 claude-code 与 dsh 的 `protocolType='anthropic'`、codex 为 `'openai'` 且 `options=[]`；切 Codex 时行内 `Alert` rect **292×50**、切回后告警数 **1 → 0**。
- **判定：✅（行构成降级）**。计划的第 2 行本应 `codex + openai 模型`，本环境 codex 的模型池为空**且模型是必填**⇒该行**建不出来**；两行改用 claude-code 的两条 anthropic 模型，保住「两行同时跑、并排、排名、总分降序」这些断言。

### §9-4 两行同时 running + 计量实时跳动

- 操作路径：吸底「开始」→ 读确认框原文 →「开始」→ 每 3 秒采样一次卡片与 `run.json` → 等两行出分。
- 证据：确认框原文 `开始执行这一轮评测？ 执行模式：并行（全部同时开跑） 本次将执行 2 个候选：` + 两行 `· Claude Code · <模型>`；四次采样（`02:50:41.759 / 45.162 / 48.278 / 51.388`）两行都 `running`（≥10 秒窗口）；跑动期间卡片 = `tok 未采集 轮次 未采集 耗时 未采集 得分 未评分`（**不出现 0**）；行结束时 `durationMs` 一次性跳到 `26465` / `833361`。
- **判定：❌（前半 ✅ / 后半不成立）**。`durationMs`/`tokens` 在行结束前**恒为 `null`**（4 次采样全 null）⇒ 「计量实时跳动」**在本实现上不存在**；根因与 A5 同源（`EvalRowSchema` 的行级计量只在行收尾时写入）。
- 附带：计划的 `|startedAt(row1) − startedAt(row2)| ≤ 2000ms` **不可执行**——契约里**没有**行级 `startedAt`/`finishedAt`（见 A4）。

### §9-5 CLI 复核分支与 diff（与页面一致）

- 操作路径：跑动/出分期间对每个 `workspacePath` 执行 `git branch --show-current`、`git status --porcelain`、`git diff --name-only {baseline}`、`git diff --numstat`；页面上开「查看改动」抽屉比对。
- 证据：两行 branch 实测 == `test/9019625a-e461-4a24-a57d-fcff9c627d9c` / `test/a45cafa2-ec45-4cb5-8994-5a2b7c5682ed`；两行 workspace 互不相同；`rev-parse HEAD` 两行都 = `efc5a0a7…b86b68`（= baseline，无新提交）；**claude-code 7 行 porcelain 全 0**；**dsh 行 ` M math.js`、numstat `4 0 math.js`**，与 `run.json`（`filesChanged=1 insertions=4 deletions=0`）、`events.jsonl` 的 `diff-summary`、界面「共 1 个文件 · +4 −0」**四处非零相等**；`events.jsonl` 行 1 = 739 条、行 2 = 22184 条，两行都首 seq=1、严格递增、末条 `end` + `exitReason=completed`。
- **判定：⚠️ 部分通过**。「页面 == CLI」这条等式在**退化值**（0/0/0）与非**退化值**（dsh 的 1 文件 +4）两种情形下都成立；但计划要的是**每个 agent** 都在 cwd 里真的干过活，claude-code 的 7 行**全部不成立**——根因是 CLI 的写权限门（见 **A1**），**不是**编排层缺陷（工作区建好、分支正确、diff 计算正确、事件完整）。

### §9-6 出分核对（总分算式与 5 维）

- 操作路径：等 `run.status` 收敛 → 读两张卡片的排名徽标与数字 → 开「评分详情」抽屉逐维比对 → 读吸底「开始」的 disabled 与 Tooltip。
- 证据：两行各 5 维、每维 1 分、`sum=5`、期望 `round(5/25×100)=20`、实际 **20**（两行都成立）；维度 key 顺序 == `DIMENSIONS`（`correctness, requirement, quality, robustness, maintainability`）；卡片 = `第 1 名 … tok 27,388 轮次 8 耗时 26s 得分 20` / `第 1 名 … tok 15,440 轮次 16 耗时 13m53s 得分 20`；排名徽标 `["第 1 名","第 1 名"]`（同分并列）；抽屉的 5 维与 `run.json` **逐项相等**；`run.status=done`；「开始」`disabled=true`、Tooltip 原文「没有可执行的行（全部已评分）」。
- **判定：✅**（`tok` 与 `run.json` 的关系实测 `27,388 = 25,734(input) + 1,654(output)`，缓存不计入——与界面口径一致）。

### §9-7 串行 3 行中途终止（canceled / skipped）

- 操作路径：`/runs` →「创建评测」→ 执行模式选「串行」→ 加 3 行 →「创建」→「开始」→ 确认框 → 等 row1 `judged`、row2 `running` 且已有 agent 事件 → 吸底「终止」→ `Popconfirm` →「确定」。
- 证据：`mode=serial rows=3`、三行 branch/workspace 互不相同；任意采样 `running ≤ 1`；卡片排队文案「串行排队中：前一行结束后自动开始」；时间线 `19:09:17 row1=judged(20) row2=running` → `19:09:19.935 row2 首个 agent 事件（seq 3, init, cwd=…\d0cca135-…\workspace）` → `19:09:30 终止确定 ⇒ row2 canceled`；row2 事件 91 条（`seq 85 status:canceled`、`seq 86 end.exitReason:canceled`、`seq 90 [WARN] 该行已被终止：适配器已停止并释放运行时`）；**row3 `skipped` 只有 2 条事件**（`status:skipped` + `end.exitReason:skipped`，**没有任何 agent 日志/usage**）；`run.status=partial`；终止后 5 个 PID 全消失、dev 闭包回 0。
- **判定：✅**（载体由计划的 Run B 改为 **Run C**：Run B 的终止窗口被轮询脚本缺陷错过——见 A11①；Run C 的位置/行数/模式与计划对 Run B 的要求同形）。

### §9-8 再开始只跑未完成行（已 judged 不重跑）

- 操作路径：把用例的评分模型改指到**死端口供应商** `冒烟-Anthropic-Bad`（`http://127.0.0.1:15999`）→ 回到 Run C 详情 → 吸底「开始」→ 读确认框 →「开始」。
- 证据：确认框原文 `本次将执行 2 个候选：· Claude Code · claude-opus-4-8 · DeepSeek Harness · claude-haiku-4-5`（**不含 row1**）；确认后 row1 仍 `judged` 且 `score.judgedAt = 2026-09-25T19:09:16.290Z` **逐字符不变**；row2/row3 离开终态 → `preparing/running`。
- **判定：✅**

### §9-9 坏评分模型 → 该行 failed、其余行不受影响

- 操作路径：同 §9-8（评分模型指向死端口）→ 等两行收敛 → 读卡片错误文案与 `run.json`。
- 证据：row2/row3 都 `failed`、`error.code=INTERNAL`（∈ `ERROR_CODES` 的 10 个码）、`error.message` 非空且不含 `undefined`/`[object Object]`；两行 `diff` 与 `durationMs` **非 null**（失败只落在评分阶段，agent 阶段产物仍在）；`run.status=partial`；row1 的分数未被触碰；卡片原文 `INTERNAL：调用文本 API 失败（127.0.0.1:15999）：fetch failed`。
- **判定：✅（隔离逻辑成立）/ ❌（文案口径）**。计划明写「**绝不允许** `fetch failed` 之类的英文原文冒到界面」⇒ 实测是中文前缀 + **英文尾巴 `fetch failed`**、且**不含模型名** ⇒ 记 ❌（见 **A3**）。可取之处：带了 host（能定位到哪个供应商）与中文动作词。
- **R13 的替代路径在本环境还要再降一级**（见 §7.B 的 **B-R13**）：计划给的「手工加一条网关并不提供的模型」在本机**产生不了失败**——中继对任意模型名都回 200 并回落 `deepseek-v4-flash`；故改用「指向死端口的供应商」，失败因此发生在上游调用且**零上游成本**。

### §5.6.7-1 宿主环境变量跑完后未变

- 操作路径：读 dev 监听 pid → `GetProcessById($devPid).StartInfo.EnvironmentVariables` → 与开工快照 `Compare-Object` → 逐个查 7 个注入变量 →（读数不可信，改用**变异验证**证明守卫有区分力）。
- 证据：81 行 vs 81 行，差异 **2 行**（`DSH_SESSION_ID` 的 before/after 各一条）；7 个注入变量（`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / `CLAUDE_CONFIG_DIR` / `CODEX_HOME`）**全部 `[absent]`**；变异验证：`pnpm --filter @aieval/agents test -t 凭据` 绿（2 passed / 163 skipped）→ 在注入函数后临时加 `process.env.ANTHROPIC_BASE_URL = …` → **1 failed**（差异行 `+ "ANTHROPIC_BASE_URL": "https://gw.example.com/anthropic"`，用例名「凭据隔离：子进程拿到了密钥，宿主 `process.env` 一个字段都没变」）→ 逐字节还原（`ReadAllBytes` 回读比较 = True，哈希回 `188a6dc2…`）→ 再跑绿。
- **判定：⚠️ 部分成立**。计划要求 `Compare-Object` **输出为空**，实测 2 行差异；但两行都是 DSH 自己的会话 id、与会话内被测的三家适配器无关，且两个快照来自**不同进程**（74528 → 72176）。**归因：方法/会话边界，不是实现坏**；而「不写宿主 `process.env`」这条不变量由变异验证证明**有区分力**。

### §5.6.7-2 工作目录里确实产生了文件改动（逐 agent + 负控）

- 操作路径：对 3 个 run 的 8 行逐个 `git -C {ws} status --porcelain` + `git diff --name-only {baseline}`；页面开「查看改动」比对；负控找「工作区备好但一行没跑」的行。
- 证据：8 行逐行结果（RunA 2 行 / RunB 3 行 / RunC 3 行）里 **7 行 claude-code 全 0**、**1 行 dsh = 1 个文件 +4/−0**（`cwd-changes.txt`）。
- **判定：❌（claude-code）/ ✅（dsh）/ 负控未执行**。claude-code 的 0 改动根因是 CLI 的**写权限门 + 8.3 短名路径门**（见 A1）；SQL 的负控不可得（Run C 的 `skipped` 行后来真跑了）⇒ **替代的区分力证据**：同一夹具下 7 行 0 改动 vs 1 行 1 改动，断言不是恒真。

### §5.6.7-3 三种终止语义 + 子进程确实消失

- 操作路径：Run A/B/C 期间快照 dev 进程的传递闭包 → 差集求 agent 子进程 → 对 claude-code 行中途终止 → 3 秒后与收尾时两次复验 PID → 读各家的终止按钮文案。
- 证据：闭包基线 0 / 运行期 3（`claude.exe 75784` / `node.exe 23896` / `conhost.exe 5016`）/ 差集 **3**（≥3 ✅）；终止 + 收尾后 5 个 PID（含 Run A 期的 66224、78336）**全部 False** ✅、dev 闭包回 0 ✅；按钮文案：claude-code =「终止」、dsh =「关闭运行时」（**与另两家不同** ✅，`cancelMidTurn: false`）、codex = 不可达。
- **判定：⚠️ 未按字面达成**。1 家完整（claude-code：语义 + 子进程回收 + 文案）、1 家只拿到文案（dsh **未真被终止**）、1 家完全不可达（codex **连行都建不出来**）；**Run D 整体未执行**（agent 启动预算 9/9 用满 + codex 无法建行）⇒ 见 **A8**。

### p1 交接-工作区校验（沙箱 root 落定 + 不可写负控 + 落盘未变）

- 操作路径：`/settings` → Tab「工作区」→ 把根目录改成 `$smokeRoot\workspace` →「校验并保存」→ 改成同名**文件** `$smokeRoot\ws-blocked` →「校验并保存」→ 改回 `$smokeRoot\workspace` →「校验并保存」。
- 证据：正例 `[ant-alert-success] 工作区可用：…\workspace`（rect 1382×40）+ 盘上 `settings.workspaceRoot` 一致；负控 `[ant-alert-error] 工作区不可用，设置未改动` + `无法创建工作区根目录：…\ws-blocked（EEXIST: file already exists, mkdir '…'）` + `PUT /api/settings → 400 {"error":{"code":"NOT_WRITABLE",…}}` + **输入框保留刚填的值** + **盘上值未变**；收尾恢复绿。**计划脚本的形状偏差已登记**：盘上是 `{settings:{workspaceRoot},…}`（嵌套）而 `GET /api/settings` 是扁平的，计划写的 `$cfg.workspaceRoot` **恒为空**（会造出假 ❌）；本项两者都测、判定以 `settings.workspaceRoot` 为准。
- **判定：✅**

### p1 交接-接口与界面正控（两汉字按钮不插空格、anthropic 拉取 400、响应只有 `apiKeyMasked`）

- 操作路径：`/settings` Tab「模型供应商」→ 盘点全部 button 的文本与可访问名 → `curl.exe` 打 `POST /api/providers/{id}/models/fetch` → 读 `GET /api/providers` 的键名与正文。
- 证据：插空格正则 `/^[\u4e00-\u9fa5] [\u4e00-\u9fa5]$/` 命中 **0**；`fetch` → `400 {"error":{"code":"INVALID_QUERY","message":"Anthropic 兼容协议没有 /models 接口，模型清单请手工维护"}}`；响应键名 = `id, createdAt, updatedAt, name, protocolType, baseUrl, models, apiKeyMasked`、带明文 `apiKey` 键的条数 **0**、正文里出现明文 `PROXY_MANAGED` = **False**。
- **判定：✅ / 一项正控不可得**。`len == 2` 的按钮有 4 个（编辑/删除/取消/保存）且都无空格，但它们各自显式传了 `autoInsertSpace={false}`（计划自己把它们算作负控）；**app 级正控**（`ConfigProvider` 层面的两汉字按钮）在本页**不可得**——`/runs`、`/cases` 空态引导按钮文案是「创建评测」「创建用例」（长度都是 4）⇒ 本项只证明了「**没有任何按钮被插空格**」，**不写成**「app 级义务已验证生效」。

---

## 4. 未覆盖项与后续计划（是什么 / 为什么没覆盖 / 后续怎么办）

1. **空池 `Alert` 的正反两面**：**已取到**（用「换智能体」驱动：切 Codex 出告警 292×50、切回消失 1→0），故**不属于**未覆盖项。未照计划「删/加 anthropic 模型」驱动的原因：删掉会把该供应商的模型池整个清空，而用例的评分模型正指向它 ⇒ 判分会先 `CONFLICT`，把第 3–6 项一并打断。
2. **dsh 的 token 计量数值**：本阶段只验证了**界面文案**（`未采集` / `不支持计量`，**不是 0**），没验证数值。字段名的权威结论在 p3 探测报告（`docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` §3/§7）：dsh **确有 usage**（`assistant/message` → `data.usage.{inputTokens,cacheReadTokens,outputTokens}`）⇒ 元数据 `usage: true` 已由 p3 落地。**后续**：真机复核「`usage` 条数 === 轮次数」（见 B4）。
3. **服务重启恢复（`interrupted`）**：只有 p4 的单测覆盖，**本阶段未做真机重启验证**——刻意省成本（重启会打断会话）。**后续**：单独一轮「起服务 → 造在途行 → 强杀 dev → 重启 → 读 `run.json` 的 `interrupted`」。
4. **`partial` vs `done` 的口径**：**已由 p4 钉死**（全 `judged` → `done`；有行没出分 → `partial`），本阶段按它做了硬断言且**实测相符**（Run A `done`、Run C `partial`）⇒ 不是缺陷、不是未做项。
5. **prod 模式（`next build && next start`）下的完整冒烟**：**未执行**。p5 阶段评审为定位 C1 在 prod 下跑过**局部**验证（模块实例 id、curl 收帧），p5 修复波也在 dev 与 prod 各做了一遍 **C1 条目的验收**；但「16 项界面冒烟在 prod 下重跑一遍」至今**未做**。**后续**：与整分支终审的 `pnpm build` 合并做一次抽样。
6. **真实 codex / dsh 候选行的端到端**：**未执行**（本机唯一可达网关只讲 Anthropic Messages；codex 适配器硬编码 `wire_api='responses'`）。**后续**：等有一个可达的 OpenAI Responses 网关时，只重跑 p3 Task 11 的 `--kind=codex` 与 p6 Task 7 Step 3 的 Run D，不算复跑整轮。
7. **无行级 `end` 事件的真实覆盖**：p5 冒烟与 p6 的真机终态都是「该行失败」，**不是** `end` 事件 ⇒ 要覆盖它需要一条**能产出改动**的真实跑（与 A1 同源：修了写权限才可能）。**后续**：随 A1 的修复补一条真机跑。
8. **`R35` 的残留**：外置依赖的**形态**（Next 把裸说明符发成 `module` 还是 `commonjs`）**始终未验**——见 §7.B 的 B-p3-5（R35 残留）。
9. **本轮被环境挡住的项**：openai 拉模型与合并断言、Run D 整体、codex 一切真跑、dsh 的真实终止、§5.6.7-2 的负控（见 A6/A8 与 §1 的未执行清单）。
10. **已接受、不修的界面弱点**（沿用脚手架冒烟记录 §4 的四条，**本期不修、不要顺手改掉**）：① 分隔条拖动方向与文字描述相反（分隔条跟随光标是标准语义，实测「向左拖 → 右栏变**宽**」）；② 窄窗口下右栏不让位、左栏被压到 **88 / 16px**（低于它自己声明的 `min: 120`）；③ **双击分隔条无任何反应**（antd 6.6.5 的 Splitter 无内置双击复位，`onDraggerDoubleClick` 无人传）；④ 900 高时右栏不溢出、520 高时右栏能滚但**页面溢出 25px**（`PageShell` 缺 `minHeight: 0`）。

---

## 5. 设计文档 12 节覆盖矩阵（用命令派生，不靠记忆）

派生命令（实测输出）：

```powershell
Select-String -Path 'docs\superpowers\plans\2026-09-22-features-p*.md' -Pattern '§(\d+)' -AllMatches |
  ForEach-Object { "$(Split-Path $_.Path -Leaf)`t$(($_.Matches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) -join ',')" } |
  Sort-Object -Unique
Select-String -Path 'docs\superpowers\plans\2026-09-22-features-p*.md' -Pattern '^## Task \d+:' |
  ForEach-Object { "$(Split-Path $_.Path -Leaf)`t$($_.Line)" }
```

实测结果（按文件聚合，节号去重升序）：

| 计划文件 | 引用的设计文档小节 |
|---|---|
| `2026-09-22-features-p0-contracts-core.md` | 2, 3, 4, 5, 6, 7, 8, 9, 10, 11（另有 `§15` 是**笔误/自指**，见下方偏差） |
| `2026-09-22-features-p1-settings.md` | 2, 3, 4, 6, 7, 8, 9, 10, 12 |
| `2026-09-22-features-p1-contracts.md` | 4, 5, 6, 7, 8, 9, 10（另一会话的未跟踪文件，仅供参考） |
| `2026-09-22-features-p2-cases.md` | 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12（`§0` 指接口契约的 §0） |
| `2026-09-22-features-p3-agents.md` | 1, 2, 3, 4, 5, 7, 9, 11, 12 |
| `2026-09-22-features-p4-evaluator.md` | 2, 3, 4, 5, 6, 7, 9, 10, 11 |
| `2026-09-22-features-p5-runs.md` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12 |
| `2026-09-22-features-p6-smoke.md` | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 |

**偏差（如实记录，不改计划文件）**：① p0 里出现的 `§15` **不是**设计文档的小节（该文档只有 §1–§12），核对原文是 `§15 第 5 步` 一类自指笔误；
② p2 的 `§0` 指向的是接口契约的 §0（计划集与依赖顺序），不是设计文档；
③ 设计文档 §1–§12 **每一节都至少被一份计划引用**，无空行。

12 行覆盖表：

| 设计文档章节 | 承载计划 | 承载任务 / 小节 | 现场证据 |
|---|---|---|---|
| §1 要解决的问题 | 全阶段 | README 的「评测口径」+ 本阶段的使用手册 | `README.md`；本文件 §1 |
| §2 本阶段范围 | p0–p5 全体 | 各计划的头部 Global Constraints | 各计划的任务清单（`Select-String '^## Task \d+:'` 实测 15+9+9+12+8+11 个任务） |
| §3 功能域关键决策 | p0（F1/F13 契约与落盘）、p4（F3–F8/F12/F14）、p5（F2/F9/F11） | p0 Task 1–15、p4 Task 1–8、p5 Task 1–11 | 各阶段评审报告 + 本文件 §3 |
| §4 用例管理 | p2 | p2 Task 2/5/6/8 | `evidence/03-case.md`（表单六字段、两个负例、AI 生成） |
| §5 评测管理 | p5（§5.1/§5.3/§5.4）、p4（§5.2/§5.5/§5.7）、p3（§5.6） | p5 Task 1/7/8/9、p4 Task 5/6、p3 Task 6–10 | `evidence/04-runA.md`、`05-runB.md`、`06-adapters.md` |
| §6 设置 | p1（§6.4 界面主题归脚手架 + p6 R31） | p1 Task 1–9；p6 Task 1 Step 4（R31） | `evidence/02-providers.md`；`evidence/r31-locale-{before,after}.txt` |
| §7 数据模型与持久化 | §7.1/§7.2 → p0；§7.3 → p0（契约）+ p4（评分）；§7.4 → p0（`event-log`）+ p4（扇出） | p0 Task 1–13、p4 Task 2/3 | `evidence/04-runA.md` §4（`usage` 事件 == `run.json`）、`events.jsonl` 实测 |
| §8 路由与前端接入 | p1/p2/p5 各自的路由段 + p5 的 SSE（+ 契约 R38） | p1 Task 7、p2 Task 7、p5 Task 3/10/11 | `apps/web-next/app/api/**`（实测 **19** 条 route.ts）；`README.md` 的接口表 |
| §9 测试 | 各计划自己的测试任务；**冒烟 9 项 = p6 Task 3–6** | p6 Task 3/4/5/6 | 本文件 §1/§3（9 项逐项） |
| §10 错误处理 | p0（错误码）→ p1/p2/p4/p5 的用例 | p0 Task 1；p1 Task 2；p2 Task 2；p4 Task 3/4；p5 Task 1 | `errors.ts` 实测 **10** 个码；`evidence/03-case.md` §3/§5.1；`README.md` 排障表 |
| §11 实施顺序 | 第 1–7 步 = p0–p5；**第 8 步 = p6** | 七份计划的头部「Spec」段 | 本文件 §1（第 8 步的 12 项） |
| §12 澄清结论 | 逐条落到上面的章节；dsh 的 usage 字段名由 p3 探测钉死 | p3 Task 11/12 | `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` §3/§7.2（`usage: false → true`） |

---

## 6. 对设计文档的实现层修正汇总

### 6.1 接口契约 §11 的 R1–R9（逐条不漏）

| 编号 | 修正内容 | 理由（摘要） | 归属 | 落地证据 |
|---|---|---|---|---|
| **R1** | `AGENT_KINDS` / `AgentKind` 真源放 `contracts`（`run.ts`），`agents` 再导出 | contracts 不能 import agents，而前端下拉与 `EvalRow.agentKind` 要从同一处派生 | p0 定义、p3 再导出 | `packages/server/contracts/src/run.ts`；`packages/server/agents/src/index.ts`；p3 `registry.test.ts` |
| **R2** | `EvalRow` 增 `baselineCommit: string`（40 位；**空串 = 尚未准备**） | `commitHash: null` 时 diff 没有可比基线 | p0 定义、p4 写入、p5 展示 | `evidence/04-runA.md` §2（起跑前 `""`，开始后 = `efc5a0a7…b86b68`） |
| **R3** | 三样 diff 取法：先 `git status --porcelain` → 再 `git add --intent-to-add --all` → 取 `git diff {baseline}..HEAD` + `git diff HEAD` | 未跟踪新文件的**正文**也要进评分输入 | p0 实现 + 回归用例 | `packages/server/core/src/git.ts`；p0 的三样合并用例；p5 冒烟 §1 第 11 行 |
| **R4** | `NOT_A_GIT_REPO` / `INVALID_REF` / `JUDGE_PARSE_FAILED` 进 `ERROR_CODES`（400/400/500） | §10 要求这三个场景有码，`httpStatusFor` 要求每个码都有映射 | p0 | `packages/server/contracts/src/errors.ts`（实测 10 个码）；`evidence/03-case.md` §3/§5.1 实测 400 |
| **R5** | 生成评分提示词与评分共用 `callTextApi` + `resolveJudgeRoute` | 两处都是「非流式文本 API + 双协议路由」，写两份必然漂移 | p0 定义、p2/p4 消费 | `packages/server/evaluator/src/text-api.ts`、`judge-route.ts`；p2/p4 的接缝守卫 |
| **R6** | 事件总线是**进程内**订阅 + 从 `events.jsonl` 回放，不做跨进程（**原文不动**；投递契约另立 R38） | 单 Next 服务进程；跨进程需要额外消息层、收益为零 | p4 | `packages/server/evaluator/src/events.ts`；R38 ② 明确「原文照旧」 |
| **R7** | 仓库校验与 commit 候选路由按**仓库路径**而非 `caseId`（`cases/validate-repo`、`cases/commits`） | 创建用例时还没有 caseId | p2（并同步修正 §8 的路由清单） | `apps/web-next/app/api/cases/validate-repo/route.ts`、`…/commits/route.ts`（实测存在）；`evidence/03-case.md` §2/§4 |
| **R8** | `EvalRow` 增 `providerId: string` | 执行该行要拿供应商的 `baseUrl` 与 `apiKey`，只存展示快照无法定位凭据 | p0 定义、p5 写入 | `evidence/04-runA.md` §4（`judgeProviderId` 非空）；`run.json` 行快照 |
| **R9** | `EvalRow.error` 增 `code: string` | 失败行要带领域归因，只有 `message` 时只能靠文案匹配 | p0 定义、p3/p4 写入、p5 展示 | `evidence/05-runB.md` §4.3（`error.code=INTERNAL` ∈ `ERROR_CODES`） |

### 6.2 计划编写期裁决的 R10–R25（与本次冒烟相关者逐条说明）

R10–R25 的完整表述在接口契约 §11；下表只记**本次冒烟能给出证据**或**必须进关账**的那些：

| 编号 | 一句话 | 本阶段证据 / 处置 |
|---|---|---|
| **R10** | 读侧只扫当前 `settings.workspaceRoot` ⇒ 改过根目录的旧轮次不可见（**取巧不取默**） | **实测复现**（见 A10）；进 §7.B 的 B-p5-1 组内的 R10 条与 §8 |
| **R13** | §9 第 9 项无法按字面执行，替代路径与差异写进关账 | 本环境**还要再降一级**（见 §7.B 的 B-R13） |
| **R17** | `appendEvent` 每次全量回读定 seq（O(n)/条，长日志退化 O(n²)） | 本次真机把它放大成可观测现象（见 §7.B 的 B-p5-2，即 p5 的 F4） |
| **R18** | `composeTotalScore` 的分母是常量 25，不是 `scores.length` | 本阶段**实测符合**（§9-6：两行 `round(5/25×100)=20`） |
| **R19** | 三样 diff **不含被 gitignore 的文件**（`git add` 上根本没有 `--include-ignored`） | 未在本次冒烟中单独复核（p0 有反向用例：忽略文件的正文**不得**出现在 diff 里） |
| **R20** | `checkoutRow(dir, null, branch)` 的基线 = **默认分支 tip**，不是当HEAD 的字面值 | 本阶段实测各行的 `baselineCommit` 都等于用例的 `commitHash`（§9-5） |
| **R21** | numstat 在 `-N` **之后**读；`truncateDiff` 只对文件片段计费、截断标记恒在 | `evidence/05-runB.md` §5 的四处非零相等（numstat `4 0` == 页面 `+4 −0`） |
| **R24** | `appendEvent` 用**静默的原始最大 seq 扫描**分配 seq | 见 §7.B 的 B-p5-2 的 ⚠️：这是**正确性**口径，别当成性能问题一起改掉 |
| **R25** | `prepareRowWorkspace` 失败时回滚行目录后原样重抛 | p0 单测面；本阶段未单独复核 |

（R11/R12/R14/R15/R16/R22/R23 与本次冒烟无直接交集，未逐条复核；R26–R31 见 6.3。）

### 6.3 各计划自述与后续追加的修正（R26–R38）

| 编号 | 修正内容 | 理由（摘要） | 归属 | 落地证据 |
|---|---|---|---|---|
| **R26** | `appendEvent` 写侧也 `safeParse`：不符合契约抛中文 `ServiceError('INTERNAL')` 且一个字节都不写；读侧容忍不变 | `events.jsonl` 是唯一真相源，写侧容忍的后果是**静默少一条** | p0 Task 12 | `packages/server/core/src/event-log.ts` + 用例 |
| **R27** | 重跑同行走只清 `workspace/` 与 `.agenthome/`，**绝不**整目录擦除；`events.jsonl` 的清空**唯一**由 `resetEvents` 负责 | 整目录删会把刚写的 `preparing`（seq 1）抹掉，下一轮从 seq 1 重发 ⇒ 客户端按 seq 去重会**静默吞掉**第一条状态事件 | p0 Task 11/12 接缝 + p5 客户端按「`seq===1` = 新一代」处理 | p0 用例；p5 `useRowStream` 的 R27 三条守卫（变异 3/3 被杀） |
| **R28** | `ensureCaseCache` 把缓存当「**某一个**来源仓库的克隆」：来源记录写 `{cacheDir}/.git/aieval-origin.json`；`commitHash === null` 先 fetch + reset 再复制；不在缓存里才抛 `INVALID_REF`（点名**来源仓库路径**） | 冻结 tip 会让 `null` 不再是「默认分支 HEAD」；没有来源记录会把**另一个仓库**当成被测对象 | p0 Task 9/11 | p0 用例；本次冒烟的三轮 run 都走这条路径 |
| **R29** | 编排层**不再**单独调 `ensureCaseCache`（缓存准备已由 `prepareRowWorkspace` 内部完成） | 两参数形态会对每个钉了具体 commit 的行也 fetch + `reset --hard`（纯浪费），且来源不可达时会误抛 `NOT_A_GIT_REPO` | p4 | `orchestrator.ts`；p4 接缝守卫 |
| **R30** | 判「评分模型是否可用」必须**对着 `providers` 解析**，不能只判 `defaultJudge !== null` | 删除供应商/移除模型后 `defaultJudge` 会变成**悬空引用**，只判非空会让界面承诺一件会失败的事 | p1 评审 → p2/p5 落地 | `evidence/03-case.md` §0（`judgeConfigured` 的判定口径实测一致：未配全局默认时按钮 `disabled=true`） |
| **R31** | 在 `apps/web-next/app/providers.tsx` 的 `ConfigProvider` 上补 `locale={zhCN}` | 「antd 内置文案默认英文」这一整类的**根因修复** | **p6 落地** | 提交 `9820457`；`evidence/r31-locale-{before,after}.txt`（同处 `svg title`：`["No data"]` → `["暂无数据"]`，显式中文文案不变） |
| **R32** | 用例的评分模型覆盖是**全有或全无**；判定侧遇「只填一个」判不可用；写侧按**值**判是否触及评分字段 | 半配置会让「判定回落全局 + 按钮可用 + 点下去 409」构成第三个可达的错误结论 | p2 修复波 → p2 收口波（按值判定由 scoped re-review 的 N1 补正） | p2 用例；`evidence/03-case.md` §0（两个 id 成对 = True） |
| **R33** | p3 的 dsh 依赖走 `next` 线（实装 **0.1.7-rc.1**），不是 `latest` | `latest` 的 peer 闭包里有三个公开源全 404 的包 ⇒ 按 `latest` 装在本机**不可能完成** | p3 Task 2（控制方裁决） | `packages/server/agents/package.json`；本阶段走的是 SDK 自带那份（`resolveDshLaunch`） |
| **R34** | 契约收口 p2 新增的三个跨包可见名字（`GenerateJudgePromptResult`、`COMMITS_KEY`/`matchesCommitsKey`、`CaseDetailPanel.deleting?`） | 不补文档的代价是 p5 很可能再写一份字面量或第二个 `dimensions` 类型 | p2 阶段评审 → 控制方补契约 | `evidence/03-case.md` §6-8b（候选缓存键命中：POST 计数 1→2→3、列表 GET 全程 0） |
| **R35** | 三家 SDK 必须同时声明在 `apps/web-next/package.json` 的 `dependencies` 里，并由 `runtime-deps.test.ts` 钉住 | 外置说明符由 **Node 在产物目录里解析**，pnpm 只把它们链在 `agents` 包下 ⇒ 不声明就会在**运行时**炸 | p3 Task 2 build 复核 → 控制方裁决 | `apps/web-next/src/runtime-deps.test.ts`；**残留未验**见 §7.B 的 B-p3-5 |
| **R36** | `runId` 的形状校验落在 `evaluator/run-store.ts` 的 `getRun`/`saveRun` 入口；消费方不要再写第二份、也不要把形状错当 `NOT_FOUND` | `runId` 会被直接拼进路径，而它的来源是**用户可控的 URL 段**；写侧守卫缺失时逃逸**当场可达**（已实测） | p2 阶段评审 F5 → p2 收口波 → p5 消费 | `run-store.ts` 的 `assertRunId` + 用例；p5 的 N9 反例（`api` 侧删掉重复校验） |
| **R37** | `dsh.protocolType` 由 `openai` 改为 **`anthropic`**（实测 `POST {root}/v1/messages` + `x-api-key`） | `protocolType` 是候选池**按协议过滤**的数据来源；保持 `openai` 会让表单给 DSH 列出不兼容的网关 | p3 Task 11 探测 → 控制方裁决 → p5 候选池跟随 | `evidence/04-runA.md` §1（`/api/runs/model-options` 里 dsh 的 `protocolType='anthropic'`）；p3 探测报告 §4 |
| **R38** | SSE 的**投递契约**与订阅时机分开裁决：① 具名事件必须用 `addEventListener(<type>)` 订阅；② 订阅时机/去重照 R6；③ 必须有**真实 HTTP + 真实 EventSource 语义**的端到端守卫；④ 已知限制（dev-only）：Turbopack 重编译重建模块图 ⇒ 模块级状态换代、已建立的长连接可能被孤立 | R6 只规定了「订阅**时机**」与「**去重**」，**一个字**没规定「帧发出去之后浏览器凭什么收得到」——C1 正是从这个缺口漏过去的 | p5 整阶段评审 → p5 修复波落地 | `packages/client/client/src/row-stream.e2e.test.tsx`（真实 语义守卫）；p5 修复波 dev + prod 各一次真机验收；`docs/.../p5-smoke.md` 的勘误段 |

### 6.4 本阶段新增的修正

| 编号 | 修正内容 | 理由 | 落地证据 |
|---|---|---|---|
| **R39（本阶段新增）** | **设计文档 §9 第 1 项的判定口径收窄为**：「本次端到端只覆盖 **anthropic** 协议路径；openai / codex 路径在本环境只有**类型面与单测面**证据」。同时把「两个协议各一个可用供应商」从**硬前置**降为**理想前置** | 本机唯一可达网关只讲 Anthropic Messages（`/v1/chat/completions`、`/v1/responses` 实测 503 空体、`/models` 空清单），且 codex 适配器硬编码 `wire_api='responses'` ⇒ 那条硬前置在本环境**不可能满足**；不收窄口径就只能写「未执行」而丢掉已经拿到的 5 项通过 | 本文件 §1（口径段 + §9-1 判定）、§3-§9-1；`evidence/probe.txt` §1；`evidence/models.json` |
| **R40（本阶段新增）** | **行级计量与行级时间戳是「终态才有」的**：`EvalRowSchema` 只有 `durationMs`/`tokens`，**没有** `startedAt`/`finishedAt`，且这些字段在行结束前**恒为 `null`**。凡要求「实时跳动」「行级时间戳」的断言，在动契约之前**一律不可执行** | 计划里两处断言（§9-4 的计量递增、Task 6 Step 2 的 `startedAt ≥ finishedAt`）都引用了不存在或运行时恒 null 的字段 ⇒ 会造出假 ❌。**不改契约**：实时跳动需要 p4 在运行期回写行快照，属新需求 | 本文件 §1（§9-4）、§3-§9-4；`evidence/04-runA.md` §2 判定 4.1b/4.2；`evidence/runA-poll.jsonl`；`packages/server/contracts/src/run.ts` |
| **R41（本阶段新增）** | **`pnpm test` 的满载超时是已知噪声，不是回归信号**；读全量红之前先确认「没有别的代理在跑套件/变异体」，并且**根 `pnpm test` 是根上单跑一次**（不是每包一行 `RUN`） | 实测改前 3 / 改后 4 条 `Test timed out`、**无一条断言失败**，四条逐条隔离复跑全绿（ui 14、core 13、web-next 9、api 37）；改前改后**同一批 3 条**逐字同名 | 本文件 §7 B-p6-9；`evidence/step5-test-{before,after}.txt`、`step5-test-isolated-reruns.txt(+.1–.4)`、`step5-test-after.utf8.txt` |

**编号冲突/漏项的显式说明**：① 接口契约 §11 的表里 **R8/R9 由 p0 计划自述追加**（不在最初 R1–R7 的七条内），本表已收；
② **R10–R25 是计划编写期裁决**，与 R1–R9 同一张契约表但语义不同（前者是「对设计文档的实现层修正」，后者是「计划编写期暴露的接缝裁决」），本表按契约原文分节，未混编；
③ 本节新增的 **R39–R41 尚未回写接口契约 §11**（本阶段只允许改 README、本关账记录与 p6 计划），**交整分支终审与后续文档轮**回填。

---

## 7. 缺口清单（现象 / 影响 / 证据 / 最小修法 / 归属）

**分类约定**（每条的「归属」列同时给出类别与责任方）：

- **[环境坏]** = 本机的网关/CLI/额度等外部条件所致，**实现无法自证其错**；后续动作是「换环境复测」。
- **[实现问题]** = 代码或契约本身的行为与设计文档/计划的要求不符；后续动作是「改代码或改契约」。
- **[设计取舍]** = 有意接受、已记账的偏离（含「取巧不取默」与「等环境恢复再补」）；后续动作是「保持现状并在文档里显式声明」。

### 7.A 本阶段（p6）实测出来的缺口 —— 11 条

**A1. claude-code 适配器在评测运行里拿不到写权限** —— **本次会话发现的、产品影响最大的缺口**

- **现象**：claude-code 的候选行在评测运行里**永远产出不了代码改动**（3 个 run、**7 行全部 `git status --porcelain` 为 0 行**）。CLI 自己的原文：`Claude requested permissions to write to <path>, but you haven't granted it yet.`；events.jsonl 里出现 **23 次** `permission_denied`，`decision_reason` = `Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification`；CLI 最后一轮输出写明了结论：读写都被 harness 的路径安全门挡住，触发点是路径里的 **8.3 短名**段 `ZHANGL~1`。
- **影响**：**Claude Code 这一家在评测里等于只能读不能写** ⇒ 它的行永远 0 改动、评分永远在「无改动」的输入上打分（Run A 两行都是 20 分、`diff` 0/0/0）。这条同时挡住「§5.6.7-2 逐 agent 有改动」与「行级 `end` 事件的真实覆盖」（见 §4 第 7 条）。
- **对照事实（关键）**：**同一台机器、同一个工作区**，dsh 行**写出了 +4/−0**（` M math.js`）；dsh 的启动形状实测带 `permission/preset: workspace-write`、`sandbox/mode: workspace-write`、`approval/policy: ask`。
- **证据路径**：`evidence/04-runA.md` §3（含 23 次 `permission_denied` 与 CLI 结论原文）、`evidence/cwd-changes.txt`（8 行逐行）、`evidence/06-adapters.md` 第 2 项、`evidence/05-runB.md` §5。
- **最小修法（未应用）**：`packages/server/agents/src/providers/claude-code/index.ts` 的 `sdk.query` 选项里补 `permissionMode: 'acceptEdits'`（或等价的允许清单），并把 `cwd` 先做 **`realpath`** 归一（避免把 8.3 短名交给 CLI 的安全门）。**两条一起做**：只补 `permissionMode` 而路径仍是短名，仍会撞路径门。
- **归属**：**[实现问题]** —— 产品侧（`packages/server/agents/**`）。**责任方：单独一批修复**（本阶段明令不改 `packages/**`），修完补一条「claude-code 行必须有非零改动」的真机跑。**修了它才可能覆盖行级 `end` 事件。**

**A2. 终止 claude-code 行泄漏 14 次 `unhandledRejection`**

- **现象**：整段会话 dev 日志里出现 **14 次** `⨯ unhandledRejection: Error: Query closed before response received`，堆栈逐层指向
  `providers/claude-code/index.ts:53` 的 `void query.interrupt?.()` → `turn.ts:164` → `release.ts:37` → `turn.ts:161`。
- **影响**：不影响行终态（Run C 的 row2 确实 `canceled`、子进程确实回收），但**未捕获异常会淹没真实错误日志**——排障时最容易先看到它。
- **证据路径**：`evidence/07-cleanup.md` Step 4（dev 日志 1191 行里 `5xx = 0`、`[ERROR] = 2`（都是故意的坏评分器）、`hydration = 0`，唯独这 14 条 `unhandledRejection`）；`evidence/05-runB.md` §3 的末段。
- **最小修法（未应用）**：与 codex 那次**同形**——把 `void query.interrupt?.()` 换成 `void Promise.resolve(query.interrupt?.()).catch(() => {})`（或在 `release.ts` 的调用点挂 `.catch`）。
- **归属**：**[实现问题]** —— 产品侧（`packages/server/agents/**`）。**责任方：与 A1 同一批修复。**

**A3. `callTextApi` 的失败文案带英文原文、且不含模型名**

- **现象**：界面卡片与 `error.message` 实测 = `调用文本 API 失败（127.0.0.1:15999）：fetch failed`。
- **影响**：计划明写「**绝不允许** `fetch failed` 之类的英文原文冒到界面」；且文案**不含模型名**，用户看不出是哪个模型/哪一段配置的问题（只有 host 能定位到供应商）。可取之处：有 host、有中文动作词。
- **证据路径**：`evidence/05-runB.md` §4.3（原文与调用点 `packages/server/evaluator/src/text-api.ts:99` 的 fetch catch 分支）；`evidence/07-cleanup.md` Step 4 的 4xx/[ERROR] 逐条归因。
- **最小修法（未应用）**：`text-api.ts` 的 catch 分支按错误类型给中文归因（连接被拒 / DNS / 超时 / TLS），把 `fetch failed` 降级为附注，并在文案里带上 `modelId`。
- **归属**：**[实现问题]** —— 产品侧（`packages/server/evaluator/**`）。**责任方：随 A1/A2 之后的文案轮。**

**A4. 契约里没有行级 `startedAt` / `finishedAt`，计划两处断言不可执行**

- **现象**：`EvalRowSchema`（`packages/server/contracts/src/run.ts`）只有 `durationMs`，**没有行级** `startedAt`/`finishedAt`（run 级才有）。计划里 §9-4 的「两行 `startedAt` 差 ≤ 2000ms」与 Task 6 Step 2 的「行 2 `startedAt ≥` 行 1 `finishedAt`」都引用了这些字段。
- **影响**：两条断言**恒不可执行**（不是失败，是无法表达）。本阶段用 `events.jsonl` 的 `at` 时间戳替代（row1 末条 `end` @18:57:04 早于 row2 首条 `status:preparing` @18:57:06）⇒ 语义结论仍成立，但**证据强度降一级**（是推导，不是字段直接读）。
- **证据路径**：`evidence/04-runA.md` §2 判定 4.1b；`evidence/05-runB.md` §2 对应行；`packages/server/contracts/src/run.ts` 的行 schema。
- **最小修法（二选一，未应用）**：① 契约加两个可选时间戳并由 p4 在行起止时写入（**改契约**，会影响 p5 的展示与既有快照兼容）；② 计划与后续断言一律改用 `events.jsonl` 的 `at`（**不改契约**，成本最低）。**本阶段选 ② 并在 R40 里显式声明。**
- **归属**：**[设计取舍]** —— 契约层。**责任方：整分支终审裁定**（若选 ①，属新需求，不进本分支）。

**A5. 行级计量在跑动期间恒为 `null`（`durationMs`/`tokens`）**

- **现象**：4 次采样（跨 ≥10 秒）两行的 `durationMs`/`tokens` **全是 `null`**，到行收尾才一次性跳到位（`26465` / `833361`）。界面因此显示 `tok 未采集 轮次 未采集 耗时 未采集`（**不出现 0**，这一点是对的）。
- **影响**：与 A4 同源 ⇒ 计划的「**计量实时跳动**」这条用户可见的体验断言**在本实现上不存在**。**好消息**：`null ≠ 0` 的口径守住了（§9-4 判定 4.3 ✅）。
- **证据路径**：`evidence/04-runA.md` §2 判定 4.2；`evidence/runA-poll.jsonl`（3 秒粒度时间线）；`packages/client/ui/src/base/metric-line.tsx`。
- **最小修法（未应用）**：与 A4 的方案 ① 绑定——要么 p4 在运行期回写行快照（真做实时），要么把「实时跳动」从断言集里删掉、界面文案保持「未采集直到终态」。**本阶段不做**。
- **归属**：**[设计取舍]**（同时也是**计划口径错**：断言写了一个实现从未承诺的性质）。**责任方：整分支终审**。

**A6. openai 协议整条不可达 + codex 无任何可达网关**

- **现象**：`GET {base}/v1/models` 与 `GET {base}/models` → **200 且清单为空 `{"models":[]}`**；`POST {base}/v1/chat/completions`、`POST {base}/v1/responses` → **503 空体**。codex 适配器把 `wire_api` **硬编码为 `'responses'`**（`packages/server/agents/src/providers/codex/sdk.ts:25`、`:86`）⇒ 该路径同样 503。**比「跑起来再失败」更早一步**：`GET /api/runs/model-options` 实测 codex 的 `options = []`，而表单的「模型」是**必填** ⇒ **codex 行在本环境连建都建不出来**。
- **影响**：Run A 的两行从「claude-code + codex」降级为两条 claude-code；**Run D 整体不可执行**（见 A8）；spec §9-1 的两个协议供应商前置**不可能满足**。
- **证据路径**：`evidence/probe.txt` §1；`evidence/models.json`；`evidence/02-providers.md` §2；`evidence/04-runA.md` §0/§5；`evidence/06-adapters.md` 第 3 项。
- **最小修法/后续动作**：等一个可达的 **OpenAI Responses** 网关后，只重跑 **p3 Task 11 的 `--kind=codex`** 与 **p6 Task 7 Step 3 的 Run D**（不算复跑整轮）。**不要**为了让 codex 跑起来去改 `wire_api`（那是适配器的设计取值，不是本环境该动的东西）。
- **归属**：**[环境坏]**（`wire_api` 硬编码是**设计**，不是缺陷）。**责任方：环境恢复后由控制方派单。**

**A7. 计划硬前置「两个协议各一个可用供应商」达不到；`AIEVAL_PROBE_*` 全空**

- **现象**：Task 1 Step 2 的四个变量实测**全部未设**（`env 里 AIEVAL* 变量条数 = 0`）⇒ 计划要求的 4 行 `[OK]` 不可能出现；计划 Task 2 Step 4 的选型规则是「取 `/models` 里第一个命中 `/(flash|mini|small|lite|chat)/i` 的 id」，而清单为空 ⇒ **规则的分母是 0，无法执行**。
- **影响**：整条冒烟只能走**降级路径**；选型与探针的两处判定必须按实测改写（已登记在 `evidence/models.json` 与 `guards.md` 的「本环境的偏差」）。
- **证据路径**：`evidence/step2-env-vars.txt`（含脚本在空值上 `TrimEnd()` 的两条必然报错原文）；`evidence/probe.txt` §1；`evidence/models.json`；`evidence/guards.md`。
- **最小修法/后续动作**：把「两个协议各一个可用供应商」在计划/设计文档里从**硬前置**降为**理想前置**（见 **R39**）。
- **归属**：**[环境坏]**（凭据不在环境里是事实）；**口径收窄**本身是**[设计取舍]**。**责任方：整分支终审回填 R39。**

**A8. Run D 整体未执行（含 dsh 的真实终止）**

- **现象**：计划 Task 7 Step 3 的 Run D（并行 3 行 = claude-code + codex + dsh，逐行终止）**一行都没建**。
- **影响**：spec §5.6.7 第 3 项「**三种**终止语义」只完整覆盖 **1 家**（claude-code）；dsh 只拿到按钮文案「关闭运行时」、**未真被终止**；codex 不可达。
- **为什么没执行**：① codex 行**根本建不出来**（模型池空 + 模型必填）；② **agent 启动额度护栏 9/9 已用满**（Run A 2 + Run B 3 + Run C 2+2）⇒ 再建 Run D 会突破护栏。**控制方裁决：本轮不补跑。**
- **证据路径**：`evidence/06-adapters.md` 头部与第 3 项；`evidence/guards.md`（护栏 9 次 agent 启动）；两批报告的计数表。
- **若后续要补，最小范围是什么**：**只补 dsh 的真实终止一条** —— 建一个 **1 行**（dsh + anthropic 模型）的 run，起跑后点卡片上的「关闭运行时」，断言 ① 该行 `status === 'canceled'` 且 `events.jsonl` 尾部有 `end.exitReason === 'canceled'`；② 运行期闭包差集里的 dsh 子进程 `close()` 阶梯后全部消失；③ 该行的按钮文案与 claude-code 不同（已实测 ✅，只需复核）。**codex 一行不要补**——它需要先有一个可达的 Responses 网关（见 A6），那属于换环境不是补跑。
- **归属**：**[设计取舍]**（额度护栏是有意的；控制方已裁决不补跑）。**责任方：额度恢复后由控制方派单（最小范围如上）。**

**A9. `pnpm test` 满载超时噪声 + 根 `pnpm test` 的形状偏差**

- **现象**：改前 `Test Files 3 failed | 98 passed (101)` / `Tests 3 failed | 1106 passed (1109)`；改后 `4 failed | 97 passed` / `4 failed | 1105 passed`；两轮失败**全部是 vitest 超时**（`Test timed out in 5000/20000/60000ms`），**无一例断言失败**。改前 3 条与改后 4 条里**有 3 条逐字同名**（ui `provider-form-modal.test.tsx:195`、core `workspace.test.ts:160`、web-next `route-run-artifacts.test.ts:158`），差异只有第 4 条（api `cases.test.ts:202` 改前通过、改后 65724ms 超时）。**形状偏差**：根 `pnpm test` **不是**每包一行 `RUN v4.1.11 <包路径>`，而是根上一次性 `RUN v4.1.11 D:/zhanglei1120/Github/ai-result-evaluation` + 一条总计行 ⇒ 根 `test` 脚本是 `vitest run --passWithNoTests` 在**根上单跑**，不是 `-r`。
- **影响**：全量红是**已知噪声**，不是回归信号；但它会让人误判（本会话差点把「api 那条新红」当成 R31 引入的缺陷）。
- **证据路径**：`evidence/step5-test-{before,after}.txt`（+ `.raw`）、`evidence/step5-test-after.utf8.txt`（after 日志的中文被按 GBK 写坏成 mojibake，已用「GBK 取字节 → UTF-8 解」修复并另存）、`evidence/step5-test-isolated-reruns.txt(+.1–.4)`。
- **隔离复跑实测**：ui `14 passed (14)` / 17.87s、core `13 passed (13)` / 35.40s、web-next `9 passed (9)` / 3.59s、api `37 passed (37)` / 100.49s ⇒ **4/4 全绿、退出码 0**。
- **最小修法/后续动作**：① 全量红一律先隔离复跑，且**先确认没有别的代理在跑套件/变异体**（本仓多写者）；② 若要根治，把根 `test` 改成 `pnpm -r test`（每包一次）以降低资源争抢——**属根 `package.json`，本阶段禁改**。③ 已知噪声的结论写进 **R41**。
- **归属**：**[环境坏]**（满载资源争抢）+ **[设计取舍]**（根脚本形状与 `-r` 的取舍）。**责任方：整分支终审**（是否改根脚本）。

**A10. R10 实测复现（改工作区根目录 → 列表 `[]` + 详情 404 + UI「评测不存在」）**

- **现象**：`/settings` →「工作区」把根目录从 `…\workspace` 改成 `…\workspace-alt` → 绿 Alert「工作区可用」；随后 `GET /api/runs` → **200 + `[]`**（3 个已有 run 全部不可见）；`GET /api/runs/4864c217-…` → **404** + `{"error":{"code":"NOT_FOUND","message":"评测不存在：4864c217-…"}}`；界面 `/runs` = 「还没有评测」、`/runs?panel=detail&id=<runAId>` = 「评测不存在或已被删除」。**改回**原根目录 ⇒ 列表恢复 3 行（`部分完成 3 串行 2026-09-26 03:08` / `已完成 3 串行 02:56` / `已完成 2 并行 02:50`）。
- **影响**：用户改了工作区根目录之后，**旧轮次既不在列表里、详情也取不到**（产物明明还在旧根目录下）。属**取巧不取默**。
- **证据路径**：`evidence/r10-runs-list-alt.json`、`evidence/r10-run-detail-alt.json`；`evidence/07-cleanup.md` Step 4 的第 4 条浏览器错误；`evidence/02-providers.md` §5（同一件事在设置侧的读法）。
- **最小修法/后续动作**：补一份「已知根目录索引」落盘物（记录历史根目录位置），或让 `listRuns` 扫多个根；**本阶段不做**（见 §7.B 的 B-R10）。
- **归属**：**[设计取舍]**（控制方已裁决接受局限）。**责任方：后续文档轮 + 若要做则由控制方派单。**

**A11. 计划脚本自身的两处缺陷**

- **① `Test-Path … -and …` 的解析陷阱**：计划 Task 6 Step 1 的原句 `Where-Object { Test-Path "$($_.FullName)\run.json" -and $_.Name -ne $runAId }` 被 PowerShell 解析成 `Test-Path` 的 **`-NewerThan`** 参数缩写，报 `Cannot convert value "4864c217-…" to type "System.DateTime"` ⇒ 轮询拿到 **0 个目录**、读到 `D:\run.json`、**静默错过 Run B 的终止窗口**。**修法**：两边各加括号 `(Test-Path …) -and ($_.Name -ne $runAId)`（已修，`p6-poll-runB.ps1`）。**这条就是文本调用 +1 的直接原因**（见 C1）。
- **② `JUDGE_OUTPUT_CONTRACT` 的「12 字抽查」取到文件头注释**：计划的 `Select-String -Pattern 'JUDGE_OUTPUT_CONTRACT' -Context 0,25` 命中的是 `score.ts` 的**文件头注释行**（第 8 行也提到该标识符），`PostContext[0]` 是注释文本，取前 12 字 = `" *      共用的*"` ⇒ 该断言**恒为 False**，与实现无关。**修法**：改按契约**正文**的字面量抽查（已换等效断言，全 True）。
- **现象/影响**：前者造成一次真实的窗口错失（并直接导致文本调用 +1），后者会造成**假 ❌**（把实现判成没达标）。两者都是**计划文本**的缺陷，不是执行者失误、也不是实现缺陷。
- **证据路径**：`evidence/05-runB.md` §6（①）、`evidence/03-case.md` §5.2（②）。
- **最小修法/后续动作**：回写计划文本（本阶段已把两处都记进本文件；计划文件本身的回填只做「冒烟记录」小节，见 §9）。
- **归属**：**[设计取舍]**（属计划文档缺陷，按控制方裁决登记）。**责任方：整分支终审决定是否回写 p6 计划正文。**

### 7.B 前几阶段累积、必须进关账的项 —— 按阶段收口

**来自 p1 交接 / 设计文档 §11（接口契约 §11 的 R1–R9）**：见 §6.1，**9 条全部有承载计划与落地证据**，无缺口。

**来自 p2 阶段（用例域）**

| 编号 | 项 | 状态与证据 |
|---|---|---|
| B-p2-1 | **仓库外截图**：p2 的 11 张 `task8-*.png` 落在 `D:\zhanglei1120\Github\deepseek-harness\`，**不随仓库入档** | **[设计取舍]** 只影响复核便利，不影响结论。证据：p2 台账记录 |
| B-p2-2 | **`INVALID_QUERY` 的文案对「请求体」不准确**：`apps/web-next/src/server-context.ts` 把 `ZodError` 一律映射成 `INVALID_QUERY` + 「**查询参数**不合法」，但该出口同时承担请求体（`CaseCreateSchema` 等）与 `assertStorable` 的校验失败 | **[设计取舍]** p2 已在前端补字段级提示（纯空白标题/仓库路径不再走到这里）⇒ **可达面只剩直接调 API**；本阶段不改（它是 p1 的共享错误出口，属契约层口径）。最小修法：把「查询参数」与「请求体」的文案分开，是一次小改动 |
| B-p2-3 | **F9 接受现状**（p2 阶段评审判定） | **[设计取舍]** p2 台账已收口，无新增证据 |
| B-p2-4 | **M-N1-route（路由级 payload 守卫，提交 `a6bce56`）由控制方自产、未经独立评审** | **[设计取舍]** 交**整分支终审**独立复核（p2 台账已登记）。 |
| B-p2-5 | **归属不准的历史提交**：`c9a0747` 的提交信息只描述 `errors.ts` 的 N1，但其中还含 T5/T6 修复轮的 4 个文件（**内容逐字节正确**）；孤立的 `b8c21eb` 内容已随 `8fa6da9` 入库 | **[设计取舍]** **不重写历史**（共享分支上改写风险远大于收益）。在此显式说明，供终审与 `finishing-a-development-branch` 的收口报告引用 |
| B-p2-6 | **F9（Nit，接受现状）**：`api` 包整包 `testTimeout: 60_000`（对照 `core` 是 20_000）⇒ 该包的失败会以「60 秒级超时」的形式出现，正是 A9 那类满载噪声的来源 | **[设计取舍]** p2 终判「接受现状」（起因真实；收紧属测试基建优化）。**证据**：`packages/server/api/vitest.config.ts` 的 `testTimeout`（对照 `packages/server/core/vitest.config.ts`）；p2 台账。**本阶段实测的代价已兑现**：api 那条满载 60s 超时、隔离复跑 37/37 绿、100.49s（A9） |
| B-p2-7 | **其余 p2「accept 但不修」的十二条**（逐条无行为缺陷）：`CasesFallback` 的 `margin: 16`；`errorMessage` 的英文兜底（含设置页 3 处重复）；`page.tsx` 的 `calc(100vh - 240px)`（只有注释、无断言）；面板切换状态复位的不变式只有注释断言；`!= null` → `!== undefined` 的变异体未单独跑（决策层已由 `case-panel-state.test.ts` 覆盖 `null`/`undefined` 两输入）；`saveRun` 的 `0o600` 只有注释；`useUpdateCase`/`useValidateRepo` 的 `revalidate:false` 只有 JSDoc；两个面板不做重复提交防护；Task 5 无防抖；Task 6 的 `deleting` 只上在确认按钮；`nav.test.ts` 的 `as string`；`CaseDetailPanel.referencedRuns` 恒 `null`；短哈希歧义措辞（`INVALID_REF`） | **[设计取舍]** 逐条在 p2 `phase-review-report.md` 与 `progress.md` 的 accept 表里给了理由。**其中「半配置下提交的确切 payload 没有运行证据」这一条已由本阶段 Task 4 Step 8c 补上端到端证据**（见 §8 第 20 行 F6） |
| B-p2-8 | **过程性 accept**：两处「当时做不成」的浏览器复核（`localhost:3083` 拒连、不许起替代服务）与「全量套件里含别人的在途文件」 | **[设计取舍]** 前者**已由本阶段补齐**：Task 4 的 8a（控制台无 antd 弃用告警 + 正控注入能抓到）、8b（「重新加载候选」恰好多发一次 POST 且不顺带刷列表）、8c（详情刷新失败仍在编辑表单、输入不丢）——**三项全部 ✅**（`evidence/03-case.md` §6）。后者仍是本仓多写者的固有约束（见 A9 的处置） |
| **B-R13** | **设计文档 §9 第 9 项无法按字面执行**（契约 §11 R13）：用例表单的评分模型是 `Select`（不能自由输入），而 `resolveJudgeRoute` 在调用前就校验「模型在该供应商清单里」⇒「故意配一个不存在的评分模型」只能走**替代路径** | **契约给的替代路径**：往供应商清单**手工加一条网关并不提供的模型**（`source: 'manual'`）→ 用例选中它 → 失败发生在**上游调用**；错误码映射为 401→`AUTH_FAILED` / 429→`RATE_LIMITED` / 其余→`INTERNAL`，该行仍落 `failed` 且消息可读，「一行失败不拖累其它行」照样成立。**本阶段实测：还要再降一级** —— 本机中继对**任意**模型名都回 200 并回落 `deepseek-v4-flash` ⇒ 手工加坏模型**产生不了失败**；改用**指向死端口的供应商**（`http://127.0.0.1:15999`、无进程监听），失败因此发生在上游调用且**零上游成本**。实测：两行 `failed` + `INTERNAL` + `run.status=partial`，row1 不受影响（§3-§9-9）。**证据**：`evidence/05-runB.md` §4.1/§4.3；`evidence/probe.txt` §4（任意模型名都回 200）；契约 §11 的 R13 行。**归属**：**[设计取舍]**（契约已裁决「不改设计文档、差异写进关账」）→ 已在 §3-§9-9 与本行显式登记 |
| **B-R12** | **跨会话命名：`apiKeyMasked` 与 `apiKeyMask`** —— 另一会话的 p1 计划把密钥掩码字段叫 `apiKeyMask`，本分支落地的是 **`apiKeyMasked`**（**用户已裁决保持后者**） | **本阶段实测观察**：HTTP 出口的键名 = `id, createdAt, updatedAt, name, protocolType, baseUrl, models, apiKeyMasked`，带明文 `apiKey` 键的条数 **0**（`evidence/02-providers.md` §6）⇒ 当前形态**只有 `apiKeyMasked`**，没有并存。**规则（照契约 §11 R12）**：若在代码或测试里看到 `apiKeyMask` 与 `apiKeyMasked` **并存，不要去改名对齐**——改名会让 p1 的既有测试大面积变红，属**另一会话的裁决面**；记成一条观察项即可。**证据**：`apps/web-next/src/server-context.ts` 等出口的键名；`evidence/providers-list.body`；契约 §11 的 R12 行。**归属**：**[设计取舍]**（用户已裁决 + 跨会话边界）→ **看到并存也不要改** |

**来自 p3 阶段（agents 域）**

| 编号 | 项 | 状态与证据 |
|---|---|---|
| B-p3-1 | **A3 的契约缺口**：**轮级状态变更无法追加事件** | **现象**：`AgentEvent` 的七个成员**全是行级的**（`status`/`log`/`usage`/`diff-summary`/`score`/`end`/`error`），落盘又按行（`{runId}/rows/{rowId}/events.jsonl`）⇒ 「轮级状态变更」（比如整轮被终止、某轮进入 `partial`）在**唯一真相源里没有位置**。**影响**：只落地了「单一写入点」这一半；轮级事实只能从 `run.json` 快照读，回放 `events.jsonl` **无法独立重建**一轮的完整历史。**证据**：`packages/server/contracts/src/agent-event.ts`（七个成员的 schema）；`packages/server/core/src/event-log.ts`（按行的落盘路径）；p4 台账 `2026-09-22-features-p4-evaluator/progress.md` 的 A3 条目（控制方裁定「接受不实现，把契约缺口登记进 p6 关账」）。**最小修法**：在契约里加一类**轮级**事件（或一条按 run 落盘的 `run-events.jsonl`），写入点与 p4 的 `setRunStatus` 同址。**归属**：**[设计取舍]**（控制方已裁定接受不实现）→ **责任方：后续阶段立项，不进本分支** |
| B-p3-2 | **M3 仍开着**：codex 的 `item.started` 是否带**非空** `text` | **现象**：本环境**无法观测**（codex 未跑到模型调用）。类型面 `AgentMessageItem.text: string` **必填**，而 JSDoc 又写「Typically the item is initially "in progress"」——**两者都不能代替实测**。**证据**：`docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` §2（codex 六条事件原文，`turn.completed` 零条、usage 零条）与 §6 第 2 条；`evidence/06-adapters.md`（codex 无法建行）。**最小修法/后续**：与 A6 一起补（需要一个可达的 Responses 网关），补跑时在 dump 里专门找 `item.started`。**归属**：**[环境坏]**（观测不了）→ 责任方：环境恢复后补 |
| B-p3-3 | **p3 的三条等价变异体**（M8 / M19 / M20，存活但不判缺陷） | **现象**：`M8`（dsh 会话过滤器恒真）、`M19`（`turn/end` 的投影不返回 tokens）、`M20`（去掉「method 必须是 `session.event`」的前置判断）在变异测试中**存活**，但各自都能证明「与不改完全等价」（M8 需要真实多会话 runtime 才能区分；M19 的副作用仍在且 usage 事件已由 draft 发出；M20 两种实现都落到同一个 `unknown(raw)`）。**影响**：无（**不为它们补假用例**——假前提下的守卫是假绿）。**一条后续事实**：M19 此后**不再是等价变异体**——p3 收尾的设计改动之后它**已可杀**（3 条红），即「一次设计改动把一个等价变异体变成了非等价，并当场钉住」。**证据**：`docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` §7.4（逐条理由）；p3 台账的变异表（21 条：18 杀 / 3 等价）与 M19 的后续条目；`packages/server/agents/src/providers/dsh/events.ts`。**归属**：**[设计取舍]**（已逐条给理由并记账）→ 无后续动作 |
| B-p3-4 | **p3 台账登记的其他边界**：dsh 的 `subagent.started`/`subagent.finished` 通知**未触发**（无样本）；dsh 的多轮/工具调用**未覆盖**；本地中继会改写 `model`（事件形状可信、模型身份不代表生产）；`codex-cli 0.154.0`（PATH 上）与 SDK 自带 `@openai/codex 0.156.1`（适配器真正 spawn 的那个）**不是同一个二进制**；三条等价变异体见 B-p3-3 | **证据**：p3 探测报告 §6 第 4/5/6/7 条。**归属**：**[环境坏]/[设计取舍]** 混合，逐条已在 p3 报告里给理由 → 无后续动作（除 dsh 的多轮/工具调用可随「更长的真实跑」顺带覆盖） |
| B-p3-9 | **p3 亲手把「race 先不做」与「p6 必须真机验收 one 条」绑在一起，而那一条 p6 没做** | **原始口径**（p3 台账）：`turn.ts` 的「消费循环 vs 释放信号」race **同意先不做**，但三条前提之一明写「**p6 冒烟加一条真机验收**：CLI 停止输出但进程仍活着 ⇒ 行在有界时间内离开 `running`，且日志出现 `[编排]…可能有残留子进程`」；p3 台账还点名「**这条要进 p6 的计划/关账清单**」。**本阶段实测：没有构造这个场景**（真机跑里出现的 agent 都是正常结束、被终止、或评分阶段失败，没有「CLI 静默但进程活着」那一种）。**影响**：race 的「先不做」这个裁决因此仍然**只有推理与单测**背书。**最小修法/后续**：构造一个「CLI 停止输出但进程不退出」的假 agent（或让真 CLI 挂住），断言行在有界时间内离开 `running`、日志出现上面那句 `[编排]` 警告。**证据**：p3 台账 `2026-09-22-features-p3-agents/progress.md` 的 race 裁决与「要进 p6 清单」那句；`packages/server/agents/src/turn.ts`。**归属**：**[设计取舍]**（race 已裁决先不做）→ 责任方：后续阶段（这条验收需要一条专门的假 agent） |
| B-p3-10 | **p3 L5 状态模糊：重构没做，台账也没收口**（**按树实测倾向「未做」**） | **现象**：p3 修复波**只加了计划行**（计划 Task 12 明写「顺手抽掉第三份 `readTokens`（评审 L5，行为保持重构）」），而**今天树里仍是三份各自独立的定义**：`providers/claude-code/events.ts`、`providers/codex/events.ts`、`providers/dsh/events.ts` 各一份，三处 WARN 文案**逐字相同**。p3 台账在 Task 11/12 之后**再未提 L5**——既没记「已做」也没记「重新开着」。**影响**：纯重复（三份同形函数），无行为缺陷；但「台账说要做、树里没做」是**恢复会话时的误判源**。**最小修法**：抽成一个共享的 `readTokens`（行为保持重构），或由控制方在 p3 台账里明确记为「接受重复、不抽」。**证据**：三个 `events.ts` 的 `readTokens` 定义与各处 WARN 文案；`docs/superpowers/plans/2026-09-22-features-p3-agents.md` 的 Task 12 那一行；p3 台账的 L5 条目。**归属**：**[设计取舍]**（重复本身可接受）+ **台账未收口** → 责任方：整分支终审或控制方 |
| B-p3-11 | **另两处「登记了但没闭合」的小面**：① 夹具选项 `createError` 现在**全仓无任何用例引用**（L1 最小修法里「或删掉这两个选项不留死面」那句留下的死面）；② 一条守卫曾**从未失败过**（删掉夹具的会话归属前置检查 ⇒ 整包 143/143 仍绿）——**这条已闭合**（补了 `testing/agent-fixtures.test.ts`，且**保留**守卫而不是删掉它） | **证据**：`packages/server/agents/src/testing/agent-fixtures.ts`（`createError` 的声明与抛出点、会话归属前置检查）与 `testing/agent-fixtures.test.ts`；p3 台账的 M2 裁决（「补 `agent-fixtures.test.ts`，**不删守卫**」，变异：删夹具那三行 ⇒ 新回归网红）。**归属**：① **[设计取舍]**（死面，删或补用例皆可）② **✅ 已闭环** |
| B-p3-5 | **R35 的残留**：`apps/web-next/src/runtime-deps.test.ts` 只证明「三家**声明在** + **解析得到**」，**不证明** Next 把外置说明符发成 `module` 而不是 `commonjs` | **现象/影响**：若 Next 发了 `commonjs`，运行时仍会撞 `ERR_PACKAGE_PATH_NOT_EXPORTED`。**本阶段真的起了服务、真的跑到了一行 agent**（claude-code 与 dsh 都跑起来了、dsh 还写出了改动）——**没有**出现 `MODULE_NOT_FOUND` 或 `ERR_PACKAGE_PATH_NOT_EXPORTED` ⇒ 这条**在行为上被终局证据推翻（不是证明形态，而是证明结果不炸）**。**但要说清**：本阶段**没有**去读产物里的裸说明符原文，所以「Next 到底发成 `module` 还是 `commonjs`」在**形态上仍未验**。**证据**：`apps/web-next/src/runtime-deps.test.ts`；`evidence/04-runA.md`、`evidence/05-runB.md` §5（dsh 真跑成功）、`evidence/07-cleanup.md` Step 4（`5xx = 0`、无模块解析错误）。**最小修法/后续**：若要把形态钉死，在 `.next/server/chunks/**` 里 grep 三家包名并贴原文（属整分支终审的一次抽样）。**归属**：**[设计取舍]**（结果已验、形态未验，显式声明）→ 责任方：整分支终审 |
| B-p3-6 | **「`usage` 条数 === 轮次数」的真机复核未做** | **现象**：p3 的 usage 去重改动（dsh 的 `usage` 事件由「投影 + 骨架」两条改成**只发一条**）只有**单测面**证据。**本阶段的实测反证**：p3 探测报告 §7.5 记录过「`usage` 出现两次」；本次 Run A 两行的 `events.jsonl` 里 `usage` 事件实测 = row1 **1 条**、row2 **2 条**，而 `turns` = 8 / 16 ⇒ **条数 ≠ 轮次数**（因为 claude-code 的 usage 在 `result` 上只出现一次，与 dsh 的「每轮一条」不是同一口径）。**影响**：这条「复核」的口径本身需要先钉死（是「每轮一条」还是「每次会话一条」因家而异）。**证据**：`evidence/04-runA.md` §3（row1 `usage×1`、row2 `usage×2`，`turns` 8/16）。**最小修法/后续**：把断言改成**按家**的口径（claude-code：一条；dsh：与 `turn/end` 条数相等），并在 dsh 的多轮真实跑上复核。**归属**：**[设计取舍]**（口径未钉死）→ 责任方：后续阶段 |
| B-p3-7 | **`R35`/`R33`/`R37` 的跟随项** | R33：dsh SDK 走 `next` 线（0.1.7-rc.1），dsh CLI 实测 `0.1.5-rc.2`（**版本偏斜**）；R37：`dsh.protocolType` 已改 `anthropic` 且 p5 候选池已跟随（本阶段 `model-options` 实测确认）。**证据**：§6.3 的 R33/R37 行。**归属**：**[设计取舍]**（已显式记账）→ 无后续动作（R33 若上游修好 `latest` 再评估回切） |
| B-p3-8 | **服务重启恢复（`interrupted`）+ 真实 Next 启动钩子的端到端** | **现象**：p4 台账记为「未做（属 p6）」，本阶段**仍未做**（**刻意省成本**：重启会打断会话）。本阶段只验证了启动日志那一行确实在跑：`[INFO] [instrumentation] 服务启动：已完成被中断候选行的恢复 { recovered: 0 }`。**证据**：`evidence/service.json`、`evidence/service-batch2.json` 的 readyLog。**后续**：见 §4 第 3 条。**归属**：**[设计取舍]**（有意跳过）→ 责任方：单独一轮 |

**来自 p4 阶段（evaluator 域）**

| 编号 | 项 | 状态与证据 |
|---|---|---|
| B-p4-1 | **Low-5**：`abortRun` 只把 `pending` 落 `skipped`，上一轮遗留的 `failed`/`interrupted` 排队行保持原状（与设计文档 §5.4 的字面表有偏差） | **控制方裁决：接受登记不改**（p4 台账的原文措辞是「接受登记，**不**改契约签名」；「接受登记不改」这个说法出自分支台账的浓缩版）。理由（p4 台账原文）：评审建议的「补一条 log 事件」在 `abortRun` 内**无法正确划定范围**——只有 `executeRun` 的局部 `planned` 知道**本轮计划**，近似实现会在**唯一真相源**里写下**不成立的话**；「唯一真相源里一句错话」比「少一句话」更坏，而要做对就得动契约 §5 的导出签名 ⇒ 为一条日志改契约**不成比例**。**证据**：`packages/server/evaluator/src/orchestrator.ts`（`abortRun` 里 `if (row.status !== 'pending') continue;` 后才落 `skipped`）；`orchestrator.test.ts` 的 `toEqual(['canceled','failed','skipped'])` 用例；p4 台账 `progress.md` 的 Low-5 裁决、`phase-review-report.md` Low-5 标题、`phase-fix-report.md` 的「登记不改」节 |
| B-p4-2 | **Low-6**：`testing/fixtures.ts` 的 `cleanup` 用 `rmSync`，在 Windows 上偶发 `EPERM`，会把一条本该绿的用例判红（首次全量 `1 failed \| 126 passed`；隔离复跑绿；第二次 `127/127` 绿） | **控制方裁决：接受登记，不加静默重试**（p4 台账原文措辞是「接受登记，**不**加静默重试」，理由是「**静默吞掉会掩盖真正的泄漏**」）。p4 修复报告补了一句更完整的处置口径：那会把真实的临时目录泄漏静默掉（临时目录残留比假红便宜，但**静默**的残留不便宜）⇒ 若再复现，正确处置是「**有界重试一次 + 告警**」，而不是无条件吞。**证据**：`packages/server/evaluator/src/testing/fixtures.ts` 的 `cleanup`；p4 台账与两份报告的对应节 |
| B-p4-3 | **Low-4 是两半**：① 恢复的「不覆盖别人改过的行」只做到一半、JSDoc 把一个未实现的性质写成了事实 —— **已修**（补二次复检 + 守卫 + 变异验证，并入修复波 `fd9328f`）；② **轮级残留**：陈旧的 `listRuns()` 仍会触发**轮级** `partial` 收尾 —— **控制方裁决：不加复检**（行级分数**已受保护**，而此刻落 `partial` **本来就是对的** ⇒ 加二次复检是在防一个**非缺陷**） | **证据**：`orchestrator.ts` 的二次复检与守卫用例；`orchestrator.ts` 里循环入口读陈旧 `listRuns()` 的那段 + `setRunStatus(..., 'partial', …)`；p4 `phase-fix-report.md` 的「残留局限（如实登记）」节 |
| B-p4-4 | **Medium-2**：`testing/fixtures.ts` 把 dsh 仍写成 `openai` ⇒ 两条 dsh 用例**假绿**，且与已按 R37 改过的计划文本不符（**测试保真度 + 计划符合性缺陷，不是生产代码错**） | **已修**（同一修复波 `fd9328f56e91f1dac29dca9b06df6bcf5e1f34c4`，5 文件 +381/−16，覆盖 High-1 + Medium-3 + Medium-2 + Low-4 + Nit-7/8/9——**台账没有给逐项 sha**）。修复后夹具 = `protocolType: kind === 'codex' ? 'openai' : 'anthropic'`，并补了映射断言（变异红出 `expected 'judged' to be 'failed'`）。**证据**：`packages/server/evaluator/src/testing/fixtures.ts`；p4 三份报告的对应节 |
| B-p4-5 | **Medium-3**：`orchestrator.ts` 的 `.finally()` 里裸调 `finalizeRun`，收尾抛错会把该轮**永久锁死**（`runTasks` 永久保留 ⇒ 每次 `startRun` 恒抛 `CONFLICT`「该评测已有候选行在运行」，而实际一行都没在跑），并留下未处理 rejection（生产无人 await ⇒ Node 默认 `--unhandled-rejections=throw` 会终结进程） | **已修**（同一修复波 `fd9328f`：try/catch + 内层 `finally` 清 `runTasks`/`abortedRuns`）。变异红出两条独立后果。**证据**：`orchestrator.ts` 的收尾块；p4 报告对应节 |
| B-p4-6 | **High-1**：在 `preparing` 阶段被终止的行会被复活成 `running` 并**真的启动 agent**（`await` 后无复检 + 无条件 `setRowStatus(...,'running')` ⇒ 快照 `canceled→running`、agent 真跑、第二条 `end`；「点了开始马上点终止」必定命中） | **已修**（同一修复波：`await` 后与启动前各复检 `TERMINAL_ROW_STATUSES`）；**守卫是「先红后修」**（未修实现下假适配器仍被调用 **2 次**）且变异可杀。**证据**：`orchestrator.ts`；p4 `phase-review-report.md` 的 High-1 节 |
| B-p4-7 | **`vi.mock('./run-store')` 注入接缝** | **接受**，但控制方**要求随修复波一起留下**，并在 **p6 关账**与整分支终审里**各出现一次**。**证据**：p4 `phase-fix-report.md` 的接缝说明（默认全量透传 ⇒ 注入的是真实边界上的真实失败） |
| B-p4-8 | **Nit-10**：`PendingRowEvent` 不从包根导出（与契约 §5 一致、与计划 Task 2 字面不一致） | **登记不改**。**证据**：p4 `phase-review-report.md` / `phase-fix-report.md` |
| B-p4-9 | **`eventsPaths` 只增不减**（B1–B3 评审的 L4） | accept 登记、留 T8；**T8 未处理** ⇒ 评审建议「在 p6 或后续顺手清理/登记」。**本阶段登记，不改**。**证据**：`packages/server/evaluator/src/events.ts` 的 `eventsPaths`；p4 报告 |
| B-p4-10 | **`end.exitReason='interrupted'` 是新增取值，契约 §2.6 未枚举** | **finding（Low，文档）**：建议写进关账或契约注记（**不改代码**）。**本文件即该落点**。**证据**：p4 `phase-review-report.md` |
| B-p4-11 | **p4 报告里另有 13 条 accept 登记项 + 12 条「无法验证」** | 逐条在 p4 `phase-review-report.md`（§10.1–§10.6、未做 2/3/4、R10 不跨重启）与 `phase-fix-report.md`（5 条无法验证、未跑 `pnpm build`/api 套件/全仓 `pnpm test`）。**归属**：**[设计取舍]**（逐条已给理由）→ 交整分支终审；其中「R10 不跨重启」与「`interrupted` 无真机」已在本文件 §4/§7 单列 |
| B-p4-12 | **p4 台账里也留着一行过期的开工状态** | **现象**：`2026-09-22-features-p4-evaluator/progress.md` 的 `- 尚未开工（等 p3）。` 未被删除（文件其余部分已完整维护）。**影响**：与 p5 台账同一类缺陷——**恢复会话时按台账判断进度会误判**。**证据**：该文件；p5 的同类问题见 B-p5-6。**最小修法**：删掉那一行或改成「已完成（见 §…）」。**归属**：**[设计取舍]**（控制方维护的账本，实现者无权改）→ 责任方：控制方 |

**来自 p5 阶段（评测域）**

| 编号 | 项 | 状态与证据 |
|---|---|---|
| B-p5-1 | **L4（dev-only）**：dev（Turbopack）重编译会**重建服务端模块图** ⇒ 模块级状态（`subscribers`/`runRoots`/`eventsPaths`）**换代**，**已经建立**的长连接被孤立在新的总线之外 | **判定：成立，且仅 dev**；prod 无此现象（评审在 dev 与 prod 各自用模块实例探针实测：dev 重编译后 id 变、prod 两条路由共用同一 chunk）。**关键限定（不能省）**：把这两处锚到 `globalThis` 能修 **L4**，但**修不好 C1**——C1 的真根因是「api 发具名事件、client 只绑 `onmessage`」，与 Map 的身份无关；修完 L4，抽屉**依然一行不涨**。**控制方裁决：L4/F4/N1 只登记不修。** **证据**：`packages/server/evaluator/src/events.ts:35`（`eventsPaths`）与 `:37`（`subscribers`）、`packages/server/evaluator/src/run-root-memory.ts:32`；p5 `phase-review-report.md` 的 L4 节与 §3.4；p5 `phase-fix-report.md` 的「登记」节；契约 **R38 ④** 已把这条限制写成已知限制。**归属**：**[设计取舍]**（dev-only、已写进契约）→ 后续若要加固，最小改法是 `globalThis.__aievalBus ??= …` |
| B-p5-2 | **F4**：`events.jsonl` 的追加读是 **O(n²)** 重放（`appendEvent` 每次追加都整文件回读定 seq，即 R17 已登记的取舍） | **现象**：真实跑一轮 **6913 条 / 2,122,167 字节**，后段明显变慢（同一秒内事件数从个位数掉到需要跨秒），期间并发的 `GET /api/runs/<id>` 出现过一次 **~1.9s** 响应；本阶段 Run A 的 row2 达到 **22184 条**事件。**判定：成立但可接受**（改动落在 `core` 的写路径、收益只在超长日志上）。**复测阈值（写进关账）**：**单行 `events.jsonl` > 5 MB 或 > 2 万条**时复测一次。**⚠️ 与 R24 的「静默原始最大 seq 扫描」是两件事**——那是**正确性**口径，别当成性能问题一起改掉。**证据**：`packages/server/core/src/event-log.ts` 的 `appendEvent`（每次追加整文件回读定 seq）；`docs/superpowers/notes/2026-09-22-features-p5-smoke.md` 的观察 F4；`evidence/04-runA.md` §3 的事件计数。**归属**：**[设计取舍]**（已给阈值）→ 达到阈值时复测 |
| B-p5-3 | **N1**：`packages/server/api/src/run-artifacts.test.ts` 第 2 条用例遗留的 `collectDiff.mockReturnValue` 已不再承重（B2 自己登记） | **登记，下次动该文件时删**（本轮未动该文件）。**注意**：p5 里有两个「N1」——评审 Nit 的 N1（本条）与 `task-2-3-report.md` 里一个**变异体编号** N1（`toFrame` 去掉 `id:` 行），引用时须写明出处。**证据**：`run-artifacts.test.ts` 的第 2 条用例与其后的 `beforeEach` 默认实现；p5 `phase-review-report.md` / `phase-fix-report.md`。**归属**：**[设计取舍]** → 下次动该文件时顺手删 |
| B-p5-4 | **F3-①**：`connected` 徽标在「连接已建立但还没吐第一个字节」时显示「未连接」（最长约 15 秒） | **已修**：`start()` 先发一条 `: ready` 注释帧（`run-stream.ts`），**打开即有首字节**（真机 curl 实测 `9 bytes received` = `: ready\n\n`）；变异「删掉那一行」红 5 条。**证据**：`packages/server/api/src/run-stream.ts` 与 `run-stream.test.ts` 的「打开即有首字节」用例；p5 `phase-fix-report.md` §5.1 |
| B-p5-5 | **F3-②**：抽屉关掉后 `connected` 不复位 | **评审已证伪，不改**：`enabled` 在依赖数组里 ⇒ React 先跑上一次 effect 的 cleanup（`stop()` ⇒ `source.close()` + `setConnected(false)`）再执行提前 return；B6 的原话只看到 early return、漏了 cleanup。**但**：**未做浏览器实测**（要构造「先连上再关抽屉」再读 React 状态，性价比低）。若要机械守卫，最小改法是把 `setConnected(false)` 显式写在提前 return 之前。**证据**：`packages/client/client/src/row-stream.ts` 的 `stop()` 与依赖数组；p5 `phase-review-report.md` 的 L2 节 |
| B-p5-6 | **p5 台账 `progress.md` 仍停在「尚未开工（等 p4）」** | **现象**：31 行，`进度` 一节只说工作区/11 份 brief/preflight scan 就绪，**没有任何** 11 任务 / 19 提交的记录；`BASE：待定`、头部还写「p4 已就绪待开工」。**影响**：台账是**恢复会话的第一入口** ⇒ 失真会让控制方误判进度、重派已完成的任务（这正是 SDD 最贵的失败模式）。**证据**：`2026-09-22-features-p5-runs/progress.md`；p5 `phase-review-report.md` 的 finding、`phase-fix-report.md` 的「未动（不在本波允许改的路径内）」。**最小修法**：控制方在关账时把它更新到「11/11 交付 + 各报告」**或**明确宣布「p5 的台账以六份任务报告为准，`progress.md` 弃用」。**控制方已认领**（「由控制方在关账时更新或宣布弃用」）——**截至本文件写就仍未更新**。**归属**：**[设计取舍]**（账本是控制方维护物）→ 责任方：控制方。**同类问题**：B-p4-12 |
| B-p5-7 | **p5 修复波的另一条传播教训**：变异脚本**两次打印 `RESTORED-OK` 而改动其实丢了** | **现象**：`log-drawer-state.ts` 少一整个分支、`page.tsx` 少一行参数，脚本却报还原成功。**已改成**：还原后**回读校验（`Buffer.equals`）+ 失败即 `exit 2`**，此后全部 `BYTES-EQUAL true`。**这是本阶段必须传下去的硬约束**（p6 与整分支终审的变异脚本一律照此做）：**光打印成功不算还原，要回读字节并断言**。**证据**：p5 `phase-fix-report.md`；脚本在 `%TEMP%\mut-run2.mjs` |
| B-p5-8 | **真实的终止语义只覆盖 claude-code 一家；`canceled` 证据只有 1 条** | 见 A8。**证据**：`evidence/06-adapters.md` 最后一段 |
| B-p5-9 | **评审自己的 11 条「无法验证」**（真实 agent 完整一轮未独立重跑、B6 探针原始写法无法核对、真实 codex/dsh 未跑、F3-② 无浏览器实测、`e7714d3` 当时 lint 红无法回放、未在 Firefox/Safari 复核命名事件语义、未跑全仓 `pnpm test`、真机第 3 条手工断网重连未做、全仓 `pnpm test` 未做、终态是「该行失败」而非 `end`） | 逐条在 p5 `phase-review-report.md` §7 与 `phase-fix-report.md` 的对应节。**其中「终态不是 `end`」已在 §4 第 7 条单列**；「手工断网重连」由真实 HTTP + 真实 `EventSource` 的端到端守卫覆盖。「未跑全仓 `pnpm test`」已由**本阶段**补上（A9）。**归属**：**[设计取舍]** → 交整分支终审 |
| B-p5-10 | **过程事故（已闭环）**：`run-detail-panel.tsx` 曾因变异命令被外部超时强杀而留成截断的 100 行，事后逐字重建并全部变异重跑 | **硬教训**：单条命令**不得**被外部超时强杀 ⇒ 一律用 `pnpm exec vitest run <单个文件>`（约 7s），**不要**用 `pnpm --filter <pkg> test -- <file>`（vitest 会把 `--` 当测试名过滤符 ⇒ 收集整包约 40s）。**验证**：控制方独立核验提交内该文件 = 237 行且结构完整、`git grep` 无 `if (false)`/`MUTANT`/`mutbak` 残留、独立复跑 ui = 241 例 exit 0。**归属**：**[设计取舍]**（已闭环）→ 无后续动作 |
| B-p5-11 | **两处有意偏离/接受的实现细节**：① `vitest.config.ts` 的 alias 方案**接受**（不改成 devDependency——要动 lock、且会把运行时可解析的 `web-next → evaluator` 边装进应用）⇒ 已加 `AGENT.md` 脚注；② N4/N4c 两条**变异存活**（`afterSeq` 在两处互为冗余）⇒ accept 并记录理由 | **证据**：p5 `phase-review-report.md` 的 alias 节与 N4 节；`AGENT.md` 的脚注（提交 `445c4f0`）。**归属**：**[设计取舍]** |

### 7.C 本阶段的过程合规与记账（控制方的三条裁决）

**C1. 文本调用 9/8（+1）—— 按实记账，不追责**

- **口径**：按「**触达模型**的调用」计：2（序 0 存活探针）+ 1（AI 生成评分提示词）+ 2（Run A 两行评分）+ 3（Run B 三行评分）+ 1（Run C 第一次开始的 row1 评分）= **9**，**超出计划字面的 8 一次**。
- **原因链（写清，不追责）**：计划把 Run B 的**总**文本调用预算写作 3（第一次 1 + 第二次 2），实际分布是「**3 次全在第一次、全部成功**」，第二次的 2 次由 **Run C 重启**承担，且那两次是**连接被拒、未触达任何模型（零上游成本）**。Run B 三行全跑到 `judged` 的直接原因是**终止用的轮询脚本踩了计划原文里的 `Test-Path … -and …` 解析陷阱**（被解析成 `-NewerThan`），错过了终止窗口（见 A11①）。
- ⇒ **这 +1 归因于计划脚本缺陷，不是执行者失误**；其中 **2 次是连接被拒、零上游成本**。
- **计划外调用**：批 1 的 **~23 次**计划外诊断性调用**按原样记账**（模型名接受面 6 次 + `max_tokens` 阈值定位 3 次 + 一次脚本编码问题误发的 4 次空模型名请求（422，未产生输出 token）+ 起点与形状确认若干次；全部 `max_tokens ≤ 4096` 单轮小请求，**无 agent 启动、无评测轮次、未用于「重跑换通过」**）；本批**新增计划外真实调用 0 次**。
- **其他额度**：agent 启动 **9/9**（零复跑）、评测轮次 **4/4**（Run A、Run B、Run C 第一次、Run C 第二次）。
- **证据**：`evidence/guards.md`（护栏表 + 白名单 + 本环境偏差）、`evidence/probe.txt`、`evidence/step2-env-vars.txt`、两批报告的计数表（`.superpowers/sdd/2026-09-22-features-p6-smoke/task-3-8-report.md` §①）。
- **归属**：**[设计取舍]**（护栏口径 + 计划脚本缺陷）→ 无后续动作（已按裁决记账）。

**C2. Run D 本轮不补跑，登记为未执行**

- **理由**：① **codex 行根本建不出来**（`options=[]` + 模型必填）；② **agent 启动额度护栏已用满（9/9）**。
- **登记的未执行范围**：spec §5.6.7 第 3 项「三种终止语义」只完整覆盖 claude-code 一家；dsh 只拿到文案；codex 不可达。
- **若后续要补，最小范围**：**只补 dsh 的真实终止一条**（1 行 run + 点「关闭运行时」+ 三条断言），全文见 **A8**。
- **证据**：A8 的证据路径；`evidence/06-adapters.md` 头部与第 3 项。
- **归属**：**[设计取舍]**（额度护栏是有意的）→ 责任方：额度/环境恢复后由控制方派单。

**C3. 执行者对「不要碰 `packages/server/**`」的解释 —— 成立**

- **规则的本意**：该规则禁的是**改动已交付产物**（在共享索引上留下与交付不符的字节），**不是**禁止计划**自己要求**的瞬时变异体验证。
- **实际发生的事（唯一一次）**：为执行计划 Task 7 Step 1 明写的「非空转证明（**必做**）」，在 `providers/claude-code/index.ts` 的注入函数后临时加了一行
  `process.env.ANTHROPIC_BASE_URL = input.route.baseUrl;`，让「凭据隔离」守卫从**绿**变**红**（1 failed，差异行 = 该变量），随后**逐字节还原**。
- **双证**：① `git hash-object` 还原后 = `188a6dc224b174a7cbd68e616fa9a17231113f8e`，与改前**逐字符相同**；② `git diff --stat -- packages/server/agents/src` **0 行**、`git status --porcelain -- packages/server/agents/src` **0 行**；再跑同一条测试回到 **2 passed / 退出码 0**。批 2 收工时又复核过一次「仓库 HEAD = `9820457`（= 批 1 的提交）、本批**零提交**、`git status` 只有别人那一行未跟踪文件」。
- **控制方裁决**：**解释成立**（禁的是改动已交付产物，不是计划自己要求、且已逐字节还原 + 哈希与 `git status` 双证的瞬时变异体）。
- **证据**：`evidence/06-adapters.md` 第 1 项（四步变异验证表）、`evidence/step7-guard-{before,mutated,restored}.txt`、`evidence/mut-backup-claude-index.ts`（变异前的逐字节备份）、`evidence/07-cleanup.md` Step 5。
- **归属**：**[设计取舍]**（规则解释 + 双证）→ 无后续动作。**注**：本结论只覆盖这一次变异；后续任何对 `packages/**` 的写入仍须逐次显式记账并留双证。

---

## 8. 本次关账后**仍开着**的事（按影响排序）

| # | 还开着的事 | 类别 | 为什么还开着 | 下一步（谁 / 什么条件） |
|---|---|---|---|---|
| **1** | **claude-code 适配器在评测运行里拿不到写权限**（A1）⇒ 这一家在评测里永远 0 改动、评分永远在「无改动」输入上打 | **[实现问题]** | 本阶段明令不改 `packages/**`；且它需要「`permissionMode: 'acceptEdits'` + `cwd` realpath 归一」**两条一起**做 | 单独一批修复（`packages/server/agents/**`）+ 修后补一条「claude-code 行必须有非零改动」的真机跑；**修了它才可能覆盖行级 `end` 事件** |
| **2** | **终止 claude-code 行泄漏 14 次 `unhandledRejection`**（A2） | **[实现问题]** | 同上（`packages/**` 禁改） | 与第 1 条同一批修复（挂 `.catch`） |
| **3** | **openai 协议整条不可达 + codex 无任何可达网关**（A6）⇒ spec §9 第 1 项的判定口径已收窄（R39），Run D 只剩 claude-code + dsh，`M3`、codex 的 usage 字段名、R35 的形态都因此没有真机证据 | **[环境坏]** | 本机唯一可达网关只讲 Anthropic Messages | 需要一个可达的 **OpenAI Responses** 网关；届时只重跑 p3 `--kind=codex` 与 Run D（A8 的最小范围） |
| **4** | **Run D 整体未执行**（A8，含 dsh 的真实终止） | **[设计取舍]** | 额度 9/9 用满 + codex 无法建行；控制方裁决本轮不补跑 | 额度恢复后按 A8 的最小范围补（只补 dsh 一条 + codex 一行不补） |
| **5** | **行级时间戳缺失 + 行级计量跑动期恒 `null`**（A4/A5）⇒「计量实时跳动」这条用户可见体验**不存在** | **[设计取舍]**（含计划口径错） | 契约不加字段是刻意的（R40）；要做真实时得让 p4 在运行期回写行快照，属新需求 | 整分支终审裁定：要么改契约 + p4 写侧（新需求，不进本分支），要么把该断言从计划里删掉 |
| **6** | **`callTextApi` 失败文案带英文原文、不含模型名**（A3） | **[实现问题]** | 本阶段禁改 `packages/**` | 随第 1/2 条之后的文案轮（`packages/server/evaluator/**`） |
| **7** | **A3 的契约缺口：轮级状态变更无法追加事件**（B-p3-1）⇒ `events.jsonl` 无法独立重建一轮的完整历史 | **[设计取舍]** | 控制方已裁定「接受不实现」 | 后续阶段立项（契约加轮级事件或按 run 落盘），不进本分支 |
| **8** | **R10：改过工作区根目录的旧轮次不可见**（A10 实测复现） | **[设计取舍]** | 「已知根目录索引」是新落盘物（新增文件 + 写入点 + 迁移口径），而这是单机单用户工具的边缘场景 | 后续立项；在那之前界面照旧显示 `workspaceBase`，并在 README 里显式写明 |
| **9** | **`events.jsonl` 追加读 O(n²)**（B-p5-2）：本次真机已达 22184 条/行 | **[设计取舍]** | 改动落在 `core` 的写路径、收益只在超长日志上；且与 R24 的正确性口径耦合 | **复测阈值：单行 > 5 MB 或 > 2 万条**时复测一次（本阶段 row2 已 22184 条 ⇒ **阈值已擦边，下次真机跑请一并量**） |
| **10** | **`M3`：codex 的 `item.started` 是否带非空 `text`**（B-p3-2） | **[环境坏]** | 本环境观测不到（未跑到模型调用）；类型面与 JSDoc 互相矛盾 | 与第 3 条同时（需要 Responses 网关） |
| **11** | **R35 的形态未验**：Next 把外置说明符发成 `module` 还是 `commonjs`（B-p3-5） | **[设计取舍]** | 结果已验（真跑不炸），形态未验 | 整分支终审在 `.next/server/chunks/**` 里 grep 三家包名并贴原文 |
| **12** | **「`usage` 条数 === 轮次数」的口径未钉死**（B-p3-6）：实测 row1 `usage×1`（turns 8）、row2 `usage×2`（turns 16）——按家而异 | **[设计取舍]** | 断言口径本身要先按家钉死 | 后续阶段改成「按家」的口径，并在 dsh 的多轮真实跑上复核 |
| **13** | **无行级 `end` 事件的真实覆盖**（§4 第 7 条） | **[环境坏]** | 需要一条**能产出改动**的真实跑 ⇒ 被第 1 条挡住 | 随第 1 条的修复一起补 |
| **14** | **服务重启恢复（`interrupted`）无真机验证**（B-p3-8） | **[设计取舍]** | 刻意省成本（重启会打断会话） | 单独一轮：「起服务 → 造在途行 → 强杀 dev → 重启 → 读 `run.json`」 |
| **15** | **prod 模式下的完整冒烟未做**（§4 第 5 条） | **[设计取舍]** | 需要一次完整构建；p5 只做了 C1 条目的 dev/prod 验收 | 与整分支终审的 `pnpm build` 合并做抽样 |
| **16** | **p4/p5 台账的过期行**（B-p4-12、B-p5-6）：两份 `progress.md` 里仍留着「尚未开工（等 p3/p4）」，p5 台账完全没有 11 任务的记录 | **[设计取舍]** | 账本是控制方维护物，实现者无权改（p5 台账不在修复波允许改的路径内） | 控制方在关账时更新，或明确宣布以任务报告为准、`progress.md` 弃用 |
| **17** | **`a6bce56`（p2 的路由级 payload 守卫）由控制方自产、未经独立评审**（B-p2-4）；`c9a0747` 的提交归属不准（B-p2-5） | **[设计取舍]** | 不重写历史；归属问题只记账 | 整分支终审独立复核 `a6bce56`；收口报告引用 B-p2-5 |
| **18** | **已接受、不修的界面弱点 4 条**（分隔条方向/窄窗口右栏不让位/双击不复位/矮窗口页面溢出 25px，§4 第 10 条）与 **R12 的跨会话命名**（`apiKeyMasked` 与 `apiKeyMask`，**看到并存也不要改**） | **[设计取舍]** | 已逐条给理由并记账（用户已裁决保持 `apiKeyMasked`） | **本期不修、不要顺手改掉** |
| **19** | **`INVALID_QUERY` 的文案对请求体不准确**（B-p2-2）与**仓库外截图**（B-p2-1） | **[设计取舍]** | 前者可达面只剩直接调 API；后者只影响复核便利 | 后续一次小改动 / 文档声明 |
| **20** | **F6 的读码论证**：p2 的 `stale` 分支此前**只有读码论证**，本阶段在 Task 4 Step 8c 拿到了它**唯一的端到端证据**（`case-detail-stale` + 标题仍以 `-SMOKE-STALE` 结尾 + 无「用例不存在」） | ✅ **已闭环** | 触发动作实测：合成 `focus` 与 `page.bringToFront()` **都不触发**重取，改用**网络重连（online）**事件 | 无后续动作（本条列出是为了显式关闭 F6） |

---

## 9. 计划的「冒烟记录」回填与收尾

- 本文件的 §1/§2/§3/§4 与 `docs/superpowers/plans/2026-09-22-features-p6-smoke.md` 文末「## 冒烟记录（执行期回填）」那张表**一一对应**；
  表中每个占位标记都已替换成「实测判定 + 关键实测值 + 证据文件」，回填后计划文件里的占位标记计数为 **0**（守卫命令与负控见下）。
- **回填守卫（计划 Task 10 Step 6）**：占位标记用**字符码**拼出（`[char]0xFF08 + '未执行' + [char]0xFF09`，避免命令自己的文本命中），
  `Select-String -SimpleMatch` 计数必须为 **0**；**负控**：临时加一行带该标记的假行 ⇒ 必须报 1 ⇒ 删掉 ⇒ 回到 0。
- **本阶段入库提交**（全部用 pathspec 形式 `git commit -F <消息文件> -- <路径>`）：
  - `9820457` `feat(web-next): 应用级 antd locale 设为中文（契约 R31）` —— 路径 `apps/web-next/app/providers.tsx`
  - `5d3358c` `docs(readme): 增补使用手册（从零到出分、常见错误表、落盘位置）` —— 路径 `README.md`
  - `938ce8d` `docs: 功能阶段关账（12 项冒烟证据、spec 12 节覆盖矩阵、修正汇总与未做项）` —— 路径 `docs/superpowers/notes/2026-09-22-features-smoke.md` + `docs/superpowers/plans/2026-09-22-features-p6-smoke.md`
  - 三枚提交的每个路径都用 `git rev-parse <sha>:<path>` == `git hash-object <path>` 逐个比对为 **逐字节相同**；提交后 `git status --porcelain` 只剩另一会话未跟踪的 `docs/superpowers/plans/2026-09-22-features-p1-contracts.md`（**未动**）。
- **未随仓库入档的产物**：`$smokeRoot\evidence\**`（**72 份**，含 Task 9 的 `manual-guard.txt` 与 Task 10 的 `plan-backfill-guard.txt`）、p2 的 11 张 `task8-*.png`（在 `deepseek-harness` 目录下）。
  本文件的每条判定都指向上面的具体文件；复核时若需要原始证据，请向使用者索取 `$smokeRoot`（临时目录，**不入库**）。
- **⚠️ 长期留存位置已变更**（2026-09-26 修复批补记）：`$smokeRoot` 是临时目录，**一被清理就只剩本文件里的文件名**。
  故把其中**承重的文本证据**复制到了**仓库外**的长期目录：**`%USERPROFILE%\aieval-p6-evidence\`**
  （即 `C:\Users\zhanglei1120\aieval-p6-evidence\`，**18 份 / ~100 KB**，证据本身**不入库**）：
  `evidence/*.md` **7 份**（`00-baseline` … `07-cleanup`）+ **两份回填守卫**（`manual-guard.txt`、`plan-backfill-guard.txt`）
  + **三份 R31 守卫**（`step7-guard-before/mutated/restored.txt`）+ 两份 host env 快照 + 两份进程快照 + `cwd-changes.txt`。
  清单、逐份字节数与 SHA256 见同目录的 **`COPY-MANIFEST.txt`**。
  **刻意未复制**：`step5-test-before.txt` / `step5-test-after.txt` 及其 `.raw`/`.utf8` 变体——单份约 **400 KB** 的全量测试日志，
  与「文本证据」体量不成比例；它们仍只在 `$smokeRoot\evidence\` 下，复核「全量红全是超时」那两条结论时请向使用者索取 `$smokeRoot`。

## 10. 勘误（2026-09-26 整分支终审后；**原文一字未改，勘误在此集中**）

> 手法沿用 `docs/superpowers/notes/2026-09-22-features-p5-smoke.md` §2 的勘误段：**已入库的证据段落与实测数字一律不改写**，
> 被推翻的陈述在这里逐条列明它错在哪、谁推翻的、以及正确的读法。
> 出处：**`.superpowers/sdd/branch-final-review.md`（整分支终审，161 提交 / 落点 §2-M6 与 §5–§8）**。
> 本节的每一条都可在该报告的对应小节里逐字核对。

### 10.1 被推翻的陈述（终审点名 4 条 + 本次复核补记的提交清单 1 条 = **5 条**）

| # | 原文（行号 + 原话） | 实际情况 | 出处 |
|---|---|---|---|
| ① | `:194`（§4 第 7 条）与 `:534`（§8 第 13 条）：「p5 冒烟与 p6 的真机终态都是『该行失败』，**不是 `end` 事件**」 | **被同一份记录直接推翻**：`:126`（§9-5）写「两行都首 seq=1、严格递增、**末条 `end` + `exitReason=completed`**」，`:138`（§9-7）写 row2 `seq 86 end.exitReason:canceled`、row3 `end.exitReason:skipped`。沙箱原始产物确认：`row 9019625a` 的 `events.jsonl` 共 **739 行**，**最后一行**是 `{"seq":739,…,"type":"end","exitReason":"completed"}`。**归因**：那句话原本只是 **p5 修复波**那一轮真机跑的事实（`.superpowers/sdd/2026-09-22-features-p5-runs/phase-fix-report.md` §8.1 第 6 条：「真实跑只覆盖 claude-code，而且**没有产出改动** ⇒ 该行判失败，终态是『失败』而不是『结束』」），被误搬成了「p5 与 p6」的共同结论。**正确读法**：p6 的 8 行里**有** `end`（且 7 行 claude-code 的 `end.exitReason` 是 `completed`）；缺的是「有一条**成功产出改动**的行级 `end`」——那要等 A1 修好写权限才可能（见 §7.A A1 与本次修复批的 H1 真机验收）。 |
| ② | `:482`（B-p5-9）：「评审自己的 **11 条**『无法验证』，逐条在 p5 `phase-review-report.md` §7」 | 两份文件都对不上：p5 `phase-review-report.md` **§7（`:334-342`）只有 7 条**，且**没有一条**是「终态是该行失败而非 `end`」；那句短语全仓 grep **只命中本文件自己**。**正确出处**：那 11 条散在 `phase-review-report.md` §7（7 条）与 `phase-fix-report.md` §8.1（6 条，其中第 6 条才是「终态是失败而不是结束」）；清单里「未跑全仓 `pnpm test`」在两处**各出现一次**（是同一件事，不是两件）。 |
| ③ | `:50`、`:163-164` 引用 `evidence/cwd-row-workspaces.txt`；`.superpowers/sdd/2026-09-22-features-p6-smoke/task-3-8-report.md:207-208` 引用 `proc-baseline-runC.json` / `proc-after-abortRunC.json` / `proc-after-runC-restart.json` | **四个文件都不存在**（本次逐名 `Test-Path` 复核：四个全是 `False`）。沙箱证据目录**仍在**且份数吻合（**72 份**）⇒ 是**清单虚列 / 从未落盘**，不是被删。同批 5 个 `proc-*` 实际只剩 2 个（`proc-before-abortRunA.json`、`proc-running-runC-restart.json`）。**正确读法**：`:50` / `:163-164` 的判定由**仍在**的 `evidence/06-adapters.md` 第 2 项与 `evidence/cwd-changes.txt` 支持（这两个文件确实存在）；被引用的两份进程快照不在，进程结论只能引 RunA 的那两份。 |
| ④ | `:327` 与 `evidence/04-runA.md:93`：「`row 9019625a` 的 `events.jsonl` 里出现 **23 次** `permission_denied`」 | 终审实测该行 **5 次**；8 行合计 **66 次**（最多的是 RunA row2 `a45cafa2` 的 **47 次**）。「23」既不等于那一行的计数，也不等于任何单行或合计。**这一条只错在数字**：同一段引的 `decision_reason` 原文与 CLI 自述**逐字可核**（`04-runA.md:96-109`），A1 的归因（8.3 短名 `ZHANGL~1` 触发 CLI 的路径安全门）**成立**——本次修复批的 H1 已按它修掉并真机复验（见 `.superpowers/sdd/branch-fix-report.md`）。 |
| ⑤ | `:7-8` 与 `:551-554`：「本阶段入库提交 **3 枚**」（`9820457` / `5d3358c` / `938ce8d`） | **清单过期**：HEAD 在这三枚之后**还有两枚只改本关账记录的提交**——`eaf8090`（关账记录修正沙箱证据份数与提交清单）与 `54a6da7`（关账记录补 B-R12/B-R13 两行并统一交叉引用）。记录自身没有登记它们。**正确清单（5 枚）**：`9820457`、`5d3358c`、`938ce8d`、`eaf8090`、`54a6da7`。 |

### 10.2 Nit 级小偏（两处，如实登记）

1. `:44`（§0 的 dsh 行）说「**四处**非零相等」，随后**列了 5 项**（CLI `porcelain` / `numstat` / `run.json` / `events.jsonl` 的 `diff-summary` / 界面文案）⇒ 数字应为 **5**。
2. `usage:false→true` 的行号记为 `dsh/index.ts:170`，实际是 **`:174`**；p3 探测报告 §7.2 把 dsh 的 `EXPECTED_METADATA` 标为 `registry.test.ts:24-29`，实际是 **`:36-39`**（`:24-29` 是 claude-code 的那一份）。

### 10.3 未被推翻的部分（终审独立复核确认，**这份记录仍然可信**）

终审逐项复核后写明：沙箱证据目录仍在且份数吻合；`run.json` 里两行各 5 维 × 1 分、`totalScore: 20`
（与 `contracts/src/score.ts:62-66` 的 `round(5/25×100)` 一致）；卡片数字可逐项复算（`25,734+1,654=27,388` / turns 8 / `26465`；
`4,408+11,032=15,440` / turns 16 / `833361`）；dsh 行的 `+4 −0` 在 **4 处互相印证**；
「全量红全是超时、零断言失败」在原始日志上成立；`~/.aieval` 隔离由哨兵回环证明且读写同源。
⇒ **结论是「这份记录可信但需要勘误」，不是「这份记录不可信」**。本次只加本节，**不改写任何证据段落**。

### 10.4 两条新登记的台账缺口（终审只读事实核查发现，2026-09-26 修复批照实收口）

| 编号 | 是什么 | 树里的实测事实 | 状态 |
|---|---|---|---|
| **B-p3-9** | p3 裁决「race 先不做」时**明写「p6 要加一条真机验收」**（缺的正是「**CLI 停止输出但进程活着**」那个形状：适配器不响应停止信号、只能靠外层兜底） | **p6 没做**：p6 的全部真机跑（3 个 run / 8 行）里没有一条构造出「CLI 仍在、事件流已停」的形状；Run D 的逐行终止**自认未执行**（`07-cleanup.md` 与 §8 第 3 条）。本次修复批也**未补**（它要一条能产出改动的真实跑 + 手工制造挂起 CLI，成本超出本批授权的一行额度） | **仍开着**：留给下一次真机跑（与 §8 第 3 条「Run D 逐行终止」同一轮做最省） |
| **B-p3-10** | p3 的 **L5**：第三份 `readTokens` 的重构（计划 Task 12 要求做） | **按树实测：未做**。三份独立定义仍在：`providers/claude-code/events.ts:95`、`providers/codex/events.ts:71`、`providers/dsh/events.ts:135`（三处 WARN 文案逐字相同、只有字段名不同）；p3 台账既没记「已做」也没记「重新开着」 | **未做**（与终审 §2-L3 同一条），留痕于此 |

> 另按控制方裁决一并订正：**B-p4-12** —— p4 的 `progress.md` 也留着一行过期的「尚未开工（等 p3）」（与 p5 台账同类），由控制方在台账侧更新。

## 11. 勘误（2026-09-26，Anthropic 拉取口径修订；**原文一字未改，勘误在此集中**）

> 手法同 §10：**已入库的证据段落与实测数字一律不改写**，被推翻的陈述在这里逐条列明它错在哪、以及正确的读法。
> 出处：spec `2026-09-22-features-design.md` §3 F1 / §6.1 的 2026-09-26 修订；
> 实现 `packages/server/api/src/providers.ts` 的 `modelListCandidates` / `fetchModelIds`；
> 界面 `packages/client/ui/src/composite/provider-form-modal.tsx`。

| # | 原文（行号 + 原话） | 实际情况 | 出处 |
|---|---|---|---|
| ① | `:53`（§1 表）与 `:181`（§4）：「`POST …/models/fetch` → **400** +『Anthropic 兼容协议没有 /models 接口』」 | **当时的实测如实**（那时服务端确有这条协议闸门，2026-09-26 已删）。协议如今**不参与**能否拉取的判定，改为按地址形态兜底：`GET {地址}/models`，**仅 404** 时依次回退 `GET {地址}/v1/models`、站点根 `/models`、站点根 `/v1/models`（后两条是 2026-09-30 再修订补的：地址填 `/anthropic` 一类 Messages 根时清单接口仍在站点根上）。**同一请求今天返回 200 + 模型清单**——真机复验：anthropic 供应商、地址 `http://likecode-llm-proxy-test.jd.com`（不带 `/v1`，真实走到回退）与 `http://likecode-llm-proxy-test.jd.com/v1/`（带尾斜杠）两种形态都拉到 **47** 个模型。**正确读法**：`400` 是「当时的服务端行为」的忠实记录，不是今天的预期 | spec §3 F1 / §6.1；`providers.ts`；真机复验见本文件所在工作树的提交 `fix(api,ui)` |
| ② | `:40`（§1 表）：「§9-1 两个供应商（openai 拉模型 / **anthropic 手工模型**）」 | 「环境缺口」这个**判定**不受影响（当时唯一可达网关只讲 Anthropic Messages），但括号里的对应关系不再是规则：`manual` 只是模型来源**之一**，anthropic 协议同样可以拿到 `fetched` 条目 | 同上 |

**未被推翻的部分**：本文件其余判定（两行终态与事件 seq、计量与 diff、出分算式、`~/.aieval` 隔离哨兵、沙箱证据份数）都不涉及本次修订，**照旧有效**。
⇒ 结论同 §10：**这份记录仍然可信，只是需要本条勘误**；本次只加本节，**不改写任何证据段落**。

