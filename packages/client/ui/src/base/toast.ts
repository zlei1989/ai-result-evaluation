'use client';

/**
 * toast 的调用面：把 vendored Base UI manager 收成「按意图命名」的四个方法与一个 `promise`。
 *
 * vendored 的 manager 只有 `add({ type, description })`——`type` 决定图标，文案落在 description 上；
 * 页面若直接写 `add`，每个调用点都要记得给 `type`，漏一次就是「成功提示没有对勾」这种静默偏差。
 * 这一层只做映射与默认值，不持有任何状态：`toast` 仍是 vendored 模块里那个模块级单例，
 * 所以 `Toaster` 挂在哪、页面在哪调用，都指向同一个队列。
 *
 * 明暗不在这里配：样式全在 `globals.css` 的语义变量里，暗色由 `html[data-theme='dark']` 覆盖。
 * `promise` 原样转发（三态由 Base UI 的 store 推进），调用方拿到的是**原 promise**：
 * 失败时它仍会 reject，既已由 error 态呈现，调用方要自己接住 rejection。
 */
import type { ReactNode } from 'react';
import { toast as baseToast } from '../components/ui/toast';

/** 四类一次性提示：`type` 只影响图标与配色，文案走 `title`（主行，读屏也会念它） */
function notify(type: 'success' | 'error' | 'info' | 'warning', content: ReactNode): string {
  return baseToast.add({ type, title: content });
}

export const toast = {
  success: (content: ReactNode): string => notify('success', content),
  error: (content: ReactNode): string => notify('error', content),
  info: (content: ReactNode): string => notify('info', content),
  warning: (content: ReactNode): string => notify('warning', content),
  /** 进行中 → 成功 / 失败：三态共用一个 toast，`options` 的每一项都可以是字符串或对象 */
  promise: baseToast.promise,
  /** 关掉一条（不传 id 就全关）：页面不需要，留给测试与将来的「撤销」入口 */
  close: (id?: string): void => baseToast.close(id),
};
