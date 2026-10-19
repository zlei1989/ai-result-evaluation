/**
 * PostCSS 只挂一个插件：Tailwind v4 的官方 PostCSS 入口。
 *
 * 为什么不需要 `tailwind.config.js`：v4 把配置搬进了 CSS（`globals.css` 里的
 * `@theme inline` / `@source` / `@custom-variant`），插件本身只为构建管线存在。
 *
 * 版式取自 Next 16 的 App Router CSS 指南（`next/dist/docs/01-app/01-getting-started/11-css.md`），
 * 与官方文档逐字一致——那个文件里写的就是这张对象。
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
