// @vitest-environment node
/**
 * runCandidate：八步时序与落盘
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：runCandidate：八步时序与落盘、runCandidate：改工作区根目录后仍在途收尾（快照侧）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { registerOrchestratorHooks, TEST_TIMEOUT_MS, home, seedRunnableRun, existsSync, readFileSync, join, loadConfig, readEvents, candidateEventsFile, saveConfig, saveRun, runCandidate, getRun, fakeAgents, abortCandidate, startedCwds, until, type EvalRun } from './testing/orchestrator-harness';

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

describe('runCandidate：八步时序与落盘', { timeout: TEST_TIMEOUT_MS }, () => {
  it('成功一行：状态 judged、计量与 diff 落库、事件顺序与 seq 正确、工作区真的有产物', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '由假适配器写入\n' }] });

    await runCandidate(run.id, candidateId);

    const saved = getRun(run.id);
    const candidate = saved.candidates[0];
    expect(candidate?.status).toBe('judged');
    expect(candidate?.branch).toBe(`test/${candidateId}`);
    // 基线必须是 40 位具体 hash，不能是 'HEAD' 之类的符号引用
    expect(candidate?.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(candidate?.tokens).toEqual({ input: 10, cached: 0, output: 20 });
    expect(candidate?.turns).toBe(1);
    expect(candidate?.durationMs).toBeGreaterThanOrEqual(0);
    expect(candidate?.diff).toEqual({ filesChanged: 1, insertions: 1, deletions: 0, truncated: false });
    expect(candidate?.score?.totalScore).toBe(30); // 评分表两项全达成（20 + 10）= 满分
    expect(candidate?.error).toBeNull();
    expect(existsSync(join(candidate?.workspacePath ?? '', 'agent-output.txt'))).toBe(true);
    // 轮级状态不归 runCandidate 管（它由轮任务收尾）
    expect(saved.status).toBe('idle');

    const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidateId));
    expect(events.map((event) => (event.type === 'status' ? `status:${event.status}` : event.type))).toEqual([
      'status:preparing',
      'status:running',
      'diff-summary',
      'status:judging',
      'score',
      'status:judged',
      'end',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('agent 在 cwd 里干活：假适配器写进工作区的文件真的出现在工作副本里', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '假适配器的产出\n' }] });

    await runCandidate(run.id, candidateId);

    const workspacePath = getRun(run.id).candidates[0]?.workspacePath ?? '';
    expect(fakeAgents.calls[0]?.cwd).toBe(workspacePath);
    expect(existsSync(join(workspacePath, 'agent-output.txt'))).toBe(true);
  });

  /**
   * route 是「事实 → 方言」的唯一通道：编排层少填窗口这一格的后果是**静默**的
   * —— cc 不加后缀、codex 不写 `model_context_window`、dsh 不写 settings.yaml，三家都照常跑完，
   * 只是模型跑在另一个窗口上。所以这里钉的是「清单里的窗口真的进了 route」。
   */
  /**
   * 强度是**候选上的配置**：编排层漏传它的后果同样是静默的 —— 三家都按模型默认档跑，
   * 而快照里明明写着用户选了 `high`（截图与实跑不一致，是横向对比里最难发现的那种失真）。
   */
  it('候选上的 effort 到达适配器输入（没选则整个键都不出现）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    // 候选快照里补上强度（创建路径由 api 的 createRun 写，这里只关心编排层有没有把它传下去）
    saveRun({ ...getRun(run.id), candidates: getRun(run.id).candidates.map((candidate) => (candidate.id === candidateId ? { ...candidate, effort: 'high' } : candidate)) });

    await runCandidate(run.id, candidateId);

    expect(fakeAgents.calls[0]?.effort).toBe('high');

    // 对照：没选的候选不给这个键（「没说」与「说了 high」必须分得开）
    const bare = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    await runCandidate(bare.run.id, bare.run.candidates[0]?.id ?? '');
    expect(fakeAgents.calls[1]?.effort).toBeUndefined();
  });

  it('组装给适配器的 route 带上供应商清单里那条模型的窗口与输出上限', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    // 模型属性在运行时现读（与 baseUrl 同口径），所以改在 runCandidate 之前即可生效
    const config = loadConfig();
    saveConfig({
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, contextWindow: 1_048_576, maxOutputTokens: 131_072 })),
      })),
    });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.contextWindow).toBe(1_048_576);
    expect(fakeAgents.calls[0]?.maxOutputTokens).toBe(131_072);
  });

  it('采集不到计量时写 null，绝不写 0（0 与「没采到」在横向对比里含义相反）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { tokens: null, turns: null });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('judged');
    expect(candidate?.tokens).toBeNull();
    expect(candidate?.turns).toBeNull();
  });

  /**
   * 子智能体那一份的**终态**落盘。
   *
   * 为什么终态这一格非写不可（不是「跑动期已经回写过就够了」）：codex 的子线程用量与 claude 的
   * 子智能体用量都**只在收尾才知道**（前者要读 rollout 文件、后者要读 CLI 落盘的子会话文件），
   * 而收尾那条 `usage` 事件会在几毫秒后被这里的终态 `patchCandidate` 覆盖（见 `TurnFinalize` 的注释）
   * ⇒ 只在事件里给数的实现，快照上永远看不到这一份。
   */
  it('终态把适配器结果的 subagentTokens 写进 run.json', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', {
      // 这一对必须**逐格 ≤**：`{4,1,2} ≤ {10,1,20}`（不变量），等号那一格也要真的被验到。
      tokens: { input: 10, cached: 1, output: 20 },
      turns: 1,
      subagentTokens: { input: 4, cached: 1, output: 2 },
    });

    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('judged');
    // 分量与合计一起落盘，且逐格满足 `subagentTokens ≤ tokens`（不变量）
    expect(candidate?.subagentTokens).toEqual({ input: 4, cached: 1, output: 2 });
    expect(candidate?.tokens).toEqual({ input: 10, cached: 1, output: 20 });
  });

  it('重跑同一行前清空事件日志：上一次的 error 不混进新一次执行，seq 重新从 1 开始', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    const config = loadConfig();

    // 第一次：供应商被删掉 → 该候选 failed，日志里留下 error
    saveConfig({ ...config, providers: [] });
    await runCandidate(run.id, candidateId);
    const first = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidateId));
    expect(first.some((event) => event.type === 'error')).toBe(true);

    // 第二次：恢复配置重跑
    saveConfig(config);
    await runCandidate(run.id, candidateId);

    const second = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidateId));
    expect(second.some((event) => event.type === 'error')).toBe(false);
    expect(second[0]?.seq).toBe(1);
    expect(getRun(run.id).candidates[0]?.status).toBe('judged');
    expect(getRun(run.id).candidates[0]?.error).toBeNull();
  });
});


/**
 * **快照侧**：用户在评测进行中改了工作区根目录后，在途轮次必须**正常收尾**。
 *
 * 未修的形态：`requireCandidate → getRun` 只扫当前根 ⇒ 第一次就抛 NOT_FOUND；而 `settleFailed` 也要先
 * `requireCandidate` ⇒ 行停在 `pending`、只留一行「落 failed 也失败（该候选可能停在非终态）」——「一次设置变更把在途轮次打死」
 * 换了扇门照样发生。
 *
 * 所以这条守卫必须断言**终态本身**（不是「发过事件」）：把 `requireCandidate` 改回 `getRun`、或去掉
 * `getRunForWrite` 的记忆兜底，都会让 `candidates[0].status` 停在 `pending` ⇒ 红。
 */
describe('runCandidate：改工作区根目录后仍在途收尾（快照侧）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('评测中途把工作区根目录改到 B：该候选照样走完八步落到 judged（快照读写按该轮自己的根解析）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '改根之后仍然跑完\n' }] });
    // 模拟用户跑到一半去设置页把工作区根目录改到 B（只改设置，不搬任何产物）
    const otherRoot = join(home.root, 'runs-b');
    saveConfig({ ...loadConfig(), settings: { ...loadConfig().settings, workspaceRoot: otherRoot } });

    await runCandidate(run.id, candidateId);

    // 快照仍在旧根 A，而且这个候选**到了终态**——停在 pending / running 就是 H1 的症状
    const saved = JSON.parse(readFileSync(join(home.workspaceRoot, run.id, 'run.json'), 'utf8')) as EvalRun;
    expect(saved.candidates[0]?.status).toBe('judged');
    expect(saved.candidates[0]?.error).toBeNull();
    expect(saved.candidates[0]?.score?.totalScore).toBe(30);
    // 八步事件齐全：`setCandidateStatus` 末尾的回读与每一次事件发布都走同一条根解析，缺哪一步都会少事件
    const events = readEvents(candidateEventsFile(home.workspaceRoot, run.id, candidateId));
    expect(events.map((event) => (event.type === 'status' ? `status:${event.status}` : event.type))).toEqual([
      'status:preparing',
      'status:running',
      'diff-summary',
      'status:judging',
      'score',
      'status:judged',
      'end',
    ]);
    // 新根下不许出现这一轮的任何产物（兜底不是「顺手在新根里再建一份」）
    expect(existsSync(join(otherRoot, run.id))).toBe(false);
  });
});


/**
 * `EvalCandidate.emptyAnswer`：候选侧「没答」观测格的**落盘判据**（三态：`true` 没答 / `false` 答了 /
 * 键**缺席**= 未记录）。
 *
 * 为什么这一格载重：真出了空答复的候选，历史上照旧拿得到分（评分通路读的 `finalText` 区分不了
 * 「没答」与「答了空串」），回看时也看不出异常——所以判据不只要写对值，还要与**候选状态**一起钉住
 * 「没答照旧拿分」这个事实本身。
 *
 * 三种「不写这一格」（**缺席**，不是写一个 `null`）：没有结果、运行的失败、结果不带 `ok`。
 * 缺席与 `null` 在契约上同读作「未记录」，但**写侧只留一种形态**才让消费侧「这一格到底是谁写的」
 * 可判——见下面失败臂为什么非断言「键不在」不可。
 *
 * 为什么空白与空串也算没答、且判据必须自己判：适配器那一层确实有「空正文不进 `finalText`」的守卫
 * （由一致性套件拦），但本层的判据**不许依赖另一层的守卫**——夹具能造出空串与纯空白，
 * 判据一旦假定它们不会出现，跨过那一层之后就会把一次空答复写成 `false`（= 断言「它答了」）。
 */
describe('runCandidate：候选侧「没答」观测格 emptyAnswer', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * 动机那一格：候选**正常收尾但一行正文都没交** ⇒ `true`。
   * 后两条断言不是陪衬——它们把「没答照旧拿分」的事实钉进守卫：只钉 `emptyAnswer === true` 的话，
   * 将来有人顺手让空答复的候选不评分（或落成别的状态），这条守卫会全绿而它要守的动机已经消失。
   */
  it('候选正常收尾但没交正文 ⇒ true，且这个候选照旧 judged、照旧有分', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: null });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.emptyAnswer).toBe(true);
    expect(candidate?.status).toBe('judged');
    expect(candidate?.score).not.toBeNull();
  });

  it('候选交了纯空白正文 ⇒ 仍是「没答」（true）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '  \n' });

    await runCandidate(run.id, candidateId);

    expect(getRun(run.id).candidates[0]?.emptyAnswer).toBe(true);
  });

  it('候选交了空串 ⇒ 与「没交正文」同判（true）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '' });

    await runCandidate(run.id, candidateId);

    expect(getRun(run.id).candidates[0]?.emptyAnswer).toBe(true);
  });

  /** 对照臂：缺了它这一组没有区分力——一个恒 `true` 的实现能过上面全部用例 */
  it('候选交了正文 ⇒ false（对照臂）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', finalText: '好。' });

    await runCandidate(run.id, candidateId);

    expect(getRun(run.id).candidates[0]?.emptyAnswer).toBe(false);
  });

  /**
   * **失败时这一格必须缺席**（不是 `true`、也不是 `false`）——本组最重要的一条。
   *
   * 要拦的缺陷：把判据写成两态（例如「`finalText === null` 就是没答」，或无条件写一个布尔值）。
   * 适配器契约明说 `ok:false` 时 `finalText` **不保证是模型答复**（cc 会把厂商的错误文本写进它），
   * 于是「一次失败」会被读成「一次空答复」——而这一格是界面与统计读「候选没答」的唯一依据。
   * 这一档刻意**给了**一段正文（`'上游 502'`，正是厂商错误文本的形状）：只看 `finalText` 的实现在这里
   * 写 `false`（把失败读成「答了」），漏判 `ok` 的无条件实现在这里写 `true`（把失败读成「没答」）
   * ——两种误读方向都被这条断言挡下。
   */
  it('候选失败（适配器交回 ok:false）⇒ 这一格缺席，失败不被读成空答复', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error', finalText: '上游 502' });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('failed');
    expect(candidate !== undefined && 'emptyAnswer' in candidate).toBe(false);
    // 值也一并钉住：写 `null` 同样是「多写了一个值」，失败信息里直接看得到差异
    expect(candidate?.emptyAnswer).toBeUndefined();
  });

  /**
   * 同一档的**另一半**：`ok:false` 且适配器**连答复都没交**（`finalText` 是 `null`）。
   *
   * 这一条拦的是「图省事把判据写成 `finalText === null` 就算没答」那种两态实现——它会把这次
   * **失败**写成 `true`（空答复）。与上一条（失败带错误文案 ⇒ 会被写成 `false`）合起来，
   * 「失败」被误读的两个方向各有一条断言钉住。
   */
  it('候选失败且没带答复（ok:false、finalText 为 null）⇒ 仍是缺席，失败不被读成「没答」', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'error' });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('failed');
    expect(candidate !== undefined && 'emptyAnswer' in candidate).toBe(false);
    expect(candidate?.emptyAnswer).toBeUndefined();
  });

  /**
   * 适配器**违约**（`run()` 直接抛）这一档：连结果都没有 ⇒ 同样缺席。
   * 它与上面两条分属条件展开的不同分支（`result === undefined` 与 `!result.ok`）——漏掉任何一个，
   * 同一个缺陷都会从另一扇门进来。
   */
  it('适配器违约（run() 直接抛）⇒ 同样缺席', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'throw' });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('failed');
    expect(candidate !== undefined && 'emptyAnswer' in candidate).toBe(false);
  });

  /**
   * 终止类终态两档（用户终止 / 适配器自报超时）：候选根本没跑完，这一格同样**不写**——
   * 写成 `true` 等于把「没跑完」混进「跑了但没答」，而这个读数的全部价值就在于两者分得开。
   */
  it('用户终止 ⇒ 缺席（终止不是「没答」）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    const task = runCandidate(run.id, candidateId);
    await until(() => startedCwds().length === 1, '该候选进入假适配器', 30_000);

    abortCandidate(run.id, candidateId);
    await task;

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('canceled');
    expect(candidate !== undefined && 'emptyAnswer' in candidate).toBe(false);
  });

  it('适配器自报超时 ⇒ 缺席（超时不是「没答」）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { selfTimeout: true });

    await runCandidate(run.id, candidateId);

    const candidate = getRun(run.id).candidates[0];
    expect(candidate?.status).toBe('timed-out');
    expect(candidate !== undefined && 'emptyAnswer' in candidate).toBe(false);
  });
});
