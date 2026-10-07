// @vitest-environment node
/**
 * runRow：瞬时失败的自动重试（切分后的第二块）
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
  home,
  seedRunnableRun,
  drainRunningTasks,
  retryRow,
  runRow,
  getRun,
  fakeAgents,
  releaseAllAgents,
  seedConfig,
} from './testing/orchestrator-harness';
import { injected } from './testing/orchestrator-seams';

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
  it('重试成功之后轮状态从 partial 翻回 done（收尾不能只发生在轮级任务里）', async () => {
    const { run } = seedRunnableRun({ rowCount: 2, executionMode: 'parallel', withJudge: true });
    const [first, second] = run.rows;
    const firstId = first?.id ?? '';
    const secondId = second?.id ?? '';
    // 第一条成功、第二条失败 ⇒ 这一轮跑完是 `partial`（正是「补完最后一个失败行」要覆盖的形状）
    // 假适配器的脚本按 kind 共用，故用**文件名**区分两次调用不可行；改用「先跑第一条成功的」两步：
    //   ① 只对第一条调 runRow（脚本 ok）→ 它 judged
    //   ② 换成失败脚本，对第二条调 runRow → 它 failed
    fakeAgents.scripts.set('codex', { mode: 'ok' });
    await runRow(run.id, firstId);
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runRow(run.id, secondId);
    expect(getRun(run.id).rows.find((row) => row.id === firstId)?.status).toBe('judged');
    expect(getRun(run.id).rows.find((row) => row.id === secondId)?.status).toBe('failed');

    // 修好之后手动重试：轮级收尾必须被补上（`retryRow` 不在 runTasks 里，startRun 的收尾够不着它）
    fakeAgents.scripts.set('codex', { mode: 'ok' });
    retryRow(run.id, secondId);
    await drainRunningTasks();
    // 与上一条同口径：等到该行真的落终态（准备阶段是同步重活，drain 可能先返回）
    await until(
      () => getRun(run.id).rows.find((row) => row.id === secondId)?.status === 'judged',
      '重试后回到 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(run.id, secondId),
    );

    expect(getRun(run.id).rows.find((row) => row.id === secondId)?.status).toBe('judged');
    // 全部行都出了分 ⇒ 轮状态必须翻回 `done`（`retryRow` 的 finally 里补的那一次 `finalizeRun`）
    expect(getRun(run.id).status).toBe('done');
  });
  it('正在运行中的行不许重新执行（先终止），与重评同一条处置', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'running', '行进入 running');

    expect(() => retryRow(run.id, rowId)).toThrowError(/正在运行中/);

    releaseAllAgents();
    await running;
  });
  it('用例被删之后不能重新执行（题面没有快照进 run.json）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // 先落到「可重新执行」的那一档（失败），否则拦下它的是判据本身、测不到「用例已删除」这一条
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runRow(run.id, rowId);
    seedConfig({ workspaceRoot: home.workspaceRoot }); // 用例没了
    expect(() => retryRow(run.id, rowId)).toThrowError(/用例已删除/);
  });
  it('入口区落盘失败 → 整段回退：该行之后仍能重新执行（不留一把打不开的锁）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runRow(run.id, rowId); // 先跑成 failed（可重新执行的那一档）

    injected.failRowSaveFor = run.id;
    expect(() => retryRow(run.id, rowId)).toThrowError(/夹具注入：行级落盘失败/);
    expect(injected.rowSaveFailed).toBe(true);
    expect(getRun(run.id).rows[0]?.status).toBe('failed');

    // 关键一步：同一个请求再来一次必须真的跑起来（回退没做时会抛「上一次的运行还没收尾」）
    fakeAgents.scripts.set('codex', { mode: 'ok' });
    const returned = retryRow(run.id, rowId);
    expect(returned.rows[0]?.status).toBe('preparing');
    await drainRunningTasks();
    await until(
      () => getRun(run.id).rows[0]?.status === 'judged',
      '回退之后重试照常跑到终态',
      TEST_TIMEOUT_MS,
      () => rowSettled(run.id, run.rows[0]?.id ?? ''),
    );
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
  });
});
