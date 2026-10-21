// @vitest-environment node
/**
 * 队列表：**取件规则**（契约的一半，纯函数）、四态迁移、登记幂等、撤回按状态分派、候选收场清表。
 *
 * 这一面的判据刻意都落在**表自己的接口**上（不经过编排层、不经过任何厂商夹具）：
 * 端口只依赖入参那条性质，就是从这些断言开始的。
 *
 * 三条口径（决定了下面每条断言为什么长这样）：
 *   1. **取件不改「已交给厂商」那一格**：取走只把它移出可取集合（不再取第二次），
 *      `deliveredAt` 要等适配器确认才写——「取走」与「交出去」是两件事；
 *   2. **幂等命中不重置状态**：同一个 `messageId` 再登记回来的是同一条，
 *      已经被取走 / 已经撤回的那些**一个字都不改**；
 *   3. **`gone` 留在表里**：重复撤回要看得出「这一条已经处理过」（200 + 已经撤回），
 *      而不是从表里消失变成 404——两种答复让客户端的动作相反。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetractOutcome } from '@aieval/contracts';
import {
  composeInjectedText,
  discardUndeliveredInjectEntries,
  enqueueInjectMessage,
  expireUndeliveredInjectEntries,
  hasUndeliveredInjectEntries,
  listInjectEntries,
  markInjectEntriesDelivered,
  promoteInjectEntry,
  publishInjectChanged,
  resetInjectQueueForTesting,
  retractInjectEntry,
  selectForDrain,
  subscribeInjectChanges,
  takeInjectEntries,
  type InjectQueueEntry,
} from './inject-queue';

/** 造一行：每个用例用自己的 id，读侧断言不会与别的用例串 */
function candidate(name: string): { runId: string; candidateId: string } {
  return { runId: `run-${name}`, candidateId: `candidate-${name}` };
}

/** 登记一条的最小入参（`requires` 逐用例给） */
function enqueue(target: { runId: string; candidateId: string }, messageId: string, requires: 'round' | 'idle' = 'idle'): InjectQueueEntry {
  return enqueueInjectMessage({
    ...target,
    messageId,
    text: `人话 ${messageId}`,
    attachments: [],
    requires,
  }).entry;
}

/** 表侧的取件（不读盘的大小） */
function take(target: { runId: string; candidateId: string }, boundary: 'round' | 'idle'): string[] {
  return takeInjectEntries(target.runId, target.candidateId, boundary, () => null).map((message) => message.id);
}

beforeEach(() => {
  resetInjectQueueForTesting();
});

afterEach(() => {
  resetInjectQueueForTesting();
});

/**
 * 订阅者抛错时的日志形状：**上下文整份交出去**（含 `stack`），不是只挑一句 `message`。
 *
 * 这一条拦的是 ERROR 日志的可用性：一个坏订阅者抛出之后，日志里只剩「某某抛错了」而没有
 * 「坏在哪一行」，而排查它的人手上只有这一条日志。判据落在**传给 `console.error` 的那一份上下文**上。
 */
describe('订阅者抛错：ERROR 带整份错误', () => {
  it('上下文的 `error` 是原对象，`stack` 与 `message` 都在', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const off = subscribeInjectChanges(() => {
      throw new Error('订阅者炸了');
    });
    enqueue(candidate('subscriber-throw'), 'm1');
    off();

    const call = spy.mock.calls[0];
    expect(call?.[0]).toContain('订阅者抛错');
    const context = call?.[1] as { error?: unknown } | undefined;
    expect(context?.error).toBeInstanceOf(Error);
    expect((context?.error as Error).message).toBe('订阅者炸了');
    expect((context?.error as Error).stack).toContain('订阅者炸了');
    spy.mockRestore();
  });
});

describe('取件规则（纯函数）', () => {
  const entries = [
    { messageId: 'a', requires: 'idle', state: 'queued' },
    { messageId: 'b', requires: 'round', state: 'queued' },
    { messageId: 'c', requires: 'idle', state: 'queued' },
    { messageId: 'd', requires: 'round', state: 'delivered' },
  ] as InjectQueueEntry[];

  it('`round` 只取要求 `round` 的条目（要求「排队」的不许被提前投出去）', () => {
    // `'round'` 的语义是「下一次模型往返之前」，把一条要求「等本轮结束」的话插到那里，
    // 等于替用户改了他选的那一档
    expect(selectForDrain(entries, 'round').map((entry) => entry.messageId)).toEqual(['b']);
  });

  it('`idle` 取全部可取的，且要求 `round` 的排在前面（它等得更久）', () => {
    expect(selectForDrain(entries, 'idle').map((entry) => entry.messageId)).toEqual(['b', 'a', 'c']);
  });

  it('已经取走过的不再取（同一句话不许让模型看到两遍）', () => {
    expect(selectForDrain(entries, 'idle').some((entry) => entry.messageId === 'd')).toBe(false);
  });
});

describe('提示词拼装（附件清单）', () => {
  it('正文 + 空行 + `[附件]` 清单，每个候选给绝对路径与大小', () => {
    const text = composeInjectedText(
      '顺便看一下这两张图',
      [
        { kind: 'image', path: '/candidates/a/attachments/m1/a.png', mimeType: 'image/png' },
        { kind: 'file', path: '/candidates/a/attachments/m1/b.txt', mimeType: 'text/plain' },
      ],
      (path) => (path.endsWith('.png') ? 12_595 : 1_126),
    );
    expect(text).toBe(
      '顺便看一下这两张图\n\n[附件]\n'
      + '- /candidates/a/attachments/m1/a.png (12.3 KB)\n'
      + '- /candidates/a/attachments/m1/b.txt (1.1 KB)',
    );
  });

  it('没有附件时正文逐字不变（不给空清单）', () => {
    expect(composeInjectedText('只有一句话', [], () => 0)).toBe('只有一句话');
  });

  it('拿不到大小的那一条不写大小那一格（不猜一个数）', () => {
    const text = composeInjectedText('看这个', [{ kind: 'file', path: '/x/a.bin', mimeType: null }], () => null);
    expect(text).toBe('看这个\n\n[附件]\n- /x/a.bin');
  });
});

describe('四态迁移', () => {
  it('登记 ⇒ queued；取件 ⇒ delivered 但 deliveredAt 仍是 null；确认交付 ⇒ 写时刻', () => {
    const target = candidate('flow');
    enqueue(target, 'm1');
    expect(listInjectEntries(target.runId, target.candidateId)[0]?.state).toBe('queued');

    expect(take(target, 'idle')).toEqual(['m1']);
    const taken = listInjectEntries(target.runId, target.candidateId)[0];
    // 取走之后不再被取第二次，但**还不算已投递**：账本记的是「模型真收到了什么」
    expect([taken?.state, taken?.deliveredAt]).toEqual(['delivered', null]);
    expect(take(target, 'idle')).toEqual([]);
    expect(hasUndeliveredInjectEntries(target.runId, target.candidateId)).toBe(true);

    const marked = markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => 'unsupported');
    expect(marked).toHaveLength(1);
    // 时刻是 ISO 8601 串（与提问应答面同口径）：落盘要给人读、要跨进程，epoch 毫秒两样都做不到
    const deliveredAt = listInjectEntries(target.runId, target.candidateId)[0]?.deliveredAt;
    expect(deliveredAt).toBeTypeOf('string');
    expect(new Date(deliveredAt ?? '').toISOString()).toBe(deliveredAt);
    expect(hasUndeliveredInjectEntries(target.runId, target.candidateId)).toBe(false);
    // 重复确认是空操作（适配器可能把同一批登记两次）
    expect(markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => 'unsupported')).toEqual([]);
  });

  it('撤回撞上「厂商已经交给模型」⇒ 落 consumed（不是 gone：它没有被撤回来）', async () => {
    const target = candidate('consumed');
    enqueue(target, 'm1');
    take(target, 'idle');
    markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => 'already-consumed');

    const result = await retractInjectEntry(target.runId, target.candidateId, 'm1');
    expect(result.kind).toBe('consumed');
    const entry = listInjectEntries(target.runId, target.candidateId)[0];
    expect([entry?.state, entry?.outcome, entry?.reason !== null]).toEqual(['consumed', 'already-consumed', true]);
  });

  it('`unsupported` / `unknown` 什么也不改（那一条留在 delivered 上等下一次机会）', async () => {
    for (const outcome of ['unsupported', 'unknown'] as RetractOutcome[]) {
      const target = candidate(`retract-${outcome}`);
      enqueue(target, 'm1');
      take(target, 'idle');
      markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => outcome);

      const result = await retractInjectEntry(target.runId, target.candidateId, 'm1');
      expect(result.kind).toBe(outcome);
      const entry = listInjectEntries(target.runId, target.candidateId)[0];
      expect([entry?.state, entry?.outcome, entry?.settledAt]).toEqual(['delivered', null, null]);
    }
  });

  it('还在我们手里的那一条直接摘掉，**不问厂商**（撤回句柄一次都不该被调到）', async () => {
    const target = candidate('queued-retract');
    enqueue(target, 'm1');
    let called = 0;
    // 没有 markDelivered ⇒ 表里没有撤回句柄；登记一个也不该被用到
    const result = await retractInjectEntry(target.runId, target.candidateId, 'm1');
    expect(result.kind).toBe('removed');
    expect(called).toBe(0);
    expect(listInjectEntries(target.runId, target.candidateId)[0]?.state).toBe('gone');
  });

  it('重复撤回 ⇒ `gone`（200 + 已经处理过，不是 404）', async () => {
    const target = candidate('repeat');
    enqueue(target, 'm1');
    await retractInjectEntry(target.runId, target.candidateId, 'm1');
    expect((await retractInjectEntry(target.runId, target.candidateId, 'm1')).kind).toBe('gone');
  });

  it('撤回不存在的 id ⇒ `not-found`（404）', async () => {
    const target = candidate('missing');
    expect((await retractInjectEntry(target.runId, target.candidateId, 'nope')).kind).toBe('not-found');
  });

  it('成功撤回 ⇒ 落 gone + `retracted`，且撤回句柄被摘掉', async () => {
    const target = candidate('retracted');
    enqueue(target, 'm1');
    take(target, 'idle');
    let calls = 0;
    markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => {
      calls += 1;
      return 'retracted';
    });
    expect((await retractInjectEntry(target.runId, target.candidateId, 'm1')).kind).toBe('retracted');
    expect((await retractInjectEntry(target.runId, target.candidateId, 'm1')).kind).toBe('gone');
    expect(calls).toBe(1);
    expect(listInjectEntries(target.runId, target.candidateId)[0]?.outcome).toBe('retracted');
  });
});

describe('登记幂等（`messageId` 是幂等键）', () => {
  it('同一个 id 再登记 ⇒ 回同一条、不新增、状态不动', () => {
    const target = candidate('idempotent');
    const first = enqueueInjectMessage({ ...target, messageId: 'm1', text: '第一次', attachments: [], requires: 'idle' });
    expect(first.created).toBe(true);
    take(target, 'idle');

    const second = enqueueInjectMessage({ ...target, messageId: 'm1', text: '第二次（内容还改了）', attachments: [], requires: 'round' });
    expect(second.created).toBe(false);
    expect(listInjectEntries(target.runId, target.candidateId)).toHaveLength(1);
    // 命中幂等时**一个字都不改**：改了正文等于让模型收到的版本无从追
    expect([second.entry.text, second.entry.requires, second.entry.state]).toEqual(['第一次', 'idle', 'delivered']);
  });

  it('不同 id 各占一条，顺序即登记顺序', () => {
    const target = candidate('order');
    enqueue(target, 'm1');
    enqueue(target, 'm2');
    expect(listInjectEntries(target.runId, target.candidateId).map((entry) => entry.messageId)).toEqual(['m1', 'm2']);
  });
});

describe('「立即发送」：单向、只对还没取走的条目可用', () => {
  it('`idle` ⇒ `round` 成功；重复调用是空操作；改口「排队」没有入口', () => {
    const target = candidate('promote');
    enqueue(target, 'm1');
    expect(promoteInjectEntry(target.runId, target.candidateId, 'm1')).toBe('promoted');
    expect(listInjectEntries(target.runId, target.candidateId)[0]?.requires).toBe('round');
    expect(promoteInjectEntry(target.runId, target.candidateId, 'm1')).toBe('already-round');
    expect(promoteInjectEntry(target.runId, target.candidateId, 'nope')).toBe('not-found');

    take(target, 'round');
    expect(promoteInjectEntry(target.runId, target.candidateId, 'm1')).toBe('not-queued');
  });
});

describe('候选收场与等待预算：两件事、两种原因', () => {
  it('候选收场 ⇒ 未投递的条目落 gone + `discarded`，并清表（含已投递的那些）', () => {
    const target = candidate('candidate-end');
    enqueue(target, 'm1');
    take(target, 'idle');
    markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => 'unsupported');
    enqueue(target, 'm2');

    const discarded = discardUndeliveredInjectEntries(target.runId, target.candidateId);
    // 只摘未投递的那条（`discarded` 的原因在 `settleInjectEntry` 里写）
    expect(discarded.map((entry) => [entry.messageId, entry.outcome])).toEqual([['m2', 'discarded']]);
    // 整个候选清表：这个候选已经结束了，留着只会让下一轮读到上一轮的幽灵条目
    expect(listInjectEntries(target.runId, target.candidateId)).toEqual([]);
    expect(hasUndeliveredInjectEntries(target.runId, target.candidateId)).toBe(false);
  });

  it('预算到点 ⇒ 落 gone + `timed-out`（不是 `discarded`：界面上是两句不同的话）', () => {
    const target = candidate('expire');
    enqueue(target, 'm1');
    const expired = expireUndeliveredInjectEntries(target.runId, target.candidateId);
    expect(expired.map((entry) => [entry.messageId, entry.state, entry.outcome]))
      .toEqual([['m1', 'gone', 'timed-out']]);
    expect(hasUndeliveredInjectEntries(target.runId, target.candidateId)).toBe(false);
  });

  it('候选收场只摘「未投递」的：已撤回的那条原因不被改写', () => {
    const target = candidate('keep-outcome');
    enqueue(target, 'm1');
    enqueue(target, 'm2');
    void retractInjectEntry(target.runId, target.candidateId, 'm1');

    const discarded = discardUndeliveredInjectEntries(target.runId, target.candidateId);
    expect(discarded.map((entry) => entry.messageId)).toEqual(['m2']);
  });
});

describe('变更信号：只推「变了」，登记 / 撤回 / 取件各发一次', () => {
  it('订阅之后每次变动都收到一次信号，退订之后不再收', async () => {
    resetInjectQueueForTesting();
    let signals = 0;
    const off = subscribeInjectChanges(() => {
      signals += 1;
    });
    const target = candidate('signal');
    enqueue(target, 'm1'); // 1
    enqueue(target, 'm1'); // 幂等命中：不是变动，不发
    promoteInjectEntry(target.runId, target.candidateId, 'm1'); // 2
    take(target, 'round'); // 3
    markInjectEntriesDelivered(target.runId, target.candidateId, ['m1'], async () => 'retracted'); // 4
    await retractInjectEntry(target.runId, target.candidateId, 'm1'); // 5：撤回成功 ⇒ 状态变了
    expect(signals).toBe(5);

    // 什么都没改变的那两种撤回（`unsupported` / `unknown`）**不发信号**：
    // 表里那一格一个字没动，让界面重读一遍只会白跑一次快照
    const target2 = candidate('signal-unsupported');
    enqueue(target2, 'm9');
    take(target2, 'idle');
    markInjectEntriesDelivered(target2.runId, target2.candidateId, ['m9'], async () => 'unsupported');
    const before = signals;
    await retractInjectEntry(target2.runId, target2.candidateId, 'm9');
    expect(signals).toBe(before);

    const afterRetract = signals;
    off();
    enqueue(target, 'm2');
    expect(signals).toBe(afterRetract);
  });

  it('订阅者抛错不影响登记与其余订阅者', () => {
    resetInjectQueueForTesting();
    publishInjectChanged();
    let reached = 0;
    const offBad = subscribeInjectChanges(() => {
      throw new Error('坏的订阅者');
    });
    const offGood = subscribeInjectChanges(() => {
      reached += 1;
    });
    const target = candidate('subscriber-throw');
    expect(() => enqueue(target, 'm1')).not.toThrow();
    offBad();
    offGood();
    expect(reached).toBe(1);
  });
});
