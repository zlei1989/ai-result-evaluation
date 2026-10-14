'use client';

/**
 * `XMarkdown` 的本仓外壳（`@ant-design/x-markdown` 的导入只允许出现在 `base/`）。
 *
 * 三件事，每一件都是本仓的口径而不是 X 的默认值：
 *
 *   1. **`escapeRawHtml` 恒开、不做成 prop**。X 的默认是 `false`——原始 HTML 会渲染成**真实 DOM**
 *      （DOMPurify 无条件消毒，但挡不住 `style` 属性整屏覆盖、远程图信标、任意外链、假凭据表单）。
 *      正文是外部输入（厂商输出、随被测仓库克隆进来的 `SKILL.md`），故本仓一律转义成文本。
 *      做成 prop 就会有人为了「让某个标签生效」把它关掉，那不是调用方该有的自由。
 *   2. **`hasNextChunk` 由调用方给，且只认 `block.assembly === 'open'`**。本仓「这一块说完了没有」
 *      只有一个判据（`assembly`），这里不再自造第二个流式布尔。
 *   3. **明暗主题靠类名切换**：X 的主题是两份全局 CSS（`themes/light.css` / `themes/dark.css`），
 *      由 `.x-markdown-light` / `.x-markdown-dark` 二选一。类名读 `useAppliedThemeMode()`
 *      （即 `html[data-theme]` 这个**已经解析好**的明暗），不自己再判一次主题。
 *
 *      **不能拿 `theme.useToken().theme.id` 判明暗**：那个 `id` 是 `@ant-design/cssinjs` 的
 *      **Theme 实例计数器**（`Theme` 构造里 `this.id = uuid++`），不是算法编号——antd 的三个
 *      算法函数都没有 `id`。它只在「单给 `defaultAlgorithm`」这一条链上等于 0（命中 antd 模块级
 *      `defaultTheme` 那个缓存实例），而 `[底色算法, compactAlgorithm]`（`PageShell` 的紧凑密度
 *      作用域）与 `[darkAlgorithm, …]` 都是新实例、`id ≥ 1`。用它判明暗的后果是**紧凑作用域里
 *      恒判为暗**：亮色主题下正文挂 `x-markdown-dark`，白底白字读不出来。
 *
 *      那两份 CSS 由**应用**引（`apps/web-next` 的根布局）：`ui` 包直出 TS 源码、不是 Next 应用，
 *      全局 CSS 只能由应用侧引。
 *
 *   4. **三处排版口径钉在这里**（`PROSE_COMPONENTS`）：消费方只递 `text` 与 `open`，所以
 *      「一处改、两处同时生效」。壳**不套**外层 `Typography` 包裹：版面归 X，否则同一段 markdown
 *      在详情面与日志面会长得不一样。
 *
 * **已知边界**：SSR 下 X 的渲染器拿不到 DOMPurify 的 `sanitize`，服务端只出一个空的
 * `.x-markdown` div ⇒ 正文是「服务端空、客户端 hydrate 后才有字」。首屏面用它要按验收判据量化。
 */
import XMarkdown, { type XMarkdownProps } from '@ant-design/x-markdown';
import { Typography } from 'antd';
import type { ReactNode } from 'react';
import { useAppliedThemeMode } from './app-theme';

/**
 * 三处必须由本壳覆盖的排版口径，每一处都是「X 的默认值与本仓口径不一致」的落点：
 *
 *   1. **`pre` 与围栏里的 `code` 都不折行**：X 的默认样式给**两个标签**都写了 `white-space: pre-wrap`
 *      （`.x-markdown pre, .x-markdown code`），`disableDefaultStyles` 关不掉它，只能内联 style 覆盖。
 *      **只盖 `pre` 不够**：块级 `code` 是 `display: block`，文字在它自己那一层就折了，
 *      `pre` 永远滚不出来（真机量到 8 行逻辑文本被折成 16 行视觉行、`scrollWidth` 等于 `clientWidth`）。
 *      提示词里的调用链路图靠前导空格对齐，折行会把树形结构撕成几段读不出来——宁可让用户横向滚。
 *      X 自己产出的这两个标签不带布局类属性（见它的 code renderer），故只透传 X 塞进来的属性。
 *      行内代码（`block === false`）不动：那一段本来就该跟着段落折行。
 *   2. **标题降两级**：`h1` → 4 级、`h2` 及以下 → 5 级。右栏只有 320–640px，照原级渲染会得到
 *      页面级巨标题，还会把整页的标题大纲带偏（详情页不该长出 `h1`）；antd 的 `Title` 只到 5 级。
 *   3. **外链新标签打开**：X 默认不给 `a` 加 `target` / `rel`，故开它自己的 `openLinksInNewTab`
 *      （顺带带上 `rel="noopener noreferrer"`，比只给 `noreferrer` 更严）。正文是外部输入，
 *      不挡 `window.opener` 等于把详情页交出去。这一条走 X 的 prop，**不在这张表里**——
 *      放进表里会把 `a` 变成自定义组件，未闭合链接的流式档位就得由本仓自己维护。
 *
 * 映射表照旧只覆盖这几类：段落 / 列表 / 表格 / 行内代码的样式归 X 自己的主题 CSS。
 */
const PROSE_COMPONENTS: NonNullable<XMarkdownProps['components']> = {
  h1: ({ children }) => <Typography.Title level={4}>{children}</Typography.Title>,
  h2: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
  h3: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
  h4: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
  h5: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
  h6: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
  pre: ({ children }) => <pre style={{ overflowX: 'auto', whiteSpace: 'pre' }}>{children}</pre>,
  // `domNode` / `streamStatus` / `lang` 是 X 塞进来的内部 prop（`streamStatus` 与 `data-state` 同义），
  // 落到 DOM 上就是非法属性；`data-block` / `data-state` 走 rest 原样保留。
  // `class` 也必须摘掉：X 把语言类名并进了 `className`，却把原始的 `class` 留在属性里，
  // 直接透传会触发 React 的「Invalid DOM property `class`」警告。
  code: ({ block, children, domNode: _domNode, streamStatus: _streamStatus, lang: _lang, class: _class, ...attrs }) => (
    <code {...attrs} style={block ? { whiteSpace: 'pre' } : undefined}>
      {children}
    </code>
  ),
};

export interface XMarkdownTextProps {
  /** markdown 原文：只渲染，不改写、不落盘 */
  text: string;
  /**
   * 这一段**还没收尾**——后面还有内容没到。本仓唯一判据是 `block.assembly === 'open'`。
   *
   * **刻意必填、不给默认值**：给了默认值，日后新增消费方会静默拿到 `false`，
   * 「这一段其实还没收尾」不会有任何提示。本仓对静默失败的容忍度是零
   * （同类前例：`Button` 单给 `variant` 静默降级、`Flex` 的 `gap="medium"` 静默不生效），
   * 所以每个调用方都要为这件事**表态过一次**——非流式面写 `open={false}` 是这笔代价，认了。
   */
  open: boolean;
}

export function XMarkdownText({ text, open }: XMarkdownTextProps): ReactNode {
  // 明暗取**已解析**的那个真源（`html[data-theme]`）：与根节点底色、`color-scheme` 同一处取值，
  // 不会出现「组件按暗色渲染、页面底色是亮的」那种半亮（判据说明见文件头第 3 条）
  const mode = useAppliedThemeMode();
  return (
    <XMarkdown
      className={mode === 'light' ? 'x-markdown-light' : 'x-markdown-dark'}
      escapeRawHtml
      // 外链一律新标签打开 + 挡掉 `window.opener`（本仓口径，见上面的第 3 条）
      openLinksInNewTab
      components={PROSE_COMPONENTS}
      streaming={{
        // 新到的片段淡入：这就是「打字」的观感来源，**不是** `Bubble.typing`
        // （那一格要求内容是字符串，用它正文的 markdown 会整块丢掉）
        enableAnimation: true,
        hasNextChunk: open,
        tail: false,
      }}
    >
      {text}
    </XMarkdown>
  );
}
