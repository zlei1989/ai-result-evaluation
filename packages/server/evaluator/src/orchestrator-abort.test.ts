// @vitest-environment node
/**
 * 终止语义
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：终止语义。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { registerOrchestratorHooks, TEST_TIMEOUT_MS, until, home, seedRunnableRun, startedCwds, expectedWorkspace, readEvents, candidateEventsFile, abortCandidate, abortRun, drainRunningTasks, rescoreCandidate, runCandidate, startRun, getRun, saveRun, fakeAgents, fakeJudge, releaseAgent, releaseJudge } from './testing/orchestrator-harness';

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

describe('终止语义', { timeout: TEST_TIMEOUT_MS }, () => {
  it('终止（串行）：正在跑的候选 canceled，还没轮到的候选 skipped，两者可区分', async () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    const aborted = abortRun(run.id);
    // 状态是**同步**落库的：调用返回时界面要看到的状态就已经在快照里了
    expect(aborted.candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'skipped', 'skipped']);

    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'skipped', 'skipped']);
    expect(saved.status).toBe('partial');
    // 后两个候选压根没有起过：skipped 不是「跑了但没分」
    expect(fakeAgents.calls).toHaveLength(1);
    const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, saved.candidates[0]?.id ?? ''));
    expect(events.some((event) => event.type === 'end' && event.exitReason === 'canceled')).toBe(true);
    // 被跳过的候选也有 end 事件：事件日志是唯一真相源，「它为什么没跑」要能从这里读出来
    const skippedEvents = readEvents(candidateEventsFile(home.workspaceRoot, run.id, saved.candidates[2]?.id ?? ''));
    expect(skippedEvents.some((event) => event.type === 'end' && event.exitReason === 'skipped')).toBe(true);
  });

  it('终止（并行）：正在跑的每个候选都是 canceled，没有 skipped', async () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 3, '三个候选都进入假适配器', 30_000);

    abortRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'canceled', 'canceled']);
    expect(saved.candidates.some((candidate) => candidate.status === 'skipped')).toBe(false);
  });

  it('单候选终止：跑着的候选 → canceled；排队中的候选 → skipped 且之后不会被启动', async () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    const candidates = getRun(run.id).candidates;
    const queued = candidates[1];
    if (queued === undefined) throw new Error('夹具应该有三个候选');
    abortCandidate(run.id, queued.id);
    expect(getRun(run.id).candidates[1]?.status).toBe('skipped');

    releaseAgent(startedCwds()[0] ?? '');
    await until(() => startedCwds().length === 2, '队列继续起下一行', 30_000);
    // 第二次起来的必须是第三个候选：第二行已经 skipped，不该再有开始的机会
    expect(startedCwds()[1]).toBe(expectedWorkspace(run.id, candidates[2]?.id ?? ''));

    releaseAgent(startedCwds()[1] ?? '');
    await drainRunningTasks();
    expect(getRun(run.id).candidates.map((candidate) => candidate.status)).toEqual(['judged', 'skipped', 'judged']);
  });

  /**
   * 整轮终止之后，串行队列**一个都不再起**——包括那些状态本来就不是 `pending` 的候选。
   * 为什么单独一条：`abortRun` 只能把 `pending` 的候选同步落成 `skipped`，而本轮的计划里可能还有
   * 上一轮留下的 `failed` / `interrupted` 行（「开始」会重跑它们）。只靠候选状态判「还要不要起下一行」
   * 时，这些行看不出任何变化 ⇒ 用户按了终止，队列照样把它们跑起来（终止也就等于没终止）。
   * 判据不靠 sleep：等**轮收尾**——终止后队列必须立刻停下，轮很快落到 `partial`；少了那笔轮级记录时
   * 队列会去起第二行（gate 挂住）⇒ 轮永远收不了场，`until` 超时即红。
   */
  it('终止（串行）：整轮终止后队列一个都不再起——队列里那个候选不是 pending（上一轮的 failed）也不例外', async () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'serial' });
    const candidates = run.candidates;
    const first = candidates[0];
    const second = candidates[1];
    const third = candidates[2];
    if (first === undefined || second === undefined || third === undefined) throw new Error('夹具应该有三个候选');
    // 第二候选是「上一轮失败、本轮要补跑」的候选：它的状态不是 pending，abortRun 不会碰它
    saveRun({
      ...run,
      candidates: [first, { ...second, status: 'failed' as const, error: { code: 'AGENT_FAILED', message: '上一轮失败' } }, third],
    });
    fakeAgents.scripts.set('codex', { mode: 'gate' });

    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    abortRun(run.id);
    // 被终止的候选自己会收尾（假适配器按 abort 返回 canceled），紧接着队列必须做出「起不起第二行」的决定
    await until(() => getRun(run.id).status === 'partial', '轮在终止后立刻收尾（队列没有继续起行）', 15_000);

    expect(fakeAgents.calls).toHaveLength(1);
    expect(getRun(run.id).candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'failed', 'skipped']);
  });

  /**
   * 单候选终止（**运行中分支**）：
   * 同一 describe 里 `abortCandidate` 打的是 **pending** 行（走 `:777-782` 的 skipped 分支），
   * 另有 CONFLICT 用例；而 `canceled` 的证据来自 `abortRun`（整轮终止，另一个函数）。
   * 「单候选终止 ⇒ canceled ⇒ 子进程与工作区按释放顺序收掉」这条路径既无单测也无真机（Run D 自认未执行）。
   *
   * 判据三条，缺一条都不足以说这条分支对：
   *   ① **同步**落成 `canceled`（调用返回时快照里就该是它——界面靠这个状态画卡片）；
   *   ② 该候选**恰好一条** `end` 事件且 `exitReason === 'canceled'`（事件日志是唯一真相源）；
   *   ③ 释放顺序 `interrupt → turn-end → dispose` 跑完（假适配器被 abort 后按协作适配器返回 canceled
   *      并在 finally 发 'turn-end'；编排层把 abort 传给 `input.signal`）——只断言终态会把
   *      「状态改了但子进程没人收」这种形状放过。
   * 另外钉住「单候选终止不影响别的候选」：串行队列会跳过这个候选继续跑后面的。
   */
  it('单候选终止（运行中分支）：该候选 canceled、恰好一条 end{canceled}、不影响其它行继续跑', async () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);

    const candidates = getRun(run.id).candidates;
    const running = candidates[0];
    if (running === undefined) throw new Error('夹具应该有三个候选');
    expect(running.status).toBe('running'); // 前提：这个候选真的在跑（走的就是 `isRunningCandidate` 那一支）

    const aborted = abortCandidate(run.id, running.id);

    // ① **同步**落库：调用返回时界面要看到的状态就已经在快照里（界面靠它立刻把卡片画成「已终止」）
    expect(aborted.candidates[0]?.status).toBe('canceled');
    // 其它两个候选不受影响：它们还没开始，既不是 canceled 也不是 skipped（那是整轮终止的语义）
    expect(aborted.candidates.slice(1).map((candidate) => candidate.status)).toEqual(['pending', 'pending']);

    // ② 事件日志是唯一真相源：该候选**恰好一条** `end`，且 exitReason 是 canceled
    //    （不是 skipped —— 那是「排队中被整轮终止」；也不是 completed/error）
    const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, running.id));
    const ends = events.filter((event) => event.type === 'end');
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ type: 'end', exitReason: 'canceled' });

    // ③ 停止信号真的发到了在途那一行（假适配器在 `input.signal` 的 abort 上记 aborted）
    await until(() => fakeAgents.calls[0]?.aborted === true, '该候选的 signal 已被 abort', 30_000);

    // ④ 单候选终止**不终止整轮**：串行队列跳过这个候选继续起下一行。
    //    刻意不 release 第一行：它的 signal 已经 abort，假适配器会自己收场，队列随即作出决定
    //    ——这正是「单个候选」与「整轮终止」（后者会把后面全部落成 skipped）的分界。
    await until(() => startedCwds().length >= 2, '队列继续起下一行', 30_000);
    expect(startedCwds()[1]).toBe(expectedWorkspace(run.id, candidates[1]?.id ?? ''));

    // 一次 abort 只对应一条 end：队列继续跑不会给该候选再补一条
    expect(readEvents(candidateEventsFile(home.workspaceRoot, run.id, running.id)).filter((event) => event.type === 'end'))
      .toHaveLength(1);

    // 别的候选的状态没有被这次 abort 动过（这里在**收尾之前**读：收尾会去起第三个候选）
    const midway = getRun(run.id);
    expect(midway.candidates[0]?.status).toBe('canceled');
    expect(midway.candidates[1]?.status).toBe('running');
    expect(midway.candidates[2]?.status).toBe('pending');

    // 收尾：放行在途的 gate 并等这一轮彻底结束。
    // ⚠️ 必须**确认第二候选的 gate 已经挂上**之后再放行（`startedCwds()` 只证明假适配器被调用过，
    // 它的 gate 是在 run() 内部稍后注册的）——否则 `releaseAllAgents()` 会在一个空集上放行，
    // 第三个候选随后挂上、没有任何人再放它，`drainRunningTasks()` 就永远等不完（实测踩到）。
    releaseAgent(startedCwds()[1] ?? '');
    await until(() => startedCwds().length >= 3, '队列起第三个候选', 30_000);
    releaseAgent(startedCwds()[2] ?? '');
    await drainRunningTasks();

    // 第二轮起的、以及第三个候选都正常跑完 ⇒ 单候选终止没有污染轮级状态
    const saved = getRun(run.id);
    expect(saved.candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'judged', 'judged']);
  }, TEST_TIMEOUT_MS);

  it('对已结束的候选调用 abortCandidate → CONFLICT（不是静默成功）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    startRun(run.id);
    await drainRunningTasks();
    const candidateId = getRun(run.id).candidates[0]?.id ?? '';
    expect(getRun(run.id).candidates[0]?.status).toBe('judged');

    expect(() => abortCandidate(run.id, candidateId)).toThrow(/已结束/);
  });

  it('没有在跑的候选时 abortRun → CONFLICT', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    expect(() => abortRun(run.id)).toThrow(/没有正在运行的候选/);

    startRun(run.id);
    await drainRunningTasks();
    expect(() => abortRun(run.id)).toThrow(/没有正在运行的候选/);
  });

  it('终止优先于评分结果：评分在终止之后才返回时，行保持 canceled，分数只进日志', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeJudge.mode = 'gate';

    startRun(run.id);
    await until(() => fakeJudge.calls.length === 1, '已进入评分阶段', 30_000);
    expect(getRun(run.id).candidates[0]?.status).toBe('judging');

    abortRun(run.id);
    expect(getRun(run.id).candidates[0]?.status).toBe('canceled');

    releaseJudge();
    await drainRunningTasks();

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('canceled'); // 没有被改成 judged
    expect(candidate?.score).toBeNull(); // 快照里不写分数
    const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidateId));
    /**
     * 证据留在日志里，而且**必须标出它的来源**。这一笔续作跑的时候行任务早已收尾
     * （`clearCandidateRuntime` 释放了 `candidateAborts`），用户可能已经点了「重新执行」——孤儿的 `score` 会夹在
     * 新一轮的事件之间，没有标记就会被当成**新一轮的分数**（事件日志是唯一真相源）。
     * 三条判据各钉一面：分**只出现一次**（标记不复制它）、带标记的 log 存在、且它紧排在分**之前**。
     */
    const scores = events.filter((event) => event.type === 'score');
    expect(scores).toHaveLength(1);
    const markerIndex = events.findIndex((event) => event.type === 'log' && event.text.includes('[已终止的尝试]'));
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeLessThan(events.findIndex((event) => event.type === 'score'));
  });

  /**
   * **准备阶段（`preparing`）被终止**。
   *
   * `startRun` 的同步前缀（`executeRun` → `runCandidate` → `runCandidateAttempt`）会把并行候选**全部**推到 `preparing`
   * 之后才返回（串行则是第一行），而 `isRunningCandidate('preparing') === true`（`contracts/src/run.ts`）⇒
   * 「点了开始马上点终止」这条最自然的用户动作**必定**落在这个窗口里：`abortRun` 同步把该候选落成
   * `canceled` + 写一条 `end`（这一步是对的）。
   *
   * 未修的形态：第一处 `await yieldToEventLoop()` 之后**没有复检**，于是继续 prepare → 注册 controller
   * （此时 abort 早已错过、新建的 signal 没被 abort）→ **无条件** `setCandidateStatus('running')` 把快照里的
   * `canceled` **复活**成 `running`、`agentProvider.run()` 真的被调用、收尾再补**第二条 `end`**；
   * 使用者按了终止而 agent 照跑（真实 CLI 进程、真实配额、工作区被改），正是设计里点名的
   * 「最难解释的候选为」那一类，也是「终态优先」（实现层修正第 5 条）唯一失效的窗口。
   *
   * 三条断言各自钉住半边，缺哪一条都能被「状态最终看起来是对的」混过去：
   *   ① 事件日志里**没有** `status:running`——复活会留下它，这是「agent 真的跑起来了」的直接证据；
   *   ② `end` **恰好一条**——T7 的幂等断言依赖的就是这条唯一性；
   *   ③ 假适配器的调用次数是 **0**——连工作区都不该被建出来（准备阶段的重活同样不该发生）。
   */
  it('准备阶段（preparing）被终止：行不再被复活成 running、agent 一次都不起、end 恰好一条（High-1）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 2, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { files: [{ path: '不该出现的产物.txt', content: 'agent 不该有机会跑\n' }] });

    startRun(run.id);
    // 同步前缀的必然结果：`startRun` 返回时两个候选都停在 preparing——就是那个窗口
    expect(getRun(run.id).candidates.map((candidate) => candidate.status)).toEqual(['preparing', 'preparing']);

    abortRun(run.id);
    expect(getRun(run.id).candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'canceled']);

    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.candidates.map((candidate) => candidate.status)).toEqual(['canceled', 'canceled']);
    expect(saved.status).toBe('partial');
    // ① agent 一次都没起：这一条是「终止真的生效」与「只是状态看起来对」的分界
    expect(fakeAgents.calls).toHaveLength(0);
    for (const candidate of saved.candidates) {
      const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidate.id));
      // ① 复活会留下一条 status:running
      expect(events.filter((event) => event.type === 'status' && event.status === 'running')).toEqual([]);
      // ② 第二条 end 与「终态优先」互斥
      expect(events.filter((event) => event.type === 'end')).toHaveLength(1);
      // 工作区也不该被建出来（workspacePath 只在 prepareCandidateWorkspace 之后才被写上）
      expect(candidate.workspacePath).toBe('');
    }
  });

  /**
   * **评分阶段的终止 race**：评分器不理 abort 时，用户终止之后这个候选也必须收场。
   *
   * 未修的形态（挂住）：评分那一步只有裸 `await`，而「行落终态」的唤醒器只接在**候选**阶段那个
   * `Promise.race` 上 ⇒ `abortCandidate` 同步把行落成 `canceled`，`runCandidateAttempt` 却一直等在评分调用上
   * （`turn.ts` 明写 `run()` 可能无界返回）：`runCandidate` 的 finally（`clearCandidateRuntime`）永不执行、
   * 轮级任务永不收尾。使用者的观感是「点了终止、状态变成已终止」，而这一轮从此永远停在「执行中」
   * （`assertRunMutable` 也一直拒它）——正是那条缺口。
   *
   * 判据为什么**不是**「候选状态是 canceled」：那一格由 `abortCandidate` **同步**落库，没有 race 的实现照样
   * 满足它（它只证明按钮生效，不证明任务收场）。收场的判据取**轮级收尾**：`finalizeRun` 只在所有行
   * 任务都返回之后才跑（`executeRun` 的 `Promise.all` 之后），故「这一轮落到 partial」⇔ 行任务收场。
   * `releaseJudge()` 故意留到断言之后：提前放行等于把这一条退化成「评分正常返回」，race 就白测了。
   */
  it('评分阶段：评分器不响应终止时，用户点「终止」后这个候选仍能收场（不能挂在评分调用上）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    // 评分器挂起且**无视 signal**（`fakeJudge` 的 gate 档：注释里写明它比真实的滴流响应还恶劣）——
    // 这就是「适配器不响应 abort」在评分阶段的可控复现；放行由用例末尾的 releaseJudge 手动给
    fakeJudge.mode = 'gate';

    startRun(run.id);
    await until(() => fakeJudge.calls.length === 1, '已进入评分阶段', 30_000);
    expect(getRun(run.id).candidates[0]?.status).toBe('judging');

    abortCandidate(run.id, candidateId);
    // 同步落库的那一格（abortCandidate 的承诺）：它**不是**收场的证据，下面那一格才是
    expect(getRun(run.id).candidates[0]?.status).toBe('canceled');

    await until(() => getRun(run.id).status === 'partial', '终止后这一轮收场（没有挂在评分调用上）', 15_000);
    await drainRunningTasks();

    expect(getRun(run.id).candidates[0]?.status).toBe('canceled');
    // 收场走的是 settleAgentJudgeStop → settleStopped 的「终态优先」：行已 canceled ⇒ 不再补第二条 end
    const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidateId));
    expect(events.filter((event) => event.type === 'end')).toHaveLength(1);

    releaseJudge(); // 事后放行：假评分器不该永久挂着（这时它放不放行都不影响上面的断言）
  });

  /**
   * 同一条 race 在**重新评分**那条旁路上的形状（`rescoreAttempt` 自己造唤醒器并注册
   * `terminalWaiters`，保持两条路同形）。
   *
   * 为什么必须单独一条：重评不在 `runTasks` 里，「行落终态」的唤醒器对它**没有任何现成的来源**——
   * 少了那次注册，`rescoreCandidate` 的任务会挂在评分调用上（`rescoreTasks` 记账不清 ⇒
   * `assertRunMutable` 恒拒、`drainRunningTasks` 空转），而**上面那条用例一个字都测不到它**。
   * 收场判据同样取轮级收尾：重评任务的 finally 会补一次 `finalizeRun`（见 `rescoreCandidate` 的头注）。
   */
  it('重新评分：评分器不响应终止时，重评任务也能收场（rescoreAttempt 自己注册唤醒器）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    // 起点：这个候选完整跑过一次（judged）。刻意直接调 runCandidate 而不是 startRun——轮状态保持 idle，
    // 于是下面「落到 partial」只可能来自重评任务的那一次收尾（判据的前提要能被断言钉住）
    await runCandidate(run.id, candidateId);
    expect(getRun(run.id).candidates[0]?.status).toBe('judged');
    expect(getRun(run.id).status).toBe('idle');

    fakeJudge.mode = 'gate';
    rescoreCandidate(run.id, candidateId);
    await until(() => fakeJudge.calls.length === 2, '重评已进入评分阶段', 30_000);
    expect(getRun(run.id).candidates[0]?.status).toBe('judging');

    abortCandidate(run.id, candidateId);
    expect(getRun(run.id).candidates[0]?.status).toBe('canceled');

    await until(() => getRun(run.id).status === 'partial', '终止后重评任务收场（补了一次轮收尾）', 15_000);
    await drainRunningTasks();
    expect(getRun(run.id).candidates[0]?.status).toBe('canceled');

    releaseJudge();
  });
});
