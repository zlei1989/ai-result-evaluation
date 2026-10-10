// @vitest-environment node
/**
 * 单行执行（用户口径）：「重新执行，只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
 *
 * 本文件钉的是**范围**，不是重跑本身（重跑的形状在 `orchestrator-retry.test.ts`）：
 *   · 没跑过的行（`pending` / `skipped`，没有基线也没有 diff）也能单跑——今天只能靠「开始」，
 *     而「开始」会把**所有**可执行行一起跑（`isRunnableRow`），「我只想跑这一个候选」无处表达；
 *   · 单跑一行时，**本轮其他行逐字不变**（状态 / 分数 / 计量 / 尝试账本 / 事件日志全都不动），
 *     串行队列也不推进——这条守卫就是那句口径的落点，它同时也是「谁把 `retryRow` 接到轮级执行上」
 *     这类改法的拦网（那种改法下别的行会被连带重跑，而页面只会显示「跑完了」）。
 *
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import type { EvalRow } from '@aieval/contracts';
import {
  attemptRecordCount,
  canRunRow,
  canRetryRow,
  drainRunningTasks,
  fakeAgents,
  getRun,
  readEvents,
  registerOrchestratorHooks,
  retryRow,
  rowEventsFile,
  rowSettled,
  seedRunnableRun,
  TEST_TIMEOUT_MS,
  until,
} from './testing/orchestrator-harness';

vi.mock('@aieval/agents', async () => (await import('./testing/orchestrator-seams')).agentsMock());
vi.mock('./judge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge')>();
  return (await import('./testing/orchestrator-seams')).judgeMock(actual);
});
vi.mock('./run-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./run-store')>();
  return (await import('./testing/orchestrator-seams')).runStoreMock(actual);
});

registerOrchestratorHooks();

/** 这一行落终态前的**全部字段**（`until` 的 `impossible` 判据用它：非终态时不必冻结） */
function rowOf(runId: string, rowId: string): EvalRow {
  const row = getRun(runId).rows.find((item) => item.id === rowId);
  if (row === undefined) throw new Error(`快照里没有这一行：${rowId}`);
  return row;
}

/** 等这一行落终态（准备阶段是同步重活，`drainRunningTasks` 可能先返回——见 retry 文件的同款注释） */
async function waitSettled(runId: string, rowId: string, label: string): Promise<void> {
  await until(
    () => rowOf(runId, rowId).status === 'judged',
    label,
    TEST_TIMEOUT_MS,
    () => rowSettled(runId, rowId),
  );
}

describe('单行执行：判据在 contracts 上分了两档', { timeout: TEST_TIMEOUT_MS }, () => {
  it('没跑过的行：可执行、但不可「重新执行」（两档判据不是同一件事）', () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const row = run.rows[0] as EvalRow;

    expect(row.baselineCommit).toBe('');
    expect(row.diff).toBeNull();
    expect(canRunRow(row)).toBe(true);
    expect(canRetryRow(row)).toBe(false);
  });
});

describe('retryRow：只跑当前候选项（没跑过的行也能单跑）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('没跑过的行点「开始执行」：真的跑起来、落 judged，attempts 从 0 起算', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    expect(rowOf(run.id, rowId).attempts).toBe(0);

    const returned = retryRow(run.id, rowId);

    // **同步**返回「已经进入准备中」的快照（与「重新执行」同一条出口，HTTP 不挂在请求上等分钟级）
    expect(returned.rows[0]?.status).toBe('preparing');
    await drainRunningTasks();
    await waitSettled(run.id, rowId, '没跑过的行单跑之后落到 judged');

    const after = rowOf(run.id, rowId);
    expect(after.status).toBe('judged');
    // attempts 从 0 累加到 1：没跑过的行与跑过的行**共用同一个执行体**，这一格照旧是累计事实
    expect(after.attempts).toBe(1);
    // 候选 agent 真的跑了（单跑 = 候选 agent 与评分整段，不是只重算评分）
    expect(fakeAgents.calls.length).toBe(1);
  });

  /**
   * 这条用例就是用户那句口径的守卫：三行串行、先跑第 1 行与第 3 行（第 2 行**没跑过**），
   * 然后只单跑第 2 行。断言不是「第 2 行跑成功了」——那是另一半——而是
   * **第 1 / 3 行逐字未变，且整轮只多了一次候选调用**。
   */
  it('串行轮次里只跑当前候选项：上方已出分的行与下方已出分的行都逐字未变', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    const [first, middle, last] = run.rows;
    const firstId = first?.id ?? '';
    const middleId = middle?.id ?? '';
    const lastId = last?.id ?? '';

    // 先让「上方」与「下方」都跑过一次并出分（第 2 行始终 pending：这正是现实里那种轮次）
    await Promise.all([...run.rows].filter((row) => row.id !== middleId).map((row) => retryRowAndSettle(run.id, row.id)));
    expect(rowOf(run.id, firstId).status).toBe('judged');
    expect(rowOf(run.id, lastId).status).toBe('judged');
    expect(rowOf(run.id, middleId).status).toBe('pending');

    // 冻结两行的全部字段与它们的落盘事实（事件日志条数 + 尝试账本条数）
    const untouched = [firstId, lastId];
    const before = untouched.map((rowId) => JSON.stringify(rowOf(run.id, rowId)));
    const eventsBefore = untouched.map((rowId) => readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).length);
    const attemptsBefore = untouched.map((rowId) => attemptRecordCount(run.id, rowId));
    const callsBefore = fakeAgents.calls.length;

    // 只跑中间那一行
    retryRow(run.id, middleId);
    await drainRunningTasks();
    await waitSettled(run.id, middleId, '中间那一行单跑之后落到 judged');

    expect(rowOf(run.id, middleId).status).toBe('judged');
    // ① 两行逐字未变：状态、分数、计量、diff、attempts 全在这一串里
    expect(untouched.map((rowId) => JSON.stringify(rowOf(run.id, rowId)))).toEqual(before);
    // ② 它们的落盘事实也没被碰过（事件日志与尝试账本都只属于各自那一行）
    expect(untouched.map((rowId) => readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).length)).toEqual(eventsBefore);
    expect(untouched.map((rowId) => attemptRecordCount(run.id, rowId))).toEqual(attemptsBefore);
    // ③ 整轮只多了一次候选调用 = 真的只有这一行跑过（串行队列没有被推进）
    expect(fakeAgents.calls.length).toBe(callsBefore + 1);
  });
});

/** 让某一行单跑并等它落终态（上面那条用例的前置准备） */
async function retryRowAndSettle(runId: string, rowId: string): Promise<void> {
  retryRow(runId, rowId);
  await drainRunningTasks();
  await waitSettled(runId, rowId, `准备阶段：${rowId} 落到 judged`);
}
