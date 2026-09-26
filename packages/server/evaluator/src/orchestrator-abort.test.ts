// @vitest-environment node
/**
 * 终止语义（§5.4 的表）
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：终止语义（§5.4 的表）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { registerOrchestratorHooks, TEST_TIMEOUT_MS, until, home, seedRunnableRun, startedCwds, expectedWorkspace, readEvents, rowEventsFile, abortRow, abortRun, drainRunningTasks, startRun, getRun, saveRun, fakeAgents, fakeJudge, releaseAgent, releaseJudge } from './testing/orchestrator-harness';

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

describe('终止语义（§5.4 的表）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('终止（串行）：正在跑的行 canceled，还没轮到的行 skipped，两者可区分', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    const aborted = abortRun(run.id);
    // 状态是**同步**落库的：调用返回时界面要看到的状态就已经在快照里了
    expect(aborted.rows.map((row) => row.status)).toEqual(['canceled', 'skipped', 'skipped']);

    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['canceled', 'skipped', 'skipped']);
    expect(saved.status).toBe('partial');
    // 后两行压根没有起过：skipped 不是「跑了但没分」
    expect(fakeAgents.calls).toHaveLength(1);
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, saved.rows[0]?.id ?? ''));
    expect(events.some((event) => event.type === 'end' && event.exitReason === 'canceled')).toBe(true);
    // 被跳过的行也有 end 事件：事件日志是唯一真相源，「它为什么没跑」要能从这里读出来
    const skippedEvents = readEvents(rowEventsFile(home.workspaceRoot, run.id, saved.rows[2]?.id ?? ''));
    expect(skippedEvents.some((event) => event.type === 'end' && event.exitReason === 'skipped')).toBe(true);
  });

  it('终止（并行）：正在跑的每一行都是 canceled，没有 skipped', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 3, '三行都进入假适配器', 30_000);

    abortRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['canceled', 'canceled', 'canceled']);
    expect(saved.rows.some((row) => row.status === 'skipped')).toBe(false);
  });

  it('单行终止：跑着的行 → canceled；排队中的行 → skipped 且之后不会被启动', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    const rows = getRun(run.id).rows;
    const queued = rows[1];
    if (queued === undefined) throw new Error('夹具应该有三行');
    abortRow(run.id, queued.id);
    expect(getRun(run.id).rows[1]?.status).toBe('skipped');

    releaseAgent(startedCwds()[0] ?? '');
    await until(() => startedCwds().length === 2, '队列继续起下一行', 30_000);
    // 第二次起来的必须是第三行：第二行已经 skipped，不该再有开始的机会
    expect(startedCwds()[1]).toBe(expectedWorkspace(run.id, rows[2]?.id ?? ''));

    releaseAgent(startedCwds()[1] ?? '');
    await drainRunningTasks();
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['judged', 'skipped', 'judged']);
  });

  /**
   * 整轮终止之后，串行队列**一个都不再起**——包括那些状态本来就不是 `pending` 的行。
   * 为什么单独一条：`abortRun` 只能把 `pending` 的行同步落成 `skipped`，而本轮的计划里可能还有
   * 上一轮留下的 `failed` / `interrupted` 行（「开始」会重跑它们）。只靠行状态判「还要不要起下一行」
   * 时，这些行看不出任何变化 ⇒ 用户按了终止，队列照样把它们跑起来（终止也就等于没终止）。
   * 判据不靠 sleep：等**轮收尾**——终止后队列必须立刻停下，轮很快落到 `partial`；少了那笔轮级记录时
   * 队列会去起第二行（gate 挂住）⇒ 轮永远收不了场，`until` 超时即红。
   */
  it('终止（串行）：整轮终止后队列一个都不再起——队列里那行不是 pending（上一轮的 failed）也不例外（§5.4）', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    const rows = run.rows;
    const first = rows[0];
    const second = rows[1];
    const third = rows[2];
    if (first === undefined || second === undefined || third === undefined) throw new Error('夹具应该有三行');
    // 第二行是「上一轮失败、本轮要补跑」的行：它的状态不是 pending，abortRun 不会碰它
    saveRun({
      ...run,
      rows: [first, { ...second, status: 'failed' as const, error: { code: 'AGENT_FAILED', message: '上一轮失败' } }, third],
    });
    fakeAgents.scripts.set('codex', { mode: 'gate' });

    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    abortRun(run.id);
    // 被终止的行自己会收尾（假适配器按 abort 返回 canceled），紧接着队列必须做出「起不起第二行」的决定
    await until(() => getRun(run.id).status === 'partial', '轮在终止后立刻收尾（队列没有继续起行）', 15_000);

    expect(fakeAgents.calls).toHaveLength(1);
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['canceled', 'failed', 'skipped']);
  });

  /**
   * 单行终止（**运行中分支**，终审 M3）：`orchestrator.ts:767-775` 此前零测试——
   * 同一 describe 里 `abortRow` 打的是 **pending** 行（走 `:777-782` 的 skipped 分支），
   * 另有 CONFLICT 用例；而 p6 的 `canceled` 证据来自 `abortRun`（整轮终止，另一个函数）。
   * 「单行终止 ⇒ canceled ⇒ 子进程与工作区按释放顺序收掉」这条路径既无单测也无真机（Run D 自认未执行）。
   *
   * 判据三条，缺一条都不足以说这条分支对：
   *   ① **同步**落成 `canceled`（调用返回时快照里就该是它——界面靠这个状态画卡片）；
   *   ② 该行**恰好一条** `end` 事件且 `exitReason === 'canceled'`（事件日志是唯一真相源）；
   *   ③ 释放顺序 `interrupt → turn-end → dispose` 跑完（假适配器被 abort 后按协作适配器返回 canceled
   *      并在 finally 发 'turn-end'；编排层把 abort 传给 `input.signal`）——只断言终态会把
   *      「状态改了但子进程没人收」这种形状放过。
   * 另外钉住「单行终止不影响别的行」：串行队列会跳过这一行继续跑后面的。
   */
  it('单行终止（运行中分支）：该行 canceled、恰好一条 end{canceled}、不影响其它行继续跑', async () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    const rows = getRun(run.id).rows;
    const running = rows[0];
    if (running === undefined) throw new Error('夹具应该有三行');
    expect(running.status).toBe('running'); // 前提：这一行真的在跑（走的就是 `isRunningRow` 那一支）

    const aborted = abortRow(run.id, running.id);

    // ① **同步**落库：调用返回时界面要看到的状态就已经在快照里（界面靠它立刻把卡片画成「已终止」）
    expect(aborted.rows[0]?.status).toBe('canceled');
    // 其它两行不受影响：它们还没开始，既不是 canceled 也不是 skipped（那是整轮终止的语义）
    expect(aborted.rows.slice(1).map((row) => row.status)).toEqual(['pending', 'pending']);

    // ② 事件日志是唯一真相源：该行**恰好一条** `end`，且 exitReason 是 canceled
    //    （不是 skipped —— 那是「排队中被整轮终止」；也不是 completed/error）
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, running.id));
    const ends = events.filter((event) => event.type === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'end', exitReason: 'canceled' });

    // ③ 停止信号真的发到了在途那一行（假适配器在 `input.signal` 的 abort 上记 aborted）
    await until(() => fakeAgents.calls[0]?.aborted === true, '该行的 signal 已被 abort', 30_000);

    // ④ 单行终止**不终止整轮**：串行队列跳过这一行继续起下一行。
    //    刻意不 release 第一行：它的 signal 已经 abort，假适配器会自己收场，队列随即作出决定
    //    ——这正是「单行」与「整轮终止」（后者会把后面全部落成 skipped）的分界。
    await until(() => startedCwds().length >= 2, '队列继续起下一行', 30_000);
    expect(startedCwds()[1]).toBe(expectedWorkspace(run.id, rows[1]?.id ?? ''));

    // 一次 abort 只对应一条 end：队列继续跑不会给该行再补一条
    expect(readEvents(rowEventsFile(home.workspaceRoot, run.id, running.id)).filter((event) => event.type === 'end'))
      .toHaveLength(1);

    // 别的行的状态没有被这次 abort 动过（这里在**收尾之前**读：收尾会去起第三行）
    const midway = getRun(run.id);
    expect(midway.rows[0]?.status).toBe('canceled');
    expect(midway.rows[1]?.status).toBe('running');
    expect(midway.rows[2]?.status).toBe('pending');

    // 收尾：放行在途的 gate 并等这一轮彻底结束。
    // ⚠️ 必须**确认第二行的 gate 已经挂上**之后再放行（`startedCwds()` 只证明假适配器被调用过，
    // 它的 gate 是在 run() 内部稍后注册的）——否则 `releaseAllAgents()` 会在一个空集上放行，
    // 第三行随后挂上、没有任何人再放它，`drainRunningTasks()` 就永远等不完（实测踩到）。
    releaseAgent(startedCwds()[1] ?? '');
    await until(() => startedCwds().length >= 3, '队列起第三行', 30_000);
    releaseAgent(startedCwds()[2] ?? '');
    await drainRunningTasks();

    // 第二轮起的、以及第三行都正常跑完 ⇒ 单行终止没有污染轮级状态
    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['canceled', 'judged', 'judged']);
  }, TEST_TIMEOUT_MS);

  it('对已结束的行调用 abortRow → CONFLICT（不是静默成功）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    startRun(run.id);
    await drainRunningTasks();
    const rowId = getRun(run.id).rows[0]?.id ?? '';
    expect(getRun(run.id).rows[0]?.status).toBe('judged');

    expect(() => abortRow(run.id, rowId)).toThrow(/已结束/);
  });

  it('没有在跑的行时 abortRun → CONFLICT', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    expect(() => abortRun(run.id)).toThrow(/没有正在运行的候选行/);

    startRun(run.id);
    await drainRunningTasks();
    expect(() => abortRun(run.id)).toThrow(/没有正在运行的候选行/);
  });

  it('终止优先于评分结果：评分在终止之后才返回时，行保持 canceled，分数只进日志', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'gate';

    startRun(run.id);
    await until(() => fakeJudge.calls.length === 1, '已进入评分阶段', 30_000);
    expect(getRun(run.id).rows[0]?.status).toBe('judging');

    abortRun(run.id);
    expect(getRun(run.id).rows[0]?.status).toBe('canceled');

    releaseJudge();
    await drainRunningTasks();

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('canceled'); // 没有被改成 judged
    expect(row?.score).toBeNull(); // 快照里不写分数
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(events.some((event) => event.type === 'score')).toBe(true); // 但证据留在日志里
  });

  /**
   * **准备阶段（`preparing`）被终止**（阶段评审 High-1）。
   *
   * `startRun` 的同步前缀（`executeRun` → `runRow` → `runRowAttempt`）会把并行行**全部**推到 `preparing`
   * 之后才返回（串行则是第一行），而 `isRunningRow('preparing') === true`（`contracts/src/run.ts`）⇒
   * 「点了开始马上点终止」这条最自然的用户动作**必定**落在这个窗口里：`abortRun` 同步把该行落成
   * `canceled` + 写一条 `end`（这一步是对的）。
   *
   * 未修的形态：第一处 `await yieldToEventLoop()` 之后**没有复检**，于是继续 prepare → 注册 controller
   * （此时 abort 早已错过、新建的 signal 没被 abort）→ **无条件** `setRowStatus('running')` 把快照里的
   * `canceled` **复活**成 `running`、`agentProvider.run()` 真的被调用、收尾再补**第二条 `end`**；
   * 使用者按了终止而 agent 照跑（真实 CLI 进程、真实配额、工作区被改），正是设计里点名的
   * 「最难解释的行为」那一类，也是「终态优先」（实现层修正第 5 条）唯一失效的窗口。
   *
   * 三条断言各自钉住半边，缺哪一条都能被「状态最终看起来是对的」混过去：
   *   ① 事件日志里**没有** `status:running`——复活会留下它，这是「agent 真的跑起来了」的直接证据；
   *   ② `end` **恰好一条**——T7 的幂等断言依赖的就是这条唯一性；
   *   ③ 假适配器的调用次数是 **0**——连工作区都不该被建出来（准备阶段的重活同样不该发生）。
   */
  it('准备阶段（preparing）被终止：行不再被复活成 running、agent 一次都不起、end 恰好一条（High-1）', async () => {
    const { run } = seedRunnableRun({ rowCount: 2, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { files: [{ path: '不该出现的产物.txt', content: 'agent 不该有机会跑\n' }] });

    startRun(run.id);
    // 同步前缀的必然结果：`startRun` 返回时两行都停在 preparing——就是那个窗口
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['preparing', 'preparing']);

    abortRun(run.id);
    expect(getRun(run.id).rows.map((row) => row.status)).toEqual(['canceled', 'canceled']);

    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['canceled', 'canceled']);
    expect(saved.status).toBe('partial');
    // ① agent 一次都没起：这一条是「终止真的生效」与「只是状态看起来对」的分界
    expect(fakeAgents.calls).toHaveLength(0);
    for (const row of saved.rows) {
      const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, row.id));
      // ① 复活会留下一条 status:running
      expect(events.filter((event) => event.type === 'status' && event.status === 'running')).toEqual([]);
      // ② 第二条 end 与「终态优先」互斥
      expect(events.filter((event) => event.type === 'end')).toHaveLength(1);
      // 工作区也不该被建出来（workspacePath 只在 prepareRowWorkspace 之后才被写上）
      expect(row.workspacePath).toBe('');
    }
  });
});
