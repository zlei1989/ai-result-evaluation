# 功能阶段 p4 实施计划：evaluator（编排、评分、事件日志、重启恢复）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `packages/server/evaluator` 从空壳做成「一轮评测的执行内核」：每候选行独立工作区、并行/串行两种执行模式、每行独立超时与终止语义、评分器与三类解析翻车点的防御、事件日志落盘与进程内扇出、服务重启恢复，并让 `apps/web-next/instrumentation.ts` 成为恢复的唯一启动钩子。

**Architecture:** 编排层只认识三样东西——`core` 的 git/工作区/事件日志原语、`agents` 的注册表（`getProvider(kind).run()`）、`contracts` 的契约。轮级状态机负责「什么时候起哪一行」，行级执行负责 spec §5.5 的八步时序，事件日志（`events.jsonl`）是执行的唯一真相源：每一次状态变更都由同一个函数同时写快照（`run.json`）与追加事件，绝不另存一份进度。终止与超时的原因由编排层记账（`signal` 只表示「外部要求停止」、不带原因），据此把 `canceled` / `skipped` / `timed-out` / `failed` / `interrupted` 五种终态区分开。评分走纯文本 API，解析只认 contracts 的 5 维，**维度缺失一律失败**而不是按缺项算平均。所有测试都用假适配器（`vi.mock('@aieval/agents')`）与假评分器（`vi.mock('./judge')`），在临时目录 + 真实小仓库里跑，不碰真实 API、不碰真实 agent CLI。

**Tech Stack:** TypeScript 5（strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`，源码 ESM）· 纯函数 + Node 内置 `node:fs` / `node:child_process`（无新增运行时依赖）· vitest 4（node 环境，`// @vitest-environment node`）· pnpm workspace（`@aieval/{evaluator,core,agents,contracts,api}`）· Next.js 16.2.7（`instrumentation.ts` 的 `register()`）· 真实 git CLI（只用于夹具仓库，不 mock）

**Spec:** docs/superpowers/specs/2026-09-22-features-design.md §3（F3/F4/F5/F9/F10/F12/F14）/ §5.2 / §5.4 / §5.5 / §5.7 / §7.4 / §9 / §10

**Interfaces source:** docs/superpowers/notes/2026-09-22-features-plan-interfaces.md（§2、§3、§4、§5、§10、§11）

## Global Constraints

- 包名 `@aieval/*`；依赖方向由 `eslint.shared.ts` 的 `withBoundary()` 硬约束（含动态 `import()` 与 `require()`，禁跨包相对引用）。**`evaluator → agents / core / contracts`，不许反向**；`evaluator` 不 import `api`、不 import `next`、不 import 任何厂商 SDK。
- 源码一律 ESM（禁 `require`）；`verbatimModuleSyntax` 开着，**类型必须 `import type`**（或内联 `type` 修饰）。
- 时间字段一律 **ISO 8601 带时区字符串**（`new Date().toISOString()`）；实体 id 一律 **UUID v4**，由服务端创建时生成——本计划只消费 id，不生成 id（生成在 p5 的 `createRun`）。
- 写盘原子（临时文件 + `renameSync`）；读盘容忍 UTF-8 BOM；配置目录 `AIEVAL_CONFIG_DIR` > `~/.aieval`，测试用 `setConfigDirForTesting()`。
- 注释 JSDoc 中文，先说「做什么」再说「怎么做」；文件头写职责 + 注意事项；日志走 `createLogger(scope)`，上下文作为 `console` 第二参数（不 `JSON.stringify`）。
- **本计划不写 `process.env.X = …`**（§5.6.4 硬性不变量之一）：隔离配置由适配器按 `configHome` 注入，编排层只负责准备目录并把路径传进去。
- **测试绝不碰真实 API、真实 agent CLI**：适配器用假实现（`vi.mock('@aieval/agents')` —— 理由见 Task 5 的文件头），评分调用用 `vi.mock('./text-api')` / `vi.mock('./judge')`；所有夹具落在 `mkdtempSync` 的临时目录里（`setConfigDirForTesting(tmp)` + `workspaceRoot` 指向临时目录），**不得触碰真实 `~/.aieval` 与真实 `~/.runs`**。
- 纯函数测试加 `// @vitest-environment node`；测试文件必须位于各包 `src/**/*.test.ts`（共享配置 `vitest.node.ts` 的 include 就是这一条）。
- 命令一律真实可跑：`pnpm --filter @aieval/evaluator test`、`pnpm --filter @aieval/web-next test`、`pnpm typecheck`、`pnpm lint`、`pnpm test`。
- **每条新增的回归守卫必须做变异验证**：把要拦的缺陷人为制造回去（改实现，不改测试），确认守卫**失败**，再还原并核对 `git hash-object` 未变。本计划对三条做：串行共用工作目录（Task 6）、维度缺失按缺项算平均（Task 3）、重启恢复误伤终态行（Task 7）。
- 提交用逐个显式 `git add <路径>`，**禁 `git add -A`**；提交信息中文，形如 `feat(evaluator): …`。
- 文档与代码里不写「TBD / 稍后补 / 类似 Task N / 加适当的错误处理」；每个代码步骤都是可直接粘贴的完整块。
- **前置依赖是硬顺序**：本计划消费 p0（`contracts` 扩展 + `core` 的 git/工作区/事件日志 + `evaluator/src/{text-api,judge-route}.ts`）与 p3（`agents` 注册表 + 三家适配器）。p0/p3 未完成时本计划第一步就会失败——这不是可以绕过的东西，见 Task 1 Step 1。
- **本计划不重写 `text-api.ts` 与 `judge-route.ts`**（它们是 p0 的产出）：`callTextApi` / `resolveJudgeRoute` 只被消费，本计划不改它们的签名、不复制它们的逻辑。

## 本计划对 spec 的实现层修正

逐条一句话，引用契约 §11（R 编号）与 spec 章节：

1. **R2**：`EvalRow.baselineCommit` 存 40 位具体 hash——准备阶段由 `core.checkoutRow` 把 `HEAD` 解析成具体 hash 返回，编排层写进该行，第 6 步的 diff 以它为基线（`commitHash: null` 时也能算 `git diff {base}..HEAD`）。
2. **R6**：事件总线只做**进程内**订阅 + 从 `events.jsonl` 回放，不做跨进程；`subscribeRowEvents` 只推「订阅之后」的事件，历史回放由消费方（p5 的 SSE）先订阅、再读文件、按 `seq` 去重。
3. **R3（消费侧）**：第 6 步的 diff 一律用 `core.collectDiff` 的三样合并结果（已提交 + 未提交 + 未跟踪），编排层不自己拼 git 命令。
4. **`EvalRun.status` 的 `done` / `partial` 口径（spec 只给了取值、没给定义）**：所有行 `judged` → `done`；跑完了但有行没出分（failed / timed-out / canceled / skipped / interrupted）→ `partial`；还有行在跑 → 保持 `running`。这是列表页显示状态的依据，p5 直接消费。
5. **终止是「同步落库、异步收尾」**（spec §5.4 只规定了状态语义，没规定时序）：`abortRun` / `abortRow` 立刻把状态改成 `canceled` / `skipped` 并写 `end` 事件，然后才给适配器发停止信号；在途任务稍后回来看到终态就**只记日志、不改状态**（终态优先），否则用户按了终止几秒后状态会跳回 `failed`。
6. **外层兜底超时的宽限值（spec §5.6.5 只说「编排层持有外层兜底」，没给数值）**：外层兜底在 `rowTimeoutMs + max(1000ms, rowTimeoutMs × 10%)` 触发，硬停再 `+2000ms`。两段宽限的理由：适配器自己的内层超时先响（§5.6.5 的「判定归属只有一处」），外层只兜「内层不响」的适配器；硬停保证一行卡死不会把整轮拖死（F12）。
7. **`JudgeInput` 增 `judgeProviderId: string`**：spec §5.7 的 `JudgeInput` 没有它，但 `ScoreResult` 必须记下「这一分是哪把尺子打的」（与 §7.2 的冗余快照同一理由），而 `resolveJudgeRoute` 只返回 `TextRoute`（没有 providerId）。取值口径仍由 `resolveJudgeRoute` 单点决定，编排层只把最终生效的 providerId 记下来（Task 4 有接缝守卫）。
8. **`publishRowEvent` 的参数类型放宽为 `AgentEvent | PendingAgentEvent`**（名字与返回值不变）：契约 §5 让它收完整 `AgentEvent`（含必填 `seq` / `at`），而 §3.4 的 `appendEvent` 说 `seq` 由写入器分配——两者矛盾。放宽后调用方可以只给内容，`seq` / `at` 一律以落盘写入器为准，订阅者收到的永远是**已落盘**的那一条。类型直接用 **core 的 `PendingAgentEvent`**（契约 §11 R17 / §3.4），本包的 `PendingRowEvent` 只是它的同名别名，不重复定义分配式 Omit。
9. **失败 / 超时 / 被终止的行也要取 diff**：spec 只把第 6 步写在 agent 完成之后；但「它跑到一半改了什么」正是失败行最需要看的证据，故只要工作区建起来了就取 diff 与计数（准备阶段就失败的行没有工作区，保持 `diff: null`）。
10. **重启恢复顺带收尾轮状态**（spec §7.4 只说把行标 `interrupted`）：恢复时把该轮状态定为 `partial` 并补 `finishedAt`，否则界面会一直显示「运行中」而没有任何行在跑。恢复**不碰**任何终态行，也不自动续跑（F10）。
11. **`getRun` / `listRuns` 只扫当前 `settings.workspaceRoot`**（契约 §5 明确的口径）：改了工作区根目录后，旧根目录下的历史轮次不在列表里（spec §6.3 的「不动已有数据」只保证不删除）。本计划不发明「历史根目录索引」这种新名字/新文件；该缺口写在最终报告的「契约冲突」里，需要 p5/spec 决定是否补一个索引。
12. **用例级缓存的调用归属（已被 p0 的 R27/R28 修订，执行时以本节为准）**：`prepareRowWorkspace` **自己**会在复制之前调 `ensureCaseCache(repoPath, cacheDir, commitHash)`（p0 的 Task 11 实现如此，签名见契约 §3.2/§3.3），编排层**不要**再单独调一次。原计划里编排行那句两参数的 `ensureCaseCache(run.repoPath, caseCacheDir(...))` 必须删掉：它落在 `commitHash = null` 分支上，会对每一行都 fetch + `reset --hard` 到源仓库当前 tip（对钉了具体 commit 的行纯属浪费），而且源仓库暂时不可达时会直接抛 `NOT_A_GIT_REPO`——哪怕那一行的 commit 早就在缓存里。若确实想显式预热缓存，传第三个参数：`ensureCaseCache(run.repoPath, caseCacheDir(run.workspaceBase, run.caseId), run.commitHash)`。
13. **`composeTotalScore` 不能替代解析器的「维度缺失即失败」守卫**：p0 的分母是**常量** `DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION = 25`（不随传入个数变化），少传一维时分母照旧是 25，于是「4 维各 4 分」被算成 `round(16 / 25 * 100) = 64`——不是 5 维各 4 分的 80，但同样是一个**由缺失信息算出来、看起来正常**的分数。因此「缺维必须整行 failed」只能由 `parseJudgeResponse` 抛错拦住（Task 3），编排层也必须**传满 5 维**。（口径裁定见接口契约 §11 R18。）
14. ~~**`baselineCommit` 的初值存在跨计划冲突**~~ **（已在 p0 落地时解决，本条留作历史记录）**：p0 的 `EvalRowSchema` 最终写的是契约 §2.4 的 `z.string()`（**没有** `.min(1)`），且 `run.test.ts` 有一条断言明确要求「空串 = 尚未准备」**必须解析成功**（`safeParse({...row, baselineCommit: ''}).success === true`）。所以 p5 的 `createRun` 落 `baselineCommit: ''`、随后 `saveRun` 都是通的；本计划的夹具可以直接用 `''`（原来为了绕开 `.min(1)` 而写 40 位假 hash 的写法已无必要，见 Task 1 的夹具）。

## Review Focus

以下五类输入/条件 spec 没有明说，但坏了会直接伤到使用者。每条都落到「拥有该代码的任务」的测试步骤里：

1. **配置漂移后在旧评测上点「开始」**：供应商被删除、供应商的协议被改过、供应商的 `baseUrl` 被改过、用例被删除——期望该行落 `failed` 或整轮拒绝启动，并给出可读中文原因（含「请重建供应商 / 去设置页」这类去向），而不是抛 `TypeError`、卡在 `preparing`、或拿旧凭据静默重跑。（Task 5 的「供应商已删除 / 协议不匹配 / 用例已删除」三个用例 +「baseUrl 快照与当前不一致」的 WARN 断言）
2. **未配置评分模型时点「开始」**：`settings.defaultJudge` 为 `null` 且用例没有覆盖——期望该行落 `failed` 且错误信息指向设置页，其余行不受影响；不能整轮崩、不能把行停在 `judging`。（Task 5 的「未配置评分模型」用例）
3. **适配器违约**：`run()` 抛异常、返回 `ok: false` 却不带 `error`、返回 `tokens: null`、忽略 `signal` 永不返回——期望行仍落到终态（`failed` / `timed-out`）且轮能收尾，`null` 计量**不许写成 0**，也不能挂死整轮。（Task 5 的「计量为 null」「run() 直接抛异常」「ok:false 却不带 error」三个用例 + Task 6 的「hang 的非合作适配器」用例）
4. **磁盘上的状态被破坏或残缺**：`run.json` 是半截 JSON / 带 BOM、行目录被手工删掉、`events.jsonl` 不存在——期望列表跳过并 WARN、订阅与恢复不炸、该行照样恢复，而不是让一个坏文件挡掉整个评测列表或让启动钩子抛错。（Task 1 的损坏/BOM 用例 + Task 2 的「行目录不存在时自建」用例 + Task 7 的「一条坏快照不会挡住其它轮次的恢复」用例）
5. **模型不守输出契约的分数形态**：`"4"`、`4.5`、`0`、`9`、`"优秀"`、维度重复、模型自造第 6 维、缺总评、缺某一维理由——期望「夹紧 / 忽略 / 占位 / 失败」四种处置各归其位，尤其**缺一维必须整行失败**。（Task 3 的纯函数用例表 + Task 4 的 `judgeRow` 用例）

---

## 文件结构总览

```
packages/server/evaluator/
├── package.json                     # 不改（已依赖 @aieval/{agents,contracts,core}）
├── vitest.config.ts                 # 不改（复用 ../../../vitest.node）
└── src/
    ├── index.ts                     # 【改】汇总导出（保留 p0 已写的 text-api / judge-route 两行）
    ├── text-api.ts                  # p0 产出，本计划只消费（不重建、不改）
    ├── judge-route.ts               # p0 产出，本计划只消费（不重建、不改）
    ├── run-store.ts                 # 【p2 已建（R16）】快照读写：listRuns / listRunsForCase / getRun / saveRun —— 本计划核验并补写侧自检
    ├── run-store.test.ts            # 【p2 已建（R16）】
    ├── events.ts                    # 【新】事件总线：publishRowEvent + subscribeRowEvents
    ├── events.test.ts               # 【新】
    ├── judge.ts                     # 【新】parseJudgeResponse（纯函数）+ judgeRow
    ├── judge.test.ts                # 【新】
    ├── orchestrator.ts              # 【新】runRow（八步时序）+ startRun / abortRun / abortRow
    │                                #      / recoverInterruptedRuns / drainRunningTasks
    ├── orchestrator.test.ts         # 【新】
    ├── index.test.ts                # 【新】导出面守卫（跨计划契约）
    └── testing/
        └── fixtures.ts              # 【新】临时家目录、真实小仓库、假适配器、假评分器、假文本 API

apps/web-next/
├── tsconfig.json                    # 【改】include 补 "instrumentation.ts"（否则 tsc 漏检）
├── instrumentation.ts               # 【新】register()：经 @aieval/api 转出调用 recoverInterruptedRuns
└── src/
    └── instrumentation.test.ts      # 【新】钩子的真实集成（node）+ edge 守卫

packages/server/api/
└── src/index.ts                     # 【改】追加一行转出：recoverInterruptedRuns
```

四个文件的**职责边界**（对齐契约 §5，不要合并）：

| 文件 | 只做 | 不做 |
|---|---|---|
| `run-store.ts` | `run.json` 的读写、列表、损坏容忍 | 不知道行状态机、不知道事件 |
| `events.ts` | 一次调用同时落盘 + 扇出、订阅管理 | 不判断业务语义（不认「终态」「进度」） |
| `judge.ts` | 提示词拼装、文本 API 调用、解析、总分合成 | 不碰工作区、不碰 git、不写 run.json |
| `orchestrator.ts` | 状态机、超时与终止、八步时序、恢复 | 不自己拼 git 命令、不自己解析 JSON、不写 process.env |

---

## Task 1: 前置校验 + `run-store.ts`（运行快照落盘）

> **先查它是否已存在（跨计划接缝，契约 §11 R16）**：`run-store.ts` 的**首个实现者是 p2**（它的 Task 1 建同一份文件：
> `deleteCase` 要统计「有多少评测引用了这个用例」，而 run-store 按依赖表本该在 p4，p2 在 p4 之前执行）。
> 所以本任务的第一步是：
>
> ```powershell
> Test-Path packages/server/evaluator/src/run-store.ts   # True ⇒ p2 已交付
> ```
>
> - **已存在**：跑 `pnpm --filter @aieval/evaluator test` 确认 `run-store.test.ts` 全绿，核对四个签名与下面 **Interfaces** 一节逐字一致，
>   然后**跳过 Step 2–5**，只做 Step 6 之后的收尾与提交（不重写、不复制第二份实现；两份计划各写一个 `saveRun` 正是要避免的事）。
>   **外加一处必须补的差量**（p2 交付后实测：p2 的 `saveRun` 只在**读**路径 `EvalRunSchema.safeParse`，没有写侧自检，而本节下面那份设计是有的）：
>   给 `saveRun` 补上写侧自检 —— `const parsed = EvalRunSchema.parse(run)` 后用 `parsed` 落盘，
>   形状漂移在**写入时**就炸，而不是把脏数据写进磁盘、再让 `listRuns` 读它时静默跳过（`readSnapshot` 返回 `null` + 一条 WARN
>   ⇒ 这一轮评测从列表里**凭空消失**，两端都不报错）。这与 p0 的 R26（事件写侧校验）是同一条原则；
>   补的时候必须配一条会失败的守卫（塞一个 `NaN` 计量字段 → `saveRun` 抛错且盘上没有该文件），并做变异验证。
>   改动是**追加**，不是重写：签名、原子写、只读目标的处置逻辑一律不动。
> - **不存在**：按本节 Step 2 起的完整 TDD 循环实现它，并在提交信息里注明「p2 未执行，由 p4 建 run-store」。
>
> 其余 7 个任务不受影响：无论谁建，`listRuns` / `listRunsForCase` / `getRun` / `saveRun` 的签名与语义都以本节为准。

**Files:**
- Create（或核验已存在）: `packages/server/evaluator/src/run-store.ts`
- Create: `packages/server/evaluator/src/run-store.test.ts`
- Create: `packages/server/evaluator/src/testing/fixtures.ts`

**Interfaces:**
- Consumes（p0 core，契约 §3.3）：`runDir(workspaceRoot, runId): string`、`runSnapshotFile(workspaceRoot, runId): string`；`resolveRootForRead(root: string): string`、`loadConfig(): AppConfig`、`saveConfig(config): void`、`setConfigDirForTesting(dir: string | null): void`、`createLogger(scope): Logger`
- Consumes（p0 contracts，契约 §2.4 / §2.5）：`EvalRunSchema`、`type EvalRun`、`ServiceError`、`SETTINGS_DEFAULTS`、`type Provider`、`type TestCase`、`type EvalRow`、`type ExecutionMode`
- Produces（契约 §5）：`listRuns(): EvalRun[]`、`listRunsForCase(caseId: string): EvalRun[]`、`getRun(runId: string): EvalRun`、`saveRun(run: EvalRun): void`

- [ ] **Step 1: 前置校验（只读，不改任何文件）**

p0 与 p3 是本计划的硬前置。逐条确认真实存在，缺任何一条都**停下**去问，不要自己补一份同名文件（那会让两份计划各写一个 `appendEvent`）：

```powershell
$required = @(
  'packages/server/evaluator/src/text-api.ts',
  'packages/server/evaluator/src/judge-route.ts',
  'packages/server/core/src/git.ts',
  'packages/server/core/src/workspace.ts',
  'packages/server/core/src/event-log.ts',
  'packages/server/contracts/src/run.ts',
  'packages/server/contracts/src/score.ts',
  'packages/server/contracts/src/agent-event.ts',
  'packages/server/agents/src/registry.ts'
)
$missing = $required | Where-Object { -not (Test-Path $_) }
if ($missing.Count -gt 0) { Write-Error "前置未完成，缺少：$($missing -join '、')" } else { Write-Output '前置齐备' }
```

Run: 上面的 pwsh 片段
Expected: 输出 `前置齐备`（`Write-Error` 时不要继续，先解决前置）

- [ ] **Step 2: 写失败测试 `run-store.test.ts`**

```ts
// @vitest-environment node
/**
 * 运行快照落盘：原子写、列表排序、损坏文件跳过（WARN）与 BOM 容忍，
 * 以及「改了工作区根目录后在途轮次仍读得到」。
 * 注意：所有这些读写都发生在 mkdtempSync 出来的临时目录里（夹具 createTempHome 负责指路），
 * 绝不触碰真实的 ~/.aieval 与 ~/.runs。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_DEFAULTS } from '@aieval/contracts';
import { runSnapshotFile, saveConfig } from '@aieval/core';
import { getRun, listRuns, listRunsForCase, saveRun } from './run-store';
import { createTempHome, makeRunFixture, type TempHome } from './testing/fixtures';

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

describe('saveRun / getRun', () => {
  it('写进 {workspaceBase}/{runId}/run.json 并能原样读回', () => {
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun(run);

    const file = runSnapshotFile(home.workspaceRoot, run.id);
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(run, null, 2)}\n`);
    expect(getRun(run.id)).toEqual(run);
  });

  it('整体覆盖：同 id 再写一次，磁盘上只剩新内容', () => {
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun(run);
    saveRun({ ...run, status: 'running', startedAt: '2026-09-22T10:00:00.000Z' });

    const again = getRun(run.id);
    expect(again.status).toBe('running');
    expect(again.startedAt).toBe('2026-09-22T10:00:00.000Z');
    expect(again.finishedAt).toBeNull();
  });

  it('不存在抛 NOT_FOUND，且错误信息带查找路径', () => {
    expect(() => getRun('00000000-0000-4000-8000-000000000000')).toThrow(/评测不存在/);
  });

  it('损坏的 run.json 抛 INTERNAL（不是 NOT_FOUND：两者的排查方向不同）', () => {
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun(run);
    writeFileSync(runSnapshotFile(home.workspaceRoot, run.id), '{ 半截', 'utf8');

    expect(() => getRun(run.id)).toThrow(/不是合法 JSON/);
    expect(() => getRun(run.id)).toThrow(new RegExp(run.id));
  });

  it('容忍 UTF-8 BOM（外部工具写过的文件都带它）', () => {
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    writeFileSync(runSnapshotFile(home.workspaceRoot, run.id), `\uFEFF${JSON.stringify(run)}`, 'utf8');

    expect(getRun(run.id).id).toBe(run.id);
  });
});

describe('listRuns', () => {
  it('按 createdAt 倒序（新在前），只列当前根目录下的轮次', () => {
    const older = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    const newer = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun({ ...older, createdAt: '2026-09-22T10:00:00.000Z' });
    saveRun({ ...newer, createdAt: '2026-09-22T11:00:00.000Z' });

    expect(listRuns().map((run) => run.id)).toEqual([newer.id, older.id]);
  });

  it('根目录还不存在时返回空列表（不是错误）', () => {
    expect(listRuns()).toEqual([]);
  });

  it('跳过损坏的 run.json 并 WARN，不让一条坏记录挡掉整个列表', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    const broken = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun(good);
    saveRun(broken);
    writeFileSync(runSnapshotFile(home.workspaceRoot, broken.id), 'not json at all', 'utf8');

    expect(listRuns().map((run) => run.id)).toEqual([good.id]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('跳过损坏的评测快照');
  });

  it('listRunsForCase 只留该用例的轮次', () => {
    const wanted = makeRunFixture({ workspaceRoot: home.workspaceRoot, caseId: 'case-a' });
    const other = makeRunFixture({ workspaceRoot: home.workspaceRoot, caseId: 'case-b' });
    saveRun(wanted);
    saveRun(other);

    expect(listRunsForCase('case-a').map((run) => run.id)).toEqual([wanted.id]);
  });
});

describe('工作区根目录变更', () => {
  it('记住每个 runId 的 workspaceBase：改了设置后 getRun 仍读得到（在途轮次不会突然「不存在」）', () => {
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot });
    saveRun(run);

    // 模拟设置页把根目录改到别处：不再 saveConfig 指向 home.workspaceRoot
    saveConfigForTest(join(home.root, 'another-root'));

    expect(listRuns()).toEqual([]);                 // 列表只扫当前根（契约口径）
    expect(getRun(run.id).id).toBe(run.id);         // 但已经见过的 runId 仍读得到
  });
});
```

`saveConfigForTest` 是上面用到的辅助函数，追加到测试文件**末尾**（放在所有 `describe` 之后即可）：

```ts
/** 只改工作区根目录：模拟「跑到一半用户去设置页换了目录」 */
function saveConfigForTest(workspaceRoot: string): void {
  saveConfig({ settings: { ...SETTINGS_DEFAULTS, workspaceRoot }, providers: [], cases: [] });
}
```

- [ ] **Step 3: 写实现 `run-store.ts`**

```ts
/**
 * 运行快照的落盘与读取：`{workspaceBase}/{runId}/run.json`。
 * 一轮评测的全部可展示状态都在这个文件里（行状态、计量、diff 摘要、分数）；
 * 执行过程的真相源是各行的 events.jsonl（F14），两者各司其职、不互相推导。
 *
 * 注意：
 *   1. **写盘原子**（临时文件 + rename），与 config-store 同口径：跑到一半崩溃时留下半截 JSON，
 *      会让这一轮彻底读不出来（git 里还看得到产物，界面却报不存在）；
 *   2. **读盘容忍 UTF-8 BOM**（外部工具写过的文件都带 BOM，`JSON.parse` 遇到它直接抛）；
 *   3. **损坏文件在列表里跳过并 WARN，在 getRun 里抛 INTERNAL**：「文件坏了」与「这轮不存在」
 *      的排查方向完全不同，报错必须能区分（config-store 的注释里有同一条教训）；
 *   4. **进程内记住每个 runId 的 workspaceBase**：用户在设置页改了工作区根目录后，
 *      在途的轮次仍要能读到自己（否则 getRun 会在跑到一半时突然 NOT_FOUND，整轮崩掉）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { EvalRunSchema, ServiceError, type EvalRun } from '@aieval/contracts';
import { createLogger, loadConfig, resolveRootForRead, runDir, runSnapshotFile } from '@aieval/core';

const log = createLogger('run-store');

/** runId → 该轮自己的工作区根目录（run.workspaceBase 的进程内索引） */
const knownRoots = new Map<string, string>();

/** 错误对象 → 可读原因（catch 到的不一定是 Error） */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 当前设置里的工作区根目录（`~` 摊开为真实家目录；只做展开，不碰磁盘） */
function currentRoot(): string {
  return resolveRootForRead(loadConfig().settings.workspaceRoot);
}

/**
 * run.json 的绝对路径：优先用进程内记住的根，读不到再回落到当前设置里的根。
 * 为什么不是每次都读当前设置：一轮评测的产物必须留在它当初的根目录下（spec §6.3 的
 * 「改动根目录时不动已有数据」），改一次设置就让在途轮次换目录写，等于把产物劈成两半。
 */
function snapshotPathFor(runId: string): string {
  const remembered = knownRoots.get(runId);
  if (remembered !== undefined) {
    const file = runSnapshotFile(remembered, runId);
    if (existsSync(file)) return file;
    // 目录被手工删了/搬走了：忘掉它，回落到当前根再找一次
    knownRoots.delete(runId);
  }
  return runSnapshotFile(currentRoot(), runId);
}

/**
 * 读一个 run.json：BOM 容忍 + 契约校验。
 * 校验用 `EvalRunSchema` 而不是裸 `JSON.parse`：磁盘上的文件可能来自旧版本（缺字段），
 * 让它在读取点带着路径报出来，比让它以 undefined 渗进编排层好得多。
 */
function readRunFile(file: string): EvalRun {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ServiceError('INTERNAL', `评测快照不是合法 JSON：${file}（${reason(error)}）`, { cause: error });
  }
  const parsed = EvalRunSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}：${issue.message}`).join('；');
    throw new ServiceError('INTERNAL', `评测快照格式不合法：${file}（${detail}）`);
  }
  knownRoots.set(parsed.data.id, parsed.data.workspaceBase);
  return parsed.data;
}

/**
 * 列出所有轮次（新的在前）。
 * 为什么排序放在数据层：目录的遍历顺序由文件系统决定（不同机器不一样），
 * 列表顺序必须可预期，否则同一份数据在两台机器上看到的顺序不同。
 */
export function listRuns(): EvalRun[] {
  const root = currentRoot();
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // 根目录还不存在（一轮都没跑过、或用户刚改了根目录）→ 空列表，不是错误
    return [];
  }

  const runs: EvalRun[] = [];
  for (const name of names) {
    const file = runSnapshotFile(root, name);
    if (!existsSync(file)) continue;
    try {
      runs.push(readRunFile(file));
    } catch (error) {
      // 一条坏记录不能让整个评测列表消失：使用者会以为「所有历史都没了」
      log.warn('跳过损坏的评测快照', { file, reason: reason(error) });
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 某个用例下的全部轮次（新的在前）；用例详情页的「被引用的评测」用它 */
export function listRunsForCase(caseId: string): EvalRun[] {
  return listRuns().filter((run) => run.caseId === caseId);
}

/** 读一轮评测：不存在抛 NOT_FOUND，文件损坏抛 INTERNAL（两者的处置不同） */
export function getRun(runId: string): EvalRun {
  const file = snapshotPathFor(runId);
  if (!existsSync(file)) {
    throw new ServiceError('NOT_FOUND', `评测不存在：${runId}（已查找 ${file}）`);
  }
  return readRunFile(file);
}

/**
 * 写一轮评测的快照（整体覆盖）。
 * 路径取自 `run.workspaceBase` 而不是当前设置：见 snapshotPathFor 的注释。
 * 落盘前用 `EvalRunSchema` 自检：形状漂移在这里就炸，而不是把脏数据写进磁盘等 p5 读时才发现。
 */
export function saveRun(run: EvalRun): void {
  const parsed = EvalRunSchema.parse(run);
  mkdirSync(runDir(parsed.workspaceBase, parsed.id), { recursive: true });
  const file = runSnapshotFile(parsed.workspaceBase, parsed.id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  knownRoots.set(parsed.id, parsed.workspaceBase);
}
```

- [ ] **Step 4: 写测试夹具 `testing/fixtures.ts`（本任务先放「临时目录 + 造数据」部分）**

```ts
/**
 * evaluator 测试夹具：临时家目录、评测/行/供应商/用例工厂。
 * 为什么所有夹具都落在 mkdtempSync 出来的临时根目录里：本计划跑的每一步都写盘
 * （run.json / events.jsonl / 工作区复制），把 config-store 指到临时目录 + 把 workspaceRoot
 * 指到临时目录，是唯一能保证「绝不触碰真实 ~/.aieval 与 ~/.runs」的写法。
 * 注意：本文件只造数据与临时目录，不造行为；假适配器 / 假评分器 / 假文本 API 在 Task 4、Task 5
 * 追加（它们要配合 vi.mock，放在同一模块里才能被 mock 工厂动态 import 到同一个实例）。
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SETTINGS_DEFAULTS,
  type EvalRow,
  type EvalRun,
  type ExecutionMode,
  type Provider,
  type Settings,
  type TestCase,
} from '@aieval/contracts';
import { saveConfig, setConfigDirForTesting } from '@aieval/core';

/** 一个用完即删的临时家目录 */
export interface TempHome {
  /** 临时根目录（仓库、产物都在它下面） */
  root: string;
  /** 临时配置目录（相当于测试期的 ~/.aieval） */
  configDir: string;
  /** 临时工作区根目录（相当于测试期的 ~/.runs） */
  workspaceRoot: string;
  cleanup: () => void;
}

/**
 * 建临时家目录并把 config-store 指过去。
 * **立刻写一份指向临时目录的配置**：不写的话 `settings.workspaceRoot` 会回落到默认的 `~/.runs`，
 * `listRuns()` / `getRun()` 就会去读真实目录——「测试不碰真实 ~/.runs」必须由夹具本身保证，
 * 不能指望每个用例都记得先 seedConfig。
 * `cleanup` 会把 override 复位成 null：不复位的话，同文件后续用例（或忘记 cleanup 的用例）
 * 会继续往已删除的目录里写，症状是莫名其妙的 ENOENT。
 */
export function createTempHome(): TempHome {
  const root = mkdtempSync(join(tmpdir(), 'aieval-evaluator-'));
  const configDir = join(root, 'config');
  const workspaceRoot = join(root, 'runs');
  setConfigDirForTesting(configDir);
  seedConfig({ workspaceRoot });
  return {
    root,
    configDir,
    workspaceRoot,
    cleanup: () => {
      setConfigDirForTesting(null);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 造一条供应商记录（默认 openai 协议，够 codex 行用；**dsh 行要显式覆盖成 `anthropic`**——Task 11 实测 dsh 讲 Anthropic Messages，见契约 R37） */
export function makeProviderFixture(overrides: Partial<Provider> = {}): Provider {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: '测试供应商',
    protocolType: 'openai',
    baseUrl: 'https://fake.invalid/v1',
    // 假凭据：测试里不存在任何真实网络调用（text-api 被 vi.mock 掉、适配器是假的）
    apiKey: 'sk-test-not-a-real-key',
    models: [{ id: 'test-model', source: 'manual' }],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 造一条用例记录；需要真实仓库的用例自己覆盖 repoPath */
export function makeCaseFixture(overrides: Partial<TestCase> = {}): TestCase {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: '测试用例',
    repoPath: join(tmpdir(), 'aieval-not-a-real-repo'),
    commitHash: null,
    taskPrompt: '把 README 的标题改成中文',
    judgePrompt: '按 5 个维度打分，只看代码改动',
    judgeProviderId: null,
    judgeModelId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 造一个候选行（字段齐全，避免每个用例各写一遍；id 与 branch 自洽） */
export function makeRowFixture(overrides: Partial<EvalRow> = {}): EvalRow {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    agentKind: 'codex',
    providerId: 'provider-placeholder',
    providerName: '测试供应商',
    baseUrl: 'https://fake.invalid/v1',
    modelId: 'test-model',
    status: 'pending',
    branch: `test/${id}`,
    workspacePath: '',
    // 占位基线：真实基线是 40 位具体 hash（R2），要等准备阶段由 prepareRowWorkspace 解析出来。
    // 这里用 ''（= 尚未准备）：契约 §2.4 的 EvalRowSchema 就是 `z.string()`，p0 的 run.test.ts 明确断言
    // 「空串必须解析成功」，所以夹具无需伪造一个假的 40 位 hash（实现层修正第 14 条已据此改写）。
    baselineCommit: '',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    ...overrides,
  };
}

/** 造一轮评测（不落盘：要不要 saveRun 由用例决定） */
export function makeRunFixture(input: {
  workspaceRoot: string;
  id?: string;
  caseId?: string;
  caseTitle?: string;
  repoPath?: string;
  commitHash?: string | null;
  executionMode?: ExecutionMode;
  rows?: EvalRow[];
  status?: EvalRun['status'];
}): EvalRun {
  return {
    id: input.id ?? randomUUID(),
    caseId: input.caseId ?? randomUUID(),
    caseTitle: input.caseTitle ?? '测试用例',
    repoPath: input.repoPath ?? join(tmpdir(), 'aieval-not-a-real-repo'),
    commitHash: input.commitHash ?? null,
    status: input.status ?? 'idle',
    executionMode: input.executionMode ?? 'parallel',
    rows: input.rows ?? [makeRowFixture()],
    workspaceBase: input.workspaceRoot,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

/** 写一份临时配置（settings + 供应商 + 用例）：默认评分模型为 null，需要评分的用例自己给 */
export function seedConfig(input: {
  workspaceRoot: string;
  providers?: Provider[];
  cases?: TestCase[];
  rowTimeoutMs?: number;
  diffBudgetBytes?: number;
  defaultJudge?: Settings['defaultJudge'];
}): void {
  saveConfig({
    settings: {
      ...SETTINGS_DEFAULTS,
      workspaceRoot: input.workspaceRoot,
      rowTimeoutMs: input.rowTimeoutMs ?? SETTINGS_DEFAULTS.rowTimeoutMs,
      diffBudgetBytes: input.diffBudgetBytes ?? SETTINGS_DEFAULTS.diffBudgetBytes,
      defaultJudge: input.defaultJudge ?? null,
    },
    providers: input.providers ?? [],
    cases: input.cases ?? [],
  });
}
```

- [ ] **Step 5: 跑测试确认失败（然后确认通过）**

Run: `pnpm --filter @aieval/evaluator test`
Expected（第一次，Step 2 之后 Step 3/4 之前）: FAIL —— `Failed to resolve import "./run-store"`。
写完 Step 3、Step 4 后再跑：
Expected: PASS —— `run-store.test.ts` 共 3 个 `describe` / 10 个 `it` 全绿。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过（若报「模块 @aieval/core 没有导出的成员 runDir / runSnapshotFile」，说明 p0 未完成或名字与契约不一致——停下核实，**不要**在 evaluator 里另写一份路径拼接）。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/run-store.ts
git add packages/server/evaluator/src/run-store.test.ts
git add packages/server/evaluator/src/testing/fixtures.ts
git commit -m "feat(evaluator): 运行快照落盘（原子写、损坏跳过、根目录变更后可读）"
```

---

## Task 2: `events.ts`（事件总线：落盘 + 进程内扇出）

**Files:**
- Create: `packages/server/evaluator/src/events.ts`
- Create: `packages/server/evaluator/src/events.test.ts`

**Interfaces:**
- Consumes（Task 1）：`getRun(runId: string): EvalRun`
- Consumes（p0 core，契约 §3.4 / §3.3）：`appendEvent(file, event): AgentEvent`、`rowEventsFile(workspaceRoot, runId, rowId): string`、`readEvents(file): AgentEvent[]`、`createLogger(scope): Logger`
- Consumes（p0 contracts，契约 §2.6）：`type AgentEvent`
- Produces（契约 §5）：`publishRowEvent(runId: string, rowId: string, event: AgentEvent | PendingAgentEvent): void`、`subscribeRowEvents(runId: string, rowId: string, listener: (event: AgentEvent) => void): () => void`、`type PendingRowEvent`（= core 的 `PendingAgentEvent`，别名）

- [ ] **Step 1: 写失败测试 `events.test.ts`**

```ts
// @vitest-environment node
/**
 * 事件总线：一次 publish 必须同时完成「落盘」与「扇出」，订阅是 live-only，
 * 坏订阅者不能打断正在跑的 agent 事件流。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@aieval/contracts';
import { readEvents, rowEventsFile } from '@aieval/core';
import { publishRowEvent, subscribeRowEvents } from './events';
import { saveRun } from './run-store';
import { createTempHome, makeRunFixture, makeRowFixture, type TempHome } from './testing/fixtures';

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

/** 落盘一轮带单行的评测，返回三个 id 与事件文件路径 */
function seedRow(): { runId: string; rowId: string; file: string } {
  const row = makeRowFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row] });
  saveRun(run);
  return { runId: run.id, rowId: row.id, file: rowEventsFile(home.workspaceRoot, run.id, row.id) };
}

describe('publishRowEvent', () => {
  it('落盘：seq 从 1 起单调递增，订阅者拿到的是「已落盘的那一条」', () => {
    const { runId, rowId, file } = seedRow();
    const seen: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, (event) => seen.push(event));

    // 调用方不给 seq：它由 core 的写入器分配（唯一真相源只能有一个分配者）
    publishRowEvent(runId, rowId, { type: 'status', status: 'running' });
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '你好' });

    const events = readEvents(file);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[0]?.type).toBe('status');
    expect(seen.map((event) => event.seq)).toEqual([1, 2]);
    expect(seen.map((event) => event.type)).toEqual(['status', 'log']);
    // at 由写入器补：没有它，日志抽屉里所有事件的时间都会是空的
    expect(seen[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('行目录不存在时自己建，事件照样落盘（「准备中」这条事件先于工作区复制）', () => {
    const { runId, rowId, file } = seedRow();
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stderr', text: '还没建目录' });
    expect(readEvents(file)).toHaveLength(1);
  });

  it('订阅者抛错不影响落盘，也不影响其它订阅者', () => {
    const { runId, rowId, file } = seedRow();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, () => {
      throw new Error('坏订阅者');
    });
    subscribeRowEvents(runId, rowId, (event) => good.push(event));

    expect(() => publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: 'x' })).not.toThrow();

    expect(readEvents(file)).toHaveLength(1);
    expect(good).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('subscribeRowEvents', () => {
  it('只收订阅之后的事件（历史由读文件承担，不在这里回放）', () => {
    const { runId, rowId } = seedRow();
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '订阅之前' });

    const seen: AgentEvent[] = [];
    subscribeRowEvents(runId, rowId, (event) => seen.push(event));
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '订阅之后' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type === 'log' && seen[0].text).toBe('订阅之后');
  });

  it('取消订阅后不再收到；重复取消不抛', () => {
    const { runId, rowId } = seedRow();
    const seen: AgentEvent[] = [];
    const unsubscribe = subscribeRowEvents(runId, rowId, (event) => seen.push(event));
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '第一条' });
    unsubscribe();
    unsubscribe();
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: '第二条' });

    expect(seen).toHaveLength(1);
  });

  it('订阅者在回调里取消自己，不会漏掉本次扇出的其它订阅者', () => {
    const { runId, rowId } = seedRow();
    const seen: string[] = [];
    const first = subscribeRowEvents(runId, rowId, () => {
      first();
      seen.push('first');
    });
    subscribeRowEvents(runId, rowId, () => seen.push('second'));

    publishRowEvent(runId, rowId, { type: 'log', stream: 'stdout', text: 'x' });
    expect(seen).toEqual(['first', 'second']);
  });

  it('同一行只推给该行的订阅者，别行的事件不会串台', () => {
    const rowA = makeRowFixture();
    const rowB = makeRowFixture();
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [rowA, rowB] });
    saveRun(run);
    const seen: AgentEvent[] = [];
    subscribeRowEvents(run.id, rowA.id, (event) => seen.push(event));

    publishRowEvent(run.id, rowB.id, { type: 'log', stream: 'stdout', text: 'B 的日志' });
    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `Failed to resolve import "./events"`。

- [ ] **Step 3: 写实现 `events.ts`**

```ts
/**
 * 每候选行的事件总线：**一次 publish 做两件事**——追加到 `events.jsonl`（唯一真相源，F14）
 * 与扇出给进程内订阅者（SSE 的实时通道）。
 * 为什么两件事必须由同一个调用完成：分开写必然出现「落盘了但没推」或「推了但没落盘」，
 * 而事件日志是唯一真相源——它和实时流一旦分叉，刷新页面看到的与刚才推送的就对不上。
 * 为什么只做进程内（契约 §11 R6）：单个 Next 服务进程，跨进程要额外消息层而收益为零；
 * 「刷新页面不丢事件」由消费方「重读文件 + 按 seq 续订」实现（spec §7.4）。
 *
 * 注意：
 *   1. `seq` / `at` 由 core 的事件日志写入器分配（唯一真相源只能有一个分配者），
 *      调用方传进来的会被忽略；订阅者收到的永远是**已落盘**的那一条；
 *   2. 订阅只收订阅**之后**发布的事件。要历史就自己读文件——**先订阅、再读文件、按 seq 去重**，
 *      顺序反了会在「读完」与「订阅上」之间丢事件；
 *   3. 订阅者抛错只记日志：一个坏订阅者不能让正在跑的 agent 事件流断掉。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent } from '@aieval/contracts';
import { appendEvent, createLogger, rowEventsFile, type PendingAgentEvent } from '@aieval/core';
import { getRun } from './run-store';

const log = createLogger('events');

/** 待发布的事件：`seq` 由写入器分配、`at` 可省（省略时写入器补当前时间）。
 *  它就是 core 的 `PendingAgentEvent`（**同一个类型，不另立一份**）——别名只为让本包读起来是「行事件」。 */
export type PendingRowEvent = PendingAgentEvent;

/** `runId:rowId` → events.jsonl 绝对路径。每条事件都读一次 run.json 会让写日志退化成 O(n) 次磁盘解析 */
const eventsPaths = new Map<string, string>();
/** `runId:rowId` → 该行的订阅者集合 */
const subscribers = new Map<string, Set<(event: AgentEvent) => void>>();

function cacheKey(runId: string, rowId: string): string {
  return `${runId}:${rowId}`;
}

/** 该行事件日志的绝对路径：优先用缓存，未命中时从 run.json 的 workspaceBase 推出来 */
function eventsFileFor(runId: string, rowId: string): string {
  const key = cacheKey(runId, rowId);
  const cached = eventsPaths.get(key);
  if (cached !== undefined) return cached;
  const file = rowEventsFile(getRun(runId).workspaceBase, runId, rowId);
  eventsPaths.set(key, file);
  return file;
}

/**
 * 发布一条行事件：落盘 → 扇出。**同步**函数（适配器的 `onEvent` 契约就是同步、不 await，
 * 见 §5.6.2：事件流不能被消费者拖慢）。
 * 落盘失败**必须冒出去**：静默丢事件等于事后无法复盘这一行到底发生了什么。
 */
export function publishRowEvent(runId: string, rowId: string, event: AgentEvent | PendingRowEvent): void {
  const file = eventsFileFor(runId, rowId);
  // 行目录可能还没建起来（「准备中」这条状态事件先于 prepareRowWorkspace 的目录复制）——补一次 mkdir
  mkdirSync(dirname(file), { recursive: true });
  const written = appendEvent(file, event);

  const listeners = subscribers.get(cacheKey(runId, rowId));
  if (listeners === undefined) return;
  // 先复制一份再遍历：订阅者在回调里取消订阅是合法用法，直接遍历原集合会漏掉后续订阅者
  for (const listener of [...listeners]) {
    try {
      listener(written);
    } catch (error) {
      log.error('事件订阅者抛错（落盘与其它订阅者不受影响）', {
        runId,
        rowId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 订阅某一行的**后续**事件，返回取消订阅函数（可重复调用）。
 * 不在这里回放历史：回放要读文件、要定 afterSeq、要去重，那是消费方（p5 的 SSE）按 seq 处理的活；
 * 本函数只保证「订阅之后发布的每一条都推给你」。
 */
export function subscribeRowEvents(runId: string, rowId: string, listener: (event: AgentEvent) => void): () => void {
  const key = cacheKey(runId, rowId);
  let listeners = subscribers.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(key, listeners);
  }
  listeners.add(listener);

  return () => {
    const current = subscribers.get(key);
    if (current === undefined) return;
    current.delete(listener);
    // 空集合立刻回收：长驻服务里跑几百行，不回收就是一条缓慢的内存泄漏
    if (current.size === 0) subscribers.delete(key);
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— 两个测试文件全绿（`events.test.ts` 共 2 个 `describe` / 7 个 `it`）。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过。若 `appendEvent` 的参数类型报「对象字面量只能指定已知属性」，说明 p0 的 `Omit<AgentEvent, 'seq' | 'at'>` 写成了非分配版本——按契约 §3.4 的签名反馈给 p0（**不要**在 evaluator 里加 `as` 断言绕过，那会把类型问题推到运行时）。

- [ ] **Step 5: 提交**

```bash
git add packages/server/evaluator/src/events.ts
git add packages/server/evaluator/src/events.test.ts
git commit -m "feat(evaluator): 事件总线（落盘与扇出一次完成、live-only 订阅、坏订阅者隔离）"
```

---

## Task 3: `judge.ts` —— `parseJudgeResponse`（纯函数，三类翻车点）

**Files:**
- Create: `packages/server/evaluator/src/judge.ts`
- Create: `packages/server/evaluator/src/judge.test.ts`

**Interfaces:**
- Consumes（p0 contracts，契约 §2.5）：`DIMENSIONS: readonly { key: DimensionKey; label: string }[]`、`type DimensionScore`、`type ScoreResult`、`ServiceError`
- Produces（契约 §5）：`parseJudgeResponse(raw: string): ScoreResult['dimensions'] & { verdict: string }`

- [ ] **Step 1: 写失败测试 `judge.test.ts`（本任务只测纯函数）**

```ts
// @vitest-environment node
/**
 * 评分解析（纯函数）：spec §5.7 的三类翻车点，外加「模型不守契约的各种分数形态」。
 * 四类处置必须各归其位，不能混：
 *   夹紧（越界 / 小数 / 数字字符串）、忽略（重复 key / 自造的第 6 维）、
 *   占位（缺总评、缺理由）、失败（不是数字、维度缺失、顶层不是对象、非法 JSON）。
 */
import { describe, expect, it } from 'vitest';
import { DIMENSIONS, JUDGE_OUTPUT_CONTRACT, ServiceError } from '@aieval/contracts';
import { parseJudgeResponse } from './judge';

/** 一份完全合法的模型返回（分数刻意不整齐，便于看出是重算还是照抄） */
const VALID = {
  dimensions: [
    { key: 'correctness', score: 4, reason: '功能正确' },
    { key: 'requirement', score: 5, reason: '需求完成' },
    { key: 'quality', score: 3, reason: '质量一般' },
    { key: 'robustness', score: 2, reason: '边界没处理' },
    { key: 'maintainability', score: 4, reason: '改动集中' },
  ],
  totalScore: 72,
  verdict: '整体可用',
};

/** 造一份「某一维不见」的返回：这是本任务最重要的一条守卫的输入 */
function withoutDimension(key: string): string {
  return JSON.stringify({ ...VALID, dimensions: VALID.dimensions.filter((item) => item.key !== key) });
}

describe('parseJudgeResponse：合法输入', () => {
  it('返回契约的 5 维（顺序与 contracts 的 DIMENSIONS 一致）与总评', () => {
    const parsed = parseJudgeResponse(JSON.stringify(VALID));
    expect(parsed).toHaveLength(5);
    expect(parsed.map((item) => item.key)).toEqual(DIMENSIONS.map((item) => item.key));
    expect(parsed.map((item) => item.score)).toEqual([4, 5, 3, 2, 4]);
    expect(parsed.verdict).toBe('整体可用');
  });

  it('标签一律取 contracts 的 DIMENSIONS，不采信模型自报的标签', () => {
    const payload = {
      ...VALID,
      dimensions: VALID.dimensions.map((item) =>
        item.key === 'robustness' ? { ...item, label: '鲁棒性' } : { ...item, label: '模型自己起的名字' },
      ),
    };
    const parsed = parseJudgeResponse(JSON.stringify(payload));
    expect(parsed.map((item) => item.label)).toEqual(DIMENSIONS.map((item) => item.label));
  });

  it('解析结果直接满足 ScoreResult[' + "'dimensions'" + '] 的形状（分数是 1–5 的整数）', () => {
    const parsed = parseJudgeResponse(JSON.stringify(VALID));
    for (const item of parsed) {
      expect(Number.isInteger(item.score)).toBe(true);
      expect(item.score).toBeGreaterThanOrEqual(1);
      expect(item.score).toBeLessThanOrEqual(5);
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('parseJudgeResponse：第 1 类翻车点（不合法 JSON）', () => {
  it('散文返回 → JUDGE_PARSE_FAILED，错误信息里说明不是合法 JSON', () => {
    expect(() => parseJudgeResponse('这份代码整体不错，我给 4 分。')).toThrow(ServiceError);
    expect(() => parseJudgeResponse('这份代码整体不错，我给 4 分。')).toThrow(/不是合法 JSON/);
  });

  it('空返回 → JUDGE_PARSE_FAILED', () => {
    expect(() => parseJudgeResponse('   \n  ')).toThrow(/空内容/);
  });

  it('顶层不是对象（数组 / 字符串 / null）→ JUDGE_PARSE_FAILED', () => {
    expect(() => parseJudgeResponse('[1,2,3]')).toThrow(/顶层不是对象/);
    expect(() => parseJudgeResponse('"ok"')).toThrow(/顶层不是对象/);
    expect(() => parseJudgeResponse('null')).toThrow(/顶层不是对象/);
  });

  it('顶层是对象但没有 dimensions 数组 → JUDGE_PARSE_FAILED', () => {
    expect(() => parseJudgeResponse(JSON.stringify({ totalScore: 80, verdict: '还行' }))).toThrow(/没有 dimensions 数组/);
  });
});

describe('parseJudgeResponse：第 2 类翻车点（markdown 围栏）', () => {
  it('```json 围栏包裹 → 先剥围栏再解析', () => {
    const parsed = parseJudgeResponse(`\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``);
    expect(parsed).toHaveLength(5);
    expect(parsed.verdict).toBe('整体可用');
  });

  it('无语言标注的围栏 + 围栏后多余话术 → 仍然解析成功（只取围栏里的内容）', () => {
    const parsed = parseJudgeResponse(`\`\`\`\n${JSON.stringify(VALID)}\n\`\`\`\n希望有帮助！`);
    expect(parsed).toHaveLength(5);
  });

  it('围栏里是坏 JSON → JUDGE_PARSE_FAILED（剥围栏只解决包裹，不解决内容）', () => {
    expect(() => parseJudgeResponse('```json\n{ 半截\n```')).toThrow(/不是合法 JSON/);
  });

  it('中间夹散文（不是以围栏开头）→ 失败，不从散文里抠 JSON', () => {
    expect(() => parseJudgeResponse(`我的结论是：\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``)).toThrow(
      /不是合法 JSON/,
    );
  });
});

describe('parseJudgeResponse：第 3 类翻车点（分数越界 / 维度缺失）', () => {
  it('分数越界与小数被夹紧到 1–5 的整数', () => {
    const cases: { given: unknown; expected: number }[] = [
      { given: 0, expected: 1 },
      { given: -3, expected: 1 },
      { given: 9, expected: 5 },
      { given: 4.5, expected: 5 },
      { given: 4.4, expected: 4 },
      { given: '3', expected: 3 },
      { given: ' 2 ', expected: 2 },
    ];
    for (const { given, expected } of cases) {
      const payload = {
        ...VALID,
        dimensions: VALID.dimensions.map((item) => (item.key === 'quality' ? { ...item, score: given } : item)),
      };
      const parsed = parseJudgeResponse(JSON.stringify(payload));
      expect(parsed[2]?.score).toBe(expected);
    }
  });

  it('分数不是数字 → JUDGE_PARSE_FAILED（这一维的分数根本没给出来）', () => {
    for (const given of ['优秀', null, true, {}]) {
      const payload = {
        ...VALID,
        dimensions: VALID.dimensions.map((item) => (item.key === 'quality' ? { ...item, score: given } : item)),
      };
      expect(() => parseJudgeResponse(JSON.stringify(payload))).toThrow(/分数不是数字/);
    }
    // 缺 score 字段与「不是数字」同路
    const missingScore = {
      ...VALID,
      dimensions: VALID.dimensions.map((item) => (item.key === 'quality' ? { key: 'quality', reason: '忘了给分' } : item)),
    };
    expect(() => parseJudgeResponse(JSON.stringify(missingScore))).toThrow(/分数不是数字/);
  });

  it('维度缺失 → JUDGE_PARSE_FAILED，绝不按缺项算平均', () => {
    const missing = withoutDimension('robustness');
    expect(() => parseJudgeResponse(missing)).toThrow(ServiceError);
    expect(() => parseJudgeResponse(missing)).toThrow(/维度缺失/);
    // 错误信息必须点名是哪一维（否则使用者无法判断是提示词漏了还是模型漏了）
    expect(() => parseJudgeResponse(missing)).toThrow(new RegExp(DIMENSIONS[3]?.label ?? 'robustness'));
  });

  it('每一维单独缺失都会失败（不是只对某一维敏感）', () => {
    for (const { key } of DIMENSIONS) {
      expect(() => parseJudgeResponse(withoutDimension(key))).toThrow(/维度缺失/);
    }
  });

  it('维度重复取第一条；模型自造的第 6 维被忽略（仍是 5 维）', () => {
    const payload = {
      ...VALID,
      dimensions: [
        ...VALID.dimensions,
        { key: 'quality', score: 1, reason: '重复的 key' },
        { key: 'performance', score: 5, reason: '模型自己加的维度' },
      ],
    };
    const parsed = parseJudgeResponse(JSON.stringify(payload));
    expect(parsed).toHaveLength(5);
    expect(parsed[2]?.score).toBe(3);
    expect(parsed.map((item) => item.key)).not.toContain('performance');
  });
});

describe('parseJudgeResponse：可容忍的缺失（占位而不是失败）', () => {
  it('缺总评 / 总评为空 → 占位文案（总评不是判据，不该让整行失败）', () => {
    expect(parseJudgeResponse(JSON.stringify({ ...VALID, verdict: undefined })).verdict).toBe('（模型未给出总评）');
    expect(parseJudgeResponse(JSON.stringify({ ...VALID, verdict: '   ' })).verdict).toBe('（模型未给出总评）');
  });

  it('某一维缺理由 → 占位文案', () => {
    const payload = {
      ...VALID,
      dimensions: VALID.dimensions.map((item) => (item.key === 'quality' ? { key: 'quality', score: 3 } : item)),
    };
    expect(parseJudgeResponse(JSON.stringify(payload))[2]?.reason).toBe('（模型未给出理由）');
  });
});

describe('与 contracts 的输出契约对齐（跨计划接缝）', () => {
  it('JUDGE_OUTPUT_CONTRACT 里出现解析器读的每个字段名', () => {
    // 这条守卫拦的是「生成侧（p2）用的字段名与解析侧（本文件）不一致」：
    // 契约 §2.5 说这份文本是生成与解析共用的单一真源，字段名一旦对不上，
    // 模型会照着契约输出、解析器却读不到——两边各自的单测都还是绿的。
    // 失败时的正确处置是统一 p0 的契约文本或本解析器，**不是删掉这条守卫**。
    for (const field of ['dimensions', 'key', 'score', 'reason', 'verdict']) {
      expect(JUDGE_OUTPUT_CONTRACT).toContain(field);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `Failed to resolve import "./judge"`。

- [ ] **Step 3: 写实现 `judge.ts`（本任务只写解析部分）**

```ts
/**
 * 评分器：把用例的评分提示词 + 裁剪后的 diff 交给评分模型（纯文本 API，F3），解析出固定 5 维分数。
 *
 * 解析必须防御三类翻车点（§5.7），且每一类的处置是**规定动作**、不是随手兜底：
 *   1. 不合法 JSON        → 抛 JUDGE_PARSE_FAILED（该行落 failed），保留 raw 原文；
 *   2. markdown 围栏包裹  → 先剥围栏再解析（模型很爱把 JSON 包在 ```json 里）；
 *   3. 分数越界 / 维度缺失 → 越界**夹紧**到 1–5；**维度缺失直接失败**。
 *
 * 为什么维度缺失不能「按缺的维度算平均」：总分分母是常量 25（`DIMENSION_COUNT * MAX_SCORE_PER_DIMENSION`），
 * 与传入几维无关。于是「4 维各 4 分」会被算成 64 分——它既不是 5 维各 4 分的 80，也不对应任何真实成绩：
 * 使用者看到的是一个由缺失信息算出来的、看起来正常的分数，而这正是最不该静默发生的事。
 *
 * 另一条不许动的口径：**总分一律由 5 维重算**（contracts 的 composeTotalScore，在 judgeRow 里调用），
 * 模型自报的 totalScore 不采信——它可能算错，而界面与冒烟都要求「卡片总分 == 5 维均分映射」（§9 第 6 项）。
 *
 * 注意：本文件不碰工作区、不碰 git、不写 run.json；调用文本 API 的是 judgeRow，解析是纯函数。
 */
import { DIMENSIONS, ServiceError, type DimensionScore, type ScoreResult } from '@aieval/contracts';

/** 解析失败时随错误一起保留的原文上限（字符）：够看清模型回了什么，又不至于把事件日志撑爆 */
const RAW_KEEP_CHARS = 2_000;
/** 成功时写进 `ScoreResult.raw` 的上限：要能当「原始返回」展示，也要防模型跑飞写出几 MB */
const RAW_MAX_CHARS = 20_000;
/** 模型没给总评时的占位文案 */
const VERDICT_FALLBACK = '（模型未给出总评）';
/** 模型没给某一维理由时的占位文案 */
const REASON_FALLBACK = '（模型未给出理由）';

/** 解析失败一律 JUDGE_PARSE_FAILED（§10）：该行落 failed；raw 原文由 judgeRow 补进 context */
function parseFailed(message: string): ServiceError {
  return new ServiceError('JUDGE_PARSE_FAILED', message);
}

/** 错误对象 → 可读原因 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 剥掉 markdown 围栏（第 2 类翻车点）。
 * 只在「整段回答以 ``` 开头」时剥：中间夹散文的情况故意不救——契约（§4.3）要求只输出 JSON，
 * 从散文里抠 JSON 会把「模型没守契约」静默变成「成功」，而暴露它正是解析器的职责。
 * 闭合围栏之后的多余话术不影响解析（只取围栏里的内容）。
 */
function stripCodeFence(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('```')) return text;
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * 分数取值：接受数字与纯数字字符串（模型常把 4 写成 "4"），四舍五入到整数后夹紧到 1–5。
 * 为什么越界夹紧、非数字失败：越界是常见小毛病，夹紧后的分数仍然可用（§5.7 明写「夹紧」）；
 * 而「不是数字」意味着这一维的分数根本没给出来，按维度缺失处理（整行 failed）。
 */
function coerceScore(value: unknown, label: string): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw parseFailed(`维度「${label}」的分数不是数字（收到 ${JSON.stringify(value) ?? 'undefined'}）`);
  }
  return Math.min(5, Math.max(1, Math.round(numeric)));
}

/** 维度理由：缺了就给占位文案，不让界面出现空白（理由是展示项，不是判据） */
function coerceReason(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : REASON_FALLBACK;
}

/**
 * 解析评分模型的返回（纯函数）。
 * 返回形状按契约 §5：维度数组本身带 `verdict` 属性（`Object.assign` 得到交叉类型，无需类型断言）。
 * 以 contracts 的 `DIMENSIONS` 为准逐维校验：**5 维一个不少、不多**，标签也由本地给
 * （不采信模型自报的标签——它把「健壮性」写成「鲁棒性」，两轮评测的维度名就对不上了）。
 */
export function parseJudgeResponse(raw: string): ScoreResult['dimensions'] & { verdict: string } {
  const text = stripCodeFence(raw);
  if (text === '') throw parseFailed('评分模型返回了空内容');

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw parseFailed(`评分模型返回的不是合法 JSON（${reason(error)}）`);
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw parseFailed('评分模型返回的 JSON 顶层不是对象');
  }

  const list = (payload as { dimensions?: unknown }).dimensions;
  if (!Array.isArray(list)) throw parseFailed('评分模型返回的 JSON 里没有 dimensions 数组');

  // 先按 key 归并：重复的 key 以第一条为准（模型偶尔会把同一维说两遍），未知 key 直接忽略
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== 'string' || byKey.has(key)) continue;
    byKey.set(key, record);
  }

  // 按契约的 5 维**逐个**取。这里刻意写成 for 循环而不是 map/filter：
  // 「缺一维就抛」必须是**一行**可被变异验证的分支（把 throw 改成 continue 就是那个缺陷本身）
  const dimensions: DimensionScore[] = [];
  for (const { key, label } of DIMENSIONS) {
    const found = byKey.get(key);
    if (found === undefined) throw parseFailed(`维度缺失：${label}（${key}）没有出现在返回里`);
    dimensions.push({ key, label, score: coerceScore(found.score, label), reason: coerceReason(found.reason) });
  }

  const rawVerdict = (payload as { verdict?: unknown }).verdict;
  const verdict = typeof rawVerdict === 'string' && rawVerdict.trim() !== '' ? rawVerdict.trim() : VERDICT_FALLBACK;
  return Object.assign(dimensions, { verdict });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— `judge.test.ts` 共 6 个 `describe` / 18 个 `it` 全绿。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过。

- [ ] **Step 5: 变异验证（守卫：维度缺失必须失败，不许按缺项算平均）**

```powershell
git hash-object packages/server/evaluator/src/judge.ts
```

把 **实现**（不是测试）改成「按返回里有的维度算」——即把那一行 `throw` 换成 `continue`：

```ts
    // 变异体（只改这一行，用于验证守卫有区分力）
    if (found === undefined) continue;
```

Run: `pnpm --filter @aieval/evaluator test`
Expected: **FAIL**，且失败来自本任务的守卫，形如：

```
 FAIL  src/judge.test.ts > parseJudgeResponse：第 3 类翻车点（分数越界 / 维度缺失） > 维度缺失 → JUDGE_PARSE_FAILED，绝不按缺项算平均
AssertionError: expected [Function] to throw error matching /维度缺失/ but it didn't throw
```

（该用例的第二条断言与「每一维单独缺失都会失败」也会一并失败。若它们**没有**失败，说明守卫没有区分力，必须先把守卫改成能拦住变异体的写法再继续。）

还原那一行（`continue` → `throw`），然后核对哈希：

```powershell
git hash-object packages/server/evaluator/src/judge.ts
```

Expected: 与变异前的哈希**逐字相同**。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/judge.ts
git add packages/server/evaluator/src/judge.test.ts
git commit -m "feat(evaluator): 评分解析（剥围栏、越界夹紧、维度缺失即失败）"
```

---

## Task 4: `judge.ts` —— `judgeRow`（文本 API + 解析 + 保留 raw）

**Files:**
- Modify: `packages/server/evaluator/src/judge.ts`（追加 `JudgeInput` / `judgeRow` / `buildJudgePrompt` / `truncateRaw`，并替换顶部 import 块）
- Modify: `packages/server/evaluator/src/judge.test.ts`（追加 `judgeRow` 的两个 `describe`）
- Modify: `packages/server/evaluator/src/testing/fixtures.ts`（追加假文本 API 与假评分器）

**Interfaces:**
- Consumes（p0 evaluator，契约 §5）：`callTextApi(route: TextRoute, input: { system?: string; prompt: string }): Promise<string>`、`type TextRoute`
- Consumes（Task 3）：`parseJudgeResponse(raw): ScoreResult['dimensions'] & { verdict: string }`
- Consumes（p0 contracts，契约 §2.5）：`JUDGE_OUTPUT_CONTRACT`、`composeTotalScore(scores: readonly number[]): number`、`ScoreResultSchema`、`type DimensionKey`、`type ScoreResult`
- Produces（契约 §5）：`interface JudgeInput`、`judgeRow(input: JudgeInput): Promise<ScoreResult>`

- [ ] **Step 1: 写失败测试（追加到 `judge.test.ts` 末尾）**

先把文件顶部的 import 整段替换为下面这版（`vi` 与假文本 API 是新增的）：

```ts
// @vitest-environment node
/**
 * 评分解析（纯函数）+ 一次评分调用（judgeRow，文本 API 用假实现）。
 * spec §5.7 的三类翻车点，外加「模型不守契约的各种分数形态」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIMENSIONS, JUDGE_OUTPUT_CONTRACT, ServiceError, composeTotalScore } from '@aieval/contracts';
import { parseJudgeResponse, judgeRow, type JudgeInput } from './judge';
import { fakeTextApi, resetFakeTextApi } from './testing/fixtures';

/**
 * 假文本 API：`judgeRow` 内部 import 的 `./text-api` 被整体替换掉，
 * 于是「模型返回什么」「调用是否失败」完全由用例控制，**不会有任何真实网络请求**。
 * 用 vi.mock 而不是给 judgeRow 加注入口：注入口会变成产品代码里只为测试存在的分支，
 * 而这里换掉的正是模块边界（p0 的 callTextApi），边界之外的行为一点没变。
 */
vi.mock('./text-api', async () => {
  const { fakeTextApiModule } = await import('./testing/fixtures');
  return fakeTextApiModule();
});

beforeEach(() => {
  resetFakeTextApi();
});
```

然后追加：

```ts
/** 一次评分调用的标准输入（route 是假的，请求根本不会发出去） */
function judgeInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    judgePrompt: '按 5 个维度打分，只看代码改动',
    diffText: '### 未提交改动（工作区 vs HEAD）\n+ 中文标题\n',
    taskPrompt: '把 README 的标题改成中文',
    dimensions: DIMENSIONS,
    route: { protocolType: 'openai', baseUrl: 'https://fake.invalid/v1', apiKey: 'sk-test', modelId: 'judge-model' },
    judgeProviderId: 'judge-provider',
    ...overrides,
  };
}

describe('judgeRow：成功路径', () => {
  it('把模型返回解析成 ScoreResult，总分由 5 维重算而不是照抄模型自报的值', async () => {
    fakeTextApi.reply = JSON.stringify({
      dimensions: [
        { key: 'correctness', score: 4, reason: '正确' },
        { key: 'requirement', score: 5, reason: '完成' },
        { key: 'quality', score: 3, reason: '一般' },
        { key: 'robustness', score: 2, reason: '边界弱' },
        { key: 'maintainability', score: 4, reason: '集中' },
      ],
      // 模型自己算了个离谱的总分：必须被忽略（4+5+3+2+4 = 18 → round(18/25*100) = 72）
      totalScore: 12,
      verdict: '整体可用',
    });

    const score = await judgeRow(judgeInput());

    expect(score.dimensions.map((item) => item.score)).toEqual([4, 5, 3, 2, 4]);
    expect(score.totalScore).toBe(composeTotalScore([4, 5, 3, 2, 4]));
    expect(score.totalScore).toBe(72);
    expect(score.verdict).toBe('整体可用');
    expect(score.judgeProviderId).toBe('judge-provider');
    expect(score.judgeModelId).toBe('judge-model');
    expect(score.judgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('system 用 contracts 的输出契约文本，prompt 里带题面、维度与 diff；空 diff 显式写「（无改动）」', async () => {
    fakeTextApi.reply = JSON.stringify({
      dimensions: DIMENSIONS.map(({ key }) => ({ key, score: 3, reason: '一般' })),
      verdict: '一般',
    });

    await judgeRow(judgeInput());
    expect(fakeTextApi.calls[0]?.input.system).toBe(JUDGE_OUTPUT_CONTRACT);
    const prompt = fakeTextApi.calls[0]?.input.prompt ?? '';
    expect(prompt).toContain('把 README 的标题改成中文');
    expect(prompt).toContain('按 5 个维度打分，只看代码改动');
    expect(prompt).toContain('+ 中文标题');
    for (const { key, label } of DIMENSIONS) {
      expect(prompt).toContain(key);
      expect(prompt).toContain(label);
    }

    await judgeRow(judgeInput({ diffText: '   ' }));
    expect(fakeTextApi.calls[1]?.input.prompt).toContain('（无改动）');
  });

  it('raw 原样保留（截断上限内），供「评分详情」的原始返回区展示', async () => {
    const reply = JSON.stringify({
      dimensions: DIMENSIONS.map(({ key }) => ({ key, score: 5, reason: '好' })),
      verdict: '好',
    });
    fakeTextApi.reply = reply;
    const score = await judgeRow(judgeInput());
    expect(score.raw).toBe(reply);
  });
});

describe('judgeRow：失败面', () => {
  it('维度缺失 → JUDGE_PARSE_FAILED，并把截断后的 raw 放进 context（日志抽屉据此排障）', async () => {
    const missing = JSON.stringify({
      dimensions: DIMENSIONS.slice(0, 4).map(({ key }) => ({ key, score: 4, reason: '好' })),
      verdict: '看起来不错',
    });
    fakeTextApi.reply = missing;

    await expect(judgeRow(judgeInput())).rejects.toThrow(ServiceError);
    await expect(judgeRow(judgeInput())).rejects.toThrow(/维度缺失/);

    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
    expect((error as ServiceError).context).toEqual({ raw: missing });
  });

  it('超长坏返回：context.raw 被截断并带「此处截断」标记', async () => {
    fakeTextApi.reply = 'x'.repeat(5_000);
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    const context = (error as ServiceError).context as { raw: string };
    expect(context.raw.length).toBeLessThan(5_000);
    expect(context.raw).toContain('此处截断');
    expect(context.raw).toContain('5000 字符');
  });

  it('调用失败（鉴权 / 限流 / 网络）透传原错误码，不折成 JUDGE_PARSE_FAILED', async () => {
    fakeTextApi.failure = new ServiceError('AUTH_FAILED', '密钥无效：https://fake.invalid（去设置页检查）');
    await expect(judgeRow(judgeInput())).rejects.toThrow(/密钥无效/);
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('AUTH_FAILED');

    fakeTextApi.failure = new Error('socket hang up');
    const wrapped = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((wrapped as ServiceError).code).toBe('INTERNAL');
    expect((wrapped as ServiceError).message).toContain('socket hang up');
  });

  it('模型返回的分数非法（缺维 + 非数字同时出现）→ 仍然是 JUDGE_PARSE_FAILED', async () => {
    fakeTextApi.reply = JSON.stringify({
      dimensions: [
        { key: 'correctness', score: '优秀', reason: '好' },
        { key: 'requirement', score: 4, reason: '好' },
      ],
      verdict: '好',
    });
    const error = await judgeRow(judgeInput()).catch((caught: unknown) => caught);
    expect((error as ServiceError).code).toBe('JUDGE_PARSE_FAILED');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `judge.ts` 没有导出 `judgeRow`（`SyntaxError`/`TypeError: judgeRow is not a function`），且 `./testing/fixtures` 没有导出 `fakeTextApi`。

- [ ] **Step 3: 追加夹具（`testing/fixtures.ts` 末尾）**

```ts
/** 假文本 API 的状态：返回值 / 失败方式 / 收到的入参 */
export const fakeTextApi = {
  reply: '',
  failure: null as Error | null,
  calls: [] as { route: unknown; input: { system?: string; prompt: string } }[],
};

/** 每个用例开头调它：模块级状态在同一测试文件里是共享的 */
export function resetFakeTextApi(): void {
  fakeTextApi.reply = '';
  fakeTextApi.failure = null;
  fakeTextApi.calls.length = 0;
}

/** 供 `vi.mock('./text-api', …)` 用作替代模块：只有 callTextApi，没有任何真实 HTTP */
export function fakeTextApiModule(): {
  callTextApi: (route: unknown, input: { system?: string; prompt: string }) => Promise<string>;
} {
  return {
    callTextApi: async (route, input) => {
      fakeTextApi.calls.push({ route, input });
      if (fakeTextApi.failure !== null) throw fakeTextApi.failure;
      return fakeTextApi.reply;
    },
  };
}
```

- [ ] **Step 4: 写实现（替换 `judge.ts` 顶部 import 块，并在文件末尾追加）**

替换后的 import 块（原来只有一行 `DIMENSIONS / ServiceError / DimensionScore / ScoreResult`）：

```ts
import {
  DIMENSIONS,
  JUDGE_OUTPUT_CONTRACT,
  ScoreResultSchema,
  ServiceError,
  composeTotalScore,
  type DimensionKey,
  type DimensionScore,
  type ScoreResult,
} from '@aieval/contracts';
import { callTextApi, type TextRoute } from './text-api';
```

追加到文件末尾：

```ts
/**
 * 一次评分请求的全部输入。
 * 两处补充**必须**保留（见计划开头的实现层修正第 7 条）：
 *   - `judgeProviderId`：spec §5.7 的 JudgeInput 没有它，但 `ScoreResult` 必须记下「这一分是哪把尺子打的」
 *     （与 §7.2 的冗余快照同一理由），而 `resolveJudgeRoute` 只返回 `TextRoute`（没有 providerId）；
 *   - `dimensions` 只用来拼提示词，解析侧以 contracts 的 `DIMENSIONS` 为准（本期 5 维固定，§7.3）。
 */
export interface JudgeInput {
  judgePrompt: string;
  diffText: string;
  taskPrompt: string;
  dimensions: readonly { key: DimensionKey; label: string }[];
  route: TextRoute;
  judgeProviderId: string;
}

/** 截断原文并留明确标记：要能区分「模型只说了这么多」与「我们截了」 */
function truncateRaw(text: string, max = RAW_KEEP_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（原始返回共 ${text.length} 字符，此处截断）`;
}

/**
 * 拼评分请求：题面 → 维度定义 → 用例的评分提示词 → 待评的改动。
 * 为什么把改动放最后：长输入里尾部内容最不容易被忽略；空 diff 显式写「（无改动）」，
 * 否则模型会把「看不到改动」当成「没改」（与 §5.5 第 7 步必须标「已截断」是同一类问题）。
 */
function buildJudgePrompt(input: JudgeInput): string {
  const dimensions = input.dimensions.map(({ key, label }) => `- ${label}（${key}）：1–5 分整数`).join('\n');
  const diff = input.diffText.trim() === '' ? '（无改动）' : input.diffText;
  return [
    '## 考题（候选拿到的任务）',
    input.taskPrompt,
    '',
    '## 评分维度（各 1–5 分，等权）',
    dimensions,
    '',
    '## 本用例的评分提示词',
    input.judgePrompt,
    '',
    '## 候选的代码改动',
    diff,
  ].join('\n');
}

/**
 * 跑一次评分：调用文本 API → 解析 → 合成总分。
 * 失败面分三类，处置不同：
 *   - 调用失败（网络 / 鉴权 / 限流）→ **透传原错误码**（§5.7 / §10：「没问到」与「答错了」是两回事，
 *     折成 JUDGE_PARSE_FAILED 会让使用者去改提示词，而真正的问题是密钥或限流）；
 *   - 解析失败 → JUDGE_PARSE_FAILED，并把截断后的 raw 放进 `context.raw`（编排层会把它写进事件日志，
 *     让日志抽屉里能直接看到模型到底回了什么）；
 *   - 形状不合契约 → 由 `ScoreResultSchema` 兜住（同一条 JUDGE_PARSE_FAILED 路径）。
 */
export async function judgeRow(input: JudgeInput): Promise<ScoreResult> {
  const prompt = buildJudgePrompt(input);

  let raw: string;
  try {
    // system 用 contracts 的输出契约文本：生成侧与解析侧共用同一份字段名（契约 §2.5 的单一真源）
    raw = await callTextApi(input.route, { system: JUDGE_OUTPUT_CONTRACT, prompt });
  } catch (error) {
    throw error instanceof ServiceError
      ? error
      : new ServiceError('INTERNAL', `调用评分模型失败：${reason(error)}`, { cause: error });
  }

  let parsed: ScoreResult['dimensions'] & { verdict: string };
  try {
    parsed = parseJudgeResponse(raw);
  } catch (error) {
    const detail = error instanceof ServiceError ? error.message : reason(error);
    throw new ServiceError('JUDGE_PARSE_FAILED', `评分解析失败：${detail}`, {
      context: { raw: truncateRaw(raw) },
      cause: error,
    });
  }

  const result: ScoreResult = {
    dimensions: [...parsed],
    // 总分一律重算：模型自报的总分可能算错，而界面必须与 5 维分自洽（§9 第 6 项冒烟）
    totalScore: composeTotalScore(parsed.map((item) => item.score)),
    verdict: parsed.verdict,
    raw: truncateRaw(raw, RAW_MAX_CHARS),
    judgeProviderId: input.judgeProviderId,
    judgeModelId: input.route.modelId,
    judgedAt: new Date().toISOString(),
  };
  // 契约自检：形状漂移在这里就炸，而不是把脏数据写进 run.json 等 p5 读的时候才发现
  return ScoreResultSchema.parse(result);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— `judge.test.ts` 共 8 个 `describe` / 25 个 `it` 全绿。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/judge.ts
git add packages/server/evaluator/src/judge.test.ts
git add packages/server/evaluator/src/testing/fixtures.ts
git commit -m "feat(evaluator): 评分调用（文本 API + 总分重算 + 解析失败保留 raw）"
```

---

## Task 5: `orchestrator.ts` —— 单行执行（八步时序 + 失败隔离）

**Files:**
- Create: `packages/server/evaluator/src/orchestrator.ts`
- Create: `packages/server/evaluator/src/orchestrator.test.ts`
- Modify: `packages/server/evaluator/src/testing/fixtures.ts`（追加真实小仓库、假适配器、假评分器）

**Interfaces:**
- Consumes（Task 1 / Task 2 / Task 4）：`getRun` / `saveRun`、`publishRowEvent`、`judgeRow`、`type JudgeInput`
- Consumes（p0 evaluator，契约 §5）：`resolveJudgeRoute(input: { judgeProviderId: string | null; judgeModelId: string | null }): TextRoute`
- Consumes（p0 core，契约 §3.2 / §3.3 / §3.4）：`ensureCaseCache(repoPath, cacheDir, commitHash = null): void`（**p0 的 R28 起有三个参数**；`commitHash === null` = 刷新到源仓库当前默认分支 tip，显式 commit 缺失时先 fetch 再判 `INVALID_REF`，消息点名**源仓库**路径）、`caseCacheDir(workspaceRoot, caseId): string`、`prepareRowWorkspace(input): { workspacePath; agentHome; baselineCommit }`（内部已调 `ensureCaseCache`，见本节第 12 条）、`collectDiff(dir, baselineCommit): { text; files; filesChanged; insertions; deletions }`、`truncateDiff(text, budgetBytes): { text; truncated; droppedFiles }`、`resetEvents(file): void`、`rowEventsFile(workspaceRoot, runId, rowId): string`
- Consumes（p0 contracts，契约 §2.4 / §2.5）：`AGENT_LABELS`、`PROTOCOL_LABELS`、`DIMENSIONS`、`TERMINAL_ROW_STATUSES`、`isRunnableRow`、`type EvalRow`、`type EvalRowStatus`、`type EvalRun`
- Consumes（p3 agents，契约 §4）：`getProvider(kind): AgentProvider`、`type AgentRunResult`
- Produces（本包内部入口，**不从 `index.ts` 导出**）：`runRow(runId: string, rowId: string): Promise<void>`

- [ ] **Step 1: 追加夹具（`testing/fixtures.ts` 末尾：真实小仓库 + 假适配器 + 假评分器）**

```ts
/**
 * 造一个**真实**的小 git 仓库（真 git，不是 mock）。
 * 为什么工作区相关的用例必须用真仓库：本计划最重要的一条守卫是「每行工作目录互不相同」，
 * 而假造复制/checkout 等于把守卫建立在自己的假设上——真仓库能让 prepareRowWorkspace 真的
 * 复制目录、真的 checkout、真的建分支，共用目录的实现在它面前藏不住。
 */
export function initFixtureRepo(dir: string): { repoPath: string; commit: string } {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ['init', '-q', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'test@example.invalid']);
  runGit(dir, ['config', 'user.name', 'aieval-test']);
  writeFileSync(join(dir, 'README.md'), '# 测试仓库\n', 'utf8');
  writeFileSync(join(dir, 'src.txt'), 'hello\n', 'utf8');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-q', '-m', 'init']);
  return { repoPath: dir, commit: runGit(dir, ['rev-parse', 'HEAD']).trim() };
}

/** 跑一条 git 命令；失败时把 stderr 一起抛出来（静默失败的夹具会把排查成本抬得很高） */
function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`git ${args.join(' ')} 失败：${stderr || String(error)}`);
  }
}

/** 造一个合法的 ScoreResult（总分按 contracts 的 composeTotalScore 算，夹具里不另写一份公式） */
export function makeScoreFixture(score = 4, judgeProviderId = 'judge-provider', judgeModelId = 'judge-model'): ScoreResult {
  const dimensions = DIMENSIONS.map(({ key, label }) => ({ key, label, score, reason: `${label}：假评分器给 ${score} 分` }));
  return {
    dimensions,
    totalScore: composeTotalScore(dimensions.map((item) => item.score)),
    verdict: '假评分器的总评',
    raw: '{"fake":true}',
    judgeProviderId,
    judgeModelId,
    judgedAt: new Date().toISOString(),
  };
}

/** 一次假适配器调用的记录：编排层的用例靠它断言「谁在什么时候跑、并发峰值多少、拿到的路由是什么」 */
export interface FakeAgentCall {
  kind: AgentKind;
  cwd: string;
  configHome: string;
  baseUrl: string;
  modelId: string;
  startedAt: number;
  finishedAt: number | null;
  exitReason: AgentExitReason | null;
  aborted: boolean;
}

/** 假适配器的行为脚本（按 kind 设置） */
export interface FakeAgentScript {
  /**
   * ok=正常返回；error=返回 ok:false；gate=挂起等测试放行（被终止时按协作适配器返回 canceled）；
   * hang=永不返回且无视 signal（模拟非合作适配器，只有编排层的硬停能收场）；
   * throw=run() 直接抛异常（模拟契约违例：契约说 run() 返回 ok:false，不抛）
   */
  mode?: 'ok' | 'error' | 'gate' | 'hang' | 'throw';
  /** 是否按 `input.timeoutMs` 自己停止（协作适配器的内层超时，§5.6.5 的第一段） */
  honorTimeout?: boolean;
  /** 返回前写进工作区的文件（内容里建议带上 cwd，便于把调用对回具体行） */
  files?: { path: string; content: string }[];
  /** `mode: 'error'` 时**不带** error 字段：复现「ok:false 却没有原因」的契约违例 */
  omitError?: boolean;
  tokens?: { input: number; cached: number; output: number } | null;
  turns?: number | null;
}

export const fakeAgents = {
  calls: [] as FakeAgentCall[],
  concurrent: 0,
  maxConcurrent: 0,
  /** gate 模式下挂起的 run：cwd → 放行函数 */
  gates: new Map<string, () => void>(),
  scripts: new Map<AgentKind, FakeAgentScript>(),
};

/** 每个用例开头调它：模块级状态在同一测试文件里是共享的 */
export function resetFakeAgents(): void {
  fakeAgents.calls.length = 0;
  fakeAgents.concurrent = 0;
  fakeAgents.maxConcurrent = 0;
  fakeAgents.gates.clear();
  fakeAgents.scripts.clear();
}

/** 放行某一行的 gate（按 cwd）；没有等待者时是空操作 */
export function releaseAgent(cwd: string): void {
  fakeAgents.gates.get(cwd)?.();
}

/** 放行当前所有 gate */
export function releaseAllAgents(): void {
  for (const release of [...fakeAgents.gates.values()]) release();
}

/** 假 provider：元数据与 §5.6.2 的表一致，run() 的行为完全由脚本决定 */
function makeFakeProvider(kind: AgentKind): AgentProvider {
  const metadata: AgentProviderMetadata = {
    protocolType: kind === 'codex' ? 'openai' : 'anthropic',
    capability: { cancelMidTurn: kind !== 'dsh', usage: true },
    isolation: 'subprocess',
  };
  return {
    kind,
    displayName: `假 ${kind}`,
    metadata,
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const script = fakeAgents.scripts.get(kind) ?? {};
      const mode = script.mode ?? 'ok';
      const call: FakeAgentCall = {
        kind,
        cwd: input.cwd,
        configHome: input.configHome,
        baseUrl: input.route.baseUrl,
        modelId: input.route.modelId,
        startedAt: Date.now(),
        finishedAt: null,
        exitReason: null,
        aborted: false,
      };
      fakeAgents.calls.push(call);
      fakeAgents.concurrent += 1;
      fakeAgents.maxConcurrent = Math.max(fakeAgents.maxConcurrent, fakeAgents.concurrent);
      const finish = (exitReason: AgentExitReason, ok: boolean, error?: AgentRunResult['error']): AgentRunResult => {
        call.finishedAt = Date.now();
        call.exitReason = exitReason;
        fakeAgents.concurrent -= 1;
        const durationMs = (call.finishedAt ?? Date.now()) - call.startedAt;
        return {
          ok,
          exitReason,
          tokens: script.tokens ?? { input: 10, cached: 0, output: 20 },
          turns: script.turns ?? 1,
          durationMs,
          ...(error === undefined ? {} : { error }),
        };
      };
      const writeFiles = (): void => {
        for (const file of script.files ?? []) writeFileSync(join(input.cwd, file.path), file.content, 'utf8');
      };
      input.signal.addEventListener('abort', () => { call.aborted = true; }, { once: true });

      if (mode === 'hang') {
        // 非合作适配器：无视 signal、永不返回。孤儿 promise 无法回收（JS 没有取消异步的机制），
        // 这正是 §5.6.5 要求适配器自带 interrupt → dispose 有界清理的原因；编排层的硬停保证轮能收尾。
        await new Promise<never>(() => {});
      }
      if (mode === 'throw') {
        // 契约违例：run() 直接抛，而不是返回 ok:false。并发计数要还原，否则会污染后续用例的峰值断言
        call.finishedAt = Date.now();
        fakeAgents.concurrent -= 1;
        throw new Error('假适配器：run() 直接抛了异常（契约违例）');
      }
      if (mode === 'error') {
        // omitError 用来复现契约违例（ok:false 却不带 error）：编排层必须仍给出可读归因
        return finish(
          'error',
          false,
          script.omitError === true ? undefined : { code: 'AGENT_FAILED', message: '假适配器：进程非零退出' },
        );
      }
      if (mode === 'gate' || script.honorTimeout === true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await new Promise<'released' | 'canceled' | 'timeout'>((resolve) => {
          fakeAgents.gates.set(input.cwd, () => resolve('released'));
          input.signal.addEventListener('abort', () => resolve('canceled'), { once: true });
          if (script.honorTimeout === true) timer = setTimeout(() => resolve('timeout'), input.timeoutMs);
        });
        if (timer !== undefined) clearTimeout(timer);
        if (outcome === 'timeout') return finish('timed-out', false, { code: 'AGENT_TIMED_OUT', message: '假适配器：内层超时' });
        if (outcome === 'canceled') return finish('canceled', false, { code: 'AGENT_CANCELED', message: '假适配器：被终止' });
      }
      writeFiles();
      return finish('completed', true);
    },
  };
}

/** 供测试里的 `vi.mock('@aieval/agents', …)` 用作替代模块：只有注册表，没有任何厂商 SDK */
export function fakeAgentsModule(): {
  getProvider: (kind: AgentKind) => AgentProvider;
  listAgentProviders: () => AgentProvider[];
} {
  return {
    getProvider: (kind) => makeFakeProvider(kind),
    listAgentProviders: () => AGENT_KINDS.map((kind) => makeFakeProvider(kind)),
  };
}

/** 假评分器的状态 */
export const fakeJudge = {
  calls: [] as JudgeInput[],
  /** ok=返回固定分；fail=抛 JUDGE_PARSE_FAILED（带 raw）；conflict=抛未配置评分模型；gate=挂起等放行 */
  mode: 'ok' as 'ok' | 'fail' | 'conflict' | 'gate',
  score: 4,
  gates: [] as (() => void)[],
};

/** 每个用例开头调它 */
export function resetFakeJudge(): void {
  fakeJudge.calls.length = 0;
  fakeJudge.mode = 'ok';
  fakeJudge.score = 4;
  fakeJudge.gates.length = 0;
}

/** 放行当前所有评分 gate */
export function releaseJudge(): void {
  for (const release of fakeJudge.gates.splice(0)) release();
}

/** 供 `vi.mock('./judge', …)` 用作替代模块 */
export function fakeJudgeModule(): { judgeRow: (input: JudgeInput) => Promise<ScoreResult> } {
  return {
    judgeRow: async (input) => {
      fakeJudge.calls.push(input);
      if (fakeJudge.mode === 'fail') {
        throw new ServiceError('JUDGE_PARSE_FAILED', `评分解析失败：维度缺失：${DIMENSIONS[3]?.label ?? '健壮性'}（robustness）没有出现在返回里`, {
          context: { raw: '{"dimensions":[]}' },
        });
      }
      if (fakeJudge.mode === 'conflict') {
        throw new ServiceError('CONFLICT', '未配置评分模型：请先到「设置 → 评分配置」里选择默认评分模型');
      }
      if (fakeJudge.mode === 'gate') {
        await new Promise<void>((resolve) => { fakeJudge.gates.push(resolve); });
      }
      return makeScoreFixture(fakeJudge.score, input.judgeProviderId, input.route.modelId);
    },
  };
}
```

夹具顶部的 import 需要补齐（这些名字在上面都用到了）：

```ts
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_KINDS,
  DIMENSIONS,
  SETTINGS_DEFAULTS,
  ServiceError,
  composeTotalScore,
  type EvalRow,
  type EvalRun,
  type ExecutionMode,
  type Provider,
  type ScoreResult,
  type Settings,
  type TestCase,
} from '@aieval/contracts';
import { saveConfig, setConfigDirForTesting } from '@aieval/core';
import type { AgentExitReason, AgentKind, AgentProvider, AgentProviderMetadata, AgentRunInput, AgentRunResult } from '@aieval/agents';
import type { JudgeInput } from '../judge';
```

- [ ] **Step 2: 写失败测试 `orchestrator.test.ts`（本任务只测单行执行）**

```ts
// @vitest-environment node
/**
 * 单行执行（spec §5.5 的八步）与失败面。
 *
 * 智能体用假注册表（`vi.mock('@aieval/agents')`）：编排层对智能体的**唯一**入口就是
 * `getProvider(kind).run()`，换掉这个模块边界就完全控制了「什么时候开始、什么时候结束、
 * 是否响应终止、返回什么计量」，且不会加载任何厂商 SDK（A6 的懒加载根本不会被触发）。
 * 为什么不选 `setAgentRuntimeForTesting({ sdkModule })`：那条路注入的是**厂商 SDK 的假模块**，
 * 真正的执行仍要穿过 p3 三家适配器的实现与事件归一化——测出来的是「p3 的适配器 + 本层编排」
 * 的耦合体，超时与终止的时序还要绕过适配器自己的释放窗口，用例会又慢又脆。
 * 适配器本身由 p3 按 §5.6.7 用假实现单独测；本层把适配器当作已被验证过的边界。
 *
 * 评分用假 judgeRow（`vi.mock('./judge')`）：本文件测的是编排时序与落盘，
 * 评分器的行为有它自己的测试（Task 3 / Task 4）。
 * 工作区用**真实** git 小仓库：F6「每行独立工作区」必须建立在真实目录上。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentKind, EvalRun, Provider } from '@aieval/contracts';
import { loadConfig, readEvents, rowEventsFile, saveConfig } from '@aieval/core';
import { runRow } from './orchestrator';
import { getRun, saveRun } from './run-store';
import {
  createTempHome,
  fakeAgents,
  fakeJudge,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  resetFakeAgents,
  resetFakeJudge,
  seedConfig,
  type TempHome,
} from './testing/fixtures';

vi.mock('@aieval/agents', async () => {
  const { fakeAgentsModule } = await import('./testing/fixtures');
  return fakeAgentsModule();
});

vi.mock('./judge', async () => {
  const { fakeJudgeModule } = await import('./testing/fixtures');
  return fakeJudgeModule();
});

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
  resetFakeAgents();
  resetFakeJudge();
});

afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

/** 造一轮真实可跑的评测：真实 git 小仓库 + 已落盘的供应商 / 用例 / 轮次 */
function seedRunnableRun(options: {
  rowCount: number;
  executionMode: 'parallel' | 'serial';
  rowTimeoutMs?: number;
  diffBudgetBytes?: number;
  withJudge?: boolean;
  agentKind?: AgentKind;
  repoPath?: string;
}): { run: EvalRun; provider: Provider } {
  const fixtureRepo = initFixtureRepo(join(home.root, `repo-${randomUUID()}`));
  const repoPath = options.repoPath ?? fixtureRepo.repoPath;
  const provider = makeProviderFixture();
  const testCase = makeCaseFixture({ repoPath, commitHash: fixtureRepo.commit });
  seedConfig({
    workspaceRoot: home.workspaceRoot,
    providers: [provider],
    cases: [testCase],
    rowTimeoutMs: options.rowTimeoutMs,
    diffBudgetBytes: options.diffBudgetBytes,
    defaultJudge: options.withJudge === false ? null : { providerId: provider.id, modelId: 'judge-model' },
  });
  const rows = Array.from({ length: options.rowCount }, () =>
    makeRowFixture({
      agentKind: options.agentKind ?? 'codex',
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
    }),
  );
  const run = makeRunFixture({
    workspaceRoot: home.workspaceRoot,
    caseId: testCase.id,
    executionMode: options.executionMode,
    rows,
    repoPath,
    commitHash: fixtureRepo.commit,
  });
  saveRun(run);
  return { run, provider };
}

describe('runRow：八步时序与落盘', () => {
  it('成功一行：状态 judged、计量与 diff 落库、事件顺序与 seq 正确、工作区真的有产物', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '由假适配器写入\n' }] });

    await runRow(run.id, rowId);

    const saved = getRun(run.id);
    const row = saved.rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.branch).toBe(`test/${rowId}`);
    // R2：基线必须是 40 位具体 hash，不能是 'HEAD' 之类的符号引用
    expect(row?.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.tokens).toEqual({ input: 10, cached: 0, output: 20 });
    expect(row?.turns).toBe(1);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.diff).toEqual({ filesChanged: 1, insertions: 1, deletions: 0, truncated: false });
    expect(row?.score?.totalScore).toBe(80); // 5 维各 4 分
    expect(row?.error).toBeNull();
    expect(existsSync(join(row?.workspacePath ?? '', 'agent-output.txt'))).toBe(true);
    // 轮级状态不归 runRow 管（它由 Task 6 的轮任务收尾）
    expect(saved.status).toBe('idle');

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(events.map((event) => (event.type === 'status' ? `status:${event.status}` : event.type))).toEqual([
      'status:preparing',
      'status:running',
      'diff-summary',
      'status:judging',
      'score',
      'status:judged',
      'end',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('agent 在 cwd 里干活：假适配器写进工作区的文件真的出现在工作副本里', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '假适配器的产出\n' }] });

    await runRow(run.id, rowId);

    const workspacePath = getRun(run.id).rows[0]?.workspacePath ?? '';
    expect(fakeAgents.calls[0]?.cwd).toBe(workspacePath);
    expect(existsSync(join(workspacePath, 'agent-output.txt'))).toBe(true);
  });

  it('采集不到计量时写 null，绝不写 0（0 与「没采到」在横向对比里含义相反）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { tokens: null, turns: null });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.tokens).toBeNull();
    expect(row?.turns).toBeNull();
  });

  it('重跑同一行前清空事件日志：上一次的 error 不混进新一次执行，seq 重新从 1 开始', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    const config = loadConfig();

    // 第一次：供应商被删掉 → 该行 failed，日志里留下 error
    saveConfig({ ...config, providers: [] });
    await runRow(run.id, rowId);
    const first = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(first.some((event) => event.type === 'error')).toBe(true);

    // 第二次：恢复配置重跑
    saveConfig(config);
    await runRow(run.id, rowId);

    const second = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(second.some((event) => event.type === 'error')).toBe(false);
    expect(second[0]?.seq).toBe(1);
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    expect(getRun(run.id).rows[0]?.error).toBeNull();
  });
});

describe('runRow：失败面与配置漂移（每一行都必须落到终态 + 可读原因）', () => {
  it('准备阶段失败（仓库不是 git 仓库）也要落 failed 并保留错误详情，不能静默停在 preparing', async () => {
    const notARepo = join(home.root, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: notARepo });
    const rowId = run.rows[0]?.id ?? '';

    await runRow(run.id, rowId); // 永不抛：失败被折成终态

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBeTruthy();
    expect(row?.error?.message.length).toBeGreaterThan(0);
    expect(row?.error?.message).not.toContain('undefined');
    expect(row?.diff).toBeNull(); // 工作区没建起来，没有 diff 可取
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)?.type).toBe('end');
  });

  it('供应商已删除 → failed 且给出去向，而不是 TypeError', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const config = loadConfig();
    saveConfig({ ...config, providers: [] });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('供应商已删除');
    expect(row?.error?.message).toContain('新建评测');
  });

  it('供应商的 baseUrl 被改过：用**当前配置**执行，但差异必须留 WARN（快照只用于追溯）', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig();
    saveConfig({
      ...config,
      providers: config.providers.map((item) =>
        item.id === provider.id ? { ...item, baseUrl: 'https://moved.invalid/v1' } : item,
      ),
    });

    await runRow(run.id, run.rows[0]?.id ?? '');

    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    // 真正生效的是当前配置（改地址多半是为了修一个错，拿旧地址重跑会再错一次）
    expect(fakeAgents.calls[0]?.baseUrl).toBe('https://moved.invalid/v1');
    // 但差异必须留痕：快照与当前配置不一致这件事本身要能被发现
    const warnText = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnText).toContain('baseUrl 快照与供应商当前配置不一致');
  });

  it('适配器 run() 直接抛异常（契约违例）→ 该行仍落 failed、原因可读，且失败行的 diff 照样留痕', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'throw', files: [{ path: 'half-done.txt', content: '跑到一半\n' }] });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('假适配器：run() 直接抛了异常');
    // 「它跑到一半改了什么」正是失败行最需要看的证据（见计划开头的实现层修正第 9 条）
    expect(row?.diff).not.toBeNull();
  });

  it('协议不匹配（openai 供应商 + Claude Code 行）→ failed 且两种协议都说清楚', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', agentKind: 'claude-code' });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('Claude Code');
    expect(row?.error?.message).toContain('Anthropic');
  });

  it('用例已删除 → failed 且说明「历史可看、不能跑」', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const config = loadConfig();
    saveConfig({ ...config, cases: [] });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('用例已删除');
    expect(row?.error?.message).toContain('历史记录仍可查看');
  });

  it('未配置评分模型 → failed 且错误信息指向设置页（不是崩、不是停在 judging）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: false });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toMatch(/设置/);
    // 前置步骤的产物仍然要留痕：diff 与计量已经落库，失败只影响分数
    expect(row?.diff?.filesChanged).toBe(0);
    expect(row?.tokens).toEqual({ input: 10, cached: 0, output: 20 });
  });

  it('评分解析失败 → failed + JUDGE_PARSE_FAILED，且 raw 原文进入事件日志（日志抽屉可见）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'fail';

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('JUDGE_PARSE_FAILED');
    expect(row?.score).toBeNull();

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    const logText = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('{"dimensions":[]}');
    expect(logText).toContain('评分模型原始返回');
  });

  it('适配器返回 ok:false 却不带 error（契约违例）→ 仍给出可读归因', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // omitError：复现「ok:false 却没有 error 字段」的契约违例（假适配器的脚本开关）
    fakeAgents.scripts.set('codex', { mode: 'error', omitError: true });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('AGENT_FAILED');
    expect(row?.error?.message).toContain('适配器未给出原因');
  });

  it('diff 超预算：按文件裁剪、标 truncated、把被丢弃的文件写进日志', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', diffBudgetBytes: 200 });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', {
      files: [
        { path: 'big-a.txt', content: `A${'x'.repeat(2_000)}\n` },
        { path: 'big-b.txt', content: `B${'y'.repeat(2_000)}\n` },
      ],
    });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.diff?.filesChanged).toBe(2);
    expect(row?.diff?.truncated).toBe(true);

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    const summary = events.find((event) => event.type === 'diff-summary');
    expect(summary?.type === 'diff-summary' ? summary.truncated : false).toBe(true);
    const logText = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('diff 超过上限 200 字节');
    expect(logText).toMatch(/big-a\.txt|big-b\.txt/);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `Failed to resolve import "./orchestrator"`。

> **裁剪算法本身不归本计划测**：`truncateDiff` 的「按文件切分、保留到预算为止、输出含截断标记与被丢弃清单」
> 是 p0 的 `core` 单测（spec §9 的「diff 裁剪」那一行）。本层要钉的是**接线**：
> 预算来自 `settings.diffBudgetBytes`、`truncated` 真的写进了 `EvalRow.diff` 与 `diff-summary` 事件、
> 被丢弃的文件名进了日志。两处都不许省——p0 的算法对了但没接上线，使用者看到的仍是「没有截断」。

- [ ] **Step 4: 写实现 `orchestrator.ts`（本任务只写单行执行）**

```ts
/**
 * 一轮评测的编排：本任务先落地**单行执行**（spec §5.5 的八步 + 失败隔离），
 * 轮级状态机（并行 / 串行 / 超时 / 终止）在 Task 6 追加到本文件。
 *
 * 三条不许动的口径：
 *   1. **每行一个独立工作区**（F6）：串行只省 CPU 与供应商配额，不省工作区——串行共用一个目录会让
 *      第二个 agent 在第一个的改动上继续写，分数无意义、整轮作废；
 *   2. **行超时判定的归属只有一处**：适配器的内层 `timeoutMs` 先响，本层持有外层兜底；
 *      `signal` 只表示「外部要求停止」、不带原因，故原因由本层记账（userAborted / timedOutRows），
 *      优先级：用户终止 > 外层兜底超时 > 适配器自报的 exitReason；
 *   3. **失败隔离**：任何异常都在本层折成该行的终态，绝不让一行的问题冒到轮级（F12）。
 *
 * 注意：本模块不写 `process.env`（§5.6.4 硬性不变量）、不拼 git 命令（走 core）、不发 HTTP（走 judge）。
 */
import {
  AGENT_LABELS,
  DIMENSIONS,
  PROTOCOL_LABELS,
  ServiceError,
  TERMINAL_ROW_STATUSES,
  isRunnableRow,
  type AgentEvent,
  type EvalRow,
  type EvalRowStatus,
  type EvalRun,
} from '@aieval/contracts';
import {
  caseCacheDir,
  collectDiff,
  createLogger,
  ensureCaseCache,
  loadConfig,
  prepareRowWorkspace,
  resetEvents,
  rowEventsFile,
  truncateDiff,
} from '@aieval/core';
import { getProvider, type AgentRunResult } from '@aieval/agents';
import { publishRowEvent } from './events';
import { judgeRow } from './judge';
import { resolveJudgeRoute } from './judge-route';
import { getRun, saveRun } from './run-store';

const log = createLogger('evaluator');

/** 硬停宽限：外层兜底发出停止信号后再等这么久还不返回，就按超时收尾（适配器承诺有界清理，正常路径走不到） */
const HARD_STOP_MARGIN_MS = 2_000;

/** 在途行的终止控制器：abortRun / abortRow 靠它把「停止」交给适配器 */
const rowAborts = new Map<string, AbortController>();
/** 被**用户**要求停止的行（`signal` 不带原因，原因必须由编排层记账） */
const userAborted = new Set<string>();
/** 触发了**外层兜底超时**的行（同上：不能靠 `signal.aborted` 推断是不是超时） */
const timedOutRows = new Set<string>();

function rowKey(runId: string, rowId: string): string {
  return `${runId}:${rowId}`;
}

/** 取快照 + 取行；行不存在抛 NOT_FOUND（带两个 id，便于从日志反查） */
function requireRow(runId: string, rowId: string): { run: EvalRun; row: EvalRow } {
  const run = getRun(runId);
  const row = run.rows.find((item) => item.id === rowId);
  if (row === undefined) throw new ServiceError('NOT_FOUND', `评测 ${runId} 里没有候选行 ${rowId}`);
  return { run, row };
}

/** 改一行的字段并落盘快照；行不存在即抛 NOT_FOUND */
function mutateRow(runId: string, rowId: string, mutate: (row: EvalRow) => void): EvalRun {
  const { run, row } = requireRow(runId, rowId);
  mutate(row);
  saveRun(run);
  return run;
}

/**
 * 行状态变更的**唯一**入口：写快照（run.json）+ 追加状态事件（events.jsonl）。
 * 为什么合成一个函数：F14 要求事件日志是唯一真相源，而真相源一旦有两个写入点就必然漂移；
 * 状态只在这里改，别处只补字段（patchRow）。`patch` 先合并、`status` 后覆盖，避免 patch 顺手改掉状态。
 * 全仓**不许**出现「直接 `row.status = …` 再 `saveRun`」的第二条路径——那是漂移的开始。
 */
function setRowStatus(runId: string, rowId: string, status: EvalRowStatus, patch?: Partial<EvalRow>): EvalRun {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch ?? {}, { status });
  });
  publishRowEvent(runId, rowId, { type: 'status', status });
  return getRun(runId);
}

/** 只补字段、不动状态：计量 / diff 摘要在跑的过程中逐步落库，状态由 setRowStatus 管 */
function patchRow(runId: string, rowId: string, patch: Partial<EvalRow>): void {
  mutateRow(runId, rowId, (row) => {
    Object.assign(row, patch);
  });
}

/** 让出一次事件循环：工作区准备是同步重活（整目录复制 + checkout），留在调用方栈里会让「开始」这个请求卡住整段复制时长 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 外层兜底的宽限：至少 1 秒，且为行超时的 10%（行超时越长，适配器自己的收尾越慢） */
function backstopMarginMs(rowTimeoutMs: number): number {
  return Math.max(1_000, Math.round(rowTimeoutMs * 0.1));
}

/** 错误对象 → ServiceError：已是 ServiceError 就原样透传（错误码要保留给该行的 `error.code`） */
function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  return new ServiceError('INTERNAL', error instanceof Error ? error.message : String(error), { cause: error });
}

/** 从 `ServiceError.context` 里取回解析失败时保留的原文（编排层要把它写进事件日志） */
function rawFromContext(context: unknown): string | null {
  if (typeof context !== 'object' || context === null) return null;
  const raw = (context as { raw?: unknown }).raw;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/** 终止类结果的判定结果 */
interface RowOutcome {
  status: 'canceled' | 'timed-out' | 'failed';
  error: EvalRow['error'];
  exitReason: string;
}

/**
 * 判定终止类结果（§5.6.5 的优先级，逐字落地）：
 *   用户终止 → `canceled`；外层兜底超时 → `timed-out`；其余按适配器自报的 `exitReason`。
 * 为什么不能只看 `signal.aborted`：外层兜底也会 abort 同一个 signal，
 * 一律当 canceled 就会把「跑飞了」记成「用户终止」——两者的处置（重跑 vs 调小超时）完全不同。
 * 返回 null 表示「正常完成」，交给评分阶段。
 */
function classifyStop(input: { userAborted: boolean; timedOut: boolean; result: AgentRunResult | null }): RowOutcome | null {
  if (input.userAborted) return { status: 'canceled', error: null, exitReason: 'canceled' };
  if (input.timedOut || input.result === null) {
    return {
      status: 'timed-out',
      error: { code: 'AGENT_TIMED_OUT', message: '超过该行的超时上限，已强制停止' },
      exitReason: 'timed-out',
    };
  }
  const { result } = input;
  if (result.exitReason === 'canceled') return { status: 'canceled', error: null, exitReason: 'canceled' };
  if (result.exitReason === 'timed-out') {
    return {
      status: 'timed-out',
      error: { code: 'AGENT_TIMED_OUT', message: '超出智能体自身的超时上限' },
      exitReason: 'timed-out',
    };
  }
  if (!result.ok || result.exitReason === 'error') {
    // 适配器违约（ok:false 却没给 error）也要给出可读归因，不能让界面显示空白原因
    const detail = result.error;
    return {
      status: 'failed',
      error:
        detail === undefined
          ? { code: 'AGENT_FAILED', message: '智能体执行失败（适配器未给出原因）' }
          : { code: detail.code, message: detail.message, ...(detail.stack === undefined ? {} : { stack: detail.stack }) },
      exitReason: 'error',
    };
  }
  return null;
}

/** 清掉这一行的在途状态：控制器与「终止原因」的记账，避免长驻进程里累积 */
function clearRowRuntime(runId: string, rowId: string): void {
  const key = rowKey(runId, rowId);
  rowAborts.delete(key);
  userAborted.delete(key);
  timedOutRows.delete(key);
}

/**
 * 落一个终止类终态。**终态优先**：abortRun / abortRow 是同步落库的，在途任务稍后带着
 * 终止结果回来时不能再写一次状态（用户明明按了终止，几秒后状态跳回 timed-out 是最难解释的行为）。
 */
function settleStopped(runId: string, rowId: string, outcome: RowOutcome): void {
  const { row } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(row.status)) {
    log.debug('行已被同步终止，执行侧不再改状态', { runId, rowId, status: row.status });
    return;
  }
  setRowStatus(runId, rowId, outcome.status, { error: outcome.error });
  publishRowEvent(runId, rowId, { type: 'end', exitReason: outcome.exitReason });
}

/** 把一行落成 `failed`（终态优先，理由同 settleStopped） */
function settleFailed(runId: string, rowId: string, error: ServiceError, durationMs: number | null): void {
  publishRowEvent(runId, rowId, {
    type: 'error',
    message: `${error.code}：${error.message}`,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  });
  const raw = rawFromContext(error.context);
  if (raw !== null) {
    // 评分解析失败时把模型原文摊进日志：日志抽屉是唯一能回答「是提示词的问题还是模型的问题」的地方（§5.7）
    publishRowEvent(runId, rowId, { type: 'log', stream: 'stderr', text: `评分模型原始返回（截断）：\n${raw}` });
  }

  const { row } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(row.status)) {
    log.warn('候选行已是终态，错误只记入事件日志、不改状态', { runId, rowId, status: row.status, code: error.code });
    return;
  }
  setRowStatus(runId, rowId, 'failed', {
    error: { code: error.code, message: error.message, ...(error.stack === undefined ? {} : { stack: error.stack }) },
    durationMs: row.durationMs ?? durationMs,
  });
  publishRowEvent(runId, rowId, { type: 'end', exitReason: 'error' });
}

/**
 * 跑一行并**保证它离开在途集合**：所有失败都在这里折成终态（F12 的失败隔离在行这一级落地）。
 * 唯一可能停在非终态的情况是「连落盘都失败」（磁盘满 / 目录被删），那种情况会打 ERROR。
 */
export async function runRow(runId: string, rowId: string): Promise<void> {
  try {
    await runRowAttempt(runId, rowId);
  } catch (error) {
    const serviceError = toServiceError(error);
    log.error('候选行执行失败', { runId, rowId, code: serviceError.code, message: serviceError.message });
    try {
      settleFailed(runId, rowId, serviceError, null);
    } catch (secondary) {
      log.error('落 failed 也失败（该行可能停在非终态）', {
        runId,
        rowId,
        reason: toServiceError(secondary).message,
      });
    }
  } finally {
    clearRowRuntime(runId, rowId);
  }
}

/**
 * 跑一行的完整过程：spec §5.5 的八步。
 * 前三步（建工作区 / 取基线 / 注入隔离配置）由 `core.prepareRowWorkspace` 一次完成；
 * 「注入隔离配置」在本层只体现为把 `configHome` 交给适配器——真正写环境变量的是适配器
 * （§5.6.4 的三条不变量：本仓任何地方都不写 `process.env`）。
 *
 * 为什么先落 `preparing` 再让出事件循环、最后才复制工作区：复制是同步重活，放在调用方
 * （`startRun`）的调用栈里会让「开始」这个请求卡住整段复制时长（并行 6 行就是 6 倍），
 * 而界面在此期间连一个状态变化都看不到。
 */
async function runRowAttempt(runId: string, rowId: string): Promise<void> {
  const { run, row } = requireRow(runId, rowId);
  if (!isRunnableRow(row.status)) return; // 已被终止或已结束：什么都不做

  const config = loadConfig();
  const settings = config.settings;
  const testCase = config.cases.find((item) => item.id === run.caseId);
  if (testCase === undefined) {
    // §4.4 允许删用例后评测仍可读，但「跑」必须有题面与评分提示词——它们没有被快照进 run.json
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法执行该行；历史记录仍可查看`);
  }
  const providerRecord = config.providers.find((item) => item.id === row.providerId);
  if (providerRecord === undefined) {
    throw new ServiceError('CONFLICT', `供应商已删除（${row.providerId}），该行无法执行；请重建供应商后新建评测`);
  }
  const agentProvider = getProvider(row.agentKind);
  if (providerRecord.protocolType !== agentProvider.metadata.protocolType) {
    // F2 的过滤在创建评测时已拦一次；这里再拦一次，因为供应商的协议可能在创建之后被改过
    throw new ServiceError(
      'CONFLICT',
      `${AGENT_LABELS[row.agentKind]} 只接受 ${PROTOCOL_LABELS[agentProvider.metadata.protocolType]} 协议的供应商，` +
        `而「${providerRecord.name}」是 ${PROTOCOL_LABELS[providerRecord.protocolType]}`,
    );
  }
  if (providerRecord.baseUrl !== row.baseUrl) {
    // 快照用于追溯、当前配置用于执行：改了地址后重跑应当用新地址，但差异必须留痕
    log.warn('行的 baseUrl 快照与供应商当前配置不一致，本次执行使用当前配置', {
      runId,
      rowId,
      snapshot: row.baseUrl,
      current: providerRecord.baseUrl,
    });
  }

  // 重跑同一行前清空事件日志：新旧事件混在一个文件里，seq 与时间线都会对不上
  resetEvents(rowEventsFile(run.workspaceBase, runId, rowId));

  setRowStatus(runId, rowId, 'preparing', {
    error: null,
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
  });
  await yieldToEventLoop();

  // 第 1 步：用例级缓存仓库 —— 由 prepareRowWorkspace 内部调用（见本节第 12 条与契约 §3.3/R28），
  // 编排层**不要**再单独调一次：两参数形式落在 commitHash=null 分支上，会逐行刷新缓存，
  // 且源仓库不可达时会直接抛 NOT_A_GIT_REPO（哪怕该行的 commit 已在缓存里）。
  // 第 2、3 步：复制缓存 → checkout 基线 → 建 test/{rowId} 分支 → 建该行独立的 .agenthome
  const branch = `test/${rowId}`;
  const prepared = prepareRowWorkspace({
    workspaceRoot: run.workspaceBase,
    caseId: run.caseId,
    repoPath: run.repoPath,
    runId,
    rowId,
    commitHash: run.commitHash,
    branch,
  });
  patchRow(runId, rowId, {
    workspacePath: prepared.workspacePath,
    branch,
    baselineCommit: prepared.baselineCommit,
  });

  const key = rowKey(runId, rowId);
  const controller = new AbortController();
  rowAborts.set(key, controller);
  const timeoutMs = settings.rowTimeoutMs;
  const margin = backstopMarginMs(timeoutMs);
  const startedAt = Date.now();

  // 第 4 步：跑智能体（内层上限交给适配器，外层兜底由本层持有）
  setRowStatus(runId, rowId, 'running');
  const backstop = setTimeout(() => {
    timedOutRows.add(key);
    controller.abort();
    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stderr',
      text: `[编排] 已超过行超时 ${timeoutMs} ms，发出停止信号；适配器若未在释放窗口内返回，将按超时收尾`,
    });
  }, timeoutMs + margin);

  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<null>((resolve) => {
    hardStop = setTimeout(() => resolve(null), timeoutMs + margin + HARD_STOP_MARGIN_MS);
  });

  // 行判定终态之后，适配器收尾期间吐出来的迟到事件不再落盘（它们会把「已结束」的日志拖长）
  let settled = false;
  const onEvent = (event: AgentEvent): void => {
    if (settled) return;
    publishRowEvent(runId, rowId, event);
  };

  let result: AgentRunResult | null = null;
  let agentError: ServiceError | null = null;
  try {
    result = await Promise.race([
      agentProvider.run({
        cwd: prepared.workspacePath,
        configHome: prepared.agentHome,
        prompt: testCase.taskPrompt,
        route: {
          protocolType: providerRecord.protocolType,
          baseUrl: providerRecord.baseUrl,
          apiKey: providerRecord.apiKey,
          modelId: row.modelId,
        },
        timeoutMs,
        signal: controller.signal,
        onEvent,
      }),
      hardDeadline,
    ]);
  } catch (error) {
    // 契约说 run() 返回 ok:false（不抛），但实现可能违例；违例也必须落成可读的 failed
    agentError = toServiceError(error);
  } finally {
    clearTimeout(backstop);
    if (hardStop !== undefined) clearTimeout(hardStop);
  }
  settled = true;
  const elapsedMs = Date.now() - startedAt;
  if (result === null) {
    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stderr',
      text: `[编排] 适配器未在 ${timeoutMs + margin + HARD_STOP_MARGIN_MS} ms 内返回，按超时收尾（可能有残留子进程）`,
    });
  }

  // 第 5 步：收集计量。采集不到就是 null，**绝不填 0**（§5.6.3：0 token 与「没采到」含义相反）
  const measured = { tokens: result?.tokens ?? null, turns: result?.turns ?? null };
  // 为什么失败 / 被终止的行也测耗时：它是客观事实，且正是排查要看的东西（「超时前跑了多久」）；
  // token 与轮次只有适配器能给，故那两项在没结果时保持 null
  const durationMs = result?.durationMs ?? elapsedMs;

  // 第 6 步：算 diff（三样合并），并按 diffBudgetBytes 裁剪
  const collected = collectDiff(prepared.workspacePath, prepared.baselineCommit);
  const clipped = truncateDiff(collected.text, settings.diffBudgetBytes);
  patchRow(runId, rowId, {
    ...measured,
    durationMs,
    diff: {
      filesChanged: collected.filesChanged,
      insertions: collected.insertions,
      deletions: collected.deletions,
      truncated: clipped.truncated,
    },
  });
  publishRowEvent(runId, rowId, {
    type: 'diff-summary',
    filesChanged: collected.filesChanged,
    insertions: collected.insertions,
    deletions: collected.deletions,
    truncated: clipped.truncated,
  });
  if (clipped.truncated) {
    // 被裁掉的文件必须留痕：否则「看不到的改动」会被评分模型当成「没改」（§5.5 第 7 步）
    const shown = clipped.droppedFiles.slice(0, 20).join('、');
    const more = clipped.droppedFiles.length > 20 ? ` 等 ${clipped.droppedFiles.length} 个文件` : '';
    publishRowEvent(runId, rowId, {
      type: 'log',
      stream: 'stderr',
      text: `[编排] diff 超过上限 ${settings.diffBudgetBytes} 字节，已按文件裁剪；未送入评分模型的文件：${shown}${more}`,
    });
  }

  // 终止类结果优先判定（用户终止 > 外层兜底超时 > 适配器自报）
  const stop = classifyStop({ userAborted: userAborted.has(key), timedOut: timedOutRows.has(key), result });
  if (stop !== null) {
    settleStopped(runId, rowId, stop);
    return;
  }
  if (agentError !== null) throw agentError; // 排在终止判定之后：终止/超时的语义优先于「适配器抛了什么」

  // 第 7 步：评分（§5.7）
  const { row: beforeJudging } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(beforeJudging.status)) {
    log.debug('行已被同步终止，跳过评分', { runId, rowId, status: beforeJudging.status });
    return;
  }
  setRowStatus(runId, rowId, 'judging');
  const route = resolveJudgeRoute({
    judgeProviderId: testCase.judgeProviderId,
    judgeModelId: testCase.judgeModelId,
  });
  const score = await judgeRow({
    judgePrompt: testCase.judgePrompt,
    diffText: clipped.text,
    taskPrompt: testCase.taskPrompt,
    dimensions: DIMENSIONS,
    route,
    // 冗余快照的同一理由（§7.2）：这一分是哪把尺子打的必须留在行上；用例没覆盖时用全局默认
    judgeProviderId: testCase.judgeProviderId ?? settings.defaultJudge?.providerId ?? '',
  });

  const { row: afterJudging } = requireRow(runId, rowId);
  if (TERMINAL_ROW_STATUSES.includes(afterJudging.status)) {
    // 评分是在用户终止之后才返回的：状态保持 canceled（用户意图优先），分数只记进日志
    publishRowEvent(runId, rowId, { type: 'score', score });
    log.warn('行已被终止，评分结果只记入事件日志', { runId, rowId, status: afterJudging.status });
    return;
  }

  // 第 8 步：落盘（分数 → 状态 → end，顺序即事件日志里的顺序）
  patchRow(runId, rowId, { score });
  publishRowEvent(runId, rowId, { type: 'score', score });
  setRowStatus(runId, rowId, 'judged');
  publishRowEvent(runId, rowId, { type: 'end', exitReason: 'completed' });
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— `orchestrator.test.ts` 共 2 个 `describe` / 14 个 `it` 全绿；整个包 4 个测试文件全绿。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/orchestrator.ts
git add packages/server/evaluator/src/orchestrator.test.ts
git add packages/server/evaluator/src/testing/fixtures.ts
git commit -m "feat(evaluator): 单行执行八步时序（真实工作区、diff 裁剪、评分落盘、失败隔离）"
```

---

## Task 6: `orchestrator.ts` —— 轮级状态机（并行 / 串行 / 超时 / 终止）

**Files:**
- Modify: `packages/server/evaluator/src/orchestrator.ts`（替换顶部 import 块 + 追加轮级状态机）
- Modify: `packages/server/evaluator/src/orchestrator.test.ts`（追加轮级用例）

**Interfaces:**
- Consumes（Task 5）：`runRow(runId, rowId): Promise<void>`（已保证永不抛）
- Consumes（p0 contracts，契约 §2.4）：`isRunningRow(status): boolean`、`TERMINAL_ROW_STATUSES`、`ROW_STATUS_LABELS`
- Produces（契约 §5）：`startRun(runId: string): EvalRun`、`abortRun(runId: string): EvalRun`、`abortRow(runId: string, rowId: string): EvalRun`、`drainRunningTasks(): Promise<void>`

- [ ] **Step 1: 写失败测试（追加到 `orchestrator.test.ts` 末尾）**

先把该文件顶部的 import 补齐（新增 `abortRow` / `abortRun` / `drainRunningTasks` / `startRun`，以及 `releaseAgent` / `releaseAllAgents` / `releaseJudge`）：

```ts
import { abortRow, abortRun, drainRunningTasks, runRow, startRun } from './orchestrator';
import {
  createTempHome,
  fakeAgents,
  fakeJudge,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  releaseAgent,
  releaseAllAgents,
  releaseJudge,
  resetFakeAgents,
  resetFakeJudge,
  seedConfig,
  type TempHome,
} from './testing/fixtures';
```

然后追加：

```ts
/** 假适配器记录下来的工作目录列表（顺序即启动顺序） */
function startedCwds(): string[] {
  return fakeAgents.calls.map((call) => call.cwd);
}

/** 某一行的预期工作目录（prepareRowWorkspace 的布局：{root}/{runId}/rows/{rowId}/workspace） */
function expectedWorkspace(runId: string, rowId: string): string {
  return join(home.workspaceRoot, runId, 'rows', rowId, 'workspace');
}

describe('执行模式：并行与串行', () => {
  it('并行：所有行同时启动，没有任何一行等前一行结束', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });

    startRun(run.id);
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(3));

    // 三行都挂在 gate 里、一行都没结束 —— 这是「同时启动」的直接证据（不是「很快相继启动」）
    expect(fakeAgents.concurrent).toBe(3);
    expect(getRun(run.id).rows.every((row) => row.status === 'running')).toBe(true);

    releaseAllAgents();
    await drainRunningTasks();

    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'judged', 'judged']);
    expect(getRun(run.id).status).toBe('done');
    expect(getRun(run.id).finishedAt).not.toBeNull();
  });

  it('串行：同一时刻只有一个 adapter 在跑，且前一行「含评分」结束后才起下一行', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });

    startRun(run.id);
    // startRun 的同步前缀只把第一行推到 preparing；agent 在让出事件循环后才起
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(1));
    expect(fakeAgents.maxConcurrent).toBe(1);
    expect(getRun(run.id).rows.filter((row) => row.status === 'pending')).toHaveLength(2);

    releaseAgent(startedCwds()[0] ?? '');
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(2));
    // 起第二行时，第一行必须已经 judged：串行的定义是「一行跑完**含评分**才起下一行」（§5.2）
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    expect(fakeAgents.maxConcurrent).toBe(1);

    releaseAgent(startedCwds()[1] ?? '');
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(3));
    releaseAgent(startedCwds()[2] ?? '');
    await drainRunningTasks();

    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'judged', 'judged']);
    expect(getRun(run.id).status).toBe('done');
    expect(fakeAgents.maxConcurrent).toBe(1);
  });

  it('串行下每行都有**独立**工作目录（防回归到「共用目录」这个致命错误，F6）', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });

    startRun(run.id);
    await drainRunningTasks();

    const rows = getRun(run.id).rows;
    const dirs = rows.map((row) => row.workspacePath);
    const cwds = startedCwds();

    // 断言用「具体列表」而不是「不相等」这种模糊判断：失败时要能一眼看出撞到了哪个目录
    expect(new Set(dirs).size).toBe(3);
    expect(new Set(cwds).size).toBe(3);
    expect([...cwds].sort()).toEqual([...dirs].sort());
    for (const row of rows) {
      expect(row.workspacePath).toBe(expectedWorkspace(run.id, row.id));
      expect(existsSync(join(row.workspacePath, '.git'))).toBe(true);
    }
    // 分支名也必须各不相同（同一用例下多候选共用分支名会互相踩，§5.5）
    expect(new Set(rows.map((row) => row.branch)).size).toBe(3);
  });

  it('「开始」只跑未完成的行：已 judged 的行不重跑', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    startRun(run.id);
    await drainRunningTasks();
    const afterFirstRound = fakeAgents.calls.length;
    expect(afterFirstRound).toBe(3);

    // 模拟「上一次跑完但有中间一行失败」：把第二行改回 failed 再开始
    const snapshot = getRun(run.id);
    const second = snapshot.rows[1];
    if (second === undefined) throw new Error('夹具应该有三行');
    second.status = 'failed';
    second.score = null;
    second.error = { code: 'AGENT_FAILED', message: '模拟上一次失败' };
    saveRun(snapshot);

    startRun(run.id);
    await drainRunningTasks();

    expect(fakeAgents.calls.length).toBe(afterFirstRound + 1); // 只补跑了失败的那一行
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'judged', 'judged']);
    expect(getRun(run.id).rows[1]?.error).toBeNull(); // 重跑成功要清掉上一次的错误
  });
});

describe('终止语义（§5.4 的表）', () => {
  it('终止（串行）：正在跑的行 canceled，还没轮到的行 skipped，两者可区分', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(1));

    const aborted = abortRun(run.id);
    // 状态是**同步**落库的：调用返回时界面要看到的状态就已经在快照里了
    expect(aborted.rows.map((row) => row.status)).toEqual(['canceled', 'skipped', 'skipped']);

    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['canceled', 'skipped', 'skipped']);
    expect(saved.status).toBe('partial');
    expect(fakeAgents.calls).toHaveLength(1); // 后两行压根没有起过
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, saved.rows[0]?.id ?? ''));
    expect(events.some((event) => event.type === 'end' && event.exitReason === 'canceled')).toBe(true);
  });

  it('终止（并行）：正在跑的每一行都是 canceled，没有 skipped', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(3));

    abortRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['canceled', 'canceled', 'canceled']);
    expect(saved.rows.some((row) => row.status === 'skipped')).toBe(false);
  });

  it('单行终止：跑着的行 → canceled；排队中的行 → skipped 且之后不会被启动', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(1));

    const rows = getRun(run.id).rows;
    const queued = rows[1];
    if (queued === undefined) throw new Error('夹具应该有三行');
    abortRow(run.id, queued.id);
    expect(getRun(run.id).rows[1]?.status).toBe('skipped');

    releaseAgent(startedCwds()[0] ?? '');
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(2));
    // 第二次起来的必须是第三行：第二行已经 skipped，不该再有开始的机会
    expect(startedCwds()[1]).toBe(expectedWorkspace(run.id, rows[2]?.id ?? ''));

    releaseAgent(startedCwds()[1] ?? '');
    await drainRunningTasks();
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'skipped', 'judged']);
  });

  it('对已结束的行调用 abortRow → CONFLICT（不是静默成功）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    startRun(run.id);
    await drainRunningTasks();
    const rowId = getRun(run.id).rows[0]?.id ?? '';
    expect(getRun(run.id).rows[0]?.status).toBe('judged');

    expect(() => abortRow(run.id, rowId)).toThrow(/已结束/);
  });

  it('没有在跑的行时 abortRun → CONFLICT', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    expect(() => abortRun(run.id)).toThrow(/没有正在运行的候选行/);

    startRun(run.id);
    await drainRunningTasks();
    expect(() => abortRun(run.id)).toThrow(/没有正在运行的候选行/);
  });

  it('终止优先于评分结果：评分在终止之后才返回时，行保持 canceled，分数只进日志', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'gate';

    startRun(run.id);
    await vi.waitFor(() => expect(fakeJudge.calls).toHaveLength(1)); // 已进入评分阶段
    expect(getRun(run.id).rows[0]?.status).toBe('judging');

    abortRun(run.id);
    expect(getRun(run.id).rows[0]?.status).toBe('canceled');

    releaseJudge();
    await drainRunningTasks();

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('canceled'); // 没有被改回 judged
    expect(row?.score).toBeNull(); // 快照里不写分数
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(events.some((event) => event.type === 'score')).toBe(true); // 但证据留在日志里
  });
});

describe('超时与失败隔离', () => {
  it('适配器按内层 timeoutMs 停止 → 该行 timed-out，另一行照常出分（失败隔离）', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 2, executionMode: 'parallel', rowTimeoutMs: 80 });
    // Task 11 实测：dsh 讲 Anthropic Messages（契约 R37）⇒ dsh 行必须配一个 **anthropic** 供应商。
    // seedRunnableRun 只种了默认的 openai 供应商，直接改 agentKind 会在执行前被协议校验拦成 failed
    // （`providerRecord.protocolType !== agentProvider.metadata.protocolType`），测不到内层超时那条路径。
    const anthropic = makeProviderFixture({ protocolType: 'anthropic', baseUrl: 'https://fake.invalid/anthropic' });
    saveConfig({ ...loadConfig(), providers: [provider, anthropic] });
    const rows = run.rows;
    // 第一行用 dsh（脚本让它按内层超时停止），第二行 codex 正常完成
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error('夹具应该有两行');
    const patched = {
      ...run,
      rows: [
        { ...first, agentKind: 'dsh' as const, providerId: anthropic.id, providerName: anthropic.name, baseUrl: anthropic.baseUrl },
        second,
      ],
    };
    saveRun(patched);
    fakeAgents.scripts.set('dsh', { honorTimeout: true });
    fakeAgents.scripts.set('codex', { files: [{ path: 'ok.txt', content: 'ok\n' }] });

    startRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows[0]?.status).toBe('timed-out');
    expect(saved.rows[0]?.error?.code).toBe('AGENT_TIMED_OUT');
    expect(saved.rows[1]?.status).toBe('judged');
    expect(saved.status).toBe('partial');
  });

  it('适配器彻底不响应（hang）时外层兜底把该行收成 timed-out，不让整轮挂死', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', rowTimeoutMs: 50 });
    fakeAgents.scripts.set('codex', { mode: 'hang' });

    startRun(run.id);
    await drainRunningTasks();

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('timed-out');
    expect(row?.error?.code).toBe('AGENT_TIMED_OUT');
    expect(getRun(run.id).status).toBe('partial');
    // 外层兜底 = rowTimeoutMs + max(1s, 10%)，硬停再 +2s：这条用例约 3 秒，属预期
  }, 20_000);

  it('失败隔离：串行下中间一行失败，前后两行照常跑完', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    // 中间那行要换成 dsh ⇒ 它得配 anthropic 供应商（Task 11 实测 dsh 讲 Anthropic Messages，契约 R37）；
    // 否则这一行会在执行前被协议校验拦成 CONFLICT，测到的就不是「适配器失败」这条路径了
    const anthropic = makeProviderFixture({ protocolType: 'anthropic', baseUrl: 'https://fake.invalid/anthropic' });
    saveConfig({ ...loadConfig(), providers: [provider, anthropic] });
    const rows = run.rows;
    const first = rows[0];
    const second = rows[1];
    const third = rows[2];
    if (first === undefined || second === undefined || third === undefined) throw new Error('夹具应该有三行');
    saveRun({
      ...run,
      rows: [
        first,
        { ...second, agentKind: 'dsh' as const, providerId: anthropic.id, providerName: anthropic.name, baseUrl: anthropic.baseUrl },
        third,
      ],
    });
    fakeAgents.scripts.set('dsh', { mode: 'error' });

    startRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['judged', 'failed', 'judged']);
    expect(saved.rows[1]?.error?.code).toBe('AGENT_FAILED');
    expect(saved.status).toBe('partial');
  });

  it('startRun 的三条拒绝路径：已有行在跑 / 没有可执行行 / 用例已删除', async () => {
    // ① 已有行在跑
    const running = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(running.run.id);
    await vi.waitFor(() => expect(startedCwds()).toHaveLength(1));
    expect(() => startRun(running.run.id)).toThrow(/已有候选行在运行/);
    releaseAllAgents();
    await drainRunningTasks();

    // ② 没有可执行的行（全部已 judged）
    expect(() => startRun(running.run.id)).toThrow(/没有可执行/);

    // ③ 用例已删除
    const orphan = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    saveConfig({ ...loadConfig(), cases: [] });
    expect(() => startRun(orphan.run.id)).toThrow(/用例已删除/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `orchestrator.ts` 没有导出 `startRun` / `abortRun` / `abortRow` / `drainRunningTasks`。

- [ ] **Step 3: 写实现（替换 `orchestrator.ts` 顶部 import 块 + 追加轮级状态机）**

替换后的 import 块（相比 Task 5 多了 `ROW_STATUS_LABELS`、`isRunningRow`）：

```ts
import {
  AGENT_LABELS,
  DIMENSIONS,
  PROTOCOL_LABELS,
  ROW_STATUS_LABELS,
  ServiceError,
  TERMINAL_ROW_STATUSES,
  isRunnableRow,
  isRunningRow,
  type AgentEvent,
  type EvalRow,
  type EvalRowStatus,
  type EvalRun,
} from '@aieval/contracts';
import {
  caseCacheDir,
  collectDiff,
  createLogger,
  ensureCaseCache,
  loadConfig,
  prepareRowWorkspace,
  resetEvents,
  rowEventsFile,
  truncateDiff,
} from '@aieval/core';
import { getProvider, type AgentRunResult } from '@aieval/agents';
import { publishRowEvent } from './events';
import { judgeRow } from './judge';
import { resolveJudgeRoute } from './judge-route';
import { getRun, saveRun } from './run-store';
```

追加到文件末尾：

```ts
/** 在途的**轮级**任务：`drainRunningTasks` 等它们，`startRun` 用它判「是不是已经在跑」 */
const runTasks = new Map<string, Promise<void>>();

/**
 * 开始执行一轮评测：只跑可执行的行（`isRunnableRow`：pending / failed / timed-out / canceled /
 * interrupted / skipped），已有行在跑则拒绝（契约 §5）。
 * 为什么立即返回快照、不等跑完：一轮评测是分钟级的，HTTP 请求不能挂在那儿；进度由事件日志 +
 * 快照驱动（F14），界面靠 SSE 追。
 * 执行模式（F9）在这里被读取一次就固定下来：本模块**不提供**改模式的入口，运行中也就无从修改。
 */
export function startRun(runId: string): EvalRun {
  const run = getRun(runId);
  if (runTasks.has(runId) || run.rows.some((row) => isRunningRow(row.status))) {
    throw new ServiceError('CONFLICT', `该评测已有候选行在运行（${runId}），请先等它结束或终止`);
  }
  const config = loadConfig();
  if (!config.cases.some((item) => item.id === run.caseId)) {
    // 题面与评分提示词没有快照进 run.json（§7.2 只冗余了 caseTitle / repoPath / commitHash），
    // 所以用例被删掉之后这轮可以看、不能跑——必须在启动前拦下，而不是等每行各自失败
    throw new ServiceError('CONFLICT', `用例已删除（${run.caseId}），无法执行该评测；历史记录仍可查看`);
  }
  if (!run.rows.some((row) => isRunnableRow(row.status))) {
    throw new ServiceError('CONFLICT', '没有可执行的候选行');
  }

  saveRun({ ...run, status: 'running', startedAt: new Date().toISOString(), finishedAt: null });
  log.info('评测开始', { runId, mode: run.executionMode, rows: run.rows.length });

  const task = executeRun(runId)
    .catch((error: unknown) => {
      // 行级已兜底（runRow 永不抛），走到这里说明是编排自身的 bug：记下来，但轮不能卡在 running
      log.error('轮级任务异常退出（行级已兜底，不应发生）', { runId, reason: toServiceError(error).message });
    })
    .finally(() => {
      finalizeRun(runId);
      runTasks.delete(runId);
    });
  runTasks.set(runId, task);

  // 重新读一次快照再返回：p5 的 POST /start 拿到的必须是「已经在跑」的状态
  return getRun(runId);
}

/**
 * 轮级执行：并行 = 所有目标行同时启动（不设并发上限，F12）；串行 = 一行跑完**含评分**才起下一行（§5.2）。
 * 两种模式**都**为每行建独立工作区（F6）——串行省的是 CPU 与供应商配额，不是工作区；
 * 串行共用一个目录会让第二个 agent 在第一个的改动上继续写，分数无意义、整轮作废。
 */
async function executeRun(runId: string): Promise<void> {
  const run = getRun(runId);
  const targets = run.rows.filter((row) => isRunnableRow(row.status)).map((row) => row.id);

  if (run.executionMode === 'parallel') {
    // runRow 保证永不抛，故 Promise.all 不会因为某一行失败而提前结束其它行
    await Promise.all(targets.map((rowId) => runRow(runId, rowId)));
    return;
  }

  for (const rowId of targets) {
    // 每行开跑前重读快照：轮级终止会把还没轮到的行同步落成 skipped，这里必须尊重它
    const current = getRun(runId).rows.find((row) => row.id === rowId);
    if (current === undefined || !isRunnableRow(current.status)) continue;
    await runRow(runId, rowId);
  }
}

/**
 * 轮收尾：所有行都到终态后，全部 `judged` → `done`，否则 `partial`。
 * spec 只给了 `idle | running | partial | done` 四个取值、没定义后两者，这里定死口径（列表页靠它显示状态）：
 * **done = 每一行都出了分；partial = 跑完了但有行没出分**（失败 / 超时 / 终止 / 跳过 / 中断）。
 * 还有行在跑就什么都不做——「轮结束」不能抢在「行结束」前面。
 */
function finalizeRun(runId: string): void {
  const run = getRun(runId);
  if (run.rows.some((row) => isRunningRow(row.status))) return;
  const status: EvalRun['status'] = run.rows.length > 0 && run.rows.every((row) => row.status === 'judged') ? 'done' : 'partial';
  if (run.status === status && run.finishedAt !== null) return; // 已收尾：不重复写时间戳
  saveRun({ ...run, status, finishedAt: new Date().toISOString() });
  log.info('评测执行结束', { runId, status, rows: run.rows.length });
}

/**
 * 终止整轮：**正在跑的行 → canceled，还没轮到的行 → skipped**（§5.4 的表，两者不可合并：
 * 「用户杀了它」与「它压根没跑」在事后复盘时是两件事）。
 * 为什么状态同步落库、不等待进程真正退出：终止是用户的即时动作，若等到子进程死掉再改状态，
 * 界面会在十几秒里一直显示「运行中」——使用者只会认为按钮坏了，然后再点几次。
 * 在途任务稍后回来时会看到终态并跳过（终态优先），进程收尾由适配器按 §5.6.5 的顺序完成。
 */
export function abortRun(runId: string): EvalRun {
  const run = getRun(runId);
  const running = run.rows.filter((row) => isRunningRow(row.status));
  if (running.length === 0 && !runTasks.has(runId)) {
    throw new ServiceError('CONFLICT', `该评测没有正在运行的候选行（${runId}）`);
  }

  for (const row of running) {
    const key = rowKey(runId, row.id);
    userAborted.add(key);
    rowAborts.get(key)?.abort();
    setRowStatus(runId, row.id, 'canceled');
    publishRowEvent(runId, row.id, { type: 'end', exitReason: 'canceled' });
  }
  // 还没轮到的行（串行排队中；并行下理论上不存在，真有也按同一口径处理）：
  // 它们从此不会再有开始的机会，语义是 skipped 而不是 canceled
  for (const row of getRun(runId).rows) {
    if (row.status !== 'pending') continue;
    setRowStatus(runId, row.id, 'skipped');
    publishRowEvent(runId, row.id, { type: 'end', exitReason: 'skipped' });
  }

  log.info('评测已终止', { runId, canceled: running.length });
  return getRun(runId);
}

/**
 * 终止单行：正在跑的行 → `canceled`；排队中的行 → `skipped`（它还没开始过，与轮级终止同一口径）；
 * 已经结束的行 → CONFLICT（界面不该给它按钮，真调到了要明确报出来，而不是静默成功）。
 */
export function abortRow(runId: string, rowId: string): EvalRun {
  const { row } = requireRow(runId, rowId);

  if (isRunningRow(row.status)) {
    const key = rowKey(runId, rowId);
    userAborted.add(key);
    rowAborts.get(key)?.abort();
    setRowStatus(runId, rowId, 'canceled');
    publishRowEvent(runId, rowId, { type: 'end', exitReason: 'canceled' });
    log.info('候选行已终止', { runId, rowId });
    return getRun(runId);
  }

  if (row.status === 'pending') {
    setRowStatus(runId, rowId, 'skipped');
    publishRowEvent(runId, rowId, { type: 'end', exitReason: 'skipped' });
    log.info('排队中的候选行已跳过', { runId, rowId });
    return getRun(runId);
  }

  throw new ServiceError('CONFLICT', `候选行已结束（${ROW_STATUS_LABELS[row.status]}），无法终止`);
}

/**
 * 等在途的轮级任务结束（测试与进程关停用）。
 * 用 while 而不是一次性 `allSettled`：等待期间可能又有新的轮开始，一次等干净更符合「关停」的语义。
 */
export async function drainRunningTasks(): Promise<void> {
  while (runTasks.size > 0) {
    await Promise.allSettled([...runTasks.values()]);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— `orchestrator.test.ts` 共 5 个 `describe` / 28 个 `it` 全绿（含约 3 秒的 hang 用例）。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过。

- [ ] **Step 5: 变异验证（守卫：串行下每行工作目录互不相同）**

```powershell
git hash-object packages/server/evaluator/src/orchestrator.ts
```

把 **实现**（不是测试）改成「串行共用工作目录」——`runRowAttempt` 里那一处 `rowId,` 改成 `rowId: runId,`：

```ts
  const prepared = prepareRowWorkspace({
    workspaceRoot: run.workspaceBase,
    caseId: run.caseId,
    repoPath: run.repoPath,
    runId,
    rowId: runId, // 变异体：所有行共用 {runDir}/rows/{runId}/workspace
    commitHash: run.commitHash,
    branch,
  });
```

Run: `pnpm --filter @aieval/evaluator test`
Expected: **FAIL**，且失败来自本任务的守卫，形如：

```
 FAIL  src/orchestrator.test.ts > 执行模式：并行与串行 > 串行下每行都有**独立**工作目录（防回归到「共用目录」这个致命错误，F6）
AssertionError: expected 1 to be 3
```

（同时 `expect([...cwds].sort()).toEqual([...dirs].sort())` 与 `.git` 存在性断言也会失败。若只有「状态」类断言失败、而目录断言没失败，说明守卫的断言写虚了，必须改到能拦住变异体为止。）

还原那一行（`rowId: runId,` → `rowId,`），然后核对哈希：

```powershell
git hash-object packages/server/evaluator/src/orchestrator.ts
```

Expected: 与变异前的哈希**逐字相同**。

- [ ] **Step 6: 提交**

```bash
git add packages/server/evaluator/src/orchestrator.ts
git add packages/server/evaluator/src/orchestrator.test.ts
git commit -m "feat(evaluator): 轮级状态机（并行/串行、终止语义、内外两层超时、失败隔离）"
```

---

## Task 7: `recoverInterruptedRuns` + `instrumentation.ts` 启动钩子

**Files:**
- Modify: `packages/server/evaluator/src/orchestrator.ts`（替换 import 块 + 追加恢复）
- Modify: `packages/server/evaluator/src/orchestrator.test.ts`（追加恢复用例）
- Modify: `packages/server/api/src/index.ts`（追加一行转出）
- Create: `apps/web-next/instrumentation.ts`
- Modify: `apps/web-next/tsconfig.json`（`include` 补 `instrumentation.ts`）
- Create: `apps/web-next/src/instrumentation.test.ts`

**Interfaces:**
- Consumes（Task 1 / Task 2）：`listRuns(): EvalRun[]`、`saveRun(run): void`、`publishRowEvent(runId, rowId, event): void`
- Produces（契约 §5）：`recoverInterruptedRuns(): { recovered: number }`
- Produces（经 `@aieval/api` 转出）：`@aieval/api` 的 `recoverInterruptedRuns`

**为什么钩子必须经 `@aieval/api` 转出，而不是直连 `@aieval/evaluator`：** `AGENT.md` 的依赖方向表里 `web-next → api / core / ui / client / contracts`，`evaluator` 不在其中；而且 `apps/web-next/package.json` 的 `dependencies` 里**没有** `@aieval/evaluator`（只有 api / client / contracts / core / ui），pnpm 的严格 `node_modules` 下直连会解析失败（`apps/web-next/node_modules/@aieval/` 里确实没有 evaluator 这个符号链接）。`api → evaluator` 是允许的方向，且 api 已经在依赖里，所以转出一次是唯一不需要新增依赖、也不违反依赖方向的做法。**不要在 web-next 的 package.json 里加 evaluator 依赖来绕过这一点。**

- [ ] **Step 1: 写失败测试（追加到 `orchestrator.test.ts`）**

先把顶部 import 补上四个名字（`writeFileSync` 用于把快照写坏，`runSnapshotFile` 用于定位快照，另两个是新增的编排出口与夹具）：

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readEvents, rowEventsFile, runSnapshotFile } from '@aieval/core';
import { abortRow, abortRun, drainRunningTasks, recoverInterruptedRuns, runRow, startRun } from './orchestrator';
import {
  createTempHome,
  fakeAgents,
  fakeJudge,
  initFixtureRepo,
  makeCaseFixture,
  makeProviderFixture,
  makeRowFixture,
  makeRunFixture,
  makeScoreFixture,
  releaseAgent,
  releaseAllAgents,
  releaseJudge,
  resetFakeAgents,
  resetFakeJudge,
  seedConfig,
  type TempHome,
} from './testing/fixtures';
```

（`loadConfig` / `saveConfig` / `getRun` / `saveRun` / `join` / `randomUUID` / `vi` 等 Task 5 已经 import 过的名字保持原样，不要重复 import。）

然后追加：

```ts
describe('recoverInterruptedRuns（F10：重启不自动续跑）', () => {
  it('只把 preparing / running / judging 的行标 interrupted，一个终态行都不动', () => {
    const rows = [
      makeRowFixture({ status: 'judged', score: makeScoreFixture(5) }),
      makeRowFixture({ status: 'failed', error: { code: 'AGENT_FAILED', message: '上次失败的原因' } }),
      makeRowFixture({ status: 'running' }),
      makeRowFixture({ status: 'preparing' }),
      makeRowFixture({ status: 'judging' }),
      makeRowFixture({ status: 'canceled' }),
      makeRowFixture({ status: 'timed-out', error: { code: 'AGENT_TIMED_OUT', message: '上次超时' } }),
      makeRowFixture({ status: 'skipped' }),
      makeRowFixture({ status: 'interrupted' }),
      makeRowFixture({ status: 'pending' }),
    ];
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows, status: 'running' });
    saveRun(run);

    const result = recoverInterruptedRuns();

    expect(result.recovered).toBe(3); // 单位是**行数**
    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual([
      'judged', // 终态行原样
      'failed',
      'interrupted',
      'interrupted',
      'interrupted',
      'canceled',
      'timed-out',
      'skipped',
      'interrupted', // 本来就是 interrupted 的行不算「本次恢复」，也不被改写
      'pending', // 从未开跑的行不碰
    ]);
    // 终态行的证据必须原样保留（这正是「不误伤」的判据：分数与错误原因都还在）
    expect(saved.rows[0]?.score?.totalScore).toBe(100);
    expect(saved.rows[1]?.error?.message).toBe('上次失败的原因');
    expect(saved.rows[6]?.error?.message).toBe('上次超时');
    // 轮不再「运行中」：否则界面会一直转圈而没有任何行在跑
    expect(saved.status).toBe('partial');
    expect(saved.finishedAt).not.toBeNull();
  });

  it('被恢复的行在事件日志里留下一句解释（日志抽屉停在半路时，看的人要知道是服务没了）', () => {
    const row = makeRowFixture({ status: 'running' });
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row], status: 'running' });
    saveRun(run);

    recoverInterruptedRuns();

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, row.id));
    const logText = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('服务重启');
    expect(events.some((event) => event.type === 'status' && event.status === 'interrupted')).toBe(true);
  });

  it('一条坏快照不会挡住其它轮次的恢复（跳过 + WARN，不是整轮启动失败）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [makeRowFixture({ status: 'running' })], status: 'running' });
    const broken = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [makeRowFixture({ status: 'running' })], status: 'running' });
    saveRun(good);
    saveRun(broken);
    writeFileSync(runSnapshotFile(home.workspaceRoot, broken.id), '{ 半截', 'utf8');

    expect(recoverInterruptedRuns().recovered).toBe(1);
    expect(getRun(good.id).rows[0]?.status).toBe('interrupted');
    expect(warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— `orchestrator.ts` 没有导出 `recoverInterruptedRuns`。

- [ ] **Step 3: 写实现（`orchestrator.ts` 的 import 块补 `listRuns` + 追加恢复函数）**

import 那一行改成（其余不变）：

```ts
import { getRun, listRuns, saveRun } from './run-store';
```

文件末尾追加：

```ts
/**
 * 服务重启恢复：把仍处 `preparing` / `running` / `judging` 的行标 `interrupted`（F10，**不自动续跑**：
 * agent 子进程已随服务消失，续跑需要独立进程托管，成本远超收益）。
 *
 * 只动这三种状态——终态行（judged / failed / timed-out / canceled / skipped / interrupted）一律不碰：
 * 把「上次失败」改写成「被中断」会抹掉失败原因，使用者就再也看不到那一行到底为什么没出分。
 *
 * 顺带把该轮收成 `partial` 并补 `finishedAt`（spec §7.4 只说了改行状态）：否则界面会一直显示
 * 「运行中」，而实际上没有任何行在跑，使用者只能干等。
 *
 * 调用点**唯一**：`apps/web-next/instrumentation.ts` 的 `register()`（Next 的服务启动钩子）。
 * 返回值的 `recovered` 是**被改写为 interrupted 的行数**（不是轮数）——启动日志按它报数。
 */
export function recoverInterruptedRuns(): { recovered: number } {
  let recovered = 0;
  let touchedRuns = 0;

  for (const run of listRuns()) {
    const interrupted = run.rows.filter((row) => isRunningRow(row.status));
    if (interrupted.length === 0) continue;

    for (const row of interrupted) {
      try {
        // 事件日志里要留一句：日志抽屉停在半路时，看的人必须能区分「模型没说话」与「服务没了」
        publishRowEvent(run.id, row.id, {
          type: 'log',
          stream: 'stderr',
          text: '服务重启：该行执行已中断（agent 子进程随服务退出，不自动续跑）；点「开始」可重跑该行。',
        });
        publishRowEvent(run.id, row.id, { type: 'status', status: 'interrupted' });
      } catch (error) {
        // 写不进事件（磁盘满 / 目录被占）不影响恢复本身：状态在 run.json 里，界面照样能看到「已中断」
        log.warn('恢复时写入行事件失败（继续恢复其它行）', {
          runId: run.id,
          rowId: row.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      row.status = 'interrupted';
      recovered += 1;
    }

    saveRun({
      ...run,
      status: 'partial',
      finishedAt: run.finishedAt ?? new Date().toISOString(),
    });
    touchedRuns += 1;
  }

  if (recovered > 0) log.warn('服务重启：已把中断的行标记为 interrupted', { rows: recovered, runs: touchedRuns });
  return { recovered };
}
```

（`reason` 这个局部函数只在 `run-store.ts` 里有；本文件里改成内联的
`error instanceof Error ? error.message : String(error)`，避免同名函数在两处漂移。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— `orchestrator.test.ts` 共 6 个 `describe` / 31 个 `it` 全绿。

Run: `pnpm --filter @aieval/evaluator typecheck`
Expected: 通过。

- [ ] **Step 5: 变异验证（守卫：重启恢复不误伤终态行）**

```powershell
git hash-object packages/server/evaluator/src/orchestrator.ts
```

把 **实现**（不是测试）改成「除了已出分的行，其余一律当被中断」：

```ts
    // 变异体：把「只认在途状态」放宽成「除 judged 外全都改写」
    const interrupted = run.rows.filter((row) => row.status !== 'judged');
```

Run: `pnpm --filter @aieval/evaluator test`
Expected: **FAIL**，且失败来自本任务的守卫，形如：

```
 FAIL  src/orchestrator.test.ts > recoverInterruptedRuns（F10：重启不自动续跑） > 只把 preparing / running / judging 的行标 interrupted，一个终态行都不动
AssertionError: expected [ 'judged', 'interrupted', …(8) ] to deeply equal [ 'judged', 'failed', …(8) ]
```

（`expect(saved.rows[1]?.error?.message).toBe('上次失败的原因')` 也会失败——失败原因被抹掉了。）

还原那一行，然后核对哈希：

```powershell
git hash-object packages/server/evaluator/src/orchestrator.ts
```

Expected: 与变异前的哈希**逐字相同**。

- [ ] **Step 6: 提交 evaluator 侧（先提交，钩子单独一个提交）**

```bash
git add packages/server/evaluator/src/orchestrator.ts
git add packages/server/evaluator/src/orchestrator.test.ts
git commit -m "feat(evaluator): 服务重启恢复（只改在途行、不碰终态行、顺带收尾轮状态）"
```

- [ ] **Step 7: 在 `api` 里转出 `recoverInterruptedRuns`**

`packages/server/api/src/index.ts` 的**完整内容**（在 p1/p5 已经追加过的导出行之后再加最后一行；若届时该文件内容与下面不同，保留其它行、只追加最后那一行与它的注释）：

```ts
/** api 公共出口：业务服务层，框架层只从这里 import。 */
export { getSettings, updateSettings } from './settings';
// 重启恢复的调用点在 web-next 的启动钩子里，而依赖方向表里 web-next 只到 api / core / ui / client / contracts
// （AGENT.md），evaluator 不在其中，也没出现在 apps/web-next/package.json 的依赖里——pnpm 的严格
// node_modules 下直连会解析失败。api → evaluator 是允许的方向，故在这里转出一次。
export { recoverInterruptedRuns } from '@aieval/evaluator';
```

- [ ] **Step 8: 写 `apps/web-next/instrumentation.ts`**

先按 `AGENT.md` 的硬约束核对本机 Next 版本的写法——本仓库已装 Next 16.2.7，其自带文档在
`apps/web-next/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md`，其中明确：

- 文件名必须是 `instrumentation.js|ts`，位置在**应用根**或 `src/` 下（**不能放进 `app/`**）；
- 导出的 `register` 函数在「一个新的 Next 服务器实例启动时被调用一次」，且**必须完成后服务器才开始处理请求**，可以是 async；
- `register` 会在 **node 与 edge 两种运行时**都被调用，用 `process.env.NEXT_RUNTIME` 区分；
- 文档推荐在 `register` **内部**动态 `import` 副作用模块，而不是在文件顶部静态 import。

（本机 `next/dist/build/utils.js` 的 `getPossibleInstrumentationHookFilenames()` 也印证了查找路径是
`<appRoot>/instrumentation.<ext>` 与 `<appRoot>/src/instrumentation.<ext>` 两处。本应用把 `app/` 放在根目录，
因此钩子放**应用根**：`apps/web-next/instrumentation.ts`。）

```ts
/**
 * Next 服务启动钩子：把上一个进程留下的在途候选行标成 interrupted（F10，不自动续跑）。
 * 位置由 Next 规定：`instrumentation.ts` 放在应用根（或 src/），**不能**放进 app/。
 *
 * 为什么经 `@aieval/api` 转出而不是直连 `@aieval/evaluator`：依赖方向表里 web-next 只到
 * api / core / ui / client / contracts（AGENT.md），evaluator 既不在其中、也不在
 * apps/web-next/package.json 的依赖里（pnpm 的严格 node_modules 下直连解析失败）。
 *
 * 为什么用「排除 edge」而不是「只认 nodejs」：恢复必须**真的发生**。写成 `=== 'nodejs'` 时，
 * 一旦该环境变量在某次运行里没被设置，恢复会静默不执行——那是最难发现的一类故障
 * （界面永远显示上一轮「运行中」）。Next 只有 node 与 edge 两种运行时，排除 edge 即可。
 *
 * 为什么在 register 内部动态 import：文档明确建议把副作用集中在 register 里；
 * 且被排除的 edge 运行时因此完全不会把 fs 相关的模块图拉进边缘包。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const [{ recoverInterruptedRuns }, { createLogger }] = await Promise.all([
    import('@aieval/api'),
    import('@aieval/core'),
  ]);
  const log = createLogger('instrumentation');

  try {
    const { recovered } = recoverInterruptedRuns();
    log.info('服务启动：已完成被中断候选行的恢复', { recovered });
  } catch (error) {
    // 启动钩子不能把服务拖垮：恢复失败只记 ERROR，宁可用「状态不对」也不让整个服务起不来
    log.error('服务启动恢复失败（服务继续启动）', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 9: 把钩子纳入类型检查（`apps/web-next/tsconfig.json`）**

`include` 目前是 `["next-env.d.ts", "app", "src", ".next/types/**/*.ts"]`——应用根下的 `instrumentation.ts`
**不在其中**，`tsc --noEmit` 会漏检它（`pnpm lint` 还会管，但那不是类型检查）。改成：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "allowJs": true,
    "incremental": true,
    "paths": { "@/*": ["./*"] },
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "instrumentation.ts", "app", "src", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 10: 写失败测试 `apps/web-next/src/instrumentation.test.ts`**

```ts
// @vitest-environment node
/**
 * 启动钩子：`register()` 在 node 运行时真的执行恢复（经 @aieval/api 转出到 evaluator），
 * 在 edge 运行时什么都不做。
 * 这里**不 mock 任何模块**：要证的正是「这条 import 链真的通、api 的转出真的写了」——
 * mock 掉就等于把要证的东西假设掉了。
 * 注意测试位置：本应用只能写 `.ts` 测试（tsconfig 的 jsx 是 preserve，`.tsx` 测试跑不起来），
 * 且 vitest 只收 `src/**/*.test.ts`；`@/` 别名指向应用根目录（vitest.config.ts 已配好）。
 * 本文件也不能 import @aieval/evaluator（它不在本应用的依赖里，这正是走 api 转出的原因），
 * 故 run.json 用手写 JSON 造——顺带把「磁盘上的快照形状」也钉了一遍。
 * 为什么 `setConfigDirForTesting` 能影响 `@aieval/api` 内部的 `loadConfig()`：vitest 按**解析后的
 * 绝对路径**去重模块，本文件 import 的 `@aieval/core` 与 evaluator 内部 import 的是同一个文件，
 * 因此是同一个模块实例、共享同一份 override。若哪天不是同一个实例，这个用例会以
 * 「恢复没发生」失败——那正是要暴露的问题。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS, saveConfig, setConfigDirForTesting } from '@aieval/core';
import { register } from '@/instrumentation';

let root: string;
let workspaceRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aieval-instrumentation-'));
  workspaceRoot = join(root, 'runs');
  setConfigDirForTesting(join(root, 'config'));
  saveConfig({ settings: { ...SETTINGS_DEFAULTS, workspaceRoot }, providers: [], cases: [] });
});

afterEach(() => {
  setConfigDirForTesting(null);
  delete process.env.NEXT_RUNTIME;
  rmSync(root, { recursive: true, force: true });
});

/** 手写一份 run.json，返回它的路径（行状态由调用方给） */
function seedRun(rowStatuses: string[]): string {
  const runId = `run-${rowStatuses.join('-')}`;
  const dir = join(workspaceRoot, runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'run.json');
  writeFileSync(
    file,
    JSON.stringify({
      id: runId,
      caseId: 'case-1',
      caseTitle: '用例',
      repoPath: join(root, 'repo'),
      commitHash: null,
      status: 'running',
      executionMode: 'parallel',
      rows: rowStatuses.map((status, index) => ({
        id: `row-${index}`,
        agentKind: 'codex',
        providerId: 'provider-1',
        providerName: '测试供应商',
        baseUrl: 'https://fake.invalid/v1',
        modelId: 'test-model',
        status,
        branch: `test/row-${index}`,
        workspacePath: '',
        // 40 位假 hash：schema 要求非空（真实值在准备阶段才解析出来，见实现层修正第 14 条）
        baselineCommit: 'a'.repeat(40),
        tokens: null,
        turns: null,
        durationMs: null,
        diff: null,
        score: null,
        error: null,
      })),
      workspaceBase: workspaceRoot,
      createdAt: '2026-09-22T10:00:00.000Z',
      startedAt: '2026-09-22T10:00:01.000Z',
      finishedAt: null,
    }),
    'utf8',
  );
  return file;
}

/** 读回快照里的行（本应用不为 run.json 再声明一套类型，故断言成最小形状即可） */
function readRows(file: string): { status: string }[] {
  const payload = JSON.parse(readFileSync(file, 'utf8')) as { rows: { status: string }[] };
  return payload.rows;
}

describe('instrumentation.register', () => {
  it('nodejs 运行时：把在途的行标成 interrupted，终态行原样（经 @aieval/api 转出调用）', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    const file = seedRun(['judged', 'running', 'preparing', 'judging', 'failed']);

    await register();

    expect(readRows(file).map((row) => row.status)).toEqual([
      'judged',
      'interrupted',
      'interrupted',
      'interrupted',
      'failed',
    ]);
  });

  it('NEXT_RUNTIME 未设置时也执行恢复（排除 edge 而不是只认 nodejs：漏跑恢复是静默故障）', async () => {
    delete process.env.NEXT_RUNTIME;
    const file = seedRun(['running']);

    await register();

    expect(readRows(file)[0]?.status).toBe('interrupted');
  });

  it('edge 运行时什么都不做（恢复要读写磁盘，边缘运行时没有文件系统）', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    const file = seedRun(['running']);

    await register();

    expect(readRows(file)[0]?.status).toBe('running');
  });

  it('没有需要恢复的行时不抛（工作区目录都还不存在）', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await expect(register()).resolves.toBeUndefined();
  });

  it('快照损坏也不把服务启动拖垮：register 正常返回', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    const file = seedRun(['running']);
    writeFileSync(file, '{ 半截', 'utf8');

    await expect(register()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 11: 跑测试确认通过**

Run: `pnpm --filter @aieval/web-next test`
Expected: 先 FAIL（`@/instrumentation` 不存在或 api 没有转出）→ 写完 Step 7–9 后 PASS：
`instrumentation.test.ts` 共 5 个 `it` 全绿，且原有的 `route-settings.test.ts` / `server-context.test.ts` 仍全绿。

Run: `pnpm typecheck`
Expected: 全部包通过（含 `apps/web-next` 对 `instrumentation.ts` 的类型检查——这也是 Step 9 的目的）。

- [ ] **Step 12: 确认 Hook 真的被 Next 接上（编译期证据）**

Run: `pnpm --filter @aieval/web-next build`
Expected: 构建成功（`instrumentation.ts` 会被 Next 编进服务端产物；构建失败时会指出是哪一个文件）。
若失败原因与本计划无关（例如某个尚未完成的页面），**原样记录错误输出**再继续，不要删掉本步骤的结论；
运行期证据（启动日志里出现 `[INFO] [instrumentation] 服务启动：已完成被中断候选行的恢复`）属于 p6 的冒烟范围。

- [ ] **Step 13: 提交（api 转出 + 钩子 + 测试 + tsconfig）**

```bash
git add packages/server/api/src/index.ts
git add apps/web-next/instrumentation.ts
git add apps/web-next/tsconfig.json
git add apps/web-next/src/instrumentation.test.ts
git commit -m "feat(web-next): 启动钩子触发中断恢复（经 api 转出，不直连 evaluator）"
```

---

## Task 8: `index.ts` 汇总导出与收尾验收

**Files:**
- Create: `packages/server/evaluator/src/index.test.ts`
- Modify: `packages/server/evaluator/src/index.ts`

**Interfaces:**
- Consumes：Task 1–7 的全部产出
- Produces（契约 §5 的出口面）：`callTextApi`、`resolveJudgeRoute`、`listRuns`、`listRunsForCase`、`getRun`、`saveRun`、`publishRowEvent`、`subscribeRowEvents`、`parseJudgeResponse`、`judgeRow`、`startRun`、`abortRun`、`abortRow`、`recoverInterruptedRuns`、`drainRunningTasks`

- [ ] **Step 1: 写失败测试 `index.test.ts`**

```ts
// @vitest-environment node
/**
 * 导出面守卫：`@aieval/evaluator` 的出口是**跨计划契约**（p5 的 api 层与 web-next 的启动钩子都从这里
 * import），名字一旦漂移，接缝处会在运行时报「不是函数」，而各包自己的单测还是绿的。
 * 断言的是**完整集合**而不是「包含某些名字」：新增出口也要显式改这里。这份摩擦是刻意的——
 * 出口面本来就是需要被看见、被评审的东西。
 * 注意：`Object.keys` 只反映运行期导出，`type` 导出（如 `JudgeInput` / `TextRoute`）不在此列。
 */
import { describe, expect, it } from 'vitest';
import * as evaluator from './index';

describe('@aieval/evaluator 导出面', () => {
  it('恰好导出契约 §5 钉死的这些名字', () => {
    expect(Object.keys(evaluator).sort()).toEqual(
      [
        // p0：文本 API 与评分路由
        'callTextApi',
        'resolveJudgeRoute',
        // 运行快照（Task 1）
        'getRun',
        'listRuns',
        'listRunsForCase',
        'saveRun',
        // 事件总线（Task 2）
        'publishRowEvent',
        'subscribeRowEvents',
        // 评分器（Task 3 / Task 4）
        'judgeRow',
        'parseJudgeResponse',
        // 编排（Task 5 / Task 6 / Task 7）
        'abortRow',
        'abortRun',
        'drainRunningTasks',
        'recoverInterruptedRuns',
        'startRun',
      ].sort(),
    );
  });

  it('编排内部入口 runRow 不从包出口暴露（它是本包测试与状态机内部用的）', () => {
    expect(Object.keys(evaluator)).not.toContain('runRow');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @aieval/evaluator test`
Expected: FAIL —— 断言左侧只有 p0 写进去的两个名字（`callTextApi` / `resolveJudgeRoute`），右侧有 15 个。

- [ ] **Step 3: 写 `index.ts`**

**保留 p0 已写的两行**（它们导出 `text-api` 与 `judge-route`，是 p2 生成评分提示词要用到的），在其后追加本计划的出口：

```ts
/** evaluator 公共出口：文本 API（p0）、评分路由（p0）、运行快照、事件总线、评分器、编排。 */
export { callTextApi, type TextRoute } from './text-api';
export { resolveJudgeRoute } from './judge-route';

// 运行快照：一轮评测的可展示状态都在这里（Task 1）
export { getRun, listRuns, listRunsForCase, saveRun } from './run-store';

// 事件总线：落盘 + 进程内扇出（Task 2）。`PendingRowEvent` 不导出：只有本包的编排层在发事件
export { publishRowEvent, subscribeRowEvents } from './events';

// 评分器：解析（纯函数）与一次评分调用（Task 3 / Task 4）
export { judgeRow, parseJudgeResponse, type JudgeInput } from './judge';

// 编排：轮级状态机与重启恢复（Task 5 / Task 6 / Task 7）。
// `runRow` 刻意不在这里导出：它是本包测试与状态机内部用的行级入口，不属于跨包契约
export { abortRow, abortRun, drainRunningTasks, recoverInterruptedRuns, startRun } from './orchestrator';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS —— `index.test.ts` 2 个 `it` 全绿；整个包 5 个测试文件全绿。

- [ ] **Step 5: 全量验收（顺序固定：typecheck → lint → test）**

Run: `pnpm typecheck`
Expected: 8 个包全部通过。

Run: `pnpm lint`
Expected: 全部通过。常见失败与处置：
- `@stylistic/quotes` / `@stylistic/semi` / `@stylistic/indent`：跑 `pnpm format` 自动修复，**修复产生的变更要随本次改动一起提交**；
- `unused-imports/no-unused-imports`：删掉没用到的 import（Task 5/6 的 import 块是替换式的，容易出现残留）；
- 边界规则报 `[分层边界] evaluator 禁止 import …`：说明引错了包（evaluator 只能 import agents / core / contracts）。

Run: `pnpm --filter @aieval/evaluator test`
Expected: PASS，5 个测试文件全绿（含约 3 秒的 hang 用例）。

Run: `pnpm --filter @aieval/web-next test`
Expected: PASS。

- [ ] **Step 6: 确认三处变异都已还原（防止变异体被留在代码里）**

```powershell
git status --porcelain packages/server/evaluator/src packages/server/api/src apps/web-next
```

Expected: **没有任何输出**（三个变异体都在各自任务里还原并提交了；有输出说明有未提交的改动，
回到对应任务核对哈希）。同时确认关键实现仍是原样：

```powershell
Select-String -Path packages/server/evaluator/src/judge.ts -Pattern 'if \(found === undefined\) throw'
Select-String -Path packages/server/evaluator/src/orchestrator.ts -Pattern 'rowId: runId'
Select-String -Path packages/server/evaluator/src/orchestrator.ts -Pattern "row.status !== 'judged'"
```

Expected: 第一条能匹配到；后两条**匹配不到**（匹配到就是变异体没还原）。

- [ ] **Step 7: 提交**

```bash
git add packages/server/evaluator/src/index.ts
git add packages/server/evaluator/src/index.test.ts
git commit -m "feat(evaluator): 汇总导出与导出面守卫（跨计划契约）"
```

---

## 完成后的交接

本计划的产出是 p5（评测域）与 p6（冒烟）的硬前置。交接时必须说清的三件事：

1. **p5 从 `@aieval/evaluator` 只能 import 这 15 个名字**（`index.test.ts` 已把它们钉住）；行级入口 `runRow` 不对外。
2. **进度只有一条路径**：`run.json` 快照（每次状态变更整体原子覆盖）+ 每行 `events.jsonl`（唯一真相源，seq 从 1 单调递增）。p5 的 SSE 必须**先 `subscribeRowEvents`、再读 `/log` 文件、按 seq 去重**——顺序反了会在两者之间丢事件。
3. **`recoverInterruptedRuns()` 的调用点只有一处**（`apps/web-next/instrumentation.ts` 的 `register()`，经 `@aieval/api` 转出）。p5 不得再挂第二处；p6 的冒烟要包括「重启服务后界面显示行已中断、点开始可重跑这些行」。

