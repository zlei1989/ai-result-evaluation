// @vitest-environment node
/**
 * 模型请求重试次数在**编排层**的接线：三处调用点（候选执行 / 追问 / 智能体评分）各把设置里那一格
 * 交给 `run()`。
 *
 * 为什么必须落在编排层（而不是只测四家适配器）：适配器那一侧的用例证明的是「给了就带出去」，
 * 证明不了**调用方有没有给**。这一格的漏传是**全仓最静默的一类**——四家照常跑完、分数照出、
 * 事件与结果一个字都不变，只是各家悄悄回落到厂商默认（cc 10 / codex 1 / dsh 5 / pi 不重试），
 * 而「四家对齐」这件事于是没有发生。
 *
 * 三个调用点**读的是各自那一次配置快照**：候选与追问走 `planCandidateEnvironment`，评分走
 * `candidateJudge` 自己那份。三处各会不会填，只有假适配器 / 假评分入口记下的 `modelRetries` 看得见。
 *
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 * 智能体评分那一路另加第四条 `./judge-agent`：它只换掉 `judgeCandidateByAgent` 这个观察口。
 */
import { vi, describe, expect, it } from 'vitest';
import {
  drainRunningTasks,
  fakeAgents,
  fakeJudgeAgent,
  followUpCandidate,
  getRun,
  registerOrchestratorHooks,
  runCandidate,
  seedRunnableRun,
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
/** 第四条对 `./judge-agent` 是**观察口**：智能体通路的入参只有换掉它才看得见（见 `judgeAgentMock`） */
vi.mock('./judge-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./judge-agent')>();
  return (await import('./testing/orchestrator-seams')).judgeAgentMock(actual);
});

registerOrchestratorHooks();

/**
 * 等这一个候选落 `judged` 并断言它真的到了。判据是**终态**而不是「立刻等于 judged」：评分是一条后台
 * 任务，`runCandidate` 返回时行还停在 `judging`；落到 `failed` 时把失败原因一起打出来——
 * 否则一条「没喂对夹具」会看起来像产品回归。
 */
async function expectJudged(runId: string, candidateId: string): Promise<void> {
  await drainRunningTasks();
  const candidate = getRun(runId).candidates.find((item) => item.id === candidateId);
  const failure = candidate?.error?.message === undefined ? '' : `：${candidate.error.message}`;
  expect(candidate?.status, `候选没有落到 judged${failure}`).toBe('judged');
}

describe('模型请求重试次数：候选执行那一处把它交给 run()', { timeout: TEST_TIMEOUT_MS }, () => {
  it('设置里给 3 ⇒ 逐字进 run() 入参', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', modelRetries: 3 });
    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.modelRetries).toBe(3);
  });

  /**
   * 出厂值也必须真的走到适配器：它是最容易「看着对、其实没接线」的那一档——设置页显示 10、
   * 适配器收到的却是「没给」，四家各自静默回落。判据取契约默认值本身，不另写一个数字。
   */
  it('没改过设置 ⇒ 出厂值 10 也照样交出去（不是「没给」）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.modelRetries).toBe(10);
  });

  it('追问那一段与候选执行带的是同一个数（同一份配置快照）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', modelRetries: 4 });
    const candidateId = run.candidates[0]?.id ?? '';
    // 追问要接得上会话：夹具得交出 `sessionId`（`null` 在拒绝面就被挡住，见 `followUpRefusal`）
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-retries' });
    await runCandidate(run.id, candidateId);
    await expectJudged(run.id, candidateId);
    fakeAgents.calls.length = 0;

    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-retries' });
    followUpCandidate(run.id, candidateId, { text: '再补一例' });
    await expectJudged(run.id, candidateId);

    expect(fakeAgents.calls.at(-1)?.modelRetries).toBe(4);
  });
});

describe('模型请求重试次数：智能体评分那一处也把它交给 run()', { timeout: TEST_TIMEOUT_MS }, () => {
  it('评审者与候选读同一份设置 ⇒ 带同一个数', async () => {
    const { run } = seedRunnableRun({
      candidateCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'cc',
      agentKind: 'dsh',
      modelRetries: 6,
    });
    const candidateId = run.candidates[0]?.id ?? '';
    await runCandidate(run.id, candidateId);
    await expectJudged(run.id, candidateId);

    expect(fakeJudgeAgent.calls[0]?.modelRetries).toBe(6);
  });
});
