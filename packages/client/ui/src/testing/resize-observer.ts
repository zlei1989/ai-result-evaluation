/**
 * 测试用的 `ResizeObserver` 替身 + 安装助手。
 *
 * 为什么**必须**打桩：jsdom 不提供 `ResizeObserver`，而 `react-resizable-panels` 在挂载与
 * 尺寸变化时直接 `new window.ResizeObserver(...)` 读**全局构造器**、不带任何 polyfill。
 * 于是任何挂载分栏的用例都会在 effect 里抛 `ReferenceError: ResizeObserver is not defined`
 * ——不是被测代码的问题，是环境缺口。
 *
 * 为什么不放进共享 `src/testing/setup.ts`：`list-detail-layout.tsx` 有一条
 * 「无 `ResizeObserver` 的环境也要把容器初值读一次」的兜底分支，全局注入桩会让那条分支在测试里
 * **永远不可达**（正是「兜底路径被测试环境掩盖」这类问题）。需要的用例自己调用本助手。
 *
 * 断言口径提醒：被测代码每次挂载都会自己 `new ResizeObserver(...)`，所以实例记录按用例累积。
 * 需要「只看本用例创建的实例」时，在用例开头 `FakeResizeObserver.reset()`。
 *
 * **替身与真实实现的差距（读断言前必看）**：它只忠实于构造 / `observe` / `unobserve` / `disconnect`
 * 的**记账**语义——**从不调用**构造时收到的回调，也**从不构造** `ResizeObserverEntry`。因此
 * `entries[].target`、`contentRect` 这类回调参数在测试里恒为死代码，「尺寸变化触发回调」这条路径
 * 在本仓任何用例中都走不到（`list-detail-layout.tsx` 的首帧容器测量是它自己在 effect 里直接读
 * `offsetWidth` 的，不依赖回调）。需要用回调驱动行为的用例**不能**靠本替身，得自己伪造 entry
 * 并手动调用 `callback`。
 */
import { vi } from 'vitest';
import { installMatchMediaStub } from './match-media';

/** 可观测的 `ResizeObserver` 替身：记录被观察元素与 `disconnect` 次数，便于断言观察与清理 */
export class FakeResizeObserver implements ResizeObserver {
  /** 本文件内创建过的全部替身实例（按创建顺序） */
  static readonly instances: FakeResizeObserver[] = [];

  /** 清空实例记录：放在 `beforeEach` 里，让每个用例只看自己创建的实例 */
  static reset(): void {
    FakeResizeObserver.instances.length = 0;
  }

  /** 构造时收到的回调（`react-resizable-panels` 会传） */
  readonly callback: ResizeObserverCallback;

  /** 被 `observe` 的目标，按调用顺序 */
  readonly observed: Element[] = [];

  /** `disconnect` 调用次数：用来断言卸载时观察器真的被断开（否则是泄漏） */
  disconnectCount = 0;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  /** 本仓没有调用点，留空实现以满足接口 */
  unobserve(): void {}

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

/**
 * 把替身装成全局 `ResizeObserver`，**顺带**补上 jsdom 的另一个缺口 `matchMedia`
 * （见 `./match-media.ts`）。
 *
 * 为什么两件事合在一个入口：挂载分栏（`react-resizable-panels`）与主题解析经常出现在
 * 同一个用例里，两个 api 的缺口成因、口径完全一致（jsdom 没实现 + 不进共享 setup）。
 * 分两个入口只会让每个用例都漏装一个 —— 那正是本入口被合并的原因。
 *
 * 反复调用只会重设全局（`afterEach` 里用 `vi.unstubAllGlobals()` 解除）。
 */
export function installResizeObserverStub(): void {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  installMatchMediaStub();
}
