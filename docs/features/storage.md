# 数据与存储

## 定位

平台全部落盘事实的地图：配置、**用例文件**、评测产物、事件日志各落在哪、怎么写、坏了怎么读。核心纪律：**写盘必须原子、读盘必须容忍、损坏必须说人话**。

## 页面形态与交互

存储位置一览：

| 数据 | 位置 |
|---|---|
| 平台配置 | `AIEVAL_CONFIG_DIR` > `~/.aieval` 下的 `config.json`：**两段**——应用设置 `settings` + 供应商 `providers`（`0600`、密钥明文）。**用例已不在这里** |
| MCP 服务器 | `settings.mcpServers`（同一份 `config.json` 的设置段）：name-keyed map（stdio / http 判别联合）；**键缺失才播预置两台**，删光不复播（见下节《MCP 配置的落盘与播种》） |
| 用例 | `settings.casesRoot`（默认 `~/.aieval-cases`）下的 `<用例 id>.json`：**一用例一文件**，文件名即身份（见下节《用例目录》） |
| 评测落盘根 | `settings.workspaceRoot`（默认 `~/.aieval-runs`） |
| 一轮评测 | `{workspaceRoot}/{runId}/`：`run.json`（行快照）+ `rows/{rowId}/`（`events.jsonl` + `messages.jsonl` + `workspace/` + `.agenthome/` / `.judgehome/`） |
| 用例镜像缓存 | 用例级 `cases/{caseId}/cache/`（文件系统级目录复制，不是每行克隆） |

## 用例目录

用例**一文件一落**，不放在 `config.json` 的 `cases` 数组里。理由：用例是**会被 git 管理的内容**，而配置那份文件一改就是整份覆盖写——一旦和供应商凭据同住一个文件，凭据就跟着进了历史。分家之后：一个用例一个文件，diff 干净、冲突面小到单个用例，「提交哪些变更」也有了天然的粒度。

### 布局与单文件格式

- 落点：`<casesRoot>/<用例 id>.json`，内容是**裸 `TestCase` 对象**（没有 `{ "cases": [...] }` 外壳），写法 `JSON.stringify(case, null, 2)` + 一个尾换行。
- **文件名是身份的真源**：文件名（去 `.json`）就是用例 id；文件内容里的 `id` 与文件名不一致时**以文件名**为准，并留一条 WARN（手抄文件忘改 `id` 是最常见的成因，而「同一份内容两个 id」会让查找与写入指向不同的文件）。
- id 形状判据：`CASE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`（`contracts/src/case.ts` 的 `isCaseIdShapeValid`）。它是**安全边界**：id 直接当文件名用，一个带 `/` 或 `..` 的 id 会把读写带出 `<casesRoot>`。写侧 `assertCaseId` 抛 `INVALID_QUERY` + 中文原因，读侧跳过并记进 `warnings`。
- 源码：`packages/server/core/src/case-store.ts`（`getCasesRoot` / `assertCaseId` / `caseFile` / `listCases` / `readCase` / `writeCase` / `deleteCaseFile` / `setCasesRootForTesting`）。
- 测试隔离：`setCasesRootForTesting(dir)` 覆盖根目录，与 `setConfigDirForTesting` 同构。这条是硬要求——默认根落在**真实家目录**下，批量写用例的夹具动手前必须先确认自己被指向临时目录（`getCasesRootOverrideForTesting` 就是那个安全阀）。

### 路径解析优先级

`getCasesRoot()` 的优先级是 **测试覆盖 > 设置页 `casesRoot` > `AIEVAL_CASES_ROOT` > `~/.aieval-cases`**：

- 后三档的判据**只有一处实现**：`core/src/paths.ts` 的 `resolveCasesRootForRead`——api 的设置归一化（`api/src/settings.ts` 的 `normalize`）读的是同一个函数。两处各判一次必然漂移，而漂移的症状是「设置页显示一个路径、用例落在另一个」。
- `AIEVAL_CASES_ROOT` **只做默认值**：设置页那一格一旦填过（落盘的是展开后的绝对路径）就压过它。空的 `AIEVAL_CASES_ROOT`（容器里注入空值）与「没设」等价。手改 `config.json` 把这一格写成契约默认字面量、同时又设了环境变量时环境变量会赢——这是已知代价，换来的是「设置页上看得见的那一格永远压过看不见的环境变量」。
- `~` 在读取时展开为真实家目录；下行（`GET /api/settings`）恒为绝对路径。

### 落盘与读侧口径

- **原子写**：`writeCase` 先 `mkdirSync(dir, { recursive: true })`，写临时文件 `<file>.tmp`（创建即 `0600`，再 `chmod` 兜底一次）→ `renameSync` 覆盖。与 `config-store` 同源：**不先删目标再 rename**。rename 失败按目标是否只读（`statSync(file).mode & 0o200`）决定「先删再重试」还是「直接重试」——把杀软瞬时占用当只读处理，只会白白制造一个「用例文件不存在」的窗口。
- **不产 BOM，但读时容忍 BOM**（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json` 默认带，`JSON.parse` 遇到就抛）：读侧先 `.replace(/^\uFEFF/, '')`。
- **目录不存在 = 还没有用例**，不是错误（首次使用、刚改过 `casesRoot` 都是这个状态），`listCases` 回空列表。
- **读侧宽容、写侧严格**：`listCases` 跳过坏文件并把原因带进 `warnings`（文件名不合 id 形状 / 读不出 / 不是合法 JSON / 内容不是对象），一条坏文件不让整页列表 500；`readCase` 对坏文件抛**含文件路径**的中文 `INTERNAL`（把它说成「不存在」会让用户去别处找，而真正该做的是修好或删掉那个文件），文件不存在才回 `null`。`deleteCaseFile` 幂等：文件本来就不在也算成功。
- 坏文件的出口是**界面**：`/cases` 列表页读到 `warnings` 就出一条 warning Alert「有 N 个用例文件被跳过，这些用例没有显示出来」+ 逐条原因（`apps/web-next/app/cases/page.tsx`）。存储层只跳过、**不删**——这个文件不是我们建的，什么时候清理由用户决定。

### 手工迁移（旧 `config.json` 的 `cases` 数组）

**不做迁移、不做兼容**：`loadConfig`（`core/src/config-store.ts`）只认 `settings` + `providers` 两段，落盘文件里多出来的 `cases` 键在读盘时被**静默丢掉**（不提示、不双写）。升级后用例列表会变空，手工搬运步骤：

1. 停掉正在保存用例的操作（页面 / 脚本），避免迁移途中被覆盖。
2. 打开配置目录（`AIEVAL_CONFIG_DIR` > `~/.aieval`）的 `config.json`，取 `cases` 数组里每一条的 `id`。
3. 在 `casesRoot`（默认 `~/.aieval-cases`，与设置页「用例目录」那一格一致）下按 `<id>.json` 落盘，内容就是那条用例对象本身——**裸 `TestCase`**，不要带 `{ "cases": [...] }` 外壳。
4. 顺手把 `config.json` 里的 `cases` 键删掉（留着也无害，读侧已经忽略它）。
5. 刷新 `/cases`：被跳过的坏文件会出现在列表页的告警条里，逐条修或删。

### 用例变更的 git 同步

`casesRoot` **本身就是 git 仓库根**时（判据 `core/src/case-git.ts` 的 `isRepoRoot`：`rev-parse --show-toplevel` 与目录的物理路径相等，不是「在某个仓库里」——只判后者会把用户家目录下的任意大仓库当作用例仓库），用例变更会被后台同步进 git。编排在 `api/src/case-sync.ts`，git 原语在 `core/src/case-git.ts`，状态契约在 `contracts/src/case-sync.ts`。

- **不阻塞保存**：用例落盘的 HTTP 响应立刻返回，同步在后台跑（`api/cases.ts` 的 `scheduleSync` → `enqueueCaseSync`，**绝不 `await`**）。人工点「提交 / 拉取」是**动作**，那条路径把结果等回来（按钮的 loading 与结果都要真实）。
- **1 秒防抖 + 串行 + 后来者合并**：连续保存（改标题 → 改题面 → 换评分表）合并成一轮；同一时刻只有一轮同步在跑，跑动期间的多次变更合并成**一轮**收尾同步——两个同步同时 commit / push 只会自己跟自己冲突。
- **逐文件提交**：一个变更文件一个提交，N 个变更文件产出 N 个提交（`commitFile` 先 `git add -A -- <path>`——只 stage 这一个路径，且这个路径已经没有变更时**什么也不做**，不产空提交——紧接着 `commit`）。**提交动作由本模块执行，智能体只写提交信息**——逐文件是**不变量**，而模型自主提交只是「大概率照做」，它还可能顺手 `git add -A`、把无关文件卷进历史。
- **提交信息来自智能体**：每轮变更起一次「评分配置」里的智能体（路由 `resolveJudgeRoute` + `requireJudgeAgent` + `resolveJudgeEffort`，**不新增配置面**），它只读不写（提示词明写不要改文件、不要执行 git 写命令），回一段 JSON `{commits:[{file,message}]}`；每条信息压成一行、截 100 字符。智能体失败 / 超时（10 分钟 `AbortController`）/ 答复不可解析 / 漏了某个文件时，用**确定性回退文案**补齐：`新增用例「标题」` / `更新用例「标题」` / `删除用例「标题」`（状态码读不出来按「更新」，标题读不到时用用例 id）。**未配置评分配置时整块同步不跑**（状态里写明「未配置…同步需要一个智能体来写提交信息」，而不是悄悄用回退文案把文件提交掉——那样用户会以为同步链路是通的）。
- **只提交用例文件**：`<casesRoot>` 下的其他变更（README、笔记）**永不进提交**，但计数进状态（`ignoredCount`）让用户看得见。判据是「根目录下的 `<合法 id>.json`」，带目录的、名字不合 id 形状的、非 `.json` 的都算无关变更。
- **对齐远端**：有本地领先提交或人工拉取时才 `fetch`；落后且没有本地领先就快进（`merge --ff-only`）；**分叉才起智能体裁定合并**，它回来之后本模块独立校验「工作区里没有未提交的用例文件、也不再落后于远端」，不成立就中止本次合并并报错（本地提交保留）。**任何情况都不 force push**（`case-git.ts` 里根本没有 force 变体）；push 失败退避重试 3 次（步长 200ms × 次数），仍失败就把原文写进状态。仓库没配远端时提交照做、只记一条 WARN（状态 `hasRemote: false`，界面说「未配置远端：变更只提交到本地」）。
- **人工拉取的语义更严**：工作区里还有未提交的用例文件时直接拒（「有 N 个未提交的用例变更，请先点「提交」再拉取」）——拉取的语义是「跟远端对齐」，顺手替你提交会和「自动提交」开关打架。
- 状态只活在**内存**（`api/src/case-sync.ts` 的 `SyncRuntime`）：不做持久化队列、不做启动补偿（改用设置页的「提交」按钮手动补）。磁盘上的 git 事实才是真源，重启后这份快照归零不影响正确性。
- 状态接口每次读都可能要探远端：探测用的 `git fetch` 有 15 秒上限、结果缓存 30 秒（`probeRemoteState`），页面挂载不能等一次十分钟的网络往返。

## MCP 配置的落盘与播种

MCP 服务器**不另开文件**：它与主题、根目录、评分配置同住 `config.json` 的 `settings` 段，键名 `mcpServers`——一份原子写的快照里能同时看到「用什么模型评分」与「给候选注入哪些工具」，读侧只有一次 `loadConfig()`。功能面（配置 / 注入 / 失败判据）见[《MCP 配置》](/features/mcp-config)，本节点名的是**落盘事实**：

- **形状**：name-keyed map，键是服务名（也是工具名前缀 `mcp__<name>__` 里的那一段），值是传输判别联合——`{ transport: 'stdio', command, args?, env?, enabled? }` 或 `{ transport: 'http', url, headers?, enabled? }`。`enabled` 缺省 `true`；跨传输的多余字段在**贴入**时被丢掉并点名，手改文件塞进去的由消费方按「不认识」处置。
- **播种（预置两台）**：`context7`（http，`headers.CONTEXT7_API_KEY` 是 `${CONTEXT7_API_KEY}` 占位）与 `playwright`（stdio，`npx -y @playwright/mcp@latest`）。判据在 `core/src/config-store.ts` 的 `normalizeSettings` 里单独写成一句显式判断：**`source.mcpServers === undefined` 才补**——「文件里没有这个键」而不是「值为空」。
- **为什么判据是「键缺失」而不是「空 map」**：后者等于**删光即复播**，用户永远删不掉预置项。键在文件里就是「配过了」的唯一证据，空 map 与没写过因此可分（`{}` 与 `undefined` 在读侧是两件事）。守卫 `core/src/config-store-mcp.test.ts` 两条：键缺失 ⇒ 预置两台；显式存下 `{}` ⇒ 读回来仍是空，且「只读一次再原样保存」不会把它写回文件。
- **原子写的口径与 `config.json` 其余部分完全一致**（临时文件创建即 `0600` → `renameSync` 覆盖；BOM 容忍；损坏抛含路径的中文原因），不因为多了这一格而分叉——见下节《数据与契约》。
- **密钥落盘是明文**（与供应商同口径）：出口掩码只发生在 `GET /api/settings` 的投影上，`env` / `headers` 里的 `${VAR}` 占位**原样落盘**（真值只在注入那一刻从环境里解析，永不回写）。
- **行内产物不在这份文件里**：注入的落点是**行私有目录**（`{workspaceRoot}/{runId}/rows/{rowId}/.agenthome/`）——claude 走 SDK 参数不落盘、codex 走线程级 `config`、dsh 落 `aieval-route.patch.yml` 的 `insert`；行内 `.npmrc` 也只写宿主 npm 配置里的 **registry 那一行**（`0600`）。宿主 `~/.aieval/config.json` 一个字节都不因注入而变。

## 数据与契约

- **配置文件 `config.json` 是两段**：`settings` + `providers`（`core/src/config-store.ts` 的 `AppConfig`）。旧版残留的 `cases` 键（以及更早的 `rowTimeoutMs`）在读盘时被丢掉——**落盘文件里留着的东西不等于运行时认的东西**；`loadConfig` 故意不做 schema 校验（一条手改坏的值不该让设置页打不开）。设置段里的 `mcpServers` 另有一条**播种**口径：键缺失才播预置两台、删光不复播（见《MCP 配置的落盘与播种》）。
- **用例一文件一落**：`<casesRoot>/<用例 id>.json`，裸 `TestCase` JSON、文件名即身份、写盘原子且 `0600`、读时容忍 BOM、坏文件跳过并进 `warnings`——完整口径（含手工迁移与 git 自动同步）见上节《用例目录》。
- **`run.json`**（行快照）：`EvalRow` 含状态、分数（`ScoreResult` 12 格，记账格全 `.default(...)`——`safeParse` 读盘的硬理由）、diff、计量。旧 `run.json`（带 `dimensions`）`safeParse` 失败 ⇒ `listRuns` **跳过并落汇总 WARN**（不炸整页）。快照与事件同源：`setRowStatus` 改状态 + 落盘 + 追加 `status` 事件**成对**。
- **`events.jsonl`**（行级事件，执行的唯一真相源）：追加写、`seq` 单调递增、按 `seq` 去重续订（`Last-Event-ID`）。**读侧容忍坏行**：写一半的 JSON、空行只跳过该行并 WARN，其余按原序全量读出（可用性优先于完备性）。只有候选新尝试的 `resetEvents` 清空。
- **`messages.jsonl`**（内容通道）：按 `mergeKey` / `subagentId` 覆盖累积；四格计量**不在这份文件里**（走 `usage` 事件与 `EvalRow`）；一行都不产出时不建文件。
- **写盘必须原子**：写临时文件（创建即 `0600`）→ `renameSync` 覆盖。**不要先删目标再 rename**——中间崩溃会让配置彻底消失，而 `loadConfig()` 会静默回落默认值。
- **rename 的 `EPERM` 有两种成因、处置相反**：目标是只读文件（只能先删）与杀软瞬时占用（重试即可）。判据 `statSync(file).mode & 0o200`，别无脑先删。
- **读盘必须容忍 UTF-8 BOM**（PowerShell 5.1 的 `Set-Content` / `ConvertTo-Json` 默认带 BOM，`JSON.parse` 遇到就抛）；自己落盘不要产 BOM。
- **配置损坏时抛含路径的中文原因**，别让 `SyntaxError` 冒充「请求体不是合法 JSON」。
- 测试隔离：`setConfigDirForTesting(dir)` 指向临时目录，**不得触碰真实 `~/.aieval`**；用例另有一处默认根（真实家目录下的 `~/.aieval-cases`），用 `setCasesRootForTesting(dir)` 覆盖。

## 状态机与时序

- 用例写盘点：`writeCase` 原子替换单个文件；写完之后由 `api/cases.ts` 的 `scheduleSync` 按 `casesAutoCommit` 决定要不要排一次后台同步（**不 await**）——逐文件提交、推送与冲突裁定的时序见上节《用例目录》的「用例变更的 git 同步」。
- 评测的写盘点：事件追加 `events.jsonl`（每事件一条，`at` 是本项目写入时间）+ 快照写 `run.json`（每次状态变更）。`usage` 回写判据：`tokensBasis === 'reported'` 才写快照（`'estimated'` 只走事件流）。
- 服务重启：`recoverInterruptedRuns` 把仍处 `running` / `preparing` / `judging` 的行标 `interrupted`。
- 历史产物删除、不做读侧兼容（旧 v1 七型 `events.jsonl` 整轮目录不提供读入口）；契约新增**可选**格例外——读侧把「键缺席」与显式 `null` 当同一件事。

## 已知边界与取舍

| 边界 | 处置 |
|---|---|
| 旧 `config.json` 的 `cases` 数组**不迁移也不读** | 已登记的破坏性变更：`loadConfig` 只认 `settings` + `providers`，旧键静默丢掉，升级后用例列表为空；处置见《用例目录》的「手工迁移」 |
| `settings.mcpServers` 删光（`{}`）后不再复播预置两台 | 有意为之：判据是「键缺失」不是「值为空」——否则用户永远删不掉预置项；要拿回预置项就手删 `config.json` 里那个键（下次读盘即播种） |
| 改 `casesRoot` 不迁移已有用例文件 | 旧文件原目录、列表只认新目录（那一格的 `extra` 已写明）；要搬家得手工拷文件 |
| `AIEVAL_CASES_ROOT` 只做默认值 | 设置页的 `casesRoot` 一旦填过就压过它（含手改回默认字面量的已知代价）；两处判据共用 `resolveCasesRootForRead` |
| 同步状态只在内存、不做启动补偿 | 重启后「上次同步」归零不影响正确性（git 事实在磁盘上）；漏掉的同步靠设置页「提交」按钮手动补 |
| 坏用例文件只跳过不删、不阻断列表 | 列表页的告警条是唯一出口；详情 / 执行走 `readCase`，坏文件抛含路径的中文 `INTERNAL` |
| `events.jsonl` 的追加读是 O(n²) 重放（每次追加整文件回读定 `seq`） | 已登记的取舍：单行 > 5 MB 或 > 2 万条时复测一次 |
| `~/.aieval-runs` 在受限沙箱里 dev server 写不动（一律 `EPERM`、接口全 500） | 排障先想沙箱 / 权限，再想代码 |
| diff 上限 `diffBudgetBytes` 默认 256KB，超限按文件裁剪并显式标「已截断」 | 被截断的两档（我们截 / 厂商截）都不得写「完整」 |

## 相关链接

- 知识文章：[《事件流》](/protocols/event-stream)（`events.jsonl` 的协议侧）、[《行执行与日志》](/features/row-execution)（八步时序的落盘点）、[《设置》](/features/settings)（workspaceRoot 与 casesRoot 的配置面、用例变更自动提交开关）、[《MCP 配置》](/features/mcp-config)（`settings.mcpServers` 的功能面与行内注入落点）、[《用例管理》](/features/case-management)（用例的读写、列表与删除侧）、[《评分》](/features/judging)（ScoreResult 记账格）
- 仓库内参考：AGENTS.md「持久化」节（原子写 / BOM / EPERM 口径的真源，互链不复制）
