/**
 * 组件测试的共享 setup：注册 jest-dom 断言、每个用例后清理 DOM、修补 jsdom 环境自身的缺口。
 * 注意：本文件不注入 matchMedia 桩——主题模块自带「无 matchMedia 时按暗色」的兜底，
 * 测试要覆盖的正是那条兜底路径。需要模拟系统偏好的用例自己注入桩。
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * 把 Node ≥22 **顶掉**的 `localStorage` 装回 jsdom 的实现（Node v26.7.0 + vitest 4.1.11）。
 *
 * 机制：Node 22 起自带一个实验性的 `localStorage` 全局，不带 `--localstorage-file` 启动时它是个
 * **取值即 `undefined`** 的访问器（还会打一条 `ExperimentalWarning`）；而 vitest 的 `populateGlobal`
 * 搬运 window 自有属性时有一条「global 上已经有同名键就不搬」的规则
 * （`getWindowKeys`：`if (k in global) return keysArray.includes(k)`），且 `localStorage` /
 * `sessionStorage` 都不在它硬编码的 KEYS 清单里 ⇒ jsdom 那一格被 Node 的顶掉。
 * `sessionStorage` 不受影响（Node 没有同名全局），差别只在 `localStorage` 这一格。
 *
 * 症状不是「测不到」而是**成片假红**：凡读写 localStorage 的用例全部挂在
 * `Cannot read properties of undefined (reading 'getItem')`（本包 `stored-preference.test.tsx`
 * 12 条、`list-detail-layout.test.tsx` 2 条），且都与被测代码无关。
 *
 * 为什么从 `_globalProxy` 取（jsdom 的内部字段）：`populateGlobal` 把 `window` 指成了 global 自己
 * （`global.window = global`），真正的 jsdom Window 实例只剩这一条路摸得到；透过它读 `localStorage`
 * 走的是 Window 自己的取值器，拿到的是**jsdom 的 Storage 实例**——方法都在 `Storage.prototype` 上，
 * 而用例 `vi.spyOn(Storage.prototype, 'getItem')`（隐私模式 / 配额两条路径）依赖的正是这一点。
 * 所以**不能**自己造一个假的 Storage 顶上：那两条用例会静默失去覆盖（它们仍会绿，但绿得没有理由）。
 *
 * 只在「真的被顶掉」时动手：Node 20 及更早没有那个全局，jsdom 的实现本来就在（此时本函数是空操作），
 * 用例自己 `vi.stubGlobal('window', …)` 的桩也不会被这里覆盖。
 */
function restoreJsdomLocalStorage(): void {
  /** `_globalProxy` 是 jsdom Window 的内部字段，本仓的 `@types/node` 不声明它 */
  const jsdomWindow = (globalThis as unknown as { _globalProxy?: { localStorage?: Storage } })._globalProxy;
  if (jsdomWindow === undefined || globalThis.localStorage !== undefined) return;
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => jsdomWindow.localStorage,
    configurable: true,
  });
}

restoreJsdomLocalStorage();

/**
 * 用 `MouseEvent` 顶上 jsdom 缺的 `PointerEvent`。
 *
 * 缺口：jsdom 只实现到 `MouseEvent`，`window.PointerEvent` 是 `undefined`；而 Base UI 的
 * Radio / Checkbox 在点击时会用 `new ownerWindow(el).PointerEvent('click', …)` **重新派发**一次
 * 带修饰键的 click（`dispatchClickWithModifiers`），于是 `fireEvent.click` 直接抛
 * `TypeError: ownerWindow(...).PointerEvent is not a constructor`。
 *
 * 这不是被测代码的分支：`PointerEvent` 的构造参数是 `MouseEvent` 的超集，而派发后的监听方只读
 * `button` / 修饰键，用 `MouseEvent` 顶上足够让点击语义跑通。放在共享 setup 里，是因为任何挂
 * Base UI 单选 / 复选控件的用例都会撞上它，逐个文件注入只会漏。
 */
function restoreJsdomPointerEvent(): void {
  if (typeof window === 'undefined' || window.PointerEvent !== undefined) return;
  class PointerEventPolyfill extends MouseEvent {}
  Object.defineProperty(window, 'PointerEvent', { value: PointerEventPolyfill, configurable: true });
}

restoreJsdomPointerEvent();

/**
 * 给 jsdom 补上 `Element.prototype.scrollTo`（它只实现了 `scrollTop` 的读写，没有滚动 API）。
 *
 * 缺口：`Message Scroller` 的定位与 `@tanstack/react-virtual` 的 `scrollToIndex` 都直接调
 * `element.scrollTo({ top, behavior })`；jsdom 里那是 `undefined` ⇒ 挂载即
 * `TypeError: el.scrollTo is not a function`。这不是被测代码的分支（浏览器里一定有），
 * 故放在共享 setup 里补齐；`ResizeObserver` 相反，**不**放这里（它掩盖的是产品自己的兜底分支）。
 *
 * 语义只对齐「写 `scrollTop` / `scrollLeft`」：jsdom 没有平滑滚动，`behavior` 忽略。
 */
function restoreJsdomElementScroll(): void {
  if (typeof window === 'undefined') return;
  const proto = window.Element.prototype as typeof Element.prototype & {
    scrollTo?: (options?: ScrollToOptions | number, y?: number) => void;
  };
  if (typeof proto.scrollTo === 'function') return;
  proto.scrollTo = function scrollTo(this: Element, options?: ScrollToOptions | number, y?: number): void {
    if (typeof options === 'object' && options !== null) {
      if (typeof options.top === 'number') (this as HTMLElement).scrollTop = options.top;
      if (typeof options.left === 'number') (this as HTMLElement).scrollLeft = options.left;
      return;
    }
    if (typeof options === 'number') (this as HTMLElement).scrollLeft = options;
    if (typeof y === 'number') (this as HTMLElement).scrollTop = y;
  };
}

restoreJsdomElementScroll();

/**
 * `waitFor` / `findBy*` 的默认上限从 **1s** 提到 **10s**。
 *
 * 为什么必须提：默认那 1 秒是本仓全量并发下最容易制造**假红**的一处——jsdom 里组件树
 * （`Select` 的占位、表单的校验文案）在机器被进程创建拖满时要几秒才落定。
 * 实测 `run-create-panel.test.tsx` 的两条用例独占跑全绿、与其他文件同跑就在
 * `waitFor(() => getByText('请选择模型'))` 上红——错误信息是「找不到文本」，指向的是渲染时机而不是断言。
 * 提上限**不放松任何断言**：等不到照旧失败，只是不再把「机器慢」判成「组件错」。
 */
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});
