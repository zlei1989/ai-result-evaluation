// @vitest-environment node
/**
 * recoverInterruptedRuns（F10：重启不自动续跑）
 *
 * 本文件是 `orchestrator.test.ts` 拆分后的一块，覆盖：recoverInterruptedRuns（F10：重启不自动续跑）、R31 夹具守卫：跨 resetFakeAgents 的迟到出口不许改共享状态。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import {
  vi,
  describe,
  expect,
  it } from 'vitest';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  until,
  home,
  readFileSync,
  writeFileSync,
  join,
  readEvents,
  rowEventsFile,
  runSnapshotFile,
  recoverInterruptedRuns,
  getRun,
  saveRun,
  fakeAgents,
  fakeAgentsModule,
  makeRowFixture,
  makeRunFixture,
  makeScoreFixture,
  resetFakeAgents,
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
 * 重启恢复（spec §7.4 / F10）
 *
 * 这是 `interrupted` 终态在**本仓唯一的生产路径**：上一进程被杀（或正常重启）之后，行会停在
 * `preparing` / `running` / `judging` 这些非终态上，而 agent 子进程已经不存在了——「续跑」需要
 * 独立进程托管，本期不做（F10），恢复只做「收尾」：把在途行标 `interrupted`、把轮收成 `partial`。
 *
 * 三条容易被写错、坏了会直接伤到使用者的地方，各有独立用例：
 *   ① **不误伤终态行**：`failed` 行上的失败原因、`timed-out` 行上的超时原因都是使用者排查的唯一线索，
 *      被一次恢复改写成「被重启打断」就永久丢了；
 *   ② **一条坏快照不得挡住其它轮次**：坏文件在 `listRuns` 里跳过并 WARN，而不是让启动钩子抛错
 *      （启动钩子抛错会让整个 Next 服务起不来）；
 *   ③ **幂等**：启动钩子可能在同一进程里被调用不止一次，第二次不许重复发事件、不许改写轮状态。
 * =================================================================================================== */

describe('recoverInterruptedRuns（F10：重启不自动续跑）', () => {
  it('只把 preparing / running / judging 的行标 interrupted，一个终态行都不动', () => {
    const rows = [
      makeRowFixture({ status: 'judged', score: makeScoreFixture(true) }),
      makeRowFixture({ status: 'failed', error: { code: 'AGENT_FAILED', message: '上次失败的原因' } }),
      makeRowFixture({ status: 'running' }),
      makeRowFixture({ status: 'preparing' }),
      makeRowFixture({ status: 'judging' }),
      makeRowFixture({ status: 'canceled' }),
      makeRowFixture({ status: 'timed-out', error: { code: 'AGENT_TIMED_OUT', message: '上次超时' } }),
      makeRowFixture({ status: 'skipped' }),
      makeRowFixture({ status: 'interrupted' }),
      makeRowFixture({ status: 'pending' }),
    ];
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows, status: 'running' });
    saveRun(run);

    const result = recoverInterruptedRuns();

    expect(result.recovered).toBe(3); // 单位是**行数**
    const saved = getRun(run.id);
    expect(saved.rows.map((row) => row.status)).toEqual([
      'judged', // 终态行原样
      'failed',
      'interrupted',
      'interrupted',
      'interrupted',
      'canceled',
      'timed-out',
      'skipped',
      'interrupted', // 本来就是 interrupted 的行不算「本次恢复」，也不被改写
      'pending', // 从未开跑的行不碰
    ]);
    // 终态行的证据必须原样保留（这正是「不误伤」的判据：分数与错误原因都还在）
    expect(saved.rows[0]?.score?.totalScore).toBe(30);
    expect(saved.rows[1]?.error?.message).toBe('上次失败的原因');
    expect(saved.rows[6]?.error?.message).toBe('上次超时');
    // 轮不再「运行中」：否则界面会一直转圈而没有任何行在跑
    expect(saved.status).toBe('partial');
    expect(saved.finishedAt).not.toBeNull();
  });

  it('被恢复的行在事件日志里留下一句解释（日志抽屉停在半路时，看的人要知道是服务没了）', () => {
    const row = makeRowFixture({ status: 'running' });
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row], status: 'running' });
    saveRun(run);

    recoverInterruptedRuns();

    const events = readEvents(rowEventsFile(home.workspaceRoot, run.id, row.id));
    const logText = events
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('服务重启');
    expect(events.some((event) => event.type === 'status' && event.status === 'interrupted')).toBe(true);
  });

  it('一条坏快照不会挡住其它轮次的恢复（跳过 + WARN，不是整轮启动失败）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [makeRowFixture({ status: 'running' })], status: 'running' });
    const broken = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [makeRowFixture({ status: 'running' })], status: 'running' });
    saveRun(good);
    saveRun(broken);
    writeFileSync(runSnapshotFile(home.workspaceRoot, broken.id), '{ 半截', 'utf8');

    expect(recoverInterruptedRuns().recovered).toBe(1);
    expect(getRun(good.id).rows[0]?.status).toBe('interrupted');
    expect(warn).toHaveBeenCalled();
  });

  /**
   * 幂等（启动钩子可能被调用不止一次；重试、热重载、多实例共用一个配置目录都会走到这里）。
   * 判据取**最强的那一档**：第二次调用之后 run.json 与 events.jsonl **一字不变**——
   * 它同时覆盖「不再追加一条 status / end 事件」与「不把 partial 改写成别的状态、不刷新 finishedAt」，
   * 比只数 `end` 事件更难被一个「看起来对」的实现混过去。
   */
  it('幂等：第二次调用不追加任何事件、不改写轮状态（连续两次的 run.json 逐字节相同）', () => {
    const row = makeRowFixture({ status: 'running' });
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [row], status: 'running' });
    saveRun(run);

    expect(recoverInterruptedRuns().recovered).toBe(1);
    const snapshotFile = runSnapshotFile(home.workspaceRoot, run.id);
    const eventsFile = rowEventsFile(home.workspaceRoot, run.id, row.id);
    const snapshotAfterFirst = readFileSync(snapshotFile, 'utf8');
    const eventsAfterFirst = readEvents(eventsFile);

    expect(recoverInterruptedRuns().recovered).toBe(0);

    expect(readFileSync(snapshotFile, 'utf8')).toBe(snapshotAfterFirst);
    expect(readEvents(eventsFile)).toEqual(eventsAfterFirst);
    // 终态事件各恰好一条：中断的收尾既能被「读了日志的人」认出来，也不会重复收尾
    expect(eventsAfterFirst.filter((event) => event.type === 'status' && event.status === 'interrupted')).toHaveLength(1);
    expect(eventsAfterFirst.filter((event) => event.type === 'end')).toHaveLength(1);
  });

  /**
   * **陈旧的 `listRuns()` 结果不得改写终态行**（阶段评审 Low-4）。
   *
   * 恢复先用 `listRuns()` 挑出「看起来在途」的行，再逐行 `setRowStatus(…, 'interrupted')`；而
   * `setRowStatus` 只按 id 定位、**不比对当前状态**。若某一行在「读列表」与「改写」之间跑完（`judged`），
   * 恢复就会把它的分数与状态一起抹掉——正是本函数开头承诺「终态行一字不动」要防的事，而那条承诺原先
   * 只写在注释里（**没有**二次复检）。
   *
   * 窗口在今天不可达（唯一调用点是启动钩子，那一瞬没有行在跑），所以判据造在**模块边界**上：
   * 让 `listRuns()` 返回一份**陈旧**快照（说该行还在 `running`），而磁盘上的当前快照里它已经 `judged`。
   * 缺了循环里那次二次复检时，这一行的 `judged` 与 30 分会一起被改写成 `interrupted`。
   */
  it('listRuns 的结果陈旧（该行其实已 judged）时不改写它：终态行的分数不许被恢复抹掉（Low-4）', () => {
    const judged = makeRowFixture({ status: 'judged', score: makeScoreFixture(true) });
    const run = makeRunFixture({ workspaceRoot: home.workspaceRoot, rows: [judged], status: 'running' });
    saveRun(run);
    // 恢复「读到」的那份列表：同一轮同一行，但在列表里它还是 running
    injected.staleList = [{ ...run, rows: [{ ...judged, status: 'running' }] }];

    const result = recoverInterruptedRuns();

    expect(result.recovered).toBe(0);
    const saved = getRun(run.id);
    expect(saved.rows[0]?.status).toBe('judged');
    expect(saved.rows[0]?.score?.totalScore).toBe(30);
    // 一个字节的事件都不该写：连那句「服务重启：该行执行已中断」都不该出现
    expect(readEvents(rowEventsFile(home.workspaceRoot, run.id, judged.id))).toEqual([]);
    // 轮级收尾照旧发生（它读的是当前快照，而此刻确实没有任何行在跑，`partial` 是对的）：
    // 本用例只钉「行级不许被改写」这一半
    expect(saved.status).toBe('partial');
  });
});


/* ===================================================================================================
 * 夹具自身的守卫（与本计划的功能无关，但它会把功能的守卫染成假红）
 *
 * `fakeAgents.concurrent` 是**模块级**计数器，而 `resetFakeAgents()` 只能把它清零、
 * 没法让一个已经挂在 gate 里的 `run()` 落定。用例超时（本机的环境性超时，实测有 60s 以上
 * 才建完夹具的）把一行丢在 gate 里之后，那一行唯一的终结者是编排层的**行兜底定时器**
 * （默认配置下约 33 分钟后才响），它迟到的 `concurrent -= 1` 会落进**后面某个用例**的断言窗口，
 * 让「三行同时在跑」那条断言以 `expected 3, received 2` 随机变红（已真实发生过一次，不可复现）。
 *
 * 这一段钉住代际守卫的**区分力**：去掉守卫，下面那条断言立刻变红（见任务报告的变异记录）。
 * 注意它用的是 `fakeAgentsModule()` **直接**起一次假运行，而不是穿过编排层：
 * 造出「跨 reset 的迟到出口」需要精确控制放行时机，而编排层那条路要先建真实 git 工作区
 * （几秒起步，比被测的那几行代码慢三个数量级）。
 *
 * 守卫有**四处**落点，本用例够得着**两处**（终审 FIX-5 纠正：上一版记成 3/4，其中一条不成立）：
 *   ① `finish()` 的 `concurrent -= 1`（用「concurrent 保持 0」钉住）——**可达**：
 *      那一次运行挂在 gate 里，放行发生在 reset 之后；
 *   ② 成功路径那次 `onEvent` 投递（用「收集到的事件保持空」钉住，脚本里给了 `events`）——**可达**，
 *      与 ① 同一个窗口（放行之后才走到投递）。
 *   **够不着的两处**（它们不是守卫，是恒真的条件——留着是为了「将来有人在前面插入 `await`」时仍然成立）：
 *   · `mode:'throw'` 的 `concurrent -= 1`：throw 分支前面唯一的 `await` 在 `mode === 'hang'`
 *     那一支里，而两个 mode **互斥** ⇒ 走到 throw 时函数体还没有让出过事件循环，
 *     这一次运行必然属于**当代** ⇒ `currentGeneration()` 恒真。要造出区分力只能在 reset 之前
 *     让它落定，那就不是「迟到的出口」了；改夹具（在前面加一个 await）等于改被测对象，不算。
 *   · `gates.set(...)` 的登记：它在 `new Promise` 的 **executor** 里同步执行（同一次同步段），
 *     `currentGeneration()` 同样恒真；用例里 `expect(fakeAgents.gates.size).toBe(0)` 之所以成立，
 *     是因为 `resetFakeAgents()` 清空了那个 map，**不是**这条条件拦下来的。
 *   两处共用同一条 `currentGeneration()` 表达式，它的区分力由 ① 与 ② 覆盖（把表达式改成恒真，
 *   ① 立刻以 `concurrent === -1` 变红）。
 * =================================================================================================== */
describe('R31 夹具守卫：跨 resetFakeAgents 的迟到出口不许改共享状态', { timeout: TEST_TIMEOUT_MS }, () => {
  it('上一代的 gate 在 reset 之后放行：concurrent 保持 0，且不改写已清空的 calls / gates / 事件流', async () => {
    // `fakeAgentsModule()` 现在是 async（它要从真 `@aieval/agents` 取协议判据与文案，见 `testing/fixtures.ts`）
    const provider = (await fakeAgentsModule()).getProvider('codex');
    const controller = new AbortController();
    // 成功路径会投递这两条：它们必须**投不进**本代用例的事件流（第三处守卫）
    fakeAgents.scripts.set('codex', {
      mode: 'gate',
      events: [{ stream: 'stdout', text: '上一代的日志：不该出现在本代的事件流里' }],
    });
    /** 本代用例收到的事件（代际守卫失效时，上一代的日志会灌进来） */
    const collected: string[] = [];

    const pending = provider.run({
      cwd: join(home.root, 'stale-workspace'),
      configHome: join(home.root, 'stale-home'),
      permission: 'full',
      prompt: 'R31：这次运行属于上一代',
      route: { protocolType: 'openai', baseUrl: 'https://fake.invalid/v1', apiKey: 'sk-test', modelId: 'test-model' },
      signal: controller.signal,
      onEvent: (event) => collected.push(event.type),
    });
    await until(() => fakeAgents.gates.size === 1, '假运行进入 gate');
    expect(fakeAgents.concurrent).toBe(1);
    // 放行器要在 reset **之前**取出来：reset 会清空 gates（那正是「用例结束」的形状），
    // 此刻才去 releaseAllAgents() 会得到一个空集合，被挂起的那一次运行反而永远不落定（实测踩过）
    const release = [...fakeAgents.gates.values()][0];
    expect(release).toBeTypeOf('function');

    // 用例结束：`beforeEach` 做的正是这一句。挂起的那一次运行此刻**还没有落定**
    resetFakeAgents();
    expect(fakeAgents.concurrent).toBe(0);

    // 迟到的放行：被挂起的那一次运行此刻才落定（它会走完 writeFiles + 事件投递 + finish）
    release?.();
    await pending;

    // 未被守卫拦住的实现会在这里变成 -1，并把这个负值带进后面每一个并发断言
    expect(fakeAgents.concurrent).toBe(0);
    expect(fakeAgents.calls).toHaveLength(0);
    // 这一条**不是**守卫的证据：gates 之所以是空的，是因为上面那次 resetFakeAgents() 清空过它
    //（`gates.set` 的登记发生在同步段里，恒真；见本 describe 的头注）
    expect(fakeAgents.gates.size).toBe(0);
    // 第二处**可达**的守卫：事件一条都不许投进本代用例的流里（否则上一代的日志会搅红别人的断言）
    expect(collected).toEqual([]);
  });
});
