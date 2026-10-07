// @vitest-environment node
/**
 * 执行模式：并行与串行
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：执行模式：并行与串行、轮收尾的失败面（Medium-3）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  until,
  seedRunnableRun,
  startedCwds,
  drainRunningTasks,
  startRun,
  getRun,
  fakeAgents,
  releaseAgent,
  releaseAllAgents,
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

describe('执行模式：并行与串行', { timeout: TEST_TIMEOUT_MS }, () => {
  it('并行：所有行同时启动，没有任何一行等前一行结束', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });

    startRun(run.id);
    await until(() => startedCwds().length === 3, '三行都进入假适配器', 30_000);

    // 三行都挂在 gate 里、一行都没结束 —— 这是「同时启动」的直接证据（不是「很快相继启动」）
    expect(fakeAgents.concurrent).toBe(3);
    expect(getRun(run.id).rows.every((row) => row.status === 'running')).toBe(true);

    releaseAllAgents();
    await drainRunningTasks();

    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'judged', 'judged']);
    expect(getRun(run.id).status).toBe('done');
    expect(getRun(run.id).finishedAt).not.toBeNull();
  });

  it('串行：同一时刻只有一个 adapter 在跑，且前一行「含评分」结束后才起下一行', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });

    startRun(run.id);
    // startRun 的同步前缀只把第一行推到 preparing；agent 在让出事件循环后才起
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);
    expect(fakeAgents.maxConcurrent).toBe(1);
    expect(getRun(run.id).rows.filter((row) => row.status === 'pending')).toHaveLength(2);

    releaseAgent(startedCwds()[0] ?? '');
    await until(() => startedCwds().length === 2, '第二行进入假适配器', 30_000);
    // 起第二行时，第一行必须已经 judged：串行的定义是「一行跑完**含评分**才起下一行」（§5.2）
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    expect(fakeAgents.maxConcurrent).toBe(1);

    releaseAgent(startedCwds()[1] ?? '');
    await until(() => startedCwds().length === 3, '第三行进入假适配器', 30_000);
    releaseAgent(startedCwds()[2] ?? '');
    await drainRunningTasks();

    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'judged', 'judged']);
    expect(getRun(run.id).status).toBe('done');
    expect(fakeAgents.maxConcurrent).toBe(1);
  });


});


/**
 * 轮收尾的失败面（阶段评审 Medium-3）。
 *
 * `finalizeRun` 会因 `setRunStatus → saveRun` 失败而抛（磁盘满 / 快照被删 / 根目录形状非法），而它原先是在
 * `.finally` 里**裸调**的：`runTasks.delete(runId)` / `abortedRuns.delete(runId)` 排在它后面 ⇒ 抛了就
 * **永远不执行**。两个后果都不是「少写一行日志」：
 *   · 这一轮在**进程存活期内再也 `startRun` 不了**——第一道闸门 `runTasks.has(runId)` 恒真，恒抛
 *     CONFLICT「该评测已有候选行在运行」，而实际一行都没在跑（使用者只能重启服务）；
 *   · `drainRunningTasks` 的 `while (runTasks.size > 0)` 因为这条永不消失的条目**空转**；
 *   · `.finally()` 返回的 promise 在生产无人 await ⇒ 未处理 rejection（Node 默认会终结进程）。
 *
 * 判据取「收尾失败之后这一轮仍能重新开始」：这一轮的行故意跑成 `failed`
 *（`isRunnableRow('failed') === true`，即用户还能点「开始」补跑）⇒ 少了那次 `delete` 时它会红。
 */
describe('轮收尾的失败面（Medium-3）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('收尾落盘失败不会把这一轮锁死：在途记账照清、之后还能重新开始、错误有日志', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    // 让该行落 failed：这样这一轮不是「全 judged」，收尾会去写 partial —— 正是被注入失败的那一笔
    fakeAgents.scripts.set('codex', { mode: 'error' });
    injected.failRunStatusSaveFor = run.id;

    startRun(run.id);
    // 收尾那一笔被拒 = 该轮所有行都已结束且 executeRun 已 resolve（它一定晚于最后一行的落库）
    await until(() => injected.runStatusSaveFailed, '轮收尾那一笔落盘已被夹具拒绝', 30_000);

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['failed']);
    // 收尾失败这一轮会停在 running：这是要人来看的故障（磁盘 / 权限），不是应当静默吞掉的事
    expect(saved.status).toBe('running');

    // **第一条判据**：少了内层 finally 里的 delete 时，这一句会抛「该评测已有候选行在运行」——
    // 而实际上没有任何行在跑（这一轮在进程存活期内就再也点不动了）
    expect(() => startRun(run.id)).not.toThrow();

    // 第二条判据：收尾失败被**记下来**了（ERROR 级），而不是变成未处理 rejection 悄悄冒到进程上
    const errorText = error.mock.calls
      .map((call) => call.map((argument) => String(argument)).join(' '))
      .join('\n');
    expect(errorText).toContain('轮收尾失败');

    await drainRunningTasks();
  });
});
