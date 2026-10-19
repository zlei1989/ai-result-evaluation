'use client';

/**
 * 评测详情的**同一个抽屉 + 页签头**：日志 / 变更 / 评分三种行级视图住在一个 `Sheet` 里，
 * 排名仍是页面级视图（不在这里）。
 *
 * 三条不变量：
 *   1. **切页签不卸载**：三个面板都 `keepMounted`，隐藏只靠 `hidden` 属性。滚动位置、
 *      展开过的工具行、过滤条件因此活着；切一次只换可见面板，不播「关一个、开一个」的动画。
 *   2. **开合与页签归调用方**：本件受控（`open` / `activeTab`），不持自己的视图态。
 *   3. **嵌套让位**：面板几何只引用 CSS 变量，退出量由 Base UI 的 `--nested-dialogs`
 *      计数驱动（二级层打开时自动生效），不写死像素距离。
 */
import type { ReactNode } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { MAIN_DRAWER_STYLE } from '../base/drawer-geometry';

/** 行级三视图（排名不在此列：它比的是候选之间，没有「哪一行」） */
export type RunDetailTab = 'log' | 'diff' | 'score';

/** 页签的顺序与文案：与三个入口按钮上的词一致 */
const TABS: readonly { value: RunDetailTab; label: string }[] = [
  { value: 'log', label: '日志' },
  { value: 'diff', label: '变更' },
  { value: 'score', label: '评分' },
];

export interface RunDetailDrawerProps {
  open: boolean;
  onClose(): void;
  /** 当前页签（受控） */
  activeTab: RunDetailTab;
  onTabChange(tab: RunDetailTab): void;
  /** 抽屉标题；默认「评测详情」 */
  title?: ReactNode;
  log: ReactNode;
  diff: ReactNode;
  score: ReactNode;
}

export function RunDetailDrawer({
  open,
  onClose,
  activeTab,
  onTabChange,
  title,
  log,
  diff,
  score,
}: RunDetailDrawerProps): ReactNode {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        data-testid="run-detail-drawer"
        data-drawer="main"
        className="gap-0 border-l border-border bg-background p-0 text-foreground"
        style={MAIN_DRAWER_STYLE}
      >
        <Tabs
          value={activeTab}
          onValueChange={(value) => onTabChange(value as RunDetailTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <SheetHeader className="flex flex-row items-center justify-between gap-snug border-b border-border px-roomy py-snug pr-10">
            <SheetTitle className="text-title">{title ?? '评测详情'}</SheetTitle>
            <TabsList variant="line" aria-label="详情视图">
              {TABS.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </SheetHeader>
          <TabsContent value="log" keepMounted className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {log}
          </TabsContent>
          <TabsContent value="diff" keepMounted className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {diff}
          </TabsContent>
          <TabsContent value="score" keepMounted className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {score}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
