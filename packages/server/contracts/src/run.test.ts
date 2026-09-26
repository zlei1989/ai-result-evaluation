// @vitest-environment node
/**
 * 评测契约：智能体真源、行状态机、EvalRow / EvalRun 形状、创建 / 编辑入参、diff 响应、
 * 三个行级动作判据，以及编辑与删除共用的两条判据（`hasLiveRows` / `isSameRowTarget`）。
 * 注意：本文件最有价值的六条守卫分别是
 *   ① AGENT_KINDS 与 §5.6.2 的表同序同值（R1）；
 *   ② TERMINAL_ROW_STATUSES / ROW_STATUS_LABELS 覆盖全部状态（新增状态时忘同步会当场红）；
 *   ③ isRunnableRow 的集合划分（judged 不可重跑，preparing/running/judging 不是「可执行」而是「在跑」）；
 *   ④ EvalRow.baselineCommit 必填但允许空串（R2：没有它 diff 没有可比基线；空串 = 尚未准备）；
 *   ⑤ EvalRow.providerId 必填（R8：展示快照会被改名，凭据只能按 id 定位）；
 *   ⑥ EvalRow.error.code 必填（R9：界面要靠它区分超时 / 限流 / 密钥无效 / 评分解析失败）。
 * 另有三条守卫是实施时补上的（见各 it 内注释）：本文件消费的 `ScoreResultSchema`（Task 5）
 * 与 `diff` / `tokens` 形状、`RunCreate.providerId` 必填——它们在契约测试里原先没有断言，
 * 对应的变异体会存活（把 `ScoreResultSchema` 换成 `z.any()` 也能全绿）。
 * 另一条是 2026-09-28 用户口径落地时补的：`canRescoreRow` / `canRetryRow` 的真值表各钉一遍
 * （当时两者分叉：前者要求 `error.stage === 'judge'`、后者要求状态是「跑过但没跑成」）。
 * **2026-09-28 晚间口径再变**（用户：「已出分、无报错时取消禁用」）：两个判据都放开了 `judged` 行，
 * 只保留「不在跑 / 有可比基线 / 有已产出改动」这三条硬前提，于是**两者又一次同源**——
 * 但它们的**语义仍然不是一件事**（整段重跑 vs 只重跑评分），故各留一组独立的真值表。
 * 2026-09-28 又补了三组（编辑 / 删除那一版）：`RunUpdateSchema`（创建入参的超集，差别只有候选行可带
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
  RowDiffFileSchema,
  RowDiffIndexSchema,
  RunCreateSchema,
  RunUpdateSchema,
  TERMINAL_ROW_STATUSES,
  canRescoreRow,
  canRetryRow,
  canRunRow,
  hasLiveRows,
  isRunnableRow,
  isRunningRow,
  isSameRowTarget,
  type EvalRow,
  type EvalRowStatus,
  type EvalRun,
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
    // 这一行走过几次尝试（2026-09-27）：这一份是「已评分的行」，故是 1 次
    attempts: 1,
    ...overrides,
  };
}

describe('AGENT_KINDS', () => {
  it('三家智能体与 spec §5.6.2 的表同序同值（R1：真源在 contracts）', () => {
    expect([...AGENT_KINDS]).toEqual(['claude-code', 'codex', 'dsh']);
    expect(AgentKindSchema.options).toEqual([...AGENT_KINDS]);
  });

  it('每家都有中文标签', () => {
    expect(AGENT_LABELS['claude-code']).toBe('Claude Code');
    expect(AGENT_LABELS.codex).toBe('Codex');
    expect(AGENT_LABELS.dsh).toBe('DeepSeek Harness');
  });
});

describe('ExecutionModeSchema', () => {
  it('只有并行与串行两种', () => {
    expect(ExecutionModeSchema.options).toEqual(['parallel', 'serial']);
    expect(ExecutionModeSchema.safeParse('both').success).toBe(false);
  });
});

describe('EvalRowStatus', () => {
  it('十个状态与 spec §5.4 的状态机逐字一致（拼错 timed-out 会让终态判定失效）', () => {
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
    agentKind: 'claude-code' as const,
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

  it('EvalRow 的 baselineCommit 是必填字段，但允许空串表示「尚未准备」（R2）', () => {
    expect(EvalRowSchema.safeParse(row).success).toBe(true);
    const { baselineCommit: _omitted, ...withoutBaseline } = row;
    expect(EvalRowSchema.safeParse(withoutBaseline).success).toBe(false);
    // 空串必须合法：创建评测时基线还没解析（要等 prepare 阶段 rev-parse HEAD），
    // 而 p5 的 createRun 落库时只能填 ''；只有 prepare 之后它才必然是非空 40 位 hash。
    // 若这里恢复成 .min(1)，真实链路上「创建评测」会直接抛 ZodError（p5 的测试 mock 了 evaluator，
    // 所以只有 p6 的冒烟第 3 项才会暴露）。
    expect(EvalRowSchema.safeParse({ ...row, baselineCommit: '' }).success).toBe(true);
  });

  it('EvalRow 要求 providerId（R8）：展示快照 providerName 可以被改名，凭据只能靠 id 定位', () => {
    const { providerId: _dropped, ...withoutProviderId } = row;
    expect(EvalRowSchema.safeParse(withoutProviderId).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, providerId: '' }).success).toBe(false);
  });

  it('EvalRow.error 必须带 code（R9），且 code 是自由字符串而不是枚举', () => {
    // 这一格要同时容纳 AgentErrorCode（§5.6.6）与接口层 ErrorCode（如 JUDGE_PARSE_FAILED），
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
   * 思考强度：行上**可选**（spec D12），创建入参里也必须**显式声明**。
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
      rows: [{ agentKind: 'claude-code' as const, providerId: 'p-1', modelId: 'm' }],
    };
    expect(RunCreateSchema.parse(create).rows[0]?.effort).toBeUndefined();
    expect(
      RunCreateSchema.parse({ ...create, rows: [{ ...create.rows[0], effort: 'max' }] }).rows[0]?.effort,
    ).toBe('max');
  });

  // 补的守卫（缺口）：行上的 status 就是 p4 写、p5 显示、SSE 判终态的那台状态机；
  // 若它退化成任意字符串，一个拼错的状态会一路落库到界面（那一格空白），而两个判定函数只会说「不是在跑」。
  it('EvalRow.status 只接受 EvalRowStatus 的取值（拼错的状态不能落库）', () => {
    expect(EvalRowSchema.safeParse({ ...row, status: 'timed-out' }).success).toBe(true);
    expect(EvalRowSchema.safeParse({ ...row, status: 'timeout' }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, status: 'paused' }).success).toBe(false);
    // 必填：缺了 status 的行读回来会让列表那一格直接空白，也无法判断它该不该进「开始」的集合
    const { status: _omitted, ...withoutStatus } = row;
    expect(EvalRowSchema.safeParse(withoutStatus).success).toBe(false);
  });

  // 补的守卫（缺口）：Task 5 的 ScoreResultSchema 是本文件唯一的跨契约消费点，
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

  // 补的守卫（缺口）：diff / tokens 非空时的形状原先没有断言——p4 写、p5 读都按这四个字段，
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

  it('RunCreate 至少一行候选，每行三个字段都必填', () => {
    const input = {
      caseId: 'c-1',
      executionMode: 'serial',
      rows: [{ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' }],
    };
    expect(RunCreateSchema.safeParse(input).success).toBe(true);
    expect(RunCreateSchema.safeParse({ ...input, rows: [] }).success).toBe(false);
    expect(RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'codex', providerId: 'p-1' }] }).success).toBe(false);
    // providerId 是服务端快照 providerName / baseUrl 的唯一线索（R8）：缺了它这一行落库后无法定位凭据
    expect(RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'codex', modelId: 'gpt-5' }] }).success).toBe(false);
    // agentKind 决定 p5 起哪个适配器：未登记的智能体必须在入口被拦下，而不是落到行上再报「不知道怎么写命令」
    expect(
      RunCreateSchema.safeParse({ ...input, rows: [{ agentKind: 'cursor', providerId: 'p-1', modelId: 'gpt-5' }] }).success,
    ).toBe(false);
  });

  // 补的守卫（缺口）：EvalRun.rows 的元素要逐个过 EvalRowSchema——p5 把整轮读回来时若只校验外层，
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

  // D5 / Review Focus 第 1 条：run-store 的 readSnapshot 用 safeParse 读盘，必填新字段会让磁盘上
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
 * `canRescoreRow`（**2026-09-28 晚间放开**：已出分、无报错的行也给「重新评分」）。
 *
 * 三个条件缺一不可：不在跑 / 有可比基线 / 有已产出的改动。它们收的是**能力前提**
 * （没有工作区就没有可复评的产出），而不是「这一行失败过没有」——用户口径 2026-09-28：
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
 * `canRetryRow`（内部名 retry，界面文案 2026-09-28 起是「**重新执行**」）。
 *
 * 判据与 `canRescoreRow` 现在**又一次同源**（同样是那三条硬前提），但语义不是一件事：
 * 重新执行 = 候选 agent 与评分都重跑（工作区重新准备、分支重建）；重新评分 = 只重跑评分那一步。
 * 这一组把真值表**独立**钉一遍：只靠其中一组的用例覆盖另一个，等于把「两者今天恰好同形」
 * 当成契约——它们随时可能再分叉（今天之前就分叉过一次），而「已出分的行能不能整段重跑」
 * 正是用户 2026-09-28 晚间点名放开的那一格。
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
 * `canRunRow`（2026-09-29 追加，用户口径：「重新执行，只执行当前候选项，不要完成后重新执行下方
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
 * `EvalRow.error.stage`（2026-09-28 追加）。
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
 * 编辑入参（2026-09-28）：创建入参的**超集**，差别只有候选行可带 `id`。
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
    repoPath: 'D:/repos/demo',
    commitHash: null,
    repoBranch: null,
    rubric: { groups: [{ name: 'g', items: [{ id: 'A', goal: '目标', weight: 10 }] }] },
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
 * `isSameRowTarget`：服务端据此决定「这一行要不要重置」，编辑表单据此算「这次会作废哪几行」。
 * 两处必须同源：漂移的症状是「确认框说会作废 2 行、实际作废了 1 行」，而那是用户唯一能核对的地方。
 */
describe('isSameRowTarget', () => {
  const row = makeRow({ agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' });

  it('四个身份字段逐字相同（含强度，两侧都没给）⇒ true', () => {
    expect(isSameRowTarget(row, { agentKind: 'codex', providerId: 'p-1', modelId: 'gpt-5' })).toBe(true);
  });

  it('强度以外的三个字段各自变化都 ⇒ false（漏掉任何一个都会让那一行的旧分数留下来）', () => {
    expect(isSameRowTarget(row, { agentKind: 'claude-code', providerId: 'p-1', modelId: 'gpt-5' })).toBe(false);
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
  // **全量替换**（spec §5.1），缺省只能读成「未指定档位」。这是安全方向——宁可多重置一行（重跑一次），
  // 也不能静默保留一个用户已经改过的档位跑出来的分。Task 8 的编辑表单会回传它。
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
