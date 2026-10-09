/**
 * `FakeEventSource` 自己的语义：它**必须像浏览器**，否则用它的守卫全是空转。
 *
 * 为什么单独给替身写用例（p5 阶段评审 C1 的直接教训）：旧版替身刻意不实现 `addEventListener`、
 * `emit()` 一律喂 `onmessage` ⇒ 它比浏览器**弱**：真实链路一帧都到不了，而 12 条 hook 用例
 * 与 24 个变异体全部绿。把「替身是否忠实」本身钉成断言，才不会再有下一次。
 *
 * 四条浏览器语义（SSE 规范 + `EventTarget`）：
 *   1. 无名帧（SSE 里没有 `event:` 行）→ `onmessage` 与 `addEventListener('message')` 都收到；
 *   2. **具名帧 → 只有 `addEventListener('<type>')` 收到，`onmessage` 收不到**；
 *   3. 按名字摘掉之后不再派发（`stop()` 靠它）；
 *   4. `on<type>` 属性与监听器是两条独立路径，互不抑制。
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_EVENT_TYPES } from '@aieval/contracts';
import { FakeEventSource } from './event-source';

function make(): FakeEventSource {
  return new FakeEventSource('/api/runs/run-1/rows/w-1/stream?afterSeq=0');
}

describe('FakeEventSource（测试替身本身的浏览器语义）', () => {
  it('无名帧：onmessage 与 addEventListener("message") 都收到，且 data/origin 与真实 MessageEvent 同形', () => {
    const source = make();
    const onmessage = vi.fn();
    const byName = vi.fn();
    source.onmessage = onmessage;
    source.addEventListener('message', byName);

    source.emit('{"seq":1}');

    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(byName).toHaveBeenCalledTimes(1);
    // data 是 SSE 的 data 行内容（字符串）；origin 来自构造时的 URL——hook 读的就是这两项
    expect(onmessage.mock.calls[0]?.[0]).toMatchObject({ data: '{"seq":1}', origin: 'http://localhost' });
  });

  it('**具名帧只派发给 addEventListener(名字)**——onmessage 一条都收不到', () => {
    const source = make();
    const onmessage = vi.fn();
    const onStatus = vi.fn();
    source.onmessage = onmessage;
    source.addEventListener('status', onStatus);

    source.emitNamed('status', '{"seq":2}');

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onmessage).not.toHaveBeenCalled();
  });

  it('八种事件类型各自独立：按名字派发不会串到别的类型上', () => {
    const source = make();
    const seen = new Map<string, ReturnType<typeof vi.fn>>();
    for (const type of AGENT_EVENT_TYPES) {
      const listener = vi.fn();
      seen.set(type, listener);
      source.addEventListener(type, listener);
    }

    source.emitNamed('usage', '{}');

    expect(seen.get('usage')).toHaveBeenCalledTimes(1);
    for (const type of AGENT_EVENT_TYPES) {
      if (type !== 'usage') expect(seen.get(type), `'${type}' 不该被 usage 帧触发`).not.toHaveBeenCalled();
    }
  });

  it('removeEventListener 之后不再派发（stop() 摘监听器靠它）；on* 属性与监听器互不抑制', () => {
    const source = make();
    const listener = vi.fn();
    const onmessage = vi.fn();
    source.addEventListener('log', listener);
    source.onmessage = onmessage;

    source.emitNamed('log', '{"seq":1}');
    expect(listener).toHaveBeenCalledTimes(1);
    // 具名帧不喂 onmessage（浏览器语义），哪怕同时挂了属性回调
    expect(onmessage).not.toHaveBeenCalled();

    source.removeEventListener('log', listener);
    source.emitNamed('log', '{"seq":2}');
    expect(listener).toHaveBeenCalledTimes(1);

    // 无名帧走 onmessage；此时已无具名监听器，它不该被调用
    source.emit('{"seq":3}');
    expect(onmessage).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('同一个监听器注册两次只叫一次（Set 语义），listenerCount 如实反映', () => {
    const source = make();
    const listener = vi.fn();

    source.addEventListener('end', listener);
    source.addEventListener('end', listener);
    expect(source.listenerCount('end')).toBe(1);

    source.emitNamed('end', '{}');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
