// @vitest-environment node
/**
 * 消息与子任务行的落盘：**适配器交出内容，编排层负责让它落进唯一真相源**。
 *
 * 这一层要钉住三件事（都是「接线」而不是「算法」）：
 *   ① 适配器的 `onMessage` / `onSubagent` 真的被接上了：跑完一行之后 `messages.jsonl` 里有那条内容；
 *   ② 消息与子任务行**共用一个文件**，读侧按 `mergeKey` / `subagentId` 覆盖累积；
 *   ③ 重跑同一行时记录日志与事件日志**同一条清空口径**（两次尝试的对话不混在一起）。
 *
 * 覆盖累积本身（折叠算法）由 `@aieval/core` 的用例钉住，这里只验证「编排层交出去的就是那一条」
 * ——两层的责任分开，红了能一眼看出是哪一层。
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import type { AgentMessage, RowRecord } from '@aieval/contracts';
import { readRowRecords } from '@aieval/core';
import { broadcastJudgeMessage, publishJudgeMessage, subscribeJudgeRecords, subscribeRowRecords } from './row-messages';
import {
  drainRunningTasks,
  existsSync,
  fakeAgents,
  getRun,
  judgeReplyJson,
  recordsFileOf,
  registerOrchestratorHooks,
  rowRecordsOf,
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

describe('消息落盘：适配器交出的内容进 messages.jsonl', { timeout: TEST_TIMEOUT_MS }, () => {
  it('一条消息一条记录，信封里的 `mergeKey` / `messageId` / `assembly` 都在', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('codex', { messages: [{ text: '我先看一下配置文件。' }] });

    startRun(run.id);
    await drainRunningTasks();

    expect(existsSync(recordsFileOf(run.id, rowId))).toBe(true);
    const { messages } = rowRecordsOf(run.id, rowId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      chunk: 'snapshot',
      assembly: 'snapshot',
      mergeKey: 'main|1|assistant|-',
      blocks: [{ type: 'text', text: '我先看一下配置文件。' }],
    });
    // `messageId` 与厂商 id 解耦（本项目生成），但必须是**非空字符串**——它是去重键
    expect(typeof messages[0]?.messageId).toBe('string');
    expect(messages[0]?.messageId).not.toBe('');
  });

  it('同一 `mergeKey` 的后到一条覆盖先到一条，最终视图每条逻辑消息只剩一条', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('codex', {
      messages: [
        { text: '我先看' },
        { text: '我先看一下配置文件。' },
        // 换一次往返 ⇒ `mergeKey` 不同 ⇒ 它是**另一条**逻辑消息（不是覆盖）
        { text: '然后动手。', roundTrip: 2 },
      ],
    });

    startRun(run.id);
    await drainRunningTasks();

    const { messages } = rowRecordsOf(run.id, rowId);
    expect(messages.map((message) => (message.blocks[0] as { text: string }).text)).toEqual([
      '我先看一下配置文件。',
      '然后动手。',
    ]);
    expect(messages.map((message) => message.mergeKey)).toEqual(['main|1|assistant|-', 'main|2|assistant|-']);
  });

  it('子任务行与消息**共用一个文件**：按 `subagentId` 覆盖累积成派发视图的一行', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('codex', {
      messages: [{ text: '派一个子智能体去查。' }, { text: '子智能体回了这个。', subagentId: 'call_Task' }],
      subagents: [
        { subagentId: 'call_Task', name: '查配置' },
        { subagentId: 'call_Task', name: '查配置', status: 'completed' },
      ],
    });

    startRun(run.id);
    await drainRunningTasks();

    const { messages, subagents } = rowRecordsOf(run.id, rowId);
    // 子智能体自己的消息带身份（归属靠 `subagentId`，不是靠猜测）
    expect(messages.map((message) => message.subagentId)).toEqual([null, 'call_Task']);
    // 两行记录（派发 + 收场）折叠成一行，且留的是**收场**那条（完整快照）
    expect(subagents).toHaveLength(1);
    expect(subagents[0]).toMatchObject({ subagentId: 'call_Task', name: '查配置', status: 'completed' });
  });

  it('适配器一条都不给时不产生文件（读侧因此不必区分「空」与「没有」）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    const rowId = getRun(run.id).rows[0]!.id;
    // 默认脚本没有任何 messages / subagents
    startRun(run.id);
    await drainRunningTasks();

    expect(existsSync(recordsFileOf(run.id, rowId))).toBe(false);
    expect(rowRecordsOf(run.id, rowId)).toEqual({ messages: [], subagents: [] });
  });

  it('delta 只广播不落盘：文件里只有快照，实时订阅者两条都收到（三家统一口径）', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('codex', {
      messages: [
        { text: '我先看', chunk: 'delta' },
        { text: '我先看一下配置文件。' },
        // 第二轮只给 delta（模拟被中断的块：永远等不到快照）
        { text: '然后动手。', roundTrip: 2, chunk: 'delta' },
      ],
    });

    // 实时订阅先挂上再起跑：广播只发给「当时在线」的订阅者，晚了就收不到
    const broadcast: RowRecord[] = [];
    const unsubscribe = subscribeRowRecords(run.id, rowId, (record) => broadcast.push(record));
    try {
      startRun(run.id);
      await drainRunningTasks();
    } finally {
      unsubscribe();
    }

    // 落盘侧：delta 一条都不进 `messages.jsonl`，文件里只有那条快照
    const { messages } = rowRecordsOf(run.id, rowId);
    expect(messages.map((message) => (message.blocks[0] as { text: string }).text)).toEqual(['我先看一下配置文件。']);
    expect(messages.every((message) => message.chunk === 'snapshot')).toBe(true);
    // 实时侧：三条全到（两条 delta + 一条快照）——打字机效果靠的就是这一路
    expect(
      broadcast.filter((record) => record.type === 'message').map((record) => record.message.chunk),
    ).toEqual(['delta', 'snapshot', 'delta']);
    /**
     * 观测格：增量帧不落盘 ⇒ 「这次到底有没有收到逐字流」事后只剩这一格。
     * 两帧、末帧是那条**中断的** delta（`然后动手。` = 5 字）——它正是「刷新后看不到半截正文、
     * 但至少知道写到哪」的那个数（`lastFrameChars` 的口径就是最后一帧的累积正文长度）。
     */
    expect(getRun(run.id).rows[0]?.streamingDelta).toEqual({ frameCount: 2, lastFrameChars: 5 });
  });
});

/**
 * 评分阶段的两份产物（用户口径「评分与执行日志分开」）：
 * 评审者是**另一个会话**，它的消息落在 `judge-messages.jsonl`，候选那条流一个字都不许混进来。
 *
 * 三条判据各有靶子：
 *   ① 评分那条真的进自己的文件（接线断了的表现是「评审者在卡片上什么都不说」）；
 *   ② 候选那条**不被污染**（混进来的症状是「执行日志里冒出评审者的对话」）；
 *   ③ 两条流的**订阅表分开**（实时侧同一条不变量：订阅执行日志的人不该收到评审者的增量）。
 */
describe('评分产物走独立文件', { timeout: TEST_TIMEOUT_MS }, () => {
  /** 评分那条消息文件的绝对路径（与候选同目录，文件名不同） */
  const judgeRecordsFileOf = (runId: string, rowId: string): string =>
    join(dirname(recordsFileOf(runId, rowId)), 'judge-messages.jsonl');

  /** 造一条评分消息：只给本用例关心的那几格，其余按契约的「没有」填（`null` = 未采集） */
  const judgeMessage = (chunk: 'delta' | 'snapshot', text: string): AgentMessage => ({
    messageId: 'judge-1',
    vendorId: null,
    role: 'assistant',
    source: 'wire',
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk,
    assembly: chunk === 'delta' ? 'open' : 'snapshot',
    mergeKey: 'judge|1|assistant|-',
    blocks: [{ type: 'text', text }],
    raw: null,
  });

  it('评审者的消息进 judge-messages.jsonl，候选那条流不被污染', async () => {
    // 两家分开配：夹具按 `kind` 索引脚本，于是**能分阶段驱动**（候选 codex / 评审者 claude-code），
    // 两条流的内容因此可以不同——「各进各的文件」这条判据才有区分力。
    // 评审者必须是吃 anthropic 的那家：harness 给评分配的供应商是 anthropic（协议不匹配会让这一行直接失败）
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'serial',
      useAgentJudge: true,
      judgeAgentKind: 'claude-code',
    });
    const rowId = getRun(run.id).rows[0]!.id;
    fakeAgents.scripts.set('codex', { messages: [{ text: '候选说的话' }] });
    fakeAgents.scripts.set('claude-code', { messages: [{ text: '评审者说的话' }], finalText: judgeReplyJson() });

    startRun(run.id);
    await drainRunningTasks();

    // 候选那条：只有候选的内容
    const candidate = rowRecordsOf(run.id, rowId);
    expect(candidate.messages).toHaveLength(1);
    expect(candidate.messages[0]?.blocks[0]).toEqual({ type: 'text', text: '候选说的话' });
    // 评分那条：落在自己的文件里，内容是**评审者**的
    const judgeFile = judgeRecordsFileOf(run.id, rowId);
    expect(existsSync(judgeFile)).toBe(true);
    const judgeWritten = readRowRecords(judgeFile).messages;
    expect(judgeWritten).toHaveLength(1);
    expect(judgeWritten[0]?.blocks[0]).toEqual({ type: 'text', text: '评审者说的话' });
  });

  it('两条流的订阅表分开：评分增量只投给订阅评分那条流的人', () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'serial' });
    const rowId = getRun(run.id).rows[0]!.id;

    const onCandidate: RowRecord[] = [];
    const onJudge: RowRecord[] = [];
    const stopA = subscribeRowRecords(run.id, rowId, (record) => onCandidate.push(record));
    const stopB = subscribeJudgeRecords(run.id, rowId, (record) => onJudge.push(record));
    try {
      // 评分增量：只广播、不落盘
      broadcastJudgeMessage(run.id, rowId, judgeMessage('delta', '评审者正在写'));
      // 评分快照：落 judge 文件 + 投评分订阅者
      publishJudgeMessage(run.id, rowId, judgeMessage('snapshot', '评审者写完了'));
    } finally {
      stopA();
      stopB();
    }

    expect(onJudge.map((record) => record.type === 'message' && record.message.chunk)).toEqual(['delta', 'snapshot']);
    expect(onCandidate).toEqual([]);
    // 落盘侧：只有快照进了文件（增量一条都不落，与候选那条流同一口径）
    const written = readRowRecords(judgeRecordsFileOf(run.id, rowId)).messages;
    expect(written.map((message) => message.chunk)).toEqual(['snapshot']);
  });
});
