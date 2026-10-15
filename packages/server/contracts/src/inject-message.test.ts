// @vitest-environment node
/**
 * 「人向运行中的智能体追加消息」这一面的**契约格**：轮级闸门、行快照的两格、账本的 `origin`、
 * 附件上限常量。
 *
 * 每个新格都有一条**旧数据**用例：老 `run.json` / 老 `messages.jsonl` 里没有它们，
 * 写成必填会让 `listRuns()` 静默跳过那一轮、让回放成片解析失败——两端都不报错。
 * 「表单收得下」那一组防的是另一件事：zod 3 的 `z.object` 默认 strip 未知键，
 * 不在契约里声明的话，表单提交的那一格会被**静默丢掉**（不是 400）。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  AgentMessageSchema,
  MessageOriginSchema,
  messageFoldKey,
} from './agent-message';
import { InjectMessageSchema } from './inject-message';
import { EvalRowSchema, EvalRunSchema } from './run';

/** 行快照的最小合法形状（不含本轮新增的两格） */
const row = {
  id: 'row-1',
  agentKind: 'cc' as const,
  providerId: 'p-1',
  providerName: '网关',
  baseUrl: 'https://gateway.invalid',
  modelId: 'm-1',
  status: 'pending' as const,
  branch: 'test/row-1',
  workspacePath: 'D:/runs/run-1/rows/row-1/workspace',
  baselineCommit: '',
  tokens: null,
  turns: null,
  durationMs: null,
  diff: null,
  score: null,
  error: null,
  attempts: 0,
};

/** 老 `run.json` 的最小合法形状（不含本轮新增的三格） */
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

/**
 * 类型面判据（真判据是 `tsc` 见红，不是这里的断言）：三个新格**不许退化成可选键**。
 * 为什么载重：「恒有这一格」与「可以缺席」在消费侧是两件事——`sessionId` 缺席会被读成
 * 「这一行是旧产物」而被拒追问，而它其实只是没写；`injectMessages` 缺席会被读成「这一轮没开闸门」，
 * 于是人在界面上打开过的开关在落盘后静默变回关闭。
 */
type RequiredCell<T, K extends keyof T> = undefined extends T[K] ? false : true;
const rowSessionIdIsRequired: RequiredCell<import('./run').EvalRow, 'sessionId'> = true;
const followUpsIsRequired: RequiredCell<import('./run').EvalRow, 'followUps'> = true;
const followUpRoundsIsRequired: RequiredCell<import('./run').EvalRow, 'followUpRounds'> = true;
const gateIsRequired: RequiredCell<import('./run').EvalRun, 'injectMessages'> = true;

describe('轮级闸门 EvalRun.injectMessages', () => {
  it('缺字段读成 false（旧 run.json 没有这一格），显式值逐字保留', () => {
    expect(EvalRunSchema.parse({ ...run, injectMessages: undefined }).injectMessages).toBe(false);
    expect(EvalRunSchema.parse({ ...run, injectMessages: true }).injectMessages).toBe(true);
  });

  it('新格都不是可选键（`tsc` 见红的那条判据的运行时影子）', () => {
    expect([rowSessionIdIsRequired, followUpsIsRequired, followUpRoundsIsRequired, gateIsRequired]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe('行快照的三格：sessionId / followUps / followUpRounds', () => {
  it('sessionId 缺字段读成 null（旧 run.json 没有这一格——它就是「不能追问」的那一档）', () => {
    expect(EvalRowSchema.parse({ ...row, sessionId: undefined }).sessionId).toBeNull();
    expect(EvalRowSchema.parse({ ...row, sessionId: 'sess-1' }).sessionId).toBe('sess-1');
    // 空串不是会话 id：留着它会让「有会话」这条判据被一个没有内容的字符串满足
    expect(EvalRowSchema.safeParse({ ...row, sessionId: '' }).success).toBe(false);
  });

  it('followUps 缺字段读成 0（旧 run.json 没有这一格），显式计数逐字保留', () => {
    expect(EvalRowSchema.parse({ ...row, followUps: undefined }).followUps).toBe(0);
    expect(EvalRowSchema.parse({ ...row, followUps: 3 }).followUps).toBe(3);
    // 计数只增不减：负数与小数都不是「追问了几次」
    expect(EvalRowSchema.safeParse({ ...row, followUps: -1 }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, followUps: 1.5 }).success).toBe(false);
  });

  /**
   * 两格数的是**两件事**，故各自独立：`followUps` = 已送达的人工消息条数（账本对齐），
   * `followUpRounds` = 追问轮次。一格里兼两义的症状是「先送进去 2 条、再追问 1 次」被读成
   * 「追问了 3 次」——日志里那句「第几次」当场就是假的。
   */
  it('followUpRounds 缺字段读成 0（旧 run.json 没有这一格），且与 followUps 各记各的', () => {
    expect(EvalRowSchema.parse({ ...row, followUpRounds: undefined }).followUpRounds).toBe(0);
    const parsed = EvalRowSchema.parse({ ...row, followUps: 3, followUpRounds: 1 });
    expect([parsed.followUps, parsed.followUpRounds]).toEqual([3, 1]);
    // 轮次同样只增不减：负数与小数都不是「追问了几轮」
    expect(EvalRowSchema.safeParse({ ...row, followUpRounds: -1 }).success).toBe(false);
    expect(EvalRowSchema.safeParse({ ...row, followUpRounds: 1.5 }).success).toBe(false);
  });
});

describe('账本 origin：题面那一档与人在半路插的那一档', () => {
  const messageBase = {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'user' as const,
    source: 'wire' as const,
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot' as const,
    assembly: 'snapshot' as const,
    mergeKey: 'main|1|user|-',
    blocks: [{ type: 'text' as const, text: '先跑一遍测试' }],
    raw: null,
  };

  it('缺字段读成题面那一档（旧账本照读），human 逐字保留', () => {
    expect(AgentMessageSchema.parse({ ...messageBase, origin: undefined }).origin).toBe('case-prompt');
    expect(AgentMessageSchema.parse({ ...messageBase, origin: 'human' }).origin).toBe('human');
  });

  it('取值只有两档，一个词都不加', () => {
    expect([...MessageOriginSchema.options]).toEqual(['case-prompt', 'human']);
    expect(AgentMessageSchema.safeParse({ ...messageBase, origin: 'operator' }).success).toBe(false);
  });
});

/**
 * `segment` 那一格：两段的 `mergeKey` 会逐字相同（追问是又开一次 `run()`，厂商轮次从 1 重数），
 * 读侧折叠必须带上段号才分得开。整格缺席读成 0 ⇒ 旧账本（没有这一格）行为逐字不变。
 */
describe('账本 segment：第一次跑那一段与第 n 次追问那一段', () => {
  const messageBase = {
    messageId: 'run-1:1',
    vendorId: null,
    role: 'assistant' as const,
    source: 'wire' as const,
    origin: 'case-prompt' as const,
    roundTrip: 1,
    turn: null,
    step: null,
    parentCallId: null,
    subagentId: null,
    chunk: 'snapshot' as const,
    assembly: 'snapshot' as const,
    mergeKey: 'main|1|assistant|-',
    blocks: [{ type: 'text' as const, text: '第一段说的话' }],
    raw: null,
  };

  it('整格缺席 = 第一次跑那一段（折叠键按 0 算），追问那一段逐字保留', () => {
    const older = AgentMessageSchema.parse({ ...messageBase, segment: undefined });
    expect(older.segment).toBeUndefined();
    expect(messageFoldKey(older)).toBe('0:main|1|assistant|-');
    expect(messageFoldKey(AgentMessageSchema.parse({ ...messageBase, segment: 2 }))).toBe('2:main|1|assistant|-');
    // 写 0 与缺席同义（两者都指第一次跑那一段）
    expect(messageFoldKey(AgentMessageSchema.parse({ ...messageBase, segment: 0 }))).toBe(messageFoldKey(older));
  });

  it('负数与小数都不是「第几段」', () => {
    expect(AgentMessageSchema.safeParse({ ...messageBase, segment: -1 }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ ...messageBase, segment: 1.5 }).success).toBe(false);
  });
});

describe('附件上限常量（前后端同一处读）', () => {
  it('单文件 20 MB / 单条消息 10 个', () => {
    expect(ATTACHMENT_MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    expect(ATTACHMENT_MAX_PER_MESSAGE).toBe(10);
  });

  it('两条限制各自独立：超限的中文原因要能点名是哪一条', () => {
    expect(Number.isInteger(ATTACHMENT_MAX_FILE_BYTES)).toBe(true);
    expect(Number.isInteger(ATTACHMENT_MAX_PER_MESSAGE)).toBe(true);
    expect(ATTACHMENT_MAX_FILE_BYTES).toBeGreaterThan(0);
    expect(ATTACHMENT_MAX_PER_MESSAGE).toBeGreaterThan(0);
  });
});

/**
 * 一条人工消息的**三个时刻**的形状。
 *
 * 钉 ISO 8601 带时区字符串（与提问应答面的 `askedAt` 同一口径）：它们要跨进程落盘、要给人读、
 * 还要与行上别的时刻（`EvalRun.createdAt` 等）并排显示。epoch 毫秒进来之后每一条消费路径都得
 * 自己知道「这一格是数字」，界面要为此并列两个格式化函数——同一种东西两种形状，漂是必然的。
 */
describe('三个时刻一律 ISO 8601 带时区字符串', () => {
  const message = {
    messageId: 'm-1',
    text: '先跑一遍测试',
    attachments: [],
    requires: 'idle' as const,
    state: 'queued' as const,
    /** 还没交出去、也还没落终态：另两格的合法取值 */
    deliveredAt: null,
    settledAt: null,
    outcome: null,
    reason: null,
  };

  it('三格收 ISO 串，且往返之后逐字不变（本地时区不参与落盘）', () => {
    const parsed = InjectMessageSchema.parse({
      ...message,
      createdAt: '2026-09-22T10:30:00.000Z',
      deliveredAt: '2026-09-22T10:31:00.000Z',
    });
    expect(new Date(parsed.createdAt).toISOString()).toBe(parsed.createdAt);
    expect(new Date(parsed.deliveredAt ?? '').toISOString()).toBe(parsed.deliveredAt);
    expect(parsed.settledAt).toBeNull();
  });

  it('epoch 毫秒一律拒掉 —— 三格都不许收数字', () => {
    for (const field of ['createdAt', 'deliveredAt', 'settledAt'] as const) {
      const payload = { ...message, createdAt: '2026-09-22T10:30:00.000Z', [field]: 1_753_000_000_000 };
      expect(InjectMessageSchema.safeParse(payload).success, `${field} 收下了 epoch 毫秒`).toBe(false);
    }
  });

  it('`createdAt` 必填（它是排队起算点），另两格可空（没交出去 / 还没落终态）', () => {
    const parsed = InjectMessageSchema.safeParse(message);
    expect(parsed.success, '缺 createdAt 也放过了').toBe(false);
    expect(InjectMessageSchema.safeParse({ ...message, createdAt: '2026-09-22T10:30:00.000Z' }).success).toBe(true);
  });
});
