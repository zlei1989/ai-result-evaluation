/**
 * cc 的**输入流**：一个可以中途 `push` 的异步可迭代，交给 `sdk.query({ prompt })`。
 *
 * 为什么要有它：字符串题面在厂商侧判定成 `isSingleUserTurn`，首条 `result` 一到就 `endInput()`
 * 关掉 stdin ⇒ 运行中再也塞不进人话。换成流之后 stdin 一直留着，中途 `push` 的那条会进 CLI 自己的
 * 异步消息队列（缺省车道 `'next'`）。
 *
 * ⚠️ **「折进本轮」不是这条流能保证的事**：交出去之后由厂商按**构造请求的时机**决定折入还是另起一轮，
 * 而适配器的两个取件点都在厂商构造之后 ⇒ 真机（CLI 2.1.281）两档都另起一轮。
 * 这条流只保证「交到厂商手里」，不承诺落点（判据见 `docs/protocols/cc.md` 的《注入与续接》）。
 *
 * 三条不变量（消费方与投递方分处两条腿，全靠它们对齐）：
 *   · **先 push 后消费不丢**：`push` 只入队，队列里有东西时 `next()` 立刻兑现（不等唤醒）；
 *   · **`end()` 之后还能把队里剩下的取完**（先兑现队列，再给 `done`）——收流是「不再有新的」，
 *     不是「已经入队的不算数」；
 *   · **每个等待者都会被兑现**：唤醒是**广播**（`push` 与 `end` 各广播一次），
 *     每个挂着的 `next()` 醒来后自己重新看一眼队列。
 *     现实里消费者只有一个（厂商 SDK 那一侧串行 `for await`），但**并发取件不许挂死**：
 *     早先的写法只留一个等待者、后来者直接覆盖它 ⇒ 被覆盖的那个 promise 既不 resolve 也不 reject
 *     永远悬着（「谁赢」还看不出，但没赢的那个是真丢了）。
 */
import type { ClaudeUserMessage } from './sdk';

export interface ClaudeInputStream {
  /** 交给 `sdk.query({ prompt })` 的那一份 */
  readonly stream: AsyncIterable<ClaudeUserMessage>;
  /**
   * 塞一条进流。**收流之后返回 `false` 且不入队**（调用方据此落一条点名的 WARN，
   * 而不是以为投出去了）：那正是「轮次已收场、这一条再也不会被厂商取走」的形状。
   */
  push(message: ClaudeUserMessage): boolean;
  /** 收流：把队里剩下的交给消费方，之后给 `done`（幂等） */
  end(): void;
  /** 收没收到流 */
  readonly ended: boolean;
}

export function createClaudeInputStream(): ClaudeInputStream {
  const queue: ClaudeUserMessage[] = [];
  /** 挂着的等待者集合（现实里至多一个，见文件头第三条：这里是**广播**而不是「留一个」） */
  const waiters = new Set<() => void>();
  let closed = false;

  /** 叫醒所有等待者：各自醒来后重新看一眼队列（有货就给货，没货且收流了就给 `done`） */
  const wakeAll = (): void => {
    for (const wake of [...waiters]) wake();
  };

  /** 一条条兑现：从队头取一条交给 `resolve`；队空且**已收流**时才给 `done` */
  const settle = (resolve: (result: IteratorResult<ClaudeUserMessage>) => void): void => {
    const head = queue.shift();
    if (head !== undefined) {
      resolve({ value: head, done: false });
      return;
    }
    // 「队空」单独不构成 `done`：并发唤醒时别人可能刚把货拿走，**没货且没收流**要重新挂上
    // （否则那条被唤醒的 `next()` 会带着 `done: true` 收场 —— 那等于告诉 SDK「输入流结束了」）
    if (closed) resolve({ value: undefined, done: true });
    else suspend(resolve);
  };

  /** 挂一个等待者上去（唤醒是广播，见 `wakeAll`） */
  const suspend = (resolve: (result: IteratorResult<ClaudeUserMessage>) => void): void => {
    const wake = (): void => {
      waiters.delete(wake);
      settle(resolve);
    };
    waiters.add(wake);
  };

  /** 取一条：队里有就兑现，收流了就 `done`，两样都不是就挂一个等待者上去 */
  const take = (): Promise<IteratorResult<ClaudeUserMessage>> =>
    new Promise((resolve) => settle(resolve));

  return {
    stream: { [Symbol.asyncIterator]: () => ({ next: take }) },
    push(message) {
      if (closed) return false;
      queue.push(message);
      wakeAll();
      return true;
    },
    end() {
      closed = true;
      wakeAll();
    },
    get ended() {
      return closed;
    },
  };
}
