# 功能阶段 p6 实施计划：冒烟、使用手册与关账

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 p0–p5 做出来的真东西跑起来——在**一次连续会话**里走完 spec §9 的 9 项冒烟与 §5.6.7 的 3 项适配器冒烟（真实网关、最小仓库、最小提示词、**不复跑**），按 `AGENT.md` 的四要素留证；随后补使用手册、写关账记录，把 spec 的 12 节逐节对上「哪份计划的哪个任务」，把未做/推迟项显式列出。

**Architecture:** 三段式。① **前置与准备**：命令级的交付物检查（文件存在性 + 语义 grep）→ 临时沙箱（最小示例仓库 / 独立 `AIEVAL_CONFIG_DIR` / 独立 `workspaceRoot`，真实 `~/.aieval` 全程只读）→ 成本护栏与失败留证口径。② **冒烟执行**：4 轮评测（Run A 并行 2 行跑完出分、Run B 串行 3 行中途终止后仅重跑未完成行且评分器故意配坏、Run D 并行 3 行跑到产出改动后逐行终止）+ 2 次非 agent 文本调用；每一项都留**浏览器实测**（`browser_evaluate` / `read_picked_element` / `browser_snapshot`）与 **CLI 互证**（`git` / `config.json` / `run.json` / `events.jsonl` / 进程与端口）两侧证据。③ **收尾与文档**：端口与进程收尾 + 真实配置未被污染的前后对比 → `README.md` 增补使用手册 → `docs/superpowers/notes/2026-09-22-features-smoke.md` 关账记录 + spec 覆盖矩阵 + 修正汇总 + 本计划「冒烟记录」小节回填。所有临时产物落在 `%TEMP%` 沙箱；本阶段入库文件只有 3 个（`README.md`、关账记录、本计划的回填）。

**Tech Stack:** Next.js 16.2.7（Turbopack，:3083）· React 19 + antd 6 · pnpm 11 workspaces · vitest 4 · zod 3 · git CLI 2.47 · PowerShell 7（pwsh）· Playwright MCP（`browser_navigate` / `browser_find` / `browser_click` / `browser_type` / `browser_evaluate` / `browser_snapshot` / `read_picked_element` / `browser_console_messages`）

**Spec:** `docs/superpowers/specs/2026-09-22-features-design.md` §9（测试的冒烟清单 9 项 + 成本护栏）· §5.6.7（适配器的冒烟 3 项）· §11 第 8 步 · §12

**Interfaces source:** `docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`（路由表 §9、页面清单 §9、落盘结构 §10、修正 R1–R7）

> **勘误（2026-09-26，Anthropic 拉取口径修订）—— 本计划下列内容已作废，原文一字未改，读法以此处为准。**
> 现行口径：**能否拉取模型不由协议判定**，改由地址形态兜底 —— `GET {地址}/models`，**仅 404** 时回退 `GET {地址}/v1/models`
> （地址已以 `/v1` 结尾时只留前者；401/403/429/5xx 说明路径是通的，不回退），两条都 404 时错误文案点名两条实际路径。
> 出处：spec §3 F1 / §6.1 的 2026-09-26 修订；实现见 `packages/server/api/src/providers.ts` 的 `modelListCandidates` / `fetchModelIds`。
> **2026-09-30 再修订（补站点根回退）**：候选是 `{地址}/models` → `{地址}/v1/models`（地址已以 `/v1` 结尾时跳过）
> → 站点根 `/models` → 站点根 `/v1/models`（重复 URL 只留一次），仍**只有 404** 才换下一条；
> 走「子路径地址」的冒烟步骤（把地址填成 `/anthropic` 一类）今天应当**返回 200 + 清单**，而不是 404。
> 受影响（行号按本文件当前文本）：`:889`～`:891`（Expected 断言 `HTTP 400` +「Anthropic 兼容协议没有 /models 接口」，并把它写成判定依据）、
> `:1722`（使用手册 ① 要求「写明『拉取模型』在 Anthropic 协议下**不可用**」）、`:1733`（排障表那行「Anthropic 协议没有 `/models`，只能手工维护」）、
> `:1940`（p1 交接正控「anthropic 拉取 400」）。**本阶段当时的实测值照旧有效**（那时服务端确有协议闸门），**只是不再是今天的预期**。
> **仍成立**：本计划其余部分（隔离与哨兵回环、成本护栏、四要素留证、其余 8 项冒烟与 3 项适配器冒烟、关账矩阵）与本次修订无关。

## Global Constraints

- 包名前缀一律 `@aieval/*`；依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束（含动态 `import()` 与 `require()`，禁跨包相对引用）。本阶段**默认不写产品代码**，一旦触发「必要的小修」必须遵守全部边界规则。
- 源码一律 ESM；`verbatimModuleSyntax` 开着，类型必须 `import type`。时间字段一律 ISO 8601 带时区字符串；实体 id 一律 UUID v4。
- 配置目录优先级 `AIEVAL_CONFIG_DIR` > `~/.aieval`。**本阶段所有会起 Next 进程的命令都必须带 `AIEVAL_CONFIG_DIR=$smokeRoot\aieval-config`**；真实 `~/.aieval` 与 `~/.runs` 全程只读、不创建。
- 端口固定 **3083**（`next dev -p 3083`）；被占用时**先 kill 占用进程再启动**（`AGENT.md`）。地址一律用 `http://localhost:3083`，**不用 `127.0.0.1`**（Next 16 的 dev 资源跨源拦截，脚手架冒烟已实测）。
- **密钥口径**：只从环境变量读取后填进界面（`Input.Password`）；明文**不得**出现在任何入库文件、任何 `evidence/` 文件、任何命令的标准输出里。证据里只允许「长度 + 前 3 后 4 掩码 + SHA256 前 8 位」。
- **临时产物一律放 `$smokeRoot`（`%TEMP%\aieval-p6-smoke-<yyyyMMdd-HHmm>`），不入库**。每个任务结束时仓库 `git status --porcelain` 只允许出现「本任务要提交的入库文件」与那一个**别人**的未跟踪文件（见 Task 1 Step 1）。
- 提交信息中文（形如 `docs(readme): …`），`git add` **逐个显式写路径**，**禁 `git add -A`**；`git status` 里不属于本次的文件**保持原样**。
- 证据必须实测：几何与数值断言一律读 `getBoundingClientRect()` / `read_picked_element` / `browser_evaluate` 的返回值，**不得凭截图判断**。
- 每项判定必须是**可证伪的断言**（等式 / 不等式 / 集合相等），判定只有三档：✅ / ❌ / 跳过+理由。**只有单侧证据（只有页面或只有 CLI）一律判「证据不足」，不得判 ✅**。
- 真实模型调用集中在 Task 5–7，**不复跑**（护栏见下）。只允许零模型调用成本的重试。
- 失败必须留三件套：原始报错正文 + 对应行 `events.jsonl` 尾部 20 行 + 该行 `run.json` 片段；并给出「工具坏 / 环境坏 / 实现坏」的归因。
- 文档禁写「TBD / 稍后补 / 视情况而定 / 按实际情况记录」；每个 checkbox 是一个**动作**（一条命令 / 一次点击序列 / 一次读取）。
- 每个任务结束时 `pnpm typecheck` 零错误（本阶段多为文档改动，跑它是为了确认没碰坏）。

## Review Focus

以下五类条件 spec 没有明说，但坏了会让「冒烟通过」变成假象。每条都落到指定任务的指定步骤：

1. **证据不足却判通过** —— 「页面上看到了」不等于「实现对了」。「我点了、有反应」不是断言；断言必须是 `round(sum/(5*5)*100)` 这类可算的等式、或页面数字与 CLI 数字的逐项相等。**只有一侧证据**（只有页面观感、或只有 CLI 文件、或只有截图）时判「证据不足」，与 ❌ 同样计入关账。落到 Task 3–7 每一项的「判定」步骤（都写明了必须贴出的实测字段）与 Task 10 Step 3 的范围清单口径。
2. **临时配置污染真实 `~/.aieval`** —— 漏设一次 `AIEVAL_CONFIG_DIR` 就会把冒烟供应商与**明文密钥**写进使用者的真实配置，并覆盖他自己的设置。落到 Task 1 Step 1（会话前哈希/时间戳/文件数快照）、Step 8（启动命令里显式带该变量）、Task 8 Step 3（前后逐项对比 + `~/.runs` 存在性不变）。
3. **端口/进程残留** —— `job_kill` 只回收它拉起的进程树；Next 的 listener 与三家 agent CLI 子进程可能活下来（DSH「关闭运行时」这条路径尤其）。落到 Task 8 Step 2：必须**同时**满足「3083 无 LISTEN」「dev 进程的传递闭包为空」「运行期记录到的 agent 子进程 PID 全部消失」，缺一条即 ❌。
4. **把「没采到计量」记成 0** —— UI 若把 `null` 渲染成 `0`，横向对比会得出「这家很省」的错误结论；记录里写「token 0」等于把缺陷写成通过。落到 Task 5 第 4 项判定：`tokens === null` 时界面文案必须是「不支持计量 / 未采集」且**不出现 `0`**；只有 `tokens !== null` 才允许断言数值跳动。
5. **跳过项不写理由 / 用「不复跑」掩盖失败** —— 成本护栏不是「失败就不管」的许可证。落到 Task 2 Step 6（护栏里写明重试白名单）、Task 5/6/7 每项的「失败处置」步骤、Task 10 Step 3（范围清单里每个 ❌/跳过必须带现象 + 证据位置 + 归因 + 后续计划）。

## 前置条件与成本护栏

### 前置条件（Task 1 逐条验证，任一条不满足就停下处理）

| 前置 | 判据（命令） | 期望 |
|---|---|---|
| p0–p5 全部合入本分支 | Task 1 Step 6 的存在性脚本 | 缺失 0 个、应删未删 0 个 |
| 四条命令全绿 | `pnpm install` / `pnpm typecheck` / `pnpm lint` / `pnpm test` | 退出码全 0 |
| **三家 CLI 可用** | `claude --version` / `codex --version` / dsh 的可执行文件 `--version` | 各打印版本号（Task 7 的 Run D 要真的驱动三家；缺哪家就在记录里如实写该家跳过） |

> **已知情况（控制方在 p3 依赖落位时实测，2026-09-25）：`dsh` 不在 PATH** ——
> `Get-Command dsh` 无结果，而 `claude` / `codex` 都在 `d.\.nvm4w\nodejs\`（`claude.ps1` / `codex.ps1`）。
> 本仓的 dsh 依赖是 **SDK** `@deepseek-ai/dsh-sdk-client`（`next` 线 0.1.7-rc.1，契约 R33），
> 而适配器要驱动的是**dsh CLI 本体**。
>
> **已找到入口并实测（不必再找）**：dsh 就是 `D:\zhanglei1120\Github\deepseek-harness\` 这个 checkout 自己，
> 它的 `package.json` 有一条 `"dsh": "node --import tsx/esm apps/cli/src/bin.ts"`（`apps/cli/package.json` 存在）。
> **实测通过的调用（2026-09-25，控制方亲测）**：
>
> ```powershell
> # 必须让 cwd = harness（tsx 是相对 cwd 解析的）：
> pnpm --dir D:\zhanglei1120\Github\deepseek-harness dsh --version
> #   或
> node --import tsx/esm apps/cli/src/bin.ts --version      # workdir = D:\zhanglei1120\Github\deepseek-harness
> ```
>
> 实测输出：**`0.1.5-rc.2`，退出码 0**（`tsx` 在 harness 的 `node_modules` 里，已确认存在）。
> **踩坑记录**：`node --import tsx/esm D:\...\deepseek-harness\apps\cli\src\bin.ts --version`（绝对路径 + cwd 在本仓）
> **会失败**，报 `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx' imported from D:\...\ai-result-evaluation\` ——
> `--import` 的模块说明符按 **cwd** 解析，不按脚本路径解析。所以要么用 `pnpm --dir`，要么把 workdir 切过去。
>
> **顺手记下的一处版本偏斜**：dsh **CLI 是 `0.1.5-rc.2`**，而本仓装的 **SDK 是 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.1`**（R33 的 `next` 线）。
> 两者不是同一版本线，事件形态**可能**有差异 —— 这正是 Task 11 的真实探测要回答的问题；若探测结果与 §5.6.3 的表冲突，
> 以**实测**为准并回写（Task 12）。
>
> 另：`~/.dsh`（10 项）、`~/.claude`（33 项）、`~/.codex`（33 项）三个配置目录都存在 ⇒ 三家 CLI 的登录态应当已具备；
> 但环境里**没有** `AIEVAL_PROBE_*` / `ANTHROPIC_*` / `DEEPSEEK_*` / `OPENAI_*` 变量（实测全为空），
> 所以真实调用所需的网关键仍要按 Task 1 Step 2 的口径由使用者提供。
>
> 若那个入口以后起不来，按下面的规则处置，**不要**为了「让前置全绿」而伪造一个 dsh 入口：
>
> 1. 再确认一次调用方式（`pnpm --dir … dsh` / 切 workdir 后直接 node 起 `apps/cli/src/bin.ts`），把**确切命令**记进 `evidence/`。
> 2. 真起不来 ⇒ **不要把整轮冒烟判定为失败**：dsh 一家按「不可用」记入前置表与关账记录的「未做项」，
>    Run D 降为 claude-code + codex 两行（Run D 的目的是三种终止语义，与适配器实现无关，两行也能证），
>    第 9 项（坏评分器隔离）不受影响；同时把 p3 的 dsh 适配器标注为「只有假 SDK 覆盖、未在真实 CLI 上取证」。
>    这一条正是 p3 保守值 `usage: false` 要覆盖的分支（契约 §5.6.3「探不到就标 usage: false」）。
| 真实网关可达 + 两套密钥在手 | 变量口径见 Task 1 Step 2（沿用 p3 Task 11 的 `AIEVAL_PROBE_BASE_URL` / `AIEVAL_PROBE_API_KEY`） | Task 2 Step 5 的两条探针都非 4xx |
| 系统 git CLI | `git --version` | ≥ 2.47（本机实测 `2.47.0.windows.2`） |
| Node / pnpm | `node -v` / `pnpm -v` | Node ≥ 20（实测 `v24.17.0`）/ pnpm 11（实测 `11.18.0`） |
| 端口 3083 可用 | `Get-NetTCPConnection -LocalPort 3083 -State Listen` | 无监听，或占用者是本仓的 `next dev`（可 kill） |
| `%TEMP%` 可写 | 沙箱建目录 + 写探针文件 | 成功 |
| **外置依赖可解析（R35）** | `pnpm --filter @aieval/web-next test -- runtime-deps` | 绿（三家 SDK 同时声明在 `apps/web-next/package.json`，且 `createRequire().resolve()` 从应用根目录解析得到）。**这是产物级验证的前置**：单元测试只证明「声明在 + 能解析」，不证明 Next 把外置说明符发成 `module` 而不是 `commonjs`——后者要到本任务真的起服务、真的跑到一行 agent 才会暴露 |

### 成本护栏（spec §9 末段：真实模型调用集中在第 3–9 项，不复跑）

一次连续会话，**4 轮评测 / 9 次 agent 启动 / 8 次文本调用**：

| 序 | 动作 | 模式·行数 | agent 启动 | 文本调用 | 终止/等待时机 |
|---|---|---|---|---|---|
| 0 | 前置模型存活探针（非 agent，Task 2 Step 5） | — | 0 | 2（`max_tokens: 1`） | — |
| 1 | 用例「AI 生成评分提示词」（Task 4） | — | 0 | 1 | — |
| 2 | **Run A**（Task 5） | parallel · 2 行（claude-code + codex） | 2（跑完出分） | 2 | 不终止，等两行 `judged` |
| 3 | **Run B 第一次开始**（Task 6 第 7 项） | serial · 3 行（claude-code / codex / codex） | 2（行 1 跑完含评分；行 2 跑起后终止） | 1 | 行 2 `running` 且收到首个 agent 事件 → 点吸底「终止」 |
| 4 | **Run B 第二次开始**（Task 6 第 8/9 项） | serial · 同行 2、行 3（行 1 已 `judged` 不重跑） | 2 | 2（**必失败**，坏评分模型） | 不终止，等两行 `failed` |
| 5 | **Run D**（Task 7 第 3 项） | parallel · 3 行（claude-code / codex / dsh） | 3（各自产出文件改动后逐行终止） | 0 | 逐行点「终止」 |
| | **合计** | | **9** | **8** | |

**不复跑规则：**
- 任何一项失败后**不得**重跑整轮去「换一个通过的结果」。失败照原样记录（判 ❌ 或跳过 + 理由），**继续**做后面的项——失败隔离本身就是被测行为。
- 允许的重试白名单（全部零模型调用）：浏览器点击/读取失败、`browser_evaluate` 表达式写错、DOM 选择器与实现不符（先用 `browser_snapshot` 记录真实结构再改写）、CLI 语法错误、路径写错、`Get-Process` 因进程已退出而失败、`pnpm` 命令因网络抖动失败。
- 失败发生在**模型调用之前**（表单校验、路由 404、按钮禁用）时，修好后重新走到该步**不算复跑**。
- 第 1 项（供应商）与第 2 项（用例）本身不含 agent 调用，恢复后重做不消耗护栏预算；探针（序 0）允许重试一次。

**失败留证三件套**（每次失败都抓，缺一件不算留证）：
1. 界面原文：`message.error` 文案、卡片错误文案，以及 `browser_console_messages({level:'error'})` 的输出；
2. `%TEMP%` 沙箱里该行的 `Get-Content "$runDir\rows\$rowId\events.jsonl" -Tail 20`；
3. 该行在 `run.json` 里的完整对象（`ConvertTo-Json -Depth 8`），以及上游响应正文（在 events 的 `error` / `log` 事件里）。

**「工具坏了」还是「被测实现坏了」**（三选一，必须写进记录）：
- 直连上游成功（`Invoke-WebRequest` 打 `{baseUrl}/models`、`{baseUrl}/chat/completions`、`{baseUrl}/v1/messages` 返回 2xx）而界面失败 ⇒ **实现坏**；
- 直连上游也失败（401/404/429/超时/连不上）⇒ **环境坏**（密钥、额度、网络、模型名），该项判**跳过 + 理由**；
- 浏览器/CLI 命令自身语法或选择器错误 ⇒ **工具坏**，按白名单重试。

## 文件结构总览

```
ai-result-evaluation/
├── README.md                                       # 改：新增「使用手册」章节 + 更新「当前状态」
└── docs/superpowers/
    ├── notes/
    │   └── 2026-09-22-features-smoke.md            # 新建：关账记录（四段式，格式照 scaffold-smoke）
    └── plans/
        └── 2026-09-22-features-p6-smoke.md         # 改：执行时回填文末「冒烟记录」小节（AGENT.md 要求）

不入库（临时沙箱，$smokeRoot = %TEMP%\aieval-p6-smoke-<yyyyMMdd-HHmm>）：
├── repo/            # 最小示例仓库（git init -b main，2 个提交，3 个文件）
├── aieval-config/   # AIEVAL_CONFIG_DIR：config.json（含**明文 apiKey**）
├── workspace/       # workspaceRoot：cases/{caseId}/cache、{runId}/run.json、rows/{rowId}/*
├── evidence/        # 原始证据：快照、探针、进程闭包、grep 结果、手册事实来源
└── secrets/         # 只放密钥的掩码与 SHA256 前 8 位，不放明文
```

**为什么这些不入库（逐条理由）：** ① `aieval-config/config.json` 与真实配置同构、含**明文** `apiKey`（`config-store` 按设计写明文，只在 API 出口掩码）；② `repo/` 是独立 git 仓库，入库会变成嵌套仓库/子模块噪音；③ `workspace/` 是运行产物（行工作副本 + `events.jsonl` + `run.json` + 可能数 MB 的 diff），每次都不同；④ `.gitignore` 覆盖不到 `%TEMP%`——靠「放对位置」比靠忽略规则更可靠。

**可能的小修（默认不发生）：** p6 **不改产品代码**。唯一例外：某个缺陷使后续冒烟项**完全无法继续**，且修复**不触达任何模型调用路径**（例如某个控件缺 `data-testid` 让几何断言无法取值、某条中文文案与本计划引用不符）。此时允许最小修复 + 单独提交 + 重跑 `pnpm typecheck` / `lint` / `test`；否则一律只记录（现象 + 最小修法，**不应用**）交后续阶段。

### 会话变量（每个新 shell 开头先跑一遍）

每条 `pwsh` 调用都是**全新的进程**，变量不跨调用保留。所以每个任务的第一步（或任何新开的 shell）都先跑这段固定指针，把公共变量重新载入：

```powershell
$repo      = 'D:\zhanglei1120\Github\ai-result-evaluation'
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
$cfgPath   = Join-Path $smokeRoot 'aieval-config\config.json'
$sample    = (Get-Content "$smokeRoot\evidence\sample-repo.txt" -Raw).Trim()
$devPid    = [int](Get-Content "$smokeRoot\evidence\dev-pid.txt" -Raw)
$firstHash = git -C $sample rev-parse HEAD~1
"repo=$repo"; "smokeRoot=$smokeRoot"; "cfgPath 存在=$(Test-Path $cfgPath)"
"sample=$sample  devPid=$devPid  firstHash=$firstHash"
# 模型选型（Task 2 Step 4 写入）：文件还不存在时跳过，不报错
if (Test-Path "$smokeRoot\evidence\models.json") {
  $m = Get-Content "$smokeRoot\evidence\models.json" -Raw | ConvertFrom-Json
  $judgeModel = $m.judge.modelId; $codexModel = $m.codex.modelId; $dshModel = $m.dsh.modelId
  $anthModel  = $m.'claude-code'.modelId
  "judge=$judgeModel  anth=$anthModel  codex=$codexModel  dsh=$dshModel"
} else { 'models.json 尚未生成（Task 2 Step 4 之前属正常）' }
```

`$smokeRoot` 的固定指针由 Task 1 Step 1 写入（因此**从 Task 1 Step 2 起**这段就可以跑）。`$sample` / `$devPid` / `$firstHash` 分别在 Task 1 Step 8、Task 2 Step 2–3 之后才有值——在它们之前跑这段会在这三行报错，属正常，按任务顺序推进即可。**下文所有 PowerShell 步骤的 Workdir 都是仓库根 `$repo`**（`git -C`/`-LiteralPath` 已显式带路径的地方除外），所有相对路径都相对仓库根。

---

## Task 1: 前置检查与起服务

**Files:**
- Modify: `apps/web-next/app/providers.tsx`（Step 4 的 R31：`ConfigProvider` 补 `locale={zhCN}` —— 本任务**唯一的入库改动**，单文件单提交）
- Create: 无其它入库文件（证据落 `$smokeRoot\evidence\`）
- Test: 无新增（R31 的可证伪检查是「同一处英文内置串变中文」，写进 `evidence/`）

**Interfaces:**
- Consumes: p0–p5 的全部交付物（interfaces §2 契约出口 / §3 core 出口 / §4 agents 出口 / §5 evaluator 出口 / §6 api 出口 / §7 hooks 出口 / §8 组件清单 / §9 路由与页面清单 / §10 落盘结构）
- Produces: `$smokeRoot` 绝对路径、`evidence\{smokeRoot.txt, git-*.txt, real-config-before.*, real-runs-before.txt, deliverable-check.txt, port-owners.json, service.json, dev-pid.txt, host-env-before.txt}`

- [ ] **Step 1: 建沙箱并记录会话前状态**

```powershell
$smokeRoot = Join-Path $env:TEMP ("aieval-p6-smoke-" + (Get-Date -Format 'yyyyMMdd-HHmm'))
New-Item -ItemType Directory -Force -Path $smokeRoot, "$smokeRoot\evidence", "$smokeRoot\secrets" | Out-Null
$smokeRoot | Set-Content "$smokeRoot\evidence\smokeRoot.txt"
# 固定指针：后续每个新 shell 靠它重新载入 $smokeRoot（见「会话变量」）
$smokeRoot | Set-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt')
$repo = 'D:\zhanglei1120\Github\ai-result-evaluation'
git -C $repo branch --show-current | Set-Content "$smokeRoot\evidence\git-branch.txt"
git -C $repo rev-parse HEAD          | Set-Content "$smokeRoot\evidence\git-head.txt"
git -C $repo status --porcelain      | Set-Content "$smokeRoot\evidence\git-status-before.txt"
# 真实配置目录（全程只读）：哈希 + 长度 + 时间戳 + 文件数
$real = Join-Path $env:USERPROFILE '.aieval'
if (Test-Path "$real\config.json") {
  (Get-FileHash "$real\config.json" -Algorithm SHA256).Hash | Set-Content "$smokeRoot\evidence\real-config-before.sha256"
  (Get-Item "$real\config.json" | Select-Object Length, LastWriteTime | ConvertTo-Json) | Set-Content "$smokeRoot\evidence\real-config-before.json"
  (Get-ChildItem $real -Force).Count | Set-Content "$smokeRoot\evidence\real-config-before.count"
} else { 'ABSENT' | Set-Content "$smokeRoot\evidence\real-config-before.sha256" }
(Test-Path (Join-Path $env:USERPROFILE '.runs')) | Set-Content "$smokeRoot\evidence\real-runs-before.txt"
Get-Content "$smokeRoot\evidence\git-branch.txt", "$smokeRoot\evidence\git-head.txt", "$smokeRoot\evidence\git-status-before.txt", "$smokeRoot\evidence\real-config-before.sha256"
```

Expected: 分支 `docs/features-plan`；`git status --porcelain` **只有一行** `?? docs/superpowers/notes/2026-09-22-features-plan-interfaces.md`（别人未提交的文件）；`real-config-before.sha256` 是 64 位十六进制（本机实测 `750BBF152C0EDDA0651284085E96F6176531B54D19492A135C1A4BCB195F191D`，`Length 219`，`LastWriteTime 2026/9/24 17:39:36`）。

判定：三条 git 输出与预期一致。**不一致就停**——说明有别的会话正在改这个仓，此时做冒烟会污染证据与提交。

- [ ] **Step 2: 载入网关地址与密钥（只进变量，不落盘、不回显明文）**

**变量口径沿用 p3 Task 11「真实事件探测」的两个基础变量**（同一套前置、同一个网关，避免重复准备环境）；只有「两个协议各一个供应商」这件 p6 独有的事才另加可选覆盖变量：

| 变量 | 谁定义的 | 含义 |
|---|---|---|
| `AIEVAL_PROBE_BASE_URL` | p3 Task 11（**必填**） | 网关根地址；openai / anthropic 两个协议都从它推导 |
| `AIEVAL_PROBE_API_KEY` | p3 Task 11（**必填**） | 密钥 |
| `AIEVAL_PROBE_MODEL` | p3 Task 11（可选） | 探测用的模型名；p6 不读它（p6 自己从 `/models` 清单里选型） |
| `AIEVAL_PROBE_CWD` | p3 Task 11（可选） | p6 不用：p6 有自己的最小示例仓库（Task 2 Step 2） |
| `AIEVAL_SMOKE_OPENAI_BASE_URL` | p6（可选覆盖） | 网关不是「根地址 + `/v1`」形状时用 |
| `AIEVAL_SMOKE_ANTHROPIC_BASE_URL` | p6（可选覆盖） | 网关的 anthropic 端点是独立路径时用 |
| `AIEVAL_SMOKE_OPENAI_KEY` / `AIEVAL_SMOKE_ANTHROPIC_KEY` | p6（可选覆盖） | 两个协议用不同密钥时用 |
| `AIEVAL_SMOKE_ANTHROPIC_MODEL` | p6（可选） | openai 清单里挑不到 `claude` 型号名时，由使用者给出 |

```powershell
# 基础口径（p3 同款）
$probeBase = $env:AIEVAL_PROBE_BASE_URL
$probeKey  = $env:AIEVAL_PROBE_API_KEY
# 按 spec §5.6.4 的口径推导两个供应商地址：openai 协议**要带** /v1，anthropic 协议**不重复** /v1
$openaiBase = if ($env:AIEVAL_SMOKE_OPENAI_BASE_URL) { $env:AIEVAL_SMOKE_OPENAI_BASE_URL }
              elseif ($probeBase -match '/v1/?$') { $probeBase.TrimEnd('/') }
              else { $probeBase.TrimEnd('/') + '/v1' }
$anthBase   = if ($env:AIEVAL_SMOKE_ANTHROPIC_BASE_URL) { $env:AIEVAL_SMOKE_ANTHROPIC_BASE_URL } else { $probeBase.TrimEnd('/') }
$openaiKey  = if ($env:AIEVAL_SMOKE_OPENAI_KEY) { $env:AIEVAL_SMOKE_OPENAI_KEY } else { $probeKey }
$anthKey    = if ($env:AIEVAL_SMOKE_ANTHROPIC_KEY) { $env:AIEVAL_SMOKE_ANTHROPIC_KEY } else { $probeKey }
foreach ($pair in @(@('openaiBase',$openaiBase), @('openaiKey',$openaiKey), @('anthBase',$anthBase), @('anthKey',$anthKey))) {
  $n = $pair[0]; $v = $pair[1]
  if ([string]::IsNullOrWhiteSpace($v)) { Write-Output "[MISSING] $n" } else { Write-Output "[OK] $n len=$($v.Length) 值=$(if ($n -like '*Key') { '<隐去>' } else { $v })" }
}
```

Expected: 4 行 `[OK]`；两个地址都打印出来、两个密钥只打印长度与 `<隐去>`。
判定：4 项齐备才继续。缺项 → 让使用者先设好（**不许**把明文写进任何文件）；若使用者选择「只在界面里手工填密钥」，则允许两个 `*Key` 缺项，但 Task 2 Step 5 的探针随之跳过并记账（第 1 项的拉模型断言降级为「手工添加模型后协议与来源正确」）。

- [ ] **Step 3: 安装依赖**

Run（Workdir = 仓库根）: `pnpm install`
Expected: 退出码 0；`Lockfile is up to date` 或 `Packages: +N`；**不得**出现 `ERR_PNPM_IGNORED_BUILDS`。
失败处置：`ERR_PNPM_IGNORED_BUILDS` ⇒ 工具链问题，按 `AGENT.md` 的 `allowBuilds` 口径补 `pnpm-workspace.yaml`（**写进 `onlyBuiltDependencies` 无效，实测仍报**）×网络失败 ⇒ 环境坏，重试一次。

- [ ] **Step 4: 应用级 antd locale 修复（R31，本阶段唯一的「先改一行再冒烟」）**

契约 R31 把「antd 内置文案默认英文」这整类的**根因修复**归给 p6（p1 只逐点补了浮层文案，p2 不动该文件）：

- 改 `apps/web-next/app/providers.tsx` 的 `ConfigProvider`：加 `locale={zhCN}`（`import zhCN from 'antd/locale/zh_CN'`）。
- 为什么是根因：p1 的 fix wave 已经实证「漏一个就漏一个英文」（judge Select 的 `No data`、`EmptyState` 的 SVG `<title>No data</title>`、`Modal` 的 `aria-label="Close"` 同源）。配一次 locale 一次性关掉这一整类，且**现有显式中文文案不会变坏**（显式值优先）。
- 可证伪的检查：改前先记一条现存的英文内置串（例如打开一个 `EmptyState` 空态，读它的 SVG `<title>`），改后**同一处**必须变成中文（或至少不再是 `No data`）；把改前/改后两段原文都贴进 `evidence/`。
- 提交：**逐个显式路径** `git add apps/web-next/app/providers.tsx`，提交信息中文 `feat(web-next): 应用级 antd locale 设为中文（契约 R31）`。
- 顺带核对（不改，只记录）：`apps/web-next/src/runtime-deps.test.ts` 是绿的（R35 的守卫在位），且三家 SDK 同时声明在 `apps/web-next/package.json` 里。

Expected: locale 生效、上面那条英文串变中文、`pnpm typecheck` 与 `pnpm lint` 仍退出 0。
若 antd 6 的类型不接受 `locale`（或 import 路径变了）：把真实报错贴进记录，并按 antd 6 的实际 API 修正；**不要**用「给每个浮层再补一次中文」绕过——那正是 R31 要终结的做法。

- [ ] **Step 5: 跑三条命令并记录真实输出形状**

Run（Workdir = 仓库根）: `pnpm typecheck`
Expected: 首行 `$ pnpm -r typecheck`、`Scope: 8 of 9 workspace projects`，随后 8 个包各两行（`<pkg> typecheck$ tsc --noEmit` / `<pkg> typecheck: Done`），**没有任何 `error TS` 行**，退出码 0。

Run: `pnpm lint`
Expected: 同样的 8 包形状（`lint$ eslint .` / `lint: Done`），无 `error` 行，退出码 0。

Run: `pnpm test`
Expected: 每个包 ` RUN  v4.1.11 <包绝对路径>` + ` Test Files  N passed (N)` + ` Tests  M passed (M)`；**任何 `failed` 即失败**；退出码 0。本机脚手架基线（本次实测）：contracts 14 · core 34 · client 10 · ui 98 · api 13 · web-next 12 = **181 个用例**，`agents` 与 `evaluator` 此时为 `No test files found, exiting with code 0`（空壳）。功能阶段落地后这两个包必须有测试文件，用例总数应显著大于 181——**记录实测总数**，不预设。

> **已知噪声（不是失败）**：① 上面三条命令若用 `pwsh` 的 `2>&1 | Out-String` 捕获，会把 pnpm 写到 stderr 的 `$ pnpm -r …` banner 渲染成 `NativeCommandError` 的一大段红字——这是 PowerShell 对原生命令 stderr 的包装，**退出码为 0 就是通过**；② 每个包的 vitest 启动时会打印 `[UNRESOLVED_IMPORT] Could not resolve 'vitest/config'` 与 `configLoader: 'native'` 警告，这是既有噪声（脚手架阶段就有），**不要**在本阶段去修它。

判定：三条退出码全 0；把三条命令的包级汇总行抄进 `evidence/`（`pnpm test 2>&1 | Select-String 'Tests\s+\d+ passed'`）。

- [ ] **Step 6: p0–p5 交付物存在性检查（脚本，一次跑完）**

```powershell
$root = 'D:\zhanglei1120\Github\ai-result-evaluation'
$mustExist = @(
  # contracts（interfaces §2）
  'packages/server/contracts/src/index.ts','packages/server/contracts/src/errors.ts',
  'packages/server/contracts/src/provider.ts','packages/server/contracts/src/case.ts',
  'packages/server/contracts/src/run.ts','packages/server/contracts/src/score.ts',
  'packages/server/contracts/src/agent-event.ts',
  # core（interfaces §3）
  'packages/server/core/src/git.ts','packages/server/core/src/workspace.ts','packages/server/core/src/event-log.ts',
  # agents（interfaces §4）
  'packages/server/agents/src/types.ts','packages/server/agents/src/runtime.ts','packages/server/agents/src/registry.ts',
  'packages/server/agents/src/providers/claude-code/index.ts','packages/server/agents/src/providers/claude-code/sdk.ts',
  'packages/server/agents/src/providers/codex/index.ts','packages/server/agents/src/providers/codex/sdk.ts',
  'packages/server/agents/src/providers/dsh/index.ts','packages/server/agents/src/providers/dsh/sdk.ts',
  # evaluator（interfaces §5）
  'packages/server/evaluator/src/text-api.ts','packages/server/evaluator/src/judge-route.ts',
  'packages/server/evaluator/src/judge.ts','packages/server/evaluator/src/run-store.ts',
  'packages/server/evaluator/src/events.ts','packages/server/evaluator/src/orchestrator.ts',
  # api（interfaces §6）
  'packages/server/api/src/providers.ts','packages/server/api/src/cases.ts',
  'packages/server/api/src/judge.ts','packages/server/api/src/runs.ts',
  # client hooks（interfaces §7）
  'packages/client/client/src/providers.ts','packages/client/client/src/cases.ts',
  'packages/client/client/src/runs.ts','packages/client/client/src/row-stream.ts',
  # ui base（interfaces §8）
  'packages/client/ui/src/base/mono-text.tsx','packages/client/ui/src/base/score-bars.tsx',
  'packages/client/ui/src/base/row-status-tag.tsx','packages/client/ui/src/base/metric-line.tsx',
  # ui composite（interfaces §8）
  'packages/client/ui/src/composite/provider-table.tsx','packages/client/ui/src/composite/provider-form-modal.tsx',
  'packages/client/ui/src/composite/judge-settings-card.tsx','packages/client/ui/src/composite/workspace-settings-card.tsx',
  'packages/client/ui/src/composite/case-form-panel.tsx','packages/client/ui/src/composite/case-detail-panel.tsx',
  'packages/client/ui/src/composite/run-create-panel.tsx','packages/client/ui/src/composite/run-detail-panel.tsx',
  'packages/client/ui/src/composite/eval-row-card.tsx','packages/client/ui/src/composite/score-detail-view.tsx',
  'packages/client/ui/src/composite/diff-view.tsx','packages/client/ui/src/composite/log-view.tsx',
  # 页面与应用级（interfaces §9）
  'apps/web-next/app/cases/page.tsx','apps/web-next/app/runs/page.tsx','apps/web-next/app/settings/page.tsx',
  'apps/web-next/app/page.tsx','apps/web-next/src/nav.ts','apps/web-next/instrumentation.ts',
  # p3 的真实事件探测（Task 11/12 的交付物：脚本 + 报告；Task 7 与 Task 10 要引用报告结论）
  'packages/server/agents/probe/raw-events.mts',
  'docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md',
  # 路由（interfaces §9，共 17 条新增）
  'apps/web-next/app/api/providers/route.ts','apps/web-next/app/api/providers/[providerId]/route.ts',
  'apps/web-next/app/api/providers/[providerId]/models/route.ts','apps/web-next/app/api/providers/[providerId]/models/fetch/route.ts',
  'apps/web-next/app/api/cases/route.ts','apps/web-next/app/api/cases/[caseId]/route.ts',
  'apps/web-next/app/api/cases/validate-repo/route.ts','apps/web-next/app/api/cases/commits/route.ts',
  'apps/web-next/app/api/cases/generate-judge-prompt/route.ts',
  'apps/web-next/app/api/runs/route.ts','apps/web-next/app/api/runs/[runId]/route.ts',
  'apps/web-next/app/api/runs/[runId]/start/route.ts','apps/web-next/app/api/runs/[runId]/abort/route.ts',
  'apps/web-next/app/api/runs/[runId]/rows/[rowId]/abort/route.ts','apps/web-next/app/api/runs/[runId]/rows/[rowId]/diff/route.ts',
  'apps/web-next/app/api/runs/[runId]/rows/[rowId]/log/route.ts','apps/web-next/app/api/runs/[runId]/rows/[rowId]/stream/route.ts'
)
$mustNotExist = @('apps/web-next/app/demo/page.tsx','apps/web-next/src/testing/demo-fixtures.ts')
$missing  = @($mustExist    | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
$leftover = @($mustNotExist | Where-Object {        Test-Path -LiteralPath (Join-Path $root $_) })
$out = @("缺失 $($missing.Count)/$($mustExist.Count)", "应删未删 $($leftover.Count)") + $missing + $leftover
$out | Set-Content "$smokeRoot\evidence\deliverable-check.txt"
$out
if ($missing.Count -eq 0 -and $leftover.Count -eq 0) { 'P0–P5 交付物：齐备' } else { 'P0–P5 交付物：不齐备 —— 停止' }
```

> `-LiteralPath` 必须写：路径里的 `[providerId]` / `[runId]` / `[rowId]` 在 PowerShell 的通配符语法里是字符集，用裸 `Test-Path` 会**假报缺失**。

Expected: `缺失 0/74`（数组共 74 条：contracts 5 + core 3 + agents 9 + evaluator 6 + api 4 + hooks 4 + ui 4 + ui composite 12 + 页面与应用级 6 + 路由 17 + 探测脚本与报告 2）、`应删未删 0`、`P0–P5 交付物：齐备`。
判定：出现任何缺失 ⇒ 停下补齐对应计划（`docs/superpowers/plans/2026-09-22-features-p{0..5}-*.md`）再回来；`app/demo/page.tsx` 仍存在 ⇒ p2 未完成。

- [ ] **Step 7: 契约出口的语义检查（grep 断言，逐条给期望）**

```powershell
$root = 'D:\zhanglei1120\Github\ai-result-evaluation'
# 1) 三个新错误码进 ERROR_CODES，AgentErrorCode 不得混进去
Select-String -LiteralPath "$root\packages\server\contracts\src\errors.ts" -Pattern "NOT_A_GIT_REPO|INVALID_REF|JUDGE_PARSE_FAILED" | Select-Object -ExpandProperty Line
# 2) AGENT_KINDS 真源在 contracts，agents 只再导出（不得再声明一份字面量数组）
Select-String -LiteralPath "$root\packages\server\contracts\src\run.ts" -Pattern "AGENT_KINDS"
Select-String -LiteralPath "$root\packages\server\agents\src\types.ts" -Pattern "AGENT_KINDS"
# 3) 三个可用性判定与终态集合存在
Select-String -LiteralPath "$root\packages\server\contracts\src\run.ts" -Pattern "isRunnableRow|isRunningRow|TERMINAL_ROW_STATUSES"
# 4) 单一真源的输出契约存在，且解析侧引用它
Select-String -LiteralPath "$root\packages\server\contracts\src\score.ts" -Pattern "JUDGE_OUTPUT_CONTRACT"
Select-String -Path "$root\packages\server\evaluator\src\*.ts" -Pattern "JUDGE_OUTPUT_CONTRACT|composeTotalScore"
# 5) 服务重启恢复的调用点唯一（interfaces §5）
Select-String -Path "$root\apps\web-next\*.ts" -Pattern "recoverInterruptedRuns"
```

Expected: 每一条都至少 1 行命中；第 1 条命中 3 个新码且同一文件里**没有** `AGENT_LOAD_FAILED`；第 5 条只在 `apps/web-next/instrumentation.ts` 命中（**恰好 1 个文件**）。
判定：任一 grep 0 命中 ⇒ 契约未落地，停；第 5 条命中 2 个及以上文件 ⇒ ❌ 记录（第二处会与 p4 的启动钩子争抢）。

- [ ] **Step 8: 端口占用处理（记录占用者再 kill）**

```powershell
$owners = @(Get-NetTCPConnection -LocalPort 3083 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
  [pscustomobject]@{ PID = $p.ProcessId; Name = $p.Name; Started = "$($p.CreationDate)"; Cmd = "$($p.CommandLine)".Substring(0, [Math]::Min(160, "$($p.CommandLine)".Length)) }
})
($owners | ConvertTo-Json -Depth 4) | Set-Content "$smokeRoot\evidence\port-owners.json"
$owners | Format-Table -AutoSize
```

Expected: 要么空数组 `[]`，要么占用者的 `Cmd` 里含 `ai-result-evaluation` 与 `next`（本机实测存在的就是本仓的 dev server，PID 形如 78252）。
判定：`[]` → 直接进 Step 8；占用者是本仓 `next dev` → `Stop-Process -Id <pid> -Force`，再跑一次本步确认 `[]`；**占用者不是本仓进程 ⇒ 停下问使用者**（不许杀别人的服务）。

- [ ] **Step 9: 起 dev 服务（后台 job，显式带 `AIEVAL_CONFIG_DIR`）**

Run（`pwsh` 工具的**后台 job**，Workdir = 仓库根）:

```powershell
# 配置目录从固定指针推导，不手抄路径（避免抄错＝污染真实 ~/.aieval）
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
$env:AIEVAL_CONFIG_DIR = Join-Path $smokeRoot 'aieval-config'
Write-Output "AIEVAL_CONFIG_DIR = $env:AIEVAL_CONFIG_DIR"
pnpm dev
```

记下 job id（形如 `pwsh-…`）。
Expected: 日志出现 `▲ Next.js 16.2.7 (Turbopack)`、`- Local: http://localhost:3083`、`✓ Ready in <N>ms`（形状取自 `notes/2026-09-22-scaffold-smoke.md` §2）。
然后：

```powershell
(Invoke-WebRequest -Uri 'http://localhost:3083/settings' -UseBasicParsing).StatusCode   # 期望 200
(Invoke-WebRequest -Uri 'http://localhost:3083/api/runs' -UseBasicParsing).StatusCode   # 期望 200（空列表 []）
(Invoke-WebRequest -Uri 'http://localhost:3083/api/providers' -UseBasicParsing).StatusCode # 期望 200
$devPid = (Get-NetTCPConnection -LocalPort 3083 -State Listen).OwningProcess
$devPid | Set-Content "$smokeRoot\evidence\dev-pid.txt"
Get-CimInstance Win32_Process -Filter "ProcessId=$devPid" | Select-Object ProcessId, Name | Format-Table -AutoSize
```

Expected: 三个 200；`dev-pid.txt` 是单个数字；该进程 `Name = node.exe`。
判定：任一非 200 ⇒ 读 dev 日志与 `browser_console_messages`，按「实现坏」记录并停（后续项全部依赖这三条路由）。
失败处置：`✓ Ready` 未出现但端口有监听 ⇒ 等 10 秒重读 job 输出（Turbopack 首编译慢）；仍无 ⇒ 在 `evidence/` 记录 job 完整输出。

- [ ] **Step 10: 采集宿主环境基线（§5.6.7 第 1 项的前半）**

```powershell
$devPid = [int](Get-Content "$smokeRoot\evidence\dev-pid.txt")
$ev = [System.Diagnostics.Process]::GetProcessById($devPid).StartInfo.EnvironmentVariables
($ev.Keys | Sort-Object | ForEach-Object { "$_=$($ev[$_])" }) | Set-Content "$smokeRoot\evidence\host-env-before.txt" -Encoding utf8
"读到的变量数 = $($ev.Count)"
foreach ($k in 'ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','DEEPSEEK_BASE_URL','DEEPSEEK_API_KEY','CLAUDE_CONFIG_DIR','CODEX_HOME') {
  if ($ev.ContainsKey($k)) { "[PRESENT] $k" } else { "[absent] $k" }
}
```

Expected: `读到的变量数` ≥ 50（本机实测 81）；7 行全部 `[absent]`。
> `DSH_HOME` **不算注入**：本机宿主本来就设了它（实测 `C:\Users\zhanglei1120\.dsh`），它属于宿主既有值——Task 7 的比对是「前后一致」，不要求它缺席。
> 方法可行性已实测：`GetProcessById(<外部 pid>).StartInfo.EnvironmentVariables` 在本机（Windows + .NET）能读到**另一个进程**的环境变量（含 `PATH`、`npm_lifecycle_event`）。若执行时抛错或返回 0 项，改用 Task 7 Step 1 的 `NODE_OPTIONS=--import` 备用法，并在记录里写明方法变更。
判定：文件行数 ≥ 50 且 7 行 `[absent]`；否则记录方法异常并转备用法。

- [ ] **Step 11: 写 baseline 证据并确认无入库改动**

```powershell
@(
  "# Task 1 会话前状态",
  "- 分支：$(Get-Content "$smokeRoot\evidence\git-branch.txt")",
  "- HEAD：$(Get-Content "$smokeRoot\evidence\git-head.txt")",
  "- dev PID：$(Get-Content "$smokeRoot\evidence\dev-pid.txt")",
  "- 真实配置哈希：$(Get-Content "$smokeRoot\evidence\real-config-before.sha256")",
  "- 真实配置：$(Get-Content "$smokeRoot\evidence\real-config-before.json" -Raw)",
  "- ~/.runs 存在：$(Get-Content "$smokeRoot\evidence\real-runs-before.txt")"
) | Set-Content "$smokeRoot\evidence\00-baseline.md"
git -C $repo status --porcelain
```

Expected: `git status --porcelain` 仍只有那一行别人的 `?? …interfaces.md`。
判定：出现了别的行 ⇒ 立即停（有人在同一个仓里工作）。**本任务不产出入库文件，无提交。**

---

## Task 2: 冒烟准备（示例仓库、供应商定义、提示词、护栏）

**Files:**
- Create: `$smokeRoot\repo\**`（临时）、`$smokeRoot\evidence\{01-prep.md, sample-repo.txt, models.json, probe.txt, guards.md, leak-scan.txt}`（临时）
- Test: 无

**Interfaces:**
- Consumes: Task 1 的 `$smokeRoot`、`$devPid`、四个环境变量
- Produces: 示例仓库绝对路径 `$sample` 与第一个提交的完整 40 位 hash `$firstHash`；`evidence/models.json`（judge 与三家 agent 行各自用的 `providerId`/`modelId` 选择依据）；`evidence/guards.md`（成本护栏 + 白名单 + 密钥口径）

- [ ] **Step 1: 建沙箱子目录**

```powershell
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
New-Item -ItemType Directory -Force -Path "$smokeRoot\repo","$smokeRoot\aieval-config","$smokeRoot\workspace" | Out-Null
New-Item -ItemType Directory -Force -Path "$smokeRoot\not-a-repo" | Out-Null   # Task 4 Step 4 的负例用
Test-Path "$smokeRoot\aieval-config"; Test-Path "$smokeRoot\workspace"
```

Expected: 两个 `True`。
判定：`$smokeRoot` 不以仓库根 `D:\zhanglei1120\Github\ai-result-evaluation` 开头（这是「不入库」的前提）。

- [ ] **Step 2: 建最小示例仓库（`git init` + 两个提交，命令可直接粘贴）**

```powershell
$sample = Join-Path $smokeRoot 'repo'
git -C $sample init -b main
git -C $sample config core.autocrlf false
git -C $sample config user.name  'p6-smoke'
git -C $sample config user.email 'p6-smoke@localhost'
Set-Content "$sample\math.js" -Encoding utf8 -Value @'
/** 最小示例模块：只做加法，供被测智能体扩展 */
export function add(a, b) {
  return a + b;
}
'@
Set-Content "$sample\README.md" -Encoding utf8 -Value @'
# 最小示例仓库

用于 AI 生成代码评测的端到端冒烟：固定 commit，让每个候选智能体在这里独立改代码。
'@
git -C $sample add math.js README.md
git -C $sample commit -m 'init: 最小示例（math.js + README）'
Set-Content "$sample\strings.js" -Encoding utf8 -Value @'
/** 最小示例模块：只做转大写 */
export function upper(text) {
  return text.toUpperCase();
}
'@
git -C $sample add strings.js
git -C $sample commit -m 'feat: 新增 strings.js'
$sample | Set-Content "$smokeRoot\evidence\sample-repo.txt"
```

Expected（本机已实测同样的命令序列）：三次 `git -C` 命令输出 `Initialized empty Git repository in …/.git/`、`[main (root-commit) <7位>] init: … 2 files changed, 5 insertions(+)`、`[main <7位>] feat: … 1 file changed, 3 insertions(+)`。
失败处置：`fatal: unknown option 'b'` ⇒ git 版本过旧（< 2.28），改用 `git init` + `git symbolic-ref HEAD refs/heads/main` 再提交，并把方法变更写进记录；身份报错 ⇒ 上面的 `git config user.*` 已写进仓库级配置，不该再报。

- [ ] **Step 3: 采集示例仓库事实（给第 2 项做互证基准）**

```powershell
$sample = (Get-Content "$smokeRoot\evidence\sample-repo.txt" -Raw).Trim()
"rev-list --count = $(git -C $sample rev-list --count HEAD)"
"HEAD 完整 hash   = $(git -C $sample rev-parse HEAD)"
"第一个提交完整 hash = $(git -C $sample rev-parse HEAD~1)"
git -C $sample log --format='%h%x09%s' -n 20
"status = [$(git -C $sample status --porcelain)]"
```

Expected: `rev-list --count = 2`；两个 hash 都是 40 位十六进制；`log` 恰好 2 行（`<7位>\tinit: 最小示例（math.js + README）` 与 `<7位>\tfeat: 新增 strings.js`，**顺序为最新在前**）；`status = []`。
判定：`count == 2` 且 `status` 为空 ⇒ 用例可以安全地指向「第一个提交」（它不等于默认分支 HEAD，因此第 2 项的「手工输入任意合法 hash」才是真的可证伪）。把第一个提交的完整 hash 记为 `$firstHash`。

- [ ] **Step 4: 定模型（规则 + 记录，不预设具体名字）**

```powershell
# 网关地址与密钥按 Task 1 Step 2 的口径推导（p3 的两个基础变量 + 可选覆盖）
$probeBase = $env:AIEVAL_PROBE_BASE_URL
$openaiBase = if ($env:AIEVAL_SMOKE_OPENAI_BASE_URL) { $env:AIEVAL_SMOKE_OPENAI_BASE_URL }
              elseif ($probeBase -match '/v1/?$') { $probeBase.TrimEnd('/') }
              else { $probeBase.TrimEnd('/') + '/v1' }
$openaiKey  = if ($env:AIEVAL_SMOKE_OPENAI_KEY) { $env:AIEVAL_SMOKE_OPENAI_KEY } else { $env:AIEVAL_PROBE_API_KEY }
$openaiModels = (Invoke-RestMethod -Uri "$openaiBase/models" -Headers @{ Authorization = "Bearer $openaiKey" }).data
$ids = @($openaiModels | ForEach-Object { $_.id })
"共 $($ids.Count) 个模型"; $ids | Sort-Object | Select-Object -First 40
(($openaiModels | ConvertTo-Json -Depth 4)) | Set-Content "$smokeRoot\evidence\models-openai.json"
```

Expected: `共 N 个模型`（N ≥ 1）；打印出清单与前 40 个 id。
判定与选型规则（写成可复算的规则，不写「选一个合适的」）：
- **评分模型（judge）**：取 `GET {openaiBase}/models` 里第一个命中 `/(flash|mini|small|lite|chat)/i` 的 id；都不命中则取清单第 1 个。
- **codex 行模型**：从同一清单里取 `$judgeModel` 之外的第 1 个 id；清单只有一个模型时与 judge 同款，并把这个理由写进记录。
- **dsh 行模型（anthropic 协议）**：dsh 讲的是 Anthropic Messages（Task 11 实测 `POST {root}/v1/messages` + `x-api-key`，契约 R37）⇒ 它只能用 `冒烟-Anthropic` 那一份手工清单里的模型，**不能借用 openai 侧的 id**；这里取 `$anthModel`（Anthropic 侧只有这一个模型）。
- **claude-code 行模型（anthropic 协议）**：Anthropic 没有 `/models`，规则是「从上面这份 openai 协议清单里挑第一个命中 `/claude/i` 的 id」，用同一个网关的 Claude 型号名；若清单里一个 `claude` 都没有，则用使用者提供的模型名，并把来源写进记录。
- 把选型结果落盘成后续所有任务都读的**唯一文件**：

```powershell
$judgeModel = @($ids | Where-Object { $_ -match '(flash|mini|small|lite|chat)' } | Select-Object -First 1)
if (-not $judgeModel) { $judgeModel = @($ids | Select-Object -First 1) }
$codexModel = @($ids | Where-Object { $_ -ne $judgeModel } | Select-Object -First 1)
if (-not $codexModel) { $codexModel = $judgeModel }
$anthModel  = @($ids | Where-Object { $_ -match 'claude' } | Select-Object -First 1)
if (-not $anthModel) { $anthModel = $env:AIEVAL_SMOKE_ANTHROPIC_MODEL }
# dsh 走 anthropic 协议（Task 11 实测，契约 R37）⇒ 模型必须取自 anthropic 供应商那一份手工清单
$dshModel   = $anthModel
$models = [ordered]@{
  judge         = [ordered]@{ providerName = '冒烟-OpenAI';    modelId = $judgeModel }
  codex         = [ordered]@{ providerName = '冒烟-OpenAI';    modelId = $codexModel }
  dsh           = [ordered]@{ providerName = '冒烟-Anthropic'; modelId = $dshModel }
  'claude-code' = [ordered]@{ providerName = '冒烟-Anthropic'; modelId = $anthModel }
}
($models | ConvertTo-Json -Depth 6) | Set-Content "$smokeRoot\evidence\models.json"
Get-Content "$smokeRoot\evidence\models.json"
```

Expected: 四个 modelId 都非空（`$anthModel` 为空 ⇒ 让使用者提供 `AIEVAL_SMOKE_ANTHROPIC_MODEL`，**不要**猜一个名字）。
失败处置：`Invoke-RestMethod` 失败 ⇒ 这是**环境坏**（密钥/网络/地址形状）；先按 spec §5.6.4 的 `/v1` 口径核对地址（openai 协议要**带** `/v1`、anthropic 协议**不重复** `/v1`），修正后**允许再探一次**（零 agent 成本）。

- [ ] **Step 5: 前置存活探针（各供应商 1 次 `max_tokens: 1`，用于把「模型名写错」与「工具坏」分开）**

```powershell
$probeBase = $env:AIEVAL_PROBE_BASE_URL
$openaiBase = if ($env:AIEVAL_SMOKE_OPENAI_BASE_URL) { $env:AIEVAL_SMOKE_OPENAI_BASE_URL }
              elseif ($probeBase -match '/v1/?$') { $probeBase.TrimEnd('/') } else { $probeBase.TrimEnd('/') + '/v1' }
$anthBase   = if ($env:AIEVAL_SMOKE_ANTHROPIC_BASE_URL) { $env:AIEVAL_SMOKE_ANTHROPIC_BASE_URL } else { $probeBase.TrimEnd('/') }
$openaiKey  = if ($env:AIEVAL_SMOKE_OPENAI_KEY) { $env:AIEVAL_SMOKE_OPENAI_KEY } else { $env:AIEVAL_PROBE_API_KEY }
$anthKey    = if ($env:AIEVAL_SMOKE_ANTHROPIC_KEY) { $env:AIEVAL_SMOKE_ANTHROPIC_KEY } else { $env:AIEVAL_PROBE_API_KEY }
$m = Get-Content "$smokeRoot\evidence\models.json" -Raw | ConvertFrom-Json
$judgeModel = $m.judge.modelId; $anthModel = $m.'claude-code'.modelId
$probe = "$smokeRoot\evidence\probe.txt"
try {
  $b1 = @{ model = $judgeModel; messages = @(@{ role = 'user'; content = 'ping' }); max_tokens = 1 } | ConvertTo-Json -Depth 6
  $r1 = Invoke-WebRequest -Uri "$openaiBase/chat/completions" -Method Post -ContentType 'application/json' `
        -Headers @{ Authorization = "Bearer $openaiKey" } -Body $b1 -UseBasicParsing
  "openai  /chat/completions -> $($r1.StatusCode)  model=$judgeModel" | Add-Content $probe
} catch { "openai  /chat/completions -> FAILED: $($_.Exception.Message)" | Add-Content $probe }
try {
  $b2 = @{ model = $anthModel; max_tokens = 1; messages = @(@{ role = 'user'; content = 'ping' }) } | ConvertTo-Json -Depth 6
  $r2 = Invoke-WebRequest -Uri "$anthBase/v1/messages" -Method Post -ContentType 'application/json' `
        -Headers @{ 'x-api-key' = $anthKey; 'anthropic-version' = '2023-06-01' } -Body $b2 -UseBasicParsing
  "anthropic /v1/messages -> $($r2.StatusCode)  model=$anthModel" | Add-Content $probe
} catch { "anthropic /v1/messages -> FAILED: $($_.Exception.Message)" | Add-Content $probe }
Get-Content $probe
```

（`$anthModel` 取 `evidence/models.json` 里 anthropic 侧手工维护的模型名。）
Expected: 两行状态码 2xx。**只写状态码与模型名，绝不写密钥。**
判定：两行都 2xx ⇒ 进入冒烟；401 ⇒ 密钥/额度（环境坏，**停并告知使用者**）；404/400 ⇒ 模型名或 URL 形状错，按 §5.6.4 修正后**再探一次**；其中一个供应商不可用 ⇒ 记录并停（第 1 项要求两个协议各一个可用供应商）。

- [ ] **Step 6: 落盘护栏与重试白名单**

```powershell
@'
# 成本护栏（本会话唯一一次，禁复跑）
| 序 | 动作 | 模式·行数 | agent 启动 | 文本调用 | 终止/等待 |
| 0 | 存活探针 | — | 0 | 2 | — |
| 1 | AI 生成评分提示词 | — | 0 | 1 | — |
| 2 | Run A | parallel 2 行 | 2 | 2 | 等 judged |
| 3 | Run B 第一次开始 | serial 3 行 | 2 | 1 | 行2 running 时整轮终止 |
| 4 | Run B 第二次开始 | serial 行2/行3 | 2 | 2 | 等 failed |
| 5 | Run D | parallel 3 行 | 3 | 0 | 逐行终止 |
| 合计 | | | 9 | 8 | |

# 允许的重试（零模型调用）
浏览器点击/读取失败、browser_evaluate 表达式写错、DOM 选择器与实现不符（先 browser_snapshot 记录真实结构）、
CLI 语法错误、路径写错、Get-Process 因进程已退出失败、pnpm 网络抖动。失败发生在模型调用之前时重走该步不算复跑。

# 密钥口径
明文只经环境变量 → 界面 Input.Password；不入库、不入 evidence/、不进标准输出。
证据里只写：长度 + 前3后4掩码 + SHA256 前 8 位。

# 失败留证三件套
① 界面原文（message.error / 卡片错误文案 / browser_console_messages error）
② Get-Content "$runDir\rows\$rowId\events.jsonl" -Tail 20
③ 该行 run.json 片段（ConvertTo-Json -Depth 8）+ 上游响应正文
'@ | Set-Content "$smokeRoot\evidence\guards.md"
Get-Content "$smokeRoot\evidence\guards.md" | Select-Object -First 4
```

Expected: 文件写入成功且前 4 行是标题与表头。

- [ ] **Step 7: 泄漏扫描（正控 + 负控，证明扫描不是空转）**

```powershell
$sample = (Get-Content "$smokeRoot\evidence\sample-repo.txt" -Raw).Trim()
$probeBase = $env:AIEVAL_PROBE_BASE_URL
$keys = @(
  $env:AIEVAL_PROBE_API_KEY,
  $env:AIEVAL_SMOKE_OPENAI_KEY,
  $env:AIEVAL_SMOKE_ANTHROPIC_KEY
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique
$files = Get-ChildItem $smokeRoot -Recurse -File
# 正控：示例仓库路径此刻已在证据文件里，必须命中（否则说明扫描没生效）
if ($files | Select-String -SimpleMatch -Pattern $sample -List) { '[正控] 命中：扫描有效' } else { '[正控] 未命中 ⇒ 扫描无效，本步作废' }
"待扫密钥数 = $($keys.Count)（含基础变量与可选覆盖，去重后）"
# 负控：明文密钥不得出现在沙箱任何文件里
foreach ($k in $keys) {
  $hit = $files | Select-String -SimpleMatch -Pattern $k -List
  if ($hit) { "[LEAK] $($hit.Path)" } else { '[clean] 无明文密钥' }
}
# 入库路径同样扫一遍（这三份是唯一会被提交的文件）
Select-String -Path 'README.md','docs\superpowers\notes\2026-09-22-features-smoke.md','docs\superpowers\plans\2026-09-22-features-p6-smoke.md' `
  -SimpleMatch -Pattern $keys -ErrorAction SilentlyContinue
```

Expected: `[正控] 命中：扫描有效` + 每个密钥一行 `[clean] 无明文密钥` + 最后一条无输出。
判定：正控未命中 ⇒ 扫描无效，本步结论作废（清零重做）；负控命中 ⇒ **立即停**，删除命中的文件并排查是哪个步骤把明文落了盘。

- [ ] **Step 8: 写准备就绪清单并收口**

```powershell
@(
  "# Task 2 准备就绪",
  "- smokeRoot: $smokeRoot",
  "- 示例仓库: $sample",
  "- 第一个提交 hash: $firstHash",
  "- 提交数: $(git -C $sample rev-list --count HEAD)；工作树: [$(git -C $sample status --porcelain)]",
  "- 探针: $(Get-Content "$smokeRoot\evidence\probe.txt" -Raw)",
  "- 选型: $(Get-Content "$smokeRoot\evidence\models.json" -Raw)",
  "- 仓库 git status（应仅剩别人那一行）:"
) | Set-Content "$smokeRoot\evidence\01-prep.md"
git -C 'D:\zhanglei1120\Github\ai-result-evaluation' status --porcelain
```

Expected: 仓库 `git status --porcelain` 仍只有那一行 `?? …interfaces.md`。
判定：本任务不产出入库文件，**无提交**。

---

## Task 3: 冒烟第 1 项 —— 建两个供应商（openai 拉模型 / anthropic 手工模型）

**Files:** 无入库文件
**Interfaces:**
- Consumes: Task 1 的 dev 服务（:3083）、Task 2 的 `$openaiBase/$anthBase/$judgeModel/$anthModel`、interfaces §8 的 `ProviderTable` / `ProviderFormModal`、§9 的 `api/providers/**`
- Produces: `evidence/02-providers.md`（第 1 项的判定与证据）、两个供应商的 `providerId`（写进 `evidence/models.json` 供 Task 5–7 使用）

**操作路径（可复现的点击序列）：**

- [ ] **Step 1: 打开供应商 Tab**

1. `browser_navigate` → `http://localhost:3083/settings`
2. `browser_find` → `模型供应商`；`browser_click` 该 Tab
3. `browser_snapshot` → 记下实际 DOM 结构（表格与「添加供应商」按钮的可访问名），把选择器写进 `evidence/02-providers.md`

判定：快照里出现「添加供应商」按钮与空表格（或 `EmptyState`）。

- [ ] **Step 2: 建 openai 协议供应商**

4. `browser_click`「添加供应商」→ `browser_snapshot` 断言弹窗含「名称」「协议类型」「API 地址」「API 密钥」「模型清单」五组控件
5. `browser_type` 名称 = `冒烟-OpenAI`
6. `browser_click` 协议 Radio「OpenAI 兼容」
7. `browser_type` API 地址 = `$openaiBase`（明文只出现在工具调用参数里，不落任何文件）
8. `browser_type` API 密钥 = `$openaiKey`
9. `browser_click`「确定」→ 断言弹窗关闭

Expected: 表格新增 1 行。
失败处置：弹窗未关闭 ⇒ 读表单校验文案；若校验拦住了地址（例如要求 https）⇒ 工具/实现问题，记 ❌ 并读 `browser_console_messages`。

- [ ] **Step 3: 拉模型（openai 协议）+ 断言「合并而非覆盖」**

10. `browser_click` 该行的「拉取模型」
11. 断言成功提示出现、该行「模型数」> 0

```powershell
$cfgPath = "$smokeRoot\aieval-config\config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$openai = $cfg.providers | Where-Object { $_.name -eq '冒烟-OpenAI' }
$openai.models | Group-Object source | Select-Object Name, Count
```

Expected: 出现 `fetched` 分组，条数 ≥ 1。
判定 A（清单真实）：把 `evidence/models-openai.json` 里的 id 集合与 `$openai.models` 的 id 集合比：
```powershell
$apiIds = @((Get-Content "$smokeRoot\evidence\models-openai.json" -Raw | ConvertFrom-Json) | ForEach-Object { $_.id })
$diff = @($openai.models.id | Where-Object { $apiIds -notcontains $_ })
"界面里的模型不在上游清单里的条数 = $($diff.Count)"; $diff
```
Expected: `0`（拉回来的每个 id 都能在上游 `/models` 响应里找到）。

- [ ] **Step 4: 手工加一条模型（为 Step 5 的合并断言留靶子）**

12. 在模型清单里手工 `Input` 一个 id → `browser_click`「添加」。本计划固定用这个 id，便于后续命令直接引用：

```powershell
$manualModel = 'smoke-manual-model-0000'
"$manualModel" | Set-Content "$smokeRoot\evidence\manual-model.txt"
```

13. 断言清单里出现它，来源 Tag 为 `manual`

- [ ] **Step 5: 合并断言（再拉一次，手工项必须还在）**

14. 再 `browser_click`「拉取模型」
15. 断言 `$manualModel` **仍在**清单里，且 `source = manual`

```powershell
$manualModel = (Get-Content "$smokeRoot\evidence\manual-model.txt" -Raw).Trim()
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$openai = $cfg.providers | Where-Object { $_.name -eq '冒烟-OpenAI' }
"manual 条数 = $(@($openai.models | Where-Object source -eq 'manual').Count)；fetched 条数 = $(@($openai.models | Where-Object source -eq 'fetched').Count)"
@($openai.models | Where-Object { $_.id -eq $manualModel }) | Format-Table -AutoSize
```

Expected: `manual 条数 = 1`、`fetched 条数 ≥ 1`、`$manualModel` 仍能查到。
判定（可证伪）：拉取**后** `$manualModel` 仍存在 ⇒ 合并成立；若消失 ⇒ ❌（这正是 spec §6.1「拉取是合并而非覆盖」要拦的缺陷）。

- [ ] **Step 6: 建 anthropic 协议供应商 + 拉取按钮禁用的正反断言**

16. `browser_click`「添加供应商」→ 名称 `冒烟-Anthropic`、协议「Anthropic 兼容」、地址 `$anthBase`、密钥 `$anthKey`
17. 在弹窗**未提交**时：`read_picked_element` 读「拉取模型」按钮 → 断言 `disabled === true`，并记录它的 `getBoundingClientRect()`（宽高都 > 0，证明它是在页面上的真实控件而不是隐藏节点）
18. `browser_hover` 该按钮 → `browser_find` 读 Tooltip 文案 → 断言含 `/models`
19. `browser_type` 手工加模型 = `$anthModel`（值取自 `evidence/models.json` 的 `claude-code.modelId`；为空则先让使用者给出模型名并存回该文件）→ `browser_click`「添加」→ 断言清单出现且来源 `manual`
20. `browser_click`「确定」
21. 复核选型文件里的 claude-code 一条与实际填进去的值一致（防止手抄漂移）：

```powershell
$m = Get-Content "$smokeRoot\evidence\models.json" -Raw | ConvertFrom-Json
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$anth = $cfg.providers | Where-Object { $_.name -eq '冒烟-Anthropic' }
"models.json 里的 claude-code = $($m.'claude-code'.modelId)"
"实际填进 anthropic 供应商的模型 = $((@($anth.models.id)) -join ', ')"
"一致 = $(@($anth.models.id) -contains $m.'claude-code'.modelId)"
```

Expected: 表格共 2 行。
失败处置：禁用断言失败（按钮可点）⇒ 记为 ❌ 并留证（这是 F1/§6.1 的回归点）；提交后确认：

```powershell
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
"providers = $(@($cfg.providers).Count)"
$cfg.providers | Select-Object name, protocolType, baseUrl,
  @{n='models';e={@($_.models).Count}},
  @{n='keyLen';e={$_.apiKey.Length}},
  @{n='keyMask';e={$_.apiKey.Substring(0,3) + [char]0x2026 + $_.apiKey.Substring($_.apiKey.Length-4)}} |
  Format-Table -AutoSize
```

- [ ] **Step 7: 设置域交接的三项核对（零模型调用；p1 Task 9 Step 8 的落点）**

> 来源：p1（设置域）Task 9 Step 8 的交接。三项都不花模型调用，各自都有**可证伪的判据**；它们覆盖的正是 p1 里
> **没有自动化测试**的那层（`apps/web-next` 保留 `jsx: preserve`，该应用内不能写 `.tsx` 测试）。
> 下文每个 fence 都**自包含**：`pwsh` 每次调用是新进程，`$smokeRoot` 从固定指针重读、`$cfgPath` 就地定义。

**① 两汉字按钮的可访问名（app 级 `autoInsertSpace: false` 的正控）**

`apps/web-next/app/providers.tsx` 在 `ConfigProvider` 上关掉了 `button.autoInsertSpace`（p1 Task 8 义务 C）。
`provider-table.tsx` / `provider-form-modal.tsx` / `workspace-settings-card.tsx` 里的按钮**本来就各自带**该 prop
（对它们是负控）；**只有 `packages/client/ui/src/base/empty-state.tsx` 的引导按钮没单独传**，而它的 label 由调用方给
—— 正控只能从它来。

> **更正（p1 交接时发现，别按旧口径找控件）**：`demo-list-page.tsx` 的「关闭」按钮也曾是正控，但 `/demo` 三件套
> **由 p2 Task 9 删除**，且本计划 Task 1 Step 6 已断言 `apps/web-next/app/demo/page.tsx` **不存在**（仍存在 ⇒ p2 未完成）。
> 所以 p6 时**不要**去 `/demo` 找一个「关闭」按钮，找不到不是缺陷。

`browser_navigate` → `http://localhost:3083/settings` → 「模型供应商」Tab → `browser_evaluate`：

```js
// 全量盘点：每个按钮的可见文案 vs 可访问名（antd 插空格会让两者都变成「编 辑」）
[...document.querySelectorAll('button')].map((b) => ({
  text: b.innerText,
  name: b.getAttribute('aria-label') ?? b.innerText,
  len: [...b.innerText].length,
}))
```

判定（按实际情况选一条，**不许合并成一句「正常」**）：
- **负控（必查）**：清单里**没有任何**按钮的 `text` 形如 `/^[\u4e00-\u9fa5] [\u4e00-\u9fa5]$/`（两汉字被插空格）。
- **正控（清单里出现 `len === 2` 的按钮时才查）**：那个按钮的 `text` 必须没有空格。p2/p5 的 `/cases`、`/runs` 空态
  若给了两汉字的 `EmptyState.action.label`，就去那一页读它，并把页面路径与文案写进证据。
- **正控不可得**（全站 `len === 2` 的按钮数为 0）：如实记「正控不可得：现有按钮标签长度都 ≠ 2，本项只证明了
  『没有被插空格的按钮』」，**不许**写成「义务 C 已验证生效」。
证据：把这份 JSON 清单与判定分支写进 `02-providers.md`。

**② 工作区「校验并保存」（spec §6.3 / §12 的执行步骤；同时把沙箱的 workspaceRoot 落定）**

> 为什么必须在这里做：本计划**没有别的步骤**把 `workspaceRoot` 指到 `$smokeRoot\workspace`，不设它就用默认的
> `~/.runs`（**真实家目录**）—— 评测产物会落到使用者的 home 下（本计划开篇的护栏第 2 条）。设置页的
> 「校验并保存」正是做这件事的入口，所以这一步既是功能核对、也是后续所有 Run 的前置。

```powershell
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
$cfgPath = "$smokeRoot\aieval-config\config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
"改之前 workspaceRoot = $($cfg.workspaceRoot)"
```

1. `/settings` → 「工作区」Tab → 「工作区根目录」填 `$smokeRoot\workspace`（Task 2 Step 1 已建好的沙箱目录）→ 点「校验并保存」。
2. 界面 + 落盘两侧互证：

```powershell
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
$cfgPath = "$smokeRoot\aieval-config\config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
"改之后 workspaceRoot = $($cfg.workspaceRoot)"      # 期望：绝对路径（不是 ~ 形式）
"与沙箱一致 = $($cfg.workspaceRoot -eq (Join-Path $smokeRoot 'workspace'))"
```

Expected：界面出现绿色 `Alert`「工作区可用：<绝对路径>」**且** `与沙箱一致 = True`。
判定：界面说成功而盘上没变 ⇒ ❌（响应与落盘不一致），停下读 `browser_console_messages` 与 `PUT /api/settings` 的响应。
3. 负控：用**同名文件**占住一个路径，再点一次「校验并保存」：

```powershell
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
New-Item -ItemType File -Force -Path "$smokeRoot\ws-blocked" | Out-Null
"ws-blocked 存在且是文件 = $((Test-Path "$smokeRoot\ws-blocked") -and -not (Test-Path "$smokeRoot\ws-blocked" -PathType Container))"
```

浏览器：把输入框改成 `$smokeRoot\ws-blocked` → 点「校验并保存」。
判定：出现**红色** `Alert` 且文案含服务端中文原因「无法创建工作区根目录」；**输入框保留刚填的值**（不被弹回旧值）；
落盘值**未变**：

```powershell
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
$cfg = Get-Content "$smokeRoot\aieval-config\config.json" -Raw | ConvertFrom-Json
"负控后仍是沙箱 = $($cfg.workspaceRoot -eq (Join-Path $smokeRoot 'workspace'))"
```

任一条不成立 ⇒ ❌（`NOT_WRITABLE` 时还写盘属数据损坏级缺陷），按「失败留证三件套」留证。
4. 收尾：把输入框改回 `$smokeRoot\workspace` 并再点一次「校验并保存」，确认又变绿 —— **后续所有 Run 的产物都落在它下面**。
   本步的 ❌ 不阻塞第 1 项的判定，但**第 4 条收尾没做完，不得进入任何 Run**。

**③ 两条接口 backstop（绕过界面直接打接口；用 `curl.exe` —— PS 里 `curl` 是 `Invoke-WebRequest` 的别名）**

```powershell
$smokeRoot = (Get-Content (Join-Path $env:TEMP 'aieval-p6-smoke-latest.txt') -Raw).Trim()
$cfgPath = "$smokeRoot\aieval-config\config.json"
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$anthId = ($cfg.providers | Where-Object { $_.name -eq '冒烟-Anthropic' }).id

# ① anthropic 协议：服务端必须自己拒绝拉取（前端禁用按钮只是体验，老页面缓存 / 直连接口都绕得过去）
$code = curl.exe -s -o "$smokeRoot\evidence\fetch-anth.body" -w "%{http_code}" `
        -X POST "http://localhost:3083/api/providers/$anthId/models/fetch"
"HTTP $code"; Get-Content "$smokeRoot\evidence\fetch-anth.body"

# ② 明文只进不出：盘上是明文（无 * 号、长度 ≥ 8），HTTP 响应里只有掩码
"盘上明文条数 = $(@($cfg.providers | Where-Object { $_.apiKey -notmatch '\*' -and $_.apiKey.Length -ge 8 }).Count) / $(@($cfg.providers).Count)"
curl.exe -s -o "$smokeRoot\evidence\providers-list.body" "http://localhost:3083/api/providers"
$list = Get-Content "$smokeRoot\evidence\providers-list.body" -Raw | ConvertFrom-Json
"列表第一条的键名 = $(($list | Select-Object -First 1).PSObject.Properties.Name -join ', ')"
"带明文 apiKey 键的条数 = $(@($list | Where-Object { $_.PSObject.Properties.Name -contains 'apiKey' }).Count)"
```

Expected：① `HTTP 400`，正文含「Anthropic 兼容协议没有 /models 接口」；
② `盘上明文条数 = 2 / 2`；键名里有 `apiKeyMasked`、**没有** `apiKey`；带明文键的条数 `= 0`。
判定：① 返回 200 或 5xx ⇒ ❌（服务端没有 backstop，只靠按钮禁用）；② 出现 `apiKey` 键或明文条数 < 2 ⇒ **立即停**
（明文下行或明文没落盘，都是安全口径破了），删掉刚写的两个 `.body` 并排查。
> **2026-09-26 修订**：上面的 ① 已作废 —— 该请求如今应当返回 **200 + 模型清单**（协议不再参与判定），
> 「返回 200 ⇒ ❌」的判据反过来才是对的。②（明文/掩码口径）不受影响，照旧。
> 沿用勘误手法：**上面这组 Expected 与判定保留原文不改**，它们只在 2026-09-26 之前成立。
（「一次上游请求都没发」这半边由 `apps/web-next/src/route-providers.test.ts` 的假上游用例钉住，冒烟只验真实 HTTP 的形状。）
证据：两个 `.body` + 上面四行输出写进 `02-providers.md`；密钥本身按 `guards.md` 的口径**只记长度与掩码**。

- [ ] **Step 8: 判定与本项收口**

**判定（可证伪，全部要贴实测值）：**
1. `@($cfg.providers).Count -eq 2`，且两条的 `protocolType` 集合等于 `{openai, anthropic}`。
2. openai 供应商 `models` 里 `source='fetched'` 条数 ≥ 1，且这些 id **逐个**能在 `evidence/models-openai.json` 里找到（Step 3 的 `$diff.Count -eq 0`）。
3. anthropic 供应商的「拉取模型」控件 `disabled === true`、`rect.width > 0 && rect.height > 0`、Tooltip 文案含 `/models`；其 `models` 至少 1 条 `source='manual'`。
4. 合并断言：拉取后 `$manualModel` 仍在（Step 5）。
5. 界面表格的密钥列文本**不含**明文密钥，且**包含**明文前 3 与后 4 字符（`keyLen ≥ 8` 时）；`keyMask` 与界面文本一致。
6. 真实 `~/.aieval` 未被写：`(Get-FileHash "$env:USERPROFILE\.aieval\config.json").Hash` 与 `evidence/real-config-before.sha256` **逐字符相同**。

任意一条不成立 ⇒ 记 ❌ + 现象 + 三件套证据；若第 6 条不成立 ⇒ **立即停**（Review Focus 第 2 条）并把该次写入的内容与还原方式写进记录。

- [ ] **Step 9: 收口**

把操作序列、实测值、判定写进 `evidence/02-providers.md`；把两个 `providerId` 回填进 `evidence/models.json`。本任务不产出入库文件，**无提交**。

---

## Task 4: 冒烟第 2 项 —— 建用例（AI 生成评分提示词、仓库与 commit 校验）

**Files:** 无入库文件
**Interfaces:**
- Consumes: Task 2 的 `$sample`/`$firstHash`、Task 3 的两个供应商、interfaces §8 的 `CaseFormPanel`、§9 的 `api/cases/**`、§6 的 `generateJudgePrompt`
- Produces: `evidence/03-case.md`、`caseId`、`runId` 的父级（用例）

**操作路径：**

- [ ] **Step 1: 进入创建表单**

1. `browser_navigate` → `http://localhost:3083/cases`
2. `browser_snapshot` → 记录列表列头与「创建用例」按钮
3. `browser_click`「创建用例」→ 断言右栏出现创建表单、URL 含 `panel=new`

Expected: 右栏（不是弹窗、不是整页）出现表单。
判定：URL query 含 `panel=new`（可证伪：整页跳转或弹层都算 ❌）。

- [ ] **Step 2: 填标题与考题提示词**

4. `browser_type` 标题 = `冒烟-最小示例`
5. `browser_type` 考题提示词 = 下面这段（**最小提示词**，全文照抄）：

```
在 math.js 里新增并导出 multiply(a, b) 函数（返回 a * b）。只改这一个文件。
```

Expected: 两个输入框有值。
判定：考题正文字数 ≤ 60（成本护栏：最短提示词；超过说明填错了）。

- [ ] **Step 3: 校验仓库（正例）**

6. `browser_type` 代码仓库 = `$sample`
7. `browser_click`「校验」→ 断言回显仓库名与当前分支

```powershell
$repoName = Split-Path $sample -Leaf
"期望仓库名 = $repoName；期望分支 = $(git -C $sample branch --show-current)"
```

Expected: 界面回显的仓库名 == `repo`、分支 == `main`（与上面命令输出逐字相同）。

- [ ] **Step 4: 校验仓库（负例，零模型成本，可证伪）**

8. 把代码仓库改成 `$smokeRoot\not-a-repo`（先建这个普通目录：`New-Item -ItemType Directory -Force "$smokeRoot\not-a-repo"`）→ `browser_click`「校验」
9. 断言：出现错误提示，文案含**具体原因**（`NOT_A_GIT_REPO` 口径：指出路径不是 git 仓库），且仓库名/分支**没有**被回显

Expected: 错误文案非空且含该路径或 git 原文。
失败处置：若无任何提示或提示是「请求体不是合法 JSON」⇒ ❌（错误映射错位），留证：界面文案 + `browser_console_messages`。

- [ ] **Step 5: commit 候选下拉 + 手工输入合法 hash（正例）**

10. 把仓库改回 `$sample` → 再「校验」→ 确认回显恢复
11. 打开 commit 候选下拉 → `browser_evaluate` 读选项文本 → 断言恰好 2 条，且与 `git log --format='%h%x09%s' -n 20` 的 2 行**逐字一致**
12. 关闭下拉，**手工输入** `$firstHash`（40 位完整 hash，不是短哈希）→ 断言输入框 `value === $firstHash`

Expected: 下拉 2 条；输入框是 40 位。
判定（可证伪）：下拉项文本 == `git log` 输出；输入框保留完整 40 位（若被截断成 7 位 ⇒ ❌，spec §4.2 明确「手工输入任意合法 hash 必须仍然可行」）。

- [ ] **Step 6: commit 负例 + AI 生成评分提示词**

13. 把 commit 改成 40 个 `0` → 断言出现 `INVALID_REF` 口径的错误（文案含该 hash 或「不存在」），且表单不保存
14. 改回 `$firstHash`
15. `browser_click`「AI 生成」→ 等待（1 次文本调用）→ 断言：评分提示词 TextArea 被回填（`value.length > 0`）、表单下方出现 **5 个**维度的只读预览

```powershell
# 输出契约真源（p0 建在 contracts，生成侧与解析侧共用同一份）
Select-String -Path 'packages\server\contracts\src\score.ts' -Pattern 'JUDGE_OUTPUT_CONTRACT' -Context 0,25
# 维度顺序真源
Select-String -Path 'packages\server\contracts\src\score.ts' -Pattern "key: '(correctness|requirement|quality|robustness|maintainability)'"
```

Expected: 两个命令都有输出；把 5 个 key 的顺序抄下来作为 Step 7 的比对基准。

- [ ] **Step 7: 保存并核对落盘**

16. `browser_click`「保存」→ 断言列表出现该用例行（标题 / 仓库名 / 7 位短哈希 / 更新时间）
17. `browser_navigate` 同 URL 刷新 → 点该行 → 断言详情栏显示，值仍在

```powershell
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$case = $cfg.cases[0]
"cases = $(@($cfg.cases).Count)"
$case | Select-Object title, repoPath, commitHash, @{n='judgePromptLen';e={$_.judgePrompt.Length}}, judgeProviderId, judgeModelId | Format-List
"commitHash 长度 = $($case.commitHash.Length)（期望 40）"
"git 侧解析 = $(git -C $sample rev-parse $firstHash)"
# 输出契约断言：5 个维度 key 必须都出现在生成的提示词里，且必须点名 JSON
$missKeys = @('correctness','requirement','quality','robustness','maintainability') |
            Where-Object { $case.judgePrompt -notmatch $_ }
"提示词里缺失的维度 key = $(@($missKeys).Count)（期望 0）"; $missKeys
"提示词里出现 JSON = $($case.judgePrompt -match 'JSON')（期望 True）"
# 与真源做一次逐字抽查：真源片段长度不足 12 时本断言作废（不得判通过），改用上面两条
$contract = (((Select-String -LiteralPath 'packages\server\contracts\src\score.ts' -Pattern 'JUDGE_OUTPUT_CONTRACT' -Context 0,25).Context.PostContext) -join "`n")
if ($contract.Length -ge 12) {
  "真源片段抽查 12 字包含 = $($case.judgePrompt.Contains($contract.Substring(0,12)))"
} else { '真源片段不足 12 字 ⇒ 本条作废（以上面两条断言为准）' }
```

Expected: `cases = 1`；`repoPath` == `$sample`；`commitHash.Length == 40` 且等于 `git rev-parse` 的输出；`judgePromptLen > 0`；`缺失的维度 key = 0`；`出现 JSON = True`。

**判定（可证伪）：**
1. `@($cfg.cases).Count -eq 1`；`title == '冒烟-最小示例'`；`repoPath == $sample`；`commitHash == (git -C $sample rev-parse $firstHash)`（40 位逐字符相等）。
2. `git -C $sample cat-file -e "$firstHash^{commit}"; $LASTEXITCODE` == 0。
3. 维度预览恰好 5 项，key 顺序 == `score.ts` 里 `DIMENSIONS` 的顺序（抄自 Step 6）。
4. 生成的 `judgePrompt` 五条并验：① 5 个维度 key（`correctness` / `requirement` / `quality` / `robustness` / `maintainability`）**逐个**出现在提示词里（`缺失 = 0`）；② 提示词里出现 `JSON`；③ 与 `JUDGE_OUTPUT_CONTRACT` 真源的 12 字抽查包含为 `True`（真源片段不足 12 字时以 ①② 为准并记明原因）。
5. 两个负例（非 git 仓库、非法 hash）都给出了含具体原因的中文错误，且都**没有**放行保存。

**失败处置：**
- 「AI 生成」失败（网络/限额/返回不是合法 JSON）⇒ 断言「已有内容**不被清空**」+ `message.error` 呈现原因；**留证三件套**后进入兜底：从 `contracts/src/score.ts` 读出 `JUDGE_OUTPUT_CONTRACT` 的**完整字面量**，前面拼一句「下面是考题、候选的代码改动与维度定义；只按下面的输出契约回复」，粘贴进评分提示词（这是唯一允许的兜底写法——它没有发明任何字段名，因为字段名来自真源）；第 2 项的「AI 生成」判 ❌（附原始报错），其余断言照常判。
- 校验通过但落盘 `commitHash` 为空/被截断 ⇒ ❌（表单没提交该字段）。

- [ ] **Step 8: p2 评审遗留的三项界面复核（零模型成本；这三条在 p2 阶段无测试面或当时无可用服务，故落到本项）**

> 三条都是 p2 阶段评审记账的遗留（见 `.superpowers/sdd/2026-09-22-features-p2-cases/progress.md` §遗留 3/4）。
> 前两条在 p2 的修复波里已经各有一个变异体证明过（M1 / M4），**这里做的是真实浏览器里的复核**；
> 第三条（`stale` 渲染那一半）**只有结构性论证**，本步是它唯一的端到端证据，所以务必做完。

**8a. `/cases?panel=new` 打开后控制台没有 antd 弃用告警**

```powershell
# 先证明控制台通道是活的（否则「没有告警」可能只是没抓到消息）
# browser_console_messages(level: 'info', all: true) → 断言返回**非空**（Next 的启动/HMR 消息即可）
# 再断言：没有任何一条匹配 '[antd:' 且同时匹配 'deprecated'
```

判定：控制台消息列表**非空**（通道活着）**且** `[antd:` + `deprecated` 的命中数为 0 ⇒ ✅。
命中数 > 0 ⇒ ❌，把那条消息原文抄进记录（`addonAfter` 那类 error 级告警只在开发/测试环境出现，生产静默，所以只能在 dev 服务上抓）。

**8b. 「重新加载候选」真的重取候选，且不顺带刷列表**

1. 在创建表单里填好 `repoPath`（`$sample`）→ `browser_click`「重新加载候选」（`data-testid="case-load-commits"`）
2. `browser_network_requests(filter: '/api/cases/commits')` → 记下 POST 计数 N1
3. `browser_click` 同一个按钮 → 再取一次，记下 N2

判定：`N2 == N1 + 1`（**恰好 +1**：过滤器命中 ⇒ 重取；若 `N2 == N1` 说明 `matchesCommitsKey` 没命中，页面静默什么都不发——这正是 p2 修掉的缺陷形态）**且**同一段时间里 `/api/cases`（列表，GET，不含 `/commits`）的请求计数**没有增加**（重取候选不得顺带刷列表）⇒ ✅。
`N2 == N1` ⇒ ❌，留证：两次 `browser_network_requests` 的原始输出。

**8c. 详情刷新失败时右栏仍在编辑表单上，输入不丢（`stale` 分支，p2 无测试面的那一半）**

1. `browser_navigate` → `/cases?panel=edit&id=<caseId>`，等表单出现已有值
2. `browser_type` 往标题（`data-testid="case-title"`）里追加一个哨兵串（例如 `-SMOKE-STALE`），**不要保存**
3. 用 Playwright 让**下一次**单条详情的 GET 失败（只拦单条，放行列表）：

```js
// browser_run_code_unsafe：装路由 + 触发一次 SWR 重新校验
// 1) 只拦单条 GET：/api/cases/<id>，不含 /api/cases 列表、不含 POST
await page.route(/\/api\/cases\/[^/?]+$/, async (route) => {
  if (route.request().method() === 'GET') {
    await route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL', message: '冒烟注入的失败' } }) });
  } else { await route.continue(); }
});
// 2) 触发重新校验：`useTestCase` 没有关掉 SWR 默认的 revalidateOnFocus（关掉的是写请求的候选 hook）
await page.evaluate(() => window.dispatchEvent(new Event('focus')));
await page.waitForSelector('[data-testid="case-detail-stale"]', { timeout: 5000 });
```

判定（**两条一起看**，缺一不可）：
- `[data-testid="case-detail-stale"]` 出现，文案含「上一次成功读取的内容」；**并且**
- 标题输入框的值**仍以 `-SMOKE-STALE` 结尾**（表单实例没被卸载、输入没丢），页面**没有**变成「用例不存在」。

❌ 的形态与含义：出现了「用例不存在」或标题里的哨兵串消失 ⇒ 说明 `stale` 分支没生效（p2 之前的行为），是**输入被静默吞掉**这一类缺陷复发；留证：`browser_snapshot` + 注入前后的两个输入框值。
兜底：若 `focus` 没能触发重新校验（5 秒内没出现告警），改用 `page.reload()` 之外的任何**用户可达**动作换来一次详情重取，并把实际用的动作写进记录；实在换不来就在记录里写「本步未能触发」（**不得**改判成通过）。

- [ ] **Step 9: 收口**

把操作序列、实测值、判定写进 `evidence/03-case.md`。本任务不产出入库文件，**无提交**。

---

## Task 5: 冒烟第 3–6 项 —— 并行两行、实时跳动、CLI 互证、出分核对

**Files:** 无入库文件
**Interfaces:**
- Consumes: Task 4 的用例、Task 3 的两个供应商与模型、interfaces §6 的 `createRun/startRun/getRowDiff`、§7 的 `useRowStream`、§8 的 `RunCreatePanel/RunDetailPanel/EvalRowCard/ScoreBars/DiffView/LogView`、§9 的 `runs/**` 路由
- Produces: `evidence/04-runA.md`（第 3–6 项判定）、Run A 的 `runId`/两个 `rowId` 与工作区路径（供 Task 7 Step 2 复用）

- [ ] **Step 1: 建 Run A（第 3 项前半：表单与协议过滤）**

1. `browser_navigate` → `http://localhost:3083/runs`
2. `browser_click`「创建评测」→ 断言右栏出现创建表单（`panel=new`）
3. 用例 `Select`：断言选项文本形如 `冒烟-最小示例 · repo · <7位哈希>`；选中它
4. 执行模式 `Radio.Group`：断言**默认选中「并行」**（读 `browser_evaluate` 的 checked 状态）
5. 候选行 1：智能体选 `Claude Code` → 打开模型 Select → `browser_evaluate` 读出全部选项文本 → 断言其中每个 modelId 都属于 `protocolType = 'anthropic'` 的供应商
6. 选中 `$anthModel` 那一项
7. `browser_click`「添加候选行」→ 行 2：智能体选 `Codex` → 读模型选项 → 断言每个 modelId 都属于 `protocolType = 'openai'` 的供应商（允许包含 `manual` 来源）→ 选中 codex 用的模型

```powershell
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
# F2 的判据：协议 → 供应商 → 模型，逐项对照
$cfg.providers | ForEach-Object { "$($_.protocolType)`t$($_.name)`t$((@($_.models.id) -join ','))" }
```

Expected: anthropic 侧只有 `$anthModel`；openai 侧有 `$judgeModel` 等。
判定：**逐个**核对「下拉里出现的 modelId」都能在上面这张表里找到，且其供应商协议与智能体要求的协议一致（claude-code→anthropic、codex→openai）。任一不符 ⇒ ❌（F2 过滤失效）。

- [ ] **Step 2: 空池 Alert 的正反两面（零模型成本）**

8. 去 `/settings` → `模型供应商` → 把 anthropic 供应商的 `$anthModel` **删除**
9. 回 `/runs` 的创建表单 → 断言 claude-code 那一行立即出现内联 `Alert`，文案含协议名与「设置」类去向指引
10. `browser_evaluate` 读该 Alert 文本与 `getBoundingClientRect()`（宽高 > 0）
11. 回 `/settings` 把 `$anthModel` **手工加回**（来源变成 `manual`，记录这一差异）
12. 回 `/runs` → 断言 Alert 消失、模型可选、选中项仍是 `$anthModel`

Expected: 第 9 步有 Alert、第 12 步无 Alert。
判定（正反两面都可证伪）：删模型后有 Alert、加回后消失 ⇒ ✅；只有一面成立 ⇒ ❌ 并留证（截图 + 快照 + `browser_console_messages`）。

- [ ] **Step 3: 创建并开始（第 3 项后半 + 第 4 项前半）**

13. `browser_click`「创建」→ 断言进入详情（右栏 `panel=detail&id=…`），状态 `idle`
14. 不靠抄 URL：**run 目录名就是 runId**，直接从磁盘取（零歧义、可复算）：

```powershell
$runDirs = @(Get-ChildItem "$smokeRoot\workspace" -Directory | Where-Object { Test-Path "$($_.FullName)\run.json" })
"候选 run 目录数 = $($runDirs.Count)（Task 5 此处应为 1）"
$runDir  = $runDirs[0].FullName
$runId   = $runDirs[0].Name
$runId | Set-Content "$smokeRoot\evidence\runA.id"
"runId = $runId;  run.json 存在 = $(Test-Path "$runDir\run.json")"
```

Expected: `候选 run 目录数 = 1`（本会话此时只创建过这一个评测）。
判定：数量 ≠ 1 ⇒ 先弄清是不是有别的 run 残留（`Get-ChildItem` 列出全部），不要盲取第一个。

15. `browser_click` 吸底「开始」→ 断言弹出 `Modal.confirm`，**列出本次将执行的候选清单**（逐行含智能体名与模型名；`browser_evaluate` 读弹窗正文）
16. 确认 → 立刻开始采样

```powershell
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
"status=$($run.status) mode=$($run.executionMode) rows=$(@($run.rows).Count)"
$run.rows | Select-Object id, agentKind, providerId, modelId, status, branch, workspacePath, baselineCommit | Format-Table -AutoSize
```

Expected: `mode=parallel`、`rows=2`、两行 `status=pending`、`branch == 'test/' + id`、`baselineCommit` 是 40 位且等于用例的 `commitHash`。

- [ ] **Step 4: 第 4 项 —— 两行同时 running + 计量实时跳动**

17. 轮询 `run.json` 直到两行都 `running`（`Get-Content` 读 `status`），记录两行 `startedAt`
18. 对卡片做**两次**采样，间隔 ≥ 5 秒：

```js
() => [...document.querySelectorAll('.ant-card')].map(c => ({
  text: c.innerText.replace(/\s+/g, ' ').trim(),
  w: Math.round(c.getBoundingClientRect().width),
  h: Math.round(c.getBoundingClientRect().height),
}))
```

19. 若 `.ant-card` 数量为 0 ⇒ 先 `browser_snapshot` 记录真实结构，再按结构改写选择器重读（白名单内的「工具坏」重试），把最终选择器写进证据

**判定（可证伪）：**
1. 存在同一时刻两行都 `status === 'running'`；`|startedAt(row1) - startedAt(row2)| ≤ 2000ms`（实测值记录，单位 ms）。
2. 每行的 `durationMs` 在两次采样间**严格递增**（这一条对三家适配器都成立，是「实时刷新」的最低判据）。
3. `tokens` 与 `turns` **按行分别判**：
   - `run.json` 里该行 `tokens === null` ⇒ 界面文案必须含「不支持计量」或「未采集」，且该行卡片的文本里**不出现 `0`**（Review Focus 第 4 条：把 null 记成 0 是最容易发生的假通过）；
   - `tokens !== null` ⇒ `output` 在两次采样间非递减且至少一次严格增加；`turns` 同理。
4. 两行都采不到 tokens 且都显示「不支持计量」⇒ 第 4 项判**部分通过**（实时用量未验证），写进未覆盖项。
5. `events.jsonl` 里 `usage` 事件若存在，其数值必须与 `run.json` 的 `tokens` 逐字段相等。

- [ ] **Step 5: 第 5 项 —— CLI 复核分支、工作区与 diff（与页面互证）**

20. 等两行到终态后，读两行的 `workspacePath`：

```powershell
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
foreach ($row in $run.rows) {
  "== row $($row.id)  agent=$($row.agentKind)  status=$($row.status)"
  "branch 实际 = $(git -C $row.workspacePath branch --show-current)   期望 = test/$($row.id)"
  "status --porcelain:"; git -C $row.workspacePath status --porcelain
  "diff stat vs baseline:"; git -C $row.workspacePath diff --stat $row.baselineCommit
  "rev-parse HEAD = $(git -C $row.workspacePath rev-parse HEAD)"
  "workspace 存在 = $(Test-Path -LiteralPath $row.workspacePath)  agenthome 存在 = $(Test-Path -LiteralPath (Join-Path (Split-Path $row.workspacePath -Parent) '.agenthome'))"
  "events.jsonl 行数 = $(@(Get-Content (Join-Path (Split-Path $row.workspacePath -Parent) 'events.jsonl')).Count)"
}
```

21. 打开该行「查看改动」抽屉 → `browser_evaluate` 读文件清单与计数文本 → 与 CLI 数字对。抽屉的正文标准容器是 `.ant-drawer-body`（`MonoText` 只在**调用方传了** `dataTestId` 时才带 testid，所以先 `browser_snapshot` 记下实际结构、再决定用 `.ant-drawer-body` 还是更精确的选择器，**并把最终选择器写进证据**）：

```js
() => [...document.querySelectorAll('.ant-drawer-body')].map(d => d.innerText.replace(/\s+/g, ' ').trim())
```

```powershell
foreach ($row in $run.rows) {
  $names = @(git -C $row.workspacePath diff --name-only $row.baselineCommit)
  $numstat = git -C $row.workspacePath diff --numstat $row.baselineCommit
  "row $($row.id): 文件数=$($names.Count)"; $numstat
  "run.json 摘要: filesChanged=$($row.diff.filesChanged) insertions=$($row.diff.insertions) deletions=$($row.diff.deletions) truncated=$($row.diff.truncated)"
}
```

**判定（可证伪）：**
1. 每行 `git branch --show-current` == `test/{rowId}`；`workspacePath` 与两行**互不相同**（F6 隔离的现场证据）。
2. 每行 `git status --porcelain` **非空**（agent 真的在 `cwd` 里干过活）。
3. 页面「查看改动」里的 `filesChanged / insertions / deletions` 三个数字与 `git diff --numstat {baseline}` 归并出来的三个数字**逐项相等**；不相等即 ❌ 并留证（这条是「三样 diff 合并」口径 R3 的现场检验）。
4. 抽屉里的文件路径集合 == `git diff --name-only {baseline}` ∪ `git status --porcelain` 里 `??` 开头的路径集合。
5. `baselineCommit` 是 40 位且等于用例的 `commitHash`（R2）。

- [ ] **Step 6: 第 6 项 —— 出分核对（硬等式）**

22. 等两行 `judged`，读卡片与「评分详情」抽屉：

```js
() => [...document.querySelectorAll('.ant-card')].map(c => c.innerText.replace(/\s+/g, ' ').trim())
```

```powershell
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
foreach ($row in $run.rows) {
  $s = $row.score
  $sum = (@($s.dimensions | ForEach-Object { $_.score }) | Measure-Object -Sum).Sum
  # JS 的 Math.round 对 .5 向上取整；PowerShell 默认是银行家舍入，必须显式 AwayFromZero，否则会造出假 ❌
  $expected = [math]::Round($sum / (5 * 5) * 100, [System.MidpointRounding]::AwayFromZero)
  "row $($row.id): 维度数=$(@($s.dimensions).Count) sum=$sum 期望总分=$expected 实际总分=$($s.totalScore) 一致=$($expected -eq $s.totalScore)"
  "维度 key 顺序 = $((@($s.dimensions.key)) -join ',')"
  "每维分数 = $((@($s.dimensions.score)) -join ',')"
  "verdict 非空 = $(-not [string]::IsNullOrWhiteSpace($s.verdict))  raw 长度 = $($s.raw.Length)"
  "judgeProviderId=$($s.judgeProviderId) judgeModelId=$($s.judgeModelId) judgedAt=$($s.judgedAt)"
}
# events.jsonl 的 seq 检查（执行器坏掉最先坏在这里）
foreach ($row in $run.rows) {
  $f = Join-Path (Split-Path $row.workspacePath -Parent) 'events.jsonl'
  $seqs = @(Get-Content $f | ForEach-Object { ($_ | ConvertFrom-Json).seq })
  $mono = $true; for ($i = 1; $i -lt $seqs.Count; $i++) { if ($seqs[$i] -le $seqs[$i - 1]) { $mono = $false } }
  "row $($row.id): 事件数=$($seqs.Count) 首 seq=$($seqs[0]) 严格递增=$mono 末类型=$((Get-Content $f -Tail 1 | ConvertFrom-Json).type)"
}
```

**判定（可证伪）：**
1. 两行 `status === 'judged'`；`@($s.dimensions).Count === 5`；5 个 key 的集合与顺序 == `score.ts` 的 `DIMENSIONS`。
2. 每个维度 `score` 是 1–5 的整数。
3. **卡片上显示的总分 == `round(sum/(5*5)*100)` == `run.json` 的 `totalScore`**（三处相等；上面脚本算的 `期望总分` 与 `实际总分` 必须 `True`，且卡片文本里解析出来的总分与它们相等）。
4. 卡片上的 5 维分值与「评分详情」抽屉里读到的 5 维**逐项相等**（同一份数据两处渲染）。
5. `events.jsonl`：首 `seq === 1`、严格递增、末条 `type === 'end'` 且 `exitReason === 'completed'`；存在 `score` 事件且其 `score.totalScore` == `run.json` 的 `totalScore`。
6. 排序与徽标（口径由 p5 钉死：出分后按总分降序、**前三名带徽标、同分同名次**，徽标文案是 `第 {rank} 名` 的金色 `Tag`）：
   - 卡片顺序的 `totalScore` 序列**非递增**（降序）；
   - 带 `第 N 名` 徽标的卡片数 == `min(3, 已出分行数)`（本 run 为 2）；
   - `rank` 的取值从 1 开始连续；**同分的行必须同名次**（本 run 若两行同分，两行都该是 `第 1 名`）。
7. `run.status === 'done'`（**硬断言**）：p4 已把口径钉死为「所有行都到终态后，全部 `judged` → `done`，否则 `partial`」；本 run 两行都 `judged` ⇒ 必须是 `done`。另断言每行 `providerId` 非空（p0 的 R8：执行期要用它定位凭据）。
8. 吸底「开始」按钮此时必须**禁用**（p5 的口径：`startDisabled = starting || hasRunning || runnable.length === 0`），且它的 `Tooltip` 给出禁用原因——这条是 `isRunnableRow` 排除 `judged` 的**零成本 UI 级互证**（与 Task 6 第 8 项互为正反）。读法与证据：

```js
() => {
  const btns = [...document.querySelectorAll('button')];
  const start = btns.find(b => b.innerText.replace(/\s+/g, '').includes('开始'));
  return { text: start?.innerText, disabled: start?.disabled, rect: start?.getBoundingClientRect().toJSON() };
}
```

判定：`disabled === true` 且 `rect.width > 0`（证明它是页面上的真实控件）。

- [ ] **Step 7: 第 3–6 项的失败处置（逐项适用）**

- agent 行失败（`failed` / `timed-out`）：读该行 `error.code` 与文案；若文案指向 CLI 缺失或包缺失 ⇒ **实现坏或环境坏**，按 §5.6.6 的要求核对文案是否**点名包名/可执行文件**（没点名本身就是一个 ❌）；留三件套后**继续**下一项（失败隔离是被测行为）。
- 鉴权/限流：直连探针（Task 2 Step 5）成功而本行失败 ⇒ 实现坏（注入参数错）；直连也失败 ⇒ 环境坏，记跳过 + 理由。
- 分数等式不成立：把 5 维分数、`sum`、期望值、实际值、卡片文本、`events.jsonl` 的 `score` 事件一起贴进证据；**不要**改测试或改期望去迁就实现。
- 采样读不到（选择器不符）：按白名单重试并记录最终选择器；仍读不到 ⇒ 判「证据不足」（不得判 ✅）。

- [ ] **Step 8: 收口**

把第 3–6 项的判定写进 `evidence/04-runA.md`，并把 Run A 的两个 `workspacePath` 追加进 `evidence/cwd-row-workspaces.txt`（Task 7 Step 2 复用）。本任务不产出入库文件，**无提交**。

---

## Task 6: 冒烟第 7–9 项 —— 串行终止（canceled/skipped）、只跑未完成行、坏评分器隔离

**Files:** 无入库文件
**Interfaces:**
- Consumes: Task 4 的用例、Task 5 的 Run A（作为「好尺子」的对照）、interfaces §6 的 `abortRun/startRun/getRun`、§2.4 的 `isRunnableRow`/`TERMINAL_ROW_STATUSES`、§9 的 `runs/[runId]/abort`
- Produces: `evidence/05-runB.md`（第 7–9 项判定）、Run B 的 3 个 `rowId` 与其工作区（Task 7 Step 2 复用其中 `skipped` 行做**负控**）

**设计说明（为什么这样排，先读再动手）：** Run B 的三行是 `claude-code` / `codex` / `codex`。第 3 行**刻意不用 dsh**：第 9 项要求失败必须来自**评分阶段**才具备区分力，若第 3 行是 dsh 而它的 SDK 缺失，该行会先在 agent 阶段失败（`AGENT_LOAD_FAILED`），「评分失败」这条断言就被别的原因顶掉了。dsh 的真实运行由 Task 7 的 Run D 覆盖。第 2、3 行用**同一个 openai 模型**是故意的：它顺带给出「同模型不同行 → 工作区与分支互不相同」的现场证据（F6）。

- [ ] **Step 1: 建 Run B（串行 3 行）**

1. `/runs` → 「创建评测」：用例同一个；执行模式选 **串行**；3 行候选 = `claude-code + $anthModel`、`codex + （evidence/models.json 里 codex 记的那个 openai 模型）`、`codex + 同上同一个模型`
2. `browser_click`「创建」→ 从磁盘取 runId（Run A 已占一个目录，取**不是** Run A 的那个）：

```powershell
$runAId  = (Get-Content "$smokeRoot\evidence\runA.id" -Raw).Trim()
$runDirs = @(Get-ChildItem "$smokeRoot\workspace" -Directory | Where-Object { Test-Path "$($_.FullName)\run.json" -and $_.Name -ne $runAId })
"候选 run 目录数 = $($runDirs.Count)（Task 6 此处应为 1）"
$runDir = $runDirs[0].FullName
$runId  = $runDirs[0].Name
$runId | Set-Content "$smokeRoot\evidence\runB.id"
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
"mode=$($run.executionMode) rows=$(@($run.rows).Count) 状态=$((@($run.rows.status)) -join ',')"
```

Expected: `候选 run 目录数 = 1`；`mode=serial`；`rows=3`；三行状态都是 `pending`。
3. 断言三行的 `branch` 与 `workspacePath` **两两不同**（即使第 2、3 行同 agent 同模型）

Expected: 三行 `workspacePath` 互不相同、`branch == 'test/' + id`。
判定：出现任意两行相同 ⇒ ❌（F6 致命错误，spec §9「防回归到共用目录」）。

- [ ] **Step 2: 第 7 项前半 —— 串行语义（一次只有一行在跑）**

4. `browser_click` 吸底「开始」→ 读 `Modal.confirm` 清单（断言列出 3 行）→ 确认
5. 采样 3 次（间隔 5 秒）读三行状态 → 断言**任意一次采样里 `running` 的行数 ≤ 1**
6. 断言行 1 `running` 时行 2/3 仍 `pending`，且卡片文案含「串行排队中」
7. 等行 1 到 `judged`（含评分，1 次 agent + 1 次评分）→ 断言进度文案形如 `1/3 已完成`
8. 断言行 2 的 `startedAt` ≥ 行 1 的 `finishedAt`（实测两个值都记下来）

**判定：** 第 5、6、8 条同时成立 ⇒ 串行语义成立；任一不成立 ⇒ ❌。

- [ ] **Step 3: 第 7 项后半 —— 中途终止 → canceled + skipped**

9. 等行 2 `status === 'running'` 且它的 `events.jsonl` 出现**首个** agent 事件（`Get-Content -Tail 1`）→ 立刻 `browser_click` 吸底「终止」→ `Popconfirm` 确认
10. 断言三行终态：行 1 `judged`（`score.judgedAt` 与 Step 2 记录的值**逐字符相同**）、行 2 `canceled`、行 3 `skipped`
11. 终止前记录 dev 进程的传递闭包（用于 Step 4 核对子进程消失）：把 Task 7 Step 3 的 `Get-Descendants` 函数复制过来执行，快照存 `evidence/proc-after-abort-B-before.json`

```powershell
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
$run.rows | Select-Object id, agentKind, status, startedAt, finishedAt | Format-Table -AutoSize
foreach ($row in $run.rows) {
  $f = Join-Path (Split-Path $row.workspacePath -Parent) 'events.jsonl'
  "== row $($row.id) status=$($row.status) 事件数=$(@(Get-Content $f).Count)"
  Get-Content $f -Tail 4
}
```

**判定（可证伪）：**
1. 行 1 仍 `judged` 且 `score.judgedAt` 未变（终止不能动已完成的行）。
2. 行 2 `canceled`，其 `events.jsonl` 尾部含 `{"type":"status","status":"canceled"}` 与 `{"type":"end","exitReason":"canceled"}`。
3. 行 3 `skipped`，其 `events.jsonl` **只有** `status: skipped` 一类事件（**不得**出现任何 agent 日志/usage 事件）——这条证明它真的没跑。
4. 行 2 的 agent 子进程在终止后 3 秒内消失：对终止**前**快照里的 PID 逐个 `Get-Process -Id <pid> -ErrorAction SilentlyContinue`，全为 `$null`；若 5 秒后仍在 ⇒ ❌（spec §5.6.5 的两段式超时没生效）。

- [ ] **Step 4: 第 8 + 9 项（一次点击同时覆盖，省一轮 agent 预算）**

> **机制说明（读 p0 的 `resolveJudgeRoute` 实现口径后定的，别改成「随便填一个模型名」）**：用例表单的「默认评分模型」是 `Select`，只能从供应商清单里选；而 `resolveJudgeRoute` 会在**调用前**校验「模型在不在该供应商的清单里」，不在就抛 `CONFLICT`（p0 Task 14 的用例：「模型不在该供应商的清单里时抛 CONFLICT（配错了要在调用前就报，不是等模型 404）」）。所以要让「不存在的模型」真的走到上游，正确做法是**先往供应商清单里手工加一条网关并不提供的模型**（`source: manual`），再让用例选中它：校验会通过，真正的失败发生在评分调用打到上游时。这也正是 spec §9 第 9 项要验的那条路。

12. 到 `/settings` → `模型供应商` → `冒烟-OpenAI` → 手工加一条**网关并不提供**的模型 `p6-smoke-no-such-model-0000`（`source` 会是 `manual`）
13. 到 `/cases` → 该用例 → 「编辑」→ 「默认评分模型」Select 里**选中** `p6-smoke-no-such-model-0000` → 保存
14. 断言落盘成对且指向它：

```powershell
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$openai = $cfg.providers | Where-Object { $_.name -eq '冒烟-OpenAI' }
$case = $cfg.cases[0]
"坏模型在供应商清单里 = $(@($openai.models.id) -contains 'p6-smoke-no-such-model-0000')（期望 True）"
"用例 judgeProviderId = $($case.judgeProviderId)（期望等于冒烟-OpenAI 的 id：$($openai.id)）"
"用例 judgeModelId    = $($case.judgeModelId)（期望 p6-smoke-no-such-model-0000）"
"两个 id 成对 = $(([bool]$case.judgeProviderId) -eq ([bool]$case.judgeModelId))（期望 True）"
```

Expected: 四行全部符合期望（坏模型在清单里、两个 id 成对）。
判定：坏模型不在清单里 ⇒ 表单没保存成功；两个 id 只有一个 ⇒ 记 ❌（p0 的「必须成对」口径）。

15. 回 `/runs` 该 run → 点「开始」→ 读 `Modal.confirm` 清单 → **断言清单只含行 2、行 3，不含行 1**
16. 确认 → 立刻断言：行 1 `status` 与 `score.judgedAt` **都不变**（第 8 项的核心：已 judged 的行不重跑）；行 2/行 3 进入 `preparing`/`running`
17. 等行 2、行 3 到终态（上限 = `settings.rowTimeoutMs`，默认 30 分钟；期间每 30 秒读一次 `run.json`）

```powershell
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
$run.rows | ForEach-Object {
  "row $($_.id) agent=$($_.agentKind) providerId=$($_.providerId) status=$($_.status)"
  "  diff.filesChanged=$($_.diff.filesChanged) tokens=$($_.tokens) durationMs=$($_.durationMs)"
  "  error.code=$($_.error.code)"
  "  error.message=$($_.error.message)"
}
"run.status = $($run.status)"
$run.rows | Where-Object { $_.status -eq 'failed' } | ForEach-Object {
  "code 在 ERROR_CODES 里 = $((@('NOT_FOUND','INVALID_QUERY','NOT_WRITABLE','CONFLICT','AUTH_FAILED','RATE_LIMITED','JUDGE_PARSE_FAILED','NOT_A_GIT_REPO','INVALID_REF','INTERNAL') -contains $_.error.code))（期望 True）"
  "message 非空且无 undefined/[object Object] = $(([bool]$_.error.message) -and ($_.error.message -notmatch 'undefined|\[object Object\]'))（期望 True）"
  "message 提到坏模型名或指向评分 = $(($_.error.message -match 'no-such-model|评分|模型'))（期望 True）"
}
```

**判定（可证伪）：**
1. 第 8 项：`Modal.confirm` 的清单**不含**行 1；确认后行 1 的 `status` 与 `score.judgedAt` 逐字符不变；行 2/3 离开终态进入 `preparing`/`running`。
2. 第 9 项：行 2 与行 3 都 `failed`；两行 `error.code ∈ ERROR_CODES`（硬断言），且按 p0 的映射**期望 `INTERNAL`**（`callTextApi` 的映射是 401→`AUTH_FAILED`、429→`RATE_LIMITED`、**其余→`INTERNAL`**，见 p0 Task 14 的 `text-api.ts` 文件头）；`error.message` 非空、不含 `undefined` / `[object Object]`、且提到坏模型名或指向评分——**绝不允许 `TypeError: fetch failed` 之类的英文原文冒到界面**（p0 明写「那对用户等于没有解释」）。实测 code 若为 `AUTH_FAILED`（网关对未知模型回 401），如实记录并在契约冲突里注明「上游行为差异，非实现缺陷」，不判 ❌。
3. 失败只落在评分阶段：两行的 `diff` 非 `null`（agent 阶段产物仍在）、`durationMs` 非 `null`；若某行的 `error.code` 指向 agent 阶段（`AGENT_*`）⇒ 如实记录为「agent 侧失败，本项目标未覆盖」，并对**另一行**复核评分侧断言。
4. 「其余行不受影响」：行 1 的 `score` 与 Task 5 第 6 项记录的值一致（同用例、同尺子、未重跑）。
5. `run.status === 'partial'`（硬断言）：p4 已把口径钉死为「所有行 `judged` → `done`；跑完了但有行没出分（failed / timed-out / canceled / skipped / interrupted）→ `partial`」（p4 的 Review Focus 第 4 条与轮收尾注释）。本 run 行 1 已 judged 但行 2/3 failed ⇒ 必须是 `partial`。

- [ ] **Step 5: 失败处置**

- 行仍 `judged`（坏模型没让它失败）⇒ ❌：评分器把不存在模型返回的内容当成了有效 JSON，或上游把错误回成了正常文本；留证：该行 `events.jsonl` 里 `score` 事件的 `raw` 原文 + `run.json` 的 `score.totalScore`。
- 行在**路由解析**阶段就 `failed` 且 `error.code === 'CONFLICT'` ⇒ 说明坏模型没进供应商清单（回到 Step 4 第 12 步补加），本项**不算验过**；重新加好后再点一次「开始」不算复跑（这次点击本来就要发生）。
- 行 2/3 在评分前就失败（agent 阶段）⇒ 按 Step 4 判定第 3 条记录，并检查评分调用是否根本没发生（`events.jsonl` 里没有 `judging` 状态）。
- 行 1 被重跑（`judgedAt` 变了）⇒ ❌（`isRunnableRow` 把 `judged` 当成可跑了），留证 `run.json` 前后两份。

- [ ] **Step 6: 收口**

把第 7–9 项的判定写进 `evidence/05-runB.md`；把行 2/行 3 的 `workspacePath` 追加进 `evidence/cwd-row-workspaces.txt`，把**行 3（`skipped`）的 `workspacePath`** 单独记进 `evidence/cwd-negative-control.txt`（Task 7 Step 2 的负控）。本任务不产出入库文件，**无提交**。

---

## Task 7: spec §5.6.7 的冒烟三项（适配器层：宿主环境、cwd 改动、三种终止语义）

**Files:** 无入库文件
**Interfaces:**
- Consumes: Task 1 的 `host-env-before.txt` 与 `$devPid`、Task 5 的 Run A 两行、Task 6 的 `skipped` 行（负控）、interfaces §4 的注册表元数据（`cancelMidTurn`/`usage`/`isolation`）、§5.6.5 的两段式释放
- Produces: `evidence/06-adapters.md`（§5.6.7 三项的判定）、Run D 的三行快照与进程闭包差集

> **复用关系（不重复起环境、不重复跑）**：§5.6.7 与 §9 的 9 项共用同一套前置（网关 / 密钥 / 最小仓库 / 最小提示词）与**同一个 dev 服务会话**；网关与密钥的变量口径直接沿用 p3 Task 11（`AIEVAL_PROBE_BASE_URL` / `AIEVAL_PROBE_API_KEY`，见 Task 1 Step 2），**不改名、不另起一套**。
> - 第 1 项（宿主环境未变）用**整段会话**的 before（Task 1 Step 10）与 after（本任务 Step 1）对比，覆盖 Task 3–7 的全部运行；
> - 第 2 项（cwd 真有改动）**复用 Run A 的两行 + Run D 的三行**，不额外跑；
> - 第 3 项（三种终止）需要三家各被终止一次，由本任务新建的 **Run D**（并行 3 行）一次覆盖；Run B 第 7 项那一次终止是**第 4 次** canceled 证据，可作旁证但**不能替代**——它只终止了 codex 一家。
> - p3 的探测（`packages/server/agents/probe/raw-events.mts`，报告 `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md`，原始 dump 在 `packages/server/agents/probe/dumps/<kind>.json` **不入库**）已经为三家各跑过一条最小任务：本阶段**直接引用那份报告**的结论（尤其 dsh 的 usage 字段名与 `usage: true/false` 的回写结果），**不重跑探测**。注意探测脚本刻意不 import 本包实现、且是在它自己的临时目录里跑的，所以它**不能**替代第 2、3 项——那两项要的正是「本工具的编排层把 `cwd` 交给 CLI」这件事。

- [ ] **Step 1: §5.6.7 第 1 项 —— 宿主环境变量在跑完后未变**

```powershell
$devPid = [int](Get-Content "$smokeRoot\evidence\dev-pid.txt")
$ev = [System.Diagnostics.Process]::GetProcessById($devPid).StartInfo.EnvironmentVariables
($ev.Keys | Sort-Object | ForEach-Object { "$_=$($ev[$_])" }) | Set-Content "$smokeRoot\evidence\host-env-after.txt" -Encoding utf8
"读到的变量数 = $($ev.Count)"
$diff = Compare-Object (Get-Content "$smokeRoot\evidence\host-env-before.txt") (Get-Content "$smokeRoot\evidence\host-env-after.txt")
if ($diff) { "差异行数 = $(@($diff).Count)"; $diff } else { '环境变量完全一致（0 差异）' }
foreach ($k in 'ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','DEEPSEEK_BASE_URL','DEEPSEEK_API_KEY','CLAUDE_CONFIG_DIR','CODEX_HOME') {
  if ($ev.ContainsKey($k)) { "[PRESENT] $k" } else { "[absent] $k" }
}
```

Expected: `环境变量完全一致（0 差异）` + 7 行 `[absent]`。
判定：`Compare-Object` 输出**必须为空**（任何一行差异即 ❌）；7 个注入变量必须仍缺席。

**备用法（`GetProcessById` 读不到时用，本机已实测可行）：** 用 `NODE_OPTIONS=--import` 预载脚本，在**服务进程内部**定期 dump 自己的 `process.env`：

```powershell
# 预载脚本落沙箱（不入库）
@'
import { writeFileSync } from "node:fs";
const out = process.env.AIEVAL_SMOKE_ENV_DUMP;
if (out) {
  const dump = () => { try { writeFileSync(`${out}.${process.pid}.json`, JSON.stringify(process.env, null, 2), "utf8"); } catch {} };
  dump();                              // 启动即 dump
  setInterval(dump, 5000).unref();     // 每 5 秒覆盖一次，最后一次即「跑完后」的状态
}
'@ | Set-Content "$smokeRoot\evidence\env-dump.mjs" -Encoding utf8
# 启动 dev 时改成：
#   $env:NODE_OPTIONS = "--import file:///$("$smokeRoot\evidence\env-dump.mjs" -replace '\\','/')"
#   $env:AIEVAL_SMOKE_ENV_DUMP = "$smokeRoot\evidence\env"
# 比对：按服务 PID 找 "env.<pid>.json"，与启动后的第一次 dump 比较
```

**非空转证明（变异验证，零模型调用，必做）：**

```powershell
# 1) 先看守卫现在是绿的
pnpm --filter @aieval/agents test -t 凭据 2>&1 | Select-String 'Tests|passed|failed|✓|×'
# 2) 人为把缺陷制造回去：在 claude-code 适配器的注入函数里加一行
#    process.env.ANTHROPIC_BASE_URL = route.baseUrl;
# 3) 同一条测试必须失败（把失败输出贴进证据）
pnpm --filter @aieval/agents test -t 凭据 2>&1 | Select-String 'Tests|failed|×'
# 4) 还原并核对哈希
git -C $repo diff --stat -- packages/server/agents/src
git -C $repo status --porcelain -- packages/server/agents/src
```

Expected: 第 1 次 PASS；第 2 次（加回缺陷后）**至少 1 个用例 FAIL**；第 4 次 `git diff`/`status` 对 `packages/server/agents/src` **无输出**（已完全还原）。
判定：若加回缺陷后测试**仍然通过** ⇒ 该守卫没有区分力，本项判「证据不足」（Review Focus 第 1 条），并把「守卫无区分力」作为一个 ❌ 记录进关账。
失败处置：`-t 凭据` 没有匹配到任何用例（p3 用了别的测试名）⇒ 用 `pnpm --filter @aieval/agents test 2>&1 | Select-String 'process.env|宿主|凭据'` 找到真实用例名，重跑并把用例名写进证据。

- [ ] **Step 2: §5.6.7 第 2 项 —— 工作目录里确实产生了文件改动（逐 agent）+ 负控**

```powershell
$file = "$smokeRoot\evidence\cwd-changes.txt"
Remove-Item $file -ErrorAction SilentlyContinue
foreach ($ws in (Get-Content "$smokeRoot\evidence\cwd-row-workspaces.txt")) {
  $rowDir = Split-Path $ws -Parent
  $baseline = (Get-Content (Join-Path $rowDir '..\..\run.json') -Raw | ConvertFrom-Json).rows |
              Where-Object { $_.workspacePath -eq $ws } | Select-Object -ExpandProperty baselineCommit
  "== $ws" | Add-Content $file
  $st = @(git -C $ws status --porcelain)
  "porcelain 行数 = $($st.Count)" | Add-Content $file
  $st | Add-Content $file
  @(git -C $ws diff --name-only $baseline) | Add-Content $file
}
Get-Content $file
# 负控：Run B 的 skipped 行（工作区备好、一行代码没跑）必须为空
$neg = (Get-Content "$smokeRoot\evidence\cwd-negative-control.txt" -Raw).Trim()
"负控工作区 = $neg"
"负控 porcelain 行数 = $(@(git -C $neg status --porcelain).Count) （期望 0）"
```

**判定（可证伪）：**
1. Run A 两行 + Run D 三行（共 5 行，覆盖 claude-code / codex / dsh 三家）：每行 `git status --porcelain` 行数 ≥ 1，且 `git diff --name-only {baseline}` 至少 1 个路径。
2. **负控**：`skipped` 行的工作区 `porcelain` 行数 **== 0**（同一命令、同一夹具，一个有改动一个没有 ⇒ 证明这条断言有区分力，不是恒真）。
3. 若某行（尤其提前终止的 dsh 行）没有改动：如实记 ❌/未覆盖 + 理由（终止时机早于首次写入），**不得**用别的行替代。

- [ ] **Step 3: §5.6.7 第 3 项 —— 三种终止语义 + 子进程确实消失（Run D）**

先记录进程树工具（已验证可用，注意用队列而不是切片，切片在单元素时死循环）：

```powershell
function Get-Descendants {
  param([int]$Root)
  $all = @(Get-CimInstance Win32_Process)
  $out = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($Root)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    foreach ($k in ($all | Where-Object { $_.ParentProcessId -eq $cur })) {
      [void]$out.Add($k)
      $queue.Enqueue([int]$k.ProcessId)
    }
  }
  return $out
}
$devPid = [int](Get-Content "$smokeRoot\evidence\dev-pid.txt")
$baseline = @(Get-Descendants -Root $devPid)
"基线闭包大小 = $($baseline.Count)"
($baseline | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Depth 4) | Set-Content "$smokeRoot\evidence\proc-baseline.json"
```

1. 建 **Run D**：并行 3 行 = `claude-code + $anthModel`、`codex + （evidence/models.json 里 codex 记的那个 openai 模型）`、`dsh + （evidence/models.json 里 dsh 记的那个模型 = $anthModel，anthropic 侧）`；完成协议过滤断言（**dsh 必须只列 anthropic 协议模型**——与 Claude Code 同池；Codex 只列 openai 协议模型）
2. `browser_click`「创建」后从磁盘取 Run D 的 runId（排除前两轮的目录），再点「开始」→ 确认弹窗 → 轮询直到三行都 `running`

```powershell
$used = @(
  (Get-Content "$smokeRoot\evidence\runA.id" -Raw).Trim()
  (Get-Content "$smokeRoot\evidence\runB.id" -Raw).Trim()
)
$runDirs = @(Get-ChildItem "$smokeRoot\workspace" -Directory | Where-Object { Test-Path "$($_.FullName)\run.json" -and $used -notcontains $_.Name })
"候选 run 目录数 = $($runDirs.Count)（Task 7 此处应为 1）"
$runDir = $runDirs[0].FullName
$runId  = $runDirs[0].Name
$runId | Set-Content "$smokeRoot\evidence\runD.id"
(Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json).rows | Select-Object id, agentKind, modelId, status, workspacePath | Format-Table -AutoSize
```

3. 对每行轮询 `git -C {ws} status --porcelain` 非空（上限 8 分钟/行；这是第 2 项 per-agent 证据的来源）——每行一旦有改动就把它记进 `evidence/cwd-row-workspaces.txt`（供 Step 2 复用）
4. 三行都有改动后，快照运行期闭包并求差集（差集 = agent 子进程）：

```powershell
$now = @(Get-Descendants -Root $devPid)
$agentProcs = @($now | Where-Object { $baseline.ProcessId -notcontains $_.ProcessId })
"运行期新增子进程数 = $($agentProcs.Count) （必须 ≥ 3，否则本项证据不足）"
$agentProcs | Select-Object ProcessId, ParentProcessId, Name, @{n='cmd';e={ "$($_.CommandLine)".Substring(0,[Math]::Min(120,"$($_.CommandLine)".Length)) }} | Format-Table -AutoSize
($agentProcs | Select-Object ProcessId, Name | ConvertTo-Json -Depth 3) | Set-Content "$smokeRoot\evidence\proc-runD-agent.json"
```

5. 逐行点卡片上的「终止」：先读按钮文案（`browser_evaluate` 或 `read_picked_element`）并记录；`claude-code` / `codex` 两行期望文案为「终止」，`dsh` 行**必须不同**（`cancelMidTurn: false` ⇒ 「关闭运行时」或等价文案 + 说明性 Tooltip），实测文案写进证据
6. 三行都终止后，断言行状态与子进程：

```powershell
$run = Get-Content "$runDir\run.json" -Raw | ConvertFrom-Json
$run.rows | Select-Object id, agentKind, status | Format-Table -AutoSize
Start-Sleep -Seconds 3
$alive = @($agentProcs | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
"终止 3 秒后仍存活的 agent 子进程数 = $($alive.Count) （期望 0）"
$alive | Select-Object ProcessId, Name | Format-Table -AutoSize
# 再看一次 dev 自己的闭包，确认没有新长出来的孤儿
@(Get-Descendants -Root $devPid).Count
foreach ($row in $run.rows) {
  $f = Join-Path (Split-Path $row.workspacePath -Parent) 'events.jsonl'
  "== row $($row.id) $($row.agentKind) status=$($row.status)"; Get-Content $f -Tail 3
}
```

**判定（四条件全中才 ✅，可证伪）：**
1. 三行 `status === 'canceled'`；每行 `events.jsonl` 尾部含 `end` 事件的 `exitReason === 'canceled'`。
2. 运行期闭包差集 `Count ≥ 3` 且每个 PID 都真实存在（`Get-Process` 成功）——**这是本项非空转的前提**：差集为空时判「证据不足」，不得判 ✅。
3. 终止 3 秒后：差集里的 PID 全部消失（`$alive.Count -eq 0`）；dev 闭包回到基线大小。
4. `dsh` 行的终止按钮文案与另两行**不同**（读到的两个文案都要贴出来）。

- [ ] **Step 4: 失败处置**

- 某家 SDK 缺失 ⇒ 该行 `failed`，按 §5.6.6 断言文案**必须点名包名与安装方式**（没点名即 ❌）；记录后**继续**下一家（失败隔离）。
- CLI 未安装（`spawn ENOENT`）⇒ 期望 `AGENT_FAILED` 且文案指向缺失的可执行文件；记为「环境坏 + 文案断言」。
- 五秒后子进程仍在 ⇒ `dispose()`/两段式超时未生效，❌ 并留证（`events.jsonl` 里应有 p4 落的 WARN）。
- 三家全部因环境不可用 ⇒ 本任务整体判「跳过 + 环境理由」，写「后续：额度/CLI 恢复后只重跑本任务（Task 7），不算复跑整轮」。

- [ ] **Step 5: 收口**

把 §5.6.7 三项的判定与实测值写进 `evidence/06-adapters.md`。本任务不产出入库文件，**无提交**。

---

## Task 8: 服务与进程收尾 + 真实配置未被污染

**Files:** 无入库文件
**Interfaces:**
- Consumes: Task 1 的 `evidence/service.json`/`dev-pid.txt`/`host-env-before.txt`/`real-*` 快照、Task 7 的 `proc-runD-agent.json`、Task 1 的 dev job id
- Produces: `evidence/07-cleanup.md`（收尾判定）

- [ ] **Step 1: 停后台 job**

1. `job_kill` Task 1 起的 dev job（记下 job id 与 kill 时间）
2. 等 3 秒

Expected: job 状态变为已结束。
判定：`job_kill` 返回本身**不算**收尾（Review Focus 第 3 条），必须过 Step 2。

- [ ] **Step 2: 端口无监听 + 进程闭包为空 + agent 子进程全消失（三条一起判）**

```powershell
$listen = @(Get-NetTCPConnection -LocalPort 3083 -State Listen -ErrorAction SilentlyContinue)
"3083 LISTEN 数 = $($listen.Count) （期望 0）"
$listen | Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
$devPid = [int](Get-Content "$smokeRoot\evidence\dev-pid.txt")
"dev PID 仍存在 = $([bool](Get-Process -Id $devPid -ErrorAction SilentlyContinue)) （期望 False）"
# 残留的 next dev / agent CLI（按本仓路径过滤，避免误伤别的会话）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'ai-result-evaluation' -and $_.CommandLine -match 'next|claude|codex|dsh' } |
  Select-Object ProcessId, Name, @{n='cmd';e={ "$($_.CommandLine)".Substring(0,[Math]::Min(120,"$($_.CommandLine)".Length)) }} |
  Format-Table -AutoSize
# Task 7 记录过的 agent 子进程 PID 逐个复核
$agentProcs = Get-Content "$smokeRoot\evidence\proc-runD-agent.json" -Raw | ConvertFrom-Json
foreach ($p in $agentProcs) { "PID $($p.ProcessId) ($($p.Name)) 仍存在 = $([bool](Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue))" }
```

Expected: `3083 LISTEN 数 = 0`；dev PID 不存在；上面两条 `Format-Table` **都没有行**；每个 agent PID 都是 `False`。

> 残留 TIME_WAIT / FIN_WAIT2 连接**不算监听**（脚手架冒烟已记录过这一点）——判据是 `-State Listen`。

判定：三条全中 ⇒ ✅；任一不中 ⇒ ❌ + 记录残留 PID/端口并手工处置（`Stop-Process -Id <pid> -Force`）后重跑本步。

- [ ] **Step 3: 真实 `~/.aieval` 与 `~/.runs` 未被污染（前后逐项对比）**

```powershell
$real = Join-Path $env:USERPROFILE '.aieval'
$afterHash = if (Test-Path "$real\config.json") { (Get-FileHash "$real\config.json" -Algorithm SHA256).Hash } else { 'ABSENT' }
$beforeHash = (Get-Content "$smokeRoot\evidence\real-config-before.sha256" -Raw).Trim()
"哈希 一致 = $($afterHash -eq $beforeHash)"
"  前: $beforeHash"; "  后: $afterHash"
if (Test-Path "$real\config.json") {
  "属性 前: $(Get-Content "$smokeRoot\evidence\real-config-before.json" -Raw)"
  "属性 后: $((Get-Item "$real\config.json" | Select-Object Length, LastWriteTime | ConvertTo-Json))"
  "文件数 前: $(Get-Content "$smokeRoot\evidence\real-config-before.count")  后: $((Get-ChildItem $real -Force).Count)"
}
"~/.runs 存在 前: $(Get-Content "$smokeRoot\evidence\real-runs-before.txt")  后: $(Test-Path (Join-Path $env:USERPROFILE '.runs'))"
# 全程所有落盘都必须指向沙箱
"沙箱 config.json 存在 = $(Test-Path "$smokeRoot\aieval-config\config.json")"
Select-String -Path "$smokeRoot\evidence\*.md" -SimpleMatch -Pattern "aieval-config" -List | Select-Object -First 3
```

Expected: `哈希 一致 = True`；`Length`/`LastWriteTime`/文件数三项前后相同；`~/.runs` 存在性与会话前相同；沙箱 `config.json` 存在。
判定：哈希不一致 ⇒ **❌ 且阻塞关账**——必须查清是哪一步没带 `AIEVAL_CONFIG_DIR`（Review Focus 第 2 条），把差异内容、发生时刻、还原方式写进记录，并考虑是否需要提醒使用者恢复他自己的供应商配置。

- [ ] **Step 4: 记录控制台与 dev 日志卫生**

```powershell
# 浏览器侧
#   browser_console_messages({ level: 'error' })  → 抄进证据
# 期望：没有 hydration mismatch、没有未捕获异常、没有 pageerror
# dev 日志：整个会话里 5xx 的条数（从 job 输出里数），与预期的失败项一一对应（不应有额外 5xx）
```

Expected: 唯一的 error 级别信息应当能与「第 9 项的坏评分模型」这类**故意制造**的失败对上；凭空多出来的 error 要逐条归因。
判定：出现 hydration mismatch 或未捕获异常 ⇒ 记录为 ❌ 缺陷项（附原文与复现路径）。

- [ ] **Step 5: 保留沙箱、写收尾记录**

沙箱**不删**（Task 9/10 还要引用里面的实测值）；只清掉误落在别处的探针文件（若在真实配置目录或仓库里发现 `.aieval-probe-*`，说明有步骤没带配置变量，按 Review Focus 第 2 条上报）。

```powershell
Get-ChildItem $env:USERPROFILE -Filter '.aieval-probe-*' -Recurse -ErrorAction SilentlyContinue | Select-Object FullName
Get-ChildItem 'D:\zhanglei1120\Github\ai-result-evaluation' -Filter '.aieval-probe-*' -Recurse -ErrorAction SilentlyContinue | Select-Object FullName
git -C 'D:\zhanglei1120\Github\ai-result-evaluation' status --porcelain
```

Expected: 前两条无输出；`git status --porcelain` 仍只有那一行别人的 `?? …interfaces.md`。
判定：本任务不产出入库文件，**无提交**。

---

## Task 9: 使用手册（`README.md` 增补章节）

**Files:**
- Modify: `README.md`（在「快速开始」之后插入「## 使用手册」章节；并更新「## 当前状态」）
- Create: 无

**Interfaces:**
- Consumes: Task 3–7 的实测结论（每个界面位置都必须是**真的点到过**的那一个）、interfaces §9 的路由与页面清单、spec §10 的错误表、§7.3 的维度与合成公式、§6.3 的落盘结构
- Produces: `evidence/manual-facts.md`（手册用词的唯一真源）、`evidence/manual-guard.txt`（一致性守卫输出）

**二选一的结论（写进 README 的理由）：在 `README.md` 里增补「使用手册」章节，不新建独立文档。** 理由三条：① 使用者的入口本来就是 README 的「快速开始」，把手册另放一处会让两处都讲同一件事、必然漂移；② 手册目标长度 120–180 行，不构成 README 的负担；③ 独立文档需要在 README 加链接，链接目标一改名就是死链，而本阶段没有第二个读者群。

- [ ] **Step 1: 抽真源（手册里出现的每个名词都必须来自这里）**

```powershell
$out = "$smokeRoot\evidence\manual-facts.md"
"# 手册事实来源（每个名词都必须出现在本文件里）" | Set-Content $out
"## 路由" | Add-Content $out
Get-ChildItem 'apps\web-next\app\api' -Recurse -Filter route.ts |
  ForEach-Object { $_.FullName.Replace((Get-Location).Path + '\', '') } | Add-Content $out
"## 错误码" | Add-Content $out
(Select-String -LiteralPath 'packages\server\contracts\src\errors.ts' -Pattern "^\s*'([A-Z_]+)'" -AllMatches).Matches |
  ForEach-Object { $_.Groups[1].Value } | Add-Content $out
"## 导航" | Add-Content $out
Select-String -LiteralPath 'apps\web-next\src\nav.ts' -Pattern "label: '(.+?)', href: '(.+?)'" |
  ForEach-Object { $_.Matches[0].Groups[1].Value + ' -> ' + $_.Matches[0].Groups[2].Value } | Add-Content $out
"## 设置页 Tab（只取 Tabs 的 key→label 四行）" | Add-Content $out
# 不能直接 grep `label: '(.+?)'`：主题 Segmented 的三个选项（跟随系统 / 明亮 / 暗色）也是 label，
# 会被一起抓进来（数出 7 条，与「4 个 Tab」对不上不是页面变了，是这个正则太宽）。
# 这里只认「key 行紧跟 label 行」的 Tab 形态。
$tabsRaw = Get-Content -Raw 'apps\web-next\app\settings\page.tsx'
[regex]::Matches($tabsRaw, "key: '(\w+)',\r?\n\s*label: '(.+?)'") |
  ForEach-Object { $_.Groups[1].Value + ' = ' + $_.Groups[2].Value } | Add-Content $out
"## 界面文案（ui 包里的 antd 中文串，手册要引用按钮/Tab 名时只能从这里挑）" | Add-Content $out
Select-String -Path 'packages\client\ui\src\base\*.tsx','packages\client\ui\src\composite\*.tsx' -Pattern "'([\u4e00-\u9fa5][^']{0,30})'" -AllMatches |
  ForEach-Object { $_.Matches | ForEach-Object { $_.Groups[1].Value } } | Sort-Object -Unique | Add-Content $out
"## 维度与合成" | Add-Content $out
Select-String -LiteralPath 'packages\server\contracts\src\score.ts' -Pattern "key: '.+?'|label: '.+?'|DIMENSION_COUNT" | ForEach-Object { $_.Line.Trim() } | Add-Content $out
Get-Content $out | Select-Object -First 30
```

Expected: 文件里能看到 18 条路由、`ERROR_CODES` 的 10 个码（7 个原有 + 3 个新增）、3 个导航项、**恰好 4 行设置页 Tab（`theme = 界面主题` / `providers = 模型供应商` / `judge = 评分配置` / `workspace = 工作区`，逐个核对这四行，不数总数**——宽松的 `label: '(.+?)'` 会把主题 Segmented 的三个选项一起数进来）、一批界面中文串、5 个维度 key 与标签。
判定：任一小节为空 ⇒ 停下查对应文件的路径是否与 interfaces 不一致（可能是 p1–p5 改名了），**不要**凭印象写手册。

- [ ] **Step 2: 写手册（逐节内容要求，每一条都是一个断言）**

在 `README.md` 的「## 快速开始」之后插入 `## 使用手册`，包含下列 6 节；**每节必须满足列出的硬要求**：

1. **① 配置（供应商 / 评分 / 工作区）**：写出三个 Tab 名（逐字取自 `manual-facts.md` 的「设置页 Tab」小节）；说明**协议类型决定它能喂给哪些智能体**（Claude Code 与 **DSH** 只吃 Anthropic 兼容——dsh 的 wire 由 Task 11 实测为 `POST {root}/v1/messages` + `x-api-key`，契约 R37；Codex 吃 OpenAI 兼容）；写明「拉取模型」在 Anthropic 协议下**不可用**、需要手工维护；写明默认评分模型、输出契约预览、行超时（默认 30 分钟）、diff 上限（默认 256KB）的位置；写明工作区根目录默认值与被测事实（落盘路径）。
   > **2026-09-26 修订**：其中「写明『拉取模型』在 Anthropic 协议下**不可用**、需要手工维护」一句已作废。
   > 现行 `README.md` 的写法是「两种协议都能点『拉取模型』自动拉取；上游连 OpenAI 风格清单接口都没有时才需要手工维护」。
   > 本条其余要求（三个 Tab 名、协议类型决定能喂给哪些智能体、评分/超时/diff 上限的位置）照旧。
2. **② 建用例**：`/cases` → 创建用例 → 右栏表单（不是弹窗）；六个字段与校验行为（标题必填、考题必填、评分提示词可点「AI 生成」且生成后仍可手改、仓库只支持**本地绝对路径**、commit 留空 = 默认分支 HEAD 且**手工输入任意合法 hash 必须可行**、默认评分模型可留空）；写明「AI 生成」在未配置评分模型时**禁用**及其提示。
3. **③ 建评测**：`/runs` → 创建评测 → 用例 Select（选项形如「标题 · 仓库名 · commit 短哈希」）/ 执行模式（默认**并行**）/ 候选行（智能体 + 模型，**模型池按协议过滤**，过滤后为空时行内出 `Alert`）；写明**创建后不自动开跑**。
4. **④ 开始与观察**：吸底「开始」（列出候选清单的确认弹窗）、「终止」（杀进程、串行未轮到的行记 `skipped`）、卡片内单行「终止」（运行中的行才有；DSH 的文案不同，因为它不支持中途取消）；并行 = 同时跑、串行 = 一行跑完**含评分**才起下一行；每行有独立工作区与独立分支（`test/{rowId}`），串行**也不是**共用目录。
5. **⑤ 看产物**：三个抽屉（执行日志：流式、可自动滚底、可下载；代码改动：三样合并 = 已提交 + 未提交 + 未跟踪，含文件清单与统一 diff、被截断时显式标注；评分详情：5 维评分条 + 每维理由 + 总评 + 原始返回）；出分后按总分降序、前三名带排名徽标；写明**总分的算式** `round(五维之和 / (5×5) × 100)` 与「5 维等权、本期固定不可自定义」。
6. **⑥ 排障**：把下面这张表**整张贴进去**（口径来自 spec §10、§4.3、§5.1）：

| 现象 | 界面文案 / 错误码 | 处置 |
|---|---|---|
| 仓库路径非法 / 不是 git 仓库 | `NOT_A_GIT_REPO` + 具体原因（含路径与 git 原文） | 填**本地**仓库根目录（含 `.git` 的目录），不做远端 URL |
| commit hash 不存在 | `INVALID_REF` | 留空 = 用默认分支 HEAD；或从最近 20 条候选里选；也可手工填任意合法 hash |
| 供应商 `/models` 拉取失败 | 错误提示呈现原因，**已手工维护的清单保留** | 核对 API 地址与密钥；Anthropic 协议没有 `/models`，只能手工维护 |
| 供应商密钥无效 | `AUTH_FAILED`（带 host）；该行 `failed` | 到设置页「模型供应商」核对密钥与地址 |
| 供应商限流 | `RATE_LIMITED`；该行 `failed` | 改用**串行**，或稍后重跑该行 |
| 评分模型返回不合法 JSON | 该行 `failed` + `JUDGE_PARSE_FAILED`，`raw` 原文在日志抽屉 | 看日志抽屉里的原始返回，必要时调整评分提示词 |
| 评分维度缺失 / 分数越界 | 越界**夹紧**到 1–5；维度缺失 ⇒ `failed` + `JUDGE_PARSE_FAILED` | 同上（维度缺失不会被「按缺项算平均」，一定失败） |
| agent 超时 | 该行 `timed-out`，子进程被强制终止，其余行不受影响 | 调大「评分配置」里的行超时，或换更小更快的模型 |
| agent 进程启动失败 | 该行 `failed` + `AGENT_FAILED`（如 CLI 未安装） | 按错误文案装 CLI / 检查 `PATH` |
| 工作区根目录不可写 | 设置页校验期 `NOT_WRITABLE`（含失败路径） | 换成可写目录后重新「校验」 |
| 候选行的模型池为空 | 该行内联 `Alert` 说明原因与出路 | 到设置页加一个**对应协议**的供应商（Claude Code 与 DSH 要 Anthropic 兼容，Codex 要 OpenAI 兼容） |
| 未配置默认评分模型 | 「AI 生成」按钮禁用 + 提示 | 到设置页「评分配置」配默认评分模型 |
| 服务重启打断评测 | 运行中的行 → `interrupted` | 点「开始」重跑这些行（**不会**自动续跑） |
| 配置文件损坏 / 带 BOM | BOM 能正常读；真损坏抛**含路径**的中文原因 | 修 `~/.aieval/config.json`，或删掉让它回落默认值 |
| 用例被删除但评测仍在 | 允许删除 | 评测靠冗余快照（仓库路径 / commit / 供应商名）继续可读 |

另外三节必须有（放在 ⑥ 之后）：
7. **数据落在哪**：`~/.aieval/config.json`（设置 + 供应商 + 用例，可用 `AIEVAL_CONFIG_DIR` 覆盖）；`{workspaceRoot}/cases/{caseId}/cache/`（用例级缓存仓库）；`{workspaceRoot}/{runId}/run.json`；`{workspaceRoot}/{runId}/rows/{rowId}/{workspace,.agenthome,events.jsonl}`；并写明「改工作区根目录**不迁移**已有产物，历史评测显示它自己的 `workspaceBase`」。
8. **分数怎么来的**：5 维等权 → `round(sum/(5*5)*100)`；评分走**纯文本 API**（不入仓库、不跑 agent，所以看不到测试结果，只凭代码本身判断）；diff 超上限会截断，卡片上会标「diff 已截断」——这一轮的分是在不完整输入下得出的。
9. **本期不做**：分布式执行 / 多用户与权限 / 云端仓库与凭据管理 / 自动合并或改进被测代码 / 历史趋势统计；维度自定义留待后续；dsh 的 token 计量看设置页——**采不到时显示「不支持计量」，不是 0**。

同步更新 `## 当前状态`：把「脚手架已落地…`agents` 与 `evaluator` 仍是空壳」改成功能阶段的实际状态（三个功能域已落地 + 手册入口），并更新实测的用例总数（Task 1 Step 5 记的那个数）。

- [ ] **Step 3: 手册一致性守卫（跑了才算写完）**

```powershell
# 1) 手册里引用的每个路由都必须存在同名 route.ts
$routes = Select-String -LiteralPath 'README.md' -Pattern '/api/([a-z0-9\-/\[\]]+)' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($r in $routes) {
  $p = "apps\web-next\app\api\$r\route.ts"
  if (Test-Path -LiteralPath $p) { "[OK]  $r" } else { "[MISS] $r -> $p" }
}
# 2) 手册里引用的每个错误码都必须存在于 contracts
$codes = Select-String -LiteralPath 'packages\server\contracts\src\errors.ts' -Pattern "^\s*'([A-Z_]+)'" -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value }
$mentioned = Select-String -LiteralPath 'README.md' -Pattern '\b([A-Z][A-Z_]{4,})\b' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
  Where-Object { $_ -match 'NOT_|INVALID_|JUDGE_|AUTH_|RATE_|CONFLICT|INTERNAL' } | Sort-Object -Unique
foreach ($c in $mentioned) { if ($codes -contains $c) { "[OK]  $c" } else { "[MISS] $c（不在 ERROR_CODES 里）" } }
# 3) 手册里引用的界面中文串必须能在实现里找到
$roots = @('packages\client\ui\src', 'apps\web-next\app')
$files = Get-ChildItem $roots -Recurse -Include *.ts,*.tsx -File | Select-Object -ExpandProperty FullName
$phrases = Select-String -LiteralPath 'README.md' -Pattern '「([^」]{2,20})」' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$misses = @()
foreach ($ph in $phrases) {
  if (-not (Select-String -Path $files -SimpleMatch -Pattern $ph -List -ErrorAction SilentlyContinue)) { $misses += $ph }
}
"检查的文案数 = $($phrases.Count)；未命中 = $($misses.Count)"; $misses
```

**判定（可证伪，且必须做一次负控）：**
1. 路由检查：0 个 `[MISS]`。
2. 错误码检查：0 个 `[MISS]`。
3. 界面文案检查：`未命中 = 0`。
4. **负控**：往 README 里临时加一行 `「这条文案在实现里绝对不存在-p6」` → 重跑第 3 段 → **必须**出现 1 个未命中 → 删掉那一行 → 重跑回到 0。负控不生效（加了假文案仍报 0 未命中）⇒ 守卫没有区分力，手册判「证据不足」。

- [ ] **Step 4: 收口与提交**

```bash
git add README.md
git commit -m "docs(readme): 增补使用手册（从零到出分、常见错误表、落盘位置）"
```

Expected: `git status --porcelain` 之后只剩那一行别人的 `?? …interfaces.md`。
判定：提交后跑 `pnpm typecheck` 零错误（本任务只改文档，跑它是为了确认没顺手碰坏别的）。

---

## Task 10: 关账记录（含 spec 覆盖矩阵、修正汇总、未做项与计划回填）

**Files:**
- Create: `docs/superpowers/notes/2026-09-22-features-smoke.md`
- Modify: `docs/superpowers/plans/2026-09-22-features-p6-smoke.md`（回填文末「冒烟记录」小节）
- Test: 无

**Interfaces:**
- Consumes: `$smokeRoot\evidence\*` 全部、Task 3–8 的判定、spec §1–§12、interfaces §0 的计划集与依赖表、§11 的 R1–R7
- Produces: 关账记录（四段式）、spec 12 节覆盖矩阵、修正汇总、未做/推迟清单

- [ ] **Step 1: 清点证据**

```powershell
Get-ChildItem "$smokeRoot\evidence" -File | Select-Object Name, Length, LastWriteTime | Sort-Object Name | Format-Table -AutoSize
Get-ChildItem "$smokeRoot\evidence" -File | ForEach-Object { "$($_.Name)`t$(@(Get-Content $_.FullName -ErrorAction SilentlyContinue).Count) 行" }
```

Expected: Task 1–9 每一步点名的证据文件都在（`00-baseline.md`、`01-prep.md`、`02-providers.md`、`03-case.md`、`04-runA.md`、`05-runB.md`、`06-adapters.md`、`07-cleanup.md`、`guards.md`、`manual-facts.md`、`manual-guard.txt`，以及各类快照/json/txt）。
判定：缺任一个 ⇒ 回到对应任务补；**不得**在关账记录里凭记忆写数字。

- [ ] **Step 2: 写关账记录（格式照 `notes/2026-09-22-scaffold-smoke.md`，四个一级小节一个都不能少）**

新建 `docs/superpowers/notes/2026-09-22-features-smoke.md`：

- **开头元信息块**（照 scaffold 记录）：任务、分支/起始提交（`git rev-parse HEAD` 的实测值）、日期、运行环境（Node / pnpm / Next / antd / 浏览器视口，视口要写明，例如 1440×900，与 `page.setViewportSize` 的实测值一致）、地址（`http://localhost:3083`，写明按文档约定用 `localhost` 不用 `127.0.0.1`）。
- **§1 范围清单**：一张表，**12 行** = spec §9 的 9 项 + §5.6.7 的 3 项；每行四列：`项 / 判定（✅ ❌ 跳过+理由 证据不足）/ 关键实测值 / 证据文件与行号`。**末行给出小结**（✅ 几项、❌ 几项、跳过几项）。
- **§2 服务与进程**：启动命令（含 `AIEVAL_CONFIG_DIR` 的完整赋值）、后台 job id、就绪日志三行的原文、收尾结果（`job_kill` + 3083 无监听 + 闭包为空 + agent PID 全消失）、真实配置目录的前后哈希/长度/时间戳/文件数四项对比（照 scaffold 记录的写法，四个值都贴）。
- **§3 操作路径与证据**：逐项（12 项）一个小节，每节含「操作路径」（编号的点击/输入序列）与「证据」（浏览器实测值 + CLI 输出互证），并给出**判定**。几何与数值一律是实测值（`getBoundingClientRect()` / `config.json` / `run.json` / `events.jsonl` / `git` / `Get-NetTCPConnection`），**不得**用「看起来」「应该是」。
- **§4 未覆盖项与后续计划**：每条写「是什么 / 为什么没覆盖 / 后续怎么办」。至少包含：未触发的空池 `Alert`（若 Task 5 Step 2 未跑到）、未验证的 dsh 计量字段（引 p3 探测结论）、服务重启恢复（`interrupted`）只由单测覆盖未见真机、`partial` vs `done` 的判定条件未钉死、以及**任何**因环境（额度/CLI）跳过的项。
- 另加 **§5 spec 12 节覆盖矩阵** 与 **§6 对 spec 的实现层修正汇总**（见 Step 3、Step 4），以及 **§7 未做/推迟项**（Step 5）。

- [ ] **Step 3: spec 12 节覆盖矩阵（用命令派生，不靠记忆）**

```powershell
# 每份计划各自引用了哪些 spec 节
Select-String -Path 'docs\superpowers\plans\2026-09-22-features-p*.md' -Pattern '§(\d+)' -AllMatches |
  ForEach-Object { "$(Split-Path $_.Path -Leaf)`t$(($_.Matches | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique) -join ',')" } |
  Sort-Object -Unique
# 每份计划的任务标题（矩阵的「哪个任务」一列从这里取）
Select-String -Path 'docs\superpowers\plans\2026-09-22-features-p*.md' -Pattern '^## Task \d+:' |
  ForEach-Object { "$(Split-Path $_.Path -Leaf)`t$($_.Line)" }
```

把这些输出整理成一张 **12 行**的表（spec §1…§12 各一行），每行三列：`spec 章节 / 承载计划（文件名）/ 承载任务（该计划里的任务标题或小节名）/ 现场证据（冒烟项或单测名，没有就写「无，见 §7 未做项」）`。

**预期映射（来自 interfaces §0 的依赖表，执行时以上面命令的实测输出为准；不一致就记录偏差，不要改计划文件）**：
- §1 要解决的问题 → 全阶段（README 的「评测口径」+ 本次手册）
- §2 本阶段范围 → p0–p5 全体
- §3 功能域关键决策 → F1/F13 归 p0（契约与落盘）、F2/F9/F11 归 p5、F3–F5/F12/F14 归 p4、F6–F8 归 p4 的编排与工作区
- §4 用例管理 → p2
- §5 评测管理 → §5.1/§5.3/§5.4 归 p5、§5.2/§5.5 归 p4、§5.6 归 p3、§5.7 归 p4
- §6 设置 → p1（§6.4 界面主题归脚手架）
- §7 数据模型与持久化 → §7.1/§7.2 归 p0、§7.3 归 p0（契约）与 p4（评分）、§7.4 归 p0（`event-log`）与 p4（扇出）
- §8 路由与前端接入 → p1/p2/p5 各自的路由段 + p5 的 SSE
- §9 测试 → 各计划自己的测试任务；**冒烟 9 项 = 本计划 Task 3–6**
- §10 错误处理 → p0（错误码）分散到 p1/p2/p4/p5 的用例
- §11 实施顺序 → 第 1–7 步 = p0–p5；**第 8 步 = 本计划**
- §12 澄清结论 → 逐条落到上面的章节；dsh 的 usage 字段由 p3 的探测任务钉死（**引用探测结果文件路径**）

判定：12 行全部有承载计划；某一行找不到 ⇒ 写进 §7 未做项（**不许**留空）。

- [ ] **Step 4: 对 spec 的实现层修正汇总（R1–R7 + 各计划自己的修正小节）**

```powershell
Select-String -Path 'docs\superpowers\plans\2026-09-22-features-p*.md' -Pattern '^#+ .*修正' -Context 0,12 |
  ForEach-Object { "$(Split-Path $_.Path -Leaf) :: $($_.Line)"; $_.Context.PostContext }
```

把 interfaces §11 的 R1–R7（`AGENT_KINDS` 真源、`baselineCommit`、三样 diff 的 `--intent-to-add` 口径、三个新错误码、`callTextApi`/`resolveJudgeRoute` 复用、进程内事件总线、仓库校验路由按路径而非 caseId）**加上各计划自述的追加修正**（p0 已经追加 **R8**：`EvalRow.providerId` 是必需字段；**R9**：`EvalRow.error.code` 是必需字段）与上面命令找出的**各计划自己的修正小节**，合并成一张表：`编号 / 修正内容 / 理由 / 归属计划 / 是否已在实现里落地的证据`。最后一行必须写明**本阶段新增的修正**（如果冒烟期间发现实现与文档不一致，这里就是它的落点）。

判定：interfaces §11 的 7 条**一条不漏**，且 p0 自述的 R8/R9 也在表里（编号冲突或漏项都要在本表里显式说明）；每条都要有「落地证据」（文件路径或测试名）。

- [ ] **Step 5: 未做/推迟项（显式列出，不许含糊）**

必须逐条写出（每条给「为什么 / 影响面 / 后续该做什么」）：
1. spec §1 的**非目标**：分布式执行、多用户与权限、云端仓库与凭据管理、自动合并或改进被测代码、历史评测趋势统计——本期明确不做。
2. 维度自定义（spec §12「维度的自定义留待后续」）。
3. dsh 的 usage 计量：以 p3 的探测报告 `docs/superpowers/notes/2026-09-22-features-p3-agent-probe.md` 的结论为准（探不到就是元数据 `usage: false` + 界面「不支持计量」）；本阶段只验证界面文案，不验证数值。若报告尚未产出，这一条判「阻塞：p3 Task 11 未完成」，写进未覆盖项。
4. 服务重启恢复（`interrupted`）：只有 p4 的单测覆盖，**本阶段未做真机重启验证**（是刻意省成本：重启会打断会话）。
5. `partial` vs `done`：口径已由 **p4 钉死**（全 `judged` → `done`；有行没出分 → `partial`），本阶段按它做硬断言（Task 5 Step 6 第 7 条、Task 6 Step 4 第 5 条）；若实测与 p4 的口径不符，在此列出为 ❌ 缺陷（不是「未做项」）。
6. 本阶段任何被跳过的冒烟项（环境原因）与它们的恢复方式。
7. p6 明确**未修改**的产品代码（若 Task 3–7 触发了「必要的小修」，在这里列出改了什么、为什么、跑了哪三条命令）。
8. 已接受的已知弱点（沿用 `notes/2026-09-22-scaffold-smoke.md` §4 的四条：窄窗口右栏不让位、双击分隔条不复位等——**本期不修**，不要顺手改掉）。
9. **R10（改过工作区根目录后的可见性）**：`listRuns` / `getRun` 只扫当前 `settings.workspaceRoot`，改过根目录的**旧轮次既不在列表也 `getRun` 不到**（契约 §5 + R10 的口径，属**取巧不取默**）。写「为什么 / 影响面 / 后续该做什么（补一份「已知根目录索引」落盘物，或让 `listRuns` 扫多个根）」。
10. **R13（spec §9 第 9 项无法按字面执行）**：用例表单的评分模型是 `Select`（不能自由输入），`resolveJudgeRoute` 在调用前就校验「模型在该供应商清单里」，所以「故意配一个不存在的评分模型」只能走替代路径（往供应商清单**手工加一条网关并不提供的模型**：`source: 'manual'` → 用例选中它 → 失败发生在上游调用）。把替代路径、实际错误码（401→`AUTH_FAILED` / 429→`RATE_LIMITED` / 其余→`INTERNAL`）与「第 9 项要证明的『一行失败不拖累其它行』照样成立」写清楚。
11. **R35 的残留（外置依赖的形态）**：`apps/web-next/src/runtime-deps.test.ts` 只证明「三家声明在 + 从应用根目录解析得到」，**不证明** Next 把外置说明符发成 `module` 而不是 `commonjs`。本阶段真的起服务、真的跑到一行 agent 就是这条的**唯一终局证据**：若运行时炸出 `MODULE_NOT_FOUND` 或 `ERR_PACKAGE_PATH_NOT_EXPORTED`，按 ❌ 缺陷记录并给出产物里的裸说明符原文。
12. **R12 的跨会话命名（不要「顺手修」）**：另一会话的 p1 计划把密钥掩码字段叫 `apiKeyMask`，本分支落地的是 **`apiKeyMasked`**（用户已裁决保持后者）。本阶段若在代码或测试里看到 `apiKeyMask` 与 `apiKeyMasked` 并存，**不要**去改名对齐——把它记成一条观察项即可（改名会让 p1 的既有测试大面积变红，属另一会话的裁决面）。
13. **`INVALID_QUERY` 的文案对「请求体」不准确**（p2 阶段评审 F4 的残留，控制方记账）：`apps/web-next/src/server-context.ts` 把 `ZodError` 一律映射成 `INVALID_QUERY` + 「**查询参数**不合法」，但这个出口同时承担**请求体**（`CaseCreateSchema` 等）与 `assertStorable` 的校验失败。p2 已在前端补了字段级提示（纯空白标题/仓库路径不再走到这里），所以**可达面只剩直接调 API**；本阶段不改（它是 p1 的共享错误出口，属契约层口径），只作为已知项记录：把「查询参数」与「请求体」的文案分开，是后续一次小改动的范围。

- [ ] **Step 6: 回填本计划文件的「冒烟记录」小节**

把本文件末尾「## 冒烟记录（执行期回填）」那张表里的每个占位标记，替换成实测判定 + 关键实测值 + 证据文件；替换完成后必须满足下面的 grep 为 `0`。

> 占位标记用**字符码拼出来**，不让这条命令自己的文本命中——否则这个守卫永远回不到 0（自指陷阱）：

```powershell
$marker = [string][char]0xFF08 + '未执行' + [string][char]0xFF09   # 全角括号包住的占位标记
$hits = @(Select-String -LiteralPath 'docs\superpowers\plans\2026-09-22-features-p6-smoke.md' -SimpleMatch -Pattern $marker)
"未回填的格子数（按行计）= $($hits.Count) （期望 0）"
$hits | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" }
```

Expected: `未回填的格子数（按行计）= 0`。
判定：非 0 ⇒ 关账未完成，**不得**提交（把列出的行号逐个回填后重跑）。**负控**：回填完再往表里临时加一行带该标记的假行 → 重跑必须报 `1` → 删掉假行 → 回到 `0`；负控不生效说明 grep 写错了，本步作废重做。

- [ ] **Step 7: 提交（逐个显式路径）**

```bash
git add docs/superpowers/notes/2026-09-22-features-smoke.md
git add docs/superpowers/plans/2026-09-22-features-p6-smoke.md
git commit -m "docs: 功能阶段关账（12 项冒烟证据、spec 12 节覆盖矩阵、修正汇总与未做项）"
git status --porcelain
```

Expected: 提交成功；`git status --porcelain` 只剩那一行别人的 `?? …interfaces.md`。
判定：出现别的未跟踪文件 ⇒ 说明有临时产物落进了仓库（Review Focus 第 2 条的变体），查清来源、移出仓库、更新记录，**不要** `git add -A` 一并带上。

---

## 冒烟记录（执行期回填）

> **本节由 Task 10 Step 6 回填。** 回填只允许两种东西：**实测值**，或「❌ / 跳过 + 理由 + 证据文件路径」。不许写「看起来正常」「应该没问题」。回填后每一行都必须能指向 `$smokeRoot\evidence\` 下的**具体文件**或 `notes/2026-09-22-features-smoke.md` 的**具体小节**。提交前跑 Task 10 Step 6 的 grep，确认下表里的占位标记**一个不剩**（该 grep 用字符码拼标记，不会自指命中）。

| 项 | 判定 | 关键实测值 | 证据 |
|---|---|---|---|
| §9-1 两个供应商（openai 拉模型 / anthropic 手工模型） | ❌ **降级（环境缺口）** | 只建成 1 个供应商 `冒烟-Anthropic`（`protocolType=anthropic`、2 条 `manual` 模型）；`GET /models`+`/v1/models` → 200 **空清单**、`/v1/chat/completions`+`/v1/responses` → **503 空体**；`providers.Count = 1`、协议集合 `{anthropic}` ⇒ 拉模型与「合并而非覆盖」**无靶子（该步未跑）** | `evidence/02-providers.md` §0/§2/§7（判定 1/2/4）；`evidence/probe.txt` §1；`evidence/models.json` |
| §9-2 建用例（AI 生成评分提示词、仓库与 commit 校验） | ✅ | 提示词回填 **1822** 字符（1 次文本调用）；`commitHash` 40 位 == `git rev-parse`；候选下拉 2 条与 `git log` 逐字一致；手工 40 位 hash 未截断；5 维 key 缺失 **0**；两个负例（非 git 仓库 / 40 个 0）都 `400` 且不放行保存 | `evidence/03-case.md` §1–§5.3（判定表 §5.2）；`evidence/gen-judge-prompt.txt` |
| §9-3 建并行评测 2 行（协议过滤） | ✅（行构成降级） | `mode=parallel rows=2`；用例 Select = `冒烟-最小示例 · repo · efc5a0a`；默认「并行」；claude-code 池只列 anthropic 两条；Codex 空池 `Alert` rect **292×50**、切回后 1→0；codex 因模型池空 + 模型必填**建不出行** | `evidence/04-runA.md` §0/§1 |
| §9-4 两行同时 running + 计量实时跳动 | ❌（前半 ✅ / 后半不成立） | 四次采样（02:50:41.759/45.162/48.278/51.388）两行都 `running` ✅；跑动期间 `durationMs`/`tokens` **恒为 `null`**、行结束才跳到 `26465`/`833361` ⇒ 「实时跳动」不存在；计划的 `startedAt` 断言**不可执行**（契约里没有该字段） | `evidence/04-runA.md` §2（判定 4.1/4.1b/4.2/4.3）；`evidence/runA-poll.jsonl` |
| §9-5 CLI 复核分支与 diff（与页面一致） | ⚠️ 部分通过（claude-code 侧 ❌） | branch 两行都 == `test/{rowId}`、workspace 互不相同 ✅；claude-code **7 行 porcelain 全 0** ❌；**dsh 行 ` M math.js` +4/−0**，页面/numstat/`run.json`/事件**四处非零相等**；`events.jsonl` row1 739 条、row2 22184 条，都首 seq=1、末条 `end`+`completed` | `evidence/04-runA.md` §3；`evidence/05-runB.md` §5；`evidence/cwd-changes.txt` |
| §9-6 出分核对（总分算式与 5 维） | ✅ | 两行 5 维各 1 分 ⇒ 期望 `round(5/25×100)=20`、实际 **20**；维度 key 顺序 == `DIMENSIONS`；两行同分都「第 1 名」；`run.status=done`；「开始」`disabled=true` + Tooltip「没有可执行的行（全部已评分）」 | `evidence/04-runA.md` §4 |
| §9-7 串行 3 行中途终止（canceled / skipped） | ✅（载体 Run B → Run C） | 任意采样 `running ≤ 1`；row2 `canceled` + `end.exitReason=canceled`（终止在首个 agent 事件之后：seq 3 @19:09:19.935）；row3 `skipped` **只有 2 条事件**（无 agent 日志/usage）；5 个 agent PID 全消失；Run B 因轮询脚本缺陷错过终止窗口（见下方脚本缺陷那条） | `evidence/05-runB.md` §2/§3；`evidence/06-adapters.md` 第 3 项 |
| §9-8 再开始只跑未完成行（已 judged 不重跑） | ✅ | 确认框**只列 2 行**（不含已 judged 的 row1）；重启后 row1 仍 `judged`、`judgedAt=2026-09-25T19:09:16.290Z` 逐字符不变 | `evidence/05-runB.md` §4.2 |
| §9-9 坏评分模型 → 该行 failed、其余行不受影响 | ✅ 逻辑成立 / ❌ 文案口径 | 两行都 `failed` + `error.code=INTERNAL`、`run.status=partial`、`diff`/`durationMs` 非 null（失败只在评分阶段）；文案 = `调用文本 API 失败（127.0.0.1:15999）：fetch failed` ⇒ **带英文原文且不含模型名**；R13 替代路径在本机**再降一级**（改用死端口供应商，零上游成本） | `evidence/05-runB.md` §4.1/§4.3 |
| §5.6.7-1 宿主环境变量跑完后未变 | ⚠️ 部分成立 | 81 vs 81 行、差异 **2 行**（都是 `DSH_SESSION_ID`）；7 个注入变量全 `[absent]`；两快照来自不同 dev 进程（74528→72176）；**守卫经变异验证有区分力**（0→1 failed→逐字节还原→0） | `evidence/06-adapters.md` 第 1 项；`evidence/host-env-{before,after}.txt`；`evidence/step7-guard-{before,mutated,restored}.txt` |
| §5.6.7-2 工作目录里确实产生了文件改动（逐 agent + 负控） | ❌ claude-code / ✅ dsh / 负控未跑 | 8 行逐行量：claude-code **7 行全 0**（CLI 写权限门 + 8.3 短名门）；**dsh 行 1 个文件 +4/−0** ✅；负控不可得（skipped 行后来真跑了）⇒ 替代区分力证据 = 7 行 0 改动 vs 1 行 1 改动 | `evidence/06-adapters.md` 第 2 项；`evidence/cwd-changes.txt` |
| §5.6.7-3 三种终止语义 + 子进程确实消失 | ⚠️ 1 家完整 / 1 家只有文案 / 1 家不可达 | claude-code ✅（中途终止 → `canceled` + 子进程消失 + 文案「终止」）；dsh 只拿到文案「关闭运行时」、**未真被终止**；codex **建不出行**；闭包差集 **3**（≥3）、终止后 5 个 PID 全消失；**Run D 整体未跑**（额度 9/9 + codex 不可建行） | `evidence/06-adapters.md` 第 3 项；`evidence/07-cleanup.md` Step 2 |
| p1 交接-工作区校验（Task 3 Step 7 ②：沙箱 root 落定 + 不可写负控 + 落盘未变） | ✅ | 正例：绿 Alert「工作区可用：…」（rect 1382×40）+ 盘上一致；负控：`NOT_WRITABLE` + 含失败路径的中文原因 + 输入保留 + 盘上值未变；收尾恢复绿（另记形状偏差：盘上是嵌套 `settings.workspaceRoot`、`GET /api/settings` 才是扁平的） | `evidence/02-providers.md` §5 |
| p1 交接-接口与界面正控（Task 3 Step 7 ①③：两汉字按钮不插空格、anthropic 拉取 400、响应只有 apiKeyMasked） | ✅ / 一项正控不可得 | 插空格命中 **0**；`POST …/models/fetch` → `400`「Anthropic 兼容协议没有 /models 接口」；HTTP 出口键名只有 `apiKeyMasked`、带明文键的条数 **0**、正文含明文 `PROXY_MANAGED` = False；**app 级正控不可得**（空态引导按钮文案长度都是 4） | `evidence/02-providers.md` §4/§6；`evidence/fetch-anth.body`；`evidence/providers-list.body` |

**服务与进程（回填）**：启动命令 = `powershell -NoProfile -ExecutionPolicy Bypass -File %TEMP%\p6-dev-launch2.ps1 -SmokeRoot <smokeRoot>`（脚本内显式 `$env:AIEVAL_CONFIG_DIR = <smokeRoot>\aieval-config`）；批 1 job `pwsh-597` / pid 74528 **开工时已不存在** ⇒ 批 2 重启为 job `pwsh-599` / pid 72176；就绪日志原文 = `▲ Next.js 16.2.7 (Turbopack)` / `- Local:         http://localhost:3083` / `✓ Ready in 1117ms` + `[INFO] [instrumentation] 服务启动：已完成被中断候选行的恢复 { recovered: 0 }`；**收尾三条件全部 ✅**（3083 无 LISTEN、dev 闭包 0、5 个 agent PID 全消失；`job_kill` 未使用，按口径它本身不算收尾）；真实 `~/.aieval/config.json` 四项前后相同（sha256 `750BBF15…F191D` / 219 B / `2026/9/24 17:39:36` / 文件数 1）+ `~/.runs` 始终不存在；沙箱 = `C:\Users\ZHANGL~1\AppData\Local\Temp\aieval-p6-smoke-20260926-0207`（evidence **66** 份，不入库）。详见 `evidence/07-cleanup.md` 与关账记录 §2。
**未覆盖项与后续（回填）**：见关账记录 §4（10 条未覆盖/已知局限）与 §7（缺口清单）+ §8（**关账后仍开着 20 条**，第一条 = claude-code 适配器在评测运行里拿不到写权限）。摘要：**Run D 整体未跑**、openai/codex 路径只有类型面与单测面证据、行级「计量实时跳动」不成立、服务重启恢复与 prod 冒烟未做、dsh 的真实终止未做。
**成本实况（回填）**：agent 启动 **9 / 9**（零复跑）；评测轮次 **4 / 4**；文本调用 **9 / 8（+1）**——按「触达模型」口径 2(探针) + 1(AI 生成) + 2(Run A) + 3(Run B) + 1(Run C) = 9；**+1 归因于计划脚本缺陷**（`Test-Path … -and …` 被解析成 `-NewerThan` ⇒ 轮询错过 Run B 的终止窗口，见关账记录 §7 A11①），其中最后 2 次是**连接被拒、零上游成本**。计划外调用：批 1 的 **~23 次**诊断性小调用按裁决原样记账（无 agent 启动、无评测轮次、未用于重跑换通过），**本批新增 0 次**。护栏表见 `evidence/guards.md`。

**成本实况（回填）**：实际 agent 启动次数与文本调用次数（与护栏的 9 / 8 对比），任何偏差都要写原因。
