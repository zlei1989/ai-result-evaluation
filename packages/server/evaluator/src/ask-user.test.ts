// @vitest-environment node
/**
 * 挂起表：待答提问的进程内真相源 + 它的变更信号总线。
 *
 * 风险面全在**接缝**上，不在数据结构上：
 *   1. **HMR 不裂脑**：表与订阅表都挂 `globalThis`（与既有三条总线同一条教训）——
 *      模块作用域的表在 dev 下会裂成两半，「连接是开着的、却一个事件都收不到」；
 *   2. **出表与收场同时发生**：答复之后该问必须从快照里消失（快照是唯一读侧），
 *      且等待方拿到的是**带答案**的那一份；
 *   3. **三处发信号**：登记、答复、取消——少一处，页面就要等到下一次操作才知道清单变了；
 *   4. **重启语义**：表只活在内存里，重启后旧 `askId` 应答不到（不是静默悬挂）。
 *
 * 本文件用**真表**（不 mock）：挂起表是纯内存对象，`afterEach` 把残余条目按「取消」收干净，
 * 免得一条用例留下的待答提问改变下一条的快照断言。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskUserQuestion } from '@aieval/contracts';
import {
  listPendingAskUser,
  registerAskUser,
  resetAskUserForTesting,
  resolveAskUser,
  subscribeAskUserChanges,
  type PendingAskHandle,
  type RegisterAskUserInput,
} from './ask-user';

/** 一条问题样本：三格布尔各有取值，免得「字段抄错」这类错在用例里也被抄一遍 */
const QUESTION: AskUserQuestion = {
  header: '选路径',
  prompt: '这次改动走哪条路？',
  options: [{ label: '原地改', description: '不新建分支', recommended: true }],
  multiSelect: false,
  allowOther: true,
  secret: false,
};

/** 一份与 `QUESTION` 对上的答案 */
const ANSWER = { header: '选路径', selected: ['原地改'], custom: null };

/** 本文件挂上去的信号订阅（用完即退订，别留给后续用例） */
const unsubscribes: Array<() => void> = [];

/** 登记一条提问（各用例只关心自己那几个字段，其余取缺省） */
function register(patch: Partial<RegisterAskUserInput> = {}): PendingAskHandle {
  return registerAskUser({
    askId: 'ask-1',
    runId: 'run-1',
    candidateId: 'candidate-1',
    stage: 'agent',
    request: { questions: [QUESTION], toolName: 'AskUserQuestion', callId: 'call-1', vendorBudgetMs: null, subagentId: null },
    ...patch,
  });
}

/**
 * 取一次调用的抛错，**只留 `Error` 自己的两个字段**（`name` / `code`）。
 * 不返回异常对象本身：变更验证里重载模块的形态会让 `instanceof ServiceError` 因类身份换了一份而假红，
 * 而本文件要断的是「抛的是哪一档」——它由 `code` 说，不由构造器身份说。
 */
function catchError(run: () => unknown): { name: string; code?: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as { name: string; code?: string };
  }
}

beforeEach(() => {
  // 表与已答名单都挂 `globalThis`、跨用例存活：不清的话上一条答过的 id 会让下一条同名提交变成 409
  resetAskUserForTesting();
});

afterEach(() => {
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  // 残留条目按「逐问给空答案」收干净（空 `selected` + 无自由输入是合法答案，形状必然对得上）：
  // 少一条未决议的 promise 挂着，免得它在下一条用例里被误当成「还在等」
  for (const entry of listPendingAskUser()) {
    resolveAskUser(
      entry.askId,
      entry.questions.map((question) => ({ header: question.header, selected: [], custom: null })),
    );
  }
  resetAskUserForTesting();
});

describe('挂起表', () => {
  it('登记之后出现在快照里：定位（轮 / 行 / 段）、问题、提问时刻都带出来', () => {
    register();

    expect(listPendingAskUser()).toEqual([
      {
        askId: 'ask-1',
        runId: 'run-1',
        candidateId: 'candidate-1',
        stage: 'agent',
        questions: [QUESTION],
        askedAt: expect.any(String),
      },
    ]);

    // 快照不带宽商上下文（工具名 / 调用 id / 厂商预算）：界面没有消费方，见契约文件头
    expect(Object.keys(listPendingAskUser()[0] ?? {})).not.toContain('toolName');
  });

  it('快照按提问顺序给（界面的先来后到由这一刻决定，不由界面自己排）', () => {
    register({ askId: 'ask-a' });
    register({ askId: 'ask-b' });
    register({ askId: 'ask-c' });

    expect(listPendingAskUser().map((entry) => entry.askId)).toEqual(['ask-a', 'ask-b', 'ask-c']);
  });

  it('答复之后该问从快照里消失，且等待方拿到的正是那一份答案（出表与收场同时发生）', async () => {
    const handle = register();
    const settled = resolveAskUser('ask-1', [ANSWER]);

    expect(settled.askId).toBe('ask-1');
    expect(settled.answeredAt).toEqual(expect.any(String));
    // 快照是唯一读侧：答完之后界面上不该再有这一问
    expect(listPendingAskUser()).toEqual([]);
    await expect(handle.outcome).resolves.toEqual({ outcome: 'answered', answers: [ANSWER] });
  });

  it('幂等：首个生效、后到 409、未知 404（三种都是 ServiceError，路由层按 code 映射）', async () => {
    const handle = register();
    resolveAskUser('ask-1', [ANSWER]);

    // 后到的第二份提交：这一问曾经存在 ⇒ 409（界面提示「已经答过了」），不是 404（那会让客户端去刷新快照）
    expect(catchError(() => resolveAskUser('ask-1', [ANSWER]))?.code).toBe('CONFLICT');

    // 从没登记过的 id：404
    expect(catchError(() => resolveAskUser('ask-没有这一条', [ANSWER]))?.code).toBe('NOT_FOUND');

    // 那一问只被决议了一次：后到的那份从头到尾没碰到它
    await expect(handle.outcome).resolves.toEqual({ outcome: 'answered', answers: [ANSWER] });
  });

  it('并发两份提交只有一个生效：后到的那份拿 409，等待方只收到一次收场', async () => {
    const handle = register();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => resolveAskUser('ask-1', [ANSWER])),
      Promise.resolve().then(() => resolveAskUser('ask-1', [ANSWER])),
    ]);

    expect(results.map((result) => (result.status === 'fulfilled' ? 'ok' : (result.reason as Error).name))).toEqual([
      'ok',
      'ServiceError',
    ]);
    await expect(handle.outcome).resolves.toEqual({ outcome: 'answered', answers: [ANSWER] });
  });

  it('答案与问题逐问对不上 ⇒ 400，且**不消耗**这一次应答机会（改一版重发仍然能答）', async () => {
    const handle = register({
      request: {
        questions: [QUESTION, { ...QUESTION, header: '要不要补测试' }],
        toolName: 'AskUserQuestion',
        callId: 'call-1',
        vendorBudgetMs: null,
        subagentId: null,
      },
    });

    expect(catchError(() => resolveAskUser('ask-1', [ANSWER]))?.code).toBe('INVALID_QUERY');
    // 只答了一问：形状不对不该把这一问从待答清单里抹掉
    expect(listPendingAskUser()).toHaveLength(1);

    // 顺序反了同样是错位（回灌进厂商钩子的那一份按位置对齐）
    expect(
      catchError(() =>
        resolveAskUser('ask-1', [
          { header: '要不要补测试', selected: [], custom: null },
          ANSWER,
        ]),
      )?.code,
    ).toBe('INVALID_QUERY');

    resolveAskUser('ask-1', [
      ANSWER,
      { header: '要不要补测试', selected: [], custom: '先不加' },
    ]);
    await expect(handle.outcome).resolves.toEqual({
      outcome: 'answered',
      answers: [ANSWER, { header: '要不要补测试', selected: [], custom: '先不加' }],
    });
  });

  it('候选终止 ⇒ 这一问落「随本轮取消」并出表（不是静默悬挂）', async () => {
    const controller = new AbortController();
    const handle = register({ signal: controller.signal });

    controller.abort();

    await expect(handle.outcome).resolves.toEqual({ outcome: 'canceled', answers: null });
    expect(listPendingAskUser()).toEqual([]);
  });

  it('登记时就已中止 ⇒ 不进表（快照里不该出现一条永远不会被答复的提问）', async () => {
    const controller = new AbortController();
    controller.abort();

    const handle = register({ signal: controller.signal });

    expect(listPendingAskUser()).toEqual([]);
    await expect(handle.outcome).resolves.toEqual({ outcome: 'canceled', answers: null });
  });

  it('收场是幂等的：取消之后答复拿 404，且等待方不会被二次决议', async () => {
    const handle = register();
    handle.settle('timeout');
    await expect(handle.outcome).resolves.toEqual({ outcome: 'timeout', answers: null });

    // 超时之后这一问已经不在表里：此时到的人与「从没问过」是同一个 404
    expect(catchError(() => resolveAskUser('ask-1', [ANSWER]))?.code).toBe('NOT_FOUND');
    await expect(handle.outcome).resolves.toEqual({ outcome: 'timeout', answers: null });
  });

  it('重复登记同一个 askId 直接抛错（一个 id 两次等待，后一个答复会去向不明）', () => {
    register();
    expect(catchError(() => register())?.code).toBe('CONFLICT');
  });

  it('三处各发一条「变了」：登记、答复、取消（少一处页面就要等下一次操作才知道清单变了）', () => {
    const seen: string[] = [];
    unsubscribes.push(subscribeAskUserChanges(() => seen.push('changed')));

    register();
    expect(seen).toHaveLength(1);

    resolveAskUser('ask-1', [ANSWER]);
    expect(seen).toHaveLength(2);

    // 取消那一路（超时 / 候选终止走的是同一个 settle）：登记一次、收场一次
    register({ askId: 'ask-2' }).settle('canceled');
    expect(seen).toHaveLength(4);
  });

  it('live-only：订阅之前的变更不回放（要当前状态就读快照）', () => {
    register({ askId: 'ask-early' }).settle('skipped');

    const seen: string[] = [];
    unsubscribes.push(subscribeAskUserChanges(() => seen.push('changed')));
    register({ askId: 'ask-late' }).settle('skipped');

    expect(seen).toHaveLength(2);
  });

  it('退订之后不再投递；坏订阅者既不打断其余订阅者、也不把这次应答变成失败', async () => {
    const seen: string[] = [];
    const unsubscribeBroken = subscribeAskUserChanges(() => {
      throw new Error('这个订阅者坏了');
    });
    unsubscribes.push(subscribeAskUserChanges(() => seen.push('changed')));

    const handle = register();
    resolveAskUser('ask-1', [ANSWER]);
    expect(seen).toHaveLength(2);
    // 应答本身照常成功：一个坏订阅者不能把一次应答变成 500
    await expect(handle.outcome).resolves.toEqual({ outcome: 'answered', answers: [ANSWER] });

    unsubscribeBroken();
    register({ askId: 'ask-2' }).settle('canceled');
    expect(seen).toHaveLength(4);
  });

  /**
   * 与既有三条总线的同款守卫同一条理由：dev 的 HMR 会重新实例化模块，
   * 表若放模块作用域，「新实例接线的应答面」与「旧实例登记的那一问」就是两张表——
   * 症状是快照恒空、应答恒 404，而连接本身完全正常。
   */
  it('模块重新实例化后表不分裂：新实例登记的那一问，旧实例的快照、订阅与应答都能碰到（dev HMR 的形状）', async () => {
    const seen: string[] = [];
    unsubscribes.push(subscribeAskUserChanges(() => seen.push('changed')));

    vi.resetModules();
    const reloaded = await import('./ask-user');
    const handle = reloaded.registerAskUser({
      askId: 'ask-after-hmr',
      runId: 'run-1',
      candidateId: 'candidate-1',
      stage: 'agent',
      request: { questions: [QUESTION], toolName: 'AskUserQuestion', callId: 'call-1', vendorBudgetMs: null, subagentId: null },
    });

    // 旧实例的读侧看得到新实例登记的那一问，旧实例的订阅者也收到了信号
    expect(listPendingAskUser().map((entry) => entry.askId)).toEqual(['ask-after-hmr']);
    expect(seen).toHaveLength(1);

    // 反过来：旧实例的写入口（应答面）能答复新实例登记的那一问
    resolveAskUser('ask-after-hmr', [ANSWER]);
    await expect(handle.outcome).resolves.toEqual({ outcome: 'answered', answers: [ANSWER] });
  });
});
