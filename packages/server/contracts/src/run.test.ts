// @vitest-environment node
/**
 * 评测契约：智能体真源、行状态机、EvalRow / EvalRun 形状、创建 / 编辑入参、diff 响应、
 * 三个行级动作判据，以及编辑与删除共用的两条判据（`hasLiveRows` / `isSameRowTarget`）。
 * 注意：本文件最有价值的六条守卫分别是
 *   ① AGENT_KINDS 与注册表同序同值；
 *   ② TERMINAL_ROW_STATUSES / ROW_STATUS_LABELS 覆盖全部状态（新增状态时忘同步会当场红）；
 *   ③ isRunnableRow 的集合划分（judged 不可重跑，preparing/running/judging 不是「可执行」而是「在跑」）；
 *   ④ EvalRow.baselineCommit 必填但允许空串（没有它 diff 没有可比基线；空串 = 尚未准备）；
 *   ⑤ EvalRow.providerId 必填（展示快照会被改名，凭据只能按 id 定位）；
 *   ⑥ EvalRow.error.code 必填（界面要靠它区分超时 / 限流 / 密钥无效 / 评分解析失败）。
 * 另有几组守卫各有其靶子（见各 it 内注释）：本文件消费的 `ScoreResultSchema`
 * 与 `diff` / `tokens` 形状、`RunCreate.providerId` 必填（把 `ScoreResultSchema` 换成 `z.any()` 会全绿）；
 * `canRescoreRow` / `canRetryRow` 的真值表**各自独立**钉一遍——两者今天同源（都只保留「不在跑 /
 * 有可比基线 / 有已产出改动」这三条硬前提，`judged` 行已按用户口径「已出分、无报错时取消禁用」放开），
 * 但它们的**语义不是一件事**（整段重跑 vs 只重跑评分），同源是当前事实而不是不变量。
 * `RunUpdateSchema`（创建入参的超集，差别只有候选行可带
 * `id`）与 `hasLiveRows` / `isSameRowTarget`——后两条都只有一个理由：界面用它决定按钮的 `disabled`、
 * 服务端拿同一份抛 `CONFLICT`，各写一份必然漂移；`isSameRowTarget` 还多一个消费方（保存前的确认框
 * 要事先算出会作废哪几行），漂移的症状是「说作废 2 行、实际作废 1 行」。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_KINDS,
  AGENT_LABELS,
  AgentKindSchema,
  EvalRowSchema,
  EvalRowStatusSchema,
  EvalRunSchema,
  ExecutionModeSchema,
  ROW_STATUS_LABELS,
  ROW_MCP_BASIS_LABELS,
  ROW_MCP_CHANNELS,
  ROW_MCP_VERDICT_LABELS,
  ROW_SKILL_BASES,
  ROW_SKILL_BASIS_LABELS,
  ROW_SKILL_VERDICT_LABELS,
  ROW_SKILL_VERDICTS,
  FollowUpAvailabilitySchema,
  FollowUpVerdictSchema,
  RowDiffFileSchema,
  RowDiffIndexSchema,
  RowMcpBasisSchema,
  RowMcpChannelSchema,
  RunCreateSchema,
  RunUpdateSchema,
  TERMINAL_ROW_STATUSES,
  canFollowUpRow,
  canRescoreRow,
  canRetryRow,
  canRunRow,
  hasLiveRows,
  isRunnableRow,
  isRunningRow,
  isSameRowTarget,
  isValidSkillPairing,
  type EvalRow,
  type EvalRowStatus,
  type EvalRun,
  type FollowUpFacts,
  type RowMcpServer,
  type RowSkillBasis,
  type RowSkillInstall,
  type RowSkillVerdict,
} from './run';

/** 一个字段齐全的候选行；只覆盖要测的那一格 */
function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: 'row-1',
    agentKind: 'codex',
    providerId: 'p1',
    providerName: '测试供应商',
    baseUrl: 'https://fake.invalid/v1',
    modelId: 'm1',
    status: 'judged',
    branch: 'test/row-1',
    workspacePath: 'C:/runs/run-1/rows/row-1/workspace',
    baselineCommit: 'a'.repeat(40),
    tokens: null,
    turns: null,
    durationMs: null,
    diff: { filesChanged: 1, insertions: 2, deletions: 3, truncated: false },
    score: null,
    error: null,
    // 这一行走过几次尝试：这一份是「已评分的行」，故是 1 次
    attempts: 1,
    sessionId: null,
    followUps: 0,
    followUpRounds: 0,
    ...overrides,
  };
}

/**
 * 类型面判据（**真判据是 `tsc` 见红**，不是下面那条运行时影子断言）：`emptyAnswer` 不许退化成必填键。
 *
 * 为什么载重：「这一格可以缺席」是旧 `run.json` 还能被读出来的前提。改成 `z.boolean()`、加
 * `.default(false)`、或去掉 `.optional()` 之后，旧轮次的每一行都会卡在解析上，而运行期的表现只是
 * **「旧轮次从列表里消失」**（`listRuns()` 静默跳过解析失败的那一轮）——一个不报错、只少东西的故障，
 * 测试里也几乎看不见。这条断言把它变成一次编译失败。手法同 `inject-message.test.ts` 那四个格。
 */
type RequiredCell<T, K extends keyof T> = undefined extends T[K] ? false : true;
const emptyAnswerIsOptional: RequiredCell<EvalRow, 'emptyAnswer'> = false;


describe('`EvalRow.emptyAnswer` 是**三态**，旧数据缺席即「未记录」', () => {
  /**
   * 要拦的缺陷：把「缺席」读成 `false`。对**旧的** `run.json` 我们并不知道当时有没有答，
   * `false` 是**断言「它答了」**——而 `false` 恰好是要防的误读方向（真出了空答复却照旧
   * 拿分的行，回看时反而显示正常）。判据因此是「**缺席不等于 `false`**」。
   */
  it('旧数据缺这一格 ⇒ 解析通过，且**不是** `false`（是未记录）', () => {
    const legacy = makeRow() as Record<string, unknown>;
    delete legacy['emptyAnswer'];
    const parsed = EvalRowSchema.parse(legacy);
    expect(parsed.emptyAnswer, '缺席必须读成「未记录」，不能当成「答了」').not.toBe(false);
    expect(parsed.emptyAnswer ?? null).toBeNull();
  });

  it('三态各自解析得出来，且互不相同', () => {
    expect(EvalRowSchema.parse(makeRow({ emptyAnswer: true })).emptyAnswer).toBe(true);
    expect(EvalRowSchema.parse(makeRow({ emptyAnswer: false })).emptyAnswer).toBe(false);
    expect(EvalRowSchema.parse(makeRow({ emptyAnswer: null })).emptyAnswer).toBeNull();
  });

  /**
   * 上面那条 `RequiredCell` 的**运行时影子**：类型断言在 `tsc` 里见红，而这条让它在 `vitest` 的
   * 用例列表里也占一格（否则「有这条判据」只活在一个没人跑得到的 const 上）。
   */
  it('这一格不是必填键（`tsc` 见红的那条判据的运行时影子）', () => {
    expect(emptyAnswerIsOptional).toBe(false);
  });
});

describe('AGENT_KINDS', () => {
  it('全部智能体与表同序同值（真源在 contracts）', () => {
    expect([...AGENT_KINDS]).toEqual(['cc', 'codex', 'dsh', 'pi']);
    expect(AgentKindSchema.options).toEqual([...AGENT_KINDS]);
  });

  it('每家都有中文标签', () => {
    expect(AGENT_LABELS['cc']).toBe('Claude Code');
    expect(AGENT_LABELS.codex).toBe('Codex');
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
    expect(AGENT_LABELS.pi).toBe('Pi Coding Agent');
  });
});

describe('ExecutionModeSchema', () => {
  it('只有并行与串行两种', () => {
    expect(ExecutionModeSchema.options).toEqual(['parallel', 'serial']);
    expect(ExecutionModeSchema.safeParse('both').success).toBe(false);
  });
});

describe('EvalRowStatus', () => {
  it('十个状态与状态机逐字一致（拼错 timed-out 会让终态判定失效）', () => {
    expect(EvalRowStatusSchema.options).toEqual([
      'pending', 'preparing', 'running', 'judging', 'judged',
      'failed', 'timed-out', 'canceled', 'skipped', 'interrupted',
    ]);
  });

  it('终态集合覆盖全部非运行态，且不含三个运行态', () => {
    for (const status of EvalRowStatusSchema.options) {
      const isRunning = status === 'preparing' || status === 'running' || status === 'judging';
      const isPending = status === 'pending';
      expect(TERMINAL_ROW_STATUSES.includes(status)).toBe(!isRunning && !isPending);
    }
  });

  it('每个状态都有中文文案（新增状态时忘补文案会当场红）', () => {
    for (const status of EvalRowStatusSchema.options) {
      expect(ROW_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
    expect(ROW_STATUS_LABELS.judged).toBe('已评分');
    expect(ROW_STATUS_LABELS['timed-out']).toBe('已超时');
  });
});

describe('isRunnableRow / isRunningRow', () => {
  it('可执行的六种状态：pending / failed / timed-out / canceled / interrupted / skipped', () => {
    const runnable: EvalRowStatus[] = ['pending', 'failed', 'timed-out', 'canceled', 'interrupted', 'skipped'];
    for (const status of EvalRowStatusSchema.options) {
      expect(isRunnableRow(status)).toBe(runnable.includes(status));
    }
  });

  it('judged 不可重跑（跑完的行不能被「开始」重跑一遍）', () => {
    expect(isRunnableRow('judged')).toBe(false);
  });

  it('三种运行态属「在跑」而不是「可执行」——界面靠它禁用开始按钮', () => {
    const running: EvalRowStatus[] = ['preparing', 'running', 'judging'];
    for (const status of EvalRowStatusSchema.options) {
      expect(isRunningRow(status)).toBe(running.includes(status));
    }
    expect(isRunningRow('pending')).toBe(false);
    expect(isRunnableRow('running')).toBe(false);
  });
});

describe('RowDiffIndexSchema / RowDiffFileSchema', () => {
  const index = {
    files: [{ path: 'a.ts', insertions: 1, deletions: 0, untracked: false, hasBody: true }],
    total: 1,
    offset: 0,
    insertions: 1,
    deletions: 0,
    noBodyCount: 0,
    truncated: false,
    droppedFiles: [],
  };

  it('索引里没有 diff 正文（正文只走单文件接口）', () => {
    expect(RowDiffIndexSchema.safeParse(index).success).toBe(true);
    // 索引响应绝不带 text 字段——带了就等于把「一次下发全部正文」又请回来了
    expect(RowDiffIndexSchema.safeParse({ ...index, text: 'x' }).success).toBe(true);
    expect(Object.keys(RowDiffIndexSchema.shape)).not.toContain('text');
  });

  it('每个文件条目必须显式给出 hasBody 与 untracked（少一个就是漏标）', () => {
    const [file] = index.files;
    expect(RowDiffIndexSchema.safeParse({ ...index, files: [{ ...file, hasBody: undefined }] }).success).toBe(false);
    expect(RowDiffIndexSchema.safeParse({ ...index, files: [{ ...file, untracked: undefined }] }).success).toBe(false);
  });

  it('droppedFiles 是必填的（被预算丢掉的文件必须逐个列出来）', () => {
    expect(RowDiffIndexSchema.safeParse({ ...index, droppedFiles: undefined }).success).toBe(false);
  });

  it('单文件正文：没有 truncated 字段（整文件丢弃的模型下它恒为 false）', () => {
    expect(RowDiffFileSchema.safeParse({ path: 'a.ts', patch: '+x', insertions: 1, deletions: 0, binary: false }).success).toBe(true);
    expect(Object.keys(RowDiffFileSchema.shape)).not.toContain('truncated');
  });
});

describe('EvalRowSchema / EvalRunSchema / RunCreateSchema', () => {
  const row = {
    id: 'row-1',
    agentKind: 'cc' as const,
    providerId: 'p-1',
    providerName: '网关',
    baseUrl: 'https://gw.example.com/anthropic',
    modelId: 'claude-opus-4-6',
    status: 'pending' as const,
    branch: 'test/row-1',
    workspacePath: 'D:/runs/run-1/rows/row-1/workspace',
    baselineCommit: 'a'.repeat(40),
    tokens: null,
    turns: null,
    durationMs: null,
    diff: null,
    score: null,
    error: null,
  };

  it('EvalRow 的 baselineCommit 是必填字段，但允许空串表示「尚未准备」', () => {
    expect(EvalRowSchema.safeParse(row).success).toBe(true);
    const { baselineCommit: _omitted, ...withoutBaseline } = row;
    expect(EvalRowSchema.safeParse(withoutBaseline).success).toBe(false);
    // 空串必须合法：创建评测时基线还没解析（要等 prepare 阶段 rev-parse HEAD），
    // 而 createRun 落库时只能填 ''；只有 prepare 之后它才必然是非空 40 位 hash。
    // 若这里恢复成 .min(1)，真实链路上「创建评测」会直接抛 ZodError（api 层的测试 mock 了 evaluator，
    // 所以只有冒烟第 3 项才会暴露）。
    expect(EvalRowSchema.safeParse({ ...row, baselineCommit: '' }).success).toBe(true);
  });

  it('EvalRow 要求 providerId：展示快照 providerName 可以被改名，凭据只能靠 id 定位', () => {
    const { providerId: _dropped, ...withoutProviderId } = row;
    expect(EvalRowSchema.safeParse(withoutProviderId).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, providerId: '' }).success).toBe(false);
  });

  it('EvalRow.error 必须带 code，且 code 是自由字符串而不是枚举', () => {
    // 这一格要同时容纳 AgentErrorCode 与接口层 ErrorCode（如 JUDGE_PARSE_FAILED），
    // 写死任一组都会漏——所以是 z.string() 但**必填**
    expect(EvalRowSchema.safeParse({ ...row, error: { message: 'CLI 未安装' } }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, error: { code: 'AGENT_FAILED', message: 'CLI 未安装' } }).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, error: { code: 'JUDGE_PARSE_FAILED', message: '维度缺失' } }).success).toBe(true);
    expect(
      EvalRowSchema.safeParse({ ...row, error: { code: 'AGENT_FAILED', message: 'CLI 未安装', stack: 'at …' } }).success,
    ).toBe(true);
  });

  it('EvalRow 拒绝错误的 agentKind', () => {
    expect(EvalRowSchema.safeParse({ ...row, agentKind: 'cursor' }).success).toBe(false);
  });

  /**
   * 思考强度：行上**可选**，创建入参里也必须**显式声明**。
   * 前者是载重的：老 `run.json` 没有这一格，必填会让 `listRuns()` 静默跳过那一轮（与 attempts
   * / useAgentJudge 同一条理由）；后者防的是 zod 3 的默认 strip —— 不声明的话，表单提交的强度
   * 会在解析时被**静默丢掉**（不是 400），服务端永远收不到它。
   */
  it('EvalRow.effort 可选（老快照照样解析）但拒绝空串；RunCreate.rows[].effort 真的进得来', () => {
    expect(EvalRowSchema.safeParse(row).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, effort: 'high' }).success).toBe(true);
    // 空串不是档位名：min(1) 挡下它，免得 `''` 被当成「选了一个叫空串的档」
    expect(EvalRowSchema.safeParse({ ...row, effort: '' }).success).toBe(false);

    const create = {
      caseId: 'c-1',
      executionMode: 'serial' as const,
      rows: [{ agentKind: 'cc' as const, providerId: 'p-1', modelId: 'm' }],
    };
    expect(RunCreateSchema.parse(create).rows[0]?.effort).toBeUndefined();
    expect(
      RunCreateSchema.parse({ ...create, rows: [{ ...create.rows[0], effort: 'max' }] }).rows[0]?.effort,
    ).toBe('max');
  });

  // 补的守卫（缺口）：行上的 status 就是编排层写、界面显示、SSE 判终态的那台状态机；
  // 若它退化成任意字符串，一个拼错的状态会一路落库到界面（那一格空白），而两个判定函数只会说「不是在跑」。
  it('EvalRow.status 只接受 EvalRowStatus 的取值（拼错的状态不能落库）', () => {
    expect(EvalRowSchema.safeParse({ ...row, status: 'timed-out' }).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, status: 'timeout' }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, status: 'paused' }).success).toBe(false);
    // 必填：缺了 status 的行读回来会让列表那一格直接空白，也无法判断它该不该进「开始」的集合
    const { status: _omitted, ...withoutStatus } = row;
    expect(EvalRowSchema.safeParse(withoutStatus).success).toBe(false);
  });

  // 补的守卫（缺口）：ScoreResultSchema 是本文件唯一的跨契约消费点，
  // 若这里退回 z.any()（或另写一份形状），「逐项二元判定 + 满分必须为正」的口径在行上就没人保了。
  it('EvalRow.score 直接消费 ScoreResultSchema（满分必须为正，0 当场红）', () => {
    const score = {
      judgments: [
        { id: 'A1', achieved: true, reason: '字段进了契约' },
        { id: 'D1', achieved: false, reason: '没补用例' },
      ],
      totalScore: 18,
      maxScore: 32,
      verdict: '完成度高',
      raw: '{}',
      judgeProviderId: 'p-1',
      judgeModelId: 'deepseek-chat',
      judgedAt: '2026-09-22T10:30:00.000Z',
    };
    expect(EvalRowSchema.safeParse({ ...row, score }).success).toBe(true);
    // 满分必须为正：0 分满分意味着「无从判定」，那种分数不该存在
    expect(EvalRowSchema.safeParse({ ...row, score: { ...score, maxScore: 0 } }).success).toBe(false);
    // 逐项判定不是可选的：旧形状（`dimensions`）里那一格叫别的名字，缺 `judgments` 必须当场红
    const { judgments: _omitted, ...withoutJudgments } = score;
    expect(EvalRowSchema.safeParse({ ...row, score: withoutJudgments }).success).toBe(false);
  });

  // 补的守卫（缺口）：diff / tokens 非空时的形状必须有断言——编排层写、界面读都按这四个字段，
  // 少一个字段（如 truncated）会让界面把「已截断」显示成「完整 diff」。
  it('EvalRow.diff / tokens 的形状在非空时逐字段校验（可空但不可残缺）', () => {
    const diff = { filesChanged: 2, insertions: 12, deletions: 3, truncated: false };
    expect(EvalRowSchema.safeParse({ ...row, diff }).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, diff: { filesChanged: 2, insertions: 12, deletions: 3 } }).success).toBe(false);
    const tokens = { input: 10, cached: 2, output: 3 };
    expect(EvalRowSchema.safeParse({ ...row, tokens }).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, tokens: { input: 10, cached: 2 } }).success).toBe(false);
  });

  it('EvalRun 冗余快照字段必填（删掉用例后仍要说得清当时测的是什么）', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    expect(EvalRunSchema.safeParse(run).success).toBe(true);
    expect(EvalRunSchema.safeParse({ ...run, caseTitle: undefined }).success).toBe(false);
    // `rubric` 是本次新增的**必填**快照：缺了它 `listRuns()` 会静默跳过那一轮（旧评测记录因此要清掉），
    // 而评分阶段读的正是这一格——退化成可选就等于让「这一轮用的是哪把尺子」变成 undefined。
    expect(EvalRunSchema.safeParse({ ...run, rubric: undefined }).success).toBe(false);
    expect(EvalRunSchema.safeParse({ ...run, status: 'paused' }).success).toBe(false);
  });

  it('EvalRun.repoBranch 缺字段读成 null（旧 run.json 没有这一列）', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    const parsed = EvalRunSchema.parse({ ...run, repoBranch: undefined });
    expect(parsed.repoBranch).toBeNull();
  });

  /**
   * 「包含步骤」快照：显式值逐字保留，缺列读成 false。
   * 为什么缺列必须按 false 而不是必填：这一列比 `useAgentJudge` 还新，磁盘上已有的 `run.json`
   * 都没有它——必填会让 `run-store` 的 `safeParse` 失败 ⇒ `listRuns()` 静默跳过那一轮
   * （与 `useAgentJudge` 同一条理由）。false 也是语义正确的兜底：老一轮评测本来就是
   * 「评分只看最终改动」跑出来的。
   */
  it('EvalRun.includeSteps 缺字段读成 false（旧 run.json 没有这一列），显式值逐字保留', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    const parsed = EvalRunSchema.parse({ ...run, includeSteps: undefined });
    expect(parsed.includeSteps).toBe(false);
    expect(EvalRunSchema.parse({ ...run, includeSteps: true }).includeSteps).toBe(true);
  });

  /**
   * 轮级备注（`EvalRun.note`）：名字补这一格的**载重**与 `includeSteps` 逐字同源——
   * 磁盘上已有的 `run.json` 没有它，必填会让 `listRuns()` 静默跳过那一轮；空串是语义正确的兜底。
   * 另一面钉的是 `RunCreate.note` **必须显式声明**（zod 3 默认 strip 未知键），否则表单提交的备注
   * 会在解析层被静默丢掉，而 POST 仍然 201。
   */
  const noteIsRequired: RequiredCell<EvalRun, 'note'> = true;

  it('EvalRun.note 缺字段读成空串（旧 run.json 没有这一格），显式值逐字保留', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    expect(EvalRunSchema.parse({ ...run, note: undefined }).note).toBe('');
    expect(EvalRunSchema.parse({ ...run, note: '对比模型不同版本间的差异' }).note).toBe('对比模型不同版本间的差异');
    // 这一格不许退化成可选键：界面按下标读它时 `undefined` 会在排序/渲染里炸
    expect(noteIsRequired).toBe(true);
  });

  it('RunCreate.note 收得下显式备注（不被 zod strip），缺省解析为 undefined（由 api 收敛成空串）', () => {
    const input = {
      caseId: 'c-1',
      executionMode: 'serial' as const,
      rows: [{ agentKind: 'codex' as const, providerId: 'p-1', modelId: 'gpt-5' }],
    };
    expect(RunCreateSchema.parse({ ...input, note: '对比模型不同版本间的差异' }).note).toBe('对比模型不同版本间的差异');
    expect(RunCreateSchema.parse(input).note).toBeUndefined();
  });

  /**
   * 应答面开关：与 `includeSteps` 同一条链（轮级快照 + 缺字段读成 false）。
   *
   * 两个方向的靶子：① 缺这一格的旧 `run.json` 必须照样解析并按「关」处置——它是默认值，
   * 也是「不问就不动」那条边界的起点；② 创建入参里**必须显式声明**这一格（zod 3 默认 strip），
   * 漏声明时表单打开它会被静默丢掉，而丢掉之后的表现恰好是「跑起来没有应答面」——
   * 一个没有任何报错的坏形状。
   */
  it('EvalRun.askUser 缺字段读成 false；RunCreate 收得下显式的 true', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    expect(EvalRunSchema.parse({ ...run, askUser: undefined }).askUser).toBe(false);
    expect(EvalRunSchema.parse({ ...run, askUser: true }).askUser).toBe(true);

    const input = { caseId: 'c-1', executionMode: 'serial', rows: [{ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' }] };
    expect(RunCreateSchema.parse({ ...input, askUser: true }).askUser).toBe(true);
    // 老客户端（不带这一格）照样合法：缺省就是「这一轮不介入」
    expect(RunCreateSchema.parse(input).askUser).toBe(false);
  });

  it('RunCreate 至少一行候选，每行三个字段都必填', () => {
    const input = {
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' }],
    };
    expect(RunCreateSchema.safeParse(input).success).toBe(true);
    expect(RunCreateSchema.safeParse({ ...input, rows: [] }).success).toBe(false);
    expect(RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'codex', providerId: 'p-1' }] }).success).toBe(false);
    // providerId 是服务端快照 providerName / baseUrl 的唯一线索：缺了它这一行落库后无法定位凭据
    expect(RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'codex', modelId: 'gpt-5' }] }).success).toBe(false);
    // agentKind 决定 api 层起哪个适配器：未登记的智能体必须在入口被拦下，而不是落到行上再报「不知道怎么写命令」
    expect(
      RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'cursor', providerId: 'p-1', modelId: 'gpt-5' }] }).success,
    ).toBe(false);
  });

  // 补的守卫（缺口）：EvalRun.rows 的元素要逐个过 EvalRowSchema——把整轮读回来时若只校验外层，
  // 等于允许「行缺字段」落库/出接口，界面会在渲染那一格时才炸（而不是在解析处指出哪一行坏）。
  it('EvalRun.rows 的元素逐个按 EvalRowSchema 校验（缺字段的行不能混进一轮里）', () => {
    const run = {
      id: 'run-1',
      caseId: 'c-1',
      caseTitle: 'LRU 缓存',
      repoPath: 'D:/repos/demo',
      commitHash: null,
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'idle' as const,
      executionMode: 'parallel' as const,
      rows: [row],
      workspaceBase: 'D:/runs',
      createdAt: '2026-09-22T10:30:00.000Z',
      startedAt: null,
      finishedAt: null,
    };
    expect(EvalRunSchema.safeParse(run).success).toBe(true);
    expect(EvalRunSchema.safeParse({ ...run, rows: [{ id: 'row-1', status: 'pending' }] }).success).toBe(false);
  });

  it('useAgentJudge 缺省为 false（老客户端与手工 POST 都不带这个字段）', () => {
    const created = RunCreateSchema.parse({
      caseId: 'c1',
      executionMode: 'parallel',
      rows: [{ agentKind: 'codex', providerId: 'p1', modelId: 'm1' }],
    });
    expect(created.useAgentJudge).toBe(false);
  });

  // run-store 的 readSnapshot 用 safeParse 读盘，必填新字段会让磁盘上
  // 已有的评测**从列表里静默消失**（只记一条 WARN），而两端都不报错。这条守卫钉住「老快照照读」。
  it('老 run.json（没有 useAgentJudge 与 judgeAgentKind）仍然读得出来，并取到默认值', () => {
    const legacy = {
      id: 'run-1',
      caseId: 'case-1',
      caseTitle: '老用例',
      repoPath: 'C:/repo',
      commitHash: null,
      // 这一份钉的是「没有 useAgentJudge / judgeAgentKind」的老快照取默认值；`rubric` 是本次新增的
      // **必填**快照（没有它的更老 run.json 会被 `listRuns()` 静默跳过，正是升级要求清记录的原因）
      rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
      status: 'done',
      executionMode: 'parallel',
      rows: [
        {
          id: 'row-1',
          agentKind: 'codex',
          providerId: 'p1',
          providerName: '老供应商',
          baseUrl: 'https://fake.invalid/v1',
          modelId: 'm1',
          status: 'judged',
          branch: 'test/row-1',
          workspacePath: 'C:/runs/run-1/rows/row-1/workspace',
          baselineCommit: 'a'.repeat(40),
          tokens: null,
          turns: null,
          durationMs: null,
          diff: null,
          score: {
            // 逐项判定在旧记录里不存在（旧形状是 5 个固定维度），故是空表；满分仍必须为正
            judgments: [],
            totalScore: 0,
            maxScore: 100,
            verdict: '老总评',
            raw: '{}',
            judgeProviderId: 'p1',
            judgeModelId: 'm1',
            judgedAt: '2026-01-01T00:00:00.000Z',
          },
          error: null,
        },
      ],
      workspaceBase: 'C:/runs',
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    };

    const parsed = EvalRunSchema.safeParse(legacy);
    if (!parsed.success) throw new Error(`老快照必须解析成功：${parsed.error.message}`);
    expect(parsed.data.useAgentJudge).toBe(false);
    expect(parsed.data.rows[0]?.score?.judgeAgentKind).toBeNull();
  });
});

/**
 * `canRescoreRow`（已出分、无报错的行也给「重新评分」）。
 *
 * 三个条件缺一不可：不在跑 / 有可比基线 / 有已产出的改动。它们收的是**能力前提**
 * （没有工作区就没有可复评的产出），而不是「这一行失败过没有」——用户口径：
 * 「已出分、无报错时取消禁用」。误点的代价由界面的 `Popconfirm` 承担（「现有分数会被替换」），
 * 不再由判据承担。
 *
 * ⚠️ 这一组必须逐档点明「**不再**看 `error.stage`」：判据里少掉的那一条是**有意**去掉的，
 * 而不是从来没写过——`error.stage` 那一格仍在落盘（叙述用），只是不再参与任何可用性判定。
 */
describe('canRescoreRow', () => {
  it('**已经出分、没有报错**的行可重评：用本轮同一把尺子把评分重算一遍', () => {
    expect(canRescoreRow(makeRow({ status: 'judged', score: null, error: null }))).toBe(true);
    expect(canRescoreRow(makeRow({ status: 'judged', error: null }))).toBe(true);
  });

  it('评分阶段失败的行照样可重评（这是它原本的用途）', () => {
    expect(canRescoreRow(makeRow({ status: 'failed', error: { code: 'JUDGE_PARSE_FAILED', message: '不是合法 JSON', stage: 'judge' } }))).toBe(true);
    expect(
      canRescoreRow(makeRow({ status: 'timed-out', error: { code: 'AGENT_TIMED_OUT', message: '评分阶段超时', stage: 'judge' } })),
    ).toBe(true);
  });

  it('候选 agent 阶段失败的行也可重评（判据不再看失败阶段）', () => {
    expect(canRescoreRow(makeRow({ status: 'failed', error: { code: 'AGENT_FAILED', message: 'CLI 起不来', stage: 'agent' } }))).toBe(true);
    expect(
      canRescoreRow(makeRow({ status: 'timed-out', error: { code: 'AGENT_TIMED_OUT', message: '候选超时', stage: 'agent' } })),
    ).toBe(true);
  });

  it('老快照（error 没有 stage 这一格）与「被终止」的行同档：只看那三条硬前提', () => {
    expect(canRescoreRow(makeRow({ status: 'failed', error: { code: 'JUDGE_PARSE_FAILED', message: '老记录' } }))).toBe(true);
    expect(canRescoreRow(makeRow({ status: 'canceled', error: null }))).toBe(true);
  });

  it('三种在途状态一律不可（正在跑的行有自己的生命周期）', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      expect(
        canRescoreRow(makeRow({ status, error: { code: 'JUDGE_PARSE_FAILED', message: '评分失败', stage: 'judge' } })),
      ).toBe(false);
    }
  });

  it('没跑过的行不可（没有可比基线或没有产出）', () => {
    const judgeFailed = { code: 'JUDGE_PARSE_FAILED', message: '评分失败', stage: 'judge' } as const;
    expect(canRescoreRow(makeRow({ status: 'pending', baselineCommit: '', diff: null, error: judgeFailed }))).toBe(false);
    expect(canRescoreRow(makeRow({ baselineCommit: '' }))).toBe(false);
    expect(canRescoreRow(makeRow({ diff: null }))).toBe(false);
    // 已出分但工作区没就绪（prepare 从没成功过）⇒ 仍然不给：这条硬前提与失败与否无关
    expect(canRescoreRow(makeRow({ status: 'judged', baselineCommit: '' }))).toBe(false);
  });
});

/**
 * `canRetryRow`（内部名 retry，界面文案是「**重新执行**」）。
 *
 * 判据与 `canRescoreRow` 现在**又一次同源**（同样是那三条硬前提），但语义不是一件事：
 * 重新执行 = 候选 agent 与评分都重跑（工作区重新准备、分支重建）；重新评分 = 只重跑评分那一步。
 * 这一组把真值表**独立**钉一遍：只靠其中一组的用例覆盖另一个，等于把「两者今天恰好同形」
 * 当成契约——它们随时可能再分叉，而「已出分的行能不能整段重跑」
 * 正是用户点名放开的那一格。
 */
describe('canRetryRow', () => {
  it('**已经出分（测试完成且没有错误）**的行可重新执行（晚间口径：不再排除 judged）', () => {
    expect(canRetryRow(makeRow({ status: 'judged' }))).toBe(true);
  });

  it('跑过但没跑成的终态也可重新执行（执行失败的出路，含用户自己终止的那些）', () => {
    for (const status of ['failed', 'timed-out', 'canceled', 'interrupted'] as const) {
      expect(canRetryRow(makeRow({ status }))).toBe(true);
    }
  });

  it('没跑过的行不可（pending / skipped：没有基线或没有产出）', () => {
    expect(canRetryRow(makeRow({ status: 'pending', baselineCommit: '', diff: null }))).toBe(false);
    expect(canRetryRow(makeRow({ status: 'skipped', baselineCommit: '', diff: null }))).toBe(false);
    expect(canRetryRow(makeRow({ status: 'failed', baselineCommit: '' }))).toBe(false);
    expect(canRetryRow(makeRow({ status: 'failed', diff: null }))).toBe(false);
    // 已出分但工作区没就绪 ⇒ 也不给（与失败与否无关的硬前提）
    expect(canRetryRow(makeRow({ status: 'judged', baselineCommit: '' }))).toBe(false);
    expect(canRetryRow(makeRow({ status: 'judged', diff: null }))).toBe(false);
  });

  it('三种在途状态一律不可（正在跑的行要先终止）', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      expect(canRetryRow(makeRow({ status }))).toBe(false);
    }
  });

  it('两个判据今天同形（同一组输入给出同一答案），但语义各是一件事', () => {
    // 同一条 judged 行：两个出口都开（一个重算评分、一个整段重跑，成本差一个数量级）
    const judged = makeRow({ status: 'judged' });
    expect(canRetryRow(judged)).toBe(true);
    expect(canRescoreRow(judged)).toBe(true);

    // 同一条候选阶段失败的行：两个出口也都开（历史上这里曾分叉：重评不给）
    const agentFailed = makeRow({ status: 'failed', error: { code: 'AGENT_FAILED', message: 'CLI 起不来', stage: 'agent' } });
    expect(canRetryRow(agentFailed)).toBe(true);
    expect(canRescoreRow(agentFailed)).toBe(true);

    // 同一条「没产出」的行：两个都不给（硬前提不是失败语义）
    const neverRan = makeRow({ status: 'pending', baselineCommit: '', diff: null });
    expect(canRetryRow(neverRan)).toBe(false);
    expect(canRescoreRow(neverRan)).toBe(false);
  });
});

/**
 * `canRunRow`（用户口径：「重新执行，只执行当前候选项，不要完成后重新执行下方
 * 已经执行过的候选项」）。
 *
 * 与 `canRetryRow` 的**唯一**差别就是「跑过没有」：
 *   · `canRetryRow` 要求「有可比基线 + 有已产出的改动」——它回答的是「**重**跑这一行有没有对照物」；
 *   · `canRunRow` 只要求「不在跑」——它回答的是「能不能**就现在**把这一行跑起来」。
 * 于是**没跑过的行**（`pending` / `skipped`，没有基线也没有 diff）也能单跑：界面上那个按钮的文案
 * 按行态分叉（没跑过 = 「开始执行」、跑过 = 「重新执行」），而两者打的是**同一条**单行执行链路
 * （`retryRow` → `runRow`）——它只动这一行，不会带动本轮其他行（串行队列也不推进）。
 *
 * 为什么这一条必须存在、且必须与 `canRetryRow` **分开**：过去没跑过的行只能靠「开始」跑，
 * 而「开始」的语义是**所有可执行行**（`isRunnableRow`）——想单独跑三行里的第二行时，
 * 它会把上面失败过的行一起重跑一遍。这是那次口径修订要解决的唯一问题。
 */
describe('canRunRow', () => {
  it('没跑过的行也能单跑（pending / skipped：没有基线、没有 diff 都不拦）', () => {
    expect(canRunRow(makeRow({ status: 'pending', baselineCommit: '', diff: null }))).toBe(true);
    expect(canRunRow(makeRow({ status: 'skipped', baselineCommit: '', diff: null }))).toBe(true);
  });

  it('跑过的终态一律可单跑（含已出分与各种失败面）', () => {
    for (const status of ['judged', 'failed', 'timed-out', 'canceled', 'interrupted'] as const) {
      expect(canRunRow(makeRow({ status }))).toBe(true);
    }
  });

  it('三种在途状态一律不可（正在跑的行要先终止，不能并发着再起一条）', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      expect(canRunRow(makeRow({ status }))).toBe(false);
    }
  });

  /**
   * 两个判据的**单调关系**：能「重新执行」的行必然能「执行」，反之不然。
   * 这条守卫拦的是「把 `canRunRow` 写成 `canRetryRow` 的复制品」——那种改法下
   * 「没跑过的行也能单跑」当场失效，而界面上只是按钮继续禁用，一次点击都不会报错。
   */
  it('能重新执行 ⇒ 必然能执行（反向不成立：没跑过的行能执行、不能重新执行）', () => {
    const ran = makeRow({ status: 'failed' });
    expect(canRetryRow(ran)).toBe(true);
    expect(canRunRow(ran)).toBe(true);

    const neverRan = makeRow({ status: 'pending', baselineCommit: '', diff: null });
    expect(canRunRow(neverRan)).toBe(true);
    expect(canRetryRow(neverRan)).toBe(false);
  });
});

/**
 * `EvalRow.error.stage`。
 * `.optional()` 是**载重**的：老 run.json 里没有这一格，必填会让 `listRuns()` 静默跳过那一轮。
 */
describe('EvalRow.error.stage（失败阶段）', () => {
  it('两档取值都被接受', () => {
    for (const stage of ['agent', 'judge'] as const) {
      const parsed = EvalRowSchema.safeParse({ ...makeRow(), error: { code: 'AGENT_FAILED', message: 'x', stage } });
      expect(parsed.success).toBe(true);
    }
  });

  it('缺这一格照样解析成功（老快照），读出来是 undefined', () => {
    const parsed = EvalRowSchema.safeParse({ ...makeRow(), status: 'failed', error: { code: 'AGENT_FAILED', message: 'x' } });
    if (!parsed.success) throw new Error(`老快照必须解析成功：${parsed.error.message}`);
    expect(parsed.data.error?.stage).toBeUndefined();
  });

  it('编造的阶段被拒（它只有两档：多一档会让快照的形状失去约束力）', () => {
    expect(EvalRowSchema.safeParse({ ...makeRow(), error: { code: 'x', message: 'y', stage: 'prepare' } }).success).toBe(false);
  });
});

describe('EvalRow.attempts（重试记账）', () => {
  it('缺省补 0：老 run.json 里没有这一格，读盘必须照样成功（与 useAgentJudge 同一条理由）', () => {
    const parsed = EvalRowSchema.parse({ ...makeRow(), attempts: undefined });
    expect(parsed.attempts).toBe(0);
  });

  it('负数被拒（它只可能是「跑过几次」，不能是 -1）', () => {
    expect(EvalRowSchema.safeParse({ ...makeRow(), attempts: -1 }).success).toBe(false);
  });
});

/**
 * `EvalRow.mcpServers` 这一格是「**本行 MCP**」观测格。
 *
 * 为什么它必须落在**行快照**上而不是只活在事件流里：事件流回答「厂商当时说了什么」，
 * 而「这一行实际装上/没装上哪几台、依据是什么」是运行之后要能复盘的事实——刷新页面、
 * 换台机器、老 `run.json` 都只读快照。故三态与 `streamingDelta` 逐条同构：
 *   · **缺席 / `null`** = 未观测（老记录、或这一行根本没跑到候选执行）；
 *   · **`[]`** = 观测了，本行一台 MCP 都没有（与「没观测」是两句不同的话）；
 *   · 非空 = 逐台：名字 / 来源（厂商原值优先）/ 判据来源 / 结论。
 *
 * 另两条必须钉住：`verdict` 与 `judgedBy` 是**闭集**（写错的结论会让界面把「没验证」读成
 * 「已连上」），以及两张中文标签表覆盖整个值域（漏一格 = 界面上一格空白，而 tsc 拦住它）。
 */
describe('EvalRow.mcpServers（本行 MCP 观测格）', () => {
  const entry = {
    name: 'playwright',
    source: 'dynamic',
    judgedBy: 'vendor-tool-table' as const,
    verdict: 'connected' as const,
  };

  it('可选可空：老 run.json 照样解析（缺格 = 未观测），显式 null 与空数组各自可辨', () => {
    const legacy = makeRow();
    expect('mcpServers' in legacy).toBe(false);
    expect(EvalRowSchema.safeParse(legacy).success).toBe(true);
    expect(EvalRowSchema.parse(makeRow({ mcpServers: null })).mcpServers).toBeNull();
    // `[]` = 观测了、确实是空的——不许与「没观测」合并
    expect(EvalRowSchema.parse(makeRow({ mcpServers: [] })).mcpServers).toEqual([]);
  });

  it('逐台四格原样保留（来源采信厂商原值，判据与结论各是闭集）', () => {
    const parsed = EvalRowSchema.parse(makeRow({ mcpServers: [entry] }));
    expect(parsed.mcpServers).toEqual([entry]);
    // 四档结论都收得住：`skipped` 承载「环境变量未设置 ⇒ 整条不注入」
    for (const verdict of ['connected', 'unavailable', 'unverified', 'skipped'] as const) {
      expect(EvalRowSchema.safeParse(makeRow({ mcpServers: [{ ...entry, verdict }] })).success).toBe(true);
    }
    // 判据来源四档：claude 是前两档、codex 是第三档、什么都没拿到是 none
    for (const judgedBy of ['vendor-status', 'vendor-tool-table', 'vendor-startup-status', 'none'] as const) {
      expect(EvalRowSchema.safeParse(makeRow({ mcpServers: [{ ...entry, judgedBy }] })).success).toBe(true);
    }
  });

  it('编造的结论 / 判据被拒（读错一格就是把「没验证」显示成「已连上」）', () => {
    // 反向断言必须**绕过类型**（`as unknown as RowMcpServer`）：正常写法在编译期就被联合类型挡住了，
    // 而这里要测的正是「有人从磁盘上手写了一份坏数据」——那一条路没有类型，只有 schema。
    const badVerdict = { ...entry, verdict: 'ok' } as unknown as RowMcpServer;
    const badBasis = { ...entry, judgedBy: 'model-said-so' } as unknown as RowMcpServer;
    expect(EvalRowSchema.safeParse(makeRow({ mcpServers: [badVerdict] })).success).toBe(false);
    expect(EvalRowSchema.safeParse(makeRow({ mcpServers: [badBasis] })).success).toBe(false);
    // 名字是这一格的主键，空串不是「一台没名字的服务」
    expect(EvalRowSchema.safeParse(makeRow({ mcpServers: [{ ...entry, name: '' }] })).success).toBe(false);
  });

  it('两张中文标签表覆盖整个值域（新增一档忘同步会当场红，而不是界面上一格空白）', () => {
    expect(Object.keys(ROW_MCP_VERDICT_LABELS).sort()).toEqual(['connected', 'skipped', 'unavailable', 'unverified']);
    expect(Object.keys(ROW_MCP_BASIS_LABELS).sort()).toEqual([
      'none', 'vendor-startup-status', 'vendor-status', 'vendor-tool-table',
    ]);
  });

  /**
   * 「通道」与「判据来源」是**同一个值域**：判据来源 = 通道 + `none`（我们没有证据那一档）。
   * 两者各写一份枚举必然漂移——漂移的表现是「事件自报 `vendor-startup-status`、观测格却记
   * `vendor-status`」，而那正是这一格唯一要回答的问题（凭什么这么说）。
   */
  it('判据来源的值域 = 通道值域 + `none`（两处各写一份枚举会当场红）', () => {
    expect([...ROW_MCP_CHANNELS]).toEqual(['vendor-status', 'vendor-startup-status', 'vendor-tool-table']);
    expect([...ROW_MCP_CHANNELS, 'none'].sort()).toEqual(Object.keys(ROW_MCP_BASIS_LABELS).sort());
    for (const channel of ROW_MCP_CHANNELS) {
      expect(RowMcpBasisSchema.safeParse(channel).success).toBe(true);
      expect(RowMcpChannelSchema.safeParse(channel).success).toBe(true);
    }
    // `none` 只是**结论侧**的「没有厂商证据」，它不是一条通道：通道那一格不许收它
    expect(RowMcpBasisSchema.safeParse('none').success).toBe(true);
    expect(RowMcpChannelSchema.safeParse('none').success).toBe(false);
  });
});

/**
 * 编辑入参：创建入参的**超集**，差别只有候选行可带 `id`。
 * 为什么 id 必须存在：编辑表单要能说清「这一行还是原来那一行」——按位置对齐时「删掉第 2 行」
 * 会让第 3 行顶上来、它的成绩被错认成第 2 行的；按 (agent, model) 对齐时两行选同一个模型就无解。
 */
describe('RunUpdateSchema', () => {
  const base = {
    caseId: 'c-1',
    executionMode: 'serial',
    rows: [{ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' }],
  };

  it('不带 id 时与创建入参同形，且 useAgentJudge 缺省为 false', () => {
    const parsed = RunUpdateSchema.parse(base);
    expect(parsed.rows).toEqual(base.rows);
    expect(parsed.useAgentJudge).toBe(false);
  });

  it('候选行可带 id（指认原来那一行）；空串 id 被拒（它不是合法的行身份）', () => {
    expect(RunUpdateSchema.safeParse({ ...base, rows: [{ ...base.rows[0], id: 'row-1' }] }).success).toBe(true);
    expect(RunUpdateSchema.safeParse({ ...base, rows: [{ ...base.rows[0], id: '' }] }).success).toBe(false);
  });

  it('至少一行：编辑不许把候选清空（服务端与表单两层都要拦）', () => {
    expect(RunUpdateSchema.safeParse({ ...base, rows: [] }).success).toBe(false);
  });

  it('与 RunCreate 的差异只有 rows[].id：创建路径解析后**没有** id 这一格', () => {
    const withId = { ...base, rows: [{ ...base.rows[0], id: 'row-1' }] };
    // zod 的 z.object 默认 strip 未知键：创建入参即使带了 id，解析后也不会留下它
    expect(RunCreateSchema.parse(withId).rows[0]).toEqual(base.rows[0]);
    expect(RunUpdateSchema.parse(withId).rows[0]).toEqual({ ...base.rows[0], id: 'row-1' });
  });

  // 上面那条钉的是**解析行为**，它拦不住一整类漂移：创建侧新增一个**可选且无默认值**的字段时，
  // 两份形状都能解析成功、`toEqual` 也相等（那一格两边都没有），于是「更新侧悄悄少一个字段」这件事
  // 没有任何断言看得见——症状正是 `RunUpdateSchema` 的 JSDoc 点名的「创建能改的编辑改不了」。
  // 故这里直接比**行元素的键集合**：更新侧的那份必须由创建侧派生，而不是手抄一遍。
  it('更新入参的行元素 = 创建入参的行元素 + id（差一处，且只有这一处）', () => {
    const createKeys = Object.keys(RunCreateSchema.shape.rows.element.shape).sort();
    const updateKeys = Object.keys(RunUpdateSchema.shape.rows.element.shape).sort();
    expect(updateKeys).toEqual([...createKeys, 'id'].sort());
  });
});

/** 一轮快照（本组只关心轮级状态与行状态） */
function runWith(status: EvalRun['status'], rowStatuses: EvalRowStatus[]): EvalRun {
  return {
    id: 'run-1',
    caseId: 'c-1',
    caseTitle: '用例',
    note: '',
    repoPath: 'D:/repos/demo',
    commitHash: null,
    repoBranch: null,
    askUser: false,
    injectMessages: false,
    rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
    includeSteps: false,
    status,
    executionMode: 'parallel',
    useAgentJudge: false,
    rows: rowStatuses.map((rowStatus, index) => makeRow({ id: `row-${index + 1}`, status: rowStatus })),
    workspaceBase: 'D:/runs',
    createdAt: '2026-09-22T10:30:00.000Z',
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * `hasLiveRows`：编辑与删除**共用**的那一条判据（界面用它置灰、服务端用它抛 409）。
 * 「轮已 running、行状态还没翻」那一拍必须也在内——它正是 `startRun` 落状态与行开跑之间的窗口。
 */
describe('hasLiveRows', () => {
  it('轮 running ⇒ true，哪怕所有行都还是 pending（那一拍正好是「刚点了开始」）', () => {
    expect(hasLiveRows(runWith('running', ['pending', 'pending']))).toBe(true);
  });

  it('三种在途行状态各一档都 ⇒ true', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      expect(hasLiveRows(runWith('partial', ['judged', status]))).toBe(true);
    }
  });

  it('空闲（还没跑过 / 全终态）⇒ false', () => {
    expect(hasLiveRows(runWith('idle', ['pending', 'pending']))).toBe(false);
    expect(hasLiveRows(runWith('done', ['judged', 'failed']))).toBe(false);
    expect(hasLiveRows(runWith('partial', []))).toBe(false);
  });
});

/**
 * `isSameRowTarget`：服务端据此决定「这一行要不要重置」，编辑表单据此算「本次会作废哪几行」。
 * 两处必须同源：漂移的症状是「确认框说会作废 2 行、实际作废了 1 行」，而那是用户唯一能核对的地方。
 */
describe('isSameRowTarget', () => {
  const row = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' });

  it('四个身份字段逐字相同（含强度，两侧都没给）⇒ true', () => {
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(true);
  });

  it('强度以外的三个字段各自变化都 ⇒ false（漏掉任何一个都会让那一行的旧分数留下来）', () => {
    expect(isSameRowTarget(row, { agentKind: 'cc', providerId: 'p-1', modelId: 'gpt-5' })).toBe(false);
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-2', modelId: 'gpt-5' })).toBe(false);
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5-mini' })).toBe(false);
  });

  it('服务端快照（providerName / baseUrl）不参与判定：供应商改名不算「换了被评对象」', () => {
    // 判据只看四个身份字段（上面三个 + 强度，见下面那三条），其余字段（providerName / baseUrl / status / score…）一个都不看
    const renamed = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', providerName: '改过名的供应商', baseUrl: 'https://new.invalid/v1' });
    expect(isSameRowTarget(renamed, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(true);
  });

  // 强度（思考档位）也是**被评对象**的一部分：`EvalRow.effort` 与创建入参的 `rows[].effort` 都是可选的
  // 「这一行要什么档位」。只把 high 改成 low，跑出来的是另一次评测——旧档位跑出来的分不能留在快照里。
  // ⚠️ 「一侧没给」一律判成**改了**（`?? null` 把「缺这一格」与「没传」并成同一格）：编辑载荷是候选行集合的
  // **全量替换**，缺省只能读成「未指定档位」。这是安全方向——宁可多重置一行（重跑一次），
  // 也不能静默保留一个用户已经改过的档位跑出来的分。编辑表单会回传它。
  it('只改强度 ⇒ false（同一行、同一个模型，换了档位就是另一次评测）', () => {
    const high = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', effort: 'high' });
    expect(isSameRowTarget(high, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', effort: 'low' })).toBe(false);
  });

  it('强度也逐字相同 ⇒ true（两侧都是 high，或两侧都没给）', () => {
    const high = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', effort: 'high' });
    expect(isSameRowTarget(high, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', effort: 'high' })).toBe(true);
    // 缺省与缺省是同一件事：没声明档位的供应商与老客户端都落在这一格
    const none = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' });
    expect(isSameRowTarget(none, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(true);
  });

  it('一侧有强度、一侧没有 ⇒ 两个方向都 false（缺省读成「未指定」，不是「和上次一样」）', () => {
    const high = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', effort: 'high' });
    const none = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' });
    expect(isSameRowTarget(high, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(false);
    expect(isSameRowTarget(none, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5', effort: 'high' })).toBe(false);
  });
});

/**
 * `EvalRow.skillInstall` 这一格是「**本行技能**」观测格。
 *
 * 与 MCP 那一格（`mcpServers`）的分工：那一格回答「这一行装上了哪几台 MCP、凭什么」，
 * 这一格回答「**这一行装上了哪几条 skill、凭什么**」。两者共同的硬口径：
 *   · **判据不许是模型答复**——结论只由厂商事件侧的证据支撑（`judgedBy` 就是那条证据的名字）；
 *   · 三态与 `streamingDelta` 逐条同构：**缺席 / `null`** = 未观测（老记录、评分行）；
 *     **`[]`** = 观测了、确实一条都没装（用户把清单全停用是**有意义**的状态）；
 *     非空 = 逐条四格。
 *
 * 另两条必须钉住：`verdict` / `judgedBy` 是**闭集**，以及**配对规则**——
 * 「没采到厂商清单」+「厂商清单里没有它」这两句话同时出现在一条上时，界面无论怎么渲染都是错的。
 */
describe('EvalRow.skillInstall（本行技能观测格）', () => {
  const entry = {
    name: 'tang-poem-meal',
    source: 'userSettings',
    judgedBy: 'vendor-skill-list' as const,
    verdict: 'installed' as const,
  };

  it('可选可空：老 run.json 照样解析（缺格 = 未观测），显式 null 与空数组各自可辨', () => {
    const legacy = makeRow();
    expect('skillInstall' in legacy).toBe(false);
    // ① 老 `run.json` 仍能过（必填会让 `listRuns()` **静默跳过那一轮**）
    expect(EvalRowSchema.safeParse(legacy).success).toBe(true);
    expect(EvalRowSchema.parse(makeRow({ skillInstall: null })).skillInstall).toBeNull();
    expect(EvalRowSchema.parse(makeRow({ skillInstall: [] })).skillInstall).toEqual([]);
  });

  it('逐条四格原样保留（来源采信厂商原值，判据与结论各是闭集）', () => {
    const parsed = EvalRowSchema.parse(makeRow({ skillInstall: [entry] }));
    // ② 新写的一行也能过（与①同一个 schema，两个方向都要跑）
    expect(parsed.skillInstall).toEqual([entry]);
    for (const verdict of ROW_SKILL_VERDICTS) {
      const judgedBy = verdict === 'missing' ? 'vendor-skill-list' : verdict === 'unverified' ? 'local-materialized' : 'vendor-skill-list';
      expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [{ ...entry, verdict, judgedBy }] })).success).toBe(true);
    }
    // 判据三档都收得住（`vendor-prompt-listing` 今天不产出，但它属于值域：将来接上那条通道不改契约）
    for (const judgedBy of ROW_SKILL_BASES) {
      const verdict = judgedBy === 'local-materialized' ? 'unverified' : 'installed';
      expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [{ ...entry, judgedBy, verdict }] })).success).toBe(true);
    }
  });

  it('编造的结论 / 判据被拒，空名字被拒（`skipped` 这一档刻意不存在）', () => {
    const badVerdict = { ...entry, verdict: 'skipped' } as unknown as RowSkillInstall;
    const badBasis = { ...entry, judgedBy: 'model-said-so' } as unknown as RowSkillInstall;
    expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [badVerdict] })).success).toBe(false);
    expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [badBasis] })).success).toBe(false);
    expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [{ ...entry, name: '' }] })).success).toBe(false);
    // 来源是**自由字符串**（厂商原值是证据，翻译成我们的词表就是第二个真源），只要求非空
    expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [{ ...entry, source: 'projectSettings' }] })).success).toBe(true);
    expect(EvalRowSchema.safeParse(makeRow({ skillInstall: [{ ...entry, source: '' }] })).success).toBe(false);
  });

  /**
   * **配对规则**：判据来源与结论必须自洽。
   *   · `installed` ⇒ 必须带厂商证据（`local-materialized` 说的是「只有落盘」，
   *     而「文件在盘上被当成结论」正是 MCP 那趟踩过的坑）；
   *   · `missing` ⇒ 只在 `vendor-skill-list` 下成立（另两档都没有「清单里没有它」所需的完整性）；
   *   · `unverified` ⇒ 配 `local-materialized`。
   */
  it('配对规则：三种合法组合之外一律判非法', () => {
    expect(isValidSkillPairing({ judgedBy: 'vendor-skill-list', verdict: 'installed' })).toBe(true);
    expect(isValidSkillPairing({ judgedBy: 'vendor-skill-list', verdict: 'missing' })).toBe(true);
    expect(isValidSkillPairing({ judgedBy: 'local-materialized', verdict: 'unverified' })).toBe(true);
    // 「只有落盘」不能说「已装上」（同一条理由的反面）
    expect(isValidSkillPairing({ judgedBy: 'local-materialized', verdict: 'installed' })).toBe(false);
    // 「没有证据」不能说「厂商没认」（那是两句相反的话）
    expect(isValidSkillPairing({ judgedBy: 'local-materialized', verdict: 'missing' })).toBe(false);
    // 「提示词里出现过」不足以支撑「清单里没有它」（完整性不够）
    expect(isValidSkillPairing({ judgedBy: 'vendor-prompt-listing', verdict: 'missing' })).toBe(false);
    // 「采到了清单」时不许记「未验证 · 仅落盘」——那会把一条有证据的结论说成没证据
    expect(isValidSkillPairing({ judgedBy: 'vendor-skill-list', verdict: 'unverified' })).toBe(false);
    // 值域里的每一档都要有明确判决（漏一格 = 静默放行一个自相矛盾的组合）
    for (const judgedBy of ROW_SKILL_BASES) {
      for (const verdict of ROW_SKILL_VERDICTS) {
        expect(typeof isValidSkillPairing({ judgedBy, verdict })).toBe('boolean');
      }
    }
  });

  it('两张中文标签表覆盖整个值域，且三句用户文案逐字可拼', () => {
    expect(Object.keys(ROW_SKILL_VERDICT_LABELS).sort()).toEqual(['installed', 'missing', 'unverified']);
    expect(Object.keys(ROW_SKILL_BASIS_LABELS).sort()).toEqual([
      'local-materialized', 'vendor-prompt-listing', 'vendor-skill-list',
    ]);
    const sentence = (judgedBy: RowSkillBasis, verdict: RowSkillVerdict): string =>
      `${ROW_SKILL_VERDICT_LABELS[verdict]} · 判据 ${ROW_SKILL_BASIS_LABELS[judgedBy]}`;
    expect(sentence('vendor-skill-list', 'installed')).toBe('已装上 · 判据 厂商清单');
    expect(sentence('local-materialized', 'unverified')).toBe('未验证 · 判据 仅落盘');
    expect(sentence('vendor-skill-list', 'missing')).toBe('缺失 · 判据 厂商清单');
  });
});

/**
 * `canFollowUpRow`（第二期：对已经跑过的行补一句话、接着同一段会话再跑一段）的真值表。
 *
 * 七档拒绝**逐条各钉一次**，因为它们的处置互不相同：前两档是「此刻不是时机」（该去排队 / 该等），
 * 后五档是「这一行接不上」（该重新上传 / 该重新执行 / 这一家结构上没有）。
 * 判据放 contracts 的理由与 `canRescoreRow` 逐字相同——界面靠它给按钮 `disabled` 与 Tooltip 文案、
 * 服务端拿同一份抛 `CONFLICT`；两处各写一份必然漂移，漂移的表现是「按钮可点、点下去 409」。
 *
 * 事实格（`FollowUpFacts`）由调用方量好递进来：契约层读不了盘、也认不出厂商（它的依赖里只有 zod），
 * 而「工作区还在不在 / 用例还在不在 / 附件有没有丢 / 这一家声明的续接那一格」四件事都在那一侧。
 */
describe('canFollowUpRow', () => {
  /** 一份「此刻能追问」的事实：盘上都在、用例在、这一家声明续接为 `yes` */
  const READY: FollowUpFacts = {
    settling: false,
    workspaceExists: true,
    case: { state: 'present' },
    attachments: null,
    resume: {
      state: 'yes',
      reason: null,
      channel: 'wire',
      gate: null,
      experimental: false,
      proofDriver: 'real-path',
      proofDriverReason: null,
    },
  };
  const facts = (overrides: Partial<FollowUpFacts> = {}): FollowUpFacts => ({ ...READY, ...overrides });
  /** 一份「跑过」的行：终态 + 有可续接的会话 */
  const ran = (overrides: Partial<EvalRow> = {}): EvalRow => makeRow({ sessionId: 'sess-1', ...overrides });
  /** 不可行的原因（可行时返回 `null`，用例据此把「可行」与「不可行」写成同一个断言形状） */
  const reasonOf = (row: EvalRow, f: FollowUpFacts = facts()): string | null => {
    const verdict = canFollowUpRow(row, f);
    return verdict.ok ? null : verdict.reason;
  };

  it('跑过、且盘上与声明都在 ⇒ 可行', () => {
    expect(canFollowUpRow(ran(), facts())).toEqual({ ok: true });
    // 面比「已出分」宽：失败 / 超时 / 终止 / 跳过 / 中断同样是「跑过」
    for (const status of ['failed', 'timed-out', 'canceled', 'skipped', 'interrupted'] as const) {
      expect(canFollowUpRow(ran({ status }), facts()).ok).toBe(true);
    }
  });

  it('① 正在跑的行属于「此刻不是时机」：指向输入区排队，并点名当前状态', () => {
    for (const status of ['preparing', 'running', 'judging'] as const) {
      const reason = reasonOf(ran({ status }));
      expect(reason).toContain('正在运行中');
      expect(reason).toContain(ROW_STATUS_LABELS[status]);
      expect(reason).toContain('排队');
    }
  });

  /**
   * **`pending` 与在跑的行同一档**（spec：所有跑过的行态都能追问；`pending` 与在跑的行走**排队**
   * 那条路）。它落到第 ③ 档是这个判据最容易犯的错：那一句的结尾是「要重跑请点『重新执行』」，
   * 而用户想要的只是「我先把话排上队」——照它做会把这一行从头重跑一遍（追问的全部价值都反了）。
   */
  it('①-b `pending` 的行不是「接不上」而是「此刻不是时机」：指向输入区排队，不许引向「重新执行」', () => {
    // `pending` 的行现实中也没有会话（连 prepare 都还没跑）——判据顺序对了才轮不到第 ③ 档
    const reason = reasonOf(ran({ status: 'pending', sessionId: null }));
    expect(reason).toContain(ROW_STATUS_LABELS.pending);
    expect(reason).toContain('排队');
    expect(reason).not.toContain('没有可续接的会话');
    expect(reason).not.toContain('重新执行');
  });

  it('② 上一次运行还没收尾 ⇒ 同样不是时机，且与「正在跑」分开说（处置相反）', () => {
    expect(reasonOf(ran(), facts({ settling: true }))).toContain('还没收尾');
    // 顺序：正在跑的行即使 `settling` 也为真，拿到的必须是「正在运行中」（该去按终止，不是干等）
    expect(reasonOf(ran({ status: 'running' }), facts({ settling: true }))).toContain('正在运行中');
  });

  it('③ 没有可续接的会话（旧产物 / 没采到 id）⇒ 拒绝，且明说不会从头重跑', () => {
    const reason = reasonOf(ran({ sessionId: null }));
    expect(reason).toContain('没有可续接的会话');
    expect(reason).toContain('重新执行');
  });

  it('④ 工作区已被删除 ⇒ 拒绝并点名那一条路径；路径为空时说出「没有记录过」', () => {
    expect(reasonOf(ran(), facts({ workspaceExists: false }))).toContain(ran().workspacePath);
    const noPath = reasonOf(ran({ workspacePath: '' }), facts({ workspaceExists: false }));
    expect(noPath).toContain('工作区已被删除');
    expect(noPath).toContain('没有记录过工作区路径');
  });

  it('⑤ 附件：根没了与某一份没了各说一句（前者整棵被清理、后者要重新上传那一份）', () => {
    const root = reasonOf(ran(), facts({ attachments: { state: 'root-missing', root: '/runs/att' } }));
    expect(root).toContain('附件根不存在');
    expect(root).toContain('/runs/att');
    const missing = reasonOf(ran(), facts({ attachments: { state: 'missing', paths: ['/a.png', '/b.txt'] } }));
    expect(missing).toContain('附件不存在');
    expect(missing).toContain('/a.png');
    expect(missing).toContain('/b.txt');
    // 都在盘上就不拦（这一格是「这次带的那几份」，不是「这个目录非空不可」）
    expect(reasonOf(ran(), facts({ attachments: { state: 'present' } }))).toBeNull();
  });

  it('⑥ 用例已删除 ⇒ 拒绝，点名是哪一个用例（id 在轮上、故从事实那一侧进来），并说清历史仍能看', () => {
    const reason = reasonOf(ran(), facts({ case: { state: 'deleted', caseId: 'case-42' } }));
    expect(reason).toContain('用例已删除');
    expect(reason).toContain('case-42');
    expect(reason).toContain('历史记录仍可查看');
  });

  it('⑦ 这一家接不上会话 ⇒ 三种「没有」必须分开说（缺席 / 厂商侧有但我们没接 / 没验过 / 结构上没有）', () => {
    expect(reasonOf(ran(), facts({ resume: undefined }))).toContain('没有声明');
    expect(
      reasonOf(ran(), facts({ resume: { ...READY.resume!, state: 'unverified', reason: 'unverified', channel: null } })),
    ).toContain('还没验证过');
    expect(
      reasonOf(ran(), facts({ resume: { ...READY.resume!, state: 'no', reason: 'not-supported', channel: null } })),
    ).toContain('结构上没有续接会话的落点');
    // 版本门：off-by-adapter 带 `gate` 时把那一个版本号说出来（说不出就没法照着做决定）
    const gated = reasonOf(
      ran(),
      facts({
        resume: {
          ...READY.resume!,
          state: 'off-by-adapter',
          reason: 'not-exposed',
          channel: null,
          gate: { version: '9.9.9' },
        },
      }),
    );
    expect(gated).toContain('9.9.9');
    // 没有版本门的那一档是另一句话：厂商侧有那条路、我们这一侧没接（两者处置不同：一个等版本，一个等接线）
    expect(
      reasonOf(ran(), facts({ resume: { ...READY.resume!, state: 'off-by-adapter', reason: 'not-exposed', channel: null } })),
    ).toContain('我们这一侧没接');
  });

  it('判据不判厂商：同样的行与事实换一家给同一句话（厂商名只来自行的 `agentKind`）', () => {
    const dsh = reasonOf(ran({ agentKind: 'dsh' }), facts({ resume: undefined }));
    const cc = reasonOf(ran({ agentKind: 'cc' }), facts({ resume: undefined }));
    expect(dsh).toContain(AGENT_LABELS.dsh);
    expect(cc).toContain(AGENT_LABELS.cc);
    expect(dsh?.replace(AGENT_LABELS.dsh, 'X')).toBe(cc?.replace(AGENT_LABELS.cc, 'X'));
  });

  it('判据的返回形状就是线上那一份：`FollowUpVerdictSchema` 收得下它（两份形状不许各说各话）', () => {
    expect(FollowUpVerdictSchema.parse(canFollowUpRow(ran(), facts()))).toEqual({ ok: true });
    const refused = canFollowUpRow(ran({ sessionId: null }), facts());
    expect(FollowUpVerdictSchema.parse(refused)).toEqual(refused);
    // 「不可行却没原因」在线上被拦下（判别联合的第二种只认非空原因）——
    // 界面要拿这一格直接说一句人话，空串会让它显示一个没有内容的 Tooltip
    expect(FollowUpVerdictSchema.safeParse({ ok: false, reason: '' }).success).toBe(false);
    expect(FollowUpVerdictSchema.safeParse({ ok: false }).success).toBe(false);
    expect(FollowUpAvailabilitySchema.safeParse({ rows: [{ rowId: 'r-1', verdict: refused }] }).success).toBe(true);
  });

  it('判据 `ok` 为真时没有原因，为假时原因非空（界面据此说一句人话，不留半句）', () => {
    const samples: FollowUpFacts[] = [
      facts(),
      facts({ settling: true }),
      facts({ workspaceExists: false }),
      facts({ case: { state: 'deleted', caseId: 'case-42' } }),
      facts({ resume: undefined }),
    ];
    for (const sample of samples) {
      const verdict = canFollowUpRow(ran(), sample);
      if (verdict.ok) continue;
      expect(verdict.reason.trim()).not.toBe('');
    }
  });
});
