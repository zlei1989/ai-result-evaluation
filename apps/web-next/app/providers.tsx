'use client';

/**
 * 根客户端 Provider：主题（偏好 auto/light/dark）+ 全局应答宿主（智能体的提问弹层，全站可见）+ toast 宿主。
 *
 * 主题来源 = GET /api/settings（`useSettings`）→ 偏好交给 ui 包的 `useResolvedTheme` 解析；
 * 主题口径（auto 按系统偏好解析、`data-theme` / `data-theme-preference` 写入）统一在 ui 包，
 * 本组件只负责「把偏好喂进去 + 挂上应答宿主与 Toaster」。
 *
 * **没有 Provider 壳**：明暗的唯一真源是 `html[data-theme]`，组件从 `globals.css` 的 CSS 变量取色，
 * 因此不存在需要向下分发的主题对象，也没有「第二处要同步」的地方。
 * `Toaster` 不产出包裹节点（children 原样渲染），页面高度链由 `body` 的纵向 flex
 * 与 `PageShell` 的 `flex-1` 承接，不依赖任何组件库的根节点。
 *
 * 挂载即摘掉布局里的未水合兜底条：那条提示由 CSS 在 8 秒后才显示，本组件跑起来就说明水合成功。
 */
import { useSettings } from '@aieval/client';
import { Toaster, useResolvedTheme } from '@aieval/ui';
import { useEffect, type ReactNode } from 'react';
import { AskUserHost } from './ask-user-host';
import { CommandPaletteHost } from './command-palette';

export function Providers({ children }: { children: ReactNode }): ReactNode {
  const { settings } = useSettings();
  // 设置未就绪时按暗色兜底（SSR 期不闪白）；本 hook 的副作用只有「写 html[data-theme] 两个属性」
  useResolvedTheme({ preference: settings?.theme });
  // 水合完成 ⇒ 兜底条没有意义了，直接摘掉（它本来要等 8 秒才可见，正常情况永远看不见）
  useEffect(() => {
    document.getElementById('hydrate-fallback')?.remove();
  }, []);
  return (
    <Toaster>
      {children}
      {/* 应答宿主：与页面平级（它要全局可见，不能只活在某个页面壳里）；
          密度取 `:root` 的档（见该文件头） */}
      <AskUserHost />
      {/* 命令面板：同样要全站可见——从任何页面 ⌘K 都能跳到某条用例 / 评测 */}
      <CommandPaletteHost />
    </Toaster>
  );
}
