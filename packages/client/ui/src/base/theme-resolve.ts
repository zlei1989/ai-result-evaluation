/**
 * 主题解析的纯函数部分（与 React 无关，便于单测锁定口径）。
 * 口径：auto 跟随操作系统；无浏览器环境一律按深色——与服务端默认主题一致，SSR 期不闪白。
 */

/** 主题偏好：auto=跟随操作系统、light=明亮、dark=暗色 */
export type ThemePreference = 'auto' | 'light' | 'dark';

/** 系统深色偏好的媒体查询：auto 模式据此解析（浏览器端唯一判据） */
export const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/** 读系统深色偏好；无 window / 无 matchMedia（SSR、老环境）按深色 */
export function readSystemDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/** 偏好 → 实际明暗：auto 跟随系统，其余原样 */
export function resolveThemeMode(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (preference !== 'auto') return preference;
  return systemDark ? 'dark' : 'light';
}
