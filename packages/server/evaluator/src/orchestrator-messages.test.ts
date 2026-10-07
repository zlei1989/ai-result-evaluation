// @vitest-environment node
/**
 * 消息与子任务行的落盘（spec v3 §2）：**适配器交出内容，编排层负责让它落进唯一真相源**。
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
import {
  drainRunningTasks,
  existsSync,
  fakeAgents,
  getRun,
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
});
