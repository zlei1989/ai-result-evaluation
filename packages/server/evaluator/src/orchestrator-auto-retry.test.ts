// @vitest-environment node
/**
 * runCandidate：瞬时失败的自动重试
 *
 * 本文件是从 `orchestrator-retry.test.ts` 拆出来的一半（同前导块、同 harness）：
 * 一个文件里的用例是**顺序**跑的，拆开才能让两块并行。
 */
import { vi, describe, expect, it, beforeEach } from 'vitest';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  PRODUCTION_CANDIDATE_RETRIES,
  PRODUCTION_CANDIDATE_RETRY_DELAY_MS,
  seedRunnableRun,
  readFileSync,
  readEvents,
  candidateAttemptsFile,
  candidateEventsFile,
  CANDIDATE_RETRY,
  runCandidate,
  getRun,
  fakeAgents,
  fakeJudge,
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


/* ===================================================================================================
 * 重试（目标口径「单个评测项执行的失败或评分失败支持重试」）
 *
 * 两个层次，两套判据，**都**要钉住：
 *   · **自动**重试（`runCandidate` 内层循环）：只重试瞬时面（网络 / 5xx / 限流 / CLI 起不来），
 *     不重试超时（分钟级的成本）与用户终止（用户意图）；
 *   · **手动**重试（`retryCandidate`）：用户点一下就重跑这个候选的 agent + 评分，
 *     不动别的候选，也不改轮级模式。
 * `attempts` 是这两者共同的记账（累加、不清零）——「试了三次才成功」必须看得出来。
 * =================================================================================================== */

/* ===================================================================================================
 * 重试（目标口径「单个评测项执行的失败或评分失败支持重试」）
 *
 * 两个层次，两套判据，**都**要钉住：
 *   · **自动**重试（`runCandidate` 内层循环）：只重试瞬时面（网络 / 5xx / 限流 / CLI 起不来），
 *     不重试超时（分钟级的成本）与用户终止（用户意图）；
 *   · **手动**重试（`retryCandidate`）：用户点一下就重跑这个候选的 agent + 评分，
 *     不动别的候选，也不改轮级模式。
 * `attempts` 是这两者共同的记账（累加、不清零）——「试了三次才成功」必须看得出来。
 * =================================================================================================== */
describe('runCandidate：瞬时失败的自动重试', { timeout: TEST_TIMEOUT_MS }, () => {
  beforeEach(() => {
    // 这一组测的就是重试本身：打开产品默认的重试预算（`beforeEach` 里为其它用例关掉了它）
    CANDIDATE_RETRY.maxRetries = PRODUCTION_CANDIDATE_RETRIES;
  });

  it('产品默认值：最多重试 2 次、退避 3 秒（数值本身是口径，用例显式钉住）', () => {
    // 用例里会把 delayMs 改成 1ms、把 maxRetries 改成 0：不在这里钉默认值，默认值就成了无人验证的常量
    expect(PRODUCTION_CANDIDATE_RETRIES).toBe(2);
    expect(PRODUCTION_CANDIDATE_RETRY_DELAY_MS).toBe(3_000);
  });

  it('第一次评分失败（JUDGE_PARSE_FAILED）→ 只重跑评分：状态 judged、attempts=2、**候选只跑一次**', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', withJudge: true });
    const candidateId = run.candidates[0]?.id ?? '';
    // 候选 agent 每次尝试都写一个文件：这一格用来钉住「候选**没有**被重跑」
    fakeAgents.scripts.set('codex', { files: [{ path: 'out.txt', content: '候选的产出\n' }] });
    // 第一次 `judgeCandidate` 就失败、第二次成功 = 「评分段那次尝试失败」（真实评分器内部把修复轮用尽后的形状）
    fakeJudge.failFirstNCalls = 1;

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('judged');
    expect(candidate?.score).not.toBeNull();
    expect(candidate?.error).toBeNull();
    // **重试的单位是评分段**：候选产出是已定终态的事实，为一个评分侧的打嗝重新生成它会换掉被打分的对象
    expect(fakeAgents.calls).toHaveLength(1);
    expect(fakeJudge.calls).toHaveLength(2);
    // attempts 累加：试了两次才成功这件事必须留在快照里
    expect(candidate?.attempts).toBe(2);

    // ⚠️ 事件日志在每次 attempt 开始时被 `resetEvents` 清空（既有的「重跑同一行」口径）：
    // 抽屉里只看得到**当前这次**尝试的事件，那条「自动重试第 1/2 次」在重试开始时就随文件一起清掉了。
    // 「重试发生过」由 `attempts`、`fakeAgents.calls` 与 `fakeJudge.calls` 三者钉住（它们都不受 reset 影响）。
    const events = readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId));
    expect(events.some((event) => event.type === 'score')).toBe(true);
    // 收场那条 `end` 记 `rescored`（与手动「重新评分」同一个词）：只重跑评分那一段的收尾就是它，
    // 而这个候选的事件日志里**两条 `end` 都在**（第一次尝试的 `end/error` 与这次的 `end/rescored`）
    // ——同一个词不区分开，读日志的人就分不清「哪条才是最后一次收场」
    expect(events.at(-1)).toMatchObject({ type: 'end', exitReason: 'rescored' });
  });

  it('评分段一直失败 → 预算用满后落 failed（stage=judge），**候选始终只跑一次**', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', withJudge: true });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'out.txt', content: '候选的产出\n' }] });
    // 评分每次都失败：重试预算全部花在评分段上
    fakeJudge.failFirstNCalls = 99;

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('failed');
    expect(candidate?.error?.code).toBe('JUDGE_PARSE_FAILED');
    // 失败阶段落盘：评分段 ⇒ 'judge'（它同时是「下一次重试只重跑评分」的判据）
    expect(candidate?.error?.stage).toBe('judge');
    expect(fakeAgents.calls).toHaveLength(1);
    expect(fakeJudge.calls).toHaveLength(1 + CANDIDATE_RETRY.maxRetries);
    expect(candidate?.attempts).toBe(1 + CANDIDATE_RETRY.maxRetries);

    // 账本里那几条重试的 `scope` 必须是 'judge'：只记「又试了一次」而不记「试的是哪一段」，
    // 事后无法回答「这一行为什么没有重新生成候选」
    const records = readFileSync(candidateAttemptsFile(run.workspaceBase, run.id, candidateId), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { phase: string; scope?: string });
    expect(records.filter((record) => record.phase === 'start').map((record) => record.scope))
      .toEqual(['candidate', 'judge', 'judge']);
  });

  it('瞬时面一直失败 → 重试次数用满后落 failed，attempts = 1 + 上限', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AGENT_FAILED' });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('failed');
    expect(candidate?.error?.code).toBe('AGENT_FAILED');
    // 失败阶段落盘：候选 agent 段 ⇒ 'agent'
    expect(candidate?.error?.stage).toBe('agent');
    expect(fakeAgents.calls).toHaveLength(1 + CANDIDATE_RETRY.maxRetries);
    expect(candidate?.attempts).toBe(1 + CANDIDATE_RETRY.maxRetries);
  });

  /**
   * **尝试账本**。
   *
   * 症状：自动重试每次都 `resetEvents`，于是「重试了几次、每次为什么失败」在日志抽屉里**一条都没有**
   * ——实测目标页那一行 `attempts = 6`，而 `events.jsonl` 里零条重试记录。
   * 账本（`attempts.jsonl`）是**累计**的，绝不参与 reset：每轮重试都有一条 start 与一条 end。
   */
  it('重试的每一次都进尝试账本（events 被 reset 也照样查得到）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AGENT_FAILED' });

    await runCandidate(run.id, candidateId);

    const file = candidateAttemptsFile(run.workspaceBase, run.id, candidateId);
    const records = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { attempt: number; phase: string; outcome?: string; code?: string; retrying?: boolean });

    const attempts = 1 + CANDIDATE_RETRY.maxRetries;
    expect(records.filter((record) => record.phase === 'start')).toHaveLength(attempts);
    expect(records.filter((record) => record.phase === 'end')).toHaveLength(attempts);
    // 前 N-1 次标了 retrying，最后一次没有——「为什么又跑了一遍」在账本里自解释
    expect(records.filter((record) => record.retrying === true)).toHaveLength(attempts - 1);
    expect(records.at(-1)).toMatchObject({ attempt: attempts, phase: 'end', outcome: 'failed', code: 'AGENT_FAILED' });
    // 与事件日志互补：事件日志只剩最后一次尝试，账本六亲不认地留着全部
    expect(readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId)).length).toBeGreaterThan(0);
  });

  /**
   * 结构修复的**留痕**（编排层这一侧的守卫）。
   *
   * 真实链路是「`judgeCandidate` 内部回问模型 → 成功」，最外层看不到失败；而这里要钉的是
   * **编排层把 `onProgress` 写进了该候选日志**这件事本身——它不写，日志抽屉里就少一句
   * 「这一行为什么多发了一次请求」，而使用者只能看到一个莫名其妙的耗时。
   * 用「第一次 attempt 的评分失败一次」来触发（不启用候选级自动重试），于是那一条日志留在盘上。
   */
  it('结构修复回问模型时，该候选日志里留下「回问」那一行（修复是额外请求，必须留痕）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', withJudge: true });
    const candidateId = run.candidates[0]?.id ?? '';
    // 关闭自动重试：让第一次 attempt 的失败日志留在事件日志里（下一次 attempt 会 resetEvents）
    CANDIDATE_RETRY.maxRetries = 0;
    fakeJudge.failOnceThenSucceed = true;

    await runCandidate(run.id, candidateId);

    expect(getRun(run.id).candidates[0]?.status).toBe('failed');
    // 这一条同时钉住「抛出来的 ServiceError 也要带对失败阶段」：修复轮用尽走的是
    // `settleFailed` 那条路，而它的阶段是由**抛异常时的候选状态**推出来的（`judging` ⇒ 'judge'）。
    // 这一格今天只用于叙述与排障（判据不再读它），但错了会让事后复盘把失败段读反。
    expect(getRun(run.id).candidates[0]?.error?.stage).toBe('judge');
    const events = readEvents(candidateEventsFile(run.workspaceBase, run.id, candidateId));
    const text = events.map((event) => (event.type === 'log' ? event.text : '')).join('\n');
    expect(text).toContain('未通过结构检查');
    // 判据换了之后这条原因的文案跟着换：缺项点名的是**引用键与目标**（旧体系报的是「维度缺失」）
    expect(text).toContain('缺少对 D1');
    expect(text).toContain('回问评分模型');
  });

  it('非瞬时面（AUTH_FAILED）一次都不重试：密钥错了再跑两遍还是错的', async () => {    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });

    await runCandidate(run.id, candidateId);

    expect(getRun(run.id).candidates[0]?.status).toBe('failed');
    // 密钥错发生在候选 agent 那一段（上游凭据是候选侧配的）⇒ 阶段 'agent'
    expect(getRun(run.id).candidates[0]?.error?.stage).toBe('agent');
    expect(fakeAgents.calls).toHaveLength(1);
    expect(getRun(run.id).candidates[0]?.attempts).toBe(1);
  });

  it('适配器自报超时（timed-out）不自动重试：分钟级的成本只能由用户决定要不要再赌一次', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { selfTimeout: true });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('timed-out');
    // 「尝试次数」这一格只有 1：超时不触发自动重试
    expect(candidate?.attempts).toBe(1);
  });
});
