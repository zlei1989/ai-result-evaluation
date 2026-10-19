// @vitest-environment node
/**
 * `followUpRow`：对**已经跑过**的行追问（接着同一段上下文再跑一段，不重建工作区、不重置会话）。
 *
 * 本文件钉的是这条路与「重新执行」(`retryRow`) 的**分界**：追问复用行工作区与会话、
 * 计量累加、`attempts` 不变、跑完无条件重评；不可追问的每一档各给一句能直接展示的中文原因，
 * 且都不许静默从头跑（档位与文案的唯一真源是契约层的 `canFollowUpRow`，这里走真 provider
 * 把那几档各踩一遍）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortRow,
  adapterMessagesOf,
  clearCases,
  followUpAvailability,
  drainRunningTasks,
  existsSync,
  fakeAgents,
  fakeJudge,
  followUpRow,
  getRun,
  join,
  readEvents,
  registerOrchestratorHooks,
  releaseAllAgents,
  retryRow,
  rmSync,
  rowEventsFile,
  rowRecordsOf,
  rowSettled,
  runRow,
  seedRunnableRun,
  ServiceError,
  TEST_TIMEOUT_MS,
  until,
  writeFileSync,
} from './testing/orchestrator-harness';
import { subscribeRowEvents } from './events';
// 队列表的登记口在编排层那一侧（与 `orchestrator-inject-messages.test.ts` 同一个入口）
import { registerInjectMessage, resetInjectQueueForTesting } from './inject-port';

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

// 队列表挂在进程内的总线上、跨用例存活：不清的话上一条用例登记的 `messageId` 会让下一条同名登记变成幂等命中
beforeEach(() => {
  resetInjectQueueForTesting();
});

/**
 * 跑完一行（追问的前置），并把那一行的 `sessionId` 钉成一个具体 id。
 * 追问的全部价值都在「接回同一条会话」上，故夹具先把这条会话造出来。
 */
async function seedJudgedRow(
  agentKind: 'codex' | 'dsh' = 'codex',
  sessionId = 'sess-1',
  injectMessages = false,
): Promise<{ runId: string; rowId: string; workspacePath: string }> {
  const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', agentKind, injectMessages });
  const rowId = run.rows[0]?.id ?? '';
  fakeAgents.scripts.set(agentKind, {
    mode: 'ok',
    files: [{ path: 'first.txt', content: '第一段\n' }],
    sessionId,
    // 钉一个具体读数：夹具的墙钟只有几毫秒，而「累计耗时不倒退」那一条要的是一个**有分量的基数**
    durationMs: 600_000,
  });
  await runRow(run.id, rowId);
  const row = rowOf(run.id, rowId);
  expect(row.status).toBe('judged');
  expect(row.sessionId).toBe(sessionId);
  return { runId: run.id, rowId, workspacePath: row.workspacePath };
}

/** 这一行的快照（找不到即抛：用例里的行 id 都来自夹具，找不到就是夹具自己错了） */
function rowOf(runId: string, rowId: string) {
  const row = getRun(runId).rows.find((item) => item.id === rowId);
  if (row === undefined) throw new Error(`夹具里没有这一行：${rowId}`);
  return row;
}

/** 该行的事件日志路径（行目录按这一轮自己记录的 `workspaceBase` 解析） */
function eventsOf(runId: string, rowId: string): string {
  return rowEventsFile(getRun(runId).workspaceBase, runId, rowId);
}

/** 被拒的中文原因（`followUpRow` 拒绝时抛 `CONFLICT`；放行即用例失败） */
function refusalOf(runId: string, rowId: string, input: Parameters<typeof followUpRow>[2]): string {
  try {
    followUpRow(runId, rowId, input);
  } catch (error) {
    if (error instanceof ServiceError) return error.message;
    throw error;
  }
  throw new Error('本该拒绝，却放行了');
}

/**
 * 拒绝之后这一行必须**一字未动**——状态、分数、尝试次数，以及「候选有没有被再跑一次」。
 * 这是「都不许静默从头跑」这句话在用例里的形状：放行一次就是一次几分钟的从头重跑。
 */
function expectRowUntouched(
  runId: string,
  rowId: string,
  before: { status: string; score: unknown; attempts: number | undefined },
  callsBefore: number,
): void {
  const row = rowOf(runId, rowId);
  expect(row.status).toBe(before.status);
  expect(row.score).toEqual(before.score);
  expect(row.attempts).toBe(before.attempts);
  expect(fakeAgents.calls.length).toBe(callsBefore);
}

describe('followUpRow：追问复用行工作区与会话', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **行为判据（主）**：行工作区里那个哨兵文件在追问之后必须还在。
   * 它会随 `prepareRowWorkspace → resetRowDir → clearRowArtifacts` 一起消失——
   * 而「工作区被重建」正是「追问接到了 `retryRow` 上」的症状，也是「智能体什么都不记得了」的成因。
   * 同一轮里另钉两格：`resume` 带的是行快照里那个会话 id、`cwd` 还是原来那个目录。
   */
  it('追问复用同一个工作区与会话：哨兵文件还在、resume 带的是行快照里的会话 id', async () => {
    const { runId, rowId, workspacePath } = await seedJudgedRow('codex', 'sess-keep');
    const sentinel = join(workspacePath, 'sentinel.txt');
    writeFileSync(sentinel, '哨兵：工作区被重建就会消失\n', 'utf8');
    const callsBefore = fakeAgents.calls.length;

    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-keep' });
    const returned = followUpRow(runId, rowId, { text: '接着把第二段也写了' });
    // 同步返回「已经在准备中」的快照（HTTP 立刻拿到，不挂在请求上等分钟级）
    expect(returned.rows[0]?.status).toBe('preparing');

    await drainRunningTasks();
    await until(
      () => rowOf(runId, rowId).status === 'judged',
      '追问后回到 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(runId, rowId),
    );

    const after = rowOf(runId, rowId);
    expect(after.status).toBe('judged');
    // 工作区没被重建：路径没变、哨兵文件还在
    expect(after.workspacePath).toBe(workspacePath);
    expect(existsSync(sentinel), '追问不许重建工作区（工作区被重建就会连带删掉会话）').toBe(true);
    // 候选真的又跑了一次，且这一次是**接着那条会话**跑的
    expect(fakeAgents.calls.length).toBe(callsBefore + 1);
    const call = fakeAgents.calls.at(-1);
    expect(call?.resumeSessionId).toBe('sess-keep');
    // **旧路径零改动**：普通追问不带 `fork`（`run` 的可选入参缺席 ⇒ 适配器一个 checkpoint
    // 选项都不碰）。这一格与 cc 适配器那条「不带 fork 时两格都不出现」是同一判据的两端。
    expect(call?.fork).toBeUndefined();
    expect(call?.cwd).toBe(workspacePath);
    expect(call?.prompt).toContain('接着把第二段也写了');
    expect(after.sessionId).toBe('sess-keep');
  });

  /**
   * 那一句人话要落**两处**：消息账本（`origin: 'human'`，复盘时与题面分得开）与行级事件
   * （日志抽屉里看得见）。两处都在「真的要交给厂商」那一拍写下去。
   *
   * 这一条同时钉住 **`segment` 那一格**：追问是又开一次 `run()`，厂商轮次从 1 重新数 ⇒
   * 两段的 `mergeKey` 会逐字相同，读侧折叠靠 `(segment, mergeKey)` 才分得开；段号同时是界面上
   * 「追问 ×N」那一段的界碑。整段（含适配器交出来的消息）都要带同一个段号。
   */
  it('追问落账本与行级事件：那句人话两处都看得到，且这一段的每条消息都带段号', async () => {
    const { runId, rowId } = await seedJudgedRow();
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', messages: [{ text: '追问那一段的答复' }] });
    followUpRow(runId, rowId, { text: '这一句必须能在日志里看到' });
    await drainRunningTasks();

    const texts = readEvents(eventsOf(runId, rowId))
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(texts).toContain('这一句必须能在日志里看到');

    const human = rowRecordsOf(runId, rowId).messages.filter((message) => message.origin === 'human');
    expect(human.map((message) => message.role)).toEqual(['user']);
    expect(
      human.some((message) =>
        message.blocks.some((block) => block.type === 'text' && block.text === '这一句必须能在日志里看到'),
      ),
    ).toBe(true);

    // 段号：人话那一条与适配器交出来的那一条都是 1（第 1 次追问那一段）
    expect(human.map((message) => message.segment)).toEqual([1]);
    const adapter = adapterMessagesOf(runId, rowId);
    expect(adapter).not.toEqual([]);
    expect(adapter.every((message) => message.segment === 1)).toBe(true);
    // 首段那条题面仍是缺席 = 0（段号只在追问那一侧写）：判据取 `role: 'user'`，
    // 光看 `origin` 分不开——适配器投出来的消息那一格默认也是 `case-prompt`
    const casePrompt = rowRecordsOf(runId, rowId).messages.filter(
      (message) => message.origin === 'case-prompt' && message.role === 'user',
    );
    expect(casePrompt.map((message) => message.segment)).toEqual([undefined]);
  });

  /**
   * **两段同号不互相覆盖**（`mergeKey` 逐字相同的那一对）：追问段的第 1 轮与首段的第 1 轮
   * 各自都在账本里。少这一格时后一段会把前一段整条吃掉，界面上表现为「追问之后首段的工具调用
   * 与思考凭空消失」。
   */
  it('两段同号的消息都在账本里（段号把它们分成两条不同的逻辑消息）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const runId = run.id;
    const rowId = run.rows[0]?.id ?? '';
    // 首段也要真的投一条消息：两边同号（都是第 1 轮、都是 assistant）才测得到那个撞键
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', messages: [{ text: '首段的第 1 轮' }] });
    await runRow(runId, rowId);

    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', messages: [{ text: '追问那一段的第 1 轮' }] });
    followUpRow(runId, rowId, { text: '再说一句' });
    await drainRunningTasks();

    const firstSegment = adapterMessagesOf(runId, rowId).filter((message) => message.segment === undefined);
    const secondSegment = adapterMessagesOf(runId, rowId).filter((message) => message.segment === 1);
    // 两段那一条的载体键**逐字相同**，靠段号才分得开（折叠键 = 段号 + 载体键）
    expect(firstSegment.map((message) => message.mergeKey)).toEqual(['main|1|assistant|-']);
    expect(secondSegment.map((message) => message.mergeKey)).toEqual(['main|1|assistant|-']);
    expect(firstSegment.map((message) => (message.blocks[0] as { text: string }).text)).toEqual(['首段的第 1 轮']);
    expect(secondSegment.map((message) => (message.blocks[0] as { text: string }).text)).toEqual(['追问那一段的第 1 轮']);
  });
});

describe('followUpRow：注入面（追问这一段行在跑，人就能往这一轮送话）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('闸门开着 ⇒ 适配器拿到端口，队列里那条投出去、落账本、计数与账本对齐', async () => {
    const { runId, rowId } = await seedJudgedRow('codex', 'sess-1', true);
    registerInjectMessage({
      runId,
      rowId,
      messageId: 'm-2',
      text: '追问这一段里补的一句',
      attachments: [],
      requires: 'idle',
    });
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', injectDrain: 'idle' });

    followUpRow(runId, rowId, { text: '先接着干' });
    await drainRunningTasks();

    const call = fakeAgents.calls.at(-1);
    expect(call?.injectAttached).toBe(true);
    expect(call?.injectAvailable).toBe(true);
    expect(call?.injectDelivered).toEqual(['m-2']);
    const { messages } = rowRecordsOf(runId, rowId);
    // 两句话都在账本里、都是人话：追问那一句与队列里那一条（同一把钥匙各追各的）
    expect(messages.filter((message) => message.origin === 'human')).toHaveLength(2);
    const row = rowOf(runId, rowId);
    expect(row.followUps).toBe(2);
    // 这一行只被追问过 1 次：账本那两条里有一条是**队列里送进去的**，不是追问
    expect(row.followUpRounds).toBe(1);
  });

  /**
   * **两个读数各归各的**（`followUps` 数已送达的人话、`followUpRounds` 数追问轮次）。
   *
   * 场景就是这一格兼两义时会出错的那个：「先有 2 条注入、再追问 1 次」。
   *   · 账本里此刻有 **3** 条 `origin: human`（两条注入 + 这一句追问）⇒ 卡片那个读数就是 3；
   *   · 而这一行只被**追问过 1 次** ⇒ 日志里那句 `[人工追问 ×N]` 必须说 1。
   * 拿账本条数当「第几次追问」的话，这里会写成 3——用户读到的是三次追问，其中两次根本不存在。
   *
   * 这一条是那组 3 / 1 的**写侧那一端**：卡片读 `followUps`（总数 3）由
   * `@aieval/ui` 的 `eval-row-card.test.tsx`「卡片显示的是人工消息总数（3），不是追问轮次（1）」钉，
   * 两个读数在**同一个场景**里取值不同 ⇒ 哪一端读错格都有一处红。
   */
  it('两个读数各归各的：注入只加送达计数，追问只加轮次（日志里那句「第几次」读轮次）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', injectMessages: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', injectDrain: 'idle', durationMs: 600_000 });
    for (const messageId of ['m-inject-1', 'm-inject-2']) {
      registerInjectMessage({ runId: run.id, rowId, messageId, text: `${messageId} 的人话`, attachments: [], requires: 'idle' });
    }
    await runRow(run.id, rowId);

    // 第一条路：两条注入送达 ⇒ 只推进「已送达的人话」那一格，轮次纹丝不动
    const afterInject = rowOf(run.id, rowId);
    expect(afterInject.followUps).toBe(2);
    expect(afterInject.followUpRounds).toBe(0);

    // 第二条路：追问一次 ⇒ 账本多一条人话（读数 3），轮次只加一
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    followUpRow(run.id, rowId, { text: '这是第一次追问' });
    await drainRunningTasks();

    const { messages } = rowRecordsOf(run.id, rowId);
    expect(messages.filter((message) => message.origin === 'human')).toHaveLength(3);
    const after = rowOf(run.id, rowId);
    expect(after.followUps).toBe(3);
    expect(after.followUpRounds).toBe(1);

    const logText = readEvents(eventsOf(run.id, rowId))
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('[人工追问 ×1]');
    expect(logText).not.toContain('[人工追问 ×3]');
  });

  it('闸门关着（缺省）⇒ 追问这一段的入参里没有 `inject` 那一格（零回归判据）', async () => {
    const { runId, rowId } = await seedJudgedRow();
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    followUpRow(runId, rowId, { text: '闸门没开' });
    await drainRunningTasks();
    expect(fakeAgents.calls.at(-1)?.injectAttached).toBe(false);
    expect(fakeAgents.calls.at(-1)?.injectAvailable).toBe(false);
  });
});

describe('followUpRow：逐档拒绝，一条都不许静默从头跑', { timeout: TEST_TIMEOUT_MS }, () => {
  it('① 还没跑过的行与正在跑的行同一档（去输入区排队），不是「接不上」', () => {
    // `pending` 的行连会话都还没有，但它的处置是「等这一轮跑完」而不是「重新执行」：
    // 落进「没有可续接的会话」那一档会把用户引向一次从头重跑
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    const before = rowOf(run.id, rowId);
    expect(before.status).toBe('pending');
    expect(before.sessionId).toBeNull();
    const reason = refusalOf(run.id, rowId, { text: '还没跑过就想追问' });
    expect(reason).toContain('还没开始跑');
    expect(reason).toContain('排队');
    expect(reason).not.toContain('重新执行');
    expectRowUntouched(run.id, rowId, before, 0);
  });

  it('③ 跑过但没采到会话 id ⇒ 拒绝，且候选一次都没跑', async () => {
    // 形态：**跑过**（工作区在盘上）、但适配器没交回会话 id（旧产物就是这一档）——
    // 这一档只有③能拦：工作区检查放它过去，而放行它就会「从头再跑一遍」
    const judged = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const judgedRowId = judged.run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: null });
    await runRow(judged.run.id, judgedRowId);
    const judgedBefore = rowOf(judged.run.id, judgedRowId);
    expect(judgedBefore.status).toBe('judged');
    expect(judgedBefore.sessionId).toBeNull();
    expect(existsSync(judgedBefore.workspacePath)).toBe(true);
    const callsBefore = fakeAgents.calls.length;
    expect(refusalOf(judged.run.id, judgedRowId, { text: '跑过但没采到会话' })).toContain('没有可续接的会话');
    expectRowUntouched(judged.run.id, judgedRowId, judgedBefore, callsBefore);
  });

  it('② 工作区已被删除 ⇒ 拒绝（追问要在原工作区上继续）', async () => {
    const { runId, rowId, workspacePath } = await seedJudgedRow();
    const before = rowOf(runId, rowId);
    const callsBefore = fakeAgents.calls.length;
    rmSync(workspacePath, { recursive: true, force: true });

    expect(refusalOf(runId, rowId, { text: '工作区没了还追问' })).toContain('工作区已被删除');
    expectRowUntouched(runId, rowId, before, callsBefore);
  });

  it('③ 用例已删除 ⇒ 拒绝', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const before = rowOf(runId, rowId);
    const callsBefore = fakeAgents.calls.length;
    clearCases();

    expect(refusalOf(runId, rowId, { text: '用例没了还追问' })).toContain('用例已删除');
    expectRowUntouched(runId, rowId, before, callsBefore);
  });

  it('④ 追问带了附件、而附件根不存在 ⇒ 拒绝（点名要重新上传）', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const before = rowOf(runId, rowId);
    const callsBefore = fakeAgents.calls.length;

    const message = refusalOf(runId, rowId, {
      text: '带一张图',
      attachments: [{ kind: 'image', path: '/nowhere/gone.png', mimeType: 'image/png' }],
    });
    expect(message).toContain('附件根不存在');
    expect(message).toContain('重新上传');
    expectRowUntouched(runId, rowId, before, callsBefore);
  });

  it('⑤ dsh 声明支持续接 ⇒ 放行，且 resume 带的是行快照里那条会话（声明接错了这条会红）', async () => {
    const { runId, rowId } = await seedJudgedRow('dsh', 'sess-dsh');
    const callsBefore = fakeAgents.calls.length;
    fakeAgents.scripts.set('dsh', { mode: 'ok', sessionId: 'sess-dsh' });

    // 读侧与写侧同一份判据：读侧说可行，写侧就必须放行（否则就是「界面说能点、点下去 409」）
    expect(followUpAvailability(runId).rows[0]?.verdict).toEqual({ ok: true });

    followUpRow(runId, rowId, { text: '接着上次那段说' });
    await drainRunningTasks();
    await until(
      () => rowOf(runId, rowId).status === 'judged',
      '追问后回到 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(runId, rowId),
    );

    expect(fakeAgents.calls.length).toBe(callsBefore + 1);
    expect(fakeAgents.calls.at(-1)?.resumeSessionId).toBe('sess-dsh');
  });

  it('在跑的行走「输入区排队」那条路：明确拒绝，并指向排队', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const callsBefore = fakeAgents.calls.length;
    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    // 已经出分的行要走 `retryRow`（`runRow` 对 `judged` 直接返回：它只挑可执行的行）
    retryRow(runId, rowId);
    await until(() => rowOf(runId, rowId).status === 'running', '这一行进入 running', TEST_TIMEOUT_MS);

    const message = refusalOf(runId, rowId, { text: '它还在跑' });
    expect(message).toContain('正在运行中');
    expect(message).toContain('排队');
    expect(fakeAgents.calls.length).toBe(callsBefore + 1); // 只有上面那次 retryRow 起的候选

    releaseAllAgents();
    await drainRunningTasks();
  });

  it('上一次运行还没收尾（已落终态、任务还在）⇒ 拒绝，不与迟到的旧任务抢状态', async () => {
    const { runId, rowId } = await seedJudgedRow();
    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    retryRow(runId, rowId);
    await until(() => rowOf(runId, rowId).status === 'running', '这一行进入 running', TEST_TIMEOUT_MS);

    // 终止是**同步**落状态的：这一刻行已是 canceled，而任务还在（rowAborts 里那个条目还在）
    abortRow(runId, rowId);
    expect(rowOf(runId, rowId).status).toBe('canceled');
    expect(refusalOf(runId, rowId, { text: '旧任务还没收尾' })).toContain('还没收尾');

    releaseAllAgents();
    await drainRunningTasks();
  });
});

describe('followUpRow：计量累加、attempts 不变、跑完无条件重评', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **口径（与 `runRow` 相反、不可互换）**：`runRow` 那五格是「本次尝试的产出」（清零是对的），
   * 追问那五格是「这一行的累计产出」（累加是对的）。`attempts` 则**不变**——它答的是
   * 「这一行走过几次尝试」，而追问没有「从头」。
   */
  it('计量在本行原有读数上相加：tokens / turns / durationMs 累加，attempts 一字不动', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const before = rowOf(runId, rowId);
    const tokensBefore = before.tokens;
    expect(tokensBefore).not.toBeNull();
    expect(before.followUps).toBe(0);

    fakeAgents.scripts.set('codex', {
      mode: 'ok',
      sessionId: 'sess-1',
      tokens: { input: 100, cached: 5, output: 50 },
      turns: 3,
      durationMs: 7_000,
    });
    followUpRow(runId, rowId, { text: '再来一段' });
    await drainRunningTasks();

    const after = rowOf(runId, rowId);
    expect(after.tokens).toEqual({
      input: (tokensBefore?.input ?? 0) + 100,
      cached: (tokensBefore?.cached ?? 0) + 5,
      output: (tokensBefore?.output ?? 0) + 50,
    });
    expect(after.turns).toBe((before.turns ?? 0) + 3);
    expect(after.durationMs).toBe((before.durationMs ?? 0) + 7_000);
    // 追问不算新一次尝试
    expect(after.attempts).toBe(before.attempts);
    // 卡片上的「人工追问 ×N」：计数与那条行级事件在同一段代码里发生
    expect(after.followUps).toBe(1);
  });

  /**
   * **无条件重评**：不改成「只在 diff 有变化时重评」。这一条故意让追问**什么都不改**
   * （脚本不写文件 ⇒ diff 摘要与追问之前逐格相同），而分数必须被新的一次评分覆盖——
   * 「有改动才重评」那种实现会在这里红。
   */
  it('跑完无条件重评：diff 一格没变，分数照样被新的一次评分覆盖', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const before = rowOf(runId, rowId);
    const judgeCallsBefore = fakeJudge.calls.length;

    // 这一次评分判「一项都没达成」⇒ 分数变了就证明「重评真的跑了」
    fakeJudge.achieved = false;
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    followUpRow(runId, rowId, { text: '一句不产生改动的话' });
    await drainRunningTasks();

    const after = rowOf(runId, rowId);
    expect(after.status).toBe('judged');
    expect(fakeJudge.calls.length).toBe(judgeCallsBefore + 1);
    expect(after.diff).toEqual(before.diff);
    expect(after.score).not.toEqual(before.score);
  });

  /**
   * 竞态：「点了追问马上点终止」。`preparing` 那段让出事件循环的窗口里到达的 `abort`
   * 必须被**复检**接住——不复检就会继续走完这一趟、无条件落 `running`，把行从 `canceled` 复活，
   * 并写出第二条 `end`。
   */
  it('点了追问马上点终止：行停在 canceled（不被复活），候选一次都没跑', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const callsBefore = fakeAgents.calls.length;
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });

    const returned = followUpRow(runId, rowId, { text: '点了追问马上终止' });
    expect(returned.rows[0]?.status).toBe('preparing');
    abortRow(runId, rowId); // 同步落 canceled，而此刻追问任务还没走到 running
    expect(rowOf(runId, rowId).status).toBe('canceled');

    await drainRunningTasks();
    const after = rowOf(runId, rowId);
    expect(after.status).toBe('canceled');
    expect(fakeAgents.calls.length).toBe(callsBefore); // 适配器一次都没被启动
    expect(after.attempts).toBe(1); // 追问不是一次尝试
  });

  /**
   * 终止发生在追问**跑动中**时，累计耗时不许倒退：冻结值必须带上一段之前那一行的累计基数
   * （心跳的 `baseMs`）。不带基数时用户终止一次追问会把之前那几十分钟的耗时一起抹成这一段的秒数。
   */
  it('追问途中终止：累计耗时不倒退、事件流只多一条 end', async () => {
    const { runId, rowId } = await seedJudgedRow();
    const before = rowOf(runId, rowId);
    const endsBefore = readEvents(eventsOf(runId, rowId)).filter((event) => event.type === 'end').length;
    expect(before.durationMs).toBeGreaterThan(0);

    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    followUpRow(runId, rowId, { text: '跑动中把它停掉' });
    await until(() => rowOf(runId, rowId).status === 'running', '追问进入 running', TEST_TIMEOUT_MS);
    abortRow(runId, rowId);
    releaseAllAgents();
    await drainRunningTasks();

    const after = rowOf(runId, rowId);
    expect(after.status).toBe('canceled');
    expect(after.durationMs ?? 0).toBeGreaterThanOrEqual(before.durationMs ?? 0);
    expect(after.attempts).toBe(before.attempts);
    const endsAfter = readEvents(eventsOf(runId, rowId)).filter((event) => event.type === 'end');
    expect(endsAfter.length).toBe(endsBefore + 1);
  });
});

/**
 * `followUpAvailability`：界面入口的**读侧**。
 *
 * 它必须与 `followUpRow` 说同一句话——判据、顺序、文案全部来自契约的 `canFollowUpRow`，
 * 本层只负责把「这一行 + 此刻盘上的事实」拼起来。用例钉的就是这条**同源**：
 * 读侧说可行的行，真追问必须真的放行；读侧说不可行的行，真追问抛的就是同一句原因
 * （两处各写一份必然漂移，而漂移的表现是「按钮写着能追问、点下去 409」）。
 */
describe('followUpAvailability：读侧与写侧同源', { timeout: TEST_TIMEOUT_MS }, () => {
  /** 这一轮的读侧结论（按行 id 取；找不到即夹具自己错了） */
  function verdictOf(runId: string, rowId: string) {
    const rows = followUpAvailability(runId).rows;
    const found = rows.find((item) => item.rowId === rowId);
    if (found === undefined) throw new Error(`读侧没有这一行：${rowId}`);
    return found.verdict;
  }

  it('跑过的行 ⇒ 读侧说可行，真追问也放行（同一条判据）', async () => {
    const { runId, rowId } = await seedJudgedRow();
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    expect(verdictOf(runId, rowId)).toEqual({ ok: true });

    followUpRow(runId, rowId, { text: '接着干' });
    await drainRunningTasks();
    expect(rowOf(runId, rowId).followUps).toBe(1);
  });

  it('没跑过的行 ⇒ 读侧与真追问抛的是同一句话（那一档是「还没开始跑」，不是「接不上」）', () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel' });
    const rowId = run.rows[0]?.id ?? '';
    const verdict = verdictOf(run.id, rowId);
    expect(verdict.ok).toBe(false);
    const reason = verdict.ok ? '' : verdict.reason;
    // 指向输入区排队（而不是「没有可续接的会话 ⇒ 重新执行」）
    expect(reason).toContain('还没开始跑');
    expect(reason).toContain('排队');
    expect(refusalOf(run.id, rowId, { text: '还没跑过' })).toBe(reason);
  });

  it('工作区被删 / 用例被删 ⇒ 读侧当场看见（这两档在浏览器里本来就看不到）', async () => {
    const { runId, rowId, workspacePath } = await seedJudgedRow();
    rmSync(workspacePath, { recursive: true, force: true });
    const deleted = verdictOf(runId, rowId);
    expect(deleted.ok ? '' : deleted.reason).toContain('工作区已被删除');

    // 用例删掉之后是另一句（顺序上排在工区之后，故上面那条要先断言掉）
    const second = await seedJudgedRow();
    clearCases();
    const noCase = verdictOf(second.runId, second.rowId);
    expect(noCase.ok ? '' : noCase.reason).toContain('用例已删除');
  });

  it('正在跑的行 ⇒ 读侧说「此刻不是时机」，指向输入区排队', async () => {
    const { runId, rowId } = await seedJudgedRow();
    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    retryRow(runId, rowId);
    await until(() => rowOf(runId, rowId).status === 'running', '这一行进入 running', TEST_TIMEOUT_MS);

    const verdict = verdictOf(runId, rowId);
    expect(verdict.ok ? '' : verdict.reason).toContain('正在运行中');
    expect(verdict.ok ? '' : verdict.reason).toContain('排队');

    releaseAllAgents();
    await drainRunningTasks();
  });

  it('每一行都有一条结论（顺序即 `run.rows` 的顺序），且 `ok` 为真时不带原因', () => {
    const { run } = seedRunnableRun({ rowCount: 3, executionMode: 'parallel' });
    const availability = followUpAvailability(run.id);
    expect(availability.rows.map((item) => item.rowId)).toEqual(run.rows.map((row) => row.id));
    for (const { rowId, verdict } of availability.rows) {
      // 三行都还没跑过 ⇒ 每一行都得有一句能直接展示的原因（不是「false」，也不是空串）
      expect(verdict.ok ? null : verdict.reason).toContain('还没开始跑');
      expect(rowId).not.toBe('');
    }
  });
});

/**
 * **分叉被拒的恢复路径**：厂商拒绝是**确定性**的（CC 的 `Resume rejected by --resume-drops-turn:`），
 * 同一分叉请求再发一次永远失败。正确收场是「清目标 + 普通续接 + 保留证据」：
 *   · 第一趟带 `fork`（适配器真的把它交给了厂商）；
 *   · 拒绝被适配器报成 `AGENT_FORK_REJECTED` ⇒ 编排层**不再带 `fork`** 跑第二趟；
 *   · 拒绝原文与那一句「不重试分叉」留在事件流里。
 * 判据是两次 `run()` 的入参（`fork` 先有后无）与事件流——只看行状态的话，
 * 「恢复成功」与「本来就没带分叉」长得一模一样。
 */
it('回到某一轮被拒 ⇒ 不重试分叉、清目标改普通续接，并保留拒绝证据', async () => {
  const { runId, rowId } = await seedJudgedRow('codex', 'sess-fork');
  fakeAgents.scripts.set('codex', {
    mode: 'error',
    errorCode: 'AGENT_FORK_REJECTED',
    errorMessage: 'Resume rejected by --resume-drops-turn: discarded range contains a queued user message',
    sessionId: 'sess-fork',
  });
  const events: { type: string; text?: string }[] = [];
  const unsubscribe = subscribeRowEvents(runId, rowId, (event) => events.push(event as { type: string; text?: string }));
  // 恢复那一条事件一落盘，就把脚本切回正常：第二趟（不带 fork）因此跑得完
  const switchOnEvidence = subscribeRowEvents(runId, rowId, (event) => {
    if (event.type === 'log' && event.text.includes('回到某一轮被拒')) {
      fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-fork' });
    }
  });
  try {
    followUpRow(runId, rowId, {
      text: '从这一点重来',
      fork: { segment: 0, turn: 1, keepAt: 'entry-1', dropFrom: 'prompt-2' },
    });
    await drainRunningTasks();
    await until(
      () => rowOf(runId, rowId).status === 'judged',
      '被拒后普通续接回到 judged',
      TEST_TIMEOUT_MS,
      () => rowSettled(runId, rowId),
    );
  } finally {
    unsubscribe();
    switchOnEvidence();
  }
  const calls = fakeAgents.calls.slice(-2);
  expect(calls[0]?.fork).toMatchObject({ keepAt: 'entry-1' });
  expect(calls[1]?.fork).toBeUndefined();
  expect(events.some((event) => event.type === 'log' && event.text?.includes('不重试分叉'))).toBe(true);
});
