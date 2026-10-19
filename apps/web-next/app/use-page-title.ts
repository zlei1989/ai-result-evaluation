'use client';

/**
 * 路由级 `<title>`：客户端页把页面名写进浏览器标签页。
 *
 * 为什么不用 Next 的 `metadata`：`/runs`、`/cases`、`/settings` 都是 `'use client'` 页面
 * （它们要 `useSearchParams` 与 SWR），而 client component 不能导出 `metadata`。
 * 于是退一步在挂载后写 `document.title`——三页共用一个拼法（`src/app-title.ts`），不各写一份。
 */
import { useEffect } from 'react';
import { pageTitle } from '@/src/app-title';

export function usePageTitle(page: string): void {
  useEffect(() => {
    document.title = pageTitle(page);
  }, [page]);
}
