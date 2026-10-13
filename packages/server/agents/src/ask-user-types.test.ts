// @vitest-environment node
/**
 * **提问端口的类型面**（`AgentRunInput.onAskUser` 与它的请求 / 答复两格）。
 *
 * 为什么需要一条单独的守卫：这一格与既有三条流**不是同一种形状**——它必须被 await、
 * 允许阻塞本次运行、并且会改变本次运行的结论（用户答了什么，模型就照什么干）。
 * 而它的形状分散在三处（编排层实现它、适配器调用它、骨架等待它），任何一处按自己的理解
 * 漂一格（把 `vendorBudgetMs` 写成毫秒字符串、把答复的 `answers` 写成必填数组），
 * 症状都是运行时才发现，且看起来像「适配器没接」。
 *
 * 判据刻意是**编译期**的（与 `contracts-alignment.test.ts` 同一类）：形状漂移时红的是
 * `pnpm typecheck`，运行期断言只负责证明这些函数真的被调用过。
 * 手法也同源：用**函数签名**而不是 `const x: T = ...` 互相赋值——带类型标注的字面量初始化会被
 * TS 的控制流分析窄化成字面量类型，那种写法对「本地类型变宽」没有区分力。
 */
import type { AskUserAnswer, AskUserOutcome, AskUserQuestion } from '@aieval/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentRunInput, AgentRunResult, AskUserReply, AskUserRequest } from './types';

/**
 * 请求的五格（独立写下的字面形状，不是从 `AskUserRequest` 反推的）：
 * 问题数组 + 厂商原始工具名 + 调用 id + 厂商自己的等待预算 + 子智能体身份。
 */
interface RequestShape {
  questions: AskUserQuestion[];
  toolName: string;
  callId: string;
  vendorBudgetMs: number | null;
  subagentId: string | null;
}

/** 答复的两格：收场方式（七态之一）+ 答案（`null` = 收场了但没有答案可回填） */
interface ReplyShape {
  outcome: AskUserOutcome;
  answers: AskUserAnswer[] | null;
}

const question: AskUserQuestion = {
  header: '选路径',
  prompt: '用哪条路径？',
  options: [{ label: '选项 A', description: null, recommended: true }],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

const request: AskUserRequest = {
  questions: [question],
  toolName: 'AskUserQuestion',
  callId: 'call_1',
  vendorBudgetMs: 120_000,
  subagentId: null,
};

const reply: AskUserReply = {
  outcome: 'answered',
  answers: [{ header: '选路径', selected: ['选项 A'], custom: null }],
};

describe('提问端口的类型面', () => {
  it('请求五格（编译期：两个方向都要能赋值）', () => {
    const toShape = (value: AskUserRequest): RequestShape => value;
    const fromShape = (value: RequestShape): AskUserRequest => value;
    // 厂商侧没有等待预算时是 `null`（`0` 会被读成「立刻就超时」，与本仓「绝不填 0」同一条口径）
    const noBudget: AskUserRequest = { ...request, vendorBudgetMs: null };
    expect(toShape(request)).toBe(request);
    expect(fromShape(request)).toBe(request);
    expect(toShape(noBudget).vendorBudgetMs).toBeNull();
  });

  it('答复两格（编译期：两个方向都要能赋值）', () => {
    const toShape = (value: AskUserReply): ReplyShape => value;
    const fromShape = (value: ReplyShape): AskUserReply => value;
    // 「收场了但没有答案可回填」是合法答复：没人答得到答案与答了空答案是两件事
    const unanswered: AskUserReply = { outcome: 'timeout', answers: null };
    expect(toShape(reply)).toBe(reply);
    expect(fromShape(reply)).toBe(reply);
    expect(toShape(unanswered).answers).toBeNull();
  });

  it('回调可选、返回 Promise（编译期）', () => {
    // 可选：不传它照样是一份合法的运行入参——「默认不介入」这条边界必须在类型上成立
    const withoutCallback: Pick<AgentRunInput, 'onAskUser'> = {};
    // 返回 Promise：它是唯一一格「要 await」的回调，写成 `void` 会让骨架无从等待
    const returnsPromise: ReturnType<NonNullable<AgentRunInput['onAskUser']>> extends Promise<AskUserReply> ? true : false = true;
    expect(withoutCallback).toEqual({});
    expect(returnsPromise).toBe(true);
  });

  it('运行结果一格都不加（编译期）', () => {
    // 问答的结果落事件与消息账本，不进运行结果——这一格一旦多出来，消费方会以为
    // 「没有它」的那些老数据缺了一块，而真相是那一期根本没有问答
    const resultHasNoAskUserCell: Extract<keyof AgentRunResult, 'askUser' | 'askUserOutcome' | 'answers'> extends never ? true : false = true;
    expect(resultHasNoAskUserCell).toBe(true);
  });
});
