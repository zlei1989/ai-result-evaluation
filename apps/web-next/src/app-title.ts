/**
 * 应用名与页面标题的唯一拼法。
 *
 * `layout.tsx` 的 metadata 与各路由的运行时标题都从这里取——两处各写一遍，
 * 改名时必有一处忘掉，症状是「标签页写着旧名字、浏览器书签又是另一个」。
 */
export const APP_TITLE = 'AI 代码评测';

/** 单个路由的 `<title>`：`评测 · AI 代码评测`（页面名在前，便于多标签页里辨认） */
export function pageTitle(page: string): string {
  return `${page} · ${APP_TITLE}`;
}
