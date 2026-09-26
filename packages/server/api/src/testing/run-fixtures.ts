/**
 * 评测域的测试夹具（api 包内共享，被 runs / run-artifacts / run-stream 三份用例复用）。
 * 只做两件事：把「供应商 / 用例」写进临时配置目录，造出「一轮评测」的形状。
 * **不 mock 任何业务函数**——那由各用例自己决定（本文件的实现全都是真值构造）。
 * 注意：本文件不是 *.test.ts，vitest 不会把它当用例收集。
 */
import { loadConfig, saveConfig, type AppConfig } from '@aieval/core';
import type { EvalRow, EvalRun, Provider, Rubric, TestCase } from '@aieval/contracts';

/** 造一个 openai 协议的供应商：默认带一条自动拉取的模型，可用 overrides 覆盖任意字段 */
export function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p-openai',
    name: 'OpenAI 网关',
    protocolType: 'openai',
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'sk-test-openai',
    models: [{ id: 'gpt-5', source: 'fetched' }],
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** 造一个 anthropic 协议的供应商：Claude Code 唯一能用的那种 */
export function makeAnthropicProvider(overrides: Partial<Provider> = {}): Provider {
  return makeProvider({
    id: 'p-anthropic',
    name: 'Anthropic 网关',
    protocolType: 'anthropic',
    baseUrl: 'https://gw.example.com/anthropic',
    apiKey: 'sk-test-anthropic',
    models: [{ id: 'claude-opus-4-6', source: 'manual' }],
    ...overrides,
  });
}

/**
 * 夹具用的评分表。`makeCase` 与 `makeRun` 的 `rubric` 必须**逐字相同**：
 * `runs.test.ts` 的「没换用例就不许动轮级快照」那条守卫靠的正是这个默认值
 * （用例与这一轮的快照同表时，「无条件重写」在它眼里等于没改），
 * 而份量更重的那条（`targetRubric` / `editedRubric`）在那个文件里自建。
 */
const FIXTURE_RUBRIC: Rubric = { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] };

/** 造一个用例：默认不指定 commit（等价于默认分支 HEAD） */
export function makeCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'c-1',
    title: '为多协议入站补齐 Anthropic 到 Chat 的转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    taskPrompt: '补齐转换并加回归用例',
    rubric: FIXTURE_RUBRIC,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

/** 把供应商与用例写进当前（临时）配置目录；其余字段保持 loadConfig 的现状 */
export function seedConfig(input: { providers?: Provider[]; cases?: TestCase[] } = {}): AppConfig {
  const config = loadConfig();
  const next: AppConfig = { ...config, providers: input.providers ?? [], cases: input.cases ?? [] };
  saveConfig(next);
  return next;
}

/** 造一行评测：默认是「还没开始跑」的形状 */
export function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'r-1',
    agentKind: 'claude-code',
    providerId: 'p-anthropic',
    providerName: 'Anthropic 网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'pending',
    branch: 'test/r-1',
    workspacePath: 'D:\\runs\\run-1\\rows\\r-1\\workspace',
    baselineCommit: '30b86eedca90b70d15b9eb9e75b454a2574762d4',
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
    // 默认一行「还没跑过」：0 次尝试（与 contracts 里这一格的缺省值一致）
    attempts: 0,
    ...overrides,
  };
}

/**
 * 造一轮评测快照：默认单行、idle。
 * `rubric` 与 `makeCase` 逐字相同（见 `FIXTURE_RUBRIC` 的说明）：它是这一轮**创建时**拍下的那把尺子，
 * 不填这一格等于造一轮「快照里没有评分表」的评测——`saveRun` 的写侧自检会当场拒绝，
 * 而「没换用例就不许动快照」那条守卫的保留侧也会退化成 `undefined`（拦不住「被丢掉/清空」）。
 */
export function makeRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '为多协议入站补齐 Anthropic 到 Chat 的转换',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    rubric: FIXTURE_RUBRIC,
    status: 'idle',
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: [makeRow()],
    workspaceBase: 'D:\\runs',
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}
