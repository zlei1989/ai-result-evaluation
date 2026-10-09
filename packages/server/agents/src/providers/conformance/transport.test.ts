// @vitest-environment node
/**
 * C 类（协议时序）判据的自测：**每条判据都要见过失败**。
 *
 * 三条真故障形态各有一条反例：订阅前推送丢失、终态早于响应、重复/凭空投递。
 */
import { describe, expect, it } from 'vitest';
import { checkTransportDelivery, type TransportTranscript } from './transport';

function transcript(overrides: Partial<TransportTranscript> = {}): TransportTranscript {
  return {
    steps: [
      { kind: 'subscribe' },
      { kind: 'push', id: 'n1' },
      { kind: 'response' },
      { kind: 'push', id: 'n2' },
      { kind: 'terminal', id: 'n3' },
    ],
    observed: ['n1', 'n2', 'n3'],
    ...overrides,
  };
}

describe('时序判据：正例', () => {
  it('常规序列（订阅后推送、终态在响应之后）⇒ 过', () => {
    expect(() => checkTransportDelivery(transcript())).not.toThrow();
  });

  it('订阅前推送但被缓冲补投 ⇒ 过（这正是夹具保真要表达的那一态）', () => {
    expect(() =>
      checkTransportDelivery(
        transcript({
          steps: [
            { kind: 'push', id: 'early' },
            { kind: 'subscribe' },
            { kind: 'response' },
            { kind: 'terminal', id: 'done' },
          ],
          observed: ['early', 'done'],
        }),
      ),
    ).not.toThrow();
  });

  it('没有订阅事件（消息级笔迹）⇒ 跳过「缓冲」那一条，其余照判', () => {
    expect(() =>
      checkTransportDelivery(transcript({ steps: [{ kind: 'push', id: 'n1' }, { kind: 'response' }], observed: ['n1'] })),
    ).not.toThrow();
  });
});

describe('时序判据：每条都能拦（反例）', () => {
  it('订阅前推送的通知丢了（没缓冲）⇒ 红', () => {
    expect(() =>
      checkTransportDelivery(
        transcript({
          steps: [{ kind: 'push', id: 'early' }, { kind: 'subscribe' }, { kind: 'response' }],
          observed: [],
        }),
      ),
    ).toThrow(/没被消费方收到/);
  });

  it('终态早于请求响应 ⇒ 红（收尾会看到半截状态）', () => {
    expect(() =>
      checkTransportDelivery(
        transcript({
          steps: [
            { kind: 'subscribe' },
            { kind: 'terminal', id: 'done' },
            { kind: 'response' },
          ],
          observed: ['done'],
        }),
      ),
    ).toThrow(/早于请求响应/);
  });

  it('同一条通知投递两次（补投与直投都来）⇒ 红', () => {
    expect(() => checkTransportDelivery(transcript({ observed: ['n1', 'n1', 'n2', 'n3'] }))).toThrow(/被投递了两次/);
  });

  it('消费方收到了厂商从未推送的条目 ⇒ 红', () => {
    expect(() => checkTransportDelivery(transcript({ observed: ['n1', 'n2', 'n3', 'ghost'] }))).toThrow(/从未推送过它/);
  });
});
