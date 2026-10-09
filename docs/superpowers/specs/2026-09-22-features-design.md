# AI 生成代码评测工具 —— 功能设计

日期：2026-09-22
状态：已定稿
前置：`docs/superpowers/specs/2026-09-22-scaffold-design.md`（脚手架设计）
性质：本文档**自包含**，覆盖三个功能域（用例 / 评测 / 设置）的完整行为、数据模型、执行时序与错误处理，以及全部**功能面**（智能体评分、结构化评分输出、评分标准项、远端 git 来源、上下文窗口与思考强度（候选行与评分两侧）、单行执行、评测的修改与删除、变更详情抽屉、测试墙钟、子智能体用量）。技术栈、分包结构、界面原语的实现契约见脚手架设计文档，本文不重复。

**写法约定**：每小节自包含，顺序固定为**口径 → 契约 → 落点 → 实现路径 → 守卫**；契约里的字段名与派生函数是**硬接口**，跨端实现按它们对齐。文中只写最终方案，不写决策过程。

**功能面落点速查**：

| 功能面 | 落在 |
|---|---|
| 两条评分通路（含重新评分） | §5.5.1 · §5.3.2 |
| 结构化评分输出 | §5.6.4 |
| 评分标准项（组 → 项的权重表） | §4.3 · §7.3 |
| 远端 git 来源（自动镜像） | §4.5 |
| 候选行的上下文窗口与思考强度 | §5.1.1 |
| 评分的思考强度（配置 + 两条通路 + 记账） | §5.5.2 · §6.2 |
| 单行执行 | §5.3.1 |
| 评测的修改与删除 | §5.3.3 |
| 变更详情抽屉 | §5.3.4 |
| 测试墙钟（进程创建预算） | §9.1 |
| 子智能体用量与轮次口径 | §7.5 |
| 活动行（流信息）统一词表 | §5.6.9 |

---

## 1. 要解决的问题

比较不同模型与智能体写代码的能力，目前只能靠零散的对话记录和主观印象，缺少可复现、可横向对比的依据。

本工具固定「同一道题 + 同一起点」，让每个候选（模型 × 智能体）在隔离的工作区里各自独立完成一遍，再用同一把尺子打分，最后并排比较。

成功标准：

1. 固定用例（仓库 + commit + 考题提示词）后，任意候选的产出可被完整复现与追溯。
2. 一轮评测里多个候选的结果可直接横向比较：分数、token、轮次、耗时、代码改动五者可对照。
3. 一次评测从创建到出分，除「配置供应商」与「评分配置」（默认评分模型；智能体评分另需默认评分智能体）外无需人工干预。
4. 候选跑失败时，失败原因在界面上可读、可定位（日志 + 错误信息），且不影响其他候选。

非目标（本期明确不做）：分布式执行、多用户与权限、**凭据管理**（远端仓库的认证一律用本机 git 的 SSH key 与凭据助手，工具不保存任何**远端仓库**凭据——供应商 apiKey 的明文落盘与掩码口径见 §6.1）、自动合并或改进被测代码、历史评测的趋势统计。

---

## 2. 本阶段范围

在脚手架（monorepo、分包、界面原语、主题、列表 + 右栏形态）之上实现三个功能域：

| 域 | 内容 |
|---|---|
| **用例管理** | 用例 CRUD、代码来源（本地 / 远端）与 commit 校验、评分标准项（表格 + 智能生成 / 智能识别） |
| **评测管理** | 创建评测（候选行 × 执行模式 × 思考强度）、执行编排、实时进度、单行执行与重评、修改与删除、产物查看（日志 / 变更详情 / 评分详情） |
| **设置** | 模型供应商（协议类型 + 模型清单 + 窗口与输出上限）、评分配置（默认评分模型 + 思考强度 + 默认评分智能体）、工作区目录、界面主题 |

脚手架阶段的 `/demo` 示例页在真实用例页落地后**删除**。

---

## 3. 功能域关键决策与理由

工程与界面层面的决策见脚手架设计文档。以下是**功能语义**层面的决策：

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| F1 | 供应商分 `openai` / `anthropic` 两种协议类型 | 协议类型只决定「模型能否驱动某智能体」，**不决定能不能拉模型清单**——清单按地址形态兜底（§6.1），故两种协议都可拉 | 全放开、运行时再报错（用户在等待十分钟后才发现配错） |
| F2 | 模型下拉框**按协议类型过滤**：选中的智能体决定哪些供应商的模型可选 | 不可行的组合在创建阶段就消失，而不是等到运行时炸。判据是「智能体接受的协议**集合**」`protocolTypes`（DSH 同时讲 `openai` 与 `anthropic` 两条 wire，单值会让它白丢一半候选池），四处消费点统一走 `acceptsProtocol()`（§5.6.2） | 不过滤（体验差，且错误信息难以理解） |
| F3 | 两条评分通路，**每一次评分只用一条**：① 纯文本 API，不入仓库、不跑智能体；② **智能体评分**——由一家 CLI 在该行工作区内自行查阅文件（通路在评分那一刻读 `EvalRun.useAgentJudge`；编辑可以改它，见 §5.5.1，所以同一轮里**先文本后智能体**是可能的） | 第 ① 条成本低、快、完全可复现，但要求「评分表 + diff」一次装进上下文窗口；改动超过窗口时只剩「请求失败」或「按预算裁掉一部分文件」两条路，而后者**分数照样出得来**（只是建立在残缺输入上）。第 ② 条让评审者按文件读、按需读，输入不再是一段文本 | 只做文本通路（大改动只能靠裁剪，分数静默失真） |
| F4 | 尺子是**评分标准项**：组 → 项的表格（`ID` / `目标` / `权重`），每项二元判定（达成 / 未达成），**没有部分分** | 权重表让「这道题什么更重要」由用例自己说清；二元判定把「模型自报分数算错」这一整类问题从根上消除——总分 = **达成项权重之和**，满分 = 全部项权重之和（不固定 100 分），满分快照进这一分 | 固定维度各 1–5 分等权（权重不可表达）；模型自报总分（要专门防御它算错） |
| F5 | 评分者 = **全局默认**（设置页「默认评分模型」+ 可选「思考强度」+ 可选「默认评分智能体」） | 多数时候固定一个强模型当尺子，横向比较才成立（强度可配之后由 `ScoreResult.judgeEffort` 记账保证可比，§5.5.2）。评分模型**两种协议都可选**（文本 API 不经过智能体协议约束）；「用哪家 CLI 驱动」是独立的一格，只在智能体评分通路上生效 | 每用例必填（重复配置，横向比较时因尺子不同而失真）；用例级覆盖（多一条能绕开设置页的旁路） |
| F6 | 每候选行**独立工作区**，串行模式下也如此 | 串行若共用一个目录，第二个 agent 是在第一个 agent 的改动之上继续写，分数无意义、整轮作废 | 共享一份克隆、各建分支（`git checkout` 是全局状态，并发时会互相破坏工作树） |
| F7 | 用例级**本地缓存仓库**，每行从缓存复制 | 把「每次评测都克隆」变成「首次克隆、之后复制」，让开一轮评测从等待变成秒开 | 每行独立 `git clone`（网络开销重复 N 次） |
| F8 | 每候选行注入**独立配置目录**（`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME`） | 并行时多个 agent 会抢同一份 `~/.claude`、`~/.codex` 配置与会话文件；且 `~/.claude/settings.json` 的 `env` 块会**盖掉**我们注入的模型路由 | 共享默认配置目录（模型路由随机失效） |
| F9 | 执行模式（并行/串行）落库，**运行中不可改** | 中途切换会让 `skipped` 语义混乱；且「这一轮用什么模式跑的」本身是复现条件 | 运行中可改 |
| F10 | 服务重启时运行中的行标记 `interrupted`，**不自动续跑** | agent 子进程已随服务消失，续跑需要独立进程托管，成本远超收益 | 断点续跑；乐观假设（状态错乱） |
| F11 | 全量产物：执行日志流 + diff 浏览器 + 评分详情 | 既是「为什么得这个分」的证据，也是排障手段 | 只存分数与元数据（debug 靠猜） |
| F12 | 执行与评分都**不限时间** + **失败隔离** | 一行只会因为「跑完 / 失败 / 用户点终止」结束；时限到了就判失败，在「上游只是慢」这一档上是**把真结果丢掉**。失败隔离照旧：一行的失败不牵动其他行 | 全局超时（一行卡住全轮停摆）。**已登记的代价**：滴流的上游响应、或忽略停止信号的适配器会把这一行一直挂在 `running` / `judging`，出路只剩用户点「终止」 |
| F13 | 持久化用**磁盘文件**（JSON + JSONL 事件日志），不引入数据库 | 数据量小、查询简单（按 id 取 + 列列表）；JSON 文件人可读、可手工检查 | 内存态（重启即丢，跑了半小时的评测白费）；SQLite/Prisma（查询能力用不上，多一层迁移成本） |
| F14 | 事件日志是执行的**唯一真相源**，SSE 由它扇出 | 刷新页面 = 重读日志 + 按序号续订，天然不丢事件、可回放；不需要额外的进度存储 | 单独维护一份进度状态（两份真相必然漂移） |
| F15 | 代码来源支持**本地路径与远端 git 地址**，按形态自动判定，远端由服务端**自动镜像**到 `{workspaceRoot}/remotes/` | 来源仍是同一个 `repoPath` 字段，不新增字段、不新增入口。镜像做成**裸镜像**（`git clone --mirror`）⇒ 跨用例复用、全部分支可见、无工作树不脏；**行准备那几条原语**（`prepareRowWorkspace` / `copyWorkspace` / `checkoutRow` / `collectDiff`）只见本地路径、一行不改——远端 URL 只出现在 `core/src/mirror.ts` | 让 core 认 URL（镜像与网络逻辑渗进 git 原语）；每轮直接 clone 远端（同一 URL 重复传整份对象） |
| F16 | 智能体评分**复用「默认评分模型」那一对**，只额外选「用哪家 CLI 驱动」；评分智能体跑在**该行现有工作区**里、用独立的 `.judgehome` | 模型与凭据都已经有唯一来源，再要一份就是第二条配置真相。工作区复用是因为它正是被评对象；配置目录必须分开（两家格式不同，共用会互相破坏） | 另配一个「评分用供应商 + 模型」（两处配置漂移）；另建一份工作区副本（复制成本 + 看到的不是候选的产出） |
| F17 | 子智能体用量作为**行级分量**单列（`subagentTokens` / `subagentTurns`），合计仍是全树 | 「这个候选多省」要能拆开看：主会话与它派发的子智能体各花了多少。评分智能体**不进这三格**——它报的是评审者的成本，与候选的成本是两件事 | 只报合计（分不出是主会话贵还是派活贵）；把评分智能体也算进去（比较口径被评审者污染） |

---

## 4. 功能模块一：用例管理

### 4.1 页面形态

`/cases` 页 = 列表 + 右侧栏（用脚手架提供的 `ListDetailLayout`）。

**列表**：`Table` 列 = 标题 / 仓库 / commit（列名逐字是 `commit`；`commitHash === null` 的格子里是次要色「默认 HEAD」，非空时是 `code` 样式的 7 位短哈希 + `Tooltip` 显全量；标题与仓库两列才用 `EllipsisText`）/ 更新时间。右上「创建用例」。空态用 `EmptyState` 引导到「创建用例」。仓库名走 `displayRepoName(source)`（渲染期**任何字符串都不抛错**：读路径拿到的是已落盘的数据，一个坏行不该让整页白屏）；判定路径（写侧校验）走会抛错的 `parseRepoSource` / `RepoSourceStringSchema`——`repoNameFromSource` 与它同一口径，生产代码里只被 `displayRepoName` 引用（正常分支走它，解析失败时由 `fallbackName` 兜底），写侧不直接用它。

**右栏三种内容**（同一个栏位换内容，不叠加、不弹层；由 `?panel=detail|new|edit&id=...` 决定）：

| 右栏内容 | 触发 |
|---|---|
| 用例详情（只读）+「编辑」「删除」 | 点列表行 |
| 创建表单 | 点「创建用例」 |
| 编辑表单（同创建，预填） | 详情栏点「编辑」 |

### 4.2 表单字段

| 字段 | 控件 | 校验与行为 |
|---|---|---|
| 标题 | `Input` | 必填 |
| 考题提示词 | `Input.TextArea`（等宽字体） | 必填 |
| 代码来源 · 类型 | `Radio.Group`：远端仓库 / 本地目录 | 默认**远端**；纯展示层状态，**落到同一个 `repoPath` 字段**。编辑态按形态回填 |
| 代码来源 · 地址 | 远端：`Input`（URL）；本地：`Input`（绝对路径） | 服务端 `parseRepoSource` 判形态（§4.5 表一）。失败给中文原因（控制字符 / `-` 开头 / 非白名单 scheme / 不是 git 仓库） |
| 分支（**仅远端**） | `Input`（「校验」按钮在上一格「代码仓库」的 `suffix` 上，连同分支一起校验） | 留空 = 远端默认分支。本地来源填了直接 `INVALID_QUERY`。校验通过回显 `仓库：{repoName} · {默认分支\|分支}：{branch} · tip {7 位短哈希} · 镜像：已就绪（更新于 YYYY-MM-DD HH:mm）`（`tip` 与镜像时间**各自可缺**，缺时不占位）；本地回显 `仓库：{repoName} · 当前分支：{branch}`（这句**逐字不变**）。「默认分支 / 分支」看的是**表单里的分支输入**，不是服务端解析出的 `branch`——用户填了分支却看到「当前分支：main」会以为填的没生效 |
| commit hash | `AutoComplete`（候选项 = 最近 20 条提交，**可手工输入任意合法 hash**） | 留空 = 默认分支 `HEAD`；填了必须 `git rev-parse --verify <hash>^{commit}` 通过（一条命令判定存在并把短哈希归一成 40 位） |
| 评分标准项 | 表格编辑器（§4.3） | 提交时按 `validateRubric` 判（与后端**同一份判据**） |

**表单里没有评分模型**：用例**不持有** `judgeProviderId` / `judgeModelId`（评分与生成一律走设置页的全局默认），也**没有** `judgePrompt`（自由文本的评分要求已由评分标准项取代）。

`extra` 文案按来源切换；远端那句必须写明「认证使用本机 git 的 SSH key / 凭据助手，工具不保存任何凭据」。

**commit 候选**：候选由「重新加载候选」按钮（挂在同一格 `Form.Item` 的 `extra` 槽）取回，作为 `AutoComplete` 的 `options` 列出最近 20 条提交（`git log --format=%h%x09%s -n 20`，远端取该 ref 的 40 位 tip 再 log），选中即填入短哈希。纯便利功能——**手工输入任意合法 hash 必须仍然可行**（不能只允许从候选里选）。

### 4.3 评分标准项（组 → 项的权重表）

**口径**

- 评分表是**组 → 评分项**的二级表格，每项三列：`ID` / `目标` / `权重`；模型对每一项做**二元判定**（达成 / 未达成），**没有部分分**。
- `总分 = 达成项权重之和`；`满分 = 全部项权重之和`（由表格决定，不是常量 100）。满分**快照**进 `ScoreResult.maxScore` ⇒ 改了表之后历史分仍自洽。
- 评分表**快照进轮次**（`EvalRun.rubric`），跑一行时**读快照、不读用例**；改了用例的表，历史记录一个字节都不变，「重新评分」用的也仍是当初那把尺子。
- `RubricSchema` **刻意不设 `.min(1)`**：空表 `{ groups: [] }` 是新建用例的真实初态，非空要求只由 `validateRubric` 在**提交时**给出。
- 项的 `id` 允许为空：空 id 的项按**位置**分配引用键 `#k`（全表顺序号，跨组连续，按 `trim()` 判空）。`validateRubric` 额外断言**生成的引用键两两不同**——两把相同的键会让模型的一次判定被同时记到两项上，分数悄悄多出一块而界面一切正常。
- 两个生成按钮都是**一次非流式文本调用**（`callTextApi`）：**不建工作区、不起 CLI、不走 `AgentJudgeInput`**。这条口径只管生成与识别，**不管评分**。

**契约（`contracts/src/rubric.ts`）**

```ts
export const MAX_ITEM_WEIGHT = 10_000;                     // 防 safe-integer 越界 / 满分失去意义 / 手滑多打零

export const RubricItemSchema = z.object({
  id: z.string().default(''),                              // 空 ID 的项按位置分配引用键 `#k`
  goal: z.string().min(1),                                 // 自足判据：既说清改哪里，也说清怎样算达成
  weight: z.number().int().positive().max(MAX_ITEM_WEIGHT),
});
export const RubricGroupSchema = z.object({ name: z.string().min(1), items: z.array(RubricItemSchema) });
export const RubricSchema = z.object({ groups: z.array(RubricGroupSchema) });  // **不设 .min(1)**（空表是真实初态）

export function rubricMaxScore(rubric: Rubric): number;                        // 空表返回 0
export function rubricItemKeys(rubric: Rubric): string[];                      // 有 id 用它，没 id 用 `#k`（全表跨组连续）
export function validateRubric(rubric: Rubric): { ok: true } | { ok: false; message: string };
export function composeTotalScore(rubric: Rubric, judgments: readonly RubricJudgment[]): number;
export function renderRubricForJudge(rubric: Rubric): string;                  // 两条评分通路共用同一份
```

`validateRubric` 是**提交用例时**的唯一判据（界面与后端共用）：至少一组、每组至少一项、组名非空、目标非空、权重正整数、id 不重复、**引用键不重复**。返回的是可直接展示的中文原因（点名哪一组、哪一项），不是笼统的「表格不合法」。

`renderRubricForJudge` 渲染 Markdown 二级表格，第一列是**引用键**（模型据此指认「我评的是哪一项」）。组名、引用键与目标**走同一份转义**：它们同为自由文本（`|` 与换行都合法），漏转义会让整行列错位，而错位之后模型读到的是一张与界面不同的表。

**服务端：生成与识别（`api/src/judge.ts` 的 `generateRubric`）**

| 分支 | 触发 | 输入 | 输出 |
|---|---|---|---|
| 智能生成 | `prompt` 为空 | 题面 + 仓库名 + **当前表格** | 合并后的完整表格 + `addedItems` |
| 智能识别 | `prompt` 非空 | `prompt`（+ 可选题面）+ **不含仓库** | 识别出的完整表格（整表替换） |

四条顺序纪律：先解析评分模型路由与强度（`resolveJudgeRoute()` → `resolveJudgeEffort()`，这两个**无参**）、并当场用 `requireJudgeEffort({ effort, model, agentKind })` 校验档位 → 生成分支才做「仓库名解析」且**不联网**（远端直接取 `source.repoName`，不需要镜像）→ 最后才调用模型（前几步失败时一次模型调用都不该花掉）。

- 生成分支提示词：只输出 JSON、无围栏；分段含当前评分表（`renderRubricForJudge`）与**已有项 ID 清单**；输出契约只给**新增**组与项；四条硬约束——只新增（不许重复 / 改写 / 删除）、禁止复用已有 ID、同名组复用原名、表格已完备时返回空 `groups`（不凑数）。
- 识别分支提示词：用户原文**原样放入**、不做改写；三条硬约束——原样抽取（组数项数数字一个都不许改、不合并不拆分）、忽略与项无关的内容（组不带权重）、用户没给 ID 时留空串**不要自己编号**。
- `mergeRubric(current, added)`：按组名归位（同名组追加到该组末尾，否则新建组追加到表尾）；`added.groups` 为空且当前表非空 ⇒ 合并结果**逐字等于原表**、`addedItems = 0`（⚠️ 实现**没有提前返回**，仍会对合并结果调一次 `validateRubric`：**当前表自己不过那道门**时——例如表单里刚加的空组——这里会抛 `JUDGE_PARSE_FAILED`「评分模型返回的表格不合法：…」，把用户自己的表说成模型违约，属代码侧的口径问题）；**当前表本身也是空表**（合并后仍无组）⇒ 抛 `INVALID_QUERY`「当前评分标准项是空的，模型也没有补充任何条目…」（如实说清是哪一边的问题，不推给模型）；新增项 id 与已有 id 冲突 ⇒ `JUDGE_PARSE_FAILED`（模型违约）（⚠️ 去重与判空用的是**未 trim** 的 `item.id`，而 `validateRubric` 与引用键都按 `item.id.trim()` 走 ⇒ 新增项写 `' A1 '` 绕得过这道「复用已有 ID」检查，随后被 `validateRubric` 的 **ID 重复**分支接住（它先按 trim 后的 ID 查重、再查引用键），报的是「评分项 ID「A1」重复了」而不是这一句；只含空白的 id 也会把一格垃圾塞进 `taken`——属代码侧的口径问题，别当成文档口径）。
- 返回值 `{ rubric, addedItems, note? }`，两个分支都返回**完整表格**；识别分支 `addedItems` 固定 0。入参按 `GenerateRubricSchema` 校验（`rubric` / `taskPrompt` / `prompt` / `repoPath`，后三格默认空串）。
- HTTP 路由沿用 `/api/cases/generate-judge-prompt`（两个按钮打同一个接口，按 `prompt` 是否为空分派）。
- **这条口径的判据落两处**：`api/src/judge.ts` 的模块头注写明「这里**没有**智能体通路」「两分支都是**非流式**文本调用，都不落盘」，以及 `judge.test.ts` 的「只用全局默认评分模型」两条（一条是「api 与 evaluator 是同一个函数」的转出守卫，另一条是**生成分支**的路由取值断言（用例内传 `prompt: ''`，按 `judge.ts` 的 `prompt.trim() !== ''` 分派走的就是生成侧；它钉的是「入参里没有模型」这一形状，**不是**「路由等于 `resolveJudgeRoute()`」——入参里本就没有模型格，换掉实现只要求自全局默认它照样绿；它的标题虽写「两个分支」，实际只跑了生成侧）；**识别分支的路由没有用例**，如实登记）。**注意：`judge.ts` 今天确实不 import `@aieval/agents`，但这条没有专门的静态守卫**（ESLint 的 api 禁用名单里也没有它）——如实登记，别把「现状如此」读成「有人守着」。理由不是洁癖：一旦生成路径也能起 CLI，「一次几十秒的表格补全」会变成「一次几分钟的会话」，而它按的是同一个按钮。
- **失败绝不改调用方状态**：识别失败时弹窗不关、文本原样保留。

**界面**

- 用例表单的评分标准项卡片 `data-testid="case-rubric"`，内含 `[智能生成] [智能识别]` 两个按钮；表尾实时汇总「满分 N 分 · 共 M 项」（满分即权重合计，这是用户自查权重的手段）。表里**一格模型选择都没有**。
- `rubric-table.tsx`：纯展示 + 受控回调（`value` / `onChange`，**不 import client 包**），单元格用受控 `Input` / `InputNumber`，增删按钮各带 `data-testid`（`rubric-add-group` / `rubric-add-item-{i}` / `rubric-remove-group-{i}` / `rubric-remove-item-{i}-{j}`）。
- `rubric-recognize-modal.tsx`：框内只有一个多行文本域 + 取消 / 识别；成功回填并关窗，**失败不关窗、文本原样保留**；关闭不写回表单。
- 用例详情：只读「评分标准项」`Card`。
- 评分详情（`packages/client/ui/src/composite/score-detail-view.tsx`）：最上方一段**这一分自己的运行信息**（无标题、显式分两行、每行各自 `wrap`）——第一行是「谁打的」：`评分智能体 / 评分模型 / 思考强度`，三个值各一个 `Tag`（色固定 `blue` / `geekblue` / `purple`，`purple` 与行卡片上那个档位 Tag 同色；`judgeAgentKind === null` 写「文本 API」，`judgeEffort === null` 写「未指定」，档位照上游词汇原样，**不随取值变色**、不给告警样式）；第二行是「花了多少」：**评分用量**（直接渲染 `输入 X tok · 缓存 Y tok · 输出 Z tok` 三元组，取 `score.judgeTokens`）与 **`耗时 <值>`**（取 `score.judgeDurationMs`）——拿不到写「用量未采集」/「未采集」，**绝不写 0**。往下是顶部总分 + `满分 N 分 · 共 M 项`，逐组一张 `Table`（列 = `引用键 / 目标 / 权重 / 判定 / 理由`），未达成项**用颜色区分（不是隐藏）**，「模型原始返回」放在嵌套抽屉里。判定与评分表**按引用键**对应，**不做「找不到就跳过」的兜底**（找不到说明数据不一致，静默跳过比报错危险）；评分表里有、判定里没有时显式渲染「缺少判定」。底部记账那一行只剩 `输出约束：schema 约束 / 提示词约束` 与 `评分时间：score.judgedAt`（身份与强度已在上面那段里，两处各排一套只会互相争夺注意力）。**五格全部来自页面递下来的 `score`**（`apps/web-next/app/runs/page.tsx` 的 `scoreDetail` 那一支，**不再传 `row`**；反向守卫在 `apps/web-next/src/runs-page-wiring.test.ts`：这个抽屉里不许再出现 `row={`）。
- 设置页的「输出契约（只读）」换成新口径的**两段**说明（①逐项给「达成 / 未达成 + 一句理由」、不给总分；②总分 = 达成项权重之和、满分 = 全部项权重之和，由每个用例的评分标准项决定）。

**三层职责（各自只做一件事）**

| 层 | 落点 | 不合格时 |
|---|---|---|
| 体验层 | 用例表单提交前 | 表单规则用 `validateRubric` 的中文原因当场拒绝提交（`Promise.reject`，表格上方 `data-testid="rubric-validation-error"` 显示同一句），**不发请求** |
| 真相层 | `api/cases.ts` **已有的** `assertStorable()` | 抛 `INVALID_QUERY` + 中文原因（**落一处**，两处各写一遍必然漂移） |
| 兜底层 | `orchestrator.ts` 起一行评分之前 | 满分 ≤ 0 ⇒ 该行落**评分失败** + 中文原因，**不许走到评分器** |

兜底层**不在写入路径上但确实会开火**：`config.json` 是手可编辑的，而 `{ groups: [] }` 是一张**合法**的 `Rubric` ⇒ 手改的空表用例 `getCase` 读得出来、`POST /api/runs` 会把空表快照进 `run.json`，于是这一轮开跑时兜底层把它变成一句可展示的 `CONFLICT`（文案必须点名「这一轮的表在创建时已快照，改用例不影响它，出路是新建一轮」）。**不要在 `createRun` 再加「空表不许建轮」的守卫**——空表是写用例过程中的合法初态。

**旧数据**：旧用例带着 `judgePrompt` / 用例级评分模型两列 —— 读侧（`asStoredCase`）**显式删这三键**后照常列出（列表不该因为一条老数据白屏），真正的拦截发生在**使用路径**（`asUsableCase`）：缺 `rubric` 或形状不合法时抛中文 `INTERNAL`「这个用例是旧版数据（没有评分标准项），请删除它或重新创建：<caseId>」，**绝不给它 `.default({ groups: [] })`**（那会让旧用例看起来只是「还没配」，而它实际带着一份已无意义的旧提示词）。旧 `run.json` 里的 `dimensions` 不在用例上，与这条无关。

**守卫**：`rubricMaxScore` / `rubricItemKeys` / `validateRubric` / `composeTotalScore` 的边界（空表合法且满分 0、空组 schema 合法而 `validateRubric` 拒绝、跨组顺序号连续、空 ID 重复合法、权重 0 / 负 / 小数 / 超上限不合法、**生成的引用键撞车被拒**）；两份契约投影的**同形守卫**（字段名逐项对齐、两份都不出现 `totalScore`、`minItems` / `maxItems` 不存在）；缺一项即失败且点名是哪一项；`run.json` 里落了评分表快照（`runs.test.ts` 的「创建评测时把用例的评分表快照进这一轮」）——**「改用例之后重评仍读快照」今天没有守卫**（`api/src/runs.test.ts:265` 只钉创建那一刻的快照值，而且它传的表恰好与夹具缺省**相同** ⇒ 分辨不出快照是从用例取来还是落了缺省值；未在改用例之后再取分），如实登记；**两条通路共用 `finalizeScore` 收口**（文本侧 `judge.test.ts` 的「两条通路共用的收口」，智能体侧 `judge-agent.test.ts` 同样钉满分与总分；**没有**「同一份回复喂两条通路再比对」的用例——两份夹具不同，如实登记）；**「只用全局默认评分模型」**（`judge.test.ts` 的两条：转出同一性 + 生成分支的路由）；至于「生成路径不 import `@aieval/agents`」——那是现状、**没有守卫**，见本节上一段的如实登记。

### 4.4 删除用例

`Popconfirm` 确认。若该用例已被评测引用：

- **确认框不显示引用数**（契约里没有「按用例查评测数」的路由，页面传 `referencedRuns={null}`，界面走「不显示数字」那一支）；删除**成功之后**的提示才列出数字（`{affectedRuns}` 个评测记录的冗余快照仍可查看），删除本身**不阻塞**；
- 已完成的评测记录**保留**（评测里冗余存仓库来源、分支、commit 与**评分表快照**，不依赖用例仍存在，见 §7.2）；
- 用例级本地缓存仓库（`{workspaceRoot}/cases/{caseId}/cache`）一并删除；
- **不动远端镜像**（它按 URL 命名、可能被多个用例共用，且不随用例消失）。

### 4.5 远端 git 仓库来源（自动镜像）

**口径**

- 来源仍是**同一个 `repoPath` 字段**，按形态判定本地路径还是远端 URL（不新增 `repoUrl`）。
- 远端由服务端**自动镜像**到 `{workspaceRoot}/remotes/<slug>-<hash8>/`：**裸镜像**（`git clone --mirror`，没有工作树、不脏、全部分支以 `refs/heads/*` 可见），跨用例复用。
- **core 只见本地路径**：远端在 api / evaluator 层就被解析成「镜像路径 + 具体 commit hash」，再交给既有 `prepareRowWorkspace` ⇒ 缓存克隆、行工作区复制、`checkoutRow`、`collectDiff`、`copyWorkspace` **一行不改**。
- `repoBranch: string | null`（null = 远端默认分支）**仅远端可填**，本地来源填了直接 `INVALID_QUERY`。
- **分支 tip 每次评测重新解析**（跟随语义）；填了 `commitHash` 则**钉死**（优先于分支）。
- **不做凭据管理**：认证 = 本机 git（SSH key / ssh-agent / credential helper）。
- 远端 git 调用**非交互 + 墙钟超时**：`GIT_TERMINAL_PROMPT=0`、`stdio: ['ignore', 'pipe', 'pipe']`（stdin 必须断开：ssh 拿不到输入时会立即失败）、`GIT_SSH_COMMAND` 追加 `-o BatchMode=yes`（**仅在进程环境里没有它时**）；探活 15 s / 传输 10 min。同步 git 调用挂在请求线程上 ⇒ clone / fetch 期间整个进程阻塞（已知代价，用墙钟上限兜底）。
- 改工作区根目录后旧镜像不再被看到（会在新根下重新克隆）。

**表一：来源形态判定（唯一真源 `contracts/src/repo-source.ts`，顺序不可换）**

| 序 | 形态 | 判定 | 例 |
|---|---|---|---|
| 0 | 含控制字符（`\u0000-\u001f\u007f`）· 以 `-` 开头 | **拒绝** `INVALID_QUERY` | 粘贴带换行的 URL；`-x` |
| 1 | Windows 盘符 `^[A-Za-z]:[\\/]`、UNC `^\\\\` | local | `D:\repos\demo`、`\\host\share\repo` |
| 2 | 白名单 scheme：`ssh://` / `http://` / `https://` / `git://` / `file://` | remote | `https://coding.jd.com/FlowAI/rbac-server.git`、`file:///D:/tmp/origin.git` |
| 3 | 其它 `^[A-Za-z][A-Za-z0-9+.-]*://`（scheme **大小写不敏感**） | **拒绝** `INVALID_QUERY`（**不回落成本地路径**） | `ftp://host/x.git`、`FTP://host/x.git` |
| 4 | scp 形态 `^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]{2,}:.+$` 且「含 `@`」或「host 段含 `.`」 | remote | `git@coding.jd.com:FlowAI/rbac-server.git` |
| 5 | 其余（含 `/home/…`、相对路径） | local | `/home/me/tool-id`、`./repo` |

- 第 4 条的额外条件是为了不把 `src:foo` 这类含冒号的本地相对路径误判成远端；`localhost:repo` 因此判 local（要指定它请写 `ssh://localhost/repo`）。
- `file://` 判 remote 是刻意的：整条远端链路（镜像、基线解析、超时、失败分类）可以用本地裸仓库全覆盖，不需要网络。
- 控制字符查**原串**（先 `trim` 就等于放行最常见的粘贴事故）；「以 `-` 开头」防 URL 被 `git clone` / `git ls-remote` 当成选项解析。
- **归一**：两侧空白 `trim`；远端**仅**去掉尾部 `/`。此外不做任何归一（不折叠大小写、不剥 `.git`、不把 https 改写成 ssh）——它是镜像 key 与「来源是否改变」的判据。
- 仓库名：远端取 URL 末段去 `.git`（无路径段时回落 host），本地取路径末段。**用途限定**：界面标签与远端来源的服务端取值；本地来源的服务端仓库名仍走 `resolveRepoInfo` 的 git 口径（`rev-parse --show-toplevel` 的目录名）。

```ts
type RepoSource = { kind: 'local'; path: string }
                | { kind: 'remote'; url: string; host: string; repoName: string };
export function parseRepoSource(source: string): RepoSource;
export function repoNameFromSource(source: string): string;   // 判定路径用：非法来源响亮地抛错
export function displayRepoName(source: string): string;      // 渲染路径用：任何字符串都不抛错
export const RepoSourceStringSchema: z.ZodType<string>;       // 给 TestCaseSchema / CaseCreateSchema 的 repoPath
```

放 contracts（不是 core / ui）：三层都要用它（core 的镜像层、api 的校验与文案、ui 的标签），放一处才有唯一真源。`RepoSourceStringSchema` 失败时把 `ServiceError` 的中文原因原样塞进 zod issue，不另写一份文案。

**表二：契约改动**

| 字段 | 内容 |
|---|---|
| `TestCaseSchema.repoPath` | 语义扩为「来源」，改用 `RepoSourceStringSchema`（旧值判定结果不变） |
| `TestCaseSchema.repoBranch` / `CaseCreateSchema.repoBranch` | `z.string().min(1).nullable().default(null)`；`.default(null)` 是**载重**的：旧 `config.json` 的用例没有这一列，读侧必须按 null 读 |
| `RepoInfoSchema` | 新增 `kind: 'local' \| 'remote'`、`mirrorPath: string \| null`、`mirrorReady: boolean`、`mirrorFetchedAt: string \| null`、`tip: string \| null`（短哈希 7 位，**仅远端有值**）；`branch` 语义：本地 = 当前分支，远端 = 默认分支或用户填的分支 |
| `RepoPathInputSchema` | 保留不动；`RepoValidateInputSchema` / `RepoCommitsInputSchema` 同形（各 extend 一格 `repoBranch`，共用一份 schema） |
| `EvalRunSchema` | 新增 `repoBranch`（快照口径：用例改分支 / 删除后，这一轮从哪个分支的哪个 commit 起跑仍读得出来） |
| `errors.ts` | 只增 `REPO_UNREACHABLE`（400）：DNS / 连接超时 / 连接被拒 / SSH 指纹未信任 / 拉取超时。认证沿用 `AUTH_FAILED`（`context.host`），不存在 / 不是仓库 / 无法归因沿用 `NOT_A_GIT_REPO`，分支与提交不存在沿用 `INVALID_REF` |

**实现路径 · `core/src/mirror.ts`**

1. 目录 `{workspaceRoot}/remotes/{slug}-{sha1(归一 URL).slice(0,8)}/`：`slug` = URL 末段去 `.git`、非 `[A-Za-z0-9._-]` 归一成 `-`、小写化、截 40 字符、为空则 `repo`；**身份判据是 hash 段**（slug 只为人眼可读）。`remotes/` 是 `workspaceRoot` 下的第三个兄弟目录，`listRuns` 只认「目录下有合法 `run.json`」的那些，不会被当成一轮评测。
2. `ensureMirror({ workspaceRoot, url, timeoutMs? }): { mirrorDir, created }`：**就绪判据 = `<dir>/HEAD` 是文件且 `<dir>/objects` 是目录**（不是「目录存在」——克隆中途失败会留下没有 objects 的半成品）→ 已就绪直接返回 `created: false`（**不联网**）→ 未就绪则清残留、`git clone --mirror --quiet <url> <dir>.tmp-<pid>`（cwd = `remotes/`）、成功后 `renameSync` **原子改名**；rename 时目标已存在（并发已建）当作成功复用；目录存在但内容损坏 ⇒ 删掉重建，删不掉给中文 `INTERNAL`。
3. `fetchMirror(mirrorDir, url, { timeoutMs?, defaultBranch? }): { fetchedAt }`：`git -C <dir> fetch --prune origin`（`--mirror` 克隆的 config 里 `remote.origin.mirror=true`，普通 fetch 即全 refs 同步）→ 成功后**立刻 `alignDefaultBranch`**（`fetch` 自己不刷新镜像 HEAD，这一步是「跟随远端默认分支」的承重点：调用方给了 `defaultBranch` 就用它，没给就自己 `ls-remote` 一次；对齐失败抛 `INTERNAL`）→ 再写镜像记录 `<dir>/aieval-mirror.json`（`{ url, fetchedAt }`，`url` 存**归一形态**；普通 `writeFileSync`，写失败只 WARN）。**更新不在 `ensureMirror` 里做**：候选列表要快（不联网）、校验要新鲜、评测准备必须新鲜，把 fetch 混进去会让准备路径联网两次、也让「候选不联网」从签名上看不出来。记录的用途只有诊断与回显「更新于 YYYY-MM-DD HH:mm」，**不参与就绪判据**（缺失或不可解析一律按「没有记录」处理、不重建）。写记录有两处：`fetchMirror` 成功后，以及**首次克隆真的把目录建出来时**（`promoteMirror` 返回 `created`；rename 撞车而复用既有目录时**不写**——那份镜像的时间由建它的那次克隆负责。否则刚建好的镜像没有 `fetchedAt` 可回显）。
4. `probeRemote(url, { cwd, timeoutMs? }): { defaultBranch, tip }`：`git ls-remote --symref <url> HEAD`，从 `ref: refs/heads/<name>\tHEAD` 与 `<sha>\tHEAD` 两行解析。`cwd` **由调用方显式给**（`{workspaceRoot}/remotes/`，必要时先建目录），刻意不回落 `process.cwd()`。空输出（远端没有任何 ref）→ `NOT_A_GIT_REPO`「远端仓库还没有任何提交」。
5. `resolveRemoteRef(mirrorDir, url, { branch, commitHash, fetch = true, timeoutMs? }): string`（返回 40 位 hash）：`commitHash` 非空时**先查镜像、查到即回（不联网）**，查不到才 `fetchMirror` 一次再判、仍没有 → `INVALID_REF`（钉死的 commit 不受 `fetch: false` 影响——要判出「镜像里确实没有」就必须抓一次）；`fetch` 为真只作用于分支 / 默认分支那条路：先 `fetchMirror` → `branch` 非空取 `refs/heads/<branch>^{commit}`（不存在 → `INVALID_REF`）→ 否则取远端默认分支（`defaultBranchName`：`symbolic-ref --short HEAD`，失败退回 `rev-parse --abbrev-ref HEAD`，都失败 → `NOT_A_GIT_REPO`「无法确定远端默认分支」）。`fetch: false`（候选列表那条路）跳过的就是分支 / 默认分支那一次 fetch。
6. 远端调用统一走**同一个** `execute` 封装（`core/src/git.ts` 的 `execute` / `gitMessage` 抽到 `core/src/git-exec.ts` 共用），新增 `env` 与 `timeoutMs` 两个可选参数（`execFileSync` 的 `timeout`，到点杀子进程）。常量 `REMOTE_PROBE_TIMEOUT_MS = 15_000`、`REMOTE_TRANSFER_TIMEOUT_MS = 600_000` 定义在 **`core/src/mirror.ts`**，都可由调用方覆盖（测试用 1 ms 制造确定性超时）。**超时判定不靠关键词**：`execFileSync` 因超时被杀时错误带 `signal`（`SIGTERM`）且 `status` 为 null ⇒ 折成 `REPO_UNREACHABLE`「远端仓库拉取超时（超过 10 分钟）…已终止 git 进程」，**不得**归到 `NOT_A_GIT_REPO`。
7. `git.ts` 只加两处签名级补充：`resolveRepoInfo` 的返回值补上新增字段的本地常量取值（`kind:'local'`、`mirrorPath:null`、`mirrorReady:false`、`mirrorFetchedAt:null`、`tip:null`）；`listCommits(repoPath, limit = 20, ref: string | null = null)` 加一个可选 ref（不传时行为逐字不变）。

**实现路径 · api / evaluator 接线**

| 落点 | 行为 |
|---|---|
| `validateRepo` | local 走现状；remote = `probeRemote` →（镜像未就绪时）`ensureMirror`（首次克隆，慢；**克隆本身就是这一次取回，紧接着不再 fetch**——大仓库首次校验是分钟级的）→ 镜像已存在时 `fetchMirror`（增量，通常 1–3 秒；把探活拿到的默认分支名传进去对齐镜像 HEAD）→ `resolveRemoteRef(..., { fetch: false })`（分支不存在在这里就拦下）→ 回 `kind:'remote'`、`repoName`、`branch`、`tip`（7 位）、`mirrorPath`、`mirrorReady:true`。远端校验**不 checkout、不碰工作树、不建行工作区** |
| `listCommitCandidates` | remote = `ensureMirror`（就绪则纯本地、**不联网**）→ `resolveRemoteRef(..., { fetch: false })` 取该 ref 的 40 位 tip → `git -C <dir> log --format=%h%x09%s -n 20 <tip>`。复用 `resolveRemoteRef` 而不自己算 ref 名（默认分支的取名只在一处实现） |
| `createCase` / `updateCase` | 形态判定走 `parseRepoSource`；本地来源 + 非 null 分支 → `INVALID_QUERY`（**按值判**，避免 UI 的全量补丁把无关保存拦下）；远端分支 / commit **先在镜像里判**，判不过时**只 `fetchMirror` 一次再判**，仍判不过才抛（远端刚推上来的分支不该因为镜像还没更新而被拒）；落盘时 `commitHash` 归一成 40 位、`repoBranch` trim（空串 → null） |
| 创建评测 | 把用例的 `repoPath` 与 `repoBranch` 一并快照进 `EvalRun` |
| 编排层准备阶段（第 1/2 步之前） | `parseRepoSource(run.repoPath)` → remote 时 `ensureMirror({ workspaceRoot: run.workspaceBase, url })`（**不联网**更新）→ `resolveRemoteRef(mirrorDir, url, { branch: run.repoBranch, commitHash: run.commitHash })`（缺省 `fetch: true`，分支 tip 在这里重新解析；**钉死的 commit 已在镜像里时一次都不抓**，否则这是本轮唯一一次 fetch）→ `prepareRowWorkspace({ …, repoPath: mirrorDir, commitHash: baseline, branch })`（传**具体 hash** 而不是 null：基线已解析成 40 位具体值，缓存只需从镜像取对象）→ `EvalRow.baselineCommit` = 该 hash（仍是 40 位）。本地来源走原路 |

**表三：基线解析**

| 来源 | `repoBranch` | `commitHash` | 基线 |
|---|---|---|---|
| local | null | null | 缓存刷新到来源仓库当前 HEAD（既有语义） |
| local | null | hash | `assertCommit` |
| local | 非 null | 任意 | 写入口就 `INVALID_QUERY`（到不了准备阶段） |
| remote | null | null | 远端**默认分支** tip（每次评测 fetch 后重新解析） |
| remote | `feat/x` | null | `refs/heads/feat/x` 的 tip（同上） |
| remote | 任意 | hash | 该 commit（镜像里没有 → fetch 一次 → 仍没有 → `INVALID_REF`） |

local 与 remote 的「默认分支 HEAD」**不是同一个东西**：local 取来源仓库**当前检出的 HEAD**（可能停在特性分支上），remote 取**远端默认分支**。这是两种来源的固有差异，写进文案与文档，不试图统一。

**错误分类**（`classifyRemoteFailure`，按序判）：① **先判超时**（`isTimeoutKill`：`signal === 'SIGTERM'` 或 `code === 'ETIMEDOUT'`，不靠关键词——远端自己报的 timeout 原文长得很像）⇒ `REPO_UNREACHABLE`「远端仓库拉取 / 探活超时（超过 N）…已终止 git 进程」；② `Permission denied (publickey` / `Authentication failed` / `could not read Username` / `HTTP Basic: Access denied` / `terminal prompts disabled` → `AUTH_FAILED`；③ `Could not resolve host` → 不可达（点名 DNS）；④ `Connection timed out` / `Connection refused` / `Network is unreachable` / `Operation timed out` / `Could not connect to server` / `Timeout was reached` → 不可达（后两条覆盖 curl 系原文与「未监听端口」这一档）；⑤ `Host key verification failed` → 指纹未信任（同样 `REPO_UNREACHABLE`）；⑥ `does not appear to be a git repository`（更具体，先判）→ `NOT_A_GIT_REPO`「不是 git 仓库」；⑦ `not found` / `Repository not found` → `NOT_A_GIT_REPO`「远端仓库不存在或无权访问」；其余 → 无法归因（同样 `NOT_A_GIT_REPO`，原文照带）。**中文原因在前**：能拿到 git 原文的分支把它作为补充缀在后面（DNS / 不可达 / 指纹未信任 / 不是仓库 / 不存在或无法归因），而**认证失败**与**墙钟超时**两支只给中文原因（超时那一支被墙钟杀掉时 git 原文只有 Node 的英文，写成「原因」是误导）——原文一律另放 `context.gitMessage`。

**界面**：来源切换是 `Radio.Group`（远端在前为默认），切到本地清空分支；「校验」与「重新加载候选」在远端首次点击可能触发克隆（loading 文案分别是「正在校验并拉取远端仓库…」与「正在拉取远端仓库…」，背后有 10 分钟上限）。详情里远端显示 URL（等宽）+ 分支行。设置页**不加**任何凭据 / 镜像管理项。

**守卫**（core 的 `mirror-*.test.ts` 七件套 + `testing/mirror-harness.ts`，夹具以真 git + `file://` 裸仓库为主，另有 **3 条走本地非 `file://` 传输**：两条 `probeRemote` 用 `unusedPort()` 造 `http://127.0.0.1:<port>`（未监听 / 超时）、一条克隆超时用 `silentRemote()` 造 `git://127.0.0.1:<port>`；**最后三条行级行为在 `evaluator/src/orchestrator-remote-source*.test.ts`**）：镜像路径稳定（同一 URL 含两侧空白 / 尾斜杠差异 → 同一目录；`https` 与 `ssh` → 不同目录）；首次建镜像后可 `for-each-ref` 看到来源全部分支（含非默认分支）；**幂等且不联网**（第二次 `created: false` 且镜像目录不变；把来源整体**改名移走**后再调一次仍成功）；`fetchMirror` 更新后镜像里有新提交且记录 `fetchedAt` 前进（记录里的 `url` **没有**归一形态的守卫——夹具 URL 本身已是归一形态，写成原串照样绿）；镜像记录缺失 / 损坏不影响就绪判据；半成品目录能重建；`tmp + rename` 竞态下复用不抛错（瞬时占用重试到成功）；`probeRemote` 四类（正常 / 空仓库 / 不存在 / 未监听端口）；`resolveRemoteRef` 三条路；超时映射到 `REPO_UNREACHABLE` 且文案含「超时」；`remotes/` 不被当评测；**远端不可达在 `file://` 夹具下表现为「来源被移走」⇒ 该行 `failed` 且错误码是 `NOT_A_GIT_REPO`**（A7 的裁定：这时该做的是改地址而不是查网络；真正的网络不可达 / 认证失败才落 `REPO_UNREACHABLE` / `AUTH_FAILED`）——**两种情形都绝不静默用旧镜像**；远端新增提交后重跑 ⇒ 新基线（分支跟随语义）。**两条当前没有守卫（如实登记）**：从裸镜像克隆出的工作副本 `refs/heads` 恰好一条（实现侧由 `resolveBaselineCommit` 的 R20 前提依赖）；镜像来源 URL 变更后重建目录（目录身份已由 `mirrorDir` 的 URL hash 覆盖）。「来源仓库变了就重克隆」那条守卫落在**用例缓存**（`git-repo-cache.test.ts`），不在镜像层。

---

## 5. 功能模块二：评测管理

### 5.1 创建评测（右栏表单）

| 字段 | 控件 | 行为 |
|---|---|---|
| 用例 | `Select` | 选项显示「标题 · 仓库名 · commit 短哈希」（仓库名走 `displayRepoName`）；必填 |
| 执行模式 | `Radio.Group`：串行 / 并行 | 必填，默认**串行**（串行在前、并行在后；并行不设并发上限，多候选一起开跑最先撞上供应商限流） |
| 候选行 | `Form.List` 动态增减 | 每行三个选择：智能体（Claude Code / Codex / DeepSeek Harness）+ 模型 + **思考强度**（§5.1.1） |
| 使用智能体评分 | `Switch` | 默认关。打开而未配置默认评分智能体时给内联 `Alert` 指向设置页（并说清「这一轮会创建失败（服务端当场拒绝）」）；「或新建评测时关闭『使用智能体评分』」那条出路只出现在**服务端**的拒绝文案里；值随创建一并落库 |

编辑态复用同一张表单（`mode: 'new' | 'edit'`），差别只有候选行可以带 `id`（§5.3.3）。

- 「使用智能体评分」在服务端**创建时再拦一次**（`createRun`）：`useAgentJudge === true` 时校验 `defaultJudgeAgent` 非空、且**设置页全局默认评分模型**所属供应商的协议能被该智能体**接受**（用例上不再有评分模型覆盖）；**三处**都抛 `CONFLICT` + 可直接展示的中文原因（未配置 / 枚举之外的值 / 协议不接受，`requireJudgeAgent`，§5.5.1）。
- payload 显式补 `useAgentJudge: values.useAgentJudge ?? false`——`zod` 的 `z.object` 默认 strip 未知键，不显式声明就会被**静默丢掉**。

**模型的候选池按协议类型过滤**（F2）：供应商的协议是**单值**（`Provider.protocolType`），智能体能接受的协议是**集合**（`AgentProviderMetadata.protocolTypes`），判定用 `acceptsProtocol(metadata, providerRecord.protocolType)`（**四处消费点唯一的判据**，见 §5.6.2）：

- 选 `Claude Code` → 只列 `anthropic` 协议供应商的模型（它的集合是 `['anthropic']`）。
- 选 `Codex` → 只列 `openai` 协议供应商的模型（它的集合是 `['openai']`）。
- 选 `DSH` → **两类协议供应商的模型都列**（它的集合是 `['openai','anthropic']`：pi-ai 路由把 `anthropic → anthropic-messages`、`openai → openai-responses`，两条 wire 都真机跑通含计量）。
- 自动拉取（`source: 'fetched'`）与手工维护（`source: 'manual'`）的模型用 `Tag` 区分来源。
- 过滤后无可选项时，该行立即内联 `Alert` 说明原因与出路（实际文案：「{智能体} 没有可选的模型：请到设置里添加协议匹配的供应商，并为它维护模型清单」——`ui` 不硬编码「哪家配哪种协议」），而不是让人选完到运行时才失败。
- 候选池与元数据的唯一出口是 `GET /api/runs/model-options`（`listAgentModelOptions()`）：一次取回三家的 `protocolTypes` / `usage` / `cancelMidTurn` / `efforts` / `defaultEffort`（仅声明该格的家出现） / `messageCapability` 与各自过滤后的模型清单，**表单不硬编码三家与协议的对应关系**。

**提交校验**：至少一行；每行三个选择均已确认（强度可留「未指定」）；执行模式已选。

**创建后即落库**（状态 `idle`），不自动开跑——「开始」是评测详情页的显式动作。

#### 5.1.1 上下文窗口与思考强度

**口径**

- 契约里只存**中性事实** `contextWindow: number`（`[1m]` / `model_context_window` / overlay 三种写法全留在各家适配器）。
- 取数按**字段优先级**取第一个正整数（不深遍历整个 JSON）：窗口 `max_input_tokens` → `contextWindow` → `context_window` → `context_length` → `limit.context` → `capabilities.contextWindow`；输出 `max_tokens` → `max_output_tokens` → `maxTokens` → `maxOutputTokens` → `limit.output`（点号表示嵌套）。
- 手工覆盖优先于拉取值，用**逐字段来源** `contextWindowSource: 'fetched' | 'manual'` 记住；`manual` 的条目在拉取时**不被覆盖**，**清空也记成 `manual`**（语义是「别用上游那个数」）。
- **窗口未知 ⇒ 三家都不注入**（不拿兜底数字冒充「已知」）。
- 强度档位：**未选 = 不指定**（dsh 的适配器落到它自己的缺省 `high`；claude / codex 干脆不传、由厂商推断），**要关闭必须显式选 `off`**（契约里的统一档名 `EFFORT_OFF`，各家负责翻成厂商词汇）。
- 候选 =（上游声明过 `supportedEfforts` ? 上游 ∩ 该家档位域 : 该家**完整档位域**）**∪ 关闭档**，在服务端算好（投影进候选池）；创建与编辑**都**按同一份候选校验（**未选也要校验**：`declared = row.effort ?? metadata.defaultEffort`，`declared` 不在候选里就建行即拒；没声明 `defaultEffort` 的家未选不校验）。表单只列候选，这一道拦的是**绕过表单直接打接口**：命中即抛 `INVALID_QUERY`，中文原因**同时点名两个值域**与最终候选（「{智能体} 不能按 {档} 跑 {模型}：该模型支持的档位是 …，{智能体} 能收的是 …，可选的是 …」），未选档位触发时还要说明「未选档位时 {智能体} 会用 {档}」。**不做就近取整**（`medium` → `high` 是静默改语义）。
- **档位域只有一处算法**：`intersectEfforts(model, agentEfforts, fallbackEfforts)`（`packages/server/contracts/src/effort.ts`）。`supportedEfforts` 非空就用它、为空（含空数组）就用 `fallbackEfforts` 顶上，**两者都要过 `agentEfforts` 这道筛**；关闭档 `EFFORT_OFF` 若该家能收且不在交集里则并入并**排第一位**（它表达的是「我们这一侧关掉思考」，不是模型声明的能力 ⇒ 不受交集裁剪）；返回 `undefined` = 一个档位都没有，调用方只给「未指定」。**两个角色共用同一份算法，共 4 个调用点**：候选池（`packages/server/api/src/runs.ts` 的 `listModelOptions` / `resolveRunRows`）传**该家完整档位域**（codex 收 9 档就该能点 9 档）；评分校验（`evaluator/src/judge-route.ts` 的 `requireJudgeEffort`）与设置页评分配置卡片（`judge-settings-card.tsx`，浏览器侧）传规范五档 `CANONICAL_EFFORT_LEVELS`（§5.5.2）。
- 每个智能体的档位域写进**注册表元数据**（`reasoningEfforts`，**必填**），由 `registry.test.ts` 强制每家显式声明；「未选时实际会用的档」也写进元数据（`defaultEffort`，**只有 dsh 声明**）——API 侧要拦「未选 + 该模型不支持那个缺省档」这种组合，否则要跑到 dsh 的硬校验处才失败，症状离真因很远。
- 强度进**行快照**（`rows[].effort`），窗口**不进**：窗口是模型属性（与 `baseUrl` 同口径，运行时现读），强度是这一行的配置（与 `modelId` 同级，必须跟着行一起被重跑、被展示、被比较）。记的是**我们要求的**档位，不是实际生效的档位。
- 推荐档**不预选**，只在选项标签上标「推荐」（预选会让「我没选过」与「我选了推荐档」在快照里长得一样）。

**契约**

```ts
// contracts/src/provider.ts
contextWindow: z.number().int().positive().optional(),        // 缺省 = 未知
maxOutputTokens: z.number().int().positive().optional(),
contextWindowSource: z.enum(['fetched', 'manual']).optional(),
supportedEfforts: z.array(z.string().min(1)).optional(),      // 原样保留上游顺序与拼写
recommendedEffort: z.string().min(1).optional(),              // 不在 supportedEfforts 里 ⇒ 按「没有推荐」
// 五格全部可选 ⇒ 磁盘上已有的 config.json 无需迁移（loadConfig 只做 JSON.parse + 合并默认值）

// contracts/src/provider.ts：设置页行内编辑器的入参（两格同进同出；null = 明确清空）
export const ProviderModelCapabilitySchema = z.object({
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
});
export const ProviderModelContextSchema = ProviderModelCapabilitySchema.extend({
  id: z.string().min(1),
  maxOutputTokens: z.number().int().positive().nullable().optional(),   // 可选：**省略与 null 同义**（这一格一并清空——服务端按 { id, source } 重建该条目）
});

// contracts/src/run.ts
export const EFFORT_OFF = 'off';                              // 「关闭思考」的统一档名
effort: z.string().min(1).optional(),                          // EvalRow；RunCreateSchema.rows[] 里同名同形

// agents/src/types.ts
route: { protocolType; baseUrl; apiKey; modelId;
         contextWindow?: number; maxOutputTokens?: number };   // 中性事实，不是方言
effort?: string;                                               // **不进 route**：它是请求参数，与 permission / prompt 同级
AgentProviderMetadata.reasoningEfforts: readonly string[];     // 该家能表达的完整档位域（必填）
AgentProviderMetadata.defaultEffort?: string;                  // 「未选」时该家实际会用的档（只有 dsh 声明）

// contracts/src/effort.ts：档位域的**唯一**算法，候选池与评分两侧共用（见上一条口径）
export const CANONICAL_EFFORT_LEVELS: readonly string[];       // ['off','low','medium','high','max']：两条通路都能表达的那一组
export function intersectEfforts(model: { supportedEfforts?: string[] },
                                 agentEfforts: readonly string[],
                                 fallbackEfforts: readonly string[]): string[] | undefined;
```

| 智能体 | `reasoningEfforts` | `defaultEffort` |
|---|---|---|
| claude-code | `['off', 'low', 'medium', 'high', 'xhigh', 'max']` | ——（未选由厂商推断） |
| codex | `['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']` | —— |
| dsh | `['off', 'low', 'high', 'max']` | `'high'` |

`AgentModelOption` 增加 `contextWindow?: number`、`efforts?: string[]`（**已按上面的规则算过**；一个档都没有时该键**不出现**，界面只给「未指定」）、`recommendedEffort?: string`（必须落在 `efforts` 里才有值）；`AgentOptionGroup` 增加 `efforts`（该智能体的完整取值域；**唯一消费方是设置页的评分配置卡片**——它拿这一格当 `agentEfforts` 去 `intersectEfforts(model, agentEfforts, CANONICAL_EFFORT_LEVELS)` 算「思考强度」候选；候选行表单不读它，行内强度选项来自模型条目自己的 `efforts`）、`defaultEffort`（仅声明该格的家出现，界面用它拼「未指定（X 用 Y）」）与 `messageCapability`。`RunCreateSchema.rows[]` 增加 `effort?: string`（**逐行**，且**必须显式声明**：zod 3 的 `z.object` 默认 strip 未知键，不声明的话表单提交的强度会被**静默丢弃**，不是 400）。

**取数（`api/src/providers.ts`）**

- `extractModelIds` → `extractModels`：解析规则 `number` 或数字字符串（`'1048576'`）→ `Number(v)`，要求 `Number.isInteger(n) && n > 0`，否则跳过换下一个字段；**上界不设**（清单里有 2M 窗口，加上界只会把合法的截掉）；`data: ['a','b']`（纯字符串形态）继续支持，此时窗口两格都是 `undefined`；**上游 id 与手工入口同口径地 `trim` 后入库**，并按 trim 后的 id 去重（本仓史上查不到「存原串」的旧形态：首个提交起就是这一形态——旧对比只存在于早期计划文档里）。
- 档位数组的优先级：`supportedEffortLevels` → `reasoning.supported_efforts`；第三种形态是 `capabilities.effort` 的**逐档对象**（`{ supported: true, low: { supported: true }, high: { supported: true, recommend: true }, … }`）——取值为对象且 `value.supported === true` 的键、保持上游键顺序，`recommend === true` 的那一档同时充当推荐档。清洗：只留非空字符串、按首次出现去重；`supportedEfforts` 为空 ⇒ **两个字段**（`supportedEfforts` / `recommendedEffort`）都不写。**上游自相矛盾时整格不采信**：`recommendedEffort` 不在 `supportedEfforts` 里 ⇒ 两个都当成上游没说。推荐字段优先级：`recommendEffortLevel` → `reasoning.default_effort`。
- **合并（最容易踩的一处）**：`fetchProviderModels` **不得**把 fetched 条目重建成 `{ id, source: 'fetched' }`——照原样上线的表现是「点一次拉取模型就把所有窗口清空」。正确形状（`manual` 条目原样保留、手工改过或手工清空的窗口不被拉取打回、上游这次没给就不保留旧值）：

```ts
const manual = current.models.filter((m) => m.source === 'manual');       // 原样保留
const manualIds = new Set(manual.map((m) => m.id));
const byId = new Map(extracted.map((m) => [m.id, m]));                    // **上游**这一次给的
const previousById = new Map(current.models.map((m) => [m.id, m]));       // 旧值：判断「用户手工改过没有」
const models = [
  ...manual,
  ...[...byId.keys()].filter((id) => !manualIds.has(id)).map((id) => {
    const previous = previousById.get(id);
    // 用户手工改过（或手工清空）就保留用户那份；否则以上游为准
    const keep = previous?.contextWindowSource === 'manual';
    return {
      id,
      source: 'fetched' as const,
      ...pickWindow(keep ? previous : byId.get(id)),
      ...pickEfforts(byId.get(id)),        // 档位永远以上游为准（手工覆盖只保护窗口这一格）
    };
  }),
];
```

  `pickWindow(x)` 只挑 `contextWindow` / `maxOutputTokens` / `contextWindowSource` 三键（缺席不写 `undefined`）；上游这次没给窗口且条目也没有手工覆盖 ⇒ 三键都不写（= 未知），**不保留上一轮的旧值**（上游下架了就是下架了）。日志「模型清单已更新」增加 `withWindow: <条数>`。**强度与窗口同一段合并、同一条规则，但窗口的手工覆盖不保护强度**：档位永远以上游为准（两件事）。
- `setProviderModelContext(providerId, input: ProviderModelContextInput)` 按 `{ id, source }` **重建**该条目：写 `contextWindow` / `maxOutputTokens`（正整数或 `null` = 明确清空；`maxOutputTokens` 省略与 `null` 同义）并把来源置 `'manual'`——**重建意味着该条目已声明的 `supportedEfforts` / `recommendedEffort` 也会被一并清掉**（保存一次窗口就退回该家完整档位域）；清单里没有这条 ⇒ `NOT_FOUND`；窗口为 `null` 时清除**窗口那两格**（`contextWindow` 不写；`maxOutputTokens` 省略或 `null` 时也不写），**并把 `contextWindowSource` 写成 `'manual'`**（它记的是「用户在这一格表过态」，清空同样是表态）。

**三家的表达（编排层给事实，适配器给方言）**

编排层只改一处：组装 route 时从供应商清单里那条模型条目读出窗口填进 `route.contextWindow` / `route.maxOutputTokens`（评分路由同样原样带上，否则「cc 驱动的评分模型不加 `[1m]`、codex 不写 `model_context_window`」与候选行的行为不一致）。

| 家 | 窗口 | 强度 |
|---|---|---|
| claude-code | `contextWindow >= ONE_M_CONTEXT (1_000_000)` ⇒ 传给 CLI 的模型名加 `[1m]` 后缀（对非 Claude 名字一样加、已有后缀幂等），否则原样；`maxOutputTokens` **不注入**（SDK 的 options 里没有对应项） | 非 `off` 时传 SDK 的 `Options.effort`；`off` ⇒ **两处一起给**：`thinking: { type: 'disabled' }`（SDK 选项，经 argv 到得了 CLI 的模型能力门）+ 子进程环境变量 `CLAUDE_CODE_EXTRA_BODY = '{"thinking":{"type":"disabled"}}'`（由 `JSON.stringify` 生成，CLI 对**非法 JSON 静默忽略整条**；它管能力门放行不了的那些模型）。**其余档位与未选必须给空对象**，不能写「键存在、值为 `undefined`」——那会**删掉**宿主继承来的同名变量，改变其它档位的行为。宿主若设过 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`，`off` 档的关闭会**静默失效**（本条运行照常跑完，但落一条点名 WARN）。未选 ⇒ 不传 |
| codex | thread config 里 `...(contextWindow === undefined ? {} : { model_context_window: contextWindow })`；**不设** `model_auto_compact_token_limit`（CLI 自己按窗口推导更准） | app-server 的 `turn/start` 带 `effort`（**`off` 也走这里**：`effort: 'none'`）；`off` 另有 **`config` 里的第二格** `model_reasoning_summary: 'none'`（⚠️ 这一格与 `model_context_window` **同在 `thread/start` 的 `config` 里**，`thread/start` 的 params 里没有 `effort` 键；两半缺一都关不掉：`include: ["reasoning.encrypted_content"]` ∧ `reasoning.summary` 的合取）；其余档位与未选 ⇒ 该键不存在 |
| dsh | **per-run overlay**：`<configHome>/aieval-route.patch.yml` 里 `- id: llm-pi-ai` 那个 patch 的 `contextWindow` / `maxTokens` 两个键；未知 ⇒ **不写那个键**（overlay 每次运行由 `buildDshRoutePatch()` 纯函数**整份重写**，同一输入两次调用逐字相同） | 强度经 SDK 选项 `DeepSeekHarnessOptions.reasoningEffort` 传（**恒带**：未选 ⇒ 缺省档 `high`，显式 `off` 原样传 `'off'`）；overlay 里写的是**静态档位表** `reasoningEfforts`（`off: null` / `low: 'low'` …），由 pi-ai 把 `off` 翻成 `thinking: { type: 'disabled' }` / `reasoning: { effort: 'none' }`（按 wire 分叉） |

三家都**不做值映射**：档位字符串按上游词汇原样透传（`off` 那一档由各家翻成自己的词汇），能不能收由候选池在创建时就保证。三家的 debug 日志各补一行 `effort`（claude 那条同时记**真正传给 CLI 的模型名** `model` 与 `declaredModel`，两个键**恒同时出现**，只在 `[1m]` 后缀生效时不同）。

**关闭档的前置条件只有 claude 有**：宿主环境若设过 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`（大小写不敏感地查、**回报原拼写**），body 覆盖层不再生效 ⇒ `off` 的关闭会**静默失效**。判据是一个**导出的纯函数**（`off` 档 + 合并后的环境里存在该键 ⇒ 返回宿主用的键名原文，否则 `null`），命中时落一条 WARN 并**照常跑完**（不抛、不跳过）：它是**观测，不是拦截**——我们不能替宿主清掉那个变量（那属于「改变其它档位的行为」）。纯函数的意义在于可测：合并后的 `env` 对象在宿主设过同名变量时会让「键不存在」的断言假红。

**界面**

- 设置页 · 模型清单（`provider-models-modal.tsx`，入口是供应商列表的「模型」按钮）：`size="small"`、`showHeader={false}` 的 `Table`，列序固定 **模型 ｜ 来源 ｜ 输入 ｜ 输出 ｜ 操作**；模型列开 `ellipsis`、**不套 `code`**、**不给宽度**（吃掉剩余宽度）；来源列只有一个来源 Tag（88px）；输入 / 输出各占一列、都是 `InputNumber`、都 **116px** 宽（= 7em 的 98px + 单元格内边距 16px + 2px 余量——表是 `table-layout: fixed`，格子比内容窄时内容会压到相邻列上），**两格一次提交**，没碰过的输入回落到清单现值且**不与「清空」混同**（草稿状态按 `Object.hasOwn` 判「改过没有」）；操作列右对齐（72px）、两个图标按钮（保存 / 移除）+ `Tooltip`（文字进 tooltip、可访问名走 `aria-label`）；**「窗口被手工维护过」**（`contextWindowSource === 'manual'`）的可视信号 = 保存图标变 `gold` + 提示语「保存窗口，模型已被手工维护」（来源列那个 Tag 另说 `source`：`source === 'manual'` 时它的文字也是「手工维护」，两者是**两格**，别把 gold 图标当成「手工添加过这条模型」的标志）；保存走 `setProviderModelContext(providerId, { contextWindow, maxOutputTokens })`（`null` = 明确清空）。`MODEL_COLUMN_WIDTH` / `MODELS_MODAL_WIDTH`（弹窗宽 720）是导出常量并由列宽守卫盯着。
- 创建评测：模型下拉在模型名后补窗口 Tag（`1M` / `200K`），**Select 的 value 不变**（仍是 `providerId::modelId`）；强度下拉的选项 = 该行当前模型的 `option.efforts`，推荐档标「推荐」、**默认不预选**、占位符是「未指定（DeepSeek Harness 用 high）」（厂商名与缺省档都由注册表元数据拼出）、**关闭档不带「推荐」后缀**；**换模型或换智能体都要作废本行已选强度**（与「换智能体作废模型」同一口径）；值编码成裸字符串随行提交。
- **候选行是一张 small `Table`**，列序固定 **智能体 ｜ 模型 ｜ 思考强度 ｜ （无标题的）操作列**：字段名交给列头、`Form.Item` **不再给 `label`**（右栏只有 ~545px 宽，竖排标签在多候选时最贵）；**可访问名由控件自己的 `aria-label` 承担**；操作列列名留空、右对齐，三个图标按钮顺序是 **上移 / 下移 / 删除**（候选顺序就是串行执行顺序），边界行**置灰而不是隐藏**，删除用危险色 `variant="link"`；模型池与强度档位由整张表的 `shouldUpdate` 订阅（判据是 `(agentKind, modelKey)` 的**签名**，行数变化也必须重画——否则新加的候选根本不出现）；**删光最后一行是可达状态**，空态文案是中文的「还没有候选：点下面的「添加候选」加一行」；列宽只在浏览器里定：智能体 130 / 强度 120 / 操作 **80**，**模型列不给宽度**（吃掉剩余宽度），表最小宽 636，首列与操作列 `fixed`。
- 行快照展示：评测详情里模型名（等宽文本）右侧另挂一个紫色档位 `Tag`（内容就是档位词本身，如 `high`；显式 `off` 时 Tooltip 写「关闭思考」而不是重复一遍 `off`），缺省不显示。
- 以上都不手写字号、不手调行内边距。

**守卫**：五格全可选（老形态解析通过、带窗口往返不丢）；窗口与输出的优先级：**有区分力的是窗口五格**（`max_input_tokens` / `contextWindow` / `context_window` / `limit.context` / `capabilities.contextWindow`）**与输出三格**（`max_tokens` / `max_output_tokens` / `limit.output`）；**嵌套与数字字符串都是被接受的取值形态**（`limit.context`、`context_window: '5000000'`），`0` / 负数 / 小数 / `'abc'` 一律跳过（换下一个字段）；`context_length` / `maxTokens` / `maxOutputTokens` 只在字段同值的真机样本里出现、**没有区分力**（如实登记）；合并的四条（拉取不清空窗口、手工覆盖不被打回、上游没给就不保留旧值、`manual` 条目原样保留）——**档位在合并路径上是否以上游为准（窗口的手工覆盖是否顺带护住档位）今天没有守卫**，如实登记（实现是 `pickWindow` / `pickEfforts` 两条分开的路）；`setProviderModelContext` 的写入 / 改 / 清空（**清空后来源仍是 `manual`**）；claude 的 `1000000` / `1048576` → `[1m]`、`999999` / 未知 → 原名、已有后缀幂等；claude 的 `off` ⇒ **两个键都在**（`thinking` 选项 + `CLAUDE_CODE_EXTRA_BODY` 逐字节等于 `{"thinking":{"type":"disabled"}}`）、其余档位与未选 ⇒ **该键不存在**（不是值为 `undefined`）、宿主设过 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` ⇒ 落点名 WARN 且照常跑完；codex 给窗口 ⇒ 键在且值逐字相等、不给 ⇒ **键不存在**、`off` ⇒ 第二格 `model_reasoning_summary: 'none'`；dsh 给窗口 ⇒ overlay 里那两个键正确、不给 ⇒ 键不出现；编排层组装的 route 带上窗口与输出上限（评分路由同样带）；候选池交集**表驱动四条边界**（交集为空 / 交集部分命中 / 上游无档位 ⇒ 给该家完整域 / 推荐档不被收）+ **关闭档在该家能收它、且交集里还没有它时仍在候选里且排第一** + **兜底那一份同样要过 `agentEfforts` 这道筛**（dsh 收不了 `medium` ⇒ 求交后少一格）；`createRun` 的行级 `effort` 不在候选 ⇒ `INVALID_QUERY` **且中文原因点名两个值域**（未选触发时还要说明用的是缺省档）；三家都显式声明 `reasoningEfforts`，声明了 `defaultEffort` 的家必须让它落在自己的档位域里。

### 5.2 执行模式

| 模式 | 行为 |
|---|---|
| **并行** | 所有候选行同时开跑，不设并发上限 |
| **串行** | 一行跑完（含评分）才起下一行 |

**串行不是「共用一个工作目录」**：每候选行依然有独立工作区（F6）。串行省的是 CPU 与供应商配额，不省工作区。靠用例级本地缓存（F7），每行复制是秒级的。

**并行模式的风险与对应**：不限并发会同时抢 CPU 与供应商配额，最先触发的通常是限流而不是机器瓶颈。因此每行必须有**失败隔离**（F12）——一行的失败不牵动其他行；**时限不设**（执行与评分都跑到自己收场，见 F12 的代价登记）。

**执行模式随评测落库，运行中不可改**（F9）。

### 5.3 列表 + 详情

**列表**列：标题（首列列名逐字是「标题」，与用例页同形）/ 状态 / 候选数 / 执行模式 / 创建时间。

**详情（右栏）**：

- **顶部信息行**：用例标题 · **代码仓库** · 分支（`repoBranch !== null` 的远端轮次才有这一格）· commit（**全量 40 位**，不再截短哈希、不挂 `Tooltip`）· 工作基目录；`extra` 放「编辑 / 删除」（§5.3.3）。
- **串行模式下的进度**：`3/6 已完成`（`completionPercent(done, total)`，`total <= 0` 返回 0，绝不让除零的 `NaN` 流进界面）。
- **候选卡片列表**，每行一张 `Card`：

```
┌──────────────────────────────────────────────────────────────┐
│ Claude Code · claude-opus-4-6                        [已评分] │
│ 分支 test/520ad8a1-67ea-48db-94b8-726af8abcdac                 │
│ tok 128,450   缓存命中 98%   轮次 17   耗时 6m23s   得分 87     │
│ ──────────────────────────────────────────────────────────── │
│ [执行日志] [变更详情] [开始执行 / 重新执行] [评分详情] [重新评分]  ┃ [终止] │
└──────────────────────────────────────────────────────────────┘
```

- 运行中实时刷新 token 累计、轮次、耗时（实时计数走 SSE；列表与详情的**快照**另有「有活在跑时每 3 秒」的轮询兜底，见 §8）。
- 卡片底部一行**活动行**，只在运行态显示「此刻在做什么」，文案由适配器按同一份词表发下来（§5.6.9）。
- 出分后按 **总分降序 → 耗时升序（`null` 当最差）→ tok（输入+输出）升序**（`compareRows`）排序；**名次 = 1 + 严格优于它的行数**，三项全同的行**并列同名次**，`rank <= RANK_BADGE_LIMIT`（3）的行带排名徽标（并列时挂徽标的行可以多于三行）。
- `MetricLine` 的 **tok / 轮次**两格在**真有子智能体分量**时多一行 Tooltip（`缓存命中` 是派生值、不挂浮层；口径见 §7.5）。
- 三个查看按钮各开一个 `Drawer`（几何见 §5.3.4）：
  - **执行日志**：流式追加、可自动滚底、可下载。
  - **变更详情**：逐文件 + 吸顶标题 + 惰性加载（§5.3.4）。
  - **评分详情**：逐组表格（引用键 / 目标 / 权重 / 判定 / 理由）+ 总评 + 原始返回（§4.3）。
- 串行模式下等待中的卡片显示「串行排队中：前一行结束后自动开始」。
- diff 被截断时（见 §5.5 第 7 步）卡片上标注「diff 已截断」。
- 卡片上另有「**重新评分**」（§5.3.2）与「**重新执行 / 开始执行**」（§5.3.1）两个按钮，各带自己的 `disabled` 判据与 `Tooltip`。这四个（执行日志 / 变更详情 / 执行这一行 / 评分详情）加「重新评分」共**五个**都**常驻渲染**——其中四个靠 `disabled` 控可用性、**执行日志连禁用态都没有**（永远可点）；而「终止」是**另一个分支**——只有 `preparing` / `running` / `judging` 时**存在**，其余行态整个按钮不在 DOM 里（图里那个 `[终止]` 因此画在竖线右侧）。

**吸底操作栏** `Layout.Footer`：

| 按钮 | 语义 | 禁用条件 |
|---|---|---|
| **开始** | 执行所有**未完成**的行（`isRunnableRow`：`pending` + `failed` + `timed-out` + `canceled` + `interrupted` + `skipped`；**`judged` 不在内**——已经出分的行不该被一次误点重跑掉几十分钟） | 存在运行中的行；或没有可执行的行；或**本次「开始」请求在途**（`starting`——从点下到快照翻成 `running` 之间 `hasRunning` 还是假，这一格正是防第二次 POST 的那一拍） |
| **终止** | 停止所有在跑的智能体子进程 | 无运行中的行；或**本次「终止」请求在途**（`aborting`） |

- 「开始」触发 `Modal.confirm`，列出本次将执行的候选清单（避免误点跑掉几十分钟）。
- 「终止」用 `Popconfirm`——它杀进程，不可撤销。
- **候选卡片内另有「终止」**（仅对运行中的该行可见）：全开并发下，某一行明显跑歪却不必等它跑完才腾资源。`cancelMidTurn: false` 的家（DSH）这一格文案退化为**「关闭运行时」**（判据在 `eval-row-card.tsx`，见 §5.6.2）。

#### 5.3.1 单行执行（只跑当前候选）

**判据分两档**（都在 contracts）：

| 判据 | 回答的问题 | 条件 | 谁在用 |
|---|---|---|---|
| `canRunRow` | 能不能**就现在**把这一行跑起来 | `!isRunningRow(row.status)` | 服务端放行、按钮 `disabled` |
| `canRetryRow` | **重**跑这一行有没有对照物 | 不在跑 + 有可比基线（`baselineCommit !== ''`）+ 有产出（`diff !== null`） | 按钮**文案**与确认框措辞；**服务端**也用它——决定事件标记与日志写「重新执行」还是「开始执行」（`orchestrator.ts`） |

两者是**单调关系**：能重新执行 ⇒ 必然能单跑，反之不然（测试里有一条守卫钉着）。

**一个按钮，文案按行态分叉**：没跑过的行 ⇒「开始执行」；跑过的行 ⇒「重新执行」；**正在首跑**的行（`preparing` / `running`，还没有基线）也显示「重新执行」⇒ 文案判据是 `canRetryRow(row) || isRunningRow(row.status)`，不是单纯的 `canRetryRow`。确认框同样分叉且**都必须点名范围**：首跑「只跑这一个候选：本轮其他行（含已经执行过的行）都不会重跑。」；重跑「候选 agent 与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。只跑这一行，本轮其他行不动。」

**并发**：本轮其他行在跑**不拦**单行执行（`retryRow` 的互斥只针对这一行：`rowAborts` / `retryTasks` 防的是「两条执行同时改同一行的状态」）。

**服务端只换判据，执行体一个字不改**：`retryRow` 仍是「同步落 `preparing` → 起 `runRow` → `finally` 里补一次 `finalizeRun`」，放行判据分三级（顺序承重）：该行在跑 ⇒ `CONFLICT`「请先终止它，再执行」→ `rowAborts` / `retryTasks` 里还有这一行 ⇒ `CONFLICT`「上一次的运行还没收尾，请稍候再试」→ `!canRunRow` ⇒ `retryRefusal`。`retryRefusal` 收成一句**竞态兜底**（走到它只可能是「读快照时不在跑、落状态前那一拍它跑起来了」），带 `log.debug`。按行态写不同的日志与事件标记（`[开始执行]` / `[重新执行]`）。

**唯一承重不变量**：单行执行**只动这一行**——本轮其他行的状态、分数、计量、diff、`attempts` 以及它们的事件日志与尝试账本全都逐字不变，串行队列不推进。守卫用三行串行夹具（跑第 1、3 行后只跑中间那一行）：逐字比对另外两行的**全部字段**（`JSON.stringify` 相等）；两行的 `events.jsonl` 与尝试账本条数都不变；`fakeAgents.calls` 只多一次。

**已知缺口（另行处置）**：`POST …/retry` 的准备阶段是**同步重活**（`ensureMirror` / `resolveRemoteRef` 的镜像 fetch 在编排层准备阶段、**先于** `prepareRowWorkspace`；后者做的是用例缓存的确保 / 复制、清上一轮产物与 checkout，都不联网），编排层已用 `await yieldToEventLoop()` 把它移出 `retryRow` 的调用栈（`retryRow` 只落 `preparing` 快照就返回），但它仍**整段占住事件循环** ⇒ 远端仓库 + 冷镜像时这一次运行会长时间停在 `preparing`，同进程的其它请求（含这一次请求自己的响应）也跟着排队；强杀重启会留下在途锁（`recoverInterruptedRuns` 标记为 `interrupted` 的行可能仍有活着的 `runRow` 与厂商 CLI 子进程留在旧模块实例里 ⇒ 该行此后一律 409，只能杀掉残留进程才恢复）。

#### 5.3.2 重新评分（只重跑评分那一步）

**判据 `canRescoreRow(row)`**，三个条件缺一不可：不在运行中（`preparing` / `running` / `judging`）· `baselineCommit !== ''` · `diff !== null`。⇒ 可重评的面 = 「跑过一次、产出了改动」的所有终态（`judged` / `failed` / `timed-out` / `canceled` / `interrupted`），**与这一行是否失败过无关**（`error.stage` 只是「这一笔失败发生在哪一段」的事实记录，不参与任何判据）；`pending` / `skipped` 得到两条**点名原因**的明确拒绝（「工作区未就绪」与「没有可复评的改动」，界面与服务端各一份同义文案）。界面与服务端**共用这一份**判据（`eval-row-card.tsx` 用它决定按钮与 `Tooltip` 原因，编排层的 `rescoreRefusal` 用它抛 `CONFLICT`）。

**服务端 `evaluator.rescoreRow(runId, rowId)`**：`requireRow` → `rescoreRefusal`（含编排层独有的 `settling`：`rowAborts` 里还有这一行的条目 ⇒ 拒）→ `loadConfig`（**用例必须仍存在**：题面与仓库来源没有快照进 `run.json`）→ 注册 `AbortController`（与候选阶段同一把钥匙 ⇒「终止」按钮在评分阶段天然有效）→ 落 `[重新评分]` 日志 → `setRowStatus('judging', { error: null, score: null })` → 跑评分（与完整跑一行的第 7 步**同一个函数** `runJudgeStage`）→ `patchRow({ score })` + `publishRowEvent({ type: 'score' })` → `setRowStatus('judged')` + `publishRowEvent({ type: 'end', exitReason: 'rescored' })`；失败/终止复用 `settleFailed` / `settleAgentJudgeStop`；`finally` 里 `clearRowRuntime` + `finalizeRun`。

四条硬口径：

1. **重新评分追加事件、不 `resetEvents`**（事件日志是执行的唯一真相源）；也不递增 `attempts`（它只统计候选阶段的重试）。
2. **入口区必须能整体回退**：登记控制器 / 写标记事件 / 写状态三步里任何一步抛 ⇒ `clearRowRuntime` 抹掉全部痕迹再抛（否则这一行会带着一个活着的条目停在终态，此后永久不可重评——而清理者挂在那个没起来的任务上）。
3. **终态复检**：评分返回时该行已是终态（用户先点了终止）⇒ 状态保持 `canceled`，分数只写进事件日志。
4. **`row.diff` 一个字都不动**：重评只跑评分，`diff` 属于候选阶段（把污染对照现算的那份写回去会让「diff 已截断」徽标凭空消失）。

**界面**：行卡片加「重新评分」按钮 + `Popconfirm`，`canRescoreRow` 为假时 `disabled` + `Tooltip` 给原因。代价（会把现有分数先清空、重评失败就丢掉旧分）由 `Popconfirm` 声明**一半**（文案逐字是「只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。」——它没写「失败旧分也不回来」），**而不是**由判据替使用者做决定。

#### 5.3.3 评测的修改与删除

**口径**

- 修改范围 = **用例 + 执行模式 + 使用智能体评分 + 候选行**（与创建表单完全对齐）。
- 只要**没有行在运行**（`!hasLiveRows(run)`）就可以改，改动**作废受影响行的结果**。
- **行 id 是行身份**：编辑入参的候选行带可选 `id`（表单必须能说清「这一行还是原来那一行」）。
- 被改动的行**原地重置**（行 id / 分支 / 工作区路径都不变），只清快照字段。
- **编辑路径不碰文件系统**：产物留给重跑时清理（`prepareRowWorkspace` 会自己清 `workspace/`、`.agenthome/`、`.judgehome/`，`runRowAttempt` 会 `resetEvents`）。
- 删除**分两步且顺序承重**：① 删 `run.json` ② `rmSync` 整个 `{workspaceBase}/{runId}/`；②失败**只 WARN 并如实回报**（响应 `workspaceRemoved: false`）。
- 用 **`PUT /api/runs/{runId}`**（不是 PATCH）：payload 的语义就是「这一轮应当长成什么样」。
- 编辑表单**复用 `RunCreatePanel`**（加 `mode: 'new' | 'edit'`）。
- 判据只加**一份** `hasLiveRows(run)`，编辑与删除共用。
- 编辑后**轮级状态收敛一次**，用新口径**而不是**现成的 `finalizeRun`（后者对「全行 pending」会落 `partial`）。
- `EvalRun` **不加字段**（列表的「创建时间」是复现条件之一，编辑不该让它变）。
- 新增行的 `workspacePath` 按 **`run.workspaceBase`** 现算，**不用当前 `settings.workspaceRoot`**（一轮的产物必须与它的快照同根）。

**契约（`contracts/src/run.ts`）**

```ts
/** 编辑交回的「这一轮应当长成什么样」：与创建的差别只有候选行可带 id */
export const RunUpdateSchema = RunCreateSchema.extend({
  rows: RunCreateSchema.shape.rows.element        // 派生而非手抄：手抄的那份在创建侧新增可选字段时会静默剥掉它
    .extend({ id: z.string().min(1).optional() }).array().min(1),
});
// RunCreateSchema / RunCreate 逐字不变（创建路径不带 id，服务端也不读它）

/** 这一轮此刻还有活在跑吗（轮级 running，或任一行处于 preparing/running/judging） */
export function hasLiveRows(run: EvalRun): boolean;

/** 编辑交回的这一行与现有行还是不是同一件事（agentKind / providerId / modelId / effort 逐字比较） */
export function isSameRowTarget(row: EvalRow, next: { agentKind; providerId; modelId; effort? }): boolean;
```

`isSameRowTarget` 也必须在 contracts：它有两个消费方（服务端 `planRunUpdate` 决定重置哪一行、编辑表单**事先算出这次会作废哪几行**），两处各写一份的漂移症状是「确认框说会作废 2 行，实际作废了 1 行」——那正是用户唯一能核对的地方。`providerName` / `baseUrl` 是服务端快照，不入判据（改个供应商名字不该把已经跑出来的成绩打掉）。**强度参与判定，且「一侧没给」算改了**：档位是**被评对象**的一部分，且编辑载荷是候选行的**全量替换**，「这一格没有」只能读成「未指定档位」——宁可多重置一行，也不能静默保留一个用户已经改过的档位跑出来的分。

**逐行处置表（`PUT /api/runs/{runId}`）**

| 编辑动作 | 行快照 | 该行的磁盘产物 |
|---|---|---|
| 只改执行模式 / 只改「使用智能体评分」 | **一行都不动** | 不动 |
| 改某行的 agent / 模型 / 强度 | 该行**原地重置**：`status → 'pending'`、`baselineCommit → ''`、`tokens / turns / durationMs / diff / score / error → null`、`attempts → 0`、`effort` 按新值重建（缺省即不写键）（⚠️ `subagentTokens` / `subagentTurns` 当前**不在重置之列**——`resetRow` 没清这两格，属已知的数据卫生缺口，界面因两行拆分要求 `tokens !== null` 而看不出来） | 不动（重跑时既有机制清） |
| 新增一行 | 新 `rowId`（`randomUUID`）+ `branch = test/{rowId}` + `workspacePath = rowWorkspaceDir(run.workspaceBase, runId, rowId)`；`providerName` / `baseUrl` 由服务端快照；其余字段与 `createRun` 的行初值逐字相同 | 无（首次 prepare 时建） |
| 删掉一行 | 从快照移除 | **不动**（孤儿目录留给整轮删除时回收） |
| 换来用例 | 重取 `caseId / caseTitle / repoPath / commitHash / repoBranch / rubric` 快照（`caseId` + 五格冗余字段）+ **所有行**按「原地重置」处理 | 同上 |

行对齐规则（**行 id 是唯一对齐键**）：带 id 且命中 ⇒ 原地更新；带 id 但**不命中** ⇒ 抛 `NOT_FOUND`「该评测里没有这一行（…）」**不静默当新行**；带 id 且在**同一入参里出现两次** ⇒ 抛 `INVALID_QUERY`「编辑入参里重复引用了同一行（…）：每一行只能出现一次」（与「未知 id」是同一处的孪生检查）；不带 id ⇒ 新行；现有行不在 patch 里 ⇒ 删除。

四条口径：**「改了才重置」按值判**（表单交回来的永远是全量行集合，按「字段出现没有」判会把每次保存都变成全行清空重来）；**`attempts` 在重置时清零**（与 `retryRow` 刻意不清零相反：重试重跑的是同一件事，编辑换掉的是**被评对象**——留着「尝试 3 次」等于让新模型凭空背上旧模型的账）；**轮级状态收敛一次**（在同一个 `saveRun` 里落地，不额外写盘）：全行 `judged` ⇒ `done`（`finishedAt` 已非 null 保留原值，否则填当前时刻）、否则 `startedAt === null` ⇒ `idle`（`finishedAt = null`）、否则 ⇒ `partial`（`finishedAt = null`）；**校验链与创建共用一份，先全校验、再一次性落盘**（顺序逐字沿用 `createRun`；编辑不为已存在的行生成新 id；任何一步抛 ⇒ **一个字节都不写**）。

**互斥与并发**：`hasLiveRows` 之外另加一条纵深守卫 `assertRunMutable`——`runTasks` / `retryTasks` / `rescoreTasks` / `rowAborts` 里还有这一轮或这一行的条目 ⇒ 409 `CONFLICT`「这一轮上一次的运行还没收尾（…）：请稍候再试，或先终止它」（`hasLiveRows` 读的是**快照**，而行刚落终态、任务还在收尾的那一拍快照是「没有活」）。守卫落在 evaluator（那是这些表的家），api 在**算新快照之前**调它（`resolveRunRows` → `assertRunMutable` → `planRunUpdate` → `saveRun`）。**四张表并非今天都开火**：`runTasks` 那一条**构造上不可达**（`startRun` 收尾把 `finalizeRun` 与 `runTasks.delete` 放在同一个同步片段里，单线程没有窗口），真正开火的是**行级在途表**——那一档 409 的唯一生产者是「行已落 `failed`、`runRow` 还在重试退避里」，此时 `rowAborts` 与 `retryTasks` **两张表同时持键**（遍历顺序里 `retryTasks` 还在前）；`runTasks` 留作将来异步改造的兜底。

**删除顺序**：存在性检查（404）→ `hasLiveRows` ⇒ 409 → 同一套互斥守卫（`assertRunMutable`）→ ① 删 `{run.workspaceBase}/{runId}/run.json` → 从进程内根记忆里忘掉这一轮（`run-root-memory` 的 `forgetRunRoot(runId)`）→ ② `rmSync({run.workspaceBase}/{runId}/, { recursive: true, force: true })` → ②失败只记 WARN + 响应 `{ workspaceRemoved: false }`。边界：**只删当前 `settings.workspaceRoot` 里可见的那一轮**（与读侧口径一致）。拆两步的理由：整目录一把删时 `rmSync` 的遍历顺序不保证，中途 EPERM 会让「快照到底删没删」变成不确定。

**接口分层**

| 层 | 落点 | 职责 |
|---|---|---|
| contracts | `contracts/src/run.ts` | `RunUpdateSchema` / `hasLiveRows` / `isSameRowTarget` |
| evaluator | `evaluator/src/orchestrator.ts` | `assertRunMutable(runId)`（互斥守卫）与 `deleteRun(runId)`（两步 + 根记忆） |
| api | `api/src/runs.ts` | `updateRun`：取快照 → `hasLiveRows` → 校验链（`resolveRunRows`）→ `assertRunMutable` → 算新快照（`planRunUpdate`）→ `saveRun`（互斥守卫排在**算新快照之前**：规划器读的是取快照那一刻的状态，按它规划出来的新快照会盖掉编排层正在写的那一份）；`deleteRun`：存在性检查 → 转 evaluator |
| 路由 | `apps/web-next/app/api/runs/[runId]/route.ts` | 现有文件加 `PUT` / `DELETE`，只做「zod 校验 → 调 api → 错误映射」 |

两个都落在 `orchestrator.ts`，**不拆到 `run-store.ts`**：`assertRunMutable` 要看的那四张表都是该模块私有的，而 `deleteRun` 若放进 `run-store.ts` 就会为了这个守卫 import orchestrator，得到循环 import。算新快照拆成两个**可导出、可直测**的函数：`resolveRunRows(rows, providers): ResolvedRunRow[]`（校验链 + 供应商快照，**创建与编辑共用**）、`planRunUpdate(run, input, resolved, target: RunTargetCase): EvalRun`（对齐 / 重置 / 轮级收敛，不做 I/O、不查配置与注册表；唯一外部状态是新增行的 `randomUUID()` 与当前时刻 `new Date().toISOString()`——后者供轮级收敛写收尾时间）。两者只从 `api/src/runs.ts` 导出（**不从 `@aieval/api` 包根转出**，包根只转 `updateRun` / `deleteRun` / `retryRow` 这些真正的消费出口）。

**界面**：`RunDetailPanel` 顶部信息卡的 `extra` 加「编辑 / 删除」（与 `CaseDetailPanel` 逐字同形）：两个汉字的按钮一律 `autoInsertSpace={false}`；删除用 `Popconfirm` 且 `onConfirm` **必须回交在途 promise**（返回 `undefined` 时确认框立刻关闭，用户会再点一次 = 第二次 DELETE）；删除文案说清「会连这一轮的全部行工作区与执行日志一起删掉，不可恢复」；`hasLiveRows` 为真时两个按钮都 `disabled`；**原因只在「编辑」那一格有 `Tooltip`**（「删除」被 `Popconfirm` 的 `disabled` 一并挡住，禁用态没有任何解释），服务端同一判据抛 409（两层都有）。新增 props `onEdit` / `onDelete` / `deleting?`。编辑表单加 `mode` + `initial?`，行值多带 `id`；提交类型收敛成 `RunFormValues`，`new` **显式剥掉 id** 再交给 `create`（**新建对象**，不动表单内部持有的行值），`edit` 原样交给 `update`；`mode` 与 `initial` 变更靠 `key` 重挂载（`initialValues` 只在挂载时读一次；**现状：`app/runs/page.tsx` 两处 `RunCreatePanel` 都未给 `key`**）。**保存前的确认框**：用 `isSameRowTarget`、`caseId` 与被从表单里删掉的行三条判据算出会作废的行（只算「跑过」的行：`attempts > 0` 或已处终态），**非空时** `Modal.confirm` 列出它们（`agentKind · modelId · 原状态`）后才发 `PUT`；**只改执行模式 / 只改评分方式时什么都不作废、不弹**（无事发生却弹窗 = 噪音，弹多了用户就会闭眼点确定）。页面右栏由两种内容变三种：`?panel=detail|new|edit&id=…`（`RunsPanelKind` 加 `'edit'`，`parseRunsPanel` 认 `edit` 且**必须带非空 id**，缺 id 回落「不显示右栏」；未知 `panel` 仍按「有 id 就是 detail」兜底）；列表选中高亮放宽到 `detail | edit`；编辑成功 ⇒ `message.success('评测已保存')` + 回 `?panel=detail&id=`，删除成功 ⇒ 回 `/runs` + `message.success`，`workspaceRemoved === false` 时补一句「行工作区有残留（被占用），可手动清理」。

**数据层**：`useUpdateRun()`（`PUT` → `mutate(runKey(id), updated, { revalidate: false })` + `await mutate(RUNS_KEY)`）、`useDeleteRun()`（`DELETE` → `mutate(runKey(id), undefined, { revalidate: false })` + `await mutate(RUNS_KEY)`）；两个都**不用** `useSWRMutation`（该文件头写明理由：写操作的响应要同时写进**详情**与**列表**两个键，而 `useSWRMutation` 只绑定一个键；顺带的好处是 runId 调用时才拿到、写操作没进 SWR 的 fetcher ⇒「窗口重新获得焦点重发一次写请求」这条坑在形状上不存在）。`api/src/index.ts` 的评测域转出加 `updateRun` / `deleteRun`；`route-runs.test.ts` 对 `@aieval/evaluator` 的手写 mock 键清单**必须跟着补** `assertRunMutable` / `deleteRun` / `requireJudgeAgent`（缺键**不在模块求值期**抛：模块照常求值，vitest 的 mock 命名空间是**访问那一刻**才抛「No … export is defined on the mock」，于是红的是**走到那条路径**的用例（服务端 500），同文件其余用例照绿；没有任何执行路径访问的键缺了甚至全绿）。

**守卫**：只改执行模式 ⇒ 所有行逐字不变；改某行模型 / 强度 ⇒ **只有那一行**重置（未重置的行 `attempts` 保留）；改用例 ⇒ **六格**用例快照（`caseId` + 五格冗余字段）重取 + 全行重置；删行 ⇒ 从快照消失且 patch 里的未知 id 抛 `NOT_FOUND`、patch 里重复引用同一行 ⇒ `INVALID_QUERY`；新增行的 `workspacePath` 落在 `run.workspaceBase` 下；`attempts` 归零（**未被重置的行不受影响**）；轮级收敛三条分支各按口径（全 judged ⇒ `done` / 从没跑过 ⇒ `idle` / 其余 ⇒ `partial`）；运行中 / 在途任务未收尾 ⇒ 409、校验失败 ⇒ **一个字节都不写**；`deleteRun` 的顺序断言（先快照后目录）+ 回收失败仍删快照 + 删后 `getRun` 404 + 根记忆被忘记；编辑表单预填**带行 id**；确认框该弹时列出被作废的行、不该弹时不弹。

#### 5.3.4 「变更详情」抽屉（逐文件 + 吸顶标题 + 惰性加载）

**形态**：文件名 + 内容的**一个可滚动列表**，向下滚动时当前文件标题**吸顶**，改动内容用 diff 组件渲染；抽屉标题「变更详情」。

**组件**：`react-diff-viewer-continued@4.4.0`（原 `react-diff-viewer` 的 peer 不含 React 19；continued 是同 API 的维护分支，额外白拿 `highlightLanguage` 与内置行虚拟化）。

**一个必须写清的接口错配**：该系列的 `oldValue` / `newValue` 收的是**完整文件正文**，不是 diff 文本；把 diff 文本直接当 `newValue`、`oldValue` 传空串，会渲染出一份**完全错误的 diff**（`+foo` 变成「新增了一行字面量 `+foo`」）。**由 diff 文本还原两侧正文**（`ui/composite/diff-patch.ts` 的 `reconstructSides`）：解析 hunk 头拿行号，用上下文行与 `/^-/` 行拼旧侧、用上下文行与 `/^+/` 行拼新侧，**并按 hunk 头的行号把两侧各自恢复到真实位置**（缺失行留空洞，**不补空串到等长**——补了会让 jsdiff 把未修改的行画成假的红绿），组件侧同时传 `showDiffOnly={false}` 让这些空洞如实显示为「未修改」；`extraLinesSurroundingDiff` 保持默认。理由：diff 文本已经是服务端算好的唯一真源，另取全文会让「界面显示的改动」与「评分模型看到的改动」变成两次独立计算，而这两者必须逐字一致。`file.binary` 为真时（服务端按「补丁里没有 `@@`」判定）不渲染 diff 视图、显示「二进制文件，没有可显示的文本改动」；两侧都还原成空串时显示的是另一句「这个文件没有可显示的文本改动」。

**超万个文件变更**

1. **正文已经有硬上限**：`collectDiff` 的正文（`text`）经 `truncateDiff(text, settings.diffBudgetBytes)` 裁剪（默认 **262144 字节 = 256 KB**），按 `diff --git` 整段保留到预算为止，超出部分只留文件名（丢弃的逐个点名并写进正文的截断说明里）。
2. **`collectDiff` 的 `files` 没有上限** ⇒ 真正的风险在文件清单本身。三条对策：**文件索引与正文拆成两种响应形态**（同一个 `…/rows/[rowId]/diff` 路由：`?offset=&limit=` → 索引、`?file=` → 单文件正文，`file` 优先；索引不含任何 diff 正文，按 `offset` / `limit` **分页**，每页 30，界面逐页追加 ⇒ **首帧只渲染一页（30 条）**，其余按滚动逐页追加，**已加载的页不回收**（列表没有虚拟化：一路滚下去 DOM 会线性涨到「已加载的全部条目」，这是刻意换来的「不重排」）；**正文按需、逐个文件加载**（`IntersectionObserver` 触发，任何一次响应都不携带「全部文件」）；**单个文件的正文不做二次截断**——`truncateDiff` 是按**整文件**丢弃的，**永远不会把一个文件的正文切一半** ⇒ 「某文件正文显示了一半」这个状态不可能出现，故 `RowDiffFile` **没有** `truncated` 字段（留一个恒为 `false` 的字段，下一个人会照着它写一条永远进不去的分支）。
3. **吸顶与惰性加载是同一个机制**：滚动正是加载的触发器，两件事在同一时刻发生，不需要两套滚动监听。
4. **服务端计算缓存**：api 层加**进程内**结果缓存，键 `(runId, rowId)`，值 = `collectDiff` 的原始输出 + 预算裁剪结果，**TTL 30 秒**（命中即续期；另有限条数上限）。语义是「打开抽屉这半分钟内的快照」，与 `useRowDiffIndex` 现有的 `revalidateOnFocus: false` 口径一致；不做主动失效（候选中途会写盘，主动失效要在编排层埋钩子）；缓存只在内存、进程重启即失效。

**契约（替换 `RowDiffSchema`，是替换而不是并存——调用方只有抽屉一处）**

```ts
export const RowDiffIndexSchema = z.object({
  files: z.array(z.object({
    path: z.string(), insertions: z.number(), deletions: z.number(),
    untracked: z.boolean(),        // 该文件在「未跟踪文件」段里
    hasBody: z.boolean(),          // false = 被 diffBudgetBytes 预算（默认 256 KB）丢弃 ⇒ 界面不给加载入口
  })),                             // 顺序 = numstat 两段的输出顺序（`mergeFilesByPath` 不排序）
  total: z.number(),               // 文件总数（不受分页影响）
  offset: z.number(),
  insertions: z.number(), deletions: z.number(),   // **全部文件**的增删合计（不是本页——头部要的是全局值）
  noBodyCount: z.number(),         // 全部文件里有多少个没有正文
  truncated: z.boolean(),
  droppedFiles: z.array(z.string()),               // 被预算丢弃的文件名（评分模型看不到它们）
});

export const RowDiffFileSchema = z.object({
  path: z.string(),
  patch: z.string(),               // 该文件那一段统一 diff 原文
  insertions: z.number(), deletions: z.number(),
  binary: z.boolean(),             // true 时界面不渲染 diff 视图
});
```

`hasBody` 的存在理由：**让「被预算丢弃」在界面上是可预期的，而不是点一下才发现没有**；它由服务端按预算算出，与 `droppedFiles` 同源。

**服务端**

- `core/src/git.ts` 新增导出 `extractDiffFile(text, path): string | undefined`（按路径取某一段 diff 原文）。**必须复用私有的 `splitDiffFiles`，不得另写一份切分逻辑**（两份切分器漂移的表现是「索引里有的文件，正文永远取不到」，且只在路径含特殊字符时出现）。**必须处理一处已存在的陷阱**：`splitDiffFiles` 从 `diff --git a/X b/Y` 取路径时是**原样取**的，而 `RowDiff.files[].path` 来自 `--numstat` 并**经过 `rewriteRenamePath` 规范化**（花括号重命名 `packages/{old => new}/x.ts` → `packages/new/x.ts`）⇒ 两个来源的路径键可能不相等，按未规范化的键去找，重命名文件的正文永远取不到。故 `extractDiffFile` **必须对切出的路径同样套一次 `rewriteRenamePath`** 再比对（该函数对已规范化的路径是幂等的）。**同名文件在「已提交」与「未提交」两段都出现时取「未提交」那一段**（未跟踪文件的正文只在未提交段；且未提交段反映的是工作区当前状态，用户打开抽屉想看的正是「现在这个文件被我改成什么样了」）——实现上就是**倒序扫描**这两段。
- `api/src/run-artifacts.ts`：`getRowDiffIndex(runId, rowId, offset, limit)` 与 `getRowDiffFile(runId, rowId, path)`，两者共用一次 `collectDiff` 结果（即那 30 秒缓存）保证同源。`getRowDiffFile` 对未知路径抛 `NOT_FOUND`、对 `hasBody === false` 的路径抛 `CONFLICT` 并说明是被预算丢弃——**两条必须分开**（「这个文件不存在于本次改动」与「它存在但正文被裁了」在排障时是两回事）；索引里有、正文段里却没有 ⇒ `INTERNAL`（同一份切分器不该出现这种状态）。
- 路由 `…/rows/[rowId]/diff/route.ts` 读查询参数：`?offset=0&limit=30` → 索引；`?file=<path>` → 单文件（`file` 优先）。`limit` **服务端封顶 200**（`DIFF_PAGE_MAX`），`offset` / `limit` 非法一律按默认值处理而不是 400（只读展示接口，宽容降级比报错更有用）——**封顶与降级都在 api 层**，路由只给默认值。`file` 用 `searchParams.get` 直接取（**它已经解过码，不得再 `decodeURIComponent` 一次**——含 `%` 的真实路径会抛 `URIError` ⇒ 500）且**路径不得被当作文件系统路径使用**（只用来在内存里比对 diff 段落中的路径字符串，不参与任何 `path.join`）。

**客户端**

- `client/src/runs.ts`：`useRowDiffIndex(runId, rowId, enabled, offset, limit)`（沿用 `revalidateOnFocus: false`；`!enabled` 或 id 为空时 SWR key 传 `null`）；`useRowDiffFile(runId, rowId, path)`（**没有 `enabled` 这一位**：`path` 为 `undefined` 时 key 传 `null`——这正是「滚动到才加载」的开关，不需要另造布尔；路径要 `encodeURIComponent`）。
- `ui/composite/diff-view.tsx` 重写：

```ts
export interface DiffViewProps {
  index: RowDiffIndex | undefined;
  /** 逐文件正文的渲染件：由调用方注入，本包不调接口（四态由同包的 `DiffFileContent` 承担） */
  renderFileBody: (path: string) => ReactNode;
  onLoadMore?: () => void;
  dark: boolean;
}
```

- **布局**：汇总条（`共 N 个文件 · +X −Y` + 截断提示，**文案沿用「评分模型看不到它们」**——改成「已截断」会让人以为只是界面没显示全）→ 搜索框（按路径过滤，只对**已加载页**做 `includes`，提示语是「仅在已加载的 N 个文件里过滤（共 M 个）」，不做服务端搜索）→ 文件列表（每项 = 吸顶标题 + 正文；标题 `position: sticky; top: 0`，**滚动容器是 `.ant-drawer-body`**（列表自己不套第二层 `overflow`）——sticky 相对最近的滚动祖先定位；标题内容 = 路径（等宽）+ `+X −Y` + 未跟踪标签（标题条只有这三项，截断 / 二进制标记挂在正文那一格）；`hasBody === false` 的条目标题照常吸顶、正文位置显示「该文件超出体积上限，未包含在本轮评分输入中」且不给加载入口；正文由 `IntersectionObserver` 在进入视口时触发加载，**没有 IO 时退化为立即渲染**；加载中显示 **`Skeleton`，不是空白**——空白会被误读成「这个文件没改动」）→ 列表底部哨兵元素触发下一页（走 ref 防「加载 → 重渲染 → 再触发」的自我维持循环）。diff 组件 `disableWorker` 传 `true`（每行一个 worker 在几十个文件同时进视口时是纯开销，且 jsdom 里没有 worker），并关掉并排视图与自带汇总。
- **抽屉几何（三个抽屉共用，落点是 `ui/src/base/drawer-geometry.ts`）**：宽度 `size={WIDE_DRAWER_SIZE}`，`WIDE_DRAWER_SIZE = 'max(50vw, 800px)'`（用 CSS `max()` 而不是在 JS 里量窗口；**显式写 `maxWidth: '100vw'` 是为了让「窄屏下 800px 下限不许撑出屏幕」这条意图留在代码里**）；内容区 `body: { padding: 0 }`，内边距由**每个抽屉的内容自己提供**（变更详情：汇总条与搜索框各带横向 padding，**文件标题条自带横向 padding**（吸顶底色要铺满整宽 ⇒ padding 加在标题条自身），**diff 正文不额外加横向 padding**；执行日志：`AgentLogLayout` 的滚动区 `Flex` 加 padding；评分详情：最外层加 padding）；限高**不写死 `maxHeight`**——高度链由 antd 自己铺好（`.ant-drawer-section` 是 flex 列 + `height:100%`、`.ant-drawer-body` 是 `flex:1; min-height:0; overflow:auto`）⇒「随窗口自适应」= 什么都不写。**抽屉内只有一个滚动容器，就是 `.ant-drawer-body` 本身**：它自己已经是 `overflow: auto`，而 sticky 相对最近的滚动祖先定位 ⇒ 不要在它内部再套一层 `overflow: auto`；内容高度用 `minHeight: '100%'`（不是 `height`，否则内容短于视口时铺不满）。**静止态下、且没有二级抽屉打开时，已核实 body 没有任何祖先带 `transform`**（`.ant-drawer` 是 `position: fixed`、content-wrapper 是 `position: absolute`）；有两条**今天就存在**的例外：**其一** antd 自带的开关动画在 `.ant-drawer-content-wrapper` 上写 `transform`（进场 `-enter/-appear` 与 `-leave-active` 是 `translateX/Y(±100%)`、`-enter-active/-leave` 归 `none`；wrapper 常带 `transition: all`，故整个移动过程都有包含块）；**其二** 本仓三个主抽屉都显式传了 `push={MAIN_DRAWER_PUSH}`，二级抽屉打开期间 rc-drawer 会给**被推开的主抽屉**写常驻内联 `transform: translateX(-360px)`。这两处的「吸顶是否失效」**都没有实测，如实登记**；若再给抽屉加常驻 `transform`，吸顶会静默失效，这一条是那一处的护栏。**不给抽屉加 `resizable`**（需求方给的是确定口径，再加一层可拖拽会让「宽度是多少」出现两个答案）。
  > **执行日志抽屉是例外**：它改用虚拟列表自持滚动容器（虚拟列表需要确定高度的视口，而 body 的高度靠 flex 取、给不到那个数）⇒ 那个抽屉的最外层取满父容器（`height: '100%'`）、固定区占自然高度、列表用 flex 取剩余高度。`body.padding: 0` 与宽度那两条照旧适用。
- `dark` **由调用方传入**（`useAppliedThemeMode()`，即 `themeMode === 'dark'`；**不要**就地再调一次 `useResolvedTheme()`——它的偏好缺省是 `'dark'`，SSR 兜底那一拍会拿到暗色），不从 `ui` 包内部猜（避免第二份主题判据 = 半亮主题）。页面把 `useRowDiffIndex` / `useRowDiffFile` 与主题接进新的 `DiffView`，抽屉 `title` 改为「变更详情」。

**「未跟踪文件」段不单独呈现**，只靠文件清单里该条目的「未跟踪」标签体现；不做 diff 行内评论、不做并排 / 内联切换的偏好持久化、不做文件树。

**守卫**：**还原算法**的单测（给一段含两个相隔很远的 hunk 的 diff，断言第二处改动落在与 hunk 头一致的下标上，且两侧行数**各自等于补丁的原侧 / 新侧行数——可以不同**，不得补空串到等长——这条是防「相隔 200 行的改动被渲染成相邻」的回归守卫，是整个设计里最容易写错的一处）；`extractDiffFile` 的正常路径 / 路径不存在 / 重命名 `=>` / `{a => b}` / 含空格路径 / **同名文件在两段中都出现时取未提交段**；索引分页与 `hasBody`；`getRowDiffFile` 的 `NOT_FOUND` 与 `CONFLICT` 两条分开断言；路由的 `?offset/limit`、`limit` 封顶、`?file=`；`diff-view.test.tsx` **逐字保留**「截断提示必须说『评分模型看不到』」那条，并覆盖吸顶 / 骨架 / `hasBody=false` 文案 / 惰性触发。

### 5.4 每候选行状态机

```
pending → preparing → running → (agent 完成) → judging → judged
                 ↘ failed / timed-out / canceled
串行被终止时未轮到的行 → skipped
服务重启时仍在运行的行 → interrupted（不自动续跑）
```

状态语义必须可区分，不能合并：

| 状态 | 含义 |
|---|---|
| `canceled` | 用户按了终止，当时**正在跑**的行 |
| `skipped` | 串行模式下用户终止时**还没轮到**的行 |
| `timed-out` | 超时。**今天没有生产者**：时限已全部删除（F12），三家适配器也都不自报这个码；留着这一档是为了「将来某家真自报超时」与「磁盘上的历史行还带着它」 |
| `failed` | agent 进程非零退出 / 启动失败 / 评分调用失败 / **评分智能体改了工作区** |
| `interrupted` | 服务重启时该行仍在运行 |

**状态的落点唯一**：`setRowStatus(runId, rowId, status, patch?)`（改状态 + 落盘快照 + 追加 `status` 事件成对发生）；`patchRow` 只补字段、不动状态（计量 / diff 摘要 / 分数在跑的过程中逐步落库）。完整跑一行与重新评分**共用同一个评分阶段函数** `runJudgeStage`，两处各写一遍必然漂移。

**失败发生在哪一段**落 `EvalRow.error.stage`（`'agent' | 'judge'`，可选）。为什么必须落盘、而不能从状态里推：两段失败落的行状态可以**逐字相同**（候选 agent 起不来与评分模型起不来都是 `failed` + `AGENT_FAILED`）。它**只是叙述性的事实记录**——没有任何判据读它（两个按钮的可用性都不看它），留着是因为「这一笔失败发生在哪一段」是排障时最常问的那个问题。

### 5.5 一轮评测的内部时序

```
1. 建工作区      {workspaceRoot}/{runId}/rows/{rowId}/workspace/
2. 取基线        远端：镜像 ensureMirror → resolveRemoteRef（本轮唯一一次 fetch）→ 具体 hash
                本地：从 {workspaceRoot}/cases/{caseId}/cache 复制 → checkout
                → git checkout -B test/{rowId} <40 位基线 hash>（一条命令同时切基线并重建行分支；重跑同一行不会因分支已存在而失败）
3. 注入隔离配置  CLAUDE_CONFIG_DIR / CODEX_HOME / DSH_HOME → {rowDir}/.agenthome/
                Claude 侧另加 settingSources: user/project/local（否则读不到被测仓库的 CLAUDE.md）
                + settings.env 把本次路由钉在 flag 档（否则仓库自带的 .claude/settings.json 盖掉路由）
4. 跑智能体      适配器统一接口（getProvider(kind).run）；工作目录 = workspace；交考题提示词
                permission: 'full'
5. 收集计量      token（输入/缓存/输出，含子智能体分量）、轮次、耗时、退出状态
6. 算 diff       git diff {commit}..HEAD + git diff HEAD + git status（登记未跟踪）
7. 评分          按 useAgentJudge 走两条通路之一（§5.5.1）→ 逐项判定 → 收口
8. 落盘          事件追加到 events.jsonl + 快照写入 run.json
```

**第 1 步的缓存准备**：用例级缓存 `{workspaceRoot}/cases/{caseId}/cache` 不存在（或来源记录缺失 / 来源已变）时才**完整克隆一次**（`git clone <repoPath> <cache>`，本地路径克隆很快）；`commitHash` 为空的那一轮还会把缓存 `fetch` 到来源当前 HEAD，请求的 commit 不在缓存里时也先 `fetch origin`。之后的候选行都从它复制。重跑同一行时**先确保缓存、再清上一轮的行产物**（清理范围见 §5.3.3）：清完而克隆失败会留下「没有工作区」的中间态；此顺序下失败时旧产物仍在原处，重跑幂等。

**第 2 步为什么是复制而不是每行克隆**：`git clone <本地路径>` 仍是完整对象复制，每次都要重新打包传输。对每行改用**文件系统级目录复制**（缓存已是完整仓库，复制出的目录直接 `checkout {commit}` 即可），把每行准备时间从「克隆耗时」降到「磁盘复制耗时」。这是让「开一轮评测」秒开的关键。

**第 6 步必须同时取三样，缺一就会漏改动**：`git diff {commit}..HEAD` 只见已提交的改动；**agent 完全可能改了代码而不提交**，只取它会给出一个空 diff 却照样打分。所以还要 `git diff HEAD`（已改未提交）与 `git status --porcelain`（未跟踪的新文件，须先 `git add --intent-to-add` 登记才拿得到正文），三者合并才是候选的完整产出。计数与正文**合并成一次 git 往返**：`diff --numstat --no-color -p <range>`，输出按**第一条行首的 `diff --git `** 切成「numstat 段 + 补丁段」（§9 的墙钟一节）。被 gitignore 的文件不进这份产出：`git add` 没有 `--include-ignored` 选项，且忽略本身就是「这不是产出」的信号——把 `.env` / 构建产物送进评分输入是密钥泄漏与噪声的双重风险。

**第 7 步的 diff 需要体积上限**：`settings.diffBudgetBytes`（默认 256KB）。超出时按文件裁剪并在送给评分模型的内容里**显式标明「已截断」及被截断的文件清单**——否则评分模型会把「看不到的改动」当成「没改」，静默给出错误的高分。同时该行卡片上标注「diff 已截断」，让人知道这一次的分是在不完整输入下得出的。

**分支名 `test/{rowId}` 用行 id 而非轮 id**：同一用例下多候选如果共用一个分支名，会互相踩（`git checkout -B` 会把对方的分支重置到自己的基线，或被迫复用别人改过的分支）。

**所有实体 id（`runId` / `rowId` / `caseId` / `providerId`）都是 UUID v4**，由服务端在创建时生成；`rowId` 同时是分支名的组成部分，因此必须是文件系统与 git 引用名双安全的（UUID 满足）。

**候选行若在 `preparing` 阶段失败**（复制失败、commit 不存在、远端不可达、工作区不可写），仍要落 `failed` 并保留错误详情，不能静默跳过。

#### 5.5.1 第 7 步：两条评分通路

**口径**

- 一轮的评分方式在创建时**快照**进 `EvalRun.useAgentJudge`（缺省 `false`）；**编辑时可以改**（只改它不动任何一行，见 §5.3.3），改完之后新一轮的评分按新值走——同一轮里已经落盘的那一分不变，「一轮里只有一把尺子」说的是**创建那一刻到编辑那一刻之间**。
- 评分智能体复用设置页「默认评分模型」那一对 `(providerId, modelId)`，只额外选「用哪家 CLI 驱动」；尺子只有**一个**来源（`resolveJudgeRoute()` 无参读全局默认）。
- 评分方式另记进**行级** `ScoreResult.judgeAgentKind`（`null` ⇔ 纯文本 API）：轮级字段回答「这一轮打算怎么评」，行级字段回答「这一分实际是谁打的」。
- 评分智能体跑在**该行现有工作区**里（不另建副本），用**独立的配置目录** `.judgehome`（与 `.agenthome` 分开：两家格式不同，共用会互相破坏）；执行层给 `permission: 'read-only'`（提示词里那句「只读评审」是**要求**，这一格是**强制**）。
- 评分智能体的用量**不进行级三格**（`tokens` / `turns` / 子智能体分量都是候选的计量，§7.5），它随这一分记进 `ScoreResult.judgeTokens`（§7.2），并转发成带 `[评分智能体] ` 前缀的日志行（`summary` 不戴前缀——卡片上本来就有阶段 tag，抽屉那条连续时间线才需要前缀分清谁说的）。
- 两条通路共用**解析、收口与执行骨架**：`parseJudgeResponse`（围栏剥离、按引用键逐项对齐、缺一项即失败）+ `finalizeScore`（同一把尺子、同一份契约自检、同一条「总分一律重算、不采信模型自报」）+ `judgeStageAttempt`（迟到事件闸门、用户终止归因、污染对照、终止 race）。

**契约**

```ts
// contracts/src/settings.ts
defaultJudgeAgent: AgentKindSchema.nullable(),          // null = 未配置；SETTINGS_DEFAULTS 里为 null

// contracts/src/run.ts
useAgentJudge: z.boolean().default(false),              // RunCreateSchema 与 EvalRunSchema 都要显式声明：
                                                        // zod 3 的 z.object 默认 strip 未知键，不声明就被静默丢掉
// contracts/src/score.ts
judgeAgentKind: AgentKindSchema.nullable().default(null),

// agents/src/types.ts
finalText: string | null;                               // 三家统一出口，null = 未采到（不猜；与空答复是两件事）

// evaluator/src/judge-agent.ts
export class JudgeAgentError extends Error { constructor(agentCode: AgentErrorCode, message: string); readonly agentCode: AgentErrorCode }
export function buildAgentJudgePrompt(input: { taskPrompt; rubric; baselineCommit }): string;
export async function judgeRowByAgent(input: AgentJudgeInput): Promise<ScoreResult>;
```

`useAgentJudge` / `judgeAgentKind` **必须带 `.default(...)`**：`run-store` 用 `EvalRunSchema.safeParse` 读盘，任何必填新字段都会让磁盘上已有的 `run.json` 解析失败（`listRuns()` 静默跳过、`getRun()` 抛 INTERNAL）。

**`finalText` 逐家钉死**（`agents/src/turn.ts` 的 `TurnState` 加这一格，初始 `null`；`assembleResult` 的 `base` 原样带出——**canceled / error / completed 三种结论都带**（`timed-out` 今天没有生产者，见 §5.6.6）。`TurnProjection` 不变：它只经 `TurnState` → 结果，**不进事件流**。次级口径：空串 **不写**；每见到一次就覆盖，多轮时最后一次即最终答复）：

| 家 | 采集点 |
|---|---|
| claude-code | 收尾消息的 `result` 字段（`projectResult` 里已在手）；有 `structured_output` 时把它序列化后作为答复 |
| codex | 主会话的模型答复条目（app-server 通知里累积的文本，取最后一次） |
| dsh | `assistant/message` → `data.message.content[]` **按 `type === 'text'` 过滤**后 `join('\n')`——同一数组里的 `reasoning` 块**也带 `text` 字段**，不过滤会把推理混进答复 |

**实现路径 · `evaluator/src/judge-agent.ts`**

1. `getProvider(input.kind).run({...})`：`cwd` = 该行工作区、`configHome` = `.judgehome`、`route` = 评分模型那一对（含窗口两格）、`permission: 'read-only'`、`prompt` = `buildAgentJudgePrompt()`、`signal`、`onEvent`（加前缀后转发）。**没有 `timeoutMs`**（F12）。`outputSchema` 用条件展开传（`undefined` / `null` 时**键不存在**）。
2. **提示词逐段拼、顺序与文本通路对齐**：考题 → 评分标准项（`renderRubricForJudge`）→ **改动怎么看** → **硬性要求** → 输出契约（`JUDGE_OUTPUT_CONTRACT`）。「改动怎么看」要写清：工作区就是当前目录、基线是 `<baselineCommit>`、`git diff <baselineCommit>` 看已跟踪改动、未跟踪的新文件自己按需读、**改动可能很大，不要整段打印，按文件读**。「硬性要求」里显式写只读评审（不改 / 不建 / 不删文件，不跑格式化与安装依赖、不跑测试；只依据工作区里真实看到的代码；最终答复作为最后一条消息的正文）。
3. **先判运行结论、再读答复**：`!result.ok` ⇒ 抛 `JudgeAgentError(result.error?.code ?? 'AGENT_FAILED', result.error?.message ?? '评分智能体执行失败（适配器未给出原因）')`（构造函数是 `(agentCode, message)`，`message` 必填；`ok: false` 却不给 `error` 的违约形状另有兜底文案，不让界面显示空白原因），**绝不先读 `finalText`**（某一家在自己的错误分支之前就采过一段文本，那里躺着的是厂商的错误文本，先读会把「没问到」当成「答错了」）。
4. `raw = result.finalText`：`null` ⇒ `JUDGE_PARSE_FAILED`「该适配器未回传最终消息」；空白串 ⇒ `JUDGE_PARSE_FAILED`「返回了空答复」（两种成因文案必须能分开）。随后 `parseJudgeResponse(raw, rubric)` → `finalizeScore({..., judgeEffort, structuredOutput: result.applied.structuredOutput, judgeTokens: result.tokens, judgeDurationMs: result.durationMs})`（`structuredOutput` 记的是**骨架算出的结论**，不是「我们传没传」；本模块**不做能力判断**、也不读注册表）。
5. 适配器违约抛异常时（契约说 `run()` 不抛）按 `signal.aborted` 分两种形状折成 `AGENT_CANCELED` / `AGENT_FAILED`——归因码必须取自适配器那一侧，上抛会被折成 `INTERNAL`，而候选阶段的同形违约走的是 agent 归因。

**实现路径 · 编排层第 7 步（`runJudgeStage`）**

1. `setRowStatus('judging')`。
2. **兜底守卫**：`rubricMaxScore(ctx.run.rubric) <= 0` ⇒ 抛 `CONFLICT`「这一轮用的评分标准项是空的，无法评分：这一轮的评分表在创建时就已快照，改用例不会影响它——请在用例里补上评分项后新建一轮评测」，**评分器一次都不调用**。
3. 取**同一份配置快照**：`route = resolveJudgeRoute()`、`judgeEffort = resolveJudgeEffort()`（§5.5.2）、`judgeProviderId = config.settings.defaultJudge?.providerId ?? ''`（几次同步读之间没有 `await`）；两条分支各自在**花掉任何一次上游调用之前**用 `requireJudgeEffort` 判一次档位（文本分支按设置里那一格、智能体分支用它自己已校验过的 kind）。
4. `useAgentJudge` 为假 ⇒ 文本通路 `judgeRow`（`rubric` = **本轮快照**、`diffText` = 第 6 步裁剪后的正文、`signal` = 同一把控制器、`judgeEffort`、`onProgress` 把每一轮修复写进行日志）；为真 ⇒ `requireJudgeAgent({ defaultJudgeAgent, route })`（未配置 / 枚举外的值 / 协议不兼容 ⇒ `CONFLICT`，中文原因点名具体 id）→ `ensureRowJudgeHome()` → `judgeRowByAgent`（**总是**带 `outputSchema: JUDGE_OUTPUT_JSON_SCHEMA`）。**降级留痕在拿到分之后**：`score.structuredOutput === false` ⇒ 发那条既有的行日志（`[评分] ${AGENT_LABELS[kind]} 没有把结构化输出落到实处（适配器 SDK 无 schema 入参），本行回落到提示词契约：返回形状由结构检查兜底，不合格会落 JUDGE_PARSE_FAILED`）——判据来自**结果**，包外不再预读 `provider.metadata.capability`（§5.6.4）。
5. **执行骨架 `judgeStageAttempt`** 做四件事（两条通路共用）：① **迟到事件闸门**（本函数落定、或该行已被判定终态之后，适配器收尾期间吐出来的事件不再落盘）；② **用户终止归因**（`signal` 不带原因，只有本层的 `userAborted` 记账能把它翻成 `AGENT_CANCELED`）；③ **污染对照**（只对智能体通路）：评分前后各算一次改动摘要（只看文件数 / 增 / 删三格）比对，不一致就落一条以 `[ERROR] ` 开头的行事件并**在拿到分时把该行判失败**（`JudgeAgentError('AGENT_FAILED', <中文原因>)`）——那一份分建立在一个被评审者改过的现场上，不自动回滚（没有干净基线可退），但也不许当作正常分数收下；**拿不到分时只留痕**（那时的第一归因是「它为什么没跑完」，拿污染顶掉它等于把真因换成一句副作用描述）。对照本身失败（工作区被删 / git 不可用）只记 WARN，绝不顶替评分结论；④ **终止 race**（`JudgeStageContext.terminalReached`）：`Promise.race([attempt, terminalReached])`，终止那一支赢 ⇒ **不改状态**（用户意图优先，这一分不写回行），在途的评分结果回来后先落一条带 `[已终止的尝试]` 标记的行日志、再发一条 `score` 事件（分数不写回行），保住「这次评分确实跑完了」的证据；**宽限为 0**（与候选阶段的 `TERMINATION_GRACE_MS` 5 秒不同：等来的也只是一条日志），且孤儿 promise 必须先挂 `.catch(() => {})`（Node 默认 `--unhandled-rejections=throw`，裸的孤儿能打崩进程）。**唤醒器必须活到整次行任务结束**（清理点收在 `clearRowRuntime`）：挂在候选阶段那个 race 的 `finally` 上，传进评分阶段的会是一条**没人唤醒的死 promise**，race 永远赢不了终止那一支。
6. 失败面折成行终态（`settleAgentJudgeStop`，两条通路共用）：`AGENT_CANCELED` ⇒ `canceled`；`AGENT_TIMED_OUT` ⇒ `timed-out`（今天无生产者，留给将来某家自报与历史数据读侧）；其余 ⇒ `failed` 且 `error.code` **原样保留 agents 的归因码**。

**`run()` 的契约是「返回 `ok:false`，绝不抛」**：抛异常必须归因到**适配器**那一侧（`AGENT_FAILED` / 停止时 `AGENT_CANCELED`），绝不能上抛给编排层——上抛会被折成 `INTERNAL`，而候选阶段的同形违约走的是 agent 归因，两条通路的归因口径必须一致。已中止的 `signal` 也要走一次 `run()`：适配器自己知道「进入即已中止」该怎么收场（骨架会给 `canceled` 且不建任何运行时），在调用方另写一份判断只会造出第二条真相。

**契约与实现路径 · 工作区**

- `core/src/workspace.ts` 新增 `rowJudgeHomeDir(workspaceRoot, runId, rowId)` → `{rowDir}/.judgehome`（`ensureRowJudgeHome` 负责建目录；建目录失败该是一次普通的 `failed`，不混进「评审者本身失败」那条路）。
- `clearRowArtifacts` 补第三条删除（**分开写**，不并入前两条）——三条各走 `removeOrThrow` / `removeTreeWithRetry`，重试是为杀软瞬时占用。

**服务端创建与编辑各再拦一次**（`api/src/runs.ts` 的 `createRun` / `updateRun`，两处共用同一对函数）：`useAgentJudge === true` 时 `resolveJudgeRoute()` + `requireJudgeAgent(...)`；评分阶段再拦一次（配置可能被改过）——共三处。

**界面**

- 设置页 `judge-settings-card.tsx` 在同卡片「思考强度」下方加同形 `Select`（`aria-label="默认评分智能体"`、`allowClear`；`size="small"` 来自外层 `<Form size="small">` 的 context，组件自己没写这个 prop，选项来自 `AGENT_KINDS` + `AGENT_LABELS`）；**协议兼容判据是集合**（`protocolTypes.includes(judgeProtocol)`，与 agents 的 `acceptsProtocol` 同义——`ui` 包按依赖表引不到 `@aieval/agents`；**不是** `metadata.protocolType === …`），协议表与档位域都只从注册表元数据来（由 `useRunModelOptions().options`（`AgentOptionGroup[]`）投影出的 `{ agentKind, protocolTypes, efforts }[]`，`ui` 包里不写这张表；**不需要新端点**）；不兼容项 `disabled` 并写明原因，已存值变成不兼容时给一条点名**该家智能体与两侧协议**的红色 `Alert`（点名 `providerId::modelId` 两个 id 的是同卡片上「默认评分模型已失效」那条，别把两条混作一条）。保存**不被阻止**（拦截发生在创建 / 编辑评测与评分三处）。
- 创建表单加 `Switch`（`initialValues` 里 `false`），开关打开而未配置默认评分智能体时给内联 `Alert` 指出路。
- 行卡片加「重新评分」按钮 + `Popconfirm`（§5.3.2）。

**错误面**：未配置 / 协议不兼容 / 枚举外的值 → `CONFLICT`（点名智能体、供应商、两种协议）；`finalText === null` → `JUDGE_PARSE_FAILED`「该适配器未回传最终消息」；答复不合法 / 缺项 / `achieved` 认不出 → 复用 `parseJudgeResponse` 的中文文案，raw 进日志抽屉；进程起不来 / 鉴权 / 限流 → 透传 `AGENT_FAILED` / `AUTH_FAILED` / `RATE_LIMITED`；污染 ⇒ `AGENT_FAILED` + `stage: 'judge'`。

**守卫**：老 `run.json`（缺 `useAgentJudge` / `judgeAgentKind`）仍能 `safeParse`（**去掉 `.default` 必须变红**）；`finalText` 在成功与失败两档结论下被带出（骨架的 `turn.test.ts` 只钉 `completed` / `error`，**`canceled` 一档未单列**）；dsh 混入 `reasoning` 块时答复只有 `text`（`dsh/events.test.ts` 的「reasoning 块不算答复」）；`canRescoreRow` 真值表（四种可重评的终态被逐条钉住——`judged` / `failed` / `timed-out` / `canceled`，`interrupted` 未单列、由 `canRetryRow` / `canRunRow` 的循环覆盖；三种在途一律不可、无基线 / 无 diff 不可）；两条通路各自共用 `finalizeScore` 收口（**没有**「同一份回复喂两条通路再比对」的用例，见 §4.3 的如实登记）；`ok:false` 时**不去读答复**（顺序契约）；污染对照：改了工作区且拿到分 ⇒ `failed`（`orchestrator-judge-route-b.test.ts`）；**反面（没拿到分 ⇒ 只留痕）暂无用例**；评分阶段按「终止」能真的切断调用。

#### 5.5.2 评分的思考强度

**口径**

- 评分强度**可配**，唯一来源是 `settings.defaultJudge.effort`；缺省 = **未指定**（不是某一档，也不是关闭）。
- 「尺子跨轮次可比」由**记账**保证：这一分用的档位随分数落盘（`ScoreResult.judgeEffort`），不同强度打的分数在数据上分得开。
- **未指定时两条通路的行为不同、不承诺落到同一档**：文本侧一个强度键都不发（听网关缺省），智能体侧走该家适配器自己的缺省（dsh 落 `high`，claude / codex 由厂商推断）。故 `null` 只说「我们没要求」，不说「它跑在哪个档」；这个状态由各通路自己处置，不用一个共享常量冒充。
- 档位域 = `intersectEfforts(模型声明, 评分智能体域, CANONICAL_EFFORT_LEVELS)`（§5.1.1 的同一个函数）：没配评分智能体、或配了枚举之外的值时，`agentEfforts` 取规范五档；兜底那一份同样要过这道筛（dsh 收不了 `medium`）。
- 档位照上游词汇原样存与展示：关闭档就是 `off`，它**不是**「未指定」的同义词。

**契约**

```ts
// packages/server/contracts/src/settings.ts
DefaultJudgeSchema = z.object({
  providerId, modelId,
  effort: z.string().min(1).optional(),           // 缺省 = 未指定；可选域见上一条口径
});

// packages/server/contracts/src/score.ts
judgeEffort: z.string().nullable().default(null),  // 这一分用的档位；null ⇔ 我们没指定（老记录读回是 null）

// packages/server/evaluator/src/judge.ts 的 JudgeInput 与 packages/server/evaluator/src/judge-agent.ts
// 的 AgentJudgeInput 各加一格：
judgeEffort?: string;                              // 纯入参：这两个模块都不读配置、不碰落盘
// finalizeScore 的必填入参加一格 judgeEffort: string | null（两个调用点各表一次态，同 structuredOutput）
```

**落点**

- **智能体侧**：`packages/server/evaluator/src/judge-agent.ts` 把 `judgeEffort` 照 `AgentRunInput.effort` 交给 `getProvider(kind).run`（缺省即不写键）。三家适配器一字不改——它们早已各自翻译：claude `Options.effort` / `off` ⇒ `thinking: { type: 'disabled' }`；codex `turn/start` 的 `effort` / `off` ⇒ `none`，**同时**在该线程 `thread/start` 的 `config` 里给 `model_reasoning_summary: 'none'`（第二格不在 `turn/start` 上，见 §5.1.1）；dsh 的 overlay 里那张 `reasoningEfforts` 档位表 `off: null`（**SDK 选项 `reasoningEffort` 收到的仍是 `'off'`**，由 pi-ai 按该表不写下发字段）。
- **文本侧**：`packages/server/evaluator/src/text-api.ts` 的 `reasoningFields(protocolType, effort)`，加在**唯一构造点** `buildBody` 上（单轮与多轮两个入口共用同一个构造点）：

| 档位 | `openai` 协议（`/chat/completions`） | `anthropic` 协议（`/v1/messages`） |
|---|---|---|
| 未指定 | 一个键都不加 | 一个键都不加 |
| `off` | `thinking: { type: 'disabled' }` | `thinking: { type: 'disabled' }` |
| 其它档 | `reasoning_effort: '<档>'` | `output_config: { effort: '<档>' }` |

**实现路径**

- 读点只有 `resolveJudgeEffort()`（`packages/server/evaluator/src/judge-route.ts`，**无参**，读 `settings.defaultJudge?.effort`）。它**不是** `TextRoute` 的一格：那是**连接事实**，强度是**请求参数**（与 `AgentRunInput.effort` 同一条口径）。
- 校验 `requireJudgeEffort({ effort, model, agentKind })` 同文件、与 `requireJudgeAgent` 并列：`undefined` = 未指定 ⇒ 放行；不在档位域里 ⇒ `CONFLICT` + 指向「设置 → 评分配置」（空串渲染成「（空串）」，否则界面上是一片空白）。它拦的是**手改 `config.json`** 与「换掉评分模型 / 智能体之后留下的悬空档位」——`loadConfig()` 刻意不做校验，不拦就要跑到 dsh 硬报错的 `UNSUPPORTED_REASONING_EFFORT` 才失败。
- 两个服务端调用点各自与尺子同源（同一份 config 快照，几次读之间没有 `await`）：`orchestrator.runJudgeStage`（`packages/server/evaluator/src/orchestrator.ts`，随 `judgeEffort` 入参传给两条分支）与 `generateRubric`（`packages/server/api/src/judge.ts`，智能生成与智能识别两次文本调用都带上）；设置页那一格的候选域是同一个算法的另一处消费（§6.2）。
- `judgeRow`（文本通路）与 `judgeRowByAgent`（智能体通路）不读配置，由调用方传值；**重新评分**（`rescoreRow`）走同一个 `runJudgeStage` ⇒ 它重跑的那一分同样按当前配置的强度打。

**守卫**

- `packages/server/evaluator/src/text-api.test.ts`：三档 × 两协议 × 未指定，请求体里**有且只有**该有的键（六条走**单轮**入口 `callTextApi`）；**多轮**入口同样带强度（第七条走 `callTextApiConversation`，两者共用同一个 `buildBody`）。
- `packages/server/evaluator/src/judge-route.test.ts`：`resolveJudgeEffort()` 与 `defaultJudge` 同源、未配置得 `undefined`；`requireJudgeEffort` 四条边界（越域 / 空串 / 枚举外的 `agentKind` 按「未配」取规范五档 / `undefined` 放行）。
- `packages/server/evaluator/src/orchestrator-judge-route.test.ts` 与 `packages/server/evaluator/src/judge-agent.test.ts`：**智能体侧**强度透到 `run` 的 `effort`（文本侧断言的是评分器入参 `judgeEffort`，它不经 `run`）；**智能体那两条**另外钉落盘的 `judgeEffort` 与配置一致。
- `packages/client/ui/src/composite/judge-settings-card.test.tsx`：候选域 = 模型声明 ∩ 评分智能体域（dsh 那一家剔除 `medium`）、清空回写、悬空提示且不回显失效值。
- 变异：文本支 `off` 分支不写 `thinking.disabled` ⇒ 请求体断言必须红。

**边界（如实登记）**

- `off` **确证**关掉思考（DeepSeek + `deepseek-flash`：两协议都 0 字符思考内容，对照 8 格非 `off` 读数全部有思考内容）。
- 档位**强度**的效力**未证实**：同一档自己的抖动不小于档间差 ⇒ 只能拿多步推理题测，且差额要超过同档抖动并写明 n/组与统计量（原始读数见 `packages/server/agents/probe/v8/REPORT.md`）。
- **非 DeepSeek 网关未验证**：可能忽略这两个键，也可能直接 400；`medium` 可能被网关折成 `high`，文案与记账一律按「我们**要求**的档位」。
- `packages/server/evaluator/src/text-api.ts` 的 `MAX_TOKENS = 4096` 用作 anthropic 分支的 `max_tokens`（openai 分支不传），难题上会截断高档位的思考（实测 `max_tokens=2048` 时两次都 `stop=max_tokens`）⇒ 会出现「配了高强度、效果被上限吃掉」，处置另开任务。

### 5.6 智能体适配器

本节是 `agents` 包的唯一设计口径：对外契约、注册表、三家适配器的注入与计量口径、生命周期与释放顺序、加载降级、错误码映射。

适配器要解决的问题只有一个：**让编排层面对「一个智能体」，而不是面对三家互不相同的 SDK**。三家厂商 SDK 都自带 agent 循环与工具执行，真正需要我们做的不是「再实现一遍 agent」，而是三件事——把评测需要的输入送进去、把它产生的计量与日志取出来、在超时与终止时干净地收尾。三件之外的一切差异都应该被适配器吸收掉。

`packages/server/agents` 内部分三层，依赖方向单向：

```
getProvider(kind).run()（编排层的唯一入口，按 kind 解析）
  ↓  src/registry.ts          kind → AgentProvider，元数据的唯一来源
  ↓  src/providers/<kind>/    每家一个目录：run() + 事件投影 + 注入参数
  ↓  厂商 SDK
```

差异全部落在 `providers/<kind>/` 里：编排层与注册表都不出现任何厂商字段名。

#### 5.6.1 关键决策与理由

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| A1 | 适配器 = **provider 注册表 + 薄投影**，不做语义转换层 | 三家 SDK 在解析层已各说各话，抹平语义要写一个中间表示（IR）与 3×2 个转换器；而评测只消费「产物 + 计量 + 日志」，适配器只需把差异投影到统一事件流 | 为三家写统一 IR（成本高、失真，且第 6 步的 diff 本就直接读工作目录） |
| A2 | 结果契约必须补上 SDK 不保证提供的计量：`cached` token / `turns` / `durationMs` / `exitReason` / 归一化事件 | 这四样是横向对比的判据（§7.2 的 `EvalRow.tokens` / `turns` / `durationMs`），但厂商 SDK 的结果帧不保证都有：费用字段常常恒为 0，用量可能只出现在某个不便读取的位置，甚至完全取不到。「跑完了」不等于「能对比」 | 直接把厂商结果帧透给编排层（编排层要按厂商分支解析，正是本层要消除的耦合；且缺字段时会静默退化成「没有数据」） |
| A3 | `AgentProvider` 注册表：**显式静态注册**，不做目录扫描 | 打包后 `readdirSync` 不可靠；注册表同时承载「协议兼容性 / 行级能力 / 消息能力 / 档位域」元数据，是前端候选池过滤与编排层判断的**唯一**查询点 | `switch (agentKind)` 散在编排层与表单里（加一家要改多处，兼容性规则会漂移） |
| A4 | **一行一次运行一次释放**，不做可多轮的 live 会话编排 | 评测的每次执行就是「一个工作区 + 一条提示词 + 跑完即弃」；多轮会话是交互式产品的需求，本项目没有消费方，而 live 会话会额外引入「会话忙」「跨轮恢复」「中断后会话能否续用」三类状态，把超时与释放的复杂度抬一个量级 | 维持长驻会话对象（多轮状态与并发保护都要自己实现，收益为零） |
| A5 | 路由注入一律走**显式选项 + 「替换型」子进程环境**，`route` 是只读输入 | 并行时多行同时驱动不同供应商；一旦靠「读 `process.env` 再兜底写回」来注入，第二行起就再也拿不到自己的凭据——写入是粘性的（`X = X \|\| 新值` 这类写法尤其），而「替换型」环境（厂商 SDK 用它整体替换子进程环境）如果不展开宿主环境补 `PATH`，子进程连 `node` 都找不到 | 写 `process.env` 让厂商 SDK 自己读（凭据串台） |
| A6 | 厂商包**函数作用域懒加载**，只缓存成功的加载 | 顶层静态导入一旦失败，整个 `agents` 包的导入都会失败——一个智能体 SDK 的故障会变成「全部智能体不可用」；不缓存失败是为了让一次镜像抖动不要毒化长驻服务的后续所有行 | 顶层静态 `import`（故障面从「一家」放大到「全包」） |
| A7 | `dispose()` 是**必需项**，且与 `interrupt()` 共用**按对象绑定**的关闭守卫 | 进程内执行的释放没有「子进程被杀掉」这个兜底；守卫若做成运行时级一次性闭锁，`中断 → 下一轮新建客户端 → 释放` 会漏关新客户端，留下孤儿进程 | 只实现 `interrupt()`（dsh 会留下孤儿子进程） |
| A8 | 事件流是**评测自己的形状**（`AgentEvent` 判别联合，§7.4 已定义），不复用厂商 SDK 的消息形状 | 事件要落 `events.jsonl` 并扇出 SSE，形状必须由本项目定义且以 §7.4 为单一来源；照搬厂商形状会让日志格式随厂商版本漂移，还会把「本项目根本不会消费的内容类型」当作兼容包袱一起带进来 | 直接落厂商原始消息（日志格式随 SDK 版本漂移） |

#### 5.6.2 契约（`agents` 包对外全部出口）

依赖方向不变：`agents → core / contracts`，**不依赖 `evaluator`**。`agents` 不知道工作区、分支、评测行的存在——它只接一个已经准备好的工作目录。

```ts
/** 三家智能体的 id；唯一**真源**在 `@aieval/contracts`（`EvalRow.agentKind` 与前端下拉都由它派生），
 *  agents 侧只做再导出（contracts 不能反向依赖 agents） */
export const AGENT_KINDS = ['claude-code', 'codex', 'dsh'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

/** 与 §7.2 的 ProtocolType 同义；此处重复声明是为了避免 agents 为两个字符串引入依赖 */
export type ProtocolType = 'openai' | 'anthropic'

/** 一次运行的全部输入。内部无厂商分支，**不写** `process.env`（宿主环境只读展开，用于补 `PATH` / `HOME`） */
export interface AgentRunInput {
  cwd: string                        // 该行工作区（第 1、2 步已备好）；适配器不做任何 git 操作
  configHome: string                 // 该行独立配置目录（第 3 步已备好）：HOME / USERPROFILE / 厂商配置目录
  permission: AgentPermission        // 'full'（候选执行阶段）| 'read-only'（评分阶段）。**必填**
  prompt: string                     // 考题提示词
  route: {
    protocolType: ProtocolType
    baseUrl: string
    apiKey: string
    modelId: string
    contextWindow?: number           // 中性事实，见 §5.1.1；缺省 = 未知
    maxOutputTokens?: number
  }
  signal: AbortSignal                // 终止用；适配器必须尊重，**不得**用它推断 exitReason
  outputSchema?: Record<string, unknown>  // 「我想要这份 schema」（见 §5.6.4）；不支持的适配器**降级**
  effort?: string                    // 思考强度；**不进 route**（它是请求参数，与 permission 同级）
  onEvent: (e: AgentEvent) => void   // 同步回调，不 await：事件流不能被消费者拖慢
  onMessage?: (m: AgentMessage) => void    // 内容级视图（消息流），与 onEvent 并行的一条流
  onSubagent?: (r: SubagentRecord) => void // 子任务行：一行一子任务，同一身份会多次投递（后者是完整快照）
}

/** 与 §5.4 的行状态同名，便于 1:1 映射；'timed-out' 而非 'timeout' */
export type AgentExitReason = 'completed' | 'timed-out' | 'canceled' | 'error'

export interface AgentRunResult {
  ok: boolean
  exitReason: AgentExitReason
  /** null = 该次运行未采到计量；绝不填 0。**是全树合计**（主会话 + 数到的每个子智能体，§7.5） */
  tokens: { input: number; cached: number; output: number } | null
  subagentTokens: { input: number; cached: number; output: number } | null   // 子智能体那一份（必填）
  subagentTurns: number | null                                              // 子智能体那一份轮次（必填）
  turns: number | null               // 全树合计；null = 一次都没观察到，绝不填 0
  durationMs: number
  error?: { code: AgentErrorCode; message: string; stack?: string }
  /** 最终答复文本；null = 未采到（与空串是两件事）。评分智能体从这里取答复，不从事件流重建 */
  finalText: string | null
  /** 这一次**实际按能力处置成了什么**（必填）：调用方据此记账（`ScoreResult.structuredOutput` 的来源由编排层决定） */
  applied: { structuredOutput: boolean }
}

/** AgentEvent 的类型定义见 §7.4；AgentMessage / SubagentRecord 见 docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md（§8 的第二条并行流），此处不重复 */
```

**`AgentRunInput` 里没有 `timeoutMs`**（F12：执行与评分都不限时间）：一次运行只会因为「跑完 / 失败 / 外部要求停止」结束，适配器自己不设内层上限；唯一能停下它的是 `signal` 与上游自己收场。

**一次运行的接口是函数而非类实例**：编排层只按 `agentKind` 解析并调用，不持有运行时对象。

```ts
export interface AgentProvider {
  readonly kind: AgentKind
  readonly displayName: string
  readonly metadata: AgentProviderMetadata
  run(input: AgentRunInput): Promise<AgentRunResult>
}

export interface AgentProviderMetadata {
  /**
   * 该智能体**能接受**的协议集合（非空、去重）；表单的候选池过滤、创建 / 编辑校验、
   * 评分智能体校验与编排层复检**四处都读它**，判据是 `acceptsProtocol(metadata, protocolType)`
   * ——不许各写一份 `includes`。claude-code / codex 是单元素数组，dsh 同时讲两条 wire。
   */
  protocolTypes: readonly ProtocolType[]
  capability: {
    /** false ⇒ 「终止」按钮在该行上退化为「关闭运行时」，界面文案必须不同 */
    cancelMidTurn: boolean
    /** false ⇒ 该适配器采不到 token，界面显示「不支持计量」而不是 0 */
    usage: boolean
    /**
     * 该适配器能不能把 `AgentRunInput.outputSchema` 落到实处（**必填**：可选会被默认成 false 而无人验证）。
     * 消费方只有一处：适配器把它**转发**进 `TurnHooks.capability`，由骨架 `runTurn` 在 `start` 之前统一处置
     * （不支持 ⇒ 摘掉 `outputSchema` 并记 `applied.structuredOutput = false`）。**编排层不读它**——
     * 包外不再预读注册表判能力，降级说明改由「拿到分之后看 `applied`」产出（§5.6.4）。
     */
    structuredOutput: boolean
  }
  /**
   * 这一家在**消息层**能拿到什么（思考正文 / 工具入参 / 工具结果 / 子任务 / 流式增量），
   * 逐格给出取值、取数通道与缺失原因。与上面的 `capability` 分开：那一组说的是**行级**能力，
   * 这一组说的是**内容级**能力，问题、消费方与变化原因都不同。
   */
  messageCapability: MessageCapability
  /** 该家能表达的思考强度档位（**完整值域**，见 §5.1.1）。**必填**，由 `registry.test.ts` 守卫 */
  reasoningEfforts: readonly string[]
  /** 未选档位时该家**实际会用的档**（只有 dsh 声明 `'high'`） */
  defaultEffort?: string
}

/** 一次运行要哪种权限档（用户口径）。**按阶段给，不按厂商给**，且**必填** */
export type AgentPermission = 'full' | 'read-only'

export function getProvider(kind: AgentKind): AgentProvider
export function listAgentProviders(): AgentProvider[]

/** 协议兼容的**判据**与**文案**也在这个白名单里（api 与 evaluator 的**四个消费点**必须同源，不许各写一份 includes） */
export function acceptsProtocol(metadata: AgentProviderMetadata, protocolType: ProtocolType): boolean
export function protocolMismatchMessage(input: ProtocolMismatchInput): string
export interface ProtocolMismatchInput { agentLabel: string; accepted: readonly ProtocolType[]; subject: string; actual: ProtocolType }
export type AgentErrorCode = 'AGENT_LOAD_FAILED' | 'AGENT_FAILED' | 'AGENT_TIMED_OUT' | 'AGENT_CANCELED' | 'AUTH_FAILED' | 'RATE_LIMITED'
```

**能力面只有 `capability` 与 `messageCapability` 两组，且每一格都有生产消费方**：跑动期用量能不能回写快照**不再**由注册表的某格决定——它由 `usage` 事件自带的 `tokensBasis` 表达（§7.4），于是编排层不必在跑之前反查注册表。「这一家的工具循环跑在哪里」也不进元数据：它是实现细节，没有消费方。

| kind | protocolTypes | cancelMidTurn | usage | structuredOutput | reasoningEfforts | defaultEffort |
|---|---|---|---|---|---|---|
| `claude-code` | `['anthropic']` | `true` | `true` | `true` | `['off','low','medium','high','xhigh','max']` | —— |
| `codex` | `['openai']` | `true` | `true` | `true` | `['off','minimal','low','medium','high','xhigh','max','ultra','persistent']` | —— |
| `dsh` | `['openai','anthropic']` | **`false`** | `true` | **`false`**（SDK 没有这一格） | `['off','low','high','max']` | `'high'` |

**这条表就是 §5.1「模型候选池按协议类型过滤」的数据来源**：`listAgentModelOptions()` 按 `AGENT_KINDS` 逐个取 `getProvider(kind).metadata.protocolTypes`（表单不硬编码三家与协议的对应关系）。F2 的过滤规则因此变成「注册表元数据的投影」，而不是表单里的一份独立规则。

**权限档的三家落点**（真源是 `packages/server/agents/src/permission.ts`——三份表放一起才能逐格对照，也才能让「三家都实现了同一份档位表」变成一条可执行的守卫）：

| permission | claude-code | codex | dsh |
|---|---|---|---|
| `'full'`（候选执行） | `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | `sandboxMode: 'danger-full-access'` + `approvalPolicy: 'never'` | `DSH_PERMISSION_MODE=danger-full-access` |
| `'read-only'`（评分） | `permissionMode: 'dontAsk'` + `permissionPrompts: 'none'` | `sandboxMode: 'read-only'` + `approvalPolicy: 'never'`（**Windows 上落 `danger-full-access`**，见 `codexPermissionOptions`） | `DSH_PERMISSION_MODE=read-only` |

两家有**必须成对**的选项，少一个就静默失效：claude 的 `bypassPermissions` 需要 `allowDangerouslySkipPermissions: true`（少了后者，CLI 侧仍旧逐个工具要批准，而无人值守的评测里没有人能点这个批准）；dsh 的三档预设里只有 `danger-full-access` 把 approval 一起设成 `never`（`read-only` 档的 approval 仍是 `ask`——评审者越界时**不会**被自动放行，它会停在无人应答的批准上，直到用户点「终止」；这是「只读」在无交互环境下的正确收场，不是缺陷）。

**厂商 SDK 的类型不从厂商包 `import type`**：适配器自己在文件内声明它消费的**窄结构**（只声明用到的方法与字段），厂商包只作为运行时依赖。理由是让 `agents` 的编译不依赖厂商的类型面——厂商发一个破坏性类型变更不应该让本仓库 `typecheck` 失败，只应该在运行时被 §5.6.7 的加载降级与错误码映射兜住。

**依赖归属**：三家的包（`@anthropic-ai/claude-agent-sdk` / `@openai/codex` / `@deepseek-ai/dsh-sdk-client`）装进 `packages/server/agents` 的 `dependencies`——`agents` 是**唯一**允许引厂商 SDK 的包。codex 那一份只用来取平台二进制（协议由本仓的 `providers/codex/appserver/*` 直接讲 JSON-RPC，不经过 SDK 的会话封装）。`pnpm-workspace.yaml` 的 `allowBuilds` 可能需要补条目（装包时以 pnpm 的构建脚本提示为准，不要预先猜）。

#### 5.6.3 事件归一化与计量

**唯一允许丢弃的事件是重复事件**（同一 `uuid` 的重复消息；连续两次读数的**三元组 + 轮次 + 时长 + 归属 + 两格子智能体分量 + 来源**逐字段相同——**`reasoningOutput` / `total` 目前未纳入比较**，见本节末尾的缺口登记；**不包括**「内容逐字相同就不重发」那种判据，它在 2026-10-07 被真机改判为缺陷删掉了）。**任何未识别的事件必须投影为一条保留原始负载的日志事件**（如 `{ type:'log', stream:'stdout', text: <原始 JSON> }`），不得静默丢弃。理由是排障与「为什么得这个分」的可追溯性：codex 的命令执行、文件改动、MCP 调用都是候选行为的一部分，丢掉它们等于丢掉证据。

**用量的原生来源必须逐家钉死**（唯一入口是 `getProvider(kind).run()`，包外不许自己 spawn 厂商 CLI）：

| kind | 用量来源 | 轮次来源 |
|---|---|---|
| `claude-code` | `result` 消息的 `usage`（输入 / 缓存读 / 输出） | 主循环 `assistant.message.id` **去重计数**（一次 API 往返算一次，跑动期就在涨）；`result` 的 `num_turns` 只在一次都没数到时**兜底**，两者不一致落一条 WARN |
| `codex` | app-server 的 `thread/tokenUsage/updated` 通知（按线程累计） | 「模型答复条目数」——**不数 `turn/completed`**（那是整段任务一条，数出来永远是 1） |
| `dsh` | 通知流的 usage 字段（已真机探测钉死） | `step/start` 的往返计数（与 `turns += 1` 同一处） |

**采集不到计量时填 `null`，绝不填 0**：0 token 与「没采到」在横向对比里含义完全不同，前者会让人得出「这家很省」的错误结论。UI 必须能区分（`null` → 「不支持计量」/「未采集」）。

**工具调用与推理内容要落盘但不必解析**：它们对评分无用（文本通路的评分输入是 diff），但对排障有用。适配器把它们归一化成日志或工具事件即可，不需要建模工具语义。活动行（卡片底部那一句话）是这些日志上的一层**词表**，见 §5.6.9。

**已知缺口（如实登记）**：去重判据 `sameUsage` 逐字段比七项（`turns` / `timing` / `turn` / `subagentTokens` / `subagentTurns` / `tokensBasis` / 三元组），其中**三元组那一格**委托给 `sameTrio`，它收的是 `AgentRunResult['tokens']` ⇒ **结构上取不到 `reasoningOutput` / `total`**（`turn.ts` 的 `sameTrio` 自己写着「spec §2.4 要求『去重比较必须纳入这一格』，当前未落地」）⇒ 只有思考 token 变了的那条 `usage` 会被判成重复而丢掉。要闭合得把**那一格**的比较对象改成事件里的五格 `UsageTokens`（落点在 `sameTrio` 的入参类型，不是在 `sameUsage` 里加字段）。

#### 5.6.4 结构化评分输出（零三方依赖）

**口径**

- schema 以**手写字面量**放在 `contracts/src/score.ts`（`JUDGE_OUTPUT_JSON_SCHEMA`），与 `JUDGE_OUTPUT_CONTRACT` 文本**同形**且**必须同批修改**；不引 `zod-to-json-schema`，不写通用转换器（那是第二份真源）。
- 契约里存**中性事实** `outputSchema?: Record<string, unknown>`，`outputFormat`（claude）/ `turn/start` 里的 `outputSchema` 一等字段（codex，本仓直接讲 JSON-RPC）/「没有这一格」（dsh）三种方言全部留在各家适配器。
- 能力声明写进**注册表元数据**且**必填**：`AgentProviderMetadata.capability.structuredOutput: boolean`。
- 调用方**总是传** `outputSchema`（它表达的是「我想要」，不是「我决定给你」）；**降级口径只该有一处**：`runTurn` 按能力把这一格从交给 `start` 的输入里摘掉、不支持的家不报错，并把结论记进结果（`applied.structuredOutput = false`）。**有痕降级由编排层在拿到分之后补**：`score.structuredOutput === false` ⇒ 发一条行日志说明本行回落到提示词契约。
- schema 的严格度**只到可移植子集**：`type` / `properties` / `required` / `additionalProperties` / `enum` / `integer` + `minimum`/`maximum`；**不用** `oneOf` / `const` / `prefixItems` / `uniqueItems` / `minItems` / `maxItems`（项数由每张评分表决定，schema 表达不了）。
- 解析判据**一个字不改**：schema 只让「不合格」更少见，不改变「不合格时怎么办」；**请求侧阻止优先于解析侧夹紧**（`achieved` 用 `{ type: 'boolean' }` 严档，而解析侧对它宽容读——这处差异是有意登记的）。
- 结果的出口仍是 `AgentRunResult.finalText`（claude 在 `structured_output` 存在时把它序列化后作为 `finalText`），不加第二个出口。

**三家落点**

| kind | `capability.structuredOutput` | 落点 | 结果出口 |
|---|---|---|---|
| `claude-code` | `true` | `query({ options: { outputFormat: { type: 'json_schema', schema } } })` | 收尾消息的 `structured_output`（序列化后进 `finalText`） |
| `codex` | `true` | app-server 的 `turn/start` 里一个**一等字段** `outputSchema`（本仓直接讲 JSON-RPC，**不落成命令行参数**） | 仍是主会话答复的文本 |
| `dsh` | `false` | 无（SDK 客户端没有这一格） | 不变 |

三条硬约束：`input.outputSchema === undefined` 时**一个字段都不加**（保证「没传 schema 的行」行为逐字不变）；不支持这一格的适配器**由骨架摘掉这一格后照常跑完**（`applied.structuredOutput = false`）——**降级口径只有这一处**，适配器不再自己判、也不报错（代价：绕过 `run` 直接构造 `AgentRunInput` 的旁路不会被拦，知情接受）；claude 的 `structured_output` 与 `result` **同时存在且内容不同**时落一条 WARN，并以 `structured_output` 为准。claude 的 `error_max_structured_output_retries` 要在 **`providers/claude-code/events.ts` 的 `projectResult`** 里折成可直接展示的中文（归因码仍是 `AGENT_FAILED`）——**不放进三家中性归因层**：那是 claude 一家的 subtype。

**编排层**

```ts
const kind = requireJudgeAgent({ defaultJudgeAgent: config.settings.defaultJudgeAgent, route });
const score = await judgeRowByAgent({ …, outputSchema: JUDGE_OUTPUT_JSON_SCHEMA });   // 总是表达「我想要」
// 留痕在**拿到分之后**：判据来自这一次运行的结果（骨架按能力摘掉 schema 时记 applied.structuredOutput = false），
// 跑之前无从得知。降级是允许的，静默降级不是——同一批用例里 schema 生效与否必须能从行日志里读出来。
if (score.structuredOutput === false) {
  publishRowEvent(ctx.runId, ctx.rowId, { type: 'log', stream: 'stderr',
    text: `[评分] ${AGENT_LABELS[kind]} 没有把结构化输出落到实处（适配器 SDK 无 schema 入参），`
      + '本行回落到提示词契约：返回形状由结构检查兜底，不合格会落 JUDGE_PARSE_FAILED' });
}
```

`finalizeScore` 的入参有**必填** `structuredOutput: boolean`（让两个调用点各自表一次态，不吃默认值）：智能体通路记 `result.applied.structuredOutput`（**骨架算出的结论**，不是我方传没传），文本通路传 `false`（它有自己的回问机制）。界面：评分详情底部的记账行写「输出约束：schema 约束 / 提示词约束」，`false` 时**不显示任何告警样式**（它是事实，不是错误）。

**守卫**：schema 的字段名与契约文本**逐项对齐**（`judgments` / `id` / `achieved` / `reason` / `verdict`），两份里都不出现 `totalScore`；`minItems` / `maxItems` **不存在**（项数由每张评分表决定，schema 表达不了）；「不传 schema ⇒ 键不存在」（不是 `undefined`）；dsh 拿到 schema ⇒ **降级跑完且 `applied.structuredOutput === false`**；三家都显式声明能力位；能力为假时事件日志里有一条降级说明且 `ScoreResult.structuredOutput === false`；claude 的收场 subtype 折成中文而不把英文代号透给用户。**两条静态守卫**：`packages/server/evaluator/src/orchestrator.ts` 里 `metadata.capability` 出现 **0 次**（能力判定只发生在 `runTurn`，包外不再预读注册表；同一条守卫同时断言 `acceptsProtocol` 的协议复检仍在）；声明 `structuredOutput: true` 的家**必须真把 schema 发出去**（真实落点是三家 `providers/<kind>/index.test.ts` 各一条 + 骨架 `agents/src/turn.test.ts`；判据本体在 `providers/conformance/structured-output.ts`，但三家夹具都没挂探针 ⇒ conformance 那一格**空转**，如实登记）。

**已知风险**：schema 落到 wire 上就是请求体里的一格，**网关不认时不报错**（只是模型照旧自由生成）——可观测手段只有 `ScoreResult.structuredOutput` 与 `score.raw`（schema 生效时 `raw` 必然是能解析的 JSON）。对照实验：同一用例、同一模型，schema 开 / 关各跑一次。

#### 5.6.5 路由注入（第 3 步的口径）

| kind | 注入点 | base URL 规范化 | 必须同时设置的项 |
|---|---|---|---|
| `claude-code` | 子进程环境 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CONFIG_DIR`（= 本行 `configHome`）/ `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`（任务跟踪三家同口径）+ 模型选项 | **拆掉尾部 `/v1`**（该 SDK 自己追加 `/v1/messages`，留着会变成 `/v1/v1/messages`） | 展开宿主环境补 `PATH` / `HOME`；`settingSources: ['user','project','local']`（`[]` 会把被测仓库的 `CLAUDE.md` 一起挡在门外）+ `settings.env` 把**前三个路由键**钉在 flag 档（2026-09-29 口径，见下）；`disallowedTools` 禁掉与评测无关的旁路工具 |
| `codex` | **`codex app-server`**（JSON-RPC / stdio）驱动；路由 = 线程级 `config` 里一份**完整的** `model_providers` 条目 + 子进程环境里的 `OPENAI_API_KEY` | **补上 `/v1`**（CLI 只走 Responses wire，即 `POST {base}/v1/responses`） | `model_provider`（= 条目键名 `aieval`，**与 `model_providers` 是一对，少哪个都不行**——只建条目不指定它，CLI 会退回内置的 `api.openai.com`，表现是 `Reconnecting... waiting for network`，极难归因）；`wire_api: 'responses'`；**`env_key: 'OPENAI_API_KEY'`**（凭据从哪个环境变量取；**不要改回 `requires_openai_auth: true`**——那走 ChatGPT 登录态，实测即使 key 就在环境里也 `header_attached=false` ⇒ 全部 401）；`request_max_retries: 1`；`tools: { web_search: false, update_plan: { enabled: true } }`（前者：网关对命名空间工具回 400；后者：三家「有没有规划」的口径必须一致）；`features.multi_agent: true`（子智能体工具要注册，否则 §7.5 的分量永远为空）；`model_context_window` 与关闭档的第二格 `model_reasoning_summary` **只在已知时出现**；临时 `HOME` 指向该行 `configHome` |
| `dsh` | **per-run overlay**（`--patch <绝对路径>` 的 `llm-pi-ai` 行：路由键 / `api` / `baseURL` / `apiKeyEnv` / 模型 / 档位）+ 子进程环境里的**自定义**凭据变量 `AIEVAL_ROUTE_API_KEY` + `DSH_PERMISSION_MODE` | **按 wire 分叉**：`anthropic` → **拆掉尾部 `/v1`**（pi-ai 原样追加 `/v1/messages?beta=true`）、`openai` → **补上 `/v1`**（pi-ai 原样追加 `/responses`，不插 `/v1`）。pi-ai **不做任何归一化**，这层保护必须由适配器给 | 用 `configHome` 作为该行的 `HOME` / `DSH_HOME`（隔离会话与配置）；`provider` 必须逐字等于 overlay 里的路由键；`patches` 必须是**绝对路径**；`initializeTimeoutMs` 显式放宽（SDK 默认 10s，冷启动不够） |

**dsh 的路由落点（两条协议统一走 `llm-pi-ai`，真机探测报告 `docs/superpowers/notes/2026-09-30-dsh-pi-ai-route-probe.md`）**：

- `anthropic → anthropic-messages`、`openai → openai-responses`（**不**映射 chat-completions）；
- 两条环境变量通路都不再用：子进程环境里的 `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` 是**显式删除**（`injected: { DEEPSEEK_*: undefined }`），不只是「不注入」——`buildSubprocessEnv` 以宿主环境为底展开，不显式删就会把开发机上的密钥继承给子进程（静默跑到公网并计费）；配置面只走 overlay，`settings.yaml` 与 `profiles/sdk/cordis.patch.yml` 都不写（**后者**——`profiles/sdk/cordis.patch.yml`——是 dsh 自己的持久化层，两边各写各的才不会互相覆盖；**前者** `settings.yaml` 是 dsh 的旧版本迁移 shim，已退役）；
- `ask_user_question` 的 `insert` 在同一份 overlay 里给。

**三条硬性不变量**：

1. 注入后返回**新对象**，输入的 `route` 只读，`process.env` 永不写入。
2. `agents` 包的**非测试源码**（`packages/server/agents/src/**`，排除 `*.test.ts`）里不得出现任何 `process.env` 写入写法（静态断言：`agents/src/static-assertions.test.ts` 的「源码里不出现任何写入宿主环境的写法」）；**测试文件一律放行**——扫描面是按扩展名排掉 `*.test.ts` 的（不区分哪个包），本包的 `providers/dsh/index.test.ts` 与其它包的 `core/src/logger.test.ts` 都在临时改环境变量）。
3. 每行的 `configHome` 必须是**独立目录**：行与行之间通过环境变量共享配置目录，会互相注入 MCP / 插件定义（codex 侧尤其明显），直接破坏「同一起点」这个前提。

**Codex 的 401 与「环境 `~/.codex` 反杀」**：显式 `model_providers` 条目不是可选优化，而是必需——环境里已有的 `~/.codex` 配置（`model_provider` / 插件 / MCP）会赢过我们注入的 base URL，表现是「明明配了网关却打到了别处」。上面「指向该行 `configHome`」一行就是它的解药。

**Claude 的 settings 分档（2026-09-29 实测，判据是「哪台本机服务器收到请求」+ 请求体）**：

| 层级（低→高） | 是什么 | 本次路由的注入点 | 谁赢 |
|---|---|---|---|
| `user` | `CLAUDE_CONFIG_DIR/settings.json`（隔离下 = 本行 `.agenthome`，**不是**宿主 `~/.claude`） | 子进程环境变量 | 环境变量 |
| `project` / `local` | `${cwd}/.claude/settings.json` 与 `settings.local.json`（在 candidate 的可写工作区里） | 子进程环境变量 | **settings 赢** ⇒ 必须钉 |
| `flag` | `--settings`（SDK 的 `options.settings`） | `settings.env` 里再给一份 | flag 赢 |

⇒ 三个键（base URL 与两份凭据）**两处都要给**：子进程环境管「CLI 启动时的连通性预检」与其余一切，
flag 档管「合并结果」。只给 settings 那一格会丢掉环境隔离，只给环境那一格则被 `project` 档盖掉。
`model` 不必钉：实测 `options.model` 赢过 settings 里的 `model` 键与 `env.ANTHROPIC_MODEL`。

**Claude 的禁用工具清单**：会话级定时任务（`CronCreate` / `CronDelete` / `CronList` / `ScheduleWakeup`）、
`PushNotification`、`DesignSync` 在任何模型上都禁（本产品每行跑完即释放，没有「以后」，也没有收件人）；
`WebSearch` **按模型名分档**——`modelId` 含 `claude`（大小写不敏感）时放行，其余模型禁用（它是厂商服务端
执行的工具，第三方模型走同一网关时未必实现，与 codex 无条件关 `web_search` 的理由同源）。

#### 5.6.6 生命周期与释放（对应第 4 步）

**每行的 `run()` 必须在所有出口释放**：正常完成、抛错、被停止、「开始」被拒——一个都不能漏。

**只有一条停止通路：`signal`**（F12：执行与评分都不限时间）。释放顺序固定，**不可颠倒**：

```
interrupt()  →  终结在途 turn  →  dispose()
（发停止信号）  （跑适配器自己的 finally 清理）  （回收子进程 / 删临时目录）
```

反面做法是「直接 `dispose()`」：两者争抢同一批资源（dsh 的子进程、codex 的临时目录），会产生竞态。**适配器层的收尾宽限**是 `agents/src/release.ts` 的 `RELEASE_GRACE_MS = 5_000`（三家共用的 turn 骨架都用它，候选与评分两次 `run` 一视同仁；编排层另有同值的 `TERMINATION_GRACE_MS`，管的是行落终态之后的交卷窗口，**只用在候选阶段**，见 §5.5.1）：发出停止信号后给适配器 5 秒交卷，超时仍在跑就强制 `dispose()`，并落一条 WARN 到该行事件日志（**非合作的适配器必须可见，不能静默**）。它**不是超时判定**——评分阶段不接宽限参数（`Promise.race` 直接以 `terminalReached` 为准，见 §5.5.1 的终止 race）：那一分反正落不了快照（行已是终态），没必要为一条日志多等 5 秒。

**`exitReason` 的归属只有一处**：`signal` 只表示「外部要求停止」，适配器**不得**用它来推断 `exitReason`——否则用户终止与别的停止来源会同时触发，两边都声称是自己导致的，最终状态就成了竞态。判定优先级固定：`signal` 已中止 → `canceled`；其余按实际结果（`assembleResult` 只产出 `canceled` / `error` / `completed`——**`timed-out` 今天没有生产者**，见 §5.4 与 §5.6.7）。

**关闭守卫必须绑定「被关闭的对象」，不能是运行时级一次性闭锁**：`中断 → 下一轮新建客户端 → 释放` 这条路径下，闭锁会让 `dispose()` 拿不到新客户端 → 留下旧客户端的孤儿进程。守卫的语义是「每个客户端恰好关一次」。

**`dispose()` 必须幂等**：停止与释放可能先后触发。

**模型与权限档变更一律「重建运行时」**，不做热改：dsh 的权限档是启动 profile 里烘进去的（改了必须重启），codex 的 sandbox 在建线程时固定——一律重建 + 正确释放旧实例，避免留下一半旧一半新的状态。

**适配器不感知工作区准备**：`cwd` / `configHome` 由编排层（§5.5 第 1–3 步）备好并传入；适配器不做 git 操作、不建分支、不校验 commit。这条边界的作用是让适配器可以在一个临时目录上被单测，而不需要造仓库。

#### 5.6.7 加载、降级与错误码

厂商 SDK 懒加载，**只缓存成功的加载**；假体注入走运行时上下文——claude / dsh 用 `sdkModule`（包名 → 模块命名空间），codex **不加载厂商 SDK 模块**（它解析自带可执行文件并 spawn `codex app-server`），其假体是 `codexProvider.runtimeHooks`（`createClient` / `resolveBinary`）。**失败面必须收窄到单家**：一家 SDK 缺失只让该家不可用，不影响其他两家、不影响整包导入。

```ts
export type AgentErrorCode =
  | 'AGENT_LOAD_FAILED'      // 厂商包缺失 / 加载失败
  | 'AGENT_FAILED'           // CLI 未安装、进程非零退出、模型名不存在
  | 'AGENT_TIMED_OUT'        // 适配器**自报**的超时（本层已无 timeoutMs：时限见 F12）。刻意与行状态 timed-out 同名
  | 'AGENT_CANCELED'         // 用户终止
  | 'AUTH_FAILED'            // 密钥无效
  | 'RATE_LIMITED'           // 限流
```

**与 `AgentExitReason` 刻意不同名**：`exitReason` 是对**编排层**的分类信号（`'timed-out'`），`error.code` 是写给**用户看**的归因（`'AGENT_TIMED_OUT'`）。两组值不是一一对应——`exitReason: 'error'` 会按上表细分成 `AGENT_LOAD_FAILED` / `AGENT_FAILED` / `AUTH_FAILED` / `RATE_LIMITED` 四种归因，而 `'canceled'` / `'timed-out'` 只有唯一归因。拆成两个类型可以让「结果分类」与「错误文案」各自演进，也避免实现者把 `exitReason` 直接当错误码透出。

**`AgentErrorCode` 不是 `contracts` 的 `ErrorCode`**：`ErrorCode` 是「能被 `httpStatusFor` 映射成 HTTP 状态码」的接口层错误码（脚手架 `errors.ts` 一次定稿、只增不改），而这一组是**落到该行事件日志里的领域归因**——`AGENT_LOAD_FAILED` 没有对应的 HTTP 状态，它描述的是一次评测执行为什么失败，不是一次请求为什么失败。两者只在 `AUTH_FAILED` / `RATE_LIMITED` 上重名：接口层那两个用于「设置页代调供应商」的即时失败，这里两个用于「该候选行 failed」的记录。实施时不要把 `AgentErrorCode` 塞进 `ERROR_CODES`（那会让 `STATUS_BY_CODE` 需要为它编造状态码）。

| 场景 | 错误码 | 用户可见文案的要求 |
|---|---|---|
| 厂商包加载失败 | `AGENT_LOAD_FAILED` | 必须点名包名与安装方式（「未装」与「装了但加载失败」的处置完全不同） |
| CLI 未安装 / `spawn ENOENT` | `AGENT_FAILED` | 指向缺失的可执行文件 |
| 密钥无效 | `AUTH_FAILED` | 带 host，指向设置页（§10） |
| 限流 | `RATE_LIMITED` | 提示改用串行（§10） |
| 模型名不存在（各家返回 404 / 400） | `AGENT_FAILED` | 保留上游响应正文——网关的 404 与模型名拼错在正文之外无法区分 |

#### 5.6.8 测试口径

**单测（不碰真实 API、不碰真实 CLI）**：

| 对象 | 断言 |
|---|---|
| 注册表 | 三家齐备；`getProvider` 对未注册 id 抛错且错误信息含可用清单；协议兼容性元数据投影与 §5.6.2 的表逐格一致（**这条是 F2 的回归网**） |
| 注入参数 | 三家 `baseUrl` / `apiKey` / 模型分别落到**正确字段**；base URL 的 `/v1` 处理用表驱动：尾斜杠与 `/v1` 后缀的组合各一例 |
| 凭据隔离 | 跑完一轮后宿主 `process.env` 里**没有**注入的变量（正反两面：子进程拿到了、宿主没被改） |
| 事件归一化 | 未识别事件被投影为保留原始负载的日志事件，**不丢失** |
| 计量 | 厂商事件里有 usage 时提取为数值；没有时得到 `null`（**断言不是 0**）；**子智能体分量**：没有子智能体 ⇒ `{0,0,0}` / `0`，有任何子智能体读不出 ⇒ 两格一起 `null` + 点名 WARN，且恒有分量 ≤ 合计；**回写口径**按每条事件自己的 `tokensBasis`（缺格按 `estimated`），不再反查注册表能力 |
| 结构化输出 | 传了 schema ⇒ 键存在且值逐字相等；**不传 ⇒ 该键不存在**；不支持的家 ⇒ 降级跑完且 `applied.structuredOutput === false`（**不把 schema 交给 `start`**，包内落一条 WARN；未传 `outputSchema` 时结果同样是 `false`，但**包内日志不出现**——判据是那条 WARN 的次数） |
| 强度与窗口 | 三家各自的参数名与值正确、**未选 ⇒ 该键不存在**（dsh 例外：落它声明的缺省档）；三家都显式声明 `reasoningEfforts`，且 `defaultEffort`（若声明）落在自己的档位域里 |
| 终止 | 停止路径断言顺序为 `interrupt → turn 终结 → dispose`；`dispose` 幂等；适配器忽略停止信号时释放仍在有限时间内完成且落 WARN |
| 加载降级 | 厂商包缺失时整包仍可导入；只有该家失败；错误文案含包名；后续一轮可重试成功 |

**冒烟（真实网关 + 最小仓库，各智能体一条最小任务，与 §9 的成本护栏一致，不复跑）**：

1. 宿主环境变量在跑完后未变；
2. 工作目录里确实产生了文件改动（证明 CLI 真的在 `cwd` 里干活，而不是在别处跑）；
3. 三种「终止」各验证一次语义：Claude Code / Codex 走 `interrupt()`，DSH 走「关闭运行时」——三者的行状态都必须是 `canceled`，且子进程确实消失（用 CLI 核对，不只看页面）。

#### 5.6.9 活动行（流信息）统一词表

**口径**

候选卡片底部那一行只回答一个问题——**此刻在做什么**。翻这句话的实现全仓只有一份：`agents/src/activity.ts`；跨家同形由 `src/activity-conformance.test.ts` 逐字钉住（差异只允许出在**厂商自己的名字**上：工具名、任务名）。

| 环节 | 落点 | 判据 |
|---|---|---|
| 采集 | `client/src/row-live.ts` 的 `stepLiveState` | 只有 `log` 事件写 `latestText`；`status` 与 `usage` 另有落点（开始时刻 / 候选结束点 / 计量与轮次），其余事件只推进游标 |
| 选句 | 同文件 `activityOf` | 候选串 = 非空 `summary`，否则 `text`（**`summary` 同样要过机器负载这一关**：评分阶段适配器会把 JSON 压成一行摘要发下来）；机器负载（JSON / `[标签] JSON`）与空串不算消息、**保留上一句** |
| 渲染 | `ui/src/base/agent-activity-line.tsx` | 只有运行态（`preparing` / `running` / `judging`）显示，还没说话时给回落文案（`正在准备…` / `正在思考…` / `正在评分…`）；终态整行收起；单行截断、不挂 Tooltip |
| 落点 | `ui/src/composite/agent-log/build-model.ts` | `log` 事件**不进轮次时间轴**，只进「原始输出」面板；`summary` 优先渲染，`text` 原文照旧逐字给出（两格不许互相顶替） |

两条推论：

1. **不给摘要 ≠ 不落证据**：`text` 照旧逐字进原始输出面板，活动行只是保留上一句人话。
2. **想让一行不占活动行，让候选串（`summary` 或 `text`）是机器负载或空串即可**——`activityOf` 先取非空 `summary`、否则取 `text`，候选串再统一过机器负载这一关；codex 的 `agentMessage` 是「落了正文就占住活动行」的典型（不给摘要，由 `activityOf` 直取它的正文）。

摘要主体上限 120 字符（`ACTIVITY_SUMMARY_MAX_LENGTH`），前缀（如 `调用工具 pwsh：`）不计入；产物一律单行化（换行与连续空白压成一个空格）后截断带省略号——卡片底部只有一行。

**词表**

| 场景 | 统一产出 | 取值规则 |
|---|---|---|
| 工具调用 | `调用工具 <名>：<参数摘要>` | 参数按优先级取**第一个非空字符串**：`command` → `file_path` → `path` → `job_id` → `query` → `pattern` → `description` → `url` → `prompt`；取不到则看改动清单（`changes[].path`，两个以内全列、更多说「前两个 等 N 个」）；再取不到 ⇒ 紧凑 JSON；整串解析不动（被截断 / 本来就是纯文本）⇒ 原样。名字或参数缺一边时句子照样成立（`调用工具 Bash` / `调用工具：ls`），两边都缺 ⇒ `调用工具`——**不编名字、不留空冒号** |
| 计划 / 待办 | `更新计划：N 步` | 入参含 `todos` / `plan` / `steps` 中任意一个**数组**即整体替换那句参数摘要（**先于**参数优先级判；空数组也是事实，说「0 步」）；codex 的原生 `turn/plan/updated` 同句 |
| 工具报错 | `工具报错：<内容>` | 只在**报错**时播；内容缺失时只留前半句。**成功返回不播** |
| 子任务派发 | `已派发子任务：<名>` | 无名 ⇒ `已派发子任务` |
| 子任务收场 | `子任务已完成 / 失败 / 已停止：<名>` | `completed` / `failed` / `stopped` 三档；认不出的厂商状态折成「已结束」，英文原文留在日志 `text` 里 |
| 模型答复 | 落 `log`，**不带摘要** | 正文本身就是人话，`activityOf` 直取 `text`（与 claude 的文本块、codex 的 `agentMessage`、dsh 的答复行同待遇）；同一句话不留两个版本 |
| **不播**（证据照落盘） | 工具成功返回 · 推理正文 · 轮次播报 · 未识别信封 | 落点分别是结果块、思考块、轮次那一格、原始输出面板 |

**「不播」这一列的判据是行为规范，不是省略**：工具成功返回会把那一行变成流水账（`工具返回：<一长串路径>`，而它本来就有结果块与原始输出面板）；推理正文与轮次播报会把最新一句钉死在 `思考：…` 或 `第 N 轮开始` 上，此后每一轮的工具调用都顶不掉它；未识别信封（如 `{"method":"account/rateLimits/updated"}`）发的是机器负载，靠 `activityOf` 的机器负载判据才挡得住——**发的人不该发**。同理，工具摘要必须带参数：只给工具名（`调用工具 Bash`）的那一句，信息量比它顶掉的那句人话更低。子任务行不留占位名：名字缺失时回落成字面量「子任务」会得到 `已派发子任务：子任务` 这种同义反复，读的人只会以为界面坏了。

**各家「在哪一条通知上发」**

| 家 | 工具调用 | 报错 | 子任务 |
|---|---|---|---|
| claude-code | `assistant` 消息里的 `tool_use` 块（一条消息里的多个块用 `；` 串成一句，整句仍截断） | `user` 消息里 `tool_result.is_error === true`（多条报错也拼成一句） | 派发 `system/task_started`；收场 `system/task_notification` |
| dsh | `session.event` 的 `tool/call`（`arguments` 是 JSON 字符串，由 `activity.ts` 解析） | `tool/result` 的 `message.isError` | `subagent.started` / `subagent.finished` |
| codex | `item/started`：`commandExecution`（工具名 `exec_command`）、`mcpToolCall`、`webSearch`、`dynamicToolCall`，以及协作调用里**不以 `spawn` 开头**的那些（`wait` / `closeAgent` 走通用工具句） | `mcpToolCall`（`error` 在场**或** `status: 'failed'`，取或、各挡一种错法）；`fileChange` / `commandExecution` 的 `failed` / `declined` | 派发：以 `spawn` 开头的协作调用的 `item/completed`；收场：三个来源见下 |

**子任务名**（运行期的收场行都带得上名字，取数面各家不同）：

| 家 | 名字从哪来 | 形状 |
|---|---|---|
| claude-code | **派发帧** `task_started.description` → 模块级名字表 → 收场帧按 `task_id` 回填 | `task_notification` 的键集里**没有** `description`（读自 `probe/dumps/v4/claude-subagent-usage.jsonl`，该目录不入库、只在本机可复核）⇒ 不回填就只能是「子任务已完成」 |
| dsh | `subagent/catalog` 的 `label`（模块级 catalog 表，与 `subagent.started` **分两条消息**到达，按 `childId` 关联） | 收场行 `子任务已完成：Review hello world Vue page` |
| codex | `thread/started` 的 `agentNickname` → `runState.nicknames` | 真机**只有主线程收到 `thread/started`**（且 `agentNickname: null`），子线程的昵称只出现在收尾 `thread/list` 的**响应**里 ⇒ 派发 / 收场行**运行期恒无名**（词表允许的那一档）；子任务行在收尾取数后会有名字，两个面因此可能不一致——这是上游协议的取数边界，**适配器层不编名字** |

**codex 的四条判据**（`L48`/`L51`/`L58`/`L59` 取自真机抓包 `probe/dumps/v6/codex-chat-wire-appserver-live-responses-subagent.jsonl`；判据 1 的「33 条命令里 6 条非零」出自**另一次真机运行、无留存转储**——与本节末尾「已知边界」同一档登记，⚠️ `probe/dumps/` 已被 `.gitignore` 排除、`git ls-files` 里 0 个文件，这些读数只在保留过本地 dump 的机器上可复核）：

1. **命令只在开始播**：`item/started` 那一刻命令行已完整（`L58`）；完成时的输出与退出码是**结果**，落点是结果块与原始输出面板。完成那一支**只看「有没有跑起来」**：`failed` / `declined` 照播「工具报错」，正常的 `completed` **一律不播，哪怕 `exitCode` 非零**——真机 33 条命令里 6 条非零（18%），而那是 `grep` / `Test-Path` 一类探测的正常返回，播成「工具报错」是**误导**不是保守。
2. **派发只能在 `item/completed` 播**：`item/started` 的 `receiverThreadIds` 是**空数组**（`L48`）、id 到 `item/completed` 才出现（`L51`）——把判据放在开始那一支，那句话在生产里**永不播**。同一条抓包里 `wait` 那一支在 `item/started` 就带 id（`L59`）⇒ 它照旧在开始播「调用工具 wait」。
3. **收场有三个来源**：协作调用的 `agentsStates`、`subAgentActivity`、**子线程自己那一轮的 `turn/completed`**（`message.ts` 的 `terminalStatusOf` 读的也是它）。三者共用一份「终态 ∧ 与上次不同」的去重台账（`runState.subagentStatus`），否则同一次收场会播三四遍；第三个来源是模型派发完直接收尾时活动行唯一的终态（否则它会一直停在「调用工具 spawnAgent」，而子任务行按同一份事实已经写着「已完成」）。
4. **`fileChange` 与命令相反，只在完成播**：`item/started` 的 `changes` 可能还是空的，拿它出一行只会得到没有信息的「调用工具 apply_patch」。

**证据负载**：活动行那一条 `log` 的 `text` 是原始条目，但按 `evidenceOf` **去掉正文型重字段**——`commandExecution.output`（命令输出）、`mcpToolCall.result`（工具结果）、`dynamicToolCall.contentItems`（内容块数组）只留识别字段、入参与状态。理由：事件流的每一条都要过 SSE 推给浏览器，而这三类的正文在各目的结果块里已经是权威的一份，在事件流里再抄一份会让一次构建的几万行输出把流撑大一个量级。

**守卫与变异**

| 守卫 | 钉住什么 |
|---|---|
| `src/activity.test.ts`（14 条） | 词表本身：句式、参数优先级（含 dsh 的 `job_id`）、计划整体替换、截断、无名不留占位 |
| `src/activity-conformance.test.ts`（7 条） | **三家逐字同形**：工具调用同一句（只有厂商工具名不同）、工具报错同一句、子任务派发 / 收场同一句、计划同一句，以及「该沉默的一起沉默」——后者钉在**草稿**上（不给摘要 ∧ 证据照落），只用「有没有摘要」会把「整条日志被删掉」也判绿 |
| 各家 `events.test.ts` | 只在各自的通知形状上钉「在哪一条通知上发」；codex 另有三条：证据负载不带结果正文（`evidenceOf` 的裁剪）、命令「没跑起来」与「非零退出」分开、**真机抓包重放**（把 `probe/dumps/v6/…live-responses-subagent.jsonl` 的 97 行里 **91 条带 `method` 的通知帧**过一遍投影，钉住「已派发子任务」与「子任务已完成」**各恰好一次且先后有序**，并断言这一串里出现过「调用工具 wait」）（⚠️ 这一条**依赖本地 dump**：`packages/server/agents/probe/dumps/` 被 `.gitignore` 排除、`git ls-files` 里 0 个文件，用例直接 `readFileSync` 且没有 `existsSync` 兜底 ⇒ **干净克隆下它会以 ENOENT 失败**——下面那些「几条红」的变异计数只在有 dump 的机器上可复现，如实登记） |

每条守卫都做过变异验证（见过它失败后还原并核 SHA256）：codex 退回「不发活动行」⇒ **12 条红**（codex 9 + 一致性 3）；claude 工具摘要退回「只给工具名」⇒ **2 条红**（`claude-code/events.test.ts` + `activity-conformance.test.ts`——仓内只有这两处断言 claude 的带参摘要）；dsh 把推理行重新顶上活动行（`思考：…`）⇒ **2 条红**；恢复「名字缺失回落成『子任务』」⇒ **10 条红**（`activity.test.ts` 1 + `activity-conformance.test.ts` 1 + dsh 1 + codex 5 + claude 2）；`evidenceOf` 改回原样返回条目 ⇒ **2 条红**；派发退回「只在 `item/started`」⇒ **4 条红**（含真机重放那一条）；子线程 `turn/completed` 不再播收场 ⇒ **1 条红**；去掉优先键里的 `job_id` ⇒ **1 条红**；路径为空时照样留空括号 ⇒ **1 条红**；claude 收场不再从名字表回填 ⇒ **2 条红**。

**已知边界（如实登记）**

1. **工具名仍是各家的真名**（`Bash` / `pwsh` / `exec_command`）：一致性只保证句式与参数摘要同形。要统一成一套抽象工具名，等于在活动行上引入第二份工具表，不做。
2. **codex 的 `subAgentActivity` 与 MCP / 联网 / 动态工具 / 补丁的 `item/started` 没有真机样本**：全库 dump 聚合出来只有 `commandExecution` 一条、collab 两条、`agentMessage` / `reasoning` / `userMessage` 若干 ⇒ 这几类的「开始发调用」只有合成夹具。若上游对某类只发 `item/completed`，那一句同样会永不播（与上面判据 2 同型）——出现时按同一条修法处理。
3. **codex 派发 / 收场行运行期恒无名**（上游取数边界，见上表）：子任务行在收尾取数后有名字，两个面可能不一致。
4. **`item/plan/delta` 与 plan 条目**在 codex 侧不产活动行：计划表的权威通知是 `turn/plan/updated`；若上游改成只发条目流，活动行会少一句计划，届时补。
5. **计划更新那一档仍只有单测**：两轮真机的模型都没调 `update_plan`。
6. **评分阶段的流与候选在同一条事件流里**：活动行在 `judging` 显示的是评分智能体的最新一句——用户口径要求「评分的消息也在这里滚动展示」，故这是**有意**的；活动行显示的是**不带前缀的 `summary`**，故**那一行**分不出这句话是谁说的（原始输出面板里的 `text` 带 `[评分智能体] ` 前缀，抽屉里分得清，见 §5.5.1）。要分开就得给事件加来源标记，属独立口径变更。

### 5.7 评分器

**文本通路（`evaluator/src/judge.ts` 的 `judgeRow`）与智能体通路的收口共用同一份代码。**

```ts
interface JudgeInput {
  rubric: Rubric                     // **本轮快照**（EvalRun.rubric），不是用例现取的那一份
  diffText: string                   // 已按 diffBudgetBytes 裁剪并标注截断
  taskPrompt: string                 // 考题提示词（给评分模型提供题面上下文）
  route: TextRoute                   // { protocolType; baseUrl; apiKey; modelId; contextWindow?; maxOutputTokens? }
  judgeProviderId: string            // 「这一分是哪把供应商打的」——与 route 同一份配置快照
  judgeEffort?: string               // 评分要求的思考强度（§5.5.2）；**不进 route**（它是请求参数）；缺省 = 未指定
  signal?: AbortSignal               // 可选：不传即「不可中止」；编排层两处调用都传同一把控制器
  onProgress?: (p: { round: number; message: string }) => void   // 每一轮修复都进该行日志
  onAttemptStart?: () => void        // 「一次新的行尝试」的接缝（生产代码里是 no-op）
}

export function validateJudgeResponse(raw: string, rubric: Rubric): JudgeValidation;   // 结构检查，**不抛**
export function parseJudgeResponse(raw: string, rubric: Rubric): { judgments; verdict };  // 不合格 ⇒ JUDGE_PARSE_FAILED
export function finalizeScore(input: { parsed; rubric; raw; judgeProviderId; judgeModelId;
                                       judgeAgentKind; judgeEffort: string | null;
                                       structuredOutput: boolean;
                                       judgeTokens: { input; cached; output } | null;
                                       judgeDurationMs: number | null }): ScoreResult;
```

`finalizeScore` 的记账入参**全部必填**（`judgeEffort` / `structuredOutput` / `judgeTokens` / `judgeDurationMs`）：两条通路各自表一次态，给缺省会让「忘了传下来」与「确实没采到」在数据上同形。**这一分自己的花销**两路来源不同、语义一致：文本侧 = 各轮成功调用**之和**（结构修复是额外请求，钱要算进去；上游没报用量的那一轮**什么都不加**，不当成 `{0,0,0}`）+ 从进 `judgeRow` 起掐表（`text-api.ts` 的 `TextCallResult.usage` 是唯一原料）；智能体侧 = 适配器自报的 `result.tokens` / `result.durationMs`（与候选行同一份原料）。没采到一律 `null`（界面写「用量未采集」/「未采集」，**绝不写 0**）。

**解析（`collectJudgeJudgments` 是唯一真源，`parseJudgeResponse` / `validateJudgeResponse` 都只是它的一层皮）**：

1. 围栏剥离不变（**只剥整段以 ``` 开头的**，中间夹散文故意不救——从散文里抠 JSON 会把「模型没守契约」静默变成「成功」，而暴露它正是解析器的职责）。
2. 顶层必须是对象、`judgments` 必须是数组；不合法 / 空内容 / 顶层不是对象 / 没有数组 ⇒ 不合格。
3. **按快照的引用键逐个找判定，缺一项即不合格**（报错点名「缺少对 <引用键>（<目标>）的判定：评分表里的每一项都必须恰好给出一条判定」）——这一条必须写成**一行可被变异验证的分支**（把它改成 `continue` 就是那个缺陷本身）。**多余的判定忽略**（只读评分表的键）、**重复引用键取第一条**。
4. `achieved` **宽容读**：接受布尔，以及 `"true"` / `"false"` / `"是"` / `"否"` / `"达成"` / `"未达成"`（大小写不敏感）；**不再多收**（`"优秀"` / `"yes"` / `1` 各加一格都是「换个词就能过」的新口子）。认不出 ⇒ 不合格。
5. `reason` 缺失给占位文案（`（模型未给出理由）`）；`verdict` 缺失给占位文案（`（模型未给出总评）`）——两者都是展示项，不是判据。

**收口 `finalizeScore`**：`totalScore = composeTotalScore(快照, 判定)`、`maxScore = rubricMaxScore(快照)`；自检失败仍抛中文 `INTERNAL`。`raw` 上限两路共用（成功 20 000 / 失败 2 000 字符），日志抽屉可见，方便判断是提示词问题还是模型问题。

**回问修复（`JUDGE_REPAIR_ROUNDS = 2`，即最多 3 次请求）**：结构检查不合格时把原因与**上轮原文**（截断）连同**逐项清单**一起回问模型——`buildJudgeFeedback` 的字段清单是「**评分表引用键 + 目标 + 权重**」+ 新输出契约（漏一项 = 白送那一项的权重）。每一轮都写进该行日志：「为什么这一行多花了一次请求的时间」必须能从日志抽屉里看出来（静默重试不可接受）。

**智能体通路的提示词**里「评分标准项」一节用 `renderRubricForJudge`，其余口径（只读要求、两类失败面、`finalText === null` 与空答复的区分、`ok` 判定先于读答复）见 §5.5.1。

---

## 6. 功能模块三：设置

`/settings` 页 = `Tabs` 四页。脚手架阶段只实现了「界面主题」一项，本阶段补齐其余三项。

### 6.1 模型供应商

`Table`（列：名称 / 协议类型 / API 地址 / 模型数 / 操作）+ 「添加供应商」`Modal` + **模型清单 `Modal`**（独立对话框，入口 = 列表每行操作列的「模型」按钮，排在「编辑」之前）。

**两个弹窗的分工**：模型清单是**高频动作**（拉取 / 增删 / 逐条维护窗口），「编辑」弹窗只管四个接线字段（名称 / 协议 / 地址 / 密钥，宽度 560）——把功能搬走要在编辑弹窗里留一条 Alert 指路（搬走却不留路标，读起来就是「功能没了」）。模型清单对话框**不做提交**（没有「确定」）：拉取、增删、保存窗口都是立即生效的独立请求，页脚只有一个「关闭」；目标供应商在开着时被删掉（`provider` 变 `null`）时给一条可见原因，而不是空白或一个注定 404 的按钮。列表**没有**「密钥掩码」列，故这里是五列。

| 字段 | 说明 |
|---|---|
| 名称 | 如「DeepSeek 官方」 |
| 协议类型 | `Radio`：OpenAI 兼容 / Anthropic 兼容 —— 决定它的模型能喂给哪些智能体；**不参与拉清单的判定** |
| API 地址 | baseURL，如 `https://api.deepseek.com/v1`（openai）或 `https://api.deepseek.com/anthropic`（anthropic） |
| API 密钥 | `Input.Password`；掩码只在**编辑弹窗**的密钥框占位符里回显（「留空表示不修改（当前：…）」），列表**不展示**掩码 |
| 模型清单（独立对话框） | 「拉取模型」按下面的候选顺序打 `GET`；可手工增删；逐条维护输入 / 输出上限（§5.1.1） |

**拉模型的四个实现要点**：

1. 请求照 `Authorization: Bearer <key>` 发；响应解析 `data[].id`，同时容忍 `data` 为字符串数组的形式，以及 `data[]` 里带窗口 / 档位的那些格（§5.1.1 的取数）。
2. **拉取结果是合并而非覆盖**：手工添加的模型必须保留（`source: 'manual'` 的条目不被 `fetched` 结果冲掉），**手工改过的窗口也不被拉取打回**（§5.1.1 的合并代码）。
3. **地址形态兜底**：候选按顺序是 `{地址}/models` → `{地址}/v1/models`（地址已以 `/v1` 结尾时跳过这条）→ 站点根的 `/models` → 站点根的 `/v1/models`，重复的 URL 只留一次。只有 **404** 才换下一条候选——401/403/429/5xx 说明路径是通的，问题在密钥、限流或上游自己；「2xx 但一条 id 都认不出」同样不换（那是响应形状问题，不是地址形态问题）。两条构造规则：`/v1` 结尾的地址不再补 `/v1`（否则打出 `/v1/v1/models`）；地址本身就填到站点根时不重复出候选（常见填法的候选必须仍是两条）。**补根的理由**：`/anthropic` 一类 Messages 根与 `/api/v1` 一类带前缀的地址都是合理填法，而清单接口往往挂在站点根上——只按配置地址拼会一路 404，用户的地址与密钥却都没错。全都不通时错误文案要点名**试过的每一条**实际路径，否则用户看不出地址少了一段。
4. **失败不阻断保存**：拉取失败保留已手工维护的清单，`message.error` 呈现原因。

**密钥的安全取舍**（必须写进代码注释）：服务端需要原 token 才能代调供应商 API，无法只存哈希；缓解措施是配置文件写盘后 `chmod 0600`（属主独占）+ 对外出口一律掩码。Windows 无 POSIX 权限位，`chmod` 仅能近似切换只读位，属主独占实际由 NTFS ACL 与用户目录隔离承担——尽力而为、失败不报错、不阻断保存。

### 6.2 评分配置

- **默认评分模型**：按供应商分组的 `Select`；候选池**覆盖两种协议**（文本通路的评分不依赖智能体，故两边都可用）。未配置时用例页的「智能生成 / 智能识别」与评测的评分步骤都不可用，界面需明确提示去向。
- **思考强度**（`packages/client/ui/src/composite/judge-settings-card.tsx`，位置在「默认评分模型」**下方**）：`Select` + `allowClear`，`aria-label="思考强度"`，清空 = **未指定**（请求里一个强度键都不加，不是关闭、也不是某一档）。选项 = §5.5.2 的档位域，与后端 `requireJudgeEffort` **同一个函数、同一个参数序**（`intersectEfforts(model, agentEfforts, CANONICAL_EFFORT_LEVELS)`）——写下侧的 schema 只看「非空字符串」，**界面能选到的值必须能过那道门**，算多一格（例如给 dsh 列出 `medium`）用户就会在生成 / 识别时被硬拒。档位文案照上游词汇原样（关闭档就是 `off`，**不加工选项文字**；与创建评测那一格同一口径）。三种边界：未配默认评分模型 ⇒ `disabled`；换掉模型 / 智能体后档位不在域里 ⇒ 显式提示「当前的思考强度已失效」且**不回显失效值**；配了评分智能体但注册表投影还没到 ⇒ `disabled` 且**不判悬空**（兜规范五档会摆出该家收不了的档）。改动随 `onChange` 自动保存（本页没有保存按钮），保存不被阻止——拦截发生在**评分**与**智能生成 / 智能识别**两处（§5.5.2；创建评测那一处只校验候选行的强度）。
- **默认评分智能体**：同形 `Select`（`AGENT_KINDS` + `AGENT_LABELS`，`allowClear`），决定「用哪家 CLI 驱动智能体评分」；不兼容当前默认评分模型的家 `disabled` 并写明原因。未配置时「使用智能体评分」的轮次在创建时被拦下（§5.5.1）。
- **输出契约（只读）**：**两段**说明（逐项给「达成 / 未达成 + 一句理由」、不给总分；总分 = 达成项权重之和、满分 = 全部项权重之和）。
- **diff 上限**（`diffBudgetBytes`）：`InputNumber`，界面上以 **KB** 计（标签即「diff 上限（KB）」、带 `suffix="KB"`），默认显示 256（= 262 144 字节）；配置里存的仍是字节。

**这一页没有「行超时」**：执行与评分都不限时间（F12）。

后两项放在这一页而不是单独的「高级」页：它们都直接决定「一次评分拿到什么输入」，与评分语义是一件事。

### 6.3 工作区

| 字段 | 说明 |
|---|---|
| 工作区根目录 | `Input` + **「校验并保存」**按钮（打 `PUT /api/settings`，服务端校验通过才落盘）；默认 `~/.runs` |

目录结构：

```
{workspaceRoot}/
├── cases/{caseId}/cache/            # 用例级本地缓存仓库（首次评测时克隆一次）
├── remotes/{slug}-{hash8}/          # 远端来源的裸镜像（`git clone --mirror`，跨用例复用）
└── {runId}/
    ├── run.json                     # 运行快照（`listRuns` 的判据）
    └── rows/{rowId}/
        ├── workspace/               # 该候选行的工作副本（独立分支 test/{rowId}）
        ├── .agenthome/              # 该候选行的智能体独立配置目录
        ├── .judgehome/              # 评分智能体自己的配置目录（与 .agenthome 分开）
        ├── events.jsonl             # 该行的执行事件日志（唯一真相源；清空只归 `resetEvents`）
        ├── messages.jsonl           # 内容级消息的落盘快照（清空归 `resetRecords`，见 §8）
        └── attempts.jsonl           # 该行的尝试账本（累计，**永不被清空**）
```

`listRuns` 只认「目录下有合法 `run.json`」的那些 ⇒ `cases/` 与 `remotes/` 不会被当成一轮评测。整轮删除只删 `{runId}/`：**镜像不随用例或评测消失**（它按 URL 命名、可能被多个用例共用），也不自动清理。

**校验必须真写一次再删**（只检查父目录是否存在不够——磁盘满、无权限、路径过长都会在真正写入时才失败）：

1. `~` 展开为 `os.homedir()`；
2. 尝试 `mkdirSync(root, { recursive: true })`；
3. 在 root 下写一个随机名**探针文件**再删除，确认「这个目录能落盘」——写文件而非建子目录：判据是能否落盘，而 mkdir+rmdir 多一个可独立失败的步骤、多一种要解释的失败；
4. 任一步失败 → `NOT_WRITABLE` + 具体原因（含失败路径），且两条失败路径的文案必须能区分是「建目录失败」还是「写入失败」（错误码与路径相同，措辞是唯一区分信号）。

**改动根目录时不动已有数据**：已完成的评测产物留在旧根目录下，不自动迁移；界面对历史评测显示其 `workspaceBase` 实际路径，避免「改了设置后找不到旧产物」。

### 6.4 界面主题

三档 `Segmented`：跟随系统（默认）/ 明亮 / 暗色。落地口径（三个消费点必须同步）见脚手架设计文档。

---

## 7. 数据模型与持久化

### 7.1 存储位置

```
~/.aieval/config.json          # 三段同在一个文件（AppConfig = { settings, providers, cases }）：
                               #   应用设置（主题、工作区根目录、默认评分模型与默认评分智能体、diff 预算）
                               #   + 供应商（含 API 密钥，仅本机）+ 用例
{workspaceRoot}/...            # 工作区与运行产物（见 §6.3）
```

配置目录优先级：测试覆盖 `setConfigDirForTesting(dir)` > `AIEVAL_CONFIG_DIR`（部署可配，**空串按未设处理**）> `~/.aieval`。原子写、UTF-8 BOM 容忍、权限收紧、缺失字段归一化等口径由脚手架的 `config-store` 统一承载。

### 7.2 契约（`packages/server/contracts`，zod schema）

```ts
type ProtocolType = 'openai' | 'anthropic'

/** 模型能力五格全部可选（缺省 = 未知，绝不兜底成 0）；后两格是思考强度，见 §5.1.1 */
type ProviderModel = {
  id: string
  source: 'fetched' | 'manual'
  contextWindow?: number
  maxOutputTokens?: number
  contextWindowSource?: 'fetched' | 'manual'      // 'manual' = 用户改过或清空过，拉取不得覆盖
  supportedEfforts?: string[]                     // 原样保留上游顺序与拼写
  recommendedEffort?: string                      // 不在 supportedEfforts 里 ⇒ 按「没有推荐」
}

type Provider = {
  id: string
  name: string
  protocolType: ProtocolType
  baseUrl: string
  apiKey: string                                  // 写盘明文，下行只给掩码（ProviderView）
  models: ProviderModel[]
  createdAt: string
  updatedAt: string
}

/** 评分标准项：组 → 项（§4.3）。**用例不持有评分模型，也没有 judgePrompt** */
type RubricItem = { id: string; goal: string; weight: number }   // id 可空（空 id 按位置引用 `#k`）
type RubricGroup = { name: string; items: RubricItem[] }
type Rubric = { groups: RubricGroup[] }                          // 空表合法（新建用例的初态）

type TestCase = {
  id: string
  title: string
  repoPath: string                                // 代码来源：本地绝对路径 或 远端 git 地址（§4.5）
  commitHash: string | null                       // null = 默认分支 HEAD
  repoBranch: string | null                       // null = 远端默认分支；本地来源必须是 null
  taskPrompt: string
  rubric: Rubric                                  // 评分表（提交时由 validateRubric 判非空）
  createdAt: string
  updatedAt: string
}

type ExecutionMode = 'parallel' | 'serial'

type EvalRun = {
  id: string
  caseId: string
  /** 冗余快照：用例被删除后仍能追溯这一轮测的是什么（见 §4.4） */
  caseTitle: string
  repoPath: string
  commitHash: string | null
  repoBranch: string | null
  /** 这一轮用的是哪张评分表；评分阶段读它、不读用例 —— 改了用例的表，历史分与它自己的满分仍自洽 */
  rubric: Rubric
  status: 'idle' | 'running' | 'partial' | 'done'
  executionMode: ExecutionMode
  /** 创建时的评分方式快照（§5.5.1）：一轮里只有一把尺子 */
  useAgentJudge: boolean
  rows: EvalRow[]
  workspaceBase: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

type EvalRowStatus =
  | 'pending' | 'preparing' | 'running' | 'judging' | 'judged'
  | 'failed' | 'timed-out' | 'canceled' | 'skipped' | 'interrupted'

type EvalRow = {
  id: string
  agentKind: 'claude-code' | 'codex' | 'dsh'
  providerId: string                              // 执行期按 id 取 apiKey
  /** 冗余快照：供应商被改名或删除后仍能追溯这一行用的什么模型 */
  providerName: string
  baseUrl: string
  modelId: string
  /** 这一行要求的思考强度（§5.1.1）；未选 = 走该家适配器的缺省 */
  effort?: string
  status: EvalRowStatus
  branch: string                                  // test/{rowId}
  workspacePath: string
  baselineCommit: string                          // 40 位具体 hash；**空串 = 尚未准备**
  /** 全树合计（主会话 + 数到的每个子智能体）；null = 未采到，绝不填 0 */
  tokens: { input: number; cached: number; output: number } | null
  turns: number | null
  /** 子智能体那一份（§7.5）：可选，因为老 run.json 没有这两格 */
  subagentTokens?: { input: number; cached: number; output: number } | null
  subagentTurns?: number | null
  durationMs: number | null
  diff: { filesChanged: number; insertions: number; deletions: number; truncated: boolean } | null
  score: ScoreResult | null
  error: { code: string; message: string; stack?: string; stage?: 'agent' | 'judge' } | null
  attempts: number                                // 这一行走过的执行尝试次数（含失败），未跑过为 0
}
```

**七格刻意的冗余快照**：`EvalRun` 存 `caseTitle` / `repoPath` / `commitHash` / `repoBranch` / `rubric`，`EvalRow` 存 `providerName` / `baseUrl`。理由：评测记录的价值在于「可追溯」，如果它只存外键，那么删掉一个用例或改掉一个供应商的名字，历史评测就再也说不清当时测的是什么；评分表同理——它决定了「满分是多少」，不留快照就会让改了表的用例把历史分数变成无解的谜。冗余的是**展示与追溯所需的只读快照**，不是可变配置。

`EvalRow.diff` 只存**计数摘要**（供卡片显示），不存 diff 正文——正文在打开「变更详情」抽屉时由 `api` 按需现场计算（见 §8 路由表）。理由：一轮评测的 diff 正文可达数 MB，预先落库既慢又占空间，而它只在有人看的时候才需要。

**可选 / 带默认值的字段是载重的**：`useAgentJudge`、`attempts`、`error.stage`、`subagentTokens`、`subagentTurns`、`effort`、`repoBranch`（在 `EvalRun` 上；`EvalRow` 的分支字段是 `branch`）与 `judgeAgentKind`、`judgeEffort`、`judgeTokens`、`judgeDurationMs`、`structuredOutput`（在嵌套的 `ScoreResult` 上）在磁盘上都可能有旧记录缺这一格 —— 必填会让 `EvalRunSchema.safeParse` 失败（`score` 是它的一部分，嵌套同样在解析面上），而 `listRuns()` 对失败是**静默跳过**（使用者看到的是「我的评测记录凭空少了几轮」，两端都不报错）。

**所以「跳过」必须可见**：`listRuns` 是**唯一**一次同时看得见「读出来的」与「被跳过的」的扫描（启动钩子 `recoverInterruptedRuns` 拿到的已经是过滤后的结果），故在**同一趟扫描的最后**记一条**汇总 WARN**（「有运行快照因评分口径升级不再兼容，已从列表跳过（列表显示的轮次会比磁盘上的少）」+ 条数；计数只含「读得出 JSON、但过不了契约」的快照，单个文件读不出来的那条另有 per-file WARN）。落在这里而不是启动钩子：启动钩子那趟第一步就是 `listRuns()`，照样会打出同一条，而日常的列表读取也带上它——「列表短了」与「为什么短」永远在同一条日志流里挨着。

所有时间字段（`createdAt` / `updatedAt` / `startedAt` / `finishedAt` / `judgedAt` / 事件的 `at`）统一为 **ISO 8601 带时区的字符串**（如 `2026-09-22T10:30:00.000Z`），不用 epoch 数字——落盘文件需要人可读，也避免时区歧义。

```ts
/** 逐项判定：评分表里那一项的**引用键** + 二元 `achieved` + 一句理由。**没有分数**（模型不给分） */
type RubricJudgment = { id: string; achieved: boolean; reason: string }

type ScoreResult = {
  /** **必须与快照评分表逐项对齐**：少一项即整行失败（缺项 = 判不了，不等于没达成） */
  judgments: RubricJudgment[]
  totalScore: number                              // 达成项权重之和（上限放开：120 / 300 分的表都合法）
  maxScore: number                                // 满分快照（权重之和），**必须为正**
  verdict: string
  raw: string                                     // 模型原始返回，排障用
  judgeProviderId: string
  judgeModelId: string
  judgedAt: string
  /** 这一分是哪个智能体打的；null ⇔ 走纯文本 API（§5.5.1） */
  judgeAgentKind: 'claude-code' | 'codex' | 'dsh' | null
  /** 这一分用的思考强度档位（§5.5.2）；null ⇔ 我们**没指定**（文本侧一个键都不发、智能体侧走该家缺省），照上游词汇原样 */
  judgeEffort: string | null
  /** 这一分是不是在 schema 约束下拿到的（false = 只靠提示词契约）；记的是 `result.applied.structuredOutput`（骨架按能力算出的结论） */
  structuredOutput: boolean
  /** **评分这一次调用自己**的用量；null = 没采到（绝不填 0）。`.default(null)`，老记录读回是 null。文本侧 = 各轮成功调用之和；智能体侧 = 适配器自报的 result.tokens */
  judgeTokens: { input: number; cached: number; output: number } | null
  /** **评分阶段**整段的耗时（含结构修复的每一轮）；null = 没采到（`.default(null)`）。智能体侧取适配器自报的 result.durationMs */
  judgeDurationMs: number | null
}

type Settings = {
  theme: 'auto' | 'light' | 'dark'
  workspaceRoot: string                           // 默认 ~/.runs（见 §6.3）
  defaultJudge: { providerId: string; modelId: string; effort?: string } | null   // effort 缺省 = 未指定（§5.5.2）
  defaultJudgeAgent: 'claude-code' | 'codex' | 'dsh' | null   // 默认评分智能体（§5.5.1）
  diffBudgetBytes: number                         // 默认 262_144（256KB），送评分模型的 diff 上限
}
```

### 7.3 评分口径（评分标准项）

评分表是**组 → 评分项**的二级表格（契约与派生函数见 §4.3）：每项有 `ID` / `目标` / `权重`，模型对每一项只做**二元判定**（达成 / 未达成），**没有部分分**。`总分 = 达成项权重之和`，`满分 = 全部项权重之和`（不固定 100 分，由用例自己的表决定）。满分随每一分快照进 `ScoreResult.maxScore`，因此改了表之后历史分仍自洽。

**模型不给总分**：总分由 `composeTotalScore(快照, 判定)` 按权重加总 ⇒ 「模型自报总分算错」这一整类问题从根上消失。评分表由用例自己定义、可编辑；**表里的项数就是判定数**（缺一项即整行失败）。

### 7.4 事件日志是执行的唯一真相源

每候选行的 `events.jsonl` 每行一个带单调序号的事件：

```ts
type AgentEvent =
  | { seq: number; at: string; type: 'status'; status: EvalRowStatus }
  | { seq: number; at: string; type: 'log'; stream: 'stdout' \| 'stderr'; text: string; summary?: string }   // summary = 给人看的一句话（词表见 §5.6.9），缺 = 这条没有可说的事
  | { seq: number; at: string; type: 'vendor-system'; ... }   // 厂商系统层事实：工具面 / 斜杠命令 / 子智能体定义 / 权限档 / 输出风格 / MCP（六格各自可空）
  | { seq: number; at: string; type: 'usage'; tokens: {...} | null; turns: number;
      tokensBasis?: 'reported' | 'estimated';
      subagentTokens?: {...} | null; subagentTurns?: number | null;
      turn?: { subagentId: string | null; round: number } | null;        // 归属（缺省/显式 null = 主会话那一份）
      timing?: { totalMs: number | null; apiMs: number | null; ttftMs: number | null; source: 'vendor' | 'events' } | null }
  | { seq: number; at: string; type: 'diff-summary'; filesChanged: number; insertions: number; deletions: number; truncated: boolean }
  | { seq: number; at: string; type: 'score'; score: ScoreResult }
  | { seq: number; at: string; type: 'error'; message: string; stack?: string }
  | { seq: number; at: string; type: 'end'; exitReason: string }
```

这八个成员**全是行级**的（轮级状态在协议里没有对应事件）。`vendor-system` 必须是**独立事件**而不是让消费方去解析那条 `log` 原文：原文是**排障证据**、形状由厂商定，消费方逐字认 `subtype === 'init'` 之类的字段就等于把厂商适配搬进了浏览器（本仓的边界是「厂商差异全部吸收在 `agents` 包内」）。

- 正在跑的进程往这个流里追加，`api` 扇出成 SSE；前端订阅。
- 刷新页面 = 重读日志 + 按 `seq` 续订（`Last-Event-ID` 语义），因此**不丢事件、可回放**。
- **读侧容忍坏行**：写一半的 JSON、空行、手工编辑出的脏数据只跳过该行并 WARN，其余事件按原顺序全量读出——一行坏绝不让整段历史消失或抛解析异常（日志抽屉的可用性优先于数据完备性）。
- 服务重启时，把仍处 `running` / `preparing` / `judging` 的行标记 `interrupted`（F10）。
- **只有 `resetEvents` 会清空**，而它只有一处调用点：候选阶段开始新的尝试时（`runRowAttempt`）。重新评分**追加**事件、不清空（§5.3.2）。
- **评分智能体的输出也进这一条流**，每行 `text` 带 `[评分智能体] ` 前缀（`summary` 不戴）——抽屉是一条连续时间线，往回滚时只有前缀能分清哪几行是评委说的。
- 事件与快照同源：`setRowStatus` 成对落「`status` 事件 + `run.json` 状态」。
- **`log` 是唯一带「给人看的一句话」的事件**：`summary` 由适配器按 §5.6.9 的词表发下来，缺格 = 这一条没有可说的事。消费方的读法固定（§5.6.9）：有 `summary` 用它、否则用 `text`，但机器负载与空串不算消息、保留上一句；`text` 原文照旧逐字进原始输出面板，两格不许互相顶替。
- **跑动期用量能不能回写快照，由事件自己说**：`usage.tokensBasis` = `'reported'`（厂商上报的权威值，与终值同口径）时才写 `run.json`；`'estimated'`（我们的跑动期估算，例如 claude 按 assistant 消息累加）**只走事件流给界面看，绝不回写**——快照是唯一落盘真相，把估算写进去会让「崩溃 / 被终止的行」看起来像采到了计量。这一格**可选**（契约里 `tokensBasis` 只是 `.optional()`，**不补 schema 默认值**），**缺省（含老事件缺格）按 `'estimated'`（安全侧）处置**——判据落在编排层的回写段（非 `'reported'` 一律不写快照）；它只描述 `tokens` 那一格，回写判据也只作用于那一格——`turns` 与两格子智能体分量**恒回写**（它们只有权威形态，没有估算形态）。去重判据（与上次**同一个三元组 + `turns` + `timing` + `turn` + 两格分量 + `tokensBasis`** 逐字段相同就不发；`reasoningOutput` / `total` 今天不在判据里，见 §5.6.3 的缺口登记）**必须含 `tokensBasis`**：两个数值恰好相同时，「估算 → 权威」仍是一次真实变化，而那是消费方唯一能拿到权威值的时机。

### 7.5 子智能体用量与轮次

**口径（行级三格）**

| 项 | 口径 |
|---|---|
| 范围 | 候选**自己派发的全部子智能体**（claude `Task` / dsh `subagent` / codex 派发的子线程），**含嵌套** |
| 不含 | **评分智能体**（`judgeRowByAgent` 那个独立的会话）——它报的是评审者的成本，与「这个候选多省」是两件事；候选阶段结束即冻结 |
| tok | `input + output` 的**全树**合计（主会话 + 全部子智能体） |
| 缓存命中 | 由全树三元组派生 `cached / (input + cached)`，不新增采集字段 |
| 轮次 | **主会话轮次 + 各子智能体轮次之和**（「一次模型 API 往返」是唯一单位）：合计在 `turns`，**子那一份单列在 `subagentTurns`** |
| 耗时 / 得分 | 不动（耗时仍是候选那一段的墙钟，子智能体的时间本来就在其中） |

**契约**

```ts
/** 子智能体那一份用量（主会话之外）；null = 没采到（含这家没有子智能体通道 / 这一行还没跑完） */
subagentTokens: { input: number; cached: number; output: number } | null
/** 子智能体那一份轮次；null = 没采到（含「有任何一个子智能体读不出轮次」） */
subagentTurns: number | null
```

- `{0,0,0}` / `0` = **确实没有子智能体**；`null` = **没采到**。两者必须长得不一样（与全仓 `null ≠ 0` 的硬口径同源）；**在契约与日志里承重**，在界面那一行浮层里不承重（见末段）。
- **「全量或 null」是硬规则**（四档）：

  | 情形 | 分量 | 合计 |
  |---|---|---|
  | 没有子智能体 | `{0,0,0}` / `0` | 主会话（全树恒等式仍成立） |
  | 有子智能体且**一个都没读失败** | Σ 各子（仍在跑的那个算「到目前为止」） | 主 + Σ |
  | 有子智能体但**子线程树不是全量**（codex 只有**枚举失败**这一档：单条线程 `thread/read` 读不到只少内容，分量与轮次分量照给） | `null`（**三家一致** ⇒ 界面一律退回一行） | **读盘拼合计的那两家**（codex / claude）退回主会话口径；**dsh 不退**（它的合计是逐条累加的流水，已经并进来的子会话用量退不回去——把已收到的丢掉等于让卡片**少报**） |
  | **合计自己也拿不出来**（主会话一次往返都没数到） | `null`（**与合计同生共死，不留孤儿分量**） | `null` |

- 三家的**共同保证**因此落在两条上：① 分量一律 `null`（界面据此一律退回一行）；② **恒有 `subagentTokens ≤ tokens`（逐格）与 `subagentTurns ≤ turns`**。
- 「读失败」= **读不到**（数据不在、格式读不动），**不是**「它还在跑」——跑动期的数本来就是「到目前为止」；而一个已经收场却读不出用量的子智能体是**事实缺失**。
- **「全量或 null」与「点名 WARN」是同一条硬规则**，但它只管「**因读不到而** `null`」那一档：`null` 时必须点名（列出读不出的那些子智能体），否则会出现「结果是 `null`、日志里点不出人」。**孤儿档（合计自己也拿不出来）不补 WARN**——那一刻没有「谁没报」可言。`null` 的判据与用量那一格**同一份**（不另造第二个谓词）。
- **`null` 与「缺键」必须分开**（三处 write site 逐字适用：投影折叠、收尾折叠、`patchRow`）：**显式 `null` = 「明确没采到」⇒ 清**；**缺键 = 「本条不带」⇒ 保持**。
- **运行期是否交出分量由各家的合计口径决定**：运行期 `turns` 已是全树（dsh）就同刻交；运行期 `turns` 只有主线程（codex / claude）就**不交**——交出去会立刻破坏 `subagentTurns ≤ turns`（真机形状：主线程 1 轮派活、子线程跑 5 轮 ⇒ 界面按「主会话 = 合计 − 分量」算出**负数**）。**终态值必须齐**：`finalTurns = lastTurns + subagentTurns`，`finalTurns === null` 时分量也必须是 `null`。
- 老 `run.json` 没有这两格 ⇒ contracts 用**可选格**（与 `attempts` / `effort` / `stage` 同一条处置）。
- **恒等式只对「主会话读数」成立**：`subagentTokens ≤ tokens`（逐格）的成立前提是这一条 `usage` 事件的主会话身份（`turn` 缺省 / `null` / `subagentId === null`）。带非空 `subagentId` 的读数是**该会话自己**的累计（dsh 的子会话读数给的是**全树**累计），两者不同尺，**不许相减**——「读数口径跟着 `turn` 走」是这条不变式的另一半。
- **`UsageTokens` 还有两格与全树口径无关**（都在三元组之外，采不到一律 `null`、绝不填 0）：`reasoningOutput`（思考 token，三家原文分别是 `output_tokens_details.thinking_tokens` / `reasoningOutputTokens`（SDK 时代旧称 `reasoning_output_tokens`）/ `reasoningTokens`；它算不算 `output` 的一部分三家口径不同 ⇒ **不要加进 `output`** 去算成本，只按它自己展示）与 `total`（厂商自报的总量原文，**不参与**归一后的恒等式，唯一用途是排障时并排看出「是厂商口径不同」还是「我们读错了字段」）。
- 传播链（一站不缺，缺一站界面就看不到）：`TurnProjection.subagentTokens/subagentTurns` → `usage` 事件 → `AgentRunResult` → `EvalRow` → `RowLiveMetrics` / `LiveMetricsView` → `MetricLine` 的第二行 Tooltip。

**三家取数**

| 家 | 子那一份用量 | 子那一份轮次 |
|---|---|---|
| dsh | Σ 本行**子会话白名单**的 `sessionUsage[id]`（`sessionUsage` 是模块级表，主会话之外还有**别的行**的会话 ⇒ 必须按白名单才与行绑定） | Σ 白名单的 `step/start` 计数（**与合计同一个计数点**：`noteDshSessionTurn` 就写在 `state.turns += 1` 的同一处、同一张模块级表的另一张表、同一个清空口）；两格由同一条事件驱动 ⇒ `subagentTurns ≤ turns` 是**构造上的** |
| codex | 运行期 `thread/tokenUsage/updated` 通知按**线程**累计（协议没有「按线程读用量」的请求 ⇒ 只能边跑边攒） | Σ 各子线程的**模型答复条目数**（与主会话同一把尺 `threadRoundTrips`） |
| claude-code | 读 CLI 转录目录，按 `message.id` **去重后**逐格求和（同一往返会按内容块出现多次、第一条的 `output_tokens` 是 0 ⇒ 不去重会双计 input / cached） | 同一份转录里 `message.id` 去重后的**个数**（**与用量同一次读盘**） |

**dsh 的三段出口**：分量在带分量的三条事件出口（`step/start`、`assistant/message`、`turn/end`）上**一起交两格**（否则会出现「上一版的非零用量分量 + `null` 的轮次分量」两句互相矛盾的话摆在同一格上）；**收尾也交一次**（子会话收场却没用量这个结论是在**不带轮次**的 `subagent.finished` 上成立的，那一轮之后再没有消息时结论就送不出去）。`null` 时**必须点名**（WARN 列出「已收场却没有用量事件」的子会话 id）；`{0,0,0}` / `0` 那一档**不刷噪声**。累加**没有去重键**：唯一的去重是 `usage` 事件的发射门（与上次逐字段相同就不发），它只决定「要不要发这条事件」，不改已累加的值。

**codex 的取数面**：子线程树由协议**一次**取回——`thread/list{ancestorThreadId}` 拿该线程的**任意深度**后代（分页每页 100 条），深度与昵称取厂商声明里的 `source.subagent.thread_spawn`，子线程名与父链因此是**厂商给的**，不是我们从事件流里猜的。**这里没有深度 / 条数上限**（协议一次给全树，不需要「递归发现 + 到量截断」那种预算；一旦有人为了性能加回上限，必须同时保证「被砍掉分支 ⇒ 分量整格 `null`」，不拿部分和冒充总数）。两条边界：**不扫盘**（不读 `rollout-*.jsonl`、不解析文件名），也**不需要「从事件流发现派发者」那一层**（事件流只能看到它点名的那一层，而协议能直接给出全树——派发者是谁、跨了几层，都由厂商的 `thread_spawn` 与 `ancestorThreadId` 回答）。任一子线程缺用量 ⇒ 分量与轮次分量**同时** `null` + 点名 WARN（分量与它所属的合计必须同刻、同尺）。

**claude 的读取（`subagent-usage.ts`）**：路径 `<configHome>/projects/<项目目录>/<sessionId>/subagents/agent-<agentId>.jsonl`（`sessionId` 来自 `system/init`；**采不到就不猜目录**——猜错会把别的会话的转录算到这一行上）。**单个文件的读数规则**：逐行 JSON；半截行 / 坏行跳过（CLI 边跑边写，这是常态）；只认 `type === 'assistant'`；按 `message.id` **去重、后到覆盖**；三项（`input_tokens` / `cache_read_input_tokens` / `output_tokens`）缺一，或认得是 `assistant` 却拿不到 `message.id` ⇒ **整份文件作废**（跳过会让那一次往返从合计与轮次里一起消失）；一条可用记录都没有（空文件 / 被中断在半截）⇒ 同样作废。**聚合（读取集 = 目录里枚举出来的转录 ∪ 事实核对名单）**：盘上有就必须读（转录比事件流更硬），名单里有就必须读得动；**有任何一个进 `missing` ⇒ 两格一起 `null`** + 一条**点名** WARN（读到的那些**不进合计**）。**形状判据（决定谁进名单）**：`subagent_type` / `spawn_depth` / `prompt` **至少一格非 `null`**（`''` 与 `0` 都算「给了」——判严了会把真派发判成幻影，比多一条幽灵行更坏）；判决**只在 `start` 帧上做**（**收场帧不承载形状证据**：审计投影只在 `start` 相位写那三格、CLI 的会话转录里根本没有 `task_*` 帧；逐帧判 = 拿一个不承载证据的帧去判 ⇒ 每个真派发的收场帧都被判成幻影），收场帧按**同一个 id 追随** `start` 帧的判决。三档：幻影（三格全空）**不产行**、**不进名单**；**只见到收场帧**的 id **照产行**（丢一个真派发比多一条幽灵行更坏）、**不要求它有转录**、两格照算，但盘上没有它的转录时落一条**不叫它子智能体**的 WARN（「…没有转录：这一行的 tok / 缓存命中 / 轮次可能少算它（无法判定它是不是子智能体）」）；**「确实没有」的出口**：会话目录不存在、或目录里一个转录都没有且名单里也没有形状像派发的 id ⇒ `{0,0,0}` / `0`。**读取实现**（逐行读在 `agents/src/read-lines.ts` 的 `readLines`，**今天只有 claude 这一条读盘路径用它**——codex 取数只走协议，不扫盘）：**同步分块流式读**（`openSync` + 64 KB `readSync`，**不许** `readFileSync` 整份 ⇒ 峰值内存从「整份 + 行数组」降到「最大单行 + 一块」；**只在换行字节 `0x0a` 处切块**，所以跨块的多字节字符永不会被截断，切完再 `toString('utf8')`——**没有 `StringDecoder`**；**必须同步**——`finalize` / `project` 都是同步钩子，改异步要动钩子签名并波及另两家）；**同版本不重复解析**（给「路径 + size + mtime」加一个 **run 作用域**的小缓存，不是模块级：避免跨 run 留大对象；收尾那一次读取**仍然真读**）；**两个读出口共用同一个缓存**（子任务条那一格与收尾合计各只 open 一次）。**读数时机**：子智能体的转录**只在收尾读一次**（终态通知那一帧只登记记录，**不读盘**），且 `rememberSubagent` 连**派发帧**（`running`）一起登记（终态优先）⇒ 没有终态通知的子智能体（CLI 没投送终态通知 / 运行被中断）在收尾那批里也有它。**不发逐轮读数**：事件流里 `turn.subagentId` 恒 `null`。

**界面（`MetricLine` 的 Tooltip）**：只在**真有分量**时画第二行，主会话那一行由**相减**得出（`tokens − subagentTokens` / `turns − subagentTurns`，派生而非第二份真值）。

| 格 | 画第二行的判据（缺一条就退回改动前那一行） |
|---|---|
| tok（`缓存命中` 是派生值、不挂浮层） | 分量**在**（不是缺格）、三项之和**> 0**、且**逐格 ≤ 合计**。即便不拆也有一行「输入 … · 缓存 … · 输出 …」可讲（合计本身） |
| 轮次 | 分量**在**、`> 0`、且 `≤ turns`。**没有分量可拆时连浮层都不出现**——这一格只讲「怎么拆」 |

- 卡片正文仍是合计那**一个**数，不因拆分改口径。
- **`{0,0,0}` 与 `null` 在这一格上渲染逐字相同（都只有一行）**：两者的区别在**契约与日志**里承重，界面这一格回答的是「子那一份怎么拆」——没有可拆的东西时，两种情形要画的本就是同一行。
- **`≤ 合计` 是纵深防御**：一份老 `run.json` 或一次将来引入的缺陷都会以「两行自己都不自洽」的形式出现在用户面前，而那种画面看起来完全正常。
- **浮层类否定面的断言必须等满延迟窗口**（antd 的 `mouseEnterDelay` 默认 0.1 s，悬浮完同步查 `.ant-tooltip` 在任何实现下都为真）⇒ 用 `expectNoTooltip()` 助手，不要同步断言。

**已知边界（如实登记）**：**codex 的「有子线程没报用量」这一档与上面那张表不一致**（2026-10-08 逐行核对）：`usageOfRun` 把分量判成 `null`，但 `finalTurns` 仍由 `mainTurns + Σ子线程轮次` 算出、**合计照样交出去**，于是 `subagentTurns: null` 与 `turns: <全树>` 同时落进快照——既不是表里写的「合计退回主会话口径」，也破了「分量与合计同生共死」的对称性（**这是代码与口径的偏差，不是设计口径**；要么把 `finalTurns` 的判据收成「子那一份读失败 ⇒ 合计也交 `null`」，要么承认「合计可以是全树、分量未知」并改本表）。**同一族的第二处在 tokens 那一格**：主线程没报用量、子线程报了时，`addUsage(null, sub)` 返回 `null` ⇒ 合计 `null`，而 `subagentTokens` 仍被交成非 null（claude 侧有显式守卫，codex 没有）——与本节「合计自己也拿不出来 ⇒ 分量与合计同生共死」那条正相反。dsh / codex 的 `{0,0,0}` 带前置条件——codex 的子线程树来自 `thread/list`，路由拒绝命名空间工具 / 关闭多智能体 / CLI 换形状时它会为空 ⇒ 它说的是「**本次没观察到**」，不是对事实的证明（文案**应当**写「本次未观察到子智能体」而不是「确实没有」；⚠️ 这句文案**当前没有落点**——界面在 `{0,0,0}` / `null` 时只画一行合计，不产出任何说明，风险登记见 `2026-10-01-agent-message-spec-design-v3.md`）；claude 的**嵌套**子智能体若转录落在别处（不在同一个会话的 `subagents/` 里），既不在目录里也不在名单里 ⇒ **既不进合计、也不会被点名**（「部分和冒充总数」那一半已关闭，「看不见」这一半仍开着）；codex 的子线程轮次可能少 1（方向是**少计**：只有一个外层用量记录的线程会漏一轮）。

---

## 8. 路由与前端接入

本阶段新增的 Route Handlers（每个只做「zod 校验 → 调 api → 错误映射」）：

```
api/
├── settings/route.ts                                    # GET 读 / PUT 打补丁（界面主题 + 评分配置 + 工作区；**脚手架期已有**，本阶段只扩了 settings 的字段）
├── providers/route.ts
├── providers/[providerId]/route.ts
├── providers/[providerId]/models/route.ts               # POST 加一条 / DELETE 删一条 / PUT 窗口与输出上限
├── providers/[providerId]/models/fetch/route.ts         # POST 拉取并合并
├── cases/route.ts
├── cases/[caseId]/route.ts
├── cases/validate-repo/route.ts                         # 按仓库路径入参（创建时还没有 caseId）
├── cases/commits/route.ts
├── cases/generate-judge-prompt/route.ts                 # 生成 / 识别评分标准项（按 prompt 是否为空分派）
├── runs/route.ts
├── runs/model-options/route.ts                          # 候选池 + 元数据（§5.1）
├── runs/[runId]/route.ts                                # GET / PUT 改 / DELETE 删（§5.3.3）
├── runs/[runId]/start/route.ts
├── runs/[runId]/abort/route.ts
├── runs/[runId]/rows/[rowId]/abort/route.ts
├── runs/[runId]/rows/[rowId]/retry/route.ts             # 单行执行（§5.3.1）
├── runs/[runId]/rows/[rowId]/rescore/route.ts           # 重新评分（§5.3.2）
├── runs/[runId]/rows/[rowId]/diff/route.ts              # ?offset/limit 索引 · ?file= 单文件（按需算，不预先落库）
├── runs/[runId]/rows/[rowId]/stream/route.ts            # SSE：§7.4 的八种事件（状态 / 日志 / 系统层 / 用量 / 改动摘要 / 评分 / 错误 / 结束）
├── runs/[runId]/rows/[rowId]/log/route.ts               # 一次性拉全量日志（抽屉首帧 + 下载）
├── runs/[runId]/rows/[rowId]/messages/route.ts          # 内容级消息的落盘快照
└── runs/[runId]/rows/[rowId]/messages/stream/route.ts   # 内容级消息的 SSE 流（与事件流并行的第二条流）
```

`stream` 是**行级事件流**的唯一实时通道，承载 §7.4 定义的全部事件类型；内容级消息另有一条并行的 SSE（`messages/stream`，与事件流是两条独立的流，口径见 `docs/superpowers/specs/2026-10-01-agent-message-spec-design-v3.md`）。

| 页面 | 数据来源（`client` 包的 hooks） |
|---|---|
| `/cases` | `useCases()` / `useTestCase(id)` / `useCreateCase()` / `useUpdateCase()` / `useDeleteCase()` / `useValidateRepo()` / `useCommitCandidates()` / `useGenerateRubric()` / `useProviders()` / `useSettings()`（后两条一起判「评分模型是否已配」） |
| `/runs` | `useRuns()` / `useRun(id)` / `useCreateRun()` / `useUpdateRun()` / `useDeleteRun()` / `useStartRun()` / `useAbortRun()` / `useAbortRow()` / `useRetryRow()` / `useRescoreRow()` / `useRunModelOptions()` / `useRowDiffIndex()` / `useRowDiffFile()` / `useRowLog()` / `useRunLiveMetrics({ runId, rowIds })`（逐行实时指标叠加层）/ `useRowMessages({ runId, rowId, enabled })`（内容级记录）/ `useCases()` / `useSettings()`（用例下拉与「未配默认评分智能体」的内联提示） |
| `/runs`（实时） | `useRowStream({ runId, rowId, enabled })`：SSE 订阅，按 `seq` 续订 |
| `/settings` | `useSettings()` / `useProviders()` / `useCreateProvider()` / `useUpdateProvider()` / `useDeleteProvider()` / `useProviderModels()` / `useFetchProviderModels()` / `useRunModelOptions()`（评分卡的智能体协议与档位域投影）/ 模型能力走 `useProviderModels().setContext`／工作区校验复用 `useSettings().update`（打 `PUT /api/settings`，不单独开 hook） |

**每行的操作入口各一个 hook**（判据同一份来自 contracts，界面与服务端都靠它）：`useRetryRow` → `POST …/retry`，`useRescoreRow` → `POST …/rescore`，两者成功后 `mutate(runKey(id))` + 刷新列表。`useRowDiffIndex` / `useRowDiffFile` 的 key 在「不启用」或路径为 `undefined` 时传 `null`——**一个请求都不发**，这就是「滚动到才加载」的开关。

**SSE 订阅 hook 的行为要求**：

1. 首帧先拉 `/log` 补全历史（抽屉打开时才有必要），再带 `?afterSeq=<已交付的最大 seq>` 接 `/stream`（断线重连由浏览器带 `Last-Event-ID`，服务端按「头 > query」取用）；
2. 断线自动重连（浏览器 `EventSource` 自带，但要处理重连后的事件重复——按 `seq` 去重）；
3. 行进入终态（`judged` / `failed` / `timed-out` / `canceled` / `skipped` / `interrupted`）后关闭连接并 `mutate` 一次快照，确保列表状态与日志一致。

**列表页的实时性**：`/runs` 列表用 SWR 的 `refreshInterval`（有评测在跑时 3 秒一次，否则关闭）。逐行 SSE 分两路开关：**实时指标**那一路由 `useRunLiveMetrics` 为**在跑的行**各开一条连接（与抽屉是否打开无关），**日志**那一路只在该行的日志抽屉打开时订阅（`useRowStream` 的 `enabled`）；两路的行集合都由「当前选中的这一轮」圈定，所以不会为每个评测都开出几十条连接。

---

## 9. 测试

| 对象 | 测试 |
|---|---|
| `core` 的 git 原语 | **真实 git CLI**，禁 mock（mock 掉的正是最容易错的地方）：校验仓库、`rev-parse --verify` 判定 commit、克隆缓存、文件系统级复制、建分支、三样 diff 合并 |
| 测试环境隔离 | 用临时目录的测试在 `beforeEach` 调 `setConfigDirForTesting(tmp)` 并断言 `getConfigDir()` 指向它——git 测试跑真实子进程，任何一处顺手 `loadConfig()` 都会覆盖用户 `~/.aieval` 里的供应商与明文密钥；夹具仓库的 `git commit` 一律带 `-c user.email / user.name`（CI 与新机器没有全局身份时 commit 直接失败） |
| 三样 diff 合并 | 用例覆盖：只有已提交改动 / 只有未提交改动 / 只有未跟踪新文件 / 三者都有 / 全空。**「只取 `commit..HEAD` 会漏掉未提交改动」必须有回归用例**；合并输出的边界由「全空」与「文件名里含 `diff --git `（切分点只看行首）」两条钉住（切分函数 `splitNumstatPatch` 是模块私有，没有单测直连它） |
| 远端镜像 | 见 §4.5 的守卫清单（真 git + `file://` 夹具，不需要网络） |
| 适配器 | 用假实现（**随本阶段的适配器一起建**：`agents/src/testing/agent-fixtures.ts`（假厂商 SDK 流与 `createRunInput`）与 `evaluator/src/testing/fixtures.ts` 的 `fakeAgents`，脚手架期那两个包只有 `export {}`）：产生确定的日志流、用量、退出码。**完整口径见 §5.6.8**——注册表与协议元数据、三家注入参数、凭据隔离的正反两面、未识别事件不丢弃、计量缺失得 `null` 而非 0、释放顺序与幂等、加载降级、结构化输出的降级 |
| 评分解析 | 按引用键逐项对齐：缺一项即失败（点名是哪一项）、多余判定忽略、重复键取第一条、`achieved` 宽容读的每一个词、围栏剥离只剥整段。**缺一项必须 `failed` 而非按缺项算平均** |
| diff 裁剪 | 超 `diffBudgetBytes` 时按文件裁剪，且输出里含「已截断」标记与被截断文件清单；**永不切半个文件**；预算小于单文件（甚至小于段落头）时仍保留段落头与截断标记，**绝不产出看起来像没改动的空文本**（`truncated` 必须为 `true`） |
| 编排时序 | 串行下断言「同一时刻只有一个 adapter 在跑」；并行下断言「全部同时启动」；终止时断言 `canceled` 与 `skipped` 的划分正确 |
| 单行执行 | 三行串行夹具：只跑中间那一行，逐字比对另外两行（见 §5.3.1） |
| 重新评分 | 事件追加不清空、入口区失败可整体回退、终态复检（见 §5.3.2）；`attempts` 不递增**当前没有专门用例**（行为成立只因 `rescoreAttempt` 不走 `runRowAttempt`，那里才是 `attempts + 1` 的唯一落点） |
| 修改与删除 | 只改执行模式 ⇒ 全行不变；改某行 ⇒ 只有那一行重置；换用例 ⇒ 快照重取 + 全行重置；删行 / 未知 id ⇒ `NOT_FOUND`；删除顺序与 `workspaceRemoved`（见 §5.3.3） |
| 工作区隔离 | 串行模式下断言每行工作目录互不相同（**防回归到「共用目录」这个致命错误**） |
| 服务重启恢复 | 启动时把 `running`/`preparing`/`judging` 的行标 `interrupted`，且不误伤终态行 |
| 拉模型合并 | `fetched` 结果不冲掉 `manual` 条目，也不打回手工改过的窗口；档位与窗口在同一段合并，但**窗口的手工覆盖是否顺带护住档位今天没有守卫**（实现是 `pickWindow` / `pickEfforts` 两条分开的路，见 §5.1.1） |
| 评分强度 | **文本侧**三档 × 两协议 × 未指定（`text-api.test.ts`，六条走单轮 + 一条多轮）：请求体里**有且只有**该有的键；**两条通路各一档**（含未配置的两条反面）：**智能体侧**透到 `run` 的 `effort`、**文本侧**透到评分器入参 `judgeEffort`（文本通路没有 `run`）；**智能体那两条**另外钉了落盘的 `score.judgeEffort` 与配置一致（文本两条经假 `judgeRow`，落盘值不在断言面内）；`requireJudgeEffort` 越域 / 空串 ⇒ `CONFLICT`（见 §5.5.2） |
| 评分花销 | 文本侧 = 各轮成功调用**求和**（上游没报用量的那一轮不加，也不当成 0）+ 从进 `judgeRow` 起掐表；智能体侧 = 适配器自报的 `result.tokens` / `result.durationMs`；没采到 ⇒ 两格 `null`（**不写 0**），老记录读回 `null`（见 §5.7） |
| 评分终止 race | 适配器**不响应 abort** 时：用户点终止 ⇒ 那一行在有限时间内收场（`Promise.race` 赢在 `terminalReached` 一侧）、状态保持 `canceled`、迟到的分先落一条 `[已终止的尝试]` 日志再发一条 `score` 事件（不写回行）；孤儿 promise 已挂 `.catch`（不许出现 unhandledRejection） |
| 工作区校验 | 探针写入失败（用例把 `writeFileSync` 打挂成 `EACCES`，代表磁盘满 / 无权限 / 路径过长；Windows 上真文件系统造不出来）/ 路径被同名文件占住 / 空串 → `NOT_WRITABLE` + 具体原因（含失败路径） |
| 用例删除 | 已完成的评测记录保留，`caseTitle`/`repoPath`/`commitHash` 快照仍可读（`rubric` 快照另有创建期守卫，见 `runs.test.ts` 的「创建评测时把用例的评分表快照进这一轮」） |
| 子智能体分量 | 见 §7.5 的契约（「全量或 null」）、「三家取数」与末段「已知边界」三处 |

### 9.1 墙钟：进程创建预算

**计价单位是「进程创建」**（本机 i7-1260P / Windows 实测）：`cmd /c exit 0` **162 ms**、`git --version` **566 ms**、`node --version` **530 ms** —— 企业 DLP/EDR 在每个新进程上挂钩（Defender 实时防护是**关**的）。由此推导：`initFixtureRepo`（6 次 git：init / config ×2 / add / commit / rev-parse）≈ **1612 ms**、本地 `git clone` ≈ **1053 ms**、`git status` ≈ 251 ms。

**三条推论**：墙钟不是「所有测试之和」，而是「**最长的那个文件**」（vitest 按**文件**并行、文件内**顺序**执行）；**失败比成功贵一个数量级**（守卫上限按「宁可超时也不假红」定，条件一旦不可能成立就把预算烧完）；**并发不是免费的**（十几路 worker 抢同一条进程创建管道时每次 spawn 都更贵）。

**测试侧**

1. **守卫 fail-fast**：`until(condition, label, timeoutMs, impossible?)` 的第 4 个可选参数每轮先问「条件已经不可能成立吗」，成立就**立刻带诊断抛错**（消息同时给出「等的是什么」与「为什么不可能」）。**上限一个都不改**；`impossible` 的判据取自被测对象自己的终态，不新造语义；**只给终态期望的等待接 `impossible`**（落成别的终态就是真失败），同步点式的等待刻意不接（避免把「错过观察」判成假红）。
2. **长杆文件按 describe 拆开**：`orchestrator.test.ts` 曾是一个 2500+ 行、86 条用例的文件（独占一个 worker 顺序跑完全程，墙钟被它钉死），现拆成 18 个 `orchestrator-*.test.ts`（其中 `orchestrator-live.test.ts` 是拆分前就有的另一个文件；`static-assertions.test.ts` 的条数绊线按 **17** 个「拆分文件」计数）+ 共享 harness `evaluator/src/testing/orchestrator-harness.ts`（导出 `until()` / `seedRunnableRun()` / `makeWorkRepo()` / `makeBareRemote()` / `TEST_TIMEOUT_MS` 与事件读取、cwd 断言小工具；用例缓存的预热 `prewarmCaseCache()` 是 harness 私有函数，由 `seedRunnableRun()` 在 `commitHash !== null` 时内部调用，**不对外导出**）。
   **`vi.mock` 必须在测试文件自身里调用**（vitest 只对它做前置提升）⇒ 每个新文件保留一段固定的三行前置块。**这是本设计唯一的静默失效路径**：漏写 `@aieval/agents` 的 mock 会让测试**真的去 spawn 厂商 CLI**。防它的守卫落在 `evaluator/src/static-assertions.test.ts`：逐个读取这些编排测试文件，断言每个都含三条 `vi.mock(` 注册（外加一条条数绊线，新增文件忘了登记也要红）。
3. **夹具减 spawn**（两件独立的事，各自可单独回滚）：**仓库模板**——harness 的 `beforeAll` 建**一个**模板仓库（`initFixtureRepo` 一次），每条用例 `cpSync` 一份到自己的 `home.root/repo-<uuid>`（纯文件系统）；**用例缓存预热**——`beforeAll` 克隆**一份**模板缓存，每条用例把它 `cpSync` 到 `caseCacheDir(...)` 并写 `.git/aieval-origin.json`。预热**只对钉死 `commitHash` 的用例**做：`commitHash === null` 的语义是「跟随来源 tip」（走 `refreshCacheToSourceHead → fetch origin`），预热出来的缓存 `origin` 指向模板而不是该用例的仓库，语义会漂。
4. **跑法分层**：`test:changed`（`vitest run --changed`）进 `package.json`，内循环用它；`test` 仍是门禁口径。**不新增**「跳过重文件」的假门禁，**不删用例、不加 `skip`/`todo`、不用 `--changed` 冒充门禁、不改 `expect` 的强度、不放宽任何守卫上限**（要的是「失败得早」，不是「等得久」）。
5. **并发度**：不为 vitest 写死 `maxWorkers`——实测四档（6 / 8 / 12 / 15 路）在噪声内、且默认档最短，写一个魔数只会多一处要维护的配置；**命令行参数永远赢过配置文件**，需要临时改并发就直接在命令行给。机器带负载时的跑法是 `pnpm vitest run --maxWorkers=6 --testTimeout=150000 --hookTimeout=150000`，且**先看 `tests` 累积项**——比上次大 2 倍以上就别把红当成回归。

**产品侧：合并 git 往返**（`core/src/git.ts`，输出逐字节等价）

| 现状 | 目标 | 判据 |
|---|---|---|
| `diff --numstat HEAD` + `diff HEAD`（2 进程） | `diff --numstat --no-color -p HEAD`（1 进程） | 一次输出里 **numstat 块在前、补丁块在后**，退出码 0 |
| `diff --numstat base..HEAD` + `diff base..HEAD`（2 进程） | `diff --numstat --no-color -p base..HEAD`（1 进程） | 同上 |
| `cat-file -e <hash>^{commit}` + `rev-parse <hash>^{commit}`（2 进程） | `rev-parse --verify <hash>^{commit}`（1 进程） | 短 hash 归一到 40 位；blob → 非零退出；不存在的 hash → 非零退出 |

**解析设计**：合并输出按**第一条行首的 `diff --git `** 切成「numstat 段 + 补丁段」；numstat 段交给现有 `parseNumstat`，补丁段就是今天 `committed` / `uncommitted` 的取值。**错误面不变**：不使用 `--quiet`（它会吃掉 stderr），`gitMessage(error)` 仍能取到 git 原文，`ServiceError` 的 code 与中文原因的形状、`context` 字段一律保持。**不消除** `ensureCaseCache` 与 `checkoutRow` 对同一 commit 的重复校验（要改 `checkoutRow` 入参，属接口变更，收益 1 进程/行，不划算）。

**验证口径**：每条新守卫做变异验证（去掉 `impossible` ⇒ 红用例重新等满上限；删一行 `vi.mock` ⇒ 静态守卫红；把 diff 切分点改错 ⇒ `git-diff-collect.test.ts` 红（`git-diff-truncate.test.ts` 喂的是合成文本、走的是另一个 `splitDiffFiles`，改切分点不会让它红）；降级后仍把 `outputSchema` 交给 `start` ⇒ `agents/src/turn.test.ts` 的两条红（`providers/*/conformance.test.ts` 里那一格**今天没有探针**、是空转：`kit.ts` 的 `checkStructuredOutputGroup` 在 `probe === undefined` 时直接 `continue`，三家夹具都没挂 `structuredOutput`）；`tokensBasis` 恒填 `'reported'` ⇒ 估算不得回写那条用例红；文本支 `off` 不写 `thinking.disabled` ⇒ 请求体断言红）；拆文件后**用例总数只增不减**，且逐包核对总数与全量一致（漏收一整个包是静默漏测）。**墙钟的对比口径固定为三步**：改前基线 → 同一命令、同一机器、同一天的改后复测 → 墙钟对比表（含用例总数与红数）；只报墙钟不报用例总数与红数的对比**不算证据**（快可能是因为少跑了）。

**冒烟**（真实起服务 :3083，浏览器逐项操作 + CLI 复核 git 事实）：

1. 建两个供应商（一个 openai 协议、一个 anthropic 协议），拉模型；
2. 建用例：填标题、考题提示词、用「智能生成」产出一张评分标准项表、校验本地仓库、填 commit；
3. 建评测：选该用例、选**并行**、加 2 行（一行 Claude Code + anthropic 模型，一行 Codex + openai 模型）；
4. 点开始，观察两行同时进入 `running`，token / 轮次 / 耗时实时跳动；
5. 用 CLI 复核：两个候选行的工作目录里 `git branch` 确实有 `test/{rowId}`，`git diff` 结果与页面「变更详情」一致；
6. 出分后核对：卡片总分与「评分详情」里逐项判定一致，总分等于**达成项权重之和**、满分等于全部项权重之和；
7. 再建一个**串行**评测（3 行），中途点终止 → 断言当前行 `canceled`、未轮到的行 `skipped`；
8. 点开始 → 断言只跑未完成的行，已 `judged` 的行不重跑；
9. 故意把评分模型配成一个不存在的模型 → 断言该行 `failed` 且错误信息可读，其余行不受影响；
10. 设置页「思考强度」选 `max`（onChange 自动保存）→ 重新评分一行 → `run.json` 的 `rows[].score.judgeEffort === 'max'`（未被重评的行仍是 `null`），且「评分详情」顶部那一格与它逐字互证；清空该格 ⇒ `defaultJudge` 上的 `effort` 键**消失**（不是写 `undefined`）；
11. 跑一行 claude-code（它在跑动期只报**估算值**）→ 运行期快照的 `turns` **在涨**、`tokens` 仍为 `null`（`usage.tokensBasis = 'estimated'` 不写回快照）；评分结束后把「评分详情」顶部的评分用量 / 耗时与 `run.json` 的 `score.judgeTokens` / `score.judgeDurationMs` 逐字互证。

**成本护栏**：开发期用最小 diff 的仓库（几个文件的示例项目）与最短提示词做端到端验证；真实模型调用集中在第 3–11 项冒烟，不复跑。

---

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 代码来源非法（控制字符 / `-` 开头 / 非白名单 scheme） | 表单校验期拦截，`INVALID_QUERY` + 中文原因 |
| 仓库路径非法 / 不是 git 仓库 | 表单校验期拦截，`NOT_A_GIT_REPO` + 具体原因；**路径不存在时先报「不存在」、不去执行 git**（避免把 `ENOENT` 误报成「不是 git 仓库」） |
| 远端不可达（DNS / 连接超时 / 连接被拒 / 指纹未信任 / 拉取超时） | `REPO_UNREACHABLE`（400）；该行 `failed`，**绝不静默用旧镜像** |
| 远端认证失败 | `AUTH_FAILED`（context 带 host）；错误信息指向本机 git 凭据 |
| commit hash / 远端分支不存在 | 表单校验期拦截，`INVALID_REF`（远端会先 fetch 一次再判） |
| 供应商 `/models` 拉取失败 | 保留已手工维护的清单；`message.error` 呈现原因；不阻断保存（点名每一条试过的路径） |
| 供应商密钥无效 | `AUTH_FAILED`（context 带 host）；该行 `failed`，错误信息指向设置页 |
| 供应商限流 | `RATE_LIMITED`；该行 `failed`，错误信息建议改用串行 |
| 评分模型返回不合法 JSON | 该行 `failed` + `JUDGE_PARSE_FAILED`，保留 `raw` 原文，日志抽屉可见 |
| 评分缺项 / `achieved` 认不出 | 先回问模型（`JUDGE_REPAIR_ROUNDS = 2`）；仍不合格 → `failed` + `JUDGE_PARSE_FAILED`，错误点名是哪一项 |
| 评分标准项为空（满分 0） | 该行 `failed` + `CONFLICT`「这一轮用的评分标准项是空的，无法评分：这一轮的评分表在创建时就已快照，改用例不会影响它——请在用例里补上评分项后新建一轮评测」，评分器一次都不调用 |
| 智能体评分未配置 / 协议不兼容 | 创建与编辑时即拦（`CONFLICT`）；评分阶段再拦一次（配置可能被改过） |
| 评分配置里的思考强度越域 / 空串 | **评分（两条通路）**与**智能生成 / 智能识别**（共用一个入口）拦（`requireJudgeEffort` ⇒ `CONFLICT` + 指向「设置 → 评分配置」，文案点名该模型与当前评分智能体可选的那几档）；未指定放行；创建评测只校验候选行的强度，设置页保存不被阻止 |
| 评分智能体没回传最终答复 | `JUDGE_PARSE_FAILED`「该适配器未回传最终消息」；空答复另有文案 |
| 评分智能体改了工作区 | 拿到分 ⇒ 该行 `failed`（`AGENT_FAILED` + `stage: 'judge'`）；没拿到分 ⇒ 只留痕（真因优先） |
| agent 进程启动失败 | 该行 `failed` + `AGENT_FAILED`（如 CLI 未安装、`spawn ENOENT`） |
| 工作区根目录不可写 | 设置页校验期拦截，`NOT_WRITABLE` |
| 分支已存在（`test/{rowId}` 冲突） | 用 UUID 行 id 已避免；重跑同一行时 `git checkout -B <branch> <基线>` 把分支**原子重置**到基线（等价于先删旧分支再建），只记 INFO「行分支已建立」（不落 WARN） |
| 用例被删除但评测仍在 | 允许；评测靠冗余快照继续可读（§7.2）。**执行类动作是例外**（「开始」/ 单行执行 / 重新评分）：题面没有快照，用例不在即 `CONFLICT`（只可看、不可跑） |
| 评测正在跑 / 在途任务未收尾 | **编辑与删除**一律 409 `CONFLICT`（`hasLiveRows` + `assertRunMutable` 两层）；**单行执行不走这两层**：它只约束**这一行**（`isRunningRow` + `rowAborts` / `retryTasks`），本轮别的行在跑不拦（§5.3.1） |
| 服务重启打断评测 | 运行中的行 → `interrupted`（界面只显示状态标签「被重启打断」），可点「开始」重跑这些行（`isRunnableRow` 把它们算作可执行） |
| 配置文件损坏 / 带 BOM / 多出已废弃的键 | 由 `config-store` 处理（BOM 剥离；**读路径刻意不做 zod 校验**，`settings` 段多出的已废弃键由 `normalizeSettings` 按 `SETTINGS_DEFAULTS` 的键表丢弃，`providers` / `cases` 段原样读回；真损坏抛含路径的中文原因） |

---

## 11. 实施顺序

依赖脚手架完成（见脚手架设计文档的完成标准）。

1. **`contracts` 扩全**：Provider / TestCase / EvalRun / EvalRow / ScoreResult / **Rubric** / AgentEvent 的 zod schema 与本阶段新增错误码（含 `REPO_UNREACHABLE`）。
2. **`core` 扩展**：git 原语（校验仓库、`rev-parse --verify`、克隆缓存、文件系统级复制、建分支、合并后的 diff 往返、`extractDiffFile`）、工作区目录管理（含 `.judgehome`）、**远端镜像层**（§4.5）。
3. **设置域**：供应商 CRUD + `/models` 拉取（合并而非覆盖）+ 模型窗口与输出上限、评分配置（默认评分模型 + 思考强度 + 默认评分智能体）、工作区校验。**这一域先做**——用例的评分标准项生成与评测的评分都依赖它。
4. **用例域**：CRUD、代码来源（本地 / 远端）与 commit 校验、commit 候选下拉、评分标准项表格与「智能生成 / 智能识别」。删除 `/demo` 示例页，用例页接上真实数据。
5. **`agents`**：先做**原始事件探测**（三家各一条最小任务，dump 原始事件流，钉死计量字段名与「子智能体能不能读到」），再实现注册表（含 `protocolTypes` / `capability` / `reasoningEfforts` / `defaultEffort` / 消息能力）与三家适配器，并按 §5.6.8 补齐单测（假实现随本阶段的适配器一起建，见 §9）。
6. **`evaluator`**：编排状态机（并行/串行）、事件日志扇出、评分器与解析（含按引用键逐项对齐）、**两条评分通路**（含评分思考强度的两条落点：智能体侧透传、文本侧 `buildBody` 按协议注入）、单行执行与重新评分、评测的修改与删除、服务重启恢复。
7. **评测域**：创建（含「使用智能体评分」与思考强度）、列表 + 右栏详情、SSE 实时刷新、吸底操作栏、三个产物抽屉（含「变更详情」的分页与惰性加载）、编辑表单。
8. **冒烟与文档**：按 §9 的 11 项冒烟清单走完并留证，写使用手册。**假实现随本阶段的适配器一起建**（见 §9 表格的适配器行）。

---

## 12. 口径总表

无遗留待定项。下表是全文的决定性口径的汇总索引（细节以各章节为准）：

| 问题 | 结论 |
|---|---|
| 评分回路 | 两条通路，**每一次评分只用一条**：纯文本 API（评分表 + diff → JSON）或**智能体评分**（在该行工作区内自己查阅）。评分那一刻读轮级 `useAgentJudge` 快照（编辑可改，见 §5.5.1） |
| 得分形态 | **评分标准项**（组 → 项：ID / 目标 / 权重），每项二元判定 + 一句理由；总分 = 达成项权重之和，满分 = 全部项权重之和 |
| 评分者 | 全局默认（设置页）：**默认评分模型**（两种协议都可选）+ **思考强度**（可选，缺省 = 未指定）+ **默认评分智能体**（只在智能体评分通路上生效）。用例上没有覆盖 |
| 评分标准项 | 用例自定义（表格 + 智能生成 / 智能识别），**随轮次快照** |
| 并发 | 并行/串行**二选一**，创建评测时配置，默认**串行**；并行不设并发上限，每行**失败隔离** |
| 执行模式可否运行中修改 | 不可修改 |
| 时限 | **执行与评分都不限时间**，一行只因「跑完 / 失败 / 用户点终止」结束（代价见 F12） |
| 串行未轮到的行 | 新增 `skipped` 状态 |
| 仓库来源 | 本地路径 或 **远端 git 地址**（服务端自动镜像，裸镜像跨用例复用）；**不做凭据管理**，认证走本机 git |
| 产物 | 全量：执行日志流 + 变更详情（逐文件 + 惰性加载）+ 评分详情 |
| 单行终止 / 单行执行 / 重新评分 | 都要（判据分别是 `isRunningRow` / `canRunRow` / `canRescoreRow`） |
| 评测的修改与删除 | 都要；运行中不可改（`hasLiveRows`），删除分两步（先快照后目录） |
| 用例级缓存仓库 + 每行复制 | 要（F7；缓存目录见 §6.3） |
| 默认落地页 | `/runs` |
| 用例创建/编辑形态 | 可拖拽宽度的右边栏（不是抽屉、不是整页） |
| 工作区根目录 | 默认 `~/.runs`，设置页可配；`cases/` 与 `remotes/` 是它的另两个兄弟目录 |
| 应用数 | 单个 Next.js 应用，无第二个下游应用 |
| 适配器总体形态 | provider 注册表 + 薄投影；不做统一 IR、不做多轮 live 会话（§5.6.1 A1 / A4）；**包外只有 `getProvider(kind).run()` 一个入口** |
| 适配器结果契约 | 在 SDK 原语之上补评测语义：`cached` token / `turns` / `durationMs` / `exitReason` / `finalText` / 归一化事件 / **结构化输出**（A2；`applied.structuredOutput` 说明这一格实际有没有下发，§5.6.4） |
| 家数与协议对应关系的唯一来源 | 注册表元数据 `protocolTypes`（**集合**），**服务端四处**消费点都读它、且都走 `acceptsProtocol()` 这一个判据（设置页评分配置只读投影、自行判集合成员），不硬编码（A3） |
| 计量采集不到时 | 填 `null` 并按该家的能力显示「不支持计量」（`capability.usage === false`）/「未采集」（运行中写「采集中」），**不填 0**（§5.6.3） |
| 子智能体用量 | 行级分量单列（`subagentTokens` / `subagentTurns`），合计仍是全树；**全量或 `null`**，恒有分量 ≤ 合计（§7.5） |
| 释放顺序 | `interrupt()` → 终结在途 turn → `dispose()`，顺序不可颠倒；守卫按对象绑定且 `dispose` 幂等（A7 / §5.6.6） |
| 终止能力差异 | 注册表元数据 `cancelMidTurn` 表达；DSH 为 `false`（关运行时），界面文案需不同（§5.6.2） |
| 权限档 | 按**阶段**给（候选执行 = `'full'`、评分 = `'read-only'`），不做成配置项（§5.6.2） |
| 凭据注入方式 | 一律显式选项 + 替换型子进程环境，`process.env` 永不写入（A5） |
| 上下文窗口 / 思考强度 | 窗口是模型属性（可选、缺省未知 ⇒ 不注入）；强度是行级配置（可选、未选 = 不指定，关闭要显式选 `off`），候选 =（上游声明过 `supportedEfforts` ? 上游 ∩ 该家档位域 : 该家**完整档位域**）∪ 关闭档（§5.1.1） |
| 评分的思考强度 | 取 `settings.defaultJudge.effort`（可选，缺省 = **未指定**，不等于关闭）；两条落点：智能体侧照 `AgentRunInput.effort` 透传、文本侧按协议注入（`off` ⇒ `thinking: { type: 'disabled' }`，其它档 ⇒ `reasoning_effort` / `output_config.effort`）；档位域与设置页候选同源（`intersectEfforts`），越域在**评分（两条通路）**与**智能生成 / 智能识别**（共用一个入口）拦；创建评测只校验**候选行**的强度、设置页保存不被阻止，这一分用的档位记账在 `ScoreResult.judgeEffort`（§5.5.2） |
| 加第四家智能体 | 加 `providers/<id>/` 一个目录 + 注册表一行 + `contracts/src/agent.ts` 的 `AGENT_KINDS` / `AGENT_LABELS` 各一格（**id 的真源在 contracts**，参见 §5.6.2）+ **`permission.ts` 里共享的三家权限表补一份**（它不在 `providers/<id>/` 目录内，`permission.test.ts` 有一条守卫专挡「注册表加了、权限表没加 ⇒ 新那家静默吃厂商默认档」）+ 测试侧的 `Record<AgentKind, …>` 构造点（tsc 会拦）与厂商包白名单/依赖；编排层与表单不改（A3） |
