'use client';

/**
 * `text` 块：**只有正文走 markdown**（思考、命令、结果都不是 markdown，解析只会得到字面标记）。
 *
 * 角色与来源的可见落点——这三格若没有界面表现，契约里就是装饰：
 *   · `assistant` 是默认主角，**不标注**；`user` 不给标签（与其余角色同形）；
 *   · `system` 给 `Badge`「系统」（厂商 system / 信封类文本与结论逐字同形）；
 *   · `role === 'tool'` 由工具类块自身表达，本件不另标；
 *   · `source !== 'wire'` 给块角标（`session-file` → 「补录」、`aggregate` → 「汇总」，
 *     `hook` / `wire` 的文案是 `null` ⇒ 不标）。
 *
 * **块里没有「正在写」那一行**（转圈 + 文案）：它是一行与正文无关的持续动效，在一段
 * 已经读得通的正文底下只会被读成空白。`assembly === 'open'` 是**流式的唯一判据**
 * （模型里没有任何流式布尔），只驱动 `XMarkdownText`：未闭合围栏的识别与复制按钮的禁用。
 *
 * 角标是 vendored 的 `Badge`：`Tag` 那套标签体系会带进另一套字号与内边距，
 * 而这一行只有「有角标 / 没角标」两种形态，不需要它。
 */
import type { ReactNode } from 'react';
import { XMarkdownText } from '../../base/x-markdown';
import { STREAM_CURSOR_CLASS } from '../../base/stream-cursor';
import { Badge } from '../../components/ui/badge';
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
    // 这一块的样式全部归 markdown 外壳（typeset 排版层），本仓只保留一样非样式的东西：
    // 「不是智能体自己说的」那两档角标。
    <div className="flex flex-col gap-1">
      {isSystem || sourceLabel !== null ? (
        <div className="flex items-center gap-1">
          {isSystem && <Badge variant="secondary">系统</Badge>}
          {sourceLabel !== null && <Badge variant="secondary">{sourceLabel}</Badge>}
        </div>
      ) : null}
      {/*
        正文**直接交给 markdown 外壳**：字符串进、它自己渲染，本仓不套任何排版容器。
        system 那一档**不**额外包一层弱化排印：那会盖掉渲染器自己的 `table` / `code` / 段落样式，
        同一段 markdown 就会在两档里长得不一样。要弱化就弱化整块，不要动它的内部排版。
      */}
      <XMarkdownText text={block.text} open={block.assembly === 'open'} />
    </div>
  );
}
