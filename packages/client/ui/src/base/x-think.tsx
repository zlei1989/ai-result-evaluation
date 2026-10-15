'use client';

/**
 * `Think` 的本仓外壳（`@ant-design/x` 的导入只允许出现在 `base/`，见
 * `docs/architecture/ui-primitives-and-theme.md` 与《X 落地纪律》）。
 *
 * 外壳刻意**薄**：语义留在调用方（`thinking-block-view` 才知道什么叫「还在思考」），
 * 这里只做三件事——
 *   1. 收口导入路径（换包、换深路径、加 `XProvider` 之类只改这一处）；
 *   2. 把本仓真正用到的那几格显式列出来（`Think` 自己有十来个 prop，透传会把它变成一层面纱）；
 *   3. 钉住 `destroyOnHidden`：折叠态收起的正文不进 DOM，与 `Collapse` 那一版同口径。
 *
 * **透传 `loading`、仍不透传 `blink`**：两者都是 `Think` 自带的「进行中」表达——
 * `loading` 把状态图标换成转圈，与标题状态文字「思考中…」是**同一判据的图标配文字**
 * （判据 `assembly === 'open'` 住在调用方）；`blink` 给 title 文字加闪烁动画，
 * 文字本身已是「思考中…」，再闪就是同一件事说两遍，故不透传。
 */
import { Think } from '@ant-design/x';
import type { ReactNode } from 'react';

export interface XThinkProps {
  /** 折叠标题：状态文字（「思考」/「思考中…」）+ 可选来源角标；纯字符串时 `Think` 的原生排版生效 */
  title: ReactNode;
  /** 进行中：状态图标换转圈（与标题状态文字同一判据） */
  loading?: boolean;
  /** 受控展开态：本仓的折叠键住在 `useAgentLogView`，组件不持态 */
  expanded: boolean;
  onExpand(next: boolean): void;
  children?: ReactNode;
}

export function XThink({ title, loading, expanded, onExpand, children }: XThinkProps): ReactNode {
  return (
    <Think title={title} loading={loading} expanded={expanded} onExpand={onExpand} destroyOnHidden>
      {children}
    </Think>
  );
}
