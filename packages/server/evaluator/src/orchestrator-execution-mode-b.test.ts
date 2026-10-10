// @vitest-environment node
/**
 * 执行模式：并行与串行（切分后的第二块）
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：执行模式：并行与串行、轮收尾的失败面（Medium-3）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  seedRunnableRun,
  startedCwds,
  expectedWorkspace,
  existsSync,
  join,
  drainRunningTasks,
  startRun,
  getRun,
  saveRun,
  fakeAgents,
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

describe('执行模式：并行与串行', { timeout: TEST_TIMEOUT_MS }, () => {
  it('串行下每行都有**独立**工作目录（防回归到「共用目录」这个致命错误）', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });

    startRun(run.id);
    await drainRunningTasks();

    const rows = getRun(run.id).rows;
    const dirs = rows.map((row) => row.workspacePath);
    const cwds = startedCwds();

    // 断言用「具体列表」而不是「不相等」这种模糊判断：失败时要能一眼看出撞到了哪个目录
    expect(new Set(dirs).size).toBe(3);
    expect(new Set(cwds).size).toBe(3);
    expect([...cwds].sort()).toEqual([...dirs].sort());
    for (const row of rows) {
      expect(row.workspacePath).toBe(expectedWorkspace(run.id, row.id));
      expect(existsSync(join(row.workspacePath, '.git'))).toBe(true);
    }
    // 分支名也必须各不相同（同一用例下多候选共用分支名会互相踩）
    expect(new Set(rows.map((row) => row.branch)).size).toBe(3);
  });
  it('「开始」只跑未完成的行：已 judged 的行不重跑', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    startRun(run.id);
    await drainRunningTasks();
    const afterFirstRound = fakeAgents.calls.length;
    expect(afterFirstRound).toBe(3);

    // 模拟「上一次跑完但有中间一行失败」：把第二行改回 failed 再开始
    const snapshot = getRun(run.id);
    const second = snapshot.rows[1];
    if (second === undefined) throw new Error('夹具应该有三行');
    second.status = 'failed';
    second.score = null;
    second.error = { code: 'AGENT_FAILED', message: '模拟上一次失败' };
    saveRun(snapshot);

    startRun(run.id);
    await drainRunningTasks();

    expect(fakeAgents.calls.length).toBe(afterFirstRound + 1); // 只补跑了失败的那一行
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'judged', 'judged']);
    expect(getRun(run.id).rows[1]?.error).toBeNull(); // 重跑成功要清掉上一次的错误
  });
});
