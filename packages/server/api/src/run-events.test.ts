// @vitest-environment node
/**
 * 全局流的 SSE 产出（`GET /api/runs/stream`）：**三条全局总线**（run 信号 / 待答挂起表 /
 * 人工消息队列）扇出成一条连接上的三类信号帧。帧格式与生命周期是本文件最硬的断言对象：
 *   - **没有 `id:` 行**：信号没有 seq、不可续订，断线重连从「当下」开始、历史由 REST 快照兜着；
 *     多发一个 id 反而会让浏览器误以为这条流可续订；
 *   - **没有 `event:` 行**：判别键是信封顶层的 `type`（与聚合流同一口径），
 *     再用 SSE 的具名事件表达一遍就是第二份会漂移的真相，而客户端只绑 `onmessage`；
 *   - **不因终态关流**（与候选级流相反）：这条流是页面级的，由客户端取消收尾；
 *   - **打开即有首字节**（ready 注释帧）：响应头等第一次 enqueue 才 flush。
 *
 * 三条总线由本文件自己 mock：工厂里各维护一张监听表，「总线推一条 → 流里出一帧」这条链路
 * 不需要任何编排，也不需要真表（真表挂 `globalThis`，跨用例存活会让断言随执行顺序变化）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamGlobalSignals } from './run-events';

/** 三条总线的监听表（与真实总线同构：订阅加进来、退订摘掉） */
const bus = {
  run: new Set<(runId: string) => void>(),
  askUser: new Set<() => void>(),
  inject: new Set<() => void>(),
};

vi.mock('@aieval/evaluator', () => ({
  subscribeRunChanges: vi.fn((listener: (runId: string) => void) => {
    bus.run.add(listener);
    return () => {
      bus.run.delete(listener);
    };
  }),
  subscribeAskUserChanges: vi.fn((listener: () => void) => {
    bus.askUser.add(listener);
    return () => {
      bus.askUser.delete(listener);
    };
  }),
  subscribeInjectChanges: vi.fn((listener: () => void) => {
    bus.inject.add(listener);
    return () => {
      bus.inject.delete(listener);
    };
  }),
}));

beforeEach(() => {
  bus.run.clear();
  bus.askUser.clear();
  bus.inject.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 总线侧推一条信号（模拟 `saveRun` 落盘 / 挂起表变更 / 队列变更） */
function publishRun(runId: string): void {
  for (const listener of [...bus.run]) listener(runId);
}
function publishAskUser(): void {
  for (const listener of [...bus.askUser]) listener();
}
function publishInject(): void {
  for (const listener of [...bus.inject]) listener();
}

describe('streamGlobalSignals', () => {
  it('先发 ready 注释帧；三条总线各成一条信号帧，且既没有 id: 行也没有 event: 行', async () => {
    const stream = streamGlobalSignals();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 打开即有首字节（不等到 15s 心跳才 flush）
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');

    publishRun('run-1');
    const runFrame = decoder.decode((await reader.read()).value);
    // 逐字钉帧：id: 行在这里出现就是「假装可续订」；event: 候选会让客户端（只绑 onmessage）零交付
    expect(runFrame).toBe('data: {"type":"run-updated","runId":"run-1"}\n\n');
    expect(runFrame).not.toContain('id:');
    expect(runFrame).not.toContain('event:');

    publishAskUser();
    const askFrame = decoder.decode((await reader.read()).value);
    // 两个信号**没有载荷**：发布侧（`publishAskUserChanged` / `publishInjectChanged`）本来就不带定位
    expect(askFrame).toBe('data: {"type":"ask-user-changed"}\n\n');
    expect(askFrame).not.toContain('event:');

    publishInject();
    expect(decoder.decode((await reader.read()).value)).toBe('data: {"type":"inject-messages-changed"}\n\n');

    await reader.cancel();
    // 三条总线一个不落全退订
    expect([bus.run.size, bus.askUser.size, bus.inject.size]).toEqual([0, 0, 0]);
  });

  it('多条信号各成一帧（合并在客户端做，服务侧不丢也不并），且不因任何一条终态关流', async () => {
    const stream = streamGlobalSignals();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 摘掉 ready 帧

    publishRun('run-a');
    publishRun('run-b');
    expect(decoder.decode((await reader.read()).value)).toContain('"runId":"run-a"');
    expect(decoder.decode((await reader.read()).value)).toContain('"runId":"run-b"');

    // 三条之后流仍然活着（页面级长连接，关流只有客户端取消一种）
    publishAskUser();
    expect(decoder.decode((await reader.read()).value)).toContain('"type":"ask-user-changed"');

    await reader.cancel();
  });

  it('客户端取消后退订三条总线并清心跳定时器（长驻服务里不许往没人读的流里塞）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const stream = streamGlobalSignals();
    const reader = stream.getReader();
    await reader.read();
    expect([bus.run.size, bus.askUser.size, bus.inject.size]).toEqual([1, 1, 1]);
    expect(vi.getTimerCount()).toBe(1); // 心跳定时器挂着（15s 一条 keep-alive）

    await reader.cancel();

    expect([bus.run.size, bus.askUser.size, bus.inject.size]).toEqual([0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('静默期每 15 秒发一条 keep-alive 注释帧（反向代理与浏览器都会掐静默连接）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const stream = streamGlobalSignals();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 摘掉 ready 帧

    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await reader.read()).value)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
