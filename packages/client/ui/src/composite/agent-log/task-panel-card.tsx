'use client';

/**
 * `task` 族的状态化清单面板 → **`Plan` 摘要行 + `Queue` 两段步骤**。
 *
 * 六条口径：
 *   · **计数与变化摘要照数据层给的渲染，UI 一个都不自己算**：本组件看不到上一张清单，
 *     跨轮比较它做不到，而数据层本来就有累积态；
 *   · **分母是四格之和**（含 `unknown`）：少了 `unknown` 那一格，含未知项的「3/5 完成」分母必错；
 *     分母为 0 时写「清单为空」——不是「0/0 完成」；
 *   · **`change === null` 表示「没有可比的上一张」**，与「三项都是 0」不是一回事：
 *     前者不表态，后者也不表态（一标题的「+0」没有信息量）；
 *   · **形态是 Plan + Queue**：一条摘要行（`TraceCollapsibleTrigger`，进行中带 `status="running"`）
 *     说清楚「几分钟前走到哪一步」；展开后步骤是 `TraceLine`，并按 Queue 分成两段——
 *     「N 未完成」**常驻可见**、「N 已完成」**默认收起**。`unknown` 留在未完成那一段：
 *     它既不能算完成、也不能被藏起来，行上如实写「状态未知」（状态词在行上，不靠颜色）；
 *   · **开合一律受控**（分层纪律 (d)）：外层 `open` 由 `useAgentLogView` 下传（默认键只认
 *     `panel.running` ⇒ 进行中展开、完成收起）；已完成那一段用**同一份折叠态的另一个键**
 *     （`doneSectionKey(cardId)`，与 `|raw` 后缀同一手法）。组件自己一份 state 都不持；
 *   · `owner === null`（这家没有「指派」这个概念）**整格不画**，`owner === ''`（有概念但无人认领）
 *     显示「未指派」；`id === null` 时 id 与依赖都不画（`blockedBy` 的值就是 id，**不自己发号**）。
 */
import {
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleIcon,
  ListChecksIcon,
  ListTodoIcon,
  RouteIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
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
import { AgentRunStateTag } from './agent-run-state-tag';
import { RawOutputPanel } from './raw-output-panel';
import type { TaskPanel, TaskStep } from './types';
import { TASK_STEP_STATUS_LABELS } from './types';

export interface TaskPanelCardProps {
  panel: TaskPanel;
  /** 这张卡片的稳定 id（`renderBlockKey` 用的同一个）：已完成段的折叠键以它为前缀 */
  cardId: string;
  /** 同一轮里更早的（未出面板的）task 调用次数 */
  earlierCount: number;
  /** 摘要行（Plan）是否展开（**受控**） */
  open: boolean;
  onOpenChange(next: boolean): void;
  /** 已完成那一段（Queue 第二段）是否展开。不给 = 收起；不给回调 = 点不动（只读） */
  doneOpen?: boolean;
  onDoneOpenChange?(next: boolean): void;
  /** 底部「原始结果」二级抽屉的开合（**受控透传**：L0 自己不持态） */
  rawOpen: boolean;
  onRawOpenChange(next: boolean): void;
  onRequestDiagnostics?(): void;
  /**
   * 「结果未采集」的原因（能力声明的 `toolResult` 那一维，由注册表从 `BlockRenderContext` 推出）。
   * `null` = 声明里没谈到这一维 ⇒ 只写「结果未采集」，**不编一句话**。
   *
   * 与工具组那一处**同一个来源、同一句文案**：这是同一个能力的两个落点，
   * 各写一份必然漂移，而漂移的表现是「同一行的工具说没投送、清单说没验证过」。
   */
  missingReason?: string | null;
}

/**
 * 已完成段的折叠键。与 `agent-message-timeline` 的 `|raw` 后缀同一条手法：**同一份折叠态、
 * 不同后缀的键**，不新增状态通道。导出是为了让注册表与组件用**同一个公式**（各写一遍必然漂移，
 * 漂了的表现是「点开的已完成段自己合上」）。
 */
export function doneSectionKey(cardId: string): string {
  return `${cardId}|done`;
}

/** 非空判定：契约里 `null` = 没采到，空串同样是「没有这句话」 */
function hasText(value: string | null): value is string {
  return value !== null && value !== '';
}

/** 变化摘要：只给非 0 的分量；三项全 0 或没有上一张（`null`）时不给这一格 */
function changeSummary(change: TaskPanel['change']): string | null {
  if (change === null) return null;
  const parts: string[] = [];
  /**
   * 一个分量一行文字。`forceNegative` 只给「移除」用：它是**移除了几项**（一个计数），
   * 数据层给 `+1` 还是 `−1` 都该渲染成同一句 `−1 移除`——同一件事不该有两种写法。
   */
  const push = (value: number, label: string, forceNegative = false): void => {
    if (value === 0) return;
    // 减号用 `−`（U+2212）而不是连字符：`-1 移除` 里的 `-` 与「破折号/负号」在不同字体下宽窄不一
    parts.push(`${forceNegative || value < 0 ? '−' : '+'}${Math.abs(value)} ${label}`);
  };
  push(change.completed, '完成');
  push(change.added, '新增');
  push(change.removed, '移除', true);
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * 一行的图标：四态各一枚。`unknown` 用问号而不是对勾——图标不能把「不知道」说成「做完了」。
 * 图标是装饰性的（`TraceIcon` 对读屏隐藏），状态词在行上的 `TraceDescription` 里。
 */
function statusIcon(status: TaskStep['status']): ReactNode {
  switch (status) {
    case 'inProgress':
      return <CircleDotIcon />;
    case 'completed':
      return <CircleCheckIcon />;
    case 'unknown':
      return <CircleHelpIcon />;
    default:
      return <CircleIcon />;
  }
}

/**
 * 一条步骤。`TraceLine.status` 只表达「还在跑」与「还没开始」这两种与动效有关的状态：
 *   · `inProgress` ⇒ `running`（标题 shimmer）；
 *   · `pending` ⇒ `pending`（整行压淡）；
 *   · `completed` / `unknown` ⇒ 不传 status（终态，且 `unknown` 不是「待办」的一种）。
 * 状态词一律写进 `TraceDescription`，同时给 `data-step-status` 供结构断言（不靠颜色）。
 */
function StepLine({ step }: { step: TaskStep }): ReactNode {
  return (
    <TraceLine
      data-step-status={step.status}
      status={step.status === 'inProgress' ? 'running' : step.status === 'pending' ? 'pending' : undefined}
    >
      <TraceIcon>{statusIcon(step.status)}</TraceIcon>
      <TraceTitle>{step.subject}</TraceTitle>
      {/* `null` = 这一家没有「指派」这个概念 ⇒ 整格不画；`''` = 有概念但当前无人认领 ⇒ 明说 */}
      {step.owner !== null && <TraceDescription>{step.owner === '' ? '未指派' : step.owner}</TraceDescription>}
      {/* 依赖的值就是 id：没有 id 时画出来的「依赖」会看起来解析成功了 */}
      {step.id !== null && step.blockedBy !== null && step.blockedBy.length > 0 && (
        <TraceDescription>{`依赖 ${step.blockedBy.join('、')}`}</TraceDescription>
      )}
      <TraceDescription>{TASK_STEP_STATUS_LABELS[step.status]}</TraceDescription>
    </TraceLine>
  );
}

export function TaskPanelCard({
  panel,
  cardId,
  earlierCount,
  open,
  onOpenChange,
  doneOpen = false,
  onDoneOpenChange,
  rawOpen,
  onRawOpenChange,
  onRequestDiagnostics,
  missingReason = null,
}: TaskPanelCardProps): ReactNode {
  const { counts } = panel;
  // 分母含 `unknown`：含未知项的清单少了它，分母必然偏小
  const total = counts.pending + counts.inProgress + counts.completed + counts.unknown;
  const countText = total === 0 ? '清单为空' : `${counts.completed}/${total} 完成`;
  // 两段的标题都用数据层的计数（不拿 `steps` 重数一遍：那会是第二份真源）
  const unfinishedCount = counts.pending + counts.inProgress + counts.unknown;
  const change = changeSummary(panel.change);

  const unfinished = panel.steps.filter((step) => step.status !== 'completed');
  const done = panel.steps.filter((step) => step.status === 'completed');

  return (
    <Trace data-testid="task-panel">
      <TraceCollapsible open={open} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger>
          {/* 摘要行也带状态：进行中就有 shimmer，不必展开才看得出「还在跑」 */}
          <TraceLine status={panel.running ? 'running' : undefined}>
            <TraceIcon>
              <RouteIcon />
            </TraceIcon>
            <TraceTitle>计划清单</TraceTitle>
            <TraceDescription>{countText}</TraceDescription>
            {change !== null && <TraceDescription>{change}</TraceDescription>}
            <AgentRunStateTag
              running={panel.running}
              hasResult={panel.result !== null}
              // 原因由注册表从能力声明的 `toolResult` 那一维推出来（与工具组同一处推导、同一句话）
              missingReason={missingReason}
              since={panel.at}
            />
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="flex flex-col gap-2">
            {hasText(panel.note) && <p className="text-sub">{panel.note}</p>}

            {panel.steps.length === 0 ? (
              // 空表与「没采到」必须分得开：这家明确报了一张空清单
              <p className="text-sub">清单为空（这家报了空表）</p>
            ) : (
              <Trace>
                {/* Queue 第一段：未完成。常驻可见——「还剩几件、哪几件」是展开后第一眼要看的东西 */}
                {unfinished.length > 0 && (
                  <>
                    <TraceLine>
                      <TraceIcon>
                        <ListTodoIcon />
                      </TraceIcon>
                      <TraceTitle>{`${unfinishedCount} 未完成`}</TraceTitle>
                    </TraceLine>
                    {unfinished.map((step) => (
                      <StepLine key={step.id ?? step.subject} step={step} />
                    ))}
                  </>
                )}

                {/* Queue 第二段：已完成。默认收起，键是 `${cardId}|done`（同一份折叠态） */}
                {done.length > 0 && (
                  <TraceCollapsible open={doneOpen} onOpenChange={onDoneOpenChange ?? (() => undefined)}>
                    <TraceCollapsibleTrigger>
                      <TraceLine>
                        <TraceIcon>
                          <ListChecksIcon />
                        </TraceIcon>
                        <TraceTitle>{`${counts.completed} 已完成`}</TraceTitle>
                      </TraceLine>
                    </TraceCollapsibleTrigger>
                    <TraceCollapsibleContent>
                      <Trace>
                        {done.map((step) => (
                          <StepLine key={step.id ?? step.subject} step={step} />
                        ))}
                      </Trace>
                    </TraceCollapsibleContent>
                  </TraceCollapsible>
                )}
              </Trace>
            )}

            {earlierCount > 0 && (
              <p className="text-sub">
                {`本轮另有 ${earlierCount} 次更新（这几次调用不出面板：整表语义下只有最后一次是有效状态）`}
              </p>
            )}

            {/* 归一化是视图，原文才是事实；结果没到手时连入口都不画（摘要行已写过「结果未采集」） */}
            {panel.result !== null && (
              // 入口不自带容器（`raw-output-panel.tsx` 口径 7）；间距由这一层给，`mt-1` 把它与清单分开
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <RawOutputPanel
                  source={{ kind: 'single', result: panel.result }}
                  open={rawOpen}
                  onOpenChange={onRawOpenChange}
                  label="原始结果"
                  onRetry={onRequestDiagnostics}
                />
              </div>
            )}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}
