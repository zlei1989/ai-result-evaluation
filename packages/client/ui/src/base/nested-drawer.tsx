'use client';

/**
 * 二级抽屉：从主抽屉里**再推出来的一层**（环境信息 / 原始输出 / 产物总览这类「不离开当前上下文」的深读）。
 *
 * 五条口径：
 *   1. **几何集中在 `base/drawer-geometry.ts`**：宽度 `NESTED_DRAWER_SIZE`（引用全局变量
 *      `--drawer-nested-width`）、窄屏兜底 `max-width: 100vw`，本件不写字面量；
 *   2. **让位归主抽屉**：本件不声明任何位移。Base UI 的 `Dialog` 嵌套后会在父弹层上写
 *      `--nested-dialogs` 与 `data-nested-dialog-open`，主抽屉按计数左移（见 `MAIN_DRAWER_STYLE`）
 *      ——二级层自己写位移不会生效，只会让人以为推动是它干的；
 *   3. **开合受控**：`open` / `onClose` 都归调用方，本件不持态；关闭手势（遮罩 / Esc / 关闭键）
 *      统一回调 `onClose`。关掉即卸载，不留浮层状态；
 *   4. **它是 `ui` 包的内部件，不从包根转出**：只有「二级」这个位置需要它，转出去就等于对外承诺
 *      一套还没有外部消费者的 API（要用时再转，顺带补用例）；
 *   5. **正文自己给内边距**：面板 `p-0`，正文容器只负责滚动与高度链；内容不套第二层滚动区。
 */
import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { NESTED_DRAWER_STYLE } from './drawer-geometry';

export interface NestedDrawerProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
}

export function NestedDrawer({ open, onClose, title, children }: NestedDrawerProps): ReactNode {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        data-testid="nested-drawer"
        className="gap-0 border-l border-border bg-background p-0 text-foreground"
        style={NESTED_DRAWER_STYLE}
      >
        <SheetHeader className="border-b border-border px-roomy py-snug">
          <SheetTitle className="text-title">{title}</SheetTitle>
        </SheetHeader>
        {/*
          正文取满剩余高度：`min-h-0 flex-1` 让下面的 `height: 100%` 有确定的包含块
          （虚拟列表需要量得到高度，否则会静默退化为全量渲染）。
        */}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
