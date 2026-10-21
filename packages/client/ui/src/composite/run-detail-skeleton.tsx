'use client';

/**
 * 评测详情面板的**加载骨架**：快照还没到右栏时，先按详情面板的形状占位。
 *
 * 为什么不是空态：空态是「这里没有东西」的断言，而这一屏只是还没读到——把
 * 「正在加载评测…」画成 `Empty` 的图标加一句说明，会被读成「这一轮没有候选」。
 * 骨架同时保住两件事：布局不跳（信息卡与候选卡的尺寸先占好），以及「还在读」这个事实
 * 本身（`Skeleton active` 的扫光是这一屏唯一的进度信号）。
 *
 * 形状与 `RunDetailPanel` 同构：一张信息卡（标题 + 四行字段）+ 若干候选卡片，外层同样是
 * `Flex vertical gap={8}` + `minHeight: 0`，故快照到达时是**原地换内容**而不是整栏重排。
 * 候选卡片默认三张：够撑起一屏，又不至于在只有一行候选的轮里留下一条过长的假列表。
 *
 * 无障碍：外层是一个 `status` 区域，带可读名「正在加载评测详情」（骨架本身对读屏器没有内容，
 * 原来那句 `EmptyState` 的文案是这一屏唯一的播报来源，不能连它一起丢掉）。
 *
 * jsdom 约束同 `artifact-overview.tsx`：`data-testid` 挂在**外层 `Flex` / `Card`** 上——
 * antd 6 的 `Skeleton` 只认自己那张 props 表，未知属性（含 `data-testid`）会被静默丢掉。
 */
import { Card, Flex, Skeleton } from 'antd';
import type { ReactNode } from 'react';

/** 候选卡片骨架的默认张数：三张刚好铺满一屏右栏，也与常见的三候选一轮对齐 */
export const RUN_DETAIL_SKELETON_ROWS = 3;

export interface RunDetailSkeletonProps {
  /** 候选卡片骨架的张数；默认 3 */
  rows?: number;
}

export function RunDetailSkeleton({ rows = RUN_DETAIL_SKELETON_ROWS }: RunDetailSkeletonProps): ReactNode {
  return (
    <Flex
      vertical
      gap={8}
      style={{ height: '100%', minHeight: 0 }}
      data-testid="run-detail-loading"
      role="status"
      aria-label="正在加载评测详情"
    >
      {/* 信息卡：标题行 + 四行字段（备注 / 代码仓库 / commit / 工作基目录的占位） */}
      <Card size="small" data-testid="run-detail-loading-header">
        <Skeleton active title={{ width: '50%' }} paragraph={{ rows: 4 }} />
      </Card>

      {/* 候选列表：与真实列表同一套 gap 与滚动容器，快照到达后高度不跳 */}
      <Flex vertical gap={8} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {Array.from({ length: rows }, (_, index) => (
          <Card key={index} size="small" data-testid="run-detail-loading-row">
            <Skeleton active title={{ width: '35%' }} paragraph={{ rows: 3 }} />
          </Card>
        ))}
      </Flex>
    </Flex>
  );
}
