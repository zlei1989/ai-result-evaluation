// @vitest-environment node
/**
 * run 级 SSE 产出：订阅 run 信号总线 → `run-updated` 帧。
 * 帧格式与生命周期是本文件最硬的断言对象：
 *   - **没有 `id:` 行**（与行级流不同）：信号没有 seq、不可续订（run-signals.ts 的口径 3），
 *     断线重连从「当下」开始，历史由 REST 快照兜着——多发一个 id 反而会让浏览器
 *     误以为这条流可续订；
 *   - **不因终态关流**（与行级流相反）：这条流跨轮次长存，由客户端取消收尾；
 *   - **打开即有首字节**（ready 注释帧）：与行级流同一条理由——响应头等第一次 enqueue 才 flush。
 *
 * `subscribeRunChanges` 由本文件自己 mock（工厂里维护一张监听表），
 * 「总线推一条信号 → 流里出现一帧」这条链路不需要任何编排。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamRunSignals } from './run-events';

/** 本文件挂上去的总线监听 */
const listeners = new Set<(runId: string) => void>();

vi.mock('@aieval/evaluator', () => ({
  subscribeRunChanges: vi.fn((listener: (runId: string) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }),
}));

beforeEach(() => {
  listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 总线侧推一条信号（模拟「saveRun 落盘成功」） */
function publish(runId: string): void {
  for (const listener of [...listeners]) listener(runId);
}

describe('streamRunSignals', () => {
  it('先发 ready 注释帧；信号成帧 event: run-updated + data:{runId}，且没有 id: 行', async () => {
    const stream = streamRunSignals();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 打开即有首字节（不等到 15s 心跳才 flush）
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');

    publish('run-1');
    const frame = decoder.decode((await reader.read()).value);
    // 逐字钉帧：id: 行在这里出现就是「假装可续订」，删掉 event: 行会让具名订阅零交付
    expect(frame).toBe('event: run-updated\ndata: {"runId":"run-1"}\n\n');
    expect(frame).not.toContain('id:');

    await reader.cancel();
  });

  it('多条信号各成一帧（合并在客户端做，服务侧不丢也不并）', async () => {
    const stream = streamRunSignals();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 摘掉 ready 帧

    publish('run-a');
    publish('run-b');
    expect(decoder.decode((await reader.read()).value)).toContain('"runId":"run-a"');
    expect(decoder.decode((await reader.read()).value)).toContain('"runId":"run-b"');

    // 两条之后流仍然活着（不因「跑完」关流——这条流长存到客户端取消）
    publish('run-c');
    expect(decoder.decode((await reader.read()).value)).toContain('"runId":"run-c"');

    await reader.cancel();
  });

  it('客户端取消后退订总线并清心跳定时器（长驻服务里不许往没人读的流里塞）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const stream = streamRunSignals();
    const reader = stream.getReader();
    await reader.read();
    expect(listeners.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // 心跳定时器挂着（15s 一条 keep-alive）

    await reader.cancel();

    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('静默期每 15 秒发一条 keep-alive 注释帧（反向代理与浏览器都会掐静默连接）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const stream = streamRunSignals();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 摘掉 ready 帧

    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await reader.read()).value)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
