'use client';

/**
 * 应用主题解析：把偏好（auto/light/dark）解析成实际明暗，并落文档根属性。
 *
 * **`html[data-theme]` 是主题的唯一真源**：CSS 变量组（`globals.css`）按它取色，
 * JS 侧需要布尔的消费方走 `useAppliedThemeMode()`（读的也是它）。这里没有第二份主题对象，
 * 因此也不存在「组件亮了、底色还是暗的」那种半亮主题——没有第二处可不同步。
 *
 * 口径：偏好由调用方从设置取后以 props 传入（ui 包不调接口，故不 import client 包）；
 * data-theme 恒为**解析后**的明暗，data-theme-preference 保留偏好原值（auto 要能区分出来）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './theme-resolve';

/**
 * 读**已经解析好**的实际明暗（`html[data-theme]`）。
 *
 * 为什么需要：`useResolvedTheme()` 的 `preference` 缺省是 `'dark'`（见下面 `rawPreference ?? 'dark'`，
 * 那是 SSR 期兜底、不闪白用的）。页面若再调一次 `useResolvedTheme()` 而不传偏好，就会拿到 `'dark'`——
 * 既是**第二份**主题判据，又与真正解析过的结果相反；它的 `apply` 副作用还会把 `data-theme` 改回暗色。
 *
 * 本文件的既有口径是「`data-theme` 恒为**解析后**的明暗」，故消费方直接读它，不再自行解析一次。
 * 无浏览器 / 属性缺失 / 属性是脏值时按暗色——与服务端默认一致，SSR 首帧不闪白。
 */
export function readAppliedThemeMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** `data-theme` 变化的订阅：写属性的那次 effect 完成后通知所有消费方（设置页切主题即触发） */
function subscribeAppliedThemeMode(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

/**
 * 跟随已解析明暗的 hook。用 `useSyncExternalStore` 而不是 `useState + useEffect`：
 * 后者首帧会先渲染兜底值再补一次，diff 正文会闪一下；前者在提交阶段就取到 DOM 上的真值。
 */
export function useAppliedThemeMode(): 'light' | 'dark' {
  return useSyncExternalStore(subscribeAppliedThemeMode, readAppliedThemeMode, () => 'dark' as const);
}

export interface UseResolvedThemeOptions {
  /** 偏好原值；未就绪（设置还没拉到）按暗色兜底——默认观感，SSR 期不闪白 */
  preference?: ThemePreference;
  /** 是否把解析结果写进文档根（默认 true） */
  apply?: boolean;
}

export interface ResolvedTheme {
  /** 实际生效的明暗（auto 已解析） */
  mode: 'light' | 'dark';
  /** 偏好原值，供排障与断言区分「跟随系统」与「显式指定」 */
  preference: ThemePreference;
}

export function useResolvedTheme({ preference: rawPreference, apply = true }: UseResolvedThemeOptions = {}): ResolvedTheme {
  const preference = rawPreference ?? 'dark';
  // 系统深色偏好：SSR/首帧无 window → 先按深色，挂载后立即解析并订阅变化
  const [systemDark, setSystemDark] = useState(readSystemDark);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SYSTEM_DARK_QUERY);
    const sync = (): void => setSystemDark(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const mode: 'light' | 'dark' = resolveThemeMode(preference, systemDark);

  useEffect(() => {
    if (!apply) return;
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.themePreference = preference;
  }, [apply, mode, preference]);

  return { mode, preference };
}
