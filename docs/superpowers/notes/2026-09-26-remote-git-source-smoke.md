# 远端 git 来源 —— 关账记录（变异验证 / 全量检查 / 冒烟）

> 对应计划：`docs/superpowers/plans/2026-09-26-remote-git-source.md` 的 **Task 14 关账**。
> 四要素按 AGENT.md「冒烟测试」节：① 范围清单 ② 操作路径 ③ 证据 ④ 未覆盖项与后续计划。
> **分工**：§1–§3（变异验证与全量检查）由 T14 实施者执行；§4 浏览器冒烟由**控制方**执行，
> 该节留空由控制方填写——本文件的作者没有操作过浏览器，不代填、不臆造 UI 证据。

## 0. 结论速览

| # | 项目 | 结论 |
|---|---|---|
| 1 | 四条变异验证 | **4/4 全部变红**，且红的是**断言/抛错**（不是 `Test timed out`）；四条全部逐字节还原 |
| 2 | `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0（0 error） |
| 3 | `pnpm test`（整包聚合） | **1266 条用例**（≥ README 的 1109 ✅）；默认上限 13 条失败、仅 CLI 抬高上限 6 条失败，**两轮 `AssertionError` 都是 0**（全部是环境形态）→ §3.3 |
| 4 | 包级复跑（T12/T10 评审点名的两条） | `core git.repo` 默认 32/33（超时）→ 抬高上限 **33/33 绿**；`evaluator` 整包两轮均 140/144（per-describe 60s 预算，CLI 抬不动）→ §3.4 |
| 5 | spec §9.4 第 1 条（属性断言，非变异项） | 见 §3.2：`git clone <镜像>` 后 `refs/heads` **恰好一行** |
| 6 | 浏览器冒烟（spec §12 夹具 A / B） | **不在本实施者范围**，由控制方执行 → §4 |

## 1. 范围清单（① 四要素之一）

| 项目 | 状态 | 理由 |
|---|---|---|
| 变异 1：`ensureMirror` 的 `git clone --mirror` → `--bare` | ✅ 已执行 | T5「增量更新拿到来源的新提交，并写镜像记录」变红（见 §3.1） |
| 变异 2：`promoteMirror` 去掉「目标已就绪则复用」分支 | ✅ 已执行 | T4「目标已存在且就绪时复用既有目录并清掉 tmp」变红（见 §3.1） |
| 变异 3：`classifyRemoteFailure` 超时分支改回 `NOT_A_GIT_REPO` | ✅ 已执行 | T5「克隆被墙钟杀掉 → REPO_UNREACHABLE」变红；另有 4 条同类守卫一并变红（见 §3.1） |
| 变异 4：`resolveCaseSource` 去掉「本地来源 + 分支 → INVALID_QUERY」 | ✅ 已执行 | T9「本地来源填分支 → INVALID_QUERY」变红（见 §3.1） |
| `packages/server/core/src/mirror.ts` 还原 | ✅ 已核对 | SHA256 与变异前逐字节一致 |
| `packages/server/api/src/cases.ts` 还原 | ✅ 已核对 | SHA256 与变异前逐字节一致 |
| spec §9.4 第 1 条（`git clone <镜像>` 只建一个本地分支） | ✅ 已取证据 | 该条是**属性断言**（钉住 R20 的前提），变异方向不可达，按计划不计入四条（见 §3.2） |
| `pnpm typecheck` | ✅ 通过（exit 0） | 见 §3.3 |
| `pnpm lint` | ✅ 通过（exit 0） | 见 §3.3 |
| `pnpm test`（整包聚合、默认上限） | ⚠️ 见 §3.3 | 总数 **1266 ≥ 1109** ✅；13 条失败全是环境形态（12 超时 + 1 `EPERM rename`），0 断言失败 |
| `pnpm --filter @aieval/core test -- git.repo` | ✅ 已复跑 | 默认上限 1 条超时（32/33），**仅 CLI 抬高上限后 33/33 绿**（见 §3.4） |
| `pnpm --filter @aieval/evaluator test` | ⚠️ 见 §3.4 | 两轮均 `140/144`：4 条卡在**自带**的 per-describe 60s 预算上（0 断言失败），CLI 杠杆抬不动 |
| 浏览器冒烟：spec §12 夹具 A（`file://` 全链路 7 项） | ⏭ 跳过（分工） | 由控制方执行，见 §4 |
| 浏览器冒烟：spec §12 夹具 B（真实远端，只做校验与候选） | ⏭ 跳过（分工） | 由控制方执行，见 §4 |

## 2. 操作路径（② 四要素之二）

本次关账**没有 UI 操作**，全部为命令行操作序列（浏览器操作路径由控制方在 §4 补）：

1. 记录变异前哈希并备份两个待变异文件（备份落在 `%TEMP%\t14-mutation-backup`，不进仓库）：
   `Get-FileHash packages\server\core\src\mirror.ts -Algorithm SHA256`；同 `packages\server\api\src\cases.ts`。
2. 对每条变异：**制造缺陷** → 跑对应用例（先默认上限、再用**仅 CLI** 的 `--testTimeout=600000` 复跑）
   → 记录红输出 → 从备份**逐字节还原** → `Get-FileHash` 与变异前比对 → `git status` 确认工作树干净。
3. 变异 1–3 用 `pnpm --filter @aieval/core test -- mirror -t "<用例名片段>"`；
   变异 4 用 `pnpm --filter @aieval/api test -- cases -t "本地来源填分支"`。
4. 全量检查：`pnpm typecheck` → `pnpm lint` → `pnpm test`。
5. 包级复跑：`pnpm --filter @aieval/core test -- git.repo` 与 `pnpm --filter @aieval/evaluator test`。

> 全程**没有**改 `vitest.config.ts` / `testTimeout` / `hookTimeout`，**没有**加 `beforeAll` 预热：
> 复跑口径只有「隔离复跑 + 仅 CLI 的 `--testTimeout`」（计划 A12）。

## 3. 证据（③ 四要素之三）

### 3.1 四条变异验证

**变异前 SHA256（四条共用）**

| 文件 | SHA256 |
|---|---|
| `packages/server/core/src/mirror.ts` | `1D3999D75348B132355171195EEA734CEEA430A250B4378C974B3056BD8E25A3` |
| `packages/server/api/src/cases.ts` | `2452E4E1B1B544F61E9E2785964DD70CA10CE6BE5F69B005A8C0D61C2B65ABC0` |

#### 变异 1 —— `--mirror` 改成 `--bare`（镜像语义的 refspec 没了）

- **缺陷**：`mirror.ts` 的 `execute(parent, ['clone', '--mirror', '--quiet', input.url, tmp], …)`
  → `['clone', '--bare', …]`。
- **命令**：`pnpm --filter @aieval/core test -- mirror -t "增量更新拿到来源的新提交"`
  （默认上限；另跑一次 `--testTimeout=600000`）。
- **红输出（默认上限，`scratch-t14-mA-default.txt`）**：

  ```
   ❯ src/mirror.test.ts (45 tests | 1 failed | 44 skipped) 5332ms
   FAIL  src/mirror.test.ts > fetchMirror > 增量更新拿到来源的新提交，并写镜像记录（url 指向来源 + fetchedAt 前进）
  AssertionError: expected 'e168978636a19610e58aa18677c23a9afe359…' to be 'ae7e0b6d231f7c0bc2f7fb7cff202546c904a…' // Object.is equality

  Expected: "ae7e0b6d231f7c0bc2f7fb7cff202546c904ab98"
  Received: "e168978636a19610e58aa18677c23a9afe359da6"

   ❯ src/mirror.test.ts:363:63
      363|     expect(git(dir, ['rev-parse', 'refs/heads/main']).trim()).toBe(tip
       |                                                               ^
        Tests  1 failed | 44 skipped (45)
     Duration  5.65s
  ```

  机制与预期一致：`--bare` 克隆的 `remote.origin.fetch` 是 `+refs/heads/*:refs/remotes/origin/*`，
  于是 `git fetch --prune origin` 把新提交写到 `refs/remotes/origin/main`，`refs/heads/main` 原地不动。
  仅 CLI 提高上限那次复跑同样是这条断言红（`scratch-t14-mA-raised.txt`，`Tests 1 failed | 44 skipped`，5.61s）
  ——**不是** `Test timed out`。
- **还原后 SHA256**：`1D3999D75348B132355171195EEA734CEEA430A250B4378C974B3056BD8E25A3`（与变异前一致）

#### 变异 2 —— `promoteMirror` 去掉「目标已就绪则复用」

- **缺陷**：删掉 catch 里的
  `if (isMirrorReady(targetDir)) outcome = 'reused-existing';`（连同其上那句注释），
  于是撞车时 `outcome` 恒为 `null` → 走 `throw new ServiceError('INTERNAL', …)`。
- **命令**：`pnpm --filter @aieval/core test -- mirror -t "目标已存在且就绪时复用既有目录"`（+ `--testTimeout=600000`）。
- **红输出（默认上限，`scratch-t14-mB-default.txt`）**：

  ```
   ❯ src/mirror.test.ts (45 tests | 1 failed | 44 skipped) 63088ms
   FAIL  src/mirror.test.ts > promoteMirror > 目标已存在且就绪时复用既有目录并清掉 tmp（rename 撞车的可达路径）
  ServiceError: 远端镜像改名失败：…\runs\remotes\origin-2184424d.tmp-999 → …\runs\remotes\origin-2184424d
   ❯ promoteMirror src/mirror.ts:192:11
      192|     throw new ServiceError('INTERNAL', `远端镜像改名失败：${tmpDir} → ${targetD…
   ❯ src/mirror.test.ts:299:12

  Caused by: Error: EPERM: operation not permitted, rename '…origin-2184424d.tmp-999' -> '…origin-2184424d'
        Tests  1 failed | 44 skipped (45)
     Duration  63.54s
  ```

  两份日志里 `Test timed out` 出现次数均为 **0**（默认上限那次 63.54s 是机器负载，非超时判负）。
- **还原后 SHA256**：`1D3999D75348B132355171195EEA734CEEA430A250B4378C974B3056BD8E25A3`（与变异前一致）

#### 变异 3 —— `classifyRemoteFailure` 的超时分支改回 `NOT_A_GIT_REPO`

- **缺陷**：`if (isTimeoutKill(error))` 分支里 `new ServiceError('REPO_UNREACHABLE', …)` → `'NOT_A_GIT_REPO'`
  （文案与其余字段不动）。
- **命令**：`pnpm --filter @aieval/core test -- mirror -t "克隆被墙钟杀掉"`（+ `--testTimeout=600000`）。
- **红输出（默认上限，`scratch-t14-mC-default.txt`）**：

  ```
   ❯ src/mirror.test.ts (45 tests | 1 failed | 44 skipped) 3077ms
   FAIL  src/mirror.test.ts > ensureMirror > 克隆被墙钟杀掉（远端接了连接却永不回话）→ REPO_UNREACHABLE，且不留 tmp 残留
  AssertionError: expected 'NOT_A_GIT_REPO' to be 'REPO_UNREACHABLE' // Object.is equality

  Expected: "REPO_UNREACHABLE"
  Received: "NOT_A_GIT_REPO"

   ❯ src/mirror.test.ts:257:43
      257|     expect((caught as ServiceError).code).toBe('REPO_UNREACHABLE');
       |                                           ^
        Tests  1 failed | 44 skipped (45)
     Duration  3.39s
  ```

- **溢出范围（`-t "超时"`，仅 CLI 上限 600000，`scratch-t14-mC-blast.txt`）**：`5 failed | 4 passed | 36 skipped`，
  变红的五条为「探活超时被杀」「墙钟杀掉（signal=SIGTERM）」「墙钟杀掉（code=ETIMEDOUT）」
  「探活墙钟杀掉（默认 15s 上限）」「抓取注入 3s 上限」——即**整个超时分类面**都由这条分支钉住。
- **还原后 SHA256**：`1D3999D75348B132355171195EEA734CEEA430A250B4378C974B3056BD8E25A3`（与变异前一致）
- **还原后复绿**：`-t "克隆被墙钟杀掉" --testTimeout=600000` → `Tests 1 passed | 44 skipped (45)`，3.07s。

#### 变异 4 —— `resolveCaseSource` 去掉「本地来源 + 分支 → `INVALID_QUERY`」

- **缺陷**：删掉 `resolveCaseSource` 里
  `if (branch !== null) throw new ServiceError('INVALID_QUERY', `本地目录来源不支持分支：${source.path}`);`
  （连同其上那句注释）。`validateRepo` / `listCommitCandidates` 里同口径的两处**没动**
  ——正是为了看清这条守卫各自的覆盖面。
- **命令**：`pnpm --filter @aieval/api test -- cases -t "本地来源填分支"`（+ `--testTimeout=600000`）。
- **红输出（默认上限，`scratch-t14-mD-default.txt`）**：

  ```
   ❯ src/cases.test.ts (57 tests | 1 failed | 56 skipped) 2572ms
   FAIL  src/cases.test.ts > 用例保存（远端来源） > 本地来源填分支 → INVALID_QUERY（按值判，不受全量补丁影响）
  AssertionError: expected [Function] to throw an error

   ❯ src/cases.test.ts:966:66
      966|     expect(() => updateCase(created.id, { repoBranch: 'main' })).toThr…
       |                                                                  ^
        Tests  1 failed | 56 skipped (57)
     Duration  3.22s
  ```

- **溢出范围（`-t "本地来源"`，仅 CLI 上限，`scratch-t14-mD-blast.txt`）**：
  `1 failed | 2 passed | 54 skipped` —— 另两条「本地来源」用例走的是 `validateRepo` /
  `listCommitCandidates` 的同名守卫，本次没被碰，所以不受影响（三条守卫各自独立，属预期）。
- **还原后 SHA256**：`2452E4E1B1B544F61E9E2785964DD70CA10CE6BE5F69B005A8C0D61C2B65ABC0`（与变异前一致）
- **还原后复绿**：`-t "本地来源填分支" --testTimeout=600000` → `Tests 1 passed | 56 skipped (57)`，1.88s。

**四条变异小结**：4/4 全部变红，四条的红都是**断言/抛错**（变异 2 是 `ServiceError('INTERNAL')` 逃逸），
没有任何一条靠 `Test timed out` 变红；四条全部逐字节还原（哈希见上），还原后工作树 `git status` 干净。

### 3.2 spec §9.4 第 1 条：属性断言（不是变异验证）

计划已裁定该条**不计入四条变异**：它是「本地路径克隆只建一个本地分支」这条**属性**的断言（R20 的前提），
不是一段可能被人改坏的代码——无论镜像建成 `--mirror` 还是 `--bare`，克隆它都只建一个本地分支，变异方向不可达。

证据（`scratch-t14-s94-clone-property.txt`，夹具为临时目录里的真 git 仓库，`main` + `feat/x`）：

```
=== ① 远端 origin.git 的 refs/heads ===
refs/heads/feat/x 1c03d4153fa8a920e91b8db9554f6971ad5b1dc3
refs/heads/main 2cdf3dab3b4735ab1afd1a2dd2461781fd6a0143
=== ② ensureMirror 形状的镜像 mirror.git 的 refs/heads ===
refs/heads/feat/x 1c03d4153fa8a920e91b8db9554f6971ad5b1dc3
refs/heads/main 2cdf3dab3b4735ab1afd1a2dd2461781fd6a0143
=== ③ 从镜像克隆出的行工作区 refs/heads（R20 前提：恰好一行）===
refs/heads/main
count = 1
=== 该行工作区 HEAD ===
2cdf3dab3b4735ab1afd1a2dd2461781fd6a0143
```

即：镜像里有 `main` 与 `feat/x` 两个分支，而从镜像克隆出来的行工作区 `refs/heads` **恰好一行**（`main`）。

### 3.3 全量检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | exit 0（`tsc -p tsconfig.typecheck.json`，0 error） |
| 静态检查 | `pnpm lint` | exit 0（`eslint . --cache`，0 error） |
| 测试 | `pnpm test` | `Test Files 8 failed \| 99 passed (107)`；`Tests 13 failed \| 1253 passed (1266)`；`Duration 692.51s` |

**用例总数 1266 ≥ README 记录的 1109** ✅（多出 157 条，均为本特性新增；新增测试文件都落在既有包目录内，
被根 `vitest.config.ts` 的 `projects` 自动收集）。

#### 13 条失败的逐条归因：**0 条断言失败**

| 形态 | 条数 | 明细 |
|---|---|---|
| `Test timed out in 20000ms`（core 的配置级上限） | 7 | `git.diff.test.ts:167`、`git.repo.test.ts:233`、`git.repo.test.ts:508`、`mirror.test.ts:223`、`mirror.test.ts:408`、`mirror.test.ts:763`、`workspace.test.ts:186` |
| `Test timed out in 60000ms`（api / evaluator） | 5 | `cases.test.ts:247`、`judge.test.ts:262`、`orchestrator.test.ts:254 / 630 / 1075` |
| `Error: EPERM: operation not permitted, rename …` | 1 | `runs.test.ts:104` → `saveConfig`（`core/src/config-store.ts:144`，`config.json.tmp → config.json` 被占用挡住） |
| `AssertionError` | **0** | 全文 `AssertionError` 出现 **0** 次 |

#### A12 (i)：受影响文件的隔离复跑（逐文件单跑、默认上限）

| 文件 | 命令 | 结果 | 失败原因 |
|---|---|---|---|
| core `git.repo` | `pnpm --filter @aieval/core test -- git.repo` | 1 failed \| 32 passed (33)，109.36s | `Test timed out in 20000ms`（`ensureCaseCache > 首次调用真的克隆出带 .git 的完整仓库…`） |
| evaluator 整包 | `pnpm --filter @aieval/evaluator test` | 4 failed \| 140 passed (144)，555.34s | 4 × `Test timed out in 60000ms`（0 断言失败） |
| api `cases` | `pnpm --filter @aieval/api test -- cases` | **57 passed (57)** ✅，251.28s | —（聚合里那条超时不复现） |
| api `judge` | `pnpm --filter @aieval/api test -- judge` | **14 passed (14)** ✅，8.02s | — |
| api `runs` | `pnpm --filter @aieval/api test -- runs` | **26 passed (26)** ✅，0.61s | —（聚合里那条 `EPERM rename` 不复现） |
| core `mirror` | `pnpm --filter @aieval/core test -- mirror` | 2 failed \| 43 passed (45)，245.17s | 2 × `Test timed out in 20000ms`（`fetchMirror > 增量更新…`、`resolveRemoteRef > 默认分支跟随远端前进…`） |
| core `workspace` | `pnpm --filter @aieval/core test -- workspace` | 1 failed \| 12 passed (13)，96.11s | `Test timed out in 20000ms` |
| core `git.diff` | `pnpm --filter @aieval/core test -- git.diff` | **22 passed (22)** ✅，32.18s | — |

**归因**：8 份日志里 `AssertionError` 合计 **0** 次；失败全部是墙钟超时。
受害用例在两轮聚合之间还会换人（evaluator 在聚合里红在 `:254/:630/:1075`，在包级隔离跑里红在
`:302/:630/:844/:1152`）——与 A12 记载的「负载型假红、受害者每次不同」一致。
另外顺带得到一次 core 整包默认上限运行：`4 failed | 172 passed (176)`，4 条也全是超时。

#### A12 (ii)：仅 CLI 抬高上限的聚合复跑

`pnpm test -- --testTimeout=600000` → `Test Files 2 failed | 105 passed (107)`；
`Tests **6 failed** | 1260 passed (**1266**)`；`Duration 688.28s`（`scratch-t14-raised-aggregate.txt`）。

失败的 6 条**仍然是环境形态，且 `AssertionError` 依旧是 0**：

1. **5 条 evaluator `orchestrator.test.ts` 的 `Test timed out in 60000ms` —— CLI 抬不动它们。**
   该文件用 `describe(…, { timeout: TEST_TIMEOUT_MS })`（`TEST_TIMEOUT_MS = 60_000`，见
   `orchestrator.test.ts:53` 与 `:217 / :301 / :537 / :589 / :681 / :788 / :819 / :1074`）
   给每个块声明了 **per-describe 预算**；vitest 里「最具体的预算优先」，CLI 的 `--testTimeout`
   只覆盖**配置级**的 `testTimeout`，不改 per-describe / per-test 预算。
   （反证：`pnpm --filter @aieval/evaluator test -- orchestrator -t "R14 接缝" --testTimeout=1`
   仍然 3 passed —— 1ms 没生效；而 `pnpm --filter @aieval/api test -- runs --testTimeout=1`
   立刻大面积 `Test timed out in 1ms` —— 配置级的那份被 CLI 覆盖了。
   这正是 T7 Ruling 的代价：那几个块刻意自带预算、`vitest.config.ts` 一字不动。）
2. **1 条 api `cases.test.ts > validateRepo（远端来源）> 远端校验只读镜像…`**：
   `ServiceError: 远端仓库探活超时（超过 15 秒）…（已终止 git 进程）`，`Caused by: Error: spawnSync git ETIMEDOUT`
   —— 是**产品自己的探活墙钟**（`REMOTE_PROBE_TIMEOUT_MS = 15_000`）被本机的进程创建停顿打穿，
   不是断言失败；同一个用例在 api 文件的隔离跑里是**绿的**（57/57）。
   （本机偶发单次 git spawn 被拖到 100s 级：见 `mirror.test.ts:142-147` 的注释与 T5 的记录。）

对比：**13 failed → 6 failed**，失败集合只变小、没有出现新的断言失败。

### 3.4 包级复跑（评审点名的两条）

| 目标 | 命令 | 默认上限 | 仅 CLI 抬高上限 |
|---|---|---|---|
| core `git.repo`（T12 评审点名） | `pnpm --filter @aieval/core test -- git.repo` | 1 failed \| 32 passed (33)，109.36s（`Test timed out in 20000ms`） | **33 passed (33)** ✅，102.23s（`--testTimeout=600000`） |
| evaluator 整包（T10 评审指出的证据缺口） | `pnpm --filter @aieval/evaluator test` | 4 failed \| 140 passed (144)，555.34s | 4 failed \| 140 passed (144)，563.84s（`--testTimeout=600000`，**同样 4 条**：受 per-describe 60s 预算约束，CLI 抬不动） |

- core `git.repo`：默认上限下那一条是**超时**（不是断言），抬高 CLI 上限后 **33/33 全绿** ✅。
- evaluator 整包：`orchestrator.test.ts` 的两轮失败用例名相同
  （`准备阶段失败（仓库不是 git 仓库）…`、`评分前改默认评分模型…M1 的窗口`、
  `终止（并行）：正在跑的每一行都是 canceled，没有 skipped`、`startRun 的三条拒绝路径…`），
  全部是 `Test timed out in 60000ms`、**0 条断言失败**——它们稳定地卡在**自己声明的** 60s 预算上，
  属于「本机负载 + 真克隆夹具」的组合，不是本特性的回归；
  要在这台机器上把它们跑绿，只能改测试文件里声明的预算（T7 Ruling 明确不动）或在更空闲的机器上跑。
- 再进一步隔离该文件单独跑（`pnpm --filter @aieval/evaluator test -- orchestrator`）：
  `4 failed | 44 passed (48)`，`549.89s`，4 条仍是 `Test timed out in 60000ms`、0 断言失败，
  但**受害者又换了一批**（`成功一行：状态 judged…`、`diff 超预算…`、
  `收尾落盘失败不会把这一轮锁死…`、`适配器按内层 timeoutMs 停止…`）。
  四轮 evaluator 运行的受害者集合互不相同 → 负载型假红（同时段控制方在跑 dev server / 浏览器冒烟）。

### 3.5 本次关账观察到的环境噪声（不是回归）

- 默认上限下 `pnpm --filter @aieval/core test -- mirror`（45 条）出现 **2 条 `Test timed out in 20000ms`**
  （`defaultBranchName > 镜像 HEAD 不是符号引用（detached）`、`resolveRemoteRef > 三条路都回 40 位具体 hash`），
  全文件 `Duration 225.45s`。两条都**不是断言失败**。
- 隔离复跑：`三条路都回 40 位` 单独跑 **通过**（5.11s）；`镜像 HEAD 不是符号引用` 单独在**默认上限**下仍是
  `Test timed out in 20000ms`（69.51s），换成**仅 CLI** 的 `--testTimeout=600000` 后 **2.42s 通过**。
- 结论：与 A12 记载一致——本机（多会话共用）的负载型 `Test timed out`，受害者每次不同，
  不是本特性引入的回归。**未**改仓库任何超时配置，**未**加预热。

（更多噪声记录见 §3.3 的聚合失败逐条归因。）

## 4. 控制方执行：服务层全链路冒烟（浏览器冒烟未做，理由见 §4.3）

### 4.1 范围清单（① 四要素之一）

| # | spec §12 的项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 夹具 A：校验回显（仓库名 / 默认分支 / tip / 镜像就绪） | ✅（服务层） | §4.2 ①② |
| 2 | 夹具 A：保存落盘 `repoPath` 是 URL、`repoBranch=null` | ✅（服务层 + 磁盘互证） | §4.2 ⑤⑨ |
| 3 | 夹具 A：候选来自镜像（不联网） | ✅（服务层） | §4.2 ④ |
| 4 | 夹具 A：建评测并开跑、行准备成功、`baselineCommit` = 默认分支 tip | ✅（服务层，行真的进入 `running`） | §4.2 ⑥⑦⑧ |
| 5 | 夹具 A：远端新增提交后重跑取到新基线 | ⏭ 未做（本轮未做第二轮） | 同类断言在 `evaluator/src/orchestrator.test.ts` 的「分支 tip 每轮重解析」用例里已守卫 |
| 6 | 夹具 A：用例改填分支 `feat/x` → 基线 = 该分支 tip | ✅（服务层，校验与 tip 已覆盖） | §4.2 ② |
| 7 | 夹具 A：负例（不存在的 `file://` / 未监听端口 / 本地带分支） | ✅（服务层覆盖后两条负例 + `ftp://`） | §4.2 ③ |
| 8 | 夹具 A 的**界面**交互（表单来源切换、回显文案、候选按钮、抽屉） | ⏭ 未做，见 §4.3 / §4.4 | UI 侧由 `@aieval/ui` 单测 + `cases-page-wiring` 读源码守卫覆盖 |
| 9 | 夹具 B（真实远端 `git@coding.jd.com:FlowAI/rbac-server.git`：校验 + 候选） | ⏭ 未做（未触网） | 需要真实凭据；按计划只做校验与候选，不跑 agent |

### 4.2 操作路径与证据（②③）

操作路径（全部命令行，真实 git + 真实落盘，配置与工作区都在 `%TEMP%\aieval-smoke`，**未碰真实 `~/.aieval`**）：

1. 造夹具「远端」：工作仓库两次提交（main）→ 建 `feat/x` 提交一次 → `git clone --bare` 成 `origin.git`；
   main tip `bc9c1394a9e6cc8f1b492bd0485940a8761a6614`、feat tip `0e3623fc3f348956c517e4e2da35872c7f8fcdc2`。
2. 写临时配置：`providers=[{id:'p-smoke', protocolType:'openai', models:[smoke-model]}]`，`workspaceRoot=%TEMP%\aieval-smoke\runs`。
3. 跑一次性服务层脚本（`packages/server/api/src/__smoke_tmp.test.ts`，**跑完已删除**，`git status` 干净）：
   `pnpm --filter @aieval/api test -- __smoke_tmp --testTimeout=300000` → **1 passed（285s）**。

关键输出（原文摘录）：

```
[SMOKE] row.status = running | baseline = bc9c1394a9e6cc8f1b492bd0485940a8761a6614 | err = (none)
[SMOKE] workspace = …\runs\24efe7e0-…\rows\28d9f943-…\workspace | run.json = …\runs\24efe7e0-…\run.json
 ✓ src/__smoke_tmp.test.ts (1 test) 285195ms
```

| 断言 | 结果 |
|---|---|
| `validateRepo({url, branch:null})` → `kind='remote'` / `repoName='origin'` / `branch='main'` / `tip='bc9c139'` / `mirrorReady=true` / 镜像 `HEAD` 在盘上 | ✅ |
| `validateRepo({url, branch:'feat/x'})` → `tip='0e3623f'` | ✅ |
| `ftp://…` → 抛「不支持的 git 地址协议」；本地路径 + `branch='main'` → 抛「不支持分支」 | ✅ |
| `listCommitCandidates({url, branch:null})` 首条 `hash='bc9c139'`（读镜像） | ✅ |
| `createCase(...)` → `repoPath` = 归一 URL、`repoBranch=null` | ✅ |
| `createRun(...)` → `repoPath` = URL、`repoBranch=null` | ✅ |
| `startRun(...)` 后行准备：`baselineCommit` = **完整 40 位 main tip**、`workspace/.git` 存在、镜像 `objects` 存在、行进入 `running`（codex 进程被真正拉起） | ✅ |
| 落盘互证：`run.json` 的 `repoPath` / `repoBranch` / `rows[0].baselineCommit` 与内存值逐字一致 | ✅ |

镜像落点（与 spec §5.1 的 key 规则一致）：`…\runs\remotes\origin-5f997dc2`。

### 4.3 浏览器冒烟为什么没做（诚实记录）

- `:3083` 在我准备冒烟时已被**另一个会话的 dev server** 占用（Next 自报 PID 73820）；Next 16 对同一 app 目录**拒绝第二个 dev server**（`⨯ Another next dev server is already running`），换端口也一样。
- 我**没有**杀掉它：AGENT.md 的「端口被占用先 kill」针对的是陈旧实例，而这个是在跑的服务，可能正被使用（杀它属于工作区之外的副作用）。
- 替代证据（都不是 UI 证据，故不冒充）：本节的服务层全链路 + `@aieval/ui` 271/272（唯一失败是无关的既有飘测）+ `cases-page-wiring` 读源码接线守卫 + 契约/数据层单测。
- 因此「界面上的来源切换、回显文案、候选按钮」这三处**仍属未覆盖**。

### 4.4 待走查的路径（若你在 :3083 上点一遍，约 2 分钟）

建议先用临时配置起服务，避免污染你自己的用例/评测：
`$env:AIEVAL_CONFIG_DIR='%TEMP%\aieval-smoke\cfg'; pnpm dev`（夹具与临时配置见 §4.2 第 1–2 步）。

1. `/cases` →「创建用例」→ 来源切「远端仓库」→ URL 填 `file:///C:/Users/zhanglei1120/AppData/Local/Temp/aieval-smoke/origin.git` → 点「校验」→ 断言回显出现「仓库：origin · 默认分支：main · tip bc9c139 · 镜像：已就绪（更新于 …）」；
2. 保存 → 列表「仓库名」列显示 `origin`；详情里出现 URL 与「分支」行为空（默认分支）；
3. 「重新加载候选」→ 候选出现（首条 `bc9c139`）；把夹具仓库临时改名后再点一次，候选**照常出现**（证明不联网）→ 改回；
4. 分支输入框填 `feat/x` → 校验回显变为「分支：feat/x」；把输入框改成 `main`（不点校验）→ **回显立即消失**（成对失效）；
5. 切回「本地目录」→ 分支字段消失；再切回远端且分支留空 → 保存成功（不是 400）；
6. `/runs` →「创建评测」→ 选用例（标签里仓库名是 `origin`）→ 加一行候选（Codex + 临时配置里的 `smoke-model`）→ 创建 → 「开始」→ 行卡片应走到「执行中」或「失败」，**失败必须是 agent 侧**（如 CLI 缺失），不能是来源侧；
7. 抽屉「查看改动」可打开；`run.json` 的 `baselineCommit` = `bc9c1394…`（与 §4.2 一致）。


## 5. 未覆盖项与后续计划（④ 四要素之四）

1. **浏览器冒烟整体未做**：spec §12 夹具 A（7 项）与夹具 B（真实远端 `git@coding.jd.com:…`）
   都不在本实施者范围（见 §4）；夹具 B 按计划只做「校验 + 建用例 + 拉候选」，**不真跑 agent**（不打额度），
   因此「真实远端跑满一轮评测」这一项仍然没有证据。
2. **镜像没有清理入口、也不随删用例消失**（计划的「交付后的已知限制」）：本期只把它写进文档，
   没有 UI / CLI 出口；工作区根目录一变，旧镜像就不再被看到（会重新克隆）。
3. **clone / fetch 期间阻塞整个服务进程**：本期只有 10 分钟墙钟兜底，**阻塞时长没有量化**
   （并发请求在克隆期间的表现未测）。
4. **默认 20s 上限对「首次真克隆」的用例偏紧**：本次聚合与 core 整包隔离跑里，
   `git.repo.test.ts > ensureCaseCache > 首次调用真的克隆出带 .git 的完整仓库`、
   `workspace.test.ts > prepareRowWorkspace > 首次调用…`、`mirror.test.ts > ensureMirror > 首次建镜像…`
   都在负载下报 `Test timed out in 20000ms`（**不是断言失败**）。T7 的 Ruling 只给 api 侧远端重夹具
   声明了 `REMOTE_FIXTURE_TIMEOUT_MS`，core 侧这几条「首次本地克隆」没有 per-test 预算
   ——是否给它们同样的预算，留给控制方裁决（本任务**没有**动任何超时配置）。
5. **两条无区分力的防御仍未找到可红构造**（T10 报告已记）：`?? null`（orchestrator 与 api 各自一处，
   只有同时去掉才会红）与「api 行准备的双重归一」。它们是防御性代码，本次不为其强造变异。
6. **变异 2 的守卫是 Windows 形状**：它靠 `rename` 覆盖已存在目录在 Windows 上抛 EPERM 才可达；
   POSIX 上 `rename(2)` 对空目录的语义不同，这条断言在 POSIX 上的可达性未验证（本机是 Windows，已见红）。
7. **A8 的已知退化**：「克隆被杀后不留 tmp 残留」在 POSIX 上退化为空过（git 自己注册了信号清理），
   只在 Windows 上有区分力——本机是 Windows，本次变异证据有效。
8. **A12 的复跑口径有一个边界（本次新发现，建议写进后续任务的 brief）**：
   「仅 CLI 的 `--testTimeout`」只能覆盖**配置级**的 `testTimeout`，覆盖不了
   `describe(…, { timeout })` / `it(…, fn, timeout)` 声明的 per-block / per-test 预算
   （判别实验见 §3.3 (ii)）。因此对自带预算的测试文件（如 evaluator 的 `orchestrator.test.ts`、
   api 侧用 `REMOTE_FIXTURE_TIMEOUT_MS` 的那批用例），这个杠杆**不产生任何效果**——
   要么在更空闲的机器上跑，要么单独裁决是否调整声明值。
9. **`git add` 口径**：本任务只新增 notes 文件，提交用逐文件 `git add`，未使用 `git add -A`
   （工作树与另一会话共用）。
