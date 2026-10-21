/**
 * 全局流的客户端出口：一条连接承载三族信号，页面里挂几个消费方都只连一次。
 *
 * 这一层要挡的四种静默死法（都不会让别的用例变红）：
 *   ① 每个消费方各开一条连接 ⇒ 连接数悄悄涨回去（界面完全看不出来，只有 Network 面板能看见）；
 *   ② 帧错投给不关心它的消费方（`inject-messages-changed` 去刷列表）⇒ 白翻一倍请求；
 *   ③ 重连不发通知 ⇒ 断线期间登记的提问永远不出现（帧不重放，只有补读快照这一条路）；
 *   ④ 坏帧打断整条流 ⇒ 从此再也不刷新，且不报任何错。
 *
 * 帧一律用 `feed()`（服务端原始字节）投递：要断言的正是「这一帧在浏览器里够不够被派发」——
 * 全局流的帧是**无名**的，判别键是顶层 `type`；写成具名帧就会让只绑 `onmessage` 的消费方零交付。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalStreamFrame } from './global-stream-hub';
import {
  GLOBAL_STREAM_URL,
  globalStreamOpenCount,
  resetGlobalStreamHubForTesting,
  subscribeGlobalStream,
} from './global-stream-hub';
import { FakeEventSource, installEventSourceStub } from './testing/event-source';

/** 服务端帧的原文（api 的 `toFrame` 逐字同形：无 `event:` 行、无 `id:` 行） */
function frame(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeEach(() => {
  FakeEventSource.reset();
  resetGlobalStreamHubForTesting();
  installEventSourceStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeGlobalStream', () => {
  it('多个订阅者共用一条连接：随全站挂载的浮层不会各开一条；最后一个退订才关流', () => {
    const receivedA: GlobalStreamFrame[] = [];
    const receivedB: GlobalStreamFrame[] = [];
    const offA = subscribeGlobalStream({ onFrame: (f) => receivedA.push(f) });
    const offB = subscribeGlobalStream({ onFrame: (f) => receivedB.push(f) });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe(GLOBAL_STREAM_URL);
    expect(globalStreamOpenCount()).toBe(1);

    // 一个订阅者退订，连接留给另一个（退了就重连等于每次卸载都抖一下）
    offA();
    expect(FakeEventSource.instances[0]?.closeCount).toBe(0);
    FakeEventSource.instances[0]?.feed(frame({ type: 'run-updated', runId: 'run-1' }));
    expect(receivedA).toHaveLength(0);
    expect(receivedB).toHaveLength(1);

    offB();
    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
    expect(globalStreamOpenCount()).toBe(0);
    // 退订幂等：React 的 effect 清理可能跑两遍
    offB();
    expect(FakeEventSource.instances[0]?.closeCount).toBe(1);
  });

  it('三族信号帧原样投给订阅者（解析成信封类型，消费方按 type 自己分流）', () => {
    const received: GlobalStreamFrame[] = [];
    subscribeGlobalStream({ onFrame: (f) => received.push(f) });

    const source = FakeEventSource.instances[0];
    source?.feed(frame({ type: 'run-updated', runId: 'run-1' }));
    source?.feed(frame({ type: 'ask-user-changed' }));
    source?.feed(frame({ type: 'inject-messages-changed' }));

    expect(received).toEqual([
      { type: 'run-updated', runId: 'run-1' },
      { type: 'ask-user-changed' },
      { type: 'inject-messages-changed' },
    ]);
  });

  it('候选级帧与坏帧都不投递（全局流不带候选级帧；一条畸形帧不许打断整条流）', () => {
    const received: GlobalStreamFrame[] = [];
    subscribeGlobalStream({ onFrame: (f) => received.push(f) });

    const source = FakeEventSource.instances[0];
    // 候选级事件帧：形状合法但不属于这条流（聚合流才有它），投出去只会让消费方拿到不相干的归属格
    source?.feed(frame({ seq: 1, at: '2026-09-22T08:01:00.000Z', type: 'status', status: 'running', candidateId: 'w-1', candidateChannel: 'candidate' }));
    // 解不动的 JSON 与判别值不在信封白名单里的帧
    source?.feed('data: 不是 JSON\n\n');
    source?.feed(frame({ type: '没有这种帧' }));
    expect(received).toHaveLength(0);

    // 坏帧之后这条流照旧能用（这正是「坏帧只跳过它自己」的判据）
    source?.feed(frame({ type: 'ask-user-changed' }));
    expect(received).toEqual([{ type: 'ask-user-changed' }]);
  });

  it('重连通知全部订阅者；首次连接不通知（页面自己的首拉刚发过）', () => {
    let reconnectsA = 0;
    let reconnectsB = 0;
    subscribeGlobalStream({ onFrame: () => {}, onReconnect: () => { reconnectsA += 1; } });
    subscribeGlobalStream({ onFrame: () => {}, onReconnect: () => { reconnectsB += 1; } });

    const source = FakeEventSource.instances[0];
    source?.emitOpen(); // 首连
    expect([reconnectsA, reconnectsB]).toEqual([0, 0]);

    source?.emitOpen(); // 浏览器自动重连
    expect([reconnectsA, reconnectsB]).toEqual([1, 1]);
  });

  it('环境没有 EventSource 时静默降级：不抛、不开连接（REST 通路照旧）', () => {
    vi.unstubAllGlobals();

    const off = subscribeGlobalStream({ onFrame: () => {} });

    expect(globalStreamOpenCount()).toBe(0);
    expect(() => off()).not.toThrow();
  });
});
