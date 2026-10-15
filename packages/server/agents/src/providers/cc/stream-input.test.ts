// @vitest-environment node
/**
 * cc 的**输入流**：可以中途 `push` 的异步可迭代（streaming input 那一侧）。
 *
 * 三条不变量各对应一种会静默出错的写法：只留一条等待者却写了两条消费路径（挂住）、
 * `end()` 顺手清空队列（已入队的题面/人工消息整条丢失）、收流之后还收 `push`（调用方以为投出去了）。
 */
import { describe, expect, it } from 'vitest';
import { createClaudeInputStream } from './stream-input';

/** 一条最小形状的用户消息（内容即身份，断言好读） */
function message(text: string): { type: 'user'; message: { role: 'user'; content: string }; parent_tool_use_id: null } {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

describe('cc 输入流', () => {
  it('先 push 后消费不丢：队里有货时立刻兑现（顺序即投递顺序）', async () => {
    const feed = createClaudeInputStream();
    const iterator = feed.stream[Symbol.asyncIterator]();
    feed.push(message('第一句'));
    feed.push(message('第二句'));

    await expect(iterator.next()).resolves.toEqual({ value: message('第一句'), done: false });
    await expect(iterator.next()).resolves.toEqual({ value: message('第二句'), done: false });
  });

  it('`end()` 之后**先把队里剩下的取完**再给 `done`（收流是「不再有新的」，不是「已入队的不算数」）', async () => {
    const feed = createClaudeInputStream();
    const iterator = feed.stream[Symbol.asyncIterator]();
    feed.push(message('收流前那一条'));
    feed.end();

    expect(feed.ended).toBe(true);
    await expect(iterator.next()).resolves.toEqual({ value: message('收流前那一条'), done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('挂着的等待者会被 `push` 唤醒；`end()` 唤醒时给 `done`', async () => {
    const feed = createClaudeInputStream();
    const iterator = feed.stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    feed.push(message('唤醒这一条'));
    await expect(pending).resolves.toEqual({ value: message('唤醒这一条'), done: false });

    const halted = iterator.next();
    feed.end();
    await expect(halted).resolves.toEqual({ value: undefined, done: true });
  });

  it('收流之后 `push` 返回 `false` 且不入队（调用方据此落 WARN，而不是以为投出去了）', async () => {
    const feed = createClaudeInputStream();
    feed.end();
    expect(feed.push(message('投晚了'))).toBe(false);
    await expect(feed.stream[Symbol.asyncIterator]().next()).resolves.toEqual({ value: undefined, done: true });
  });

  /**
   * **并发取件不许有「永远不落定」的那个**。
   *
   * 早先的写法只留一个等待者、后来者把它覆盖掉 ⇒ 被覆盖的 promise 既不 resolve 也不 reject
   * （挂死）。现实里消费者只有一个（厂商 SDK 那一侧串行 `for await`），所以这条是防御；
   * 但它是**明确的**形状判据：两个 `next()` 同时在飞时，喂 N 条货就有 N 个落定，
   * 剩下的继续挂着（而不是带着 `done: true` 收场——那等于告诉 SDK「输入流结束了」）。
   */
  it('两个等待者同时在飞：喂两条货，两条都落定；剩下的仍然挂着（不误报 done）', async () => {
    const feed = createClaudeInputStream();
    const iterator = feed.stream[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    feed.push(message('给先醒的'));
    feed.push(message('给后醒的'));

    const settled = await Promise.all([first, second]);
    const values = settled.map((one) => (one.done ? 'DONE' : String((one.value as { message: { content: string } }).message.content)));
    // **按挂起顺序**（Set 的迭代序 = 插入序）：先挂上的那个拿先到的那条
    expect(values).toEqual(['给先醒的', '给后醒的']);
    expect(settled.every((one) => !one.done)).toBe(true);

    // 第三条还没到：这个等待者挂住（既不 done 也不丢），`end()` 之后才收场
    const third = iterator.next();
    const raced = await Promise.race([third, new Promise((resolve) => setTimeout(() => resolve('STILL-WAITING'), 60))]);
    expect(raced).toBe('STILL-WAITING');
    feed.end();
    await expect(third).resolves.toEqual({ value: undefined, done: true });
  });
});
