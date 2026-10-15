// @vitest-environment node
/**
 * 应答面的 api 层：待答快照与应答受理。
 *
 * 挂起表本身由 `@aieval/evaluator` 的用例负责（真表），本文件把那一层换成受控的假表：
 * 这里要验的是**接缝**——清单原样透出、答案原样带回、收场结果带上两个时刻。
 * 用工柄 + `vi.mock` 而不是真表：真表挂 `globalThis`，跨用例存活会让断言随执行顺序变化。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, type AskUserAnswer, type AskUserQuestion } from '@aieval/contracts';
import { answerAskUser, getPendingAskUser } from './ask-user';

/** 假挂起表：本文件这两条用例的全部输入 */
const table = vi.hoisted(() => ({ pending: [] as unknown[], resolved: [] as Array<{ askId: string; answers: unknown[] }> }));

vi.mock('@aieval/evaluator', () => ({
  listPendingAskUser: vi.fn(() => table.pending),
  resolveAskUser: vi.fn((askId: string, answers: unknown[]) => {
    if (table.resolved.some((entry) => entry.askId === askId)) {
      throw new ServiceError('CONFLICT', '这一问已经答过了（首个应答生效，后到的提交不再处理）');
    }
    table.resolved.push({ askId, answers });
    return { askId, answeredAt: '2026-10-13T12:00:05.000Z' };
  }),
}));

/** 一条问题样本 */
const QUESTION: AskUserQuestion = {
  header: '选路径',
  prompt: '这次改动走哪条路？',
  options: [{ label: '原地改', description: null, recommended: false }],
  multiSelect: false,
  allowOther: false,
  secret: false,
};

/** 一条待答提问（快照的形状由 evaluator 给，这里只是把它摆进假表） */
const PENDING = {
  askId: 'ask-1',
  runId: 'run-1',
  rowId: 'row-1',
  stage: 'agent' as const,
  questions: [QUESTION],
  askedAt: '2026-10-13T12:00:00.000Z',
};

const ANSWER: AskUserAnswer = { header: '选路径', selected: ['原地改'], custom: null };

beforeEach(() => {
  table.pending = [];
  table.resolved = [];
});

describe('待答快照', () => {
  it('原样透出清单（本层不缓存、不排序：界面要的先来后到就是表里那一刻的顺序）', () => {
    table.pending = [PENDING, { ...PENDING, askId: 'ask-2', rowId: null }];

    expect(getPendingAskUser()).toEqual(table.pending);
  });

  it('没人提问时给空数组（不是 null：客户端一个 for-of 就能跑）', () => {
    expect(getPendingAskUser()).toEqual([]);
  });

  it('按 runId 过滤：只给该轮的条目；不传（或空串）时给全部', () => {
    table.pending = [PENDING, { ...PENDING, askId: 'ask-2', runId: 'run-2', rowId: null }];

    // 归属过滤走的是**条目自己那一格 runId**（信号帧不带归属，读侧才是权威）
    expect(getPendingAskUser('run-1').map((item) => item.askId)).toEqual(['ask-1']);
    expect(getPendingAskUser('run-2').map((item) => item.askId)).toEqual(['ask-2']);
    // 没有这一轮的提问时给空数组（客户端不必区分「没问过」与「过滤掉了」）
    expect(getPendingAskUser('run-没有这一轮')).toEqual([]);
    expect(getPendingAskUser()).toHaveLength(2);
    // 空串 = 没给过滤（runId 不可能是空串，见 api 的说明）
    expect(getPendingAskUser('')).toHaveLength(2);
  });
});

describe('应答受理', () => {
  it('首个应答：返回这一问的收场结果，答案原样带回，并补上服务端的答时刻', () => {
    const accepted = answerAskUser('ask-1', [ANSWER]);

    expect(accepted).toEqual({
      askId: 'ask-1',
      answer: { outcome: 'answered', answers: [ANSWER] },
      answeredAt: '2026-10-13T12:00:05.000Z',
    });
    expect(table.resolved).toEqual([{ askId: 'ask-1', answers: [ANSWER] }]);
  });

  it('后到的第二份提交：假表抛 CONFLICT，本层原样透出（路由层据此映射 409）', () => {
    answerAskUser('ask-1', [ANSWER]);

    expect(() => answerAskUser('ask-1', [ANSWER])).toThrow(ServiceError);
    // 表里只留下第一份：后到的那一份从头到尾没生效
    expect(table.resolved).toEqual([{ askId: 'ask-1', answers: [ANSWER] }]);
  });
});
