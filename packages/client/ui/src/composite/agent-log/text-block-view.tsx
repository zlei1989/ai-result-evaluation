'use client';

/**
 * `text` 块：**只有正文走 markdown**（思考、命令、结果都不是 markdown，解析只会得到字面标记）。
 *
 * 角色与来源的可见落点——这三格若没有界面表现，契约里就是装饰：
 *   · `assistant` 是默认主角，**不标注**；`user` 给左侧竖线 + `Tag`「用户」
 * （否则一次会话里的多个用户轮会被读成智能体的输出）；
 *   · `system` 给 `Tag`「系统」+ **整块降一档**（厂商 system / 信封类文本与结论逐字同形）；
 *   · `role === 'tool'` 由工具类块自身表达，本件不另标；
 *   · `source !== 'wire'` 给块角标（`session-file` → 「补录」、`aggregate` → 「汇总」，
 *     `hook` / `wire` 的文案是 `null` ⇒ 不标）。
 *
 * `assembly === 'open'` 时在正文下方给一行**「转圈 + 正在思考」**——它仍是动效的**唯一**判据
 * （模型里没有任何流式布尔）。
 */
import { Flex, Spin, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { XMarkdownText } from '../../base/x-markdown';
import { STREAM_CURSOR_CLASS } from '../../base/stream-cursor';
import type { TextBlock } from './types';
import { MESSAGE_SOURCE_LABELS } from './types';

/**
 * 流式光标类名（真源在 `base/stream-cursor.ts`：活动行也用它）。
 * 这里原样转出，是为了不动既有 import 路径与那条跨包守卫的靶子。
 */
export { STREAM_CURSOR_CLASS };

export function TextBlockView({ block }: { block: TextBlock }): ReactNode {
  const sourceLabel = MESSAGE_SOURCE_LABELS[block.source];
  const isSystem = block.role === 'system';

  return (
    // 最原始的形态：**没有左侧竖线、没有内边距、没有角色标签**——
    // 这一块的样式全部归 XMarkdown 自己，本仓只保留两样非样式的东西：
    // 一是「不是智能体自己说的」那两档角标，二是「还没写完」那一行。
    <Flex vertical gap={4}>
      {isSystem || sourceLabel !== null ? (
        <Flex align="center" gap={4}>
          {isSystem && <Tag>系统</Tag>}
          {sourceLabel !== null && <Tag>{sourceLabel}</Tag>}
        </Flex>
      ) : null}
      {/*
        正文**直接交给 `XMarkdown`**：字符串进、它自己渲染，本仓不套任何排版容器。
        此前 system 那一档外面包了 `Typography.Paragraph type="secondary"`——那是**我们在覆盖它**：
        antd 的排版规则会盖掉 X 自己的 `table` / `code` / 段落样式，于是同一段 markdown
        在 system 与非 system 两档长得不一样。要弱化就弱化整块，不要动它的内部排版。
      */}
      <XMarkdownText text={block.text} open={block.assembly === 'open'} />
      {/*
        还在写：正文下方一行「转圈 + 正在思考」。
        **不再是容器上的闪烁光标**——那一格是纯 CSS 伪元素，读者只能看出「有东西在闪」，
        说不出在做什么；这一行有字，且用的是 antd 的 `Spin`（与 X 的 `loadingRender` 同一种表达）。
      */}
      {block.assembly === 'open' && <WorkingRow />}
    </Flex>
  );
}

/** 「这一条还在写」那一行。留成独立组件，是为了让上面那棵树各分支的职责一眼可分 */
function WorkingRow(): ReactNode {
  return (
    <Flex align="center" gap="middle">
      <Spin size="small" />
      <Typography.Text>正在思考</Typography.Text>
    </Flex>
  );
}
