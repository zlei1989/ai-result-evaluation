'use client';

/**
 * 预置的执行日志抽屉（L2）：**唯一一处主 Sheet**（环境抽屉那个是内部件，另算一处）。
 *
 * 它是「评测页一行接线」的那个件：`open` / `onClose` / `model` 三格就能用，
 * 其余全是可选——**重组能力不要求调用方付税**。
 *
 * 几何：
 *   · 宽度只引用 `MAIN_DRAWER_STYLE`（`base/drawer-geometry.ts`）：宽度值住在应用全局样式的
 *     `--drawer-main-width` 里，本件不写第二份字面量；窄屏兜底 `max-width: 100vw`。
 *     评测页那一层用同一个常量，两边不会漂移。
 *   · 面板自身不设内边距（`p-0`）：正文的缩进由内容自己给，否则正文会贴死抽屉边框；
 *   · `open === false` 时不渲染正文（Sheet 关闭即卸载），不留浮层状态。
 */
import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../../components/ui/sheet';
import { MAIN_DRAWER_STYLE } from '../../base/drawer-geometry';
import { AgentLogLayout, type AgentLogLayoutProps } from './agent-log-layout';

export interface AgentLogDrawerProps extends AgentLogLayoutProps {
  open: boolean;
  onClose(): void;
  /** 抽屉标题；默认「执行日志」 */
  title?: ReactNode;
}

export function AgentLogDrawer({ open, onClose, title, ...layoutProps }: AgentLogDrawerProps): ReactNode {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // 关闭手势（遮罩 / Esc / 关闭按钮）统一回到调用方的 `onClose`，本件不持开合态
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        data-testid="agent-log-drawer"
        data-drawer="main"
        // vendored 的 `sm:max-w-sm` / `w-3/4` 是抽屉的默认档；宽度与窄屏兜底都走内联值，
        // 不受 Tailwind 工具类生成顺序影响
        className="gap-0 border-l border-border bg-background p-0 text-foreground"
        style={MAIN_DRAWER_STYLE}
      >
        <SheetHeader className="border-b border-border px-roomy py-snug">
          <SheetTitle className="text-title">{title ?? '执行日志'}</SheetTitle>
        </SheetHeader>
        {/* 正文取满剩余高度：Sheet 的面板已是纵向 flex，布局件自己再声明 `h-full` */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <AgentLogLayout {...layoutProps} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
