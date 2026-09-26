# AI 生成代码评测工具 —— 评测详情「修改 / 删除」设计

日期：2026-09-28
状态：待评审
前置：`docs/superpowers/specs/2026-09-22-features-design.md`（功能设计：用例 / 评测 / 设置）、`docs/superpowers/specs/2026-09-22-scaffold-design.md`（脚手架）、`docs/superpowers/specs/2026-09-26-remote-git-source-design.md`（远端来源）
性质：本文只做一件事——给**一轮评测**补上「修改」与「删除」两个动作，形态与用例详情已有的「编辑 / 删除」对齐。工作区布局、行状态机、事件日志口径、评分口径、`run.json` 的既有字段**全部不变**（本文**不加**任何 `EvalRun` 字段）。与前置文档冲突时以本文为准：features-design §3 F9 那句「执行模式落库，运行中不可改」中**只有「运行中不可改」继续成立**（落库不变，非运行中可改，见 §3 D2）；§5.3 的「吸底操作栏 = 开始 + 终止」增补顶部信息卡上的两个入口（§6.1）。

---

## 1. 要解决的问题

现状（四条已实现的事实）：

1. **用例**详情已有「编辑 / 删除」：`CaseDetailPanel` 的 `extra` 两个按钮 + `PUT`/`DELETE /api/cases/{caseId}` + `useUpdateCase`/`useDeleteCase`，删除用 `Popconfirm` 且把在途 promise 交回确认框；
2. **评测**详情只有「开始 / 终止」（`RunDetailPanel` 的吸底栏），单轮评测**建成之后就改不动、也删不掉**——一个选错的模型或漏掉的候选，出路只有「重新建一轮」；
3. `EvalRun` 上**没有自己的标题**：`caseTitle` / `repoPath` / `commitHash` / `repoBranch` 都是从用例**冗余快照**过来的（features-design §7.2），所以「修改一轮评测」能改的字段本质上就是创建表单那几格：**用例、执行模式、使用智能体评分、候选行**；
4. 一轮的落盘产物都在 `{workspaceBase}/{runId}/` 下：`run.json`（快照）、`rows/{rowId}/workspace`（行工作区）、`rows/{rowId}/events.jsonl`（执行日志）。

需求：在评测详情上就地**修改**这一轮怎么跑，以及**删除**这一轮（连同它的产物）。用户口径（2026-09-28）：修改范围与创建表单**完全对齐**；只要**没有行在运行**就可以改，改动作废受影响行的已有结果；删除连整个 `{workspaceBase}/{runId}/` 一起删。

成功标准：

1. 在 `/runs?panel=detail&id=…` 上能打开一张预填当前值的编辑表单，改完保存后详情与列表都反映新值（用例标题 / 候选数 / 执行模式三列同源更新）；
2. **未受影响的行逐字不变**：只改执行模式时，所有行的 status / 分数 / diff / 计量一个字节都不动；
3. 被改动的行**不留旧数据**：换了模型或换了用例的行回到「待开始」，且它的旧分数不会继续挂在卡片上；
4. 删除后这一轮从列表与详情同时消失，磁盘上 `{workspaceBase}/{runId}/` 被回收；回收不掉时**如实回报**，不假装干净；
5. 有行在运行中时两个动作都被拦下：界面上入口置灰并给出原因，服务端同一判据抛 409。

---

## 2. 本阶段范围

| 做 | 不做 |
|---|---|
| `RunUpdateSchema`（创建入参的超集：候选行可带 `id`）与判据 `hasLiveRows` / `isSameRowTarget` | 给 `EvalRun` 加 `updatedAt` / 编辑历史 / 审计字段 |
| 评测的 `PUT` / `DELETE` 路由与 api / evaluator 落点 | 编辑后自动重跑受影响的行（跑不跑由「开始」决定） |
| 「逐行处置」语义：原地重置 / 新增 / 删除 / 改用例全量重置 | 编辑时的产物即时清理（留给重跑时的既有机制，§3 D5） |
| 轮级状态在编辑后的收敛口径 | **单行的结果恢复**（跑过但没跑成的行走既有的「重新评测 / 重新评分」两个出口，编辑不承担这个职责） |
| 编辑表单复用 `RunCreatePanel`（`mode: 'new' \| 'edit'`） | 新建一个 `RunEditPanel`（两份字段表必然漂移） |
| 详情面板的「编辑 / 删除」入口 + 运行中置灰与原因 | 批量删除 / 多选 / 回收站 |
| 删除的两步落盘顺序与「回收失败如实回报」 | 删除别的轮次、删除用例级缓存仓库（`cases/{caseId}/cache` 不归本轮所有） |

---

## 3. 关键决策与理由

| # | 决策 | 理由 | 被否决的替代 |
|---|---|---|---|
| D1 | 修改范围 = **用例 + 执行模式 + 使用智能体评分 + 候选行**（与创建表单完全对齐） | 这四格就是 `EvalRun` 可变字段的全集（`caseTitle` 等是快照，标题那一格不由用户编辑）；选错用例 / 选错模型 / 漏一个候选都能就地修 | 只改执行模式与评分方式（最小，但选错模型仍只能删了重建）；不许换用例（快照身份洁癖，但用户真实会选错） |
| D2 | 只要**没有行在运行**（`!hasLiveRows(run)`）就可以改，改动作废受影响行的结果 | 「一次都没跑过」这条判据太紧：跑残了还得删了重建，而残缺轮次的恢复出口（重新评测 / 重新评分）**只对失败行**给出；反过来「随时可改」不可接受——正在跑的行有自己的生命周期，终止它是另一件事（`hasLiveRows` 与 `startRun` 的既有判据同源） | 只在 `status === 'idle'` 且全行 `pending` 时可改（F9 的紧读，实用价值低）；任何时候都可改（与在途执行打架，会让 `settleStopped` 的终态优先守卫失效） |
| D3 | **行 id 是行身份**：编辑入参的候选行带可选 `id` | 编辑表单必须能说清「这一行还是原来那一行」。按位置对齐时「删掉第 2 行」会让第 3 行顶上来、它的成绩被错认成第 2 行的；按 `(agent, model)` 对齐时两行选同一个模型就无解 | 按位置对齐；按 `(agentKind, providerId, modelId)` 三元组**对齐**（两行选同一个模型时无法区分「改的是哪一行」——注意这个三元组仍被用作「同一行的**目标**变没变」的判据，见 §4.3，那是另一件事）；编辑即「全部删掉重建」（`retryRow` 的原地重跑语义会与它分叉成两套） |
| D4 | 被改动的行**原地重置**（行 id / 分支 / 工作区路径都不变），只清快照字段 | 行身份稳定＝日志抽屉与既有 `retryRow`（同一 rowId 原地重跑）继续成立；行目录里 `workspacePath` 与 `branch` 不变，后续 prepare 的语义不用重推 | 删旧行建新行（编辑一次行 id 全换、旧行目录成孤儿）；保留旧分只把 status 打回 pending（会出现「待开始的行挂着上一轮的分」——本仓最反对的「把旧数据渲染成新数据」） |
| D5 | **编辑路径不碰文件系统**：产物留给重跑时清理 | `prepareRowWorkspace` 重跑同一行时会自己清 `workspace/ .agenthome/ .judgehome`，`runRowAttempt` 会 `resetEvents`——这条路已经修好且有守卫；而编辑是同步 HTTP 路径，Windows 上 agent 刚退、杀软占用都可能让目录删除 EPERM/EBUSY，让一次「改个模型」因为删不掉旧目录而失败，是把内部细节泄漏成用户故障 | 编辑时就地删产物（多一条会失败的删除路径，且当场丢掉上一轮的事件日志）；整目录删（`events.jsonl` 归 `resetEvents` 独占，§11 R27；整目录删会把「重跑」变成对日志的隐式清空） |
| D6 | 删除**分两步且顺序承重**：① 删 `run.json` ② `rmSync` 整个 `{workspaceBase}/{runId}/` | ①是用户按下去要的那件事（列表立刻干净），②是回收空间。整目录一把删时 `rmSync` 的遍历顺序不保证，中途 EPERM 会让「快照到底删没删」变成不确定；拆开后「删了但列表里还在」不可能发生 | 整目录一把 `rmSync`；只删 `run.json`（磁盘上留一堆没人知道是不是垃圾的工作区，与「删用例一并清缓存仓库」的口径也不一致） |
| D7 | ②回收失败**只 WARN 并如实回报**（响应 `workspaceRemoved: false`），不报成删除失败 | 与 `removeCaseCache` 同一处置精神：快照已删＝用户要的结果已达成，剩下的失败是磁盘回收问题，报成「删除失败」会让用户再点一次（而那一轮已经不存在了） | 回收失败即整体失败（快照已删，用户再点只会拿到 404）；静默 WARN 不回报（界面会显示「已删除」而磁盘上还留着几 GB） |
| D8 | 用 **`PUT /api/runs/{runId}`**（不是 PATCH） | payload 的语义就是「这一轮应当长成什么样」（可变字段全量交回），与 `/api/cases/{caseId}` 逐字同形；client 侧 `putJson` / `delJson` 原语已存在，不新增 | PATCH 增量补丁（要定义「字段缺省 = 不改」还是「= 清空」，而表单交回来的永远是全量，多一层没有消费方的语义） |
| D9 | 编辑表单**复用 `RunCreatePanel`**（加 `mode`），不新写组件 | 两处字段表（用例 / 执行模式 / 使用智能体评分 / 候选行）必须永远一致，各写一份必然漂移；`CaseFormPanel` 的 `mode: 'new' \| 'edit'` 是同一做法且已被验证 | 新建 `RunEditPanel`（字段表两份、校验两份、文案两份） |
| D10 | 判据只加**一份**：`hasLiveRows(run)`，编辑与删除共用 | 两个动作的可用条件是同一条（「不在运行中」），做成 `canEditRun` / `canDeleteRun` 是假一对；判据放 contracts 是既有落点（`isRunnableRow` / `canRescoreRow` / `canRetryRow` 都在那里），界面用它置灰、服务端用它抛 409，一份真源不会漂移成「按钮可点、点下去 409」 | 两个判据各写一份；判据只写在服务端（界面只能靠 `status === 'running'` 自己猜，会漏掉「行在跑但轮状态还没翻」这一拍） |
| D11 | 编辑后**轮级状态收敛一次**，用新口径而不是现成的 `finalizeRun` | `finalizeRun` 对「全行 pending」会落 `partial`，把一个从没跑过的轮次显示成「部分完成」；收敛口径见 §5.1 第 3 条 | 不动轮级状态（`done` 的轮次里留着一行 `pending`，列表显示「已完成」，与卡片自相矛盾）；直接复用 `finalizeRun`（见左） |
| D12 | `EvalRun` **不加字段** | 列表那列「创建时间」是这一轮的复现条件之一，编辑不该让它变；真要追溯「改过」将来作为**可选且带默认值**的字段再加（必填会让老 `run.json` 被 `listRuns` 静默跳过——`attempts` / `useAgentJudge` / `stage` 三次都踩过这条） | 加 `updatedAt`（改了列表排序语义与页面上「创建时间」那一列的含义）；加 `editedAt`（本期没有消费方） |
| D13 | 新增行的 `workspacePath` 按 **`run.workspaceBase`** 现算，不用当前 `settings.workspaceRoot` | 一轮的产物必须与它的快照同根（run-store 口径 4 / R10）：用户在评测期间改过工作区根目录时，`prepareRowWorkspace` 拿的是 `run.workspaceBase`，若编辑时按当前设置算，新行的工作区就会落在另一个根里——这一轮的产物裂成两半，且两边都不报错 | 用 `settings.workspaceRoot`（`createRun` 用的是它，但那是**建轮**的那一刻，`workspaceBase` 就是在那里定下的） |

---

## 4. 契约变更（`packages/server/contracts/src/run.ts`）

### 4.1 `RunUpdateSchema`（新增）

创建入参的**超集**，差别只有一处：候选行多一个**可选 `id`**。

```ts
/** 编辑交回的「这一轮应当长成什么样」：与创建的差别只有候选行可带 id（指认原来那一行） */
export const RunUpdateSchema = RunCreateSchema.extend({
  rows: z
    .array(
      z.object({
        /** 有 id = 原地更新这一行；没有 = 新增一行。创建路径不带它 */
        id: z.string().min(1).optional(),
        agentKind: AgentKindSchema,
        providerId: z.string().min(1),
        modelId: z.string().min(1),
      }),
    )
    .min(1),
});
export type RunUpdate = z.infer<typeof RunUpdateSchema>;
```

`RunCreateSchema` / `RunCreate` **逐字不变**（创建路径不带 id，服务端也不会去读它）。

### 4.2 判据 `hasLiveRows`（新增）

```ts
/** 这一轮此刻还有活在跑吗（轮级 running，或任一行处于 preparing/running/judging） */
export function hasLiveRows(run: EvalRun): boolean {
  return run.status === 'running' || run.rows.some((row) => isRunningRow(row.status));
}
```

放 contracts 的理由与 `isRunnableRow` / `isRunningRow` / `canRescoreRow` / `canRetryRow` 逐字相同：界面靠它决定按钮的 `disabled`、服务端靠同一份抛 `CONFLICT`。**它不是**「有没有行跑过」，也不是「能不能重新评测」。

### 4.3 判据 `isSameRowTarget`（新增）

```ts
/** 编辑交回的这一行与现有行还是不是同一件事（agentKind / providerId / modelId 逐字比较） */
export function isSameRowTarget(
  row: EvalRow,
  next: { agentKind: AgentKind; providerId: string; modelId: string },
): boolean {
  return row.agentKind === next.agentKind && row.providerId === next.providerId && row.modelId === next.modelId;
}
```

**为什么它也必须在 contracts**：这条「改了才重置」的判据有两个消费方——服务端的 `planRunUpdate` 用它决定重置哪一行，编辑表单用它**事先算出这次会作废哪几行**（§6.2 的确认框）。两处各写一份必然漂移，漂移的症状是「确认框说会作废 2 行，实际作废了 1 行」——而那正是用户唯一能核对的地方。`providerName` / `baseUrl` 是服务端快照，不入判据。

---

## 5. 服务端语义

### 5.1 「修改」= 一张逐行处置表

`PUT /api/runs/{runId}` 的入参是 `RunUpdate`，服务端把它解释成「这一轮应当长成什么样」：

| 编辑动作 | 行快照 | 该行的磁盘产物 |
|---|---|---|
| 只改执行模式 / 只改「使用智能体评分」 | **一行都不动** | 不动 |
| 改某行的 agent 或模型 | 该行**原地重置**：`status → 'pending'`、`baselineCommit → ''`、`tokens / turns / durationMs / diff / score / error → null`、`attempts → 0` | 不动（重跑时 `prepareRowWorkspace` 清 `workspace/ .agenthome/ .judgehome`，`resetEvents` 清事件日志） |
| 新增一行 | 新 `rowId`（`randomUUID`）+ `branch = test/{rowId}` + `workspacePath = rowWorkspaceDir(run.workspaceBase, runId, rowId)`；`providerName` / `baseUrl` 由服务端快照；`status = 'pending'`、`baselineCommit = ''`、`tokens / turns / durationMs / diff / score / error = null`、`attempts = 0`（`createRun` 的行初值逐字相同） | 无（首次 prepare 时建） |
| 删掉一行 | 从快照移除 | **不动**：孤儿目录留给整轮删除时一起回收（§3 D5/D6） |
| 换来用例 | 重取 `caseTitle / repoPath / commitHash / repoBranch` 快照 + **所有行**按「原地重置」处理 | 同上 |

行对齐规则（**行 id 是唯一对齐键**，§3 D3）：

1. patch 里的行**带 id 且命中**现有行 ⇒ 原地更新那一行；
2. 带 id 但**不命中**（脏 URL / 并发改动）⇒ 抛 `NOT_FOUND`「该评测里没有这一行（…）」，**不静默当新行**：静默会造出一行用户没打算要的候选；
3. 不带 id ⇒ 新行；
4. 现有行**不在** patch 里 ⇒ 删除。

四条口径：

1. **「改了才重置」按值判**（`updateCase` 同口径）：编辑表单交回来的永远是**全量**行集合，按「字段出现没有」判会把每次保存都变成全行清空重来。判据就是 §4.3 的 `isSameRowTarget`（`agentKind / providerId / modelId` 三者逐字比较）。
2. **`attempts` 在重置时清零**，与 `retryRow` **刻意不清零**相反，理由要写进注释：重试重跑的是同一件事（同一模型、同一用例），尝试次数是那一行的累计事实；而编辑换掉的是**被评对象**，留着「尝试 3 次」等于让新模型凭空背上旧模型的账。
3. **轮级状态编辑后收敛一次**（在同一个 `saveRun` 里落地，不额外写盘）：
   - 全行 `judged` ⇒ `done`，`finishedAt` 已是非 null 就保留原值、否则填当前时刻；
   - 否则 `startedAt === null`（一次都没跑过）⇒ `idle`，`finishedAt = null`；
   - 否则 ⇒ `partial`，`finishedAt = null`（跑过一轮、现在又有行待跑）。
   不调 `finalizeRun` 的理由见 §3 D11。
4. **校验链与创建共用一份，且先全校验、再一次性落盘**。顺序逐字沿用 `createRun`（用例存在 → 评分通路 → 供应商存在 → 模型在该供应商清单里 → 协议兼容），差别只有两条：
   - 编辑不为**已存在的行**生成新 id（用 patch 里带的那个；只有新增行才有新 id）；
   - 任何一步抛 ⇒ **一个字节都不写**（与 `retryRow` 的「入口区必须能整体回退」同一条原则）。

### 5.2 互斥与并发

`hasLiveRows` 之外**另加一条**纵深守卫：`runTasks`（轮级）/ `retryTasks` / `rescoreTasks`（行级）/ `rowAborts` 里还有这一轮或这一行的条目 ⇒ 409 `CONFLICT`「上一次的运行还没收尾，请稍候再试」。
理由：`hasLiveRows` 读的是**快照**，而行刚落终态、任务还在收尾的那一拍快照是「没有活」；这条守卫与 `retryRow` 里既有的那条（`rowAborts.has(key) || retryTasks.has(key)`）同源。守卫落在 evaluator（那是这些表的家），api 在算完新快照、写盘**之前**调它。

### 5.3 「删除」

`DELETE /api/runs/{runId}`：

1. 存在性检查（`getRunView`，不存在 ⇒ 404）→ 同一套互斥守卫（§5.2）→ `hasLiveRows` ⇒ 409；
2. ① 删 `{run.workspaceBase}/{runId}/run.json`；
3. ② `rmSync({run.workspaceBase}/{runId}/, { recursive: true, force: true })` 回收剩余（行工作区 + 事件日志）；
4. 从进程内根记忆里忘掉这一轮（`run-root-memory` 新增 `forgetRunRoot(runId)`）——否则 `getRunForWrite` 还能把已删的轮次解析到旧根（R10 的兜底会把「找不到」答成一条路径）；
5. ②失败只记 WARN + 响应 `{ workspaceRemoved: false }`（§3 D7）。

边界：**只删当前 `settings.workspaceRoot` 里可见的那一轮**（与读侧口径一致，R10）。用户在评测期间改过根目录、这一轮留在旧根时，列表里看不到它、也就删不掉它——这是既有读取口径的直接推论，不是本次引入的缺口。

### 5.4 「修改」的接口分层

| 层 | 落点 | 职责 |
|---|---|---|
| contracts | `contracts/src/run.ts` | `RunUpdateSchema` / `hasLiveRows` |
| evaluator | `evaluator/src/orchestrator.ts` | `assertRunMutable(runId)`（§5.2 的互斥守卫）与 `deleteRun(runId)`（§5.3 的两步 + 根记忆） |
| api | `api/src/runs.ts` | `updateRun(runId, input)`：取快照 → `hasLiveRows` 判据 → 校验链 → 算新快照 → `assertRunMutable` → `saveRun`；`deleteRun(runId)`：存在性检查 → 转 evaluator |
| 路由 | `apps/web-next/app/api/runs/[runId]/route.ts` | 现有文件加 `PUT` / `DELETE`，只做「zod 校验 → 调 api → 错误映射」 |

**两个都落在 `orchestrator.ts`，不拆到 `run-store.ts`**：`assertRunMutable` 要看的那四张表（`runTasks` / `retryTasks` / `rescoreTasks` / `rowAborts`）都是该模块私有的；而 `deleteRun` 若放进 `run-store.ts` 就会为了这个守卫去 import orchestrator，得到 `orchestrator → run-store → orchestrator` 的循环 import——本仓已经为同一条坑专门抽过模块（见 `run-root-memory.ts` 文件头对 `run-store → events → run-store` 的处置）。`deleteRun` 的落盘用 core 的 `runDir` 与 `node:fs`，路径语义与 `saveRun` 同源。

「算新快照」拆成两个**可导出、可直测**的函数（页面与组件层的间接断言盖不住「哪一行被重置了」，这条规则必须能被**直接**测到——与 `matchCaseTitle` / `completionPercent` 同一考虑）：

- `resolveRunRows(input): ResolvedRow[]`——校验链 + 供应商快照（`providerName` / `baseUrl`），**创建与编辑共用**（`createRun` 现有的那段 `input.rows.map(...)` 投影就是它的雏形）；返回的每项带上 patch 里的 `id`（如果有）；
- `planRunUpdate(run, resolvedRows, input): EvalRun`——对齐 / 重置 / 轮级收敛，不做 I/O、不查配置与注册表；唯一的外部状态是新增行的 `randomUUID()`（与既有投影同一做法，注释里点明），用例对新增行只断言「id 非空且不等于任何原行 id」，不写死值。

---

## 6. 界面

### 6.1 `RunDetailPanel`（`packages/client/ui/src/composite/run-detail-panel.tsx`）

顶部信息卡的 `extra` 加「编辑 / 删除」，与 `CaseDetailPanel` 逐字同形：

- 两个汉字的按钮一律 `autoInsertSpace={false}`（否则可访问名变成「编 辑」/「删 除」）；
- 删除用 `Popconfirm`，`onConfirm` **必须回交在途 promise**（返回 `undefined` 时确认框立刻关闭，用户看到「点一下没反应」，再点一次就是第二次 DELETE——`CaseDetailPanel` 的注释里已有这条）；
- 删除文案说清「会连这一轮的全部行工作区与执行日志一起删掉，不可恢复」；
- `hasLiveRows(run)` 为真时两个按钮都 `disabled` + `Tooltip` 说明原因（「有候选行正在运行：先终止，再编辑 / 删除」），服务端同一判据抛 409——两层都有，界面的置灰只是提前告知。

新增 props：`onEdit: () => void`、`onDelete: () => void | Promise<unknown>`、`deleting?: boolean`。

### 6.2 编辑表单（`RunCreatePanel` 加 `mode`）

- `mode: 'new' | 'edit'`（缺省 `'new'`，既有调用方逐字不变）+ `initial?: EvalRun`；行值多带一个 `id`（预填时带上，新增行为空）。
- 提交类型收敛成一个 `RunFormValues`（`rows: { id?: string; agentKind; providerId; modelId }[]`）。页面按 mode 映射：`new` **显式剥掉 id** 再交给 `create`（不依赖 zod 对未知键的静默剥离），`edit` 原样交给 `update`。剥的时候**新建对象**，不动表单内部持有的行值。
- 两个必须写进注释的细节：
  1. 编辑时「用例」下拉要保证**当前用例在选项里**——用例已被删除时补一个 `disabled` 的占位选项并提示「原用例已删除，请重新选择」，否则 `Select` 显示空白，用户只改执行模式、一保存就悄悄换了个用例；
  2. 执行模式在编辑模式取 `initial.executionMode`，不能被 `initialValues` 的「默认串行」盖掉（`initialValues` 只在挂载时读一次，`mode` 与 `initial` 变更必须靠 `key` 重挂载——与 `CaseFormPanel` 的 `key={case-edit-${id}}` 同一手法）。
- **保存前的确认框**（「作废」是本次唯一会丢数据的动作，必须让人先看清）：用 §4.3 的 `isSameRowTarget` 与 `caseId` 比较算出这次会作废的行，**非空时**用 `Modal.confirm` 列出它们（`agentKind · modelId · 原状态`）后才发 `PUT`；**只改执行模式 / 只改评分方式时什么都不作废，不弹**（无事发生却弹窗＝噪音，弹多了用户就会闭眼点确定，安全带的效力就此归零——与「开始」的确认框同一取舍）。表单提交入口因此从 `onSubmit` 直接提交改为「先 `preventDefault` 式地过一道确认」，`Modal.confirm` 的 `onOk` 里才真正调用 `onSubmit`。
- **既有的一个粗糙点不在本次修**：`judgeAgentConfigured` 这一格只看设置页的全局默认，不看**当前选中用例**的评分覆盖（创建路径已有同一偏差，服务端用的是 `resolveJudgeRoute` 的合并结果），于是用例级覆盖已配好时界面仍可能提示「设置页还没配」。两处口径要修就一起修，本次保持两处同形。

### 6.3 页面接线（`apps/web-next/app/runs/page.tsx`）

右栏由两种内容变三种：`?panel=detail|new|edit&id=…`。

- `apps/web-next/src/runs-view.ts`：`RunsPanelKind` 加 `'edit'`；`parseRunsPanel` 认 `edit`（**必须带非空 id**，缺 id 回落「不显示右栏」，与 detail 同一处置）；`runsPanelHref` 输出 `/runs?panel=edit&id=…`。未知 `panel` 值仍按「有 id 就是 detail」兜底，旧链接不白屏。
- 列表选中高亮从「`panel === 'detail'`」放宽到 `detail | edit`。
- 编辑面板的依赖与创建面板逐字相同（`cases` / `modelOptionsFor` / `judgeAgentConfigured` / `saving`），但 `saving` 用 `isUpdating`。
- 编辑成功 ⇒ `message.success('评测已保存')` + 回 `?panel=detail&id=`；删除成功 ⇒ 回 `/runs`（无右栏）+ `message.success`，`workspaceRemoved === false` 时补一句「行工作区有残留（被占用），可手动清理」。
- 与 `/cases` 的一处**有意差异**：runs 页右栏**不需要** `cases` 页 `go()` 里那套「复位仓库校验回显 / 维度」的临时状态（它没有跨面板残留的状态），所以本次不引入那层。

---

## 7. 数据层（`packages/client/client/src/runs.ts`）

- `useUpdateRun()`：`PUT ${runKey(id)}` → `mutate(runKey(id), updated, { revalidate: false })` + `await mutate(RUNS_KEY)`；
- `useDeleteRun()`：`DELETE` → `mutate(runKey(id), undefined, { revalidate: false })`（清详情缓存，照 `useDeleteCase` 口径）+ `await mutate(RUNS_KEY)`；
- 两个都**不用** `useSWRMutation`，走本文件既有的手工 `mutate` 形状——该文件头写明了两条理由（runId 是调用时才拿到的；写操作因此不进 SWR 的 fetcher，「窗口重新获得焦点 ⇒ 重发一次写请求」这条坑在形状上不存在）。两个 hook 从 client 包根导出。
- `api/src/index.ts` 的评测域转出加 `updateRun` / `deleteRun`（路由从 api 包根取它们）。⚠️ `api/src/runs.ts` 会新 import evaluator 的 `assertRunMutable` 与 `deleteRun`（后者按该文件既有约定别名成 `…InOrchestrator`），于是 **`apps/web-next/src/route-runs.test.ts` 对 `@aieval/evaluator` 的手写 mock 键清单必须跟着补**——缺键不是「用例红」，而是模块求值期直接抛「No … export is defined on the mock」（该文件头的修正 2/3 已记录这条坑两次）。

---

## 8. 测试与守卫

每条新增回归守卫都必须做**变异验证**（AGENT.md 硬要求）：把它要拦的缺陷人为制造回去，确认守卫**失败**，再还原并核对文件哈希未变。

| 层 | 用例 | 变异点（守卫要拦的缺陷） |
|---|---|---|
| contracts | `RunUpdateSchema`：id 可缺、可空、rows 至少一条；`hasLiveRows` 真值表（轮 running / 单行 running / 全终态 / 空行集合） | 判据漏掉 `run.status === 'running'`（轮已 running 但行状态还没翻的那一拍会放行） |
| contracts | `RunUpdate` 与 `RunCreate` 的**键集合差异只有 `rows[].id`** | 有人给创建入参也加上 id 并让服务端读它 |
| contracts | `isSameRowTarget`：三个字段各自变化都判 false；`providerName` / `baseUrl`（服务端快照）变化**不影响**判定 | 判据漏掉 `providerId`（换供应商不重置，新供应商背上旧分数） |
| evaluator / api | 只改执行模式 ⇒ 所有行**逐字**不变（含 score / diff / 计量 / attempts） | 把「不重置」写成「无条件重置」或反向，两边都要红 |
| evaluator / api | 改某行模型 ⇒ **只有那一行**重置，其余行逐字不变 | 重置范围写成「全部行」（静默丢分）；写成「不重置」（待开始的行挂着旧分数） |
| evaluator / api | 改用例 ⇒ 快照四格重取 + 全行重置 | 只改 `caseId` 不重取快照（详情卡显示旧仓库 / 旧 commit） |
| evaluator / api | 删行 ⇒ 从快照消失、其余行不变；patch 里带未知 id ⇒ `NOT_FOUND` | 未知 id 被静默当成新行 |
| evaluator / api | 新增行 ⇒ 新 id / `branch=test/{id}` / `workspacePath` 落在 `run.workspaceBase` 下 | `workspacePath` 用 `settings.workspaceRoot` 算（D13：产物裂成两半） |
| evaluator / api | `attempts` 归零；未重置的行 attempts 保留 | 重置时漏掉 attempts（新模型背旧账） |
| evaluator / api | 轮级状态收敛三条分支（全 judged / 没跑过 / 跑过又有待跑），且 `finishedAt` 各按口径 | 直接复用 `finalizeRun`（没跑过的轮次落 `partial`） |
| evaluator / api | 运行中 / 在途任务未收尾 ⇒ 409；校验失败 ⇒ 一个字节都不写 | 先写盘再校验（半份快照） |
| evaluator | `deleteRun`：先 run.json 后目录（顺序断言）、目录回收失败 ⇒ `workspaceRemoved:false` 且快照已删、删后 `getRun` 抛 404、根记忆被忘记 | 整目录一把删（顺序不可断言）；回收失败报成整体失败 |
| 路由 | `PUT` / `DELETE` 的 zod 解析、存在性、409/404 映射（照 `route-runs.test.ts` 既有形状，mock 句柄的手写键清单要补 `assertRunMutable` / `deleteRun`） | mock 缺键在模块求值期抛错的既有坑 |
| ui | 详情面板出现「编辑 / 删除」；`hasLiveRows` 时两者均禁用且有 Tooltip 原因；`Popconfirm` 的 `onConfirm` 回交 promise；编辑表单预填当前值**且带行 id**；预填的行集合与 `run.rows` 一一对应 | 编辑表单丢掉行 id（保存后全部当新行，静默丢分） |
| ui | 保存前确认框：会作废行时列出它们、确认后才提交；只改执行模式 / 评分方式时**不弹**直接提交 | 无条件弹（噪音，用户闭眼点确定）；该弹时不弹（静默丢分） |
| 页面接线 | `parseRunsPanel` / `runsPanelHref` 的三态（含 `edit` 缺 id 的回落）；编辑提交走 `update`、创建提交走 `create` 且**不带 id**；删除成功回 `/runs` | 创建路径把 id 一起发出去（服务端把创建当编辑读） |

---

## 9. 风险与待解

| # | 风险 | 处置 |
|---|---|---|
| R1 | 编辑后没重跑时，磁盘上留着**被改动行**的旧工作区与旧事件日志（D5 的代价） | 明确接受：删除整轮时一并回收；重跑时既有机制清。若要「编辑后立即干净」，那是 D5 的被否决项，需要有新的理由才能翻案 |
| R2 | 删行留下的孤儿目录同理 | 同上 |
| R3 | 编辑与「开始 / 重新评测 / 重新评分」的并发窗口 | 两道守卫：`hasLiveRows`（快照）+ 在途任务表（§5.2）；两者都在写盘前 |
| R4 | 改用例（或换模型）把行结果打掉，用户可能没预期 | §6.2 的保存前确认框列出**将被作废的那几行**（`agentKind · modelId · 原状态`），不弹的条件也写在同一节：只改执行模式 / 评分方式时什么都不作废，不弹 |
| R5 | 本轮留在旧根（用户改过工作区根）时删不掉 | 与读侧口径一致（R10 的直接推论），不是本次引入的缺口；在服务的返回文案里如实说「当前工作区根下找不到这一轮」 |

---

## 10. 非目标

- 编辑历史 / 撤销 / 审计（本仓没有审计面，做一半的撤销比不做更危险）；
- 编辑后自动重跑（编辑只改「这一轮应当长成什么样」）；
- 批量删除、多选、回收站；
- 单行的**结果恢复**（跑过但没跑成的行走既有的「重新评测 / 重新评分」两个出口；编辑只负责改「这一轮长什么样」，不负责重跑）；
- 给 `EvalRun` 加 `updatedAt`（§3 D12）；
- 删除用例级缓存仓库（`{workspaceRoot}/cases/{caseId}/cache`）——它不归某一轮所有。
