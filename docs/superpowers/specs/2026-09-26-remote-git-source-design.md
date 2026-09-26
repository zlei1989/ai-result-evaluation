# AI 生成代码评测工具 —— 远端 git 仓库来源设计

日期：2026-09-26
状态：待评审
前置：`docs/superpowers/specs/2026-09-22-scaffold-design.md`（脚手架设计）、`docs/superpowers/specs/2026-09-22-features-design.md`（功能设计：用例 / 评测 / 设置）
性质：本文只改**用例的代码来源**这一处——在本地绝对路径之外支持远端 git 仓库（URL）。工作区布局、缓存与行分支口径、评分口径、行状态机、事件日志口径全部不变。与前置文档冲突时以本文为准：前置文档里「只支持本地目录 / 不做远端 URL 与凭据管理」的两处表述（features-design §4.2 表单字段表、§8 非目标清单）由本文取代——**仍然不做凭据管理**，但远端 URL 成为受支持的来源形态。

---

## 1. 要解决的问题

现状（三条已实现的事实）：

1. 用例的代码来源是一个**本地绝对路径**：`resolveRepoInfo` 先 `existsSync` 再 `git rev-parse --is-inside-work-tree`，不是本地工作树一律 `NOT_A_GIT_REPO`；
2. 首次评测时由 `ensureCaseCache` 执行 `git clone <repoPath> <cacheDir>`（本地路径克隆），之后每行从缓存做文件系统级复制；
3. 用例表单的「代码仓库」一栏明写「只支持本地目录：不做远端 URL 与凭据管理」。

实际需求：被测仓库常常**只在远端**（本机有可用的 git 连接，例如 `git@coding.jd.com:FlowAI/rbac-server.git`），本地未必有一份克隆，或者那份克隆的路径不该成为评测配置的一部分。要评测这些仓库，就必须让工具自己把代码取到本地——同时不引入凭据管理。

成功标准：

1. 在 `/cases` 的「代码仓库」里填一个支持的 git URL（可选填分支）就能建用例、看 commit 候选、开评测，全程不需要先手工克隆。
2. 本地路径用例的**行为逐字不变**：既有测试全绿、既有文案不变、既有 `config.json` 不改一个字节。
3. 认证一律走**本机 git 的能力**（SSH key / ssh-agent / credential helper）——工具不落任何凭据、不新增凭据界面。
4. 远端失败（不可达 / 认证失败 / 仓库不存在 / 分支不存在 / 超时）都在界面上给出**可处置**的中文原因，且失败不静默：绝不在远端不可达时拿一份旧镜像当「当前代码」评分。

---

## 2. 本阶段范围

| 做 | 不做 |
|---|---|
| 来源形态判定（本地路径 / 远端 URL，单点真源放 contracts） | 凭据管理（token 落盘、SSH key 选择、HTTPS 账密） |
| 工作区根下的**裸镜像**层（`git clone --mirror` + 增量 `fetch --prune`） | 镜像的后台异步拉取、进度百分比、镜像管理界面 |
| 校验（快探活 + 更新镜像）、commit 候选、保存时的分支/commit 判定 | 镜像的自动清理 / GC / 容量配额 |
| 新增可选「分支」字段（留空 = 远端默认分支） | 浅克隆、部分克隆（`--filter`）、submodule 内容拉取、LFS 特化 |
| 评测准备阶段的基线解析（分支 tip 每次重新解析 / commit 钉死） | 多进程（多实例）下的镜像互斥锁 |
| 远端失败分类与中文文案；错误码只增 `REPO_UNREACHABLE` | 私有仓库「无权限」与「不存在」的区分（远端两者同形） |

---

## 3. 关键决策与理由

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| D1 | 来源仍放**同一个 `repoPath` 字段**，按形态判定本地路径还是远端 URL；不新增 `repoUrl` | 避免「两个字段 XOR」这种半配置面（`judgeProviderId`/`judgeModelId` 已为一个同类问题专门写了 `assertJudgePair` 守卫）；`run.repoPath` 快照天然显示用户填的原文；所有既有消费者只面对一个字段 | 新增 `repoUrl` + 与 `repoPath` 互斥（多一个恒等式要守、旧数据要迁移、快照要二选一） |
| D2 | 远端由服务端**自动镜像**到 `{workspaceRoot}/remotes/<slug>-<hash8>` | 「填 URL 就能用」成立；镜像跨用例复用，同一仓库只付一次网络开销 | 每个用例缓存直接从 URL 克隆（网络 × 用例数、候选/校验各自临时克隆）、手工克隆成本地目录（不满足成功标准 1） |
| D3 | 镜像是**裸镜像**（`git clone --mirror`） | 没有工作树：不会脏、不占第二份空间、分支全部以 `refs/heads/*` 可见；`git clone <镜像>` 仍**只建一个本地分支**（= 镜像 HEAD = 远端默认分支），R20 那条前提继续成立 | 普通克隆（多一份工作树；「工作树脏了」变成一个要处置的新状态） |
| D4 | **core 只见本地路径**：远端在 api / evaluator 层就被解析成「镜像路径 + 具体 commit hash」，再交给现有 `prepareRowWorkspace` | 缓存克隆、行工作区复制、`checkoutRow`、`collectDiff`、`copyWorkspace` **一行不改**；改动面被限制在「解析来源」这一层 | 让 `git.ts` 学会 URL（`resolveRepoInfo` / `listCommits` / `ensureCaseCache` 全部按 URL 分叉，错误归因与测试面同时翻倍） |
| D5 | 新增 `repoBranch: string \| null`（null = 远端默认分支）；**仅远端来源可填**，本地来源填了直接 `INVALID_QUERY` | 「从某特性分支当前状态起跑」是真实需求；本地来源保持「当前 HEAD」这条既有语义不动，不引入第二种本地基线口径 | 本地也支持分支（多一套语义与测试）；用 commit hash 代替分支（跟随 tip 的语义没法表达） |
| D6 | 「校验」= 快探活 + **确保镜像存在并更新**（首次克隆较慢，按钮 loading） | 慢一次发生在用户明确点击的动作上；之后候选/评测/保存判定都命中已就绪镜像，秒开 | 校验只探活、镜像按需建（慢点落在「重新加载候选」或首轮评测准备上，用户更不好预期） |
| D7 | 分支 tip **每次评测重新解析**（跟随语义）；填了 commit hash 则**钉死**（优先于分支） | 「跟随分支」与「钉死起点」是两种都要的口径；评测的可比性靠钉死，日常跟进度靠跟随 | 保存时把分支 tip 固定成 hash（分支前进后用户以为还在跟随） |
| D8 | **不做凭据管理**：认证 = 本机 git（SSH key / ssh-agent / credential helper） | 单用户本地工具；凭据一旦落盘就要处理掩码、轮换、泄漏面，收益远小于成本 | 令牌落 `config.json`（0600）并做掩码界面（本期无需求） |
| D9 | 远端 git 调用**非交互 + 墙钟超时**：`GIT_TERMINAL_PROMPT=0`、`stdin: 'ignore'`、SSH 追加 `BatchMode=yes`（仅在用户未自设 `GIT_SSH_COMMAND` 时）、探活 15s / 传输 10min | 同步 git 调用挂在请求线程上，一次凭据提示或网络黑洞会**冻住整个服务**；超时把「卡死」变成可处置的错误 | 只依赖 git 默认行为（缺 key 时 ssh 可能长时间等待）；把超时做成设置项（本期没有调参需求） |
| D10 | 错误码**只增** `REPO_UNREACHABLE`（400）；认证沿用 `AUTH_FAILED`，仓库不存在/不是仓库/无法归因沿用 `NOT_A_GIT_REPO`，分支与提交不存在沿用 `INVALID_REF` | 网络不通（查网络/重试/VPN）与地址不对（改地址）的**处置不同**，混在一个码里界面只能按文案猜；`ERROR_CODES` 的既定口径就是「一次定稿、后续只增不改」 | 全部塞进 `NOT_A_GIT_REPO`（处置方向被带偏）；为每类失败各加一个码（码表膨胀且界面没有对应动作） |
| D11 | 镜像**不随「删除用例」消失**、不自动清理 | 它是按 URL 命名的缓存、可能被多个用例共用；删用例连带删镜像会让别的用例下次评测重新付克隆成本 | 随用例删除（共用镜像被误删）；做引用计数（给一个缓存加生命周期管理，收益不抵复杂度） |
| D12 | 镜像与基线解析**保持同步**（沿用 `execFileSync`），不做异步化 | 编排层有一条既有不变量建立在「准备阶段是同步重活、Node 单线程插不进第三方改动」之上（`orchestrator.ts` 的两处复检注释）；把它改成异步会同时动到终止语义与那两条守卫 | 异步 spawn + 轮询进度（本期唯一收益是「克隆期间页面还能用」，代价是终止语义与测试面重做） |

---

## 4. 契约变更

### 4.1 来源形态判定（唯一真源：`packages/server/contracts/src/repo-source.ts`，新文件）

判定顺序**必须按此顺序**，因为后面的规则依赖前面的排除：

| 序 | 形态 | 判定 | 例 |
|---|---|---|---|
| 1 | Windows 盘符路径 `^[A-Za-z]:[\\/]`、UNC `^\\\\` | local | `D:\repos\demo`、`\\host\share\repo` |
| 2 | 白名单 scheme：`ssh://`、`http://`、`https://`、`git://`、`file://` | remote | `https://coding.jd.com/FlowAI/rbac-server.git`、`file:///D:/tmp/origin.git` |
| 3 | 其它 `^[a-z][a-z0-9+.-]*://` | **拒绝** | `ftp://host/x.git` → `INVALID_QUERY` |
| 4 | scp 形态：`^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]{2,}:.+$`，且「含 `@`」或「host 段含 `.`」 | remote | `git@coding.jd.com:FlowAI/rbac-server.git`、`github.com:x/y.git` |
| 5 | 其余（含 `/home/…`、相对路径） | local | `D:/repos/demo`、`./repo` |

口径说明：

- 第 4 条的额外条件是为了不把 `src:foo` 这类含冒号的本地相对路径误判成远端；`localhost:repo`（无 `@`、host 段无点）因此判为 local，要指定它请写 `ssh://localhost/repo`。
- `file://` 判为 remote 是**刻意**的：它让整条远端链路（镜像、基线解析、超时、失败分类）可以在测试与冒烟里用本地裸仓库全覆盖，不需要网络。
- **归一**：两侧空白先 `trim`；远端**仅**去掉尾部的 `/`（`https://host/x.git/` → `https://host/x.git`）。除这两条外不做任何归一（不做大小写折叠、不剥 `.git`、不把 https 改写成 ssh），因为它是镜像 key 与「来源是否改变」的判据——过度归一会让两个不同的远端指向同一镜像。
- **两条硬拒绝**（在判定之前，RG13）：来源串含控制字符（`\u0000-\u001f`，含换行与制表符）→ `INVALID_QUERY`「代码来源里含控制字符」；来源串以 `-` 开头 → `INVALID_QUERY`「代码来源不能以 - 开头」。前者防粘贴事故，后者防远端 URL 被 `git clone` / `git ls-remote` 当成选项解析（`--upload-pack=…` 是一条真实的参数注入面）。
- 第 3 条的文案：「不支持的 git 地址协议：ftp（支持 ssh:// / http:// / https:// / git:// / file:// 与 user@host:path）」。

### 4.2 `repo-source.ts` 导出

```ts
type RepoSource =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; url: string; host: string; repoName: string };

/** 形态判定 + 归一 + 解析仓库名与主机；ftp:// 之类抛 INVALID_QUERY */
export function parseRepoSource(source: string): RepoSource;

/**
 * 仓库名：远端取 URL 末段去 .git（`git@host:FlowAI/rbac-server.git` → `rbac-server`），本地取路径末段。
 * **用途限定**：界面标签（不用起 git）与远端来源的服务端取值。本地来源的服务端仓库名仍走现状
 * `resolveRepoInfo` 的 git 口径（`rev-parse --show-toplevel` 的目录名），本函数不取代它。
 */
export function repoNameFromSource(source: string): string;

/** 给 TestCaseSchema / CaseCreateSchema 的 repoPath 用的 zod 校验（内部调用 parseRepoSource） */
export const RepoSourceStringSchema: z.ZodType<string>;
```

放 contracts 而不是 core / ui 的理由：这三层都要用它（core 的镜像层、api 的校验与文案、ui 的「标题 · 仓库名 · commit」标签），放一处才有唯一真源；contracts 已有纯函数先例（`isRunnableRow`、`DIMENSIONS`、`AGENT_LABELS`），且 core 允许依赖 contracts。

### 4.3 `case.ts`

| 字段 | 变更 |
|---|---|
| `TestCaseSchema.repoPath` | 语义扩为「来源」；改用 `RepoSourceStringSchema`（校验「是不是受支持的来源」）。旧值（本地绝对路径）判定结果不变 |
| `TestCaseSchema.repoBranch` / `CaseCreateSchema.repoBranch` | 新增 `z.string().min(1).nullable().default(null)`。null = 远端默认分支；本地来源必须为 null |
| `RepoInfoSchema` | 新增 `kind: 'local' \| 'remote'`、`mirrorPath: string \| null`、`mirrorReady: boolean`、`mirrorFetchedAt: string \| null`（镜像最近一次成功 fetch 的时间，界面回显「更新于 HH:mm」）、`tip: string \| null`（短哈希 7 位，**仅远端有值**；本地为 null——本地的既有回显文案「仓库：X · 当前分支：main」逐字不变）。`branch` 语义：本地 = 当前分支，远端 = 默认分支或用户填的分支 |
| `RepoPathInputSchema` | **保留不动**（`GenerateJudgePromptSchema` 继续 extend 它）。新增两个入参，均为 `RepoPathInputSchema.extend({ repoBranch: z.string().min(1).nullable().default(null) })`：`RepoValidateInputSchema`（校验）、`RepoCommitsInputSchema`（候选） |

`repoBranch` 加 `.default(null)` 而不是「缺字段就报错」：旧 `config.json` 里的用例没有这个字段，读侧必须按 null 读（`loadConfig` 只对 settings 做了字段补齐，cases 是原样透传的）。

### 4.4 `run.ts`

`EvalRunSchema` 新增 `repoBranch: z.string().min(1).nullable().default(null)`。理由同 `repoPath` / `commitHash` 的快照口径：用例被改名、改分支或删除之后，这一轮到底从哪个分支的哪个 commit 起跑，必须还能从 `run.json` 读出来。

### 4.5 `errors.ts`

```ts
'REPO_UNREACHABLE',   // 400  远端 git 仓库不可达（DNS / 连接超时 / 连接被拒 / SSH 主机指纹未信任 / 拉取超时）
```

`STATUS_BY_CODE` 同步加一条；`errors.test.ts` 的两张表（精确列表断言与逐码状态断言）同步更新。**不加**其它码：远端「不存在 / 不是仓库 / 无法归因」继续用 `NOT_A_GIT_REPO`（文案里点名是远端），认证继续用 `AUTH_FAILED`（`context.host` 放主机名）。

### 4.6 兼容性

| 数据 | 兼容行为 |
|---|---|
| 旧 `config.json` 的用例（本地路径、无 `repoBranch`） | 判定为 local，`repoBranch` 读成 null；保存后该字段才落盘 |
| 旧 `run.json`（无 `repoBranch`） | `.default(null)` 读成 null；历史轮次的显示与复现不受影响 |
| `repoPath` 的既有本地形态 | 判定规则第 1/5 条覆盖，行为与文案逐字不变 |

---

## 5. core：镜像层（`packages/server/core/src/mirror.ts`，新文件）

### 5.1 目录与 key

```
{workspaceRoot}/remotes/{slug}-{sha1(归一后的 URL).slice(0, 8)}/
```

- `slug` = URL 末段去 `.git`，非 `[A-Za-z0-9._-]` 的字符归一成 `-`，小写化，截到 40 字符；为空则 `repo`。slug 只为人眼可读，**身份判据是 hash 段**。
- 同一 URL（仅容忍两侧空白与尾斜杠差异）稳定映射同一目录；`https` 与 `ssh` 形态的同一仓库是**两个**镜像（见 §4.1 的归一说明）。
- 改工作区根目录后旧镜像不再被看到（会重新克隆一次）——与既有的「改工作区根目录不迁移产物」同一口径。
- `remotes/` 是 `workspaceRoot` 下的第三个兄弟目录（既有 `cases/`、`{runId}/`）。`listRuns` 只认「目录下有合法 `run.json`」的那些（`readSnapshot` 先 `existsSync` 再 parse），`remotes/` 不会被当成一轮评测；这条要有守卫（§9.1）。

### 5.2 `ensureMirror`（存在性：克隆 / 修复 / 复用，**不负责更新**）

```ts
export function ensureMirror(input: {
  workspaceRoot: string;
  url: string;
  /** 测试注入用；缺省取常量 */
  timeoutMs?: number;
}): { mirrorDir: string; created: boolean };
```

1. 算 `mirrorDir`。
2. **就绪判据**：`<dir>/HEAD` 是文件且 `<dir>/objects` 是目录 → 已就绪（不是「目录存在」：克隆中途失败会留下一个没有 objects 的半成品，沿用缓存那条口径）。
3. 已就绪 → 直接返回 `created: false`（**不联网**）。
4. 未就绪 → 清掉残留的半成品目录 → `git clone --mirror --quiet <url> <dir>.tmp-<pid>`（cwd = `remotes/`）→ 成功后 `renameSync` 原子改名，`created: true`。失败时清掉 `.tmp-*` 再抛。
5. **rename 时目标已存在**（另一个请求刚好建好了）：当作成功，复用既有目录（不覆盖、不报错），`created: false`。
6. 目录存在但**内容损坏**（有目录无 objects）→ 删掉重建；删除失败给中文 `INTERNAL`（与 `copyWorkspace` 的「缓存状态损坏」同一处置口径）。

**为什么更新不在这里做**：不同调用方对「要不要联网」的要求相反——候选列表要快（不联网）、校验要新鲜（联网）、评测准备必须新鲜（联网）。把 `fetch` 混进 `ensureMirror` 会让准备路径连着 fetch 两次（`ensureMirror` 一次 + 基线解析一次），也让「候选不联网」这条口径无法从签名上看出来。故**更新是独立的一次调用**（§5.3），由调用方按自己的语义决定。

### 5.3 `fetchMirror`（更新）与镜像记录

```ts
export function fetchMirror(mirrorDir: string, url: string, options?: { timeoutMs?: number }): { fetchedAt: string };
```

1. `git -C <dir> fetch --prune`（`--mirror` 克隆的 config 里 `remote.origin.mirror=true`，普通 `fetch` 即镜像语义的全 refs 同步）。
2. 成功后原子写镜像记录 `<dir>/aieval-mirror.json`：`{ url, fetchedAt }`（与缓存来源记录同口径：写失败只 WARN，不影响本次结果）。
3. 失败按 §8 分类抛错，**不吞**：调用方必须知道自己读的是不是最新的。

镜像记录的用途只有两个：诊断（排查「这个目录到底是哪个远端」）与回显「更新于 HH:mm」。它**不参与就绪判据**（判据是 §5.2 第 2 条的内容检查），缺失或不可解析都按「没有记录」处理、不重建。
**写记录的时机有两处**：`fetchMirror` 成功后（主要路径），以及**首次克隆成功后**（`ensureMirror` 里，否则刚建好的镜像没有 `fetchedAt` 可回显，而候选/校验路径可能在第一次 fetch 之前就读它）。两处都只 WARN 不抛。
**写法是普通 `writeFileSync`（不要求原子）**：它是缓存注解而不是真相，写到一半崩溃只会留下一个不可解析的文件，而读侧对不可解析一律按「没有记录」处理（安全方向：宁可回显「没有记录」，也不谎报一个更新时间）。记录里的 `url` 存**归一形态**（与镜像 key 的输入同一个串），不是用户输入的原文。

### 5.4 `probeRemote`（校验快路径，不克隆）

```ts
export function probeRemote(url: string, options: { cwd: string; timeoutMs?: number }):
  { defaultBranch: string; tip: string }   // tip = 40 位
```

`git ls-remote --symref <url> HEAD`，从 `ref: refs/heads/<name>\tHEAD` 与 `<sha>\tHEAD` 两行解析。`cwd` **由调用方显式给**（api 层传 `{workspaceRoot}/remotes/`，必要时先 `mkdirSync`）；刻意不回落 `process.cwd()`——那会把「服务进程恰好在一个仓库目录里」变成隐式输入（`ls-remote` 不写工作树，cwd 只影响 git 的解释上下文）。空输出（远端没有任何 ref）→ `NOT_A_GIT_REPO`「远端仓库还没有任何提交：<url>」。失败按 §8 分类。

### 5.5 `resolveRemoteRef`（基线解析）

```ts
export function resolveRemoteRef(mirrorDir: string, url: string, input: {
  branch: string | null;        // null = 远端默认分支
  commitHash: string | null;    // 非空则优先，分支被忽略
  fetch?: boolean;              // 缺省 true：先调 fetchMirror
  timeoutMs?: number;
}): string;                     // 40 位具体 hash
```

解析顺序（每一步失败都带上下文，文案见 §8）：

1. `fetch` 为 true（缺省）→ `fetchMirror(mirrorDir, url)`。
2. `commitHash` 非空 → `git -C <dir> cat-file -e <hash>^{commit}` 判定存在 + `rev-parse <hash>^{commit}` 归一；找不到 → `INVALID_REF`。
3. `branch` 非空 → `refs/heads/<branch>^{commit}`；不存在 → `INVALID_REF`「分支不存在」。
4. 否则 → 远端默认分支：`git -C <dir> symbolic-ref --short HEAD`（`--mirror` 克隆时镜像的 HEAD 就是远端的 HEAD），再 `rev-parse refs/heads/<name>^{commit}`；`symbolic-ref` 失败时退回 `rev-parse --abbrev-ref HEAD`；两者都失败 → `NOT_A_GIT_REPO`「无法确定远端默认分支：<url>」。**这一路不联网**（不塞 `probeRemote` 进来：镜像里的 HEAD 已经是远端的事实，读它不需要再连一次）。

### 5.6 非交互与超时

- 远端调用统一走**同一个** `execute` 封装（把 `git.ts` 里的 `execute` / `gitMessage` 抽到 `packages/server/core/src/git-exec.ts`，`git.ts` 与 `mirror.ts` 共用——远端调用不允许另起一套进程封装），并新增两个可选参数：`env`（追加环境变量）与 `timeoutMs`（`execFileSync` 的 `timeout`，到点杀子进程）。
- 固定注入：`GIT_TERMINAL_PROMPT=0`（禁止 HTTPS 交互式账密）、`stdin: 'ignore'`（ssh 拿不到 TTY，缺 key 时立即失败而不是等待）；`GIT_SSH_COMMAND` **仅当进程环境里没有它时**才追加 `-o BatchMode=yes`（不覆盖用户自己的 ssh 配置，也不改 known_hosts 口径）。
- 常量：`REMOTE_PROBE_TIMEOUT_MS = 15_000`、`REMOTE_TRANSFER_TIMEOUT_MS = 600_000`。两者都可由调用方覆盖（测试用 1ms 制造确定性超时）。
- 超时判定：`execFileSync` 因超时被杀时抛出的错误带 `signal`（`SIGTERM`）且 `status` 为 null → 折成 `REPO_UNREACHABLE`「远端仓库拉取超时（超过 10 分钟）：<url>（已终止 git 进程）」。**不得**把它归到 `NOT_A_GIT_REPO`（那会把用户指向「改地址」）。

### 5.7 并发不变量

- 同进程内：镜像操作是同步 git 调用，天然串行（与 `prepareRowWorkspace` 同一条不变量）。
- 跨请求（页面的校验请求与正在准备的评测）：由「克隆到 `.tmp-<pid>` + 原子 rename + 目标已存在即复用」兜住——最坏情况是一个请求白克隆一次并丢弃，不会出现半成品被使用。
- 多实例（同机跑两个 dev server）：不保证（单实例假设，记入 §10）。

### 5.8 与既有函数的关系

`ensureCaseCache` / `cloneCaseCache` / `refreshCacheToSourceHead` / `checkoutRow` / `resolveBaselineCommit` / `copyWorkspace` / `collectDiff` 的**行为一行不改**。远端来源在调用它们之前已被解析成「本地镜像路径 + 具体 commit hash」，走的完全是本地路径那条既有链路（缓存克隆的 origin 记录因此记的是镜像路径：换 URL → 镜像路径变 → 来源比对自动命中「来源已变」并重克隆，这条既有守卫不加代码就继续有效）。

`git.ts` 里只有两处签名级的补充，都是本设计的契约变更带来的、与「是否感知 URL」无关：

- `resolveRepoInfo` 返回值补上 `RepoInfo` 新增字段的本地常量取值（`kind: 'local'`、`mirrorPath: null`、`mirrorReady: false`、`mirrorFetchedAt: null`、`tip: null`）；
- `listCommits(repoPath, limit = 20, ref: string | null = null)` 增一个可选 ref（远端候选要按镜像里的具体 ref 读历史），不传时行为与现在逐字相同。

---

## 6. api / evaluator 接线

### 6.1 `validateRepo`（`packages/server/api/src/cases.ts`）

| 来源 | 行为 |
|---|---|
| local | 现状：`resolveRepoInfo(path)`，回 `kind:'local'`、`mirrorPath:null`、`mirrorReady:false`、`tip:null` |
| remote | `probeRemote(url, { cwd: remotes/ })` →（镜像未就绪时）`ensureMirror(...)`（首次克隆，慢）→ `fetchMirror(...)`（增量更新，通常 1–3 秒）→ `resolveRemoteRef(dir, url, { branch: repoBranch, commitHash: null, fetch: false })`（既有校验的同一精神：**先探活再判定**，分支不存在在这里就拦下）→ 回 `kind:'remote'`、`repoName`（`repoNameFromSource`）、`branch`（`repoBranch ?? defaultBranch`）、`tip`（上一步 40 位 hash 的 7 位短形态）、`mirrorPath`、`mirrorReady:true` |

远端校验**不 checkout、不碰工作树、不建行工作区**。`repoBranch` 填了但分支不存在 → `INVALID_REF`「分支不存在：feat/x（远端：<url>）」。镜像已就绪时 `ensureMirror` 是纯本地操作（不联网），联网只发生在 `probeRemote` 与 `fetchMirror` 两处。

### 6.2 `listCommitCandidates`（同上文件）

| 来源 | 行为 |
|---|---|
| local | 现状：`listCommits(path)` |
| remote | `ensureMirror`（就绪则纯本地检查，**不联网**；未就绪时才克隆，慢，界面有 loading 与文案见 §7）→ `resolveRemoteRef(dir, url, { branch: repoBranch, commitHash: null, fetch: false })` 取到该 ref 的 40 位 tip（分支不存在 → `INVALID_REF`，与校验同一归因）→ `git -C <dir> log --format=%h%x09%s -n 20 <tip>`。复用 `resolveRemoteRef` 而不是自己算 ref 名：默认分支的取名只在一处实现 |

「候选只是便利、手工输入任意合法 hash 仍可行」这条口径不变。

### 6.3 `createCase` / `updateCase`

- 形态判定走 `parseRepoSource`（不支持 `ftp://` 之类 → `INVALID_QUERY`）。
- `repoBranch` 一致性：本地来源 + 非 null 分支 → `INVALID_QUERY`「本地目录来源不支持分支（当前只支持远端来源指定分支）：<path>」。这条**按值判**（与既有的 `repoChanged` / `commitTouched` 同一形状），避免 UI 的全量补丁把无关保存拦下。
- 远端来源的分支 / commit 判定：`ensureMirror` 就绪后**先在镜像里判**（`resolveRemoteRef(dir, url, { branch, commitHash, fetch: false })`）；判不过时**只 `fetchMirror` 一次再判**，仍判不过才抛（分支不存在 → `INVALID_REF`，commit 不存在 → `INVALID_REF`，文案点名远端 URL）。这条「先本地判、失败只抓一次、仍失败才报错」照抄 `ensureCaseCache` 既有的口径——远端刚推上来的分支/提交不该因为镜像还没更新而被拒。「坏值不在写入口放行」这条既有口径对远端同样成立。
- 落盘：`commitHash` 归一成 40 位；`repoBranch` trim 后落盘（空串 → null）。
- 删除用例：只删 `{workspaceRoot}/cases/{caseId}/cache`（现状），**不动镜像**（D11）。

### 6.4 `generateJudgePrompt`

只用仓库名 → 远端直接取 `repoNameFromSource`，不需要镜像、不联网。

### 6.5 `runs.ts`

创建评测时把用例的 `repoPath` 与 `repoBranch` 一并快照进 `EvalRun`（`commitHash` 现状不变）。读侧（列表/详情）不需要额外网络操作。

### 6.6 `orchestrator` 准备阶段

远端来源的准备时序（`runRowAttempt` 的第 1/2 步之前）：

1. `parseRepoSource(run.repoPath)`；
2. remote → `const { mirrorDir } = ensureMirror({ workspaceRoot: run.workspaceBase, url })`（不存在则克隆；**不联网**更新）；
3. `const baseline = resolveRemoteRef(mirrorDir, url, { branch: run.repoBranch, commitHash: run.commitHash })`——缺省 `fetch: true`，**这是本轮唯一一次 fetch**（分支 tip 在这里被重新解析）；
4. `prepareRowWorkspace({ workspaceRoot, caseId, repoPath: mirrorDir, runId, rowId, commitHash: baseline, branch })` —— 传**具体 hash** 而不是 null：镜像刚 fetch 过，缓存只需从镜像取对象（`ensureCaseCache` 的「缓存里没有就 fetch」分支），不走 null 的「刷新到来源 HEAD」分支；
5. `EvalRow.baselineCommit` = 第 3 步的 hash（R2「准备后必须是 40 位具体 hash」不破）。

本地来源走原路（`repoPath` 直接交给 `prepareRowWorkspace`，`commitHash` 原样传 null / hash）。

### 6.7 基线解析规则总表

| 来源 | `repoBranch` | `commitHash` | 基线 |
|---|---|---|---|
| local | null | null | 现状：缓存刷新到来源仓库当前 HEAD（`commitHash: null` 的既有语义） |
| local | null | hash | 现状：`assertCommit` |
| local | 非 null | 任意 | 写入口就 `INVALID_QUERY`（到不了准备阶段） |
| remote | null | null | 远端**默认分支** tip（每次评测 fetch 后重新解析） |
| remote | `feat/x` | null | `refs/heads/feat/x` 的 tip（每次评测 fetch 后重新解析） |
| remote | 任意 | hash | 该 commit（镜像里没有 → fetch 一次 → 仍没有 → `INVALID_REF`） |

注意 local 与 remote 的「默认分支 HEAD」**不是同一个东西**：local 取来源仓库**当前检出的 HEAD**（可能停在特性分支上），remote 取**远端默认分支**。这是两种来源的固有差异，写进文案与本文档，不试图统一。

### 6.8 阻塞代价（明确记录）

第 2/3 步是同步 git 调用：网络慢时整个 Node 进程阻塞（页面其它请求、SSE、终止操作都排在后面）。这是 D12 的已知代价，用 10 分钟墙钟上限兜底，并在 §10 记为已知限制。

---

## 7. 界面

### 7.1 用例表单（`packages/client/ui/src/composite/case-form-panel.tsx`）

- 「代码仓库」上方加**来源切换**（`Radio.Group`：本地目录 / 远端仓库），纯展示层状态，落到同一个 `repoPath` 字段；编辑态按来源形态回填。
- 本地态：现状（路径输入 + 「校验」+ 成功回显「仓库：X · 当前分支：main」）。
- 远端态：URL 输入 + 「分支（留空 = 远端默认分支）」输入 + 「校验」；成功回显「仓库：rbac-server · 默认分支：main · tip abc1234 · 镜像：已就绪（更新于 12:04）」。
- 「重新加载候选」在远端首次点击可能触发克隆（若用户跳过了校验）：按钮 loading + 文案「正在拉取远端仓库…」（背后有 10 分钟上限）。
- 校验按钮在远端首次点击同样会克隆，沿用既有 `validating` loading 态，提示文案改为「正在校验并拉取远端仓库…」。
- 「代码仓库」的 `extra` 文案按来源切换：本地 = 现状那句；远端 = 「认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据」。
- 字段级校验：本地要求「请填写代码仓库的本地绝对路径」；远端要求「请填写 git 地址（ssh:// / http(s):// / git:// / file:// / user@host:path）」。

### 7.2 列表 / 详情 / 评测页

| 位置 | 显示 |
|---|---|
| 用例列表「仓库名」列 | `repoNameFromSource`（远端从 URL 末段取） |
| 用例详情「代码仓库」 | 远端显示 URL（等宽）+ 分支行（有则显示「分支：feat/x」，无则「默认分支」） |
| 评测列表 / 详情的仓库列 | `run.repoPath`（URL 原文），有分支时并排显示 |
| 「创建评测」的用例下拉（`run-create-panel` 的 `repoNameOf`） | 改用 `repoNameFromSource`（URL 末段），不再只按路径分隔符切分 |

### 7.3 不做的界面

设置页不加任何凭据/镜像管理项；不做镜像容量与清理入口（§2 的「不做」列）。

---

## 8. 错误处理与文案

### 8.1 分类表

| 触发 | 错误码 | 中文文案（`<原文>` = git stderr 摘录，同时进 `context.gitMessage`） |
|---|---|---|
| SSH/HTTPS 凭据不可用 | `AUTH_FAILED`（401，`context.host`） | `远端仓库认证失败：<host>（请确认本机 SSH key 已加入 ssh-agent，或 HTTPS 凭据助手可用）` |
| DNS 解析失败 | `REPO_UNREACHABLE` | `无法解析远端主机：<host>（<原文>）` |
| 连接超时 / 连接被拒 / 网络不可达 | `REPO_UNREACHABLE` | `无法连接远端仓库：<host>（<原文>）` |
| SSH 主机指纹未信任 | `REPO_UNREACHABLE` | `SSH 主机指纹未信任：<host>（Host key verification failed；请先在本机手工 git clone 一次以确认指纹）` |
| 拉取超时（墙钟上限） | `REPO_UNREACHABLE` | `远端仓库拉取超时（超过 10 分钟）：<url>（已终止 git 进程）` |
| 远端不存在 / 无权访问（远端同形报 not found） | `NOT_A_GIT_REPO` | `远端仓库不存在或无权访问：<url>（<原文>；私有仓库在凭据不可用时也会这样报）` |
| 远端没有任何提交 | `NOT_A_GIT_REPO` | `远端仓库还没有任何提交：<url>` |
| 远端地址不是 git 仓库 | `NOT_A_GIT_REPO` | `不是 git 仓库：<url>（<原文>）` |
| 其余无法归因的远端失败 | `NOT_A_GIT_REPO` | `无法读取远端仓库：<url>（<原文>）` |
| 分支不存在 | `INVALID_REF` | `分支不存在：<branch>（远端：<url>）` |
| commit 不存在（镜像 fetch 后仍无） | `INVALID_REF` | `commit 不存在：<hash>（远端：<url>，已在镜像中执行 git fetch，仍找不到该 commit）` |
| 不支持的地址协议 | `INVALID_QUERY` | `不支持的 git 地址协议：<scheme>（支持 ssh:// / http:// / https:// / git:// / file:// 与 user@host:path）` |
| 本地来源填了分支 | `INVALID_QUERY` | `本地目录来源不支持分支：<path>` |
| 镜像目录损坏且删不掉 | `INTERNAL` | `远端镜像状态损坏且无法重建：<dir>（<errno 原文>）` |

### 8.2 判别关键词（按序匹配 git 原文）

1. `Permission denied (publickey`、`Authentication failed`、`could not read Username`、`HTTP Basic: Access denied`、`terminal prompts disabled` → 认证
2. `Could not resolve host` → DNS；`Connection timed out`、`Connection refused`、`Network is unreachable`、`Operation timed out`、**`Could not connect to server`**、**`Timeout was reached`** → 不可达
   （后两条是实测补上的：本机 git 2.47 对**未监听端口**给的是 `Failed to connect to 127.0.0.1 port N after N ms: Could not connect to server`，**没有** `Connection refused` 字样；只抄经典关键词会让 spec 自己那条「未监听端口 → `REPO_UNREACHABLE`」的用例被归成 `NOT_A_GIT_REPO`。这两条同时覆盖 curl 系（`http(s)://`）的原文。）
3. `Host key verification failed` → 主机指纹
4. `repository .* not found`、`does not appear to be a git repository`、`not found` → 不存在 / 不是仓库
5. 其余 → 无法归因（同样 `NOT_A_GIT_REPO`，原文照带）

超时**不靠关键词**：靠 `execFileSync` 因超时被杀的错误特征（`signal` 有值、`status` 为 null）判定——写关键词匹配会把「远端自己报 timeout」误当成我们杀的那次。

### 8.3 原文的落点

沿用 `git.ts` 文件头第 3 条口径：**中文原因在前，git 的英文原文作为可排查的补充跟在后面**，同一份原文另放 `context.gitMessage`。远端失败尤其需要原文——「不可达」与「不是仓库」的文案很像，只有原文能区分。

---

## 9. 测试与守卫

### 9.1 core（`mirror.test.ts`，真 git，`file://` 夹具）

| 用例 | 断言 |
|---|---|
| 镜像路径稳定 | 同一 URL（含两侧空白 / 尾斜杠差异）→ 同一目录；`https` 与 `ssh` 形态 → 不同目录 |
| 首次建镜像 | `ensureMirror` 后目录满足就绪判据、`created: true`、`git -C <dir> for-each-ref` 能看到来源的全部分支（含 tag） |
| 幂等且**不联网** | 第二次调用 `created: false`，且**镜像内的提交号不变**（不重克隆、不 fetch）；用「把来源仓库删掉后再调一次仍成功」证明它没联网 |
| `fetchMirror` 更新 | 来源新增提交后 `fetchMirror` → 镜像里出现新提交，且 `aieval-mirror.json` 的 `fetchedAt` 前进、`url` 是**归一形态**（与镜像 key 的输入同一个串，§5.3） |
| 镜像记录缺失/损坏 | 删掉或写坏 `aieval-mirror.json` → 就绪判据不受影响、不重建、回显按「无记录」处理 |
| **R20 前提** | `git clone <裸镜像>` 到临时目录后 `for-each-ref refs/heads` **恰好一条**，且等于远端默认分支 |
| 半成品目录 | 手工造一个只有目录没有 `objects` 的残留 → 重建后可用 |
| tmp + rename 竞态 | 预先建好目标目录（模拟并发已建）→ 复用、不抛错、不覆盖 |
| `probeRemote` 四类 | 正常（默认分支 + tip 正确）、空仓库、不存在路径（`file:///.../nope.git` → `NOT_A_GIT_REPO`）、未监听端口（`http://127.0.0.1:<空闲端口>` → `REPO_UNREACHABLE`） |
| `resolveRemoteRef` 三条路 | 指定分支 / 默认分支 / 指定 hash 都返回 40 位 hash；分支不存在 → `INVALID_REF`；hash 不存在 → `INVALID_REF` |
| 超时映射 | 注入 `timeoutMs: 1` → `REPO_UNREACHABLE` 且文案含「超时」，**不是** `NOT_A_GIT_REPO` |
| `remotes/` 不被当评测 | 建一轮评测 + 一个镜像后 `listRuns()` 只返回那一轮 |
| 来源变更重克隆 | 用例的 URL 换成另一个镜像 → `ensureCaseCache` 的来源记录比对命中「来源已变」并重克隆（既有守卫对新来源形态继续有效）|

### 9.2 contracts

- `repo-source.test.ts`：§4.1 判定表逐行取例（含 `D:\…`、`\\host\share`、`/home/…`、`./repo`、`src:foo`、`localhost:repo`、`git@host:path`、`host.com:path`、五种 scheme、`ftp://` 拒绝、尾斜杠归一、仓库名解析）。
- `case.test.ts` / `run.test.ts`：新字段与 `.default(null)`（缺字段按 null 读、本地来源 + 分支在写契约上可表达但服务端拦）。
- `errors.test.ts`：`ERROR_CODES` 列表与 `REPO_UNREACHABLE` 的状态码。

### 9.3 api / evaluator / ui

| 位置 | 用例 |
|---|---|
| `api/src/cases.test.ts` | 远端校验回显（kind/repoName/branch/tip/mirrorReady）；本地来源 + 分支 → `INVALID_QUERY`；远端分支不存在 → `INVALID_REF` 且不落盘；远端 commit 不存在 → `INVALID_REF`；候选按分支 tip 列出；URL 场景下 `generateJudgePrompt` 取到仓库名 |
| `api/src/runs.test.ts` | `repoBranch` 进快照；旧 `run.json`（无该字段）仍可读 |
| `evaluator/src/orchestrator.test.ts` | `file://` 远端跑一行：`baselineCommit` 是 40 位、工作区内容来自镜像；**远端新增提交后重跑 → 新基线**（分支跟随语义）；远端不可达 → 该行 `failed` 且错误码是 `REPO_UNREACHABLE`/`AUTH_FAILED`，不静默用旧镜像 |
| `ui`（`case-form-panel.test.tsx` / `run-create-panel.test.tsx`） | 来源切换显示对应字段；分支字段只在远端出现；回显文案；URL 的仓库名进「标题 · 仓库名 · commit」 |

### 9.4 变异验证（AGENT.md 硬要求：没有见过失败的守卫不算守卫）

四条必须逐条做（制造缺陷 → 确认变红 → 还原 → 核对文件哈希）：

1. 「`git clone <裸镜像>` 只建一个本地分支」：改成从镜像先建额外分支再克隆 → 用例必须红；
2. 「tmp + rename」：改成直接 clone 到目标目录 → 半成品/竞态用例必须红；
3. 「超时 → `REPO_UNREACHABLE`」：把超时错误改成 `NOT_A_GIT_REPO` → 超时用例必须红；
4. 「本地来源 + 分支 → `INVALID_QUERY`」：去掉这条拦截 → 对应用例必须红。

### 9.5 环境事实（影响执行方式）

本会话的沙箱**跑不了 git CLI**（`git status`、`git ls-remote` 被拒；`git --version` 可以）。因此实现阶段的 `pnpm test`（夹具用真 git）、提交、以及真实远端冒烟，都需要一次更宽的执行权限授权，或在本机由人执行。这一点要在实施计划里显式安排。

---

## 10. 非目标与已知限制

1. **不做凭据管理**：不落 token、不选 SSH key、不做 HTTPS 账密；认证失败只能给到「请确认本机 SSH key / 凭据助手」这一层。
2. **不做 submodule 内容与 LFS 特化**：`--mirror` 不含 submodule 工作树内容，评测工作区里的 submodule 目录与本地路径来源的表现一致（空目录）。
3. **不做浅克隆**：大仓库首次克隆慢是已知代价（有 10 分钟上限与明确文案）。
4. **镜像不自动清理**、不随删用例消失、无管理 UI；改工作区根目录后旧镜像不再被看到（会重新克隆）。
5. **同步阻塞**：clone/fetch 期间整个服务进程阻塞（含 SSE 与终止操作）。这是 D12 的已知代价。
6. **不区分「私有仓库无权限」与「仓库不存在」**：远端两者同形，文案并列说明两种可能。
7. **多实例不保证镜像竞态安全**：同机跑两个 dev server 时不保证（单实例假设）。
8. **local 与 remote 的「默认分支 HEAD」语义不同**（见 §6.7 的注意），文档与文案都要说清，不做统一。

---

## 11. 裁定项（RG，实施计划必须遵守）

| # | 裁定 | 理由 |
|---|---|---|
| RG1 | 来源形态判定与仓库名解析**只在 `contracts/repo-source.ts` 实现一处**，core / api / ui 全部复用它 | 三层都要用；两份判定必然漂移，而漂移的代价是「同一个字符串在保存时是远端、在准备时是本地」 |
| RG2 | 远端 git 调用**复用同一个 `execute` 封装**（抽到 `git-exec.ts`），不另起一套进程封装；`-c core.quotepath=false` / `-c core.autocrlf=false` 两条照旧 | 中文路径与 CRLF 两条口径对镜像与缓存同样承重（镜像里的对象是工作区字节的来源） |
| RG3 | 远端调用必须带 `GIT_TERMINAL_PROMPT=0` 与 `stdin: 'ignore'`，并有墙钟超时 | 同步调用挂在请求上，交互式提示或网络黑洞会冻住整个服务 |
| RG4 | `GIT_SSH_COMMAND` **只在进程环境里没有它时**才追加 `BatchMode=yes` | 不覆盖用户自己的 ssh 配置；known_hosts 口径不替用户做决定 |
| RG5 | 镜像的**就绪判据是内容**（`HEAD` 文件 + `objects` 目录），不是目录存在 | 与缓存同口径：克隆中途失败会留下看似存在的半成品 |
| RG6 | 建镜像一律**克隆到 `.tmp-<pid>` 再原子 rename**；rename 时目标已存在即复用 | 跨请求并发下不允许出现「被使用的半成品」 |
| RG7 | core 不得感知 URL：远端到 core 之前必须已解析成「本地镜像路径 + 具体 hash」。`git.ts` 允许的改动只有两处签名级补充（`resolveRepoInfo` 补 `RepoInfo` 新增字段的本地常量、`listCommits` 增可选 ref），**行为逻辑一行不改** | D4 的边界；`ensureCaseCache`/`checkoutRow`/`collectDiff` 的既有测试不改一行仍全绿，是本设计的可验证承诺 |
| RG13 | 来源串以 `-` 开头一律拒绝（`INVALID_QUERY`）；含控制字符的拒绝 | 远端 URL 会作为**参数**传给 `git clone` / `git ls-remote`，`--upload-pack=…` 这类值会被 git 当选项解析（参数注入面）。本地路径走 `cwd` 不在此列，但同一条判定一并拦下更简单 |
| RG8 | 远端来源的 `EvalRow.baselineCommit` 必须是 40 位具体 hash | R2 的既有口径不能破：空基线会让 diff 变成空、静默给出错误高分 |
| RG9 | 分支只允许出现在远端来源；本地来源填了分支**在写入口拦下** | 不做静默忽略（用户以为生效了才是最坏的） |
| RG10 | 远端不可达时**绝不沿用旧镜像**当「当前代码」评分；错误如实抛出 | 前置 spec §3 F6 那类静默错分 |
| RG11 | 远端失败必须保留 git 原文（message 末尾 + `context.gitMessage`） | 「不可达」与「不是仓库」的中文文案接近，只有原文能区分 |
| RG12 | 镜像目录不得被复制进评测工作区（`remotes/` 与 `cases/` 平级，不进任何行工作区） | 与「来源记录放 `.git` 里」同一条理由：工作区里的额外文件会被算进 diff 与文件树，污染评分输入 |

---

## 12. 冒烟计划（实施阶段执行）

**夹具 A（无网络，全链路）**：`file:///<tmp>/origin.git`（裸仓库，含 `main` + `feat/x` 两个分支与若干提交）。

1. `/cases` → 创建用例 → 来源切「远端仓库」→ 填夹具 URL → 点「校验」→ 断言回显（仓库名、默认分支、tip、镜像已就绪）；
2. 保存 → 断言 `~/.aieval/config.json` 里该用例的 `repoPath` 是 URL、`repoBranch` 为 null；
3. 「重新加载候选」→ 断言候选来自镜像：**先把夹具仓库临时改名**（制造「远端不可达」）再点候选——候选照常列出即证明这一步没联网；随后改回。
4. 建一轮评测（假上游供应商，沿用 p5 冒烟的 `127.0.0.1:3099` 手法）→ 断言行准备成功、`baselineCommit` = 默认分支 tip、diff 抽屉可用；
5. 向夹具仓库**新增一个提交** → 重跑该行 → 断言新基线 = 新 tip（分支跟随语义）；
6. 用例改填分支 `feat/x` → 校验回显分支 tip → 重跑 → 断言基线 = `feat/x` 的 tip；
7. 负例：URL 改成不存在的 `file://` 路径 → 校验给 `NOT_A_GIT_REPO`；改成 `http://127.0.0.1:<空闲端口>` → `REPO_UNREACHABLE`；本地来源填分支 → `INVALID_QUERY`。

**夹具 B（真实远端）**：`git@coding.jd.com:FlowAI/rbac-server.git`。

1. 校验 → 断言认证走通（本机 SSH key）、回显仓库名与默认分支；
2. 建用例 + 拉候选（不真跑 agent，避免打额度）；
3. 若要跑满一轮，用最小 prompt 与单行候选，并记录耗时与镜像大小。

**记录口径**：沿用 AGENT.md 的冒烟四要素（范围清单 / 操作路径 / 证据互证 / 未覆盖项），写进本阶段的 notes 文件。

---

## 13. 文档更新（实施计划的一部分）

| 文件 | 改什么 |
|---|---|
| `README.md` 使用手册 ② 建用例 | 「代码仓库」一行改为「本地绝对路径或 git 地址（+ 可选分支）」；字段表补「分支」一行；补一句认证走本机 git、不做凭据管理 |
| `README.md` ⑥ 排障表 | 补四行：远端不可达（`REPO_UNREACHABLE`）、认证失败（`AUTH_FAILED`）、远端仓库不存在/无权限（`NOT_A_GIT_REPO`）、分支不存在（`INVALID_REF`）——处置一列写「查网络 / 配本机 SSH key / 改地址 / 改分支」 |
| `README.md`「数据落在哪」 | 补 `{workspaceRoot}/remotes/<slug>-<hash8>/`（远端仓库镜像，跨用例复用、不随删用例消失） |
| `README.md`「本期不做」 | 「云端仓库与凭据管理」改为「凭据管理（远端仓库本身已支持，认证走本机 git）」 |
| `docs/superpowers/notes/` | 实施阶段新增本阶段的接口裁定与冒烟记录（文件名由实施计划定），本文的 RG 编号是设计侧裁定，实施侧引用它 |

---

## 14. 待评审项

1. §4.1 的形态判定顺序与 scp 形态的额外条件（含 `@` 或 host 段含点）是否认可——它是「本地路径不被误判成远端」的唯一防线；
2. §6.7 里 local 与 remote 的「默认分支 HEAD」语义差异是否接受为**记录在案的固有差异**（不统一）；
3. §9.5 的执行方式：实现与测试需要更宽的执行权限（沙箱跑不了 git），是否授权我在需要时申请，或由你在本机跑测试与冒烟。
