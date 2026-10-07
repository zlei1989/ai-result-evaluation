# 三条工作线的交接（2026-10-07）

> 用途：本会话（三条工作线）的**压缩交接**。新会话要续跑时，从本文的「下一条线」一节起步即可；
> 每条线的完整裁决与证据在各线的 ledger 里（`.superpowers/sdd/<线名>/progress.md`）。

## 1. 思考强度：未选不关闭 + 显式关闭 —— 已收尾

**口径**：未选 ⇒ dsh 走缺省 `high`、claude / codex 不传（由厂商推断）；显式选 `off` ⇒ 各家翻成厂商词汇
（dsh `off` / claude `thinking:{type:'disabled'}` / codex `none`）。**未选 ≠ 关闭**。

**真机结论**（`off` 行 vs 未选对照行）：

| 家 | `off` 行 | 对照行 | 状态 |
|---|---|---|---|
| **dsh** | 0 思考块 | 113+62 块 | ✅ 本来就有效（run `f2cd60be`） |
| **claude** | **0 思考块**（主+子，三套口径全 0） | 1 / 0（敏感口径 3+3） | ✅ **已修**（run `78ef5b58`） |
| **codex** | **28 条 reasoning**（28,169 字、网关自述 7,347 tokens） | 13 条 | ❌ **修过但真机未生效** |

- **claude 的修法**：spawn CLI 时注入 `CLAUDE_CODE_EXTRA_BODY='{"thinking":{"type":"disabled"}}'`（**只在 `off` 档**）。根因是 CLI 的**模型能力门**（它不认识我们的模型名 ⇒ 故意不写 `thinking` 字段）。附带：该覆盖层**对子智能体也生效**。
- **codex 的修法**：给 CLI config 加 `model_reasoning_summary: 'none'`（**只在 `off` 档**，实参在**第三**位、不许挤掉 `contextWindow`）。它避开的是「CLI 硬编码的 `include` **∧** `summary:"auto"` 同时存在 ⇒ 网关无视 `effort:"none"`」。**但真机上 `turn_context` 直证 `effort="none"` ∧ `summary="none"`（主 + 子线程）⇒ 参数确已到 CLI，是网关照样推理** ⇒ 极简 prompt 上的「0」（stepF）**不外推到 agentic 长链路**。

**规格与记录**：`docs/superpowers/specs/2026-10-06-effort-default-and-explicit-off-design.md`（已含**两轮**真机更正）、`…-effort-off-really-disables-thinking-design.md`（本线设计）、冒烟记录 `docs/superpowers/notes/2026-10-06-effort-off-really-disables-thinking-smoke.md`；ledger `.superpowers/sdd/2026-10-06-effort-off-really-disables-thinking/progress.md`。

**登记的残留（都属于"可以留"）**：
- T3 一条**覆盖边界**：spec 里「读**合并后**的 env」这句注释级硬约束**没有用例钉住**（存活变异「改读裸 `process.env`」六条全绿；两写法今日**行为等价** ⇒ 不是漏判）。
- **界面/API 视图的思考块少于模型真实产出**（同一行真实 4 条主线程思考、API 只回 1 条）—— **既存、非这两条线引入** ⇒ 建议**单开一项**。
- **codex 要不要往网关侧继续追**（换关闭表达 / 动网关）⇒ 明确标为**下一次裁定**。

## 2. evaluator 测试收集死锁 —— 已修

**根因**：`vi.mock` 工厂的动态 `import()` 链**重入一个「正在求值中」的模块** ⇒ vite ModuleRunner 的 await 环，**永不 settle、无报错、无超时、零 CPU** ⇒ evaluator **19/27 个测试文件永不开始**（`pnpm test` 整个不可用）。

**修法**（3 处源码改动，共 +496 行，全在 `packages/server/evaluator/src/`）：
1. 断开 `testing/fixtures.ts` 到 `@aieval/agents` 的**唯一值成员**那条运行时边（改为等价的 **17 格字面量**）；
2. 加 **AST 结构守卫**（工厂目标的静态可达闭包 + 4 项被 mock 模块的登记表绊线 + 正负样本表）；
3. 修 `testing/orchestrator-seams.ts` 那句**假前提**注释。

**验证（双向 + 重复测量）**：修前 `orchestrator-run-row` **62.4s 不退出**（仅 `RUN` 头、31.3s 内 CPU 增量 0.09s）⇒ 修后 **7.66s 自行退出**；变异把边造回去 ⇒ **60.01s 重新卡死**，还原后哈希逐字相同；整包收集判据 **5/5 恒为 27**；**全量 213 文件 142s 跑完并自行退出**（2694 用例、`AssertionError` 仅 1 条已登记软断言）。

**ledger**：`.superpowers/sdd/2026-10-06-evaluator-collect-deadlock-fix/progress.md`（含全部裁决与两处覆盖边界）。

## 3. 下一条线（建议）：清理期 EPERM

**现象**：`packages/server/evaluator/src/testing/fixtures.ts:97` 的 `cleanup` 在删临时目录时抛 `EPERM`（目录被 git 子进程的 cwd 句柄锁住）⇒ 用例红。它是本包**唯一**让门禁变红的机制。

**已实测的关键事实**：
- **Node v26.7.0 的 rimraf 不把 `EPERM` 计入重试** ⇒ `maxRetries: 40` **形同虚设**（0ms 就抛；真重试至少 600ms）。子进程死后立刻可删。
- `%TEMP%` 残留**持续累积**：`aieval-evaluator-*` **424 个**（315 → 367 → 424）、`aieval-route-cases-*` **255 个**；同形态在**另一个包**（web-next 的 `route-cases.test.ts`）也有 9 条 ⇒ 与 evaluator 无关的独立证据。
- 修完预期：`pnpm test` 的红从 **13 个文件**降到 **4 个有既往记录**的（`@aieval/ui` 的 localStorage 12+2、agents 的软断言 1）⇒ 门禁才真正可用。
- **判读口径（本会话已用）**：`失败条数 == 清理期 EPERM 条数` **且 `AssertionError == 0`**（两者缺一不可；用 `AssertionError` 那一半才能把清理期 flake 与真红分开）。

**可考虑的修法（尚未评估，按代价从低到高）**：① 在清理处自己写退避重试（判据：`EPERM`/`EBUSY` 不在 Node 的 `retryErrorCodes` 白名单里 ⇒ 要手动重试）；② 改用 promise 版 `fs.rm`（Node 的 `maxRetries` 语义只覆盖部分 errno）；③ 把清理移出被测进程（例如交给一个收尾钩子）；④ 清掉存量残留并给残留加个上限守卫。

### 3.1 诊断 spike 已做（2026-10-07）→ **修法确定为「自写有界重试」**

**根因链（带 `file:line`）**：`orchestrator-harness.ts:214`(beforeEach) → `fixtures.ts:79` `mkdtempSync(%TEMP%/aieval-evaluator-*)` = 临时根；
用例体走 `orchestrator.ts:1147` `prepareRowWorkspace` → `core/workspace.ts:150` `ensureCaseCache`（`git.ts` 的 clone/fetch/reset/cat-file/rev-parse）与 `:171` `checkoutRow`（`git.ts:492`），行内最后一次 git 是 `orchestrator.ts:1382` `collectDiff`（`git.ts:559/561/568/570`）。
**它们全都走唯一入口** `packages/server/core/src/git-exec.ts:26-27` 的 `execFileSync('git', […], { cwd: dir })`，而 cwd 分别是 `{root}/runs/cases/<id>`（`workspace.ts:30-32`）与 `{root}/runs/<run>/rows/<row>/workspace`（`workspace.ts:45-47`）—— **全在临时根里**。
⇒ `orchestrator-harness.ts:227-233` afterEach → `fixtures.ts:88-97` `home.cleanup()` → `:97` `rmSync` 撞上**刚退出的 git 进程**（Windows 上句柄释放晚于 `execFileSync` 返回几 ms）。实测几何：子进程 cwd = 根的孙目录时删根 ⇒ **EPERM 3ms**；子进程一死立刻 ok。

**`maxRetries` 为什么无效（实测证据）**：白名单**只存在于异步路径** —— `node --expose-internals` 读 `internal/fs/rimraf` 得 `retryErrorCodes = ['EBUSY','EMFILE','ENFILE','ENOTEMPTY','EPERM']`（退避线性），而 `fs.rmSync` **直接下沉 C++**：`binding.rmSync(path, maxRetries, recursive, retryDelay)`。
⇒ 同步 (40,100) 对活锁 **1ms 抛**；同场景异步 `fs.rm`(40,100) **631ms 内自愈**。**`fixtures.ts:95` 那句「口径与 mirror-harness 一致」是错的**；`mirror-harness.ts:222-243` 恰因「1ms 就抛、一次都没重试」才自写 10×200ms + **只 WARN**。

**修法评估（结论）**：
- **① 自写有界重试 ★★★★★（推荐）**：~10 行（`fixtures.ts:97` + `sleepSync` = `Atomics.wait`，同款见 `mirror-harness.ts:241`）；实测竞态窗口只有几 ms（+100ms 的重试必成功）⇒ 白名单 `EPERM/EBUSY/EACCES/ENOTEMPTY` + **10×200ms** + **超限只 WARN 不抛**。风险低。
  ⚠️ **同一误用全仓还有约 12 处** `rmSync(…, maxRetries:…)` **全是 no-op**（`git-repo-harness.ts:130`、`route-cases.test.ts:85`、各 `route-*.test.ts` 等）—— `route-cases` 那 262 个残留就是其中之一 ⇒ **值得与本条一起修**。
- **② promise `fs.rm` ★★★☆☆**：能解决（EPERM 在白名单、实测自愈），但要把 `cleanup: () => void` 变 async（`fixtures.ts:67` + `events.test.ts:26`、`orchestrator-live.test.ts:205`、`run-delete.test.ts:74`、`orchestrator-harness.ts:231` 四处 await）；且线性退避最坏 ≈ **82s/条**，必须重调成 (10,100)≈5.5s ⇒ 写错预算会拖爆 `testTimeout`。
- **③ 源头解锁 ★★☆☆☆**：**`-C` 变体已被实测否掉**（`-C` 会 chdir 进去 ⇒ 仍 EPERM）；真不 chdir 的是 `--git-dir/--work-tree`（探针里 git **活着**时删根 ok 3ms），但全仓要逐点改每个调用点（`isGitRepo`/`resolveRepoInfo` 是探测语义、bare 镜像无 work tree），且**任何 git 退出后立刻删都会 EPERM**（clone 5/10、status 7/10、diff 9/10）⇒ 只改 clone 无用；还要覆盖 agent CLI 的 cwd（`workspace.ts:156` 的 `clearRowArtifacts` / `deleteRun` 同样曝露）⇒ **建议另立项**。
- **④ 移出进程 / 清残留 ★★★☆☆**：**换进程不解决锁**（锁与进程无关、换谁删都 EPERM），只把「红」变成「没人看见」，还多付一次进程创建（本机 ~160ms/次）；**清残留值得做**（现存 `aieval-evaluator-*` **459**、`aieval-route-cases-*` **262**，今天 04:0x 一批就留了 37 个），但必须用 `AGENTS.md` 的 `Assert-Deletable` + 只碰 `%TEMP%\aieval-*` + **年龄 > 1 天**过滤（避开正在跑的会话）。

**最小判别实验（一条命令级，尚未执行）**：`node %TEMP%\dsh-rimraf-probe\judge-cleanup.mjs`（~10s、单文件、不改仓库）。每轮：根里跑一次真 git → **架证人**（`spawn('git',['hash-object','--stdin'],{cwd:<根内目录>,…})` 挂住 stdin 且 `exitCode===null`）→ 调候选 cleanup。三条必须**同时**成立：
① 证人活着时**必须返回失败/WARN**（返回 ok = 吞错掩盖；10 轮静默 ok 必须为 0）；② 放掉证人后再调**必须 ok 且 `retries>=1`**、耗时落在第 1 次退避与 2s 之间（= 等的是真锁，不是走运）；③ 无证人时 ok、`retries===0`、<20ms（= 没有固定 sleep）。
**阳性对照**：今天的 `rmSync(root,{recursive:true,force:true,maxRetries:40,retryDelay:100})` 用同一脚本跑**必须在 ① 里抛 EPERM** —— 否则该实验没有区分力。

**未能查清**：具体是哪一次 git 调用当的凶手（每次运行不同；只确认「任何 git 命令退出后立刻删都会 5–9/10 失败」，锁的持有者是**刚退出的直接子进程**）；残留数与 EPERM 次数的严格对应（459/262 里混着 Ctrl-C、超时被杀、WARN 放行）；`--git-dir/--work-tree` 全量改造对 bare 镜像与 `isGitRepo` 探测语义的逐命令等价性。

## 4. 本会话确立的流程教训（值得留档）

- **共享分支上，review package 的 BASE 一律取实现者提交的 `^`** —— 本会话三次命中（别人的提交会插进来，其中一次混进 3 个提交 / 19 个文件）；收尾改用**逐提交 `git show` 拼接**的 diff，`MERGE_BASE..HEAD` 不可用（按路径过滤也不安全）。
- **跨文件的行号引用会互相顶过期** ⇒ 新注释按**形态文本**指认、不写行号；已有引用用「平移后行号 + 括注旧号」。
- **经共享常量读键的断言，在"键名写错"时不会红**（实现与断言一起错）⇒ 键名判据要用**字面量**。本会话在两条线上各抓出一次（其中一次还实测复现了"缺陷曾存活"）。
- **变异靶子要先验真**：本会话有 3 处 brief/plan 的变异判据被实现者**实测推翻**，其中一处"缺陷"在 SDK 层其实**行为等价**（`undefined` 值的 config 键根本不外发）。
- **子代理可能"做完不报告"就结束** ⇒ 派完要在合理间隔主动核对（`list_agents` + `git status`），不要只等通知。
- **一次真实反例胜过一条前提登记**：codex 的「极简 prompt 上 0」被真机长链路推翻 ⇒ 前提登记里要写「链路形态」这一格。
