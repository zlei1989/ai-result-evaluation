'use client';

/**
 * 共用 markdown 正文渲染器的本仓外壳（`streamdown` + `Code Block` + `Typeset`）。
 *
 * 四个消费面（考题提示词、技能正文、日志正文、用户提示词）都只递 `text` 与 `open`，
 * 所以口径只能钉在这里——钉在消费方就会「换一个消费面少一份证据」。四条口径：
 *
 *   1. **原始 HTML 一律转义成文本，且不交给调用方决定**。`streamdown` 默认带 `rehype-raw`，
 *      原始 HTML 会进 DOM 树；本仓只挂 `sanitize` + `harden` 两个插件（不传 `raw`），于是
 *      标签被转义成**看得见的字面量**。正文是外部输入（厂商输出、随被测仓库克隆进来的
 *      `SKILL.md`），做成 prop 就会有人为了「让某个标签生效」把 raw 放回来。
 *      **不用 `skipHtml`**：它删节点，HTML 直接消失；本仓要的是字面量。
 *   2. **`open` 是「这一块还没收尾」的唯一判据**。本仓的规范词来自契约的 `assembly === 'open'`；
 *      翻成 `streamdown` 的 `isAnimating` 只发生在这里一行（该 prop 还兼管「围栏还没闭合」的
 *      识别与复制按钮的禁用，属于同一件事的两面）。**刻意必填、不给默认值**：给了默认值，
 *      日后新增消费方会静默拿到 `false`，「这一段其实还没收尾」不会有任何提示。
 *   3. **围栏代码块不折行**。`CodeBlockContent` 的 `wrap` 默认是 `false`（`data-wrap` 不写，
 *      `whitespace-pre-wrap` 那条变体不生效），内层 `<code>` 是 `min-w-max` 撑到内容宽、
 *      横向滚动由 `overflow-auto` 给 ⇒ 本仓**不打开 `wrap`**。提示词里的调用链路图靠前导空格
 *      对齐，宁可让用户横向滚也不撕开树形结构。
 *   4. **标题降两级**：`h1` 渲成 `<h4>`、`h2`–`h6` 渲成 `<h5>`。右栏只有 320–640px，照原级渲染
 *      会长出页面级巨标题、还会把整页标题大纲带偏。层级重映射归 `components`（`typeset` 是纯
 *      CSS、按元素名选中，不做重映射），字号 / 行高 / 间距归 `typeset` 的排版层
 *      （标题档与块间距由 `globals.css` 的「排版尺度（typeset）」块覆盖，见该块文件头）。
 *
 * **SSR 首帧就有正文**：消毒是纯 JS 的 `rehype-sanitize` + `rehype-harden`，渲染路径不碰 DOM，
 * 服务端能出完整 HTML；后到的只有代码着色（`useHighlightedCode` 先渲染原文、hydrate 后换成
 * 着色结果，字符与行数不变）。
 *
 * 围栏代码块由 `Code Block` 接管（`components.code` + `data-block` 判别），行内代码保持行内：
 * 复制按钮、语言标签、逐行渲染都在那一层。`controls={false}` 关掉 streamdown 自带的表格 /
 * 图片工具条——版面 chrome 由本仓的组件决定，不要两套按钮。
 */
import { Streamdown, defaultRehypePlugins, useIsCodeFenceIncomplete, type Components, type ExtraProps } from 'streamdown';
import type { ReactNode } from 'react';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from '../components/ui/code-block';
import { useHighlightedCode } from '../hooks/use-highlighted-code';

/** 围栏的语言标记：`language-ts` → `ts`；没有标记时是空串（表头回落成 `text`） */
const LANGUAGE_PATTERN = /language-(\S+)/;

/**
 * 围栏代码块：语言标签 + 复制按钮 + 逐行内容。
 *
 * `useIsCodeFenceIncomplete()` 只在 `isAnimating` 开着时有效（外壳把 `open` 翻成它），
 * 返回 `true` 表示闭围栏还没到——这一档的可见产物就是**复制按钮禁用**：半截代码复制走没有意义。
 */
function FencedCodeBlock({ code, language }: { code: string; language: string }): ReactNode {
  const incomplete = useIsCodeFenceIncomplete();
  const lines = useHighlightedCode(code, language);

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || 'text'}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} disabled={incomplete} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * `code` 的总入口：围栏代码走 `Code Block`，行内代码原样出 `<code>`。
 *
 * `streamdown` 只给围栏代码挂 `data-block`（`pre` 的默认渲染把该属性塞给它的 `code` 子节点），
 * 因此「围栏 vs 行内」有现成判据，不需要自己数反引号。
 */
function MarkdownCode({
  children,
  className,
  ...rest
}: React.ComponentProps<'code'> & ExtraProps): ReactNode {
  if (!('data-block' in rest)) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  return (
    <FencedCodeBlock
      code={typeof children === 'string' ? children : ''}
      language={LANGUAGE_PATTERN.exec(className ?? '')?.[1] ?? ''}
    />
  );
}

/**
 * 本仓口径的排版表：标题降两级 + 外链新标签打开 + 围栏交给 `Code Block`。
 *
 * 其余元素（段落 / 列表 / 表格 / 引用）交给 `typeset` 的排版层与 `streamdown` 的默认渲染器：
 * 壳不套额外的排版容器，否则同一段 markdown 在详情面与日志面会长得不一样。
 */
const PROSE_COMPONENTS: Components = {
  h1: ({ children }) => <h4>{children}</h4>,
  h2: ({ children }) => <h5>{children}</h5>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h5>{children}</h5>,
  h6: ({ children }) => <h5>{children}</h5>,
  // 外链一律新标签打开并挡掉 `window.opener`：正文是外部输入，不挡等于把详情页交出去。
  // 同时关掉 `streamdown` 的外链确认层（`linkSafety`）——目标与 rel 已在下面这一行钉死，
  // 再叠一层「点了先弹确认」只会让每次点击多一步。
  a: ({ children, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  code: MarkdownCode,
  // 粗体仍然出原生 `<strong>`：streamdown 的默认实现把它渲成 `<span data-streamdown="strong">`
  // （只有 `font-semibold` 的观感，没有语义）。正文要被读屏、复制、被 `strong` 选择器选中，
  // 语义标签不能降级成 span。
  strong: ({ children }) => <strong>{children}</strong>,
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
  return (
    <div data-slot="markdown" className="typeset typeset-chat">
      {/*
        `Streamdown` 自己的根节点写死了 `space-y-4`（utilities 层），块间距的差异化归
        `globals.css` 的「排版尺度（typeset）」块（层外，压过 utilities）。故这里**不挂**
        任何 `space-y-*` / `mt-*`：再挂一个只会和那一块抢同一件事，两层不同的间距真源
        在标题与段落上会表现为「谁在某一次构建里恰好被产出」。
      */}
      <Streamdown
        // 不传 `raw`：原始 HTML 被转义成文本（口径 ①）。`defaultRehypePlugins` 是
        // `Record<string, Pluggable>`，`noUncheckedIndexedAccess` 下取出来是可选，故滤掉 undefined
        rehypePlugins={[defaultRehypePlugins.sanitize, defaultRehypePlugins.harden].filter(
          (plugin) => plugin !== undefined,
        )}
        components={PROSE_COMPONENTS}
        // 「这一块说完了没有」翻成 streamdown 的流式开关（口径 ②）：未闭合围栏的识别与
        // 复制按钮的禁用它都认这一个开关
        isAnimating={open}
        // 版面 chrome 归本仓的组件：关掉自带表格 / 图片工具条，避免两套按钮
        controls={false}
        // 外链的 target / rel 在 `PROSE_COMPONENTS.a` 里钉死，外链确认层因此关掉（见该处注释）
        linkSafety={{ enabled: false }}
      >
        {text}
      </Streamdown>
    </div>
  );
}
