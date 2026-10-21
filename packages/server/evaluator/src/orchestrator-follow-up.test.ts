// @vitest-environment node
/**
 * `followUpCandidate`：对**已经跑过**的候选追问（接着同一段上下文再跑一段，不重建工作区、不重置会话）。
 *
 * 本文件钉的是这条路与「重新执行」(`retryCandidate`) 的**分界**：追问复用候选工作区与会话、
 * 计量累加、`attempts` 不变、跑完无条件重评；不可追问的每一档各给一句能直接展示的中文原因，
 * 且都不许静默从头跑（档位与文案的唯一真源是契约层的 `canFollowUpCandidate`，这里走真 provider
 * 把那几档各踩一遍）。
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortCandidate,
  adapterMessagesOf,
  clearCases,
  followUpAvailability,
  drainRunningTasks,
  existsSync,
  fakeAgents,
  fakeJudge,
  followUpCandidate,
  getRun,
  join,
  readEvents,
  registerOrchestratorHooks,
  releaseAllAgents,
  retryCandidate,
  rmSync,
  candidateEventsFile,
  candidateRecordsOf,
  candidateSettled,
  runCandidate,
  seedRunnableRun,
  ServiceError,
  TEST_TIMEOUT_MS,
  until,
  writeFileSync,
} from './testing/orchestrator-harness';
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
 * 跑完一行（追问的前置），并把那一候选的 `sessionId` 钉成一个具体 id。
 * 追问的全部价值都在「接回同一条会话」上，故夹具先把这条会话造出来。
 */
async function seedJudgedCandidate(
  agentKind: 'codex' | 'dsh' = 'codex',
  sessionId = 'sess-1',
  injectMessages = false,
): Promise<{ runId: string; candidateId: string; workspacePath: string }> {
  const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', agentKind, injectMessages });
  const candidateId = run.candidates[0]?.id ?? '';
  fakeAgents.scripts.set(agentKind, {
    mode: 'ok',
    files: [{ path: 'first.txt', content: '第一段\n' }],
    sessionId,
    // 钉一个具体读数：夹具的墙钟只有几毫秒，而「累计耗时不倒退」那一条要的是一个**有分量的基数**
    durationMs: 600_000,
  });
  await runCandidate(run.id, candidateId);
  const candidate = candidateOf(run.id, candidateId);
  expect(candidate.status).toBe('judged');
  expect(candidate.sessionId).toBe(sessionId);
  return { runId: run.id, candidateId, workspacePath: candidate.workspacePath };
}

/** 这个候选的快照（找不到即抛：用例里的候选 id 都来自夹具，找不到就是夹具自己错了） */
function candidateOf(runId: string, candidateId: string) {
  const candidate = getRun(runId).candidates.find((item) => item.id === candidateId);
  if (candidate === undefined) throw new Error(`夹具里没有这个候选：${candidateId}`);
  return candidate;
}

/** 该候选的事件日志路径（候选目录按这一轮自己记录的 `workspaceBase` 解析） */
function eventsOf(runId: string, candidateId: string): string {
  return candidateEventsFile(getRun(runId).workspaceBase, runId, candidateId);
}

/** 被拒的中文原因（`followUpCandidate` 拒绝时抛 `CONFLICT`；放行即用例失败） */
function refusalOf(runId: string, candidateId: string, input: Parameters<typeof followUpCandidate>[2]): string {
  try {
    followUpCandidate(runId, candidateId, input);
  } catch (error) {
    if (error instanceof ServiceError) return error.message;
    throw error;
  }
  throw new Error('本该拒绝，却放行了');
}

/**
 * 拒绝之后这个候选必须**一字未动**——状态、分数、尝试次数，以及「候选有没有被再跑一次」。
 * 这是「都不许静默从头跑」这句话在用例里的形状：放行一次就是一次几分钟的从头重跑。
 */
function expectCandidateUntouched(
  runId: string,
  candidateId: string,
  before: { status: string; score: unknown; attempts: number | undefined },
  callsBefore: number,
): void {
  const candidate = candidateOf(runId, candidateId);
  expect(candidate.status).toBe(before.status);
  expect(candidate.score).toEqual(before.score);
  expect(candidate.attempts).toBe(before.attempts);
  expect(fakeAgents.calls.length).toBe(callsBefore);
}

describe('followUpCandidate：追问复用候选工作区与会话', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **行为判据（主）**：候选工作区里那个哨兵文件在追问之后必须还在。
   * 它会随 `prepareCandidateWorkspace → resetCandidateDir → clearCandidateArtifacts` 一起消失——
   * 而「工作区被重建」正是「追问接到了 `retryCandidate` 上」的症状，也是「智能体什么都不记得了」的成因。
   * 同一轮里另钉两格：`resume` 带的是候选快照里那个会话 id、`cwd` 还是原来那个目录。
   */
  it('追问复用同一个工作区与会话：哨兵文件还在、resume 带的是候选快照里的会话 id', async () => {
    const { runId, candidateId, workspacePath } = await seedJudgedCandidate('codex', 'sess-keep');
    const sentinel = join(workspacePath, 'sentinel.txt');
    writeFileSync(sentinel, '哨兵：工作区被重建就会消失\n', 'utf8');
    const callsBefore = fakeAgents.calls.length;

    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-keep' });
    const returned = followUpCandidate(runId, candidateId, { text: '接着把第二段也写了' });
    // 同步返回「已经在准备中」的快照（HTTP 立刻拿到，不挂在请求上等分钟级）
    expect(returned.candidates[0]?.status).toBe('preparing');

    await drainRunningTasks();
    await until(
      () => candidateOf(runId, candidateId).status === 'judged',
      '追问后回到 judged',
      TEST_TIMEOUT_MS,
      () => candidateSettled(runId, candidateId),
    );

    const after = candidateOf(runId, candidateId);
    expect(after.status).toBe('judged');
    // 工作区没被重建：路径没变、哨兵文件还在
    expect(after.workspacePath).toBe(workspacePath);
    expect(existsSync(sentinel), '追问不许重建工作区（工作区被重建就会连带删掉会话）').toBe(true);
    // 候选真的又跑了一次，且这一次是**接着那条会话**跑的
    expect(fakeAgents.calls.length).toBe(callsBefore + 1);
    const call = fakeAgents.calls.at(-1);
    expect(call?.resumeSessionId).toBe('sess-keep');
    expect(call?.cwd).toBe(workspacePath);
    expect(call?.prompt).toContain('接着把第二段也写了');
    expect(after.sessionId).toBe('sess-keep');
  });

  /**
   * 那一句人话要落**两处**：消息账本（`origin: 'human'`，复盘时与题面分得开）与候选级事件
   * （日志抽屉里看得见）。两处都在「真的要交给厂商」那一拍写下去。
   *
   * 这一条同时钉住 **`segment` 那一格**：追问是又开一次 `run()`，厂商轮次从 1 重新数 ⇒
   * 两段的 `mergeKey` 会逐字相同，读侧折叠靠 `(segment, mergeKey)` 才分得开；段号同时是界面上
   * 「追问 ×N」那一段的界碑。整段（含适配器交出来的消息）都要带同一个段号。
   */
  it('追问落账本与候选级事件：那句人话两处都看得到，且这一段的每条消息都带段号', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', messages: [{ text: '追问那一段的答复' }] });
    followUpCandidate(runId, candidateId, { text: '这一句必须能在日志里看到' });
    await drainRunningTasks();

    const texts = readEvents(eventsOf(runId, candidateId))
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(texts).toContain('这一句必须能在日志里看到');

    const human = candidateRecordsOf(runId, candidateId).messages.filter((message) => message.origin === 'human');
    expect(human.map((message) => message.role)).toEqual(['user']);
    expect(
      human.some((message) =>
        message.blocks.some((block) => block.type === 'text' && block.text === '这一句必须能在日志里看到'),
      ),
    ).toBe(true);

    // 段号：人话那一条与适配器交出来的那一条都是 1（第 1 次追问那一段）
    expect(human.map((message) => message.segment)).toEqual([1]);
    const adapter = adapterMessagesOf(runId, candidateId);
    expect(adapter).not.toEqual([]);
    expect(adapter.every((message) => message.segment === 1)).toBe(true);
    // 首段那条题面仍是缺席 = 0（段号只在追问那一侧写）：判据取 `role: 'user'`，
    // 光看 `origin` 分不开——适配器投出来的消息那一格默认也是 `case-prompt`
    const casePrompt = candidateRecordsOf(runId, candidateId).messages.filter(
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
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const runId = run.id;
    const candidateId = run.candidates[0]?.id ?? '';
    // 首段也要真的投一条消息：两边同号（都是第 1 轮、都是 assistant）才测得到那个撞键
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', messages: [{ text: '首段的第 1 轮' }] });
    await runCandidate(runId, candidateId);

    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', messages: [{ text: '追问那一段的第 1 轮' }] });
    followUpCandidate(runId, candidateId, { text: '再说一句' });
    await drainRunningTasks();

    const firstSegment = adapterMessagesOf(runId, candidateId).filter((message) => message.segment === undefined);
    const secondSegment = adapterMessagesOf(runId, candidateId).filter((message) => message.segment === 1);
    // 两段那一条的载体键**逐字相同**，靠段号才分得开（折叠键 = 段号 + 载体键）
    expect(firstSegment.map((message) => message.mergeKey)).toEqual(['main|1|assistant|-']);
    expect(secondSegment.map((message) => message.mergeKey)).toEqual(['main|1|assistant|-']);
    expect(firstSegment.map((message) => (message.blocks[0] as { text: string }).text)).toEqual(['首段的第 1 轮']);
    expect(secondSegment.map((message) => (message.blocks[0] as { text: string }).text)).toEqual(['追问那一段的第 1 轮']);
  });
});

describe('followUpCandidate：注入面（追问这一段行在跑，人就能往这一轮送话）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('闸门开着 ⇒ 适配器拿到端口，队列里那条投出去、落账本、计数与账本对齐', async () => {
    const { runId, candidateId } = await seedJudgedCandidate('codex', 'sess-1', true);
    registerInjectMessage({
      runId,
      candidateId,
      messageId: 'm-2',
      text: '追问这一段里补的一句',
      attachments: [],
      requires: 'idle',
    });
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', injectDrain: 'idle' });

    followUpCandidate(runId, candidateId, { text: '先接着干' });
    await drainRunningTasks();

    const call = fakeAgents.calls.at(-1);
    expect(call?.injectAttached).toBe(true);
    expect(call?.injectAvailable).toBe(true);
    expect(call?.injectDelivered).toEqual(['m-2']);
    const { messages } = candidateRecordsOf(runId, candidateId);
    // 两句话都在账本里、都是人话：追问那一句与队列里那一条（同一把钥匙各追各的）
    expect(messages.filter((message) => message.origin === 'human')).toHaveLength(2);
    const candidate = candidateOf(runId, candidateId);
    expect(candidate.followUps).toBe(2);
    // 这个候选只被追问过 1 次：账本那两条里有一条是**队列里送进去的**，不是追问
    expect(candidate.followUpRounds).toBe(1);
  });

  /**
   * **两个读数各归各的**（`followUps` 数已送达的人话、`followUpRounds` 数追问轮次）。
   *
   * 场景就是这一格兼两义时会出错的那个：「先有 2 条注入、再追问 1 次」。
   *   · 账本里此刻有 **3** 条 `origin: human`（两条注入 + 这一句追问）⇒ 卡片那个读数就是 3；
   *   · 而这个候选只被**追问过 1 次** ⇒ 日志里那句 `[人工追问 ×N]` 必须说 1。
   * 拿账本条数当「第几次追问」的话，这里会写成 3——用户读到的是三次追问，其中两次根本不存在。
   *
   * 这一条是那组 3 / 1 的**写侧那一端**：卡片读 `followUps`（总数 3）由
   * `@aieval/ui` 的 `eval-candidate-card.test.tsx`「卡片显示的是人工消息总数（3），不是追问轮次（1）」钉，
   * 两个读数在**同一个场景**里取值不同 ⇒ 哪一端读错格都有一处红。
   */
  it('两个读数各归各的：注入只加送达计数，追问只加轮次（日志里那句「第几次」读轮次）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', injectMessages: true });
    const candidateId = run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1', injectDrain: 'idle', durationMs: 600_000 });
    for (const messageId of ['m-inject-1', 'm-inject-2']) {
      registerInjectMessage({ runId: run.id, candidateId, messageId, text: `${messageId} 的人话`, attachments: [], requires: 'idle' });
    }
    await runCandidate(run.id, candidateId);

    // 第一条路：两条注入送达 ⇒ 只推进「已送达的人话」那一格，轮次纹丝不动
    const afterInject = candidateOf(run.id, candidateId);
    expect(afterInject.followUps).toBe(2);
    expect(afterInject.followUpRounds).toBe(0);

    // 第二条路：追问一次 ⇒ 账本多一条人话（读数 3），轮次只加一
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    followUpCandidate(run.id, candidateId, { text: '这是第一次追问' });
    await drainRunningTasks();

    const { messages } = candidateRecordsOf(run.id, candidateId);
    expect(messages.filter((message) => message.origin === 'human')).toHaveLength(3);
    const after = candidateOf(run.id, candidateId);
    expect(after.followUps).toBe(3);
    expect(after.followUpRounds).toBe(1);

    const logText = readEvents(eventsOf(run.id, candidateId))
      .filter((event) => event.type === 'log')
      .map((event) => (event.type === 'log' ? event.text : ''))
      .join('\n');
    expect(logText).toContain('[人工追问 ×1]');
    expect(logText).not.toContain('[人工追问 ×3]');
  });

  it('闸门关着（缺省）⇒ 追问这一段的入参里没有 `inject` 那一格（零回归判据）', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    followUpCandidate(runId, candidateId, { text: '闸门没开' });
    await drainRunningTasks();
    expect(fakeAgents.calls.at(-1)?.injectAttached).toBe(false);
    expect(fakeAgents.calls.at(-1)?.injectAvailable).toBe(false);
  });
});

describe('followUpCandidate：逐档拒绝，一条都不许静默从头跑', { timeout: TEST_TIMEOUT_MS }, () => {
  it('① 还没跑过的候选与正在跑的候选同一档（去输入区排队），不是「接不上」', () => {
    // `pending` 的候选连会话都还没有，但它的处置是「等这一轮跑完」而不是「重新执行」：
    // 落进「没有可续接的会话」那一档会把用户引向一次从头重跑
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    const before = candidateOf(run.id, candidateId);
    expect(before.status).toBe('pending');
    expect(before.sessionId).toBeNull();
    const reason = refusalOf(run.id, candidateId, { text: '还没跑过就想追问' });
    expect(reason).toContain('还没开始跑');
    expect(reason).toContain('排队');
    expect(reason).not.toContain('重新执行');
    expectCandidateUntouched(run.id, candidateId, before, 0);
  });

  it('③ 跑过但没采到会话 id ⇒ 拒绝，且候选一次都没跑', async () => {
    // 形态：**跑过**（工作区在盘上）、但适配器没交回会话 id（旧产物就是这一档）——
    // 这一档只有③能拦：工作区检查放它过去，而放行它就会「从头再跑一遍」
    const judged = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const judgedCandidateId = judged.run.candidates[0]?.id ?? '';
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: null });
    await runCandidate(judged.run.id, judgedCandidateId);
    const judgedBefore = candidateOf(judged.run.id, judgedCandidateId);
    expect(judgedBefore.status).toBe('judged');
    expect(judgedBefore.sessionId).toBeNull();
    expect(existsSync(judgedBefore.workspacePath)).toBe(true);
    const callsBefore = fakeAgents.calls.length;
    expect(refusalOf(judged.run.id, judgedCandidateId, { text: '跑过但没采到会话' })).toContain('没有可续接的会话');
    expectCandidateUntouched(judged.run.id, judgedCandidateId, judgedBefore, callsBefore);
  });

  it('② 工作区已被删除 ⇒ 拒绝（追问要在原工作区上继续）', async () => {
    const { runId, candidateId, workspacePath } = await seedJudgedCandidate();
    const before = candidateOf(runId, candidateId);
    const callsBefore = fakeAgents.calls.length;
    rmSync(workspacePath, { recursive: true, force: true });

    expect(refusalOf(runId, candidateId, { text: '工作区没了还追问' })).toContain('工作区已被删除');
    expectCandidateUntouched(runId, candidateId, before, callsBefore);
  });

  it('③ 用例已删除 ⇒ 拒绝', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    const before = candidateOf(runId, candidateId);
    const callsBefore = fakeAgents.calls.length;
    clearCases();

    expect(refusalOf(runId, candidateId, { text: '用例没了还追问' })).toContain('用例已删除');
    expectCandidateUntouched(runId, candidateId, before, callsBefore);
  });

  it('④ 追问带了附件、而附件根不存在 ⇒ 拒绝（点名要重新上传）', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    const before = candidateOf(runId, candidateId);
    const callsBefore = fakeAgents.calls.length;

    const message = refusalOf(runId, candidateId, {
      text: '带一张图',
      attachments: [{ kind: 'image', path: '/nowhere/gone.png', mimeType: 'image/png' }],
    });
    expect(message).toContain('附件根不存在');
    expect(message).toContain('重新上传');
    expectCandidateUntouched(runId, candidateId, before, callsBefore);
  });

  it('⑤ dsh 声明支持续接 ⇒ 放行，且 resume 带的是候选快照里那条会话（声明接错了这条会红）', async () => {
    const { runId, candidateId } = await seedJudgedCandidate('dsh', 'sess-dsh');
    const callsBefore = fakeAgents.calls.length;
    fakeAgents.scripts.set('dsh', { mode: 'ok', sessionId: 'sess-dsh' });

    // 读侧与写侧同一份判据：读侧说可行，写侧就必须放行（否则就是「界面说能点、点下去 409」）
    expect(followUpAvailability(runId).candidates[0]?.verdict).toEqual({ ok: true });

    followUpCandidate(runId, candidateId, { text: '接着上次那段说' });
    await drainRunningTasks();
    await until(
      () => candidateOf(runId, candidateId).status === 'judged',
      '追问后回到 judged',
      TEST_TIMEOUT_MS,
      () => candidateSettled(runId, candidateId),
    );

    expect(fakeAgents.calls.length).toBe(callsBefore + 1);
    expect(fakeAgents.calls.at(-1)?.resumeSessionId).toBe('sess-dsh');
  });

  it('在跑的候选走「输入区排队」那条路：明确拒绝，并指向排队', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    const callsBefore = fakeAgents.calls.length;
    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    // 已经出分的候选要走 `retryCandidate`（`runCandidate` 对 `judged` 直接返回：它只挑可执行的候选）
    retryCandidate(runId, candidateId);
    await until(() => candidateOf(runId, candidateId).status === 'running', '这个候选进入 running', TEST_TIMEOUT_MS);

    const message = refusalOf(runId, candidateId, { text: '它还在跑' });
    expect(message).toContain('正在运行中');
    expect(message).toContain('排队');
    expect(fakeAgents.calls.length).toBe(callsBefore + 1); // 只有上面那次 retryCandidate 起的候选

    releaseAllAgents();
    await drainRunningTasks();
  });

  it('上一次运行还没收尾（已落终态、任务还在）⇒ 拒绝，不与迟到的旧任务抢状态', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    retryCandidate(runId, candidateId);
    await until(() => candidateOf(runId, candidateId).status === 'running', '这个候选进入 running', TEST_TIMEOUT_MS);

    // 终止是**同步**落状态的：这一刻行已是 canceled，而任务还在（candidateAborts 里那个条目还在）
    abortCandidate(runId, candidateId);
    expect(candidateOf(runId, candidateId).status).toBe('canceled');
    expect(refusalOf(runId, candidateId, { text: '旧任务还没收尾' })).toContain('还没收尾');

    releaseAllAgents();
    await drainRunningTasks();
  });
});

describe('followUpCandidate：计量累加、attempts 不变、跑完无条件重评', { timeout: TEST_TIMEOUT_MS }, () => {
  /**
   * **口径（与 `runCandidate` 相反、不可互换）**：`runCandidate` 那五格是「本次尝试的产出」（清零是对的），
   * 追问那五格是「这个候选的累计产出」（累加是对的）。`attempts` 则**不变**——它答的是
   * 「这个候选走过几次尝试」，而追问没有「从头」。
   */
  it('计量在候选原有读数上相加：tokens / turns / durationMs 累加，attempts 一字不动', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    const before = candidateOf(runId, candidateId);
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
    followUpCandidate(runId, candidateId, { text: '再来一段' });
    await drainRunningTasks();

    const after = candidateOf(runId, candidateId);
    expect(after.tokens).toEqual({
      input: (tokensBefore?.input ?? 0) + 100,
      cached: (tokensBefore?.cached ?? 0) + 5,
      output: (tokensBefore?.output ?? 0) + 50,
    });
    expect(after.turns).toBe((before.turns ?? 0) + 3);
    expect(after.durationMs).toBe((before.durationMs ?? 0) + 7_000);
    // 追问不算新一次尝试
    expect(after.attempts).toBe(before.attempts);
    // 卡片上的「人工追问 ×N」：计数与那条候选级事件在同一段代码里发生
    expect(after.followUps).toBe(1);
  });

  /**
   * **无条件重评**：不改成「只在 diff 有变化时重评」。这一条故意让追问**什么都不改**
   * （脚本不写文件 ⇒ diff 摘要与追问之前逐格相同），而分数必须被新的一次评分覆盖——
   * 「有改动才重评」那种实现会在这里红。
   */
  it('跑完无条件重评：diff 一格没变，分数照样被新的一次评分覆盖', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    const before = candidateOf(runId, candidateId);
    const judgeCallsBefore = fakeJudge.calls.length;

    // 这一次评分判「一项都没达成」⇒ 分数变了就证明「重评真的跑了」
    fakeJudge.achieved = false;
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    followUpCandidate(runId, candidateId, { text: '一句不产生改动的话' });
    await drainRunningTasks();

    const after = candidateOf(runId, candidateId);
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
    const { runId, candidateId } = await seedJudgedCandidate();
    const callsBefore = fakeAgents.calls.length;
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });

    const returned = followUpCandidate(runId, candidateId, { text: '点了追问马上终止' });
    expect(returned.candidates[0]?.status).toBe('preparing');
    abortCandidate(runId, candidateId); // 同步落 canceled，而此刻追问任务还没走到 running
    expect(candidateOf(runId, candidateId).status).toBe('canceled');

    await drainRunningTasks();
    const after = candidateOf(runId, candidateId);
    expect(after.status).toBe('canceled');
    expect(fakeAgents.calls.length).toBe(callsBefore); // 适配器一次都没被启动
    expect(after.attempts).toBe(1); // 追问不是一次尝试
  });

  /**
   * 终止发生在追问**跑动中**时，累计耗时不许倒退：冻结值必须带上一段之前那一候选的累计基数
   * （心跳的 `baseMs`）。不带基数时用户终止一次追问会把之前那几十分钟的耗时一起抹成这一段的秒数。
   */
  it('追问途中终止：累计耗时不倒退、事件流只多一条 end', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    const before = candidateOf(runId, candidateId);
    const endsBefore = readEvents(eventsOf(runId, candidateId)).filter((event) => event.type === 'end').length;
    expect(before.durationMs).toBeGreaterThan(0);

    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    followUpCandidate(runId, candidateId, { text: '跑动中把它停掉' });
    await until(() => candidateOf(runId, candidateId).status === 'running', '追问进入 running', TEST_TIMEOUT_MS);
    abortCandidate(runId, candidateId);
    releaseAllAgents();
    await drainRunningTasks();

    const after = candidateOf(runId, candidateId);
    expect(after.status).toBe('canceled');
    expect(after.durationMs ?? 0).toBeGreaterThanOrEqual(before.durationMs ?? 0);
    expect(after.attempts).toBe(before.attempts);
    const endsAfter = readEvents(eventsOf(runId, candidateId)).filter((event) => event.type === 'end');
    expect(endsAfter.length).toBe(endsBefore + 1);
  });
});

/**
 * `followUpAvailability`：界面入口的**读侧**。
 *
 * 它必须与 `followUpCandidate` 说同一句话——判据、顺序、文案全部来自契约的 `canFollowUpCandidate`，
 * 本层只负责把「这个候选 + 此刻盘上的事实」拼起来。用例钉的就是这条**同源**：
 * 读侧说可行的候选，真追问必须真的放行；读侧说不可行的候选，真追问抛的就是同一句原因
 * （两处各写一份必然漂移，而漂移的表现是「按钮写着能追问、点下去 409」）。
 */
describe('followUpAvailability：读侧与写侧同源', { timeout: TEST_TIMEOUT_MS }, () => {
  /** 这一轮的读侧结论（按候选 id 取；找不到即夹具自己错了） */
  function verdictOf(runId: string, candidateId: string) {
    const candidates = followUpAvailability(runId).candidates;
    const found = candidates.find((item) => item.candidateId === candidateId);
    if (found === undefined) throw new Error(`读侧没有这个候选：${candidateId}`);
    return found.verdict;
  }

  it('跑过的候选 ⇒ 读侧说可行，真追问也放行（同一条判据）', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-1' });
    expect(verdictOf(runId, candidateId)).toEqual({ ok: true });

    followUpCandidate(runId, candidateId, { text: '接着干' });
    await drainRunningTasks();
    expect(candidateOf(runId, candidateId).followUps).toBe(1);
  });

  it('没跑过的候选 ⇒ 读侧与真追问抛的是同一句话（那一档是「还没开始跑」，不是「接不上」）', () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    const candidateId = run.candidates[0]?.id ?? '';
    const verdict = verdictOf(run.id, candidateId);
    expect(verdict.ok).toBe(false);
    const reason = verdict.ok ? '' : verdict.reason;
    // 指向输入区排队（而不是「没有可续接的会话 ⇒ 重新执行」）
    expect(reason).toContain('还没开始跑');
    expect(reason).toContain('排队');
    expect(refusalOf(run.id, candidateId, { text: '还没跑过' })).toBe(reason);
  });

  it('工作区被删 / 用例被删 ⇒ 读侧当场看见（这两档在浏览器里本来就看不到）', async () => {
    const { runId, candidateId, workspacePath } = await seedJudgedCandidate();
    rmSync(workspacePath, { recursive: true, force: true });
    const deleted = verdictOf(runId, candidateId);
    expect(deleted.ok ? '' : deleted.reason).toContain('工作区已被删除');

    // 用例删掉之后是另一句（顺序上排在工区之后，故上面那条要先断言掉）
    const second = await seedJudgedCandidate();
    clearCases();
    const noCase = verdictOf(second.runId, second.candidateId);
    expect(noCase.ok ? '' : noCase.reason).toContain('用例已删除');
  });

  it('正在跑的候选 ⇒ 读侧说「此刻不是时机」，指向输入区排队', async () => {
    const { runId, candidateId } = await seedJudgedCandidate();
    fakeAgents.scripts.set('codex', { mode: 'gate', sessionId: 'sess-1' });
    retryCandidate(runId, candidateId);
    await until(() => candidateOf(runId, candidateId).status === 'running', '这个候选进入 running', TEST_TIMEOUT_MS);

    const verdict = verdictOf(runId, candidateId);
    expect(verdict.ok ? '' : verdict.reason).toContain('正在运行中');
    expect(verdict.ok ? '' : verdict.reason).toContain('排队');

    releaseAllAgents();
    await drainRunningTasks();
  });

  it('每个候选都有一条结论（顺序即 `run.candidates` 的顺序），且 `ok` 为真时不带原因', () => {
    const { run } = seedRunnableRun({ candidateCount: 3, executionMode: 'parallel' });
    const availability = followUpAvailability(run.id);
    expect(availability.candidates.map((item) => item.candidateId)).toEqual(run.candidates.map((candidate) => candidate.id));
    for (const { candidateId, verdict } of availability.candidates) {
      // 三个候选都还没跑过 ⇒ 每个候选都得有一句能直接展示的原因（不是「false」，也不是空串）
      expect(verdict.ok ? null : verdict.reason).toContain('还没开始跑');
      expect(candidateId).not.toBe('');
    }
  });
});
