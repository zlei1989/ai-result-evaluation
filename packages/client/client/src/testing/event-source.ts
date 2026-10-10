/**
 * 测试用的 `EventSource` 替身 + 安装助手。
 *
 * 为什么需要它：jsdom **没有实现 `EventSource`**（已核对 jsdom 25 的
 * `lib/jsdom/living/interfaces.js`：有 `WebSocket`、没有 `EventSource`），
 * 而这里要测的正是「首帧拉 /log → 接 /stream → 去重 → 终态关连接」这条链路。
 *
 * 为什么不放进共享 `src/testing/setup.ts`：`useRowStream` 有一条「环境不支持 EventSource 时
 * 退化为只读历史」的兜底分支，全局注入替身会让那条分支在测试里**永远不可达**
 * （与 `resize-observer.ts` 刻意不共享是同一个理由）。需要的用例自己调用本助手。
 *
 * ## 替身必须**具备浏览器的具名/无名事件语义**
 *
 * SSE 规范：带 `event: <type>` 字段的帧是**具名事件**，只派发给 `addEventListener('<type>')`
 * 注册的监听器；`onmessage` **只收默认事件**。api 的 `toFrame` 发的正是具名事件
 * （`packages/server/api/src/run-stream.ts`），所以：
 *
 * - **旧版替身刻意不实现 `addEventListener`、`emit()` 一律喂 `onmessage`**⇒ 它比真实浏览器
 * **弱**：真实链路一帧都到不了，而 12 条 hook 用例与 24 个变异体全部绿。这不是「写错一行」，
 * 是**替身不忠实**让守卫整体失去区分力。升级后 `emitNamed(type, data)` 只派发给按名字注册的
 * 监听器，`emit(data)` 只派发给 `onmessage` ——用错哪一个都会当场红。
 * - 因此**不具备 `addEventListener` 的替身不得用于验证订阅行为**（①）。
 *
 * 替身只忠实于本仓用到的部分：构造 / `onopen` / `onmessage` / `onerror` / `close` /
 * `addEventListener` / `removeEventListener`（含 `on*` 属性与监听器**去重**、`this` 指向实例、
 * 以及「一个监听器抛错不打断其余监听器」这三条 `EventTarget.dispatchEvent` 的既有语义）。
 */
import { vi } from 'vitest';

/** `addEventListener` / `removeEventListener` 的两种入参：本仓只用函数形态，对象形态原样接受、一并移除 */
type EventListenerLike = (event: never) => void;

/** MessageEvent 的最小形状（jsdom 有 `MessageEvent`，但替身不依赖它） */
export interface FakeMessageEvent {
  readonly type: string;
  readonly data: string;
  /** 与真实 `MessageEvent` 一致：`new EventSource(url)` 之后的 `event.origin` 就是它 */
  readonly origin: string;
}

/** 可观测的 `EventSource` 替身：记录 URL、`close()` 次数，并允许用例手动投递帧 */
export class FakeEventSource {
  /** 本文件内创建过的全部实例（按创建顺序）——断言「重连/换行时旧连接被关掉」靠它 */
  static readonly instances: FakeEventSource[] = [];

  /**
   * 清空实例记录：放在 `beforeEach` 里，让每个用例只看自己创建的实例。
   *
   * 连同**把所有旧实例的监听器摘空**一起做（`readyState = 2`）：React 的 effect cleanup 只保证
   * 「卸载时会调 `stop()`」，而 `@testing-library/react` 的自动 cleanup 在**本仓没有开启**
   * （`src/testing/setup.ts` 没引 `@testing-library/react` 的 cleanup）⇒ 上一个用例 render 出来的
   * hook 可能还挂着监听器，它的 `setError/setEvents` 会**写进一个已经不属于本用例的 React 树**，
   * 本用例却读到那条错误的 error 文案。旧替身因为 `emit()` 只喂 `onmessage` 而掩盖了这件事；
   * 派发变忠实之后它立刻显形（实测：`连接出错` 用例读到上一条用例的「收到无法解析的事件帧」）。
   */
  static reset(): void {
    for (const instance of FakeEventSource.instances) {
      instance.listeners.clear();
      instance.readyState = 2;
    }
    FakeEventSource.instances.length = 0;
  }

  readonly url: string;
  readonly origin: string;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: FakeMessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  /** `close()` 调用次数：终态关流与卸载清理都要能被看见 */
  closeCount = 0;
  /** 按事件名注册的监听器（`Set`：与 `EventTarget` 一致，同一函数注册两次只算一次） */
  private readonly listeners = new Map<string, Set<EventListenerLike>>();

  constructor(url: string) {
    this.url = url;
    this.origin = new URL(url, 'http://localhost').origin;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 2;
  }

  addEventListener(type: string, listener: EventListenerLike | null): void {
    if (listener === null) return;
    const bucket = this.listeners.get(type) ?? new Set<EventListenerLike>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: EventListenerLike | null): void {
    if (listener === null) return;
    this.listeners.get(type)?.delete(listener);
  }

  /** 当前按事件名注册的监听器数量（含 `message`）——断言「停掉连接时把监听器摘干净」用 */
  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.size ?? 0;
    let total = 0;
    for (const bucket of this.listeners.values()) total += bucket.size;
    return total;
  }

  /** 用例驱动：模拟服务端推来一帧**无名**事件（SSE 里没有 `event:` 行的帧） */
  emit(data: string): void {
    this.dispatch('message', { type: 'message', data, origin: this.origin });
  }

  /**
   * 用例驱动：模拟服务端推来一帧**具名**事件（SSE 的 `event: <type>` 行，api 发的就是这种）。
   * 只派发给 `addEventListener(type)` 注册的监听器——这是替换身最该守住的那条浏览器语义。
   *
   * ⚠️ 与真实浏览器一致的另一条语义：`emitNamed('error', data)` 派发的 `MessageEvent` 会**先喂
   * `onerror` 属性**（`dispatch` 先调 `on<type>`）。`onerror` **就是**`error` 的 event handler，
   * 所以服务端发的具名 `error` 帧在真实浏览器里也走 `onerror`——client 正是按这一点用
   * `typeof data === 'string'` 把「服务端帧」与「连接故障（没有 data 的普通 Event）」分开的
   *。
   */
  emitNamed(type: string, data: string): void {
    this.dispatch(type, { type, data, origin: this.origin });
  }

  /** 用例驱动：连接建立 / 断开 */
  emitOpen(): void {
    this.readyState = 1;
    this.dispatch('open', new Event('open'));
  }

  /**
   * 用例驱动：**连接故障**。
   * 刻意派发没有 `data` 的普通 `Event`（不是 `MessageEvent`）：真实浏览器的 `onerror` 在连接
   * 中断时拿到的就是这个形状，而 client 靠「有没有 data」区分它与服务端的具名 `error` 帧。
   */
  emitError(): void {
    this.dispatch('error', new Event('error'));
  }

  /**
   * 与 `EventTarget.dispatchEvent` 同形的派发：先 `on<type>` 属性，再按注册顺序叫监听器；
   * 一个监听器抛错只记日志、不打断其余监听器（浏览器就是这个行为）。
   */
  private dispatch(type: string, event: Event | FakeMessageEvent): void {
    const handler = (this as unknown as Record<string, unknown>)[`on${type}`];
    if (typeof handler === 'function') {
      (handler as (event: Event | FakeMessageEvent) => void).call(this, event);
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        (listener as (event: Event | FakeMessageEvent) => void).call(this, event);
      } catch (error) {
        console.error(`FakeEventSource: '${type}' 监听器抛错（与浏览器一致：不打断其余监听器）`, error);
      }
    }
  }
}

/** 把替身装成全局 `EventSource`（`afterEach` 里用 `vi.unstubAllGlobals()` 解除） */
export function installEventSourceStub(): void {
  vi.stubGlobal('EventSource', FakeEventSource);
}
