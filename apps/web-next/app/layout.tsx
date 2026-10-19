/** SSR 壳：html/body + 根 Providers + 全局样式。 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { APP_TITLE } from '@/src/app-title';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: APP_TITLE,
  description: 'AI 生成代码的评测工具',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    // `data-theme` 直出暗色：SSR 兜底与 `useResolvedTheme` 的缺省一致（不闪白）；
    // 客户端 effect 挂载后按用户偏好改写，主题的唯一真源就是这个属性。
    <html lang="zh-CN" data-theme="dark">
      <body>
        <Providers>{children}</Providers>
        {/* 未水合兜底：8 秒后由 CSS 浮出（`#hydrate-fallback` 的动画），Providers 一挂载就摘掉它。
            只有「客户端脚本没跑起来」时才会被看见——最常见的原因是开发期用 127.0.0.1 / 内网 IP
            打开 dev server，`/_next` 被跨源策略挡住。没有这条，用户看到的是永远转的骨架和点不动的页签。 */}
        <div id="hydrate-fallback" role="status" data-testid="hydrate-fallback">
          <strong>界面脚本没有加载完成。</strong>
          <span>若你用的是 127.0.0.1 或内网地址，请改用 http://localhost:3083；或让服务端放过该来源（AIEVAL_DEV_ORIGINS）。</span>
        </div>
      </body>
    </html>
  );
}
