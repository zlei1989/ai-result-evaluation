# evaluator 收集死锁修复（`vi.mock` 工厂重入「正在求值中」的模块）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉 `evaluator/src/testing/fixtures.ts` 对 `@aieval/agents` 的那条**运行时边**，让本包 19 个在**收集阶段**静默挂死的测试文件真正跑起来；并新增一条结构守卫 + 一条绊线，使「工厂动态 import 的闭包里出现运行时边」这一类环**下次先红一次**。

**Architecture:** `vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock())` 这类工厂在**收集阶段**就必须把目标模块求值出来；而 `orchestrator-seams.ts` 静态 import `./fixtures`，`fixtures.ts` 又**运行时** import `@aieval/agents`（它在那条 import 语句里混了一个值成员 `permissiveMessageCapability`）⇒ 构成 vite ModuleRunner **解不开的 await 环**（永不 settle、无报错、无超时、零 CPU）。修法是让那条 import 语句**只剩类型专用成员**（`verbatimModuleSyntax: true` 会整条擦除它），并把夹具里唯一用到的那一格换成与 `permissiveMessageCapability()` **逐字等价**的 17 格字面量。守卫用 TS AST：从每个 `vi.mock(…)` 工厂实参里的 `import('<字面量>')` 出发，沿**运行时相对 import** 走闭包，凡是对「被 mock 的项目模块」（4 项登记表）存在运行时边即红。

**Tech Stack:** TypeScript 5（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `esModuleInterop`）、vitest 4.1.11 + vite 8.3.0（本机实测版本）、`typescript` 编译器 API（`ts.createSourceFile`，已是 `evaluator/package.json:22` 的 devDependency）、PowerShell 下的 `pnpm.cmd`。

**Spec:** `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md` §9.1（本线的过程 spec 已并入该文档并从库中删除）

## Global Constraints

- **范围只在这三处**（spec §3.2）：`packages/server/evaluator/src/testing/fixtures.ts`、`packages/server/evaluator/src/testing/orchestrator-seams.ts`、`packages/server/evaluator/src/static-assertions.test.ts`（外加一份 notes 读数记录，见 Task 1）。**不动任何产品代码、不动包依赖表**（`evaluator/package.json:17` 的 `@aieval/agents: workspace:*` 仍在）、**不动既有用例的判据**（spec §3.5）。
- **一个都不动**（spec §6.4，防扩环）：三条 `vi.mock` 的注册本身、`fakeAgentsModule` 里的 `vi.importActual('@aieval/agents')`（`fixtures.ts:803`）、`orchestrator-harness.ts:40` 对 `../run-store` 的运行时 import、既有用例判据、包依赖表。
- **目标形态**（spec §3.2/§3.3）：`fixtures.ts:34-44` 那条 import **只剩类型专用成员**（本次取「整条 `import type { … }`」形态，与同文件 `:45` 的 `import type { JudgeInput } from '../judge'` 同形）；`:581` 用**逐字等价**的 **17 格**字面量（真源 `agents/src/types.ts:292-311`）。**不要**在夹具里另写一个 `permissiveMessageCapability()` 复制函数（那是第二份真源）。
- **守卫判据集合 = 所有被 mock 的「项目模块」，4 项**：`@aieval/agents` / `./judge` / `./run-store` / `./text-api`；**显式排除 `node:` 内建**（`run-delete.test.ts:32`、`run-store.test.ts:21` mock 了 `node:fs`，而 `fixtures.ts:11` 必须能 import 它）。两半都不许在实现里收窄或放宽（spec §4.2 的 2026-10-06 控制者裁定）。
- **提交逐个显式 `git add <路径>`，禁止 `git add -A`**（本仓有别的会话在并行工作）；`git status` 里不属于本次的文件**保持原样、不要动**。
- **每条新守卫都要做变异验证**：人为把缺陷造回去 ⇒ 确认守卫**红** ⇒ 还原并核对 `Get-FileHash` 与基线一致。**没见过失败的守卫不算守卫**（本仓口径）。
- 代码变更后按序执行：`pnpm.cmd typecheck` → `pnpm.cmd lint` → 相关测试。**本机 `pnpm.ps1` / `npm.ps1` 被执行策略拦** ⇒ 一切命令用 **`pnpm.cmd`**（`pnpm.cmd vitest run <路径>`）。
- ⚠️ **不要跑全量 `pnpm.cmd test` 作为常规验证** —— 这条 spec 修的就是「全量跑不起来」。常规验证一律用文件级 / 包级 `pnpm.cmd vitest run <路径>`；**只有 Task 4 的「全量第一次真正跑起来」允许跑一次**，且**它可能暴露别的既存红：如实登记、不承诺全绿**（spec §5.3）。
- **变异验证期间不要跑 `pnpm.cmd lint`**：变异体会引入未使用的 import（`unused-imports/no-unused-imports` 会红），那不是本次要观测的东西。变异只跑相关测试文件。
- 中断挂死的进程时**只收自己起的那一棵进程树**：用 `Start-Process … -PassThru` 拿到自己的 PID（Task 1 Step 2 的 ① 就是这个写法），到点用 `taskkill /PID <自己那个 pid> /T /F`。**禁止** `taskkill /IM node.exe` —— 那会连带杀掉别的会话在 3083 上跑着的 dev server 与别人正在跑的进程。Windows 上强杀以 `[exit code: 1]`（无信号标记）结算 —— 那是**中断**，不是命令失败。
- 注释与文档一律**中文**；测试文件头 / 用例注释要说明「**为什么**」。
- 本机版本：**vitest 4.1.11 + vite 8.3.0**；spec §2.3 引的 `vite/dist/node/module-runner.js` 行号只对应这份安装，**改了版本别照抄行号**（spec §7）。

## 改动面（文件结构）

| 文件 | 动作 | 职责 |
|---|---|---|
| `packages/server/evaluator/src/testing/fixtures.ts` | Modify `:34-44`、`:579-581` | 去掉对 `@aieval/agents` 的运行时边（import 整条类型化 + `messageCapability` 换 17 格字面量） |
| `packages/server/evaluator/src/static-assertions.test.ts` | Modify `:30-32`（import）、文件末尾 `:467` 之后追加一个 `describe` + 模块级辅助 | 新守卫（闭包运行时边）+ 绊线（登记表与源码同步）+ 样本表（判据的规格） |
| `packages/server/evaluator/src/testing/orchestrator-seams.ts` | Modify `:8-10` | 修那句**与现状不符**的注释，并把「怎么判」与「怎么防」接到新守卫上 |
| `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md` | Create（Task 1）→ 追加（Task 3、Task 4） | 探针读数、判据读数、既存红三分类登记 |

---

### Task 1: 断开那条运行时边（`fixtures.ts`）+ 修前修后读数

**Files:**
- Modify: `packages/server/evaluator/src/testing/fixtures.ts:34-44`（import 改成整条类型专用）
- Modify: `packages/server/evaluator/src/testing/fixtures.ts:579-581`（`messageCapability` 换成 17 格字面量）
- Create: `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`
- Test: `packages/server/evaluator/src/judge.test.ts`（判据 4 对照前提）、`packages/server/evaluator/src/run-delete.test.ts`（探针 1）、`packages/server/evaluator/src/orchestrator-run-row.test.ts`（判据 1）、`packages/server/evaluator/src/judge-agent.test.ts`（判据 2）

**Interfaces:**
- Consumes: 无（本 Task 是链头）。
- Produces:
  - `fixtures.ts` 对 `@aieval/agents` 的 import **整条类型专用**（运行时边消失）。
  - `makeFakeProvider(kind: AgentKind): AgentProvider` 的 `metadata.messageCapability` 是 17 格字面量，逐格等于 `permissiveMessageCapability()`（`agents/src/types.ts:292-311`）。
  - notes 文件 `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`（Task 3 追加「已知边界」、Task 4 追加「修后判据 / 既存红登记」）。

- [ ] **Step 1: 对照前提（spec §5.1 判据 4）——先证明「机器与环境是同一个状态」**

Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/judge.test.ts
```

Expected: **≈3.4s 自行退出**，exit code 0，汇总行 `Test Files  1 passed (1)`、`Tests  27 passed (27)`（`judge.test.ts` 今天确有 27 条 `it(`，已逐条数过）。
**若它也卡**（进程不退出、也不出现任何用例行）⇒ **停止**：机器或环境不是记录里的那个状态，先别拿后面的判据下结论（spec §5.1 判据 4）。

- [ ] **Step 2: 探针 1（spec §5.4）——修前单独跑 `run-delete.test.ts`，登记读数**

**这一步有可能会挂死，所以不许「跑一下看看会不会卡」——按下面五步跑：起进程时先拿到自己的 PID、等满 60s 再判读、到点只收自己那一棵进程树、最后确认无残留。**

```powershell
# ① 起进程并**记住 PID**（这是「自己起的那一条」的唯一凭据；若 Start-Process 报找不到 pnpm.cmd，
#    用 (Get-Command pnpm.cmd).Source 取绝对路径再传 -FilePath）
$probe = Start-Process -FilePath 'pnpm.cmd' `
  -ArgumentList 'vitest','run','packages/server/evaluator/src/run-delete.test.ts' `
  -WorkingDirectory 'D:\Github\ai-result-evaluation' -PassThru `
  -RedirectStandardOutput "$env:TEMP\aieval-probe1.out" -RedirectStandardError "$env:TEMP\aieval-probe1.err"
"probe pid = $($probe.Id)"

# ② 等满 60s（不要提前判死：挂死的判据正是「60s 后仍不退出」）
Start-Sleep -Seconds 60

# ③ 判读：进程还活着吗 + 输出尾部是什么
"exited: " + $probe.HasExited
Get-Content "$env:TEMP\aieval-probe1.out" -Tail 20

# ④ 若仍活着 ⇒ 只收**自己这一棵树**（/T 连子进程一起）；PID 必须是 ① 打印出来的那个
taskkill /PID $probe.Id /T /F

# ⑤ 确认无残留（这一条只是**看**：别人的 node 进程照旧在，一个都不要碰）
Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, StartTime, CPU
```

Expected（两种都合法，**必须如实登记是哪一种**）：
- **正常**：步骤 ③ 是 `exited: True`，输出尾部有汇总行 `Test Files  1 passed (1)`、`Tests  5 passed (5)`（该文件 5 条用例）⇒ 记录「正常」（步骤 ④ 是空操作）；
- **也卡**：步骤 ③ 是 `exited: False`，且输出尾部**只有 `RUN` 头**（`RUN  v4.1.11 …`；被重定向时连它也可能还没刷出来）、**没有任何用例行、没有汇总行** ⇒ 记录「也卡」（执行步骤 ④ 收树）。

⚠️ 步骤 ④ 的 `/PID` **只能**用 ① 打印的 `$probe.Id`；**禁止** `taskkill /IM node.exe` —— 那会连带杀掉别的会话在 3083 上的 dev server 与别人正在跑的进程。步骤 ⑤ 只用于核对，**不要**顺手 `Stop-Process` 别的 PID。

判读规则（spec §5.4，写死，不许临场改）：

| 探针结果 | 怎么判 | 许做什么、不许做什么 |
|---|---|---|
| **也卡** | §1.3 的三条共同点**不是充分条件** | **不许**因此改守卫的判据集合（守卫按 §4.2 的 4 项落地）；把这条观察写进 notes |
| **正常** | 三条共同点仍成立，缺的是「为什么它不在名单里」的解释 | 守卫的判据集合**一个都不动**；把这条解释写进 notes |

读数先记在手边，Step 4 建 notes 文件时一并写入它的「### 探针 1 的判读」那一格。

- [ ] **Step 3: 判据 1（spec §5.1 判据 1）——修前确认它**卡死**（这就是本 Task 的「失败的测试」）**

**与 Step 2 同一套程序（等满 60s ⇒ 判读 ⇒ 只收自己那棵树），换成本文件与新的 PID：**

```powershell
# ① 起进程并记住 PID
$hang1 = Start-Process -FilePath 'pnpm.cmd' `
  -ArgumentList 'vitest','run','packages/server/evaluator/src/orchestrator-run-row.test.ts' `
  -WorkingDirectory 'D:\Github\ai-result-evaluation' -PassThru `
  -RedirectStandardOutput "$env:TEMP\aieval-probe2.out" -RedirectStandardError "$env:TEMP\aieval-probe2.err"
"hang pid = $($hang1.Id)"

# ② 等满 60s
Start-Sleep -Seconds 60

# ③ 判读
"exited: " + $hang1.HasExited
Get-Content "$env:TEMP\aieval-probe2.out" -Tail 20

# ④ 仍活着 ⇒ 只收自己这一棵树
taskkill /PID $hang1.Id /T /F

# ⑤ 确认无残留（只看，不碰别人的进程）
Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, StartTime, CPU
```

Expected（修前）：步骤 ③ 是 `exited: False`，输出里**最多只有 `RUN` 头**（重定向下可能一个字都没刷出来），**没有任何用例行、没有汇总行**。这是**静默挂死**：不是慢、也不是超时 —— 等待发生在任何用例开始之前，`testTimeout: 40_000` / `hookTimeout: 60_000` 都到不了。
**若这一条反而通过（`exited: True` + 汇总行）** ⇒ 本次修复的前提不成立，**停下**：把读数记下来（Step 4 建 notes 时写入）后回报，不要继续往下改。
⚠️ 只终止 `$hang1.Id` 那一棵树；**不要**碰 3083 的 dev server 与别人的 node 进程。

- [ ] **Step 4: 建 notes 文件，写入修前基线**

Create `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`，内容如下（`期望` 列照抄不许改；`实测` / `墙钟` / `退出方式` 三列按 Step 1–3 的真实读数逐格填）：

```markdown
# evaluator 收集死锁修复：探针与判据读数

> 计划：`docs/superpowers/plans/2026-10-06-evaluator-collect-deadlock-fix.md`
> spec：`docs/superpowers/specs/2026-10-06-evaluator-collect-deadlock-fix-design.md`
> 机器：本机（vitest 4.1.11 + vite 8.3.0）。

## 1. 修前基线

| # | 命令 | 期望（spec） | 实测 | 墙钟 | 退出方式 |
|---|---|---|---|---|---|
| 判据 4 | `pnpm.cmd vitest run packages/server/evaluator/src/judge.test.ts` | ≈3.4s / `Test Files 1 passed` / `Tests 27 passed` | | | 自行退出 |
| 探针 1 | `pnpm.cmd vitest run packages/server/evaluator/src/run-delete.test.ts` | 60s 内自行退出（判读规则见 spec §5.4） | | | |
| 判据 1（修前） | `pnpm.cmd vitest run packages/server/evaluator/src/orchestrator-run-row.test.ts` | **卡死**：60s 零输出、不退出 | | | 手工中断 |

### 探针 1 的判读（spec §5.4）

（二选一，照抄判读结论：`也卡 ⇒ 三条共同点不是充分条件`（**不许**因此改守卫的判据集合）；或 `正常 ⇒ 三条共同点仍成立，缺的是「为什么它不在名单里」的解释`。）

（后续小节按顺序追加：「## 2. 已知边界」→「## 3. 修后判据」→「## 4. 既存红登记」。）
```

- [ ] **Step 5: 改 `fixtures.ts:34-44`——那条 import 只剩类型专用成员**

把 `packages/server/evaluator/src/testing/fixtures.ts` 的 `:34-44` 整段（现状见下）替换为后面那段：

```ts
import {
  permissiveMessageCapability,
  type AgentErrorCode,
  type AgentExitReason,
  type AgentKind,
  type AgentPermission,
  type AgentProvider,
  type AgentProviderMetadata,
  type AgentRunInput,
  type AgentRunResult,
} from '@aieval/agents';
```

替换为（**整条 `import type`**，与同文件 `:45` 的形态一致）：

```ts
/**
 * ⚠️ **这一条必须是类型专用的（2026-10-06）**：`@aieval/agents` 是被 `vi.mock` 的模块之一，
 * 而本文件落在某个工厂的**动态 import 闭包**上（`orchestrator-seams.ts:22` 静态 import 本文件，
 * 而各测试文件的工厂又 `await import('./testing/orchestrator-seams')`）⇒ 只要这条 import 里多出
 * **一个值成员**，就构成「工厂 → seams → fixtures → **正在求值中**的 `@aieval/agents`」这条
 * vite ModuleRunner 解不开的 await 环：整个文件 **0 个用例、无报错、无超时、零 CPU**（本包实测
 * 19/27 个文件如此 ⇒ `pnpm test` 整个不可用；根因见 spec §2）。
 * `tsconfig.base.json:5` 的 `verbatimModuleSyntax: true` 会把整条类型专用的 import **擦除**，
 * 运行时边随之消失 —— 这就是修复的全部机制。
 * 换来的那一格（`makeFakeProvider` 的 `messageCapability`）改用逐字字面量，见下面那里的注释。
 * 守卫：`static-assertions.test.ts` 的 `describe('工厂动态 import 的闭包不得运行时 import
 * 被 mock 的模块（防收集期静默挂死）')`。
 */
import type {
  AgentErrorCode,
  AgentExitReason,
  AgentKind,
  AgentPermission,
  AgentProvider,
  AgentProviderMetadata,
  AgentRunInput,
  AgentRunResult,
} from '@aieval/agents';
```

（这 8 个类型成员**都在本文件里有用**：`AgentKind` `:363`/`:392`/`:514`/`:562`/`:808-809`、`AgentPermission` `:420`、`AgentExitReason` `:433`/`:615`、`AgentErrorCode` `:462`、`AgentProviderMetadata` `:563`、`AgentRunInput` `:587`、`AgentRunResult` `:465`/`:470`/`:478`/`:587`/`:615` —— 一个都不要顺手删。）

- [ ] **Step 6: 改 `fixtures.ts:579-581`——`messageCapability` 换成 17 格字面量**

把现状这三行：

```ts
    // 消息能力声明：编排层不读它（它服务内容级视图），故这里用最宽松的一份形状桩；
    // 三家的真值在各自的 `providers/<kind>/index.ts` 里，由 agents 包的一致性用例钉住
    messageCapability: permissiveMessageCapability(),
```

替换为：

```ts
    /**
     * 消息能力声明：编排层不读它（它服务内容级视图），故这里用最宽松的一份形状桩；
     * 三家的真值在各自的 `providers/<kind>/index.ts` 里，由 agents 包的一致性用例钉住。
     *
     * **为什么是逐字字面量、而不是 `permissiveMessageCapability()`（2026-10-06）**：那个函数要从
     * `@aieval/agents` **运行时** import 进来，而它正是被 `vi.mock` 的模块之一 ⇒ 夹具会被卷进
     * 「工厂 → seams → fixtures → 在飞模块」那条环（见本文件 `:34` 那条 import 的注释）。
     * 字面量把这条运行时边**彻底去掉**，且不需要任何运行时读——**不要**改用
     * `vi.importActual('@aieval/agents')` 现取（那只是把边挪到执行期，风险面不明，spec §3.3），
     * 也**不要**在夹具里另写一个同名复制函数（那是第二份真源，spec §3.3）。
     *
     * 等价性：与 `agents/src/types.ts:292-311` 的返回值**逐格等价**（17 格 = 6 个能力位
     * + 5 对 `Source`/`Reason` + `notes`）；将来 `MessageCapability`（`contracts/src/agent-message.ts:401-463`）
     * 新增必填格时 `tsc` 会**直接点名**，故这份字面量不会静默过期。
     */
    messageCapability: {
      thinkingText: 'yes',
      thinkingTextKind: 'full',
      toolInput: 'yes',
      toolResult: 'yes',
      subagent: 'yes',
      streamingDelta: 'yes',
      thinkingTextSource: 'wire',
      thinkingTextReason: null,
      toolInputSource: 'wire',
      toolInputReason: null,
      toolResultSource: 'wire',
      toolResultReason: null,
      subagentSource: 'wire',
      subagentReason: null,
      streamingDeltaSource: 'wire',
      streamingDeltaReason: null,
      notes: [],
    },
```

- [ ] **Step 7: 类型检查**

Run:

```powershell
pnpm.cmd typecheck
```

Expected: **本次改动引入 0 错**（本仓是共享工作区，别人未提交的文件若有错，逐条归因到别人、不算本次的红）。这一条同时验证 Step 6 的 17 格字面量确实满足 `MessageCapability`。

- [ ] **Step 8: lint**

Run:

```powershell
pnpm.cmd lint
```

Expected: 全绿。**若报 `permissiveMessageCapability` / 某个 `type` 成员未使用** ⇒ 说明 Step 5 没有把整条改成 `import type`（或误删了还在用的类型成员），回到 Step 5 修。

- [ ] **Step 9: 判据 1 与判据 2（spec §5.1）——修后必须自行退出**

Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/orchestrator-run-row.test.ts
pnpm.cmd vitest run packages/server/evaluator/src/judge-agent.test.ts
```

Expected（两条都按同一判据读）：
- **60s 内进程自行退出**（不靠人工中断）；
- exit code 0；
- 汇总行出现 `Test Files  1 passed (1)`；
- **用例数非 0**：判据 1 是 `Tests  8 passed (8)`（`orchestrator-run-row.test.ts` 8 条），判据 2 是 `Tests  19 passed (19)`（`judge-agent.test.ts` 19 条）。「0 个用例 + 无报错」是静默挂死的另一种形态 ⇒ 必须看这一行。

**若汇总行是 failed**：先按 spec §5.3 的口径登记那几条红（本 Task 只改了 import 形态与一个字面量，理论上不可能改变任何判据）⇒ 逐条判断是不是与本次改动相关；**相关就修**，不相关就登记进 notes 并继续。

- [ ] **Step 10: 变异 1（spec §5.2 第 1 条）——修复侧的反证：边回来了就必须重新卡死**

① 先记基线哈希：

```powershell
Get-FileHash packages/server/evaluator/src/testing/fixtures.ts -Algorithm SHA256
```

② 把两处**同时**改回缺陷形态（**就是要造回那条环**）：`:581` 改回 `messageCapability: permissiveMessageCapability(),`；`:34-44` 改回带值成员的形态：

```ts
import {
  permissiveMessageCapability,
  type AgentErrorCode,
  type AgentExitReason,
  type AgentKind,
  type AgentPermission,
  type AgentProvider,
  type AgentProviderMetadata,
  type AgentRunInput,
  type AgentRunResult,
} from '@aieval/agents';
```

③ 跑它——**这一步同样预期挂死，用 Step 2 那一套五步程序**（等满 60s ⇒ 判读 ⇒ `taskkill /PID <自己起的 pid> /T /F` ⇒ 确认无残留），只把输出重定向换成 `"$env:TEMP\aieval-mutation1.out"` / `.err`、变量换成 `$hang2`：

```powershell
$hang2 = Start-Process -FilePath 'pnpm.cmd' `
  -ArgumentList 'vitest','run','packages/server/evaluator/src/orchestrator-run-row.test.ts' `
  -WorkingDirectory 'D:\Github\ai-result-evaluation' -PassThru `
  -RedirectStandardOutput "$env:TEMP\aieval-mutation1.out" -RedirectStandardError "$env:TEMP\aieval-mutation1.err"
"hang pid = $($hang2.Id)"
Start-Sleep -Seconds 60
"exited: " + $hang2.HasExited
Get-Content "$env:TEMP\aieval-mutation1.out" -Tail 20
taskkill /PID $hang2.Id /T /F
Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id, StartTime, CPU
```

Expected: 60s 后 `exited: False`、没有任何用例行与汇总行（**重新卡死**）。这一步证明这条边**就是**闭合边（「边没了才通」+「边回来了就死」双向）。
⚠️ 只终止 `$hang2.Id` 那一棵树；**不要**碰 3083 的 dev server 与别人的 node 进程。

④ 逐字还原两处，再跑一次哈希：

```powershell
Get-FileHash packages/server/evaluator/src/testing/fixtures.ts -Algorithm SHA256
```

Expected: 与 ① 的哈希**逐字相同**（这就是 spec §5.2 第 4 条的「还原并核对文件哈希未变」）。还原后重跑判据 1 确认回绿。

⚠️ 变异期间**不要跑 lint**（值成员会变成未使用的 import，那是变异体的副作用，不是本次要观测的东西）。

- [ ] **Step 11: 探针 2（spec §5.4 第 2 条，条件式）**

**只在 Step 9 判据 1 失败（仍卡）时执行**；判据 1 通过 ⇒ 本步不触发。

无论触发与否，都在 notes 文件末尾追加一个**三级**小节记录它（不占用二级编号）：

```markdown
### 探针 2（spec §5.4 第 2 条）：未触发 / 已触发

- 未触发：判据 1 通过（60s 内自行退出）⇒ spec §6.3 那条观察保持「未验」原样，不追。
- 已触发（判据 1 仍卡）：先看 `fixtures.ts:803` 的 `vi.importActual`、再看 workspace 软链装载路径，结论如下：
```

若判据 1 仍卡：**先看 `fixtures.ts:803` 的 `vi.importActual`**（spec §6.3：它是对同一个模块 id 的一次运行时触碰，只是走 mock 的旁路 API；它**不在**被追到的那条边上，但**没有被排除**），**再看** spec §6.2 的 workspace 软链 / 裸包说明符装载路径（`d-bare` 未验那条）。
**不许**为了让它过而改守卫的判据集合、**不许**拆掉 `fakeAgentsModule` 的 `vi.importActual`（那正是 `fixtures.ts:788-797` 记录过的事故的修复：拆了会让 evaluator 16 个文件、83 条用例一起红，而报错点离真因很远）。把结论写进 notes 后回报。

- [ ] **Step 12: 提交**

```bash
git add packages/server/evaluator/src/testing/fixtures.ts docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md
git commit -m "fix(evaluator): 断开夹具对 @aieval/agents 的运行时边，解开收集期静默挂死"
```

---

### Task 2: 结构守卫——工厂闭包不得对被 mock 的项目模块存在运行时边

**Files:**
- Modify: `packages/server/evaluator/src/static-assertions.test.ts:30-32`（import 行：补 `posix` 与 `typescript`）
- Modify: `packages/server/evaluator/src/static-assertions.test.ts`（文件末尾 `:467` 之后追加一个 `describe` 与它的模块级辅助）
- Test: `packages/server/evaluator/src/static-assertions.test.ts`

**Interfaces:**
- Consumes: Task 1 的修复结果（**否则本守卫落地即红**——`fixtures.ts` 那条运行时边会让闭包判定命中 `testing/fixtures.ts:34`）。
- Produces（Task 3 的注释要按名字指向它们）：
  - `describe('工厂动态 import 的闭包不得运行时 import 被 mock 的模块（防收集期静默挂死）')`；
  - `MOCKED_MODULES: ReadonlyArray<{ label: string; key: string }>`（4 项登记表：`@aieval/agents` / `judge` / `run-store` / `text-api`）；
  - `mockedRuntimeEdges(file: string, text: string): string[]`（判据本体，样本表直接喂它）；
  - `factoryClosure(target: string): string[]`、`viMockCalls(file: string, text: string): MockCall[]`、`factoryImports(file: string, text: string, factory: ts.Expression): FactoryImports`。

- [ ] **Step 1: 写守卫（一次写完：import 行 + 模块级辅助 + `describe`）**

**① 把 `:30-32` 的 import 行改成：**

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
```

（`ts` **必须**用默认导入，两条依据都是实测的：① 本机装的 `typescript@5.9.3` 的 `package.json` 只有 `"main": "./lib/typescript.js"` + `"typings": "./lib/typescript.d.ts"`、**没有 `exports` / `module`** ⇒ 它是纯 CJS 包，类型走 `typings`（d.ts 以 `export = ts` 收尾）、运行期由 CJS 互操作给出 `module.exports`；② 本仓 `tsconfig.base.json:14` 有 `esModuleInterop: true`，默认导入合法。**不要**改成 `import * as ts from 'typescript'` —— 那不报类型错，但一个 CJS bundle 的具名导出未必能被识别，`ts.createSourceFile` 可能静默是 `undefined`。）

**② 在文件末尾（`:467` 的 `});` 之后）追加下面这一整段：**

````ts
/**
 * **工厂动态 import 的闭包里，不得存在对「被 mock 的项目模块」的运行时边**（2026-10-06）。
 *
 * 为什么必须有这条守卫：`vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock())`
 * 这类工厂在**收集阶段**就要把目标模块求值出来，于是「工厂 → seams → fixtures → **正在求值中**的
 * `@aieval/agents`」构成一条 vite ModuleRunner **解不开的 await 环**：整个文件 **0 个用例、无报错、
 * 无超时、零 CPU**（本包实测 19/27 个文件如此 ⇒ `pnpm test` 这个动作整个不成立；根因见 spec
 * `2026-10-06-evaluator-collect-deadlock-fix-design.md` §2）。
 *
 * 为什么不能靠上面那条守卫（三条 `vi.mock` 文本的存在性）：
 *   · 它与缺陷**同向**——mock 注册得越齐它越绿，而**注册齐全正是触发条件之一**（19 个挂死文件
 *     在那条守卫下全绿，却一个用例都跑不了）；
 *   · 环的形状是「A 的工厂 → B → C → A」，任何**单文件**的文本里都看不到它。
 *
 * 判据分三步（spec §4.2）：
 *   ① MOCKED  ← 一张**登记表**（`MOCKED_MODULES`）：所有被 mock 的**项目模块**。`node:` 内建
 *      **刻意不入表**——`run-delete.test.ts:32` / `run-store.test.ts:21` mock 了 `node:fs`，而
 *      `fixtures.ts:11` 必须能 import 它（建临时家目录），把内建纳入判据会让守卫**落地即红**，
 *      且环发生在**项目模块**之间；
 *   ② ROOTS   ← 扫 `src/**\/*.test.ts` 里每个 `vi.mock(…)` 的**工厂实参**子树，取其中的
 *      `import('<字面量>')`；工厂里出现**非字面量**目标 ⇒ 直接判红（推导不出来就不放行）；
 *   ③ 违规    ← 从 ROOTS 出发沿**运行时相对 import** 走 `src/` 内的本地文件得到闭包，
 *      闭包里任一文件对 MOCKED 里任一目标存在运行时边 ⇒ 红，报 `文件:行: 说明符`。
 *
 * 为什么范围是「工厂目标的静态可达闭包」而不是整个 `src/testing/`：`orchestrator-harness.ts:40`
 * **运行时** import `../run-store`（它自己也是被 mock 的模块），而 harness **不是**任何工厂的目标
 * ⇒ 把整个目录纳入，守卫**落地那一刻就是红的**，而那不是本缺陷（假红会诱使人削弱断言 —— 这正是
 * 本仓反复登记的教训）。
 *
 * 已知边界（如实登记，不许当成守卫失效，spec §5.2 的 3b / §7）：拼字符串的 `require`、
 * `import(变量)` 这类推导不出来的形态（工厂目标的那一半已由 ② 判红兜住）、以及下面显式放行的
 * `vi.importActual`。
 */

/** 一条「运行时触碰了某个模块」的记录；`kind` 决定它是否被放行 */
interface RuntimeTouch {
  /** `import-actual` 是 `vi.importActual(…)`：mock 系统的旁路 API，**显式放行**（spec §4.4） */
  kind: 'static-import' | 'dynamic-import' | 'require' | 'import-actual';
  /** 说明符原文（未归一化）；非字面量目标记成 `<非字面量>` */
  specifier: string;
  /** 源码行号（1 起） */
  line: number;
}

/**
 * 被 mock 的项目模块**登记表**（不靠类型推导，靠下面那条绊线用例与源码保持同步）。
 * `key` 是归一后的模块身份：裸说明符原样，相对说明符归一成相对 `src/` 的路径（不带扩展名）
 * ⇒ 从 `src/testing/` 看，`../judge` 与从 `src/` 看的 `./judge` 是**同一个身份**。
 */
const MOCKED_MODULES: ReadonlyArray<{ label: string; key: string }> = [
  // 三方：orchestrator-run-row.test.ts:12、judge-agent.test.ts:18、run-delete.test.ts:39 等
  { label: '@aieval/agents', key: '@aieval/agents' },
  // 本地：orchestrator-run-row.test.ts:13 / :17；judge.test.ts:22（同一类环的另一个入口）
  { label: './judge', key: 'judge' },
  { label: './run-store', key: 'run-store' },
  { label: './text-api', key: 'text-api' },
];

/** `src/**\/*.test.ts`（相对 src，正斜杠）——`vi.mock` 只可能写在测试文件里 */
function testFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.test.ts'));
}

/** `src/**\/*.ts`（含 `testing/**` 与测试文件）：闭包只在本包的文件里走 */
function allSourceFiles(): string[] {
  return readdirSync(import.meta.dirname, { recursive: true })
    .map((entry) => String(entry).replace(/\\/g, '/'))
    .filter((entry) => entry.endsWith('.ts'));
}

/** 字符串字面量节点的文本；不是字面量（含 undefined）时为 null */
function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * 把说明符归一成**模块身份**：相对说明符按 `fromFile` 所在目录归一成相对 `src/` 的路径
 * （去掉 `.ts`）；裸说明符原样返回。只比身份，不校验文件是否存在。
 */
function moduleKey(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier)).replace(/\.ts$/, '');
}

/** 顶层语句是不是一条**运行时**模块引用（spec §4.2 的逐形态表） */
function isRuntimeModuleStatement(statement: ts.Statement): boolean {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause === undefined) return true; // `import 'x'`：副作用导入
    if (clause.isTypeOnly) return false; // `import type { … } from`：整条擦除
    if (clause.name !== undefined) return true; // 默认导入
    const bindings = clause.namedBindings;
    if (bindings === undefined) return true;
    if (ts.isNamespaceImport(bindings)) return true; // `import * as ns from`
    return bindings.elements.some((element) => !element.isTypeOnly); // 任一成员不带 `type`
  }
  if (ts.isExportDeclaration(statement)) {
    if (statement.moduleSpecifier === undefined) return false; // 本地导出，不碰别的模块
    if (statement.isTypeOnly) return false; // `export type { … } from`
    const clause = statement.exportClause;
    if (clause === undefined) return true; // `export * from`
    if (ts.isNamespaceExport(clause)) return true; // `export * as ns from`
    return clause.elements.some((element) => !element.isTypeOnly);
  }
  if (ts.isImportEqualsDeclaration(statement)) {
    // `import a = require('x')`；`import type a = require('x')` 是类型专用，放行
    return !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference);
  }
  return false;
}

/** 顶层语句的模块说明符文本；不是「带字面量说明符的模块引用」时为 null */
function statementSpecifier(statement: ts.Statement): string | null {
  if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    return statement.moduleSpecifier === undefined ? null : literalText(statement.moduleSpecifier);
  }
  if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
    return literalText(statement.moduleReference.expression);
  }
  return null;
}

/**
 * 一个文件里全部「运行时触碰模块」的位置。
 *
 * 两条来源互补：顶层声明走 `source.statements`；动态 `import()` / `require()` / `vi.importActual()`
 * 走整棵树的 `CallExpression`（它们可以出现在任何深度）。`typeof import('x')` 是 `ImportTypeNode`
 * （**类型位置**、不是 `CallExpression`）⇒ 天然落在判据之外（这正是正则方案会误报的那个形态）。
 *
 * ⚠️ `vi.importActual(…)` **故意记成一条触碰**（而不是在这里跳过）：放行发生在
 * `mockedRuntimeEdges()` 里 —— 删掉那条放行规则守卫就会红（spec §5.2 的变异 3a：
 * **见过失败才算守卫**）。
 */
function runtimeTouches(file: string, text: string): RuntimeTouch[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const touches: RuntimeTouch[] = [];
  const at = (node: ts.Node): number => lineOf(text, node.getStart(source));
  for (const statement of source.statements) {
    if (!isRuntimeModuleStatement(statement)) continue;
    const specifier = statementSpecifier(statement);
    if (specifier !== null) touches.push({ kind: 'static-import', specifier, line: at(statement) });
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        touches.push({ kind: 'dynamic-import', specifier: literalText(node.arguments[0]) ?? '<非字面量>', line: at(node) });
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'vi' &&
        callee.name.text === 'importActual'
      ) {
        touches.push({ kind: 'import-actual', specifier: literalText(node.arguments[0]) ?? '<非字面量>', line: at(node) });
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        touches.push({ kind: 'require', specifier: literalText(node.arguments[0]) ?? '<非字面量>', line: at(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return touches;
}

/**
 * 一个文件对**被 mock 的项目模块**的运行时边（`文件:行: 说明符（被 mock 的 登记名）`）。
 *
 * `vi.importActual(…)` 在此**显式放行**（spec §4.4）：它是 mock 系统的旁路 API（读的是**真模块**），
 * `fixtures.ts:803` 用它让 `acceptsProtocol` / `protocolMismatchMessage` 与真模块同源 ——
 * 那是 `fixtures.ts:788-797` 记录过的那次事故（缺这两个导出 ⇒ evaluator 16 个文件、83 条用例
 * 一起红，报错点离真因很远）的修复。把它算成运行时边 ⇒ 守卫**落地即红**，还会诱使人去拆掉
 * 那次修复。**这条放行是活代码**：删掉它，守卫必须红（spec §5.2 的变异 3a）。
 */
function mockedRuntimeEdges(file: string, text: string): string[] {
  const edges: string[] = [];
  for (const touch of runtimeTouches(file, text)) {
    if (touch.kind === 'import-actual') continue;
    const mocked = MOCKED_MODULES.find((module) => module.key === moduleKey(file, touch.specifier));
    if (mocked !== undefined) edges.push(`${file}:${touch.line}: ${touch.specifier}（被 mock 的 ${mocked.label}）`);
  }
  return edges;
}

/** 一个文件里全部**运行时相对 import** 的目标（归一后，相对 `src/` 且不带扩展名） */
function runtimeRelativeTargets(file: string, text: string): string[] {
  return runtimeTouches(file, text)
    .filter((touch) => touch.kind !== 'import-actual' && touch.specifier.startsWith('.'))
    .map((touch) => moduleKey(file, touch.specifier));
}

/**
 * 从工厂目标出发，沿**运行时相对 import** 走 `src/` 内的本地文件，得到闭包（含起点）。
 * 只沿相对 import 走：裸说明符（`@aieval/agents` / `node:fs`）不是本包的文件 —— 它们正是判据要
 * 比对的**目标**，不是要展开的中间节点。类型专用 import 不跟着走（不产生运行时边）。
 */
function factoryClosure(target: string): string[] {
  const known = new Set(allSourceFiles());
  const seen = new Set<string>();
  const queue = [`${target}.ts`];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file) || !known.has(file)) continue;
    seen.add(file);
    for (const next of runtimeRelativeTargets(file, readSource(file))) queue.push(`${next}.ts`);
  }
  return [...seen];
}

/** 一条 `vi.mock('<字面量>', <工厂>)` 调用 */
interface MockCall {
  /** 第一个实参（说明符）的文本 */
  specifier: string;
  /** 工厂实参；没有第二实参的注册没有传递 import 图 */
  factory: ts.Expression | undefined;
}

/** 收集一个测试文件里所有「说明符是字面量」的 `vi.mock(…)` 调用 */
function viMockCalls(file: string, text: string): MockCall[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const calls: MockCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'vi' &&
      node.expression.name.text === 'mock'
    ) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== null) calls.push({ specifier, factory: node.arguments[1] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** 工厂实参里的动态 `import('<字面量>')` 目标（归一后），以及推导不出来的那些 */
interface FactoryImports {
  /** 归一后的目标（相对 `src/`，不带扩展名） */
  targets: string[];
  /** 非字面量的 `import(…)` 目标：推导不出来就不放行（spec §4.2 ②） */
  unresolved: string[];
}

/** 扫一棵工厂实参子树里的动态 `import(…)` */
function factoryImports(file: string, text: string, factory: ts.Expression): FactoryImports {
  const source = factory.getSourceFile();
  const targets: string[] = [];
  const unresolved: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier === null) unresolved.push(`${file}:${lineOf(text, node.getStart(source))}: import(<非字面量>)`);
      else targets.push(moduleKey(file, specifier));
    }
    ts.forEachChild(node, visit);
  };
  visit(factory);
  return { targets, unresolved };
}

describe('工厂动态 import 的闭包不得运行时 import 被 mock 的模块（防收集期静默挂死）', () => {
  it('闭包里没有对「被 mock 的项目模块」的运行时边；工厂里的 import 目标必须是字面量', () => {
    const offenders: string[] = [];
    const unresolved: string[] = [];
    for (const file of testFiles()) {
      const text = readSource(file);
      for (const call of viMockCalls(file, text)) {
        if (call.factory === undefined) continue;
        const imports = factoryImports(file, text, call.factory);
        unresolved.push(...imports.unresolved);
        for (const target of imports.targets) {
          for (const reached of factoryClosure(target)) offenders.push(...mockedRuntimeEdges(reached, readSource(reached)));
        }
      }
    }
    // 推导不出来 ⇒ 不放行（宁可红，也不要一条「看不懂就算过」的守卫）
    expect(unresolved).toEqual([]);
    // 同一个文件会被多个工厂命中，去重后报出来
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('绊线：被 mock 的项目模块与工厂目标，与登记表逐项一致（新增时先红一次）', () => {
    const mockedKeys = new Set<string>();
    const factoryTargets = new Set<string>();
    for (const file of testFiles()) {
      const text = readSource(file);
      for (const call of viMockCalls(file, text)) {
        // ⚠️ `node:` 内建**不入判据**：run-delete.test.ts:32 与 run-store.test.ts:21 mock 了 `node:fs`，
        // 而 fixtures.ts:11 必须能 import 它（建临时家目录）——把内建纳入判据会让守卫**落地即红**，
        // 且环发生在**项目模块**之间（spec §4.2 ① 的 2026-10-06 控制者裁定）。
        if (!call.specifier.startsWith('node:')) mockedKeys.add(moduleKey(file, call.specifier));
        if (call.factory !== undefined) {
          for (const target of factoryImports(file, text, call.factory).targets) factoryTargets.add(target);
        }
      }
    }
    // 本条是**绊线**：新增第三条 `vi.mock` 或第三个工厂目标模块时它先红一次，逼作者回来看
    // 「新模块要不要纳入 MOCKED_MODULES、会不会构成同类环」——沿用本仓的计数绊线手法
    // （见上面 `:448-458`）。
    expect([...mockedKeys].sort()).toEqual(MOCKED_MODULES.map((module) => module.key).sort());
    expect([...mockedKeys].sort()).toEqual(['@aieval/agents', 'judge', 'run-store', 'text-api']);
    // 工厂目标今天只有这两个模块（现状：全包的 `import('./testing/…')` 只落在这两处）
    expect([...factoryTargets].sort()).toEqual(['testing/fixtures', 'testing/orchestrator-seams']);
  });

  it('判定认得出运行时边的各种形态，并放行类型专用 / 类型位置 / vi.importActual（判据的规格）', () => {
    /**
     * 为什么单开一条：上面那条只能证明「当前源码干净」，不能证明判据**有覆盖**——判据被改窄时
     * 那条照样绿。这里把形态直接喂给判定本身（沿用本仓做法，见 `agents/src/static-assertions.test.ts:185-209`）。
     * 喂进去的「来源文件」写作 `testing/fixtures.ts`：样本 ⑦ 就是靠它验证「`../judge` 归一化后
     * 命中 `judge`」这条口径。
     */
    const negative = [
      "import { permissiveMessageCapability } from '@aieval/agents';",
      ["import {", "  type A,", "  permissiveMessageCapability,", "} from '@aieval/agents';"].join('\n'),
      "import providers from '@aieval/agents';",
      "import * as agents from '@aieval/agents';",
      "import '@aieval/agents';",
      "export * from '@aieval/agents';",
      "export { getProvider } from '@aieval/agents';",
      "import a = require('@aieval/agents');",
      "const a = await import('@aieval/agents');",
      "require('@aieval/agents');",
      "import { getProvider } from '../judge';",
      'import{getProvider}from"@aieval/agents";',
    ];
    for (const form of negative) {
      expect(mockedRuntimeEdges('testing/fixtures.ts', form), `应当命中：${form}`).not.toEqual([]);
    }

    const positive = [
      "import type { A, B } from '@aieval/agents';",
      ["import {", "  type AgentKind,", "  type AgentProvider,", "} from '@aieval/agents';"].join('\n'),
      "import type { JudgeInput } from '../judge';",
      "const t: typeof import('@aieval/agents') = x;",
      "const actual = await vi.importActual<typeof import('@aieval/agents')>('@aieval/agents');",
      "import { fakeAgentsModule } from './fixtures';",
    ];
    for (const form of positive) {
      expect(mockedRuntimeEdges('testing/fixtures.ts', form), `不该命中：${form}`).toEqual([]);
    }
  });
});
````

- [ ] **Step 2: 跑守卫——期望绿（它的红由后面三条变异给出）**

Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/static-assertions.test.ts
```

Expected: **几秒内**自行退出，`Test Files  1 passed (1)`，且用例数比改动前**多 3 条**（本文件原有 6 条 `it(`，见 `:368` / `:374` / `:391` / `:413` / `:448` / `:460`；改后 9 条 ⇒ `Tests  9 passed (9)`）。

⚠️ 这条守卫**不是**从「先写红、再改绿」起步的：它是结构守卫，红必须由**人为造回缺陷**给出（Step 5–8）。**没见过失败的守卫不算守卫**。

- [ ] **Step 3: 类型检查**

Run:

```powershell
pnpm.cmd typecheck
```

Expected: 本次改动引入 0 错（`ts` 的类型面全在这里用上了 —— 若 `ts` 报「不是模块」或 `ts.createSourceFile` 报不存在，见 Step 1 ① 后面那段括号里的两条依据）。

- [ ] **Step 4: lint**

Run:

```powershell
pnpm.cmd lint
```

Expected: 全绿（`@stylistic` 的单引号 / 分号 / 2 空格缩进都按本仓规则写）。

- [ ] **Step 5: 变异 2（spec §5.2 第 2 条）——守卫侧的种子缺陷：只加回值成员**

① 记基线哈希（**要变的是 `fixtures.ts`**，所以记它的哈希）：

```powershell
Get-FileHash packages/server/evaluator/src/testing/fixtures.ts -Algorithm SHA256
```

② 只把 `fixtures.ts:34-44` 那条 import 改回带值成员的形态（**`:581` 仍用字面量** ⇒ 这是一个「**未被使用但运行时存在**」的 import）：

```ts
import {
  permissiveMessageCapability,
  type AgentErrorCode,
  type AgentExitReason,
  type AgentKind,
  type AgentPermission,
  type AgentProvider,
  type AgentProviderMetadata,
  type AgentRunInput,
  type AgentRunResult,
} from '@aieval/agents';
```

③ Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/static-assertions.test.ts
```

Expected: **红** —— 第一条用例的 `expect([...new Set(offenders)]).toEqual([])` 失败，且报错文本里必须出现 **`testing/fixtures.ts:34`**（spec §5.2 第 2 条要的就是「指向 `fixtures.ts:34-44` 那一行」）。若红的是别的用例、或报错里没有这一行 ⇒ 守卫指错了对象，回到 Step 1 修。

④ 逐字还原 `fixtures.ts`，核对哈希：

```powershell
Get-FileHash packages/server/evaluator/src/testing/fixtures.ts -Algorithm SHA256
```

Expected: 与 ① 的哈希**逐字相同**。还原后重跑守卫回绿。

- [ ] **Step 6: 变异 3a（spec §5.2 第 3a 条）——放行规则本身要活着**

① 记基线哈希：

```powershell
Get-FileHash packages/server/evaluator/src/static-assertions.test.ts -Algorithm SHA256
```

② 删掉 `mockedRuntimeEdges()` 里那一行：

```ts
    if (touch.kind === 'import-actual') continue;
```

（即：把 `fixtures.ts:803` 的 `vi.importActual` 判成运行时边。）

③ Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/static-assertions.test.ts
```

Expected: **两条用例同时红** —— ① 第一条（`offenders` 里出现 `testing/fixtures.ts:803`）；② 第三条样本表的**正样本** `await vi.importActual<…>(…)` 那条（`不该命中：…` 的失败信息）。⇒ 证明这条放行规则是**活**的，不是无人经过的死代码。

④ 还原那一行，核对哈希：

```powershell
Get-FileHash packages/server/evaluator/src/static-assertions.test.ts -Algorithm SHA256
```

Expected: 与 ① 一致；重跑守卫回绿。

- [ ] **Step 7: 变异 2b（本仓规矩：新守卫的每一条断言都要见过失败）——绊线必须真的会响**

① 记基线哈希：

```powershell
Get-FileHash packages/server/evaluator/src/judge.test.ts -Algorithm SHA256
```

② 在 `packages/server/evaluator/src/judge.test.ts` 的 `vi.mock('./text-api', …)` 之前临时插一行（**只跑守卫文件，不跑 `judge.test.ts`**）：

```ts
vi.mock('./events', async () => ({}));
```

③ Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/static-assertions.test.ts
```

Expected: **红** —— 第二条（绊线的）前两条断言同时失败（它们比的是同一个推导集合）：`mockedKeys` 多出 `events` ⇒ `toEqual(['@aieval/agents','judge','run-store','text-api'])` 失败。**第一条（闭包判定）必须仍然绿** —— 若它也红了，说明这一行意外带进了工厂目标，回到 Step 1 检查。

④ 删掉那一行，核对哈希：

```powershell
Get-FileHash packages/server/evaluator/src/judge.test.ts -Algorithm SHA256
```

Expected: 与 ① 一致；重跑守卫回绿。

- [ ] **Step 8: 变异 2c（本仓规矩）——样本表必须真的能挡住「改窄判据」**

① 记基线哈希：

```powershell
Get-FileHash packages/server/evaluator/src/static-assertions.test.ts -Algorithm SHA256
```

② 把 `isRuntimeModuleStatement()` 里的 `export` 那两个分支整段删掉：

```ts
  if (ts.isExportDeclaration(statement)) {
    if (statement.moduleSpecifier === undefined) return false; // 本地导出，不碰别的模块
    if (statement.isTypeOnly) return false; // `export type { … } from`
    const clause = statement.exportClause;
    if (clause === undefined) return true; // `export * from`
    if (ts.isNamespaceExport(clause)) return true; // `export * as ns from`
    return clause.elements.some((element) => !element.isTypeOnly);
  }
```

③ Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/static-assertions.test.ts
```

Expected: **红** —— 第三条样本表里 `export * from '@aieval/agents';` 与 `export { getProvider } from '@aieval/agents';` 两条负样本不再被命中（`应当命中：…` 的失败信息）。

④ 把那段贴回去，核对哈希：

```powershell
Get-FileHash packages/server/evaluator/src/static-assertions.test.ts -Algorithm SHA256
```

Expected: 与 ① 一致；重跑守卫回绿。

- [ ] **Step 9: 提交**

```bash
git add packages/server/evaluator/src/static-assertions.test.ts
git commit -m "test(evaluator): 新增守卫——工厂动态 import 的闭包不得运行时 import 被 mock 的模块"
```

⚠️ 本 Task **不改** `fixtures.ts`（Step 5 的变异必须逐字还原）；`git add` 只加守卫这一个文件。

---

### Task 3: 修 `orchestrator-seams.ts` 那句与现状不符的注释 + 登记 3b

**Files:**
- Modify: `packages/server/evaluator/src/testing/orchestrator-seams.ts:8-10`
- Modify: `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`（追加「已知边界」小节）
- Test: `packages/server/evaluator/src/static-assertions.test.ts`（注释改动不许改变任何判据）

**Interfaces:**
- Consumes: Task 2 产出的 `describe('工厂动态 import 的闭包不得运行时 import 被 mock 的模块（防收集期静默挂死）')`（注释里要按这个名字指过去）。
- Produces: `orchestrator-seams.ts:1-19` 的文件头注释（口径与现状相符 + 指向守卫）；notes 的「已知边界」小节。

- [ ] **Step 1: 改注释（`orchestrator-seams.ts:8-10`）**

现状（`:8-10`，**与事实不符**）：

```ts
 * 本模块只依赖 `./fixtures` 与 `@aieval/contracts`（两者都不 import 被 mock 的模块），
 * 因此从工厂里 import 它是安全的；对 `../judge` / `../run-store` 的引用一律只出现在**类型位置**
 * （`typeof import('...')` 编译期擦除，不产生运行时 import）。
```

替换为：

```ts
 * ⚠️ **口径修正（2026-10-06）**：本模块今天能从工厂里安全地 import，靠的是「**它的运行时依赖闭包
 * 里没有被 mock 的模块**」——而**不是**「依赖 `./fixtures` 就等于安全」。**修正前那句注释**把结论
 * 建立在一个**假前提**上：`./fixtures` 原先从 `@aieval/agents` **运行时** import 了一个值成员
 * （`permissiveMessageCapability`；已在 **T1 的那个提交**里连同 `:581` 的调用点一起改成字面量），
 * 而 `@aieval/agents` 正是被 mock 的模块之一 ⇒「工厂 → 本模块 → fixtures → **正在求值中**的
 * `@aieval/agents`」构成一条 vite ModuleRunner **解不开的 await 环**，表现与上面那种循环**一字不差**
 * （整个文件 0 个用例、无报错、无超时、零 CPU；本仓实测 19/27 个文件如此 ⇒ `pnpm test` 整个不可用）。
 * 对 `../judge` / `../run-store` / `../text-api` 的引用一律只出现在**类型位置**
 * （`typeof import('...')` 编译期擦除，不产生运行时 import）——这一条**与现状相符**，保持不变。
 * **怎么判、怎么防**都在 `../static-assertions.test.ts` 的
 * `describe('工厂动态 import 的闭包不得运行时 import 被 mock 的模块（防收集期静默挂死）')`：
 * 它从每个工厂的 `import(...)` 出发沿运行时闭包走，凡是对被 mock 的项目模块
 * （`@aieval/agents` / `./judge` / `./run-store` / `./text-api`）存在运行时边就红。
 * **往本模块（或 `./fixtures`）加任何运行时 import 之前，先看那条守卫。**
```

- [ ] **Step 2: 跑守卫确认注释改动没碰到判据**

Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator/src/static-assertions.test.ts
```

Expected: 几秒内自行退出，`Test Files  1 passed (1)`、`Tests  9 passed (9)`（注释不进 AST 的 import 判据）。

- [ ] **Step 3: 类型检查与 lint**

Run:

```powershell
pnpm.cmd typecheck
pnpm.cmd lint
```

Expected: 两条都全绿（只改注释，本次引入 0 错）。

- [ ] **Step 4: 登记 spec §5.2 的 3b（**不作为变异**）与两条未验观察**

在 notes 文件末尾**追加**一个二级小节 `## 2. 已知边界`，其下写入（**逐条照抄口径，一条都不许升级为结论**）：

```markdown
## 2. 已知边界

### 3b：守卫**看不见**的形态（登记，不作为变异）

形态：在夹具里用 `vi.importActual('@aieval/agents')` **现取** `permissiveMessageCapability` 来填 `messageCapability` 那一格。
按 §4.4 的判据它是**放行**的 —— 这是**有意留的覆盖边界**，**不许**当成「守卫失效」。

**为什么没有按字面执行这条变异**：spec §5.2 把落点写成 `makeFakeProvider()`，而
`fixtures.ts:562` 的 `function makeFakeProvider(kind: AgentKind): AgentProvider` 是**同步**函数，
`vi.importActual` 返回 Promise ⇒ 这个字面形态**不可直接实现**（要真做，得由异步的 mock 工厂先把值
存到一个模块级变量、再让同步的 `makeFakeProvider` 去读，那是另一套机械、且它测的是「守卫看不见什么」
而不是本次要守的东西）。spec 自己把这一条标为「登记，不作为变异」，故本计划只登记。

### 未验的观察（spec §6.2 / §6.3，本计划不主张结论）

- §6.2：`d-bare`（**裸包说明符**版本）因探针的 junction 穿不过 workspace 软链**没验成** ⇒ 若判据 1 仍卡，
  回去查 workspace 软链的装载路径（Task 1 Step 11 的探针 2）。
- §6.3：`fixtures.ts:803` 在 `fakeAgentsModule()` 里对**同一个模块 id** 有一次运行时触碰（走 mock 的
  旁路 API、读的是真模块）。它不在被追到的那条边上，且在当前挂死路径上根本不会执行（在函数体内，
  晚于那条静态边），但**没有被排除**。
- 变体覆盖：`--pool` 的其它取值、**非 Windows**、**vitest 5 / vite 7** 均**未验**（本机是 vitest 4.1.11
  + vite 8.3.0；spec §2.3 引的 `module-runner.js` 行号只对应这份安装）。
```

- [ ] **Step 5: 提交**

```bash
git add packages/server/evaluator/src/testing/orchestrator-seams.ts docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md
git commit -m "docs(evaluator): 修正 seams 注释里那条已被证伪的安全前提，并指向新守卫"
```

---

### Task 4: 整包收集验收（判据 3）+ 全量第一次真正跑起来（spec §5.3）

**Files:**
- Modify: `docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md`（追加「修后判据」与「既存红登记」两小节）
- Test: `packages/server/evaluator`（整包 27 个文件）+ 全仓一次

**Interfaces:**
- Consumes: Task 1–3 的全部改动（`fixtures.ts` 的 import 与字面量、新守卫、seams 注释）。
- Produces: notes 的「## 3. 修后判据」与「## 4. 既存红登记」两小节（这是本次交付的一部分，要提交）。

- [ ] **Step 1: 判据 3a（spec §5.1 判据 3）——整包 27 个文件，进程必须自行退出**

Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator
```

Expected（20 分钟上限）：
- ① 进程**自行退出**（不靠人工中断）；
- ② 汇总行 `Test Files` 的**总数是 27**（形如 `Test Files  N failed | M passed (27)`；`N + M = 27`）——
  这条判的是「**27 个文件都能被收集**」，**不判全绿**（spec §5.3）；
- ③ **19 个目标文件都被执行过**（下一条 Step 用 json 产物钉死）。

**若 20 分钟不退出** ⇒ 记录读数后中断它（前台跑的用 `Ctrl+C`；若是用 `Start-Process -PassThru` 起的，就按 Task 1 Step 2 那五步用 `taskkill /PID <自己那个 pid> /T /F` 收自己那一棵树，**别** `taskkill /IM node.exe`），然后回报：说明修复不完整，回到 Task 1 Step 11 的探针 2。

- [ ] **Step 2: 判据 3b——用 json 产物钉死「收集到 27 个」**

Run:

```powershell
pnpm.cmd vitest run packages/server/evaluator --reporter=json --outputFile="$env:TEMP\aieval-evaluator-collect.json"
(Get-Content "$env:TEMP\aieval-evaluator-collect.json" -Raw | ConvertFrom-Json).testResults.Count
```

Expected: 第二行输出 **`27`**。（记录里挂死时 json 产物**根本不生成** ⇒ 「产物生成 + 条数 27」本身就是判据。）

- [ ] **Step 3: spec §5.3——全量第一次真正跑起来（**本计划唯一允许跑的一次全量**）**

Run:

```powershell
pnpm.cmd test
```

**判据（必须按此读，不许加码）**：
- **只承诺「27 个文件能被收集」**（上一步已证）；**不承诺全绿**。那 19 个文件在门禁里**从未执行过**
  （合并记录按「evaluator **未执行**」入账）⇒ 解冻后是**第一次**真的执行它们，可能暴露与本修复无关的既存红。
- **先看 `tests` 累积项**：比上次大 2 倍以上就不把红当回归（本仓「机器带负载」的口径 —— 同时跑着开发
  服务器 / 浏览器自动化时，同一份代码的 `tests` 累积实测会涨到 3.1×）。
- **逐条登记新出现的红**，按「**回归 / 既存 / 机器慢**」三分类；**本次修复里不顺手修**（不扩环）。
- 跑之前确认机器安静（没人跑着 dev server / 浏览器自动化）。

- [ ] **Step 4: 把修后读数与既存红写进 notes**

在 notes 文件末尾**追加**两小节（`命令 / 期望` 两列照抄；`实测 / 墙钟 / 退出方式` 三列按真实读数填）：

```markdown
## 3. 修后判据

| # | 命令 | 期望（spec） | 实测 | 墙钟 | 退出方式 |
|---|---|---|---|---|---|
| 判据 1 | `pnpm.cmd vitest run packages/server/evaluator/src/orchestrator-run-row.test.ts` | 60s 内自行退出 / `Test Files 1 passed` / `Tests 8 passed` | | | 自行退出 |
| 判据 2 | `pnpm.cmd vitest run packages/server/evaluator/src/judge-agent.test.ts` | 60s 内自行退出 / `Test Files 1 passed` / `Tests 19 passed` | | | 自行退出 |
| 判据 3a | `pnpm.cmd vitest run packages/server/evaluator` | 20 分钟内自行退出 / `Test Files` 总数 27 | | | 自行退出 |
| 判据 3b | `… --reporter=json --outputFile=…` 后读 `testResults.Count` | `27` | | | 自行退出 |
| 全量 | `pnpm.cmd test` | 不再挂死在收集阶段；**不承诺全绿** | | | 自行退出 |

## 4. 既存红登记

| 文件:用例 | 红的样子 | 分类（回归 / 既存 / 机器慢） | 依据 |
|---|---|---|---|
| | | | |

（没有红就写「无」；**分类必须有依据**：回归 = 与本次改动相关；既存 = 该文件在门禁里从未执行过、
与 `@aieval/agents` 那条 import 无关；机器慢 = `tests` 累积项比上次大 2 倍以上。）
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/notes/2026-10-06-evaluator-collect-deadlock-fix-probe.md
git commit -m "docs(evaluator): 登记收集死锁修复后的判据读数与既存红三分类"
```
