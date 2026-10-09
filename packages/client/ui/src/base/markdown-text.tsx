'use client';

/**
 * MarkdownText：把一段 markdown 原文渲染成 antd 排版元素。
 *
 * 消费者有三处：用例详情的「考题提示词」卡片、执行日志里用户提示词首条、以及助手正文块（提示词由模型 / 外部系统写，常带标题、表格、
 * 围栏代码块、行内代码）。三条口径：
 *   1. **排版交给 antd**：外层用 `Typography` 建立 `.ant-typography` 上下文，antd 会为它内部的
 *      `code / strong / del / ul / ol / blockquote / table / pre` 配上成套样式——连 `pre` 里嵌套的
 *      `code` 都被它抹平，不会出现「代码块里再套一个行内代码片」。所以本组件只映射四处：
 *      标题、段落、链接、围栏代码块；不手写字号、不手调行内边距（AGENTS.md「样式一律走 antd」）。
 *   2. **标题降两级**：markdown 的 h1→4 级、h2 及以下→5 级。右栏只有 320–640px，
 *      照原级渲染会得到页面级巨标题，还会把整页的标题大纲带偏（详情页不该长出 h1）。
 *   3. **`remark-gfm` 是必需品**：真实用例的提示词里有 23 行 GFM 表格，去掉它那些行会退化成一堆
 *      竖线文本。**不引入 `rehype-raw`**：提示词是外部输入，原始 HTML 由 react-markdown 默认转义成
 *      文本——看得见提示词里写了什么，又不会变成活元素。
 */
import { Typography } from 'antd';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export interface MarkdownTextProps {
  /** markdown 原文：只渲染，不改写、不落盘 */
  text: string;
}

export function MarkdownText({ text }: MarkdownTextProps): ReactNode {
  return (
    // antd 的排版重置样式都挂在 `.ant-typography` 下，这一层就是给下面的原生标签（ul / table / blockquote）用的
    <Typography>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          // antd 的 Title 只到 5 级（h1–h5），markdown 的 h5 / h6 一并落到 5 级
          h1: ({ children }) => <Typography.Title level={4}>{children}</Typography.Title>,
          h2: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
          h3: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
          h4: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
          h5: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
          h6: ({ children }) => <Typography.Title level={5}>{children}</Typography.Title>,
          p: ({ children }) => <Typography.Paragraph>{children}</Typography.Paragraph>,
          // 提示词里的外链不受本仓控制：一律新标签打开，并挡掉 window.opener
          a: ({ href, children }) => (
            <Typography.Link href={href} target="_blank" rel="noreferrer">
              {children}
            </Typography.Link>
          ),
          /**
           * 围栏代码块：antd 给 `pre` 的默认样式是 `pre-wrap`（长行折行），这里改回 `pre` +
           * 横向滚动。提示词里的调用链路图靠前导空格对齐，折行会把树形结构撕成几段读不出来——
           * 宁可让用户横向滚。`overflowX` 只在超宽时出现滚动条，窄内容看不出区别。
           */
          pre: ({ children }) => <pre style={{ overflowX: 'auto', whiteSpace: 'pre' }}>{children}</pre>,
        }}
      >
        {text}
      </Markdown>
    </Typography>
  );
}
