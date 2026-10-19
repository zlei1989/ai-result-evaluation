'use client';

/**
 * 「这次调用现在什么状态」——**工具行 / 工具组 / 计划清单三处共用的分派点**。
 *
 * 为什么必须是具名原语：`running` **不可由「有没有结果」推断**（见 `render-blocks.ts` 的 `ToolItem`），
 * 而这条规则要落在三个地方（工具行 / 工具组 / 计划清单）。三处各写一遍必然有两处漂，
 * 漂了之后「结果未采集」会在某一处悄悄变回「正在跑」——那正是「假装采到了」的反面。
 *
 * ⚠️ **问答卡片不走这个件**：`ask-user-card.tsx` 自己写这一支（`pending` 走转圈 + 秒表、
 * 其余走静态灰字）。它的状态轴与工具调用不同（多了「等待答复」与收场七态），
 * 硬并进来会让两个判据互相将就。
 *
 * 三条边界：
 *   1. **结果到了就不表态**（返回 `null`）：已确定的事不占地方。`running` 的语义本来就含
 *      「结果未到」，两者同时为真只可能是数据层把这一格给宽了，此时以结果为准更诚实；
 *   2. **`since` 为 null 或非法时只写「进行中」**，不挂定时器、也不算出 NaN 耗时；
 *   3. 灰字**绝不同时带转圈**：静态的「没采到」加一个转圈，读的人会一直等一个不会来的结果。
 *      转圈只画在 `data-testid="run-state-running"` 那一支里，两档在结构上就分得开。
 *
 * 形态是**行内一段文字**（不套卡片 / 不套标签）：它要和工具行的标题、计划清单的摘要行
 * 排在同一行里，外面再包一层，那一行就会多出两套行高与间距。
 */
import { LoaderCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatDuration } from '../../base/metric-line';
import { useNow } from '../../base/use-now';

export interface AgentRunStateTagProps {
  /** 有调用、结果未到、**且所在轮次尚未结束** */
  running: boolean;
  /** 结果在不在（`null` = 还没到） */
  hasResult: boolean;
  /** 结果未采集时的原因（能力声明给）；`null` 时只写「结果未采集」 */
  missingReason: string | null;
  /** 计时用；`running` 为 false 时不挂定时器 */
  since?: string | null;
}

/** ISO 时刻 → 毫秒；缺失、空串或非法时 `null`（界面不该出现 NaN 耗时） */
function parseAt(iso: string | null): number | null {
  if (iso === null || iso === '') return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function AgentRunStateTag({ running, hasResult, missingReason, since }: AgentRunStateTagProps): ReactNode {
  const sinceMs = parseAt(since ?? null);

  /**
   * 只有「还在跑」且拿得到开始时刻才挂定时器：终态的耗时是结算值、不会涨，
   * 而详情页上同时挂着几十个工具行，每个都每秒重渲染一次是纯浪费（`useNow` 的文件头）。
   * hook 必须在任何提前返回之前调用，故先算 `active` 再分派画面。
   */
  const now = useNow(!hasResult && running && sinceMs !== null);

  // 结果到手 ⇒ 这一格不表态（包括轮次还在跑、但这行的结果已经回来了的那种）
  if (hasResult) return null;

  if (!running) {
    return (
      <span className="text-sub text-muted-foreground">
        {missingReason === null || missingReason === '' ? '结果未采集' : `结果未采集 · ${missingReason}`}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1" data-testid="run-state-running">
      {/* 转圈是这一档独有的信号；`prefers-reduced-motion` 下停转，文字仍然说明在跑 */}
      <LoaderCircleIcon aria-hidden="true" className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
      <span className="tabular-nums">{sinceMs === null ? '进行中' : `进行中 · ${formatDuration(now - sinceMs)}`}</span>
    </span>
  );
}
