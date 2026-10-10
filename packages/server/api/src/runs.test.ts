// @vitest-environment node
/**
 * 评测服务：创建（校验 → 快照 → 落库 idle）、列表顺序、启动/终止的业务闸门、候选池协议投影。
 *
 * **为什么在 api 层 mock 掉 `@aieval/evaluator`（而不是注入假 provider）**：
 * 被测对象是 api 自己的业务规则（校验顺序、快照字段、落库状态、候选池投影），它与编排层的
 * 契约就是 evaluator 导出的那几个函数；在这一层替换掉它们，能同时做到三件事——
 *   1. **不起真实 agent 进程**：`startRun` / `abortRun` 落到假的实现上，编排状态机（以及它
 *      会 spawn 的子进程）在 api 用例里根本不会被进入；
 *   2. 断言「api 有没有把该做的事交给编排层」（调用次数与入参），这比 sdk 层的行为更能定位问题；
 *   3. 快照的读写在假实现里是一个内存 Map，用例可以精确控制「磁盘上有什么」。
 *
 * `@aieval/agents` **保持真实**：注册表是静态注册 + 纯元数据（§5.6.1 A6：厂商 SDK 是函数作用域
 * 懒加载），import 它不会拉起任何厂商包，而候选池的协议判据正需要这份真实元数据。
 *
 * `@aieval/core` 保持真实（只把三个函数包一层 spy，语义不变），因为「落盘」「按路径读事件」
 * 这些行为本身就是被测内容的一部分。
 *
 * 配置目录一律指向 mkdtemp 出来的临时目录，**绝不触碰真实 ~/.aieval**。
 *
 * 创建入参里的 `useAgentJudge` 在契约上是**必填**（`RunCreateSchema` 用 `.default(false)` 定默认值，
 * 而 `.default()` 落在 zod 的**输出**类型上）：服务端不替调用方补这一格，故下面每条 `createRun`
 * 都显式写出它——漏掉的表现是「这一轮明明是模型评分，却按智能体评分跑」。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from '@aieval/agents';
import {
  EFFORT_OFF,
  PROTOCOL_LABELS,
  ServiceError,
  type EvalRow,
  type EvalRun,
  type Rubric,
  type TestCase,
} from '@aieval/contracts';
import { rowWorkspaceDir, setCasesRootForTesting, setConfigDirForTesting } from '@aieval/core';
import {
  abortRow as abortRowInOrchestrator,
  abortRun as abortRunInOrchestrator,
  assertRunMutable,
  deleteRun as deleteRunInOrchestrator,
  getRun as getRunSnapshot,
  listRuns as listRunsFromDisk,
  rescoreRow as rescoreRowInOrchestrator,
  retryRow as retryRowInOrchestrator,
  saveRun,
  startRun as startRunInOrchestrator,
} from '@aieval/evaluator';
import {
  abortRow,
  abortRun,
  createRun,
  deleteRun,
  getRunView,
  listAgentModelOptions,
  listModelOptions,
  listRunsView,
  planRunUpdate,
  rescoreRow,
  resolveRunRows,
  retryRow,
  startRun,
  updateRun,
  type RunTargetCase,
} from './runs';
import { updateSettings } from './settings';
import {
  makeAnthropicProvider,
  makeCase,
  makeProvider,
  makeRow,
  makeRun,
  seedConfig,
} from './testing/run-fixtures';
import { removeTreeWithRetry } from './testing/cleanup';

/**
 * 只替换**编排层**那几个函数（本层被测的是 api 自己的业务规则：校验顺序、快照字段、落库状态），
 * 其余导出保持真实——尤其是 `resolveJudgeRoute` / `requireJudgeAgent`：
 * 「创建时把评分配置问题拦下来」这条守卫的**全部内容**就是这两个函数，把它们也换成 `vi.fn()`，
 * 下面那两条用例会退化成「断言自己装的桩」，装什么都能绿。
 *
 * 走 `importOriginal` 而不是手写一份键清单：清单漏一个键时，失败出现在**运行期**、
 * 且红的是别人的用例（`xxx is not a function`）——那正是本任务要修的那种坑。
 */
vi.mock('@aieval/evaluator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aieval/evaluator')>();
  return {
    ...actual,
    listRuns: vi.fn(),
    getRun: vi.fn(),
    saveRun: vi.fn(),
    startRun: vi.fn(),
    abortRun: vi.fn(),
    abortRow: vi.fn(),
    rescoreRow: vi.fn(),
    retryRow: vi.fn(),
    // 守卫（2026-09-28 复核顺修）：真实实现读的是编排层的在途任务表，而本层没有在途任务 ⇒ 恒通过，
    // 于是「它一抛就不许落盘」这条不变式一直没人守。换成可抛的替身，下面那条用例才钉得住它。
    assertRunMutable: vi.fn(),
    // 删除（2026-09-28）：api 层的 deleteRun 只是转发，本层要断言的是「转过去了吗」
    deleteRun: vi.fn(),
  };
});

let dir: string;
/** 假的「磁盘」：saveRun 写进来、getRun/listRuns 从这里读 */
let store: Map<string, EvalRun>;

beforeEach(() => {
  // **必须清一次调用记录**：本仓 vitest 没开 `clearMocks`（`vitest.node.ts` 只设 environment/include），
  // 而 `not.toHaveBeenCalled()` 断言的是**累积**的调用历史 —— 不清就会让「上一轮用例调用过」
  // 变成「这一轮用例也调用过」，失败点还会随用例顺序漂移（`mock.results[0]` 同理读到的是一次旧调用）。
  // `clearAllMocks` 只清调用/结果、保留实现，下面的 mockImplementation 会重新装上同一份实现。
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'aieval-runs-'));
  setConfigDirForTesting(dir);
  // 用例目录也要指到临时目录：用例是一文件一落（core 的 `case-store`），config 目录的 override 管不到它
  setCasesRootForTesting(join(dir, 'cases'));
  store = new Map();
  vi.mocked(saveRun).mockImplementation((run: EvalRun) => {
    store.set(run.id, run);
  });
  vi.mocked(getRunSnapshot).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return run;
  });
  vi.mocked(listRunsFromDisk).mockImplementation(() => [...store.values()]);
  vi.mocked(startRunInOrchestrator).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return { ...run, status: 'running' };
  });
  vi.mocked(abortRunInOrchestrator).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return { ...run, status: 'partial' };
  });
  vi.mocked(abortRowInOrchestrator).mockImplementation((runId: string) => {
    const run = store.get(runId);
    if (run === undefined) throw new ServiceError('NOT_FOUND', `评测不存在：${runId}`);
    return { ...run, status: 'partial' };
  });
  // 工作区根目录指到临时目录：创建出来的行路径不会落到真实 ~/.aieval-runs
  updateSettings({ workspaceRoot: join(dir, 'ws') });
  seedConfig({ providers: [makeProvider(), makeAnthropicProvider()], cases: [makeCase()] });
});

afterEach(() => {
  // 与 beforeEach 的 clearAllMocks 配对：`clearAllMocks` 清不掉**排队中的 once 实现**，
  // 某条用例若在消费掉它之前就失败（例如直通用例里的 mockImplementationOnce），
  // 那一个 once 就会漏给下一条用例，把一次失败放大成两条互不相关的红。
  // `resetAllMocks` 连同实现一起清掉，beforeEach 会重新装同一份实现。
  vi.resetAllMocks();
  setConfigDirForTesting(null);
  setCasesRootForTesting(null);
  removeTreeWithRetry(dir);
});

describe('createRun', () => {
  it('落库 idle、不自动开跑，并按行快照供应商名与 baseUrl', () => {
    const run = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [
        { agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    });

    expect(run.status).toBe('idle');
    expect(run.executionMode).toBe('serial');
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.rows).toHaveLength(2);
    // 创建**不得**把「开始」一起做了：编排层的启动函数一次都不能被调用
    expect(vi.mocked(startRunInOrchestrator)).not.toHaveBeenCalled();

    const [first, second] = run.rows;
    expect(first?.status).toBe('pending');
    expect(first?.providerId).toBe('p-anthropic');
    expect(first?.providerName).toBe('Anthropic 网关');
    expect(first?.baseUrl).toBe('https://gw.example.com/anthropic');
    expect(first?.modelId).toBe('claude-opus-4-6');
    expect(second?.providerName).toBe('OpenAI 网关');
    // 分支名用行 id（同一用例下多候选共用分支名会互相踩，spec §5.5）
    expect(first?.branch).toBe(`test/${first?.id ?? ''}`);
    expect(first?.workspacePath.startsWith(join(dir, 'ws'))).toBe(true);
    expect(first?.tokens).toBeNull();
    expect(first?.score).toBeNull();
    // 快照写进了假的磁盘（saveRun 被调用过）
    expect(vi.mocked(saveRun)).toHaveBeenCalledTimes(1);
  });

  it('创建时落 baselineCommit 空串（= 尚未准备），绝不伪造 40 位假 hash（R2）', () => {
    // 基线要到准备阶段才解析成具体 hash（contracts §2.4 的 EvalRowSchema 就是 z.string()，
    // p0 有一条断言明确要求空串必须解析成功）。写假 hash 会让界面显示一个不存在的 commit，
    // 也让「准备阶段把 HEAD 解析成具体 hash」这一步失去判据。
    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [
        { agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    });

    expect(run.rows.map((row) => row.baselineCommit)).toEqual(['', '']);
  });

  it('冗余快照用例标题/仓库路径/commit：用例被删也说得清当时测的是什么', () => {
    seedConfig({
      providers: [makeAnthropicProvider()],
      cases: [makeCase({ commitHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' })],
    });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(run.caseTitle).toBe('为多协议入站补齐 Anthropic 到 Chat 的转换');
    expect(run.repoPath).toBe('D:\\projects\\gateway');
    expect(run.commitHash).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
    expect(run.workspaceBase).toBe(join(dir, 'ws'));
  });

  /**
   * 远端用例的「跟哪条分支」必须随这一轮落库（spec §6.5 / §7.2 的冗余快照口径）。
   * 为什么不能只留在用例里：分支是**这一轮开始时**的选择，之后在用例里改分支（评测还要继续重跑某一行）
   * 时，历史轮次仍要说得清自己当时跟的是哪条；编排层的远端准备也直接读这一份快照，不回头查配置。
   */
  it('创建评测时把用例的分支快照进这一轮', () => {
    seedConfig({
      providers: [makeAnthropicProvider()],
      cases: [makeCase({ repoBranch: 'feat/x' })],
    });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(run.repoBranch).toBe('feat/x');
    // 落盘的那一份也要有：编排层读的是磁盘上的快照，不是当前配置里的用例
    expect(vi.mocked(saveRun).mock.calls[0]?.[0]?.repoBranch).toBe('feat/x');
  });

  /**
   * **这一轮用的是哪张评分表**必须随创建落库（`EvalRunSchema.rubric`，spec §7.2 的冗余快照口径）。
   * 为什么它是承重的：评分阶段读的是**快照**而不是 `testCase.rubric`——不写下这一格，
   * 「改了用例的评分表之后，历史分数仍与当初那把尺子自洽」这条不变式就没有载体
   * （评分阶段拿到 `undefined`，`rubricMaxScore` 会当场炸；或者更坏：悄悄按用例现取的表评分）。
   * 这条断言的**边界**（如实登记）：这里传的表恰好与夹具缺省**相同**（`testing/run-fixtures.ts` 的
   * `FIXTURE_RUBRIC`）⇒ 它只能证明「快照里有这一格、且等于用例那张表」，分辨不出「从用例取来」
   * 还是「落了缺省值」；要分辨得换一张不同的表（同文件 `planRunUpdate` 组的 `targetRubric` / `editedRubric`，
   * 见 `:953` / `:954`）。
   */
  it('创建评测时把用例的评分表快照进这一轮（评分阶段读的是它，不是用例现取的那一份）', () => {
    const rubric: Rubric = { groups: [{ name: '一、生产代码', items: [{ id: 'A1', goal: '追加 agent 字段', weight: 20 }] }] };
    seedConfig({ providers: [makeAnthropicProvider()], cases: [makeCase({ rubric })] });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(run.rubric).toEqual(rubric);
    // 落盘的那一份也要有：编排层读的是磁盘上的快照，不是当前配置里的用例
    expect(vi.mocked(saveRun).mock.calls[0]?.[0]?.rubric).toEqual(rubric);
  });

  /**
   * 旧 config.json 里的用例**没有** `repoBranch` 这一列（这一列是后加的），而 `loadConfig` 不过 schema，
   * 运行期读到的就是 `undefined`——契约声明的却是 `string | null`。
   * 不做 `?? null` 归一的话，创建出来的这一轮会带着 `undefined`：JSON.stringify 把这把键整个丢掉，
   * 磁盘上的快照与创建返回值对不上，读侧（界面 / 编排）还得各自再防一次。
   * 夹具按历史数据的真实来路造：先造一条用例，再把那把键删掉（`delete` 而不是置 null，区别正是本用例要钉的）。
   * 注意这条归一今天有**两层**：`getCase` 的 `asStoredCase` 先补一次（A10③），`createRun` 再兜一次。
   * 故单独去掉任一层都不会红，两层都去掉才会红（变异记录见任务报告）——这里钉的是**端到端**的承诺：
   * 「旧用例跑出来的这一轮，快照里这一列是 null」。
   */
  it('旧用例缺 repoBranch 这一列时快照落 null（不是 undefined）', () => {
    const legacy = makeCase();
    delete (legacy as Partial<TestCase>).repoBranch;
    seedConfig({ providers: [makeAnthropicProvider()], cases: [legacy] });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(run.repoBranch).toBeNull();
  });

  it('用例不存在时抛 NOT_FOUND，且不落库', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-missing',
        executionMode: 'parallel',
        useAgentJudge: false,
        rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect((caught as ServiceError).message).toContain('c-missing');
    expect(vi.mocked(saveRun)).not.toHaveBeenCalled();
  });

  it('供应商不存在时抛 NOT_FOUND（名字与 id 都要能读出来）', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        useAgentJudge: false,
        rows: [{ agentKind: 'claude-code', providerId: 'p-gone', modelId: 'claude-opus-4-6' }],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect((caught as ServiceError).message).toContain('p-gone');
  });

  it('模型不在该供应商的清单里时抛 NOT_FOUND，且文案点名供应商', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        useAgentJudge: false,
        rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-3-5-sonnet' }],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('NOT_FOUND');
    expect((caught as ServiceError).message).toContain('Anthropic 网关');
    expect((caught as ServiceError).message).toContain('claude-3-5-sonnet');
  });

  it('协议不匹配时抛 CONFLICT：Claude Code 不能被 openai 协议的供应商驱动', () => {
    let caught: unknown;
    try {
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        useAgentJudge: false,
        rows: [{ agentKind: 'claude-code', providerId: 'p-openai', modelId: 'gpt-5' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    // 文案用的是 contracts 里的协议中文标签（两处各写一份中文必然漂移）
    expect((caught as ServiceError).message).toContain(PROTOCOL_LABELS.anthropic);
    expect((caught as ServiceError).message).toContain(PROTOCOL_LABELS.openai);
    expect(vi.mocked(saveRun)).not.toHaveBeenCalled();
  });

  /**
   * 开关打开时必须在**创建**这一刻把评分配置问题拦下来（spec §6）。
   * 为什么不能等评分阶段：候选 agent 已经白跑了几分钟，使用者为此付出的等待不可撤，
   * 而错误出现在「与刚才那次选择无关」的地方。两条用例对应 spec §6 的两项校验：
   *   ① 没配默认评分智能体；② 默认评分智能体的协议与这一轮的评分模型不匹配。
   * ②的判据是**全局默认评分模型**的协议（用例上不再有覆盖，评分配置是唯一来源）。
   */
  it('开关打开但未配默认评分智能体 → CONFLICT（不要等人跑完才在评分阶段炸）', () => {
    // 评分**模型**是配了的：否则先炸的是「未配置评分模型」那条守卫，本用例就测不到这一格了
    updateSettings({ defaultJudge: { providerId: 'p-anthropic', modelId: 'claude-opus-4-6' } });

    expect(() =>
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        useAgentJudge: true,
        rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      }),
    ).toThrowError(/没有配置默认评分智能体/);
    // 拦下来就等于没创建：不能在磁盘上留一轮「永远跑不了评分」的评测
    expect(vi.mocked(saveRun)).not.toHaveBeenCalled();
  });

  it('评分智能体与全局默认评分模型的协议不匹配 → CONFLICT，点名两家', () => {
    const anthropicProvider = makeAnthropicProvider({ models: [{ id: 'claude-sonnet-5', source: 'manual' }] });
    seedConfig({ providers: [makeProvider(), anthropicProvider], cases: [makeCase()] });
    // 尺子只有全局默认这一个来源：把它指向 Anthropic 协议的模型，再让 Codex 去驱动它
    // Codex 走 chat-completions，驱动不了 Anthropic 协议的评分模型（R37 的注册表元数据是唯一判据）
    updateSettings({
      defaultJudge: { providerId: anthropicProvider.id, modelId: 'claude-sonnet-5' },
      defaultJudgeAgent: 'codex',
    });

    expect(() =>
      createRun({
        caseId: 'c-1',
        executionMode: 'parallel',
        useAgentJudge: true,
        rows: [{ agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' }],
      }),
    ).toThrowError(/Codex 只接受 OpenAI 兼容协议/);
    expect(vi.mocked(saveRun)).not.toHaveBeenCalled();
  });

  it('开关关闭时不去碰评分配置：没配默认评分智能体也能创建（默认关闭是用户口径）', () => {
    // 这条是上面两条的**阴性面**：守卫若写成「无条件校验」，所有历史用法（模型评分）都会被误伤
    const run = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(run.useAgentJudge).toBe(false);
  });
});

describe('runId 的形状校验不重复实现（R36）', () => {
  it('getRunView 把原样 id 直通编排层：形状判定只有 run-store 一份，错误按原对象抛出', () => {
    // `run-store` 的 getRun/saveRun 入口已有 assertRunId（空串 / 以 . 开头 / 含 / \ .. ⇒ INVALID_QUERY）。
    // api 若自己再判一次形状，就会对同一个 id 给出第二个（且往往是 NOT_FOUND）结论——
    // 「形状不对」与「这一轮不存在」必须能分开，所以这里按**对象同一性**断言直通：
    // 编排层抛出的那个错误对象必须原样到达调用方，而不能被本地判定替换成一个新的 ServiceError。
    const thrown = new ServiceError('INVALID_QUERY', 'runId 不合法（../../etc）', { context: { runId: '../../etc' } });
    vi.mocked(getRunSnapshot).mockImplementationOnce(() => {
      throw thrown;
    });

    let caught: unknown;
    try {
      getRunView('../../etc');
    } catch (error) {
      caught = error;
    }

    expect(vi.mocked(getRunSnapshot)).toHaveBeenCalledWith('../../etc');
    expect(caught).toBe(thrown);
  });
});

describe('listRunsView', () => {
  it('按 createdAt 倒序（最新在前）', () => {
    store.set('old', makeRun({ id: 'old', createdAt: '2026-09-22T08:00:00.000Z' }));
    store.set('new', makeRun({ id: 'new', createdAt: '2026-09-22T09:30:00.000Z' }));
    store.set('mid', makeRun({ id: 'mid', createdAt: '2026-09-22T09:00:00.000Z' }));

    expect(listRunsView().map((run) => run.id)).toEqual(['new', 'mid', 'old']);
  });

  it('排序不原地改写入参（读接口不改写入侧返回的数组）', () => {
    store.set('old', makeRun({ id: 'old', createdAt: '2026-09-22T08:00:00.000Z' }));
    store.set('new', makeRun({ id: 'new', createdAt: '2026-09-22T09:30:00.000Z' }));

    listRunsView();

    expect(vi.mocked(listRunsFromDisk).mock.results[0]?.value.map((run: EvalRun) => run.id)).toEqual(['old', 'new']);
  });
});

describe('getRunView', () => {
  it('直通编排层的快照读取（api 不重复造 NOT_FOUND 的判定）', () => {
    const run = makeRun({ id: 'run-9' });
    store.set('run-9', run);

    expect(getRunView('run-9')).toEqual(run);
    expect(vi.mocked(getRunSnapshot)).toHaveBeenCalledWith('run-9');
  });
});

describe('startRun', () => {
  it('有可执行行时交给编排层并返回它的结果', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ status: 'failed' })] }));

    const run = startRun('run-1');

    expect(vi.mocked(startRunInOrchestrator)).toHaveBeenCalledWith('run-1');
    expect(run.status).toBe('running');
  });

  it('没有可执行行时抛 CONFLICT，且不惊动编排层', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1', status: 'judged' })] }));

    expect(() => startRun('run-1')).toThrowError(/没有可执行的候选行/);
    // 静默什么都不做是最难排查的一种反馈：界面刚点过「开始」，必须有明确失败
    expect(vi.mocked(startRunInOrchestrator)).not.toHaveBeenCalled();
  });

  it('评测不存在时抛 NOT_FOUND，且不惊动编排层', () => {
    expect(() => startRun('nope')).toThrowError(ServiceError);
    expect(vi.mocked(startRunInOrchestrator)).not.toHaveBeenCalled();
  });
});

describe('abortRun / abortRow', () => {
  it('终止整轮：直通编排层', () => {
    store.set('run-1', makeRun());

    expect(abortRun('run-1').status).toBe('partial');
    expect(vi.mocked(abortRunInOrchestrator)).toHaveBeenCalledWith('run-1');
  });

  it('终止整轮时评测不存在 → NOT_FOUND，且不惊动编排层', () => {
    expect(() => abortRun('nope')).toThrowError(ServiceError);
    expect(vi.mocked(abortRunInOrchestrator)).not.toHaveBeenCalled();
  });

  it('终止单行：行存在则直通编排层', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1', status: 'running' })] }));

    abortRow('run-1', 'r-1');

    expect(vi.mocked(abortRowInOrchestrator)).toHaveBeenCalledWith('run-1', 'r-1');
  });

  it('终止单行：行 id 不存在 → NOT_FOUND（脏 URL 不能真的去杀别人）', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1', status: 'running' })] }));

    expect(() => abortRow('run-1', 'r-other')).toThrowError(/没有这一行/);
    expect(vi.mocked(abortRowInOrchestrator)).not.toHaveBeenCalled();
  });
});

/**
 * 重新评分（Task 7，spec §9）的 api 侧分工。
 *
 * 本层**不重写可用性判据**（那是 contracts 的 `canRescoreRow` + 编排层的 `rescoreRefusal`）：
 * 它只做「这一行在不在这一轮里」的存在性检查，然后把请求转给编排层。故这两条用例钉的是**分工**，
 * 而不是判据本身——判据的用例在 `orchestrator.test.ts` 的「只重跑评分」那一组里。
 *
 * 为什么这一层要讲分工：`abortRow` 与 `rescoreRow` 的形状逐字同形，而职责边界一漂移，
 * 最先出现的症状是「界面拿到了 200，但什么都没发生」——那比一个 409 难查得多。
 */
describe('rescoreRow', () => {
  it('行存在则直通编排层，并把编排层给的那份快照原样返回（不另读一次磁盘）', () => {
    const run = makeRun({
      useAgentJudge: true,
      rows: [makeRow({ id: 'r-1', status: 'judged', diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false } })],
    });
    store.set('run-1', run);
    vi.mocked(rescoreRowInOrchestrator).mockReturnValue({ ...run, status: 'running' });

    expect(rescoreRow('run-1', 'r-1').status).toBe('running');
    expect(vi.mocked(rescoreRowInOrchestrator)).toHaveBeenCalledWith('run-1', 'r-1');
  });

  it('行 id 不存在 → NOT_FOUND，且不惊动编排层（脏 URL 不能拿别人的工作区去评分）', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1' })] }));

    expect(() => rescoreRow('run-1', 'r-other')).toThrowError(/没有这一行/);
    expect(vi.mocked(rescoreRowInOrchestrator)).not.toHaveBeenCalled();
  });

  it('评测不存在 → NOT_FOUND（存在性检查先于转出）', () => {
    expect(() => rescoreRow('nope', 'r-1')).toThrowError(ServiceError);
    expect(vi.mocked(rescoreRowInOrchestrator)).not.toHaveBeenCalled();
  });
});

/**
 * 单行重新执行（2026-09-27 引入，内部名 retry，界面文案「重新执行」）的 api 侧分工：与 `rescoreRow` **逐字同形**——只有存在性检查在本层，
 * 可用性判据与拒绝原因都在编排层。两条路径分开写是因为它们**做的是两件事**：
 * 重评只重跑评分，重新执行连候选 agent 一起重跑（分钟级 vs 几十秒）。
 */
describe('retryRow', () => {
  it('行存在则直通编排层，并把编排层给的那份快照原样返回（不另读一次磁盘）', () => {
    const run = makeRun({
      rows: [makeRow({ id: 'r-1', status: 'failed', diff: { filesChanged: 1, insertions: 1, deletions: 0, truncated: false } })],
    });
    store.set('run-1', run);
    vi.mocked(retryRowInOrchestrator).mockReturnValue({ ...run, status: 'running' });

    expect(retryRow('run-1', 'r-1').status).toBe('running');
    expect(vi.mocked(retryRowInOrchestrator)).toHaveBeenCalledWith('run-1', 'r-1');
  });

  it('行 id 不存在 → NOT_FOUND，且不惊动编排层（脏 URL 不能拿别人的工作区去重跑）', () => {
    store.set('run-1', makeRun({ rows: [makeRow({ id: 'r-1' })] }));

    expect(() => retryRow('run-1', 'r-other')).toThrowError(/没有这一行/);
    expect(vi.mocked(retryRowInOrchestrator)).not.toHaveBeenCalled();
  });

  it('评测不存在 → NOT_FOUND（存在性检查先于转出）', () => {
    expect(() => retryRow('nope', 'r-1')).toThrowError(ServiceError);
    expect(vi.mocked(retryRowInOrchestrator)).not.toHaveBeenCalled();
  });
});

describe('listModelOptions', () => {
  /**
   * 2026-10-06 口径变更带来的期望对象变化：夹具里的模型**都没声明** `supportedEfforts`
   * ⇒ 候选档位从「没有这一格」变成该家的**完整档位域**，故本组三条断言里各多一格 `efforts`。
   * 本组的主题是**协议过滤**（看得见哪些模型），所以档位格按注册表真值回填，
   * 不在这里抄第二份档位表——档位域本身另有 `registry.test.ts` 的守卫与下面「思考强度」那两组的用例。
   */
  it('Claude Code 只看到 anthropic 协议的模型', () => {
    expect(listModelOptions('claude-code')).toEqual([
      {
        providerId: 'p-anthropic',
        providerName: 'Anthropic 网关',
        modelId: 'claude-opus-4-6',
        source: 'manual',
        efforts: getProvider('claude-code').metadata.reasoningEfforts,
      },
    ]);
  });

  it('Codex 只看到 openai 协议的模型（单协议智能体的语义不变）', () => {
    expect(listModelOptions('codex')).toEqual([
      {
        providerId: 'p-openai',
        providerName: 'OpenAI 网关',
        modelId: 'gpt-5',
        source: 'fetched',
        efforts: getProvider('codex').metadata.reasoningEfforts,
      },
    ]);
  });

  /**
   * **本次放宽的靶子**（计划 Task 7）：DSH 两条 wire 都能收（`anthropic-messages` / `openai-responses`），
   * 所以它的候选池是**两类协议的并集**。
   *
   * 为什么这条必须存在：只改元数据、没有这条正向用例的话，「放宽」这件事在测试里**没有靶子**——
   * 把 `protocolTypes` 改回单元素，所有既有用例照样全绿（它们断言的正是「只看得到一种协议」）。
   */
  it('DSH 同时接受两种协议：openai 供应商的模型也进候选池', () => {
    // 顺序 = **供应商清单的顺序**（`listModelOptions` 按 `listProviders()` 逐个 flatMap，
    // 不是按协议集合的顺序）——夹具里 openai 那条排在前面，所以它先出现
    // （`efforts` 这一格的来由见本组开头 2026-10-06 的说明）
    const dshEfforts = getProvider('dsh').metadata.reasoningEfforts;
    expect(listModelOptions('dsh')).toEqual([
      { providerId: 'p-openai', providerName: 'OpenAI 网关', modelId: 'gpt-5', source: 'fetched', efforts: dshEfforts },
      {
        providerId: 'p-anthropic',
        providerName: 'Anthropic 网关',
        modelId: 'claude-opus-4-6',
        source: 'manual',
        efforts: dshEfforts,
      },
    ]);
  });

  it('没有任何匹配协议的供应商时返回空数组（不是全部模型）', () => {
    seedConfig({ providers: [makeProvider()], cases: [makeCase()] });

    expect(listModelOptions('claude-code')).toEqual([]);
  });
});

describe('listAgentModelOptions', () => {
  it('按 AGENT_KINDS 的顺序给出三个 kind 的元数据与候选池', () => {
    const groups = listAgentModelOptions();

    expect(groups.map((group) => group.agentKind)).toEqual(['claude-code', 'codex', 'dsh']);
    expect(groups[0]?.protocolTypes).toEqual(['anthropic']);
    expect(groups[1]?.protocolTypes).toEqual(['openai']);
    // dsh 两条 wire 都能收 ⇒ 集合是两个元素（契约 R37 的收口）
    expect(groups[2]?.protocolTypes).toEqual(['openai', 'anthropic']);
    expect(groups[0]?.options.map((option) => option.modelId)).toEqual(['claude-opus-4-6']);
    expect(groups[1]?.options.map((option) => option.modelId)).toEqual(['gpt-5']);
    // dsh 的候选池是两类协议的**并集**（顺序 = 供应商清单顺序）
    expect(groups[2]?.options.map((option) => option.modelId)).toEqual(['gpt-5', 'claude-opus-4-6']);
  });

  it('把 cancelMidTurn 元数据透出来（DSH 为 false，界面文案要跟着变）', () => {
    const groups = listAgentModelOptions();
    const dsh = groups.find((group) => group.agentKind === 'dsh');

    expect(dsh?.cancelMidTurn).toBe(false);
    expect(groups.find((group) => group.agentKind === 'claude-code')?.cancelMidTurn).toBe(true);
    // dsh 的 usage 以 p3 的真实探测结果为准（spec §5.6.3），这里只断言它是一个布尔
    expect(typeof dsh?.usage).toBe('boolean');
  });

  it('三个 kind 的元数据逐字段等于注册表真值（接缝守卫：api 不许有第二份对应表，A3/R11）', () => {
    // 这一条不是重复断言上面两条：它把「值来自注册表」这件事本身钉住。
    // 若有人在 api 里硬编码 protocolType / usage / cancelMidTurn（或漏透传某一项），
    // 注册表换了值而这里不同步，界面就会按错的文案工作（「终止」写成「关闭运行时」或反之），
    // 而上面那些写死期望值的用例仍会全绿——它们与实现漂移的方向相同。
    for (const group of listAgentModelOptions()) {
      const { metadata } = getProvider(group.agentKind);
      // 集合用 toEqual 比对（逐元素同序）：改成 toBe 就退回「只比一个值」，多协议那家会假绿
      expect(group.protocolTypes).toEqual(metadata.protocolTypes);
      expect(group.usage).toBe(metadata.capability.usage);
      expect(group.cancelMidTurn).toBe(metadata.capability.cancelMidTurn);
      /**
       * **消息能力声明也要透传**（2026-10-04 收口）。
       *
       * 它是界面那四句「这家结构上不支持 / 厂商没投送 / 我们还没接 / 没验证过」的**唯一**来源
       * （`MISSING_REASON_LABELS` 的取值全来自这五格 + 各自的 `source` / `reason`）。
       * 此前 api 只透 `usage` / `cancelMidTurn` 两格，于是整条链路在出口处断掉：
       * 界面拿不到声明 ⇒ 一律回落成 `unverified` ⇒ 三家都被说成「没验证过」，
       * 而真相是「codex 的思考正文只在会话文件里」这种**具体**原因。
       */
      expect(group.messageCapability).toEqual(metadata.messageCapability);
    }
  });

  it('reasoningEfforts 也来自注册表（档位域是智能体的能力，不许在 api 里抄第二份）', () => {
    for (const group of listAgentModelOptions()) {
      expect(group.efforts).toEqual(getProvider(group.agentKind).metadata.reasoningEfforts);
    }
  });

  /**
   * `defaultEffort`（「未选档位」时该家实际会用的档）也来自注册表，且按「有意义才出现」投影。
   *
   * 为什么值得钉：界面拿它拼创建表单的占位符（「未指定（DeepSeek Harness 用 high）」），
   * 而 api 里值写死或改成填一个兜底档，**路由测试与组件测试都不会响**——症状是界面替某一家
   * 承诺一个它根本没声明的缺省档（或反过来，DSH 那半句消失）。故这里逐家与注册表比对 +
   * 把「没声明的家这一格**不存在**」也钉住（写成 `defaultEffort: undefined` 与不写是两件事：
   * 前者在 JSON 里会被丢掉，但形状上仍是一次「我们声明了这一格」）。
   */
  it('defaultEffort 逐家等于注册表真值；没声明的家这一格**不存在**', () => {
    for (const group of listAgentModelOptions()) {
      const declared = getProvider(group.agentKind).metadata.defaultEffort;
      if (declared === undefined) {
        expect('defaultEffort' in group).toBe(false);
      } else {
        expect(group.defaultEffort).toBe(declared);
      }
    }
    // 阳性面对照：今天必须有且只有 DSH 声明它（三家全不声明时上面那个循环会静默全过）
    const withDefault = listAgentModelOptions().filter((group) => group.defaultEffort !== undefined);
    expect(withDefault.map((group) => group.agentKind)).toEqual(['dsh']);
  });
});

/**
 * 思考强度的**交集**与创建期校验（spec D10）。
 * 这一组盯的是「不要让人选完到运行时才失败」：dsh 对不支持的档位是硬报错
 * （`UNSUPPORTED_REASONING_EFFORT`），所以不支持的组合必须在**列选项**与**创建**两处都被拦下；
 * 而「就近取整」（medium → high）是静默改语义，明确不做。
 */
describe('思考强度：候选池交集与创建校验', () => {
  /**
   * 2026-10-06 口径变更（本用例的三条候选断言随之改判据，逐条在下面点名）：
   * ① 上游**没声明** `supportedEfforts` ⇒ 不再是「没有档位可选」，而是给该家**完整档位域**
   *    （本机两个 provider 都是 `source: fetched` 且不带这一格 ⇒ 旧写法让界面连档位都没有）；
   * ② 候选里**恒含关闭档** `EFFORT_OFF` 且排第一——它表达的是「我们这一侧关掉思考」，
   *    不是模型声明的能力，因而不受交集裁剪。
   */
  it('交集 = 上游档位 ∩ 该智能体档位，再并上关闭档；上游没说就给完整档位域', () => {
    const provider = makeAnthropicProvider({
      models: [
        { id: 'three', source: 'manual', supportedEfforts: ['low', 'high', 'max'], recommendedEffort: 'high' },
        { id: 'narrow', source: 'manual', supportedEfforts: ['low', 'medium', 'xhigh'], recommendedEffort: 'medium' },
        { id: 'unknown', source: 'manual' },
      ],
    });
    seedConfig({ providers: [provider] });

    const cc = listModelOptions('claude-code');
    // 变更①的前半：交集照旧，只是前面多了关闭档（上游没声明 off，它不受交集裁剪）
    expect(cc.find((option) => option.modelId === 'three')?.efforts).toEqual([EFFORT_OFF, 'low', 'high', 'max']);
    expect(cc.find((option) => option.modelId === 'narrow')?.efforts).toEqual([EFFORT_OFF, 'low', 'medium', 'xhigh']);
    // 变更①：上游未声明 ⇒ 该家完整档位域（此前断言的是 `undefined`）
    expect(cc.find((option) => option.modelId === 'unknown')?.efforts).toEqual(
      getProvider('claude-code').metadata.reasoningEfforts,
    );
    expect(cc.find((option) => option.modelId === 'unknown')?.recommendedEffort).toBeUndefined();

    // dsh 只认 off/low/high/max ⇒ narrow 的三档里只剩 low，再并上关闭档（变更②，此前是 ['low']）；
    // 推荐档 medium 不在交集里 ⇒ 不给推荐
    const dsh = listModelOptions('dsh');
    expect(dsh.find((option) => option.modelId === 'narrow')?.efforts).toEqual([EFFORT_OFF, 'low']);
    expect(dsh.find((option) => option.modelId === 'narrow')?.recommendedEffort).toBeUndefined();
    expect(dsh.find((option) => option.modelId === 'three')?.recommendedEffort).toBe('high');
  });

  /**
   * 候选构成（2026-10-06 口径变更）：上游**没声明** `supportedEfforts` ⇒ 给该家**完整档位域**
   * （本机两个 provider 都是这种形态，旧写法让界面连档位都没有）；声明过 ⇒ 交集 **∪ 关闭档**
   * （关闭档表达的是「我们这一侧关掉思考」，不受交集裁剪）。
   */
  it('上游未声明档位 ⇒ 候选 = 该家完整档位域；且关闭档恒在其中', () => {
    const provider = makeAnthropicProvider({ models: [{ id: 'unknown', source: 'manual' }] });
    seedConfig({ providers: [provider] });

    const cc = listModelOptions('claude-code').find((option) => option.modelId === 'unknown');
    expect(cc?.efforts).toEqual(getProvider('claude-code').metadata.reasoningEfforts);
    expect(cc?.efforts?.[0]).toBe(EFFORT_OFF);
  });

  it('上游声明过但不含关闭档 ⇒ 关闭档仍在候选里、且排第一', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'three', source: 'manual', supportedEfforts: ['low', 'high', 'max'], recommendedEffort: 'high' }],
    });
    seedConfig({ providers: [provider] });

    const cc = listModelOptions('claude-code').find((option) => option.modelId === 'three');
    expect(cc?.efforts).toEqual([EFFORT_OFF, 'low', 'high', 'max']);
  });

  it('创建时校验：不在交集里 ⇒ INVALID_QUERY 并点名两个值域；在交集里（含关闭档 off）/ 没选 ⇒ 落进快照（或留空）', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'm', source: 'manual', supportedEfforts: ['low', 'high', 'max'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    const bad = (): EvalRun =>
      createRun({
        caseId: 'c-1',
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm', effort: 'medium' }],
      });
    expect(bad).toThrow(ServiceError);
    // 两个值域都要点名：用户才知道是「模型不支持」还是「这家智能体不支持」
    expect(bad).toThrow(/medium/);
    expect(bad).toThrow(/low \/ high \/ max/);

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm', effort: 'high' }],
    });
    expect(run.rows[0]?.effort).toBe('high');

    /**
     * **关闭档也要能落盘**（2026-10-06 fix 轮）：上游只声明了 `low/high/max`，`off` 靠
     * `intersectEfforts` 的并集才在候选里 ⇒ 这一条同时钉住「候选里真有它」与「校验放它过去」。
     * 为什么必须有一条：全仓此前**没有一处**用 `effort: EFFORT_OFF` 建过行（ui 与 api 的用例
     * 都只提交过 `high` / `low`）⇒ 把关闭档从候选里去掉、或让校验误拒它，今天照样全绿，
     * 而症状是「界面选了关闭档 `off`，建行被 400 拦下」。
     */
    const off = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm', effort: EFFORT_OFF }],
    });
    expect(off.rows[0]?.effort).toBe(EFFORT_OFF);

    const bare = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'm' }],
    });
    // 「没说」与「说了 high」在快照里必须分得开
    expect(bare.rows[0]?.effort).toBeUndefined();
  });

  /**
   * **未选也要校验**（2026-10-06，Task 1 评审查出的缺口）：dsh 的「未选」不是「什么都没要求」，
   * 它会真的落到缺省档 `high` ⇒ 该档不在候选里时必须**建行就拒**，否则要跑到 dsh 的硬校验处
   * 才失败（`UNSUPPORTED_REASONING_EFFORT`，正是本计划要避免的「症状离真因很远」）。
   */
  it('未选档位也校验：dsh 的缺省档 high 不在候选里 ⇒ 建行即拒并点名', () => {
    // dsh 的档位域是 off/low/high/max；上游只声明 low ⇒ 候选 = [off, low]，而未选时 dsh 会用 high
    const provider = makeAnthropicProvider({
      models: [{ id: 'only-low', source: 'manual', supportedEfforts: ['low'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    const create = (): EvalRun =>
      createRun({
        caseId: 'c-1',
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ agentKind: 'dsh', providerId: provider.id, modelId: 'only-low' }],
      });
    expect(create).toThrow(ServiceError);
    expect(create).toThrow(/未选档位时/);
    expect(create).toThrow(/high/);
  });

  it('未选 + 该家没声明 defaultEffort（claude / codex）⇒ 不校验，快照里照样留空', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'only-low', source: 'manual', supportedEfforts: ['low'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    const run = createRun({
      caseId: 'c-1',
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: provider.id, modelId: 'only-low' }],
    });
    expect(run.rows[0]?.effort).toBeUndefined();
  });
});

/**
 * `planRunUpdate`：编辑的**逐行处置**（spec §5.1 的那张表）。
 * 这是本功能最容易写错的一处——「多重置一行」等于静默丢分，「少重置一行」等于让待开始的行挂着旧分。
 * 故它被抽成纯函数并在这里**直接**测，不走 HTTP（间接断言盖不住「哪一行被重置了」）。
 */
describe('planRunUpdate', () => {
  const providers = [makeAnthropicProvider(), makeProvider()];
  /** 造一条「跑过且有结果」的行：重置与否一看便知 */
  const judgedRow = (id: string, overrides: Partial<EvalRow> = {}): EvalRow =>
    makeRow({
      id,
      status: 'judged',
      baselineCommit: 'a'.repeat(40),
      tokens: { input: 10, cached: 1, output: 20 },
      turns: 3,
      durationMs: 1_000,
      diff: { filesChanged: 1, insertions: 2, deletions: 0, truncated: false },
      score: {
        // Task 2 的评分契约：模型只给逐项二元判定，总分与满分由系统按权重加总。
        // 这一行按「A1（80 分，达成）+ A2（20 分，未达成）」这张表打出来 ⇒ 80 分 / 满分 100。
        // 本组用例断言的是「重置有没有把这一行的分清掉」，与分是怎么算出来的无关
        judgments: [
          { id: 'A1', achieved: true, reason: '夹具：这一项达成' },
          { id: 'A2', achieved: false, reason: '夹具：这一项未达成' },
        ],
        totalScore: 80,
        maxScore: 100,
        verdict: '好',
        raw: '{}',
        judgeProviderId: 'p-anthropic',
        judgeModelId: 'claude-opus-4-6',
        judgedAt: '2026-09-22T09:00:00.000Z',
        judgeAgentKind: null,
        // 强度未指定（一个强度键都没发）：本组用例不涉及强度通路
        judgeEffort: null,
        structuredOutput: false,
        // 评分自己的花销（2026-10-08）：本组用例不涉及这两格
        judgeTokens: null,
        judgeDurationMs: null,
      },
      attempts: 2,
      ...overrides,
    });

  /**
   * 轮级快照里那张评分表（`EvalRun.rubric`）。三处刻意用**不同**的表：
   * 「换了用例就重取」与「没换用例就逐字保留」这两件事，用同一张表是分辨不出来的
   * （两种实现都会绿）——而「改了用例的评分表不许改写历史」正是不快照它就守不住的那条。
   */
  const targetRubric: Rubric = { groups: [{ name: '一、目标用例的评分表', items: [{ id: 'B1', goal: '目标项', weight: 5 }] }] };
  const editedRubric: Rubric = { groups: [{ name: '一、用户后来改过的评分表', items: [{ id: 'C1', goal: '改过的项', weight: 7 }] }] };
  /**
   * 这一轮**当初**拍下的那把尺子（保留侧的那个值）。
   * 必须有值、且与上面两张都不同：拿夹具缺省当保留侧时它是 `undefined`，
   * 于是「只改执行模式」那条守卫只能拦住「被改成了别的表」，拦不住「被丢掉 / 清空」——
   * 不变式的一半是空的（这正是本文件那条守卫此前的问题）。
   */
  const preservedRubric: Rubric = { groups: [{ name: '一、这一轮创建时的评分表', items: [{ id: 'A1', goal: '保留侧的目标', weight: 9 }] }] };

  const target: RunTargetCase = {
    caseId: 'c-1',
    caseTitle: '用例标题',
    repoPath: 'D:\\projects\\gateway',
    commitHash: null,
    repoBranch: null,
    rubric: targetRubric,
  };

  /**
   * 「跑过一轮」的轮次要带上 `startedAt`：`settleRunAfterEdit` 正是按它区分「一次都没跑过」与
   * 「跑过一轮、现在又有行待跑」（spec §5.1 口径 3）。有 judged 行却没有 `startedAt` 的轮次
   * 在真实数据里不存在（跑过就一定写过它），按那种形状造夹具会让断言落在错的分支上。
   */
  const ranRun = (overrides: Partial<EvalRun> = {}): EvalRun =>
    makeRun({
      status: 'done',
      startedAt: '2026-09-22T08:00:00.000Z',
      finishedAt: '2026-09-22T09:00:00.000Z',
      ...overrides,
    });

  /**
   * 轮级那六格用例快照（`caseId` + 五格冗余字段，含 `rubric`）。
   * A（终审 Important）的判据就是它：`caseId` 没变时这六格必须**逐字保留**——取成对象整体 `toEqual`，
   * 任一格跟着当前用例漂了都会红（`rubric` 那一格漂了 = 改了用例的评分表就改写了历史分数）。
   */
  const caseSnapshotOf = (
    run: EvalRun,
  ): Pick<EvalRun, 'caseId' | 'caseTitle' | 'repoPath' | 'commitHash' | 'repoBranch' | 'rubric'> => ({
    caseId: run.caseId,
    caseTitle: run.caseTitle,
    repoPath: run.repoPath,
    commitHash: run.commitHash,
    repoBranch: run.repoBranch,
    rubric: run.rubric,
  });

  it('只改执行模式：所有行逐字不变（含分数 / diff / 计量 / attempts）', () => {
    const row = judgedRow('r-1');
    const run = makeRun({ rows: [row], executionMode: 'parallel' });
    const input = {
      caseId: 'c-1',
      executionMode: 'serial' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    expect(next.executionMode).toBe('serial');
    expect(next.rows).toEqual([row]);
    // 轮级状态跟着行集合收敛：全 judged ⇒ done
    expect(next.status).toBe('done');
  });

  /**
   * A（终审 Important）：**没换用例就不许动轮级快照**。
   *
   * 症状链（可达路径，不是理论）：用户改的是**用例自己**的 `commitHash` / `repoPath`（`CasePatchSchema`
   * 是 `CaseCreateSchema.partial()`，允许改），此后哪怕只想把这一轮从串行改成并行，无条件按当前用例
   * 重写快照也会让这一轮的「复现条件」变成新 commit，而每一行还挂着在**旧** commit 上挣来的分；
   * 再点「开始」时 pending / failed 的行按 `run.commitHash` 重跑 ⇒ **一轮里两条基线**，两端都不报错
   * （客户端按 `caseId` 判「同一用例」，连作废确认框都不会弹）。
   *
   * 为什么现有用例看不见：`makeCase` 与 `makeRun` 的五格取值逐字相同，无条件重写在它们眼里等于没改。
   * 故这条用例**刻意让两边全不相同**（`caseId` 相同 = 同一个用例被改过）。
   */
  it('只改执行模式：用例快照逐字保留（用例自己的 commit / 仓库改过，也不许跟着漂过来）', () => {
    const row = judgedRow('r-1');
    const run = ranRun({
      caseId: 'c-1',
      caseTitle: '旧标题（建这一轮时的快照）',
      repoPath: 'D:\\projects\\old-gateway',
      commitHash: 'b'.repeat(40),
      repoBranch: 'main',
      // 保留侧必须是个**具体的**表（不是夹具缺省）：否则「被丢掉 / 清空」这一半拦不住
      rubric: preservedRubric,
      rows: [row],
    });
    // 当前用例：六格与上面**全不相同**（`rubric` 也换一张，否则「无条件重写」瞒得过这一条）
    const editedCase: RunTargetCase = {
      caseId: 'c-1',
      caseTitle: '新标题（用户后来改用例改的）',
      repoPath: 'D:\\projects\\new-gateway',
      commitHash: 'c'.repeat(40),
      repoBranch: 'release',
      rubric: editedRubric,
    };
    const input = {
      caseId: 'c-1',
      executionMode: 'serial' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), editedCase);

    // 五格逐字不变（任一格跟着 `editedCase` 漂了就红）
    expect(caseSnapshotOf(next)).toEqual(caseSnapshotOf(run));
    expect(next.executionMode).toBe('serial');
    // 行也一行都不动（spec §5.1 处置表的第一行：只改执行模式）
    expect(next.rows).toEqual([row]);
  });

  /**
   * F1：重置必须把失败归因（`error`）一起清掉。
   *
   * 为什么值得单独一条：夹具里的行 `error` 恒为 `null`（`makeRow` 的初值），于是「漏清 error」这一格
   * 在别的用例眼里等于「本来就是 null」——把 `resetRow` 里那句 `error: null` 删掉，既有用例**一条都不红**。
   * 症状：换了模型的行回到「待开始」，卡片上却还挂着**上一任被评对象**的失败原因（R9 的归因是那一次跑的事实）。
   */
  it('重置清掉失败归因：换了模型的行不再挂着旧 error', () => {
    const failed = judgedRow('r-1', {
      status: 'failed',
      error: { code: 'UPSTREAM_5XX', message: '上游 502', stage: 'agent' },
    });
    const run = ranRun({ rows: [failed] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    expect(next.rows[0]?.error).toBeNull();
    // 归因只是「那一笔失败的事实」，重置后这一行连状态都换了
    expect(next.rows[0]?.status).toBe('pending');
  });

  it('改某行模型：**只有那一行**重置，其余行逐字不变', () => {
    const changed = judgedRow('r-1');
    const untouched = judgedRow('r-2');
    const run = ranRun({ rows: [changed, untouched] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' },
        { id: 'r-2', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
      ],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    const reset = next.rows.find((row) => row.id === 'r-1');
    expect(reset?.status).toBe('pending');
    expect(reset?.score).toBeNull();
    expect(reset?.diff).toBeNull();
    expect(reset?.tokens).toBeNull();
    expect(reset?.turns).toBeNull();
    expect(reset?.durationMs).toBeNull();
    expect(reset?.baselineCommit).toBe('');
    expect(reset?.attempts).toBe(0);
    // 行身份稳定：id / 分支 / 工作区路径一个字都不变（原地重置，spec §3 D4）
    expect(reset?.branch).toBe(changed.branch);
    expect(reset?.workspacePath).toBe(changed.workspacePath);
    // 服务端快照跟着新供应商走
    expect(reset?.providerName).toBe('OpenAI 网关');
    expect(reset?.baseUrl).toBe('https://gw.example.com/v1');
    // 没被碰的那一行逐字不变
    expect(next.rows.find((row) => row.id === 'r-2')).toEqual(untouched);
    // attempts 归零的理由：换了被评对象，旧模型的账不能算到新模型头上（与 retryRow 刻意不清零相反）
    expect(next.status).toBe('partial');
  });

  it('新增一行：新 id / branch=test/{id} / workspacePath 落在 run.workspaceBase 下', () => {
    const run = ranRun({ workspaceBase: 'D:\\runs-old', rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    const added = next.rows[1];
    expect(added?.status).toBe('pending');
    expect(added?.attempts).toBe(0);
    expect(added?.baselineCommit).toBe('');
    // E1（spec §5.4 明文要求）：新行的 id **非空且不等于任何原行 id**。
    // 只钉「两条路径的 id 互不相同」（下面那条差分守卫）盖不住这一格：复用**同一轮里**某一行的 id
    // 照样能过那条，而快照里就出现两行同 id——`rowKey` / 行工作区 / 事件目录三处同时撞车，
    // 界面上的候选数与进度分母还会各算一份，两端都不报错。
    expect(added?.id).toBeTruthy();
    expect(run.rows.map((row) => row.id)).not.toContain(added?.id);
    expect(added?.branch).toBe(`test/${added?.id ?? ''}`);
    // ⚠️ 必须落在**这一轮自己记录的根**下：用当前 settings.workspaceRoot 算会让产物裂成两半（spec §3 D13）
    expect(added?.workspacePath).toBe(rowWorkspaceDir('D:\\runs-old', run.id, added?.id ?? ''));
    expect(next.status).toBe('partial');
  });

  /**
   * **差分守卫**：创建路径与「编辑新增」路径造出来的行必须逐字段相同，只有三格**行身份**
   * （`id` / `branch` / `workspacePath`）各自独立。两条路径共用 `buildRow` 就是为了这件事，
   * 而这条用例不重复任何一格的期望值，只钉「两条路径不许各自漂移」。
   * 为什么值得单独守：初值漏一格或写歪一格的症状不是「少显示一个字段」——`EvalRowSchema` 的必填格缺失
   * 会让 `saveRun` 拒绝，或让 `listRuns()` **静默跳过整轮**（「我的评测记录凭空少了几轮」）。
   */
  it('创建的行与编辑新增的行逐字段相同（除 id / branch / workspacePath 三格行身份）', () => {
    // 上游声明过档位才可选强度 ⇒ 顺带把 `effort` 的写法也纳入这条比较（它正是被迫改三处的那一格）
    const provider = makeAnthropicProvider({
      models: [{ id: 'claude-opus-4-6', source: 'manual', supportedEfforts: ['low', 'high'] }],
    });
    seedConfig({ providers: [provider], cases: [makeCase()] });

    // 创建路径：真实走一次 createRun（它自己从配置里读供应商）
    const created = createRun({
      caseId: 'c-1',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6', effort: 'high' }],
    });

    // 编辑路径：同一条候选（同 kind / 供应商 / 模型 / 档位）作为**新行**加进另一轮
    const run = ranRun({ rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6', effort: 'high' },
      ],
    };
    const addedRow = planRunUpdate(run, input, resolveRunRows(input.rows, [provider]), target).rows[1]!;
    const createdRow = created.rows[0]!;

    /** 摘掉三格**行身份**（它们本来就该各自独立），只比其余字段 */
    const withoutIdentity = ({ id, branch, workspacePath, ...rest }: EvalRow): Omit<EvalRow, 'id' | 'branch' | 'workspacePath'> => rest;

    // 用 `toStrictEqual` 而不是 `toEqual`：后者**忽略值为 undefined 的键**，
    // 于是「新增行漏了一格初值」在它眼里等于「没写这一格」——正是这条守卫最该抓住的那种漂移。
    expect(withoutIdentity(addedRow)).toStrictEqual(withoutIdentity(createdRow));
    // 三格行身份确实各自独立（否则上面那条比较会因为「本来就一样」而失去意义）
    expect(addedRow.id).not.toBe(createdRow.id);
    expect(addedRow.branch).toBe(`test/${addedRow.id}`);
  });

  it('删掉一行：从快照消失，其余行不变', () => {
    const run = makeRun({ rows: [judgedRow('r-1'), judgedRow('r-2')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-2', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);

    expect(next.rows.map((row) => row.id)).toEqual(['r-2']);
  });

  it('patch 里带未知行 id ⇒ NOT_FOUND（不许静默当新行：那会凭空多出一行用户没打算要的候选）', () => {
    const run = makeRun({ rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-404', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };

    expect(() => planRunUpdate(run, input, resolveRunRows(input.rows, providers), target)).toThrowError(/r-404/);
  });

  /**
   * 同一个行 id 在入参里出现两次 ⇒ `INVALID_QUERY`。
   * 必须在服务端拦：`resolved.map` 会把两条都落到**同一个**现有行上，快照里那一行就出现两次——
   * 候选数、进度分母、排名全部多算一份，而两端都不报错。孪生的那条（id 不在这一轮里 ⇒ NOT_FOUND）
   * 本来就只能在这里判，故两条 id 完整性检查留在同一处，不放进契约的 schema。
   */
  it('同一行 id 出现两次 ⇒ INVALID_QUERY（不许把同一行算两遍）', () => {
    const run = makeRun({ rows: [judgedRow('r-1'), judgedRow('r-2')] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
        { id: 'r-1', agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' },
      ],
    };

    let caught: unknown;
    try {
      planRunUpdate(run, input, resolveRunRows(input.rows, providers), target);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('INVALID_QUERY');
    expect((caught as ServiceError).message).toContain('r-1');
    expect((caught as ServiceError).message).toContain('重复');
  });

  it('换来用例：重取五格快照（含评分表），且**所有行**重置（题面与基线都变了）', () => {
    const run = makeRun({ caseId: 'c-1', caseTitle: '旧标题', repoPath: 'D:\\old', rows: [judgedRow('r-1')] });
    const input = {
      caseId: 'c-2',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    };
    const newCase: RunTargetCase = {
      caseId: 'c-2',
      caseTitle: '新标题',
      repoPath: 'D:\\new',
      commitHash: 'b'.repeat(40),
      repoBranch: 'feat/x',
      rubric: targetRubric,
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, providers), newCase);

    expect([next.caseId, next.caseTitle, next.repoPath, next.commitHash, next.repoBranch]).toEqual([
      'c-2', '新标题', 'D:\\new', 'b'.repeat(40), 'feat/x',
    ]);
    // 换过去的那张评分表必须跟着走：不重取的话，新用例的行会拿**旧用例**的尺子评分
    // （评分阶段读的是 `run.rubric` 这份快照，不是用例现取的那一份）
    expect(next.rubric).toEqual(targetRubric);
    // 目标一个字都没变，但题面变了 ⇒ 照样重置
    expect(next.rows[0]?.status).toBe('pending');
    expect(next.rows[0]?.score).toBeNull();
    expect(next.rows[0]?.attempts).toBe(0);
  });

  it('轮级状态收敛三条分支（没跑过 ⇒ idle / 跑过又有待跑 ⇒ partial / 全 judged ⇒ done 且保留 finishedAt）', () => {
    const pending = makeRow({ id: 'r-1', status: 'pending', baselineCommit: '', attempts: 0 });
    const untouchedRows = [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }];
    const input = { caseId: 'c-1', executionMode: 'parallel' as const, useAgentJudge: false, rows: untouchedRows };
    const resolved = resolveRunRows(input.rows, providers);

    const neverStarted = planRunUpdate(makeRun({ rows: [pending], status: 'idle', startedAt: null }), input, resolved, target);
    expect(neverStarted.status).toBe('idle');
    expect(neverStarted.finishedAt).toBeNull();

    const ranBefore = planRunUpdate(
      ranRun({ rows: [judgedRow('r-1')] }),
      { ...input, rows: [{ ...untouchedRows[0]!, agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' }] },
      resolveRunRows([{ agentKind: 'codex' as const, providerId: 'p-openai', modelId: 'gpt-5' }], providers),
      target,
    );
    expect(ranBefore.status).toBe('partial');
    expect(ranBefore.finishedAt).toBeNull();

    const stillDone = planRunUpdate(
      ranRun({ rows: [judgedRow('r-1')] }),
      input,
      resolved,
      target,
    );
    expect(stillDone.status).toBe('done');
    expect(stillDone.finishedAt).toBe('2026-09-22T09:00:00.000Z');
  });

  /**
   * 强度（spec D12）是**这一行的配置**，与 agent / 模型同级：编辑换掉被评对象时它必须跟着换。
   * 两条面都要钉住——「新档位没写进去」（这一行按旧档位跑）与「清回默认后旧键还留着」
   * （界面显示默认、实际按旧档位跑）都是静默的错配，而 `...current` 的展开正好会犯第二种。
   */
  it('强度跟着行配置一起进重置后的快照：换档位写新值，清回默认不留旧键', () => {
    // 强度要落进快照，上游就得**声明**过档位（交集不为空才可选）：与上面「思考强度」那一组同一条口径。
    // 两个模型都声明同一组档位，于是这一次编辑里「换了模型」与「换了档位」同时发生。
    const provider = makeAnthropicProvider({
      models: [
        { id: 'm-old', source: 'manual', supportedEfforts: ['low', 'high'] },
        { id: 'm-new', source: 'manual', supportedEfforts: ['low', 'high'] },
      ],
    });
    const run = ranRun({ rows: [judgedRow('r-1', { modelId: 'm-old', effort: 'high' })] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'm-new', effort: 'low' }],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, [provider]), target);
    expect(next.rows[0]?.effort).toBe('low');

    // 表单把这一行的强度清回「默认」：重置后的快照里连这把键都不该有（与 createRun 的「缺省不写键」同口径）。
    // 只改强度本身现在也会触发重置（`d1b79fa` 起 `isSameRowTarget` 计入 effort）；这条夹具沿用上面那一段
    // 同时换了模型，不影响本格断言。
    const cleared = {
      ...input,
      rows: [{ id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'm-new' }],
    };
    const afterClear = planRunUpdate(run, cleared, resolveRunRows(cleared.rows, [provider]), target);
    expect(afterClear.rows[0]?.status).toBe('pending');
    expect(afterClear.rows[0]).not.toHaveProperty('effort');
  });

  /**
   * 只改某行的**强度**（其余身份格一个字都不动）⇒ 只有那一行被重置，且快照里写的是新的档位。
   * 这一条覆盖的是**接线**：`resolveRunRows` 保留下来的 `effort` 必须真的走进 `isSameRowTarget` 的比较
   * （`d1b79fa` 起判据计入 effort）。契约那一侧只覆盖判据本身——接不上线的症状是「保存成功、档位没变」。
   */
  it('只改某行的强度 ⇒ 只有那一行重置且快照写新档位，其余行逐字不变', () => {
    const provider = makeAnthropicProvider({
      models: [{ id: 'claude-opus-4-6', source: 'manual', supportedEfforts: ['low', 'high'] }],
    });
    const untouched = judgedRow('r-2');
    const run = ranRun({ rows: [judgedRow('r-1', { effort: 'high' }), untouched] });
    const input = {
      caseId: 'c-1',
      executionMode: 'parallel' as const,
      useAgentJudge: false,
      rows: [
        { id: 'r-1', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6', effort: 'low' },
        { id: 'r-2', agentKind: 'claude-code' as const, providerId: 'p-anthropic', modelId: 'claude-opus-4-6' },
      ],
    };

    const next = planRunUpdate(run, input, resolveRunRows(input.rows, [provider]), target);

    const changed = next.rows.find((row) => row.id === 'r-1');
    expect(changed?.status).toBe('pending');
    expect(changed?.score).toBeNull();
    expect(changed?.diff).toBeNull();
    expect(changed?.attempts).toBe(0);
    // 保留的 effort 必须一路走到快照里（不只是参与比较）
    expect(changed?.effort).toBe('low');
    // 行身份稳定；没被碰的那一行逐字不变
    expect(changed?.branch).toBe('test/r-1');
    expect(next.rows.find((row) => row.id === 'r-2')).toEqual(untouched);
  });

  it('resolveRunRows：供应商不存在 / 模型不在清单 / 协议不匹配三条各自抛出（与创建同一份）', () => {
    const bad = (providerId: string, modelId: string) => [{ agentKind: 'codex' as const, providerId, modelId }];
    expect(() => resolveRunRows(bad('p-gone', 'gpt-5'), providers)).toThrowError(/p-gone/);
    expect(() => resolveRunRows(bad('p-openai', 'nope'), providers)).toThrowError(/模型清单/);
    expect(() => resolveRunRows([{ agentKind: 'claude-code' as const, providerId: 'p-openai', modelId: 'gpt-5' }], providers)).toThrowError(/协议/);
  });
});

/**
 * 编辑一轮评测（spec §5.1）的 api 侧：**校验 → 算新快照 → 落盘**，且顺序承重。
 * 这一组钉的是那三件在纯函数层看不见的事——「能不能改」的判据先跑、校验失败一个字节都不写、
 * 落盘的是新快照而不是内存里那一份。逐行处置（哪一行被重置）在 `planRunUpdate` 那一组里。
 */
describe('updateRun', () => {
  /** 落一盘「已经跑过一轮」的评测，返回它的快照 */
  function seedJudgedRun(): EvalRun {
    const run = makeRun({
      rows: [
        makeRow({
          id: 'r-1',
          status: 'judged',
          baselineCommit: 'a'.repeat(40),
          score: {
            // 与 `planRunUpdate` 那一组的 `judgedRow` 同一形状（逐项判定 + 满分快照）：
            // 这一行「跑过一轮且出过分」——编辑之后它该被逐字保留
            judgments: [
              { id: 'A1', achieved: true, reason: '夹具：这一项达成' },
              { id: 'A2', achieved: false, reason: '夹具：这一项未达成' },
            ],
            totalScore: 80,
            maxScore: 100,
            verdict: '好',
            raw: '{}',
            judgeProviderId: 'p-anthropic',
            judgeModelId: 'claude-opus-4-6',
            judgedAt: '2026-09-22T09:00:00.000Z',
            judgeAgentKind: null,
            // 强度未指定（一个强度键都没发）：本组用例不涉及强度通路
            judgeEffort: null,
            structuredOutput: false,
            // 评分自己的花销（2026-10-08）：本组用例不涉及这两格
            judgeTokens: null,
            judgeDurationMs: null,
          },
          attempts: 1,
        }),
      ],
      status: 'done',
      startedAt: '2026-09-22T08:00:00.000Z',
      finishedAt: '2026-09-22T09:00:00.000Z',
    });
    store.set(run.id, run);
    return run;
  }

  it('只改执行模式：落盘的 executionMode 变了，行与轮级结果逐字保留', () => {
    const before = seedJudgedRun();

    const next = updateRun(before.id, {
      caseId: before.caseId,
      executionMode: 'serial',
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(next.executionMode).toBe('serial');
    expect(next.status).toBe('done');
    expect(next.rows).toEqual(before.rows);
    // 「先全校验、再一次性落盘」：store 里那一份也必须是新的
    expect(store.get(before.id)?.executionMode).toBe('serial');
    expect(store.get(before.id)?.rows).toEqual(before.rows);
  });

  it('换模型 ⇒ 那一行重置并落盘（评分 / diff / 基线 / attempts 全清）', () => {
    const before = seedJudgedRun();

    const next = updateRun(before.id, {
      caseId: before.caseId,
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' }],
    });

    expect(next.rows[0]?.status).toBe('pending');
    expect(next.rows[0]?.score).toBeNull();
    expect(next.rows[0]?.attempts).toBe(0);
    expect(next.rows[0]?.providerName).toBe('OpenAI 网关');
    expect(store.get(before.id)?.rows[0]?.status).toBe('pending');
  });

  it('运行中 ⇒ CONFLICT（界面上入口也置灰，两层同一判据）', () => {
    const before = seedJudgedRun();
    store.set(before.id, { ...before, status: 'running' });

    let caught: unknown;
    try {
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      });
    } catch (error) {
      caught = error;
    }

    // 只钉文案等于没钉 409：路由层（Task 5）按 **code** 映射 HTTP 状态，文案是给人看的
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    expect((caught as ServiceError).message).toContain('运行');
  });

  it('校验失败 ⇒ 一个字节都不写（store 保持原样）', () => {
    const before = seedJudgedRun();

    expect(() =>
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ id: 'r-1', agentKind: 'codex', providerId: 'p-gone', modelId: 'gpt-5' }],
      }),
    ).toThrowError(/p-gone/);
    expect(store.get(before.id)).toEqual(before);
  });

  /**
   * 「落盘前再调一次编排层的活性守卫」（`assertRunMutable`）——A3 的顺序里最容易丢的一环：
   * 它抛的时候，盘上必须还是原样。替身是可抛的（见文件头的 mock 说明）：真实实现读的是编排层的
   * 在途任务表，本层没有在途任务 ⇒ 恒通过，这条不变式就永远没人守。
   * 为什么值得单独一条：快照上「没有活」而任务还在收尾的那一拍（行刚落终态、`finally` 还没跑），
   * 正是这条守卫存在的唯一理由——按那份旧快照写下去，会盖掉编排层正在写的那一份。
   */
  it('编排层说「上一轮还没收尾」⇒ CONFLICT 原样透出，且一个字节都不写', () => {
    const before = seedJudgedRun();
    const thrown = new ServiceError('CONFLICT', '这一轮上一次的运行还没收尾（run-1）：请稍候再试，或先终止它');
    vi.mocked(assertRunMutable).mockImplementation(() => {
      throw thrown;
    });

    let caught: unknown;
    try {
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: false,
        rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      });
    } catch (error) {
      caught = error;
    }

    // 原样透出：api 不吞、不包装（吞掉它，界面会拿到一个「成功」，而什么都没改）
    expect(caught).toBe(thrown);
    expect((caught as ServiceError).code).toBe('CONFLICT');
    // 守卫在 `saveRun` **之前**：它抛了就不许有任何写入（把落盘提到守卫之前 ⇒ 这条必红）
    expect(store.get(before.id)).toEqual(before);
  });

  it('换用例 ⇒ 用例快照重取，行全部重置', () => {
    const before = seedJudgedRun();
    // 再加一个用例：标题 / 仓库都不同，且带一个 commit（`seedConfig` 会整体覆盖 providers 与 cases，
    // 故必须把 `beforeEach` 里那两家供应商与 c-1 一起带上）
    seedConfig({
      providers: [makeProvider(), makeAnthropicProvider()],
      cases: [
        makeCase(),
        makeCase({ id: 'c-2', title: '另一个用例', repoPath: 'D:\\projects\\other', commitHash: 'c'.repeat(40) }),
      ],
    });

    const next = updateRun(before.id, {
      caseId: 'c-2',
      executionMode: 'parallel',
      useAgentJudge: false,
      rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
    });

    expect(next.caseTitle).toBe('另一个用例');
    expect(next.repoPath).toBe('D:\\projects\\other');
    expect(next.rows[0]?.status).toBe('pending');
  });

  it('开着「使用智能体评分」而设置页没配 ⇒ CONFLICT，且不落盘（与创建同一份判定）', () => {
    const before = seedJudgedRun();

    expect(() =>
      updateRun(before.id, {
        caseId: before.caseId,
        executionMode: 'serial',
        useAgentJudge: true,
        rows: [{ id: 'r-1', agentKind: 'claude-code', providerId: 'p-anthropic', modelId: 'claude-opus-4-6' }],
      }),
    ).toThrowError(/评分智能体|评分/);
    expect(store.get(before.id)).toEqual(before);
  });

  it('不存在的轮次 ⇒ NOT_FOUND', () => {
    expect(() =>
      updateRun('nope', { caseId: 'c-1', executionMode: 'serial', useAgentJudge: false, rows: [{ agentKind: 'codex', providerId: 'p-openai', modelId: 'gpt-5' }] }),
    ).toThrowError(/评测不存在/);
  });
});

describe('deleteRun（api 层）', () => {
  it('存在性检查 + 转编排层，并把 workspaceRemoved 原样回给界面', () => {
    const run = makeRun();
    store.set(run.id, run);
    vi.mocked(deleteRunInOrchestrator).mockReturnValue({ workspaceRemoved: false });

    expect(deleteRun(run.id)).toEqual({ workspaceRemoved: false });
    expect(vi.mocked(deleteRunInOrchestrator)).toHaveBeenCalledWith(run.id);
  });

  /**
   * 顺序才是这道检查存在的**唯一理由**（见 `runs.ts` 里 `deleteRun` 的 JSDoc）：编排层的
   * `getRunForWrite` 有「按进程内记忆兜底」的分支，**先委派**的话，一个留在旧根、当前根里看不到的
   * 轮次会被解析出来，**它的工作区会被真的删掉**——正是本条用例名自称要防的那件事。
   * 故这里不只断言「检查存在」，还断言「委派一次都没发生」：两行对调 ⇒ 这条必红
   * （只断言抛错是拦不住的：先委派时 `getRunSnapshot` 照样抛 `/评测不存在/`）。
   */
  it('不存在 ⇒ NOT_FOUND（脏 URL 不能删到别人的目录）', () => {
    expect(() => deleteRun('nope')).toThrowError(/评测不存在/);
    // 先查存在、再委派：被拦下的这一轮不许惊动编排层（`beforeEach` 已清过调用历史）
    expect(vi.mocked(deleteRunInOrchestrator)).not.toHaveBeenCalled();
  });
});
