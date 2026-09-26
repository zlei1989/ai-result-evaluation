'use client';

/**
 * 应用主题解析：把偏好（auto/light/dark）解析成实际明暗 + antd 主题配置，并落文档根属性。
 *
 * **三个消费点必须同步，缺一处就会出现「组件亮了、底色还是暗的」的半亮主题**：
 *   ① <ConfigProvider theme>            —— 组件层配色
 *   ② html[data-theme]                  —— CSS 底色变量与 color-scheme
 *   ③ ConfigProvider.config({ holderRender }) —— 脱离 React 上下文的静态 message/Modal
 *
 * 口径：偏好由调用方从设置取后以 props 传入（ui 包不调接口，故不 import client 包）；
 * data-theme 恒为**解析后**的明暗，data-theme-preference 保留偏好原值（auto 要能区分出来）。
 */
import { App as AntdApp, ConfigProvider, theme } from 'antd';
import type { ThemeConfig } from 'antd';
import { createElement, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './theme-resolve';

/**
 * 读**已经解析好**的实际明暗（`html[data-theme]`）。
 *
 * 为什么需要：`useResolvedTheme()` 的 `preference` 缺省是 `'dark'`（见下面 `rawPreference ?? 'dark'`，
 * 那是 SSR 期兜底、不闪白用的）。页面若再调一次 `useResolvedTheme()` 而不传偏好，就会拿到 `'dark'`——
 * 既是**第二份**主题判据，又与真正解析过的结果相反；它的 `apply` 副作用还会把 `data-theme` 改回暗色，
 * 于是 `ConfigProvider` 是明亮主题、组件却按暗色渲染（症状：「亮色主题下背景不对」）。
 *
 * 本文件的既有口径是「`data-theme` 恒为**解析后**的明暗」，故消费方直接读它，不再自行解析一次。
 * 无浏览器 / 属性缺失 / 属性是脏值时按暗色——与服务端默认一致，SSR 首帧不闪白。
 */
export function readAppliedThemeMode(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

/** `data-theme` 变化的订阅：`providers` 写完属性后通知所有消费方（设置页切主题即触发） */
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
  /** 是否把解析结果写进文档根与 antd 静态渲染器（默认 true） */
  apply?: boolean;
}

export interface ResolvedTheme {
  /** 实际生效的明暗（auto 已解析） */
  mode: 'light' | 'dark';
  /** 偏好原值，供排障与断言区分「跟随系统」与「显式指定」 */
  preference: ThemePreference;
  themeConfig: ThemeConfig;
  /** 静态 message/Modal 的 holderRender：脱离 React 上下文渲染时也要跟随同一主题 */
  holderRender: (node: ReactNode) => ReactNode;
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
  const themeConfig: ThemeConfig = useMemo(
    () => ({ algorithm: mode === 'light' ? theme.defaultAlgorithm : theme.darkAlgorithm }),
    [mode],
  );
  const holderRender = useMemo(
    () => (node: ReactNode) => createElement(ConfigProvider, { theme: themeConfig }, createElement(AntdApp, null, node)),
    [themeConfig],
  );

  useEffect(() => {
    if (!apply) return;
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.themePreference = preference;
    ConfigProvider.config({ theme: themeConfig, holderRender });
  }, [apply, mode, preference, themeConfig, holderRender]);

  return { mode, preference, themeConfig, holderRender };
}
