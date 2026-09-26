/**
 * client 包的评测域测试夹具：一轮评测与几条事件。
 * 只造数据，不做断言；runs.test.tsx 与 row-stream.test.tsx 共用。
 * 注意：本文件不是 *.test.tsx，vitest 不会把它当用例收集。
 */
import type { AgentEvent, EvalRun, EvalRow, Rubric } from '@aieval/contracts';

/**
 * 这一轮用的评分表**快照**（`EvalRun.rubric` 是必填格，与 `getRun` 的读盘口径同一条）。
 * 为什么夹具必须给：缺了它 `saveRun` 的写侧自检会拒、`listRuns()` 会静默跳过那一轮——
 * 夹具的缺格会让「被测代码坏了」与「夹具过时了」长得一模一样。一组一项、显式 `id`。
 */
const FIXTURE_RUBRIC: Rubric = {
  groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '补齐 Anthropic 到 Chat 的转换', weight: 100 }] }],
};

/** 造一行评测：默认是「跑完了、有分」的形状，可用 overrides 覆盖 */
export function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'w-1',
    agentKind: 'claude-code',
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'judged',
    branch: 'test/w-1',
    workspacePath: 'D:\\runs\\run-1\\rows\\w-1\\workspace',
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: { input: 128_450, cached: 12_800, output: 4_200 },
    turns: 17,
    durationMs: 383_000,
    diff: { filesChanged: 3, insertions: 25, deletions: 7, truncated: false },
    score: null,
    error: null,
    // 默认一行「一次就跑到位的行」：attempts = 1（界面据此判断「要不要显示重试过的提示」）
    attempts: 1,
    ...overrides,
  };
}

/** 造一轮评测：默认单行、已完成 */
export function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '为多协议入站补齐 Anthropic 到 Chat 的转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    rubric: FIXTURE_RUBRIC,
    status: 'done',
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: [makeRow()],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: '2026-09-22T08:01:00.000Z',
    finishedAt: '2026-09-22T08:10:00.000Z',
    ...overrides,
  };
}

/** 造一条事件：seq 必填，其余按类型给默认值 */
export function makeEvent(overrides: Partial<AgentEvent> & { seq: number }): AgentEvent {
  const base = { at: '2026-09-22T08:00:00.000Z', type: 'log' as const, stream: 'stdout' as const, text: `第 ${overrides.seq} 行` };
  return { ...base, ...overrides } as AgentEvent;
}
