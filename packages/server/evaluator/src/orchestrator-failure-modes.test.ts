// @vitest-environment node
/**
 * runRow：失败面与配置漂移（每一行都必须落到终态 + 可读原因）
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：runRow：失败面与配置漂移（每一行都必须落到终态 + 可读原因）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { vi, describe, expect, it } from 'vitest';
import { clearCases, registerOrchestratorHooks, TEST_TIMEOUT_MS, until, home, seedRunnableRun, mkdirSync, join, loadConfig, overwriteCase, readEvents, rowEventsFile, saveConfig, saveRun, rescoreRow, runRow, getRun, fakeAgents, fakeJudge } from './testing/orchestrator-harness';

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

describe('runRow：失败面与配置漂移（每一行都必须落到终态 + 可读原因）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('准备阶段失败（仓库不是 git 仓库）也要落 failed 并保留错误详情，不能静默停在 preparing', async () => {
    const notARepo = join(home.root, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', repoPath: notARepo });
    const rowId = run.rows[0]?.id ?? '';

    await runRow(run.id, rowId); // 永不抛：失败被折成终态

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBeTruthy();
    expect(row?.error?.message.length).toBeGreaterThan(0);
    expect(row?.error?.message).not.toContain('undefined');
    expect(row?.diff).toBeNull(); // 工作区没建起来，没有 diff 可取
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)?.type).toBe('end');
  });

  it('供应商已删除 → failed 且给出去向，而不是 TypeError', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const config = loadConfig();
    saveConfig({ ...config, providers: [] });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('供应商已删除');
    expect(row?.error?.message).toContain('新建评测');
  });

  it('供应商的 baseUrl 被改过：用**当前配置**执行，但差异必须留 WARN（快照只用于追溯）', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = loadConfig();
    saveConfig({
      ...config,
      providers: config.providers.map((item) =>
        item.id === provider.id ? { ...item, baseUrl: 'https://moved.invalid/v1' } : item,
      ),
    });

    await runRow(run.id, run.rows[0]?.id ?? '');

    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    // 真正生效的是当前配置（改地址多半是为了修一个错，拿旧地址重跑会再错一次）
    expect(fakeAgents.calls[0]?.baseUrl).toBe('https://moved.invalid/v1');
    // 但差异必须留痕：快照与当前配置不一致这件事本身要能被发现
    const warnText = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnText).toContain('baseUrl 快照与供应商当前配置不一致');
  });

  it('适配器 run() 直接抛异常（契约违例）→ 该行仍落 failed、原因可读，且失败行的 diff 照样留痕', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    fakeAgents.scripts.set('codex', { mode: 'throw', files: [{ path: 'half-done.txt', content: '跑到一半\n' }] });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('假适配器：run() 直接抛了异常');
    // 「它跑到一半改了什么」正是失败行最需要看的证据：
    // 工作区只要建起来了就必须留 diff 摘要。为什么这里只看「不为 null」、不钉计数：throw 模式
    // 的假适配器是**先抛后写**（见 fixtures 里 mode==='throw' 的位置），工作区此刻还没被改动，
    // 计数天然是 0——钉 `filesChanged: 1` 是在钉夹具的脚本顺序，不是在钉编排层的行为
    //（实测踩过：把它写成 1 会得到一条与实现无关的恒红断言）。
    expect(row?.diff).not.toBeNull();
  });

  it('协议不匹配（openai 供应商 + Claude Code 行）→ failed 且两种协议都说清楚', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', agentKind: 'claude-code' });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('Claude Code');
    expect(row?.error?.message).toContain('Anthropic');
  });

  /**
   * 「哪家配哪种协议」钉在 **evaluator 侧**：适配器统一走 pi-ai 路由，`dsh` 声明
   * `protocolTypes: ['openai','anthropic']`，两条 wire 都受支持（含计量）⇒ 「dsh 行 + openai 供应商」是
   * **合法**组合。这条是**正向用例**：它钉的是**编排层的复检**真的按集合放行，
   * 而不是把合法组合拦成 `failed`。
   *
   * 判据分两层，两层都要有：本文件这一条钉**编排层的复检**（夹具给的 dsh 元数据就是两条 wire；
   * 注意 evaluator 的三个 `vi.mock` 把 `@aieval/agents` 整个换成了夹具，改**真注册表**在这里看不到），
   * `packages/server/api/src/runs.test.ts` 的「DSH 同时接受两种协议」钉**真注册表**那一侧。
   */
  it('dsh 行 + openai 供应商：放宽后**放行**，agent 真的被调起', async () => {
    const { run, provider } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', agentKind: 'dsh' });
    // 前提本身也是断言的一部分：夹具默认给的就是 openai 供应商（改掉它这条用例会当场失效）
    expect(provider.protocolType).toBe('openai');

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('judged');
    expect(row?.error).toBeNull();
    // 假适配器真的被调起过（候选行这一次；走的是 dsh 那份脚本）
    expect(fakeAgents.calls.length).toBeGreaterThan(0);
    expect(fakeAgents.calls[0]?.kind).toBe('dsh');
  });

  it('用例已删除 → failed 且说明「历史可看、不能跑」', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    // 用例是一文件一落：把用例文件删掉才是「用例已被删除」（配置里已经没有 cases 这一格了）
    clearCases();

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('用例已删除');
    expect(row?.error?.message).toContain('历史记录仍可查看');
  });

  it('未配置评分模型 → failed 且错误信息指向设置页（不是崩、不是停在 judging）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: false });

    await runRow(run.id, run.rows[0]?.id ?? '');

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toMatch(/设置/);
    // 前置步骤的产物仍然要留痕：diff 与计量已经落库，失败只影响分数
    expect(row?.diff?.filesChanged).toBe(0);
    expect(row?.tokens).toEqual({ input: 10, cached: 0, output: 20 });
  });

  it('评分解析失败 → failed + JUDGE_PARSE_FAILED，且 raw 原文进入事件日志（日志抽屉可见）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeJudge.mode = 'fail';

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('JUDGE_PARSE_FAILED');
    expect(row?.score).toBeNull();

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    const logText = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('{"judgments":[]}');
    expect(logText).toContain('评分模型原始返回');
  });

  it('适配器返回 ok:false 却不带 error（契约违例）→ 仍给出可读归因', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    // omitError：复现「ok:false 却没有 error 字段」的契约违例（假适配器的脚本开关）
    fakeAgents.scripts.set('codex', { mode: 'error', omitError: true });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.code).toBe('AGENT_FAILED');
    expect(row?.error?.message).toContain('适配器未给出原因');
  });

  /**
   * 适配器违约（`run()` 抛异常）走的是 `classifyStop` → `settleStopped`。`settleStopped` 在 `failed`
   * 时**必须补发 `error`**，顺序与 `settleFailed` 一致（error 先于终态 status，`end` 收尾）——
   * 事件日志是唯一真相源：日志抽屉缺了原因，事后就无法复盘这一行为什么失败
   * （`run.json` 里有，但抽屉是唯一能看时间线的地方）。
   */
  it('适配器违约落 failed 时，事件日志里有 error 事件（与其它失败路径同一口径）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'throw' });

    await runRow(run.id, rowId);

    expect(getRun(run.id).rows[0]?.status).toBe('failed');
    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(events.map((event) => (event.type === 'status' ? `status:${event.status}` : event.type))).toEqual([
      'status:preparing',
      'status:running',
      'diff-summary',
      'error',
      'status:failed',
      'end',
    ]);
    const error = events.find((event) => event.type === 'error');
    expect(error?.type === 'error' ? error.message : '').toContain('假适配器：run() 直接抛了异常');
  });

  it('diff 超预算：按文件裁剪、标 truncated、把被丢弃的文件写进日志', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', diffBudgetBytes: 200 });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', {
      files: [
        { path: 'big-a.txt', content: `A${'x'.repeat(2_000)}\n` },
        { path: 'big-b.txt', content: `B${'y'.repeat(2_000)}\n` },
      ],
    });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.diff?.filesChanged).toBe(2);
    expect(row?.diff?.truncated).toBe(true);

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, rowId));
    const summary = events.find((event) => event.type === 'diff-summary');
    expect(summary?.type === 'diff-summary' ? summary.truncated : false).toBe(true);
    const logText = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('diff 超过上限 200 字节');
    expect(logText).toMatch(/big-a\.txt|big-b\.txt/);
  });

  /**
   * 兜底守卫：评分表为空（满分 0）时**不许**走到 `finalizeScore`。
   * 为什么需要它：`RubricSchema` 刻意不设 `.min(1)`（空表是新建用例的真实初态），而空表是一张**合法的
   * `Rubric`**——用例的写入路径由 `assertStorable` 拦得住，但读侧只拒过不了 schema 的形状，于是一张
   * 手改 `config.json` 留下的空表照样能被 `getCase` 读出来、被 `createRun` 原样快照进 `run.json`。
   * 空表的 `maxScore` 是 0，而 `ScoreResultSchema.maxScore` 要求正数 ⇒ 放它进去会抛 `INTERNAL`
   * （一条本不该发生的形状漂移），使用者看到的是一句「本不该发生」——而这明明是一个可以讲清楚的状态。
   *
   * 起点是**真跑一行**（不是手搓一条 judged 行）：空表只挡评分那一段，候选阶段照常产出，
   * 于是「有工作区、有 diff」这个重评硬前提是真的，下面第二个入口（`rescoreRow`）走的是真路。
   * 两个入口共用 `runJudgeStage`，故这一条把两条路都钉住。
   */
  it('评分表为空的用例不评分：该行 failed + 中文原因，评分器一次都没被调用', async () => {
    // `withJudge: true` 是承重的：不配评分模型的话，「评分器一次都没被调用」会因为另一个原因成立（假绿）
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    // 空表同时写进**用例**与这一轮的**快照**：真实来路是「手改过的用例文件里那条用例是空表，
    // 这一轮照着它建、于是快照也是空表」（用例的写入路径拦得住空表，落盘的这一份只能从工具外来）
    const emptyRubric = { groups: [] };
    overwriteCase(run.caseId, { rubric: emptyRubric });
    saveRun({ ...run, rubric: emptyRubric });

    await runRow(run.id, rowId);

    const row = getRun(run.id).rows[0];
    expect(row?.status).toBe('failed');
    expect(row?.error?.message).toContain('评分标准项');
    // 文案的另一半是**唯一解得开这个状态的动作**：判据读的是这一轮的**快照**，所以只说
    // 「去用例里补评分项」会把用户送进死循环（补完再跑，撞上的还是同一条守卫与同一张空快照）。
    // 这条断言钉住那句出路，缺了它文案就又变成把人引到找不到的地方。
    expect(row?.error?.message).toContain('新建一轮评测');
    // 一次评分请求都不该花出去：没有表就没有判定依据。这条断言是有区分力的——去掉守卫时它是 1，
    // 而那一行会拿着假评分器的读数（满分 30）落成 judged
    expect(fakeJudge.calls).toHaveLength(0);
    // 候选阶段照常跑完（空表只挡评分那一段）：下面那条重评的前提（工作区 + diff）因此是真前提
    expect(fakeAgents.calls).toHaveLength(1);

    // 第二个入口（重新评分）：同一个 `runJudgeStage`、同一句中文原因、同样一次评分都不花
    const returned = rescoreRow(run.id, rowId);
    expect(returned.rows[0]?.status).toBe('judging');
    await until(() => getRun(run.id).rows[0]?.status === 'failed', '空表行重新评分同样落 failed');
    expect(getRun(run.id).rows[0]?.error?.message).toContain('评分标准项');
    expect(fakeJudge.calls).toHaveLength(0);
  });
});
