// @vitest-environment node
/**
 * 单候选执行（用户口径）：「重新执行，只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
 *
 * 本文件钉的是**范围**，不是重跑本身（重跑的形状在 `orchestrator-retry.test.ts`）：
 *   · 没跑过的候选（`pending` / `skipped`，没有基线也没有 diff）也能单跑——今天只能靠「开始」，
 *     而「开始」会把**所有**可执行候选一起跑（`isRunnableCandidate`），「我只想跑这一个候选」无处表达；
 *   · 单跑一行时，**本轮其他行逐字不变**（状态 / 分数 / 计量 / 尝试账本 / 事件日志全都不动），
 *     串行队列也不推进——这条守卫就是那句口径的落点，它同时也是「谁把 `retryCandidate` 接到轮级执行上」
 *     这类改法的拦网（那种改法下别的候选会被连带重跑，而页面只会显示「跑完了」）。
 *
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import type { EvalCandidate } from '@aieval/contracts';
import {
  attemptRecordCount,
  canRunCandidate,
  canRetryCandidate,
  drainRunningTasks,
  fakeAgents,
  getRun,
  readEvents,
  registerOrchestratorHooks,
  retryCandidate,
  candidateEventsFile,
  candidateSettled,
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

/** 这个候选落终态前的**全部字段**（`until` 的 `impossible` 判据用它：非终态时不必冻结） */
function candidateOf(runId: string, candidateId: string): EvalCandidate {
  const candidate = getRun(runId).candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) throw new Error(`快照里没有这个候选：${candidateId}`);
  return candidate;
}

/** 等这个候选落终态（准备阶段是同步重活，`drainRunningTasks` 可能先返回——见 retry 文件的同款注释） */
async function waitSettled(runId: string, candidateId: string, label: string): Promise<void> {
  await until(
    () => candidateOf(runId, candidateId).status === 'judged',
    label,
    TEST_TIMEOUT_MS,
    () => candidateSettled(runId, candidateId),
  );
}

describe('单候选执行：判据在 contracts 上分了两档', { timeout: TEST_TIMEOUT_MS }, () => {
  it('没跑过的候选：可执行、但不可「重新执行」（两档判据不是同一件事）', () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidate = run.candidates[0] as EvalCandidate;

    expect(candidate.baselineCommit).toBe('');
    expect(candidate.diff).toBeNull();
    expect(canRunCandidate(candidate)).toBe(true);
    expect(canRetryCandidate(candidate)).toBe(false);
  });
});

describe('retryCandidate：只跑当前候选项（没跑过的候选也能单跑）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('没跑过的候选点「开始执行」：真的跑起来、落 judged，attempts 从 0 起算', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    expect(candidateOf(run.id, candidateId).attempts).toBe(0);

    const returned = retryCandidate(run.id, candidateId);

    // **同步**返回「已经进入准备中」的快照（与「重新执行」同一条出口，HTTP 不挂在请求上等分钟级）
    expect(returned.candidates[0]?.status).toBe('preparing');
    await drainRunningTasks();
    await waitSettled(run.id, candidateId, '没跑过的候选单跑之后落到 judged');

    const after = candidateOf(run.id, candidateId);
    expect(after.status).toBe('judged');
    // attempts 从 0 累加到 1：没跑过的候选与跑过的候选**共用同一个执行体**，这一格照旧是累计事实
    expect(after.attempts).toBe(1);
    // 候选 agent 真的跑了（单跑 = 候选 agent 与评分整段，不是只重算评分）
    expect(fakeAgents.calls.length).toBe(1);
  });

  /**
   * 这条用例就是用户那句口径的守卫：三个候选串行、先跑第 1 行与第 3 行（第 2 行**没跑过**），
   * 然后只单跑第 2 行。断言不是「第 2 候选跑成功了」——那是另一半——而是
   * **第 1 / 3 行逐字未变，且整轮只多了一次候选调用**。
   */
  it('串行轮次里只跑当前候选项：上方已出分的候选与下方已出分的候选都逐字未变', async () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'serial' });
    const [first, middle, last] = run.candidates;
    const firstId = first?.id ?? '';
    const middleId = middle?.id ?? '';
    const lastId = last?.id ?? '';

    // 先让「上方」与「下方」都跑过一次并出分（第 2 行始终 pending：这正是现实里那种轮次）
    await Promise.all([...run.candidates].filter((candidate) => candidate.id !== middleId).map((candidate) => retryCandidateAndSettle(run.id, candidate.id)));
    expect(candidateOf(run.id, firstId).status).toBe('judged');
    expect(candidateOf(run.id, lastId).status).toBe('judged');
    expect(candidateOf(run.id, middleId).status).toBe('pending');

    // 冻结两个候选的全部字段与它们的落盘事实（事件日志条数 + 尝试账本条数）
    const untouched = [firstId, lastId];
    const before = untouched.map((candidateId) => JSON.stringify(candidateOf(run.id, candidateId)));
    const eventsBefore = untouched.map((candidateId) => readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId)).length);
    const attemptsBefore = untouched.map((candidateId) => attemptRecordCount(run.id, candidateId));
    const callsBefore = fakeAgents.calls.length;

    // 只跑中间那一行
    retryCandidate(run.id, middleId);
    await drainRunningTasks();
    await waitSettled(run.id, middleId, '中间那一行单跑之后落到 judged');

    expect(candidateOf(run.id, middleId).status).toBe('judged');
    // ① 两个候选逐字未变：状态、分数、计量、diff、attempts 全在这一串里
    expect(untouched.map((candidateId) => JSON.stringify(candidateOf(run.id, candidateId)))).toEqual(before);
    // ② 它们的落盘事实也没被碰过（事件日志与尝试账本都只属于各自那一行）
    expect(untouched.map((candidateId) => readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId)).length)).toEqual(eventsBefore);
    expect(untouched.map((candidateId) => attemptRecordCount(run.id, candidateId))).toEqual(attemptsBefore);
    // ③ 整轮只多了一次候选调用 = 真的只有这个候选跑过（串行队列没有被推进）
    expect(fakeAgents.calls.length).toBe(callsBefore + 1);
  });
});

/** 让某一行单跑并等它落终态（上面那条用例的前置准备） */
async function retryCandidateAndSettle(runId: string, candidateId: string): Promise<void> {
  retryCandidate(runId, candidateId);
  await drainRunningTasks();
  await waitSettled(runId, candidateId, `准备阶段：${candidateId} 落到 judged`);
}
