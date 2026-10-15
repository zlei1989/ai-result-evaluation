// @vitest-environment node
/**
 * 编排层接上人工消息面：**闸门**（没开 ⇒ 适配器一格都不挂）、**投递落账本 + 行快照的计数**、
 * **「队列非空 ⇒ 这一行先不收场」的等待预算**，以及**会话 id 落库与跨行串味的断言**。
 *
 * 这一组用例跑的是**真编排层 + 假适配器**：判据因此落在磁盘上的事实（`messages.jsonl` /
 * `events.jsonl` / `run.json`）与装配事实（`fakeAgents.calls` 里记下的入参）上，
 * 而不是落在某个内部标志上。
 *
 * 三条口径：
 *   1. **零回归的判据是「那个键在不在」**：`run.injectMessages === false` 时适配器收到的入参里
 *      **没有** `inject` 这一格——不是「有一个关着的端口」；
 *   2. **账本与计数同段代码**：真正交出去那一刻写账本、同时把行快照的「人工追问 ×N」加一，
 *      两处因此不会漂（漂了就是「卡片上的数与账本对不上」）；
 *   3. **等太久的收场与行收场是两件事**：前者说「等太久了」（`timed-out`），
 *      后者说「这一行已经结束了」（`discarded`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEvents, rowEventsFile } from '@aieval/core';
import { INJECT_WAIT, listInjectMessages, registerInjectMessage } from './inject-port';
import { resetInjectQueueForTesting } from './inject-queue';
import {
  drainRunningTasks,
  fakeAgents,
  getRun,
  PRODUCTION_ROW_RETRIES,
  registerOrchestratorHooks,
  ROW_RETRY,
  rowRecordsOf,
  saveRun,
  seedRunnableRun,
  startRun,
  TEST_TIMEOUT_MS,
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

/** 产品默认的等待预算（用例改小之前先读它，`afterEach` 还原） */
let productionBudgetMs = INJECT_WAIT.budgetMs;
let productionLeadMs = INJECT_WAIT.leadMs;

beforeEach(() => {
  resetInjectQueueForTesting();
  productionBudgetMs = INJECT_WAIT.budgetMs;
  productionLeadMs = INJECT_WAIT.leadMs;
});

afterEach(() => {
  resetInjectQueueForTesting();
  INJECT_WAIT.budgetMs = productionBudgetMs;
  INJECT_WAIT.leadMs = productionLeadMs;
});

/** 这一行在磁盘上的行级事件 */
function eventsOf(runId: string, rowId: string, workspaceBase: string) {
  return readEvents(rowEventsFile(workspaceBase, runId, rowId));
}

describe('闸门：没开 ⇒ 适配器一格都不挂', () => {
  it('`injectMessages` 关闭（缺省）时入参里没有 `inject` 那一格', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', {});
    startRun(run.id);
    await drainRunningTasks();

    expect(fakeAgents.calls[0]?.injectAttached).toBe(false);
    expect(fakeAgents.calls[0]?.injectAvailable).toBe(false);
  });

  it('开了闸门时适配器拿到一个 `available: true` 的端口', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', injectMessages: true });
    fakeAgents.scripts.set('codex', {});
    startRun(run.id);
    await drainRunningTasks();

    expect(fakeAgents.calls[0]?.injectAttached).toBe(true);
    expect(fakeAgents.calls[0]?.injectAvailable).toBe(true);
  });
});

describe('投递：账本与行快照的计数同段代码', () => {
  it('适配器取件并确认交付 ⇒ 账本里有一条 `origin: human` 的消息，快照的计数加一', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', injectMessages: true });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('codex', { injectDrain: 'idle', sessionId: 'sess-1' });
    registerInjectMessage({
      runId: run.id,
      rowId,
      messageId: 'm-1',
      text: '顺便把 changelog 也补上',
      attachments: [],
      requires: 'idle',
    });

    startRun(run.id);
    await drainRunningTasks();

    expect(fakeAgents.calls[0]?.injectDelivered).toEqual(['m-1']);
    // 只看人话那一条：账本首条是题面（我们自己落的记账消息，不是适配器取走的这一条）
    const human = rowRecordsOf(run.id, rowId).messages.filter((message) => message.origin === 'human');
    expect(human.map((message) => [message.messageId, message.role, message.origin]))
      .toEqual([['m-1', 'user', 'human']]);
    // 「N 与账本对齐」（不与队列表对齐）：账本里有一条，计数就是一
    expect(getRun(run.id).rows[0]?.followUps).toBe(1);
    // 「已送达」也有一条行级事件（与账本共用 `messageId`）：两处能互相追回
    const injectEvents = eventsOf(run.id, rowId, run.workspaceBase).filter((event) => event.type === 'inject-message');
    expect(injectEvents.map((event) => (event.type === 'inject-message' ? [event.messageId, event.outcome] : null)))
      .toEqual([['m-1', 'delivered']]);
    // 行落终态时**整行清表**（含已投递的）：这一行结束了，留着只会让下一轮读到上一轮的幽灵条目
    expect(listInjectMessages(run.id, rowId)).toEqual([]);
  });
});

describe('不收场边界：队列非空时先等这一批的预算', () => {
  it('适配器没取走 ⇒ 行停在 running 等预算；到点那一条落 gone + `timed-out` 事件，行照常收场', async () => {
    INJECT_WAIT.budgetMs = 1_500;
    INJECT_WAIT.leadMs = 0;
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial', injectMessages: true });
    const rowId = getRun(run.id).rows[0]!.id;
    // 适配器不取件（`injectDrain` 不给）⇒ 那一条一直留在队列里
    fakeAgents.scripts.set('codex', {});
    registerInjectMessage({ runId: run.id, rowId, messageId: 'm-1', text: '人话', attachments: [], requires: 'idle' });

    startRun(run.id);
    // 假适配器几毫秒就跑完了：这一刻行**必须**还活着（「队列非空 ⇒ 先不收场」）
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getRun(run.id).rows[0]?.status).toBe('running');
    expect(listInjectMessages(run.id, rowId)[0]?.state).toBe('queued');

    await drainRunningTasks();

    // 到点：那一条按「等太久了」丢弃（不是「行已结束」），行照常落 judged、表随之清空
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    expect(listInjectMessages(run.id, rowId)).toEqual([]);
    // 未投递的收场**不产生账本记录**（模型从来没看到过它），只有一条行级事件；
    // 账本里此刻只有题面那一条
    expect(rowRecordsOf(run.id, rowId).messages.map((message) => message.origin)).toEqual(['case-prompt']);
    const injectEvents = eventsOf(run.id, rowId, run.workspaceBase).filter((event) => event.type === 'inject-message');
    expect(injectEvents.map((event) => (event.type === 'inject-message' ? [event.messageId, event.outcome] : null)))
      .toEqual([['m-1', 'timed-out']]);
  }, TEST_TIMEOUT_MS);
});

describe('会话 id：落进行快照，且不许跨行串味', () => {
  it('适配器上报的 `sessionId` 落进这一行', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', { sessionId: 'sess-1' });
    startRun(run.id);
    await drainRunningTasks();

    expect(getRun(run.id).rows[0]?.sessionId).toBe('sess-1');
  });

  it('没采到 ⇒ 落 `null`（旧产物与新产物在这一格上同形：都不能追问）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    fakeAgents.scripts.set('codex', {});
    startRun(run.id);
    await drainRunningTasks();

    expect(getRun(run.id).rows[0]?.sessionId).toBeNull();
  });

  it('同一轮里同一个 id 出现在两行上 ⇒ SESSION_ID_SHARED（挡静默的行为污染）', async () => {
    const { run } = seedRunnableRun({ rowCount: 2, executionMode: 'serial' });
    const seeded = getRun(run.id);
    const [first, second] = seeded.rows;
    // 第一行已经带着这条会话（「上一次尝试留下的」形态）：第二行再报同一个 id 就是隔离漏了
    seeded.rows[0]!.sessionId = 'sess-shared';
    saveRun(seeded);
    fakeAgents.scripts.set('codex', { sessionId: 'sess-shared' });

    startRun(run.id);
    await drainRunningTasks();

    const rows = getRun(run.id).rows;
    // 第一行报的是它自己那条 ⇒ 不算串味，照常收场
    expect(rows.find((row) => row.id === first!.id)?.status).toBe('judged');
    const polluted = rows.find((row) => row.id === second!.id);
    expect(polluted?.status).toBe('failed');
    /**
     * 归因码是**这一格专属**的：`INTERNAL` 在 `TRANSIENT_ROW_RETRY_CODES` 里（文本评分通路的
     * 网络与 5xx 都折成它）⇒ 若沿用 `INTERNAL`，打开重试预算时这种行会被自动重跑，
     * 而「隔离漏了」重跑也不会好——只是把同一个失败延后 `3s × N`，还多一轮可能被污染的运行。
     */
    expect(polluted?.error?.code).toBe('SESSION_ID_SHARED');
    expect(polluted?.error?.message).toContain(first!.id);
  }, TEST_TIMEOUT_MS);

  it('隔离漏了**不自动重跑**：重试预算打开也不重跑（那个码不在瞬时表里）', async () => {
    const productionRetries = ROW_RETRY.maxRetries;
    const productionDelay = ROW_RETRY.delayMs;
    ROW_RETRY.maxRetries = PRODUCTION_ROW_RETRIES;
    ROW_RETRY.delayMs = 1;
    try {
      const { run } = seedRunnableRun({ rowCount: 2, executionMode: 'serial' });
      const seeded = getRun(run.id);
      const second = seeded.rows[1];
      // 第一行已经带着这条会话：第二行再报同一个 id 就是隔离漏了
      seeded.rows[0]!.sessionId = 'sess-shared';
      saveRun(seeded);
      fakeAgents.scripts.set('codex', { sessionId: 'sess-shared' });

      startRun(run.id);
      await drainRunningTasks();

      const polluted = getRun(run.id).rows.find((row) => row.id === second!.id);
      // 两条候选行各跑一次；第二行若被重跑，这里会变成 4（每一次尝试都会再报一次同一个 id）
      expect(fakeAgents.calls.filter((one) => one.kind === 'codex'), '隔离漏了不该重跑').toHaveLength(2);
      expect(polluted?.status).toBe('failed');
    } finally {
      ROW_RETRY.maxRetries = productionRetries;
      ROW_RETRY.delayMs = productionDelay;
    }
  }, TEST_TIMEOUT_MS);
});
