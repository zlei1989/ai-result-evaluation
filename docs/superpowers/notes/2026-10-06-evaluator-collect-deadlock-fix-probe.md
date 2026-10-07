# evaluator 收集死锁修复：探针与判据读数

> 计划：`docs/superpowers/plans/2026-10-06-evaluator-collect-deadlock-fix.md`
> spec：`docs/superpowers/specs/2026-10-06-evaluator-collect-deadlock-fix-design.md`
> 机器：本机（vitest 4.1.11 + vite 8.3.0）。

## 1. 修前基线

| # | 命令 | 期望（spec） | 实测 | 墙钟 | 退出方式 |
|---|---|---|---|---|---|
| 判据 4 | `pnpm.cmd vitest run packages/server/evaluator/src/judge.test.ts` | ≈3.4s / `Test Files 1 passed` / `Tests 27 passed` | `Test Files  1 passed (1)` / `Tests  27 passed (27)` / exit code **0**（两次读数一致：3.33s 与 3.87s） | 3.33s | 自行退出 |
| 探针 1 | `pnpm.cmd vitest run packages/server/evaluator/src/run-delete.test.ts` | 60s 内自行退出（判读规则见 spec §5.4） | **也卡**：60s 后 `exited: False`；`probe1.out` **只有 `RUN` 头**（无任何用例行、无汇总行）；树内 node 进程 60s 内 CPU 累计仅 0.6s | 60s 未退出 | 手工中断（`taskkill /PID 25516 /T /F`） |
| 判据 1（修前） | `pnpm.cmd vitest run packages/server/evaluator/src/orchestrator-run-row.test.ts` | **卡死**：60s 零输出、不退出 | **卡死**：62.4s 后 `exited: False`；`probe2.out` 共 **3 行**（空行 + `RUN v4.1.11 …` + 空行），无任何用例行与汇总行；**零 CPU 实证**：t=20s 与 t=51.3s 两次采样子树，31.3s 窗口内三个 node 的 CPU 增量分别为 **+0 / +0.094s / +0.094s** | 62.4s 未退出 | 手工中断（`taskkill /PID 28748 /T /F`） |

> 取证口径（T1 记录）：三条都用 `Start-Process -PassThru` 起进程、先打印并落盘自己的 PID，等满 60s 再判读，只 `taskkill /PID <自己那个> /T /F` 收自己那棵树；收树后核对 `node` 进程清单，别人的进程一个都没碰（两次 `taskkill` 的输出逐条列出了被终止的 PID，全部落在自己的树内）。
> 需要 exit code 的读数（判据 4、判据 1/2 的修后）用 `cmd.exe /v:on /c "pnpm.cmd … & echo AIEVAL_EXITCODE=!errorlevel!"` 包裹：本机 `Start-Process -PassThru` 的对象在 `WaitForExit(ms)` 之后读不到 `ExitCode`（连 `cmd /c exit 7` 都读成空，只有 `-Wait` 能读到）。
> ⚠️ **不要写成 `%errorlevel%`**：`cmd /c "A & echo %errorlevel%"` 的整行在 `A` 执行前就被解析，`%errorlevel%` 展开成**进入时的旧值**——实测 `pnpm typecheck` 明明打印 `[ELIFECYCLE] Command failed with exit code 2` 却回显 `AIEVAL_EXITCODE=0`。必须开延迟展开（`/v:on` + `!errorlevel!`，已用 `cmd /c exit 7` 验证回显 7）。
> 两次挂死取证（探针 1、判据 1 修前、变异 1）**没有**用这个包裹，与 brief 的原始形态逐字一致。

### 探针 1 的判读（spec §5.4）

探针 1 实测结论：**也卡** ⇒ 照抄判读规则：`也卡 ⇒ §1.3 的三条共同点不是充分条件`（**不许**因此改守卫的判据集合；守卫按 spec §4.2 的 4 项落地）。

现状细节（供回填 spec §5.3 待观察项与 §7 未验清单的人用）：`run-delete.test.ts` **同时**具备共同点 ①（`:39` 以 `./testing/orchestrator-seams` 为工厂体的 `vi.mock('@aieval/agents')`）与 ③（`:17` 静态 import `./testing/fixtures`），因此它**不应该**在「正常」那一侧——实测却与 19 个挂死文件同症状。⇒ 按 spec §5.4 的规则，这条观察只回填「未验项」，**不扩** §4.2 的判据集合。
（回填 spec §2/§7 与 §5.3 待观察项的动作**不在 T1**：本 Task 只登记读数，spec/plan 由控制者落。）

### 探针 1 的修后对照（T1 追加，非 brief 点名步骤）

| 命令 | 读数 | 墙钟 | exit | 结论 |
|---|---|---|---|---|
| `pnpm.cmd vitest run packages/server/evaluator/src/run-delete.test.ts` | `Test Files  1 passed (1)` / `Tests  5 passed (5)` | 8.23s 自行退出 | **0** | 同一条修复**同时解开**了探针 1 那个文件 |

⇒ spec §5.3 的待观察项（「`run-delete.test.ts` 若也卡，三条共同点的充分性要重估」）在**修后**这一侧是无歧义的：它修前挂死、修后 8.23s 自行退出且 5 条全绿，**与 19 个挂死文件同源**，不是「另一条没写出来的条件」。

### 变异 1（spec §5.2 第 1 条）的读数（T1 追加）

- 变异体构造：`git checkout -- packages/server/evaluator/src/testing/fixtures.ts` ⇒ 与 HEAD **逐字相同**（`git diff --quiet` 退出码 0），两处缺陷形态就位（`:34 import {` + `:35 permissiveMessageCapability,`；`:581 messageCapability: permissiveMessageCapability(),`），变异体哈希 `A0167907A44487DEF692E0A78E969D6498714FF2C183F3E0CF87056EC540EE17`。
- 跑判据 1：**60.01s 后 `exited: False`**；`aieval-mutation1.out` 共 **3 行**（仅 `RUN` 头），零用例行、零汇总行 ⇒ **边回来了就重新卡死**。收树 `taskkill /PID 24516 /T /F`（输出列的 7 个 PID 全在自树内）。
- 还原：把修复版逐字拷回 ⇒ 哈希 `66126DD89AF18A32E27B7C738716285CC2EF600C896AE40BE4245B0577A45986`，**与变异前基线逐字相同**（`True`）；还原后重跑判据 1 = 8.18s 自行退出。
- ⇒ **「边没了才通」+「边回来了就死」双向闭合**，这条边就是闭合边。

> ⚠️ **哈希基线在 T3 之后已经变了（T4 补记）**：上面那个 `66126DD8…` 是 **T1 提交（`420736f`）当时**的基线，
> 只适用于那之前。T3 收口（`55e2690`）改了 `fixtures.ts` 的**两行注释**（`:36` 的 `orchestrator-seams.ts:22` → `:36`（T3 前 `:22`）），
> 文件因此多了 5 字节 ⇒ **现行基线是 `BDEAB2A0C15B30F5B021EB7C1B74A1F61CD68182AA14142F1FA5B6B97DAF5CAC`**（51454 字节）。
> 本 notes 与 T4 报告里凡引用「逐字相同 / 基线未变」的判据，一律以**新**基线为准。
> 三个版本的字节级 SHA256（`git cat-file blob` 原样落盘后 `Get-FileHash`，非 `git show` 管道——后者会带 BOM 并把 LF 转成 CRLF，值不可比）：
>
> | 版本 | SHA256 | 字节 |
> |---|---|---|
> | `420736f^`（T1 之前，= 变异体） | `A0167907A44487DEF692E0A78E969D6498714FF2C183F3E0CF87056EC540EE17` | 48839 |
> | `420736f`（T1 修复版，= 上文旧基线） | `66126DD89AF18A32E27B7C738716285CC2EF600C896AE40BE4245B0577A45986` | 51449 |
> | `55e2690` = `HEAD` = 工作区（**现行基线**） | `BDEAB2A0C15B30F5B021EB7C1B74A1F61CD68182AA14142F1FA5B6B97DAF5CAC` | 51454 |

### 判据 1 / 判据 2 的修后读数，与「清理期 EPERM」既存红（spec §5.3 口径登记）

**判据 2（`judge-agent.test.ts`）**：3s 自行退出 / `Test Files  1 passed (1)` / `Tests  19 passed (19)` / exit **0** ⇒ **完整通过**。

**判据 1（`orchestrator-run-row.test.ts`）**：进程**每次都自行退出**（挂死判据解除）、用例数**非 0**（8 条全部执行），但**汇总行是 `failed`**：

| 次序 | 墙钟 | 汇总 | exit | stderr 里 `EPERM` 计数 | 失败条数 |
|---|---|---|---|---|---|
| 修后第 1 次 | 7.66s | `Tests  8 failed (8)` | 1 | 8 | 8 |
| 修后第 2 次 | 7.06s | `Tests  6 failed | 2 passed (8)` | 1 | 6 | 6 |
| 变异还原后 | 8.18s | `Tests  3 failed | 5 passed (8)` | 1 | 3 | 3 |

⇒ **失败条数恒等于 `EPERM` 计数，没有一条是断言失败**；通过条数 0/2/5 每次不同 ⇒ **非确定性竞态**，与用例语义无关。8 条红的报错逐条都是同一句：`Error: EPERM, Permission denied: \\?\C:\Users\…\Temp\aieval-evaluator-xxxx`，栈落在 **`fixtures.ts:97`**（`createTempHome().cleanup` 的 `rmSync`）⇒ `orchestrator-harness.ts:231`。

**交叉对照（同批此前挂死的另一个文件）**：`orchestrator-messages.test.ts` 修后 5.02s 自行退出 / `3 failed | 1 passed (4)` / `EPERM` 计数 3 ⇒ 同一形态（失败数 = EPERM 数），说明不是 run-row 独有。

**机制（两条本机实测，不依赖仓库代码）**：

1. 纯 Node 探针（临时目录被一个子进程当 cwd）：`rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })` 抛**同一个** `EPERM, Permission denied: \\?\…`，**耗时 1ms**；子进程被杀之后再删即成功。⇒ Node **v26.7.0** 的 `internal/fs/rimraf` 判据是 `retryErrorCodes.has(err.code)`，而 **EPERM 不在其中** ⇒ `fixtures.ts:97` 的 `maxRetries: 40, retryDelay: 100`（其上方 `:90-96` 的注释正是为这类 EPERM 加的）**对该 errno 形同虚设**，重试一次都不会发生。
2. `%TEMP%` 下 `aieval-evaluator-*` 残留**共 315 个**，日期自 **2026-10-02** 起（早于本次修复 5 天）⇒ 该清理失败是**长期既存**现象，不是本次冒出来的。

**归属（三条，判为与本次改动无关）**：① 报错行 `fixtures.ts:97` 本次**一字未动**（本次的真实增删区间只有两处：import 那条语句 `:34-56`、`messageCapability` 字面量与它的 JSDoc `:591-624`——见 `git show --unified=0`）；② `messageCapability` 在 evaluator 全包只出现一次、且**编排层不读它**（spec §6.1）⇒ 这份字面量不可能影响 git 子进程与 `rmdir`；③ 同文件三次跑出 0/2/5 条通过（竞态）+ 机制在**纯 Node** 下即可复现。

**三分类**：**既存 + 环境（机器带负载）**，**不是回归**。按 spec §5.3「本次修复里不顺手修（不扩环）」登记，T1 不动它。
⚠️ 给 T4 的判读口径建议：整包/全量跑时**用「该文件的失败条数是否等于 stderr 里 `EPERM` 的条数」来把「清理期 flake」与「真红」分开**；`fixtures.ts:97` 对 EPERM 不重试这一条若要修，应作为**独立的一条线**（本线不扩环）。

### 探针 2（spec §5.4 第 2 条）：未触发

- 触发条件是「判据 1 **仍卡**」；判据 1 修后 **7.66s 自行退出、8 条用例全部执行**（收集期挂死的判据已解除）⇒ **未触发**：spec §6.3 的 `vi.importActual` 与 §6.2 的 workspace 软链装载路径都**不追**，`fixtures.ts:846`（T1 之前的编号是 `:803`）的 `vi.importActual` 一字未动。
- 附注（防止误读）：判据 1 的汇总行是 `failed`，但红因 100% 是**清理期 EPERM 既存 flake**（见上表），**不是**收集期挂死，故不构成「仍卡」。

## 2. 已知边界

本节登记本修复**有意不覆盖**的形态与**未验**项（与 spec §7 的未验清单同源）：下面两条都**不是**「守卫失效」，也不许据此扩 §4.2 的判据集合。

### 3b：守卫**看不见**的形态（登记，不作为变异）

形态：在夹具里用 `vi.importActual('@aieval/agents')` **现取** `permissiveMessageCapability` 来填 `messageCapability` 那一格。
按 §4.4 的判据它是**放行**的 —— 这是**有意留的覆盖边界**，**不许**当成「守卫失效」。

**为什么没有按字面执行这条变异**：spec §5.2 把落点写成 `makeFakeProvider()`，而
`fixtures.ts:574`（T1 之前的编号是 `:562`）的 `function makeFakeProvider(kind: AgentKind): AgentProvider` 是**同步**函数，
`vi.importActual` 返回 Promise ⇒ 这个字面形态**不可直接实现**（要真做，得由异步的 mock 工厂先把值
存到一个模块级变量、再让同步的 `makeFakeProvider` 去读，那是另一套机械、且它测的是「守卫看不见什么」
而不是本次要守的东西）。spec 自己把这一条标为「登记，不作为变异」，故本计划只登记。

### 未验的观察（spec §6.2 / §6.3，本计划不主张结论）

- §6.2：`d-bare`（**裸包说明符**版本）因探针的 junction 穿不过 workspace 软链**没验成** ⇒ 若判据 1 仍卡，
  回去查 workspace 软链的装载路径（Task 1 Step 11 的探针 2）。
- §6.3：`fixtures.ts:846`（T1 之前的编号是 `:803`）在 `fakeAgentsModule()` 里对**同一个模块 id** 有一次运行时触碰（走 mock 的
  旁路 API、读的是真模块）。它不在被追到的那条边上，且在当前挂死路径上根本不会执行（在函数体内，
  晚于那条静态边），但**没有被排除**。
- 变体覆盖：`--pool` 的其它取值、**非 Windows**、**vitest 5 / vite 7** 均**未验**（本机是 vitest 4.1.11
  + vite 8.3.0；spec §2.3 引的 `module-runner.js` 行号只对应这份安装）。

## 3. 修后判据

| # | 命令 | 期望（spec） | 实测 | 墙钟 | 退出方式 |
|---|---|---|---|---|---|
| 判据 1 | `pnpm.cmd vitest run packages/server/evaluator/src/orchestrator-run-row.test.ts` | 60s 内自行退出 / `Test Files 1 passed` / `Tests 8 passed` | `Test Files  1 failed (1)` / `Tests  6 failed \| 2 passed (8)` / exit **1**。**8 条用例全部执行**（挂死判据解除）；6 条红**逐条**都是清理期 `EPERM`（栈落 `fixtures.ts:97`），`AssertionError` **0** ⇒ 与 T1 同形（T1 三次读数 8/6/3 条红，通过数 0/2/5 每次不同） | 5.79s | 自行退出 |
| 判据 2 | `pnpm.cmd vitest run packages/server/evaluator/src/judge-agent.test.ts` | 60s 内自行退出 / `Test Files 1 passed` / `Tests 19 passed` | `Test Files  1 passed (1)` / `Tests  19 passed (19)` / exit **0** ⇒ **与期望逐字相符** | 2.24s | 自行退出 |
| 判据 3a | `pnpm.cmd vitest run packages/server/evaluator` | 20 分钟内自行退出 / `Test Files` 总数 27 | `Test Files  5 failed \| 22 passed (27)` / `Tests  5 failed \| 251 passed (256)` ⇒ **总数 27** ✓（判的是「27 个文件都能被收集」，不是全绿）。5 条红里 **4 条纯清理期 `EPERM`** + **1 条断言红**（`orchestrator-execution-mode-b.test.ts`，见 §4） | 21.22s（vitest 自报 Duration 19.31s） | 自行退出 |
| 判据 3b | `… --reporter=json --outputFile=…` 后读 `testResults.Count` | `27` | `testResults.Count = **27**` ✓；且 **27 条全部带 `startTime`**。同一产物：`numTotalTests 256` / `numPassedTests 249` / `numFailedTests **7**`，其中 7 条**全是**清理期 `EPERM`、`AssertionError` **0** ⇒ 这一次的读数是**纯 flake** | 20.76s | 自行退出 |
| 全量 | `pnpm.cmd test` | 不再挂死在收集阶段；**不承诺全绿** | `Test Files  13 failed \| 200 passed (213)` / `Tests  32 failed \| 2662 passed (2694)` ⇒ **213 个文件全部跑完并自行退出**，收集期挂死消失。13 条红**逐条登记见 §4**，其中 **0 条判为回归**——⚠️ 措辞限定见 §4.3：这条「0」**只对归属已闭合的 12 条成立**，第 13 条（`execution-mode-b` 的断言 flake）**归属未闭合**。⚠️ **本次全量是在机器「非安静」状态下跑的**（常驻 dev server + 一个活着的 codex 评测子进程，见下节负载事实）——额度按控制者裁决不补跑 | 150.12s（vitest 自报 Duration 147.70s） | 自行退出 |

> **判据 3b 的加强读法**：spec §5.1 判据 3 ③ 只要求「19 个目标文件都被执行过」。本轮的判据是「**json 产物生成 + `testResults.Count === 27` + 27 条**每条**都有 `startTime`**」——三者同时成立才排除「文件被收集却一个用例都没跑」那种**静默**形态（挂死时 json 产物根本不生成，见 spec §5.1）。实测 27 条 `startTime` 缺失数为 **0**。
>
> **判据 3a 与 3b 的红集合每次不同**（3a：5 红含 1 条断言；3b：7 红全 EPERM），这本身就是清理期 flake 的判据之一，不是两次修复效果不一致。
>
> **判据 3a ↔ 全量的差集（T4 补记：三处红集合两两不同）**：
> · **全量新出现、3a 里没有的**：`orchestrator-abort` / `auto-retry` / `judge-route` / `run-delete` 各 1 条 + `orchestrator-messages`（**文件级**）——**全部是清理期 `EPERM`**，一条断言红都没有；
> · **3a 独有、全量里反而全绿的**：`orchestrator-timeout-isolation.test.ts`（3a 里 1 条清理期 `EPERM`；全量里 `✓ 5 tests passed`）；
> · **3a 与全量都红的**：`remote-source` / `live` / `rescore` / `execution-mode-b`（最后这个只在 3a 那一次带断言，见 §4 末条）。
>   ⚠️ **不能写成「三次都红」**：3b（`collect.json`）那一跑里 **`execution-mode-b` 是 `2 passed` 全绿**、**`remote-source` 也没红** —— 3b 的红**只有三个文件**：`orchestrator-execution-mode` / `live` / `rescore`。三个集合两两不同，这恰恰就是本段要说的那件事。
> ⇒ 两两差集**全是清理期 `EPERM` 的随机落点**，这是「红集合每次不同」那条判据的强化，不是修复效果在三次之间变化。

> ✅ **退出码的取得方式：§1 的口径有效 —— T4 首次那条「修正」是错的，已撤回。**
> §1 记的 `cmd.exe /v:on /c "pnpm.cmd … & echo AIEVAL_EXITCODE=!errorlevel!"` **是对的**，T1/T2/T3 的退出码读数**无需打折扣**。T4 的双向实测（`probe` 系列）：
>
> | 形态 | 实测输出 | 结论 |
> |---|---|---|
> | `cmd /v:on /c "pnpm.cmd --version & echo AIEVAL_EXITCODE=!errorlevel!"` | `11.18.0` + `AIEVAL_EXITCODE=0` | 命令**行**形态：pnpm.cmd 返回后 `&` 继续 ⇒ **有效** |
> | 同形态、命令失败 | `AIEVAL_EXITCODE=1` | 失败也有效 |
> | `… "pnpm.cmd exec node exit2.js & echo …!errorlevel!"` | `AIEVAL_EXITCODE=2` | **码值保真**（没有被压成 1） |
> | **批处理文件内** `pnpm.cmd --version`（**不带 `call`**） | 只有 `LINE1 \| 11.18.0`，**LINE3 / LINE4 都不执行** | ⚠️ 这才是「后置行消失」的真因 |
> | **批处理文件内** `call pnpm.cmd --version` | `LINE1 \| 11.18.0 \| LINE3_AFTER_PNPM=0 \| LINE4` | 加 `call` 即恢复 ⇒ 变量是 **`call`**，**不是** pnpm |
>
> ⇒ 真机制是 **cmd 的批处理链接语义**：**在 `.cmd` 脚本内部不带 `call` 直接调用另一个 `.cmd`（`pnpm.cmd` 就是一个），控制权会转移到被调脚本而不再返回**，于是该脚本在那一行之后**退场**，后续行自然不执行。命令行 `cmd /c "… & echo !errorlevel!"` 形态**不受影响**（`&` 的右半边由同一命令行继续解析执行）。
> T4 首次之所以误判成「`pnpm.cmd` 自己的行为」，是因为探针用了**批处理文件**形态、而对照组 `cmd /c exit 7` **不是批处理调用** —— **没有控住 `call` 这个变量**。
> ⇒ 本节判据 1 / 判据 2 的 exit code（由 PowerShell `& pnpm.cmd … ; $LASTEXITCODE` 取得）成立；判据 3a / 3b / 全量的**字面**退出码本轮**仍缺**（那三次是用**批处理文件**起的，后置行没跑到），只由汇总行 `[ELIFECYCLE] Test failed` 判为**非 0**。§5 的 4 轮整包复跑已改用**命令行一行形态**并把 `AIEVAL_EXITCODE` **落盘**，四轮全部取到 `exit=1` —— 既有形态有效性的现场复核。

### T4 记录的负载与环境事实（读上表时必须一并读）

- ⚠️ **任务书点名的那个负载源，在 T4 开跑时已经不存在**：所谓「别人起的僵死 vitest 进程树（`pnpm.mjs vitest run orchestrator-`，10+ 分钟、零 CPU、515MB）」——本机**扫遍全部进程的 `CommandLine`，无任何 `vitest` 命中**（唯一命中是我自己那条 pwsh 命令本身）。⇒ 「恒定负载源」这条前提**已过期**，不可照抄进结论。
- **实际负载源（三者都常驻，且我无权终止）**：① `pnpm dev` → `next dev -p 3083` 整棵树（`next-server` RSS **2.1GB**，实测 **CPU 0%**）；② 一个**活着的** `codex.exe` 评测子进程（挂在 3083 那棵树下面，就是界面上的 run `8df6ff65…`；采样时 0% CPU，但在等 LLM、**随时可能醒过来 spawn 进程**）；③ DSH 的 Playwright MCP + Edge + 页面取元素 helper。
- **全机 CPU 实测 ≈ 16 逻辑核里的 4%**：6s 窗口内**全部**进程的 CPU 增量合计约 3.9s，其中最大的两项是 DSH 自己的界面进程（renderer 22% + gpu 17% 单核比）。⇒ 机器**并没有**被这条负载压住（`Win32_Processor.LoadPercentage` 那个瞬时值 50/65 与逐进程增量对不上，以后者为准）。
- `%TEMP%\aieval-evaluator-*` 残留 **367 个**（T1 记录 315 ⇒ 又 +52）⇒ 清理失败不但长期既存，还**仍在累积**。
- ✅ **「机器慢」这一支在本轮不成立**，依据两条，**更硬的是第 ② 条**：
  - ① **数量级**：全量 `tests` 累积 **770.88s**，记录基线是安静时 **2604s** / 带负载时 **8154s** ⇒ 本轮约 **0.30×**。⚠️ **但这个比值「不可横比」**：那对基线出自 `docs/superpowers/plans/2026-09-28-test-speedup.md:491`（**9 天前**，且当时套件构成与今天不同——同表记当时全量墙钟 ~225s / 699.6s），故它只能当**数量级**参考，不能当逐项判据。
  - ② **硬依据：全部产物里没有任何一条 `Test timed out`，也没有 `Hook timed out`**。逐份计数（Step 1 / Step 2 / 第 3 步全量 / §5 的 4 轮整包复跑 / 守卫的修后·变异·还原 3 份，共 **20 份** stdout+stderr）**全部为 0**。这一条才承重——本仓带负载假红的**签名就是它**：上面那张基线表自己记着「带负载那批 24 条红里 **23 条是 `Test timed out in 60000ms`**，另有 5 条 `Hook timed out`」。⇒ 一条超时都没有，说明本轮的红**不是**「机器慢」形态，而是清理期 `EPERM` 这种**与耗时无关**的 errno 竞态。

## 4. 既存红登记

全量 `pnpm test`：`Test Files  13 failed | 200 passed (213)`、`Tests  32 failed | 2662 passed (2694)`。
（12 个文件有逐用例失败数、合计 **12+9+2+1+8 = 32**，与汇总行**逐条对上**；第 13 个是**文件级**失败、不计入用例数。）

**归属的总判据（一条就够，先说这条）**：本线（T1–T3，`420736f~1..HEAD`）**只改了 6 个文件**——`static-assertions.test.ts`、`testing/fixtures.ts`、`testing/orchestrator-seams.ts` + 3 个 docs 文件。`git diff --stat 420736f~1..HEAD` 里 **`packages/client/ui`、`packages/server/agents`、`apps/web-next` 一个字节都没出现** ⇒ 这三个包/应用下的 **24 条红（4 个文件：ui `stored-preference` 12 + ui `list-detail-layout` 2 + agents `claude-code/index` 1 + web-next `route-cases` 9）在因果上不可能**由本线产生。（其余 8 条红在 `evaluator` 包内，逐条见下表与下面的口径。）

| 文件:用例 | 红的样子 | 分类（回归 / 既存 / 机器慢） | 依据 |
|---|---|---|---|
| evaluator 8 个文件各 1 条：`orchestrator-abort` / `auto-retry` / `execution-mode-b` / `judge-route` / `live` / `remote-source` / `rescore` / `run-delete` | `Error: EPERM, Permission denied: \\?\…\Temp\aieval-evaluator-XXXX`，栈顶统一是 `Object.cleanup fixtures.ts:97:7`；**它下面那一跳逐个不同**（T4 逐条核过）：其中 **6 条**是 `→ orchestrator-harness.ts:231:10`（`abort` / `auto-retry` / `execution-mode-b` / `judge-route` / `remote-source` / `rescore`），**`live` 是 `→ orchestrator-live.test.ts:205:8`**、**`run-delete` 是 `→ run-delete.test.ts:74:8`**（这两个文件各自在用例内调 `cleanup`，没走 harness 那一跳） | **既存 + 环境** | 失败条数 **8 == `fixtures.ts:97` 的 EPERM 条数 8**，`AssertionError` 0；本线在该文件只动了**注释与 import 的类型专用性**，`:97` 一字未动；T1 已证机制在**纯 Node** 探针下即可复现（EPERM 不在 Node v26.7.0 `rimraf` 的 `retryErrorCodes` 里）。**栈的第二跳不同不影响归属**：三条路径都终止在同一个 `fixtures.ts:97` 的 `rmSync` |
| evaluator `orchestrator-messages.test.ts`（**文件级**失败，0 条用例计入） | 整个文件 FAIL：`EPERM … aieval-orch-repo-template-zf5Vak`，栈 `orchestrator-harness.ts:210:25` | **既存 + 环境** | 同一 EPERM 家族，但落点是**模板仓库**临时目录（非逐用例目录）⇒ 清理/准备期的文件级失败；**Step 1 同一文件 4 条全绿** ⇒ 非确定性，不是稳定红 |
| ui `base/stored-preference.test.tsx`（**12/12 全红**） | `TypeError: Cannot read properties of undefined (reading 'getItem' / 'setItem' / 'clear' / 'removeItem')` | **既存（有既往记录）** | `notes/2026-10-03-drawer-width-unification-smoke.md:85` 已逐字登记：**Node v26.7.0 自带实验性 `localStorage` 全局**（未给 `--localstorage-file` ⇒ 它是 `undefined`）把 jsdom 那份**盖掉**了；条数 **12 与记录完全一致**；该文件依赖图只有 react + testing-library，与本线无关 |
| ui `base/list-detail-layout.test.tsx`（2/9） | 同上（`localStorage` undefined） | **既存（同一条既往记录）** | 同上；记录里也是 **2** |
| agents `providers/claude-code/index.test.ts`（1/44） | `AssertionError: expected '本机 tmpdir 不含 8.3 短名（C:\Users\Zlei1\AppData\Local\Temp），H1 的归一用例在此环境不可构造' to contain '~'`，锚点 `index.test.ts:191:10` | **既存（有既往记录）** | `notes/2026-10-05-claude-subagent-own-usage-smoke.md:273-278` 记的是**逐字同一形态**，并已判「**本机既有红，非本次**」；该用例的「环境不可构造」跳过路径本身写成 `expect.soft(…).toContain('~')`，而那段中文里**不含** `~` ⇒ **在该路径上必红**（要修应改为 `soft` 之外的登记方式，属独立一条线） |
| web-next `src/route-cases.test.ts`（9/19） | `EPERM … aieval-route-cases-XXXX` | **既存 + 环境** | `notes/2026-10-03-…:86` 已登记 `route-cases.test.ts` 的**同族** EPERM（当次 5 条，本次 9 条 ⇒ 条数随机，符合 flake）；落点是 `%TEMP%\aieval-route-cases-*`，与本线无关 |
| evaluator `orchestrator-execution-mode-b.test.ts` > `「开始」只跑未完成的行：已 judged 的行不重跑` | 一次性 `AssertionError: expected 3 to be 4 // Object.is equality`，锚点 `orchestrator-execution-mode-b.test.ts:79:37`（`expect(fakeAgents.calls.length).toBe(afterFirstRound + 1)`） | **既存（低概率 flake，归属未定）** ⚠️ | 该断言在**全部 13 次观测里只出现 1 次**：判据 3a **出现**；判据 3b **未出现**；全量**未出现**（全量里该文件只红在清理期 `EPERM`）；**命中工况的 4 轮整包复跑**（§5）**未出现**（第 1、4 轮该文件各 1 条红，但逐轮 json 显示**纯 `EPERM`**；第 2、3 轮全绿）；单文件重复 6 次**再未出现**（纯 `EPERM` 5 次 / 全绿 1 次，`AssertionError` 0）。⇒ 可判**非确定性**（命中工况命中率 **1/6**）。⚠️ **但不能判它「与在途改动无关」**：另有一会话正在改 `orchestrator.ts`（产品码，+90 行）与 `orchestrator-live.test.ts`（+50 行），而前者正是该文件被测的产品源；**我未获授权还原这两个文件**，故本轮**无法排除**「在途改动」这一支（见下条） |

**三分类汇总**：

- **回归：0 条（⚠️ 带一条限定，别读平）**。依据 = 上面那条总判据（本线 6 个文件，不触及 ui / agents / web-next）**加上全量 32 条的逐条闭合**：**15 条**有既往 notes 记录、**17 条**是清理期 `EPERM`，两边相加 = 32，没有剩余。
  ⚠️ **限定 —— 这条「0」管不到的那一条**：`orchestrator-execution-mode-b.test.ts:79` 的断言红**不在全量这 32 条里**（全量里该文件**只红在清理期 `EPERM`**）。它出现在**判据 3a**，且**13 次观测只命中 1 次**（§5）。它被测的产品源 `orchestrator.ts` 正是**另一会话的在途 WIP**（+90 行）⇒ **既不能判成回归、也不能判成「与在途改动无关」**，归属**未闭合**，故**单列**、不计入上面任何一个桶。
- **既存：13 个文件 / 32 条（+1 个文件级）**。其中 **15 条 / 3 个文件**有**既往 notes 记录逐字对应**（ui `stored-preference` 12 + ui `list-detail-layout` 2 对 `2026-10-03-…:85`；agents `claude-code/index` 1 对 `2026-10-05-…:273-278`）；余下 **17 条 / 9 个文件**属清理期 EPERM 家族（本 notes §1 已登记其机制），外加 `orchestrator-messages` 那 **1 个文件级**失败。
- **机器慢：0 条**（`tests` 累积 770.88s ≈ 基线 0.30×；**硬依据是全部产物零 `Test timed out`**，见 §3 末）。

### ⚠️ T4 未能自行处置、需控制者裁决的两件事

1. **任务书的前提与现场不符**：点名的「僵死 vitest 进程树」**已不存在**（全机器无 `vitest` 命中），而现场另有一个**活着的 codex 评测子进程**与常驻 dev server。我按「不许终止别人的进程」这条硬约束**没有碰它们**，改为把真实负载如实登记在 §3 末。控制者若要更干净的读数，需要先由人停掉 3083 上的 dev server 与在跑的评测轮次。
2. **被测包内有别人的在途改动**：`packages/server/evaluator/src/orchestrator.ts`（产品码 +90 行）与 `orchestrator-live.test.ts`（+50 行）**未提交**。本轮整包/全量把这份 WIP 一起执行了。它影响两处读数：① `orchestrator-live.test.ts` 是**19 个目标文件之一**，其 WIP 新增用例（心跳冻结那两条）在判据 3b 里因清理期 EPERM 而红；② 上表最后一条的断言红**无法排除**由 `orchestrator.ts` 的 WIP 引起。**我未 `git add` 也未改动这两个文件**（提交只含 notes）。若要干净的归因，需要控制者安排：在那两个文件落定后，单独重跑 `orchestrator-execution-mode-b.test.ts` 与 `orchestrator-live.test.ts` 若干次。

### T4 对「过期行号」的收口（点名事项）

- `:803` → **`:846`**（本节上方 §1 的探针 2 那一条，原写作 `fixtures.ts:803` 的 `vi.importActual`）：已改为 `fixtures.ts:846`（T1 之前的编号是 `:803`），与同文件下面 §2「未验的观察」那条的写法**统一**（那条本来就对）。
- **选择「平移后行号 + 括注旧编号」而不是「按形态文本指认」的理由**：本文件里已经有一条同形的写法（§2 的 `fixtures.ts:846`（T1 之前的编号是 `:803`）），两处**统一**比引入第二种指认风格更不容易再漂移；且形态文本（`vi.importActual`）在 `fixtures.ts` 里有 **4 处**命中（`:599` 注释里 1 处、`:837`/`:842` 注释 2 处、`:846` 真代码 1 处），单说「`vi.importActual` 那处」**反而歧义**。
- **顺手核净了本 notes 里全部 `fixtures.ts:NNN` 引用**（共 7 处），逐条对着当前文件（**964 行**）复核，结论如下（除 `:803` 那处外**全部本来就对**）：
  `:34-56`（import 区块：JSDoc 34-46 + `import type {` 47-56）✓、`:90-96`（`rmSync` 上方注释）✓、`:97`（`rmSync` 本体）✓、`:574`（`function makeFakeProvider`）✓、`:591-624`（`messageCapability` 的 JSDoc + 逐字字面量）✓、`:846`（`vi.importActual`）✓、以及 §1「变异 1」里那组**刻意写成 T1 之前编号**的 `:34`/`:35`/`:581`/`:562`/`:803` ✓（它们描述的是 `git checkout --` 回 HEAD 的那个变异体，本来就该用旧编号）。
- 复核手段：`Get-Content` **不能**用来数这个文件的行数——不带 `-Encoding` 时 PS 5.1 按 ANSI 解码，中文被解成乱码且**行数读成 787**（真值 **964**）；先按字节用 Node 数（`\n` 计数 = 964、CRLF 0、BOM 无），再用 read/ripgrep 定位逐行内容。
- **哈希基线**：本 notes §1「变异 1」那个 `66126DD8…` 是 **T1 当时**的基线，T3 收口改了 `fixtures.ts` 两行注释后**已失效**；现行基线是 `BDEAB2A0C15B30F5B021EB7C1B74A1F61CD68182AA14142F1FA5B6B97DAF5CAC`。三个版本的字节级对照表已补在 §1「变异 1」小节末尾（那里也是唯一引用旧哈希的地方）。

## 5. 命中工况复跑（整包 ×4）与那条断言 flake 的取证

**为什么要复跑**：T4 当场那 6 次复跑用的是**单文件**工况，而那条断言红的命中发生在 **27 文件并行**的整包工况 ⇒ 必须在**命中工况**下重测（控制者批准；整包不限次数，只有 `pnpm test` 限一次）。

**命令**（注意用的是**命令行一行形态**，它顺带复核了上面那条退出码口径）：

```
cmd /v:on /c "pnpm.cmd vitest run packages/server/evaluator --reporter=default --reporter=json --outputFile=<n>.json & echo AIEVAL_EXITCODE=!errorlevel!"
```

| 轮 | 墙钟 | exit（落盘取到） | `Test Files` | `Tests` | `AssertionError` | `fixtures.ts:97` EPERM | `testResults` 总数 |
|---|---|---|---|---|---|---|---|
| 第 0 轮 = **判据 3a**（Step 1 原始整包） | 21.22s | （缺，见上） | `5 failed \| 22 passed (27)` | `5 failed \| 251 passed (256)` | **1** | 5 | 27 |
| 第 1 轮 | 21.10s | **1** | `8 failed \| 19 passed (27)` | `11 failed \| 245 passed (256)` | **0** | 11 | 27 |
| 第 2 轮 | 21.83s | **1** | `4 failed \| 23 passed (27)` | `8 failed \| 248 passed (256)` | **0** | 8 | 27 |
| 第 3 轮 | 20.72s | **1** | `7 failed \| 20 passed (27)` | `9 failed \| 247 passed (256)` | **0** | 9 | 27 |
| 第 4 轮 | 20.60s | **1** | `6 failed \| 21 passed (27)` | `7 failed \| 249 passed (256)` | **0** | 7 | 27 |

**三条读数**（都在命中工况下）：

1. ✅ **`Test Files` 总数恒为 27、`testResults` 总数恒为 27**（第 0–4 轮 **5/5**）⇒ 判据 3a/3b 的「27 个文件都能被收集」在重复测量下**稳定**，不是一次侥幸。
2. ✅ **`AssertionError` 在 4 轮里全为 0**，且**每轮「失败条数」逐条等于 `fixtures.ts:97` 的 EPERM 条数**（11=11、8=8、9=9、7=7）⇒ 按 T4 判读口径，这 4 轮**全是纯清理期 flake**，没有一条真红。
3. ✅ **`orchestrator-execution-mode-b.test.ts:79` 的断言红在 4 轮里一次都没复现**：逐轮 json 显示该文件第 1、4 轮 `failed=1` 但**失败原因只有 EPERM**（`断言红=0`），第 2、3 轮**全绿**。

**该断言红的观测总账（13 次）**：命中 **1** 次 —— 判据 3a（整包，命中工况）；未命中 **12** 次 —— 判据 3b（整包）、全量、本表 4 轮（整包）、单文件重复 6 次。⇒ 命中工况下 **1/6**，全样本 **1/13**。
⇒ 结论：**低概率非确定性 flake**（同一文件在 12 次未命中里，凡红必是清理期 EPERM，失败条数恒等于 EPERM 条数）。⚠️ 但**归属仍未闭合**：该文件被测的产品源是另一会话在途修改的 `orchestrator.ts`，我未获授权还原，故**不能排除「在途改动」这一支**（同 §4 末条的限定）。

**产物（可独立复核）**：`%TEMP%\aieval-t4\` 下 `rerun-summary.txt`（本表的机器可读版）、`rerun-{1..4}.out` / `.err` / `.json`，以及第 0 轮的 `step1-pkg.out` / `.err`。`Test timed out` 与 `Hook timed out` 在这 20 份产物里逐份计数**全为 0**。

### pnpm typecheck 退出码「1 与 2 两处并存」的收口

本线 `progress.md` 记的是「`pnpm typecheck` **外层**退出码 **1**、直接 `tsc.CMD` **真实码 2**」，而 T4 首次实测 `pnpm typecheck` 得到 **2**，随后复测又得 **1** ⇒ 两处并存，读者会疑惑。T4 的收口（**与分类无关**，因为判据是「3 条 `error TS`、全在 `agents` 包、HEAD 上既存」，不看退出码）：

- **机制（读安装的编译器源码确认，不是推测）**：`typescript@5.9.3` 的 `lib/typescript.js:6140-6143` 定义 `Success = 0` / `DiagnosticsPresent_OutputsSkipped = 1` / `DiagnosticsPresent_OutputsGenerated = 2`；决定取哪个的是 `:133755-133758`：

  ```js
  if (emitResult.emitSkipped && diagnostics.length > 0) return 1;  // OutputsSkipped
  else if (diagnostics.length > 0)                      return 2;  // OutputsGenerated
  return 0;
  ```

  ⇒ **1 与 2 都是「有诊断」的合法取值**，差别只在 `emitResult.emitSkipped`（**产出这一档**），**不在 pnpm 是否透传**。
- **pnpm 透传这一层是实测过的**：本轮字节保真复测，`pnpm.cmd typecheck` **与** 直接 `node_modules\.bin\tsc.CMD -p tsconfig.typecheck.json` **两者同为 exit 1**，且 pnpm 自己的那行原文就是 `[ELIFECYCLE] Command failed with exit code 1.`；同一命令连测 3 次稳定为 1。
- ⇒ **两处记录（1 与 2）都不假**，是同一个编译器在同一批 3 条错上、因 `emitSkipped` 处于不同档而给出的两个合法码；T4 首次那个 **2 我没能再复现**（3 次 + 1 次字节保真实测全为 1），故如实记为「**一次未复现的历史读数**」，不编机制去圆它。
- **读法**：判 `typecheck` 过不过，看 `error TS` 行数，**不要看退出码**。

### 本轮对守卫的收口（终审 With fixes）：`export {} from` 空子句

**缺陷**：`mockedRuntimeEdges` 的 export 分支原先只写 `return clause.elements.some((element) => !element.isTypeOnly);` —— 而 `Array.prototype.some` 对**空数组**恒返回 `false`，于是 **`export {} from '@aieval/agents'` 被判成「不是运行时边」**。实测它转译后是 **1 条真请求**（`__vite_ssr_import__`），且 **spec §4.2 的修正段与 §4.5 的负样本⑪ 都判它违规** ⇒ 收口前是「**权威文档判违规、实现判放行**」，那个矛盾只记在 gitignore 的 ledger 里、**不在任何入库文档里**。

**修法（一行 + 一条样本）**：export 分支补 `if (clause.elements.length === 0) return true;`（空子句算运行时边），样本表补一条负样本 `export {} from '@aieval/agents';`。**零误报风险**（两条本就放行的形态走的是**两条不同**的路径，别混成一条）：`export type { … } from` 是在 `statement.isTypeOnly` 那一行返回 `false`；而 `export { type A, type B } from` 的 `elements` **非空**（长度 ≥ 1），是由下面最后一行 `.some(…)` 返回 `false` —— **两者都到不了**新的空子句分支。

**变异验证（本仓规矩：没见过失败的守卫不算守卫）**：

| 步骤 | 动作 | `static-assertions.test.ts` 读数 | exit | 文件 SHA256 |
|---|---|---|---|---|
| 修后 | 补上一行 + 一条样本 | `Test Files 1 passed (1)` / **`Tests 9 passed (9)`** | 0 | `FB8B02FED6778570763258FD50D69AF2CF005C3A71E62ED13D99BA100CC886CD` |
| **变异** | 把那一行改回「不认空子句」 | `Test Files 1 failed (1)` / **`Tests 1 failed \| 8 passed (9)`**，红的就是 `应当命中：export {} from '@aieval/agents';: expected [] to not deeply equal []` | 1 | `D6EB7B0ECFE907EC3A3CDF129E452468B10F5BDEF03F8FA6D8FEA00EC069A636` |
| 还原 | 逐字还原 | `Test Files 1 passed (1)` / **`Tests 9 passed (9)`** | 0 | `FB8B02FE…` **与修后逐字相同（True）** |

⇒ 那条 `if (clause.elements.length === 0) return true;` **承重**：拿掉它，**恰好**那条新样本红，其余 8 条照旧绿 ⇒ 新样本有区分力，且这一行是它的唯一覆盖。`pnpm lint` 在本轮改动后 **exit 0**。

**顺带登记的一条结构性盲区（写进守卫 JSDoc，并与本 notes 互为入库载体）**：工厂体若写成**静态 import 的标识符**（如 `vi.mock('@aieval/agents', seams.agentsMock)`）而非内联动态 import，则判据 ② 取不到任何 `import('<字面量>')` ⇒ **ROOTS 为空 ⇒ 整条判据静默放行**（不报错、不红）。它**当前无活体实例**：本包 **27** 个测试文件里 **22 个**含带工厂的 `vi.mock`、共 **58 处**，这 58 处的工厂体**全部**（58/58）是内联 `async () => (await import('<字面量>'))…` 形态 ⇒ ROOTS 非空（`static-assertions.test.ts` 里另有 3 处只出现在**样本字符串**里，不是真 mock，不计入 58）。属**独立一条线**，本线只登记、不扩环。
