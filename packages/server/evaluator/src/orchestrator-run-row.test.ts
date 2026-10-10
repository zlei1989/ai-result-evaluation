// @vitest-environment node
/**
 * runRow：八步时序与落盘
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：runRow：八步时序与落盘、runRow：改工作区根目录后仍在途收尾（快照侧）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { registerOrchestratorHooks, TEST_TIMEOUT_MS, home, seedRunnableRun, existsSync, readFileSync, join, loadConfig, readEvents, rowEventsFile, saveConfig, saveRun, runRow, getRun, fakeAgents, type EvalRun } from './testing/orchestrator-harness';

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

describe('runRow：八步时序与落盘', { timeout: TEST_TIMEOUT_MS }, () => {
  it('成功一行：状态 judged、计量与 diff 落库、事件顺序与 seq 正确、工作区真的有产物', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '由假适配器写入\n' }] });

    await runRow(run.id, rowId);

    const saved = getRun(run.id);
    const row = saved.rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.branch).toBe(`test/${rowId}`);
    // 基线必须是 40 位具体 hash，不能是 'HEAD' 之类的符号引用
    expect(row?.baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.tokens).toEqual({ input: 10, cached: 0, output: 20 });
    expect(row?.turns).toBe(1);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(row?.diff).toEqual({ filesChanged: 1, insertions: 1, deletions: 0, truncated: false });
    expect(row?.score?.totalScore).toBe(30); // 评分表两项全达成（20 + 10）= 满分
    expect(row?.error).toBeNull();
    expect(existsSync(join(row?.workspacePath ?? '', 'agent-output.txt'))).toBe(true);
    // 轮级状态不归 runRow 管（它由轮任务收尾）
    expect(saved.status).toBe('idle');

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
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
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '假适配器的产出\n' }] });

    await runRow(run.id, rowId);

    const workspacePath = getRun(run.id).rows[0]?.workspacePath ?? '';
    expect(fakeAgents.calls[0]?.cwd).toBe(workspacePath);
    expect(existsSync(join(workspacePath, 'agent-output.txt'))).toBe(true);
  });

  /**
   * route 是「事实 → 方言」的唯一通道：编排层少填窗口这一格的后果是**静默**的
   * —— cc 不加后缀、codex 不写 `model_context_window`、dsh 不写 settings.yaml，三家都照常跑完，
   * 只是模型跑在另一个窗口上。所以这里钉的是「清单里的窗口真的进了 route」。
   */
  /**
   * 强度是**行上的配置**：编排层漏传它的后果同样是静默的 —— 三家都按模型默认档跑，
   * 而快照里明明写着用户选了 `high`（截图与实跑不一致，是横向对比里最难发现的那种失真）。
   */
  it('行上的 effort 到达适配器输入（没选则整个键都不出现）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // 行快照里补上强度（创建路径由 api 的 createRun 写，这里只关心编排层有没有把它传下去）
    saveRun({ ...getRun(run.id), rows: getRun(run.id).rows.map((row) => (row.id === rowId ? { ...row, effort: 'high' } : row)) });

    await runRow(run.id, rowId);

    expect(fakeAgents.calls[0]?.effort).toBe('high');

    // 对照：没选的行不给这个键（「没说」与「说了 high」必须分得开）
    const bare = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    await runRow(bare.run.id, bare.run.rows[0]?.id ?? '');
    expect(fakeAgents.calls[1]?.effort).toBeUndefined();
  });

  it('组装给适配器的 route 带上供应商清单里那条模型的窗口与输出上限', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    // 模型属性在运行时现读（与 baseUrl 同口径），所以改在 runRow 之前即可生效
    const config = loadConfig();
    saveConfig({
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        models: provider.models.map((model) => ({ ...model, contextWindow: 1_048_576, maxOutputTokens: 131_072 })),
      })),
    });

    await runRow(run.id, run.rows[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.contextWindow).toBe(1_048_576);
    expect(fakeAgents.calls[0]?.maxOutputTokens).toBe(131_072);
  });

  it('采集不到计量时写 null，绝不写 0（0 与「没采到」在横向对比里含义相反）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { tokens: null, turns: null });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.tokens).toBeNull();
    expect(row?.turns).toBeNull();
  });

  /**
   * 子智能体那一份的**终态**落盘。
   *
   * 为什么终态这一格非写不可（不是「跑动期已经回写过就够了」）：codex 的子线程用量与 claude 的
   * 子智能体用量都**只在收尾才知道**（前者要读 rollout 文件、后者要读 CLI 落盘的子会话文件），
   * 而收尾那条 `usage` 事件会在几毫秒后被这里的终态 `patchRow` 覆盖（见 `TurnFinalize` 的注释）
   * ⇒ 只在事件里给数的实现，快照上永远看不到这一份。
   */
  it('终态把适配器结果的 subagentTokens 写进 run.json', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', {
      // 这一对必须**逐格 ≤**：`{4,1,2} ≤ {10,1,20}`（不变量），等号那一格也要真的被验到。
      tokens: { input: 10, cached: 1, output: 20 },
      turns: 1,
      subagentTokens: { input: 4, cached: 1, output: 2 },
    });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    // 分量与合计一起落盘，且逐格满足 `subagentTokens ≤ tokens`（不变量）
    expect(row?.subagentTokens).toEqual({ input: 4, cached: 1, output: 2 });
    expect(row?.tokens).toEqual({ input: 10, cached: 1, output: 20 });
  });

  it('重跑同一行前清空事件日志：上一次的 error 不混进新一次执行，seq 重新从 1 开始', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    const config = loadConfig();

    // 第一次：供应商被删掉 → 该行 failed，日志里留下 error
    saveConfig({ ...config, providers: [] });
    await runRow(run.id, rowId);
    const first = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(first.some((event) => event.type === 'error')).toBe(true);

    // 第二次：恢复配置重跑
    saveConfig(config);
    await runRow(run.id, rowId);

    const second = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(second.some((event) => event.type === 'error')).toBe(false);
    expect(second[0]?.seq).toBe(1);
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    expect(getRun(run.id).rows[0]?.error).toBeNull();
  });
});


/**
 * **快照侧**：用户在评测进行中改了工作区根目录后，在途轮次必须**正常收尾**。
 *
 * 未修的形态：`requireRow → getRun` 只扫当前根 ⇒ 第一次就抛 NOT_FOUND；而 `settleFailed` 也要先
 * `requireRow` ⇒ 行停在 `pending`、只留一行「落 failed 也失败（该行可能停在非终态）」——「一次设置变更把在途轮次打死」
 * 换了扇门照样发生。
 *
 * 所以这条守卫必须断言**终态本身**（不是「发过事件」）：把 `requireRow` 改回 `getRun`、或去掉
 * `getRunForWrite` 的记忆兜底，都会让 `rows[0].status` 停在 `pending` ⇒ 红。
 */
describe('runRow：改工作区根目录后仍在途收尾（快照侧）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('评测中途把工作区根目录改到 B：该行照样走完八步落到 judged（快照读写按该轮自己的根解析）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { files: [{ path: 'agent-output.txt', content: '改根之后仍然跑完\n' }] });
    // 模拟用户跑到一半去设置页把工作区根目录改到 B（只改设置，不搬任何产物）
    const otherRoot = join(home.root, 'runs-b');
    saveConfig({ ...loadConfig(), settings: { ...loadConfig().settings, workspaceRoot: otherRoot } });

    await runRow(run.id, rowId);

    // 快照仍在旧根 A，而且这一行**到了终态**——停在 pending / running 就是 H1 的症状
    const saved = JSON.parse(readFileSync(join(home.workspaceRoot, run.id, 'run.json'), 'utf8')) as EvalRun;
    expect(saved.rows[0]?.status).toBe('judged');
    expect(saved.rows[0]?.error).toBeNull();
    expect(saved.rows[0]?.score?.totalScore).toBe(30);
    // 八步事件齐全：`setRowStatus` 末尾的回读与每一次事件发布都走同一条根解析，缺哪一步都会少事件
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
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
