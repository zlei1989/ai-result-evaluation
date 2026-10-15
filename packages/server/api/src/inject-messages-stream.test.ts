// @vitest-environment node
/**
 * 人工消息队列的信号式 SSE 产出：队列变更 → `inject-messages-changed` 帧。
 *
 * 帧格式与生命周期是本文件最硬的断言对象（与待答清单那条信号流的同款用例同源）：
 *   - **帧里没有内容**：`event:` 行 + 一行空的 `data:`。这一帧的全部意思就是「变了，去重读快照」，
 *     没有 `id:` 行（信号不可续订），也不载快照（队列里有正文与附件路径，多发一份就是第二份真相）；
 *   - **那一行空的 `data:` 不能省**：没有 `data` 字段的块在浏览器里不派发任何事件
 *     （规范：「data buffer 是空串就返回」）——省掉它，界面上「发了消息但排队区不刷新」；
 *   - **不因终态关流**（与行级事件流相反）：这条流长存，由客户端取消收尾；
 *   - **打开即有首字节**（ready 注释帧）：响应头等第一次 enqueue 才 flush。
 *
 * `subscribeInjectChanges` 由本文件自己 mock（工厂里维护一张监听表）：
 * 「总线推一条信号 → 流里出现一帧」这条链路不需要真队列表。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamInjectMessages } from './inject-messages-stream';

/** 本文件挂上去的总线监听 */
const listeners = new Set<() => void>();

vi.mock('@aieval/evaluator', async (importOriginal) => ({
  // 其余名字原样透传：`@aieval/api` 的 index 会把 evaluator 的一整套名字转出去，
  // 手写键清单漏一个就在 import 阶段炸，而漏的那些与本文件无关
  ...(await importOriginal<typeof import('@aieval/evaluator')>()),
  subscribeInjectChanges: vi.fn((listener: () => void) => {
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

/** 总线侧推一条信号（模拟「登记 / 取件 / 交付 / 撤回 / 丢弃」） */
function publish(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * 按 SSE 规范把一段流解析成**浏览器会派发的事件**（只实现本仓用到的 `event` / `data` 两个字段）。
 *
 * 判据与规范逐字对齐：空行结束一块并触发派发；派发前先看 data buffer，**空串就整块丢掉**。
 * 这一条正是「帧里那行空的 `data:` 不能省」的全部理由，故它必须参与断言，而不是只断言字符串字面量。
 */
function dispatched(text: string): { type: string; data: string }[] {
  const events: { type: string; data: string }[] = [];
  let data = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line === '') {
      // 派发：data buffer 非空才有事件；载荷去掉末尾那一个换行（收一行 `data:` 补一个）
      if (data !== '') events.push({ type: type === '' ? 'message' : type, data: data.endsWith('\n') ? data.slice(0, -1) : data });
      data = '';
      type = '';
      continue;
    }
    if (line.startsWith(':')) continue; // 注释帧
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data += `${value}\n`;
    else if (field === 'event') type = value;
  }
  return events;
}

describe('streamInjectMessages', () => {
  it('先发 ready 注释帧；信号成帧 event: inject-messages-changed + 空 data:，没有 id: 行', async () => {
    const stream = streamInjectMessages();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // 打开即有首字节（不等到 15s 心跳才 flush）
    expect(decoder.decode((await reader.read()).value)).toBe(': ready\n\n');

    publish();
    const frame = decoder.decode((await reader.read()).value);
    // 逐字钉帧：多给 data: 内容就是把快照塞进了帧（第二份真相），删掉 event: 行会让具名订阅零交付，
    // 而**删掉 data: 行本身**会让整帧不派发（见下一条用例）
    expect(frame).toBe('event: inject-messages-changed\ndata:\n\n');
    expect(frame).not.toContain('id:');

    await reader.cancel();
  });

  it('多条信号各成一帧（合并在客户端做，服务侧不丢也不并）', async () => {
    const stream = streamInjectMessages();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 摘掉 ready 帧

    publish();
    publish();
    expect(decoder.decode((await reader.read()).value)).toBe('event: inject-messages-changed\ndata:\n\n');
    expect(decoder.decode((await reader.read()).value)).toBe('event: inject-messages-changed\ndata:\n\n');

    // 两帧之后流仍然活着（队列没有「自然关闭」这一档）
    publish();
    expect(decoder.decode((await reader.read()).value)).toBe('event: inject-messages-changed\ndata:\n\n');

    await reader.cancel();
  });

  it('帧在浏览器里必须可派发：空 data: 行是载重的（省掉它整帧不派发，订阅端零交付）', async () => {
    const stream = streamInjectMessages();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const ready = decoder.decode((await reader.read()).value);
    // 注释帧不产生事件（先钉住解析器本身是忠实的，免得它对什么都「派发」）
    expect(dispatched(ready)).toEqual([]);

    publish();
    const frame = decoder.decode((await reader.read()).value);

    // 场景：队列变了 → 浏览器必须真的叫醒订阅端一次，载荷为空串
    expect(dispatched(frame)).toEqual([{ type: 'inject-messages-changed', data: '' }]);

    await reader.cancel();
  });

  it('客户端取消后退订总线并清心跳定时器（长驻服务里不许往没人读的流里塞）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const stream = streamInjectMessages();
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
    const stream = streamInjectMessages();
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // 摘掉 ready 帧

    vi.advanceTimersByTime(15_000);
    expect(decoder.decode((await reader.read()).value)).toBe(': keep-alive\n\n');

    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
