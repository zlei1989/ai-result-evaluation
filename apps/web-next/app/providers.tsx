'use client';

/**
 * antd 客户端 Provider：主题（偏好 auto/light/dark）+ App 包装（message/modal 上下文）+ 紧凑密度。
 * 主题来源 = GET /api/settings（useSettings）→ 偏好交给 ui 包的 useResolvedTheme 解析；
 * 主题口径（auto 按系统偏好解析、data-theme / data-theme-preference 写入、holderRender 注册）统一在 ui 包，
 * 本组件只负责「把偏好喂进去 + 提供 AntdApp 子树」。
 */
import { useSettings } from '@aieval/client';
import { DensityProvider, useResolvedTheme } from '@aieval/ui';
import { App as AntdApp, ConfigProvider } from 'antd';
import type { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }): ReactNode {
  const { settings } = useSettings();
  // 设置未就绪时 useResolvedTheme 内部按暗色兜底（SSR 期不闪白）
  const { mode, themeConfig } = useResolvedTheme({ preference: settings?.theme });
  return (
    <ConfigProvider theme={themeConfig}>
      {/* 把解析后的实际明暗传给 PageShell：其紧凑密度主题需据此选底色算法 */}
      <DensityProvider mode={mode}>
        <AntdApp>{children}</AntdApp>
      </DensityProvider>
    </ConfigProvider>
  );
}
