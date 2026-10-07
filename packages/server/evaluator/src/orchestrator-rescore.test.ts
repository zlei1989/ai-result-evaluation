// @vitest-environment node
/**
 * rescoreRow：只重跑评分，不重跑候选
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：rescoreRow：只重跑评分，不重跑候选。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import {
  vi,
  describe,
  expect,
  it } from 'vitest';
import { registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  until,
  home,
  seedRunnableRun,
  judgeReplyJson,
  canRescoreRow,
  readEvents,
  rowEventsFile,
  drainRunningTasks,
  rescoreRow,
  ROW_RETRY,
  runRow,
  getRun,
  saveRun,
  fakeAgents,
  fakeJudge,
  releaseAllAgents,
  releaseJudge,
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


/* ===================================================================================================
 * 行级「重新评分」（Task 7）
 *
 * 本功能要解决的是**产品今天没有的出口**：一行评分失败 / 超时 / 被重启打断之后，除了新建一整轮
 * （候选 agent 又要跑几分钟）没有别的路。故这一组用例的重心有三处，缺一条这个功能就不成立：
 *   ① **候选 agent 一次都不许再跑**（成本就是它的全部理由）；
 *   ② **事件日志是追加的**（旧的 `score` 事件留在原地当历史，`resetEvents` 一次都不许调）；
 *   ③ 不可重评的行要**点名**为什么，而不是笼统地说「不能重评」。
 * 另外两条是本层自己的口径：模式沿用 `run.useAgentJudge`（一轮里只有一把尺子），以及
 * 「重试出口自己也不静默」——重评失败同样落 `failed` + 可读归因。
 * =================================================================================================== */

describe('rescoreRow：只重跑评分，不重跑候选', { timeout: TEST_TIMEOUT_MS }, () => {
  it('把「未跑过」的行挡下来（没跑过 ⇒ 工作区未就绪），并说清该先做什么', () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' }); // 行是 pending、diff 为 null、baselineCommit 为 ''
    expect(() => rescoreRow(run.id, run.rows[0]?.id ?? '')).toThrowError(/工作区未就绪/);
  });

  it('把「正在运行中」的行挡下来，并指向终止', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'running', '行进入 running');
    expect(() => rescoreRow(run.id, rowId)).toThrowError(/正在运行中/);
    releaseAllAgents();
    await running;
  });

  /**
   * **2026-09-28 晚间口径**（「已出分、无报错时取消禁用」）：已经出分的行也给「重新评分」。
   * 与它相对的是同日上午那版口径（「只有评分失败报错，才可重新评分」）——那次收紧在这里被反转，
   * 故本条用例的**起点就是一条成功的行**（最容易被误判成「不该给」的那一格）。
   */
  it('已经出分且没有报错的行照样可重评：分数被新的评分结果替换，候选 agent 没有再跑', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '候选的产出\n' }] });
    await runRow(run.id, rowId); // 一次成功：judged + 有分 + error 为 null
    // 夹具的默认读数：评分表两项全达成 ⇒ 满分 30
    expect(getRun(run.id).rows[0]?.score?.totalScore).toBe(30);
    expect(getRun(run.id).rows[0]?.error).toBeNull();
    const agentCallsAfterRun = fakeAgents.calls.length;

    // 换一个读数（一项都没达成 ⇒ 0），确认落盘的是**这一次**的结果而不是旧分
    fakeJudge.achieved = false;
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.score?.totalScore === 0, '重新评分落盘（一项都没达成 ⇒ 0）');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.score?.totalScore).toBe(0);
    // 只重跑评分：候选 agent 一次都没再跑（这是本功能的全部意义）
    expect(fakeAgents.calls).toHaveLength(agentCallsAfterRun);
    // 事件日志**追加**：旧的 score 事件留在原地，新的 score 与 [重新评分] 标记接在后面
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.filter((event) => event.type === 'score')).toHaveLength(2);
    expect(events.some((event) => event.type === 'log' && event.text.includes('[重新评分]'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'end', exitReason: 'rescored' });
  });

  it('候选 agent 阶段失败的行也能重评（判据不再看失败阶段）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // 非瞬时码：不触发自动重试，一次就落终态
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runRow(run.id, rowId);
    // 失败阶段照旧落盘（叙述用）：候选 agent 阶段 ⇒ 'agent'
    expect(getRun(run.id).rows[0]?.error?.stage).toBe('agent');
    // 但判据不看它：这一行有基线、有 diff，故重评放行（重评只读既有产出）
    // 读数取夹具缺省（评分表两项全达成 ⇒ 30），断言写全是为了让「这一行真的出了分」有确切的值
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'judged', '候选阶段失败的行重评后出分');
    expect(getRun(run.id).rows[0]?.score?.totalScore).toBe(30);
  });

  /**
   * 老快照（2026-09-28 之前落的盘，没有 `error.stage` 这一格）**照常可重评**：
   * 「读不到失败阶段」曾经是拒绝理由（不确认就不放行），判据不再看那一格之后这条限制一并消失。
   * 这一条同时是「读 `error.stage` 的判据没有偷偷回来」的守卫。
   */
  it('老快照（error 没有 stage）照常可重评', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error', errorCode: 'AUTH_FAILED' });
    await runRow(run.id, rowId);
    // 手工抹掉 `stage`，模拟「这一格是后加的、盘上的老记录没有它」
    const before = getRun(run.id);
    saveRun({
      ...before,
      rows: before.rows.map((row) => ({ ...row, error: { code: row.error?.code ?? 'AGENT_FAILED', message: row.error?.message ?? '' } })),
    });
    expect(getRun(run.id).rows[0]?.error?.stage).toBeUndefined();

    fakeJudge.achieved = false; // 一项都没达成 ⇒ 0（与上面那条 30 分的读数分得开）
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'judged', '老快照重评后出分');
    expect(getRun(run.id).rows[0]?.score?.totalScore).toBe(0);
  });

  it('正例：评分失败的行重评出分、候选 agent 没有再跑一次、日志追加而不是清空', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    // 候选**真的写一个文件**：重评那一侧要断言「送进评分模型的改动正文非空且含这个文件」——
    // 空 diff 会被评分请求（`buildJudgePrompt`）拼成「（无改动）」，而模型照样能给出一个看起来正常的分数，
    // 正是本功能要消灭的那种静默失败（终审 FIX-2）。不写文件时这条断言没有区分力。
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '候选的产出\n' }] });
    // 起点是「评分失败」的行：判据早已不看这一档（放宽了），这里只为造一条**有产出**的行
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    const agentCallsAfterRun = fakeAgents.calls.length;
    const eventsAfterRun = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).length;
    expect(getRun(run.id).rows[0]?.error?.stage).toBe('judge');

    fakeJudge.mode = 'ok';
    // 读数取「全达成」⇒ 满分 30（起点是评分失败的行，此前没有分可比——这条断言要的是「真的出分了」）
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.score?.totalScore === 30, '重新评分落盘');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.score?.totalScore).toBe(30);
    // 重新出分之后失败归因必须清干净（界面不许同时显示「已评分」与一条红错误）
    expect(row?.error).toBeNull();
    // 候选 agent 一次都没再跑（这是本功能的全部意义：分钟级的成本不该被一次重评带上）
    expect(fakeAgents.calls).toHaveLength(agentCallsAfterRun);
    // **重评送进评分模型的改动正文是现算的**（`runJudgeRowStage` 的 `ctx.diffText ?? clippedDiffText(...)`，
    // 重评那一侧 `diffText` 恒为 null）：它退化成空串时，模型收到的是「（无改动）」而分数照样出得来。
    // 这条断言是那一次现算唯一的观测点——少了它，「重评把 diff 算没了」整套用例全绿。
    const rescoreDiff = fakeJudge.calls.at(-1)?.diffText ?? '';
    expect(rescoreDiff).not.toBe('');
    expect(rescoreDiff).toContain('agent-output.txt');
    // 事件日志**追加**：第一次那笔失败的证据还在，重评又补了一条 score 与一条 [重新评分] 标记
    const events = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId));
    expect(events.length).toBeGreaterThan(eventsAfterRun);
    expect(events.filter((event) => event.type === 'score')).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'log' && event.text.includes('[重新评分]'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'end', exitReason: 'rescored' });
  });

  /**
   * **F1 入口区回退的守卫**（终审 FIX-5 追加：原报告把 R31 的守卫数记成 3/4，
   * 而「入口区失败必须整体回退」这条**是可构造且便宜的**，不该只靠推理）。
   *
   * 不变量：`rescoreRow` 入口区那三步（登记控制器 → 标记事件 → 写状态）任何一步抛之后，
   * 这一行不能**带着一个活着的 `rowAborts` 条目**停在终态——那个条目是「不可重评」的判据
   * （`rescoreRefusal` 的 `settling`），而唯一的清理者 `clearRowRuntime` 挂在**没起来的**重评任务的
   * finally 上 ⇒ 一次落盘失败会被放大成「这一行永久不可重评」，且没有任何东西能修回来。
   *
   * 注入点用 `./run-store` 的 saveRun 接缝：入口区里两次同步读之间没有 `await`，
   * 测试无法「恰好在那一刻」动手脚（与轮级收尾那条守卫同一理由，见那个 mock 的注释）。
   */
  it('重评入口落盘失败 → 整段回退：该行之后仍能重评（不留一把打不开的锁）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    // 先跑成「评分失败」（判据放开之前这是唯一可重评的一档；今天只为造一个**有产出**的行）
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('failed');
    const before = readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).length;

    injected.failRowSaveFor = run.id; // 入口区那次 setRowStatus 的落盘失败一次
    expect(() => rescoreRow(run.id, rowId)).toThrowError(/夹具注入：行级落盘失败/);
    expect(injected.rowSaveFailed).toBe(true);
    // 「失败就该是什么都没发生」：终态没被改动，也没有半截状态留在盘上
    expect(getRun(run.id).rows[0]?.status).toBe('failed');
    // 标记事件写在落盘之前，它已经在日志里了（那一笔不回退是刻意的：日志是追加的真相源，
    // 而「用户请求过重评」这件事确实发生过）——下面那条重评成功即为「锁已打开」的证据
    expect(readEvents(rowEventsFile(run.workspaceBase, run.id, rowId)).length).toBeGreaterThan(before);

    // 关键一步：同一个请求**再来一次**必须真的跑起来。回退没做时它会抛
    // 「该行上一次的运行还没收尾，请稍候再试」，而且此后永远如此。
    fakeJudge.mode = 'ok';
    // 与夹具缺省（全达成 ⇒ 30）分得开：读数变了才是「重评真的跑了」的证据
    fakeJudge.achieved = false;
    const returned = rescoreRow(run.id, rowId);
    expect(returned.rows[0]?.status).toBe('judging');
    await until(() => getRun(run.id).rows[0]?.score?.totalScore === 0, '回退之后重评照常出分');
    await drainRunningTasks();
    expect(fakeJudge.calls).toHaveLength(2); // 第一次 entry 失败时一次评分调用都没发生
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
  });

  it('用例被删之后不能重评（题面没有快照进 run.json）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    // 先落到「可重评」的那一档（评分失败），否则拦下它的是判据本身、测不到「用例已删除」这一条
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    seedConfig({ workspaceRoot: home.workspaceRoot }); // 用例没了
    expect(() => rescoreRow(run.id, rowId)).toThrowError(/用例已删除/);
  });

  /**
   * **F1 的回归守卫：上一次的运行还没收尾时不许重评。**
   *
   * 窗口的形状（判据**放宽之后**比以前更容易进来）：评分失败 ⇒ 行已经是 `failed`
   * （评分阶段）这个**终态**，而 `runRow` 的自动重试正在退避等待里、`finally` 还没跑
   * ⇒ `rowAborts` 里那把控制器还活着。此刻行字段完全满足重评判据的三个硬前提
   * （判据只看行字段，看不见 `rowAborts`），放它进去就是这条竞态：
   * 重评把状态推回 `judging` ⇒ 迟到的旧任务调 `settleStopped` / `settleFailed`，它们的
   * 「终态优先」守卫只看**当前**状态（刚被重评改成非终态）⇒ **再落一次终态**把重评踩掉；
   * 重评自己的终态复检随后只把分数记进日志，用户还会看到终止按钮失灵。
   *
   * 判据因此落在 `rowAborts` 上——它的条目存在的时间正好是「上一次运行还在收尾」。
   * `startRun` 有 `runTasks.has(runId)` 天然挡着，重评不在 `runTasks` 里，必须自己挡。
   */
  it('上一次的运行还没收尾（评分失败后还在自动重试的退避里）→ 拒绝重评，而不是并发着去抢状态', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    // 打开自动重试并把退避放长：窗口要够宽，用例才有稳定的观测点（默认 3 秒也够，这里压到 400ms）
    ROW_RETRY.maxRetries = 1;
    ROW_RETRY.delayMs = 400;
    fakeJudge.mode = 'fail';
    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'failed', '评分失败落 failed');

    // 行字段已经「可重评」——判据若不看 rowAborts，下面这一句就会放行。
    // `stage` 那一格只是叙述（判据不读它），真正承重的是紧随其后的 `canRescoreRow` 断言
    const midFlight = getRun(run.id).rows[0];
    expect(midFlight?.error?.stage).toBe('judge');
    expect(canRescoreRow(midFlight!)).toBe(true);

    expect(() => rescoreRow(run.id, rowId)).toThrowError(/上一次的运行还没收尾/);

    // 收尾之后同一个请求就能过了：拒绝是「请稍候」，不是「永久不可重评」
    await running;
    fakeJudge.mode = 'ok';
    await until(() => rescoreRow(run.id, rowId).rows[0]?.status === 'judging', '收尾后可以重评');
    await drainRunningTasks();
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
  });

  /**
   * **F2：智能体评分那一路上，重评必须还是同一把尺子**（spec D11）。
   *
   * 为什么必须单独钉：`useAgentJudge` 在夹具里的缺省是 `false`，上面六条用例全都走的**文本**通路。
   * 于是「`rescoreAttempt` 有没有把它自己读到的那份 run 快照交给 `runJudgeStage`」这条接缝
   * **一条用例都没碰**——一旦它退化成「不传 / 传一个陈旧的轮级开关」，一轮智能体评分的评测会被
   * 重新用**文本模型**评分，而 `score.judgeAgentKind` 会从 `claude-code` 悄悄变成 `null`：
   * 界面上只是「分数变了」，看不出换了尺子——正是本功能存在的理由所反对的那种失败。
   */
  it('开关打开时重评仍走评分智能体：judgeAgentKind 落库、评分智能体真的又跑了一次、评分模型一次都没走', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
    });
    const rowId = run.rows[0]?.id ?? '';
    // 起点是「评分阶段失败」的行（这时失败阶段落成 'judge'）：判据不看这一段，这里只是顺手
    // 让这一条走「评分智能体」那条路——本用例要钉的是**通路**与 `judgeAgentKind` 落库
    fakeAgents.scripts.set('claude-code', { mode: 'error', errorCode: 'AGENT_FAILED' });
    await runRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('failed');
    expect(getRun(run.id).rows[0]?.error?.stage).toBe('judge');
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code']);

    // 换一把尺子的读数：第二次评分智能体全达成（满分 30）
    fakeAgents.scripts.set('claude-code', { finalText: judgeReplyJson() });
    rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.score?.totalScore === 30, '重评走智能体通路并落盘');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.score?.judgeAgentKind).toBe('claude-code');
    // 候选（codex）没有再跑：只有评分智能体多跑了一次
    expect(fakeAgents.calls.map((call) => call.kind)).toEqual(['codex', 'claude-code', 'claude-code']);
    // 阴性面：纯文本通路一次都没走（走错通路时它会在这里出现，而 judgeAgentKind 会是 null）
    expect(fakeJudge.calls).toHaveLength(0);
  });

  it('重评失败会落 failed 并给出原因（重试出口必须自己也不静默）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    // 起点是评分失败的行；重评又失败一次 ⇒ 仍然 failed，且失败阶段仍然是「评分那一段」
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    void rescoreRow(run.id, rowId);
    // 判据用「评分调用真的发生了第二次」：行在重评前后都是 `failed`，只看状态分不出「重评跑没跑」
    await until(() => fakeJudge.calls.length === 2, '重评真的又调了一次评分');
    await drainRunningTasks();
    expect(getRun(run.id).rows[0]?.status).toBe('failed');
    expect(getRun(run.id).rows[0]?.error?.code).toBe('JUDGE_PARSE_FAILED');
    expect(getRun(run.id).rows[0]?.error?.stage).toBe('judge');
  });

  it('补完最后一个失败行后 partial 翻回 done', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    // 直接落一份 partial 的快照（本文件既有写法就是这个）：这一轮「跑完了但没出分」
    saveRun({ ...getRun(run.id), status: 'partial', finishedAt: new Date().toISOString() });

    fakeJudge.mode = 'ok';
    void rescoreRow(run.id, rowId);
    await until(() => getRun(run.id).status === 'done', '轮状态翻回 done');
  });

  /**
   * 重评入口**同步清空旧失败归因与旧分**（spec §14 第 6 条）：界面停在「评分中」却还挂着上一次的
   * 失败原因（或过期分数），使用者会以为这一次评分没开始 / 已经出分了。
   *
   * 2026-09-28 之后起点只能是**评分失败**的行，于是真正有区分力的那一条是 `error` 必须变 null
   * （它此前非空）；`score` 那一条退化成防御性断言（这一档的行本来就不该带分）——两条都留在
   * 这里，是因为入口区那一笔 `{ error: null, score: null }` 的语义就是「两样都不留」。
   */
  it('重评入口同步清空旧失败归因与旧分：快照立刻变「评分中 + 无错无分」', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'fail';
    await runRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.error?.code).toBe('JUDGE_PARSE_FAILED');

    // 评分 gate 住：整个重评停在「评分中」，于是这一次同步返回的快照就是「评分中」那一帧
    fakeJudge.mode = 'gate';
    const returned = rescoreRow(run.id, rowId);

    expect(returned.rows[0]?.status).toBe('judging');
    expect(returned.rows[0]?.error).toBeNull();
    expect(returned.rows[0]?.score).toBeNull();

    releaseJudge();
    await until(() => getRun(run.id).rows[0]?.status === 'judged', '重评收尾');
  });
});
