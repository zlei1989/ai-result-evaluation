// @vitest-environment node
/**
 * 待答队列的推进规则：先来后到、收到确认才出队、关掉不算答，以及迟到快照不许复活已收场的提问。
 *
 * 这一组是**纯函数**用例：不挂 hook、不碰 fetch，断言的是「状态怎么变」这件事本身。
 * 传输那一半（信号驱动重读、POST 的成败）在 `ask-user.test.tsx`，两处刻意分开——
 * 队列规则若只能靠渲染结果观察，改错一处就得靠猜是哪一层的问题。
 */
import { describe, expect, it } from 'vitest';
import type { PendingAskUser } from '@aieval/contracts';
import {
  EMPTY_ASK_USER_QUEUE,
  answerableAskUser,
  applyAskUserSnapshot,
  confirmAskUserAnswered,
  currentAskUser,
  dismissAskUser,
  reopenAskUser,
  type AskUserQueueState,
} from './ask-user-queue';

/** 一条待答提问：只有 `askId` 参与队列规则，其余字段填成合法形状即可 */
function pending(askId: string, askedAt = '2026-10-13T10:00:00.000Z'): PendingAskUser {
  return {
    askId,
    runId: 'run-1',
    rowId: 'w-1',
    stage: 'agent',
    questions: [{ header: askId, prompt: '这次改哪条路径？', options: [], multiSelect: false, allowOther: true, secret: false }],
    askedAt,
  };
}

/** 另一轮的提问：焦点过滤的判据是每一条自己的 `runId` */
function pendingIn(runId: string, askId: string): PendingAskUser {
  return { ...pending(askId), runId };
}

/** 一份快照落到空队列上 */
function withSnapshot(...askIds: string[]): AskUserQueueState {
  return applyAskUserSnapshot(EMPTY_ASK_USER_QUEUE, askIds.map((askId) => pending(askId)));
}

describe('先来后到', () => {
  it('队首是快照里的第一条，答完第一条才轮到第二条', () => {
    const state = withSnapshot('a', 'b');

    expect(currentAskUser(state)?.askId).toBe('a');
    expect(currentAskUser(confirmAskUserAnswered(state, 'a'))?.askId).toBe('b');
  });

  it('顺序是**服务端的顺序**，不是本地看到的先后（两次登记的间隙里读过一次快照也不会错位）', () => {
    // 先只看到 b（b 已登记、a 还没登记），随后一次重读拿到 [a, b]：先问的 a 仍排在队首
    const seenB = withSnapshot('b');
    const both = applyAskUserSnapshot(seenB, [pending('a'), pending('b')]);

    expect(both.pending.map((item) => item.askId)).toEqual(['a', 'b']);
    expect(currentAskUser(both)?.askId).toBe('a');
  });
});

describe('出队只在确认之后', () => {
  it('重读同一份快照不改变队列（没有确认就一条都不出队）', () => {
    const state = withSnapshot('a', 'b');
    const again = applyAskUserSnapshot(state, [pending('a'), pending('b')]);

    expect(again.pending.map((item) => item.askId)).toEqual(['a', 'b']);
  });

  it('走一次确认才出队，且它是幂等的（同一 askId 确认两次结果一样）', () => {
    const once = confirmAskUserAnswered(withSnapshot('a', 'b'), 'a');
    const twice = confirmAskUserAnswered(once, 'a');

    expect(once.pending.map((item) => item.askId)).toEqual(['b']);
    expect(twice.pending.map((item) => item.askId)).toEqual(['b']);
    expect(twice.settled).toEqual(['a']);
  });

  it('迟到的快照不把已确认的那一问塞回队列（应答 POST 与重读并发时的真实时序）', () => {
    const answered = confirmAskUserAnswered(withSnapshot('a', 'b'), 'a');
    // 这份快照是应答之前算出来的：里面还列着 a
    const late = applyAskUserSnapshot(answered, [pending('a'), pending('b')]);

    expect(late.pending.map((item) => item.askId)).toEqual(['b']);
  });

  it('快照里消失的提问直接出队，之后的快照也复活不了它（别处答了 / 取消 / 超时）', () => {
    const gone = applyAskUserSnapshot(withSnapshot('a', 'b'), [pending('b')]);
    expect(gone.pending.map((item) => item.askId)).toEqual(['b']);

    const late = applyAskUserSnapshot(gone, [pending('a'), pending('b')]);
    expect(late.pending.map((item) => item.askId)).toEqual(['b']);
  });
});

describe('关掉不是回答', () => {
  it('关掉只改记号：队列一条不少，队首仍是它', () => {
    const state = dismissAskUser(withSnapshot('a', 'b'), 'a');

    expect(state.pending.map((item) => item.askId)).toEqual(['a', 'b']);
    // 只是「不再自动弹」，不是「这条不算」：关掉之后它仍排在队首
    expect(currentAskUser(state)).toBeNull();
    expect(state.pending[0]?.askId).toBe('a');
  });

  it('重新打开回到同一问（关掉期间队列没动过）', () => {
    const reopened = reopenAskUser(dismissAskUser(withSnapshot('a', 'b'), 'a'));

    expect(currentAskUser(reopened)?.askId).toBe('a');
  });

  it('被关掉的那一问从快照里消失时记号一并清掉，否则它会把下一问挡在门外', () => {
    const dismissed = dismissAskUser(withSnapshot('a', 'b'), 'a');
    const aGone = applyAskUserSnapshot(dismissed, [pending('b')]);

    expect(aGone.dismissedAskId).toBeNull();
    expect(currentAskUser(aGone)?.askId).toBe('b');
  });

  it('关掉的那一问被本地确认之后记号也清掉', () => {
    const confirmed = confirmAskUserAnswered(dismissAskUser(withSnapshot('a', 'b'), 'a'), 'a');

    expect(confirmed.dismissedAskId).toBeNull();
    expect(currentAskUser(confirmed)?.askId).toBe('b');
  });
});

describe('焦点过滤（暂缓）', () => {
  /** 三条提问分属两轮，且**交错**排队（run-1 的 a、run-2 的 c、run-1 的 b） */
  function twoRuns(): AskUserQueueState {
    return applyAskUserSnapshot(EMPTY_ASK_USER_QUEUE, [pending('a'), pendingIn('run-2', 'c'), pending('b')]);
  }

  it('焦点是某一轮时只弹该轮的提问：别的轮次的连队首都当不上', () => {
    const state = twoRuns();

    expect(currentAskUser(state, 'run-2')?.askId).toBe('c');
    // 队列本体一条不少（暂缓不是取消，也不是出队）
    expect(state.pending.map((item) => item.askId)).toEqual(['a', 'c', 'b']);
  });

  it('焦点为 null（没在看某一轮）时全部可弹：暂缓不是丢弃', () => {
    const state = twoRuns();

    expect(currentAskUser(state, null)?.askId).toBe('a');
    // 缺省与显式 null 同义：老调用方（不关心焦点）的语义一个字不改
    expect(currentAskUser(state)?.askId).toBe('a');
    expect(answerableAskUser(state, null)).toHaveLength(3);
  });

  it('焦点轮没有待答提问时 current 是 null，其余轮的仍留在队列里', () => {
    const state = twoRuns();

    expect(currentAskUser(state, 'run-没有这一轮')).toBeNull();
    expect(answerableAskUser(state, 'run-没有这一轮')).toHaveLength(0);
    expect(state.pending).toHaveLength(3);
  });

  it('关掉的记号只作用于有资格弹的那一份：别的轮的暂缓提问不许顶上来', () => {
    const state = dismissAskUser(twoRuns(), 'c');

    // 焦点在 run-2：被关掉的 c 仍是它的队首 ⇒ 不弹（回到「关掉」的既有语义）
    expect(currentAskUser(state, 'run-2')).toBeNull();
    expect(answerableAskUser(state, 'run-2')).toHaveLength(1);
    // 焦点放开：别的轮的提问照旧弹，不被 run-2 那个记号挡住
    expect(currentAskUser(state, null)?.askId).toBe('a');
  });
});
