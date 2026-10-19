/**
 * 测试用的 `matchMedia` 替身 + 安装助手。
 *
 * 为什么需要：jsdom 25（本仓装的这一份）**完全没有实现** `window.matchMedia`，
 * 而主题解析要按系统偏好决定明暗（`auto` 档）——不打桩，「跟随系统」这条路在 jsdom 里
 * 只能走「API 不存在」的兜底分支，测不到真正的解析。与 `ResizeObserver` 同属**环境缺口**，
 * 不是被测代码的问题。
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
