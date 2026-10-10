// @vitest-environment node
/**
 * 超时与失败隔离
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：超时与失败隔离、超时与失败隔离（续）：终止必须真的能收尾。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { clearCases, registerOrchestratorHooks, TEST_TIMEOUT_MS, until, seedRunnableRun, startedCwds, loadConfig, saveConfig, abortRow, abortRun, drainRunningTasks, runRow, startRun, getRun, saveRun, fakeAgents, makeProviderFixture, releaseAllAgents } from './testing/orchestrator-harness';

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

describe('超时与失败隔离', { timeout: TEST_TIMEOUT_MS }, () => {
  it('适配器自报超时 → 该行 timed-out，另一行照常出分（失败隔离）', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 2, executionMode: 'parallel' });
    // `dsh` 现在**两条协议都收**（`['openai','anthropic']`），
    // 所以这里配 openai 也合法。**刻意**仍配一条 anthropic 供应商：让 dsh 行同时覆盖「路由协议是
    // anthropic ⇒ 适配器走 anthropic-messages」那条分支。dsh 的元数据本身两条 wire 都收，配这条
    // anthropic 供应商不是必需——但少了它，本用例只覆盖 openai 那一条 wire，「适配器自报超时」
    // 这条路径就只剩半边判据。
    const anthropic = makeProviderFixture({ protocolType: 'anthropic', baseUrl: 'https://fake.invalid/anthropic' });
    saveConfig({ ...loadConfig(), providers: [provider, anthropic] });
    const rows = run.rows;
    // 第一行用 dsh（脚本让它自报超时），第二行 codex 正常完成
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error('夹具应该有两行');
    const patched = {
      ...run,
      rows: [
        {
          ...first,
          agentKind: 'dsh' as const,
          providerId: anthropic.id,
          providerName: anthropic.name,
          baseUrl: anthropic.baseUrl,
        },
        second,
      ],
    };
    saveRun(patched);
    fakeAgents.scripts.set('dsh', { selfTimeout: true });
    fakeAgents.scripts.set('codex', { files: [{ path: 'ok.txt', content: 'ok\n' }] });

    startRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows[0]?.status).toBe('timed-out');
    expect(saved.rows[0]?.error?.code).toBe('AGENT_TIMED_OUT');
    expect(saved.rows[1]?.status).toBe('judged');
    expect(saved.status).toBe('partial');
  });

  it('失败隔离：串行下中间一行失败，前后两行照常跑完', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 3, executionMode: 'serial' });
    // 中间那行换成 dsh，并沿用上面那条 anthropic 供应商（理由同第一条用例：dsh 两条协议都收，
    // 这里刻意覆盖 anthropic 那条 wire）。配 openai 供应商同样合法。
    const anthropic = makeProviderFixture({ protocolType: 'anthropic', baseUrl: 'https://fake.invalid/anthropic' });
    saveConfig({ ...loadConfig(), providers: [provider, anthropic] });
    const rows = run.rows;
    const first = rows[0];
    const second = rows[1];
    const third = rows[2];
    if (first === undefined || second === undefined || third === undefined) throw new Error('夹具应该有三行');
    saveRun({
      ...run,
      rows: [
        first,
        {
          ...second,
          agentKind: 'dsh' as const,
          providerId: anthropic.id,
          providerName: anthropic.name,
          baseUrl: anthropic.baseUrl,
        },
        third,
      ],
    });
    fakeAgents.scripts.set('dsh', { mode: 'error' });

    startRun(run.id);
    await drainRunningTasks();

    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual(['judged', 'failed', 'judged']);
    expect(saved.rows[1]?.error?.code).toBe('AGENT_FAILED');
    expect(saved.status).toBe('partial');
  });

  it('startRun 的三条拒绝路径：已有行在跑 / 没有可执行行 / 用例已删除', async () => {
    // ① 已有行在跑
    const running = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'gate' });
    startRun(running.run.id);
    await until(() => startedCwds().length === 1, '第一行进入假适配器', 30_000);
    expect(() => startRun(running.run.id)).toThrow(/已有候选行在运行/);
    releaseAllAgents();
    await drainRunningTasks();

    // ② 没有可执行的行（全部已 judged）
    expect(() => startRun(running.run.id)).toThrow(/没有可执行/);

    // ③ 用例已删除（用例是一文件一落：删文件才是「已删除」）
    const orphan = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    clearCases();
    expect(() => startRun(orphan.run.id)).toThrow(/用例已删除/);
  });

  /**
   * **协作适配器被终止时，交卷窗口要真的用上**：用户终止后，适配器报回来的 `tokens`/`turns`
   * 照样要落盘（对照：直接放弃等待会让界面从「轮次 17」退回「未采集」）。
   * `mode: 'gate'` 就是那个形状——挂住直到 abort，然后如实返回（夹具的 `finish` 带 tokens/turns）。
   */
  it('协作适配器被终止：行 canceled，且适配器交回的计量与轮次照常落盘（不是两个 null）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'gate', tokens: { input: 501, cached: 3, output: 7 }, turns: 17 });

    const running = runRow(run.id, rowId);
    await until(() => getRun(run.id).rows[0]?.status === 'running', '行进入 running', 30_000);
    abortRow(run.id, rowId);
    await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 15_000))]);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('canceled');
    expect(row?.turns).toBe(17);
    expect(row?.tokens).toEqual({ input: 501, cached: 3, output: 7 });
  }, TEST_TIMEOUT_MS);
});

describe('超时与失败隔离（续）：终止必须真的能收尾', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **非合作适配器**（`mode: 'hang'`：无视 `signal`、永不落定）—— 删掉硬停之后，这条路径只剩
   * 「用户终止」一个出口，而**终止必须真的能收尾**。
   *
   * 为什么必须有这一条：`turn.ts` 明写 `runTurn` 可能无界返回（`dispose` 只能尽力让迭代结束）。
   * 只把行状态写成 `canceled` 而让行任务继续挂在 `await run()` 上，后果实测过（冒烟时的一轮）：
   * **轮级**状态永远停在 `running`、列表显示「执行中」、「开始」被在途任务挡着拒绝——
   * 用户以为停了，其实没停。判据是 `terminalWaiters` + 终止交卷窗口：行一落终态就唤醒行任务，
   * 最多再给适配器 5 秒交卷。
   *
   * 断言四件事：
   *   ① **不自超时**：等足 3 秒状态仍是 `running`（有人把兜底定时器加回来，这一条立刻红）；
   *   ② **终止同步落库**：`abortRun` 当场写成 `canceled`，且 `error` 为 null；
   *   ③ **行任务真的收尾**：`drainRunningTasks()` 能返回（挂住的 `run()` 不再挡着它）；
   *   ④ **轮级也收尾**：轮状态从 `running` 落成 `partial`（这正是会卡住的那一格）。
   */
  it('适配器彻底不响应（hang）时不自超时；用户终止后行与**轮**都必须真的收尾', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'hang' });

    startRun(run.id);
    await until(() => getRun(run.id).rows[0]?.status === 'running', '行进入 running', 30_000);

    // ① 等足 3 秒：没有任何兜底超时把它带走
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const hanging = getRun(run.id).rows[0];
    expect(hanging?.status).toBe('running');
    expect(hanging?.error).toBeNull();

    // ② 用户终止：同步落库
    abortRun(run.id);
    expect(getRun(run.id).rows[0]?.status).toBe('canceled');
    expect(getRun(run.id).rows[0]?.error).toBeNull();

    // ③ 行任务收尾：挂住的那次 `run()` 不再挡着它（没有 `terminalWaiters` 时这里会永远等下去）
    await drainRunningTasks();
    expect(getRun(run.id).rows[0]?.status).toBe('canceled');
    // ④ 轮级收尾
    await until(() => getRun(run.id).status !== 'running', '轮状态离开 running', 10_000);
    expect(getRun(run.id).status).toBe('partial');
  }, TEST_TIMEOUT_MS);
});
