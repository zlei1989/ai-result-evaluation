'use client';

/**
 * 二级抽屉：从主抽屉里**再推出来的一层**（原文查看这类「不离开当前上下文」的深读）。
 *
 * 五条口径：
 *   1. **几何集中在 `base/drawer-geometry.ts`**：宽度 `NESTED_DRAWER_SIZE`（`min(60vw, 900px)`）、
 *      语义槽 `DRAWER_SEMANTIC_STYLES`（窄屏兜底 + 内容区自管内边距），本件不写字面量；
 *   2. **本件不写 `push`**：把主抽屉推开多远由**主抽屉自己**声明（`MAIN_DRAWER_PUSH`）——
 *      rc-drawer 的位移量取的是父级那一份，写在子级上是空转（实测：子级写 360、父级不写 ⇒
 *      只挪默认的 180，详见 `drawer-geometry.ts` 里 `MAIN_DRAWER_PUSH` 的注释）。
 *      本件必须渲染在主抽屉的**子树里**：`parentContext` 是 React context，portal 不影响它；
 *   3. `destroyOnHidden`：关掉即卸载，不留浮层状态；`mask.closable`（`maskClosable` 已废弃）：
 *      点遮罩关闭；
 *   4. **它是 `ui` 包的内部件，不从包根转出**：只有「二级」这个位置需要它，转出去就等于对外承诺
 *      一套还没有外部消费者的 API（要用时再转，顺带补用例）；
 *   5. **内容自己给内边距**：`body.padding` 已置 0（见口径 1），直接用本件会贴边。
 */
import { Drawer } from 'antd';
import type { ReactNode } from 'react';
import { DRAWER_SEMANTIC_STYLES, NESTED_DRAWER_SIZE } from './drawer-geometry';

export interface NestedDrawerProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
}

export function NestedDrawer({ open, onClose, title, children }: NestedDrawerProps): ReactNode {
  return (
    <Drawer
      title={title}
      placement="right"
      size={NESTED_DRAWER_SIZE}
      open={open}
      onClose={onClose}
      // 关掉即卸载（`destroyOnHidden`）：`open === false` 时正文一个节点都不在 DOM 里
      destroyOnHidden
      mask={{ enabled: true, closable: true }}
      styles={DRAWER_SEMANTIC_STYLES}
      data-testid="nested-drawer"
    >
      {children}
    </Drawer>
  );
}
