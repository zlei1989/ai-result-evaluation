// @vitest-environment node
/**
 * runRow：瞬时失败的自动重试
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：runRow：瞬时失败的自动重试、retryRow：单个评测项的重新执行（手动出口，界面文案「重新执行」，内部名仍是 retry）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  registerOrchestratorHooks,
  rowSettled,
  TEST_TIMEOUT_MS,
  until,
  seedRunnableRun,
  readEvents,
  rowEventsFile,
  drainRunningTasks,
  retryRow,
  runRow,
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


describe('retryRow：单个评测项的重新执行（手动出口，界面文案「重新执行」）', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **2026-09-29 口径修订**：这条用例原来是 `expect(() => retryRow(...)).toThrowError(/工作区未就绪/)`
   * ——「没跑过的行」当时被这条判据挡着，用户只能靠「开始」跑它，而「开始」会把**所有**可执行行一起跑。
   * 用户原话：「重新执行，只执行当前候选项，不要完成后重新执行下方已经执行过的候选项」。
   * 于是「没跑过」不再是拒绝理由（判据换成 `canRunRow`），这条用例随之翻面成**正例**：
   * 「没跑过的行也能单跑，而且 attempts 从 0 起算」由 `orchestrator-single-row.test.ts` 钉住
   * （那里还钉了「只动这一行」），这里只留一句「它不再是拒绝理由」的反向对照。
   */
  it('「没跑过」不再被拦下（判据换成 canRunRow 之后，这条路上不再有 CONFLICT）', () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // 起点：没基线、没 diff——旧判据（canRetryRow）在这一档上必抛，今天它照常起任务
    expect(run.rows[0]?.baselineCommit).toBe('');
    expect(run.rows[0]?.diff).toBeNull();
    expect(retryRow(run.id, rowId).rows[0]?.status).toBe('preparing');
    releaseAllAgents();
    return drainRunningTasks();
  });

  /**
   * **用户口径（2026-09-28 晚间修订）**：「已出分、无报错时取消禁用」。
   * 与之相对，早先那版口径是「已经测试完成且没有错误就不能重新评测」——本条用例正是那次反转的落点：
   * 判据不再排除 `judged`，重跑一次已出分的行是允许的（误点的代价由界面的 `Popconfirm` 拦）。
   */
  it('已经出分且没有报错的行照样能重新执行：整段重跑一遍，分数被新的结果替换', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    await runRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    const callsAfterFirstRun = fakeAgents.calls.length;

    fakeAgents.scripts.set('codex', { mode: 'ok' });
    const returned = retryRow(run.id, rowId);
    expect(returned.rows[0]?.status).toBe('preparing');

    await drainRunningTasks();
    await until(
      () => getRun(run.id).rows[0]?.status === 'judged',
      '已出分的行重新执行后仍是 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(run.id, rowId),
    );
    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    // attempts 累加（1 → 2）：不清零是既有口径，「这一行走过几次尝试」是累计事实
    expect(row?.attempts).toBe(2);
    // 候选 agent 真的又跑了一次（这就是「重新执行」与「重新评分」的分界）
    expect(fakeAgents.calls.length).toBe(callsAfterFirstRun + 1);
  });

  it('正例：失败的行重跑成功——状态回到 judged、候选真的又跑了一次、别的行不受影响', async () => {
    const { run } = seedRunnableRun({ rowCount: 2, executionMode: 'parallel' });
    const [first, second] = run.rows;
    const firstId = first?.id ?? '';
    // 两条行都用同一个假适配器脚本：先让它们都失败（且不触发自动重试：用非瞬时码）
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runRow(run.id, firstId);
    await runRow(run.id, second?.id ?? '');
    expect(getRun(run.id).rows.every((row) => row.status === 'failed')).toBe(true);
    // 失败阶段落盘：候选 agent 阶段 ⇒ 'agent'（叙述用：判据不再读它）
    expect(getRun(run.id).rows.every((row) => row.error?.stage === 'agent')).toBe(true);
    const callsAfterFailures = fakeAgents.calls.length;

    // 手动重试第一条行：脚本换成成功
    fakeAgents.scripts.set('codex', { mode: 'ok', files: [{ path: 'retried.txt', content: '重试的产出\n' }] });
    const returned = retryRow(run.id, firstId);

    // **同步**返回「已经进入准备中」的快照（HTTP 立即拿到，不挂在请求上等分钟级）
    expect(returned.rows.find((row) => row.id === firstId)?.status).toBe('preparing');
    await drainRunningTasks();
    // 这里**必须**再等一次状态收敛：`runRowAttempt` 的「准备」是同步重活（真 git 复制），
    // 长到足以让 `drainRunningTasks` 在它落盘之前返回（那条路径上 `retryTasks` 已删干净）。
    // 等待上限走用例自己的 `TEST_TIMEOUT_MS`，不是断言强度——判据仍是「最终必须 judged」
    await until(
      () => getRun(run.id).rows.find((row) => row.id === firstId)?.status === 'judged',
      '重试后回到 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(run.id, firstId),
    );

    const after = getRun(run.id);
    expect(after.rows.find((row) => row.id === firstId)?.status).toBe('judged');
    // 只动了这一行：第二条仍然是失败态（判据里的「单个评测项」就是这个意思）
    expect(after.rows.find((row) => row.id === second?.id)?.status).toBe('failed');
    // attempts 从 1（失败那次）累加到 2（手动重试那次）——不清零
    expect(after.rows.find((row) => row.id === firstId)?.attempts).toBe(2);
    // 候选真的又跑了一次（重试重跑整行，不是只重跑评分）
    expect(fakeAgents.calls.length).toBe(callsAfterFailures + 1);
    expect(fakeAgents.calls.at(-1)?.prompt).toContain('把 README 的标题改成中文');

    // ⚠️ `[重新执行]` 那一行标记事件**在重跑开始时就随 `resetEvents` 清掉了**（与「重跑同一行前清空日志」
    // 的既有口径一致）：所以这里不钉它。「重试发生过」由 `attempts = 2`、agent 调用次数与终态钉住。
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, firstId));
    expect(events.at(-1)).toMatchObject({ type: 'end', exitReason: 'completed' });
  });

  it('超时 / 被终止 / 被重启打断的行照样可以重新执行（它们同样「跑过一次且有产出」）', async () => {
    // 适配器**自报**超时（2026-09-28 起没有内层 timeoutMs、也没有编排层兜底超时了）
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // 行落 `timed-out`（阶段是 agent），并且工作区与 diff 都已就绪
    fakeAgents.scripts.set('codex', { selfTimeout: true });
    await runRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('timed-out');
    expect(getRun(run.id).rows[0]?.error?.stage).toBe('agent');

    fakeAgents.scripts.set('codex', { mode: 'ok' });
    const returned = retryRow(run.id, rowId);
    expect(returned.rows[0]?.status).toBe('preparing');
    releaseAllAgents();
    await drainRunningTasks();
    await until(
      () => getRun(run.id).rows[0]?.status === 'judged',
      '超时的行重新执行后回到 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(run.id, run.rows[0]?.id ?? ''),
    );
  });




});
