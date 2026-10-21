// @vitest-environment node
/**
 * runCandidate：瞬时失败的自动重试
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：runCandidate：瞬时失败的自动重试、retryCandidate：单个评测项的重新执行（手动出口，界面文案「重新执行」，内部名仍是 retry）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  registerOrchestratorHooks,
  candidateSettled,
  TEST_TIMEOUT_MS,
  until,
  seedRunnableRun,
  readEvents,
  candidateEventsFile,
  drainRunningTasks,
  retryCandidate,
  runCandidate,
  getRun,
  fakeAgents,
  releaseAllAgents,
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


describe('retryCandidate：单个评测项的重新执行（手动出口，界面文案「重新执行」）', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **「没跑过」不是拒绝理由**（判据是 `canRunCandidate`）：用户原话「重新执行，只执行当前候选项，
   * 不要完成后重新执行下方已经执行过的候选项」——「开始」会把**所有**可执行候选一起跑，单个候选出口必须能只跑它。
   * 正向面（「没跑过的候选也能单跑，attempts 从 0 起算」「只动这个候选」）由 `orchestrator-single-candidate.test.ts` 钉住，
   * 这里只留一句反向对照。
   */
  it('「没跑过」不再被拦下（判据换成 canRunCandidate 之后，这条路上不再有 CONFLICT）', () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    // 起点：没基线、没 diff——旧判据（canRetryCandidate）在这一档上必抛，今天它照常起任务
    expect(run.candidates[0]?.baselineCommit).toBe('');
    expect(run.candidates[0]?.diff).toBeNull();
    expect(retryCandidate(run.id, candidateId).candidates[0]?.status).toBe('preparing');
    releaseAllAgents();
    return drainRunningTasks();
  });

  /**
   * **用户口径**：「已出分、无报错时取消禁用」。
   * 判据**不排除** `judged`：重跑一次已出分的候选是允许的（误点的代价由界面的 `Popconfirm` 拦）。
   */
  it('已经出分且没有报错的候选照样能重新执行：整段重跑一遍，分数被新的结果替换', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', withJudge: true });
    const candidateId = run.candidates[0]?.id ?? '';
    await runCandidate(run.id, candidateId);
    expect(getRun(run.id).candidates[0]?.status).toBe('judged');
    const callsAfterFirstRun = fakeAgents.calls.length;

    fakeAgents.scripts.set('codex', { mode: 'ok' });
    const returned = retryCandidate(run.id, candidateId);
    expect(returned.candidates[0]?.status).toBe('preparing');

    await drainRunningTasks();
    await until(
      () => getRun(run.id).candidates[0]?.status === 'judged',
      '已出分的候选重新执行后仍是 judged',
      TEST_TIMEOUT_MS,
      () => candidateSettled(run.id, candidateId),
    );
    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('judged');
    // attempts 累加（1 → 2）：不清零是既有口径，「这个候选走过几次尝试」是累计事实
    expect(candidate?.attempts).toBe(2);
    // 候选 agent 真的又跑了一次（这就是「重新执行」与「重新评分」的分界）
    expect(fakeAgents.calls.length).toBe(callsAfterFirstRun + 1);
  });

  it('正例：失败的候选重跑成功——状态回到 judged、候选真的又跑了一次、别的候选不受影响', async () => {
    const { run } = seedRunnableRun({ candidateCount: 2, executionMode: 'parallel' });
    const [first, second] = run.candidates;
    const firstId = first?.id ?? '';
    // 两条候选都用同一个假适配器脚本：先让它们都失败（且不触发自动重试：用非瞬时码）
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runCandidate(run.id, firstId);
    await runCandidate(run.id, second?.id ?? '');
    expect(getRun(run.id).candidates.every((candidate) => candidate.status === 'failed')).toBe(true);
    // 失败阶段落盘：候选 agent 阶段 ⇒ 'agent'（叙述用：判据不再读它）
    expect(getRun(run.id).candidates.every((candidate) => candidate.error?.stage === 'agent')).toBe(true);
    const callsAfterFailures = fakeAgents.calls.length;

    // 手动重试第一条行：脚本换成成功
    fakeAgents.scripts.set('codex', { mode: 'ok', files: [{ path: 'retried.txt', content: '重试的产出\n' }] });
    const returned = retryCandidate(run.id, firstId);

    // **同步**返回「已经进入准备中」的快照（HTTP 立即拿到，不挂在请求上等分钟级）
    expect(returned.candidates.find((candidate) => candidate.id === firstId)?.status).toBe('preparing');
    await drainRunningTasks();
    // 这里**必须**再等一次状态收敛：`runCandidateAttempt` 的「准备」是同步重活（真 git 复制），
    // 长到足以让 `drainRunningTasks` 在它落盘之前返回（那条路径上 `retryTasks` 已删干净）。
    // 等待上限走用例自己的 `TEST_TIMEOUT_MS`，不是断言强度——判据仍是「最终必须 judged」
    await until(
      () => getRun(run.id).candidates.find((candidate) => candidate.id === firstId)?.status === 'judged',
      '重试后回到 judged',
      TEST_TIMEOUT_MS,
      () => candidateSettled(run.id, firstId),
    );

    const after = getRun(run.id);
    expect(after.candidates.find((candidate) => candidate.id === firstId)?.status).toBe('judged');
    // 只动了这个候选：第二条仍然是失败态（判据里的「单个评测项」就是这个意思）
    expect(after.candidates.find((candidate) => candidate.id === second?.id)?.status).toBe('failed');
    // attempts 从 1（失败那次）累加到 2（手动重试那次）——不清零
    expect(after.candidates.find((candidate) => candidate.id === firstId)?.attempts).toBe(2);
    // 候选真的又跑了一次：**手动**「重新执行」重跑的是整个候选（与自动重试里「评分段失败只重跑评分」不同——
    // 那条口径见 `orchestrator-auto-retry.test.ts` 的评分段重试用例）
    expect(fakeAgents.calls.length).toBe(callsAfterFailures + 1);
    expect(fakeAgents.calls.at(-1)?.prompt).toContain('把 README 的标题改成中文');

    // ⚠️ `[重新执行]` 那一行标记事件**在重跑开始时就随 `resetEvents` 清掉了**（与「重跑同一行前清空日志」
    // 的既有口径一致）：所以这里不钉它。「重试发生过」由 `attempts = 2`、agent 调用次数与终态钉住。
    const events = readEvents(candidateEventsFile(run.workspaceBase, run.id, firstId));
    expect(events.at(-1)).toMatchObject({ type: 'end', exitReason: 'completed' });
  });

  it('超时 / 被终止 / 被重启打断的候选照样可以重新执行（它们同样「跑过一次且有产出」）', async () => {
    // 适配器**自报**超时（没有内层 timeoutMs、也没有编排层兜底超时）
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    // 行落 `timed-out`（阶段是 agent），并且工作区与 diff 都已就绪
    fakeAgents.scripts.set('codex', { selfTimeout: true });
    await runCandidate(run.id, candidateId);
    expect(getRun(run.id).candidates[0]?.status).toBe('timed-out');
    expect(getRun(run.id).candidates[0]?.error?.stage).toBe('agent');

    fakeAgents.scripts.set('codex', { mode: 'ok' });
    const returned = retryCandidate(run.id, candidateId);
    expect(returned.candidates[0]?.status).toBe('preparing');
    releaseAllAgents();
    await drainRunningTasks();
    await until(
      () => getRun(run.id).candidates[0]?.status === 'judged',
      '超时的候选重新执行后回到 judged',
      TEST_TIMEOUT_MS,
      () => candidateSettled(run.id, run.candidates[0]?.id ?? ''),
    );
  });




});
