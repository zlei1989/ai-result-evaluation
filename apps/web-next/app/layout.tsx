/** SSR 壳：html/body + antd Provider + 全局样式。 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';
// X 的正文排版（XMarkdown 的主题变量与 `.x-markdown-*` 规则）。两份都必须引：
// 选择器各挂在 `.x-markdown-light` / `.x-markdown-dark` 下，由 `XMarkdownText` 按 antd token
// 二选一 —— 只引一份，另一套主题下的正文就是无样式的兜底。
// 只能由应用侧引：`ui` 包直出 TS 源码、不是 Next 应用，全局 CSS 过不了它的构建；
// 也因此这个包必须在 `apps/web-next` 的 dependencies 里，否则 Next 从应用侧解析不到（整站 500）。
import '@ant-design/x-markdown/themes/light.css';
import '@ant-design/x-markdown/themes/dark.css';

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
