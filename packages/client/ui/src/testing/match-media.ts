/**
 * 测试用的 `matchMedia` 替身 + 安装助手。
 *
 * 为什么**必须**打桩：jsdom 25（本仓装的这一份）**完全没有实现** `window.matchMedia`，
 * 而 antd 6.6.5 的 `Table` 在挂载时的 layout effect 里会经由 `_util/responsiveObserver`
 * 直接调 `window.matchMedia(query)`（`grid/hooks/useBreakpoint` → `InternalTable`，
 * 用来过滤 `responsive` 列，**无条件**订阅、不看列上有没有 `responsive`）——
 * 不打桩，任何挂载 `Table` 的用例都抛 `TypeError: window.matchMedia is not a function`。
 * 与 `ResizeObserver` 同属**环境缺口**，不是被测代码的问题。
 *
 * 为什么不放进共享 `src/testing/setup.ts`：主题模块（`base/app-theme.tsx`、`base/theme-resolve.ts`）
 * 自带「无 `matchMedia` 时」的兜底分支，全局注入会让「这个 API 在环境里不存在」这一前提
 * 在所有用例里静默消失；需要的用例自己装（同 `resize-observer.ts` 的口径）。
 */
import { vi } from 'vitest';

/**
 * 把替身装成全局 `matchMedia`。
 * 替身对**所有**查询一律回「不匹配」：本仓没有按断点隐藏的列，静态 false 既省事又确定
 * （真按查询求值反而会引入一份测试自己实现的媒体查询解析器）。
 */
export function installMatchMediaStub(): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    return {
      matches: false,
      media: query,
      onchange: null,
      addListener: (): void => {},
      removeListener: (): void => {},
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
      dispatchEvent: (): boolean => false,
    };
  });
}
