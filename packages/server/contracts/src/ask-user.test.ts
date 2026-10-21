// @vitest-environment node
/**
 * 待答提问的传输形状：快照一条、应答请求、应答收场结果。
 *
 * 三条判据的靶子（都不是「schema 能不能解析」，而是消费侧会踩的坑）：
 *   1. **`stage` 与既有的失败段同词表**：提问在哪一段发生在排障时与「这一笔失败在哪一段」
 *      是同一个问题，两处各造一套枚举就会让读的人多一次翻译；
 *   2. **应答请求逐问对上**：空数组必须在入口被拒——少答一问会在两天后以「模型说用户选了空」
 *      的形式暴露，那时已经查不到是哪一次应答；
 *   3. **答案侧复用账本那一份**，不在这里另立形状：`selected` 只装标签、`custom` 的
 *      `null` 与 `''` 是两件事，两份形状漂了就会「回灌给厂商的答案」与「落进账本的答案」不一致。
 */
import { describe, expect, it } from 'vitest';
import { AskUserAnswerRequestSchema, AskUserStageSchema, PendingAskUserSchema, CandidateFailureStageSchema } from './index';

/** 一条待答提问的完整样本（`candidateId` 可为空的两种取值各测一遍） */
function pending(patch: Record<string, unknown> = {}) {
  return {
    askId: 'ask-1',
    runId: 'run-1',
    candidateId: 'candidate-1',
    stage: 'agent',
    questions: [
      {
        header: '选路径',
        prompt: '这次改动走哪条路？',
        options: [{ label: '原地改', description: null, recommended: true }],
        multiSelect: false,
        allowOther: true,
        secret: false,
      },
    ],
    askedAt: '2026-10-13T12:00:00.000Z',
    ...patch,
  };
}

describe('待答提问的形状', () => {
  it('stage 与 CandidateFailureStageSchema 同词表（排障时「哪一段」只该有一套说法）', () => {
    expect([...AskUserStageSchema.options]).toEqual([...CandidateFailureStageSchema.options]);
  });

  it('一条待答提问：五格缺一不可，candidateId 允许 null（不在某一个候选上的提问是合法事实）', () => {
    const parsed = PendingAskUserSchema.safeParse(pending());
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success ? parsed.data : null).toEqual(pending());
    expect(PendingAskUserSchema.safeParse(pending({ candidateId: null })).success).toBe(true);

    // 少了 runId 的条目在界面上表现为「有一问在等，但不知道属于谁」——宁可解析失败
    const { runId: _runId, ...missingRun } = pending();
    expect(PendingAskUserSchema.safeParse(missingRun).success).toBe(false);
    expect(PendingAskUserSchema.safeParse(pending({ askId: '' })).success).toBe(false);
  });

  it('应答请求：askId + 至少一条答案，且照账本那一份形状原样收下', () => {
    const answers = [
      { header: '选路径', selected: ['原地改'], custom: null },
      { header: '要不要顺手补测试', selected: [], custom: '先不加' },
    ];
    const parsed = AskUserAnswerRequestSchema.safeParse({ askId: 'ask-1', answers });
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success ? parsed.data : null).toEqual({ askId: 'ask-1', answers });
    // 空数组是「没有任何答案」，不是「答了一问但什么都没选」——后者是 selected: []
    expect(AskUserAnswerRequestSchema.safeParse({ askId: 'ask-1', answers: [] }).success).toBe(false);
    expect(
      AskUserAnswerRequestSchema.safeParse({ askId: 'ask-1', answers: [{ header: '选路径', selected: [] }] }).success,
    ).toBe(false);
    // `askId` 是幂等键，缺了它这一份答案没有归处（不是「答一个默认的那一问」）
    expect(AskUserAnswerRequestSchema.safeParse({ answers }).success).toBe(false);
    expect(AskUserAnswerRequestSchema.safeParse({ askId: '', answers }).success).toBe(false);
    // 裸数组不合法：请求体是一个对象，`askId` 才有地方放
    expect(AskUserAnswerRequestSchema.safeParse(answers).success).toBe(false);
  });
});
