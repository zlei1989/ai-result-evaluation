'use client';

/**
 * `task` 族的状态化清单面板：agent 自述的进度**当前状态**（不是一次调用的回显）。
 *
 * 五条口径：
 *   · **计数与变化摘要都照数据层给的渲染，UI 一个都不自己算**：本组件看不到上一张清单，
 *     跨轮比较它做不到，而数据层本来就有累积态；
 *   · **分母是四格之和**（含 `unknown`）：少了 `unknown` 那一格，含未知项的「3/5 完成」分母必错；
 *     分母为 0 时写「清单为空」——不是「0/0 完成」；
 *   · **`change === null` 表示「没有可比的上一张」**，与「三项都是 0」不是一回事：
 *     前者不表态，后者也不表态（一标题的「+0」没有信息量）；
 *   · 清单四态各有中文与色档，**`unknown` 用中性灰、绝不显示成成功**；
 *     `owner === null`（这家没有「指派」这个概念）**整格不画**，`owner === ''`（有概念但无人认领）
 *     显示「未指派」；`id === null` 时 id 与依赖都不画（`blockedBy` 的值就是 id，**不自己发号**）；
 *   · **「本轮另有 N 次更新」是一行静态说明，不是折叠项**：本件没有第二份开合态可用
 *     （L0 一律不得自己持态），画一个点不开的箭头比写清楚这件事更糟。
 */
import { Collapse, Flex, Listy, Tag, Typography } from 'antd';
import { useMemo, type ReactNode } from 'react';
import { AgentRunStateTag } from './agent-run-state-tag';
import { RawOutputPanel } from './raw-output-panel';
import type { TaskPanel, TaskStep } from './types';
import { TASK_STEP_STATUS_LABELS } from './types';

export interface TaskPanelCardProps {
  panel: TaskPanel;
  /** 同一轮里更早的（未出面板的）task 调用次数 */
  earlierCount: number;
  open: boolean;
  onOpenChange(next: boolean): void;
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

const PANEL_KEY = 'task-panel';

/** 非空判定：契约里 `null` = 没采到，空串同样是「没有这句话」 */
function hasText(value: string | null): value is string {
  return value !== null && value !== '';
}

/**
 * 清单四态 → `Tag` 色档。
 * **`unknown` 用中性灰**：它是「状态没采到」，不是「已完成」——涂绿就是把未知项算进了进度。
 */
function stepColor(status: TaskStep['status']): 'default' | 'processing' | 'success' {
  switch (status) {
    case 'inProgress':
      return 'processing';
    case 'completed':
      return 'success';
    default:
      return 'default';
  }
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

/** 一项清单：状态 + 文本 +（这家有这个概念时）owner +（拿得到 id 时）依赖 */
function StepRow({ step }: { step: TaskStep }): ReactNode {
  return (
    <Flex align="center" gap={4} wrap>
      <Tag color={stepColor(step.status)}>{TASK_STEP_STATUS_LABELS[step.status]}</Tag>
      <Typography.Text>{step.subject}</Typography.Text>
      {/* `null` = 这一家没有「指派」这个概念 ⇒ 整格不画；`''` = 有概念但当前无人认领 ⇒ 明说 */}
      {step.owner !== null && <Tag>{step.owner === '' ? '未指派' : step.owner}</Tag>}
      {/* 依赖的值就是 id：没有 id 时画出来的「依赖」会看起来解析成功了 */}
      {step.id !== null && step.blockedBy !== null && step.blockedBy.length > 0 && (
        <Tag>{`依赖 ${step.blockedBy.join('、')}`}</Tag>
      )}
    </Flex>
  );
}

export function TaskPanelCard({
  panel,
  earlierCount,
  open,
  onOpenChange,
  rawOpen,
  onRawOpenChange,
  onRequestDiagnostics,
  missingReason = null,
}: TaskPanelCardProps): ReactNode {
  const { counts } = panel;
  // 分母含 `unknown`：含未知项的清单少了它，分母必然偏小
  const total = counts.pending + counts.inProgress + counts.completed + counts.unknown;
  const countText = total === 0 ? '清单为空' : `${counts.completed}/${total} 完成`;
  const change = changeSummary(panel.change);

  // `steps` 是只读数组，而 `Listy` 要 `T[]`；摊平一次并挂住引用，免得每次渲染都让列表重算
  const steps = useMemo(() => [...panel.steps], [panel.steps]);

  const label = (
    <Flex vertical>
      <Flex align="center" gap={4} wrap>
        <Typography.Text>计划清单</Typography.Text>
        <Typography.Text type="secondary">{countText}</Typography.Text>
        {change !== null && <Typography.Text type="secondary">{change}</Typography.Text>}
        <AgentRunStateTag
          running={panel.running}
          hasResult={panel.result !== null}
          // 原因由注册表从能力声明的 `toolResult` 那一维推出来（与工具组同一处推导、同一句话）
          missingReason={missingReason}
          since={panel.at}
        />
      </Flex>
      {hasText(panel.note) && <Typography.Text type="secondary">{panel.note}</Typography.Text>}
    </Flex>
  );

  return (
    <Collapse
      destroyOnHidden
      activeKey={open ? [PANEL_KEY] : []}
      onChange={(keys) => onOpenChange(keys.length > 0)}
      items={[
        {
          key: PANEL_KEY,
          label,
          children: (
            <Flex vertical gap={4}>
              {panel.steps.length === 0 ? (
                // 空表与「没采到」必须分得开：这家明确报了一张空清单
                <Typography.Text type="secondary">清单为空（这家报了空表）</Typography.Text>
              ) : (
                <Listy
                  items={steps}
                  rowKey={(step) => step.id ?? step.subject}
                  itemRender={(step) => <StepRow step={step} />}
                />
              )}
              {earlierCount > 0 && (
                <Typography.Text type="secondary">
                  {`本轮另有 ${earlierCount} 次更新（这几次调用不出面板：整表语义下只有最后一次是有效状态）`}
                </Typography.Text>
              )}
              {/* 归一化是视图，原文才是事实；结果没到手时连入口都不画（标题已写过「结果未采集」） */}
              {panel.result !== null && (
                <RawOutputPanel
                  source={{ kind: 'single', result: panel.result }}
                  open={rawOpen}
                  onOpenChange={onRawOpenChange}
                  label="原始结果"
                  onRetry={onRequestDiagnostics}
                />
              )}
            </Flex>
          ),
        },
      ]}
    />
  );
}
