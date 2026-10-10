/**
 * 评测域的测试夹具（api 包内共享，被 runs / run-artifacts / run-stream 三份用例复用）。
 * 只做两件事：把「供应商 / 用例」写进临时配置目录，造出「一轮评测」的形状。
 * **不 mock 任何业务函数**——那由各用例自己决定（本文件的实现全都是真值构造）。
 * 注意：本文件不是 *.test.ts，vitest 不会把它当用例收集。
 *
 * ⚠️ 夹具里的**磁盘地址**（`workspaceBase` / `workspacePath`）是**真路径**，不是展示用的字符串：
 * 用例会拿它们 mkdir、写 `events.jsonl` / `messages.jsonl`。故一律按当前平台拼（见
 * `FIXTURE_WORKSPACE_ROOT`），不许写 `D:\runs` 这类盘符字面量——那在 POSIX 上是相对路径。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteCaseFile,
  getCasesRootOverrideForTesting,
  listCases,
  loadConfig,
  rowWorkspaceDir,
  saveConfig,
  writeCase,
} from '@aieval/core';
import type { EvalRow, EvalRun, Provider, Rubric, TestCase } from '@aieval/contracts';
import { afterAll } from 'vitest';
import { removeTreeWithRetry } from './cleanup';

/**
 * 夹具的工作区根：**当前平台认得的真绝对路径**，每个测试文件一棵（vitest 按文件隔离模块图，
 * 故两份用例文件不会共用同一棵树），随本模块的 `afterAll` 一起回收。
 *
 * 为什么必须这样：`makeRun().workspaceBase` / `makeRow().workspacePath` 会被用例**真的**拿去
 * mkdir / 写盘（`run-artifacts.test.ts` 的 `seedRun(..., { createWorkspace: true })`、
 * `messages-stream.test.ts` 的 `resetRecords(...)`），而盘符路径在 POSIX 上**不是绝对路径**——
 * 它是相对路径，产物会落进进程 cwd（仓库根），长出一个名为 `D:\runs` 的目录
 * （`D:\runs\run-1\rows\r-1\workspace` 与 `D:\runs/run-1/rows/r-1` 两棵树）。
 * 顺带钉住一条不变量：夹具交给产品代码的地址必须 `isAbsolute()`（守卫见 `run-fixtures.test.ts`）。
 */
const FIXTURE_WORKSPACE_ROOT = mkdtempSync(join(tmpdir(), 'aieval-run-fixtures-'));

// 钩子写在夹具模块里：模块级钩子在**收集期**注册到当前测试文件的根套件（实测有效），
// 这样「谁 import 夹具、谁就自动回收自己那棵树」，不必让 12 个消费文件各写一遍清理。
afterAll(() => {
  removeTreeWithRetry(FIXTURE_WORKSPACE_ROOT);
});

/** 夹具的工作区根：用例要在真实磁盘上断言时用它拼路径，别写自己的盘符字面量 */
export function fixtureWorkspaceRoot(): string {
  return FIXTURE_WORKSPACE_ROOT;
}

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

/**
 * 把供应商写进当前（临时）配置目录，把用例写进当前用例目录；其余设置保持 loadConfig 的现状。
 *
 * 用例**不再随 saveConfig 覆盖写**（一文件一用例，见 core 的 `case-store`）：所以每次 seed 都要先把
 * 上一批清掉——`seedConfig({ })` 在调用方那里的语义是「盘上一条用例都没有」，
 * 上一批文件还在就测不到它要的那条分支（例如「用例已被删除」）。
 */
export function seedConfig(input: { providers?: Provider[]; cases?: TestCase[] } = {}): void {
  // 安全阀：没有测试 override 时 `listCases()` 读的是真实家目录下的 ~/.aieval-cases，
  // 下面那句 deleteCaseFile 就会删掉开发者的真实用例。调用方必须先 setCasesRootForTesting()。
  if (getCasesRootOverrideForTesting() === null) {
    throw new Error('夹具失败： seedConfig 前必须先 setCasesRootForTesting()（用例目录尚未指向临时目录）');
  }
  for (const existing of listCases().cases) deleteCaseFile(existing.id);
  for (const item of input.cases ?? []) writeCase(item);

  const config = loadConfig();
  saveConfig({ settings: config.settings, providers: input.providers ?? [] });
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
    workspacePath: rowWorkspaceDir(FIXTURE_WORKSPACE_ROOT, 'run-1', 'r-1'),
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
    workspaceBase: FIXTURE_WORKSPACE_ROOT,
    createdAt: '2026-09-22T08:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}
