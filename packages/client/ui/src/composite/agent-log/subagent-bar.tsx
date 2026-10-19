'use client';

/**
 * 子任务占位条 → `Subagent` 形态：**一条 `TraceCollapsible`，不是一张卡**。
 *
 * 收起态就是一行：「子任务 · 名称 · 状态 · 耗时」，高度从原来的四行卡面降到一条 trace line；
 * 展开体里只放**看不见的细节**（状态缺失原因 / 结果摘要 / 用量 / 派发方式）。
 * 「进入」与「重试」留在收起态可见的位置（它们是这一行上唯一有副作用的动作，藏进展开体
 * 会让「进子任务」多一次点击），但**只能是触发器的兄弟节点**：触发器本身是 `<button>`，
 * 把按钮塞进按钮是无效 HTML，读屏与键盘都会错乱。
 *
 * 六条口径：
 * · **任务名为空时用 id 前缀兜底**（`子任务 <subagentId 前 8 位>`）：claude 的聚合形态就是
 *   `name: null`，显示空白会被读成「界面坏了」；主会话/子任务共用同一份形状，故兜底只认 id；
 * · **状态与「状态未采集」同时显示**：`status` 永远有一个可渲染的值
 *   （采不到就是 `'unknown'`），而「为什么是 unknown」是另一格，藏起来等于把
 *   「这家结构上不支持」说成「我们没接」；
 * · 三格（派发方式 / 结果摘要 / 用量）**拿不到时各显示「未采集」而不是空白**；
 *   **`usage === null` 且是主会话时不显示这一格**——主会话的用量本来就不在这个节点上
 *   （它在 `AgentLogModel.facts.tokens`），画一个「未采集」是在报一个不存在的缺口；
 * · **用量的三个数走千分位 + `tok` 单位**（`formatUsageTriple`，与事实条、逐轮页脚同一口径）；
 * · **耗时只在 `startedAt` / `endedAt` 都有时画**（`endedAt - startedAt`）：只有一头时编不出数字，
 *   宁可少一格，也不显示 `0s` 或 `NaN`；
 * · **开合受控**（分层纪律 (d)）：`open` / `onOpenChange` 由调用方给。默认收起——
 *   派发点在时间轴里是「路标」而不是「详情」，进子任务看内容由「进入」承担。
 */
import { BotIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatUsageTriple } from '../../base/usage-metrics';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '../../components/ui/trace';
import { formatDuration } from '../../base/format';
import type { SessionNode } from './types';
import { LOG_NODE_STATUS_LABELS, MISSING_REASON_LABELS } from './types';

export interface SubagentBarProps {
  node: SessionNode;
  /** 展开体是否打开（**受控**：折叠态住在 `useAgentLogView`） */
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 「进入」；未给时按钮 disabled */
  onEnter?(nodeId: string): void;
  /** 节点状态未采集时的重试（`source.retryNode`）；未给时不渲染重试按钮 */
  onRetry?(nodeId: string): void;
}

/**
 * 摘要行的状态：只有「还在跑」与「失败」会动（shimmer / 红字），其余终态不传 status。
 * `unsettled`（等不到了）与 `unknown`（不知道）**都不是失败**，也不该转圈。
 */
function traceStatusOf(node: SessionNode): 'running' | 'error' | undefined {
  if (node.status === 'running') return 'running';
  if (node.status === 'failed') return 'error';
  return undefined;
}

/** 任务名的兜底：`null` 与空串都算「没给名字」（空白会被读成界面坏了） */
function displayName(node: SessionNode): string {
  if (node.name !== null && node.name !== '') return node.name;
  const id = node.subagentId !== null && node.subagentId !== '' ? node.subagentId : node.id;
  return `子任务 ${id.slice(0, 8)}`;
}

/**
 * 耗时：两头都有才给。任一头缺失、或解析出非有限数时返回 `null`（不编数字、不显示 NaN）。
 * `0s` 是合法的短暂运行，故不把 0 当缺失。
 */
function durationOf(node: SessionNode): string | null {
  if (node.startedAt === null || node.endedAt === null) return null;
  const started = new Date(node.startedAt).getTime();
  const ended = new Date(node.endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return formatDuration(ended - started);
}

export function SubagentBar({ node, open, onOpenChange, onEnter, onRetry }: SubagentBarProps): ReactNode {
  const duration = durationOf(node);

  return (
    <Trace data-testid="subagent-bar" data-node-kind={node.kind}>
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        {/* 一行：左边是触发器（标题 + 状态 + 耗时），右边是动作组。
            auto 外边距把动作组顶到右端：`justify` 是逐行生效的，名称长到换行时单元素行会被推到左端 */}
        <div className="flex w-full min-w-0 items-center gap-2">
          <TraceCollapsibleTrigger>
            <TraceLine status={traceStatusOf(node)}>
              <TraceIcon>
                <BotIcon />
              </TraceIcon>
              <Badge variant="secondary">子任务</Badge>
              <TraceTitle>{displayName(node)}</TraceTitle>
              <TraceDescription>{LOG_NODE_STATUS_LABELS[node.status]}</TraceDescription>
              {duration !== null && <TraceDescription>{duration}</TraceDescription>}
            </TraceLine>
          </TraceCollapsibleTrigger>
          {/* 动作组：`shrink-0` 免得名称过长时把按钮压扁；重试在前、进入在后（导航入口占最右角） */}
          <div className="ms-auto flex shrink-0 items-center gap-1">
            {onRetry !== undefined && (
              <Button size="xs" variant="ghost" onClick={() => onRetry(node.id)}>
                重试
              </Button>
            )}
            <Button size="xs" variant="outline" disabled={onEnter === undefined} onClick={() => onEnter?.(node.id)}>
              进入 ▸
            </Button>
          </div>
        </div>
        <TraceCollapsibleContent>
          <div className="flex flex-col gap-2">
            {/* 「为什么状态是 unknown」单独一句：它与 `状态未知` 是两个事实 */}
            {node.statusMissing !== null && (
              <p className="text-sub">{`状态未采集 · ${MISSING_REASON_LABELS[node.statusMissing]}`}</p>
            )}

            {/* 结果摘要整段给（长文本要能折行，不塞进 truncate 的标题里） */}
            <div className="flex flex-col gap-1">
              <span className="text-sub text-muted-foreground">结果摘要</span>
              <p className="whitespace-pre-wrap text-foreground">{node.outcome ?? '未采集'}</p>
            </div>

            {/* 第二行：左「用量」、右「派发方式」（后者 auto 外边距钉右，没有用量那格时也在右边） */}
            <div className="flex flex-wrap items-center gap-3">
              {/* 主会话没有自己这一格 ⇒ 整格不画；子任务没采到 ⇒ 如实说「用量未采集」。
                  有值的那一支走 `formatUsageTriple`（千分位 + `tok`）：事实条、逐轮页脚、轮末里程碑
                  与这一格是**同一个数**，四处必须长得一样 */}
              {node.usage === null && node.kind === 'main' ? null : (
                <span className="flex items-center gap-1">
                  <span className="text-sub text-muted-foreground">用量</span>
                  <span className={node.usage === null ? 'text-muted-foreground' : 'text-foreground'}>
                    {node.usage === null ? '用量未采集' : formatUsageTriple(node.usage)}
                  </span>
                </span>
              )}
              <span className="ms-auto flex items-center gap-1">
                <span className="text-sub text-muted-foreground">派发方式</span>
                <span className="text-foreground">{node.dispatchKind ?? '未采集'}</span>
              </span>
            </div>
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
