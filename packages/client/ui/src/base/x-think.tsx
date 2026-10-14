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
 * **刻意不透传 `blink` / `loading`**：这两个是 `Think` 自带的「进行中」表达，而本仓的
 * 「还在思考」有自己的一格信号（`ACTIVITY_SWEEP_CLASS` 扫光 + 「思考中…」文案），
 * 它只在**折叠态**出现（展开时正文在流，静态标题上再挂动画会把信号稀释成噪声）。
 * 两个都挂就是同一件事说两遍。要用 `Think` 自带的那一套，改的是调用方的判据，不是这里。
 */
import { Think } from '@ant-design/x';
import type { ReactNode } from 'react';

export interface XThinkProps {
  /** 折叠标题（本仓把「思考」「摘要」角标、来源角标与进行中信号都放在这里） */
  title: ReactNode;
  /** 受控展开态：本仓的折叠键住在 `useAgentLogView`，组件不持态 */
  expanded: boolean;
  onExpand(next: boolean): void;
  children?: ReactNode;
}

export function XThink({ title, expanded, onExpand, children }: XThinkProps): ReactNode {
  return (
    <Think title={title} expanded={expanded} onExpand={onExpand} destroyOnHidden>
      {children}
    </Think>
  );
}
