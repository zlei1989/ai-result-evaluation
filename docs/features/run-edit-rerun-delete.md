# 修改、重跑与删除评测

## 定位

创建之后的三个动作族：**改**（编辑整轮，被改的行原地重置）、**重跑**（两个出口——单行执行连候选 agent 带评分整段重跑、重新评分只重跑评分那一步）、**删**（先删快照再删目录）。行级判据全部集中在 contracts（`hasLiveRows` / `isSameRowTarget` / `canRunRow` / `canRetryRow` / `canRescoreRow`）：界面靠它决定按钮的 `disabled`、服务端拿同一份判据抛 `CONFLICT`——两处各写一份必然漂移，漂移的表现是「按钮可点、点下去 409」。内部名与文案的对应：按钮叫「重新执行」，内部名仍是 `retryRow` / `useRetryRow` / `/rows/{rowId}/retry` 路由（一次文案调整做全链路改名不划算，名字↔文案的对应记在判据的 JSDoc 里）。

与详情页吸底操作栏的「开始」相区分：「开始」执行**所有未完成**的行（`isRunnableRow`：`pending` / `failed` / `timed-out` / `canceled` / `interrupted` / `skipped`，**`judged` 不在内**——已经出分的行不该被一次误点重跑掉几十分钟）；「我只想跑这一个候选」由本文的单行执行出口表达。

## 页面形态与交互

### 编辑

- **入口**：评测详情卡顶部信息行的 `extra`「编辑 / 删除」（与用例详情逐字同形；两个汉字的按钮一律 `autoInsertSpace={false}`）。`hasLiveRows` 为真（轮级 `running` 或任一行 `preparing` / `running` / `judging`）时两个入口都 `disabled`；**原因只在「编辑」那一格有 `Tooltip`**——「有候选行正在运行：先终止，再编辑 / 删除」（「删除」被 `Popconfirm` 的 `disabled` 一并挡住，禁用态没有任何解释）；服务端同一判据抛 409，两层都有。
- **编辑表单复用创建表单**（`mode: 'new' | 'edit'`）：修改范围 = 用例 + 执行模式 + 使用智能体评分 + 候选行，与创建完全对齐；候选行可以带 `id`（表单必须能说清「这一行还是原来那一行」），`new` **显式剥掉 id** 再交给 `create`（新建对象、不动表单内部持有的行值），`edit` 原样交给 `update`；`mode` 与 `initial` 变更靠 `key` 重挂载（`initialValues` 只在挂载时读一次）；**整张表单取自 `initial`、尤其是执行模式**——少了它就会被表单缺省的「串行」盖掉，用户只改了个模型、执行模式却被悄悄改成串行。
- **右栏三态**：`?panel=detail|new|edit&id=…`（`parseRunsPanel` 认 `edit` 且必须带非空 id，缺 id 回落「不显示右栏」；未知 `panel` 仍按「有 id 就是 detail」兜底）；列表选中高亮放宽到 `detail | edit`；编辑成功 ⇒ `message.success('评测已保存')` + 回 `?panel=detail&id=`。
- **保存前的确认框**：用 `isSameRowTarget`、`caseId` 与被从表单里删掉的行三条判据算出会作废的行（只算「跑过」的：`attempts > 0` 或已处终态），**非空时** `Modal.confirm`（标题「保存后会作废这些行的已有结果？」，正文「保存后它们会回到「待开始」，已有的分数与产物不再显示：」后逐行列出 `agentKind · modelId · 原状态`）后才发 `PUT`；**只改执行模式 / 只改评分方式时什么都不作废、不弹**（无事发生却弹窗 = 噪音，弹多了用户就会闭眼点确定）。
- **原用例已删除**：「用例」下拉显示禁用占位项（「原用例已删除，请重新选择」），保存被服务端以 404 `NOT_FOUND`「用例不存在：`<caseId>`」拒绝，磁盘一字不改（与「开始」对同类轮次的处置一致：用例已删 ⇒ 只能看不能跑）。

### 重跑出口一：单行执行（连候选 agent 带评分整段重跑，只跑这一行）

- **一个按钮，文案按行态分叉**：没跑过的行 ⇒「开始执行」；跑过的行 ⇒「重新执行」；**正在首跑**的行（`preparing` / `running`，还没有基线）也显示「重新执行」——文案判据是 `canRetryRow(row) || isRunningRow(row.status)`，不是单纯的 `canRetryRow`（它确实已经跑起来了，显示「开始执行」会让人以为还没开始）。文案与确认框措辞都从同一判据派生：两处各写一份，必然出现「按钮写重新执行、确认框说首跑」的漂移。
- **可用面由 `canRunRow` 决定**（不在跑就放行，**含一次都没跑过的行**）：没跑过的行（`baselineCommit === ''` 或没有 diff）⇒「开始执行」= 这一行的首跑；跑过 ⇒「重新执行」= 整段重跑（两者同一条链路，只按行态换文案）。`canRunRow` 与 `canRetryRow` 是**单调关系**（测试里有一条守卫钉着）：能重新执行 ⇒ 必然能单跑，反之不然。误点的代价由 `Popconfirm` 拦一次，不由判据替使用者说不。
- **确认框 `Popconfirm` 标题与说明随行态分叉且必须点名范围**：首跑标题「开始执行这一行？」、说明「只跑这一个候选：本轮其他行（含已经执行过的行）都不会重跑。」；重跑标题「重新执行这一行？」、说明「候选 agent 与评分都会重跑：工作区会被重新准备，现有分数会被新的评分结果替换。只跑这一行，本轮其他行不动。」
- **本轮其他行在跑不拦单行执行**（`retryRow` 的互斥只针对这一行：`rowAborts` / `retryTasks` 防的是「两条执行同时改同一行的状态」）。
- **服务端放行判据分三级（顺序承重）**：该行在跑 ⇒ `CONFLICT`「请先终止它，再执行」→ `rowAborts` / `retryTasks` 里还有这一行 ⇒ `CONFLICT`「上一次的运行还没收尾，请稍候再试」→ `!canRunRow` ⇒ `retryRefusal` 收成一句**竞态兜底**（走到它只可能是「读快照时不在跑、落状态前那一拍它跑起来了」，带 `log.debug`）。按行态写不同的日志与事件标记（`[开始执行]` / `[重新执行]`）。
- `attempts` 照旧累计、不清零（重试重跑的是**同一件事**；与编辑重置刻意清零相反）。
- **唯一承重不变量：单行执行只动这一行**——本轮其他行的状态、分数、计量、diff、`attempts` 以及它们的事件日志与尝试账本逐字不变，串行队列不推进（守卫用三行串行夹具逐字比对另外两行的全部字段）。

### 重跑出口二：重新评分（只重跑评分那一步）

- **判据 `canRescoreRow` 三条件缺一不可**：不在运行中（`preparing` / `running` / `judging`）· `baselineCommit !== ''` · `diff !== null`。⇒ 可重评的面 = 「跑过一次、产出了改动」的所有终态（`judged` / `failed` / `timed-out` / `canceled` / `interrupted`），**与这一行是否失败过无关**（`error.stage` 只是「这一笔失败发生在哪一段」的事实记录，不参与任何判据）。`pending` / `skipped` 得到**点名原因**的明确拒绝（「工作区未就绪」与「没有可复评的改动」，界面与服务端各一份同义文案，且与判据三条件**逐条同序**）。2026-09-28 晚间放开：原来还要求 `error.stage === 'judge'`，于是已出分与候选阶段失败的行都挂着禁用——用户口径改成「已分出，无报错时取消禁用」。
- 与单行执行**成本差一个数量级**（几十秒 vs 分钟级），故不做成一个按钮。
- `Popconfirm` 标题「重新评分这一行？」、说明「只重跑评分步骤，候选 agent 不会再跑；现有的分数会被新的评分结果替换。」——代价（会把现有分数先清空、重评失败就丢掉旧分）由确认框声明**一半**，**而不是**由判据替使用者做决定。
- **按钮顺序是用户指定的版面口径**：执行日志 / 变更详情 / 重新执行 / 评分详情 / 重新评分（顺序要连注释一起改，否则下一个人只能靠猜）；可点态**不挂** `Tooltip`（浮层不该凭空出现）；禁用态的原因在真机上屏：在跑 ⇒「正在运行中：请先终止它，再重新执行 / 再重新评分」，没跑过 ⇒「这一行的工作区未就绪，请先点「开始」跑一次」。
- `Tooltip` 必须挂在**外层 span** 上：直接子节点若是 `Popconfirm`，悬浮事件会被那条链吃掉（真实浏览器实测连一个 `.ant-tooltip` 节点都不出现）——jsdom 验不出这件事（`fireEvent.mouseEnter` 是直接派发到按钮上的合成事件），改这一处必须在真实浏览器里悬浮一次。

### 删除

- `Popconfirm` 文案「删除这一轮评测？这一轮的全部行工作区与执行日志会一起删掉，不可恢复。」；`onConfirm` **必须回交在途 promise**（返回 `undefined` 时确认框立刻关闭，用户会再点一次 = 第二次 DELETE）。
- 删除成功 ⇒ 回 `/runs` + `message.success`；`workspaceRemoved === false` 时补一句「行工作区有残留（被占用），可手动清理」。

## 数据与契约

- **`RunUpdateSchema` = `RunCreateSchema.extend({ rows: …element.extend({ id }).array().min(1) })`——派生而非手抄**（手抄的那份在创建侧新增可选字段时会静默剥掉它）；`RunCreateSchema` 逐字不变（创建路径不带 id，服务端也不读它）。
- **`PUT /api/runs/{runId}`（不是 PATCH）**：payload 的语义就是「这一轮应当长成什么样」。
- `hasLiveRows(run)`：轮级 `running` 或任一行 `preparing` / `running` / `judging`。**编辑与删除共用这一条**（做 `canEditRun` / `canDeleteRun` 是假一对）。轮级状态也要看：`startRun` 把 `running` **同步**落库、而行要等各自的任务起来才翻状态，中间那一拍只有轮级状态能反映「已经在跑了」。
- `isSameRowTarget(row, next)`：`agentKind` / `providerId` / `modelId` / `effort` 逐字比较（`effort` 两侧 `?? null`——`undefined` 与「缺这一格」并成同一格）。`providerName` / `baseUrl` 是服务端快照**不入判据**（改个供应商名字不该把已经跑出来的成绩打掉）；**强度参与判定，且「一侧没给」算改了**：编辑载荷是候选行的**全量替换**，「这一格没有」只能读成「未指定档位」——宁可多重置一行，也不能静默保留一个用户已经改过的档位跑出来的分。两个消费方（服务端 `planRunUpdate` 决定重置哪一行、编辑表单事先算出会作废哪几行）各写一份的漂移症状是「确认框说会作废 2 行，实际作废了 1 行」——那正是用户唯一能核对的地方。
- **行对齐规则（行 id 是唯一对齐键）**：带 id 且命中 ⇒ 原地更新；带 id 但**不命中** ⇒ `NOT_FOUND`「该评测里没有这一行（…）」**不静默当新行**；带 id 且在**同一入参里出现两次** ⇒ `INVALID_QUERY`「编辑入参里重复引用了同一行（…）：每一行只能出现一次」（与「未知 id」是同一处的孪生检查）；不带 id ⇒ 新行；现有行不在 patch 里 ⇒ 删除。
- **逐行处置表**：

| 编辑动作 | 行快照 | 该行的磁盘产物 |
|---|---|---|
| 只改执行模式 / 只改「使用智能体评分」 | **一行都不动** | 不动 |
| 改某行的 agent / 模型 / 强度 | 该行**原地重置**：`status → 'pending'`、`baselineCommit → ''`、`tokens / turns / durationMs / diff / score / error → null`、`attempts → 0`、`effort` 按新值重建（缺省即不写键——界面从此显示「默认」档） | 不动（重跑时既有机制清：`prepareRowWorkspace` 清 `workspace/`、`.agenthome/`、`.judgehome/`） |
| 新增一行 | 新 `rowId`（`randomUUID`）+ `branch = test/{rowId}` + `workspacePath` 按 `run.workspaceBase` 现算；`providerName` / `baseUrl` 由服务端快照 | 无（首次 prepare 时建） |
| 删掉一行 | 从快照移除 | **不动**（孤儿目录留给整轮删除时回收） |
| 换来用例 | 重取六格快照（`caseId` + 标题 / `repoPath` / `repoBranch` / `commitHash` / `rubric`）+ **所有行**按「原地重置」处理 | 同上 |

  新增行的 `workspacePath` 按 **`run.workspaceBase`** 现算，**不用当前 `settings.workspaceRoot`**——一轮的产物必须与它的快照同根。
- **`attempts` 在重置时清零（与 `retryRow` 刻意不清零相反）**：重试重跑的是同一件事，编辑换掉的是**被评对象**——留着「尝试 3 次」等于让新模型凭空背上旧模型的账。
- **轮级状态收敛一次**（在同一个 `saveRun` 里落地）：全行 `judged` ⇒ `done`（`finishedAt` 已非 null 保留原值，否则填当前时刻）、`startedAt === null` ⇒ `idle`（`finishedAt = null`）、否则 ⇒ `partial`（`finishedAt = null`）——用新口径而不是现成的 `finalizeRun`（后者对「全行 pending」会落 `partial`）。
- `EvalRun` **不加字段**（列表的「创建时间」是复现条件之一，编辑不该让它变）。
- **「改了才重置」按值判**：表单交回来的永远是全量行集合，按「字段出现没有」判会把每次保存都变成全行清空重来。
- **校验链与创建共用一份，先全校验、再一次性落盘**（顺序逐字沿用 `createRun`；编辑不为已存在的行生成新 id；任何一步抛 ⇒ **一个字节都不写**）。
- **数据层**：`useUpdateRun()`（`PUT` → `mutate(runKey(id), updated, { revalidate: false })` + `await mutate(RUNS_KEY)`）、`useDeleteRun()`（`DELETE` → `mutate(runKey(id), undefined, …)`）；两个都**不用** `useSWRMutation`——写操作的响应要同时写进**详情**与**列表**两个键，而 `useSWRMutation` 只绑定一个键；顺带的好处：写操作没进 SWR 的 fetcher ⇒「窗口重新获得焦点重发一次写请求」这条坑在形状上不存在。
- **接口分层**：contracts（`RunUpdateSchema` / `hasLiveRows` / `isSameRowTarget`）→ evaluator（`assertRunMutable` 互斥守卫、`deleteRun` 两步 + 根记忆）→ api（`updateRun` / `deleteRun`）→ 路由（现有文件加 `PUT` / `DELETE`，只做「zod 校验、调 api、错误映射」）。`assertRunMutable` 与 `deleteRun` 都落在 `orchestrator.ts`、**不拆 `run-store.ts`**：四张在途表都是该模块私有的，`deleteRun` 放进 `run-store` 会为这个守卫 import orchestrator，得到循环 import。算新快照拆成两个**可导出、可直测**的函数：`resolveRunRows(rows, providers)`（校验链 + 供应商快照，创建与编辑共用）、`planRunUpdate(run, input, resolved, target)`（对齐 / 重置 / 轮级收敛，不做 I/O、不查配置与注册表）；两者只从 `api/src/runs.ts` 导出，包根只转出 `updateRun` / `deleteRun` / 等真正的消费出口。

## 状态机与时序

```text
PUT /api/runs/{runId}（顺序承重）
  取快照 → hasLiveRows（真 ⇒ 409）→ 校验链 resolveRunRows
  → assertRunMutable（在途任务表非空 ⇒ 409）→ planRunUpdate → saveRun
```

- **互斥守卫排在算新快照之前**：规划器读的是取快照那一刻的状态，按它规划出来的新快照会盖掉编排层正在写的那一份。
- **互斥与并发**：`hasLiveRows` 之外另加一条纵深守卫 `assertRunMutable`——`runTasks` / `retryTasks` / `rescoreTasks` / `rowAborts` 里还有这一轮或这一行的条目 ⇒ 409 `CONFLICT`「这一轮上一次的运行还没收尾（…）：请稍候再试，或先终止它」。`hasLiveRows` 读的是**快照**，而行刚落终态、任务还在收尾的那一拍快照是「没有活」。四张表并非都开火：`runTasks` 那条**构造上不可达**（`startRun` 收尾把 `finalizeRun` 与 `runTasks.delete` 放在同一个同步片段里，单线程没有窗口），真正开火的是**行级在途表**——那一档 409 的唯一生产者是「行已落 `failed`、`runRow` 还在重试退避里」，此时 `rowAborts` 与 `retryTasks` 两张表同时持键；`runTasks` 留作将来异步改造的兜底。
- **删除顺序（两步且顺序承重）**：存在性检查（404）→ `hasLiveRows` ⇒ 409 → `assertRunMutable` → ① 删 `{workspaceBase}/{runId}/run.json` → 从进程内根记忆里忘掉这一轮（`forgetRunRoot(runId)`）→ ② `rmSync` 整目录（`{ workspaceBase }/{runId}/`, `recursive: true, force: true`）→ ② 失败只 WARN + 响应 `{ workspaceRemoved: false }`。边界：**只删当前 `settings.workspaceRoot` 里可见的那一轮**（与读侧口径一致）。拆两步的理由：整目录一把删时 `rmSync` 的遍历顺序不保证，中途 EPERM 会让「快照到底删没删」变成不确定。
- **重新评分服务端流程**（`evaluator.rescoreRow(runId, rowId)`）：`requireRow` → `rescoreRefusal`（含编排层独有的 `settling`：`rowAborts` 里还有这一行的条目 ⇒ 拒）→ `loadConfig`（**用例必须仍存在**：题面与仓库来源没有快照进 `run.json`）→ 注册 `AbortController`（与候选阶段**同一把钥匙** ⇒「终止」按钮在评分阶段天然有效）→ 落 `[重新评分]` 日志 → `setRowStatus('judging', { error: null, score: null })` → 跑评分（与完整跑一行的第 7 步**同一个函数** `runJudgeStage`）→ `patchRow({ score })` + 发 `score` 事件 → `setRowStatus('judged')` + 发 `end` 事件（`exitReason: 'rescored'`）；失败 / 终止复用 `settleFailed` / `settleAgentJudgeStop`；`finally` 里 `clearRowRuntime` + `finalizeRun`。
- **四条硬口径**：
  1. **追加事件、不 `resetEvents`**（事件日志是执行的唯一真相源）；也不递增 `attempts`（它只统计候选阶段的重试）。
  2. **入口区必须能整体回退**：登记控制器 / 写标记事件 / 写状态三步里任何一步抛 ⇒ `clearRowRuntime` 抹掉全部痕迹再抛（否则这一行会带着一个活着的条目停在终态，此后永久不可重评——而清理者挂在那个没起来的任务上）。
  3. **终态复检**：评分返回时该行已是终态（用户先点了终止）⇒ 状态保持 `canceled`，分数只写进事件日志。
  4. **`row.diff` 一个字都不动**：重评只跑评分，`diff` 属于候选阶段（把污染对照现算的那份写回去会让「diff 已截断」徽标凭空消失）。
- **单行执行服务端**：`retryRow` 是「同步落 `preparing` → 起 `runRow` → `finally` 里补一次 `finalizeRun`」；编辑路径不碰文件系统（产物留给重跑时清理；`runRowAttempt` 会 `resetEvents`）。

## 已知边界与取舍

| 边界 | 状态 | 处置与判据 |
|---|---|---|
| `resetRow` 不清 `subagentTokens` / `subagentTurns` | 已知数据卫生缺口 | 重置行时这两格残留旧值；界面因两行拆分要求 `tokens !== null` 而看不出来 |
| `settling` 窗口「界面可点、点下去 409」 | 未闭合 | 编排层有界面看不见的判据（`rowAborts`）；判据放宽后进得来这个窗口的行**变多了**（此前只可能是评分阶段失败的终态，现在是任意「跑过一次且有产出」的终态——如评分落 `failed` 之后 `runRow` 还在自动重试退避里）。闭合需要快照多一格「还在收尾」或让界面订阅在途状态，是另一个改动 |
| `error.stage` 没有任何控制流读者 | 观测口径 | 照旧落盘（契约与单测钉着形状），排障用；若要删先确认没有新判据依赖它 |
| `retry` 的准备阶段是同步重活 | 已知代价 | `ensureMirror` / `resolveRemoteRef` 的镜像 fetch 在编排层准备阶段、先于 `prepareRowWorkspace`；`await yieldToEventLoop()` 把它移出 `retryRow` 的调用栈（`retryRow` 只落 `preparing` 快照就返回），但仍**整段占住事件循环** ⇒ 远端仓库 + 冷镜像时这一行会长时间停在 `preparing`，同进程其它请求（含这一次请求自己的响应）也跟着排队；强杀重启会留下在途锁——被标记 `interrupted` 的行可能仍有活着的 `runRow` 与厂商 CLI 子进程留在旧模块实例里 ⇒ 该行此后一律 409，只能杀掉残留进程才恢复 |
| 编辑表单可被无提示导航离开 | 设计后果 | 点另一行会跳详情，未保存内容静默丢弃；**手输 `?panel=edit&id=…` 可绕过面板的 `hasLiveRows` 置灰**（靠服务端 409 兜底）——都是本页 URL-as-truth 设计的后果，留作后续设计讨论 |
| 「重新评分 → 真的重算出分」「重新执行 → 真的重跑候选」未在真机复现 | 未覆盖 | 当时机器评分配置为空，点下去只会走「评分阶段失败」；由编排层用例覆盖（重评：分数 80 → 60、`score` 事件两条、`exitReason=rescored`；重跑：`attempts` 1→2、候选 agent 再跑一次、事件追加）。恢复评分配置后应在真机补一次 |
| 编辑 / 删除冒烟用磁盘播种快照构造 | 未覆盖 | 「已评分行」「运行中」「用例已删」都用播种的 `run.json` 构造，验证界面判定与服务端语义，不验证真 agent 跑出来的行——那部分由既有评测冒烟记录覆盖 |

## 相关链接

- [创建评测](/features/run-creation) —— 编辑复用的那张表单、执行模式与候选行的创建侧口径
- [用例管理](/features/case-management) —— 换用例时重取的六格快照从哪来、`assertStorable` 真相层
- [功能总览](/features/) —— 本域目录层：三大模块与数据模型清单
- [《评测详情与候选行》](/features/run-detail)、[《评分》](/features/judging)、[《行执行与日志》](/features/row-execution) —— 详情页形态与吸底操作栏（开始 / 终止）、重新评分重跑的那一步（`runJudgeStage` 与两条通路）、事件日志与 SSE 口径
- [故障索引](/faq/) —— 评测编辑与重跑链路上的报错排障入口
