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
import { createElement, useEffect, useMemo, useState, type ReactNode } from 'react';
import { SYSTEM_DARK_QUERY, readSystemDark, resolveThemeMode, type ThemePreference } from './theme-resolve';

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
