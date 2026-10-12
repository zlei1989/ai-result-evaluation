// @vitest-environment node
/**
 * 评分阶段「执行过程记录」证据的**编排层接线**：`runJudgeStage` 把 `assembleProcessEvidence`
 * 的产物交进两条通路（文本通路 `judgeRow` 的 `processEvidence`、智能体通路 `judgeRowByAgent`
 * 的 `processEvidence`）。
 *
 * 组装本身的行为在 `process-evidence.test.ts` 里测（raw 原文、codex 双文件、字节截断），
 * 这里只钉「接线」：快照门控是否真的影响两份入参、磁盘原文是否原样进了文本通路、
 * codex 候选是否多一份 messages、重评是否沿用同一份组装。
 * 三条 `vi.mock` 之外的第四条（`./judge-agent`）是**观察口**：智能体通路的入参只有换掉
 * `judgeRowByAgent` 才看得见——漏掉这一条时，本文件只有文本通路有观测点，而智能体通路
 * 少传证据会静默绿（智能体通路消费证据的 absolutePath，只有这个观察口看得见）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { rowMessagesFile } from '@aieval/core';
import {
  registerOrchestratorHooks,
  TEST_TIMEOUT_MS,
  until,
  home,
  seedRunnableRun,
  rowEventsFile,
  drainRunningTasks,
  rescoreRow,
  runRow,
  getRun,
  fakeAgents,
  fakeJudge,
  fakeJudgeAgent,
  releaseJudge,
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
vi.mock('./judge-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge-agent')>();
  return (await import('./testing/orchestrator-seams')).judgeAgentMock(actual);
});

registerOrchestratorHooks();

describe('评分阶段组装执行过程证据（快照门控 + codex 补 messages + 预算截断）', { timeout: TEST_TIMEOUT_MS }, () => {
  it('开关关（快照 includeSteps=false）：文本通路拿到的证据是空文件表', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true });
    const rowId = run.rows[0]?.id ?? '';
    await runRow(run.id, rowId);
    expect(getRun(run.id).rows[0]?.status).toBe('judged');
    expect(fakeJudge.calls[0]?.processEvidence?.files).toEqual([]);
  });

  it('开关开：events.jsonl 原文逐字节进文本通路（评分请求发出那一刻的磁盘原文）', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      withJudge: true,
      agentKind: 'dsh',
      includeSteps: true,
    });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('dsh', {
      events: [{ stream: 'stdout', text: '候选的推理过程第一行' }],
    });
    // gate 住评分：judgeRow 已收到入参、行停在 judging，此刻磁盘上的 events.jsonl 不会再长
    fakeJudge.mode = 'gate';
    const running = runRow(run.id, rowId);
    // 真仓库准备在本机要几秒（见 harness 的 TEST_TIMEOUT_MS）：等待上限照用例级口径放宽
    await until(() => fakeJudge.calls.length === 1, '评分请求已发出', TEST_TIMEOUT_MS);

    const evidence = fakeJudge.calls[0]?.processEvidence;
    expect(evidence?.files).toHaveLength(1);
    expect(evidence?.files[0]).toMatchObject({
      filename: 'candidate-events.jsonl',
      truncated: false,
      absolutePath: rowEventsFile(home.workspaceRoot, run.id, rowId),
    });
    // raw 原文：与这一拍磁盘内容逐字节一致（含坏行也照留——解析口径在组装里不存在）
    const diskRaw = readFileSync(rowEventsFile(home.workspaceRoot, run.id, rowId), 'utf8');
    expect(evidence?.files[0]?.content).toBe(diskRaw);
    expect(evidence?.files[0]?.content).toContain('候选的推理过程第一行');

    releaseJudge();
    await running;
    await drainRunningTasks();
  });

  it('开关开 + 候选 codex：messages.jsonl 原文作为第二个证据文件进文本通路', async () => {
    const { run } = seedRunnableRun({ rowCount: 1, executionMode: 'parallel', withJudge: true, includeSteps: true });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('codex', {
      messages: [{ text: 'codex 的思考全文只落在消息账本里' }],
    });
    await runRow(run.id, rowId);

    const evidence = fakeJudge.calls[0]?.processEvidence;
    expect(evidence?.files.map((file) => file.filename)).toEqual([
      'candidate-events.jsonl',
      'candidate-messages.jsonl',
    ]);
    expect(evidence?.files[1]?.absolutePath).toBe(rowMessagesFile(home.workspaceRoot, run.id, rowId));
    expect(evidence?.files[1]?.content).toContain('codex 的思考全文只落在消息账本里');
  });

  it('智能体通路拿到同一份证据（absolutePath 指向磁盘原文，供评审者直接读取）', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'cc',
      agentKind: 'dsh',
      includeSteps: true,
    });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('dsh', {
      events: [{ stream: 'stdout', text: '评审者要读的候选推理' }],
    });
    await runRow(run.id, rowId);
    await drainRunningTasks();
    expect(getRun(run.id).rows[0]?.status).toBe('judged');

    const evidence = fakeJudgeAgent.calls[0]?.processEvidence;
    expect(evidence?.files).toHaveLength(1);
    expect(evidence?.files[0]?.absolutePath).toBe(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(evidence?.files[0]?.content).toContain('评审者要读的候选推理');
  });

  it('预算按 settings.diffBudgetBytes 生效：小预算下进评分上下文的证据带截断标注', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      withJudge: true,
      agentKind: 'dsh',
      includeSteps: true,
      diffBudgetBytes: 300,
    });
    const rowId = run.rows[0]?.id ?? '';
    // 一条远超预算的日志行：整行装不进任何一边，只能落进「中间被截」的那部分
    const longText = `LONG-${'推'.repeat(400)}`;
    fakeAgents.scripts.set('dsh', {
      events: [{ stream: 'stdout', text: longText }],
    });
    await runRow(run.id, rowId);

    const evidence = fakeJudge.calls[0]?.processEvidence;
    expect(evidence?.files[0]?.truncated).toBe(true);
    expect(evidence?.files[0]?.content).toMatch(/…（中间 \d+ 行已截断，预算 300 字节）…/);
    expect(Buffer.byteLength(evidence?.files[0]?.content ?? '', 'utf8')).toBeLessThanOrEqual(300);
    // 截断的是内容本身：那条超长日志不许以任何形态漏进评分上下文
    expect(evidence?.files[0]?.content).not.toContain('LONG-');
  });

  it('重新评分沿用同一份组装（重评那次 judgeRow 也拿到证据，快照门控照旧）', async () => {
    const { run } = seedRunnableRun({
      rowCount: 1,
      executionMode: 'parallel',
      withJudge: true,
      agentKind: 'dsh',
      includeSteps: true,
    });
    const rowId = run.rows[0]?.id ?? '';
    fakeAgents.scripts.set('dsh', {
      events: [{ stream: 'stdout', text: '第一次跑出来的推理' }],
    });
    await runRow(run.id, rowId);
    expect(fakeJudge.calls).toHaveLength(1);

    fakeJudge.achieved = false;
    rescoreRow(run.id, rowId);
    await until(() => fakeJudge.calls.length === 2, '重评的评分请求已发出');
    await drainRunningTasks();

    const evidence = fakeJudge.calls[1]?.processEvidence;
    expect(evidence?.files).toHaveLength(1);
    expect(evidence?.files[0]?.absolutePath).toBe(rowEventsFile(home.workspaceRoot, run.id, rowId));
    expect(evidence?.files[0]?.content).toContain('第一次跑出来的推理');
  });
});
