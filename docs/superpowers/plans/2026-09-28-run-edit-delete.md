# 评测详情「修改 / 删除」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给一轮评测补上「修改」（用例 / 执行模式 / 使用智能体评分 / 候选行的全量编辑）与「删除」（快照 + 全部产物）两个动作，形态与用例详情已有的「编辑 / 删除」对齐。

**Architecture:** 契约层加一个创建入参的**超集** `RunUpdateSchema`（候选行可带 `id`）与两个判据（`hasLiveRows` / `isSameRowTarget`）；api 层把创建的那段「校验链 + 供应商快照」抽成 `resolveRunRows` 供创建与编辑共用，编辑再用一个**纯函数** `planRunUpdate` 算新快照（行 id 对齐 → 原地重置 / 新增 / 删除 → 轮级状态收敛）；evaluator 提供互斥守卫 `assertRunMutable` 与两步删除 `deleteRun`；路由加 `PUT` / `DELETE`；client 加两个 hook；ui 侧详情卡加两个入口、创建面板加 `mode`；web-next 的右栏由两态变三态（`?panel=detail|new|edit`）。

**Tech Stack:** TypeScript 5（strict）、zod 3、Next.js App Router（Route Handlers）、SWR 2、antd 6 + React 19、vitest 4（node / jsdom 双配置）、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-28-run-edit-delete-design.md`（本计划是它的实现；两者冲突时以 spec 为准，并把冲突报告给发起人）

## Global Constraints

- 交流与所有用户可见文案一律**中文**；服务端抛 `ServiceError`，它的 `message` 必须可直接展示。
- 依赖方向（`AGENT.md` 的表）：`web-next → api / core / ui / client / contracts`；`api → evaluator / agents / core / contracts`；`ui → contracts`；`client → contracts`。**ui 层不许 import 数据层**（`@aieval/client`），**api 层不许 import 任何框架**。
- 源码一律 ESM：`require()` 被两处 lint 规则禁止。
- **提交时逐个显式 `git add <路径>`，禁止 `git add -A`**：本仓可能同时有别的会话在工作；`git status` 里不属于本次改动的文件**保持原样、不要动**。
- 每个任务收尾都要 `pnpm typecheck` → `pnpm lint` → 修掉所有错误 → 才 commit（`AGENT.md` 的顺序）。
- **新增的每条回归守卫都必须做变异验证**：把它要拦的缺陷人为制造回去，确认该守卫**失败**，再还原并核对文件哈希未变。
- 测试**不得触碰**真实 `~/.aieval` 与 `~/.runs`：配置目录用 `setConfigDirForTesting(dir)`，工作区根用临时目录。
- 两个汉字的按钮一律 `autoInsertSpace={false}`（否则可访问名变成「编 辑」/「删 除」）。
- 样式走 antd（主题 token / 紧凑密度 / 语义 `styles`）：**不手写字号、不手调行内边距**。
- `apps/web-next` **不能写 `.tsx` 测试**（该应用 `jsx: preserve`）：页面层只能写 `.ts` 的源码文本守卫。
- `EvalRun` 的既有字段**一个都不改**（本次不加任何新字段）。

## Review Focus

以下是 spec 隐含、但没有哪条任务的测试天然覆盖的输入 / 失败模式；每条都在「落在哪个任务」里补了**直接断言的用例**。

1. **原用例已被删除的轮次**：打开编辑表单时，用户看到的下拉不能是空白，且只改执行模式保存后 `caseId` 不能被悄悄换掉（真实路径：用例在另一个标签页被删）。→ Task 8 的 `原用例已被删除：下拉里补一个禁用的占位项，保存不会换掉 caseId`。
2. **把候选删到 0 行**：表单校验、`RunUpdateSchema` 的 `min(1)`、路由的 400 三层都要拦，且**一个字节都不许落盘**（半份快照比没有更坏）。→ Task 1 的 `至少一行：编辑不许把候选清空`、Task 3 的 `删掉一行：从快照消失，其余行不变`（它与「删到 0 行」共用同一条路径）、Task 5 的 `rows 为空的请求体 → 400`。
3. **两个标签页同时编辑同一轮**：后提交的那份可能引用**已经不存在**的行 id；此时必须 404 报出具体行，**不许**静默当新行（那会凭空多出一行用户没打算要的候选）。→ Task 3 的 `patch 里带未知行 id ⇒ NOT_FOUND` 与 Task 5 的 `未知的行 id → 404，且带出那个 id`。
4. **工作区根被改过的在途轮次**：这一轮记的是旧根（`workspaceBase`），新增行的工作区路径必须落在**旧根**下，否则这一轮的产物裂成两半且两边都不报错。→ Task 3 的 `新增一行：新 id / branch=test/{id} / workspacePath 落在 run.workspaceBase 下`。
5. **留在旧根、列表里看不到的轮次**：删除必须按「当前工作区根里可见」判定，找不到就 404，**绝不能**按名字去删当前根下的同名目录。→ Task 4 的 `deleteRun（api 层）· 不存在 ⇒ NOT_FOUND` 与 Task 2 的 `不存在的轮次 ⇒ NOT_FOUND（脏 URL 不能删到别的目录）`。

---

## Task 1: 契约 —— `RunUpdateSchema` / `hasLiveRows` / `isSameRowTarget`

**Files:**
- Modify: `packages/server/contracts/src/run.ts`（在 `RunCreateSchema` 之后加 `RunUpdateSchema`；在 `isRunningRow` 之后加两个判据）
- Modify: `packages/server/contracts/src/index.ts:59-83`（出口清单加四个名字）
- Test: `packages/server/contracts/src/run.test.ts`（文件末尾追加三个 `describe`）

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces:
  - `RunUpdateSchema: z.ZodType<RunUpdate>`，`type RunUpdate = { caseId: string; executionMode: ExecutionMode; useAgentJudge: boolean; rows: { id?: string; agentKind: AgentKind; providerId: string; modelId: string }[] }`
  - `hasLiveRows(run: EvalRun): boolean`
  - `isSameRowTarget(row: EvalRow, next: { agentKind: AgentKind; providerId: string; modelId: string }): boolean`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/server/contracts/src/run.test.ts` 末尾（`makeRow` 已在该文件顶部定义，直接用）：

```ts
/**
 * 编辑入参（2026-09-28）：创建入参的**超集**，差别只有候选行可带 `id`。
 * 为什么 id 必须存在：编辑表单要能说清「这一行还是原来那一行」——按位置对齐时「删掉第 2 行」
 * 会让第 3 行顶上来、它的成绩被错认成第 2 行的；按 (agent, model) 对齐时两行选同一个模型就无解。
 */
describe('RunUpdateSchema', () => {
  const base = {
    caseId: 'c-1',
    executionMode: 'serial',
    rows: [{ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' }],
  };

  it('不带 id 时与创建入参同形，且 useAgentJudge 缺省为 false', () => {
    const parsed = RunUpdateSchema.parse(base);
    expect(parsed.rows).toEqual(base.rows);
    expect(parsed.useAgentJudge).toBe(false);
  });

  it('候选行可带 id（指认原来那一行）；空串 id 被拒（它不是合法的行身份）', () => {
    expect(RunUpdateSchema.safeParse({ ...base, rows: [{ ...base.rows[0], id: 'row-1' }] }).success).toBe(true);
    expect(RunUpdateSchema.safeParse({ ...base, rows: [{ ...base.rows[0], id: '' }] }).success).toBe(false);
  });

  it('至少一行：编辑不许把候选清空（服务端与表单两层都要拦）', () => {
    expect(RunUpdateSchema.safeParse({ ...base, rows: [] }).success).toBe(false);
  });

  it('与 RunCreate 的差异只有 rows[].id：创建路径解析后**没有** id 这一格', () => {
    const withId = { ...base, rows: [{ ...base.rows[0], id: 'row-1' }] };
    // zod 的 z.object 默认 strip 未知键：创建入参即使带了 id，解析后也不会留下它
    expect(RunCreateSchema.parse(withId).rows[0]).toEqual(base.rows[0]);
    expect(RunUpdateSchema.parse(withId).rows[0]).toEqual({ ...base.rows[0], id: 'row-1' });
  });
});

/** 一轮快照（本组只关心轮级状态与行状态） */
function runWith(status: EvalRun['status'], rowStatuses: EvalRowStatus[]): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '用例',
    repoPath: 'D:/repos/demo',
    commitHash: null,
    repoBranch: null,
    status,
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: rowStatuses.map((rowStatus, index) => makeRow({ id: `row-${index + 1}`, status: rowStatus })),
    workspaceBase: 'D:/runs',
    createdAt: '2026-09-22T10:30:00.000Z',
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * `hasLiveRows`：编辑与删除**共用**的那一条判据（界面用它置灰、服务端用它抛 409）。
 * 「轮已 running、行状态还没翻」那一拍必须也在内——它正是 `startRun` 落状态与行开跑之间的窗口。
 */
describe('hasLiveRows', () => {
  it('轮 running ⇒ true，哪怕所有行都还是 pending（那一拍正好是「刚点了开始」）', () => {
    expect(hasLiveRows(runWith('running', ['pending', 'pending']))).toBe(true);
  });

  it('三种在途行状态各一档都 ⇒ true', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      expect(hasLiveRows(runWith('partial', ['judged', status]))).toBe(true);
    }
  });

  it('空闲（还没跑过 / 全终态）⇒ false', () => {
    expect(hasLiveRows(runWith('idle', ['pending', 'pending']))).toBe(false);
    expect(hasLiveRows(runWith('done', ['judged', 'failed']))).toBe(false);
    expect(hasLiveRows(runWith('partial', []))).toBe(false);
  });
});

/**
 * `isSameRowTarget`：服务端据此决定「这一行要不要重置」，编辑表单据此算「这次会作废哪几行」。
 * 两处必须同源：漂移的症状是「确认框说会作废 2 行、实际作废了 1 行」，而那是用户唯一能核对的地方。
 */
describe('isSameRowTarget', () => {
  const row = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' });

  it('三者逐字相同 ⇒ true', () => {
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(true);
  });

  it('三个字段各自变化都 ⇒ false（漏掉任何一个都会让那一行的旧分数留下来）', () => {
    expect(isSameRowTarget(row, { agentKind: 'claude-code', providerId: 'p-1', modelId: 'gpt-5' })).toBe(false);
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-2', modelId: 'gpt-5' })).toBe(false);
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5-mini' })).toBe(false);
  });

  it('服务端快照（providerName / baseUrl）不参与判定：供应商改名不算「换了被评对象」', () => {
    // 判据只看三个身份字段，其余字段（providerName / baseUrl / status / score…）一个都不看
    const renamed = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', providerName: '改过名的供应商', baseUrl: 'https://new.invalid/v1' });
    expect(isSameRowTarget(renamed, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(true);
  });
});
```

同时把新名字加进 import 列表（该文件顶部那段）：

```ts
  RunCreateSchema,
  RunUpdateSchema,
  TERMINAL_ROW_STATUSES,
  canRescoreRow,
  canRetryRow,
  hasLiveRows,
  isRunnableRow,
  isRunningRow,
  isSameRowTarget,
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/contracts test src/run.test.ts`
Expected: FAIL —— `RunUpdateSchema is not defined`（或 TS 报 `has no exported member`）

- [ ] **Step 3: 实现**

在 `packages/server/contracts/src/run.ts` 的 `RunCreate` 类型之后加：

```ts
/**
 * 编辑交回的「这一轮应当长成什么样」：与创建的差别只有候选行可带 `id`（指认原来那一行）。
 * 为什么是**超集**而不是另一个形状：编辑表单与创建表单是同一张（`RunCreatePanel` 的 `mode`），
 * 字段表必须共用一个真源；两份形状各写一遍必然漂移成「创建能改的编辑改不了」。
 * 创建路径**不读** `id`（`RunCreateSchema` 逐字不变），服务端也不会把带 id 的创建入参当编辑读。
 */
export const RunUpdateSchema = RunCreateSchema.extend({
  rows: z
    .array(
      z.object({
        /** 有 id = 原地更新这一行（并保留它的结果）；没有 = 新增一行 */
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

在 `isRunningRow` 之后加：

```ts
/**
 * 这一轮此刻还有活在跑吗（轮级 running，或任一行处于 preparing / running / judging）。
 *
 * 这是**编辑与删除共用**的那一条判据：两个动作的可用条件是同一条（「不在运行中」），
 * 做成 `canEditRun` / `canDeleteRun` 是假一对。判据放 contracts 的理由与
 * `isRunnableRow` / `isRunningRow` / `canRescoreRow` / `canRetryRow` 逐字相同：
 * 界面靠它决定按钮的 `disabled`、服务端靠同一份抛 `CONFLICT`——两处各写一份必然漂移，
 * 漂移的表现是「按钮可点、点下去 409」。
 *
 * 为什么轮级状态也要看：`startRun` 把 `status: 'running'` **同步**落库、而行要等各自的任务起来
 * 才翻状态，中间那一拍只有轮级状态能反映「已经在跑了」。它**不是**「有没有行跑过」，
 * 也**不是**「能不能重新评测」——那两条各有自己的判据。
 */
export function hasLiveRows(run: EvalRun): boolean {
  return run.status === 'running' || run.rows.some((row) => isRunningRow(row.status));
}

/**
 * 编辑交回的这一行与现有行还是不是同一件事（`agentKind` / `providerId` / `modelId` 逐字比较）。
 *
 * 为什么它必须在 contracts：这条判据有两个消费方——服务端的 `planRunUpdate` 用它决定重置哪一行，
 * 编辑表单用它**事先算出这次会作废哪几行**（保存前的确认框）。两处各写一份必然漂移，
 * 漂移的症状是「确认框说会作废 2 行，实际作废了 1 行」——而那正是用户唯一能核对的地方。
 * `providerName` / `baseUrl` 是服务端快照（供应商改名后它们会变），**不参与**判定：
 * 改个供应商名字不该把一行已经跑出来的成绩打掉。
 */
export function isSameRowTarget(
  row: EvalRow,
  next: { agentKind: AgentKind; providerId: string; modelId: string },
): boolean {
  return row.agentKind === next.agentKind && row.providerId === next.providerId && row.modelId === next.modelId;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/contracts test src/run.test.ts`
Expected: PASS（本文件全部用例，含既有的 `canRescoreRow` / `canRetryRow` 两组）

- [ ] **Step 5: 变异验证（三条守卫都要见红）**

逐条做，每做完一条立刻还原并核对文件哈希（`git diff --stat packages/server/contracts/src/run.ts` 必须干净）：

1. 把 `hasLiveRows` 的 `run.status === 'running' ||` 删掉 → `轮 running ⇒ true` 必须红；
2. 把 `isSameRowTarget` 的 `row.providerId === next.providerId &&` 删掉 → `providerId 变化 ⇒ false` 必须红；
3. 把 `RunUpdateSchema` 的 `rows` 元素里的 `id` 那一行删掉 → `候选行可带 id` 必须红。

- [ ] **Step 6: 补包根出口**

`packages/server/contracts/src/index.ts` 的 `./run` 出口清单里（`RunCreateSchema,` 之后、`TERMINAL_ROW_STATUSES,` 之前，以及两个判据的字母序位置）加：

```ts
  RunUpdateSchema,
  hasLiveRows,
  isSameRowTarget,
  type RunUpdate,
```

- [ ] **Step 7: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
```

Expected: 两条命令都以 0 退出（`pnpm lint` 若报格式问题，用 `pnpm --filter <包> exec eslint --fix <文件>` 就地修，**不要**提交未修的格式问题）。

```bash
git add packages/server/contracts/src/run.ts packages/server/contracts/src/run.test.ts packages/server/contracts/src/index.ts
git commit -m "feat(contracts): 编辑入参 RunUpdateSchema 与两个判据（hasLiveRows / isSameRowTarget）"
```

---

## Task 2: evaluator —— `forgetRunRoot` / `assertRunMutable` / `deleteRun`

**Files:**
- Modify: `packages/server/evaluator/src/run-root-memory.ts`（末尾加 `forgetRunRoot`）
- Modify: `packages/server/evaluator/src/orchestrator.ts`（imports + 两个新函数，放在 `retryRow` 那一组在途任务表之后）
- Modify: `packages/server/evaluator/src/index.ts:19-29`（出口加两个名字）
- Modify: `packages/server/evaluator/src/index.test.ts:14-42`（导出面完整集合）
- Test: `packages/server/evaluator/src/run-delete.test.ts`（新建）

**Interfaces:**
- Consumes: `hasLiveRows`（Task 1）、`runDir` / `runSnapshotFile`（`@aieval/core` 已有）、`getRunForWrite` / `saveRun`（本包）
- Produces:
  - `forgetRunRoot(runId: string): void`（**不**从包根出口，只在包内用）
  - `assertRunMutable(runId: string): void`（在途任务未收尾时抛 `ServiceError('CONFLICT', …)`）
  - `deleteRun(runId: string): { workspaceRemoved: boolean }`

- [ ] **Step 1: 写失败的测试**

新建 `packages/server/evaluator/src/run-delete.test.ts`：

```ts
// @vitest-environment node
/**
 * 删除一轮评测（spec §5.3）：① 删快照 ② 回收整个 `{workspaceBase}/{runId}/` ③ 忘掉根记忆。
 *
 * 为什么单独一个文件而不是塞进 orchestrator.test.ts：本文件要 mock `node:fs` 的 `rmSync`
 * 造「回收失败」那一支（真实成因无法在 CI 上稳定造出：Windows 上需要文件被占用），
 * 而与 run-store.test.ts 一样，模块级 `vi.mock('node:fs')` 的影响面越小越好。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError } from '@aieval/contracts';
import { rowEventsFile, runDir, runSnapshotFile } from '@aieval/core';
import { deleteRun } from './orchestrator';
import { recalledRunRoot } from './run-root-memory';
import { getRun, saveRun } from './run-store';
import { createTempHome, makeRowFixture, makeRunFixture, type TempHome } from './testing/fixtures';

// 只把 rmSync 换成可注入的替身（默认原样透传）：真实文件系统照常走，
// 「回收失败」那一支由用例显式装上一个只在 recursive 调用上抛的实现。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

/** 取抛出的错误（断言 code 时必须拿到对象本身） */
function thrownBy(action: () => unknown): unknown {
  try {
    action();
    return undefined;
  } catch (error) {
    return error;
  }
}

let home: TempHome;

beforeEach(() => {
  // 上一轮用例可能装了粘性实现；mockReset 还原成 `vi.fn(actual.rmSync)`
  vi.mocked(rmSync).mockReset();
  home = createTempHome();
});

afterEach(() => {
  // 先复位再 cleanup：cleanup 自己也要 rmSync，带着替身会把它拖红
  vi.mocked(rmSync).mockReset();
  home.cleanup();
});

/**
 * 落盘一轮评测，并给它造出「行工作区 + 事件日志」——删除要回收的正是这些。
 * 行 id 由夹具自己生成（`makeRowFixture` 的 branch 与 id 自洽），不用手抄。
 */
function seedRunOnDisk(): { runId: string; runDirPath: string; rowId: string } {
  const row = makeRowFixture();
  const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row] });
  saveRun(run);
  const dir = runDir(home.workspaceRoot, run.id);
  mkdirSync(join(dir, 'rows', row.id, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'rows', row.id, 'workspace', 'README.md'), '# 产物\n', 'utf8');
  writeFileSync(rowEventsFile(home.workspaceRoot, run.id, row.id), '{"type":"log"}\n', 'utf8');
  return { runId: run.id, runDirPath: dir, rowId: row.id };
}

describe('deleteRun', () => {
  it('删掉快照与整个运行目录，并把这一轮从根记忆里忘掉', () => {
    const { runId, runDirPath, rowId } = seedRunOnDisk();
    // 写盘时登记过记忆（saveRun 的职责），删除的正是它
    expect(recalledRunRoot(runId)).toBe(home.workspaceRoot);
    expect(existsSync(runSnapshotFile(home.workspaceRoot, runId))).toBe(true);
    expect(existsSync(join(runDirPath, 'rows', rowId, 'workspace', 'README.md'))).toBe(true);

    const result = deleteRun(runId);

    expect(result.workspaceRemoved).toBe(true);
    expect(existsSync(runDirPath)).toBe(false);
    // 删干净之后 getRun 必须抛 NOT_FOUND（列表 / 详情都不该再看到它）
    const error = thrownBy(() => getRun(runId));
    expect(error).toBeInstanceOf(ServiceError);
    expect((error as ServiceError).code).toBe('NOT_FOUND');
    // 记忆必须一起失效：否则 getRunForWrite 的兜底会把「找不到」答成一条旧根路径
    expect(recalledRunRoot(runId)).toBeUndefined();
  });

  it('有行在跑 ⇒ CONFLICT，且一个字节都不删', () => {
    const { runId, runDirPath } = seedRunOnDisk();
    const running = { ...getRun(runId), status: 'running' as const };
    saveRun(running);

    const error = thrownBy(() => deleteRun(runId));

    expect((error as ServiceError).code).toBe('CONFLICT');
    expect((error as ServiceError).message).toContain('运行');
    expect(existsSync(runSnapshotFile(home.workspaceRoot, runId))).toBe(true);
    expect(existsSync(runDirPath)).toBe(true);
  });

  it('不存在的轮次 ⇒ NOT_FOUND（脏 URL 不能删到别的目录）', () => {
    const error = thrownBy(() => deleteRun('nope'));
    expect((error as ServiceError).code).toBe('NOT_FOUND');
  });

  it('回收失败：快照照样删掉，结果里如实说 workspaceRemoved: false', async () => {
    const { runId, runDirPath } = seedRunOnDisk();
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    // 只让「回收整目录」那一次失败（`recursive: true`）：删快照那一笔必须照常成功
    vi.mocked(rmSync).mockImplementation(((target: Parameters<typeof rmSync>[0], options?: Parameters<typeof rmSync>[1]) => {
      if (options?.recursive === true) throw new Error('EPERM: 行工作区被占用');
      return real.rmSync(target, options);
    }) as typeof rmSync);

    const result = deleteRun(runId);

    expect(result.workspaceRemoved).toBe(false);
    // 用户要的那件事（这一轮消失）已经达成：快照没了、列表干净
    expect(existsSync(runSnapshotFile(home.workspaceRoot, runId))).toBe(false);
    // 回收失败不等于删除失败：目录残留是磁盘问题，不是「删除没生效」
    expect(existsSync(runDirPath)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/evaluator test src/run-delete.test.ts`
Expected: FAIL —— `deleteRun is not a function`（导入为 undefined）

- [ ] **Step 3: 实现 `forgetRunRoot`**

`packages/server/evaluator/src/run-root-memory.ts` 末尾加：

```ts
/**
 * 忘掉这一轮（**唯一**该主动失效的时刻：删除评测）。
 *
 * 为什么删除必须忘：`getRunForWrite` 只在「当前根里找不到」时才查记忆——而「找不到」正是删除之后
 * 的形状，于是记忆会把一次「找不到」答成一条旧根路径，`deleteRun` 自己的存在性检查也就形同虚设。
 * 其它时刻常驻、不需要失效的三条理由见文件头；本函数不改变那三条中的任何一条。
 */
export function forgetRunRoot(runId: string): void {
  runRoots.delete(runId);
}
```

- [ ] **Step 4: 实现 `assertRunMutable` 与 `deleteRun`**

`packages/server/evaluator/src/orchestrator.ts` 的 import 区：

```ts
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
```

`@aieval/contracts` 的 import 里加 `hasLiveRows`（与 `canRescoreRow` / `canRetryRow` 同段、按字母序放 `canRetryRow` 之后）。

`@aieval/core` 的 import 里加两个名字（与 `rowEventsFile` 同段、按字母序）：

```ts
  rowEventsFile,
  runDir,
  runSnapshotFile,
```

新增一行 import（放在 `./run-store` 那行之后）：

```ts
import { forgetRunRoot } from './run-root-memory';
```

在 `retryTasks` 声明之后（`retryRow` 之前）加：

```ts
/** 这一轮还有没有「上一次的运行还没收尾」的任务：轮级任务 + 行级三条在途表 */
function hasUnsettledWork(runId: string): boolean {
  if (runTasks.has(runId)) return true;
  const prefix = `${runId}:`;
  for (const key of [...retryTasks.keys(), ...rescoreTasks.keys(), ...rowAborts.keys()]) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 「这一轮此刻可以被改 / 被删吗」的纵深守卫：还有在途任务就抛 `CONFLICT`。
 *
 * 为什么 `hasLiveRows` 之外还要它：那条判据读的是**快照**，而行刚落终态、任务还在收尾
 * （`finally` 还没跑）的那一拍，快照上确实「没有活」。这条守卫与 `retryRow` 里既有的那条
 * （`rowAborts.has(key) || retryTasks.has(key)`）同源，只是把范围从「这一行」放大到「这一轮」。
 */
export function assertRunMutable(runId: string): void {
  if (hasUnsettledWork(runId)) {
    throw new ServiceError('CONFLICT', `这一轮上一次的运行还没收尾（${runId}）：请稍候再试，或先终止它`);
  }
}

/**
 * 删除一轮评测：**分两步且顺序是承重的**（spec §5.3）。
 *   ① 删 `run.json` —— 这是用户按下去要的那件事（列表立刻干净）。快照是列表的唯一真相源，
 *      先删它，就永远不可能出现「回收失败了但这一轮还在列表里」这种半吊子状态。
 *   ② `rmSync` 整个 `{workspaceBase}/{runId}/` —— 回收行工作区与事件日志。
 *      为什么不整目录一把删：`rmSync` 的内部遍历顺序不保证，中途 EPERM 会让
 *      「快照到底删没删」变成不确定。拆开之后，①的结果是确定的。
 *
 * ②失败**只 WARN 并如实回报**（`workspaceRemoved: false`），不报成删除失败：与 `removeCaseCache`
 * 同一处置精神——快照已删＝用户要的结果已达成，剩下的失败是磁盘回收问题（Windows 上文件被占用）；
 * 报成「删除失败」会让用户再点一次，而那一轮已经不存在了，他只会拿到 404。
 *
 * 路径取 `run.workspaceBase`（这一轮**自己**记录的根）而不是当前 `settings.workspaceRoot`：
 * 用户在评测期间改过工作区根目录时，这一轮连读都读不到（`getRun` 只扫当前根 ⇒ 上面先抛 NOT_FOUND），
 * 更不该按当前根去猜一个可能同名、却属于别人的目录。
 */
export function deleteRun(runId: string): { workspaceRemoved: boolean } {
  const run = getRunForWrite(runId);
  if (hasLiveRows(run)) {
    throw new ServiceError('CONFLICT', `这一轮还有候选行在运行（${runId}）：请先终止它，再删除`);
  }
  assertRunMutable(runId);

  const dir = runDir(run.workspaceBase, runId);
  const snapshot = runSnapshotFile(run.workspaceBase, runId);
  try {
    rmSync(snapshot, { force: true });
  } catch (error) {
    // 快照删不掉＝用户要的那件事没发生：必须如实抛（中文原因，与 saveRun 的失败面同口径）
    throw new ServiceError(
      'INTERNAL',
      `评测快照删除失败（${snapshot}）：${error instanceof Error ? error.message : String(error)}`,
      { cause: error, context: { runId, snapshot } },
    );
  }
  // 快照没了就把记忆一起清掉：留着它，`getRunForWrite` 还会把这一轮解析回旧根
  forgetRunRoot(runId);

  let workspaceRemoved = true;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    workspaceRemoved = false;
    log.warn('行工作区回收失败（评测已删除，产物残留）', {
      dir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  log.info('评测已删除', { runId, workspaceRemoved, workspaceBase: run.workspaceBase });
  return { workspaceRemoved };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/evaluator test src/run-delete.test.ts`
Expected: PASS（4 条）

- [ ] **Step 6: 变异验证**

1. 把 `deleteRun` 里的 `rmSync(snapshot, { force: true })` 改成 `rmSync(dir, { recursive: true, force: true })`（整目录一把删）→ `回收失败：快照照样删掉` 必须红（快照先被删、或直接抛）；
2. 把 `forgetRunRoot(runId)` 删掉 → `删掉快照与整个运行目录` 里的 `recalledRunRoot(runId)` 断言必须红；
3. 把 `hasLiveRows(run)` 那个 if 删掉 → `有行在跑 ⇒ CONFLICT` 必须红。

- [ ] **Step 7: 补出口与导出面守卫**

`packages/server/evaluator/src/index.ts` 的 `./orchestrator` 出口加两个名字（按字母序）：

```ts
export {
  abortRow,
  abortRun,
  assertRunMutable,
  deleteRun,
  drainRunningTasks,
  recoverInterruptedRuns,
  rescoreRow,
  retryRow,
  startRun,
} from './orchestrator';
```

`packages/server/evaluator/src/index.test.ts` 的完整集合里加两行：

```ts
        // 评测的「修改 / 删除」（2026-09-28）：api 层的 updateRun / deleteRun 从本包取它们
        'assertRunMutable',
        'deleteRun',
```

- [ ] **Step 8: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @aieval/evaluator test
```

Expected: 全部 0 退出（本包的既有用例也一并跑一遍——`hasUnsettledWork` 读的三张表是既有测试在用的共享状态）。

```bash
git add packages/server/evaluator/src/run-root-memory.ts packages/server/evaluator/src/orchestrator.ts packages/server/evaluator/src/index.ts packages/server/evaluator/src/index.test.ts packages/server/evaluator/src/run-delete.test.ts
git commit -m "feat(evaluator): 评测的互斥守卫与两步删除（assertRunMutable / deleteRun）"
```

---

## Task 3: api —— `resolveRunRows` 抽取 + `planRunUpdate` 纯函数

**Files:**
- Modify: `packages/server/api/src/runs.ts`（`createRun` 的每行投影改成调 `resolveRunRows`；文件末尾加两个导出）
- Test: `packages/server/api/src/runs.test.ts`（追加一个 `describe`）

**Interfaces:**
- Consumes: `RunUpdate` / `RunCreate` / `isSameRowTarget` / `EvalRow` / `EvalRun` / `Provider`（contracts）、`rowWorkspaceDir`（core）
- Produces:
  - `interface ResolvedRunRow { id?: string; agentKind: AgentKind; providerId: string; providerName: string; baseUrl: string; modelId: string }`
  - `resolveRunRows(rows: RunUpdate['rows'], providers: readonly Provider[]): ResolvedRunRow[]`
  - `interface RunTargetCase { caseId: string; caseTitle: string; repoPath: string; commitHash: string | null; repoBranch: string | null }`
  - `planRunUpdate(run: EvalRun, input: RunUpdate, resolved: readonly ResolvedRunRow[], target: RunTargetCase): EvalRun`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/server/api/src/runs.test.ts` 末尾（该文件已有 `makeRow` / `makeRun` / `makeAnthropicProvider` / `makeProvider` 夹具）：

```ts
/**
 * `planRunUpdate`：编辑的**逐行处置**（spec §5.1 的那张表）。
 * 这是本功能最容易写错的一处——「多重置一行」等于静默丢分，「少重置一行」等于让待开始的行挂着旧分。
 * 故它被抽成纯函数并在这里**直接**测，不走 HTTP（间接断言盖不住「哪一行被重置了」）。
 */
describe('planRunUpdate', () => {
  const providers = [makeAnthropicProvider(), makeProvider()];
  /** 造一条「跑过且有结果」的行：重置与否一看便知 */
  const judgedRow = (id: string, overrides: Partial<EvalRow> = {}): EvalRow =>
    makeRow({
      id,
      status: 'judged',
      baselineCommit: 'a'.repeat(40),
      tokens: { input: 10, cached: 1, output: 20 },
      turns: 3,
      durationMs: 1_000,
      diff: { filesChanged: 1, insertions: 2, deletions: 0, truncated: false },
      score: {
        dimensions: [],
        totalScore: 80,
        verdict: '好',
        raw: '{}',
        judgeProviderId: 'p-anthropic',
        judgeModelId: 'claude-opus-4-6',
        judgedAt: '2026-09-22T09:00:00.000Z',
        judgeAgentKind: null,
      },
      attempts: 2,
      ...overrides,
    });

  const target: RunTargetCase = {
    caseId: 'c-1',
    caseTitle: '用例标题',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
  };

  it('只改执行模式：所有行逐字不变（含分数 / diff / 计量 / attempts）', () => {
    const row = judgedRow('r-1');
    const run = makeRun({ rows: [row], executionMode: 'parallel' });
    const input = {
      caseId: 'c-1',
      executionMode: 'serial' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    expect(next.executionMode).toBe('serial');
    expect(next.rows).toEqual([row]);
    // 轮级状态跟着行集合收敛：全 judged ⇒ done
    expect(next.status).toBe('done');
  });

  it('改某行模型：**只有那一行**重置，其余行逐字不变', () => {
    const changed = judgedRow('r-1');
    const untouched = judgedRow('r-2');
    const run = makeRun({ rows: [changed, untouched] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' },
        { id: 'r-2', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
      ],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    const reset = next.rows.find((row) => row.id === 'r-1');
    expect(reset?.status).toBe('pending');
    expect(reset?.score).toBeNull();
    expect(reset?.diff).toBeNull();
    expect(reset?.tokens).toBeNull();
    expect(reset?.turns).toBeNull();
    expect(reset?.durationMs).toBeNull();
    expect(reset?.baselineCommit).toBe('');
    expect(reset?.attempts).toBe(0);
    // 行身份稳定：id / 分支 / 工作区路径一个字都不变（原地重置，spec §3 D4）
    expect(reset?.branch).toBe(changed.branch);
    expect(reset?.workspacePath).toBe(changed.workspacePath);
    // 服务端快照跟着新供应商走
    expect(reset?.providerName).toBe('OpenAI 网关');
    expect(reset?.baseUrl).toBe('https://gw.example.com/v1');
    // 没被碰的那一行逐字不变
    expect(next.rows.find((row) => row.id === 'r-2')).toEqual(untouched);
    // attempts 归零的理由：换了被评对象，旧模型的账不能算到新模型头上（与 retryRow 刻意不清零相反）
    expect(next.status).toBe('partial');
  });

  it('新增一行：新 id / branch=test/{id} / workspacePath 落在 run.workspaceBase 下', () => {
    const run = makeRun({ workspaceBase: 'D:\\runs-old', rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    const added = next.rows[1];
    expect(added?.status).toBe('pending');
    expect(added?.attempts).toBe(0);
    expect(added?.baselineCommit).toBe('');
    expect(added?.branch).toBe(`test/${added?.id ?? ''}`);
    // ⚠️ 必须落在**这一轮自己记录的根**下：用当前 settings.workspaceRoot 算会让产物裂成两半（spec §3 D13）
    expect(added?.workspacePath).toBe(rowWorkspaceDir('D:\\runs-old', run.id, added?.id ?? ''));
    expect(next.status).toBe('partial');
  });

  it('删掉一行：从快照消失，其余行不变', () => {
    const run = makeRun({ rows: [judgedRow('r-1'), judgedRow('r-2')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-2', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    expect(next.rows.map((row) => row.id)).toEqual(['r-2']);
  });

  it('patch 里带未知行 id ⇒ NOT_FOUND（不许静默当新行：那会凭空多出一行用户没打算要的候选）', () => {
    const run = makeRun({ rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-404', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    expect(() => planRunUpdate(run, input, resolveRunRows(input.rows, providers), target)).toThrowError(/r-404/);
  });

  it('换来用例：重取四格快照，且**所有行**重置（题面与基线都变了）', () => {
    const run = makeRun({ caseId: 'c-1', caseTitle: '旧标题', repoPath: 'D:\\old', rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-2',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };
    const newCase: RunTargetCase = {
      caseId: 'c-2',
      caseTitle: '新标题',
      repoPath: 'D:\\new',
      commitHash: 'b'.repeat(40),
      repoBranch: 'feat/x',
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), newCase);

    expect([next.caseId, next.caseTitle, next.repoPath, next.commitHash, next.repoBranch]).toEqual([
      'c-2', '新标题', 'D:\\new', 'b'.repeat(40), 'feat/x',
    ]);
    // 目标一个字都没变，但题面变了 ⇒ 照样重置
    expect(next.rows[0]?.status).toBe('pending');
    expect(next.rows[0]?.score).toBeNull();
    expect(next.rows[0]?.attempts).toBe(0);
  });

  it('轮级状态收敛三条分支（没跑过 ⇒ idle / 跑过又有待跑 ⇒ partial / 全 judged ⇒ done 且保留 finishedAt）', () => {
    const pending = makeRow({ id: 'r-1', status: 'pending', baselineCommit: '', attempts: 0 });
    const untouchedRows = [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }];
    const input = { caseId: 'c-1', executionMode: 'parallel' as const, useAgentJudge: false, rows: untouchedRows };
    const resolved = resolveRunRows(input.rows, providers);

    const neverStarted = planRunUpdate(makeRun({ rows: [pending], status: 'idle', startedAt: null }), input, resolved, target);
    expect(neverStarted.status).toBe('idle');
    expect(neverStarted.finishedAt).toBeNull();

    const ranBefore = planRunUpdate(
      makeRun({ rows: [judgedRow('r-1')], status: 'done', startedAt: '2026-09-22T08:00:00.000Z', finishedAt: '2026-09-22T09:00:00.000Z' }),
      { ...input, rows: [{ ...untouchedRows[0]!, agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' }] },
      resolveRunRows([{ agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' }], providers),
      target,
    );
    expect(ranBefore.status).toBe('partial');
    expect(ranBefore.finishedAt).toBeNull();

    const stillDone = planRunUpdate(
      makeRun({ rows: [judgedRow('r-1')], status: 'done', startedAt: '2026-09-22T08:00:00.000Z', finishedAt: '2026-09-22T09:00:00.000Z' }),
      input,
      resolved,
      target,
    );
    expect(stillDone.status).toBe('done');
    expect(stillDone.finishedAt).toBe('2026-09-22T09:00:00.000Z');
  });

  it('resolveRunRows：供应商不存在 / 模型不在清单 / 协议不匹配三条各自抛出（与创建同一份）', () => {
    const bad = (providerId: string, modelId: string) => [{ agentKind: 'codex' as const, providerId, modelId }];
    expect(() => resolveRunRows(bad('p-gone', 'gpt-5'), providers)).toThrowError(/p-gone/);
    expect(() => resolveRunRows(bad('p-openai', 'nope'), providers)).toThrowError(/模型清单/);
    expect(() => resolveRunRows([{ agentKind: 'claude-code' as const, providerId: 'p-openai', modelId: 'gpt-5' }], providers)).toThrowError(/协议/);
  });
});
```

该文件的 import 顶部补上新名字（含 `rowWorkspaceDir`）：

```ts
import { rowWorkspaceDir, setConfigDirForTesting } from '@aieval/core';
```

并把 `planRunUpdate`、`resolveRunRows`、`type RunTargetCase` 从 `./runs` 引入，`type EvalRow` 从 `@aieval/contracts` 引入。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/api test src/runs.test.ts`
Expected: FAIL —— `planRunUpdate is not a function`

- [ ] **Step 3: 把创建的那段投影抽成 `resolveRunRows`**

在 `packages/server/api/src/runs.ts` 里，把 `createRun` 里 `input.rows.map(...)` 那段的**校验三连**换掉，并新增两个导出。先从 import 里补 `type Provider` 与 `isSameRowTarget`、`type RunUpdate`：

```ts
import {
  AGENT_KINDS,
  PROTOCOL_LABELS,
  ServiceError,
  isRunnableRow,
  isSameRowTarget,
  type AgentKind,
  type EvalRow,
  type EvalRun,
  type Provider,
  type ProtocolType,
  type RunCreate,
  type RunUpdate,
} from '@aieval/contracts';
```

新增（放在 `createRun` 之前）：

```ts
/** 校验链解析出来的一行：候选行本身 + 服务端快照（供应商名 / baseUrl）+ 编辑才有的原行 id */
export interface ResolvedRunRow {
  /** 编辑时指认「原来那一行」；创建路径恒为 undefined */
  id?: string;
  agentKind: AgentKind;
  providerId: string;
  providerName: string;
  baseUrl: string;
  modelId: string;
}

/**
 * 候选行的校验链 + 供应商快照：**创建与编辑共用一份**。
 * 顺序逐字沿用创建时的口径（供应商存在 → 模型在该供应商清单里 → 协议兼容）：顺序反了会把
 * 「供应商不存在」报成「模型不存在」，让用户往错误的方向排查。
 * 三个判定**都不在这里重写**：协议判据来自 agents 注册表元数据（spec §5.6.2 A3），
 * 本文件里没有「哪家智能体配哪种协议」的映射表。
 */
export function resolveRunRows(
  rows: RunUpdate['rows'],
  providers: readonly Provider[],
): ResolvedRunRow[] {
  return rows.map((row) => {
    const provider = providers.find((item) => item.id === row.providerId);
    if (provider === undefined) {
      throw new ServiceError('NOT_FOUND', `供应商不存在或已被删除（${row.providerId}），请重新选择模型`);
    }
    if (!provider.models.some((model) => model.id === row.modelId)) {
      throw new ServiceError(
        'NOT_FOUND',
        `供应商「${provider.name}」的模型清单里没有 ${row.modelId}，请重新选择，或到设置里为它补上这个模型`,
      );
    }
    const { displayName, metadata } = getProvider(row.agentKind);
    if (metadata.protocolType !== provider.protocolType) {
      throw new ServiceError(
        'CONFLICT',
        `${displayName} 只接受${PROTOCOL_LABELS[metadata.protocolType]}协议的供应商，而「${provider.name}」是${PROTOCOL_LABELS[provider.protocolType]}协议`,
      );
    }
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      agentKind: row.agentKind,
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: provider.baseUrl,
      modelId: row.modelId,
    };
  });
}
```

`createRun` 里的 `const rows: EvalRow[] = input.rows.map((row) => { … })` 整段替换成：

```ts
  const rows: EvalRow[] = resolveRunRows(input.rows, providers).map((row) => {
    const rowId = randomUUID();
    return {
      id: rowId,
      agentKind: row.agentKind,
      providerId: row.providerId,
      providerName: row.providerName,
      baseUrl: row.baseUrl,
      modelId: row.modelId,
      status: 'pending',
      branch: `test/${rowId}`,
      // 工作区路径在创建时就能算出来：编排层建目录时用的是同一个 core 函数，不会漂移。
      // 落进去省掉「还没准备」这一种额外的空值状态（按需读产物时要按它定位）。
      workspacePath: rowWorkspaceDir(settings.workspaceRoot, runId, rowId),
      // 基线在准备阶段才解析成 40 位 hash（§11 R2），创建时还没有
      baselineCommit: '',
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
      // 还没跑过 ⇒ 0 次尝试（契约里这一格的缺省值也是 0，显式写出来是为了让落盘物自解释）
      attempts: 0,
    };
  });
```

- [ ] **Step 4: 实现 `planRunUpdate`**

追加到 `packages/server/api/src/runs.ts` 末尾：

```ts
/** 编辑时这一轮指向的用例（四格冗余快照的来源，spec §7.2） */
export interface RunTargetCase {
  caseId: string;
  caseTitle: string;
  repoPath: string;
  commitHash: string | null;
  repoBranch: string | null;
}

/**
 * 重置一行：保留行身份（id / 分支 / 工作区路径），清掉它的全部结果。
 *
 * 为什么必须清干净而不是只把 status 打回 pending：留着一份旧分数，界面就会出现
 * 「待开始的行挂着上一轮的分数」——正是本仓最反对的「把旧数据渲染成新数据」。
 * `attempts` **也清零**，与 `retryRow` 刻意不清零**相反**：重试重跑的是同一件事（同一模型、同一用例），
 * 尝试次数是那一行的累计事实；而编辑换掉的是**被评对象**，留着「尝试 3 次」等于让新模型凭空背上
 * 旧模型的账（编排层的注释写明了 retryRow 那一条的理由，两处的差别是刻意的）。
 */
function resetRow(current: EvalRow, row: ResolvedRunRow): EvalRow {
  return {
    ...current,
    agentKind: row.agentKind,
    providerId: row.providerId,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    status: 'pending',
    baselineCommit: '',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    attempts: 0,
  };
}

/**
 * 新增一行：新 id、新分支、新工作区路径，其余字段与 `createRun` 的行初值逐字相同。
 *
 * ⚠️ `workspacePath` 必须按 **`run.workspaceBase`**（这一轮自己记录的根）算，**不能**用当前
 * `settings.workspaceRoot`：`prepareRowWorkspace` 拿的就是 `run.workspaceBase`，按当前设置算会让新行
 * 的工作区落在另一个根里——这一轮的产物裂成两半，而两边都不报错（spec §3 D13 / run-store 口径 4）。
 */
function newRow(run: EvalRun, row: ResolvedRunRow): EvalRow {
  const rowId = randomUUID();
  return {
    id: rowId,
    agentKind: row.agentKind,
    providerId: row.providerId,
    providerName: row.providerName,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    status: 'pending',
    branch: `test/${rowId}`,
    workspacePath: rowWorkspaceDir(run.workspaceBase, run.id, rowId),
    baselineCommit: '',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    attempts: 0,
  };
}

/**
 * 编辑之后的轮级状态（spec §5.1 口径 3）。
 * **不复用编排层的 `finalizeRun`**：它对「全行 pending」会落 `partial`，把一个从没跑过的轮次
 * 显示成「部分完成」。三条分支：
 *   · 全行 judged ⇒ `done`（`finishedAt` 已是非 null 就保留原值，否则填当前时刻）；
 *   · 一次都没跑过（`startedAt === null`）⇒ `idle`、`finishedAt = null`；
 *   · 其余（跑过一轮、现在又有行待跑）⇒ `partial`、`finishedAt = null`。
 */
function settleRunAfterEdit(run: EvalRun, rows: readonly EvalRow[], now: string): Pick<EvalRun, 'status' | 'finishedAt'> {
  const allJudged = rows.length > 0 && rows.every((row) => row.status === 'judged');
  if (allJudged) return { status: 'done', finishedAt: run.finishedAt ?? now };
  if (run.startedAt === null) return { status: 'idle', finishedAt: null };
  return { status: 'partial', finishedAt: null };
}

/**
 * 算「编辑之后这一轮长什么样」（spec §5.1 的逐行处置表）：行对齐 → 原地重置 / 新增 / 删除 → 轮级收敛。
 *
 * 纯函数：不读盘、不查配置与注册表、**不写盘**（调用方负责 `saveRun`）。唯一的外部状态是
 * 新增行的 `randomUUID()` 与时间戳——用例对新增行只断言「id 非空且不等于任何原行 id」。
 * 抽出它的理由：页面与组件层的间接断言盖不住「哪一行被重置了」，这条规则必须能被**直接**测到。
 *
 * 行对齐的**唯一键是行 id**（spec §3 D3）：
 *   · 带 id 且命中 ⇒ 原地更新（目标没变就逐字保留，变了就重置）；
 *   · 带 id 但不命中 ⇒ `NOT_FOUND`，**不静默当新行**（静默会造出一行用户没打算要的候选）；
 *   · 不带 id ⇒ 新增；
 *   · 现有行不在入参里 ⇒ 删除（从快照移除；它的磁盘产物留给整轮删除时回收）。
 * 「改了才重置」按**值**判：表单交回来的永远是全量行集合，按「字段出现没有」判会把每次保存
 * 都变成全行清空重来（与 `updateCase` 同口径，判据是 contracts 的 `isSameRowTarget`）。
 */
export function planRunUpdate(
  run: EvalRun,
  input: RunUpdate,
  resolved: readonly ResolvedRunRow[],
  target: RunTargetCase,
): EvalRun {
  const caseChanged = target.caseId !== run.caseId;
  const currentById = new Map(run.rows.map((row) => [row.id, row]));

  const rows: EvalRow[] = resolved.map((row) => {
    const current = row.id === undefined ? undefined : currentById.get(row.id);
    if (row.id !== undefined && current === undefined) {
      throw new ServiceError('NOT_FOUND', `该评测里没有这一行（${row.id}），请刷新后重试`, {
        context: { runId: run.id, rowId: row.id },
      });
    }
    if (current === undefined) return newRow(run, row);
    // 换用例 ⇒ 题面与基线都变了，**所有行**作废；否则只看这一行的目标变没变
    if (caseChanged || !isSameRowTarget(current, row)) return resetRow(current, row);
    return current;
  });

  const now = new Date().toISOString();
  return {
    ...run,
    caseId: target.caseId,
    caseTitle: target.caseTitle,
    repoPath: target.repoPath,
    commitHash: target.commitHash,
    repoBranch: target.repoBranch,
    executionMode: input.executionMode,
    useAgentJudge: input.useAgentJudge,
    rows,
    ...settleRunAfterEdit(run, rows, now),
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test src/runs.test.ts`
Expected: PASS —— 新增的 8 组用例 + **既有全部用例**（`createRun` 的 12 组不能因为这次抽取有任何变化）

- [ ] **Step 6: 变异验证**

1. 把 `planRunUpdate` 里的 `if (caseChanged || !isSameRowTarget(current, row))` 改成 `if (false)` → `改某行模型 ⇒ 只有那一行重置` 与 `换来用例 ⇒ 所有行重置` 都必须红；
2. 把 `resolved.map` 换成 `run.rows.map`（即不理会入参的行集合）→ `删掉一行` 与 `新增一行` 必须红；
3. 把 `newRow` 里的 `rowWorkspaceDir(run.workspaceBase, …)` 改成 `rowWorkspaceDir('D:\\runs-new', …)` → `workspacePath 落在 run.workspaceBase 下` 必须红；
4. 把 `settleRunAfterEdit` 的第一条分支换成直接 `return { status: 'partial', finishedAt: null }` → `全 judged ⇒ done 且保留 finishedAt` 必须红。

- [ ] **Step 7: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
```

```bash
git add packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts
git commit -m "feat(api): 抽取候选行校验链并加编辑的纯函数规划（resolveRunRows / planRunUpdate）"
```

---

## Task 4: api —— `updateRun` / `deleteRun`

**Files:**
- Modify: `packages/server/api/src/runs.ts`（追加两个导出）
- Modify: `packages/server/api/src/index.ts:32-45`（评测域出口加两个名字）
- Test: `packages/server/api/src/runs.test.ts`（追加一个 `describe`）

**Interfaces:**
- Consumes: Task 1 的 `hasLiveRows`、Task 2 的 `assertRunMutable` / evaluator 的 `deleteRun`、Task 3 的 `resolveRunRows` / `planRunUpdate`
- Produces:
  - `updateRun(runId: string, input: RunUpdate): EvalRun`
  - `deleteRun(runId: string): { workspaceRemoved: boolean }`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/server/api/src/runs.test.ts` 末尾。该文件的 evaluator 是 `importOriginal` 展开后**只替换**被测的那几个函数的（见文件头），所以 `assertRunMutable` 走真实实现（测试里没有在途任务，恒通过），而 evaluator 的 `deleteRun` 要按同一手法加进 mock 的替换清单：

```ts
describe('updateRun', () => {
  /** 落一盘「已经跑过一轮」的评测，返回它的快照 */
  function seedJudgedRun(): EvalRun {
    const run = makeRun({
      rows: [
        makeRow({
          id: 'r-1',
          status: 'judged',
          baselineCommit: 'a'.repeat(40),
          score: {
            dimensions: [],
            totalScore: 80,
            verdict: '好',
            raw: '{}',
            judgeProviderId: 'p-anthropic',
            judgeModelId: 'claude-opus-4-6',
            judgedAt: '2026-09-22T09:00:00.000Z',
            judgeAgentKind: null,
          },
          attempts: 1,
        }),
      ],
      status: 'done',
      startedAt: '2026-09-22T08:00:00.000Z',
      finishedAt: '2026-09-22T09:00:00.000Z',
    });
    store.set(run.id, run);
    return run;
  }

  it('只改执行模式：落盘的 executionMode 变了，行与轮级结果逐字保留', () => {
    const before = seedJudgedRun();

    const next = updateRun(before.id, {
      caseId: before.caseId,
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(next.executionMode).toBe('serial');
    expect(next.status).toBe('done');
    expect(next.rows).toEqual(before.rows);
    // 「先全校验、再一次性落盘」：store 里那一份也必须是新的
    expect(store.get(before.id)?.executionMode).toBe('serial');
    expect(store.get(before.id)?.rows).toEqual(before.rows);
  });

  it('换模型 ⇒ 那一行重置并落盘（评分 / diff / 基线 / attempts 全清）', () => {
    const before = seedJudgedRun();

    const next = updateRun(before.id, {
      caseId: before.caseId,
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' }],
    });

    expect(next.rows[0]?.status).toBe('pending');
    expect(next.rows[0]?.score).toBeNull();
    expect(next.rows[0]?.attempts).toBe(0);
    expect(next.rows[0]?.providerName).toBe('OpenAI 网关');
    expect(store.get(before.id)?.rows[0]?.status).toBe('pending');
  });

  it('运行中 ⇒ CONFLICT（界面上入口也置灰，两层同一判据）', () => {
    const before = seedJudgedRun();
    store.set(before.id, { ...before, status: 'running' });

    expect(() =>
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      }),
    ).toThrowError(/运行/);
  });

  it('校验失败 ⇒ 一个字节都不写（store 保持原样）', () => {
    const before = seedJudgedRun();

    expect(() =>
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ id: 'r-1', agentKind: 'codex', providerId: 'p-gone', modelId: 'gpt-5' }],
      }),
    ).toThrowError(/p-gone/);
    expect(store.get(before.id)).toEqual(before);
  });

  it('换用例 ⇒ 四格快照重取，行全部重置', () => {
    const before = seedJudgedRun();
    // 再加一个用例：标题 / 仓库都不同，且带一个 commit（`seedConfig` 会整体覆盖 providers 与 cases，
    // 故必须把 `beforeEach` 里那两家供应商与 c-1 一起带上）
    seedConfig({
      providers: [makeProvider(), makeAnthropicProvider()],
      cases: [
        makeCase(),
        makeCase({ id: 'c-2', title: '另一个用例', repoPath: 'D:\\projects\\other', commitHash: 'c'.repeat(40) }),
      ],
    });

    const next = updateRun(before.id, {
      caseId: 'c-2',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(next.caseTitle).toBe('另一个用例');
    expect(next.repoPath).toBe('D:\\projects\\other');
    expect(next.rows[0]?.status).toBe('pending');
  });

  it('开着「使用智能体评分」而设置页没配 ⇒ CONFLICT，且不落盘（与创建同一份判定）', () => {
    const before = seedJudgedRun();

    expect(() =>
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: true,
        rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      }),
    ).toThrowError(/评分智能体|评分/);
    expect(store.get(before.id)).toEqual(before);
  });
});

describe('deleteRun（api 层）', () => {
  it('存在性检查 + 转编排层，并把 workspaceRemoved 原样回给界面', () => {
    const run = makeRun();
    store.set(run.id, run);
    evaluator.deleteRun.mockReturnValue({ workspaceRemoved: false });

    expect(deleteRun(run.id)).toEqual({ workspaceRemoved: false });
    expect(evaluator.deleteRun).toHaveBeenCalledWith(run.id);
  });

  it('不存在 ⇒ NOT_FOUND（脏 URL 不能删到别人的目录）', () => {
    expect(() => deleteRun('nope')).toThrowError(/评测不存在/);
  });
});
```

配套的三处改动：

1. 顶部 evaluator mock 的替换清单加一行（否则 `deleteRun` 会走真实实现、真的去删临时目录）：

```ts
    rescoreRow: vi.fn(),
    retryRow: vi.fn(),
    // 删除（2026-09-28）：api 层的 deleteRun 只是转发，本层要断言的是「转过去了吗」
    deleteRun: vi.fn(),
```

2. import 区加 `deleteRun`、`updateRun`（来自 `./runs`）。`seedConfig` / `makeCase` 已在该文件顶部引入（`beforeEach` 里就用了它们），无需新增。

3. `updateRun` 的存在性：`updateRun('nope', …)` 也要有 404 断言，追加一条：

```ts
  it('不存在的轮次 ⇒ NOT_FOUND', () => {
    expect(() =>
      updateRun('nope', { caseId: 'c-1', executionMode: 'serial', useAgentJudge: false, rows: [{ agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' }] }),
    ).toThrowError(/评测不存在/);
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/api test src/runs.test.ts`
Expected: FAIL —— `updateRun is not a function` / `deleteRun is not a function`

- [ ] **Step 3: 实现**

`packages/server/api/src/runs.ts` 的 evaluator import 里加两个名字（按该文件既有别名约定）：

```ts
  deleteRun as deleteRunInOrchestrator,
  assertRunMutable,
```

`@aieval/contracts` 的 import 里加 `hasLiveRows`。追加两个导出到文件末尾：

```ts
/**
 * 更新一轮评测（「修改」，spec §5.1）：校验 → 算新快照 → 落盘。
 *
 * 顺序与失败语义都是承重的：
 *   1. **先判「能不能改」**（`hasLiveRows`）：正在跑的行有自己的生命周期，处置是「先终止」，
 *      与后面那几条「改法不成立」完全不同，必须先分开；
 *   2. **再全校验**（用例存在 → 评分通路 → 每行的供应商 / 模型 / 协议），任何一步抛都**一个字节
 *      都不写**——半份快照比「什么都没发生」危险得多（与 `retryRow` 的「入口区必须能整体回退」同源）；
 *   3. **最后才落盘**，且落盘前再调一次编排层的 `assertRunMutable`：`hasLiveRows` 读的是快照，
 *      而行刚落终态、任务还在收尾的那一拍快照上是「没有活」。
 *
 * 「使用智能体评分」的判定与创建**共用同一份**（`resolveJudgeRoute` + `requireJudgeAgent`）：
 * 用例级覆盖可能把评分模型换到另一种协议，故这一步必须拿**这次指定的那个用例**去解析。
 */
export function updateRun(runId: string, input: RunUpdate): EvalRun {
  const before = getRunSnapshot(runId);
  if (hasLiveRows(before)) {
    throw new ServiceError('CONFLICT', `这一轮还有候选行在运行（${runId}）：请先终止它，再修改`);
  }

  const testCase = getCase(input.caseId);
  const providers = listProviders();
  const settings = getSettings();
  if (input.useAgentJudge) {
    const route = resolveJudgeRoute({
      judgeProviderId: testCase.judgeProviderId,
      judgeModelId: testCase.judgeModelId,
    });
    requireJudgeAgent({ defaultJudgeAgent: settings.defaultJudgeAgent, route });
  }

  const resolved = resolveRunRows(input.rows, providers);
  const next = planRunUpdate(before, input, resolved, {
    caseId: testCase.id,
    caseTitle: testCase.title,
    repoPath: testCase.repoPath,
    commitHash: testCase.commitHash,
    repoBranch: testCase.repoBranch ?? null,
  });

  assertRunMutable(runId);
  saveRun(next);
  log.info('评测已修改', { runId, caseId: next.caseId, rows: next.rows.length, executionMode: next.executionMode });
  return next;
}

/**
 * 删除一轮评测（spec §5.3）：存在性检查 → 转编排层（那里才有在途任务表与产物路径）。
 * 为什么存在性检查在这里而不是只靠编排层：编排层的 `getRunForWrite` 有「按进程内记忆兜底」的
 * 分支，直接转过去的话，一个**别的根**下的同名轮次可能被解析到——而删除的语义是
 * 「删掉**当前工作区根里可见的这一轮**」（与读侧口径一致，R10）。
 */
export function deleteRun(runId: string): { workspaceRemoved: boolean } {
  getRunSnapshot(runId);
  const result = deleteRunInOrchestrator(runId);
  log.info('评测已删除', { runId, workspaceRemoved: result.workspaceRemoved });
  return result;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/api test src/runs.test.ts`
Expected: PASS

- [ ] **Step 5: 变异验证**

1. 把 `updateRun` 里的 `if (hasLiveRows(before))` 那一整段删掉 → `运行中 ⇒ CONFLICT` 必须红；
2. 把 `saveRun(next)` 提到 `const resolved = resolveRunRows(…)` **之前**（先写盘再校验）→ `校验失败 ⇒ 一个字节都不写` 必须红；
3. 把 `deleteRun` 里的 `getRunSnapshot(runId)` 删掉 → `不存在 ⇒ NOT_FOUND` 必须红。

- [ ] **Step 6: 补包根出口**

`packages/server/api/src/index.ts` 的评测域出口清单加两个名字（按字母序）：

```ts
  createRun,
  deleteRun,
  getRunView,
  listAgentModelOptions,
  listModelOptions,
  listRunsView,
  rescoreRow,
  retryRow,
  startRun,
  updateRun,
```

- [ ] **Step 7: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
pnpm --filter @aieval/api test
```

```bash
git add packages/server/api/src/runs.ts packages/server/api/src/runs.test.ts packages/server/api/src/index.ts
git commit -m "feat(api): 评测的修改与删除（updateRun / deleteRun）"
```

---

## Task 5: 路由 —— `PUT` / `DELETE /api/runs/[runId]`

**Files:**
- Modify: `apps/web-next/app/api/runs/[runId]/route.ts`（现有 GET 之外加两个 handler）
- Test: `apps/web-next/src/route-runs.test.ts`（mock 键清单 + 两个 `describe`）

**Interfaces:**
- Consumes: Task 4 的 `updateRun` / `deleteRun`（都从 `@aieval/api` 包根取）、Task 1 的 `RunUpdateSchema`
- Produces: `PUT` / `DELETE` 两个 Route Handler，响应体分别是 `EvalRun` 与 `{ workspaceRemoved: boolean }`

- [ ] **Step 1: 写失败的测试**

`apps/web-next/src/route-runs.test.ts`：

(a) 顶部 import 加：

```ts
import { GET as getRun, DELETE as deleteRunRoute, PUT as putRun } from '@/app/api/runs/[runId]/route';
```

(b) `vi.hoisted` 的 mock 键清单加两行（**必须显式列**：api 的 `index.ts` 转出了这两个名字，缺键会在模块求值期抛 `No … export is defined on the mock`，这是本文件头记录的既有坑）：

```ts
  deleteRun: vi.fn(),
  assertRunMutable: vi.fn(),
```

(c) 文件末尾追加：

```ts
/**
 * `PUT /api/runs/[runId]`（编辑）与 `DELETE`（删除）：这一层钉的是**传输链**——
 * zod 有没有把 `rows[].id` 解析掉、两个 id 有没有按 URL 原样交给 api、错误有没有映射成中文。
 * 「哪一行被重置」是 api / contracts 的判据，不在本文件的职责里（mock 掉了 evaluator）。
 */
describe('PUT /api/runs/[runId]', () => {
  it('把 rows[].id 真的交给了服务端（zod 默认 strip 未知键，漏声明就是静默当新行）', async () => {
    const run = await createRealRun();
    const rowId = run.rows[0]?.id ?? '';
    // 编排层被 mock，故这里断言的是「api 层收到了带 id 的那一行」——用 saveRun 的落盘物反向核对
    store.set(run.id, run);

    const res = await putRun(jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [{ id: rowId, agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as EvalRun;
    expect(body.executionMode).toBe('serial');
    // 行 id 原样保留 = 「原地更新这一行」这条语义真的走到了 api
    expect(body.rows.map((row) => row.id)).toEqual([rowId]);
    expect(store.get(run.id)?.executionMode).toBe('serial');
  });

  it('rows 为空的请求体 → 400（RunUpdateSchema 的 min(1)）', async () => {
    const run = await createRealRun();
    const res = await putRun(jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [] }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_QUERY');
  });

  it('未知的行 id → 404，且带出那个 id（不许静默当新行）', async () => {
    const run = await createRealRun();
    const res = await putRun(
      jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [{ id: 'r-404', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }),
      { params: Promise.resolve({ runId: run.id }) },
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain('r-404');
  });

  it('运行中的轮次 → 409', async () => {
    const run = await createRealRun();
    store.set(run.id, { ...run, status: 'running' });
    const res = await putRun(
      jsonRequest({ caseId: 'c-1', executionMode: 'serial', rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }),
      { params: Promise.resolve({ runId: run.id }) },
    );

    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/runs/[runId]', () => {
  it('转给 api 层并把 workspaceRemoved 原样回出去', async () => {
    const run = await createRealRun();
    evaluator.deleteRun.mockReturnValue({ workspaceRemoved: false });

    const res = await deleteRunRoute(new Request('http://localhost/api/runs/x', { method: 'DELETE' }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceRemoved: false });
    expect(evaluator.deleteRun).toHaveBeenCalledWith(run.id);
  });

  it('不存在的轮次 → 404', async () => {
    const res = await deleteRunRoute(new Request('http://localhost/api/runs/x', { method: 'DELETE' }), {
      params: Promise.resolve({ runId: 'nope' }),
    });

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/web-next test src/route-runs.test.ts`
Expected: FAIL —— `PUT` / `DELETE` 未从路由导出（`putRun is not a function`）

- [ ] **Step 3: 实现路由**

`apps/web-next/app/api/runs/[runId]/route.ts` 改为：

```ts
/**
 * 单轮评测快照：GET / PUT（编辑）/ DELETE（删除）。
 * 只做「zod 校验 → 调 api → 错误映射」三件事（spec 的目录边界：路由层不写业务）。
 * Next 16 的动态路由上下文里 `params` 是 **Promise**，必须 await。
 */
import { deleteRun, getRunView, updateRun } from '@aieval/api';
import { RunUpdateSchema } from '@aieval/contracts';
import { handleApiError, readJsonBody } from '@/src/server-context';

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(getRunView(runId));
  } catch (error) {
    return handleApiError(error);
  }
}

/** 编辑这一轮：入参是「这一轮应当长成什么样」（可变字段全量），与用例的 PUT 逐字同形 */
export async function PUT(req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    const input = RunUpdateSchema.parse(await readJsonBody(req));
    return Response.json(updateRun(runId, input));
  } catch (error) {
    return handleApiError(error);
  }
}

/** 删除这一轮：快照 + 它的全部产物。`workspaceRemoved: false` = 磁盘回收失败（界面要如实说） */
export async function DELETE(_req: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  try {
    const { runId } = await params;
    return Response.json(deleteRun(runId));
  } catch (error) {
    return handleApiError(error);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/web-next test src/route-runs.test.ts`
Expected: PASS（含既有的 GET / POST / start / abort / rescore / retry 全部用例）

- [ ] **Step 5: 变异验证**

1. 把 `PUT` 里的 `RunUpdateSchema` 换成 `RunCreateSchema` → `rows[].id` 那一条必须红（id 被 strip 掉、行被当新行）；
2. 把 `DELETE` 里的 `deleteRun(runId)` 换成 `deleteRun('')` → `转给 api 层` 必须红。

- [ ] **Step 6: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
```

```bash
git add apps/web-next/app/api/runs/[runId]/route.ts apps/web-next/src/route-runs.test.ts
git commit -m "feat(web-next): 评测的 PUT / DELETE 路由"
```

---

## Task 6: client —— `useUpdateRun` / `useDeleteRun`

**Files:**
- Modify: `packages/client/client/src/runs.ts`（追加两个 hook）
- Modify: `packages/client/client/src/index.ts:24-42`（评测域出口加两个名字）
- Test: `packages/client/client/src/runs.test.tsx`（追加两个 `describe`）

**Interfaces:**
- Consumes: `putJson` / `delJson`（本包 `./http`）、`runKey` / `RUNS_KEY`（本文件）
- Produces:
  - `useUpdateRun(): { update: (runId: string, input: RunUpdate) => Promise<EvalRun>; isUpdating: boolean }`
  - `useDeleteRun(): { remove: (runId: string) => Promise<{ workspaceRemoved: boolean }>; isDeleting: boolean }`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/client/client/src/runs.test.tsx` 末尾（该文件已有 `stubFetch` / `json` / `wrapper` / `makeRun` 夹具）：

```ts
/**
 * 编辑与删除的**回写约定**（与另外四个写操作逐字同形）：
 * mutation 成功后写详情缓存（`revalidate: false`，避免紧接的 GET 用旧值覆盖）、再刷新列表。
 * 为什么不走 `useSWRMutation`：见 runs.ts 文件头——runId 是**调用时**才拿到的，
 * 且写操作不进 SWR 的 fetcher（「窗口重新获得焦点 ⇒ 重发一次写请求」在形状上就不存在）。
 */
describe('useUpdateRun', () => {
  it('PUT 到详情键，并同时回写详情缓存与列表', async () => {
    const updated = { ...makeRun(), executionMode: 'serial' as const };
    const fetchMock = stubFetch(async (url, init) => {
      if (init?.method === 'PUT' && url === runKey('run-1')) return json(updated);
      if (url === RUNS_KEY) return json([updated]);
      return json({});
    });

    const { result } = renderHook(() => ({ list: useRuns(), update: useUpdateRun() }), { wrapper });
    await waitFor(() => expect(result.current.list.runs).toHaveLength(1));

    await act(async () => {
      await result.current.update.update('run-1', {
        caseId: 'c-1',
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      });
    });

    const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(putCall?.[0]).toBe(runKey('run-1'));
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({ executionMode: 'serial' });
    // 列表也刷新了（否则左栏还显示旧的执行模式）：首次挂载 1 次 + 写操作后 1 次
    expect(countGets(fetchMock, RUNS_KEY)).toBeGreaterThanOrEqual(2);
  });

  it('请求失败时抛 ServiceError，且不把缓存写坏', async () => {
    stubFetch(async () => json({ error: { code: 'CONFLICT', message: '这一轮还有候选行在运行' } }, 409));

    const { result } = renderHook(() => useUpdateRun(), { wrapper });

    await act(async () => {
      await expect(
        result.current.update('run-1', { caseId: 'c-1', executionMode: 'serial', useAgentJudge: false, rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }] }),
      ).rejects.toThrowError(/正在运行|在运行/);
    });
    expect(result.current.isUpdating).toBe(false);
  });
});

describe('useDeleteRun', () => {
  it('DELETE 详情键、清掉详情缓存并刷新列表，返回 workspaceRemoved', async () => {
    const fetchMock = stubFetch(async (url, init) => {
      if (init?.method === 'DELETE' && url === runKey('run-1')) return json({ workspaceRemoved: false });
      if (url === RUNS_KEY) return json([]);
      return json(makeRun());
    });

    const { result } = renderHook(
      () => ({ detail: useRun('run-1'), remove: useDeleteRun() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.detail.run).toBeDefined());

    let removed: { workspaceRemoved: boolean } | undefined;
    await act(async () => {
      removed = await result.current.remove.remove('run-1');
    });

    expect(removed).toEqual({ workspaceRemoved: false });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    // 详情缓存被清掉：改回同一个 URL 时不许先渲染一条已经不存在的轮次
    await waitFor(() => expect(result.current.detail.run).toBeUndefined());
  });
});
```

（`countGets(fetchMock, url)` 与 `stubFetch` / `json` / `wrapper` / `makeRun` 都是该文件已有的夹具，签名照旧。）

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/client test src/runs.test.tsx`
Expected: FAIL —— `useUpdateRun is not a function`

- [ ] **Step 3: 实现**

`packages/client/client/src/runs.ts`：import 里加 `delJson`、`putJson`，以及 `type RunUpdate`：

```ts
import type { AgentKind, EvalRun, ProtocolType, ProviderModel, RowDiff, RunCreate, RunUpdate, AgentEvent } from '@aieval/contracts';
import { delJson, getJson, postJson, putJson } from './http';
```

在 `useCreateRun` 之后加：

```ts
/**
 * 编辑一轮评测（「修改」）：PUT 全量可变字段 → 回写详情与列表两个键。
 * 形状与另外四个写操作逐字相同（见文件头约定 3）：手工 `mutate`、`revalidate: false`、
 * 再显式刷新列表——缺任何一处都会出现「详情新、列表旧」。
 * `isUpdating` 只用于按钮转圈与禁用；可用性判据是 contracts 的 `hasLiveRows`，与服务端同一份。
 */
export function useUpdateRun(): { update: (runId: string, input: RunUpdate) => Promise<EvalRun>; isUpdating: boolean } {
  const { mutate } = useSWRConfig();
  const [isUpdating, setUpdating] = useState(false);

  const update = useCallback(
    async (runId: string, input: RunUpdate): Promise<EvalRun> => {
      setUpdating(true);
      try {
        const run = await putJson<EvalRun>(runKey(runId), input);
        // revalidate:false：响应就是最新值，再拉一次只会多一次请求，还可能被慢响应覆盖成旧值
        await mutate(runKey(runId), run, { revalidate: false });
        await mutate(RUNS_KEY);
        return run;
      } finally {
        setUpdating(false);
      }
    },
    [mutate],
  );

  return { update, isUpdating };
}

/**
 * 删除一轮评测：清掉详情缓存（照 `useDeleteCase` 的口径）+ 刷新列表。
 * 响应里的 `workspaceRemoved` 必须原样交给页面：`false` = 磁盘上的行工作区没能回收，
 * 界面要如实说出来（不假装干净，也不把「回收失败」说成「删除失败」）。
 */
export function useDeleteRun(): { remove: (runId: string) => Promise<{ workspaceRemoved: boolean }>; isDeleting: boolean } {
  const { mutate } = useSWRConfig();
  const [isDeleting, setDeleting] = useState(false);

  const remove = useCallback(
    async (runId: string): Promise<{ workspaceRemoved: boolean }> => {
      setDeleting(true);
      try {
        const result = await delJson<{ workspaceRemoved: boolean }>(runKey(runId));
        // 删掉的详情缓存必须清掉：留着它，改回同一个 URL 时会先渲染一条已经不存在的轮次
        await mutate(runKey(runId), undefined, { revalidate: false });
        await mutate(RUNS_KEY);
        return result;
      } finally {
        setDeleting(false);
      }
    },
    [mutate],
  );

  return { remove, isDeleting };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/client test src/runs.test.tsx`
Expected: PASS

- [ ] **Step 5: 变异验证**

1. 把 `useUpdateRun` 里的 `await mutate(RUNS_KEY);` 删掉 → `PUT 到详情键，并同时回写详情缓存与列表` 里的请求计数断言必须红；
2. 把 `useDeleteRun` 里的 `mutate(runKey(runId), undefined, …)` 删掉 → 「详情缓存被清掉」必须红。

- [ ] **Step 6: 补包根出口**

`packages/client/client/src/index.ts` 的 `./runs` 出口加两个名字（按字母序）：

```ts
  useStartRun,
  useUpdateRun,
  useDeleteRun,
```

（`useDeleteRun` 按字母序应排在 `useCreateRun` 之后，实施时按该清单既有的字母序放准。）

- [ ] **Step 7: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
```

```bash
git add packages/client/client/src/runs.ts packages/client/client/src/runs.test.tsx packages/client/client/src/index.ts
git commit -m "feat(client): 评测的编辑与删除 hooks（useUpdateRun / useDeleteRun）"
```

---

## Task 7: ui —— `RunDetailPanel` 的「编辑 / 删除」入口

**Files:**
- Modify: `packages/client/ui/src/composite/run-detail-panel.tsx`（props + 顶部信息卡的 `extra`）
- Test: `packages/client/ui/src/composite/run-detail-panel.test.tsx`（追加一个 `describe`）

**Interfaces:**
- Consumes: Task 1 的 `hasLiveRows`
- Produces: `RunDetailPanelProps` 新增 `onEdit: () => void`、`onDelete: () => void | Promise<unknown>`、`deleting?: boolean`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/client/ui/src/composite/run-detail-panel.test.tsx` 末尾。**两处既有夹具必须先改**：

(a) 共享的 `handlers`（第 90-101 行）加三格：

```ts
const handlers = {
  onStart: vi.fn(),
  onAbortRun: vi.fn(),
  onAbortRow: vi.fn(),
  onRescoreRow: vi.fn(),
  rescoring: false,
  onRetryRow: vi.fn(),
  retrying: false,
  onOpenLog: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenScore: vi.fn(),
  // 编辑 / 删除（2026-09-28）
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  deleting: false,
};
```

(b) 该文件的 `renderPanel(run, overrides)` 是**两参数**的（`renderPanel(makeRun(), { onEdit })`），下面的用例按它写。

```ts
/**
 * 「编辑 / 删除」两个入口（spec §6.1）：与用例详情逐字同形，且**不在运行中**才可用。
 * 三条各自的理由：
 *   · 两个汉字的按钮必须关掉 antd 的自动空格，否则可访问名是「编 辑」/「删 除」；
 *   · `Popconfirm` 的 `onConfirm` 必须**回交 promise**（返回 undefined 时确认框立刻关闭，
 *     用户看到「点一下没反应」，再点一次就是第二次 DELETE）；
 *   · 有行在跑时两个按钮都要禁用并给出原因——服务端同一判据会抛 409，界面的置灰是提前告知。
 */
describe('RunDetailPanel 的编辑 / 删除入口', () => {
  it('默认（空闲）时两个入口都在且可点', () => {
    const onEdit = vi.fn();
    renderPanel(makeRun(), { onEdit });

    fireEvent.click(screen.getByTestId('run-detail-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('run-detail-delete')).toBeEnabled();
  });

  it('有行在跑时两个入口都禁用（原因在 Tooltip 里）', async () => {
    renderPanel(makeRun({ status: 'running', rows: [makeRow('w-1', { status: 'running' })] }));

    expect(screen.getByTestId('run-detail-edit')).toBeDisabled();
    expect(screen.getByTestId('run-detail-delete')).toBeDisabled();
    // 禁用不是「静默」：原因必须说得出「先终止」。Tooltip 的触发点在禁用按钮外面那层 span 上
    fireEvent.mouseEnter(screen.getByTestId('run-detail-edit').parentElement ?? document.body);
    await waitFor(() => expect(screen.getByText(/先终止/)).toBeDefined());
  });

  it('删除走 Popconfirm，确认后把在途 promise 交给它（否则确认框会提前关闭）', async () => {
    let resolveDelete: (() => void) | undefined;
    const onDelete = vi.fn(() => new Promise<void>((resolve) => { resolveDelete = resolve; }));
    renderPanel(makeRun(), { onDelete });

    fireEvent.click(screen.getByTestId('run-detail-delete'));
    const confirm = await screen.findByRole('button', { name: '确认删除' });
    fireEvent.click(confirm);

    expect(onDelete).toHaveBeenCalledTimes(1);
    // promise 还没落定 ⇒ 确认按钮必须还在 loading（提前关闭就是「点一下没反应」那个缺陷）
    await waitFor(() => expect(confirm.className).toContain('ant-btn-loading'));
    await act(async () => { resolveDelete?.(); });
  });
});
```

同文件顶部的 import 补 `act`。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/ui test src/composite/run-detail-panel.test.tsx`
Expected: FAIL —— `Unable to find an element by: [data-testid="run-detail-edit"]`

- [ ] **Step 3: 实现**

`packages/client/ui/src/composite/run-detail-panel.tsx`：

(a) 文件头的四条口径补一条（放在「四条口径」之后）：

```
 * 第五条口径（2026-09-28）：「编辑 / 删除」两个入口放在**顶部信息卡的 `extra`** 上，
 * 与 `case-detail-panel.tsx` 逐字同形（同一个位置、同一套 Popconfirm 语义）；两者都只在
 * **没有行在运行**时可用——判据是 contracts 的 `hasLiveRows`，与服务端抛 409 的那一条同源。
```

(b) import 里加 `hasLiveRows` 与 `Tooltip`（`Tooltip` 已有）：

```ts
import { hasLiveRows, ... } from '@aieval/contracts';
```

(c) props 接口加三格：

```ts
  /** 打开编辑表单（右栏切到 edit） */
  onEdit: () => void;
  /**
   * 删除这一轮。**必须返回在途请求的 promise**（`() => remove(id)`，而不是 `() => { void remove(id) }`）：
   * antd 的 `ActionButton` 只在 `onConfirm` 返回 thenable 时才等待它——返回 undefined 时确认框会
   * **立刻关闭**，用户看到的是「点一下就没反应」，再点一次就是第二次 DELETE
   *（`case-detail-panel.tsx` 的 `onDelete` 注释同此口径）。
   */
  onDelete: () => void | Promise<unknown>;
  /** 删除请求在途：给确认按钮上 loading，避免重复点 */
  deleting?: boolean;
```

(d) 函数签名解构里加 `onEdit, onDelete, deleting = false`。

(e) 在 `const serial = run.executionMode === 'serial';` 之后加：

```ts
  /**
   * 「能不能改 / 能不能删」：只有一条判据（`hasLiveRows`），由服务端同一份函数抛 409。
   * 有行在跑时两个入口一律禁用并给出原因——正在跑的行有自己的生命周期，处置是「先终止」。
   */
  const live = hasLiveRows(run);
  const mutateDisabledReason = live ? '有候选行正在运行：先终止，再编辑 / 删除' : undefined;
```

(f) 顶部信息卡加 `extra`：

```tsx
      <Card
        size="small"
        title={run.caseTitle}
        data-testid="run-header"
        extra={
          <Flex gap={8}>
            {/* 两个汉字的标签必须关掉 antd 的自动空格：否则可访问名变成「编 辑」/「删 除」 */}
            <Tooltip title={mutateDisabledReason}>
              <Button
                size="small"
                autoInsertSpace={false}
                disabled={live}
                data-testid="run-detail-edit"
                onClick={onEdit}
              >
                编辑
              </Button>
            </Tooltip>
            <Popconfirm
              title="删除这一轮评测？"
              description="这一轮的全部行工作区与执行日志会一起删掉，不可恢复。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true, loading: deleting, autoInsertSpace: false }}
              cancelButtonProps={{ autoInsertSpace: false }}
              disabled={live}
              onConfirm={onDelete}
            >
              <Button size="small" danger autoInsertSpace={false} disabled={live} data-testid="run-detail-delete">
                删除
              </Button>
            </Popconfirm>
          </Flex>
        }
      >
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test src/composite/run-detail-panel.test.tsx`
Expected: PASS（含既有的顶部信息卡 / 进度 / 排序 / 开始确认框 / 终止等全部用例）

- [ ] **Step 5: 变异验证**

1. 把两个按钮的 `disabled={live}` 删掉 → `有行在跑时两个入口都禁用` 必须红；
2. 把 `onConfirm={onDelete}` 换成 `onConfirm={() => { void onDelete(); }}` → `确认后把在途 promise 交给它` 必须红。

- [ ] **Step 6: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
```

```bash
git add packages/client/ui/src/composite/run-detail-panel.tsx packages/client/ui/src/composite/run-detail-panel.test.tsx
git commit -m "feat(ui): 评测详情的编辑 / 删除入口（运行中置灰并给原因）"
```

---

## Task 8: ui —— `RunCreatePanel` 的 `mode="edit"` 与保存前确认框

**Files:**
- Modify: `packages/client/ui/src/composite/run-create-panel.tsx`（`mode` / `initial` / `RunFormValues` / 确认框 / 预填）
- Modify: `packages/client/ui/src/index.ts:45-49`（出口加 `type RunFormValues`）
- Test: `packages/client/ui/src/composite/run-create-panel.test.tsx`（追加一个 `describe`）

**Interfaces:**
- Consumes: Task 1 的 `isSameRowTarget`、`TERMINAL_ROW_STATUSES`、`ROW_STATUS_LABELS`
- Produces:
  - `interface RunFormValues { caseId: string; executionMode: ExecutionMode; useAgentJudge: boolean; rows: { id?: string; agentKind: AgentKind; providerId: string; modelId: string }[] }`
  - `RunCreatePanel` 新 props：`mode?: 'new' | 'edit'`、`initial?: EvalRun`；`onSubmit: (input: RunFormValues) => void`
  - `invalidatedRows(run: EvalRun, submit: RunFormValues): EvalRow[]`（具名导出的纯函数）

- [ ] **Step 1: 写失败的测试**

追加到 `packages/client/ui/src/composite/run-create-panel.test.tsx` 末尾。该文件的 `renderPanel` 已有默认 props，下面显式覆盖：

```ts
/**
 * 编辑模式（spec §6.2）：同一张表单，`mode="edit"` 预填当前轮次。
 * 三条各自对应一个真实会咬人的失败：
 *   · 行必须带上原行 id —— 丢了它，保存时所有行都被当新行，已跑出的结果静默清零；
 *   · 执行模式取 `initial.executionMode` —— 被 `initialValues` 的「默认串行」盖掉会让用户
 *     只改了个模型、执行模式却被悄悄改成串行；
 *   · 原用例已被删除时下拉要有一个禁用占位项 —— 否则显示空白，用户一保存就换了个用例。
 */
describe('RunCreatePanel（编辑模式）', () => {
  const editRun: EvalRun = {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '多协议入站转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: '71e628091bf7134a6e677a58cc1e0f29b9302e6f',
    repoBranch: null,
    status: 'done',
    // 故意与「默认串行」不同：取值来源不对时这一条会红
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: [
      {
        id: 'r-1',
        agentKind: 'claude-code',
        providerId: 'p-anthropic',
        providerName: 'Anthropic 网关',
        baseUrl: 'https://gw.example.com/anthropic',
        modelId: 'claude-opus-4-6',
        status: 'judged',
        branch: 'test/r-1',
        workspacePath: 'D:\\runs\\run-1\\rows\\r-1\\workspace',
        baselineCommit: 'a'.repeat(40),
        tokens: null,
        turns: null,
        durationMs: null,
        diff: null,
        score: null,
        error: null,
        attempts: 1,
      },
    ],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: '2026-09-22T08:00:00.000Z',
    finishedAt: '2026-09-22T09:00:00.000Z',
  };

  it('预填执行模式与用例，且提交的行带着原行 id', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    // 执行模式取自 initial（并行），不是表单缺省的串行
    expect(screen.getByRole('radio', { name: '并行' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      caseId: 'c-1',
      executionMode: 'parallel',
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });
  });

  it('只改执行模式 ⇒ 不弹确认框（什么都不作废，弹窗就是噪音）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    fireEvent.click(screen.getByRole('radio', { name: '串行' }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/作废/)).toBeNull();
  });

  it('改模型 ⇒ 弹确认框列出将被作废的那一行，确认后才提交', async () => {
    const onSubmit = vi.fn();
    renderPanel({ mode: 'edit', initial: editRun, onSubmit, modelOptionsFor: poolFor });

    // 换智能体（模型那一格会被既有行为清空），再选一个 openai 的模型。
    // 选项必须用本文件既有的 `pickOption`：antd 6 的 Select 在 DOM 里有两份选项，
    // `getByRole('option')` 拿到的是不接事件的可访问性镜像（见该函数的长注释）。
    pickOption('智能体', 'Codex');
    pickOption('模型', /gpt-5/);
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    // 确认框里必须点名**将被作废的那一行**（列的是这一轮现有的行：智能体 · 模型 · 原状态）
    expect(await screen.findByText(/作废/)).toBeDefined();
    expect(screen.getByText(/Claude Code · claude-opus-4-6/)).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('原用例已被删除：下拉里补一个禁用的占位项，保存不会换掉 caseId', async () => {
    const onSubmit = vi.fn();
    const deletedCaseRun = { ...editRun, caseId: 'c-gone', caseTitle: '已被删掉的用例' };
    renderPanel({ mode: 'edit', initial: deletedCaseRun, onSubmit, modelOptionsFor: poolFor });

    expect(screen.getByText(/已被删掉的用例/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ caseId: 'c-gone' });
  });

  it('新增模式：提交里不含 id（创建路径不接受行身份）', async () => {
    const onSubmit = vi.fn();
    renderPanel({ onSubmit, modelOptionsFor: poolFor });

    pickOption('模型', /claude-opus-4-6/);
    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0].rows[0]).not.toHaveProperty('id');
  });
});

/**
 * `invalidatedRows`：确认框的内容，也是它「不该弹时不弹」的判据。
 * 判据是 contracts 的 `isSameRowTarget`——与服务端的重置判据**同一份**。
 */
describe('invalidatedRows', () => {
  /** 一行「跑过、有东西可丢」的行 */
  function rowOf(overrides: Partial<EvalRow> = {}): EvalRow {
    return {
      id: 'r-1',
      agentKind: 'claude-code',
      providerId: 'p-anthropic',
      providerName: 'Anthropic 网关',
      baseUrl: 'https://gw.example.com/anthropic',
      modelId: 'claude-opus-4-6',
      status: 'judged',
      branch: 'test/r-1',
      workspacePath: 'D:\\runs\\run-1\\rows\\r-1\\workspace',
      baselineCommit: 'a'.repeat(40),
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
      attempts: 1,
      ...overrides,
    };
  }

  const judged = rowOf();
  const neverRan = rowOf({ id: 'r-2', status: 'pending', baselineCommit: '', attempts: 0 });
  const run = { ...editRun, rows: [judged, neverRan] };

  /** 把一组行拼成表单会交回的形状（`id` 原样带着） */
  function submitOf(rows: EvalRow[], overrides: Partial<RunFormValues> = {}): RunFormValues {
    return {
      caseId: run.caseId,
      executionMode: run.executionMode,
      useAgentJudge: run.useAgentJudge,
      rows: rows.map((row) => ({ id: row.id, agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId })),
      ...overrides,
    };
  }

  it('只改执行模式 ⇒ 空数组（不弹）', () => {
    expect(invalidatedRows(run, submitOf([judged, neverRan]))).toEqual([]);
  });

  it('改模型 ⇒ 只有那一行，且**没跑过的行不算**（它没有东西可丢）', () => {
    const changed = invalidatedRows(run, submitOf([rowOf({ modelId: 'claude-haiku' }), neverRan]));
    expect(changed.map((row) => row.id)).toEqual(['r-1']);
  });

  it('删掉一行 ⇒ 它在作废名单里；换来用例 ⇒ 全部（含没跑过的）', () => {
    expect(invalidatedRows(run, submitOf([neverRan])).map((row) => row.id)).toEqual(['r-1']);
    expect(invalidatedRows(run, submitOf([judged, neverRan], { caseId: 'c-2' })).map((row) => row.id)).toEqual(['r-1']);
  });
});
```

配套改动两处：① 把 `editRun` 这条夹具**提到模块作用域**（`describe('invalidatedRows')` 与编辑模式那一组共用它，写在 `describe` 里隔壁那个 describe 看不见）；② 顶部 import 加 `invalidatedRows`、`type RunFormValues`、`type EvalRow`。`pickOption` 是该文件已有的夹具（用它而不是 `getByRole('option')`，理由见它的长注释）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/ui test src/composite/run-create-panel.test.tsx`
Expected: FAIL —— `invalidatedRows is not a function`

- [ ] **Step 3: 实现**

`packages/client/ui/src/composite/run-create-panel.tsx`：

(a) import 补：

```ts
import { Alert, Button, Flex, Form, Modal, Radio, Select, Switch, Tag } from 'antd';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  ROW_STATUS_LABELS,
  TERMINAL_ROW_STATUSES,
  displayRepoName,
  isSameRowTarget,
  type AgentKind,
  type EvalRow,
  type EvalRun,
  type ExecutionMode,
  type TestCase,
} from '@aieval/contracts';
```

(b) 文件头的五条口径之后补第六条：

```
 *   6. **编辑模式**（2026-09-28，spec §6.2）：`mode="edit"` + `initial` 预填，**不新写一个
 *      `RunEditPanel`**——两处字段表必然漂移。两个坑写在 `initialValues` 与 `caseOptions` 那两处：
 *      执行模式必须取自 `initial`（不能被表单缺省的「串行」盖掉），原用例被删掉时必须补一个禁用
 *      占位项（否则下拉空白，用户只改执行模式、一保存就换了个用例）。
```

(c) props 加两格：

```ts
  /** 'new'（缺省）= 创建；'edit' = 编辑已有的一轮（配合 `initial` 预填） */
  mode?: 'new' | 'edit';
  /** 编辑时的当前轮次；`mode="edit"` 必须给 */
  initial?: EvalRun;
  saving: boolean;
  onSubmit: (input: RunFormValues) => void;
  onCancel: () => void;
```

(d) 表单值的类型与新增导出（放在 `FormValues` 附近，`FormValues` 保留给内部用）：

```ts
/** 提交给调用方的形状：与 contracts 的 `RunUpdate` 逐字段一致（`id` 只在编辑时有） */
export interface RunFormValues {
  caseId: string;
  executionMode: ExecutionMode;
  useAgentJudge: boolean;
  rows: { id?: string; agentKind: AgentKind; providerId: string; modelId: string }[];
}

/** 表单内部的行值：模型用编码值承载 (providerId, modelId)，编辑时另带原行 id */
interface RowFormValue {
  id?: string;
  agentKind?: AgentKind;
  modelKey?: string;
}

/**
 * 这次保存会作废哪些行（保存前确认框的内容，也是它「不该弹时不弹」的判据）。
 *
 * 判据是 contracts 的 `isSameRowTarget` —— 与服务端 `planRunUpdate` 决定「重置哪一行」的**同一份**：
 * 两处各写一份必然漂移，而漂移的症状（「确认框说 2 行、实际 1 行」）正好落在用户唯一能核对的地方。
 *
 * 「作废」只算**有东西可丢**的行（跑过或落过终态）：一个从没跑过的 `pending` 行被重置什么都不丢，
 * 拿它去弹确认框是噪音——而噪音会让用户闭眼点确定，安全带的效力就此归零（与「开始」的确认框同一取舍）。
 */
export function invalidatedRows(run: EvalRun, submit: RunFormValues): EvalRow[] {
  const caseChanged = submit.caseId !== run.caseId;
  const submitted = new Map(submit.rows.flatMap((row) => (row.id === undefined ? [] : [[row.id, row] as const])));
  return run.rows.filter((row) => {
    const lostSomething = row.attempts > 0 || TERMINAL_ROW_STATUSES.includes(row.status);
    if (!lostSomething) return false;
    if (caseChanged) return true;
    const next = submitted.get(row.id);
    if (next === undefined) return true; // 被从表单里删掉的行
    return !isSameRowTarget(row, next);
  });
}
```

(e) 组件体：

```ts
export function RunCreatePanel({
  cases,
  modelOptionsFor,
  judgeAgentConfigured,
  mode = 'new',
  initial,
  saving,
  onSubmit,
  onCancel,
}: RunCreatePanelProps): ReactNode {
  const [form] = Form.useForm<FormValues>();
  const [modal, contextHolder] = Modal.useModal();
  const editing = mode === 'edit' && initial !== undefined;

  // 既有那三行原样保留（`label` 是「标题 · 仓库名 · 短哈希」），只把类型显式写出来：
  // 多了 `disabled` 这一格（给「原用例已删除」的占位项用）
  const caseOptions: { value: string; label: string; disabled?: boolean }[] = cases.map((item) => ({
    value: item.id,
    label: `${item.title} · ${displayRepoName(item.repoPath)} · ${
      item.commitHash === null ? '默认分支 HEAD' : shortHash(item.commitHash)
    }`,
  }));
  // 原用例已被删除（另一个标签页删的）：补一个**禁用**的占位项。
  // 不补的话 `Select` 显示空白，用户只改执行模式、一保存就把 caseId 换成了别的用例。
  if (editing && !cases.some((item) => item.id === initial.caseId)) {
    caseOptions.unshift({ value: initial.caseId, label: `${initial.caseTitle}（原用例已删除，请重新选择）`, disabled: true });
  }
```

（`displayRepoName` / `shortHash` 都已在文件顶部 import，不用新增。）

`handleFinish` 改成先过确认框：

```ts
  /**
   * 提交路径：**先把表单值收敛成 `RunFormValues`**，再决定要不要弹确认框。
   * 为什么要确认框：编辑是本次唯一会丢数据的动作（重置 / 删行），而它丢的东西用户看不见
   * （卡片上的分数会在保存后消失）。只改执行模式 / 评分方式时什么都不作废 ⇒ **不弹**。
   */
  const handleFinish = (values: FormValues): void => {
    const rows: RunFormValues['rows'] = [];
    for (const row of values.rows ?? []) {
      const decoded = row.modelKey === undefined ? null : decodeModelKey(row.modelKey);
      if (row.agentKind === undefined || decoded === null) continue;
      rows.push({
        ...(row.id === undefined ? {} : { id: row.id }),
        agentKind: row.agentKind,
        providerId: decoded.providerId,
        modelId: decoded.modelId,
      });
    }
    if (values.caseId === undefined || rows.length === 0) return;
    const submit: RunFormValues = {
      caseId: values.caseId,
      executionMode: values.executionMode ?? 'serial',
      useAgentJudge: values.useAgentJudge ?? false,
      rows,
    };

    const doomed = editing ? invalidatedRows(initial, submit) : [];
    if (doomed.length === 0) {
      onSubmit(submit);
      return;
    }
    modal.confirm({
      title: '保存后会作废这些行的已有结果？',
      width: 520,
      // 浮层根节点带类名：调用方与用例要能收窄到「这一个浮层」（页面上确认框不止一处）
      rootClassName: 'run-edit-confirm',
      content: (
        <Flex vertical gap={4}>
          <Typography.Text>保存后它们会回到「待开始」，已有的分数与产物不再显示：</Typography.Text>
          {doomed.map((row) => (
            <Typography.Text key={row.id} type="secondary">
              · {AGENT_LABELS[row.agentKind]} · {row.modelId}（{ROW_STATUS_LABELS[row.status]}）
            </Typography.Text>
          ))}
        </Flex>
      ),
      okText: '保存',
      cancelText: '取消',
      okButtonProps: { danger: true, autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: () => onSubmit(submit),
    });
  };
```

（`Typography` 要加进 antd 的 import；`initial` 在这一支里已由 `editing` 保证非空——TypeScript 的收窄需要写成 `editing && initial !== undefined ? …`，实施时按 TS 的收窄结果调整。）

`Form` 的 `initialValues`：

```tsx
      initialValues={
        editing
          ? {
            caseId: initial.caseId,
            executionMode: initial.executionMode,
            useAgentJudge: initial.useAgentJudge,
            rows: initial.rows.map((row) => ({
              id: row.id,
              agentKind: row.agentKind,
              modelKey: encodeModelKey(row.providerId, row.modelId),
            })),
          }
          : { executionMode: 'serial', useAgentJudge: false }
      }
```

`Form.List` 的 `initialValue` 只在**新建**时给（编辑时行来自 `initialValues.rows`）：

```tsx
      <Form.List
        name="rows"
        {...(editing ? {} : { initialValue: [{ agentKind: 'claude-code' as const }] })}
        rules={[{ validator: requireAtLeastOneRow }]}
      >
```

`Form.Item name={[field.name, 'modelKey']}` 里那个隐藏的行 id 用 `<Form.Item name={[field.name, 'id']} hidden noStyle><Input /></Form.Item>` 承载？**不用**：`initialValues` 里 `rows[i].id` 会被 `Form.List` 直接接管（它按 `rows` 的键走），`getFieldValue(['rows', field.name, 'id'])` 也读得到——`handleFinish` 读的是 `values.rows[i].id`，`Form` 会把 `initialValues` 里那一格一并交回来。**不要**再给 id 加一个 `Form.Item`（多一个控件等于多一个可能与 `initialValues` 不同步的来源）。

组件末尾加 `{contextHolder}`（已有 `return (<Form>…)`，把它包成 `<>{contextHolder}<Form …>…</Form></>`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @aieval/ui test src/composite/run-create-panel.test.tsx`
Expected: PASS（含既有的五组：模型池过滤 / 空池 Alert / 提交校验 / 智能体评分开关 / 执行模式顺序）

- [ ] **Step 5: 变异验证**

1. 把 `initialValues` 里的 `executionMode: initial.executionMode` 删掉 → `预填执行模式与用例` 必须红；
2. 把 `rows` 映射里的 `id: row.id` 删掉 → 同一条的 `rows[0].id` 断言必须红；
3. 把 `invalidatedRows` 里的 `if (!lostSomething) return false;` 删掉 → `改模型 ⇒ 只有那一行，且没跑过的行不算` 必须红；
4. 把原用例已删除那段 `caseOptions.unshift(...)` 删掉 → `原用例已被删除` 必须红。

- [ ] **Step 6: 补包根出口**

`packages/client/ui/src/index.ts`：

```ts
export {
  RunCreatePanel,
  invalidatedRows,
  type RunCreatePanelProps,
  type RunFormValues,
  type RunModelOption,
} from './composite/run-create-panel';
```

- [ ] **Step 7: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
```

```bash
git add packages/client/ui/src/composite/run-create-panel.tsx packages/client/ui/src/composite/run-create-panel.test.tsx packages/client/ui/src/index.ts
git commit -m "feat(ui): 创建面板支持编辑模式并加作废确认框"
```

---

## Task 9: web-next —— `runs-view` 三态与页面接线

**Files:**
- Modify: `apps/web-next/src/runs-view.ts`（`RunsPanelKind` / `parseRunsPanel` / `runsPanelHref`）
- Modify: `apps/web-next/src/runs-view.test.ts`（三态表）
- Modify: `apps/web-next/app/runs/page.tsx`（panel 三态、两个 hook、两个 handler）
- Test: `apps/web-next/src/runs-page-wiring.test.ts`（源码文本守卫）

**Interfaces:**
- Consumes: Task 6 的 `useUpdateRun` / `useDeleteRun`、Task 7 的 `RunDetailPanel` 新 props、Task 8 的 `RunCreatePanel` `mode` / `RunFormValues`
- Produces: 右栏 `?panel=detail|new|edit`；`RunsPanelKind = 'detail' | 'new' | 'edit'`

- [ ] **Step 1: 写失败的测试**

(a) `apps/web-next/src/runs-view.test.ts` 的 `it.each` 表加三行：

```ts
    ['?panel=edit&id=run-1', { panel: 'edit', id: 'run-1' }],
    // 编辑没有 id 等于没打开右栏（与 detail 同一条回落：半开的右栏是 ListDetailLayout 警告的形态）
    ['?panel=edit', { panel: null, id: null }],
    ['?panel=edit&id=', { panel: null, id: null }],
```

`runsPanelHref` 一组加：

```ts
    expect(runsPanelHref('edit', 'run-1')).toBe('/runs?panel=edit&id=run-1');
    expect(runsPanelHref('edit', null)).toBe('/runs');
```

(b) `apps/web-next/src/runs-page-wiring.test.ts` 末尾加：

```ts
/**
 * 「编辑 / 删除」的**接线**守卫（与上面两组同一类缺口）：数据层（`@aieval/client`）与展示层
 * （`@aieval/ui`）各自有自己的用例，而「页面有没有把它们接上」两边都看不见——
 * 漏接的症状是「详情面板上那两个按钮点了没反应」或「编辑保存后列表不刷新」，而各包用例全绿。
 * `apps/web-next` 不能写 `.tsx` 测试（AGENT.md 硬约束），故这里按源码文本钉住。
 */
describe('runs 页面的编辑 / 删除接线', () => {
  const source = (): string => readFileSync(pagePath, 'utf8');

  it('两个动作在页面里都从数据层取（useUpdateRun / useDeleteRun）', () => {
    expect(source()).toContain('useUpdateRun');
    expect(source()).toContain('useDeleteRun');
  });

  it('编辑走 update(run.id, values)、删除走 remove(run.id) 并回列表', () => {
    const text = source();
    expect(text).toContain('update(run.id, values)');
    expect(text).toContain('remove(run.id)');
    // 删除成功要回列表（无右栏），否则右栏会停在一条已经不存在的轮次上
    expect(text).toContain("runsPanelHref(null, null)");
  });

  it('编辑面板带 mode="edit" 与 initial（预填的唯一来源）', () => {
    const text = source();
    expect(text).toContain('mode="edit"');
    expect(text).toContain('initial={run}');
  });

  it('详情面板把两个回调接上，并把 deleting 透下去（不然确认框不会转圈）', () => {
    const text = source();
    expect(text).toContain('onEdit=');
    expect(text).toContain('onDelete=');
    expect(text).toContain('deleting={isDeleting}');
  });

  it('创建路径**显式剥掉**行 id（不依赖 zod 对未知键的静默剥离）', () => {
    // 只断言「创建那一支把 rows 重映射过」这一件事：整条表达式逐字匹配会被换行与格式化打红
    const text = source();
    expect(text).toContain('rows: values.rows.map(');
    expect(text).toContain('agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId');
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter @aieval/web-next test src/runs-view.test.ts src/runs-page-wiring.test.ts`
Expected: FAIL —— `?panel=edit&id=run-1` 实际解析成 `detail`；页面源码里找不到 `useUpdateRun`

- [ ] **Step 3: 实现 `runs-view.ts`**

```ts
/** 右栏的三种内容（spec §5.3 / §6.3：同一个栏位换内容，不叠加、不弹层） */
export type RunsPanelKind = 'detail' | 'new' | 'edit';
```

```ts
/**
 * 解析 `?panel=detail|new|edit&id=…`。
 * 规则：`new` 忽略 id；`detail` / `edit` 必须带非空 id，否则回落到「不显示右栏」；
 * 未知 `panel` 值按「有 id 就是详情」处理（旧链接/手敲 URL 不至于白屏）。
 * `edit` 必须被**显式**认出来：少了它，`?panel=edit&id=…` 会落到最后那条兜底上当详情渲染
 * （右栏显示的是只读详情，用户以为编辑入口坏了），而这类缺陷两端都不报错。
 */
export function parseRunsPanel(search: string | URLSearchParams): RunsPanelState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawId = params.get('id');
  const id = rawId === null || rawId === '' ? null : rawId;
  const rawPanel = params.get('panel');

  if (rawPanel === 'new') return { panel: 'new', id: null };
  // detail / edit / 未知面板共用同一条回落：没有 id 就不显示右栏
  if (id === null) return { panel: null, id: null };
  return { panel: rawPanel === 'edit' ? 'edit' : 'detail', id };
}

/** 面板 → URL；panel 为 null 时回到不带查询串的 `/runs`（「无右栏」这一态也可分享） */
export function runsPanelHref(panel: RunsPanelKind | null, id: string | null): string {
  if (panel === null) return '/runs';
  if (panel === 'new') return '/runs?panel=new';
  return id === null ? '/runs' : `/runs?panel=${panel}&id=${encodeURIComponent(id)}`;
}
```

- [ ] **Step 4: 实现 `app/runs/page.tsx`**

(a) import：`useUpdateRun`、`useDeleteRun` 加进 `@aieval/client` 的清单；`type RunFormValues` 加进 `@aieval/ui` 的清单。

(b) hooks：

```ts
  const { create, isCreating } = useCreateRun();
  const { update, isUpdating } = useUpdateRun();
  const { remove, isDeleting } = useDeleteRun();
```

(c) `selectedId` 放宽（详情与编辑都要取这一轮的快照）：

```ts
  const selectedId = panel.panel === 'detail' || panel.panel === 'edit' ? panel.id : null;
```

(d) `handleCreate` 改成收 `RunFormValues` 并**显式剥掉 id**：

```ts
  /**
   * 创建：把表单交回的 `RunFormValues` 收敛成契约的 `RunCreate`。
   * **显式剥掉 `id`**（不依赖 zod 对未知键的静默剥离）：创建路径不接受行身份这件事必须写在
   * 这里看得见的地方——靠 `RunCreateSchema` 的 strip 是隐式的，将来谁把 schema 改成 strict
   * 就会在运行期多出一堆 400。
   */
  const handleCreate = async (values: RunFormValues): Promise<void> => {
    const input: RunCreate = {
      caseId: values.caseId,
      executionMode: values.executionMode,
      useAgentJudge: values.useAgentJudge,
      rows: values.rows.map((row) => ({ agentKind: row.agentKind, providerId: row.providerId, modelId: row.modelId })),
    };
    try {
      const created = await create(input);
      router.replace(runsPanelHref('detail', created.id));
    } catch (cause) {
      void message.error(describeError(cause));
    }
  };

  /** 编辑：`RunFormValues` 与契约的 `RunUpdate` 逐字段一致，原样交给数据层 */
  const handleUpdate = async (values: RunFormValues): Promise<void> => {
    if (run === undefined) return;
    try {
      await update(run.id, values);
      void message.success('评测已保存');
      router.replace(runsPanelHref('detail', run.id));
    } catch (cause) {
      void message.error(describeError(cause));
    }
  };

  /**
   * 删除：**必须把在途 promise 交回确认框**（`RunDetailPanel` 的 `onDelete` 注释写明了原因）。
   * `workspaceRemoved === false` 时如实说一句「有残留」——盘子上的行工作区没能回收，
   * 那既不等于删除失败，也不该假装干净。
   */
  const handleDelete = (): Promise<void> | undefined => {
    if (run === undefined) return undefined;
    return remove(run.id)
      .then((result) => {
        void message.success(result.workspaceRemoved ? '评测已删除' : '评测已删除；行工作区有残留（被占用），可手动清理');
        closePanel();
      })
      .catch((error: unknown) => void message.error(describeError(error)));
  };
```

(e) 右栏渲染：

```tsx
  const detail =
    panel.panel === 'new' ? (
      <RunCreatePanel
        cases={cases ?? []}
        modelOptionsFor={optionsFor}
        judgeAgentConfigured={settings === undefined ? undefined : settings.defaultJudgeAgent !== null}
        saving={isCreating}
        onSubmit={(values) => void handleCreate(values)}
        onCancel={closePanel}
      />
    ) : panel.panel === 'edit' && run !== undefined ? (
      <RunCreatePanel
        // key 带上 id：`initialValues` 只在挂载时读一次，切换轮次必须重挂载（与 cases 页同手法）
        key={`run-edit-${run.id}`}
        mode="edit"
        initial={run}
        cases={cases ?? []}
        modelOptionsFor={optionsFor}
        judgeAgentConfigured={settings === undefined ? undefined : settings.defaultJudgeAgent !== null}
        saving={isUpdating}
        onSubmit={(values) => void handleUpdate(values)}
        onCancel={() => router.replace(runsPanelHref('detail', run.id))}
      />
    ) : selectedId === null ? null : (…) /* 既有三条分支原样保留 */
```

并在既有的 `RunDetailPanel` 那一段加三个 props：

```tsx
        onEdit={() => router.replace(runsPanelHref('edit', run.id))}
        onDelete={handleDelete}
        deleting={isDeleting}
```

(f) 文件头的「五条口径」补一条：

```
 *   6. **右栏三态**（2026-09-28）`?panel=detail|new|edit&id=…`：编辑与详情共用同一份快照
 *      （`selectedId` 两态都取 id）。与 `/cases` 的一处有意差异：runs 页没有需要复位的跨面板
 *      临时状态（用例页那套 `go()` 复位是为仓库校验回显服务的），故不引入那层。
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @aieval/web-next test`
Expected: PASS（`runs-view` / `runs-page-wiring` / `route-runs` 与该应用其余用例全绿）

- [ ] **Step 6: 变异验证**

1. 把 `parseRunsPanel` 里的 `rawPanel === 'edit' ? 'edit' : 'detail'` 改成 `'detail'` → `?panel=edit&id=run-1` 那一条必须红；
2. 把 `handleCreate` 里的 `rows: values.rows.map(…)` 换成 `rows: values.rows`（把 id 一起发出去）→ 页面接线那条「显式剥掉行 id」的文本守卫必须红；
3. 把 `deleting={isDeleting}` 删掉 → 对应文本守卫必须红。

- [ ] **Step 7: 全链检查并提交**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Expected: 全绿（这一步是分支级的收口：`pnpm test` 由根配置收齐 8 个包，**核对用例总数与逐包跑一致**）。

```bash
git add apps/web-next/src/runs-view.ts apps/web-next/src/runs-view.test.ts apps/web-next/app/runs/page.tsx apps/web-next/src/runs-page-wiring.test.ts
git commit -m "feat(web-next): 评测右栏三态与编辑 / 删除接线"
```

---

## Task 10: 冒烟与关账记录

**Files:**
- Create: `docs/superpowers/notes/2026-09-28-run-edit-delete-smoke.md`

**Interfaces:**
- Consumes: 前九个任务的全部产物（真实服务）
- Produces: 一份「范围清单 / 操作路径 / 证据 / 未覆盖项」四要素记录（`AGENT.md` 的冒烟口径）

- [ ] **Step 1: 起真实服务**

```bash
pnpm dev
```

（端口 3083 被占用时先 kill 占用进程再起——`AGENT.md` 的既有口径。）

- [ ] **Step 2: 按真实用户路径逐项操作**（用浏览器 MCP，逐项记录 ✅/❌）

1. `/runs` → 创建一轮（用例 + 2 候选 + 串行）→ 记下 `id`；
2. 详情卡右上出现「编辑 / 删除」两个按钮；
3. 点「编辑」→ 表单预填当前用例 / 执行模式 / 两行候选（**含行 id**）→ 改执行模式为并行 → 确定 → **不弹确认框**（什么都没作废）→ 保存后回到详情，列表那一列「执行模式」同步变成并行；
4. 再点「编辑」→ 改其中一个候选的模型 → 确定 → **弹出确认框并点名那一行** → 点「保存」→ 详情里那一行回到「待开始」、另一行原样；
5. 点「删除」→ `Popconfirm` 文案说清「行工作区与执行日志一起删掉」→ 确认 → 回到列表、这一轮消失；
6. 运行中置灰：开一轮并点「开始」，在它跑起来时回到详情，两个入口均禁用且 Tooltip 给出「先终止」；
7. 原用例被删除的轮次：删掉该用例（用例页）→ 回到这一轮的编辑表单 → 下拉显示「（原用例已删除，请重新选择）」且只改执行模式保存后 `caseId` 不变。

- [ ] **Step 3: 用 CLI 复核落盘事实（页面与磁盘互证）**

```powershell
# ① 编辑后：这一轮的快照里 executionMode / 行状态 / 那一行的分数
Get-Content "$env:USERPROFILE\.runs\<runId>\run.json" | ConvertFrom-Json | Select-Object executionMode,status,finishedAt
(Get-Content "$env:USERPROFILE\.runs\<runId>\run.json" | ConvertFrom-Json).rows | Select-Object id,modelId,status,attempts

# ② 删除后：目录必须整体消失（除非界面提示了「有残留」）
Test-Path "$env:USERPROFILE\.runs\<runId>"
```

把两条输出原样贴进记录里，并逐条写上「与页面上的哪个数字对应」。

- [ ] **Step 4: 写记录**

`docs/superpowers/notes/2026-09-28-run-edit-delete-smoke.md`，四要素齐：

```markdown
# 评测详情「修改 / 删除」冒烟记录（2026-09-28）

## 1. 范围清单
- [x] 详情面板的「编辑 / 删除」入口（含运行中置灰 + Tooltip 原因）
- [x] 编辑表单预填（用例 / 执行模式 / 智能体评分 / 候选行含行 id）
- [x] 只改执行模式 ⇒ 不弹确认框，且所有行结果逐字保留
- [x] 改模型 ⇒ 确认框点名该行，保存后只有该行回到「待开始」
- [x] 新增 / 删除候选行
- [x] 删除整轮（快照 + 产物），并核对磁盘
- [x] 原用例已被删除的轮次仍能编辑

## 2. 操作路径
（逐步骤写点击 / 输入序列）

## 3. 证据
（浏览器状态 + 上面两条 CLI 输出，逐条对应）

## 4. 未覆盖项与后续
（例如：两个标签页并发编辑只做了单标签页验证；留在旧根的轮次无法从界面删除——R5）
```

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/notes/2026-09-28-run-edit-delete-smoke.md
git commit -m "docs: 评测修改 / 删除的冒烟记录"
```

---

## 完成标准（分支级）

- `pnpm typecheck` / `pnpm lint` / `pnpm test` 三条全绿，且 `pnpm test` 的用例总数与逐包跑一致（`AGENT.md` 的收集范围口径）。
- 本计划里**每一条**新增守卫都做过变异验证，并在实现者的记录里写明「改回缺陷后哪条用例变红」。
- spec §8 的测试表逐行都有对应用例；spec §9 的五条风险各有一条用例、一条冒烟记录，或 spec 明文写下的「明确接受」（R1 / R2 属于后者，写在冒烟记录的「未覆盖项」里）。
