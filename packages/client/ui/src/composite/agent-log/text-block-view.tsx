'use client';

/**
 * `text` 块：**只有正文走 markdown**（思考、命令、结果都不是 markdown，解析只会得到字面标记）。
 *
 * 角色与来源的可见落点（§6.9）——这三格若没有界面表现，契约里就是装饰：
 *   · `assistant` 是默认主角，**不标注**；`user` 给左侧竖线 + `Tag`「用户」
 *     （否则一次会话里的多个用户轮会被读成智能体的输出）；
 *   · `system` 给 `Tag`「系统」+ **整块降一档**（厂商 system / 信封类文本与结论逐字同形）；
 *   · `role === 'tool'` 由工具类块自身表达，本件不另标；
 *   · `source !== 'wire'` 给块角标（`session-file` → 「补录」、`aggregate` → 「汇总」，
 *     `hook` / `wire` 的文案是 `null` ⇒ 不标）。
 *
 * `assembly === 'open'` 时挂**流式光标类名**——它是动效的**唯一**判据（模型里没有任何流式布尔）。
 * 光标本身是 CSS 伪元素（`apps/web-next/app/globals.css`），`ui` 包只带类名：本文件一行渲染细节都不改。
 */
import { Flex, Tag, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import { MarkdownText } from '../../base/markdown-text';
import { STREAM_CURSOR_CLASS } from '../../base/stream-cursor';
import type { TextBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

/**
 * 流式光标类名（2026-10-10 起真源在 `base/stream-cursor.ts`：活动行也用它）。
 * 这里原样转出，是为了不动既有 import 路径与那条跨包守卫的靶子。
 */
export { STREAM_CURSOR_CLASS };

export function TextBlockView({ block }: { block: TextBlock }): ReactNode {
  const { token } = theme.useToken();
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  const isUser = block.role === 'user';
  const isSystem = block.role === 'system';
  const hasMarks = isUser || isSystem || sourceLabel !== null;

  return (
    <Flex
      vertical
      gap={4}
      className={block.assembly === 'open' ? STREAM_CURSOR_CLASS : undefined}
      style={
        // 用户消息的左侧竖线：只给结构性的边框，宽度与颜色都取 token（不写像素、不手调字号）
        isUser
          ? { borderInlineStart: `${token.lineWidth}px solid ${token.colorBorder}`, paddingInlineStart: token.paddingSM }
          : undefined
      }
    >
      {hasMarks && (
        <Flex align="center" gap={4}>
          {isUser && <Tag>用户</Tag>}
          {isSystem && <Tag>系统</Tag>}
          {sourceLabel !== null && <Tag>{sourceLabel}</Tag>}
        </Flex>
      )}
      {isSystem ? (
        // 整块降一档：厂商 system 文本与智能体的结论必须看得出不是一回事
        <Typography.Paragraph type="secondary">
          <MarkdownText text={block.text} />
        </Typography.Paragraph>
      ) : (
        <MarkdownText text={block.text} />
      )}
    </Flex>
  );
}
