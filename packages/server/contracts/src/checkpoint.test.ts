/**
 * `checkpoint.ts` 的契约判据：能力声明的配对规则、作废范围的边界、读侧默认跳过与向后兼容。
 *
 * 这些用例只碰纯函数与 schema —— 厂商适配与编排层的接线在各自的包里钉。
 */
import { describe, expect, it } from 'vitest';
import {
  CheckpointCapabilitySchema,
  EvalRowSchema,
  visibleMessages,
  voidedByAny,
  withoutVoidedTotals,
  type CheckpointVoid,
} from './index';

/** 一条作废标记：回到首段第 2 轮，当时已有 0..3 四段 */
function mark(overrides: Partial<CheckpointVoid> = {}): CheckpointVoid {
  return {
    checkpointId: 'cp-1',
    segment: 0,
    turn: 2,
    throughSegment: 3,
    at: '2026-10-19T00:00:00.000Z',
    tokens: { input: 100, cached: 40, output: 10 },
    turns: 2,
    ...overrides,
  };
}

describe('CheckpointCapabilitySchema：声明四格必须自洽', () => {
  it('支持的两档都合法（resume-at 带 filesRewind / fork 不带）', () => {
    const resumeAt = CheckpointCapabilitySchema.safeParse({
      supported: true,
      mode: 'resume-at',
      filesRewind: true,
      reason: null,
      notes: [],
    });
    const fork = CheckpointCapabilitySchema.safeParse({
      supported: true,
      mode: 'fork',
      filesRewind: false,
      reason: null,
      notes: [],
    });
    expect(resumeAt.success).toBe(true);
    expect(fork.success).toBe(true);
  });

  it('不支持时缺原因 / 带 mode / 声明文件回退 都不合法', () => {
    const base = { supported: false, mode: null, filesRewind: false, reason: 'not-supported', notes: [] };
    expect(CheckpointCapabilitySchema.safeParse(base).success).toBe(true);
    expect(CheckpointCapabilitySchema.safeParse({ ...base, reason: null }).success).toBe(false);
    expect(CheckpointCapabilitySchema.safeParse({ ...base, mode: 'fork' }).success).toBe(false);
    expect(CheckpointCapabilitySchema.safeParse({ ...base, filesRewind: true }).success).toBe(false);
  });

  it('支持时不许带原因、必须给 mode', () => {
    const base = { supported: true, mode: 'fork', filesRewind: false, reason: null, notes: [] };
    expect(CheckpointCapabilitySchema.safeParse({ ...base, reason: 'not-supported' }).success).toBe(false);
    expect(CheckpointCapabilitySchema.safeParse({ ...base, mode: null }).success).toBe(false);
  });
});

describe('voidedByAny：作废范围的三个边界', () => {
  const record = (segment: number, roundTrip: number) => ({ segment, roundTrip });

  it('回退点之前的段不动作废、同段只作废更晚的轮次（含边界那一轮保留）', () => {
    const marks = [mark()];
    expect(voidedByAny(marks, record(0, 2))).toBe(false);
    expect(voidedByAny(marks, record(0, 3))).toBe(true);
    expect(voidedByAny(marks, record(0, 1))).toBe(false);
  });

  it('回退点之后的旧段整段作废，但标记之后新追加的段不误伤', () => {
    const marks = [mark({ throughSegment: 3 })];
    expect(voidedByAny(marks, record(1, 1))).toBe(true);
    expect(voidedByAny(marks, record(3, 9))).toBe(true);
    expect(voidedByAny(marks, record(4, 1))).toBe(false);
  });

  it('没有标记时一条都不作废（旧数据的默认读法）', () => {
    expect(voidedByAny([], record(0, 1))).toBe(false);
  });
});

describe('visibleMessages：读侧默认跳过，显式开关才给作废段', () => {
  const messages = [
    { id: 'kept', segment: 0, roundTrip: 2 },
    { id: 'voided-tail', segment: 0, roundTrip: 3 },
    { id: 'voided-segment', segment: 1, roundTrip: 1 },
    { id: 'new-segment', segment: 4, roundTrip: 1 },
  ];

  it('默认视图里作废段整段消失，保留段与标记之后的新段照旧', () => {
    expect(visibleMessages(messages, [mark()]).map((message) => message.id)).toEqual(['kept', 'new-segment']);
  });

  it('显式 includeVoided 才原样给出（用于「看被作废的那一段」）', () => {
    expect(visibleMessages(messages, [mark()], { includeVoided: true })).toHaveLength(messages.length);
  });
});

describe('withoutVoidedTotals：用量与轮次扣掉作废段', () => {
  it('逐项相减，扣到负数时夹到 0', () => {
    const totals = withoutVoidedTotals(
      { tokens: { input: 120, cached: 40, output: 12 }, turns: 5 },
      [mark({ tokens: { input: 100, cached: 40, output: 10 }, turns: 2 })],
    );
    expect(totals).toEqual({ tokens: { input: 20, cached: 0, output: 2 }, turns: 3 });
    expect(
      withoutVoidedTotals({ tokens: { input: 1, cached: 1, output: 1 }, turns: 1 }, [mark()]).tokens,
    ).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it('本来没采到计量时仍是 null（不因为扣减变成 0）', () => {
    expect(withoutVoidedTotals({ tokens: null, turns: null }, [mark()])).toEqual({ tokens: null, turns: null });
  });
});

describe('旧 run.json 的向后兼容', () => {
  it('行快照缺席 checkpointVoids 时按「未作废」读', () => {
    const parsed = EvalRowSchema.parse({
      id: 'row-1',
      agentKind: 'cc',
      providerId: 'p-1',
      providerName: '网关',
      baseUrl: 'https://example.test',
      modelId: 'm-1',
      status: 'judged',
      branch: 'test/row-1',
      workspacePath: '/tmp/row-1',
      baselineCommit: 'a'.repeat(40),
      tokens: null,
      turns: null,
      durationMs: null,
      diff: null,
      score: null,
      error: null,
    });
    expect(parsed.checkpointVoids).toBeUndefined();
  });
});
