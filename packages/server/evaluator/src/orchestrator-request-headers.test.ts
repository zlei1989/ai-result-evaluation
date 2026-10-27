// @vitest-environment node
/**
 * 自定义请求头在**编排层**的接线：三处调用点（候选执行 / 追问 / 智能体评分）各把设置里那张表
 * 交给 `run()`，空表时不传这个键。
 *
 * 为什么必须落在编排层（而不是只测四家适配器）：适配器那一侧的用例证明的是「给了就带出去」，
 * 证明不了**调用方有没有给**。这一格的漏传是**全仓最静默的一类**——四家照常跑完、分数照出、
 * 事件与结果一个字都不变，只是发往网关的请求里少了几条头；网关侧若有路由 / 计费 / 审计规则认这几条头，
 * 表现是「行为变了但没有任何报错」。
 *
 * 三个调用点**读的是各自那一次配置快照**：候选与追问走 `planCandidateEnvironment`（MCP / 技能同一份），
 * 评分走 `candidateJudge` 自己那份。三处各会不会填，只有假适配器记下的 `requestHeaders` 看得见。
 *
 * 共享夹具、假适配器接缝与 `until` 等待器都在 `./testing/orchestrator-harness`——
 * 那里也写明了**为什么三条 `vi.mock` 必须在每个文件里逐字重复**（vitest 的前置提升只作用于本文件）。
 * 智能体评分那一路另加第四条 `./judge-agent`：它只换掉 `judgeCandidateByAgent` 这个观察口，
 * 不换 `./judge`（文本通路那一路与本文件无关，真实现留在那儿不影响本文件任何断言）。
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

/** 设置页那张卡里最常见的一条敏感头 + 一条非敏感头（值就是要原样发出去的那几个字） */
const HEADERS = { 'X-Trace-Id': 'abc-123', 'X-Api-Key': 'gw-plain-secret-0005' };

/**
 * 等这一个候选落 `judged` 并断言它真的到了。判据是**终态**而不是「立刻等于 judged」：评分是一条后台
 * 任务，`runCandidate` 返回时行还停在 `judging`，直接断言会让用例比产品快一步；
 * 而落到 `failed` 时把失败原因一起打出来——否则一条「没喂对夹具」会看起来像产品回归。
 */
async function expectJudged(runId: string, candidateId: string): Promise<void> {
  await drainRunningTasks();
  const candidate = getRun(runId).candidates.find((item) => item.id === candidateId);
  const failure = candidate?.error?.message === undefined ? '' : `：${candidate.error.message}`;
  expect(candidate?.status, `候选没有落到 judged${failure}`).toBe('judged');
}

describe('自定义请求头：候选执行那一处把它交给 run()', { timeout: TEST_TIMEOUT_MS }, () => {
  it('配了 ⇒ 逐字进 run() 入参（不掩码、不改形）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', customHeaders: HEADERS });
    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.requestHeaders).toEqual(HEADERS);
  });

  it('没配 ⇒ 这一格根本不存在（不兜成空表：适配器按「给了空表」会去写一个空方言键）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel' });
    await runCandidate(run.id, run.candidates[0]?.id ?? '');

    expect(fakeAgents.calls[0]?.requestHeaders).toBeUndefined();
  });

  it('追问那一段与候选执行带的是同一张表（同一个网关，两段不许换身份）', async () => {
    const { run } = seedRunnableRun({ candidateCount: 1, executionMode: 'parallel', customHeaders: HEADERS });
    const candidateId = run.candidates[0]?.id ?? '';
    // 追问要接得上会话：夹具得交出 `sessionId`（`null` 在拒绝面就被挡住，见 `followUpRefusal`）
    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-headers' });
    await runCandidate(run.id, candidateId);
    await expectJudged(run.id, candidateId);
    fakeAgents.calls.length = 0;

    fakeAgents.scripts.set('codex', { mode: 'ok', sessionId: 'sess-headers' });
    followUpCandidate(run.id, candidateId, { text: '再补一例' });
    await expectJudged(run.id, candidateId);

    expect(fakeAgents.calls.at(-1)?.requestHeaders).toEqual(HEADERS);
  });
});

describe('自定义请求头：智能体评分那一处也把它交给 run()', { timeout: TEST_TIMEOUT_MS }, () => {
  it('评审者与候选打同一个网关 ⇒ 带同一张表', async () => {
    const { run } = seedRunnableRun({
      candidateCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'cc',
      agentKind: 'dsh',
      customHeaders: HEADERS,
    });
    const candidateId = run.candidates[0]?.id ?? '';
    await runCandidate(run.id, candidateId);
    await expectJudged(run.id, candidateId);

    expect(fakeJudgeAgent.calls[0]?.requestHeaders).toEqual(HEADERS);
  });

  it('没配 ⇒ 评分的入参上也没有这一格', async () => {
    const { run } = seedRunnableRun({
      candidateCount: 1,
      executionMode: 'parallel',
      useAgentJudge: true,
      judgeAgentKind: 'cc',
      agentKind: 'dsh',
    });
    const candidateId = run.candidates[0]?.id ?? '';
    await runCandidate(run.id, candidateId);
    await expectJudged(run.id, candidateId);

    expect(fakeJudgeAgent.calls[0]?.requestHeaders).toBeUndefined();
  });
});
