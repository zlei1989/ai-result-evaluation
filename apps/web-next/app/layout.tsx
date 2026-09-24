/** SSR 壳：html/body + antd Provider + 全局样式。 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI 代码评测',
  description: 'AI 生成代码的评测工具',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
